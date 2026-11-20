// Crew: seated pilots and drivers with their hands on the controls, and the controls move.
// One figure = two skinned meshes (matte + glossy) sharing one skeleton: two draw calls, whatever the pose. Every
// piece of the figure and of its controls (stick, throttle, yoke, steering wheel, collective, pedals) is rigidly bound
// to one bone, and the bones are posed every frame from the control inputs: the stick / yoke / wheel / pedals move,
// two-bone IK keeps the hands on the grips and the feet on the pedals, and the head looks a little into the turn.
//
// Rig space: origin at the hip point on the seat, forward -Z, up +Y, metres for an adult (the cockpit gives a scale).
// Cockpit builders only declare seats (obj.userData.seats); planeDetail.assemble() dresses them for the vehicle
// (fighter pilot, light-plane pilot with a headset, rescue crew, racing driver, airline crew, astronaut) through addCrew().
// Visual only: nothing here is seen by physics.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { PARTS } from './parts.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const col = (hex) => new THREE.Color(hex); // linear working colour from sRGB hex

// ---------- materials (shared by every figure) ----------
let _mats = null;
export function crewMaterials() {
  if (_mats) return _mats;
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  const gloss = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.3 });
  matte.name = 'crewMatte'; gloss.name = 'crewGloss';
  return (_mats = { matte, gloss });
}

// ---------- outfits ----------
// colours: suit, suit2 (vest / trousers), trim (stripes, harness), glove, boot, skin, hair, helmet, helmet2, visor
const SKIN = [0xe0ac8a, 0xb07a55, 0x7a4b32, 0xf0c8a8];
const HAIR = [0x2b1d14, 0x4a3020, 0x111111, 0x8a6a3a];
export const OUTFITS = {
  jet: { head: 'helmet', mask: true, visor: 0x8a6a1e, helmet: 0xdfe2e4, helmet2: 0x4d5560, suit: 0x56603f, suit2: 0x3e4531, trim: 0x2a2c2e, glove: 0x3b2e25, boot: 0x1a1a1a, harness: true },
  space: { head: 'bubble', visor: 0xb08a2a, helmet: 0xf2f2ee, helmet2: 0xc8102e, suit: 0xe9e9e4, suit2: 0xd4d4ce, trim: 0x8a9099, glove: 0xf0f0ea, boot: 0xe2e2dc, harness: false, ring: true },
  light: { head: 'headset', glasses: true, suit: 0x2f5d8a, suit2: 0xb9a57d, trim: 0x2a2c2e, glove: null, boot: 0x3b2a1e, cups: 0x26282b },
  warbird: { head: 'leather', suit: 0x6b4a2e, suit2: 0x5a5f45, trim: 0xd8d2c2, glove: 0x4a3322, boot: 0x2a1d14, harness: true },
  racer: { head: 'helmet', mask: false, visor: 0x1b2127, helmet: 0xf2b705, helmet2: 0x15161a, suit: 0xf2f2ee, suit2: 0xc8102e, trim: 0x15161a, glove: 0x15161a, boot: 0x15161a, harness: true },
  heli: { head: 'helmet', mic: true, visor: 0x14191e, helmet: 0xf2f2ee, helmet2: 0xc8102e, suit: 0xd9531c, suit2: 0x3d3f44, trim: 0xd9dcdf, glove: 0x1d1e20, boot: 0x1a1a1a, stripes: true },
  medic: { head: 'helmet', mic: true, visor: 0x14191e, helmet: 0xf2f2ee, helmet2: 0x2e7d32, suit: 0x2e7d32, suit2: 0x2b2d31, trim: 0xd9dcdf, glove: 0x1d1e20, boot: 0x1a1a1a, stripes: true },
  driver: { head: 'fullface', visor: 0x101418, helmet: 0xe8601c, helmet2: 0x15161a, suit: 0xc8102e, suit2: 0x15161a, trim: 0xf2f2ee, glove: 0x15161a, boot: 0x15161a, harness: true, stripes: true },
  // motorbike riders: a motocross kit (jersey, goggles under a peaked helmet, big boots) and road-racing leathers
  mx: { head: 'fullface', peak: true, visor: 0xd9761c, helmet: 0xf2f2ee, helmet2: 0xe8601c, suit: 0xe8601c, suit2: 0x2b2d31, trim: 0xf2f2ee, glove: 0x15161a, boot: 0xf2f2ee, stripes: true, bigBoots: true },
  sport: { head: 'fullface', visor: 0x1b2127, helmet: 0xf2f2ee, helmet2: 0x1d4e89, suit: 0x1d4e89, suit2: 0xf2f2ee, trim: 0xc8102e, glove: 0x15161a, boot: 0x15161a, stripes: true, hump: true },
  airline: { head: 'headset', shirt: true, suit: 0xf2f2f0, suit2: 0x1b2433, trim: 0x15161a, glove: null, boot: 0x111111, cups: 0x26282b, epaulettes: 0xd4a82a },
};

