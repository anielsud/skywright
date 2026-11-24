// Real-world locations, built from geodata baked offline by tools/realworld/bake.py into assets/real/<id>/:
// heights (AWS Terrain Tiles), imagery (Sentinel-2 cloudless by EOX, CC BY 4.0; in the US, USDA NAIP aerial photos,
// public domain) and OpenStreetMap data (ODbL).
// Two nested squares: a detailed one (~20 m heights, ~5-10 m imagery) around the airport, and a coarse one
// (~230 m heights, ~120 m imagery) out to the haze, so the real mountains carry on to the horizon. Past the coarse
// square the same sources are streamed while flying (src/geostream.js), so a fast jet never reaches an edge.
// Everything is loaded before the World is built (loadReal), then World asks this module for heights, colours,
// the vegetation mask and the road network (the minimap samples the same heights and colours). The game frame: metres, origin at the runway centre,
// -z along the runway, which points to the compass bearing loc.north.
import * as THREE from 'three';
import { resample } from './roads.js';
import { smoothstep, clamp } from './noise.js';
import { inStuntCut } from './stuntPark.js';
import { GLTFLoader } from '../vendor/addons/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/addons/meshopt_decoder.module.js';
import { GeoStream } from './geostream.js';
import { decodeRoadnet, way } from './roadnet.js';
import { decodeRoads, PACK_V } from './roadPack.js';
import { ROADS } from './version.js';

const BASE = 'assets/real/';
const GAIN = 1.35, DESHADE = 0.3; // imagery brightness (linear, loc.satGain overrides) and how much of its baked-in shading to remove (shaders.js)
const cache = new Map(); // id -> loaded data (kept for the session: flying here again needs no reload)
const BAND = 5000; // m: the coarse square's last 5 km fade into the streamed data (geostream.js), heights and colours
// #152: the World has one water level. At a place whose water is a mountain lake (Jungfrau: 561 m), the real lowlands
// further out (the Swiss plateau and the Po valley, 100-550 m) would all be under it. Outside the detailed square,
// ground below LIFT m above the water is lifted to at least LIFT_MIN above it, blended (convex: hills keep their
// shape, the plains a gentle relief), unless the imagery says it is really water there (a lake, e.g. Maggiore: it
// stays, drawn at the World's level). LIFT_MIN clears the far field's 'dry land' test (wl + 20 m), so the water isn't
// drawn under the plains at all: 5 m apart, 50 km away, no depth buffer could keep them apart.
const LIFT = 100, LIFT_MIN = 25, LIFT_EDGE = 1500;

