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
import { scrapeTeamStats, teamsCacheKey } from './scrapers/bbref.js';
import { getRosters } from './scrapers/bbrRoster.js';
import { cached } from './cache.js';
import { detectGameEvents, appendEvents } from './events.js';
import { dispatchPush } from './push.js';
import { resolveAbbr } from '../../src/data/abbrAlias.js';
// Per-player last-10 availability (ESPN box scores), refreshed daily by
// .github/workflows/refresh-availability.yml and bundled at deploy time.
import availabilityData from '../../src/data/availability.json';

const { computeInjuryScoreDetailed, normalizeName } = core;

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

// Walks backwards 3 days from the target slate date, pulling ESPN
// scoreboards and recording the most recent completed game for each
// team. Returns teamId → ET YYYYMMDD of that team's last game. Used by
// the formula layer to know whether a team is playing on B2B / rest.
//
// 3-day window is enough to tell "played yesterday (B2B)" apart from
// "played 2 days ago (1 day rest)" apart from "played 3+ days ago
// (well-rested)" — anything beyond that collapses to the same "rested"
// bucket in the rest-adjustment coefficient.
async function fetchRecentGames(league, etDateStr) {
  const path = LEAGUE_PATH[league];
  if (!path) return {};
  const lastGamePlayed = {};
  for (let i = 1; i <= 3; i++) {
    const prevDate = shiftEtYmd(etDateStr, -i);
    try {
      const url = `${ESPN_BASE}/${path}/scoreboard?dates=${prevDate}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        const state = ev.status?.type?.state;
        // Count all scheduled + completed games — "in progress" shouldn't
        // happen for a date in the past, but if it does, that team was
        // still playing that day, so they still get a rest-day entry.
        if (state === 'pre' && i > 0) continue;
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        for (const c of (comp.competitors || [])) {
          const teamId = String(c.team?.id || c.id || '');
          // First-write-wins: since we iterate i=1 (yesterday) first,
          // the most recent game for each team is what we keep.
          if (teamId && !lastGamePlayed[teamId]) {
            lastGamePlayed[teamId] = prevDate;
          }
        }
      }
    } catch (e) {
      /* skip this day on any error — rest info is nice-to-have, not required */
    }
  }
  return lastGamePlayed;
}

// Days between the slate game and the team's previous game, inclusive
// of calendar-day boundaries. Interpretation:
//   1 = played yesterday  → back-to-back (B2B)
//   2 = played 2 days ago → 1 day of rest between games
//   3+ = well-rested
//   null = no recent game in our 3-day window (likely 3+ rest)
function daysSincePreviousGame(teamId, gameEtDateStr, lastGamePlayed) {
  const last = lastGamePlayed[teamId];
  if (!last) return null;
  const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12);
  const diffMs = toDay(gameEtDateStr) - toDay(last);
  return Math.round(diffMs / 86_400_000);
}

// Fetches the ESPN injuries endpoint and reduces it to per-team injury
// data: scalar score (for Δ_Star) + per-player rows (for the breakdown
// surface). Both come from a single computeInjuryScoreDetailed pass so
// score and rows can't drift.
//
// When `espnAbbrByTeamId` is provided, joins each ESPN team's injury
// list against the bundled BBR roster (src/data/rosters.json) so the
// score is PLAYER-WEIGHTED: a star OUT counts more than a 12th-man OUT.
// Falls through to status-only weights for teams we don't have an abbr
// mapping for (e.g. team isn't playing today, so it wasn't in the slate).
//
// Returns { scoresByTeamId: {}, detailByTeamId: {} } on failure so a
// transient ESPN hiccup doesn't blank predictions — Δ_Star just degrades
// to 0 for that cron tick.
async function fetchInjuryData(league, espnAbbrByTeamId) {
  const path = LEAGUE_PATH[league];
  if (!path) return { scoresByTeamId: {}, detailByTeamId: {} };
  try {
    const res = await fetch(`${ESPN_BASE}/${path}/injuries`);
    if (!res.ok) throw new Error(`ESPN ${path} injuries → ${res.status}`);
    const data = await res.json();
    const rosters = getRosters(league).teams || {};

    const scoresByTeamId = {};
    const detailByTeamId = {};
    for (const team of data.injuries || []) {
      const teamId = String(team.id);
      const players = (team.injuries || []).map((inj) => ({
        player: inj.athlete?.displayName || '',
        status: inj.status || '',
      }));
      if (!players.length) continue;

      const espnAbbr = espnAbbrByTeamId?.[teamId];
      const roster = espnAbbr ? rosters[espnAbbr] : null;
      const rosterByName = roster
        ? new Map(roster.players.map((p) => [normalizeName(p.name), p]))
        : null;

      // NBA → v2 valuation (needs the ESPN availability feed for the
      // "still in the ratings" fade); WNBA → legacy scoring.
      const avail = espnAbbr ? availabilityData?.[league]?.teams?.[espnAbbr] : null;
      const detail = computeInjuryScoreDetailed(players, rosterByName, { league, availability: avail });
      scoresByTeamId[teamId] = detail.score;
      detailByTeamId[teamId] = detail;
    }
    return { scoresByTeamId, detailByTeamId };
  } catch (e) {
    console.warn(`[predictions] ${league} injuries fetch failed:`, e?.message || e);
    return { scoresByTeamId: {}, detailByTeamId: {} };
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
      ...openingLines(odds),
    },
  };
}

// DraftKings' OPENING spread/total as ESPN reports it next to the current
// line (odds.pointSpread.home.open.line, odds.total.over.open.line). Kept
// so the tracker can grade "bet at the open" vs "bet at the close" — the
// 11/20/26 backtest showed lines move toward the model ~71% of the time.
function parseLineNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : null;
}
function openingLines(odds) {
  return {
    openLine:  parseLineNum(odds?.pointSpread?.home?.open?.line),
    openTotal: parseLineNum(odds?.total?.over?.open?.line),
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

function buildContext(teamsByEspnAbbr, injuryScoresByTeamId, injuryDetailByTeamId) {
  return {
    getTeamStats: (_league, abbr) => teamsByEspnAbbr[resolveAbbr(abbr)] || null,
    // Δ_Star reads ESPN's injury endpoint, keyed by numeric team id —
    // matches the frontend's getInjuryScore() lookup so server and client
    // produce identical predictions.
    getInjuryScore: (_league, teamId) => injuryScoresByTeamId[String(teamId)] || 0,
    // Per-player rows for the breakdown surface. Same data the scalar
    // score came from, so the two can't drift. Empty rows + score 0 when
    // a team isn't in the injuries payload (clean game day).
    getInjuryDetail: (_league, teamId) =>
      injuryDetailByTeamId[String(teamId)] || { score: 0, rows: [] },
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
    breakdown:  core.predictionBreakdown(game, ctx),
    book: {
      favored: game.odds.favored,
      spread:  game.odds.spread,
      total:   game.odds.total,
    },
  };
}

// Line timing for the tracker (11/20/26). Three moments, all home-signed:
//   open  — DraftKings' opening line (ESPN), whatever time we first see it
//   first — the line + pick on the FIRST cron run that had usable odds,
//           i.e. the earliest bet the app would have recommended. Carried
//           forward unchanged by mergeGame on every later run.
//   close — the line on this run; frozen with the snapshot at lock.
// Grading the same game at each moment shows whether betting early beats
// waiting (the market moves toward injury news between open and close).
function withLines(snap, game, nowIso) {
  return { ...snap, lines: lineTiming(game, snap, nowIso) };
}

function lineTiming(game, snap, nowIso) {
  const o = game.odds || {};
  return {
    open:  { homeLine: o.openLine ?? null, total: o.openTotal ?? null },
    first: { homeLine: o.homeLine, total: o.total, at: nowIso, sp: snap.sp, ou: snap.ou, projMargin: snap.projMargin },
    close: { homeLine: o.homeLine, total: o.total },
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
  // Keep the FIRST line/pick we ever saw for this game (see lineTiming).
  // Also keep an opening line we saw earlier if ESPN stops reporting it.
  const prevLines = existing?.predictions?.lines;
  if (predictions?.lines && prevLines && predictions !== existing.predictions) {
    predictions = {
      ...predictions,
      lines: {
        ...predictions.lines,
        first: prevLines.first ?? predictions.lines.first,
        open: predictions.lines.open?.homeLine != null ? predictions.lines.open : (prevLines.open ?? predictions.lines.open),
      },
    };
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

  // Slate + team stats + 3-day lookback in parallel. Injuries comes
  // AFTER the slate so we can build the espnAbbr-by-teamId map (Step B:
  // needed to join ESPN's injury entries with the bundled BBR roster
  // for per-player weighting).
  const hSlot = Math.floor(now / 3_600_000);
  const [slate, teamsBlob, lastGamePlayed] = await Promise.all([
    fetchSlate(league, etDateStr),
    cached(env, teamsCacheKey(league, hSlot), 60 * 60 * 6, () => scrapeTeamStats(league, env)),
    fetchRecentGames(league, etDateStr),
  ]);

  const espnAbbrByTeamId = {};
  for (const g of slate) {
    if (g.home?.id) espnAbbrByTeamId[String(g.home.id)] = g.home.abbr;
    if (g.away?.id) espnAbbrByTeamId[String(g.away.id)] = g.away.abbr;
  }

  const { scoresByTeamId, detailByTeamId } = await fetchInjuryData(league, espnAbbrByTeamId);
  const teamsByEspnAbbr = normalizeBBRKeys(teamsBlob.teams || {});
  const ctx = buildContext(teamsByEspnAbbr, scoresByTeamId, detailByTeamId);

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
  const newEvents = [];
  const nowIso = new Date(now).toISOString();
  for (const game of slate) {
    if (etYmdFromIso(game.date) !== etDateStr) continue;

    // Attach each team's days-since-previous-game before handing the game
    // off to formulaCore — used for the B2B margin + total adjustments.
    const slateEtDate = etYmdFromIso(game.date);
    game.home.daysRest = daysSincePreviousGame(String(game.home.id), slateEtDate, lastGamePlayed);
    game.away.daysRest = daysSincePreviousGame(String(game.away.id), slateEtDate, lastGamePlayed);

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
        daysRest: game.home.daysRest,
      },
      away: {
        id:    game.away.id,
        abbr:  game.away.abbr,
        name:  game.away.shortName || game.away.name,
        score: game.away.score,
        winner: game.away.winner,
        daysRest: game.away.daysRest,
      },
      odds: game.odds,
      predictions: usable ? withLines(snapshotFor(game, ctx), game, new Date(now).toISOString()) : null,
    };
    const prev = existingById.get(game.id);
    const merged = mergeGame(prev, fresh, now);
    // Change detection (Updates feed / push). Skipped for games that were
    // already locked — mergeGame returned them untouched.
    if (!(prev && prev.locked)) {
      // When this game first had a line — survives a run where the book
      // briefly pulls odds, so "line posted" can't fire twice.
      merged.lineSeenAt = prev?.lineSeenAt ?? (prev?.predictions || merged.predictions ? nowIso : null);
      const { events, alertState } = detectGameEvents(prev, merged, nowIso);
      if (merged.predictions && alertState) merged.predictions = { ...merged.predictions, alertState };
      newEvents.push(...events);
    }
    games.push(merged);
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
    events: appendEvents(existingBlob?.events, newEvents),
  };

  if (env.CACHE) {
    await env.CACHE.put(kvKey, JSON.stringify(blob));
  }
  // This run's new events (not stored separately) for push dispatch.
  return Object.assign(blob, { newEvents });
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
  const allNew = [];

  for (const league of ['nba', 'wnba']) {
    for (const dateStr of [today, tomorrow]) {
      try {
        const blob = await refreshPredictions(env, league, dateStr);
        allNew.push(...(blob.newEvents || []));
        results.push({ league, date: dateStr, games: blob.games.length, events: (blob.newEvents || []).length, ok: true });
      } catch (e) {
        results.push({ league, date: dateStr, ok: false, error: e.message || String(e) });
      }
    }
  }
  // Push this run's updates to subscribed phones (one bundled alert per
  // device). Never lets a push failure break the prediction refresh.
  try {
    results.push({ push: await dispatchPush(env, allNew) });
  } catch (e) {
    results.push({ push: { error: e.message || String(e) } });
  }
  return results;
}
