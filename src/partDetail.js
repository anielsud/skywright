// Visual-only detail for individual parts: twisted propeller blades, cowling louvres and exhaust stacks, jet intake
// lips / compressor faces / nozzle petals, oleo landing gear with torque links and brake lines, cockpit fittings.
// Only built when a part is built with { detail } (flight, hangar, traffic). partInfo() builds parts without it, so
// nothing here can change hull points, mass centres or any other physics input.
// Small pieces are tagged near (userData.near): planeDetail's LOD hides them beyond a few dozen metres.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { M } from './materials.js';
import { PM, lightGeometry } from './planeMaterials.js';
import { LivePanel } from './liveDisplays.js';
import { revolve, airfoil } from './parts.js'; // (circular, used at build time only)
import { bubbleInterior } from './bubbleCockpit.js'; // (circular, used at build time only)
import { fighterInterior } from './jetCockpit.js'; // (circular too: build time only)

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const KEEP = ['position', 'normal', 'uv', 'uv1'];
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
export const mx = (p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => new THREE.Matrix4().compose(V(...p), _q.setFromEuler(_e.set(...r)), V(...s));

// Same attribute set + an index on every geometry so a Bag can merge them.
// Zero-length normals (degenerate tips, collapsed rings) turn into NaN in the lighting shader, and bloom smears a NaN
// pixel into a black block: give them the direction away from the geometry's centre instead.
export function fixNormals(g) {
  const n = g.attributes.normal, p = g.attributes.position; if (!n) return g;
  let c = null;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i), y = n.getY(i), z = n.getZ(i), l = Math.hypot(x, y, z);
    if (l > 1e-6 && Number.isFinite(l)) continue;
    if (!c) { g.computeBoundingBox(); c = g.boundingBox.getCenter(new THREE.Vector3()); }
    const d = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).sub(c); if (d.lengthSq() < 1e-12) d.set(0, 1, 0); d.normalize();
    n.setXYZ(i, d.x, d.y, d.z);
  }
  n.needsUpdate = true; return g;
}
export function norm(g) {
  for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  fixNormals(g);
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.index) { const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
  g.clearGroups(); g.morphAttributes = {};
  return g;
}
// Collects small geometries per material and emits one merged mesh per material (few draw calls even unmerged).
export class Bag {
  constructor() { this.b = new Map(); }
  add(geo, mat, m) { const g = norm(geo); if (m) g.applyMatrix4(m); if (!this.b.has(mat)) this.b.set(mat, []); this.b.get(mat).push(g); return this; }
  merged() { const out = []; for (const [mat, gs] of this.b) out.push([mat, gs.length > 1 ? mergeGeometries(gs) : gs[0]]); this.b.clear(); return out; }
  to(parent, near = false) {
    for (const [mat, gs] of this.b) {
      const mesh = new THREE.Mesh(gs.length > 1 ? mergeGeometries(gs) : gs[0], mat);
      if (near) { mesh.userData.near = true; mesh.castShadow = false; }
      parent.add(mesh);
    }
    this.b.clear(); return parent;
  }
}

// ---------- one material for all small metal / rubber / black fittings ----------
// A 16-texel palette: colour in the map, roughness (G) and metalness (B) in a second texture sampled at the same uv.
// Meshes using one of the stock fitting materials are re-coloured through uv into the kit material when a plane is
// merged, so a whole rigid piece's fittings cost one draw call. (Textured ones, like tyres, keep their own material.)
const KIT = [['steel', 0x8b9097, 1, 0.25], ['darkMetal', 0x2b2d31, 0.7, 0.45], ['aluminum', 0xc9ccd1, 0.9, 0.32], ['chrome', 0xffffff, 1, 0.08],
  ['rubber', 0x1a1a1a, 0, 0.9], ['black', 0x111215, 0.3, 0.6], ['prop', 0x222326, 0.4, 0.5], ['propTip', 0xf2c300, 0.2, 0.5], ['pilot', 0xeaeaea, 0.1, 0.5],
  ['visor', 0x332200, 0.9, 0.1], ['PMexhaust', 0x0d0c0b, 0, 1], ['PMseat', 0x24262a, 0, 0.85], ['brushed', 0xb9bdc3, 0.9, 0.38], ['polished', 0xd8dbe0, 1, 0.12], ['hot', 0x5a4a3e, 0.85, 0.42], ['titanium', 0x7d828a, 0.9, 0.45], ['anodised', 0x9c8c4e, 0.75, 0.35]];
let kitMat = null, kitSlots = null;
export function kitMaterial() {
  if (kitMat) return kitMat;
  const mk = (f) => { const c = document.createElement('canvas'); c.width = KIT.length; c.height = 1; const g = c.getContext('2d'); KIT.forEach((k, i) => { g.fillStyle = f(k); g.fillRect(i, 0, 1, 1); }); const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; };
  const col = mk((k) => '#' + k[1].toString(16).padStart(6, '0')); col.colorSpace = THREE.SRGBColorSpace;
  const rm = mk((k) => `rgb(0,${Math.round(k[3] * 255)},${Math.round(k[2] * 255)})`);
  kitMat = new THREE.MeshStandardMaterial({ map: col, roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: 1 });
  return kitMat;
}
export function kitSlot(mat) {
  if (!kitSlots) {
    kitSlots = new Map();
    KIT.forEach(([k], i) => { const m = k.startsWith('PM') ? PM[k[2].toLowerCase() + k.slice(3)]() : M[k] ? M[k]() : PM.metal(k); kitSlots.set(m, i); });
  }
  return kitSlots.has(mat) ? kitSlots.get(mat) : -1;
}
// geometry (already normalised) re-coloured for kit slot i
export function kitUV(g, i) { const a = g.attributes.uv, u = (i + 0.5) / KIT.length; for (let k = 0; k < a.count; k++) a.setXY(k, u, 0.5); return g; }

// a box or round rod from a to b
export function bar(a, b, w, h = w, round = false, segs = 8) {
  const d = b.clone().sub(a), L = Math.max(1e-4, d.length());
  const g = round ? new THREE.CylinderGeometry(w / 2, h / 2, L, segs, 1, false) : new THREE.BoxGeometry(w, L, h);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1)));
  return g;
}
export const tube = (pts, r, segs = 6, steps = 0) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps || pts.length * 5, r, segs, false);
// a tube with its ends closed (pipes, cage tubes, bows: their open ends showed as holes)
export function pipe(pts, r, segs = 6, steps = 0) {
  const g = tube(pts, r, segs, steps), T = g.parameters.tubularSegments, R = segs, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  const pos = Array.from(P.array), nrm = Array.from(N.array), uv = Array.from(U.array), idx = Array.from(g.index.array), c = g.parameters.path;
  for (const [ring, t, flip] of [[0, 0, false], [T, 1, true]]) {
    const p = c.getPointAt(t), d = c.getTangentAt(t).multiplyScalar(flip ? 1 : -1), ci = pos.length / 3; pos.push(p.x, p.y, p.z); nrm.push(d.x, d.y, d.z); uv.push(t, 0.5);
    for (let i = 1; i <= R; i++) { const a = ring * (R + 1) + i - 1, b = a + 1; if (flip) idx.push(b, a, ci); else idx.push(a, b, ci); }
  }
  const o = new THREE.BufferGeometry(); o.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); o.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); o.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); o.setIndex(idx);
  return o;
}

// Closed loops (all the same length) joined into a skin; optional caps. Winding is checked so normals face outwards.
export function ringLoft(rings, capStart = false, capEnd = false) {
  const n = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const ctr = (r) => r.reduce((s, p) => s.add(p), V()).multiplyScalar(1 / r.length);
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) {
    const a = k * n + i, b = k * n + ((i + 1) % n), c = (k + 1) * n + ((i + 1) % n), d = (k + 1) * n + i;
    idx.push(a, b, c, a, c, d);
  }
  const k = Math.floor((rings.length - 1) / 2), A = rings[k][0], B = rings[k][1], C = rings[k + 1][1];
  if (B.clone().sub(A).cross(C.clone().sub(A)).dot(A.clone().sub(ctr(rings[k]))) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const cap = (k, k2) => {
    const c = ctr(rings[k]), away = c.clone().sub(ctr(rings[k2])), ci = pos.length / 3; pos.push(c.x, c.y, c.z);
    const a = rings[k][0], b = rings[k][1], flip = b.clone().sub(c).cross(a.clone().sub(c)).dot(away) < 0;
    for (let i = 0; i < n; i++) { const a = k * n + i, b = k * n + ((i + 1) % n); flip ? idx.push(ci, a, b) : idx.push(ci, b, a); }
  };
  if (capStart) cap(0, 1);
  if (capEnd) cap(rings.length - 1, rings.length - 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ---------- clipping an indexed geometry by a per-vertex value (< 0 is cut away) ----------
export function clipGeometry(geo, val) {
  const idx = geo.index ? geo.index.array : [...Array(geo.attributes.position.count).keys()];
  const names = Object.keys(geo.attributes), src = names.map((k) => geo.attributes[k]), arr = src.map((a) => Array.from(a.array));
  let count = geo.attributes.position.count; const cache = new Map(), out = [];
  let any = false; for (let i = 0; i < val.length; i++) if (val[i] < 0) { any = true; break; }
  if (!any) return null;
  const cut = (a, b) => {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a; if (cache.has(key)) return cache.get(key);
    const t = val[a] / (val[a] - val[b]), n = count++;
    src.forEach((A, k) => { const s = A.itemSize, d = arr[k]; for (let c = 0; c < s; c++) d.push(d[a * s + c] + (d[b * s + c] - d[a * s + c]) * t); if (names[k] === 'normal') { const o = n * 3, l = Math.hypot(d[o], d[o + 1], d[o + 2]) || 1; d[o] /= l; d[o + 1] /= l; d[o + 2] /= l; } });
    cache.set(key, n); return n;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const tri = [idx[i], idx[i + 1], idx[i + 2]], ins = tri.map((v) => val[v] < 0), nIn = ins.filter(Boolean).length;
    if (!nIn) { out.push(...tri); continue; }
    if (nIn === 3) continue;
    const poly = [];
    for (let e = 0; e < 3; e++) { const a = tri[e], b = tri[(e + 1) % 3]; if (!ins[e]) poly.push(a); if (ins[e] !== ins[(e + 1) % 3]) poly.push(cut(a, b)); }
    for (let k = 1; k < poly.length - 1; k++) out.push(poly[0], poly[k], poly[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  names.forEach((k, j) => g.setAttribute(k, new THREE.Float32BufferAttribute(arr[j], src[j].itemSize)));
  g.setIndex(out); return g;
}

// ---------- closing open surfaces ----------
// Boundary of an (indexed or not) geometry: directed edges a->b of triangles whose reverse is not in the mesh, with
// positions welded (revolve seams and primitive caps repeat vertices). Returns { tri, weld, edges: [[a, b]] } in
// original vertex indices.
// a numeric key for a position welded to 0.25 mm (parts are built within +-16 m of their origin; a string key beyond)
export const posKey = (x, y, z) => { const a = Math.round(x * 4e3) + 65536, b = Math.round(y * 4e3) + 65536, c = Math.round(z * 4e3) + 65536; return a >= 0 && a < 131072 && b >= 0 && b < 131072 && c >= 0 && c < 131072 ? a + b * 131072 + c * 17179869184 : `${a},${b},${c}`; };
function openEdges(geo) {
  const P = geo.attributes.position, n = P.count, key = new Map(), weld = new Int32Array(n);
  for (let i = 0; i < n; i++) { const k = posKey(P.getX(i), P.getY(i), P.getZ(i)); let j = key.get(k); if (j === undefined) { j = key.size; key.set(k, j); } weld[i] = j; }
  const tri = geo.index ? Array.from(geo.index.array) : [...Array(n).keys()], dir = new Map();
  for (let t = 0; t < tri.length; t += 3) for (let e = 0; e < 3; e++) { const a = tri[t + e], b = tri[t + (e + 1) % 3]; if (weld[a] !== weld[b]) dir.set(weld[a] * 1e7 + weld[b], [a, b]); }
  const edges = [];
  for (const [k, ab] of dir) { const wa = Math.floor(k / 1e7), wb = k % 1e7; if (!dir.has(wb * 1e7 + wa)) edges.push(ab); }
  return { tri, weld, edges, nw: key.size };
}
// Close every hole of a surface with a fan from the hole's centre (end caps of blades, tubes, lofts). Winding follows
// the surface, so the caps face out. Keeps the attribute set (cap vertices copy the rim's uv/uv1).
export function capHoles(geo) {
  const { tri, weld, edges, nw } = openEdges(geo); if (!edges.length) return geo;
  const par = new Int32Array(nw).map((_, i) => i), find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (const [a, b] of edges) par[find(weld[a])] = find(weld[b]);
  const loops = new Map(); for (const e of edges) { const r = find(weld[e[0]]); if (!loops.has(r)) loops.set(r, []); loops.get(r).push(e); }
  const names = Object.keys(geo.attributes).filter((k) => k !== 'normal'), arr = names.map((k) => Array.from(geo.attributes[k].array)), P = geo.attributes.position;
  let count = P.count; const out = tri.slice();
  for (const es of loops.values()) {
    const c = count++;
    names.forEach((k, j) => { const s = geo.attributes[k].itemSize, d = arr[j]; for (let q = 0; q < s; q++) { let m = 0; for (const [a] of es) m += d[a * s + q]; d.push(m / es.length); } });
    for (const [a, b] of es) out.push(b, a, c);
  }
  const g = new THREE.BufferGeometry(); names.forEach((k, j) => g.setAttribute(k, new THREE.Float32BufferAttribute(arr[j], geo.attributes[k].itemSize)));
  g.setIndex(out); g.computeVertexNormals(); return g;
}
// Give an open surface a wall thickness t: an inner copy offset along the (welded) normals, facing in, and a rim joining
// the two along every hole. Ducts, nozzles, cowls and tyres then have real inside surfaces with proper normals.
export function shell(geo, t, innerMat = null) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const { tri, weld, edges, nw } = openEdges(geo), P = geo.attributes.position, N = geo.attributes.normal, n = P.count;
  const wn = new Float32Array(nw * 3); for (let i = 0; i < n; i++) { const w = weld[i] * 3; wn[w] += N.getX(i); wn[w + 1] += N.getY(i); wn[w + 2] += N.getZ(i); }
  const names = Object.keys(geo.attributes), arr = names.map((k) => Array.from(geo.attributes[k].array));
  names.forEach((k, j) => {
    const s = geo.attributes[k].itemSize, d = arr[j];
    for (let i = 0; i < n; i++) {
      const w = weld[i] * 3, l = Math.hypot(wn[w], wn[w + 1], wn[w + 2]) || 1;
      for (let q = 0; q < s; q++) {
        let v = d[i * s + q];
        if (k === 'position') v -= (wn[w + q] / l) * t; else if (k === 'normal') v = -wn[w + q] / l;
        d.push(v);
      }
    }
  });
  const out = tri.slice(), inner = [];
  for (let i = 0; i < tri.length; i += 3) inner.push(tri[i] + n, tri[i + 2] + n, tri[i + 1] + n);
  const rim = []; for (const [a, b] of edges) rim.push(b, a, a + n, b, a + n, b + n);
  const g = new THREE.BufferGeometry(); names.forEach((k, j) => g.setAttribute(k, new THREE.Float32BufferAttribute(arr[j], geo.attributes[k].itemSize)));
  if (innerMat) { g.setIndex([...out, ...rim, ...inner]); g.addGroup(0, out.length + rim.length, 0); g.addGroup(out.length + rim.length, inner.length, 1); }
  else g.setIndex([...out, ...rim, ...inner]);
  return g;
}
// split a shelled geometry's inner face off as its own geometry (for a different inside material)
export function shellParts(geo, t) {
  const g = shell(geo, t, true), idx = g.index.array, [o, i] = g.groups;
  const a = g.clone(), b = g.clone(); a.setIndex(Array.from(idx.slice(o.start, o.start + o.count))); b.setIndex(Array.from(idx.slice(i.start, i.start + i.count)));
  a.clearGroups(); b.clearGroups(); return [a, b];
}

// ---------- propellers ----------
// Blade along +X spinning about Z (thrust towards -Z): chord peaks around 40 % radius and rounds off at the tip,
// pitch angle falls from ~50° at the root to ~12° at the tip (constant geometric pitch), flat-bottomed section.
// Returns the blade, its painted tip band and the round shank that plugs into the hub.
export function bladeGeometry(R, { chord = 1, pitch = 1.25, r0 = 0.15, band = 0.08, N = 14 } = {}) {
  const S = 14, rings = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N, r = R * (r0 + (1 - r0) * t);
    let c = R * chord * (0.07 + 0.065 * Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.15)));
    if (t > 0.78) c *= Math.sqrt(Math.max(0.05, 1 - ((t - 0.78) / 0.222) ** 2));
    const beta = Math.atan2(pitch * R, 2 * Math.PI * r), tk = (0.15 - 0.1 * t) * c;
    const d = V(0, -Math.cos(beta), Math.sin(beta)), n = V(0, -Math.sin(beta), -Math.cos(beta)), ring = [];
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2, x = -Math.cos(a) * c * 0.5 + c * 0.15, y = Math.sin(a) * tk * 0.5 * (Math.sin(a) > 0 ? 1 : 0.3);
      ring.push(V(r, 0, 0).addScaledVector(d, x).addScaledVector(n, y));
    }
    rings.push(ring);
  }
  const cut = Math.round(N * (1 - band));
  const blade = ringLoft(rings.slice(0, cut + 1), true, false), tip = ringLoft(rings.slice(cut), false, true);
  const shank = new THREE.CylinderGeometry(R * 0.028, R * 0.034, R * r0 * 1.05, 10); shank.rotateZ(Math.PI / 2); shank.translate(R * r0 * 0.5, 0, 0);
  // one mesh per blade: the colour comes from a two-texel map (u = 0.25 blade, 0.75 painted tip), see PM.blade()
  const paint = (g, u) => { norm(g); const a = g.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u, 0.5); return g; };
  return mergeGeometries([paint(blade, 0.25), paint(tip, 0.75), paint(shank, 0.25)]);
}

// Rotor blade (same frame as the plain box: span +X from the hub, thickness Y, chord Z): symmetric section, swept tip.
export function rotorBlade(R, chord, { from = 0, to = 1, grow = 0 } = {}) {
  // A real rotor blade: NACA 0012 section (leading edge forward = -Z, 25 % chord on the feathering axis), washout twist
  // of 8 degrees root to tip, a round root cuff blending into the airfoil, and a tapered, swept tip. from/to cut a span
  // range (the painted tip cap), grow puffs it out a little so it sits over the blade.
  const rings = [], N = 28, S = 28, naca = (x) => 5 * 0.12 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  for (let k = 0; k <= N; k++) {
    const t = from + (to - from) * (k / N), x = R * (0.05 + 0.945 * t);
    const tipT = Math.max(0, (t - 0.93) / 0.07), c = chord * (1 - 0.55 * tipT ** 1.3), sweep = chord * 0.35 * tipT ** 1.6;
    const cuff = 1 - THREE.MathUtils.smoothstep(t, 0.06, 0.16), tw = THREE.MathUtils.degToRad(8) * (0.75 - t);
    const ct = Math.cos(tw), st = Math.sin(tw), ring = [];
    for (let i = 0; i < S; i++) {
      const sA = i / S, xc = 0.5 * (1 - Math.cos(sA * Math.PI * 2)), up = sA < 0.5 ? 1 : -1; // 0 = leading edge, 1 = trailing edge
      let y = up * naca(Math.max(1e-4, xc)) * c * (1 + grow), z = (xc - 0.25) * c * (1 + grow) + sweep;
      const a = (i / S) * Math.PI * 2, rc = chord * 0.17; // root cuff: a round section
      y = y * (1 - cuff) + Math.sin(a) * rc * cuff; z = z * (1 - cuff) + -Math.cos(a) * rc * cuff;
      ring.push(V(x, y * ct - z * st, y * st + z * ct));
    }
    rings.push(ring);
  }
  return ringLoft(rings, true, true);
}

// ---------- engines ----------
// Piston / radial / turboprop cowling detail. g: the engine group; profile radius r, length len (cowl from z=0 to len).
export function propEngineDetail(g, { len, radius: r, radial, color, propR }) {
  const paint = PM.skin(color), dark = M.darkMetal(), steel = M.steel(), soot = PM.exhaust(), intake = M.intake();
  const b = new Bag(), nb = new Bag();
  const turbo = !radial && len > 2;
  if (radial) {
    // An open NACA cowl ring instead of the plain part's closed blob (whose cylinders sat behind its front disc, out of
    // sight): a rounded lip curling into the cowl, so the cylinder bank shows through the opening. Behind the bank a
    // dark baffle and the cowl's back closes it off.
    for (const m of g.children.slice()) if ((m.geometry?.type === 'CylinderGeometry' && m.material === M.steel()) || m.geometry?.type === 'CircleGeometry') g.remove(m);
    const cowl = g.children.find((m) => m.isMesh && m.material === paint);
    if (cowl) {
      const ri = r * 0.7, lip = smoothPts([[0.5, ri * 0.97], [0.16, ri], [0.03, ri * 1.02], [-0.03, (ri + r) / 2], [0.03, r * 0.95], [0.16, r * 0.995], [len * 0.5, r * 0.98], [len, r * 0.7]], 40);
      cowl.geometry = revolve(lip, { segs: 48 }); cowl.geometry = capHoles(cowl.geometry); // the back end (under the gills) and the inside end behind the engine
    }
    const baffle = new THREE.CircleGeometry(r * 0.69, 32); baffle.rotateY(Math.PI); baffle.translate(0, 0, 0.42); b.add(baffle, PM.exhaust());
    // the engine: crankcase drum, reduction-gear case in front (behind the spinner), nine finned cylinders with their
    // heads, rocker boxes and pushrods, the ignition harness ring and the intake pipes behind
    const crank = new THREE.CylinderGeometry(r * 0.24, r * 0.24, 0.3, 18); crank.rotateX(Math.PI / 2); crank.translate(0, 0, 0.16); b.add(crank, PM.metal('titanium'));
    const red = new THREE.CylinderGeometry(r * 0.3, r * 0.22, 0.14, 24); red.rotateX(Math.PI / 2); red.translate(0, 0, 0.0); b.add(red, PM.metal('brushed'));
    const nC = 9, cz = 0.17;
    for (let i = 0; i < nC; i++) {
      const a = (i / nC) * Math.PI * 2 + Math.PI / 2, rot = [0, 0, a - Math.PI / 2], c = Math.cos(a), s = Math.sin(a), at = (k) => [c * r * k, s * r * k, cz];
      const cyl = new THREE.CylinderGeometry(r * 0.085, r * 0.095, r * 0.3, 12); cyl.applyMatrix4(mx(at(0.36), rot)); b.add(cyl, dark);
      for (let f = 0; f < 7; f++) { const fin = new THREE.CylinderGeometry(r * 0.12, r * 0.12, r * 0.012, 14); fin.applyMatrix4(mx(at(0.29 + f * 0.03), rot)); b.add(fin, dark); }
      const head = new THREE.CylinderGeometry(r * 0.12, r * 0.14, r * 0.14, 12); head.applyMatrix4(mx(at(0.55), rot)); b.add(head, PM.metal('brushed'));
      for (let f = 0; f < 4; f++) { const hf = new THREE.BoxGeometry(r * 0.3, r * 0.012, r * 0.2); hf.applyMatrix4(mx(at(0.5 + f * 0.035), rot)); nb.add(hf, PM.metal('brushed')); }
      for (const dz of [-1, 1]) { const rb = new THREE.BoxGeometry(r * 0.07, r * 0.07, r * 0.1); rb.applyMatrix4(mx([c * r * 0.6, s * r * 0.6, cz + dz * r * 0.08], rot)); b.add(rb, steel); }
      for (const dz of [-1, 1]) nb.add(bar(V(c * r * 0.58, s * r * 0.58, cz - r * 0.1 + dz * 0.012), V(c * r * 0.25, s * r * 0.25, cz - r * 0.14 + dz * 0.012), r * 0.025, r * 0.025, true, 5), steel);
      nb.add(pipe([V(c * r * 0.3, s * r * 0.3, cz + r * 0.12), V(c * r * 0.32, s * r * 0.32, cz + r * 0.3), V(c * r * 0.2, s * r * 0.2, cz + r * 0.42)], r * 0.035, 6, 10), steel); // intake pipe
    }
    const harness = new THREE.TorusGeometry(r * 0.31, r * 0.02, 6, 36); harness.translate(0, 0, cz - r * 0.15); b.add(harness, PM.metal('anodised'));
    for (let i = 0; i < nC; i++) { const a = (i / nC) * Math.PI * 2 + Math.PI / 2; nb.add(tube([V(Math.cos(a) * r * 0.31, Math.sin(a) * r * 0.31, cz - r * 0.15), V(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, cz - r * 0.12), V(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, cz - r * 0.06)], r * 0.01, 4, 8), M.black()); }
    // cowl flaps (gills) round the cowl's trailing edge, slightly open
    const nG = 18, rr = r * 0.69;
    for (let i = 0; i < nG; i++) {
      const a = (i / nG) * Math.PI * 2, gill = new THREE.BoxGeometry((2 * Math.PI * rr / nG) * 0.94, 0.01, 0.13);
      gill.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.1)); gill.translate(0, -0.006, 0.06);
      gill.applyMatrix4(mx([Math.sin(a) * rr, Math.cos(a) * rr, len - 0.04], [0, 0, -a]));
      b.add(gill, paint);
    }
    // exhaust collector stubs low on each side, with sooty ends
    for (const sx of [-1, 1]) {
      const ex = pipe([V(sx * r * 0.55, -r * 0.45, len - 0.25), V(sx * r * 0.68, -r * 0.55, len + 0.05), V(sx * r * 0.74, -r * 0.6, len + 0.3)], 0.06, 8);
      b.add(ex, dark);
      const mouth = new THREE.CircleGeometry(0.055, 10); mouth.applyMatrix4(mx([sx * r * 0.74, -r * 0.6, len + 0.301])); b.add(mouth, soot);
    }
  } else {
    // remove the plain exhaust stubs: replaced by proper stacks below
    for (const m of g.children.slice()) if (m.geometry?.type === 'CylinderGeometry' && m.material === M.darkMetal()) g.remove(m);
    if (turbo) {
      // turboprop: big curved exhaust stacks either side, chin intake scoop under the spinner
      for (const sx of [-1, 1]) {
        const p0 = V(sx * r * 0.55, r * 0.05, len * 0.36), p1 = V(sx * r * 1.0, r * 0.08, len * 0.44), p2 = V(sx * r * 1.12, r * 0.06, len * 0.56);
        b.add(pipe([p0, p1, p2], r * 0.2, 12, 14), dark);
        const lip = new THREE.TorusGeometry(r * 0.2, r * 0.025, 6, 16); lip.applyMatrix4(mx(p2.toArray(), [0, sx * 0.5, 0])); b.add(lip, steel);
        const m = new THREE.CircleGeometry(r * 0.19, 14); m.applyMatrix4(mx(p2.clone().add(V(sx * 0.005, 0, 0.01)).toArray(), [0, sx * 0.5, 0])); b.add(m, soot);
      }
      const scoop = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2); scoop.applyMatrix4(mx([0, -r * 0.72, len * 0.22], [Math.PI, 0, 0], [r * 0.42, r * 0.3, len * 0.22])); b.add(shell(scoop, r * 0.02), paint);
      const mouth = new THREE.CircleGeometry(1, 16, Math.PI, Math.PI); mouth.applyMatrix4(mx([0, -r * 0.74, 0.012], [0, Math.PI, 0], [r * 0.34, r * 0.22, 1])); b.add(mouth, intake);
    } else {
      // flat-four: two real cooling inlets cut into the cowl face beside the spinner, each a duct back to the finned
      // cylinder heads behind a baffle; an oil-cooler scoop under the chin; two short stacks each side under the cowl
      pistonCowl(g, b, nb, { len, r, paint });
      for (const sx of [-1, 1]) {
        for (const dz of [0, 0.11]) {
          const p0 = V(sx * r * 0.42, -r * 0.78, len * 0.68 + dz), p1 = V(sx * r * 0.46, -r * 1.02, len * 0.76 + dz);
          b.add(bar(p0, p1, 0.05, 0.05, true, 8), dark);
          const m = new THREE.CircleGeometry(0.02, 8); m.applyMatrix4(new THREE.Matrix4().compose(p1.clone().addScaledVector(p1.clone().sub(p0).normalize(), 0.002), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), p1.clone().sub(p0).normalize()), V(1, 1, 1))); b.add(m, soot);
        }
        // oil cooler / cowl flap lip at the bottom rear
      }
      const flap = new THREE.BoxGeometry(r * 0.7, 0.012, 0.16); flap.applyMatrix4(mx([0, -r * 0.88, len - 0.04], [0.35, 0, 0])); b.add(flap, paint);
    }
    // louvres: little raked slots high on each side of the cowl (near only)
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) {
      const z = len * (turbo ? 0.62 : 0.5) + i * 0.04, a = sx * 1.0, rr = r * (1 - 0.08 * Math.max(0, z - len * 0.45) / (len * 0.55)) - 0.003; // on the cowl, which tapers aft of 45 % (they stood off it)
      const l = new THREE.BoxGeometry(r * 0.16, 0.01, 0.014); l.applyMatrix4(mx([Math.sin(a) * rr, Math.cos(a) * rr, z], [0, 0, -a]));
      nb.add(l, dark);
    }
  }
  // spinner backplate
  const bp = new THREE.CylinderGeometry(r * 0.37, r * 0.37, 0.02, 24); bp.rotateX(Math.PI / 2); bp.translate(0, 0, -0.005); b.add(bp, PM.metal('brushed'));
  b.to(g); nb.to(g, true);
}

