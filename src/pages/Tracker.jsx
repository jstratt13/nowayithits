import { useEffect, useMemo, useState } from 'react';
import { SEED_TRACKER } from '../data/seedTracker.js';
import AccuracyPanel from '../components/AccuracyPanel.jsx';
import { useLiveStats } from '../hooks/useLiveStats.js';
import { useSyncStatus } from '../hooks/useTrackerSync.js';
import { BLOWOUT_THRESHOLD, zoneLabels } from '../data/formulaCore.js';
import NewsPanel from '../components/NewsPanel.jsx';

const STORAGE_KEY = 'dbp-tracker-v1';

// A row "was a blowout" purely on margin — independent of what the model
// predicted. NBA ≥ 16, WNBA ≥ 14 per the configured thresholds.
function wasBlowout(row) {
  const t = BLOWOUT_THRESHOLD[row.league || 'nba'] ?? 15;
  return (row.margin || 0) >= t;
}

// Ungraded = a row that has actual-outcome data but no locked prediction.
// Pre-existing seed rows (no `graded` field) are treated as graded.
const isGraded = (r) => r.graded !== false;

const ZONE_BADGE = {
  'Safe Zone':    'badge-zone-safe',
  'Baseline':     'badge-zone-base',
  'High Alert':   'badge-zone-alert',
  'Lock':         'badge-zone-lock',
  'Super Lock':   'badge-zone-super',
  // Quiet back-compat for any rows persisted under the old NBA label.
  'Max Expulsion':'badge-zone-super',
};

const RESULTS = ['All', 'Hit', 'Miss'];
const BLOWOUT_FILTER_VALUES = ['All', 'Yes', 'No'];
const LEAGUES = ['nba', 'wnba'];

// Zone filter chips switch per league — NBA tops out at "Max Expulsion",
// WNBA at "Super Lock". Always prefixed with "All".
function zonesForLeague(league) {
  return ['All', ...zoneLabels(league)];
}

function loadRows() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrateRows(JSON.parse(raw));
  } catch { /* ignore */ }
  return migrateRows(SEED_TRACKER);
}

// One-time data migration for label changes that don't affect the
// underlying prediction — currently just retiring "Max Expulsion" in
// favor of the unified Lock 55–75% / Super Lock >75% NBA boundaries.
function migrateRows(rows) {
  return rows.map((r) => {
    if (r.zone === 'Max Expulsion') {
      const newZone = (r.dbp ?? 0) >= 70 ? 'Super Lock' : 'Lock';
      return { ...r, zone: newZone };
    }
    return r;
  });
}

function saveRows(rows) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); }
  catch { /* ignore */ }
}

function dbpColor(v) {
  if (v >= 55) return '#b91c1c';
  if (v >= 45) return '#c2410c';
  if (v >= 25) return '#1d4ed8';
  return '#15803d';
}

