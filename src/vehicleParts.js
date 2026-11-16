// Extra parts for the stock vehicles: a buggy tub and roll cage, knobby off-road and monster tyres on long-travel
// suspension, a light bar, a rear wing, a pickup body for monster trucks and a bubble-nosed helicopter cabin.
// They register into PARTS like parts.js's own (same fields, same build(color, { detail }) contract), so the hangar,
// physics and save codes treat them like any other part.
import * as THREE from 'three';
import { PARTS, revolve, smoothProfile } from './parts.js';
import { M } from './materials.js';
import { PM, lightGeometry } from './planeMaterials.js';
import { V, bar, tube, Bag, seatGeo, flightDeckGlass } from './partDetail.js';
import { clipGeometry } from './skinBlend.js';

const cached = new Map();
const mat = (k, make) => { if (!cached.has(k)) cached.set(k, make()); return cached.get(k); };
const knobby = () => mat('knobby', () => new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0, roughness: 0.93 }));
const rimPaint = (c) => mat('rim' + c, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.75, roughness: 0.28, clearcoat: 0.6, clearcoatRoughness: 0.1 }));
const tubePaint = (c) => mat('tube' + c, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.12 }));

function ensureUv1(obj) {
  obj.traverse((m) => { const g = m.geometry; if (m.isMesh && !g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
  return obj;
}
function def(p) { const b = p.build; p.build = (c, o) => ensureUv1(b(c, o?.detail || 0)); PARTS[p.id] = p; }

// ---------- a boxy body: rounded-rectangle (superellipse) sections lofted along Z ----------
// secs: [{ z, hw, top, bot, n }] nose first; n = squareness (2 = ellipse, 4+ = boxy). Linear between sections (add
// sections for soft transitions). uv: u along the length, v around; uv1 in metres for the panel skin.
function superLoft(secs, segs = 40, capsOut = false) {
  const pos = [], uv = [], uv1 = [], idx = [], row = segs + 1, z0 = secs[0].z, z1 = secs.at(-1).z;
  const se = (t, n) => Math.sign(t) * Math.abs(t) ** (2 / n);
  for (const s of secs) {
    let arc = 0, prev = null;
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2, mid = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2;
      const x = s.hw * se(Math.sin(th), s.n || 3), y = mid + hh * se(Math.cos(th), s.n || 3);
      if (prev) arc += Math.hypot(x - prev[0], y - prev[1]); prev = [x, y];
      pos.push(x, y, s.z); uv.push((s.z - z0) / (z1 - z0), i / segs); uv1.push(s.z, arc);
    }
  }
  for (let j = 0; j < secs.length - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * row + i, b = (j + 1) * row + i, c = (j + 1) * row + i + 1, d = j * row + i + 1;
    idx.push(a, b, c, a, c, d);
  }
  const nSide = idx.length;
  for (const [j, front] of [[0, true], [secs.length - 1, false]]) { // caps
    const s = secs[j], ci = pos.length / 3; pos.push(0, (s.top + s.bot) / 2, s.z); uv.push(front ? 0 : 1, 0.5); uv1.push(s.z, 0);
    for (let i = 0; i < segs; i++) { const a = j * row + i, b = j * row + i + 1; front ? idx.push(ci, b, a) : idx.push(ci, a, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // winding: make sure the first quad faces away from the axis
  const p = g.attributes.position, n = g.attributes.normal, k = Math.floor(segs / 4) + row; // a vertex on the right side
  if (n.getX(k) * p.getX(k) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  // The caps above face into the body (culled: you looked through the nose and tail into the hollow tub). The plain part
  // keeps them (its volume centroid is a physics input); detail builds pass capsOut and get them facing out.
  if (capsOut) {
    const P = g.attributes.position, v = (i) => new THREE.Vector3().fromBufferAttribute(P, i), half = (idx.length - nSide) / 2;
    for (let i = nSide; i < idx.length; i += 3) {
      const nz = v(idx[i + 1]).sub(v(idx[i])).cross(v(idx[i + 2]).sub(v(idx[i]))).z, front = i < nSide + half;
      if (front ? nz > 0 : nz < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return g;
}
// soften a list of sections: insert midpoints blended with neighbours (cheap Chaikin pass on every parameter)
function chaikin(secs, passes = 2) {
  let s = secs;
  for (let k = 0; k < passes; k++) {
    const o = [s[0]];
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1], mix = (t) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + (b[key] - a[key]) * t]));
      o.push(mix(0.25), mix(0.75));
    }
    o.push(s.at(-1)); s = o;
  }
  return s;
}

// ---------- wheels ----------
// Knobby tyre around X: a lathe of the tyre section with staggered tread blocks (and shoulder lugs) pushed out.
function knobbyTyre(r, w, { blocks = 18, rim = 0.6, knob = 0.045 } = {}) {
  const NA = blocks * 8, prof = [];
  const ri = r * rim, sh = Math.min(r * 0.18, w * 0.3); // inner (bead) radius, shoulder rounding
  // section from the left bead round the tread to the right bead: [x, rho, tread?]
  for (let i = 0; i <= 4; i++) { const t = i / 4; prof.push([-w / 2 + 0.01 * Math.sin(t * Math.PI), ri + (r - sh - ri) * t, 0]); }
  for (let i = 1; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; prof.push([-w / 2 + sh - Math.cos(a) * sh, r - sh + Math.sin(a) * sh, i >= 2 ? 1 : 0.5]); }
  for (let i = 1; i < 6; i++) prof.push([-w / 2 + sh + (w - 2 * sh) * (i / 6), r, 1]);
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; prof.push([w / 2 - sh + Math.sin(a) * sh, r - sh + Math.cos(a) * sh, i <= 2 ? 1 : 0.5]); }
  for (let i = 1; i <= 4; i++) { const t = i / 4; prof.push([w / 2 - 0.01 * Math.sin(t * Math.PI), r - sh - (r - sh - ri) * t, 0]); }
  const pos = [], uv = [], idx = [], NP = prof.length;
  for (let a = 0; a <= NA; a++) {
    const ph = (a / NA) * Math.PI * 2, cell = Math.floor((a / NA) * blocks * 2 + 0.5) % (blocks * 2), sub = ((a / NA) * blocks * 2 + 0.5) % 1;
    for (let j = 0; j < NP; j++) {
      const [x, rho, tr] = prof[j], side = x > 0 ? 1 : 0;
      // block pattern: alternating left / right blocks, wide shoulder lugs every other block
      const onBlock = sub > 0.12 && sub < 0.88 && ((cell + side) % 2 === 0 ? Math.abs(x) > w * 0.04 : Math.abs(x) > w * 0.3);
      const lug = tr === 0.5 && (cell + side) % 2 === 0 && sub > 0.15 && sub < 0.85;
      const k = tr === 1 ? (onBlock ? knob : 0) : lug ? knob * 0.7 : 0;
      pos.push(x * (1 + (tr ? k * 0.4 : 0)), Math.cos(ph) * (rho + k), Math.sin(ph) * (rho + k)); uv.push(a / NA, j / (NP - 1));
    }
  }
  for (let a = 0; a < NA; a++) for (let j = 0; j < NP - 1; j++) { const i0 = a * NP + j, i1 = (a + 1) * NP + j; idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// Beadlock rim: barrel, a bolted ring on the outer face, six spokes and a hub cap (outer face towards +X).
function beadlockRim(r, w, color, lv) {
  const b = new Bag(), paint = rimPaint(color), steel = M.steel(), dark = M.darkMetal(), rr = r * 0.62;
  const barrel = new THREE.CylinderGeometry(rr, rr, w * 0.86, 28, 1, true); barrel.rotateZ(Math.PI / 2); b.add(barrel, dark);
  const ring = new THREE.TorusGeometry(rr * 0.97, r * 0.05, 8, 32); ring.rotateY(Math.PI / 2); ring.translate(w * 0.4, 0, 0); b.add(ring, paint);
  const face = new THREE.CylinderGeometry(rr * 0.92, rr * 0.92, 0.02, 28); face.rotateZ(Math.PI / 2); face.translate(w * 0.18, 0, 0); b.add(face, dark);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    b.add(bar(V(w * 0.32, c * rr * 0.22, s * rr * 0.22), V(w * 0.36, c * rr * 0.9, s * rr * 0.9), r * 0.11, r * 0.06), paint);
  }
  const hub = new THREE.CylinderGeometry(rr * 0.28, rr * 0.34, w * 0.2, 16); hub.rotateZ(-Math.PI / 2); hub.translate(w * 0.36, 0, 0); b.add(hub, paint);
  const cap = new THREE.CylinderGeometry(rr * 0.12, rr * 0.12, w * 0.08, 12); cap.rotateZ(Math.PI / 2); cap.translate(w * 0.48, 0, 0); b.add(cap, M.chrome());
  if (lv) for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, bolt = new THREE.CylinderGeometry(r * 0.018, r * 0.018, 0.03, 6); bolt.rotateZ(Math.PI / 2); bolt.translate(w * 0.43, Math.cos(a) * rr * 0.97, Math.sin(a) * rr * 0.97); b.add(bolt, steel); }
  return b;
}
// Off-road corner: knobby tyre on a beadlock rim, coil-over shock (body on the strut, shaft and spring ride with the
// wheel) and A-arms out to an inboard pivot. Same contract as parts.js gearLeg: origin = strut top, userData.strut /
// .wheels (children spin about X) / .steer / .wheelsFixed (follows the wheel without spinning).
function offroadCorner({ r, w, len, color, steer, lv, arm = 0.55, blocks = 18 }) {
  const g = new THREE.Group(), strut = new THREE.Group(), wheels = new THREE.Group(), fixed = new THREE.Group();
  wheels.position.y = -len; fixed.position.y = -len;
  const sB = new Bag(), fB = new Bag(), steel = M.steel(), chrome = M.chrome(), dark = M.darkMetal(), arms = tubePaint(0x26272b);
  const xi = -(w / 2 + r * 0.22); // shock line, just inboard of the tyre
  // shock body (on the chassis) and reservoir
  const body = new THREE.CylinderGeometry(r * 0.09, r * 0.09, len * 0.55, 12); body.translate(xi, -len * 0.27, 0); sB.add(body, M.paint(color, 'metal'));
  const cap = new THREE.CylinderGeometry(r * 0.12, r * 0.12, 0.05, 12); cap.translate(xi, -0.02, 0); sB.add(cap, dark);
  const res = new THREE.CylinderGeometry(r * 0.06, r * 0.06, len * 0.35, 10); res.translate(xi - r * 0.16, -len * 0.18, r * 0.06); sB.add(res, M.paint(color, 'metal'));
  // shaft + spring ride with the wheel
  const shaft = new THREE.CylinderGeometry(r * 0.04, r * 0.04, len * 0.7, 8); shaft.translate(xi, len * 0.35 + r * 0.1, 0); fB.add(shaft, chrome);
  const coil = []; for (let k = 0; k <= 48; k++) { const a = k * 0.85; coil.push(V(xi + Math.cos(a) * r * 0.13, r * 0.15 + (k / 48) * len * 0.62, Math.sin(a) * r * 0.13)); }
  fB.add(tube(coil, r * 0.022, 5, 120), M.paint(0xf2b705, 'gloss'));
  // knuckle and A-arms (upper and lower wishbones to an inboard pivot)
  const kn = new THREE.BoxGeometry(r * 0.16, r * 0.55, r * 0.22); kn.translate(-w * 0.32, 0, 0); fB.add(kn, dark);
  for (const [y, zz] of [[r * 0.24, r * 0.5], [-r * 0.18, r * 0.62]]) for (const sz of [-1, 1]) fB.add(bar(V(-w * 0.32, y, 0), V(-w / 2 - arm, y + r * 0.05, sz * zz), r * 0.07, r * 0.07, true, 8), arms);
  // chassis brackets carrying the arms' inboard pivots up to the mount (the pivots hung in the air under the body)
  if (lv) for (const sz of [-1, 1]) { const xp = -w / 2 - arm, zp = sz * r * 0.56; sB.add(bar(V(xp, -len - r * 0.2, zp), V(xp, 0.02, zp * 0.85), r * 0.13, r * 0.06), dark); sB.add(bar(V(xp, -len + r * 0.3, zp), V(xi, -0.02, 0), r * 0.06, r * 0.06, true, 6), dark); }
  const axle = new THREE.CylinderGeometry(r * 0.05, r * 0.05, w * 0.6, 8); axle.rotateZ(Math.PI / 2); axle.translate(-w * 0.2, 0, 0); fB.add(axle, steel);
  // the spinning wheel: tyre + rim
  const wh = new THREE.Group(); const tb = new Bag(); tb.add(knobbyTyre(r, w, { blocks }), knobby()); tb.to(wh); beadlockRim(r, w, color, lv).to(wh);
  wheels.add(wh);
  sB.to(strut); fB.to(fixed); strut.add(fixed); strut.add(wheels); g.add(strut);
  g.userData.strut = strut; g.userData.wheels = wheels; g.userData.steer = steer; g.userData.wheelsFixed = fixed;
  return g;
}

// ---------- body builders ----------
function buggyTub(c, lv) {
  const g = new THREE.Group();
  const S = chaikin([
    { z: -2.2, hw: 0.4, top: -0.08, bot: -0.22, n: 3 },
    { z: -2.05, hw: 0.6, top: -0.02, bot: -0.3, n: 3.5 },
    { z: -1.5, hw: 0.72, top: 0.08, bot: -0.34, n: 4 },
    { z: -0.85, hw: 0.76, top: 0.2, bot: -0.36, n: 4.5 },
    { z: -0.45, hw: 0.78, top: 0.28, bot: -0.36, n: 5 },
    { z: 0.75, hw: 0.78, top: 0.28, bot: -0.36, n: 5 },
    { z: 1.3, hw: 0.74, top: 0.22, bot: -0.33, n: 4.5 },
    { z: 1.85, hw: 0.66, top: 0.16, bot: -0.24, n: 4 },
    { z: 2.0, hw: 0.56, top: 0.1, bot: -0.14, n: 3.5 },
  ], 2);
  // detail: caps facing out (the plain part's nose and tail were see-through) and car paint instead of riveted panels
  const skin = lv ? PM.carPaint(c) : PM.skin(c);
  g.add(new THREE.Mesh(superLoft(S, 44, !!lv), skin));
  const scoop = superLoft(chaikin([{ z: -1.35, hw: 0.2, top: 0.24, bot: 0.06, n: 4 }, { z: -1.1, hw: 0.23, top: 0.31, bot: 0.1, n: 4 }, { z: -0.55, hw: 0.23, top: 0.38, bot: 0.2, n: 4 }, { z: -0.45, hw: 0.2, top: 0.36, bot: 0.24, n: 4 }], 1), 24, !!lv);
  g.add(new THREE.Mesh(scoop, skin));
  const b = new Bag(), dark = M.darkMetal(), tp = tubePaint(0x1a1b1e);
  const mouth = new THREE.BoxGeometry(0.3, 0.1, 0.02); mouth.translate(0, 0.17, -1.355); b.add(mouth, M.intake());
  // front bumper / nerf bars / skid plate
  b.add(tube([V(-0.55, -0.22, -2.0), V(-0.45, -0.18, -2.32), V(0, -0.16, -2.4), V(0.45, -0.18, -2.32), V(0.55, -0.22, -2.0)], 0.045, 8, 40), tp);
  b.add(tube([V(-0.5, 0.0, -2.05), V(-0.35, 0.05, -2.3), V(0.35, 0.05, -2.3), V(0.5, 0.0, -2.05)], 0.035, 8, 30), tp);
  const skid = new THREE.BoxGeometry(0.9, 0.04, 1.2); skid.translate(0, -0.37, -1.4); b.add(skid, M.aluminum());
  for (const sx of [-1, 1]) b.add(tube([V(sx * 0.7, -0.3, -0.9), V(sx * 0.86, -0.28, -0.6), V(sx * 0.86, -0.28, 0.6), V(sx * 0.7, -0.3, 0.9)], 0.04, 8, 30), tp);
  // rear: spare-wheel-style diffuser fins and tail lights
  for (const sx of [-0.3, 0, 0.3]) b.add(bar(V(sx, -0.25, 1.7), V(sx, -0.12, 2.05), 0.03, 0.12), dark);
  b.to(g);
  if (lv) {
    const tl = new Bag(); for (const sx of [-1, 1]) { const l = new THREE.BoxGeometry(0.16, 0.08, 0.02); l.translate(sx * 0.32, 0.08, 2.0); tl.add(l, M.light(0xff2010)); } tl.to(g, true);
  }
  return g;
}

function truckBody(c, lv) {
  const g = new THREE.Group();
  const S = chaikin([
    { z: -2.4, hw: 0.8, top: 0.4, bot: 0.02, n: 5 },
    { z: -2.28, hw: 0.9, top: 0.6, bot: -0.02, n: 6 },
    { z: -0.95, hw: 0.92, top: 0.7, bot: -0.02, n: 6 },
    { z: -0.75, hw: 0.92, top: 0.74, bot: -0.02, n: 6 },
    { z: -0.15, hw: 0.88, top: 1.38, bot: -0.02, n: 6 },
    { z: 0.75, hw: 0.88, top: 1.42, bot: -0.02, n: 6 },
    { z: 0.85, hw: 0.92, top: 0.8, bot: -0.02, n: 6 },
    { z: 2.25, hw: 0.92, top: 0.78, bot: -0.02, n: 6 },
    { z: 2.38, hw: 0.86, top: 0.72, bot: 0.02, n: 5 },
  ], 1);
  if (lv) truckCab(g, S, c); else g.add(new THREE.Mesh(superLoft(S, 48), PM.skin(c)));
  const b = new Bag(), tp = tubePaint(0x1a1b1e), dark = M.darkMetal();
  // ladder frame, axles, push bar, roof light mounts
  for (const sx of [-0.55, 0.55]) { const r = new THREE.BoxGeometry(0.12, 0.18, 4.6); r.translate(sx, -0.12, 0); b.add(r, dark); }
  for (const z of [-1.75, 1.75]) { const ax = new THREE.CylinderGeometry(0.09, 0.09, 2.3, 10); ax.rotateZ(Math.PI / 2); ax.translate(0, -0.55, z); b.add(ax, dark); const diff = new THREE.SphereGeometry(0.2, 12, 10); diff.translate(0, -0.55, z); b.add(diff, dark);
    for (const sx of [-0.55, 0.55]) b.add(bar(V(sx, -0.2, z), V(sx * 1.2, -0.55, z), 0.06, 0.06, true, 6), M.paint(0xf2b705, 'gloss')); }
  b.add(tube([V(-0.8, 0.05, -2.38), V(-0.6, 0.0, -2.62), V(0.6, 0.0, -2.62), V(0.8, 0.05, -2.38)], 0.06, 8, 30), tp);
  b.add(tube([V(-0.6, 0.0, -2.62), V(-0.5, 0.45, -2.6), V(0.5, 0.45, -2.6), V(0.6, 0.0, -2.62)], 0.045, 8, 30), tp);
  b.to(g);
  if (lv) { const tl = new Bag(); for (const sx of [-1, 1]) { const l = new THREE.BoxGeometry(0.12, 0.22, 0.02); l.translate(sx * 0.74, 0.5, 2.39); tl.add(l, M.light(0xff2010)); } tl.to(g, true); }
  return g;
}

// Detail build of the pickup body: car paint, real glass in the cab (windscreen, door windows, rear window) with a dark
// cab behind it, seats, a dash and a driver (crew.js); door and hood shut lines, door handles, mirrors and headlights.
const lerpSec = (a, b, t) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] - a[k]) * t]));
function densify(S, n) { const o = []; for (let i = 0; i < S.length - 1; i++) for (let k = 0; k < n; k++) o.push(lerpSec(S[i], S[i + 1], k / n)); o.push(S.at(-1)); return o; }
function secAt(S, z) { for (let i = 1; i < S.length; i++) if (S[i].z >= z) return lerpSec(S[i - 1], S[i], (z - S[i - 1].z) / (S[i].z - S[i - 1].z || 1)); return S.at(-1); }
const sideX = (s, y) => { const mid = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2, c = Math.max(-1, Math.min(1, (y - mid) / hh)), n = s.n || 3, t = Math.sign(c) * Math.abs(c) ** (n / 2); return s.hw * Math.sqrt(Math.max(0, 1 - t * t)) ** (2 / n); };
const topY = (s, x) => { const mid = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2, c = Math.max(-1, Math.min(1, x / s.hw)), n = s.n || 3, t = Math.abs(c) ** (n / 2); return mid + hh * Math.sqrt(Math.max(0, 1 - t * t)) ** (2 / n); };
function truckCab(g, S0, c) {
  const S = densify(S0, 3), geo = superLoft(S, 56, true), P = geo.attributes.position;
  // window openings as slab boxes (negative inside): the skin is clipped exactly along them, the glass is the rest
  const win = (x, y, z) => {
    const ax = Math.abs(x), band = Math.max(0.86 - y, y - 1.3);
    return Math.min(Math.max(band, -0.74 - z, z + 0.2, ax - 0.66), Math.max(band, -0.02 - z, z - 0.62, 0.55 - ax), Math.max(0.92 - y, y - 1.3, 0.7 - z, ax - 0.56));
  };
  const d = new Float32Array(P.count), nd = new Float32Array(P.count), v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); d[i] = win(v.x, v.y, v.z); nd[i] = -d[i]; }
  g.add(new THREE.Mesh(clipGeometry(geo, d) || geo, PM.carPaint(c)));
  const glass = clipGeometry(geo, nd); if (glass) g.add(new THREE.Mesh(glass, flightDeckGlass())); // tinted: the bubble-canopy glass went milky white in daylight
  // the cab seen through the glass: the skin's inside faces in a dark trim colour
  const inner = new THREE.Mesh(geo, mat('cabIn', () => new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.9, side: THREE.BackSide }))); inner.castShadow = false; g.add(inner);
  const b = new Bag(), nb = new Bag(), black = M.black(), chrome = M.chrome(), seam = M.paint(0x0b0c0e, 'matte');
  const dash = new THREE.BoxGeometry(1.6, 0.14, 0.34); dash.translate(0, 0.74, -0.58); b.add(dash, black);
  for (const sx of [-0.4, 0.4]) { const st = seatGeo(0.46, 0.62, 0.42, 0.22); st.translate(sx, 0.4, 0.42); b.add(st, PM.seat()); }
  g.userData.seats = [{ p: [-0.4, 0.44, 0.3], s: 1 }]; // driver on the left
  // shut lines (thin dark grooves just proud of the paint), door handles, mirrors
  const line = (pts) => nb.add(tube(pts, 0.007, 4, pts.length * 4), seam);
  for (const sx of [-1, 1]) {
    const at = (y, z) => V(sx * (sideX(secAt(S, z), y) + 0.004), y, z), col = (z) => { const o = []; for (let k = 0; k <= 8; k++) o.push(at(0.1 + 0.76 * (k / 8), z)); return o; };
    line(col(-0.12)); line(col(0.7)); { const o = []; for (let k = 0; k <= 10; k++) o.push(at(0.1, -0.12 + 0.82 * (k / 10))); line(o); }
    const h = new THREE.BoxGeometry(0.03, 0.04, 0.16); h.translate(sx * (sideX(secAt(S, 0.52), 0.72) + 0.015), 0.72, 0.52); nb.add(h, chrome);
    const arm = bar(V(sx * 0.86, 0.9, -0.12), V(sx * 1.02, 0.95, -0.14), 0.03, 0.03); b.add(arm, black);
    const mir = new THREE.BoxGeometry(0.05, 0.16, 0.11); mir.translate(sx * 1.05, 0.98, -0.14); b.add(mir, black);
    // hood seams
    const hood = []; for (let k = 0; k <= 10; k++) { const z = -2.25 + 1.42 * (k / 10), sec = secAt(S, z); hood.push(V(sx * 0.7, topY(sec, 0.7) + 0.004, z)); } line(hood);
    // headlights on the grille face, tail lights are on the plain part
    const hl = new THREE.CircleGeometry(0.075, 18); hl.rotateY(Math.PI); hl.translate(sx * 0.58, 0.24, -2.404); nb.add(hl, M.light(0xfff4d8));
    const ring = new THREE.TorusGeometry(0.08, 0.012, 6, 18); ring.translate(sx * 0.58, 0.24, -2.405); nb.add(ring, chrome);
  }
  { const o = []; for (let k = 0; k <= 12; k++) { const x = -0.7 + 1.4 * (k / 12); o.push(V(x, topY(secAt(S, -0.83), x) + 0.004, -0.83)); } line(o); } // cowl line at the back of the hood
  b.to(g); nb.to(g, true);
}

