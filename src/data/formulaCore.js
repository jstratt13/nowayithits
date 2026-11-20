// ─────────────────────────────────────────────────────────────────────────
//  Blowy 5.2 — Prediction formulas (PURE)
//
//  This module is environment-agnostic: no browser globals, no module-level
//  state, no imports from frontend-only code. Lookups for team stats and
//  injury scores are passed in via a `ctx` object so the same math runs
//  identically in:
//
//    - the browser   (ctx wired to src/data/liveStats.js via formula.js)
//    - the worker    (ctx wired to scraped JSON in worker/src/...)
//
//  Shared shape across both leagues:
//      Base_ANG    = (SRS_Fav − SRS_Und) + HCA_Dynamic + Δ_Star
//      Δ_Vol       = (Matchup_TOG × 1.4) + (Matchup_ORG × 0.5)
//      True_Gap    = Base_ANG + Δ_Vol
//      Z           = intercept + multiplier × True_Gap
//      DBP%        = sigmoid(Z) × 100
//
//      Total       = (Projected_Possessions × Combined_Off_Rating) / 100
//
//  League-specific values live in MODEL_CONFIG below.
//
//  ctx shape:
//    {
//      getTeamStats:   (league, abbr)    => stats | null
//      getInjuryScore: (league, teamId)  => number   // 0 if unknown
//    }
//
//  Injury scores are keyed by ESPN's numeric team id (not abbreviation),
//  because the upstream injuries endpoint doesn't ship team abbreviations.
//  Use `computeInjuryScore(players)` below to convert a raw ESPN player
//  list into the per-team score the formula expects.
// ─────────────────────────────────────────────────────────────────────────

// ── Per-league configuration ───────────────────────────────────────────

const MODEL_CONFIG = {
  nba: {
    intercept: -2.095,
    multiplier: 0.185,
    starCap: { min: -5.0, max: 5.5 },
    hca: {
      // Re-anchored 11/5/26 to the empirical "neither B2B" home margin
      // across 2 full seasons: +2.03 (2024-25) and +2.21 (2025-26) → ~2.1.
      // Previously 3.50 (stale — NBA HCA has shrunk steadily over the
      // last decade). The highTier / lowPace tiers remain their original
      // relative values; they don't fire yet (no arena classifier).
      standard: 2.10,
      highTier: 2.60,
      lowPace:  1.30,
    },
    paceDeflate:     3.5,  // NBA playoff half-court tightening (gated to Apr–Jun)
    paceDefault:     100,
    // All defaults below are re-anchored to live BBR 2026-27 league
    // averages (sampled 11/5/26 after the <tbody> scraper fix). Defaults
    // serve two purposes: (1) shrinkage anchor — early-season team ratings
    // are pulled toward this value via (gp/15)², so a bad anchor pulls
    // teams toward the wrong "center"; (2) fallback when BBR is missing
    // a team. ORtg and DRtg must be identical league-wide by definition
    // (what one team scores, another allows); the small gap in the live
    // scrape is just per-team rounding noise.
    //
    // Live NBA 2026-27 averages for reference:
    //   ORtg 113.24 · DRtg 113.38 · TO% 13.81 · ORB% 27.36 · DRB% 72.51
    //   oppTO% 13.78 · Pace 99.47 · 3PAr 0.429
    offRtgDefault:  113,
    defRtgDefault:  113,
    leagueAvgDRB:   72.5,   // team DRB% league-wide (shrinkage anchor only)
    leagueAvg3PAr:  0.42,   // team FG3A / FGA (3-point attempt rate) league-wide
    // TO differential's league average = 0 by definition (every TO forced
    // equals a TO committed by someone else), so no config constant.
    blowoutMargin:   16,
    // MPF disabled for NBA (Volume Delta passes through Δ_Vol × 1.0).
    paceMpfBaseline: null,
    zones: [
      { threshold: 25, label: 'Safe Zone',  key: 'safe',  badge: 'badge-zone-safe'  },
      { threshold: 45, label: 'Baseline',   key: 'base',  badge: 'badge-zone-base'  },
      { threshold: 55, label: 'High Alert', key: 'alert', badge: 'badge-zone-alert' },
      { threshold: 70, label: 'Lock',       key: 'lock',  badge: 'badge-zone-lock'  },
      { threshold: Infinity, label: 'Super Lock', key: 'super', badge: 'badge-zone-super' },
    ],
  },
  wnba: {
    intercept: -1.6,
    multiplier: 0.16,
    starCap: { min: -8.0, max: 8.0 },
    hca: {
      // Arena-tier classification by home/road net rating split.
      // TODO: classify each home team into one of these via the worker
      // scraper. Until then everyone uses standard.
      elite:     4.50,  // top-tier home court (+4 to +5; midpoint)
      flatline:  2.45,
      hardFloor: 2.00,
      standard:  3.00,  // fallback when tier hasn't been determined
    },
    paceDeflate:     0,    // no penalty — currently regular season
    paceDefault:     80,
    // Re-anchored to live BBR WNBA 2026 completed-season averages (sampled
    // 11/5/26). Previous defaults (100 / 100 / 14.5 / 26.0) were a
    // historical placeholder from before BBR's WNBA scrape was wired up;
    // actual league averages diverge meaningfully, especially ORtg/DRtg.
    //
    // Live WNBA 2026 averages for reference:
    //   ORtg 109.13 · DRtg 109.09 · TO% 14.39 · ORB% 25.45 · DRB% 74.55
    //   Pace 79.31 · 3PAr 0.372
    offRtgDefault:  109,
    defRtgDefault:  109,
    leagueAvgDRB:   74.5,
    leagueAvg3PAr:  0.37,
    blowoutMargin:   14,
    // Matchup Pace Factor (MPF): scales Volume Delta in True Gap so games
    // with low possession counts give less weight to TOV/ORB advantages.
    // MPF = (home_pace + away_pace) / mpfBaseline. For WNBA-typical pace
    // ~80, MPF ≈ 0.83 → Δ_Vol contribution is dampened by ~17%.
    // NBA leaves this off (paceMpfBaseline: null) for now.
    paceMpfBaseline: 192,  // 2 × 96.0 baseline possessions/game
    zones: [
      { threshold: 25, label: 'Safe Zone',  key: 'safe',  badge: 'badge-zone-safe'  },
      { threshold: 45, label: 'Baseline',   key: 'base',  badge: 'badge-zone-base'  },
      { threshold: 55, label: 'High Alert', key: 'alert', badge: 'badge-zone-alert' },
      { threshold: 70, label: 'Lock',       key: 'lock',  badge: 'badge-zone-lock'  },
      { threshold: Infinity, label: 'Super Lock', key: 'super', badge: 'badge-zone-super' },
    ],
  },
};

const cfg = (league) => MODEL_CONFIG[league] || MODEL_CONFIG.nba;

// ── Injury status weights (Δ_Star) ─────────────────────────────────────
//
// Per the model handoff: Out 1.0, Doubtful 0.75, Questionable/GTD/Day-To-Day
// 0.4, Probable 0.1. A team's injury_score is the sum of weights across all
// listed injured players. Then:
//
//   IAF        = 1 + (und_score − fav_score) × 0.05
//   Δ_Star_raw = (IAF − 1) × 20
//   Δ_Star     = clamp(Δ_Star_raw, league.starCap)
//
// Status strings are normalized (lowercased, trimmed) so ESPN's variants
// ("Day-To-Day", "Day-to-Day", "GTD", "Game Time Decision", etc.) all map
// to the same bucket. Unknown statuses contribute 0.

const INJURY_STATUS_WEIGHTS = {
  out:                    1.0,
  suspended:              1.0,
  doubtful:               0.75,
  questionable:           0.4,
  'day-to-day':           0.4,
  'day to day':           0.4,
  gtd:                    0.4,
  'game time decision':   0.4,
  probable:               0.1,
};

