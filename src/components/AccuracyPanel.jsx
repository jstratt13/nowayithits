import { useMemo, useState } from 'react';
import Sparkline from './Sparkline.jsx';

// Each window returns a date-range filter (start/end timestamps). "Yesterday"
// snaps to the calendar day before today; the rolling windows include today.
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

// `lookback` is the rolling-average window (in days) applied to each point
// on the chart. `null` means cumulative — every game from the start of
// recorded history through that day.
const WINDOWS = [
  {
    key: 'y',
    label: 'Yesterday',
    lookback: 1,
    range: () => {
      const today = startOfDay(new Date());
      return { start: today - 86_400_000, end: today };
    },
  },
  {
    key: '10d',
    label: 'Last 10 days',
    lookback: 10,
    range: () => ({ start: startOfDay(new Date()) - 9 * 86_400_000, end: Date.now() }),
  },
  {
    key: 'm',
    label: 'Last month',
    lookback: 30,
    range: () => ({ start: startOfDay(new Date()) - 29 * 86_400_000, end: Date.now() }),
  },
  {
    key: '3m',
    label: 'Last 3 months',
    lookback: 90,
    range: () => ({ start: startOfDay(new Date()) - 89 * 86_400_000, end: Date.now() }),
  },
  {
    key: 'all',
    label: 'All time',
    lookback: null,
    range: () => ({ start: null, end: null }),
  },
];

// League-specific blowout thresholds (margin >= threshold counts as a blowout).
const BLOWOUT_MARGIN = { nba: 16, wnba: 14 };
const blowoutThreshold = (league) => BLOWOUT_MARGIN[league] ?? 15;

export default function AccuracyPanel({ rows }) {
  const [windowKey, setWindowKey] = useState('m');
  const win = WINDOWS.find((w) => w.key === windowKey) || WINDOWS[0];

  const inWindow = useMemo(() => {
    const { start, end } = win.range();
    if (start == null && end == null) return rows;
    return rows.filter((r) => {
      const t = new Date(r.date).getTime();
      if (!Number.isFinite(t)) return false;
      if (start != null && t < start) return false;
      if (end != null && t >= end) return false;
      return true;
    });
  }, [rows, win]);

  return (
    <div className="panel accuracy-panel">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">Model accuracy</div>
          <div className="panel-title">Predicted vs. actual blowouts</div>
        </div>
        <select
          className="window-select"
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value)}
          aria-label="Time window"
        >
          {WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>{w.label}</option>
          ))}
        </select>
      </div>

      <LeagueChart league="nba"  rows={inWindow} allRows={rows} windowKey={windowKey} />
      <LeagueChart league="wnba" rows={inWindow} allRows={rows} windowKey={windowKey} />
    </div>
  );
}

