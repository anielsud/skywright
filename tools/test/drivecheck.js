// Car handling (browser module, driven by drivecheck.py): the stock cars on flat ground at 60 Hz through the game's own
// physics (no rendering), in every driving mode, with scripted inputs:
//   circle:  held at a speed (5 to 30 m/s) with the stick hard over for 6 s: the turning circle (radius), the yaw rate
//            and the cornering g it settles at, and whether it tips (lowest up.y, wheels in the air).
//   slalom:  15 m/s, the stick swung from lock to lock every 1.2 s: how far the heading swings each way, and it stays
//            on its wheels.
//   fishhook: (the tip test) 20 m/s, full lock one way, then the other: it must stay on its wheels in Easy and Racer.
//   a kid's own cars (meshcheck.js carBuilds: wheels, engine, cage and wing dropped on a body, some narrow and tall):
//            hard turns at 10 and 20 m/s and the fishhook must keep them on their wheels in Easy and Racer.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { carBuilds } from './meshcheck.js';
import { analyze } from '../../src/design.js';

const flat = (h = 0) => ({ groundAt: () => ({ h, n: new THREE.Vector3(0, 1, 0), type: 'runway' }), maxGround: () => h, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: h });
const C = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0, ...o });
const hsp = (ac) => Math.hypot(ac.v.x, ac.v.z);
const yawOf = (ac) => { const f = ac.forward; return Math.atan2(-f.x, -f.z); };
// throttle (or brake) to hold a ground speed, as a driver would
const hold = (ac, vT) => { const e = vT - hsp(ac); return e > -0.3 ? { throttle: clamp01(0.35 + e * 0.6) } : { rev: clamp01(-e * 0.3) }; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function run(design, mode, script, { T = 8, speed = 0, dt = 1 / 60 } = {}) {
  const ac = new Aircraft(design, REALISM[mode]), env = flat();
  ac.spawn(env, new THREE.Vector3(0, 0, 0), 0);
  // settle on its springs, then set off at the speed
  for (let i = 0; i < 60; i++) { ac.setControls(C()); ac.brake = 1; ac.step(dt, env); }
  ac.brake = 0; ac.v.set(0, ac.v.y, -speed); ac.groundSpeed = speed;
  const out = { s: [], minUp: 1, lift: 0, flips: 0 };
  let prev = yawOf(ac), yaw = 0, nW = 0;
  for (const p of ac.parts) if (p.gear) nW += p.gear.wheels.length;
  for (let f = 0; f * dt < T; f++) {
    const t = f * dt, c = script(t, ac);
    ac.setControls(C(c)); ac.brake = 0;
    const up0 = ac.up.y; ac.step(dt, env);
    if (up0 < 0.5 && ac.up.y > 0.99) out.flips++;
    ac.events.length = 0;
    const y = yawOf(ac); let d = y - prev; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; yaw += d; prev = y;
    let inAir = 0; for (const p of ac.parts) if (p.gear) for (const w of p.gear.wheels) if (!w.contact) inAir++;
    out.minUp = Math.min(out.minUp, ac.up.y); out.lift = Math.max(out.lift, t > 0.3 ? inAir : 0);
    const vB = ac.v.clone().applyQuaternion(ac.q.clone().invert());
    out.s.push({ t, yaw, beta: Math.atan2(vB.x, Math.max(1, Math.abs(vB.z))), spd: hsp(ac), wy: ac.wW.y, up: ac.up.y, x: ac.x.x, z: ac.x.z, inAir, steer: ac.steerAngle() });
  }
  out.nW = nW; out.cornerG = ac.cornerG; out.wheelbase = ac.wheelbase;
  return out;
}
const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / Math.max(1, a.length);

// circle at speed v: 1 s straight, then hard right for 6 s; steady state over the last 2.5 s
export function circle(design, mode, v, dir = 1) {
  const r = run(design, mode, (t, ac) => ({ ...hold(ac, v), roll: t > 1 ? dir : 0 }), { T: 7, speed: v });
  const ss = r.s.filter((s) => s.t > 4.5), wy = Math.abs(avg(ss, 'wy')), spd = avg(ss, 'spd');
  // response: heading change in the first second of steering
  const y1 = r.s.find((s) => s.t >= 2).yaw - r.s.find((s) => s.t >= 1).yaw;
  const t90 = (r.s.find((s) => s.t > 1 && Math.abs(s.wy) >= 0.9 * wy)?.t ?? 99) - 1; // time to 90 % of the steady yaw rate
  return { v, spd: +spd.toFixed(2), yawRate: +wy.toFixed(3), radius: +(spd / Math.max(1e-3, wy)).toFixed(1), latG: +(spd * wy / 9.81).toFixed(2), turn1s: +(Math.abs(y1) * 180 / Math.PI).toFixed(1), t90: +t90.toFixed(2),
    lock: +(Math.abs(r.s.find((s) => s.t >= 3).steer) * 180 / Math.PI).toFixed(1), minUp: +r.minUp.toFixed(3), lift: r.lift, flips: r.flips, nW: r.nW };
}
export function slalom(design, mode, v = 15) {
  const per = 2.4, r = run(design, mode, (t, ac) => ({ ...hold(ac, v), roll: t < 1 ? 0 : Math.sin((t - 1) * 2 * Math.PI / per) > 0 ? 1 : -1 }), { T: 1 + per * 4, speed: v });
  const ss = r.s.filter((s) => s.t > 1 + per);
  const yaws = ss.map((s) => s.yaw), swing = Math.max(...yaws) - Math.min(...yaws);
  const xs = ss.map((s) => s.x), lat = Math.max(...xs) - Math.min(...xs);
  return { v, swing: +(swing * 180 / Math.PI).toFixed(1), lateral: +lat.toFixed(2), spd: +avg(ss, 'spd').toFixed(2), minUp: +r.minUp.toFixed(3), lift: r.lift, flips: r.flips };
}
export function fishhook(design, mode, v = 20) {
  const r = run(design, mode, (t, ac) => ({ throttle: t < 1 ? hold(ac, v).throttle || 0 : 0.5, roll: t < 1 ? 0 : t < 2.2 ? 1 : -1 }), { T: 6, speed: v });
  return { v, minUp: +r.minUp.toFixed(3), lift: r.lift, flips: r.flips, nW: r.nW };
}

// drift: 18 m/s, full lock and the handbrake for 1.5 s with the gas on, then let go of the handbrake, then straighten
export function drift(design, mode, v = 18) {
  const r = run(design, mode, (t, ac) => ({ throttle: t < 1 ? hold(ac, v).throttle || 0 : 0.7, roll: t < 1 ? 0 : t < 3.5 ? 1 : 0, hand: t > 1 && t < 2.5 ? 1 : 0 }), { T: 6, speed: v });
  const during = r.s.filter((s) => s.t > 1 && s.t < 3.5), end = r.s.filter((s) => s.t > 5);
  return { v, maxBeta: +(Math.max(...during.map((s) => Math.abs(s.beta))) * 180 / Math.PI).toFixed(1), endBeta: +(Math.max(...end.map((s) => Math.abs(s.beta))) * 180 / Math.PI).toFixed(1),
    turned: +(Math.abs(r.s.at(-1).yaw) * 180 / Math.PI).toFixed(0), spd: +r.s.find((s) => s.t >= 2.5).spd.toFixed(1), minUp: +r.minUp.toFixed(3), flips: r.flips };
}
// brake and steer: 20 m/s, full brake and full lock together: with ABS it still turns, a locked wheel just slides
export function brakeTurn(design, mode, v = 20) {
  const r = run(design, mode, (t, ac) => ({ rev: t > 1 && ac.groundSpeed > 0.5 ? 1 : 0, roll: t > 1 ? 1 : 0 }), { T: 4, speed: v });
  const stop = r.s.find((s) => s.t > 1 && s.spd < 1) || r.s.at(-1);
  return { v, turned: +(Math.abs(stop.yaw) * 180 / Math.PI).toFixed(0), stopT: +(stop.t - 1).toFixed(2), minUp: +r.minUp.toFixed(3) };
}

export const SPEEDS = [5, 10, 15, 20, 25, 30];
const mkCheck = (checks) => (name, conds) => { const bad = conds.filter(([ok]) => !ok).map(([, w]) => w); checks.push({ name, ok: !bad.length, why: bad.join('; ') }); };
// one stock car in one mode: every manoeuvre, judged. Returns { result, checks }
export function carPlan(d, mode, { strict = true } = {}) {
  const checks = [], check = mkCheck(checks);
  const circles = SPEEDS.map((v) => circle(d, mode, v)), sl = slalom(d, mode), fh = fishhook(d, mode), dr = drift(d, mode), bt = brakeTurn(d, mode);
  const result = { name: d.name, mode, circles, slalom: sl, fishhook: fh, drift: dr, brakeTurn: bt };
  if (!strict) return { result, checks };
  const pro = mode === 'sim', tipped = (r) => r.minUp < 0.5 || r.flips > 0;
  for (const c of circles) check(`${d.name} ${mode} circle ${c.v} m/s`, [
    // crisp at every speed: a tight circle slow, and still a real turn at speed (at least ~0.55 g, ~0.8 g low cars)
    [c.v > 7 || c.radius < 6, `wide circle at ${c.v} m/s: ${c.radius} m`],
    [c.v <= 7 || c.latG >= (pro ? 0.6 : 0.95), `weak turn at ${c.v} m/s: ${c.latG} g, radius ${c.radius} m`],
    [c.t90 <= (pro ? 0.9 : 0.45), `slow to turn in: ${c.t90} s to 90 % of its turn rate`],
    [!tipped(c) && (pro || !c.lift || c.v < 7), `tipped or lifted a wheel (up ${c.minUp}, ${c.lift} wheels up)`],
  ]);
  check(`${d.name} ${mode} slalom`, [[sl.swing >= (pro ? 24 : 36), `heading swings only ${sl.swing}°`], [!tipped(sl), `tipped (up ${sl.minUp})`]]);
  check(`${d.name} ${mode} fishhook`, [[pro || !tipped(fh), `tipped (up ${fh.minUp})`]]);
  check(`${d.name} ${mode} handbrake`, [[pro || !tipped(dr), `tipped (up ${dr.minUp})`], [mode !== 'pilot' || dr.maxBeta > 15, `Racer: no drift (${dr.maxBeta}°)`], [pro || dr.maxBeta < 50, `spun out (${dr.maxBeta}°)`], [pro || dr.endBeta < 8, `still sliding after letting go (${dr.endBeta}°)`]]);
  check(`${d.name} ${mode} brake + steer`, [[!tipped(bt), `tipped (up ${bt.minUp})`], [bt.turned > (pro ? 0 : 25), `ABS: barely turned while braking (${bt.turned}°)`]]);
  return { result, checks };
}
// a kid's own car (KID_CARS()[k]) in one mode: hard turns at 10 and 20 m/s and the fishhook keep it on its wheels
export const KID_CARS = () => carBuilds(12, 7);
export function kidCarChecks(k, d, mode) {
  const checks = [], check = mkCheck(checks);
  if (!d.parts.length) return checks;
  const c = [10, 20].map((v) => circle(d, mode, v)), fh = fishhook(d, mode), up = Math.min(...c.map((x) => x.minUp), fh.minUp);
  if (c[0].nW < 3) return checks; // (a bike, or not a car)
  check(`kid's car ${k} ${mode}: stays on its wheels`, [[up > 0.7, `tipped (up ${up})`]]);
  return checks;
}
// presets: the stock cars (not bikes). Returns { results: [...], checks: [{ name, ok, why }] }  (the browser path, drivecheck.py)
export function plan(presets, modes = ['arcade', 'pilot', 'sim'], { strict = true } = {}) {
  const results = [], checks = [];
  for (const d of presets) for (const mode of modes) { const r = carPlan(d, mode, { strict }); results.push(r.result); checks.push(...r.checks); }
  if (strict) for (const [k, d] of KID_CARS().entries()) for (const mode of modes.filter((m) => m !== 'sim')) checks.push(...kidCarChecks(k, d, mode));
  return { results, checks };
}

// Node tier (tools/test/node/run.mjs): one case per stock car and mode (~0.5 s), and the kid's cars in pairs (Easy and
// Racer, ~1 s). The kid's cars are built once, here (placing their parts the hangar's way is most of
// their cost), and travel in the case.
export const isStockCar = (d) => { const s = analyze(d); return s.car && !s.bike && !s.heli && s.wingArea < 0.5; };
export const nodeSuite = { files: ['src/drive.js', 'src/aircraft.js', 'src/carRig.js', 'src/parts.js', 'src/design.js', 'tools/test/drivecheck.js', 'tools/test/meshcheck.js'], headless: true };
export function cases({ presets }) {
  const kids = KID_CARS().map((d, k) => ({ k, d })), groups = [];
  for (let i = 0; i < kids.length; i += 2) groups.push({ id: `kid's cars ${i}-${i + 1}`, kids: kids.slice(i, i + 2) });
  return [...presets.filter(isStockCar).flatMap((d) => ['arcade', 'pilot', 'sim'].map((mode) => ({ id: `${d.name} ${mode}`, car: d.name, mode }))), ...groups];
}
export function runCase(c, { presets }) {
  if (c.kids) return c.kids.flatMap(({ k, d }) => ['arcade', 'pilot'].flatMap((mode) => kidCarChecks(k, d, mode)));
  const { result: r, checks } = carPlan(presets.find((d) => d.name === c.car), c.mode);
  // (the turning-circle table rides along on the first check, as information: --json keeps it)
  if (checks[0]) checks[0].info = r.circles.map((x) => `${x.v} m/s: r ${x.radius} m ${x.latG} g`).join(', ') + ` | slalom ${r.slalom.swing}°, fishhook up ${r.fishhook.minUp}, handbrake ${r.drift.maxBeta}°, brake + steer ${r.brakeTurn.turned}°`;
  return checks;
}
