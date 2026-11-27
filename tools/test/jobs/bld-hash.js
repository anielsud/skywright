// Job (a tool, not in jobs.py's default list): New York's generated buildings, hashed, to prove a change to how they
// are generated (realCity.js MeshW, the footprints, the collision boxes) leaves them byte for byte the same. Run it on
// the change and on main and compare the hashes it logs:
//   python3 tools/test/jobs.py bld-hash --quality low
//  - tall buildings: every tall mesh's arrays (positions, normals, uvs, colours, atlas, damage, indices) as written,
//    and its draw-range levels (lv, main, all), in build order;
//  - the other meshes MeshW writes (the landmarks: realLandmarks.js), in the order written;
//  - low buildings: streamed along a fixed straight line (the Battery to Harlem, 150 m up, 60 m/s, 30 Hz, the city
//    update driven as traffic drives it, under the test stepper: stepClock.js), every tile built hashed by its tile key (a tile built twice must hash the same);
//  - the collision boxes: every entry in the city's grid (tall and the low tiles standing at the end), its box and its
//    parts, after every lazy one is forced (setback.js lazyParts) and the Refiner flushed.
// Generation time (city.msTall at load, the low tiles' build time on the flight) is logged: info only.
import { toLocal } from '../../../src/realworld.js';
import { MeshW, CityScenery } from '../../../src/realCity.js';
import { stepping, stepTick } from '../../../src/stepClock.js';

