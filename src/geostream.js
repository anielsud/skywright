// Real geodata streamed at runtime, for the land past the edge of a real place's baked squares (src/realworld.js).
// The bake stops at its coarse square (120-240 km); an SR-71 crosses that in a couple of minutes, and the edge row used
// to smear outward forever (#151). Past it the same two sources the bake reads are fetched as web-mercator tiles while
// flying: heights from AWS Terrain Tiles (Terrarium PNG: h = R*256 + G + B/256 - 32768) and Sentinel-2 cloudless 2016 by
// EOX (CC BY 4.0) for the colour, graded like the bake's (lift_shadows) and tinted to match the baked imagery at the
// square's edge. Three zoom levels: z10 (~110-150 m a pixel, the coarse square's own detail) near the camera for the
// streamed tiles, physics and the minimap; z8 for the far field out to ~70 km; z6 under everything (a few tiles cover
// the whole horizon). A sample takes the finest level that has arrived. Tiles are fetched ahead of the plane (biased
// along its velocity) and decoded in a worker; the Cache API keeps them for repeat flights and a briefly-offline tablet.
// When a tile arrives that an earlier sample had wanted and missed, the area those samples covered is handed back to
// the World (invalidateArea) to rebuild: only ground built from something worse is ever rebuilt. Nothing here throws:
// offline, a sample falls back to the nearest coarser level, then to the baked square's mean edge colour and height.
import { now as clock } from './stepClock.js';

const ELEV = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`;
export const geoTileUrl = (kind, z, x, y) => (kind === 'e' ? ELEV : IMG)(z, x, y); // (tools/realworld/geotiles.mjs bakes these)
export const GEO_CACHE = 'skywright-geo-v1'; // (sw.js keeps it across releases and leaves these requests to us)
const CACHE_MAX = 1500; // tiles kept in the Cache API (~70 KB each)
const R_EARTH = 6371008.8, D2R = Math.PI / 180;
// zoom levels, finest first; r: prefetch radius around the camera (m), lead: how far ahead along the velocity (s)
const LEVELS = [{ z: 10, r: 30000, lead: 25 }, { z: 8, r: 80000, lead: 30 }, { z: 6, r: 0, lead: 40 }]; // (z6: the far field's radius + 40 km)
const MEM_MAX = 120; // decoded tiles kept in memory (a z10 pair is ~450 KB)
const INFLIGHT = 6;

// The worker: fetch (Cache API first), decode off the main thread, convert to heights / graded colours. carve: the
// source of realworld.js carveFlatSea, which gives Terrarium's flat sea at the water level (open ocean is stored at
// exactly 0 m, e.g. off New York) a sea floor, here per tile (#153)
const workerSrc = (carve) => `${carve}

