// Cockpit stations: one first-person view per seat. Visual and camera only; nothing here is seen by physics.
//
// Every seat a builder declares (obj.userData.seats) gets a crew figure (crew.js), and the view of that seat is from
// that figure's eyes, looking along its own forward axis, so it follows the part wherever a builder put it, at any size,
// rotation or mirror. A cockpit without a seat (the greenhouse nose) uses its part's `eye`, and a build with no
// cockpit at all gets a camera on the top of its nose. Each eye is then checked against the meshes that were really
// built: it is moved clear of anything closer than a few centimetres (canopy frame, panel, skin), and raised, like a
// seat adjusted up, until it is out of anything solid and can see forward over the glare shield; only a canopy sunk
// so deep into a body that no seat inside it sees out lets the head come up out of it. The clearance left sets the
// near plane. From a seat, its own figure loses its head and torso (the hands, legs and controls stay), and a dark
// cabin lining that covers the windows is swapped for the skin drawn from inside (windows open).
// tools/test/cockpitcheck.py checks every view of every stock vehicle and of random builds.
import * as THREE from 'three';
import { CapsuleView } from './capsule.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _tri = new THREE.Triangle(), _cp = V(), _a = V(), _b = V(), _c = V(), _m = new THREE.Matrix4();

// ---------- the vehicle's triangles near a point (body space) ----------
// Every visible mesh of the vehicle except `skip` (the seat's own figure), prop discs and glows, as a flat list of
// triangles with a glass flag (transparent material). Only triangles whose box comes within `R` of `c` are kept.
export function nearTriangles(root, c, R, skip = null) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), out = { p: [], glass: [], mesh: [], tri: [], flip: [] }, lo = c.clone().subScalar(R), hi = c.clone().addScalar(R);
  const sphere = new THREE.Sphere(), v = V();
  const addMesh = (o, mw) => {
    const g = o.geometry, P = g?.attributes?.position; if (!P) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _m.multiplyMatrices(inv, mw);
    sphere.copy(g.boundingSphere).applyMatrix4(_m); if (sphere.center.distanceTo(c) > R + sphere.radius) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material, glass = !!(mat?.transparent && (mat.opacity ?? 1) < 0.75);
    const n = P.count, T = new Float32Array(n * 3), flip = !o.isSkinnedMesh && _m.determinant() < 0; // (a mirrored mesh's triangles wind the other way)
    for (let i = 0; i < n; i++) {
      if (o.isSkinnedMesh) o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld).applyMatrix4(inv); else v.fromBufferAttribute(P, i).applyMatrix4(_m);
      T[i * 3] = v.x; T[i * 3 + 1] = v.y; T[i * 3 + 2] = v.z;
    }
    const idx = g.index, cnt = idx ? idx.count : n;
    for (let k = 0; k + 2 < cnt; k += 3) {
      const i0 = (idx ? idx.getX(k) : k) * 3, i1 = (idx ? idx.getX(k + 1) : k + 1) * 3, i2 = (idx ? idx.getX(k + 2) : k + 2) * 3;
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) { const mn = Math.min(T[i0 + a], T[i1 + a], T[i2 + a]), mx = Math.max(T[i0 + a], T[i1 + a], T[i2 + a]); if (mx < lo.getComponent(a) || mn > hi.getComponent(a)) ok = false; }
      if (!ok) continue;
      out.p.push(T[i0], T[i0 + 1], T[i0 + 2], T[i1], T[i1 + 1], T[i1 + 2], T[i2], T[i2 + 1], T[i2 + 2]); out.glass.push(glass); out.mesh.push(o); out.tri.push(k / 3); out.flip.push(flip);
    }
  };
  const walk = (o) => {
    if (!o.visible || o === skip || o.userData.isDisc) return;
    if (o.isMesh) {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.blending !== THREE.AdditiveBlending && mat.visible !== false) {
        if (o.isSkinnedMesh) o.skeleton?.update();
        if (o.isInstancedMesh) { const im = new THREE.Matrix4(), mw = new THREE.Matrix4(); for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, im); addMesh(o, mw.multiplyMatrices(o.matrixWorld, im)); } }
        else addMesh(o, o.matrixWorld);
      }
    }
    for (const ch of o.children) walk(ch);
  };
  walk(root);
  out.p = new Float32Array(out.p);
  out.box = boxes(out.p);
  return out;
}
// per triangle: min xyz, max xyz (to skip far triangles cheaply)
function boxes(P) {
  const n = P.length / 9, B = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const x = P[i * 9 + a], y = P[i * 9 + 3 + a], z = P[i * 9 + 6 + a]; B[i * 6 + a] = Math.min(x, y, z); B[i * 6 + 3 + a] = Math.max(x, y, z); }
  return B;
}
const far = (B, i, e, r) => e.x < B[i * 6] - r || e.x > B[i * 6 + 3] + r || e.y < B[i * 6 + 1] - r || e.y > B[i * 6 + 4] + r || e.z < B[i * 6 + 2] - r || e.z > B[i * 6 + 5] + r;

