// Boats: floating, planing and steering for any vehicle with a boat hull (boatParts.js). aircraft.js calls in here only
// for a vehicle detectBoat() says is a boat (ac.isBoat); nothing here runs for planes, cars, bikes or seaplanes.
//
// The hull floats by its real shape. Each hull part is measured once (hullColumns): vertical rays through its hull
// meshes give columns of solid hull (bottom, top, plan area, the bottom's normal). Every substep each column that dips
// into the water is pushed up by the weight of the water it displaces (Archimedes), at the middle of its wet part, so a
// heeled or trimmed hull rights itself the way its shape says, and a hull loaded at one end sits down at that end.
// Columns over land do nothing: on a beach or a trailer a boat just sits on its hull points (aircraft.contacts).
//
// Moving through the water:
//   - planing: the bottom presses on the water it moves into, ½ρ·cp·(v·n)·|v| on each wet panel. At speed that lifts
//     the hull until only its after part is wet: up on the plane. Below planing speed the hull drags its own bow wave
//     (a resistance hump, worst at a Froude number of ~0.5) and its stern sinks into the trough: the bow rises, then
//     levels out as it gets over the hump. Displacement hulls (planing 0) meet a wall at hull speed instead.
//   - drag: skin friction on the wet bottom, the wave hump, and a keel that stops it sliding sideways.
//   - waves: a gentle swell (waveAt) moves the water every column sees: the boat bobs and pitches over it.
//   - the motors (engine.type 'marine') push only while their propeller / jet intake is under water (it fades out as
//     it breaks the surface). Outboards and jets swivel their thrust to steer; a propeller and rudder steers with the
//     rudder in the flow (the propeller's wash keeps it working at low speed). Brake = reverse thrust.
//   - Arcade / Pilot help: the steering sets a turn rate, the boat leans into its turns (a little in Sim too, as a V
//     hull does), the bow can't rear past ~13°, and a boat stuck upside down is set upright after 2 s.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { clamp } from './noise.js';

const G = 9.81, RHO = 1000;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const bump = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _r = new THREE.Vector3(), _vp = new THREE.Vector3(), _f = new THREE.Vector3(), _n = new THREE.Vector3();
const _xb = new THREE.Vector3(), _yb = new THREE.Vector3(), _zb = new THREE.Vector3(), _qi = new THREE.Quaternion(), _a = new THREE.Vector3(), _m3 = new THREE.Matrix3();
const NX = 8, NZ = 15; // (an even number across: no column right on a V hull's keel line) // columns across and along each hull part

// The swell (m) at (x, z) at time t: two long, slow wave trains. amp: the location's sea state (env.waveAmp).
export function waveAt(x, z, t, amp = 0.08) {
  if (!amp) return 0;
  return amp * (0.62 * Math.sin(0.19 * x + 0.12 * z - 1.25 * t) + 0.38 * Math.sin(-0.09 * x + 0.23 * z - 1.6 * t + 1.3));
}

