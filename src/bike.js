// Motorbikes: balance and handling for two-wheeled vehicles. aircraft.js calls in here for any vehicle the layout test
// calls a bike; nothing here runs for planes or cars.
//
// A bike is any car (it has a drive engine) whose wheels are exactly two, in line, on the centreline: the stock bikes
// and a kid's own build alike. On two wheels the rigid-body model would simply fall over, so a rider rides it:
//   - the steering sets a LEAN: full stick is ~35° (less at walking pace, none at a stop, less on a bike that would
//     scrape its pegs or fairing first). The front wheel is turned to the angle that holds the bike's ACTUAL lean in
//     balance (tan(lean) = v·yaw rate / g), plus a correction towards the wanted lean: to lean right from upright that
//     correction first steers left. Counter-steering, done for you.
//   - a balance torque helps the lean follow its target (strong in Arcade, softer in Pilot, a light assist in Sim, where
//     the steering does more of the work). Below walking pace the rider puts a foot down: it stays up at a stop in
//     every mode.
//   - the rider keeps it pointing along its steering (a light back wheel under hard braking would slide out and spin
//     it), steers into a sliding back wheel, eases the brakes before the back lifts on its own and the gas before the
//     front does (every mode).
//   - Arcade/Pilot: full gas from low speed lifts the front (a wheelie, ~25°, for up to 2.5 s per twist of the gas);
//     a full stop from speed lifts the back (a stoppie, ~16°). Both are held at their angle, can't go over, and come
//     back down gently.
//   - in the air the rider levels the bike and keeps its nose near the flight path, so a jump lands on its wheels.
//   - the rider (not a part) adds drag, less when tucked in; rolling backwards is only a shuffle.
// Physics only: the visuals read ac.bike (lean, steer, tuck) through planeDetail.updateDetail.
import * as THREE from 'three';
import { clamp } from './noise.js';

const G = 9.81;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _t = new THREE.Vector3(), _a = new THREE.Vector3(), _p = new THREE.Vector3(), _qi = new THREE.Quaternion();

// bal: balance torque, lean: how far full stick leans, tricks: wheelies / stoppies, air: attitude hold in the air,
// yaw: how firmly the rider keeps the bike pointing along its steering (catches a sliding back wheel)
const MODE = {
  arcade: { bal: 1, lean: 1, tricks: 1, air: 1, yaw: 40 },
  pilot: { bal: 0.75, lean: 1, tricks: 1, air: 0.8, yaw: 34 },
  sim: { bal: 0.3, lean: 0.9, tricks: 0, air: 0.3, yaw: 26 },
};
export const LEAN_MAX = 0.62; // rad (~35°): 0.7 g of cornering, inside the tyres' 0.9 g
const LOCK = 0.55; // rad: full lock at walking pace
const SLIDE = 0.6; // rad: the slide angle a skid holds at full stick (~35°)
const WHEELIE = 0.42, STOPPIE = -0.28, LOOP = 0.62; // rad (ground-relative pitch): wheelie and stoppie heights, hard limit

// Two in-line wheels on the centreline? wheels: [{ x, z, ...}] in the vehicle frame. Returns { front, rear, L } or null.
export function bikeLayout(wheels) {
  if (wheels.length !== 2) return null;
  const [a, b] = wheels;
  if (Math.abs(a.x) > 0.2 || Math.abs(b.x) > 0.2 || Math.abs(a.x - b.x) > 0.15 || Math.abs(a.z - b.z) < 0.6) return null;
  const front = a.z < b.z ? a : b, rear = front === a ? b : a;
  return { front, rear, L: rear.z - front.z };
}

