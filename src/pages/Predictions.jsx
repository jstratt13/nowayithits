import { useMemo, useState } from 'react';
import { useScoreboard } from '../hooks/useScoreboard.js';
import { useLiveStats } from '../hooks/useLiveStats.js';
import { useSharedPredictions } from '../hooks/useSharedPredictions.js';
import GameCard from '../components/GameCard.jsx';
import NewsPanel from '../components/NewsPanel.jsx';

const LEAGUES = [
  { key: 'nba',  label: 'NBA' },
  { key: 'wnba', label: 'WNBA' },
];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function fullDateLabel(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function relativeDateLabel(d) {
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 7) return `In ${diff} days`;
  if (diff < -1 && diff >= -7) return `${-diff} days ago`;
  return null;
}

export default function Predictions() {
  const [league, setLeague] = useState('nba');
  const [date, setDate] = useState(() => startOfDay(new Date()));
  useLiveStats([league], { withInjuries: true });

  const isToday = useMemo(() => sameDay(date, new Date()), [date]);

  return (
    <div className="page-with-sidebar">
      <div className="page-main">
      <div className="prediction-controls">
        <div className="league-tabs" role="tablist" aria-label="League">
          {LEAGUES.map((l) => (
            <button
              key={l.key}
              type="button"
              role="tab"
              aria-selected={league === l.key}
              className={'league-tab' + (league === l.key ? ' active' : '')}
              onClick={() => setLeague(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>

        <div className="date-nav" role="group" aria-label="Slate date">
          <button
            type="button"
            className="date-nav-btn"
            onClick={() => setDate((d) => addDays(d, -1))}
            aria-label="Previous day"
          >
            ◀
          </button>
          <div className="date-nav-label">
            {isToday
              ? <span className="date-nav-rel">TODAY</span>
              : <button
                  type="button"
                  className="date-nav-today-inline"
                  onClick={() => setDate(startOfDay(new Date()))}
                  title="Back to today"
                >
                  ↩ Today
                </button>
            }
            <span className="date-nav-full">{fullDateLabel(date)}</span>
          </div>
          <button
            type="button"
            className="date-nav-btn"
            onClick={() => setDate((d) => addDays(d, 1))}
            aria-label="Next day"
          >
            ▶
          </button>
        </div>
      </div>

      <LeagueSection league={league} date={date} />
      </div>
      <NewsPanel league={league} />
    </div>
  );
}

function LeagueSection({ league, date }) {
  const { games, status, error } = useScoreboard(league, date);
  // Server-computed predictions for this (league, date). Polls every 10 min;
  // each GameCard reads its own snapshot by ESPN event id. If the worker is
  // unreachable, cards fall through to a "Loading…" state — never to a local
  // compute fallback, which would re-introduce per-device drift.
  const { byGameId: predictionsByGameId } = useSharedPredictions(league, date);

  return (
    <section>
      <div className="section-head">
        <div className="section-title">
          <span className="league-pill">{league.toUpperCase()}</span>
          <h2>Live predictions</h2>
        </div>
        <div className="section-meta">
          {status === 'ok' && `${games.length} game${games.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {status === 'loading' && (
        <div className="skeleton-grid">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton" />)}
        </div>
      )}

      {status === 'error' && (
        <div className="error-state">
          Couldn't reach ESPN scoreboard — {error}
        </div>
      )}

      {status === 'ok' && games.length === 0 && (
        <div className="empty-state">
          No {league.toUpperCase()} games on this slate.
        </div>
      )}

      {status === 'ok' && games.length > 0 && (
        <div className="game-grid">
          {games.map((g) => (
            <GameCard
              key={g.id}
              game={g}
              serverPrediction={predictionsByGameId[g.id] || null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
