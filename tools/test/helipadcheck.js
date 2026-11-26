// Rooftop helipad check, run by the nyc job (tools/test/jobs/nyc.js). See tools/test/README.md, Rooftop helipad check; heliChecks(r) is its verdicts in JS. The flight's own time is stepped with
// __sky.advance (no frames drawn), one 1/60 s step at a time so every step can be checked; every wait is on a game
// state (padcheck.js start/steps: the harness's waits).
import { start, steps } from './padcheck.js';
export { spawn, predict } from './padcheck.js';
const S = window.__sky;

// the lowest point of the gear (skid bottoms) in world space, and how many skid points touch
function gearLow(ac) {
  const T = S.THREE, p = new T.Vector3(); let lo = Infinity, n = 0, c = 0;
  const per = [];
  for (const part of ac.parts) if (part.gear) { let k = 0; for (const w of part.gear.wheels) { ac.worldPoint(w.top.clone().addScaledVector(w.dir, w.len + w.r - w.comp), p); lo = Math.min(lo, p.y); n++; if (w.contact) { c++; k++; } } per.push(k); }
  return { lo, n, contact: c, skids: per.length, skidsDown: per.filter((k) => k > 0).length };
}
const upOf = (q) => new S.THREE.Vector3(0, 1, 0).applyQuaternion(q).y;

// How the same vehicle rests on the runway: the flight's own helicopter teleported there (put down as Aircraft.spawn
// puts a vehicle on the ground, the 0.031 m a stand start sits lower subtracted, as on the pad) and stepped in the game
// loop for 7 s with the throttle closed: its resting attitude on its skids (up.y), how far it settles, and how much it
// still creeps and tilts over the last 5 s. The pad must hold it exactly the same way.
function runwayRest(F, heading) {
  const T = S.THREE, ac = F.ac, rw = F.world.runways[0];
  S.controls.setThrottle(0);
  ac.spawn(F.env, new T.Vector3(rw.x, 0, rw.len / 2 - 60), heading); ac.x.y -= 0.031; ac.syncVisual();
  const y0 = ac.x.y; let x2 = null, q2 = null, drift = 0, tilt = 0, i = 0;
  steps(F, () => {
    if (i === 121) { x2 = ac.x.clone(); q2 = ac.q.clone(); } else if (x2) { drift = Math.max(drift, ac.x.distanceTo(x2)); tilt = Math.max(tilt, ac.q.angleTo(q2)); }
    return i++ >= 420;
  }, 10);
  return { up: upOf(ac.q), sink: y0 - ac.x.y, drift, tilt, contact: gearLow(ac) };
}

