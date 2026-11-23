// Live cockpit instruments: the needles, cards and lamps of a cockpit's panel follow the vehicle (airspeed, altitude,
// attitude, heading, revs, gear, stall...), and small canvas screens can be redrawn a few times a second.
//
// A cockpit builder makes a LivePanel, declares its instruments on it in the panel's own frames (a face matrix whose
// local +Z points out of the panel, as cabKit's faceM: the instrument's face in local XY), and adds it to the part:
//   const lp = new LivePanel(atlasMaterial, { white: [u, v], lamp: [u, v] });
//   lp.needle(faceM, { src: 'kt', at: (kt) => angle, len, w, color });   // a pointer turning on its pivot
//   lp.lamp(faceM, { src: 'stall', w, h, color, uv });                    // a light that comes on
//   lp.horizon(faceM, { r, ... });                                        // an attitude indicator's ball
//   lp.part(faceM, shape, { src, xf });                                   // anything else that turns / slides
//   lp.screen(faceM, w, h, { px: [cw, ch], hz, draw(ctx, S) });          // a canvas display (phase 2)
//   lp.to(group);
// Everything one panel declares is ONE mesh (one draw call) on a clone of the panel's own atlas material (flat
// coloured pieces sample a white texel of it and are tinted by vertex colour; textured ones, like a heading card, sample
// the atlas where the face is painted), plus one more for its canvas screens if it has any. The mesh is near-only
// detail (the LOD hides it at a distance) and planeDetail.mergeStatic leaves it alone (userData.live).
//
// Per frame (main.js, after the HUD): updateLive(player's vehicle, ctx). Only the player's own vehicle is ever updated
// and only while the camera is in the cockpit; elsewhere (other players, traffic, the hangar, the chase camera) the
// instruments stay where they were last left, or at rest as built. One update: the signals (signals()) once, then each
// item's damped value (a critically damped spring, like a real instrument's needle), the item's vertices rewritten
// (a few hundred floats per cockpit) and uploaded. No textures are redrawn except the canvas screens, at their rate.
//
// Angles: `at` and the dial helpers speak the canvas's angles (radians, 0 at 3 o'clock, clockwise: how the faces were
// painted); on the face (+Y up) that is a turn of -angle.
import * as THREE from 'three';
import { MOTOR, isMotor, motorRpm } from './motorSound.js';

