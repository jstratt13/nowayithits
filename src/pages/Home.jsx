import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useScoreboard } from '../hooks/useScoreboard.js';
import { useSharedPredictions } from '../hooks/useSharedPredictions.js';
import { fmtLine } from '../data/formulaCore.js';

// Treats today as the user's local calendar day — same convention used
// by the Predictions page so the home page agrees with what the rest of
// the app considers "today's slate".
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Confidence weighting: every point of spread edge counts double a point
// of total edge, per project spec. Returns the better of the two bets
// for a given prediction, with both numeric confidence + a display label.
function bestPickForGame(p, game) {
  const spreadConf = 2 * Math.abs(p?.sp?.edge ?? 0);
  const totalConf  = Math.abs(p?.ou?.edge ?? 0);
  if (spreadConf === 0 && totalConf === 0) return null;
  if (spreadConf >= totalConf) {
    return {
      type: 'spread',
      confidence: spreadConf,
      label: `${p.sp.side} ${fmtLine(p.sp.line)}`,
      edgeLabel: `edge ${fmtLine(p.sp.edge)} pts`,
      game,
      pred: p,
    };
  }
  return {
    type: 'total',
    confidence: totalConf,
    label: `${p.ou.direction} ${p.ou.line.toFixed(1)}`,
    edgeLabel: `edge ${fmtLine(p.ou.edge)} pts`,
    game,
    pred: p,
  };
}