// The flat-four cowl: the plain part's front is a closed disc (a checkered blob). Rebuilt finer, with two elliptical
// inlets cut exactly into the face (clipGeometry), each lined with a duct to a finned cylinder-head face, a rounded lip
// round each opening, and an oil-cooler scoop under the chin with its radiator grille.
function pistonCowl(g, b, nb, { len, r, paint }) {
  const cowl = g.children.find((m) => m.isMesh && m.material === paint); if (!cowl) return;
  const prof = [[0, 0], [0, 0.18 * r], [0, 0.32 * r], [0, 0.44 * r], [0.004, 0.55 * r], [0.014, 0.63 * r], [0.03, 0.71 * r], [0.055, 0.79 * r], [0.09, 0.85 * r], [0.13, 0.9 * r], [0.22, 0.95 * r], [len * 0.45, r], [len, 0.92 * r], [len + 0.01, 0]]; // (behind the lip: the plain cowl's lines, so the louvres sit on it)
  const zAt = (rho) => { for (let i = 1; i < 11; i++) if (prof[i][1] >= rho) { const a = prof[i - 1], c = prof[i]; return a[0] + (c[0] - a[0]) * ((rho - a[1]) / (c[1] - a[1] || 1)); } return 0.22; };
  const IN = [[0.6 * r, 0.1 * r], [-0.6 * r, 0.1 * r]], ax = 0.19 * r, ay = 0.145 * r;
  const geo = revolve(prof, { segs: 72 }), P = geo.attributes.position, val = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i); val[i] = z > 0.2 ? 1 : Math.min(...IN.map(([cx, cy]) => (Math.hypot((x - cx) / ax, (y - cy) / ay) - 1) * ay)); }
  cowl.geometry = clipGeometry(geo, val) || geo; cowl.geometry.computeVertexNormals(); cowl.userData.openOk = 'cooling inlets: each lined by its duct';
  const ductM = PM.duct(0x2a2c30), depth = Math.min(0.32, len * 0.3);
  for (const [cx, cy] of IN) {
    const ring = (k, shrink, dz) => { const o = []; for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2, x = cx + Math.cos(a) * ax * shrink, y = cy + Math.sin(a) * ay * shrink; o.push(V(x, y, k === 0 ? zAt(Math.hypot(x, y)) - 0.004 : dz)); } return o; };
    const rings = [ring(0, 1.0), ring(1, 0.98, depth * 0.45), ring(2, 0.9, depth)], duct = ringLoft(rings);
    b.add(duct, ductM);
    b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ring(0, 1.04).map((p) => p.add(V(0, 0, -0.006))), true), 56, Math.max(0.008, r * 0.022), 6, true), PM.metal('polished')); // rolled lip, bare metal
    const face = new THREE.CircleGeometry(1, 24); face.applyMatrix4(mx([cx, cy, depth - 0.005], [0, Math.PI, 0], [ax * 0.9, ay * 0.9, 1])); b.add(face, M.darkMetal());
    for (let k = -2; k <= 2; k++) nb.add(bar(V(cx - ax * 0.8 * Math.sqrt(1 - (k / 2.6) ** 2), cy + k * ay * 0.32, depth - 0.02), V(cx + ax * 0.8 * Math.sqrt(1 - (k / 2.6) ** 2), cy + k * ay * 0.32, depth - 0.02), r * 0.02, r * 0.012), PM.metal('brushed')); // cylinder-head fins
  }
  // oil-cooler scoop: a rounded box under the chin, open at the front, fairing back into the cowl
  const rings = [];
  for (const [z, w, h, dy] of [[0.16, 0.2, 0.09, 0], [0.22, 0.21, 0.095, 0], [0.4, 0.19, 0.08, 0.01], [0.62, 0.12, 0.03, 0.03]]) {
    const ring = [], yc = -0.905 * r - h * r + dy * r;
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); ring.push(V(Math.sign(c) * Math.abs(c) ** 0.5 * w * r, yc + Math.sign(s) * Math.abs(s) ** 0.5 * h * r, z * len / 1.1)); }
    rings.push(ring);
  }
  b.add(shell(ringLoft(rings, false, true), r * 0.015), paint);
  const gr = new THREE.PlaneGeometry(0.38 * r, 0.16 * r); gr.rotateY(Math.PI); gr.translate(0, -1.02 * r, 0.21 * len / 1.1); b.add(gr, M.darkMetal());
  for (let k = -4; k <= 4; k++) nb.add(bar(V(k * 0.04 * r, -1.1 * r, 0.205 * len / 1.1), V(k * 0.04 * r, -0.94 * r, 0.205 * len / 1.1), r * 0.008, r * 0.006), M.steel());
}

// Jet intake lip, twisted compressor/fan blades, exhaust plug or afterburner petals and turbine face.
export function jetEngineDetail(g, { len, radius: r, fan, ab }) {
  const lipMat = PM.metal('polished'), dark = M.darkMetal(), steel = M.steel(), hot = PM.metal('hot');
  const b = new Bag();
  // inside surfaces: the cowl gets a wall thickness (a rim where it ends), the duct inside it an acoustic-liner grey
  // instead of a black void, the nozzle a thick wall
  const [outerM, ductM, , nozM, coreM] = g.children; // skin, duct, fan group, nozzle, core disc
  if (outerM?.isMesh) outerM.geometry = shell(outerM.geometry, r * 0.04);
  if (ductM?.isMesh) ductM.material = PM.duct(fan ? 0x8e9399 : 0x4e5258);
  if (fan) { g.remove(nozM); g.remove(coreM); } else if (nozM?.isMesh && !ab) nozM.geometry = shell(nozM.geometry, r * 0.05);
  const lipR = fan ? r * 0.94 : r * 0.88;
  const lip = new THREE.TorusGeometry(fan ? r * 0.93 : lipR, r * (fan ? 0.075 : 0.06), 10, 48); lip.translate(0, 0, fan ? 0.03 : 0.02); b.add(lip, lipMat);
  // compressor / fan face: replace the box blades with twisted blades, keep the group (aircraft.js spins userData.fan)
  const fanG = g.userData.fan;
  if (fanG) {
    for (const c of fanG.children.slice()) if (!c.isMesh) fanG.remove(c);
    const nb = fan ? 24 : 18, blades = [], rh = r * 0.28, rt = r * 0.86;
    for (let i = 0; i < nb; i++) {
      const rings = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, rr = rh + (rt - rh) * t, tw = (fan ? 1.05 : 0.85) - 0.45 * t, c = r * (fan ? 0.22 : 0.16) * (1 + 0.25 * t);
        const d = V(Math.cos(tw), 0, Math.sin(tw)), ring = [];
        for (const [x, y] of [[-0.5, 0], [0, 0.012], [0.5, 0], [0, -0.012]]) ring.push(V(0, rr, 0).addScaledVector(d, x * c).add(V(0, 0, y * 0).addScaledVector(V(-Math.sin(tw), 0, Math.cos(tw)), y * r)));
        rings.push(ring);
      }
      const bg = ringLoft(rings, true, true); bg.rotateZ((i / nb) * Math.PI * 2); bg.translate(0, 0, len * 0.12); blades.push(norm(bg));
    }
    const bm = new THREE.Mesh(mergeGeometries(blades), fan ? PM.metal('titanium') : steel); fanG.add(bm);
    if (fan) { // white swirl on the spinner (so you can see it turning)
      const sw = []; for (let k = 0; k <= 12; k++) { const t = k / 12, a = t * Math.PI * 1.6, rr = r * 0.3 * (1 - t) * 1.03; sw.push(V(Math.sin(a) * rr, Math.cos(a) * rr, len * 0.05 + r * 0.3 - t * r * 0.6)); } // on the hub cone
      const swirl = new THREE.Mesh(pipe(sw, r * 0.02, 5, 24), M.paint(0xffffff, 'matte'));
      swirl.userData.near = true; fanG.add(swirl);
    }
  }
  // what holds it all together: a drum from the fan hub back through the engine (the blade roots sit in it; the fan face
  // and the parts behind it hung free in the duct), radial struts from it to the duct wall. Duct wall radius as built
  // by parts.js jetEngine (the inner duct is the outer profile x 0.88).
  const prof = fan ? [[0, r * 0.92], [0.05, r], [len * 0.35, r * 1.02], [len * 0.8, r * 0.85], [len, r * 0.62]] : [[0, r * 0.85], [0.1, r], [len * 0.6, r], [len, r * 0.78]];
  const ductR = (z) => { for (let i = 1; i < prof.length; i++) if (prof[i][0] >= z) { const [z0, r0] = prof[i - 1], [z1, r1] = prof[i]; return 0.88 * (r0 + (r1 - r0) * ((z - z0) / (z1 - z0 || 1))); } return 0.88 * prof.at(-1)[1]; };
  const zHub = len * 0.05 + r * 0.3, zEnd = fan ? len * 0.48 : len + 0.06, rd = r * 0.29;
  { const d = new THREE.CylinderGeometry(rd, rd, zEnd - zHub + 0.02, 20, 1); d.rotateX(Math.PI / 2); d.translate(0, 0, (zHub - 0.02 + zEnd) / 2); b.add(d, steel); }
  if (fan) { const c = new THREE.CylinderGeometry(r * 0.505, rd, len * 0.04, 24); c.rotateX(Math.PI / 2); c.translate(0, 0, len * 0.435); b.add(c, steel); } // the core's front closes onto the drum
  const spokes = (n, z, rOut, depth, mat, a0 = 0) => { for (let i = 0; i < n; i++) { const a = a0 + (i / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); b.add(bar(V(c * rd * 0.9, sn * rd * 0.9, z), V(c * rOut, sn * rOut, z), 0.03 * r / 0.55, depth), mat); } };
  if (!fan) spokes(4, len * 0.12 + r * 0.32, ductR(len * 0.12 + r * 0.32) + 0.012, r * 0.12, dark, Math.PI / 4); // compressor-case struts behind the blades
  const glow = (rr, z) => { // the turbine face / flame holder glows with the flame (shares the flame core's material)
    const fc = g.userData.flameCore; if (!fc) return;
    const d = new THREE.Mesh(new THREE.CircleGeometry(rr, 24), fc.material); d.position.z = z; d.userData.cosmetic = true; d.castShadow = false; g.add(d);
  };
  if (fan) {
    // high-bypass exhaust: the bypass duct ends at the cowl; inside it the core cowl (bare metal) with its own nozzle, the
    // turbine face deep inside and the exhaust plug (the plain part's black disc read as a hole straight through)
    const core = revolveZ(smoothPts([[len * 0.45, r * 0.5], [len * 0.75, r * 0.53], [len, r * 0.5], [len + r * 0.42, r * 0.42]], 14), 32, 1);
    b.add(shell(core, r * 0.03), PM.metal('brushed'));
    const coreIn = revolveZ([[len + r * 0.1, r * 0.4], [len + r * 0.41, r * 0.4]], 32, 1); b.add(coreIn, PM.duct(0x3a3c40));
    const face = new THREE.CircleGeometry(r * 0.41, 28); face.translate(0, 0, len + r * 0.1); b.add(face, PM.exhaust());
    const plug = new THREE.LatheGeometry([[0.0, 0], [0.0, r * 0.3], [0.3 * r, r * 0.29], [0.75 * r, r * 0.18], [1.15 * r, 0.02], [1.16 * r, 0]].map(([z, rr]) => new THREE.Vector2(rr, z)), 24);
    plug.rotateX(Math.PI / 2); plug.translate(0, 0, len + r * 0.1); b.add(plug, dark);
    // bypass exit: a ring of outlet guide vanes deep in the duct, and the duct lining in a darker grey round the core
    { const z = len * 0.5, r0 = r * 0.49, r1 = ductR(z) + 0.012; // (from the core cowl out to the duct wall: they floated between the two)
      for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2, v = new THREE.BoxGeometry(0.012, r1 - r0, r * 0.18); v.rotateY(0.25); v.translate(0, (r0 + r1) / 2, z); v.rotateZ(a); b.add(v, steel); } }
    glow(r * 0.4, len + r * 0.12);
  } else if (ab) {
    // afterburner: ring of overlapping petals (heat-tinted, seen from inside too), a sleeve, flame-holder rings and a
    // dark turbine face inside that glows when it lights
    for (const m of g.children.slice()) if (m.material === M.darkMetal() && m.geometry?.attributes?.position?.count < 400) g.remove(m); // old plain nozzle
    const nP = 16, petalM = PM.duct(0x5a4a3e, 'hot');
    for (let i = 0; i < nP; i++) {
      const a0 = (i / nP) * Math.PI * 2, da = (Math.PI * 2 / nP) * 0.62;
      const petal = new THREE.CylinderGeometry(r * 0.79, r * 0.6, r * 0.62, 3, 1, true, a0 - da, da * 2);
      petal.rotateX(-Math.PI / 2); petal.translate(0, 0, len + r * 0.3); b.add(petal, petalM);
    }
    const inner = new THREE.CylinderGeometry(r * 0.76, r * 0.58, r * 0.6, 24, 1, true); inner.rotateX(-Math.PI / 2); inner.translate(0, 0, len + r * 0.3); b.add(inner, PM.duct(0x2b2d31));
    for (const [rr, z] of [[0.45, -0.05], [0.25, -0.12]]) { const t = new THREE.TorusGeometry(r * rr, 0.02, 6, 24); t.translate(0, 0, len + z); b.add(t, steel); }
    spokes(6, len - 0.085, ductR(len - 0.085) + 0.012, 0.1, steel); // radial flame-holder gutters carry the rings
    glow(r * 0.55, len + 0.06);
  } else {
    glow(r * 0.5, len + 0.06);
    for (const [rr, z] of [[0.4, 0.02]]) { const t = new THREE.TorusGeometry(r * rr, 0.015, 6, 20); t.translate(0, 0, len + z); b.add(t, steel); }
    spokes(4, len + 0.02, r * 0.77, 0.04, steel, Math.PI / 4); // turbine exit struts out to the nozzle wall carry the ring
    const cone = new THREE.ConeGeometry(r * 0.25, r * 0.5, 16); cone.rotateX(Math.PI / 2); cone.translate(0, 0, len + 0.02); b.add(cone, dark);
  }
  b.to(g);
}

export function rocketDetail(g, { len, radius: r }) {
  const b = new Bag();
  for (const z of [0.15, 0.5, 0.85]) { const t = new THREE.TorusGeometry(r * 1.004, 0.012, 4, 28); t.translate(0, 0, len * z + r); b.add(t, M.darkMetal()); }
  // nozzle: the plain part's single-sided cone vanished when you looked into it (its inside faces were culled). A bell
  // with a wall: throat, bell contour out to the exit lip, heat-tinted inside, cooling-tube bands outside, a sooty throat
  // and a glow deep in the throat that lights with the flame.
  for (const m of g.children.slice()) if (m.isMesh && m.material === M.darkMetal() && m.geometry.type === 'BufferGeometry' && m.geometry.attributes.position.count < 60) g.remove(m);
  const bp = smoothPts([[len - 0.02 * r, r * 0.36], [len + 0.08 * r, r * 0.27], [len + 0.22 * r, r * 0.34], [len + 0.55 * r, r * 0.6], [len + 0.92 * r, r * 0.8]], 18), bell = revolveZ(bp, 36, 1);
  b.add(shell(bell, r * 0.035), PM.metal('hot'));
  const bellR = (z) => { for (let i = 1; i < bp.length; i++) if (bp[i][0] >= z) { const [z0, r0] = bp[i - 1], [z1, r1] = bp[i]; return r0 + (r1 - r0) * ((z - z0) / (z1 - z0 || 1)); } return bp.at(-1)[1]; };
  for (const t of [0.35, 0.62, 0.86]) { const z = len + (0.08 + 0.84 * t) * r, band = new THREE.TorusGeometry(bellR(z) + r * 0.009, r * 0.018, 4, 36); band.translate(0, 0, z); b.add(band, M.darkMetal()); } // on the bell (they stood off it)
  const throat = new THREE.CircleGeometry(r * 0.3, 20); throat.translate(0, 0, len + 0.06 * r); b.add(throat, PM.exhaust());
  b.to(g);
  const fc = g.userData.flameCore;
  if (fc) { const d = new THREE.Mesh(new THREE.CircleGeometry(r * 0.3, 20), fc.material); d.position.z = len + 0.09 * r; d.userData.cosmetic = true; d.castShadow = false; g.add(d); }
}

// ---------- landing gear ----------
// Wheel: tyre with sidewall bead, two-piece rim with hub boss, bolts and (braked wheels) a brake disc.
function wheelDetailed(r, w, brake) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag();
  const tire = new THREE.TorusGeometry(r * 0.72, r * 0.3, 14, 32); tire.rotateY(Math.PI / 2); tire.scale(w / (r * 0.6), 1, 1);
  b.add(tire, PM.tyre());
  for (const sx of [-1, 1]) {
    const bead = new THREE.TorusGeometry(r * 0.47, r * 0.035, 6, 28); bead.rotateY(Math.PI / 2); bead.translate(sx * w * 0.36, 0, 0); b.add(bead, M.aluminum());
    const rim = new THREE.CylinderGeometry(r * 0.46, r * 0.4, w * 0.12, 24); rim.rotateZ(sx * Math.PI / 2); rim.translate(sx * w * 0.33, 0, 0); b.add(rim, M.aluminum());
    const boss = new THREE.CylinderGeometry(r * 0.16, r * 0.2, w * 0.1, 14); boss.rotateZ(sx * Math.PI / 2); boss.translate(sx * w * 0.42, 0, 0); b.add(boss, M.aluminum());
    const cap = new THREE.CylinderGeometry(r * 0.07, r * 0.07, w * 0.06, 10); cap.rotateZ(Math.PI / 2); cap.translate(sx * w * 0.48, 0, 0); b.add(cap, M.steel());
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, bolt = new THREE.CylinderGeometry(r * 0.025, r * 0.025, w * 0.05, 6); bolt.rotateZ(Math.PI / 2); bolt.translate(sx * w * 0.42, Math.cos(a) * r * 0.27, Math.sin(a) * r * 0.27); nb.add(bolt, M.steel()); }
  }
  const core = new THREE.CylinderGeometry(r * 0.42, r * 0.42, w * 0.55, 20); core.rotateZ(Math.PI / 2); b.add(core, M.darkMetal());
  if (brake) { const disc = new THREE.CylinderGeometry(r * 0.36, r * 0.36, 0.02, 24); disc.rotateZ(Math.PI / 2); disc.translate(-w * 0.2, 0, 0); nb.add(disc, M.steel()); }
  b.to(g); nb.to(g, true);
  return g;
}

// Wheel spat (fixed gear): a teardrop shell round the upper two thirds of the wheel with a flat floor and a slot the
// tyre pokes through, a dark liner, a lip round the slot and a collar where each spring leg enters the shell.
// Frame: origin at the axle, forward -Z; the legs come down beside the tyre.
function wheelSpat(bag, { r, ww, paint, legs }) {
  const R0 = r * 1.02, y0 = r * 0.1, Hs = r * 1.05, W = ww / 2 + 0.045 + r * 0.09, cut = -r * 0.72;
  // side profile: blunt nose just ahead of the tyre, long tapering tail
  const fz = new THREE.SplineCurve([[-1.5, 0], [-1.35, 0.55], [-1.05, 0.88], [-0.6, 0.99], [0, 1], [0.7, 0.96], [1.3, 0.82], [1.9, 0.55], [2.4, 0.25], [2.75, 0]].map(([z, f]) => new THREE.Vector2(z * r, f))).getPoints(30);
  // section: ellipse on top, fuller (superellipse) below so the floor is wide enough for the tyre slot
  const sec = (f, ph) => { const c = Math.cos(ph), sn = Math.sin(ph), e = c < 0 ? 2 / 3 : 1; return V(W * f * Math.sign(sn) * Math.abs(sn) ** e, y0 + Hs * f * Math.sign(c) * Math.abs(c) ** e, 0); };
  const N = fz.length - 1, MS = 20, rings = [], outline = [];
  for (let k = 0; k <= N; k++) {
    const z = fz[k].x, f = Math.max(0.03, fz[k].y), q = f > 1e-4 ? (y0 - cut) / (Hs * f) : 2, al = q >= 1 ? Math.PI : Math.acos(-(q ** 1.5)), ring = [];
    for (let i = 0; i <= MS; i++) ring.push(sec(f, -al + (2 * al * i) / MS).setZ(z));
    rings.push(ring); outline.push([al >= Math.PI ? 0 : sec(f, al).x, z]);
  }
  const grid = (rs, flip) => { // rows = stations, cols = arc points (open strip)
    const pos = [], idx = [], C = rs[0].length;
    for (const r of rs) for (const p of r) pos.push(p.x, p.y, p.z);
    for (let k = 0; k < rs.length - 1; k++) for (let i = 0; i < C - 1; i++) { const a = k * C + i, b = a + 1, c = a + C + 1, d = a + C; flip ? idx.push(a, c, b, a, d, c) : idx.push(a, b, c, a, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  };
  // winding: the arc runs -x (left) over the top to +x with stations nose->tail: check one normal points up
  const shell = grid(rings, false), nY = shell.attributes.normal.getY(Math.floor(N / 2) * (MS + 1) + MS / 2);
  bag.add(nY > 0 ? shell : grid(rings, true), paint);
  const liner = rings.map((r) => r.map((p) => V(p.x * 0.975, y0 + (p.y - y0) * 0.975, p.z * 0.99)));
  bag.add(grid(liner, false), M.intake());
  // floor with the tyre slot (a shape in the x/z plane at y = cut)
  const sh = new THREE.Shape();
  outline.forEach(([x, z], i) => (i ? sh.lineTo(x, z) : sh.moveTo(x, z)));
  for (let k = N; k >= 0; k--) sh.lineTo(-outline[k][0], outline[k][1]);
  const ws = ww / 2 + 0.015, ls = Math.sqrt(Math.max(0.01, R0 * R0 - cut * cut)) + 0.03, rr = Math.min(ws, ls) * 0.9, hole = new THREE.Path(), slot = [];
  for (let i = 0; i <= 24; i++) { // rounded rectangle, counter-clockwise
    const q = Math.floor(i / 6.0001), t = (i - q * 6) / 6 * Math.PI / 2 + q * Math.PI / 2, cx = (q === 0 || q === 3 ? 1 : -1) * (ws - rr), cz = (q < 2 ? 1 : -1) * (ls - rr);
    slot.push([cx + Math.cos(t) * rr, cz + Math.sin(t) * rr]);
  }
  slot.forEach(([x, z], i) => (i ? hole.lineTo(x, z) : hole.moveTo(x, z))); sh.holes.push(hole);
  const floor = new THREE.ShapeGeometry(sh, 4); floor.rotateX(Math.PI / 2); floor.translate(0, cut, 0); // shape y -> world z, normal now faces -y
  bag.add(floor, paint);
  const fl = floor.clone(); fl.translate(0, 0.004, 0); bag.add(fl, M.intake());
  bag.add(tube(slot.map(([x, z]) => V(x, cut - 0.002, z)).concat([V(slot[0][0], cut - 0.002, slot[0][1])]), 0.009, 5, 48), M.rubber());
  // collars where the spring legs pass into the top of the shell (legs: [{ a, dir }] in this frame)
  for (const { a, dir } of legs) {
    const sAt = Math.abs(a.x) < W ? y0 + Hs * Math.sqrt(1 - (a.x / W) ** 2) * 0.97 : y0, t = (sAt - a.y) / (dir.y || 1);
    const hit = a.clone().addScaledVector(dir, t);
    bag.add(fairedBar(hit.clone().addScaledVector(dir, -0.03), hit.clone().addScaledVector(dir, 0.07), 0.07, 0.17), paint);
  }
}

// Streamlined strut from a to b: a teardrop section (round nose, tapering tail) w thick and c long, its long axis
// along fwd (projected square to the strut), so the thin side faces the airflow. Capped both ends.
const _sec = (() => { const n = 14, out = []; for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2, c = Math.cos(t); out.push([0.5 * Math.sin(t) * (c < 0 ? 1 + c * 0.45 : 1), c > 0 ? 0.42 * c : 0.58 * c]); } return out; })();
export function fairedBar(a, b, w, c, fwd = V(0, 0, -1), stations = [[0, 1], [1, 1]]) {
  const d = b.clone().sub(a), y = d.clone(); if (y.lengthSq() < 1e-10) y.set(0, 1e-5, 0); y.normalize();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y)); if (z.lengthSq() < 1e-6) z.set(0, 0, -1).addScaledVector(y, y.z); if (z.lengthSq() < 1e-6) z.set(1, 0, 0); z.normalize();
  const x = y.clone().cross(z).normalize();
  const ring = (p, k) => _sec.map(([sx, sz]) => p.clone().addScaledVector(x, sx * w * k).addScaledVector(z, sz * c * k));
  return ringLoft(stations.map(([t, k]) => ring(a.clone().addScaledVector(d, t), k)), true, true);
}
// Where a strut meets the skin: the strut flares out into a fairing that runs on into the skin (top: the skin point,
// dir: up the strut, n: the skin's outward normal), so the joint reads as one piece wherever the skin curves away.
export function strutFlare(top, dir, n, w, c, fwd) {
  const L = w * 2.5 + 0.05, e = 0.03 + c * 0.7 * (1 - Math.abs(n.dot(dir)));
  return fairedBar(top.clone().addScaledVector(dir, -L), top.clone().addScaledVector(dir, e), w, c, fwd, [[0, 1], [0.45, 1.08], [0.75, 1.35], [L / (L + e), 1.75], [1, 2]]);
}

