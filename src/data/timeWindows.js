// Time-window definitions shared by Tracker + AccuracyPanel so the two
// surfaces always offer the same filter set. Static windows (week / month /
// 3mo / all) live here; season windows are derived from the actual rows
// because we only want to offer seasons the user has data for.
//
// Range convention: inclusive start, exclusive end (consistent with
// AccuracyPanel's original implementation). A `start/end` of null means
// "no bound on that side."

const DAY = 86_400_000;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

// Rolling / static windows. `lookback` is the rolling-average window (in
// days) applied to each point on the chart; null means cumulative.
export const STATIC_WINDOWS = [
  {
    key: 'y',
    label: 'Yesterday',
    lookback: 1,
    range: () => {
      const today = startOfDay(new Date());
      return { start: today - DAY, end: today };
    },
  },
  {
    key: 'w',
    label: 'Last week',
    lookback: 7,
    range: () => ({ start: startOfDay(new Date()) - 6 * DAY, end: Date.now() }),
  },
  {
    key: '10d',
    label: 'Last 10 days',
    lookback: 10,
    range: () => ({ start: startOfDay(new Date()) - 9 * DAY, end: Date.now() }),
  },
  {
    key: 'm',
    label: 'Last month',
    lookback: 30,
    range: () => ({ start: startOfDay(new Date()) - 29 * DAY, end: Date.now() }),
  },
  {
    key: '3m',
    label: 'Last 3 months',
    lookback: 90,
    range: () => ({ start: startOfDay(new Date()) - 89 * DAY, end: Date.now() }),
  },
  {
    key: 'all',
    label: 'All time',
    lookback: null,
    range: () => ({ start: null, end: null }),
  },
];

// Season bucketing
//   NBA season: starts Aug 1 of year Y, ends Jul 31 of year Y+1. Key "Y-YY".
//     Oct 2026 → "2026-27";  Apr 2027 → "2026-27"
//   WNBA season: single calendar year. Key "Y".
//     Jul 2026 → "2026"
//
// Choice of Aug 1 / Jul 31 as the NBA cutover: offseason sits inside the
// prior season label so any lingering playoff-adjacent news or late lock
// rows don't jump the next season too early.
function nbaSeasonKeyForDate(dateLike) {
  const t = new Date(dateLike);
  const y = t.getFullYear();
  const m = t.getMonth() + 1; // 1-12
  if (m >= 8) return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  return `${y - 1}-${String(y % 100).padStart(2, '0')}`;
}

function wnbaSeasonKeyForDate(dateLike) {
  return String(new Date(dateLike).getFullYear());
}

export function seasonKeyForRow(row) {
  const league = row.league || 'nba';
  return league === 'wnba'
    ? wnbaSeasonKeyForDate(row.date)
    : nbaSeasonKeyForDate(row.date);
}

function nbaSeasonRange(key) {
  const startYear = Number(key.slice(0, 4));
  return {
    start: Date.UTC(startYear, 7, 1),              // Aug 1 of start year
    end:   Date.UTC(startYear + 1, 7, 1),          // Aug 1 of next year (exclusive)
  };
}

function wnbaSeasonRange(key) {
  const year = Number(key);
  return {
    start: Date.UTC(year, 0, 1),                   // Jan 1
    end:   Date.UTC(year + 1, 0, 1),               // Jan 1 next year (exclusive)
  };
}

export function seasonRange(key, league) {
  return league === 'wnba' ? wnbaSeasonRange(key) : nbaSeasonRange(key);
}

export function seasonLabel(key, league) {
  return league === 'wnba' ? `WNBA ${key}` : `NBA ${key}`;
}

// Build season-window options from the rows the user actually has. Returns
// most-recent-first so the dropdown reads naturally.
export function seasonWindowsFromRows(rows, league) {
  const keys = new Set();
  for (const r of rows) {
    if ((r.league || 'nba') !== league) continue;
    keys.add(seasonKeyForRow(r));
  }
  const sorted = [...keys].sort().reverse();
  return sorted.map((key) => ({
    key: `season:${league}:${key}`,
    label: seasonLabel(key, league),
    // A season is a fixed range, so "rolling average" inside it is
    // cumulative from the season's start (same semantics as "All time"
    // scoped to the season).
    lookback: null,
    range: () => seasonRange(key, league),
    seasonKey: key,
    seasonLeague: league,
  }));
}

// Convenience: full window set combining static + per-league seasons
// derived from the given rows. Static windows first, then each league's
// seasons grouped together.
export function allWindowsFromRows(rows) {
  const nbaSeasons = seasonWindowsFromRows(rows, 'nba');
  const wnbaSeasons = seasonWindowsFromRows(rows, 'wnba');
  return [...STATIC_WINDOWS, ...nbaSeasons, ...wnbaSeasons];
}

// Apply a window's range to a list of rows. Used by both surfaces.
export function filterRowsByWindow(rows, win) {
  const { start, end } = win.range();
  if (start == null && end == null) return rows;
  return rows.filter((r) => {
    const t = new Date(r.date).getTime();
    if (!Number.isFinite(t)) return false;
    if (start != null && t < start) return false;
    if (end != null && t >= end) return false;
    return true;
  });
}
