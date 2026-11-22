// Build assets/landmarks/liberty.glb (realLandmarks.js) from TT3D's photogrammetry scan of the Statue of Liberty
// (Sketchfab "Statue of Liberty" by TT3D, CC BY 4.0: https://sketchfab.com/3d-models/statue-of-liberty-a66ff5ea231f42e8839d68116dbfec8c).
//   npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer   (in any folder)
//   node statue.mjs statue_of_liberty.glb OUT.glb        (copy this file next to that node_modules)
// The scan is the statue on the top of its pedestal, over a shell of trees and the fort's roof. Kept: the statue and
// the pedestal down to CUT (below that the game builds the pedestal's base, the foundation and Fort Wood itself),
// stray fragments dropped. Out: metres, the statue's base (the top of the pedestal) at the origin, facing -Z (her
// right arm, with the torch, towards +X), three levels of detail (lod0..lod2) and the torch's flame (flame), each one mesh with vertex colours ( the
// scan's colours eased towards copper green and pink-grey granite, keeping its weathering), meshopt-compressed.
// The scene's extras: { torch: [x, y, z] (the flame's top), cut: { y, half } (the pedestal's cut: its height and
// half-width there), credit }.
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, dedup, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

const [SRC, OUT] = process.argv.slice(2);
const STATUE_H = 46.05; // the statue, base to the top of the torch's flame (m)
const LODS = [90000, 24000, 6000]; // triangles
const AXIS = [0.2, 7.7], CUT_Y = -3.35, CUT_R = 3.2; // in the scan: the pedestal's axis (x, z), the cut, the radius kept

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready; await MeshoptEncoder.ready; io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const src = await io.read(SRC);