// ---------- geometry helpers ----------
const UP = V(0, 1, 0), FWD = V(0, 0, -1);
// rotation taking +Y to dir, with local -Z as close as possible to hint (forward)
function basis(dir, hint = FWD, out = new THREE.Quaternion()) {
  const y = dir.clone().normalize(); let h = hint.clone();
  if (Math.abs(h.dot(y)) > 0.97) h = Math.abs(y.y) < 0.9 ? UP.clone() : V(1, 0, 0);
  const z = h.addScaledVector(y, -h.dot(y)).normalize().negate(), x = y.clone().cross(z).normalize();
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// tapered capsule along +Y from 0 to L (radius r0 at the bottom, r1 at the top), optional elliptic section (sx, sz)
function capsule(L, r0, r1 = r0, { sx = 1, sz = 1, seg = 8, ring = 3 } = {}) {
  const pts = [];
  for (let i = 0; i <= ring; i++) { const a = -Math.PI / 2 + (i / ring) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r0, Math.sin(a) * r0)); }
  for (let i = 0; i <= ring; i++) { const a = (i / ring) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r1 + 1e-4, L + Math.sin(a) * r1)); }
  pts[0].x = 1e-4; pts[pts.length - 1].x = 1e-4;
  const g = new THREE.LatheGeometry(pts, seg); g.scale(sx, 1, sz); return g;
}
// capsule from a to b (rig points)
function capAB(a, b, r0, r1 = r0, o = {}) {
  const d = b.clone().sub(a), g = capsule(d.length(), r0, r1, o);
  g.applyMatrix4(new THREE.Matrix4().compose(a, basis(d, o.hint || FWD), V(1, 1, 1))); return g;
}
function ellipsoid(c, rx, ry, rz, { w = 10, h = 7, phi = [0, Math.PI * 2], th = [0, Math.PI] } = {}) {
  const g = new THREE.SphereGeometry(1, w, h, phi[0], phi[1], th[0], th[1]); g.scale(rx, ry, rz); g.translate(c.x, c.y, c.z); return g;
}
// front-facing spherical patch (centre of the patch towards -Z): half-angle a around, theta band t0..t1 from the top
const frontPatch = (r, a, t0, t1, w = 16, h = 6) => new THREE.SphereGeometry(r, w, h, Math.PI * 1.5 - a, a * 2, t0, t1 - t0);
function torusAB(R, r, arc, seg = 24) { return new THREE.TorusGeometry(R, r, 6, seg, arc); }
function boxG(sx, sy, sz, c) { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(c.x, c.y, c.z); return g; }

// pieces → two merged skinned geometries (matte, gloss)
class Kit {
  constructor() { this.p = { matte: [], gloss: [] }; }
  add(geo, hex, bone, gloss = false, m = null) {
    const g = geo; if (m) g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    const n = g.attributes.position.count, c = col(hex), cs = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { cs[i * 3] = c.r; cs[i * 3 + 1] = c.g; cs[i * 3 + 2] = c.b; si[i * 4] = bone; sw[i * 4] = 1; }
    g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    this.p[gloss ? 'gloss' : 'matte'].push(g); return this;
  }
  build() { const o = {}; for (const k in this.p) o[k] = this.p[k].length ? mergeGeometries(this.p[k]) : null; return o; }
}

// ---------- the rig ----------
// Bones (flat, all children of the rig root; transforms in rig space)
const B = { hips: 0, spine: 1, head: 2, uArmR: 3, fArmR: 4, uArmL: 5, fArmL: 6, thighR: 7, shinR: 8, thighL: 9, shinL: 10, ctlA: 11, ctlB: 12, pedR: 13, pedL: 14, ctlC: 15 };
const NB = 16;
const DIM = { lean: 0.2, spine: 0.5, shoulderW: 0.19, shoulderUp: 0.44, upper: 0.29, fore: 0.27, hand: 0.05, hipW: 0.1, thigh: 0.45, shin: 0.43, ankle: 0.07 };

// Where the controls are, per control kind (rig space, scale 1). Each returns the rest transforms of its bones and
// how to pose them from the inputs.
const CTL = {
  stick: { // centre stick between the knees, throttle on the left console
    stickBase: V(0, -0.1, -0.44), stickLen: 0.36, thrBase: V(-0.3, 0.06, -0.12), thrLen: 0.17,
  },
  cyclic: { // helicopter: cyclic between the knees, collective lever beside the seat (raised with the throttle)
    stickBase: V(0, -0.12, -0.42), stickLen: 0.42, collBase: V(-0.27, 0.02, 0.1), collLen: 0.42,
  },
  yoke: { colBase: V(0, -0.3, -0.62), colLen: 0.62, yokeR: 0.15 },
  wheel: { col: V(0, 0.28, -0.52), tilt: 0.42, wheelR: 0.19 },
  bars: {}, // a motorbike: hands on the fork's grips (given every frame), feet on the pegs, the body leans and tucks
  none: {},
};

function ikTwo(S, T, a, b, pole, outE) {
  const d = T.clone().sub(S), L = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3); d.normalize();
  const x = (a * a - b * b + L * L) / (2 * L), y = Math.sqrt(Math.max(0, a * a - x * x));
  const p = pole.clone().addScaledVector(d, -pole.dot(d)); if (p.lengthSq() < 1e-8) p.set(0, -1, 0); p.normalize();
  return outE.copy(S).addScaledVector(d, x).addScaledVector(p, y);
}

