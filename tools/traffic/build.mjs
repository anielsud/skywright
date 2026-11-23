// Build the road traffic and airport ground vehicles (src/vehicles.js) from free models:
//   assets/traffic/vehicles.glb   every vehicle's body at three levels of detail + its wheels (meshopt-compressed)
//   assets/traffic/atlas.webp     one colour atlas for all of them (alpha: cut-out decals)
//   assets/traffic/data.webp      R paint mask (where a car's own colour goes), G roughness, B metalness
//
// Sources (Sketchfab, CC BY 4.0; credits in main.js and README), unzipped glTF downloads in SRC_DIR:
//   generic_passenger_car_pack/            "Generic passenger car pack" by comrade1280
//   generic_civil_service_vehicles_pack/   "Generic civil service vehicles pack" by comrade1280
//   fuel_truck/                            "Fuel Truck" by abdullahjavedyo90 (the Shell livery painted out)
//   airport_baggage_equipment_cart_lowpoly/ "Airport baggage equipment (cart) lowpoly" by menX1151
//
//   npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer sharp  (any folder;
//   link its node_modules here)   then   node tools/traffic/build.mjs SRC_DIR [OUT_DIR=assets/traffic]
//
// Every vehicle comes out in the game's frame: metres, forward -Z, +Y up, standing on y = 0, centred in x and z.
// Wheels that are separate objects (all but the cart) are cut out of the body so they can spin; the
// nearest level of detail draws them separately, the farther two have them merged in.
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, quantize, dedup, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { read, prims, bbox, findNode } from './collect.mjs';

sharp.cache(false);
const [SRC, OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '../../assets/traffic')] = process.argv.slice(2);
const PREVIEW = process.env.PREVIEW === '1'; // also write OUT/preview.json (sizes, wheels, lights) for checking

// ---------- what to take ----------
// id: name in the game. node: the vehicle's node in its pack. flip: turn it 180° (its front was +Z after squaring
// up). length: scale to this length (m) when the source isn't in metres. tile: atlas size of its main texture.
// paint: the body takes each car's own colour (the paint mask). kind: car | van | truck | bus | service | airport
// turn: true/false overrides the facing test (the end with the redder light lenses is the back), for vehicles with red
// lights at both ends (emergency lights) or none modelled
const P = 'generic_passenger_car_pack', C = 'generic_civil_service_vehicles_pack';
const SPECS = [
  { id: 'compact', src: P, node: 'Compact Body', paint: true, kind: 'car' },
  { id: 'coupe', src: P, node: 'Coupe Body', paint: true, kind: 'car' },
  { id: 'hatch', src: P, node: 'Hatchback Body', paint: true, kind: 'car' },
  { id: 'minivan', src: P, node: 'minivan body', paint: true, kind: 'car' },
  { id: 'offroad', src: P, node: 'Offroad Body', paint: true, kind: 'car' },
  { id: 'pickup', src: P, node: 'Pickup Body', paint: true, kind: 'car' },
  { id: 'sedan', src: P, node: 'Sedan Body', paint: true, kind: 'car' },
  { id: 'sport', src: P, node: 'Sport body', paint: true, kind: 'car' },
  { id: 'suv', src: P, node: 'SUV Body', paint: true, kind: 'car' },
  { id: 'wagon', src: P, node: 'Wagon Body', paint: true, kind: 'car' },
  { id: 'ambulance', src: C, node: 'ambulance', kind: 'service', turn: true },
  { id: 'citybus', src: C, node: 'citybus', kind: 'bus', tile: 768 },
  { id: 'firetruck', src: C, node: 'fire_truck', kind: 'service', tile: 768 },
  { id: 'garbage', src: C, node: 'garbage_truck', kind: 'truck', tile: 768 },
  { id: 'police', src: C, node: 'police_sedan', kind: 'service', turn: false },
  { id: 'utility', src: C, node: 'rdservtruck', kind: 'truck' },
  { id: 'schoolbus', src: C, node: 'school_bus', kind: 'bus', tile: 768 },
  { id: 'taxi', src: C, node: 'taxi', kind: 'car' },
  { id: 'towtruck', src: C, node: 'towtruck', kind: 'truck' },
  { id: 'postvan', src: C, node: 'postvan', kind: 'van', turn: true },
  { id: 'tanker', src: 'fuel_truck', node: null, kind: 'truck', turn: true, tiles: { 'Material.003': 768 }, lod0: 14000 },
  { id: 'cart', src: 'airport_baggage_equipment_cart_lowpoly', node: null, kind: 'airport', length: 2.9, tile: 256, noWheels: true },
];
const LOD_TRIS = [null, 1400, 450]; // lod0 = the model as it is; lod1/lod2 targets (whole vehicle, wheels merged)