// Helicopter cabin: a body of revolution (so planeDetail can dress it like any fuselage) with a raised tail joint.
const HELI_PROF = [[-1.05, 0.0], [-1.05, 0.62], [-0.85, 0.82], [-0.2, 0.9], [0.6, 0.86], [1.3, 0.62], [1.9, 0.36], [2.3, 0.22]];
const heliYOff = (z) => (z > 0.5 ? (z - 0.5) * 0.2 : 0);
function heliCabin(c) {
  const g = new THREE.Group(), prof = smoothProfile(HELI_PROF, 40);
  g.add(new THREE.Mesh(revolve(prof, { sy: 1.12, sx: 0.92, yOff: heliYOff, segs: 40, cap: true }), PM.skin(c)));
  g.userData.body = { prof, sx: 0.92, sy: 1.12, yOff: heliYOff };
  // engine cowling hump on top, exhausts
  const hump = revolve(smoothProfile([[-0.2, 0], [0.0, 0.3], [0.8, 0.36], [1.5, 0.22], [1.75, 0]], 20), { segs: 24, sy: 0.7, sx: 1.1, cap: true }); hump.translate(0, 0.86, 0); g.add(new THREE.Mesh(hump, PM.skin(c)));
  const b = new Bag(); for (const sx of [-1, 1]) { const ex = new THREE.CylinderGeometry(0.08, 0.1, 0.32, 12); ex.rotateX(Math.PI / 2.6); ex.translate(sx * 0.3, 1.08, 1.45); b.add(ex, M.darkMetal()); } b.to(g);
  return g;
}
// Bubble nose: glass dome forward of the cabin bulkhead, painted chin, two seats, pilots, instrument console.
function heliNose(c, lv) {
  const g = new THREE.Group(), R = 0.86;
  const glass = new THREE.SphereGeometry(R, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.62); // dome around +Y, opening downwards
  glass.rotateX(-Math.PI / 2); glass.scale(0.95, 1.08, 1.45); // now opens towards +Z (the cabin)
  g.add(new THREE.Mesh(glass, PM.canopy(0x1d2a33)));
  const chin = new THREE.SphereGeometry(R * 1.015, 32, 10, Math.PI, Math.PI, Math.PI * 0.6, Math.PI * 0.4); // lower front quarter
  chin.scale(0.95, 1.08, 1.45); g.add(new THREE.Mesh(chin, PM.skin(c)));
  const frame = new THREE.TorusGeometry(R * 0.97, 0.035, 8, 40); frame.scale(0.95, 1.08, 1); g.add(new THREE.Mesh(frame, PM.skin(c)));
  const b = new Bag();
  if (lv) { // detail: the crew sit forward in the bubble (the cabin's front bulkhead is at z = 0), a low console ahead of them
    const con = new THREE.BoxGeometry(0.86, 0.12, 0.3); con.rotateX(-0.55); con.translate(0, -0.2, -0.92); b.add(con, M.black());
    for (const sx of [-0.3, 0.3]) { const st = seatGeo(0.42, 0.6, 0.38, 0.22); st.translate(sx, -0.34, 0.0); b.add(st, PM.seat()); }
    b.to(g);
    g.userData.seats = [{ p: [0.3, -0.32, -0.18], s: 0.8 }, { p: [-0.3, -0.32, -0.18], s: 0.8, role: 'crew' }]; // pilot right, rescue medic left
    return g;
  }
  const console_ = new THREE.BoxGeometry(0.9, 0.22, 0.35); console_.rotateX(-0.5); console_.translate(0, -0.12, -0.55); b.add(console_, M.black());
  for (const sx of [-0.3, 0.3]) {
    const seat = new THREE.BoxGeometry(0.42, 0.62, 0.12); seat.rotateX(-0.2); seat.translate(sx, -0.05, 0.15); b.add(seat, PM.seat());
    const cush = new THREE.BoxGeometry(0.42, 0.1, 0.4); cush.translate(sx, -0.33, -0.05); b.add(cush, PM.seat());
  }
  b.to(g);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), M.pilot()); helmet.position.set(0.3, 0.38, 0.0); g.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 8, -0.9, 1.8, 1.0, 0.7), M.visor()); visor.position.copy(helmet.position); visor.rotation.y = Math.PI; g.add(visor);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.45, 10), PM.seat()); torso.position.set(0.3, 0.05, 0.02); g.add(torso);
  return g;
}

