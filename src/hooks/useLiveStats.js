import { useEffect, useState } from 'react';
import { ensureTeamStats, ensureInjuries, refreshInjuries, subscribe, getLiveSources } from '../data/liveStats.js';

const INJURY_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

// Triggers the worker fetch for team stats and ESPN fetch for injuries.
// Re-renders when new data arrives. Injuries auto-refresh every 10 min.
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

  // Background injury refresh — catches late scratches and status changes
  // without requiring a manual page reload.
  useEffect(() => {
    if (!withInjuries) return;
    const timer = setInterval(() => {
      for (const l of leagues) refreshInjuries(l);
    }, INJURY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [leagues.join(','), withInjuries]);

  return getLiveSources();
}
