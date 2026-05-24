# No Way It Hits — DBP Tracker

Live NBA + WNBA blowout / spread / O/U projections, plus a results tracker.

Two pages:

- **Predictions** (`/predictions`) — today's NBA and WNBA slate pulled from ESPN's public scoreboard, scored with the Blowy 5.2 model (Base ANG + Volume Delta → True Gap → DBP%).
- **Tracker** (`/tracker`) — historical predictions vs. real results, with hit-rate stats, filters, and a per-league accuracy chart.

## Repo layout

```
dbp-tracker/
├── src/                  # React app (Vite)
├── worker/               # Cloudflare Worker (data scrapers)
├── public/.nojekyll      # so GH Pages serves hashed asset URLs
└── README.md             # you are here
```

The frontend (in `src/`) is a static site deployed to **GitHub Pages**. The worker (in `worker/`) is deployed to **Cloudflare** and exposes JSON endpoints the frontend hits at runtime.

## Run locally

```bash
npm install
npm run dev
```

The dev server uses the bundled placeholder team stats from `src/data/teamStats.js`. To wire in real scraped data, also run the worker locally (see below) and create a `.env.local` with:

```
VITE_WORKER_URL=http://localhost:8787
```

## The data pipeline

The worker exposes these routes:

| Route | Source | Status |
|---|---|---|
| `GET /teams/:league` | basketball-reference.com | ✅ implemented |
| `GET /injuries/:league` | rotowire.com | ✅ implemented |
| `GET /nba-injury-report` | official.nba.com (PDF) | ⏳ stub |
| `GET /underdog` | Underdog NBA wire | ⏳ stub |
| `GET /line-movement/:league` | vegasinsider.com | ⏳ stub |

`/teams/:league` returns SRS, Off Rtg, Def Rtg, Pace, TO%, ORB%, DRB% per team. `/injuries/:league` returns a flat player list plus a per-team rollup score that feeds the model's Δ_Star calculation.

The stub routes return `{ ok: true, players: [] }` so the frontend renders gracefully while we build the rest of the pipeline.

### Cache

Each route caches its response in Cloudflare KV. TTLs are tuned per source:

- `/teams/:league` — 6h (BBR ratings only refresh once a day)
- `/injuries/:league` — 15m
- `/nba-injury-report` — 30m (matches the league's hourly publish cadence)
- `/underdog` — 5m
- `/line-movement/:league` — 5m

## Deploying the worker (Cloudflare)

1. **Sign up for Cloudflare** (free, no card) at <https://dash.cloudflare.com/sign-up>. Use any email; no Workers plan needed.

2. **Install wrangler** (Cloudflare's CLI):

   ```bash
   cd worker
   npm install
   ```

3. **Log in:**

   ```bash
   npx wrangler login
   ```

   Opens a browser to authorize the CLI against your Cloudflare account.

4. **Create the KV namespace** (used by `cache.js`):

   ```bash
   npx wrangler kv:namespace create CACHE
   ```

   The CLI prints something like `{ binding = "CACHE", id = "abc123…" }`. Paste that `id` into `worker/wrangler.toml` where it says `REPLACE_WITH_KV_ID`.

5. **Test locally:**

   ```bash
   npm run dev
   ```

   Hits `http://localhost:8787/teams/nba` — should return JSON scraped from Basketball-Reference.

6. **Deploy:**

   ```bash
   npm run deploy
   ```

   Wrangler prints the worker URL (e.g. `https://dbp-tracker-worker.<your-subdomain>.workers.dev`). Copy it.

7. **Point the frontend at the worker.** From the project root:

   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local` and set `VITE_WORKER_URL` to the worker URL from step 6. Rebuild + redeploy the GitHub Pages site:

   ```bash
   npm run deploy
   ```

## Deploying the frontend (GitHub Pages)

1. Push to a repo named `dbp-tracker` on GitHub:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:<your-username>/dbp-tracker.git
   git push -u origin main
   ```

2. Deploy:

   ```bash
   npm run deploy
   ```

   This builds with `base=/dbp-tracker/` and pushes `dist/` to the `gh-pages` branch.

3. In repo settings → Pages, set the source to the `gh-pages` branch (root). Your site will be at `https://<your-username>.github.io/dbp-tracker/`.

If you name the repo something other than `dbp-tracker`, update both `build:pages` and `deploy` scripts in `package.json` to match.

## The model

Formula plumbing lives in [`src/data/formula.js`](src/data/formula.js):

```
Base_ANG    = (SRS_Fav − SRS_Und) + HCA_Dynamic + Δ_Star
Δ_Vol       = (Matchup_TOG × 1.4) + (Matchup_ORG × 0.5)
True_Gap    = Base_ANG + Δ_Vol
Z           = intercept + multiplier × True_Gap   (league-specific)
DBP%        = sigmoid(Z) × 100
Total       = (Pace × Combined_Off) / 100
```

The two leagues use different coefficients. All values live in `MODEL_CONFIG` at the top of `formula.js`:

| Parameter | NBA | WNBA |
|---|---|---|
| Sigmoid intercept | −2.095 | −1.6 |
| Sigmoid multiplier | 0.185 | 0.16 |
| Star Δ cap | −5.0 / +5.5 | ±8.0 |
| Pace deflation | −2.5 | −1.5 |
| Blowout threshold | margin ≥ 16 | margin ≥ 14 |

Zones are the same labels in both leagues:

| Zone | DBP% |
|---|---|
| Safe Zone | <25% |
| Baseline | 25–45% |
| High Alert | 45–55% |
| Lock | 55–70% |
| Super Lock | >70% |

Δ_Star is wired to the Rotowire injury rollup: `IAF = 1 + (und_score − fav_score) × 0.05`, then `(IAF − 1) × 20`, clamped to the per-league cap.

### WNBA-specific data needs (not yet wired)

Per the WNBA blueprint, three pieces of data still need to land in the worker before the model is fully spec-compliant for WNBA:

1. **Arena HCA tier** — classify each home team into Elite (+4–5) / Flatline (+2.45) / Hard Floor (+2.0) from home vs road net rating split. Until then WNBA games use a single `standard` HCA of +3.0. Hook: `bbref.js` per-team page parse.
2. **SRS blending** — for the first 5–7 games of the season, blend current SRS with previous season's closing SRS. Hook: also fetch the prior year's standings + expose `srsPrev`.
3. **"Last 10 Games" possession filter** — switch the TO%/ORB%/DRB% source from season-to-date to last 10 games after ~1 month into the season. Hook: stats.wnba.com leaguedashteamstats with `LastNGames=10`.

A fourth, fully optional integration: **Her Hoop Stats On/Off Net Rating** per player, to refine Δ_Star beyond the Rotowire status-weight rollup.

### Volume Delta

The Volume Delta components (`Matchup_TOG`, `Matchup_ORG`) compute from the team-stats fields the BBR scraper emits (`toOff`, `toDef`, `orbOff`, `drbDef`). They return 0 if any field is missing — which it currently is on stub data — so deploy the worker and Δ_Vol picks up automatically.

## Tracker storage

The Tracker page persists its rows to `localStorage` under `dbp-tracker-v1`. The initial dataset is seeded from `src/data/seedTracker.js`.

## Blowout thresholds

Used by the accuracy chart to decide whether an actual game was a blowout:

- NBA: `margin ≥ 16`
- WNBA: `margin ≥ 14`

Both are configured under `MODEL_CONFIG[league].blowoutMargin` in `src/data/formula.js` and re-exported as `BLOWOUT_THRESHOLD`.
