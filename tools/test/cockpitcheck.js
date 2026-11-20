// Cockpit check (browser module, driven by cockpitcheck.py): builds every stock vehicle (as is, resized and mirrored),
// seeded random player builds (planes, cars, fittings, motorbikes) and multi-station builds (bombers with a glass nose,
// top, tail and belly gunner bubbles, twin cockpits, cars, capsules) as flight Aircraft, and checks every cockpit view (Aircraft.stations, stations.js):
//   1. the eye is inside its cockpit: within the box of its seat's part (canopy, nose, cab, capsule) and its figure,
//   2. the eye is not inside solid geometry: nothing within 3 cm of it, and it doesn't look out through the backs of
//      one-sided surfaces (10 of 14 directions first meet a back face: the head is buried in a body skin, a seat or a
//      panel, and the view would see through the vehicle),
//   3. there is a clear line of sight forward: of five rays straight ahead and a few degrees off it, at least three
//      meet glass first (with no wall right behind it), or nothing solid within 1.2 m (scaled with the seat) - not the
//      panel, a frame or the skin.
// It reads the meshes the way they are drawn from that seat (first person on: own head and torso gone, window
// linings swapped). Its ray tests are its own, not stations.js's. Visual only: physics is never touched.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { newPart, mirroredOf } from '../../src/design.js';
import { randomBuilds, fittingBuilds, bikeBuilds } from './meshcheck.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------- the meshes as seen from a seat: triangles in body (root) space, tagged by mesh ----------
function triangles(root, skip) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), out = [], v = V(), m = new THREE.Matrix4();
  const add = (o, mw) => {
    const g = o.geometry, P = g?.attributes?.position; if (!P) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const glass = !!(mat?.transparent && (mat.opacity ?? 1) < 0.75), lining = mat?.side === THREE.BackSide;
    m.multiplyMatrices(inv, mw);
    const T = new Float32Array(P.count * 3), flip = !o.isSkinnedMesh && m.determinant() < 0; // (a mirrored mesh's triangles wind the other way)
    for (let i = 0; i < P.count; i++) { if (o.isSkinnedMesh) o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld).applyMatrix4(inv); else v.fromBufferAttribute(P, i).applyMatrix4(m); T[i * 3] = v.x; T[i * 3 + 1] = v.y; T[i * 3 + 2] = v.z; }
    const idx = g.index, n = idx ? idx.count : P.count;
    for (let k = 0; k + 2 < n; k += 3) {
      const a = (idx ? idx.getX(k) : k) * 3, b = (idx ? idx.getX(k + 1) : k + 1) * 3, c = (idx ? idx.getX(k + 2) : k + 2) * 3;
      out.push({ a: V(T[a], T[a + 1], T[a + 2]), b: V(T[b], T[b + 1], T[b + 2]), c: V(T[c], T[c + 1], T[c + 2]), glass, lining, mesh: o, flip });
    }
  };
  const walk = (o) => {
    if (!o.visible || o === skip || o.userData.isDisc) return;
    if (o.isMesh) {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.blending !== THREE.AdditiveBlending) {
        if (o.isSkinnedMesh) o.skeleton?.update();
        if (o.isInstancedMesh) { const im = new THREE.Matrix4(); for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, im); add(o, new THREE.Matrix4().multiplyMatrices(o.matrixWorld, im)); } } else add(o, o.matrixWorld);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}
const near = (tris, e, R) => tris.filter((t) => Math.min(t.a.x, t.b.x, t.c.x) < e.x + R && Math.max(t.a.x, t.b.x, t.c.x) > e.x - R && Math.min(t.a.y, t.b.y, t.c.y) < e.y + R && Math.max(t.a.y, t.b.y, t.c.y) > e.y - R && Math.min(t.a.z, t.b.z, t.c.z) < e.z + R && Math.max(t.a.z, t.b.z, t.c.z) > e.z - R);
const ray = new THREE.Ray(), hit = V();
function hits(tris, o, d) { // every crossing along the ray: [{ t, tri }], nearest first
  ray.set(o, d); const out = [];
  for (const t of tris) if (ray.intersectTriangle(t.a, t.b, t.c, false, hit)) out.push({ t: hit.distanceTo(o), tri: t });
  return out.sort((x, y) => x.t - y.t);
}
function clearance(tris, e) { let d = Infinity; const tr = new THREE.Triangle(), p = V(); for (const t of tris) { tr.set(t.a, t.b, t.c); tr.closestPointToPoint(e, p); const k = p.distanceTo(e); if (k < d) d = k; } return d; }

