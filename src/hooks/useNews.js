import { useEffect, useState } from 'react';
import { fetchNews } from '../data/espnNews.js';

const REFRESH_MS = 10 * 60 * 1000; // 10 min — news ages slowly

export function useNews(league) {
  const [state, setState] = useState({ status: 'loading', articles: [], error: null });

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setState((s) => ({ ...s, status: s.articles.length ? 'ok' : 'loading' }));
      fetchNews(league)
        .then((articles) => {
          if (cancelled) return;
          setState({ status: 'ok', articles, error: null });
        })
        .catch((e) => {
          if (cancelled) return;
          setState({ status: 'error', articles: [], error: e.message });
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [league]);

  return state;
}
