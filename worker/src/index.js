// dbp-tracker-worker
//
// Routes (all except /health and /auth/* require a Bearer JWT; /admin/*
// requires an admin claim):
//
//   Public:
//     GET  /health                              — liveness
//     POST /auth/signup                         — public user signup + email verify
//     GET  /auth/verify?token=...               — consume verification link
//     POST /auth/login                          — user or admin login
//     GET  /auth/me                             — introspect current JWT
//
//   Authenticated:
//     GET  /teams/:league                       — BBR team stats (6h KV cache)
//     GET  /rosters/:league                     — bundled per-player data
//     GET  /predictions/:league?date=YYYYMMDD   — single-day blob
//     GET  /predictions/:league?from=&to=       — range (max 60 days)
//
//   Admin:
//     GET  /admin/refresh                       — manually drive the cron pipeline
//
// All responses are JSON. CORS is wide-open so a GitHub-Pages-hosted
// frontend can fetch directly. Scraper caching lives in cache.js /
// predictions.js.

import { scrapeTeamStats } from './scrapers/bbref.js';
import { getRosters } from './scrapers/bbrRoster.js';
import { cached } from './cache.js';
import {
  refreshPredictions,
  readPredictions,
  readPredictionsRange,
  refreshAllForCron,
  etYmd,
} from './predictions.js';
import { handleAuthRoute } from './auth/handlers.js';
import { requireAuth, requireAdmin } from './auth/middleware.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Prevent Cloudflare's edge PoP from caching dynamic API responses.
      // The worker manages its own freshness via KV.
      'cache-control': 'no-store',
      ...CORS,
      ...(init.headers || {}),
    },
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
  async fetch(request, env /* ctx */) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      // Auth routes accept POST (signup, login) so they need to be
      // dispatched before the GET-only guard below.
      const authResp = await handleAuthRoute(request, env, url, parts, CORS);
      if (authResp) return authResp;

      // Everything else is GET-only.
      if (request.method !== 'GET') return err('method not allowed', 405);

      // ── Public ──
      if (parts.length === 0 || parts[0] === 'health') {
        return json({ ok: true, name: 'dbp-tracker-worker', time: new Date().toISOString() });
      }

      // ── Authenticated data routes — single gate for all of them ──
      if (
        parts[0] === 'teams' ||
        parts[0] === 'rosters' ||
        parts[0] === 'predictions'
      ) {
        const a = await requireAuth(request, env, CORS);
        if (!a.ok) return a.response;
      }

      if (parts[0] === 'teams' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);
        // Use the hour slot from the frontend's cache-buster param as the KV key
        // so we return fresh data once per hour without always scraping BBR.
        const hSlot = url.searchParams.get('_h') || '0';
        const cacheKey = `teams:${league}:${hSlot}`;
        const data = await cached(env, cacheKey, 60 * 60 * 6, () =>
          scrapeTeamStats(league, env)
        );
        return json({ ok: true, league, ...data });
      }

      // GET /rosters/:league
      // Per-team roster with MPG + BPM + PER per player. Served from the
      // bundled src/data/rosters.json snapshot (refreshed daily by the
      // GitHub Actions workflow .github/workflows/refresh-rosters.yml).
      // No runtime BBR fetch — that lived here previously and got rate-
      // limited hard by Cloudflare worker IPs.
      if (parts[0] === 'rosters' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);
        return json({ ok: true, league, ...getRosters(league) });
      }

      // GET /predictions/:league?date=YYYYMMDD
      //   → single-day blob (used by the Predictions page)
      // GET /predictions/:league?from=YYYYMMDD&to=YYYYMMDD
      //   → array of day blobs (used by the Tracker reconciler to grab a
      //     30-day window in one round trip)
      //
      // Snapshots are populated by the cron handler every 10 min; once a
      // game is within 5 min of tipoff its snapshot is frozen
      // ("locked: true") and never overwritten thereafter. Range fetches
      // cap at MAX_RANGE_DAYS (60) so the worker can't fan out into a
      // hundreds-of-KV-reads request.
      if (parts[0] === 'predictions' && parts[1]) {
        const league = leagueFromPath(parts[1]);
        if (!league) return err('unknown league', 400);

        const fromQ = url.searchParams.get('from');
        const toQ   = url.searchParams.get('to');
        if (fromQ && toQ) {
          const fromStr = fromQ.replace(/-/g, '');
          const toStr   = toQ.replace(/-/g, '');
          const result = await readPredictionsRange(env, league, fromStr, toStr);
          if (result.tooLarge) {
            return err(`range exceeds ${result.maxDays} days`, 400);
          }
          return json({ ok: true, league, from: fromStr, to: toStr, days: result.days });
        }

        const dateStr = (url.searchParams.get('date') || etYmd()).replace(/-/g, '');
        const blob = await readPredictions(env, league, dateStr);
        return json({ ok: true, ...blob });
      }

      // ── Admin: GET /admin/refresh ──
      // Manually drives the cron pipeline so we can verify it end-to-end
      // without waiting for the next scheduled run. Accepts
      // ?league=nba|wnba (default both) and ?date=YYYYMMDD (default today
      // + tomorrow). Admin-only since it triggers writes to the
      // predictions blobs (still idempotent under lock rules).
      if (parts[0] === 'admin' && parts[1] === 'refresh') {
        const a = await requireAdmin(request, env, CORS);
        if (!a.ok) return a.response;
        const leagueQ = (url.searchParams.get('league') || '').toLowerCase();
        const dateQ   = url.searchParams.get('date');
        if (leagueQ && dateQ) {
          const league = leagueFromPath(leagueQ);
          if (!league) return err('unknown league', 400);
          const blob = await refreshPredictions(env, league, dateQ.replace(/-/g, ''));
          return json({ ok: true, refreshed: [{ league, date: blob.date, games: blob.games.length }] });
        }
        const refreshed = await refreshAllForCron(env);
        return json({ ok: true, refreshed });
      }

      return err('not found', 404);
    } catch (e) {
      return err(e.message || String(e), 502, { stack: (e.stack || '').slice(0, 800) });
    }
  },

  // Cron handler — fires per the `[triggers]` in wrangler.toml (every 10
  // minutes). Refreshes predictions for both leagues, ET-today and
  // ET-tomorrow. ctx.waitUntil keeps the worker alive past the scheduled
  // callback so all KV writes complete.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      refreshAllForCron(env).then(
        (results) => {
          // Cloudflare captures console output in `wrangler tail` and the
          // dashboard's Logs view. Keep the line short for grep-ability.
          console.log('[cron] refresh', JSON.stringify(results));
        },
        (err) => {
          console.error('[cron] refresh failed', err && err.stack || err);
        }
      )
    );
  },
};
