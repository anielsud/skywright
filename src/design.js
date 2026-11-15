// Design model: a list of parts with transforms + parent links. Presets and analysis.
import * as THREE from 'three';
import { PARTS, partInfo } from './parts.js';

export const partScale = (p) => p.scale || [1, 1, 1];
export function partMatrix(p, out = new THREE.Matrix4()) {
  const [sx, sy, sz] = partScale(p);
  return out.compose(new THREE.Vector3(...p.pos), new THREE.Quaternion(...p.quat), new THREE.Vector3(p.mirror ? -sx : sx, sy, sz));
}

// ---------- resizing ----------
// Long round extras resize like bodies; wings/tails by span and chord; everything else by one uniform Size.
const ROUND_EXTRAS = new Set(['x_nosecone', 'x_tailcone', 'x_tank']);
const isFin = (id) => PARTS[id].attach === 'fin'; // fins are built span-up (+Y), thickness along X
// The sliders a part offers: [key, label, min, max]
export function sizeSliders(id) {
  const d = PARTS[id]; if (!d) return [];
  if (d.cat === 'fuselage' || ROUND_EXTRAS.has(id)) return [['len', 'Length', 0.5, 3], ['dia', 'Diameter', 0.5, 2.5]];
  if (d.wing) return [['span', 'Span', 0.5, 2.5], ['chord', 'Chord', 0.5, 2]];
  return [['size', 'Size', 0.5, 2.5]];
}
// Which local scale components ([x, y, z]) a slider drives. Chord also scales thickness so the airfoil keeps its shape.
export function sizeAxes(id, key) {
  if (key === 'len') return [2];
  if (key === 'dia') return [0, 1];
  if (key === 'span') return [isFin(id) ? 1 : 0];
  if (key === 'chord') return [2, isFin(id) ? 0 : 1];
  return [0, 1, 2];
}
export const sizeValue = (p, key) => partScale(p)[sizeAxes(p.id, key)[0]];
const volScale = (p) => { const [sx, sy, sz] = partScale(p); return sx * sy * sz; };
// Mass follows what the part is: bodies by volume, wings by area, engines and gear by size² (so thrust/weight stays put)
function massScale(p) {
  const d = PARTS[p.id], [sx, sy, sz] = partScale(p);
  if (d.wing) return (isFin(p.id) ? sy : sx) * sz;
  if (d.engine || d.gear) return Math.cbrt(sx * sy * sz) ** 2;
  return sx * sy * sz;
}
export const partMass = (p) => PARTS[p.id].mass * massScale(p);
export const partHp = (p) => PARTS[p.id].hp * Math.sqrt(massScale(p)); // bigger parts are a bit tougher
export const thrustScale = (p) => Math.cbrt(volScale(p)) ** 2; // thrust grows with intake / prop disc area
// Engine tuning: power multiplies stock thrust (0.25–3); rockets also carry a burn time in seconds.
export const POWER_RANGE = [0.25, 3], BURN_RANGE = [5, 120];
export const partPower = (p) => p.power ?? 1;
export const partBurn = (p) => p.burn ?? PARTS[p.id].engine?.burn ?? 0;
export const linScale = (p) => Math.cbrt(volScale(p)); // gear: wheel radius and strut length
// A lifting surface (part-local arrays) after the part is scaled: span/chord stretch area, chord and aspect ratio;
// n comes back pre-divided by scale², so transformDirection(partMatrix) yields R·S⁻¹·n: still perpendicular to the stretched skin.
const _sv = new THREE.Vector3();
export function scaleSurface(s, [sx, sy, sz]) {
  if (sx === 1 && sy === 1 && sz === 1) return s;
  const span = _sv.set(s.s[0] * sx, s.s[1] * sy, s.s[2] * sz).length(), chord = _sv.set(s.f[0] * sx, s.f[1] * sy, s.f[2] * sz).length();
  return { ...s, n: _sv.set(s.n[0] / (sx * sx), s.n[1] / (sy * sy), s.n[2] / (sz * sz)).normalize().toArray(),
    area: s.area * span * chord, chord: s.chord * chord, ar: s.ar && Math.max(1, s.ar * span / chord) };
}