// ---------- what the instruments read ----------
// The rest state (in the hangar, and how a panel is built): engine off, standing still, level, heading north.
export const REST = Object.freeze({
  spd: 0, kt: 0, mph: 0, kmh: 0, alt: 0, vs: 0, hdg: 0, pitch: 0, roll: 0, turn: 0, slip: 0,
  rpm: 0, rpmK: 0, thr: 0, map: 29.9, g: 1, gMax: 1, gMin: 1, oilP: 0, oilT: 0.1, cht: 0.1, egt: 0.1, fuelL: 0.72, fuelR: 0.68, amp: 0.35,
  gearDown: 1, gearMove: 0, stall: 0, running: 0, off: 1, brake: 1, ab: 0, gearNo: 0, rev: 0, t: 0, metric: 0, mach: 0, fpmAz: 0, fpmEl: 0, north: 0, flaps: 0, n1: 0.2, egtJ: 0.05,
});
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _q = new THREE.Quaternion();
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
// The signals, in the units real instruments show: knots, feet, feet per minute, degrees per second, rpm...
export function signals(ac, ctx, S, dt) {
  const q = ac.q; _f.set(0, 0, -1).applyQuaternion(q); _u.set(0, 1, 0).applyQuaternion(q); _r.set(1, 0, 0).applyQuaternion(q);
  S.t = (S.t || 0) + dt;
  S.spd = ac.isCar || ac.isBoat ? ac.v.length() : ac.airspeed || 0; // (as the HUD: cars and boats over the ground)
  S.kt = S.spd * 1.94384; S.mph = S.spd * 2.23694; S.kmh = S.spd * 3.6;
  S.alt = ac.x.y * 3.28084; S.vs = ac.v.y * 196.85;
  const hdg = Math.atan2(_f.x, -_f.z) + THREE.MathUtils.degToRad(ctx.world?.loc?.north || 0);
  if (S._h != null && dt > 0) S.turn += (THREE.MathUtils.radToDeg(wrapPi(hdg - S._h)) / dt - S.turn) * Math.min(1, dt * 3); // (deg/s)
  S._h = hdg; S.hdg = hdg;
  S.pitch = Math.asin(clamp(_f.y, -1, 1)); S.roll = Math.atan2(-_r.y, _u.y); // (+ nose up, + right wing down)
  { const sf = ac._crewG?.f; S.slip = sf ? clamp(-sf.dot(_r) / Math.max(0.3, sf.dot(_u)), -0.5, 0.5) : 0; } // the ball: where the apparent gravity puts it (planeDetail.specificForce)
  // engines: a piston's or turboprop's rpm, a rotor's engine (shown as a piston heli's ~2700 at 100 %), a jet's % rpm;
  // cars, bikes and boats: the revs the engine sound hears (motorSound.motorRpm: through the gearbox, the clutch...)
  let rpm = 0, rpmK = 0, run = 0, ab = 0, motorE = null;
  for (const p of ac.parts) {
    if (!p.alive || !p.engine) continue; const e = p.engine, sp = e.spoolT || 0;
    if (e.abOn) ab = 1;
    if (isMotor(e.sound) && (e.type === 'drive' || ac.isBoat || ac.isCar)) { motorE ||= e; continue; }
    if (e.type === 'prop') { const r = e.rpm || 0; if (r > rpm) { rpm = r; rpmK = r / (e.maxRpm || 2700); } if (r > 100) run = 1; }
    else if (e.type === 'rotor') { const r = (e.rpm || 0) / (e.maxRpm || 2000) * 2700 * Math.min(1, sp * 1.5); if (r > rpm) { rpm = r; rpmK = r / 2700; } if (sp > 0.05) run = 1; }
    else if (e.type === 'jet') { const r = 60 + 40 * sp; if (r * 27 > rpm) { rpm = r * 27; rpmK = r / 100; } run = 1; }
  }
  if (motorE) {
    const kind = motorE.sound, M = MOTOR[kind], st = (S._motor && S._motor.motor === M) ? S._motor : (S._motor = { motor: M, gear: 0, rpmS: M.rpm[0], clock: 0 });
    st.clock += dt;
    const on = ac.engineRunning !== false; // (main.js engineSwitch: off until the first press of the gas, off again parked a while)
    const r = on ? motorRpm(st, motorE, { groundSpeed: ac.v.length(), wheelV: ctx.wheelV ?? null, onGround: ac.onGround }, Math.max(1e-3, dt)).rpm : 0;
    rpm = r; rpmK = r / M.rpm[1]; run = on ? 1 : 0;
    S.gearNo = !on ? 0 : ac.reversing ? -1 : M.gears ? st.gear + 1 : (S.spd > 0.5 ? 1 : 0);
  } else S.gearNo = 0;
  if (ac.engineRunning === false && !motorE) run = 0;
  S.rpm = rpm; S.rpmK = rpmK; S.running = run; S.off = 1 - run; S.ab = ab;
  S.thr = clamp(ac.ctl?.throttle || 0, 0, 1); S.rev = ac.reversing ? 1 : 0;
  const amb = 29.92 * clamp((ac.rho ?? 1.225) / 1.225, 0, 1.2);
  S.map = run ? Math.min(amb, (11 + 18 * S.thr) * amb / 29.92) : amb; // (manifold pressure: ambient when stopped, ~11 in at idle)
  S.g = ac.g ?? 1; if (!ac.onGround || S.t > 1) { S.gMax = Math.max(S.gMax ?? 1, S.g); S.gMin = Math.min(S.gMin ?? 1, S.g); }
  const warm = (k, target, tau) => { S[k] += (target - S[k]) * Math.min(1, dt / tau); };
  S.oilP = run ? 0.32 + 0.4 * clamp(rpmK, 0, 1) : Math.max(0, S.oilP - dt * 0.5);
  warm('oilT', run ? 0.5 + 0.12 * S.thr : 0.1, 60); warm('cht', run ? 0.38 + 0.35 * S.thr : 0.1, 25); warm('egt', run ? 0.35 + 0.4 * S.thr : 0.1, 4);
  S.amp = run ? 0.58 + 0.06 * S.thr : 0.35;
  S.gearDown = (ac.gearT ?? 1) > 0.98 ? 1 : 0; S.gearMove = (ac.gearT ?? 1) > 0.02 && (ac.gearT ?? 1) < 0.98 ? 1 : 0;
  S.stall = ac.stalled && ctx.stallWarn !== false ? 1 : 0;
  S.brake = ac.brake > 0.5 || ac.svcBrake > 0.5 || ac.ctl?.hand > 0.5 ? 1 : 0;
  S.metric = ctx.metric ? 1 : 0; // (digital displays: km/h instead of mph)
  S.hasRetract = ac.hasRetract ? 1 : 0; S.onGround = ac.onGround ? 1 : 0;
  { const W = ctx.world; S.agl = W?.heightAt ? ac.x.y - Math.max(W.heightAt(ac.x.x, ac.x.z), W.waterLevel ?? -1e9) : 1e4; }
  { let dm = 0; for (const p of ac.parts) if (p.alive && p.engine && p.hp) dm = Math.max(dm, (p.dmg || 0) / p.hp); S.engDmg = dm; } // (an engine's damage: the ENGINE and ENG FIRE cautions)
  S.mach = ac.mach || 0; S.north = ctx.world?.loc?.north || 0; S.flaps = ac.flaps || 0; S.x = ac.x.x; S.y = ac.x.y; S.z = ac.x.z;
  { const v = _r.copy(ac.v).applyQuaternion(_q.copy(ac.q).invert()), L = Math.hypot(v.x, v.z); // the flight path in the aircraft's frame (degrees off the nose)
    const sp = ac.v.length(); S.fpmAz = sp > 3 ? THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z)) : 0; S.fpmEl = sp > 3 ? THREE.MathUtils.radToDeg(Math.atan2(v.y, L)) : 0; }
  { let n = 0, k = 0; for (const p of ac.parts) if (p.alive && p.engine && (p.engine.type === 'jet' || p.engine.type === 'rocket')) { n += p.engine.spoolT || 0; k++; } // jets: N1 and EGT follow the spool
    S.n1 = k ? (run ? 0.2 + 0.8 * n / k : Math.max(0, (S.n1 || 0) - dt * 0.1)) : S.rpmK; S.egtJ = k ? (run ? 0.3 + 0.55 * n / k + (ab ? 0.12 : 0) : 0.05) : S.egt; }
  S.env = ctx; // (screens that draw the world: the map tiles, other aircraft)
  return S;
}

