import { useMemo, useState } from 'react';
import Sparkline from './Sparkline.jsx';

// Each window returns a date-range filter (start/end timestamps). "Yesterday"
// snaps to the calendar day before today; the rolling windows include today.
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

const WINDOWS = [
  {
    key: 'y',
    label: 'Yesterday',
    range: () => {
      const today = startOfDay(new Date());
      return { start: today - 86_400_000, end: today };
    },
  },
  {
    key: '10d',
    label: 'Last 10 days',
    range: () => ({ start: startOfDay(new Date()) - 9 * 86_400_000, end: Date.now() }),
  },
  {
    key: 'm',
    label: 'Last month',
    range: () => ({ start: startOfDay(new Date()) - 29 * 86_400_000, end: Date.now() }),
  },
  {
    key: '3m',
    label: 'Last 3 months',
    range: () => ({ start: startOfDay(new Date()) - 89 * 86_400_000, end: Date.now() }),
  },
  {
    key: 'all',
    label: 'All time',
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

      <LeagueChart league="nba"  rows={inWindow} />
      <LeagueChart league="wnba" rows={inWindow} />
    </div>
  );
}

function LeagueChart({ league, rows }) {
  const threshold = blowoutThreshold(league);

  // Two populations:
  //   gamesAll    — every game in this league + window, used for actual outcomes
  //                 (includes ungraded — we know if it was a blowout regardless
  //                 of whether the model made a pregame call).
  //   gamesGraded — only games where a pregame prediction was locked, used for
  //                 anything that requires the model's DBP%.
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

  const series = useMemo(
    () => buildDailySeries({ gamesGraded, gamesAll, threshold }),
    [gamesGraded, gamesAll, threshold]
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

// Build two daily series from different populations:
//   dbp    — avg DBP% per day from gamesGraded
//   actual — actual blowout % per day from gamesAll (ungraded included)
// They share an X axis but may not have the same set of days (a day with
// only ungraded games has an actual point but no DBP point).
function buildDailySeries({ gamesGraded, gamesAll, threshold }) {
  return {
    dbp:    daily(gamesGraded, (list) => list.reduce((s, r) => s + (r.dbp || 0), 0) / list.length),
    actual: daily(gamesAll,    (list) => (list.filter((r) => (r.margin || 0) >= threshold).length / list.length) * 100),
  };
}

function daily(games, reducer) {
  const byDay = new Map();
  for (const g of games) {
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t)) continue;
    const day = Math.floor(t / 86400000);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(g);
  }
  const points = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    points.push({ x: day, y: reducer(byDay.get(day)) });
  }
  return points;
}
