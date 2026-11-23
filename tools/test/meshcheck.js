// Mesh check (browser module, driven by meshcheck.py): builds the stock vehicles plus seeded random player builds the
// way the hangar does (detail parts + assembly pass) and looks for
//   1. open shells: a connected, non-flat piece of an opaque one-sided mesh with a boundary loop big enough to look
//      into (a duct, nozzle, tyre or cowl with no inside surface, or a missing end cap). Flat sheets (dials, decals,
//      mouths) and DoubleSide/transparent/additive materials are fine; a mesh may opt out with userData.openOk = 'why'.
//   2. exhausts through glass: every car-engine exhaust path (userData.exhaustPaths, world space) against every glass
//      mesh of the same vehicle.
//   3. floating parts (floatingParts below): on every stock vehicle, the random builds re-placed the way the hangar
//      places parts, and the random car builds.
// Everything is visual only; it never touches physics.
import * as THREE from 'three';
import { PARTS } from '../../src/parts.js';
import { newPart, mirroredOf } from '../../src/design.js';
import { partInfo } from '../../src/parts.js';
import { buildDesign, placePart } from '../../src/hangar.js';

const MIN_LOOP = 0.3; // metres of boundary: a smaller hole (a 5 cm tube end, a wire) is too small to look into
const SKIP_CATS = new Set(['gear']); // landing gear, floats and skids: their builders are being reworked separately (TODO: include)

// ---------- seeded random player builds ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const ENGINES = ['e_piston', 'e_radial', 'e_turboprop', 'e_electric', 'e_jet_small', 'e_jet_ab', 'e_turbofan', 'e_rocket'];
const BODIES = ['fus_light', 'fus_sport', 'fus_fighter', 'fus_airliner', 'fus_pod', 'fus_glider', 'fus_cargo', 'fus_buggy', 'fus_truck', 'fus_heli', 'fus_rocket'];
const CANOPIES = ['ck_bubble', 'ck_fighter', 'ck_open'];
// placed: every part is dropped onto the vehicle the way the hangar places a tapped part (hangarDrop below) instead
// of sitting at its fixed spot, so nothing starts out in mid-air: the floating-parts check runs on these.
export function randomBuilds(n = 20, seed = 7, { placed = false } = {}) {
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
    if (placed) { const P = placeAll(parts); parts.length = 0; parts.push(...P); }
    // whole-design variants: resized, mirrored
    if (k % 3 === 1) parts.forEach((p) => { if (!p.scale) p.scale = [1.3, 1.3, 1.3]; });
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `${placed ? 'placed' : 'random'} ${k} (${body})`, parts });
  }
  return out;
}

