import { useMemo, useState } from 'react';
import Sparkline from './Sparkline.jsx';
import { STATIC_WINDOWS, allWindowsFromRows, filterRowsByWindow } from '../data/timeWindows.js';

// League-specific blowout thresholds (margin >= threshold counts as a blowout).
const BLOWOUT_MARGIN = { nba: 16, wnba: 14 };
const blowoutThreshold = (league) => BLOWOUT_MARGIN[league] ?? 15;

export default function AccuracyPanel({ rows }) {
  const [windowKey, setWindowKey] = useState('m');

  // Window set = static rolling windows + per-league seasons derived from
  // the rows present. Re-memo'd when rows change so a newly-synced game
  // from a brand-new season adds its season option without a reload.
  const windows = useMemo(() => allWindowsFromRows(rows), [rows]);
  const win = windows.find((w) => w.key === windowKey) || windows[0] || STATIC_WINDOWS[0];

  const inWindow = useMemo(() => filterRowsByWindow(rows, win), [rows, win]);

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
          <optgroup label="Rolling">
            {windows.filter((w) => !w.key.startsWith('season:')).map((w) => (
              <option key={w.key} value={w.key}>{w.label}</option>
            ))}
          </optgroup>
          {windows.some((w) => w.key.startsWith('season:nba:')) && (
            <optgroup label="NBA seasons">
              {windows.filter((w) => w.key.startsWith('season:nba:')).map((w) => (
                <option key={w.key} value={w.key}>{w.label}</option>
              ))}
            </optgroup>
          )}
          {windows.some((w) => w.key.startsWith('season:wnba:')) && (
            <optgroup label="WNBA seasons">
              {windows.filter((w) => w.key.startsWith('season:wnba:')).map((w) => (
                <option key={w.key} value={w.key}>{w.label}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <LeagueChart league="nba"  rows={inWindow} allRows={rows} win={win} />
      <LeagueChart league="wnba" rows={inWindow} allRows={rows} win={win} />
    </div>
  );
}

function LeagueChart({ league, rows, allRows, win }) {
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
  // matches the selected window (null = cumulative, used by All-time and
  // season windows).
  const leagueAllRows = allRows.filter((r) => (r.league || 'nba') === league);
  const lookbackDays = win.lookback;

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
            yMax={win.key === 'y' ? 100 : 70}
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
