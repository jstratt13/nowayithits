// Live-data store backed by the Cloudflare Worker.
//
// The formula module reads team stats via getActiveTeamStats() and injuries
// via getInjuryScore(). Until the worker fetch resolves (or if the worker
// URL isn't configured), we transparently fall back to the bundled stub in
// teamStats.js — so the app still works on first load.

import { TEAM_STATS as STUB_STATS, ABBR_ALIAS } from './teamStats.js';

// Set this via .env as VITE_WORKER_URL=https://your-worker.your-subdomain.workers.dev
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

const LIVE_TEAMS = { nba: null, wnba: null };
const LIVE_INJURIES = { nba: null, wnba: null };
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
  const res = await fetch(`${WORKER_URL}${path}`, { mode: 'cors' });
  if (!res.ok) throw new Error(`worker ${path} → ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'worker error');
  return body;
}

export function ensureTeamStats(league) {
  if (LIVE_TEAMS[league] !== null) return;
  if (pending.has(`teams:${league}`)) return;
  pending.add(`teams:${league}`);

  fetchJSON(`/teams/${league}`)
    .then((body) => {
      LIVE_TEAMS[league] = body.teams || {};
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

export function ensureInjuries(league) {
  if (LIVE_INJURIES[league] !== null) return;
  if (pending.has(`injuries:${league}`)) return;
  pending.add(`injuries:${league}`);

  fetchJSON(`/injuries/${league}`)
    .then((body) => {
      LIVE_INJURIES[league] = body.byTeam || {};
      LIVE_META.injuries[league] = { source: body.source, fetchedAt: body.fetchedAt, count: body.count };
    })
    .catch((e) => {
      LIVE_INJURIES[league] = {};
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

export function getInjuryScore(league, abbr) {
  const live = LIVE_INJURIES[league];
  if (!live) return 0;
  const key = resolveAbbr(abbr);
  const t = live[key];
  return t ? (t.score || 0) : 0;
}

export function getLiveSources() {
  return LIVE_META;
}

export { ABBR_ALIAS };
