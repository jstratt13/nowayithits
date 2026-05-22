// dbp-tracker-worker
//
// Routes:
//   GET /health                  → {ok:true}
//   GET /teams/:league           → team stats per team (BBR-scraped)
//   GET /injuries/:league        → rolled-up injury list (Rotowire-scraped)
//   GET /line-movement/:league   → opening vs current line per game (TODO)
//   GET /nba-injury-report       → official NBA injury report (TODO, PDF)
//
// All responses are JSON. CORS is wide-open so a GitHub-Pages-hosted
// frontend can fetch directly. Each scraper caches its result for a
// scraper-specific TTL via Cloudflare KV.

import { scrapeTeamStats } from './scrapers/bbref.js';
import { scrapeInjuries } from './scrapers/rotowire.js';
import { scrapeLineMovement } from './scrapers/vegasinsider.js';
import { scrapeOfficialInjuries } from './scrapers/nbaOfficial.js';
import { scrapeUnderdogWire } from './scrapers/underdog.js';
import { cached } from './cache.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...(init.headers || {}) },
  });
}

function err(message, status = 500, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

function leagueFromPath(seg) {
  const l = (seg || '').toLowerCase();
  return l === 'nba' || l === 'wnba' ? l : null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'GET') return err('method not allowed', 405);

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts.length === 0 || parts[0] === 'health') {
        return json({ ok: true, name: 'dbp-tracker-worker', time: new Date().toISOString() });
      }

      if (parts[0] === 'teams' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);
        const data = await cached(env, `teams:${league}`, 60 * 60 * 6, () =>
          scrapeTeamStats(league, env)
        );
        return json({ ok: true, league, ...data });
      }

      if (parts[0] === 'injuries' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);
        const data = await cached(env, `injuries:${league}`, 60 * 15, () =>
          scrapeInjuries(league, env)
        );
        return json({ ok: true, league, ...data });
      }

      if (parts[0] === 'nba-injury-report') {
        const data = await cached(env, 'nba-injury-report', 60 * 30, () =>
          scrapeOfficialInjuries(env)
        );
        return json({ ok: true, ...data });
      }

      if (parts[0] === 'underdog') {
        const data = await cached(env, 'underdog-wire', 60 * 5, () =>
          scrapeUnderdogWire(env)
        );
        return json({ ok: true, ...data });
      }

      if (parts[0] === 'line-movement' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);
        const data = await cached(env, `line-movement:${league}`, 60 * 5, () =>
          scrapeLineMovement(league, env)
        );
        return json({ ok: true, league, ...data });
      }

      return err('not found', 404);
    } catch (e) {
      return err(e.message || String(e), 502, { stack: (e.stack || '').slice(0, 800) });
    }
  },
};
