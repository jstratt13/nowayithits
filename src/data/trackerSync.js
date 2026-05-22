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
import { getZone, BLOWOUT_THRESHOLD } from './formula.js';

const TRACKER_KEY = 'dbp-tracker-v1';
const SYNC_META_KEY = 'dbp-tracker-sync-v1';

// How many days of completed games to consider on each sync pass.
const SYNC_WINDOW_DAYS = 7;

const LEAGUES = ['nba', 'wnba'];

// ── Storage helpers ────────────────────────────────────────────────────

function readRows() {
  try {
    const raw = localStorage.getItem(TRACKER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
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
  const margin = Math.abs((game.home.score ?? 0) - (game.away.score ?? 0));
  const total  = (game.home.score ?? 0) + (game.away.score ?? 0);
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

  const margin = Math.abs((game.home.score ?? 0) - (game.away.score ?? 0));
  const total  = (game.home.score ?? 0) + (game.away.score ?? 0);

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

export async function reconcileTracker({ days = SYNC_WINDOW_DAYS } = {}) {
  const existingRows = readRows();
  const existingIds = new Set(existingRows.map((r) => r.id));

  const added = [];
  const skipped = { notFinal: 0, alreadyTracked: 0 };
  const ungradedAdded = [];

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
        if (existingIds.has(id)) { skipped.alreadyTracked++; continue; }

        const snapshot = getLocked(game.id);
        const row = snapshot
          ? buildTrackerRow(game, snapshot)
          : buildUngradedRow(game);
        added.push(row);
        if (!snapshot) ungradedAdded.push(row.id);
        existingIds.add(id);
      }
    }
  }

  if (added.length) {
    const next = [...existingRows, ...added];
    writeRows(next);
  }

  const meta = {
    lastSyncAt: new Date().toISOString(),
    lastAddedCount: added.length,
    lastUngradedCount: ungradedAdded.length,
    lastSkipped: skipped,
  };
  writeMeta(meta);

  return { added, ungradedAdded, skipped, meta };
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