const CACHE = ${JSON.stringify(GEO_CACHE)}, MAX = ${CACHE_MAX};
let cache = null, puts = 0;
const open = async () => { try { return cache || (cache = await caches.open(CACHE)); } catch (e) { return null; } };
async function trim() { const c = await open(); if (!c) return; try { const ks = await c.keys(); for (let k = 0; k < ks.length - MAX * 0.8 && ks.length > MAX; k++) await c.delete(ks[k]); } catch (e) {} }
setTimeout(trim, 15000);
async function blobOf(url) {
  const c = await open();
  if (c) try { const hit = await c.match(url); if (hit) return { blob: await hit.blob(), net: 0 }; } catch (e) {}
  const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (c) try { await c.put(url, r.clone()); if (++puts % 200 === 0) trim(); } catch (e) {}
  const blob = await r.blob();
  return { blob, net: blob.size };
}
// the bake's lift_shadows (tools/realworld/bake.py): shade lit only by blue skylight lifted towards the sunlit colour
function grade(d, out) {
  for (let k = 0, o = 0; k < d.length; k += 4, o += 3) {
    const r = d[k], g = d[k + 1], b = d[k + 2], L = r * 0.3 + g * 0.59 + b * 0.11;
    let s = Math.min(1, Math.max(0, (60 - L) / 45)); s = s * s * (3 - 2 * s);
    s *= 1 - Math.min(1, Math.max(0, (b - g * 1.1) / 20));
    const m = 1 + 0.9 * s;
    out[o] = Math.min(255, r * m * (1 + 0.12 * s) + 0.5); out[o + 1] = Math.min(255, g * m + 0.5); out[o + 2] = Math.min(255, b * m * (1 - 0.42 * s) + 0.5);
  }
}
async function decode(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = new OffscreenCanvas(256, 256), g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 256, 256); bmp.close?.();
  return g.getImageData(0, 0, 256, 256).data;
}
function convert(kind, d, o) {
  if (kind === 'e') {
    const H = new Float32Array(65536); for (let k = 0; k < 65536; k++) H[k] = d[k * 4] * 256 + d[k * 4 + 1] + d[k * 4 + 2] / 256 - 32768;
    if (o) carveFlatSea({ n: 256, H, sp: o.sp }, o.wl, 0.05, 25, o.minRun);
    return H;
  }
  const C = new Uint8Array(65536 * 3); grade(d, C); return C;
}
self.onmessage = async (e) => {
  const { id, url, kind, o, seed } = e.data; // seed: the tile's file from the place's geo.bin (no fetch, same decode)
  try { const { blob, net } = seed ? { blob: seed, net: 0 } : await blobOf(url); const data = convert(kind, await decode(blob), o); self.postMessage({ id, ok: true, data, net, seed: !!seed }, [data.buffer]); }
  catch (err) { self.postMessage({ id, ok: false, err: String(err && err.message || err) }); }
};`;
// (the same code on the main thread where a worker can't decode: no OffscreenCanvas)
let mainDecode = null;
function mainThread(src) {
  if (mainDecode) return mainDecode;
  const { blobOf, convert } = new Function('self', src + '\nreturn { blobOf, convert };')({});
  mainDecode = async (url, kind, o, seed) => {
    const { blob, net } = seed ? { blob: seed, net: 0 } : await blobOf(url);
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, 256, 256); bmp.close?.();
    return { data: convert(kind, g.getImageData(0, 0, 256, 256).data, o), net, seed: !!seed };
  };
  return mainDecode;
}

export class GeoStream {
  // meta: the place's meta.json (lat0, lon0, north); inset: [x0, z0, x1, z1], the area the baked squares cover by
  // themselves (no tile wholly inside it is fetched); fallback: { h, c: [r, g, b] 0..1 } for ground with no data at all;
  // carve: (G, wl, k, dmax, minRun) => void, sinks flat sea at the water level wl (realworld.js carveFlatSea)
  constructor(meta, inset, fallback, carve, wl) {
    this.src = workerSrc(carve ? carve.toString() : 'function carveFlatSea() {}'); this.wl = wl;
    this.lat0 = meta.lat0; this.lon0 = meta.lon0;
    const th = (meta.north || 0) * D2R; this.cs = Math.cos(th); this.sn = Math.sin(th);
    this.kx = 1 / (R_EARTH * Math.cos(meta.lat0 * D2R) * D2R); this.kz = 1 / (R_EARTH * D2R); // m -> degrees
    this.inset = inset; this.fb = fallback;
    this.tiles = new Map(); // key -> { d: data, Z, kind, used }
    this.pending = new Map(); // key -> { Z, tx, ty, kind, at } (in flight)
    this.failed = new Map(); this.tries = new Map(); // key -> retry time (ms), failures so far
    this.miss = new Map(); // key -> [x0, z0, x1, z1]: the area of samples that wanted this tile and went without
    this.boxes = new Map(); // 'Z,tx,ty' -> the tile's bounds in the game frame
    this.queue = []; this.want = new Set(); this.rects = [];
    this.memo = { e: [null, -1], i: [null, -1] };
    this.tint = [1, 1, 1]; this.tintDone = false;
    this.clock = 0; this.lastPlan = -1e9; this.cam = null; this.vel = { x: 0, z: 0 }; this.lastT = 0;
    this.seeded = new Map(); // url -> Blob: tile files shipped with the place (seed)
    this.stats = { netBytes: 0, netTiles: 0, cacheTiles: 0, seedTiles: 0, fails: 0, invalidations: 0, ms: 0, frames: 0 };
    this.onInvalidate = null; this.radius = () => 130000; this.ids = 0; this.cbs = new Map();
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') throw new Error('no worker decode');
      const url = URL.createObjectURL(new Blob([this.src], { type: 'text/javascript' }));
      this.worker = new Worker(url); URL.revokeObjectURL(url);
      this.worker.onmessage = (e) => { const cb = this.cbs.get(e.data.id); this.cbs.delete(e.data.id); cb?.(e.data); };
      this.worker.onerror = () => { this.worker?.terminate(); this.worker = null; }; // (main-thread decode from here on)
    } catch (e) { this.worker = null; }
  }

  // ---- projection: the game frame <-> lat / lon (tools/realworld/bake.py to_latlon / to_local), web mercator 0..1
  ll(x, z) { const E = x * this.cs - z * this.sn, N = -x * this.sn - z * this.cs; return [this.lat0 + N * this.kz, this.lon0 + E * this.kx]; }
  local(lat, lon) { const E = (lon - this.lon0) / this.kx, N = (lat - this.lat0) / this.kz; return [E * this.cs - N * this.sn, -(E * this.sn + N * this.cs)]; }
  merc(x, z, out) {
    const E = x * this.cs - z * this.sn, N = -x * this.sn - z * this.cs, lat = this.lat0 + N * this.kz, lon = this.lon0 + E * this.kx;
    const s = Math.sin(lat * D2R);
    out[0] = (lon + 180) / 360; out[1] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return out;
  }
  box(Z, tx, ty) {
    const k = Z + ',' + tx + ',' + ty; let b = this.boxes.get(k); if (b) return b;
    const n = 2 ** Z, lon = (t) => t / n * 360 - 180, lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) / D2R;
    const P = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]].map(([a, c]) => this.local(lat(c), lon(a)));
    b = [Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])), Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1]))];
    if (this.boxes.size > 4000) this.boxes.clear();
    this.boxes.set(k, b); return b;
  }
  key(kind, Z, tx, ty) { return ((Z * 4096 + ty) * 4096 + tx) * 2 + (kind === 'i' ? 1 : 0); }

  // ---- sampling (synchronous, cheap: called for every vertex and texel of the ground built outside the baked squares)
  tile(kind, Z, tx, ty) {
    const k = this.key(kind, Z, tx, ty), m = this.memo[kind];
    if (m[1] === k) return m[0];
    const t = this.tiles.get(k); if (t) { t.used = this.clock; m[0] = t; m[1] = k; }
    return t || null;
  }
  noteMiss(kind, Z, tx, ty, x, z) {
    const k = this.key(kind, Z, tx, ty), r = this.miss.get(k);
    if (r) { if (x < r[0]) r[0] = x; if (z < r[1]) r[1] = z; if (x > r[2]) r[2] = x; if (z > r[3]) r[3] = z; return; }
    if (this.miss.size > 3000) this.miss.delete(this.miss.keys().next().value);
    this.miss.set(k, [x, z, x, z]);
  }
  // bilinear at global pixel (fx, fy) of level Z, crossing into neighbouring tiles at the edges; null when the tile is missing
  // (ch: channels, o: channel; pixel centres at +0.5, like the bake's bilinear)
  at(kind, Z, fx, fy, ch, o) {
    const gx = Math.floor(fx), gy = Math.floor(fy), u = fx - gx, v = fy - gy, tx = gx >> 8, ty = gy >> 8, lx = gx & 255, ly = gy & 255;
    const t = this.tile(kind, Z, tx, ty); if (!t) return null;
    const d = t.d, k = (ly * 256 + lx) * ch + o;
    if (lx < 255 && ly < 255) return (d[k] * (1 - u) + d[k + ch] * u) * (1 - v) + (d[k + 256 * ch] * (1 - u) + d[k + 257 * ch] * u) * v;
    const px = (a, b) => { const t2 = this.tile(kind, Z, a >> 8, b >> 8); return t2 ? t2.d[(((b & 255) * 256) + (a & 255)) * ch + o] : d[k]; }; // (a missing neighbour: this tile's edge pixel)
    const a = d[k], b = px(gx + 1, gy), c = px(gx, gy + 1), e = px(gx + 1, gy + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
  }
  height(x, z, zMax = 10) {
    const m = this.merc(x, z, this.mm || (this.mm = [0, 0]));
    for (const L of LEVELS) {
      if (L.z > zMax) continue;
      const n = 256 * 2 ** L.z, fx = m[0] * n - 0.5, fy = m[1] * n - 0.5, h = this.at('e', L.z, fx, fy, 1, 0);
      if (h !== null) return h;
      this.noteMiss('e', L.z, Math.floor(fx) >> 8, Math.floor(fy) >> 8, x, z);
    }
    return this.fb.h;
  }
  // colour, sRGB 0..1 (graded like the bake, tinted to the baked imagery), times gain (RealData's gainS), into c
  color(x, z, c, gain, zMax = 10) {
    const m = this.merc(x, z, this.mm || (this.mm = [0, 0])), T = this.tint;
    for (const L of LEVELS) {
      if (L.z > zMax) continue;
      const n = 256 * 2 ** L.z, fx = m[0] * n - 0.5, fy = m[1] * n - 0.5, r = this.at('i', L.z, fx, fy, 3, 0);
      if (r !== null) return c.setRGB(Math.min(1, r / 255 * T[0] * gain), Math.min(1, this.at('i', L.z, fx, fy, 3, 1) / 255 * T[1] * gain), Math.min(1, this.at('i', L.z, fx, fy, 3, 2) / 255 * T[2] * gain));
      this.noteMiss('i', L.z, Math.floor(fx) >> 8, Math.floor(fy) >> 8, x, z);
    }
    const F = this.fb.c; return c.setRGB(Math.min(1, F[0] * gain), Math.min(1, F[1] * gain), Math.min(1, F[2] * gain));
  }
  // raw (untinted) colour at one level, or null: for matching the tint to the baked imagery
  rawColor(x, z, Z) {
    const m = this.merc(x, z, [0, 0]), n = 256 * 2 ** Z, fx = m[0] * n - 0.5, fy = m[1] * n - 0.5;
    const r = this.at('i', Z, fx, fy, 3, 0); if (r === null) return null;
    return [r, this.at('i', Z, fx, fy, 3, 1), this.at('i', Z, fx, fy, 3, 2)];
  }

  // ---- what to fetch: every level's tiles within its radius of the camera and of a point ahead along the velocity,
  // except those the baked squares cover by themselves. Nearest first, the coarse backdrop before everything.
  plan(cx, cz) {
    const want = [], seen = new Set(), I = this.inset;
    for (const L of LEVELS) {
      const R = L.r || this.radius() + 40000, lead = Math.min(L.lead * Math.hypot(this.vel.x, this.vel.z), R);
      const sp = Math.hypot(this.vel.x, this.vel.z) || 1, centres = [[cx, cz]];
      if (lead > 2000) centres.push([cx + this.vel.x / sp * lead, cz + this.vel.z / sp * lead]);
      const n = 2 ** L.z;
      for (const [ox, oz] of centres) {
        let mx0 = 1, my0 = 1, mx1 = 0, my1 = 0;
        for (const [a, b] of [[-R, -R], [R, -R], [-R, R], [R, R]]) { const m = this.merc(ox + a, oz + b, [0, 0]); mx0 = Math.min(mx0, m[0]); mx1 = Math.max(mx1, m[0]); my0 = Math.min(my0, m[1]); my1 = Math.max(my1, m[1]); }
        for (let ty = Math.floor(my0 * n); ty <= Math.floor(my1 * n); ty++) for (let tx = Math.floor(mx0 * n); tx <= Math.floor(mx1 * n); tx++) {
          if (ty < 0 || ty >= n) continue;
          const t = ((tx % n) + n) % n, id = L.z + ',' + t + ',' + ty; if (seen.has(id)) continue;
          const b = this.box(L.z, t, ty);
          if (b[0] >= I[0] && b[1] >= I[1] && b[2] <= I[2] && b[3] <= I[3]) continue; // all inside the baked data
          const dx = Math.max(b[0] - ox, 0, ox - b[2]), dz = Math.max(b[1] - oz, 0, oz - b[3]);
          if (Math.hypot(dx, dz) > R) continue;
          seen.add(id);
          const dc = Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cz, 0, cz - b[3]));
          want.push({ Z: L.z, tx: t, ty, pri: L.z === 6 ? dc - 1e7 : dc / (L.z === 10 ? 1 : 2) });
        }
      }
    }
    want.sort((a, b) => a.pri - b.pri);
    this.want = new Set(); this.queue = [];
    const now = clock();
    for (const w of want) for (const kind of ['e', 'i']) {
      const k = this.key(kind, w.Z, w.tx, w.ty); this.want.add(k);
      if (this.tiles.has(k) || this.pending.has(k) || (this.failed.get(k) || 0) > now) continue;
      this.queue.push({ k, kind, Z: w.Z, tx: w.tx, ty: w.ty });
    }
  }
  request(q) {
    const url = (q.kind === 'e' ? ELEV : IMG)(q.Z, q.tx, q.ty), seed = this.seeded.get(url);
    this.pending.set(q.k, q);
    // the flat sea's floor: depth by distance from the shore inside this tile (so a shore just across a tile edge
    // isn't seen: the floor drops to its 25 m within ~500 m of a shore anyway); a smaller run counts as sea at coarse zooms
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (q.ty + 0.5) / 2 ** q.Z))), o = q.kind === 'e' ? { wl: this.wl, sp: 40075016.7 * Math.cos(lat) / (256 * 2 ** q.Z), minRun: Math.max(4, 64 >> (10 - q.Z)) } : null;
    const done = (r) => { const t0 = performance.now(); this.received(q, r); this.stats.ms += performance.now() - t0; };
    if (this.worker) { const id = ++this.ids; this.cbs.set(id, done); this.worker.postMessage({ id, url, kind: q.kind, o, seed }); }
    else mainThread(this.src)(url, q.kind, o, seed).then((r) => done({ ok: true, ...r }), (e) => done({ ok: false, err: String(e) }));
  }
  received(q, r) {
    this.pending.delete(q.k);
    if (!r.ok) { this.stats.fails++; const n = (this.tries.get(q.k) || 0) + 1; this.tries.set(q.k, n); this.failed.set(q.k, clock() + Math.min(120000, 5000 * 2 ** n)); return; } // (back off: 10 s, 20 s ... 2 min)
    if (r.seed) this.stats.seedTiles++; else if (r.net) { this.stats.netBytes += r.net; this.stats.netTiles++; } else this.stats.cacheTiles++;
    this.arrive(q, r.data);
  }
  arrive(q, data) {
    this.tiles.set(q.k, { d: data, Z: q.Z, kind: q.kind, used: this.clock });
    this.memo.e[1] = this.memo.i[1] = -1;
    this.failed.delete(q.k); this.tries.delete(q.k);
    const r = this.miss.get(q.k);
    if (r) { this.miss.delete(q.k); this.rects.push(r); }
    if (q.kind === 'i' && !this.tintDone && this.matchTint) this.matchTint();
    if (this.tiles.size > MEM_MAX) this.evict();
  }
  evict() {
    const list = [...this.tiles].filter(([k]) => !this.want.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (let n = 0; n < list.length && this.tiles.size > MEM_MAX * 0.85; n++) this.tiles.delete(list[n][0]);
    this.memo.e[1] = this.memo.i[1] = -1;
  }
  // everything built from the stream: all the ground outside the inset (four slabs)
  invalidateAll() { const I = this.inset, B = 1e7; this.rects.push([-B, -B, B, I[1]], [-B, I[3], B, B], [-B, I[1], I[0], I[3]], [I[2], I[1], B, I[3]]); }

  // Once a frame (World.update): re-plan now and then, keep the requests flowing, and hand arrived areas to the World
  // to rebuild, a few per frame. All of it is small: decoding happens in the worker.
  update(cam) {
    const t0 = performance.now(), tc = clock(); this.clock++; // (stats.ms: the main thread's share of streaming, arrivals included; tc: game time under the test stepper, stepClock.js)
    if (this.cam) {
      const dt = (tc - this.lastT) / 1000;
      if (dt > 0.05) { const k = Math.min(1, dt / 2); this.vel.x += ((cam.x - this.cam.x) / dt - this.vel.x) * k; this.vel.z += ((cam.z - this.cam.z) / dt - this.vel.z) * k; this.cam = { x: cam.x, z: cam.z }; this.lastT = tc; }
    } else { this.cam = { x: cam.x, z: cam.z }; this.lastT = tc; }
    if (tc - this.lastPlan > 700) { this.lastPlan = tc; this.plan(cam.x, cam.z); }
    while (this.pending.size < INFLIGHT && this.queue.length) { const q = this.queue.shift(); if (!this.tiles.has(q.k) && !this.pending.has(q.k)) this.request(q); }
    for (let n = 0; n < 4 && this.rects.length; n++) { const r = this.rects.shift(); this.stats.invalidations++; this.onInvalidate?.(r[0] - 50, r[1] - 50, r[2] + 50, r[3] + 50); }
    this.stats.ms += performance.now() - t0; this.stats.frames++;
  }
  // The coarse backdrop shipped with the place (assets/real/<id>/geo.bin, tools/realworld/geotiles.mjs): the tile files
  // exactly as the hosts serve them, so the first view needs no outside fetch. Requests for these tiles hand the file
  // to the same decode as a fetched one (worker, sea carve, grading, tint); the rest still stream. A bad file is ignored.
  seed(buf) {
    try {
      const b = new Uint8Array(buf), hl = new DataView(b.buffer, b.byteOffset).getUint32(4, true);
      if (String.fromCharCode(...b.subarray(0, 4)) !== 'SKG1') return;
      let o = 8 + hl;
      for (const [kind, Z, tx, ty, n] of JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + hl))).tiles) {
        this.seeded.set((kind === 'e' ? ELEV : IMG)(Z, tx, ty), new Blob([b.subarray(o, o + n)], { type: kind === 'e' ? 'image/png' : 'image/jpeg' })); o += n;
      }
    } catch (e) { this.seeded.clear(); }
  }
  // Before the World is built: start fetching what the first view needs (the coarse backdrop, and anything near the
  // start past the baked squares), keeping requests flowing for at most `ms`; resolves then or when all are in. Never
  // rejects. Not awaited (realworld.js loadReal): the World may already be built from what it sampled when this
  // resolves, so it leaves miss/rects alone (attach's reset() starts them afresh for each World).
  prime(ms = 3000) {
    this.plan(0, 0);
    while (this.pending.size < INFLIGHT && this.queue.length) this.request(this.queue.shift());
    return new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        while (this.pending.size < INFLIGHT && this.queue.length) this.request(this.queue.shift());
        if ((!this.pending.size && !this.queue.length) || performance.now() - t0 > ms) res(); else setTimeout(tick, 50);
      };
      tick();
    });
  }
  // a fresh World: nothing it builds has used anything yet
  reset() { this.miss.clear(); this.rects.length = 0; this.cam = null; this.vel = { x: 0, z: 0 }; this.lastPlan = -1e9; }
  info() { const s = this.stats; return `${this.tiles.size} tiles, ${this.pending.size} loading, ${(s.netBytes / 1e6).toFixed(1)} MB in ${s.netTiles} (+${s.seedTiles} shipped, ${s.cacheTiles} cached, ${s.fails} failed), ${s.invalidations} rebuilds, ${(s.ms / Math.max(1, s.frames)).toFixed(3)} ms/frame`; }
  dispose() { this.worker?.terminate(); this.worker = null; this.tiles.clear(); this.cbs.clear(); }
}