// ---------- logos painted out (pixel rectangles in the source textures) ----------
// word: red lettering on the yellow band -> band yellow. badge: the emblem on the white tank -> white.
// light: white lettering on the dark panel -> panel grey.
const DEBRAND = {
  'fuel_truck/textures/Material.003_baseColor.png': [
    { r: [620, 1426, 995, 1514], word: true }, { r: [1004, 1796, 1384, 1884], word: true },
    { r: [1104, 1418, 1226, 1526] }, { r: [794, 1744, 906, 1900] },
  ],
};

// ---------- small maths ----------
const lerp = (a, b, t) => a + (b - a) * t;
function transform(parts, fn) { for (const p of parts) for (let i = 0; i < p.P.length; i += 3) { const [x, y, z, nx, ny, nz] = fn(p.P[i], p.P[i + 1], p.P[i + 2], p.N[i], p.N[i + 1], p.N[i + 2]); p.P[i] = x; p.P[i + 1] = y; p.P[i + 2] = z; p.N[i] = nx; p.N[i + 1] = ny; p.N[i + 2] = nz; } }

// square the vehicle up: its long axis (principal axis of its footprint) along z, centred, wheels on y = 0
function squareUp(parts, spec) {
  const all = parts.flatMap((p) => p.P);
  let cx = 0, cz = 0, n = all.length / 3; for (let i = 0; i < all.length; i += 3) { cx += all[i]; cz += all[i + 2]; } cx /= n; cz /= n;
  let sxx = 0, szz = 0, sxz = 0; for (let i = 0; i < all.length; i += 3) { const x = all[i] - cx, z = all[i + 2] - cz; sxx += x * x; szz += z * z; sxz += x * z; }
  let a = 0.5 * Math.atan2(2 * sxz, sxx - szz); // principal axis angle from +x
  const rot = Math.PI / 2 - a; // turn the principal axis onto +z (which end is the front: see the facing test)
  const c = Math.cos(rot), s = Math.sin(rot);
  transform(parts, (x, y, z, nx, ny, nz) => [(x - cx) * c - (z - cz) * s, y, (x - cx) * s + (z - cz) * c, nx * c - nz * s, ny, nx * s + nz * c]);
  let b = bbox(parts.flatMap((p) => p.P));
  if (b.size[0] > b.size[2]) { transform(parts, (x, y, z, nx, ny, nz) => [z, y, -x, nz, ny, -nx]); b = bbox(parts.flatMap((p) => p.P)); }
  const k = spec.length ? spec.length / b.size[2] : 1;
  transform(parts, (x, y, z, nx, ny, nz) => [(x - b.c[0]) * k, (y - b.lo[1]) * k, (z - b.c[2]) * k, nx, ny, nz]);
  return bbox(parts.flatMap((p) => p.P));
}

