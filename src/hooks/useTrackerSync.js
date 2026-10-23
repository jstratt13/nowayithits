import { useCallback, useEffect, useState } from 'react';
import { reconcileAndNotify, getSyncMeta, subscribeSync } from '../data/trackerSync.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useFetchWithAuth } from '../auth/useFetchWithAuth.js';

// Sync interval — re-runs reconcile while the app stays open.
// 15 min is plenty since games take 2+ hours to finalize after tipoff.
const INTERVAL_MS = 15 * 60 * 1000;

// Module-level guard so multiple components don't double-fire.
let activeRun = null;
let lastResult = null;

async function runOnce(authFetch) {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    try {
      lastResult = await reconcileAndNotify({ authFetch });
    } catch (e) {
      lastResult = { error: e.message || String(e) };
    } finally {
      activeRun = null;
    }
    return lastResult;
  })();
  return activeRun;
}

// Ticker — invoke ONCE from a top-level component (App.jsx).
// Runs on mount + every INTERVAL_MS while mounted, AND whenever auth
// state flips (login or token rotation) so the next tick uses the
// fresh credentials.
export function useTrackerSyncTicker({ enabled = true } = {}) {
  const { token, status } = useAuth();
  const authFetch = useFetchWithAuth();
  useEffect(() => {
    if (!enabled) return;
    if (status !== 'authenticated' || !token) return;
    runOnce(authFetch);
    const t = setInterval(() => runOnce(authFetch), INTERVAL_MS);
    return () => clearInterval(t);
  }, [enabled, token, status, authFetch]);
}

// Read-only subscription — invoke from any component that wants to
// reflect sync status. Re-renders when a sync finishes.
export function useSyncStatus() {
  const authFetch = useFetchWithAuth();
  const [meta, setMeta] = useState(() => getSyncMeta());
  const [running, setRunning] = useState(() => !!activeRun);

  useEffect(() => {
    const unsub = subscribeSync(() => {
      setMeta(getSyncMeta());
      setRunning(!!activeRun);
    });
    // Poll the running flag too so the badge can flip even between bus events.
    const t = setInterval(() => setRunning(!!activeRun), 1000);
    return () => { unsub(); clearInterval(t); };
  }, []);

  // syncNow binds the current authFetch so callers don't have to thread
  // it. Recomputed if the token changes mid-session.
  const syncNow = useCallback(() => runOnce(authFetch), [authFetch]);

  return {
    lastSyncAt: meta.lastSyncAt || null,
    lastAddedCount: meta.lastAddedCount || 0,
    lastSkipped: meta.lastSkipped || null,
    running,
    syncNow,
  };
}