// ---------- parts ----------
def({ id: 'fus_buggy', cat: 'fuselage', name: 'Buggy Tub', desc: 'Low, tough off-road racer body with a bumper and nerf bars. Add a cage, a motor and big wheels.', mass: 260, hp: 1100, color: 0x15161a,
  build: (c, lv) => buggyTub(c, lv) });
def({ id: 'fus_truck', cat: 'fuselage', name: 'Monster Truck Body', desc: 'Pickup body on a ladder frame. Made for giant wheels.', mass: 620, hp: 2200, color: 0x1d4e89, eye: [-0.3, 1.0, -0.2],
  build: (c, lv) => truckBody(c, lv) });
def({ id: 'fus_heli', cat: 'fuselage', name: 'Heli Cabin', desc: 'Helicopter cabin with an engine hump. Bubble Nose in front, Tail Boom behind, rotor on top.', mass: 260, hp: 1100, color: 0xc8102e,
  build: (c) => heliCabin(c) });
def({ id: 'ck_heli', cat: 'cockpit', name: 'Bubble Nose', desc: 'Wrap-around glass helicopter nose with two seats. Bolts to the front of a Heli Cabin.', mass: 70, hp: 300, color: 0xc8102e, eye: [0.3, 0.4, -0.1],
  build: (c, lv) => heliNose(c, lv) });