export default function Home() {
  const today = useMemo(() => startOfToday(), []);

  // Live scoreboards for both leagues. Each scoreboard hook handles its
  // own loading/error state internally; we just merge the results.
  const nbaScore  = useScoreboard('nba',  today);
  const wnbaScore = useScoreboard('wnba', today);

  // Server-computed predictions for both leagues. Same idea — each hook
  // polls /predictions/:league every 10 min.
  const nbaPreds  = useSharedPredictions('nba',  today);
  const wnbaPreds = useSharedPredictions('wnba', today);

  // Build the combined live-scores list. Sort by start time so the panel
  // reads top-to-bottom in tipoff order, regardless of league.
  const liveGames = useMemo(() => {
    const all = [
      ...(nbaScore.games || []),
      ...(wnbaScore.games || []),
    ];
    return all.sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [nbaScore.games, wnbaScore.games]);

  // Compute Pick of the Day items.
  const picks = useMemo(() => {
    function findHighestBlowout(predMap, games) {
      // Highest DBP% across games that actually have a server prediction.
      let best = null;
      for (const g of games) {
        const sp = predMap[g.id];
        if (!sp?.predictions) continue;
        const dbp = sp.predictions.dbp;
        if (dbp == null) continue;
        if (!best || dbp > best.dbp) best = { dbp, game: g, pred: sp.predictions };
      }
      return best;
    }
    function findTopPick(predMap, games) {
      let best = null;
      for (const g of games) {
        const sp = predMap[g.id];
        if (!sp?.predictions) continue;
        const candidate = bestPickForGame(sp.predictions, g);
        if (!candidate) continue;
        if (!best || candidate.confidence > best.confidence) best = candidate;
      }
      return best;
    }

    const nbaGames  = nbaScore.games  || [];
    const wnbaGames = wnbaScore.games || [];

    const highestBlowout = (() => {
      const a = findHighestBlowout(nbaPreds.byGameId,  nbaGames);
      const b = findHighestBlowout(wnbaPreds.byGameId, wnbaGames);
      if (!a) return b;
      if (!b) return a;
      return a.dbp >= b.dbp ? a : b;
    })();

    const nbaTopPick  = findTopPick(nbaPreds.byGameId,  nbaGames);
    const wnbaTopPick = findTopPick(wnbaPreds.byGameId, wnbaGames);
    return { highestBlowout, nbaTopPick, wnbaTopPick };
  }, [nbaScore.games, wnbaScore.games, nbaPreds.byGameId, wnbaPreds.byGameId]);

  return (
    <div className="home-layout">
      <div className="home-main">
        <AboutSection />
        <PickOfTheDay picks={picks} />
      </div>
      <aside className="home-sidebar">
        <LiveScoresPanel games={liveGames} loading={nbaScore.status === 'loading' || wnbaScore.status === 'loading'} />
      </aside>
    </div>
  );
}

// ── About section ──────────────────────────────────────────────────────

function AboutSection() {
  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2 className="home-section-title">About No Way It Hits</h2>
      </div>

      <p className="home-prose">
        <strong>No Way It Hits</strong> is a daily professional
        basketball blowout predictor. The name's a tongue-in-cheek nod
        to lopsided lines — the kind a casual viewer sees and thinks,
        "no way it hits." Sometimes they're right. Often the model says
        otherwise.
      </p>
      <p className="home-prose">
        More personally, "No Way It Hits" is, in my opinion, the most
        effective reverse jinx to keep your crazy parlays alive!
      </p>
      <p className="home-prose">
        The goal is a persistent, honest record of model performance
        over time. Every prediction the model makes locks five minutes
        before tipoff and is never retroactively edited — even if the
        formula changes later. The tracker grades each locked
        prediction against the actual outcome so accuracy stats can be
        trusted to evolve the model with real evidence rather than
        wishful revision.
      </p>

      <div className="home-callout">
        <span className="home-callout-label">What counts as a blowout?</span>
        <div className="home-callout-tiles">
          <div className="home-callout-tile">
            <span className="home-callout-league">NBA</span>
            <span className="home-callout-value">final margin ≥ 16</span>
          </div>
          <div className="home-callout-tile">
            <span className="home-callout-league">WNBA</span>
            <span className="home-callout-value">final margin ≥ 14</span>
          </div>
        </div>
      </div>

      <div className="home-subsection">
        <h3 className="home-subsection-title">Key terms</h3>

        <dl className="home-glossary">
          <dt>DBP%</dt>
          <dd>
            <strong>Daily Blowout Probability</strong>. The model's
            estimate of how likely a game ends as a blowout (see the
            margin thresholds above). A 70%+ DBP is a "Super Lock" zone;
            anything under 25% is "Safe Zone."
          </dd>

          <dt>Inputs to DBP</dt>
          <dd>
            DBP is a sigmoid over the <em>True Gap</em> — the model's
            estimated point gap between the two teams. True Gap is built
            from four ingredients:
            <ul className="home-bullets">
              <li>
                <strong>Team strength</strong> — a 50/50 blend of full-season
                net rating and the net rating from the last 10 games, so a
                team's recent performance carries significant weight in
                predicting outcomes of games.
              </li>
              <li>
                <strong>Home-court advantage</strong> — a league-specific
                base (NBA +3.5, WNBA +3.0); future work will add per-arena
                tiers for the WNBA.
              </li>
              <li>
                <strong>Δ_Star (injury impact)</strong> — a player-weighted
                rollup of who's out. Star availability counts more than
                bench guys, scaled by minutes-per-game × per-minute impact
                (BPM for NBA, PER for WNBA).
              </li>
              <li>
                <strong>Δ_Vol (matchup edge)</strong> — turnover and
                offensive-rebound matchup advantages, dampened by a pace
                factor in the WNBA where fewer possessions mean fewer
                chances for those edges to manifest.
              </li>
            </ul>
          </dd>

          <dt>Spread Pick / Total Pick</dt>
          <dd>
            The model's lean against the sportsbook line. <strong>Spread
            edge</strong> is the points-of-margin difference between the
            model and the book; <strong>total edge</strong> is the
            points-of-total difference. Larger edge = the model thinks
            the book line is further off.
          </dd>
        </dl>
      </div>
    </section>
  );
}

// ── Pick of the Day ────────────────────────────────────────────────────