// ---------- measuring a hull ----------
const colCache = new Map();
// Columns of a hull part in its own frame: [{ x, z, y0, y1 (one solid interval), dx, dz, n (outward normal of the
// bottom, for the lowest interval only) }]
export function hullColumns(id) {
  if (colCache.has(id)) return colCache.get(id);
  const d = PARTS[id], obj = d.build(d.color, { detail: 0 }); obj.updateMatrixWorld(true);
  const meshes = []; obj.traverse((m) => { if (m.isMesh && m.userData.hull) meshes.push(m); });
  const box = new THREE.Box3(); for (const m of meshes) box.expandByObject(m);
  const out = [];
  if (!meshes.length || box.isEmpty()) { colCache.set(id, out); return out; }
  const sides = new Map(); for (const m of meshes) { sides.set(m, m.material.side); m.material = m.material.clone(); m.material.side = THREE.DoubleSide; }
  const rc = new THREE.Raycaster(), dir = new THREE.Vector3(0, -1, 0), size = box.getSize(new THREE.Vector3()), dx = size.x / NX, dz = size.z / NZ;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = box.min.x + (i + 0.5) * dx, z = box.min.z + (j + 0.5) * dz;
    rc.set(new THREE.Vector3(x, box.max.y + 1, z), dir); rc.far = size.y + 2;
    const hits = rc.intersectObjects(meshes, false).sort((a, b) => b.point.y - a.point.y), ys = [];
    let low = null;
    for (const h of hits) { if (!ys.length || ys.at(-1) - h.point.y > 2e-3) ys.push(h.point.y); low = h; }
    if (ys.length < 2) continue;
    const iv = []; if (ys.length % 2) iv.push([ys.at(-1), ys[0]]); else for (let k = 0; k < ys.length; k += 2) iv.push([ys[k + 1], ys[k]]);
    const n = low.face.normal.clone().transformDirection(low.object.matrixWorld); if (n.y > 0) n.negate();
    iv.sort((a, b) => a[0] - b[0]);
    iv.forEach(([y0, y1], k) => { if (y1 - y0 > 0.01) out.push({ x, z, y0, y1, dx, dz, n: k === 0 ? n.toArray() : null }); });
  }
  for (const m of meshes) { m.material.dispose(); }
  obj.traverse((m) => m.geometry?.dispose?.());
  colCache.set(id, out); return out;
}

// The columns of a whole design (or of an Aircraft's parts) in the design frame. parts: [{ id, m: Matrix4, ref }]
function designColumns(parts) {
  const cols = [], p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), ex = new THREE.Vector3(), ez = new THREE.Vector3();
  for (const { id, m, ref } of parts) {
    const H = PARTS[id]?.boatHull; if (!H) continue;
    _m3.getNormalMatrix(m); const L3 = new THREE.Matrix3().setFromMatrix4(m);
    let across = 1; { const cs = hullColumns(id); across = Math.max(1, new Set(cs.map((c) => c.x.toFixed(4))).size); }
    for (const c of hullColumns(id)) {
      p0.set(c.x, c.y0, c.z).applyMatrix4(m); p1.set(c.x, c.y1, c.z).applyMatrix4(m);
      ex.set(c.dx, 0, 0).applyMatrix3(L3); ez.set(0, 0, c.dz).applyMatrix3(L3);
      const dA = ex.clone().cross(ez).length(), axis = p1.clone().sub(p0), h = axis.length();
      if (h < 1e-3 || dA < 1e-5) continue;
      cols.push({ b: p0.clone(), a: axis, h, dA, n: c.n ? new THREE.Vector3(...c.n).applyMatrix3(_m3).normalize() : null, side: ez.length() / across, ref, H, wl: null, wet: 0, sub: 0 });
    }
  }
  return cols;
}

// Level, at rest: the height of the hull's lowest point above the water when it floats (negative: how deep the keel
// sits), the waterline's plan, and whether it floats at all. design-frame columns, mass (kg).
function floatLevel(cols, mass) {
  if (!cols.length) return null;
  let lo = Infinity, hi = -Infinity, cap = 0; for (const c of cols) { lo = Math.min(lo, c.b.y, c.b.y + c.a.y); hi = Math.max(hi, c.b.y, c.b.y + c.a.y); cap += c.dA * c.h; }
  const disp = (wl) => { let v = 0; for (const c of cols) { const y0 = Math.min(c.b.y, c.b.y + c.a.y), y1 = Math.max(c.b.y, c.b.y + c.a.y); v += c.dA * c.h * clamp((wl - y0) / Math.max(1e-4, y1 - y0), 0, 1); } return v; };
  const need = mass / RHO; if (need >= cap) return { wl: hi, sinks: true, cap, lo, hi };
  let a = lo, b = hi; for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (disp(m) < need) a = m; else b = m; }
  return { wl: (a + b) / 2, sinks: false, cap, lo, hi };
}

