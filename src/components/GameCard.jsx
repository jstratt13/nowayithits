import { getZone, fmtLine } from '../data/formula.js';
import { getTeamInjuries } from '../data/liveStats.js';

function statusLabel(game) {
  if (game.state === 'in')   return { text: game.statusLabel || 'LIVE', cls: 'live' };
  if (game.state === 'post') return { text: 'Final', cls: 'final' };
  return { text: 'Scheduled', cls: 'scheduled' };
}

// Decide what to render. Source of truth is the server snapshot (worker's
// /predictions endpoint), never local compute — that would re-introduce
// the per-device divergence this whole change exists to eliminate.
//
//   serverPrediction with predictions       → render (locked OR live based on flag)
//   serverPrediction locked, predictions null → missing (orphaned: worker first observed the game in-progress)
//   no serverPrediction at all              → loading (cron hasn't reached this game yet)
function resolveDisplay(serverPrediction) {
  if (serverPrediction && serverPrediction.predictions) {
    return {
      source: serverPrediction.locked ? 'locked' : 'live',
      view: serverPrediction.predictions,
    };
  }
  if (serverPrediction && serverPrediction.locked) {
    return { source: 'missing', view: null };
  }
  return { source: 'loading', view: null };
}

export default function GameCard({ game, serverPrediction = null }) {
  const { source, view } = resolveDisplay(serverPrediction);

  // No localStorage mirror — the Tracker reconciler now reads locked
  // snapshots directly from the worker (Step 4). Legacy `dbp-locked-preds-v1`
  // entries from before this change still get unioned in as a fallback
  // for pre-Step-2 games.

  const s = statusLabel(game);
  const cardCls = 'game-card' + (game.state === 'in' ? ' is-live' : game.state === 'post' ? ' is-final' : '');

  if (source === 'missing') {
    return (
      <article className={cardCls}>
        <div className="game-card-top">
          <span className="game-time">{game.startTimeLabel}</span>
          <span className={'game-status ' + s.cls}>{s.text}</span>
        </div>

        <div className="matchup">
          <TeamRow team={game.away} away showScore />
          <TeamRow team={game.home} showScore />
        </div>

        <div className="missing-pred">
          No pregame prediction was locked for this game.
        </div>
      </article>
    );
  }

  if (source === 'loading') {
    return (
      <article className={cardCls}>
        <div className="game-card-top">
          <span className="game-time">{game.startTimeLabel}</span>
          <span className={'game-status ' + s.cls}>{s.text}</span>
        </div>

        <div className="matchup">
          <TeamRow team={game.away} away showScore={game.state !== 'pre'} />
          <TeamRow team={game.home} showScore={game.state !== 'pre'} />
        </div>

        <div className="missing-pred">
          Loading projections…
        </div>

        <InjurySection game={game} />
      </article>
    );
  }

  const dbp = view.dbp;
  const zone = getZone(dbp, game.league);
  const sp = view.sp;
  const ou = view.ou;
  const projTotal = view.projTotal;
  const projMargin = view.projMargin;
  const inputs = view.inputs;

  return (
    <article className={cardCls}>
      <div className="game-card-top">
        <span className="game-time">{game.startTimeLabel}</span>
        <span className={'game-status ' + s.cls}>{s.text}</span>
      </div>

      <div className="matchup">
        <TeamRow team={game.away} away showScore={game.state !== 'pre'} />
        <TeamRow team={game.home} showScore={game.state !== 'pre'} />
      </div>

      <div className="dbp-row">
        <div className="dbp-block">
          <span className="dbp-label">
            DBP% {source === 'locked' && <LockHint />}
          </span>
          <span className="dbp-value">{dbp.toFixed(1)}%</span>
        </div>
        <div className="dbp-block" style={{ alignItems: 'flex-end', textAlign: 'right' }}>
          <span className="dbp-label">Zone</span>
          <span className={'badge ' + zone.badge}>{zone.label}</span>
        </div>
      </div>

      <div className="preds">
        <div className="pred">
          <span className="pred-label">
            Spread Pick {source === 'locked' && <LockHint />}
          </span>
          <span className="pred-pick">
            {sp ? `${sp.side} ${fmtLine(sp.line)}` : '—'}
          </span>
          <span className="pred-book">
            {projMargin != null
              ? `Proj winner: ${projMargin >= 0 ? game.home.abbr : game.away.abbr} by ${Math.abs(projMargin).toFixed(1)} pts`
              : '—'}
          </span>
        </div>
        <div className="pred">
          <span className="pred-label">
            Total Pick {source === 'locked' && <LockHint />}
          </span>
          <span className="pred-pick">
            {ou ? `${ou.direction} ${ou.line.toFixed(1)}` : '—'}
          </span>
          <span className="pred-book">
            Proj {projTotal.toFixed(1)}
            {ou ? ` · edge ${fmtLine(ou.edge)}` : ''}
          </span>
        </div>
      </div>

      <InjurySection game={game} />

      <div className="input-row">
        <span className="input-stat"><span className="k">Base ANG</span><span className="v">{fmtLine(inputs.baseANG)}</span></span>
        <span className="input-stat"><span className="k">Δ Vol</span><span className="v">{fmtLine(inputs.deltaVol)}</span></span>
        <span className="input-stat"><span className="k">True Gap</span><span className="v">{fmtLine(inputs.trueGap)}</span></span>
      </div>
    </article>
  );
}

function LockHint() {
  return (
    <span
      title="Locked at tipoff"
      style={{
        marginLeft: 6,
        fontSize: '0.55rem',
        letterSpacing: '0.1em',
        color: 'var(--muted2)',
      }}
    >
      🔒 LOCKED
    </span>
  );
}

// ── Injury Report ────────────────────────────────────────────────────────

// Status classification: Out/Suspended → red  |  everything else → orange
function injuryTier(status) {
  const s = (status || '').toLowerCase();
  if (s === 'out' || s === 'suspended') return 'out';
  return 'questionable';
}

function InjurySection({ game }) {
  const awayList = getTeamInjuries(game.league, game.away.id);
  const homeList = getTeamInjuries(game.league, game.home.id);
  if (!awayList.length && !homeList.length) return null;

  return (
    <div className="injury-section">
      {awayList.length > 0 && (
        <InjuryTeam name={game.away.shortName || game.away.abbr} players={awayList} />
      )}
      {homeList.length > 0 && (
        <InjuryTeam name={game.home.shortName || game.home.abbr} players={homeList} />
      )}
    </div>
  );
}

function InjuryTeam({ name, players }) {
  return (
    <div className="injury-team">
      <span className="injury-team-name">{name}</span>
      <div className="injury-players">
        {players.map((p, i) => {
          const tier = injuryTier(p.status);
          return (
            <div key={i} className="injury-player">
              <span className={'injury-dot injury-dot-' + tier} />
              <span className="injury-name">{p.player}</span>
              <span className={'injury-status injury-status-' + tier}>
                {tier === 'out' ? 'OUT' : 'QUESTIONABLE'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TeamRow({ team, away, showScore }) {
  return (
    <div className="team-row">
      <span className="team-name">
        {team.logo && (
          <img src={team.logo} alt="" width={20} height={20} style={{ display: 'block' }} />
        )}
        {team.shortName || team.name}
        <span className="abbr">{team.abbr}{away ? ' @' : ''}</span>
      </span>
      {showScore && (
        <span className={'team-score' + (team.winner ? ' winner' : '')}>
          {team.score != null ? team.score : '—'}
        </span>
      )}
    </div>
  );
}
