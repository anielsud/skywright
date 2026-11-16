// Mesh check (browser module, driven by meshcheck.py): builds the stock vehicles plus seeded random player builds the
// way the hangar does (detail parts + assembly pass) and looks for
//   1. open shells: a connected, non-flat piece of an opaque one-sided mesh with a boundary loop big enough to look
//      into (a duct, nozzle, tyre or cowl with no inside surface, or a missing end cap). Flat sheets (dials, decals,
//      mouths) and DoubleSide/transparent/additive materials are fine; a mesh may opt out with userData.openOk = 'why'.
//   2. exhausts through glass: every car-engine exhaust path (userData.exhaustPaths, world space) against every glass
//      mesh of the same vehicle.
// Everything is visual only; it never touches physics.
import * as THREE from 'three';
import { PARTS } from '../../src/parts.js';
import { newPart, mirroredOf } from '../../src/design.js';
import { partInfo } from '../../src/parts.js';
import { buildDesign } from '../../src/hangar.js';

const MIN_LOOP = 0.3; // metres of boundary: a smaller hole (a 5 cm tube end, a wire) is too small to look into
const SKIP_CATS = new Set(['gear']); // landing gear, floats and skids: their builders are being reworked separately (TODO: include)

// ---------- seeded random player builds ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const ENGINES = ['e_piston', 'e_radial', 'e_turboprop', 'e_electric', 'e_jet_small', 'e_jet_ab', 'e_turbofan', 'e_rocket'];
const BODIES = ['fus_light', 'fus_sport', 'fus_fighter', 'fus_airliner', 'fus_pod', 'fus_glider', 'fus_cargo', 'fus_buggy', 'fus_truck', 'fus_heli', 'fus_rocket'];
const CANOPIES = ['ck_bubble', 'ck_fighter', 'ck_open'];
export function randomBuilds(n = 20, seed = 7) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [];
  for (let k = 0; k < n; k++) {
    const body = BODIES[k % BODIES.length], parts = [], add = (id, pos, o = {}) => { parts.push(newPart(id, pos, o)); return parts.length - 1; };
    const f = add(body, [0, 0, 0]);
    const car = body === 'fus_buggy' || body === 'fus_truck' || R() < 0.2;
    const sc = () => { const s = 0.75 + R() * 0.7; return R() < 0.5 ? [s, s, s] : [0.8 + R() * 0.6, 0.8 + R() * 0.6, 0.8 + R() * 0.6]; };
    // a canopy somewhere along the top (sometimes far forward, sometimes off-centre)
    { const i = add(pick(CANOPIES), [R() < 0.25 ? (R() - 0.5) * 0.4 : 0, 0.35 + R() * 0.4, -2.5 + R() * 3], { parent: f }); if (R() < 0.4) parts[i].scale = sc(); }
    // engines: one on the nose or tail, a pair on the sides
    { const id = pick(ENGINES), i = add(id, [0, (R() - 0.5) * 0.3, R() < 0.6 ? -3.2 - R() : 2.5 + R()], { parent: f, color: 0xc8102e }); if (R() < 0.5) parts[i].scale = sc(); }
    { const id = pick(ENGINES), x = 0.8 + R() * 1.5, y = (R() - 0.5) * 1.2, z = -1.5 + R() * 3, i = add(id, [x, y, z], { parent: f }); if (R() < 0.5) parts[i].scale = sc(); parts.push(mirroredOf(parts[i])); }
    if (!car && R() < 0.7) { const i = add('w_taper', [0.4, -0.2, -0.3], { parent: f }); parts.push(mirroredOf(parts[i])); }
    if (car) {
      add('c_motor', [0, 0.3 + R() * 0.5, (R() - 0.5) * 3], { parent: f });
      const w = pick(['c_bigfoot', 'c_offroad_steer', 'c_monster', 'c_wheel']);
      for (const z of [-1.6, 1.6]) { const i = add(w, [1.2 + R() * 0.3, 0, z], { parent: f }); parts.push(mirroredOf(parts[i])); }
      if (R() < 0.5) add('c_rollcage', [0, 0.3, 0], { parent: f });
    }
    if (R() < 0.5) { const i = add('x_tank', [1.2, -0.6, 0.5], { parent: f }); parts.push(mirroredOf(parts[i])); }
    // whole-design variants: resized, mirrored
    if (k % 3 === 1) parts.forEach((p) => { if (!p.scale) p.scale = [1.3, 1.3, 1.3]; });
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `random ${k} (${body})`, parts });
  }
  return out;
}

