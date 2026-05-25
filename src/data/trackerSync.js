// ─────────────────────────────────────────────────────────────────────────
//  Tracker sync — auto-grade locked predictions against real outcomes.
//
//  For each FINAL game in the last N days that:
//    • has a locked pregame snapshot (dbp-locked-preds-v1)
//    • is NOT already in the tracker (dbp-tracker-v1)
//  we materialize a graded tracker row and append it.
//
//  This is purely additive — existing rows are never modified, and per the
//  integrity rule in lockedPredictions.js, locked snapshots are never
//  rewritten either.
// ─────────────────────────────────────────────────────────────────────────

import { fetchScoreboard } from './espn.js';
import { getLocked } from './lockedPredictions.js';
import { getZone, BLOWOUT_THRESHOLD } from './formulaCore.js';
import { SEED_TRACKER } from './seedTracker.js';

const TRACKER_KEY = 'dbp-tracker-v1';
const SYNC_META_KEY = 'dbp-tracker-sync-v1';

// How many days of completed games to consider on each sync pass.
// Bigger window = older boundary days don't roll off when the user comes
// back after a few days away. ESPN scoreboard fetches are cheap; we do
// this once on app load + every 15 min via the ticker.
const SYNC_WINDOW_DAYS = 30;

const LEAGUES = ['nba', 'wnba'];

// Worker URL for server-side locked snapshots. The reconciler prefers
// these over `dbp-locked-preds-v1` localStorage entries so all devices
// grade against the same authoritative snapshot.
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

