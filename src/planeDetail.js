// Assembly pass: makes a set of parts look like one built aircraft. Runs over an assembled design (parts already built
// and placed) and adds, per part-to-part contact found through the parent links:
//   - wing / tail root fillets blending into the body,
//   - pylons under (or beside) engines, tanks and boosters that hang off a wing or body,
//   - canopy sills/skirts seating cockpits into the fuselage,
//   - wheel wells with hinged doors for retracting gear, boot fairings where fixed legs enter the skin,
// plus skin furniture (antennas, beacons, static ports, pitot tubes, walkways, fuel caps, worn leading edges, exhaust soot).
// Everything is built in world space from the placed parts (so it stays the right size after resizing and mirroring),
// then baked into the local space of the part it rides on (it breaks off with that part). All of it is cosmetic: physics
// reads partInfo(), which never sees any of this.
// Also here: the per-frame visual hook (doors, slats, spoilers, gear forks) and the hangar's control-surface preview.
import * as THREE from 'three';
import { PARTS, partInfo, airfoil } from './parts.js';
import { partMatrix, partScale, scaleSurface, linScale } from './design.js';
import { M } from './materials.js';
import { PM, lightGeometry } from './planeMaterials.js';
import { V, bar, tube, pipe, norm, ringLoft, Bag, kitMaterial, kitSlot, kitUV, EXHAUST_ROUTES, exhaustPipes, navColour, shell, clipGeometry, OPEN_WELL } from './partDetail.js';
import { clamp, lerp } from './noise.js';
import { applyLivery } from './liveries.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { blendSkins, addTubObstacle } from './skinBlend.js';
import { addCrew } from './crew.js';
import { routeGear, routeStruts } from './gearRoute.js';
import { assembleCar } from './carDetail.js';
import { fitOut } from './fitOut.js';
import { keepOut } from './interior.js';
import { bikeSync, wireRiders, riderInput } from './bikeParts.js';
import { TANDEM_SHAPE, TANDEM_VOL, RAMJET } from './supersonicParts.js';

const BODY = new Set(['fuselage', 'cockpit']), BODY_X = new Set(['x_nosecone', 'x_tailcone']);
const isBody = (id) => BODY.has(PARTS[id].cat) || BODY_X.has(id);
const POD = { // engine / store pods: radius and length along local z (front, back) for pylons; exhaust exits for soot
  e_piston: { r: 0.5, z0: 0, z1: 1.1, ex: [[0.23, -0.51, 0.84]], soot: 1.6 },
  e_radial: { r: 0.75, z0: 0, z1: 1.6, ex: [[0.555, -0.45, 1.9]], soot: 2.4 },
  e_turboprop: { r: 0.55, z0: 0, z1: 2.6, ex: [[0.616, 0.033, 1.46]], soot: 2.6 },
  e_electric: { r: 0.47, z0: -0.3, z1: 0.5 },
  e_jet_small: { r: 0.38, z0: 0, z1: 2.2 }, e_jet_ab: { r: 0.55, z0: 0, z1: 4.2 }, e_turbofan: { r: 1.17, z0: 0, z1: 4.0 },
  e_rocket: { r: 0.32, z0: 0, z1: 3.2 }, e_ramjet: { r: RAMJET.R, z0: 0, z1: RAMJET.L }, x_tank: { r: 0.3, z0: -1.3, z1: 1.5 }, x_smoke: { r: 0.1, z0: -0.5, z1: 0.5 },
};
const rc = new THREE.Raycaster();
const _m3 = new THREE.Matrix3();

// ---------- helpers ----------
function solidMeshes(obj) {
  const out = [], skip = new Set();
  for (const k of ['prop', 'fan', 'flame', 'flameCore']) if (obj.userData[k]) obj.userData[k].traverse((o) => skip.add(o));
  obj.traverse((m) => {
    if (!m.isMesh || skip.has(m) || m.userData.cosmetic || m.userData.isDisc || m.userData.joint || m.userData.near) return;
    if (m.material.transparent || m.material.blending === THREE.AdditiveBlending) return;
    out.push(m);
  });
  return out;
}
// Ray cast against meshes (nearest hit within far; front faces only unless double-sided). The assembly pass fires a
// few thousand rays per plane, so each geometry gets a one-level box hierarchy (chunks of 48 consecutive triangles,
// which revolve()/loft() lay out in compact strips) instead of three's test-every-triangle Mesh.raycast.
const _u0 = new THREE.Vector2(), _u1 = new THREE.Vector2(), _u2 = new THREE.Vector2();
const accel = new WeakMap(), _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _a = V(), _b = V(), _c = V(), _hit = V(), _sph = new THREE.Sphere();
function chunks(g) {
  let ch = accel.get(g); if (ch) return ch;
  const pos = g.attributes.position, idx = g.index, n = (idx ? idx.count : pos.count) / 3, v = V(); ch = [];
  for (let t0 = 0; t0 < n; t0 += 48) {
    const t1 = Math.min(n, t0 + 48), box = new THREE.Box3();
    for (let t = t0 * 3; t < t1 * 3; t++) box.expandByPoint(v.fromBufferAttribute(pos, idx ? idx.getX(t) : t));
    ch.push({ t0, t1, box });
  }
  accel.set(g, ch); return ch;
}
function cast(meshes, from, dir, far = Infinity, both = false) {
  rc.set(from, dir);
  let best = null, bestD = far;
  for (const m of meshes) {
    const g = m.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
    _sph.copy(g.boundingSphere).applyMatrix4(m.matrixWorld);
    if (!rc.ray.intersectsSphere(_sph) || rc.ray.distanceToPoint(_sph.center) > _sph.radius) continue;
    _inv.copy(m.matrixWorld).invert(); _ray.copy(rc.ray).applyMatrix4(_inv);
    const pos = g.attributes.position, idx = g.index, cull = !both && m.material.side === THREE.FrontSide;
    for (const c of chunks(g)) {
      if (!_ray.intersectsBox(c.box)) continue;
      for (let t = c.t0; t < c.t1; t++) {
        const i = t * 3;
        _a.fromBufferAttribute(pos, idx ? idx.getX(i) : i); _b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1); _c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
        if (!_ray.intersectTriangle(_a, _b, _c, cull, _hit)) continue;
        const wp = _hit.clone().applyMatrix4(m.matrixWorld), d = wp.distanceTo(from);
        if (d < bestD) {
          bestD = d; const n = _b.clone().sub(_a).cross(_c.clone().sub(_a)).applyMatrix3(_m3.getNormalMatrix(m.matrixWorld)).normalize(); best = { p: wp, n, d, m };
          const u1 = g.attributes.uv1; // panel-skin uv of the hit, so joints can carry the panel lines on
          if (u1) { const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2; best.uv1 = THREE.Triangle.getInterpolation(_hit, _a, _b, _c, _u0.fromBufferAttribute(u1, i0), _u1.fromBufferAttribute(u1, i1), _u2.fromBufferAttribute(u1, i2), new THREE.Vector2()); }
        }
      }
    }
  }
  return best;
}
// world-space geometry -> local space of obj (flipping the winding back for mirrored parts)
function toLocal(geo, obj) {
  const inv = obj.matrixWorld.clone().invert();
  geo.applyMatrix4(inv);
  if (inv.determinant() < 0) {
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); }
    else { const p = geo.attributes.position; for (const k of Object.keys(geo.attributes)) { const a = geo.attributes[k], n = a.itemSize; for (let t = 0; t < p.count; t += 3) for (let c = 0; c < n; c++) { const x = a.array[(t + 1) * n + c]; a.array[(t + 1) * n + c] = a.array[(t + 2) * n + c]; a.array[(t + 2) * n + c] = x; } } }
  }
  return geo;
}
function addTo(obj, geo, mat, { near = false, shadow = true } = {}) {
  const m = new THREE.Mesh(norm(toLocal(geo, obj)), mat);
  m.userData.joint = true; m.userData.cosmetic = true; m.castShadow = shadow && !near && !mat.transparent; m.receiveShadow = true;
  if (near) m.userData.near = true;
  obj.add(m); return m;
}
// Grid surface (rows x cols of world points) with optional uv; normals oriented towards `out` (a world direction or fn)
function gridGeo(P, { uv = null, uv1 = null, out = null, closedCols = false } = {}) {
  const R = P.length, C = P[0].length, pos = [], uvs = [], uv1s = [], idx = [];
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { pos.push(P[i][j].x, P[i][j].y, P[i][j].z); uvs.push(...(uv ? uv(i, j) : [0, 0])); if (uv1) uv1s.push(...uv1(i, j)); }
  const CC = closedCols ? C : C - 1;
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < CC; j++) { const a = i * C + j, b = i * C + ((j + 1) % C), c = (i + 1) * C + ((j + 1) % C), d = (i + 1) * C + j; idx.push(a, b, c, a, c, d); }
  if (out) { // orient: compare a middle triangle's normal with the outward hint
    const i = Math.floor((R - 1) / 2), j = Math.floor((C - 1) / 2), a = P[i][j], b = P[i][(j + 1) % C], c = P[i + 1][(j + 1) % C];
    const n = b.clone().sub(a).cross(c.clone().sub(a)), o = typeof out === 'function' ? out(i, j) : out;
    if (n.dot(o) < 0) for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1s, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const smooth = (t) => t * t * (3 - 2 * t);

// Wing / tail planform in world space (mirrors parts.js buildWing + fin rotation).
function wingFrame(p, obj) {
  const d = PARTS[p.id], o = d.wing, fin = d.attach === 'fin';
  const dih = fin ? 0 : THREE.MathUtils.degToRad(o.dihedral || 0), K = o.planform === 'ellipse' ? 10 : 4;
  const chordAt = (s) => o.planform === 'ellipse' ? Math.max(o.tip, o.root * Math.sqrt(Math.max(0, 1 - s * s))) : o.root + (o.tip - o.root) * s;
  const leAt = (s) => o.planform === 'ellipse' ? -o.root / 2 + (o.root - chordAt(s)) * 0.25 + o.sweep * s : -o.root / 2 + o.sweep * s;
  const th = o.thick ?? 0.12, cam = fin ? 0 : (o.camber ?? 0.02), hinge = o.hinge ?? 0.72, { up, lo } = airfoil(40, th, cam);
  const yAt = (arr, x) => { for (let i = 1; i < arr.length; i++) if (arr[i][0] >= x) { const a = arr[i - 1], b = arr[i]; return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0] || 1)); } return arr.at(-1)[1]; };
  const W = obj.matrixWorld;
  // s: span fraction, x: chord fraction, side: +1 upper, -1 lower, 0 camber line; lift: metres off the surface (local units)
  const local = (s, x, side = 0, lift = 0) => {
    const c = chordAt(s), y = side > 0 ? yAt(up, x) : side < 0 ? yAt(lo, x) : cam * 4 * x * (1 - x);
    const v = V(s * o.span * Math.cos(dih), s * o.span * Math.sin(dih) + y * c + lift * Math.sign(side || 1), leAt(s) + x * c);
    return fin ? V(-v.y, v.x, v.z) : v;
  };
  const pt = (s, x, side = 0, lift = 0) => local(s, x, side, lift).applyMatrix4(W);
  return { o, d, fin, K, hinge, th, cam, chordAt, pt, local, W };
}