// The helicopter `name` started at `location` (swapped into the World already there), Pilot or Arcade, then heliRun.
export async function heli(name = 'Dragonfly', realism = 'pilot', { location = 'nyc', hold = 5 } = {}) {
  return heliRun(await start(name, location, { realism }), { hold });
}
// The flight F (a helicopter just started; nothing else done with it yet): where it started, then (on a helipad) its
// runway resting baseline, then parked on the pad, a lift to a hover, a landing and a rest, all stepped (no frames
// drawn, nothing awaited). Returns the measurements (heliChecks judges them).
export function heliRun(F = S.F, { hold = 5 } = {}) {
  const T = S.THREE, ac = F.ac, W = F.world, H = W.helipads, pad = H?.start;
  const r = { name: ac.design.name, realism: F.cfg.realism, location: W.loc?.id ?? F.cfg.location, start: F.cfgStart, pad: pad ? { name: pad.name, deckY: pad.y, roofY: pad.roofY, D: pad.D, heading: pad.heading } : null, stats: H?.stats };
  if (!pad) return r;
  const ev = [], own = Object.prototype.hasOwnProperty.call(ac, 'emit'), emit0 = ac.emit, emit = emit0.bind(ac);
  ac.emit = (type, data) => { ev.push({ type, ...data }); emit(type, data); };
  const fwd = () => new T.Vector3(0, 0, -1).applyQuaternion(ac.q), up = () => upOf(ac.q);
  const H0 = pad.W(0, 0, 0), off = (x = ac.x.x, z = ac.x.z) => Math.hypot(x - H0.x, z - H0.z);
  const dmg = () => ac.parts.reduce((a, p) => a + p.dmg, 0), alive = () => ac.parts.filter((p) => p.alive).length;
  const rotor = () => ac.parts.filter((p) => p.engine?.type === 'rotor').reduce((a, p) => Math.max(a, p.engine.spoolT || 0), 0);
  const rotorAngle = () => ac.parts.filter((p) => p.engine?.type === 'rotor').map((p) => p.engine.angle);
  // the building and the pad's obstacles: any part inside one (what main.js tests each frame), or a building entry with a damage key
  const hp = new T.Vector3(); let hits = 0;
  const hitCheck = () => { for (const p of ac.parts) if (p.alive && W.treeHit(ac.worldPoint(p.center, hp))) hits++; };
  // where buildFlight put it (F.spawnPose: before any step); the skids as they rest now (after the warm-up's few steps)
  const P = F.spawnPose, q0s = new T.Quaternion().fromArray(P.q), f0 = new T.Vector3(0, 0, -1).applyQuaternion(q0s), g0 = gearLow(ac);
  r.spawn = { off: off(P.x[0], P.x[2]), level: upOf(q0s), gearAboveDeck: g0.lo - pad.y, heading: Math.atan2(-f0.x, -f0.z), engines: F.eng.on, y: P.x[1] };
  // the building under the pad can't be knocked down
  const under = W.towns.hit(new T.Vector3(pad.cx, pad.roofY - 3, pad.cz));
  r.building = { found: !!under, dk: under?.dk ?? null, fixed: !!under?.fixed, top: under ? under[1] + under[3] : null };
  // calm air (gusts are random; a parked helicopter creeps a little in a breeze, on any ground): the same every run.
  // Put back afterwards (the World is kept for the job's next flights).
  const air = { W: W.W, base: W.windBase.clone(), gust: W.gust.clone(), gustT: W.gustT.clone() };
  W.W = { ...air.W, wind: 0, turb: 0 }; W.windBase.set(0, 0, 0); W.gust.set(0, 0, 0); W.gustT.set(0, 0, 0);
  try {
    // 0. the runway baseline (teleported there), then back to its spawn pose on the pad
    r.runway = runwayRest(F, pad.heading);
    ac.x.fromArray(P.x); ac.q.fromArray(P.q); ac.v.fromArray(P.v); ac.w.set(0, 0, 0); ac.wW?.set(0, 0, 0); ac.syncVisual();
    // 1. parked: it settles onto its skids (as on a runway: the springs take its weight), then nothing moves for `hold` s
    S.controls.setThrottle(0);
    const a0 = rotorAngle(), ts = F.t; let rot = 0, offG = 0, n = 0, minSkids = 99;
    ev.length = 0; hits = 0;
    steps(F, () => { rot = Math.max(rot, rotor()); hitCheck(); return F.t - ts >= 2; });
    const settleSink = r.spawn.y - ac.x.y;
    const x0 = ac.x.clone(), q0 = ac.q.clone(), t0 = F.t; let drift = 0, tilt = 0, vmax = 0;
    steps(F, () => { drift = Math.max(drift, ac.x.distanceTo(x0)); tilt = Math.max(tilt, ac.q.angleTo(q0)); vmax = Math.max(vmax, ac.v.length()); if (!ac.onGround) offG++; rot = Math.max(rot, rotor()); minSkids = Math.min(minSkids, gearLow(ac).skidsDown); hitCheck(); n++; return F.t - t0 >= hold; });
    const g1 = gearLow(ac), turned = rotorAngle().reduce((a, x, i) => Math.max(a, Math.abs(x - a0[i])), 0);
    r.hold = { seconds: F.t - t0, settle: F.t - ts - (F.t - t0), settleSink, frames: n, drift, tilt, vmax, offGround: offG, rotor: rot, rotorTurned: turned, engines: F.eng.on, minSkidsDown: minSkids, skids: g1.skids, contact: g1.contact, points: g1.n, gearAboveDeck: g1.lo - pad.y, up: up(), events: [...new Set(ev.map((e) => e.type))], hits, dmg: dmg() };
    // 2. lift off to a hover 25 m up, hold it 4 s
    ev.length = 0; hits = 0;
    const t1 = F.t; let maxOff = 0, minUp = 1, liftT = null;
    S.controls.setThrottle(0.8);
    steps(F, () => { hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up()); if (liftT == null && !ac.onGround) liftT = F.t - t1; return ac.x.y - pad.y > 25 || F.t - t1 > 30 || ac.dead; });
    S.controls.setThrottle(0.5);
    const th = F.t; let hyMin = Infinity, hyMax = -Infinity;
    steps(F, () => { hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up()); if (F.t - th > 1.5) { hyMin = Math.min(hyMin, ac.x.y); hyMax = Math.max(hyMax, ac.x.y); } return F.t - th > 5.5 || ac.dead; });
    r.lift = { liftoffAfter: liftT, height: ac.x.y - pad.y, hoverBand: hyMax - hyMin, maxOff, minUp, events: [...new Set(ev.map((e) => e.type))], hits, dmg: dmg(), alive: alive(), parts: ac.parts.length, engines: F.eng.on, dead: !!ac.dead };
    // 3. back down: sink at ~2 m/s, slow to ~0.8 m/s for the last few metres, then the collective down
    ev.length = 0; hits = 0;
    const t2 = F.t; let touch = null, vy = 0;
    S.controls.setThrottle(0.3);
    steps(F, () => {
      hitCheck(); maxOff = Math.max(maxOff, off()); minUp = Math.min(minUp, up());
      if (ac.x.y - pad.y < 7) S.controls.setThrottle(0.44);
      if (touch == null && ac.onGround) { touch = { t: F.t - t2, vy, off: off() }; }
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
  } finally {
    W.W = air.W; W.windBase.copy(air.base); W.gust.copy(air.gust); W.gustT.copy(air.gustT);
    if (own) ac.emit = emit0; else delete ac.emit;
  }
  r.inflightCompiles = window.__inflightCompiles || 0;
  return r;
}