// aircraft.js: after the parts are built. Returns the bike state, or null for anything that isn't a bike.
export function detectBike(ac) {
  const ws = [];
  for (const p of ac.parts) if (p.gear && !p.gear.float) for (const w of p.gear.wheels) ws.push({ x: w.top.x, z: w.top.z, w });
  const lay = bikeLayout(ws); if (!lay) return null;
  const cdA = ac.parts.reduce((a, p) => Math.max(a, p.d.riderDrag || 0), 0) || 0.45; // the rider (not a part) catches the wind too
  // how far it can lean before something other than a tyre touches the road (a kid's bike on small wheels, a wide
  // fairing): every hull point against the line between the two tyres' contact patches, sitting on its springs
  const f = lay.front.w, r = lay.rear.w, gy = (w) => w.top.y - w.len - w.r + 0.09, xc = (f.top.x + r.top.x) / 2;
  let clear = 1.2;
  for (const p of ac.parts) for (const h of p.hull) {
    const t = clamp((h.z - f.top.z) / (r.top.z - f.top.z), 0, 1), hh = h.y - (gy(f) + (gy(r) - gy(f)) * t), x = Math.abs(h.x - xc);
    if (x > 0.02) clear = Math.min(clear, Math.atan2(Math.max(0, hh), x));
  }
  return { front: lay.front.w, rear: lay.rear.w, L: lay.L, cdA, leanMax: clamp(clear - 0.12, 0.25, LEAN_MAX), lean: 0, leanT: 0, steer: 0, pitch: 0, tuck: 0, wheelie: 0, stoppie: 0, wheelieT: 0, stoppieT: 0, trick: '' };
}

// The front wheel's steering angle (rad, + = left, like aircraft.steerAngle), set every substep by bikeAssist.
export function bikeSteer(ac) { return ac.bike.steer; }