// ---------- design analysis (design.js analyze) ----------
// For a design with a boat hull: { cols, level (design-frame waterline height, at rest), sinks, motors: [{ id, wet: is
// the propeller / intake under water at rest }] }, or null.
export function boatLayout(design, mass, partMatrix) {
  const parts = [], m = new THREE.Matrix4();
  for (const p of design.parts) if (PARTS[p.id]) parts.push({ id: p.id, m: partMatrix(p, m).clone(), ref: p });
  const cols = designColumns(parts); if (!cols.length) return null;
  const fl = floatLevel(cols, mass), motors = [];
  for (const { id, m: mm } of parts) { const e = PARTS[id].engine; if (e?.type !== 'marine') continue; const at = new THREE.Vector3(...e.propAt).applyMatrix4(mm); motors.push({ id, wet: !!fl && at.y < fl.wl - 0.05 }); }
  return { cols: cols.length, level: fl?.wl ?? 0, sinks: !!fl?.sinks, motors };
}

// ---------- the flight model's side ----------
// After the parts are built (aircraft.js constructor). The boat's state, or null for anything else.
export function detectBoat(ac) {
  if (ac.isHeli || !ac.parts.some((p) => p.d.boatHull)) return null;
  const cols = designColumns(ac.parts.filter((p) => p.d.boatHull).map((p) => ({ id: p.p.id, m: p.m, ref: p })));
  if (!cols.length) return null;
  let zMin = Infinity, zMax = -Infinity, Awp = 0, planing = 0, turn = 0, bank = 0;
  for (const c of cols) { zMin = Math.min(zMin, c.b.z); zMax = Math.max(zMax, c.b.z); if (c.n) { Awp += c.dA; planing += c.H.planing * c.dA; turn += c.H.turn * c.dA; bank += c.H.bank * c.dA; } }
  const motors = [];
  for (const p of ac.parts) {
    const e = p.d.engine; if (e?.type !== 'marine') continue;
    const P = (v) => (v ? new THREE.Vector3(...v).applyMatrix4(p.m) : null);
    motors.push({ part: p, e: p.engine, def: e, propAt: P(e.propAt), thrustAt: P(e.thrustAt), rudderAt: P(e.rudderAt), fwd: new THREE.Vector3(0, 0, -1).transformDirection(p.m), steer: 0, bite: 0 });
  }
  const L = Math.max(1, zMax - zMin);
  return {
    cols, motors, L, Awp, planing: Awp ? planing / Awp : 1, turn: Awp ? turn / Awp : 0.6, bank: Awp ? bank / Awp : 0.3,
    cH: 2 * 0.45 * Math.sqrt(RHO * G * ac.mass / Math.max(0.5, Awp)), // heave damping per m² of wet bottom (ζ ≈ 0.45)
    steer: 0, wet: 0, flipT: 0, t: 0, fn: 0, speed: 0, trim: 0, bow: [null, null], stern: new THREE.Vector3(), sternWet: false, waveAmp: 0.08,
  };
}

// Every frame, before the substeps: which columns are over water, and how high it is there (the terrain query is too
// dear for every column every substep; a boat moves a fraction of a column in a frame).
export function boatFrame(ac, env, dt) {
  const b = ac.boat; b.t += dt; b.waveAmp = env.waveAmp ?? 0.08;
  for (const c of b.cols) {
    if (!c.ref.alive) { c.wl = null; continue; }
    ac.worldPoint(c.b, _p); c.wx = _p.x; c.wz = _p.z;
    const g = env.groundAt(_p.x, _p.z, _p.y);
    c.wl = g.type === 'water' ? g.h : null;
  }
}

