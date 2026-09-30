/* Deepreading service worker：应用壳离线缓存 */
const CACHE = 'deepreading-v3.9';
const CORE = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './banner-ink.jpg',
  './css/styles.css',
  './js/app.js', './js/ai.js', './js/ambience.js', './js/voice.js',
  './lib/pdf.min.js', './lib/pdf.worker.min.js',
  './lib/jszip.min.js', './lib/mammoth.min.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // 只缓存本站与明确的 CDN 库
        const u = new URL(e.request.url);
        const okHost = u.origin === self.location.origin ||
          /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)$/.test(u.hostname);
        if (okHost && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