// ── Per-player impact weighting (Step B) ───────────────────────────────
//
// A player's contribution to the team injury score is:
//   player_weight = status_weight × impactFactor(rosterEntry)
//
// Multiplicative form: minutes act as the dominant filter, and advanced
// metrics (BPM for NBA, PER fallback for WNBA) differentiate within that.
// A player who doesn't play can't matter no matter how good per-minute,
// because the team isn't using them.
//
//   mpg_factor      = min(mpg / 36, 1.0)            # full at 36+ mpg
//   bpm_trust       = min(mpg / 18, 1.0)            # BPM reliable at 18+ mpg
//   bpm_multiplier  = 1 + max(0, BPM − (−2)) / 2.8 × bpm_trust
//   impact          = mpg_factor × bpm_multiplier
//
//   (WNBA fallback: per_multiplier = 1 + max(0, PER − 12) / 5 × per_trust)
//
// Tuning rationale:
//   - REPLACEMENT_BPM = −2 (BPM at which a player is "replaceable")
//   - BPM_SCALE = 2.8 → top stars (BPM 9.3, e.g. Luka) land at ~5,
//     matching the model spec target of "few points but not more than 6"
//   - bpm_trust factor stops a 6-mpg-with-hot-BPM player from inflating
//     (BPM is statistically noisy for small samples)
//   - MPG_FLOOR (added 6/3/26) anchors the mpgFactor at 4 mpg rather
//     than 0. A player who only sees garbage time shouldn't move the
//     team's injury score when they sit — their absence doesn't change
//     the rotation. Above 4 mpg the factor climbs linearly to 1.0 at
//     MPG_FULL=36. Stars are barely affected (~−4%); deep bench drops
//     from 0.11 to 0; sub-rotation players drop ~60%.
//   - Per-league Δ_Star caps (NBA ±5/+5.5, WNBA ±8) still bound the
//     extreme top end if a team has multiple stars OUT
//
// Calibrated impact magnitudes (post MPG_FLOOR change):
//   Luka  (35.8 mpg / 9.3 BPM)     →  4.99   (was 5.01)
//   LeBron (33.2 / 3.5)            →  2.64   (was 2.73)
//   Avg starter (28 / 1.0)         →  1.55   (was 1.61)
//   12-mpg bench (12 / 0)          →  0.43   (was 0.57)
//   DJ Garcia rookie (6.2 / 6.4)   →  0.14   (was 0.35) — garbage time fix
//   Deep bench (4 / −2)            →  0      (was 0.11)
//   A'ja Wilson (28.8 / PER 32.5)  →  3.92   (was 4.08)
//
// Unmatched names fall back to impact = 0 (11/6/26). Rationale: the
// team's season-to-date ORtg/DRtg already reflects play WITHOUT the
// unmatched player — they haven't been on the court while we've been
// collecting efficiency numbers. Penalizing their absence further would
// double-count what the efficiency numbers already encode. This applies
// to stars who've been out all season, benchwarmers, new signings, and
// players whose name didn't survive BBR↔ESPN matching. If a player has
// actually played for this team and shown up in the efficiency sample,
// they'll be in the BBR roster with positive mpg and get a real impact.

const MPG_FULL = 36;
// Below this many minutes per game, a player is essentially garbage-
// time only — their absence doesn't materially change the rotation.
// mpgFactor goes to zero at MPG_FLOOR and climbs linearly from there.
const MPG_FLOOR = 4;

// NBA — BPM as advanced metric
const BPM_REPLACEMENT  = -2;
const BPM_SCALE        = 2.8;
const BPM_TRUST_MIN    = 18;

// WNBA — PER as advanced metric (BBR doesn't compute BPM for WNBA)
const PER_BASE         = 12;
const PER_SCALE        = 5;
const PER_TRUST_MIN    = 12;

const NAME_MATCH_THRESHOLD = 0.75;

function impactFactor(rosterEntry) {
  if (!rosterEntry) return 0; // unmatched or no roster data → zero (see comment above)
  const mpg = rosterEntry.mpg ?? 0;
  // Anchored at MPG_FLOOR: a 4-mpg player contributes 0, a 36-mpg
  // player contributes 1.0, linear in between. See the calibration
  // table in the comment block above.
  const mpgFactor = Math.max(
    0,
    Math.min((mpg - MPG_FLOOR) / (MPG_FULL - MPG_FLOOR), 1.0)
  );

  let advMultiplier = 1.0;
  if (rosterEntry.bpm != null) {
    const trust = Math.min(mpg / BPM_TRUST_MIN, 1.0);
    const above = Math.max(0, rosterEntry.bpm - BPM_REPLACEMENT);
    advMultiplier = 1 + (above / BPM_SCALE) * trust;
  } else if (rosterEntry.per != null) {
    const trust = Math.min(mpg / PER_TRUST_MIN, 1.0);
    const above = Math.max(0, rosterEntry.per - PER_BASE);
    advMultiplier = 1 + (above / PER_SCALE) * trust;
  }

  return mpgFactor * advMultiplier;
}

// Name normalization for matching ESPN injury entries against BBR rosters.
// Lowercases, strips accents (NFD decomposition + drop combining marks),
// strips punctuation, collapses whitespace. So "Luka Dončić" (BBR) and
// "Luka Doncic" (ESPN, no accent) both become "luka doncic".
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic two-row dynamic programming Levenshtein. Fast for short strings
// like player names (~15 chars × ~15 chars = trivial).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function levenshteinSim(a, b) {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - levenshtein(a, b) / longer;
}

// Look up an injured player's roster entry by normalized name. Tries exact
// match first; on miss, walks the team's roster for the best fuzzy match
// at or above NAME_MATCH_THRESHOLD. Returns null if no match — caller's
// impactFactor(null) returns 1.0 (status-only fallback) so we never zero
// out an injury just because the name didn't line up.
function findRosterEntry(injuredName, rosterByNormName) {
  if (!rosterByNormName || !rosterByNormName.size) return null;
  const target = normalizeName(injuredName);
  if (!target) return null;
  const exact = rosterByNormName.get(target);
  if (exact) return exact;

  let best = null;
  let bestSim = 0;
  for (const [name, entry] of rosterByNormName) {
    const sim = levenshteinSim(target, name);
    if (sim >= NAME_MATCH_THRESHOLD && sim > bestSim) {
      bestSim = sim;
      best = entry;
    }
  }
  return best;
}

// computeInjuryScoreDetailed: sum of (status_weight × player_impact) across
// the team's injury list, PLUS the per-player rows that produced it. The
// rows are what the tap-to-expand breakdown surfaces; the score is what
// formula consumers (Δ_Star, totals injury impact) use. Single loop, single
// source of truth — if the rows say "LeBron contributed 2.73" the team
// score will also have 2.73 baked in.
//
// rosterByNormName is optional. When provided, contribution is player-
// weighted via impactFactor(rosterEntry). When not (no roster data at
// all), impact = 0 — see the comment above impactFactor() for the
// rationale: the team's efficiency stats already reflect play without
// these players.
//
// Rows are returned sorted by contribution desc so the UI shows the
// heaviest-hitting absences first.
// opts.league === 'nba'  → v2 valuation (nbaInjuryValue below), score in
//                          POINTS PER 100 POSSESSIONS, plus offScore/defScore.
// anything else (WNBA)    → legacy impactFactor scoring (no BPM to rebuild on).
export function computeInjuryScoreDetailed(players, rosterByNormName, opts = {}) {
  if (opts.league === 'nba') return computeInjuryScoreV2(players, rosterByNormName, opts.availability);
  if (!Array.isArray(players)) return { score: 0, rows: [], model: 'legacy' };
  let score = 0;
  const rows = [];
  for (const p of players) {
    const key = String(p?.status || '').toLowerCase().trim();
    const statusWeight = INJURY_STATUS_WEIGHTS[key] || 0;
    if (statusWeight === 0) continue;
    const entry = rosterByNormName ? findRosterEntry(p?.player, rosterByNormName) : null;
    const impact = rosterByNormName ? impactFactor(entry) : 0;
    const contribution = statusWeight * impact;
    score += contribution;
    rows.push({
      player: p?.player || '',
      status: p?.status || '',
      statusWeight,
      mpg: entry?.mpg ?? null,
      bpm: entry?.bpm ?? null,
      per: entry?.per ?? null,
      impact,
      contribution,
    });
  }
  rows.sort((a, b) => b.contribution - a.contribution);
  return { score, rows, model: 'legacy' };
}

