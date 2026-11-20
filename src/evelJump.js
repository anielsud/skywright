// The daredevil canyon jump at the Grand Canyon: a huge launch ramp on the rim of a real side canyon, aimed across the
// gap at a matching landing ramp on the far rim. Found from the terrain (stuntSite.js findGap: the narrowest crossing
// near the hint that is a real gap, with level rim ground both sides, clear of roads and buildings).
//
// The run: a stars-and-stripes run-up strip with a rocket-boost section (a big boost pad: it takes you to exactly the
// speed the jump needs), the launch ramp (16 m high, 25 degrees at the lip), the flight (about 6 s, slow motion over
// the top), the landing ramp (its top follows the flight path, so you touch down along it, then curves down to the
// run-out) and a brake parachute that stops you on the run-out. Kid-friendly: on the strip and the ramp the car is
// held in the lane, and in the air a helper nudges you onto the landing ramp (it can't make up for a car that missed the
// boost: then a rescue parachute lowers you into the canyon). Dressing: a sign gantry, flags, grandstands, a TV
// camera tower on each rim, floodlights.
//
// Frame (stuntKit.js Site): x along the jump from the launch rim's edge (x = 0), z across it, y up from the launch
// rim's level. The far rim's edge is at x = gap.
import * as THREE from 'three';
import { clamp } from './noise.js';
import { Site, Geo, V, Y, PAINT, col, kicker, ATLAS } from './stuntKit.js';
import { findGap } from './stuntSite.js';

const G = 9.81, HK = 16, THETA = (25 * Math.PI) / 180, LIP = -8, RL = 260; // launch ramp height, lip angle, lip x; landing curve radius
const STRIP = 170, SPAWN = 30; // the rocket strip's length, and the start's distance before it

// Where the jump goes, its flight and the ground it levels.
export function planEvel(w, cfg) {
  const g = findGap(w, { run: 300, out: 230, ...cfg }); if (!g) return null;
  const yB = g.hB - g.hA + 0.05, xT = g.gap + 20; // the run-out deck's level (launch frame), and the touchdown point
  const k = kicker(HK, (THETA * 180) / Math.PI), ramp0 = LIP - k.L;
  const fly = (v) => { // the flight from the lip at v: height and slope at x
    const c2 = Math.cos(THETA) ** 2;
    return { y: (x) => HK + (x - LIP) * Math.tan(THETA) - (G * (x - LIP) ** 2) / (2 * v * v * c2), slope: (x) => Math.tan(THETA) - (G * (x - LIP)) / (v * v * c2) };
  };
  // the launch speed that brings you down on the landing ramp's curve exactly where its slope is the flight path's
  let lo = 20, hi = 150;
  for (let i = 0; i < 60; i++) { const v = (lo + hi) / 2, f = fly(v), phi = Math.atan(-f.slope(xT)); if (f.y(xT) - (yB + RL * (1 - Math.cos(phi))) > 0) hi = v; else lo = v; }
  const v = (lo + hi) / 2, f = fly(v), phi = Math.atan(-f.slope(xT)), yT = f.y(xT);
  const v0 = Math.sqrt(v * v + 2 * G * HK) + 2; // the strip's speed: up the ramp you lose some (and a little to drag)
  const pad = (x0, x1, h) => ({ x: g.x + g.dx * (x0 + x1) / 2, z: g.z + g.dz * (x0 + x1) / 2, c: Math.cos(g.yaw), s: Math.sin(g.yaw), hx: (x1 - x0) / 2, hz: 60, blend: 50, h, fill: 12 }); // (wide and long: flat under the decks at every terrain resolution)
  const runStart = ramp0 - STRIP - SPAWN - 15; // (findGap checked 300 m behind the rim and 230 m beyond the far one: clear and level)
  return {
    ...g, yB, xT, yT, v, v0, phi, k, ramp0, runStart, runEnd: g.gap + 222, top: f.y(LIP + (v * v * Math.sin(2 * THETA)) / (2 * G)) ,
    fly: f, jump: xT - LIP, pads: [pad(runStart - 10, -2, g.hA), pad(g.gap + 6, g.gap + 290, g.hB)],
  };
}

