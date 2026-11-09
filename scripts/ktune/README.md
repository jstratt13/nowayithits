# ktune — quarterly re-fit of the Model B dominance strength `k`

Keeps the totals **matchup dominance correction** (Model B) honest against the
current NBA. Run it each quarter; log the result in the history table below.

## What `k` is

`src/data/formulaCore.js` → `combinedOffRating()` adds a correction on top of the
flat 50/50 (own-offense + opponent-defense) average:

```
homeExpected_per100 = (effOff_home + effDef_away)/2
                    + MATCHUP_ORTG_COEF*(effOff_home - leagueAvg)
                    + MATCHUP_DRTG_COEF*(effDef_away - leagueAvg)
```

Shipped strength: `MATCHUP_ORTG_COEF = 0.40`, `MATCHUP_DRTG_COEF = 0.63`.

`ktune` fits a single scalar **`k`** that scales *both* coefficients:

- `k = 0` → pure naive 50/50 (no correction)
- `k = 1` → shipped strength (own-offense weight 0.90, opponent-defense 1.13)

It finds the `k` that best predicts **actual game totals** using **point-in-time
ratings** — each team's ORtg/DRtg/pace computed from *only the games before* each
game, the way the live model actually sees it. `k` is the OLS slope of
`(actual_total − naive_total)` on `(modelB_total − naive_total)`.

## Why this exists (findings as of 2026-11-09)

The original Model B fit produced 0.40/0.63 (≈ `k=1`) using **season-aggregate
(final) ratings**. That is largely *look-ahead*: with the stable full-season
numbers the correction extracts real signal, but you don't have those at game
time. Re-fit on **point-in-time** ratings, the optimal `k` collapses:

- Per-season `k` ≈ −0.01 … +0.38; **pooled `k` ≈ +0.01 ± 0.08**.
- Shipped `k=1` is **worse than naive** on totals MAE in every full season.
- An earlier pass (kyleskom dataset) suggested a strong old→recent drift
  (−0.24 → +0.92); that did **not** survive clean official box scores and was a
  data-assembly artifact. Clean 2025-26 `k` is +0.21 in both halves.

So **the shipped `k=1` is not supported for live totals; ~0.2 is the most the
data backs.** `k` may still drift with league style, and the *current* season
can't be fit until teams have ~25–30 GP — hence the quarterly cadence.

Model changes (adjusting the two coefficients) affect **new snapshots only**
(integrity rule); locked predictions never change.

## Data

Official box scores from `stats.nba.com` `leaguegamelog` (one request per season,
cached under `.cache/`, which is git-ignored and regenerable). Pure Python
stdlib — no numpy/pandas/pip.

## Usage

```bash
python3 scripts/ktune/ktune.py                      # last 5 seasons (cached)
python3 scripts/ktune/ktune.py --refresh            # re-pull from stats.nba.com
python3 scripts/ktune/ktune.py --seasons 2024-25,2025-26,2026-27
python3 scripts/ktune/ktune.py --gp-min 10          # stricter min games-played
```

## How to act on the output

1. Look at the **current season** row once it's mature (~Jan, ~25–30 GP/team).
2. If its `k` settles clearly away from today's working value with a tight SE
   (and recent full seasons agree), scale **both** coefficients in
   `src/data/formulaCore.js` by the new `k` (e.g. `k=0.2` → 0.08 / 0.126) and
   redeploy **both** frontend and worker.
3. Add a row to the history table below every run.

## History

| Run date | Pooled k | Current-season k (n) | Notes / action |
|----------|----------|----------------------|----------------|
| 2026-11-09 | +0.01 ± 0.08 | 2026-27: −0.35 ± 1.68 (97) | Baseline. Current season too young to fit. Shipped k=1 unsupported live; no code change made. Revisit ~Jan 2027. |
