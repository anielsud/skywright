// In-page part of stunts.py: drives stock cars through the Grand Canyon stunt park with scripted inputs (gas on, a
// simple lane-keeping steer) on the real flight model at a fixed 60 Hz, and reports what happened. Needs a flight at
// 'canyon' (window.__sky.F with world.stunts). Physics only: the flight is paused and stepped from here.
const DT = 1 / 60;

// a fresh car of the given preset at a park-frame spot, heading along +x (dir 1) or -x (dir -1)
function place(S, name, realism, x, z, dir, v = 0) {
  const F = S.F, P = F.world.stunts, design = JSON.parse(JSON.stringify(S.presets.find((d) => d.name === name)));
  const ac = new S.Aircraft(design, S.REALISM[realism]);
  ac.spawn(F.env, new S.THREE.Vector3(P.O.x + x, 0, P.O.z + z), dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  ac.engineRunning = true;
  if (v) ac.v.set(dir * v, 0, 0);
  return ac;
}
// step with gas on, steering to hold lane z (park frame) along heading dir; trace every frame
function drive(S, ac, { z, dir, T, until = () => false, gas = 1, speed = null, steer = true }) { // speed(x): a speed cap (m/s) at park x, or null

  const P = S.F.world.stunts, O = P.O, tr = [], fwd = new S.THREE.Vector3();
  for (let i = 0; i < T / DT; i++) {
    fwd.set(0, 0, -1).applyQuaternion(ac.q);
    const lz = ac.x.z - O.z, err = (z - lz) * dir, ang = Math.atan2(fwd.z * dir, fwd.x * dir);
    const roll = steer && ac.up.y > 0.5 && ac.onGround ? Math.max(-1, Math.min(1, 0.12 * err - 1.6 * ang)) : 0; // (no steering upside down)
    const cap = typeof speed === 'function' ? speed(ac.x.x - O.x) : speed, g = cap != null ? (ac.v.dot(fwd) < cap ? 1 : 0) : gas;
    ac.setControls({ pitch: 0, roll, yaw: 0, throttle: g, rev: 0, hand: 0 });
    ac.brake = 0;
    ac.step(DT, S.F.env);
    const msgs = P.drive(ac, DT);
    const comp = []; for (const p of ac.parts) if (p.gear) for (const w of p.gear.wheels) comp.push(w.contact ? 1 : 0);
    tr.push({ t: i * DT, x: ac.x.x - O.x, y: ac.x.y - O.y, z: lz, up: ac.up.y, fx: fwd.x, fy: fwd.y, v: ac.v.length(), g: ac.onGround, st: !!ac.stuntUp, w: comp.reduce((a, b) => a + b, 0), nw: comp.length, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead, m: msgs ? msgs.map((m) => m.center || m.toast) : null });
    if (ac.dead || until(ac, tr)) break;
  }
  return tr;
}
const r2 = (v) => Math.round(v * 100) / 100;

// The loop run: from the start arch, straight down the right lane: three kickers / tabletop, boost, round the loop.
export function loopRun(S, name, realism) {
  const P = S.F.world.stunts, L = P.loopInfo, ac = place(S, name, realism, P.start.pos.x - P.O.x, 30 + P.start.lane, 1), parts = ac.parts.length;
  const tr = drive(S, ac, { z: 30 + P.start.lane, dir: 1, T: 40, until: (a, t) => t.at(-1).x > L.exitXpark + 40 });
  // tabletop: air after its lip
  const tt = tr.filter((p) => p.x > -40 && p.x < 0), air = longestAir(tt);
  const loop = tr.filter((p) => p.x > L.entryX - 2 && p.t >= (tr.find((q) => q.x > L.entryX)?.t ?? 1e9));
  const top = loop.reduce((a, p) => (p.y > a.y ? p : a), { y: -1 });
  const inv = loop.filter((p) => p.up < -0.8), invContact = inv.filter((p) => p.w >= p.nw - 1);
  const after = tr.filter((p) => p.x > L.exitXpark + 8);
  const last = tr.at(-1);
  return {
    name, realism, frames: tr.length, parts, alive: last.alive, dead: last.dead,
    tabletop: { air: r2(air.t), landUp: r2(air.landUp), maxY: r2(Math.max(...tt.map((p) => p.y))) },
    entrySpeed: r2(tr.find((p) => p.x > L.entryX)?.v ?? 0),
    loop: { topY: r2(top.y), upAtTop: r2(top.up ?? 1), speedAtTop: r2(top.v ?? 0), invertedFrames: inv.length, invertedOnWheels: invContact.length, minUp: r2(Math.min(...loop.map((p) => p.up))) },
    exit: { reached: after.length > 0, up: r2(after[0]?.up ?? -1), y: r2(after[0]?.y ?? -1), z: r2(after[0]?.z ?? 0), v: r2(after[0]?.v ?? 0), minUpAfter: r2(Math.min(...after.map((p) => p.up), 1)) },
    msgs: [...new Set(tr.flatMap((p) => p.m || []))],
  };
}
// The canyon jump: from the end of the banked turn along straight 2: boost, up the mesa, boost, across the gap, landing.
export function jumpRun(S, name, realism) {
  const P = S.F.world.stunts, G = P.gapAt, ac = place(S, name, realism, 160, -30, -1), parts = ac.parts.length;
  const xs0 = 170 - G.s0, xs1 = 170 - G.s1; // the gap, park x (straight 2 runs towards -x from x = 170)
  const tr = drive(S, ac, { z: -30, dir: -1, T: 30, until: (a, t) => t.at(-1).x < xs1 - 40 });
  const inGap = tr.filter((p) => p.x < xs0 && p.x > xs1), minY = Math.min(...inGap.map((p) => p.y)), air = longestAir(tr);
  const land = tr.filter((p) => p.x < xs1 - 15);
  return {
    name, realism, parts, alive: tr.at(-1).alive, dead: tr.at(-1).dead,
    lipSpeed: r2(tr.find((p) => p.x < xs0)?.v ?? 0), gapMinY: r2(minY), air: r2(air.t), landUp: r2(air.landUp),
    landed: land.length > 0, after: { up: r2(Math.min(...land.map((p) => p.up), 1)), y: r2(land[0]?.y ?? -1) },
  };
}
// The bowl: round the west turn at speed, riding up the wall.
export function bowlRun(S, name, realism, speed = 18) {
  const P = S.F.world.stunts, ac = place(S, name, realism, -110, -30, -1), parts = ac.parts.length;
  const tr = []; let phase = 0;
  drive(S, ac, { z: -30, dir: -1, T: 8, speed, until: (a, t) => t.at(-1).x < -170 });
  // in the bowl: steer to hold the 36 m radius line round the centre (-170, 0)
  const O = P.O, fwd = new S.THREE.Vector3();
  for (let i = 0; i < 12 / DT; i++) {
    fwd.set(0, 0, -1).applyQuaternion(ac.q);
    const cx = ac.x.x - O.x + 170, cz = ac.x.z - O.z, rr = Math.hypot(cx, cz), tang = new S.THREE.Vector3(cz / rr, 0, -cx / rr); // anticlockwise seen from above
    const ang = Math.atan2(fwd.clone().cross(tang).y, fwd.dot(tang));
    const roll = Math.max(-1, Math.min(1, -0.15 * (rr - 36) - 1.5 * ang));
    ac.setControls({ pitch: 0, roll, yaw: 0, throttle: ac.v.dot(fwd) < speed ? 1 : 0, rev: 0, hand: 0 }); ac.brake = 0;
    ac.step(DT, S.F.env); P.drive(ac, DT);
    const right = new S.THREE.Vector3(1, 0, 0).applyQuaternion(ac.q);
    tr.push({ x: ac.x.x - O.x, y: ac.x.y - O.y, z: cz, up: ac.up.y, bank: Math.asin(Math.max(-1, Math.min(1, right.y))) * 57.3, st: !!ac.stuntUp, v: ac.v.length() });
    if (ac.dead || (i > 60 && ac.x.x - O.x > -170 && cz > 0)) break;
  }
  if (window.__bowlTrace) window.__bowlTrace = tr.filter((p, i) => i % 6 === 0).map((p) => [p.x, p.y, p.z, p.up, p.bank, p.st ? 1 : 0, p.v].map((v) => Math.round(v * 100) / 100).join(' '));
  const maxY = Math.max(...tr.map((p) => p.y)), maxBank = Math.max(...tr.map((p) => Math.abs(p.bank)));
  // then on along straight 1 for a few seconds: back on all four wheels, upright
  const after = drive(S, ac, { z: 30, dir: 1, T: 1.5, gas: 0, steer: false }); // (coasting, short of the first kicker)
  const settled = after.slice(-20);
  if (window.__bowlTrace) window.__bowlTrace.push('--', ...after.filter((p, i) => i % 6 === 0).map((p) => [p.x, p.y, p.z, p.up, p.fy, p.w, p.v, p.st ? 1 : 0].map((v) => Math.round(v * 100) / 100).join(' ')));
  return { name, realism, speed, parts, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead, maxY: r2(maxY), maxBank: r2(maxBank), out: r2(tr.at(-1).x), onWall: tr.filter((p) => p.st).length,
    after: { x: r2(after.at(-1).x), z: r2(after.at(-1).z), minUp: r2(Math.min(...after.map((p) => p.up))), up: r2(Math.min(...settled.map((p) => p.up))), wheels: Math.min(...settled.map((p) => p.w)) } };
}
function longestAir(tr) {
  let best = { t: 0, landUp: 1 }, t0 = null;
  for (let i = 0; i < tr.length; i++) {
    const p = tr[i];
    if (!p.g && t0 == null) t0 = p.t;
    if (p.g && t0 != null) { const t = p.t - t0; if (t > best.t) { const later = tr.slice(i, i + 60); best = { t, landUp: Math.min(...later.map((q) => q.up)) }; } t0 = null; }
  }
  return best;
}
// Coasting into the loop at the boost pad's speed (no gas after it) still makes it round; far too slow, you fall off
// the loop, but onto the ground beside it, not through anything.
export function loopSpeeds(S, name, realism) {
  const P = S.F.world.stunts, L = P.loopInfo, z = 30 + P.start.lane;
  const coast = place(S, name, realism, 0, z, 1, 14);
  const t1 = drive(S, coast, { z, dir: 1, T: 10, speed: (x) => (x < 40 ? null : 0), until: (a, t) => t.at(-1).x > L.exitXpark + 20 });
  const slow = place(S, name, realism, L.entryX - 4, z, 1, 11);
  const t2 = drive(S, slow, { z, dir: 1, T: 10, gas: 0 });
  const lo = (tr) => Math.min(...tr.map((p) => p.y));
  return {
    name, realism,
    coast: { inverted: t1.filter((p) => p.up < -0.8 && p.w >= p.nw - 1).length, exitUp: r2(t1.at(-1).up), exitX: r2(t1.at(-1).x), minY: r2(lo(t1)), alive: t1.at(-1).alive, parts: coast.parts.length },
    tooSlow: { topY: r2(Math.max(...t2.map((p) => p.y))), minY: r2(lo(t2)), inverted: t2.filter((p) => p.up < -0.8 && p.w >= p.nw - 1).length, finite: t2.every((p) => Number.isFinite(p.x + p.y + p.z)), endY: r2(t2.at(-1).y), endX: r2(t2.at(-1).x) },
  };
}
// Planes: one set down gently on the mesa top stands on it; one flown into the far mesa's cliff stops at it.
export function planeRuns(S, name = 'Kestrel') {
  const F = S.F, P = F.world.stunts, O = P.O, T = S.THREE, design = JSON.parse(JSON.stringify(S.presets.find((d) => d.name === name)));
  const G = P.gapAt, xTop = 170 - (G.s0 - 9), xCliff = 170 - G.s1; // a spot on mesa A's top, and mesa B's cliff face (park x)
  const step = (ac, T, f) => { const tr = []; for (let i = 0; i < T / DT; i++) { ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: f ?? 0 }); ac.brake = 1; ac.step(DT, F.env); tr.push({ x: ac.x.x - O.x, y: ac.x.y - O.y, g: ac.onGround, dead: ac.dead }); if (ac.dead) break; } return tr; };
  const a = new S.Aircraft(design, S.REALISM.pilot);
  a.spawn(F.env, new T.Vector3(O.x + xTop, 0, O.z - 30), Math.PI / 2, { air: true, alt: O.y + G.h - 1 + 2.2, speed: 0 }); a.gearDown = true; a.gearT = 1;
  const t1 = step(a, 4);
  const b = new S.Aircraft(design, S.REALISM.pilot);
  b.spawn(F.env, new T.Vector3(O.x + xCliff + 10, 0, O.z - 30), Math.PI / 2, { air: true, alt: O.y + 3.5, speed: 45 }); // (in the gap, below the lips)
  let hit = 0; const t2 = []; for (let i = 0; i < 3 / DT; i++) { b.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 }); b.step(DT, F.env); for (const e of b.events.splice(0)) if (e.type === 'impact' || e.type === 'wreck') hit++; t2.push({ x: b.x.x - O.x, v: b.v.length() }); if (b.dead) break; }
  return {
    name,
    land: { topY: r2(G.h - 1), y: r2(t1.at(-1).y), onGround: t1.at(-1).g, dead: !!a.dead, parts: a.parts.filter((p) => p.alive).length, of: a.parts.length },
    crash: { cliffX: r2(xCliff), speed0: 45, speedPast: r2(t2.find((p) => p.x < xCliff)?.v ?? 0), impacts: hit, dead: !!b.dead, alive: b.parts.filter((p) => p.alive).length, of: b.parts.length },
  };
}
export function run(opts = {}) {
  const S = window.__sky, F = S.F; F.paused = true;
  F.world.gust.set(0, 0, 0); F.world.gustT.set(0, 0, 0); // (the same wind every run: gusts are random)
  const P = F.world.stunts, L = P.loopInfo;
  L.entryX = -XS_OFF + L.s0; L.exitXpark = L.entryX + L.exitX;
  const out = { stats: P.stats, loop: [], speeds: [], jump: [], bowl: [], planes: null };
  for (const name of opts.cars || ['Dune Buggy', 'Chomper']) for (const rl of opts.realism || ['pilot']) {
    out.loop.push(loopRun(S, name, rl)); out.speeds.push(loopSpeeds(S, name, rl)); out.jump.push(jumpRun(S, name, rl));
    for (const v of opts.bowlSpeeds || [14, 20, 26]) out.bowl.push(bowlRun(S, name, rl, v));
  }
  out.planes = planeRuns(S);
  return out;
}
const XS_OFF = 170; // straight 1 starts at park x = -170 (stuntPark.js XS)
// debugging: the raw trace of a run (every n-th frame, between park x0 and x1)
export function trace(which, name = 'Dune Buggy', realism = 'pilot', x0 = -1e9, x1 = 1e9, n = 3, o = {}) {
  const S = window.__sky; S.F.paused = true; const P = S.F.world.stunts;
  const ac = which === 'loop' ? place(S, name, realism, o.x ?? P.start.pos.x - P.O.x, 30 + P.start.lane, 1, o.v || 0) : place(S, name, realism, o.x ?? 160, -30, -1, o.v || 0);
  const tr = which === 'loop' ? drive(S, ac, { z: 30 + P.start.lane, dir: 1, T: o.T || 30, speed: o.speed }) : drive(S, ac, { z: -30, dir: -1, T: o.T || 25, speed: o.speed });
  return tr.filter((p, i) => i % n === 0 && p.x > x0 && p.x < x1).map((p) => [p.t, p.x, p.y, p.z, p.up, p.fy, p.v, p.g ? 1 : 0, p.st ? 1 : 0, p.w, p.alive].map((v) => Math.round(v * 100) / 100).join(' '));
}
// screenshots: a fresh car (added to the scene, the flight's own hidden) driven along a lane until cond(ac) holds
export function stage(name, x, z, dir, v, cond, T = 12, speed = null) {
  const S = window.__sky, F = S.F, O = F.world.stunts.O; F.paused = true; F.world.gust.set(0, 0, 0);
  if (S.__stageAc) F.scene.remove(S.__stageAc.root);
  F.ac.root.visible = false;
  const ac = place(S, name, 'pilot', x, z, dir, v); F.scene.add(ac.root); S.__stageAc = ac;
  drive(S, ac, { z, dir, T, speed, until: (a) => cond(a, a.x.x - O.x, a.x.z - O.z) });
  return [ac.x.x - O.x, ac.x.y - O.y, ac.x.z - O.z];
}