// ---------- fillets ----------
// Where a wing's root (or tip) section dives into a body: march each chordwise station of the end section along the
// (straight) wing skin towards the body, find where it pierces the skin, and sweep a concave quarter-round from the
// wing skin to the body skin around that line. Radius grows towards the trailing edge, fades out at the ends.
function fillet(wp, wobj, bp, bobj, paintOf) {
  const F = wingFrame(wp, wobj), body = solidMeshes(bobj), made = [];
  if (!body.length) return made;
  for (const end of [0, 1]) {
    const sE = end, sN = end ? 1 - 1 / F.K : 1 / F.K;
    const chordW = F.pt(sE, 0).distanceTo(F.pt(sE, 1)), R0 = clamp(chordW * 0.075, 0.035, 0.5);
    const N = 18, st = [];
    for (let k = 0; k <= 2 * N; k++) { // upper surface hinge -> LE, then lower LE -> hinge
      const t = k <= N ? 1 - k / N : (k - N) / N, x = F.hinge * 0.985 * (0.5 - 0.5 * Math.cos(Math.PI * t)), side = k <= N ? 1 : -1;
      if (k === N) { st.push({ x: 0, side: 0 }); continue; }
      st.push({ x, side });
    }
    const hits = st.map(({ x, side }) => {
      const P0 = F.pt(sE, x, side), P1 = F.pt(sN, x, side), L = P0.distanceTo(P1), dir = P0.clone().sub(P1).normalize();
      const h = cast(body, P1, dir, L * 1.05); if (!h || h.d < 0.02) return null;
      const out = dir.clone().negate();
      // wing skin normal at this station
      const dx = 0.01, Ta = F.pt(sE, Math.max(0, x - dx), side || -1), Tb = F.pt(sE, Math.min(1, x + dx), side || 1);
      let nw = out.clone().cross(Tb.clone().sub(Ta)).normalize();
      const mid = F.pt(sE, Math.max(0.001, x), 0); if (nw.dot(P0.clone().sub(mid)) < 0 && side) nw.negate();
      if (!side) nw = F.pt(sE, 0, 0).sub(F.pt(sE, 0.05, 0)).normalize(); // leading edge: straight ahead
      const t = nw.clone().addScaledVector(h.n, -nw.dot(h.n));
      if (t.lengthSq() < 1e-4) return null;
      return { I: h.p.clone(), N: h.n, out, t: t.normalize(), nw, x, room: h.d, uv1: h.uv1 };
    });
    // contiguous runs of hits
    const runs = []; let cur = [];
    hits.forEach((h, k) => { if (h) cur.push(k); else { if (cur.length) runs.push(cur); cur = []; } });
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (run.length < 4) continue;
      const J = 7, rows = [], uvRows = [];
      run.forEach((k, ri) => {
        const h = hits[k], fade = smooth(clamp(Math.min(ri, run.length - 1 - ri) / 2.5, 0, 1));
        const R = Math.min(h.room * 0.8, R0 * (0.75 + 0.9 * h.x / F.hinge)) * (0.15 + 0.85 * fade);
        const A = h.I.clone().addScaledVector(h.out, R);
        const g = h.I.clone().addScaledVector(h.t, R), hb = cast(body, g.clone().addScaledVector(h.N, R * 1.5 + 0.05), h.N.clone().negate(), R * 3 + 0.1);
        const B = hb ? hb.p : g; uvRows.push(hb?.uv1 || h.uv1 || null);
        const row = [];
        for (let j = 0; j <= J; j++) { const u = j / J; row.push(A.clone().multiplyScalar((1 - u) ** 2).addScaledVector(h.I, 2 * u * (1 - u)).addScaledVector(B, u * u)); }
        rows.push(row);
      });
      const mid = hits[run[Math.floor(run.length / 2)]];
      const haveUv = uvRows.every(Boolean), geo = gridGeo(rows, { out: mid.nw.clone().add(mid.N), uv1: haveUv ? (i) => [uvRows[i].x, uvRows[i].y] : null });
      const m = addTo(bobj, geo, PM.skin(paintOf(bp))); made.push(m);
      m.userData.edge = { pts: rows.map((r) => r[J]), n: mid.N.clone() }; // the body-side seam (rivets)
    }
  }
  return made;
}

// ---------- pylons ----------
function pylon(pp, pobj, qp, qobj) {
  const P = POD[pp.id]; if (!P) return null;
  const W = pobj.matrixWorld, r = P.r * Math.cbrt(Math.abs(W.determinant()));
  const target = solidMeshes(qobj); if (!target.length) return null;
  const a0 = V(0, 0, P.z0).applyMatrix4(W), a1 = V(0, 0, P.z1).applyMatrix4(W), axis = a1.clone().sub(a0), len = axis.length(); axis.normalize();
  const mid = a0.clone().lerp(a1, 0.5);
  // pick the side facing the parent: shortest of 12 rays round the axis
  const ref = Math.abs(axis.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0), e1 = ref.clone().addScaledVector(axis, -ref.dot(axis)).normalize(), e2 = axis.clone().cross(e1);
  let best = null;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, dir = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
    for (const f of [0.35, 0.5, 0.65]) { const h = cast(target, a0.clone().lerp(a1, f), dir, r + 4); if (h && (!best || h.d < best.d)) best = { d: h.d, dir }; }
  }
  if (!best || best.d < r * 0.97 || best.d > r + 3.5) return null;
  const u = best.dir, w = u.clone().cross(axis).normalize();
  // stations along the pod: where the ray towards the parent hits
  const NS = 14, tops = [];
  for (let i = 0; i <= NS; i++) {
    const f = 0.08 + 0.84 * (i / NS), c = a0.clone().lerp(a1, f), h = cast(target, c, u, r + 4);
    tops.push(h && h.d > r * 0.9 ? { f, c, top: h.p.clone().addScaledVector(u, Math.min(0.08, r * 0.15)) } : null);
  }
  // longest contiguous run
  let run = [], cur = [];
  tops.forEach((t, i) => { if (t) cur.push(i); else { if (cur.length > run.length) run = cur; cur = []; } }); if (cur.length > run.length) run = cur;
  if (run.length < 3) return null;
  const st = run.map((i) => tops[i]), thick = clamp(r * 0.32, 0.035, 0.32);
  // the pylon runs forward along the pod top ahead of the parent (a swept leading edge) and tapers off behind it
  const fA = st[0].f, fB = st.at(-1).f, fF = Math.min(fA, Math.max(0.12, fA - 0.4)), fK = Math.max(fB, Math.min(0.97, fB + 0.06));
  const hAt = (f) => { // height of the pylon top above the axis
    const H = (k) => st[k].top.clone().sub(st[k].c).dot(u);
    if (f <= fA) return lerp(r, H(0), fA > fF ? smooth((f - fF) / (fA - fF)) : 1);
    if (f >= fB) return lerp(H(st.length - 1), r, fK > fB ? smooth((f - fB) / (fK - fB)) : 0);
    let k = 0; while (k < st.length - 2 && st[k + 1].f < f) k++;
    return lerp(H(k), H(k + 1), (f - st[k].f) / (st[k + 1].f - st[k].f || 1));
  };
  // pylon wall: chord along the pod axis, from the pod skin (slightly sunk) to just inside the parent skin
  const C = 16, rows = [];
  for (const side of [1, -1]) {
    const row = [];
    for (let j = 0; j <= C; j++) {
      const x = j / C, f = fF + (fK - fF) * x, c = a0.clone().lerp(a1, f), ht = Math.max(r * 0.9, hAt(f));
      const half = thick * 0.5 * Math.min(1, 2.6 * Math.sqrt(x) * (1 - x)) * side;
      row.push([c.clone().addScaledVector(u, r * 0.88).addScaledVector(w, half), c.clone().addScaledVector(u, ht).addScaledVector(w, half)]);
    }
    rows.push(row);
  }
  // as a grid: rows = [bottom-right..., top-right..., top-left..., bottom-left] around, cols = chord stations
  const ring = (j) => [rows[0][j][0], rows[0][j][1], rows[1][j][1], rows[1][j][0]];
  const P2 = [0, 1, 2, 3].map((k) => Array.from({ length: C + 1 }, (_, j) => ring(j)[k]));
  P2.push(P2[0].map((p) => p.clone()));
  const geo = gridGeo(P2, { out: (i) => (i < 2 ? w : w.clone().negate()) });
  const mesh = addTo(qobj, geo, PM.skin(qp.color)), top = st.reduce((a, t) => a.add(t.top), V()).multiplyScalar(1 / st.length);
  return { mesh, pp, pobj, qp, qobj, r, u, w, axis, a0, a1, len, top, thick };
}

