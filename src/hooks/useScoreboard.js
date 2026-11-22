import { useEffect, useState } from 'react';
import { fetchScoreboard } from '../data/espn.js';
import { onRefresh } from '../data/refreshBus.js';

// Lines, scores and game state change through the day — re-fetch every
// 2 minutes and on any app refresh (↻, pull-to-refresh, reopening the app).
const POLL_MS = 2 * 60 * 1000;

export function useScoreboard(league, date) {
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ok | error
  const [error, setError] = useState(null);

  const dateKey = date ? date.toISOString().slice(0, 10) : '';

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);

    let hadData = false;
    const load = () => fetchScoreboard(league, date)
      .then((data) => {
        if (cancelled) return;
        hadData = true;
        setGames(data);
        setStatus('ok');
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        // A failed background refresh keeps the last good slate on screen.
        if (!hadData) setStatus('error');
      });

    load();
    const timer = setInterval(load, POLL_MS);
    const off = onRefresh(load);
    return () => { cancelled = true; clearInterval(timer); off(); };
  }, [league, dateKey]);

  return { games, status, error };
}
