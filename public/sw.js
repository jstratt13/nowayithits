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
//  Phase 3: `push` shows game alerts; tapping one opens the Updates page.
// ─────────────────────────────────────────────────────────────────────────
const CACHE = 'nwih-shell-v2';
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

// ── Push alerts (app phase 3) ─────────────────────────────────────────
// Payload (worker/src/push.js buildNotification): { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let data;
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'No Way It Hits', body: event.data?.text() || '' }; }
  const scope = self.registration.scope;
  event.waitUntil(self.registration.showNotification(data.title || 'No Way It Hits', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: scope + 'icons/icon-192.png',
    badge: scope + 'icons/icon-192.png',
    data: { url: scope + (data.url || '#/updates') },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ('navigate' in w) await w.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