// ---------- nacelles and engine beams ----------
// Prop engines hung under (or on) a wing get an aft nacelle: it carries on behind the cowl, shrinking and rising until it
// runs into the wing's lower skin, so the engine looks installed rather than clipped on.
const PROP_NACELLE = { e_piston: 0.92, e_radial: 0.7, e_turboprop: 0.92 };
function nacelle(pl) {
  const k = PROP_NACELLE[pl.pp.id]; if (!k) return;
  const target = solidMeshes(pl.qobj), { r, u, axis, a1 } = pl, rs = r * k, H = [], NS = 14;
  // how far behind the cowl the wing goes, and its height above the axis there
  let L = 0;
  for (let i = 1; i <= 24; i++) { const t = (i / 24) * r * 6, h = cast(target, a1.clone().addScaledVector(axis, t), u, r * 4); if (!h) break; L = t; H.push([t, h.d]); }
  if (L < r * 0.8) return;
  L += r * 0.4;
  const hAt = (t) => { let b = H[0]; for (const q of H) if (q[0] <= t) b = q; return b[1]; };
  const w = u.clone().cross(axis).normalize(), rings = [];
  for (let i = 0; i <= NS; i++) {
    const f = i / NS, t = f * L, rho = rs * (1 - 0.9 * smooth(f) ** 1.3) + 0.01, rise = Math.max(0, hAt(Math.min(t, L - r * 0.4)) + 0.04 - rho) * smooth(Math.min(1, f * 1.6));
    const c = a1.clone().addScaledVector(axis, t - 0.02).addScaledVector(u, rise), ring = [];
    for (let j = 0; j < 20; j++) { const a = (j / 20) * Math.PI * 2; ring.push(c.clone().addScaledVector(u, Math.cos(a) * rho).addScaledVector(w, Math.sin(a) * rho * 1.04)); }
    rings.push(ring);
  }
  addTo(pl.pobj, ringLoft(rings, false, true), PM.skin(pl.pp.color));
}
// Three or more pods in a row under one wing: a continuous streamlined beam under the skin carries all their pylons.
function engineBeams(list, ctx) {
  if (list.length < 3) return;
  const span = list.at(-1).top.clone().sub(list[0].top); if (span.lengthSq() < 1e-6) return; span.normalize();
  list.sort((a, b) => a.top.dot(span) - b.top.dot(span));
  const runs = []; let cur = [list[0]];
  for (let i = 1; i < list.length; i++) { const gap = list[i].top.distanceTo(list[i - 1].top); if (gap < 5.5 * Math.max(list[i].r, list[i - 1].r)) cur.push(list[i]); else { runs.push(cur); cur = [list[i]]; } }
  runs.push(cur);
  for (const run of runs) {
    if (run.length < 3) continue;
    const rA = run.reduce((s, p) => s + p.r, 0) / run.length, lenA = run.reduce((s, p) => s + p.len, 0) / run.length;
    const d = run.reduce((s, p) => s.add(p.axis), V()).normalize(), u = run.reduce((s, p) => s.add(p.u), V()).normalize();
    const Lh = clamp(lenA * 0.4, 0.3, 3), T = clamp(rA * 0.5, 0.06, 0.6), sp = run.at(-1).top.clone().sub(run[0].top).normalize();
    const ctrs = run.map((p) => p.top.clone().addScaledVector(u, -T * 0.55).addScaledVector(d, Lh * 0.1));
    const st = [[ctrs[0].clone().addScaledVector(sp, -rA * 1.1), 0.25], [ctrs[0].clone().addScaledVector(sp, -rA * 0.55), 0.8], ...ctrs.map((c) => [c, 1]), [ctrs.at(-1).clone().addScaledVector(sp, rA * 0.55), 0.8], [ctrs.at(-1).clone().addScaledVector(sp, rA * 1.1), 0.25]];
    const rings = st.map(([c, sc]) => { const ring = []; for (let j = 0; j < 18; j++) { const a = (j / 18) * Math.PI * 2, x = Math.cos(a), y = Math.sin(a); ring.push(c.clone().addScaledVector(d, -x * Lh * sc * (x > 0 ? 1 : 1.35)).addScaledVector(u, y * T * sc * (1 - 0.35 * Math.max(0, -x)))); } return ring; });
    const host = run[0].qobj;
    addTo(host, ringLoft(rings, true, true), PM.skin(run[0].pp.color)); // in the pods' colour: reads as the engines' common mount
    // rivet line along the bottom of the beam and a builder's plate on its inboard end
    const bag = ctx.near(host);
    for (let i = 1; i < st.length - 2; i++) for (let k = 0; k < 12; k++) { const p = st[i][0].clone().lerp(st[i + 1][0], k / 12).addScaledVector(u, -T * 1.0); rivet(bag, p, u.clone().negate(), 0.012); }
    plate(bag, st[1][0].clone().addScaledVector(u, -T * 0.92), u.clone().negate(), sp, 0.16);
  }
}
// a rivet line just off the body-side seam of each fillet, and a builder's plate ahead of a main wing's root
function filletRivets(made, bobj, ctx, mainWing) {
  const bag = ctx.near(bobj);
  for (const m of made) {
    const e = m.userData.edge; if (!e || e.pts.length < 2) continue;
    let acc = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i], L = a.distanceTo(b);
      for (let t = (0.07 - acc) / (L || 1); t < 1; t += 0.07 / (L || 1)) rivet(bag, a.clone().lerp(b, Math.max(0, t)).addScaledVector(e.n, 0.002), e.n, 0.009);
      acc = (acc + L) % 0.07;
    }
    if (mainWing && e.pts.length > 6) { const lead = e.pts[Math.floor(e.pts.length / 2)], h = snap(solidMeshes(bobj), lead.clone().addScaledVector(ctx.fw, 0.35), e.n, 0.15); if (h) plate(bag, h.p.addScaledVector(h.n, 0.002), h.n, ctx.fw, 0.12); } // (on the skin ahead of the fillet: it stood off the curve)
  }
}
// a surface point near p (within `reach` along the normal n either way) on meshes: { p, n } with n facing along n, or null
function snap(meshes, p, n, reach = 0.04) {
  const h = cast(meshes, p.clone().addScaledVector(n, reach), n.clone().negate(), 2 * reach, true); if (!h) return null;
  if (h.n.dot(n) < 0) h.n.negate(); return h;
}
// small fittings: a domed rivet head; a riveted builder's plate (aluminium with a dark border)
function rivet(bag, p, n, s) { const g = new THREE.SphereGeometry(s, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, 0.4, 1); g.applyMatrix4(frameAt(p, n, V(0, 0, -1))); bag.add(g, M.aluminum()); }
function plate(bag, p, n, along, w) {
  const f = frameAt(p, n, along), pl = new THREE.BoxGeometry(w, 0.004, w * 0.55); pl.applyMatrix4(f); bag.add(pl, PM.metal('brushed'));
  const bd = new THREE.BoxGeometry(w * 0.82, 0.005, w * 0.3); bd.applyMatrix4(f); bag.add(bd, M.black());
  for (const [x, z] of [[-0.42, -0.21], [0.42, -0.21], [-0.42, 0.21], [0.42, 0.21]]) rivet(bag, p.clone().add(V(x * w, 0.004, z * w).applyMatrix4(new THREE.Matrix4().extractRotation(f))), n, 0.008);
}

// ---------- canopy seat ----------
const CANOPY = {
  ck_bubble: { n: 36, g: (th, ph) => V(0.45 * Math.cos(ph) * Math.sin(th), 0.425 * Math.sin(ph), -1.0 * Math.cos(ph) * Math.cos(th)) },
  ck_open: { n: 28, g: (th) => V(0.42 * Math.sin(th), 0, -0.58 * Math.cos(th)), flat: true },
  ck_fighter: { n: 40, g: (() => {
    const prof = [[-1.6, 0.02], [-0.8, 0.42], [0.3, 0.5], [1.4, 0.3], [2.0, 0.04]], c = new THREE.SplineCurve(prof.map(([z, r]) => new THREE.Vector2(z, r))).getPoints(40);
    const rAt = (z) => { for (let i = 1; i < c.length; i++) if (c[i].x >= z) { const a = c[i - 1], b = c[i]; return a.y + (b.y - a.y) * ((z - a.x) / (b.x - a.x || 1)); } return 0.04; };
    return (th, ph) => { const f = th < Math.PI ? th / Math.PI : (2 * Math.PI - th) / Math.PI, side = th < Math.PI ? 1 : -1, z = -1.45 + 3.3 * f, r = Math.max(0.05, rAt(z)) * 0.98; return V(side * r * Math.cos(ph), 1.15 * r * Math.sin(ph), z); };
  })() },
  ck_tandem: { n: 40, g: TANDEM_SHAPE, vol: TANDEM_VOL, floor: -0.72 }, // (sunk into its body: the skin opens under the glass, a tub down to the floor)
};
// A canopy sunk into its body (C.vol: its glass volume, < 0 inside, in part coordinates): the skin facing up inside the
// glass is cut away, and a tub runs from the seam S (where the glass comes out of the skin) down to the cockpit floor
// C.floor, replacing the canopy's own tub. (The crew sat inside a solid skin, buried to the chest.)
function opening(C, cobj, structure, S, up) {
  const inv = cobj.matrixWorld.clone().invert(), v = V(), n = V();
  for (const m of structure) {
    const g = m.geometry, pos = g.attributes.position, nrm = g.attributes.normal; if (!pos || !nrm) continue;
    m.updateMatrixWorld(); const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld), val = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); if (n.dot(up) < 0.2) { val[i] = 1; continue; }
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(inv); val[i] = C.vol(v.x, v.y, v.z);
    }
    const g2 = clipGeometry(g, val); if (g2) { m.geometry = g2; g.dispose(); }
  }
  const W = cobj.matrixWorld, loc = S.map((p) => p.clone().applyMatrix4(inv));
  const ring = (k, sx, sz) => loc.map((p) => V(p.x * sx, p.y + (C.floor - p.y) * k, p.z * sz).applyMatrix4(W));
  const rings = [ring(0, 1, 1), ring(0.55, 0.95, 0.97), ring(1, 0.86, 0.9)], tg = ringLoft(rings, false, true), idx = tg.index.array;
  addTubObstacle(cobj, rings, inv); // (the crew keep inside it)
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } // (facing in)
  tg.computeVertexNormals();
  addTo(cobj, tg, PM.seat(), { shadow: false });
  cobj.traverse((o) => { if (o.userData.ownTub) o.visible = false; });
}
function seat(cp, cobj, bp, structure) {
  const C = CANOPY[cp.id]; if (!C) return;
  const W = cobj.matrixWorld, down = V(0, -1, 0).transformDirection(W), up = down.clone().negate();
  const ctr = V(0, 0, 0).applyMatrix4(W), S = [], H = [];
  for (let k = 0; k < C.n; k++) {
    const th = (k / C.n) * Math.PI * 2, base = C.g(th, 0).applyMatrix4(W);
    const top = cast(structure, base.clone().addScaledVector(up, 2.5), down, 6);
    if (!top) { S.push(base); H.push(base.clone()); continue; }
    if (top.p.distanceTo(base) > 0.7 && top.p.clone().sub(base).dot(down) > 0) { S.push(base); H.push(base.clone()); continue; } // nothing close below
    const above = top.p.clone().sub(base).dot(up) > 0; // body skin above the canopy base: the glass sinks into the body
    if (!above || C.flat) { S.push(base); H.push(top.p.clone()); continue; }
    // find where the glass comes out of the body (bisect along the meridian)
    let lo = 0, hi = Math.PI / 2;
    for (let it = 0; it < 7; it++) {
      const ph = (lo + hi) / 2, g = C.g(th, ph).applyMatrix4(W), h = cast(structure, g.clone().addScaledVector(up, 2.5), down, 6);
      if (h && h.p.clone().sub(g).dot(up) > 0) lo = ph; else hi = ph;
    }
    const s = C.g(th, lo).applyMatrix4(W); S.push(s); H.push(s.clone());
  }
  if (C.vol) opening(C, cobj, structure, S, up);
  // skirt (where the canopy base floats above the skin), flaring out into the body
  const rows = [];
  for (let j = 0; j <= 4; j++) {
    const u = j / 4;
    rows.push(S.map((s, k) => { const out = s.clone().sub(ctr).addScaledVector(up, -s.clone().sub(ctr).dot(up)).normalize(), drop = H[k].distanceTo(s); return s.clone().lerp(H[k], u).addScaledVector(out, drop * 0.35 * u * u); }));
  }
  const geo = gridGeo(rows, { closedCols: true, out: S[Math.floor(C.n / 4)].clone().sub(ctr) });
  addTo(cobj, geo, PM.skin(bp.color));
  // sill: a rounded frame along the seam
  const sill = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(S, true), C.n * 3, cp.id === 'ck_open' ? 0.045 : 0.03, 6, true);
  addTo(cobj, sill, PM.skin(cp.id === 'ck_open' ? cp.color : bp.color));
  if (cp.id === 'ck_open') openWell(cobj, structure);
}
// An open cockpit on a body that isn't reshaped round it (a car's tub): the body's deck inside the coaming used to stay
// closed, so the driver sat through it. Now the deck is cut away inside the coaming and a well goes down to the floor
// (OPEN_WELL.floor, as deep as skinBlend's tub for this cockpit, or the body's bottom if that is higher), running forward
// under the deck as a footwell (floor, sides, ceiling under the deck, a front wall), so the legs go under the cowl.
function openWell(cobj, structure) {
  const W = cobj.matrixWorld, inv = W.clone().invert(), down = V(0, -1, 0).transformDirection(W).normalize(), up = down.clone().negate();
  const L = (x, y, z) => V(x, y, z).applyMatrix4(W), yOf = (p) => p.clone().applyMatrix4(inv).y, { a, b, fw, foot } = OPEN_WELL;
  const deck = cast(structure, L(0, 1.5, 0), down, 4); if (!deck) return;
  const deckY = yOf(deck.p), bot = cast(structure, L(0, deckY - 0.02, 0), down, 4, true);
  const floorY = Math.max(OPEN_WELL.floor, bot ? yOf(bot.p) + 0.015 : -Infinity); if (deckY - floorY < 0.2) return;
  const deckAt = (x, z) => { const h = cast(structure, L(x, deckY + 1, z), down, 3); return h ? yOf(h.p) : deckY; }; // (the deck's top, before it is cut)
  const ceilAt = (z) => { const h = cast(structure, L(0, floorY + 0.05, z), up, 2, true); return Math.max(floorY + 0.15, (h ? yOf(h.p) : deckY) - 0.015); }; // (under the deck)
  const ze = (x) => -b * Math.sqrt(Math.max(0, 1 - (x / a) ** 2)), zf = ze(fw) - foot, N = 40;
  // the well's outline: round the opening from one side of the footwell, behind the seat, to the other
  const th0 = Math.asin(fw / a), rim = []; for (let k = 0; k <= N; k++) { const th = th0 + (2 * Math.PI - 2 * th0) * (k / N); rim.push([a * Math.sin(th), -b * Math.cos(th)]); }
  const tops = rim.map(([x, z]) => deckAt(x * 1.04, z * 1.04));
  const tunnel = []; for (let k = 0; k <= 8; k++) { const z = zf + (ze(fw) - zf) * (k / 8); tunnel.push([z, ceilAt(z)]); }
  // cut the deck: the body's skin inside the opening, above the middle of the well (the floor stays)
  const mid = (deckY + floorY) / 2;
  for (const m of new Set([deck.m])) {
    const g = m.geometry, P = g.attributes.position, val = new Float32Array(P.count), v = V(), toC = inv.clone().multiply(m.matrixWorld);
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(toC); val[i] = Math.max(Math.hypot(v.x / a, v.z / b) - 1, (mid - v.y) * 3); }
    const g2 = clipGeometry(g, val); if (g2) { g2.computeBoundingSphere(); g2.computeBoundingBox(); m.geometry = g2; }
  }
  const mat = PM.duct(0x2a2c30), geos = [];
  geos.push(gridGeo([rim.map(([x, z], k) => L(x, tops[k] - 0.004, z)), rim.map(([x, z]) => L(x, floorY, z))])); // walls round the opening
  for (const sx of [-1, 1]) geos.push(gridGeo([tunnel.map(([z, c]) => L(sx * fw, c, z)), tunnel.map(([z]) => L(sx * fw, floorY, z))])); // footwell sides
  geos.push(gridGeo([[L(-fw, tunnel[0][1], zf), L(fw, tunnel[0][1], zf)], [L(-fw, floorY, zf), L(fw, floorY, zf)]])); // its front wall
  const cols = 16, ceil = [], flo = [];
  for (let i = 0; i <= 8; i++) ceil.push(Array.from({ length: cols + 1 }, (_, j) => { const x = -fw + 2 * fw * (j / cols), z = zf + (ze(x) - zf) * (i / 8); return L(x, tunnel[Math.min(8, Math.round(((z - zf) / (ze(fw) - zf)) * 8))]?.[1] ?? deckY, z); }));
  geos.push(gridGeo(ceil)); // its ceiling, up to the opening's edge
  for (let i = 0; i <= 10; i++) flo.push(Array.from({ length: 33 }, (_, j) => { const x = -a + 2 * a * (j / 32), z0 = Math.abs(x) <= fw ? zf : ze(x), z1 = -ze(x); return L(x * 0.999, floorY, z0 + (z1 - z0) * (i / 10)); }));
  geos.push(gridGeo(flo)); // the floor
  for (const g of geos) addTo(cobj, g, mat);
}

