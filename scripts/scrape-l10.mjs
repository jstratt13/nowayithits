#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  Basketball-Reference per-team advanced gamelog scraper (Node-side).
//
//  Fetches each NBA team's /teams/{abbr}/{year}/gamelog-advanced/ page,
//  extracts the per-game ORtg / DRtg / Pace / volume stats, averages the
//  last 10 games, and writes src/data/l10Cache.json. Worker imports that
//  JSON at build time and uses it to populate the L10 blend inputs —
//  replacing the earlier (home_pace + away_pace) / 2 approximation with
//  BBR's own per-game pace.
//
//  Why GH Actions and not the worker: 30 BBR fetches per scrape cycle is
//  rate-limit territory from Cloudflare worker IPs (same reason rosters
//  moved here). GH runner IPs are a different pool.
//
//  Schedule: once daily at 10:00 UTC (6 AM ET / 5 AM EDT). Max data age
//  at any evening tipoff ≈ 13-16 hours, well under 18h.
//
//  Sanity guards (BEFORE writing the file):
//    1. Must successfully parse ≥ MIN_TEAMS teams
//    2. Average game count across teams must not drop > MAX_DROP vs prior
//       committed JSON (catches parser regressions and BBR HTML changes)
//
//  Any failure → script exits non-zero, file is NOT overwritten,
//  last-known-good keeps serving.
//
//  Usage:
//    node scripts/scrape-l10.mjs
//    node scripts/scrape-l10.mjs --dry-run
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'src/data/l10Cache.json');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';

const MIN_TEAMS = 28;          // 30 NBA teams; allow 2 misses before failing
const MAX_DROP = 0.30;         // > 30% drop in avg game count vs prior = fail
// BBR's public rate limit sits around ~20 req/min. 3.5 sec between requests
// = ~17/min, with headroom for the occasional retry.
const REQUEST_SPACING_MS = 3500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 30_000; // 30 sec on 429 before retry

const DRY_RUN = process.argv.includes('--dry-run');

const NBA_TEAMS = [
  'ATL','BOS','BRK','CHI','CHO','CLE','DAL','DEN','DET','GSW',
  'HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK',
  'OKC','ORL','PHI','PHO','POR','SAC','SAS','TOR','UTA','WAS',
];

function nbaSeasonYear(now = new Date()) {
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

async function fetchHtml(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) return res.text();
    // 429 = rate limited. Back off and retry. Other 4xx/5xx — fail fast.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      console.warn(`    [retry ${attempt}/${MAX_RETRIES-1}] 429 from ${url} — backing off ${RETRY_BACKOFF_MS/1000}s`);
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`${url} → ${res.status}`);
  }
  throw new Error(`${url} → all retries exhausted`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Pull a numeric cell by data-stat name. Handles the "value in a span" and
// "value as raw text" cases BBR uses on these tables.
function numCell(row, statName) {
  const m = row.match(new RegExp(`data-stat="${statName}"[^>]*>([-]?[0-9.]+)`));
  return m ? parseFloat(m[1]) : null;
}

// Parse a single team's advanced-gamelog page → array of per-game stat
// objects (most recent last). Skips header rows and rows with no parseable
// pace (future games / postponed games).
//
// BBR tags the table with the FRANCHISE's historic abbr (BRK → NJN, CHO →
// CHA, NOP → NOH), which doesn't always match the URL path. Rather than
// maintain a mapping, we find the table by structure: the only table on
// this page with a `team_game_num_season` column is the one we want.
function parseTeamGamelog(html) {
  html = html.replace(/<!--/g, '').replace(/-->/g, '');
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const tblHtml = tables.find((t) => /data-stat="team_game_num_season"/.test(t));
  if (!tblHtml) return [];
  const body = tblHtml.replace(/<thead[\s\S]*?<\/thead>/g, '');
  const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    if (/class="[^"]*thead/.test(row)) continue;
    const gameNum = numCell(row, 'team_game_num_season');
    const pace = numCell(row, 'pace');
    if (gameNum == null || pace == null) continue;
    out.push({
      gameNum,
      offRtg:    numCell(row, 'team_off_rtg'),
      defRtg:    numCell(row, 'team_def_rtg'),
      pace,
      tovPct:    numCell(row, 'team_tov_pct'),
      oppTovPct: numCell(row, 'opp_tov_pct'),
      orbPct:    numCell(row, 'team_orb_pct'),
      oppOrbPct: numCell(row, 'opp_orb_pct'),
      threePAr:  numCell(row, 'fg3a_per_fga_pct'),
    });
  }
  // BBR lists games in chronological order by game number — belt-and-
  // suspenders: sort by gameNum in case of any out-of-order rows.
  out.sort((a, b) => a.gameNum - b.gameNum);
  return out;
}