// ---------- placing parts the way the hangar does ----------
// The hangar puts a tapped part where the tap's ray meets the vehicle (Hangar.placement -> placePart, used here as is):
// the part it hit becomes its parent, and with symmetry on a mirrored copy goes on the partner.
function builtMeshes(parts) {
  const root = new THREE.Group(), det = buildDesign({ parts }, root, { quick: true, near: false }); root.updateMatrixWorld(true); const all = [];
  det.parts.forEach((o, i) => o?.traverse((m) => { if (m.isMesh && m.visible && !m.userData.isDisc && !m.isInstancedMesh) { m.userData._pi = i; all.push(m); } })); // (glass too: Hangar.pick hits it)
  return { root, all, box: new THREE.Box3().setFromObject(root) };
}
// rays: [[origin, dir], ...] tried in order; the first hit places the part. Returns the new part's index or -1.
export function hangarDrop(parts, id, rays, o = {}) {
  const { root, all } = builtMeshes(parts), rc = new THREE.Raycaster(); let h = null;
  for (const [from, dir] of rays) { if (h) break; rc.set(from, dir.clone().normalize()); h = rc.intersectObjects(all, false).find((x) => x.face) || null; }
  root.traverse((m) => m.geometry?.dispose?.()); if (!h) return -1;
  const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
  const p = { ...placePart(id, h.point.clone(), nrm), parent: h.object.userData._pi }; if (o.color !== undefined) p.color = o.color; if (o.scale) p.scale = [...o.scale];
  parts.push(p); const i = parts.length - 1;
  if (o.symmetry !== false && Math.abs(p.pos[0]) > 0.12) { // the mirrored copy hangs on the parent's partner, if it has one
    const q = parts[p.parent], pp = parts.findIndex((r, k) => k !== p.parent && r.id === q.id && Math.abs(r.pos[0] + q.pos[0]) < 0.02 && Math.abs(r.pos[1] - q.pos[1]) < 0.02 && Math.abs(r.pos[2] - q.pos[2]) < 0.02 && Math.abs(q.pos[0]) > 0.05);
    parts.push({ ...mirroredOf(p), parent: pp >= 0 ? pp : p.parent });
  }
  return i;
}
// Re-place every part of a build (its fixed spots as the taps): each part is dropped, in order, from outside the
// vehicle towards its spot along the way a kid would reach it: wheels and gear from below, canopies, roofs and car
// fittings from above, side pods and wings from the side, nose and tail pieces from the front or back. Mirrored copies
// come from the symmetry, not the list.
export function placeAll(src) {
  const out = [], map = new Map(), V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  src.forEach((p, i) => {
    if (i === 0) { out.push({ ...p, pos: [...p.pos], parent: -1 }); map.set(i, 0); return; }
    const mirrorOf = src.findIndex((q, k) => k < i && q.id === p.id && Math.abs(q.pos[0] + p.pos[0]) < 1e-6 && Math.abs(q.pos[0]) > 0.05 && q.pos[1] === p.pos[1] && q.pos[2] === p.pos[2] && q.mirror !== p.mirror);
    if (mirrorOf >= 0) return; // made by the drop of its original
    const { box } = builtMeshes(out), d = PARTS[p.id], [x, y, z] = p.pos, far = 4 + box.getSize(V3()).length(), rays = [];
    const below = (k = 1) => [V3(x * k, box.min.y - 2, z), V3(0, 1, 0)], above = (k = 1) => [V3(x * k, box.max.y + 2, z), V3(0, -1, 0)];
    const side = () => [V3(Math.sign(x || 1) * far, y, z), V3(-Math.sign(x || 1), 0, 0)], end = () => [V3(x, y, z < 0 ? box.min.z - 2 : box.max.z + 2), V3(0, 0, z < 0 ? 1 : -1)];
    if (d.attach === 'gear') rays.push(below(), below(0.75), below(0.5), below(0.3), below(0));
    else if (d.cat === 'cockpit' || d.cat === 'car') rays.push(above(), above(0.5), above(0));
    else if (d.attach === 'wing' || Math.abs(x) > 0.5) rays.push(side(), [V3(x, y, z), V3(-Math.sign(x), 0, 0)], below(), above());
    else rays.push(end(), above(), below());
    const j = hangarDrop(out, p.id, rays, { scale: p.scale, color: p.color });
    if (j >= 0) map.set(i, j);
  });
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

// ---------- random bike builds (dropped the way the hangar places parts) ----------
// A bike frame (or a pod or buggy body: any body with two wheels in line on the centreline is a bike), a fork wheel
// dropped from below near the front and a swingarm wheel near the back (either kind, sometimes resized), and an engine
// dropped from above or below the middle. Some whole builds resized.
const BIKE_BODIES = ['b_dirt', 'b_sport', 'b_dirt', 'b_sport', 'fus_pod', 'fus_buggy'];
export function bikeBuilds(n = 10, seed = 71, { forks = ['b_fork_dirt', 'b_fork_road'], rears = ['b_swing_dirt', 'b_swing_road'], engines = ['b_single', 'b_four'], bodies = BIKE_BODIES, fit = false } = {}) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [], snap = (v) => Math.round(v * 20) / 20;
  for (let k = 0; k < n; k++) {
    const parts = [], add = (p) => (parts.push(p), parts.length - 1);
    const body = bodies[k % bodies.length], f = add(newPart(body, [0, 0, 0]));
    if (R() < 0.3) { const d = 0.85 + R() * 0.3, l = 0.85 + R() * 0.35; parts[f].scale = [d, d, l]; }
    const built = () => { const root = new THREE.Group(), det = buildDesign({ parts }, root, { quick: true, near: false }); root.updateMatrixWorld(true); const all = []; det.parts.forEach((o, i) => o?.traverse((m) => { if (m.isMesh && !m.material.transparent && !m.userData.isDisc && !m.isInstancedMesh) { m.userData._pi = i; all.push(m); } })); return { root, all, box: new THREE.Box3().setFromObject(root) }; };
    const drop = (id, z, fromBelow, o = {}) => {
      const { root, all, box } = built(), rc = new THREE.Raycaster(); let h = null;
      for (const kz of [1, 0.85, 0.7, 0.5]) { if (h) break; rc.set(new THREE.Vector3(0, fromBelow ? box.min.y - 2 : box.max.y + 2, z * kz), new THREE.Vector3(0, fromBelow ? 1 : -1, 0)); h = rc.intersectObjects(all, false)[0]; }
      root.traverse((m) => m.geometry?.dispose?.()); if (!h) return -1;
      const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize(), info = partInfo(id), pos = h.point.clone();
      if (PARTS[id].attach === 'gear') pos.addScaledVector(nrm, -0.05);
      else { const c = info.center, hh = info.size.clone().multiplyScalar(0.5); pos.addScaledVector(nrm, (Math.abs(nrm.x) * hh.x + Math.abs(nrm.y) * hh.y + Math.abs(nrm.z) * hh.z) * 0.9).sub(c); }
      const p = newPart(id, [0, snap(pos.y), snap(pos.z)], { parent: h.object.userData._pi }); if (o.scale) p.scale = o.scale; return add(p);
    };
    const bb = built().box, L = bb.max.z - bb.min.z, ws = R() < 0.3 ? (() => { const s = +(0.8 + R() * 0.4).toFixed(2); return [s, s, s]; })() : undefined;
    drop(pick(forks), bb.min.z + L * (0.12 + R() * 0.12), true, { scale: ws });
    drop(pick(rears), bb.max.z - L * (0.12 + R() * 0.12), true, { scale: ws });
    drop(pick(engines), bb.min.z + L * (0.4 + R() * 0.2), R() < 0.5);
    if (fit) { // the kid then moves the wheels down (Move) until both tyres are the lowest things on it
      const wheel = (p) => PARTS[p.id].gear && !PARTS[p.id].gear.float, { root, all } = built(); let low = Infinity;
      for (const m of all) if (!wheel(parts[m.userData._pi])) low = Math.min(low, new THREE.Box3().setFromObject(m).min.y);
      root.traverse((m) => m.geometry?.dispose?.());
      for (const p of parts) if (wheel(p)) { const g = PARTS[p.id].gear, s = Math.cbrt((p.scale || [1, 1, 1]).reduce((a, v) => a * v, 1)), bottom = p.pos[1] - (g.len + g.r) * s; p.pos[1] = snap(p.pos[1] + Math.min(0, low - 0.12 - bottom)); }
    }
    if (k % 3 === 1) parts.forEach((p) => { p.scale = (p.scale || [1, 1, 1]).map((v) => v * 1.2); p.pos = p.pos.map((v) => v * 1.2); });
    out.push({ name: `bike ${k} (${body}, ${parts.slice(1).map((p) => p.id).join('/')})`, parts });
  }
  return out;
}