// inside solid geometry: nearly every way (10 of 14 directions) the first surface met is the back of a one-sided
// (front-side) surface, which isn't drawn, so the view would see through the vehicle. Glass, figures and back-side
// linings (rooms seen from inside) are fine. Returns the material of the most-met back surface, or null.
const DIRS = [[1, 0.013, 0.007], [-1, 0.011, -0.009], [0.012, 1, 0.008], [-0.01, -1, 0.013], [0.009, 0.012, 1], [-0.011, 0.007, -1], [0.58, 0.57, 0.59], [-0.57, 0.58, 0.58], [0.59, -0.57, 0.57], [-0.58, -0.58, 0.57], [0.57, 0.58, -0.59], [-0.58, 0.57, -0.58], [0.58, -0.59, -0.57], [-0.57, -0.58, -0.59]].map((d) => V(...d).normalize()); // the six axes and eight diagonals
function shutIn(tris, e) {
  const solid = tris.filter((t) => !t.glass && !t.mesh.isSkinnedMesh), n = V(), by = new Map(); let backs = 0;
  for (const d of DIRS) {
    const hs = hits(solid, e, d); if (!hs.length) continue;
    const isBack = (t) => (Array.isArray(t.mesh.material) ? t.mesh.material[0] : t.mesh.material)?.side === THREE.FrontSide && (n.subVectors(t.b, t.a).cross(V().subVectors(t.c, t.a)).dot(d) > 0) !== t.flip;
    const first = hs.filter((h) => h.t < hs[0].t + 1e-3); // (coincident surfaces: a drawn one among them is what you see)
    if (first.every((h) => isBack(h.tri))) { backs++; by.set(first[0].tri.mesh, (by.get(first[0].tri.mesh) || 0) + 1); }
  }
  if (backs < 10) return null;
  const m = [...by].sort((a, b) => b[1] - a[1])[0][0]; return m.material?.name || m.material?.type || 'mesh';
}
// rays ahead (and 4 and 8 degrees off) that meet glass first, or nothing solid within 1.2 m (scaled)
function sight(tris, e, st, s) {
  const right = V().crossVectors(st.fwd, st.up).normalize(), reach = 1.2 * s; let clear = 0;
  for (const [yw, pt] of [[0, 0], [0, -0.07], [0.14, 0], [-0.14, 0], [0, 0.07]]) {
    const d = st.fwd.clone().applyAxisAngle(st.up, yw).applyAxisAngle(right, pt).normalize(), hs = hits(tris, e, d), h = hs[0];
    const wall = h?.tri.glass && hs.find((x) => !x.tri.glass && x.t < h.t + 0.1 * s); // glass with a wall right behind it is no window
    if (!h || (h.tri.glass && !wall) || h.t > reach) clear++;
  }
  return clear;
}

// ---------- multi-station and odd builds ----------
function stationBuilds() {
  const out = [], mk = (name, f) => { const parts = [], add = (id, pos, o = {}) => { parts.push(newPart(id, pos, o)); return parts.length - 1; }; f(add, parts); out.push({ name, parts }); };
  mk('bomber: glass nose, pilot, top, tail and belly gunners', (add, parts) => {
    const b = add('fus_cargo', [0, 0, 0]); // (r 2.5 m, z -7 to 9.6)
    add('ck_glassnose', [0, -0.4, -7.1], { parent: b });
    add('ck_bubble', [0, 2.45, -4.6], { parent: b });
    add('ck_bubble', [0, 2.6, 1.5], { parent: b });
    add('ck_bubble', [0, 1.9, 8.6], { parent: b, rot: [0, 180, 0] });
    add('ck_bubble', [0, -2.45, 0.4], { parent: b, rot: [0, 0, 180] });
    const w = add('w_taper', [2.3, 1.2, -0.5], { parent: b }); parts.push(mirroredOf(parts[w]));
  });
  mk('twin cockpits side by side (mirrored pair)', (add, parts) => {
    const b = add('fus_sport', [0, 0, 0]); const w = add('w_taper', [0.4, -0.2, -0.3], { parent: b }); parts.push(mirroredOf(parts[w]));
    const c = add('ck_fighter', [0.6, 0.45, -1.0], { parent: b }); parts.push(mirroredOf(parts[c]));
  });
  mk('big and small canopies (resized 1.6 / 0.6)', (add, parts) => {
    const b = add('fus_light', [0, 0, 0]);
    const i = add('ck_bubble', [0, 0.55, -1.2], { parent: b }); parts[i].scale = [1.6, 1.6, 1.6];
    const j = add('ck_open', [0, 0.45, 1.2], { parent: b }); parts[j].scale = [0.6, 0.6, 0.6];
  });
  mk('canopy turned 30 degrees and tipped', (add) => { const b = add('fus_sport', [0, 0, 0]); add('ck_bubble', [0.1, 0.55, -0.6], { parent: b, rot: [8, 30, 6] }); });
  mk('airliner nose on a cargo body, resized 0.7', (add, parts) => { const b = add('fus_cargo', [0, 0, 0]); const i = add('ck_airliner', [0, 0, -4.2], { parent: b }); parts[i].scale = [0.7, 0.7, 0.7]; });
  mk('heli cabin with its own seats (no bubble nose)', (add) => { const b = add('fus_heli', [0, 0, 0]); add('fus_boom', [0, 0.38, 4.6], { parent: b }); add('r_main', [0, 1.3, 0.6], { parent: b }); });
  mk('rocket capsule, mirrored', (add, parts) => { const b = add('fus_rocket', [0, 0, 0]); add('e_rocket', [0, 0, 5.2], { parent: b }); parts.forEach((p) => { p.mirror = !p.mirror; }); });
  mk('no cockpit at all', (add) => { const b = add('fus_pod', [0, 0, 0]); add('e_piston', [0, 0, -2.2], { parent: b }); });
  return out;
}
const resized = (d) => { const r = JSON.parse(JSON.stringify(d)); r.name = d.name + ' resized'; r.parts.forEach((q, i) => { q.scale = [[1.35, 1.35, 1.35], [0.8, 0.8, 0.8], [1.6, 1, 1.2]][i % 3]; }); return r; };
const mirrored = (d) => { const r = JSON.parse(JSON.stringify(d)); r.name = d.name + ' mirrored'; r.parts.forEach((q) => { q.pos[0] = -q.pos[0]; q.mirror = !q.mirror; q.quat = [q.quat[0], -q.quat[1], -q.quat[2], q.quat[3]]; }); return r; };

