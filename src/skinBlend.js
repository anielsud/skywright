// One skin where parts meet. A body's skin is rebuilt (finer where something touches it) and every vertex is pushed out
// along its normal onto the smooth union of the body with what is mounted on it:
//   - canopies: a "pedestal" under the glass footprint (flaring as it goes down, with a turtledeck behind) that the body
//     swells up into, so the skin always rises to meet the glass, however high, far forward or off-centre it sits;
//   - other bodies it touches (pods on pods, booms into pods): both skins blend into one neck, each keeping its own half;
//   - engines, tanks and boosters it touches: the skin flows into the nacelle;
//   - rotor masts: a faired mast base.
// Then the cockpit opening is cut where the skin is inside the glass (exact, along the implicit glass volume), the glass
// is trimmed where it is inside the skin, and a sill runs along the seam with a dark tub under it.
// Fields are approximate signed distances in world metres (evaluated analytically from the part shapes, so the result
// follows resizing and mirroring). Everything here is cosmetic: physics reads partInfo(), which never sees it.
import * as THREE from 'three';
import { PARTS, revolve, airfoil } from './parts.js';
import { PM } from './planeMaterials.js';
import { V, ringLoft, fighterGlassR, fixNormals, clipGeometry, posKey, leatherMat } from './partDetail.js';
export { clipGeometry };
import { clamp } from './noise.js';

const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const axisScales = (W) => { const e = W.elements; return [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])]; };
const _l = V();
const TUCK = 0.035, DEEP = 0.5, RAMP_MAX = 1.6; // the windscreen fairing reaches at most 60 % of the glass's half-length ahead of it

// ---------- cockpit shapes, in a frame (u across, h up out of the mount, v along) ----------
const id3 = (q) => [q.x, q.y, q.z], idInv = (u, h, v) => V(u, h, v);
const ell = (u, v, a, b) => (Math.hypot(u / a, v / b) - 1) * Math.min(a, b);
const CK = {
  ck_bubble: {
    frame: id3, local: idInv, up: V(0, 1, 0), a: 0.45, b: 1.0, c: 0.425, v0: -1, v1: 1, flare: 0.35, tub: 0.76, sill: 0.026,
    turtle: { cz: 0.6, ex: 0.3, ey: 0.13, ez: 1.5 },
    foot: (u, v, g) => ell(u, v, 0.45 * g, 1.0 * g),
    vol: (u, h, v) => (h >= 0 ? (Math.hypot(u / 0.45, h / 0.425, v) - 1) * 0.425 : ell(u, v, 0.45, 1.0)),
    wall(th, t) { const s = Math.sin(th), c = -Math.cos(th); if (t < 0.4) return [0.45 * s, -DEEP * (1 - t / 0.4), c]; const ph = ((t - 0.4) / 0.6) * Math.PI / 2 * 0.96; return [0.45 * s * Math.cos(ph), 0.425 * Math.sin(ph), c * Math.cos(ph)]; },
  },
  ck_fighter: {
    frame: id3, local: idInv, up: V(0, 1, 0), a: 0.5, b: 1.8, c: 0.57, v0: -1.6, v1: 2.0, flare: 0.25, tub: 0.55, sill: 0.03,
    turtle: { cz: 1.7, ex: 0.3, ey: 0.26, ez: 2.3 },
    foot(u, v, g) { const vz = clamp(v, -1.58, 1.98); let d = Math.abs(u) - fighterGlassR(vz) * g; const dz = Math.max(-1.6 - v, v - 2.0); if (dz > 0) d = Math.max(d, dz); return d; },
    vol(u, h, v) { if (v < -1.6 || v > 2.0) return Math.max(-1.6 - v, v - 2.0) + 0.01; return Math.hypot(u, h / 1.15) - fighterGlassR(v); },
    wall(th, t) { const f = th < Math.PI ? th / Math.PI : (2 * Math.PI - th) / Math.PI, side = th < Math.PI ? 1 : -1, z = -1.52 + 3.45 * f, r = fighterGlassR(z), ph = -1.25 + t * 2.75; return [side * r * Math.cos(ph), 1.15 * r * Math.sin(ph), z]; },
  },
  ck_open: {
    frame: id3, local: idInv, up: V(0, 1, 0), a: 0.4, b: 0.56, c: 0.1, v0: -0.56, v1: 0.56, flare: 0.3, tub: 0.5, sill: 0.06, rimColour: true,
    turtle: { cz: 0.5, ex: 0.16, ey: 0.2, ez: 0.75 },
    foot: (u, v, g) => ell(u, v, 0.4 * g, 0.56 * g),
    vol: (u, h, v) => (h > 0.4 ? h - 0.4 : ell(u, v, 0.37, 0.52)),
    wall(th, t) { return [0.37 * Math.sin(th), -DEEP + t * (DEEP + 0.3), -0.52 * Math.cos(th)]; },
  },
  ck_glassnose: { // dome looking forward (-z): h = -z, v = y
    frame: (q) => [q.x, -q.z, q.y], local: (u, h, v) => V(u, v, -h), up: V(0, 0, -1), a: 0.7, b: 0.7, c: 0.98, v0: -0.7, v1: 0.7, flare: 0.45, ramp: 0, tub: 0.6, sill: 0.04,
    foot: (u, v, g) => Math.hypot(u, v) - 0.7 * g,
    vol: (u, h, v) => (h >= 0 ? (Math.hypot(u / 0.7, v / 0.7, h / 0.98) - 1) * 0.7 : Math.hypot(u, v) - 0.7),
    wall(th, t) { const s = Math.sin(th), c = Math.cos(th); if (t < 0.4) return [0.7 * s, -DEEP * (1 - t / 0.4), 0.7 * c]; const ph = ((t - 0.4) / 0.6) * Math.PI / 2 * 0.96; return [0.7 * s * Math.cos(ph), 0.98 * Math.sin(ph), 0.7 * c * Math.cos(ph)]; },
  },
};
const MAST = { r_main: 0.7, r_main4: 0.9 };
export const seatsCanopy = (id) => !!CK[id];

