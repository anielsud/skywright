// Rooftop helipad check (run in the page by helipadcheck.py). See helipadcheck.py for what it checks. The flight's own
// time is stepped with __sky.advance (no frames drawn), one 1/60 s step at a time so every step can be checked.
import { start as startOn, running, steps } from './padcheck.js';
export { spawn, predict } from './padcheck.js';
const S = window.__sky;

// load a preset and start a flight (swapped into the World already there when it is the same place); resolves as soon
// as the flight exists (before its first step)
const start = (name, location, realism = 'pilot', time = 10) => startOn(name, location, { realism, time });

// how the same vehicle rests on the runway (a fresh one, stepped at 60 Hz on the flight's own ground for 6 s): its
// resting attitude on its skids (up.y) and how far it settles. The pad must hold it exactly the same way.
function runwayRest(F, name, realism, heading) {
  const T = S.THREE, ac = new S.Aircraft(JSON.parse(JSON.stringify(S.presets.find((p) => p.name === name))), S.REALISM[realism]);
  const rw = F.world.runways[0]; ac.spawn(F.env, new T.Vector3(rw.x, 0, rw.len / 2 - 60), heading); ac.x.y -= 0.031; const y0 = ac.x.y; // (resting on it, as on the pad)
  let x2 = null, q2 = null, drift = 0, tilt = 0;
  for (let i = 0; i < 420; i++) {
    ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0 }); ac.brake = 1; ac.step(1 / 60, F.env);
    if (i === 120) { x2 = ac.x.clone(); q2 = ac.q.clone(); } else if (x2) { drift = Math.max(drift, ac.x.distanceTo(x2)); tilt = Math.max(tilt, ac.q.angleTo(q2)); }
  }
  return { up: new T.Vector3(0, 1, 0).applyQuaternion(ac.q).y, sink: y0 - ac.x.y, drift, tilt, contact: gearLow(ac) };
}
// the lowest point of the gear (skid bottoms) in world space, and how many skid points touch
function gearLow(ac) {
  const T = S.THREE, p = new T.Vector3(); let lo = Infinity, n = 0, c = 0;
  const per = [];
  for (const part of ac.parts) if (part.gear) { let k = 0; for (const w of part.gear.wheels) { ac.worldPoint(w.top.clone().addScaledVector(w.dir, w.len + w.r - w.comp), p); lo = Math.min(lo, p.y); n++; if (w.contact) { c++; k++; } } per.push(k); }
  return { lo, n, contact: c, skids: per.length, skidsDown: per.filter((k) => k > 0).length };
}