// the soup without the triangles for which drop(i) is true
function without(soup, drop) {
  const o = { p: [], glass: [], mesh: [], tri: [], flip: [] };
  for (let i = 0, n = soup.glass.length; i < n; i++) if (!drop(i)) { for (let k = 0; k < 9; k++) o.p.push(soup.p[i * 9 + k]); o.glass.push(soup.glass[i]); o.mesh.push(soup.mesh[i]); o.tri.push(soup.tri[i]); o.flip.push(soup.flip[i]); }
  o.p = new Float32Array(o.p); o.box = boxes(o.p); return o;
}
// Dark interior linings (opaque back-side shells just inside a skin, so a cabin looks dark and solid through its
// windows from outside) cover the windows too, so from a seat inside one you would see only the lining. Find the
// linings that hide glass from the eye (glass within a hand's width of one of their triangles, either side, along the
// line from the eye).
function liningsOverGlass(soup, e, s) {
  const out = new Set(), lin = [], d = V(), q = V(), P = soup.p;
  for (let i = 0, n = soup.glass.length; i < n; i++) {
    const m = soup.mesh[i], mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!soup.glass[i] && mat?.side === THREE.BackSide && !m.isSkinnedMesh && !m.isInstancedMesh) lin.push(i);
  }
  if (!lin.length) return out;
  // through each pane (its centre and corners pulled in a little) from the eye: a lining within a hand's width of the
  // glass, in front of it or right behind it, hides that window
  for (let i = 0, n = soup.glass.length; i < n; i++) {
    if (!soup.glass[i]) continue;
    _c.set(0, 0, 0); for (let k = 0; k < 3; k++) _c.x += P[i * 9 + k * 3] / 3, _c.y += P[i * 9 + k * 3 + 1] / 3, _c.z += P[i * 9 + k * 3 + 2] / 3;
    for (let k = -1; k < 3; k++) {
      q.copy(_c); if (k >= 0) q.lerp(_b.fromArray(P, i * 9 + k * 3), 0.85);
      const dist = q.distanceTo(e); if (dist < 1e-3) continue;
      d.subVectors(q, e).divideScalar(dist);
      hitMeshes(soup, lin, e, d, dist - 0.3 * s, dist + 0.3 * s, out);
    }
  }
  return out;
}
// add to `out` the meshes of triangles `list` that the ray meets between t0 and t1
function hitMeshes(soup, list, o, dir, t0, t1, out) {
  const P = soup.p, B = soup.box, e1 = V(), e2 = V(), pv = V(), tv = V(), qv = V(), a = V(), b = V(), c = V();
  const lo = [0, 0, 0], hi = [0, 0, 0]; // the ray segment's box
  for (let k = 0; k < 3; k++) { const p0 = o.getComponent(k) + dir.getComponent(k) * t0, p1 = o.getComponent(k) + dir.getComponent(k) * t1; lo[k] = Math.min(p0, p1); hi[k] = Math.max(p0, p1); }
  for (const i of list) {
    if (out.has(soup.mesh[i]) || B[i * 6] > hi[0] || B[i * 6 + 3] < lo[0] || B[i * 6 + 1] > hi[1] || B[i * 6 + 4] < lo[1] || B[i * 6 + 2] > hi[2] || B[i * 6 + 5] < lo[2]) continue;
    a.fromArray(P, i * 9); b.fromArray(P, i * 9 + 3); c.fromArray(P, i * 9 + 6);
    e1.subVectors(b, a); e2.subVectors(c, a); pv.crossVectors(dir, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-12) continue;
    const id = 1 / det; tv.subVectors(o, a); const u = tv.dot(pv) * id; if (u < 0 || u > 1) continue;
    qv.crossVectors(tv, e1); const w = dir.dot(qv) * id; if (w < 0 || u + w > 1) continue;
    const t = e2.dot(qv) * id; if (t >= t0 && t <= t1) out.add(soup.mesh[i]);
  }
}
// In its place, from the seat: the part's own skin (the opaque one-sided shells round the eye, with their windows cut
// out exactly) drawn from the inside in the lining's material. Same lining look, open windows, nothing new to compile.
function insideOf(lining, e, root, inv, made) {
  if (made.has(lining)) return made.get(lining); // (both seats of one cabin share it)
  let part = lining; while (part.parent && part.parent !== root) part = part.parent; // the part's object
  const shells = [], box = new THREE.Box3(), m = new THREE.Matrix4();
  part.traverse((o) => {
    if (!o.isMesh || o === lining || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || o.userData.isDisc) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.transparent || mat.side !== THREE.FrontSide || mat.blending === THREE.AdditiveBlending) return;
    const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
    box.copy(g.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)); if (!box.containsPoint(e)) return; // a shell round the seat
    shells.push(o);
  });
  const out = shells.map((o) => {
    const w = new THREE.Mesh(o.geometry, lining.material); w.castShadow = false; w.receiveShadow = true; w.visible = false; w.userData.cosmetic = true;
    o.add(w); return w;
  });
  made.set(lining, out); return out;
}