// ---------- fields ----------
function profTable(prof) {
  const z0 = prof[0][0], z1 = prof.at(-1)[0], N = 256, r = new Float32Array(N + 1), span = z1 - z0 || 1;
  for (let i = 0; i <= N; i++) {
    const z = z0 + span * (i / N); let best = 0;
    for (let k = 1; k < prof.length; k++) {
      const a = prof[k - 1], b = prof[k], lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      if (z < lo - 1e-9 || z > hi + 1e-9) continue;
      const t = hi - lo < 1e-9 ? 1 : (z - a[0]) / (b[0] - a[0]); best = Math.max(best, a[1] + (b[1] - a[1]) * t);
    }
    r[i] = best;
  }
  const at = (z) => { const u = clamp((z - z0) / span, 0, 1) * N, i = Math.min(N - 1, Math.floor(u)); return r[i] + (r[i + 1] - r[i]) * (u - i); };
  const slope = (z) => { const u = clamp((z - z0) / span, 0, 1) * N, i = Math.min(N - 1, Math.floor(u)); return (r[i + 1] - r[i]) / (span / N); };
  return { z0, z1, at, slope };
}
function bodyField(obj) {
  const b = obj.userData.body, W = b.skin.matrixWorld, inv = W.clone().invert(), sc = axisScales(W), s = Math.min(...sc);
  const T = profTable(b.prof), sxy = Math.min(b.sx, b.sy), yOff = b.yOff;
  const f = (p) => {
    _l.copy(p).applyMatrix4(inv);
    const z = _l.z, zc = z < T.z0 ? T.z0 : z > T.z1 ? T.z1 : z, r = T.at(zc), sl = T.slope(zc), yo = yOff ? yOff(zc) : 0;
    let d = ((Math.hypot(_l.x / b.sx, (_l.y - yo) / b.sy) - r) * sxy) / Math.sqrt(1 + sl * sl);
    const dz = Math.max(T.z0 - z, z - T.z1);
    if (dz > 0) d = d > 0 ? Math.hypot(d, dz) : dz;
    return d * s;
  };
  const rMax = Math.max(...b.prof.map((q) => q[1]));
  return { kind: 'body', obj, f, box: new THREE.Box3().setFromObject(b.skin), rW: rMax * Math.max(b.sx, b.sy) * Math.max(sc[0], sc[1]), T, inv, W, sc, b };
}
// tapered capsule along local z from z0 to z1 (engines, tanks, boosters), kept just inside the real cowl so skin that
// runs into it is hidden by the cowl; rear radius as a fraction of the front one per pod
const POD_TAPER = { e_radial: 0.7, e_piston: 0.92, e_turboprop: 0.92, e_jet_small: 0.8, e_jet_ab: 0.8, e_turbofan: 0.62, e_electric: 0.82, e_ramjet: 1, x_tank: 0.6, x_smoke: 0.6 };
function podField(obj, P, id) {
  const W = obj.matrixWorld, inv = W.clone().invert(), s = Math.min(...axisScales(W)), r0 = P.r * 0.9, r1 = r0 * (POD_TAPER[id] ?? 1), za = P.z0 + r0 * 0.4, zb = P.z1 - r1 * 0.4;
  const f = (p) => { _l.copy(p).applyMatrix4(inv); const zc = clamp(_l.z, za, zb), r = r0 + (r1 - r0) * ((zc - za) / (zb - za || 1)); return (Math.hypot(_l.x, _l.y, _l.z - zc) - r) * s; };
  const box = new THREE.Box3(V(-P.r, -P.r, P.z0), V(P.r, P.r, P.z1)).applyMatrix4(W);
  return { kind: 'pod', obj, f, box, rW: P.r * s };
}
// rounded cone along local y (rotor mast fairing)
function coneField(obj, yb, rb, yt, rt) {
  const W = obj.matrixWorld, inv = W.clone().invert(), s = Math.min(...axisScales(W));
  const f = (p) => {
    _l.copy(p).applyMatrix4(inv); const t = clamp((_l.y - yb) / (yt - yb), 0, 1), r = rb + (rt - rb) * t;
    let d = Math.hypot(_l.x, _l.z) - r; const dy = Math.max(yb - _l.y, _l.y - yt); if (dy > 0) d = d > 0 ? Math.hypot(d, dy) : dy;
    return d * s * 0.9;
  };
  return { kind: 'mast', obj, f, box: new THREE.Box3(V(-rb, yb, -rb), V(rb, yt, rb)).applyMatrix4(W), rW: rb * s };
}
// wing / tail as a swept airfoil box (span along local x; fins are built span-up and turned)
function wingField(obj, id) {
  const o = PARTS[id].wing, fin = PARTS[id].attach === 'fin', W = obj.matrixWorld, inv = W.clone().invert(), s = Math.min(...axisScales(W));
  const dih = fin ? 0 : THREE.MathUtils.degToRad(o.dihedral || 0), th = o.thick ?? 0.12, cam = fin ? 0 : (o.camber ?? 0.02), { up } = airfoil(40, th, cam);
  const chordAt = (t) => (o.planform === 'ellipse' ? Math.max(o.tip, o.root * Math.sqrt(Math.max(0, 1 - t * t))) : o.root + (o.tip - o.root) * t);
  const leAt = (t) => (o.planform === 'ellipse' ? -o.root / 2 + (o.root - chordAt(t)) * 0.25 + o.sweep * t : -o.root / 2 + o.sweep * t);
  const halfT = (x) => { for (let i = 1; i < up.length; i++) if (up[i][0] >= x) { const a = up[i - 1], b = up[i]; return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0] || 1)) - cam * 4 * x * (1 - x); } return 0; };
  const L = o.span * Math.cos(dih);
  const f = (p) => {
    _l.copy(p).applyMatrix4(inv); let x = _l.x, y = _l.y; if (fin) { x = _l.y; y = -_l.x; }
    const t = clamp(x / L, 0, 1), c = chordAt(t), le = leAt(t), xc = clamp((_l.z - le) / c, 0, 1), yc = t * o.span * Math.sin(dih) + cam * 4 * xc * (1 - xc) * c;
    const dy = Math.abs(y - yc) - halfT(xc) * c, dz = Math.max(le - _l.z, _l.z - le - c), ds = Math.max(-x, x - L);
    const m = Math.max(dy, dz, ds), d = m > 0 ? Math.hypot(Math.max(dy, 0), Math.max(dz, 0), Math.max(ds, 0)) : m;
    return d * s;
  };
  return { kind: 'wing', obj, f, box: new THREE.Box3().setFromObject(obj), L, inv, fin };
}
// Gear sponson: an elongated blister along the body axis around a retracting leg's strut top (C-130 style), for legs
// hung off the side of a body under a high wing, whose strut tops otherwise end in mid air beside the fuselage.
function sponsonField(O, axis, r, hl) {
  const _d = V();
  const f = (p) => { _d.copy(p).sub(O); const a = _d.dot(axis); _d.addScaledVector(axis, -a); return (Math.hypot(_d.length() / r, a / hl) - 1) * r; };
  const box = new THREE.Box3().setFromCenterAndSize(O, V(1, 1, 1).multiplyScalar(2 * r)).union(new THREE.Box3().setFromCenterAndSize(O.clone().addScaledVector(axis, hl), V(1, 1, 1).multiplyScalar(2 * r))).union(new THREE.Box3().setFromCenterAndSize(O.clone().addScaledVector(axis, -hl), V(1, 1, 1).multiplyScalar(2 * r)));
  return { kind: 'sponson', f, box, rW: r };
}
// the body axis point closest to a world point, and a skin-function helper
function axisPoint(B, wp) {
  const l = wp.clone().applyMatrix4(B.inv), z = clamp(l.z, B.T.z0, B.T.z1);
  return V(0, B.b.yOff ? B.b.yOff(z) : 0, z).applyMatrix4(B.W);
}
const boxNear = (a, b, k) => a.clone().expandByScalar(k).intersectsBox(b);