// ---------- wheels ----------
// Separate wheel objects: passenger cars have them as their own nodes (given); in the other packs they're merged into
// the body, so find them: welded connected pieces that are round in side view and stand on the ground, plus whatever
// small pieces sit inside them (rims, hubs, dual tyres).
function findWheels(parts) {
  const tris = []; // [part, triStart]
  for (const p of parts) { if (/glass|decal/i.test(p.matName)) continue; for (let t = 0; t < p.I.length; t += 3) tris.push([p, t]); }
  const key = (p, i) => `${Math.round(p.P[i * 3] * 1000)},${Math.round(p.P[i * 3 + 1] * 1000)},${Math.round(p.P[i * 3 + 2] * 1000)}`;
  const id = new Map(), par = [], find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const vid = (p, i) => { const k = key(p, i); let v = id.get(k); if (v === undefined) { v = par.length; par.push(v); id.set(k, v); } return v; };
  const tv = tris.map(([p, t]) => [vid(p, p.I[t]), vid(p, p.I[t + 1]), vid(p, p.I[t + 2])]);
  for (const [a, b, c] of tv) { par[find(b)] = find(a); par[find(c)] = find(a); }
  const comps = new Map();
  tris.forEach(([p, t], k) => {
    const r = find(tv[k][0]); let C = comps.get(r); if (!C) comps.set(r, (C = { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9], tris: [] }));
    C.tris.push([p, t]);
    for (let q = 0; q < 3; q++) { const i = p.I[t + q]; for (let d = 0; d < 3; d++) { C.lo[d] = Math.min(C.lo[d], p.P[i * 3 + d]); C.hi[d] = Math.max(C.hi[d], p.P[i * 3 + d]); } }
  });
  const list = [...comps.values()].map((C) => ({ ...C, size: C.hi.map((h, d) => h - C.lo[d]), c: C.hi.map((h, d) => (h + C.lo[d]) / 2) }));
  const seeds = list.filter((C) => C.lo[1] < 0.12 && C.size[1] > 0.38 && Math.abs(C.size[1] - C.size[2]) < 0.14 * C.size[1] && C.size[0] < 0.9 * C.size[1] && Math.abs(C.c[0]) > 0.25);
  const wheels = [];
  for (const s of seeds.sort((a, b) => b.size[1] - a.size[1])) {
    const w = wheels.find((w) => Math.abs(w.c[2] - s.c[2]) < w.r * 0.5 && Math.sign(w.c[0]) === Math.sign(s.c[0]) && Math.abs(w.c[0] - s.c[0]) < 0.6);
    if (w) { w.comps.push(s); continue; }
    wheels.push({ c: s.c.slice(), r: s.size[1] / 2, comps: [s] });
  }
  for (const w of wheels) { // pieces inside the wheel (rims, nuts, hub caps), and the wheel's whole extent
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const s of w.comps) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], s.lo[d]); hi[d] = Math.max(hi[d], s.hi[d]); }
    for (const C of list) if (!w.comps.includes(C) && !seeds.includes(C) && C.lo.every((v, d) => v > lo[d] - 0.03) && C.hi.every((v, d) => v < hi[d] + 0.03)) w.comps.push(C);
    w.c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; w.r = (hi[1] - lo[1]) / 2;
  }
  return wheels;
}
// split parts into body parts and per-wheel parts (triangles moved, vertices copied)
function cutWheels(parts, wheels) {
  const taken = new Map(); // part -> Set(triStart)
  wheels.forEach((w) => { w.parts = new Map(); for (const C of w.comps) for (const [p, t] of C.tris) { if (!taken.has(p)) taken.set(p, new Set()); taken.get(p).add(t); if (!w.parts.has(p)) w.parts.set(p, []); w.parts.get(p).push(t); } });
  const sub = (p, tl) => { const map = new Map(), out = { matName: p.matName, mat: p.mat, P: [], N: [], UV: [], I: [] }; for (const t of tl) for (let q = 0; q < 3; q++) { const i = p.I[t + q]; let j = map.get(i); if (j === undefined) { j = out.P.length / 3; map.set(i, j); out.P.push(p.P[i * 3], p.P[i * 3 + 1], p.P[i * 3 + 2]); out.N.push(p.N[i * 3], p.N[i * 3 + 1], p.N[i * 3 + 2]); out.UV.push(p.UV[i * 2], p.UV[i * 2 + 1]); } out.I.push(j); } return out; };
  const body = parts.map((p) => { const s = taken.get(p); if (!s) return p; const tl = []; for (let t = 0; t < p.I.length; t += 3) if (!s.has(t)) tl.push(t); return sub(p, tl); }).filter((p) => p.I.length);
  for (const w of wheels) w.parts = [...w.parts].map(([p, tl]) => sub(p, tl));
  return body;
}

// ---------- head and tail lights: the front-most and rear-most light-lens triangles, left and right ----------
function lights(parts, b) {
  const pts = []; for (const p of parts) if (/optic/i.test(p.matName)) for (const i of p.I) pts.push([p.P[i * 3], p.P[i * 3 + 1], p.P[i * 3 + 2]]);
  const pick = (front) => {
    const end = front ? Math.min(...pts.map((q) => q[2])) : Math.max(...pts.map((q) => q[2]));
    const near = pts.filter((q) => Math.abs(q[2] - end) < 0.3 && q[1] < b.hi[1] * 0.7);
    const side = (s) => { const L = near.filter((q) => Math.sign(q[0]) === s && Math.abs(q[0]) > 0.2); if (!L.length) return null; return [0, 1, 2].map((d) => +(L.reduce((a, q) => a + q[d], 0) / L.length).toFixed(3)); };
    const l = side(-1), r = side(1);
    return l && r ? [l, r] : null;
  };
  const fb = (front) => { const z = front ? b.lo[2] - 0.02 : b.hi[2] + 0.02, y = Math.min(0.9, b.size[1] * 0.45); return [[-b.size[0] * 0.33, y, z], [b.size[0] * 0.33, y, z]].map((v) => v.map((x) => +x.toFixed(3))); };
  return { head: (pts.length && pick(true)) || fb(true), tail: (pts.length && pick(false)) || fb(false) };
}

