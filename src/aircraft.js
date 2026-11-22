// Runtime aircraft: rigid-body flight model built from parts, ground contact, damage & break-up.
import * as THREE from 'three';
import { batchAircraft, syncBatch, unbatchAircraft } from './acBatch.js';
import { PARTS, partInfo } from './parts.js';
import { partMatrix, partScale, partMass, partHp, subtree, scaleSurface, thrustScale, linScale, partPower, partBurn, isRocketDesign, onRoadWheels } from './design.js';
import { M } from './materials.js';
import { clamp, lerp } from './noise.js';
import { keepHeatPatch } from './sonic.js';
import { assemble, updateDetail, mergeStatic } from './planeDetail.js';
import { groundUnder, groundAtPoint } from './collide.js';
import { detectBike, bikeSteer, bikeAssist } from './bike.js';
import { buildStations, showStation } from './stations.js';
import { detectBoat, boatFrame, boatForces, boatRecover, settleBoat, boatVisuals } from './boat.js';
import { driveMode } from './drive.js';
import { bakeCabinLight, keepCabinPatch } from './cabinLight.js';

// spaceRCS: every plane can turn in space (no RCS part needed). rocketHigh: rockets push up to 1 + rocketHigh times harder
// in the thin air above ~10 km (a generous shove towards space). Nothing changes lower down.
export const REALISM = {
  arcade: { id: 'arcade', name: 'Arcade', aeroTorque: 0, assist: 1, liftMult: 1.6, minArea: 12, stallSharp: 0, sideslipKill: 1.6, gearMult: 2.5, crashMult: 2.6, gLimit: Infinity, thrustTorque: 0, propTorque: 0, dragMult: 0.6, autoLevel: 0.9, waveMult: 0.45, spaceRCS: 1, rocketHigh: 0.5 },
  pilot: { id: 'pilot', name: 'Pilot', aeroTorque: 0.55, assist: 0.45, liftMult: 1.15, minArea: 0, stallSharp: 0.5, sideslipKill: 0.25, gearMult: 1.5, crashMult: 1.6, gLimit: 16, thrustTorque: 0.4, propTorque: 0, dragMult: 0.85, autoLevel: 0.15, waveMult: 0.75 },
  sim: { id: 'sim', name: 'Simulator', aeroTorque: 1, assist: 0, liftMult: 1, minArea: 0, stallSharp: 1, sideslipKill: 0, gearMult: 1, crashMult: 1, gLimit: 10, thrustTorque: 1, propTorque: 1, dragMult: 1, autoLevel: 0, waveMult: 1 },
};

const G = 9.81;
// flap deflection (rad) for each flap notch: up, 10°, 20°, full
export const FLAP_DEFL = [0, 0.18, 0.35, 0.6];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _rf = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3(), _rc = new THREE.Vector3(), _rd = new THREE.Vector3();
const _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rv = new THREE.Vector3(); // rocket attitude hold
// ---- the atmosphere, from the runway to space ----
// Air density (kg/m³): the old exponential (a near-perfect fit to the ISA troposphere) up to 11 km, then the
// US Standard Atmosphere 1976, interpolated log-linearly: 1/14 of sea level at 20 km, 1/1000 at 48 km, ~0 above 100 km.
const RHO_UP = [[11000, 1.225 * Math.exp(-11000 / 9000)], [20000, 0.08803], [32000, 0.01322], [47000, 0.00143], [51000, 0.00086], [71000, 6.42e-5],
  [86000, 6.96e-6], [100000, 5.6e-7], [120000, 2.22e-8], [150000, 2.08e-9], [200000, 2.54e-10], [300000, 1.92e-11]].map(([h, r]) => [h, Math.log(r)]);
export function airDensity(h) {
  if (!(h > 11000)) return 1.225 * Math.exp(-Math.max(0, h || 0) / 9000);
  const T = RHO_UP; let i = 1; while (i < T.length - 1 && h > T[i][0]) i++;
  const [h0, l0] = T[i - 1], [h1, l1] = T[i];
  return Math.exp(l0 + (l1 - l0) * (h - h0) / (h1 - h0)); // (extrapolates the last layer above 300 km)
}
// ISA air temperature (K): -6.5 °C per km up to the tropopause at 11 km, -56.5 °C to 20 km, warmer in the ozone layer
// (stratopause ~0 °C at 47-51 km), coldest at the mesopause (86 km, -86 °C). The hot, near-empty thermosphere above is left out.
const T_UP = [[11000, 216.65], [20000, 216.65], [32000, 228.65], [47000, 270.65], [51000, 270.65], [71000, 214.65], [86000, 186.95]];
export function airTemp(h) {
  if (!(h > 11000)) return 288.15 - 0.0065 * clamp(h || 0, 0, 11000);
  let i = 1; while (i < T_UP.length && h > T_UP[i][0]) i++;
  if (i >= T_UP.length) return T_UP[T_UP.length - 1][1];
  const [h0, t0] = T_UP[i - 1], [h1, t1] = T_UP[i];
  return t0 + (t1 - t0) * (h - h0) / (h1 - h0);
}
// speed of sound (m/s): 340 at sea level, 295 above 11 km
export const speedOfSound = (h) => 20.05 * Math.sqrt(airTemp(h));
// Gravity weakens with height (inverse square from the Earth's centre). The world is flat, so a fast plane also gets the
// lift a curved Earth would give it: horizontal speed bends the path round the planet, v²/r (enough to float at ~7.9 km/s).
export const EARTH_R = 6371000;
export const gravityAt = (h, vh2 = 0) => G * (EARTH_R / (EARTH_R + Math.max(0, h))) ** 2 - vh2 / (EARTH_R + Math.max(0, h));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// How much the air still does, 0..1: 1 everywhere below ~22 km; higher up, only while dynamic pressure is still useful
// (a hypersonic rocket's fins work for a while at 40 km; nothing works at 100 km). Scales the magic assists too.
export const airAuthority = (rho, q) => Math.max(smooth(0.015, 0.08, rho), smooth(40, 400, q));
// Extra parasite drag from shock waves, as a multiple of the normal drag (0 below Mach 0.8).
// It climbs steeply through the transonic band ("the sound barrier"), peaks just past Mach 1, then eases off,
// so punching through takes full power (or a dive) and it gets easier once you're supersonic.
export function waveDrag(M) {
  if (!(M > 0.8)) return 0;
  if (M < 1.02) { const t = (M - 0.8) / 0.22; return 1.2 * t * t * (3 - 2 * t); }
  return 1.2 * (0.35 + 0.65 * Math.exp(-(M - 1.02) * 2.5));
}

// Turbo-ramjet thrust (engine.ram) as a multiple of its low-speed thrust: ram air like a fighter's intakes up to Mach 2,
// then the inlet spike's shocks squeeze the air harder the faster it comes in, so the push is ~5x by Mach 3; past about
// Mach 3.3 the air arrives too hot to use and the thrust falls away (the top speed).
export const ramThrust = (M) => (1 + 0.9 * clamp((M - 0.8) / 1.2, 0, 1) + 3.2 * smooth(1, 3, M)) * (1 - smooth(3.1, 3.65, M));

// ---- shared impulse contact solver (world frame) ----
// body: { x (com world), v, wW (world ang vel), invMass, invIW (Matrix3 world) }
function applyImpulse(body, r, J) {
  body.v.addScaledVector(J, body.invMass);
  _v3.copy(r).cross(J).applyMatrix3(body.invIW); body.wW.add(_v3);
}
function pointVel(body, r, out) { return out.copy(body.wW).cross(r).add(body.v); }
function effMass(body, r, n) {
  const rn = _v3.copy(r).cross(n); const t = rn.clone().applyMatrix3(body.invIW);
  return body.invMass + t.cross(r).dot(n);
}
// returns impact speed (positive) or 0
export function contactPoint(body, pWorld, g, opts) {
  const pen = g.h - pWorld.y;
  if (pen <= 0) return null;
  const n = g.n, r = _v.copy(pWorld).sub(body.x);
  const vp = pointVel(body, r, _v2);
  const vn = vp.dot(n);
  const res = { pen, vn, vt: 0 };
  if (vn < 0) {
    const e = opts.e ?? 0.1;
    const j = (-(1 + e) * vn) / effMass(body, r, n);
    applyImpulse(body, r, n.clone().multiplyScalar(j));
    const vp2 = pointVel(body, r, new THREE.Vector3());
    const vt = vp2.sub(n.clone().multiplyScalar(vp2.dot(n)));
    const vtl = vt.length(); res.vt = vtl;
    if (vtl > 1e-4) {
      const t = vt.divideScalar(vtl);
      const jt = Math.min(opts.mu * j, vtl / effMass(body, r, t));
      applyImpulse(body, r, t.multiplyScalar(-jt));
    }
  } else {
    const vt = vp.clone().sub(n.clone().multiplyScalar(vn)); res.vt = vt.length();
  }
  return res;
}

// ---------------- Debris ----------------
export class Debris {
  constructor(objs, x, v, wW, mass, hullWorld, opts = {}) {
    this.group = new THREE.Group(); this.group.position.copy(x);
    for (const o of objs) { o.updateMatrixWorld(true); const m = o.matrixWorld.clone(); this.group.add(o); m.premultiply(new THREE.Matrix4().makeTranslation(-x.x, -x.y, -x.z)); m.decompose(o.position, o.quaternion, o.scale); }
    this.x = x.clone(); this.v = v.clone(); this.wW = wW.clone(); this.q = new THREE.Quaternion();
    this.mass = Math.max(5, mass); this.invMass = 1 / this.mass;
    this.hull = hullWorld.map((p) => p.clone().sub(x));
    let rr = 0.5; for (const p of this.hull) rr = Math.max(rr, p.length()); this.radius = rr;
    const I = this.mass * rr * rr * 0.25; this.invI = 1 / I; this.invIW = new THREE.Matrix3().set(this.invI, 0, 0, 0, this.invI, 0, 0, 0, this.invI);
    this.sleep = 0; this.burning = opts.burning || 0; this.smoking = opts.smoking || 0; this.age = 0; this.name = opts.name || '';
  }
  step(dt, env) {
    if (this.sleep > 2) return;
    this.age += dt;
    this.v.y -= G * dt;
    this.v.multiplyScalar(1 - 0.02 * dt); this.wW.multiplyScalar(1 - 0.3 * dt);
    this.x.addScaledVector(this.v, dt);
    _q.set(this.wW.x * dt * 0.5, this.wW.y * dt * 0.5, this.wW.z * dt * 0.5, 0).multiply(this.q);
    this.q.x += _q.x; this.q.y += _q.y; this.q.z += _q.z; this.q.w += _q.w; this.q.normalize();
    if (this.x.y - this.radius < env.maxGround(this.x.x, this.x.z) + 1) {
      let maxPen = 0; let touching = false; const p = new THREE.Vector3();
      for (const h of this.hull) {
        p.copy(h).applyQuaternion(this.q).add(this.x);
        const g = groundAtPoint(env, p); // (terrain, or a stunt ramp it is inside)
        const r = contactPoint(this, p, g, { e: 0.25, mu: g.type === 'water' ? 0.1 : 0.6 });
        if (r) { touching = true; maxPen = Math.max(maxPen, r.pen); if (r.vn < -6 && env.onDebrisHit) env.onDebrisHit(this, p, -r.vn, g); }
      }
      if (maxPen > 0) this.x.y += maxPen * 0.6;
      const g0 = env.groundAt(this.x.x, this.x.z);
      if (g0.type === 'water' && touching) { this.v.multiplyScalar(1 - 1.5 * dt); this.wW.multiplyScalar(1 - 2 * dt); this.x.y -= 0.15 * dt; }
      if (touching && this.v.lengthSq() < 0.15 && this.wW.lengthSq() < 0.1) this.sleep += dt; else this.sleep = 0;
    }
    this.group.position.copy(this.x); this.group.quaternion.copy(this.q);
  }
}