// ---------- landing gear ----------
// A gear leg is built round its wheel frame: origin at the axle, +y up, -z forward, x along the axle. In the part
// (strut) frame that frame sits at y = -len, turned by route.q: the assembly pass (gearRoute.js) turns it so the wheel
// stands upright and rolls straight ahead whatever angle the part was placed at, and routes the legs from the wheel up
// to the skin they really meet (route.legs), plus braces to structure (route.braces). Without a route (part pictures)
// the legs run to the part origin as before.
const oleoK = 1.7; // chord / thickness of a faired oleo cylinder
function gearDims({ len, r, w, bogie, tail }) {
  const ww = w || r * 0.6, ro = 0.04 + r * 0.085, cl = len - r * 1.25 - 0.08;
  const kind = bogie ? 'bogie' : tail ? 'tail' : r * 1.1 + 0.04 > len * 0.8 ? 'car' : 'oleo';
  return { ww, ro, cl, kind, gland: kind === 'bogie' ? len * 0.4 : kind === 'car' ? len * 0.5 : kind === 'tail' ? r * 1.25 + 0.06 : len - cl * 0.62 };
}
// tail wheel: the swivel axis runs down ahead of the axle (the wheel castors behind it)
const tailCaster = (r) => -r * 0.5;
// Where the legs start, in the wheel frame. side: the side of the wheel a spring leg runs down (+1 / -1), or 0 for a
// yoke either side of the wheel (a gear on the centreline). Oleo legs start at the gland nut on the wheel's axis.
export function gearAnchors(o, side = -1) {
  if (o.fairing) { const x = gearDims(o).ww * 0.5 + 0.05, y = o.r * 0.05; return side ? [V(side * x, y, 0)] : [V(-x, y, 0), V(x, y, 0)]; }
  return [V(0, gearDims(o).gland, o.tail ? tailCaster(o.r) : 0)];
}
function defaultRoute(o) {
  const { ro, cl, kind } = gearDims(o), T = V(0, -o.len, 0);
  const legs = gearAnchors(o, -1).map((a) => ({ a: a.clone().add(T), top: V(0, 0, 0) })), braces = [];
  if (kind === 'oleo' && !o.steer && !o.fairing && o.len > 1.2) braces.push({ a: V(0, -cl * 0.45, 0), b: V(0, 0, o.len * 0.38) });
  if (kind === 'bogie') braces.push({ a: V(0, -o.len * 0.32, 0), b: V(0, 0, o.len * 0.42) }, { a: V(0, -o.len * 0.25, 0), b: V(ro * 6, 0, 0) });
  return { q: new THREE.Quaternion(), side: -1, legs, braces, fwd: V(0, 0, -1) };
}

// Full gear leg. Same contract as parts.js gearLeg (origin = strut top, userData.strut / .wheels / .steer, wheels at
// y = -len), plus userData.wheelsFixed: fork, axle, piston and spat that follow the wheel up and down without spinning
// (planeDetail.updateDetail keeps them on the wheel; aircraft.js only spins the children of .wheels), and
// userData.reroute(route) for the assembly pass.
export function gearLegDetailed(o) {
  const g = new THREE.Group(), strut = new THREE.Group(), wheels = new THREE.Group(), fixed = new THREE.Group(), leg = new THREE.Group();
  wheels.position.y = -o.len; fixed.position.y = -o.len;
  strut.add(leg); if (!o.bogie) strut.add(fixed); strut.add(wheels); g.add(strut);
  g.userData.strut = strut; g.userData.wheels = wheels; g.userData.steer = !!o.steer; if (!o.bogie) g.userData.wheelsFixed = fixed;
  g.userData.gearLeg = { opts: o, anchors: (side) => gearAnchors(o, side), dims: gearDims(o) };
  g.userData.reroute = (route) => buildGearLeg(o, route, leg, fixed, wheels);
  buildGearLeg(o, null, leg, fixed, wheels);
  return g;
}
function clearGroup(grp) { for (const c of grp.children.slice()) { grp.remove(c); c.traverse((m) => m.geometry?.dispose()); } }
function buildGearLeg(o, route, leg, fixed, wheels) {
  for (const grp of [leg, fixed, wheels]) clearGroup(grp);
  const R = route || defaultRoute(o), { len, r, steer, color = 0xdddddd } = o, { ww, ro, cl, kind, gland } = gearDims(o);
  const paint = PM.skin(color), steel = M.steel(), chrome = M.chrome(), dark = M.darkMetal(), rub = M.rubber();
  // wheel frame <-> part frame
  const T = new THREE.Matrix4().compose(V(0, -len, 0), R.q, V(1, 1, 1)), Rq = new THREE.Matrix4().makeRotationFromQuaternion(R.q), Ti = T.clone().invert();
  const toL = (p) => p.clone().applyMatrix4(Ti), fwd = R.fwd;
  const lB = new Bag(), lN = new Bag(); // leg pieces in the wheel frame (strut)
  const sB = new Bag(), sN = new Bag(); // routed pieces, already in the part frame (strut)
  const fB = new Bag(), fN = new Bag(); // fork / spat / axle: wheel frame, ride with the wheel
  const fU = new Bag(), fUN = new Bag(); // piston and lower torque link: also raked with the leg about the fork crown
  const legs = R.legs.map((l) => ({ ...l, aL: toL(l.a), topL: toL(l.top), kneeL: l.knee ? toL(l.knee) : null }));
  // the legs: from the anchor (via a knee where the straight path was blocked) to the top, streamlined, plus boots
  // (a tail wheel's leg is a leaf spring: a flat strap, wide across and thin fore and aft)
  const legW = o.fairing ? 0.036 : kind === 'bogie' ? ro * 3 : kind === 'tail' ? r * 0.45 : ro * 2, legC = o.fairing ? 0.12 : kind === 'tail' ? r * 0.13 : legW * oleoK;
  for (const l of legs) {
    const pts = [l.a, ...(l.knee ? [l.knee] : []), l.top];
    for (let i = 0; i < pts.length - 1; i++) sB.add(fairedBar(pts[i], pts[i + 1].clone().addScaledVector(pts[i + 1].clone().sub(pts[i]).normalize(), i < pts.length - 2 ? legW * 0.3 : 0), legW, legC, fwd), paint);
    if (l.knee) sB.add(new THREE.SphereGeometry(legW * 0.62, 12, 8).translate(l.knee.x, l.knee.y, l.knee.z), paint);
    if (l.n && R.boot) sB.add(strutFlare(l.top, l.top.clone().sub(pts.at(-2)).normalize(), l.n, legW, legC, fwd), paint);
    else { const up = l.top.clone().sub(pts.at(-2)).normalize(); sB.add(fairedBar(l.top.clone().addScaledVector(up, -0.05), l.top.clone().addScaledVector(up, 0.02), legW * 1.25, legC * 1.15, fwd), PM.metal('anodised')); } // collar
  }
  const lg0 = legs[0], segBot = lg0.a, segTop = lg0.knee || lg0.top; // first leg segment
  const aft = (a, b) => { const d = b.clone().sub(a).normalize(); return fwd.clone().negate().addScaledVector(d, fwd.dot(d)).normalize(); };
  // braces: streamlined, from the leg to structure
  for (const br of R.braces || []) sB.add(fairedBar(br.a, br.b, ro * (kind === 'bogie' ? 1.1 : 0.9), ro * (kind === 'bogie' ? 1.1 : 0.9) * oleoK, fwd), paint);
  if (o.fairing) {
    // spring-steel legs into a streamlined spat; a step on a single leg, brake line down its back
    if (legs.length === 1) {
      const p = segBot.clone().lerp(segTop, 0.5), upP = V(0, 1, 0).applyQuaternion(R.q), out = V(R.side > 0 ? 1 : -1, 0, 0).applyQuaternion(R.q);
      const step = new THREE.BoxGeometry(0.16, 0.012, 0.12); step.translate(0.08, 0, 0); step.applyMatrix4(new THREE.Matrix4().makeBasis(out, upP, out.clone().cross(upP).normalize()).setPosition(p));
      sN.add(step, M.aluminum()); sN.add(bar(p, p.clone().addScaledVector(out, 0.08), 0.02, 0.02, true, 5), steel);
      const af = aft(segBot, segTop); sN.add(tube([0.95, 0.5, 0.08].map((t) => segBot.clone().lerp(lg0.top, t).addScaledVector(af, 0.03)), 0.007, 4), rub);
    }
    wheelSpat(fB, { r, ww, paint, legs: legs.map((l) => ({ a: l.aL, dir: (l.kneeL || l.topL).clone().sub(l.aL).normalize() })) });
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.12, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
  } else if (kind === 'bogie') {
    // heavy bogie: faired oleo, gland, torque links; the beam and four wheels hang below and ride with the oleo
    lB.add(fairedBar(V(0, gland - 0.04, 0), V(0, gland + 0.04, 0), legW * 1.1, legC * 1.1), steel); // gland
    lN.add(bar(V(0, len * 0.42, -ro * 2.5), V(0, len * 0.3, -ro * 4), 0.07, 0.04), steel);
    const af = aft(segBot, segTop); sN.add(tube([0.9, 0.5, 0.1].map((t) => segBot.clone().lerp(segTop, t).addScaledVector(af, ro * 3.05)), 0.018, 5), rub);
    const piston = new THREE.CylinderGeometry(ro * 1.05, ro * 1.05, len * 0.5, 14); piston.translate(0, len * 0.25 + 0.05, 0); fU.add(piston, chrome);
    fUN.add(bar(V(0, len * 0.3, -ro * 4), V(0, len * 0.12, -ro * 1.2), 0.07, 0.04), steel);
    const beam = new THREE.CylinderGeometry(0.06 + r * 0.06, 0.06 + r * 0.06, r * 3.4, 12); beam.rotateX(Math.PI / 2); fB.add(beam, steel);
    for (const dz of [-1, 1]) { const ax = new THREE.CylinderGeometry(0.05 + r * 0.04, 0.05 + r * 0.04, ww * 2.1, 10); ax.rotateZ(Math.PI / 2); ax.translate(0, 0, dz * r * 1.2); fB.add(ax, steel); }
    for (const dz of [-1, 1]) for (const dx of [-1, 1]) { const wh = wheelDetailed(r, ww, true); wh.position.set(dx * ww * 0.75, 0, dz * r * 1.2).applyQuaternion(R.q); wh.quaternion.copy(R.q); wheels.add(wh); }
  } else if (kind === 'car') {
    // car / monster wheel: short upright, an arm out to the hub, a coil-over shock
    const cyl = new THREE.CylinderGeometry(ro, ro, len * 0.5, 12); cyl.translate(0, len * 0.75, 0); lB.add(cyl, paint);
    const coil = []; for (let k = 0; k <= 40; k++) { const a = k * 0.9; coil.push(V(Math.cos(a) * ro * 1.6, len - k / 40 * len * 0.45 - 0.02, Math.sin(a) * ro * 1.6)); }
    lN.add(tube(coil, 0.012, 4, 80), M.propTip());
    const piston = new THREE.CylinderGeometry(ro * 0.7, ro * 0.7, len * 0.6, 10); piston.translate(0, len * 0.3, 0); fB.add(piston, chrome);
    fB.add(bar(V(0, 0, 0), V(-(ww * 0.5 + 0.02), 0, 0), 0.07, 0.07, true, 8), steel);
  } else if (kind === 'tail') {
    // tail wheel: the leaf-spring leg ends in a swivel head; below it a castering fork (crown ahead of the axle, slim legs
    // either side of the tyre) carries a small solid tyre on its hub, with a steering horn across the crown. Fork, horn and
    // wheel turn with the steering (wheelsFixed follows the wheel).
    const hp = lg0.aL, hr = r * 0.2, crown = hp.y - 0.05, zc = hp.z, fx = ww * 0.5 + r * 0.1;
    const head = new THREE.CylinderGeometry(hr, hr * 1.15, 0.07, 14); head.translate(hp.x, hp.y - 0.02, hp.z); lB.add(head, steel);
    const cap = new THREE.CylinderGeometry(hr * 0.6, hr * 0.6, 0.02, 10); cap.translate(hp.x, hp.y + 0.025, hp.z); lN.add(cap, chrome);
    const cr = new THREE.BoxGeometry(2 * fx + r * 0.16, r * 0.14, r * 0.36); cr.translate(0, crown, zc); fB.add(cr, steel);
    for (const sx of [-1, 1]) fB.add(bar(V(sx * fx, crown, zc), V(sx * fx, 0, 0), r * 0.1, r * 0.22), steel);
    const axle = new THREE.CylinderGeometry(r * 0.12, r * 0.12, 2 * fx + r * 0.2, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
    const horn = bar(V(-r * 0.75, crown + r * 0.1, zc), V(r * 0.75, crown + r * 0.1, zc), r * 0.1, r * 0.08); fN.add(horn, steel);
  } else {
    // oleo: faired cylinder (the routed leg) + gland nut; chrome piston, fork crown, fork legs and axle ride with the wheel
    lB.add(fairedBar(V(0, gland - 0.018, 0), V(0, gland + 0.018, 0), legW * 1.12, legC * 1.12), steel); // gland nut
    const crown = r * 1.1 + 0.04; // fork crown height above the axle
    const pl = len - crown - cl * 0.35; // piston length (its top hides inside the cylinder)
    const piston = new THREE.CylinderGeometry(ro * 0.72, ro * 0.72, pl, 12); piston.translate(0, crown + pl / 2, 0); fU.add(piston, chrome);
    const cr = new THREE.BoxGeometry(ww + 0.12, 0.07, 0.1); cr.translate(0, crown, 0); fB.add(cr, steel);
    for (const sx of [-1, 1]) fB.add(bar(V(sx * (ww * 0.5 + 0.04), crown, 0), V(sx * (ww * 0.5 + 0.04), 0, 0), 0.03, 0.08), steel);
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.14, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
    // torque links (scissor) on the front of the oleo, with lugs on the cylinder and the fork crown and an apex pin
    const yL = len - cl * 0.52, zT = -ro * 1.5 - 0.02, apex = V(0, gland - 0.04 - (gland - crown) * 0.35, zT - Math.max(0.06, len * 0.08));
    lN.add(bar(V(0, yL, zT), apex, 0.03, 0.022), steel);
    fUN.add(bar(apex, V(0, crown + 0.02, zT), 0.03, 0.022), steel);
    lN.add(bar(V(0, yL, -ro * 0.5), V(0, yL, zT - 0.012), 0.05, 0.035), steel);
    fUN.add(bar(V(0, crown + 0.02, -0.03), V(0, crown + 0.02, zT - 0.012), 0.05, 0.035), steel);
    lN.add(bar(V(-0.02, apex.y, apex.z), V(0.02, apex.y, apex.z), 0.03, 0.03, true, 6), steel); // apex pin
    if (!steer) { // brake line down the back of the leg
      const af = aft(segBot, segTop); sN.add(tube([0.95, 0.5, 0.05].map((t) => segBot.clone().lerp(segTop, t).addScaledVector(af, ro * 2 + 0.01)), 0.009, 5), rub);
      fN.add(tube([V(0, crown + 0.2, ro * 1.2), V(-ww * 0.3, crown * 0.6, ro * 1.4), V(-(ww * 0.5 + 0.04), r * 0.2, 0.06)], 0.009, 5), rub);
    } else {
      const c = segBot.clone().lerp(segTop, 0.75), du = segTop.clone().sub(segBot).normalize(); // steering collar and actuator on the cylinder
      sB.add(fairedBar(c.clone().addScaledVector(du, -0.04), c.clone().addScaledVector(du, 0.04), legW * 1.3, legC * 1.25, fwd), steel);
      sN.add(bar(c, c.clone().add(V(ro * 2.6, 0.1, ro * 0.6).applyQuaternion(R.q)), 0.035, 0.035, true, 6), chrome);
    }
    if (steer && r < 0.3 && len > 0.6) { const mg = new THREE.TorusGeometry(r * 1.05, 0.02, 4, 16, Math.PI * 0.6); mg.rotateY(Math.PI / 2); mg.rotateX(-Math.PI * 0.2); fN.add(mg, dark); } // mudguard
  }
  if (kind !== 'bogie') { // one wheel: stood upright by its own rotation (aircraft.js spins it about x), ZYX so the spin comes first
    const wh = wheelDetailed(r, ww, !steer), e = new THREE.Euler().setFromQuaternion(R.q, 'ZYX');
    wh.rotation.set(0, e.y, e.z, 'ZYX'); wheels.add(wh);
  }
  // an oleo whose leg was raked (to clear a control surface) leans its gland, links and piston with it, about the crown
  const Cl = V(0, kind === 'bogie' ? 0 : r * 1.1 + 0.04, 0), u = kind === 'oleo' || kind === 'bogie' ? lg0.aL.clone().sub(Cl).normalize() : V(0, 1, 0);
  const Mu = new THREE.Matrix4().makeTranslation(Cl.x, Cl.y, Cl.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), u))).multiply(new THREE.Matrix4().makeTranslation(-Cl.x, -Cl.y, -Cl.z));
  const put = (bag, grp, near, m) => { const n0 = grp.children.length; bag.to(grp, near); for (const c of grp.children.slice(n0)) c.geometry.applyMatrix4(m); };
  const TU = T.clone().multiply(Mu), RU = Rq.clone().multiply(Mu);
  put(lB, leg, false, TU); put(lN, leg, true, TU); sB.to(leg); sN.to(leg, true);
  const fg = kind === 'bogie' ? wheels : fixed; put(fB, fg, false, Rq); put(fN, fg, true, Rq); put(fU, fg, false, RU); put(fUN, fg, true, RU);
}

// Float / skid struts. stations: z of the struts along the float (part frame), y: the float's top. Without the
// assembly pass they are posts up to the part origin; gearRoute.js calls userData.restrut(segs, boots, fwd) with
// struts routed up to the skin (N-struts, spreader bars), all in the part frame.
export function strutLegs(g, spec) {
  const grp = new THREE.Group(); g.add(grp);
  const build = (segs, boots = [], fwd = V(0, 0, -1)) => {
    clearGroup(grp);
    const b = new Bag(), fit = spec.kind === 'float' ? M.steel() : spec.paint;
    for (const s of segs) {
      const w = spec.w * (s.k || 1), c = spec.c * (s.k || 1);
      b.add(fairedBar(s.a, s.b, w, c, fwd), spec.kind === 'float' ? M.steel() : spec.paint);
      if (s.foot) { const d = s.b.clone().sub(s.a).normalize(); b.add(fairedBar(s.a.clone().addScaledVector(d, -0.02), s.a.clone().addScaledVector(d, 0.06), w * 1.5, c * 1.3, fwd), fit); } // clamp on the float / skid
    }
    for (const t of boots) b.add(strutFlare(t.p, t.dir, t.n, spec.w, spec.c, fwd), spec.kind === 'float' ? M.steel() : spec.paint);
    b.to(grp);
  };
  g.userData.strutLegs = spec;
  g.userData.restrut = build;
  build(spec.stations.map((z) => ({ a: V(0, spec.y, z), b: V(0, 0, z), foot: true })));
  return g;
}

// ---------- cockpits ----------
// Glass shapes shared with the assembly pass (skinBlend.js), which seats the canopy into the body skin.
export const FIGHTER_GLASS = [[-1.6, 0.02], [-0.8, 0.42], [0.3, 0.5], [1.4, 0.3], [2.0, 0.04]];
const _fgc = new THREE.SplineCurve(FIGHTER_GLASS.map(([z, r]) => new THREE.Vector2(z, r))).getPoints(48);
export const fighterGlassR = (z) => { if (z <= _fgc[0].x || z >= _fgc.at(-1).x) return 0; for (let i = 1; i < _fgc.length; i++) if (_fgc[i].x >= z) { const a = _fgc[i - 1], b = _fgc[i]; return Math.max(0, a.y + (b.y - a.y) * ((z - a.x) / (b.x - a.x || 1))); } return 0; };
// a frame bow following a glass cross-section: half-width w and height h of the section at z, from just below the base
function bowGeo(w, h, z, rad, y0 = -0.06) {
  const pts = [V(-w, y0, z)];
  for (let i = 0; i <= 16; i++) { const a = Math.PI * (i / 16); pts.push(V(-Math.cos(a) * w, Math.sin(a) * h, z)); }
  pts.push(V(w, y0, z));
  return pipe(pts, rad, 6, 60);
}
// Obstacles round a seat (crew.js prepObstacle: the posture keeps the body clear of them), from the geometry that is
// built: a box placed by matrix m (a panel), the glare shield's hood (a part-cylinder of radius r squashed to k in depth,
// an arc of +-arc about straight ahead, centred at (y, z), height hgt: the box round it), a canopy's sections sampled
// from sec(z) -> [w, h, yc] over z0..z1.
export function boxObstacle(name, m, size) { const p = V(), q = new THREE.Quaternion(), s = V(); m.decompose(p, q, s); return { name, box: p.toArray(), size, rot: new THREE.Euler().setFromQuaternion(q).toArray().slice(0, 3) }; }
export function hoodObstacle(name, r, k, arc, y, z, hgt) { const d = r * k * (1 - Math.cos(arc)); return { name, box: [0, y, z - r * k + d / 2], size: [2 * r * Math.sin(arc), hgt, d] }; }
export function insideRows(z0, z1, n, sec) { return Array.from({ length: n + 1 }, (_, i) => { const z = z0 + (z1 - z0) * (i / n); return [+z.toFixed(4), ...sec(z).map((v) => +v.toFixed(4))]; }); }
// seat: a reclined, padded shell (back + pan) as a lofted section; headrest as a pillow
export function seatGeo(width, backH, panL, tilt) {
  // back: section is a shallow U (wings at the sides), swept up the back line
  const back = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6, y = backH * t, zb = Math.sin(tilt) * y, ring = [];
    for (const [x, dz] of [[-0.5, -0.07], [-0.42, 0.0], [0, 0.02], [0.42, 0.0], [0.5, -0.07], [0.46, 0.035], [0, 0.06], [-0.46, 0.035]]) ring.push(V(x * width * (1 - 0.12 * t), y * Math.cos(tilt), zb + dz));
    back.push(ring);
  }
  const g = ringLoft(back, true, true);
  const pan = new THREE.CapsuleGeometry(width * 0.42, width * 0.2, 4, 10); pan.rotateZ(Math.PI / 2); pan.scale(1, 0.3, 1.5 * panL / width); pan.translate(0, 0.02, -panL * 0.45);
  return mergeGeometries([norm(g), norm(pan)]);
}
// Detail build of the glazed cockpits. Replaces the plain part's boxes: everything inside fits under the glass.
// The glass carries a skirt below its base (hidden): skinBlend clips it to the body skin and shows it when seated.
export function cockpitBuild(id, color, lv = 2) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = PM.skin(color), black = M.black(), seatM = PM.seat();
  if (id === 'ck_bubble') {
    const a = 0.45, bb = 1.0, c = 0.425;
    const dome = new THREE.SphereGeometry(1, 56, 22, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(a, c, bb);
    g.add(new THREE.Mesh(dome, PM.canopy()));
    const skirt = new THREE.Mesh((() => { const s = new THREE.CylinderGeometry(1, 1, 0.5, 56, 1, true); s.scale(a, 1, bb); s.translate(0, -0.25, 0); return s; })(), PM.canopy());
    skirt.visible = false; skirt.userData.glassSkirt = true; g.add(skirt);
    // windscreen bow and the rear hoop of the sliding hood (they follow the glass)
    for (const [z, rad] of [[-0.6, 0.018], [0.42, 0.014]]) { const k = Math.sqrt(1 - (z / bb) ** 2); b.add(bowGeo(a * k + 0.006, c * k + 0.006, z, rad), paint); }
    bubbleInterior(g, b, nb, lv); // the cockpit under it (bubbleCockpit.js): panel, glareshield, consoles, seat, side panels, floor
  } else if (id === 'ck_fighter') {
    const glass = revolveZ(smoothPts(FIGHTER_GLASS, 40), 48, 1.15);
    g.add(new THREE.Mesh(glass, PM.canopy(0x6b5524)));
    // windscreen bow (thick) and the canopy arch, following the glass section
    for (const [z, rad] of [[-0.62, 0.026], [0.78, 0.02]]) { const r = fighterGlassR(z); b.add(bowGeo(r + 0.006, r * 1.15 + 0.006, z, rad, -r * 0.35), paint); }
    // the cockpit under it (jetCockpit.js): ejection seat on rails, consoles, side-stick, panel, glare shield, HUD, mirrors
    fighterInterior(g, b, nb, paint);
  }
  b.to(g); nb.to(g, true);
  return g;
}
// The open cockpit's well on a body that isn't reshaped round it (planeDetail.openWell): the opening inside the coaming
// (half-width a, half-length b), the footwell's half-width and length ahead of the opening, and the floor's height.
export const OPEN_WELL = { a: 0.37, b: 0.53, fw: 0.24, foot: 0.45, floor: -0.58 };
// Detail build of the open cockpit: windscreen, coaming rim, a padded seat; the pilot (or driver) comes from crew.js.
// The windscreen is a little curved, raked screen in a metal frame standing on the front of the coaming (its base at the
// group origin): skinBlend moves it onto the seam when the cockpit is seated in a body, and leaves it untrimmed.
export function openCockpitBuild(color) {
  const g = new THREE.Group(), b = new Bag();
  const screen = new THREE.Group(), sb = new Bag(), Rw = 0.34, A = 0.75, H = 0.24, rake = 0.55;
  const wsG = new THREE.CylinderGeometry(Rw, Rw, H, 20, 1, true, Math.PI - A, 2 * A); wsG.translate(0, H / 2, Rw); // front of the arc at z = 0
  const tilt = new THREE.Matrix4().makeRotationX(rake); wsG.applyMatrix4(tilt); // top leaning back
  const glass = new THREE.Mesh(wsG, PM.canopy(0x3c5262)); glass.userData.screenGlass = true; glass.castShadow = false; screen.add(glass);
  const arc = (y) => { const o = []; for (let i = 0; i <= 12; i++) { const a = Math.PI - A + 2 * A * (i / 12); o.push(V(Math.sin(a) * Rw * 1.01, y, Rw + Math.cos(a) * Rw * 1.01).applyMatrix4(tilt)); } return o; };
  sb.add(pipe(arc(H), 0.011, 6, 40), M.chrome()); // top rail
  for (const i of [0, 12]) { const p = arc(0)[i], q = arc(H)[i]; sb.add(bar(p, q, 0.022, 0.022, true, 6), M.chrome()); } // side posts
  const foot = arc(0); sb.add(pipe(foot, 0.014, 6, 40), M.darkMetal()); // base strip on the coaming
  sb.to(screen); screen.position.set(0, 0.03, -0.52); g.add(screen); g.userData.screen = screen;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 10, 32), leatherMat(color)); rim.rotation.x = Math.PI / 2; rim.scale.set(1, 1.4, 1); g.add(rim); g.userData.rim = rim; // padded coaming (skinBlend swaps it for one along the seam)
  const st = seatGeo(0.4, 0.5, 0.36, 0.3); st.translate(0, -0.36, 0.32); b.add(st, PM.seat());
  const hrest = new THREE.CapsuleGeometry(0.06, 0.12, 4, 10); hrest.rotateZ(Math.PI / 2); hrest.scale(1, 1, 0.6); hrest.translate(0, 0.17, 0.48); b.add(hrest, PM.seat());
  // dash under the coaming's front: the instruments, and where a steering column goes in (on a car body it hangs from
  // the deck, its ends in the footwell's sides; under a plane's coaming it is the instrument panel)
  const pf = mx([0, -0.19, -0.5], [-0.15, 0, 0]), dash = new THREE.BoxGeometry(0.47, 0.2, 0.025); dash.applyMatrix4(pf); b.add(dash, M.black());
  const nb = new Bag(); for (let i = 0; i < 3; i++) { const d = new THREE.CircleGeometry(0.03, 12); d.applyMatrix4(pf.clone().multiply(mx([-0.12 + i * 0.12, 0.02, 0.0135]))); nb.add(d, PM.dial()); }
  { // their needles (liveDisplays.js): the revs, the speed, and a fuel gauge that stays put
    const lp = new LivePanel(null, { basic: true }), at = (f) => Math.PI * 0.75 + Math.PI * 1.5 * Math.max(-0.02, Math.min(1.03, f)), F = (i) => pf.clone().multiply(mx([-0.12 + i * 0.12, 0.02, 0.0135]));
    for (const [i, src, col] of [[0, 'rpmK', '#ff6a1a'], [1, (S) => S.spd / 50, '#f2f2f2'], [2, () => 0.7, '#f2f2f2']]) lp.needle(F(i), { src, at, len: 0.022, w: 0.0024, z: 0.0008, color: col, hub: 2.4, hubCol: '#2a2b2e' });
    lp.to(g); }
  b.to(g); nb.to(g, true);
  g.userData.fit = [{ kind: 'seat', p: [0, -0.393, 0.18], w: 0.22, d: 0.2 }];
  // the pilot or driver (crew.js) on that seat, the seat point where the hips settle; pedals on the well's floor
  { const P = [0, -0.219, 0.241], S = 0.84, at = (x, y, z) => [x - P[0], y - P[1], z - P[2]]; // (controls: part units from the seat point)
    g.userData.seats = [{ p: P, s: S, fit: { at: [0, -0.36, 0.32], dims: [0.4, 0.5, 0.36, 0.3], floor: OPEN_WELL.floor, feet: 'pedals' },
      controls: { pedY: at(0, OPEN_WELL.floor, 0)[1], pedZ: at(0, 0, -0.2)[2] } }]; }
  // what the driver must keep clear of: the padded coaming (the rim torus's inside: 0.4 - 0.06 across, x1.4 long, 6 cm
  // above and below its centre line; closed ahead of it, the deck), the well under it (OPEN_WELL's opening, and the
  // footwell ahead of it) and the dash
  { const { a, b, fw, foot } = OPEN_WELL, ze = -b * Math.sqrt(1 - (fw / a) ** 2), ri = 0.4 - 0.06, rl = (0.4 - 0.06) * 1.4;
    const ell = (z, A, Bz) => (Math.abs(z) < Bz ? A * Math.sqrt(1 - (z / Bz) ** 2) : 0);
    g.userData.seats[0].obstacles = [{ name: 'coaming / well', below: 'walls', top: 0.06, inside: insideRows(ze - foot, b, 48, (z) => [ell(z, ri, rl), 10, -0.06, 2, Math.max(ell(z, a, b), z <= ze ? fw : 0)]) },
      boxObstacle('dash', pf, [0.47, 0.2, 0.025])]; }
  return g;
}
// small local copies of parts.js revolve helpers (parts.js imports this file)
function smoothPts(pts, n) { return new THREE.SplineCurve(pts.map(([z, r]) => new THREE.Vector2(z, r))).getPoints(n).map((p) => [p.x, Math.max(0, p.y)]); }
function revolveZ(prof, segs, sy) {
  const rings = prof.map(([z, r]) => { const ring = []; for (let i = 0; i < segs; i++) { const t = (i / segs) * Math.PI * 2; ring.push(V(Math.sin(t) * r, Math.cos(t) * r * sy, z)); } return ring; });
  return ringLoft(rings);
}