function averageL10(games) {
  const last10 = games.slice(-10);
  if (last10.length === 0) return null;
  const avg = (key) => {
    const vals = last10.map((g) => g[key]).filter((v) => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  return {
    gameCount:    last10.length,
    firstGameNum: last10[0].gameNum,
    lastGameNum:  last10[last10.length - 1].gameNum,
    offRtg:       avg('offRtg'),
    defRtg:       avg('defRtg'),
    pace:         avg('pace'),
    tovPct:       avg('tovPct'),
    oppTovPct:    avg('oppTovPct'),
    orbPct:       avg('orbPct'),
    oppOrbPct:    avg('oppOrbPct'),
    threePAr:     avg('threePAr'),
  };
}

async function scrapeNba(year) {
  const result = {};
  for (let i = 0; i < NBA_TEAMS.length; i++) {
    const abbr = NBA_TEAMS[i];
    const url = `https://www.basketball-reference.com/teams/${abbr}/${year}/gamelog-advanced/`;
    try {
      if (i > 0) await sleep(REQUEST_SPACING_MS);
      const html = await fetchHtml(url);
      const games = parseTeamGamelog(html);
      const l10 = averageL10(games);
      if (l10) {
        result[abbr] = l10;
        console.log(`  ${abbr}: ${l10.gameCount} games (${l10.firstGameNum}-${l10.lastGameNum}) · ORtg ${l10.offRtg?.toFixed(1)} DRtg ${l10.defRtg?.toFixed(1)} Pace ${l10.pace?.toFixed(1)}`);
      } else {
        console.warn(`  ${abbr}: no games parsed`);
      }
    } catch (e) {
      console.warn(`  ${abbr}: ${e.message}`);
    }
  }
  return result;
}

function loadPrevious() {
  try {
    if (!existsSync(OUT_PATH)) return null;
    return JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function sanityCheck(result, previous) {
  const teamCount = Object.keys(result.nba).length;
  if (teamCount < MIN_TEAMS) {
    throw new Error(`Only ${teamCount} teams scraped; expected ≥ ${MIN_TEAMS}. Refusing to write.`);
  }

  const avgGames = Object.values(result.nba).reduce((s, t) => s + t.gameCount, 0) / teamCount;
  if (previous?.nba) {
    const prevCount = Object.values(previous.nba).reduce((s, t) => s + (t.gameCount || 0), 0) /
                       Math.max(1, Object.keys(previous.nba).length);
    // Only enforce the drop guard if the previous had meaningful data to compare against
    if (prevCount > 5 && avgGames < prevCount * (1 - MAX_DROP)) {
      throw new Error(`Avg game count dropped from ${prevCount.toFixed(1)} to ${avgGames.toFixed(1)} (> ${(MAX_DROP*100).toFixed(0)}%). Refusing to write.`);
    }
  }
  console.log(`[sanity] ${teamCount} NBA teams · avg ${avgGames.toFixed(1)} games each`);
}

(async () => {
  console.log('[l10] scraping NBA advanced gamelog…');
  const year = nbaSeasonYear();
  console.log(`[l10] NBA season ${year}`);

  const result = {
    source: 'basketball-reference.com',
    fetchedAt: new Date().toISOString(),
    nba: await scrapeNba(year),
    // WNBA regular-season L10 not implemented yet (WNBA is offseason Nov-Apr).
    wnba: {},
  };

  const previous = loadPrevious();
  sanityCheck(result, previous);

  if (DRY_RUN) {
    console.log('[dry-run] not writing output file');
    return;
  }

  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
  console.log(`[l10] wrote ${OUT_PATH}`);
})().catch((e) => {
  console.error('[l10] FAILED:', e.message);
  process.exit(1);
});