// [[name, ok, detail]] for a job's T.checks: helipadcheck.py's verdicts on heli()'s result
export function heliChecks(r) {
  if (!(r.start === 'helipad' && r.pad)) return [['starts on the rooftop helipad', false, `started at ${r.start}, pad ${r.pad?.name ?? 'none'}`]];
  const p = r.pad, s = r.spawn, h = r.hold, l = r.lift, L = r.land, b = r.building, rw = r.runway;
  const any = (events, keys) => keys.filter((k) => events.includes(k));
  const f = (x, d = 2) => (x == null ? String(x) : Number(x).toFixed(d)), e = (x) => Number(x).toExponential(1);
  const dh = Math.abs((((s.heading - p.heading + 3.14159) % 6.28318) + 6.28318) % 6.28318 - 3.14159); // (Python's % in helipadcheck.py: never negative)
  const still = (drift, tilt) => drift < Math.min(0.05, rw.drift * 1.3 + 0.005) && tilt < Math.min(0.01, rw.tilt * 1.3 + 0.002);
  const rwLine = `runway: up ${f(rw.up, 4)}, settles ${f(rw.sink * 100, 1)} cm, creeps ${f(rw.drift * 1000, 1)} mm / tilts ${e(rw.tilt)} rad in 5 s`;
  return [
    ['the building under the pad has no damage key (it cannot be knocked down)', b.found && b.dk == null && b.fixed, `found ${b.found}, damage key ${b.dk}, fixed ${b.fixed}, top ${b.top}`],
    ['spawns on the H', s.off < 0.5, `${f(s.off)} m off the H (pad ${p.name}, deck ${f(p.deckY)} m)`],
    ['spawns level', s.level > 0.999, `up ${f(s.level, 5)}`],
    ['spawns with its skids resting on the deck', Math.abs(s.gearAboveDeck) < 0.01, `skids ${f(s.gearAboveDeck * 100, 1)} cm from the deck`],
    ["spawns facing the pad's view", dh < 0.02, `heading ${f(s.heading, 3)} (pad ${f(p.heading, 3)})`],
    ['spawns with the engines off', !s.engines, `engines ${s.engines}`],
    ['parked for 5 s', h.seconds >= 4.99, `${f(h.seconds, 2)} s`],
    ['parked: the rotor stays stopped', h.rotor < 0.02 && h.rotorTurned < 0.05 && !h.engines, `spool ${f(h.rotor, 4)}, turned ${f(h.rotorTurned, 4)} rad, engines ${h.engines}`],
    ['parked: rests exactly as on a runway', Math.abs(h.up - rw.up) < 0.002 && Math.abs(h.settleSink - rw.sink) < 0.01, `up ${f(h.up, 4)}, settled ${f(h.settleSink * 100, 1)} cm in ${f(h.settle, 1)} s; ${rwLine}`],
    ['parked: does not move (no more than on a runway)', still(h.drift, h.tilt) && h.vmax < 0.08, `drift ${f(h.drift * 1000)} mm, tilt ${e(h.tilt)} rad, vmax ${f(h.vmax, 4)}; ${rwLine}`],
    ['parked: both skids stay on the deck', h.offGround === 0 && h.minSkidsDown === h.skids && Math.abs(h.gearAboveDeck) < 0.03, `off deck ${h.offGround}/${h.frames} steps, skids down >= ${h.minSkidsDown}/${h.skids}, lowest ${f(h.gearAboveDeck * 100, 1)} cm`],
    ['parked: no contact or damage', h.hits === 0 && h.dmg === 0 && !any(h.events, ['impact', 'scrape', 'debris', 'wreck', 'touch']).length, `hits ${h.hits}, dmg ${f(h.dmg, 1)}, events ${h.events.join(',') || 'none'}`],
    ['lifts off to a hover 25 m up', l.liftoffAfter != null && l.height > 24 && !l.dead, `off the deck after ${f(l.liftoffAfter)} s, ${f(l.height, 1)} m up`],
    ['the hover is steady', l.hoverBand < 2.0, `band ${f(l.hoverBand)} m`],
    ['lift-off: no collision or damage', l.hits === 0 && l.dmg === 0 && l.alive === l.parts && !any(l.events, ['impact', 'scrape', 'debris', 'wreck']).length, `hits ${l.hits}, dmg ${f(l.dmg, 1)}, ${l.alive}/${l.parts} parts, events ${l.events.join(',') || 'none'}`],
    ['lands gently', L.touch != null && -L.touch.vy < 1.5 && !L.hardLanding, `touchdown ${JSON.stringify(L.touch)}, hard landing ${L.hardLanding}`],
    ['lands on the deck', L.onDeck && L.off < 3, `${f(L.off)} m off the H, on the deck ${L.onDeck}`],
    ['after landing: rests on the deck as on a runway', Math.abs(L.level - rw.up) < 0.003 && L.minSkidsDown === L.skids && Math.abs(L.gearAboveDeck) < 0.03 && L.offGround === 0,
      `up ${f(L.level, 4)} (runway ${f(rw.up, 4)}), skids down >= ${L.minSkidsDown}/${L.skids}, lowest ${f(L.gearAboveDeck * 100, 1)} cm, off deck ${L.offGround}`],
    ['after landing: still (no more than on a runway)', still(L.settleDrift, L.settleTilt) && L.v < 0.05, `drift ${f(L.settleDrift * 1000)} mm, tilt ${e(L.settleTilt)} rad, v ${f(L.v, 4)}; ${rwLine}`],
    ['landing: no collision or damage', L.hits === 0 && L.dmg === 0 && L.alive === L.parts && !any(L.events, ['impact', 'scrape', 'debris', 'wreck']).length, `hits ${L.hits}, dmg ${f(L.dmg, 1)}, ${L.alive}/${L.parts} parts, events ${L.events.join(',') || 'none'}`],
  ];
}