// Fittings and bodies dropped anywhere (part polish): greenhouse noses, position and landing lights, pylons with stores,
// electric fans, cargo and heli cabins (with and without a Bubble Nose), monster tyres. Random spots, rotations and
// sizes; every third build mirrored.
const FITTINGS = ['x_navlight', 'x_landlight', 'x_pylon', 'e_electric', 'ck_glassnose', 'x_navlight'];
export function fittingBuilds(n = 12, seed = 31) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [], rot = () => [Math.round((R() - 0.5) * 120), Math.round((R() - 0.5) * 180), Math.round((R() - 0.5) * 120)];
  const bodies = ['fus_cargo', 'fus_heli', 'fus_light', 'fus_pod', 'fus_buggy'];
  for (let k = 0; k < n; k++) {
    const body = bodies[k % bodies.length], parts = [], add = (id, pos, o = {}) => { parts.push(newPart(id, pos, o)); return parts.length - 1; };
    const f = add(body, [0, 0, 0]);
    if (body === 'fus_heli' && R() < 0.5) add('ck_heli', [0, 0, -1.05], { parent: f });
    if (body === 'fus_heli') add('fus_boom', [0, 0.38, 4.6], { parent: f });
    if (body === 'fus_buggy') { for (const z of [-1.35, 1.35]) { const i = add(pick(['c_bigfoot', 'c_offroad', 'c_monster', 'c_wheel']), [1.1, 0, z], { parent: f }); parts.push(mirroredOf(parts[i])); } add('ck_open', [0, 0.36, -0.1], { parent: f }); }
    if (body !== 'fus_buggy' && body !== 'fus_heli') { const w = add('w_taper', [0.4, 0, -0.3], { parent: f }); parts.push(mirroredOf(parts[w])); const pl = add('x_pylon', [2.2, -0.12, -0.3], { parent: w }); add(pick(['x_tank', 'e_jet_small']), [2.2, -1.2, -0.3], { parent: pl }); }
    for (let j = 0; j < 4; j++) {
      const id = pick(FITTINGS), x = R() < 0.3 ? 0 : (R() - 0.5) * 3, i = add(id, [x, (R() - 0.3) * 2, -3 + R() * 6], { parent: f, rot: R() < 0.6 ? rot() : undefined });
      if (R() < 0.4) { const s = 0.6 + R() * 0.9; parts[i].scale = [s, s, s]; }
      if (Math.abs(x) > 0.05 && R() < 0.6) parts.push(mirroredOf(parts[i]));
    }
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `fittings ${k} (${body})`, parts });
  }
  return out;
}