// Exhaust routes from a car engine's collectors, in engine space (x mirrored per side): the first one the assembly finds
// clear of body and glass is used.
export const EXHAUST_ROUTES = [
  { name: 'side pipes', pts: [[0.42, 0.08, 0.3], [0.42, 0.09, 0.5], [0.43, 0.12, 0.85]] },
  { name: 'zoomies', pts: [[0.42, 0.08, 0.3], [0.52, 0.13, 0.33], [0.66, 0.26, 0.36], [0.82, 0.46, 0.44]] },
  { name: 'dump under', pts: [[0.42, 0.08, 0.3], [0.42, -0.06, 0.48], [0.4, -0.2, 0.8], [0.4, -0.22, 1.5]] },
  { name: 'stacks', pts: [[0.42, 0.08, 0.3], [0.5, 0.18, 0.36], [0.52, 0.6, 0.4], [0.52, 1.05, 0.42]] },
  { name: 'stubs', pts: [[0.42, 0.08, 0.3], [0.5, 0.1, 0.36], [0.56, 0.1, 0.4]] }, // last resort: short open headers
];
export function exhaustPipes(route, ex) {
  const g = new THREE.Group(), b = new Bag(), chrome = M.chrome(), r = ex.r; g.userData.route = route.name;
  for (const sx of [1, -1]) {
    const pts = route.pts.map(([x, y, z]) => V(sx * x, y, z)), end = pts.at(-1), dir = end.clone().sub(pts.at(-2)).normalize();
    b.add(pipe(pts, r, 12, pts.length * 8), chrome);
    // the tip: a flared open ring with a sooty inside, and the pipe's dark bore just inside it
    const tip = new THREE.CylinderGeometry(r * 1.15, r * 1.02, r * 1.4, 16, 1, true), q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir);
    tip.applyMatrix4(new THREE.Matrix4().compose(end.clone().addScaledVector(dir, r * 0.5), q, V(1, 1, 1))); b.add(shell(tip, r * 0.12), chrome);
    const bore = new THREE.CircleGeometry(r * 0.95, 14); bore.applyMatrix4(new THREE.Matrix4().compose(end.clone().addScaledVector(dir, 0.004), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), dir), V(1, 1, 1))); b.add(bore, PM.exhaust());
  }
  b.to(g); return g;
}
// Detail build of the car engine: a supercharged V8 (the plain part is three boxes). Front towards -Z. Block and heads in
// the part colour, chrome rocker covers, polished blower with its drive belt and pulleys, an injector hat with an open
// mouth, four-into-one headers on each bank sweeping down into the side pipes, timing cover, alternator, oil pan.
export function carEngineDetail(color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = M.paint(color), chrome = M.chrome(), alu = PM.metal('polished'), dark = M.darkMetal(), hot = PM.metal('hot'), black = M.black();
  // bottom end: block, oil pan, bell housing
  const block = new THREE.BoxGeometry(0.36, 0.26, 0.66); block.translate(0, 0.17, 0); b.add(block, paint);
  const pan = new THREE.BoxGeometry(0.28, 0.1, 0.56); pan.translate(0, 0.0, 0.02); b.add(pan, dark);
  const bell = new THREE.CylinderGeometry(0.17, 0.2, 0.12, 20); bell.rotateX(Math.PI / 2); bell.translate(0, 0.16, 0.38); b.add(bell, alu);
  // the V: two banks at 45 degrees, heads in the part colour, chrome rocker covers with breathers
  for (const sx of [-1, 1]) {
    const head = new THREE.BoxGeometry(0.17, 0.16, 0.64); head.applyMatrix4(mx([0, 0.06, 0])); head.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); b.add(head, paint);
    const cov = new THREE.CapsuleGeometry(0.06, 0.5, 4, 10); cov.rotateX(Math.PI / 2); cov.scale(1.25, 0.8, 1); cov.applyMatrix4(mx([0, 0.16, 0])); cov.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); b.add(cov, chrome);
    const br = new THREE.CylinderGeometry(0.025, 0.025, 0.06, 10); br.applyMatrix4(mx([0, 0.22, 0.15])); br.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); nb.add(br, chrome);
    // headers: four primaries out of the outer face of the head, down and back into a collector, then the side pipe
    const outF = V(sx * 0.29, 0.31, 0);
    for (let k = 0; k < 4; k++) {
      const z = -0.24 + k * 0.16, p0 = V(outF.x, outF.y, z), p1 = V(sx * 0.36, 0.26, z), p2 = V(sx * 0.4, 0.12, z * 0.6 + 0.08), p3 = V(sx * 0.42, 0.08, 0.3);
      b.add(pipe([p0, p1, p2, p3], 0.024, 8, 24), hot);
    }
    const coll = new THREE.SphereGeometry(0.055, 12, 8); coll.translate(sx * 0.42, 0.08, 0.3); b.add(coll, hot); // collector
  }
  // The exhaust from each collector: side pipes by default. The assembly pass (planeDetail.routeExhaust) checks them
  // against the vehicle they are fitted to and re-routes them (zoomies, dumps under the floor, stacks) if they would
  // run into the body or through glass.
  g.userData.exhaust = { from: [V(0.42, 0.08, 0.3), V(-0.42, 0.08, 0.3)], r: 0.05 };
  // engine mounts: four legs off the block, carried down to whatever the engine sits on (carDetail.js feet)
  g.userData.feet = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ p: [sx * 0.19, 0.08, sz * 0.22], d: [sx * 0.25, -1, 0], r: 0.03, kind: 'sq', mat: M.darkMetal(), on: 'any', reach: 1.0 })));
  g.add(exhaustPipes(EXHAUST_ROUTES[0], g.userData.exhaust));
  // intake manifold, the blower (ribbed case), injector hat with an open mouth and throttle butterflies
  const man = new THREE.BoxGeometry(0.22, 0.1, 0.56); man.translate(0, 0.43, 0); b.add(man, alu);
  const blower = new THREE.CapsuleGeometry(0.11, 0.42, 4, 14); blower.rotateX(Math.PI / 2); blower.scale(1.25, 0.85, 1); blower.translate(0, 0.56, 0.0); b.add(blower, alu);
  for (let k = 0; k < 7; k++) { const rib = new THREE.BoxGeometry(0.3, 0.012, 0.012); rib.translate(0, 0.65, -0.21 + k * 0.07); nb.add(rib, alu); }
  const hat = new THREE.BoxGeometry(0.26, 0.14, 0.3); hat.translate(0, 0.73, -0.02); b.add(hat, dark);
  const lip = new THREE.BoxGeometry(0.28, 0.02, 0.05); lip.translate(0, 0.81, -0.16); b.add(lip, chrome);
  const mouth = new THREE.PlaneGeometry(0.22, 0.1); mouth.rotateY(Math.PI); mouth.translate(0, 0.74, -0.171); b.add(mouth, black);
  for (const sx of [-0.06, 0.06]) { const fly = new THREE.CircleGeometry(0.035, 12); fly.rotateY(Math.PI); fly.rotateX(0.5); fly.translate(sx, 0.74, -0.15); nb.add(fly, alu); }
  // front: blower drive pulley and belt down to the crank pulley, timing cover, alternator
  const pul = (r, y, z, w = 0.05) => { const c = new THREE.CylinderGeometry(r, r, w, 18); c.rotateX(Math.PI / 2); c.translate(0, y, z); return c; };
  b.add(pul(0.075, 0.56, -0.3), alu); b.add(pul(0.1, 0.14, -0.37), alu); b.add(pul(0.035, 0.14, -0.4, 0.06), chrome);
  for (const sx of [-1, 1]) b.add(bar(V(sx * 0.08, 0.56, -0.31), V(sx * 0.1, 0.14, -0.37), 0.012, 0.05), black); // the belt
  const tc = new THREE.BoxGeometry(0.26, 0.24, 0.04); tc.translate(0, 0.2, -0.345); b.add(tc, paint);
  const alt = pul(0.06, 0.3, -0.3, 0.1); alt.translate(-0.17, 0, 0); b.add(alt, alu);
  // plug wires: a row of coloured leads from each head down the side of the block
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) nb.add(tube([V(sx * 0.22, 0.42, -0.24 + k * 0.16), V(sx * 0.27, 0.43, -0.2 + k * 0.16), V(sx * 0.3, 0.38, -0.2 + k * 0.16)], 0.008, 4, 6), M.paint(0xd21f1f, 'gloss'));
  b.to(g); nb.to(g, true);
  return g;
}
// Detail build of the airliner nose: the same skin of revolution, with the flight-deck windows cut into it facing
// forward (the plain part's windscreen patch faced sideways), framed panes, a dark flight deck behind them with the
// glare shield and panel, and two crew seats (crew.js seats the captain and first officer with their yokes).
// flight-deck windows: the canopy glass, darker and less mirror-like (at the low angles you see them from, the bubble
// canopy glass turned the windscreen milky white)
let _fdg = null;
export function flightDeckGlass() {
  if (_fdg) return _fdg;
  const base = PM.canopy(0x1c2a36); _fdg = base.clone();
  Object.assign(_fdg, { opacity: 0.45, envMapIntensity: 0.55, color: new THREE.Color(0x0f171e) });
  _fdg.onBeforeCompile = base.onBeforeCompile; _fdg.customProgramCacheKey = base.customProgramCacheKey;
  return _fdg;
}
export const AIRLINER_NOSE =[[-4.6, 0], [-4.4, 0.7], [-3.4, 1.4], [-1.8, 1.82], [0, 1.9]];
// Detail nose shape, in side view: crown line T, keel line B and half-width W along z (z = 0 joins the tube, r = 1.9).
// A 737's, traced off a side-on photo (scaled by its 1.83 m front door, the tip and the fuselage axis lined up): the
// tip hangs low, the crown runs up the long radome and the avionics bay at ~25 deg to the windscreen, steepens up
// the windscreen (~45 deg) and only then rounds over into the crown, well aft of the windows, so there is a deep brow of
// skin over them; the keel curves up gently. (The plain part, which physics reads, is unchanged.)
const NOSE_T = [[-4.6, -0.62], [-4.52, -0.42], [-4.38, -0.28], [-4.18, -0.13], [-3.98, -0.02], [-3.58, 0.18], [-3.18, 0.35], [-3.0, 0.43], [-2.8, 0.6], [-2.6, 0.82], [-2.38, 0.98], [-2.18, 1.1], [-1.98, 1.2], [-1.58, 1.36], [-1.18, 1.52], [-0.6, 1.74], [0, 1.9]];
const NOSE_B = [[-4.6, -0.62], [-4.55, -0.8], [-4.38, -0.97], [-4.18, -1.07], [-3.98, -1.13], [-3.58, -1.3], [-3.18, -1.4], [-2.78, -1.52], [-2.38, -1.6], [-1.98, -1.66], [-1.2, -1.78], [0, -1.9]];
const NOSE_W = [[-4.6, 0], [-4.52, 0.36], [-4.3, 0.72], [-3.9, 1.06], [-3.3, 1.42], [-2.5, 1.7], [-1.4, 1.87], [0, 1.9]];
function lineFn(pts) { // spline through (z, v), tabulated on a uniform z grid
  const s = new THREE.SplineCurve(pts.map(([z, v]) => new THREE.Vector2(z, v))).getPoints(160), z0 = pts[0][0], z1 = pts.at(-1)[0], N = 1024, t = new Float32Array(N + 1);
  for (let k = 0, i = 1; k <= N; k++) { const z = z0 + (z1 - z0) * (k / N); while (i < s.length - 1 && s[i].x < z) i++; const a = s[i - 1], c = s[i]; t[k] = a.y + (c.y - a.y) * Math.min(1, Math.max(0, (z - a.x) / (c.x - a.x || 1))); }
  return (z) => { const u = Math.min(1, Math.max(0, (z - z0) / (z1 - z0))) * N, k = Math.min(N - 1, Math.floor(u)); return t[k] + (t[k + 1] - t[k]) * (u - k); };
}
const nT = lineFn(NOSE_T), nB = lineFn(NOSE_B), nW = lineFn(NOSE_W);
// a point on the nose skin: z along, th round from the top (+ = right)
const nosePt = (z, th, k = 1) => { const T = nT(z), B = nB(z), mid = (T + B) / 2, c = Math.cos(th), h = c >= 0 ? T - mid : mid - B; return V(Math.sin(th) * nW(z) * k, mid + c * h * k, z); };
// flight-deck window set, measured off a 737's (side-on and head-on photos; heights over the fuselage axis, the deck's
// floor 0.6 under it): a shallow band between a sill line (0.40 at the front panes, rising aft) and a top line 0.82 up,
// just over the pilots' eyes, ending aft at the third side window's back edge (its lower corner cut back), under a
// deep brow of skin. Three panes a side: the wide front one, the sliding window beside the pilot, the small one aft.
// > 0 inside the glazing
const SILL = (z) => 0.4 + 0.045 * (z + 3.0), WTOPY = (z) => 0.82 + 0.02 * (z + 2.6), WAFT = (y) => -1.38 - 0.45 * Math.max(0, 0.67 - y);
const WPOST1 = 0.52, WPOST2 = -1.93; // the front/sliding window post's azimuth, the sliding/aft window post's z
const winVal = (z, th) => { const y = nosePt(z, th).y; return Math.min(y - SILL(z), WTOPY(z) - y, WAFT(y) - z, (1.3 - Math.abs(th)) * 0.8); };
// where a line y = lvl(z) crosses the skin at azimuth th (the skin rises aft there), and the azimuth of height y at z
const zOn = (th, lvl) => { let lo = -4.0, hi = -1.0; for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (nosePt(m, th).y - lvl(m) > 0) hi = m; else lo = m; } return hi; };
const thAt = (z, y) => { const T = nT(z), B = nB(z), mid = (T + B) / 2; return Math.acos(Math.min(1, Math.max(-1, (y - mid) / (y >= mid ? T - mid : mid - B)))); };
// the glazing's outline as [z, th], round from the left aft corner of the sill: sill, right aft edge, top, left aft edge
function winOutline(n = 30) {
  const fix = (lvl) => { let y = lvl(-2); for (let i = 0; i < 20; i++) y = lvl(WAFT(y)); return y; }; // (where the aft edge meets the line)
  // a line across the nose: by azimuth over the front (th0 either side), then by z along the side (where the skin runs
  // nearly level with it, so its azimuth is the well-defined one), to the aft edge at yEnd
  const line = (lvl, th0, yEnd, dir) => { const zA = zOn(th0, lvl), zB = WAFT(yEnd), pts = [];
    for (let i = 0; i <= n; i++) { const z = zB + (zA - zB) * (i / n); pts.push([z, -thAt(z, lvl(z))]); }
    for (let i = 1; i < n; i++) { const th = -th0 + 2 * th0 * (i / n); pts.push([zOn(th, lvl), th]); }
    for (let i = 0; i <= n; i++) { const z = zA + (zB - zA) * (i / n); pts.push([z, thAt(z, lvl(z))]); }
    return dir > 0 ? pts : pts.reverse().map(([z, th]) => [z, th]); };
  const ys = fix(SILL), yt = fix(WTOPY), out = [...line(SILL, 0.85, ys, 1)];
  for (let i = 1; i < 8; i++) { const y = ys + (yt - ys) * (i / 8), z = WAFT(y); out.push([z, thAt(z, y)]); }
  out.push(...line(WTOPY, 0.6, yt, -1));
  for (let i = 1; i < 8; i++) { const y = yt + (ys - yt) * (i / 8), z = WAFT(y); out.push([z, -thAt(z, y)]); }
  return out;
}
// the posts between the panes, each as [z, th] from the sill up: the centre one, the front panes' outer posts, and the
// posts between the sliding and aft side windows (upright in side view)
function winPosts() {
  const P = [];
  for (const th of [0, -WPOST1, WPOST1]) { const z0 = zOn(th, SILL), z1 = zOn(th, WTOPY), pts = []; for (let k = 0; k <= 8; k++) pts.push([z0 + (z1 - z0) * (k / 8), th]); P.push(pts); }
  for (const sx of [-1, 1]) { const z = WPOST2, y0 = SILL(z), y1 = WTOPY(z), pts = []; for (let k = 0; k <= 8; k++) { const y = y0 + (y1 - y0) * (k / 8); pts.push([z, sx * thAt(z, y)]); } P.push(pts); }
  return P;
}
// ---------- the airliner's flight deck (Boeing 737NG / MAX style, from photos of real ones) ----------
// Everything painted or printed in the deck (panel greys, the displays, the mode control panel, the CDUs, the overhead's
// switch panels, radios, circuit breakers, carpet, sheepskin) comes from one atlas: one material (colour + glowing
// screens in its emissive map + roughness), so the whole deck is one draw call plus the kit fittings.
// The colour sheet is 2048 x 1024: the left half holds the printed faces (displays, panels, CDUs, radios: everything that
// glows), the right half the materials laid over the furniture (powder-coated plates with their seams, Dzus fasteners,
// baked shading in the corners and worn edges; the bezels, anti-glare fabric, carpet, fleece, leather, visor fabric).
// The emissive map only covers the left half (its texture transform stretches it there; clamped black beyond).
// The roughness map also carries, in red and blue, how strongly and how coarsely the shader's grain breaks up each
// surface (fdPatch): fine powder-coat grain on the panels, weave on fabric, pile on the carpet, tufts on the fleece.
const FDW = 1024, FW = 2048;
const fdR = (x, y, w, h) => [x / FW, 1 - (y + h) / FDW, (x + w) / FW, 1 - y / FDW];
const FDA = { pfd: fdR(0, 0, 320, 256), nd: fdR(320, 0, 320, 256), eng: fdR(640, 0, 320, 256), isfd: fdR(960, 0, 64, 64), gear: fdR(960, 64, 64, 192),
  mcp: fdR(0, 256, 768, 64), efis: fdR(768, 256, 128, 64), clock: fdR(896, 256, 128, 64), cdu: fdR(0, 320, 160, 256), radio: fdR(160, 320, 192, 256), cb: fdR(352, 320, 160, 256),
  lowL: fdR(512, 320, 512, 64), lowR: fdR(512, 384, 512, 64), outb: fdR(512, 448, 256, 128), ovh: fdR(0, 576, 512, 384), door: fdR(512, 576, 256, 384), side: fdR(768, 576, 256, 384),
  plateA: fdR(1024, 0, 256, 256), plateB: fdR(1280, 0, 256, 256), plateC: fdR(1536, 0, 256, 256), face: fdR(1792, 0, 256, 256),
  bezel: fdR(1024, 256, 256, 256), fabric: fdR(1280, 256, 256, 256), carpet: fdR(1536, 256, 256, 256), fleece: fdR(1792, 256, 256, 256),
  leather: fdR(1024, 512, 256, 256), worn: fdR(1280, 512, 256, 256), visor: fdR(1536, 512, 256, 256), post: fdR(1792, 512, 256, 256),
  bulk: fdR(1024, 768, 256, 256), shell: fdR(1280, 768, 256, 256), lining: fdR(1536, 768, 256, 256) };
// small solid swatches along the bottom row of the left half: [colour, roughness, grain strength, grain coarseness]
const FDS = { panel: ['#4f5963', 0.7, 0.45, 0], trim: ['#7f878e', 0.8, 0.4, 0], glare: ['#111214', 0.95, 0.9, 0.25], carpet: ['#3d4752', 1, 1, 0.6], fleece: ['#ddd2bd', 1, 1, 1], bezel: ['#24282d', 0.45, 0.3, 0],
  grey: ['#5e6871', 0.7, 0.45, 0], door: ['#6b737a', 0.6, 0.4, 0], white: ['#e6e6e1', 0.5, 0.3, 0], knob: ['#17181b', 0.45, 0.25, 0], kick: ['#30353a', 0.9, 0.5, 0], shell: ['#3b4047', 0.55, 0.3, 0], yellow: ['#d8b22a', 0.6, 0.3, 0], red: ['#a8231d', 0.6, 0.3, 0], cream: ['#ece6d6', 0.4, 0.2, 0], ovh: ['#57616b', 0.7, 0.45, 0], post: ['#5b646c', 0.75, 0.4, 0], lip: ['#08090a', 0.6, 0.2, 0] };
