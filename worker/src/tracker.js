// ─────────────────────────────────────────────────────────────────────────
//  Server-side tracker grading — powers GET /tracker/graded.
//
//  Reads the pregame snapshots the cron already stored in KV
//  (predictions:<league>:<date>), re-fetches ESPN final scores for those
//  dates, grades each locked game's spread + O/U pick, and returns tracker-
//  shaped rows. A GitHub Action (refresh-tracker-graded.yml) calls this daily
//  and commits src/data/trackerGraded.json, so the graded record lives in the
//  repo instead of only in one browser's localStorage.
//
//  Grading uses the SAME helpers as the client reconciler (src/data/grading.js)
//  so client and server can't disagree on a Hit/Miss.
// ─────────────────────────────────────────────────────────────────────────

import { readPredictionsRange } from './predictions.js';
import { getZone } from '../../src/data/formulaCore.js';
import { gradeSpread, gradeOU } from '../../src/data/grading.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function fmtSignedLine(n) {
  if (n == null || Number.isNaN(n)) return '';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(1)}`;
}

// "20261104" → "November 4, 2026" (matches the client tracker's date format).
function prettyDate(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function roundTo(n, p) {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

// Final scores for one ET date, keyed by ESPN event id (= our gameId).
async function fetchFinals(league, ymd) {
  const path = league === 'wnba' ? 'wnba' : 'nba';
  try {
    const res = await fetch(`${ESPN_BASE}/${path}/scoreboard?dates=${ymd}`);
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    for (const ev of data.events || []) {
      const comp = (ev.competitions || [])[0] || {};
      if (!comp.status?.type?.completed) continue;
      const sc = {};
      for (const c of comp.competitors || []) sc[c.homeAway] = Number(c.score);
      if (sc.home != null && sc.away != null) {
        out[String(ev.id)] = { homeScore: sc.home, awayScore: sc.away };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function buildRow(game, p, league, ymd, finals) {
  const fin = finals[String(game.gameId)];
  if (!fin) return null; // not final yet → skip (re-graded on a later run)
  const home = { abbr: game.home.abbr, score: fin.homeScore };
  const away = { abbr: game.away.abbr, score: fin.awayScore };

  const inputs = p.inputs || {};
  const favAbbr = inputs.favoredIsHome ? game.home.abbr : game.away.abbr;
  const margin = Math.abs(fin.homeScore - fin.awayScore);
  const total = fin.homeScore + fin.awayScore;

  return {
    id: `g${game.gameId}`,
    league,
    date: prettyDate(ymd),
    matchup: `${game.away.abbr} @ ${game.home.abbr}`,
    posSRS: favAbbr,
    srsGap: roundTo((inputs.favSRS ?? 0) - (inputs.undSRS ?? 0), 2),
    starDelta: roundTo(inputs.deltaStar ?? 0, 2),
    hca: inputs.hca ?? null,
    dbp: roundTo(p.dbp, 2),
    zone: p.dbp != null ? getZone(p.dbp, league).label : null,
    spreadPick: p.sp ? `${p.sp.side} ${fmtSignedLine(p.sp.line)}` : '',
    ouPick: p.ou ? `${p.ou.direction} ${p.ou.line.toFixed(1)}` : '',
    spreadResult: gradeSpread(p.sp, away, home) || '',
    ouResult: gradeOU(p.ou, away, home) || '',
    margin,
    actualHomeMargin: fin.homeScore - fin.awayScore,
    projMargin: roundTo(p.projMargin, 2),
    total,
    projTotal: roundTo(p.projTotal, 2),
    awayScore: fin.awayScore,
    homeScore: fin.homeScore,
    bookSpread: p.book?.spread ?? null,
    bookTotal: p.book?.total ?? null,
    graded: true,
  };
}

// Grade every locked game with a pregame prediction in [fromStr, toStr].
// Returns { rows } or { tooLarge, maxDays } (range cap from readPredictionsRange).
export async function exportGraded(env, league, fromStr, toStr) {
  const range = await readPredictionsRange(env, league, fromStr, toStr);
  if (range.tooLarge) return { tooLarge: true, maxDays: range.maxDays };

  const rows = [];
  for (const day of range.days || []) {
    const dayGames = (day.games || []).filter((g) => g.predictions);
    if (!dayGames.length) continue;
    const finals = await fetchFinals(league, day.date);
    for (const g of dayGames) {
      const row = buildRow(g, g.predictions, league, day.date, finals);
      if (row) rows.push(row);
    }
  }
  return { rows };
}