// ---------- the material ----------
// The panel's atlas material with vertex colours: the colour tints what the map gives, and its glow (the emissive map)
// too, so a white texel lit in the glow map makes a lamp of any colour.
const _mats = new WeakMap(); let _plain = null, _plainBasic = null;
function liveMaterial(base, basic) {
  if (!base) return basic ? (_plainBasic ||= new THREE.MeshBasicMaterial({ vertexColors: true })) : (_plain ||= tint(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.45 })));
  let m = _mats.get(base); if (m) return m;
  m = tint(base.clone()); m.vertexColors = true; _mats.set(base, m); return m;
}
function tint(m) {
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey?.() ?? '';
  m.onBeforeCompile = (sh, r) => { prev?.call(m, sh, r); sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif'); };
  m.customProgramCacheKey = () => key + '|live'; m.userData.live = true; return m;
}

// ---------- 2D shapes on a face ----------
// vertices in the face's frame (x right, y up, z out of the face), a colour and an atlas uv each; triangles.
export class Shape {
  constructor() { this.p = []; this.c = []; this.uv = []; this.i = []; }
  get n() { return this.p.length / 3; }
  v(x, y, z, col, uv) { this.p.push(x, y, z); this.c.push(col.r, col.g, col.b); this.uv.push(uv[0], uv[1]); return this.n - 1; }
  tri(a, b, c) { this.i.push(a, b, c); return this; }
  quad(a, b, c, d) { return this.tri(a, b, c).tri(a, c, d); }
  // a convex polygon (counter-clockwise), fanned
  poly(pts, z, col, uv) { const i0 = this.n; for (const [x, y] of pts) this.v(x, y, z, col, uv); for (let k = 1; k < pts.length - 1; k++) this.tri(i0, i0 + k, i0 + k + 1); return this; }
  // any simple polygon (triangulated)
  outline(pts, z, col, uv) { // (each triangle turned to face +z)
    const i0 = this.n, v2 = pts.map(([x, y]) => new THREE.Vector2(x, y)); for (const [x, y] of pts) this.v(x, y, z, col, uv);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(v2, [])) { const A = v2[a], B = v2[b], C = v2[c]; (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) >= 0 ? this.tri(i0 + a, i0 + b, i0 + c) : this.tri(i0 + a, i0 + c, i0 + b); }
    return this; }
  disc(cx, cy, r, z, col, uv, seg = 12) { const pts = []; for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return this.poly(pts, z, col, uv); }
  // a thick line from (x0, y0) to (x1, y1)
  bar(x0, y0, x1, y1, w, z, col, uv) { const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2; return this.poly([[x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny], [x0 + nx, y0 + ny]], z, col, uv); }
  // a pointer along +x: a tapered blade from the tail to the tip, and a dark hub over its pivot
  needle({ len, w, tail = 0.18, tipW = 0.3, z = 0, col, uv, hub = 1.4, hubCol = null }) {
    const t = -len * tail, h = w / 2;
    this.poly([[t, -h], [len * 0.88, -h * tipW], [len, 0], [len * 0.88, h * tipW], [t, h]], z, col, uv);
    if (hub) this.disc(0, 0, w * hub * 0.5, z + 0.0002, hubCol || DARK, uv, 10);
    return this;
  }
  // a textured disc: each vertex samples the atlas at uvAt(x, y) (its unrotated place on the face)
  card(r, z, uvAt, seg = 32, col = WHITE) { const i0 = this.n; this.v(0, 0, z, col, uvAt(0, 0)); for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI * 2, x = Math.cos(a) * r, y = Math.sin(a) * r; this.v(x, y, z, col, uvAt(x, y)); } for (let k = 1; k <= seg; k++) this.tri(i0, i0 + k, i0 + k + 1); return this; }
}
// a Shape as a plain geometry (uvs, normals +z; no colours): fixed pieces drawn with the atlas itself
export function shapeGeometry(sh) {
  const g = new THREE.BufferGeometry(), n = sh.n, nor = new Float32Array(n * 3); for (let i = 0; i < n; i++) nor[i * 3 + 2] = 1;
  g.setAttribute('position', new THREE.Float32BufferAttribute(sh.p, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(sh.uv, 2)); g.setIndex(sh.i); return g;
}
export const color = (c) => new THREE.Color(c); // (sRGB hex or css -> linear, as vertex colours are)
const WHITE = color(0xffffff), DARK = color(0x1c1d20);
// a dial's sweep: v from v0 to v1 over the canvas angles a0..a1 (clamped a little past its stops, like a real pointer)
export const sweep = (v0, v1, a0, a1, over = 0.04) => (v) => { const t = clamp((v - v0) / (v1 - v0), -over, 1 + over); return a0 + (a1 - a0) * t; };

// ---------- a cockpit's live panel ----------
export class LivePanel {
  // base: the atlas material the faces are drawn with (null: plain colours); white / lamp: uvs of a white texel (lamp:
  // one lit in the emissive map too); basic: unlit (for faces drawn with MeshBasicMaterial)
  constructor(base = null, { white = [0, 0], lamp = null, basic = false } = {}) {
    this.base = base; this.white = white; this.lampUV = lamp || white; this.basic = basic; this.items = []; this.screens = []; this.hooks = [];
  }
  // anything that moves on a face: shape (in the face's frame, round the pivot); src: a signal name or (S) => value;
  // xf(value, out): out = [turn (canvas radians), dx, dy, scale] (or a number: just the turn); w: the damping (rad/s:
  // ~12 a quick needle, ~4 a lazy one, 0 none); wrap: the value is an angle (damped the short way round)
  part(m, shape, { src = null, xf = null, w = 12, wrap = false, pivot = [0, 0], custom = null } = {}) {
    const it = { m: m.clone(), shape, src, xf, w, wrap, pivot, custom, x: 0, vx: 0, init: false, out: [0, 0, 0, 1] };
    this.items.push(it); return it;
  }
  // a needle: at(value) -> canvas angle; len, w: blade length and width (metres); z: above the face
  needle(m, { src, at, len, w, tail, tipW, z = 0.0012, color: col = '#f4f4f0', hub, hubCol, damp = 12, pivot = [0, 0], wrap = false }) {
    const s = new Shape().needle({ len, w, tail, tipW, z, col: color(col), uv: this.white, hub, hubCol: hubCol && color(hubCol) });
    return this.part(m, s, { src, xf: at, w: damp, pivot, wrap });
  }
  // a lamp: a w x h light (or round: r) that comes on while src is truthy; uv: where its lit face is in the atlas (a
  // rect [u0, v0, u1, v1]: a lit legend), or the lamp texel tinted `color`
  lamp(m, { src, w = 0.01, h = 0.01, r = 0, color: col = '#3cdc5a', uv = null, z = 0.0008 }) {
    const s = new Shape(), c = uv ? WHITE : color(col);
    if (r) s.disc(0, 0, r, z, c, this.lampUV, 14);
    else if (uv) { const [u0, v0, u1, v1] = uv, a = s.v(-w / 2, -h / 2, z, c, [u0, v0]), b = s.v(w / 2, -h / 2, z, c, [u1, v0]), cc = s.v(w / 2, h / 2, z, c, [u1, v1]), d = s.v(-w / 2, h / 2, z, c, [u0, v1]); s.quad(a, b, cc, d); }
    else s.poly([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], z, c, this.lampUV);
    return this.part(m, s, { src: typeof src === 'function' ? src : (S) => (S[src] ? 1 : 0), xf: (v, o) => { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = v > 0.5 ? 1 : 0; }, w: 0 });
  }
  // an attitude indicator's ball, behind no mask: the sky and ground halves of a disc of radius r clipped exactly at
  // the horizon each frame, pitch lines every 5 degrees; and round it a ring (out to ring) that only rolls. k: card
  // travel per radian of pitch (metres); z: above the face; the fixed airplane symbol and bank scale are the caller's.
  horizon(m, { r, ring = r * 1.2, k = r * 2.2, z = 0.0006, sky = '#2f7cc8', ground = '#7a4f2a', line = '#f4f4f0', seg = 20, damp = 14 }) {
    const s = new Shape(), cs = color(sky), cg = color(ground), cl = color(line), uv = this.white, N = seg + 2;
    const layer = (zz) => { const i0 = s.n; for (const c of [cs, cg]) { const j0 = s.n; for (let k2 = 0; k2 < N; k2++) s.v(0, 0, zz, c, uv); for (let k2 = 1; k2 < N - 1; k2++) s.tri(j0, j0 + k2, j0 + k2 + 1); } return i0; };
    const L0 = layer(z), L1 = layer(z + 0.0004); // the rolling ring (pitch 0), the ball
    const bars = []; for (const [deg, hw] of [[0, 1], [5, 0.16], [-5, 0.16], [10, 0.3], [-10, 0.3], [15, 0.16], [-15, 0.16], [20, 0.3], [-20, 0.3]]) { const i0 = s.n; for (let q = 0; q < 4; q++) s.v(0, 0, z + 0.0008, cl, uv); s.quad(i0, i0 + 1, i0 + 2, i0 + 3); bars.push([i0, deg, hw]); }
    const ptr = s.n; s.poly([[0, 0], [0, 0], [0, 0]], z + 0.0008, color('#f4f4f0'), uv); // the sky pointer at the top of the rolling ring
    const segFill = (P, i0, rr, s0, sx, sy, dx, dy) => { // one layer: the disc of radius rr split by the line through (sx, sy) along (dx, dy)
      const h2 = rr * rr - s0 * s0;
      if (h2 <= 0) { // the line misses it: all sky (s0 > 0) or all ground
        const [a, b] = s0 > 0 ? [i0, i0 + N] : [i0 + N, i0];
        for (let k2 = 0; k2 < N; k2++) { const an = k2 === 0 ? 0 : ((k2 - 1) / (N - 2)) * Math.PI * 2; P(a + k2, k2 === 0 ? 0 : Math.cos(an) * rr, k2 === 0 ? 0 : Math.sin(an) * rr); P(b + k2, 0, 0); }
        return;
      }
      const h = Math.sqrt(h2), e1x = sx - dx * h, e1y = sy - dy * h, e2x = sx + dx * h, e2y = sy + dy * h, a1 = Math.atan2(e1y, e1x), a2 = Math.atan2(e2y, e2x);
      let span = a1 - a2; while (span < 0) span += 2 * Math.PI; while (span > 2 * Math.PI) span -= 2 * Math.PI;
      for (const [j, from, sp] of [[i0, a2, span], [i0 + N, a1, 2 * Math.PI - span]]) { P(j, sx, sy); for (let k2 = 1; k2 < N; k2++) { const an = from + sp * ((k2 - 1) / (N - 2)); P(j + k2, Math.cos(an) * rr, Math.sin(an) * rr); } }
    };
    return this.part(m, s, { w: damp, custom: (S, it, P) => {
      const st = it.st ||= { p: 0, r: 0, vp: 0, vr: 0 }, dt = it.dt;
      spring(st, 'p', 'vp', S.pitch, damp, dt); spring(st, 'r', 'vr', S.roll, damp, dt);
      const ph = st.r, dx = Math.cos(ph), dy = Math.sin(ph), nx = -dy, ny = dx; // the horizon's direction (it turns against the bank) and its up
      const off = clamp(st.p * k, -r * 1.6, r * 1.6), sx = -nx * off, sy = -ny * off;
      segFill(P, L0, ring, 0, 0, 0, dx, dy); segFill(P, L1, r, off, sx, sy, dx, dy);
      for (const [i0, deg, hw] of bars) { // pitch lines (the horizon line full width), dropped where they would leave the ball
        const c = (deg * Math.PI / 180) * k, cx = sx + nx * c, cy = sy + ny * c, half = deg === 0 ? Math.sqrt(Math.max(0, r * r - off * off)) : hw * r, th = deg === 0 ? r * 0.035 : r * 0.022;
        const ok = deg === 0 ? Math.abs(off) < r : Math.hypot(cx, cy) + half < r * 0.96;
        const ax = dx * half, ay = dy * half, bx = nx * th / 2, by = ny * th / 2;
        if (!ok) { for (let q = 0; q < 4; q++) P(i0 + q, 0, 0); continue; }
        P(i0, cx - ax - bx, cy - ay - by); P(i0 + 1, cx + ax - bx, cy + ay - by); P(i0 + 2, cx + ax + bx, cy + ay + by); P(i0 + 3, cx - ax + bx, cy - ay + by);
      }
      const pr = ring * 0.97, pw = r * 0.09, ux = nx, uy = ny; // the sky pointer: points up the card (at the bank scale's zero when level)
      P(ptr, ux * (r * 1.04), uy * (r * 1.04)); P(ptr + 1, ux * pr + dx * pw, uy * pr + dy * pw); P(ptr + 2, ux * pr - dx * pw, uy * pr - dy * pw);
    } });
  }
  // a whole attitude indicator on a face of radius R: the ball and the rolling ring (horizon above), the bank scale's
  // ticks on the case and the little aeroplane fixed over them
  attitude(m, R, { sky, ground, symbol = '#f29a1f', z = 0.0004 } = {}) {
    const ball = R * 0.78; this.horizon(m, { r: ball, ring: R * 0.97, k: ball * 2.0, z, sky, ground });
    const sc = new Shape(), wc = color('#f4f4f0'), oc = color(symbol), uv = this.white, zz = z + 0.0014;
    for (const dg of [-60, -30, -20, -10, 10, 20, 30, 60]) { const a = Math.PI / 2 + dg * Math.PI / 180, r0 = R * (Math.abs(dg) % 30 ? 0.88 : 0.82); sc.bar(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97, R * (Math.abs(dg) % 30 ? 0.03 : 0.045), zz, wc, uv); }
    sc.poly([[0, R * 0.96], [R * 0.07, R * 1.06], [-R * 0.07, R * 1.06]], zz, wc, uv);
    for (const sx of [-1, 1]) { sc.bar(sx * R * 0.6, 0, sx * R * 0.2, 0, R * 0.06, zz + 0.0002, oc, uv); sc.bar(sx * R * 0.21, 0.0, sx * R * 0.08, -R * 0.11, R * 0.06, zz + 0.0002, oc, uv); }
    sc.disc(0, 0, R * 0.05, zz + 0.0003, oc, uv, 10);
    return this.part(m, sc);
  }
  // a canvas display: w x h on the face (its centre at m's origin, z above it); px: its canvas size; draw(ctx, S, w, h)
  // is called hz times a second while it is watched. All a panel's screens share one canvas and one material.
  // (same: another screen of this panel whose picture this one shows too, as a second PFD; dark: no diffuse, the
  // picture only glows, as a real display's black glass)
  // (key(S): what the picture shows, as a string: unchanged, it is neither redrawn nor uploaded)
  // (round: a disc w across, as a dial's face, not a rectangle)
  screen(m, w, h, { px = [256, 128], hz = 10, draw, z = 0.0005, glow = 0.9, same = null, dark = false, key = null, round = false }) { const sc = { m: m.clone(), w, h, px, hz, draw, z, glow, same, key, round, last: null, y: 0, t: 1e9 }; if (dark) this.dark = true; this.screens.push(sc); return sc; }
  // anything else to do each frame while watched (fn(S, dt)): a HUD's uniforms and canvas (liveHud.js)
  hook(fn) { this.hooks.push(fn); return this; }

  // build the mesh(es) and add them to the part's group
  to(parent) {
    if (this.items.length) {
      let nv = 0, ni = 0; for (const it of this.items) { it.v0 = nv; nv += it.shape.n; ni += it.shape.i.length; }
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
      let k = 0;
      for (const it of this.items) {
        const e = it.m.elements, nz = new THREE.Vector3(e[8], e[9], e[10]).normalize();
        it.o = [e[12], e[13], e[14]]; it.ex = [e[0], e[1], e[2]]; it.ey = [e[4], e[5], e[6]]; it.ez = [e[8], e[9], e[10]];
        for (let i = 0; i < it.shape.n; i++) { nor.set([nz.x, nz.y, nz.z], (it.v0 + i) * 3); }
        col.set(it.shape.c, it.v0 * 3); uv.set(it.shape.uv, it.v0 * 2);
        for (const j of it.shape.i) idx[k++] = j + it.v0;
      }
      const g = new THREE.BufferGeometry();
      const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', pa); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.pos = pa;
      this.step(REST, 0, true);
      g.computeBoundingSphere(); g.boundingSphere.radius += 0.05; // (needles swing about inside their faces)
      const mesh = new THREE.Mesh(g, liveMaterial(this.base, this.basic));
      mesh.userData.live = this; mesh.userData.near = true; mesh.userData.keepShape = true; mesh.castShadow = false; mesh.receiveShadow = true;
      parent.add(mesh); this.mesh = mesh;
    }
    if (this.screens.length) this.buildScreens(parent);
    return parent;
  }
  buildScreens(parent) {
    const own = this.screens.filter((s) => !s.same), cw = Math.max(...own.map((s) => s.px[0])); let ch = 0; for (const s of own) { s.y = ch; ch += s.px[1]; }
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.flipY = false; // (not flipped: a screen's rows go up as they are, so one can be uploaded on its own)
    const geos = [];
    for (const s of this.screens) {
      const pg = s.round ? new THREE.CircleGeometry(s.w / 2, 28) : new THREE.PlaneGeometry(s.w, s.h), uv = pg.attributes.uv;
      const r = s.same || s; for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * r.px[0]) / cw, (r.y + (1 - uv.getY(i)) * r.px[1]) / ch);
      pg.translate(0, 0, s.z); pg.applyMatrix4(s.m); geos.push(pg);
      if (!s.same) { s.ctx = cv.getContext('2d'); this.drawScreen(s, REST); }
    }
    const geo = geos.length > 1 ? mergeAll(geos) : geos[0];
    const mat = new THREE.MeshStandardMaterial({ map: this.dark ? null : tex, color: this.dark ? 0x000000 : 0xffffff, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: Math.max(...this.screens.map((s) => s.glow)), roughness: 0.6, metalness: 0 }); // (an anti-glare finish: the screen's glass gives the sheen)
    const mesh = new THREE.Mesh(geo, mat); mesh.userData.live = this; mesh.userData.near = true; mesh.userData.keepShape = true; mesh.castShadow = false; mesh.receiveShadow = true;
    this.screenTex = tex; this.screenMesh = mesh; this.canvas = cv; tex.needsUpdate = true; parent.add(mesh);

  }
  // this panel's own screen texture and material (everything else it uses is shared): whoever drops a vehicle without
  // collecting its textures calls this (the hangar's rebuild); left behind, every rebuild leaked one texture (#213)
  dispose() { this.screenTex?.dispose(); this.screenMesh?.material.dispose(); this.screenTex = null; }
  // redraw the screens that are due (at their rate, scaled down when frames are tight: liveStats.rate) and whose picture
  // changed (key), and upload just those (their rows of the shared canvas: texSubImage, not the whole texture)
  updateScreens(S, dt) {
    const dirty = [];
    for (const s of this.screens) {
      if (s.same) continue; s.t += dt; if (s.t < 1 / (s.hz * liveStats.rate)) continue; s.t = 0;
      if (s.key) { const k = s.key(S); if (k === s.last) continue; s.last = k; }
      this.drawScreen(s, S); dirty.push(s);
    }
    if (!dirty.length) return;
    const R = _renderer, tex = this.screenTex, cw = this.canvas.width;
    if (R && R.properties.get(tex).__webglTexture && tex.version > 0) dirty.forEach((s, i) => uploadRegion(R, this.canvas, tex, 0, s.y, s.px[0], s.px[1], i === dirty.length - 1)); // (each screen redrawn, its own rows; the mip levels rebuilt once)
    else { tex.needsUpdate = true; liveStats.bytes += cw * this.canvas.height * 4; liveStats.uploads++; }
  }
  drawScreen(s, S) { const c = s.ctx; c.save(); c.beginPath(); c.rect(0, s.y, s.px[0], s.px[1]); c.clip(); c.translate(0, s.y); s.draw(c, S, s.px[0], s.px[1]); c.restore(); }

  // one frame: damp every item towards what it shows, rewrite its vertices (snap: straight there)
  step(S, dt, snap = false) {
    const P = this.pos.array, out = [0, 0, 0, 1];
    for (const it of this.items) {
      if (it.done && !it.src && !it.custom) continue; // (fixed pieces: written once)
      const o = it.o, ex = it.ex, ey = it.ey, ez = it.ez, sp = it.shape.p, v0 = it.v0, n = it.shape.n;
      if (it.custom) { // the item writes its own vertices (face coordinates, z from its shape)
        it.dt = snap ? 1e3 : dt;
        it.custom(S, it, (i, x, y) => { const z = sp[i * 3 + 2], j = (v0 + i) * 3; P[j] = o[0] + ex[0] * x + ey[0] * y + ez[0] * z; P[j + 1] = o[1] + ex[1] * x + ey[1] * y + ez[1] * z; P[j + 2] = o[2] + ex[2] * x + ey[2] * y + ez[2] * z; });
        it.done = true; continue;
      }
      let a = 0, tx = 0, ty = 0, k = 1;
      if (it.src) {
        const target = typeof it.src === 'function' ? it.src(S) : S[it.src];
        if (snap || !it.init || !it.w) { it.x = target; it.vx = 0; it.init = true; }
        else if (it.wrap) { const d = wrapPi(target - it.x); const tgt = it.x + d; it.x = springTo(it, tgt, dt); }
        else it.x = springTo(it, target, dt);
        const r = it.xf(it.x, out); if (typeof r === 'number') a = r; else if (r === undefined) [a, tx, ty, k] = out;
      }
      const c = Math.cos(-a) * k, s = Math.sin(-a) * k, px = it.pivot[0] + tx, py = it.pivot[1] + ty;
      for (let i = 0; i < n; i++) {
        const lx = sp[i * 3], ly = sp[i * 3 + 1], z = sp[i * 3 + 2], x = px + c * lx - s * ly, y = py + s * lx + c * ly, j = (v0 + i) * 3;
        P[j] = o[0] + ex[0] * x + ey[0] * y + ez[0] * z; P[j + 1] = o[1] + ex[1] * x + ey[1] * y + ez[1] * z; P[j + 2] = o[2] + ex[2] * x + ey[2] * y + ez[2] * z;
      }
      it.done = true;
    }
    this.pos.needsUpdate = true;
  }
  update(S, dt) {
    const pa = this.mesh?.geometry.attributes.position; // (cabinLight gives the mesh a new geometry on the same attributes; a
    if (pa && pa !== this.pos) { if (pa.count === this.pos.count) this.pos = pa; else this.items.length = 0; } // part cut away round another's interior is left as it is)
    if (this.items.length) this.step(S, dt);
    for (const h of this.hooks) h(S, dt);
    if (this.screens.length) this.updateScreens(S, dt);
  }
}
// a critically damped spring (a needle settling on its value: no overshoot, ~1/w seconds)
function springTo(it, target, dt) { const w = it.w, h = Math.min(dt, 0.1); it.vx += (w * w * (target - it.x) - 2 * w * it.vx) * h; return it.x + it.vx * h; }
function spring(st, kx, kv, target, w, dt) { if (dt > 1) { st[kx] = target; st[kv] = 0; return; } if (Math.abs(target - st[kx]) > Math.PI && kx === 'r') st[kx] += 2 * Math.PI * Math.round((target - st[kx]) / (2 * Math.PI)); const h = Math.min(dt, 0.1); st[kv] += (w * w * (target - st[kx]) - 2 * w * st[kv]) * h; st[kx] += st[kv] * h; }
function mergeAll(geos) { // (PlaneGeometries: same attributes)
  let nv = 0, ni = 0; for (const g of geos) { nv += g.attributes.position.count; ni += g.index.count; }
  const out = new THREE.BufferGeometry(), A = {}; for (const k of ['position', 'normal', 'uv']) A[k] = new Float32Array(nv * geos[0].attributes[k].itemSize);
  const idx = new Uint16Array(ni); let v = 0, i = 0;
  for (const g of geos) { for (const k in A) A[k].set(g.attributes[k].array, v * g.attributes[k].itemSize); for (let j = 0; j < g.index.count; j++) idx[i++] = g.index.getX(j) + v; v += g.attributes.position.count; }
  for (const k in A) out.setAttribute(k, new THREE.BufferAttribute(A[k], k === 'uv' ? 2 : 3)); out.setIndex(new THREE.BufferAttribute(idx, 1)); return out;
}

