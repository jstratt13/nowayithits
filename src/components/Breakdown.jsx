import { useState } from 'react';
import { fmtLine } from '../data/formulaCore.js';

// Pure renderer of view.breakdown (produced by predictionBreakdown in
// formulaCore.js, stored on the locked snapshot by the worker). Never
// re-computes anything — if it isn't on the snapshot, the section just
// doesn't render. Keeps the integrity rule intact: post-lock displays
// are bit-identical to what was frozen at tipoff.
export default function Breakdown({ breakdown }) {
  if (!breakdown) return null;
  const { baseANG, deltaVol, deltaStar, dbp, total, favAbbr, undAbbr } = breakdown;

  return (
    <div className="breakdown">
      <Section title="Base ANG">
        <Row label={`SRS Δ (${favAbbr} − ${undAbbr})`} value={baseANG.srsDelta} signed />
        <Row label="HCA" value={baseANG.hcaSigned} signed />
        <DeltaStarRow deltaStar={deltaStar} />
        {baseANG.rest && <RestRow rest={baseANG.rest} />}
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

      {total && <TotalSection total={total} />}
    </div>
  );
}

// Projected total — three expandable rows (possessions, combined rating,
// matchup adjustment) then the final number. Each sub-row expands to
// show the inputs it was built from so the arithmetic can be traced.
function TotalSection({ total }) {
  const { possessions, ratings, matchup, rest, total: projTotal } = total;
  return (
    <Section title="Projected Total">
      <ExpandRow
        label="Possessions"
        value={possessions.value}
        formatter={(v) => v.toFixed(1)}
      >
        <Row label="Home pace" value={possessions.homePace} formatter={(v) => v.toFixed(1)} muted />
        <Row label="Away pace" value={possessions.awayPace} formatter={(v) => v.toFixed(1)} muted />
        {possessions.paceDeflate !== 0 && (
          <Row label="Playoff pace deflate" value={-possessions.paceDeflate} signed muted />
        )}
      </ExpandRow>

      <ExpandRow
        label="Combined rating"
        value={ratings.combined}
        formatter={(v) => v.toFixed(1)}
      >
        <Row
          label={`${ratings.home.abbr} off / ${ratings.away.abbr} def → home exp`}
          value={ratings.home.expected}
          formatter={(v) => v.toFixed(1)}
          muted
        />
        <Row label={`${ratings.home.abbr} effective ORtg`} value={ratings.home.ratingOff} formatter={(v) => v.toFixed(1)} muted />
        <Row label={`${ratings.away.abbr} effective DRtg`} value={ratings.away.ratingDef} formatter={(v) => v.toFixed(1)} muted />
        <Row
          label={`${ratings.away.abbr} off / ${ratings.home.abbr} def → away exp`}
          value={ratings.away.expected}
          formatter={(v) => v.toFixed(1)}
          muted
        />
        <Row label={`${ratings.away.abbr} effective ORtg`} value={ratings.away.ratingOff} formatter={(v) => v.toFixed(1)} muted />
        <Row label={`${ratings.home.abbr} effective DRtg`} value={ratings.home.ratingDef} formatter={(v) => v.toFixed(1)} muted />
        {(ratings.home.injuryScore > 0 || ratings.away.injuryScore > 0) && (
          <Row
            label={`Injury adj (${ratings.home.abbr} ${ratings.home.injuryScore.toFixed(1)} · ${ratings.away.abbr} ${ratings.away.injuryScore.toFixed(1)})`}
            value={null}
            formatter={() => 'applied to effOff/effDef'}
            muted
          />
        )}
        <Row label="Base total (poss × combined ÷ 100)" value={ratings.baseTotal} formatter={(v) => v.toFixed(1)} muted />
      </ExpandRow>

      {matchup && (
        <ExpandRow
          label={`Matchup adj (×${matchup.multiplier.toFixed(3)})`}
          value={(matchup.multiplier - 1) * 100}
          formatter={(v) => (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`)}
        >
          <Row
            label={`Game TO diff (${matchup.gameToDiff?.toFixed(2)}) — symmetric quadratic`}
            value={matchup.gameToDiff}
            signed
            muted
          />
          <Row
            label="TO diff impact"
            value={matchup.toDiffImpactPct}
            formatter={(v) => (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`)}
            muted
          />
          {matchup.game3PAr != null && (
            <>
              <Row
                label={`Game 3PAr (${matchup.game3PAr.toFixed(1)}) — bottom-decile threshold`}
                value={matchup.game3PAr}
                formatter={(v) => v.toFixed(1)}
                muted
              />
              <Row
                label={
                  matchup.threePArImpactPct < 0
                    ? `3PAr low penalty (below ${matchup.threePArLowThreshold})`
                    : '3PAr (no penalty — above threshold)'
                }
                value={matchup.threePArImpactPct}
                formatter={(v) => (v === 0 ? '0.00%' : v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`)}
                muted
              />
            </>
          )}
        </ExpandRow>
      )}

      {rest && (
        <ExpandRow
          label={`Rest / B2B (×${rest.multiplier.toFixed(3)})`}
          value={(rest.multiplier - 1) * 100}
          formatter={(v) => (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`)}
        >
          <Row
            label="Home"
            value={null}
            formatter={() => restLabel(rest.homeDaysRest)}
            muted
          />
          <Row
            label="Away"
            value={null}
            formatter={() => restLabel(rest.awayDaysRest)}
            muted
          />
          <Row
            label="Scenario"
            value={null}
            formatter={() => restScenario(rest)}
            muted
          />
        </ExpandRow>
      )}

      <Row label="Projected Total" value={projTotal} formatter={(v) => v.toFixed(1)} bold />
    </Section>
  );
}

function restLabel(n) {
  if (n == null) return 'rested (3d+)';
  if (n === 1) return 'B2B';
  if (n === 2) return '1d rest';
  return `${n - 1}d rest`;
}

function restScenario(r) {
  if (r.homeB2B && r.awayB2B) return 'Both B2B → ×0.99';
  if (r.homeB2B)              return 'Home B2B only → ×1.01';
  if (r.awayB2B)              return 'Away B2B only → ×1.00 (status only)';
  return 'Neither B2B → baseline';
}

// Rest / B2B margin adjustment. Signed from the favored-perspective so it
// slots cleanly into the Base ANG column. Expands to show both teams'
// actual rest days + the home-perspective shift.
function RestRow({ rest }) {
  const [open, setOpen] = useState(false);
  const label = rest.marginSigned === 0 ? 'Rest / B2B' : 'Rest / B2B';
  const restText = (n) => {
    if (n == null) return 'rested (3d+)';
    if (n === 1) return 'B2B';
    if (n === 2) return '1d rest';
    return `${n - 1}d rest`;
  };
  return (
    <>
      <button
        type="button"
        className={'breakdown-row breakdown-row-toggle' + (open ? ' is-open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="breakdown-row-label">
          {label}
          <span className="breakdown-row-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
        <span className="breakdown-row-value">{fmtLine(rest.marginSigned)}</span>
      </button>
      {open && (
        <div className="breakdown-substack">
          <Row label="Home status" value={null} formatter={() => restText(rest.homeDaysRest)} muted />
          <Row label="Away status" value={null} formatter={() => restText(rest.awayDaysRest)} muted />
          <Row label="Home-perspective adj" value={rest.marginHome} signed muted />
          <Row
            label="Applied to favored side"
            value={rest.marginSigned}
            signed
            muted
          />
        </div>
      )}
    </>
  );
}

function ExpandRow({ label, value, formatter, children }) {
  const [open, setOpen] = useState(false);
  const fmt = formatter ? formatter(value) : (value == null ? '—' : Number(value).toFixed(2));
  return (
    <>
      <button
        type="button"
        className={'breakdown-row breakdown-row-toggle' + (open ? ' is-open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="breakdown-row-label">
          {label}
          <span className="breakdown-row-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
        <span className="breakdown-row-value">{fmt}</span>
      </button>
      {open && <div className="breakdown-substack">{children}</div>}
    </>
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
