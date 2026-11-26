// In-page part of stunts.py: drives stock cars and bikes through a location's stunt park (and, at the Grand Canyon,
// the daredevil canyon jump) with scripted inputs (gas on, a simple lane-keeping steer) on the real flight model at a
// fixed 60 Hz, and reports what happened. Needs a flight at a location with stunts (window.__sky.F with world.stunts).
// Physics only: the flight is paused and stepped from here. Positions are in the site's own frame (stuntKit.js Site:
// x along the park, z across it), so it works for any placement and heading.
import { stepping } from '../../src/stepClock.js';
import { SonicFX } from '../../src/sonic.js'; // (a staged vehicle gets the heat-glow materials, like every vehicle the game shows: no extra shader variants)
const DT = 1 / 60;
const park = (S) => S.F.world.stunts.park;

// a fresh vehicle of the given preset at a site-frame spot, heading along +x (dir 1) or -x (dir -1)
function place(S, name, realism, x, z, dir, v = 0, site = park(S)) {
  const F = S.F, design = JSON.parse(JSON.stringify(S.presets.find((d) => d.name === name)));
  const ac = new S.Aircraft(design, S.REALISM[realism]);
  ac.spawn(F.env, site.W(new S.THREE.Vector3(x, 0, z)), site.heading(dir));
  ac.engineRunning = true;
  if (v) ac.v.copy(site.Wd(new S.THREE.Vector3(dir * v, 0, 0)));
  return ac;
}
// step with gas on, steering to hold lane z (site frame) along heading dir; trace every frame
function drive(S, ac, { z, dir, T, until = () => false, gas = 1, speed = null, steer = true, site = park(S), msgs = null, rollAt = null }) { // speed(x): a speed cap (m/s) at site x, or null; rollAt(lp, fl): the steering (overrides the lane keeping), or null
  const P = S.F.world.stunts, tr = [], fwd = new S.THREE.Vector3();
  for (let i = 0; i < T / DT; i++) {
    fwd.set(0, 0, -1).applyQuaternion(ac.q);
    const lp = site.Lp(ac.x), fl = site.Ld(fwd), err = (z - lp.z) * dir, ang = Math.atan2(fl.z * dir, fl.x * dir);
    const own = rollAt ? rollAt(lp, fl) : null;
    const roll = own != null ? own : steer && ac.up.y > 0.5 && ac.onGround ? Math.max(-1, Math.min(1, 0.12 * err - 1.6 * ang)) : 0; // (no steering upside down)
    const cap = typeof speed === 'function' ? speed(lp.x) : speed, g = cap != null ? (ac.v.dot(fwd) < cap ? 1 : 0) : gas;
    ac.setControls({ pitch: 0, roll, yaw: 0, throttle: g, rev: 0, hand: 0 });
    ac.brake = 0;
    ac.step(DT, S.F.env);
    const m = P.drive(ac, DT);
    if (m && msgs) msgs.push(...m);
    const q = site.Lp(ac.x), comp = []; for (const p of ac.parts) if (p.gear) for (const w of p.gear.wheels) comp.push(w.contact ? 1 : 0);
    tr.push({ t: i * DT, x: q.x, y: q.y, z: q.z, up: ac.up.y, fy: fwd.y, v: ac.v.length(), vy: ac.v.y, g: ac.onGround, st: !!ac.stuntUp, w: comp.reduce((a, b) => a + b, 0), nw: comp.length, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead, m: m ? m.map((mm) => mm.center || mm.toast) : null });
    if (ac.dead || until(ac, tr)) break;
  }
  return tr;
}
const r2 = (v) => Math.round(v * 100) / 100;
const minUp = (tr) => Math.min(...tr.map((p) => p.up), 1);

