import { useEffect, useState } from 'react';
import { fetchScoreboard } from '../data/espn.js';

export function useScoreboard(league, date) {
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ok | error
  const [error, setError] = useState(null);

  const dateKey = date ? date.toISOString().slice(0, 10) : '';

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);

    fetchScoreboard(league, date)
      .then((data) => {
        if (cancelled) return;
        setGames(data);
        setStatus('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [league, dateKey]);

  return { games, status, error };
}
