import { useEffect, useState } from 'react';
import { ensureInjuries, refreshInjuries, subscribe } from '../data/liveStats.js';

const INJURY_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

// Subscribes to the ESPN injuries cache so cards re-render when new data
// arrives, and runs a 10-min background refresh while the page is open
// (catches late scratches without a manual reload).
//
// `withInjuries: false` is supported but currently unused by any caller —
// kept for callers that don't render injury chips. Predictions page passes
// true; Tracker page passes false.
export function useLiveStats(leagues = ['nba', 'wnba'], { withInjuries = true } = {}) {
  const [, force] = useState(0);

  useEffect(() => {
    const unsub = subscribe(() => force((x) => x + 1));
    if (withInjuries) {
      for (const l of leagues) ensureInjuries(l);
    }
    return unsub;
  }, [leagues.join(','), withInjuries]);

  useEffect(() => {
    if (!withInjuries) return;
    const timer = setInterval(() => {
      for (const l of leagues) refreshInjuries(l);
    }, INJURY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [leagues.join(','), withInjuries]);
}