// Every substep, after gravity (body-frame F and T, as aircraft.substep has them): the water's push, drag, the
// motors and the steering.
export function boatForces(ac, F, T, ctl, dt, env) {
  const b = ac.boat, q = ac.q, R = ac.R, mass = ac.mass, x = ac.x, v = ac.v, wW = ac.wW, t = b.t;
  _qi.copy(q).invert();
  const Fw = _f.set(0, 0, 0), Tw = _t.set(0, 0, 0);
  _xb.set(1, 0, 0).applyQuaternion(q); _yb.set(0, 1, 0).applyQuaternion(q); _zb.set(0, 0, -1).applyQuaternion(q); // right, up, forward
  const vb = _a.copy(v).applyQuaternion(_qi), u = -vb.z; // forward speed through the water
  const vh = Math.hypot(v.x, v.z), Fn = vh / Math.sqrt(G * b.L);
  let wetA = 0, wetBottom = 0, bowS = null, bowP = null;
  const Tt = new THREE.Vector3(); // the motors' twist (world)
  const add = (f, at) => { Fw.add(f); _r.copy(at).sub(x); Tw.add(_r.cross(f)); };
  for (const c of b.cols) {
    c.wet = 0; c.sub = 0;
    if (c.wl == null) continue;
    const pb = ac.worldPoint(c.b, _p), ax = _n.copy(c.a).applyQuaternion(q), y0 = pb.y, y1 = pb.y + ax.y;
    const wl = c.wl + waveAt(pb.x, pb.z, t, b.waveAmp), lo = Math.min(y0, y1), span = Math.abs(y1 - y0);
    if (wl <= lo) continue;
    const frac = span > 1e-3 ? clamp((wl - lo) / span, 0, 1) : 1, sub = frac * c.h;
    c.sub = sub; c.wet = Math.min(1, sub / 0.08);
    // centre of the wet part
    const cb = (y0 <= y1 ? pb : pb.add(ax)).clone().addScaledVector(ax, (y0 <= y1 ? 1 : -1) * frac * 0.5);
    const r = _r.copy(cb).sub(x), vp = _vp.copy(wW).cross(r).add(v);
    const vol = c.dA * sub, f = new THREE.Vector3(0, RHO * G * vol, 0);
    f.y -= b.cH * c.dA * c.wet * vp.y; // heave damping
    if (c.n) { // the bottom: planing pressure and skin friction
      wetA += c.dA * c.wet; wetBottom += c.dA;
      const n = new THREE.Vector3().copy(c.n).applyQuaternion(q), un = vp.dot(n), area = c.dA / Math.max(0.3, Math.abs(c.n.y)), V = vp.length();
      if (un > 0) f.addScaledVector(n, -0.5 * RHO * c.H.cp * un * V * area * c.wet);
      const vz = vp.dot(_zb); f.addScaledVector(_zb, -0.5 * RHO * 0.0032 * area * c.wet * vz * Math.abs(vz));
      // where the bow wave climbs the hull: the most forward wet bottom column each side (boatFX: spray)
      const zf = c.b.z; if (c.b.x >= 0) { if (!bowS || zf < bowS.z) bowS = { z: zf, c, wl }; } else if (!bowP || zf < bowP.z) bowP = { z: zf, c, wl };
    }
    // the keel: it won't slide sideways
    const vl = vp.dot(_xb), As = sub * c.side * c.H.lat;
    add(f, cb);
    // (the keel's grip acts at the height of the centre of mass: how much it leans is the banking's job below)
    add(new THREE.Vector3().copy(_xb).multiplyScalar(-(0.5 * RHO * As * vl * Math.abs(vl) + RHO * As * 1.5 * vl)), cb.setY(x.y));
  }
  const wet = b.wet = b.Awp ? wetA / b.Awp : 0;
  b.fn = Fn; b.speed = u; ac.groundSpeed = u;
  // the hull's own bow wave: a resistance hump (planing hulls) or a wall at hull speed (displacement hulls), and a
  // little linear drag so it drifts to a stop; the stern squats into the trough over the hump: bow up
  if (wet > 0.01) {
    const P = b.planing, hump = P * 0.13 * bump(Fn, 0.5, 0.22) + (1 - P) * 0.3 * smooth(0.22, 0.62, Fn) * (Fn / 0.5) ** 2;
    if (vh > 0.05) { const k = mass * G * hump * Math.min(1, wet * 3) / vh; Fw.x -= v.x * k; Fw.z -= v.z * k; }
    Fw.x -= v.x * mass * 0.06 * wet; Fw.z -= v.z * mass * 0.06 * wet;
    Tw.addScaledVector(_xb, mass * G * b.L * 0.12 * P * bump(Fn, 0.6, 0.25) * Math.min(1, wet * 3) * Math.sign(u || 1));
  }
  // ---- the motors ----
  const s = clamp(ctl.yaw + ctl.roll, -1, 1), gas = ctl.throttle || 0, rev = ctl.rev || 0;
  b.steer += (s - b.steer) * Math.min(1, dt * 6);
  ac.reversing = rev > 0.02 && rev >= gas && u < 0.8;
  const cmd = rev > 0.02 && rev >= gas ? -rev * 0.55 : gas;
  for (const mo of b.motors) {
    const p = mo.part, e = mo.e; if (!p.alive) { mo.bite = 0; continue; }
    e.spoolT = (e.spoolT || 0) + (Math.abs(cmd) - (e.spoolT || 0)) * Math.min(1, dt / 0.35);
    mo.steer = b.steer * mo.def.steer;
    const pa = ac.worldPoint(mo.propAt, new THREE.Vector3()), wl = waterAt(b, pa, t);
    mo.bite = wl == null ? 0 : smooth(-0.08, 0.3, wl - pa.y);
    const dmg = (1 - clamp(p.dmg / p.hp, 0, 1) * 0.7) * (p.dmg > p.hp * 0.75 ? 0.2 : 1);
    const fall = cmd >= 0 ? Math.max(0, 1 - (Math.max(0, u) / e.vmax) ** 2) : Math.max(0, 1 - (Math.max(0, -u) / 6) ** 2);
    const thrust = e.thrust * e.spoolT * Math.sign(cmd) * fall * mo.bite * dmg;
    e.thrustNow = Math.abs(thrust);
    e.bite = mo.bite; // (the engine sound: a propeller out of the water over-revs)
    e.rpm = e.idleRpm + (e.maxRpm - e.idleRpm) * Math.max(e.spoolT * (mo.bite > 0.3 ? 0.85 : 1), clamp(Math.abs(u) / e.vmax, 0, 1) * 0.7);
    const fwd = mo.fwd.clone();
    if (mo.def.kind === 'swivel') fwd.applyAxisAngle(_n.set(0, 1, 0), mo.steer);
    const fW = fwd.applyQuaternion(q).multiplyScalar(thrust);
    Fw.add(fW); _r.copy(ac.worldPoint(mo.thrustAt, new THREE.Vector3())).sub(x); Tt.add(_r.cross(fW)); // (its twist is limited below in Arcade / Pilot)
    if (mo.rudderAt && mo.bite > 0) { // the rudder, in the stream past the hull plus the propeller's wash
      const wash = Math.abs(thrust) / (RHO * 0.2), V2 = u * Math.abs(u) + wash;
      const fr = -0.5 * RHO * mo.def.rudderArea * V2 * 1.3 * Math.sin(mo.steer) * mo.bite;
      add(_n.copy(_xb).multiplyScalar(fr), ac.worldPoint(mo.rudderAt, new THREE.Vector3()));
    }
  }
  // into the body frame. Arcade / Pilot: a motor low on the transom can't flip the boat over backwards (a blow-over):
  // its nose-up twist is capped at what the hull's bow-down trim can take (Sim: all of it)
  const Tb = Tt.applyQuaternion(_qi); if (R.assist > 0) Tb.x = Math.min(Tb.x, ac.I.elements[0] * (2.5 - 1.5 * R.assist));
  F.add(Fw.applyQuaternion(_qi)); T.add(Tw.applyQuaternion(_qi)).add(Tb);
  // Arcade / Pilot: the bow never rears up past ~13°, in the water or leaping off a wave
  const pitch0 = Math.asin(clamp(_zb.y, -1, 1));
  if (R.assist > 0 && pitch0 > 0.22 && ac.up.y > 0) T.x -= ac.I.elements[0] * (25 * (pitch0 - 0.22) + 4 * Math.max(0, ac.w.x)) * R.assist;
  if (wet < 0.01) return;
  const I = ac.I.elements, w = ac.w, wk = Math.min(1, wet * 3);
  // the water damps rolling, pitching and spinning
  T.x -= I[0] * w.x * 1.2 * wk; T.y -= I[4] * w.y * 0.9 * wk; T.z -= I[8] * w.z * 1.0 * wk;
  // ---- help: turn rate, banking, a bow that won't rear up, no sliding (Arcade) ----
  const A = R.assist;
  const right = _xb, bankA = Math.asin(clamp(right.y, -1, 1)), pitch = Math.asin(clamp(_zb.y, -1, 1));
  if (A > 0) {
    const want = -s * b.turn * smooth(0.4, 4, Math.abs(u)) * (u < -0.3 ? -1 : 1);
    T.y += I[4] * 3.2 * A * wk * (want - w.y);
    if (pitch < -0.1) T.x += I[0] * 12 * (-0.1 - pitch) * A * wk;
    F.x -= vb.x * mass * 1.1 * A * wk;
  }
  const bk = A > 0 ? 0.5 + 0.5 * A : 0.3, want = clamp(Math.atan(Math.max(0, u) * w.y / G) * b.bank * 2, -0.45, 0.45);
  T.z += I[8] * (5 * (want - bankA) - 2.2 * w.z) * bk * wk;
  b.trim = pitch;
}
// water height at a world point from the nearest wet-able column (the cached terrain query) plus the swell
function waterAt(b, p, t) {
  let best = null, bd = Infinity;
  for (const c of b.cols) { if (c.wl == null) continue; const d = (c.wx - p.x) ** 2 + (c.wz - p.z) ** 2; if (d < bd) { bd = d; best = c; } }
  return best ? best.wl + waveAt(p.x, p.z, t, b.waveAmp) : null;
}