// ---------- landing gear: wells, doors, boots ----------
// Legs, braces, struts and boots are routed to the skin by gearRoute.js; here the wells and doors of retracting gear.
function gearJoint(gp, gobj, qp, structure, out, gc) {
  const d = PARTS[gp.id], gi = d.gear; if (!gi) return;
  if (gi.float) { routeStruts(gp, gobj, gc, gc.partner(gp)); return; }
  const legs = routeGear(gp, gobj, gc);
  if (legs && (!gi.retract || legs[0].knee || !legs[0].n)) return; // fixed legs end in boots; a leg bent round a flap gets a boot, no well
  if (legs) structure = gc.solid; // wells and doors never on a control surface
  const W = gobj.matrixWorld, down = V(0, -1, 0).transformDirection(W).normalize(), up = down.clone().negate(), o = V(0, 0, 0).applyMatrix4(W);
  const sk = legs ? { p: legs[0].top, n: legs[0].n } : cast(structure, o.clone().addScaledVector(down, 0.1), up, 1.2);
  if (!sk) return;
  const sl = Math.cbrt(Math.abs(W.determinant()));
  if (!gi.retract) { // (car wheels: not routed)
    // boot fairing where the leg enters the skin
    const rr = (0.035 + gi.r * 0.08) * sl, boot = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    boot.scale(rr, rr * 0.9, rr * 3); boot.translate(0, 0, rr * 0.9); // low teardrop, longer behind the leg
    const fw = V(0, 0, -1).transformDirection(out.rootW).normalize(), z = fw.clone().negate().addScaledVector(sk.n, fw.dot(sk.n)).normalize();
    const x = sk.n.clone().cross(z).normalize(), m = new THREE.Matrix4().makeBasis(x, sk.n, z).setPosition(sk.p.clone().addScaledVector(sk.n, -0.02));
    boot.applyMatrix4(m); addTo(gobj, boot, PM.skin(qp.color));
    return;
  }
  // retracting gear: fold direction as in aircraft.js animateRetract
  const xw = gp.pos[0], centre = Math.abs(xw) < 0.35 || gi.steer;
  const fl = centre ? V(0, 0, gi.steer ? -1 : 1) : V(-Math.sign(xw) * (gp.mirror ? -1 : 1), 0, 0); // gear-local fold direction
  const cl = V(0, 1, 0).cross(fl).normalize(), bogie = !!gi.wheels;
  const ww = gi.r * (bogie ? 0.6 : 0.6), Lb = gi.len + gi.r * (bogie ? 1.9 : 1.05), Wb = bogie ? ww * 2.6 + 0.35 : Math.max(gi.r * 1.1, ww + 0.22);
  // the well follows the skin where it is close to the plane of the strut's attachment, and stays flat where the skin
  // curves away or changes part (wing root / intake / belly), so the doors stay clean panels
  const NL = 7, NW = 4, P = [], inv = W.clone().invert(), ySk = sk.p.clone().applyMatrix4(inv).y, tol = Wb * 0.14;
  const at0 = legs ? sk.p.clone().applyMatrix4(inv).setY(0) : V(); // a raked leg: the well opens where it meets the skin
  for (let i = 0; i <= NL; i++) {
    const row = []; let off = false;
    for (let j = 0; j <= NW; j++) {
      const lp = fl.clone().multiplyScalar(-0.12 * Lb + 1.12 * Lb * (i / NL)).addScaledVector(cl, (j / NW - 0.5) * Wb).add(at0);
      const wp = lp.clone().setY(ySk + 0.5).applyMatrix4(W), h = cast(structure, wp.clone().addScaledVector(down, 1.6), up, 2.6);
      const hy = h ? h.p.clone().applyMatrix4(inv).y : ySk - 1;
      if (Math.abs(hy - ySk) > tol) off = true;
      row.push(lp.clone().setY(clamp(hy, ySk - tol, ySk + tol)));
    }
    if (off && i > 2) break; // the skin falls away (or another part starts): the well ends here
    P.push(row);
  }
  if (P.length < 3) return;
  const NLr = P.length - 1;
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i < NLr; i++) for (let j = 0; j <= NW; j++) P[i][j].y = (P[i - 1][j].y + P[i][j].y * 2 + P[i + 1][j].y) / 4;
  for (const row of P) for (const p of row) p.applyMatrix4(W);
  const well = addTo(gobj, gridGeo(P.map((r) => r.map((p) => p.clone().addScaledVector(down, 0.004))), { out: down }), PM.bay(), { shadow: false });
  // two doors split along the well, hinged on its long edges; they hang open while the gear is down
  const doors = [];
  for (const half of [0, 1]) {
    const cols = half ? [2, 3, 4] : [0, 1, 2], skin = P.map((r) => cols.map((j) => r[j].clone().addScaledVector(down, 0.012)));
    const inner = skin.map((r) => r.map((p) => p.clone().addScaledVector(up, 0.012)));
    const rows = skin.map((r, i) => [...r, ...inner[i].slice().reverse()]);
    const hingeIdx = half ? cols.length - 1 : 0, h0 = skin[0][hingeIdx], h1 = skin.at(-1)[hingeIdx];
    const geo = norm(ringLoft(rows.map((r) => r), true, true));
    // pivot in gear-local space at the hinge line
    const inv = W.clone().invert(), hl0 = h0.clone().applyMatrix4(inv), hl1 = h1.clone().applyMatrix4(inv), axis = hl1.clone().sub(hl0).normalize();
    const piv = new THREE.Object3D(); piv.position.copy(hl0); gobj.add(piv);
    toLocal(geo, gobj); geo.translate(-hl0.x, -hl0.y, -hl0.z);
    const mesh = new THREE.Mesh(geo, PM.skin(qp.color)); mesh.userData.joint = mesh.userData.cosmetic = true; mesh.castShadow = true; piv.add(mesh);
    // open = swing the door's free edge downwards
    const freeL = skin[Math.floor(NLr / 2)][half ? 0 : cols.length - 1].clone().applyMatrix4(inv).sub(hl0);
    const test = freeL.clone().applyAxisAngle(axis, 1.4);
    const sign = test.y < freeL.y ? 1 : -1;
    doors.push({ piv, axis, sign });
  }
  out.doors.push({ gobj, doors, well });
  setDoors(out.doors.at(-1), 1);
}
function setDoors(dd, gearT) {
  const open = smooth(clamp(gearT / 0.2, 0, 1));
  for (const d of dd.doors) d.piv.quaternion.setFromAxisAngle(d.axis, d.sign * open * 1.55);
  dd.well.visible = open > 0.02;
}

