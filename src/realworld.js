// Real-world locations, built from geodata baked offline by tools/realworld/bake.py into assets/real/<id>/:
// heights (AWS Terrain Tiles), Sentinel-2 cloudless imagery (EOX, CC BY 4.0) and OpenStreetMap data (ODbL).
// Two nested squares: a detailed one (~20 m heights, ~10 m imagery) around the airport, and a coarse one
// (~230 m heights, ~120 m imagery) out to the haze, so the real mountains carry on to the horizon.
// Everything is loaded before the World is built (loadReal), then World asks this module for heights, colours,
// the vegetation mask, the road network and the minimap. The game frame: metres, origin at the runway centre,
// -z along the runway, which points to the compass bearing loc.north.
import * as THREE from 'three';
import { resample } from './roads.js';
import { smoothstep, clamp } from './noise.js';

const BASE = 'assets/real/';
const GAIN = 1.35, DESHADE = 0.3; // imagery brightness (linear) and how much of its baked-in shading to remove (shaders.js)
const GAIN_SRGB = Math.pow(GAIN, 1 / 2.2);
const cache = new Map(); // id -> loaded data (kept for the session: flying here again needs no reload)

export const REAL_LOCATIONS = {
  lauterbrunnen: {
    id: 'lauterbrunnen', name: 'Jungfrau Region', real: true,
    desc: 'The real Swiss Alps from satellite data: Interlaken, the Lauterbrunnen valley, Eiger, Mönch and Jungfrau.',
    credit: 'Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Heights: AWS Terrain Tiles · Map data © OpenStreetMap contributors',
    seed: 41, rwyH: 568, water: 561, north: 50, cloudBase: 3300, trees: 'pine', snowline: 2900, erosion: false,
    // the alpine tree palette, with real altitudes mapped onto the fictional valley's (tree line ~2000 m, beech below ~1200 m)
    // wl: the valley floor (towns, the airport) is only a few metres above the lakes: no riverside woods across it
    flora: { biome: 'alpine', snowline: 1250, h: (h) => (h - 540) * 0.68, wl: 25 },
    waterColors: { deep: 0x0d4a52, shallow: 0x2f8f8a, sand: 0x6b6a55 }, // glacial-milk turquoise lakes
    colors: { grass: [0x4a6b2a, 0x5f7f35, 0x3f5d27], rock: 0x6b6660, snow: 0xf4f6f8, sand: 0x9a8d6a, dirt: 0x6f5a3c },
    height(n, x, z) { const D = cache.get(this.id); return D ? D.height(x, z) : this.rwyH; },
  },
  // Bora Bora and the Leeward Society Islands. Keeps the Coral Islands' id (and its tropical palms, boats, reef water,
  // gulls and surf), so saved settings and online sessions from before land here. The airport is on Motu Mute, the
  // reef islet north of the main island; the lagoon and reef depths are estimated from the imagery (tools/realworld/sea.py)
  islands: {
    id: 'islands', name: 'Bora Bora', real: true,
    desc: 'The real Bora Bora from satellite data: Mt Otemanu, a turquoise lagoon inside the coral reef, palm-covered motus, and Taha’a and Raiatea on the horizon.',
    credit: 'Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Heights: AWS Terrain Tiles · Lagoon depths estimated from the imagery · Map data © OpenStreetMap contributors',
    seed: 23, rwyH: 2.5, water: 0, north: 124.6, cloudBase: 1100, trees: 'palm', snowline: 99999, erosion: false, boats: true,
    waterStart: [800, -2300], // seaplanes start in the lagoon off the airport, facing south-east along it
    padBlend: 160, // the airport sits on a narrow reef islet: its apron meets the sea within ~160 m
    townScale: 0.45, // small villages strung along the coast road: keep the palms between the houses
    osmStyle: 'tropical', // realBuildings.js: painted houses under metal roofs, thatched resorts, overwater bungalows
    waterColors: { deep: 0x0b3474, shallow: 0x12bcc8, sand: 0x9ae8dc }, waterReef: 0.15, // sapphire ocean, turquoise lagoon over pale sand
    colors: { grass: [0x3f7a2c, 0x56913a, 0x2f6125], rock: 0x5a524a, snow: 0x5a524a, sand: 0xe3d3a3, dirt: 0x7a6040 },
    height(n, x, z) { const D = cache.get(this.id); return D ? D.height(x, z) : this.rwyH; },
  },
};

