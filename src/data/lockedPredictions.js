// ─────────────────────────────────────────────────────────────────────────
//  Legacy locked-prediction reader.
//
//  Historical context: before the server-side prediction pipeline existed,
//  every browser computed predictions locally and froze a snapshot into
//  dbp-locked-preds-v1 localStorage at tipoff. Those entries are now
//  read-only history — the worker is the authority for new locks, and
//  the GameCard render path doesn't write here anymore.
//
//  This file still exists for one reason: the tracker reconciler falls
//  back to legacy localStorage snapshots when grading games from BEFORE
//  the worker started writing locks (Step 2 deploy = 5/23/26). Those
//  entries gradually age out as the 30-day sync window rolls forward.
//
//  The integrity rule that originally lived here (no writes post-tipoff)
//  is now enforced server-side in worker/src/predictions.js mergeGame().
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'dbp-locked-preds-v1';

export function getLocked(gameId) {
  if (!gameId) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[gameId] || null;
  } catch {
    return null;
  }
}