// a 32-bit hash over typed arrays' bytes (murmur3-style word mix; the tail bytes folded in)
export function hashArrays(arrays, h = 0x9747b28c) {
  for (const A of arrays) {
    if (!A) { h = Math.imul(h ^ 0xdead, 0x5bd1e995); continue; }
    const b = new Uint8Array(A.buffer, A.byteOffset, A.byteLength), nw = b.byteLength >> 2;
    const w = (A.byteOffset & 3) === 0 ? new Uint32Array(A.buffer, A.byteOffset, nw) : new Uint32Array(b.slice(0, nw * 4).buffer);
    for (let i = 0; i < nw; i++) { let k = Math.imul(w[i], 0xcc9e2d51); k = (k << 15) | (k >>> 17); h ^= Math.imul(k, 0x1b873593); h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0; }
    for (let i = nw * 4; i < b.byteLength; i++) h = Math.imul(h ^ b[i], 0x5bd1e995);
    h ^= b.byteLength; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const geoArrays = (g) => [...Object.keys(g.attributes).sort().map((k) => g.attributes[k].array), g.index?.array];
const combine = (hs) => hashArrays([new TextEncoder().encode(hs.join(','))]);

// Hooks MeshW.mesh (the arrays as written, before the GPU upload empties them) and buildLowStep (each low tile built,
// by key; its build time). Returns the recorder.
export function install() {
  const rec = { meshes: new WeakMap(), list: [], lows: new WeakSet(), low: new Map(), lowMs: 0, lowTiles: 0, lowBad: [] };
  const mesh = MeshW.prototype.mesh, step = CityScenery.prototype.buildLowStep;
  MeshW.prototype.mesh = function (mat) { const m = mesh.call(this, mat); rec.meshes.set(m, geoArrays(m.geometry)); rec.list.push(new WeakRef(m)); return m; };
  CityScenery.prototype.buildLowStep = function (t, budget) {
    const t0 = performance.now(), done = step.call(this, t, budget); rec.lowMs += performance.now() - t0;
    if (done) {
      const key = t.i + ',' + t.j, ms = t.meshes || (t.low && t.low !== true ? [t.low] : []); // (a tile's meshes: one per 500 m cell, realCity.js LOW_CELL)
      const h = ms.length ? combine(ms.map((m) => hashArrays(rec.meshes.get(m)))) : 'empty';
      for (const m of ms) { rec.lows.add(m); rec.meshes.delete(m); } rec.lowTiles++;
      const was = rec.low.get(key); if (was && was !== h) rec.lowBad.push(key); else rec.low.set(key, h);
    }
    return done;
  };
  rec.uninstall = () => { MeshW.prototype.mesh = mesh; CityScenery.prototype.buildLowStep = step; };
  return rec;
}
export function tallHash(city, rec) { // (each 2 km group's arrays as its writer wrote them: the far mesh, before its index is cut down; the cell meshes share its vertices)
  const hs = (city.tallGroups || city.tallMeshes).map((g) => hashArrays(rec.meshes.get(g.m)) + ':' + g.lv.join('/') + '/' + g.main + '/' + g.all);
  return { n: hs.length, hash: combine(hs) };
}
// every other mesh MeshW wrote so far (the landmarks: realLandmarks.js), in the order written
export function otherHash(city, rec) {
  const tall = new Set([...(city.tallGroups || []), ...city.tallMeshes].map((g) => g.m)), hs = [];
  for (const r of rec.list) { const m = r.deref(); if (m && !tall.has(m) && !rec.lows.has(m) && rec.meshes.has(m)) hs.push(hashArrays(rec.meshes.get(m))); }
  return { n: hs.length, hash: combine(hs) };
}
export function lowHash(rec) {
  const keys = [...rec.low.keys()].sort();
  return { n: keys.length, built: rec.lowTiles, hash: combine(keys.map((k) => k + '=' + rec.low.get(k))), bad: rec.lowBad };
}
// every grid entry once (grid order), its box numbers and parts, the lazy ones forced, the Refiner flushed
export function boxHash(city) {
  const seen = new Set(), ents = [];
  for (const a of city.grid.values()) for (const e of a) if (!seen.has(e)) { seen.add(e); ents.push(e); }
  for (const e of ents) void e.parts;
  city.refiner.flush();
  const out = [];
  let parts = 0;
  for (const e of ents) {
    const P = e.parts, f = new Float64Array(9 + (P ? P.length * 6 : 0));
    for (let k = 0; k < 9; k++) f[k] = e[k];
    if (P) P.forEach((q, i) => { f.set([q.x, q.z, q.ux, q.uz, q.hl, q.hw], 9 + i * 6); parts++; });
    out.push(f, new Uint8Array([e.through ? 1 : 0, e.passage ? 1 : 0, e.below ? 1 : 0, e.fixed ? 1 : 0]));
  }
  return { n: ents.length, parts, hash: hashArrays(out) };
}
// streams the low buildings along the line (W: the World, cam: a camera, THREE)
export async function fly(W, cam, THREE, yieldEvery = 30) {
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, W.heightAt(x, z) + h, z); };
  const a = at([40.7030, -74.0160, 150]), b = at([40.8000, -73.9500, 150]), n = Math.ceil(a.distanceTo(b) / 60 * 30), v = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    cam.position.lerpVectors(a, b, i / n); cam.lookAt(b); cam.updateMatrixWorld();
    stepping(() => { W.update(1 / 30, cam, v, []); W.towns.update(1 / 30, W.t, null, cam.position); stepTick(1 / 30); }); // (the test stepper: streaming budgets in work units, so what's built doesn't depend on the machine)
    if (yieldEvery && i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // the tiles still queued at the end, finished (so the set built doesn't depend on the machine's speed)
  const C = W.towns.city; for (let k = 0; k < 10000 && C.queue.length; k++) stepping(() => { C.update(1 / 30, cam.position); stepTick(1 / 30); });
  return n;
}

export async function run(T) {
  const rec = install();
  try {
    let C;
    await T.step('nyc: build, hash the tall buildings', async () => {
      await T.start('Kestrel', 'nyc'); C = T.S.F.world.towns.city;
      const h = tallHash(C, rec), o = otherHash(C, rec); T.log(`BLDHASH tall ${h.hash} (${h.n} meshes, ${C.stats.tall} buildings) msTall ${C.msTall.toFixed(0)} ms`); T.log(`BLDHASH other ${o.hash} (${o.n} meshes: landmarks)`);
    });
    await T.step('nyc: stream Battery to Harlem, hash the low tiles', async () => {
      const S = T.S, F = S.F; F.paused = true; rec.lowMs = 0;
      await fly(F.world, S.rig.cam, T.THREE);
      const h = lowHash(rec); T.check('every tile built twice hashed the same', !h.bad.length, h.bad.join(' '));
      T.log(`BLDHASH low ${h.hash} (${h.n} tiles, ${h.built} builds) lowMs ${rec.lowMs.toFixed(0)} ms (flight only)`);
    }, { allowStalls: true });
    await T.step('nyc: hash the collision boxes', async () => {
      const h = boxHash(C); T.log(`BLDHASH boxes ${h.hash} (${h.n} entries, ${h.parts} parts)`);
    });
  } finally { rec.uninstall(); }
}
