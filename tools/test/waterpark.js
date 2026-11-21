// In-page part of waterpark.py: drives stock boats (and a kid's random boat builds) through a location's water park
// (src/waterPark.js) with scripted inputs (full gas plus a simple lane-keeping steer) on the real flight model at a
// fixed 60 Hz, and reports what happened. Needs a flight at a location with a water park (window.__sky.F with
// world.waterParks). Physics only: the flight is paused and stepped from here. Positions are in the park's own frame
// (stuntKit.js Site: x along the course, z across it, y up from the water).
import { kidBoats } from './boatride.js';

const DT = 1 / 60;
const park = (S) => S.F.world.waterParks.park;
const r2 = (v) => Math.round(v * 100) / 100;

// a fresh vehicle of a design at a park-frame spot, heading along +x (dir 1) or -x (dir -1), afloat
function place(S, design, realism, x, z, dir = 1, v = 0) {
  const F = S.F, P = park(S), ac = new S.Aircraft(JSON.parse(JSON.stringify(design)), S.REALISM[realism]);
  ac.spawn(F.env, P.W(new S.THREE.Vector3(x, 0, z)), P.heading(dir));
  ac.engineRunning = true;
  if (v) ac.v.copy(P.Wd(new S.THREE.Vector3(dir * v, 0, 0)));
  return ac;
}
const preset = (S, name) => S.presets.find((d) => d.name === name);
// step with full gas (or gas(x)), steering to hold lane z (or z(x)) heading dir; trace every frame
// (path(x): follow a curving line z = path(x) instead, looking ahead with the boat's speed: the slalom)
function drive(S, ac, { z, dir = 1, T, until = () => false, gas = () => 1, steer = true, path = null }) {
  const P = park(S), tr = [], fwd = new S.THREE.Vector3(), msgs = [];
  for (let i = 0; i < T / DT; i++) {
    fwd.set(0, 0, -1).applyQuaternion(ac.q);
    const lp = P.Lp(ac.x), fl = P.Ld(fwd), zz = typeof z === 'function' ? z(lp.x) : z, err = (zz - lp.z) * dir, ang = Math.atan2(fl.z * dir, fl.x * dir);
    let roll = steer && ac.up.y > 0.5 ? Math.max(-1, Math.min(1, 0.1 * err - 1.6 * ang)) : 0;
    if (path) { // the line's direction ahead (where the boat will be once it has turned) plus a pull back onto it; damped by the turn rate
      const L = 1.2 * ac.v.length() + 2, want = Math.atan2(path(lp.x + L + 1) - path(lp.x + L - 1), 2) + 0.1 * (path(lp.x + L * 0.5) - lp.z), rate = (ang - (drive.pa ?? ang)) / DT; drive.pa = ang;
      roll = Math.max(-1, Math.min(1, -2 * (ang - want) - 0.6 * rate));
    }
    ac.setControls({ pitch: 0, roll, yaw: 0, throttle: gas(lp.x), rev: 0, hand: 0 });
    ac.step(DT, S.F.env);
    const m = S.F.world.waterParks.drive(ac, DT); if (m) msgs.push(...m.map((x) => x.center || x.toast).filter(Boolean));
    const q = P.Lp(ac.x), wet = ac.boat ? ac.boat.wet : 0;
    tr.push({ t: i * DT, x: q.x, y: q.y, z: q.z, up: ac.up.y, fy: fwd.y, v: ac.v.length(), wet, g: ac.onGround, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead });
    if (ac.dead || until(ac, tr)) break;
  }
  return { tr, msgs };
}
// the longest flight (no contact, out of the water) after x0, and what came after it
function flights(tr, x0 = -1e9) {
  let best = { t: 0 }, i0 = -1;
  for (let i = 0; i < tr.length; i++) {
    const p = tr[i], air = !p.g && p.wet < 0.01 && p.x > x0;
    if (air && i0 < 0) i0 = i;
    if (!air && i0 >= 0) { const t = p.t - tr[i0].t; if (t > best.t) best = { t, i0, i1: i }; i0 = -1; }
  }
  if (best.t <= 0) return { t: 0, maxY: 0, landUp: 1, after: [] };
  const fl = tr.slice(best.i0, best.i1), after = tr.slice(best.i1, best.i1 + 150);
  return { t: best.t, maxY: Math.max(...fl.map((p) => p.y)), x0: tr[best.i0].x, x1: tr[best.i1].x, landUp: Math.min(...after.map((p) => p.up)), endUp: after.at(-1)?.up ?? 1, after, fl };
}