// ---------- random speed builds (the SR-71's parts dropped anywhere) ----------
// A Chined Body (or another body) with a thin wing through it, Spike Ramjets either mid-wing (through the wing, like the
// SR-71) or dropped under a wing or onto the body the way the hangar places them, All-Moving Fins dropped onto the
// engines or the tail at a random cant, a Tandem Canopy dropped onto the top, retractable gear
// dropped from below. Some parts resized; some whole builds resized or mirrored. Checked for open shells and floating parts.
const SPEED_BODIES = ['fus_chine', 'fus_fighter', 'fus_chine', 'fus_airliner', 'fus_chine', 'fus_pod'];
export const isSpeedDesign = (d) => d.parts.some((p) => ['fus_chine', 'e_ramjet', 't_allmove', 'ck_tandem'].includes(p.id));
export function speedBuilds(n = 10, seed = 71) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [], snap = (v) => Math.round(v * 20) / 20;
  for (let k = 0; k < n; k++) {
    const parts = [], add = (p) => (parts.push(p), parts.length - 1);
    const body = SPEED_BODIES[k % SPEED_BODIES.length], f = add(newPart(body, [0, 0, 0]));
    if (R() < 0.3) { const d = 0.8 + R() * 0.4, l = 0.7 + R() * 0.5; parts[f].scale = [d, d, l]; }
    const built = () => { const root = new THREE.Group(), det = buildDesign({ parts }, root, { quick: true, near: false }); root.updateMatrixWorld(true); const all = []; det.parts.forEach((o, i) => o?.traverse((m) => { if (m.isMesh && !m.material.transparent && !m.userData.isDisc && !m.isInstancedMesh && m.material.blending !== THREE.AdditiveBlending) { m.userData._pi = i; all.push(m); } })); return { root, all, box: new THREE.Box3().setFromObject(root) }; };
    // drop a part onto the build along dir (from far away), the way the hangar seats it; only onto parts in `onto` (indices) if given
    const drop = (id, x, z, dir, o = {}) => {
      const { root, all, box } = built(), rc = new THREE.Raycaster(), from = dir === 'down' ? box.max.y + 3 : box.min.y - 3, ray = new THREE.Vector3(0, dir === 'down' ? -1 : 1, 0);
      const cand = o.onto ? all.filter((m) => o.onto.includes(m.userData._pi)) : all; let h = null;
      for (const kx of [1, 0.8, 0.6, 0.4, 0]) for (const kz of [1, 0.85, 0.7]) { if (h) break; rc.set(new THREE.Vector3(x * kx, from, z * kz), ray); h = rc.intersectObjects(cand, false)[0]; }
      root.traverse((m) => m.geometry?.dispose?.()); if (!h) return -1;
      const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize(), info = partInfo(id), pos = h.point.clone();
      if (PARTS[id].attach === 'gear') pos.addScaledVector(nrm, -0.05);
      else { const c = info.center, hh = info.size.clone().multiplyScalar(0.5); pos.addScaledVector(nrm, (Math.abs(nrm.x) * hh.x + Math.abs(nrm.y) * hh.y + Math.abs(nrm.z) * hh.z) * (o.sink ?? 0.9)).sub(c); }
      pos.set(Math.abs(pos.x) < 0.15 ? 0 : snap(pos.x), snap(pos.y), snap(pos.z));
      const p = newPart(id, pos.toArray(), { parent: h.object.userData._pi, rot: o.rot }); if (o.scale) p.scale = o.scale; // (placed upright, then turned about its origin, as in the hangar)
      const i = add(p); if (Math.abs(p.pos[0]) > 0.12) add({ ...mirroredOf(p), parent: o.mirrorParent ? o.mirrorParent(p.parent) : p.parent }); return i;
    };
    const chine = body === 'fus_chine', bb = built().box, L = bb.max.z - bb.min.z;
    // a thin wing pair through the body (root at the centreline side of the body)
    const wid = 'w_delta', wz = bb.min.z + L * (0.62 + R() * 0.08), wy = chine ? 0 : (R() - 0.5) * 0.4;
    const w = add(newPart(wid, [chine ? 1.1 : 0.5, wy, wz], { parent: f })); if (R() < 0.7) parts[w].scale = [1 + R() * 0.6, 1, 1 + R() * 0.7];
    add(mirroredOf(parts[w])); const wpair = [w, w + 1], mirrorW = (pi) => (pi === w ? w + 1 : pi);
    // engines: through the wing (mid-wing), under it, or on top of the body
    const where = pick(['mid', 'mid', 'under', 'top']);
    let eng = -1; const es = R() < 0.4 ? (() => { const s = +(0.7 + R() * 0.6).toFixed(2); return [s, s, s]; })() : undefined;
    if (where === 'mid') { const sc = parts[w].scale || [1, 1, 1], wd = PARTS[wid].wing, sp = 0.3 + R() * 0.25, x = parts[w].pos[0] + wd.span * sc[0] * sp, zle = wz + (-wd.root / 2 + wd.sweep * sp) * sc[2];
      eng = add(newPart('e_ramjet', [snap(x), wy, snap(zle - 2.5 - R() * 2)], { parent: w })); if (es) parts[eng].scale = es; add({ ...mirroredOf(parts[eng]), parent: w + 1 }); }
    else if (where === 'under') eng = drop('e_ramjet', bb.max.x * (1.2 + R()), wz - 3, 'up', { onto: wpair, mirrorParent: mirrorW, scale: es });
    else eng = drop('e_ramjet', 0, bb.min.z + L * 0.45, 'down', { onto: [f], scale: es });
    // fins: on the engines (canted in) or on the tail of the body
    const cant = Math.round(R() * 25), onEng = eng >= 0 && parts[eng].pos[0] > 0.5 && R() < 0.7;
    if (onEng) { const e = parts[eng]; drop('t_allmove', e.pos[0], e.pos[2] + 11, 'down', { onto: [eng], rot: [0, 0, cant], mirrorParent: (pi) => pi + 1 }); }
    else drop('t_allmove', R() < 0.5 ? 0 : bb.max.x * 0.3, bb.max.z - L * 0.1, 'down', { onto: [f], rot: [0, 0, cant] });
    // a canopy on top, towards the front
    drop('ck_tandem', 0, bb.min.z + L * (0.2 + R() * 0.15), 'down', { onto: [f], sink: 0.55 });
    // gear: a nose leg and a pair of mains
    drop('g_retract_nose', 0, bb.min.z + L * 0.22, 'up', { onto: [f] });
    drop('g_retract', bb.max.x * (0.5 + R() * 0.4), wz + 1, 'up', { onto: [f, ...wpair], mirrorParent: mirrorW });
    if (k % 3 === 1) parts.forEach((p) => { p.scale = (p.scale || [1, 1, 1]).map((v) => v * 1.25); p.pos = p.pos.map((v) => v * 1.25); });
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `speed ${k} (${body}, ${where} engines, ${onEng ? 'fins on engines' : 'fin on body'})`, parts });
  }
  return out;
}