// ---------- random car builds (dropped the way the hangar places parts) ----------
// A body, four wheels of a random kind dropped from below (5 cm into what they hit), a car engine, sometimes a roll
// cage, a light bar (on the cage or the roof) and a rear wing dropped from above (resting on the surface the way the
// hangar seats a part by its bounding box). Some parts resized, some whole builds resized or mirrored.
const CAR_BODIES = ['fus_buggy', 'fus_truck', 'fus_pod', 'fus_light', 'fus_cargo', 'fus_buggy', 'fus_truck', 'fus_sport'];
const CAR_WHEELS = [['c_wheel_steer', 'c_wheel'], ['c_offroad_steer', 'c_offroad'], ['c_bigfoot', 'c_bigfoot'], ['c_monster', 'c_monster'], ['c_offroad_steer', 'c_bigfoot'], ['c_wheel_steer', 'c_offroad']];
export function carBuilds(n = 12, seed = 53) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [], snap = (v) => Math.round(v * 20) / 20;
  for (let k = 0; k < n; k++) {
    const parts = [], add = (p) => (parts.push(p), parts.length - 1);
    const body = CAR_BODIES[k % CAR_BODIES.length], f = add(newPart(body, [0, 0, 0]));
    if (R() < 0.35) { const d = 0.8 + R() * 0.5, l = 0.8 + R() * 0.5; parts[f].scale = [d, d, l]; }
    const built = () => { const root = new THREE.Group(), det = buildDesign({ parts }, root, { quick: true, near: false }); root.updateMatrixWorld(true); const all = []; det.parts.forEach((o, i) => o?.traverse((m) => { if (m.isMesh && !m.material.transparent && !m.userData.isDisc && !m.isInstancedMesh) { m.userData._pi = i; all.push(m); } })); return { root, all, box: new THREE.Box3().setFromObject(root) }; };
    const drop = (id, x, z, fromBelow, o = {}) => { // (a miss on a narrow tail or nose: the kid taps further in)
      const { root, all, box } = built(), rc = new THREE.Raycaster(); let h = null;
      for (const k of [1, 0.75, 0.5, 0.3, 0]) for (const kz of [1, 0.8, 0.6]) {
        if (h) break; rc.set(new THREE.Vector3(x * k, fromBelow ? box.min.y - 2 : box.max.y + 2, z * kz), new THREE.Vector3(0, fromBelow ? 1 : -1, 0)); h = rc.intersectObjects(all, false)[0];
      }
      root.traverse((m) => m.geometry?.dispose?.()); if (!h) return -1;
      const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize(), info = partInfo(id), pos = h.point.clone();
      if (PARTS[id].attach === 'gear') pos.addScaledVector(nrm, -0.05);
      else { const c = info.center, hh = info.size.clone().multiplyScalar(0.5); pos.addScaledVector(nrm, (Math.abs(nrm.x) * hh.x + Math.abs(nrm.y) * hh.y + Math.abs(nrm.z) * hh.z) * 0.9).sub(c); }
      pos.set(Math.abs(pos.x) < 0.15 ? 0 : snap(pos.x), snap(pos.y), snap(pos.z));
      const p = newPart(id, pos.toArray(), { parent: h.object.userData._pi }); if (o.scale) p.scale = o.scale;
      const i = add(p); if (Math.abs(p.pos[0]) > 0.12) add({ ...mirroredOf(p), parent: p.parent }); return i;
    };
    const bb = built().box, L = bb.max.z - bb.min.z, [wf, wr] = pick(CAR_WHEELS), ws = R() < 0.35 ? (() => { const s = +(0.7 + R() * 0.7).toFixed(2); return [s, s, s]; })() : undefined;
    const wx = bb.max.x * (0.55 + R() * 0.35);
    drop(wf, wx, bb.min.z + L * (0.14 + R() * 0.12), true, { scale: ws });
    drop(wr, wx, bb.max.z - L * (0.14 + R() * 0.12), true, { scale: ws });
    drop('c_motor', 0, bb.min.z + L * (R() < 0.5 ? 0.2 + R() * 0.15 : 0.65 + R() * 0.15), false);
    if (R() < 0.6) drop('c_rollcage', 0, bb.min.z + L * (0.4 + R() * 0.2), false, R() < 0.3 ? { scale: [1.2, 1.2, 1.2] } : {});
    if (R() < 0.6) drop('c_lightbar', 0, bb.min.z + L * (0.35 + R() * 0.2), false);
    if (R() < 0.5) drop('c_rearwing', 0, bb.max.z - L * (0.08 + R() * 0.1), false);
    if (k % 3 === 1) parts.forEach((p) => { p.scale = (p.scale || [1, 1, 1]).map((v) => v * 1.25); p.pos = p.pos.map((v) => v * 1.25); });
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `car ${k} (${body}, ${wf}/${wr})`, parts });
  }
  return out;
}