export function mirroredOf(p) {
  const m = { ...p, pos: [-p.pos[0], p.pos[1], p.pos[2]], quat: [p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]], mirror: !p.mirror };
  if (p.scale) m.scale = [...p.scale]; // don't share the array with the original
  return m;
}

export function newPart(id, pos, opts = {}) {
  const q = opts.rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...opts.rot.map(THREE.MathUtils.degToRad))) : new THREE.Quaternion();
  return { id, pos: [...pos], quat: [q.x, q.y, q.z, q.w], mirror: !!opts.mirror, color: opts.color ?? PARTS[id].color, parent: opts.parent ?? -1 };
}

// Subtree (indices) rooted at i
export function subtree(parts, i) {
  const out = [i];
  for (let k = 0; k < out.length; k++) parts.forEach((p, j) => { if (p.parent === out[k] && !out.includes(j)) out.push(j); });
  return out;
}

export function removeParts(design, idxs) {
  const keep = design.parts.map((_, i) => !idxs.includes(i));
  const remap = []; let n = 0;
  design.parts.forEach((_, i) => { remap[i] = keep[i] ? n++ : -1; });
  design.parts = design.parts.filter((_, i) => keep[i]).map((p) => ({ ...p, parent: p.parent >= 0 ? remap[p.parent] : -1 }));
  // orphaned parts (parent removed) get attached to root
  design.parts.forEach((p, i) => { if (i > 0 && p.parent < 0) p.parent = 0; });
  if (design.parts[0]) design.parts[0].parent = -1;
}