// ---------- textures -> atlas ----------
const texCache = new Map();
async function texImage(srcDir, tex, factor, w) { // RGBA raw at w x w, factor multiplied in
  const uri = tex ? path.join(srcDir, tex.getURI()) : null;
  const k = `${uri}|${factor}|${w}`; if (texCache.has(k)) return texCache.get(k);
  let buf;
  if (uri) {
    let img = sharp(uri, { limitInputPixels: false }).ensureAlpha();
    const rel = path.relative(SRC, uri), fix = DEBRAND[rel];
    if (fix) { const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }); debrand(data, info.width, fix); img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }); }
    buf = await img.resize(w, w, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  } else buf = Buffer.alloc(w * w * 4, 255);
  if (factor.some((f) => f !== 1)) for (let i = 0; i < buf.length; i += 4) for (let c = 0; c < 4; c++) buf[i + c] = Math.round(buf[i + c] * factor[c]);
  texCache.set(k, buf); return buf;
}
function debrand(d, W, fixes) {
  const px = (x, y) => (y * W + x) * 4;
  const median = (vals) => { vals.sort((a, b) => a - b); return vals[vals.length >> 1] ?? 0; };
  for (const f of fixes) {
    const [x0, y0, x1, y1] = f.r;
    if (f.word || f.light) { // the background colour: the rectangle's most common non-lettering pixels
      const isInk = (i) => f.word ? d[i] > 110 && d[i + 1] < 110 && d[i + 2] < 110 : d[i] + d[i + 1] + d[i + 2] > 420 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 50;
      const isBg = (i) => f.word ? d[i] > 200 && d[i + 1] > 140 && d[i + 2] < 90 : d[i] + d[i + 1] + d[i + 2] < 200 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 30;
      const bg = [[], [], []]; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = px(x, y); if (isBg(i)) for (let c = 0; c < 3; c++) bg[c].push(d[i + c]); }
      const col = bg.map(median);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { // ink and its anti-aliased fringe (any pixel next to ink)
        let ink = false; for (let dy = -2; dy <= 2 && !ink; dy++) for (let dx = -2; dx <= 2 && !ink; dx++) ink = isInk(px(Math.min(x1 - 1, Math.max(x0, x + dx)), Math.min(y1 - 1, Math.max(y0, y + dy))));
        if (ink && !isBg(px(x, y))) { const i = px(x, y); for (let c = 0; c < 3; c++) d[i + c] = col[c]; }
      }
    } else { // badge: fill with the rectangle's border colour
      const bd = [[], [], []]; for (let x = x0; x < x1; x++) for (const y of [y0, y1 - 1]) { const i = px(x, y); for (let c = 0; c < 3; c++) bd[c].push(d[i + c]); }
      const col = bd.map(median); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = px(x, y); for (let c = 0; c < 3; c++) d[i + c] = col[c]; }
    }
  }
}
// The paint mask of a car body: in the passenger pack the paint is exactly the fully glossy, non-metal parts of the
// metal/roughness map (G ~ 25, B = 0), whatever its colour (black and white cars too). Painted pixels become a grey shade
// (their brightness relative to the paint's own) that each car's colour multiplies, keeping the texture's shading.
function paintMask(rgba, mr, w) {
  const mask = new Uint8Array(w * w), V = [];
  const cl = (x) => Math.min(1, Math.max(0, x)), m = (i) => cl((52 - mr[i * 4 + 1]) / 12) * cl((22 - mr[i * 4 + 2]) / 10); // paint: G ~25, B 0
  for (let i = 0; i < w * w; i++) if (m(i) > 0.5) V.push(Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]));
  V.sort((a, b) => a - b); const vref = Math.max(8, V[Math.floor(V.length * 0.75)] || 255);
  for (let i = 0; i < w * w; i++) {
    const k = m(i); mask[i] = Math.round(k * 255); if (!k) continue;
    const g = Math.min(255, Math.round((Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) / vref) * 0.85 * 255));
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(lerp(rgba[i * 4 + c], g, k));
  }
  return mask;
}