// ---------------- Aircraft ----------------
export class Aircraft {
  constructor(design, realism = REALISM.pilot) {
    this.design = design; this.R = realism;
    this.root = new THREE.Group();
    this.parts = [];
    this.events = [];
    this.flaps = 0; this.trim = 0; this.gearDown = true; this.gearT = 1; this.smokeOn = false; this.brake = 0;
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0 }; // rev/hand: a car's brake-then-reverse pedal and handbrake
    this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.w = new THREE.Vector3();
    this.wW = new THREE.Vector3(); this.invIW = new THREE.Matrix3();
    this.stats = { maxSpeed: 0, maxAlt: 0, maxG: 1, time: 0, airTime: 0, landings: 0, bestLanding: null, partsLost: 0, distance: 0 };
    // crash diagnostics for analytics (main.js flight_end / part_lost): what broke things, and signs the physics misbehaved.
    // this.cause is set just before a hit, a scrape, a hard landing, an over-G or a wall/tree/bird blow damages a part, so a
    // part that breaks off says why (the 'debris' event carries it)
    this.diag = { nanResets: 0, spinClamps: 0, deepPens: 0, maxPen: 0, recovers: 0, gearCollapses: 0 }; this.cause = null;
    this.g = 1; this.alpha = 0; this.stalled = false; this.onGround = false; this.wrecked = false; this.time = 0;
    this.landingLight = null;
    const m = new THREE.Matrix4();
    design.parts.forEach((p, i) => {
      const d = PARTS[p.id]; if (!d) return;
      const info = partInfo(p.id);
      const obj = d.build(p.color, { detail: 2 });
      partMatrix(p, m); m.decompose(obj.position, obj.quaternion, obj.scale);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = !o.material.transparent; o.receiveShadow = !o.material.transparent; } });
      this.root.add(obj);
      // m may carry scale (resized bodies): keep a pure rotation and the scaled bbox size for inertia/drag
      const rot = new THREE.Matrix4().makeRotationFromQuaternion(obj.quaternion), size = info.size.clone().multiply(new THREE.Vector3(...partScale(p)));
      const part = { i, p, d, obj, m: m.clone(), rot, size, alive: true, hp: partHp(p), dmg: 0, mass: partMass(p), info, scorched: false,
        center: info.centroid.clone().applyMatrix4(m), surfaces: [], engine: null, gear: null, hull: [], dragA: null, name: d.name };
      const ctrlObjs = obj.userData.controls || (obj.children[0]?.userData?.controls) || [];
      for (const s0 of info.surfaces) {
        const s = scaleSurface(s0, partScale(p));
        const sv = { pos: new THREE.Vector3(...s.pos).applyMatrix4(m), n: new THREE.Vector3(...s.n).transformDirection(m), f: new THREE.Vector3(...s.f).transformDirection(m),
          s: new THREE.Vector3(...s.s).transformDirection(m), area: s.area, ar: s.ar, role: s.role, chord: s.chord, cl0: (d.wing?.camber || 0) * 9,
          delta: 0, mix: { pitch: 0, roll: 0, yaw: 0 }, ctrlObj: null, load: 0, part };
        sv.isDelta = (d.wing?.ar || 9) < 2.6;
        part.surfaces.push(sv);
      }
      ctrlObjs.forEach((c) => { if (part.surfaces[c.strip]) part.surfaces[c.strip].ctrlObj = c.obj; });
      if (d.engine) {
        const e = d.engine, ts = thrustScale(p) * partPower(p);
        part.engine = { ...e, thrust: e.thrust * ts, ab: e.ab ? e.ab * ts : 0, pos: info.center.clone().applyMatrix4(m), dir: new THREE.Vector3(0, e.type === 'rotor' ? 1 : 0, e.type === 'rotor' ? 0 : -1).transformDirection(m), spool: 0, rpm: 0, thrustNow: 0,
          burn: partBurn(p), burning: false, prop: obj.userData.prop, fan: obj.userData.fan, flame: obj.userData.flame, flameCore: obj.userData.flameCore, spinDir: p.mirror ? -1 : 1, angle: 0, smokeT: 0 };
      }
      if (d.gear) {
        const gi = d.gear, ls = linScale(p); // ls: resized gear (wheel/strut sizes are in metres, the mesh is in part-local units)
        const wheels = [];
        if (gi.float) for (const dz of [-gi.flen * 0.32, gi.flen * 0.32, 0]) wheels.push({ top: new THREE.Vector3(0, 0, dz).applyMatrix4(m), dir: new THREE.Vector3(0, -1, 0).transformDirection(m), len: (gi.clen ?? 1.0) * ls, r: (gi.cr ?? 0.3) * ls, ls, steer: false, brake: false, float: true, comp: 0, contact: false });
        else wheels.push({ top: new THREE.Vector3(0, 0, 0).applyMatrix4(m), dir: new THREE.Vector3(0, -1, 0).transformDirection(m), len: gi.len * ls, r: gi.r * ls, ls, steer: gi.steer, brake: gi.brake, drive: !!gi.drive, comp: 0, contact: false, spin: 0, ...(gi.grip ? { grip: gi.grip } : {}) });
        part.gear = { ...gi, wheels, strut: obj.userData.strut, wheelObj: obj.userData.wheels };
      }
      if (d.smoke) part.smoke = { pos: new THREE.Vector3(0, 0, info.box.max.z).applyMatrix4(m), color: new THREE.Color(p.color) };
      if (d.light) {
        part.light = { type: d.light, pos: info.center.clone().applyMatrix4(m), bulb: obj.userData.bulb };
        if (d.light === 'nav' && part.light.bulb) {
          const x = part.light.pos.x; part.light.color = x < -0.5 ? 0xff2020 : x > 0.5 ? 0x20ff40 : 0xffffff;
          part.light.bulb.material.color.setHex(part.light.color).multiplyScalar(6);
        }
        if (d.light === 'landing' && !this.landingLight) {
          const sl = new THREE.SpotLight(0xfff2dd, 0, 450, 0.35, 0.5, 1.2); sl.position.copy(part.light.pos);
          const tgt = new THREE.Object3D(); tgt.position.copy(part.light.pos).add(new THREE.Vector3(0, -0.25, -1).transformDirection(m)); this.root.add(tgt); sl.target = tgt;
          this.root.add(sl); this.landingLight = sl; part.light.spot = sl;
        }
      }
      if (d.eye) part.eye = new THREE.Vector3(...d.eye).applyMatrix4(m);
      // hull points (excluding gear: wheels handle that)
      if (!d.gear) for (const h of info.hull) part.hull.push(h.clone().applyMatrix4(m));
      // body drag areas
      const sz = size;
      if (!d.wing) {
        const cd = d.cat === 'gear' ? [0.6, 0.6, 0.7] : d.cat === 'fuselage' || d.cat === 'cockpit' ? [0.5, 0.6, 0.06] : [0.5, 0.5, 0.18];
        const ax = sz.y * sz.z * 0.75, ay = sz.x * sz.z * 0.75, az = sz.x * sz.y * 0.785 * (d.frontal ?? 1); // frontal: the share of the box's front a part really shows the air (an open inlet swallows the rest)
        // rotate area box into body frame roughly (use abs of rotation matrix)
        const e = rot.elements;
        const A = [ax * cd[0], ay * cd[1], az * cd[2]];
        part.dragA = new THREE.Vector3(
          Math.abs(e[0]) * A[0] + Math.abs(e[4]) * A[1] + Math.abs(e[8]) * A[2],
          Math.abs(e[1]) * A[0] + Math.abs(e[5]) * A[1] + Math.abs(e[9]) * A[2],
          Math.abs(e[2]) * A[0] + Math.abs(e[6]) * A[1] + Math.abs(e[10]) * A[2]);
      }
      this.parts.push(part);
    });
    { const objs = []; for (const p of this.parts) objs[p.i] = p.obj; assemble(design, objs, this.root); mergeStatic(objs, this.root); try { this.cabin = bakeCabinLight(objs, this.root); } catch (e) { console.warn('cabinLight', e); } } // (then light into the cockpits and cabins only through their glass: cabinLight.js) // fillets, pylons, doors, skin furniture (visual only), then one mesh per material per part
    this.hasEngine = this.parts.some((p) => p.engine);
    this.hasRetract = this.parts.some((p) => p.gear?.retract);
    this.hasSmoke = this.parts.some((p) => p.smoke);
    this.hasAB = this.parts.some((p) => p.engine?.ab);
    this.isHeli = this.parts.some((p) => p.engine?.type === 'rotor');
    this.isCar = this.parts.some((p) => p.engine?.type === 'drive') || onRoadWheels(design); // (car/bike wheels and no wings: a land vehicle whatever drives it, design.js)
    this.driveF = 0; this.flipT = 0; this.svcBrake = 0; this.reversing = false; this.groundSpeed = 0;
    this.motorCount = this.parts.filter((p) => p.engine?.type === 'drive').length;
    // Rockets (any build with a rocket body) steer like rockets: see rocketControls(). A mixed build (rocket body + main
    // wings) blends between the rocket and plane schemes by rocketK (1 = rocket); a pure rocket is always 1.
    this.isRocket = isRocketDesign(design) && !this.isHeli && !this.isCar;
    this.rocketPure = this.isRocket && !this.parts.some((p) => p.d.cat === 'wing');
    this.rocketK = this.rocketPure ? 1 : 0; this.liftRatio = 0; this.viewQ = null; // viewQ: the camera's world rotation (main.js)
    this.ce = this.ctl;
    this.hasRCS = this.parts.some((p) => p.d.rcs || p.engine?.type === 'rocket'); // little gas jets (or the rockets' own) turn you in space
    this.rho = airDensity(0); this.airFx = 1; this.rcsFire = 0;
    this.updateMass(true);
    this.initialMass = this.mass;
    this.steerGeometry();
    this.bike = this.isCar ? detectBike(this) : null; this.isBike = !!this.bike; // two in-line wheels on the centreline: bike.js balances it
    this.boat = detectBoat(this); this.isBoat = !!this.boat; // a boat hull: boat.js floats and drives it
    this.D = this.isCar && !this.isBike ? driveMode(realism) : null; // a car's driving mode (drive.js): Easy, Racer or Pro
    let r = 1; for (const p of this.parts) for (const h of p.hull) r = Math.max(r, h.distanceTo(this.com)); for (const p of this.parts) if (p.gear) r = Math.max(r, p.gear.wheels[0].top.distanceTo(this.com) + p.gear.wheels[0].len + 0.5);
    this.radius = r;
  }

  alive() { return this.parts.filter((p) => p.alive); }

  updateMass(initial = false) {
    const oldCom = this.com ? this.com.clone() : null;
    let mass = 0; const com = new THREE.Vector3();
    for (const p of this.parts) if (p.alive) { mass += p.mass; com.addScaledVector(p.center, p.mass); }
    if (mass <= 0) { this.mass = 1; this.com = com; return; }
    com.divideScalar(mass);
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of this.parts) {
      if (!p.alive) continue;
      const s = p.size, mm = p.mass;
      // local box inertia, rotated approximately with abs rotation
      const ix = (mm / 12) * (s.y * s.y + s.z * s.z), iy = (mm / 12) * (s.x * s.x + s.z * s.z), iz = (mm / 12) * (s.x * s.x + s.y * s.y);
      const e = p.rot.elements;
      const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
      const loc = [ix, iy, iz];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { let sum = 0; for (let k = 0; k < 3; k++) sum += R[a * 3 + k] * loc[k] * R[b * 3 + k]; I[a * 3 + b] += sum; }
      const r = p.center.clone().sub(com), r2 = r.lengthSq(), ra = [r.x, r.y, r.z];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[a * 3 + b] += mm * ((a === b ? r2 : 0) - ra[a] * ra[b]);
    }
    // keep it well-conditioned
    const minI = mass * 0.3; for (let a = 0; a < 3; a++) I[a * 4] = Math.max(I[a * 4], minI);
    this.I = new THREE.Matrix3().set(...I);
    this.Iinv = this.I.clone().invert();
    this.mass = mass; this.com = com;
    if (!initial && oldCom) { // keep world positions consistent: CoM moved within the body
      const d = com.clone().sub(oldCom).applyQuaternion(this.q);
      this.x.add(d); this.v.add(this.wW.clone().cross(d));
    }
    // control mixing
    const maxs = { pitch: 1e-6, roll: 1e-6, yaw: 1e-6 };
    let hArea = 0;
    for (const p of this.parts) for (const s of p.surfaces) {
      if (!p.alive) continue;
      hArea += s.area * Math.abs(s.n.y);
      const r = s.pos.clone().sub(com), t = r.cross(s.n), tn = t.length();
      if (tn < 0.05 || s.role === 'fixed' || s.role === 'flap') { s.mix = { pitch: 0, roll: 0, yaw: 0 }; continue; }
      t.divideScalar(tn);
      s.mix = { pitch: t.x, yaw: -t.y, roll: -t.z };
      for (const k in maxs) maxs[k] = Math.max(maxs[k], Math.abs(s.mix[k]));
    }
    for (const p of this.parts) for (const s of p.surfaces) for (const k in maxs) { s.mix[k] /= maxs[k]; if (Math.abs(s.mix[k]) < 0.12) s.mix[k] = 0; }
    this.hArea = hArea;
    this.ctrlAuthority = { pitch: maxs.pitch > 0.01, roll: maxs.roll > 0.01, yaw: maxs.yaw > 0.01 };
  }

  // Place on ground (or in the air) at world pos with heading (rad, 0 = -Z)
  spawn(env, pos, heading, { air = false, speed = 0, alt = 0, pitch = 0 } = {}) {
    this.q.setFromEuler(new THREE.Euler(pitch, heading, 0, 'YXZ'));
    this.w.set(0, 0, 0); this.wW.set(0, 0, 0);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q);
    this.v.copy(fwd).multiplyScalar(speed);
    if (air) { this.x.set(pos.x, alt, pos.z); this.gearDown = !this.hasRetract; this.gearT = this.gearDown ? 1 : 0; }
    else {
      let minY = Infinity;
      const pts = [];
      for (const p of this.parts) { for (const h of p.hull) pts.push(h); if (p.gear) for (const w of p.gear.wheels) pts.push(w.top.clone().addScaledVector(w.dir, w.len + w.r)); }
      for (const pt of pts) minY = Math.min(minY, pt.clone().sub(this.com).applyQuaternion(this.q).y);
      let gh = env.groundAt(pos.x, pos.z).h;
      const deck = env.surfRay?.(new THREE.Vector3(pos.x, gh + 40, pos.z), new THREE.Vector3(0, -1, 0), 40); if (deck) gh = gh + 40 - deck.t; // (on a built deck or ramp: on top of it)
      this.x.set(pos.x, gh - minY + 0.03, pos.z);
      this.gearDown = true; this.gearT = 1;
      if (this.isBoat) settleBoat(this, env); // afloat at its waterline (on land it stays where it was put)
    }
    this.syncVisual();
  }

  syncVisual() {
    this.root.quaternion.copy(this.q);
    this.root.position.copy(this.com).multiplyScalar(-1).applyQuaternion(this.q).add(this.x);
  }
  worldPoint(bodyPt, out = new THREE.Vector3()) { return out.copy(bodyPt).sub(this.com).applyQuaternion(this.q).add(this.x); }

  emit(type, data) { this.events.push({ type, ...data }); }

  setControls(c) { Object.assign(this.ctl, c); }
  toggleGear() { if (!this.hasRetract) return; if (this.onGround && this.gearDown) { this.emit('msg', { text: 'Can’t raise gear on the ground!' }); return; } this.gearDown = !this.gearDown; this.emit('gear', { down: this.gearDown }); }
  cycleFlaps() { this.flaps = (this.flaps + 1) % 4; this.emit('msg', { text: ['Flaps up', 'Flaps 10°', 'Flaps 20°', 'Flaps full'][this.flaps] }); }

  step(dtFrame, env) {
    if (this.dead) return;
    // more, smaller steps at very high dynamic pressure (hypersonic rockets) so the stiff aero torques stay stable
    const qd = 0.5 * airDensity(this.x.y) * this.v.lengthSq();
    const hz = 240 * clamp(Math.sqrt(qd / 150000), 1, 4);
    const n = Math.max(1, Math.ceil(dtFrame * hz));
    const dt = dtFrame / n;
    const v0 = this.v.clone(), x0 = this.x.clone(), q0 = this.q.clone();
    if (this.isRocket) this.rocketControls(dtFrame); else this.ce = this.ctl;
    if (this.isBoat) boatFrame(this, env, dtFrame);
    if (this.isCar) this.walls = env.walls ? env.walls(this.x.x, this.x.z, this.radius + this.v.length() * dtFrame + 2, this.walls || []) : null; // buildings nearby
    for (let i = 0; i < n; i++) this.substep(dt, env);
    if (!Number.isFinite(this.x.x + this.x.y + this.x.z + this.v.x + this.v.y + this.v.z + this.q.x + this.q.y + this.q.z + this.q.w + this.w.x + this.w.y + this.w.z)) {
      // numerical blow-up (absurd speeds): never let NaN reach the renderer (bloom turns it into a black frame)
      this.diag.nanResets++;
      this.x.copy(x0); this.v.copy(v0).multiplyScalar(0.9); this.q.copy(q0); this.w.set(0, 0, 0); this.wW.set(0, 0, 0);
    }
    if (this.isCar) this.carRecover(dtFrame);
    if (this.isBoat) boatRecover(this, dtFrame, env);
    if (dtFrame > 0) { const acc = this.v.clone().sub(v0).divideScalar(dtFrame); this.gSmooth = lerp(this.gSmooth ?? 1, (acc.dot(this.up) + G * this.up.y) / G, Math.min(1, dtFrame * 8)); this.g = this.gSmooth; }
    this.time += dtFrame; this.stats.time += dtFrame;
    this.updateVisuals(dtFrame, env);
  }

  // ---- car ----
  // Stick left/right steers (as well as the rudder). W / the GAS pedal goes, S / BRAKE brakes and then reverses.
  steerCmd() { return this.isCar ? clamp(this.ctl.yaw + this.ctl.roll, -1, 1) : this.ctl.yaw; }
  // Steering angle (rad, + = left) of the reference front wheel; steerAngle(w) gives one wheel its own angle.
  steerAngle(w = null) {
    if (!this.isCar) {
      // a steered tail wheel (behind the CoM) turns the opposite way to a nose wheel so the nose still goes where you push (#98)
      const tail = w && this.com && w.top.z > this.com.z ? -1 : 1;
      return -tail * this.ctl.yaw * 0.55 * clamp(1 - this.airspeed / 45, 0.15, 1);
    }
    if (this.isBike) return bikeSteer(this, w);
    // cars: full lock (~34°) at walking pace, less as you speed up so full lock asks for the driving mode's cornering g
    // (drive.js: Easy and Racer hold the car down so it can't tip; Pro stops at the car's own rollover limit, cornerG)
    const v = this.stuntUp ? this.v.length() : Math.hypot(this.v.x, this.v.z), L = this.wheelbase || 2.5; // (up a loop's side the speed is all vertical)
    // (on a banked ramp, bowl or loop the banking holds you in the turn too: more lock allowed)
    // (the anti-roll hand raises the car's own rollover limit, rollG, by 1 / (1 - antiRoll): Easy can't tip at all;
    // Pro asks for no more than 80 % of what tips it in a steady turn; a swerve, a kerb or a wobbly build can still roll it)
    const D = this.D, turn = D ? (D.antiRoll >= 1 ? D.turnG * G : Math.min(D.turnG * G, (this.rollG || 8) / (1 - D.antiRoll) * 0.8)) : this.cornerG || 6;
    const cg = turn + (this.stuntUp ? G * Math.tan(Math.min(1.3, Math.acos(clamp(this.stuntUp.y, -1, 1)))) : 0);
    const th = -this.steerCmd() * Math.min(0.6, Math.atan(L * cg / Math.max(1, v * v)));
    if (!w || w.L === undefined) return th;
    // Ackermann: every steered wheel points square to the radius from one turning centre beside the pivot axle, so the
    // inside wheel turns more than the outside one, and wheels behind the pivot (4-wheel steer) turn the other way
    const sn = Math.sin(th);
    return Math.atan((w.L * sn) / (L * Math.cos(th) + w.xo * sn));
  }
  // Where the car turns about: the middle of the fixed (unsteered) wheels, or of all of them for 4-wheel steer.
  steerGeometry() {
    if (!this.isCar) return;
    const ws = []; for (const p of this.parts) if (p.gear && !p.gear.float) ws.push(...p.gear.wheels);
    const fixed = ws.filter((w) => !w.steer), base = fixed.length ? fixed : ws;
    if (!ws.length) return;
    const zp = base.reduce((a, w) => a + w.top.z, 0) / base.length, xc = ws.reduce((a, w) => a + w.top.x, 0) / ws.length;
    let L = 0; for (const w of ws) if (w.steer) { w.L = zp - w.top.z; w.xo = w.top.x - xc; L = Math.max(L, Math.abs(w.L)); }
    if (L < 0.3) for (const w of ws) delete w.L; // one axle only: nothing to turn about, plain steering
    this.wheelbase = Math.max(0.6, L);
    // how hard it can corner before it tips: ~3/4 of the static rollover limit (half the track over the CoM height), so a
    // low buggy corners at 0.8 g and a tall monster truck at about half that
    const half = ws.reduce((a, w) => a + Math.abs(w.top.x - xc), 0) / ws.length;
    const h = this.com.y - ws.reduce((a, w) => a + w.top.y - w.len - w.r, 0) / ws.length;
    this.cornerG = clamp(0.75 * G * half / Math.max(0.3, h), 3, 8);
    this.rollG = G * half / Math.max(0.3, h); // the static rollover limit (m/s²), unclamped: drive.js modes steer below it
  }
  // Easy and Racer (drive.js): the yaw helper turns the car at the rate its steering asks for, so it turns in crisply
  // and never spins out. With the handbrake on, Racer lets it rotate further into a drift and holds the slide below
  // driftMax (body slip angle); let go and the helper straightens it out.
  carAssist(T) {
    const D = this.D; if (!D.yawHelp) return;
    let wheels = 0; for (const p of this.parts) if (p.alive && p.gear) for (const w of p.gear.wheels) if (w.contact) wheels++;
    if (wheels < 2) return;
    const vg = this.groundSpeed, L = this.wheelbase || 2.5, vB = _rv.copy(this.v).applyQuaternion(_qi.copy(this.q).invert());
    let want = (vg * Math.tan(this.steerAngle())) / L; // + = left
    const beta = Math.atan2(vB.x, Math.max(1, Math.abs(vB.z))) * Math.sign(vg || 1); // + = nose left of where it is going
    let k = 6 * D.yawHelp;
    if (this.ctl.hand > 0 && D.drift > 0 && Math.abs(vg) > 5) { want *= 1.8; k *= 0.35; } // drifting: rotate more, hold less
    let acc = clamp(want - this.w.y, -3, 3) * k;
    const over = Math.abs(beta) - D.driftMax; // sliding further than the mode allows: catch it (and stop the spin)
    if (over > 0 && D.driftMax > 0 && Math.abs(vg) > 3) acc += -Math.sign(beta) * Math.min(1, over * 5) * (12 + 4 * Math.max(0, Math.sign(beta) * this.w.y));
    T.add(_rv.set(0, acc, 0).applyMatrix3(this.I)); // (through the whole inertia: a lopsided build's products of inertia would turn a bare yaw torque into a roll)
  }
  // Arcade and Pilot: a car stuck on its roof or side for 2 s is set back on its wheels.
  // A bike lying on its side is picked up in every mode, after 1.5 s.
  carRecover(dt) {
    const bike = this.isBike, stuck = (this.R.assist > 0 || bike) && this.onGround && this.up.y < (bike ? 0.5 : 0.3) && this.v.length() < (bike ? 3 : 2) && !this.stuntUp; // (on its wheels up a steep ramp is not stuck)
    this.flipT = stuck ? this.flipT + dt : 0;
    if (this.flipT < (bike ? 1.5 : 2)) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q); fwd.y = 0;
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-fwd.x, -fwd.z));
    this.x.y += 1.5; this.v.set(0, 0, 0); this.w.set(0, 0, 0); this.wW.set(0, 0, 0); this.flipT = 0; this.diag.recovers++;
    this.emit('msg', { text: 'Back on your wheels!' });
  }

  // ---- rocket ----
  // The stick moves the nose across the SCREEN: left/right swings it left/right, back/forward tips it up/down, whatever
  // way up the rocket is and wherever the camera is (a rocket standing on its tail has no "wings level" to bank from,
  // so plane-style roll-to-turn makes no sense from the chase camera). The rudder (Q/E, the touch slider) rolls.
  // Writes this.ce, the body-axis commands the surfaces and assists use, blended with the plane scheme by rocketK.
  rocketControls(dt) {
    const c = this.ctl, fwd = _rf.set(0, 0, -1).applyQuaternion(this.q);
    let want = 1;
    if (!this.rocketPure) { // rocket plane: rocket-style when the nose is high or the rockets burn with the wings not yet carrying it
      if (this.onGround) want = fwd.y > 0.6 ? 1 : 0;
      else {
        this.liftS = (this.liftS ?? 1) + (Math.abs(this.liftRatio) - (this.liftS ?? 1)) * Math.min(1, dt / 0.6); // (lift jumps about in rolls and pushes)
        want = Math.max(smooth(0.5, 0.8, fwd.y), this.rocketBurn ? 1 - smooth(0.55, 0.9, this.liftS) : 0);
      }
    }
    this.rocketK += (want - this.rocketK) * Math.min(1, dt / 0.5);
    if (!this.rocketPure && Math.abs(want - (this.rocketMode ? 1 : 0)) > 0.7) { this.rocketMode = want > 0.5; this.emit('msg', { text: this.rocketMode ? 'Rocket steering: stick points the nose' : 'Plane steering: stick banks' }); }
    if (this.ce === this.ctl) this.ce = {};
    const ce = Object.assign(this.ce, c), k = this.rocketK;
    if (k < 0.002) return;
    const vq = this.viewQ || this.q;
    const camR = _ra.set(1, 0, 0).applyQuaternion(vq), camU = _rb.set(0, 1, 0).applyQuaternion(vq);
    // screen-right and screen-up, each made square to the nose (two estimates of "right" summed so neither degenerates)
    const a = _rc.copy(camR).addScaledVector(fwd, -fwd.dot(camR)).add(_rd.copy(fwd).cross(camU));
    if (a.lengthSq() < 0.04) a.copy(camR).addScaledVector(fwd, -fwd.dot(camR));
    if (a.lengthSq() < 1e-4) a.set(1, 0, 0).applyQuaternion(this.q);
    a.normalize();
    const b = _rd.copy(a).cross(fwd);
    const d = a.multiplyScalar(c.roll).addScaledVector(b, c.pitch);
    const w = _rb.copy(fwd).cross(d).applyQuaternion(_qi.copy(this.q).invert()); // turn rate wanted, in the body frame
    if (w.lengthSq() > 1) w.normalize();
    ce.pitch = lerp(c.pitch, w.x, k); ce.yaw = lerp(c.yaw, -w.y, k); ce.roll = lerp(c.roll, c.yaw, k);
    this.rocketHoldTarget(ce, k);
  }
  // Arcade/Pilot attitude hold. While the stick is held the target attitude rides just ahead of the nose, at the point a
  // plain rate damper would stop it (now + spin / damper gain); let go and the target stays put, and rocketAssist()
  // steers the nose onto it. Before this the assist only damped the spin, so once the fins had airflow they weathervaned
  // the nose back towards the old flight path ("snaps back to the middle" in Pilot). Dropped (it follows the nose) on
  // the ground, without authority (no burn, no air), in Sim, and while a rocket plane flies plane-style.
  rocketHoldTarget(ce, k) {
    const hq = this.rocketHold || (this.rocketHold = this.q.clone());
    const stick = Math.max(Math.abs(ce.pitch), Math.abs(ce.yaw), Math.abs(ce.roll)) > 0.04;
    if (this.R.assist <= 0 || this.onGround || k < 0.5 || (this.rocketAuth ?? 0) < 0.05) { hq.copy(this.q); this.rocketHolding = false; return; }
    if (stick || !this.rocketHolding) {
      const lead = _rv.copy(this.w).divideScalar(this.rocketGain || 6), a = lead.length(); // where the spin would die out
      hq.copy(this.q); if (a > 1e-6) hq.multiply(_rq.setFromAxisAngle(lead.divideScalar(a), Math.min(a, 0.35)));
      this.rocketHolding = !stick;
    }
  }

  // Arcade/Pilot: the stick sets the turn rate (let go and it holds its heading, and the roll stops), worked by the swivelling
  // engines while they burn and by the fins once there's airflow. Sim: just the engines' swivel (a few degrees), no help.
  rocketAssist(F, T, ctl, V, air, vAirB, Taero) {
    const R = this.R, k = this.rocketK, sf = clamp((V - 6) / 22, 0, 1) * air;
    if (R.assist > 0) {
      const auth = Math.max(sf, this.rocketBurn ? 1 : 0) * k, rate = 0.45 + 0.25 * R.assist; // rad/s at full stick
      const gain = (this.rocketGain = 6 * (0.5 + 0.5 * R.assist)); this.rocketAuth = auth;
      const des = _v3.set(ctl.pitch * rate, -ctl.yaw * rate, -ctl.roll * 1.6);
      if (this.rocketHolding) { // stick centred: turn towards the held attitude (body-frame error, critically damped)
        const e = _rq2.copy(this.q).invert().multiply(this.rocketHold), s = (e.w < 0 ? -2 : 2) * gain * 0.25;
        des.set(e.x * s, e.y * s, e.z * s);
      }
      const err = des.sub(this.w).multiplyScalar(gain * auth);
      T.add(err.applyMatrix3(this.I));
      // the swivelling engines and fins' autopilot also take out the fins' pull towards the airflow (Pilot feels its
      // aero torque, Arcade none), so the nose goes where the stick points and stays there instead of weathervaning back
      T.addScaledVector(Taero, -R.aeroTorque * auth);
      if (R.sideslipKill > 0) { const kill = this.mass * R.sideslipKill * sf * k * 0.6; F.x -= vAirB.x * kill; F.y -= vAirB.y * kill; } // flies like a dart, the same in every direction
    } else if (this.rocketBurn) {
      let tv = 0; for (const p of this.parts) if (p.alive && p.engine?.type === 'rocket') tv += p.engine.thrustNow * Math.max(1, Math.abs(p.engine.pos.z - this.com.z)) * 0.09;
      T.x += ctl.pitch * tv * k; T.y -= ctl.yaw * tv * k; T.z -= ctl.roll * Math.min(tv * 0.2, this.I.elements[8] * 1.2) * k; // (a slim rocket spins up easily: gentle roll)
    }
  }

  // ---- helicopter ----
  // Main rotors push along their mast. Throttle is the collective: in Arcade and Pilot it sets the climb rate
  // (middle = hover, the rotor works out the lift); in Sim it is raw lift. The stick tilts the rotor disc (cyclic).
  // Each spinning rotor twists the body the other way; a working tail rotor cancels that.
  rotors(dt, rho, ctl, F, T, q, qi) {
    const R = this.R, mass = this.mass, run = ctl.throttle > 0.02 || !this.onGround ? 1 : 0;
    let maxT = 0;
    const mains = [], tails = [];
    for (const p of this.parts) {
      const e = p.engine; if (!e || !p.alive) continue;
      if (e.type === 'tailrotor') { tails.push(p); continue; }
      if (e.type !== 'rotor') continue;
      e.spoolT = (e.spoolT || 0) + (run - (e.spoolT || 0)) * Math.min(1, dt / e.spool);
      e.health = (1 - clamp(p.dmg / p.hp, 0, 1) * 0.7) * (p.dmg > p.hp * 0.75 ? 0.3 : 1);
      maxT += e.thrust * e.spoolT * e.health * (rho / 1.225); mains.push(p);
    }
    const upY = _v2.set(0, 1, 0).applyQuaternion(q).y;
    let total;
    if (R.assist > 0) {
      const vd = (ctl.throttle - 0.5) * 2 * 7; // m/s: full = climb 7, zero = sink 7
      total = ctl.throttle < 0.02 && this.onGround ? 0 : mass * (G + 1.6 * (vd - this.v.y)) / Math.max(0.5, upY);
    } else total = maxT * ctl.throttle;
    total = clamp(total, 0, maxT);
    this.collective = maxT > 0 ? total / maxT : 0;
    let twist = 0;
    const Fs = new THREE.Vector3(), r = new THREE.Vector3();
    for (const p of mains) {
      const e = p.engine, share = maxT > 0 ? e.thrust * e.spoolT * e.health * (rho / 1.225) / maxT : 0, thrust = total * share;
      e.thrustNow = thrust;
      e.rpm = lerp(e.idleRpm, e.maxRpm, e.spoolT * (0.75 + 0.25 * this.collective));
      Fs.copy(e.dir); Fs.z += ctl.pitch * 0.1; Fs.x += ctl.roll * 0.1; Fs.normalize().multiplyScalar(thrust); // cyclic
      F.add(Fs);
      r.copy(e.pos).sub(this.com);
      T.addScaledVector(_v3.copy(r).cross(Fs), R.thrustTorque);
      twist += thrust * 0.05 * e.spinDir;
      T.addScaledVector(e.dir, -thrust * 0.05 * e.spinDir);
    }
    const spool = mains.reduce((a, p) => Math.max(a, p.engine.spoolT), 0);
    for (const p of tails) { const e = p.engine; e.spoolT = spool; e.rpm = lerp(e.idleRpm, e.maxRpm, spool); }
    this.tailOK = tails.length > 0 && spool > 0.3;
    if (this.tailOK) T.y += twist * mains.reduce((a, p) => a + Math.abs(p.engine.dir.y), 0) / Math.max(1, mains.length); // anti-torque
  }
  heliAssist(F, T, ctl, q, qi, fwdSpeed) {
    const a = this.R.assist;
    const fwd = _v2.set(0, 0, -1).applyQuaternion(q), pitch = Math.asin(clamp(fwd.y, -1, 1));
    const right = _v3.set(1, 0, 0).applyQuaternion(q), bank = Math.asin(clamp(right.y, -1, 1));
    // Arcade/Pilot: the stick sets the attitude (let go = level hover). Sim: only the rotor's natural damping.
    const kp = 7 * a, kd = 4 * a + 1.2;
    const err = new THREE.Vector3(kp * (ctl.pitch * 0.35 - pitch) - kd * this.w.x, 0, kp * (-ctl.roll * 0.4 - bank) - kd * this.w.z);
    // tail rotor = rudder (yaw rate); in Arcade the stick also turns you when moving forward
    if (this.tailOK) err.y = 4 * (-ctl.yaw * 1.2 - (a > 0 ? ctl.roll * clamp(fwdSpeed / 15, 0, 1) * 0.8 * a : 0) - this.w.y);
    T.add(err.applyMatrix3(this.I));
    // Arcade: let go of the stick and it stops drifting
    if (a > 0 && Math.abs(ctl.pitch) < 0.1 && Math.abs(ctl.roll) < 0.1 && !this.onGround) {
      F.add(_v2.set(-this.v.x, 0, -this.v.z).multiplyScalar(this.mass * 0.8 * a).applyQuaternion(qi));
    }
  }

  // The air's forces on the airframe at one instant: every lifting strip (lift, drag, stall, control and flap
  // deflection) and every body's drag, in the body frame, added to F; their moments about the CoM added to Taero. Uses
  // this.w (rotation adds airflow at the tips and tail), this.com, this.R. The flight (substep) and the wind tunnel
  // (windTunnel.js, through aeroAt) both call this, so the tunnel shows exactly the forces the plane flies with.
  // probe (tunnel only): an array that gets one entry per lifting strip.
  aeroLoads(vAirB, V, rho, mach, ctl, pitchCmd, flapDefl, F, Taero, probe = null) {
    const R = this.R;
    const wave = 1 + waveDrag(mach) * (R.waveMult ?? 1);
    // control surfaces can't swing fully against a supersonic airstream (also keeps Mach 4 rockets flyable)
    const maxDefl = 0.38 * Math.min(1, 60000 / Math.max(1, 0.5 * rho * V * V));
    let liftScale = R.liftMult;
    if (R.minArea && this.hArea < R.minArea) liftScale *= Math.min(8, R.minArea / Math.max(0.6, this.hArea));
    let maxAlpha = 0, totalLift = 0;
    const r = new THREE.Vector3(), vp = new THREE.Vector3(), Fs = new THREE.Vector3(), ld = new THREE.Vector3();
    // ---- lifting surfaces ----
    for (const p of this.parts) {
      if (!p.alive) continue;
      let partLift = 0;
      for (const s of p.surfaces) {
        const dCtl = clamp(pitchCmd * s.mix.pitch + ctl.roll * s.mix.roll + ctl.yaw * s.mix.yaw, -1, 1) * maxDefl;
        const dFlap = s.role === 'flap' && p.d.wing?.flaps ? flapDefl : 0;
        s.delta = dCtl + dFlap;
        r.copy(s.pos).sub(this.com);
        vp.copy(this.w).cross(r).add(vAirB);
        vp.addScaledVector(s.s, -vp.dot(s.s));
        const V2 = vp.lengthSq(); if (V2 < 0.5) { s.load = 0; if (probe) probe.push({ s, a: 0, aEff: 0, stalled: false, L: 0, cl: 0, cd: 0, Vs: 0, F: new THREE.Vector3() }); continue; }
        const Vs = Math.sqrt(V2);
        const along = vp.dot(s.f), nrm = vp.dot(s.n);
        const a = Math.atan2(-nrm, along);
        const aa = Math.abs(a);
        const a0 = s.isDelta ? 0.5 : 0.27;
        const clA = (2 * Math.PI * s.ar) / (s.ar + 2);
        const aEff = a + (aa < 1.2 ? 0.55 * s.delta : 0);
        let cl;
        const aeAbs = Math.abs(aEff);
        if (aeAbs < a0) cl = clA * aEff + s.cl0 * Math.cos(a);
        else {
          const clMax = clA * a0 * Math.sign(aEff) + s.cl0 * 0.5;
          const fp = 1.1 * Math.sin(2 * aEff);
          const t = clamp((aeAbs - a0) / 0.35, 0, 1);
          const post = clMax * (1 - 0.4 * R.stallSharp);
          cl = R.stallSharp > 0 ? lerp(lerp(clMax, post, Math.min(1, (aeAbs - a0) * 20)), fp, t * R.stallSharp) : (aeAbs > Math.PI / 2 ? fp : clMax);
        }
        let cd = 0.012 * wave + (cl * cl) / (Math.PI * 0.8 * s.ar) + 1.2 * Math.sin(a) ** 2 * (aeAbs > a0 ? 1 : 0.3) + Math.abs(dFlap) * 0.08;
        const qd = 0.5 * rho * V2 * s.area;
        const vh = _v2.copy(vp).divideScalar(Vs);
        ld.copy(s.n).addScaledVector(vh, -s.n.dot(vh)).normalize();
        const L = qd * cl * liftScale;
        Fs.copy(ld).multiplyScalar(L).addScaledVector(vh, -qd * cd * R.dragMult);
        s.load = L; partLift += L;
        if (probe) probe.push({ s, a, aEff, stalled: aeAbs > a0, L, cl, cd, Vs, F: Fs.clone() });
        F.add(Fs); Taero.add(_v3.copy(r).cross(Fs));
        if (Math.abs(s.n.y) > 0.6 && s.role !== 'ctrl') maxAlpha = Math.max(maxAlpha, aeAbs * (Math.abs(a) < 1.5 ? 1 : 0));
        totalLift += L * Math.abs(s.n.y);
      }
      p.lift = partLift;
      // body drag
      if (p.dragA) {
        r.copy(p.center).sub(this.com);
        vp.copy(this.w).cross(r).add(vAirB);
        const k = -0.5 * rho * R.dragMult * wave;
        let A = p.dragA;
        const retracted = p.gear && p.gear.retract && this.gearT < 0.05;
        const fx = k * A.x * vp.x * Math.abs(vp.x), fy = k * A.y * vp.y * Math.abs(vp.y), fz = k * A.z * vp.z * Math.abs(vp.z) * (retracted ? 0.05 : 1);
        Fs.set(fx, fy, fz);
        F.add(Fs); Taero.add(_v3.copy(r).cross(Fs));
      }
    }
    const out = this._aero || (this._aero = { maxAlpha: 0, totalLift: 0 });
    out.maxAlpha = maxAlpha; out.totalLift = totalLift;
    return out;
  }
  // The same, at a state the caller sets up (the wind tunnel): air velocity in the body frame, altitude (air density
  // and speed of sound), flap notch (0-3). Control inputs come from this.ce / this.ctl and this.trim, as in flight.
  aeroAt(vAirB, alt, flaps, F, Taero, probe = null) {
    const rho = airDensity(alt), V = vAirB.length(), mach = V / speedOfSound(alt), ctl = this.ce || this.ctl;
    const pitchCmd = clamp(ctl.pitch + (this.R.aeroTorque > 0 ? this.trim : 0), -1, 1);
    return this.aeroLoads(vAirB, V, rho, mach, ctl, pitchCmd, FLAP_DEFL[flaps], F, Taero, probe);
  }

  substep(dt, env) {
    const R = this.R, q = this.q, mass = this.mass;
    _qi.copy(q).invert();
    const alt = this.x.y;
    const rho = airDensity(alt);
    this.rho = rho;
    const wind = env.windAt(this.x);
    const vAirB = _v.copy(this.v).sub(wind).applyQuaternion(_qi).clone();
    const V = vAirB.length();
    this.airspeed = V;
    const mach = V / speedOfSound(alt);
    this.mach = mach;
    const air = airAuthority(rho, 0.5 * rho * V * V); // 1 below ~22 km: the assists below fade only in near-vacuum
    const F = new THREE.Vector3(), T = new THREE.Vector3(), Taero = new THREE.Vector3();
    const ctl = this.ce || this.ctl;
    // automatic pitch trim (like a fly-by-wire autotrim): holds attitude when the stick is centred
    if (R.aeroTorque > 0) {
      if (this.onGround || V < 12) this.trim *= 1 - Math.min(1, dt * 0.5);
      else if (Math.abs(ctl.pitch) < 0.08) this.trim = clamp(this.trim - this.w.x * dt * 1.2, -0.7, 0.7);
    }
    const pitchCmd = clamp(ctl.pitch + (R.aeroTorque > 0 ? this.trim : 0), -1, 1);
    const { maxAlpha, totalLift } = this.aeroLoads(vAirB, V, rho, mach, ctl, pitchCmd, FLAP_DEFL[this.flaps], F, Taero);
    const r = new THREE.Vector3(), Fs = new THREE.Vector3();
    this.alpha = maxAlpha; this.liftRatio = totalLift / (mass * G);
    this.stalled = R.stallSharp > 0 && maxAlpha > 0.29 && V > 8 && !this.onGround && air > 0.5; // (no stalling in a vacuum)
    // ---- engines ----
    const fwdSpeed = -vAirB.z;
    if (this.isHeli) this.rotors(dt, rho, ctl, F, T, q, _qi);
    this.driveF = 0; let burningNow = false;
    if (this.isCar) { // pedals: gas goes; brake slows you, and once stopped (and still held) reverses; gas while rolling back brakes too
      const vg = -_v2.copy(this.v).applyQuaternion(_qi).z; // ground speed along the car
      this.svcBrake = 0;
      if (ctl.rev > 0.02 && ctl.rev >= ctl.throttle) { if (vg > 0.6 && !this.reversing) this.svcBrake = ctl.rev; else this.reversing = true; }
      else { this.reversing = false; if (ctl.throttle > 0.02 && vg < -0.6) this.svcBrake = ctl.throttle; }
      this.groundSpeed = vg;
    }
    for (const p of this.parts) {
      const e = p.engine; if (!e || !p.alive || e.type === 'rotor' || e.type === 'tailrotor' || e.type === 'marine') continue; // (boat motors: boat.js)
      if (e.type === 'drive') { // force goes through the driven wheels (see contacts)
        const rev = this.reversing ? ctl.rev : 0, gas = rev > 0 ? 0 : ctl.throttle, vg = this.groundSpeed;
        e.spoolT = (e.spoolT || 0) + (Math.max(gas, rev) - (e.spoolT || 0)) * Math.min(1, dt / 0.25);
        const dmgF = (1 - clamp(p.dmg / p.hp, 0, 1) * 0.7) * (p.dmg > p.hp * 0.75 ? 0.2 : 1);
        this.driveF += rev > 0 ? -e.thrust * 0.5 * e.spoolT * Math.max(0, 1 - (Math.max(0, -vg) / 10) ** 2) * dmgF
          : e.thrust * e.spoolT * Math.max(0, 1 - (Math.max(0, vg) / (e.vmax * (this.D?.top ?? 1))) ** 2) * dmgF; // (Easy: a gentler top speed)
        // off the pedals the engine holds you back (engine braking): the car slows to a stop instead of coasting for ever
        if (gas < 0.05 && rev < 0.05) this.driveF -= clamp(vg / 1.5, -1, 1) * mass * G * 0.14 * (1 - Math.max(gas, rev) * 20) / Math.max(1, this.motorCount);
        e.thrustNow = 0;
        e.rpm = lerp(e.idleRpm, e.maxRpm, Math.max(e.spoolT * 0.6, clamp(Math.abs(fwdSpeed) / e.vmax, 0, 1)));
        continue;
      }
      let target = ctl.throttle;
      if (e.type === 'rocket') {
        if (e.burning) burningNow = true;
        if (!e.burning && ctl.throttle > 0.5 && e.burn > 0) { e.burning = true; this.emit('msg', { text: 'Rocket ignition!' }); this.emit('rocket', {}); }
        target = e.burning ? 1 : 0;
        if (e.burning) { e.burn -= dt; if (e.burn <= 0) { e.burning = false; this.emit('msg', { text: 'Rocket burnt out' }); } }
      }
      const spool = e.type === 'jet' ? e.spool || 3 : e.type === 'rocket' ? 0.15 : e.sound === 'electric' ? 0.1 : e.spool || 0.5;
      e.spoolT = (e.spoolT || 0) + (target - (e.spoolT || 0)) * Math.min(1, dt / (spool * 0.5));
      const dmgF = 1 - clamp(p.dmg / p.hp, 0, 1) * 0.7;
      let thrust = 0;
      if (e.type === 'prop') thrust = e.thrust * e.spoolT * Math.max(0, 1 - (Math.max(0, fwdSpeed) / e.vmax) ** 1.6) * smooth(0.03, 0.25, rho); // props bite on nothing above ~15 km
      else if (e.type === 'jet') {
        thrust = e.thrust * (0.04 + 0.96 * e.spoolT) * (1 + 0.25 * Math.min(1, fwdSpeed / 300));
        e.abOn = !!e.ab && ctl.throttle > 0.95 && e.spoolT > 0.9;
        if (e.abOn) thrust += (e.ab - e.thrust);
        if (e.ram) thrust *= ramThrust(mach); // turbo-ramjet (inlet spike + bypass): most of the push comes from ram air at Mach 3
        else if (e.ab) thrust *= 1 + 0.9 * clamp((mach - 0.8) / 1.2, 0, 1); // fighter intakes: ram air adds thrust at supersonic speed
        // too little air to burn the fuel: jets fade above ~18 km and flame out by ~25 km (they relight lower down);
        // a turbo-ramjet keeps burning to ~26 km and fades out by ~29 km
        const lit = e.ram ? smooth(0.016, 0.04, rho) : smooth(0.04, 0.11, rho); thrust *= lit;
        if (lit < 0.05 && e.spoolT > 0.3 && !e.flamedOut) { e.flamedOut = true; this.emit('msg', { text: 'Flameout! The air is too thin for jet engines', bad: true }); }
        else if (lit > 0.6) e.flamedOut = false;
        if (lit < 0.5) e.abOn = false;
      } else if (e.type === 'rocket') thrust = e.burning ? e.thrust * (1 + (R.rocketHigh ?? 0) * smooth(8000, 30000, alt)) : 0;
      thrust *= (rho / 1.225) ** (e.type === 'rocket' ? 0 : 0.7) * dmgF;
      if (p.dmg > p.hp * 0.75 && e.type !== 'rocket') thrust *= 0.2;
      e.thrustNow = thrust;
      e.rpm = e.type === 'prop' ? lerp(e.idleRpm, e.maxRpm, e.spoolT) * (0.85 + 0.15 * clamp(fwdSpeed / e.vmax, 0, 1)) : e.spoolT;
      if (e.type === 'prop' && ctl.throttle <= 0.001 && e.spoolT < 0.01 && !this.engineRunning) e.rpm = 0;
      Fs.copy(e.dir).multiplyScalar(thrust);
      F.add(Fs);
      r.copy(e.pos).sub(this.com);
      T.addScaledVector(_v3.copy(r).cross(Fs), R.thrustTorque);
      if (e.type === 'prop') T.addScaledVector(e.dir, -thrust * 0.035 * e.spinDir * R.propTorque);
    }
    this.rocketBurn = burningNow;
    // ---- gravity ----
    F.add(_v2.set(0, -gravityAt(alt, this.v.x * this.v.x + this.v.z * this.v.z) * mass, 0).applyQuaternion(_qi));
    // ---- arcade/pilot assistance ----
    T.addScaledVector(Taero, R.aeroTorque);
    // An amphibian (a car or bike with a boat hull) is both: the hull floats it and the wheels drive it. Afloat (wet and
    // no wheel on land) the boat's help steers and steadies it; on land the car's or bike's does.
    const afloat = this.isBoat && this.boat.wet > 0.05 && !this.landWheels;
    if (this.isBoat) boatForces(this, F, T, ctl, dt, env); // floating, planing, motors, steering (boat.js)
    if (this.isBike) { if (!afloat) bikeAssist(this, F, T, ctl, dt, env); } // balance, counter-steering, wheelies, attitude in the air
    else if (this.isBoat && (afloat || !this.isCar)) { /* the hull's help (boatForces) */ }
    else if (this.isHeli) this.heliAssist(F, T, ctl, q, _qi, fwdSpeed);
    else if (this.isCar && this.onGround && R.assist > 0) { // Arcade/Pilot: stability control keeps the wheels down
      const right = _v2.set(1, 0, 0).applyQuaternion(q), bank = Math.asin(clamp(this.stuntUp ? right.dot(this.stuntUp) : right.y, -1, 1)); // level with the ramp/loop/banking the wheels are on
      const lv = this.D ? this.D.level : R.assist; // (a car's driving mode sets how firmly: a tall narrow build on soft springs falls over without it)
      T.add(_v3.set(0, 0, -bank * 6 * lv - this.w.z * 3 * lv).applyMatrix3(this.I));
      if (this.D) this.carAssist(T);
    }
    else if (R.assist > 0 && !(this.isCar && this.onGround) && this.rocketK < 0.999) {
      const sf = clamp((V - 6) / 22, 0, 1) * (1 - this.rocketK); // (a rocket plane fades this out as it goes rocket-style)
      const des = new THREE.Vector3(ctl.pitch * 1.3, -ctl.yaw * 0.7, -ctl.roll * 2.4);
      const beta = Math.atan2(vAirB.x, Math.max(1, -vAirB.z));
      des.y += -beta * 3 * R.assist;
      const right = _v2.set(1, 0, 0).applyQuaternion(q);
      const bank = Math.asin(clamp(right.y, -1, 1));
      const fwd = _v3.set(0, 0, -1).applyQuaternion(q);
      const upside = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y < 0;
      if (Math.abs(ctl.roll) < 0.1 && !upside) des.z += -bank * 1.5 * R.autoLevel;
      // coordinated turn: yaw with bank
      const k = 7 * R.assist * sf * air;
      const err = des.sub(this.w).multiplyScalar(k);
      if (!this.ctrlAuthority.yaw) err.y *= 0.3;
      T.add(err.applyMatrix3(this.I));
      // kill sideslip
      if (R.sideslipKill > 0) F.x -= vAirB.x * mass * R.sideslipKill * sf * air;
    }
    if (this.isRocket && this.rocketK > 0.001 && !this.onGround) this.rocketAssist(F, T, ctl, V, air, vAirB, Taero);
    // ---- reaction control: in near-vacuum the stick fires attitude jets (rate command: let go and the spin stops) ----
    const rcs = (this.hasRCS || R.spaceRCS) && !this.onGround && !this.isCar ? 1 - air : 0;
    this.rcsFire = 0;
    if (rcs > 0.001) {
      const des = _v3.set(ctl.pitch * 0.9, -ctl.yaw * 0.6, -ctl.roll * 1.4);
      const up = _v2.set(0, 1, 0).applyQuaternion(q);
      if (R.autoLevel > 0 && Math.abs(ctl.roll) < 0.1 && up.y > 0) des.z += -Math.asin(clamp(_v2.set(1, 0, 0).applyQuaternion(q).y, -1, 1)) * 1.2 * R.autoLevel;
      des.sub(this.w); this.rcsFire = Math.min(1, des.length() * rcs);
      T.add(des.multiplyScalar(3 * rcs).applyMatrix3(this.I));
    }
    // ---- integrate forces (contacts applied as impulses after) ----
    const Fw = F.applyQuaternion(q);
    this.lastAccel = Fw.clone().divideScalar(mass);
    this.v.addScaledVector(Fw, dt / mass);
    // angular: dw = Iinv (T - w x Iw)
    const Iw = this.w.clone().applyMatrix3(this.I);
    const gyro = this.w.clone().cross(Iw);
    const dw = T.sub(gyro).applyMatrix3(this.Iinv);
    this.w.addScaledVector(dw, dt);
    // clamp absurd rates
    if (this.w.lengthSq() > 400) { this.w.setLength(20); this.diag.spinClamps++; }
    // ---- ground contact ----
    this.wW.copy(this.w).applyQuaternion(q);
    this.invIW.copy(this.Iinv);
    const Rm = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    this.invIW.multiplyMatrices(Rm, this.Iinv).multiply(Rm.clone().transpose());
    this.invMass = 1 / mass;
    this.contacts(dt, env);
    if (this.isBoat && this.boat.wet > 0.01) this.onGround = true; // afloat
    if (this.walls?.length) this.wallContacts(env);
    this.w.copy(this.wW).applyQuaternion(_qi.copy(q).invert());
    // ---- integrate position / orientation ----
    this.x.addScaledVector(this.v, dt);
    _q.set(this.w.x * dt * 0.5, this.w.y * dt * 0.5, this.w.z * dt * 0.5, 0);
    const dq = q.clone().multiply(_q);
    q.x += dq.x; q.y += dq.y; q.z += dq.z; q.w += dq.w; q.normalize();
    // load factor
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // structural limits
    if (R.gLimit < Infinity && !this.onGround) {
      for (const p of this.parts) {
        if (!p.alive || !p.surfaces.length || p.d.cat !== 'wing') continue;
        const share = p.surfaces.reduce((a, s) => a + s.area * Math.abs(s.n.y), 0) / Math.max(0.5, this.hArea);
        const strength = this.initialMass * G * share * R.gLimit * 1.1 + p.hp * 2;
        // Structures fail from SUSTAINED overload, not one twitchy frame: time over the limit accumulates (and drains twice
        // as fast below it); ~0.75 s over breaks the part, a gross overload (1.8x) still breaks it at once.
        // per-substep lift is noisy (the old check snapped wings on numeric spikes at ~7 g): judge a smoothed load
        p.liftS = (p.liftS ?? p.lift) + (p.lift - (p.liftS ?? p.lift)) * Math.min(1, dt / 0.12);
        const ratio = Math.abs(p.liftS) / strength;
        p.overT = ratio > 1 ? (p.overT || 0) + dt : Math.max(0, (p.overT || 0) - dt * 2);
        if (p.overT > 0.25 && !p.strainWarned) { p.strainWarned = true; this.emit('msg', { text: `${p.name} is straining! Ease off!`, bad: true }); this.emit('strain', { part: p.i }); }
        if (p.overT === 0) p.strainWarned = false;
        if (p.overT > 0.75 || ratio > 1.8) { this.cause = { why: 'overload', g: this.g }; this.emit('msg', { text: `Over-G! ${p.name} snapped!`, bad: true }); this.breakPart(p.i, 'overload'); this.cause = null; }
      }
    }
  }

  contacts(dt, env) {
    const lowest = this.x.y - this.radius;
    if (lowest > env.maxGround(this.x.x, this.x.z) + 2) { this.onGround = false; this.stuntUp = null; for (const p of this.parts) if (p.gear) for (const w of p.gear.wheels) { w.contact = false; w.comp = 0; } return; }
    const q = this.q;
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    const fwdB = new THREE.Vector3(0, 0, -1);
    let anyWheel = false, maxPen = 0;
    const R = this.R;
    // count wheels for stiffness
    let nW = 0, nDrive = 0; for (const p of this.parts) if (p.alive && p.gear && (this.gearT > 0.95 || !p.gear.retract)) { nW += p.gear.wheels.length; nDrive += p.gear.wheels.filter((w) => w.drive).length; }
    const kBase = (this.mass * G) / (0.09 * Math.max(2, nW));
    const cBase = 2 * Math.sqrt(kBase * this.mass / Math.max(2, nW)) * 0.6;
    const top = new THREE.Vector3(), pt = new THREE.Vector3(), rr = new THREE.Vector3(), vpt = new THREE.Vector3();
    const stuntN = new THREE.Vector3(); let nStunt = 0, stuntPen = 0; const stuntPush = new THREE.Vector3();
    let rollM = 0, landWheel = false; const fwdCar = this.D ? _rf.set(0, 0, -1).applyQuaternion(q) : null;
    for (const p of this.parts) {
      if (!p.alive || !p.gear) continue;
      const usable = !p.gear.retract || this.gearT > 0.95;
      for (const w of p.gear.wheels) {
        w.contact = false;
        if (!usable) continue;
        this.worldPoint(w.top, top);
        const L = w.len + w.r;
        down.copy(w.dir).applyQuaternion(q);
        const g = groundUnder(env, top, down, L); // the terrain, or a stunt ramp/loop the strut points at (collide.js)
        if (g.type === 'water' && this.isBoat && !w.float) continue; // an amphibian's hull floats it: the wheels hang in the water (and paddle: boat.js)
        const d = g.d;
        const comp = L - d;
        w.comp = clamp(comp, 0, w.len * 0.6);
        if (comp <= 0) continue;
        w.contact = true; anyWheel = true; if (g.type !== 'water') landWheel = true;
        if (g.stunt) { stuntN.add(g.n); nStunt++; }
        pt.copy(top).addScaledVector(down, d);
        rr.copy(pt).sub(this.x);
        vpt.copy(this.wW).cross(rr).add(this.v);
        const vn = vpt.dot(g.n);
        const water = g.type === 'water';
        const limit = (p.gear.limit || 4) * R.gearMult * (water && !w.float ? 0.5 : 1);
        if (-vn > limit && !w.float) { this.diag.gearCollapses++; this.cause = { why: 'hard_landing', impact: -vn, limit, surf: g.type, stunt: !!g.stunt }; this.emit('msg', { text: `Hard landing! ${p.name} collapsed`, bad: true }); this.emit('impact', { pos: pt.clone(), speed: -vn, surf: g.type }); this.breakPart(p.i, 'gear'); this.cause = null; break; }
        if (-vn > 1.2 && !w.wasContact) this.emit('touch', { pos: pt.clone(), speed: -vn, water, float: w.float });
        let N = kBase * Math.min(comp, w.len * 0.7) - cBase * vn;
        if (comp > w.len * 0.7) N += kBase * 20 * (comp - w.len * 0.7);
        N = Math.max(0, N);
        if (w.float && !water) N *= 1; // skid on ground
        // directions
        const fwdW = fwdB.clone();
        if (w.steer) fwdW.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.steerAngle(w));
        fwdW.applyQuaternion(q);
        fwdW.addScaledVector(g.n, -fwdW.dot(g.n)).normalize();
        const latW = new THREE.Vector3().crossVectors(g.n, fwdW).normalize();
        const vf = vpt.dot(fwdW), vl = vpt.dot(latW);
        let muRoll = 0.025, muLat = 0.9;
        if (g.type === 'grass') muRoll = 0.05;
        if (w.brake) muRoll += Math.max(this.brake, this.svcBrake) * (this.isBike ? 0.95 : 0.65); // (a bike's brakes can stop it at about 1 g; its rider stops it tipping over the front)
        const hand = this.isCar && this.ctl.hand > 0 && w.top.z > this.com.z ? this.ctl.hand : 0; // handbrake locks the back wheels: slide!
        // a car's driving mode (drive.js): its tyres' side grip; Easy and Racer's handbrake drift lets the tail out but
        // keeps the gas pushing; with no ABS (Pro) a hard brake locks the wheel and it slides instead of steering
        const D = this.D, drift = D && hand && D.drift > 0 && Math.abs(vf) > 5 ? D.drift : 0;
        if (D && !w.float && !water) muLat = D.latMu * (g.type === 'grass' || g.type === 'sand' ? 0.85 : 1);
        if (drift) { muRoll += hand * 0.1; muLat *= 1 - 0.7 * hand * drift; }
        else if (hand) { muRoll += hand * 0.6; muLat *= 1 - 0.5 * hand; }
        const lock = D && !D.abs && w.brake && Math.max(this.brake, this.svcBrake) > 0.75 && Math.abs(vf) > 2 ? 1 : 0;
        if (lock) muLat *= 0.35;
        if (w.float) { muRoll = water ? 0.03 + Math.min(0.12, Math.abs(vf) * 0.004) : 0.35; muLat = water ? 0.35 : 0.5; }
        else if (water) { muRoll = 0.6; muLat = 0.6; }
        const DBG = globalThis.__dbg || {};
        const Ff = -clamp(vf / 0.4, -1, 1) * muRoll * N * (DBG.roll ?? 1);
        const Fl = -clamp(vl / 0.25, -1, 1) * muLat * N * (DBG.lat ?? 1);
        const grip = w.grip || 0.8, Fd = w.drive && nDrive ? clamp(this.driveF / nDrive, -grip * N, grip * N) * (water ? 0.15 : 1) * (1 - (drift ? 0.3 : 1) * hand) : 0; // engine through the tyre
        // one grip budget per tyre: pushing and cornering share it, so a spinning wheel slides instead of adding grip
        let Fx = Ff + Fd, Fy = Fl; const cap = Math.max(muLat, muRoll, w.grip || 0) * N, tot = Math.hypot(Fx, Fy);
        if (D && D.tc && tot > cap) { // traction control and ABS: steering keeps its grip, the gas and brakes get what is left (at least a third)
          const room = Math.max(Math.sqrt(Math.max(0, cap * cap - Fy * Fy)), cap * 0.35);
          Fx = clamp(Fx, -room, room); const t2 = Math.hypot(Fx, Fy); if (t2 > cap) Fy *= Math.sqrt(Math.max(0, cap * cap - Fx * Fx)) / Math.abs(Fy);
        } else if ((Fd || hand || (D && Ff)) && tot > cap) { Fx *= cap / tot; Fy *= cap / tot; }
        if (D && D.antiRoll) rollM += _rv.copy(rr).cross(_rb.copy(fwdW).multiplyScalar(Fx).addScaledVector(latW, Fy)).dot(fwdCar); // the tyre's push along the road (sideways, and a turned wheel's drive) rolls the car: summed to cancel below
        const Fw = g.n.clone().multiplyScalar(N).addScaledVector(fwdW, Fx).addScaledVector(latW, Fy);
        // apply as impulse
        applyImpulse(this, rr, Fw.multiplyScalar(dt));
        w.spin = (w.spin || 0) + (vf / Math.max(0.1, w.r)) * dt;
        w.vf = vf; w.slip = Math.abs(vl);
        // for the engine sound only (motorSound.js): how hard a driven wheel is spinning (the push it was asked for past what
        // the tyre could take; traction control keeps it near zero) and whether the brakes or handbrake have locked it
        if (w.drive) {
          const want = nDrive ? this.driveF / nDrive * (water ? 0.15 : 1) : 0, used = Math.abs(Fx - Ff) + 1; // the engine's push asked for, and what the tyre passed on
          w.spinX = want * vf >= -0.5 * Math.abs(want) && Math.abs(want) > used * 1.05 ? Math.min(3, Math.abs(want) / used - 1) * (D && D.tc ? 0.08 : 1) : 0;
          w.locked = lock || (hand > 0.5 && !drift) ? 1 : 0;
        }
        if (water && Math.abs(vf) > 3 && Math.random() < 0.3) this.emit('spray', { pos: pt.clone(), speed: Math.abs(vf) });
        else if (!water && w.locked && Math.abs(vf) > 2 && Math.random() < 0.35) this.emit('skid', { pos: pt.clone(), speed: Math.abs(vf), surf: g.type }); // (a locked wheel: tyre smoke or a dust trail)
        else if (!water && g.type !== 'runway' && Math.abs(vf) > 8 && Math.random() < 0.06) this.emit('dust', { pos: pt.clone(), speed: Math.abs(vf), surf: g.type });
      }
      for (const w of p.gear.wheels) w.wasContact = w.contact;
    }
    this.landWheels = landWheel; // (an amphibian with a wheel on land drives; with none, afloat, the hull carries it)
    // Easy and Racer: an invisible hand cancels (part of) the roll the tyres' cornering push puts on the car, so it
    // corners flat and can't tip over in a turn (drive.js antiRoll)
    if (rollM) this.wW.add(_rv.copy(fwdCar).multiplyScalar(-this.D.antiRoll * rollM * dt).applyMatrix3(this.invIW));
    // hull points
    const hp = new THREE.Vector3();
    const hits = new Map(), slide = new Map(); let inWater = false;
    for (const p of this.parts) {
      if (!p.alive) continue;
      for (const h of p.hull) {
        this.worldPoint(h, hp);
        if (hp.y > this.x.y + 50) continue;
        const g = groundAtPoint(env, hp); // (terrain, or a stunt ramp the point is inside)
        if (hp.y > g.h) continue;
        const water = g.type === 'water', slick = g.type === 'slick'; // (slick: a wet ramp, waterPark.js: a hull slides up it, no scraping)
        if (water && this.isBoat) continue; // (a boat's hull floats: boat.js)
        const res = contactPoint(this, hp, g, { e: water ? 0 : 0.12, mu: water ? 0.12 : slick ? 0.04 : g.type === 'runway' ? 0.4 : 0.55 });
        if (!res) continue;
        if (g.stunt) { if (res.pen > stuntPen) { stuntPen = res.pen; stuntPush.copy(g.n); } } // pushed out along the face, not up
        else maxPen = Math.max(maxPen, res.pen);
        const impact = -res.vn;
        const thr = (water ? 9 : 4.5) * R.crashMult;
        if (impact > thr * 0.6 && (!hits.has(p) || hits.get(p).impact < impact)) hits.set(p, { impact, pt: hp.clone(), n: g.n.clone(), thr, surf: g.type, stunt: !!g.stunt });
        if (res.vt > 4 && !water && !slick) {
          slide.set(p, Math.max(slide.get(p) || 0, res.vt));
          if (Math.random() < 0.08) this.emit('scrape', { pos: hp.clone(), speed: res.vt, surf: g.type });
        }
        if ((water || slick) && (res.vt > 3 || impact > 2) && Math.random() < 0.15) this.emit('spray', { pos: hp.clone(), speed: Math.max(res.vt, impact) });
        if (water) inWater = true;
      }
    }
    for (const [p, vt] of slide) { this.cause = { why: 'scrape', impact: vt }; this.damage(p, (vt * dt * 2.5) / R.crashMult / (p.i === 0 ? 3 : 1), null); }
    this.cause = null;
    if (inWater) { this.v.multiplyScalar(1 - 0.9 * dt); this.wW.multiplyScalar(1 - 1.5 * dt); }
    for (const [p, h] of hits) { // one damage event per part per step (not per contact point)
      this.deform(p, h.pt, h.n, Math.min(0.5, (h.impact - h.thr * 0.4) * 0.025));
      if (h.impact > h.thr) {
        this.cause = { why: 'hit', impact: h.impact, thr: h.thr, surf: h.surf, stunt: !!h.stunt };
        const toughness = p.i === 0 ? 3 : 1; // the core body is extra strong so crashes come apart progressively
        this.damage(p, ((h.impact - h.thr) ** 2 * 22) / toughness, h.pt);
        this.emit('impact', { pos: h.pt, speed: h.impact, surf: h.surf });
      }
    }
    this.cause = null;
    // pushed out of a structure from deep inside it: a sign of tunnelling into a ramp or the loop (and of the "glitch" jolts)
    if (stuntPen > 0.3) this.diag.deepPens++;
    this.diag.maxPen = Math.max(this.diag.maxPen, stuntPen, maxPen);
    if (maxPen > 0) this.x.y += Math.min(maxPen, 0.5) * 0.3;
    if (stuntPen > 0) this.x.addScaledVector(stuntPush, Math.min(stuntPen, 0.5) * 0.3);
    this.stuntUp = nStunt ? stuntN.normalize() : null; // wheels on a structure: the surface they stand on (assists level with it)
    const wasGround = this.onGround;
    this.onGround = anyWheel || maxPen > 0 || stuntPen > 0;
    if (anyWheel && !wasGround && this.airTimeNow > 3) {
      const vs = -this.v.y;
      this.stats.landings++;
      if (this.stats.bestLanding === null || vs < this.stats.bestLanding) this.stats.bestLanding = vs;
      this.emit('landing', { vs, onWheels: true });
    }
    if (this.onGround) this.airTimeNow = 0;
  }

  // ---- buildings (cars and bikes) ----
  // Every substep (240 Hz or more: a car moves under half a metre between tests even at 100 m/s, so it can't tunnel
  // through a wall), the vehicle's whole box (every hull point and wheel, body frame) is tested against each building's
  // box nearby (env.walls: world.wallBoxes) by separating axes in plan view and by height. Overlapping, it is pushed out
  // along the shallowest axis and the push is an impulse at its deepest corners (a glancing blow turns it along the
  // wall, a corner spins it). A hole knocked in a building lets it through (env.wallPass).
  bodyBox() {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate(), _p = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.alive) continue;
      for (const h of p.hull) { lo.min(h); hi.max(h); }
      if (p.gear) for (const w of p.gear.wheels) for (const s of [-1, 1]) { _p.copy(w.top).addScaledVector(w.dir, w.len).add(_v.set(0, s * w.r, s * w.r)); lo.min(_p); hi.max(_p); _p.copy(w.top); lo.min(_p); hi.max(_p); }
    }
    const pts = []; for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z));
    return { pts, n: this.alive().length, world: pts.map(() => new THREE.Vector3()) };
  }
  wallContacts(env) {
    let bb = this.wallBox; if (!bb || bb.n !== this.alive().length) bb = this.wallBox = this.bodyBox();
    const C = bb.world; let ymin = Infinity, ymax = -Infinity, cx = 0, cz = 0;
    for (let i = 0; i < 8; i++) { this.worldPoint(bb.pts[i], C[i]); ymin = Math.min(ymin, C[i].y); ymax = Math.max(ymax, C[i].y); cx += C[i].x / 8; cz += C[i].z / 8; }
    const f = _rf.set(0, 0, -1).applyQuaternion(this.q); f.y = 0; if (f.lengthSq() < 1e-4) f.set(1, 0, 0).applyQuaternion(this.q).setY(0); f.normalize();
    const axes = [[0, 0], [0, 0], [f.x, f.z], [-f.z, f.x]], n = _ra, r = _rb;
    for (const B of this.walls) {
      if (B.y1 < ymin + 0.25 || (B.y0 > ymax && B.y0 > ymin + 3)) continue; // over it (on rubble, a kerb) or well under it (a box less than 3 m up still reaches the street: New York's sit on their footprint's base height)
      axes[0][0] = B.ux; axes[0][1] = B.uz; axes[1][0] = -B.uz; axes[1][1] = B.ux;
      let best = Infinity, nx = 0, nz = 0;
      for (const [ax, az] of axes) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 8; i++) { const d = C[i].x * ax + C[i].z * az; lo = Math.min(lo, d); hi = Math.max(hi, d); }
        const bc = B.x * ax + B.z * az, be = B.hl * Math.abs(ax * B.ux + az * B.uz) + B.hw * Math.abs(-ax * B.uz + az * B.ux);
        const o = Math.min(hi - (bc - be), bc + be - lo); if (o <= 0) { best = -1; break; }
        if (o < best) { best = o; const s = cx * ax + cz * az > bc ? 1 : -1; nx = ax * s; nz = az * s; }
      }
      if (best <= 0) continue;
      // the deepest corners (one for a corner-on hit, a whole face head-on), at a height inside the building
      let dmin = Infinity; for (let i = 0; i < 8; i++) dmin = Math.min(dmin, C[i].x * nx + C[i].z * nz);
      r.set(0, 0, 0); let k = 0;
      for (let i = 0; i < 8; i++) if (C[i].x * nx + C[i].z * nz < dmin + 0.15) { r.add(C[i]); k++; }
      r.divideScalar(k); r.y = clamp(this.x.y, B.y0 + 0.1, B.y1 - 0.1);
      if (env.wallPass?.(B.e, r)) continue; // through a hole knocked in it
      n.set(nx, 0, nz);
      this.x.addScaledVector(n, Math.min(best, 1.5) + 0.002);
      r.sub(this.x);
      const vn = pointVel(this, r, _rc).dot(n);
      if (vn < 0) {
        const j = (-1.25 * vn) / effMass(this, r, n); applyImpulse(this, r, _rd.copy(n).multiplyScalar(j));
        const vt = pointVel(this, r, _rc).addScaledVector(n, -pointVel(this, r, _v2).dot(n)), vtl = vt.length();
        if (vtl > 1e-3) { vt.divideScalar(vtl); applyImpulse(this, r, vt.multiplyScalar(-Math.min(0.35 * j, vtl / effMass(this, r, vt)))); }
        const wt = this.wallT || (this.wallT = new WeakMap()); if (-vn > 1.5 && this.time - (wt.get(B.e) ?? -1) > 0.3) { wt.set(B.e, this.time); this.emit('wall', { e: B.e, pos: r.clone().add(this.x), speed: -vn, n: n.clone() }); }
      }
    }
  }

  damage(p, amount, at) {
    if (!p.alive) return;
    p.dmg += amount;
    if (!p.scorched && p.dmg > p.hp * 0.55) {
      p.scorched = true;
      p.obj.traverse((o) => { if (o.isMesh && !o.material.transparent && o.material.color) { const old = o.material; o.material = old.clone(); keepCabinPatch(old, o.material); keepHeatPatch(old, o.material); o.material.color.multiplyScalar(0.45); if (o.material.roughness !== undefined) o.material.roughness = 0.8; if (o.material.clearcoat) o.material.clearcoat = 1e-4; } }); // (not 0: that's another shader, compiled mid-crash)
      if (p.engine) this.emit('msg', { text: `${p.name} damaged!`, bad: true });
    }
    if (p.dmg >= p.hp) this.breakPart(p.i, 'impact');
  }

  deform(p, worldPt, dirWorld, amount) {
    if (amount < 0.01) return;
    const inv = new THREE.Matrix4(), lp = new THREE.Vector3(), ld = new THREE.Vector3(), v = new THREE.Vector3();
    const radius = 0.6 + amount * 3;
    p.obj.traverse((o) => {
      if (!o.isMesh || o.userData.isDisc) return;
      o.updateMatrixWorld(true);
      inv.copy(o.matrixWorld).invert();
      lp.copy(worldPt).applyMatrix4(inv);
      ld.copy(dirWorld).transformDirection(inv);
      const pos = o.geometry.attributes.position;
      let changed = false;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = v.distanceTo(lp);
        if (d > radius) continue;
        const f = (1 - d / radius) ** 2 * amount;
        v.addScaledVector(ld, f);
        v.x += (Math.random() - 0.5) * f * 0.4; v.y += (Math.random() - 0.5) * f * 0.4; v.z += (Math.random() - 0.5) * f * 0.4;
        pos.setXYZ(i, v.x, v.y, v.z); changed = true;
      }
      if (changed) { pos.needsUpdate = true; o.userData.dirtyNormals = true; }
    });
    this.normalsDirty = true;
  }

  breakPart(i, why) {
    const p = this.parts.find((pp) => pp.i === i);
    if (!p || !p.alive) return;
    const idxs = subtree(this.design.parts, i).filter((k) => this.parts[k] && this.parts[k].alive);
    if (i === 0) {
      // the core is destroyed: everything comes apart
      this.wrecked = true;
      const all = this.parts.filter((pp) => pp.alive);
      for (const pp of all) this.detach([pp.i], 'wreck');
      this.emit('wreck', { pos: this.x.clone(), speed: this.v.length() });
      this.dead = true;
      return;
    }
    this.detach(idxs, why);
  }

  detach(idxs, why) {
    const objs = [], hull = []; let mass = 0; const c = new THREE.Vector3(); let burning = 0, names = [];
    for (const k of idxs) {
      const p = this.parts[k]; if (!p.alive) continue;
      p.alive = false; this.stats.partsLost++;
      objs.push(p.obj); mass += p.mass; c.addScaledVector(this.worldPoint(p.center), p.mass); names.push(p.name);
      for (const h of p.hull) hull.push(this.worldPoint(h));
      if (p.gear) for (const w of p.gear.wheels) hull.push(this.worldPoint(w.top.clone().add(new THREE.Vector3(0, -(w.len + w.r), 0))), this.worldPoint(w.top));
      if (p.engine && (p.engine.spoolT > 0.2 || why === 'wreck')) burning = Math.max(burning, p.engine.type === 'jet' || p.engine.type === 'rocket' ? 1 : 0.6);
      if (p.light?.spot) { p.light.spot.intensity = 0; }
    }
    if (!objs.length) return;
    c.divideScalar(mass);
    if (!hull.length) hull.push(c.clone());
    const r = c.clone().sub(this.x);
    const v = this.wW.clone().cross(r).add(this.v);
    const kick = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3);
    v.add(kick);
    const wW = this.wW.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4));
    // world transforms are kept by Debris constructor
    this.root.updateMatrixWorld(true);
    const deb = new Debris(objs, c, v, wW, mass, hull, { burning: why === 'wreck' && burning ? burning : burning * 0.5, smoking: 1, name: names[0] });
    syncBatch(this.batch); // its meshes left the plane: they draw themselves again (now, even if the plane is gone)
    this.emit('debris', { debris: deb, why, names, ids: idxs.map((k) => this.parts[k].p.id), pos: c.clone(), speed: v.length(), cause: this.cause ? { ...this.cause } : null });
    if (why !== 'wreck') this.emit('msg', { text: `${names[0]} ${why === 'gear' ? 'snapped off' : 'broke off'}!`, bad: true });
    if (this.alive().length === 0) { this.dead = true; return; }
    const before = this.initialMass;
    this.updateMass();
    if (this.mass < before * 0.35 || !this.parts[0].alive) { this.wrecked = true; }
    this.hasEngine = this.parts.some((p) => p.alive && p.engine);
    this.hasRCS = this.parts.some((p) => p.alive && (p.d.rcs || p.engine?.type === 'rocket'));
  }

  updateVisuals(dt, env) {
    if (this.dead) return;
    this.syncVisual();
    // Mach number and skin temperature (also runs for remote planes, which skip substep).
    // Air hitting the skin is squeezed and heats it towards T_amb * (1 + 0.2 M²); the skin warms and cools with a lag.
    const tAmb = airTemp(this.x.y);
    this.mach = (this.airspeed || 0) / speedOfSound(this.x.y);
    if (!Number.isFinite(this.mach)) this.mach = 0;
    this.stats.maxMach = Math.max(this.stats.maxMach || 0, this.mach);
    // ...but only where there is air to squeeze: full heating below ~42 km, fading out towards space (re-entry glows at 40-60 km)
    const rho = airDensity(this.x.y), heatK = Math.min(1, Math.sqrt(rho / 0.003));
    this.rho = rho; this.airFx = smooth(1e-5, 5e-4, rho); // (sonic.js: no booms, vapour or plasma in a vacuum)
    const tSkin = tAmb * (1 + 0.2 * this.mach * this.mach * heatK);
    if (!(this.skinK > 0)) this.skinK = tAmb;
    this.skinK += (tSkin - this.skinK) * (1 - Math.exp(-dt / (tSkin > this.skinK ? 6 : 12)));
    this.skinC = this.skinK - 273.15;
    const spd = this.v.length(); this.stats.maxSpeed = Math.max(this.stats.maxSpeed, spd);
    this.stats.maxAlt = Math.max(this.stats.maxAlt, this.x.y - (env.groundHeightAtSpawn || 0));
    if (!this.onGround) { this.stats.airTime += dt; this.airTimeNow = (this.airTimeNow || 0) + dt; }
    this.stats.maxG = Math.max(this.stats.maxG, Math.abs(this.g));
    this.stats.distance += spd * dt;
    // gear retraction
    const tgt = this.gearDown ? 1 : 0;
    this.gearT += clamp(tgt - this.gearT, -dt / 3, dt / 3);
    for (const p of this.parts) {
      if (!p.alive) continue;
      for (const s of p.surfaces) if (s.ctrlObj) s.ctrlObj.rotation.x = lerp(s.ctrlObj.rotation.x, s.delta, Math.min(1, dt * 12));
      const e = p.engine;
      if (e) {
        if (e.prop) {
          const rps = e.type === 'prop' ? (e.rpm / 60) : e.type === 'rotor' ? e.rpm / 300 * (e.spoolT || 0) : e.type === 'tailrotor' ? e.rpm / 60 * (e.spoolT || 0) : 0;
          e.angle += rps * Math.PI * 2 * dt * e.spinDir * (e.sound === 'electric' ? 0.3 : 1);
          e.prop.userData.spinner.rotation.z = e.angle;
          const fast = e.type === 'rotor' || e.type === 'tailrotor' ? clamp((e.spoolT || 0) * 1.2 - 0.2, 0, 1) : clamp((e.rpm - 500) / 1200, 0, 1);
          e.prop.userData.disc.material.opacity = 0;
          e.prop.userData.spinner.visible = true;
          if (!e.discMat) { e.discMat = e.prop.userData.disc.material.clone(); e.prop.userData.disc.material = e.discMat; }
          e.discMat.opacity = fast * 0.14;
          e.prop.userData.spinner.children.forEach((c) => (c.visible = fast < 0.85 || Math.random() < 0.3));
        }
        if (e.fan) e.fan.rotation.z += (e.spoolT * 40 + 0.5) * dt;
        if (e.flame) {
          const on = e.type === 'rocket' ? (e.burning ? 1 : 0) : e.abOn ? 1 : 0;
          const flick = 0.85 + Math.random() * 0.3;
          e.flame.material.opacity = lerp(e.flame.material.opacity, on * 0.75 * flick, Math.min(1, dt * 10));
          e.flameCore.material.opacity = lerp(e.flameCore.material.opacity, on * 0.9 * flick, Math.min(1, dt * 10));
          e.flame.scale.set(1, 0.8 + on * 0.3 * flick, 1);
          e.flame.visible = e.flame.material.opacity > 0.02; e.flameCore.visible = e.flame.visible;
        }
      }
      if (p.gear) {
        if (p.gear.retract && p.gear.strut) this.animateRetract(p);
        const w = p.gear.wheels[0];
        if (p.gear.wheelObj && !w.float) {
          p.gear.wheelObj.position.y = (-w.len + w.comp) / w.ls;
          p.gear.wheelObj.children.forEach((c) => { if (!p.d.gear.wheels) c.rotation.x = -(w.spin || 0); });
          if (w.steer) p.gear.wheelObj.rotation.y = this.steerAngle(w) * (p.p.mirror ? -1 : 1); // (a mirrored part's local frame is flipped)
        }
      }
      if (p.light?.bulb && p.light.type === 'nav') {
        const strobe = p.light.color === 0xffffff;
        const on = strobe ? (this.time % 1.2) < 0.08 : true;
        p.light.bulb.visible = on;
      }
    }
    if (this.landingLight) this.landingLight.intensity = env.night ? 4000 : 0;
    updateDetail(this, dt); // gear doors, slats, spoilers
    if (this.isBoat) boatVisuals(this);
    if (this.normalsDirty) {
      this.normalsDirty = false;
      this.root.traverse((o) => { if (o.isMesh && o.userData.dirtyNormals) { o.geometry.computeVertexNormals(); o.userData.dirtyNormals = false; } });
    }
    // draw-call batching (acBatch.js): built on the first visual frame (after SonicFX's heat copies), then kept in sync
    if (this.batchOff !== true) {
      try { if (!this.batch) this.batch = batchAircraft(this); else syncBatch(this.batch); }
      catch (err) { console.warn('acBatch', err); unbatchAircraft(this.batch); this.batch = null; this.batchOff = true; }
    }
  }

  // Retractable gear folds into the body: main legs swing inwards (towards the centreline), nose/centre legs
  // forwards, and everything above the attachment point is clipped so nothing pokes through the wing.
  animateRetract(p) {
    const g = p.gear, up = 1 - this.gearT;
    if (!g.clip) {
      g.clip = new THREE.Plane();
      g.strut.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.clippingPlanes = [g.clip]; o.material.clipShadows = true; } });
      const xw = p.p.pos[0], centre = Math.abs(xw) < 0.35 || p.d.gear.steer;
      g.fold = centre ? { axis: 'x', sign: p.d.gear.steer ? 1 : -1 } : { axis: 'z', sign: -Math.sign(xw) * (p.p.mirror ? -1 : 1) };
    }
    g.strut.rotation.x = g.strut.rotation.z = 0;
    g.strut.rotation[g.fold.axis] = up * (Math.PI / 2) * g.fold.sign;
    g.strut.visible = this.gearT > 0.02;
    // clip plane at the skin: keep only what hangs below the attachment point (in world space)
    p.obj.updateMatrixWorld();
    const n = new THREE.Vector3(0, -1, 0).transformDirection(p.obj.matrixWorld), o = new THREE.Vector3(0, -0.03, 0).applyMatrix4(p.obj.matrixWorld);
    g.clip.setFromNormalAndCoplanarPoint(n, o);
    if (this.gearT > 0.999) g.clip.constant = 1e6; // fully down: no clipping
  }
  // Cockpit views (stations.js): one per seat, built from the assembled meshes the first time they are asked for.
  get stations() { return this._stations || (this._stations = buildStations(this)); }
  // first person at station st (null = outside): that seat's figure loses its head and torso, the rest stays
  setCockpitView(st) { if (this._stations || st) showStation(this.stations, st || null); }
  // things the camera / audio / HUD want
  get forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.q); }
  get up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.q); }
  eyePoint() { const st = this.stations.find((s) => !s.part || s.part.alive) || this.stations[0]; return st ? st.eye.clone() : this.com.clone(); }
}
