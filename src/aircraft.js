// Runtime aircraft: rigid-body flight model built from parts, ground contact, damage & break-up.
import * as THREE from 'three';
import { PARTS, partInfo } from './parts.js';
import { partMatrix, subtree } from './design.js';
import { M } from './materials.js';
import { clamp, lerp } from './noise.js';

export const REALISM = {
  arcade: { id: 'arcade', name: 'Arcade', aeroTorque: 0, assist: 1, liftMult: 1.6, minArea: 12, stallSharp: 0, sideslipKill: 1.6, gearMult: 2.5, crashMult: 2.6, gLimit: Infinity, thrustTorque: 0, propTorque: 0, dragMult: 0.6, autoLevel: 0.9 },
  pilot: { id: 'pilot', name: 'Pilot', aeroTorque: 0.55, assist: 0.45, liftMult: 1.15, minArea: 0, stallSharp: 0.5, sideslipKill: 0.25, gearMult: 1.5, crashMult: 1.6, gLimit: 16, thrustTorque: 0.4, propTorque: 0, dragMult: 0.85, autoLevel: 0.15 },
  sim: { id: 'sim', name: 'Simulator', aeroTorque: 1, assist: 0, liftMult: 1, minArea: 0, stallSharp: 1, sideslipKill: 0, gearMult: 1, crashMult: 1, gLimit: 10, thrustTorque: 1, propTorque: 1, dragMult: 1, autoLevel: 0 },
};

