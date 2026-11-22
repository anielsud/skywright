// Motorbike parts (the Bike tab): two frames with their bodywork, fork wheels that steer on telescopic forks, swingarm
// wheels on a monoshock, two engines. They register into PARTS like parts.js's own (same fields, same
// build(color, { detail }) contract), so the hangar, physics and save codes treat them like any other part. Physics:
// the wheels are ordinary car wheels (one ray each, straight down from the part's origin); two of them in line on the
// centreline make the vehicle a bike (bike.js). Visual: the wheel parts carry their own moving rig (bikeSync below,
// run from planeDetail.updateDetail): the fork turns about its raked steering head and its lower legs slide up the
// outer tubes as the wheel rises; the swingarm swings about its pivot and the shock squeezes. Their mounts (steering
// stem, swingarm pivot, shock top, engine and exhaust hangers) are feet that carDetail.js carries to whatever the kid
// bolted them under, so a bike built from any parts holds together. The rider is crew.js's ('bars' seats).
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';
import { V, bar, tube, pipe, Bag, shell } from './partDetail.js';
import { superLoft, chaikin } from './vehicleParts.js';
import * as CK from './cabKit.js';

const cached = new Map();
const mat = (k, make) => { if (!cached.has(k)) cached.set(k, make()); return cached.get(k); };
const rubber = () => mat('tyre', () => new THREE.MeshStandardMaterial({ color: 0x1b1b1d, metalness: 0, roughness: 0.92 }));
const plastic = (c) => mat('plas' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.55 }));
const framePaint = (c) => mat('frame' + c, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.12 }));
const anod = (c) => mat('anod' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0.85, roughness: 0.28 }));
const gold = () => mat('gold', () => new THREE.MeshStandardMaterial({ color: 0xc8962a, metalness: 1, roughness: 0.22 }));
const seatMat = () => mat('seat', () => new THREE.MeshStandardMaterial({ color: 0x17181a, metalness: 0, roughness: 0.78 }));
const glass = () => mat('screen', () => new THREE.MeshPhysicalMaterial({ color: 0x3a4652, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.35, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
const BLACK = 0x17181b;

function ensureUv1(obj) {
  obj.traverse((m) => { const g = m.geometry; if (m.isMesh && !g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
  return obj;
}
function def(p) { const b = p.build; p.build = (c, o) => ensureUv1(b(c, o?.detail || 0)); PARTS[p.id] = p; }

// ---------- geometry helpers ----------
// A flat shape drawn in the side view ([[z, y], ...]) and given a thickness across the bike, centred on x.
function side(pts, x, depth, bevel = 0.006) {
  const sh = new THREE.Shape(); pts.forEach(([z, y], i) => (i ? sh.lineTo(z, y) : sh.moveTo(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.002, depth - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -Math.max(0.002, depth - 2 * bevel) / 2); g.rotateY(-Math.PI / 2); g.translate(x, 0, 0);
  return g;
}
// a band following a side-view curve: the curve [[z, y], ...] is its top edge, t its thickness (downwards / inwards)
function band(curve, t) {
  const top = curve.map(([z, y]) => [z, y]), n = curve.length, bot = [];
  for (let i = n - 1; i >= 0; i--) {
    const a = curve[Math.max(0, i - 1)], b = curve[Math.min(n - 1, i + 1)], dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1;
    bot.push([curve[i][0] + (dy / l) * t, curve[i][1] - (dz / l) * t]);
  }
  return [...top, ...bot];
}
// a closed lathe about the X axis: profile [[radius, x], ...] (the last point joins the first)
function lathe(profile, segs = 32) {
  const pts = profile.concat([profile[0]]).map(([r, x]) => new THREE.Vector2(r, x));
  const g = new THREE.LatheGeometry(pts, segs); g.rotateZ(-Math.PI / 2); return g;
}
const xCyl = (r, x0, x1, y = 0, z = 0, segs = 16) => { const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), segs); g.rotateZ(Math.PI / 2); g.translate((x0 + x1) / 2, y, z); return g; };
const box = (sx, sy, sz, x, y, z) => { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(x, y, z); return g; };
// a rounded slab in the XZ plane (clamps, plates): a stadium from x0 to x1, half-depth hz, thickness t, centred at y
function stadium(x0, x1, hz, t, y = 0) {
  const sh = new THREE.Shape(); sh.absarc(x1, 0, hz, -Math.PI / 2, Math.PI / 2, false); sh.absarc(x0, 0, hz, Math.PI / 2, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 8 }); g.rotateX(Math.PI / 2); g.translate(0, y + t / 2, 0); return g;
}
// group g placed at `from`, its +Y pointing at `to`
const _up = V(0, 1, 0);
function aim(g, from, to) { g.position.copy(from); const d = to.clone().sub(from); const L = d.length(); if (L > 1e-6) g.quaternion.setFromUnitVectors(_up, d.divideScalar(L)); return L; }
// a coil spring along +Y from 0 to L (wire radius w, coil radius R)
function coil(R, L, w, turns) {
  const N = Math.round(turns * 14), pts = [];
  for (let k = 0; k <= N; k++) { const t = k / N, a = t * turns * Math.PI * 2; pts.push(V(Math.cos(a) * R, w + t * (L - 2 * w), Math.sin(a) * R)); }
  return pipe(pts, w, 6, N);
}

// ---------- wheels ----------
// Motorcycle tyre about X: a round crown (the section is nearly a half-ellipse) from bead to bead, closed at the bead
// seat (it sits on the rim). Knobby: staggered blocks stand out of the crown and shoulders.
function bikeTyre(r, w, h, { knobby = false, blocks = 30, segs = 0 } = {}) {
  const ri = r - h, prof = [], NA = segs || (knobby ? blocks * 8 : 72), kn = knobby ? Math.min(0.016, h * 0.16) : 0;
  const c = r - h * 0.55, ay = h * 0.55, wb = w * 0.62;
  for (let i = 0; i <= 3; i++) { const t = i / 3; prof.push([-wb / 2 - (w - wb) / 2 * t, ri + (c - ri) * t, 0]); } // sidewall up
  for (let i = 1; i <= 15; i++) { const a = -Math.PI / 2 + (i / 16) * Math.PI; prof.push([Math.sin(a) * w / 2, c + Math.cos(a) * ay, Math.abs(a) < 1.15 ? 1 : 0.5]); }
  for (let i = 0; i <= 3; i++) { const t = i / 3; prof.push([w / 2 - (w - wb) / 2 * t, c + (ri - c) * t, 0]); } // down to the right bead
  const NP = prof.length, pos = [], idx = [];
  for (let a = 0; a <= NA; a++) {
    const ph = (a / NA) * Math.PI * 2;
    for (let j = 0; j < NP; j++) {
      const [x, rho, tr] = prof[j];
      let k = 0;
      if (kn && tr) { const u = (a / NA) * blocks * 2 + (x > 0 ? 0.5 : 0), cell = Math.floor(u), sub = u % 1, onB = sub > 0.18 && sub < 0.82 && (cell % 2 === 0 ? Math.abs(x) > w * 0.06 : Math.abs(x) < w * 0.3); k = onB ? kn * (tr === 1 ? 1 : 0.8) : 0; }
      pos.push(x * (1 + k * 2), Math.cos(ph) * (rho + k), Math.sin(ph) * (rho + k));
    }
  }
  for (let a = 0; a < NA; a++) for (let j = 0; j < NP - 1; j++) { const i0 = a * NP + j, i1 = (a + 1) * NP + j; idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1); }
  for (let a = 0; a < NA; a++) { const i0 = a * NP + NP - 1, i1 = (a + 1) * NP + NP - 1, j0 = a * NP, j1 = (a + 1) * NP; idx.push(i0, i1, j0, i1, j1, j0); } // bead seat
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// The spinning wheel (about X, at the origin): tyre on its rim, spokes or cast arms, hub, brake disc(s), rear sprocket.
// o: { r, w, h, knobby, spokes, discs: [x...], discR, sprocket: x | null, rimC }
function wheelSpin(o, lv) {
  const b = new Bag(), ri = o.r - o.h, wr = o.w * 0.62, hubW = o.hubW || 0.12;
  b.add(bikeTyre(o.r, o.w, o.h, { knobby: o.knobby && lv, segs: lv ? 0 : 24 }), rubber());
  const rimM = o.spokes ? anod(o.rimC ?? 0x1a1a1c) : framePaint(o.rimC ?? 0x1a1a1c);
  b.add(lathe([[ri, -wr / 2], [ri, wr / 2], [ri - 0.012, wr / 2 + 0.004], [ri - 0.022, wr * 0.25], [ri - 0.03, 0], [ri - 0.022, -wr * 0.25], [ri - 0.012, -wr / 2 - 0.004]], lv ? 48 : 20), rimM);
  b.add(lathe([[0.012, -hubW / 2], [0.05, -hubW / 2], [0.055, -hubW * 0.4], [0.042, -hubW * 0.2], [0.04, hubW * 0.2], [0.055, hubW * 0.4], [0.05, hubW / 2], [0.012, hubW / 2]], 20), o.spokes ? M.aluminum() : rimM);
  if (lv) {
    if (o.spokes) for (let i = 0; i < 32; i++) { // tangentially laced, alternate flanges
      const sx = i % 2 ? 1 : -1, a = (i / 32) * Math.PI * 2, a2 = a + sx * 0.32, rh = 0.052, rr = ri - 0.026;
      b.add(bar(V(sx * hubW * 0.4, Math.cos(a) * rh, Math.sin(a) * rh), V(sx * wr * 0.12, Math.cos(a2) * rr, Math.sin(a2) * rr), 0.0045, 0.0045, true, 4), M.steel());
    }
    else for (let i = 0; i < 5; i++) for (const k of [-1, 1]) { // cast: five split spokes
      const a = (i / 5) * Math.PI * 2, a2 = a + k * 0.12, rh = 0.045;
      b.add(bar(V(0, Math.cos(a) * rh, Math.sin(a) * rh), V(0, Math.cos(a2) * (ri - 0.022), Math.sin(a2) * (ri - 0.022)), 0.022, 0.016), rimM);
    }
    for (const x of o.discs || []) { // a wave-edged disc on a carrier bolted to the hub
      const R = o.discR;
      const d = new THREE.CylinderGeometry(R, R, 0.005, 36); d.rotateZ(Math.PI / 2); d.translate(x, 0, 0); b.add(d, M.steel());
      const car = new THREE.CylinderGeometry(R * 0.6, R * 0.6, 0.009, 24); car.rotateZ(Math.PI / 2); car.translate(x, 0, 0); b.add(car, anod(0x2b2d31));
      b.add(xCyl(0.045, x, Math.sign(x) * hubW * 0.35), anod(0x2b2d31));
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; b.add(xCyl(0.007, x - 0.006, x + 0.006, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, 6), M.chrome()); }
    }
    if (o.sprocket != null) { // rear sprocket on the left, teeth all round
      const R = o.sprR, sh = new THREE.Shape(), T = 44;
      for (let k = 0; k <= T * 2; k++) { const a = (k / (T * 2)) * Math.PI * 2, rr = k % 2 ? R : R - 0.008; k ? sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      const sp = new THREE.ExtrudeGeometry(sh, { depth: 0.006, bevelEnabled: false }); sp.rotateY(Math.PI / 2); sp.translate(o.sprocket - 0.003, 0, 0); b.add(sp, anod(0xe8601c));
      b.add(xCyl(0.05, o.sprocket, -hubW * 0.35), anod(0x2b2d31));
    }
  }
  return b;
}

// ---------- the front wheel: telescopic fork that steers ----------
// Origin: the physics wheel's top (the wheel ray goes straight down from here, len to the axle with the fork fully out).
// The steering head is raked back: the top clamp is Lf up the steering axis from the axle. Built at full extension.
// o: { r, w, h, len, Lf, rake, fx (leg spacing / 2), ro, rin (outer / inner tube radius), Hc (clamp spacing), outerL,
//      bars: 'mx' | 'clip', fender: 'high' | 'hug', plate, discs, discR, spokes, knobby }
function forkWheel(o, color, lv) {
  const g = new THREE.Group(), strut = new THREE.Group(); g.add(strut);
  const ca = Math.cos(o.rake), sa = Math.sin(o.rake), T = V(0, -o.len + o.Lf * ca, o.Lf * sa), rakeQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), o.rake);
  const steer = new THREE.Group(); steer.position.copy(T); steer.quaternion.copy(rakeQ); g.add(steer);
  const slide = new THREE.Group(); slide.position.y = -o.Lf; steer.add(slide);
  const spin = new THREE.Group(); slide.add(spin);
  const sB = new Bag(), lB = new Bag(), dark = anod(0x2b2d31), alu = M.aluminum(), paint = PM.carPaint(color, 'satin');
  const fx = o.fx, Hc = o.Hc, cl = anod(o.clampC ?? 0xd0d3d8);
  // clamps, steerer, outer tubes with their caps (all steer)
  sB.add(stadium(-fx, fx, o.ro + 0.014, 0.028, -0.014), cl);
  sB.add(stadium(-fx, fx, o.ro + 0.018, 0.042, -Hc), cl);
  sB.add(new THREE.CylinderGeometry(0.022, 0.022, Hc + 0.01, 14).translate(0, -Hc / 2, 0), M.steel()); // steerer
  sB.add(new THREE.CylinderGeometry(0.02, 0.026, 0.02, 14).translate(0, 0.008, 0), M.chrome()); // stem nut
  for (const sx of [-1, 1]) {
    sB.add(new THREE.CylinderGeometry(o.ro, o.ro, o.outerL, lv ? 18 : 10).translate(sx * fx, 0.012 - o.outerL / 2, 0), anod(o.tubeC ?? 0x1c1d20));
    sB.add(new THREE.CylinderGeometry(o.ro * 0.8, o.ro * 0.8, 0.02, 12).translate(sx * fx, 0.02, 0), cl); // fork caps
    if (lv) sB.add(new THREE.CylinderGeometry(o.ro * 1.04, o.ro * 1.04, 0.035, 18).translate(sx * fx, 0.012 - o.outerL + 0.02, 0), dark); // seal holders
  }
  // handlebars
  let grips;
  if (o.bars === 'mx') {
    const bp = [V(-0.4, 0.115, 0.1), V(-0.27, 0.088, 0.065), V(-0.1, 0.075, 0.04), V(0.1, 0.075, 0.04), V(0.27, 0.088, 0.065), V(0.4, 0.115, 0.1)];
    sB.add(pipe(bp, 0.013, 8, 40), anod(0x2b2d31));
    for (const sx of [-1, 1]) sB.add(bar(V(sx * 0.045, -0.002, 0.03), V(sx * 0.045, 0.085, 0.04), 0.03, 0.03, true, 10), dark); // bar clamps
    if (lv) sB.add(box(0.2, 0.035, 0.04, 0, 0.1, 0.04), plastic(0x15161a)); // crossbar pad
    grips = [bp[0].clone().lerp(bp[1], 0.4), bp[5].clone().lerp(bp[4], 0.4)];
    for (const [a, c] of [[bp[0], bp[1]], [bp[5], bp[4]]]) sB.add(bar(a.clone().lerp(c, -0.04), a.clone().lerp(c, 0.8), 0.036, 0.036, true, 10), plastic(0x15161a));
  } else { // clip-ons under the top clamp
    grips = [];
    for (const sx of [-1, 1]) {
      const a = V(sx * fx, -0.045, 0), c = V(sx * 0.32, -0.09, 0.12);
      sB.add(new THREE.CylinderGeometry(o.ro + 0.01, o.ro + 0.01, 0.04, 14).translate(sx * fx, -0.045, 0), dark);
      sB.add(bar(a, c, 0.024, 0.024, true, 10), dark);
      const gs = a.clone().lerp(c, 0.58); sB.add(bar(gs, c.clone().lerp(a, -0.06), 0.036, 0.036, true, 10), plastic(0x15161a)); grips.push(gs.clone().lerp(c, 0.55));
    }
    grips.sort((p, q) => p.x - q.x);
  }
  if (lv) for (const [k, gp] of grips.entries()) { // levers: brake on the right, clutch on the left, with their perches
    const sx = k ? 1 : -1, root = gp.clone().lerp(V(0, gp.y, gp.z), 0.28);
    sB.add(new THREE.CylinderGeometry(0.02, 0.02, 0.035, 10).rotateZ(Math.PI / 2).translate(root.x, root.y, root.z), dark);
    sB.add(bar(root.clone().add(V(0, 0, -0.01)), root.clone().add(V(sx * 0.13, -0.005, -0.06)), 0.012, 0.006), alu);
    if (k) sB.add(box(0.045, 0.03, 0.035, root.x - 0.01, root.y + 0.025, root.z + 0.005), dark); // master cylinder
  }
  // dirt: the high fender under the bottom clamp and the number plate in front of the bars
  if (o.fender === 'high') {
    const z0 = -0.42, curve = []; for (let i = 0; i <= 10; i++) { const t = i / 10, z = z0 + t * 0.7; curve.push([z, -Hc - 0.024 - 0.1 * ((z + 0.05) / 0.4) ** 2]); }
    sB.add(side(band(curve, 0.014), 0, 0.13, 0.004), paint);
    sB.add(box(0.07, 0.03, 0.06, 0, -Hc - 0.03, -0.03), paint); // mounting boss against the clamp
  }
  if (o.plate) {
    const sh = new THREE.Shape(); sh.absellipse(0, 0, 0.15, 0.13, 0, Math.PI * 2, false); const pl = new THREE.ExtrudeGeometry(sh, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1, curveSegments: 20 });
    pl.rotateX(-0.12); pl.translate(0, -0.04, -o.ro - 0.05); sB.add(pl, PM.carPaint(0xf2f2ee)); // a white plate for the race number
    for (const sx of [-1, 1]) sB.add(bar(V(sx * 0.06, -0.012, -o.ro - 0.042), V(sx * 0.06, -0.012, -0.004), 0.018, 0.02), paint); // tabs to the top clamp
    if (lv) digits(sB, '21', V(0, -0.035, -o.ro - 0.058), 0.12);
  }
  // lower legs (slide with the wheel): inner tubes, axle lugs, axle, caliper, guards or a hugger fender
  const inL = o.Lf - (o.outerL - 0.012) + o.overlap;
  for (const sx of [-1, 1]) {
    lB.add(new THREE.CylinderGeometry(o.rin, o.rin, inL, lv ? 16 : 8).translate(sx * fx, inL / 2, 0), o.tubeIn === 'gold' ? gold() : M.chrome());
    lB.add(box(0.05, 0.11, 0.07, sx * fx, 0.02, 0.005), anod(o.lugC ?? 0x1c1d20)); // axle lug
    if (o.fender === 'high' && lv) lB.add(side([[-0.035, 0.07], [-0.03, 0.36], [0.0, 0.38], [0.012, 0.3], [0.01, 0.07]], sx * (fx + o.rin * 0.25), 0.03, 0.004), paint); // fork guards
  }
  lB.add(xCyl(0.012, -fx - 0.03, fx + 0.03), M.steel()); // axle
  for (const [k, x] of (o.discs || []).entries()) { // calipers astride the discs
    const sx = Math.sign(x) || -1, a = o.discR - 0.02, y = a * 0.55, z = a * 0.82;
    lB.add(box(0.045, 0.1, 0.055, x + sx * 0.004, y, z), M.paint(0xc8102e, 'gloss'));
    lB.add(bar(V(x + sx * 0.01, y, z), V(sx * fx, 0.02, 0.02), 0.02, 0.03), dark);
    void k;
  }
  if (o.fender === 'hug') { // a hugger over the tyre on the lower legs
    const R = o.r + 0.035, curve = []; for (let i = 0; i <= 12; i++) { const a = -0.95 + (i / 12) * 1.75; curve.push([-Math.sin(a) * R, Math.cos(a) * R]); }
    const fw = 2 * (fx - o.rin - 0.006); lB.add(side(band(curve, 0.012), 0, fw, 0.003), paint);
    for (const sx of [-1, 1]) lB.add(box(o.rin + 0.016, 0.03, 0.07, sx * (fx - o.rin / 2 - 0.004), R - 0.008, 0), dark); // tabs to the legs
  }
  sB.to(steer); lB.to(slide);
  wheelSpin(o, lv).to(spin);
  // the stem carried up to whatever the fork hangs from (the frame's head tube, or anything a kid bolted it under)
  const a = V(0, ca, sa), stem = T.clone().addScaledVector(a, -Hc + 0.021);
  g.userData.feet = lv ? [{ p: stem.toArray(), d: a.toArray(), r: 0.022, kind: 'rod', mat: M.steel(), on: 'any', back: 0.05, reach: 1.2 }] : undefined;
  const proxy = new THREE.Group(); proxy.add(new THREE.Group()); proxy.position.y = -o.len; // aircraft.js writes the wheel's travel, steering and spin here
  const comp0 = V();
  Object.assign(g.userData, { strut, wheels: proxy, steer: true, bikeWheel: 'front', rigid: [steer, slide, spin], grips: grips.map((p) => ({ o: steer, p })), axleHalf: fx + 0.03 });
  g.userData.bikeSync = (st) => { // st: { comp, steer, spin } in the part's units
    const c = Math.max(0, st.comp); steer.quaternion.copy(rakeQ).multiply(_qs.setFromAxisAngle(_up, st.steer));
    slide.position.copy(comp0.set(0, -o.Lf + c / ca, 0)); spin.rotation.x = st.spin;
  };
  return g;
}
const _qs = new THREE.Quaternion(), _z = V(0, 0, 1);
// race numbers as seven-segment bars (front plates: read from the front)
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function digits(b, str, c, h) {
  const w = h * 0.55, t = h * 0.16, gap = w * 0.35, n = str.length, x0 = -(n * w + (n - 1) * gap) / 2;
  [...str].forEach((ch, i) => {
    const xc = -(x0 + i * (w + gap) + w / 2), segs = SEG[ch] || '', S = { a: [0, h / 2, w, t], d: [0, -h / 2, w, t], g: [0, 0, w, t], f: [w / 2, h / 4, t, h / 2], b: [-w / 2, h / 4, t, h / 2], e: [w / 2, -h / 4, t, h / 2], c: [-w / 2, -h / 4, t, h / 2] };
    for (const s of segs) { const [dx, dy, sx, sy] = S[s], m = box(sx, sy, 0.006, xc + dx, dy, 0); m.rotateX(-0.12); m.translate(c.x, c.y, c.z); b.add(m, plastic(0x111214)); }
  });
}

// ---------- the rear wheel: swingarm on a monoshock ----------
// Origin: the physics wheel's top, straight above the axle. The swingarm pivots at P (part-local) and its axle end
// follows the wheel up and down (an arc: the axle moves back a little as it rises). The shock runs from a top mount
// (on the frame, through a foot) to a lug on the arm, and squeezes as the arm rises; the chain runs from the gearbox
// sprocket at the pivot to the rear sprocket. o: { r, w, h, len, P: [y, z], ax (arm half-spacing), aw, ah (beam size),
// shockTop: [y, z], shockLug: [y, s], knobby, spokes, discs, discR, sprocket, sprR, armC }
function swingWheel(o, color, lv) {
  const g = new THREE.Group(), strut = new THREE.Group(); g.add(strut);
  const P = V(0, o.P[0], o.P[1]), A0 = V(0, -o.len, 0), La = P.distanceTo(A0);
  const arm = new THREE.Group(); g.add(arm); arm.position.copy(P); arm.quaternion.setFromUnitVectors(_z, A0.clone().sub(P).normalize()); // (+Z along the arm, +Y up)
  const hub = new THREE.Group(); hub.position.set(0, 0, La); arm.add(hub);
  const spin = new THREE.Group(); hub.add(spin);
  const aB = new Bag(), sB = new Bag(), dark = anod(0x2b2d31), armM = o.armC === 'alu' ? M.aluminum() : anod(o.armC ?? 0x2b2d31);
  // the arm: two beams round the tyre, a cross brace near the pivot, the pivot tube, axle blocks, chain slider
  for (const sx of [-1, 1]) {
    aB.add(box(o.aw, o.ah, La + 0.06, sx * o.ax, 0, La / 2 - 0.01), armM);
    aB.add(box(o.aw + 0.012, o.ah * 0.8, 0.06, sx * o.ax, 0, La + 0.005), dark); // axle blocks / adjusters
  }
  aB.add(box(2 * o.ax, o.ah * 0.9, 0.1, 0, 0, 0.1), armM); // cross brace
  aB.add(xCyl(0.03, -o.ax - o.aw / 2, o.ax + o.aw / 2, 0, 0, 16), armM); // pivot tube
  aB.add(xCyl(0.012, -o.ax - o.aw / 2 - 0.012, o.ax + o.aw / 2 + 0.012, 0, La), M.steel()); // axle
  const lug = V(0, o.ah * 0.45 + 0.025, o.shockLug[1]);
  aB.add(box(0.05, 0.05, 0.05, 0, o.ah * 0.45, o.shockLug[1]), dark); // shock lug on the brace
  if (lv) aB.add(box(0.012, 0.03, La * 0.55, -o.ax + o.aw / 2 + 0.006, o.ah * 0.5, La * 0.3), plastic(0x15161a)); // chain slider
  // brake caliper over the disc on the right, with its hanger to the beam
  for (const x of o.discs || []) { const a = o.discR - 0.02; aB.add(box(0.045, 0.08, 0.05, x, a * 0.5, La - a * 0.85), M.paint(0x2b2d31, 'gloss')); aB.add(bar(V(x, a * 0.5, La - a * 0.85), V(o.ax, 0, La - 0.03), 0.025, 0.02), dark); }
  // the chain: gearbox sprocket at the pivot, a loop round both sprockets on the left
  if (lv && o.sprocket != null) {
    const x = o.sprocket, rf = 0.045, rr = o.sprR, pts = [];
    for (let k = 0; k <= 10; k++) { const a = -Math.PI / 2 + (k / 10) * Math.PI; pts.push(V(x, Math.sin(a) * rr, La + Math.cos(a) * rr)); }
    for (let k = 0; k <= 10; k++) { const a = Math.PI / 2 + (k / 10) * Math.PI; pts.push(V(x, Math.sin(a) * rf, Math.cos(a) * rf)); }
    aB.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 120, 0.007, 5, true), M.darkMetal());
    aB.add(xCyl(rf - 0.004, x - 0.004, x + 0.004), anod(0x2b2d31)); aB.add(xCyl(0.02, x, -o.ax + o.aw / 2), dark);
  }
  // the shock: body and reservoir from the top mount, chrome shaft from the lug, the spring between them
  const top = V(0, o.shockTop[0], o.shockTop[1]), body = new THREE.Group(), shaft = new THREE.Group(), spring = new THREE.Group();
  g.add(body, shaft, spring);
  const lugAt = () => { arm.updateMatrix(); return lug.clone().applyMatrix4(arm.matrix); };
  const L0 = top.distanceTo(lugAt()), bL = L0 * 0.55, rb = 0.028;
  const bB = new Bag(), hB = new Bag(), pB = new Bag();
  bB.add(new THREE.CylinderGeometry(rb, rb, bL, 16).translate(0, bL / 2, 0), anod(0xe8601c)); // body (adjusters in orange)
  bB.add(new THREE.CylinderGeometry(rb * 1.5, rb * 1.5, 0.018, 16).translate(0, bL * 0.25, 0), dark); // spring top perch
  bB.add(xCyl(0.018, -0.03, 0.03, 0, 0, 10), dark); // top eye
  if (lv) { bB.add(new THREE.CylinderGeometry(rb * 0.75, rb * 0.75, bL * 0.7, 12).translate(-rb * 1.9, bL * 0.4, 0), anod(o.resC ?? 0x2b2d31)); bB.add(bar(V(-rb * 0.9, bL * 0.1, 0), V(-rb * 1.4, bL * 0.12, 0), 0.02, 0.02, true, 8), dark); }
  hB.add(new THREE.CylinderGeometry(rb * 0.42, rb * 0.42, L0 * 0.62, 12).translate(0, L0 * 0.31, 0), M.chrome());
  hB.add(new THREE.CylinderGeometry(rb * 1.5, rb * 1.5, 0.018, 16).translate(0, 0.03, 0), dark); // bottom perch
  hB.add(xCyl(0.018, -0.03, 0.03, 0, 0, 10), dark); // bottom eye
  const sL = L0 - bL * 0.25 - 0.048; pB.add(coil(rb * 1.3, sL, 0.0075, 6.5), M.paint(o.springC ?? 0xf2b705, 'gloss'));
  aB.to(arm); bB.to(body); hB.to(shaft); pB.to(spring);
  // mounts carried to the frame: the shock's top eye up, the pivot bolt's ends forwards and up
  sB.add(xCyl(0.014, -o.ax - o.aw / 2 - 0.02, o.ax + o.aw / 2 + 0.02, P.y, P.z), M.steel()); // pivot bolt
  sB.add(box(0.06, 0.035, 0.035, 0, top.y + 0.0, top.z), dark); // shock top clevis
  sB.to(strut);
  wheelSpin(o, lv).to(spin);
  const proxy = new THREE.Group(); proxy.add(new THREE.Group()); proxy.position.y = -o.len;
  const ax = V(), dd = V();
  const sync = (st) => {
    const y = -o.len + Math.max(0, st.comp), dy = y - P.y, dz = Math.sqrt(Math.max(1e-6, La * La - dy * dy)), dir = dd.set(0, dy, dz).normalize();
    arm.quaternion.setFromUnitVectors(_z, dir); spin.rotation.x = st.spin;
    const B = lugAt();
    const L = aim(body, top, B); aim(shaft, B, top); aim(spring, top, B); spring.position.addScaledVector(ax.copy(B).sub(top).normalize(), bL * 0.25 + 0.009);
    spring.scale.set(1, Math.max(0.3, (L - bL * 0.25 - 0.03 - 0.018) / sL), 1);
  };
  sync({ comp: 0, spin: 0 });
  Object.assign(g.userData, { strut, wheels: proxy, steer: false, bikeWheel: 'rear', rigid: [arm, spin, body, shaft, spring], bikeSync: sync, axleHalf: o.ax + o.aw / 2 + 0.012 });
  if (lv) g.userData.feet = [
    { p: [0, top.y + 0.017, top.z], d: [0, 1, 0], r: 0.016, kind: 'sq', mat: dark, on: 'any', back: 0.02, reach: 0.8 },
    ...[-1, 1].map((sx) => ({ p: [sx * o.pfx, P.y, P.z], d: [0, 0.6, -0.8], r: 0.02, kind: 'sq', mat: dark, on: 'any', back: 0.03, reach: 0.8 })),
  ];
  return g;
}

