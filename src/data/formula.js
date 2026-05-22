// ─────────────────────────────────────────────────────────────────────────
//  Blowy 5.2 — Prediction formulas
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
//  League-specific values live in MODEL_CONFIG below. NBA defaults come
//  from blowy_52_model_training_blueprint.csv; WNBA defaults come from
//  gemini-code-1779431740324.txt.
// ─────────────────────────────────────────────────────────────────────────

import { getActiveTeamStats, getInjuryScore } from './liveStats.js';

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
    paceDeflate:     2.5,
    otHangover:      1.75,
    restRustEff:     0.985,
    paceDefault:     99,
    offRtgDefault:  115,
    blowoutMargin:   16,
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
    paceDeflate:     1.5,  // tighter than NBA — WNBA games are 40 min
    otHangover:      1.50,
    restRustEff:     0.985,
    paceDefault:     80,
    offRtgDefault:  100,
    blowoutMargin:   14,
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

// ── Team stats accessor (live-or-stub from liveStats store) ────────────

function stats(league, abbr) {
  return getActiveTeamStats(league, abbr) || {};
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
function hcaDynamic(game) {
  const homeTier = stats(game.league, game.home.abbr).hcaTier;
  const c = cfg(game.league).hca;
  if (homeTier && c[homeTier] != null) return c[homeTier];
  return c.standard;
}

// Delta_Star: quantifiable star absence modification.
//   Δ_Star = (IAF_Mult − 1.0) × 20
//   IAF approximation: 1 + (undInjuryScore − favInjuryScore) × 0.05
//   Output clamped to per-league cap (NBA −5/+5.5, WNBA ±8.0).
function deltaStar(league, favAbbr, undAbbr) {
  const favScore = getInjuryScore(league, favAbbr);
  const undScore = getInjuryScore(league, undAbbr);
  const iaf = 1.0 + (undScore - favScore) * 0.05;
  const raw = (iaf - 1.0) * 20;
  const { min, max } = cfg(league).starCap;
  return Math.max(min, Math.min(max, raw));
}

// Returns { favoredIsHome, favSRS, undSRS, hca, deltaStar, baseANG }.
function favoritedView(game) {
  const homeSRS = get(stats(game.league, game.home.abbr), 'srs', 0);
  const awaySRS = get(stats(game.league, game.away.abbr), 'srs', 0);

  const hca = hcaDynamic(game);

  // Model selects its OWN favorite: home if SRS + HCA outpaces away.
  const homeNeutral = homeSRS + hca;
  const favoredIsHome = homeNeutral >= awaySRS;

  const favSRS = favoredIsHome ? homeSRS : awaySRS;
  const undSRS = favoredIsHome ? awaySRS : homeSRS;
  const favAbbr = favoredIsHome ? game.home.abbr : game.away.abbr;
  const undAbbr = favoredIsHome ? game.away.abbr : game.home.abbr;
  const star = deltaStar(game.league, favAbbr, undAbbr);

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

function deltaVol(game, view) {
  const favAbbr = view.favoredIsHome ? game.home.abbr : game.away.abbr;
  const undAbbr = view.favoredIsHome ? game.away.abbr : game.home.abbr;
  const favStats = stats(game.league, favAbbr);
  const undStats = stats(game.league, undAbbr);
  const tog = matchupTOG(favStats, undStats);
  const org = matchupORG(favStats, undStats);
  return (tog * 1.4) + (org * 0.5);
}

// ── Step C · True_Gap → Z → DBP% ────────────────────────────────────────

export function computeBreakdown(game) {
  const c = cfg(game.league);
  const view = favoritedView(game);
  const dvol = deltaVol(game, view);
  const trueGap = view.baseANG + dvol;
  const z = c.intercept + c.multiplier * trueGap;
  const dbp = sigmoid(z) * 100;
  return {
    ...view,
    deltaVol: dvol,
    trueGap,
    z,
    dbp,
    zone: getZone(dbp, game.league),
  };
}

export function computeDBP(game) {
  return computeBreakdown(game).dbp;
}

// Signed home margin (positive = home favored).
export function projectedMargin(game) {
  const b = computeBreakdown(game);
  return b.favoredIsHome ? b.trueGap : -b.trueGap;
}

// ── Over/Under Projection Engine ────────────────────────────────────────

function projectedPossessions(game) {
  const c = cfg(game.league);
  const hStats = stats(game.league, game.home.abbr);
  const aStats = stats(game.league, game.away.abbr);
  const hPace = get(hStats, 'pace', c.paceDefault);
  const aPace = get(aStats, 'pace', c.paceDefault);
  return ((hPace + aPace) / 2) - c.paceDeflate;
}

function combinedOffRating(game) {
  const c = cfg(game.league);
  const hOff = get(stats(game.league, game.home.abbr), 'off', c.offRtgDefault);
  const aOff = get(stats(game.league, game.away.abbr), 'off', c.offRtgDefault);
  let combined = hOff + aOff;
  if (game.modifiers?.restRust) combined *= c.restRustEff;
  return combined;
}

export function projectedTotal(game) {
  const c = cfg(game.league);
  const poss = projectedPossessions(game);
  const combined = combinedOffRating(game);
  let total = (poss * combined) / 100;
  if (game.modifiers?.otHangover) total += c.otHangover;
  return total;
}

// ── Derived picks ───────────────────────────────────────────────────────

// SPREAD PICK: compare model margin to the book's signed home line.
// homeLine is the home team's signed line (e.g. -5.5 = home favored by 5.5).
// "Home covers" when modelMargin + homeLine > 0.
export function spreadPick(game) {
  const { homeLine } = game.odds || {};
  if (homeLine == null) return null;

  const modelMargin = projectedMargin(game);
  const homeEdge = modelMargin + homeLine;

  if (homeEdge >= 0) {
    return { side: game.home.abbr, line: homeLine,  edge: homeEdge };
  }
  return   { side: game.away.abbr, line: -homeLine, edge: -homeEdge };
}

// O/U PICK: compare projected total to the book O/U.
export function ouPick(game) {
  if (game.odds?.total == null) return null;
  const proj = projectedTotal(game);
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
export function predictionInputs(game) {
  const b = computeBreakdown(game);
  return {
    favoredIsHome: b.favoredIsHome,
    favSRS: +b.favSRS.toFixed(2),
    undSRS: +b.undSRS.toFixed(2),
    hca: b.hca,
    deltaStar: b.deltaStar,
    baseANG: +b.baseANG.toFixed(2),
    deltaVol: +b.deltaVol.toFixed(2),
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
