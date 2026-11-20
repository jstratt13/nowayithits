#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  Basketball-Reference roster scraper (Node-side).
//
//  Runs from a GitHub-hosted runner (or locally) — NOT from a Cloudflare
//  Worker. CF worker IPs get rate-limited hard by BBR; GH runner IPs have
//  a separate reputation and consistently get 200 OK.
//
//  Output: src/data/rosters.json (committed to the repo). The worker
//  imports the JSON at build time so the predictions cron never has to
//  hit BBR at runtime.
//
//  Sanity guards (BEFORE writing the file):
//   1. Each league must scrape ≥ MIN_TEAMS teams
//   2. Every team must have ≥ MIN_PLAYERS players
//   3. Total player count must not drop > MAX_DROP_PCT vs the previous
//      committed JSON (catches the case where BBR changes their HTML
//      structure and the parser silently breaks)
//
//  Any failure → script exits non-zero, file is NOT overwritten, GitHub
//  Actions shows a red ❌. Last-known-good data keeps serving.
//
//  Usage:
//    node scripts/scrape-rosters.mjs
//    node scripts/scrape-rosters.mjs --dry-run   # parse + validate, don't write
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH  = resolve(REPO_ROOT, 'src/data/rosters.json');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';

// Sanity-guard thresholds — keep them on the loose side so legitimate
// roster shrinkage (offseason cuts, expansion year, etc.) doesn't trip
// the alarm, but parser-bug-level data loss does.
//
// Season opening week caveat: BBR's per_game table only has players who
// have logged actual game minutes, so a team that's played 1-2 games
// may legitimately show < 10 entries. Pass --min-players=N (e.g. 8)
// during the first ~2 weeks of each season.
const MIN_TEAMS       = { nba: 28, wnba: 11 };
const MIN_PLAYERS     = { nba: 10, wnba: 8 };
const MAX_DROP_PCT    = 0.20;   // > 20% total player loss = fail

const DRY_RUN = process.argv.includes('--dry-run');

// --min-players=N overrides MIN_PLAYERS for both leagues.
const minPlayersArg = process.argv.find((a) => a.startsWith('--min-players='));
if (minPlayersArg) {
  const n = parseInt(minPlayersArg.split('=')[1], 10);
  if (Number.isInteger(n) && n >= 1 && n <= 20) {
    MIN_PLAYERS.nba = n;
    MIN_PLAYERS.wnba = n;
    console.log(`[config] MIN_PLAYERS override: ${n}`);
  } else {
    console.error(`invalid --min-players=${n}; must be 1-20`);
    process.exit(1);
  }
}

// --max-drop=0.N overrides MAX_DROP_PCT. Use e.g. --max-drop=0.5 during
// season opening week when BBR's per_game table is sparse.
let maxDropOverride = null;
const maxDropArg = process.argv.find((a) => a.startsWith('--max-drop='));
if (maxDropArg) {
  const n = parseFloat(maxDropArg.split('=')[1]);
  if (Number.isFinite(n) && n > 0 && n <= 1) {
    maxDropOverride = n;
    console.log(`[config] MAX_DROP_PCT override: ${n}`);
  } else {
    console.error(`invalid --max-drop=${n}; must be in (0, 1]`);
    process.exit(1);
  }
}

// Canonical BBR → ESPN abbreviation map — single source of truth shared
// with the worker (predictions.js) and frontend (liveStats.js).
import { resolveAbbr as toEspnAbbr } from '../src/data/abbrAlias.js';

