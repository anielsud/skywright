// Scripted bike rides (browser module, driven by bikeride.py): each stock bike, in each realism mode, on flat ground at
// 60 Hz with the controls a player would use (the same Aircraft physics the game steps). Physics only, no rendering.
//   ride:    gas up, turn left, turn right, brake to a stop, wait: it must stay upright all the way, turn the way it was
//            steered, reach a decent speed and stand still at the end.
//   wheelie: (Arcade/Pilot) full gas from a roll lifts the front, it stays below the loop-out limit, and comes back down
//            onto both wheels when the gas is eased; holding full gas from a stop wheelies and then rides on normally.
//   stoppie: (Arcade/Pilot) a hard stop lifts the back wheel, and it lands again.
//   jump:    launched off the ground at speed with the bike level: it lands upright and rides on.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { bikeBuilds } from './meshcheck.js';
import { PARTS } from '../../src/parts.js';
import { analyze } from '../../src/design.js';

const flat = (h = 0) => ({ groundAt: () => ({ h, n: new THREE.Vector3(0, 1, 0), type: 'runway' }), maxGround: () => h, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: h });
const C = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0, ...o });

// One ride: script(t, ac) -> controls; returns per-frame samples (every 0.1 s) and the run's extremes
export function run(design, mode, script, { T = 20, spawn = {}, dt = 1 / 60 } = {}) {
  const ac = new Aircraft(design, REALISM[mode]), env = flat();
  ac.spawn(env, new THREE.Vector3(0, 0, 0), 0, spawn);
  if (spawn.speed) ac.v.set(0, spawn.vy || 0, -spawn.speed);
  if (spawn.alt) { ac.x.y = spawn.alt; ac.syncVisual(); }
  const out = { samples: [], maxLean: 0, minUp: 1, maxSpeed: 0, maxPitch: -9, minPitch: 9, flips: 0, events: [] };
  let yaw0 = null;
  for (let f = 0; f * dt < T; f++) {
    const t = f * dt, c = script(t, ac);
    ac.setControls(C(c)); ac.brake = c.park ? 1 : 0;
    const up0 = ac.up.y; ac.step(dt, env);
    if (ac.flipT === 0 && up0 < 0.5 && ac.up.y > 0.99) out.flips++; // carRecover put it back up
    for (const e of ac.events.splice(0)) if (['msg', 'landing', 'impact', 'wreck'].includes(e.type)) out.events.push([+t.toFixed(2), e.type, e.text || '']);
    const fwd = ac.forward, yaw = Math.atan2(-fwd.x, -fwd.z); if (yaw0 === null) yaw0 = yaw;
    const b = ac.bike || {}, spd = Math.hypot(ac.v.x, ac.v.z);
    out.maxLean = Math.max(out.maxLean, Math.abs(b.lean || 0)); out.minUp = Math.min(out.minUp, ac.up.y); out.maxSpeed = Math.max(out.maxSpeed, spd);
    if (ac.onGround) { out.maxPitch = Math.max(out.maxPitch, b.pitch || 0); out.minPitch = Math.min(out.minPitch, b.pitch || 0); }
    if (f % 6 === 0) out.samples.push({ t: +t.toFixed(2), spd: +spd.toFixed(2), lean: +(b.lean || 0).toFixed(3), leanT: +(b.leanT || 0).toFixed(3), steer: +(b.steer || 0).toFixed(3), pitch: +(b.pitch || 0).toFixed(3), yaw: +(yaw - yaw0).toFixed(3), y: +ac.x.y.toFixed(3), up: +ac.up.y.toFixed(3), fc: !!b.front?.contact, rc: !!b.rear?.contact, ground: ac.onGround, dead: !!ac.dead, ...(globalThis.__rideDbg ? { wy: +ac.w.y.toFixed(3), wz: +ac.w.z.toFixed(3), fs: +(b.front?.slip || 0).toFixed(2), rs: +(b.rear?.slip || 0).toFixed(2), fcomp: +(b.front?.comp || 0).toFixed(3), rcomp: +(b.rear?.comp || 0).toFixed(3), vg: +ac.groundSpeed.toFixed(2), rev: ac.reversing, sb: +ac.svcBrake.toFixed(2) } : {}) });
    if (ac.dead) { out.dead = true; break; }
  }
  out.final = out.samples.at(-1); out.isBike = ac.isBike; out.isCar = ac.isCar; out.mass = +ac.mass.toFixed(1);
  return out;
}
const sample = (r, t) => r.samples.reduce((a, s) => (Math.abs(s.t - t) < Math.abs(a.t - t) ? s : a));
const unwrapYaw = (r, t0, t1) => { let tot = 0, prev = sample(r, t0).yaw; for (const s of r.samples) if (s.t > t0 && s.t <= t1) { let d = s.yaw - prev; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; tot += d; prev = s.yaw; } return tot; };