// ── NBA injury value v2 (rebuilt + backtested 11/19/26) ─────────────────
//
// Backtest: 3,216 games (2023-24..2025-26), point-in-time, fit on two
// seasons / tested on the third. Replaced the hand-picked Δ_Star (IAF ×0.05
// ×20, BPM_SCALE 2.8, 1.0 floor, ±5 NET cap) which (a) let below-replacement
// players cancel stars, (b) under-scaled stars, (c) capped the NET so
// stacked/star injuries got crushed, (d) double-counted long absences.
//
//   value (pts per 100 poss) = SCALE × max(0, BPM − REPLACEMENT)
//                              × (mpg / 48) × share,  capped at PLAYER_CAP
//   share = ½ × (games played / team games) + ½ × (played in last 10 / 10)
//           → how much of him is still baked into the team's ratings.
//   Spread:  Δ_Star = (und score − fav score) × game possessions / 100. No net cap.
//   Totals:  same values split OBPM / DBPM — losing offense lowers his
//            team's expected points, losing defense raises the opponent's.
//
// Results vs the old formula (held-out RMSE): all games 14.433 → 14.387,
// games where a star sat 14.486 → 14.252, totals 19.074 → 18.896 (the old
// totals rule was worse than ignoring injuries). ATS unchanged (books
// already price injuries — ATS gains must come from team strength).
// Tested and rejected: on/off net rating (14.479, too noisy), blends, any
// cap on the net or a team total, cutoffs 0/12/15/21 (18 locked by Jordan).
export const INJURY_V2 = {
  MIN_MPG:          18,    // LOCKED 11/19/26 — below 18 mpg no measurable margin effect
  REPLACEMENT_BPM:  -3,    // flat optimum −3..−6 (trades off with SCALE)
  SCALE:            0.58,  // fitted 0.55–0.60 on every held-out season
  PLAYER_CAP:       5.0,   // per player, pts per 100 poss — beat no cap & every net cap
  OFF_REPLACEMENT:  -1.5,  // totals split (OBPM side)
  DEF_REPLACEMENT:  -1.5,  // totals split (DBPM side)
  NO_PRIOR_BPM:     -1,    // players w/o a usable prior season (fit vs −2 / replacement)
  PRIOR_MIN_MP:     250,   // total minutes over the prior seasons (3-season, minutes-weighted) needed for the prior to count
  // UNVALIDATED (backtest only had last season's BPM): regress this season's
  // BPM toward last season's — this season reaches 50% weight at 20 games.
  PRIOR_GAMES:      20,
};

function regressBpm(cur, prior, gp) {
  if (cur == null) return prior;
  const g = Math.max(0, gp || 0);
  const K = INJURY_V2.PRIOR_GAMES;
  return (prior * K + cur * g) / (K + g);
}

// Share of the player that is still IN the team's (season + L10) ratings.
// Without the ESPN availability feed for his team, both halves use the
// season share. If his name isn't in the feed, the L10 half falls back to
// the season share rather than treating him as absent.
function availabilityShare(entry, avail) {
  const tg = avail?.teamGames;
  const seasonShare = entry.g != null && tg > 0 ? Math.min(1, entry.g / tg) : 1;
  if (!avail || !avail.window) return seasonShare;
  const n = avail.played?.[normalizeName(entry.name)];
  const l10Share = n != null ? Math.min(1, n / avail.window) : seasonShare;
  return 0.5 * seasonShare + 0.5 * l10Share;
}

export function nbaInjuryValue(entry, avail) {
  const zero = { value: 0, off: 0, def: 0, bpm: entry?.bpm ?? null, share: null, capped: false, belowMin: false };
  if (!entry) return zero;
  const mpg = entry.mpg ?? 0;
  if (mpg < INJURY_V2.MIN_MPG) return { ...zero, belowMin: true };
  const priorOk = entry.priorMp != null && entry.priorMp >= INJURY_V2.PRIOR_MIN_MP;
  const pB = priorOk && entry.priorBpm  != null ? entry.priorBpm  : INJURY_V2.NO_PRIOR_BPM;
  const pO = priorOk && entry.priorObpm != null ? entry.priorObpm : INJURY_V2.NO_PRIOR_BPM / 2;
  const pD = priorOk && entry.priorDbpm != null ? entry.priorDbpm : INJURY_V2.NO_PRIOR_BPM / 2;
  const bpm  = regressBpm(entry.bpm,  pB, entry.g);
  const obpm = regressBpm(entry.obpm, pO, entry.g);
  const dbpm = regressBpm(entry.dbpm, pD, entry.g);
  const share = availabilityShare(entry, avail);
  const k = INJURY_V2.SCALE * (mpg / 48) * share;
  const raw = k * Math.max(0, bpm - INJURY_V2.REPLACEMENT_BPM);
  const value = Math.min(INJURY_V2.PLAYER_CAP, raw);
  let off = k * Math.max(0, obpm - INJURY_V2.OFF_REPLACEMENT);
  let def = k * Math.max(0, dbpm - INJURY_V2.DEF_REPLACEMENT);
  const od = off + def;
  if (od > INJURY_V2.PLAYER_CAP) { off *= INJURY_V2.PLAYER_CAP / od; def *= INJURY_V2.PLAYER_CAP / od; }
  return { value, off, def, bpm, share, capped: raw > INJURY_V2.PLAYER_CAP, belowMin: false };
}

function computeInjuryScoreV2(players, rosterByNormName, avail) {
  if (!Array.isArray(players)) return { score: 0, offScore: 0, defScore: 0, rows: [], model: 'v2' };
  let score = 0, offScore = 0, defScore = 0;
  const rows = [];
  for (const p of players) {
    const key = String(p?.status || '').toLowerCase().trim();
    const statusWeight = INJURY_STATUS_WEIGHTS[key] || 0;
    if (statusWeight === 0) continue;
    const entry = rosterByNormName ? findRosterEntry(p?.player, rosterByNormName) : null;
    const v = nbaInjuryValue(entry, avail);
    const contribution = statusWeight * v.value;
    score += contribution;
    offScore += statusWeight * v.off;
    defScore += statusWeight * v.def;
    rows.push({
      player: p?.player || '',
      status: p?.status || '',
      statusWeight,
      mpg: entry?.mpg ?? null,
      bpm: v.bpm,                 // BPM actually used (this season regressed to last)
      bpmSeason: entry?.bpm ?? null,
      per: entry?.per ?? null,
      share: v.share,
      capped: v.capped,
      belowMin: v.belowMin,
      impact: v.value,            // pts per 100 poss if fully out
      contribution,               // × status weight
    });
  }
  rows.sort((a, b) => b.contribution - a.contribution);
  return { score, offScore, defScore, rows, model: 'v2' };
}

// ── Team stats accessor (resolved via ctx) ─────────────────────────────

function stats(ctx, league, abbr) {
  return (ctx && ctx.getTeamStats && ctx.getTeamStats(league, abbr)) || {};
}

const get = (s, k, fallback) => (s && s[k] != null ? s[k] : fallback);

// ── Sigmoid + zone classification ───────────────────────────────────────

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// getZone is league-aware. Both leagues currently share the same thresholds
// (Safe <25, Baseline 25-45, High Alert 45-55, Lock 55-70, Super Lock >70);
// `league` is still a parameter so the per-league zones[] can diverge again
// without touching callers.
export function getZone(pct, league = 'nba') {
  const zones = cfg(league).zones;
  for (const z of zones) {
    if (pct < z.threshold) return z;
  }
  return zones[zones.length - 1];
}