// The loop run: from the start arch, straight down the right lane: the kickers (and the tabletop), boost, round the loop.
export function loopRun(S, name, realism) {
  const P = park(S), L = P.loopInfo, Ly = P.L, XS = P.XS, s0 = P.Lp(P.start.pos);
  const ac = place(S, name, realism, s0.x, s0.z, 1), parts = ac.parts.length;
  const tr = drive(S, ac, { z: s0.z, dir: 1, T: 40, until: (a, t) => t.at(-1).x > L.exitXpark + 40 });
  // the jump before the boost: the tabletop, or the last kicker
  const j0 = -XS + (Ly.tabletop ?? Ly.kickers.at(-1)[0]) - 2, j1 = -XS + Ly.loop - 4;
  const tt = tr.filter((p) => p.x > j0 && p.x < j1), air = longestAir(tt);
  const loop = tr.filter((p) => p.x > L.entryX - 2 && p.t >= (tr.find((q) => q.x > L.entryX)?.t ?? 1e9));
  const top = loop.reduce((a, p) => (p.y > a.y ? p : a), { y: -1 });
  const inv = loop.filter((p) => p.up < -0.8), invContact = inv.filter((p) => p.w >= p.nw - 1);
  const after = tr.filter((p) => p.x > L.exitXpark + 8);
  const last = tr.at(-1);
  return {
    name, realism, bike: !!ac.isBike, frames: tr.length, parts, alive: last.alive, dead: last.dead, start: [r2(s0.x), r2(s0.z)], what: Ly.tabletop != null ? 'tabletop' : 'kicker',
    tabletop: { air: r2(air.t), landUp: r2(air.landUp), maxY: r2(Math.max(...tt.map((p) => p.y))) },
    entrySpeed: r2(tr.find((p) => p.x > L.entryX)?.v ?? 0),
    loop: { topY: r2(top.y), upAtTop: r2(top.up ?? 1), speedAtTop: r2(top.v ?? 0), invertedFrames: inv.length, invertedOnWheels: invContact.length, minUp: r2(Math.min(...loop.map((p) => p.up))) },
    exit: { reached: after.length > 0, up: r2(after[0]?.up ?? -1), y: r2(after[0]?.y ?? -1), z: r2(after[0]?.z ?? 0), v: r2(after[0]?.v ?? 0), minUpAfter: r2(minUp(after)) },
    msgs: [...new Set(tr.flatMap((p) => p.m || []))],
  };
}
// The canyon jump: from the end of the banked turn along straight 2: boost, up the mesa, boost, across the gap, landing.
export function jumpRun(S, name, realism) {
  const P = park(S), G = P.gapAt, XS = P.XS, ac = place(S, name, realism, XS - 10, -30, -1), parts = ac.parts.length;
  const xs0 = XS - G.s0, xs1 = XS - G.s1; // the gap, site x (straight 2 runs towards -x from x = XS)
  const tr = drive(S, ac, { z: -30, dir: -1, T: 30, until: (a, t) => t.at(-1).x < xs1 - 40 });
  const inGap = tr.filter((p) => p.x < xs0 && p.x > xs1), minY = Math.min(...inGap.map((p) => p.y)), air = longestAir(tr);
  const land = tr.filter((p) => p.x < xs1 - 15);
  return {
    name, realism, parts, alive: tr.at(-1).alive, dead: tr.at(-1).dead,
    lipSpeed: r2(tr.find((p) => p.x < xs0)?.v ?? 0), gapMinY: r2(minY), air: r2(air.t), landUp: r2(air.landUp),
    landed: land.length > 0, after: { up: r2(minUp(land)), y: r2(land[0]?.y ?? -1) },
  };
}
// The bowl: round the west turn at speed, riding up the wall.
export function bowlRun(S, name, realism, speed = 18) {
  const P = park(S), XS = P.XS, ac = place(S, name, realism, -XS + 60, -30, -1, speed > 28 ? speed : 0), parts = ac.parts.length; // (flat out: already at speed, as off the whoops)
  drive(S, ac, { z: -30, dir: -1, T: 8, speed, until: (a, t) => t.at(-1).x < -XS });
  // in the bowl: steer to hold the 36 m radius line round the centre (-XS, 0)
  const T = S.THREE, fwd = new T.Vector3(), tr = [];
  for (let i = 0; i < 12 / DT; i++) {
    fwd.set(0, 0, -1).applyQuaternion(ac.q);
    const lp = P.Lp(ac.x), fl = P.Ld(fwd), cx = lp.x + XS, cz = lp.z, rr = Math.hypot(cx, cz), tang = new T.Vector3(cz / rr, 0, -cx / rr); // anticlockwise seen from above
    const ang = Math.atan2(fl.clone().cross(tang).y, fl.dot(tang));
    const roll = Math.max(-1, Math.min(1, -0.15 * (rr - 36) - 1.5 * ang));
    ac.setControls({ pitch: 0, roll, yaw: 0, throttle: ac.v.dot(fwd) < speed ? 1 : 0, rev: 0, hand: 0 }); ac.brake = 0;
    ac.step(DT, S.F.env); S.F.world.stunts.drive(ac, DT);
    const q = P.Lp(ac.x), right = P.Ld(new T.Vector3(1, 0, 0).applyQuaternion(ac.q));
    tr.push({ x: q.x, y: q.y, z: q.z, d: Math.hypot(q.x + XS, q.z) - 30, up: ac.up.y, bank: Math.asin(Math.max(-1, Math.min(1, right.y))) * 57.3, st: !!ac.stuntUp, v: ac.v.length() });
    if (ac.dead || (i > 60 && q.x > -XS && q.z > 0)) break;
  }
  const maxY = Math.max(...tr.map((p) => p.y)), maxBank = Math.max(...tr.map((p) => Math.abs(p.bank)));
  // then on along straight 1 for a moment: back on its wheels, upright
  const after = drive(S, ac, { z: 30, dir: 1, T: 1.5, gas: 0, steer: false }); // (coasting, short of the first kicker)
  const settled = after.slice(-20);
  return { name, realism, speed, parts, alive: ac.parts.filter((p) => p.alive).length, dead: !!ac.dead, maxY: r2(maxY), maxD: r2(Math.max(...tr.filter((p) => p.x < -XS).map((p) => p.d))), rimA: r2(P.bowlInfo.rimA), maxBank: r2(maxBank), out: r2(tr.at(-1).x), onWall: tr.filter((p) => p.st).length,
    after: { x: r2(after.at(-1).x), z: r2(after.at(-1).z), minUp: r2(minUp(after)), up: r2(Math.min(...settled.map((p) => p.up))), wheels: Math.min(...settled.map((p) => p.w)), of: after[0].nw } };
}
// The east turn, as a kid rides it: from the start arch, full gas all the way, steering down the lane to the loop, then
// hands off: through the loop, over the rumble strip, round the banked turn (Arcade and Pilot steer you round it), and
// on down straight 2 (steering again, to the mesa jump's boost). Never over the barrier on the berm's top; at the Grand
// Canyon, not off down the link lane to the canyon jump either.
export function turnRun(S, name, realism) {
  const P = park(S), XS = P.XS, s0 = P.Lp(P.start.pos), ac = place(S, name, realism, s0.x, s0.z, 1), parts = ac.parts.length;
  const keep = (lp, fl, z, dir) => Math.max(-1, Math.min(1, 0.12 * (z - lp.z) * dir - 1.6 * Math.atan2(fl.z * dir, fl.x * dir)));
  const rollAt = (lp, fl) => (!ac.onGround || ac.up.y < 0.5 ? 0 : lp.z > 0 ? (lp.x < P.loopInfo.entryX ? keep(lp, fl, s0.z, 1) : 0) : lp.x < XS ? keep(lp, fl, -30, -1) : 0);
  const tr = drive(S, ac, { z: s0.z, dir: 1, T: 40, rollAt, until: (a, t) => { const p = t.at(-1); return (p.z < 0 && p.x < XS - 40) || p.x > XS + 60; } });
  const turn = tr.filter((p) => p.x > XS - 2), d = (p) => Math.hypot(p.x - XS, p.z) - 30, end = tr.at(-1);
  return { name, realism, parts, alive: end.alive, dead: end.dead, entry: r2(turn[0]?.v ?? 0), maxV: r2(Math.max(...turn.map((p) => p.v))), maxD: r2(Math.max(...turn.map(d))), maxY: r2(Math.max(...turn.map((p) => p.y))),
    minUp: r2(minUp(turn)), end: { x: r2(end.x), z: r2(end.z), up: r2(end.up), v: r2(end.v) }, edge: 7, round: end.z < 0 && end.x < XS - 40 };
}
// At the Grand Canyon: steering towards the jump at the fork (held right for a moment at the end of straight 1, as a kid
// picks it) takes the link lane, and on onto the canyon jump's run-up.
export function forkRun(S, name, realism) {
  const P = park(S), E = S.F.world.stunts.evel, XS = P.XS, s0 = P.Lp(P.start.pos), e0 = E.Lp(E.start.pos), ac = place(S, name, realism, s0.x, s0.z, 1);
  const keep = (lp, fl, z) => Math.max(-1, Math.min(1, 0.12 * (z - lp.z) - 1.6 * Math.atan2(fl.z, fl.x)));
  const rollAt = (lp, fl) => (!ac.onGround || ac.up.y < 0.5 ? 0 : lp.x < P.loopInfo.entryX ? keep(lp, fl, s0.z) : lp.x < XS - 10 ? 0 : lp.x < XS + 8 ? 0.6 : keep(lp, fl, 30));
  E.st.phase = 'idle';
  const tr = drive(S, ac, { z: s0.z, dir: 1, T: 30, rollAt, until: (a) => E.Lp(a.x).x > e0.x + 15 || P.Lp(a.x).z < 0 });
  const e = E.Lp(ac.x), end = tr.at(-1);
  return { name, realism, onRunUp: e.x > e0.x + 15 && Math.abs(e.z) < 8, runUp: { x: r2(e.x - e0.x), z: r2(e.z) }, park: { x: r2(end.x), z: r2(end.z) }, up: r2(ac.up.y), dead: !!ac.dead };
}
function longestAir(tr) {
  let best = { t: 0, landUp: 1 }, t0 = null;
  for (let i = 0; i < tr.length; i++) {
    const p = tr[i];
    if (!p.g && t0 == null) t0 = p.t;
    if (p.g && t0 != null) { const t = p.t - t0; if (t > best.t) { const later = tr.slice(i, i + 60); best = { t, landUp: minUp(later), i }; } t0 = null; }
  }
  return best;
}
// Coasting into the loop at the boost pad's speed (no gas after it) still makes it round; far too slow, you fall off
// the loop, but onto the ground beside it, not through anything.
export function loopSpeeds(S, name, realism) {
  const P = park(S), L = P.loopInfo, z = 30 + P.start.lane, bx = -P.XS + P.L.boost, k2 = -P.XS + P.L.kickers.at(-1)[0] + 8;
  const coast = place(S, name, realism, bx - Math.min(23, bx - k2 - 4), z, 1, 14); // (on the flat after the last kicker)
  const t1 = drive(S, coast, { z, dir: 1, T: 10, speed: (x) => (x < bx + 17 ? null : 0), until: (a, t) => t.at(-1).x > L.exitXpark + 20 });
  const slow = place(S, name, realism, L.entryX - 4, z, 1, 11);
  const t2 = drive(S, slow, { z, dir: 1, T: 10, gas: 0 });
  const lo = (tr) => Math.min(...tr.map((p) => p.y));
  return {
    name, realism, exitXpark: r2(L.exitXpark),
    coast: { inverted: t1.filter((p) => p.up < -0.8 && p.w >= p.nw - 1).length, exitUp: r2(t1.at(-1).up), exitX: r2(t1.at(-1).x), minY: r2(lo(t1)), alive: t1.at(-1).alive, parts: coast.parts.length },
    tooSlow: { topY: r2(Math.max(...t2.map((p) => p.y))), minY: r2(lo(t2)), inverted: t2.filter((p) => p.up < -0.8 && p.w >= p.nw - 1).length, finite: t2.every((p) => Number.isFinite(p.x + p.y + p.z)), endY: r2(t2.at(-1).y), endX: r2(t2.at(-1).x) },
  };
}
// Planes: one set down gently on the mesa top stands on it; one flown into the far mesa's cliff stops at it.
export function planeRuns(S, name = 'Kestrel') {
  const F = S.F, P = park(S), T = S.THREE, design = JSON.parse(JSON.stringify(S.presets.find((d) => d.name === name)));
  const G = P.gapAt, xTop = P.XS - (G.s0 - 9), xCliff = P.XS - G.s1; // a spot on mesa A's top, and mesa B's cliff face (site x)
  const step = (ac, Tt) => { const tr = []; for (let i = 0; i < Tt / DT; i++) { ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0 }); ac.brake = 1; ac.step(DT, F.env); tr.push({ y: P.Lp(ac.x).y, g: ac.onGround, dead: ac.dead }); if (ac.dead) break; } return tr; };
  const a = new S.Aircraft(design, S.REALISM.pilot), pa = P.W(new T.Vector3(xTop, 0, -30));
  a.spawn(F.env, pa, P.heading(-1), { air: true, alt: P.O.y + G.h - 1 + 2.2, speed: 0 }); a.gearDown = true; a.gearT = 1;
  const t1 = step(a, 4);
  const b = new S.Aircraft(design, S.REALISM.pilot), pb = P.W(new T.Vector3(xCliff + 10, 0, -30));
  b.spawn(F.env, pb, P.heading(-1), { air: true, alt: P.O.y + 3.5, speed: 45 }); // (in the gap, below the lips)
  let hit = 0; const t2 = []; for (let i = 0; i < 3 / DT; i++) { b.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 }); b.step(DT, F.env); for (const e of b.events.splice(0)) if (e.type === 'impact' || e.type === 'wreck') hit++; t2.push({ x: P.Lp(b.x).x, v: b.v.length() }); if (b.dead) break; }
  return {
    name,
    land: { topY: r2(G.h - 1), y: r2(t1.at(-1).y), onGround: t1.at(-1).g, dead: !!a.dead, parts: a.parts.filter((p) => p.alive).length, of: a.parts.length },
    crash: { cliffX: r2(xCliff), speed0: 45, speedPast: r2(t2.find((p) => p.x < xCliff)?.v ?? 0), impacts: hit, dead: !!b.dead, alive: b.parts.filter((p) => p.alive).length, of: b.parts.length },
  };
}
// The daredevil canyon jump: from its start, full gas (the lane keeps you straight): the rocket strip, the ramp, over
// the canyon, onto the landing ramp, the brake parachute.
// The long run-up: from the park's start arch flat out down straight 1 (the kickers, the boost, round the loop), the fork
// to the link lane, the jump's run-up (on the rocket strip at zE = 0, or beside it at zE = +-4.5: no boost) and over.
export function longRun(S, name, realism, zE = 0) {
  const P = park(S), E = S.F.world.stunts.evel, EP = E.P, XS = P.XS, s0 = P.Lp(P.start.pos), ac = place(S, name, realism, s0.x, s0.z, 1), parts = ac.parts.length, msgs = [];
  const keep = (lp, fl, z) => Math.max(-1, Math.min(1, 0.12 * (z - lp.z) - 1.6 * Math.atan2(fl.z, fl.x)));
  const rollAt = (lp, fl) => { if (!ac.onGround || ac.up.y < 0.5) return 0; const e = E.Lp(ac.x); if (e.x > EP.runStart - 20) { const f = E.Ld(new S.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q)), far = Math.abs(zE - e.z) > 1.5, r = Math.max(-1, Math.min(1, (far ? 0.12 : 0.05) * (zE - e.z) - (far ? 1.6 : 0.8) * Math.atan2(f.z, f.x))); return e.x < EP.ramp0 && Math.abs(r) > 0.04 ? r : 0; } return lp.x < P.loopInfo.entryX ? keep(lp, fl, s0.z) : lp.x < XS - 10 ? 0 : lp.x < XS + 8 ? 0.6 : keep(lp, fl, 30); };
  E.st.phase = 'idle';
  const tr = drive(S, ac, { z: s0.z, dir: 1, T: 60, rollAt, msgs, until: (a, t) => { const e = E.Lp(a.x); return (e.x > EP.gap + 40 && a.onGround && a.v.length() < 6) || e.y < -150 || P.Lp(a.x).z < 0; } });
  // speeds in the jump's frame (the trace is in the park's)
  const W = (p) => E.Lp(P.W(new S.THREE.Vector3(p.x, p.y, p.z))), et = tr.map((p) => ({ ...p, ...W(p) }));
  const at = (x) => et.find((p) => p.x > x), air = longestAir(et), landed = et[air.i] || et.at(-1), end = et.at(-1);
  return { name, realism, zE, parts, alive: end.alive, dead: end.dead, planned: r2(EP.v0), gap: r2(EP.gap), runUp: r2(EP.ramp0 - EP.runStart),
    zStrip: r2(Math.max(0, ...et.filter((p) => p.x > EP.ramp0 - 172 && p.x < EP.ramp0).map((p) => Math.abs(p.z)))), vFork: r2(tr.find((p) => p.x > XS)?.v ?? 0), vStrip: r2(at(EP.ramp0 - 172)?.v ?? 0), vFoot: r2(at(EP.ramp0)?.v ?? 0), vLip: r2(at(-8)?.v ?? 0), zLip: r2(at(-8)?.z ?? 99),
    air: r2(air.t), peakY: r2(Math.max(...et.map((p) => p.y))), touchX: r2(landed.x), touchV: r2(landed.v), landUp: r2(air.landUp), endX: r2(end.x), endY: r2(end.y), runEnd: r2(EP.runEnd),
    onFarSide: end.x > EP.gap + 10 && end.y > EP.yB - 3, msgs: [...new Set(msgs.map((m) => m.center || m.toast).filter(Boolean))] };
}
export function evelRun(S, name, realism) {
  const E = S.F.world.stunts.evel, P = E.P, s0 = E.Lp(E.start.pos);
  const ac = place(S, name, realism, s0.x, 0, 1, 0, E), parts = ac.parts.length, msgs = [];
  E.st.phase = 'idle';
  const tr = drive(S, ac, { z: 0, dir: 1, T: 35, steer: false, site: E, msgs, until: (a, t) => (t.at(-1).x > P.gap + 40 && t.at(-1).g && a.v.length() < 6) || t.at(-1).y < -150 });
  const lipI = tr.findIndex((p) => p.x > -8), air = longestAir(tr), over = tr.filter((p) => p.x > 0 && p.x < P.gap);
  const land = tr.filter((p, i) => i > (air.i ?? 0)), landed = tr[air.i] || tr.at(-1), end = tr.at(-1);
  return {
    name, realism, parts, alive: end.alive, dead: end.dead, gap: r2(P.gap), dip: r2(P.dip), plannedSpeed: r2(P.v0),
    stripSpeed: r2(Math.max(...tr.filter((p) => p.x < P.ramp0).map((p) => p.v))), lipSpeed: r2(tr[lipI]?.v ?? 0), lipZ: r2(tr[lipI]?.z ?? 99),
    air: r2(air.t), peakY: r2(Math.max(...tr.map((p) => p.y))), minYOverGap: r2(Math.min(...over.map((p) => p.y))),
    touchX: r2(landed.x), touchY: r2(landed.y), touchV: r2(landed.v), landUp: r2(air.landUp), minUpAfter: r2(minUp(land)), endX: r2(end.x), endV: r2(end.v), endZ: r2(end.z), runEnd: r2(P.runEnd),
    onFarSide: end.x > P.gap + 10 && end.y > P.yB - 3, chute: msgs.some((m) => m.center === 'YOU MADE IT!'), slowmo: msgs.some((m) => m.slowmo), msgs: [...new Set(msgs.map((m) => m.center || m.toast))],
  };
}
// Too slow for the jump (no rocket strip: from the ramp's foot at 30 m/s): the rescue parachute lowers you into the canyon.
export function evelShort(S, name = 'Dune Buggy') {
  const E = S.F.world.stunts.evel, P = E.P, ac = place(S, name, 'pilot', P.ramp0 + 2, 0, 1, 30, E), msgs = [];
  E.st.phase = 'run';
  const tr = drive(S, ac, { z: 0, dir: 1, T: 40, gas: 0, steer: false, site: E, msgs, until: (a, t) => t.at(-1).g && t.at(-1).x > 0 && t.length > 120 });
  const fall = tr.filter((p) => p.x > 0 && !p.g), vmin = Math.min(...fall.map((p) => p.vy)), end = tr.at(-1);
  return { name, chute: msgs.some((m) => m.center === 'PARACHUTE!'), fastestFall: r2(vmin), touchVy: r2(tr.at(-2)?.vy ?? 0), air: r2(fall.length * DT), endY: r2(end.y), endUp: r2(end.up), alive: end.alive, parts: ac.parts.length, dead: end.dead };
}
export function run(opts = {}) {
  const S = window.__sky, F = S.F; F.paused = true;
  F.world.gust.set(0, 0, 0); F.world.gustT.set(0, 0, 0); // (the same wind every run: gusts are random)
  const P = park(S), out = { stats: F.world.stunts.stats, site: F.world.stuntPlan.site, loop: [], speeds: [], jump: [], bowl: [], turn: [], fork: [], planes: null, evel: [], evelShort: null, longRun: [] };
  for (const name of opts.cars || ['Dune Buggy', 'Chomper']) for (const rl of opts.realism || ['pilot']) {
    out.loop.push(loopRun(S, name, rl));
    if (opts.full !== false) { out.speeds.push(loopSpeeds(S, name, rl)); out.jump.push(jumpRun(S, name, rl)); for (const v of opts.bowlSpeeds || [14, 20, 26, 34]) out.bowl.push(bowlRun(S, name, rl, v)); out.turn.push(turnRun(S, name, rl)); if (P.link && F.world.stunts.evel) out.fork.push(forkRun(S, name, rl)); }
    if (F.world.stunts.evel && opts.evel !== false) out.evel.push(evelRun(S, name, rl));
    if (F.world.stunts.evel && opts.evel !== false && P.link) { out.longRun.push(longRun(S, name, rl, 0)); if (name === (opts.cars || ['Dune Buggy'])[0]) out.longRun.push(longRun(S, name, rl, 5.6)); }
  }
  if (opts.planes !== false && P.L.tabletop != null) out.planes = planeRuns(S);
  if (F.world.stunts.evel && opts.evel !== false) out.evelShort = evelShort(S);
  return out;
}
// debugging: the raw trace of a run (every n-th frame, between site x0 and x1)
export function trace(which, name = 'Dune Buggy', realism = 'pilot', x0 = -1e9, x1 = 1e9, n = 3, o = {}) {
  const S = window.__sky; S.F.paused = true; const P = park(S), E = S.F.world.stunts.evel;
  let tr;
  if (which === 'evel') { const s0 = E.Lp(E.start.pos), ac = place(S, name, realism, o.x ?? s0.x, 0, 1, o.v || 0, E); E.st.phase = 'idle'; tr = drive(S, ac, { z: 0, dir: 1, T: o.T || 30, steer: false, site: E }); }
  else if (which === 'loop') { const s0 = P.Lp(P.start.pos), ac = place(S, name, realism, o.x ?? s0.x, s0.z, 1, o.v || 0); tr = drive(S, ac, { z: s0.z, dir: 1, T: o.T || 30, speed: o.speed }); }
  else { const ac = place(S, name, realism, o.x ?? P.XS - 10, -30, -1, o.v || 0); tr = drive(S, ac, { z: -30, dir: -1, T: o.T || 25, speed: o.speed }); }
  return tr.filter((p, i) => i % n === 0 && p.x > x0 && p.x < x1).map((p) => [p.t, p.x, p.y, p.z, p.up, p.fy, p.v, p.g ? 1 : 0, p.st ? 1 : 0, p.w, p.alive, p.m ? p.m.join('|') : ''].map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(' '));
}
// screenshots: a fresh vehicle (added to the scene, the flight's own hidden) driven along a lane until cond(ac) holds
export function stage(name, x, z, dir, v, cond, T = 12, speed = null, which = 'park', steer = true) {
  const S = window.__sky, F = S.F, site = which === 'evel' ? F.world.stunts.evel : park(S); F.paused = true; F.world.gust.set(0, 0, 0);
  if (S.__stageAc) F.scene.remove(S.__stageAc.root);
  F.ac.root.visible = false;
  const ac = place(S, name, 'pilot', x, z, dir, v, site); F.scene.add(ac.root); new SonicFX(ac, F.scene); S.__stageAc = ac;
  if (which === 'evel') site.st.phase = 'idle';
  drive(S, ac, { z, dir, T, speed, site, steer, until: (a) => { const q = site.Lp(a.x); return cond(a, q.x, q.z, q.y); } });
  ac.syncVisual?.();
  const q = site.Lp(ac.x); return [q.x, q.y, q.z];
}

