// ─────────────────────────────────────────────────────────────────────────
//  Season phase for tracker rows — preseason games are kept in the table
//  but excluded from every hit-rate / accuracy stat (11/20/26).
//
//  Rows synced from now on carry ESPN's `seasonType` (1 = preseason,
//  2 = regular season, 3 = playoffs). Older rows don't, so NBA falls back
//  to the calendar: anything between Sep 25 and the regular-season opener
//  is preseason. WNBA has no date fallback (opener varies; only 11 rows) —
//  it relies on seasonType.
// ─────────────────────────────────────────────────────────────────────────

const NBA_OPENERS = {
  2024: '2024-10-22',
  2025: '2025-10-21',
  2026: '2026-10-20',
};
const NBA_DEFAULT_OPENER_MMDD = '10-20';

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isPreseasonRow(row) {
  if (!row) return false;
  if (row.seasonType != null) return Number(row.seasonType) === 1;
  if ((row.league || 'nba') !== 'nba') return false;
  const d = new Date(row.date);
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getFullYear();
  const day = ymd(d);
  const opener = NBA_OPENERS[y] || `${y}-${NBA_DEFAULT_OPENER_MMDD}`;
  return day >= `${y}-09-25` && day < opener;
}

export const notPreseason = (row) => !isPreseasonRow(row);