// ── Step A · Base Adjusted Net Gravity ──────────────────────────────────

// TODO: pick HCA tier per game. NBA blueprint allows standard / highTier /
// lowPace. WNBA blueprint wants arena-tier classification (Elite / Flatline
// / Hard Floor) from home/road net rating splits — that needs the BBR
// scraper to produce per-team home vs road net rating, which the worker
// doesn't extract yet.
function hcaDynamic(game, ctx) {
  const homeTier = stats(ctx, game.league, game.home.abbr).hcaTier;
  const c = cfg(game.league).hca;
  if (homeTier && c[homeTier] != null) return c[homeTier];
  return c.standard;
}

// Delta_Star: quantifiable star absence modification.
//   Δ_Star = (IAF_Mult − 1.0) × 20
//   IAF approximation: 1 + (undInjuryScore − favInjuryScore) × 0.05
//   Output clamped to per-league cap (NBA −5/+5.5, WNBA ±8.0).
//
// Lookups are keyed by ESPN numeric team id, not abbreviation, because the
// ESPN injuries endpoint doesn't ship abbreviations and chasing a separate
// /teams call just to bridge the gap is wasted work.
//
// Returns a structured detail object — `.value` is what existing scalar
// callers consume; the rest powers the breakdown surface (Step 1 of the
// tap-to-expand work).
function deltaStar(game, ctx, favId, undId) {
  const league = game.league;
  const inj = ctx && ctx.getInjuryScore ? ctx.getInjuryScore : () => 0;
  const favScore = inj(league, favId);
  const undScore = inj(league, undId);
  if (league === 'nba') {
    // v2: scores are pts per 100 possessions → convert at this game's pace.
    // No net cap (each player is already capped individually).
    const possessions = projectedPossessions(game, ctx);
    const value = ((undScore - favScore) * possessions) / 100;
    return { value, favScore, undScore, iaf: null, raw: value, clamped: false, model: 'v2', possessions };
  }
  const iaf = 1.0 + (undScore - favScore) * 0.05;
  const raw = (iaf - 1.0) * 20;
  const { min, max } = cfg(league).starCap;
  const value = Math.max(min, Math.min(max, raw));
  return { value, favScore, undScore, iaf, raw, clamped: raw !== value };
}

// Early-season SRS shrinkage. BBR's SRS after 2–3 games is wildly noisy
// (e.g. +22 for a team that won two games by 25), which pushes DBP to
// 95%+ on half the slate in opening week. Shrink the SRS toward 0 with
// a weight that ramps from 0 → 1 over the team's first SRS_SHRINK_GAMES
// games played, then locks at full SRS. Both teams in a matchup are
// shrunk independently, so (favSRS − undSRS) collapses toward 0 when
// either side has little data.
//
// Curve shape: weight = (gp / SRS_SHRINK_GAMES)². Quadratic (convex up)
// so the adjustment stays strong through roughly games 1–8 (weight ≤
// 0.28, so ≥72% shrink), then drops off sharply as gp approaches 15.
// A linear ramp lets SRS reach ~50% of full force by game 8, which is
// too much weight on 8 games of noise.
const SRS_SHRINK_GAMES = 15;

function srsShrinkWeight(teamStats) {
  const gp = get(teamStats, 'wins', 0) + get(teamStats, 'losses', 0);
  if (gp <= 0) return 0;
  if (gp >= SRS_SHRINK_GAMES) return 1;
  const r = gp / SRS_SHRINK_GAMES;
  return r * r;
}

// SRS blended with a recent-form proxy. Mirrors how blendedOff/blendedDef
// inject L10 data into the total projection — same 50/50 weight, same
// "fall back to full-season when L10 isn't available" semantics.
//
// BBR's SRS column on the season page is frozen once the regular season
// ends. During playoffs (NBA April-June) it never updates, which made the
// margin/DBP path totally insensitive to playoff results. The fix: use
// (offL10 − defL10) as a per-100-possession recent NetRtg, multiply by
// the team's own pace to get points-per-game units (matches SRS units),
// then blend with full-season SRS at L10_WEIGHT (NBA 0.60 + SOS, 11/20/26).
//
// L10 source today:
//   NBA April–June  → BBR's playoff page Off/Def Rtg (worker scraper)
//   NBA Oct–Mar      → no L10 yet → falls back to plain SRS
//   WNBA             → no L10 yet → falls back to plain SRS
// (Adding regular-season L10 scraping is on the future-work list.)
//
// Per-100 framework (11/19/26): both halves are put on a per-100-possession
// basis (SRS ÷ team pace × 100; L10 NetRtg already is), blended, then
// converted at THIS GAME's shared possessions. Both teams play the same
// number of possessions, so converting each with its own pace (the old way)
// was slightly off — tiny numerically (~0.04 typical, ≤~0.4 at extreme
// pace gaps) but it puts spreads on the same scale as the totals path.
// Without gamePoss it reduces exactly to the old per-game behavior.
//
// Recent-form weight + strength-of-schedule on the L10 (11/20/26, chosen
// for ATS). Backtest 2024-25..2026-27 weighted toward the two most recent
// seasons (Jordan: 2023-24 no longer representative), ESPN/DK + dataset
// closing lines: 10-game SOS-adjusted @ 0.60 ranked #1 of 168 options on
// recency-weighted ATS (51.1% vs live 50.2%; 2025-26 51.4% vs 50.2%) and
// matches the cover-margin regression's implied weight (0.60). Not a proven
// edge (inside the best-of-168 luck band) — margin RMSE is ~0.03 worse
// than 0.5 raw. WNBA untested → keeps 0.5, no SOS.
export const L10_WEIGHT = { nba: 0.60, wnba: 0.5 };
const L10_SOS_HCA_PER100 = 2.1; // home edge per 100 poss stripped out of L10

// SOS adjustment for a team's last-10 NetRtg, in pts per 100 possessions:
//   mean over the 10 opponents of their CURRENT strength (shrunk SRS per 100)
//   − home-court edge × share of those games played at home.
// A team whose L10 came against strong opponents gets credit; a soft or
// home-heavy stretch gets marked down. teamsByCode is the team table keyed
// by the same BBR codes the L10 scrape stores (BRK, CHO, PHO…). Returns
// null when the schedule context is missing (older cache) → no adjustment.
export function l10SosAdjustment(team, teamsByCode, league = 'nba') {
  if (league !== 'nba') return null;
  const opps = team?.l10Opponents;
  if (!Array.isArray(opps) || opps.length === 0 || !teamsByCode) return null;
  const c = cfg(league);
  let sum = 0, n = 0;
  for (const code of opps) {
    const o = code && teamsByCode[code];
    if (!o) continue;
    const pace = get(o, 'pace', c.paceDefault) || c.paceDefault;
    sum += (get(o, 'srs', 0) * srsShrinkWeight(o) * 100) / pace;
    n++;
  }
  if (n < Math.ceil(opps.length / 2)) return null; // too many unknown opponents
  const homeShare = team.l10HomeGames != null ? team.l10HomeGames / opps.length : 0.5;
  return sum / n - L10_SOS_HCA_PER100 * homeShare;
}

function blendedSRS(teamStats, league, gamePoss) {
  const c = cfg(league);
  const rawSrs = get(teamStats, 'srs', 0);
  const srs = rawSrs * srsShrinkWeight(teamStats);
  const pace = get(teamStats, 'pace', c.paceDefault) || c.paceDefault;
  const poss = gamePoss ?? pace;
  const srsPer100 = (srs * 100) / pace;
  const offL10 = get(teamStats, 'offLast10', null);
  const defL10 = get(teamStats, 'defLast10', null);
  if (offL10 == null || defL10 == null) return (srsPer100 * poss) / 100;
  const sos = league === 'nba' ? get(teamStats, 'l10Sos', null) : null;
  const l10Per100 = offL10 - defL10 + (sos ?? 0);
  const w = L10_WEIGHT[league] ?? 0.5;
  return (((1 - w) * srsPer100 + w * l10Per100) * poss) / 100;
}

