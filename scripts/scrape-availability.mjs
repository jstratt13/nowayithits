#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  Player availability scraper (Node-side, ESPN).
//
//  For every NBA team: how many games it has played this season, and how
//  many of its LAST 10 games each player actually appeared in. The injury
//  model (formulaCore.js, nbaInjuryValue) uses this to fade an injured
//  player's adjustment as his absence works its way into the team's ratings:
//
//    share = ½ × (games played / team games) + ½ × (last-10 games played / 10)
//
//  The backtest showed the fade only helps through the last-10 half
//  (season-only fade == no fade), so this feed is required, not optional.
//
//  Source: ESPN scoreboard (per date, last ~45 days) + game summaries (box
//  scores). Inactive players are absent from the box; DNPs are flagged.
//  Keyed by ESPN team abbreviation and normalizeName(player) — the same keys
//  the worker uses for the ESPN injury report and rosters.json.
//
//  Output: src/data/availability.json (bundled into the worker).
//  Sanity guards: ≥ 28 teams, each with ≥ 3 games in its window. Any failure
//  → exit non-zero, file NOT overwritten (last-known-good keeps serving).
//
//  Usage: node scripts/scrape-availability.mjs [--dry-run]
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from '../src/data/formulaCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'src/data/availability.json');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const LOOKBACK_DAYS = 45;   // comfortably covers 10 games, incl. All-Star break
const WINDOW = 10;
const MIN_TEAMS = 28;
const DRY_RUN = process.argv.includes('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (nwih availability)' } });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url} → ${e.message}`);
    }
    await sleep(1000 * (i + 1));
  }
  throw new Error(`${url} → retries exhausted`);
}
function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  // 1. completed regular-season games over the lookback window
  const events = new Map(); // id -> { date, teams: [abbr...], records: {abbr: gp} }
  const today = new Date();
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
    const sb = await getJson(`${ESPN}/scoreboard?dates=${ymd(d)}`);
    for (const ev of sb.events || []) {
      const comp = ev.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      if (ev.season?.type !== 2) continue; // regular season only
      const rec = {};
      for (const c of comp.competitors || []) {
        const total = (c.records || []).find((r) => r.type === 'total')?.summary;
        const [w, l] = (total || '').split('-').map(Number);
        rec[c.team.abbreviation] = Number.isFinite(w) && Number.isFinite(l) ? w + l : null;
      }
      events.set(String(ev.id), { date: ev.date, teams: Object.keys(rec), records: rec });
    }
    await sleep(150);
  }

  // 2. each team's last WINDOW games + current games-played count
  const byTeam = {};
  for (const [id, e] of events) {
    for (const t of e.teams) (byTeam[t] ||= []).push({ id, date: e.date, gp: e.records[t] });
  }
  const need = new Set();
  for (const list of Object.values(byTeam)) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    list.splice(WINDOW);
    list.forEach((g) => need.add(g.id));
  }

  // 3. box scores for the needed games
  const played = {}; // id -> { teamAbbr: Set(normName) }
  for (const id of need) {
    const s = await getJson(`${ESPN}/summary?event=${id}`);
    const out = {};
    for (const team of s.boxscore?.players || []) {
      const set = new Set();
      for (const a of team.statistics?.[0]?.athletes || []) {
        const min = parseFloat((a.stats || [])[0]);
        if (!a.didNotPlay && Number.isFinite(min) && min > 0) set.add(normalizeName(a.athlete?.displayName));
      }
      out[team.team.abbreviation] = set;
    }
    played[id] = out;
    await sleep(150);
  }

  // 4. assemble
  const teams = {};
  for (const [abbr, list] of Object.entries(byTeam)) {
    const counts = {};
    // streak = team games since the player last played (0 = played the
    // most recent game). list is newest-first, so the first game a name
    // appears in is his last appearance. Players absent from the whole
    // window have no entry (= missed ≥ window). Feeds the star cap.
    const streak = {};
    list.forEach((g, i) => {
      for (const name of played[g.id]?.[abbr] || []) {
        counts[name] = (counts[name] || 0) + 1;
        if (streak[name] == null) streak[name] = i;
      }
    });
    teams[abbr] = { teamGames: list[0]?.gp ?? null, window: list.length, played: counts, streak };
  }

  const n = Object.keys(teams).length;
  const thin = Object.entries(teams).filter(([, t]) => t.window < 3).map(([a]) => a);
  if (n < MIN_TEAMS) throw new Error(`only ${n} teams found (expected ≥ ${MIN_TEAMS})`);
  if (thin.length) throw new Error(`teams with < 3 games in window: ${thin.join(', ')}`);
  console.log(`✓ ${n} teams, ${need.size} box scores, windows ${Math.min(...Object.values(teams).map((t) => t.window))}–${WINDOW}`);

  const result = { source: 'espn', fetchedAt: new Date().toISOString(), nba: { teams } };
  if (existsSync(OUT_PATH)) {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    if (JSON.stringify(prev.nba) === JSON.stringify(result.nba)) {
      result.fetchedAt = prev.fetchedAt; // unchanged → byte-identical → no commit/redeploy
      console.log('no availability changes — preserving fetchedAt');
    }
  }
  if (DRY_RUN) { console.log('[DRY RUN] GS:', JSON.stringify(teams.GS)); return; }
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error('AVAILABILITY SCRAPE FAILED:', e.message); process.exit(1); });
