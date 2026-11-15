// Offline cache: network-first for the page, stale-while-revalidate for scripts and assets.
const CACHE = 'skywright-v3';
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/three.module.min.js', 'vendor/peerjs.min.js', 'vendor/addons/Sky.js', 'vendor/addons/BufferGeometryUtils.js', 'vendor/addons/OrbitControls.js', 'vendor/addons/RoomEnvironment.js',
  ...['postprocessing/EffectComposer', 'postprocessing/RenderPass', 'postprocessing/UnrealBloomPass', 'postprocessing/OutputPass', 'postprocessing/ShaderPass', 'postprocessing/Pass', 'postprocessing/MaskPass', 'shaders/CopyShader', 'shaders/LuminosityHighPassShader', 'shaders/OutputShader'].map((f) => `vendor/addons/${f}.js`),
  ...['main', 'parts', 'design', 'aircraft', 'world', 'billboard', 'materials', 'noise', 'effects', 'audio', 'controls', 'hud', 'cameras', 'missions', 'hangar', 'traffic', 'shaders', 'post', 'roads', 'vehicles', 'flora', 'towns', 'version', 'tiles', 'net', 'remote'].map((f) => `src/${f}.js`)];
// recorded sounds: whatever assets/sfx/index.json lists (built by tools/sfx/process.py), so this list never goes stale
const sfxFiles = () => fetch('assets/sfx/index.json', { cache: 'reload' }).then((r) => r.json()).then((ix) => ['assets/sfx/index.json', ...Object.keys(ix).map((n) => `assets/sfx/${n}.ogg`)]).catch(() => []);
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(async (c) => c.addAll([...FILES, ...(await sfxFiles())].map((f) => new Request(f, { cache: 'reload' }))) /* bypass the HTTP cache so a new deploy precaches fresh files */).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const isDoc = req.mode === 'navigate';
  e.respondWith(isDoc
    ? fetch(req, { cache: 'no-cache' }).then((r) => { caches.open(CACHE).then((c) => c.put(req, r.clone())); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    : caches.match(req).then((cached) => {
      const net = fetch(req, { cache: 'no-cache' }).then((resp) => /* revalidate with the server (cheap 304s), never trust a stale HTTP cache */ { if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return resp; }).catch(() => cached);
      return cached || net; // stale-while-revalidate: next load gets the update
    }));
});
