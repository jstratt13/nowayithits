// ─────────────────────────────────────────────────────────────────────────
//  App-wide "refresh now" signal.
//
//  The installed app (Home Screen PWA) has no browser reload button, and
//  iOS keeps it suspended in the background, so picks went stale until the
//  app was force-closed. Every data hook listens for this event and
//  re-fetches immediately. It fires from:
//    • the ↻ button in the header
//    • pull-to-refresh (installed app)
//    • returning to the app after it was in the background ≥ 30 s
//  On a manual refresh or reopen we also check whether a new version of
//  the app was deployed and, if so, reload the page to pick it up.
// ─────────────────────────────────────────────────────────────────────────

export const REFRESH_EVENT = 'nwih:refresh';

export function requestRefresh(reason = 'manual') {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: { reason, at: Date.now() } }));
}

// Subscribe; returns an unsubscribe function (use inside useEffect).
export function onRefresh(cb) {
  const h = () => cb();
  window.addEventListener(REFRESH_EVENT, h);
  return () => window.removeEventListener(REFRESH_EVENT, h);
}

// Fire a refresh when the app comes back to the foreground after being
// hidden for a while (iOS resumes PWAs with stale state). Call once.
const RESUME_AFTER_MS = 30 * 1000;
let installed = false;
export function installResumeRefresh() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let hiddenAt = document.hidden ? Date.now() : null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= RESUME_AFTER_MS) resumeRefresh();
    hiddenAt = null;
  });
  // Safari restoring the page from its back/forward cache.
  window.addEventListener('pageshow', (e) => { if (e.persisted) resumeRefresh(); });
}

// Reopening the app refreshes data AND picks up a newly deployed version
// (iOS resumes Home Screen apps with the old code otherwise — a deploy
// only showed up after force-closing the app or tapping ↻).
async function resumeRefresh() {
  requestRefresh('resume');
  if (await newVersionAvailable()) window.location.reload();
}

// Has a newer build been deployed? Compares the entry script in the live
// index.html with the one this page loaded. Production only.
export async function newVersionAvailable() {
  if (!import.meta.env.PROD) return false;
  try {
    const current = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src');
    if (!current) return false;
    const res = await fetch(`${import.meta.env.BASE_URL}index.html?_v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const html = await res.text();
    const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
    return !!m && m[1] !== current;
  } catch {
    return false;
  }
}