// ---------- floating parts ----------
// Every piece of a car (each connected piece of every mesh: a merged mesh holds many, an instanced link is one per
// instance) must touch, or come within `tol` of, another piece, and all of them must hang together as one vehicle:
// a piece (or a group of pieces) not connected to the main body is floating. Touch = a vertex within tol of the other's
// triangle, or an edge through it. Crew (skinned, posed at runtime), prop discs and glows are left out, and so is
// anything under userData.floatOk = 'why' (a deliberate gap, with its reason).
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
// per piece, cached: triangle bounds grown by tol, and a coarse grid of them (pieces are tested against many others)
function triBounds(C, tol) {
  if (C.tb) return C.tb; const n = C.T.length / 9, tb = new Float32Array(n * 6), T = C.T;
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v0 = T[i * 9 + a], v1 = T[i * 9 + 3 + a], v2 = T[i * 9 + 6 + a]; tb[i * 6 + a] = Math.min(v0, v1, v2) - tol; tb[i * 6 + 3 + a] = Math.max(v0, v1, v2) + tol; }
  return (C.tb = tb);
}
function triGrid(C) {
  if (C.grid) return C.grid; const tb = C.tb, n = tb.length / 6, sz = C.box.getSize(new THREE.Vector3()), cell = Math.max(0.03, Math.max(sz.x, sz.y, sz.z) / 32), cells = new Map(), o = C.box.min;
  const at = (p) => [Math.floor((p.x - o.x) / cell), Math.floor((p.y - o.y) / cell), Math.floor((p.z - o.z) / cell)];
  for (let i = 0; i < n; i++) {
    const a = at({ x: tb[i * 6], y: tb[i * 6 + 1], z: tb[i * 6 + 2] }), b = at({ x: tb[i * 6 + 3], y: tb[i * 6 + 4], z: tb[i * 6 + 5] });
    for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) { const k = `${x},${y},${z}`; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(i); }
  }
  return (C.grid = { at, cells });
}
function touches(A, B, tol) {
  const reg = A.box.clone().expandByScalar(tol).intersect(B.box.clone().expandByScalar(tol)); if (reg.isEmpty()) return false;
  const sel = (C) => { // triangles of C (bounds grown by tol) meeting reg, through C's own coarse grid
    const o = [], tb = triBounds(C, tol), G = triGrid(C), r = reg, inR = (i) => tb[i * 6] <= r.max.x && tb[i * 6 + 3] >= r.min.x && tb[i * 6 + 1] <= r.max.y && tb[i * 6 + 4] >= r.min.y && tb[i * 6 + 2] <= r.max.z && tb[i * 6 + 5] >= r.min.z;
    const box = (i) => new THREE.Box3(new THREE.Vector3(tb[i * 6], tb[i * 6 + 1], tb[i * 6 + 2]), new THREE.Vector3(tb[i * 6 + 3], tb[i * 6 + 4], tb[i * 6 + 5]));
    const c0 = G.at(r.min), c1 = G.at(r.max), nc = (c1[0] - c0[0] + 1) * (c1[1] - c0[1] + 1) * (c1[2] - c0[2] + 1);
    if (nc * 4 > tb.length / 6) { for (let i = 0; i < tb.length / 6; i++) if (inR(i)) o.push([i, box(i)]); return o; }
    const seen = new Set();
    for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) for (const i of G.cells.get(`${x},${y},${z}`) || []) if (!seen.has(i)) { seen.add(i); if (inR(i)) o.push([i, box(i)]); }
    return o;
  };
  const a = sel(A), b = sel(B); if (!a.length || !b.length) return false;
  const size = reg.getSize(new THREE.Vector3()), cell = Math.max(0.02, Math.max(size.x, size.y, size.z) / 24), grid = new Map(), ck = (x, y, z) => `${x},${y},${z}`;
  const cells = (bx, f) => { for (let x = Math.floor(bx.min.x / cell); x <= Math.floor(bx.max.x / cell); x++) for (let y = Math.floor(bx.min.y / cell); y <= Math.floor(bx.max.y / cell); y++) for (let z = Math.floor(bx.min.z / cell); z <= Math.floor(bx.max.z / cell); z++) f(ck(x, y, z)); };
  for (const [j, bx] of b) cells(bx, (k) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push([j, bx]); });
  for (const [i, bx] of a) { let hit = false; const seen = new Set(); cells(bx, (k) => { if (hit) return; for (const [j, by] of grid.get(k) || []) { if (seen.has(j)) continue; seen.add(j); if (bx.intersectsBox(by) && triTouch(A.T, i, B.T, j, tol)) { hit = true; return; } } }); if (hit) return true; }
  return false;
}
export function floatingParts(root, det, design, { tol = 0.01, gaps = true, collect = false } = {}) {
  root.updateMatrixWorld(true);
  const comps = [], shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; }, M4 = new THREE.Matrix4();
  root.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || m.userData.decal || !shown(m)) return; // (decals: stickers a few mm off the skin)
    for (let x = m; x; x = x.parent) if (x.userData.floatOk) return; // a deliberate gap, with its reason
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
  // how far a floating piece is from the vehicle (nearest vertex to a triangle of the main set, looked for within 0.5 m)
  const mainC = comps.filter((_, i) => find(i) === main), gapOf = (c) => {
    let best = Infinity; const reach = c.box.clone().expandByScalar(0.5), v = new THREE.Vector3(), n = c.T.length / 3, step = Math.max(1, Math.floor(n / 150));
    for (const m of mainC) {
      if (!m.box.intersectsBox(reach)) continue;
      for (let t = 0; t < m.T.length / 9; t++) {
        vtx(m.T, t, 0, _a); vtx(m.T, t, 1, _b); vtx(m.T, t, 2, _c); _tri.set(_a, _b, _c);
        const tb = new THREE.Box3().setFromPoints([_a, _b, _c]); if (!tb.intersectsBox(reach)) continue;
        for (let k = 0; k < n; k += step) { v.set(c.T[k * 3], c.T[k * 3 + 1], c.T[k * 3 + 2]); const d = _tri.closestPointToPoint(v, _p).distanceTo(v); if (d < best) best = d; }
      }
    }
    return best;
  };
  const out = new Map();
  comps.forEach((c, i) => {
    if (find(i) === main) return;
    const k = partOf(c.mesh) + ' ' + (c.mesh.material.name || c.mesh.material.type) + ' #' + (c.mesh.material.color?.getHexString?.() || '') + (c.mesh.isInstancedMesh ? ' (link)' : '');
    const sz = c.box.getSize(new THREE.Vector3()).length();
    if (!out.has(k)) out.set(k, { what: k, n: 0, size: 0, at: null });
    const o = out.get(k); o.n++; if (sz > o.size) { o.size = +sz.toFixed(3); o.at = c.box.getCenter(new THREE.Vector3()).toArray().map((x) => +x.toFixed(2)); }
    if (gaps && o.n <= 4) { const g = gapOf(c); o.gap = Math.min(o.gap ?? Infinity, g); }
  });
  if (collect) { const fl = comps.filter((_, i) => find(i) !== main), T = new Float32Array(fl.reduce((s, c) => s + c.T.length, 0)); let k = 0; for (const c of fl) { T.set(c.T, k); k += c.T.length; } return { pieces: comps.length, floating: [...out.values()], tris: T }; }
  for (const o of out.values()) if (o.gap !== undefined) o.gap = Number.isFinite(o.gap) ? +o.gap.toFixed(3) : '>0.5';
  return { pieces: comps.length, floating: [...out.values()] };
}
// pose every car corner and bike wheel: wheels pushed up by `comp` of their travel, steered wheels turned `steer` rad;
// rigs, forks and swingarms follow
export function poseCar(det, comp, steer) {
  for (const o of det.parts) {
    const u = o?.userData;
    if (u?.bikeSync) { u.bikeSync({ comp: comp * -u.wheels.position.y, steer: u.bikeWheel === 'front' ? steer : 0, spin: comp }); continue; } // bike forks and swingarms (bikeParts.js)
    if (!u?.corner) continue; u.wheels.position.y = -u.corner.len * (1 - comp); u.wheels.rotation.y = u.steer ? steer : 0; u.wheelsFixed.position.copy(u.wheels.position); u.wheelsFixed.rotation.y = u.wheels.rotation.y; }
  det.rig?.update();
}
export const isCarDesign = (d) => d.parts.some((p) => PARTS[p.id]?.cat === 'car' || PARTS[p.id]?.cat === 'bike' || p.id === 'fus_buggy' || p.id === 'fus_truck');

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
// A hole's rim that lies against another opaque surface is closed by it: a bezel ring standing on its instrument panel,
// a gauge's can sunk into the panel, a cup pressed onto a wall. Such boundary edges don't count towards the hole. An
// edge is closed when its ends and middle are all within SEAL_TOL of an opaque, visible triangle that is not part of the
// same connected piece (any mesh of the vehicle, the same mesh's other pieces included). Glass never closes anything:
// a hole behind glass is a hole you can see. (1 cm: the reach the floating-parts check calls touching.)
const SEAL_TOL = 0.01;
const opaqueSurface = (m) => {
  const mt = m.material; if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || !mt || Array.isArray(mt) || mt.transparent || mt.colorWrite === false || mt.blending !== THREE.NormalBlending) return false;
  for (let o = m; o; o = o.parent) if (!o.visible) return false;
  return true;
};
// the vehicle's opaque surfaces for openShells' rim test: near(box) gathers the triangles in a region, close(p, ...)
// says whether p is within tol of one of them (the meshes listed on first use)
export function sealer(root) {
  let meshes = null;
  const list = () => { if (!meshes) { meshes = []; root.updateMatrixWorld(true); root.traverse((m) => { if (opaqueSurface(m) && m.geometry?.attributes.position) { m.geometry.computeBoundingBox(); meshes.push(m); } }); } return meshes; };
  const M4 = new THREE.Matrix4(), tri = new THREE.Triangle(), cp = new THREE.Vector3();
  // [{ T: Float32Array of world corners, mesh, t: triangle index, box }]
  const near = (box) => {
    const out = [], v = new THREE.Vector3(), tb = new THREE.Box3();
    for (const m of list()) {
      const inst = m.isInstancedMesh ? m.count : 1;
      for (let k = 0; k < inst; k++) {
        const W = m.isInstancedMesh ? (m.getMatrixAt(k, M4), M4.clone().premultiply(m.matrixWorld)) : m.matrixWorld;
        if (!m.geometry.boundingBox.clone().applyMatrix4(W).intersectsBox(box)) continue;
        const P = m.geometry.attributes.position, ix = m.geometry.index?.array, nt = (ix ? ix.length : P.count) / 3;
        for (let t = 0; t < nt; t++) {
          const T = new Float32Array(9); tb.makeEmpty();
          for (let c = 0; c < 3; c++) { v.fromBufferAttribute(P, ix ? ix[t * 3 + c] : t * 3 + c).applyMatrix4(W); T[c * 3] = v.x; T[c * 3 + 1] = v.y; T[c * 3 + 2] = v.z; tb.expandByPoint(v); }
          if (tb.intersectsBox(box)) out.push({ T, mesh: m, t, box: tb.clone() });
        }
      }
    }
    return out;
  };
  // is point p within tol of one of the triangles `cand` that `skip` doesn't exclude?
  const close = (p, cand, skip, tol) => {
    for (const c of cand) {
      if (p.x < c.box.min.x - tol || p.x > c.box.max.x + tol || p.y < c.box.min.y - tol || p.y > c.box.max.y + tol || p.z < c.box.min.z - tol || p.z > c.box.max.z + tol || skip(c)) continue;
      tri.a.fromArray(c.T, 0); tri.b.fromArray(c.T, 3); tri.c.fromArray(c.T, 6);
      if (tri.closestPointToPoint(p, cp).distanceToSquared(p) <= tol * tol) return true;
    }
    return false;
  };
  return { near, close };
}

