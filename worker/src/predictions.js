// ─────────────────────────────────────────────────────────────────────────
//  Predictions orchestrator — runs on a cron trigger every 10 min.
//
//  Pulls the ESPN slate (today + tomorrow, ET), pulls team stats from the
//  existing BBR scraper (KV-cached), and computes each game's prediction
//  via the shared formulaCore module. Stores the result as one blob per
//  league per ET date in KV.
//
//  Lock semantics (per INTEGRITY RULES in src/data/lockedPredictions.js):
//
//    1. A snapshot is mutable while tipoff > now + LOCK_BUFFER (5 min).
//       It updates every cron run as odds / stats refresh.
//
//    2. When tipoff ≤ now + LOCK_BUFFER, the snapshot is computed one
//       final time and marked `locked: true`. From then on, no cron run
//       will overwrite it — even if the model formula changes later.
//
//    3. A game that disappears from ESPN's slate (postponement, cancel)
//       is preserved in the blob IF it was already locked. This keeps
//       graded outcomes in the tracker reachable.
//
//  Free-tier KV budget: 4 writes per cron run (2 leagues × 2 dates) +
//  occasional team-stats refresh = comfortably under 1k writes/day.
// ─────────────────────────────────────────────────────────────────────────

import * as core from '../../src/data/formulaCore.js';
import { scrapeTeamStats } from './scrapers/bbref.js';
import { cached } from './cache.js';

const { computeInjuryScore } = core;

// ── ESPN abbreviation aliasing ────────────────────────────────────────
// Mirrors src/data/teamStats.js ABBR_ALIAS. BBR uses 3-letter codes
// (NYK, SAS, GSW); ESPN's scoreboard uses 2-letter codes (NY, SA, GS).
// We re-key the BBR team stats by ESPN abbreviation before lookup.
const ABBR_ALIAS = {
  NYK: 'NY',
  SAS: 'SA',
  NOP: 'NO',
  GSW: 'GS',
  UTA: 'UTAH',
  WAS: 'WSH',
  CON: 'CONN',
  PHO: 'PHX',
};
const resolveAbbr = (a) => ABBR_ALIAS[a] || a;

function normalizeBBRKeys(teams) {
  const out = {};
  for (const [bbrKey, data] of Object.entries(teams || {})) {
    out[resolveAbbr(bbrKey)] = data;
  }
  return out;
}

// ── Date helpers (America/New_York) ───────────────────────────────────
// All "today" semantics for the slate use ET, since the NBA + WNBA
// schedules are anchored there.