// ---------- floating parts ----------
// Every piece of a car (each connected piece of every mesh: a merged mesh holds many, an instanced link is one per
// instance) must touch, or come within `tol` of, another piece, and all of them must hang together as one vehicle:
// a piece (or a group of pieces) not connected to the main body is floating. Touch = a vertex within tol of the other's
// triangle, or an edge through it. Crew (skinned, posed at runtime), prop discs and glows are left out.
const _tri = new THREE.Triangle(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _h = new THREE.Vector3(), _s = new THREE.Vector3(), _qq = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function segTri(p0, p1, a, b, c) { // segment p0-p1 through triangle abc?
  _e1.subVectors(b, a); _e2.subVectors(c, a); const d = _q.subVectors(p1, p0); _h.crossVectors(d, _e2); const det = _e1.dot(_h);
  if (Math.abs(det) < 1e-12) return false; const f = 1 / det; _s.subVectors(p0, a); const u = f * _s.dot(_h); if (u < 0 || u > 1) return false;
  _qq.crossVectors(_s, _e1); const v = f * d.dot(_qq); if (v < 0 || u + v > 1) return false; const t = f * _e2.dot(_qq); return t >= 0 && t <= 1;
}
const vtx = (T, i, k, out) => out.set(T[i * 9 + k * 3], T[i * 9 + k * 3 + 1], T[i * 9 + k * 3 + 2]);
function triTouch(TA, i, TB, j, tol) {
  const A = [vtx(TA, i, 0, new THREE.Vector3()), vtx(TA, i, 1, new THREE.Vector3()), vtx(TA, i, 2, new THREE.Vector3())], B = [vtx(TB, j, 0, _a), vtx(TB, j, 1, _b), vtx(TB, j, 2, _c)];
  _tri.set(B[0], B[1], B[2]); for (const v of A) if (_tri.closestPointToPoint(v, _p).distanceToSquared(v) <= tol * tol) return true;
  _tri.set(A[0], A[1], A[2]); for (const v of B) if (_tri.closestPointToPoint(v, _p).distanceToSquared(v) <= tol * tol) return true;
  for (let e = 0; e < 3; e++) { if (segTri(A[e], A[(e + 1) % 3], B[0], B[1], B[2]) || segTri(B[e], B[(e + 1) % 3], A[0], A[1], A[2])) return true; }
  return false;
}
function pieces(mesh, W, out) {
  const g = mesh.geometry, P = g.attributes.position, idx = g.index ? g.index.array : null, nt = (idx ? idx.length : P.count) / 3, v = new THREE.Vector3();
  const wp = new Float32Array(P.count * 3), key = new Map(), id = new Int32Array(P.count);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(W); wp.set([v.x, v.y, v.z], i * 3); const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`; let j = key.get(k); if (j === undefined) key.set(k, j = key.size); id[i] = j; }
  const par = new Int32Array(key.size).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let t = 0; t < nt; t++) { const a = id[idx ? idx[t * 3] : t * 3], b = id[idx ? idx[t * 3 + 1] : t * 3 + 1], c = id[idx ? idx[t * 3 + 2] : t * 3 + 2]; par[find(a)] = find(b); par[find(b)] = find(c); }
  const groups = new Map();
  for (let t = 0; t < nt; t++) { const r = find(id[idx ? idx[t * 3] : t * 3]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  for (const ts of groups.values()) {
    const T = new Float32Array(ts.length * 9), box = new THREE.Box3();
    ts.forEach((t, n) => { for (let k = 0; k < 3; k++) { const vi = idx ? idx[t * 3 + k] : t * 3 + k; T.set(wp.subarray(vi * 3, vi * 3 + 3), n * 9 + k * 3); box.expandByPoint(v.set(wp[vi * 3], wp[vi * 3 + 1], wp[vi * 3 + 2])); } });
    out.push({ T, box, mesh });
  }
}
function touches(A, B, tol) {
  const reg = A.box.clone().expandByScalar(tol).intersect(B.box.clone().expandByScalar(tol)); if (reg.isEmpty()) return false;
  const sel = (C) => { const o = [], b = new THREE.Box3(), v = new THREE.Vector3(); for (let i = 0; i < C.T.length / 9; i++) { b.makeEmpty(); for (let k = 0; k < 3; k++) b.expandByPoint(vtx(C.T, i, k, v)); b.expandByScalar(tol); if (b.intersectsBox(reg)) o.push([i, b.clone()]); } return o; };
  const a = sel(A), b = sel(B); if (!a.length || !b.length) return false;
  const size = reg.getSize(new THREE.Vector3()), cell = Math.max(0.02, Math.max(size.x, size.y, size.z) / 24), grid = new Map(), ck = (x, y, z) => `${x},${y},${z}`;
  const cells = (bx, f) => { for (let x = Math.floor(bx.min.x / cell); x <= Math.floor(bx.max.x / cell); x++) for (let y = Math.floor(bx.min.y / cell); y <= Math.floor(bx.max.y / cell); y++) for (let z = Math.floor(bx.min.z / cell); z <= Math.floor(bx.max.z / cell); z++) f(ck(x, y, z)); };
  for (const [j, bx] of b) cells(bx, (k) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push([j, bx]); });
  for (const [i, bx] of a) { let hit = false; const seen = new Set(); cells(bx, (k) => { if (hit) return; for (const [j, by] of grid.get(k) || []) { if (seen.has(j)) continue; seen.add(j); if (bx.intersectsBox(by) && triTouch(A.T, i, B.T, j, tol)) { hit = true; return; } } }); if (hit) return true; }
  return false;
}
export function floatingParts(root, det, design, { tol = 0.01 } = {}) {
  root.updateMatrixWorld(true);
  const comps = [], shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; }, M4 = new THREE.Matrix4();
  root.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || m.userData.decal || !shown(m)) return; // (decals: stickers a few mm off the skin)
    const mt = m.material; if (!mt || Array.isArray(mt) || mt.blending === THREE.AdditiveBlending || mt.colorWrite === false) return;
    if (m.isInstancedMesh) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, M4); pieces(m, M4.clone().premultiply(m.matrixWorld), comps); }
    else pieces(m, m.matrixWorld, comps);
  });
  const par = comps.map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const order = comps.map((_, i) => i).sort((a, b) => comps[a].box.min.x - comps[b].box.min.x);
  for (let oi = 0; oi < order.length; oi++) {
    const A = comps[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const B = comps[order[oj]]; if (B.box.min.x > A.box.max.x + tol) break;
      if (find(order[oi]) === find(order[oj])) continue;
      if (touches(A, B, tol)) par[find(order[oi])] = find(order[oj]);
    }
  }
  const sets = new Map(); comps.forEach((c, i) => { const r = find(i); sets.set(r, (sets.get(r) || 0) + c.T.length); });
  const main = [...sets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const partOf = (m) => { for (let o = m; o; o = o.parent) { const i = det.parts.indexOf(o); if (i >= 0) return `#${i} ${design.parts[i].id}`; } return 'assembly'; };
  const out = new Map();
  comps.forEach((c, i) => {
    if (find(i) === main) return;
    const k = partOf(c.mesh) + ' ' + (c.mesh.material.name || c.mesh.material.type) + ' #' + (c.mesh.material.color?.getHexString?.() || '') + (c.mesh.isInstancedMesh ? ' (link)' : '');
    const sz = c.box.getSize(new THREE.Vector3()).length();
    if (!out.has(k)) out.set(k, { what: k, n: 0, size: 0, at: null });
    const o = out.get(k); o.n++; if (sz > o.size) { o.size = +sz.toFixed(3); o.at = c.box.getCenter(new THREE.Vector3()).toArray().map((x) => +x.toFixed(2)); }
  });
  return { pieces: comps.length, floating: [...out.values()] };
}
// pose every car corner: wheels pushed up by `comp` of their travel, steered wheels turned `steer` rad; rigs follow
export function poseCar(det, comp, steer) {
  for (const o of det.parts) { const u = o?.userData; if (!u?.corner) continue; u.wheels.position.y = -u.corner.len * (1 - comp); u.wheels.rotation.y = u.steer ? steer : 0; u.wheelsFixed.position.copy(u.wheels.position); u.wheelsFixed.rotation.y = u.wheels.rotation.y; }
  det.rig?.update();
}
export const isCarDesign = (d) => d.parts.some((p) => PARTS[p.id]?.cat === 'car' || p.id === 'fus_buggy' || p.id === 'fus_truck');

// ---------- position lights ----------
// Every detailed position light shows its side's colour (red left, green right, white on the centreline: aircraft.js's
// rule) and its teardrop head points along the flight direction, flattened onto its mount.
function navLightIssues(design, det, root) {
  const out = [], inv = root.matrixWorld.clone().invert(), fw = new THREE.Vector3(0, 0, -1).transformDirection(root.matrixWorld);
  det.parts.forEach((o, i) => {
    const u = o?.userData; if (!u?.navLens) return;
    const x = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv).x, want = x < -0.5 ? 0xff2020 : x > 0.5 ? 0x20ff40 : 0xffffff;
    if (u.navLens.material.color.getHex() !== new THREE.Color(want).getHex()) out.push({ part: i, issue: 'lens colour' });
    const up = new THREE.Vector3(0, 1, 0).transformDirection(o.matrixWorld), f = fw.clone().addScaledVector(up, -fw.dot(up));
    const head = new THREE.Vector3(0, 0, -1).transformDirection(u.navHead.matrixWorld);
    if (f.lengthSq() > 0.01 && head.dot(f.normalize()) < 0.97) out.push({ part: i, issue: 'head not facing the airflow', dot: +head.dot(f).toFixed(3) });
  });
  return out;
}