// A cockpit seated on body B: the pedestal field it adds to B, and its glass volume (for the opening).
function cockpitSetup(cp, cobj, B) {
  const C = CK[cp.id], W = cobj.matrixWorld, inv = W.clone().invert(), sc = axisScales(W), s = Math.min(...sc);
  const O = V().setFromMatrixPosition(W), A = axisPoint(B, O), [, hA] = C.frame(A.clone().applyMatrix4(inv));
  if (!(hA < -0.02)) return null; // the body is not under (or behind) the glass: nothing to sit on
  const gap = B.f(O); if (gap > 2.5) return null;
  const hb = hA, gMax = 1 + C.flare * Math.max(0, -hb), T = C.turtle, vc = (C.v0 + C.v1) / 2, ramp = C.ramp ?? 2.4;
  // the fairing only runs forward over body: stop where the body ends ahead of the glass (a canopy at the very nose)
  const span = Math.abs(C.v0 - vc); let ext = 0;
  for (let k = 1; k <= 12; k++) { const e = span * (RAMP_MAX - 1) * (k / 12); if (B.f(C.local(0, hb * 0.6, C.v0 - e).applyMatrix4(W)) > 0) break; ext = e; }
  const rampMax = 1 + ext / span, gvMax = Math.min(rampMax, 1 + ramp * Math.max(0, -hb));
  const fl = (p) => { _l.copy(p).applyMatrix4(inv); return C.frame(_l); };
  const f = (p) => {
    const [u, h, v] = fl(p), dep = Math.max(0, -h), g = 1 + C.flare * dep, gv = Math.min(rampMax, 1 + ramp * dep);
    // sides flare out going down; the front runs forward as it goes down: a windscreen fairing sloping down into the skin
    // ahead of the glass (it used to rake back, which left the glass front sticking out over a cliff)
    const vq = v < vc ? vc + (v - vc) / gv : v;
    let d = Math.max(smax(C.foot(u, vq, g), h - TUCK, 0.1), hb - h); // rounded deck edge
    if (T) { const dt = Math.max((Math.hypot(u / T.ex, h / T.ey, (v - T.cz) / T.ez) - 1) * Math.min(T.ex, T.ey, T.ez), hb - h); d = smin(d, dt, 0.1); }
    return d * s;
  };
  const vol = (p) => { const [u, h, v] = fl(p); return Math.max(C.vol(u, h, v), -(h + DEEP)) * s; };
  // world box of the pedestal (footprint grown by the flare, from the axis up to the turtledeck)
  const box = new THREE.Box3(), vMax = Math.max(C.v1, T ? T.cz + T.ez : C.v1);
  for (const u of [-C.a * gMax, C.a * gMax]) for (const h of [hb, Math.max(TUCK, T ? T.ey : 0)]) for (const v of [vc + (C.v0 * gMax - vc) * gvMax, vMax]) box.expandByPoint(C.local(u, h, v).applyMatrix4(W));
  const k = clamp(0.42 * C.a * s, 0.06, 0.4);
  const ped = { kind: 'ped', obj: cobj, f, box: box.expandByScalar(k), k, reach: Math.max(0.3, gap + C.a * s * 1.2 + k) };
  const vbox = new THREE.Box3();
  for (const u of [-C.a, C.a]) for (const h of [-DEEP, C.c + 0.1]) for (const v of [C.v0, C.v1]) vbox.expandByPoint(C.local(u, h, v).applyMatrix4(W));
  return { cp, cobj, C, W, inv, s, ped, vol, vbox, up: C.up.clone().transformDirection(W).normalize() };
}

// ---------- union of a body with its fields ----------
function makeUnion(B, fields) {
  const act = [];
  const pick = (p) => { act.length = 0; for (const F of fields) if (F.box.containsPoint(p)) act.push(F); return act; };
  // stop: the point has crossed into another body's half of the neck (bisector) or reached a pod's skin
  const eval_ = (p, list) => { const fb = B.f(p); let f = fb, stop = false; for (const F of list) { const g = F.f(p); if ((F.stop === 'bis' && g < fb) || (F.stop === 'in' && g <= 0)) stop = true; f = smin(f, g, F.k); } return { f, stop }; };
  const tmp = [];
  return { pick, eval: eval_, at: (p) => { tmp.length = 0; for (const F of fields) if (F.box.containsPoint(p)) tmp.push(F); return eval_(p, tmp).f; } };
}
const _g = V(), _gp = V();
function gradient(U, list, p, h, out) {
  for (let a = 0; a < 3; a++) { _gp.copy(p); _gp.setComponent(a, p.getComponent(a) + h); const f1 = U.eval(_gp, list).f; _gp.setComponent(a, p.getComponent(a) - h); out.setComponent(a, f1 - U.eval(_gp, list).f); }
  return out.normalize();
}
// Push points (world, with world normals) out along their normals onto the union surface, keeping each point's own
// distance to the body (decals float a few mm above it). A point stops early where it crosses into another body's half
// of a shared neck (that body's skin covers the rest) or reaches a pod's skin. Returns per-point displacement.
function project(U, B, P, N, { steps = 12 } = {}) {
  const n = P.length / 3, moved = new Float32Array(n), p0 = V(), nv = V(), p = V(), list = [];
  for (let i = 0; i < n; i++) {
    p0.fromArray(P, i * 3);
    const act = U.pick(p0); if (!act.length) continue;
    list.length = 0; list.push(...act);
    const fb0 = B.f(p0), r0 = U.eval(p0, list);
    if (r0.f >= fb0 - 1e-5 || r0.stop) continue; // nothing mounted near enough to change the skin here
    nv.fromArray(N, i * 3);
    let reach = 0; for (const F of list) reach = Math.max(reach, F.reach || F.k);
    let hitSurf = false;
    const done = (t) => { p.copy(p0).addScaledVector(nv, t); const r = U.eval(p, list); hitSurf = r.f - fb0 >= 0; return hitSurf || r.stop; };
    let lo = 0, hi = -1, prev = 0;
    for (let s = 1; s <= steps; s++) { const t = (reach * s) / steps; if (done(t)) { lo = prev; hi = t; break; } prev = t; }
    let t;
    if (hi < 0) t = reach; // still inside after the whole reach: leave it there, out of sight
    else { for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; if (done(m)) hi = m; else lo = m; } t = hi; }
    p.copy(p0).addScaledVector(nv, t); p.toArray(P, i * 3); moved[i] = t;
    if (hi >= 0) { // the union's normal where it has really moved; the skin's own where it barely did (no shading seam)
      gradient(U, list, p, 0.003, _g);
      if (_g.dot(nv) > 0.05) { const w = Math.min(1, t / (0.03 * Math.max(0.5, B.rW))); _g.lerp(nv, 1 - w * w * (3 - 2 * w)).normalize().toArray(N, i * 3); }
    }
  }
  return moved;
}

