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
const MIN_TEAMS       = { nba: 28, wnba: 11 };
const MIN_PLAYERS     = { nba: 10, wnba: 8 };
const MAX_DROP_PCT    = 0.20;   // > 20% total player loss = fail

const DRY_RUN = process.argv.includes('--dry-run');

// ── BBR_TO_ESPN abbreviation map (mirrors worker/src/scrapers/bbrRoster.js)
const BBR_TO_ESPN = {
  // NBA
  NYK: 'NY',
  SAS: 'SA',
  NOP: 'NO',
  GSW: 'GS',
  UTA: 'UTAH',
  WAS: 'WSH',
  PHO: 'PHX',
  BRK: 'BKN',
  CHO: 'CHA',
  // WNBA
  NYL: 'NY',
  LVA: 'LV',
  LAS: 'LA',
  GSV: 'GS',
  CON: 'CONN',
};
const toEspnAbbr = (bbr) => BBR_TO_ESPN[bbr] || bbr;

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
    if (!name) continue;
    out.set(slug, { name, slug, team, mpg });
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
    out.set(slug, { bpm, per });
  }
  return out;
}

async function scrapeLeague(league) {
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

  const teams = {};
  for (const [slug, pg] of pgMap) {
    const adv = advMap.get(slug) || { bpm: null, per: null };
    const espnAbbr = toEspnAbbr(pg.team);
    if (!teams[espnAbbr]) {
      teams[espnAbbr] = { bbrCode: pg.team, players: [] };
    }
    teams[espnAbbr].players.push({
      name: pg.name,
      slug,
      mpg: pg.mpg,
      bpm: adv.bpm,
      per: adv.per,
    });
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
    if (dropPct > MAX_DROP_PCT) {
      throw new Error(`[${league}] player count dropped ${oldPlayerCount} → ${newPlayerCount} (${(dropPct * 100).toFixed(1)}% loss, threshold ${MAX_DROP_PCT * 100}%)`);
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
    result[league] = await scrapeLeague(league);
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