// ---------- per frame ----------
// (bytes / uploads: what the screens have sent to the GPU, for the tests; rate: how fast the screens redraw, 1 = as declared)
export const liveStats = { ms: 0, panels: 0, frames: 0, bytes: 0, uploads: 0, rate: 1 };
let _renderer = null; const _pos = new THREE.Vector2();
// main.js hands over the renderer: the screens then upload only their own rows
export function setLiveRenderer(r) { _renderer = r; }
export const liveRenderer = () => _renderer;
// a rectangle of a canvas into its (already uploaded, unflipped) texture: copied through a scratch canvas of just that
// size (WebGL ignores the unpack-skip settings for a canvas source in some browsers: a region of the source itself
// came out wrong), so the upload is the rectangle's bytes, not the whole canvas's
const _scr = document.createElement('canvas'), _scrG = _scr.getContext('2d'), _scrT = new THREE.Texture(_scr);
// (mips: rebuild the texture's mip levels after it: only the last of a frame's uploads to one texture needs to)
export function uploadRegion(R, src, tex, x, y, w, h, mips = true) {
  if (_scr.width !== w || _scr.height !== h) { _scr.width = w; _scr.height = h; } else _scrG.clearRect(0, 0, w, h);
  _scrG.drawImage(src, x, y, w, h, 0, 0, w, h); _pos.set(x, y); const gm = tex.generateMipmaps; tex.generateMipmaps = gm && mips; R.copyTextureToTexture(_scrT, tex, null, _pos); tex.generateMipmaps = gm;
  liveStats.bytes += w * h * 4; liveStats.uploads++;
}
// ac: the player's vehicle; ctx: { dt, cockpit (the camera is in the cockpit), world, wheelV (main.js drivenWheels),
// stallWarn }. Nothing happens unless the camera is in the cockpit.
export function updateLive(ac, ctx) {
  if (!ctx.cockpit || !ac || ac.dead || !ac.root) return;
  const t0 = performance.now();
  if (!ac._livePanels) { const P = []; ac.root.traverse((o) => { const lp = o.userData.live; if (lp instanceof LivePanel && !P.includes(lp)) P.push(lp); }); ac._livePanels = P; }
  const P = ac._livePanels; if (!P.length) return;
  const dt = Math.min(0.1, Math.max(0, ctx.dt || 0)), S = ac._liveS ||= { ...REST };
  liveStats.rate = ctx.rate ?? 1; // (main.js: lower when the frame budget is tight)
  signals(ac, ctx, S, dt);
  for (const lp of P) lp.update(S, dt);
  liveStats.panels = P.length; liveStats.frames++; liveStats.ms += (performance.now() - t0 - liveStats.ms) * 0.05;
}
