// Bakes a city's setbacks against its baked road layout (#294; src/layout/setbacks.js) and writes
// assets/real/<id>/setbacks.bin.gz (committed; keyed to the layout's index: a re-baked layout makes it stale, and the
// game works them out at load as before until this is run again). Deterministic: the same code and data give the same
// bytes (gzip without a timestamp).
//
//   node --import ./tools/test/node/setup.mjs tools/bake/setbacks.mjs nyc
//
// 1. each tall building's ground: the layout's surface (fine) at its footprint's corners, lowest and highest (as
//    city.py samples the hi grid), where its chunks are baked;
//    (all.mjs: answered by the layout bake's checks, from the meshes they make anyway; run alone: the chunks meshed
//    on a worker per core, heights.mjs);
// 2. the building lines: each baked street out to its pavement's (or verge's) edge; today's roads in the chunks not baked;
// 3. the city's tall buildings built once with those (realCity.js CityScenery.bake), every road-dependent answer recorded.
import { writeFileSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { worldAt } from '../test/node/world.mjs';
import { CityScenery, readRec } from '../../src/realCity.js';
import { Layout } from '../../src/layout/runtime.js';
import { roadIndex } from '../../src/setback.js';
import { groundGrid, latticeHeights } from '../../src/layout/rules.js';
import { latticeOf } from '../../src/layout/mesh.js';
import { groundBytes } from '../../src/layout/format.js';
import { overlayKey, hashBytes, SETBACK_CODE, buildingLines, encodeSetbacks } from '../../src/layout/setbacks.js';
import { onWorkers, workers } from './pool.mjs';

if (import.meta.url === pathToFileURL(process.argv[1]).href) { // (run as a script; all.mjs calls bakeSetbacks with the layout bake's World)
  globalThis.SKY_LAYOUT = true; globalThis.SKY_SETBACKS = false; globalThis.SKY_LAYOUT_LAZY = false; // (the World with its layout, its ground today's as before (node/world.mjs lazyLayout); no overlay read while baking one)
  const id = process.argv[2] || 'nyc'; await bakeSetbacks(id, (await worldAt(id)).world);
  process.exit(0);
}
// A city's tall records (city.bin's order) and the points the stage asks the layout's height at: each footprint's
// corners, grouped by the chunk (size S) each falls in: { recs, asks: Map('ix,iz' -> Float64Array x, z, ...) }. The
// layout bake can answer them as it checks its chunks (all.mjs: layout.mjs bakePlace's asks), from the same meshes.
export function tallCorners(W, S) {
  const city = W.real.city, H = city.hdr, q = H.q, R = {}, recs = [], asks = new Map();
  for (const t of H.tiles) {
    const cx = H.x0 + (t[0] + 0.5) * H.tile, cz = H.z0 + (t[1] + 0.5) * H.tile; let o = t[2];
    for (let r = 0; r < t[3]; r++) { readRec(city.U, city.S, o, q, cx, cz, R); const P = R.P.map((p) => [p[0], p[1]]); recs.push({ o, P, g0: R.g0, g1: R.g1 }); o = R.next; }
  }
  for (const r of recs) for (const [x, z] of r.P) { const k = Math.floor(x / S) + ',' + Math.floor(z / S); (asks.get(k) || asks.set(k, []).get(k)).push(x, z); }
  for (const [k, a] of asks) asks.set(k, Float64Array.from(a));
  return { recs, asks };
}
// W: the place's World (with or without its layout: the stage reads none of the World's own; nor the overlay: D.setbacks
// is only read with the layout wanted); answered: Map('ix,iz' -> heights at tallCorners' asks there), from the layout
// bake's checks (all.mjs); any baked chunk's not there are worked out here. -> a summary for all.mjs
export async function bakeSetbacks(id, W, answered = new Map()) {
  const t0 = performance.now(), D = W.real, index = JSON.parse(readFileSync(`assets/real/${id}/layout/index.json`, 'utf8'));
  const tw = performance.now(), L = new Layout(W, index, `assets/real/${id}/layout/`), S = index.size;
  // ---- 1. the ground under each tall record: each corner the runtime's way (Layout.heightAt: its chunk's fine mesh, if
  // that chunk is baked); the chunks not answered already meshed in parallel, a worker per core (heights.mjs)
  const { recs, asks } = tallCorners(W, S), ground = new Map(), grid = groundGrid(W), ck = (x, z) => Math.floor(x / S) + ',' + Math.floor(z / S);
  const jobs = [...asks].filter(([k]) => L.index.has(k) && !answered.has(k)).map(([k, Q]) => { const e = L.index.get(k), buf = e.file ? gunzipSync(readFileSync(`assets/real/${id}/layout/${e.file}`)) : groundBytes(e.ix, e.iz, !!W.loc.city), lat = latticeOf({ x0: e.ix * S, z0: e.iz * S, size: S }, grid);
    return { k, buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), G: latticeHeights(W, grid, lat), Q }; });
  const tl = performance.now(), hts = new Map(), at = new Map();
  for (const [k, H] of answered) if (L.index.has(k)) hts.set(k, H);
  if (jobs.length) for (const [k, H] of await onWorkers(new URL('./heights.mjs', import.meta.url), jobs, { grid })) hts.set(k, H);
  for (const k of hts.keys()) at.set(k, 0);
  let moved = 0;
  for (const r of recs) {
    let lo = Infinity, hi = -Infinity;
    for (const [x, z] of r.P) { const k = ck(x, z); if (!hts.has(k)) continue; const i = at.get(k), h = hts.get(k)[i]; at.set(k, i + 1); if (h === h) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }
    if (lo === Infinity) continue;
    const g0 = Math.round(lo * 4), g1 = Math.round(hi * 4); // (quarter metres, as city.bin)
    if (g0 !== Math.round(r.g0 * 4) || g1 !== Math.round(r.g1 * 4)) { ground.set(r.o, [g0 - Math.round(r.g0 * 4), g1 - Math.round(r.g1 * 4)]); moved++; } // (the change from city.bin's)
  }
  const tg = performance.now();
  console.log(`${id}: ${recs.length} tall records; ground from the layout for ${moved} (${hts.size - jobs.length} chunks answered by the layout's checks, ${jobs.length} meshed here${jobs.length ? ` on ${workers(jobs.length)} workers` : ''}) in ${((tg - tw) / 1000).toFixed(1)} s (lattices ${((tl - tw) / 1000).toFixed(1)} s)`);
  // ---- 2. the building lines
  const Ls = []; for (const k of L.index.keys()) Ls.push((await L.load(k)).L);
  const old = roadIndex(W), lines = buildingLines(Ls, old, S, (x, z) => W.rawHeight(x, z)); L.chunks.clear(); L.active.clear(); L.act.clear();
  console.log(`  building lines: ${lines.segs.length} segments (${lines.segs.length - lines.kept} the layout's, ${lines.kept} today's outside its chunks)`);
  // ---- 3. the tall buildings, recorded
  const tl2 = performance.now();
  CityScenery.bake = { roads: lines, ground };
  let C; try { C = new CityScenery(W, D, new THREE.Group()); } finally { CityScenery.bake = null; }
  const tapes = Array.from({ length: recs.length }, (_, i) => C.tapes[i] || null), key = bakedKey(id, index);
  const raw = encodeSetbacks(tapes, key, lines), gz = gzipSync(raw, { level: 9 }), out = `assets/real/${id}/setbacks.bin.gz`;
  writeFileSync(out, gz);
  const st = { cut: 0, drop: 0, through: 0 }; for (const T of tapes) { const s = T?.sb?.[0]; if (s?.drop) st.drop++; else if (s?.through) st.through++; else if (s?.cut) st.cut++; }
  console.log(`  setbacks: ${st.cut} cut, ${st.drop} dropped, ${st.through} with a road through (today's roads: ${W.towns?.city?.setbacks ? `${W.towns.city.setbacks.cut} cut, ${W.towns.city.setbacks.dropped} dropped, ${W.towns.city.setbacks.through} through` : '-'})`);
  console.log(`  wrote ${out}: ${(gz.length / 1024).toFixed(0)} KB (${(raw.length / 1024).toFixed(0)} KB raw), key ${key}; ${((performance.now() - t0) / 1000).toFixed(1)} s in all (ground ${((tg - tw) / 1000).toFixed(1)} s, lines ${((tl2 - tg) / 1000).toFixed(1)} s, buildings ${((performance.now() - tl2) / 1000).toFixed(1)} s)`);
  return { id, kb: gz.length / 1024, ...st, s: { ground: (tg - tw) / 1000, lines: (tl2 - tg) / 1000, buildings: (performance.now() - tl2) / 1000, all: (performance.now() - t0) / 1000 } };
}
// the key an overlay baked now gets (layout/setbacks.js overlayKey: the layout's, city.bin.gz's bytes', the setback code's)
export function bakedKey(id, index = JSON.parse(readFileSync(`assets/real/${id}/layout/index.json`, 'utf8'))) { return overlayKey(index, hashBytes(new Uint8Array(readFileSync(`assets/real/${id}/city.bin.gz`))), SETBACK_CODE.map((f) => readFileSync(f, 'utf8'))); }
