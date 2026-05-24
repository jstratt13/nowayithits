// Pulls the worker's server-computed predictions for a given (league, date)
// and re-fetches every 10 minutes — same cadence as injuries (useLiveStats)
// and the worker's own cron. The returned `byGameId` map is keyed by ESPN
// event id so GameCard lookups are O(1) against `game.id`.
//
// Why this exists (see project handoff, "shared lock" item):
//   Before this hook, every browser computed its own predictions at page
//   load and froze them in localStorage. Two visitors with different load
//   times got different "locked" snapshots for the same game. The worker
//   now owns the authoritative snapshot — this hook just consumes it.
//
// Behavior:
//   status === 'loading'  — first fetch in flight
//   status === 'ok'       — at least one fetch has succeeded; byGameId is current
//   status === 'error'    — last fetch failed; byGameId holds last good data (or {} on first failure)
//   status === 'disabled' — VITE_WORKER_URL is unset (local dev without a worker)
//
// On error or 'disabled', GameCards fall through to their "Loading…" state.
// They NEVER fall back to local compute — that would re-introduce the
// per-device divergence we're trying to eliminate.

import { useEffect, useState } from 'react';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';
const POLL_MS = 10 * 60 * 1000; // 10 minutes

function ymd(date) {
  // Same convention as src/data/espn.js — local calendar day formatted as
  // YYYYMMDD. For US users this lines up with the ET dates the worker
  // buckets predictions under.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function useSharedPredictions(league, date) {
  const [byGameId, setByGameId] = useState({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);

  const dateStr = date ? ymd(date) : '';

  useEffect(() => {
    if (!WORKER_URL) {
      setStatus('disabled');
      setByGameId({});
      return;
    }
    if (!league || !dateStr) return;

    let cancelled = false;

    async function fetchOnce() {
      try {
        // Per-hour cache-buster so neither the browser nor Cloudflare's
        // edge serves a stale response. The worker reads from KV so its
        // own freshness is independent of HTTP cache.
        const hourSlot = Math.floor(Date.now() / 3_600_000);
        const url = `${WORKER_URL}/predictions/${league}?date=${dateStr}&_h=${hourSlot}`;
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(`worker → ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        if (!body.ok) throw new Error(body.error || 'worker error');

        const map = {};
        for (const g of body.games || []) {
          if (g.gameId) map[g.gameId] = g;
        }
        setByGameId(map);
        setMeta({ computedAt: body.computedAt, date: body.date });
        setStatus('ok');
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e.message || String(e));
        setStatus((s) => (s === 'ok' ? 'ok' : 'error'));
        // ↑ once we've ever had a good fetch, keep showing it even if a
        // refresh fails — predictions are 10-min-fresh by design, a hiccup
        // shouldn't blank the UI.
      }
    }

    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [league, dateStr]);

  return { byGameId, status, error, meta };
}