function PickOfTheDay({ picks }) {
  const { highestBlowout, nbaTopPick, wnbaTopPick } = picks;
  const empty = !highestBlowout && !nbaTopPick && !wnbaTopPick;

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2 className="home-section-title">Pick of the Day</h2>
      </div>

      {empty ? (
        <div className="home-prose home-empty">
          No games on today's slate. Check back later, or jump to{' '}
          <Link to="/predictions">Predictions</Link> for upcoming slates.
        </div>
      ) : (
        <>
          {highestBlowout && (
            <div className="home-subsection">
              <h3 className="home-subsection-title">Highest Blowout Probability</h3>
              <div className="pick-grid">
                <PickCard
                  league={highestBlowout.game.league}
                  matchup={`${highestBlowout.game.away.abbr} @ ${highestBlowout.game.home.abbr}`}
                  tipoff={highestBlowout.game.startTimeLabel}
                  primary={`${highestBlowout.dbp.toFixed(1)}% DBP`}
                  secondary={`Model projects ${
                    highestBlowout.pred.projMargin >= 0
                      ? highestBlowout.game.home.abbr
                      : highestBlowout.game.away.abbr
                  } by ${Math.abs(highestBlowout.pred.projMargin).toFixed(1)}`}
                />
              </div>
            </div>
          )}

          {(nbaTopPick || wnbaTopPick) && (
            <div className="home-subsection">
              <h3 className="home-subsection-title">Top Confidence</h3>
              <div className="pick-grid">
                {nbaTopPick && (
                  <PickCard
                    league="nba"
                    matchup={`${nbaTopPick.game.away.abbr} @ ${nbaTopPick.game.home.abbr}`}
                    tipoff={nbaTopPick.game.startTimeLabel}
                    primary={nbaTopPick.label}
                    secondary={`${nbaTopPick.type === 'spread' ? 'Spread' : 'O/U'} · ${nbaTopPick.edgeLabel}`}
                  />
                )}
                {wnbaTopPick && (
                  <PickCard
                    league="wnba"
                    matchup={`${wnbaTopPick.game.away.abbr} @ ${wnbaTopPick.game.home.abbr}`}
                    tipoff={wnbaTopPick.game.startTimeLabel}
                    primary={wnbaTopPick.label}
                    secondary={`${wnbaTopPick.type === 'spread' ? 'Spread' : 'O/U'} · ${wnbaTopPick.edgeLabel}`}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PickCard({ league, matchup, tipoff, primary, secondary }) {
  return (
    <article className="pick-card">
      <span className="pick-eyebrow">
        <span className={'league-pill league-pill-' + (league || 'nba')}>{(league || 'nba').toUpperCase()}</span>
      </span>
      <div className="pick-matchup">{matchup}</div>
      <div className="pick-time">{tipoff}</div>
      <div className="pick-primary">{primary}</div>
      <div className="pick-secondary">{secondary}</div>
    </article>
  );
}

// ── Live scores side panel ─────────────────────────────────────────────

function LiveScoresPanel({ games, loading }) {
  return (
    <div className="live-scores-panel">
      <div className="live-scores-head">
        <h3 className="live-scores-title">Today's Scores</h3>
      </div>

      {loading && (!games || games.length === 0) && (
        <div className="live-scores-empty">Loading…</div>
      )}

      {!loading && (!games || games.length === 0) && (
        <div className="live-scores-empty">No games today.</div>
      )}

      {games && games.length > 0 && (
        <ol className="live-scores-list">
          {games.map((g) => <LiveScoreRow key={g.id} game={g} />)}
        </ol>
      )}
    </div>
  );
}

function LiveScoreRow({ game }) {
  const state = game.state;
  // Status label varies by state:
  //   pre  → "7:00 PM"
  //   in   → "Q3 2:15" (ESPN's shortDetail)
  //   post → "Final"
  let statusText;
  if (state === 'pre') {
    statusText = game.startTimeLabel;
  } else if (state === 'in') {
    statusText = game.statusLabel || 'Live';
  } else {
    statusText = 'Final';
  }

  const showScores = state !== 'pre';

  return (
    <li className={'live-score-row live-score-' + state}>
      <div className="live-score-status">
        <span className={'league-pill league-pill-' + game.league}>{game.league.toUpperCase()}</span>
        <span className="live-score-status-text">{statusText}</span>
      </div>
      <div className="live-score-teams">
        <div className="live-score-team">
          <span className="live-score-abbr">{game.away.abbr}</span>
          {showScores && (
            <span className={'live-score-pts' + (game.away.winner ? ' is-winner' : '')}>
              {game.away.score ?? '—'}
            </span>
          )}
        </div>
        <div className="live-score-team">
          <span className="live-score-abbr">{game.home.abbr}</span>
          {showScores && (
            <span className={'live-score-pts' + (game.home.winner ? ' is-winner' : '')}>
              {game.home.score ?? '—'}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
