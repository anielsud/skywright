// Landing gear routing for the assembly pass (planeDetail.assemble). Visual only: aircraft.js takes every wheel and
// float contact from the part's placement, never from these meshes.
//   - Wheels stand upright and roll straight ahead (axle level and square to the flight direction) whatever angle the
//     gear part was placed at; the wheel centre stays where physics has it.
//   - Every leg runs from the wheel up to the first solid skin it meets (fuselage, wing box, nacelle...), and ends there
//     in a boot. If that path is blocked by a control surface (flap, aileron, slat, spoiler, flap track) or meets
//     nothing, it bends at a knee below the obstacle and goes to the nearest solid structure instead.
//   - Braces (drag / side) go from the leg to the nearest solid structure ahead/behind or inboard/outboard, or are left
//     out when there is none in reach.
//   - A spring leg runs down the inboard side of its wheel; a gear on the centreline gets a symmetric yoke.
//   - Floats get N-struts (two posts and a diagonal) and spreader bars to the float on the other side; skids get cross
//     tubes leaning in to the body.
// Everything is found by rays against the placed parts in world space (resized and mirrored parts just work) and
// handed back to the part's builder (partDetail.js) in the part's own frame.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { V } from './partDetail.js';

const DEG = Math.PI / 180;

// The rotation (part frame) that turns the part's wheel frame back to the design frame: inverse of the placement
// rotation, conjugated by the x-mirror for mirrored parts (R·S·Rc = S, so the wheel is the mirror image of an upright one).
export function levelQuat(p) {
  const [x, y, z, w] = p.quat;
  return p.mirror ? new THREE.Quaternion(-x, y, z, w) : new THREE.Quaternion(-x, -y, -z, w);
}

// ctx: { cast(meshes, from, dir, far, both) -> { p, n, d, m }, all: meshes, movable: Set, fw, right, up (world) }
function hit(ctx, from, dir, far) {
  const h = ctx.cast(ctx.all, from, dir, far, true);
  if (h) { h.movable = ctx.movable.has(h.m); if (h.n.dot(dir) > 0) h.n.negate(); }
  return h;
}

// One leg from A (world) aiming at O: the first solid skin straight on; else the whole leg raked (up to 40 degrees,
// or 85 with nothing above) onto the cheapest solid point; else a knee below the obstacle and the cheapest solid point
// around it. Costs favour straight-on directions; near-ties keep the first candidate, so mirrored legs (mirrored
// search) pick the same one.
// side: +1 / -1 / 0, which way is outboard (0: a centreline leg only leans fore or aft, so it stays symmetric).
// C: the pivot an oleo rakes about (its fork crown / bogie beam), so piston and cylinder stay in line; the leg then
// starts at a: the gland, as far from C along the raked line as A was. Ot: the part origin (default O).
function routeLeg(ctx, A, O, s, side, C = null, Ot = O) {
  const dir = O.clone().sub(A), dO = Math.max(1e-3, dir.length()); dir.normalize();
  const h = hit(ctx, A, dir, dO + 2.5 * s);
  if (h && !h.movable) return { top: h.p.clone().addScaledVector(dir, 0.02 * s), n: h.n, knee: null, m: h.m };
  // search basis that mirrors exactly between a left and a right leg: e2 along the flight direction, e1 outboard
  const e2 = ctx.fw.clone().addScaledVector(dir, -ctx.fw.dot(dir)).normalize();
  const e1 = ctx.right.clone().multiplyScalar(side || 1); e1.addScaledVector(dir, -e1.dot(dir)).addScaledVector(e2, -e1.dot(e2)).normalize();
  // candidate directions: a grid of leans round the leg, plus straight at the part origin (which the hangar put just
  // inside the skin it was dropped on, so a thin boom or strut the grid steps over is still found)
  const scan = (from, th0, th1, dth, far) => {
    let best = null;
    const ds = [Ot.clone().sub(from).normalize()];
    for (let th = th0; th <= th1; th += dth) for (let ph = side ? 0 : 90; ph < 360; ph += side ? 20 : 180) {
      const t = th * DEG, f = ph * DEG;
      ds.push(dir.clone().multiplyScalar(Math.cos(t)).addScaledVector(e1, Math.sin(t) * Math.cos(f)).addScaledVector(e2, Math.sin(t) * Math.sin(f)));
    }
    for (const d of ds) {
      const t = Math.acos(Math.min(1, d.dot(dir))); if (t > th1 * DEG + 1e-6) continue;
      const hh = hit(ctx, from, d, far);
      if (!hh || hh.movable || hh.d < 0.03 * s) continue;
      const cost = hh.d * (1 + 0.8 * (1 - Math.cos(t)) + 0.8 * Math.abs(d.dot(e1))); // leaning sideways costs more than fore / aft
      if (!best || cost < best.cost - 1e-3 * s) best = { cost, top: hh.p.clone().addScaledVector(d, 0.02 * s), n: hh.n, m: hh.m };
    }
    return best;
  };
  // nothing above at all, or the obstacle sits right on the leg: lean further instead of bending
  const P = C || A, rake = scan(P, 5, 40, 7, dO + 2.5 * s + A.distanceTo(P)) || (!h || h.d < 0.2 * s ? scan(P, 45, 85, 8, 3.5 * s) : null);
  if (rake) return { a: P.clone().addScaledVector(rake.top.clone().sub(P).normalize(), A.distanceTo(P)), top: rake.top, n: rake.n, knee: null, m: rake.m };
  // a knee just under the obstacle, else lower down (more room to pass under a deep control surface), else lean from A
  const kd = h ? Math.min(dO, h.d - 0.08 * s) : 0;
  for (const f of [1, 0.5, 0]) {
    const K = kd * f > 0.03 * s ? A.clone().addScaledVector(dir, kd * f) : null, bent = scan(K || A, 12, 85, 8, 3.5 * s);
    if (bent) return { top: bent.top, n: bent.n, knee: K, m: bent.m };
    if (!K) break;
  }
  return { top: O.clone(), n: null, knee: null }; // nothing solid in reach: the leg ends at the part origin, as before
}