// visible-from-inside holes of one geometry, in world metres (welded positions, connected pieces); with a sealer (see
// above), rims lying against another opaque surface are closed by it
export function openShells(mesh, seal = null) {
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
    if (!comp.has(r)) comp.set(r, { len: 0, edges: [] }); const o = comp.get(r); o.len += wp[a].distanceTo(wp[b]); o.edges.push([a, b]);
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
    if (flat) continue;
    let len = c.len;
    if (seal) { // take away the rim lying against other surfaces
      const cand = seal.near(box.clone().expandByScalar(SEAL_TOL)), skip = (q) => q.mesh === mesh && find(id[idx ? idx[q.t * 3] : q.t * 3]) === r, mid = new THREE.Vector3();
      for (const [a, b] of c.edges) if (seal.close(wp[a], cand, skip, SEAL_TOL) && seal.close(wp[b], cand, skip, SEAL_TOL) && seal.close(mid.addVectors(wp[a], wp[b]).multiplyScalar(0.5), cand, skip, SEAL_TOL)) len -= wp[a].distanceTo(wp[b]);
      if (len < MIN_LOOP) continue;
    }
    out.push({ loop: +len.toFixed(2), size: +size.toFixed(2), at: ctr.toArray().map((x) => +x.toFixed(2)) });
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

// ---------- tube seams ----------
// Where two tubes meet along each other (a nose, cone, boom or another body against a body's end, or plugged into its
// tapering end; straight or up to 50 deg apart) the skin must run on smoothly: no inward dip across the seam and no
// crease in the shading. Each join is sampled along the axis of one of the two tubes, across the seam (0.9 of its radius
// either side), at 32 angles round it: a ray from outside towards the axis finds the visible skin; its distance from
// the axis is the surface radius, the interpolated vertex normal is what the shading sees. Rays that pass through glass
// or first hit another part are dropped (that skin is not part of this seam), and so are hits on trim (userData.trim:
// window frames, a bubble's frame, a bolted flange: rings meant to stand proud). Fails where the skin sits below the
// chord between its neighbours 5 % or 10 % of the radius away on either side by more than DIP_TOL of the radius (at
// least DIP_MIN metres: a groove, a step, a dent), or where the shading normal turns by more than NRM_TOL degrees
// between neighbouring samples (2.5 % of the radius apart: a crease).
const DIP_TOL = 0.006, DIP_MIN = 0.006, NRM_TOL = 10; // (6 mm: below that it is facets and ring spacing, not a groove)
// tube-shaped parts that are not bodies: their profile along local z ([z, r], r scaled by sx, sy)
const TUBE_PARTS = {
  x_nosecone: { prof: [[-1.6, 0], [-1.2, 0.18], [-0.5, 0.38], [0, 0.45]] },
  x_tailcone: { prof: [[0, 0.5], [1.0, 0.38], [2.2, 0.12], [2.4, 0]] },
  ck_airliner: { prof: [[-4.6, 0], [-4.4, 0.7], [-3.4, 1.4], [-1.8, 1.82], [0, 1.9]] },
  ck_heli: { prof: Array.from({ length: 13 }, (_, k) => { const z = -1.247 + 1.247 * (k / 12); return [z, 0.86 * Math.sqrt(Math.max(0, 1 - (z / 1.247) ** 2))]; }), sx: 0.95, sy: 1.08 },
};
function tubeOf(obj, id) {
  const b = obj?.userData.body, t = b ? { prof: b.prof, sx: b.sx ?? 1, sy: b.sy ?? 1, yOff: b.yOff } : TUBE_PARTS[id] ? { sx: 1, sy: 1, ...TUBE_PARTS[id] } : null;
  if (!t) return null;
  const W = (b?.skin || obj).matrixWorld, inv = W.clone().invert(), e = W.elements, sc = Math.cbrt(Math.abs(W.determinant()));
  const z0 = t.prof[0][0], z1 = t.prof.at(-1)[0], rMax = Math.max(...t.prof.map((q) => q[1]));
  const rAt = (z) => { // the widest the profile is at z (a flat end is a vertical step in it)
    let best = 0; z = Math.min(z1, Math.max(z0, z));
    for (let i = 1; i < t.prof.length; i++) { const a = t.prof[i - 1], c = t.prof[i], lo = Math.min(a[0], c[0]), hi = Math.max(a[0], c[0]); if (z < lo - 1e-9 || z > hi + 1e-9) continue; best = Math.max(best, hi - lo < 1e-9 ? Math.max(a[1], c[1]) : a[1] + (c[1] - a[1]) * ((z - a[0]) / (c[0] - a[0]))); }
    return best;
  };
  const yo = (z) => (t.yOff ? t.yOff(z) : 0), l = new THREE.Vector3();
  const f = (p) => { l.copy(p).applyMatrix4(inv); if (l.z < z0 || l.z > z1) return Math.max(z0 - l.z, l.z - z1) * sc; return (Math.hypot(l.x / t.sx, (l.y - yo(l.z)) / t.sy) - rAt(l.z)) * Math.min(t.sx, t.sy) * sc; };
  const axis = new THREE.Vector3(e[8], e[9], e[10]).normalize(), L = z1 - z0;
  const ends = [];
  for (const [z, inward] of [[z0, 1], [z1, -1]]) { // an end with some width (a pointed tip is not a joint)
    let r = 0; for (let k = 0; k <= 6; k++) r = Math.max(r, rAt(z + inward * L * 0.03 * (k / 6)));
    if (r * sc > 0.02) ends.push({ z, wide: r > 0.3 * rMax, r: r * (t.sx + t.sy) / 2 * sc, c: new THREE.Vector3(0, yo(z), z).applyMatrix4(W), inward: axis.clone().multiplyScalar(inward) });
  }
  return { f, axis, ends, rMax: rMax * Math.max(t.sx, t.sy) * sc, rAtW: (p) => { l.copy(p).applyMatrix4(inv); return rAt(l.z) * (t.sx + t.sy) / 2 * sc; } };
}
export function tubeJoins(design, det) {
  const T = det.parts.map((o, i) => (o ? tubeOf(o, design.parts[i].id) : null)), joins = [];
  T.forEach((A, i) => {
    if (!A) return;
    T.forEach((B, j) => {
      if (!B || j === i) return;
      for (const e of A.ends) {
        // tube to tube along each other (end to end, or plugged into B's end, up to 50 deg apart): this end against B's
        // end, or inside B with B's end round it (a boom poking out through the side of a body is skinBlend's neck)
        const like = (g) => Math.min(e.r, g.r) >= 0.3 * Math.max(e.r, g.r); // (a pointed tip against a wide end is not a joint)
        const near = B.ends.some((g) => like(g) && g.c.distanceTo(e.c) < 0.3 * Math.max(e.r, g.r));
        const plugged = B.f(e.c) <= 0.05 * B.rMax && B.rAtW(e.c) >= e.r && B.ends.some((g) => { const d = g.c.clone().sub(e.c), al = d.dot(e.inward); return like(g) && al > -0.05 && d.addScaledVector(e.inward, -al).length() <= Math.max(0.6 * e.r, 0.3 * g.r) + 0.02; });
        if (!near && !plugged) continue;
        if (Math.abs(e.inward.dot(B.axis)) < Math.cos(50 * Math.PI / 180)) continue;
        // the seam: where A's axis leaves B, going from this end into A
        const C = e.c.clone(), step = e.r / 20;
        for (let k = 0; k < 400 && B.f(C) < 0; k++) C.addScaledVector(e.inward, step);
        if (joins.some((J) => J.C.distanceTo(C) < 0.3 * Math.min(J.R, e.r) && ((J.i === i && J.j === j) || (J.i === j && J.j === i)))) continue;
        joins.push({ i, j, C, axis: e.inward.clone(), R: Math.max(e.r, A.rAtW(C)) });
      }
    });
  });
  return joins;
}
export function tubeSeams(design, det, root, { cols = 32, rows = 72, trace = null } = {}) {
  root.updateMatrixWorld(true);
  const owner = new Map(), all = [];
  det.parts.forEach((o, i) => o?.traverse((m) => owner.set(m, i)));
  const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
  root.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || m.userData.decal || m.userData.near || !shown(m)) return;
    const mt = m.material; if (!mt || Array.isArray(mt) || mt.blending === THREE.AdditiveBlending || mt.colorWrite === false || mt.side === THREE.BackSide) return;
    all.push(m);
  });
  const rc = new THREE.Raycaster(), out = [], nm = new THREE.Matrix3();
  for (const J of tubeJoins(design, det)) {
    const A = J.axis, u0 = Math.abs(A.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), e1 = u0.clone().addScaledVector(A, -u0.dot(A)).normalize(), e2 = A.clone().cross(e1);
    const W = Math.min(0.9 * J.R + 0.1, 1.6), far = 3 * J.R + 1, ds = (2 * W) / rows;
    let worst = 0, worstN = 0, at = null, atN = null, valid = 0;
    for (let c = 0; c < cols; c++) {
      const th = ((c + 0.37) / cols) * Math.PI * 2, u = e1.clone().multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th));
      const col = [];
      for (let k = 0; k < rows; k++) { // (an even count: never exactly on the seam plane, where a ray runs along the end caps)
        const s = -W + (2 * W * (k + 0.5)) / rows, base = J.C.clone().addScaledVector(A, s);
        rc.set(base.clone().addScaledVector(u, far), u.clone().negate()); rc.far = far;
        const hits = rc.intersectObjects(all, false); let h = null;
        for (const x of hits) { if (x.object.material.transparent) break; if (x.object.userData.trim) continue; h = x; break; }
        const pi = h ? owner.get(h.object) : -1;
        if (!h || (pi !== J.i && pi !== J.j)) { col.push(null); continue; }
        const d = h.point.clone().sub(J.C), r = d.addScaledVector(A, -d.dot(A)).length();
        const n = (h.normal ? h.normal.clone() : h.face.normal.clone()).applyMatrix3(nm.getNormalMatrix(h.object.matrixWorld)).normalize();
        col.push({ s, r, n, pi, mesh: h.object });
      }
      if (trace && trace.j === out.length && Math.abs(c - trace.c) < 0.5) trace.rows = col.map((q, k) => (q ? [+q.s.toFixed(3), +q.r.toFixed(4), q.pi, q.mesh.material.type + ":" + (q.mesh.material.color?.getHexString?.() || "") + ":" + q.mesh.geometry.attributes.position.count, k ? +(Math.acos(Math.min(1, Math.max(-1, col[k - 1]?.n.dot(q.n) ?? 1))) * 180 / Math.PI).toFixed(1) : 0] : null));
      // dip: below the radius on both sides (within the window); normal jump between neighbours
      for (let k = 0; k < col.length; k++) {
        const q = col[k]; if (!q) continue; valid++;
        // how far below the chord between its neighbours either side (5 % and 10 % of the radius away) the skin sits:
        // a seam groove or step shows; a long gentle waist between two parts of different sizes does not
        let dip = 0;
        for (const f of [0.05, 0.1]) { const h = Math.max(1, Math.round((f * J.R) / ds)), a = col[k - h], b = col[k + h]; if (a && b) dip = Math.max(dip, (a.r + b.r) / 2 - q.r); }
        if (dip > worst) { worst = dip; at = { th: +(th * 180 / Math.PI).toFixed(0), s: +q.s.toFixed(3) }; }
        const p = col[k - 1];
        // (not right at the edge of a glazed stretch, where the rays graze the glass's frame or edge)
        if (p && col[k - 2] !== null && col[k + 1] !== null) { const ang = Math.acos(Math.min(1, Math.max(-1, p.n.dot(q.n)))) * 180 / Math.PI; if (ang > worstN) { worstN = ang; atN = { th: +(th * 180 / Math.PI).toFixed(0), s: +q.s.toFixed(3) }; } }
      }
    }
    const tol = Math.max(DIP_MIN, DIP_TOL * J.R);
    out.push({ a: `#${J.i} ${design.parts[J.i].id}`, b: `#${J.j} ${design.parts[J.j].id}`, R: +J.R.toFixed(3), C: J.C.toArray().map((x) => +x.toFixed(2)), dip: +worst.toFixed(4), dipAt: at, tol: +tol.toFixed(4), nrm: +worstN.toFixed(1), nrmAt: atN, cover: +(valid / (cols * rows)).toFixed(2), bad: worst > tol || worstN > NRM_TOL });
  }
  return out;
}