const FDK = Object.keys(FDS), fdSw = (k) => [(FDK.indexOf(k) * 32 + 16) / FW, 1 - 992 / FDW];
// the overhead's modules and its toggle switches (u across from the left, v from its aft edge to the front), shared by the
// printed panel and the 3D toggles
let _ovl = null;
function overheadLayout() {
  if (_ovl) return _ovl;
  let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const mods = [], sw = [], cols = [0, 0.27, 0.5, 0.73, 1];
  for (let c = 0; c < 4; c++) {
    let v = 0.02;
    while (v < 0.96) {
      const h = Math.min(0.98 - v, 0.11 + rnd() * 0.1), u0 = cols[c] + 0.01, u1 = cols[c + 1] - 0.01, kind = rnd();
      const m = { u0, u1, v0: v, v1: v + h, kind: kind < 0.6 ? 'sw' : kind < 0.8 ? 'ann' : 'gauge' }; mods.push(m);
      if (m.kind === 'sw') { const n = 2 + Math.floor(rnd() * 4), rows = h > 0.15 ? 2 : 1; for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) sw.push([u0 + (u1 - u0) * ((i + 0.5) / n), v + h * (rows === 2 ? (r ? 0.3 : 0.7) : 0.45), rnd() < 0.15]); }
      v += h + 0.01;
    }
  }
  return (_ovl = { mods, sw });
}
const MCP_WIN = [[0.015, 0.075, '042'], [0.165, 0.255, '250'], [0.375, 0.445, '084'], [0.545, 0.665, '10000'], [0.755, 0.855, '-1200'], [0.925, 0.985, '042']];
function fdAtlasTextures() {
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
  const [ca, a] = mk(FW, FDW), [ce, e] = mk(FDW, FDW), [cr, r] = mk(FW, FDW);
  a.fillStyle = FDS.panel[0]; a.fillRect(0, 0, FW, FDW); e.fillStyle = '#000'; e.fillRect(0, 0, FDW, FDW);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // roughness (green) with the grain's strength (red) and coarseness (blue)
  const rmF = (x, y, w, h, rough, gs = 0.45, sc = 0) => { r.fillStyle = `rgb(${Math.round(gs * 255)},${Math.round(rough * 255)},${Math.round(sc * 255)})`; r.fillRect(x, y, w, h); };
  rmF(0, 0, FW, FDW, 0.7);
  const T = (c, s, x, y, px, col, al = 'center', w = 'bold') => { c.font = `${w} ${px}px monospace`; c.textAlign = al; c.textBaseline = 'middle'; c.fillStyle = col; c.fillText(s, x, y); };
  const screen = (x, y, w, h) => { a.fillStyle = '#050607'; a.fillRect(x, y, w, h); rmF(x, y, w, h, 0.15, 0, 0); };
  const ring = (c, x, y, rad, col, lw = 2) => { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.stroke(); };
  const disc = (c, x, y, rad, col) => { c.fillStyle = col; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill(); };
  // baked shading: an inner shadow round a rectangle (panels meeting, recesses), a soft dark ring round a knob or switch
  const ao = (x, y, w, h, d = 10, k = 0.35, sides = 'tblr') => {
    for (const [s, gx0, gy0, gx1, gy1, rx, ry, rw, rh] of [['t', x, y, x, y + d, x, y, w, d], ['b', x, y + h, x, y + h - d, x, y + h - d, w, d], ['l', x, y, x + d, y, x, y, d, h], ['r', x + w, y, x + w - d, y, x + w - d, y, d, h]]) {
      if (!sides.includes(s)) continue; const g = a.createLinearGradient(gx0, gy0, gx1, gy1); g.addColorStop(0, `rgba(0,0,0,${k})`); g.addColorStop(1, 'rgba(0,0,0,0)'); a.fillStyle = g; a.fillRect(rx, ry, rw, rh); } };
  const halo = (x, y, rad, k = 0.4) => { const g = a.createRadialGradient(x, y, rad * 0.7, x, y, rad * 1.9); g.addColorStop(0, `rgba(0,0,0,${k})`); g.addColorStop(1, 'rgba(0,0,0,0)'); a.fillStyle = g; a.beginPath(); a.arc(x, y, rad * 1.9, 0, Math.PI * 2); a.fill(); };
  // a Dzus fastener: a slotted quarter-turn stud in a little ring
  const dzus = (x, y, rad = 3.5) => { disc(a, x + 0.6, y + 0.8, rad + 1.2, 'rgba(0,0,0,0.35)'); disc(a, x, y, rad, '#a3aab0'); disc(a, x - rad * 0.25, y - rad * 0.25, rad * 0.45, 'rgba(255,255,255,0.25)'); a.strokeStyle = '#30353a'; a.lineWidth = Math.max(1, rad * 0.35); a.beginPath(); a.moveTo(x - rad * 0.75, y + rad * 0.3); a.lineTo(x + rad * 0.75, y - rad * 0.3); a.stroke(); };
  // backlit legend: cream lettering that glows faintly (a real panel's light plate)
  const legend = (s, x, y, px, al = 'center') => { T(a, s, x, y, px, '#efeadb', al); T(e, s, x, y, px, '#5a5444', al); };
  const glow = (x, y, w, h, col, k = 1) => { e.save(); e.shadowColor = col; e.shadowBlur = 7; e.globalAlpha = k; e.fillStyle = col; e.fillRect(x, y, w, h); e.restore(); };
  // a module face: a slightly different grey each, its seam, the light plate's edge, shading in its corners, fasteners
  const module = (x, y, w, h, base = FDS.panel[0], fast = true) => {
    a.fillStyle = base; a.fillRect(x, y, w, h); const k = (rnd() - 0.5) * 0.08; a.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(10,20,30,${-k})`; a.fillRect(x, y, w, h);
    ao(x, y, w, h, Math.min(10, w / 6, h / 6), 0.3); a.strokeStyle = 'rgba(255,255,255,0.13)'; a.lineWidth = 1; a.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
    a.strokeStyle = '#1a1e22'; a.lineWidth = 2; a.strokeRect(x + 1, y + 1, w - 2, h - 2);
    if (fast && w > 40 && h > 30) for (const [fx, fy] of [[x + 7, y + 7], [x + w - 7, y + 7], [x + 7, y + h - 7], [x + w - 7, y + h - 7]]) dzus(fx, fy, 2.6); };
  // primary flight display: attitude (sky over ground, pitch ladder, the yellow aircraft symbol), speed and altitude tapes,
  // the mode annunciations along the top, the heading arc along the bottom
  const pfd = (x0, y0) => {
    screen(x0, y0, 320, 256); const c = e; c.save(); c.translate(x0, y0);
    c.save(); c.beginPath(); c.roundRect(80, 36, 160, 136, 16); c.clip();
    c.fillStyle = '#2470d6'; c.fillRect(70, 20, 180, 86); c.fillStyle = '#8b5428'; c.fillRect(70, 106, 180, 80);
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(70, 106); c.lineTo(250, 106); c.stroke(); c.lineWidth = 1.5;
    for (let k = -4; k <= 4; k++) if (k) { const y = 106 - k * 13, w = k % 2 ? 12 : 26; c.beginPath(); c.moveTo(160 - w, y); c.lineTo(160 + w, y); c.stroke(); if (!(k % 2)) { T(c, String(Math.abs(k) * 5), 160 - w - 10, y, 9, '#fff'); T(c, String(Math.abs(k) * 5), 160 + w + 10, y, 9, '#fff'); } }
    c.restore();
    c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(160, 106, 62, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
    for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { const t = (d - 90) * Math.PI / 180, l = d % 30 ? 5 : 9; c.beginPath(); c.moveTo(160 + Math.cos(t) * 62, 106 + Math.sin(t) * 62); c.lineTo(160 + Math.cos(t) * (62 + l), 106 + Math.sin(t) * (62 + l)); c.stroke(); }
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(160, 44); c.lineTo(154, 34); c.lineTo(166, 34); c.fill();
    c.fillStyle = '#111'; c.strokeStyle = '#ffd21a'; c.lineWidth = 2.5; for (const [x, w] of [[112, 30], [178, 30]]) { c.fillRect(x, 103, w, 6); c.strokeRect(x, 103, w, 6); } c.fillRect(157, 103, 6, 6); c.strokeRect(157, 103, 6, 6);
    c.strokeStyle = '#ff40ff'; c.lineWidth = 2; c.beginPath(); c.moveTo(160, 66); c.lineTo(160, 146); c.moveTo(118, 112); c.lineTo(202, 112); c.stroke(); // (flight director bars)
    for (const [x, lab, val, step] of [[14, 'spd', 250, 10], [256, 'alt', 10000, 100]]) {
      c.fillStyle = '#4a4f58'; c.fillRect(x, 36, 50, 136); c.strokeStyle = '#fff'; c.lineWidth = 1.5;
      for (let k = -3; k <= 3; k++) { const y = 104 - k * 20; c.beginPath(); c.moveTo(lab === 'spd' ? x + 50 : x, y); c.lineTo(lab === 'spd' ? x + 42 : x + 8, y); c.stroke(); if (k) T(c, String(val + k * step * 2), x + 25, y, 10, '#fff'); }
      c.fillStyle = '#000'; c.fillRect(x - 2, 94, 54, 22); c.strokeStyle = '#fff'; c.strokeRect(x - 2, 94, 54, 22); T(c, String(val), x + 25, 105, 13, '#fff');
    }
    c.strokeStyle = '#ff40ff'; c.lineWidth = 2; c.strokeRect(258, 26, 46, 9); T(c, '10000', 281, 30, 9, '#ff40ff'); T(c, '250', 39, 30, 9, '#ff40ff');
    c.strokeStyle = '#777'; c.lineWidth = 1; for (const [i, s] of ['MCP SPD', 'LNAV', 'VNAV PTH'].entries()) { c.strokeRect(78 + i * 56, 4, 54, 18); T(c, s, 105 + i * 56, 13, 9, '#3fe03f'); }
    T(c, 'CMD', 160, 50, 10, '#3fe03f');
    c.save(); c.beginPath(); c.rect(70, 182, 180, 74); c.clip(); c.fillStyle = '#4a4f58'; c.beginPath(); c.arc(160, 296, 100, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 1.5; for (let d = -40; d <= 40; d += 5) { const t = (d - 90) * Math.PI / 180, l = (84 + d) % 10 ? 5 : 10; c.beginPath(); c.moveTo(160 + Math.cos(t) * 100, 296 + Math.sin(t) * 100); c.lineTo(160 + Math.cos(t) * (100 - l), 296 + Math.sin(t) * (100 - l)); c.stroke(); if (!((84 + d + 6) % 30)) T(c, String((84 + d + 6) / 10), 160 + Math.cos(t + 0.1) * 82, 296 + Math.sin(t + 0.1) * 82, 10, '#fff'); }
    c.restore(); c.fillStyle = '#000'; c.fillRect(146, 184, 28, 14); c.strokeStyle = '#fff'; c.strokeRect(146, 184, 28, 14); T(c, '084', 160, 191, 10, '#fff');
    c.restore();
  };
  // navigation display: compass arc, range ring, the magenta route through waypoints ahead of the aircraft triangle
  const nd = (x0, y0, w, h) => {
    screen(x0, y0, w, h); const c = e; c.save(); c.translate(x0, y0); c.scale(w / 320, h / 256);
    const cx = 160, cy = 236, R = 196; c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R, Math.PI * 1.25, Math.PI * 1.75); c.stroke();
    for (let hd = 40; hd <= 130; hd += 5) { const t = (hd - 84 - 90) * Math.PI / 180, l = hd % 10 ? 7 : 13; if (Math.abs(hd - 84) > 46) continue; c.beginPath(); c.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); c.lineTo(cx + Math.cos(t) * (R - l), cy + Math.sin(t) * (R - l)); c.stroke(); if (!(hd % 30)) T(c, String(hd / 10), cx + Math.cos(t) * (R - 24), cy + Math.sin(t) * (R - 24), 14, '#fff'); }
    c.setLineDash([5, 6]); c.lineWidth = 1.2; c.beginPath(); c.arc(cx, cy, R / 2, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); c.setLineDash([]);
    c.strokeStyle = '#ff48ff'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(cx, cy); c.lineTo(176, 150); c.lineTo(214, 72); c.lineTo(250, 8); c.stroke();
    for (const [x, y, n, col] of [[176, 150, 'RIVET', '#ff48ff'], [214, 72, 'TOPAZ', '#fff'], [92, 118, 'KESTR', '#4fd8e8']]) { c.fillStyle = col; c.beginPath(); for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4, rr = i % 2 ? 2.5 : 7; c.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); } c.fill(); T(c, n, x + 26, y, 11, col); }
    ring(c, 60, 186, 6, '#4fd8e8', 2); T(c, 'KSKY', 60, 200, 10, '#4fd8e8');
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(cx, cy - 16); c.lineTo(cx - 9, cy + 6); c.lineTo(cx + 9, cy + 6); c.closePath(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
    T(c, 'GS 245  TAS 262', 6, 12, 12, '#fff', 'left'); T(c, '270°/ 15', 6, 28, 12, '#fff', 'left');
    c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(130, 4, 60, 18); T(c, 'TRK 084', 160, 13, 12, '#fff'); T(c, 'MAG', 210, 13, 11, '#3fe03f');
    T(c, 'TOPAZ', 314, 12, 12, '#ff48ff', 'right'); T(c, '1423.4z', 314, 28, 12, '#fff', 'right'); T(c, '32 NM', 314, 44, 12, '#fff', 'right'); T(c, '20', cx + 6, cy - R / 2 - 6, 11, '#fff', 'left');
    c.restore();
  };
  // engine display (737 MAX upper centre / FO inboard): N1 and EGT dials for both engines, with the ND sharing the screen
  const eng = (x0, y0) => {
    screen(x0, y0, 320, 256); const c = e; c.save(); c.translate(x0, y0);
    const dial = (x, y, rad, frac, val) => { c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y, rad, Math.PI, Math.PI * 2.15); c.stroke(); c.strokeStyle = '#f2453b'; c.beginPath(); c.arc(x, y, rad, Math.PI * 2.1, Math.PI * 2.15); c.stroke();
      const t = Math.PI + frac * Math.PI * 1.15; c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(t) * rad, y + Math.sin(t) * rad); c.stroke(); c.fillStyle = '#9a9a9a'; c.beginPath(); c.moveTo(x, y); c.arc(x, y, rad - 2, Math.PI, t); c.fill();
      c.fillStyle = '#000'; c.fillRect(x - 4, y - 18, 42, 16); c.strokeStyle = '#fff'; c.lineWidth = 1; c.strokeRect(x - 4, y - 18, 42, 16); T(c, val, x + 17, y - 10, 11, '#fff'); };
    T(c, 'TAT +12c', 8, 10, 10, '#fff', 'left'); T(c, 'CRZ', 150, 10, 10, '#3fe03f', 'right');
    dial(40, 72, 30, 0.74, '85.2'); dial(118, 72, 30, 0.74, '85.3'); T(c, 'N1', 79, 92, 11, '#4fd8e8');
    dial(40, 150, 26, 0.6, '625'); dial(118, 150, 26, 0.6, '631'); T(c, 'EGT', 79, 168, 11, '#4fd8e8');
    for (const [i, s] of ['FF/FU  2.42  2.44', 'OIL P   44    45', 'OIL T   88    86', 'FUEL  4.1  4.6  4.1'].entries()) T(c, s, 8, 190 + i * 15, 10, i === 3 ? '#fff' : '#cfcfcf', 'left');
    c.restore(); nd(x0 + 160, y0 + 64, 160, 128); e.fillStyle = '#000'; e.fillRect(x0 + 158, y0, 2, 256);
  };
  pfd(0, 0); nd(320, 0, 320, 256); eng(640, 0);
  { screen(960, 0, 64, 64); const c = e; c.save(); c.beginPath(); c.rect(974, 8, 36, 48); c.clip(); c.fillStyle = '#2470d6'; c.fillRect(974, 8, 36, 26); c.fillStyle = '#8b5428'; c.fillRect(974, 34, 36, 22); c.restore(); c.fillStyle = '#ffd21a'; c.fillRect(984, 32, 16, 3); T(c, '250', 966, 32, 7, '#fff', 'left'); T(c, '100', 1022, 32, 7, '#fff', 'right'); }
  { // landing gear panel round the gear lever: three green "down" lights, the lever's UP / OFF / DN placard
    module(960, 64, 64, 192, '#5a6570', false); legend('LANDING GEAR', 992, 78, 7); for (const [i, s] of ['UP', 'OFF', 'DN'].entries()) legend(s, 1012, 150 + i * 26, 8);
    for (const [x, y] of [[992, 98], [978, 114], [1006, 114]]) { a.fillStyle = '#0c0d0e'; a.fillRect(x - 7, y - 5, 14, 10); ao(x - 7, y - 5, 14, 10, 3, 0.5); glow(x - 5, y - 3, 10, 6, '#35d14a'); }
    halo(992, 222, 9); legend('AUTO BRAKE', 992, 238, 7); ring(a, 992, 222, 8, '#111', 5); dzus(966, 70, 2.4); dzus(1018, 70, 2.4); dzus(966, 250, 2.4); dzus(1018, 250, 2.4);
  }
  { // mode control panel: grey modules, recessed black windows with the selected course / speed / heading / altitude /
    // vertical speed, mode buttons with their lit bars, backlit legends; shadow under the glare shield's lip along its top
    const x0 = 0, y0 = 256, W = 768; module(x0, y0, W, 64, '#68737d', false);
    for (const u of [0.13, 0.33, 0.5, 0.71, 0.9]) { a.fillStyle = '#1a1e22'; a.fillRect(x0 + u * W, y0 + 2, 2, 60); }
    for (const [u0, u1, s] of MCP_WIN) { const x = x0 + u0 * W, w = (u1 - u0) * W; a.fillStyle = '#050505'; a.fillRect(x, y0 + 12, w, 20); ao(x, y0 + 12, w, 20, 5, 0.7); a.strokeStyle = 'rgba(255,255,255,0.18)'; a.lineWidth = 1; a.strokeRect(x - 1.5, y0 + 10.5, w + 3, 23);
      T(e, s, x + w / 2, y0 + 22, 17, '#f3eedc'); rmF(x, y0 + 12, w, 20, 0.15, 0, 0); halo(x + w / 2, y0 + 47, 9, 0.35); }
    for (const [i, s] of ['COURSE', 'IAS/MACH', 'HEADING', 'ALTITUDE', 'VERT SPEED', 'COURSE'].entries()) legend(s, x0 + (MCP_WIN[i][0] + MCP_WIN[i][1]) / 2 * W, y0 + 6, 7);
    for (let k = 0; k < 22; k++) { const u = 0.09 + k * 0.038; if (MCP_WIN.some(([u0, u1]) => u > u0 - 0.03 && u < u1 + 0.01)) continue; const x = x0 + u * W; a.fillStyle = 'rgba(0,0,0,0.4)'; a.fillRect(x - 10, y0 + 40, 22, 14); a.fillStyle = '#c9ccce'; a.fillRect(x - 11, y0 + 38, 22, 14); a.fillStyle = 'rgba(255,255,255,0.35)'; a.fillRect(x - 11, y0 + 38, 22, 2);
      a.fillStyle = '#1d1f21'; a.fillRect(x - 9, y0 + 41, 18, 3); if (k % 3 === 0) glow(x - 9, y0 + 41, 18, 3, '#3fe03f'); T(a, ['N1', 'SPD', 'LVL', 'VNAV', 'LNAV', 'VOR', 'APP', 'HDG', 'ALT', 'V/S', 'CMD', 'CWS'][k % 12], x, y0 + 49, 5, '#222'); }
    legend('A/T ARM', x0 + 0.115 * W, y0 + 58, 6); legend('CMD A', x0 + 0.89 * W, y0 + 58, 6);
    ao(x0, y0, W, 64, 16, 0.45, 't'); // (under the glare shield's lip)
  }
  { // EFIS control panels (minimums, baro, map mode and range knobs) and a clock face
    module(768, 256, 128, 64, '#626d77', false); for (const x of [796, 868]) { halo(x, 290, 14, 0.45); ring(a, x, 290, 14, '#1c1d1f', 6); } for (let k = 0; k < 6; k++) { a.fillStyle = '#c9ccce'; a.fillRect(818 + (k % 3) * 9, 270 + Math.floor(k / 3) * 22, 7, 12); }
    legend('MINS', 796, 266, 7); legend('BARO', 868, 266, 7); ao(768, 256, 128, 64, 14, 0.45, 't');
    module(896, 256, 128, 64, '#626d77', false); disc(a, 960, 288, 28, '#0b0b0c'); ring(a, 960, 288, 28, '#bbb', 2); for (let k = 0; k < 12; k++) { const t = k * Math.PI / 6; a.strokeStyle = '#eee'; a.lineWidth = 2; a.beginPath(); a.moveTo(960 + Math.cos(t) * 20, 288 + Math.sin(t) * 20); a.lineTo(960 + Math.cos(t) * 26, 288 + Math.sin(t) * 26); a.stroke(); }
    T(e, '14:23', 960, 296, 11, '#ffb02e');
  }
  { // control display unit (FMS): its screen sunk in the bezel, the keypad's raised keys with shadows, line-select keys
    const x0 = 0, y0 = 320; module(x0, y0, 160, 256, '#363b41', true); a.fillStyle = '#0a0b0c'; a.fillRect(x0 + 13, y0 + 5, 134, 108); screen(x0 + 16, y0 + 8, 128, 102); ao(x0 + 16, y0 + 8, 128, 102, 6, 0.6);
    const key = (x, y, w, h, s, col = '#c4c7cb') => { a.fillStyle = 'rgba(0,0,0,0.55)'; a.fillRect(x + 1, y + 1.5, w, h); a.fillStyle = col; a.fillRect(x, y, w, h); a.fillStyle = 'rgba(255,255,255,0.35)'; a.fillRect(x, y, w, 1.5); a.fillStyle = 'rgba(0,0,0,0.18)'; a.fillRect(x, y + h - 2, w, 2); if (s) T(a, s, x + w / 2, y + h / 2 + 0.5, 6, '#111'); };
    for (let k = 0; k < 6; k++) for (const x of [x0 + 3, x0 + 147]) key(x, y0 + 20 + k * 15, 10, 9, '');
    const lines = [['ACT RTE 1 LEGS', '#fff', 1], ['084°     12NM', '#fff', 0], ['RIVET  250/FL100', '#ff48ff', 0], ['091°     31NM', '#fff', 0], ['TOPAZ  250/FL120', '#3fe03f', 0], ['', '', 0], ['KESTR  280/FL240', '#3fe03f', 0], ['', '', 0], ['-----------------', '#fff', 0], ['<RTE 2   RTE DATA>', '#fff', 0]];
    lines.forEach(([s, col, big], i) => s && T(e, s, x0 + 80, y0 + 16 + i * 9.5, big ? 9 : 8, col));
    for (let k = 0; k < 10; k++) key(x0 + 8 + (k % 5) * 29, y0 + 118 + Math.floor(k / 5) * 14, 25, 11, ['INIT', 'RTE', 'CLB', 'CRZ', 'DES', 'MENU', 'LEGS', 'HOLD', 'PROG', 'EXEC'][k], k === 9 ? '#dfe3e6' : '#c4c7cb');
    for (let k = 0; k < 30; k++) key(x0 + 64 + (k % 5) * 18, y0 + 150 + Math.floor(k / 5) * 17, 15, 14, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ /<>'[k]);
    for (let k = 0; k < 12; k++) key(x0 + 8 + (k % 3) * 18, y0 + 168 + Math.floor(k / 3) * 19, 15, 15, '123456789.0-'[k]);
    glow(x0 + 125, y0 + 120, 20, 2, '#3fe03f'); legend('EXEC', x0 + 135, y0 + 140, 5); legend('DSPY  FAIL  MSG  OFST', x0 + 34, y0 + 152, 4);
  }
  { // radio boxes on the aft pedestal: each its own module (red-digit frequency windows sunk in it, knobs, transfer switch)
    const x0 = 160, y0 = 320; a.fillStyle = '#2a2f34'; a.fillRect(x0, y0, 192, 256);
    const freq = [['118.30', '121.50'], ['110.30', '113.90'], ['124.85', '119.10'], ['ADF 362', '7000']];
    for (let k = 0; k < 4; k++) { const y = y0 + 4 + k * 63; module(x0 + 3, y, 186, 59, ['#5b6670', '#626c76', '#58636d', '#606a73'][k], true);
      for (const [j, xx] of [x0 + 14, x0 + 100].entries()) { a.fillStyle = '#040404'; a.fillRect(xx, y + 9, 76, 20); ao(xx, y + 9, 76, 20, 5, 0.7); T(e, freq[k][j], xx + 38, y + 19, 15, '#ff4a2a'); rmF(xx, y + 9, 76, 20, 0.15, 0, 0); legend(j ? 'STBY' : 'ACTIVE', xx + 38, y + 4.5, 5); }
      for (const xx of [x0 + 40, x0 + 152]) { halo(xx, y + 44, 9, 0.45); ring(a, xx, y + 44, 9, '#161718', 6); } a.fillStyle = '#e1e1dc'; a.fillRect(x0 + 84, y + 38, 24, 12); T(a, 'TFR', x0 + 96, y + 44, 6, '#111'); legend(['VHF 1', 'NAV 1', 'VHF 2', 'ADF / ATC'][k], x0 + 96, y + 55, 5); }
  }
  { // circuit breakers: rows of black buttons with white collars and their labels, on two modules
    const x0 = 352, y0 = 320; module(x0, y0, 160, 128, '#5b6670', true); module(x0, y0 + 128, 160, 128, '#606a74', true);
    for (let rr = 0; rr < 22; rr++) { a.fillStyle = '#d8d8d8'; a.fillRect(x0 + 10, y0 + 4 + rr * 11.4, 140, 1); for (let k = 0; k < 15; k++) { if ((rr * 7 + k * 3) % 11 === 0) continue; const x = x0 + 13 + k * 9.5, y = y0 + 10 + rr * 11.4; disc(a, x + 0.7, y + 0.9, 3.6, 'rgba(0,0,0,0.4)'); disc(a, x, y, 3.4, '#e6e6e2'); disc(a, x, y, 2.3, '#0d0d0e'); } }
  }
  { // panel strips below the displays: knobs (with shadows), amber caution lights that glow, backlit legends, fasteners
    for (const [y0, flip] of [[320, false], [384, true]]) { module(512, y0, 512, 64, flip ? '#5a6570' : '#5f6a74', true); for (const u of [170, 342]) { a.fillStyle = '#1a1e22'; a.fillRect(512 + u, y0 + 2, 2, 60); }
      for (let k = 0; k < 8; k++) { const x = 512 + (flip ? 480 - k * 62 : 32 + k * 62); if (k % 3 === 1) { a.fillStyle = '#0a0a0a'; a.fillRect(x - 20, y0 + 16, 40, 18); ao(x - 20, y0 + 16, 40, 18, 4, 0.6); glow(x - 17, y0 + 19, 34, 12, k === 4 ? '#f0a020' : '#5a3a12', k === 4 ? 1 : 0.8); legend('CAUTION', x, y0 + 46, 6); } else { halo(x, y0 + 28, 10, 0.45); ring(a, x, y0 + 28, 10, '#141414', 7); legend(['MAIN DU', 'LOWER DU', 'BRT', 'FUEL FLOW', 'N1 SET', 'SPD REF'][k % 6], x, y0 + 50, 6); } } }
  }
  { // outboard panels: clock, the display brightness knobs, the nose wheel steering switch
    const x0 = 512, y0 = 448; module(x0, y0, 256, 128, '#5c6771', true); halo(x0 + 60, y0 + 56, 34, 0.3); disc(a, x0 + 60, y0 + 56, 34, '#0b0b0c'); ring(a, x0 + 60, y0 + 56, 34, '#aaa', 2);
    T(e, '14:23', x0 + 60, y0 + 50, 13, '#ffb02e'); T(e, '02:41', x0 + 60, y0 + 70, 10, '#ffb02e');
    for (let k = 0; k < 3; k++) { halo(x0 + 140 + k * 38, y0 + 40, 9, 0.45); ring(a, x0 + 140 + k * 38, y0 + 40, 9, '#141414', 6); legend(['INBD', 'OUTBD', 'UPPER'][k], x0 + 140 + k * 38, y0 + 60, 7); }
    a.fillStyle = '#0a0a0a'; a.fillRect(x0 + 130, y0 + 84, 100, 22); glow(x0 + 133, y0 + 87, 94, 16, '#6a320c', 0.8); legend('NOSE WHEEL STEERING', x0 + 180, y0 + 116, 7);
  }
  { // overhead panel: modules each its own grey, outlined light plates, backlit legends, switch bosses, annunciators that glow
    const x0 = 0, y0 = 576, W = 512, H = 384, L = overheadLayout(); a.fillStyle = '#1c2024'; a.fillRect(x0, y0, W, H);
    const px = (u, v) => [x0 + u * W, y0 + (1 - v) * H];
    let s = 5; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const m of L.mods) {
      const [xa, ya] = px(m.u0, m.v1), [xb, yb] = px(m.u1, m.v0); module(xa, ya, xb - xa, yb - ya, ['#58636d', '#5e6872', '#545f69', '#5b656f'][Math.floor(rnd() * 4)], true);
      a.strokeStyle = 'rgba(232,230,220,0.55)'; a.lineWidth = 1; a.strokeRect(xa + 10, ya + 13, xb - xa - 20, yb - ya - 18);
      legend(['FUEL', 'ELEC', 'HYD', 'BLEED', 'PRESS', 'ANTI-ICE', 'LIGHTS', 'APU', 'ENG START', 'WIPER'][Math.floor(rnd() * 10)], (xa + xb) / 2, ya + 8, 7);
      if (m.kind === 'ann') { const n = 2 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) { const x = xa + 12 + i * ((xb - xa - 24) / n), y = ya + 18 + j * ((yb - ya - 26) / 2), w = (xb - xa - 24) / n - 5, h = Math.min(12, (yb - ya - 26) / 2 - 4); a.fillStyle = '#121416'; a.fillRect(x, y, w, h); ao(x, y, w, h, 3, 0.6); const lit = rnd(); if (lit < 0.3) glow(x + 1, y + 1, w - 2, h - 2, lit < 0.12 ? '#3a78ff' : '#d08a1c', 0.6); else { a.fillStyle = 'rgba(200,190,150,0.12)'; a.fillRect(x + 1, y + 1, w - 2, h - 2); } } }
      if (m.kind === 'gauge') { const n = (xb - xa) > 100 ? 2 : 1; for (let i = 0; i < n; i++) { const x = xa + (xb - xa) * ((i + 0.5) / n), y = (ya + yb) / 2 + 4, rad = Math.min(18, (yb - ya) / 2 - 9); halo(x, y, rad, 0.35); disc(a, x, y, rad, '#0b0b0c'); ring(a, x, y, rad, '#bbb', 1.5); e.strokeStyle = '#8a8270'; e.lineWidth = 2; e.beginPath(); e.moveTo(x, y); e.lineTo(x + rad * 0.7, y - rad * 0.5); e.stroke(); } }
    }
    for (const [u, v] of L.sw) { const [x, y] = px(u, v); halo(x, y, 5, 0.45); disc(a, x, y, 5, '#2b2f33'); disc(a, x, y, 2.5, '#9aa0a5'); a.fillStyle = '#eceff1'; a.fillRect(x - 6, y + 8, 12, 1.5); e.fillStyle = '#4a4538'; e.fillRect(x - 6, y + 8, 12, 1.5); legend(['ON', 'OFF', 'AUTO'][Math.floor(rnd() * 3)], x, y - 9, 4); }
  }
  { // the flight-deck door: grey panel, kick plate scuffed at the foot, a placard, the peephole, the keypad beside the handle
    const x0 = 512, y0 = 576; a.fillStyle = FDS.door[0]; a.fillRect(x0, y0, 256, 384); ao(x0, y0, 256, 384, 20, 0.35); a.strokeStyle = '#6d757b'; a.lineWidth = 3; a.strokeRect(x0 + 12, y0 + 12, 232, 360);
    a.strokeStyle = 'rgba(255,255,255,0.15)'; a.lineWidth = 1; a.strokeRect(x0 + 15, y0 + 15, 226, 354);
    disc(a, x0 + 128, y0 + 120, 7, '#5c646b'); disc(a, x0 + 128, y0 + 120, 4.5, '#101010'); a.fillStyle = '#d9d9d4'; a.fillRect(x0 + 88, y0 + 160, 80, 30); T(a, 'FLIGHT DECK', x0 + 128, y0 + 175, 9, '#222');
    a.fillStyle = '#5c646b'; a.fillRect(x0 + 30, y0 + 322, 196, 50); for (let k = 0; k < 40; k++) { a.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},0.12)`; a.fillRect(x0 + 32 + rnd() * 190, y0 + 324 + rnd() * 44, 4 + rnd() * 18, 1); }
    a.fillStyle = '#30353a'; a.fillRect(x0 + 200, y0 + 196, 30, 44); for (let k = 0; k < 12; k++) { a.fillStyle = '#9aa0a5'; a.fillRect(x0 + 203 + (k % 3) * 9, y0 + 200 + Math.floor(k / 3) * 10, 6, 7); }
  }
  { // side console top: its plate with fasteners and worn edge, the audio control panel (backlit), a map light switch
    const x0 = 768, y0 = 576; module(x0, y0, 256, 384, '#57616a', true); a.fillStyle = 'rgba(220,225,230,0.16)'; a.fillRect(x0 + 2, y0 + 2, 12, 380); // (worn along the inner edge, where elbows rest)
    module(x0 + 40, y0 + 200, 176, 120, '#56616b', true); for (let k = 0; k < 10; k++) { const x = x0 + 52 + (k % 5) * 32, y = y0 + 214 + Math.floor(k / 5) * 34; a.fillStyle = 'rgba(0,0,0,0.45)'; a.fillRect(x + 1, y + 2, 22, 14); a.fillStyle = '#c9ccce'; a.fillRect(x, y, 22, 14); a.fillStyle = '#1d1f21'; a.fillRect(x + 2, y + 2, 18, 3); if (!(k % 4)) glow(x + 2, y + 2, 18, 3, '#3fe03f'); }
    legend('AUDIO CONTROL', x0 + 128, y0 + 300, 9); for (let k = 0; k < 4; k++) { halo(x0 + 70 + k * 40, y0 + 280, 6); ring(a, x0 + 70 + k * 40, y0 + 280, 6, '#151515', 4); }
    module(x0 + 60, y0 + 40, 136, 110, '#5a6570', true); legend('OXYGEN', x0 + 128, y0 + 56, 8); a.fillStyle = '#0c0d0e'; a.fillRect(x0 + 80, y0 + 70, 96, 60); ao(x0 + 80, y0 + 70, 96, 60, 8, 0.6);
  }
  // the right half: materials laid over the furniture
  const mottle = (x0, y0, W, H, n = 70, k = 0.045) => { for (let i = 0; i < n; i++) { const x = x0 + rnd() * W, y = y0 + rnd() * H, rr = 8 + rnd() * 46, l = rnd() < 0.5 ? '255,255,255' : '0,0,0', g = a.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, `rgba(${l},${k})`); g.addColorStop(1, `rgba(${l},0)`); a.save(); a.beginPath(); a.rect(x0, y0, W, H); a.clip(); a.fillStyle = g; a.fillRect(x - rr, y - rr, 2 * rr, 2 * rr); a.restore(); } };
  // a powder-coated panel plate: its own grey, mottled, the seam round it, a lighter light-plate edge, shading in the
  // corners, a Dzus fastener at each corner; worn (lighter, scuffed) along one edge where hands go
  const plate = (x0, y0, base, { top = 0, wear = 0, fast = true, rough = 0.72, gs = 0.45 } = {}) => {
    const W = 256, H = 256; a.fillStyle = base; a.fillRect(x0, y0, W, H); mottle(x0, y0, W, H);
    if (wear) { const g = a.createLinearGradient(0, y0, 0, y0 + 40); g.addColorStop(0, `rgba(215,222,228,${0.28 * wear})`); g.addColorStop(1, 'rgba(215,222,228,0)'); a.fillStyle = g; a.fillRect(x0, y0, W, 40);
      for (let k = 0; k < 25 * wear; k++) { a.fillStyle = `rgba(${rnd() < 0.6 ? '230,235,240' : '20,22,25'},${0.04 + rnd() * 0.06})`; a.fillRect(x0 + rnd() * W, y0 + rnd() * H * 0.3, 2 + rnd() * 10, 1); } }
    ao(x0, y0, W, H, 22, 0.42); if (top) ao(x0, y0, W, H, 90, top, 't');
    a.strokeStyle = 'rgba(255,255,255,0.12)'; a.lineWidth = 1.5; a.strokeRect(x0 + 6.5, y0 + 6.5, W - 13, H - 13); a.strokeStyle = '#15181b'; a.lineWidth = 3; a.strokeRect(x0 + 1.5, y0 + 1.5, W - 3, H - 3);
    if (fast) for (const [fx, fy] of [[x0 + 16, y0 + 16], [x0 + W - 16, y0 + 16], [x0 + 16, y0 + H - 16], [x0 + W - 16, y0 + H - 16]]) dzus(fx, fy, 5);
    rmF(x0, y0, W, H, rough, gs, 0); };
  plate(1024, 0, '#58636d'); plate(1280, 0, '#626c75'); plate(1536, 0, '#454d55'); plate(1792, 0, '#56616b', { top: 0.7 });
  plate(1280, 512, '#4e5862', { wear: 1 });
  { // display bezel: dark satin frame, the glass's black recess with shading into it, screws and the soft keys along its foot
    const x0 = 1024, y0 = 256; a.fillStyle = '#22262b'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256, 40, 0.05); ao(x0, y0, 256, 256, 14, 0.5);
    const hx = 256 * 0.065, hy = 256 * 0.085; a.fillStyle = '#060708'; a.fillRect(x0 + hx, y0 + hy, 256 - 2 * hx, 256 - 2 * hy); a.strokeStyle = 'rgba(255,255,255,0.14)'; a.lineWidth = 1.5; a.strokeRect(x0 + hx - 2, y0 + hy - 2, 256 - 2 * hx + 4, 256 - 2 * hy + 4);
    for (const [fx, fy] of [[x0 + 8, y0 + 8], [x0 + 248, y0 + 8], [x0 + 8, y0 + 248], [x0 + 248, y0 + 248]]) { disc(a, fx, fy, 3, '#6b7177'); a.strokeStyle = '#111'; a.lineWidth = 1; a.beginPath(); a.moveTo(fx - 2, fy); a.lineTo(fx + 2, fy); a.stroke(); }
    for (let k = 0; k < 6; k++) { a.fillStyle = '#3d4247'; a.fillRect(x0 + 40 + k * 31, y0 + 246, 18, 6); } rmF(x0, y0, 256, 256, 0.42, 0.3, 0);
  }
  { // anti-glare fabric: near-black weave, a stitched seam along its edge
    const x0 = 1280, y0 = 256; a.fillStyle = '#111214'; a.fillRect(x0, y0, 256, 256);
    mottle(x0, y0, 256, 256, 50, 0.06); a.strokeStyle = 'rgba(90,92,95,0.8)'; a.setLineDash([4, 3]); a.lineWidth = 1.2; a.strokeRect(x0 + 10, y0 + 10, 236, 236); a.setLineDash([]); ao(x0, y0, 256, 256, 10, 0.4); rmF(x0, y0, 256, 256, 0.97, 0.9, 0.25);
  }
  { // carpet: blue-grey pile, flecked, darker into the corners
    const x0 = 1536, y0 = 256; a.fillStyle = '#3a4450'; a.fillRect(x0, y0, 256, 256); for (let k = 0; k < 6000; k++) { const v = rnd(); a.fillStyle = v < 0.45 ? '#323b46' : v < 0.9 ? '#44505c' : '#58636e'; a.fillRect(x0 + rnd() * 256, y0 + rnd() * 256, 1.5, 1.5); }
    mottle(x0, y0, 256, 256, 60, 0.06); ao(x0, y0, 256, 256, 40, 0.5); rmF(x0, y0, 256, 256, 1, 1, 0.6);
  }
  { // sheepskin: cream fleece in tufts, shaded between them
    const x0 = 1792, y0 = 256; a.fillStyle = '#dcd1bb'; a.fillRect(x0, y0, 256, 256); a.save(); a.beginPath(); a.rect(x0, y0, 256, 256); a.clip();
    for (let k = 0; k < 3500; k++) { const x = x0 + rnd() * 256, y = y0 + rnd() * 256, rr = 1.5 + rnd() * 3, dk = rnd() < 0.45, g = a.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 0, x, y, rr); g.addColorStop(0, dk ? 'rgba(190,178,156,0.3)' : 'rgba(248,243,232,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)'); a.fillStyle = g; a.fillRect(x - rr, y - rr, 2 * rr, 2 * rr); }
    a.restore(); ao(x0, y0, 256, 256, 26, 0.3); rmF(x0, y0, 256, 256, 1, 0.42, 1);
  }
  { // leather: dark, mottled, a sheen worn into it, stitched along its edges
    const x0 = 1024, y0 = 512; a.fillStyle = '#26231f'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256, 90, 0.07); const g = a.createLinearGradient(0, y0, 0, y0 + 256); g.addColorStop(0, 'rgba(255,240,220,0.1)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.25)'); a.fillStyle = g; a.fillRect(x0, y0, 256, 256);
    a.strokeStyle = 'rgba(120,108,92,0.8)'; a.setLineDash([5, 4]); a.lineWidth = 1.5; a.strokeRect(x0 + 12, y0 + 12, 232, 232); a.setLineDash([]); ao(x0, y0, 256, 256, 14, 0.45); rmF(x0, y0, 256, 256, 0.5, 0.7, 0.35);
  }
  { // sun visor fabric: dark green-grey weave in a darker binding
    const x0 = 1536, y0 = 512; a.fillStyle = '#383d36'; a.fillRect(x0, y0, 256, 256); for (let k = 0; k < 256; k += 3) { a.fillStyle = 'rgba(255,255,255,0.03)'; a.fillRect(x0, y0 + k, 256, 1); a.fillStyle = 'rgba(0,0,0,0.05)'; a.fillRect(x0 + k, y0, 1, 256); }
    mottle(x0, y0, 256, 256, 40, 0.06); a.strokeStyle = '#1e211d'; a.lineWidth = 14; a.strokeRect(x0 + 7, y0 + 7, 242, 242); rmF(x0, y0, 256, 256, 0.95, 0.9, 0.3);
  }
  { // window posts and reveals: mid grey trim, shaded along its long edges where it turns
    const x0 = 1792, y0 = 512; a.fillStyle = '#4a5158'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256, 50, 0.05); ao(x0, y0, 256, 256, 26, 0.25, 'tb'); rmF(x0, y0, 256, 256, 0.9, 0.45, 0.05);
  }
  { // back bulkhead: grey lining panels with their seams and fasteners, shaded at the edges
    const x0 = 1024, y0 = 768; a.fillStyle = '#737b82'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256, 60, 0.05);
    for (const u of [64, 192]) { a.fillStyle = 'rgba(20,24,28,0.6)'; a.fillRect(x0 + u, y0, 2, 256); for (let k = 0; k < 6; k++) dzus(x0 + u - 6, y0 + 20 + k * 44, 2.6); } a.fillStyle = 'rgba(20,24,28,0.6)'; a.fillRect(x0, y0 + 100, 256, 2);
    ao(x0, y0, 256, 256, 30, 0.35); rmF(x0, y0, 256, 256, 0.8, 0.4, 0);
  }
  { // moulded plastic shell (seat backs, boxes): dark grey, lighter where its edges round over
    const x0 = 1280, y0 = 768; a.fillStyle = '#383d44'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256, 40, 0.05); a.strokeStyle = 'rgba(255,255,255,0.12)'; a.lineWidth = 6; a.strokeRect(x0 + 4, y0 + 4, 248, 248); ao(x0, y0, 256, 256, 18, 0.3); rmF(x0, y0, 256, 256, 0.5, 0.3, 0);
  }
  { const x0 = 1536, y0 = 768; a.fillStyle = '#727a81'; a.fillRect(x0, y0, 256, 256); mottle(x0, y0, 256, 256); rmF(x0, y0, 256, 256, 0.85, 0.35, 0.05); }
  // swatches
  FDK.forEach((k, i) => { a.fillStyle = FDS[k][0]; a.fillRect(i * 32, 960, 32, 64); rmF(i * 32, 960, 32, 64, FDS[k][1], FDS[k][2], FDS[k][3]); });
  // a fine grain over the whole sheet (a texel's worth of powder coat, felt where the shader's grain is too small to see)
  { const img = a.getImageData(0, 0, FW, FDW), d = img.data; let s2 = 9; for (let i = 0; i < d.length; i += 4) { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; const n = ((s2 >> 16) & 15) - 7.5; d[i] += n; d[i + 1] += n; d[i + 2] += n; } a.putImageData(img, 0, 0); }
  e.fillStyle = '#000'; e.fillRect(FDW - 2, 0, 2, FDW); // (clamped beyond its half: black)
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const small = document.createElement('canvas'); small.width = 512; small.height = 256; small.getContext('2d').drawImage(cr, 0, 0, 512, 256); // (roughness and grain change from region to region: a quarter size will do)
  const emi = tex(ce, true); emi.repeat.set(2, 1); // (the emissive map covers the left half only)
  return { map: tex(ca, true), emi, rm: tex(small, false) };
}
// The deck's surface grain, in the shader (crew.js's crewPatch does the same for the crew): a value-noise height field at
// the surface's own scale bumps the normal and breaks up colour and roughness, so no surface reads as a flat colour. How
// strong and how coarse comes from the roughness map's red and blue (or `fixed` [strength, coarseness]); a slower noise
// mottles everything a little, as light does across real panels.
const FD_GLSL = /* glsl */`varying vec3 vFdP;
  float fdH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float fdN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(fdH(i), fdH(i + vec3(1,0,0)), f.x), mix(fdH(i + vec3(0,1,0)), fdH(i + vec3(1,1,0)), f.x), f.y), mix(mix(fdH(i + vec3(0,0,1)), fdH(i + vec3(1,0,1)), f.x), mix(fdH(i + vec3(0,1,1)), fdH(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 fdBump(vec3 n, vec3 vp, float h, float k) { vec3 dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); vec3 g = sign(det) * (dhx * r1 + dhy * r2); return normalize(abs(det) * n - k * g); }`;