// B2B / rest adjustment — empirically measured from 2 full NBA seasons
// (2024-25 + 2025-26, ~2,600 games). "Neither B2B" is the baseline; the
// coefficients below are the measured home-margin shifts vs that baseline.
//
//   daysRest === 1  → back-to-back (team played yesterday)
//   daysRest > 1 or null → not B2B (treated as baseline)
//
// Margin side (signed from HOME perspective):
//   Home B2B only → −3.00 pts (home disadvantaged)
//   Away B2B only → +1.75 pts (home advantaged)
//   Both B2B      → 0 (effect flipped between the two seasons → noise)
//
// Totals side (multiplicative):
//   Home B2B only → ×1.01   (B2B home actually produced slightly HIGHER
//                            totals — pace effect beats fatigue effect)
//   Both B2B      → ×0.99
//   Away B2B only → ×1.00  (variance too high to call — status surfaced
//                            on the breakdown, no number applied)
function restState(game) {
  const hDaysRest = game.home?.daysRest;
  const aDaysRest = game.away?.daysRest;
  const homeB2B = hDaysRest === 1;
  const awayB2B = aDaysRest === 1;
  return { hDaysRest, aDaysRest, homeB2B, awayB2B };
}

function restMarginAdjustment(game) {
  const { homeB2B, awayB2B } = restState(game);
  if (homeB2B && awayB2B) return 0;
  if (homeB2B)            return -3.00;   // home disadvantage
  if (awayB2B)            return +1.75;   // home advantage
  return 0;
}

function restTotalMultiplier(game) {
  const { homeB2B, awayB2B } = restState(game);
  if (homeB2B && awayB2B) return 0.99;
  if (homeB2B && !awayB2B) return 1.01;
  // Away-B2B-alone case: variance too high in historical data to apply
  // an adjustment. Status surfaced on the breakdown, multiplier stays 1.
  return 1.00;
}

// Returns { favoredIsHome, favSRS, undSRS, hca, deltaStar, baseANG, rest }.
function favoritedView(game, ctx) {
  const gamePoss = projectedPossessions(game, ctx);
  const homeSRS = blendedSRS(stats(ctx, game.league, game.home.abbr), game.league, gamePoss);
  const awaySRS = blendedSRS(stats(ctx, game.league, game.away.abbr), game.league, gamePoss);

  const hca = hcaDynamic(game, ctx);

  // Home-perspective rest adjustment (+ = home benefit; − = home hit).
  const restMarginHome = restMarginAdjustment(game);

  // Model selects its OWN favorite: home if SRS + HCA + rest outpaces away.
  const homeNeutral = homeSRS + hca + restMarginHome;
  const favoredIsHome = homeNeutral >= awaySRS;

  const favSRS = favoredIsHome ? homeSRS : awaySRS;
  const undSRS = favoredIsHome ? awaySRS : homeSRS;
  const favId  = favoredIsHome ? game.home.id : game.away.id;
  const undId  = favoredIsHome ? game.away.id : game.home.id;
  const starDetail = deltaStar(game, ctx, favId, undId);

  const hcaSigned = favoredIsHome ? +hca : -hca;
  // Rest adjustment flips sign if the away team is the favorite — same
  // convention as HCA — so Base_ANG stays "favored-perspective".
  const restSigned = favoredIsHome ? +restMarginHome : -restMarginHome;
  const baseANG = (favSRS - undSRS) + hcaSigned + starDetail.value + restSigned;

  return {
    favoredIsHome,
    favSRS,
    undSRS,
    hca,
    deltaStar: starDetail.value,
    deltaStarDetail: starDetail,
    rest: {
      ...restState(game),
      marginHome: restMarginHome,   // signed from home perspective
      marginSigned: restSigned,     // signed from favored perspective
    },
    baseANG,
  };
}

// ── Step B · Volume Delta ───────────────────────────────────────────────

// 50/50 full-season + L10 blend for each volume metric, mirroring the
// pattern blendedOff / blendedDef / blendedSRS already use for totals
// and margin. Falls back to plain full-season when L10 isn't available
// (NBA regular season + WNBA — the scraper only fills L10 fields from
// BBR's playoff page, which is only meaningful for NBA Apr-Jun).
function blendVal(teamStats, fullKey, l10Key) {
  const full = get(teamStats, fullKey, null);
  const l10  = get(teamStats, l10Key,  null);
  if (full == null) return null;
  if (l10 == null)  return full;
  return full * 0.5 + l10 * 0.5;
}

// ── Δ_Vol REMOVED (11/6/26) ─────────────────────────────────────────────
//
// matchupTOG + matchupORG + deltaVol were previously summed into a Δ_Vol
// term added to Base_ANG inside trueGap (DBP% / margin path). Incremental
// analysis against 2 full seasons (residualize margin on NetRtg diff)
// showed |r| < 0.03 for TO differential, DRB%, and 3PAr differential —
// all zero incremental signal after SRS/NetRtg. Same conclusion that
// stripped the totals matchup math; applied symmetrically to the margin
// path on 11/6/26. See [[feedback-model-validation]].
//
// matchupPaceFactor() is INTENTIONALLY preserved below but now orphaned.
// Its only call site was scaling deltaVol inside trueGap; with Δ_Vol gone
// it has nothing to multiply. Kept in code so the MODEL_CONFIG
// `paceMpfBaseline` entries stay referenced and we don't lose the
// implementation if we later find a data-validated place to reconnect
// it (e.g. pace-weighted HCA or Δ_Star). It returns 1.0 when
// `paceMpfBaseline` is null (NBA default), so even if accidentally
// called it's a no-op.

// Matchup Pace Factor — orphaned (see note above). Kept as a scaffold
// for future pace-based adjustments.
function matchupPaceFactor(game, ctx) {
  const c = cfg(game.league);
  if (!c.paceMpfBaseline) return 1.0;
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);
  const hPace = get(hStats, 'pace', c.paceDefault);
  const aPace = get(aStats, 'pace', c.paceDefault);
  return (hPace + aPace) / c.paceMpfBaseline;
}

// ── Step C · True_Gap → Z → DBP% ────────────────────────────────────────

function computeBreakdown(game, ctx) {
  const c = cfg(game.league);
  const view = favoritedView(game, ctx);
  // Δ_Vol removed 11/6/26 — trueGap is now just Base_ANG. See comment
  // block above matchupPaceFactor() for history + rationale.
  const trueGap = view.baseANG;
  const z = c.intercept + c.multiplier * trueGap;
  const dbp = sigmoid(z) * 100;
  return {
    ...view,
    trueGap,
    z,
    dbp,
    zone: getZone(dbp, game.league),
  };
}

export function computeDBP(game, ctx) {
  return computeBreakdown(game, ctx).dbp;
}

// Signed home margin (positive = home favored).
export function projectedMargin(game, ctx) {
  const b = computeBreakdown(game, ctx);
  return b.favoredIsHome ? b.trueGap : -b.trueGap;
}

// ── Over/Under Projection Engine ────────────────────────────────────────

// Gate on NBA playoff months (April–June) — mirrors the same month check
// in worker/src/scrapers/bbref.js for the L10 scrape. paceDeflate is a
// half-court tightening correction that only applies in the playoffs;
// leaving it on in the regular season deflates projected totals by ~4pts.
function isNbaPlayoffs(league) {
  if (league !== 'nba') return false;
  const m = new Date().getUTCMonth() + 1;
  return m >= 4 && m <= 6;
}