class Rig {
  constructor(kind, ctl, outfit, seed, opts = {}) {
    this.kind = kind; this.ctl = ctl; this.o = outfit; this.seed = seed;
    this.pegs = opts.pegs || [V(-0.24, -0.62, 0.0), V(0.24, -0.62, 0.0)]; this.groundY = opts.groundY ?? -1.1;
    const C = CTL[ctl] || CTL.none, D = DIM;
    this.C = C;
    // static joints
    const spineQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), D.lean);
    this.spineQ = spineQ; this.spinePos = V(0, 0.03, 0);
    const sp = (x, y, z) => V(x, y, z).applyQuaternion(spineQ).add(this.spinePos);
    this.neck = sp(0, D.spine, 0.0);
    this.shR = sp(D.shoulderW, D.shoulderUp, 0.02); this.shL = sp(-D.shoulderW, D.shoulderUp, 0.02);
    this.hipR = V(D.hipW, 0, 0); this.hipL = V(-D.hipW, 0, 0);
    this.state = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
    this.q = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.p = Array.from({ length: NB }, () => V());
    this.pose(this.state);
  }
  // control bone transforms + hand/foot targets
  controls(s) {
    const C = this.C, p = this.p, q = this.q, hands = {}, feet = {};
    const e = new THREE.Euler();
    if (this.ctl === 'stick' || this.ctl === 'cyclic') {
      // stick: pitch back (+) tilts the grip towards the pilot (+z), roll right (+) tilts it right
      p[B.ctlA].copy(C.stickBase); q[B.ctlA].setFromEuler(e.set(s.pitch * 0.32, 0, -s.roll * 0.3));
      const grip = V(0, C.stickLen, 0).applyQuaternion(q[B.ctlA]).add(C.stickBase);
      hands.R = grip.clone().add(V(0.015, -0.015, 0.02));
      if (this.ctl === 'stick') {
        p[B.ctlB].copy(C.thrBase); q[B.ctlB].setFromEuler(e.set(-0.55 + s.thr * 1.1, 0, 0)); // forward = more throttle
        hands.L = V(0, C.thrLen, 0).applyQuaternion(q[B.ctlB]).add(C.thrBase).add(V(-0.01, 0.01, 0.0));
      } else {
        // collective: lever from a pivot behind, pointing forward; raised with the throttle
        p[B.ctlB].copy(C.collBase); q[B.ctlB].setFromEuler(e.set(-Math.PI / 2 + 0.18 + s.thr * 0.35, 0, 0));
        hands.L = V(0, C.collLen, 0).applyQuaternion(q[B.ctlB]).add(C.collBase).add(V(0, 0.03, 0));
      }
    } else if (this.ctl === 'yoke') {
      // column hinged at the floor: pull = back; the yoke turns about the column's top axis
      p[B.ctlA].copy(C.colBase); q[B.ctlA].setFromEuler(e.set(0.42 + s.pitch * 0.14, 0, 0));
      const top = V(0, C.colLen, 0).applyQuaternion(q[B.ctlA]).add(C.colBase);
      // the yoke stands nearly upright facing the pilot and turns about the axis towards the pilot (local Z)
      p[B.ctlB].copy(top); q[B.ctlB].setFromEuler(e.set(0.12, 0, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -s.roll * 0.7));
      for (const [k, sx] of [['R', 1], ['L', -1]]) hands[k] = V(sx * C.yokeR, 0.02, 0.0).applyQuaternion(q[B.ctlB]).add(top);
    } else if (this.ctl === 'wheel') {
      const tq = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), C.tilt); // wheel plane leans back towards the driver
      p[B.ctlA].copy(C.col); q[B.ctlA].copy(tq).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), s.steer));
      for (const [k, a] of [['R', -1.15], ['L', 1.15]]) hands[k] = V(Math.sin(-a) * C.wheelR, Math.cos(a) * C.wheelR, 0.02).applyQuaternion(q[B.ctlA]).add(C.col);
    } else if (this.ctl === 'bars') { // on the grips (rig space, from the fork), else resting on the tank
      hands.L = s.hands?.[0] || V(-0.2, 0.05, -0.42); hands.R = s.hands?.[1] || V(0.2, 0.05, -0.42);
      feet.L = this.pegs[0].clone().lerp(V(this.pegs[0].x - 0.1, this.groundY + 0.06, this.pegs[0].z - 0.12), s.foot || 0); // a foot down when stopped
      feet.R = this.pegs[1].clone();
      return { hands, feet };
    } else {
      hands.R = V(0.16, 0.0, -0.32); hands.L = V(-0.16, 0.0, -0.32); // resting on the thighs
    }
    // pedals: rudder pedals swing fore and aft; a car has a throttle pedal under the right foot
    const pz = -0.86, py = -0.34;
    if (this.ctl === 'wheel') {
      p[B.pedR].set(0.12, py, pz); q[B.pedR].setFromEuler(e.set(-0.5 - s.thr * 0.35, 0, 0));
      p[B.pedL].set(-0.14, py, pz + 0.02); q[B.pedL].setFromEuler(e.set(-0.5, 0, 0));
    } else {
      p[B.pedR].set(0.13, py, pz - s.yaw * 0.06); q[B.pedR].setFromEuler(e.set(-0.35, 0, 0));
      p[B.pedL].set(-0.13, py, pz + s.yaw * 0.06); q[B.pedL].setFromEuler(e.set(-0.35, 0, 0));
    }
    feet.R = V(0, 0.1, 0.05).applyQuaternion(q[B.pedR]).add(p[B.pedR]);
    feet.L = V(0, 0.1, 0.05).applyQuaternion(q[B.pedL]).add(p[B.pedL]);
    return { hands, feet };
  }
  pose(s) {
    const D = DIM, p = this.p, q = this.q, { hands, feet } = this.controls(s), bars = this.ctl === 'bars';
    if (bars) { // a rider: bent forward over the tank (more when tucked at speed), leaning further into a turn than the bike
      const fwd = (this.o.hump ? 0.6 : 0.42) + (s.tuck || 0) * (this.o.hump ? 0.42 : 0.22), lean = s.lean || 0;
      this.hipAt = V(lean * 0.12, -Math.abs(lean) * 0.03, (s.tuck || 0) * 0.04);
      this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -lean).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -fwd));
      this.spinePos = V(0, 0.03, 0).add(this.hipAt);
      const sp = (x, y, z) => V(x, y, z).applyQuaternion(this.spineQ).add(this.spinePos);
      this.neck = sp(0, D.spine, 0.0); this.shR = sp(D.shoulderW, D.shoulderUp, 0.02); this.shL = sp(-D.shoulderW, D.shoulderUp, 0.02);
      this.hipR = V(D.hipW, 0, 0).add(this.hipAt); this.hipL = V(-D.hipW, 0, 0).add(this.hipAt);
    }
    if (bars) p[B.hips].copy(this.hipAt); else p[B.hips].set(0, 0, 0);
    q[B.hips].identity();
    p[B.spine].copy(this.spinePos); q[B.spine].copy(this.spineQ);
    p[B.head].copy(this.neck);
    if (bars) q[B.head].setFromEuler(new THREE.Euler(-0.1, s.look * 0.5, (s.bikeLean || 0) * 0.55 + (s.lean || 0) * 0.5, 'YXZ')); // eyes level, looking up the road
    else q[B.head].setFromEuler(new THREE.Euler(-0.08 + s.pitch * 0.05, s.look, s.look * 0.15, 'YXZ'));
    const E = V();
    const limb = (S, T, a, b, pole, iu, iff, hint) => {
      ikTwo(S, T, a, b, pole, E);
      p[iu].copy(S); basis(E.clone().sub(S), hint, q[iu]);
      p[iff].copy(E); basis(T.clone().sub(E), hint, q[iff]);
    };
    const handL = D.fore + D.hand;
    const eR = bars ? V(0.9, -0.1, 0.3) : V(0.55, -0.8, 0.25), kR = bars ? V(0.5, 0.6, -1) : V(0.1, 1, -0.4); // riders: elbows out, knees forward against the tank
    limb(this.shR, hands.R, D.upper, handL, eR, B.uArmR, B.fArmR, V(0.2, 0, -1));
    limb(this.shL, hands.L, D.upper, handL, V(-eR.x, eR.y, eR.z), B.uArmL, B.fArmL, V(-0.2, 0, -1));
    limb(this.hipR, feet.R, D.thigh, D.shin, kR, B.thighR, B.shinR, FWD);
    limb(this.hipL, feet.L, D.thigh, D.shin, V(-kR.x, kR.y, kR.z), B.thighL, B.shinL, FWD);
  }
}

