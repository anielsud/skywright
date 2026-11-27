// Bakes a city's setbacks against its baked road layout (#294; src/layout/setbacks.js) and writes
// assets/real/<id>/setbacks.bin.gz (committed; keyed to the layout's index: a re-baked layout makes it stale, and the
// game works them out at load as before until this is run again). Deterministic: the same code and data give the same
// bytes (gzip without a timestamp).
//
//   node --import ./tools/test/node/setup.mjs tools/bake/setbacks.mjs nyc
//
// 1. each tall building's ground: the layout's surface (fine) at its footprint's corners, lowest and highest (as
//    city.py samples the hi grid), where its chunks are baked;
// 2. the building lines: each baked street out to its pavement's (or verge's) edge; today's roads in the chunks not baked;
// 3. the city's tall buildings built once with those (realCity.js CityScenery.bake), every road-dependent answer recorded.
import { writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
globalThis.SKY_LAYOUT = true; globalThis.SKY_SETBACKS = false; // (the World with its layout; no overlay read while baking one)
const { worldAt } = await import('../test/node/world.mjs');
const { CityScenery, readRec } = await import('../../src/realCity.js');
const { Layout } = await import('../../src/layout/runtime.js');
const { roadIndex } = await import('../../src/setback.js');
const { layoutKey, buildingLines, encodeSetbacks } = await import('../../src/layout/setbacks.js');

const id = process.argv[2] || 'nyc', t0 = performance.now();
const { world: W } = await worldAt(id), D = W.real, index = JSON.parse(readFileSync(`assets/real/${id}/layout/index.json`, 'utf8'));
const tw = performance.now(), L = new Layout(W, index, `assets/real/${id}/layout/`), S = index.size, city = D.city, H = city.hdr, q = H.q;
// ---- 1. the ground under each tall record: grouped by the chunk its first corner is in, chunks a column at a time
const R = {}, byChunk = new Map(), recs = [];
for (const t of H.tiles) {
  const cx = H.x0 + (t[0] + 0.5) * H.tile, cz = H.z0 + (t[1] + 0.5) * H.tile; let o = t[2];
  for (let r = 0; r < t[3]; r++) { readRec(city.U, city.S, o, q, cx, cz, R); const P = R.P.map((p) => [p[0], p[1]]), k = Math.floor(P[0][0] / S) + ',' + Math.floor(P[0][1] / S); recs.push({ o, P, g0: R.g0, g1: R.g1 }); (byChunk.get(k) || byChunk.set(k, []).get(k)).push(recs.length - 1); o = R.next; }
}
const ground = new Map(), keys = [...byChunk.keys()].map((k) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const ensure = async (k) => { if (!L.index.has(k)) return; const c = await L.load(k); if (!c.m.fine) { L.ask(c, 'fine'); while (L.queue.size) L.pump(); } };
let meshed = 0, moved = 0;
for (const [ix, iz] of keys) {
  for (const c of [...L.chunks.values()]) if (c.ix < ix - 1) { L.chunks.delete(c.k); L.active.delete(c.k); } // (a column behind: freed)
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const k = ix + a + ',' + (iz + b); if (!L.chunks.get(k)?.m.fine && L.index.has(k)) { await ensure(k); meshed++; } }
  for (const i of byChunk.get(ix + ',' + iz)) {
    const r = recs[i]; let lo = Infinity, hi = -Infinity;
    for (const [x, z] of r.P) { const h = L.heightAt(x, z); if (h === h) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }
    if (lo === Infinity) continue;
    const g0 = Math.round(lo * 4), g1 = Math.round(hi * 4); // (quarter metres, as city.bin)
    if (g0 !== Math.round(r.g0 * 4) || g1 !== Math.round(r.g1 * 4)) { ground.set(r.o, [g0 - Math.round(r.g0 * 4), g1 - Math.round(r.g1 * 4)]); moved++; } // (the change from city.bin's)
  }
}
const tg = performance.now();
console.log(`${id}: ${recs.length} tall records; ground from the layout for ${moved} (${meshed} chunk meshes) in ${((tg - tw) / 1000).toFixed(1)} s`);
// ---- 2. the building lines
const Ls = []; for (const k of L.index.keys()) Ls.push((await L.load(k)).L);
const old = roadIndex(W), lines = buildingLines(Ls, old, S); L.chunks.clear(); L.active.clear();
console.log(`  building lines: ${lines.segs.length} segments (${lines.segs.length - lines.kept} the layout's, ${lines.kept} today's outside its chunks)`);
// ---- 3. the tall buildings, recorded
CityScenery.bake = { roads: lines, ground };
let C; try { C = new CityScenery(W, D, new THREE.Group()); } finally { CityScenery.bake = null; }
const tapes = Array.from({ length: recs.length }, (_, i) => C.tapes[i] || null), key = layoutKey(index);
const raw = encodeSetbacks(tapes, key), gz = gzipSync(raw, { level: 9 }), out = `assets/real/${id}/setbacks.bin.gz`;
writeFileSync(out, gz);
const st = { cut: 0, drop: 0, through: 0 }; for (const T of tapes) { const s = T?.sb?.[0]; if (s?.drop) st.drop++; else if (s?.through) st.through++; else if (s?.cut) st.cut++; }
console.log(`  setbacks: ${st.cut} cut, ${st.drop} dropped, ${st.through} with a road through (today's roads: ${W.towns?.city?.setbacks ? `${W.towns.city.setbacks.cut} cut, ${W.towns.city.setbacks.dropped} dropped, ${W.towns.city.setbacks.through} through` : '-'})`);
console.log(`  wrote ${out}: ${(gz.length / 1024).toFixed(0)} KB (${(raw.length / 1024).toFixed(0)} KB raw), key ${key}; ${((performance.now() - t0) / 1000).toFixed(1)} s in all`);
process.exit(0);