const MULTI_TEAM_RE = /^(?:TOT|\d+TM)$/;
const SLUG_RE = /href=['"]\/(?:wnba\/)?players\/[a-z]\/([a-z]+\d+w?)\.html/;
// NBA pages use data-stat="name_display"; WNBA pages use data-stat="player".
// Match either, then drill into the <a> to get the rendered name.
const NAME_RE = /data-stat="(?:name_display|player)"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/;
// NBA uses data-stat="team_name_abbr"; WNBA league-wide pages use "team".
const TEAM_STATS = ['team_name_abbr', 'team'];

function nbaSeasonYear(now = new Date()) {
  // NBA season label = spring year. Oct-Dec → next year; Jan-Sep → current year.
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}
function wnbaSeasonYear(now = new Date()) {
  return now.getUTCFullYear();
}

function pageUrls(league, year) {
  if (league === 'nba') {
    return {
      perGame:  `https://www.basketball-reference.com/leagues/NBA_${year}_per_game.html`,
      advanced: `https://www.basketball-reference.com/leagues/NBA_${year}_advanced.html`,
    };
  }
  return {
    perGame:  `https://www.basketball-reference.com/wnba/years/${year}_per_game.html`,
    advanced: `https://www.basketball-reference.com/wnba/years/${year}_advanced.html`,
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`BBR ${url} → ${res.status}`);
  return res.text();
}

function pickCell(row, statName) {
  const re = new RegExp(`data-stat="${statName}"[^>]*?(?:csk="([^"]+)")?[^>]*>([\\s\\S]*?)<\\/(?:td|th)>`);
  const m = row.match(re);
  if (!m) return null;
  const csk = m[1];
  const rendered = m[2].replace(/<[^>]+>/g, '').trim();
  if (csk && csk !== '') return csk;
  return rendered || null;
}

// Pull all <tr> rows out of a table. BBR's WNBA pages have <tbody> WITHOUT
// a closing </tbody> tag, so we can't reliably scope to the tbody. Instead
// we grab every <tr> inside the table and rely on a slug check downstream
// to filter out header rows (which never have player links).
function findTableRows(html, tableIds) {
  for (const id of tableIds) {
    const m = html.match(new RegExp(`<table[^>]*id="${id}"[\\s\\S]*?<\\/table>`));
    if (m) return m[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  }
  return [];
}

function readTeam(row) {
  for (const s of TEAM_STATS) {
    const v = pickCell(row, s);
    if (v) return v;
  }
  return null;
}

function parsePerGame(html) {
  const stripped = html.replace(/<!--/g, '').replace(/-->/g, '');
  // NBA league-wide page: id="per_game_stats". WNBA: id="per_game".
  const rows = findTableRows(stripped, ['per_game_stats', 'per_game']);

  const out = new Map();
  for (const row of rows) {
    const slugM = row.match(SLUG_RE);
    if (!slugM) continue;
    const slug = slugM[1];
    const team = readTeam(row);
    if (!team || MULTI_TEAM_RE.test(team)) continue;
    const nameM = row.match(NAME_RE);
    const name = nameM ? nameM[1].replace(/<[^>]+>/g, '').trim() : null;
    const mpgRaw = pickCell(row, 'mp_per_g');
    const mpg = mpgRaw != null && !Number.isNaN(parseFloat(mpgRaw)) ? parseFloat(mpgRaw) : null;
    // Games played FOR THIS TEAM — the injury model uses g / team games as
    // the share of the team's season rating that still includes the player.
    const g = numOrNull(pickCell(row, 'games'));
    if (!name) continue;
    out.set(slug, { name, slug, team, mpg, g });
  }
  return out;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// Season-aggregate BPM per player for a (prior) season: prefers the
// multi-team TOT/2TM row so traded players get their whole-season value.
// Feeds the injury model's BPM prior (see combinePriorSeasons).
function parseAdvancedSeason(html) {
  const stripped = html.replace(/<!--/g, '').replace(/-->/g, '');
  const rows = findTableRows(stripped, ['advanced']);
  const out = new Map();
  for (const row of rows) {
    const slugM = row.match(SLUG_RE);
    if (!slugM) continue;
    const slug = slugM[1];
    const team = readTeam(row);
    const multi = !!team && MULTI_TEAM_RE.test(team);
    if (out.has(slug) && !multi) continue;
    out.set(slug, {
      bpm:  numOrNull(pickCell(row, 'bpm')),
      obpm: numOrNull(pickCell(row, 'obpm')),
      dbpm: numOrNull(pickCell(row, 'dbpm')),
      mp:   numOrNull(pickCell(row, 'mp')),
    });
  }
  return out;
}

// Minutes-weighted blend of several past seasons (most recent first). Each
// season votes by minutes played — no extra recency weight. Seasons with no
// minutes or no BPM are skipped; priorMp = total minutes across them (the
// model ignores priors under INJURY_V2.PRIOR_MIN_MP).
const PRIOR_SEASONS = 3;
function combinePriorSeasons(seasonMaps) {
  const acc = new Map();
  for (const m of seasonMaps) {
    for (const [slug, r] of m) {
      if (!r.mp || r.bpm == null) continue;
      const a = acc.get(slug) || { mp: 0, bpm: 0, obpm: 0, dbpm: 0, seasons: 0 };
      a.mp += r.mp; a.seasons += 1;
      a.bpm  += r.mp * r.bpm;
      a.obpm += r.mp * (r.obpm ?? 0);
      a.dbpm += r.mp * (r.dbpm ?? 0);
      acc.set(slug, a);
    }
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  const out = new Map();
  for (const [slug, a] of acc) {
    out.set(slug, {
      bpm: round2(a.bpm / a.mp), obpm: round2(a.obpm / a.mp), dbpm: round2(a.dbpm / a.mp),
      mp: Math.round(a.mp), seasons: a.seasons,
    });
  }
  return out;
}

function parseAdvanced(html) {
  const stripped = html.replace(/<!--/g, '').replace(/-->/g, '');
  const rows = findTableRows(stripped, ['advanced']);

  const out = new Map();
  for (const row of rows) {
    const slugM = row.match(SLUG_RE);
    if (!slugM) continue;
    const slug = slugM[1];
    const team = readTeam(row);
    if (!team || MULTI_TEAM_RE.test(team)) continue;
    const bpmRaw = pickCell(row, 'bpm');
    const perRaw = pickCell(row, 'per');
    const bpm = bpmRaw != null && bpmRaw !== '' && !Number.isNaN(parseFloat(bpmRaw)) ? parseFloat(bpmRaw) : null;
    const per = perRaw != null && perRaw !== '' && !Number.isNaN(parseFloat(perRaw)) ? parseFloat(perRaw) : null;
    out.set(slug, { bpm, per, obpm: numOrNull(pickCell(row, 'obpm')), dbpm: numOrNull(pickCell(row, 'dbpm')) });
  }
  return out;
}

async function scrapeLeague(league, previous) {
  const year = league === 'nba' ? nbaSeasonYear() : wnbaSeasonYear();
  const urls = pageUrls(league, year);
  console.log(`[${league}] fetching ${urls.perGame}`);
  console.log(`[${league}] fetching ${urls.advanced}`);
  const [perGameHtml, advancedHtml] = await Promise.all([
    fetchHtml(urls.perGame),
    fetchHtml(urls.advanced),
  ]);
  const pgMap  = parsePerGame(perGameHtml);
  const advMap = parseAdvanced(advancedHtml);

  // NBA only: the injury model's BPM prior = MINUTES-WEIGHTED average of the
  // last PRIOR_SEASONS seasons (tested 11/20: ties last-season-only on
  // accuracy but stops one short/injured/fluky season from mis-rating a
  // player — e.g. Haliburton, who missed all of 2025-26). Past seasons never
  // change, so if ANY page fails we carry forward what's already on disk (by
  // slug) rather than silently mixing a 2-season prior with 3-season ones.
  let priorMap = null;
  if (league === 'nba') {
    const seasonMaps = [];
    try {
      for (let i = 1; i <= PRIOR_SEASONS; i++) {
        const priorUrl = pageUrls(league, year - i).advanced;
        console.log(`[${league}] fetching prior season ${priorUrl}`);
        seasonMaps.push(parseAdvancedSeason(await fetchHtml(priorUrl)));
        await new Promise((r) => setTimeout(r, 3500)); // stay well under BBR's rate limit
      }
      priorMap = combinePriorSeasons(seasonMaps);
    } catch (e) {
      console.warn(`[${league}] prior-season fetch failed (${e.message}) — carrying forward previous prior* fields`);
    }
  }
  const prevPrior = new Map();
  for (const t of Object.values(previous?.[league]?.teams ?? {})) {
    for (const p of t.players) {
      if (p.priorBpm !== undefined) prevPrior.set(p.slug, p);
    }
  }

  const teams = {};
  for (const [slug, pg] of pgMap) {
    const adv = advMap.get(slug) || { bpm: null, per: null, obpm: null, dbpm: null };
    const espnAbbr = toEspnAbbr(pg.team);
    if (!teams[espnAbbr]) {
      teams[espnAbbr] = { bbrCode: pg.team, players: [] };
    }
    const entry = {
      name: pg.name,
      slug,
      mpg: pg.mpg,
      g: pg.g,
      bpm: adv.bpm,
      obpm: adv.obpm,
      dbpm: adv.dbpm,
      per: adv.per,
    };
    if (league === 'nba') {
      const pr = priorMap ? priorMap.get(slug) : null;
      const carry = prevPrior.get(slug);
      entry.priorBpm  = pr ? pr.bpm  : (priorMap ? null : carry?.priorBpm ?? null);
      entry.priorObpm = pr ? pr.obpm : (priorMap ? null : carry?.priorObpm ?? null);
      entry.priorDbpm = pr ? pr.dbpm : (priorMap ? null : carry?.priorDbpm ?? null);
      entry.priorMp   = pr ? pr.mp   : (priorMap ? null : carry?.priorMp ?? null);
      entry.priorSeasons = pr ? pr.seasons : (priorMap ? null : carry?.priorSeasons ?? null);
    }
    teams[espnAbbr].players.push(entry);
  }

  return {
    source: 'basketball-reference.com',
    season: String(year),
    fetchedAt: new Date().toISOString(),
    teams,
  };
}

// ── Sanity guards ──────────────────────────────────────────────────────

function validate(league, data, previous) {
  const teamCount = Object.keys(data.teams).length;
  if (teamCount < MIN_TEAMS[league]) {
    throw new Error(`[${league}] only ${teamCount} teams scraped (expected ≥ ${MIN_TEAMS[league]})`);
  }

  const tooSmall = Object.entries(data.teams)
    .filter(([, t]) => t.players.length < MIN_PLAYERS[league])
    .map(([abbr, t]) => `${abbr}(${t.players.length})`);
  if (tooSmall.length > 0) {
    throw new Error(`[${league}] teams with < ${MIN_PLAYERS[league]} players: ${tooSmall.join(', ')}`);
  }

  // Diff check: compare to previous committed snapshot
  const prevTeams = previous?.[league]?.teams ?? {};
  const oldPlayerCount = Object.values(prevTeams).reduce((s, t) => s + t.players.length, 0);
  const newPlayerCount = Object.values(data.teams).reduce((s, t) => s + t.players.length, 0);
  if (oldPlayerCount > 0) {
    const dropPct = (oldPlayerCount - newPlayerCount) / oldPlayerCount;
    const dropLimit = maxDropOverride ?? MAX_DROP_PCT;
    if (dropPct > dropLimit) {
      throw new Error(`[${league}] player count dropped ${oldPlayerCount} → ${newPlayerCount} (${(dropPct * 100).toFixed(1)}% loss, threshold ${dropLimit * 100}%)`);
    }
    console.log(`[${league}] ✓ players ${oldPlayerCount} → ${newPlayerCount}`);
  } else {
    console.log(`[${league}] ✓ ${newPlayerCount} players (no prior snapshot to diff)`);
  }

  console.log(`[${league}] ✓ ${teamCount} teams, all ≥ ${MIN_PLAYERS[league]} players each`);
}

// ── Main ──────────────────────────────────────────────────────────────

// Strip the freshness timestamp before comparing — otherwise every scrape
// run produces a non-empty diff and the workflow commits + redeploys daily
// regardless of whether anything actually changed.
function stripFetchedAt(data) {
  if (!data) return data;
  const out = {};
  for (const [league, blob] of Object.entries(data)) {
    out[league] = { ...blob, fetchedAt: null };
  }
  return out;
}

function isPayloadEqual(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(stripFetchedAt(a)) === JSON.stringify(stripFetchedAt(b));
}

async function main() {
  const previous = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, 'utf8'))
    : null;

  console.log(`scrape-rosters: previous=${previous ? 'loaded' : 'none'}  dry-run=${DRY_RUN}`);

  const result = {};
  for (const league of ['nba', 'wnba']) {
    result[league] = await scrapeLeague(league, previous);
    validate(league, result[league], previous);
  }

  // If team data is identical to what's already on disk, carry over the
  // prior fetchedAt so the file is byte-for-byte equal → workflow's
  // `git diff --quiet` sees no change and skips the commit + redeploy.
  if (previous && isPayloadEqual(previous, result)) {
    console.log('\nno player data changes since previous scrape — preserving fetchedAt');
    for (const league of Object.keys(result)) {
      if (previous[league]?.fetchedAt) {
        result[league].fetchedAt = previous[league].fetchedAt;
      }
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] would write to', OUT_PATH);
    console.log('NBA sample teams:', Object.keys(result.nba.teams).slice(0, 5).join(', '));
    console.log('WNBA sample teams:', Object.keys(result.wnba.teams).slice(0, 5).join(', '));
    return;
  }

  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${OUT_PATH} (${(JSON.stringify(result).length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('SCRAPE FAILED:', e.message);
  process.exit(1);
});
