const CACHE = 'montessori-v1';
const ASSETS = [
  '/montessori-newest-mvp/',
  '/montessori-newest-mvp/index.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // API-Calls nie cachen
  if (e.request.url.includes('workers.dev') || e.request.url.includes('anthropic')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