function fdPatch(m, fixed, extra = '') {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFdP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFdP = position;');
    const cls = fixed ? `vec4 fdC = vec4(${fixed[0].toFixed(3)}, 0.0, ${fixed[1].toFixed(3)}, 0.0);` : 'vec4 fdC = texture2D(roughnessMap, vRoughnessMapUv);';
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FD_GLSL)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${cls} float fdGs = fdC.r, fdSc = fdC.b, fdF = mix(900.0, 75.0, fdSc);
        float fdFw = clamp(length(fwidth(vFdP)) * fdF * 0.7, 0.0, 1.0);
        float fdN1 = fdN(vFdP * fdF), fdN2 = fdN(vFdP * fdF * 2.3 + 3.7), fdLo = fdN(vFdP * 2.2), fdMid = fdN(vFdP * 14.0 + 1.3);
        float fdHt = mix((fdN1 - 0.5) + (fdN2 - 0.5) * 0.5, 0.0, fdFw);
        diffuseColor.rgb *= 1.0 + (fdLo - 0.5) * 0.14 + (fdMid - 0.5) * 0.08 + fdHt * 0.22 * fdGs; ${extra}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor * (1.0 + (fdMid - 0.5) * 0.45 + fdHt * 0.35 * fdGs), 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = fdBump(normal, -vViewPosition, fdHt, fdGs * mix(0.00035, 0.0016, fdSc));');
  };
  m.customProgramCacheKey = () => 'fd-' + (fixed ? fixed.join('-') : 'atlas');
  return m;
}
const fdMat = () => pdMat('fdAtlas', () => { const t = fdAtlasTextures(); return fdPatch(new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emi, emissive: 0xffffff, emissiveIntensity: 0.95, roughnessMap: t.rm, roughness: 1, metalness: 0 })); });
// glass over the displays: a black, glossy layer added on top (only its reflection shows)
const fdGlassMat = () => pdMat('fdGlass', () => new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, envMapIntensity: 1.8 }));
// the lining inside the skin (seen from inside: back faces), a mid grey (the photos' deck reads dark round its bright windows), with the same grain
const fdLinerMat = () => pdMat('fdLiner', () => fdPatch(new THREE.MeshStandardMaterial({ color: 0x6d757c, roughness: 0.86, side: THREE.BackSide }), [0.4, 0.08], 'diffuseColor.rgb *= 0.55 + 0.45 * clamp((vFdP.y + 0.1) / 1.1, 0.0, 1.0) * clamp((vFdP.z + 3.6) / 1.2, 0.35, 1.0);')); // (shade baked by height and depth: darker low down and far forward, under the panel)
// a geometry's uv (0..1 over a face) into an atlas rect, or all of it onto a swatch
function fdUV(g, r) {
  norm(g); const a = g.attributes.uv;
  for (let k = 0; k < a.count; k++) if (typeof r === 'string') a.setXY(k, ...fdSw(r)); else a.setXY(k, r[0] + a.getX(k) * (r[2] - r[0]), r[1] + a.getY(k) * (r[3] - r[1]));
  return g;
}
// a quad a-b-c-d (uv 0,0 / 1,0 / 1,1 / 0,1) facing roughly `want`
function fdQuad(A, B, C, D, r, want) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...A.toArray(), ...B.toArray(), ...C.toArray(), ...D.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  const n = B.clone().sub(A).cross(D.clone().sub(A)); g.setIndex(n.dot(want) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]); g.computeVertexNormals();
  return fdUV(g, r);
}
const fdBox = (w, h, d, r, m) => { const g = fdUV(new THREE.BoxGeometry(w, h, d), r); if (m) g.applyMatrix4(m); return g; };
// uv projected along each vertex's main axis over the geometry's bounds (lofts, extrusions, seats: a material plate laid
// over each face), into an atlas rect. Flat faces: unweld it first (flat = true).
function fdTriUV(g, r, flat = false, seat = false) {
  if (flat && g.index) { g = g.toNonIndexed(); g.computeVertexNormals(); }
  norm(g); g.computeBoundingBox(); const bb = g.boundingBox, sz = bb.getSize(V()), P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  const f = (p, k) => (p - bb.min.getComponent(k)) / Math.max(1e-4, sz.getComponent(k));
  let s0 = Infinity, s1 = -Infinity; if (seat) for (let i = 0; i < P.count; i++) { const t = P.getY(i) - P.getZ(i) * 0.8; s0 = Math.min(s0, t); s1 = Math.max(s1, t); }
  for (let i = 0; i < P.count; i++) { const ax = Math.abs(N.getX(i)), ay = Math.abs(N.getY(i)), az = Math.abs(N.getZ(i)), p = [P.getX(i), P.getY(i), P.getZ(i)];
    const [u, v] = seat ? [f(p[0], 0), (p[1] - p[2] * 0.8 - s0) / Math.max(1e-4, s1 - s0)] : ax >= ay && ax >= az ? [f(p[2], 2), f(p[1], 1)] : ay >= az ? [f(p[0], 0), f(p[2], 2)] : [f(p[0], 0), f(p[1], 1)]; // (a seat: across, and up the back then forward along the pan, without streaks)
    U.setXY(i, r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1])); }
  return g;
}
// a ringLoft's uv: along the rings (u) and round each ring (v), into an atlas rect (its caps at the rect's middle)
function fdLoftUV(g, n, rings, r) {
  norm(g); const U = g.attributes.uv;
  for (let i = 0; i < U.count; i++) { const [u, v] = i < n * rings ? [Math.floor(i / n) / (rings - 1), (i % n) / Math.max(1, n - 1)] : [0.5, 0.5]; U.setXY(i, r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1])); }
  return g;
}
// a display's bezel (local to its panel face, z out of the face): the frame's front ring (painted from the bezel plate:
// screws, soft keys, shading into the recess), its sides, and the recess walls down to the screen, which sits `d` back
function fdBezel(W, H, w, h, d, z0) {
  const r = FDA.bezel, at = (x, y) => [r[0] + (x / W + 0.5) * (r[2] - r[0]), r[1] + (y / H + 0.5) * (r[3] - r[1])], out = [];
  const q = (pts, uv, want) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => p.toArray()), 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
    const n = pts[1].clone().sub(pts[0]).cross(pts[3].clone().sub(pts[0])); g.setIndex(n.dot(want) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]); g.computeVertexNormals(); out.push(norm(g)); };
  const O = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]], I = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], dark = at(0, 0);
  for (let k = 0; k < 4; k++) { const j = (k + 1) % 4, f = (p, z) => V(p[0], p[1], z);
    q([f(O[k], z0), f(O[j], z0), f(I[j], z0), f(I[k], z0)], [at(...O[k]), at(...O[j]), at(...I[j]), at(...I[k])], V(0, 0, 1)); // front ring
    q([f(I[k], z0), f(I[j], z0), f(I[j], z0 - d), f(I[k], z0 - d)], [dark, dark, dark, dark], V(-(I[k][0] + I[j][0]), -(I[k][1] + I[j][1]), 0)); // recess walls (facing in)
    q([f(O[k], z0), f(O[j], z0), f(O[j], z0 - 0.012), f(O[k], z0 - 0.012)], [at(...O[k]), at(...O[j]), at(...O[j]), at(...O[k])], V(O[k][0] + O[j][0], O[k][1] + O[j][1], 0)); } // outer sides
  return mergeGeometries(out);
}
// The deck inside airlinerNoseBuild's skin (part coordinates; the nose looks along -z, the floor's top at FLOOR). Built
// round the crew's seats and controls: the yokes' columns stand in the floor at z -3.16 ahead of each seat, the rudder
// pedals hinge at the floor at z -3.03, the eyes are about 1.05 up. Returns the obstacles for the crew's posture solve.
function airlinerFlightDeck(g, bR, nbR, { SY, SZ, SEAT, FLOOR, zs, DY, DZ }) {
  const A = fdMat(), K = 0.97, kit = { black: M.black(), dark: M.darkMetal(), alu: M.aluminum(), rubber: M.rubber(), chrome: M.chrome() };
  // The furniture is laid out in deck coordinates and set down into the nose by (0, DY, DZ) (b, nb; the obstacles too);
  // what follows the skin (lining, window reveals and posts, visors) is built in place (bR, nbR)
  const SH = new THREE.Matrix4().makeTranslation(0, DY, DZ), shift = (bag) => ({ add: (geo, mat, m) => bag.add(geo, mat, m ? SH.clone().multiply(m) : SH), to: (...a) => bag.to(...a) });
  const b = shift(bR), nb = shift(nbR);
  // the lining's inner half-width at (z, y), and its top at (z, x), in deck coordinates
  const secHW = (z0, y0, k = K) => { const z = z0 + DZ, y = y0 + DY, T = nT(z), B = nB(z), mid = (T + B) / 2, h = (y >= mid ? T - mid : mid - B) * k, c = (y - mid) / h; return Math.abs(c) >= 1 ? 0 : Math.sqrt(1 - c * c) * nW(z) * k; };
  const topY = (z0, x, k = K) => { const z = z0 + DZ, T = nT(z), B = nB(z), mid = (T + B) / 2, s = Math.min(1, Math.abs(x) / (nW(z) * k)); return mid + Math.sqrt(1 - s * s) * (T - mid) * k - DY; };
  // lining: the nose's sections at 0.97, cut open at the windows (it hid them: the pilots saw grey where the glass is) and
  // below the floor
  { const lz = zs.filter((z) => z > -4.05 && z < -1.4 + DZ), LS = 96, lp = [], li = [], val = [];
    for (const z of lz) for (let i = 0; i <= LS; i++) { const t = (i / LS) * Math.PI * 2, th = t > Math.PI ? t - Math.PI * 2 : t, p = nosePt(z, th, K); lp.push(p.x, p.y, p.z); val.push(Math.min(z < -4.0 || z > -1.5 + DZ ? 1 : -winVal(z, th), p.y - (FLOOR + DY) + 0.06)); }
    for (let j = 0; j < lz.length - 1; j++) for (let i = 0; i < LS; i++) { const a = j * (LS + 1) + i, c = a + LS + 1; li.push(a, c, c + 1, a, c + 1, a + 1); }
    const liner = new THREE.BufferGeometry(); liner.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); liner.setIndex(li); liner.computeVertexNormals();
    g.add(new THREE.Mesh(clipGeometry(liner, Float32Array.from(val)) || liner, fdLinerMat())); }
  // window reveals: the lining turned out to the skin all round the glazing, and the posts between the panes cased in trim
  { const out = [], inn = []; for (const [z, th] of winOutline(40)) { out.push(nosePt(z, th, 1.0)); inn.push(nosePt(z, th, K - 0.002)); }
    const n = out.length, pos = [], idx = []; for (const p of [...out, ...inn]) pos.push(p.x, p.y, p.z);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, n + j, i, n + j, n + i, i, n + j, j, i, n + i, n + j); } // (both faces)
    const rv = new THREE.BufferGeometry(); rv.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rv.setIndex(idx); rv.computeVertexNormals();
    { const uv = []; for (const v of [0, 1]) for (let i = 0; i < n; i++) uv.push(i / n, v); rv.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); } bR.add(fdUV(rv, FDA.post), A);
    for (const [pi, post] of winPosts().entries()) { // (each cased across its run, a little past the sill and the top)
      const at = (t) => { const k = Math.min(post.length - 2, Math.max(0, Math.floor(t * (post.length - 1)))), f = t * (post.length - 1) - k; return [post[k][0] + (post[k + 1][0] - post[k][0]) * f, post[k][1] + (post[k + 1][1] - post[k][1]) * f]; };
      const w = pi ? 0.036 : 0.045, rings = [];
      for (let k = 0; k <= 8; k++) { const t = -0.05 + 1.1 * (k / 8), [z, th] = at(t), po = nosePt(z, th, 0.999), pin = nosePt(z, th, K - 0.01);
        const [za, tha] = at(t - 0.02), [zb, thb] = at(t + 0.02), tg = nosePt(zb, thb).sub(nosePt(za, tha)), nr = po.clone().sub(V(0, (nT(z) + nB(z)) / 2, z)), a = nr.cross(tg).normalize();
        rings.push([po.clone().addScaledVector(a, -w), po.clone().addScaledVector(a, w), pin.clone().addScaledVector(a, w * 0.8), pin.clone().addScaledVector(a, -w * 0.8)]); }
      bR.add(fdLoftUV(ringLoft(rings, true, true), 4, rings.length, FDA.post), A);
    }
    // the sliding windows' latch handles, on their aft frames
    for (const sx of [-1, 1]) { const z = WPOST2 - 0.05, th = sx * thAt(z, 1.22), p0 = nosePt(z, th, K - 0.01), p1 = nosePt(z - 0.05, th, K - 0.05); nbR.add(bar(p0, p1, 0.02, 0.02, true, 6), kit.black); nbR.add(bar(p1, p1.clone().add(V(-sx * 0.0, -0.09, 0.0)), 0.022, 0.022, true, 6), kit.black); }
  }
  // floor: blue-grey carpet, and each seat's tracks
  b.add(fdBox(2.2, 0.05, 2.3, FDA.carpet, mx([0, -0.12, -2.65])), A);
  for (const sx of [-1, 1]) for (const dx of [-0.13, 0.13]) b.add(bar(V(sx * 0.55 + dx, FLOOR + 0.012, -2.86), V(sx * 0.55 + dx, FLOOR + 0.012, -1.86), 0.035, 0.024), kit.alu);
  // back bulkhead with the flight-deck door in its frame, circuit-breaker panels either side
  { const bp = [0, 0, -1.5 + DZ]; for (let i = 0; i <= 48; i++) bp.push(...nosePt(-1.5 + DZ, (i / 48) * Math.PI * 2, K + 0.01).toArray()); // (the nose's section where it stands)
    const bk = new THREE.BufferGeometry(); bk.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); bk.setIndex(Array.from({ length: 48 }, (_, i) => [0, i + 1, i + 2]).flat()); // (facing the deck) bk.computeVertexNormals();
    { const P = bk.attributes.position, uv = []; for (let i = 0; i < P.count; i++) uv.push(0.5 + P.getX(i) / 4, 0.5 + P.getY(i) / 4); bk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); } bR.add(fdUV(bk, FDA.bulk), A);
    b.add(fdBox(0.74, 1.84, 0.03, 'door', mx([0, FLOOR + 0.92, -1.52])), A);
    b.add(fdQuad(V(0.36, FLOOR + 0.01, -1.536), V(-0.36, FLOOR + 0.01, -1.536), V(-0.36, FLOOR + 1.83, -1.536), V(0.36, FLOOR + 1.83, -1.536), FDA.door, V(0, 0, -1)), A);
    for (const [x, w] of [[-0.4, 0.06], [0.4, 0.06]]) b.add(fdBox(w, 1.9, 0.05, FDA.post, mx([x, FLOOR + 0.95, -1.52])), A);
    b.add(fdBox(0.86, 0.06, 0.05, FDA.post, mx([0, FLOOR + 1.9, -1.52])), A);
    nb.add(bar(V(-0.28, FLOOR + 1.0, -1.56), V(-0.14, FLOOR + 1.0, -1.56), 0.022, 0.022, true, 8), kit.alu); nb.add(bar(V(-0.28, FLOOR + 1.0, -1.537), V(-0.28, FLOOR + 1.0, -1.565), 0.02, 0.02, true, 6), kit.alu);
    for (const sx of [-1, 1]) b.add(fdQuad(V(sx * 0.52, 0.5, -1.504), V(sx * 1.02, 0.5, -1.504), V(sx * 1.02, 1.28, -1.504), V(sx * 0.52, 1.28, -1.504), FDA.cb, V(0, 0, -1)), A); }
  // main instrument panel (the pf plane: tilted back 0.3 at its top): side sections full height, the centre one only above
  // the pedestal; four displays (captain's PFD and ND, the engine display and the first officer's PFD) in bezels, the
  // standby instrument and landing-gear lever between them, knob strips below; outboard panels angled towards each pilot
  const pf = mx([0, 0.46, -3.3], [-0.3, 0, 0]), P = (x, y, z) => pf.clone().multiply(mx([x, y, z]));
  for (const sx of [-1, 1]) b.add(fdBox(0.61, 0.42, 0.06, FDA.face, P(sx * 0.495, 0, 0)), A);
  b.add(fdBox(0.38, 0.285, 0.06, FDA.face, P(0, 0.0675, 0)), A);
  const glassM = fdGlassMat(), screenAt = (cx, cy, w, h, r) => { // (the screen sunk 6 mm in its bezel, glass over it)
    const W = w / 0.87, H = h / 0.83, bz = fdBezel(W, H, w, h, 0.006, 0.044); bz.applyMatrix4(P(cx, cy, 0)); b.add(bz, A);
    const s = fdUV(new THREE.PlaneGeometry(w, h), r); s.applyMatrix4(P(cx, cy, 0.038)); b.add(s, A); const gl = new THREE.PlaneGeometry(w, h); gl.applyMatrix4(P(cx, cy, 0.0395)); nb.add(gl, glassM); };
  screenAt(-0.51, 0.025, 0.26, 0.2, FDA.pfd); screenAt(-0.215, 0.025, 0.26, 0.2, FDA.nd); screenAt(0.215, 0.025, 0.26, 0.2, FDA.eng); screenAt(0.51, 0.025, 0.26, 0.2, FDA.pfd);
  screenAt(0, 0.09, 0.07, 0.07, FDA.isfd);
  { const s = fdUV(new THREE.PlaneGeometry(0.1, 0.14), FDA.gear); s.applyMatrix4(P(0, -0.0, 0.0305)); b.add(s, A);
    nb.add(bar(V(0, 0, 0).applyMatrix4(P(0.022, -0.035, 0.03)), V(0, 0, 0).applyMatrix4(P(0.022, -0.02, 0.1)), 0.012, 0.012, true, 6), kit.alu); // the gear lever and its wheel-shaped knob
    const kn = new THREE.CylinderGeometry(0.022, 0.022, 0.014, 14); kn.rotateX(Math.PI / 2); kn.applyMatrix4(P(0.022, -0.02, 0.1)); nb.add(kn, kit.chrome); }
  for (const sx of [-1, 1]) { const s = fdUV(new THREE.PlaneGeometry(0.6, 0.1), sx < 0 ? FDA.lowL : FDA.lowR); s.applyMatrix4(P(sx * 0.495, -0.155, 0.0305)); b.add(s, A);
    for (let k = 0; k < 8; k++) if (k % 3 !== 1) { const kn = new THREE.CylinderGeometry(0.009, 0.01, 0.014, 10); kn.rotateX(Math.PI / 2); const u = sx < 0 ? 32 + k * 62 : 480 - k * 62; kn.applyMatrix4(P(sx * 0.495 + (u / 512 - 0.5) * 0.6, -0.155 + (0.5 - 28 / 64) * 0.1, 0.037)); nb.add(kn, kit.black); } }
  const wings = [];
  for (const sx of [-1, 1]) { const wm = pf.clone().multiply(mx([sx * 0.8, 0, 0], [0, -sx * 0.55, 0])).multiply(mx([sx * 0.13, 0, 0])); wings.push(wm);
    b.add(fdBox(0.26, 0.42, 0.06, FDA.face, wm), A); const s = fdUV(new THREE.PlaneGeometry(0.24, 0.12), FDA.outb); s.applyMatrix4(wm.clone().multiply(mx([0, 0.06, 0.0305]))); b.add(s, A); }
  // under the panel, the toe board (where the rudder pedals and the columns go into the floor), dark
  const toe = { a: V(0, FLOOR, -3.52), b: V(0, 0.27, -3.235) };
  b.add(fdQuad(V(-1.0, toe.a.y, toe.a.z), V(1.0, toe.a.y, toe.a.z), V(1.0, toe.b.y, toe.b.z), V(-1.0, toe.b.y, toe.b.z), FDA.plateC, V(0, 0.6, 1)), A);
  // glare shield: a flat anti-glare top out to the windscreen (its outline follows the lining), with the mode control panel
  // and the two EFIS control panels along its aft face, a padded lip
  const GZ = -3.255, GY0 = 0.65, GY1 = 0.75;
  { const hw = (z) => Math.max(0, secHW(z, GY1) - 0.012); let zt = GZ; while (hw(zt - 0.005) > 0.04 && zt > -3.9) zt -= 0.005;
    const sh = new THREE.Shape(), N = 18; sh.moveTo(-hw(GZ), -GZ); for (let i = 0; i <= N; i++) { const z = GZ + (zt - GZ) * (i / N); sh.lineTo(-hw(z), -z); } for (let i = N; i >= 0; i--) { const z = GZ + (zt - GZ) * (i / N); sh.lineTo(hw(z), -z); }
    const gs = new THREE.ExtrudeGeometry(sh, { depth: GY1 - GY0, bevelEnabled: false, curveSegments: 4 }); gs.rotateX(-Math.PI / 2); gs.translate(0, GY0, 0); b.add(fdTriUV(gs, FDA.fabric), A);
    const lip = new THREE.CylinderGeometry(0.018, 0.018, 2 * hw(GZ) - 0.02, 10); lip.rotateZ(Math.PI / 2); lip.translate(0, GY1 - 0.012, GZ + 0.004); b.add(fdUV(lip, FDA.fabric), A);
    b.add(fdBox(0.8, 0.08, 0.025, FDA.plateB, mx([0, 0.69, GZ + 0.0125])), A); { const s = fdUV(new THREE.PlaneGeometry(0.8, 0.08), FDA.mcp); s.translate(0, 0.69, GZ + 0.0255); b.add(s, A); }
    for (const [u0, u1] of MCP_WIN) { const kn = new THREE.CylinderGeometry(0.011, 0.012, 0.018, 12); kn.rotateX(Math.PI / 2); kn.translate(-0.4 + ((u0 + u1) / 2) * 0.8, 0.69 - 0.022, GZ + 0.034); nb.add(kn, kit.black); }
    for (const sx of [-1, 1]) { b.add(fdBox(0.22, 0.08, 0.025, FDA.plateB, mx([sx * 0.585, 0.69, GZ + 0.0125])), A); const s = fdUV(new THREE.PlaneGeometry(0.22, 0.08), FDA.efis); s.translate(sx * 0.585, 0.69, GZ + 0.0255); b.add(s, A);
      for (const dx of [-0.068, 0.068]) { const kn = new THREE.CylinderGeometry(0.013, 0.014, 0.02, 12); kn.rotateX(Math.PI / 2); kn.translate(sx * 0.585 + dx, 0.69 - 0.006, GZ + 0.035); nb.add(kn, kit.black); } }
    // the standby compass at the top of the centre post
    { const z = zOn(0, WTOPY) + 0.06 - DZ, y = topY(z, 0) - 0.05; nb.add(fdBox(0.07, 0.06, 0.07, 'knob', mx([0, y, z])), A); nb.add(bar(V(0, y + 0.03, z), V(0, topY(z, 0) + 0.01, z), 0.02, 0.02), kit.dark); }
  }
  // overhead panel: a box hung under the crown from just behind the windscreen's top back over the seats, sloping up aft
  // with the crown (a 737's starts right at the windscreen's top: it is the deck's ceiling there), its face full of switch
  // panels (the toggles stand out of it), grab handles at its front corners
  const OVH = { ZF: -2.85, ZA: -1.72, D: 0.16 };
  { const { ZF, ZA, D } = OVH, X = 0.36, yt = (z) => topY(z, X) - 0.006, yb = (z) => yt(ZF) - D + (yt(ZA) - yt(ZF)) * (z - ZF) / (ZA - ZF);
    OVH.y0 = yb(ZF); OVH.y1 = topY(ZA, 0);
    const c = { lfb: V(-X, yb(ZF), ZF), rfb: V(X, yb(ZF), ZF), lab: V(-X, yb(ZA), ZA), rab: V(X, yb(ZA), ZA), lft: V(-X, yt(ZF), ZF), rft: V(X, yt(ZF), ZF), lat: V(-X, yt(ZA), ZA), rat: V(X, yt(ZA), ZA) };
    b.add(fdQuad(c.lfb, c.rfb, c.rab, c.lab, FDA.ovh, V(0, -1, 0.2)), A); // (its lettering's top towards the back: upright to a pilot looking up)
    for (const sx of [-1, 1]) { const [f, a2, ft, at] = sx < 0 ? [c.lfb, c.lab, c.lft, c.lat] : [c.rfb, c.rab, c.rft, c.rat]; b.add(fdQuad(a2, f, ft, at, FDA.plateB, V(sx, 0, 0)), A); }
    b.add(fdQuad(c.lfb, c.rfb, c.rft, c.lft, FDA.plateB, V(0, 0, -1)), A); b.add(fdQuad(c.lab, c.rab, c.rat, c.lat, FDA.plateB, V(0, 0, 1)), A);
    const L = overheadLayout(), du = c.rfb.clone().sub(c.lfb), dv = c.lab.clone().sub(c.lfb), n = du.clone().cross(dv).normalize(); if (n.y > 0) n.negate();
    for (const [u, v, guard] of L.sw) { const p0 = c.lfb.clone().addScaledVector(du, u).addScaledVector(dv, v), p1 = p0.clone().addScaledVector(n, 0.017).add(V(0, 0, -0.004));
      nb.add(bar(p0, p1, 0.0045, 0.0045, true, 5), kit.chrome); nb.add(fdBox(0.008, 0.008, 0.008, guard ? 'red' : 'cream', mx(p1.toArray())), A); }
    for (const sx of [-1, 1]) { const x = sx * 0.43, z0 = -2.56, z1 = -2.4, y0 = topY(-2.48, x) - 0.01; nb.add(pipe([V(x, y0, z0), V(x, y0 - 0.06, z0 + 0.01), V(x, y0 - 0.07, (z0 + z1) / 2), V(x, y0 - 0.06, z1 - 0.01), V(x, y0, z1)], 0.011, 6, 24), kit.black); }
  }
  // centre pedestal (the 737's): the two CDUs on its sloping front under the displays, the throttle quadrant (thrust levers,
  // start levers, speed brake on the left, flap lever on the right, the stabiliser trim wheels on its sides), radios aft
  const PX = 0.19, prof = [[-2.0, FLOOR], [-2.0, 0.25], [-2.6, 0.285], [-2.64, 0.31], [-2.72, 0.335], [-2.84, 0.345], [-2.96, 0.335], [-3.02, 0.31], [-3.04, 0.27], [-3.28, 0.39], [-3.3, 0.39], [-3.3, FLOOR]];
  { const sh = new THREE.Shape(); prof.forEach(([z, y], i) => (i ? sh.lineTo(-z, y) : sh.moveTo(-z, y)));
    const pg = new THREE.ExtrudeGeometry(sh, { depth: 2 * PX, bevelEnabled: false }); pg.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, -1), V(0, 1, 0), V(1, 0, 0))); pg.translate(-PX, 0, 0); b.add(fdTriUV(pg, FDA.worn), A); // (worn pale along its top edges, where hands go)
    const sl = Math.atan2(0.12, 0.24), cm = (x) => mx([x, 0.33 + Math.cos(sl) * 0.016, -3.16 + Math.sin(sl) * 0.016], [-(Math.PI / 2 - sl), 0, 0]);
    for (const sx of [-1, 1]) { b.add(fdBox(0.145, 0.25, 0.03, FDA.plateC, cm(sx * 0.0925)), A); const s = fdUV(new THREE.PlaneGeometry(0.14, 0.245), FDA.cdu); s.applyMatrix4(cm(sx * 0.0925).multiply(mx([0, 0, 0.0155]))); b.add(s, A); }
    b.add(fdQuad(V(-0.18, 0.253, -2.02), V(0.18, 0.253, -2.02), V(0.18, 0.288, -2.59), V(-0.18, 0.288, -2.59), FDA.radio, V(0, 1, 0)), A);
    for (const x of [-0.05, 0.05]) b.add(fdBox(0.012, 0.004, 0.2, 'knob', mx([x, 0.344, -2.83])), A); // (the thrust levers' slots)
    // thrust levers with their knobs, reverser levers piggybacking, start levers aft of them
    for (const x of [-0.05, 0.05]) { const p0 = V(x, 0.3, -2.86), p1 = V(x, 0.47, -2.79); nb.add(bar(p0, p1, 0.016, 0.012), kit.alu); b.add(fdBox(0.05, 0.032, 0.04, 'knob', mx([x + (x < 0 ? -0.006 : 0.006), 0.478, -2.786], [0.4, 0, 0])), A);
      nb.add(bar(V(x, 0.34, -2.83), V(x, 0.4, -2.86), 0.01, 0.01), kit.black); nb.add(bar(V(x * 0.8, 0.31, -2.68), V(x * 0.8, 0.36, -2.66), 0.008, 0.012), kit.dark); b.add(fdBox(0.016, 0.024, 0.02, 'white', mx([x * 0.8, 0.37, -2.66])), A); }
    nb.add(bar(V(-0.15, 0.31, -2.88), V(-0.15, 0.43, -2.82), 0.012, 0.012), kit.alu); nb.add(bar(V(-0.18, 0.435, -2.82), V(-0.12, 0.435, -2.82), 0.016, 0.016, true, 8), kit.alu); // speed brake
    nb.add(bar(V(0.15, 0.31, -2.86), V(0.15, 0.42, -2.86), 0.012, 0.012), kit.alu); b.add(fdBox(0.06, 0.022, 0.035, 'white', mx([0.15, 0.43, -2.86])), A); // flap lever
    for (const sx of [-1, 1]) { const tw = new THREE.CylinderGeometry(0.12, 0.12, 0.035, 28); tw.rotateZ(Math.PI / 2); tw.translate(sx * 0.205, 0.17, -2.82); b.add(fdUV(tw, 'knob'), A);
      for (const a0 of [0.4, 2.5, 4.6]) b.add(fdBox(0.004, 0.06, 0.012, 'white', mx([sx * 0.2235, 0.17 + Math.cos(a0) * 0.085, -2.82 + Math.sin(a0) * 0.085], [a0, 0, 0])), A); } // (white stripes, so you see them spin)
  }
  // side consoles along the walls: the nose-wheel tillers (a 747 has one each side), oxygen mask boxes, audio panels
  for (const sx of [-1, 1]) {
    const XI = 0.9, YT = 0.42, rings = [], zz = [-3.12, -2.82, -2.5, -2.2, -1.95];
    for (const z of zz) { const xo = Math.max(XI + 0.05, secHW(z, YT) - 0.008); rings.push([V(sx * XI, FLOOR, z), V(sx * XI, YT, z), V(sx * xo, YT, z), V(sx * xo, FLOOR, z)]); }
    b.add(fdTriUV(ringLoft(rings, true, true), FDA.plateA, true), A);
    b.add(fdBox(0.02, 0.2, 0.62, FDA.leather, mx([sx * (XI - 0.01), 0.17, -2.45])), A); // (a chart pocket on its inner face)
    { const xo = secHW(-2.2, YT) - 0.02; b.add(fdQuad(V(sx * XI, YT + 0.002, -1.97), V(sx * xo, YT + 0.002, -1.97), V(sx * xo, YT + 0.002, -3.1), V(sx * XI, YT + 0.002, -3.1), FDA.side, V(0, 1, 0)), A); }
    b.add(fdBox(0.13, 0.07, 0.17, FDA.shell, mx([sx * 1.02, YT + 0.035, -2.38])), A); b.add(fdBox(0.05, 0.012, 0.03, 'yellow', mx([sx * 0.98, YT + 0.075, -2.32])), A);
    { const tz = -2.96, ty = YT + 0.03; const tl = new THREE.TorusGeometry(0.055, 0.009, 6, 20); tl.rotateX(Math.PI / 2 - 0.25); tl.translate(sx * 1.0, ty + 0.02, tz); b.add(fdUV(tl, 'knob'), A);
      nb.add(bar(V(sx * 1.0, ty - 0.03, tz), V(sx * 1.0, ty + 0.02, tz), 0.02, 0.02, true, 8), kit.dark); nb.add(bar(V(sx * 1.045, ty + 0.03, tz), V(sx * 1.045, ty + 0.06, tz), 0.014, 0.014, true, 6), kit.black); }
  }
  // the crew seats: upholstered shells under fleece covers, on a frame over a base on floor tracks; headrest, armrests
  for (const sx of [-1, 1]) {
    const sb = shift(new Bag()), X = sx * 0.55, st = seatGeo(...SEAT); st.translate(X, SY, SZ); sb.add(fdTriUV(st, FDA.fleece, false, true), A);
    const tilt = SEAT[3], up = (h, dz = 0) => [X, SY + h * Math.cos(tilt), SZ + h * Math.sin(tilt) + dz];
    const hr = new THREE.CapsuleGeometry(0.07, 0.16, 4, 10); hr.rotateZ(Math.PI / 2); hr.scale(1, 1, 0.55); hr.rotateX(tilt); hr.translate(...up(0.82, 0.075)); sb.add(fdTriUV(hr, FDA.fleece, false, true), A);
    sb.add(fdBox(0.46, 0.74, 0.05, FDA.shell, mx(up(0.38, 0.09), [tilt, 0, 0])), A); // (the seat back's hard shell)
    sb.add(fdBox(0.08, 0.2, 0.05, FDA.shell, mx(up(0.8, 0.12), [tilt, 0, 0])), A); // (the headrest's stem)
    sb.add(fdBox(0.44, 0.07, 0.44, FDA.shell, mx([X, SY - 0.05, SZ - 0.2])), A); // (pan frame)
    for (const side of [-1, 1]) { sb.add(fdBox(0.025, 0.07, 0.42, FDA.leather, mx([X + side * 0.235, SY - 0.02, SZ - 0.2])), A); } // (the cushion's leather sides)
    for (const side of [-1, 1]) { const ax = X + side * 0.29; sb.add(fdBox(0.05, 0.05, 0.3, FDA.leather, mx([ax, SY + 0.2, SZ - 0.13])), A); sb.add(fdBox(0.03, 0.2, 0.04, FDA.shell, mx([ax, SY + 0.09, SZ + 0.04], [0.15, 0, 0])), A); }
    { const n0 = g.children.length; sb.to(g); for (const m of g.children.slice(n0)) m.userData.seatRail = sx === 1 ? 0 : 1; } // (the seats' order below)
    const bh = SY - 0.09 - FLOOR; b.add(fdBox(0.36, bh, 0.36, FDA.plateC, mx([X, FLOOR + bh / 2, SZ - 0.22])), A);
    for (const dx of [-0.13, 0.13]) b.add(fdBox(0.05, 0.03, 0.42, 'shell', mx([X + dx, FLOOR + 0.03, SZ - 0.22])), A);
  }
  // sun visors (fabric over a stiff board, in a binding): pulled part-way down over the top of each sliding window, and stowed
  // up against the lining behind the front windows' top edge, on their rails
  const visor = (sx, th0, th1, z0f, z1f, k) => { const pos = [], uv = [], idx = [], NU = 6;
    for (let i = 0; i <= NU; i++) for (const [j, zf] of [[0, z0f], [1, z1f]]) { const th = sx * (th0 + (th1 - th0) * (i / NU)), p = nosePt(zf(th), th, k); pos.push(p.x, p.y, p.z); uv.push(i / NU, j); }
    for (let i = 0; i < NU; i++) { const a = i * 2, c = a + 2; idx.push(a, c, c + 1, a, c + 1, a + 1, a, c + 1, c, a, a + 1, c + 1); } // (both faces)
    const v = new THREE.BufferGeometry(); v.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); v.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); v.setIndex(idx); v.computeVertexNormals(); nbR.add(fdUV(v, FDA.visor), A);
    const r0 = nosePt(z0f(sx * th0), sx * th0, k + 0.005), r1 = nosePt(z0f(sx * th1), sx * th1, k + 0.005); nbR.add(bar(r0, r1, 0.012, 0.012, true, 6), kit.dark); };
  const zTop = (th) => zOn(th, WTOPY);
  for (const sx of [-1, 1]) { visor(sx, WPOST1 + 0.04, 0.72, (th) => zTop(th) + 0.005, (th) => zTop(th) - 0.14, K - 0.03); visor(sx, 0.12, 0.45, (th) => zTop(th) + 0.03, (th) => zTop(th) + 0.2, K - 0.012); }
  // what the crew must keep clear of
  const tb =new THREE.Matrix4().compose(toe.a.clone().add(toe.b).multiplyScalar(0.5).add(V(0, 0, -0.012)), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), toe.b.clone().sub(toe.a).normalize()), V(1, 1, 1));
  return [boxObstacle('panel', pf, [1.6, 0.42, 0.06]), boxObstacle('panel L', wings[0], [0.26, 0.42, 0.06]), boxObstacle('panel R', wings[1], [0.26, 0.42, 0.06]),
    { name: 'glare shield', box: [0, (GY0 + GY1) / 2, GZ - 0.19], size: [1.84, GY1 - GY0 + 0.01, 0.38] },
    { name: 'pedestal', box: [0, (FLOOR + 0.4) / 2, -3.0], size: [0.48, 0.4 - FLOOR, 0.6] }, { name: 'pedestal aft', box: [0, (FLOOR + 0.3) / 2, -2.35], size: [0.4, 0.3 - FLOOR, 0.7] },
    { name: 'thrust levers', box: [0, 0.4, -2.8], size: [0.36, 0.17, 0.24] },
    { name: 'console L', box: [-1.25, (FLOOR + 0.5) / 2, -2.53], size: [0.7, 0.5 - FLOOR, 1.2] }, { name: 'console R', box: [1.25, (FLOOR + 0.5) / 2, -2.53], size: [0.7, 0.5 - FLOOR, 1.2] },
    { name: 'overhead', box: [0, (OVH.y0 + OVH.y1) / 2, (OVH.ZF + OVH.ZA) / 2], size: [0.76, OVH.y1 - OVH.y0, OVH.ZA - OVH.ZF] }, boxObstacle('toe board', tb, [2.0, toe.b.distanceTo(toe.a), 0.024])].map((o) => ({ ...o, box: [o.box[0], o.box[1] + DY, o.box[2] + DZ] }));
}
export function airlinerNoseBuild(color, skinMat) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), black = M.black();
  // skin grid: dense rings round the windscreen, coarser elsewhere
  const zs = []; for (let z = -4.6; z < -4.2; z += 0.05) zs.push(z); for (let z = -4.2; z < -1.0; z += 0.05) zs.push(z); for (let z = -1.0; z < -0.001; z += 0.2) zs.push(z); zs.push(0);
  const SEG = 96, row = SEG + 1, circ = 2 * Math.PI * 1.9, pos = [], uv = [], uv1 = [], idx = [];
  for (const z of zs) for (let i = 0; i <= SEG; i++) { const th = (i / SEG) * Math.PI * 2, p = nosePt(z, th > Math.PI ? th - Math.PI * 2 : th); pos.push(p.x, p.y, p.z); uv.push((z + 4.6) / 4.6, i / SEG); uv1.push(z, (i / SEG) * circ); }
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < SEG; i++) { const a = j * row + i, c = (j + 1) * row + i; idx.push(a, c, c + 1, a, c + 1, a + 1); }
  { const ci = pos.length / 3; pos.push(0, 0, 0); uv.push(1, 0.5); uv1.push(0, 0); const j = zs.length - 1; for (let i = 0; i < SEG; i++) idx.push(ci, j * row + i + 1, j * row + i); }
  const sk = new THREE.BufferGeometry(); sk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); sk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); sk.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2)); sk.setIndex(idx); sk.computeVertexNormals(); fixNormals(sk);
  // the glazing is cut out of the skin exactly along the outline (clipGeometry); the glass is the cut-out piece, set
  // in a little
  const P = sk.attributes.position, N = sk.attributes.normal, val = new Float32Array(P.count), neg = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { const z = P.getZ(i), T = nT(z), B = nB(z), mid = (T + B) / 2, dy = P.getY(i) - mid, th = Math.atan2(P.getX(i) / Math.max(1e-4, nW(z)), dy / Math.max(1e-4, dy >= 0 ? T - mid : mid - B)); val[i] = z > -1.0 || z < -4.0 ? -1 : winVal(z, th); neg[i] = -val[i]; }
  const skin = new THREE.Mesh(clipGeometry(sk, neg) || sk, skinMat); skin.userData.openOk = 'flight-deck windows: glazed'; g.add(skin);
  const glass = clipGeometry(sk, val);
  if (glass) { const gp = glass.attributes.position, gn = glass.attributes.normal; for (let i = 0; i < gp.count; i++) gp.setXYZ(i, gp.getX(i) - gn.getX(i) * 0.012, gp.getY(i) - gn.getY(i) * 0.012, gp.getZ(i) - gn.getZ(i) * 0.012); g.add(new THREE.Mesh(glass, flightDeckGlass())); }
  // frames: the outline (traced along the cut) and the posts between the six panes, black like an airline's window mask
  const lift = (p, th, d = 0.006) => { const q = nosePt(p.z, th, 1); const n = q.clone().sub(V(0, (nT(p.z) + nB(p.z)) / 2, p.z)).normalize(); return p.clone().addScaledVector(n, d); };
  const edgeZ = (th) => zOn(th, SILL); // (sill crossing at this azimuth)
  const loop = winOutline(30).map(([z, th]) => lift(nosePt(z, th), th));
  const fb = new Bag(); // (the window frames: their own mesh, so the seam check can tell them from the skin)
  fb.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, true, 'centripetal'), 220, 0.032, 6, true), black);
  for (const [pi, post] of winPosts().entries()) fb.add(pipe(post.map(([z, th]) => lift(nosePt(z, th), th)), pi ? 0.03 : 0.04, 6, 24), black);
  { const n0 = g.children.length; fb.to(g); for (const m of g.children.slice(n0)) m.userData.trim = 'window frames round the flight-deck glazing'; }
  // wipers parked along the bottom of the two front panes
  for (const sx of [-1, 1]) { const a = sx * 0.06, c = sx * 0.34; nb.add(tube([lift(nosePt(edgeZ(a) - 0.03, a), a, 0.006), lift(nosePt(edgeZ(a) + 0.05, a), a, 0.02), lift(nosePt(edgeZ(c) + 0.08, c), c, 0.02)], 0.012, 4, 8), black); } // (from a pivot on the skin below the glass: they lay on the glass)
  // radome seam, pitot probes, static ports
  { const pts = []; for (let i = 0; i < 48; i++) { const th = (i / 48) * Math.PI * 2; pts.push(lift(nosePt(-4.12, th), th, 0.003)); } b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, 0.005, 4, true), M.darkMetal()); }
  const alu = M.aluminum();
  for (const sx of [-1, 1]) {
    const pb = lift(nosePt(-3.25, sx * 1.75), sx * 1.75, 0);
    nb.add(bar(pb, pb.clone().add(V(sx * 0.13, -0.03, 0)), 0.03, 0.03, true, 6), alu);
    nb.add(bar(pb.clone().add(V(sx * 0.13, -0.03, 0.02)), pb.clone().add(V(sx * 0.13, -0.03, -0.22)), 0.022, 0.022, true, 6), alu);
    const sp = lift(nosePt(-2.4, sx * 1.5), sx * 1.5, 0.004), d = new THREE.CircleGeometry(0.05, 12); d.applyMatrix4(new THREE.Matrix4().compose(sp, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), V(sx, 0.07, 0).normalize()), V(1, 1, 1))); nb.add(d, alu);
  }
  // flight deck (airlinerFlightDeck): lining, window reveals, panel, glare shield, overhead, pedestal, consoles, seats
  // (the deck is laid out round floor top -0.095 and seats at z -2.3, and set down DY and aft DZ into the nose: its floor
  // 0.6 under the fuselage axis, like a 737's, the pilots' eyes beside the sliding windows)
  const DY = -0.5, DZ = 0.4, SEAT = [0.5, 0.75, 0.48, 0.2]; // (seatGeo's dims: a cushion 42 cm over the floor, an airliner seat's height)
  const deck = airlinerFlightDeck(g, b, nb, { SY: 0.24, SZ: -2.3, SEAT, FLOOR: -0.095, zs, DY, DZ });
  const FLOOR = -0.095 + DY, SY = 0.24 + DY, SZ = -2.3 + DZ; // (floor top; seatGeo's origin height, z: where they ended up)
  b.to(g); nb.to(g, true);
  // each seat declares its cushion and back (seatGeo's, as placed above), the floor, and the feet on the rudder pedals
  // (drawn by crew.js, hinged on the floor under the panel)
  g.userData.seats = [1, -1].map((sx) => { const p = [sx * 0.55, SY + 0.04, SZ - 0.24];
    return { p, s: 1, fit: { at: [sx * 0.55, SY, SZ], dims: SEAT, floor: FLOOR, feet: 'pedals' }, controls: {
      pedY: FLOOR - p[1], pedZ: -3.03 + DZ - p[2], // rudder pedals under the panel, hinged at the floor
      colBase: [0, FLOOR - p[1], -0.62], colLen: 0.75, // the column pivots in the floor (the generic one stopped 7 cm over it), the yoke clear of the knees
    }, adjust: { pedZ: [-0.06, 0.08], seatZ: [-0.08, 0.08], seatY: [-0.03, 0.05] } }; }); // (an airliner's pedals adjust, and its seats run on rails, fore and aft and up and down; the yoke doesn't)
  // what each pilot must keep clear of: inside the lining (the nose's sections at 0.97), and the deck's furniture
  for (const st of g.userData.seats) st.obstacles = [{ name: 'lining', below: 'mirror', inside: insideRows(-4.0, -1.5 + DZ, 50, (z) => [nW(z) * 0.97, (nT(z) - nB(z)) / 2 * 0.97, (nT(z) + nB(z)) / 2]) }, ...deck];
  g.userData.cabinDeep = true; // (cabinLight: a deep, enclosed deck, lit only through its band of windows)
  // the deck's own lamps, lit at night (cabinLight bakes them; deck coordinates, set down with it): the dome light aft of the
  // overhead (a big diffuser: r), the overhead's flood from the glare shield, the panel floods under the glare shield's lip,
  // the pedestal flood under the overhead's front, and each pilot's map light on the side wall, aimed at the lap and the
  // yoke's chart clip. [position, aim, cone (cos), strength, size]
  const lamp = (p, d, cone, k, r) => ({ p: [p[0], p[1] + DY, p[2] + DZ], d: d && V(...d).normalize().toArray(), cone, k, r });
  g.userData.cabinLamps = [lamp([0, 1.78, -1.62], [0, -1, 0], [-0.2, 0.3], 0.6, 0.6), lamp([0, 0.8, -3.15], [0, 0.8, 0.6], [0.4, 0.8], 0.25, 0.15), lamp([0, 1.2, -2.7], [0, -1, -0.2], [0.6, 0.9], 0.12),
    ...[-1, 1].flatMap((sx) => [lamp([sx * 0.45, 0.62, -3.1], [0, -0.87, -0.49], [0.3, 0.75], 0.2), lamp([sx * 0.98, 1.1, -2.62], [-sx * 0.43, -0.55, -0.13], [0.75, 0.92], 0.08)])];
  g.userData.tube = { z0: -4.6, z1: 0, sec: (z) => { const T = nT(z), B = nB(z); return [(T + B) / 2, nW(z), (T - B) / 2]; } }; // its section, for skinBlend's seam with the tube behind
  return g;
}
// Helicopter rotor head: grips, pitch links, swashplate.
export function rotorDetail(g, { R, blades, chord, mast }) {
  if (!mast) return;
  const b = new Bag(), nb = new Bag();
  const sw = new THREE.CylinderGeometry(chord * 0.75, chord * 0.75, 0.05, 18); sw.translate(0, mast * 0.72, 0); b.add(sw, M.steel());
  const sw2 = new THREE.CylinderGeometry(chord * 0.6, chord * 0.6, 0.04, 18); sw2.translate(0, mast * 0.78, 0); b.add(sw2, M.aluminum());
  for (let i = 0; i < blades; i++) { const a = (i / blades) * Math.PI * 2 + 0.4; nb.add(bar(V(Math.cos(a) * chord * 0.55, mast * 0.8, Math.sin(a) * chord * 0.55), V(Math.cos(a) * chord * 0.5, mast * 0.98, Math.sin(a) * chord * 0.5), 0.02, 0.02, true, 5), M.steel()); }
  b.to(g); nb.to(g, true); void R;
}