export const REAL_LOCATIONS = {
  lauterbrunnen: {
    id: 'lauterbrunnen', name: 'Jungfrau Region', real: true,
    desc: 'The real Swiss Alps from satellite data: Interlaken, the Lauterbrunnen valley, Eiger, Mönch and Jungfrau.',
    credit: 'Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Heights: AWS Terrain Tiles · Map data © OpenStreetMap contributors',
    seed: 41, rwyH: 568, water: 561, north: 50, cloudBase: 3300, trees: 'pine', snowline: 2900, erosion: false,
    // the alpine tree palette, with real altitudes mapped onto the fictional valley's (tree line ~2000 m, beech below ~1200 m)
    // wl: the valley floor (towns, the airport) is only a few metres above the lakes: no riverside woods across it
    flora: { biome: 'alpine', snowline: 1250, h: (h) => (h - 540) * 0.68, wl: 25 },
    // the stunt park: wooden ramps, hay bales and cowbell flags in a meadow at the west tip of Lake Brienz (stuntSite.js), the
    // water park just offshore: an amphibious build can drive from one to the other
    roadStart: { place: 'Wilderswil', maxClass: 3 }, // 'On the road': the village street of Wilderswil, by the airfield (landStart.js)
    stunts: { theme: 'alpine', layout: 'compact', near: [-1095, -1243], r: 400, distW: 8, maxForest: 0.15, seed: 117 },
    waterColors: { deep: 0x0d4a52, shallow: 0x2f8f8a, sand: 0x6b6a55 }, // glacial-milk turquoise lakes
    marina: { at: [-1700, 3900], r: 2600, waves: 0.04 }, // boats start at a marina on Lake Thun, by Interlaken (marina.js finds the spot)
    waterPark: { theme: 'alpine', near: [-1095, -1243], r: 1500 }, // the water park (waterPark.js): off the stunt park's meadow at the west tip of Lake Brienz
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
    marina: { at: [5300, -3900], r: 2400, waves: 0.05 }, // boats: a marina in the lagoon off Vaitape
    waterPark: { theme: 'tropical', near: [4540, 580], r: 1200, shallow: 5, distW: 6 }, // the water park (waterPark.js): in the turquoise lagoon off the stunt park's shore
    padBlend: 160, // the airport sits on a narrow reef islet: its apron meets the sea within ~160 m
    // the stunt park: a palm-lined sand track with a tiki arch on the island's east shore (stuntSite.js), the water park in the lagoon beside it
    roadStart: { place: 'Vaitape', maxClass: 1 }, // 'On the road': the island's ring road at Vaitape (landStart.js)
    stunts: { theme: 'tropical', layout: 'compact', near: [4540, 580], r: 400, distW: 8, maxForest: 1, minAbove: 1.0, forestW: 0, seed: 117 },
    townScale: 0.45, // small villages strung along the coast road: keep the palms between the houses
    osmStyle: 'tropical', // realBuildings.js: painted houses under metal roofs, thatched resorts, overwater bungalows
    waterColors: { deep: 0x0b3474, shallow: 0x1aa6b8, sand: 0xece4cc }, waterReef: 0.15, // sapphire ocean, turquoise lagoon over pale sand
    colors: { grass: [0x3f7a2c, 0x56913a, 0x2f6125], rock: 0x5a524a, snow: 0x5a524a, sand: 0xe3d3a3, dirt: 0x7a6040 },
    height(n, x, z) { const D = cache.get(this.id); return D ? D.height(x, z) : this.rwyH; },
  },
  // the Grand Canyon took the place (and the id) of the fictional Red Canyon: old settings and rooms carry over
  canyon: {
    id: 'canyon', name: 'Grand Canyon', real: true,
    desc: 'The real Grand Canyon from aerial photos: the South Rim villages, Phantom Ranch, the Colorado River and the North Rim.',
    credit: 'Imagery: USDA NAIP via USGS The National Map (public domain), Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) farther out · Heights: AWS Terrain Tiles (USGS 3DEP) · Map data © OpenStreetMap contributors',
    seed: 37, rwyH: 2002, water: 200, north: 40.5, cloudBase: 4300, trees: 'pine', snowline: 99999, erosion: false, desert: true,
    fogBase: 1300, // haze settles into the canyon
    marina: { river: true, at: [2330, -17474], r: 4000, waves: 0.02 }, // boats: a landing on the Colorado (flat water near Phantom Ranch)
    // the daredevil area on the South Rim: the canyon jump (src/evelJump.js) across a side canyon, found near this hint
    // (stuntSite.js findGap), and the stunt park (src/stuntPark.js) right behind its run-up, its track feeding the jump
    roadStart: { place: 'Tusayan', maxClass: 1 }, // cars and bikes 'On the road': the main road through Tusayan, by the airport (landStart.js)
    stunts: { atJump: true, layout: 'compact', flat: 60, blend: 80, fill: 0, evel: { near: [1420, -10100], heading: 200, span: 140, turn: 16, dip: 150 } },
    satGain: 1.05, // NAIP is brighter than Sentinel-2
    cliff: [0.36, 0.24, 0.18, 0.4], // the walls: red-stained limestone and sandstone (the deshadowed photos see most of them)
    sunLat: 36.05, // the real sun path: sunset light from the west on the canyon walls (world.js setTime)
    // the hi imagery file per quality tier (NAIP is sharp enough to be worth 8192 px on a laptop)
    img: { ultra: 'hi.jpg', high: 'hi.jpg', medium: 'hi-4k.jpg', low: 'hi-2k.jpg' },
    // ponderosa pine on the rims, pinyon-juniper below, desert scrub in the canyon (flora.js 'rim'); real altitudes
    flora: { biome: 'rim', snowline: 99999, h: (h) => h, wl: 50 },
    waterColors: { deep: 0x163c38, shallow: 0x3d7a68, sand: 0x9a7a52 },
    river: { color: 0x3c4836 }, // the Colorado: olive green (silty brown after storms)
    buildStyle: { wood: 0.3, roofs: [['shingle', 0.35], ['grey', 0.5], ['tile', 0.15]] }, // the parks' log-and-stone rustic, motels in Tusayan
    colors: { grass: [0x8a7a55, 0x9a8a60, 0x7a6a48], rock: 0x9a5a3c, snow: 0xd9b48a, sand: 0xc49a6c, dirt: 0x9a6a48 },
    height(n, x, z) { const D = cache.get(this.id); return D ? D.height(x, z) : this.rwyH; },
  },
  nyc: {
    id: 'nyc', name: 'New York City', real: true,
    desc: 'Take off from LaGuardia and fly the Hudson: the Statue of Liberty, the skyscrapers, Central Park and the bridges. Stunt park and water park side by side in Liberty State Park.',
    credit: 'Imagery: USGS NAIP (public domain), Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Buildings: NYC Open Data, © OpenStreetMap contributors · Heights: AWS Terrain Tiles',
    seed: 53, rwyH: 6, water: 0, north: 32, cloudBase: 1800, trees: 'pine', snowline: 99999, erosion: false, boats: true,
    core: 33000, // the detailed core reaches from LaGuardia to the Statue of Liberty (16 km)
    marina: { at: [-700, 600], r: 2600, waves: 0.1 }, // boats: a marina on Flushing Bay, beside LaGuardia
    waterPark: { theme: 'urban', near: [-7600, 14300], r: 1200 }, // the water park (waterPark.js): between Liberty State Park and Ellis Island, the Statue of Liberty and Lower Manhattan round it
    roads: { step: 16, chunk: 2500 }, // every street (roads.bin: ~58k ways), 16 m between points away from the junctions, meshes per 2.5 km
    // deciduous parks and street trees: the alpine palette's valley floor, with no rocks or shrubs on the pavement
    flora: { biome: 'alpine', snowline: 99999, h: (h) => h * 0.5, wl: 0, bare: true },
    waterColors: { deep: 0x1c3a44, shallow: 0x3a6a6a, sand: 0x5a5a50 }, // the harbour: green-grey, silty
    colors: { grass: [0x4f6b35, 0x5d7a3c, 0x46612f], rock: 0x6a6866, snow: 0xf4f6f8, sand: 0x8a8270, dirt: 0x6a5a48 },
    // the stunt park: concrete, containers and graffiti on the open lawns of Liberty State Park, Jersey City (no buildings,
    // roads, water or tree canopy: stuntSite.js findSite), beside the water park; about lat 40.7044, lon -74.0452
    roadStart: { near: { lat: 40.7587, lon: -73.9787 }, maxClass: 1 }, // 'On the road': a Midtown Manhattan avenue (landStart.js)
    stunts: { theme: 'urban', layout: 'compact', near: [-7650, 14350], r: 500, distW: 8, canopy: true, maxCanopy: 0.2, maxForest: 0.2, seed: 117 },
    satGain: 1.0, sat: { deshade: 0.2, detail: 0.3 }, // aerial photos (NAIP): little photo grass on top of them, less de-shading
    city: {
      // antenna masts / spires (top above the ground, m) on the tallest building at that point
      masts: [{ name: 'Empire State Building', lat: 40.748440, lon: -73.985664, top: 443 }, { name: 'One World Trade Center', lat: 40.712742, lon: -74.013382, top: 541 }],
      // the Statue of Liberty: a model (realLandmarks.js) instead of the footprints there; facing: compass bearing
      statue: { lat: 40.689247, lon: -74.044502, facing: 125 },
      // rooftop helipads (src/helipad.js) on the tallest building at each point, picked from the footprint data for a
      // big flat roof with nothing taller within 250 m. The first is where helicopters start: 55 Water Street (209 m,
      // a 51 x 99 m roof by the harbour), facing the Statue of Liberty. Their buildings can't be knocked down.
      helipads: [
        { name: '55 Water Street', lat: 40.703070, lon: -74.009319, look: { lat: 40.689247, lon: -74.044502 }, start: true },
        { name: 'One Penn Plaza', lat: 40.751361, lon: -73.992603 },
        { name: 'Javits Federal Building', lat: 40.715477, lon: -74.004324 },
      ],
    },
    height(n, x, z) { const D = cache.get(this.id); return D ? D.height(x, z) : this.rwyH; },
  },
};

