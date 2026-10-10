/* Deepreading service worker：应用壳离线缓存 */
const CACHE = 'deepreading-v3.42';
const CORE = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './banner-ink.jpg',
  './css/styles.css',
  './js/util.js', './js/app.js', './js/ai.js', './js/ambience.js', './js/voice.js',
  './js/paginate.js', './js/flip.js',
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
  // 分享目标：外部 App 分享文件给 DeepRead（POST multipart），暂存后跳回应用入库
  if(e.request.method==='POST' && url.pathname.endsWith('/index.html')){
    e.respondWith((async()=>{
      try{
        const fd=await e.request.formData();
        const files=fd.getAll('book').filter(f=>f instanceof File && f.size>0);
        if(files.length){
          const c=await caches.open('dr-share');
          for(const f of files){
            await c.put('share/'+Date.now()+'_'+Math.random().toString(36).slice(2)+'/'+encodeURIComponent(f.name),
              new Response(f,{headers:{'Content-Type':f.type||'application/octet-stream'}}));
          }
        }
      }catch(_){}
      return Response.redirect(new URL('./index.html?shared=1', self.location.href).href, 303);
    })());
    return;
  }
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