export async function heli(name = 'Dragonfly', realism = 'pilot', { location = 'nyc', hold = 5, shots = false } = {}) {
  const T = S.THREE, F = await start(name, location, realism), ac = F.ac, W = F.world, H = W.helipads, pad = H?.start;
  const r = { name, realism, location, start: F.cfgStart, pad: pad ? { name: pad.name, deckY: pad.y, roofY: pad.roofY, D: pad.D, heading: pad.heading } : null, stats: H?.stats };
  if (!pad) return r;
  const ev = [], emit = ac.emit.bind(ac); ac.emit = (type, data) => { ev.push({ type, ...data }); emit(type, data); };
  const fwd = () => new T.Vector3(0, 0, -1).applyQuaternion(ac.q), up = () => new T.Vector3(0, 1, 0).applyQuaternion(ac.q).y;
  const off = () => Math.hypot(ac.x.x - pad.W(0, 0, 0).x, ac.x.z - pad.W(0, 0, 0).z);
  const dmg = () => ac.parts.reduce((a, p) => a + p.dmg, 0), alive = () => ac.parts.filter((p) => p.alive).length;
  const rotor = () => ac.parts.filter((p) => p.engine?.type === 'rotor').reduce((a, p) => Math.max(a, p.engine.spoolT || 0), 0);
  const rotorAngle = () => ac.parts.filter((p) => p.engine?.type === 'rotor').map((p) => p.engine.angle);
  // the building and the pad's obstacles: any part inside one (what main.js tests each frame), or a building entry with a damage key
  const hp = new T.Vector3(); let hits = 0;
  const hitCheck = () => { for (const p of ac.parts) if (p.alive && W.treeHit(ac.worldPoint(p.center, hp))) hits++; };
  const g0 = gearLow(ac), f0 = fwd();
  r.spawn = { off: off(), level: up(), gearAboveDeck: g0.lo - pad.y, heading: Math.atan2(-f0.x, -f0.z), engines: F.eng.on, y: ac.x.y };
  // the building under the pad can't be knocked down
  const under = W.towns.hit(new T.Vector3(pad.cx, pad.roofY - 3, pad.cz));
  r.building = { found: !!under, dk: under?.dk ?? null, fixed: !!under?.fixed, top: under ? under[1] + under[3] : null };
  // calm air (gusts are random; a parked helicopter creeps a little in a breeze, on any ground): the same every run
  const W0 = W.W; W.W = { ...W0, wind: 0, turb: 0 }; W.windBase.set(0, 0, 0); W.gust.set(0, 0, 0); W.gustT.set(0, 0, 0);
  r.runway = runwayRest(F, name, realism, pad.heading);
  await running(F);
  // 1. parked: it settles onto its skids (as on a runway: the springs take its weight), then nothing moves for `hold` s
  S.controls.setThrottle(0);
  const a0 = rotorAngle(), ts = F.t; let rot = 0, offG = 0, n = 0, minSkids = 99, settleSink = 0;
  ev.length = 0; hits = 0;
  steps(F, () => { rot = Math.max(rot, rotor()); hitCheck(); return F.t - ts >= 2; });
  settleSink = r.spawn.y - ac.x.y;
  const x0 = ac.x.clone(), q0 = ac.q.clone(), t0 = F.t; let drift = 0, tilt = 0, vmax = 0;
  steps(F, () => { drift = Math.max(drift, ac.x.distanceTo(x0)); tilt = Math.max(tilt, ac.q.angleTo(q0)); vmax = Math.max(vmax, ac.v.length()); if (!ac.onGround) offG++; rot = Math.max(rot, rotor()); minSkids = Math.min(minSkids, gearLow(ac).skidsDown); hitCheck(); n++; return F.t - t0 >= hold; });
  const g1 = gearLow(ac), turned = rotorAngle().reduce((a, x, i) => Math.max(a, Math.abs(x - a0[i])), 0);
  r.hold = { seconds: F.t - t0, settle: F.t - ts - (F.t - t0), settleSink, frames: n, drift, tilt, vmax, offGround: offG, rotor: rot, rotorTurned: turned, engines: F.eng.on, minSkidsDown: minSkids, skids: g1.skids, contact: g1.contact, points: g1.n, gearAboveDeck: g1.lo - pad.y, up: up(), events: [...new Set(ev.map((e) => e.type))], hits, dmg: dmg() };
  // 2. lift off to a hover 25 m up, hold it 4 s
  ev.length = 0; hits = 0;
  let t1 = F.t, maxOff = 0, minUp = 1, liftT = null;
  S.controls.setThrottle(0.8);
  steps(F, () => { hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up()); if (liftT == null && !ac.onGround) liftT = F.t - t1; return ac.x.y - pad.y > 25 || F.t - t1 > 30 || ac.dead; });
  S.controls.setThrottle(0.5);
  const th = F.t; let hy0 = ac.x.y, hyMin = Infinity, hyMax = -Infinity;
  steps(F, () => { hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up()); if (F.t - th > 1.5) { hyMin = Math.min(hyMin, ac.x.y); hyMax = Math.max(hyMax, ac.x.y); } return F.t - th > 5.5 || ac.dead; });
  if (shots) { window.__heliShot = { x: ac.x.toArray() }; }
  r.lift = { liftoffAfter: liftT, height: ac.x.y - pad.y, hoverBand: hyMax - hyMin, maxOff, minUp, events: [...new Set(ev.map((e) => e.type))], hits, dmg: dmg(), alive: alive(), parts: ac.parts.length, engines: F.eng.on, dead: !!ac.dead };
  void hy0;
  // 3. back down: sink at ~2 m/s, slow to ~0.8 m/s for the last few metres, then the collective down
  ev.length = 0; hits = 0;
  const t2 = F.t; let touch = null, vy = 0;
  S.controls.setThrottle(0.3);
  steps(F, () => {
    hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up());
    if (ac.x.y - pad.y < 7) S.controls.setThrottle(0.44);
    if (touch == null && ac.onGround) { touch = { t: F.t - t2, vy: vy, off: off() }; }
    vy = ac.v.y;
    return touch != null || F.t - t2 > 40 || ac.dead;
  });
  S.controls.setThrottle(0);
  const t3 = F.t; let x1 = null, q1 = null, settleDrift = 0, settleTilt = 0, offG2 = 0, minSkids2 = 99;
  steps(F, () => { hitCheck(); if (F.t - t3 > 2 && !x1) { x1 = ac.x.clone(); q1 = ac.q.clone(); } if (x1) { settleDrift = Math.max(settleDrift, ac.x.distanceTo(x1)); settleTilt = Math.max(settleTilt, ac.q.angleTo(q1)); if (!ac.onGround) offG2++; minSkids2 = Math.min(minSkids2, gearLow(ac).skidsDown); } return F.t - t3 > 6 || ac.dead; });
  const g2 = gearLow(ac);
  r.land = { touch, off: off(), level: up(), gearAboveDeck: g2.lo - pad.y, contact: g2.contact, points: g2.n, skids: g2.skids, minSkidsDown: minSkids2, v: ac.v.length(), settleDrift, settleTilt, offGround: offG2,
    events: [...new Set(ev.map((e) => e.type))], hardLanding: ev.some((e) => e.type === 'msg' && /Hard landing/.test(e.text || '')), hits, dmg: dmg(), alive: alive(), parts: ac.parts.length, dead: !!ac.dead, onDeck: pad.onDeck(ac.x.x, ac.x.z, -1) };
  r.maxOff = maxOff; r.minUp = minUp;
  r.inflightCompiles = window.__inflightCompiles || 0;
  return r;
}
