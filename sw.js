// Offline cache: network-first for the page, stale-while-revalidate for scripts and assets.
const CACHE = 'skywright-v1';
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/three.module.min.js', 'vendor/addons/Sky.js', 'vendor/addons/BufferGeometryUtils.js', 'vendor/addons/OrbitControls.js', 'vendor/addons/RoomEnvironment.js',
  ...['main', 'parts', 'design', 'aircraft', 'world', 'billboard', 'materials', 'noise', 'effects', 'audio', 'controls', 'hud', 'cameras', 'missions', 'hangar', 'traffic'].map((f) => `src/${f}.js`)];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const isDoc = req.mode === 'navigate';
  e.respondWith(isDoc
    ? fetch(req).then((r) => { caches.open(CACHE).then((c) => c.put(req, r.clone())); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    : caches.match(req).then((cached) => {
      const net = fetch(req).then((resp) => { if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return resp; }).catch(() => cached);
      return cached || net; // stale-while-revalidate: next load gets the update
    }));
});