// a lat / lon in the game frame (the same equirectangular projection as tools/realworld/bake.py to_local)
export function toLocal(meta, lat, lon) {
  const th = THREE.MathUtils.degToRad(meta.north || 0), d = Math.PI / 180, R = 6371008.8;
  const E = (lon - meta.lon0) * d * R * Math.cos(meta.lat0 * d), N = (lat - meta.lat0) * d * R;
  return [E * Math.cos(th) - N * Math.sin(th), -(E * Math.sin(th) + N * Math.cos(th))];
}
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
// city.bin (tools/realworld/city.py): 'SKC1', uint32 header length, JSON header, int16 words (the building records)
function decodeCity(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'SKC1') throw new Error('city.bin: bad header');
  const hl = dv.getUint32(4, true), hdr = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  const o = bytes.byteOffset + 8 + hl, n = (bytes.byteLength - 8 - hl) >> 1;
  const buf = o % 2 ? bytes.slice(8 + hl).buffer : bytes.buffer, off = o % 2 ? 0 : o;
  return { hdr, S: new Int16Array(buf, off, n), U: new Uint16Array(buf, off, n) };
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
  if (cache.get(id)?.key === key) { await cache.get(id).stream.prime(1500); return cache.get(id); }
  const dir = BASE + id + '/';
  const files = [get(dir + 'meta.json', 'json'), get(dir + 'hi.bin.gz'), get(dir + 'far.bin.gz'), get(dir + (loc.img?.[quality] || 'hi.jpg'), 'blob'), get(dir + 'far.jpg', 'blob'), get(dir + 'cover.png', 'blob'), get(dir + 'osm.json', 'json'), get(dir + 'roads.bin.gz')];
  if (loc.city) files.push(get(dir + 'city.bin.gz')); // a city's buildings (realCity.js)
  if (loc.city?.statue) files.push(get('assets/landmarks/liberty.glb').catch((e) => (console.warn('[landmarks] statue model', e), null))); // the Statue of Liberty scan (realLandmarks.js; tools/liberty)
  let done = 0; const tick = (p) => { done++; onProgress?.(done / files.length); return p; };
  const [meta, hiZ, farZ, hiB, farB, coverB, osm, roadsZ, cityZ, statueB] = await Promise.all(files.map((p) => p.then(tick)));
  // the largest imagery texture on this tier; a place with loc.img has a ready-made hi file per tier (no resize)
  const texSize = quality === 'high' || quality === 'ultra' ? 4096 : 2048, fit = { resizeWidth: texSize, resizeHeight: texSize, resizeQuality: 'high' };
  const opt = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const [hiBmp, farBmp, coverBmp] = await Promise.all([
    createImageBitmap(hiB, !loc.img && texSize < 4096 ? fit : {}),
    createImageBitmap(farB, texSize < 4096 ? fit : {}), createImageBitmap(coverB, opt),
  ]);
  const D = new RealData(loc, meta, decodeHeights(await gunzip(hiZ), meta.hi.n), decodeHeights(await gunzip(farZ), meta.far.n), hiBmp, farBmp, coverBmp, osm);
  await D.stream.prime(); // the streamed land the first view reaches past the coarse square (a few seconds at most; never fails)
  { const b = await gunzip(roadsZ); D.roadnet = decodeRoadnet(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } // every road, with its junctions (roadnet.js)
  // the roads already built and graded, baked at deploy for this build (roadPack.js; none locally)
  const packKey = ROADS !== 'dev' ? ROADS : globalThis.SKY_ROADPACK_KEY; // (tests: a dev build loads packs baked with that key)
  if (packKey) try { const b = await gunzip(await get(`assets/boot/roads-${id}.bin.gz`)), P = decodeRoads(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); if (P.key === packKey && P.v === PACK_V) D.roadPack = P; } catch { /* (missing: work them out) */ }
  if (cityZ) D.city = decodeCity(await gunzip(cityZ));
  if (statueB) try { D.statue = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(statueB, '')).scene; } catch (e) { console.warn('[landmarks] statue model', e); }
  D.key = key;
  cache.get(id)?.dispose();
  cache.set(id, D);
  return D;
}
export function realData(loc) { return cache.get(loc.id) || null; }

