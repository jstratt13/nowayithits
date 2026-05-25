// ─────────────────────────────────────────────────────────────────────────
//  Live injury data for the per-card injury display.
//
//  This module used to also fetch and cache team stats + compute per-team
//  injury SCORES for a local-compute prediction path. That whole local
//  path is gone — predictions now come from the worker (Step 3). The
//  remaining job here is narrow:
//
//    1. Fetch ESPN's `/injuries/:league` endpoint (free + CORS-friendly).
//    2. Index by ESPN numeric team id.
//    3. Hand the per-team player list to GameCard for the inline injury
//       rollup (red OUT dots, orange QUESTIONABLE dots, etc.).
//
//  Refresh every 10 min via useLiveStats's background ticker so late
//  scratches surface without a manual reload.
// ─────────────────────────────────────────────────────────────────────────

const LIVE_INJURIES = { nba: null, wnba: null };
const pending = new Set();
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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
      // Keyed by ESPN numeric team id → flat player list. Each entry
      // has { player, status, comment } so the card can render names
      // alongside an OUT/QUESTIONABLE chip.
      const byTeamId = {};
      for (const team of data.injuries || []) {
        const players = (team.injuries || []).map((inj) => ({
          player: inj.athlete?.displayName || '—',
          status: inj.status || '',
          comment: inj.shortComment || '',
        }));
        if (players.length) byTeamId[team.id] = players;
      }
      LIVE_INJURIES[league] = byTeamId;
    })
    .catch(() => {
      LIVE_INJURIES[league] = {};
    })
    .finally(() => {
      pending.delete(`injuries:${league}`);
      notify();
    });
}

// Force a fresh injury fetch regardless of current cache state.
// Called by the 10-min background ticker in useLiveStats.
export function refreshInjuries(league) {
  LIVE_INJURIES[league] = null;
  ensureInjuries(league);
}

// Returns the flat player list for a team by ESPN numeric team ID, or [].
// Pass the team object's id directly (game.home.id / game.away.id).
export function getTeamInjuries(league, teamId) {
  const live = LIVE_INJURIES[league];
  if (!live || !teamId) return [];
  return live[String(teamId)] || [];
}