const G = 9.81;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
export const airDensity = (h) => 1.225 * Math.exp(-Math.max(0, h) / 9000);

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
        const g = env.groundAt(p.x, p.z);
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
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.w = new THREE.Vector3();
    this.wW = new THREE.Vector3(); this.invIW = new THREE.Matrix3();
    this.stats = { maxSpeed: 0, maxAlt: 0, maxG: 1, time: 0, airTime: 0, landings: 0, bestLanding: null, partsLost: 0, distance: 0 };
    this.g = 1; this.alpha = 0; this.stalled = false; this.onGround = false; this.wrecked = false; this.time = 0;
    this.landingLight = null;
    const m = new THREE.Matrix4();
    design.parts.forEach((p, i) => {
      const d = PARTS[p.id]; if (!d) return;
      const info = partInfo(p.id);
      const obj = d.build(p.color);
      partMatrix(p, m); m.decompose(obj.position, obj.quaternion, obj.scale);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = !o.material.transparent; o.receiveShadow = !o.material.transparent; } });
      this.root.add(obj);
      const part = { i, p, d, obj, m: m.clone(), alive: true, hp: d.hp, dmg: 0, mass: d.mass, info, scorched: false,
        center: info.centroid.clone().applyMatrix4(m), surfaces: [], engine: null, gear: null, hull: [], dragA: null, name: d.name };
      const ctrlObjs = obj.userData.controls || (obj.children[0]?.userData?.controls) || [];
      for (const s of info.surfaces) {
        const sv = { pos: new THREE.Vector3(...s.pos).applyMatrix4(m), n: new THREE.Vector3(...s.n).transformDirection(m), f: new THREE.Vector3(...s.f).transformDirection(m),
          s: new THREE.Vector3(...s.s).transformDirection(m), area: s.area, ar: s.ar, role: s.role, chord: s.chord, cl0: (d.wing?.camber || 0) * 9,
          delta: 0, mix: { pitch: 0, roll: 0, yaw: 0 }, ctrlObj: null, load: 0, part };
        sv.isDelta = (d.wing?.ar || 9) < 2.6;
        part.surfaces.push(sv);
      }
      ctrlObjs.forEach((c) => { if (part.surfaces[c.strip]) part.surfaces[c.strip].ctrlObj = c.obj; });
      if (d.engine) {
        const e = d.engine;
        part.engine = { ...e, pos: info.center.clone().applyMatrix4(m), dir: new THREE.Vector3(0, 0, -1).transformDirection(m), spool: 0, rpm: 0, thrustNow: 0,
          burn: e.burn || 0, burning: false, ab: 0, prop: obj.userData.prop, fan: obj.userData.fan, flame: obj.userData.flame, flameCore: obj.userData.flameCore, spinDir: p.mirror ? -1 : 1, angle: 0, smokeT: 0 };
      }
      if (d.gear) {
        const gi = d.gear;
        const wheels = [];
        if (gi.float) for (const dz of [-gi.flen * 0.32, gi.flen * 0.32, 0]) wheels.push({ top: new THREE.Vector3(0, 0, dz).applyMatrix4(m), dir: new THREE.Vector3(0, -1, 0).transformDirection(m), len: 1.0, r: 0.3, steer: false, brake: false, float: true, comp: 0, contact: false });
        else wheels.push({ top: new THREE.Vector3(0, 0, 0).applyMatrix4(m), dir: new THREE.Vector3(0, -1, 0).transformDirection(m), len: gi.len, r: gi.r, steer: gi.steer, brake: gi.brake, comp: 0, contact: false, spin: 0 });
        part.gear = { ...gi, wheels, strut: obj.userData.strut, wheelObj: obj.userData.wheels };
      }
      if (d.smoke) part.smoke = { pos: new THREE.Vector3(0, 0, info.box.max.z).applyMatrix4(m), color: new THREE.Color(p.color) };
      if (d.light) {
        part.light = { type: d.light, pos: info.center.clone().applyMatrix4(m), bulb: obj.userData.bulb };
        if (d.light === 'nav' && part.light.bulb) {
          const x = part.light.pos.x; part.light.color = x < -0.5 ? 0xff2020 : x > 0.5 ? 0x20ff40 : 0xffffff;
          part.light.bulb.material.color.setHex(part.light.color);
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
      const sz = info.size;
      if (!d.wing) {
        const cd = d.cat === 'gear' ? [0.6, 0.6, 0.7] : d.cat === 'fuselage' || d.cat === 'cockpit' ? [0.5, 0.6, 0.06] : [0.5, 0.5, 0.18];
        const ax = sz.y * sz.z * 0.75, ay = sz.x * sz.z * 0.75, az = sz.x * sz.y * 0.785;
        // rotate area box into body frame roughly (use abs of rotation matrix)
        const e = m.elements;
        const A = [ax * cd[0], ay * cd[1], az * cd[2]];
        part.dragA = new THREE.Vector3(
          Math.abs(e[0]) * A[0] + Math.abs(e[4]) * A[1] + Math.abs(e[8]) * A[2],
          Math.abs(e[1]) * A[0] + Math.abs(e[5]) * A[1] + Math.abs(e[9]) * A[2],
          Math.abs(e[2]) * A[0] + Math.abs(e[6]) * A[1] + Math.abs(e[10]) * A[2]);
      }
      this.parts.push(part);
    });
    this.hasEngine = this.parts.some((p) => p.engine);
    this.hasRetract = this.parts.some((p) => p.gear?.retract);
    this.hasSmoke = this.parts.some((p) => p.smoke);
    this.hasAB = this.parts.some((p) => p.engine?.ab);
    this.updateMass(true);
    this.initialMass = this.mass;
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
      const s = p.info.size, mm = p.mass;
      // local box inertia, rotated approximately with abs rotation
      const ix = (mm / 12) * (s.y * s.y + s.z * s.z), iy = (mm / 12) * (s.x * s.x + s.z * s.z), iz = (mm / 12) * (s.x * s.x + s.y * s.y);
      const e = p.m.elements;
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
      const g = env.groundAt(pos.x, pos.z);
      this.x.set(pos.x, g.h - minY + 0.03, pos.z);
      this.gearDown = true; this.gearT = 1;
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
    const n = Math.max(1, Math.ceil(dtFrame / (1 / 240)));
    const dt = dtFrame / n;
    const v0 = this.v.clone();
    for (let i = 0; i < n; i++) this.substep(dt, env);
    if (dtFrame > 0) { const acc = this.v.clone().sub(v0).divideScalar(dtFrame); this.gSmooth = lerp(this.gSmooth ?? 1, (acc.dot(this.up) + G * this.up.y) / G, Math.min(1, dtFrame * 8)); this.g = this.gSmooth; }
    this.time += dtFrame; this.stats.time += dtFrame;
    this.updateVisuals(dtFrame, env);
  }

  substep(dt, env) {
    const R = this.R, q = this.q, mass = this.mass;
    _qi.copy(q).invert();
    const alt = this.x.y;
    const rho = airDensity(alt);
    const wind = env.windAt(this.x);
    const vAirB = _v.copy(this.v).sub(wind).applyQuaternion(_qi).clone();
    const V = vAirB.length();
    this.airspeed = V;
    const F = new THREE.Vector3(), T = new THREE.Vector3(), Taero = new THREE.Vector3();
    const ctl = this.ctl;
    const flapDefl = [0, 0.18, 0.35, 0.6][this.flaps];
    // automatic pitch trim (like a fly-by-wire autotrim): holds attitude when the stick is centred
    if (R.aeroTorque > 0) {
      if (this.onGround || V < 12) this.trim *= 1 - Math.min(1, dt * 0.5);
      else if (Math.abs(ctl.pitch) < 0.08) this.trim = clamp(this.trim - this.w.x * dt * 1.2, -0.7, 0.7);
    }
    const pitchCmd = clamp(ctl.pitch + (R.aeroTorque > 0 ? this.trim : 0), -1, 1);
    const maxDefl = 0.38;
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
        const V2 = vp.lengthSq(); if (V2 < 0.5) { s.load = 0; continue; }
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
        let cd = 0.012 + (cl * cl) / (Math.PI * 0.8 * s.ar) + 1.2 * Math.sin(a) ** 2 * (aeAbs > a0 ? 1 : 0.3) + Math.abs(dFlap) * 0.08;
        const qd = 0.5 * rho * V2 * s.area;
        const vh = _v2.copy(vp).divideScalar(Vs);
        ld.copy(s.n).addScaledVector(vh, -s.n.dot(vh)).normalize();
        const L = qd * cl * liftScale;
        Fs.copy(ld).multiplyScalar(L).addScaledVector(vh, -qd * cd * R.dragMult);
        s.load = L; partLift += L;
        F.add(Fs); Taero.add(_v3.copy(r).cross(Fs));
        if (Math.abs(s.n.y) > 0.6 && s.role !== 'ctrl') maxAlpha = Math.max(maxAlpha, aeAbs * (Math.abs(a) < 1.5 ? 1 : 0));
        totalLift += L * Math.abs(s.n.y);
      }
      p.lift = partLift;
      // body drag
      if (p.dragA) {
        r.copy(p.center).sub(this.com);
        vp.copy(this.w).cross(r).add(vAirB);
        const k = -0.5 * rho * R.dragMult;
        let A = p.dragA;
        const retracted = p.gear && p.gear.retract && this.gearT < 0.05;
        const fx = k * A.x * vp.x * Math.abs(vp.x), fy = k * A.y * vp.y * Math.abs(vp.y), fz = k * A.z * vp.z * Math.abs(vp.z) * (retracted ? 0.05 : 1);
        Fs.set(fx, fy, fz);
        F.add(Fs); Taero.add(_v3.copy(r).cross(Fs));
      }
    }
    this.alpha = maxAlpha;
    this.stalled = R.stallSharp > 0 && maxAlpha > 0.29 && V > 8 && !this.onGround;
    // ---- engines ----
    const fwdSpeed = -vAirB.z;
    for (const p of this.parts) {
      const e = p.engine; if (!e || !p.alive) continue;
      let target = ctl.throttle;
      if (e.type === 'rocket') {
        if (!e.burning && ctl.throttle > 0.5 && e.burn > 0) { e.burning = true; this.emit('msg', { text: 'Rocket ignition!' }); this.emit('rocket', {}); }
        target = e.burning ? 1 : 0;
        if (e.burning) { e.burn -= dt; if (e.burn <= 0) { e.burning = false; this.emit('msg', { text: 'Rocket burnt out' }); } }
      }
      const spool = e.type === 'jet' ? e.spool || 3 : e.type === 'rocket' ? 0.15 : e.sound === 'electric' ? 0.1 : e.spool || 0.5;
      e.spoolT = (e.spoolT || 0) + (target - (e.spoolT || 0)) * Math.min(1, dt / (spool * 0.5));
      const dmgF = 1 - clamp(p.dmg / p.hp, 0, 1) * 0.7;
      let thrust = 0;
      if (e.type === 'prop') thrust = e.thrust * e.spoolT * Math.max(0, 1 - (Math.max(0, fwdSpeed) / e.vmax) ** 1.6);
      else if (e.type === 'jet') {
        thrust = e.thrust * (0.04 + 0.96 * e.spoolT) * (1 + 0.25 * Math.min(1, fwdSpeed / 300));
        e.abOn = !!(PARTS[p.p.id].engine.ab) && ctl.throttle > 0.95 && e.spoolT > 0.9;
        if (e.abOn) thrust += (PARTS[p.p.id].engine.ab - e.thrust);
      } else if (e.type === 'rocket') thrust = e.burning ? e.thrust : 0;
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
    // ---- gravity ----
    F.add(_v2.set(0, -G * mass, 0).applyQuaternion(_qi));
    // ---- arcade/pilot assistance ----
    T.addScaledVector(Taero, R.aeroTorque);
    if (R.assist > 0) {
      const sf = clamp((V - 6) / 22, 0, 1);
      const des = new THREE.Vector3(ctl.pitch * 1.3, -ctl.yaw * 0.7, -ctl.roll * 2.4);
      const beta = Math.atan2(vAirB.x, Math.max(1, -vAirB.z));
      des.y += -beta * 3 * R.assist;
      const right = _v2.set(1, 0, 0).applyQuaternion(q);
      const bank = Math.asin(clamp(right.y, -1, 1));
      const fwd = _v3.set(0, 0, -1).applyQuaternion(q);
      const upside = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y < 0;
      if (Math.abs(ctl.roll) < 0.1 && !upside) des.z += -bank * 1.5 * R.autoLevel;
      // coordinated turn: yaw with bank
      const k = 7 * R.assist * sf;
      const err = des.sub(this.w).multiplyScalar(k);
      if (!this.ctrlAuthority.yaw) err.y *= 0.3;
      T.add(err.applyMatrix3(this.I));
      // kill sideslip
      if (R.sideslipKill > 0) F.x -= vAirB.x * mass * R.sideslipKill * sf;
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
    if (this.w.lengthSq() > 400) this.w.setLength(20);
    // ---- ground contact ----
    this.wW.copy(this.w).applyQuaternion(q);
    this.invIW.copy(this.Iinv);
    const Rm = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    this.invIW.multiplyMatrices(Rm, this.Iinv).multiply(Rm.clone().transpose());
    this.invMass = 1 / mass;
    this.contacts(dt, env);
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
        if (Math.abs(p.lift) > strength) { this.emit('msg', { text: `Over-G! ${p.name} snapped!`, bad: true }); this.breakPart(p.i, 'overload'); }
      }
    }
  }

  contacts(dt, env) {
    const lowest = this.x.y - this.radius;
    if (lowest > env.maxGround(this.x.x, this.x.z) + 2) { this.onGround = false; for (const p of this.parts) if (p.gear) for (const w of p.gear.wheels) { w.contact = false; w.comp = 0; } return; }
    const q = this.q;
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    const fwdB = new THREE.Vector3(0, 0, -1);
    let anyWheel = false, maxPen = 0;
    const R = this.R;
    // count wheels for stiffness
    let nW = 0; for (const p of this.parts) if (p.alive && p.gear && (this.gearT > 0.95 || !p.gear.retract)) nW += p.gear.wheels.length;
    const kBase = (this.mass * G) / (0.09 * Math.max(2, nW));
    const cBase = 2 * Math.sqrt(kBase * this.mass / Math.max(2, nW)) * 0.6;
    const top = new THREE.Vector3(), pt = new THREE.Vector3(), rr = new THREE.Vector3(), vpt = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.alive || !p.gear) continue;
      const usable = !p.gear.retract || this.gearT > 0.95;
      for (const w of p.gear.wheels) {
        w.contact = false;
        if (!usable) continue;
        this.worldPoint(w.top, top);
        const g = env.groundAt(top.x, top.z);
        const L = w.len + w.r;
        down.copy(w.dir).applyQuaternion(q);
        const cosd = Math.max(0.35, -down.dot(g.n));
        const d = (top.y - g.h) / cosd;
        const comp = L - d;
        w.comp = clamp(comp, 0, w.len * 0.6);
        if (comp <= 0) continue;
        w.contact = true; anyWheel = true;
        pt.copy(top).addScaledVector(down, d);
        rr.copy(pt).sub(this.x);
        vpt.copy(this.wW).cross(rr).add(this.v);
        const vn = vpt.dot(g.n);
        const water = g.type === 'water';
        const limit = (p.gear.limit || 4) * R.gearMult * (water && !w.float ? 0.5 : 1);
        if (-vn > limit && !w.float) { this.emit('msg', { text: `Hard landing! ${p.name} collapsed`, bad: true }); this.emit('impact', { pos: pt.clone(), speed: -vn, surf: g.type }); this.breakPart(p.i, 'gear'); break; }
        if (-vn > 1.2 && !w.wasContact) this.emit('touch', { pos: pt.clone(), speed: -vn, water, float: w.float });
        let N = kBase * Math.min(comp, w.len * 0.7) - cBase * vn;
        if (comp > w.len * 0.7) N += kBase * 20 * (comp - w.len * 0.7);
        N = Math.max(0, N);
        if (w.float && !water) N *= 1; // skid on ground
        // directions
        const fwdW = fwdB.clone();
        if (w.steer) fwdW.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.ctl.yaw * 0.55 * clamp(1 - this.airspeed / 45, 0.15, 1));
        fwdW.applyQuaternion(q);
        fwdW.addScaledVector(g.n, -fwdW.dot(g.n)).normalize();
        const latW = new THREE.Vector3().crossVectors(g.n, fwdW).normalize();
        const vf = vpt.dot(fwdW), vl = vpt.dot(latW);
        let muRoll = 0.025, muLat = 0.9;
        if (g.type === 'grass') muRoll = 0.05;
        if (w.brake) muRoll += this.brake * 0.65;
        if (w.float) { muRoll = water ? 0.03 + Math.min(0.12, Math.abs(vf) * 0.004) : 0.35; muLat = water ? 0.35 : 0.5; }
        else if (water) { muRoll = 0.6; muLat = 0.6; }
        const DBG = globalThis.__dbg || {};
        const Ff = -clamp(vf / 0.4, -1, 1) * muRoll * N * (DBG.roll ?? 1);
        const Fl = -clamp(vl / 0.25, -1, 1) * muLat * N * (DBG.lat ?? 1);
        const Fw = g.n.clone().multiplyScalar(N).addScaledVector(fwdW, Ff).addScaledVector(latW, Fl);
        // apply as impulse
        applyImpulse(this, rr, Fw.multiplyScalar(dt));
        w.spin = (w.spin || 0) + (vf / Math.max(0.1, w.r)) * dt;
        w.vf = vf; w.slip = Math.abs(vl);
        if (water && Math.abs(vf) > 3 && Math.random() < 0.3) this.emit('spray', { pos: pt.clone(), speed: Math.abs(vf) });
        else if (!water && g.type !== 'runway' && Math.abs(vf) > 8 && Math.random() < 0.06) this.emit('dust', { pos: pt.clone(), speed: Math.abs(vf), surf: g.type });
      }
      for (const w of p.gear.wheels) w.wasContact = w.contact;
    }
    // hull points
    const hp = new THREE.Vector3();
    const hits = new Map(), slide = new Map(); let inWater = false;
    for (const p of this.parts) {
      if (!p.alive) continue;
      for (const h of p.hull) {
        this.worldPoint(h, hp);
        if (hp.y > this.x.y + 50) continue;
        const g = env.groundAt(hp.x, hp.z);
        if (hp.y > g.h) continue;
        const water = g.type === 'water';
        const res = contactPoint(this, hp, g, { e: water ? 0 : 0.12, mu: water ? 0.12 : g.type === 'runway' ? 0.4 : 0.55 });
        if (!res) continue;
        maxPen = Math.max(maxPen, res.pen);
        const impact = -res.vn;
        const thr = (water ? 9 : 4.5) * R.crashMult;
        if (impact > thr * 0.6 && (!hits.has(p) || hits.get(p).impact < impact)) hits.set(p, { impact, pt: hp.clone(), n: g.n.clone(), thr, surf: g.type });
        if (res.vt > 4 && !water) {
          slide.set(p, Math.max(slide.get(p) || 0, res.vt));
          if (Math.random() < 0.08) this.emit('scrape', { pos: hp.clone(), speed: res.vt, surf: g.type });
        }
        if (water && (res.vt > 3 || impact > 2) && Math.random() < 0.15) this.emit('spray', { pos: hp.clone(), speed: Math.max(res.vt, impact) });
        if (water) inWater = true;
      }
    }
    for (const [p, vt] of slide) this.damage(p, (vt * dt * 2.5) / R.crashMult / (p.i === 0 ? 3 : 1), null);
    if (inWater) { this.v.multiplyScalar(1 - 0.9 * dt); this.wW.multiplyScalar(1 - 1.5 * dt); }
    for (const [p, h] of hits) { // one damage event per part per step (not per contact point)
      this.deform(p, h.pt, h.n, Math.min(0.5, (h.impact - h.thr * 0.4) * 0.025));
      if (h.impact > h.thr) {
        const toughness = p.i === 0 ? 3 : 1; // the core body is extra strong so crashes come apart progressively
        this.damage(p, ((h.impact - h.thr) ** 2 * 22) / toughness, h.pt);
        this.emit('impact', { pos: h.pt, speed: h.impact, surf: h.surf });
      }
    }
    if (maxPen > 0) this.x.y += Math.min(maxPen, 0.5) * 0.3;
    const wasGround = this.onGround;
    this.onGround = anyWheel || maxPen > 0;
    if (anyWheel && !wasGround && this.airTimeNow > 3) {
      const vs = -this.v.y;
      this.stats.landings++;
      if (this.stats.bestLanding === null || vs < this.stats.bestLanding) this.stats.bestLanding = vs;
      this.emit('landing', { vs, onWheels: true });
    }
    if (this.onGround) this.airTimeNow = 0;
  }

  damage(p, amount, at) {
    if (!p.alive) return;
    p.dmg += amount;
    if (!p.scorched && p.dmg > p.hp * 0.55) {
      p.scorched = true;
      p.obj.traverse((o) => { if (o.isMesh && !o.material.transparent && o.material.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.45); if (o.material.roughness !== undefined) o.material.roughness = 0.8; if (o.material.clearcoat) o.material.clearcoat = 0; } });
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
    this.emit('debris', { debris: deb, why, names, pos: c.clone(), speed: v.length() });
    if (why !== 'wreck') this.emit('msg', { text: `${names[0]} ${why === 'gear' ? 'snapped off' : 'broke off'}!`, bad: true });
    if (this.alive().length === 0) { this.dead = true; return; }
    const before = this.initialMass;
    this.updateMass();
    if (this.mass < before * 0.35 || !this.parts[0].alive) { this.wrecked = true; }
    this.hasEngine = this.parts.some((p) => p.alive && p.engine);
  }

  updateVisuals(dt, env) {
    if (this.dead) return;
    this.syncVisual();
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
          const rps = e.type === 'prop' ? (e.rpm / 60) : 0;
          e.angle += rps * Math.PI * 2 * dt * e.spinDir * (e.sound === 'electric' ? 0.3 : 1);
          e.prop.userData.spinner.rotation.z = e.angle;
          const fast = clamp((e.rpm - 500) / 1200, 0, 1);
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
        if (p.gear.retract && p.gear.strut) p.gear.strut.rotation.x = (1 - this.gearT) * -Math.PI / 2 * (p.d.gear.steer ? -1 : 1);
        const w = p.gear.wheels[0];
        if (p.gear.wheelObj && !w.float) {
          p.gear.wheelObj.position.y = -w.len + w.comp;
          p.gear.wheelObj.children.forEach((c) => { if (!p.d.gear.wheels) c.rotation.x = -(w.spin || 0); });
          if (w.steer) p.gear.wheelObj.rotation.y = -this.ctl.yaw * 0.55 * clamp(1 - this.airspeed / 45, 0.15, 1);
        }
      }
      if (p.light?.bulb && p.light.type === 'nav') {
        const strobe = p.light.color === 0xffffff;
        const on = strobe ? (this.time % 1.2) < 0.08 : true;
        p.light.bulb.visible = on;
      }
    }
    if (this.landingLight) this.landingLight.intensity = env.night ? 4000 : 0;
    if (this.normalsDirty) {
      this.normalsDirty = false;
      this.root.traverse((o) => { if (o.isMesh && o.userData.dirtyNormals) { o.geometry.computeVertexNormals(); o.userData.dirtyNormals = false; } });
    }
  }

  setCockpitView(on) {
    const ck = this.parts.find((p) => p.alive && p.eye);
    if (ck) ck.obj.visible = !on;
  }
  // things the camera / audio / HUD want
  get forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.q); }
  get up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.q); }
  eyePoint() {
    const ck = this.parts.find((p) => p.alive && p.eye);
    if (ck) return ck.eye.clone();
    const f = this.parts[0]; const b = f.info.box;
    return new THREE.Vector3(0, b.max.y * 0.6, b.min.z * 0.45).applyMatrix4(f.m);
  }
}
