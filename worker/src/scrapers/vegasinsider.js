// VegasInsider line-movement scraper — STUB.
//
// Page: https://www.vegasinsider.com/nba/odds/las-vegas/
// What we want per game:
//   - opening spread + opening total (consensus or specific book)
//   - current spread + current total
//   - direction + magnitude of movement (steam = >= 1pt move in <30min, etc.)
//
// VegasInsider's HTML structure is moderately stable but the page is heavy
// (large tables with sticky headers). Implementation plan:
//
//   1. Fetch the odds page (NBA / WNBA variants).
//   2. Parse the consensus row per game: opener vs current line.
//   3. Diff and emit { gameId, opening: {spread, total}, current: {spread, total}, deltaSpread, deltaTotal }.
//
// For now we return an empty payload so the frontend renders gracefully.

export async function scrapeLineMovement(_league, _env) {
  return {
    source: 'vegasinsider.stub',
    fetchedAt: new Date().toISOString(),
    note: 'Line movement parsing not implemented yet — fill in vegasinsider.js',
    games: [],
  };
}
