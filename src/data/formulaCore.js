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
      standard: 3.50, // Base ANG default
      highTier: 4.00, // High-tier / Extreme urgency
      lowPace:  2.75, // Low-Possession / Slow team
    },
    paceDeflate:     3.5,  // NBA playoff half-court tightening
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
// Unmatched names fall back to impact = 1.0 (status-only behavior) so
// name-matching gaps don't silently zero out an injury entry.

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
  if (!rosterEntry) return 1.0; // unmatched → status-only fallback
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
// weighted via impactFactor(rosterEntry). When not (frontend without
// bundled rosters), falls back to status-only (impact = 1.0).
//
// Rows are returned sorted by contribution desc so the UI shows the
// heaviest-hitting absences first.
export function computeInjuryScoreDetailed(players, rosterByNormName) {
  if (!Array.isArray(players)) return { score: 0, rows: [] };
  let score = 0;
  const rows = [];
  for (const p of players) {
    const key = String(p?.status || '').toLowerCase().trim();
    const statusWeight = INJURY_STATUS_WEIGHTS[key] || 0;
    if (statusWeight === 0) continue;
    const entry = rosterByNormName ? findRosterEntry(p?.player, rosterByNormName) : null;
    const impact = rosterByNormName ? impactFactor(entry) : 1.0;
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
  return { score, rows };
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
function deltaStar(ctx, league, favId, undId) {
  const inj = ctx && ctx.getInjuryScore ? ctx.getInjuryScore : () => 0;
  const favScore = inj(league, favId);
  const undScore = inj(league, undId);
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
// then 50/50 blend with full-season SRS.
//
// L10 source today:
//   NBA April–June  → BBR's playoff page Off/Def Rtg (worker scraper)
//   NBA Oct–Mar      → no L10 yet → falls back to plain SRS
//   WNBA             → no L10 yet → falls back to plain SRS
// (Adding regular-season L10 scraping is on the future-work list.)
function blendedSRS(teamStats, league) {
  const c = cfg(league);
  const rawSrs = get(teamStats, 'srs', 0);
  const srs = rawSrs * srsShrinkWeight(teamStats);
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
  const starDetail = deltaStar(ctx, game.league, favId, undId);

  const hcaSigned = favoredIsHome ? +hca : -hca;
  const baseANG = (favSRS - undSRS) + hcaSigned + starDetail.value;
  return {
    favoredIsHome,
    favSRS,
    undSRS,
    hca,
    deltaStar: starDetail.value,
    deltaStarDetail: starDetail,
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

// Returns a detail object — `.value` is what existing scalar callers
// consume; the per-team blended inputs power the breakdown surface.
function matchupTOG(favStats, undStats) {
  // From the favorite's perspective, positive should mean
  // "TO matchup helps the favorite." Higher TO% is BAD for the team
  // turning it over (unlike ORB%/DRB% which are control stats). So:
  //   ((undOff_TO + favDef_TO) / 2)   = und's expected TO% (high = good for fav)
  // − ((favOff_TO + undDef_TO) / 2)   = fav's expected TO% (high = bad for fav)
  //
  // Previously the two halves were swapped, which inverted the sign:
  // a favorite with the better TO matchup ended up REDUCING their
  // projected margin via Δ_Vol. Fixed 5/26/26 after a sign-trace on
  // tomorrow's OKC @ SAS — OKC forces TOs at 14.6%/15.7% (high) and
  // SAS at 11.5%/11.8% (low), so the TO matchup clearly favors OKC,
  // and matchupTOG should reflect that with a POSITIVE value.
  //
  // Each input is the 50/50 blend of full-season + L10. If the data
  // pipeline doesn't provide L10 for this league/season, blendVal
  // returns the plain full-season value.
  const favOff = blendVal(favStats, 'toOff', 'toOffLast10');
  const undDef = blendVal(undStats, 'toDef', 'toDefLast10');
  const undOff = blendVal(undStats, 'toOff', 'toOffLast10');
  const favDef = blendVal(favStats, 'toDef', 'toDefLast10');
  if ([favOff, undDef, undOff, favDef].some((v) => v == null)) {
    return { value: 0, favOff_TO: null, undDef_TO: null, undOff_TO: null, favDef_TO: null };
  }
  const value = ((undOff + favDef) / 2) - ((favOff + undDef) / 2);
  return { value, favOff_TO: favOff, undDef_TO: undDef, undOff_TO: undOff, favDef_TO: favDef };
}

function matchupORG(favStats, undStats) {
  // ((ORB%_Fav_Off + DRB%_Und_Def_Allowed) / 2)
  //  − ((ORB%_Und_Off + DRB%_Fav_Def_Allowed) / 2)
  // DRB%_X_Def_Allowed = 100 − opponent ORB% — but our team-stats schema
  // already stores `drbDef` as the team's defensive rebound %, so the
  // "allowed" portion is implicit. We approximate the blueprint as:
  //   favBoardEdge = (favOrbOff + undDrbDef) / 2
  //                  − (undOrbOff + favDrbDef) / 2
  // Each input is the 50/50 full-season + L10 blend.
  const favOff = blendVal(favStats, 'orbOff', 'orbOffLast10');
  const undDef = blendVal(undStats, 'drbDef', 'drbDefLast10');
  const undOff = blendVal(undStats, 'orbOff', 'orbOffLast10');
  const favDef = blendVal(favStats, 'drbDef', 'drbDefLast10');
  if ([favOff, undDef, undOff, favDef].some((v) => v == null)) {
    return { value: 0, favOff_ORB: null, undDef_ORB: null, undOff_ORB: null, favDef_ORB: null };
  }
  const value = ((favOff + undDef) / 2) - ((undOff + favDef) / 2);
  return { value, favOff_ORB: favOff, undDef_ORB: undDef, undOff_ORB: undOff, favDef_ORB: favDef };
}

function deltaVol(game, view, ctx) {
  const favAbbr = view.favoredIsHome ? game.home.abbr : game.away.abbr;
  const undAbbr = view.favoredIsHome ? game.away.abbr : game.home.abbr;
  const favStats = stats(ctx, game.league, favAbbr);
  const undStats = stats(ctx, game.league, undAbbr);
  const tog = matchupTOG(favStats, undStats);
  const org = matchupORG(favStats, undStats);
  const value = (tog.value * 1.4) + (org.value * 0.5);
  return { value, tog, org };
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

function computeBreakdown(game, ctx) {
  const c = cfg(game.league);
  const view = favoritedView(game, ctx);
  const dvolDetail = deltaVol(game, view, ctx);
  const mpf = matchupPaceFactor(game, ctx);
  const trueGap = view.baseANG + dvolDetail.value * mpf;
  const z = c.intercept + c.multiplier * trueGap;
  const dbp = sigmoid(z) * 100;
  return {
    ...view,
    deltaVol: dvolDetail.value,
    deltaVolDetail: dvolDetail,
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

// Injury impact on team rating points (Option 1 totals adjustment).
//
// Re-uses the team injury score that already feeds Δ_Star — sum of
// (status_weight × impactFactor) across the team's listed injuries. For
// totals we apply it twice per team: subtract from their effective
// offensive rating, add to their effective defensive rating. Net effect
// on projected total: usually slightly negative (offense effect bigger
// than defense effect, especially for star scorers being out).
//
// Tunable starting points — calibrate against actual outcomes over time:
//   ALPHA = 1.0  → each unit of injury score drops ORtg by 1.0 point
//   BETA  = 0.2  → each unit of injury score raises DRtg by 0.2 points
// For a star-out team (injury score ~5), that's ~5 pts off ORtg and
// ~1 pt onto DRtg. Net projTotal drop ≈ 2.5–3 pts in a typical matchup.
const INJURY_TOTAL_ALPHA = 1.0;
const INJURY_TOTAL_BETA  = 0.2;

function teamInjuryScore(game, ctx, teamSide) {
  const inj = ctx && ctx.getInjuryScore ? ctx.getInjuryScore : () => 0;
  return inj(game.league, teamSide.id) || 0;
}

// Matchup-adjusted combined scoring rate.
//
// Each team's expected output blends THEIR offense with the OPPONENT's
// defense, not just the sum of two raw offensive ratings. Books and
// industry models do this — without it, totals are systematically biased
// OVER because the formula assumes you score your ORtg against everyone
// (ignoring that strong defenses suppress scoring).
//
//   homeExpected  =  (effOff(home) + effDef(away))  / 2
//   awayExpected  =  (effOff(away) + effDef(home))  / 2
//   combined      =  homeExpected + awayExpected
//
// Where effOff / effDef each have their team's injury impact subtracted
// from offense / added to defense respectively (see INJURY_TOTAL_ALPHA
// and INJURY_TOTAL_BETA above).
function combinedOffRating(game, ctx) {
  const hStats = stats(ctx, game.league, game.home.abbr);
  const aStats = stats(ctx, game.league, game.away.abbr);
  const hInj = teamInjuryScore(game, ctx, game.home);
  const aInj = teamInjuryScore(game, ctx, game.away);

  const effHomeOff = blendedOff(hStats, game.league) - INJURY_TOTAL_ALPHA * hInj;
  const effAwayOff = blendedOff(aStats, game.league) - INJURY_TOTAL_ALPHA * aInj;
  const effHomeDef = blendedDef(hStats, game.league) + INJURY_TOTAL_BETA  * hInj;
  const effAwayDef = blendedDef(aStats, game.league) + INJURY_TOTAL_BETA  * aInj;

  const homeExpected = (effHomeOff + effAwayDef) / 2;
  const awayExpected = (effAwayOff + effHomeDef) / 2;
  return homeExpected + awayExpected;
}

export function projectedTotal(game, ctx) {
  const poss = projectedPossessions(game, ctx);
  const combined = combinedOffRating(game, ctx);
  return (poss * combined) / 100;
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

  const tog = b.deltaVolDetail.tog;
  const org = b.deltaVolDetail.org;
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
      total: b.baseANG,
    },
    deltaVol: {
      matchupTOG: tog,
      matchupORG: org,
      togWeighted: tog.value * 1.4,
      orgWeighted: org.value * 0.5,
      sum: b.deltaVolDetail.value,
      mpf: b.mpf,
      total: b.deltaVolDetail.value * b.mpf,
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
    },
    dbp: {
      intercept: c.intercept,
      multiplier: c.multiplier,
      trueGap: b.trueGap,
      z: b.z,
      dbp: b.dbp,
    },
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