// ---------- engines ----------
// Engine-local origin: the crank. Single: a big-bore thumper leaning forward, header round the right to a high
// silencer. Four: an inline four with four headers into a collector under the sump and a short silencer on the right.
function bikeEngine({ four, color, lv }) {
  const g = new THREE.Group(), b = new Bag(), dark = anod(0x2b2d31), alu = M.aluminum(), paint = M.paint(color, 'metal');
  const hw = four ? 0.17 : 0.1, lean = four ? 0.5 : 0.2, ca = Math.cos(lean), sa = Math.sin(lean);
  const ax = V(0, ca, -sa); // cylinder axis (forward lean)
  b.add(superLoft(chaikin([{ z: -0.17, hw: hw * 0.9, top: 0.02, bot: -0.13, n: 4 }, { z: -0.1, hw, top: 0.06, bot: -0.19, n: 5 }, { z: 0.12, hw, top: 0.06, bot: -0.19, n: 5 }, { z: 0.18, hw: hw * 0.9, top: 0.02, bot: -0.13, n: 4 }], 1), lv ? 28 : 12, !!lv), alu);
  b.add(xCyl(four ? 0.1 : 0.11, hw - 0.01, hw + 0.035, -0.04, 0.03, 24), alu); // clutch cover (right)
  b.add(xCyl(0.08, -hw - 0.03, -hw + 0.01, -0.03, -0.05, 20), dark); // alternator cover (left)
  if (lv) for (const [x, r] of [[hw + 0.035, 0.07], [-hw - 0.03, 0.05]]) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; b.add(xCyl(0.006, x - 0.005, x + 0.006, -0.035 + Math.cos(a) * r, (x > 0 ? 0.03 : -0.05) + Math.sin(a) * r, 6), M.steel()); }
  const at = (h) => V(0, 0.04, -0.02).addScaledVector(ax, h);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, ax);
  const cylW = four ? 0.34 : 0.13, finN = lv ? 9 : 3;
  for (let k = 0; k < finN; k++) { // finned barrel
    const h = 0.03 + (k / (finN - 1)) * 0.17, f = four ? new THREE.BoxGeometry(cylW, 0.009, 0.13) : new THREE.CylinderGeometry(0.085, 0.085, 0.009, 24);
    f.applyQuaternion(q); f.translate(...at(h).toArray()); b.add(f, paint);
  }
  { const c = four ? new THREE.BoxGeometry(cylW - 0.03, 0.2, 0.1) : new THREE.CylinderGeometry(0.06, 0.06, 0.2, 18); c.applyQuaternion(q); c.translate(...at(0.115).toArray()); b.add(c, paint); }
  { const hd = new THREE.BoxGeometry(cylW + 0.01, 0.07, 0.14); hd.applyQuaternion(q); hd.translate(...at(0.24).toArray()); b.add(hd, alu); }
  { const cv = new THREE.BoxGeometry(cylW - 0.02, 0.045, 0.11); cv.applyQuaternion(q); cv.translate(...at(0.295).toArray()); b.add(cv, M.paint(four ? 0x15161a : 0xe8601c, 'gloss')); } // cam cover
  const n = four ? 4 : 1, xs = four ? [-0.12, -0.04, 0.04, 0.12] : [0];
  // intake behind the head (throttle bodies / carb)
  for (const x of xs) b.add(bar(at(0.22).add(V(x, 0, 0.06)), at(0.24).add(V(x, 0.03, 0.17)), 0.045, 0.045, true, 12), dark);
  // exhaust: headers from the front of the head (detail only: the plain part is what physics scrapes on the ground)
  const ex = pipe, hdrC = M.paint(four ? 0x6d6a66 : 0x7d6a55, 'metal'), mfl = four ? M.paint(0x2a2b2e, 'metal') : M.aluminum();
  const port = (x) => at(0.21).add(V(x, 0, -0.06));
  let muffA = V(), muffB = V();
  if (lv && four) {
    for (const x of xs) b.add(ex([port(x), port(x).add(V(0, -0.03, -0.04)), V(x, 0.12, -0.2), V(x * 0.8, -0.06, -0.17), V(x * 0.5, -0.2, -0.12), V(x * 0.25, -0.235, -0.02), V(0.03, -0.24, 0.1)], 0.019, 8, 30), hdrC);
    b.add(ex([V(0.0, -0.245, 0.06), V(0.04, -0.245, 0.16), V(0.16, -0.2, 0.22), V(0.255, -0.135, 0.255)], 0.032, 10, 24), hdrC);
    muffA = V(0.255, -0.13, 0.25); muffB = V(0.275, 0.0, 0.55);
  } else if (lv) {
    b.add(ex([port(0), port(0).add(V(0.0, -0.02, -0.08)), V(0.05, 0.16, -0.21), V(0.13, 0.0, -0.2), V(0.16, -0.14, -0.08), V(0.17, -0.13, 0.18), V(0.18, -0.06, 0.3)], 0.022, 8, 40), hdrC);
    muffA = V(0.18, -0.05, 0.3); muffB = V(0.19, 0.13, 0.72);
  }
  if (lv) {
    b.add(bar(muffA, muffB, four ? 0.11 : 0.1, four ? 0.11 : 0.1, true, 18), mfl);
    const tip = muffB.clone().addScaledVector(muffB.clone().sub(muffA).normalize(), 0.02);
    b.add(bar(muffB.clone().lerp(muffA, 0.02), tip, 0.045, 0.045, true, 12), M.chrome());
    b.add(bar(muffB.clone().lerp(muffA, 0.12), muffB.clone().lerp(muffA, 0.08), 0.104, 0.104, true, 18), M.chrome()); // end cap band
  }
  if (lv) { const sk = new THREE.CylinderGeometry(0.015, 0.015, 0.06, 8); sk.applyQuaternion(q); sk.translate(...at(0.3).add(V(four ? 0.0 : 0, 0.0, -0.05)).toArray()); b.add(sk, M.black()); } // plug lead
  b.to(g);
  const mid = muffA.clone().lerp(muffB, 0.55), hd = at(0.32);
  const dm = anod(0x2b2d31);
  g.userData.feet = lv ? [
    { p: [0, -0.185, 0.02], d: [0, -1, 0], r: 0.018, kind: 'sq', mat: dm, on: 'any', back: 0.02, reach: 0.9 }, // under the sump
    { p: [0, hd.y, hd.z], d: [0, 1, 0.15], r: 0.016, kind: 'sq', mat: dm, on: 'any', back: 0.02, reach: 1.0 }, // head stay
    { p: [0, 0.0, -0.17], d: [0, -0.2, -1], r: 0.016, kind: 'sq', mat: dm, on: 'any', back: 0.02, reach: 0.35 }, // front mount
    { p: [mid.x - 0.03, mid.y + 0.03, mid.z], d: [-0.35, 1, 0], r: 0.012, kind: 'rod', mat: M.steel(), on: 'any', back: 0.02, reach: 0.6 }, // silencer hanger
  ] : undefined;
  g.userData.bikeEngine = { four };
  return g;
}