// The coarse square's sea, carved under the water. Off New York the AWS Terrain Tiles have no sea floor: the open
// ocean is stored flat at sea level, exactly 0 m (the heights are hydro-flattened). The bake carves the detailed
// square's sea (bake.py carve_water) but not this one's, so out there the ground sat exactly at the water level,
// which everything downstream takes for dry land (World.shoreSnap lifts it to SHORE_OVER above): the water shader
// discarded it, the tiles found no land worth a mesh (anyLand) and the far field didn't drown it, so nothing was
// drawn at all and the haze behind showed through as a flat pale sheet, edged by the bathymetry tiles (#153).
// Here it gets a sea floor the way the bake does the detailed square's: big flat runs at the water level (small ones
// are low ground: left alone) sink under it, deeper further from the nearest dry sample (chamfer distance, 2 passes).
// Exported for any other grid of real heights (streamed ones past the squares have the same flat sea).
export function carveFlatSea(G, wl, k = 0.05, dmax = 25, minRun = 64) {
  const n = G.n, H = G.H, N = n * n, flat = new Uint8Array(N); // 1: at the water level; then 2: in a big run (sea), 3: being filled, 4: in a small run
  let any = false;
  for (let q = 0; q < N; q++) if (Math.abs(H[q] - wl) < 0.07) { flat[q] = 1; any = true; } // (heights come in 1/8 m steps)
  if (!any) return 0;
  const stack = new Int32Array(N), run = new Int32Array(N); let carved = 0;
  for (let s = 0; s < N; s++) {
    if (flat[s] !== 1) continue;
    let sp = 0, m = 0; stack[sp++] = s; flat[s] = 3;
    while (sp) {
      const q = stack[--sp], i = q % n; run[m++] = q;
      if (i > 0 && flat[q - 1] === 1) { flat[q - 1] = 3; stack[sp++] = q - 1; }
      if (i < n - 1 && flat[q + 1] === 1) { flat[q + 1] = 3; stack[sp++] = q + 1; }
      if (q >= n && flat[q - n] === 1) { flat[q - n] = 3; stack[sp++] = q - n; }
      if (q < N - n && flat[q + n] === 1) { flat[q + n] = 3; stack[sp++] = q + n; }
    }
    const v = m >= minRun ? 2 : 4; for (let a = 0; a < m; a++) flat[run[a]] = v;
  }
  // distance (in samples) to the nearest dry sample: anything above the water level (sea floor already under it counts as sea)
  const D = new Float32Array(N), R2 = Math.SQRT2;
  for (let q = 0; q < N; q++) D[q] = H[q] > wl + 0.07 ? 0 : 1e9;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = j * n + i; let d = D[q]; if (!d) continue;
    if (i > 0) d = Math.min(d, D[q - 1] + 1);
    if (j > 0) { d = Math.min(d, D[q - n] + 1); if (i > 0) d = Math.min(d, D[q - n - 1] + R2); if (i < n - 1) d = Math.min(d, D[q - n + 1] + R2); }
    D[q] = d;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const q = j * n + i; let d = D[q]; if (!d) continue;
    if (i < n - 1) d = Math.min(d, D[q + 1] + 1);
    if (j < n - 1) { d = Math.min(d, D[q + n] + 1); if (i < n - 1) d = Math.min(d, D[q + n + 1] + R2); if (i > 0) d = Math.min(d, D[q + n - 1] + R2); }
    D[q] = d;
  }
  for (let q = 0; q < N; q++) if (flat[q] === 2) { H[q] = wl - 1.2 - Math.min(dmax, D[q] * G.sp * k); carved++; }
  return carved;
}