// 1. every triangle in world space (the scan's node transforms baked), with its colours
const mul = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
let P = [], C = [], I = [];
for (const n of src.getRoot().listNodes()) {
  const me = n.getMesh(); if (!me) continue; const W = n.getWorldMatrix();
  for (const p of me.listPrimitives()) {
    const a = p.getAttribute('POSITION'), c = p.getAttribute('COLOR_0'), idx = p.getIndices(), base = P.length / 3, v = [0, 0, 0], k = [1, 1, 1, 1];
    for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); P.push(...mul(W, v)); if (c) c.getElement(i, k); C.push(k[0], k[1], k[2]); }
    for (let i = 0; i < idx.getCount(); i++) I.push(base + idx.getScalar(i));
  }
}
console.log('scan:', P.length / 3, 'vertices', I.length / 3, 'triangles');
// 2. crop: the statue and the pedestal above the cut, within CUT_R of the axis
const keep = (i) => P[i * 3 + 1] > CUT_Y && Math.hypot(P[i * 3] - AXIS[0], P[i * 3 + 2] - AXIS[1]) < CUT_R;
let T = []; for (let t = 0; t < I.length; t += 3) if (keep(I[t]) && keep(I[t + 1]) && keep(I[t + 2])) T.push(I[t], I[t + 1], I[t + 2]);
// 3. weld by position (the scan comes in 18 chunks), then keep the big connected pieces (no floating specks)
const key = (i) => `${Math.round(P[i * 3] * 2000)},${Math.round(P[i * 3 + 1] * 2000)},${Math.round(P[i * 3 + 2] * 2000)}`;
const rep = new Map(), canon = new Int32Array(P.length / 3).fill(-1);
for (const i of T) if (canon[i] < 0) { const k = key(i); if (!rep.has(k)) rep.set(k, i); canon[i] = rep.get(k); }
T = T.map((i) => canon[i]);
const par = new Int32Array(P.length / 3).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
for (let t = 0; t < T.length; t += 3) { const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]); par[b] = a; par[find(c)] = a; }
const size = new Map(); for (let t = 0; t < T.length; t += 3) { const r = find(T[t]); size.set(r, (size.get(r) || 0) + 1); }
const big = Math.max(...size.values()), T2 = [];
for (let t = 0; t < T.length; t += 3) if (size.get(find(T[t])) > big * 0.004) T2.push(T[t], T[t + 1], T[t + 2]);
console.log('cropped:', T.length / 3, '-> kept', T2.length / 3, 'triangles in', [...size.values()].filter((s) => s > big * 0.004).length, 'pieces');
// 4. where the statue starts: the lowest height where the copper green takes over (green above red), and the top
const used = [...new Set(T2)];
let top = -1e9; for (const i of used) top = Math.max(top, P[i * 3 + 1]);
const slice = 0.05, gr = new Map();
for (const i of used) { const s = Math.floor(P[i * 3 + 1] / slice); const g = gr.get(s) || [0, 0]; g[0] += C[i * 3 + 1] - C[i * 3]; g[1]++; gr.set(s, g); }
let base = null; for (let s = Math.floor(CUT_Y / slice) + 2; s * slice < top; s++) { const ok = [0, 1, 2].every((d) => { const g = gr.get(s + d); return g && g[0] / g[1] > 0.02; }); if (ok) { base = s * slice; break; } }
const S = STATUE_H / (top - base);
console.log(`statue from y ${base.toFixed(2)} to ${top.toFixed(2)} (scan units): scale ${S.toFixed(3)} m/unit; pedestal kept ${((base - CUT_Y) * S).toFixed(1)} m`);
// 5. facing: her torch is up to her right; front = up x right
let tq = [0, 0, 0], tn = 0; for (const i of used) if (P[i * 3 + 1] > top - 0.6) { tq[0] += P[i * 3]; tq[2] += P[i * 3 + 2]; tn++; }
const rx = tq[0] / tn - AXIS[0], rz = tq[2] / tn - AXIS[1], rl = Math.hypot(rx, rz), right = [rx / rl, rz / rl];
const ang = Math.atan2(right[1], right[0]); // rotate so right -> +X (front then -Z)
const ca = Math.cos(-ang), sa = Math.sin(-ang);
const place = (i) => { const x = P[i * 3] - AXIS[0], z = P[i * 3 + 2] - AXIS[1]; return [(x * ca - z * sa) * S, (P[i * 3 + 1] - base) * S, (x * sa + z * ca) * S]; };
// 6. colours: copper green above the base, granite below, the scan's light and dark kept as weathering (but its baked
// sunlight evened out), the torch's flame gold
const lum = (i) => 0.3 * C[i * 3] + 0.59 * C[i * 3 + 1] + 0.11 * C[i * 3 + 2];
const mean = (f) => { let s = 0, n = 0; for (const i of used) if (f(i)) { s += lum(i); n++; } return s / n; };
const above = (i) => P[i * 3 + 1] >= base, mA = mean(above), mB = mean((i) => !above(i));
const lin = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((c) => (c / 255) ** 2.2);
const COPPER = lin(0xa9c9b8), COPPER_D = lin(0x6f9888), GRANITE = lin(0xc2b6a4), GOLD = lin(0xe0b050);
const colour = (i) => {
  const y = (P[i * 3 + 1] - base) * S, v = Math.max(0.55, Math.min(1.45, lum(i) / (above(i) ? mA : mB)));
  if (y > STATUE_H - 2.6) return GOLD.map((c) => c * (0.8 + 0.2 * v)); // (only the flame is that high)
  if (y >= 0) { const w = (v - 0.55) / 0.9; return COPPER_D.map((d, k) => (d + (COPPER[k] - d) * w) * (0.9 + 0.1 * v)); }
  return GRANITE.map((c) => c * (0.78 + 0.22 * v));
};
// 7. one document: positions, colours; welded, normals, then the three levels
const vmap = new Map(); used.forEach((i, k) => vmap.set(i, k));
const pos = new Float32Array(used.length * 3), col = new Float32Array(used.length * 3);
used.forEach((i, k) => { pos.set(place(i), k * 3); col.set(colour(i), k * 3); });
const ind = new Uint32Array(T2.map((i) => vmap.get(i)));
// centred on the pedestal: the middle of its footprint over the lowest 8 m kept
{ let lx = 1e9, hx = -1e9, lz = 1e9, hz = -1e9; const yc = (CUT_Y - base) * S + 8;
  for (let k = 0; k < used.length; k++) if (pos[k * 3 + 1] < yc) { lx = Math.min(lx, pos[k * 3]); hx = Math.max(hx, pos[k * 3]); lz = Math.min(lz, pos[k * 3 + 2]); hz = Math.max(hz, pos[k * 3 + 2]); }
  const cx = (lx + hx) / 2, cz = (lz + hz) / 2; for (let k = 0; k < used.length; k++) { pos[k * 3] -= cx; pos[k * 3 + 2] -= cz; }
  console.log(`recentred on the pedestal by (${cx.toFixed(2)}, ${cz.toFixed(2)}) m`); }