const cornerDef = (id, name, desc, mass, o, steer) => def({ id, cat: 'car', name, desc, mass, hp: o.hp, color: o.color, attach: 'gear',
  gear: { len: o.len, r: o.r, steer, brake: true, drive: true, limit: o.limit, k: 3 },
  build: (c, lv) => offroadCorner({ ...o, color: c, steer, lv }) });
cornerDef('c_offroad', 'Off-Road Wheel', 'Knobby tyre on long-travel suspension. Drives. Put them at the back.', 55, { r: 0.5, w: 0.42, len: 0.55, limit: 10, hp: 900, color: 0xd9a400 }, false);
cornerDef('c_offroad_steer', 'Off-Road Steering Wheel', 'Knobby tyre on long-travel suspension. Drives and steers. Put them at the front.', 57, { r: 0.5, w: 0.42, len: 0.55, limit: 10, hp: 900, color: 0xd9a400 }, true);
cornerDef('c_bigfoot', 'Monster Tyre', 'Gigantic knobby tyre that drives and steers. Climb over anything.', 140, { r: 0.85, w: 0.72, len: 0.7, limit: 12, hp: 1600, color: 0xc8102e, arm: 0.35, blocks: 16 }, true);

def({ id: 'c_rollcage', cat: 'car', name: 'Roll Cage', desc: 'Steel tube cage. Looks tough and keeps the driver safe when you flip.', mass: 45, hp: 1400, color: 0xe8601c,
  build: (c) => {
    const g = new THREE.Group(), b = new Bag(), p = tubePaint(c), r = 0.042;
    const hoopF = [V(-0.64, 0, -0.85), V(-0.6, 0.55, -0.6), V(-0.5, 0.95, -0.32), V(0.5, 0.95, -0.32), V(0.6, 0.55, -0.6), V(0.64, 0, -0.85)];
    const hoopM = [V(-0.66, 0, 0.5), V(-0.63, 0.75, 0.47), V(-0.48, 1.0, 0.45), V(0.48, 1.0, 0.45), V(0.63, 0.75, 0.47), V(0.66, 0, 0.5)];
    b.add(tube(hoopF, r, 8, 60), p); b.add(tube(hoopM, r, 8, 60), p);
    for (const sx of [-1, 1]) {
      b.add(bar(V(sx * 0.5, 0.95, -0.32), V(sx * 0.48, 1.0, 0.45), r * 2, r * 2, true, 8), p); // roof rails
      b.add(bar(V(sx * 0.48, 1.0, 0.45), V(sx * 0.56, 0.0, 1.75), r * 2, r * 2, true, 8), p); // rear braces
      b.add(bar(V(sx * 0.64, 0.38, -0.72), V(sx * 0.65, 0.38, 0.49), r * 1.8, r * 1.8, true, 8), p); // door bars
      b.add(bar(V(sx * 0.62, 0.0, -0.85), V(sx * 0.62, 0.38, -0.72), r * 1.8, r * 1.8, true, 8), p);
    }
    b.add(bar(V(-0.62, 0.05, 0.5), V(0.48, 1.0, 0.45), r * 1.8, r * 1.8, true, 8), p); // X behind the seat
    b.add(bar(V(-0.5, 0.95, -0.32), V(0.48, 1.0, 0.45), r * 1.6, r * 1.6, true, 8), p); // roof diagonal
    b.to(g); return g;
  } });