// ---------- one vehicle ----------
function check(design) {
  const ac = new Aircraft(design, REALISM.pilot || Object.values(REALISM)[0]);
  const root = ac.root; root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  // (main before stations.js: the one old eye point)
  const list = 'stations' in ac ? ac.stations : [{ name: 'eye', eye: ac.eyePoint(), fwd: V(0, 0, -1), up: V(0, 1, 0), s: 1, part: ac.parts.find((p) => p.alive && p.eye) || null }];
  const res = [];
  for (const st of list) {
    if (ac.setCockpitView && 'stations' in ac) ac.setCockpitView(st);
    const r = { name: st.name, part: st.part?.p.id || '-', at: [st.eye.x, st.eye.y, st.eye.z].map((v) => +v.toFixed(2)), issues: [] };
    if (![st.eye.x, st.eye.y, st.eye.z].every(Number.isFinite)) { r.issues.push('eye not finite'); res.push(r); continue; }
    const s = st.s || 1, all = triangles(root, st.crew || null), tris = near(all, st.eye, 3 * Math.max(1, s));
    // 1. inside the cockpit: the seat's part (with its figure). Only a cockpit buried in a body may put the eye above
    // it, and then this check confirms that there really was no seat in it that sees out: every point from the
    // figure's eyes up to the top of the cockpit is enclosed by a solid mesh or blind ahead.
    if (st.part) {
      const box = new THREE.Box3().setFromObject(st.part.obj).applyMatrix4(inv).expandByScalar(0.05);
      if (!box.containsPoint(st.eye)) {
        let room = null; const inner = box.clone().expandByScalar(-0.08);
        if (st.eye0) for (let h = 0; h < 1.5 * s; h += 0.04 * s) {
          const p = st.eye0.clone().addScaledVector(st.up, h); if (!inner.containsPoint(p)) break; // (a seat needs head room under the top)
          if (clearance(tris, p) > 0.04 && !shutIn(near(all, p, 3 * Math.max(1, s)), p) && sight(tris, p, st, s) >= 3) { room = p; break; }
        }
        if (room) r.issues.push(`outside its cockpit (${st.part.p.id}), though ${room.toArray().map((v) => v.toFixed(2))} inside it sees out`);
        else r.note = 'cockpit buried in the body: eye above it';
      }
    }
    // 2. not in solid geometry
    const cl = clearance(tris, st.eye); r.clear = +cl.toFixed(3);
    if (cl < 0.03) r.issues.push(`${(cl * 100).toFixed(1)} cm from a surface`);
    const inside = shutIn(tris, st.eye);
    if (inside) r.issues.push(`inside a closed mesh (${inside})`);
    // 3. forward line of sight out of the glass
    const clear = sight(tris, st.eye, st, s);
    r.los = clear; if (clear < 3) r.issues.push(`forward view blocked (${clear}/5 rays clear)`);
    res.push(r);
  }
  if ('stations' in ac) ac.setCockpitView(null);
  return res;
}

// every design the check builds (also handy to fly one: hangar.load(designs(__sky.presets).find(...)))
export function designs(presets, random = 20, seed = 7) {
  const out = [];
  for (const p of presets) out.push(p, resized(p), mirrored(p));
  out.push(...stationBuilds(), ...randomBuilds(random, seed), ...fittingBuilds(12, seed + 24), ...bikeBuilds(8, seed + 64));
  return out;
}
export function run({ presets, random = 20, seed = 7 } = {}) {
  const out = [];
  for (const d of designs(presets, random, seed)) {
    try { out.push({ name: d.name, stations: check(d) }); } catch (e) { out.push({ name: d.name, error: String(e.stack || e) }); }
  }
  return out;
}
