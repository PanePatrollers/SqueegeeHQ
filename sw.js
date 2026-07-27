/* Minimal service worker: caches the app shell so the icon/launch
   doesn't feel broken with no signal. Live data always comes from
   Firebase over the network, not from this cache. */
const CACHE = 'squeegeehq-v3';
const SHELL = ['./index.html','./styles.css','./app.js','./firebase-config.js','./manifest.json'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return; // let Firebase/Google Maps requests pass through untouched
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
