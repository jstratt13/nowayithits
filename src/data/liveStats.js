// Live-data store backed by the Cloudflare Worker.
//
// The formula module reads team stats via getActiveTeamStats() and injuries
// via getInjuryScore(). Until the worker fetch resolves (or if the worker
// URL isn't configured), we transparently fall back to the bundled stub in
// teamStats.js — so the app still works on first load.

import { TEAM_STATS as STUB_STATS, ABBR_ALIAS } from './teamStats.js';
import { computeInjuryScore } from './formulaCore.js';

// Set this via .env as VITE_WORKER_URL=https://your-worker.your-subdomain.workers.dev
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

const LIVE_TEAMS = { nba: null, wnba: null };
const LIVE_INJURIES = { nba: null, wnba: null };
// Per-team injury score, keyed by ESPN numeric team id. Populated alongside
// LIVE_INJURIES so getInjuryScore() is a constant-time lookup against the
// same source as the player list shown on each card.
const LIVE_INJURY_SCORES = { nba: null, wnba: null };
const LIVE_META = { teams: { nba: null, wnba: null }, injuries: { nba: null, wnba: null } };
const pending = new Set();
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fetchJSON(path) {
  if (!WORKER_URL) throw new Error('VITE_WORKER_URL not set');
  // Append a per-hour cache-buster so the browser and Cloudflare edge
  // never serve a stale worker response. The worker uses KV for its own
  // caching (6-hour TTL for team stats, 15-min for injuries).
  const hourSlot = Math.floor(Date.now() / 3_600_000);
  const bust = path.includes('?') ? `&_h=${hourSlot}` : `?_h=${hourSlot}`;
  const res = await fetch(`${WORKER_URL}${path}${bust}`, { mode: 'cors' });
  if (!res.ok) throw new Error(`worker ${path} → ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'worker error');
  return body;
}

// Basketball-Reference uses different abbreviations than ESPN
// (e.g., BBR="SAS", ESPN="SA"; BBR="NYK", ESPN="NY").
// The worker scrapes BBR so its keys need to be re-mapped to ESPN
// format before we store them, so formula.js lookups always work.
function normalizeBBRKeys(teams) {
  const out = {};
  for (const [bbrKey, data] of Object.entries(teams)) {
    const appKey = ABBR_ALIAS[bbrKey] || bbrKey;
    out[appKey] = data;
  }
  return out;
}

export function ensureTeamStats(league) {
  if (LIVE_TEAMS[league] !== null) return;
  if (pending.has(`teams:${league}`)) return;
  pending.add(`teams:${league}`);

  fetchJSON(`/teams/${league}`)
    .then((body) => {
      LIVE_TEAMS[league] = normalizeBBRKeys(body.teams || {});
      LIVE_META.teams[league] = { source: body.source, season: body.season, fetchedAt: body.fetchedAt };
    })
    .catch((e) => {
      LIVE_TEAMS[league] = {};
      LIVE_META.teams[league] = { source: 'fallback', reason: e.message };
    })
    .finally(() => {
      pending.delete(`teams:${league}`);
      notify();
    });
}

// Fetch injuries directly from ESPN (no worker needed — free + CORS-enabled).
// Keyed by ESPN numeric team ID so the lookup in GameCard is a direct match
// against game.home.id / game.away.id with no abbreviation translation.
const ESPN_INJURY_URL = {
  nba:  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/injuries',
};

export function ensureInjuries(league) {
  if (LIVE_INJURIES[league] !== null) return;
  if (pending.has(`injuries:${league}`)) return;
  pending.add(`injuries:${league}`);

  const url = ESPN_INJURY_URL[league];
  if (!url) {
    LIVE_INJURIES[league] = {};
    pending.delete(`injuries:${league}`);
    notify();
    return;
  }

  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      // Build two parallel maps from the same fetch:
      //   byTeamId    → [...players]   (drives the per-card injury list UI)
      //   scoreByTeamId → number       (drives Δ_Star inside the formula)
      // Both are keyed by ESPN's numeric team id so a lookup off a game's
      // home.id / away.id is a direct hit — no abbr translation needed.
      const byTeamId = {};
      const scoreByTeamId = {};
      for (const team of data.injuries || []) {
        const players = (team.injuries || []).map((inj) => ({
          player: inj.athlete?.displayName || '—',
          status: inj.status || '',
          comment: inj.shortComment || '',
        }));
        if (players.length) {
          byTeamId[team.id] = players;
          scoreByTeamId[team.id] = computeInjuryScore(players);
        }
      }
      LIVE_INJURIES[league] = byTeamId;
      LIVE_INJURY_SCORES[league] = scoreByTeamId;
      LIVE_META.injuries[league] = { source: 'espn.com', fetchedAt: new Date().toISOString(), count: Object.keys(byTeamId).length };
    })
    .catch((e) => {
      LIVE_INJURIES[league] = {};
      LIVE_INJURY_SCORES[league] = {};
      LIVE_META.injuries[league] = { source: 'fallback', reason: e.message };
    })
    .finally(() => {
      pending.delete(`injuries:${league}`);
      notify();
    });
}

function resolveAbbr(abbr) {
  return ABBR_ALIAS[abbr] || abbr;
}

export function getActiveTeamStats(league, abbr) {
  const key = resolveAbbr(abbr);
  const live = LIVE_TEAMS[league];
  if (live && live[key]) return live[key];
  return (STUB_STATS[league] && STUB_STATS[league][key]) || null;
}

// Note: keyed by ESPN numeric team id (game.home.id / game.away.id), NOT
// by abbreviation. Previously this was looked up by abbr against a map
// keyed by id, which silently returned 0 for every team — making Δ_Star
// a no-op in practice. See formulaCore.js `computeInjuryScore` for the
// per-status weights that build each team's score.
export function getInjuryScore(league, teamId) {
  const scores = LIVE_INJURY_SCORES[league];
  if (!scores || !teamId) return 0;
  return scores[teamId] || 0;
}

// Force a fresh injury fetch regardless of current cache state.
// Called by the 10-min background ticker in useLiveStats.
export function refreshInjuries(league) {
  LIVE_INJURIES[league] = null; // reset so ensureInjuries re-fetches
  LIVE_INJURY_SCORES[league] = null;
  ensureInjuries(league);
}

// Returns the flat player list for a team by ESPN numeric team ID, or [].
// Pass the team object from the ESPN scoreboard (game.home / game.away).
export function getTeamInjuries(league, teamId) {
  const live = LIVE_INJURIES[league];
  if (!live || !teamId) return [];
  return live[String(teamId)] || [];
}

export function getLiveSources() {
  return LIVE_META;
}

export { ABBR_ALIAS };