// ---------- skin furniture ----------
function bladeAntenna(h) { // swept blade, base at origin, up = +y, forward = -z
  const s = new THREE.Shape(); s.moveTo(-h * 0.55, 0); s.lineTo(h * 0.45, 0); s.lineTo(h * 0.35, h * 0.25); s.quadraticCurveTo(h * 0.3, h, h * 0.1, h); s.lineTo(-h * 0.05, h); s.lineTo(-h * 0.45, h * 0.15); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.008, h * 0.06), bevelEnabled: false }); g.translate(0, 0, -Math.max(0.008, h * 0.06) / 2); g.rotateY(Math.PI / 2);
  return g;
}
// place a small piece at a skin point: local frame up = skin normal, forward = aircraft forward projected on the skin
function frameAt(p, n, fw) {
  const z = fw.clone().negate().addScaledVector(n, fw.dot(n)); if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(n, -n.z);
  z.normalize(); const x = n.clone().cross(z).normalize();
  return new THREE.Matrix4().makeBasis(x, n, z).setPosition(p);
}
function bodyFurniture(p, obj, info, ctx) {
  const b = obj.userData.body; if (!b) return;
  const meshes = solidMeshes(obj), W = obj.matrixWorld, fw = ctx.fw;
  const z0 = b.prof[0][0], z1 = b.prof.at(-1)[0], rMax = Math.max(...b.prof.map((q) => q[1])) * Math.max(b.sx, b.sy);
  const sc = partScale(p), R = rMax * Math.max(sc[0], sc[1]), Lz = (z1 - z0) * sc[2];
  if (R < 0.2 || p.id === 'fus_boom') return;
  const yo = (z) => (b.yOff ? b.yOff(z) : 0);
  const skin = (f, ang) => { // skin point at length fraction f, angle round (0 top, +pi/2 right)
    const z = z0 + (z1 - z0) * f, dirL = V(Math.sin(ang), Math.cos(ang), 0), from = V(0, yo(z), z).addScaledVector(dirL, rMax * 3).applyMatrix4(W);
    const to = V(0, yo(z), z).applyMatrix4(W); const h = cast(meshes, from, to.clone().sub(from).normalize(), from.distanceTo(to));
    return h;
  };
  const bag = ctx.near(obj), big = new Bag();
  const put = (bg, geo, mat, h) => { geo.applyMatrix4(frameAt(h.p, h.n, fw)); bg.add(geo, mat); };
  // antennas: blade on top, one under the belly; whip on light aircraft
  for (const [f, ang, hh] of [[0.56, 0, clamp(R * 0.22, 0.09, 0.42)], [0.44, Math.PI, clamp(R * 0.14, 0.07, 0.3)], ...(R > 1.2 ? [[0.3, 0, R * 0.12], [0.62, Math.PI, R * 0.1]] : [])]) {
    const h = skin(f, ang); if (h && !ctx.occupied(h.p.clone().addScaledVector(h.n, hh * 0.5), obj)) put(bag, bladeAntenna(hh), M.black(), h);
  }
  // static ports (aluminium discs with a dark centre) on both sides
  for (const s of [1, -1]) {
    const h = skin(R > 1 ? 0.18 : 0.62, s * Math.PI / 2 * 0.95); if (!h) continue;
    const d = new THREE.CylinderGeometry(R > 1 ? 0.07 : 0.035, R > 1 ? 0.07 : 0.035, 0.006, 14); put(bag, d, M.aluminum(), h);
    const c = new THREE.CylinderGeometry(R > 1 ? 0.03 : 0.015, R > 1 ? 0.03 : 0.015, 0.008, 10); put(bag, c, M.black(), h);
  }
  // loading ramp (cargo bodies, PARTS[id].ramp: z range in part units): its seams under the upswept tail (two sides and the
  // aft edge), the hinge line across the belly with its knuckles, and a crew door with a window on each side
  const rp = PARTS[p.id].ramp;
  if (rp) {
    const k = Math.max(sc[0], sc[1]), fz = (z) => (z - z0) / (z1 - z0), seamM = M.paint(0x0b0c0e, 'matte'), aS = 0.85;
    const line = (pts, r = 0.012) => { const hs = pts.map(([z, a]) => skin(fz(z), a)).filter(Boolean); if (hs.length >= 2) bag.add(tube(hs.map((h) => h.p.clone().addScaledVector(h.n, 0.006 * k)), r * k, 4, hs.length * 3), seamM); return hs; };
    const N = 10, run = (za, zb, a) => Array.from({ length: N + 1 }, (_, i) => [za + (zb - za) * (i / N), a]), arc = (z, a0, a1) => Array.from({ length: N + 1 }, (_, i) => [z, a0 + (a1 - a0) * (i / N)]);
    for (const s of [1, -1]) line(run(rp.z0, rp.z1, Math.PI - s * aS));
    line(arc(rp.z1, Math.PI - aS, Math.PI + aS));
    const hinge = line(arc(rp.z0, Math.PI - aS, Math.PI + aS), 0.02);
    for (let i = 1; i < hinge.length - 1; i += 3) { const h = hinge[i], kn = new THREE.CylinderGeometry(0.045 * k, 0.045 * k, 0.16 * k, 10); kn.rotateZ(Math.PI / 2); kn.applyMatrix4(frameAt(h.p.clone().addScaledVector(h.n, 0.01 * k), h.n, fw)); bag.add(kn, M.darkMetal()); }
    if (rp.door != null) for (const s of [1, -1]) {
      const d0 = rp.door - 0.45, d1 = rp.door + 0.45, a0 = s * (Math.PI / 2 - 0.32), a1 = s * (Math.PI / 2 + 0.42);
      line(run(d0, d1, a0)); line(run(d0, d1, a1)); line(arc(d0, a0, a1)); line(arc(d1, a0, a1));
      const w = skin(fz(rp.door), s * (Math.PI / 2 - 0.18)); if (w) { const g = new THREE.CylinderGeometry(0.13 * k, 0.13 * k, 0.012, 18); put(bag, g, PM.windscreen(), w); }
    }
  }
  // anti-collision beacons on big bodies (top and belly)
  if (R > 1.2) for (const [f, ang] of [[0.42, 0], [0.5, Math.PI]]) {
    const h = skin(f, ang); if (!h || ctx.occupied(h.p.clone().addScaledVector(h.n, 0.1), obj)) continue;
    const base = new THREE.CylinderGeometry(0.12, 0.14, 0.04, 14); put(big, base, M.black(), h);
    const lens = lightGeometry(new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 1); lens.applyMatrix4(frameAt(h.p.clone().addScaledVector(h.n, 0.03), h.n, fw));
    const lm = new THREE.Mesh(toLocal(lens, obj), PM.light()); lm.userData.planeLight = lm.userData.cosmetic = true; lm.castShadow = false; obj.add(lm);
  }
  // fighters: formation-light strips on the sides, pitot boom on the nose
  if (p.id === 'fus_fighter') {
    for (const s of [1, -1]) { const h = skin(0.25, s * Math.PI / 2 * 0.8); if (h) { const g = new THREE.BoxGeometry(0.05, 0.006, 0.36); g.applyMatrix4(frameAt(h.p, h.n, fw)); big.add(g, PM.formation()); } }
    const nose = V(0, yo(z0), z0).applyMatrix4(W);
    if (!ctx.occupied(nose, obj)) { const tip = nose.clone().addScaledVector(fw, 1.1); big.add(bar(nose.clone().addScaledVector(fw, -0.05), tip, 0.045, 0.02, true, 8), M.steel()); }
  }
  // airliner tube: APU exhaust in the tail cone
  if (p.id === 'fus_airliner') { const t = V(0, yo(z1), z1).applyMatrix4(W), g = new THREE.CircleGeometry(0.2, 16); g.applyMatrix4(frameAt(t, fw.clone().negate(), V(0, 1, 0))); big.add(g, PM.exhaust()); }
  ctx.flush(big, obj, false);
}
// walkway, fuel cap, worn leading edge and (left main wing) a pitot tube
function wingFurniture(p, obj, ctx, rootJoined) {
  const d = PARTS[p.id]; if (!d.wing || d.allMoving) return; // (an all-moving fin turns as a whole: nothing fixed on it)
  const F = wingFrame(p, obj), spanW = F.pt(0, 0.3, 1).distanceTo(F.pt(1, 0.3, 1)), main = d.cat === 'wing';
  const big = new Bag(), bag = ctx.near(obj);
  // worn leading edge: bare metal strip round the nose, ragged at its edges
  if (spanW > 1.2 && F.o.root >= (main ? 4 : 2.4)) {
    const NS = 24, NV = 6, rows = [];
    for (let i = 0; i <= NS; i++) {
      const s = 0.015 + 0.97 * (i / NS), row = [];
      for (let j = 0; j <= NV; j++) { const v = j / NV, side = v < 0.5 ? -1 : 1, x = Math.abs(v - 0.5) * 2 * 0.045; row.push(F.pt(s, Math.max(0.0005, x), side, 0.0025)); }
      rows.push(row);
    }
    const lenW = spanW;
    const geo = gridGeo(rows, { uv: (i, j) => [(i / NS) * lenW / 1.5, j / NV], out: F.pt(0.5, 0, 0).sub(F.pt(0.5, 0.3, 0)) });
    addTo(obj, geo, PM.wear(), { shadow: false });
  }
  if (!main) return;
  // walkway on the upper surface next to the root fillet
  // (only where the root really meets that body: a stub wing joined at its tip, like the Twin Pod's centre section, got
  // walkways out in the middle of the wing)
  const rb = rootJoined && new THREE.Box3().setFromObject(rootJoined);
  const lowWing = rb && rb.clone().expandByScalar(0.3).containsPoint(F.pt(0, 0.3, 0)) && F.pt(0.05, 0.3, 0).sub(rb.getCenter(V())).dot(ctx.up) < 0;
  if (lowWing) {
    const s0 = Math.min(0.2, 0.18 / spanW + 0.01), s1 = s0 + Math.min(0.2, 0.42 / spanW), rows = [];
    for (let i = 0; i <= 4; i++) { const s = s0 + (s1 - s0) * (i / 4), row = []; for (let j = 0; j <= 6; j++) row.push(F.pt(s, 0.12 + 0.4 * (j / 6), 1, 0.003)); rows.push(row); }
    addTo(obj, gridGeo(rows, { uv: (i, j) => [i / 4, j / 6], out: F.pt(0.1, 0.3, 1).sub(F.pt(0.1, 0.3, -1)) }), PM.walkway(), { shadow: false });
  }
  // fuel cap
  { const s = 0.45, pnt = F.pt(s, 0.3, 1, 0.002), n = F.pt(s, 0.3, 1).sub(F.pt(s, 0.3, -1)).normalize(), fw = F.pt(s, 0, 0).sub(F.pt(s, 0.5, 0)).normalize();
    const cap = new THREE.CylinderGeometry(0.055, 0.06, 0.012, 16); cap.applyMatrix4(frameAt(pnt, n, fw)); bag.add(cap, M.aluminum());
    const tab = new THREE.BoxGeometry(0.07, 0.01, 0.015); tab.applyMatrix4(frameAt(pnt.clone().addScaledVector(n, 0.01), n, fw)); bag.add(tab, M.steel()); }
  // pitot tube under the left wing of light aircraft
  const tipW = F.pt(1, 0.3, 0), rootW = F.pt(0, 0.3, 0), leftWing = tipW.clone().sub(rootW).dot(ctx.right) < 0;
  if (leftWing && F.o.root < 3 && spanW > 2) {
    const s = 0.62, a = F.pt(s, 0.2, -1), n = F.pt(s, 0.2, -1).sub(F.pt(s, 0.2, 1)).normalize(), b = a.clone().addScaledVector(n, 0.14);
    const tipP = b.clone().add(F.pt(s, 0, 0).sub(F.pt(s, 0.2, 0)).normalize().multiplyScalar(F.pt(s, 0, 0).distanceTo(F.pt(s, 0.2, 0)) + 0.22));
    bag.add(bar(a, b, 0.035, 0.012), M.aluminum()); bag.add(bar(b, tipP, 0.018, 0.018, true, 6), M.aluminum());
  }
  ctx.flush(big, obj, false);
}
// soot streaks from exhaust stacks along whatever skin is behind them
function soot(p, obj, ctx, parent) {
  const P = POD[p.id]; if (!P?.ex) return;
  const W = obj.matrixWorld, targets = [...solidMeshes(obj), ...(parent ? solidMeshes(parent) : [])];
  for (const [ex, ey, ez] of P.ex) for (const sx of [1, -1]) {
    const S = V(sx * ex, ey, ez).applyMatrix4(W), axisP = V(0, 0, ez).applyMatrix4(W), outward = S.clone().sub(axisP).normalize();
    const aft = ctx.fw.clone().negate(), L = P.soot * linScale(p), rows = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10, c = S.clone().addScaledVector(aft, u * L), across = outward.clone().cross(aft).normalize(), wdt = 0.06 + 0.32 * u;
      const row = [];
      for (let j = 0; j <= 4; j++) {
        const q = c.clone().addScaledVector(across, (j / 4 - 0.5) * wdt), h = cast(targets, q.clone().addScaledVector(outward, 0.6), outward.clone().negate(), 1.5);
        if (!h) { row.length = 0; break; }
        row.push(h.p.clone().addScaledVector(h.n, 0.004));
      }
      if (!row.length) break;
      rows.push(row);
    }
    if (rows.length < 3) continue;
    const n = rows.length - 1, geo = gridGeo(rows, { uv: (i, j) => [i / n * (n / 10), j / 4], out: outward });
    // attach to whatever is under the middle of the streak
    addTo(obj, geo, PM.soot(), { shadow: false });
  }
}

