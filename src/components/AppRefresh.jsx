import { useEffect, useRef, useState } from 'react';
import { newVersionAvailable, requestRefresh } from '../data/refreshBus.js';

// Manual refresh: re-fetch every data source in place (no page reload), and
// if a new build has been deployed since the app opened, reload to get it.
async function refreshNow() {
  requestRefresh('manual');
  if (await newVersionAvailable()) window.location.reload();
}

// ↻ button for the header.
export function RefreshButton() {
  const [spinning, setSpinning] = useState(false);
  async function onClick() {
    if (spinning) return;
    setSpinning(true);
    await refreshNow();
    setTimeout(() => setSpinning(false), 900);
  }
  return (
    <button type="button" className={'nav-refresh' + (spinning ? ' spinning' : '')} onClick={onClick}
      aria-label="Refresh picks and scores" title="Refresh picks and scores">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
      </svg>
    </button>
  );
}

// Pull down from the top of the page to refresh — installed app only (a
// browser tab already has its own reload). Purely visual pull; on release
// past the threshold it triggers the same refresh as the ↻ button.
const THRESHOLD = 70;
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!isStandalone()) return;
    const down = (e) => {
      if (window.scrollY > 0 || e.touches.length !== 1) { start.current = null; return; }
      start.current = e.touches[0].clientY;
    };
    const move = (e) => {
      if (start.current == null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) { pullRef.current = 0; setPull(0); return; }
      pullRef.current = Math.min(120, dy * 0.5);
      setPull(pullRef.current);
    };
    const up = async () => {
      const p = pullRef.current;
      start.current = null; pullRef.current = 0; setPull(0);
      if (p >= THRESHOLD) {
        setBusy(true);
        await refreshNow();
        setTimeout(() => setBusy(false), 900);
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, []);

  if (!pull && !busy) return null;
  const ready = pull >= THRESHOLD;
  return (
    <div className="ptr" style={{ transform: `translate(-50%, ${busy ? 16 : pull / 2}px)` }} role="status" aria-live="polite">
      <span className={'ptr-icon' + (busy ? ' spinning' : '')} style={{ transform: busy ? undefined : `rotate(${pull * 3}deg)` }}>↻</span>
      <span className="ptr-label">{busy ? 'Refreshing…' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
    </div>
  );
}
