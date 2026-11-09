// ─────────────────────────────────────────────────────────────────────────
//  Pick grading — ONE source of truth for both:
//    • the client-side tracker reconciler (src/data/trackerSync.js)
//    • the server-side export endpoint (worker /tracker/graded)
//  so the two can never drift on how a Hit/Miss is decided.
//
//  `away` / `home` are objects carrying at least { abbr, score }.
//  Push (exactly on the number) is graded as 'Miss', matching the tracker's
//  long-standing convention. Returns null when inputs are missing.
// ─────────────────────────────────────────────────────────────────────────

// SPREAD: sp = { side, line } where `line` is the signed line FOR the picked
// side (e.g. "home -4.5" → side=home, line=-4.5). The side covers when its
// margin plus its line is positive.
export function gradeSpread(sp, away, home) {
  if (!sp || sp.line == null) return null;
  if (away?.score == null || home?.score == null) return null;
  const pickedScore = sp.side === home.abbr ? home.score : away.score;
  const oppScore    = sp.side === home.abbr ? away.score : home.score;
  const cover = (pickedScore - oppScore) + sp.line;
  return cover > 0 ? 'Hit' : 'Miss';
}

// O/U: ou = { direction: 'OVER' | 'UNDER', line }.
export function gradeOU(ou, away, home) {
  if (!ou || ou.line == null) return null;
  if (away?.score == null || home?.score == null) return null;
  const total = away.score + home.score;
  if (ou.direction === 'OVER')  return total > ou.line ? 'Hit' : 'Miss';
  if (ou.direction === 'UNDER') return total < ou.line ? 'Hit' : 'Miss';
  return null;
}
