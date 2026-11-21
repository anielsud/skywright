// Boat parts (the Boat tab): four hulls, three ways to push a boat along and a few boat fittings. They register into
// PARTS like parts.js's own (same fields, same build(color, { detail }) contract), so the hangar, physics and save codes
// treat them like any other part.
//
// A hull is any part with `boatHull`: a build with one makes the whole vehicle a boat (boat.js floats it). Its meshes
// tagged userData.hull are what floats: boat.js measures them once per part (hullColumns) with vertical rays, so a
// resized or rotated hull, or a kid's own mix of hulls, floats by its real shape.
// The motors carry engine.type 'marine' (boat.js pushes the boat with them, only while their propeller or jet intake
// is under water): an outboard that swivels to steer, a propeller and rudder under the hull, and a water jet whose
// nozzle swivels. Their swivelling piece is userData.strut and the propeller userData.fan (spun by aircraft.js like a
// jet's fan), so the draw-call merge keeps both moving.
//
// The hulls are lofted from stations (bow to stern): keel, chine, gunwale and, inside the gunwale, a deck that drops
// into a cockpit or a working deck behind bulwarks where the stations say so. Painted bottom, a boot stripe, topsides,
// a white gunwale cap and deck, each one strip so the creases stay crisp; the transom closes the stern.
import * as THREE from 'three';
import { mergeVertices } from '../vendor/addons/BufferGeometryUtils.js';
import { PARTS } from './parts.js';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';
import { V, bar, pipe, Bag, seatGeo, ringLoft } from './partDetail.js';

const cached = new Map();
const mat = (k, make) => { if (!cached.has(k)) cached.set(k, make()); return cached.get(k); };
const gel = (c) => mat('gel' + c, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.08 }));
// Procedural surface relief from the object-space position (no UVs needed): marine vinyl grain, non-skid diamonds
const RELIEF = /* glsl */`
  varying vec3 vRelP;
  float rH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float rN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(rH(i), rH(i + vec3(1,0,0)), f.x), mix(rH(i + vec3(0,1,0)), rH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(rH(i + vec3(0,0,1)), rH(i + vec3(1,0,1)), f.x), mix(rH(i + vec3(0,1,1)), rH(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 rBump(vec3 n, vec3 vp, float h, float k) { vec3 dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); return normalize(abs(det) * n - k * sign(det) * (dhx * r1 + dhy * r2)); }`;
