// Offline cache: network-first for the page, stale-while-revalidate for scripts and assets.
const CACHE = 'skywright-v3';
// real-world location data (assets/real/, ~15 MB a place): not precached, cached on first use in its own cache,
// which survives releases so a new version doesn't download the mountains again
const REAL = 'skywright-real-v1';
// hangar textures and props (assets/hangar/, 3-8 MB by quality): also cached on first use, in a cache that survives releases
const HANGAR = 'skywright-hangar-v1';
// geodata streamed past a real place's baked squares (src/geostream.js: elevation and satellite tiles from other hosts):
// fetched and cached by the game itself in this cache, which also survives releases. Not intercepted here.
const GEO = 'skywright-geo-v1';
const GEO_HOSTS = /^https:\/\/(s3\.amazonaws\.com\/elevation-tiles-prod|tiles\.maps\.eox\.at)\//;
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/three.module.min.js', 'vendor/peerjs.min.js', 'vendor/addons/Sky.js', 'vendor/addons/BufferGeometryUtils.js', 'vendor/addons/OrbitControls.js', 'vendor/addons/RoomEnvironment.js',
  ...[].map((f) => `src/${f}.js`),
  // CC0 ground textures (keep in sync with TEXTURE_FILES in src/terrainTex.js)
  ...['aerial_grass_rock', 'aerial_rocks_02', 'aerial_beach_01', 'dry_ground_rocks', 'cliff_side'].flatMap((n) => [`tex/${n}_d.jpg`, `tex/${n}_n.jpg`]),
  // foliage atlas (src/flora.js): the small one is precached; the 2048 one (high / ultra quality) is cached on first use
  'assets/flora/foliage_1024.webp'];
// recorded sounds: whatever assets/sfx/index.json lists (built by tools/sfx/process.py), so this list never goes stale
const sfxFiles = () => fetch('assets/sfx/index.json', { cache: 'reload' }).then((r) => r.json()).then((ix) => ['assets/sfx/index.json', ...Object.keys(ix).map((n) => `assets/sfx/${n}.ogg`)]).catch(() => []);
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(async (c) => c.addAll([...FILES, ...(await sfxFiles())].map((f) => new Request(f, { cache: 'reload' }))) /* bypass the HTTP cache so a new deploy precaches fresh files */).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== REAL && k !== HANGAR && k !== GEO).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  if (req.url.includes('/assets/music/') || GEO_HOSTS.test(req.url)) return; // streamed media uses range requests: leave them to the network + HTTP cache
  const isDoc = req.mode === 'navigate';
  const store = req.url.includes('/assets/real/') ? REAL : req.url.includes('/assets/hangar/') ? HANGAR : CACHE;
  const put = (resp) => { if (resp.ok) { const copy = resp.clone(); caches.open(store).then((c) => c.put(req, copy)); } return resp; };
  // Code and styles (and the page) are network-first, so one load always gets one consistent version: with
  // stale-while-revalidate each file updated on its own, and a release could run new main.js with an old style.css.
  // The cache answers when offline, or if the network is slower than 3 s.
  const code = isDoc || /\.(js|css|html|webmanifest)(\?|$)/.test(new URL(req.url).pathname) && new URL(req.url).origin === location.origin;
  if (code) {
    e.respondWith(caches.match(req).then((cached) => {
      const net = fetch(req, { cache: 'no-cache' }).then(put);
      const fallback = () => cached || (isDoc ? caches.match('index.html') : undefined) || net;
      if (!cached && !isDoc) return net.catch(() => caches.match(req));
      return Promise.race([net, new Promise((res) => setTimeout(() => res(null), 3000))]).then((r) => r || fallback()).catch(fallback);
    }));
    return;
  }
  // everything else (textures, models, real-world data, sounds): stale-while-revalidate
  e.respondWith(caches.match(req).then((cached) => {
    const net = fetch(req, { cache: 'no-cache' }).then(put).catch(() => cached); // revalidate (cheap 304s), never trust a stale HTTP cache
    return cached || net;
  }));
});
