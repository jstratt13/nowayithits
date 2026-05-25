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

export const MODEL_CONFIG = {
  nba: {
    intercept: -2.095,
    multiplier: 0.185,
    starCap: { min: -5.0, max: 5.5 },
    hca: {
      standard: 3.50, // Base ANG default
      highTier: 4.00, // High-tier / Extreme urgency
      lowPace:  2.75, // Low-Possession / Slow team
    },
    paceDeflate:     3.5,  // NBA playoff half-court tightening
    otHangover:      1.75,
    restRustEff:     0.985,
    paceDefault:     99,
    offRtgDefault:  115,
    defRtgDefault:  115,   // league average DRtg ≈ ORtg
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
    otHangover:      1.50,
    restRustEff:     0.985,
    paceDefault:     80,
    offRtgDefault:  100,
    defRtgDefault:  100,   // WNBA league average DRtg ≈ ORtg
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

export const INJURY_STATUS_WEIGHTS = {
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
//   - Per-league Δ_Star caps (NBA ±5/+5.5, WNBA ±8) still bound the
//     extreme top end if a team has multiple stars OUT
//
// Calibrated impact magnitudes:
//   Luka  (35.8 mpg / 9.3 BPM)     →  5.01
//   LeBron (33.2 / 3.5)            →  2.73
//   Avg starter (28 / 1.0)         →  1.61
//   12-mpg bench (12 / 0)          →  0.57
//   DJ Garcia rookie (6.2 / 6.4)   →  0.35   (was 0.84 under old linear)
//   Deep bench (4 / −2)            →  0.11
//   A'ja Wilson (28.8 / PER 32.5)  →  4.08
//
// Unmatched names fall back to impact = 1.0 (status-only behavior) so
// name-matching gaps don't silently zero out an injury entry.

export const MPG_FULL = 36;

// NBA — BPM as advanced metric
export const BPM_REPLACEMENT  = -2;
export const BPM_SCALE        = 2.8;
export const BPM_TRUST_MIN    = 18;

// WNBA — PER as advanced metric (BBR doesn't compute BPM for WNBA)
export const PER_BASE         = 12;
export const PER_SCALE        = 5;
export const PER_TRUST_MIN    = 12;

export const NAME_MATCH_THRESHOLD = 0.75;

export function impactFactor(rosterEntry) {
  if (!rosterEntry) return 1.0; // unmatched → status-only fallback
  const mpg = rosterEntry.mpg ?? 0;
  const mpgFactor = Math.min(mpg / MPG_FULL, 1.0);

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

// computeInjuryScore: sum of (status_weight × player_impact) across the
// team's injury list. `rosterByNormName` is optional — when provided, the
// score is player-weighted. When not provided (e.g. frontend without
// bundled rosters), falls back to status-only (impact = 1.0 for everyone).
export function computeInjuryScore(players, rosterByNormName) {
  if (!Array.isArray(players)) return 0;
  let score = 0;
  for (const p of players) {
    const key = String(p?.status || '').toLowerCase().trim();
    const statusWeight = INJURY_STATUS_WEIGHTS[key] || 0;
    if (statusWeight === 0) continue;
    const impact = rosterByNormName
      ? impactFactor(findRosterEntry(p?.player, rosterByNormName))
      : 1.0;
    score += statusWeight * impact;
  }
  return score;
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

// getZone is league-aware. NBA tops out at "Max Expulsion" above 65%;
// WNBA tops out at "Super Lock" above 75% per the WNBA blueprint.
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
function deltaStar(ctx, league, favId, undId) {
  const inj = ctx && ctx.getInjuryScore ? ctx.getInjuryScore : () => 0;
  const favScore = inj(league, favId);
  const undScore = inj(league, undId);
  const iaf = 1.0 + (undScore - favScore) * 0.05;
  const raw = (iaf - 1.0) * 20;
  const { min, max } = cfg(league).starCap;
  return Math.max(min, Math.min(max, raw));
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
// then 50/50 blend with full-season SRS.
//
// L10 source today:
//   NBA April–June  → BBR's playoff page Off/Def Rtg (worker scraper)
//   NBA Oct–Mar      → no L10 yet → falls back to plain SRS
//   WNBA             → no L10 yet → falls back to plain SRS
// (Adding regular-season L10 scraping is on the future-work list.)
function blendedSRS(teamStats, league) {
  const c = cfg(league);
  const srs = get(teamStats, 'srs', 0);
  const offL10 = get(teamStats, 'offLast10', null);
  const defL10 = get(teamStats, 'defLast10', null);
  if (offL10 == null || defL10 == null) return srs;

  const pace = get(teamStats, 'pace', c.paceDefault);
  // Convert NetRtg (per-100-poss) → points-per-game so the units align with SRS.
  const recentSrsProxy = ((offL10 - defL10) * pace) / 100;
  return 0.5 * srs + 0.5 * recentSrsProxy;
}

// Returns { favoredIsHome, favSRS, undSRS, hca, deltaStar, baseANG }.
function favoritedView(game, ctx) {
  const homeSRS = blendedSRS(stats(ctx, game.league, game.home.abbr), game.league);
  const awaySRS = blendedSRS(stats(ctx, game.league, game.away.abbr), game.league);

  const hca = hcaDynamic(game, ctx);

  // Model selects its OWN favorite: home if SRS + HCA outpaces away.
  const homeNeutral = homeSRS + hca;
  const favoredIsHome = homeNeutral >= awaySRS;

  const favSRS = favoredIsHome ? homeSRS : awaySRS;
  const undSRS = favoredIsHome ? awaySRS : homeSRS;
  const favId  = favoredIsHome ? game.home.id : game.away.id;
  const undId  = favoredIsHome ? game.away.id : game.home.id;
  const star = deltaStar(ctx, game.league, favId, undId);

  const hcaSigned = favoredIsHome ? +hca : -hca;
  const baseANG = (favSRS - undSRS) + hcaSigned + star;
  return { favoredIsHome, favSRS, undSRS, hca, deltaStar: star, baseANG };
}

// ── Step B · Volume Delta ───────────────────────────────────────────────

function matchupTOG(favStats, undStats) {
  // ((TO%_Fav_Off + TO%_Und_Def) / 2) − ((TO%_Und_Off + TO%_Fav_Def) / 2)
  // All four fields default to null; if any are missing we return 0 to
  // avoid contaminating Δ_Vol with partial data.
  const favOff = get(favStats, 'toOff', null);
  const undDef = get(undStats, 'toDef', null);
  const undOff = get(undStats, 'toOff', null);
  const favDef = get(favStats, 'toDef', null);
  if ([favOff, undDef, undOff, favDef].some((v) => v == null)) return 0;
  return ((favOff + undDef) / 2) - ((undOff + favDef) / 2);
}

function matchupORG(favStats, undStats) {
  // ((ORB%_Fav_Off + DRB%_Und_Def_Allowed) / 2)
  //  − ((ORB%_Und_Off + DRB%_Fav_Def_Allowed) / 2)
  // DRB%_X_Def_Allowed = 100 − opponent ORB% — but our team-stats schema
  // already stores `drbDef` as the team's defensive rebound %, so the
  // "allowed" portion is implicit. We approximate the blueprint as:
  //   favBoardEdge = (favOrbOff + undDrbDef) / 2
  //                  − (undOrbOff + favDrbDef) / 2
  const favOff = get(favStats, 'orbOff', null);
  const undDef = get(undStats, 'drbDef', null);
  const undOff = get(undStats, 'orbOff', null);
  const favDef = get(favStats, 'drbDef', null);
  if ([favOff, undDef, undOff, favDef].some((v) => v == null)) return 0;
  return ((favOff + undDef) / 2) - ((undOff + favDef) / 2);
}

function deltaVol(game, view, ctx) {
  const favAbbr = view.favoredIsHome ? game.home.abbr : game.away.abbr;
  const undAbbr = view.favoredIsHome ? game.away.abbr : game.home.abbr;
  const favStats = stats(ctx, game.league, favAbbr);
  const undStats = stats(ctx, game.league, undAbbr);
  const tog = matchupTOG(favStats, undStats);
  const org = matchupORG(favStats, undStats);
  return (tog * 1.4) + (org * 0.5);
}

// Matchup Pace Factor. When the league config enables it, scales Volume
// Delta in True Gap by the game's expected possession count relative to
// a baseline. Slow-paced games (WNBA at ~80 pace) get a sub-1 multiplier
// → Δ_Vol contributes less, because fewer possessions mean fewer chances
// for TOV/ORB advantages to manifest.
//
//   MPF = (home_pace + away_pace) / mpfBaseline
//
// WNBA: mpfBaseline = 192 (2 × 96 reference pace), so MPF ≈ 0.83 at
// league-average pace 80 → Δ_Vol contribution dampened ~17%.
// NBA: mpfBaseline = null → MPF = 1.0 (no scaling, identical behavior
// to before this change).
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

export function computeBreakdown(game, ctx) {
  const c = cfg(game.league);
  const view = favoritedView(game, ctx);
  const dvol = deltaVol(game, view, ctx);
  const mpf = matchupPaceFactor(game, ctx);
  const trueGap = view.baseANG + dvol * mpf;
  const z = c.intercept + c.multiplier * trueGap;
  const dbp = sigmoid(z) * 100;
  return {
    ...view,
    deltaVol: dvol,
    mpf,
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

function projectedPossessions(game, ctx) {
  const c = cfg(game.league);
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);
  const hPace = get(hStats, 'pace', c.paceDefault);
  const aPace = get(aStats, 'pace', c.paceDefault);
  return ((hPace + aPace) / 2) - c.paceDeflate;
}

// Blend full-season and last-10-games offensive rating.
// Per spec: each carries equal 50% weight when L10 data is available.
// If L10 is missing (early season or fetch failed), falls back to full
// season only — no silent weighting artifact.
function blendedOff(teamStats, league) {
  const c = cfg(league);
  const full = get(teamStats, 'off', c.offRtgDefault);
  const l10  = get(teamStats, 'offLast10', null);
  if (l10 != null) return full * 0.5 + l10 * 0.5;
  return full;
}

// Mirror of blendedOff for defensive rating. Same 50/50 blend, same
// L10-missing fallback. Lower = better defense; combined with the
// opponent's offense in combinedOffRating below.
function blendedDef(teamStats, league) {
  const c = cfg(league);
  const full = get(teamStats, 'def', c.defRtgDefault);
  const l10  = get(teamStats, 'defLast10', null);
  if (l10 != null) return full * 0.5 + l10 * 0.5;
  return full;
}

// Matchup-adjusted combined scoring rate.
//
// Each team's expected output blends THEIR offense with the OPPONENT's
// defense, not just the sum of two raw offensive ratings. Books and
// industry models do this — without it, totals are systematically biased
// OVER because the formula assumes you score your ORtg against everyone
// (ignoring that strong defenses suppress scoring).
//
//   homeExpected  =  (blendedOff(home) + blendedDef(away))  / 2
//   awayExpected  =  (blendedOff(away) + blendedDef(home))  / 2
//   combined      =  homeExpected + awayExpected
//
// Algebraically equivalent to:
//   combined = (sumOfBlendedOff + sumOfBlendedDef) / 2
// — i.e. the simple average of total offense vs total defense, which is
// the intuition: a high-octane offense playing a top defense settles
// somewhere in the middle.
function combinedOffRating(game, ctx) {
  const c = cfg(game.league);
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);

  const homeExpected = (blendedOff(hStats, game.league) + blendedDef(aStats, game.league)) / 2;
  const awayExpected = (blendedOff(aStats, game.league) + blendedDef(hStats, game.league)) / 2;
  let combined = homeExpected + awayExpected;

  if (game.modifiers?.restRust) combined *= c.restRustEff;
  return combined;
}

export function projectedTotal(game, ctx) {
  const c = cfg(game.league);
  const poss = projectedPossessions(game, ctx);
  const combined = combinedOffRating(game, ctx);
  let total = (poss * combined) / 100;
  if (game.modifiers?.otHangover) total += c.otHangover;
  return total;
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
    deltaVol: +b.deltaVol.toFixed(2),
    mpf: +b.mpf.toFixed(3),
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