// ---------- main ----------
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const docs = {};
const vehicles = [];
for (const spec of SPECS) {
  const doc = docs[spec.src] ??= await read(path.join(SRC, spec.src, 'scene.gltf'));
  const srcRoot = doc.getRoot().listScenes()[0].listChildren()[0];
  let parts, given = [];
  if (spec.src === P) { // body node + the four wheel nodes nearest it
    const node = findNode(doc, spec.node); parts = prims(node);
    const b0 = bbox(parts.flatMap((p) => p.P)), rn = node.getParentNode();
    const wn = rn.listChildren().filter((n) => n.getName().startsWith('Wheel')).map((n) => ({ n, ps: prims(n) })).map((o) => ({ ...o, b: bbox(o.ps.flatMap((p) => p.P)) }))
      .filter((o) => o.b.c[0] > b0.lo[0] - 0.1 && o.b.c[0] < b0.hi[0] + 0.1 && o.b.c[2] > b0.lo[2] - 0.1 && o.b.c[2] < b0.hi[2] + 0.1);
    for (const o of wn) { given.push(o.ps); parts.push(...o.ps); }
  } else parts = prims(spec.node ? findNode(doc, spec.node) : srcRoot);
  for (const p of parts) { p.matName = p.mat?.getName() || ''; }
  const b = squareUp(parts, spec);
  let wheels = [];
  if (given.length) { // wheel nodes: their own triangles (now squared up with the rest)
    wheels = given.map((ps) => { const bb = bbox(ps.flatMap((p) => p.P)); return { c: bb.c, r: bb.size[1] / 2, comps: [{ tris: ps.flatMap((p) => { const o = []; for (let t = 0; t < p.I.length; t += 3) o.push([p, t]); return o; }) }] }; });
  } else if (!spec.noWheels) wheels = findWheels(parts);
  const body = cutWheels(parts, wheels);
  vehicles.push({ spec, body, wheels, b });
  console.log(spec.id.padEnd(10), `${b.size.map((x) => x.toFixed(2)).join(' x ')} m`, `${body.reduce((a, p) => a + p.I.length / 3, 0)} tris`, `wheels ${wheels.length}`, wheels.map((w) => `[${w.c.map((x) => x.toFixed(2))} r${w.r.toFixed(2)}]`).join(' '));
}