def({ id: 'c_lightbar', cat: 'car', name: 'Light Bar', desc: 'Four big spotlights for racing through the night.', mass: 8, hp: 200, color: 0x1a1b1e,
  build: (c) => {
    const g = new THREE.Group(), b = new Bag();
    const beam = new THREE.BoxGeometry(1.1, 0.08, 0.08); b.add(beam, M.paint(c, 'matte'));
    for (const sx of [-1, 1]) b.add(bar(V(sx * 0.5, -0.12, 0.02), V(sx * 0.5, 0, 0.02), 0.04, 0.04, true, 6), M.darkMetal());
    for (let i = 0; i < 4; i++) {
      const x = -0.42 + i * 0.28, h = new THREE.CylinderGeometry(0.1, 0.085, 0.12, 16); h.rotateX(Math.PI / 2); h.translate(x, 0.11, -0.02); b.add(h, M.paint(c, 'matte'));
      const lens = new THREE.Mesh(lightGeometry(new THREE.CircleGeometry(0.088, 18), 2), PM.light()); lens.userData.planeLight = true; lens.userData.cosmetic = true; lens.castShadow = false;
      lens.position.set(x, 0.11, -0.085); lens.rotation.y = Math.PI; g.add(lens);
      const ring = new THREE.TorusGeometry(0.095, 0.012, 6, 20); ring.translate(x, 0.11, -0.082); b.add(ring, M.chrome());
    }
    b.to(g); return g;
  } });