// ---------- frames and bodywork ----------
// Frame-local: forward -Z, up +Y; the head tube lies on the stock fork's steering axis. Seats are declared for crew.js
// ('bars': hands on the fork's grips, feet on the pegs). The frame's mass includes its rider's.
function headTube(b, T, a, Hc, m) {
  const p0 = T.clone().addScaledVector(a, -Hc + 0.024), p1 = T.clone().addScaledVector(a, -0.032);
  b.add(bar(p0, p1, 0.068, 0.068, true, 18), m);
  return [p0, p1];
}
function dirtFrame(c, lv) {
  const g = new THREE.Group(), b = new Bag(), fr = framePaint(0xe8601c), paint = PM.carPaint(c, 'satin'), blk = plastic(BLACK), dark = anod(0x2b2d31);
  const tb = lv ? pipe : tube, rake = DIRT_F.rake, a = V(0, Math.cos(rake), Math.sin(rake)), T = DIRT_T;
  const [h0, h1] = headTube(b, T, a, DIRT_F.Hc, fr);
  // twin spars to the pivot plates, a down tube splitting into the cradle under the engine, the subframe
  for (const sx of [-1, 1]) {
    b.add(tb([h1.clone().add(V(sx * 0.02, -0.01, 0.02)), V(sx * 0.1, 0.19, -0.2), V(sx * 0.13, 0.11, -0.02), V(sx * 0.135, -0.05, 0.1), V(sx * 0.135, -0.22, 0.15)], 0.022, 8, 40), fr);
    b.add(tb([V(0, -0.2, -0.36), V(sx * 0.06, -0.33, -0.3), V(sx * 0.07, -0.5, -0.2), V(sx * 0.07, -0.525, 0.0), V(sx * 0.11, -0.47, 0.11), V(sx * 0.13, -0.37, 0.14)], 0.016, 8, 40), fr);
    b.add(tb([V(sx * 0.125, 0.09, 0.0), V(sx * 0.11, 0.17, 0.3), V(sx * 0.09, 0.2, 0.58)], 0.013, 8, 24), dark); // subframe rails
    b.add(tb([V(sx * 0.135, -0.18, 0.15), V(sx * 0.11, 0.02, 0.36), V(sx * 0.09, 0.18, 0.56)], 0.011, 8, 24), dark); // subframe stays
    b.add(box(0.022, 0.2, 0.15, sx * 0.135, -0.3, 0.155), fr); // pivot plates
    b.add(bar(V(sx * 0.13, -0.355, 0.09), V(sx * 0.255, -0.36, 0.09), 0.03, 0.025), dark); // footpeg brackets
    if (lv) for (let k = 0; k < 5; k++) b.add(box(0.06, 0.008, 0.012, sx * 0.235, -0.345, 0.07 + k * 0.011), M.steel()); // peg teeth
    b.add(box(0.05, 0.01, 0.065, sx * 0.235, -0.352, 0.09), M.steel());
  }
  b.add(tb([h0.clone().add(V(0, 0.005, -0.012)), V(0, -0.05, -0.39), V(0, -0.2, -0.36)], 0.02, 8, 20), fr); // down tube
  b.add(xCyl(0.012, -0.125, 0.125, 0.125, 0.12), dark); // shock top cross tube
  b.add(box(0.15, 0.012, 0.3, 0, -0.537, -0.08), blk); // skid plate on the cradle
  // radiators beside the down tube, shrouds over them, tank, seat, side plates, rear fender, airbox
  for (const sx of [-1, 1]) {
    b.add(box(0.15, 0.26, 0.05, sx * 0.095, 0.0, -0.3), dark);
    for (const y of [-0.08, 0.08]) b.add(bar(V(sx * 0.03, y, -0.31), V(0, y, -0.395), 0.02, 0.02), dark); // brackets to the down tube
    if (lv) for (let k = 0; k < 9; k++) b.add(box(0.13, 0.004, 0.052, sx * 0.09, -0.11 + k * 0.027, -0.3), M.aluminum());
    b.add(side([[-0.36, -0.05], [-0.4, 0.12], [-0.34, 0.26], [-0.2, 0.31], [-0.02, 0.28], [-0.06, 0.12], [-0.2, -0.1]], sx * 0.185, 0.016), paint); // shroud
    b.add(side([[0.22, 0.02], [0.3, 0.21], [0.62, 0.24], [0.6, 0.08], [0.4, -0.02]], sx * 0.135, 0.014), paint); // side number plate
  }
  const tank = chaikin([{ z: -0.26, hw: 0.06, top: 0.25, bot: 0.13, n: 3 }, { z: -0.19, hw: 0.17, top: 0.3, bot: 0.06, n: 3.5 }, { z: -0.08, hw: 0.17, top: 0.315, bot: 0.06, n: 4 }, { z: 0.04, hw: 0.12, top: 0.3, bot: 0.12, n: 3.5 }], 1);
  const saddle = chaikin([{ z: -0.1, hw: 0.08, top: 0.325, bot: 0.25, n: 3 }, { z: 0.05, hw: 0.13, top: 0.335, bot: 0.24, n: 4 }, { z: 0.45, hw: 0.11, top: 0.315, bot: 0.21, n: 4 }, { z: 0.62, hw: 0.07, top: 0.3, bot: 0.22, n: 3 }], 1);
  b.add(superLoft(tank, lv ? 28 : 12, !!lv), paint); // tank
  b.add(superLoft(saddle, lv ? 28 : 12, !!lv), seatMat());
  b.add(side(band([[0.42, 0.24], [0.6, 0.25], [0.8, 0.27], [0.98, 0.31], [1.06, 0.33]], 0.03), 0, 0.15, 0.008), paint); // rear fender
  b.add(superLoft([{ z: 0.24, hw: 0.1, top: 0.22, bot: 0.08, n: 4 }, { z: 0.42, hw: 0.09, top: 0.22, bot: 0.1, n: 4 }], 12, !!lv), blk); // airbox
  if (lv) { const tl = new THREE.BoxGeometry(0.06, 0.03, 0.02); tl.translate(0, 0.31, 1.0); b.add(tl, M.light(0xff2010)); }
  if (lv) { const cap = new THREE.CylinderGeometry(0.03, 0.03, 0.015, 14); cap.translate(0, 0.315, -0.18); b.add(cap, dark); } // fuel cap
  b.to(g);
  // the rider (crew.js rideGeometry): standing in the attack stance over the saddle, knees gripping the tank and the
  // shrouds (their outer faces, as a box round the radiators), feet on the pegs
  const shrouds = [{ z: -0.4, hw: 0.193, top: 0.22, bot: -0.08, n: 8 }, { z: -0.3, hw: 0.193, top: 0.29, bot: -0.08, n: 8 }, { z: -0.12, hw: 0.193, top: 0.3, bot: 0.0, n: 8 }, { z: -0.02, hw: 0.193, top: 0.28, bot: 0.14, n: 8 }];
  g.userData.seats = [{ p: [0, 0.33, 0.2], s: 1, ctl: 'bars', rider: 'mx', pegs: [[-0.235, -0.335, 0.085], [0.235, -0.335, 0.085]], ground: -0.8, saddle, around: [tank, shrouds], knees: 'grip', lean: 0.6,
    stance: 'attack', legs: { hip: 1.95, knee: 2.2 }, hz0: 0.08 }]; // (the attack stance: up on the pegs, knees bent ~125 degrees, hips over the pegs, leaning over the bars)
  return g;
}
function sportFrame(c, lv) {
  const g = new THREE.Group(), b = new Bag(), alu = M.aluminum(), paint = PM.carPaint(c, 'satin'), blk = plastic(BLACK), dark = anod(0x2b2d31);
  const rake = SPORT_F.rake, a = V(0, Math.cos(rake), Math.sin(rake)), T = SPORT_T;
  const [h0, h1] = headTube(b, T, a, SPORT_F.Hc, alu);
  for (const sx of [-1, 1]) { // twin aluminium spars round the engine to the pivot
    b.add(superLoft([{ z: -0.42, hw: 0.04, top: 0.24, bot: 0.12, n: 6 }, { z: -0.2, hw: 0.04, top: 0.21, bot: 0.06, n: 6 }, { z: 0.02, hw: 0.04, top: 0.12, bot: -0.02, n: 6 }, { z: 0.13, hw: 0.04, top: 0.01, bot: -0.27, n: 6 }].map((s) => ({ ...s, hw: 0.025 })), 12, !!lv).translate(sx * 0.155, 0, 0), alu);
    b.add(bar(h1.clone().lerp(h0, 0.5), V(sx * 0.155, 0.18, -0.41), 0.05, 0.08), alu); // head stock gussets
    b.add(box(0.02, 0.15, 0.12, sx * 0.172, -0.19, 0.14), alu); // pivot plates
    b.add(side([[0.12, -0.13], [0.3, -0.19], [0.32, -0.25], [0.12, -0.27]], sx * 0.185, 0.012, 0.003), alu); // rearset hangers
    b.add(bar(V(sx * 0.19, -0.215, 0.27), V(sx * 0.27, -0.215, 0.27), 0.022, 0.022, true, 10), dark); // pegs
    b.add(tb3(sx), dark);
  }
  function tb3(sx) { return (lv ? pipe : tube)([V(sx * 0.155, 0.08, 0.0), V(sx * 0.1, 0.17, 0.4), V(sx * 0.07, 0.22, 0.75)], 0.012, 8, 20); } // subframe
  b.add(xCyl(0.012, -0.15, 0.15, 0.1, 0.12), dark); // shock top cross member
  // bodywork: the nose with its headlights and screen, the side panels and belly pan, tank, seat, tail
  const nose = chaikin([{ z: -0.9, hw: 0.04, top: 0.22, bot: 0.15, n: 2.5 }, { z: -0.84, hw: 0.15, top: 0.31, bot: 0.15, n: 3 }, { z: -0.7, hw: 0.24, top: 0.38, bot: 0.15, n: 3.5 }, { z: -0.54, hw: 0.29, top: 0.41, bot: 0.12, n: 4 }, { z: -0.44, hw: 0.29, top: 0.39, bot: 0.02, n: 4 }], 2);
  b.add(superLoft(nose, lv ? 36 : 14, !!lv), paint);
  for (const sx of [-1, 1]) b.add(side([[-0.44, 0.08], [-0.4, -0.1], [-0.32, -0.27], [-0.1, -0.31], [0.15, -0.27], [0.12, -0.05], [0.02, 0.06], [-0.25, 0.1]], sx * 0.215, 0.02), paint); // side panels, set in behind the front cowl where the rider's knees go (clear of the road at full lean)
  b.add(superLoft([{ z: -0.27, hw: 0.2, top: -0.22, bot: -0.46, n: 2.2 }, { z: 0.13, hw: 0.2, top: -0.22, bot: -0.43, n: 2.2 }], 20, !!lv), paint); // belly pan, meeting the side panels
  if (lv) for (const sx of [-1, 1]) { const vent = side([[-0.3, -0.06], [-0.12, -0.12], [-0.12, -0.16], [-0.3, -0.12]], sx * 0.226, 0.004, 0.001); b.add(vent, blk); }
  const tank = chaikin([{ z: -0.34, hw: 0.1, top: 0.3, bot: 0.15, n: 3 }, { z: -0.26, hw: 0.17, top: 0.36, bot: 0.1, n: 3.5 }, { z: -0.1, hw: 0.18, top: 0.355, bot: 0.08, n: 4 }, { z: 0.05, hw: 0.13, top: 0.27, bot: 0.1, n: 3.5 }], 1);
  const saddle = chaikin([{ z: 0.0, hw: 0.11, top: 0.235, bot: 0.12, n: 3 }, { z: 0.12, hw: 0.13, top: 0.215, bot: 0.11, n: 4 }, { z: 0.36, hw: 0.11, top: 0.235, bot: 0.12, n: 4 }], 1);
  b.add(superLoft(tank, lv ? 28 : 12, !!lv), paint); // tank
  b.add(superLoft(saddle, 20, !!lv), seatMat());
  b.add(superLoft(chaikin([{ z: 0.3, hw: 0.13, top: 0.25, bot: 0.06, n: 3.5 }, { z: 0.55, hw: 0.11, top: 0.33, bot: 0.14, n: 3.5 }, { z: 0.82, hw: 0.06, top: 0.37, bot: 0.24, n: 3 }, { z: 0.88, hw: 0.03, top: 0.35, bot: 0.27, n: 2.5 }], 1), lv ? 28 : 12, !!lv), paint); // tail
  if (lv) {
    const scr = superLoft(chaikin([{ z: -0.66, hw: 0.17, top: 0.39, bot: 0.36, n: 2.4 }, { z: -0.56, hw: 0.2, top: 0.5, bot: 0.4, n: 2.6 }, { z: -0.47, hw: 0.19, top: 0.52, bot: 0.38, n: 2.6 }], 1), 24, true);
    b.add(scr, glass()); // the screen
    { // the TFT dash under the screen, ahead of the top clamp on a bracket off the nose: revs, speed, gear (live: liveDisplays.js)
      const lp = CK.livePanel(), m = CK.faceM(V(0, 0.445, -0.505), V(0, 0.62, 0.78));
      CK.screen(b, b, m, 0.11, 0.055, 'engine', { d: 0.022, border: 0.008, housing: dark, fittings: false, live: { panel: lp, draw: CK.bikeTFT, px: [256, 128] } }); // (in the bike's dark anodising: one more draw call, the display)
      b.add(bar(V(0, 0.395, -0.51), V(0, 0.43, -0.505), 0.014, 0.02, true, 6), dark); lp.to(g); }
    for (const sx of [-1, 1]) { // twin headlights in the nose, mirrors on stalks
      const l = new THREE.SphereGeometry(0.06, 16, 10); l.scale(1.3, 0.55, 0.5); l.rotateX(-Math.PI / 2 - 0.35); l.translate(sx * 0.1, 0.25, -0.8); b.add(l, M.light(0xfff4dd));
      b.add(bar(V(sx * 0.27, 0.36, -0.5), V(sx * 0.33, 0.42, -0.47), 0.012, 0.012, true, 6), dark);
      const mr = new THREE.SphereGeometry(0.05, 12, 8); mr.scale(1, 0.55, 0.45); mr.translate(sx * 0.35, 0.43, -0.47); b.add(mr, paint);
    }
    const tl = superLoft([{ z: 0.87, hw: 0.05, top: 0.33, bot: 0.29, n: 3 }, { z: 0.895, hw: 0.04, top: 0.325, bot: 0.295, n: 3 }], 12, true); b.add(tl, M.light(0xff2010));
    b.add(box(0.12, 0.012, 0.16, 0, 0.17, 0.92), blk); b.add(box(0.11, 0.008, 0.07, 0, 0.17, 1.0), M.paint(0xf2f2ee, 'matte')); // number plate hanger
    b.add(bar(V(0, 0.27, 0.86), V(0, 0.17, 0.9), 0.04, 0.02), blk);
  }
  b.to(g);
  // the rider (crew.js rideGeometry): on the saddle, knees gripping the tank above the side panels (their outer faces
  // as a box), feet on the rearsets, reaching over the nose to the clip-ons
  const panels = [{ z: -0.44, hw: 0.226, top: 0.08, bot: -0.08, n: 10 }, { z: -0.32, hw: 0.226, top: 0.095, bot: -0.27, n: 10 }, { z: -0.1, hw: 0.226, top: 0.09, bot: -0.31, n: 10 }, { z: 0.02, hw: 0.226, top: 0.06, bot: -0.3, n: 10 }, { z: 0.12, hw: 0.226, top: -0.05, bot: -0.28, n: 10 }];
  g.userData.seats = [{ p: [0, 0.225, 0.2], s: 1, ctl: 'bars', rider: 'sport', pegs: [[-0.24, -0.205, 0.27], [0.24, -0.205, 0.27]], ground: -0.62, saddle, around: [tank, panels, nose], knees: 'grip', lean: 0.95,
    legs: { hip: 1.15, knee: 1.2 }, hz0: 0.08 }]; // (a racing crouch on rearsets: hips back on the seat, legs folded tight, knees to the tank)
  return g;
}