// ---------- analysis ----------
const RHO = 1.225, G = 9.81;
export function analyze(design) {
  const m = new THREE.Matrix4(), com = new THREE.Vector3();
  let drivePower = 0, motors = 0, driveWheels = 0, wheels = 0;
  let rotorLift = 0, rotors = 0, tailRotors = 0, twist = 0, rotorOff = 0; const rotorAt = new THREE.Vector3();
  let mass = 0, thrust = 0, wingArea = 0, finArea = 0, engines = 0, props = 0, jets = 0, rockets = 0, gear = 0, floats = 0, smoke = 0;
  const lift = new THREE.Vector3(); let liftW = 0; let latLift = 0, latThrust = 0;
  const ctrl = { pitch: 0, roll: 0, yaw: 0 };
  const items = [];
  for (const p of design.parts) {
    const d = PARTS[p.id]; if (!d) continue;
    const info = partInfo(p.id); partMatrix(p, m);
    const c = info.centroid.clone().applyMatrix4(m);
    const pm = partMass(p); mass += pm; com.addScaledVector(c, pm);
    items.push({ p, d, info, m: m.clone(), c });
  }
  if (mass > 0) com.divideScalar(mass);
  const n = new THREE.Vector3(), pos = new THREE.Vector3();
  for (const { p, d, info, m: mm } of items) {
    if (d.gear && !d.gear.float) { wheels++; if (d.gear.drive) driveWheels++; }
    if (d.engine?.type === 'drive') { motors++; engines++; drivePower += d.engine.thrust * thrustScale(p) * partPower(p); }
    else if (d.engine?.type === 'tailrotor') tailRotors++;
    else if (d.engine?.type === 'rotor') {
      engines++; rotors++;
      const t = d.engine.thrust * thrustScale(p) * partPower(p), at = info.center.clone().applyMatrix4(mm);
      rotorLift += t; rotorAt.addScaledVector(at, t); twist += (p.mirror ? -1 : 1) * t;
    } else if (d.engine) {
      engines++; if (d.engine.type === 'jet') jets++; else if (d.engine.type === 'rocket') rockets++; else props++;
      const t = (d.engine.ab || d.engine.thrust) * thrustScale(p) * partPower(p); thrust += t;
      latThrust += (info.center.clone().applyMatrix4(mm).x - com.x) * t;
    }
    if (d.gear) { gear++; if (d.gear.float && !d.gear.skid) floats++; } // skids float but are not a seaplane
    if (d.smoke) smoke++;
    for (const s0 of info.surfaces) {
      const s = scaleSurface(s0, partScale(p));
      n.set(...s.n).transformDirection(mm); pos.set(...s.pos).applyMatrix4(mm);
      const horiz = Math.abs(n.y);
      wingArea += s.area * horiz; finArea += s.area * Math.abs(n.x);
      const eff = (s.ar < 4 ? 0.7 : 1) * (pos.z > com.z + 2 ? 0.55 : 1); // tail sits in downwash
      lift.addScaledVector(pos, s.area * horiz * eff); liftW += s.area * horiz * eff;
      latLift += (pos.x - com.x) * s.area * horiz;
      const r = pos.clone().sub(com), t = r.clone().cross(n);
      ctrl.pitch += Math.abs(t.x) * s.area; ctrl.roll += Math.abs(t.z) * s.area; ctrl.yaw += Math.abs(t.y) * s.area;
    }
  }
  if (rotorLift > 0) { rotorAt.divideScalar(rotorLift); rotorOff = Math.hypot(rotorAt.x - com.x, rotorAt.z - com.z); }
  const hover = mass > 0 ? rotorLift / (mass * G) : 0, heli = rotors > 0, car = motors > 0 && !heli;
  const grip = mass > 0 ? drivePower / (mass * G) : 0;
  const col = liftW > 0 ? lift.divideScalar(liftW) : com.clone();
  const mac = wingArea > 0 ? Math.sqrt(wingArea / 7) : 1;
  const margin = (col.z - com.z) / mac; // + = stable (lift centre behind CoM)
  const stall = wingArea > 0 ? Math.sqrt((2 * mass * G) / (RHO * wingArea * 1.4)) : Infinity;
  const tw = mass > 0 ? thrust / (mass * G) : 0;
  const warnings = [];
  if (!design.parts.length) warnings.push(['info', 'Start by adding a body from the parts list.']);
  else {
    if (heli) {
      if (hover < 1.05) warnings.push(['bad', 'The rotor can’t lift this much. Use a bigger rotor, more Power, or a lighter build.']);
      else if (hover < 1.3) warnings.push(['warn', 'Only just enough rotor lift: it will be slow to climb.']);
      if (Math.abs(twist) > rotorLift * 0.2 && !tailRotors) warnings.push(['bad', 'No tail rotor: it will spin round and round! Put one at the end of the tail.']);
      if (rotorAt.y < com.y) warnings.push(['warn', 'The rotor is below the middle of the helicopter. Mount it on top.']);
      if (rotorOff > 0.4) warnings.push(['warn', 'The rotor isn’t over the middle, so it will tip. Move it over the yellow dot.']);
      if (!gear) warnings.push(['info', 'No skids: it will sit on its belly. Add Helicopter Skids from Gear.']);
      if (hover >= 1.05 && rotorAt.y >= com.y && rotorOff <= 0.4 && (tailRotors || Math.abs(twist) <= rotorLift * 0.2)) warnings.push(['good', 'Ready to hover! Throttle to the middle to hold height.']);
    }
    else if (car) {
      if (!driveWheels) warnings.push(['bad', 'The Car Engine needs Car Wheels to push on. Add some from the Car tab.']);
      else if (wheels < 3) warnings.push(['warn', 'Fewer than 3 wheels: it will tip over. Use 4.']);
      if (driveWheels && !design.parts.some((q) => PARTS[q.id]?.gear?.steer)) warnings.push(['warn', 'Nothing steers. Use Steering Wheels at the front.']);
      if (grip < 0.25 && driveWheels) warnings.push(['warn', 'Heavy for its engine: it will be slow. Add Power or another engine.']);
      if (driveWheels && wheels >= 3) warnings.push(['good', 'Ready to drive! Throttle to go, stick to steer, pull the stick back to reverse.']);
    }
    else if (!engines) warnings.push(['info', 'No engines: it’s a glider. It will start in the air.']);
    const plane = !heli && !(car && wingArea < 0.5);
    if (plane && wingArea < 0.5) warnings.push(['bad', 'No wings. Only Arcade mode will get this off the ground.']);
    if (plane && wingArea > 0.5 && margin < -0.02) warnings.push(['bad', 'Tail-heavy: the centre of mass is behind the lift. Expect flips in Sim mode. Move wings back or add weight up front.']);
    else if (plane && margin > 0.6) warnings.push(['warn', 'Very nose-heavy. It will be hard to lift the nose. Move wings forward.']);
    if (plane && finArea < 0.4 && wingArea > 0.5) warnings.push(['warn', 'No vertical fin: it will yaw around in Pilot and Sim modes.']);
    if (plane && tw > 0 && tw < 0.18) warnings.push(['warn', 'Underpowered. Add engines or lose weight.']);
    if (plane && tw > 1.2) warnings.push(['good', 'Thrust-to-weight over 1: it can climb straight up!']);
    if (plane && !gear) warnings.push(['info', 'No landing gear: it will belly-slide on take-off. Starting in the air is easier.']);
    if (plane && (Math.abs(latLift) > wingArea * 0.4 || Math.abs(latThrust) > thrust * 0.3)) warnings.push(['warn', 'Lopsided! It will roll or yaw in Sim mode (Arcade forgives this).']);
    if (plane && stall < 40 && tw > 0.2 && margin >= -0.02 && margin <= 0.6 && finArea >= 0.4) warnings.push(['good', 'Looks flyable. Have fun!']);
  }
  return { car, grip, motors, driveWheels, wheels, heli, hover, rotors, tailRotors, mass, com, col, margin, stall, thrust, tw, wingArea, finArea, engines, props, jets, rockets, gear, floats, smoke, ctrl, warnings };
}