export class EvelJump extends Site {
  constructor(world, P, theme, mats) {
    const t0 = performance.now();
    super(world, V(P.x, P.hA, P.z), P.yaw, theme, 1776);
    this.P = P;
    this.build();
    this.cm.build();
    this.buildMeshes(world, mats, 'evelJump');
    this.chute = this.buildChute(world, mats);
    const back = this.Wd(V(-1, 0, 0)), side = this.Wd(V(0, 0, 1)), pos = this.W(V(P.ramp0 - STRIP - SPAWN, 0, 0));
    this.start = { id: 'evel', pos, heading: this.heading(1), lane: 4, at: (slot) => pos.clone().addScaledVector(back, 10 * slot).addScaledVector(side, slot % 2 ? -4 : slot ? 4 : 0), msg: 'DAREDEVIL CANYON JUMP! Full gas, hit the rocket strip!' };
    this.st = { phase: 'idle', chute: null, open: 0 };
    this.stats.buildMs = Math.round(performance.now() - t0);
    Object.assign(this.stats, { gap: Math.round(P.gap), jump: Math.round(P.jump), dip: Math.round(P.dip), speed: Math.round(P.v0) });
  }
  inside(x, z) { const [u, v] = this.local(x, z), P = this.P; return u > P.runStart - 10 && u < P.runEnd + 10 && Math.abs(v) < 40; }
  bare(x, z) { const [u, v] = this.local(x, z), P = this.P; return (u > P.runStart - 12 && u < 2 && Math.abs(v) < 40) || (u > P.gap - 2 && u < P.runEnd + 12 && Math.abs(v) < 40); }

