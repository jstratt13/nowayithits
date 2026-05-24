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
import {
  refreshPredictions,
  readPredictions,
  readPredictionsRange,
  refreshAllForCron,
  etYmd,
} from './predictions.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
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

      // Diagnostic v2: probe the structure of the advanced-team table.
      if (parts[0] === 'debug' && parts[1] === 'parse' && parts[2]) {
        const l = leagueFromPath(parts[2]);
        if (!l) return err('unknown league', 400);
        const year = l === 'nba' ? 2026 : 2026;
        const url = l === 'nba'
          ? `https://www.basketball-reference.com/leagues/NBA_${year}.html`
          : `https://www.basketball-reference.com/wnba/years/${year}.html`;
        const res = await fetch(url, {
          headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html' },
        });
        let html = await res.text();
        html = html.replace(/<!--/g, '').replace(/-->/g, '');

        // Try each candidate table id and report length + first 800 chars
        const findings = {};
        for (const id of ['advanced-team', 'advanced_stats', 'advanced', 'team-stats-misc', 'misc_stats', 'misc', 'per_game-team', 'team-stats-per_game']) {
          const m = html.match(new RegExp(`<table[^>]*id="${id}"[\\s\\S]*?</table>`));
          findings[id] = m ? { found: true, length: m[0].length, head: m[0].slice(0, 600) } : { found: false };
        }
        // Also extract all table ids
        const allIds = [...html.matchAll(/<table[^>]*id="([^"]+)"/g)].map(x => x[1]);
        return json({ ok: true, url, allTableIds: allIds.slice(0, 50), totalTables: allIds.length, findings });
      }

      // Diagnostic: see what BBR actually returns to the worker.
      if (parts[0] === 'debug' && parts[1] === 'bbref' && parts[2]) {
        const l = leagueFromPath(parts[2]);
        if (!l) return err('unknown league', 400);
        const year = (() => {
          const d = new Date();
          return l === 'nba'
            ? (d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() + 1 : d.getUTCFullYear())
            : d.getUTCFullYear();
        })();
        const url = l === 'nba'
          ? `https://www.basketball-reference.com/leagues/NBA_${year}.html`
          : `https://www.basketball-reference.com/wnba/years/${year}.html`;
        const res = await fetch(url, {
          headers: {
            'user-agent': env.USER_AGENT,
            'accept': 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        });
        const text = await res.text();
        return json({
          ok: true,
          url,
          status: res.status,
          contentType: res.headers.get('content-type'),
          length: text.length,
          excerpt: text.slice(0, 1200),
          hasAdvancedTable: /id="advanced-team"|id="advanced_stats"/.test(text),
          hasMiscTable:     /id="team-stats-misc"|id="misc_stats"/.test(text),
          firstTableId:     (text.match(/<table[^>]*id="([^"]+)"/) || [])[1] || null,
        });
      }

      if (parts[0] === 'debug' && parts[1] === 'recentform') {
        const { scrapeRecentFormORtg } = await import('./scrapers/bbref.js');
        const result = await scrapeRecentFormORtg('nba', 2026, env);
        const keys = Object.keys(result);
        const sample = Object.fromEntries(Object.entries(result).slice(0, 5));
        return json({ teams: keys.length, sample });
      }

      if (parts[0] === 'debug' && parts[1] === 'fullscrape') {
        // Run scrapeTeamStats inline and return its result so we can verify
        // offLast10 is being populated correctly end-to-end.
        const { scrapeTeamStats } = await import('./scrapers/bbref.js');
        const result = await scrapeTeamStats('nba', env);
        const t = result.teams || {};
        const sample = {};
        for (const k of ['OKC','SAS','NYK','BOS']) {
          if (t[k]) sample[k] = { off: t[k].off, offLast10: t[k].offLast10 };
        }
        return json({ total: Object.keys(t).length, sample });
      }

      if (parts[0] === 'debug' && parts[1] === 'l10direct') {
        // Call the internal playoff ORtg scraper directly and surface its output
        const { scrapeTeamStats } = await import('./scrapers/bbref.js');
        // Import the internal function by re-building the URL + table parse inline
        const pRes = await fetch('https://www.basketball-reference.com/playoffs/NBA_2026.html', {
          headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html' },
        });
        let pHtml = await pRes.text();
        pHtml = pHtml.replace(/<!--/g, '').replace(/-->/g, '');
        const tableM = pHtml.match(/<table[^>]*id="advanced-team"[\s\S]*?<\/table>/);
        if (!tableM) return json({ error: 'no table' });
        const tbody = tableM[0].match(/<tbody[\s\S]*?<\/tbody>/);
        if (!tbody) return json({ error: 'no tbody' });
        const rows = tbody[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
        const results = {};
        for (const row of rows) {
          const hrefM = row.match(/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//);
          if (!hrefM) continue;
          const abbr = hrefM[1];
          const offM = row.match(/data-stat="off_rtg"[^>]*>([^<]*)</);
          results[abbr] = offM ? offM[1].trim() : 'MISSING';
        }
        return json({ rowsFound: rows.length, teams: Object.keys(results).length, sample: Object.entries(results).slice(0,5) });
      }

      if (parts[0] === 'debug' && parts[1] === 'l10') {
        const res2 = await fetch('https://www.basketball-reference.com/playoffs/NBA_2026.html', {
          headers: { 'user-agent': env.USER_AGENT, 'accept': 'text/html' },
        });
        let html = await res2.text();
        html = html.replace(/<!--/g, '').replace(/-->/g, '');

        // Find the advanced-team table and extract first data row
        const tblM = html.match(/<table[^>]*id="advanced-team"[\s\S]*?<\/table>/);
        if (!tblM) return json({ error: 'No advanced-team table found', status: res2.status });
        const tbl = tblM[0];
        const rows = tbl.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
        // Find first data row (has a team href)
        let sampleRow = null;
        for (const r of rows) {
          if (/href=['"]\/(?:wnba\/)?teams\/([A-Z]{2,5})\//.test(r)) { sampleRow = r; break; }
        }
        // Extract all data-stat values from that row
        const cells = {};
        const cellRegex = /<(?:td|th)\b[^>]*\bdata-stat="([^"]+)"[^>]*>([\s\S]*?)<\/(?:td|th)>/g;
        let cm;
        while (sampleRow && (cm = cellRegex.exec(sampleRow)) !== null) {
          const val = cm[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
          if (val) cells[cm[1]] = val;
        }
        return json({ rowCount: rows.length, sampleCells: cells });
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

      // POST/GET /admin/refresh — manually drives the cron pipeline so we
      // can verify it end-to-end without waiting for the next scheduled
      // run. Accepts ?league=nba|wnba (default both) and ?date=YYYYMMDD
      // (default today + tomorrow). No auth — the worker is open and the
      // operation is idempotent (KV writes are bounded by lock rules).
      if (parts[0] === 'admin' && parts[1] === 'refresh') {
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