// ---------- open shells ----------
const skipMesh = (m) => {
  const mt = m.material;
  return !m.isMesh || m.isSkinnedMesh || !m.visible || m.userData.isDisc || m.userData.cosmetic || m.userData.planeLight || m.userData.openOk ||
    !mt || Array.isArray(mt) || mt.transparent || mt.side !== THREE.FrontSide || mt.blending !== THREE.NormalBlending || mt.colorWrite === false;
};
// visible-from-inside holes of one geometry, in world metres (welded positions, connected pieces)
export function openShells(mesh) {
  const g = mesh.geometry, P = g.attributes.position, n = P.count, W = mesh.matrixWorld, v = new THREE.Vector3();
  const key = new Map(), id = new Int32Array(n), wp = [];
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(W); const k = `${Math.round(v.x * 2000)},${Math.round(v.y * 2000)},${Math.round(v.z * 2000)}`;
    let j = key.get(k); if (j === undefined) { j = wp.length; key.set(k, j); wp.push(v.clone()); } id[i] = j;
  }
  const idx = g.index ? g.index.array : null, nt = (idx ? idx.length : n) / 3, edges = new Map(), par = new Int32Array(wp.length).map((_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let t = 0; t < nt; t++) {
    const a = id[idx ? idx[t * 3] : t * 3], b = id[idx ? idx[t * 3 + 1] : t * 3 + 1], c = id[idx ? idx[t * 3 + 2] : t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = x < y ? x * 1e7 + y : y * 1e7 + x; edges.set(k, (edges.get(k) || 0) + 1); }
    par[find(a)] = find(b); par[find(b)] = find(c);
  }
  const comp = new Map(); // root -> { boundary length, points }
  for (const [k, c] of edges) {
    if (c !== 1) continue;
    const a = Math.floor(k / 1e7), b = k % 1e7, r = find(a);
    if (!comp.has(r)) comp.set(r, { len: 0 }); comp.get(r).len += wp[a].distanceTo(wp[b]);
  }
  const out = [];
  for (const [r, c] of comp) {
    if (c.len < MIN_LOOP) continue;
    // flat sheet? (all points of the piece within 1 % of its size of one plane)
    const pts = []; for (let i = 0; i < wp.length; i++) if (find(i) === r) pts.push(wp[i]);
    const box = new THREE.Box3().setFromPoints(pts), size = box.getSize(new THREE.Vector3()).length();
    const ctr = box.getCenter(new THREE.Vector3()); let nrm = null;
    for (let i = 0; i < pts.length && !nrm; i += Math.max(1, Math.floor(pts.length / 40))) for (let j = i + 1; j < pts.length && !nrm; j += Math.max(1, Math.floor(pts.length / 40))) {
      const c2 = new THREE.Vector3().subVectors(pts[i], ctr).cross(new THREE.Vector3().subVectors(pts[j], ctr)); if (c2.length() > size * size * 0.02) nrm = c2.normalize();
    }
    const flat = nrm && pts.every((p) => Math.abs(new THREE.Vector3().subVectors(p, ctr).dot(nrm)) < size * 0.01 + 1e-3);
    if (!flat) out.push({ loop: +c.len.toFixed(2), size: +size.toFixed(2), at: ctr.toArray().map((x) => +x.toFixed(2)) });
  }
  return out;
}