// ---------- building a figure (rest pose geometry, bone-local pieces baked through the rest transforms) ----------
function figureGeometry(rig) {
  const o = rig.o, k = new Kit(), D = DIM, seed = rig.seed;
  const skin = SKIN[seed % SKIN.length], hair = HAIR[(seed * 7 + 1) % HAIR.length];
  const R = (i) => new THREE.Matrix4().compose(rig.p[i], rig.q[i], V(1, 1, 1));
  const at = (i, geo, hex, gloss = false) => k.add(geo, hex, i, gloss, R(i));
  // pelvis + seat contact
  at(B.hips, ellipsoid(V(0, 0.04, 0.02), 0.19, 0.12, 0.15), o.suit2);
  // torso: a lofted chest, wider at the shoulders, a little deeper than wide at the belly
  const torso = capsule(0.3, 0.14, 0.12, { sx: 1.25, sz: 0.85, seg: 14, ring: 4 }); torso.translate(0, 0.06, 0.0); // top at the shoulder line
  at(B.spine, torso, o.suit);
  at(B.spine, ellipsoid(V(0, D.shoulderUp - 0.03, 0.01), 0.2, 0.065, 0.1, { w: 14 }), o.suit); // shoulder line
  if (o.harness) { // shoulder straps, lap belt and the buckle
    for (const sx of [-1, 1]) at(B.spine, capAB(V(sx * 0.1, D.shoulderUp + 0.03, 0.08), V(sx * 0.07, 0.12, -0.13), 0.022, 0.022, { sz: 0.4, seg: 6 }), o.trim);
    at(B.hips, capAB(V(-0.17, 0.08, -0.1), V(0.17, 0.08, -0.1), 0.025, 0.025, { seg: 6 }), o.trim);
    at(B.spine, boxG(0.07, 0.07, 0.03, V(0, 0.13, -0.135)), 0x9aa0a6, true);
  }
  if (o.hump) at(B.spine, ellipsoid(V(0, D.shoulderUp - 0.06, 0.12), 0.09, 0.12, 0.06, { w: 12 }), o.suit, true); // leathers' aero hump
  if (o.mask === true) { const vest = capsule(0.16, 0.15, 0.135, { sx: 1.25, sz: 0.88, seg: 14, ring: 2 }); vest.translate(0, 0.17, 0); at(B.spine, vest, o.suit2); } // survival vest
  if (o.stripes) for (const y of [0.2, 0.32]) { const r = 0.14 - (y - 0.06) * 0.067 + 0.004, st = new THREE.CylinderGeometry(r, r, 0.035, 16, 1, true); st.scale(1.25, 1, 0.85); st.translate(0, y, 0); at(B.spine, st, o.trim); }
  if (o.shirt) { // tie and epaulettes
    at(B.spine, capAB(V(0, D.shoulderUp - 0.02, -0.115), V(0, 0.16, -0.122), 0.022, 0.03, { sz: 0.25, seg: 6 }), o.trim);
    for (const sx of [-1, 1]) at(B.spine, boxG(0.09, 0.012, 0.045, V(sx * 0.15, D.shoulderUp + 0.03, 0.01)), 0x15161a), at(B.spine, boxG(0.092, 0.014, 0.008, V(sx * 0.15, D.shoulderUp + 0.032, 0.01)), o.epaulettes, true);
  }
  // arms: sleeve, elbow, forearm and a gloved (or bare) fist
  const hand = o.glove ?? skin;
  for (const [u, f, sx] of [[B.uArmR, B.fArmR, 1], [B.uArmL, B.fArmL, -1]]) {
    at(u, ellipsoid(V(0, 0.01, 0), 0.055, 0.055, 0.055), o.suit);
    at(u, capsule(D.upper, 0.052, 0.045), o.suit);
    at(f, capsule(D.fore, 0.047, 0.038), o.shirt ? skin : o.suit);
    if (o.shirt) at(f, capsule(0.06, 0.05, 0.05), o.suit); // rolled sleeve
    if (o.glove) at(f, capsule(0.07, 0.044, 0.048, { ring: 3 }).translate(0, D.fore - 0.05, 0), o.glove); // gauntlet
    at(f, ellipsoid(V(0, D.fore + D.hand - 0.005, -0.005), 0.042, 0.055, 0.048), hand);
    at(f, capAB(V(sx * -0.03, D.fore + 0.02, -0.035), V(sx * -0.02, D.fore + 0.07, -0.05), 0.014, 0.012, { seg: 6, ring: 3 }), hand); // thumb
  }
  // legs and boots
  for (const [t, s] of [[B.thighR, B.shinR], [B.thighL, B.shinL]]) {
    at(t, capsule(D.thigh, 0.08, 0.062, { sz: 0.92 }), o.suit2);
    at(s, ellipsoid(V(0, 0, 0), 0.062, 0.062, 0.062), o.suit2);
    at(s, capsule(D.shin - 0.04, 0.056, 0.046), o.suit2);
    const boot = ellipsoid(V(0, D.shin + 0.0, -0.06), 0.052, 0.05, 0.12); at(s, boot, o.boot);
    if (o.bigBoots) at(s, capsule(0.24, 0.058, 0.062).translate(0, D.shin - 0.24, 0), o.boot); // motocross boots up the shin
  }
  // head: neck, then per outfit
  const hc = V(0, 0.135, -0.01);
  at(B.head, capsule(0.07, 0.05, 0.048), o.head === 'headset' || o.head === 'leather' ? skin : o.suit);
  if (o.head === 'leather') { // white silk scarf round the neck, the end tucked into the jacket
    at(B.head, torusAB(0.062, 0.022, Math.PI * 2, 14).rotateX(Math.PI / 2).translate(0, 0.03, 0), 0xf2f2ee);
  }
  const face = () => { // a simple face: skull, jaw, nose, ears, eyes and brows
    at(B.head, ellipsoid(hc, 0.083, 0.105, 0.098), skin);
    at(B.head, ellipsoid(V(0, hc.y - 0.05, hc.z - 0.03), 0.065, 0.055, 0.07), skin); // jaw
    at(B.head, ellipsoid(V(0, hc.y - 0.005, hc.z - 0.1), 0.014, 0.026, 0.02), skin); // nose
    for (const sx of [-1, 1]) {
      at(B.head, ellipsoid(V(sx * 0.083, hc.y, hc.z + 0.005), 0.015, 0.028, 0.02), skin); // ears
      at(B.head, ellipsoid(V(sx * 0.032, hc.y + 0.02, hc.z - 0.088), 0.012, 0.009, 0.006), 0x1b1410); // eyes
    }
    at(B.head, ellipsoid(V(0, hc.y - 0.048, hc.z - 0.088), 0.022, 0.005, 0.006), 0x8a4a3a); // mouth
  };
  if (o.head === 'helmet' || o.head === 'fullface' || o.head === 'bubble') {
    const big = o.head === 'bubble' ? 1.18 : 1;
    if (o.head !== 'bubble') at(B.head, ellipsoid(hc, 0.083, 0.105, 0.098), skin); // face under the visor
    // shell: a dome over the top, sides and back, with a raised ridge and a contrasting stripe
    const shell = ellipsoid(hc, 0.128 * big, 0.135 * big, 0.142 * big, { w: 20, h: 12, th: [0, o.head === 'fullface' ? Math.PI * 0.86 : Math.PI * 0.66] });
    at(B.head, shell, o.helmet, true);
    if (o.head !== 'bubble') at(B.head, ellipsoid(V(0, hc.y + 0.02, hc.z), 0.022, 0.14, 0.15, { th: [0, Math.PI * 0.55] }), o.helmet2, true);
    // the visor: a front patch over the eyes (bigger and gold on a spacesuit, down to the chin on a full-face)
    const vt = o.head === 'fullface' ? [0.36, 0.62] : o.head === 'bubble' ? [0.3, 0.72] : [0.33, 0.6];
    const vis = frontPatch(0.148 * big, o.head === 'bubble' ? 1.05 : 0.95, Math.PI * vt[0], Math.PI * vt[1], 18, 6); vis.translate(hc.x, hc.y, hc.z);
    at(B.head, vis, o.visor, true);
    if (o.head === 'fullface') { // chin bar under the visor
      const chin = frontPatch(0.142, 1.0, Math.PI * 0.62, Math.PI * 0.84, 16, 4); chin.translate(hc.x, hc.y, hc.z); at(B.head, chin, o.helmet, true);
    }
    if (o.mask) { // oxygen mask over nose and mouth, with the hose down to the chest
      at(B.head, ellipsoid(V(0, hc.y - 0.045, hc.z - 0.11), 0.05, 0.055, 0.045), 0x4c5047);
      at(B.head, capAB(V(0.02, hc.y - 0.08, hc.z - 0.12), V(0.06, hc.y - 0.17, hc.z - 0.1), 0.014, 0.014, { seg: 6 }), 0x2a2c2e);
      for (const sx of [-1, 1]) at(B.head, ellipsoid(V(sx * 0.1, hc.y - 0.02, hc.z - 0.04), 0.012, 0.012, 0.03), 0x9aa0a6); // bayonet fittings
    }
    if (o.peak) { const pk = ellipsoid(V(0, hc.y + 0.095, hc.z - 0.12), 0.1, 0.014, 0.09, { w: 14, h: 5 }); pk.rotateX(-0.12); at(B.head, pk, o.helmet2, true); } // motocross peak
    if (o.mic) at(B.head, capAB(V(0.11, hc.y - 0.02, hc.z - 0.02), V(0.035, hc.y - 0.055, hc.z - 0.11), 0.008, 0.011, { seg: 5 }), 0x15161a);
    if (o.ring) at(B.head, torusAB(0.16, 0.022, Math.PI * 2, 24).rotateX(Math.PI / 2).translate(0, 0.02, 0), o.trim, true); // suit neck ring
  } else if (o.head === 'headset') {
    face();
    at(B.head, ellipsoid(V(0, hc.y + 0.025, hc.z + 0.012), 0.09, 0.09, 0.1, { th: [0, Math.PI * 0.5] }), hair); // hair
    at(B.head, ellipsoid(V(0, hc.y - 0.0, hc.z + 0.03), 0.088, 0.08, 0.08, { th: [Math.PI * 0.3, Math.PI * 0.4], phi: [0, Math.PI] }), hair);
    at(B.head, torusAB(0.098, 0.009, Math.PI, 16).translate(0, hc.y + 0.005, hc.z + 0.01), o.cups); // headband over the top
    for (const sx of [-1, 1]) { const cup = new THREE.CylinderGeometry(0.038, 0.04, 0.03, 12); cup.rotateZ(Math.PI / 2); cup.translate(sx * 0.098, hc.y, hc.z + 0.01); at(B.head, cup, o.cups, true); }
    at(B.head, capAB(V(-0.1, hc.y - 0.02, hc.z - 0.01), V(-0.03, hc.y - 0.05, hc.z - 0.1), 0.006, 0.008, { seg: 5 }), 0x15161a); // boom mic
    if (o.glasses) { const gl = frontPatch(0.1, 0.62, Math.PI * 0.4, Math.PI * 0.48, 12, 2); gl.translate(hc.x, hc.y, hc.z); at(B.head, gl, 0x0e1114, true); }
  } else if (o.head === 'leather') {
    face();
    at(B.head, ellipsoid(hc, 0.092, 0.112, 0.105, { w: 18, h: 10, th: [0, Math.PI * 0.62] }), 0x5a3a22); // leather cap over the ears
    for (const sx of [-1, 1]) {
      at(B.head, ellipsoid(V(sx * 0.088, hc.y - 0.01, hc.z + 0.01), 0.022, 0.045, 0.035), 0x4a2f1b);
      // goggles pushed up on the forehead
      const ring = torusAB(0.026, 0.008, Math.PI * 2, 14); ring.rotateX(-0.6); ring.translate(sx * 0.035, hc.y + 0.075, hc.z - 0.075); at(B.head, ring, 0x9aa0a6, true);
      at(B.head, ellipsoid(V(sx * 0.035, hc.y + 0.075, hc.z - 0.079), 0.022, 0.022, 0.006), 0x6f8fa0, true);
    }
    at(B.head, capAB(V(-0.06, hc.y + 0.08, hc.z - 0.05), V(0.06, hc.y + 0.08, hc.z - 0.05), 0.008, 0.008, { seg: 5 }), 0x3a2618);
    // (white scarf below, on the neck)
  }
  // ---- controls ----
  const C = rig.C, blk = 0x15161a, metal = 0x6b7077;
  if (rig.ctl === 'stick' || rig.ctl === 'cyclic') {
    at(B.ctlA, capsule(0.06, 0.05, 0.035, { seg: 10 }).translate(0, -0.02, 0), blk); // rubber boot
    at(B.ctlA, capsule(C.stickLen - 0.06, 0.013, 0.013, { seg: 6 }), metal, true);
    at(B.ctlA, capsule(0.1, 0.022, 0.026, { seg: 8 }).translate(0, C.stickLen - 0.06, 0), blk); // grip
    at(B.ctlA, ellipsoid(V(0, C.stickLen + 0.04, -0.012), 0.008, 0.008, 0.008), 0xc8102e, true); // trigger / button
    if (rig.ctl === 'stick') {
      at(B.hips, boxG(0.1, 0.06, 0.34, V(C.thrBase.x, C.thrBase.y - 0.02, C.thrBase.z - 0.02)), 0x2b2d31); // throttle quadrant
      at(B.ctlB, capsule(C.thrLen, 0.01, 0.01, { seg: 6 }), metal, true);
      at(B.ctlB, ellipsoid(V(0, C.thrLen, 0), 0.026, 0.03, 0.04), blk);
    } else {
      at(B.ctlB, capsule(C.collLen, 0.016, 0.016, { seg: 6 }), metal, true);
      at(B.ctlB, capsule(0.12, 0.024, 0.024, { seg: 8 }).translate(0, C.collLen - 0.1, 0), blk);
    }
  } else if (rig.ctl === 'yoke') {
    at(B.ctlA, capsule(C.colLen, 0.035, 0.03, { seg: 8 }), 0x3a3d42);
    // yoke: a "ram's horn" bar with two grips, in the plane facing the pilot (local XY of ctlB after the tilt)
    const bar = capAB(V(-C.yokeR, 0.0, 0), V(C.yokeR, 0.0, 0), 0.018, 0.018, { seg: 6 }); at(B.ctlB, bar, blk);
    for (const sx of [-1, 1]) at(B.ctlB, capAB(V(sx * C.yokeR, -0.02, 0), V(sx * C.yokeR * 1.05, 0.08, 0), 0.022, 0.022, { seg: 8 }), blk);
    at(B.ctlB, boxG(0.08, 0.05, 0.04, V(0, 0.0, 0.01)), 0x3a3d42);
  } else if (rig.ctl === 'wheel') {
    const rim = torusAB(C.wheelR, 0.017, Math.PI * 2, 28); at(B.ctlA, rim, blk);
    for (const a of [Math.PI / 2, Math.PI * 1.18, Math.PI * 1.82]) at(B.ctlA, capAB(V(0, 0, 0), V(Math.cos(a) * C.wheelR, Math.sin(a) * C.wheelR, 0), 0.012, 0.012, { seg: 6 }), 0x8a8f96, true);
    at(B.ctlA, new THREE.CylinderGeometry(0.045, 0.05, 0.04, 14).rotateX(Math.PI / 2), 0x2b2d31);
    at(B.ctlA, ellipsoid(V(0, C.wheelR, 0.0), 0.02, 0.012, 0.02), 0xe8601c); // top-centre marker
    at(B.ctlA, capAB(V(0, 0, -0.02), V(0, 0, -0.42), 0.025, 0.03, { seg: 8 }), 0x2b2d31); // column, forward into the dash
  }
  // pedals
  if (rig.ctl !== 'bars') for (const i of [B.pedR, B.pedL]) {
    at(i, boxG(0.085, 0.16, 0.018, V(0, 0.07, 0)), rig.ctl === 'wheel' && i === B.pedR ? 0x9aa0a6 : 0x2b2d31);
    at(i, capAB(V(0, 0.0, 0.02), V(0, 0.14, 0.1), 0.01, 0.01, { seg: 5 }), 0x2b2d31);
  }
  return k.build();
}