// The park's site: dry, flat and clear (no water, buildings, roads, woods or, where the place asks, tree canopy)
export function siteCheck(S) {
  const w = S.F.world, P = w.stuntPlan, R = w.real, k = w.stunts.park, L = P.layout; let n = 0, wet = 0, bare = 0, wood = 0, can = 0, lo = Infinity, hi = -Infinity;
  const c = { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }, lerp(o, t) { this.r += (o.r - this.r) * t; this.g += (o.g - this.g) * t; this.b += (o.b - this.b) * t; return this; } };
  for (let x = -L.pad[0]; x <= L.pad[0]; x += 8) for (let z = -L.pad[1]; z <= L.pad[1]; z += 8) {
    const p = k.W(new S.THREE.Vector3(x, 0, z)), h = w.height(p.x, p.z); n++;
    lo = Math.min(lo, h); hi = Math.max(hi, h); if (h < w.waterLevel + 0.5 || R.waterAt(p.x, p.z) != null) wet++; if (R.bare(p.x, p.z)) bare++; if ((R.forest(p.x, p.z) ?? 0) > 0.5) wood++;
    R.color(p.x, p.z, c); const s = c.r + c.g + c.b; if (s / 3 < 0.315 && (2 * c.g - c.r - c.b) / s > 0.08) can++;
  }
  const g = w.groundAt(k.start.pos.x, k.start.pos.z), cfg = w.loc.stunts, site = P.site;
  const fixed = !!(site.fixed || site.atJump), woodOK = (cfg.maxForest ?? 0.25) > 0.5 ? 1e9 : 0, canopyOK = cfg.canopy ? (cfg.maxCanopy ?? 0.12) + 0.03 : 1, range = hi - lo, canopy = can / n;
  const ok = wet === 0 && range < (fixed ? 40 : 12) && (fixed || (bare === 0 && wood <= woodOK && canopy <= canopyOK));
  const why = `(${site.x.toFixed(0)}, ${site.z.toFixed(0)}) yaw ${(site.yaw * 57.2958).toFixed(0)}, ${(Math.hypot(k.O.x, k.O.z) / 1000).toFixed(1)} km from the runway; ground range ${range.toFixed(1)} m, water ${wet}, buildings/roads ${bare}, woods ${wood}, canopy ${(canopy * 100).toFixed(0)}% of ${n} points; start ${(g.h - k.O.y).toFixed(2)} m off the pad; planned in ${P.ms} ms`;
  return { ok, why, site: { x: site.x, z: site.z, yaw: site.yaw }, n, wet, bare, wood, canopy, range, fixed };
}
// A car or bike started the way main.js starts one at World.landStart(start) ('park', 'road', 'evel'), left a second
// with the brake on: where it is, which way it faces, and whether any part of it is in a building or a tree
export function startAt(S, name, start) {
  const w = S.F.world, s = w.landStart(start); if (!s) return null;
  const ac = new S.Aircraft(JSON.parse(JSON.stringify(S.presets.find((d) => d.name === name))), S.REALISM.pilot);
  const at = s.at ? s.at(0) : s.pos;
  // (the trees round it: Flora grows them near the camera; a fixed amount of work per call, not 100 ms of it, so how far
  // it gets doesn't depend on the machine: stepClock.js)
  if (w.flora?.update) stepping(() => { for (let i = 0; i < 60; i++) { w.flora.update(at, 100); if (!w.flora.queue?.some((q) => q.d < 400)) break; } });
  ac.spawn(S.F.env, at, s.heading);
  for (let i = 0; i < 60; i++) { ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0 }); ac.brake = 1; ac.step(DT, S.F.env); }
  const f = new S.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q), ax = new S.THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading)), g = w.groundAt(ac.x.x, ac.x.z);
  let hit = 0; for (const p of ac.parts) for (const h of p.hull) if (w.treeHit(ac.worldPoint(h, new S.THREE.Vector3()))) hit++;
  return { d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), car: ac.isCar, bike: !!ac.isBike, ground: g.type, onRoad: w.nearRoad ? w.nearRoad(ac.x.x, ac.x.z, 2) : null, hit,
    evel: start !== 'evel' || s === w.stunts.evel?.start, road: s.id === 'road' ? { x: Math.round(s.pos.x), z: Math.round(s.pos.z), dist: s.dist } : null };
}