// ---------- the parts ----------
// Stock geometry (shared with design.js's presets): fork and swingarm wheels for each kind of bike.
export const DIRT_F = { r: 0.37, w: 0.09, h: 0.1, len: 0.32, Lf: 0.92, rake: 0.47, fx: 0.105, ro: 0.03, rin: 0.024, Hc: 0.17, outerL: 0.58, overlap: 0.24, bars: 'mx', fender: 'high', plate: true, discs: [-0.062], discR: 0.135, spokes: true, knobby: true, tubeIn: 'gold', lugC: 0x1c1d20, clampC: 0xe8601c, rimC: 0x1a1a1c };
export const DIRT_R = { r: 0.35, w: 0.12, h: 0.1, len: 0.32, P: [-0.08, -0.58], ax: 0.1, aw: 0.035, ah: 0.07, pfx: 0.135, shockTop: [0.36, -0.62], shockLug: [0, 0.12], spokes: true, knobby: true, discs: [0.065], discR: 0.11, sprocket: -0.072, sprR: 0.1, armC: 'alu', rimC: 0x1a1a1c };
export const SPORT_F = { r: 0.31, w: 0.12, h: 0.085, len: 0.22, Lf: 0.72, rake: 0.42, fx: 0.105, ro: 0.032, rin: 0.025, Hc: 0.14, outerL: 0.44, overlap: 0.2, bars: 'clip', fender: 'hug', discs: [-0.07, 0.07], discR: 0.155, spokes: false, knobby: false, tubeIn: 'gold', lugC: 0x15161a, clampC: 0x2b2d31, rimC: 0x15161a, tubeC: 0x15161a };
export const SPORT_R = { r: 0.32, w: 0.19, h: 0.1, len: 0.22, P: [-0.02, -0.56], ax: 0.155, aw: 0.04, ah: 0.09, pfx: 0.172, shockTop: [0.25, -0.58], shockLug: [0, 0.13], spokes: false, knobby: false, discs: [0.085], discR: 0.11, sprocket: -0.12, sprR: 0.1, armC: 'alu', rimC: 0x15161a, hubW: 0.2, springC: 0xc8102e };
// where the stock frames put their head tubes: the stock fork's top clamp at full extension (fork part at FORK_AT)
export const DIRT_AT = { fork: [0, -0.2, -0.74], rear: [0, -0.22, 0.74], engine: [0, -0.32, -0.07] };
export const SPORT_AT = { fork: [0, -0.18, -0.7], rear: [0, -0.17, 0.7], engine: [0, -0.24, -0.08] };
const topClamp = (F, at) => V(at[0], at[1] - F.len + F.Lf * Math.cos(F.rake), at[2] + F.Lf * Math.sin(F.rake));
const DIRT_T = topClamp(DIRT_F, DIRT_AT.fork), SPORT_T = topClamp(SPORT_F, SPORT_AT.fork);