// Where the figure looks from (rig space, rest pose, head straight): just behind the eyes on the head bone.
function eyePoint(rig) {
  const r = new Rig(rig.kind, rig.ctl, rig.o, rig.seed, { pegs: rig.pegs, groundY: rig.groundY }); // (posed at rest)
  const k = rig.o.head === 'bubble' ? 1.18 : 1;
  return V(0, 0.155, -0.075 * k).applyQuaternion(r.q[B.head]).add(r.p[B.head]);
}

const geoCache = new Map();
// outfit: OUTFITS key or object; ctl: 'stick' | 'cyclic' | 'yoke' | 'wheel' | 'none'; seed picks skin/hair tones
export function buildCrew(outfitKey, ctl = 'stick', { seed = 0, colors = null, pegs = null, groundY } = {}) {
  const outfit = { ...(OUTFITS[outfitKey] || OUTFITS.light), ...(colors || {}) };
  const rig = new Rig(outfitKey, ctl, outfit, seed, { pegs, groundY });
  const key = outfitKey + '|' + ctl + '|' + (seed % 4) + '|' + JSON.stringify(colors || 0) + (pegs ? '|' + JSON.stringify(pegs.map((v) => v.toArray().map((x) => +x.toFixed(3)))) : '');
  if (!geoCache.has(key)) geoCache.set(key, figureGeometry(rig));
  const geos = geoCache.get(key), mats = crewMaterials();
  const root = new THREE.Group(); root.name = 'crew';
  const bones = []; for (let i = 0; i < NB; i++) { const b = new THREE.Bone(); b.position.copy(rig.p[i]); b.quaternion.copy(rig.q[i]); root.add(b); bones.push(b); }
  root.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(bones);
  for (const [k, g] of Object.entries(geos)) {
    if (!g) continue;
    const m = new THREE.SkinnedMesh(g, mats[k]); m.userData.near = true; m.userData.crew = true; m.userData.cosmetic = true; m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false; // a few hundred triangles; skinned bounds would otherwise need a refresh as the pose changes
    root.add(m); m.bind(skel, new THREE.Matrix4());
  }
  const smooth = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
  root.userData.crewRig = {
    rig, root,
    eye: eyePoint(rig), // rig space: between the eyes, head straight (cockpit view, stations.js)
    // where the eyes are now (rig space): a motorbike rider bends over the tank and leans into turns (stations.js)
    eyeNow(out = V()) { return out.set(0, 0.155, -0.075 * (outfit.head === 'bubble' ? 1.18 : 1)).applyQuaternion(rig.q[B.head]).add(rig.p[B.head]); },
    // first person: the head and torso (with whatever they wear) shrink to nothing so the camera in the head sees out;
    // hands, arms, legs and the controls stay
    firstPerson(on) { const k = on ? 1e-4 : 1; for (const i of [B.head, B.spine]) bones[i].scale.setScalar(k); },
    // c: { pitch, roll, yaw, throttle, steer } (stick back = +pitch, right = +roll and +yaw); returns true while still moving
    update(c, dt) {
      const k = Math.min(1, (dt || 0.016) * 12), s = smooth;
      const tgt = { pitch: clamp(c.pitch || 0, -1, 1), roll: clamp(c.roll || 0, -1, 1), yaw: clamp(c.yaw || 0, -1, 1), thr: clamp(c.throttle ?? 0.4, 0, 1), steer: clamp(c.steer || 0, -1.7, 1.7) };
      tgt.look = clamp(-(tgt.roll * 0.35 + tgt.yaw * 0.25) + tgt.steer * 0.25, -0.6, 0.6);
      if (rig.ctl === 'bars') { tgt.lean = clamp(c.lean || 0, -0.6, 0.6); tgt.tuck = clamp(c.tuck || 0, 0, 1); tgt.foot = clamp(c.foot || 0, 0, 1); tgt.bikeLean = clamp(c.bikeLean || 0, -1, 1); s.hands = c.hands || null; }
      let moving = false;
      for (const a in tgt) { const kk = a === 'look' ? k * 0.35 : k; const v = s[a] + (tgt[a] - s[a]) * kk; if (Math.abs(v - tgt[a]) > 1e-3) moving = true; s[a] = v; }
      rig.pose(s);
      for (let i = 0; i < NB; i++) { bones[i].position.copy(rig.p[i]); bones[i].quaternion.copy(rig.q[i]); }
      return moving;
    },
  };
  return root;
}