// ---------- reshaping one body ----------
function reshape(B, fields, cks, quick) {
  const b = B.b, skin = b.skin, W = skin.matrixWorld, inv = B.inv, sc = B.sc;
  // finer rings where something touches, and more segments round
  const hW = clamp(B.rW * 0.1, 0.035, 0.16) * (quick ? 1.8 : 1), hz = hW / sc[2], spans = [];
  for (const F of fields) { const bx = F.box.clone().expandByScalar(F.k || 0).applyMatrix4(inv); spans.push([bx.min.z, bx.max.z, F.h ?? hW]); }
  // (a long profile segment reaching into a seam's zone is cut at the zone's edge first, so only that part gets the
  // seam's close rings)
  const cuts = spans.filter((q) => q[2] < hW).flatMap((q) => [q[0], q[1]]), src = [b.prof[0]];
  for (let k = 1; k < b.prof.length; k++) {
    const [za, ra] = b.prof[k - 1], [zb, rb] = b.prof[k];
    for (const z of cuts.filter((z) => (z - za) * (z - zb) < 0).sort((x, y) => (x - y) * Math.sign(zb - za))) src.push([z, ra + ((rb - ra) * (z - za)) / (zb - za)]);
    src.push(b.prof[k]);
  }
  const prof = [src[0]];
  for (let k = 1; k < src.length; k++) {
    const [za, ra] = src[k - 1], [zb, rb] = src[k], on = spans.filter(([lo, hi, h]) => (h < hW ? Math.min(hi, Math.max(za, zb)) - Math.max(lo, Math.min(za, zb)) > 1e-6 : Math.max(za, zb) >= lo && Math.min(za, zb) <= hi)), hit = on.length > 0;
    const h = Math.min(hW, ...on.map((q) => q[2])), segL = Math.hypot((zb - za) / (h / sc[2]), ((rb - ra) * Math.max(b.sx * sc[0], b.sy * sc[1])) / h); // flat noses need rings too; a seam its own spacing
    const n = hit ? Math.max(1, Math.min(60, Math.ceil(segL))) : 1;
    for (let s = 1; s <= n; s++) prof.push([za + ((zb - za) * s) / n, ra + ((rb - ra) * s) / n]);
  }
  const rL = Math.max(...b.prof.map((q) => q[1])), circ = 2 * Math.PI * rL * Math.max(b.sx * sc[0], b.sy * sc[1]);
  const segs = Math.max(b.segs || 32, Math.min(quick ? 64 : 112, Math.ceil(circ / hW / 4) * 4));
  let geo = revolve(prof, { segs, sx: b.sx, sy: b.sy, yOff: b.yOff, cap: true });
  const U = makeUnion(B, fields);
  // world positions/normals, push, back to local
  const pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count, P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  const nm = new THREE.Matrix3().getNormalMatrix(W), WT = new THREE.Matrix3().setFromMatrix4(W).transpose(), v = V();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(W).toArray(P, i * 3); v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize().toArray(N, i * 3); }
  // vertices sharing a position (a nose or tail apex, the revolve seam) move along one averaged normal: a collapsed apex
  // ring pushed along its spread of normals opened into a hole
  { const groups = new Map(); for (let i = 0; i < n; i++) { const k = posKey(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); const gk = groups.get(k); if (gk) gk.push(i); else groups.set(k, [i]); }
    for (const gk of groups.values()) { if (gk.length < 2) continue; v.set(0, 0, 0); for (const i of gk) { v.x += N[i * 3]; v.y += N[i * 3 + 1]; v.z += N[i * 3 + 2]; } if (v.lengthSq() < 1e-12) continue; v.normalize(); for (const i of gk) v.toArray(N, i * 3); } }
  const moved = project(U, B, P, N, { steps: quick ? 7 : 12 });
  for (let i = 0; i < n; i++) {
    if (!moved[i]) continue;
    v.fromArray(P, i * 3).applyMatrix4(inv); pos.setXYZ(i, v.x, v.y, v.z);
    v.fromArray(N, i * 3).applyMatrix3(WT).normalize(); nrm.setXYZ(i, v.x, v.y, v.z);
  }
  // the cockpit openings: cut the skin where it is inside a glass volume (only skin facing the glass's way)
  if (cks.length) {
    const val = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      v.fromArray(P, i * 3); let m = 1;
      for (const ck of cks) { if (!ck.vbox.containsPoint(v)) continue; _g.fromArray(N, i * 3); if (_g.dot(ck.up) < 0.2) continue; m = Math.min(m, ck.vol(v)); } // only the deck facing the glass
      val[i] = m;
    }
    const g2 = clipGeometry(geo, val); if (g2) { geo.dispose(); geo = g2; skin.userData.openOk = 'cockpit opening: the sill and the tub close it'; }
  }
  fixNormals(geo); geo.computeBoundingSphere(); geo.computeBoundingBox();
  const old = skin.geometry; skin.geometry = geo; old.dispose();
  // registration letters ride the swollen skin at their own few mm above it
  for (const m of B.obj.children) {
    if (!m.isMesh || m === skin || !m.userData.cosmetic || !m.geometry.attributes.normal) continue;
    const dp = m.geometry.attributes.position, dn = m.geometry.attributes.normal, Wm = m.matrixWorld, Pm = new Float32Array(dp.count * 3), Nm = new Float32Array(dp.count * 3);
    const nmm = new THREE.Matrix3().getNormalMatrix(Wm), invm = Wm.clone().invert();
    for (let i = 0; i < dp.count; i++) { v.fromBufferAttribute(dp, i).applyMatrix4(Wm).toArray(Pm, i * 3); v.fromBufferAttribute(dn, i).applyMatrix3(nmm).normalize().toArray(Nm, i * 3); }
    const mv = project(U, B, Pm, Nm, { steps: 8 });
    for (let i = 0; i < dp.count; i++) if (mv[i]) { v.fromArray(Pm, i * 3).applyMatrix4(invm); dp.setXYZ(i, v.x, v.y, v.z); }
    dp.needsUpdate = true; m.geometry.computeBoundingSphere();
  }
  return U;
}

// ---------- seating a canopy: trim the glass, sill along the seam, tub under it ----------
function seatCanopy(ck, U, bodyColor, addTo, rivets) {
  const { C, cobj, W, s, cp } = ck;
  const skinF = (p) => U.at(p), gradAt = (p) => { const g = V(), q = V(); for (let a = 0; a < 3; a++) { q.copy(p); q.setComponent(a, p.getComponent(a) + 0.003); const f1 = U.at(q); q.setComponent(a, p.getComponent(a) - 0.003); g.setComponent(a, f1 - U.at(q)); } return g.normalize(); };
  // trim the glass inside the skin; the skirt below the base becomes visible once trimmed
  cobj.traverse((m) => {
    if (!m.isMesh || m.userData.near || !m.material?.transparent || m.material.blending === THREE.AdditiveBlending || m.userData.isDisc || m.userData.screenGlass) return;
    const g = m.geometry, pos = g.attributes.position, val = new Float32Array(pos.count), v = V(); m.updateMatrixWorld();
    for (let i = 0; i < pos.count; i++) val[i] = skinF(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    const g2 = clipGeometry(g, val); if (g2) { m.geometry = fixNormals(g2); g.dispose(); }
    if (m.userData.glassSkirt) m.visible = true;
  });
  if (cobj.userData.rim) cobj.userData.rim.visible = false;
  // seam: down each wall line from the top until it enters the skin
  const NS = 64, seam = [], P = (th, t) => C.local(...C.wall(th, t)).applyMatrix4(W);
  for (let k = 0; k < NS; k++) {
    const th = (k / NS) * Math.PI * 2; let prev = 1, pt = null;
    if (skinF(P(th, 1)) < 0) { seam.push(null); continue; }
    for (let sI = 1; sI <= 30; sI++) {
      const t = 1 - sI / 30;
      if (skinF(P(th, t)) < 0) { let lo = t, hi = prev; for (let it = 0; it < 8; it++) { const m = (lo + hi) / 2; if (skinF(P(th, m)) < 0) lo = m; else hi = m; } pt = P(th, (lo + hi) / 2); break; }
      prev = t;
    }
    seam.push(pt);
  }
  const ok = seam.filter(Boolean).length;
  if (ok < NS * 0.7) return false;
  for (let k = 0; k < NS; k++) if (!seam[k]) { let a = k, b = k; while (!seam[(a + NS) % NS]) a--; while (!seam[b % NS]) b++; seam[k] = seam[(a + NS) % NS].clone().lerp(seam[b % NS], (k - a) / (b - a)); }
  const ctr = seam.reduce((acc, p) => acc.add(p), V()).multiplyScalar(1 / NS), up = ck.up;
  const outOf = (p) => { const d = p.clone().sub(ctr); d.addScaledVector(up, -d.dot(up)); return d.normalize(); };
  // sill: a rounded frame along the seam (leather coaming on open cockpits)
  const rad = C.sill * s, sillPts = seam.map((p) => p.clone().addScaledVector(outOf(p), rad * 0.45).addScaledVector(up, rad * 0.15));
  addTo(cobj, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sillPts, true), NS * 2, rad, C.rimColour ? 10 : 6, true), C.rimColour ? leatherMat(cp.color) : PM.skin(bodyColor));
  // open cockpits: the windscreen stands on the front of that padded coaming
  const scr = cobj.userData.screen;
  if (scr) { let f = null; for (const p of sillPts) { const q = p.clone().applyMatrix4(ck.inv); if (!f || q.z < f.z) f = q; } scr.position.set(0, f.y + C.sill * 0.55, f.z + C.sill * 0.9); }
  // a rivet row on the skin just outside the sill (the frame is screwed down to the deck)
  if (rivets && !C.rimColour) {
    const rp = [], rn = [], curve = new THREE.CatmullRomCurve3(seam, true), L = curve.getLength(), n = Math.max(12, Math.round(L / (0.065 * s)));
    for (let k = 0; k < n; k++) { const p = curve.getPointAt(k / n), o = outOf(p), q = p.clone().addScaledVector(o, rad * 2.2); const g = gradAt(q); rp.push(q.addScaledVector(g, -U.at(q))); rn.push(g); }
    rivets(cobj, rp, rn);
  }
  // tub: dark walls from just inside the seam down to a floor, kept inside the skin
  let depth = C.tub * s;
  const ring = (dd, shrink) => seam.map((p) => { const q = p.clone().addScaledVector(outOf(p), -0.012 * s).addScaledVector(up, -dd); return ctr.clone().addScaledVector(up, -dd).lerp(q, shrink); });
  // (a narrow-bottomed body: the floor narrows, the walls sloping in, before the tub gets shallower; the seat and the
  // pilot's feet need the depth more than the floor needs the width)
  let shrink = 0.82;
  search: for (let it = 0; it < 6; it++) { for (const sh of [0.82, 0.64, 0.48]) if (ring(depth, sh).every((p) => skinF(p) < -0.01) && ring(depth * 0.55, 1 - (1 - sh) / 3).every((p) => skinF(p) < 0)) { shrink = sh; break search; } depth *= 0.75; }
  if (depth < 0.08 * s) return true;
  const rings = [ring(0, 1), ring(depth * 0.55, 1 - (1 - shrink) / 3), ring(depth, shrink)];
  const tg = ringLoft(rings, false, true), idx = tg.index.array; // ringLoft orients outward: flip so the tub faces in
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  tg.computeVertexNormals();
  addTo(cobj, tg, PM.seat(), { shadow: false });
  addTubObstacle(cobj, rings, ck.inv);
  // furniture that follows the tub (a cockpit's userData.tubFit(the rings in its own frame) -> [[geometry, material]]
  // in that frame: side panels, consoles pressed onto the walls, a floor)
  if (cobj.userData.tubFit) try { for (const [geo, mat] of cobj.userData.tubFit(rings.map((r) => r.map((p) => p.clone().applyMatrix4(ck.inv))))) addTo(cobj, geo.applyMatrix4(W), mat, { shadow: false }); } catch (e) { console.warn('tubFit', e); }
  return true;
}
// The tub just built (rings of world points round its wall, top first) as an obstacle for the crew of seats that declare
// obstacles (crew.js: { well }), in the cockpit's own coordinates, every other point round
export function addTubObstacle(cobj, rings, inv) {
  const well = rings.map((r) => r.filter((_, k) => k % 2 === 0).map((p) => p.clone().applyMatrix4(inv).toArray().map((x) => +x.toFixed(4))));
  for (const st of cobj.userData.seats || []) if (st.obstacles) st.obstacles = [...st.obstacles.filter((o) => o.name !== 'tub'), { name: 'tub', well }];
  cobj.userData.tubWell = rings.map((r) => r.map((p) => p.clone().applyMatrix4(inv).toArray())); // (every point: interior.js keeps other parts out of it)
}