// ---------- presets ----------
function wingLE(id, s) { // leading edge point (part-local) at span fraction s
  const o = PARTS[id].wing; const dih = THREE.MathUtils.degToRad(o.dihedral || 0);
  const chord = o.planform === 'ellipse' ? Math.max(o.tip, o.root * Math.sqrt(1 - s * s)) : o.root + (o.tip - o.root) * s;
  const le = o.planform === 'ellipse' ? -o.root / 2 + (o.root - chord) * 0.25 + o.sweep * s : -o.root / 2 + o.sweep * s;
  return { x: s * o.span * Math.cos(dih), y: s * o.span * Math.sin(dih), z: le, chord };
}

class PB {
  constructor(name, desc) { this.d = { name, desc, parts: [] }; }
  add(id, pos, o = {}) { this.d.parts.push(newPart(id, pos, o)); return this.d.parts.length - 1; }
  pair(id, pos, o = {}) {
    const i = this.add(id, pos, o); const m = mirroredOf(this.d.parts[i]);
    const par = this.d.parts[m.parent], sib = this.d.parts[m.parent + 1];
    if (par && sib && sib.id === par.id && sib.mirror !== par.mirror && Math.abs(sib.pos[0] + par.pos[0]) < 1e-6) m.parent = m.parent + 1;
    this.d.parts.push(m); return [i, i + 1];
  }
  // engines hung under a wing (pair) at span fraction s
  underWing(eid, wid, wingIdx, wpos, s, drop, fwd, o = {}) {
    const le = wingLE(wid, s);
    return this.pair(eid, [wpos[0] + le.x, wpos[1] + le.y - drop, wpos[2] + le.z - fwd], { parent: wingIdx, ...o });
  }
}

