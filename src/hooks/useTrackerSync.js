import { useEffect, useState } from 'react';
import { reconcileAndNotify, getSyncMeta, subscribeSync } from '../data/trackerSync.js';

// Sync interval — re-runs reconcile while the app stays open.
// 15 min is plenty since games take 2+ hours to finalize after tipoff.
const INTERVAL_MS = 15 * 60 * 1000;

// Module-level guard so multiple components don't double-fire.
let activeRun = null;
let lastResult = null;

async function runOnce() {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    try {
      lastResult = await reconcileAndNotify();
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
// Runs on mount + every INTERVAL_MS while mounted.
export function useTrackerSyncTicker({ enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return;
    runOnce();
    const t = setInterval(runOnce, INTERVAL_MS);
    return () => clearInterval(t);
  }, [enabled]);
}

// Read-only subscription — invoke from any component that wants to
// reflect sync status. Re-renders when a sync finishes.
export function useSyncStatus() {
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

  return {
    lastSyncAt: meta.lastSyncAt || null,
    lastAddedCount: meta.lastAddedCount || 0,
    lastSkipped: meta.lastSkipped || null,
    running,
    syncNow: runOnce,
  };
}