function LeagueChart({ league, rows, allRows, windowKey }) {
  const threshold = blowoutThreshold(league);

  // Window-scoped sets — used for the metric cards (avg DBP, actual blowout %)
  const gamesAll = rows.filter((r) => (r.league || 'nba') === league);
  const gamesGraded = gamesAll.filter((r) => r.graded !== false);
  const nAll = gamesAll.length;
  const nGraded = gamesGraded.length;
  const nUngraded = nAll - nGraded;

  const avgDBP = nGraded
    ? +(gamesGraded.reduce((s, r) => s + (r.dbp || 0), 0) / nGraded).toFixed(1)
    : null;
  const blowoutCount = gamesAll.filter((r) => (r.margin || 0) >= threshold).length;
  const blowoutPct = nAll ? Math.round((blowoutCount / nAll) * 100) : null;

  // Chart series — rolling average over time, not per-day snapshots.
  // Uses the ENTIRE league dataset (not just the window) for the rolling
  // lookback population. The X-axis still covers the window's days; each
  // point shows the rolling avg ending on that day. Lookback duration
  // matches the selected window:
  //   Yesterday    → 1-day rolling   (essentially the day itself)
  //   Last 10 days → 10-day rolling
  //   Last month   → 30-day rolling
  //   Last 3 months → 90-day rolling
  //   All time     → cumulative running average (no lower bound)
  const leagueAllRows = allRows.filter((r) => (r.league || 'nba') === league);
  const winCfg = WINDOWS.find((w) => w.key === windowKey) || WINDOWS[0];
  const lookbackDays = winCfg.lookback;

  const series = useMemo(
    () => buildRollingSeries({
      windowGames: gamesAll,
      allLeagueGames: leagueAllRows,
      lookbackDays,
      threshold,
    }),
    [gamesAll, leagueAllRows, lookbackDays, threshold]
  );
  const delta = avgDBP != null && blowoutPct != null
    ? Math.round((blowoutPct - avgDBP) * 10) / 10
    : null;

  return (
    <div className="league-chart">
      <div className="league-chart-head">
        <span className="league-chart-name">{league.toUpperCase()}</span>
        <span className="league-chart-count">
          {nAll} game{nAll === 1 ? '' : 's'}
          {nUngraded > 0 && ` · ${nGraded} graded`}
          {' · blowout ≥ '}{threshold}
        </span>
      </div>

      <div className="league-chart-metrics">
        <Metric label={`Avg DBP%${nUngraded ? ' (graded)' : ''}`} value={avgDBP != null ? `${avgDBP}%` : '—'} color="var(--base)" />
        <Metric label="Actual blowout %" value={blowoutPct != null ? `${blowoutPct}%` : '—'} color="var(--alert)" />
        <Metric
          label="Δ (actual − model)"
          value={delta != null ? (delta >= 0 ? `+${delta}` : `${delta}`) : '—'}
          color={delta == null ? 'var(--muted)' : delta >= 0 ? 'var(--hit)' : 'var(--miss)'}
          mono
        />
      </div>

      {nAll === 0 ? (
        <div className="chart-empty">No {league.toUpperCase()} games in this window</div>
      ) : (
        <>
          <Sparkline
            ariaLabel={`${league.toUpperCase()} predicted vs actual blowout rate`}
            yMax={windowKey === 'y' ? 100 : 70}
            series={[
              { label: 'Avg DBP%',     color: 'var(--base)',  points: series.dbp },
              { label: 'Blowout rate', color: 'var(--alert)', points: series.actual, dashed: true },
            ]}
          />
          <div className="chart-legend">
            <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--base)' }} />Model DBP%</span>
            <span className="legend-item"><span className="legend-swatch legend-dashed" style={{ borderColor: 'var(--alert)' }} />Actual blowout %</span>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, color, mono }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={'metric-value' + (mono ? ' mono' : '')} style={{ color }}>{value}</span>
    </div>
  );
}

// Rolling-average series. For each unique game-day in the chart's window,
// compute the average DBP% and actual blowout % across the lookback period
// ending on that day.
//
//   lookbackDays = 90  → 3-month rolling average (used for finite windows)
//   lookbackDays = null → cumulative running average (used for "All time")
//
// Two passes:
//   dbp series  — uses only graded games (need a model DBP to average)
//   actual series — uses all games (margin is known regardless of grading)
function buildRollingSeries({ windowGames, allLeagueGames, lookbackDays, threshold }) {
  // Unique day buckets present in the visible window
  const days = new Set();
  for (const g of windowGames) {
    const t = new Date(g.date).getTime();
    if (Number.isFinite(t)) days.add(Math.floor(t / 86400000));
  }
  const sortedDays = [...days].sort((a, b) => a - b);

  // Pre-bucket the full league dataset once for performance.
  const gradedByDay = [];
  const allByDay = [];
  for (const g of allLeagueGames) {
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    const day = Math.floor(t / 86400000);
    allByDay.push({ day, game: g });
    if (g.graded !== false) gradedByDay.push({ day, game: g });
  }

  const dbp = [];
  const actual = [];
  for (const day of sortedDays) {
    const start = lookbackDays == null ? -Infinity : day - lookbackDays;
    const end = day; // inclusive

    // Rolling DBP average across graded games in window [start, end]
    const dbpPool = gradedByDay.filter((x) => x.day >= start && x.day <= end);
    if (dbpPool.length) {
      const avg = dbpPool.reduce((s, x) => s + (x.game.dbp || 0), 0) / dbpPool.length;
      dbp.push({ x: day, y: avg });
    }

    // Rolling actual blowout % across all games (graded + ungraded)
    const actualPool = allByDay.filter((x) => x.day >= start && x.day <= end);
    if (actualPool.length) {
      const blows = actualPool.filter((x) => (x.game.margin || 0) >= threshold).length;
      actual.push({ x: day, y: (blows / actualPool.length) * 100 });
    }
  }
  return { dbp, actual };
}
