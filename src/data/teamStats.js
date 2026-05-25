// ─────────────────────────────────────────────────────────────────────────
//  Team stats — placeholder values.
//
//  Schema per team:
//    srs    — Simple Rating System (point diff adjusted for SoS)
//    off    — Offensive Rating (pts per 100 possessions)
//    def    — Defensive Rating (pts allowed per 100 possessions)
//    pace   — Possessions per 48
//    toOff  — Offensive turnover %
//    toDef  — Defensive turnover % (forced)
//    orbOff — Offensive rebound %
//    drbDef — Defensive rebound % (i.e. 100 − opp ORB% allowed)
//
//  Until real data is wired in, fill from:
//    SRS / Off / Def        → basketball-reference.com/leagues/NBA_<year>_ratings.html
//    Pace / TO% / ORB% / DRB% → nba.com/stats/teams/advanced
//
//  Values here are approximate / illustrative — replace with scraped numbers.
// ─────────────────────────────────────────────────────────────────────────

export const TEAM_STATS = {
  nba: {
    BOS:  { srs:  7.6, off: 119.0, def: 110.5, pace:  98.0, toOff: 11.5, toDef: 13.5, orbOff: 27.0, drbDef: 78.0 },
    OKC:  { srs:  9.4, off: 118.5, def: 107.0, pace:  99.5, toOff: 11.8, toDef: 15.0, orbOff: 27.5, drbDef: 78.0 },
    DEN:  { srs:  1.9, off: 117.5, def: 113.0, pace:  97.0, toOff: 12.5, toDef: 12.0, orbOff: 25.0, drbDef: 76.0 },
    NY:   { srs:  6.3, off: 117.0, def: 111.0, pace:  97.0, toOff: 12.0, toDef: 13.0, orbOff: 29.0, drbDef: 76.5 },
    MIN:  { srs: -1.9, off: 113.0, def: 113.0, pace:  98.0, toOff: 13.0, toDef: 13.0, orbOff: 26.0, drbDef: 76.0 },
    CLE:  { srs:  1.0, off: 117.0, def: 113.0, pace:  97.5, toOff: 11.5, toDef: 13.0, orbOff: 25.5, drbDef: 77.0 },
    LAL:  { srs: -3.2, off: 115.0, def: 116.0, pace:  99.0, toOff: 13.0, toDef: 12.0, orbOff: 24.5, drbDef: 75.0 },
    PHI:  { srs: -7.6, off: 110.5, def: 117.0, pace:  98.5, toOff: 13.5, toDef: 12.0, orbOff: 23.5, drbDef: 74.0 },
    DET:  { srs:  3.8, off: 116.0, def: 113.0, pace:  99.5, toOff: 12.5, toDef: 13.0, orbOff: 28.0, drbDef: 75.5 },
    SA:   { srs:  5.2, off: 117.5, def: 113.0, pace: 100.0, toOff: 12.0, toDef: 13.5, orbOff: 26.5, drbDef: 76.5 },
    HOU:  { srs:  3.2, off: 115.5, def: 112.0, pace:  99.0, toOff: 12.5, toDef: 14.0, orbOff: 30.5, drbDef: 76.5 },
    ATL:  { srs: -3.7, off: 115.5, def: 117.0, pace:  99.5, toOff: 13.0, toDef: 12.0, orbOff: 25.0, drbDef: 74.5 },
    PHX:  { srs:  9.3, off: 119.0, def: 110.0, pace:  98.0, toOff: 11.0, toDef: 13.5, orbOff: 27.0, drbDef: 77.5 },
    ORL:  { srs: -6.7, off: 112.0, def: 115.5, pace:  96.5, toOff: 13.5, toDef: 14.0, orbOff: 27.5, drbDef: 75.5 },
    TOR:  { srs: -1.0, off: 114.5, def: 114.0, pace:  99.0, toOff: 12.5, toDef: 12.5, orbOff: 26.0, drbDef: 75.5 },
    MIA:  { srs:  0.5, off: 114.5, def: 113.0, pace:  96.0, toOff: 12.0, toDef: 13.5, orbOff: 24.5, drbDef: 76.5 },
    MIL:  { srs:  4.0, off: 117.5, def: 113.0, pace:  98.0, toOff: 12.0, toDef: 12.5, orbOff: 25.0, drbDef: 76.5 },
    GS:   { srs:  2.1, off: 117.0, def: 113.5, pace:  99.0, toOff: 13.0, toDef: 13.0, orbOff: 25.0, drbDef: 75.5 },
    LAC:  { srs:  0.0, off: 115.0, def: 114.0, pace:  97.0, toOff: 12.0, toDef: 12.5, orbOff: 24.5, drbDef: 76.0 },
    MEM:  { srs:  1.5, off: 115.5, def: 113.0, pace: 100.5, toOff: 13.0, toDef: 14.5, orbOff: 27.0, drbDef: 75.5 },
    IND:  { srs:  2.2, off: 119.0, def: 116.0, pace: 101.5, toOff: 12.5, toDef: 13.0, orbOff: 24.5, drbDef: 75.0 },
    CHI:  { srs: -2.5, off: 113.5, def: 115.0, pace:  98.5, toOff: 12.0, toDef: 12.5, orbOff: 25.5, drbDef: 75.0 },
    BKN:  { srs: -4.0, off: 111.5, def: 115.0, pace:  97.5, toOff: 12.5, toDef: 12.5, orbOff: 24.5, drbDef: 75.0 },
    WSH:  { srs: -8.0, off: 110.5, def: 117.5, pace:  99.0, toOff: 13.0, toDef: 12.0, orbOff: 24.0, drbDef: 74.0 },
    POR:  { srs: -8.6, off: 109.5, def: 117.0, pace:  98.0, toOff: 13.5, toDef: 13.0, orbOff: 26.0, drbDef: 74.5 },
    UTAH: { srs: -6.5, off: 112.5, def: 118.0, pace: 100.0, toOff: 13.0, toDef: 13.0, orbOff: 26.5, drbDef: 74.0 },
    SAC:  { srs: -1.2, off: 115.0, def: 115.5, pace:  98.0, toOff: 11.5, toDef: 12.0, orbOff: 24.5, drbDef: 75.5 },
    NO:   { srs: -3.0, off: 113.5, def: 115.0, pace:  98.0, toOff: 13.0, toDef: 14.0, orbOff: 26.5, drbDef: 75.0 },
    CHA:  { srs: -7.5, off: 110.5, def: 117.0, pace:  98.0, toOff: 13.5, toDef: 12.5, orbOff: 25.0, drbDef: 73.5 },
    DAL:  { srs:  0.8, off: 116.5, def: 114.5, pace:  97.0, toOff: 11.5, toDef: 12.0, orbOff: 25.5, drbDef: 77.0 },
  },
  wnba: {
    MIN:  { srs:  8.5, off: 105.0, def:  96.5, pace:  80.0, toOff: 14.0, toDef: 17.0, orbOff: 24.0, drbDef: 76.5 },
    NY:   { srs:  6.5, off: 103.5, def:  97.0, pace:  80.5, toOff: 13.5, toDef: 16.5, orbOff: 23.5, drbDef: 76.0 },
    LV:   { srs:  4.0, off: 104.0, def: 100.0, pace:  80.5, toOff: 14.0, toDef: 16.0, orbOff: 22.5, drbDef: 75.5 },
    CONN: { srs:  0.5, off:  99.5, def:  99.0, pace:  79.0, toOff: 14.5, toDef: 15.5, orbOff: 24.0, drbDef: 75.0 },
    IND:  { srs:  3.0, off: 102.5, def:  99.5, pace:  82.0, toOff: 14.5, toDef: 16.0, orbOff: 23.5, drbDef: 75.5 },
    PHX:  { srs:  4.2, off: 102.5, def:  98.5, pace:  80.0, toOff: 14.0, toDef: 16.5, orbOff: 23.0, drbDef: 75.0 },
    SEA:  { srs:  1.0, off: 100.5, def:  99.5, pace:  79.5, toOff: 14.5, toDef: 15.5, orbOff: 23.0, drbDef: 75.0 },
    ATL:  { srs: -1.5, off:  98.5, def: 100.0, pace:  80.0, toOff: 14.5, toDef: 15.5, orbOff: 24.0, drbDef: 74.5 },
    CHI:  { srs: -4.5, off:  95.5, def: 100.0, pace:  79.5, toOff: 15.0, toDef: 15.0, orbOff: 25.5, drbDef: 74.0 },
    LA:   { srs: -3.0, off:  97.0, def: 100.0, pace:  80.5, toOff: 15.0, toDef: 14.5, orbOff: 24.0, drbDef: 74.5 },
    DAL:  { srs: -2.5, off:  97.5, def: 100.0, pace:  80.0, toOff: 15.0, toDef: 15.0, orbOff: 24.5, drbDef: 74.0 },
    WSH:  { srs: -3.5, off:  96.5, def: 100.0, pace:  79.5, toOff: 15.0, toDef: 14.5, orbOff: 23.5, drbDef: 74.5 },
    GS:   { srs: -2.0, off:  97.5, def:  99.5, pace:  80.0, toOff: 14.5, toDef: 15.5, orbOff: 23.5, drbDef: 75.0 },
  },
};

// Canonical BBR → ESPN abbreviation map. Re-exported here for back-compat
// with existing frontend callers (e.g. liveStats.js); single source of
// truth lives in abbrAlias.js so the worker + scraper share the same map.
export { ABBR_ALIAS } from './abbrAlias.js';
