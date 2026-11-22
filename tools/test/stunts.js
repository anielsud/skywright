// In-page part of stunts.py: drives stock cars and bikes through a location's stunt park (and, at the Grand Canyon,
// the daredevil canyon jump) with scripted inputs (gas on, a simple lane-keeping steer) on the real flight model at a
// fixed 60 Hz, and reports what happened. Needs a flight at a location with stunts (window.__sky.F with world.stunts).
// Physics only: the flight is paused and stepped from here. Positions are in the site's own frame (stuntKit.js Site:
// x along the park, z across it), so it works for any placement and heading.
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
  const ac = place(S, name, 'pilot', x, z, dir, v, site); F.scene.add(ac.root); S.__stageAc = ac;
  if (which === 'evel') site.st.phase = 'idle';
  drive(S, ac, { z, dir, T, speed, site, steer, until: (a) => { const q = site.Lp(a.x); return cond(a, q.x, q.z, q.y); } });
  ac.syncVisual?.();
  const q = site.Lp(ac.x); return [q.x, q.y, q.z];
}