// ---------- car parts ----------
const glassOf = (obj, out) => obj.traverse((m) => { if (m.isMesh && m.visible && m.material?.transparent && m.material.blending !== THREE.AdditiveBlending && !m.userData.isDisc) out.push(m); });
// A car engine's exhaust: try each route (side pipes, zoomies, dump under, stacks) against everything else on the
// vehicle and use the first that runs into neither body nor glass (on a front-engined truck the side pipes went
// through the windscreen). Never a route through glass; if every route touches something, the shortest clear-of-glass
// one. The chosen paths are kept in userData.exhaustPaths (world) for tools/test/meshcheck.
function routeExhaust(obj, objs) {
  const ex = obj.userData.exhaust, W = obj.matrixWorld, solid = [], glass = [];
  for (const o of objs) { if (!o || o === obj) continue; solid.push(...solidMeshes(o)); glassOf(o, glass); }
  const hits = (list, pts, skip0 = true) => { let n = 0; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], d = pts[i + 1].clone().sub(a), L = d.length(); d.normalize(); const s0 = i === 0 && skip0 ? Math.min(0.06, L * 0.3) : 0; /* a pipe may start on the skin it leaves */ if (cast(list, a.clone().addScaledVector(d, s0), d, L - s0 + ex.r, true)) n++; } return n; };
  let best = null;
  for (const route of EXHAUST_ROUTES) {
    const paths = [1, -1].map((sx) => route.pts.map(([x, y, z]) => V(sx * x, y, z).applyMatrix4(W)));
    const g = paths.reduce((s, p) => s + hits(glass, p, false), 0); if (g) continue;
    const b = paths.reduce((s, p) => s + hits(solid, p), 0);
    if (!best || b < best.b) best = { route, paths, b };
    if (!b) break;
  }
  const old = obj.children.find((c) => c.userData.route);
  if (!best) { if (old) old.visible = false; obj.userData.exhaustPaths = []; return; }
  if (old?.userData.route !== best.route.name) { if (old) { obj.remove(old); old.traverse((m) => m.geometry?.dispose()); } obj.add(exhaustPipes(best.route, ex)); }
  obj.userData.exhaustPaths = best.paths.map((p) => p.map((q) => q.toArray()));
}
// Where an engine sits on a body (through a hood or a deck): a rubber-edged collar on the skin round its sump.
function engineCollar(obj, body) {
  const W = obj.matrixWorld, solid = solidMeshes(body), pts = [], up = V(0, 1, 0).transformDirection(W).normalize();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), lx = Math.sign(c) * Math.abs(c) ** 0.4 * 0.24, lz = Math.sign(s) * Math.abs(s) ** 0.4 * 0.4;
    const top = V(lx, 0.45, lz).applyMatrix4(W), h = cast(solid, top, up.clone().negate(), 0.75);
    if (!h || h.n.dot(up) < 0.5) return; // not sitting on a deck all round: no collar
    pts.push(h.p.addScaledVector(h.n, 0.012));
  }
  addTo(body, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 84, 0.03, 6, true), M.rubber());
}
// A car wheel on an open-wheel body gets a fender (truck bodies carry mud flaps instead: carDetail.js, which also
// builds the axles, drivetrain and moving suspension).
function carCorner(p, obj, bp) { if (!PARTS[bp.id].mudFlaps) fender(obj.userData, bp.color); }

// A cycle-wing fender over a car wheel (open-wheel bodies: a truck body has its own wheel arches and mud flaps): a
// crowned strip in the body's paint following the tyre from behind the axle to ahead of the top, with a rolled edge
// and two stays down beside the tyre's inner wall. It sits on the wheel's fixed frame (wheelsFixed), so it rises and
// steers with the wheel and never meets the tyre. Sized from the tyre actually fitted.
function fender(u, color) {
  const wh = u.wheels, fx = u.wheelsFixed; wh.updateMatrixWorld(true);
  const inv = wh.matrixWorld.clone().invert(), box = new THREE.Box3(), m = new THREE.Matrix4();
  wh.traverse((o) => { if (o.isMesh) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld))); } });
  if (box.isEmpty()) return;
  const w = box.max.x - box.min.x, xc = (box.max.x + box.min.x) / 2, rr = Math.max(box.max.y, -box.min.y, box.max.z, -box.min.z);
  const R = rr * 1.07 + 0.03, hw = w * 0.58, crown = rr * 0.06, NA = 18, NX = 8, rows = [];
  const P = (th, x, dr = 0) => V(x, (R + dr) * Math.cos(th), -(R + dr) * Math.sin(th));
  for (let i = 0; i <= NA; i++) {
    const th = -1.2 + 1.95 * (i / NA), row = [];
    for (let j = 0; j <= NX; j++) { const t = (j / NX) * 2 - 1, edge = Math.abs(t) > 0.92 ? -(Math.abs(t) - 0.92) * 0.9 * rr : 0; row.push(P(th, xc + t * hw, crown * (1 - t * t) + edge)); }
    rows.push(row);
  }
  const geo = shell(gridGeo(rows, { uv: (i, j) => [i / NA, j / NX], out: V(0, 1, 0) }), Math.max(0.008, rr * 0.018));
  const b = new Bag(); b.add(geo, PM.carPaint(color));
  for (const th of [0.45, -0.75]) { const top = P(th, xc - hw * 0.92), bot = V(xc - w * 0.5 - 0.02, rr * 0.3 * Math.cos(th), -rr * 0.3 * Math.sin(th)); b.add(bar(top, bot, rr * 0.05, rr * 0.05, true, 6), M.darkMetal()); }
  for (const [mat, g] of b.merged()) { const mesh = new THREE.Mesh(g, mat); mesh.userData.joint = mesh.userData.cosmetic = true; mesh.castShadow = true; mesh.receiveShadow = true; fx.add(mesh); }
}

// A position light: its lens shows the colour of its side (red left, green right, white on the centreline: the rule
// aircraft.js colours the bulb by in flight) and its teardrop head turns to face the airflow, flattened onto the skin it
// sits on, however the part was turned.
function navLight(obj, ctx) {
  const u = obj.userData, W = obj.matrixWorld, x = V().setFromMatrixPosition(W).applyMatrix4(ctx.rootInv).x, col = navColour(x);
  u.navLens.material.color.setHex(col); u.navLens.material.emissive.setHex(col);
  if (u.bulb) u.bulb.material.color.setHex(col).multiplyScalar(6);
  const f = ctx.fw.clone().transformDirection(W.clone().invert()); f.y = 0;
  if (f.lengthSq() > 1e-4) { f.normalize(); u.navHead.rotation.y = Math.atan2(-f.x, -f.z); }
}

// ---------- LOD ----------
// One per aircraft: hides the small near-only detail beyond a distance (the renderer calls update() for isLOD objects).
class DetailLOD extends THREE.Object3D {
  constructor(items, radius) { super(); this.isLOD = true; this.autoUpdate = true; this.items = items; this.far = 40 + radius * 1.2; this.on = true; this._p = V(); }
  update(camera) {
    if (!this.items.length) return;
    const d = this._p.setFromMatrixPosition(this.matrixWorld).distanceTo(camera.position) * (camera.zoom ? 1 / camera.zoom : 1) * (camera.fov ? camera.fov / 50 : 1);
    const on = this.on ? d < this.far * 1.1 : d < this.far * 0.9;
    if (on !== this.on) { this.on = on; for (const m of this.items) m.visible = on; }
  }
}