function relief(m, field, key) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRelP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRelP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + RELIEF).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{ ${field} normal = rBump(normal, -vViewPosition, h, k); }`);
  };
  m.customProgramCacheKey = () => 'relief-' + key; return m;
}
const nonSkid = (c) => mat('deck' + c, () => relief(new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.82 }),
  'vec2 q = vRelP.xz * 55.0; vec2 dq = abs(fract(vec2(q.x + q.y, q.x - q.y) * 0.5) - 0.5); float fw = clamp(length(fwidth(vRelP)) * 60.0, 0.0, 1.0); float h = mix(smoothstep(0.32, 0.18, max(dq.x, dq.y)), 0.0, fw) * 0.8 + (rN(vRelP * 140.0) - 0.5) * 0.3; float k = 0.0009;', 'deck'));
// marine vinyl: a soft sheen, a little clearcoat and a fine leather grain
const vinyl = (c) => mat('vinyl' + c, () => relief(new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.42, sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.4, 0.4, 0.4), clearcoat: 0.35, clearcoatRoughness: 0.35 }),
  'float h = (rN(vRelP * 320.0) - 0.5) * 0.6 + (rN(vRelP * 900.0) - 0.5) * 0.25; float k = 0.00035;', 'vinyl'));
// An upholstered cushion: a rounded box (corner radius r) whose faces bulge out by `bulge`; `pleats` horizontal channels
// sewn across the front face (backrests). Centred on the origin, w x h x d.
function cushion(w, h, d, r = 0.05, bulge = 0.02, pleats = 0) {
  const g = new THREE.BoxGeometry(w, h, d, 16, 12, 12), p = g.attributes.position, hw = w / 2, hh = h / 2, hd = d / 2, q = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i); c.set(THREE.MathUtils.clamp(q.x, -hw + r, hw - r), THREE.MathUtils.clamp(q.y, -hh + r, hh - r), THREE.MathUtils.clamp(q.z, -hd + r, hd - r));
    const n = q.clone().sub(c); const L = n.length() || 1; n.divideScalar(L); q.copy(c).addScaledVector(n, r);
    const ux = q.x / hw, uy = q.y / hh, uz = q.z / hd; // bulge: the stuffing pushes each face out in the middle
    q.addScaledVector(n, bulge * Math.max(0, 1 - ux * ux) * Math.max(0, 1 - uy * uy) * Math.max(0, 1 - uz * uz) * 4);
    if (pleats && n.z < -0.5) { const t = (q.y / h + 0.5) * (pleats + 1); q.z += 0.012 * Math.exp(-(((t - Math.round(t)) / 0.08) ** 2)) * (Math.round(t) > 0 && Math.round(t) <= pleats ? 1 : 0); }
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.deleteAttribute('normal'); const m = mergeVertices(g, 1e-4); m.computeVertexNormals(); return m;
}
// piping: a thin welted cord round a cushion's top edge (a rounded rectangle at height y)
function piping(w, d, r, y, rad = 0.008) {
  const pts = [], hw = w / 2 - r, hd = d / 2 - r;
  for (const [cx, cz, a0] of [[hw, hd, 0], [-hw, hd, Math.PI / 2], [-hw, -hd, Math.PI], [hw, -hd, Math.PI * 1.5]]) for (let k = 0; k <= 6; k++) { const a = a0 + (k / 6) * Math.PI / 2; pts.push(V(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r)); }
  pts.push(pts[0].clone()); return pipe(pts, rad, 6, 120);
}
const rubberM = () => M.rubber();
const WHITE = 0xf4f4f0, TEAK = 0xb8956a;

function ensureUv1(obj) {
  obj.traverse((m) => { const g = m.geometry; if (m.isMesh && !g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
  return obj;
}
function def(p) { const b = p.build; p.build = (c, o) => ensureUv1(b(c, o?.detail || 0)); PARTS[p.id] = p; }

// ---------- hull lofting ----------
// A station: { z, yk (keel), hc, yc (chine half-width, height), hg, ys (gunwale), yd (deck / cockpit floor), t (gunwale
// cap width) }. dense(): stations every `step` metres, linear between the given ones, then the shape lines (not the
// deck drops) eased with a light smoothing pass.
const KEYS = ['yk', 'hc', 'yc', 'hg', 'ys', 't'];
function dense(S, step = 0.1) {
  const out = [];
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1], n = Math.max(1, Math.round((b.z - a.z) / step));
    for (let k = 0; k < n; k++) { const t = k / n, o = { z: a.z + (b.z - a.z) * t }; for (const key of [...KEYS, 'yd']) o[key] = a[key] + (b[key] - a[key]) * t; out.push(o); }
  }
  out.push({ ...S.at(-1) });
  for (let pass = 0; pass < 3; pass++) {
    const prev = out.map((s) => ({ ...s }));
    for (let i = 1; i < out.length - 1; i++) for (const key of KEYS) out[i][key] = (prev[i - 1][key] + 2 * prev[i][key] + prev[i + 1][key]) / 4;
  }
  return out;
}
// the points of one station's half section (x >= 0): keel, chine, boot-stripe top, gunwale, cap inner edge, deck edge, deck middle
function section(s) {
  const K = [0, s.yk], C = [s.hc, s.yc], G = [s.hg, s.ys], B = [s.hc + (s.hg - s.hc) * 0.16, s.yc + (s.ys - s.yc) * 0.16];
  const flare = Math.min(0.06, (s.ys - s.yc) * 0.08), mid = [(s.hc + s.hg) / 2 + flare, (s.yc + s.ys) / 2];
  const I = [Math.max(0, s.hg - s.t), s.ys], F = [Math.max(0, s.hg - s.t), Math.min(s.ys, s.yd)], Mid = [0, Math.min(s.ys, s.yd)];
  return { K, C, B, mid, G, I, F, Mid };
}
// a strip through the stations: cols = which section points, left to right; sx = +1 / -1 (side)
function strip(S, cols, sx) {
  const pos = [], uv = [], idx = [], n = cols.length;
  for (const s of S) {
    const sec = section(s); let arc = 0, prev = null;
    for (const c of cols) {
      const p = sec[c], x = p[0] * sx, y = p[1];
      if (prev) arc += Math.hypot(x - prev[0], y - prev[1]); prev = [x, y];
      pos.push(x, y, s.z); uv.push(s.z, arc);
    }
  }
  for (let j = 0; j < S.length - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i + 1, d = (j + 1) * n + i;
    if (sx > 0) idx.push(a, c, d, a, b, c); else idx.push(a, d, c, a, c, b); // (outward)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// the transom: the last station's whole section as a flat polygon facing aft
function transom(s) {
  const sec = section(s), ring = [];
  for (const c of ['K', 'C', 'B', 'mid', 'G', 'I', 'F']) ring.push(sec[c]);
  ring.push(sec.Mid);
  for (const c of ['F', 'I', 'G', 'mid', 'B', 'C']) ring.push([-sec[c][0], sec[c][1]]);
  const pts = []; for (const p of ring) if (!pts.length || Math.hypot(p[0] - pts.at(-1).x, p[1] - pts.at(-1).y) > 1e-4) pts.push(new THREE.Vector2(p[0], p[1]));
  if (pts[0].distanceTo(pts.at(-1)) < 1e-4) pts.pop();
  let tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos = [], uv = []; for (const p of pts) { pos.push(p.x, p.y, s.z); uv.push(p.x, p.y); }
  const idx = []; for (const t of tris) { const [a, b, c] = t, ax = pts[b].x - pts[a].x, ay = pts[b].y - pts[a].y, bx = pts[c].x - pts[a].x, by = pts[c].y - pts[a].y; if (ax * by - ay * bx > 0) idx.push(a, b, c); else idx.push(a, c, b); }
  tris = null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// The hull's skin as meshes on g (all tagged hull: they are what floats). o: { bottom, stripe, side, deck, floor } colours.
function hullSkin(g, S, o) {
  const add = (geo, m) => { const mesh = new THREE.Mesh(geo, m); mesh.userData.hull = true; mesh.userData.openOk = 'hull skin: bottom, topsides, gunwale, deck and transom meet edge to edge'; g.add(mesh); return mesh; };
  const b = new Bag();
  for (const sx of [1, -1]) {
    b.add(strip(S, ['K', 'C'], sx), gel(o.bottom));
    b.add(strip(S, ['C', 'B'], sx), gel(o.stripe));
    b.add(strip(S, ['B', 'mid', 'G'], sx), o.sideMat || gel(o.side));
    b.add(strip(S, ['G', 'I'], sx), gel(o.deck));
    b.add(strip(S, ['I', 'F'], sx), gel(o.deck));
  }
  b.add(strip(S, ['F', 'Mid'], 1), nonSkid(o.floor)); b.add(strip(S, ['F', 'Mid'], -1), nonSkid(o.floor));
  b.add(transom(S.at(-1)), gel(o.side === o.bottom ? o.deck : o.side));
  for (const [m, geos] of b.b) { const merged = geos.length > 1 ? mergeAll(geos) : geos[0]; add(merged, m); }
  b.b.clear();
}
function mergeAll(geos) {
  let n = 0, ni = 0; for (const g of geos) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(ni); let o = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2);
    const I = g.index.array; for (let k = 0; k < I.length; k++) idx[oi + k] = I[k] + o; o += g.attributes.position.count; oi += I.length;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
// station lookup (interpolated) at z
function stationAt(S, z) {
  if (z <= S[0].z) return S[0]; if (z >= S.at(-1).z) return S.at(-1);
  for (let i = 1; i < S.length; i++) if (S[i].z >= z) { const a = S[i - 1], b = S[i], t = (z - a.z) / (b.z - a.z || 1), o = { z }; for (const k of [...KEYS, 'yd']) o[k] = a[k] + (b[k] - a[k]) * t; return o; }
  return S.at(-1);
}
const st = (z, yk, hc, yc, hg, ys, yd, t) => ({ z, yk, hc, yc, hg, ys, yd, t });

// ---------- the hulls ----------
// Speedboat: a deep-V bowrider. Foredeck, windscreen, a cockpit with two bucket seats and a bench, a helm console.
const SPEED = dense([
  st(-3.3, 0.62, 0.0, 0.62, 0.0, 1.02, 1.02, 0.0), st(-3.05, 0.25, 0.3, 0.45, 0.42, 1.0, 1.0, 0.06), st(-2.6, 0.02, 0.62, 0.3, 0.78, 0.97, 0.97, 0.08),
  st(-1.9, -0.16, 0.88, 0.17, 1.0, 0.94, 0.94, 0.09), st(-1.25, -0.25, 1.0, 0.1, 1.1, 0.92, 0.92, 0.09), st(-1.15, -0.26, 1.01, 0.09, 1.11, 0.92, 0.42, 0.1),
  st(0.0, -0.29, 1.05, 0.07, 1.14, 0.9, 0.4, 0.12), st(1.6, -0.3, 1.06, 0.06, 1.14, 0.88, 0.4, 0.12), st(2.3, -0.3, 1.06, 0.06, 1.14, 0.87, 0.4, 0.12),
  st(2.4, -0.3, 1.06, 0.06, 1.14, 0.87, 0.8, 0.12), st(3.2, -0.29, 1.04, 0.07, 1.1, 0.86, 0.8, 0.12),
]);
export const SPEED_TRANSOM = { y: 0.86, z: 3.2 }; // where an outboard clamps on
function speedHull(c, lv) {
  const g = new THREE.Group();
  hullSkin(g, SPEED, { bottom: WHITE, stripe: 0x15161a, side: c, deck: WHITE, floor: 0xd8d6cf });
  const b = new Bag(), nb = new Bag(), chrome = M.chrome(), seatM = vinyl(WHITE), seatM2 = vinyl(c);
  // windscreen: a raked, wrap-around pane on the front of the cockpit, its foot on the deck
  { const n = 16, rows = [[], []];
    for (let i = 0; i <= n; i++) {
      const u = i / n * 2 - 1, x = u * 1.0, z = -1.3 + 0.22 * u * u, s = stationAt(SPEED, z), y0 = s.ys - 0.012;
      rows[0].push(V(x, y0, z)); rows[1].push(V(x * 0.92, y0 + 0.42, z + 0.28));
    }
    const pos = [], idx = []; for (const r of rows) for (const p of r) pos.push(p.x, p.y, p.z);
    for (let i = 0; i < n; i++) idx.push(i, i + 1, n + 2 + i, i, n + 2 + i, n + 1 + i);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wg.setIndex(idx); wg.computeVertexNormals();
    g.add(new THREE.Mesh(wg, M.glass(0x6f8fa8)));
    b.add(pipe(rows[1], 0.018, 6, 48), chrome); // top frame
    for (const k of [0, n]) b.add(bar(rows[0][k], rows[1][k], 0.03, 0.03, true, 6), chrome);
  }
  // helm console (starboard) and the passenger's glovebox (port), on the cockpit floor, 67 cm tall (the wheel is
  // mounted on the helm console's back face: seats[0].helm)
  for (const sx of [1, -1]) {
    const w = 0.62, x = sx * 0.5, z0 = -1.12, z1 = -0.55, y0 = 0.38, y1 = 1.1;
    const geo = new THREE.BoxGeometry(w, y1 - y0, z1 - z0); geo.translate(x, (y0 + y1) / 2, (z0 + z1) / 2); b.add(geo, gel(WHITE));
    const dash = new THREE.BoxGeometry(w * 0.92, 0.04, 0.3); dash.rotateX(-0.35); dash.translate(x, y1 + 0.005, z1 - 0.14); b.add(dash, M.black());
  }
  // bucket seats on pedestals (cushion 42 cm above the deck, a helm seat's height), a bench across the back
  for (const sx of [1, -1]) {
    const ped = new THREE.CylinderGeometry(0.08, 0.12, 0.38, 12); ped.translate(sx * 0.5, 0.58, 0.25); b.add(ped, chrome);
    const s = seatGeo(0.5, 0.55, 0.46, 0.2); s.translate(sx * 0.5, 0.77, 0.42); b.add(s, sx > 0 ? seatM2 : seatM);
    if (lv) { const pc = cushion(0.44, 0.1, 0.42, 0.045, 0.014); pc.translate(sx * 0.5, 0.8, 0.2); b.add(pc, sx > 0 ? seatM2 : seatM); b.add(piping(0.43, 0.41, 0.045, 0.845).translate(sx * 0.5, 0, 0.2), sx > 0 ? seatM : seatM2); }
  }
  { // the bench: a moulded gelcoat base, three upholstered seat cushions with piping, three pleated back cushions
    const base = new THREE.BoxGeometry(1.94, 0.26, 0.56); base.translate(0, 0.53, 2.06); b.add(base, gel(WHITE));
    for (const cx of [-0.63, 0, 0.63]) {
      const sc = cushion(0.61, 0.16, 0.54, 0.055, 0.018); sc.translate(cx, 0.74, 2.04); b.add(sc, seatM);
      b.add(piping(0.6, 0.53, 0.055, 0.81).translate(cx, 0, 2.04), seatM2);
      const bk = cushion(0.61, 0.46, 0.13, 0.05, 0.016, 2); bk.rotateX(-0.12); bk.translate(cx, 1.08, 2.31); b.add(bk, seatM2);
    }
  }
  // rub rail along the gunwale, bow rails, cleats
  { const rail = []; for (let k = 0; k <= 40; k++) { const s = stationAt(SPEED, -3.28 + 6.46 * (k / 40)); rail.push(V(s.hg + 0.01, s.ys - 0.02, s.z)); }
    for (const sx of [1, -1]) b.add(pipe(rail.map((p) => V(p.x * sx, p.y, p.z)), 0.035, 6, 120), M.darkMetal()); }
  if (lv) {
    for (const sx of [1, -1]) { // bow rail on stanchions
      const pts = []; for (let k = 0; k <= 8; k++) { const z = -3.0 + 1.6 * (k / 8), s = stationAt(SPEED, z); pts.push(V(sx * Math.max(0.05, s.hg - 0.08), s.ys + 0.38, z)); }
      b.add(pipe(pts, 0.016, 6, 40), chrome);
      for (const k of [0, 4, 8]) { const p = pts[k], s = stationAt(SPEED, p.z); b.add(bar(V(p.x, s.ys - 0.01, p.z), p, 0.03, 0.03, true, 6), chrome); }
    }
    for (const [sx, z] of [[1, -2.5], [-1, -2.5], [1, 2.9], [-1, 2.9]]) { const s = stationAt(SPEED, z), cl = new THREE.BoxGeometry(0.05, 0.05, 0.2); cl.translate(sx * (s.hg - 0.06), s.ys + 0.02, z); nb.add(cl, chrome); }
    // the cockpit's furniture: upholstered side bolsters along both inner gunwales, a snap-in carpet, cup holders in the
    // gunwale tops, speaker grilles low on the side panels and a grab handle for the passenger
    const carpet = mat('carpet', () => relief(new THREE.MeshStandardMaterial({ color: 0x3b3e43, metalness: 0, roughness: 0.96 }), 'float h = (rN(vRelP * 700.0) - 0.5) * 0.8 + (rN(vRelP * 90.0) - 0.5) * 0.3; float k = 0.0007;', 'carpet'));
    { const m = new THREE.Shape(), hw = 0.82, z0 = -0.52, z1 = 1.74, rr = 0.12; m.moveTo(-hw + rr, z0); m.lineTo(hw - rr, z0); m.quadraticCurveTo(hw, z0, hw, z0 + rr); m.lineTo(hw, z1 - rr); m.quadraticCurveTo(hw, z1, hw - rr, z1); m.lineTo(-hw + rr, z1); m.quadraticCurveTo(-hw, z1, -hw, z1 - rr); m.lineTo(-hw, z0 + rr); m.quadraticCurveTo(-hw, z0, -hw + rr, z0);
      const mg = new THREE.ExtrudeGeometry(m, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.006, bevelSegments: 2, curveSegments: 6 }); mg.rotateX(Math.PI / 2); mg.translate(0, 0.418, 0); b.add(mg, carpet); }
    for (const sx of [1, -1]) {
      const bl = cushion(0.09, 0.2, 2.25, 0.04, 0.012); bl.translate(sx * 0.975, 0.74, 0.63); b.add(bl, seatM);
      b.add(piping(0.09, 2.25, 0.04, 0.84).translate(sx * 0.975, 0, 0.63), seatM2);
      for (const z of [0.25, 1.45]) { const ring = new THREE.TorusGeometry(0.045, 0.008, 8, 24); ring.rotateX(Math.PI / 2); ring.translate(sx * 1.05, 0.905, z); nb.add(ring, chrome);
        const cup = new THREE.CylinderGeometry(0.042, 0.04, 0.012, 20); cup.translate(sx * 1.05, 0.9, z); nb.add(cup, M.black()); }
      for (const z of [0.55, 1.45]) { const g2 = new THREE.CylinderGeometry(0.075, 0.075, 0.01, 28); g2.rotateZ(Math.PI / 2); g2.translate(sx * 0.985, 0.54, z); nb.add(g2, M.black());
        const r2 = new THREE.TorusGeometry(0.078, 0.008, 6, 28); r2.rotateY(Math.PI / 2); r2.translate(sx * 0.98, 0.54, z); nb.add(r2, chrome); }
    }
    { const hpts = []; for (let k = 0; k <= 10; k++) { const t = k / 10; hpts.push(V(-1.02, 0.905 + Math.sin(t * Math.PI) * 0.07, -0.55 + t * 0.32)); } b.add(pipe(hpts, 0.013, 8, 30), chrome); } // grab handle
    // spray strakes along the bottom (each half sunk into the skin)
    for (const f of [0.35, 0.68]) for (const sx of [1, -1]) {
      const pts = []; for (let k = 0; k <= 20; k++) { const z = -2.4 + 5.4 * (k / 20), s = stationAt(SPEED, z); pts.push(V(sx * s.hc * f, s.yk + (s.yc - s.yk) * f - 0.004, z)); }
      b.add(pipe(pts, 0.022, 4, 40), gel(WHITE));
    }
  }
  b.to(g); nb.to(g, true);
  g.userData.seats = [{ p: [0.5, 0.82, 0.3], s: 1, fit: { at: [0.5, 0.77, 0.42], dims: [0.5, 0.55, 0.46, 0.2], floor: 0.433 }, helm: { col: [0, 0.36, -0.5], tilt: 0.42 } }, { p: [-0.5, 0.82, 0.3], s: 1, role: 'crew', fit: { at: [-0.5, 0.77, 0.42], dims: [0.5, 0.55, 0.46, 0.2], floor: 0.433 } }]; // driver to starboard (fit: the bucket seats' seatGeo and the carpet's top, so the crew sit on them, feet on the floor)
  return g;
}

// Jet ski: a short planing hull with footwells either side of a saddle, a hood with handlebars.
const SKI = dense([
  st(-1.6, 0.42, 0.0, 0.42, 0.0, 0.62, 0.62, 0.0), st(-1.35, 0.1, 0.3, 0.26, 0.38, 0.62, 0.62, 0.05), st(-0.9, -0.06, 0.48, 0.13, 0.56, 0.6, 0.6, 0.06),
  st(-0.35, -0.12, 0.54, 0.09, 0.6, 0.56, 0.56, 0.08), st(-0.25, -0.12, 0.55, 0.09, 0.6, 0.56, 0.3, 0.1), st(1.15, -0.13, 0.55, 0.07, 0.59, 0.52, 0.3, 0.1),
  st(1.25, -0.13, 0.55, 0.07, 0.59, 0.52, 0.48, 0.1), st(1.6, -0.12, 0.53, 0.08, 0.57, 0.5, 0.48, 0.1),
]);
export const SKI_TRANSOM = { y: -0.12, z: 1.6 };
function jetSkiHull(c, lv) {
  const g = new THREE.Group();
  hullSkin(g, SKI, { bottom: 0x2b2d31, stripe: WHITE, side: c, deck: WHITE, floor: 0x2b2d31 });
  const b = new Bag(), paint = gel(c);
  // the saddle: a raised spine down the middle, the seat on top of it
  { const spine = new THREE.BoxGeometry(0.42, 0.42, 1.55); spine.translate(0, 0.5, 0.48); b.add(spine, paint);
    const seat = new THREE.CapsuleGeometry(0.2, 1.2, 6, 14); seat.rotateX(Math.PI / 2); seat.scale(1, 0.55, 1); seat.translate(0, 0.74, 0.5); b.add(seat, vinyl(0x15161a)); }
  // hood over the bow, steering column and handlebars
  { const hood = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2); hood.scale(0.42, 0.3, 0.75); hood.translate(0, 0.56, -0.62); b.add(hood, paint);
    const hb = new THREE.CircleGeometry(1, 24); hb.rotateX(Math.PI / 2); hb.scale(0.42, 1, 0.75); hb.translate(0, 0.56, -0.62); b.add(hb, paint); // (its underside, on the deck)
    const col = bar(V(0, 0.75, -0.36), V(0, 1.01, -0.245), 0.09, 0.09, true, 10); b.add(col, M.black());
    b.add(bar(V(-0.34, 1.0, -0.24), V(0.34, 1.0, -0.24), 0.035, 0.035, true, 8), M.darkMetal());
    for (const sx of [1, -1]) b.add(bar(V(sx * 0.26, 1.0, -0.24), V(sx * 0.37, 1.0, -0.24), 0.045, 0.045, true, 8), rubberM());
    const glass = new THREE.BoxGeometry(0.4, 0.14, 0.03); glass.rotateX(-0.6); glass.translate(0, 0.86, -0.42); b.add(glass, M.black()); }
  if (lv) { // grab handle behind the seat, sponsons
    b.add(pipe([V(-0.16, 0.69, 1.2), V(-0.16, 0.8, 1.27), V(0.16, 0.8, 1.27), V(0.16, 0.69, 1.2)], 0.016, 6, 24), M.darkMetal()); // (its feet in the saddle)
    for (const sx of [1, -1]) { const sp = new THREE.BoxGeometry(0.05, 0.06, 0.5); sp.translate(sx * 0.565, 0.1, 1.15); b.add(sp, M.black()); }
  }
  b.to(g);
  // ridden like a motorbike (crew.js 'bars'): feet in the footwells, hands on the handlebar grips
  g.userData.seats = [{ p: [0, 0.82, 0.32], s: 1, ctl: 'bars', rider: 'boat', pegs: [[-0.36, 0.33, 0.28], [0.36, 0.33, 0.28]], ground: 0.3 }];
  g.userData.grips = [{ o: g, p: V(-0.33, 1.0, -0.24) }, { o: g, p: V(0.33, 1.0, -0.24) }];
  return g;
}

// Pontoon: two aluminium tubes under a carpeted deck with a fence, couches round the edge and a helm console.
const TUBE = [[-3.55, 0], [-3.4, 0.16], [-3.15, 0.27], [-2.8, 0.32], [-2.3, 0.34], [3.15, 0.34], [3.3, 0.3], [3.4, 0]];
function revolveZ(prof, segs = 24) {
  const pts = prof.map(([z, r]) => new THREE.Vector2(Math.max(1e-3, r), z));
  const geo = new THREE.LatheGeometry(pts, segs); geo.rotateX(Math.PI / 2); // lathe axis y -> z (nose at -z)
  return geo;
}
export const PONTOON_TRANSOM = { y: 0.55, z: 3.25 };
function pontoonHull(c, lv) {
  const g = new THREE.Group(), alu = M.aluminum(), b = new Bag();
  for (const sx of [1, -1]) { const t = new THREE.Mesh(revolveZ(TUBE, 28), alu); t.position.x = sx * 1.05; t.userData.hull = true; g.add(t); }
  { const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.22, 6.5), nonSkid(0x5a6670)); deck.position.set(0, 0.42, 0); deck.userData.hull = true; g.add(deck); } // (sits 1 cm into the tubes)
  // fence: posts, a top rail and painted panels, with a gate at the bow
  const panel = gel(c), y0 = 0.53, y1 = 1.28;
  const ring = [V(-1.25, 0, -2.6), V(-1.25, 0, 3.1), V(1.25, 0, 3.1), V(1.25, 0, -2.6)];
  for (let k = 0; k < 3; k++) {
    const a = ring[k], e = ring[k + 1], L = a.distanceTo(e), n = Math.max(1, Math.round(L / 1.6));
    for (let i = 0; i <= n; i++) { const p = a.clone().lerp(e, i / n); b.add(bar(V(p.x, y0 - 0.01, p.z), V(p.x, y1, p.z), 0.045, 0.045, true, 8), alu); }
    const pn = new THREE.BoxGeometry(Math.abs(e.x - a.x) || 0.03, y1 - y0 - 0.2, Math.abs(e.z - a.z) || 0.03); pn.translate((a.x + e.x) / 2, (y0 + y1) / 2 - 0.05, (a.z + e.z) / 2); b.add(pn, panel);
    b.add(bar(V(a.x, y1, a.z), V(e.x, y1, e.z), 0.05, 0.05, true, 8), alu);
  }
  for (const sx of [1, -1]) { // the bow: short fence returns either side of the gate
    b.add(bar(V(sx * 1.25, y1, -2.6), V(sx * 0.45, y1, -2.6), 0.05, 0.05, true, 8), alu); b.add(bar(V(sx * 0.45, y0 - 0.01, -2.6), V(sx * 0.45, y1, -2.6), 0.045, 0.045, true, 8), alu);
    const pn = new THREE.BoxGeometry(0.8, y1 - y0 - 0.2, 0.03); pn.translate(sx * 0.85, (y0 + y1) / 2 - 0.05, -2.6); b.add(pn, panel);
  }
  // couches along the sides and across the stern, the helm console and its seat
  const cush = vinyl(WHITE), trim = vinyl(0x1d4e89);
  for (const sx of [1, -1]) { const s = new THREE.BoxGeometry(0.55, 0.38, 3.2); s.translate(sx * 0.92, 0.72, 0.9); b.add(s, cush); const bk = new THREE.BoxGeometry(0.14, 0.4, 3.2); bk.translate(sx * 1.16, 1.1, 0.9); b.add(bk, trim); }
  { const s = new THREE.BoxGeometry(1.3, 0.38, 0.55); s.translate(0, 0.72, 2.75); b.add(s, cush); }
  { const con = new THREE.BoxGeometry(0.6, 0.62, 0.55); con.translate(0.85, 0.84, -1.4); b.add(con, gel(WHITE)); const dash = new THREE.BoxGeometry(0.56, 0.04, 0.3); dash.rotateX(-0.3); dash.translate(0.85, 1.16, -1.3); b.add(dash, M.black());
    const ped = new THREE.CylinderGeometry(0.07, 0.1, 0.3, 12); ped.translate(0.85, 0.68, -0.4); b.add(ped, M.chrome()); const s = seatGeo(0.5, 0.55, 0.46, 0.2); s.translate(0.85, 0.83, -0.25); b.add(s, cush); }
  if (lv) { // bimini top on two hoops
    const top = new THREE.BoxGeometry(2.3, 0.03, 2.2); top.translate(0, 2.12, -0.6); b.add(top, vinyl(0x1d4e89));
    for (const z of [-1.6, 0.4]) b.add(pipe([V(-1.25, y1 - 0.02, z), V(-1.2, 1.9, z), V(-0.9, 2.11, z), V(0.9, 2.11, z), V(1.2, 1.9, z), V(1.25, y1 - 0.02, z)], 0.022, 6, 40), alu);
  }
  b.to(g);
  g.userData.seats = [{ p: [0.85, 0.88, -0.38], s: 1 }];
  return g;
}

// Workboat: a beamy, high-bowed hull with a working deck behind bulwarks, a fat rubber fender all round and a bow pudding.
const WORK = dense([
  st(-5.0, 1.15, 0.0, 1.25, 0.0, 2.05, 2.05, 0.0), st(-4.6, 0.35, 0.8, 0.65, 1.0, 1.95, 1.6, 0.16), st(-3.8, -0.25, 1.45, 0.28, 1.6, 1.8, 1.42, 0.16),
  st(-2.5, -0.52, 1.7, 0.12, 1.78, 1.66, 1.3, 0.16), st(0.0, -0.6, 1.76, 0.06, 1.82, 1.55, 1.24, 0.16), st(3.5, -0.56, 1.72, 0.06, 1.78, 1.5, 1.2, 0.16),
  st(4.75, -0.44, 1.62, 0.1, 1.68, 1.5, 1.2, 0.16), st(4.85, -0.42, 1.61, 0.11, 1.67, 1.5, 1.5, 0.16), st(5.0, -0.38, 1.6, 0.13, 1.65, 1.5, 1.5, 0.16),
]);
export const WORK_DECK = (z) => stationAt(WORK, z).yd;
export const WORK_BOTTOM = (x, z) => { const s = stationAt(WORK, z); return s.yk + (s.yc - s.yk) * Math.min(1, Math.abs(x) / Math.max(0.01, s.hc)); };
function workHull(c, lv) {
  const g = new THREE.Group();
  hullSkin(g, WORK, { bottom: 0x8a2a22, stripe: WHITE, side: c, deck: WHITE, floor: 0x7a7f86 });
  const b = new Bag(), rub = rubberM();
  { const pts = []; for (let k = 0; k <= 48; k++) { const s = stationAt(WORK, -4.95 + 9.9 * (k / 48)); pts.push(V(s.hg + 0.02, s.ys - 0.25, s.z)); }
    for (const sx of [1, -1]) b.add(pipe(pts.map((p) => V(p.x * sx, p.y, p.z)), 0.11, 8, 140), rub); }
  { const pud = new THREE.CapsuleGeometry(0.28, 0.9, 6, 14); pud.rotateZ(Math.PI / 2); pud.translate(0, 1.55, -5.0); b.add(pud, rub); }
  { const st2 = stationAt(WORK, 4.9), stern = new THREE.CapsuleGeometry(0.16, 2.6, 6, 12); stern.rotateZ(Math.PI / 2); stern.translate(0, st2.ys - 0.3, 5.02); b.add(stern, rub); }
  if (lv) for (const [sx, z] of [[1, -3.6], [-1, -3.6], [1, 4.3], [-1, 4.3]]) { // bitts on the deck
    const s = stationAt(WORK, z), y = s.yd - 0.01; for (const dz of [-0.15, 0.15]) { const p = new THREE.CylinderGeometry(0.07, 0.07, 0.35, 10); p.translate(sx * (s.hg - 0.45), y + 0.175, z + dz); b.add(p, M.darkMetal()); }
  }
  b.to(g);
  return g;
}

// ---------- propulsion ----------
// Outboard motor. Origin: where its clamp bracket sits on the transom's top edge (the transom face at z = 0, the motor
// behind it at +z). The whole motor swivels about the steering axis to steer; the propeller is at the foot of the leg.
const OB = { pivotZ: 0.32, prop: [0, -1.22, 0.66], legBot: -1.2 };
function outboard(c, lv) {
  const g = new THREE.Group(), b = new Bag(), sw = new THREE.Group(), sb = new Bag(), paint = gel(c), black = M.black();
  // clamp bracket on the transom (stays put)
  { const br = new THREE.BoxGeometry(0.26, 0.34, 0.36); br.translate(0, -0.08, OB.pivotZ / 2 - 0.02); b.add(br, black);
    const lip = new THREE.BoxGeometry(0.3, 0.06, 0.16); lip.translate(0, 0.07, 0.04); b.add(lip, black); }
  sw.position.z = OB.pivotZ; // the swivelling motor, built about its steering axis
  const loc = (x, y, z) => V(x, y, z - OB.pivotZ);
  if (lv) { // a moulded cowling: rounded nose towards the boat, widest near the back, a flatter top; the black lower cowl
    // below the parting line, vent slots at the back of the top and a stripe decal down each side
    const loft = (z0, z1, wF, hTop, hBot, n, N = 18, S = 28) => { const rings = [];
      for (let k = 0; k <= N; k++) { const t = k / N, z = z0 + (z1 - z0) * t, w = wF(t), top = hTop(t), bot = hBot(t), cy = (top + bot) / 2, hh = (top - bot) / 2, ring = [];
        for (let i = 0; i < S; i++) { const a2 = (i / S) * Math.PI * 2, ca = Math.cos(a2), sa = Math.sin(a2); ring.push(V(Math.sign(ca) * Math.abs(ca) ** (2 / n) * w, cy + Math.sign(sa) * Math.abs(sa) ** (2 / (sa > 0 ? n * 1.3 : n)) * hh, z - OB.pivotZ)); }
        rings.push(ring); } return ringLoft(rings, true, true); };
    const wUp = (t) => 0.235 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.94)), 0.45) * (0.82 + 0.18 * t);
    sb.add(loft(0.02, 0.84, wUp, (t) => 0.75 - 0.07 * (1 - t) ** 2, () => 0.24, 2.6), paint); // top cowl
    sb.add(loft(0.08, 0.78, (t) => wUp(t) * 0.86, () => 0.26, () => -0.02, 2.4), black); // lower cowl
    for (const sx of [1, -1]) {
      for (let k = 0; k < 3; k++) { const v = new THREE.BoxGeometry(0.012, 0.018, 0.1); v.rotateZ(sx * 0.5); v.translate(sx * 0.13, 0.7, 0.58 + k * 0.045 - OB.pivotZ); sb.add(v, black); } // vents
      const dec = new THREE.BoxGeometry(0.004, 0.05, 0.5); dec.translate(sx * 0.226, 0.46, 0.5 - OB.pivotZ); sb.add(dec, gel(0xf2f2ee)); // stripe decal
    }
  } else { const cowl = new THREE.CapsuleGeometry(0.24, 0.32, 6, 16); cowl.rotateX(Math.PI / 2); cowl.scale(0.95, 1.25, 1); cowl.translate(0, 0.42, 0.42 - OB.pivotZ); sb.add(cowl, paint);
    const cap = new THREE.BoxGeometry(0.36, 0.08, 0.5); cap.translate(0, 0.73, 0.44 - OB.pivotZ); sb.add(cap, black);
    const neck = new THREE.BoxGeometry(0.3, 0.3, 0.36); neck.translate(0, 0.08, 0.4 - OB.pivotZ); sb.add(neck, black); }
  { // the leg: a streamlined column from under the cowling to the gearcase, an anti-ventilation plate, the torpedo and skeg
    const leg = new THREE.CylinderGeometry(0.11, 0.08, 1.36, 12); leg.scale(0.6, 1, 1.6); leg.translate(0, -0.53, 0.44 - OB.pivotZ); sb.add(leg, black); // (down into the gearcase)
    const plate = new THREE.BoxGeometry(0.42, 0.025, 0.42); plate.translate(0, -0.92, 0.44 - OB.pivotZ); sb.add(plate, black);
    const torp = new THREE.CapsuleGeometry(0.075, 0.42, 6, 12); torp.rotateX(Math.PI / 2); torp.translate(0, OB.prop[1], 0.45 - OB.pivotZ); sb.add(torp, black);
    const skeg = bar(loc(0, OB.prop[1] - 0.05, 0.42), loc(0, OB.prop[1] - 0.26, 0.5), 0.02, 0.12); sb.add(skeg, black); }
  sb.to(sw);
  const prop = screw(0.2, 3, M.steel()); prop.position.set(0, OB.prop[1], OB.prop[2] - 0.01 - OB.pivotZ); sw.add(prop);
  g.add(sw); b.to(g);
  g.userData.strut = sw; g.userData.fan = prop;
  return g;
}
// A three-bladed propeller about z (blades twisted), hub towards -z. Group so it can spin as one.
function screw(R, n, m) {
  const g = new THREE.Group(), b = new Bag();
  const hub = new THREE.CapsuleGeometry(R * 0.28, R * 0.6, 4, 10); hub.rotateX(Math.PI / 2); b.add(hub, m);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, blade = new THREE.SphereGeometry(1, 12, 6); blade.scale(R * 0.55, R * 0.04, R * 0.32);
    blade.translate(R * 0.5, 0, 0); blade.rotateX(0.5); blade.rotateZ(a); b.add(blade, m);
  }
  b.to(g); return g;
}
// Propeller and rudder under the hull (an inboard engine drives it through the shaft). Origin: the strut's foot on the
// hull bottom. The rudder blade (behind the propeller) turns to steer.
const IB = { prop: [0, -0.42, 0.42], rudder: [0, -0.42, 0.85] };
function inboard(c, lv) {
  const g = new THREE.Group(), b = new Bag(), steel = M.steel(), bronze = mat('bronze', () => new THREE.MeshStandardMaterial({ color: 0xb08a4a, metalness: 1, roughness: 0.3 }));
  { const flange = new THREE.BoxGeometry(0.32, 0.14, 0.7); flange.translate(0, 0.05, 0.2); b.add(flange, M.darkMetal()); // (half sunk into the hull)
    b.add(bar(V(0, 0.05, -0.2), V(0, IB.prop[1], IB.prop[2] - 0.25), 0.07, 0.07, true, 10), steel); // the shaft, out of the hull
    b.add(bar(V(0, 0.02, 0.25), V(0, IB.prop[1] + 0.02, IB.prop[2] - 0.2), 0.03, 0.12), M.darkMetal()); // shaft strut
    const brg = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 10); brg.rotateX(Math.PI / 2); brg.translate(0, IB.prop[1], IB.prop[2] - 0.2); b.add(brg, M.darkMetal());
    b.add(bar(V(0, 0.06, 0.85), V(0, IB.rudder[1] + 0.25, IB.rudder[2]), 0.05, 0.05, true, 8), steel); } // rudder stock
  const prop = screw(0.26, 3, bronze); prop.position.set(0, IB.prop[1], IB.prop[2]); g.add(prop);
  const rud = new THREE.Group(); rud.position.set(0, 0, IB.rudder[2]);
  { const r = new Bag(), blade = new THREE.BoxGeometry(0.035, 0.5, 0.36); blade.translate(0, IB.rudder[1], 0.1); r.add(blade, steel); r.to(rud); }
  g.add(rud); b.to(g);
  g.userData.strut = rud; g.userData.fan = prop;
  return g;
}
// Water jet: an intake under the hull, a pump behind it and a nozzle out of the transom that swivels to steer.
// Origin: the bottom of the transom on the keel line (the transom face at z = 0).
const WJ = { intake: [0, -0.02, -0.75], nozzle: [0, 0.1, 0.34], pivotZ: 0.12 };
function waterJet(c, lv) {
  const g = new THREE.Group(), b = new Bag(), black = M.black(), steel = M.steel();
  { const grate = new THREE.BoxGeometry(0.3, 0.05, 0.6); grate.translate(0, 0.0, -0.72); b.add(grate, black); // (half in the hull bottom)
    const pump = new THREE.CylinderGeometry(0.14, 0.12, 0.5, 14); pump.rotateX(Math.PI / 2); pump.translate(0, 0.1, -0.12); b.add(pump, steel);
    const plate = new THREE.BoxGeometry(0.4, 0.03, 0.35); plate.translate(0, -0.03, 0.14); b.add(plate, steel);
    const duct = new THREE.BoxGeometry(0.22, 0.14, 0.5); duct.translate(0, 0.03, -0.4); b.add(duct, black); }
  const nz = new THREE.Group(); nz.position.z = WJ.pivotZ;
  { const n = new Bag(), cone = new THREE.CylinderGeometry(0.075, 0.115, 0.3, 14); cone.rotateX(Math.PI / 2); cone.translate(0, WJ.nozzle[1], 0.12); n.add(cone, steel);
    const ring = new THREE.TorusGeometry(0.082, 0.014, 6, 16); ring.translate(0, WJ.nozzle[1], 0.27); n.add(ring, black); n.to(nz); }
  g.add(nz); b.to(g);
  const imp = new THREE.Group(); imp.position.set(0, 0.1, 0.12); g.add(imp); // (the impeller, hidden in the pump: spun so the sound follows)
  g.userData.strut = nz;
  return g;
}

// ---------- fittings ----------
// Wheelhouse: a cabin with glass all round, a helm inside, a roof with a mast, a searchlight and work lights.
function wheelhouse(c, lv) {
  const g = new THREE.Group(), b = new Bag(), paint = gel(c), white = gel(WHITE), W = 2.4, D = 2.4, H0 = 1.05, H1 = 2.1;
  for (const [x, z, w, d] of [[0, -D / 2, W, 0.08], [0, D / 2, W, 0.08], [-W / 2, 0, 0.08, D], [W / 2, 0, 0.08, D]]) { const p = new THREE.BoxGeometry(w, H0, d); p.translate(x, H0 / 2 - 0.02, z); b.add(p, paint); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = new THREE.BoxGeometry(0.1, H1 - H0 + 0.02, 0.1); p.translate(sx * (W / 2 - 0.01), (H0 + H1) / 2, sz * (D / 2 - 0.01)); b.add(p, white); }
  { const roof = new THREE.BoxGeometry(W + 0.3, 0.12, D + 0.3); roof.translate(0, H1 + 0.05, 0); b.add(roof, white); }
  const glass = M.glass(0x5f7f96);
  for (const [x, z, w, d] of [[0, -D / 2, W - 0.1, 0.02], [0, D / 2, W - 0.1, 0.02], [-W / 2, 0, 0.02, D - 0.1], [W / 2, 0, 0.02, D - 0.1]]) { const p = new THREE.BoxGeometry(w, H1 - H0, d); p.translate(x, (H0 + H1) / 2, z); g.add(new THREE.Mesh(p, glass)); }
  { const helm = new THREE.BoxGeometry(1.4, 0.95, 0.45); helm.translate(0, 0.475, -D / 2 + 0.28); b.add(helm, M.black());
    const s = seatGeo(0.5, 0.55, 0.46, 0.2); s.translate(0.4, 0.42, 0.1); b.add(s, vinyl(0x2b2d31)); const ped = new THREE.CylinderGeometry(0.07, 0.1, 0.46, 10); ped.translate(0.4, 0.21, -0.05); b.add(ped, M.chrome()); }
  { const mast = new THREE.CylinderGeometry(0.06, 0.08, 1.4, 10); mast.translate(0, H1 + 0.8, 0.5); b.add(mast, white);
    const yard = bar(V(-0.6, H1 + 1.3, 0.5), V(0.6, H1 + 1.3, 0.5), 0.06, 0.06, true, 8); b.add(yard, white);
    const sl = new THREE.CylinderGeometry(0.16, 0.13, 0.3, 14); sl.rotateX(Math.PI / 2); sl.translate(0, H1 + 0.3, -0.7); b.add(sl, M.black());
    const base = new THREE.CylinderGeometry(0.08, 0.1, 0.2, 10); base.translate(0, H1 + 0.16, -0.7); b.add(base, M.black());
    for (const [sx, col] of [[-1, 0xff2020], [1, 0x2050ff]]) { const l = new THREE.SphereGeometry(0.09, 10, 8); l.translate(sx * 0.55, H1 + 1.42, 0.5); b.add(l, PM.light(col)); } }
  b.to(g);
  g.userData.seats = [{ p: [0.4, 0.47, -0.05], s: 1, ctl: 'wheel' }];
  return g;
}
// Water cannon (a fire monitor): a pedestal, a swivel body and a nozzle aimed forward and up. The smoke button turns
// the water on (main.js / boatFX.js shoot it from userData-free data: d.cannon).
const CANNON = { tip: [0, 0.88, -0.86], dir: [0, 0.42, -0.91] };
function cannon(c, lv) {
  const g = new THREE.Group(), b = new Bag(), paint = gel(c), brass = mat('brass', () => new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.25 }));
  { const ped = new THREE.CylinderGeometry(0.1, 0.16, 0.5, 14); ped.translate(0, 0.24, 0); b.add(ped, paint);
    const body = new THREE.SphereGeometry(0.15, 14, 10); body.translate(0, 0.52, 0); b.add(body, paint);
    const d = V(...CANNON.dir), tip = V(...CANNON.tip), from = V(0, 0.52, 0);
    b.add(bar(from, tip.clone().addScaledVector(d, -0.18), 0.1, 0.1, true, 12), paint);
    b.add(bar(tip.clone().addScaledVector(d, -0.2), tip, 0.075, 0.075, true, 12), brass);
    if (lv) { const wheel = new THREE.TorusGeometry(0.09, 0.012, 6, 16); wheel.rotateY(Math.PI / 2); wheel.translate(0.16, 0.52, 0); b.add(wheel, M.black()); b.add(bar(V(0.08, 0.52, 0), V(0.16, 0.52, 0), 0.02, 0.02, true, 6), M.black()); b.add(bar(V(0.16, 0.42, 0), V(0.16, 0.62, 0), 0.016, 0.016, true, 6), M.black()); b.add(bar(V(0.16, 0.52, -0.1), V(0.16, 0.52, 0.1), 0.016, 0.016, true, 6), M.black()); } } // (the hand wheel on its spokes)
  b.to(g);
  return g;
}

// ---------- the parts ----------
// boatHull: { planing (0 = a displacement hull, 1 = gets up on the plane), cp (bottom pressure coefficient), lat (keel
// grip against sliding sideways), turn (how hard Arcade/Pilot let it turn, rad/s at speed), bank (lean into a turn) }
def({ id: 'h_speed', cat: 'boat', name: 'Speedboat Hull', desc: 'Deep-V speedboat with a windscreen, bucket seats and a helm. Add an Outboard at the back!', mass: 700, hp: 2400, color: 0xc8102e,
  boatHull: { planing: 1, cp: 0.42, lat: 2.6, turn: 0.75, bank: 0.42 }, build: (c, lv) => speedHull(c, lv) });
def({ id: 'h_pontoon', cat: 'boat', name: 'Pontoon Deck', desc: 'Two big tubes under a party deck with couches and a fence. Slow, steady and very hard to tip.', mass: 820, hp: 2600, color: 0x1d4e89,
  boatHull: { planing: 0.55, cp: 0.3, lat: 1.8, turn: 0.55, bank: 0.12 }, build: (c, lv) => pontoonHull(c, lv) });
def({ id: 'h_jetski', cat: 'boat', name: 'Jet Ski Hull', desc: 'A little hull you ride like a motorbike. Put a Water Jet at the back. Zoom!', mass: 260, hp: 1100, color: 0xf2b705,
  boatHull: { planing: 1, cp: 0.42, lat: 2.4, turn: 1.1, bank: 0.55 }, build: (c, lv) => jetSkiHull(c, lv) });
def({ id: 'h_work', cat: 'boat', name: 'Workboat Hull', desc: 'Big tough hull for tugs and fireboats, with a rubber fender all round. Put a Wheelhouse on deck.', mass: 3800, hp: 9000, color: 0xc8102e,
  boatHull: { planing: 0.3, cp: 0.3, lat: 3.2, turn: 0.45, bank: 0.16 }, build: (c, lv) => workHull(c, lv) });

// marine: { kind, thrust (N), vmax (m/s), propAt (what must be under water), thrustAt, steer (rad of swivel / rudder),
// pivotZ (the steering axis, part-local z) }
def({ id: 'm_outboard', cat: 'boat', name: 'Outboard Motor', desc: 'Clamps on the back of a boat and swivels to steer. Its propeller must be in the water.', mass: 220, hp: 900, color: 0x15161a,
  engine: { type: 'marine', kind: 'swivel', thrust: 7600, vmax: 25, propAt: OB.prop, thrustAt: OB.prop, steer: 0.5, pivotZ: OB.pivotZ, sound: 'outboard', idleRpm: 750, maxRpm: 3400, cyl: 6 },
  build: (c, lv) => outboard(c, lv) });
def({ id: 'm_inboard', cat: 'boat', name: 'Prop & Rudder', desc: 'An inboard engine turns a big propeller under the hull; the rudder behind it steers. Fit it underneath, at the back.', mass: 420, hp: 1400, color: 0x2b2d31,
  engine: { type: 'marine', kind: 'rudder', thrust: 12000, vmax: 17, propAt: IB.prop, thrustAt: IB.prop, rudderAt: IB.rudder, rudderArea: 0.18, steer: 0.6, pivotZ: IB.rudder[2], sound: 'inboard', idleRpm: 600, maxRpm: 2600, cyl: 8 },
  build: (c, lv) => inboard(c, lv) });
def({ id: 'm_jet', cat: 'boat', name: 'Water Jet', desc: 'Sucks water in underneath and squirts it out the back. The nozzle swivels to steer. Great for jet skis.', mass: 90, hp: 700, color: 0x8b9097,
  engine: { type: 'marine', kind: 'swivel', thrust: 4400, vmax: 27, propAt: WJ.intake, thrustAt: WJ.nozzle, steer: 0.42, pivotZ: WJ.pivotZ, sound: 'jetski', idleRpm: 1200, maxRpm: 4200, cyl: 3 },
  build: (c, lv) => waterJet(c, lv) });
def({ id: 'b_wheelhouse', cat: 'boat', name: 'Wheelhouse', desc: 'A cabin with windows all round and the captain at the wheel. Put it on a big deck.', mass: 650, hp: 2000, color: 0xc8102e,
  build: (c, lv) => wheelhouse(c, lv) });
def({ id: 'b_cannon', cat: 'boat', name: 'Water Cannon', desc: 'A fire monitor. Press the smoke button (or Space) to squirt water!', mass: 60, hp: 500, color: 0xc8102e, smoke: true, cannon: CANNON,
  build: (c, lv) => cannon(c, lv) });

// ---------- where things go on the stock boats (design.js presets) ----------
export const BOAT_AT = {
  speedOutboard: [0, SPEED_TRANSOM.y, SPEED_TRANSOM.z],
  skiJet: [0, SKI_TRANSOM.y, SKI_TRANSOM.z],
  pontoonOutboard: [0, PONTOON_TRANSOM.y, PONTOON_TRANSOM.z],
  workDeck: WORK_DECK, workBottom: WORK_BOTTOM,
};