function projectedPossessions(game, ctx) {
  const c = cfg(game.league);
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);
  const hPace = get(hStats, 'pace', c.paceDefault);
  const aPace = get(aStats, 'pace', c.paceDefault);
  const paceDeflate = isNbaPlayoffs(game.league) ? c.paceDeflate : 0;
  return ((hPace + aPace) / 2) - paceDeflate;
}

// Shrink a full-season rating toward the league-average default using the
// same (gp/15)² weight as SRS. Early-season ORtg/DRtg has 2-3× the stdev of
// mature-season values; a team showing DRtg=99 after 3 games (because their
// opponents happened to shoot poorly) was dragging projected totals down
// ~9pts. L10 is NOT shrunk — it's recent-form data and inherently fresher.
function shrinkTowardDefault(raw, leagueDefault, teamStats) {
  const w = srsShrinkWeight(teamStats);
  return leagueDefault + (raw - leagueDefault) * w;
}

// Blend full-season and last-10-games offensive rating.
// Per spec: each carries equal 50% weight when L10 data is available.
// If L10 is missing (early season or fetch failed), falls back to full
// season only — no silent weighting artifact.
function blendedOff(teamStats, league) {
  const c = cfg(league);
  const rawFull = get(teamStats, 'off', c.offRtgDefault);
  const full = shrinkTowardDefault(rawFull, c.offRtgDefault, teamStats);
  const l10  = get(teamStats, 'offLast10', null);
  if (l10 != null) return full * 0.5 + l10 * 0.5;
  return full;
}

// Mirror of blendedOff for defensive rating. Same 50/50 blend, same
// L10-missing fallback. Lower = better defense; combined with the
// opponent's offense in combinedOffRating below.
function blendedDef(teamStats, league) {
  const c = cfg(league);
  const rawFull = get(teamStats, 'def', c.defRtgDefault);
  const full = shrinkTowardDefault(rawFull, c.defRtgDefault, teamStats);
  const l10  = get(teamStats, 'defLast10', null);
  if (l10 != null) return full * 0.5 + l10 * 0.5;
  return full;
}

// Injury impact on team rating points (Option 1 totals adjustment).
//
// Re-uses the team injury score that already feeds Δ_Star — sum of
// (status_weight × impactFactor) across the team's listed injuries. For
// totals we apply it twice per team: subtract from their effective
// offensive rating, add to their effective defensive rating. Net effect
// on projected total: usually slightly negative (offense effect bigger
// than defense effect, especially for star scorers being out).
//
// Tunable — calibrate against actual outcomes over time:
//   ALPHA = 0.7  → each unit of injury score drops ORtg by 0.7 pts
//   BETA  = 0.2  → each unit of injury score raises DRtg by 0.2 pts
// Previously ALPHA was 1.0 but even non-star players tend to be good
// offensive players at the NBA level — replacement-level scoring isn't
// zero, so a straight 1.0 ratio was over-penalizing. Dropped to 0.7 on
// 11/5/26. For a star-out team (injury score ~5), that's ~3.5 pts off
// ORtg and ~1 pt onto DRtg. Net projTotal drop ≈ 1.5–2 pts in a
// typical matchup.
const INJURY_TOTAL_ALPHA = 0.7;
const INJURY_TOTAL_BETA  = 0.2;

// ↑ ALPHA/BETA are LEGACY (WNBA only). The backtest showed this rule made
// NBA totals worse than ignoring injuries (RMSE 19.074 vs 18.952). NBA now
// uses the v2 offense/defense split below (18.896).

function teamInjuryScore(game, ctx, teamSide) {
  const inj = ctx && ctx.getInjuryScore ? ctx.getInjuryScore : () => 0;
  return inj(game.league, teamSide.id) || 0;
}

// Injury inputs for the totals path, per team.
//   v2 (NBA):     off/def = the same per-player values that drive Δ_Star,
//                 split OBPM/DBPM (pts per 100). One scale for both paths.
//   legacy (WNBA): ALPHA/BETA × the scalar injury score.
function teamInjuryParts(game, ctx, teamSide) {
  const score = teamInjuryScore(game, ctx, teamSide);
  if (game.league === 'nba') {
    const d = ctx && ctx.getInjuryDetail ? ctx.getInjuryDetail(game.league, teamSide.id) : null;
    return { score, off: d?.offScore ?? 0, def: d?.defScore ?? 0, model: 'v2' };
  }
  return { score, off: INJURY_TOTAL_ALPHA * score, def: INJURY_TOTAL_BETA * score, model: 'legacy' };
}

// ── Matchup dominance correction (11/8/26) ──────────────────────────────
//
// The pure (effOff + effDef) / 2 average under-weights both inputs. Fit
// across 4 full seasons of game-level data (10,216 team-scoring instances,
// leave-one-season-out CV, R² = 0.0385) showed the real relationship is:
//
//   per_team_expected = (effOff + oppEffDef) / 2
//                     + MATCHUP_ORTG_COEF × (effOff − leagueAvgRating)
//                     + MATCHUP_DRTG_COEF × (oppEffDef − leagueAvgRating)
//
// Effective weights become 0.5 + MATCHUP_ORTG_COEF on own ORtg and
// 0.5 + MATCHUP_DRTG_COEF on opponent DRtg. The fact that DRtg carries
// MORE weight than ORtg is a real finding — playing against an elite
// defense determines your scoring more than your own offense does. A top
// defense can shut down anyone; a top offense can still be stopped.
//
// Fitted on pooled regression, intercept was a contaminated version of
// HCA (home-only intercept +1.49, away-only −0.56, diff = 2.05 ≈ hca
// standard 2.10). HCA stays in Base_ANG only — no double-counting here.
//
// Applies to the EFFECTIVE ratings (post-shrinkage, post-injury) so the
// correction naturally scales down early-season when shrinkage compresses
// both deltas toward zero.
//
// ── Dominance strength k (tuned quarterly — see scripts/ktune/) ─────────
// The BASE coefficients below are from that original fit, which used
// SEASON-AGGREGATE (full-season) ratings — i.e. k = 1. Re-fitting on
// POINT-IN-TIME ratings (only games before each game, the way the live
// model sees it) shows full strength over-amplifies noisy live deltas:
// the optimal strength on point-in-time data is ~0.2 across the recent
// full seasons (2023-24..2025-26), and k = 1 actually hurts live totals
// accuracy. So we scale BOTH base coefficients by MATCHUP_DOMINANCE_K.
// Re-fit quarterly (scripts/ktune/ktune.py) and update this ONE number;
// like any model change it affects NEW snapshots only (integrity rule).
const MATCHUP_ORTG_COEF_BASE = 0.40;
const MATCHUP_DRTG_COEF_BASE = 0.63;
const MATCHUP_DOMINANCE_K    = 0.20;  // 11/8/26 shipped at 1.0 → 0.20 on 11/9/26 (point-in-time fit)
const MATCHUP_ORTG_COEF = MATCHUP_ORTG_COEF_BASE * MATCHUP_DOMINANCE_K;  // 0.080 → own-off weight 0.58
const MATCHUP_DRTG_COEF = MATCHUP_DRTG_COEF_BASE * MATCHUP_DOMINANCE_K;  // 0.126 → opp-def weight 0.626

