// ─────────────────────────────────────────────────────────────────────────
//  Roster lookup (bundled, no runtime BBR fetch).
//
//  The scrape itself now lives in scripts/scrape-rosters.mjs and runs as
//  a GitHub Actions job on a daily cron. The output is committed to
//  src/data/rosters.json. This module just reads that bundled JSON.
//
//  Why this exists instead of live scraping: Cloudflare worker egress IPs
//  get rate-limited hard by BBR (shared IP pool with millions of other
//  workers, no good reputation). Moving the scrape off-Worker eliminates
//  the entire 429 failure mode and makes refresh cadence loud + auditable
//  via git diff on rosters.json.
//
//  Refresh path:
//    .github/workflows/refresh-rosters.yml   →  daily cron + manual button
//      runs node scripts/scrape-rosters.mjs   (from a GH-hosted runner)
//        fetches BBR per-game + advanced pages, validates, writes JSON
//      commits + pushes if anything changed   →  triggers redeploy
//
//  If the workflow fails (BBR down, parser broken, etc.) the file stays
//  untouched and the worker keeps serving the last-known-good snapshot.
// ─────────────────────────────────────────────────────────────────────────

import rostersData from '../../../src/data/rosters.json';

export function getRosters(league) {
  return rostersData[league] || {
    source: null,
    season: null,
    fetchedAt: null,
    teams: {},
  };
}

// Returns a Map<slug, { name, mpg, bpm, per }> for one team. Step B's
// per-player Δ_Star weighting joins ESPN injury names against this map.
export function getTeamPlayers(league, espnAbbr) {
  const team = rostersData[league]?.teams?.[espnAbbr];
  if (!team) return new Map();
  return new Map(team.players.map((p) => [p.slug, p]));
}
