// A real World in Node (tools/test/node): built as a flight builds it (main.js buildFlight), with a stand-in renderer,
// and the env a flight's vehicle steps on. For Node suites that need a location's ground, water, shore and built
// structures (collision meshes), not its pictures.
//   const { world, env } = await nodeWorld('islands', 'low');  ...  world.dispose();
// What differs from the browser's World: nothing is drawn; images decode to blank pixels (setup.mjs), so a real place's
// land-cover map (cover.png) reads as empty and what is placed by it differs (the stunt parks find no site); the
// geodata streamed from the internet past a real place's baked squares (geostream.js) is not fetched; the World's clock
// stays at 0 (the swell's phase); some real-place buildings (realBuildings.js) come out with NaN vertices (three.js
// says so while they are built: kept in `said`, not printed), so don't trust building walls here yet. Heights, water,
// the marinas and their docks are the browser's: boatride's marina rides match the browser's to the last digit or
// within the browser's own run-to-run spread (0.1 degree, the swell's phase).
import * as THREE from 'three';
import { World, LOCATIONS } from '../../../src/world.js';
import { loadReal } from '../../../src/realworld.js';

// any property, call or construction gives another; numbers read as 0
const any = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any()), apply: () => any(), construct: () => any(), set: () => true });

export async function nodeWorld(location, quality = 'low', { time = 10, weather = 'clear', quiet = true } = {}) {
  const loc = LOCATIONS[location]; if (!loc) throw new Error(`no location ${location}`);
  // (building one logs what it can't place on a blank land-cover map, and three.js complains about the NaN buildings:
  // kept, not printed; any other error still prints)
  const said = [], { log, warn, error } = console, keep = (...a) => said.push(a.map((x) => (typeof x === 'string' ? x : x?.constructor?.name)).join(' '));
  if (quiet) { console.log = console.warn = keep; console.error = (...a) => (String(a[0]).startsWith('THREE.') ? keep(...a) : error(...a)); }
  // offline: the internet's geodata tiles (geostream.js, only past the baked squares) would decode to blank pixels
  // here anyway, and waiting for them costs seconds; refused, the stream falls back as it does offline
  const fetch0 = globalThis.fetch; globalThis.fetch = (u, o) => (/^https?:/.test(String(u?.url ?? u)) ? Promise.reject(new Error('offline (node/world.mjs)')) : fetch0(u, o));
  try {
    if (loc.real) await loadReal(loc, quality); else await World.prepare(location);
    const world = new World(any(), new THREE.Scene(), { location, quality, time, weather });
    // the env main.js buildFlight gives a flight's vehicle (keep in step with it), less its effects and sounds
    const env = {
      groundAt: (x, z, y) => world.groundAt(x, z, y), maxGround: (x, z) => world.maxGround(x, z), windAt: (p) => world.windAt(p),
      get night() { return world.night || world.W.dark > 0.6; }, groundHeightAtSpawn: world.loc.rwyH,
      ...(world.surfs.length ? { surfRay: (o, d, len) => world.surfRay(o, d, len), surfPoint: (p) => world.surfPoint(p) } : {}),
      waveAmp: world.loc.marina?.waves ?? 0.06,
      walls: (x, z, r, out) => world.wallBoxes(x, z, r, out), wallPass: (e, p) => !!e.dk && world.destruct.passes(e, p),
      onDebrisHit() {},
    };
    return { world, env, said };
  } finally { console.log = log; console.warn = warn; console.error = error; globalThis.fetch = fetch0; }
}