const torch = [0, 0, 0]; { let n = 0, ty = -1e9; for (let k = 0; k < used.length; k++) if (pos[k * 3 + 1] > STATUE_H - 0.6) { torch[0] += pos[k * 3]; torch[2] += pos[k * 3 + 2]; n++; ty = Math.max(ty, pos[k * 3 + 1]); } torch[0] /= n; torch[2] /= n; torch[1] = ty; }
let half = 0; for (let k = 0; k < used.length; k++) if (pos[k * 3 + 1] < (CUT_Y - base) * S + 1.5) half = Math.max(half, Math.abs(pos[k * 3]), Math.abs(pos[k * 3 + 2]));
const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene('liberty');
const mat = doc.createMaterial('liberty').setRoughnessFactor(0.7).setMetallicFactor(0);
// (the scan's chunks share positions: weld those first, so the simplifier sees one surface)
const wk = new Map(), remap = new Uint32Array(used.length); let nv = 0;
for (let k = 0; k < used.length; k++) { const q = `${Math.round(pos[k * 3] * 500)},${Math.round(pos[k * 3 + 1] * 500)},${Math.round(pos[k * 3 + 2] * 500)}`; if (!wk.has(q)) wk.set(q, nv++); remap[k] = wk.get(q); }
const wpos = new Float32Array(nv * 3), wcol = new Float32Array(nv * 3);
for (let k = 0; k < used.length; k++) { wpos.set(pos.subarray(k * 3, k * 3 + 3), remap[k] * 3); wcol.set(col.subarray(k * 3, k * 3 + 3), remap[k] * 3); }
const wind = ind.map((i) => remap[i]);
// the torch's flame (the top 2.6 m): its own mesh, so the game can light it at night
const FLAME_Y = STATUE_H - 2.6, inFlame = (i) => wpos[i * 3 + 1] > FLAME_Y;
const fl = [], body = [];
for (let t = 0; t < wind.length; t += 3) (inFlame(wind[t]) && inFlame(wind[t + 1]) && inFlame(wind[t + 2]) ? fl : body).push(wind[t], wind[t + 1], wind[t + 2]);
const parts = [...LODS.map((n, l) => ['lod' + l, Uint32Array.from(body), n]), ['flame', Uint32Array.from(fl), 1500]];
for (const [name, src0, target] of parts) {
  let li = src0;
  if (src0.length / 3 > target) [li] = MeshoptSimplifier.simplify(src0, wpos, 3, target * 3, 0.02, []);
  // compact to the vertices used, smooth normals (area-weighted)
  const vm = new Int32Array(nv).fill(-1), order = []; for (const i of li) if (vm[i] < 0) { vm[i] = order.length; order.push(i); }
  const P3 = new Float32Array(order.length * 3), C3 = new Float32Array(order.length * 3), N3 = new Float32Array(order.length * 3), I3 = new Uint32Array(li.length);
  order.forEach((i, k) => { P3.set(wpos.subarray(i * 3, i * 3 + 3), k * 3); C3.set(wcol.subarray(i * 3, i * 3 + 3), k * 3); });
  for (let t = 0; t < li.length; t++) I3[t] = vm[li[t]];
  for (let t = 0; t < I3.length; t += 3) {
    const [a, b, c] = [I3[t] * 3, I3[t + 1] * 3, I3[t + 2] * 3], e1 = [0, 1, 2].map((k) => P3[b + k] - P3[a + k]), e2 = [0, 1, 2].map((k) => P3[c + k] - P3[a + k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) N3[v + k] += n[k];
  }
  for (let v = 0; v < N3.length; v += 3) { const m = Math.hypot(N3[v], N3[v + 1], N3[v + 2]) || 1; N3[v] /= m; N3[v + 1] /= m; N3[v + 2] /= m; }
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  const op = doc.createPrimitive().setMaterial(mat).setIndices(acc('SCALAR', I3)).setAttribute('POSITION', acc('VEC3', P3)).setAttribute('NORMAL', acc('VEC3', N3)).setAttribute('COLOR_0', acc('VEC3', C3));
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(op)));
  console.log(`${name}: ${I3.length / 3} triangles, ${order.length} vertices`);
}
scene.setExtras({ torch: torch.map((v) => +v.toFixed(2)), cut: { y: +((CUT_Y - base) * S).toFixed(2), half: +half.toFixed(2) }, credit: 'Statue of Liberty scan by TT3D (sketchfab.com/tt3d), CC BY 4.0' });
doc.getRoot().getAsset().extras = { credit: 'Statue of Liberty scan by TT3D (https://sketchfab.com/tt3d), CC BY 4.0, cropped, recoloured and simplified for Skywright' };
await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(OUT, doc);
console.log('extras', JSON.stringify(scene.getExtras()));