// Matchup-adjusted combined scoring rate.
//
// Each team's expected output blends THEIR offense with the OPPONENT's
// defense, then applies the dominance correction above. Combined =
// home_expected + away_expected.
//
//   homeExpected  =  (effOff(home) + effDef(away)) / 2
//                    + MATCHUP_ORTG_COEF × (effOff(home) − leagueAvg)
//                    + MATCHUP_DRTG_COEF × (effDef(away) − leagueAvg)
//   awayExpected  =  (effOff(away) + effDef(home)) / 2
//                    + MATCHUP_ORTG_COEF × (effOff(away) − leagueAvg)
//                    + MATCHUP_DRTG_COEF × (effDef(home) − leagueAvg)
//
// Injuries:
//   NBA (v2):   applied straight to each team's expected points per 100 —
//               homeExpected −= home's offense lost; += away's defense lost
//               (and mirrored). Matches the validated backtest exactly.
//   WNBA (legacy): folded into effOff / effDef via ALPHA / BETA.
//
// Single source of truth for combinedOffRating() AND totalBreakdown() —
// they used to duplicate this math line for line.
function totalsRatings(game, ctx) {
  const c = cfg(game.league);
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);
  const hI = teamInjuryParts(game, ctx, game.home);
  const aI = teamInjuryParts(game, ctx, game.away);
  const v2 = game.league === 'nba';

  const effHomeOff = blendedOff(hStats, game.league) - (v2 ? 0 : hI.off);
  const effAwayOff = blendedOff(aStats, game.league) - (v2 ? 0 : aI.off);
  const effHomeDef = blendedDef(hStats, game.league) + (v2 ? 0 : hI.def);
  const effAwayDef = blendedDef(aStats, game.league) + (v2 ? 0 : aI.def);

  // League anchor — ORtg and DRtg averages are identical by construction
  // at the league level (one team's points scored equals another's
  // allowed). Using offRtgDefault is fine; it's set to the empirical
  // league average per the 11/5/26 re-anchoring.
  const leagueAvg = c.offRtgDefault;

  const homeBase = (effHomeOff + effAwayDef) / 2;
  const awayBase = (effAwayOff + effHomeDef) / 2;
  const homeCorrection =
    MATCHUP_ORTG_COEF * (effHomeOff - leagueAvg) +
    MATCHUP_DRTG_COEF * (effAwayDef - leagueAvg);
  const awayCorrection =
    MATCHUP_ORTG_COEF * (effAwayOff - leagueAvg) +
    MATCHUP_DRTG_COEF * (effHomeDef - leagueAvg);
  const homeInjuryAdj = v2 ? -hI.off + aI.def : 0;
  const awayInjuryAdj = v2 ? -aI.off + hI.def : 0;

  const homeExpected = homeBase + homeCorrection + homeInjuryAdj;
  const awayExpected = awayBase + awayCorrection + awayInjuryAdj;

  const hPace = get(hStats, 'pace', c.paceDefault);
  const aPace = get(aStats, 'pace', c.paceDefault);
  const paceDeflate = isNbaPlayoffs(game.league) ? c.paceDeflate : 0;

  return {
    leagueAvg, hPace, aPace, paceDeflate,
    possessions: projectedPossessions(game, ctx),
    home: { abbr: game.home.abbr, ratingOff: effHomeOff, ratingDef: effHomeDef, injury: hI,
            baseExpected: homeBase, correction: homeCorrection, injuryAdj: homeInjuryAdj, expected: homeExpected },
    away: { abbr: game.away.abbr, ratingOff: effAwayOff, ratingDef: effAwayDef, injury: aI,
            baseExpected: awayBase, correction: awayCorrection, injuryAdj: awayInjuryAdj, expected: awayExpected },
    combined: homeExpected + awayExpected,
  };
}

function combinedOffRating(game, ctx) {
  return totalsRatings(game, ctx).combined;
}

// ── Totals matchup adjustment (11/6/26 trimmed to only the signals that
//    survived Jordan's precision bar) ────────────────────────────────────
//
// History: we tried TO% + ORB% matchup, then TO diff + DRB% + linear 3PAr,
// then TO diff + DRB% + asymmetric 3PAr. All removed when the incremental
// analysis (residualize against ORtg+DRtg+pace) showed |r|<0.03 — the raw
// slopes were entirely captured by ORtg/DRtg already.
//
// What's kept now, per Jordan's call after reviewing the stratified fringe
// analysis (pooled 2,643 games, residualized on ORtg+DRtg+pace):
//
// 1) TO DIFFERENTIAL — symmetric quadratic
//    Fringe residuals showed both extreme deciles at ~−1.2 pts (an
//    inverted-U around the middle). Model: small middle bonus at
//    TO diff = 0, quadratic penalty as |TO diff| grows.
//      TO_DIFF_MIDDLE_BONUS = 0.3%       (at middle)
//      TO_DIFF_PENALTY_COEF = 0.15       (per TO diff² pp)
//    Values: TO diff = 0 → +0.3%, |TO diff| = 2 → −0.3%, |TO diff| = 2.5
//    (fringe) → −0.64%. Roughly matches the ~−1.2 pt extreme residuals.
//
// 2) 3PAr BOTTOM-DECILE ONLY — one-sided threshold penalty
//    Bottom 10% games (avg 3PAr ~37pp) showed residual −1.40 pts (0.6%)
//    — a real signal Jordan wanted captured. Top-side effects were noise
//    (±0.2 to -0.86 pts, no clear direction). Model: linear penalty
//    ramping between a threshold and a floor, no top-side term.
//      THREE_PAR_LOW_THRESHOLD = 40pp    (penalty starts here)
//      THREE_PAR_LOW_FLOOR     = 37pp    (full −0.6% penalty)
//
// Everything else (DRB%, previous asymmetric 3PAr top-side penalty,
// ORB%) stays dropped — stratified fringes didn't support them.
const TO_DIFF_MIDDLE_BONUS = 0.30;
const TO_DIFF_PENALTY_COEF = 0.15;

const THREE_PAR_LOW_THRESHOLD = 40;
const THREE_PAR_LOW_FLOOR     = 37;
const THREE_PAR_LOW_MAX_PENALTY = 0.6;

function toDiffImpactPct(gameToDiff) {
  return TO_DIFF_MIDDLE_BONUS - TO_DIFF_PENALTY_COEF * gameToDiff * gameToDiff;
}

function threePArLowImpactPct(game3PArPp) {
  if (game3PArPp >= THREE_PAR_LOW_THRESHOLD) return 0;
  if (game3PArPp <= THREE_PAR_LOW_FLOOR)     return -THREE_PAR_LOW_MAX_PENALTY;
  // Linear interpolation between threshold (0%) and floor (-max%)
  const t = (THREE_PAR_LOW_THRESHOLD - game3PArPp) / (THREE_PAR_LOW_THRESHOLD - THREE_PAR_LOW_FLOOR);
  return -THREE_PAR_LOW_MAX_PENALTY * t;
}

function shrinkRate(raw, leagueAvg, teamStats) {
  const w = srsShrinkWeight(teamStats);
  return leagueAvg + (raw - leagueAvg) * w;
}

function totalMatchupDetail(game, ctx) {
  const c = cfg(game.league);
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);

  // ── TO differential (symmetric quadratic) ──────────────────────────
  // Per-team diff = opp_TOV% − own_TOV%. Both sides shrunk toward league
  // avg TOV (13.5 placeholder — exact value doesn't matter, both sides
  // shrink toward the same anchor and the diff cancels).
  const DEFAULT_TOV = 13.5;
  const hToOff = shrinkRate(get(hStats, 'toOff', DEFAULT_TOV), DEFAULT_TOV, hStats);
  const aToOff = shrinkRate(get(aStats, 'toOff', DEFAULT_TOV), DEFAULT_TOV, aStats);
  const hToDef = shrinkRate(get(hStats, 'toDef', DEFAULT_TOV), DEFAULT_TOV, hStats);
  const aToDef = shrinkRate(get(aStats, 'toDef', DEFAULT_TOV), DEFAULT_TOV, aStats);
  const hDiff = hToDef - hToOff;
  const aDiff = aToDef - aToOff;
  const gameToDiff = (hDiff + aDiff) / 2;
  const toDiffImpact = toDiffImpactPct(gameToDiff);

  // ── 3PAr bottom-decile threshold penalty ──────────────────────────
  const h3PAr = shrinkRate(get(hStats, 'threePAr', c.leagueAvg3PAr), c.leagueAvg3PAr, hStats) * 100;
  const a3PAr = shrinkRate(get(aStats, 'threePAr', c.leagueAvg3PAr), c.leagueAvg3PAr, aStats) * 100;
  const game3PAr = (h3PAr + a3PAr) / 2;
  const threePArImpact = threePArLowImpactPct(game3PAr);

  const multiplier = 1 + (toDiffImpact + threePArImpact) / 100;

  return {
    gameToDiff, toDiffImpactPct: toDiffImpact,
    toDiffMiddleBonus: TO_DIFF_MIDDLE_BONUS, toDiffPenaltyCoef: TO_DIFF_PENALTY_COEF,
    game3PAr, threePArImpactPct: threePArImpact,
    threePArLowThreshold: THREE_PAR_LOW_THRESHOLD, threePArLowFloor: THREE_PAR_LOW_FLOOR,
    multiplier,
  };
}

