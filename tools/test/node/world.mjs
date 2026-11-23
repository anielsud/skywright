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

const worlds = new Map();
const renderer = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => ({})) });

// the World at a location (cached per worker): { world, env, warns (console.warn while it was built), ms }
export async function worldAt(id, { time = 11 } = {}) {
  if (worlds.has(id)) return worlds.get(id);
  const t0 = performance.now(), loc = LOCATIONS[id];
  if (!loc) throw new Error(`no location ${id}`);
  // (offline: the land streamed in past the baked squares (geostream.js) is left out. It only reaches beyond the
  // coarse square, kilometres from anything tested, and the network would make a run slower and less repeatable)
  const net = globalThis.fetch; globalThis.fetch = (u, o) => (/^https?:/.test(String(u?.url ?? u)) ? Promise.reject(new Error('offline (tests)')) : net(u, o));
  const warn = console.warn, warns = []; console.warn = (...a) => { warns.push(a.map(String).join(' ')); warn(...a); }; // (kept: e.g. '[stunts] no flat, clear site')
  let world;
  try {
    if (loc.real) await loadReal(loc, 'low'); else await World.prepare(id);
    world = new World(renderer, new THREE.Scene(), { location: id, quality: 'low', time, weather: 'clear' });
  } finally { globalThis.fetch = net; console.warn = warn; }
  world.gust.set(0, 0, 0); world.gustT.set(0, 0, 0); // (the same wind every run: gusts are random)
  const out = { world, env: envOf(world), warns, ms: Math.round(performance.now() - t0) };
  worlds.set(id, out);
  return out;
}
// main.js's flight env for a World (the parts the flight model reads)
export function envOf(world) {
  return {
    groundAt: (x, z, y) => world.groundAt(x, z, y), maxGround: (x, z) => world.maxGround(x, z), windAt: (p) => world.windAt(p),
    get night() { return world.night || world.W.dark > 0.6; }, groundHeightAtSpawn: world.loc.rwyH,
    ...(world.surfs.length ? { surfRay: (o, d, len) => world.surfRay(o, d, len), surfPoint: (p) => world.surfPoint(p) } : {}),
    waveAmp: world.loc.marina?.waves ?? 0.06,
    walls: (x, z, r, out) => world.wallBoxes(x, z, r, out), wallPass: (e, p) => !!e.dk && world.destruct.passes(e, p),
    onDebrisHit: () => {},
  };
}
// what the browser tests reach through window.__sky, for a World: S.F.world, S.F.env, S.Aircraft, ...
export const skyOf = (w, presets) => ({ F: { world: w.world, env: w.env, paused: true }, THREE, Aircraft, REALISM, analyze, presets });