def({ id: 'c_rearwing', cat: 'car', name: 'Rear Wing', desc: 'Big racing wing on two struts. Just for looks (and bragging).', mass: 16, hp: 400, color: 0x15161a,
  build: (c, lv) => {
    const g = new THREE.Group(), b = new Bag(), skin = lv ? PM.carPaint(c) : PM.skin(c);
    const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.quadraticCurveTo(0.12, 0.07, 0.48, 0.025); sh.lineTo(0.5, 0.0); sh.quadraticCurveTo(0.2, -0.015, 0, 0);
    const blade = new THREE.ExtrudeGeometry(sh, { depth: 1.5, bevelEnabled: false }); blade.translate(0, 0, -0.75); blade.rotateY(Math.PI / 2); blade.rotateX(-0.12); blade.translate(0, 0.62, -0.2); b.add(blade, skin);
    for (const sx of [-1, 1]) {
      const ep = new THREE.BoxGeometry(0.025, 0.36, 0.62); ep.translate(sx * 0.76, 0.6, 0.02); b.add(ep, skin);
      b.add(bar(V(sx * 0.32, lv ? -0.14 : 0, 0.05), V(sx * 0.32, 0.6, 0.0), 0.05, 0.16), tubePaint(0x1a1b1e)); // detail: down onto the body (it floated above the tub)
      if (lv) { const foot = new THREE.BoxGeometry(0.1, 0.03, 0.22); foot.translate(sx * 0.32, -0.13, 0.05); b.add(foot, M.darkMetal()); }
    }
    b.to(g); return g;
  } });