// The test plan: presets = the stock bikes, others = every other stock vehicle. Returns [{ name, ok, why, ...numbers }]
export function plan(presets, others = []) {
  const out = [], check = (name, r, conds) => { const bad = conds.filter(([ok]) => !ok).map(([, why]) => why); out.push({ name, ok: !bad.length, why: bad.join('; '), maxLean: +r.maxLean.toFixed(2), minUp: +r.minUp.toFixed(2), maxSpeed: +r.maxSpeed.toFixed(1), maxPitch: +r.maxPitch.toFixed(2), minPitch: +r.minPitch.toFixed(2), flips: r.flips, final: r.final, events: r.events.slice(0, 6) }); return r; };
  for (const d of presets) for (const mode of ['arcade', 'pilot', 'sim']) {
    // the ride: 0-4 s gas, 4-9 s left turn on part gas, 9-13 s right turn, 13-15 s straight, 15-23 s brake to a stop, then wait
    const ride = run(d, mode, (t, ac) => t < 4 ? { throttle: 0.75 } : t < 9 ? { throttle: 0.2, roll: -1 } : t < 13 ? { throttle: 0.2, roll: 1 } : t < 15 ? { throttle: 0.5 } : t < 23 ? { rev: Math.abs(ac.groundSpeed) > 0.3 ? 0.9 : 0 } : {}, { T: 26 });
    const left = unwrapYaw(ride, 4, 9), right = unwrapYaw(ride, 9, 13), stop = sample(ride, 23), end = ride.final;
    check(`${d.name} ${mode}: ride`, ride, [
      [ride.isBike, 'not detected as a bike'], [!ride.dead, 'wrecked'], [ride.minUp > 0.55, `fell over (up ${ride.minUp.toFixed(2)})`], [!ride.flips, 'had to be picked up'],
      [ride.maxSpeed > 12, `slow (${ride.maxSpeed.toFixed(1)} m/s)`], [left > 0.6, `left turn ${left.toFixed(2)} rad`], [right < -0.4, `right turn ${right.toFixed(2)} rad`],
      [ride.maxLean > 0.25, `never leaned (${ride.maxLean.toFixed(2)})`], [stop.spd < 0.5, `still moving at 23 s (${stop.spd})`], [end.spd < 0.3 && end.up > 0.95, `not standing still and upright at the end (${end.spd} m/s, up ${end.up})`],
    ]);
    if (mode === 'sim') continue;
    // wheelie: roll at 8 m/s, then full gas for 2.5 s, then ease off
    const wh = run(d, mode, (t) => (t < 2 ? { throttle: 0.5 } : t < 4.5 ? { throttle: 1 } : { throttle: 0.3 }), { T: 8, spawn: { speed: 6 } });
    const up = wh.samples.filter((s) => s.t > 2 && s.t < 4.6 && !s.fc && s.rc).length, back = wh.samples.filter((s) => s.t > 6.5).every((s) => s.fc && s.rc);
    check(`${d.name} ${mode}: wheelie`, wh, [[up >= 5, `front never came up (${up} samples)`], [wh.maxPitch < 0.7, `too high (${wh.maxPitch.toFixed(2)} rad)`], [back, 'did not come back down'], [wh.minUp > 0.6, 'fell over'], [!wh.dead, 'wrecked']]);
    // holding full gas from a stop (a kid on the keyboard): it launches on the back wheel, then puts the front down and
    // gets going properly
    const fg = run(d, mode, () => ({ throttle: 1 }), { T: 10 });
    const upT = fg.samples.filter((s) => !s.fc && s.rc).length * 0.1, downEnd = fg.samples.filter((s) => s.t > 7).every((s) => s.fc && s.rc);
    check(`${d.name} ${mode}: full gas`, fg, [[upT >= 1, `no wheelie (${upT.toFixed(1)} s)`], [downEnd, 'still on the back wheel after 7 s'], [fg.maxSpeed > 25, `slow (${fg.maxSpeed.toFixed(1)} m/s)`], [fg.maxPitch < 0.7, 'too high'], [fg.minUp > 0.6, 'fell over']]);
    // stoppie: 18 m/s, then a full hard stop
    const sp = run(d, mode, (t, ac) => (t < 1 ? { throttle: 0.6 } : { rev: Math.abs(ac.groundSpeed) > 0.3 ? 1 : 0 }), { T: 7, spawn: { speed: 18 } });
    const lift = sp.samples.filter((s) => s.fc && !s.rc && s.t > 1).length, down = sp.samples.filter((s) => s.t > 5.5).every((s) => s.fc && s.rc);
    check(`${d.name} ${mode}: stoppie`, sp, [[lift >= 3, `back never came up (${lift} samples)`], [sp.minPitch > -0.55, `nose too low (${sp.minPitch.toFixed(2)})`], [down, 'did not land'], [sp.minUp > 0.6, 'fell over'], [!sp.dead, 'wrecked']]);
  }
  // jump: in the air at 2.5 m, 15 m/s, a little roll and nose-up: lands upright and rides on
  for (const d of presets) for (const mode of ['arcade', 'pilot', 'sim']) {
    const j = run(d, mode, (t) => ({ throttle: 0.4 }), { T: 6, spawn: { air: true, alt: 2.5, speed: 15, vy: 3, pitch: 0.12 } });
    const landed = j.samples.filter((s) => s.t > 3);
    check(`${d.name} ${mode}: jump`, j, [[!j.dead, 'wrecked'], [landed.every((s) => s.up > 0.85 && s.fc && s.rc), 'did not land upright on both wheels'], [j.minUp > 0.6, 'tipped over'], [!j.flips, 'had to be picked up']]);
  }
  // a kid's own bikes, parts dropped the way the hangar places them (meshcheck.js): any frame or body with two wheels in
  // line on the centreline is a bike, whatever the wheels are (car wheels too), and whatever angle it sits at. They must be
// detected and ride without falling over.
  const kids = [...bikeBuilds(8, 91, { fit: true }), ...bikeBuilds(3, 93, { forks: ['c_wheel_steer'], rears: ['c_wheel'], engines: ['c_motor'], bodies: ['fus_pod', 'b_dirt', 'fus_buggy'], fit: true })];
  for (const d of kids) {
    // (a random build whose wheels don't both reach the ground, so it sits on its frame, isn't a bike anyone could ride)
    const rest = run(d, 'arcade', () => ({}), { T: 1.5 });
    if (!(rest.final.fc && rest.final.rc)) { out.push({ name: `kid ${d.name}: skipped`, ok: true, skip: true, why: 'its wheels don\'t both reach the ground' }); continue; }
    const ride = run(d, 'arcade', (t, ac) => t < 3 ? { throttle: 0.6 } : t < 8 ? { throttle: 0.15, roll: -1 } : t < 10 ? { throttle: 0.3 } : t < 22 ? { rev: Math.abs(ac.groundSpeed) > 0.3 ? 0.9 : 0 } : {}, { T: 24 }); // (a short, tall bike can only brake gently before it tips onto its nose)
    check(`kid ${d.name}: ride`, ride, [[ride.isBike, 'not detected as a bike'], [!ride.dead, 'wrecked'], [ride.maxLean < 0.95, `fell over (lean ${ride.maxLean.toFixed(2)})`], [!ride.flips, 'had to be picked up'],
      [ride.maxSpeed > 8, `slow (${ride.maxSpeed.toFixed(1)} m/s)`], [ride.minPitch > -0.6, `nose dived (${ride.minPitch.toFixed(2)})`], [unwrapYaw(ride, 3, 8) > 0.4, 'did not turn left'], [ride.final.spd < 0.5 && Math.abs(ride.final.lean) < 0.1, 'not stopped upright at the end']]);
  }
  // a bike or car with its engine taken out is still a land vehicle (not a glider dropped from the sky): it rolls
  // off at a push and stays upright (Niam's Dirt Bike without its engine, 2026-11-21)
  for (const d of [...presets, ...others.filter((o) => o.parts.some((p) => p.id.startsWith('c_')))]) {
    const bare = { ...d, name: `${d.name} without engine`, parts: d.parts.filter((p) => !PARTS[p.id]?.engine) };
    if (bare.parts.length === d.parts.length || bare.parts.some((p) => PARTS[p.id]?.cat === 'wing')) continue;
    const st = analyze(bare), r = run(bare, 'pilot', () => ({ throttle: 1 }), { T: 4, spawn: { speed: 5 } });
    check(`${bare.name}: still rolls`, r, [[st.car, 'analyze() says it is not a land vehicle'], [!st.warnings.some(([, t]) => /glider/.test(t)), 'called a glider'],
      [r.isCar, 'Aircraft is not a car'], [!r.dead, 'wrecked'], [r.minUp > 0.55, `fell over (up ${r.minUp.toFixed(2)})`], [r.final.spd < 5, `sped up with no engine (${r.final.spd} m/s)`]]);
  }
  // and everything else stays what it was
  for (const d of others) { const ac = new Aircraft(d, REALISM.arcade); out.push({ name: `${d.name}: not a bike`, ok: !ac.isBike, why: ac.isBike ? 'detected as a bike' : '' }); }
  return out;
}