export function etYmd(when = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}${lookup.month}${lookup.day}`;
}

function etYmdFromIso(iso) {
  return etYmd(new Date(iso));
}

export function shiftEtYmd(dateStr, dayDelta) {
  // Treat dateStr as a calendar date in ET, shift by dayDelta days, return
  // the new ET YYYYMMDD. Done via UTC midpoint to avoid DST seams.
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const noonUtc = Date.UTC(y, m - 1, d, 12) + dayDelta * 86_400_000;
  return etYmd(new Date(noonUtc));
}

// ── ESPN slate ────────────────────────────────────────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball';
const LEAGUE_PATH = { nba: 'nba', wnba: 'wnba' };

async function fetchSlate(league, etDateStr) {
  const path = LEAGUE_PATH[league];
  if (!path) throw new Error(`unsupported league: ${league}`);
  const url = `${ESPN_BASE}/${path}/scoreboard?dates=${etDateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${path} scoreboard ${etDateStr} → ${res.status}`);
  const data = await res.json();
  return (data.events || []).map((ev) => normalizeEvent(ev, league)).filter(Boolean);
}

// Fetches the ESPN injuries endpoint and reduces it to a map of
//   { [teamId: string]: number }   // injury score for Δ_Star
// Returns {} on failure so a transient ESPN hiccup doesn't blank
// predictions — Δ_Star just degrades to 0 for that cron tick.
async function fetchInjuryScores(league) {
  const path = LEAGUE_PATH[league];
  if (!path) return {};
  try {
    const res = await fetch(`${ESPN_BASE}/${path}/injuries`);
    if (!res.ok) throw new Error(`ESPN ${path} injuries → ${res.status}`);
    const data = await res.json();
    const scores = {};
    for (const team of data.injuries || []) {
      const players = (team.injuries || []).map((inj) => ({ status: inj.status || '' }));
      if (players.length) scores[String(team.id)] = computeInjuryScore(players);
    }
    return scores;
  } catch (e) {
    // Logged but not thrown — Δ_Star = 0 fallback is safer than failing
    // the whole prediction blob.
    console.warn(`[predictions] ${league} injuries fetch failed:`, e?.message || e);
    return {};
  }
}

// Same normalization as src/data/espn.js so the game shape matches what the
// frontend produces — keeps formulaCore output identical between server and
// client compute paths.
function normalizeEvent(ev, league) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const status = ev.status?.type || {};
  const state = status.state || 'pre';
  const odds = comp.odds?.[0] || null;
  const homeTeam = teamFrom(home);
  const awayTeam = teamFrom(away);

  let homeLine = null;
  if (odds) {
    if (typeof odds.spread === 'number') {
      homeLine = odds.spread;
    } else if (typeof odds.details === 'string') {
      const m = odds.details.match(/([A-Z]{2,4})\s*([+-]?\d+(\.\d+)?)/);
      if (m) {
        const favAbbr = m[1];
        const num = parseFloat(m[2]);
        const favoredAtHome = favAbbr === homeTeam.abbr;
        homeLine = favoredAtHome ? -Math.abs(num) : Math.abs(num);
      }
    }
  }

  let homeFavored = null;
  if (odds?.homeTeamOdds?.favorite === true) homeFavored = true;
  else if (odds?.awayTeamOdds?.favorite === true) homeFavored = false;
  else if (homeLine != null) homeFavored = homeLine < 0;

  const bookSpread = homeLine == null ? null : Math.abs(homeLine);
  const favoredAbbr = homeFavored == null ? null : (homeFavored ? homeTeam.abbr : awayTeam.abbr);

  return {
    id: ev.id,
    league,
    date: ev.date,
    state,
    statusLabel: status.shortDetail || status.description || '',
    home: homeTeam,
    away: awayTeam,
    odds: {
      homeLine,
      spread: bookSpread,
      total: odds?.overUnder ?? null,
      homeFavored,
      favored: favoredAbbr,
      provider: odds?.provider?.name || null,
    },
  };
}

function teamFrom(side) {
  const t = side.team || {};
  return {
    id: t.id,
    name: t.displayName || t.name,
    shortName: t.shortDisplayName || t.name,
    abbr: t.abbreviation || '',
    score: side.score != null ? Number(side.score) : null,
    winner: !!side.winner,
  };
}

// ── ctx + snapshot ────────────────────────────────────────────────────

function buildContext(teamsByEspnAbbr, injuryScoresByTeamId) {
  return {
    getTeamStats: (_league, abbr) => teamsByEspnAbbr[resolveAbbr(abbr)] || null,
    // Δ_Star reads ESPN's injury endpoint, keyed by numeric team id —
    // matches the frontend's getInjuryScore() lookup so server and client
    // produce identical predictions.
    getInjuryScore: (_league, teamId) => injuryScoresByTeamId[String(teamId)] || 0,
  };
}

function snapshotFor(game, ctx) {
  return {
    dbp:        core.computeDBP(game, ctx),
    projTotal:  core.projectedTotal(game, ctx),
    projMargin: core.projectedMargin(game, ctx),
    sp:         core.spreadPick(game, ctx),
    ou:         core.ouPick(game, ctx),
    inputs:     core.predictionInputs(game, ctx),
    book: {
      favored: game.odds.favored,
      spread:  game.odds.spread,
      total:   game.odds.total,
    },
  };
}

function hasUsableOdds(game) {
  return !!game.odds && game.odds.homeLine != null && game.odds.total != null;
}

// ── Lock decision ─────────────────────────────────────────────────────

const LOCK_BUFFER_MS = 5 * 60 * 1000; // lock 5 min before tipoff

function shouldLock(tipoffMs, nowMs) {
  return tipoffMs - nowMs <= LOCK_BUFFER_MS;
}

// Merge fresh compute into existing snapshot, honoring the integrity rule.
// If the existing snapshot is already locked, return it untouched.
function mergeGame(existing, fresh, nowMs) {
  if (existing && existing.locked) return existing;

  const tipoffMs = new Date(fresh.tipoff).getTime();
  const lockNow = Number.isFinite(tipoffMs) && shouldLock(tipoffMs, nowMs);

  // If we're locking THIS run and we don't have a usable prediction (e.g.
  // odds went missing at the wire), prefer the previous unlocked snapshot's
  // predictions over null — but still flip locked: true so we stop trying.
  let predictions = fresh.predictions;
  if (lockNow && !predictions && existing?.predictions) {
    predictions = existing.predictions;
  }

  return {
    ...fresh,
    predictions,
    locked: lockNow,
    lockedAt: lockNow ? new Date(nowMs).toISOString() : null,
  };
}

// ── Main entry: refresh one (league, etDate) bucket ───────────────────

export async function refreshPredictions(env, league, etDateStr) {
  const now = Date.now();

  // Slate + team stats + injury scores in parallel — independent fetches,
  // no point serializing them.
  const hSlot = Math.floor(now / 3_600_000);
  const [slate, teamsBlob, injuryScores] = await Promise.all([
    fetchSlate(league, etDateStr),
    cached(env, `teams:${league}:${hSlot}`, 60 * 60 * 6, () => scrapeTeamStats(league, env)),
    fetchInjuryScores(league),
  ]);
  const teamsByEspnAbbr = normalizeBBRKeys(teamsBlob.teams || {});
  const ctx = buildContext(teamsByEspnAbbr, injuryScores);

  // Load existing snapshots for this league/date so locked games are
  // preserved verbatim.
  const kvKey = `predictions:${league}:${etDateStr}`;
  let existingBlob = null;
  try {
    if (env.CACHE) existingBlob = await env.CACHE.get(kvKey, { type: 'json' });
  } catch {
    /* fall through with no existing data */
  }
  const existingById = new Map();
  for (const g of existingBlob?.games || []) existingById.set(g.gameId, g);

  // Compute fresh predictions for games that fall in THIS ET date bucket.
  // ESPN's scoreboard occasionally returns games whose ET tipoff date is
  // actually the next day (e.g. 10pm PT = 1am ET); those get picked up by
  // the cron run for the next date instead.
  const games = [];
  for (const game of slate) {
    if (etYmdFromIso(game.date) !== etDateStr) continue;

    const usable = hasUsableOdds(game);
    const fresh = {
      gameId: game.id,
      league,
      tipoff: game.date,
      state: game.state,
      statusLabel: game.statusLabel,
      computedAt: new Date(now).toISOString(),
      home: {
        id:    game.home.id,
        abbr:  game.home.abbr,
        name:  game.home.shortName || game.home.name,
        score: game.home.score,
        winner: game.home.winner,
      },
      away: {
        id:    game.away.id,
        abbr:  game.away.abbr,
        name:  game.away.shortName || game.away.name,
        score: game.away.score,
        winner: game.away.winner,
      },
      odds: game.odds,
      predictions: usable ? snapshotFor(game, ctx) : null,
    };
    games.push(mergeGame(existingById.get(game.id), fresh, now));
  }

  // Carry over locked snapshots whose game disappeared from the live slate
  // (postponed / cancelled). Drop unlocked-and-gone games — they're just
  // noise.
  for (const [id, g] of existingById) {
    if (g.locked && !games.find((x) => x.gameId === id)) {
      games.push(g);
    }
  }

  const blob = {
    league,
    date: etDateStr,
    computedAt: new Date(now).toISOString(),
    games,
  };

  if (env.CACHE) {
    await env.CACHE.put(kvKey, JSON.stringify(blob));
  }
  return blob;
}

// Read-only access used by the GET /predictions route.
export async function readPredictions(env, league, etDateStr) {
  const kvKey = `predictions:${league}:${etDateStr}`;
  try {
    if (!env.CACHE) return emptyBlob(league, etDateStr);
    const blob = await env.CACHE.get(kvKey, { type: 'json' });
    return blob || emptyBlob(league, etDateStr);
  } catch {
    return emptyBlob(league, etDateStr);
  }
}

function emptyBlob(league, etDateStr) {
  return { league, date: etDateStr, computedAt: null, games: [] };
}

// Inclusive list of YYYYMMDD strings between fromStr and toStr.
// Guards against accidental huge ranges so the worker doesn't fan out to
// hundreds of KV reads in a single request.
const MAX_RANGE_DAYS = 60;

function enumerateRange(fromStr, toStr) {
  // Treat both endpoints as ET calendar dates. Iterate by adding 1 ET day at
  // a time via shiftEtYmd — handles month/year boundaries and DST seams.
  const out = [];
  let cur = fromStr;
  for (let i = 0; i < MAX_RANGE_DAYS; i++) {
    out.push(cur);
    if (cur === toStr) return out;
    cur = shiftEtYmd(cur, 1);
  }
  // Hit the cap without reaching toStr → range exceeded MAX_RANGE_DAYS.
  // Caller validates this and returns 400.
  return null;
}

// Batch range read used by the Tracker reconciler so a single sync tick can
// fetch a 30-day window in one HTTP round trip instead of 30 sequential
// fetches. Returns one entry per date in the (inclusive) range; days the
// cron never wrote return an empty `games: []` rather than being skipped,
// so callers can distinguish "no games" from "missing data".
export async function readPredictionsRange(env, league, fromStr, toStr) {
  const dates = enumerateRange(fromStr, toStr);
  if (!dates) return { tooLarge: true, maxDays: MAX_RANGE_DAYS };
  const days = await Promise.all(dates.map((d) => readPredictions(env, league, d)));
  return { days };
}

// Cron driver: refresh both leagues × (today, tomorrow) in ET.
export async function refreshAllForCron(env) {
  const today = etYmd();
  const tomorrow = shiftEtYmd(today, 1);
  const results = [];

  for (const league of ['nba', 'wnba']) {
    for (const dateStr of [today, tomorrow]) {
      try {
        const blob = await refreshPredictions(env, league, dateStr);
        results.push({ league, date: dateStr, games: blob.games.length, ok: true });
      } catch (e) {
        results.push({ league, date: dateStr, ok: false, error: e.message || String(e) });
      }
    }
  }
  return results;
}