// closest triangle to a point: { d, at (closest point), i }
export function closest(soup, e) {
  let best = { d: Infinity, at: V(), i: -1 }; const P = soup.p;
  for (let i = 0, n = P.length / 9; i < n; i++) {
    if (best.d < Infinity && far(soup.box, i, e, best.d)) continue;
    _a.fromArray(P, i * 9); _b.fromArray(P, i * 9 + 3); _c.fromArray(P, i * 9 + 6); _tri.set(_a, _b, _c);
    _tri.closestPointToPoint(e, _cp); const d = _cp.distanceTo(e); // (NaN on a degenerate triangle: never the closest)
    if (d < best.d) best = { d, at: _cp.clone(), i };
  }
  return best;
}
// ---------- the views ----------
// Forward line of sight from e along the view (fwd, up): the centre ray and four a few degrees off it. A ray is clear
// if the first thing it meets is glass with no skin right behind it, or nothing solid within `reach` (the panel, a
// frame bow or the cage in your face would be).
export function lineOfSight(soup, e, fwd, up, reach) {
  const right = V().crossVectors(fwd, up).normalize(), rays = [[0, 0], [0, -0.07], [0.14, 0], [-0.14, 0], [0, 0.07]];
  let clear = 0;
  for (const [yw, pt] of rays) {
    const d = fwd.clone().applyAxisAngle(up, yw).applyAxisAngle(right, pt).normalize(), { tg, to } = nearest(soup, e, d);
    if (tg < to ? to - tg > 0.1 * reach / 1.2 || tg > reach : to > reach) clear++; // (glass with a skin right behind it is no window)
  }
  return clear;
}
// nearest glass and nearest solid along a ray
function nearest(soup, o, dir) {
  const P = soup.p, e1 = V(), e2 = V(), pv = V(), tv = V(), qv = V(); let tg = Infinity, to = Infinity;
  for (let i = 0, cnt = soup.glass.length; i < cnt; i++) {
    _a.fromArray(P, i * 9); _b.fromArray(P, i * 9 + 3); _c.fromArray(P, i * 9 + 6);
    e1.subVectors(_b, _a); e2.subVectors(_c, _a); pv.crossVectors(dir, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-12) continue;
    const id = 1 / det; tv.subVectors(o, _a); const u = tv.dot(pv) * id; if (u < 0 || u > 1) continue;
    qv.crossVectors(tv, e1); const w = dir.dot(qv) * id; if (w < 0 || u + w > 1) continue;
    const t = e2.dot(qv) * id; if (t <= 1e-5) continue;
    if (soup.glass[i]) tg = Math.min(tg, t); else to = Math.min(to, t);
  }
  return { tg, to };
}