// ── Date helpers ──────────────────────────────────────────────────────

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function addDays(date, n) {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

// ── Server lock fetcher ───────────────────────────────────────────────

// Hits the worker's batch /predictions/:league?from=...&to=... route and
// returns a Map keyed by ESPN event id. Only entries with non-null
// `predictions` are included — orphaned games (locked:true, predictions:null)
// can't be graded so we let the reconciler fall back to localStorage or
// emit an ungraded row.
//
// Throws on transport / parse failure so the caller can fall back to
// localStorage-only for that sync tick.
async function fetchServerLocks(league, fromYmd, toYmd) {
  if (!WORKER_URL) return new Map();
  // Per-hour cache-buster matches the pattern used elsewhere — keeps
  // Cloudflare's edge cache from serving stale responses.
  const hourSlot = Math.floor(Date.now() / 3_600_000);
  const url = `${WORKER_URL}/predictions/${league}?from=${fromYmd}&to=${toYmd}&_h=${hourSlot}`;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`worker → ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'worker error');

  const map = new Map();
  for (const day of body.days || []) {
    for (const g of day.games || []) {
      if (g.gameId && g.predictions) map.set(g.gameId, g.predictions);
    }
  }
  return map;
}

// ── Storage helpers ────────────────────────────────────────────────────

// IMPORTANT: must match the fallback logic in Tracker.jsx's loadRows() —
// when localStorage is empty (first visit, fresh browser) we seed from
// SEED_TRACKER so both the Tracker page and the sync ticker agree on the
// initial dataset, regardless of which one races to read first.
function readRows() {
  try {
    const raw = localStorage.getItem(TRACKER_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  // Persist the seed immediately so we don't have to re-seed on every read.
  writeRows(SEED_TRACKER);
  return [...SEED_TRACKER];
}

function writeRows(rows) {
  try {
    localStorage.setItem(TRACKER_KEY, JSON.stringify(rows));
  } catch { /* quota */ }
}

function readMeta() {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch { /* quota */ }
}

// Build a stable id for a game in the tracker. We key off ESPN's event id
// so the same game is never inserted twice across syncs.
function trackerIdFor(game) {
  return `g${game.id}`;
}

// ── Grading helpers ────────────────────────────────────────────────────

// Format a game's ISO date as "Month Day, Year" (matches seed convention).
function formatGameDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtSignedLine(n) {
  if (n == null || Number.isNaN(n)) return '';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(1)}`;
}

// Did the picked side cover the spread?
// sp = { side, line, edge } where line is signed FOR the picked side.
function gradeSpread(sp, away, home) {
  if (!sp || sp.line == null) return null;
  const pickedScore = sp.side === home.abbr ? home.score : away.abbr ? away.score : null;
  const oppScore    = sp.side === home.abbr ? away.score : home.score;
  if (pickedScore == null || oppScore == null) return null;
  const margin = pickedScore - oppScore;
  const cover = margin + sp.line;
  if (cover > 0) return 'Hit';
  if (cover < 0) return 'Miss';
  return 'Miss'; // push — treat as miss to match the existing tracker convention
}

function gradeOU(ou, away, home) {
  if (!ou || ou.line == null) return null;
  if (away.score == null || home.score == null) return null;
  const total = away.score + home.score;
  if (ou.direction === 'OVER')  return total > ou.line ? 'Hit' : total < ou.line ? 'Miss' : 'Miss';
  if (ou.direction === 'UNDER') return total < ou.line ? 'Hit' : total > ou.line ? 'Miss' : 'Miss';
  return null;
}

// Blowout grading
//   dbp >= 45 = "we projected a blowout"
//   actual margin >= league threshold = "blowout actually happened"
function gradeBlowout(dbp, actualMargin, league) {
  const threshold = BLOWOUT_THRESHOLD[league] ?? 15;
  const predicted = dbp >= 45;
  const actually  = actualMargin >= threshold;
  if (predicted && actually)    return 'Hit (Blowout)';
  if (!predicted && !actually)  return 'Hit (Safe)';
  if (predicted && !actually)   return 'Miss (No Blowout)';
  return 'Miss (Variance Blowout)';
}

// Build an "ungraded" tracker row for a FINAL game we never observed
// pregame (no locked snapshot exists). The row carries actual-outcome
// fields only — final score, margin, total, blowout Yes/No — and leaves
// all prediction columns blank. The `graded: false` flag lets downstream
// stats (hit rates, accuracy chart) exclude these rows without losing
// the historical record that the game happened.
function buildUngradedRow(game) {
  const awayScore = game.away.score ?? null;
  const homeScore = game.home.score ?? null;
  const margin = Math.abs((homeScore ?? 0) - (awayScore ?? 0));
  const total  = (homeScore ?? 0) + (awayScore ?? 0);
  return {
    id: trackerIdFor(game),
    league: game.league,
    date: formatGameDate(game.date),
    matchup: `${game.away.abbr} @ ${game.home.abbr}`,
    posSRS: null,
    srsGap: null,
    starDelta: null,
    hca: null,
    dbp: null,
    zone: null,
    blowout: null,
    spreadPick: '',
    ouPick: '',
    spreadResult: '',
    ouResult: '',
    margin,
    total,
    awayScore,
    homeScore,
    bookSpread: null,
    bookTotal: null,
    graded: false,
    syncedAt: new Date().toISOString(),
  };
}

// Convert a locked snapshot + a FINAL game into a tracker row.
function buildTrackerRow(game, snapshot) {
  const { sp, ou, dbp, inputs, book } = snapshot;
  const zone = getZone(dbp).label;

  const awayScore = game.away.score ?? null;
  const homeScore = game.home.score ?? null;
  const margin = Math.abs((homeScore ?? 0) - (awayScore ?? 0));
  const total  = (homeScore ?? 0) + (awayScore ?? 0);

  const favAbbr = inputs?.favoredIsHome ? game.home.abbr : game.away.abbr;

  const spreadPickStr = sp ? `${sp.side} ${fmtSignedLine(sp.line)}` : '';
  const ouPickStr     = ou ? `${ou.direction} ${ou.line.toFixed(1)}` : '';

  const spreadResult = gradeSpread(sp, game.away, game.home);
  const ouResult     = gradeOU(ou, game.away, game.home);
  const blowout      = gradeBlowout(dbp, margin, game.league);

  return {
    id: trackerIdFor(game),
    league: game.league,
    date: formatGameDate(game.date),
    matchup: `${game.away.abbr} @ ${game.home.abbr}`,
    posSRS: favAbbr,
    srsGap: roundTo(inputs ? inputs.favSRS - inputs.undSRS : 0, 2),
    starDelta: roundTo(inputs?.deltaStar ?? 0, 2),
    hca: inputs?.hca ?? null,
    dbp: roundTo(dbp, 2),
    zone,
    blowout,
    spreadPick: spreadPickStr,
    ouPick: ouPickStr,
    spreadResult: spreadResult || '',
    ouResult: ouResult || '',
    margin,
    total,
    awayScore,
    homeScore,
    bookSpread: book?.spread ?? null,
    bookTotal:  book?.total ?? null,
    graded: true,
    syncedAt: new Date().toISOString(),
  };
}

function roundTo(n, places) {
  if (n == null || Number.isNaN(n)) return n;
  const m = 10 ** places;
  return Math.round(n * m) / m;
}

// ── Main reconciliation ────────────────────────────────────────────────

function* iterateRecentDates(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    yield d;
  }
}