export function makePresets() {
  const P = [];
  { // Kestrel — high-wing trainer
    const b = new PB('Kestrel', 'Friendly high-wing trainer. The best first plane.');
    const f = b.add('fus_light', [0, 0, 0]);
    b.add('e_piston', [0, 0, -4.1], { parent: f, color: 0xc8102e });
    b.add('ck_bubble', [0, 0.62, -2.15], { parent: f });
    const w = b.pair('w_trainer', [0, 0.8, -0.7], { parent: f });
    b.pair('t_hstab', [0, 0.05, 3.75], { parent: f, color: 0xc8102e });
    b.add('t_vfin', [0, 0.18, 3.55], { parent: f, color: 0xc8102e });
    b.add('g_nose', [0, -0.68, -2.55], { parent: f });
    b.pair('g_main', [0.55, -0.52, -0.25], { parent: f, rot: [0, 0, 24] });
    const tip = wingLE('w_trainer', 1);
    b.add('x_navlight', [tip.x + 0.05, 0.8 + tip.y, -0.7], { parent: w[0] }); b.add('x_navlight', [-tip.x - 0.05, 0.8 + tip.y, -0.7], { parent: w[1] });
    b.add('x_landlight', [0, -0.55, -3.0], { parent: f });
    P.push(b.d);
  }
  { // Viper — jet fighter
    const b = new PB('Viper', 'Afterburning jet fighter. Fast, twitchy, loud.');
    const f = b.add('fus_fighter', [0, 0, 0]);
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f });
    const w = b.pair('w_swept', [0.95, -0.15, 1.3], { parent: f });
    b.add('e_jet_ab', [0, 0, 1.5], { parent: f });
    b.pair('t_jet_hstab', [0.6, -0.05, 4.7], { parent: f });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f });
    b.add('g_retract_nose', [0, -0.3, -3.9], { parent: f });
    b.pair('g_retract', [1.7, -0.3, 2.5], { parent: f });
    b.pair('x_tank', [3.2, -0.65, 1.7], { parent: w[0] });
    b.add('x_smoke', [0, -0.75, 4.2], { parent: f, color: 0xc8102e });
    P.push(b.d);
  }
  { // Tempest — warbird taildragger
    const b = new PB('Tempest', 'Radial-engined warbird taildragger with an elliptical wing.');
    const f = b.add('fus_sport', [0, 0, 0], { color: 0x5a6b45 });
    b.add('e_radial', [0, 0.05, -3.95], { parent: f, color: 0x5a6b45 });
    b.add('ck_bubble', [0, 0.45, -0.6], { parent: f, color: 0x5a6b45 });
    b.pair('w_ellipse', [0.25, -0.3, -1.3], { parent: f, color: 0x5a6b45 });
    b.pair('t_hstab', [0, 0.05, 2.9], { parent: f, color: 0x5a6b45 });
    b.add('t_vfin', [0, 0.15, 2.7], { parent: f, color: 0x5a6b45 });
    b.pair('g_main', [1.3, -0.35, -2.35], { parent: f });
    b.add('g_tail', [0, -0.18, 2.9], { parent: f });
    P.push(b.d);
  }
  { // Twin Pod — two fuselages joined by a wing
    const b = new PB('Twin Pod', 'Two fuselages joined by one wing. Double the fun.');
    const f = b.add('fus_sport', [-2.4, 0, 0], { color: 0x1d4e89 });
    const c = b.pair('w_stub', [0, -0.05, -0.3], { parent: f, color: 0xf2f2ee });
    const f2 = b.add('fus_sport', [2.4, 0, 0], { parent: c[0], color: 0x1d4e89 });
    for (const [x, par] of [[-2.4, f], [2.4, f2]]) {
      b.add('e_piston', [x, 0, -3.5], { parent: par, color: 0xf2f2ee });
      b.add('t_vfin', [x, 0.15, 2.6], { parent: par, color: 0xf2b705 });
      b.add('g_main', [x, -0.3, -0.9], { parent: par });
      b.add('g_tail', [x, -0.15, 2.8], { parent: par });
    }
    b.add('t_hstab', [-2.4, 0.05, 2.75], { parent: f, color: 0xf2f2ee });
    b.add('t_hstab', [2.4, 0.05, 2.75], { parent: f2, color: 0xf2f2ee, mirror: true });
    b.add('w_taper', [2.85, -0.05, -0.3], { parent: f2 });
    b.add('w_taper', [-2.85, -0.05, -0.3], { parent: f, mirror: true });
    b.add('ck_bubble', [-2.4, 0.42, -0.9], { parent: f });
    b.add('ck_bubble', [2.4, 0.42, -0.9], { parent: f2 });
    P.push(b.d);
  }
  { // Albatross — seaplane
    const b = new PB('Albatross', 'Float plane. Take off and land on water!');
    const f = b.add('fus_light', [0, 0, 0], { color: 0xf2b705 });
    b.add('e_piston', [0, 0, -4.1], { parent: f, color: 0x1b2a41 });
    b.add('ck_bubble', [0, 0.62, -2.15], { parent: f });
    b.pair('w_trainer', [0, 0.8, -0.65], { parent: f, color: 0xf2b705 });
    b.pair('t_hstab', [0, 0.05, 3.75], { parent: f, color: 0x1b2a41 });
    b.add('t_vfin', [0, 0.18, 3.55], { parent: f, color: 0x1b2a41 });
    b.pair('g_float', [0.62, -0.45, -1.0], { parent: f });
    P.push(b.d);
  }
  { // Jumbo — 4-engine airliner
    const b = new PB('Jumbo', 'Four-engine airliner. Heavy, stable, majestic.');
    const f = b.add('fus_airliner', [0, 0, 0]);
    b.add('ck_airliner', [0, 0, -11], { parent: f });
    const wp = [1.5, -0.9, -1.5];
    const w = b.pair('w_airliner', wp, { parent: f });
    b.underWing('e_turbofan', 'w_airliner', w[0], wp, 0.32, 1.6, 2.2);
    b.underWing('e_turbofan', 'w_airliner', w[0], wp, 0.62, 1.2, 2.0);
    b.pair('t_big_hstab', [0.6, 0.6, 9.8], { parent: f });
    b.add('t_big_vfin', [0, 1.4, 8.4], { parent: f });
    b.add('g_retract_nose', [0, -1.9, -8.0], { parent: f });
    b.pair('g_bogie', [2.6, -0.5, 1.2], { parent: w[0] });
    P.push(b.d);
  }
  { // Centipede — 14 engines
    const b = new PB('Centipede', 'Fourteen engines. Props AND jets. Because why not.');
    const f = b.add('fus_airliner', [0, 0, 0], { color: 0x7b2d8b });
    b.add('ck_airliner', [0, 0, -11], { parent: f, color: 0x7b2d8b });
    const wp = [1.5, 0.6, -1.0];
    const w = b.pair('w_airliner', wp, { parent: f, color: 0xf2f2ee });
    for (const s of [0.18, 0.32, 0.46, 0.6, 0.74, 0.88]) b.underWing('e_turboprop', 'w_airliner', w[0], wp, s, 0.75 - s * 0.35, 1.2, { color: 0xf2b705 });
    b.pair('e_jet_small', [2.4, 1.2, 6.5], { parent: f, color: 0xf2f2ee });
    b.pair('t_big_hstab', [0.6, 0.6, 9.8], { parent: f, color: 0xf2f2ee });
    b.add('t_big_vfin', [0, 1.4, 8.4], { parent: f, color: 0xf2b705 });
    b.add('g_retract_nose', [0, -1.9, -8.0], { parent: f });
    b.pair('g_bogie', [2.0, -0.5, 1.5], { parent: f });
    b.pair('x_smoke', [7, 0.9, 2.5], { parent: w[0], color: 0xf2b705 });
    P.push(b.d);
  }
  { // Kite — glider
    const b = new PB('Kite', 'Sailplane. No engine: find rising air over hills and glide forever.');
    const f = b.add('fus_glider', [0, 0, 0]);
    b.add('ck_bubble', [0, 0.32, -1.0], { parent: f });
    b.pair('w_glider', [0, 0.25, 0.7], { parent: f });
    b.pair('t_hstab', [0, 0.85, 5.5], { parent: f, color: 0xc8102e });
    b.add('t_vfin', [0, 0.05, 5.1], { parent: f, color: 0xc8102e });
    b.add('g_main', [0, -0.35, 1.05], { parent: f });
    b.add('g_nose', [0, -0.3, -1.4], { parent: f });
    P.push(b.d);
  }
  { // Firecracker — rocket delta
    const b = new PB('Firecracker', 'Delta wing + two rocket boosters + a jet. Hold on tight.');
    const f = b.add('fus_fighter', [0, 0, 0], { color: 0xf2f2ee });
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f, color: 0xf2f2ee });
    b.pair('w_delta', [0.9, -0.2, 2.6], { parent: f, color: 0xe8601c });
    b.add('e_jet_ab', [0, 0, 1.5], { parent: f });
    b.pair('e_rocket', [1.3, 0.55, 2.0], { parent: f });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f, color: 0xe8601c });
    b.add('g_retract_nose', [0, -0.35, -3.9], { parent: f });
    b.pair('g_retract', [1.9, -0.35, 3.0], { parent: f });
    b.pair('x_smoke', [4.9, -0.2, 6.8], { parent: f, color: 0xe8601c });
    P.push(b.d);
  }
  { // Dragonfly — light helicopter
    const b = new PB('Dragonfly', 'Light helicopter. Throttle to the middle to hover, stick to fly around.');
    const f = b.add('fus_pod', [0, 0, 0], { color: 0xf2b705 });
    b.add('x_nosecone', [0, 0, -1.6], { parent: f, color: 0xf2b705 });
    b.add('ck_bubble', [0, 0.45, -0.6], { parent: f });
    const boom = b.add('fus_boom', [0, 0.2, 4.6], { parent: f, color: 0xf2b705 });
    b.add('t_vfin', [0, 0.25, 7.3], { parent: boom, color: 0x111111 });
    b.add('r_tail', [0.12, 0.75, 7.9], { parent: boom });
    b.add('r_main', [0, 0.55, 1.44], { parent: f });
    b.pair('g_skid', [0.6, -0.4, 0.3], { parent: f });
    P.push(b.d);
  }
  { // Dune Buggy — a car
    const b = new PB('Dune Buggy', 'A fast little car. Throttle to go, stick to steer, pull back to reverse.');
    const f = b.add('fus_pod', [0, 0, 0], { color: 0xe8601c });
    b.add('x_nosecone', [0, 0, -1.6], { parent: f, color: 0xe8601c });
    b.add('ck_open', [0, 0.45, -0.2], { parent: f });
    b.add('c_motor', [0, 0.35, 1.2], { parent: f });
    b.pair('c_wheel_steer', [0.78, -0.2, -1.1], { parent: f });
    b.pair('c_wheel', [0.78, -0.2, 1.1], { parent: f });
    P.push(b.d);
  }
  { // Stardust — rocket plane for the edge of space
    const b = new PB('Stardust', 'Rocket plane for the edge of space. Full throttle, pull up until you point at the sky, and hold on!');
    const f = b.add('fus_fighter', [0, 0, 0], { color: 0x1b1b1f });
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f, color: 0x1b1b1f });
    b.pair('w_swept', [0.95, -0.15, 1.3], { parent: f, color: 0x1b1b1f });
    const r = b.add('e_rocket', [0, 0, 1.9], { parent: f, color: 0xf2f2ee });
    Object.assign(b.d.parts[r], { power: 2.5, burn: 65 });
    b.pair('t_jet_hstab', [0.6, -0.05, 4.7], { parent: f, color: 0x1b1b1f });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f, color: 0x1b1b1f });
    b.add('x_rcs', [0, 0.1, -5.2], { parent: f, color: 0xf2f2ee });
    b.add('g_retract_nose', [0, -0.3, -3.9], { parent: f });
    b.pair('g_retract', [1.7, -0.3, 2.5], { parent: f });
    P.push(b.d);
  }
  return P;
}