// A brace from F (on the leg) to the nearest solid structure along one of the horizontal directions hs, climbing.
function routeBrace(ctx, F, hs, s, maxL, r0) {
  let best = null;
  for (const hd of hs) for (const el of [25, 35, 45, 55, 65]) {
    const d = hd.clone().multiplyScalar(Math.cos(el * DEG)).addScaledVector(ctx.up, Math.sin(el * DEG)).normalize();
    const from = F.clone().addScaledVector(d, r0), hh = hit(ctx, from, d, maxL);
    if (!hh || hh.movable || hh.d < 0.15 * s) continue;
    if (!best || hh.d < best.d - 1e-3 * s) best = { d: hh.d, b: hh.p.clone().addScaledVector(d, 0.02 * s) };
  }
  return best ? { a: F.clone(), b: best.b } : null;
}

// Only the meshes within reach of a part (each ray tests every mesh's bounding sphere otherwise: the Jumbo has hundreds).
function near(ctx, c, R) {
  const cache = ctx.spheres || (ctx.spheres = new Map());
  const all = ctx.all.filter((m) => {
    let sp = cache.get(m);
    if (!sp) { const g = m.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); sp = g.boundingSphere.clone().applyMatrix4(m.matrixWorld); cache.set(m, sp); }
    return sp.center.distanceTo(c) < R + sp.radius;
  });
  return { ...ctx, all };
}

const sideOf = (gp) => (Math.abs(gp.pos[0]) < 0.05 ? 0 : gp.pos[0] > 0 ? 1 : -1); // outboard, in the design frame

// Wheeled gear. Returns the routed leg tops (world) for the wells, or null if the part has no routable leg.
export function routeGear(gp, gobj, ctx) {
  const gl = gobj.userData.gearLeg, gi = PARTS[gp.id].gear;
  if (!gl || !gobj.userData.reroute || PARTS[gp.id].cat === 'car') return null;
  gobj.updateMatrixWorld(true);
  const o = gl.opts, Wm = gobj.matrixWorld, inv = Wm.clone().invert(), s = Math.cbrt(Math.abs(Wm.determinant()));
  const q = levelQuat(gp), side = sideOf(gp);
  ctx = near(ctx, V(0, 0, 0).applyMatrix4(Wm), (o.len + 4) * s);
  // the wheel frame in the part frame and in the world; a spring leg on the inboard side (a yoke on the centreline)
  const T = new THREE.Matrix4().compose(V(0, -o.len, 0), q, V(1, 1, 1)), TW = Wm.clone().multiply(T);
  const sideL = side ? -side * (gp.mirror ? -1 : 1) : 0;
  const O = V(0, 0, 0).applyMatrix4(Wm), legs = [], kind = gl.dims.kind;
  for (const aL of gl.anchors(sideL)) {
    const A = aL.clone().applyMatrix4(TW);
    // an oleo stays on the wheel's axis: aim straight up the wheel frame to the part origin's height
    const upT = V(0, 1, 0).transformDirection(TW), aim = o.fairing ? O : A.clone().addScaledVector(upT, Math.max(0.05, O.clone().sub(A).dot(upT)));
    const C = o.fairing ? null : V(0, kind === 'bogie' ? 0 : o.r * 1.1 + 0.04, 0).applyMatrix4(TW); // fork crown / bogie beam
    const res = routeLeg(ctx, A, aim, s, side, C, O); legs.push({ A: res.a || A, ...res });
  }
  // braces on long oleo legs and bogies, if there is structure to take them
  const braces = [], L0 = legs[0], top0 = L0.knee || L0.top, legLen = top0.distanceTo(L0.A);
  const ro = gl.dims.ro * s;
  if (legLen > 0.5 * s && ((kind === 'oleo' && !o.steer && !o.fairing && o.len > 1.2) || kind === 'bogie')) {
    const inb = ctx.right.clone().multiplyScalar(side ? -side : 1), maxL = o.len * s * 0.9;
    const db = routeBrace(ctx, L0.A.clone().lerp(top0, 0.4), [ctx.fw.clone().negate(), ctx.fw.clone()], s, maxL, ro * 1.6);
    if (db) braces.push(db);
    if (kind === 'bogie' && side) { const sb = routeBrace(ctx, L0.A.clone().lerp(top0, 0.55), [inb, inb.clone().negate()], s, maxL, ro * 1.6); if (sb) braces.push(sb); }
  }
  const toP = (p) => p.clone().applyMatrix4(inv), toD = (d) => d.clone().transformDirection(inv);
  gobj.userData.reroute({
    q, side: sideL, boot: !gi.retract || legs.some((l) => l.knee), fwd: toD(ctx.fw),
    legs: legs.map((l) => ({ a: toP(l.A), top: toP(l.top), knee: l.knee ? toP(l.knee) : null, n: l.n ? toD(l.n) : null })),
    braces: braces.map((b) => ({ a: toP(b.a), b: toP(b.b) })),
  });
  gobj.userData.gearRoute = { legs: legs.map((l) => ({ a: l.A, knee: l.knee, top: l.top, n: l.n })), braces }; // for tools/test/gearcheck
  return legs;
}

