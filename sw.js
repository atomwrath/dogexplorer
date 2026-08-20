/* Offline cache. Bump CACHE when you ship — old caches are dropped on activate. */
const CACHE = 'pup-city-v1';
const ASSETS = [
  './', './index.html',
  './city/', './city/index.html',
  './creator/', './creator/index.html',
  './styles/base.css', './styles/city.css', './styles/creator.css',
  './vendor/three.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS).catch(()=>{}))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Network-first for HTML/JS so updates land immediately; cache-first for the rest. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const isCode = req.mode === 'navigate' || /\.(js|css|html)$/.test(new URL(req.url).pathname);
  if(isCode){
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
  }
});