// Rocket stage: a tall cylinder with an ogive nose (a body of revolution, so planeDetail dresses it like a fuselage).
const ROCKET_PROF = [...smoothProfile([[-7.2, 0], [-6.8, 0.32], [-6.0, 0.66], [-5.0, 0.86], [-4.4, 0.9]], 20), [3.0, 0.9], [3.9, 0.9], [4.0, 0.84]];
def({ id: 'fus_rocket', cat: 'fuselage', name: 'Rocket Stage', desc: 'Tall fuel tank with a pointy nose. Rocket engines at the bottom, fins at the back: it launches standing up!', mass: 1600, hp: 3000, color: 0xf2f2ee,
  build: (c, lv) => {
    const g = new THREE.Group();
    g.userData.body = { prof: ROCKET_PROF, sx: 1, sy: 1, yOff: null };
    const b = new Bag(); // stage rings
    for (const z of [-4.4, -1.2, 2.2]) { const r = new THREE.TorusGeometry(0.905, 0.025, 6, 40); r.translate(0, 0, z); b.add(r, M.darkMetal()); }
    if (!lv) { g.add(new THREE.Mesh(revolve(ROCKET_PROF, { segs: 40, cap: true }), PM.skin(c))); b.to(g); return g; }
    // detail: a crew porthole in the capsule section with an astronaut looking out (the Rocket had no crew at all)
    const W = { z: -3.75, r: 0.3 }, skin = revolve([...ROCKET_PROF.filter((q) => q[0] <= -4.4), ...Array.from({ length: 16 }, (_, k) => [-4.3 + k * 0.1, 0.9]), ...ROCKET_PROF.filter((q) => q[0] > -2.8)], { segs: 64, cap: true }); // denser rings round the porthole
    const P = skin.attributes.position, d = new Float32Array(P.count), v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); d[i] = v.x > 0 ? Math.hypot(Math.atan2(v.y, v.x) * 0.9, v.z - W.z) - W.r : 1; }
    const cut = clipGeometry(skin, d) || skin; g.add(new THREE.Mesh(cut, PM.skin(c)));
    const inner = new THREE.Mesh(revolve([[-5.0, 0.86], [-2.6, 0.88]], { segs: 32, cap: true }), mat('capsuleIn', () => new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9, side: THREE.BackSide }))); g.add(inner);
    const xw = 0.865;
    const glass = new THREE.CircleGeometry(W.r + 0.03, 28); glass.rotateY(Math.PI / 2); glass.translate(xw, 0, W.z); g.add(new THREE.Mesh(glass, PM.canopy(0x1d2a33)));
    const ring = new THREE.TorusGeometry(W.r + 0.02, 0.035, 8, 32); ring.rotateY(Math.PI / 2); ring.translate(0.875, 0, W.z); b.add(ring, M.darkMetal());
    for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2, bolt = new THREE.SphereGeometry(0.014, 6, 4); bolt.translate(0.905, Math.sin(a) * (W.r + 0.075), W.z + Math.cos(a) * (W.r + 0.075)); b.add(bolt, M.steel()); }
    b.to(g);
    // the astronaut lies with the head towards the nose, facing the porthole (+x): rig up = -z, rig forward = +x
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, -1), V(-1, 0, 0)));
    g.userData.seats = [{ p: [-0.14, 0, -3.1], s: 0.85, quat: q.toArray(), ctl: 'none' }]; // (no stick in front of the face)
    return g;
  } });