def({ id: 'b_dirt', cat: 'bike', name: 'Dirt Bike Frame', desc: 'Motocross frame with tank, seat, shrouds and a high fender. Add a fork wheel in front, a swingarm wheel behind and an engine.', mass: 150, hp: 900, color: 0xe8601c, stand: 'box', riderDrag: 0.55,
  build: (c, lv) => dirtFrame(c, lv) });
def({ id: 'b_sport', cat: 'bike', name: 'Sport Bike Frame', desc: 'Racing frame with a full fairing, a screen and a tail. Add a road fork wheel, a road swingarm wheel and the four-cylinder engine.', mass: 185, hp: 1100, color: 0x1d4e89, stand: 'paddock', riderDrag: 0.36,
  build: (c, lv) => sportFrame(c, lv) });
const forkDef = (id, name, desc, o, mass) => def({ id, cat: 'bike', name, desc, mass, hp: 700, color: o.knobby ? 0xe8601c : 0x1d4e89, attach: 'gear',
  gear: { len: o.len, r: o.r, steer: true, brake: true, drive: false, limit: o.knobby ? 11 : 8, k: 3 }, build: (c, lv) => forkWheel(o, c, lv) });
const swingDef = (id, name, desc, o, mass) => def({ id, cat: 'bike', name, desc, mass, hp: 800, color: 0x1a1a1c, attach: 'gear',
  gear: { len: o.len, r: o.r, steer: false, brake: true, drive: true, limit: o.knobby ? 11 : 8, k: 3, grip: 1.15 }, build: (c, lv) => swingWheel(o, c, lv) });