// ---------- dressing a design's seats ----------
// Which crew a vehicle gets: from its parts (rotor = helicopter crew, drive engine = racing driver, rocket + RCS = an
// astronaut, jets = fighter pilot, radial = warbird pilot, airliner nose = airline crew, otherwise a light-plane pilot).
export function crewKind(design, cockpitId) {
  const ids = new Set(design.parts.map((p) => p.id)), has = (f) => design.parts.some((p) => f(PARTS[p.id] || {}, p.id));
  if (cockpitId === 'ck_airliner') return 'airline';
  if (has((d) => d.engine?.type === 'rotor')) return 'heli';
  if (has((d) => d.engine?.type === 'drive')) return 'driver';
  if (ids.has('x_rcs') && has((d) => d.engine?.type === 'rocket')) return 'space';
  if (has((d) => d.engine?.type === 'jet' || d.engine?.type === 'rocket')) return 'jet';
  if (ids.has('e_radial')) return 'warbird';
  if (design.livery === 'racer') return 'racer'; // air racer: helmet and race suit
  return 'light';
}
const CTL_OF = { airline: 'yoke', heli: 'cyclic', driver: 'wheel' };

// Add a figure to every declared seat (obj.userData.seats: [{ p: [x,y,z], s, ctl?, yaw? | quat?, role? }]).
// role 'crew' = a passenger / second crew member with no controls. Returns the rigs (also on obj.userData.crew).
export function addCrew(design, objs) {
  const rigs = [];
  design.parts.forEach((p, i) => {
    const obj = objs[i], seats = obj?.userData?.seats; if (!seats?.length) return;
    let kind = crewKind(design, p.id);
    const list = [];
    seats.forEach((st, k) => {
      let outfit = kind, ctl = st.ctl || CTL_OF[kind] || 'stick', colors = null, pegs = null, groundY;
      if (st.role === 'crew') { outfit = kind === 'heli' ? 'medic' : kind; ctl = 'none'; }
      if (kind === 'driver') colors = { helmet: p.color === 0x15161a || p.color == null ? 0xe8601c : 0xf2b705, helmet2: 0x15161a };
      if (ctl === 'bars') { // a rider in the bike's colours, feet on the frame's pegs (seat space -> rig space)
        outfit = st.rider || 'mx'; colors = { suit: p.color ?? OUTFITS[outfit].suit, helmet2: p.color ?? OUTFITS[outfit].helmet2 };
        const at = V(...st.p), sc = st.s || 1; pegs = (st.pegs || []).map((q) => V(...q).sub(at).divideScalar(sc)); if (pegs.length !== 2) pegs = null;
        if (st.ground != null) groundY = (st.ground - st.p[1]) / sc;
      }
      const c = buildCrew(outfit, ctl, { seed: i * 3 + k, colors, pegs, groundY });
      Object.assign(c.userData.crewRig, { role: st.role || 'pilot', kind, ctl, part: i, seat: k }); // (stations.js names the cockpit views from these)
      c.position.set(...st.p); if (st.quat) c.quaternion.fromArray(st.quat); else if (st.yaw) c.rotation.y = st.yaw; c.scale.setScalar(st.s || 1);
      obj.add(c); list.push(c.userData.crewRig);
    });
    obj.userData.crew = list; rigs.push(...list);
  });
  return rigs;
}