// Tubes joined to tubes (seam check): a body with a nose, cone, cockpit section, boom or another body bolted to its
// front or back end, end to end, sometimes at an angle, with a gap or overlap of a few cm, sized to match or not, some
// rolled; a boom plugged into a body's tail. Whole builds resized or mirrored.
const SEAM_BODIES = ['fus_light', 'fus_sport', 'fus_airliner', 'fus_pod', 'fus_glider', 'fus_cargo', 'fus_heli', 'fus_rocket', 'fus_boom', 'fus_fighter'];
const SEAM_FRONT = ['x_nosecone', 'ck_airliner', 'x_nosecone', 'ck_heli', 'fus_pod', 'fus_boom', 'fus_rocket'];
const SEAM_BACK = ['x_tailcone', 'fus_boom', 'x_tailcone', 'fus_rocket', 'fus_light'];
const _ends = new Map();
function partEnds(id) { // the part's ends with real width, in part space (z, r, y, facing: -1 front, +1 back)
  if (_ends.has(id)) return _ends.get(id);
  const o = PARTS[id].build(PARTS[id].color, { detail: 2 }); o.updateMatrixWorld(true);
  const t = tubeOf(o, id), out = t ? t.ends.filter((e) => e.wide).map((e) => ({ z: e.c.z, y: e.c.y, r: e.r, facing: e.inward.z > 0 ? -1 : 1 })) : [];
  o.traverse((m) => m.geometry?.dispose?.()); _ends.set(id, out); return out;
}
export function seamBuilds(n = 16, seed = 71) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [];
  for (let k = 0; k < n; k++) {
    const body = SEAM_BODIES[k % SEAM_BODIES.length], parts = [], add = (p) => (parts.push(p), parts.length - 1);
    const f = add(newPart(body, [0, 0, 0]));
    if (R() < 0.3) { const d = 0.8 + R() * 0.5; parts[f].scale = [d, d, 0.8 + R() * 0.5]; }
    const ps = parts[f].scale || [1, 1, 1];
    for (const side of [-1, 1]) {
      const pe = partEnds(body).find((e) => e.facing === side); if (!pe) continue;
      const id = pick(side < 0 ? SEAM_FRONT : SEAM_BACK), ends = partEnds(id);
      // the child's end that meets the parent: its own back end on a front join (or its front end, turned round)
      let ce = ends.find((e) => e.facing === -side), yaw = 0;
      if (!ce) { ce = ends.find((e) => e.facing === side); yaw = 180; } if (!ce) continue;
      const match = (pe.r * (ps[0] + ps[1]) / 2) / ce.r, s = R() < 0.5 ? match : match * (0.7 + R() * 0.6), sc = R() < 0.3 ? [s, s, s * (0.7 + R() * 0.6)] : [s, s, s];
      const pitch = R() < 0.35 ? (R() < 0.5 ? -1 : 1) * (6 + R() * 12) : 0, roll = R() < 0.25 ? 90 : 0;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(roll)));
      const gap = (R() - 0.5) * 0.04 * pe.r * side; // a few cm apart or into each other
      const P = new THREE.Vector3(0, pe.y * ps[1], pe.z * ps[2] + gap), cl = new THREE.Vector3(0, ce.y * sc[1], ce.z * sc[2]).applyQuaternion(q);
      const pos = P.sub(cl).toArray().map((v) => +v.toFixed(3));
      const p = newPart(id, pos, { parent: f }); p.quat = q.toArray(); p.scale = sc; add(p);
    }
    if (R() < 0.35 && body !== 'fus_boom' && !parts.some((p) => p.pos[2] > 0)) { // a boom pushed into the body's tail (into the tail cone, or out through its side), if nothing is on that end already
      const p = newPart('fus_boom', [0, 0.1 * ps[1], (body === 'fus_airliner' ? 13 : body === 'fus_cargo' ? 10 : 5) * ps[2] * 0.85], { parent: f }); add(p);
    }
    if (k % 3 === 1) parts.forEach((p) => { p.scale = (p.scale || [1, 1, 1]).map((v) => v * 1.3); p.pos = p.pos.map((v) => v * 1.3); });
    if (k % 3 === 2) parts.forEach((p) => { p.pos[0] = -p.pos[0]; p.mirror = !p.mirror; p.quat = [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]]; });
    out.push({ name: `seams ${k} (${body}: ${parts.slice(1).map((p) => p.id).join(', ')})`, parts });
  }
  return out;
}