// ---------- tubes meeting end to end: one fair skin across the seam ----------
// Bodies (userData.body) and tube-shaped parts (userData.tube: nose and tail cones, the airliner nose, the heli bubble)
// bolted end to end, or one plugged into the tapering end of the other, straight or up to 50 deg apart, a little apart or
// into each other, at any size, rotation or mirror. Each used to keep its own end: a step where the radii differed, a
// groove between two rounded ends, and, even where they matched (the airliner nose on its tube), a dark ring right at
// the seam, because each end ring's vertex normals had been averaged with the flat end cap behind it, so they pointed
// along the axis and the skin shaded as if it curled in. Now, over a short zone either side of the seam, both skins
// become one fair surface: at each angle round the seam axis a cubic from A's radius and slope where its zone starts to
// B's where its zone ends (never dipping below both). Each part's end is slid along its own axis onto the seam plane
// (tilted ends, gaps, overlaps); a rounded-off end and anything past it fold flat onto that plane as the cap. Every point
// of the part in its zone keeps where it sits in its own tube's section (on the skin, inside, or proud of it) and is
// placed at that fraction of the fair radius, so the skin lands on the fair surface and what rides on it rides along;
// the skin takes the fair surface's normals, the same function on both sides. The panel texture carries the joint
// line; there is no geometric groove. Visual only: physics never sees any of it.
const SEAM_M = 64, SEAM_ANG = Math.cos(THREE.MathUtils.degToRad(50));
function tubeShape(obj) {
  const t = obj.userData.tube || obj.userData.body; if (!t?.prof && !t?.sec) return null;
  let z0, z1, sec;
  if (t.sec) ({ z0, z1, sec } = t);
  else { // the widest the profile is at each z, over its whole length (a rounded end can bulge past its first point)
    const pr = t.prof, sx = t.sx ?? 1, sy = t.sy ?? 1, yo = t.yOff, N = 1024, tab = new Float32Array(N + 1);
    z0 = Math.min(...pr.map((q) => q[0])); z1 = Math.max(...pr.map((q) => q[0])); const span = z1 - z0 || 1;
    for (let k = 1; k < pr.length; k++) {
      const [za, ra] = pr[k - 1], [zb, rb] = pr[k], i0 = Math.ceil(((Math.min(za, zb) - z0) / span) * N - 1e-6), i1 = Math.floor(((Math.max(za, zb) - z0) / span) * N + 1e-6);
      for (let i = Math.max(0, i0); i <= Math.min(N, i1); i++) { const z = z0 + (span * i) / N, f = Math.abs(zb - za) < 1e-9 ? 1 : clamp((z - za) / (zb - za), 0, 1); tab[i] = Math.max(tab[i], Math.abs(zb - za) < 1e-9 ? Math.max(ra, rb) : ra + (rb - ra) * f); }
    }
    sec = (z) => { const u = clamp((z - z0) / span, 0, 1) * N, i = Math.min(N - 1, Math.floor(u)), r = tab[i] + (tab[i + 1] - tab[i]) * (u - i); return [yo ? yo(z) : 0, r * sx, r * sy]; };
  }
  const W = obj.matrixWorld, inv = W.clone().invert(), sc = axisScales(W), l = V(), sw = (sc[0] + sc[1]) / 2;
  const inside = (p) => { l.copy(p).applyMatrix4(inv); if (l.z < z0 || l.z > z1) return false; const [cy, rx, ry] = sec(l.z); return rx > 1e-6 && ry > 1e-6 && Math.hypot(l.x / rx, (l.y - cy) / ry) < 1; };
  const q = V();
  // distance along u from Q to where the skin is last crossed going out (0 if the ray never runs inside: Q past a
  // tilted end may be outside while the skin round it is not)
  const exit = (Q, u, far) => {
    let lo = -1, hi = 0, was = inside(Q);
    for (let k = 1; k <= 16; k++) { const s = (far * k) / 16, now = inside(q.copy(Q).addScaledVector(u, s)); if (was && !now) { lo = (far * (k - 1)) / 16; hi = s; } was = now; }
    if (was) return far; if (lo < 0) return 0;
    for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if (inside(q.copy(Q).addScaledVector(u, m))) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const rAt = (z) => { const [, rx, ry] = sec(clamp(z, z0, z1)); return ((rx + ry) / 2) * sw; };
  const radAt = (p) => rAt(l.copy(p).applyMatrix4(inv).z);
  const L = z1 - z0, ends = [];
  for (const [z, s] of [[z0, 1], [z1, -1]]) { // the end's width: just inside it (a rounded end is a few cm long)
    let r = 0; for (let k = 0; k <= 6; k++) r = Math.max(r, rAt(z + s * L * 0.03 * (k / 6)));
    if (r > 0.02) ends.push({ r, z, s, c: V(0, sec(z)[0], z).applyMatrix4(W), inward: V(0, 0, s).transformDirection(W).normalize() });
  }
  // how far in from an end the tube reaches 90 % of the width it has `depth` (world) in: in front of that it is
  // rounded off (a dome, a bulging nose disc)
  const shoulder = (e, depth) => {
    const Dl = depth / sc[2], full = 0.9 * rAt(e.z + e.s * Dl);
    for (let k = 0; k <= 60; k++) { const zz = e.z + e.s * Dl * (k / 60); if (rAt(zz) >= full) return { d: Dl * (k / 60) * sc[2], z: zz }; }
    return { d: 0, z: e.z };
  };
  const ecc = (p, zAt = null) => { l.copy(p).applyMatrix4(inv); const [cy, rx, ry] = sec(clamp(zAt ?? l.z, z0, z1)), x = l.x / Math.max(rx, 1e-5), y = (l.y - cy) / Math.max(ry, 1e-5); return rx < 1e-4 && ry < 1e-4 ? (Math.hypot(l.x, l.y - cy) < 1e-4 ? 0 : 99) : Math.hypot(x, y); };
  const axisAt = (p) => { l.copy(p).applyMatrix4(inv); const z = clamp(l.z, z0, z1); return { c: V(0, sec(z)[0], z).applyMatrix4(W), z }; };
  return { obj, inside, exit, radAt, ecc, shoulder, axisAt, ends, len: L * sc[2] };
}
// pairs of ends that meet: facing each other within 50 deg, centres in line, a small gap or an overlap
function findSeams(design, objs, valid) {
  const T = new Map(), out = [];
  design.parts.forEach((p, i) => { if (!valid(i)) return; objs[i].updateMatrixWorld(true); const s = tubeShape(objs[i]); if (s?.ends.length) T.set(i, s); });
  const used = new Set();
  for (const [i, A] of T) for (const [j, B] of T) {
    if (j <= i) continue;
    let best = null;
    for (const [ka, eA] of A.ends.entries()) for (const [kb, eB] of B.ends.entries()) {
      if (used.has(i + ':' + ka) || used.has(j + ':' + kb)) continue;
      const a = eA.inward.clone().negate(), b = eB.inward, rm = Math.max(eA.r, eB.r), rn = Math.min(eA.r, eB.r);
      if (a.dot(b) < SEAM_ANG || rn < 0.3 * rm) continue;
      const n = a.clone().add(b).normalize(), d = eB.c.clone().sub(eA.c), ax = d.dot(n), lat = d.addScaledVector(n, -ax).length();
      if (lat > 0.45 * rn + 0.02 || ax > 0.3 * rn + 0.03) continue; // off to the side, or too far apart
      const over = -ax, inA = A.inside(eB.c), inB = B.inside(eA.c);
      if (over > 0.3 * rn && !inA && !inB) continue;
      // the seam: halfway, or (when one runs into the other) at the end that stands proud
      let C = eA.c.clone().lerp(eB.c, 0.5);
      if (over > 0.02 * rm) C = (eA.r - B.radAt(eA.c) >= eB.r - A.radAt(eB.c) ? eA.c : eB.c).clone();
      const score = lat + Math.abs(ax);
      if (!best || score < best.score) best = { score, ka, kb, i, j, A, B, eA, eB, n, C };
    }
    // a tube plugged into the (tapering) end of another, along it: the seam is where the outer one has narrowed to the
    // inner one's width, and the rest of the outer one's end folds away inside
    if (!best) for (const [X, Y, xi, yi] of [[A, B, i, j], [B, A, j, i]]) for (const [kx, eX] of X.ends.entries()) for (const [ky, eY] of Y.ends.entries()) {
      if (best || used.has(xi + ':' + kx) || used.has(yi + ':' + ky)) continue;
      const a = eX.inward.clone().negate(), b = eY.inward; if (a.dot(b) < SEAM_ANG || !X.inside(eY.c)) continue;
      const d = eX.c.clone().sub(eY.c), along = d.dot(b), lat = d.addScaledVector(b, -along).length();
      if (along < 0 || lat > Math.max(0.6 * eY.r, 0.3 * eX.r) + 0.02) continue;
      const P = eY.c.clone(), step = Math.max(0.01, along / 60); let k = 0;
      for (; k < 80 && X.inside(P) && X.radAt(P) > Y.radAt(P); k++) P.addScaledVector(b, step);
      if (!X.inside(P) && k === 0) continue;
      const ax = X.axisAt(P), eX2 = { r: Y.radAt(P), c: ax.c, z: ax.z, s: eX.s, inward: eX.inward };
      const n = a.clone().add(b).normalize(), S = xi < yi ? { i: xi, j: yi, A: X, B: Y, eA: eX2, eB: eY } : { i: yi, j: xi, A: Y, B: X, eA: eY, eB: eX2 };
      if (xi > yi) n.negate(); // (n runs from A into B)
      best = { ...S, n, C: P.clone(), ka: xi < yi ? kx : ky, kb: xi < yi ? ky : kx };
    }
    if (best) { used.add(i + ':' + best.ka); used.add(j + ':' + best.kb); out.push(best); }
  }
  return out;
}
function hermite(p0, m0, p1, m1, D, u) { const u2 = u * u, u3 = u2 * u; return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * D * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * D * m1; }
function hermiteD(p0, m0, p1, m1, D, u) { const u2 = u * u; return ((6 * u2 - 6 * u) * p0 + (3 * u2 - 4 * u + 1) * D * m0 + (-6 * u2 + 6 * u) * p1 + (3 * u2 - 2 * u) * D * m1) / D; }
function fairSeam(S) {
  const { A, B, eA, eB, n, C } = S, M = SEAM_M;
  const u0 = Math.abs(n.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0), e1 = u0.addScaledVector(n, -u0.dot(n)).normalize(), e2 = n.clone().cross(e1);
  const L = 0.3 * (eA.r + eB.r) + 0.6 * Math.abs(eA.r - eB.r), rm = Math.max(eA.r, eB.r), far = 3 * rm + 0.6;
  const dirs = Array.from({ length: M }, (_, m) => { const f = (m / M) * Math.PI * 2; return e1.clone().multiplyScalar(Math.cos(f)).addScaledVector(e2, Math.sin(f)); });
  // per side (sg -1: A, before the seam; +1: B): its zone's depth, and its radius and slope where the zone starts
  const side = (X, e, sg, Lx) => {
    const h = 0.04 * Lx, Q = V(), R = (q, m) => X.exit(Q.copy(C).addScaledVector(n, sg * q), dirs[m], far);
    const p = [], sl = [];
    for (let m = 0; m < M; m++) { p.push(R(Lx, m)); sl.push((R(Lx + h, m) - R(Lx - h, m)) / (2 * h)); }
    const sh = X.shoulder(e, Lx); return { X, sg, Lx, p, sl, a: e.inward.clone().negate(), ce: e.c, dS: Math.min(sh.d, 0.6 * Lx), zS: sh.z };
  };
  // the fair curve per angle: a cubic from A's radius and slope (t = -LA) to B's (t = +LB). Where that would dip below
  // both (one part still tapering hard towards the seam: a pointed nose against a wide body), the zone on the steep side
  // grows (up to a third of the part) until it does not; failing that, the slopes are eased off.
  const dips = (S1, S2) => { const D = S1.Lx + S2.Lx; let bad = 0; for (let m = 0; m < M; m++) { const lo = Math.min(S1.p[m], S2.p[m]) - 0.002 * rm; for (let k = 1; k < 16; k++) if (hermite(S1.p[m], -S1.sl[m], S2.p[m], S2.sl[m], D, k / 16) < lo) { bad++; break; } } return bad; };
  const LA0 = Math.min(L, 0.35 * A.len), LB0 = Math.min(L, 0.35 * B.len);
  let SA = side(A, eA, -1, LA0), SB = side(B, eB, 1, LB0);
  for (let it = 1; it <= 4 && dips(SA, SB); it++) {
    const LA = Math.min(LA0 * 1.5 ** it, 0.35 * A.len), LB = Math.min(LB0 * 1.5 ** it, 0.35 * B.len);
    const steepA = SA.sl.reduce((x, y) => x + Math.abs(y), 0) >= SB.sl.reduce((x, y) => x + Math.abs(y), 0);
    if (steepA && LA > SA.Lx) SA = side(A, eA, -1, LA); else if (LB > SB.Lx) SB = side(B, eB, 1, LB); else if (LA > SA.Lx) SA = side(A, eA, -1, LA); else break;
  }
  const D = SA.Lx + SB.Lx, P0 = SA.p, P1 = SB.p, M0 = SA.sl.map((x) => -x), M1 = SB.sl.slice();
  for (let m = 0; m < M; m++) {
    const lo = Math.min(P0[m], P1[m]) - 0.002 * rm;
    for (let it = 0; it < 6; it++) {
      let ok = true; for (let k = 1; k < 16; k++) if (hermite(P0[m], M0[m], P1[m], M1[m], D, k / 16) < lo) { ok = false; break; }
      if (ok) break; const f = it < 5 ? 0.7 : 0; M0[m] *= f; M1[m] *= f;
    }
  }
  const lerpM = (arr, f) => { const x = (((f / (Math.PI * 2)) % 1) + 1) % 1 * M, m = Math.floor(x) % M, w = x - Math.floor(x); return arr[m] * (1 - w) + arr[(m + 1) % M] * w; };
  const fairAt = (t, f) => hermite(lerpM(P0, f), lerpM(M0, f), lerpM(P1, f), lerpM(M1, f), D, clamp((t + SA.Lx) / D, 0, 1));
  const ur = V(), uf = V(), dF = V(), dT = V();
  const fairN = (t, f, out) => {
    const r = fairAt(t, f), rt = hermiteD(lerpM(P0, f), lerpM(M0, f), lerpM(P1, f), lerpM(M1, f), D, clamp((t + SA.Lx) / D, 0, 1)), df = 0.02, rf = (fairAt(t, f + df) - fairAt(t, f - df)) / (2 * df);
    const c = Math.cos(f), s = Math.sin(f); ur.copy(e1).multiplyScalar(c).addScaledVector(e2, s); uf.copy(e1).multiplyScalar(-s).addScaledVector(e2, c);
    dF.copy(uf).multiplyScalar(r).addScaledVector(ur, rf); dT.copy(n).addScaledVector(ur, rt);
    return out.crossVectors(dF, dT).normalize();
  };
  const p = V(), w = V(), nv = V(), done = new Map(), bin = (f) => ((Math.round((f / (Math.PI * 2)) * M) % M) + M) % M;
  for (const sd of [SA, SB]) {
    const { X, sg, Lx, a, ce, dS, zS } = sd, an = a.dot(n), list = [];
    X.obj.traverse((m) => {
      if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || m.userData.keepShape || !m.geometry?.attributes.position) return; // (a frame or flange ring that stands proud on purpose keeps its shape)
      m.updateMatrixWorld(true);
      const W = m.matrixWorld, pos = m.geometry.attributes.position;
      // a geometry shared with another mesh (the heli cabin's inside, a cached piece) is mapped once per placement
      const prev = done.get(m.geometry); if (prev && prev.equals(W)) return;
      let hit = false; for (let i = 0; i < pos.count && !hit; i++) if (sg * p.fromBufferAttribute(pos, i).applyMatrix4(W).sub(C).dot(n) <= Lx) hit = true;
      if (!hit) return;
      if (prev) m.geometry = m.geometry.clone(); done.set(m.geometry, W.clone()); list.push(m);
    });
    // mitre: slide along the part's own axis so that, from where its end has rounded off to full width (its shoulder),
    // it lands on the seam plane (tilted ends, gaps, overlaps), fading out over the zone. The rounded-off end in front
    // of the shoulder, and whatever sticks out past it, folds flat onto the seam plane as the cap, its outermost ring
    // stretched out to the fair surface (per angle: the widest folded point there).
    const fold = (pp) => { const ds = ce.clone().sub(pp).dot(a) - dS; if (ds > 0) { if (ds < Lx - dS) pp.addScaledVector(a, (-_g.copy(pp).addScaledVector(a, ds).sub(C).dot(n) / an) * (1 - ds / (Lx - dS))); return false; } pp.addScaledVector(a, -_g.copy(pp).sub(C).dot(n) / an); return true; };
    const rim = new Float32Array(M);
    for (const m of list) {
      if (m.userData.decal) continue; const P = m.geometry.attributes.position, W = m.matrixWorld;
      for (let i = 0; i < P.count; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(W); const e = X.ecc(p, zS); if (!(e < 1.5) || sg * p.clone().sub(C).dot(n) > Lx || !fold(p)) continue;
        w.copy(p).sub(C).addScaledVector(n, -p.clone().sub(C).dot(n)); const k = bin(Math.atan2(w.dot(e2), w.dot(e1))); rim[k] = Math.max(rim[k], e);
      }
    }
    for (const m of list) {
      const W = m.matrixWorld, inv = W.clone().invert(), nm = new THREE.Matrix3().getNormalMatrix(W), WT = new THREE.Matrix3().setFromMatrix4(W).transpose();
      const P = m.geometry.attributes.position, N = m.geometry.attributes.normal, decal = m.userData.decal;
      for (let i = 0; i < P.count; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(W);
        const q = sg * p.clone().sub(C).dot(n), d = ce.clone().sub(p).dot(a); if (q > Lx && d > Lx) continue;
        // where the point is in its own tube's section: 1 on the skin, less inside, more outside
        let e = X.ecc(p); if (!(e < 3)) continue;
        const eS = X.ecc(p, zS), folded = fold(p);
        const t0 = p.clone().sub(C).dot(n), t2 = sg * Math.max(0, sg * t0); w.copy(p).sub(C).addScaledVector(n, -t0);
        const r = w.length(), f = Math.atan2(w.dot(e2), w.dot(e1));
        if (folded) e = Math.min(1, eS / Math.max(1e-3, rim[bin(f)]));
        // the skin and what hugs it (a chin shell; the skin where the profile table is only near it) flow onto the fair
        // surface at the seam; decals keep their few mm
        const outward = N ? nv.fromBufferAttribute(N, i).applyMatrix3(nm).normalize().dot(w) / Math.max(r, 1e-9) : 1;
        const skin = Math.abs(e - 1) < (outward > 0.3 ? 0.1 : 0.03) && sg * t2 <= Lx; if (skin && !decal) e = 1 + (e - 1) * smooth01(clamp(sg * t2 / Lx, 0, 1));
        p.copy(C).addScaledVector(n, t2); if (r > 1e-6) p.addScaledVector(w, sg * t2 > Lx ? 1 : (e * fairAt(t2, f)) / r); // (past the zone: only the mitre's tail)
        if (N && skin && r > 1e-6) { // the fair surface's normal (on the end ring it had been bent along the axis by the cap)
          nv.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); const out = nv.dot(w) / r;
          if (out > (sg * t2 < 0.15 * Lx ? -0.5 : 0.3) || (Math.abs(d - dS) < 0.06 * Lx && out > -0.2)) { fairN(t2, f, nv).applyMatrix3(WT).normalize(); N.setXYZ(i, nv.x, nv.y, nv.z); }
        }
        p.applyMatrix4(inv); P.setXYZ(i, p.x, p.y, p.z);
      }
      P.needsUpdate = true; if (N) N.needsUpdate = true; m.geometry.computeBoundingSphere(); m.geometry.computeBoundingBox();
    }
  }
}
const smooth01 = (x) => x * x * (3 - 2 * x);
// ---------- entry point ----------
// Reshapes every body that carries something, seats its canopies. Returns the set of cockpit part indices it seated
// (planeDetail skips its own canopy skirt for those). opts.pods: POD table (radius/length of engine and store pods),
// opts.addTo: planeDetail's world-geometry -> part mesh helper, opts.quick: coarser while a slider is dragged.
export const TM = { reshape: 0, seat: 0, seam: 0 };
export function blendSkins(design, objs, { pods, addTo, quick = false, rivets = null }) {
  const parts = design.parts, seated = new Set(), valid = (i) => i >= 0 && objs[i] && PARTS[parts[i]?.id];
  const bf = new Map();
  parts.forEach((p, i) => { if (valid(i) && objs[i].userData.body?.skin) { objs[i].updateMatrixWorld(true); bf.set(i, bodyField(objs[i])); } });
  let seams = []; try { seams = findSeams(design, objs, valid); } catch (e) { console.warn('skinBlend seams', e); }
  const faired = new Set(seams.map((S) => S.i + ':' + S.j));
  for (const [i, B] of bf) {
    const fields = [], cks = [];
    parts.forEach((q, j) => {
      if (j === i || !valid(j)) return;
      const d = PARTS[q.id], o = objs[j];
      try {
        if (bf.has(j) && !faired.has(Math.min(i, j) + ':' + Math.max(i, j))) { // (tubes end to end: fairSeam below)
          const Cb = bf.get(j), k = clamp(0.45 * Math.min(B.rW, Cb.rW), 0.05, 1.0);
          if (boxNear(B.box, Cb.box, k)) fields.push({ ...Cb, box: Cb.box.clone().expandByScalar(k), k, reach: k * 0.9, stop: 'bis' });
        } else if (bf.has(j)) { /* faired below */
        } else if (pods[q.id] && !d.wing) {
          const F = podField(o, pods[q.id], q.id); F.k = clamp(0.4 * F.rW, 0.05, 0.4); F.reach = F.k; // thicker than the reach: skin that runs into it just ends up hidden inside
          if (boxNear(B.box, F.box, F.k)) { F.box.expandByScalar(F.k); fields.push(F); }
        } else if (CK[q.id] && q.parent === i) {
          const ck = cockpitSetup(q, o, B); if (ck) { fields.push(ck.ped); cks.push(ck); }
        } else if (d.wing && (q.parent === i || parts[i].parent === j)) {
          // a body passing through a wing away from its root (twin booms, pods on a wing): the skin swells into it
          const F = wingField(o, q.id), c = V().setFromMatrixPosition(B.W).applyMatrix4(F.inv), t = (F.fin ? c.y : c.x) / F.L;
          if (t > 0.08 && t < 0.92) { F.k = clamp(0.5 * B.rW, 0.05, 0.5); F.reach = F.k * 1.2; F.stop = 'in'; F.box.expandByScalar(F.k); if (boxNear(B.box, F.box, 0)) fields.push(F); }
        } else if (d.gear?.retract && q.parent === i) {
          // a retracting leg whose strut top sits at or outside this body's skin, with no wing over it: grow a sponson
          const O = V().setFromMatrixPosition(o.matrixWorld), out = B.f(O);
          const underWing = parts.some((w, k) => PARTS[w.id]?.wing && objs[k] && wingField(objs[k], w.id).f(O) < 0.6);
          if (out > -0.08 && !underWing) {
            const sl = Math.cbrt(Math.abs(o.matrixWorld.determinant())), r = clamp(d.gear.r * 0.85 * sl, 0.15, 0.7) + Math.max(0, out) * 0.5, hl = (d.gear.r * 2.4 + 0.4) * sl;
            const axis = V(0, 0, 1).transformDirection(B.W).normalize(), C = O.clone().add(V(0, 0.06 * sl, 0).transformDirection(o.matrixWorld).multiplyScalar(0.06 * sl));
            const F = sponsonField(C, axis, r, hl); F.obj = o; F.k = clamp(0.5 * r, 0.08, 0.4); F.reach = r * 2 + Math.max(0, out) + F.k; F.box.expandByScalar(F.k); fields.push(F);
          }
        } else if (MAST[q.id] && q.parent === i) {
          const inv = o.matrixWorld.clone().invert(), A = axisPoint(B, V().setFromMatrixPosition(o.matrixWorld)).applyMatrix4(inv);
          if (A.y < 0) { const F = coneField(o, A.y, 0.26, MAST[q.id] * 0.12, 0.15); F.k = 0.2; F.reach = MAST[q.id] * 0.12 - A.y + 0.2; F.box.expandByScalar(F.k); fields.push(F); } // the skin itself becomes the mast fairing
        }
      } catch (e) { console.warn('skinBlend field', q.id, e); }
    });
    // a seam at one of its ends: rings close enough together there for the fair surface (fairSeam) to be followed
    for (const S of seams) if (S.i === i || S.j === i) { const r = 0.6 * (S.eA.r + S.eB.r) + 1.2 * Math.abs(S.eA.r - S.eB.r) + 0.1; fields.push({ kind: 'seam', f: () => 1e9, k: 0.01, reach: 0, h: clamp(0.08 * Math.min(S.eA.r, S.eB.r), 0.025, 0.16), box: new THREE.Box3().setFromCenterAndSize(S.C, V(1, 1, 1).multiplyScalar(2 * r)) }); }
    if (!fields.length) continue;
    try {
      const t0 = performance.now(), U = reshape(B, fields, cks, quick); TM.reshape += performance.now() - t0; const t1 = performance.now();
      for (const ck of cks) if (seatCanopy(ck, U, parts[i].color, addTo, quick ? null : rivets)) seated.add(parts.indexOf(ck.cp)); TM.seat += performance.now() - t1;
    } catch (e) { console.warn('skinBlend body', parts[i].id, e); }
  }
  for (const S of seams) for (const [X, e] of [[S.A, S.eA], [S.B, S.eB]]) { // a part faired onto a body's front covers its own nose (planeDetail's rule)
    const nc = X.obj.userData.noseCap; if (nc && e.s === 1 && nc.obj.parent === X.obj) { X.obj.remove(nc.obj); nc.obj.traverse((m) => m.geometry?.dispose()); X.obj.userData.seats = null; }
  }
  for (const S of seams) try { const t0 = performance.now(); fairSeam(S); TM.seam += performance.now() - t0; } catch (e) { console.warn('skinBlend seam', parts[S.i].id, parts[S.j].id, e); }
  return seated;
}
