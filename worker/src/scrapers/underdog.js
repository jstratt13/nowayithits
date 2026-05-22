// Underdog NBA breaking-news wire scraper — STUB.
//
// Underdog Fantasy's NBA Twitter feed (@Underdog__NBA) is the cleanest
// late-scratch signal. Two implementation paths once we wire this up:
//
//  1. Twitter / X public scraping is locked down — most public scrapers
//     (nitter mirrors, syndication.twitter.com) get rate-limited fast.
//     Most reliable path is the official X API with a Basic tier key
//     ($100/mo) → cheap but not free.
//  2. Underdog also surfaces breaking news on their site at
//     https://underdogfantasy.com/lobby (requires browser-like fetch);
//     we'd need to find the underlying JSON feed.
//
// For now this returns an empty wire so the frontend can render. Fill in
// when the data source decision is made (free vs paid X API tier).

export async function scrapeUnderdogWire(_env) {
  return {
    source: 'underdog.stub',
    fetchedAt: new Date().toISOString(),
    note: 'Underdog wire not implemented yet — pick an upstream + fill underdog.js',
    items: [],
  };
}