// Every substep, before the contacts: the rider's steering and the balance / trick / air torques (body frame, added to T).
export function bikeAssist(ac, F, T, ctl, dt, env) {
  const b = ac.bike, m = MODE[ac.R.id] || MODE.pilot, q = ac.q, I = ac.I.elements, w = ac.w, mass = ac.mass;
  const fwd = _f.set(0, 0, -1).applyQuaternion(q), right = _r.set(1, 0, 0).applyQuaternion(q);
  const su = ac.stuntUp; // (on a ramp, the loop or the bowl: lean, slope and the yaw catch are taken from its surface, not the world's)
  const lean = -Math.asin(clamp(su ? right.dot(su) : right.y, -1, 1)), leanRate = -w.z; // + = leaning right
  const vg = ac.groundSpeed, spd = Math.abs(vg), s = clamp(ac.steerCmd(), -1, 1); // s: + = right
  const fc = b.front.contact, rc = b.rear.contact, ground = fc || rc;
  b.lean = lean;
  // ---- steering and lean ----
  const roll = smooth(1.2, 7, spd) * (vg > 0 ? 1 : 0); // how much leaning is possible: none at a stop or rolling back
  // a skid: the back brake (the handbrake) locks the back wheel. The rider lets the tail swing out the way they steer
  // (a brake slide), sitting more upright, then catches it when they let go (see the heading hold and opposite lock)
  const rc0 = b.rear.contact, skid = ground && rc0 && (ctl.hand || 0) > 0.5 && vg > 2 ? smooth(2, 5, vg) : 0; b.skid = skid;
  const want = s * b.leanMax * m.lean * roll * (1 - 0.5 * skid);
  b.leanT += clamp(want - b.leanT, -2.6 * dt, 2.6 * dt); // (the lean target moves at a rider's pace)
  const fallen = Math.abs(lean) > 1.15;
  let dg; // ground steering angle, + = right
  if (!ground || fallen) dg = s * LOCK * 0.3;
  else {
    const v2 = Math.max(1, vg * vg), L = b.L;
    const hold = Math.atan((L * G * Math.tan(clamp(lean, -1.2, 1.2))) / v2); // what keeps this lean in balance
    const fix = (L * (14 * (lean - b.leanT) + 4 * leanRate)) / v2; // steer into a fall, out of it to lean further
    const k = roll; // walking pace and below: the bars just turn the wheel
    dg = clamp(k * (hold + fix) + (1 - k) * s * LOCK, -LOCK, LOCK);
    // opposite lock: if the back wheel slides out, the front steers the same way and catches it (a gripping tyre only
    // creeps sideways a little, below 0.2 m/s, so this does nothing in a normal turn)
    _a.copy(ac.v).applyQuaternion(_qi.copy(q).invert()); _p.copy(b.rear.top).sub(ac.com); _t.copy(w).cross(_p).add(_a);
    const slide = Math.sign(_t.x) * Math.max(0, Math.abs(_t.x) - 0.2);
    if (vg > 3) dg = clamp(dg + 0.8 * (1 - 0.75 * skid) * Math.atan2(slide, Math.max(1, -_t.z)), -LOCK, LOCK); // (skidding: mostly let it slide)
    if (skid) dg += (s * 0.12 - dg) * skid * Math.min(1, Math.abs(s) * 3); // (held straight, it still balances as usual) // (skidding, the bars point the way you push: no counter-steering, the slide goes that way)
  }
  // the wheel turns about the leaning steering head: the angle on the ground is the head's angle squashed by the lean
  b.steer += (-Math.atan(Math.tan(dg) / Math.max(0.35, Math.cos(lean))) - b.steer) * Math.min(1, dt * 30);
  const bal = Math.max(m.bal, 1 - smooth(1.5, 3, spd)); // below walking pace: a foot down, in every mode
  const Ix = I[0], Iz = I[8];
  const g0 = env.groundAt(ac.x.x, ac.x.z), h = clamp(ac.x.y - g0.h, 0.3, 2), Ir = Iz + mass * h * h; // (a bike rolls about its tyres' contact line)
  if (ground && !fallen) { // the rider's balance: lean follows its target
    const over = Math.max(0, Math.abs(lean) - b.leanMax - 0.08) * Math.sign(lean); // past what the tyres (or the clearance) can take: always caught
    const acc = (30 * (b.leanT - lean) - 10 * leanRate) * bal - 40 * over - (over ? 6 * leanRate : 0);
    T.z -= acc * Ir;
  } else if (!ground) { // in the air: level the bike
    const acc = (9 * (0 - lean) - 4 * leanRate) * m.air;
    T.z -= acc * Iz;
  }
  // ---- pitch: wheelies, stoppies, loop-out guard, attitude in the air ----
  const pitch = Math.asin(clamp(fwd.y, -1, 1));
  let slope = 0;
  if (ground) { const n = su || g0.n; _t.copy(fwd).addScaledVector(n, -fwd.dot(n)); if (_t.lengthSq() > 1e-6) slope = Math.asin(clamp(_t.normalize().y, -1, 1)); }
  const rel = pitch - slope; b.pitch = rel;
  const pivot = (wh) => { // inertia about a wheel's contact patch and the weight's moment about it (+ = nose up)
    ac.worldPoint(wh.top, _p).addScaledVector(_a.set(0, -1, 0).applyQuaternion(q), wh.len - wh.comp); _p.y -= wh.r; // (the axle, then straight down)
    _a.copy(ac.x).sub(_p); const fh = _t.set(fwd.x, 0, fwd.z).normalize();
    return { Ieff: Ix + mass * _a.lengthSq(), grav: mass * G * _a.dot(fh) };
  };
  b.trick = '';
  if (ground && !fallen) {
    if (m.tricks && Math.abs(lean) < 0.35) {
      const straight = Math.abs(lean) < 0.2 && Math.abs(s) < 0.4;
      // a wheelie lasts up to 2.5 s per twist of the gas (ease off and open it again for another), so holding full gas
      // launches with the front up and then gets on with going fast
      if (ctl.throttle < 0.5) b.wheelieT = 0;
      const wantW = ctl.throttle > 0.85 && vg > 1 && vg < 20 && rc && straight && b.wheelieT < 2.5, wantS = ctl.rev > 0.95 && vg > 4 && fc && !wantW && straight;
      if (wantW || b.wheelieT > 0 && ctl.throttle >= 0.5) b.wheelieT = b.wheelieT + dt;
      if (wantW) { // front up, held at the wheelie angle on the back wheel
        const tgt = WHEELIE * clamp((ctl.throttle - 0.85) / 0.12, 0, 1), P = pivot(b.rear);
        T.x += P.Ieff * (20 * (tgt - rel) - 6 * w.x) + (fc ? 0 : P.grav * 0.5); b.trick = 'wheelie';
      } else if (wantS) { // back up, balanced on the front wheel
        const tgt = STOPPIE * clamp((ctl.rev - 0.95) / 0.04, 0, 1), P = pivot(b.front);
        T.x += P.Ieff * (8 * (tgt - rel) - 4 * w.x); b.trick = 'stoppie'; b.stoppieT = tgt;
      }
    }
    // (every mode, leaning or not) a wheel that came up without being asked comes back down, gently, and the bike
    // never goes over backwards or over the bars
    if (!b.trick && !fc && rc && rel > 0.02) { const P = pivot(b.rear), wDes = -Math.min(1.2, 2.5 * rel); T.x += P.Ieff * 5 * (wDes - w.x); }
    else if (!b.trick && fc && !rc && rel < -0.02) { const P = pivot(b.front), wDes = Math.min(1.2, -2.5 * rel); T.x += P.Ieff * 5 * (wDes - w.x); }
    if (rel > LOOP && w.x > -1) T.x -= pivot(b.rear).Ieff * (40 * (rel - LOOP) + 8 * Math.max(0, w.x));
    if (rel < -LOOP * 0.7 && w.x < 1) T.x += pivot(b.front).Ieff * (40 * (-LOOP * 0.7 - rel) + 8 * Math.max(0, -w.x));
  }
  // wheelie control (every mode): the engine eases off when the front lifts on its own (or a wanted wheelie goes past
  // its height), so the gas never flips the bike over backwards
  if (rc && !fc && ac.driveF > 0) {
    const lim = b.trick === 'wheelie' ? WHEELIE - 0.04 : 0.05;
    if (rel > lim) ac.driveF *= clamp(1 - (rel - lim) * 12 - Math.max(0, w.x) * 0.8, 0.05, 1);
  }
  // braking (every mode, like ABS): the brakes ease off before the back wheel goes light (it would slide out and spin
  // the bike), or, in a stoppie, before the back goes higher than the stoppie
  if (ac.svcBrake > 0 && fc) {
    if (b.trick === 'stoppie') { if (rel < b.stoppieT) ac.svcBrake *= clamp(1 - (b.stoppieT - rel) * 8 + Math.min(0, w.x) * 0.5, 0.25, 1); }
    else ac.svcBrake *= rc ? 1 - 0.5 * clamp((0.03 - b.rear.comp) / 0.025, 0, 1) : clamp(0.4 + rel * 3, 0.05, 0.4); // (back wheel up when you didn't ask: let it down)
  }
  b.wheelie = !fc && rc ? rel : 0; b.stoppie = fc && !rc ? -rel : 0;
  // the bike points where its front wheel takes it: a light back wheel (hard braking, a stoppie) or no front wheel
  // (a wheelie) can't hold the line by itself, so the rider catches a slide before it becomes a spin (about the vertical)
  if (ground && !fallen) {
    // (skidding: the rider holds the bike at a slide angle, the nose turned off the way it's going by up to SLIDE the
    // way the stick pushes, the locked back wheel out the other side)
    let want = -vg * Math.tan(dg) / b.L;
    if (skid) { _p.copy(ac.v).applyQuaternion(_qi.copy(q).invert()); const nose = Math.atan2(-_p.x, Math.max(0.5, -_p.z)); want += (-4 * (s * SLIDE - nose) - want) * skid; }
    const wy = su ? _a.copy(w).applyQuaternion(q).dot(su) : _a.copy(w).applyQuaternion(q).y, k = (fc && rc ? m.yaw : 30) * I[4] * (wy - want);
    T.add((su ? _t.copy(su).multiplyScalar(-k) : _t.set(0, -k, 0)).applyQuaternion(_qi.copy(q).invert()));
  }
  if (!ground) { // in the air: nose near the flight path (a touch up, so the back wheel lands first), no spin
    const vh = Math.hypot(ac.v.x, ac.v.z), path = Math.atan2(ac.v.y, Math.max(1, vh)), tgt = clamp(path * 0.3, -0.15, 0.15) + 0.04;
    T.x += (6 * (tgt - pitch) - 3 * w.x) * Ix * m.air;
    T.y -= 2 * w.y * I[4] * m.air;
  }
  b.tuck = smooth(16, 30, spd) * (ctl.throttle > 0.3 ? 1 : 0.6);
  // bikes don't really reverse: rolling backwards is a walking-pace shuffle
  if (ac.reversing && ac.driveF < 0) ac.driveF *= 0.35 * clamp(1 - Math.max(0, -vg) / 2.2, 0, 1);
  // the rider's drag (tucking in helps), along the bike
  _a.copy(ac.v).applyQuaternion(_qi.copy(q).invert()); F.z -= 0.5 * ac.rho * b.cdA * (1 - 0.25 * b.tuck) * _a.z * Math.abs(_a.z);
}