async function gunzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// uint16 per sample, (h + 200) * 8, delta-coded along each row
function decodeHeights(bytes, n) {
  const u = new Uint16Array(bytes.buffer, bytes.byteOffset, n * n), H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) { let acc = 0; for (let i = 0, k = j * n; i < n; i++, k++) { acc = (acc + u[k]) & 0xffff; H[k] = acc / 8 - 200; } }
  return H;
}
async function get(url, kind) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return kind === 'json' ? r.json() : kind === 'blob' ? r.blob() : r.arrayBuffer();
}
function pixels(bmp, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

// Load (once) everything a real location needs. quality: the World's tier (smaller imagery textures on low/medium).
export async function loadReal(loc, quality = 'high', onProgress) {
  const id = loc.id, key = id + ':' + quality;
  if (cache.get(id)?.key === key) return cache.get(id);
  const dir = BASE + id + '/';
  let done = 0; const tick = (p) => { done++; onProgress?.(done / 7); return p; };
  const [meta, hiZ, farZ, hiB, farB, coverB, osm] = await Promise.all([
    get(dir + 'meta.json', 'json'), get(dir + 'hi.bin.gz'), get(dir + 'far.bin.gz'), get(dir + 'hi.jpg', 'blob'), get(dir + 'far.jpg', 'blob'), get(dir + 'cover.png', 'blob'), get(dir + 'osm.json', 'json'),
  ].map((p) => p.then(tick)));
  const texSize = quality === 'high' ? 4096 : 2048;
  const opt = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const [hiBmp, farBmp, coverBmp] = await Promise.all([
    createImageBitmap(hiB, texSize < 4096 ? { resizeWidth: texSize, resizeHeight: texSize, resizeQuality: 'high' } : {}),
    createImageBitmap(farB, texSize < 4096 ? { resizeWidth: texSize, resizeHeight: texSize, resizeQuality: 'high' } : {}), createImageBitmap(coverB, opt),
  ]);
  const D = new RealData(loc, meta, decodeHeights(await gunzip(hiZ), meta.hi.n), decodeHeights(await gunzip(farZ), meta.far.n), hiBmp, farBmp, coverBmp, osm);
  D.key = key;
  cache.get(id)?.dispose();
  cache.set(id, D);
  return D;
}
export function realData(loc) { return cache.get(loc.id) || null; }

class RealData {
  constructor(loc, meta, hiH, farH, hiBmp, farBmp, coverBmp, osm) {
    this.loc = loc; this.meta = meta; this.osm = osm;
    this.hi = { ...meta.hi, H: hiH, sp: meta.hi.size / (meta.hi.n - 1) };
    this.far = { ...meta.far, H: farH, sp: meta.far.size / (meta.far.n - 1) };
    this.hiBmp = hiBmp; this.farBmp = farBmp;
    // CPU copies of the imagery for vertex colours (far terrain, grass tint, roofs): 2048 px is plenty
    this.hiPx = { ...meta.hi, n: 2048, d: pixels(hiBmp, 2048) };
    this.farPx = { ...meta.far, n: Math.min(2048, farBmp.width), d: pixels(farBmp, Math.min(2048, farBmp.width)) };
    const cn = coverBmp.width, cd = pixels(coverBmp, cn), cover = new Uint8Array(cn * cn);
    for (let k = 0; k < cover.length; k++) cover[k] = cd[k * 4];
    this.cover = { ...meta.hi, n: cn, d: cover }; // (meta's n is the height grid's)
    coverBmp.close?.();
    this.edge = 1500; // blend from the detailed heights to the coarse ones over the last 1.5 km of the detailed square
  }
  sampleH(G, x, z) {
    const n = G.n, fx = clamp((x - G.x0) / G.sp, 0, n - 1.0001), fz = clamp((z - G.z0) / G.sp, 0, n - 1.0001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, H = G.H, k = j * n + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v;
  }
  // distance (m) inside the detailed square (negative outside)
  inHi(x, z) { const G = this.hi; return Math.min(x - G.x0, G.x0 + G.size - x, z - G.z0, G.z0 + G.size - z); }
  height(x, z) {
    const e = this.inHi(x, z);
    if (e >= this.edge) return this.sampleH(this.hi, x, z);
    const f = this.sampleH(this.far, x, z);
    if (e <= 0) return f;
    return f + (this.sampleH(this.hi, x, z) - f) * smoothstep(0, this.edge, e);
  }
  // imagery colour (sRGB 0..1, like the baked albedo) at (x,z)
  samplePx(P, x, z, c) {
    const n = P.n, fx = clamp((x - P.x0) / P.size * n - 0.5, 0, n - 1.001), fz = clamp((z - P.z0) / P.size * n - 0.5, 0, n - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, d = P.d, k = (j * n + i) * 4, k2 = k + n * 4;
    const ch = (o) => ((d[k + o] * (1 - u) + d[k + 4 + o] * u) * (1 - v) + (d[k2 + o] * (1 - u) + d[k2 + 4 + o] * u) * v) / 255;
    return c.setRGB(Math.min(1, ch(0) * GAIN_SRGB), Math.min(1, ch(1) * GAIN_SRGB), Math.min(1, ch(2) * GAIN_SRGB)); // sRGB values, like the baked albedo
  }
  color(x, z, c) {
    const e = this.inHi(x, z);
    if (e <= 0) return this.samplePx(this.farPx, x, z, c);
    const r = this.samplePx(this.hiPx, x, z, c);
    if (e >= 300) return r;
    const f = this.samplePx(this.farPx, x, z, new THREE.Color());
    return r.lerp(f, 1 - e / 300);
  }
  // forest density 0..1 from the mapped forests (OSM), for Flora.setForestMask; 0 on houses, roads, water and
  // glaciers; null outside the data (Flora falls back to its own forest noise there)
  forest(x, z) {
    const C = this.cover, n = C.n, i = Math.floor((x - C.x0) / C.size * n), j = Math.floor((z - C.z0) / C.size * n);
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    const v = C.d[j * n + i];
    return v <= 1 ? 0 : (v - 1) / 254;
  }
  // shader uniforms for the satellite imagery (merged into the terrain material's detail uniforms)
  uniforms() {
    if (!this.tex) {
      const mk = (bmp) => { const t = new THREE.Texture(bmp); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; };
      this.tex = { hi: mk(this.hiBmp), far: mk(this.farBmp) };
    }
    const h = this.meta.hi, f = this.meta.far;
    return {
      satHi: { value: this.tex.hi }, satFar: { value: this.tex.far },
      satHiR: { value: new THREE.Vector4(h.x0, h.z0, 1 / h.size, 0) }, satFarR: { value: new THREE.Vector4(f.x0, f.z0, 1 / f.size, 0) },
      satSun: { value: this.captureSun() }, satGain: { value: GAIN }, satDeshade: { value: DESHADE },
    };
  }
  // where the sun was for the imagery (Sentinel-2 passes at ~10:30 solar time; the cloudless mosaic is mostly summer
  // scenes): azimuth ~150 deg, elevation ~55 deg, turned into the game frame
  captureSun() {
    const az = THREE.MathUtils.degToRad(150), el = THREE.MathUtils.degToRad(55), th = THREE.MathUtils.degToRad(this.loc.north || 0);
    const E = Math.sin(az) * Math.cos(el), N = Math.cos(az) * Math.cos(el);
    return new THREE.Vector3(E * Math.cos(th) - N * Math.sin(th), Math.sin(el), -(E * Math.sin(th) + N * Math.cos(th))).normalize();
  }

  // Road network for the World (same shape as roads.js planNetwork): real roads inside the core map, so the
  // existing road meshes, terrain flattening, painting and car traffic all work on them. No fields, no rail line.
  network(w) {
    const lim = w.half + 300, roads = [], kinds = ['highway', 'main', 'main', 'street'];
    for (const [cls, width, br, flat] of this.osm.roads) {
      if (w.qName === 'low' && cls === 3) continue;
      const pts = [];
      for (let k = 0; k < flat.length; k += 2) pts.push(new THREE.Vector3(flat[k], 0, flat[k + 1]));
      // keep the parts inside the core and off the game's airport (a road can leave and come back: split it)
      const runs = []; let cur = [];
      const ok = (p) => Math.abs(p.x) < lim && Math.abs(p.z) < lim && !(Math.abs(p.x - 100) < 520 && Math.abs(p.z) < 1300);
      for (const p of resample(pts, 8)) { if (ok(p)) cur.push(p); else if (cur.length) { runs.push(cur); cur = []; } }
      if (cur.length) runs.push(cur);
      for (const rp of runs) {
        if (rp.length < 3) continue;
        let hs = rp.map((p) => w.rawHeight(p.x, p.z));
        if (br) { const a = hs[0], b = hs.at(-1); hs = hs.map((_, i) => a + (b - a) * (i / (hs.length - 1)) + 0.6); }
        else { const n = hs.length; for (let it = 0; it < 3; it++) hs = hs.map((h, i) => (hs[Math.max(0, i - 1)] + h * 2 + hs[Math.min(n - 1, i + 1)]) / 4); }
        rp.forEach((p, i) => (p.y = Math.max(hs[i], w.waterLevel + 0.6)));
        roads.push({ pts: rp, kind: kinds[cls], width: Math.min(width, cls === 0 ? 12 : 9), bridge: rp.map(() => !!br), real: true });
      }
    }
    // longest first: roads[0] is what the World calls "the road"
    roads.sort((a, b) => b.pts.length - a.pts.length);
    return { roads, towns: [], fields: [], rail: null };
  }
  // villages and towns as World town sites (ambience, parked cars, the shuttle helicopter): set after the terrain
  // is flattened, so they don't level the real ground around them
  towns(w) {
    const out = [];
    for (const [name, x, z, type] of this.osm.places) {
      if (Math.abs(x) > w.half - 200 || Math.abs(z) > w.half - 200) continue;
      const h = w.sampleGrid(x, z);
      out.push({ name, c: new THREE.Vector3(x, h, z), dir: new THREE.Vector3(1, 0, 0), size: (type === 'village' ? 0.35 : 0.7) * (this.loc.townScale ?? 1), h });
    }
    return out.sort((a, b) => b.size - a.size || Math.hypot(a.c.x, a.c.z) - Math.hypot(b.c.x, b.c.z));
  }
  // minimap: the imagery itself, with the runways
  minimap(w, runways, rwyLen) {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), h = this.meta.hi, k = this.hiBmp.width / h.size;
    g.drawImage(this.hiBmp, (-w.half - h.x0) * k, (-w.half - h.z0) * k, w.size * k, w.size * k, 0, 0, s, s);
    g.fillStyle = '#222'; for (const r of runways) g.fillRect(s / 2 + (r.x / w.size) * s - 1.5, s / 2 - (rwyLen / w.size) * s / 2, 3, (rwyLen / w.size) * s);
    return c;
  }
  dispose() { this.tex?.hi.dispose(); this.tex?.far.dispose(); this.tex = null; }
}
