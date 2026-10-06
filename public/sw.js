// App-shell service worker: precache the shell, serve static assets stale-while-revalidate,
// never cache the API or uploads-by-default (uploads are immutable, so cache-first is fine).
const CACHE = 'flipp-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/theme.js', '/app.js', '/study.js', '/md.js', '/lib.js', '/ui.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/vendor/htm-preact.js', '/vendor/marked.js', '/vendor/purify.js',
  '/vendor/katex/katex.mjs', '/vendor/katex/katex.min.css',
];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    if (url.pathname.startsWith('/uploads/')) return hit || fresh;
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
