import { useEffect, useState } from 'react';
import { ensureTeamStats, ensureInjuries, subscribe, getLiveSources } from '../data/liveStats.js';

// Triggers the worker fetch for the given league(s) and re-renders when
// new data arrives. The formula module reads from the same module-level
// store, so calling this hook is enough to make predictions reactive.
export function useLiveStats(leagues = ['nba', 'wnba'], { withInjuries = true } = {}) {
  const [, force] = useState(0);

  useEffect(() => {
    const unsub = subscribe(() => force((x) => x + 1));
    for (const l of leagues) {
      ensureTeamStats(l);
      if (withInjuries) ensureInjuries(l);
    }
    return unsub;
  }, [leagues.join(','), withInjuries]);

  return getLiveSources();
}