class RealData {
  constructor(loc, meta, hiH, farH, hiBmp, farBmp, coverBmp, osm) {
    this.loc = loc; this.meta = meta; this.osm = osm;
    this.gain = loc.satGain ?? GAIN; this.gainS = Math.pow(this.gain, 1 / 2.2); // (per place: aerial photos come brighter than Sentinel-2)
    this.hi = { ...meta.hi, H: hiH, sp: meta.hi.size / (meta.hi.n - 1) };
    this.far = { ...meta.far, H: farH, sp: meta.far.size / (meta.far.n - 1) };
    carveFlatSea(this.far, meta.water ?? loc.water); // (the open sea off New York is flat at 0 m in this square: see carveFlatSea)
    this.hiBmp = hiBmp; this.farBmp = farBmp;
    // CPU copies of the imagery for vertex colours (far terrain, grass tint, roofs): 2048 px is plenty
    this.hiPx = { ...meta.hi, n: 2048, d: pixels(hiBmp, 2048) };
    this.farPx = { ...meta.far, n: Math.min(2048, farBmp.width), d: pixels(farBmp, Math.min(2048, farBmp.width)) };
    const cn = coverBmp.width, cd = pixels(coverBmp, cn), cover = new Uint8Array(cn * cn);
    for (let k = 0; k < cover.length; k++) cover[k] = cd[k * 4];
    this.cover = { ...meta.hi, n: cn, d: cover }; // (meta's n is the height grid's)
    coverBmp.close?.();
    this.edge = 1500; // blend from the detailed heights to the coarse ones over the last 1.5 km of the detailed square
    this.buildRivers(osm.rivers || []);
    // past the coarse square: streamed tiles (geostream.js). zMax: the finest zoom a sample may use (the far field
    // asks for coarser ones while it builds a distant cell, World.tiles.far)
    const F = this.far; this.zMax = 10; this.tmpA = new THREE.Color(); this.tmpB = new THREE.Color(); this.tmpW = new THREE.Color();
    this.stream = new GeoStream(meta, [F.x0 + BAND, F.z0 + BAND, F.x0 + F.size - BAND, F.z0 + F.size - BAND], this.edgeMeans(), carveFlatSea, meta.water ?? loc.water);
    this.stream.matchTint = () => this.matchTint();
    this.lift = loc.water > 5; this.wl = loc.water; // (at sea level the sea is the sea: Terrarium has the sea floor)
  }
  // the coarse square's mean height and colour along its edge: what ground with no data at all looks like (offline)
  edgeMeans() {
    const G = this.far, n = G.n, P = this.farPx, m = P.n; let h = 0, c = [0, 0, 0], k = 0, q = 0;
    for (let i = 0; i < n; i++) for (const j of [0, n - 1]) { h += G.H[j * n + i] + G.H[i * n + j]; k += 2; }
    for (let i = 0; i < m; i++) for (const j of [0, m - 1]) for (const p of [j * m + i, i * m + j]) { for (let o = 0; o < 3; o++) c[o] += P.d[p * 4 + o]; q++; }
    return { h: h / k, c: c.map((v) => v / q / 255) };
  }
  // Sentinel-2 straight from EOX isn't exactly the baked imagery (the Grand Canyon's is NAIP aerial photos; a bake can
  // grade its own): match the stream's mean colour to the coarse square's along a ring inside its fading band, from
  // the coarse backdrop (z6) once it has arrived. Ground already built from the old tint is rebuilt.
  matchTint() {
    const G = this.far, sum = [0, 0, 0], ref = [0, 0, 0], c = this.tmpA; let k = 0;
    for (let s = 0; s < 4; s++) for (let i = 0; i < 64; i++) {
      const t = BAND / 2 + (G.size - BAND) * (i + 0.5) / 64, e = s & 1 ? BAND / 2 : G.size - BAND / 2; // (along the side, across it)
      const x = G.x0 + (s < 2 ? t : e), z = G.z0 + (s < 2 ? e : t);
      const r = this.stream.rawColor(x, z, 6); if (!r) continue;
      this.samplePx(this.farPx, x, z, c);
      for (let o = 0; o < 3; o++) { sum[o] += r[o] / 255; } ref[0] += c.r / this.gainS; ref[1] += c.g / this.gainS; ref[2] += c.b / this.gainS; k++;
    }
    if (k < 128) return;
    this.stream.tint = sum.map((v, o) => clamp(ref[o] / Math.max(1e-3, v), 0.7, 1.4));
    this.stream.tintDone = true; this.stream.invalidateAll();
  }
  // the World this data is building (one at a time): streamed tiles that arrive rebuild its ground
  attach(w) { this.stream.reset(); this.stream.onInvalidate = (x0, z0, x1, z1) => w.invalidateArea(x0, z0, x1, z1); this.stream.radius = () => w.tiles?.far.viewDist() ?? 130000; }
  detach() { this.stream.onInvalidate = null; }
  // Rivers far above the World's water level (the Colorado in the Grand Canyon): the bake carved a bed under a
  // downhill water surface. Kept where the detailed heights are used unblended. Segments go in a 100 m hash.
  buildRivers(list) {
    this.rivers = []; this.riverHash = new Map();
    for (const flat of list) {
      let pts = [];
      const flush = () => { if (pts.length > 2) this.rivers.push(pts); pts = []; };
      for (let k = 0; k < flat.length; k += 4) {
        if (this.inHi(flat[k], flat[k + 1]) < this.edge + 100) { flush(); continue; }
        pts.push({ x: flat[k], z: flat[k + 1], h: flat[k + 2], w: flat[k + 3] });
      }
      flush();
    }
    for (const P of this.rivers) for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1], m = Math.max(a.w, b.w) + 20;
      for (let cx = Math.floor((Math.min(a.x, b.x) - m) / 100); cx <= Math.floor((Math.max(a.x, b.x) + m) / 100); cx++)
        for (let cz = Math.floor((Math.min(a.z, b.z) - m) / 100); cz <= Math.floor((Math.max(a.z, b.z) + m) / 100); cz++) {
          const k = cx * 65536 + cz; let L = this.riverHash.get(k); if (!L) this.riverHash.set(k, (L = [])); L.push(a, b);
        }
    }
  }
  // water surface height of a real river at (x,z), or null when not on one (m: metres of bank to count as well)
  waterAt(x, z, m = 0) {
    if (!this.riverHash.size) return null;
    const L = this.riverHash.get(Math.floor(x / 100) * 65536 + Math.floor(z / 100)); if (!L) return null; // (cells hold segments within w + 20 m)
    let best = null, bd = Infinity;
    for (let k = 0; k < L.length; k += 2) {
      const a = L[k], b = L[k + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1), px = a.x + dx * t - x, pz = a.z + dz * t - z, d = Math.hypot(px, pz);
      if (d < a.w + (b.w - a.w) * t + m && d < bd) { bd = d; best = a.h + (b.h - a.h) * t; }
    }
    return best;
  }
  // where a seaplane starts on the river (a long straight reach, from the bake), or null
  waterStart() {
    const s = this.osm.riverStart; if (!s || this.waterAt(s[0], s[1]) == null) return null;
    // mid-stream: the nearest centre-line point, facing downstream along the reach
    let best = null, bd = Infinity;
    for (const P of this.rivers) P.forEach((p, i) => { const d = Math.hypot(p.x - s[0], p.z - s[1]); if (d < bd && i + 1 < P.length) { bd = d; best = [p, P[Math.min(P.length - 1, i + 3)]]; } });
    if (!best) return null;
    const [a, b] = best;
    return { pos: new THREE.Vector3(a.x, 0, a.z), heading: Math.atan2(-(b.x - a.x), -(b.z - a.z)) };
  }
  sampleH(G, x, z) {
    const n = G.n, fx = clamp((x - G.x0) / G.sp, 0, n - 1.0001), fz = clamp((z - G.z0) / G.sp, 0, n - 1.0001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, H = G.H, k = j * n + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v;
  }
  // distance (m) inside the detailed square (negative outside)
  inHi(x, z) { const G = this.hi; return Math.min(x - G.x0, G.x0 + G.size - x, z - G.z0, G.z0 + G.size - z); }
  // distance (m) inside the coarse square (negative outside)
  inFar(x, z) { const G = this.far; return Math.min(x - G.x0, G.x0 + G.size - x, z - G.z0, G.z0 + G.size - z); }
  height(x, z) {
    const e = this.inHi(x, z);
    if (e >= this.edge) return this.sampleH(this.hi, x, z);
    const f = this.farHeight(x, z);
    if (e > 0) return f + (this.sampleH(this.hi, x, z) - f) * smoothstep(0, this.edge, e);
    return this.lift && f < this.wl + LIFT ? this.lifted(x, z, f, e) : f;
  }
  // the coarse square's heights, fading into the streamed ones over its last BAND m, and the streamed ones past it
  farHeight(x, z) {
    const ef = this.inFar(x, z);
    if (ef >= BAND) return this.sampleH(this.far, x, z);
    const s = this.stream.height(x, z, this.zMax);
    return ef <= 0 ? s : s + (this.sampleH(this.far, x, z) - s) * smoothstep(0, BAND, ef);
  }
  // #152: ground below the lake level outside the detailed square, out of the water unless the imagery shows water
  lifted(x, z, h, e) {
    const k = LIFT - LIFT_MIN, up = this.wl + LIFT_MIN + k * Math.exp((h - this.wl - LIFT) / k); // (>= h, equal at wl + LIFT with the same slope)
    const w = smoothstep(0, LIFT_EDGE, -e) * (1 - this.wetness(this.color(x, z, this.tmpW)));
    return h + (up - h) * w;
  }
  // how much a (graded, sRGB) imagery colour looks like open water: well bluer than red, about as blue as green, and
  // dark (tuned on Sentinel-2 over Geneva, Thun, Maggiore and Lugano against the Swiss plateau and the Po valley's fields)
  wetness(c) {
    const L = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    return smoothstep(1.3, 1.5, c.b / (c.r + 0.01)) * smoothstep(0.84, 0.9, c.b / (c.g + 0.01)) * (1 - smoothstep(0.42, 0.56, L));
  }
  // imagery colour (sRGB 0..1, like the baked albedo) at (x,z)
  // nothing grows here (buildings, roads, water; in a city everything but the parks): Flora's bare mask
  bare(x, z) {
    const C = this.cover, n = C.n, i = Math.floor((x - C.x0) / C.size * n), j = Math.floor((z - C.z0) / C.size * n);
    return i >= 0 && j >= 0 && i < n && j < n && C.d[j * n + i] === 0;
  }
  samplePx(P, x, z, c) {
    const n = P.n, fx = clamp((x - P.x0) / P.size * n - 0.5, 0, n - 1.001), fz = clamp((z - P.z0) / P.size * n - 0.5, 0, n - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, d = P.d, k = (j * n + i) * 4, k2 = k + n * 4;
    const ch = (o) => ((d[k + o] * (1 - u) + d[k + 4 + o] * u) * (1 - v) + (d[k2 + o] * (1 - u) + d[k2 + 4 + o] * u) * v) / 255;
    const g = this.gainS; return c.setRGB(Math.min(1, ch(0) * g), Math.min(1, ch(1) * g), Math.min(1, ch(2) * g)); // sRGB values, like the baked albedo
  }
  color(x, z, c) {
    const e = this.inHi(x, z);
    if (e <= 0) return this.farColor(x, z, c);
    const r = this.samplePx(this.hiPx, x, z, c);
    if (e >= 300) return r;
    return r.lerp(this.farColor(x, z, this.tmpA), 1 - e / 300);
  }
  // like farHeight: the coarse imagery, fading into the streamed imagery (graded and tinted the same way)
  farColor(x, z, c) {
    const ef = this.inFar(x, z);
    if (ef >= BAND) return this.samplePx(this.farPx, x, z, c);
    this.stream.color(x, z, c, this.gainS, this.zMax);
    return ef <= 0 ? c : c.lerp(this.samplePx(this.farPx, x, z, this.tmpB), smoothstep(0, BAND, ef));
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
      this.tex = { hi: mk((this.paintHi && this.paintHi(this.hiBmp, this.meta.hi, this.gainS)) || this.hiBmp), far: mk(this.farBmp) }; // (paintHi: World's airport infield, airportGround.js)
    }
    const h = this.meta.hi, f = this.meta.far;
    return {
      satHi: { value: this.tex.hi }, satFar: { value: this.tex.far },
      satHiR: { value: new THREE.Vector4(h.x0, h.z0, 1 / h.size, 0) }, satFarR: { value: new THREE.Vector4(f.x0, f.z0, 1 / f.size, BAND / f.size) }, // (w: the fading band, shaders.js satColor)
      satSun: { value: this.captureSun() }, satGain: { value: this.gain }, satDeshade: { value: this.loc.sat?.deshade ?? DESHADE }, satDetail: { value: this.loc.sat?.detail ?? 1 },
      satCliff: { value: new THREE.Vector4(...(this.loc.cliff || [0.15, 0.14, 0.125, 0.75])) }, // colour of steep rock the photo can't see, and how much
    };
  }
  // where the sun was for the imagery (Sentinel-2 passes at ~10:30 solar time; the cloudless mosaic is mostly summer
  // scenes): azimuth ~150 deg, elevation ~55 deg, turned into the game frame
  // (meta.sun: [true azimuth, elevation], estimated by the bake from the photos themselves, e.g. for NAIP)
  captureSun() {
    const [az0, el0] = this.meta.sun || [150, 55];
    const az = THREE.MathUtils.degToRad(az0), el = THREE.MathUtils.degToRad(el0), th = THREE.MathUtils.degToRad(this.loc.north || 0);
    const E = Math.sin(az) * Math.cos(el), N = Math.cos(az) * Math.cos(el);
    return new THREE.Vector3(E * Math.cos(th) - N * Math.sin(th), Math.sin(el), -(E * Math.sin(th) + N * Math.cos(th))).normalize();
  }

  // Road network for the World: every mapped road inside the core map (roads.bin, roadnet.js), so the road meshes,
  // terrain carving, painting and car traffic all work on them. Each road keeps its junctions as exact points
  // (rd.jn: [point index, node id] pairs: the ways meeting there share the node id), so grading meets them at one
  // height and traffic can turn from one road onto the next. Resampled to loc.roads.step metres between junctions.
  // Tunnels too (rd.tunnel: graded under the ground, roads.js; drawn as tubes). No fields, no rail line.
  network(w) {
    if (this.roadPack) return this.packedNetwork(w);
    const lim = w.half + 300, roads = [], kinds = ['highway', 'main', 'main', 'street'], R = this.roadnet;
    const spans = (this.osm.bridges || []).map((b) => ({ ax: b.a[0], az: b.a[1], dx: b.b[0] - b.a[0], dz: b.b[1] - b.a[1] }));
    const step = (this.loc.roads || {}).step || 8;
    const ok = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim && !(Math.abs(x - 100) < 520 && Math.abs(z) < 1300) && (globalThis.SKY_ROADPACK || !inStuntCut(w.stuntPlan, x, z)); // (the deploy's road pack is baked uncut: the stunt sites are cut out at load, packedNetwork) // (inside the core, off the game's airport, not across a stunt site)
    for (let k = 0; k < R.ways; k++) {
      const W = way(R, k);
      const kind = kinds[W.cls], width = Math.min(W.width, W.cls === 0 ? 12 : 9), props = { kind, width, real: true, oneway: W.oneway, lanes: W.lanes, roundabout: W.roundabout, layer: W.layer, cls: W.cls, ...(W.tunnel ? { tunnel: true } : {}) };
      if (W.ys) { // a bridge over water with baked deck heights (bake.py bridge_profiles): keep them, no pillars under the suspended spans
        const pts = []; for (let i = 0; i < W.n; i++) pts.push(new THREE.Vector3(R.x[W.s + i], W.ys[i], R.z[W.s + i]));
        const rp = resample(pts, step), span = rp.map((p) => spans.some((b) => { const L2 = b.dx * b.dx + b.dz * b.dz, t = ((p.x - b.ax) * b.dx + (p.z - b.az) * b.dz) / L2; return t > 0.02 && t < 0.98 && Math.abs((p.x - b.ax) * b.dz - (p.z - b.az) * b.dx) / Math.sqrt(L2) < 30; }));
        const jn = []; if (R.node[W.s] >= 0) jn.push([0, R.node[W.s]]); if (R.node[W.s + W.n - 1] >= 0) jn.push([rp.length - 1, R.node[W.s + W.n - 1]]);
        roads.push({ pts: rp, ...props, bridge: rp.map(() => true), span, baked: true, jn });
        continue;
      }
      // runs inside the core (a road can leave and come back: split it), resampled between its junctions
      let cur = null; const runs = [];
      // the way's shape: its junctions and ends, and the points between them that bend it by more than 0.5 m (OSM
      // traces a street every few metres: kept whole, NYC's roads had 770k points, twice the triangles)
      const keep = new Uint8Array(W.n); keep[0] = keep[W.n - 1] = 1; for (let i = 0; i < W.n; i++) if (R.node[W.s + i] >= 0) keep[i] = 1;
      const dp = (a, b) => { if (b - a < 2) return; let m = -1, md = 0.5; const ax = R.x[W.s + a], az = R.z[W.s + a], dx = R.x[W.s + b] - ax, dz = R.z[W.s + b] - az, L = Math.hypot(dx, dz) || 1;
        for (let i = a + 1; i < b; i++) { const d = Math.abs((R.x[W.s + i] - ax) * dz - (R.z[W.s + i] - az) * dx) / L; if (d > md) { md = d; m = i; } }
        if (m >= 0) { keep[m] = 1; dp(a, m); dp(m, b); } };
      { let a = 0; for (let i = 1; i < W.n; i++) if (keep[i]) { dp(a, i); a = i; } }
      for (let i = 0; i < W.n; i++) {
        if (!keep[i]) continue;
        const x = R.x[W.s + i], z = R.z[W.s + i], nd = R.node[W.s + i];
        if (!ok(x, z)) { if (cur) { runs.push(cur); cur = null; } continue; }
        if (!cur) cur = { pts: [], jn: [] };
        const p = new THREE.Vector3(x, 0, z);
        if (cur.pts.length) { // fill to the step from the last point (shape points are kept too: a bend stays a bend)
          const a = cur.pts.at(-1), m = Math.ceil(Math.hypot(x - a.x, z - a.z) / step);
          for (let j = 1; j < m; j++) cur.pts.push(a.clone().lerp(p, j / m));
        }
        if (nd >= 0) cur.jn.push([cur.pts.length, nd]);
        cur.pts.push(p);
      }
      if (cur) runs.push(cur);
      for (const { pts: rp, jn } of runs) {
        if (rp.length < 2 || (rp.length < 3 && !jn.length)) continue;
        let hs = rp.map((p) => w.rawHeight(p.x, p.z));
        if (W.bridge) { const a = hs[0], b = hs.at(-1); hs = hs.map((_, i) => a + (b - a) * (i / Math.max(1, hs.length - 1)) + 0.6); }
        else { const n = hs.length; for (let it = 0; it < 3; it++) hs = hs.map((h, i) => (hs[Math.max(0, i - 1)] + h * 2 + hs[Math.min(n - 1, i + 1)]) / 4); }
        rp.forEach((p, i) => (p.y = Math.max(hs[i], w.waterLevel + 0.6)));
        roads.push({ pts: rp, ...props, bridge: rp.map(() => W.bridge), jn });
      }
    }
    // longest first: roads[0] is what the World calls "the road"
    roads.sort((a, b) => b.pts.length - a.pts.length);
    return { roads, towns: [], fields: [], rail: null };
  }
  // the network from the deploy's road pack (roadPack.js: built and graded already): the stunt sites cut out (the game's
  // site search needs the imagery, so the pack is baked without them), each piece keeping its points' heights and
  // junctions. net.graded: roads.js gradeReal has nothing to do.
  packedNetwork(w) {
    const roads = [];
    for (const rd of this.roadPack.roads) {
      const n = rd.pts.length, cut = rd.pts.map((p) => inStuntCut(w.stuntPlan, p.x, p.z));
      if (!cut.some(Boolean)) { roads.push(rd); continue; }
      const jAt = new Map(rd.jn); let a = 0;
      for (let i = 0; i <= n; i++) {
        if (i < n && !cut[i]) continue;
        if (i - a >= 2) { const sl = (A) => A?.slice(a, i); roads.push({ ...rd, pts: sl(rd.pts), bridge: sl(rd.bridge), span: sl(rd.span), tube: sl(rd.tube), jn: [...jAt].filter(([j]) => j >= a && j < i).map(([j, nd]) => [j - a, nd]) }); }
        a = i + 1;
      }
    }
    return { roads, towns: [], fields: [], rail: null, graded: true };
  }
  // the mapped roads as plain lists (landStart: where 'On the road' starts): [{ cls, width, bridge, baked, pts: [[x, z]] }],
  // and the road tunnels' centre lines ([[x, z]] each)
  roadList() {
    const R = this.roadnet, out = [], tunnels = [];
    for (let k = 0; k < R.ways; k++) {
      const W = way(R, k), pts = []; for (let i = 0; i < W.n; i++) pts.push([R.x[W.s + i], R.z[W.s + i]]);
      if (W.tunnel) tunnels.push({ pts, width: W.width }); else out.push({ cls: W.cls, width: W.width, bridge: W.bridge, baked: !!W.ys, pts });
    }
    return { roads: out, tunnels };
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
  dispose() { this.tex?.hi.dispose(); this.tex?.far.dispose(); this.tex = null; this.stream.dispose(); }
}