// ---------- entry point ----------
// design: { parts }, objs[i]: the built object of design part i (already placed, all under `root`).
// opts.near: build the small near-only furniture and the LOD switch (flight/hangar), false for merged static planes.
export function assemble(design, objs, root, { near = true, quick = false } = {}) {
  root.updateMatrixWorld(true);
  const out = { doors: [], parts: objs, rootW: root.matrixWorld.clone() };
  const parts = design.parts, valid = (i) => i >= 0 && objs[i] && PARTS[parts[i]?.id];
  // bodies swell into one skin with what they carry, canopies are seated into them (skinBlend.js)
  const nearBags = new Map(), nearBag = (obj) => { if (!near) return { add() {} }; if (!nearBags.has(obj)) nearBags.set(obj, new Bag()); return nearBags.get(obj); };
  // a body with its own nose (userData.noseCap) puts it away when another part covers its front (a Bubble Nose bolted
  // to a Heli Cabin is then the nose), and its seats go with it
  objs.forEach((o, i) => {
    const nc = valid(i) && o.userData.noseCap; if (!nc) return;
    o.updateMatrixWorld(true); const f = V(...nc.front).applyMatrix4(o.matrixWorld);
    const covers = (q) => { let hit = false; q.traverse((m) => { if (!hit && m.isMesh && !m.userData.isDisc && new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position).applyMatrix4(m.matrixWorld).containsPoint(f)) hit = true; }); return hit; };
    if (objs.some((q, j) => j !== i && valid(j) && !PARTS[parts[j].id].gear && PARTS[parts[j].id].cat !== 'rotor' && covers(q))) {
      o.remove(nc.obj); nc.obj.traverse((m) => m.geometry?.dispose()); o.userData.seats = null;
    }
  });
  const t0 = performance.now(); let seated = new Set();
  // (the canopy's rivet row is found on the blended skin's field: each rivet is snapped onto the built skin, or left out)
  let skins = null; const skinOf = () => skins || (skins = objs.flatMap((o, j) => (valid(j) && isBody(parts[j].id) ? solidMeshes(o) : [])));
  try { seated = blendSkins(design, objs, { pods: POD, addTo, quick, rivets: (obj, pts, n) => { const bag = nearBag(obj), m = skinOf().filter((x) => !obj.children.includes(x)); pts.forEach((p, k) => { const h = snap(m, p, n[k]); if (h) rivet(bag, h.p, h.n, 0.008); }); } }); } catch (e) { console.warn('skinBlend', e); }
  const tSkin = performance.now() - t0;
  const fw = V(0, 0, -1).transformDirection(root.matrixWorld).normalize(), right = V(1, 0, 0).transformDirection(root.matrixWorld).normalize(), up = V(0, 1, 0).transformDirection(root.matrixWorld).normalize();
  const gearSet = new Set();
  parts.forEach((p, i) => { if (valid(i) && PARTS[p.id].gear) objs[i].traverse((o) => gearSet.add(o)); });
  const structure = [];
  parts.forEach((p, i) => { if (valid(i) && !PARTS[p.id].gear && PARTS[p.id].cat !== 'rotor') structure.push(...solidMeshes(objs[i])); });
  const ctx = {
    fw, right, up, structure, isGear: (m) => gearSet.has(m), rootInv: root.matrixWorld.clone().invert(),
    near: nearBag,
    flush: (bag, obj, nr) => { for (const [mat, geo] of bag.merged()) addTo(obj, geo, mat, { near: nr }); },
    boxes: objs.map((o, j) => (valid(j) ? new THREE.Box3().setFromObject(o).expandByScalar(0.05) : null)),
    occupied: (pt, self) => ctx.boxes.some((b, j) => b && objs[j] !== self && b.containsPoint(pt)),
  };
  const done = new Set(), joined = new Map(), tm = { skin: tSkin }, T = (k, f) => { const t0 = performance.now(); const r = f(); tm[k] = (tm[k] || 0) + performance.now() - t0; return r; }; out.timing = tm;
  const pairKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a), pylons = new Map();
  const paintOf = (bp) => bp.color;
  parts.forEach((p, i) => {
    if (!valid(i) || !valid(p.parent)) return;
    const q = parts[p.parent], j = p.parent, k = pairKey(i, j); if (done.has(k)) return; done.add(k);
    const di = PARTS[p.id], dj = PARTS[q.id];
    try {
      let fm = null;
      if (di.wing && isBody(q.id)) { fm = T('fillet', () => fillet(p, objs[i], q, objs[j], paintOf)); if (fm.length) joined.set(i, objs[j]); }
      else if (dj.wing && isBody(p.id)) { fm = T('fillet', () => fillet(q, objs[j], p, objs[i], paintOf)); if (fm.length) joined.set(j, objs[i]); }
      if (fm?.length && near) T('rivets', () => filletRivets(fm, di.wing ? objs[j] : objs[i], ctx, PARTS[(di.wing ? p : q).id].cat === 'wing'));
      let pl = null;
      if (POD[p.id] && (dj.wing || isBody(q.id))) pl = T('pylon', () => pylon(p, objs[i], q, objs[j]));
      else if (POD[q.id] && (di.wing || isBody(p.id))) pl = T('pylon', () => pylon(q, objs[j], p, objs[i]));
      if (pl && PARTS[pl.qp.id].wing) { T('nacelle', () => nacelle(pl)); if (!pylons.has(pl.qobj)) pylons.set(pl.qobj, []); pylons.get(pl.qobj).push(pl); }
      if (CANOPY[p.id] && isBody(q.id) && !seated.has(i)) T('seat', () => seat(p, objs[i], q, solidMeshes(objs[j]))); // only the body it sits on (a roll cage above is not a skin)
    } catch (e) { console.warn('planeDetail joint', p.id, q.id, e); }
  });
  for (const list of pylons.values()) try { T('beam', () => engineBeams(list, ctx)); } catch (e) { console.warn('planeDetail beam', e); }
  // landing gear once every skin, fillet, pylon and nacelle is in place: gearRoute.js routes the legs to whatever is
  // really there. Control surfaces (and what rides on them) move, so no strut may meet them.
  root.updateMatrixWorld(true); // (the joints added above have no world matrix yet)
  const movable = new Set(), gearSolid = [];
  const shown = (m) => { for (let o = m; o; o = o.parent) if (!o.visible) return false; return true; };
  parts.forEach((p, i) => {
    if (!valid(i)) return; const o = objs[i];
    for (const u of [o.userData, o.children[0]?.userData || {}]) for (const c of [...(u.controls || []), ...(u.slats || []), ...(u.spoilers || [])]) c.obj.traverse((m) => movable.add(m));
    if (PARTS[p.id].gear || PARTS[p.id].cat === 'rotor') return;
    const skip = new Set(); for (const k of ['prop', 'fan', 'flame', 'flameCore']) o.userData[k]?.traverse((m) => skip.add(m));
    o.traverse((m) => { if (m.isMesh && !skip.has(m) && !m.userData.isDisc && !m.userData.near && !m.material.transparent && m.material.blending !== THREE.AdditiveBlending && shown(m)) gearSolid.push(m); });
  });
  const gc = {
    cast, all: gearSolid, solid: gearSolid.filter((m) => !movable.has(m)), movable, fw, right, up, rootW: root.matrixWorld.clone(), rootInv: root.matrixWorld.clone().invert(),
    partner: (gp) => { const j = parts.findIndex((o, k) => valid(k) && o !== gp && o.id === gp.id && Math.abs(gp.pos[0]) > 0.05 && Math.abs(o.pos[0] + gp.pos[0]) < 0.02 && Math.abs(o.pos[1] - gp.pos[1]) < 0.02 && Math.abs(o.pos[2] - gp.pos[2]) < 0.02); return j >= 0 ? objs[j] : null; },
  };
  parts.forEach((p, i) => {
    if (!valid(i) || !valid(p.parent) || !PARTS[p.id].gear || objs[i].userData.corner || objs[i].userData.bikeWheel) return; // (car corners: carDetail.js; bike wheels: bikeParts.js)
    try { T('gear', () => gearJoint(p, objs[i], parts[p.parent], structure, out, gc)); } catch (e) { console.warn('planeDetail gear', p.id, e); }
  });
  parts.forEach((p, i) => {
    if (!valid(i)) return;
    try {
      const d = PARTS[p.id];
      if (d.cat === 'fuselage') T('body', () => bodyFurniture(p, objs[i], partInfo(p.id), ctx));
      if (d.wing) T('wing', () => wingFurniture(p, objs[i], ctx, joined.get(i)));
      if (POD[p.id]?.ex) T('soot', () => soot(p, objs[i], ctx, valid(p.parent) ? objs[p.parent] : null));
      if (objs[i].userData.exhaust) T('exhaust', () => routeExhaust(objs[i], objs));
      if (objs[i].userData.navHead) navLight(objs[i], ctx);
      if (d.cat === 'car' && objs[i].userData.wheelsFixed && valid(p.parent) && isBody(parts[p.parent].id)) T('fender', () => carCorner(p, objs[i], parts[p.parent]));
      if (d.cat === 'car' && objs[i].userData.exhaust && valid(p.parent)) T('collar', () => engineCollar(objs[i], objs[p.parent]));
    } catch (e) { console.warn('planeDetail furniture', p.id, e); }
  });
  // cockpit seats and panels, rotor masts and shafts carried to the surfaces they stand on (fitOut.js)
  try { T('fit', () => fitOut(design, objs, root, { valid, cast, addTo, structure, quick })); } catch (e) { console.warn('fitOut', e); }
  // cars: rigged suspension, axles and drivetrain, mud flaps, feet carried to the surfaces they stand on (carDetail.js)
  try { out.rig = T('car', () => assembleCar(design, objs, root, { valid, isBody, cast, solidMeshes, addTo, structure, near, ids: parts.map((p) => p.id), rootW: root.matrixWorld.clone() })); } catch (e) { console.warn('carDetail', e); }
  for (const [obj, bag] of nearBags) ctx.flush(bag, obj, true);
  // interiors are inviolate: every other part's geometry cut away inside each cockpit's or cabin's interior (interior.js)
  if (!quick) try { root.updateMatrixWorld(true); out.keptOut = T('interior', () => keepOut(objs)).cut; } catch (e) { console.warn('interior', e); } // (not while a slider is dragged: the full rebuild after it does it)
  if (near) try { T('crew', () => { addCrew(design, objs); wireRiders(objs); }); } catch (e) { console.warn('crew', e); } // pilots and drivers on the declared seats (crew.js), riders' hands on the bars
  // near-only items: everything tagged near anywhere in the plane
  const items = [];
  for (const o of objs) if (o) o.traverse((m) => { if (m.isMesh && m.userData.near) { m.castShadow = false; if (near) items.push(m); else m.visible = false; } });
  if (near) { let r = 2; root.updateMatrixWorld(true); const box = new THREE.Box3(); for (const o of objs) if (o) box.expandByObject(o); if (!box.isEmpty()) r = box.getSize(V()).length() / 2; const lod = new DetailLOD(items, r); root.add(lod); out.lod = lod; }
  applyLivery(design, objs, root); // paint scheme over the skins (liveries.js)
  root.userData.detail = out;
  return out;
}

// ---------- draw-call merge (flight / remote planes) ----------
// Every rigid piece of a part (the part itself, each hinged surface, slat, spoiler, door, fan, gear strut, fork, wheel)
// gets one mesh per material: everything that moves with it is merged into it. Pieces that blink, flicker or come and
// go on their own (flames, bulbs, prop discs, wheel wells, propeller blades) stay separate. Near-only detail is merged
// separately and stays under the LOD switch. Parts still break off as a whole.
export function mergeStatic(objs, root) {
  const D = root.userData.detail, items = [];
  for (const obj of objs) {
    if (!obj) continue;
    const u = obj.userData, rigid = new Set([obj]), skip = new Set();
    for (const c of u.controls || obj.children[0]?.userData?.controls || []) rigid.add(c.obj);
    for (const s of [...(u.slats || []), ...(u.spoilers || [])]) rigid.add(s.obj);
    for (const k of ['fan', 'strut', 'wheelsFixed', 'spike']) if (u[k]) rigid.add(u[k]);
    for (const r of u.rigid || []) rigid.add(r); // a part's own moving pieces (bike forks, swingarms, shocks)
    if (u.wheels) { if (PARTS_BOGIE(u)) rigid.add(u.wheels); else for (const c of u.wheels.children) rigid.add(c); }
    for (const k of ['flame', 'flameCore', 'bulb', 'prop']) if (u[k]) skip.add(u[k]);
    for (const dd of D?.doors || []) if (dd.gobj === obj) { skip.add(dd.well); for (const d of dd.doors) rigid.add(d.piv); }
    obj.updateMatrixWorld(true);
    for (const r of rigid) {
      const inv = r.matrixWorld.clone().invert(), m = new THREE.Matrix4(), buckets = new Map(), victims = [];
      const walk = (o) => {
        if (skip.has(o) || (o !== r && rigid.has(o)) || o.userData.isDisc || o.userData.live || o.isSkinnedMesh) return; // crew: skinned, posed every frame; live instruments (liveDisplays.js): rewritten every frame
        if (o.isMesh && o.visible && !o.isInstancedMesh) {
          const slot = kitSlot(o.material), mat = slot >= 0 ? kitMaterial() : o.material;
          const key = mat.uuid + (o.castShadow ? 's' : '') + (o.userData.near ? 'n' : '') + (o.userData.planeLight ? 'l' : '');
          if (!buckets.has(key)) buckets.set(key, { mat, geos: [], shadow: o.castShadow, near: !!o.userData.near, light: !!o.userData.planeLight, recv: o.receiveShadow });
          m.multiplyMatrices(inv, o.matrixWorld);
          const g = norm(o.geometry.clone()); g.applyMatrix4(m); if (slot >= 0) kitUV(g, slot);
          if (m.determinant() < 0) { const idx = g.index; for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); } }
          buckets.get(key).geos.push(g); victims.push(o);
        }
        for (const c of o.children.slice()) walk(c);
      };
      walk(r);
      if (!victims.length || (victims.length < 2 && kitSlot(victims[0].material) < 0)) continue;
      for (const v of victims) v.parent.remove(v);
      for (const b of buckets.values()) {
        const mesh = new THREE.Mesh(b.geos.length > 1 ? mergeGeometries(b.geos) : b.geos[0], b.mat);
        mesh.castShadow = b.shadow; mesh.receiveShadow = b.recv; mesh.userData.cosmetic = true;
        if (b.near) { mesh.userData.near = true; items.push(mesh); }
        if (b.light) mesh.userData.planeLight = true;
        r.add(mesh);
      }
    }
  }
  if (D?.lod) { D.lod.items = D.lod.items.filter((m) => m.parent).concat(items); for (const m of D.lod.items) m.visible = D.lod.on; }
}
const PARTS_BOGIE = (u) => u.wheels.children.length > 1 && !u.wheelsFixed;

