import { useState } from 'react';
import { fmtLine } from '../data/formulaCore.js';

// Pure renderer of view.breakdown (produced by predictionBreakdown in
// formulaCore.js, stored on the locked snapshot by the worker). Never
// re-computes anything — if it isn't on the snapshot, the section just
// doesn't render. Keeps the integrity rule intact: post-lock displays
// are bit-identical to what was frozen at tipoff.
export default function Breakdown({ breakdown }) {
  if (!breakdown) return null;
  const { baseANG, deltaVol, deltaStar, dbp, favAbbr, undAbbr } = breakdown;

  return (
    <div className="breakdown">
      <Section title="Base ANG">
        <Row label={`SRS Δ (${favAbbr} − ${undAbbr})`} value={baseANG.srsDelta} signed />
        <Row label="HCA" value={baseANG.hcaSigned} signed />
        <DeltaStarRow deltaStar={deltaStar} />
        <Row label="Base ANG" value={baseANG.total} signed bold />
      </Section>

      <Section title="Δ Vol">
        <Row
          label={`Matchup TOG (${fmtLine(deltaVol.matchupTOG.value)}) × 1.4`}
          value={deltaVol.togWeighted}
          signed
        />
        <Row
          label={`Matchup ORG (${fmtLine(deltaVol.matchupORG.value)}) × 0.5`}
          value={deltaVol.orgWeighted}
          signed
        />
        <Row label="Σ pre-MPF" value={deltaVol.sum} signed />
        {deltaVol.mpf !== 1 && (
          <Row label={`MPF (×${deltaVol.mpf.toFixed(2)})`} value={deltaVol.total} signed />
        )}
        <Row label="Δ Vol" value={deltaVol.total} signed bold />
      </Section>

      <Section title="DBP%">
        <Row label="True Gap" value={dbp.trueGap} signed />
        <Row label="Intercept" value={dbp.intercept} signed muted />
        <Row label="Multiplier" value={dbp.multiplier} formatter={(v) => v.toFixed(3)} muted />
        <Row label="Z" value={dbp.z} formatter={(v) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3))} />
        <Row label="DBP%" value={dbp.dbp} formatter={(v) => `${v.toFixed(1)}%`} bold />
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="breakdown-section">
      <div className="breakdown-section-title">{title}</div>
      <div className="breakdown-rows">{children}</div>
    </div>
  );
}

function Row({ label, value, signed, bold, muted, formatter }) {
  const fmt = formatter
    ? formatter(value)
    : signed
      ? fmtLine(value)
      : value == null ? '—' : Number(value).toFixed(2);
  const cls =
    'breakdown-row' +
    (bold ? ' breakdown-row-bold' : '') +
    (muted ? ' breakdown-row-muted' : '');
  return (
    <div className={cls}>
      <span className="breakdown-row-label">{label}</span>
      <span className="breakdown-row-value">{fmt}</span>
    </div>
  );
}

// Δ Star sits inside the Base ANG section because it's one of the three
// inputs that sum to Base ANG (along with SRS Δ and HCA). The row itself
// shows the scalar value; tapping expands an inline substack with IAF /
// Raw / clamp status + per-team player tables. Collapsed by default so
// the Base ANG section reads tightly when scrolling.
function DeltaStarRow({ deltaStar }) {
  const [open, setOpen] = useState(false);
  const { favTeam, undTeam, iaf, raw, clamped, value } = deltaStar;
  const totalPlayers = favTeam.players.length + undTeam.players.length;

  return (
    <>
      <button
        type="button"
        className={'breakdown-row breakdown-row-toggle' + (open ? ' is-open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Hide Δ Star detail' : 'Show Δ Star detail'}
      >
        <span className="breakdown-row-label">
          Δ Star
          <span className="breakdown-row-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
        <span className="breakdown-row-value">{fmtLine(value)}</span>
      </button>

      {open && (
        <div className="breakdown-substack">
          <Row label="IAF" value={iaf} formatter={(v) => v.toFixed(3)} muted />
          <Row label="Raw" value={raw} signed muted />
          {clamped && <Row label="Clamped → cap" value={value} signed muted />}

          {totalPlayers === 0 ? (
            <div className="breakdown-empty">No injured players on either side.</div>
          ) : (
            <>
              <PlayerTable title={favTeam.abbr} rows={favTeam.players} />
              <PlayerTable title={undTeam.abbr} rows={undTeam.players} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function PlayerTable({ title, rows }) {
  if (!rows.length) {
    return (
      <div className="breakdown-player-table">
        <div className="breakdown-player-team">{title}</div>
        <div className="breakdown-empty">No listed absences.</div>
      </div>
    );
  }
  return (
    <div className="breakdown-player-table">
      <div className="breakdown-player-team">{title}</div>
      <div className="breakdown-player-header">
        <span>Player</span>
        <span>Status</span>
        <span>MPG</span>
        <span>BPM/PER</span>
        <span>Impact</span>
        <span>Contrib</span>
      </div>
      {rows.map((r, i) => {
        const adv = r.bpm != null
          ? r.bpm.toFixed(1)
          : r.per != null
            ? r.per.toFixed(1)
            : '—';
        return (
          <div key={i} className="breakdown-player-row">
            <span className="breakdown-player-name" title={r.player}>{r.player}</span>
            <span className="breakdown-player-status">{r.status || '—'}</span>
            <span>{r.mpg != null ? r.mpg.toFixed(1) : '—'}</span>
            <span>{adv}</span>
            <span>{r.impact.toFixed(2)}</span>
            <span className="breakdown-player-contrib">{r.contribution.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}
