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

export async function run({ presets = [], random = 20, fittings = 12 } = {}) {
  const designs = [...presets, ...randomBuilds(random), ...fittingBuilds(fittings)], report = [];
  for (const d of designs) {
    const root = new THREE.Group(); let res;
    try {
      const det = buildDesign(d, root, { quick: false, near: true }); root.updateMatrixWorld(true);
      const open = [];
      det.parts.forEach((o, i) => { if (!o || SKIP_CATS.has(PARTS[d.parts[i].id]?.cat)) return; o.traverse((m) => { if (skipMesh(m)) return; for (const s of openShells(m)) open.push({ part: d.parts[i].id, mat: m.material.name || m.material.type, ...s }); }); });
      res = { name: d.name, open, exhaust: exhaustHits(root), nav: navLightIssues(d, det, root) };
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