// The station's frame (body space): eye, forward and up from a figure / part matrix (mirrors and scale taken out).
function frameOf(m, eyeLocal, inv, tilt = 0) {
  const mm = new THREE.Matrix4().multiplyMatrices(inv, m);
  const eye = eyeLocal.clone().applyMatrix4(mm), fwd = V(0, 0, -1).transformDirection(mm), up0 = V(0, 1, 0).transformDirection(mm);
  const right = V().crossVectors(fwd, up0).normalize(); if (tilt) fwd.applyAxisAngle(right, tilt);
  const up = V().crossVectors(right, fwd).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate()));
  const s = Math.cbrt(Math.abs(mm.determinant()));
  return { eye, fwd, up, q, s };
}

// Inside solid geometry (a head buried in a body skin, a seat, a panel): looking out from there, nearly every way
// (10 of 14 directions) the first thing met is the back of a one-sided surface, which isn't drawn, so the view would
// see through the vehicle. Glass, figures and back-side linings (rooms meant to be seen from inside) are fine to see.
const DIRS14 = [[1, 0.013, 0.007], [-1, 0.011, -0.009], [0.012, 1, 0.008], [-0.01, -1, 0.013], [0.009, 0.012, 1], [-0.011, 0.007, -1], [0.58, 0.57, 0.59], [-0.57, 0.58, 0.58], [0.59, -0.57, 0.57], [-0.58, -0.58, 0.57], [0.57, 0.58, -0.59], [-0.58, 0.57, -0.58], [0.58, -0.59, -0.57], [-0.57, -0.58, -0.59]].map((d) => V(...d).normalize()); // the six axes and eight diagonals
export function enclosed(soup, e) {
  const P = soup.p, e1 = V(), e2 = V(), pv = V(), tv = V(), qv = V(), n = V(); let backs = 0;
  for (const dir of DIRS14) {
    let best = Infinity, back = false;
    for (let i = 0, cnt = soup.glass.length; i < cnt; i++) {
      if (soup.glass[i] || soup.mesh[i].isSkinnedMesh) continue;
      _a.fromArray(P, i * 9); _b.fromArray(P, i * 9 + 3); _c.fromArray(P, i * 9 + 6);
      e1.subVectors(_b, _a); e2.subVectors(_c, _a); pv.crossVectors(dir, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-12) continue;
      const id = 1 / det; tv.subVectors(e, _a); const u = tv.dot(pv) * id; if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, e1); const w = dir.dot(qv) * id; if (w < 0 || u + w > 1) continue;
      const t = e2.dot(qv) * id; if (t <= 1e-5 || t > best + 1e-3) continue;
      const m = soup.mesh[i], side = (Array.isArray(m.material) ? m.material[0] : m.material)?.side ?? THREE.FrontSide;
      const bk = side === THREE.FrontSide && !soup.lined?.has(m) && (n.crossVectors(e1, e2).dot(dir) > 0) !== soup.flip[i]; // (a skin lined from inside is seen)
      if (t < best - 1e-3) { best = t; back = bk; } else { best = Math.min(best, t); back = back && bk; } // (coincident surfaces: the drawn one counts)
    }
    if (back) backs++;
    if (backs >= 10) return true;
    if (backs + DIRS14.length - 1 - DIRS14.indexOf(dir) < 10) return false; // (decided either way)
  }
  return false;
}
// push a point out to `c` from every surface near it
function pushOut(soup, e0, c) {
  const e = e0.clone();
  for (let it = 0; it < 16; it++) {
    const P = soup.p, push = V(); let n = 0;
    for (let i = 0, cnt = P.length / 9; i < cnt; i++) {
      if (far(soup.box, i, e, c)) continue;
      _a.fromArray(P, i * 9); _b.fromArray(P, i * 9 + 3); _c.fromArray(P, i * 9 + 6); _tri.set(_a, _b, _c);
      _tri.closestPointToPoint(e, _cp); const d = _cp.distanceTo(e); if (!(d < c)) continue; // (NaN: a degenerate triangle)
      const away = d > 1e-5 ? e.clone().sub(_cp).divideScalar(d) : _tri.getNormal(V()).multiplyScalar(e.clone().sub(_a).dot(_tri.getNormal(V())) >= 0 ? 1 : -1);
      push.addScaledVector(away, c - d); n++;
    }
    if (!n) break;
    if (push.length() > c) push.setLength(c);
    e.add(push.multiplyScalar(0.7));
  }
  return e;
}
// Move the eye clear of the meshes around it, then up (a seat adjusted up), within its cockpit, until it is out of
// anything solid and sees forward over the panel: a canopy a kid sank deep into a body raises its pilot's eye up into
// the glass.
function settle(st, soup, box, vbox) {
  const c = st.clear0, reach = 1.2 * st.s, e0 = st.eye.clone();
  let top = 0.16 * st.s; // how far up the seat may go: to the top of its cockpit, less the head room
  if (box) { const p = V(); for (let k = 0; k < 8; k++) { p.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z); top = Math.max(top, p.sub(e0).dot(st.up) - c); } }
  top = Math.min(top, 1.2 * st.s);
  let best = null;
  for (let h = 0, k = 0; h <= top + 1e-6 && k < 30; h += 0.03 * st.s, k++) {
    const e = pushOut(soup, e0.clone().addScaledVector(st.up, h), c);
    if (box && !box.containsPoint(e)) continue;
    const cand = { e, h, los: lineOfSight(soup, e, st.fwd, st.up, reach), shut: enclosed(soup, e), clear: closest(soup, e).d };
    (st.tried ||= []).push([+h.toFixed(2), cand.los, cand.shut, +cand.clear.toFixed(3)]); // (for tools/test)
    const score = (q) => (q.shut ? 0 : 100) + Math.min(q.los, 3) * 10 + Math.min(q.clear, c) / c; // (lower wins a tie)
    if (!best || score(cand) > score(best)) best = cand;
    if (!cand.shut && cand.los >= 3 && cand.clear >= c * 0.9) break; // the lowest good seat (a window post may hide a ray or two)
  }
  // a canopy sunk so deep into a body that there is no seat inside it that sees out: the head comes up out of it, as
  // far as the top of the vehicle (in 40 steps)
  if (best && (best.shut || best.los < 3)) {
    const roof = Math.max(top + 0.3 * st.s, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => V(k & 1 ? vbox.max.x : vbox.min.x, k & 2 ? vbox.max.y : vbox.min.y, k & 4 ? vbox.max.z : vbox.min.z).sub(e0).dot(st.up) + c));
    const step = Math.max(0.03 * st.s, (roof - top) / 40);
    for (let h = top + step; h <= roof + 1e-6; h += step) {
      const e = pushOut(soup, e0.clone().addScaledVector(st.up, h), c); if (enclosed(soup, e)) continue;
      const los = lineOfSight(soup, e, st.fwd, st.up, reach), clear = closest(soup, e).d;
      if (los >= 3 && clear >= c * 0.6) { best = { e, h, los, shut: false, clear }; st.buried = true; break; }
    }
  }
  if (best) { st.eye.copy(best.e); st.los = best.los; st.shut = best.shut; }
  st.clear = closest(soup, st.eye).d;
  st.near = THREE.MathUtils.clamp(st.clear * 0.5, 0.02, 0.2);
}