export async function run({ presets = [], random = 20, placed = 20, fittings = 12, cars = 16, bikes = 10, speed = 10, seams = 16, floatOnly = false } = {}) {
  const cb = [...carBuilds(cars), ...bikeBuilds(bikes)], pb = randomBuilds(placed, 7, { placed: true }), sb = speedBuilds(speed), designs = [...presets, ...randomBuilds(random), ...pb, ...fittingBuilds(fittings), ...cb, ...sb, ...seamBuilds(seams)], report = [];
  // floating parts: every stock vehicle, the random builds re-placed the way the hangar places parts, the car and bike
  // builds and the speed builds (the plain random and fitting builds put parts at fixed spots, which can be in mid-air:
  // the hangar never does that)
  const floatCheck = new Set([...presets, ...pb, ...cb, ...sb]);
  for (const d of designs) {
    if (floatOnly && !floatCheck.has(d)) continue;
    const root = new THREE.Group(); let res;
    try {
      const det = buildDesign(d, root, { quick: false, near: true }); root.updateMatrixWorld(true);
      const open = [], seal = sealer(root);
      det.parts.forEach((o, i) => { if (!o || SKIP_CATS.has(PARTS[d.parts[i].id]?.cat)) return; o.traverse((m) => { if (skipMesh(m)) return; for (const s of openShells(m, seal)) open.push({ part: d.parts[i].id, mat: m.material.name || m.material.type, ...s }); }); });
      res = { name: d.name, open, exhaust: exhaustHits(root), nav: navLightIssues(d, det, root), seams: tubeSeams(d, det, root) };
      if (floatCheck.has(d)) { // no floating parts: at rest, and with the wheels pushed up and steered (the rig must follow)
        const rest = floatingParts(root, det, d), moves = det.parts.some((o) => o?.userData.corner); // (nothing moves without car corners)
        poseCar(det, 0.6, 0.45); const moved = moves ? floatingParts(root, det, d) : rest; poseCar(det, 0, 0);
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