// Floats and skids: posts from each station up to the skin (leaning in a little), an N diagonal between the posts, and
// spreader bars meeting the float on the other side at the centre plane.
export function routeStruts(gp, gobj, ctx, partner) {
  const sp = gobj.userData.strutLegs; if (!sp || !gobj.userData.restrut) return;
  gobj.updateMatrixWorld(true);
  const Wm = gobj.matrixWorld, inv = Wm.clone().invert(), s = Math.cbrt(Math.abs(Wm.determinant())), side = sideOf(gp);
  ctx = near(ctx, V(0, 0, 0).applyMatrix4(Wm), (Math.max(...sp.stations.map(Math.abs)) + 4.5) * s);
  const upW = V(0, 1, 0).transformDirection(Wm), inW = ctx.right.clone().multiplyScalar(-side), lean = sp.kind === 'skid' ? 0.35 : 0.2;
  const posts = sp.stations.map((z) => {
    const B = V(0, sp.y, z).applyMatrix4(Wm), aim = B.clone().addScaledVector(upW, s).addScaledVector(inW, lean * s);
    return { B, ...routeLeg(ctx, B, aim, s, side) };
  });
  const segs = [], boots = [], clear = (a, b) => { const d = b.clone().sub(a), L = d.length(); return !hit(ctx, a, d.normalize(), L); };
  for (const p of posts) {
    const pts = [p.B, ...(p.knee ? [p.knee] : []), p.top];
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1], foot: i === 0 });
    if (p.n) boots.push({ p: p.top, n: p.n, dir: p.top.clone().sub(pts.at(-2)).normalize() });
  }
  if (sp.kind === 'float' && posts.length === 2) {
    // N: from the rear post's foot to just under the front post's top
    const [f, r] = posts, a = r.B.clone().addScaledVector(upW, 0.08 * s), b = f.B.clone().lerp(f.knee || f.top, 0.8);
    if (clear(a, b)) segs.push({ a, b, k: 0.7 });
    // spreader bars: from a quarter way up each post to the centre plane between the two floats
    if (partner) for (const p of posts) { // (both floats meet exactly at the centre plane: no order dependence)
      const a2 = p.B.clone().lerp(p.knee || p.top, 0.25), b2 = a2.clone().applyMatrix4(ctx.rootInv).setX(0).applyMatrix4(ctx.rootW);
      if (clear(a2, b2)) segs.push({ a: a2, b: b2, k: 0.7 });
    }
  }
  const toP = (p) => p.clone().applyMatrix4(inv), toD = (d) => d.clone().transformDirection(inv);
  gobj.userData.restrut(segs.map((x) => ({ ...x, a: toP(x.a), b: toP(x.b) })), boots.map((t) => ({ p: toP(t.p), n: toD(t.n), dir: toD(t.dir) })), toD(ctx.fw));
  gobj.userData.gearRoute = { legs: posts.map((p) => ({ a: p.B, knee: p.knee, top: p.top, n: p.n })), braces: [], free: segs.filter((x) => x.k) }; // for tools/test/gearcheck
}