// Names: the first flying seat is the Pilot (Captain on an airliner's left seat, Driver in a car, the astronaut in a
// capsule); the others by what they are and where they sit from the pilot.
function nameStations(list, ac) {
  if (!list.length) return;
  const fwdOK = (s) => s.fwd.z < -0.7 && s.up.y > 0.5;
  const flying = list.filter((s) => s.role === 'pilot' && !s.noSeat);
  let P = flying.find(fwdOK) || flying[0] || list[0];
  const sameCk = list.filter((s) => s.part === P.part && s.role === 'pilot');
  if (P.kind === 'airline' && sameCk.length > 1) P = sameCk.reduce((a, b) => (b.eye.x < a.eye.x ? b : a)); // the captain sits on the left
  const box = new THREE.Box3(); for (const p of ac.parts) if (p.alive) box.expandByObject(p.obj);
  const len = box.max.z - box.min.z;
  const first = { airline: 'Captain', driver: 'Driver', space: 'Astronaut', heli: 'Pilot' };
  for (const s of list) {
    if (s === P) { s.name = s.bike ? 'Rider' : first[s.kind] || (s.noSeat && !s.part ? 'Nose camera' : 'Pilot'); continue; }
    const d = s.eye.clone().sub(P.eye), id = s.part ? s.part.p.id : '';
    if (s.part === P.part) s.name = s.role === 'crew' ? (s.kind === 'heli' ? 'Medic' : 'Passenger') : s.kind === 'airline' ? 'First officer' : 'Co-pilot';
    else if (id === 'ck_glassnose') s.name = 'Bomb aimer';
    else if (s.kind === 'driver') s.name = s.bike ? 'Rider' : 'Passenger';
    else if (s.fwd.z > 0.5) s.name = 'Tail gunner';
    else if (s.up.y < -0.3 || d.y < -0.8) s.name = 'Belly gunner';
    else if (Math.abs(d.z) < 1.5 && Math.abs(d.x) > 0.8 && Math.abs(d.y) < 0.6) s.name = s.role === 'crew' ? 'Passenger' : 'Co-pilot';
    else if (d.z < -1) s.name = 'Nose gunner';
    else if (s.eye.z > box.max.z - len * 0.2) s.name = 'Tail gunner';
    else if (d.z > 1) s.name = 'Top gunner';
    else s.name = 'Gunner';
  }
  const count = new Map(), k = new Map(); for (const s of list) count.set(s.name, (count.get(s.name) || 0) + 1);
  for (const s of list) if (count.get(s.name) > 1) { const n = (k.get(s.name) || 0) + 1; k.set(s.name, n); s.name += ' ' + n; } // Gunner 1, Gunner 2
  list.sort((a, b) => (a === P ? -1 : b === P ? 1 : 0));
}

