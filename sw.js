/* Deepreading service worker：应用壳离线缓存 */
const CACHE = 'deepreading-v3.13';
const CORE = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './banner-ink.jpg',
  './css/styles.css',
  './js/util.js', './js/app.js', './js/ai.js', './js/ambience.js', './js/voice.js',
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
  const url = new URL(e.request.url);
  // 跨域请求（ElevenLabs/Gemini 等 API）：不拦截，直接走网络，失败如实抛错
  // （旧版曾把失败的 API 请求兜底成首页 HTML，导致"HTTP 200 却返回网页"的假成功）
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        // 只有页面导航才兜底到首页；JS/CSS 等资源失败就如实失败
        const accept = e.request.headers.get('accept') || '';
        if (e.request.mode === 'navigate' || accept.includes('text/html')) {
          return caches.match('./index.html');
        }
        throw new TypeError('network failed: ' + url.pathname);
      });
    })
  );
});
