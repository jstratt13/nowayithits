import { useEffect } from 'react';
import {
  computeDBP,
  getZone,
  projectedMargin,
  projectedTotal,
  spreadPick,
  ouPick,
  fmtLine,
  predictionInputs,
} from '../data/formula.js';
import { getLocked, setLocked, hasUsableOdds } from '../data/lockedPredictions.js';

function statusLabel(game) {
  if (game.state === 'in')   return { text: game.statusLabel || 'LIVE', cls: 'live' };
  if (game.state === 'post') return { text: 'Final', cls: 'final' };
  return { text: 'Scheduled', cls: 'scheduled' };
}

// Build the snapshot we persist while the game is pregame + has odds.
function buildSnapshot(game) {
  return {
    sp: spreadPick(game),
    ou: ouPick(game),
    dbp: computeDBP(game),
    projTotal: projectedTotal(game),
    projMargin: projectedMargin(game),
    inputs: predictionInputs(game),
    book: {
      favored: game.odds.favored,
      spread:  game.odds.spread,
      total:   game.odds.total,
    },
  };
}

// Decide what to render for this card.
//   pregame              → live compute (formula updates during pregame are
//                          allowed; snapshot is written on the side so it
//                          freezes at tipoff)
//   in / post + locked   → read from the locked snapshot, never recompute
//   in / post + no lock  → render a "no pregame prediction" state instead
//                          of falling back to live compute, which would
//                          silently drift with formula changes after tipoff
function resolveDisplay(game) {
  if (game.state === 'pre') {
    return { source: 'live', view: buildSnapshot(game) };
  }
  const locked = getLocked(game.id);
  if (locked) return { source: 'locked', view: locked };
  return { source: 'missing', view: null };
}

export default function GameCard({ game }) {
  const { source, view } = resolveDisplay(game);

  // Persist the snapshot while the game is still pregame and odds are
  // available. setLocked() refuses to write for any non-'pre' state, so the
  // snapshot freezes the moment the game tips off.
  const oddsKey = hasUsableOdds(game)
    ? `${game.odds.homeLine}:${game.odds.total}:${game.odds.favored}`
    : '';
  useEffect(() => {
    if (game.state === 'pre' && hasUsableOdds(game)) {
      setLocked(game.id, buildSnapshot(game), game.state);
    }
  }, [game.id, game.state, oddsKey]);

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

  const dbp = view.dbp;
  const zone = getZone(dbp, game.league);
  const sp = view.sp;
  const ou = view.ou;
  const projTotal = view.projTotal;
  const projMargin = view.projMargin;
  const inputs = view.inputs;
  const book = view.book || {};

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
            Book: {book.favored && book.spread != null
              ? `${book.favored} -${book.spread.toFixed(1)}`
              : 'n/a'}
            {sp ? ` · edge ${fmtLine(Math.abs(sp.edge))}` : ''}
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

      <div className="input-row">
        <span className="input-stat"><span className="k">Base ANG</span><span className="v">{fmtLine(inputs.baseANG)}</span></span>
        <span className="input-stat"><span className="k">Δ Vol</span><span className="v">{fmtLine(inputs.deltaVol)}</span></span>
        <span className="input-stat"><span className="k">True Gap</span><span className="v">{fmtLine(inputs.trueGap)}</span></span>
        <span className="input-stat"><span className="k">Proj M</span><span className="v">{fmtLine(projMargin)}</span></span>
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
