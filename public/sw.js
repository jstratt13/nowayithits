// ─────────────────────────────────────────────────────────────────────────
//  No Way It Hits — service worker (installable app shell).
//
//  Phase 1: makes the site installable and keeps the shell loading when the
//  connection drops. Deliberately conservative so a deploy is never hidden
//  behind a stale cache:
//    • page loads (navigations) → network first, cached copy only offline
//    • hashed build assets (/assets/*) → cache first (filenames change on
//      every build, so a cached one can never be stale)
//    • everything else (worker API, ESPN, fonts) → straight to the network
//  Phase 3 adds `push` + `notificationclick` handlers here.
// ─────────────────────────────────────────────────────────────────────────
const CACHE = 'nwih-shell-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API / ESPN / fonts: network only

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
