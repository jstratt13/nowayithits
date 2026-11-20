import { useEffect, useState } from 'react';
import { ensureInjuries, refreshInjuries, subscribe } from '../data/liveStats.js';
import { onRefresh } from '../data/refreshBus.js';

const INJURY_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

// Subscribes to the ESPN injuries cache so cards re-render when new data
// arrives, and runs a 10-min background refresh while the page is open
// (catches late scratches without a manual reload).
export function useLiveStats(leagues = ['nba', 'wnba']) {
  const [, force] = useState(0);
  const key = leagues.join(',');

  useEffect(() => {
    const unsub = subscribe(() => force((x) => x + 1));
    for (const l of leagues) ensureInjuries(l);
    return unsub;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const refresh = () => { for (const l of leagues) refreshInjuries(l); };
    const timer = setInterval(refresh, INJURY_REFRESH_MS);
    const off = onRefresh(refresh);
    return () => { clearInterval(timer); off(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
