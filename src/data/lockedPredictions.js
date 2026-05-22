// Once a game tips off, ESPN drops the live odds object — which would
// blank out the spread/total picks the model already made. To prevent
// that, we snapshot each game's full pregame prediction the LAST time
// we saw it with odds available, then read the snapshot back for live
// and final cards.
//
// INTEGRITY RULES — read before changing this file
//
//   1. Snapshots may ONLY be written while game.state === 'pre'.
//      Never write or modify a snapshot for a game that has tipped off,
//      gone final, or whose outcome is known. Doing so would let the
//      model retroactively look smarter than it was, destroying the
//      whole point of accuracy tracking.
//
//   2. During pregame the snapshot may update with each line move so
//      we capture the closing line + closing model output. That's
//      conventional sportsbook semantics, not revisionism.
//
//   3. Snapshots are immutable once a game leaves pregame. The Tracker
//      and AccuracyPanel compare these locked predictions to the
//      actual final score — if we tampered with #1 above, the hit-rate
//      stats would be a lie.
//
// Snapshots are keyed by ESPN's event id and live in localStorage so they
// persist across reloads.

const STORAGE_KEY = 'dbp-locked-preds-v1';

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / availability — drop silently */
  }
}

export function getLocked(gameId) {
  if (!gameId) return null;
  const all = readAll();
  return all[gameId] || null;
}

// Persist the pregame snapshot. Requires gameState so we can enforce
// integrity rule #1 at the data layer — refuses to write if the game has
// already tipped off, regardless of what the caller passes in.
export function setLocked(gameId, snapshot, gameState) {
  if (!gameId) return;
  if (gameState && gameState !== 'pre') {
    if (typeof console !== 'undefined') {
      console.warn(`[dbp] refused to lock snapshot for ${gameId} — state=${gameState}`);
    }
    return;
  }
  const all = readAll();
  all[gameId] = { ...snapshot, savedAt: Date.now() };
  writeAll(all);
}

// True if the game's odds payload has enough info to compute picks.
export function hasUsableOdds(game) {
  const o = game?.odds;
  return !!o && o.homeLine != null && o.total != null;
}
