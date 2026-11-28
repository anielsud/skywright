// Real Worlds in Node (for Node-tier suites that drive through a place: the stunt parks, the water parks, the walls).
// A World is built the way main.js builds one (the real data loaded first, at Low), with a stand-in renderer: nothing
// is drawn, but the terrain, roads, buildings, flora, stunt sites, marina and water park are all there, and the
// flight model's env is main.js's. Kept per worker thread (a worker that runs several cases at a place builds it once).
//
// What matches the browser: everything found from heights, OpenStreetMap and the landcover map (the PNG decodes in
// Node: setup.mjs). What doesn't: anything read from the imagery colours (JPEGs don't decode in Node), which only New
// York's stunt site search uses (its tree-canopy rule): there the Node World's park is not where the game's is.
import * as THREE from 'three';
import { World, LOCATIONS } from '../../../src/world.js';
import { loadReal } from '../../../src/realworld.js';
import { Aircraft, REALISM } from '../../../src/aircraft.js';
import { analyze } from '../../../src/design.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeLayout, groundBytes } from '../../../src/layout/format.js';
import { meshChunk } from '../../../src/layout/mesh.js';

const worlds = new Map();
const renderer = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => ({})) });

// the World at a location (cached per worker): { world, env, warns (console.warn while it was built), ms }
export async function worldAt(id, { time = 11 } = {}) {
  if (worlds.has(id)) return worlds.get(id);
  const t0 = performance.now(), loc = LOCATIONS[id];
  if (!loc) throw new Error(`no location ${id}`);
  // (offline: the land streamed in past the baked squares (geostream.js) is left out. It only reaches beyond the
  // coarse square, kilometres from anything tested, and the network would make a run slower and less repeatable)
  // (the backdrop shipped with a place, geo.bin, is left out too: Node decodes its PNG heights but not its JPEG imagery)
  const net = globalThis.fetch; globalThis.fetch = (u, o) => (/^https?:|geo\.bin$/.test(String(u?.url ?? u)) ? Promise.reject(new Error('offline (tests)')) : net(u, o));
  const warn = console.warn, warns = []; console.warn = (...a) => { warns.push(a.map(String).join(' ')); warn(...a); }; // (kept: e.g. '[stunts] no flat, clear site')
  let world;
  try {
    await loadReal(loc, 'low');
    world = new World(renderer, new THREE.Scene(), { location: id, quality: 'low', time, weather: 'clear' });
  } finally { globalThis.fetch = net; console.warn = warn; }
  world.gust.set(0, 0, 0); world.gustT.set(0, 0, 0); // (the same wind every run: gusts are random)
  lazyLayout(world);
  const out = { world, env: envOf(world), warns, ms: Math.round(performance.now() - t0) };
  worlds.set(id, out);
  if (process.env.SKY_WORLD_LOG) console.log(`  [world] ${id} built in ${out.ms} ms`); // (how often, and how long: SKY_WORLD_LOG=1)
  return out;
}
// The baked road layout (#294) in a Node World: each chunk read and meshed (fine) the first time physics asks about a
// point in it (World.sampleGrid / groundAt: Layout.heightAt, ground) or a city tile waits for it (readyIn), so a test
// anywhere stands on the layout's surface as the game does once its chunks round the camera are in. Placing (lanes,
// lamps, trees, building lines: placeY, kindAt, pavedAt, edgeAt; the retaining walls' boxes) reads only the chunks already in, as in the game,
// where what was placed before a chunk arrived is placed again on it (onActive): a lane graph over the whole map
// doesn't mesh the whole map (layout/runtime.js streams them; here they're synchronous, so a
// result doesn't hang on when a chunk arrived). A chunk's mesh doesn't depend on its neighbours', so the order they're
// meshed in changes nothing. Off (?layout=0, SKY_LAYOUT=0): no layout, nothing to do. The bakes keep their World's
// ground today's (globalThis.SKY_LAYOUT_LAZY = false: tools/bake/setbacks.mjs, layout.mjs).
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export function lazyLayout(world) {
  const L = world.layout; if (!L || L.lazy || globalThis.SKY_LAYOUT_LAZY === false) return world;
  const mesh = (k) => { const e = L.index.get(k); if (!e) return undefined; let c = L.chunks.get(k);
    if (!c) { c = { k, ix: e.ix, iz: e.iz, cx: (e.ix + 0.5) * L.size, cz: (e.iz + 0.5) * L.size, m: {}, phys: null, mesh: null, shown: null, asked: new Set() }; L.chunks.set(k, c);
      if (!e.file) c.buf = groundBytes(e.ix, e.iz, !!world.loc.city).buffer; else { const b = gunzipSync(readFileSync(REPO + L.dir + e.file)); c.buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      c.L = decodeLayout(c.buf); c.ready = Promise.resolve(); }
    if (!c.L) return undefined; /* (being fetched by the streaming: it meshes it) */
    if (!c.m.fine) { c.asked.add('fine'); const { grid, G } = L.lattice(c.L); L.got(c, 'fine', meshChunk(c.L, grid, G, 'fine', L.edgeH(c)), null); }
    return Map.prototype.get.call(L.active, k); };
  class Active extends Map { off = 0; get(k) { return super.get(k) ?? (this.off ? undefined : mesh(k)); } has(k) { return super.has(k) || (!this.off && !!mesh(k)); } }
  const A = new Active(L.active); L.active = A; L.lazy = true; L.on = true;
  /* (and the retaining walls' boxes, wallBoxes: what asks for them stands on the ground first, World.groundAt, which meshes
  its chunk; asking at every building in a city (walls.js registered) doesn't mesh the city) */
  for (const f of ['placeY', 'kindAt', 'pavedAt', 'edgeAt', 'wallBoxes']) { const o = L[f].bind(L); L[f] = (...a) => { A.off++; try { return o(...a); } finally { A.off--; } }; }
  /* (today's road tiles, built about the camera (roads.js group.userData.update) on whatever ground is in: inside a
  layout chunk they don't draw, so building one doesn't mesh the chunks under it either) */
  const G = world.roadGroup?.userData; if (G?.update) { const up = G.update; G.update = (...a) => { A.off++; try { return up(...a); } finally { A.off--; } }; }
  const unload = L.unload.bind(L); L.unload = (c) => { unload(c); L.on = true; }; /* (a chunk dropped far from the camera (World.update): meshed again when asked about) */
  return world;
}
// main.js's flight env for a World (the parts the flight model reads)
export function envOf(world) {
  return {
    groundAt: (x, z, y) => world.groundAt(x, z, y), maxGround: (x, z) => world.maxGround(x, z), windAt: (p) => world.windAt(p),
    get night() { return world.night || world.W.dark > 0.6; }, groundHeightAtSpawn: world.loc.rwyH,
    ...(world.surfs.length ? { surfRay: (o, d, len) => world.surfRay(o, d, len), surfPoint: (p) => world.surfPoint(p) } : {}),
    waveAmp: world.loc.marina?.waves ?? 0.06,
    walls: (x, z, r, out) => world.wallBoxes(x, z, r, out), tunnelWalls: (x, z, r, out) => (world.tunnelWalls ? world.tunnelWalls(x, z, r, out) : ((out.length = 0), out)), // (stand-in worlds have none) wallPass: (e, p) => !!e.dk && world.destruct.passes(e, p),
    onDebrisHit: () => {},
  };
}
// what the browser tests reach through window.__sky, for a World: S.F.world, S.F.env, S.Aircraft, ...
export const skyOf = (w, presets) => ({ F: { world: w.world, env: w.env, paused: true }, THREE, Aircraft, REALISM, analyze, presets });

// A World at a given quality, not cached (boatride: the Grand Canyon's river landing is also checked at High). Building
// one logs what it can't place and three.js's notes: kept in `said`, not printed (quiet), any other error prints.
//   const { world, env } = await nodeWorld('islands', 'low');  ...  world.dispose();
export async function nodeWorld(location, quality = 'low', { time = 10, weather = 'clear', quiet = true } = {}) {
  const loc = LOCATIONS[location]; if (!loc) throw new Error(`no location ${location}`);
  const said = [], { log, warn, error } = console, keep = (...a) => said.push(a.map((x) => (typeof x === 'string' ? x : x?.constructor?.name)).join(' '));
  if (quiet) { console.log = console.warn = keep; console.error = (...a) => (String(a[0]).startsWith('THREE.') ? keep(...a) : error(...a)); }
  const fetch0 = globalThis.fetch; globalThis.fetch = (u, o) => (/^https?:/.test(String(u?.url ?? u)) ? Promise.reject(new Error('offline (tests)')) : fetch0(u, o));
  try {
    await loadReal(loc, quality);
    const world = new World(renderer, new THREE.Scene(), { location, quality, time, weather }); lazyLayout(world);
    return { world, env: envOf(world), said };
  } finally { console.log = log; console.warn = warn; console.error = error; globalThis.fetch = fetch0; }
}