export default function Tracker() {
  useLiveStats(['nba', 'wnba'], { withInjuries: false });
  const sync = useSyncStatus();
  const [rows, setRows] = useState(loadRows);

  // After each sync completes, re-read rows from localStorage so any
  // newly-graded games show up without a manual refresh.
  useEffect(() => {
    if (sync.lastSyncAt) setRows(loadRows());
  }, [sync.lastSyncAt]);
  const [league, setLeague] = useState('nba');
  const [zone, setZone] = useState('All');

  // The zone chip set depends on which league is active — NBA shows
  // "Max Expulsion", WNBA shows "Super Lock". Memoize so switching leagues
  // also resets a stale zone filter that no longer exists in the new set.
  const zoneChoices = useMemo(() => zonesForLeague(league), [league]);
  useEffect(() => {
    if (zone !== 'All' && !zoneChoices.includes(zone)) setZone('All');
  }, [zoneChoices, zone]);
  const [spreadF, setSpreadF] = useState('All');
  const [ouF, setOuF] = useState('All');
  const [blowoutF, setBlowoutF] = useState('All');
  const [search, setSearch] = useState('');
  const [groupByDate, setGroupByDate] = useState(false);
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState(-1);

  useEffect(() => { saveRows(rows); }, [rows]);

  const filtered = useMemo(() => {
    let d = rows.filter((r) => (r.league || 'nba') === league);
    if (zone !== 'All') d = d.filter((r) => r.zone === zone);
    if (spreadF !== 'All') d = d.filter((r) => r.spreadResult === spreadF);
    if (ouF !== 'All') d = d.filter((r) => r.ouResult === ouF);
    if (blowoutF !== 'All') {
      d = d.filter((r) => blowoutF === 'Yes' ? wasBlowout(r) : !wasBlowout(r));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      d = d.filter((r) => [r.matchup, r.posSRS, r.spreadPick, r.ouPick, r.zone, r.blowout]
        .some((v) => v && v.toLowerCase().includes(q)));
    }
    d.sort((a, b) => {
      let av = a[sortKey] ?? -Infinity;
      let bv = b[sortKey] ?? -Infinity;
      if (sortKey === 'date') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
    return d;
  }, [rows, league, zone, spreadF, ouF, blowoutF, search, sortKey, sortDir]);

  const stats = useMemo(() => {
    const n = filtered.length;
    if (!n) return { n: 0 };

    // Spread + O/U hit-rates are model-accuracy stats — they only make
    // sense on rows where the model made a pregame call. Ungraded games
    // are excluded from numerator + denominator to avoid biasing.
    const graded = filtered.filter(isGraded);
    const gradedN = graded.length;
    const sH = graded.filter((r) => r.spreadResult === 'Hit').length;
    const oH = graded.filter((r) => r.ouResult === 'Hit').length;
    const ungradedN = n - gradedN;

    // Blowout % is a pure outcome stat now — what fraction of games
    // actually ended as blowouts. Counted across ALL filtered games
    // (graded or not) since the actual margin is known regardless.
    // Paired visually with Avg DBP so the model's predicted blowout
    // rate sits next to the realized blowout rate.
    const blowN = filtered.filter(wasBlowout).length;

    // 1-decimal precision — e.g. 64.1% instead of 64%
    const pct = (num, den) => den ? Math.round((num / den) * 1000) / 10 : null;

    return {
      n,
      gradedN,
      ungradedN,
      spreadPct: pct(sH, gradedN),
      ouPct: pct(oH, gradedN),
      blowPct: pct(blowN, n),
      sH, oH, blowN,
      // Margin + total are always populated, even on ungraded rows.
      avgMargin: (filtered.reduce((s, r) => s + (r.margin || 0), 0) / n).toFixed(1),
      avgTotal: (filtered.reduce((s, r) => s + (r.total || 0), 0) / n).toFixed(1),
      // DBP is only on graded rows.
      avgDBP: gradedN
        ? (graded.reduce((s, r) => s + (r.dbp || 0), 0) / gradedN).toFixed(1)
        : null,
    };
  }, [filtered]);

  const grouped = useMemo(() => {
    if (!groupByDate) return { '': filtered };
    const g = {};
    filtered.forEach((r) => { (g[r.date] = g[r.date] || []).push(r); });
    return g;
  }, [filtered, groupByDate]);

  const handleSort = (k) => {
    if (sortKey === k) setSortDir((d) => -d);
    else { setSortKey(k); setSortDir(-1); }
  };

  return (
    <div className="page-with-sidebar">
      <div className="page-main">
      <div className="section-head">
        <div className="section-title">
          <h2>Model performance tracker</h2>
        </div>
        <div className="section-meta">
          <SyncBadge sync={sync} />
          <span style={{ marginLeft: '0.85em' }}>
            {filtered.length} of {rows.length} games
          </span>
        </div>
      </div>

      <div className="tracker-top">
        <AccuracyPanel rows={rows} />

        <div className="panel perf-panel">
          <div className="panel-head">
            <div>
              <div className="panel-eyebrow">Model performance</div>
              <div className="panel-title">Hit rates · current filters</div>
            </div>
          </div>
          <div className="stat-bar">
            <StatCell
              l="Games"
              v={stats.n || '—'}
              sub={stats.ungradedN ? `${stats.gradedN} graded · ${stats.ungradedN} ungraded` : ''}
            />
            <StatCell
              l="Spread hit %"
              v={stats.spreadPct == null ? '—' : `${stats.spreadPct.toFixed(1)}%`}
              sub={stats.gradedN ? `${stats.sH}/${stats.gradedN}` : ''}
              color={stats.spreadPct == null ? 'var(--muted)' : stats.spreadPct >= 50 ? 'var(--hit)' : 'var(--miss)'}
            />
            <StatCell
              l="O/U hit %"
              v={stats.ouPct == null ? '—' : `${stats.ouPct.toFixed(1)}%`}
              sub={stats.gradedN ? `${stats.oH}/${stats.gradedN}` : ''}
              color={stats.ouPct == null ? 'var(--muted)' : stats.ouPct >= 50 ? 'var(--hit)' : 'var(--miss)'}
            />
            <StatCell l="Avg margin" v={stats.n ? `+${stats.avgMargin}` : '—'} />
            <StatCell l="Avg total" v={stats.n ? stats.avgTotal : '—'} />
            <StatCell l="Avg DBP" v={stats.avgDBP == null ? '—' : `${stats.avgDBP}%`} color="var(--accent2)" />
            <StatCell
              l="Blowout %"
              v={stats.blowPct == null ? '—' : `${stats.blowPct.toFixed(1)}%`}
              sub={stats.n ? `${stats.blowN}/${stats.n}` : ''}
              color="var(--accent2)"
            />
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <FilterGroup label="League" values={LEAGUES} active={league} onClick={setLeague} labelFor={(v) => v.toUpperCase()} />
        <FilterGroup label="Zone"   values={zoneChoices}   active={zone}   onClick={setZone} />
        <FilterGroup label="Spread" values={RESULTS} active={spreadF} onClick={setSpreadF} />
        <FilterGroup label="O/U"    values={RESULTS} active={ouF}     onClick={setOuF} />
        <FilterGroup label="Blowout" values={BLOWOUT_FILTER_VALUES} active={blowoutF} onClick={setBlowoutF} />

        <input
          className="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search matchup, team, pick…"
        />

        <button
          type="button"
          className={'filter-chip' + (groupByDate ? ' active' : '')}
          onClick={() => setGroupByDate((v) => !v)}
        >
          Group by date
        </button>
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table className="tracker">
            <thead>
              <tr>
                <TH k="date"         label="Date"   onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="league"       label="Lg"     onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="matchup"      label="Matchup" onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="awayScore"    label="Final"  onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="zone"         label="Zone"   onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="dbp"          label="DBP%"   onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="spreadPick"   label="Spread" onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="ouPick"       label="O/U"    onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="spreadResult" label="Sp Res" onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="ouResult"     label="OU Res" onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="blowout"      label="Blowout" onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="margin"       label="Margin" right onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
                <TH k="total"        label="Total"  right onClick={handleSort} sortKey={sortKey} sortDir={sortDir} />
              </tr>
            </thead>
            <tbody>
              {Object.entries(grouped).map(([gKey, gRows]) => {
                const gn = gRows.length;
                const sH = gRows.filter((r) => r.spreadResult === 'Hit').length;
                const oH = gRows.filter((r) => r.ouResult === 'Hit').length;
                // Blowout % per date — fraction of games that actually
                // ended as blowouts, regardless of model prediction.
                const bN = gRows.filter(wasBlowout).length;

                return (
                  <FragmentRows key={gKey}>
                    {groupByDate && (
                      <tr className="group-head">
                        <td colSpan={13}>
                          ▸ {gKey}
                          <span style={{ marginLeft: 14, color: 'var(--muted2)', letterSpacing: '0.06em' }}>
                            {gn} games · Sp {Math.round(sH/gn*100)}% · OU {Math.round(oH/gn*100)}% · Blow {Math.round(bN/gn*100)}%
                          </span>
                        </td>
                      </tr>
                    )}
                    {gRows.map((r) => <Row key={r.id} r={r} />)}
                  </FragmentRows>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="empty-state" style={{ border: 'none', borderRadius: 0 }}>
            No games match — adjust filters
          </div>
        )}
      </div>
      </div>
      <NewsPanel league={league} />
    </div>
  );
}

function FragmentRows({ children }) {
  return <>{children}</>;
}

function SyncBadge({ sync }) {
  const text = sync.running
    ? 'Syncing…'
    : sync.lastSyncAt
      ? `Last synced ${timeAgo(sync.lastSyncAt)}${sync.lastAddedCount ? ` · +${sync.lastAddedCount} new` : ''}`
      : 'Never synced';

  return (
    <button
      type="button"
      className="sync-badge"
      onClick={() => sync.syncNow()}
      title="Click to sync now"
      disabled={sync.running}
    >
      <span className={'sync-dot' + (sync.running ? ' running' : '')} />
      {text}
    </button>
  );
}

// "April 23, 2026" → "Apr 23". Strips year, abbreviates month, single-line.
function shortDate(s) {
  if (!s) return '';
  return s
    .replace(/, \d{4}/, '')
    .replace('January', 'Jan').replace('February', 'Feb').replace('March', 'Mar')
    .replace('April', 'Apr').replace('June', 'Jun')
    .replace('July', 'Jul').replace('August', 'Aug').replace('September', 'Sep')
    .replace('October', 'Oct').replace('November', 'Nov').replace('December', 'Dec');
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function Row({ r }) {
  const graded = isGraded(r);
  // Row tint dropped along with the old Hit/Miss blowout grading — the
  // green/red left-border was tied to "did the model correctly predict
  // a blowout," which is no longer a per-row concept. Ungraded rows
  // still get their muted style so missing-prediction games stand out.
  const cls = graded ? '' : 'ungraded-row';
  const blowoutYes = wasBlowout(r);

  return (
    <tr className={cls}>
      <td style={{ whiteSpace: 'nowrap' }}>{shortDate(r.date)}</td>
      <td style={{ color: 'var(--muted)' }}>{(r.league || 'nba').toUpperCase()}</td>
      <td>
        <span className="matchup-cell">{r.matchup}</span>
        {!graded && <NoPredBadge />}
      </td>
      <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>
        <FinalScore r={r} />
      </td>
      <td>
        {r.zone
          ? <span className={'badge ' + (ZONE_BADGE[r.zone] || '')}>{r.zone}</span>
          : <Dash />}
      </td>
      <td>
        {graded && r.dbp != null
          ? <DBPBar value={r.dbp} />
          : <Dash />}
      </td>
      <td style={{ color: 'var(--muted)' }}>{r.spreadPick || <Dash />}</td>
      <td style={{ color: 'var(--muted)' }}>{r.ouPick || <Dash />}</td>
      <td>
        {r.spreadResult
          ? <span className={'badge ' + (r.spreadResult === 'Hit' ? 'badge-hit' : 'badge-miss')}>{r.spreadResult}</span>
          : <Dash />}
      </td>
      <td>
        {r.ouResult
          ? <span className={'badge ' + (r.ouResult === 'Hit' ? 'badge-hit' : 'badge-miss')}>{r.ouResult}</span>
          : <Dash />}
      </td>
      <td>
        {/* Blowout column is a pure outcome flag now: Yes if final margin
            cleared the league threshold, No otherwise. Same display for
            graded + ungraded rows. Color mirrors the zone palette — Yes
            uses the Super Lock purple, No uses the Baseline blue —
            since both colors are model-neutral observations rather than
            hit/miss judgments. */}
        <span className={'badge ' + (blowoutYes ? 'badge-zone-super' : 'badge-zone-base')}>
          {blowoutYes ? 'Yes' : 'No'}
        </span>
      </td>
      <td className="right" style={{ fontWeight: 600, color: 'var(--accent)' }}>+{r.margin}</td>
      <td className="right" style={{ color: 'var(--muted)' }}>{r.total}</td>
    </tr>
  );
}

function DBPBar({ value }) {
  const w = Math.min(100, Math.max(0, value));
  const c = dbpColor(value);
  return (
    <div className="dbp-bar">
      <div className="dbp-track">
        <div className="dbp-fill" style={{ '--w': `${w}%`, '--c': c }} />
      </div>
      <span className="dbp-num">{value.toFixed(1)}%</span>
    </div>
  );
}

function Dash() {
  return <span style={{ color: 'var(--muted2)' }}>—</span>;
}

// Final score in "AWAY−HOME" order, matching the matchup column's "AWAY @ HOME"
// reading direction. Bolds the winning side. Falls back to a dash for legacy
// rows (seed data + any row synced before this field was added) that don't
// have individual scores stored.
function FinalScore({ r }) {
  const a = r.awayScore;
  const h = r.homeScore;
  if (a == null || h == null) return <Dash />;
  const homeWon = h > a;
  const awayWon = a > h;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ fontWeight: awayWon ? 600 : 400, color: awayWon ? 'var(--accent)' : undefined }}>{a}</span>
      <span style={{ margin: '0 4px', color: 'var(--muted2)' }}>−</span>
      <span style={{ fontWeight: homeWon ? 600 : 400, color: homeWon ? 'var(--accent)' : undefined }}>{h}</span>
    </span>
  );
}

function NoPredBadge() {
  return (
    <span
      className="badge"
      style={{
        marginLeft: 8,
        color: 'var(--muted)',
        background: 'var(--surface2)',
        border: '0.5px solid var(--border2)',
      }}
      title="No pregame prediction was locked for this game"
    >
      No Pred
    </span>
  );
}

function StatCell({ l, v, sub, color }) {
  return (
    <div className="stat-cell">
      <span className="v" style={color ? { color } : undefined}>{v}</span>
      <span className="l">{l}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

function FilterGroup({ label, values, active, onClick, labelFor }) {
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className={'filter-chip' + (active === v ? ' active' : '')}
          onClick={() => onClick(v)}
        >
          {labelFor ? labelFor(v) : v}
        </button>
      ))}
    </div>
  );
}

function TH({ k, label, right, onClick, sortKey, sortDir }) {
  const sorted = sortKey === k;
  return (
    <th
      className={(right ? 'right ' : '') + (sorted ? 'sorted' : '')}
      onClick={() => onClick(k)}
    >
      {label}
      <span style={{ marginLeft: 4, color: sorted ? 'var(--accent2)' : 'var(--muted2)', fontSize: '0.7em' }}>
        {sorted ? (sortDir === 1 ? '↑' : '↓') : '⇅'}
      </span>
    </th>
  );
}