// After the substeps: Arcade and Pilot set a capsized boat back upright after 2 s (floating, facing the same way).
export function boatRecover(ac, dt, env) {
  const b = ac.boat;
  const stuck = ac.R.assist > 0 && b.wet > 0.02 && ac.up.y < 0.3 && ac.v.length() < 4;
  b.flipT = stuck ? b.flipT + dt : 0;
  if (b.flipT < 2) return;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ac.q); fwd.y = 0;
  ac.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-fwd.x, -fwd.z));
  ac.v.set(0, 0, 0); ac.w.set(0, 0, 0); ac.wW.set(0, 0, 0); b.flipT = 0;
  settleBoat(ac, env);
  ac.emit('msg', { text: 'Back the right way up!' });
}

// Float it level at its waterline where it is (spawning, righting). Leaves it alone if there is no water under it.
export function settleBoat(ac, env) {
  const b = ac.boat; ac.syncVisual?.();
  const q = ac.q;
  const level = [], P = new THREE.Vector3();
  let wl = null;
  for (const c of b.cols) {
    if (!c.ref.alive) continue;
    P.copy(c.b).sub(ac.com).applyQuaternion(q).add(ac.x);
    const g = env.groundAt(P.x, P.z); if (g.type !== 'water') continue;
    wl = wl == null ? g.h : Math.max(wl, g.h);
    const A = c.a.clone().applyQuaternion(q);
    level.push({ y0: P.y - ac.x.y, y1: P.y - ac.x.y + A.y, v: c.dA * c.h });
  }
  if (wl == null) return false;
  const disp = (y) => { let s = 0; for (const c of level) { const lo = Math.min(c.y0, c.y1) + y, hi = Math.max(c.y0, c.y1) + y; s += c.v * clamp((wl - lo) / Math.max(1e-4, hi - lo), 0, 1); } return s; };
  const need = ac.mass / RHO; let a = wl - 30, z = wl + 30;
  for (let k = 0; k < 50; k++) { const m = (a + z) / 2; if (disp(m) > need) a = m; else z = m; }
  ac.x.y = (a + z) / 2; ac.v.set(0, 0, 0); ac.w.set(0, 0, 0); ac.wW.set(0, 0, 0);
  for (const c of b.cols) { c.wl = null; } boatFrame(ac, env, 0);
  ac.syncVisual?.();
  return true;
}

// Visual: outboards, nozzles and rudders swing with the steering (aircraft.updateVisuals).
export function boatVisuals(ac) {
  for (const mo of ac.boat.motors) { const s = mo.part.obj.userData.strut; if (s) s.rotation.y += (mo.steer * (mo.part.p.mirror ? -1 : 1) - s.rotation.y) * 0.3; }
}
