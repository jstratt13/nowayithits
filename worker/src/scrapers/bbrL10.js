// ─────────────────────────────────────────────────────────────────────────
//  L10 lookup (bundled, no runtime BBR fetch).
//
//  Mirrors the roster pattern. The scrape itself lives in
//  scripts/scrape-l10.mjs and runs as a daily GitHub Actions job
//  (refresh-l10.yml) at 10:00 UTC. The output is committed to
//  src/data/l10Cache.json and read from here at worker request time.
//
//  Why this exists: 30 per-team BBR fetches per worker cron tick blows
//  past BBR's rate limit (same reason rosters moved off-Worker). The GH
//  runner path gets exact per-game ORtg/DRtg/Pace from BBR's
//  advanced-gamelog pages (no approximation).
//
//  Fallback: if a team isn't in the cache for any reason (first-run
//  before the workflow completes, parser gap, team added mid-season),
//  bbref.js keeps its monthly-game-log approximation as a fallback.
// ─────────────────────────────────────────────────────────────────────────

import l10Data from '../../../src/data/l10Cache.json';

// Returns { offRtg, defRtg, pace, tovPct, oppTovPct, orbPct, oppOrbPct,
// threePAr, gameCount, lastGameNum } for a given league + BBR team abbr,
// or null if not in the cache.
export function getL10(league, bbrAbbr) {
  return l10Data?.[league]?.[bbrAbbr] || null;
}

export function getL10Meta() {
  return {
    source: l10Data?.source || null,
    fetchedAt: l10Data?.fetchedAt || null,
  };
}