forkDef('b_fork_dirt', 'Dirt Fork Wheel', 'Knobby front wheel on long-travel forks with wide bars and a number plate. It steers. Put it at the front of a bike.', DIRT_F, 16);
forkDef('b_fork_road', 'Road Fork Wheel', 'Sticky front wheel on stiff racing forks with low clip-on bars and twin brakes. It steers.', SPORT_F, 18);
swingDef('b_swing_dirt', 'Dirt Swingarm Wheel', 'Knobby back wheel on a swingarm with a big shock and a chain. The engine drives it.', DIRT_R, 18);
swingDef('b_swing_road', 'Road Swingarm Wheel', 'Fat slick back wheel on a racing swingarm with a shock. The engine drives it.', SPORT_R, 22);
// Engines: the 'drive' engine type, like the Car Engine: it pushes through the driven wheels. sound: the engine voice
// (motorSound.js: a single-cylinder thumper, a screaming inline four).
def({ id: 'b_single', cat: 'bike', name: 'Dirt Bike Engine', desc: 'Big single-cylinder thumper with a high pipe. Drives the back wheel. Full gas for a wheelie!', mass: 34, hp: 700, color: 0x2b2d31,
  engine: { type: 'drive', thrust: 2300, vmax: 44, sound: 'dirtbike', idleRpm: 1400, maxRpm: 2700, cyl: 1 },
  build: (c, lv) => bikeEngine({ four: false, color: c, lv }) });
