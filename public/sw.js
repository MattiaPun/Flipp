// Service worker: precached app shell (stale-while-revalidate), network-first caching of the study data you
// opened recently (so you can keep studying offline), immutable uploads cache-first, and push notifications.
const CACHE = 'flipp-v4';
const API_CACHE = 'flipp-api';
const SHELL = [
  '/', '/index.html', '/styles.css', '/theme.js', '/app.js', '/ui.js', '/md.js', '/lib.js', '/srs.js', '/offline.js',
  '/pages/auth.js', '/pages/home.js', '/pages/course.js', '/pages/set.js', '/pages/study.js', '/pages/settings.js', '/pages/admin.js',
  '/pages/backups.js', '/pages/browse.js', '/pages/stats.js', '/pages/groups.js', '/pages/transfer.js', '/pages/reminders.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/vendor/htm-preact.js', '/vendor/marked.js', '/vendor/purify.js',
  '/vendor/katex/katex.mjs', '/vendor/katex/katex.min.css', '/vendor/nunito/wght.css', '/vendor/nunito/files/nunito-latin-wght-normal.woff2',
];
// GET endpoints worth keeping for offline study.
const OFFLINE_API = /^\/api\/(auth\/me|courses|courses\/\d+|sets\/\d+|study|stats|tags)$/;

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_API.test(url.pathname)) return;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(API_CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.open(API_CACHE).then((c) => c.match(e.request)).then((hit) => hit || Response.error())));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // Uploads never change under the same name: cache first. App code is network first, so a deploy never
  // runs new HTML against old modules; the cache is only the offline fallback.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const fresh = () => fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    if (url.pathname.startsWith('/uploads/')) return (await cache.match(e.request)) || fresh();
    return fresh().catch(async (err) => (await cache.match(e.request)) || Promise.reject(err));
  }));
});

self.addEventListener('message', (e) => { if (e.data === 'logout') caches.delete(API_CACHE); });

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Flipp', { body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' }, tag: 'flipp-reminder' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => new URL(c.url).origin === location.origin);
    if (win) { win.navigate(url); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
