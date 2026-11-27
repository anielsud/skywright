// The layout's ground against today's terrain base (#294): outside the embankment lines (off the paved regions, where
// rules.js ground is the natural ground itself), how far it is from World.shoreSnap(World.rawHeight(x, z)), the base
// today's terrain is drawn from before roads.js carves it: at the hi grid's points and every STEP m. The bake's report
// (tools/bake/layout.mjs); latticeG(L, lat): a chunk's natural-ground heights at its lattice (rules.js latticeHeights).
// groundOf measures one chunk (the bake runs it while its checks run on the workers), mergeGround reports them together.
import { makeRules, latticeGround } from '../../src/layout/rules.js';
import { KIND } from '../../src/layout/format.js';
import { latticeOf } from '../../src/layout/mesh.js';

export function groundVsBase(w, Ls, grid, latticeG, STEP = 10) {
  return mergeGround(Ls.map((L) => groundOf(w, L, grid, latticeG(L, latticeOf(L, grid)), STEP)));
}
// one chunk's (G: its natural ground at its lattice): per kind (nodes, pts) each distance and where, in order
export function groundOf(w, L, grid, G, STEP = 10) {
  const S = { nodes: [[], [], []], pts: [[], [], []] };
  const lat = latticeOf(L, grid), g = latticeGround(grid, lat, G), R = makeRules(L.net, g, !!L.city, grid.wl ?? -Infinity);
  const at = (x, z, k) => { if (R.region(x, z) !== KIND.ground) return; const gy = g(x, z), y = R.ground(x, z); if (Math.abs(y - gy) > 1e-6) return; // (in a bank or a city's lot)
    const s = S[k]; s[0].push(Math.abs(y - w.shoreSnap(w.rawHeight(x, z)))); s[1].push(x); s[2].push(z); };
  // at the hi grid's points (where the base is defined: the layout's ground points and today's terrain both interpolate between them)
  for (let j = Math.ceil((L.z0 - grid.z0) / grid.sp); grid.z0 + j * grid.sp < L.z0 + L.size; j++) for (let i = Math.ceil((L.x0 - grid.x0) / grid.sp); grid.x0 + i * grid.sp < L.x0 + L.size; i++) at(grid.x0 + i * grid.sp, grid.z0 + j * grid.sp, 'nodes');
  // and on a STEP lattice between them (the base's own value there: where shoreSnap steps between two points, the interpolation can't)
  for (let z = L.z0 + STEP / 2; z < L.z0 + L.size; z += STEP) for (let x = L.x0 + STEP / 2; x < L.x0 + L.size; x += STEP) at(x, z, 'pts');
  return S;
}
// chunks' groundOf, in order, as one: per kind how many, p99, max, and the worst [distance, x, z]
export function mergeGround(list) {
  const out = {};
  for (const k of ['nodes', 'pts']) {
    const d = []; let worst;
    for (const c of list) { const [E, X, Z] = c[k]; for (let q = 0; q < E.length; q++) { const e = E[q]; d.push(e); if (!worst || e > worst[0]) worst = [+e.toFixed(2), Math.round(X[q]), Math.round(Z[q])]; } }
    d.sort((a, b) => a - b); out[k] = { n: d.length, p99: d.length ? +d[Math.floor(d.length * 0.99)].toFixed(3) : 0, max: d.length ? +d[d.length - 1].toFixed(3) : 0, worst };
  }
  return out;
}
