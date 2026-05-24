// ─────────────────────────────────────────────────────────────────────────
//  Frontend wrapper around formulaCore.
//
//  formulaCore.js holds the pure Blowy 5.2 math — environment-agnostic so
//  the Cloudflare Worker can run it too. This file wires the core to the
//  browser's live-stats store (liveStats.js) and re-exports the same API
//  the rest of the frontend already uses, so callers don't change.
//
//  If you're tuning the model, edit MODEL_CONFIG inside formulaCore.js.
// ─────────────────────────────────────────────────────────────────────────

import * as core from './formulaCore.js';
import { getActiveTeamStats, getInjuryScore } from './liveStats.js';

// Bind the lookup callbacks once. The core math reads stats / injury scores
// exclusively through this ctx — no module-level state leaks across calls.
const ctx = {
  getTeamStats:   getActiveTeamStats,
  getInjuryScore,
};

// ── Pure re-exports (no ctx needed) ────────────────────────────────────

export const getZone           = core.getZone;
export const fmtLine           = core.fmtLine;
export const BLOWOUT_THRESHOLD = core.BLOWOUT_THRESHOLD;
export const zoneLabels        = core.zoneLabels;

// ── ctx-bound re-exports ───────────────────────────────────────────────

export const computeBreakdown  = (game) => core.computeBreakdown(game, ctx);
export const computeDBP        = (game) => core.computeDBP(game, ctx);
export const projectedMargin   = (game) => core.projectedMargin(game, ctx);
export const projectedTotal    = (game) => core.projectedTotal(game, ctx);
export const spreadPick        = (game) => core.spreadPick(game, ctx);
export const ouPick            = (game) => core.ouPick(game, ctx);
export const predictionInputs  = (game) => core.predictionInputs(game, ctx);