// Build the stations of an Aircraft (after its visuals are assembled). Returns [{ name, part, crew, eye, q, fwd, up,
// s (seat scale), near, clear, los, buried }] in body (root) space, the pilot first.
export function buildStations(ac) {
  const root = ac.root; root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), list = [], made = new Map();
  for (const p of ac.parts) {
    const crews = []; p.obj.traverse((o) => { if (o.userData.crewRig?.eye) crews.push(o); });
    for (const c of crews) {
      const r = c.userData.crewRig, f = frameOf(c.matrixWorld, r.eye, inv);
      // a motorbike rider moves on the bike (bends over the tank, tucks, leans into turns): the eye follows the head
      const live = r.ctl === 'bars' ? new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld) : null;
      list.push({ part: p, crew: c, rig: r, role: r.role || 'pilot', kind: r.kind || 'light', bike: r.ctl === 'bars', live, ...f });
    }
    if (!crews.length && p.d.cat === 'cockpit' && p.d.eye) { // a cockpit without a seat (a glazed nose): its part's eye, looking ahead and down
      const f = frameOf(p.obj.matrixWorld, V(...p.d.eye), inv, -0.26);
      list.push({ part: p, crew: null, role: 'pilot', kind: 'light', noSeat: true, ...f });
    }
  }
  if (!list.length) { // no cockpit at all: a camera on top of the nose of the main body
    const body = ac.parts.find((p) => ['fuselage', 'cockpit'].includes(p.d.cat)) || ac.parts[0];
    if (body) {
      const b = new THREE.Box3().setFromObject(body.obj).applyMatrix4(inv);
      const e = V((b.min.x + b.max.x) / 2, b.max.y + 0.12, b.min.z + (b.max.z - b.min.z) * 0.22);
      list.push({ part: null, crew: null, role: 'pilot', kind: 'light', noSeat: true, eye: e, fwd: V(0, 0, -1), up: V(0, 1, 0), q: new THREE.Quaternion(), s: 1 });
    }
  }
  const vbox = new THREE.Box3(); for (const p of ac.parts) vbox.expandByObject(p.obj); vbox.applyMatrix4(inv);
  // a crew riding inside a round body (the Rocket's capsule) looks out from capsule.js's cabin: padded walls, its
  // windows, a panel; the body is swapped for it while you sit there. Its seat looks up the body, out of the nose windows.
  const cab = CapsuleView.for(ac);
  for (const st of list) if (cab && st.part === cab.part && st.crew) {
    const f = frameOf(cab.part.obj.matrixWorld, cab.L.eye, inv);
    Object.assign(st, f, { cabin: cab });
  }
  for (const st of list) {
    if (st.cabin) st.cabin.set(true); // (settled against the cabin it will see)
    st.eye0 = st.eye.clone();
    st.clear0 = THREE.MathUtils.clamp(0.07 * st.s, 0.035, 0.12);
    let soup = nearTriangles(root, st.eye, 4 * Math.max(1, st.s), st.crew);
    const lin = liningsOverGlass(soup, st.eye, st.s);
    st.linings = [...lin].map((mesh) => ({ mesh, inside: insideOf(mesh, st.eye, root, inv, made) }));
    if (lin.size) { soup = without(soup, (i) => lin.has(soup.mesh[i])); soup.lined = new Set(st.linings.flatMap((l) => l.inside.map((w) => w.parent))); }
    const box = st.part ? new THREE.Box3().setFromObject(st.part.obj).applyMatrix4(inv) : null;
    settle(st, soup, box, vbox);
    if (st.cabin) st.cabin.set(false);
    if (st.live) st.eyeRest = st.rig.eyeNow(V()).applyMatrix4(st.live); // (the rider's pose when it was settled)
  }
  nameStations(list, ac);
  return list;
}

// The station's eye now (body space): a rider's follows the head (keeping the seat's settling offset).
const _e = V();
export function stationEye(st, out = V()) {
  if (!st.live) return out.copy(st.eye);
  return out.copy(st.rig.eyeNow(_e).applyMatrix4(st.live)).add(st.eye).sub(st.eyeRest);
}

// First person at station `st` (or none): its own figure's head and torso go, everyone else stays.
export function showStation(list, st) {
  if (st === list.cur) return;
  for (const s of list) {
    s.rig?.firstPerson(s === st);
    for (const l of s.linings || []) { l.mesh.visible = true; for (const w of l.inside) w.visible = false; }
  }
  for (const l of st?.linings || []) { l.mesh.visible = false; for (const w of l.inside) w.visible = true; } // see out of the windows the lining covers
  for (const s of list) if (s.cabin && s.cabin !== st?.cabin) s.cabin.set(false);
  st?.cabin?.set(true);
  list.cur = st;
}