// atlas tiles: one per (texture, factor); a car body's tile also gets its paint mask
const tiles = new Map(); // key -> { w, rgba, data, x, y }
async function tileFor(v, part) {
  const m = part.mat, srcDir = path.join(SRC, v.spec.src), n = part.matName;
  const tex = m?.getBaseColorTexture(), f0 = m ? m.getBaseColorFactor() : [1, 1, 1, 1];
  // by role: glass is near enough one flat colour (drawn opaque: no see-through, nothing inside); a body texture keeps
  // the size its vehicle asks for whichever part uses it (wheels cut from a body use the body's texture)
  const role = /glass/i.test(n) ? 'glass' : /optic/i.test(n) ? 'optic' : /decal/i.test(n) ? 'decal' : /wheel|wheek/i.test(n) ? 'wheel' : 'body';
  const f = role === 'glass' ? [f0[0], f0[1], f0[2], 1] : f0;
  const w = !tex ? 16 : { glass: 32, optic: 512, decal: 256, wheel: 256 }[role] ?? (v.spec.tiles?.[n] || v.spec.tile || 512);
  const paint = !!v.spec.paint && role === 'body';
  const k = `${tex?.getURI()}|${f}|${role}|${paint}|${v.spec.src}`;
  let T = tiles.get(k); if (T) return T;
  const rgba = Buffer.from(await texImage(srcDir, tex, f, w));
  if (role !== 'decal') for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  // data: paint, roughness, metalness
  const data = Buffer.alloc(w * w * 4, 255);
  const mr = m?.getMetallicRoughnessTexture(), rf = m ? m.getRoughnessFactor() : 1, mf = m ? m.getMetallicFactor() : 0;
  const mrBuf = mr ? await texImage(srcDir, mr, [1, 1, 1, 1], w) : null;
  const glass = role === 'glass';
  for (let i = 0; i < w * w; i++) {
    data[i * 4] = 0;
    data[i * 4 + 1] = glass ? 20 : Math.round((mrBuf ? mrBuf[i * 4 + 1] : 255) * rf);
    data[i * 4 + 2] = glass ? 0 : Math.round((mrBuf ? mrBuf[i * 4 + 2] : 255) * mf);
  }
  if (paint && mrBuf) { const mask = paintMask(rgba, mrBuf, w); for (let i = 0; i < w * w; i++) data[i * 4] = mask[i]; }
  T = { w, rgba, data }; tiles.set(k, T); return T;
}
for (const v of vehicles) {
  for (const p of v.body) { p.isBody = true; p.tile = await tileFor(v, p); }
  for (const wh of v.wheels) for (const p of wh.parts) p.tile = await tileFor(v, p);
  // which way it faces: the end whose light lenses are redder is the back (tail lights), so that end goes to +z
  const red = (end) => { let s = 0, n = 0; for (const p of v.body) if (/optic/i.test(p.matName)) for (const i of p.I) { if (Math.abs(p.P[i * 3 + 2] - end) > 0.45) continue; const T = p.tile, x = Math.round(Math.min(1, Math.max(0, p.UV[i * 2])) * (T.w - 1)), y = Math.round(Math.min(1, Math.max(0, p.UV[i * 2 + 1])) * (T.w - 1)), k = (y * T.w + x) * 4; s += T.rgba[k] - (T.rgba[k + 1] + T.rgba[k + 2]) / 2; n++; } return n ? s / n : 0; };
  const rf = red(v.b.lo[2]), rb = red(v.b.hi[2]), turn = v.spec.turn ?? rf > rb + 8;
  if (turn) { const t = (x, y, z, nx, ny, nz) => [-x, y, -z, -nx, ny, -nz]; transform(v.body, t); for (const w of v.wheels) { transform(w.parts, t); w.c = [-w.c[0], w.c[1], -w.c[2]]; } v.b = bbox(v.body.flatMap((p) => p.P).concat(v.wheels.flatMap((w) => w.parts.flatMap((p) => p.P)))); }
  Object.assign(v, lights(v.body, v.b));
  console.log(v.spec.id.padEnd(10), `lenses red front ${rf.toFixed(0)} back ${rb.toFixed(0)}${turn ? ': turned round' : ''}`);
}
// shelf-pack the tiles (biggest first) into a 4096-wide atlas, each with a 4 px gutter of its own edge pixels
const G = 4, AW = 4096, list = [...tiles.values()].sort((a, b) => b.w - a.w);
let sx = 0, sy = 0, shelf = 0;
for (const T of list) { const s = T.w + 2 * G; if (sx + s > AW) { sx = 0; sy += shelf; shelf = 0; } T.x = sx + G; T.y = sy + G; sx += s; shelf = Math.max(shelf, s); }
const AH = Math.ceil((sy + shelf) / 256) * 256; // (WebGL2: any size mipmaps)
console.log(`atlas ${AW} x ${AH}: ${list.length} tiles`);
if (process.env.TILES) for (const [k, T] of tiles) console.log('  tile', T.w, k);
const atlas = Buffer.alloc(AW * AH * 4), datab = Buffer.alloc(AW * AH * 4);
for (const T of list) for (const [dst, src] of [[atlas, T.rgba], [datab, T.data]]) for (let y = -G; y < T.w + G; y++) for (let x = -G; x < T.w + G; x++) {
  const sx2 = Math.min(T.w - 1, Math.max(0, x)), sy2 = Math.min(T.w - 1, Math.max(0, y)), si = (sy2 * T.w + sx2) * 4, di = ((T.y + y) * AW + T.x + x) * 4;
  for (let c = 0; c < 4; c++) dst[di + c] = src[si + c];
}
fs.mkdirSync(OUT, { recursive: true });
await sharp(atlas, { raw: { width: AW, height: AH, channels: 4 } }).webp({ quality: 88, alphaQuality: 90, effort: 6 }).toFile(path.join(OUT, 'atlas.webp'));
await sharp(datab, { raw: { width: AW, height: AH, channels: 4 } }).removeAlpha().resize(AW / 2, AH / 2).webp({ quality: 90, effort: 6 }).toFile(path.join(OUT, 'data.webp'));