export function cloneDesign(d) { return JSON.parse(JSON.stringify(d)); }
export function encodeDesign(d) {
  const slim = { n: d.name, p: d.parts.map((p) => [p.id, p.pos.map((v) => +v.toFixed(3)), p.quat.map((v) => +v.toFixed(4)), p.mirror ? 1 : 0, p.color, p.parent, ...(p.scale || p.power != null || p.burn != null ? [p.scale ? p.scale.map((v) => +v.toFixed(3)) : 0] : []), ...(p.power != null || p.burn != null ? [{ w: p.power, b: p.burn }] : [])]) };
  return btoa(unescape(encodeURIComponent(JSON.stringify(slim))));
}
const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
const tuneOf = (t) => (t && typeof t === 'object' ? { ...(inRange(t.w, POWER_RANGE) ? { power: t.w } : {}), ...(inRange(t.b, BURN_RANGE) ? { burn: t.b } : {}) } : {});
export function decodeDesign(s) {
  const slim = JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
  return { name: slim.n || 'Imported', parts: slim.p.filter((a) => PARTS[a[0]]).map((a) => ({ id: a[0], pos: a[1], quat: a[2], mirror: !!a[3], color: a[4], parent: a[5], ...(Array.isArray(a[6]) && a[6].length === 3 && a[6].every((v) => Number.isFinite(v) && v > 0) ? { scale: a[6] } : {}), ...tuneOf(a[7]) })) };
}