// Compose a stable dedup key from date + league + matchup so seed rows
// (which have hand-rolled ids like "63") match games we'd otherwise add
// from ESPN (which would get an id like "g401873342"). Both code paths
// emit identical date / matchup / league strings.
function dedupKey(row) {
  return `${row.date}|${row.league || 'nba'}|${row.matchup}`;
}

export async function reconcileTracker({ days = SYNC_WINDOW_DAYS } = {}) {
  const existingRows = readRows();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const existingIds = new Set(existingRows.map((r) => r.id));
  const existingKeys = new Set(existingRows.map(dedupKey));

  const added = [];
  const skipped = { notFinal: 0, alreadyTracked: 0 };
  const ungradedAdded = [];
  let backfilled = 0; // existing rows where we filled in missing fields

  // Pre-fetch the server lock maps for both leagues across the full window
  // in parallel. Two HTTP requests vs (days × leagues) per-day fetches.
  // Each league fetch can fail independently — we just degrade to legacy
  // localStorage for that league this tick and retry next time.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fromYmd = ymd(addDays(today, -(days - 1)));
  const toYmd   = ymd(today);

  const serverLocks = { nba: new Map(), wnba: new Map() };
  const serverErrors = {};
  await Promise.all(LEAGUES.map(async (lg) => {
    try {
      serverLocks[lg] = await fetchServerLocks(lg, fromYmd, toYmd);
    } catch (e) {
      serverErrors[lg] = e.message || String(e);
      if (typeof console !== 'undefined') {
        console.warn(`[tracker-sync] ${lg} server locks unavailable → ${serverErrors[lg]}`);
      }
    }
  }));

  // Snapshot resolution order, per Step 4:
  //   1. Server map (preferred — authoritative, shared across devices)
  //   2. localStorage `dbp-locked-preds-v1` (legacy fallback for pre-Step-2
  //      games, or when the worker fetch failed this tick)
  //   3. None → ungraded row
  function resolveSnapshot(game) {
    const fromServer = serverLocks[game.league]?.get(game.id);
    if (fromServer) return fromServer;
    return getLocked(game.id) || null;
  }

  for (const date of iterateRecentDates(days)) {
    for (const league of LEAGUES) {
      let games;
      try {
        games = await fetchScoreboard(league, date);
      } catch {
        continue; // network hiccup — try other leagues/days
      }

      for (const game of games) {
        if (game.state !== 'post') { skipped.notFinal++; continue; }

        const id = trackerIdFor(game);
        const snapshot = resolveSnapshot(game);
        const row = snapshot
          ? buildTrackerRow(game, snapshot)
          : buildUngradedRow(game);

        // Dedupe by ID first (sync's own rows), then by date+matchup so
        // we never duplicate a seed row that lacks an ESPN id.
        if (existingIds.has(id)) {
          // Already tracked — but backfill any fields the previous version
          // of the reconciler didn't store. Currently: per-team final
          // scores (added so the Tracker page can show "AWAY−HOME"). Only
          // fills MISSING fields; never overwrites existing values to
          // preserve the integrity rule.
          const existing = existingById.get(id);
          if (existing && existing.awayScore == null && row.awayScore != null) {
            existing.awayScore = row.awayScore;
            existing.homeScore = row.homeScore;
            backfilled++;
          }
          skipped.alreadyTracked++;
          continue;
        }
        if (existingKeys.has(dedupKey(row))) { skipped.alreadyTracked++; continue; }

        added.push(row);
        if (!snapshot) ungradedAdded.push(row.id);
        existingIds.add(id);
        existingKeys.add(dedupKey(row));
      }
    }
  }

  // Persist if we added new rows OR backfilled any existing ones.
  if (added.length || backfilled > 0) {
    const next = [...existingRows, ...added];
    writeRows(next);
  }

  const meta = {
    lastSyncAt: new Date().toISOString(),
    lastAddedCount: added.length,
    lastBackfilledCount: backfilled,
    lastUngradedCount: ungradedAdded.length,
    lastSkipped: skipped,
    serverReached: Object.keys(serverErrors).length === 0,
    serverErrors,
  };
  writeMeta(meta);

  return { added, ungradedAdded, backfilled, skipped, meta };
}

export function getSyncMeta() {
  return readMeta();
}

// ── Listener bus so cross-component updates stay in sync ───────────────

const listeners = new Set();

export function subscribeSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

// Wrap reconcileTracker so it always fires the listener bus after writing.
const _reconcile = reconcileTracker;
export async function reconcileAndNotify(opts) {
  const out = await _reconcile(opts);
  notify();
  return out;
}
