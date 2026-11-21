// Visual-only detail for individual parts: twisted propeller blades, cowling louvres and exhaust stacks, jet intake
// lips / compressor faces / nozzle petals, oleo landing gear with torque links and brake lines, cockpit fittings.
// Only built when a part is built with { detail } (flight, hangar, traffic). partInfo() builds parts without it, so
// nothing here can change hull points, mass centres or any other physics input.
// Small pieces are tagged near (userData.near): planeDetail's LOD hides them beyond a few dozen metres.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { M } from './materials.js';
import { PM, lightGeometry } from './planeMaterials.js';
import { revolve, airfoil } from './parts.js'; // (circular, used at build time only)

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
export function cockpitBuild(id, color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = PM.skin(color), black = M.black(), seatM = PM.seat();
  if (id === 'ck_bubble') {
    const a = 0.45, bb = 1.0, c = 0.425;
    const dome = new THREE.SphereGeometry(1, 56, 22, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(a, c, bb);
    g.add(new THREE.Mesh(dome, PM.canopy()));
    const skirt = new THREE.Mesh((() => { const s = new THREE.CylinderGeometry(1, 1, 0.5, 56, 1, true); s.scale(a, 1, bb); s.translate(0, -0.25, 0); return s; })(), PM.canopy());
    skirt.visible = false; skirt.userData.glassSkirt = true; g.add(skirt);
    // windscreen bow and the rear hoop of the sliding hood (they follow the glass)
    for (const [z, rad] of [[-0.6, 0.018], [0.42, 0.014]]) { const k = Math.sqrt(1 - (z / bb) ** 2); b.add(bowGeo(a * k + 0.006, c * k + 0.006, z, rad), paint); }
    // tub fittings: seat, pilot, glare shield with the instrument panel under it, stick
    const st = seatGeo(0.36, 0.72, 0.34, 0.32); st.translate(0, -0.54, 0.42); b.add(st, seatM); // (low in a deep tub: a seated adult's head clears the glass)
    const hrest = new THREE.CapsuleGeometry(0.06, 0.12, 4, 10); hrest.rotateZ(Math.PI / 2); hrest.scale(1, 1, 0.6); hrest.translate(0, 0.2, 0.64); b.add(hrest, seatM);
    // the pilot (crew.js) on that seat; the seat point is where the hips settle. The controls where this cockpit has
    // them (part coordinates): the stick standing on the tub floor between the knees, the throttle lever on the left
    // wall beside the hip, the rudder pedals on the floor
    { const P = [0, -0.392, 0.367], S = 0.8, at = (x, y, z) => [x - P[0], y - P[1], z - P[2]]; // (controls: part units from the seat point)
      g.userData.seats = [{ p: P, s: S, fit: { at: [0, -0.54, 0.42], dims: [0.36, 0.72, 0.34, 0.32], floor: -0.66, feet: 'pedals' },
        controls: { stickBase: at(0, -0.655, -0.12), stickLen: 0.42, thrBase: at(-0.325, -0.38, 0.1), pedY: at(0, -0.66, 0)[1], pedZ: at(0, 0, -0.28)[2] } }]; }
    const gl = new THREE.CylinderGeometry(0.26, 0.26, 0.16, 18, 1, true, -1.25, 2.5); gl.scale(1, 1, 0.55); gl.rotateY(Math.PI); gl.translate(0, 0.08, -0.55); b.add(shell(gl, 0.008), black);
    const glTop = new THREE.CylinderGeometry(0.26, 0.26, 0.012, 18, 1, false, -1.25, 2.5); glTop.scale(1, 1, 0.55); glTop.rotateY(Math.PI); glTop.translate(0, 0.16, -0.55); b.add(capHoles(glTop), black);
    const pf = mx([0, 0.06, -0.54], [-0.25, 0, 0]), pnl = new THREE.BoxGeometry(0.46, 0.2, 0.012); pnl.applyMatrix4(pf); b.add(pnl, black); // (its top edge up under the glare shield's lid: the shield hung ahead of it)
    for (let i = 0; i < 5; i++) { const d = new THREE.CircleGeometry(0.032, 12); d.applyMatrix4(pf.clone().multiply(mx([-0.18 + i * 0.09, 0.02 - (i % 2) * 0.06, 0.0065]))); nb.add(d, PM.dial()); } // on the panel face (they hung in front of it, or behind)
    g.userData.fit = [{ kind: 'seat', p: [0, -0.573, 0.29], w: 0.2, d: 0.2 }, { kind: 'panel', p: V(0, -0.1, 0).applyMatrix4(pf).toArray(), w: 0.4, d: 0.05, tilt: -0.25 }];
    // what the pilot must keep clear of: inside the dome (and its skirt's walls down into the tub), the panel, the hood
    g.userData.seats[0].obstacles = [{ name: 'canopy', inside: insideRows(-bb, bb, 40, (z) => { const k = Math.sqrt(Math.max(0, 1 - (z / bb) ** 2)); return [a * k, c * k, 0]; }) },
      boxObstacle('panel', pf, [0.46, 0.2, 0.012]), hoodObstacle('glare shield', 0.26, 0.55, 1.25, 0.08, -0.55, 0.16)];
  } else if (id === 'ck_fighter') {
    const glass = revolveZ(smoothPts(FIGHTER_GLASS, 40), 48, 1.15);
    g.add(new THREE.Mesh(glass, PM.canopy(0x6b5524)));
    // windscreen bow (thick) and the canopy arch, following the glass section
    for (const [z, rad] of [[-0.62, 0.026], [0.78, 0.02]]) { const r = fighterGlassR(z); b.add(bowGeo(r + 0.006, r * 1.15 + 0.006, z, rad, -r * 0.35), paint); }
    // ejection seat: padded back, head box (inside the glass) with the yellow/black firing handle
    // (set down in the tub, so the pilot's helmet clears the canopy: it touched the glass)
    const st = seatGeo(0.42, 0.62, 0.4, 0.3); st.translate(0, -0.4, 0.52); b.add(st, seatM);
    const hb = new THREE.CapsuleGeometry(0.1, 0.16, 4, 10); hb.rotateZ(Math.PI / 2); hb.scale(1, 1.05, 0.8); hb.translate(0, 0.28, 0.73); b.add(hb, seatM);
    const handle = new THREE.TorusGeometry(0.06, 0.011, 4, 10, Math.PI); handle.translate(0, 0.34, 0.67); nb.add(handle, M.propTip());
    // side consoles along the tub walls beside the seat: the side-stick on the right one (forearm on its armrest), the
    // throttle on the left. The pilot's feet on the rudder pedals just ahead of the seat (the tub floor is ~-0.52).
    for (const sx of [-1, 1]) { const con = new THREE.BoxGeometry(0.17, 0.4, 0.8); con.translate(sx * 0.315, -0.38, 0.02); b.add(con, black); }
    const arm = new THREE.BoxGeometry(0.13, 0.05, 0.34); arm.translate(0.29, -0.155, 0.15); b.add(arm, seatM); // the side-stick's raised mount and armrest
    g.userData.seats = [{ p: [0, -0.28, 0.4], s: 0.88, fit: { at: [0, -0.4, 0.52], dims: [0.42, 0.62, 0.4, 0.3], floor: -0.52, feet: 'pedals' },
      controls: { stickBase: [0.27, 0.17, -0.33], stickLen: 0.11, thrBase: [-0.27, 0.1, -0.25], thrLen: 0.11, pedZ: -0.55, pedY: -0.22 } }];
    const gl = new THREE.CylinderGeometry(0.3, 0.3, 0.18, 18, 1, true, -1.3, 2.6); gl.scale(1, 1, 0.6); gl.rotateY(Math.PI); gl.translate(0, 0.14, -0.6); b.add(shell(gl, 0.008), black);
    const glTop = new THREE.CylinderGeometry(0.3, 0.3, 0.012, 18, 1, false, -1.3, 2.6); glTop.scale(1, 1, 0.6); glTop.rotateY(Math.PI); glTop.translate(0, 0.23, -0.6); b.add(capHoles(glTop), black);
    const pf = mx([0, 0.11, -0.6], [-0.2, 0, 0]), pnl = new THREE.BoxGeometry(0.52, 0.24, 0.012); pnl.applyMatrix4(pf); b.add(pnl, black); // (top edge under the glare shield's lid)
    for (let i = 0; i < 2; i++) { const d = new THREE.PlaneGeometry(0.13, 0.11); d.applyMatrix4(pf.clone().multiply(mx([-0.1 + i * 0.2, 0, 0.0065]))); nb.add(d, PM.dial()); } // (on the panel face)
    // HUD combiner on two posts standing on the glare shield (it hung in the air above it)
    const hf = mx([0, 0.33, -0.62], [-0.35, 0, 0]), hud = new THREE.PlaneGeometry(0.15, 0.13); hud.applyMatrix4(hf); nb.add(hud, PM.canopy(0x3c6b52));
    for (const sx of [-1, 1]) { const top = V(sx * 0.068, -0.06, 0).applyMatrix4(hf); nb.add(bar(top, V(top.x, 0.226, top.z - 0.05), 0.012, 0.012, true, 6), black); }
    g.userData.fit = [{ kind: 'seat', p: [0, -0.435, 0.36], w: 0.24, d: 0.22 }, { kind: 'panel', p: V(0, -0.12, 0).applyMatrix4(pf).toArray(), w: 0.1, d: 0.05, tilt: -0.2 }]; // (the panel on a narrow centre pedestal: the legs go either side of it to the pedals)
    // what the pilot must keep clear of: inside the glass (revolved, 1.15 x as tall as wide; walls below its base), the
    // side consoles, the side-stick's armrest (the legs only: the forearm rests on it), the panel, its hood and the HUD
    g.userData.seats[0].obstacles = [{ name: 'canopy', inside: insideRows(FIGHTER_GLASS[0][0], FIGHTER_GLASS.at(-1)[0], 72, (z) => [fighterGlassR(z), fighterGlassR(z) * 1.15, 0]) },
      ...[-1, 1].map((sx) => ({ name: 'console', box: [sx * 0.315, -0.38, 0.02], size: [0.17, 0.4, 0.8] })), { name: 'armrest', box: [0.29, -0.155, 0.15], size: [0.13, 0.05, 0.34], parts: ['legs', 'torso'] },
      boxObstacle('panel', pf, [0.52, 0.24, 0.012]), hoodObstacle('glare shield', 0.3, 0.6, 1.3, 0.14, -0.6, 0.18), boxObstacle('HUD', hf, [0.15, 0.13, 0.01])];
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
// Like a 747 / A320 / 787 nose: the tip sits low, the radome rises to a windscreen face raked back ~45-50 deg, and the
// crown line flattens out behind it; the keel curves up gently. (The plain part, which physics reads, is unchanged.)
const NOSE_T = [[-4.6, -0.2], [-4.52, 0.12], [-4.3, 0.42], [-3.95, 0.64], [-3.55, 0.84], [-3.1, 1.24], [-2.6, 1.64], [-2.1, 1.84], [-1.2, 1.9], [0, 1.9]];
const NOSE_B = [[-4.6, -0.2], [-4.52, -0.5], [-4.3, -0.86], [-3.9, -1.24], [-3.3, -1.58], [-2.5, -1.8], [-1.4, -1.89], [0, -1.9]];
const NOSE_W = [[-4.6, 0], [-4.52, 0.36], [-4.3, 0.72], [-3.9, 1.06], [-3.3, 1.42], [-2.5, 1.7], [-1.4, 1.87], [0, 1.9]];
function lineFn(pts) { // spline through (z, v), tabulated on a uniform z grid
  const s = new THREE.SplineCurve(pts.map(([z, v]) => new THREE.Vector2(z, v))).getPoints(160), z0 = pts[0][0], z1 = pts.at(-1)[0], N = 1024, t = new Float32Array(N + 1);
  for (let k = 0, i = 1; k <= N; k++) { const z = z0 + (z1 - z0) * (k / N); while (i < s.length - 1 && s[i].x < z) i++; const a = s[i - 1], c = s[i]; t[k] = a.y + (c.y - a.y) * Math.min(1, Math.max(0, (z - a.x) / (c.x - a.x || 1))); }
  return (z) => { const u = Math.min(1, Math.max(0, (z - z0) / (z1 - z0))) * N, k = Math.min(N - 1, Math.floor(u)); return t[k] + (t[k + 1] - t[k]) * (u - k); };
}
const nT = lineFn(NOSE_T), nB = lineFn(NOSE_B), nW = lineFn(NOSE_W);
// a point on the nose skin: z along, th round from the top (+ = right)
const nosePt = (z, th, k = 1) => { const T = nT(z), B = nB(z), mid = (T + B) / 2, c = Math.cos(th), h = c >= 0 ? T - mid : mid - B; return V(Math.sin(th) * nW(z) * k, mid + c * h * k, z); };
// flight-deck window set: above a sill line (horizontal in side view, rising a little aft), ahead of a top edge that
// sweeps back towards the sides; > 0 inside the glazing
const SILL = (z) => 0.82 + 0.06 * (z + 3.5), WTOP = (th) => -2.7 + 0.7 * th * th, WSIDE = 1.12;
const winVal = (z, th) => { const p = nosePt(z, th); return Math.min(p.y - SILL(z), WTOP(th) - z, (WSIDE - Math.abs(th)) * 0.8); };
export function airlinerNoseBuild(color, skinMat) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), black = M.black();
  // skin grid: dense rings round the windscreen, coarser elsewhere
  const zs = []; for (let z = -4.6; z < -4.2; z += 0.05) zs.push(z); for (let z = -4.2; z < -1.9; z += 0.05) zs.push(z); for (let z = -1.9; z < -0.001; z += 0.2) zs.push(z); zs.push(0);
  const SEG = 96, row = SEG + 1, circ = 2 * Math.PI * 1.9, pos = [], uv = [], uv1 = [], idx = [];
  for (const z of zs) for (let i = 0; i <= SEG; i++) { const th = (i / SEG) * Math.PI * 2, p = nosePt(z, th > Math.PI ? th - Math.PI * 2 : th); pos.push(p.x, p.y, p.z); uv.push((z + 4.6) / 4.6, i / SEG); uv1.push(z, (i / SEG) * circ); }
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < SEG; i++) { const a = j * row + i, c = (j + 1) * row + i; idx.push(a, c, c + 1, a, c + 1, a + 1); }
  { const ci = pos.length / 3; pos.push(0, 0, 0); uv.push(1, 0.5); uv1.push(0, 0); const j = zs.length - 1; for (let i = 0; i < SEG; i++) idx.push(ci, j * row + i + 1, j * row + i); }
  const sk = new THREE.BufferGeometry(); sk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); sk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); sk.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2)); sk.setIndex(idx); sk.computeVertexNormals(); fixNormals(sk);
  // the glazing is cut out of the skin exactly along the outline (clipGeometry); the glass is the cut-out piece, set
  // in a little
  const P = sk.attributes.position, N = sk.attributes.normal, val = new Float32Array(P.count), neg = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { const z = P.getZ(i), T = nT(z), B = nB(z), mid = (T + B) / 2, dy = P.getY(i) - mid, th = Math.atan2(P.getX(i) / Math.max(1e-4, nW(z)), dy / Math.max(1e-4, dy >= 0 ? T - mid : mid - B)); val[i] = z > -1.5 || z < -4.0 ? -1 : winVal(z, th); neg[i] = -val[i]; }
  const skin = new THREE.Mesh(clipGeometry(sk, neg) || sk, skinMat); skin.userData.openOk = 'flight-deck windows: glazed'; g.add(skin);
  const glass = clipGeometry(sk, val);
  if (glass) { const gp = glass.attributes.position, gn = glass.attributes.normal; for (let i = 0; i < gp.count; i++) gp.setXYZ(i, gp.getX(i) - gn.getX(i) * 0.012, gp.getY(i) - gn.getY(i) * 0.012, gp.getZ(i) - gn.getZ(i) * 0.012); g.add(new THREE.Mesh(glass, flightDeckGlass())); }
  // frames: the outline (traced along the cut) and the posts between the six panes, black like an airline's window mask
  const lift = (p, th, d = 0.006) => { const q = nosePt(p.z, th, 1); const n = q.clone().sub(V(0, (nT(p.z) + nB(p.z)) / 2, p.z)).normalize(); return p.clone().addScaledVector(n, d); };
  const edgeZ = (th) => { let lo = -4.0, hi = WTOP(th); for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (nosePt(m, th).y - SILL(m) > 0) hi = m; else lo = m; } return hi; }; // sill crossing at this azimuth
  const loop = [], TH = WSIDE - 0.004;
  for (let i = 0; i <= 30; i++) { const th = -TH + 2 * TH * (i / 30); loop.push(lift(nosePt(edgeZ(th), th), th)); }
  for (let i = 0; i <= 30; i++) { const th = TH - 2 * TH * (i / 30), z = WTOP(th); loop.push(lift(nosePt(z, th), th)); }
  const fb = new Bag(); // (the window frames: their own mesh, so the seam check can tell them from the skin)
  fb.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, true, 'centripetal'), 220, 0.032, 6, true), black);
  for (const th of [0, -0.38, 0.38, -0.76, 0.76]) { const z0 = edgeZ(th), z1 = WTOP(th), pts = []; for (let k = 0; k <= 8; k++) { const z = z0 + (z1 - z0) * (k / 8); pts.push(lift(nosePt(z, th), th)); } fb.add(pipe(pts, th ? 0.03 : 0.04, 6, 24), black); }
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
  // flight deck: dark lining (the inside of the skin), back bulkhead, floor, glare shield and panel under the sill,
  // centre pedestal, seats
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.9, side: THREE.BackSide });
  const lz = zs.filter((z) => z > -4.05 && z < -1.4), lp = [], li = [], LS = 40;
  for (const z of lz) for (let i = 0; i <= LS; i++) { const th = (i / LS) * Math.PI * 2, p = nosePt(z, th > Math.PI ? th - Math.PI * 2 : th, 0.97); lp.push(p.x, p.y, p.z); }
  for (let j = 0; j < lz.length - 1; j++) for (let i = 0; i < LS; i++) { const a = j * (LS + 1) + i, c = a + LS + 1; li.push(a, c, c + 1, a, c + 1, a + 1); }
  const liner = new THREE.BufferGeometry(); liner.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); liner.setIndex(li); liner.computeVertexNormals();
  g.add(new THREE.Mesh(liner, dark));
  const bulk = new THREE.CircleGeometry(1.84, 32); bulk.rotateY(Math.PI); bulk.translate(0, 0, -1.5); b.add(bulk, M.paint(0x3a3d42, 'matte'));
  const floor = new THREE.BoxGeometry(2.2, 0.05, 2.3); floor.translate(0, -0.12, -2.65); b.add(floor, M.paint(0x34373c, 'matte'));
  const glare = new THREE.CylinderGeometry(0.95, 0.95, 0.07, 24, 1, false, -1.0, 2.0); glare.scale(1, 1, 0.42); glare.rotateY(Math.PI); glare.translate(0, 0.69, -3.15); b.add(capHoles(glare), black); // (on the panel top: it hovered over it)
  const pf = mx([0, 0.46, -3.3], [-0.3, 0, 0]), pnl = new THREE.BoxGeometry(1.5, 0.42, 0.06); pnl.applyMatrix4(pf); b.add(pnl, M.paint(0x2b2d31, 'matte'));
  for (let i = 0; i < 5; i++) { const d = new THREE.PlaneGeometry(0.2, 0.16); d.applyMatrix4(pf.clone().multiply(mx([-0.56 + i * 0.28, 0.04, 0.0305]))); nb.add(d, PM.dial()); } // (on the panel face)
  const ped = new THREE.BoxGeometry(0.34, 0.42, 0.8); ped.translate(0, 0.1, -2.85); b.add(ped, M.paint(0x2b2d31, 'matte'));
  // crew seats: cushion 42 cm over the floor (an airliner seat's height), on a pedestal down to the floor
  const FLOOR = -0.095, SY = 0.24, SZ = -2.3, SEAT = [0.5, 0.75, 0.48, 0.2]; // (floor top; seatGeo's origin height, z; its dims)
  for (const sx of [-1, 1]) {
    const st = seatGeo(...SEAT); st.translate(sx * 0.55, SY, SZ); b.add(st, PM.seat());
    const bh = SY - 0.04 - FLOOR, rs = new THREE.BoxGeometry(0.3, bh, 0.3); rs.translate(sx * 0.55, FLOOR + bh / 2, SZ - 0.22); b.add(rs, M.darkMetal());
  }
  b.to(g); nb.to(g, true);
  // each seat declares its cushion and back (seatGeo's, as placed above), the floor, and the feet on the rudder pedals
  // (drawn by crew.js, hinged on the floor under the panel)
  g.userData.seats = [1, -1].map((sx) => { const p = [sx * 0.55, SY + 0.04, SZ - 0.24];
    return { p, s: 1, fit: { at: [sx * 0.55, SY, SZ], dims: SEAT, floor: FLOOR, feet: 'pedals' }, controls: {
      pedY: FLOOR - p[1], pedZ: -3.03 - p[2], // rudder pedals under the panel, hinged at the floor
      colBase: [0, FLOOR - p[1], -0.62], colLen: 0.75, // the column pivots in the floor (the generic one stopped 7 cm over it), the yoke clear of the knees
    } }; });
  // what each pilot must keep clear of: inside the lining (the nose's sections at 0.97), the panel and its glare shield,
  // the centre pedestal
  for (const st of g.userData.seats) st.obstacles = [{ name: 'lining', below: 'mirror', inside: insideRows(-4.0, -1.5, 50, (z) => [nW(z) * 0.97, (nT(z) - nB(z)) / 2 * 0.97, (nT(z) + nB(z)) / 2]) },
    boxObstacle('panel', pf, [1.5, 0.42, 0.06]), hoodObstacle('glare shield', 0.95, 0.42, 1.0, 0.69, -3.15, 0.07), { name: 'pedestal', box: [0, 0.1, -2.85], size: [0.34, 0.42, 0.8] }];
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