// Streamlined strut with clevis fittings at both ends.
export function strutDetail(g, color) {
  for (const c of g.children.slice()) g.remove(c);
  const b = new Bag(), nb = new Bag();
  const s = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12); s.scale(0.65, 1, 1.5); b.add(s, PM.skin(color));
  for (const sy of [-1, 1]) {
    const f = new THREE.BoxGeometry(0.035, 0.12, 0.08); f.translate(0, sy * 0.78, 0); b.add(f, PM.metal('anodised'));
    const bolt = new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6); bolt.rotateZ(Math.PI / 2); bolt.translate(0, sy * 0.8, 0); nb.add(bolt, M.steel());
  }
  b.to(g); nb.to(g, true);
}

// ---------- small fittings: greenhouse nose, electric fan motor, landing and position lights, pylon ----------
const _pdm = new Map();
const pdMat = (k, make) => { if (!_pdm.has(k)) _pdm.set(k, make()); return _pdm.get(k); };
// polished reflector (seen from inside a lamp bowl): mirror metal on both faces
const mirrorMat = () => pdMat('mirror', () => new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 1, roughness: 0.06, side: THREE.DoubleSide }));
// padded leather (cockpit coamings, cushions)
export const leatherMat = (c = 0x4a2e1c) => pdMat('leather' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.62 }));