// ---------- geometry ----------
// a part's UVs into its tile (clamped to the tile: a few source UVs stray just outside 0..1; glTF v runs down)
function atlasUV(p) { const T = p.tile, o = []; for (let i = 0; i < p.UV.length; i += 2) { let u = p.UV[i], v = p.UV[i + 1]; if (v < -0.001 && v >= -1.001) v += 1; u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v)); o.push((T.x + 0.5 + u * (T.w - 1)) / AW, (T.y + 0.5 + v * (T.w - 1)) / AH); } return o; }
function merge(parts, offset = [0, 0, 0]) {
  const P = [], N = [], UV = [], I = [];
  for (const p of parts) { const base = P.length / 3; for (let i = 0; i < p.P.length; i += 3) P.push(p.P[i] - offset[0], p.P[i + 1] - offset[1], p.P[i + 2] - offset[2]); for (const x of p.N) N.push(x); for (const x of atlasUV(p)) UV.push(x); for (const i of p.I) I.push(base + i); }
  return { P: new Float32Array(P), N: new Float32Array(N), UV: new Float32Array(UV), I: new Uint32Array(I) };
}
function simplify(g, target, maxErr = 0.25) {
  if (g.I.length / 3 <= target) return g;
  // Prune: small loose pieces (mirrors, bolts, badges) go when they're below the error; Permissive: collapses may cross
  // UV seams, with the UVs weighted so the texture stays put (these models are dozens of separate pieces, which
  // the plain simplifier keeps whole, stalling at ~1700 triangles)
  const [out, err] = MeshoptSimplifier.simplifyWithAttributes(g.I, g.P, 3, g.UV, 2, [1.5, 1.5], null, target * 3, maxErr, ['Prune', 'Permissive']);
  if (process.env.TILES) console.log(`  simplify ${g.I.length / 3} -> ${out.length / 3} (target ${target}, error ${err.toFixed(3)})`);
  return { ...g, I: new Uint32Array(out) };
}
function compact(g) { const map = new Map(), P = [], N = [], UV = [], I = []; for (const i of g.I) { let j = map.get(i); if (j === undefined) { j = P.length / 3; map.set(i, j); P.push(g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]); N.push(g.N[i * 3], g.N[i * 3 + 1], g.N[i * 3 + 2]); UV.push(g.UV[i * 2], g.UV[i * 2 + 1]); } I.push(j); } return { P: new Float32Array(P), N: new Float32Array(N), UV: new Float32Array(UV), I: new Uint32Array(I) }; }

const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene('traffic'), mat = doc.createMaterial('traffic');
const mesh = (name, g) => {
  g = compact(g);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(g.P).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(g.N).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(g.UV).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(g.I.length / 3 * 3 < 65536 && g.P.length / 3 < 65536 ? new Uint16Array(g.I) : g.I).setBuffer(buf));
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  return g.I.length / 3;
};
const meta = {};
for (const v of vehicles) {
  const id = v.spec.id, whole = merge([...v.body, ...v.wheels.flatMap((w) => w.parts)]);
  const tris = [mesh(`${id}_lod0`, v.spec.lod0 ? simplify(merge(v.body), v.spec.lod0) : merge(v.body))];
  for (let l = 1; l < LOD_TRIS.length; l++) tris.push(mesh(`${id}_lod${l}`, simplify(whole, LOD_TRIS[l])));
  const wheels = v.wheels.map((w, k) => { tris.push(mesh(`${id}_wheel${k}`, simplify(merge(w.parts, w.c), 600, 0.02))); return [...w.c.map((x) => +x.toFixed(3)), +w.r.toFixed(3)]; });
  meta[id] = { kind: v.spec.kind, paint: !!v.spec.paint, L: +v.b.size[2].toFixed(3), W: +v.b.size[0].toFixed(3), H: +v.b.size[1].toFixed(3), wheels, head: v.head, tail: v.tail, tris };
}
scene.setExtras({ vehicles: meta, atlas: [AW, AH], credits: 'comrade1280, abdullahjavedyo90, menX1151 (Sketchfab, CC BY 4.0)' });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await doc.transform(dedup(), prune({ keepAttributes: true }), // (the material has no textures in the file: prune would drop the UVs)
   quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 14 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(path.join(OUT, 'vehicles.glb'), doc);
if (PREVIEW) fs.writeFileSync(path.join(OUT, 'preview.json'), JSON.stringify(meta, null, 1));
for (const f of ['vehicles.glb', 'atlas.webp', 'data.webp']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), 'MB');