export function projectedTotal(game, ctx) {
  const poss = projectedPossessions(game, ctx);
  const combined = combinedOffRating(game, ctx);
  const matchup = totalMatchupDetail(game, ctx);
  const restMult = restTotalMultiplier(game);
  return (poss * combined / 100) * matchup.multiplier * restMult;
}

// Structured breakdown of the totals projection — mirrors predictionBreakdown
// in format so the UI can render it the same way. Called once; its output
// is frozen into the snapshot alongside the DBP breakdown.
export function totalBreakdown(game, ctx) {
  const tr = totalsRatings(game, ctx);
  const { leagueAvg, hPace, aPace, paceDeflate, possessions, combined } = tr;
  const teamRow = (t) => ({
    abbr: t.abbr,
    ratingOff: t.ratingOff,
    ratingDef: t.ratingDef,
    injuryScore: t.injury.score,
    injuryOff: t.injury.off,       // pts per 100 of THIS team's offense lost
    injuryDef: t.injury.def,       // pts per 100 of THIS team's defense lost
    injuryModel: t.injury.model,   // 'v2' (NBA) | 'legacy' (WNBA)
    baseExpected: t.baseExpected,
    correction: t.correction,
    injuryAdj: t.injuryAdj,        // v2: change to this team's expected pts per 100
    expected: t.expected,
  });

  const baseTotal = (possessions * combined) / 100;
  const matchup = totalMatchupDetail(game, ctx);

  const rest = restState(game);
  const restMultiplier = restTotalMultiplier(game);
  const total = baseTotal * matchup.multiplier * restMultiplier;

  return {
    possessions: {
      homePace: hPace,
      awayPace: aPace,
      paceDeflate,
      value: possessions,
    },
    ratings: {
      home: teamRow(tr.home),
      away: teamRow(tr.away),
      combined,
      baseTotal,
      matchupCorrection: {
        leagueAvg,
        ortgCoef: MATCHUP_ORTG_COEF,
        drtgCoef: MATCHUP_DRTG_COEF,
      },
    },
    matchup,
    rest: {
      homeDaysRest: rest.hDaysRest,
      awayDaysRest: rest.aDaysRest,
      homeB2B: rest.homeB2B,
      awayB2B: rest.awayB2B,
      multiplier: restMultiplier,
    },
    total,
  };
}

// ── Derived picks ───────────────────────────────────────────────────────

// SPREAD PICK: compare model margin to the book's signed home line.
// homeLine is the home team's signed line (e.g. -5.5 = home favored by 5.5).
// "Home covers" when modelMargin + homeLine > 0.
export function spreadPick(game, ctx) {
  const { homeLine } = game.odds || {};
  if (homeLine == null) return null;

  const modelMargin = projectedMargin(game, ctx);
  const homeEdge = modelMargin + homeLine;

  if (homeEdge >= 0) {
    return { side: game.home.abbr, line: homeLine,  edge: homeEdge };
  }
  return   { side: game.away.abbr, line: -homeLine, edge: -homeEdge };
}

// O/U PICK: compare projected total to the book O/U.
export function ouPick(game, ctx) {
  if (game.odds?.total == null) return null;
  const proj = projectedTotal(game, ctx);
  const direction = proj > game.odds.total ? 'OVER' : 'UNDER';
  return { direction, line: game.odds.total, edge: proj - game.odds.total };
}

// Formatting helper for signed lines.
export function fmtLine(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(1)}`;
}

// Structured breakdown surface — powers the tap-to-expand UI. Every number
// here is derived from the same code path as computeDBP / projectedMargin /
// predictionInputs, so the breakdown can't drift from the scalar display.
//
// Per-player Δ_Star rows come from an optional ctx.getInjuryDetail(league,
// teamId) → { score, rows }. When the ctx doesn't expose it (early-callers,
// frontend without the bundled rosters), players[] falls back to []; the
// scalar team scores still match exactly because they come from the same
// ctx.getInjuryScore path everything else uses.
export function predictionBreakdown(game, ctx) {
  const c = cfg(game.league);
  const b = computeBreakdown(game, ctx);

  const favAbbr = b.favoredIsHome ? game.home.abbr : game.away.abbr;
  const undAbbr = b.favoredIsHome ? game.away.abbr : game.home.abbr;
  const favId   = b.favoredIsHome ? game.home.id   : game.away.id;
  const undId   = b.favoredIsHome ? game.away.id   : game.home.id;

  const getDetail = ctx && ctx.getInjuryDetail
    ? ctx.getInjuryDetail
    : () => ({ score: 0, rows: [] });
  const favDetail = getDetail(game.league, favId);
  const undDetail = getDetail(game.league, undId);

  const star = b.deltaStarDetail;

  return {
    favoredIsHome: b.favoredIsHome,
    favAbbr,
    undAbbr,
    baseANG: {
      favSRS: b.favSRS,
      undSRS: b.undSRS,
      srsDelta: b.favSRS - b.undSRS,
      hca: b.hca,
      hcaSigned: b.favoredIsHome ? +b.hca : -b.hca,
      deltaStar: b.deltaStar,
      rest: b.rest ? {
        homeDaysRest: b.rest.hDaysRest,
        awayDaysRest: b.rest.aDaysRest,
        homeB2B: b.rest.homeB2B,
        awayB2B: b.rest.awayB2B,
        marginHome: b.rest.marginHome,       // signed, home-perspective
        marginSigned: b.rest.marginSigned,   // signed, favored-perspective
      } : null,
      total: b.baseANG,
    },
    deltaStar: {
      favTeam: {
        abbr: favAbbr,
        score: star.favScore,
        players: favDetail.rows || [],
      },
      undTeam: {
        abbr: undAbbr,
        score: star.undScore,
        players: undDetail.rows || [],
      },
      iaf: star.iaf,
      raw: star.raw,
      clamped: star.clamped,
      value: star.value,
      model: star.model || 'legacy',        // 'v2' = rebuilt NBA injury value
      possessions: star.possessions ?? null,
    },
    dbp: {
      intercept: c.intercept,
      multiplier: c.multiplier,
      trueGap: b.trueGap,
      z: b.z,
      dbp: b.dbp,
    },
    total: totalBreakdown(game, ctx),
  };
}

// Inputs surface used in card footer / debugging
export function predictionInputs(game, ctx) {
  const b = computeBreakdown(game, ctx);
  return {
    favoredIsHome: b.favoredIsHome,
    favSRS: +b.favSRS.toFixed(2),
    undSRS: +b.undSRS.toFixed(2),
    hca: b.hca,
    deltaStar: b.deltaStar,
    baseANG: +b.baseANG.toFixed(2),
    trueGap: +b.trueGap.toFixed(2),
    z: +b.z.toFixed(3),
  };
}

// League-specific blowout thresholds (used by the tracker + accuracy chart).
export const BLOWOUT_THRESHOLD = {
  nba:  MODEL_CONFIG.nba.blowoutMargin,
  wnba: MODEL_CONFIG.wnba.blowoutMargin,
};

// League-specific zone definitions exposed for the Tracker's filter chips.
export function zoneLabels(league = 'nba') {
  return cfg(league).zones.map((z) => z.label);
}