// Greenhouse nose (ck_glassnose detail): the same dome as the plain part (radius 0.7 at the base ring, 0.98 long, looking
// forward along -z), glazed with real canopy glass and framed like a bomber's nose: meridian frames from the base ring to a
// nose ring and two hoops across them, so the glass reads as panes (the plain part's rings floated in the air), and a
// ball-mounted gun in the nose ring. Inside, behind the glass: a floor, the bomb aimer's cushion, a bombsight, an ammunition
// box and the gun's breech; a bulkhead closes the back. A hidden skirt behind the base is shown and trimmed by skinBlend
// when the nose is seated on a body.
export function glassNoseBuild(color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = PM.skin(color), R = 0.7, L = 0.98, dark = M.darkMetal(), tint = 0x2f4656;
  const P = (psi, phi, t = 0) => V((R + t) * Math.sin(psi) * Math.cos(phi), (R + t) * Math.sin(psi) * Math.sin(phi), -(L + t) * Math.cos(psi));
  const dome = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2); dome.rotateX(-Math.PI / 2); dome.scale(R, R, L);
  g.add(new THREE.Mesh(dome, PM.canopy(tint)));
  const skirt = new THREE.CylinderGeometry(1, 1, 0.5, 48, 1, true); skirt.rotateX(Math.PI / 2); skirt.scale(R, R, 1); skirt.translate(0, 0, 0.25);
  const sk = new THREE.Mesh(skirt, PM.canopy(tint)); sk.visible = false; sk.userData.glassSkirt = true; g.add(sk);
  const psiTip = 0.3, NR = 10, fr = 0.017;
  for (let k = 0; k < NR; k++) { // meridian frames, base ring to nose ring
    const phi = (k / NR) * Math.PI * 2 + Math.PI / 2, pts = [];
    for (let i = 0; i <= 10; i++) pts.push(P(psiTip + (Math.PI / 2 - psiTip) * (i / 10), phi, fr * 0.6));
    b.add(pipe(pts, fr, 6, 30), paint);
  }
  for (const [psi, r] of [[0.95, 0.014], [1.3, 0.014], [Math.PI / 2, 0.03], [psiTip, 0.024]]) { // hoops, base ring, nose ring
    const pts = []; for (let i = 0; i < 40; i++) pts.push(P(psi, (i / 40) * Math.PI * 2, r * 0.6));
    b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 80, r, 6, true), paint);
  }
  // ball mount and gun in the nose ring
  const zt = -L * Math.cos(psiTip), ball = new THREE.SphereGeometry(0.13, 20, 14); ball.scale(1, 1, 0.8); ball.translate(0, 0, zt - 0.02); b.add(ball, dark);
  const gd = V(0, -0.12, -1).normalize(), g0 = V(0, -0.01, zt - 0.1);
  b.add(bar(g0, g0.clone().addScaledVector(gd, 0.62), 0.032, 0.032, true, 10), M.black()); // barrel
  nb.add(bar(g0.clone().addScaledVector(gd, 0.04), g0.clone().addScaledVector(gd, 0.3), 0.06, 0.06, true, 12), dark); // cooling jacket
  nb.add(bar(g0.clone().addScaledVector(gd, 0.58), g0.clone().addScaledVector(gd, 0.66), 0.05, 0.05, true, 10), dark); // flash hider
  const breech = new THREE.BoxGeometry(0.09, 0.1, 0.26); breech.translate(0, 0.0, zt + 0.2); b.add(breech, M.black());
  nb.add(bar(V(-0.07, -0.02, zt + 0.34), V(0.07, -0.02, zt + 0.34), 0.03, 0.03, true, 8), M.black()); // spade grips
  // the bomb aimer's station: floor, cushion, bombsight with its eyepiece, an ammunition box; bulkhead at the back
  const floor = new THREE.BoxGeometry(0.8, 0.03, 0.62); floor.translate(0, -0.41, -0.25); b.add(floor, M.paint(0x3a3d42, 'matte'));
  const cush = new THREE.CapsuleGeometry(0.1, 0.32, 4, 10); cush.rotateX(Math.PI / 2); cush.scale(1.3, 0.45, 1); cush.translate(0.12, -0.37, -0.12); b.add(cush, leatherMat());
  const sight = new THREE.BoxGeometry(0.13, 0.16, 0.14); sight.translate(-0.16, -0.31, -0.5); b.add(sight, M.paint(0x2b3a2a, 'matte'));
  const eye = new THREE.CylinderGeometry(0.022, 0.03, 0.12, 10); eye.rotateX(-0.6); eye.translate(-0.16, -0.19, -0.44); nb.add(eye, M.black());
  const ammo = new THREE.BoxGeometry(0.16, 0.13, 0.2); ammo.translate(0.22, -0.33, -0.48); b.add(ammo, M.paint(0x4b5320, 'matte'));
  const bulk = new THREE.CircleGeometry(R * 0.985, 40); bulk.rotateY(Math.PI); bulk.translate(0, 0, 0.004); b.add(bulk, M.paint(0x2e3136, 'matte'));
  b.to(g); nb.to(g, true);
  return g;
}

// Electric fan detail: the fan sits on a can motor (finned can, cooling slots, end bell, three phase leads) held in the
// duct by four stator vanes, with a short shaft and a proper spinner ahead of the blades (the plain part's flat black
// blades and chrome ball read as a black disc).
export function electricMotorDetail(g, { r = 0.4, zFan = -0.05, ductR = 0.385 } = {}) {
  const b = new Bag(), nb = new Bag(), can = PM.metal('anodised'), alu = PM.metal('brushed');
  const rc = r * 0.34, z0 = zFan + 0.08, z1 = zFan + 0.36;
  b.add(revolve(smoothPts([[zFan - 0.29, 0], [zFan - 0.26, rc * 0.42], [zFan - 0.18, rc * 0.78], [zFan - 0.08, rc * 0.95], [zFan - 0.02, rc]], 14).concat([[zFan - 0.019, 0]]), { segs: 24 }), PM.metal('polished'));
  const shaft = new THREE.CylinderGeometry(rc * 0.22, rc * 0.22, 0.14, 12); shaft.rotateX(Math.PI / 2); shaft.translate(0, 0, zFan + 0.03); b.add(shaft, M.steel());
  const body = new THREE.CylinderGeometry(rc, rc, z1 - z0, 28); body.rotateX(Math.PI / 2); body.translate(0, 0, (z0 + z1) / 2); b.add(body, can);
  for (let k = 0; k < 7; k++) { const f = new THREE.CylinderGeometry(rc * 1.16, rc * 1.16, 0.012, 28); f.rotateX(Math.PI / 2); f.translate(0, 0, z0 + 0.05 + k * 0.032); b.add(f, can); }
  for (let k = 0; k < 10; k++) { // cooling slots in the front face
    const a = (k / 10) * Math.PI * 2, s = new THREE.PlaneGeometry(rc * 0.36, rc * 0.12); s.rotateZ(a); s.rotateY(Math.PI); s.translate(Math.cos(a) * rc * 0.62, Math.sin(a) * rc * 0.62, z0 - 0.002); nb.add(s, M.black());
  }
  b.add(revolve([[z1 - 0.002, 0], [z1, rc], [z1 + 0.03, rc * 0.82], [z1 + 0.05, rc * 0.4], [z1 + 0.052, 0.01], [z1 + 0.053, 0]], { segs: 24 }), alu); // end bell
  for (let k = 0; k < 4; k++) { // stator vanes: the motor mount, from the can out to the duct wall
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
    b.add(bar(V(c * rc * 0.95, s * rc * 0.95, z1 - 0.1), V(c * ductR, s * ductR, z1 - 0.06), 0.016, 0.09), alu);
  }
  [0xc0392b, 0x111111, 0xd4a017].forEach((col, k) => { const a = -Math.PI / 2 + (k - 1) * 0.18; nb.add(tube([V(Math.cos(a) * rc * 0.9, Math.sin(a) * rc * 0.9, z1 + 0.01), V(Math.cos(a) * rc * 1.6, Math.sin(a) * rc * 1.6, z1 + 0.03), V(Math.cos(a) * ductR * 0.98, Math.sin(a) * ductR * 0.98, z1 + 0.06)], 0.008, 5, 10), M.paint(col, 'gloss')); });
  b.to(g); nb.to(g, true);
}

// Landing light (x_landlight detail): a tapered, painted can with a chrome bezel, a polished parabolic reflector bowl, a
// glowing lamp in its focus behind a little shield, and a clear domed cover glass; two mounting lugs. Lens faces -z.
export function landLightBuild(color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), R = 0.112;
  const can = new THREE.Mesh(revolve([[-0.072, R + 0.004], [-0.066, 0.124], [0.03, 0.118], [0.07, 0.095], [0.08, 0.05], [0.082, 0]], { segs: 32 }), PM.skin(color));
  can.userData.openOk = 'front: the reflector bowl and bezel fill it'; g.add(can);
  b.add(revolve(smoothPts([[-0.07, R], [-0.05, R * 0.82], [-0.03, R * 0.56], [-0.012, R * 0.28], [-0.004, 0.012]], 12), { segs: 32 }), mirrorMat());
  const bez = new THREE.TorusGeometry(R + 0.006, 0.011, 8, 36); bez.translate(0, 0, -0.072); b.add(bez, M.chrome());
  const lampG = new THREE.SphereGeometry(0.026, 14, 10); lampG.scale(1, 1, 1.3); lampG.translate(0, 0, -0.03);
  const lamp = new THREE.Mesh(lightGeometry(lampG, 2), PM.light()); lamp.userData.planeLight = true; lamp.userData.cosmetic = true; lamp.castShadow = false; g.add(lamp);
  const sh = new THREE.CylinderGeometry(0.03, 0.03, 0.012, 14); sh.rotateX(Math.PI / 2); sh.translate(0, 0, -0.06); nb.add(sh, M.chrome()); // bulb shield
  const rs = 0.3, th = Math.asin((R + 0.004) / rs), cap = new THREE.SphereGeometry(rs, 32, 4, 0, Math.PI * 2, 0, th); cap.rotateX(-Math.PI / 2); cap.translate(0, 0, -0.072 + rs * Math.cos(th));
  const glass = new THREE.Mesh(cap, PM.canopy(0x8fa4b4)); glass.userData.cosmetic = true; glass.castShadow = false; g.add(glass);
  for (const sx of [-1, 1]) { const lug = new THREE.BoxGeometry(0.02, 0.05, 0.06); lug.translate(sx * 0.06, 0.11, 0.03); nb.add(lug, M.darkMetal()); }
  b.to(g); nb.to(g, true);
  return g;
}

// Position light (x_navlight detail): a streamlined teardrop housing (half sunk into the skin it sits on) with a domed
// lens over its front half. The lens is the part's bulb: aircraft.js colours it by side in flight (red left, green right,
// white on the centreline) and blinks the white strobe; the assembly pass gives it the same colour in the hangar and
// turns the head to face the airflow whatever the part's rotation (planeDetail.navLight). userData.navHead is the head.
export function navLightBuild(color) {
  const g = new THREE.Group(), head = new THREE.Group(), b = new Bag(), yc = 0.03;
  const house = revolve(smoothPts([[-0.13, 0], [-0.115, 0.032], [-0.07, 0.056], [0.0, 0.06], [0.08, 0.042], [0.15, 0.012], [0.165, 0]], 18), { segs: 24, sy: 0.85 });
  house.translate(0, yc, 0); b.add(house, PM.skin(color));
  const base = new THREE.CylinderGeometry(0.07, 0.085, 0.03, 18); base.scale(1, 1, 1.9); base.translate(0, -0.005, 0.02); b.add(base, PM.skin(color));
  const lensG = revolve(smoothPts([[-0.142, 0], [-0.125, 0.036], [-0.08, 0.062], [-0.03, 0.068], [-0.004, 0.066]], 14).concat([[-0.003, 0]]), { segs: 24, sy: 0.85 }); lensG.translate(0, yc, 0);
  const lens = new THREE.Mesh(lensG, navLensMat().clone()); lens.castShadow = false; lens.userData.cosmetic = true; lens.userData.navLens = true; head.add(lens);
  const bulbG = new THREE.SphereGeometry(0.03, 12, 8); bulbG.scale(1, 0.85, 1.4); bulbG.translate(0, yc, -0.06);
  const bulb = new THREE.Mesh(bulbG, M.light(0xffffff).clone()); bulb.castShadow = false; head.add(bulb);
  const bez = new THREE.TorusGeometry(0.064, 0.007, 6, 28); bez.scale(1, 0.85, 1); bez.translate(0, yc, -0.004); b.add(bez, M.chrome());
  b.to(head); g.add(head);
  g.userData.bulb = bulb; g.userData.navHead = head; g.userData.navLens = lens;
  return g;
}
// coloured glass over the lamp: tinted, glossy, a little self-lit so it reads as a lit lens by day (cloned per light: the
// assembly pass sets each one's colour)
const navLensMat = () => pdMat('navLens', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, metalness: 0, roughness: 0.1, transparent: true, opacity: 0.86, depthWrite: false }));
// the colour a position light shows at this lateral position (vehicle frame): the rule aircraft.js uses for the bulb
export const navColour = (x) => (x < -0.5 ? 0xff2020 : x > 0.5 ? 0x20ff40 : 0xffffff);

// Pylon (x_pylon detail): an aerofoil-section pylon on the plain part's planform (top chord 1.7 m, bottom 0.9 m, 0.8 m
// deep, 12 cm thick) instead of a flat slab: a rounded leading edge, a root that flares out and runs forward and aft into a
// fillet where it meets the wing above, and a keel fairing with sway braces for whatever hangs below. Front -z, top y = 0.
export function pylonBuild(color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = PM.skin(color);
  const { up, lo } = airfoil(18, 1, 0), sec = [...up.slice().reverse(), ...lo.slice(1, -1)]; // unit-thickness section: TE, upper, LE, lower
  const rings = [], N = 14;
  for (let k = 0; k <= N; k++) {
    const t = k / N, y = -0.8 * t, fl = t < 0.25 ? (1 - t / 0.25) ** 2 : 0; // root flare
    const le = -0.9 + 0.4 * t - 0.25 * fl, te = 0.8 - 0.4 * t + 0.14 * fl, ch = te - le, half = 0.06 * (1 + 1.8 * fl);
    rings.push(sec.map(([x, yy]) => V(yy * half * 2, y, le + x * ch))); // (unit thickness: |yy| peaks at 0.5)
  }
  b.add(ringLoft(rings, true, true), paint);
  const keel = new THREE.CapsuleGeometry(0.05, 0.62, 4, 10); keel.rotateX(Math.PI / 2); keel.scale(1, 0.6, 1); keel.translate(0, -0.8, -0.05); b.add(keel, paint);
  for (const z of [-0.3, 0.2]) for (const sx of [-1, 1]) nb.add(bar(V(sx * 0.04, -0.8, z), V(sx * 0.16, -0.92, z), 0.025, 0.025, true, 6), M.darkMetal());
  b.to(g); nb.to(g, true);
  return g;
}