// [name, ok, why] for every assertion on a report of runs (run()'s shape: loop, speeds, jump, bowl, turn, ...)
export function judge(r, loc) {
  const out = [], add = (name, ok, why = '') => out.push([`${loc}: ${name}`, !!ok, why]);
  for (const l of r.loop || []) {
    const n = `${l.name} (${l.realism})`, tt = l.tabletop, lp = l.loop, ex = l.exit;
    add(`${n}: ${l.what} jump, lands upright`, tt.air > 0.3 && tt.landUp > 0.8, `air ${tt.air} s, lowest up ${tt.landUp}`);
    add(`${n}: loop entry speed`, l.entrySpeed > 21, `${l.entrySpeed} m/s`);
    add(`${n}: over the top of the loop`, lp.topY > 17 && lp.upAtTop < -0.9, `top ${lp.topY} m, up ${lp.upAtTop}`);
    add(`${n}: upside down on its wheels`, lp.invertedOnWheels >= 8 && lp.invertedOnWheels >= lp.invertedFrames - 2, `${lp.invertedOnWheels}/${lp.invertedFrames} frames`);
    add(`${n}: out of the loop upright, exit lane`, ex.reached && ex.up > (l.bike ? 0.8 : 0.9) && ex.y < 2.5 && Math.abs(ex.z - 26.5) < 2.5 && ex.minUpAfter > 0.8, `up ${ex.up}, y ${ex.y}, z ${ex.z}, ${ex.v} m/s`);
    add(`${n}: nothing broke on the loop run`, l.alive === l.parts && !l.dead, `${l.alive}/${l.parts} parts`);
  }
  for (const s of r.speeds || []) {
    const n = `${s.name} (${s.realism})`, c = s.coast, t = s.tooSlow;
    add(`${n}: coasting from the boost loops`, c.inverted >= 8 && c.exitUp > 0.9 && c.exitX > s.exitXpark + 10 && c.alive === c.parts, `${c.inverted} frames inverted, out at x ${c.exitX}`);
    add(`${n}: too slow rolls back, stays out of the ground`, t.topY < 12 && t.inverted === 0 && t.finite && t.minY > 0.3, `top ${t.topY} m, lowest ${t.minY} m`);
  }
  for (const j of r.jump || []) {
    const n = `${j.name} (${j.realism})`;
    add(`${n}: mesa jump clears the gap`, j.gapMinY > 5 && j.air > 1.0, `lip ${j.lipSpeed} m/s, ${j.air} s air, lowest over the gap ${j.gapMinY} m`);
    add(`${n}: mesa jump lands upright`, j.landUp > 0.8 && j.landed && j.after.up > 0.8 && j.alive === j.parts, `lowest up after landing ${j.landUp}, ${j.alive}/${j.parts} parts`);
  }
  for (const b of r.bowl || []) { // (flat out, a motorbike rides right up to the lip: the catch fence holds it there; it must not go over the top)
    const a = b.after;
    add(`${b.name} (${b.realism}) bowl at ${b.speed} m/s`, b.onWall > 60 && b.maxBank > 25 && b.maxY < (b.speed > 28 ? 9 : 8) && b.maxD <= b.rimA + 0.05 && a.up > 0.9 && a.wheels >= Math.min(3, a.of) && b.alive === b.parts,
      `bank up to ${b.maxBank} deg, ${b.maxY} m up the wall, ${b.maxD} m out (lip ${b.rimA}), out: up ${a.up}, ${a.wheels}/${a.of} wheels down`);
  }
  for (const t of r.turn || []) {
    const e = t.end;
    add(`${t.name} (${t.realism}) loop -> banked turn, hands off: round it, never over the barrier`, t.round && t.maxD <= t.edge && t.minUp > 0.7 && Math.abs(e.z + 30) < 4 && e.up > 0.9 && t.alive === t.parts && !t.dead,
      `in at ${t.entry} m/s (up to ${t.maxV}), ${t.maxD} m out (kerb ${t.edge}), up to ${t.maxY} m, lowest up ${t.minUp}; out at x ${e.x}, z ${e.z}, up ${e.up}, ${t.alive}/${t.parts} parts`);
  }
  for (const f of r.fork || []) add(`${f.name} (${f.realism}) steered onto the link lane at the fork reaches the canyon jump's run-up`, f.onRunUp && f.up > 0.8 && !f.dead, `${f.runUp.x} m along the run-up, ${f.runUp.z} m off its line (park x ${f.park.x}, z ${f.park.z})`);
  const p = r.planes;
  if (p) {
    const la = p.land, cr = p.crash;
    add(`${p.name} set down on the mesa stands on it`, la.onGround && la.y > la.topY + 0.3 && la.y < la.topY + 4 && !la.dead, `y ${la.y} m (deck ${la.topY} m)`);
    add(`${p.name} flown into the cliff hits it`, cr.impacts > 0 && cr.speedPast < 20, `${cr.impacts} impacts, ${cr.speedPast} m/s past the face (from ${cr.speed0}), ${cr.alive}/${cr.of} parts`);
  }
  for (const e of r.evel || []) {
    const n = `${e.name} (${e.realism}) canyon jump`;
    add(`${n}: rocket strip and lip`, e.stripSpeed > e.plannedSpeed - 2 && Math.abs(e.lipZ) < 1.5, `${e.stripSpeed} m/s on the strip, ${e.lipSpeed} m/s at the lip, ${e.lipZ} m off the centreline`);
    add(`${n}: clears the ${e.gap.toFixed(0)} m gap`, e.air > 4 && e.minYOverGap > 5 && e.touchX > e.gap && e.slowmo, `${e.air} s in the air, up to ${e.peakY} m, lowest over the gap ${e.minYOverGap} m above the rim, down at x ${e.touchX} (far rim ${e.gap})`);
    add(`${n}: lands upright on the far ramp, parachute stops it`, e.onFarSide && e.landUp > 0.85 && e.minUpAfter > 0.8 && e.chute && e.endX < e.runEnd && e.endV < 6.5 && e.alive === e.parts && !e.dead, `lowest up ${e.minUpAfter}, stopped at x ${e.endX} (run-out ends ${e.runEnd}), ${e.alive}/${e.parts} parts`);
  }
  for (const e of r.longRun || []) {
    const n = `${e.name} (${e.realism}) long run-up from the park`;
    if (e.zE === 0) add(`${n}: flat out through the fork, on the rocket strip: a bigger jump, lands upright, stopped`, e.vFork > 30 && e.onFarSide && e.landUp > 0.85 && e.alive === e.parts && !e.dead && e.endX < e.runEnd && e.touchX > e.gap,
      `${e.vFork} m/s at the fork, ${e.vFoot} m/s at the ramp, ${e.vLip} at the lip; ${e.air} s air, up to ${e.peakY} m, down at x ${e.touchX}, stopped at ${e.endX} (run-out ends ${e.runEnd}), up ${e.landUp}, ${e.alive}/${e.parts} parts; ${e.msgs.filter((m) => /canyon/.test(m)).join(', ')}`);
    else add(`${n}: beside the rocket strip (no boost): too slow, the rescue parachute`, e.msgs.includes('PARACHUTE!') && !e.onFarSide && !e.dead && e.vFoot < e.planned * 0.75, `${e.vFoot} m/s at the ramp (planned ${e.planned}), ${e.zStrip} m off the centreline on the strip, ${e.alive}/${e.parts} parts`);
  }
  const es = r.evelShort;
  if (es) add('too slow for the canyon jump: the rescue parachute lowers it', es.chute && es.touchVy > -9 && es.endUp > 0.5 && !es.dead, `falling at ${es.fastestFall} m/s before it opens, ${es.touchVy} m/s at touchdown, ${es.endY} m down in the canyon, up ${es.endUp}, ${es.alive}/${es.parts} parts`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Node tier (tools/test/node/run.mjs): the same runs on real Worlds built in Node (node/world.mjs), headless.
//
// What differs per location (src/realworld.js loc.stunts, stuntPark.js planStunts): every place uses the 'compact'
// layout, so the track, its ramps, the loop and the bowl are the same mesh in the park's own frame everywhere. What a
// place changes: the site (found from its terrain, water, buildings, woods and, at New York, tree canopy in the
// imagery; at the Grand Canyon placed right behind the canyon jump's run-up), the ground levelled under and round it,
// the pad's height (air density: the Grand Canyon's pad is at 2,169 m), the ground type under the track (sand at the
// Grand Canyon, grass elsewhere), the wind over it, the theme (the mesa jump's surfaces: rock, painted containers,
// timber, lava), the link lane and fork to the canyon jump (the Grand Canyon only: there the rumble strip doesn't slow
// you for the banked turn), the road start and the canyon jump. So:
//   ref:      the full set of runs (loop, coasting / too slow, mesa jump, bowl at four speeds, banked turn) for every car
//             and mode, once, on the reference park: the compact layout without a link, on a flat lot (flatWorld);
//   location: at every place: the site is dry, flat and clear; every car starts at the arch and on the road (and at the
//             Grand Canyon at the canyon jump) facing the right way; the loop run from the arch (the run-up on the
//             place's own ground, out into the exit lane) and the mesa jump (its theme's surfaces), in Pilot;
//   canyon:   the Grand Canyon's own, both modes: its loop and mesa jump, its link and fork (the hands-off run takes the
//             banked turn, a steered one the link lane), the canyon jump and the long run-up from the park; the rescue
//             parachute.
// New York's site needs the imagery (tree canopy), which Node can't read: the browser tier checks it (stunts.py), and
// drives the loop run there. In Node, New York's park stands where the search puts it without the canopy rule.
export const LOCS = ['canyon', 'nyc', 'lauterbrunnen', 'islands'], CARS = ['Dune Buggy', 'Chomper', 'Dirt Bike', 'Sport Bike'], MODES = ['pilot', 'arcade'];
export const nodeSuite = { files: ['src/stunt*.js', 'src/evelJump.js', 'src/aircraft.js', 'src/bike*.js', 'src/drive.js', 'src/collide.js', 'src/world.js', 'src/realworld.js', 'src/landStart.js', 'tools/test/stunts.js', 'tools/test/node/world.mjs'], headless: true };
export function cases() {
  return [
    ...[[CARS[0], CARS[2]], [CARS[1], CARS[3]]].map((cars) => ({ id: `canyon ${cars.join(', ')}`, kind: 'canyon', loc: 'canyon', world: 'canyon', cars })), // (a car and a bike each: about the same work)
    ...LOCS.map((loc) => ({ id: `${loc} site, starts, runs`, kind: 'location', loc, world: loc })),
    ...CARS.flatMap((car) => MODES.map((rl) => ({ id: `ref ${car} ${rl}`, kind: 'ref', loc: 'ref', car, rl }))),
  ];
}
// The reference park: just the park (the compact layout, no link) on a flat, calm lot of grass at sea level, with
// main.js's flight env over it: no terrain, roads or buildings to build (the places' own ground is what the location
// runs are for)
let flat = null;
async function flatWorld() {
  if (flat) return flat;
  const THREE = await import('three'), { StuntParks, layoutOf } = await import('../../src/stuntPark.js'), { THEMES } = await import('../../src/stuntKit.js');
  const { makeNoise } = await import('../../src/noise.js'), { World } = await import('../../src/world.js'), { envOf } = await import('./node/world.mjs');
  const cfg = { layout: 'compact', theme: 'tropical' }, up = new THREE.Vector3(0, 1, 0);
  const w = { loc: { id: 'flat', stunts: cfg, rwyH: 0 }, noise: makeNoise(1), real: null, flora: null, group: new THREE.Group(), night: false, W: { dark: 0 }, waterLevel: -50, gust: new THREE.Vector3(), gustT: new THREE.Vector3() };
  w.stuntPlan = { cfg, layout: layoutOf(cfg), theme: THEMES[cfg.theme], site: { x: 0, z: 0, yaw: 0, fixed: true }, park: { x: 0, z: 0, yaw: 0, h: 0, link: 0, linkDy: 0 }, pads: [] };
  w.stunts = new StuntParks(w, w.stuntPlan); w.surfs = w.stunts.sites.map((s) => s.cm);
  Object.assign(w, { surfRay: World.prototype.surfRay, surfPoint: World.prototype.surfPoint, groundAt: () => ({ h: 0, n: up.clone(), type: 'grass' }), maxGround: (x, z) => Math.max(0, w.stunts.topAt(x, z)), windAt: () => new THREE.Vector3(), wallBoxes: (x, z, r, o = []) => ((o.length = 0), o), reset() {} });
  return (flat = { world: w, env: envOf(w), ms: 0 });
}
export async function runCase(c, { presets }) {
  const { worldAt, skyOf } = await import('./node/world.mjs');
  const w = c.kind === 'ref' ? await flatWorld() : await worldAt(c.loc), S = skyOf(w, presets), out = [], judged = (r, where) => judge(r, where).map(([name, ok, why]) => ({ name, ok, why }));
  w.world.reset(); w.world.gust.set(0, 0, 0); w.world.gustT.set(0, 0, 0);
  const park0 = w.world.stunts.park; park0.st = { air: 0, upside: false }; park0.la = null;
  const r = { loop: [], speeds: [], jump: [], bowl: [], turn: [], fork: [], planes: null, evel: [], evelShort: null, longRun: [] };
  if (c.kind === 'ref') { // the whole set, one car and mode
    r.loop.push(loopRun(S, c.car, c.rl)); r.speeds.push(loopSpeeds(S, c.car, c.rl)); r.jump.push(jumpRun(S, c.car, c.rl));
    for (const v of [14, 20, 26, 34]) r.bowl.push(bowlRun(S, c.car, c.rl, v));
    r.turn.push(turnRun(S, c.car, c.rl));
    if (park(S).L.tabletop != null) r.planes = planeRuns(S);
    return judged(r, 'ref');
  }
  if (c.kind === 'canyon') {
    for (const car of c.cars) for (const rl of MODES) {
      r.loop.push(loopRun(S, car, rl)); r.jump.push(jumpRun(S, car, rl)); r.turn.push(turnRun(S, car, rl)); r.fork.push(forkRun(S, car, rl));
      r.evel.push(evelRun(S, car, rl)); r.longRun.push(longRun(S, car, rl, 0));
      if (car === CARS[0]) r.longRun.push(longRun(S, car, rl, 5.6));
    }
    return judged(r, c.loc);
  }
  const add = (name, ok, why = '') => out.push({ name: `${c.loc}: ${name}`, ok: !!ok, why }), W = w.world, st = W.stunts.stats;
  if (c.loc === 'nyc') out.push({ name: 'nyc: site: dry, flat and clear', ok: true, skip: true, why: 'needs the imagery (tree canopy): checked in the browser (stunts.py)' });
  else { const s = siteCheck(S); add('site: dry, flat and clear', s.ok, s.why); }
  add('no stunt site warnings', !w.warns.some((m) => m.includes('[stunts]')), w.warns.filter((m) => m.includes('[stunts]')).join('; '));
  add('park built', W.stunts.park && st.collTris > 0, `${st.draws} draw calls, ${st.tris} triangles, ${st.collTris} collision triangles (World built in ${w.ms} ms)`);
  for (const car of CARS) {
    const p = startAt(S, car, 'park');
    add(`${car} starts at the start arch, facing the first kicker`, p && p.car && p.d < 3 && p.fx > 0.95 && p.hit === 0, p ? `${p.d.toFixed(1)} m from the arch, heading ${p.fx.toFixed(2)}${p.bike ? ' (bike)' : ''}, ${p.hit} parts in something` : 'no park start');
    const q = startAt(S, car, 'road');
    add(`${car} starts on the road, in its lane, facing along it`, q && q.d < 3 && q.fx > 0.95 && q.hit === 0, q ? `${q.d.toFixed(1)} m from the spot ${JSON.stringify(q.road)}, heading ${q.fx.toFixed(2)}, ground ${q.ground}, on a drawn road ${q.onRoad}, ${q.hit} parts in a building or tree` : 'no road start');
    if (W.stunts.evel) { const e = startAt(S, car, 'evel'); add(`${car} picks the canyon jump start: at its run-up, facing the ramp`, e && e.d < 3 && e.fx > 0.95 && e.evel, e ? `${e.d.toFixed(1)} m from it, heading ${e.fx.toFixed(2)}` : 'no canyon jump start'); }
    if (c.loc !== 'canyon') { r.loop.push(loopRun(S, car, 'pilot')); r.jump.push(jumpRun(S, car, 'pilot')); }
  }
  if (W.stunts.evel) r.evelShort = evelShort(S);
  out.push(...judged(r, c.loc));
  return out;
}