  build() {
    const P = this.P, Pn = this.G.paint, red = col(0xc8102e), wht = col(0xf4f4f4), blue = col(0x0a2a6c), asph = col(0x2c3038), steel = col(0x6c7178);
    const path = (s) => ({ p: V(s, 0, 0), t: V(1, 0, 0), r: V(0, 0, 1) });
    // run-up and run-out: asphalt decks with red and white edges (on the levelled rims; a deck keeps it smooth at any
    // terrain resolution)
    const deckX = (y) => [[-9, y], [-8.4, y], [-6.6, y], [6.6, y], [8.4, y], [9, y]];
    const deckC = (s, k) => (k === 0 || k === 4 ? wht : k === 1 || k === 3 ? (Math.floor(s / 4) % 2 ? red : wht) : asph);
    this.sweep(Pn, { s0: P.runStart, s1: P.ramp0, n: Math.ceil((P.ramp0 - P.runStart) / 6), path, cross: () => deckX(0.05), color: deckC, type: () => PAINT, depth: 1, wallColor: () => steel, wallType: PAINT, floor: -3, flat: true });
    const outEnd = P.runEnd, landEnd = P.xT + RL * Math.sin(P.phi);
    this.sweep(Pn, { s0: landEnd, s1: outEnd, n: Math.ceil((outEnd - landEnd) / 6), path, cross: () => deckX(P.yB), color: deckC, type: () => PAINT, depth: 1, wallColor: () => steel, wallType: PAINT, floor: P.yB - 3, flat: true });
    // stars down the middle of the run-up, the rocket strip, the start line
    for (let s = P.runStart + 4; s < P.ramp0 - STRIP - 8; s += 6) this.signQuad([V(s, 0.07, -2.5), V(s, 0.07, 2.5), V(s + 5, 0.07, 2.5), V(s + 5, 0.07, -2.5)].map((v) => V(v.x, v.y, -v.z)), ATLAS.stars);
    this.boost(path, P.ramp0 - STRIP - 3, STRIP, P.v0, 0.05, true, 6.2, false, { tex: 'rocket', tile: 6, push: 30, msg: 'ROCKET BOOST!' });
    { const x = P.ramp0 - STRIP - SPAWN + 4; this.signQuad([V(x - 1.5, 0.09, -6.6), V(x - 1.5, 0.09, 6.6), V(x + 1.5, 0.09, 6.6), V(x + 1.5, 0.09, -6.6)], ATLAS.check); }
    // the launch ramp: red and white stripes down a 16 m kicker, blue parapets with stars, held in the lane
    const k = P.k, deck = (h, rim) => [[-7.6, h + rim], [-6.4, h + 0.05], [-6, h], [-4, h], [-2, h], [0, h], [2, h], [4, h], [6, h], [6.4, h + 0.05], [7.6, h + rim]];
    const stripes = (s, kk) => (kk === 0 || kk === 9 ? blue : kk === 1 || kk === 8 ? wht : kk % 2 ? red : wht);
    this.sweep(Pn, { s0: P.ramp0, s1: LIP, n: 40, path, cross: (s) => deck(k.h(s - P.ramp0), 1.3), color: stripes, type: () => PAINT, depth: 2, wallColor: () => blue, wallType: PAINT, floor: -14 });
    // its sides: DAREDEVIL CANYON JUMP in big letters, stars above the run-up end
    for (const sd of [-1, 1]) { const z = sd * 7.63, x0 = P.ramp0 + 14, x1 = LIP - 6, hgt = (x1 - x0) / 4, y0 = Math.max(0.4, k.h(x1 - P.ramp0) - hgt - 1.6); const q = [V(x0, y0, z), V(x1, y0, z), V(x1, y0 + hgt, z), V(x0, y0 + hgt, z)]; this.signQuad(sd > 0 ? q : [q[1], q[0], q[3], q[2]], ATLAS.daredevil); }
    // the landing ramp: its top follows the flight path (just under it) from 3 m past the far rim to the touchdown
    // point, then curves down to the run-out; parapets either side, the front face down into the canyon
    const xc0 = P.gap + 3, xcx = P.xT + RL * Math.sin(P.phi), ycc = P.yB + RL;
    const yl = (x) => (x <= P.xT ? P.fly.y(x) - 0.35 - 0.012 * (P.xT - x) ** 2 : ycc - Math.sqrt(Math.max(0, RL * RL - (x - xcx) ** 2))); // (the catch dips under the path towards its front: a low flight still lands on it)
    this.landY = yl; this.landEnd = landEnd;
    const ldeck = (h) => [[-10.2, h + 1.4], [-9, h + 0.05], [-8.6, h], [-6, h], [-3, h], [0, h], [3, h], [6, h], [8.6, h], [9, h + 0.05], [10.2, h + 1.4]];
    const lstripes = (s, kk) => (kk === 0 || kk === 9 ? blue : kk === 1 || kk === 8 ? wht : kk % 2 ? red : wht);
    this.sweep(Pn, { s0: xc0, s1: landEnd, n: 70, path, cross: (s) => ldeck(yl(s)), color: lstripes, type: () => PAINT, depth: 2, wallColor: () => blue, wallType: PAINT, floor: P.yB - 16 });
    for (const sd of [-1, 1]) for (let x = xc0 + 4; x < landEnd - 8; x += 7) { const h = yl(x + 3) - 3.2; if (h < P.yB + 0.6) continue; const z = sd * 10.23, q = [V(x, h, z), V(x + 5, h, z), V(x + 5, h + 2.4, z), V(x, h + 2.4, z)]; this.signQuad(sd > 0 ? q : [q[1], q[0], q[3], q[2]], ATLAS.stars); }
    // the end of the run-out: a sand trap and a wall of tyres
    for (let z = -9; z <= 9; z += 0.9) this.tyres(V(outEnd + 3, P.yB, z), 3);
    { const wl = (s) => ({ p: V(outEnd + 3, P.yB, s), t: V(0, 0, 1), r: V(-1, 0, 0) }); this.wallLine(wl, -10, 10, 0.4, 1.4, P.yB); }
    // a sign gantry over the run-up (facing the cars), flags along both decks, grandstands, the TV towers, floodlights
    this.gantry(P.ramp0 - STRIP + 30);
    for (let x = P.runStart + 10; x < P.ramp0 - 4; x += 26) for (const sd of [-1, 1]) this.usFlag(V(x + (sd > 0 ? 13 : 0), 0, sd * 12.5));
    for (let x = landEnd + 6; x < outEnd - 10; x += 26) for (const sd of [-1, 1]) this.usFlag(V(x + (sd > 0 ? 13 : 0), P.yB, sd * 12.5));
    this.stand(P.ramp0 - 45, 19, 40, 1); this.stand(P.ramp0 - 105, -19, 40, -1);
    this.standAt(landEnd + 40, P.yB, 21, 40, 1);
    this.tvTower(LIP - 30, -26, 0, 15); this.tvTower(P.gap + 50, 30, P.yB, 9);
    for (const [x, z] of [[P.ramp0 - 30, -24], [P.ramp0 - 140, 24]]) this.tower(x, z, V(x + 40, 0, 0));
  }
  // a grandstand standing on a deck at height y
  standAt(x, y, z, len, f) { const O = this.O.y, Pn = this.G.paint, i0 = Pn.p.length; this.O.y += y; this.stand(x, z, len, f); this.O.y = O; for (let i = i0 + 1; i < Pn.p.length; i += 3) Pn.p[i] += y; }
  // a flag with red and white stripes and a blue corner of stars, on a pole
  usFlag(p) {
    const Pn = this.G.paint, h = 7, fw = 2.4, fh = 1.4, y = p.y + h - fh;
    this.cyl(Pn, p.x, p.y, p.z, 0.06, 0.05, h, 4, col(0xdddddd), false);
    const two = (a, b, c, d, k) => { this.quad(Pn, a, b, c, d, k, null, V(0, 0, 1)); this.quad(Pn, a, b, c, d, k, null, V(0, 0, -1)); };
    for (let i = 0; i < 7; i++) { const y0 = y + (i * fh) / 7, y1 = y + ((i + 1) * fh) / 7; two(V(p.x + 0.06, y0, p.z), V(p.x + 0.06 + fw, y0, p.z), V(p.x + 0.06 + fw, y1, p.z), V(p.x + 0.06, y1, p.z), col(i % 2 ? 0xf4f4f4 : 0xc8102e)); }
    for (const sd of [-1, 1]) { const z = p.z + sd * 0.02, x0 = p.x + 0.06, x1 = x0 + fw * 0.42, y0 = y + fh * 0.46, y1 = y + fh; const q = [V(x0, y0, z), V(x1, y0, z), V(x1, y1, z), V(x0, y1, z)]; this.signQuad(sd > 0 ? q : [q[1], q[0], q[3], q[2]], ATLAS.stars); }
  }
  // a steel gantry over the run-up with the big sign on both faces
  gantry(x) {
    const Pn = this.G.paint, steel = col(0x3a3e44);
    for (const sd of [-1, 1]) { this.box(Pn, x, 0, sd * 11, 0.6, 14.5, 0.6, 0, steel, [PAINT, 0.5]); this.box(Pn, x, 0, sd * 11, 1.6, 0.6, 1.6, 0, col(0x8a8a86)); }
    this.box(Pn, x, 8.6, 0, 0.8, 6, 22.6, 0, col(0x0a2a6c));
    const w = 20, h = 5, y0 = 9.1;
    this.signQuad([V(x - 0.42, y0, w / 2), V(x - 0.42, y0, -w / 2), V(x - 0.42, y0 + h, -w / 2), V(x - 0.42, y0 + h, w / 2)], ATLAS.daredevil);
    this.signQuad([V(x + 0.42, y0, -w / 2), V(x + 0.42, y0, w / 2), V(x + 0.42, y0 + h, w / 2), V(x + 0.42, y0 + h, -w / 2)], ATLAS.daredevil);
  }
  // a scaffold tower with a TV camera, its operator and a LIVE board, at (x, z) on ground at height y, h tall
  tvTower(x, z, y, h) {
    const Pn = this.G.paint, sc = col(0x8a9096), dk = col(0x26282c);
    for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]]) this.box(Pn, x + dx, y, z + dz, 0.18, h, 0.18, 0, sc);
    for (let yy = y + 2; yy < y + h; yy += 2.5) { this.box(Pn, x, yy, z - 1.5, 3.1, 0.1, 0.1, 0, sc); this.box(Pn, x, yy, z + 1.5, 3.1, 0.1, 0.1, 0, sc); this.box(Pn, x - 1.5, yy + 1.2, z, 0.1, 0.1, 3.1, 0, sc); this.box(Pn, x + 1.5, yy + 1.2, z, 0.1, 0.1, 3.1, 0, sc); }
    this.box(Pn, x, y + h, z, 3.6, 0.25, 3.6, 0, col(0x5a4a3a)); // the platform
    for (const sd of [-1, 1]) { this.box(Pn, x, y + h + 1.0, z + sd * 1.75, 3.6, 0.08, 0.08, 0, sc); this.box(Pn, x + sd * 1.75, y + h + 1.0, z, 0.08, 0.08, 3.6, 0, sc); }
    const top = y + h + 0.25, aim = this.P ? V(this.P.gap / 2 - x, 0, -z).normalize() : V(1, 0, 0); // the camera looks out over the gap
    this.box(Pn, x, top, z, 0.08, 1.3, 0.08, 0, dk); // tripod head
    const cam = V(x, top + 1.5, z);
    this.box(Pn, x, top + 1.3, z, 0.5, 0.45, 0.5, Math.atan2(aim.x, aim.z), dk);
    this.tube(Pn, cam.clone().addScaledVector(aim, 0.25), cam.clone().addScaledVector(aim, 0.85), 0.16, 0.2, 8, col(0x111111));
    // the operator, and the LIVE board on the rail facing the run-up
    const op = cam.clone().addScaledVector(aim, -0.7);
    this.box(Pn, op.x, top, op.z, 0.42, 1.3, 0.3, 0, col(0x1f3a6a)); this.box(Pn, op.x, top + 1.32, op.z, 0.24, 0.26, 0.24, 0, col(0xd8a070), col(0x111111));
    const bx = x - 1.82, q = [V(bx, y + h + 0.3, z + 1.2), V(bx, y + h + 0.3, z - 1.2), V(bx, y + h + 1.5, z - 1.2), V(bx, y + h + 1.5, z + 1.2)];
    this.signQuad(q, ATLAS.tv);
  }
  // the parachute: a red, white and blue canopy on lines from the hitch at the origin, opening along +z
  buildChute(world, mats) {
    const geo = new Geo(), seg = 12, R = 3.2, Z0 = 7.5, D = 2.2, cs = [col(0xc8102e), col(0xf4f4f4), col(0x1f4fa8)], save = this.G;
    this.G = { paint: geo };
    const P = (i, j) => { const a = (i / seg) * Math.PI * 2, t = j / 4, r = R * Math.sin(((1 - t) * Math.PI) / 2 + 0.0001) , z = Z0 + D * Math.sin((t * Math.PI) / 2); return V(Math.cos(a) * r, Math.sin(a) * r, z); };
    for (let i = 0; i < seg; i++) for (let j = 0; j < 4; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1), k = cs[i % 3];
      this.quad(geo, a, b, c, d, k, null, a.clone().add(c).normalize()); this.quad(geo, a, b, c, d, k, null, a.clone().add(c).normalize().negate());
    }
    for (let i = 0; i < seg; i += 2) { const e = P(i, 0); this.tube(geo, V(0, 0, 0.2), e, 0.02, 0.02, 3, col(0x222222), false); }
    this.G = save;
    const m = new THREE.Mesh(geo.geometry(), mats.paint); m.name = 'evelJump-chute'; m.castShadow = true; m.receiveShadow = true; m.visible = false; m.frustumCulled = false;
    world.group.add(world.nearShadow ? world.nearShadow(m) : m);
    return m;
  }

  // ---- per frame ----
  reset() { const st = this.st; if (st.phase !== 'idle') { st.phase = 'idle'; st.chute = null; } }
  // A car at the jump: the rocket strip, the lane, the flight, the landing, the parachutes. Messages for the HUD.
  drive(ac, dt) {
    const P = this.P, lp = ac.isCar && !ac.dead ? this.Lp(ac.x) : null;
    if (!lp || lp.x < P.runStart - 60 || lp.x > P.runEnd + 60 || Math.abs(lp.z) > 400) { this.reset(); this.chuteUpdate(ac, dt); return null; }
    const st = this.st, msgs = [], fwd = V(0, 0, -1).applyQuaternion(ac.q), fl = this.Ld(fwd), vl = this.Ld(ac.v);
    const onRun = lp.x < LIP + 1 && lp.x > P.runStart - 5 && Math.abs(lp.z) < 12, onOut = lp.x > P.gap && lp.x < P.runEnd + 5 && Math.abs(lp.z) < 14;
    if (ac.onGround) {
      this.boostPads(ac, dt, fwd, msgs);
      if (st.phase === 'air') { // down: on the landing ramp, or somewhere else
        if (onOut && lp.y > P.yB - 3) {
          st.phase = 'landed'; st.chute = 'brake'; st.open = 0;
          msgs.push({ center: 'YOU MADE IT!' }, { toast: `DAREDEVIL! ${Math.round(lp.x - st.x0)} m over the canyon`, good: true });
        } else st.phase = 'done';
      } else if (st.phase === 'rescue') { st.phase = 'done'; st.chuteT = 1.5; }
      if (onRun && st.phase !== 'landed') st.phase = 'run';
      if ((st.phase === 'run' && onRun) || (st.phase === 'landed' && onOut)) this.lane(ac, dt, fl, lp);
      if (st.phase === 'landed') { // the brake parachute: pulls you down to a crawl on the run-out
        const s = ac.v.length();
        if (s > 5) ac.v.multiplyScalar(Math.max(5, s - 22 * dt) / s); // (more than any engine can push against)
        else if (st.chute === 'brake') { st.chute = null; st.phase = 'done'; msgs.push({ toast: 'Stopped by the parachute. What a jump!', good: true }); }
      }
    } else {
      if (st.phase === 'run' && lp.x > LIP - 6 && vl.x > 5) { st.phase = 'air'; st.x0 = lp.x; st.vy = vl.y; st.peak = false; }
      if (st.phase === 'air') {
        if (!st.peak && st.vy > 0 && vl.y <= 0) { st.peak = true; msgs.push({ slowmo: 1.8, center: 'DAREDEVIL!' }); } // over the top: slow motion
        st.vy = vl.y;
        if (lp.y < Math.min(0, P.yB) - 30) { st.phase = 'rescue'; st.chute = 'rescue'; st.open = 0; msgs.push({ center: 'PARACHUTE!' }); }
        else this.airGuide(ac, dt, lp, vl);
      }
      if (st.phase === 'rescue') this.rescue(ac, dt);
    }
    this.chuteUpdate(ac, dt);
    return msgs.length ? msgs : null;
  }
  // the rails of the run-up, the ramp and the run-out: pointed along the lane and eased back to its middle
  lane(ac, dt, fl, lp) {
    if (fl.x < 0.5 || ac.v.length() < 6) return;
    const err = Math.asin(clamp(fl.clone().cross(V(1, 0, 0)).y, -1, 1)), turn = new THREE.Quaternion().setFromAxisAngle(Y, err * Math.min(1, 4 * dt));
    ac.q.premultiply(turn).normalize(); ac.v.applyQuaternion(turn);
    ac.x.addScaledVector(this.Wd(V(0, 0, 1)), -lp.z * Math.min(1, 2 * dt));
  }
  // In the air: nudge the flight back onto the planned path (its height, climb and speed at this point of the jump),
  // which comes down along the landing ramp, and keep the car level and pointed along its flight path, wheels down.
  // Limited (7 m/s^2, 4.5 in Simulator): a car that missed the rocket strip still falls short.
  airGuide(ac, dt, lp, vl) {
    const P = this.P;
    if (lp.x < P.xT - 2) {
      const vx = P.v * Math.cos(THETA), vy = P.fly.slope(lp.x) * vx + 1.5 * (P.fly.y(lp.x) + 0.9 - lp.y);
      const dvx = vx - vl.x, dvy = vy - vl.y, dvz = -0.8 * lp.z - vl.z, m = Math.hypot(dvx, dvy, dvz), lim = (ac.R.assist > 0 ? 7 : 4.5) * dt, k = m > lim ? lim / m : 1;
      ac.v.add(this.Wd(V(dvx * k, dvy * k, dvz * k)));
    }
    const f = ac.v.clone().normalize(), up = Y.clone().addScaledVector(f, -f.y).normalize(), right = f.clone().cross(up);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, f.clone().negate()));
    ac.q.slerp(q, Math.min(1, 3 * dt)).normalize(); ac.w.multiplyScalar(Math.max(0, 1 - 6 * dt));
  }
  // the rescue parachute: down gently, level
  rescue(ac, dt) {
    if (ac.v.y < -7) ac.v.y += (-7 - ac.v.y) * Math.min(1, 3 * dt);
    ac.v.x *= Math.max(0, 1 - 0.7 * dt); ac.v.z *= Math.max(0, 1 - 0.7 * dt);
    const fw = V(0, 0, -1).applyQuaternion(ac.q); fw.y = 0; if (fw.lengthSq() < 1e-4) fw.set(0, 0, -1); fw.normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fw.clone().cross(Y), Y, fw.clone().negate()));
    ac.q.slerp(q, Math.min(1, 2 * dt)).normalize(); ac.w.multiplyScalar(Math.max(0, 1 - 4 * dt));
  }
  chuteUpdate(ac, dt) {
    const st = this.st, m = this.chute;
    if (st.chuteT > 0) { st.chuteT -= dt; if (st.chuteT <= 0) st.chute = null; }
    if (!st.chute || ac.dead) { m.visible = false; st.open = 0; return; }
    st.open = Math.min(1, st.open + dt * 2.5);
    const v = ac.v.lengthSq() > 1 ? ac.v.clone().normalize() : V(0, 0, -1).applyQuaternion(ac.q);
    if (st.chute === 'brake') { m.position.copy(ac.x).addScaledVector(v, -1.6); m.lookAt(m.position.clone().addScaledVector(v, -10).add(V(0, 1.2, 0))); m.scale.setScalar(0.25 + 0.75 * st.open); }
    else { m.position.copy(ac.x).add(V(0, 0.6, 0)); m.lookAt(m.position.clone().add(V(0, 10, 0))); m.scale.setScalar((0.25 + 0.75 * st.open) * 2); }
    m.visible = true;
  }
  dispose() { super.dispose(); this.chute?.geometry.dispose(); this.chute?.parent?.remove(this.chute); }
}