def({ id: 'b_four', cat: 'bike', name: 'Sport Bike Engine', desc: 'Screaming four-cylinder racing engine. Very fast!', mass: 60, hp: 900, color: 0x2b2d31,
  engine: { type: 'drive', thrust: 2700, vmax: 70, sound: 'sportbike', idleRpm: 1300, maxRpm: 2700, cyl: 4 },
  build: (c, lv) => bikeEngine({ four: true, color: c, lv }) });

// ---------- per frame (planeDetail.updateDetail): every bike wheel follows its physics wheel ----------
// ac: the Aircraft (or the hangar's preview stand-in, which has no wheels moving: then the fork just follows the stick)
export function bikeSync(ac) {
  for (const p of ac.parts) {
    const u = p.obj?.userData; if (!p.alive || !u?.bikeSync) continue;
    const px = u.wheels, d = PARTS[p.p?.id ?? '']?.gear;
    if (d && p.gear) u.bikeSync({ comp: px.position.y + d.len, steer: px.rotation.y, spin: px.children[0]?.rotation.x || 0 });
    else u.bikeSync({ comp: 0, steer: u.bikeWheel === 'front' ? clamp(-(ac.crewSteer || 0) * 0.3, -0.5, 0.5) : 0, spin: 0 });
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- riders (crew.js 'bars' seats) ----------
// After the crew is seated (planeDetail.assemble): every rider gets the grips of the fork nearest its seat, so its hands
// stay on the bars as they turn. Without a fork (a kid's bike on car wheels) the hands rest on the tank.
const toRoot = (o, p, root, out = V()) => { out.copy(p); for (let x = o; x && x !== root; x = x.parent) { x.updateMatrix(); out.applyMatrix4(x.matrix); } return out; };
const chain = (o, root, out = new THREE.Matrix4()) => { out.identity(); const list = []; for (let x = o; x && x !== root; x = x.parent) list.push(x); for (let k = list.length - 1; k >= 0; k--) { list[k].updateMatrix(); out.multiply(list[k].matrix); } return out; };
export function wireRiders(objs) {
  const forks = objs.filter((o) => o?.userData.grips);
  for (const o of objs) for (const r of o?.userData.crew || []) {
    if (r.rig.ctl !== 'bars') continue;
    const root = o.parent, at = toRoot(r.root, V(), root);
    let best = null, bd = Infinity;
    for (const f of forks) { const d = toRoot(f, V(), root).distanceTo(at); if (d < bd) { bd = d; best = f; } }
    r.bars = { grips: best ? best.userData.grips : null, root };
  }
}
const _m4 = new THREE.Matrix4(), _gp = V();
const attached = (o, root) => { for (let x = o; x; x = x.parent) if (x === root) return true; return false; };
// The rider's inputs from the bike: hands on the grips (rig space), the extra lean into a turn, the tuck at speed, a
// foot down when stopped.
export function riderInput(ac, r) {
  const b = ac.bike, out = { lean: 0, bikeLean: 0, tuck: 0, foot: 0, brace: 0, hands: null };
  if (b) { out.bikeLean = b.lean; out.lean = clamp(b.lean * 0.5, -0.45, 0.45); out.tuck = b.tuck; out.brace = b.brace || 0; out.foot = ac.onGround ? 1 - clamp((Math.abs(ac.groundSpeed) - 0.4) / 1.2, 0, 1) : 0; }
  const g = r.bars?.grips; if (!g) return out;
  _m4.copy(chain(r.root, r.bars.root)).invert();
  // [left, right]; null for a grip no longer on this vehicle (its fork broke off and flew away): that hand lets go
  out.hands = g.map((h) => attached(h.o, r.bars.root) ? toRoot(h.o, h.p, r.bars.root, V()).applyMatrix4(_m4) : null);
  return out;
}

// ---------- hangar: a stand to show the bike on ----------
// Dirt frames (and any other bike) sit on a motocross box stand under the frame, the wheels just off the floor; a frame
// that asks for paddock stands (sport) gets one under each axle's ends. Sized from the built bike. Returns
// { stand (world space: add it to the scene), y (for root.position.y) } like hangar.uprightStage.
export function bikeStand(design, root) {
  root.updateMatrixWorld(true);
  const wheels = [];
  design.parts.forEach((p, i) => {
    const d = PARTS[p.id]; if (!d?.gear || d.gear.float) return;
    const o = root.children.find((c) => c.userData.partIndex === i); if (!o) return;
    const s = Math.cbrt(Math.abs(o.matrixWorld.determinant())), top = V().setFromMatrixPosition(o.matrixWorld);
    const hub = top.clone().add(V(0, -d.gear.len * s, 0)), half = o.userData.axleHalf ? o.userData.axleHalf * s : new THREE.Box3().setFromObject(o).getSize(V()).x / 2;
    wheels.push({ hub, r: d.gear.r * s, half, o });
  });
  if (wheels.length < 2) return null;
  const lift = 0.04, low = Math.min(...wheels.map((w) => w.hub.y - w.r)), y = -low + lift;
  const style = design.parts.map((p) => PARTS[p.id]?.stand).find(Boolean) || 'box';
  const st = new THREE.Group(), b = new Bag(), red = M.paint(0xc8102e, 'gloss'), steel = M.steel(), rub = rubber(), dark = anod(0x2b2d31);
  wheels.sort((a, c) => a.hub.z - c.hub.z);
  if (style === 'paddock') {
    for (const w of wheels) {
      const yA = w.hub.y + y - 0.012, z = w.hub.z, back = w === wheels[0] ? -1 : 1, zb = z + back * 0.3, x = Math.max(w.half, w.r * 0.5);
      for (const sx of [-1, 1]) {
        b.add(bar(V(sx * x, 0.04, z), V(sx * x, yA - 0.04, z), 0.035, 0.035), red); // upright under the axle end
        b.add(bar(V(sx * x, yA - 0.045, z), V(sx * x, yA + 0.002, z), 0.045, 0.06, true, 10), rub); // cup it sits in
        b.add(bar(V(sx * x, 0.045, z + back * 0.02), V(sx * x, 0.045, zb), 0.035, 0.035), red); // base rail
        b.add(xCyl(0.045, sx * x - 0.022, sx * x + 0.022, 0.045, zb, 14), rub); // roller
        b.add(bar(V(sx * x, 0.06, z + back * 0.01), V(sx * x, Math.min(yA * 0.5, 0.25), zb * 0.5 + z * 0.5), 0.022, 0.022), red); // brace
      }
      b.add(xCyl(0.02, -x, x, 0.045, zb), red); b.add(xCyl(0.018, -x, x, 0.045, z), red);
      b.add(bar(V(0, 0.045, zb), V(0, 0.5, zb + back * 0.45), 0.03, 0.03, true, 10), red); // handle
      b.add(bar(V(0, 0.5, zb + back * 0.45), V(0, 0.52, zb + back * 0.5), 0.045, 0.045, true, 10), rub);
    }
  } else { // box stand under the lowest point of the bike between its wheels
    const pts = [], v = V(), z0 = wheels[0].hub.z + wheels[0].r * 0.6, z1 = wheels.at(-1).hub.z - wheels.at(-1).r * 0.6;
    root.traverse((m) => {
      if (!m.isMesh || !m.visible || m.userData.crew || m.isSkinnedMesh || wheels.some((w) => { for (let x = m; x; x = x.parent) if (x === w.o) return true; return false; })) return;
      const a = m.geometry.attributes.position, step = Math.max(1, Math.floor(a.count / 400));
      for (let i = 0; i < a.count; i += step) { v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld); if (Math.abs(v.x) < 0.12 && v.z > z0 && v.z < z1) pts.push(v.clone()); }
    });
    if (!pts.length) return { stand: st, y };
    const lowP = pts.reduce((a, c) => (c.y < a.y ? c : a)), H = lowP.y + y, zc = lowP.z, w = 0.3, d = 0.26;
    b.add(box(w + 0.04, 0.022, d + 0.04, 0, 0.011, zc), dark); // base
    b.add(box(w, 0.03, d, 0, H - 0.015, zc), red); // top
    b.add(box(w * 0.9, 0.012, d * 0.9, 0, H - 0.006 + 0.006, zc), rub); // rubber pad
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(bar(V(sx * w * 0.45, 0.02, zc + sz * d * 0.45), V(sx * w * 0.42, H - 0.03, zc + sz * d * 0.42), 0.03, 0.03), red);
    for (const sx of [-1, 1]) b.add(bar(V(sx * w * 0.45, 0.04, zc - d * 0.45), V(sx * w * 0.42, H - 0.04, zc + d * 0.42), 0.018, 0.018, true, 6), steel);
  }
  b.to(st); st.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { stand: st, y };
}
