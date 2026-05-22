// Official NBA injury report scraper — STUB.
//
// The league publishes a PDF on the hour at:
//   https://official.nba.com/nba-injury-report/
// The actual file lives at a URL like:
//   https://ak-static.cms.nba.com/referee/injury/Injury-Report_YYYY-MM-DD_HHPM.pdf
//
// Parsing a PDF inside a Cloudflare Worker is non-trivial — Workers can't
// run unpdf / pdf-parse out of the box, and a heavyweight WASM PDF parser
// will bust the script size limit. Two realistic options to fill this in
// later:
//
//  1. Use `unpdf` (https://github.com/unjs/unpdf) compiled to ESM. Works
//     in Workers and stays under the size cap as long as we only ship the
//     text-extraction module, not the full PDFKit.
//  2. Defer PDF parsing to a separate small service (Worker → R2 fetch
//     PDF → fan out to a one-shot Lambda / Cloud Run job for parsing).
//
// For now this returns an empty list with `source: stub` so the frontend
// can render gracefully while we lean on Rotowire as the primary source.

export async function scrapeOfficialInjuries(_env) {
  return {
    source: 'nba-official.stub',
    fetchedAt: new Date().toISOString(),
    note: 'PDF parsing not implemented yet — fill in nbaOfficial.js',
    players: [],
  };
}
