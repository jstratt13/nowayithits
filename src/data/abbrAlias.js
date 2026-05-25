// ─────────────────────────────────────────────────────────────────────────
//  Single source of truth for BBR → ESPN team abbreviation translation.
//
//  BBR uses 3-letter codes (NYK, SAS, GSW). ESPN's scoreboard, injuries,
//  and team endpoints use 2-letter codes for some teams (NY, SA, GS).
//  All downstream lookups in this codebase are keyed by ESPN abbreviations,
//  so we re-key BBR-sourced data through this map before storage.
//
//  Keys that aren't aliased pass through unchanged (e.g. MIN, CHI, BOS,
//  CLE, DAL — same in both leagues' BBR and ESPN systems).
//
//  Imported by:
//    src/data/teamStats.js              (frontend live-stats lookups)
//    worker/src/predictions.js          (worker cron prediction compute)
//    scripts/scrape-rosters.mjs         (Node-side BBR roster scraper)
//
//  Previously each of these had its own local copy. They drifted: the
//  frontend + worker were missing BRK/CHO + the WNBA codes (NYL, LVA,
//  LAS, GSV) that the scraper already had. Result: WNBA Liberty, Aces,
//  Sparks, and Valkyries (plus NBA Nets and Hornets) all silently fell
//  back to SRS = 0 and other defaults because the lookup key never
//  matched. This file ends that.
// ─────────────────────────────────────────────────────────────────────────

export const ABBR_ALIAS = {
  // NBA
  NYK: 'NY',
  SAS: 'SA',
  NOP: 'NO',
  GSW: 'GS',
  UTA: 'UTAH',
  WAS: 'WSH',
  PHO: 'PHX',
  BRK: 'BKN',
  CHO: 'CHA',
  // WNBA — different franchises from their NBA cousins, often different codes
  NYL: 'NY',
  LVA: 'LV',
  LAS: 'LA',
  GSV: 'GS',
  CON: 'CONN',
};

export function resolveAbbr(bbrCode) {
  return ABBR_ALIAS[bbrCode] || bbrCode;
}