// ---------- exhausts through glass ----------
function exhaustHits(root) {
  const glass = [], paths = [], hits = [];
  root.traverse((m) => { if (m.isMesh && m.material?.transparent && m.material.blending !== THREE.AdditiveBlending && !m.userData.isDisc) glass.push(m); if (m.userData.exhaustPaths) paths.push(...m.userData.exhaustPaths); });
  const rc = new THREE.Raycaster();
  for (const path of paths) for (let i = 0; i < path.length - 1; i++) {
    const a = new THREE.Vector3(...path[i]), b = new THREE.Vector3(...path[i + 1]), d = b.clone().sub(a), L = d.length(); if (L < 1e-4) continue;
    rc.set(a, d.normalize()); rc.far = L;
    const h = rc.intersectObjects(glass, false); if (h.length) hits.push({ at: h[0].point.toArray().map((x) => +x.toFixed(2)) });
  }
  return { paths: paths.length, hits };
}

export async function run({ presets = [], random = 20, fittings = 12, cars = 16, floatOnly = false } = {}) {
  const cb = carBuilds(cars), designs = [...presets, ...randomBuilds(random), ...fittingBuilds(fittings), ...cb], report = [];
  // floating parts: the stock cars and the car builds placed the way the hangar places parts (randomBuilds puts engines
  // at fixed spots that can be in mid-air on a short body, which the hangar never does)
  const floatCheck = new Set([...presets.filter(isCarDesign), ...cb]);
  for (const d of designs) {
    const root = new THREE.Group(); let res;
    try {
      const det = buildDesign(d, root, { quick: false, near: true }); root.updateMatrixWorld(true);
      const open = [];
      det.parts.forEach((o, i) => { if (!o || SKIP_CATS.has(PARTS[d.parts[i].id]?.cat)) return; o.traverse((m) => { if (skipMesh(m)) return; for (const s of openShells(m)) open.push({ part: d.parts[i].id, mat: m.material.name || m.material.type, ...s }); }); });
      res = { name: d.name, open, exhaust: exhaustHits(root), nav: navLightIssues(d, det, root) };
      if (floatCheck.has(d)) { // no floating parts: at rest, and with the wheels pushed up and steered (the rig must follow)
        const rest = floatingParts(root, det, d); poseCar(det, 0.6, 0.45); const moved = floatingParts(root, det, d); poseCar(det, 0, 0);
        res.floating = rest.floating; res.floatingMoved = moved.floating; res.pieces = rest.pieces;
      }
    } catch (e) { res = { name: d.name, error: String(e && e.stack || e) }; }
    root.traverse((m) => m.geometry?.dispose?.());
    report.push(res);
  }
  return report;
}
// one part on its own (detail build, no assembly): which of its meshes are open, for debugging
export function probe(id) {
  const o = PARTS[id].build(PARTS[id].color, { detail: 2 }); o.updateMatrixWorld(true); const out = [];
  o.traverse((m) => { if (skipMesh(m)) return; for (const s of openShells(m)) out.push({ geo: m.geometry.type, nv: m.geometry.attributes.position.count, mat: m.material.type, color: m.material.color?.getHexString(), ...s }); });
  return out;
}
export { PARTS };