// The MEGA JUMP from the start arch: full gas down the main lane (boost strip, ramp), over the obstacle, splashdown.
export function megaRun(S, design, realism, { from = 'start', T = 70 } = {}) {
  const P = park(S), mega = P.ramps.find((r) => r.name === 'mega'), C = P.splashAt;
  const x0 = from === 'start' ? P.Lp(P.start.pos).x : mega.x0 - 60, ac = place(S, design, realism, x0, 0, 1, from === 'start' ? 0 : 6), parts = ac.parts.length;
  const { tr, msgs } = drive(S, ac, { z: 0, T, until: (a, t) => t.at(-1).x > C.x1 + 10 || (t.at(-1).x > C.x0 + 40 && t.at(-1).wet > 0.02 && t.length > 60 && a.v.length() < 3) });
  const f = flights(tr, mega.x0), obst = P.obstacleAt, over = f.fl ? f.fl.filter((p) => p.x > obst.x0 && p.x < obst.x1) : [];
  const toe = tr.find((p) => p.x > mega.x0), lip = tr.find((p) => p.x > mega.x1 - 0.5), last = tr.at(-1);
  return {
    name: design.name, realism, parts, alive: last.alive, dead: last.dead, frames: tr.length,
    toeSpeed: r2(toe?.v ?? 0), lipSpeed: r2(lip?.v ?? 0), reached: tr.some((p) => p.x > mega.x1),
    air: r2(f.t), maxY: r2(f.maxY), from: r2(f.x0 ?? 0), to: r2(f.x1 ?? 0), overMinY: r2(over.length ? Math.min(...over.map((p) => p.y)) : -9), obstTop: r2(obst.top), cleared: over.length > 0 && Math.min(...over.map((p) => p.y)) > obst.top + 0.5 && (f.x1 ?? 0) > obst.x1,
    landUp: r2(f.landUp), endUp: r2(last.up), maxPitchUp: r2(Math.max(...(f.fl || [{ fy: 0 }]).map((p) => p.fy))), minPitch: r2(Math.min(...(f.fl || [{ fy: 0 }]).map((p) => p.fy))),
    msgs: [...new Set(msgs)],
  };
}
// The kickers' lane: each boat at its own full speed over the small and the medium kicker, then through the hoop.
export function kickerRun(S, design, realism) {
  const P = park(S), K = P.ramps.filter((r) => r.name === 'small' || r.name === 'medium'), H = P.hoops[0];
  const ac = place(S, design, realism, K[0].x0 - 70, K[0].z), parts = ac.parts.length;
  const { tr, msgs } = drive(S, ac, { z: K[0].z, T: 60, until: (a, t) => t.at(-1).x > H.x + 30 });
  const after = tr.filter((p) => p.x > K[0].x0), last = tr.at(-1);
  return { name: design.name, realism, parts, alive: last.alive, dead: last.dead, reachedHoop: last.x > H.x, minUp: r2(Math.min(...after.map((p) => p.up))), endUp: r2(last.up), air: r2(flights(tr, K[0].x0).t), msgs: [...new Set(msgs)] };
}
// The slalom: weaving through the gates (following a line through each gate's middle), then through the waterfall.
export function slalomRun(S, design, realism) {
  const P = park(S), G = P.gates, F = P.falls[0];
  const ac = place(S, design, realism, G[0].x - 45, G[0].zc), parts = ac.parts.length;
  const path = (x) => { const i = G.findIndex((q) => q.x > x); if (i <= 0) return i < 0 ? F.z : G[0].zc; const a = G[i - 1], b = G[i], t = (x - a.x) / (b.x - a.x); return a.zc + ((b.zc - a.zc) * (1 - Math.cos(Math.PI * t))) / 2; }; // (through the middle of each gate)
  drive.pa = null;
  const { tr, msgs } = drive(S, ac, { z: G[0].zc, path, T: 80, gas: () => 0.8, until: (a, t) => t.at(-1).x > F.x + 25 });
  const last = tr.at(-1);
  return { name: design.name, realism, parts, alive: last.alive, dead: last.dead, endX: r2(last.x), minUp: r2(Math.min(...tr.map((p) => p.up))), msgs: [...new Set(msgs)] };
}
// The wrong way: flat out into the back of the MEGA JUMP ramp (and into its side). Nothing breaks off, it isn't wrecked.
export function wrongWay(S, design, realism) {
  const P = park(S), mega = P.ramps.find((r) => r.name === 'mega'), out = [];
  for (const [what, x, z, dir, lane] of [['back', mega.xb + 60, 0, -1, 0], ['side', mega.x0 + mega.L * 0.6, -45, 1, null]]) {
    let ac;
    if (lane == null) { ac = new S.Aircraft(JSON.parse(JSON.stringify(design)), S.REALISM[realism]); ac.spawn(S.F.env, P.W(new S.THREE.Vector3(x, 0, z)), P.yaw); ac.engineRunning = true; } // (heading +z, across the lane)
    else ac = place(S, design, realism, x, z, dir);
    const parts = ac.parts.length, fwd = new S.THREE.Vector3(); let minUp = 1;
    for (let i = 0; i < 14 / DT; i++) { fwd.set(0, 0, -1).applyQuaternion(ac.q); ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 1, rev: 0, hand: 0 }); ac.step(DT, S.F.env); S.F.world.waterParks.drive(ac, DT); minUp = Math.min(minUp, ac.up.y); if (ac.dead) break; }
    const lp = P.Lp(ac.x);
    out.push({ name: design.name, realism, what, parts, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead, past: lane == null ? lp.z > mega.z : lp.x < mega.x0, minUp: r2(minUp), endUp: r2(ac.up.y), endY: r2(lp.y) });
  }
  return out;
}
// The site: open, deep enough water over the course and its margin, nothing built, no bridge, clear of the marina.
export function siteCheck(S) {
  const F = S.F, w = F.world, WP = w.waterParks, P = WP.park, C = P.course, T = S.THREE, M = w.marina, pt = new T.Vector3();
  let n = 0, dry = 0, shallow = 0, built = 0, bridge = 0, minD = Infinity, nearM = Infinity;
  for (let x = C.x0 - C.margin; x <= C.x1 + C.margin; x += 8) for (let z = C.z0 - C.margin; z <= C.z1 + C.margin; z += 8) {
    const p = P.W(new T.Vector3(x, 0, z)), g = w.groundAt(p.x, p.z), inner = x >= C.x0 && x <= C.x1 && z >= C.z0 && z <= C.z1; n++;
    if (g.type !== 'water') { dry++; continue; }
    const d = g.h - w.heightAt(p.x, p.z); if (inner) minD = Math.min(minD, d); if (inner && d < C.depth) shallow++; // (the margin round it: just water)
    if (w.towns?.hit?.(pt.set(p.x, g.h + 2, p.z)) || w.towns?.hit?.(pt.set(p.x, g.h + 6, p.z))) built++;
    if (w.roadSurf?.q(p.x, p.z, true)) bridge++;
    if (M) nearM = Math.min(nearM, Math.hypot(p.x - M.x, p.z - M.z));
  }
  return { site: WP.site, n, dry, shallow, built, bridge, minDepth: r2(minD), marinaDist: Math.round(nearM), stats: WP.stats, wl: r2(P.O.y) };
}
export function run(opts = {}) {
  const S = window.__sky, F = S.F; F.paused = true;
  F.world.gust.set(0, 0, 0); F.world.gustT.set(0, 0, 0); // (the same wind every run: gusts are random)
  const boats = (opts.boats || S.presets.filter((d) => S.analyze(d).boat).map((d) => d.name)).map((n) => preset(S, n)).filter(Boolean), modes = opts.realism || ['arcade', 'pilot'];
  const out = { site: siteCheck(S), mega: [], sim: [], kick: [], slalom: [], wrong: [], kids: [] };
  for (const d of boats) for (const rl of modes) out.mega.push(megaRun(S, d, rl));
  if (opts.sim !== false) for (const d of boats) out.sim.push(megaRun(S, d, 'sim')); // (Sim: no help in the air; reported, not judged)
  for (const d of boats) out.kick.push(kickerRun(S, d, 'arcade'));
  for (const n of ['Jet Ski', 'Pontoon']) if (preset(S, n)) out.slalom.push(slalomRun(S, preset(S, n), 'arcade'));
  for (const d of boats) out.wrong.push(...wrongWay(S, d, 'pilot'));
  // a kid's own boats: random hulls, resized, motors and extras where the hangar would put them; from the boost strip
  for (const d of kidBoats(opts.kids ?? 8, opts.seed ?? 11)) for (const rl of modes) out.kids.push(megaRun(S, d, rl, { from: 'boost', T: 40 }));
  return out;
}
// screenshots: a fresh boat (added to the scene, the flight's own hidden) driven down the main lane until cond(ac) holds
export function stage(name, cond, T = 40, lane = 0, x0 = null) {
  const S = window.__sky, F = S.F, P = park(S); F.paused = true; F.world.gust.set(0, 0, 0);
  if (S.__stageAc) F.scene.remove(S.__stageAc.root);
  F.ac.root.visible = false;
  const ac = place(S, preset(S, name), 'pilot', x0 ?? P.Lp(P.start.pos).x, lane); F.scene.add(ac.root); S.__stageAc = ac;
  drive(S, ac, { z: lane, T, until: (a) => { const q = P.Lp(a.x); return cond(a, q.x, q.y, q.z); } });
  ac.syncVisual?.();
  const q = P.Lp(ac.x); return [q.x, q.y, q.z];
}