// Parked planes: swap stock fitting materials for the kit material (before traffic.mergeByMaterial).
export function kitify(root) {
  root.traverse((o) => { if (!o.isMesh) return; const s = kitSlot(o.material); if (s < 0) return; o.geometry = kitUV(norm(o.geometry.clone()), s); o.material = kitMaterial(); });
  return root;
}

// The specific force on the vehicle (acceleration minus gravity, world frame, in g): (0, 1, 0) at rest on the ground or
// in level flight. From the change in velocity since the last frame, lightly smoothed (contact forces chatter at 60 Hz).
const _gf = new THREE.Vector3(), _gq = new THREE.Quaternion();
function specificForce(ac, dt) {
  if (!ac.v?.isVector3) return null; // (the hangar's preview: standing still)
  const st = ac._crewG ||= { v: ac.v.clone(), f: new THREE.Vector3(0, 1, 0) };
  if (dt > 1e-4 && dt < 0.25 && !ac.dead) {
    _gf.copy(ac.v).sub(st.v).divideScalar(dt * 9.81); _gf.y += 1;
    if (_gf.lengthSq() > 400) _gf.setLength(20); // (a crash's one-frame spike; the crew's spring caps it again)
    st.f.lerp(_gf, Math.min(1, dt * 20));
  }
  st.v.copy(ac.v);
  return st.f;
}
// ...in a crew's own frame (the figure may sit at any angle in its part)
function crewForce(r, gW) { if (!gW) return null; r.root.getWorldQuaternion(_gq).invert(); return gW.clone().applyQuaternion(_gq); }

// ---------- per-frame visual hook (flight and remote planes) ----------
// Called at the end of Aircraft.updateVisuals: gear doors follow gearT, slats ride out with the flaps, spoilers rise
// with roll (on the wing whose aileron goes up) and on the ground after landing, gear forks follow the wheels.
export function updateDetail(ac, dt) {
  const D = ac.root.userData.detail; if (!D) return;
  for (const dd of D.doors) setDoors(dd, ac.gearT);
  const k = Math.min(1, dt * 4), spd = ac.v?.length?.() || 0;
  let crewMoving = false;
  bikeSync(ac); // bike forks steer and slide, swingarms swing (before the riders reach for the bars)
  const gW = specificForce(ac, dt); // (what the seat pushes the crew with, world frame, in g: they sway against it)
  const ground = ac.onGround && (ac.ctl.throttle || 0) < 0.1 && spd > 6 ? 1 : 0;
  for (const p of ac.parts) {
    if (!p.alive) continue;
    const u = p.obj.userData;
    if (u.crew) {
      const c = ac.ctl, steer = ac.isCar && ac.steerAngle ? ac.steerAngle() * 2.6 : ac.crewSteer ?? 0;
      for (const r of u.crew) if (r.update({ pitch: c.pitch, roll: c.roll, yaw: c.yaw, throttle: c.throttle, steer, gf: crewForce(r, gW), ...(r.bars ? riderInput(ac, r) : null) }, dt)) crewMoving = true;
    }
    if (u.wheelsFixed && u.wheels) { u.wheelsFixed.position.copy(u.wheels.position); u.wheelsFixed.rotation.y = u.wheels.rotation.y; }
    if (u.spike) u.spike.position.z = RAMJET.spikeTravel * smooth(clamp(((ac.mach || 0) - 1.6) / 1.6, 0, 1)); // inlet spike: locked forward to Mach 1.6, fully back by 3.2
    if (u.slats) { const t = ac.flaps > 0 ? 1 : 0; for (const s of u.slats) { s.t = lerp(s.t || 0, t, k * 0.6); s.obj.position.set(0, -0.022 * s.chord * s.t, -0.05 * s.chord * s.t); } }
    if (u.spoilers) {
      const ail = p.surfaces.find((s) => s.role === 'aileron'), roll = ail ? Math.max(0, -ail.delta) * 1.6 : 0, tgt = Math.max(ground * 0.9, roll);
      for (const s of u.spoilers) s.obj.rotation.x = lerp(s.obj.rotation.x, -tgt, k * 2);
    }
  }
  D.rig?.update(); // suspension links follow the wheels (carRig.js)
  return crewMoving;
}

// ---------- hangar: control-surface preview ----------
// Mirrors Aircraft's control mixing so the hangar can move the surfaces like a pre-flight control check:
// arrow keys / WASD = stick, Q/E = rudder, F = flaps. A short automatic check plays when a plane is loaded.
export class ControlPreview {
  constructor() {
    this.ctl = { pitch: 0, roll: 0, yaw: 0 }; this.flaps = 0; this.keys = new Set(); this.surfs = []; this.demo = 0; this.moving = false;
    window.addEventListener('keydown', (e) => this.key(e, true)); window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }
  key(e, down) {
    if (!this.enabled || (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) || e.metaKey || e.ctrlKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'q', 'e', 'f'].includes(k)) return;
    if (down && k === 'f' && !this.keys.has('f')) this.flaps = (this.flaps + 1) % 4;
    if (down) this.keys.add(k); else this.keys.delete(k);
    this.demo = 0; this.moving = true;
  }
  // rebuild the surface list after the hangar rebuilt the plane (objs[i] for design part i, com from analyze())
  attach(design, objs, com) {
    this.surfs = []; this.parts = [];
    const m = new THREE.Matrix4(), maxs = { pitch: 1e-6, roll: 1e-6, yaw: 1e-6 };
    design.parts.forEach((p, i) => {
      const d = PARTS[p.id], obj = objs[i]; if (!d || !obj) return;
      const ctrl = obj.userData.controls || obj.children[0]?.userData?.controls || [], info = partInfo(p.id); partMatrix(p, m);
      const surfaces = [];
      info.surfaces.forEach((s0, si) => {
        const s = scaleSurface(s0, partScale(p)), pos = V(...s.pos).applyMatrix4(m), n = V(...s.n).transformDirection(m);
        const r = pos.clone().sub(com), t = r.cross(n), tn = t.length(), sv = { role: s.role, flaps: !!d.wing?.flaps, obj: ctrl.find((c) => c.strip === si)?.obj, mix: { pitch: 0, roll: 0, yaw: 0 }, delta: 0 };
        if (!(tn < 0.05 || s.role === 'fixed' || s.role === 'flap')) { t.divideScalar(tn); sv.mix = { pitch: t.x, yaw: -t.y, roll: -t.z }; for (const k in maxs) maxs[k] = Math.max(maxs[k], Math.abs(sv.mix[k])); }
        surfaces.push(sv); this.surfs.push(sv);
      });
      this.parts.push({ obj, surfaces, alive: true });
    });
    for (const s of this.surfs) for (const k in maxs) { s.mix[k] /= maxs[k]; if (Math.abs(s.mix[k]) < 0.12) s.mix[k] = 0; }
    this.objs = objs; this.root = objs.find(Boolean)?.parent;
  }
  playCheck() { this.demo = 0.001; this.moving = true; }
  // returns true while anything is still moving (the hangar renders on demand)
  update(dt) {
    if (!this.surfs.length && !this.parts?.length) return false;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    const c = this.ctl, K = this.keys;
    let tgt = { pitch: (K.has('ArrowDown') || K.has('s') ? 1 : 0) - (K.has('ArrowUp') || K.has('w') ? 1 : 0), roll: (K.has('ArrowRight') || K.has('d') ? 1 : 0) - (K.has('ArrowLeft') || K.has('a') ? 1 : 0), yaw: (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0) };
    let flaps = this.flaps;
    if (this.demo > 0) { // stick right, left, back, forward, rudder right, left, flaps down and up again
      this.demo += dt; const T = [[0, 0, 0, 0], [0, 1, 0, 0], [0, -1, 0, 0], [1, 0, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0], [0, 0, -1, 0], [0, 0, 0, 3], [0, 0, 0, 0]], i = Math.floor(this.demo / 0.7);
      if (!(i >= 0 && i < T.length)) this.demo = 0; else { const [pi, ro, ya, fl] = T[i]; tgt = { pitch: pi, roll: ro, yaw: ya }; flaps = fl; }
    }
    const k = Math.min(1, dt * 6); let moving = this.demo > 0 || K.size > 0;
    for (const a of ['pitch', 'roll', 'yaw']) { c[a] = lerp(c[a], tgt[a], k); if (Math.abs(c[a] - tgt[a]) > 0.002) moving = true; }
    const flapDefl = [0, 0.18, 0.35, 0.6][flaps];
    for (const s of this.surfs) {
      const want = clamp(c.pitch * s.mix.pitch + c.roll * s.mix.roll + c.yaw * s.mix.yaw, -1, 1) * 0.38 + (s.role === 'flap' && s.flaps ? flapDefl : 0);
      s.delta = lerp(s.delta, want, k);
      if (Math.abs(s.delta - want) > 0.002) moving = true;
      if (s.obj) s.obj.rotation.x = s.delta;
    }
    // slats and spoilers through the same hook as in flight
    if (this.root) {
      const fake = { root: this.root, gearT: 1, ctl: { throttle: 1, pitch: c.pitch, roll: c.roll, yaw: c.yaw }, onGround: false, v: null, flaps, parts: this.parts, crewSteer: -(c.roll + c.yaw) * 1.2 };
      if (updateDetail(fake, dt)) moving = true; // the crew follows the stick / wheel
    }
    const was = this.moving; this.moving = moving;
    return moving || was;
  }
}
