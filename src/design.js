// Design model: a list of parts with transforms + parent links. Presets and analysis.
import * as THREE from 'three';
import { PARTS, partInfo } from './parts.js';
import './vehicleParts.js';
import { DIRT_AT, SPORT_AT } from './bikeParts.js';
import { bikeLayout } from './bike.js';
import './supersonicParts.js';
import { BOAT_AT } from './boatParts.js';
import { boatLayout } from './boat.js';
import './stockLiveries.js';
import { LIVERIES } from './liveries.js';

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

// ---------- symmetry ----------
// A part can have symmetric copies: Mirror (2) reflects it across the centreline (x = 0, the copy carries the mirror
// flag); 3 and 4 copy it round the vehicle's long axis (radial symmetry: rocket fins, boosters and engines, an X tail).
// The copies are ordinary parts (physics, analyze() and save codes see each one on its own), and they are linked only
// by where they sit, as mirrored pairs always were, so old designs and share codes need nothing new.
export const SYM_MODES = [0, 2, 3, 4]; // off, mirror, 3-way, 4-way
// The long axis radial copies turn about: parallel to z through the centreline (x = 0) at the height of the root body's
// centre (a rocket's or fuselage's middle).
export function symAxis(design) {
  const r = design.parts[0]; if (!r || !PARTS[r.id]) return [0, 0];
  return [0, partInfo(r.id).center.clone().applyMatrix4(partMatrix(r)).y];
}
const _zAxis = new THREE.Vector3(0, 0, 1);
// p turned by ang (radians) about the long axis
export function rotatedOf(p, ang, axis = [0, 0]) {
  const c = Math.cos(ang), s = Math.sin(ang), dx = p.pos[0] - axis[0], dy = p.pos[1] - axis[1];
  const q = new THREE.Quaternion().setFromAxisAngle(_zAxis, ang).multiply(new THREE.Quaternion(...p.quat));
  const m = { ...p, pos: [+(axis[0] + dx * c - dy * s).toFixed(4), +(axis[1] + dx * s + dy * c).toFixed(4), p.pos[2]], quat: [q.x, q.y, q.z, q.w] };
  if (p.scale) m.scale = [...p.scale];
  return m;
}
// The other n - 1 copies of p for symmetry n (each a function of the edited original, so edits can be passed on)
export function symMakers(n, axis) {
  if (n === 2) return [(p) => mirroredOf(p)];
  if (n < 2) return [];
  return Array.from({ length: n - 1 }, (_, k) => (p) => rotatedOf(p, ((k + 1) * 2 * Math.PI) / n, axis));
}
// distance of a part from the long axis (an on-axis part gets no radial copies; an on-centreline one no mirror twin)
export const offAxis = (p, n, axis) => (n === 2 ? Math.abs(p.pos[0]) : Math.hypot(p.pos[0] - axis[0], p.pos[1] - axis[1]));
// round parts (bodies, round extras, engines but car motors and rotors) look the same turned about their own long axis
const roundPart = (id) => { const d = PARTS[id]; return d.cat === 'fuselage' || ROUND_EXTRAS.has(id) || (!!d.engine && !['drive', 'rotor', 'tailrotor'].includes(d.engine.type)); };
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
// does part b sit exactly where a's copy c is? (same part, same place, turned the same way, same size; a round part
// may be spun differently about its own axis, as the stock Rocket's boosters are)
export function sameSpot(c, b) {
  if (!b || b.id !== c.id || !!b.mirror !== !!c.mirror) return false;
  if (Math.hypot(b.pos[0] - c.pos[0], b.pos[1] - c.pos[1], b.pos[2] - c.pos[2]) > 0.02) return false;
  const sb = b.scale || [1, 1, 1], sc = c.scale || [1, 1, 1];
  if (!sb.every((v, k) => Math.abs(v - sc[k]) < 0.01)) return false;
  _qa.set(...c.quat); _qb.set(...b.quat);
  if (Math.abs(_qa.dot(_qb)) > 0.9995) return true;
  if (!roundPart(c.id) || Math.abs(sb[0] - sb[1]) > 0.01) return false;
  const d = _qa.invert().multiply(_qb); // b relative to c, in c's frame: a pure spin about local z?
  return Math.hypot(d.x, d.y) < 0.012;
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
// Rocket bodies make the whole build a rocket: it steers like one (stick = nose left/right/up/down on screen, the rudder
// rolls) and, without main wings, launches standing up.
const ROCKET_BODIES = new Set(['fus_rocket']);
export const isRocketDesign = (design) => design.parts.some((p) => ROCKET_BODIES.has(p.id));
// A land vehicle with no engine at all (a kid took the motor out): car or bike wheels, no wings, no boat hull, no rocket
// body. It is still a car or bike (aircraft.js isCar, analyze().car): it starts on the ground and rolls (downhill, or
// off a ramp) instead of turning into a glider dropped from the sky.
export const coastsOnWheels = (design) => { const ds = design.parts.map((p) => PARTS[p.id]).filter(Boolean);
  return ds.some((d) => d.gear && !d.gear.float && (d.cat === 'car' || d.cat === 'bike')) && !ds.some((d) => d.engine || d.cat === 'wing' || d.boatHull) && !isRocketDesign(design); };
export const launchesVertical = (design) => !!design.vertical || (isRocketDesign(design) && !design.parts.some((p) => PARTS[p.id]?.cat === 'wing'));

export function analyze(design) {
  const m = new THREE.Matrix4(), com = new THREE.Vector3();
  let drivePower = 0, motors = 0, driveWheels = 0, wheels = 0; const wheelAt = [];
  let rotorLift = 0, rotors = 0, tailRotors = 0, twist = 0, rotorOff = 0; const rotorAt = new THREE.Vector3();
  let mass = 0, thrust = 0, wingArea = 0, finArea = 0, engines = 0, props = 0, jets = 0, rockets = 0, gear = 0, floats = 0, smoke = 0, marine = 0;
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
    if (d.gear && !d.gear.float) { wheels++; if (d.gear.drive) driveWheels++; wheelAt.push({ x: mm.elements[12], z: mm.elements[14], d: d.gear }); }
    if (d.engine?.type === 'drive') { motors++; engines++; drivePower += d.engine.thrust * thrustScale(p) * partPower(p); }
    else if (d.engine?.type === 'tailrotor') tailRotors++;
    else if (d.engine?.type === 'rotor') {
      engines++; rotors++;
      const t = d.engine.thrust * thrustScale(p) * partPower(p), at = info.center.clone().applyMatrix4(mm);
      rotorLift += t; rotorAt.addScaledVector(at, t); twist += (p.mirror ? -1 : 1) * t;
    } else if (d.engine?.type === 'marine') { engines++; marine++; } // boat motors (boat.js)
    else if (d.engine) {
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
  const hover = mass > 0 ? rotorLift / (mass * G) : 0, heli = rotors > 0, car = (motors > 0 || coastsOnWheels(design)) && !heli;
  const grip = mass > 0 ? drivePower / (mass * G) : 0;
  const bike = car && bikeLayout(wheelAt); // two in-line wheels on the centreline: it rides like a motorbike (bike.js)
  const boat = !heli && design.parts.some((p) => PARTS[p.id]?.boatHull) ? boatLayout(design, mass, partMatrix) : null; // a boat hull: it floats (boat.js)
  const col = liftW > 0 ? lift.divideScalar(liftW) : com.clone();
  const mac = wingArea > 0 ? Math.sqrt(wingArea / 7) : 1;
  const margin = (col.z - com.z) / mac; // + = stable (lift centre behind CoM)
  const stall = wingArea > 0 ? Math.sqrt((2 * mass * G) / (RHO * wingArea * 1.4)) : Infinity;
  const tw = mass > 0 ? thrust / (mass * G) : 0;
  const rocket = isRocketDesign(design) && !heli && !car, vertical = !!design.vertical || (rocket && launchesVertical(design));
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
    else if (bike) {
      if (!motors) warnings.push(['warn', 'No engine: it can only roll downhill. Add an engine from the Bike tab.']);
      else if (!driveWheels) warnings.push(['bad', 'The engine needs a wheel to push on. Use a Swingarm Wheel at the back.']);
      if (!bike.front.d.steer) warnings.push(['warn', 'The front wheel doesn’t steer. Use a Fork Wheel at the front.']);
      if (motors && grip < 0.25 && driveWheels) warnings.push(['warn', 'Heavy for its engine: it will be slow. Add Power or a bigger engine.']);
      if (motors && driveWheels && bike.front.d.steer) warnings.push(['good', 'Ready to ride! Gas to go, brake to stop, steer to lean into the turns. Full gas for a wheelie!']);
    }
    else if (boat) {
      if (boat.sinks) warnings.push(['bad', 'Too heavy for its hull: it will sink! Use a bigger hull or fewer heavy parts.']);
      if (!marine) warnings.push(['bad', 'No motor. Add an Outboard Motor, a Prop & Rudder or a Water Jet from the Boat tab.']);
      for (const m of boat.motors) if (!m.wet) warnings.push(['warn', `The ${PARTS[m.id].name}'s propeller is out of the water. Put it at the back, down low.`]);
      if (marine && !boat.sinks && boat.motors.some((m) => m.wet)) warnings.push(['good', 'Ready to go boating! Gas to go, brake to slow down (keep holding it to reverse), stick to steer.']);
    }
    else if (car) {
      if (!motors) warnings.push(['warn', 'No engine: it can only roll downhill. Add a Car Engine from the Car tab.']);
      else if (!driveWheels) warnings.push(['bad', 'The Car Engine needs Car Wheels to push on. Add some from the Car tab.']);
      else if (wheels < 3) warnings.push(['warn', 'Fewer than 3 wheels: it will tip over. Use 4.']);
      if (driveWheels && !design.parts.some((q) => PARTS[q.id]?.gear?.steer)) warnings.push(['warn', 'Nothing steers. Use Steering Wheels at the front.']);
      if (motors && grip < 0.25 && driveWheels) warnings.push(['warn', 'Heavy for its engine: it will be slow. Add Power or another engine.']);
      if (motors && driveWheels && wheels >= 3) warnings.push(['good', 'Ready to drive! Gas to go, brake to stop (keep holding it to reverse), stick to steer.']);
    }
    else if (!engines) warnings.push(['info', 'No engines: it’s a glider. It will start in the air.']);
    if (rocket && !vertical) warnings.push(['info', 'Rocket plane: it steers like a rocket when the nose is up or the rockets are burning, and like a plane when the wings carry it.']);
    const plane = !heli && !(car && wingArea < 0.5) && !vertical && !boat; // rockets launch standing up
    if (vertical && engines) warnings.push(tw > 1.1 ? ['good', 'Rocket ready! It launches standing up: full throttle, keep the nose pointing at the sky.'] : ['bad', 'Not enough thrust to lift off. Add rockets or more Power.']);
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
  return { ...(bike ? { bike: true } : {}), ...(boat ? { boat: true, marine, waterline: boat.level } : {}), car, rocket, vertical, grip, motors, driveWheels, wheels, heli, hover, rotors, tailRotors, mass, com, col, margin, stall, thrust, tw, wingArea, finArea, engines, props, jets, rockets, gear, floats, smoke, ctrl, warnings };
}

// ---------- presets ----------
// Every stock vehicle wears a livery (stockLiveries.js): design.livery names its key.
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
    b.d.livery = 'kestrel';
    const f = b.add('fus_light', [0, 0, 0]);
    b.add('e_piston', [0, 0, -4.1], { parent: f, color: 0xc8102e });
    b.add('ck_bubble', [0, 0.62, -2.15], { parent: f });
    const w = b.pair('w_trainer', [0, 0.8, -0.7], { parent: f });
    b.pair('t_hstab', [0, 0.05, 3.75], { parent: f });
    b.add('t_vfin', [0, 0.18, 3.55], { parent: f, color: 0xc8102e });
    b.add('g_nose', [0, -0.68, -2.55], { parent: f });
    b.pair('g_main', [0.55, -0.52, -0.25], { parent: f, rot: [0, 0, 24], color: 0xc8102e });
    const tip = wingLE('w_trainer', 1);
    b.add('x_navlight', [tip.x + 0.05, 0.8 + tip.y, -0.7], { parent: w[0] }); b.add('x_navlight', [-tip.x - 0.05, 0.8 + tip.y, -0.7], { parent: w[1] });
    b.add('x_landlight', [0, -0.55, -3.0], { parent: f });
    P.push(b.d);
  }
  { // Viper — jet fighter
    const b = new PB('Viper', 'Afterburning jet fighter with a sharkmouth. Fast, twitchy, loud.');
    b.d.livery = 'viper';
    const G = 0x4b535d;
    const f = b.add('fus_fighter', [0, 0, 0], { color: G });
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f, color: G });
    const w = b.pair('w_swept', [0.95, -0.15, 1.3], { parent: f, color: G });
    b.add('e_jet_ab', [0, 0, 1.5], { parent: f, color: 0x2b2e33 });
    b.pair('t_jet_hstab', [0.6, -0.05, 4.7], { parent: f, color: G });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f, color: G });
    b.add('g_retract_nose', [0, -0.3, -3.9], { parent: f });
    b.pair('g_retract', [1.7, -0.3, 2.5], { parent: f });
    b.pair('x_tank', [3.2, -0.65, 1.7], { parent: w[0], color: G });
    b.add('x_smoke', [0, -0.75, 4.2], { parent: f, color: 0xc8102e });
    P.push(b.d);
  }
  { // Tempest — warbird taildragger
    const b = new PB('Tempest', 'Radial-engined warbird taildragger with invasion stripes and a checkerboard nose.');
    b.d.livery = 'tempest';
    const O = 0x4f5d38;
    const f = b.add('fus_sport', [0, 0, 0], { color: O });
    b.add('e_radial', [0, 0.05, -3.95], { parent: f, color: 0xf2b705 });
    b.add('ck_bubble', [0, 0.45, -0.6], { parent: f, color: O });
    b.pair('w_ellipse', [0.25, -0.3, -1.3], { parent: f, color: O });
    b.pair('t_hstab', [0, 0.05, 2.9], { parent: f, color: O });
    b.add('t_vfin', [0, 0.15, 2.7], { parent: f, color: O });
    b.pair('g_main', [1.3, -0.35, -2.35], { parent: f, color: O });
    b.add('g_tail', [0, -0.18, 2.9], { parent: f });
    P.push(b.d);
  }
  { // Twin Pod — two fuselages joined by a wing
    const b = new PB('Twin Pod', 'Two racing fuselages joined by one wing. Double the fun.');
    b.d.livery = 'twinpod';
    const f = b.add('fus_sport', [-2.4, 0, 0], { color: 0x1d4e89 });
    const c = b.pair('w_stub', [0, -0.05, -0.3], { parent: f, color: 0xf2f2ee });
    const f2 = b.add('fus_sport', [2.4, 0, 0], { parent: c[0], color: 0x1d4e89 });
    for (const [x, par] of [[-2.4, f], [2.4, f2]]) {
      b.add('e_piston', [x, 0, -3.5], { parent: par, color: 0xf2b705 });
      b.add('t_vfin', [x, 0.15, 2.6], { parent: par, color: 0xf2b705 });
      b.add('g_main', [x, -0.3, -0.9], { parent: par, color: 0x1d4e89 });
      b.add('g_tail', [x, -0.15, 2.8], { parent: par });
    }
    b.add('t_hstab', [-2.4, 0.05, 2.75], { parent: f, color: 0xf2f2ee });
    b.add('t_hstab', [2.4, 0.05, 2.75], { parent: f2, color: 0xf2f2ee, mirror: true });
    b.add('w_taper', [2.85, -0.05, -0.3], { parent: f2, color: 0xf2f2ee });
    b.add('w_taper', [-2.85, -0.05, -0.3], { parent: f, mirror: true, color: 0xf2f2ee });
    b.add('ck_bubble', [-2.4, 0.42, -0.9], { parent: f, color: 0x1d4e89 });
    b.add('ck_bubble', [2.4, 0.42, -0.9], { parent: f2, color: 0x1d4e89 });
    P.push(b.d);
  }
  { // Albatross — seaplane
    const b = new PB('Albatross', 'Island-hopping float plane. Take off and land on water!');
    b.d.livery = 'albatross';
    const f = b.add('fus_light', [0, 0, 0], { color: 0xf2b705 });
    b.add('e_piston', [0, 0, -4.1], { parent: f, color: 0x0f6f7c });
    b.add('ck_bubble', [0, 0.62, -2.15], { parent: f, color: 0xf2b705 });
    b.pair('w_trainer', [0, 0.8, -0.65], { parent: f, color: 0xf2b705 });
    b.pair('t_hstab', [0, 0.05, 3.75], { parent: f, color: 0x0f6f7c });
    b.add('t_vfin', [0, 0.18, 3.55], { parent: f, color: 0x0f6f7c });
    b.pair('g_float', [0.62, -0.45, -1.0], { parent: f, color: 0xf2f2ee });
    P.push(b.d);
  }
  { // Jumbo — 4-engine airliner
    const b = new PB('Jumbo', 'Skywright Airlines four-engine airliner. Heavy, stable, majestic.');
    b.d.livery = 'airline';
    const NAVY = 0x16306e;
    const f = b.add('fus_airliner', [0, 0, 0]);
    b.add('ck_airliner', [0, 0, -11], { parent: f });
    const wp = [1.5, -0.9, -1.5];
    const w = b.pair('w_airliner', wp, { parent: f, color: 0xdfe3e8 });
    b.underWing('e_turbofan', 'w_airliner', w[0], wp, 0.32, 1.6, 2.2, { color: NAVY });
    b.underWing('e_turbofan', 'w_airliner', w[0], wp, 0.62, 1.2, 2.0, { color: NAVY });
    b.pair('t_big_hstab', [0.6, 0.6, 9.8], { parent: f, color: 0xdfe3e8 });
    b.add('t_big_vfin', [0, 1.4, 8.4], { parent: f, color: NAVY });
    b.add('g_retract_nose', [0, -1.9, -8.0], { parent: f });
    b.pair('g_bogie', [2.6, -0.5, 1.2], { parent: w[0] });
    P.push(b.d);
  }
  { // Centipede — 14 engines
    const b = new PB('Centipede', 'Fourteen engines. Props AND jets. And a big grin. Because why not.');
    b.d.livery = 'centipede';
    const f = b.add('fus_airliner', [0, 0, 0], { color: 0x6a2c91 });
    b.add('ck_airliner', [0, 0, -11], { parent: f, color: 0x6a2c91 });
    const wp = [1.5, 0.6, -1.0];
    const w = b.pair('w_airliner', wp, { parent: f, color: 0xf2f2ee });
    for (const s of [0.18, 0.32, 0.46, 0.6, 0.74, 0.88]) b.underWing('e_turboprop', 'w_airliner', w[0], wp, s, 0.75 - s * 0.35, 1.2, { color: 0xf2b705 });
    b.pair('e_jet_small', [2.4, 1.2, 6.5], { parent: f, color: 0x7bc142 });
    b.pair('t_big_hstab', [0.6, 0.6, 9.8], { parent: f, color: 0xf2f2ee });
    b.add('t_big_vfin', [0, 1.4, 8.4], { parent: f, color: 0xf2b705 });
    b.add('g_retract_nose', [0, -1.9, -8.0], { parent: f });
    b.pair('g_bogie', [2.0, -0.5, 1.5], { parent: f });
    b.pair('x_smoke', [7, 0.9, 2.5], { parent: w[0], color: 0xf2b705 });
    P.push(b.d);
  }
  { // Kite — glider
    const b = new PB('Kite', 'Sailplane. No engine: find rising air over hills and glide forever.');
    b.d.livery = 'kite';
    const f = b.add('fus_glider', [0, 0, 0]);
    b.add('ck_bubble', [0, 0.32, -1.0], { parent: f });
    b.pair('w_glider', [0, 0.25, 0.7], { parent: f });
    b.pair('t_hstab', [0, 0.85, 5.5], { parent: f });
    b.add('t_vfin', [0, 0.05, 5.1], { parent: f });
    b.add('g_main', [0, -0.35, 1.05], { parent: f });
    b.add('g_nose', [0, -0.3, -1.4], { parent: f });
    P.push(b.d);
  }
  { // Firecracker — rocket delta
    const b = new PB('Firecracker', 'Delta wing + two rocket boosters + a jet, painted with flames. Hold on tight.');
    b.d.livery = 'firecracker';
    const f = b.add('fus_fighter', [0, 0, 0], { color: 0xf2f2ee });
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f, color: 0xf2f2ee });
    b.pair('w_delta', [0.9, -0.2, 2.6], { parent: f, color: 0xe8601c });
    b.add('e_jet_ab', [0, 0, 1.5], { parent: f });
    b.pair('e_rocket', [1.3, 0.55, 2.0], { parent: f, color: 0xf2f2ee });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f, color: 0xe8601c });
    b.add('g_retract_nose', [0, -0.35, -3.9], { parent: f });
    b.pair('g_retract', [1.9, -0.35, 3.0], { parent: f });
    b.pair('x_smoke', [4.9, -0.2, 6.8], { parent: f, color: 0xe8601c });
    P.push(b.d);
  }
  { // Dragonfly — rescue helicopter
    const b = new PB('Dragonfly', 'Rescue helicopter with a bubble nose. Throttle to the middle to hover, stick to fly around.');
    b.d.livery = 'rescue';
    const f = b.add('fus_heli', [0, 0, 0], { color: 0xc8102e });
    b.add('ck_heli', [0, 0, -1.05], { parent: f, color: 0xc8102e });
    const boom = b.add('fus_boom', [0, 0.38, 4.6], { parent: f, color: 0xf2f2ee });
    b.add('t_vfin', [0, 0.43, 7.05], { parent: boom, color: 0xc8102e });
    b.add('r_tail', [0.14, 0.95, 7.65], { parent: boom });
    const r = b.add('r_main', [0, 1.12, 1.3], { parent: f, color: 0x1b1b1f });
    b.d.parts[r].power = 1.2;
    b.pair('g_skid', [0.72, -0.72, 0.35], { parent: f, color: 0x1b1b1f });
    b.add('x_landlight', [0, -1.0, -1.2], { parent: f });
    P.push(b.d);
  }
  { // Dune Buggy — an off-road racer
    const b = new PB('Dune Buggy', 'Off-road racer: giant knobby tyres, a roll cage and a supercharged V8. Throttle to go, stick to steer, pull back to reverse.');
    b.d.livery = 'buggy';
    const f = b.add('fus_buggy', [0, 0, 0], { color: 0x15161a });
    b.add('ck_open', [0, 0.36, -0.1], { parent: f, color: 0x15161a });
    const m = b.add('c_motor', [0, 0.26, 1.15], { parent: f, color: 0xc8102e });
    b.d.parts[m].power = 1.5;
    const cage = b.add('c_rollcage', [0, 0.3, 0], { parent: f, color: 0xe8601c });
    b.add('c_lightbar', [0, 1.37, -0.3], { parent: cage });
    b.add('c_rearwing', [0, 0.24, 1.9], { parent: f, color: 0x15161a });
    b.pair('c_offroad_steer', [1.08, 0.02, -1.35], { parent: f, color: 0xd9a400 });
    b.pair('c_offroad', [1.08, 0.02, 1.35], { parent: f, color: 0xd9a400 });
    P.push(b.d);
  }
  { // Stardust — rocket plane for the edge of space
    const b = new PB('Stardust', 'Black rocket plane for the edge of space. Full throttle, pull up until you point at the sky, and hold on!');
    b.d.livery = 'stardust';
    const K = 0x17181b;
    const f = b.add('fus_fighter', [0, 0, 0], { color: K });
    b.add('ck_fighter', [0, 0.6, -3.4], { parent: f, color: K });
    b.pair('w_swept', [0.95, -0.15, 1.3], { parent: f, color: K });
    const r = b.add('e_rocket', [0, 0, 1.9], { parent: f, color: 0x2a2c30 });
    Object.assign(b.d.parts[r], { power: 2.5, burn: 65 });
    b.pair('t_jet_hstab', [0.6, -0.05, 4.7], { parent: f, color: K });
    b.add('t_jet_vfin', [0, 0.55, 3.6], { parent: f, color: K });
    b.add('x_rcs', [0, 0.1, -5.2], { parent: f, color: K });
    b.add('g_retract_nose', [0, -0.3, -3.9], { parent: f });
    b.pair('g_retract', [1.7, -0.3, 2.5], { parent: f });
    P.push(b.d);
  }
  { // Chomper — monster truck
    const b = new PB('Chomper', 'Monster truck with a shark grin and wheels taller than you. Throttle to go, stick to steer, pull back to reverse.');
    b.d.livery = 'chomper';
    const f = b.add('fus_truck', [0, 0, 0], { color: 0x1565c0 });
    const m = b.add('c_motor', [0, 0.68, -1.45], { parent: f, color: 0xc0c4ca });
    b.d.parts[m].power = 2.2;
    b.add('c_lightbar', [0, 1.5, -0.05], { parent: f });
    b.pair('c_bigfoot', [1.35, 0.0, -1.75], { parent: f, color: 0xc8102e });
    b.pair('c_bigfoot', [1.35, 0.0, 1.75], { parent: f, color: 0xc8102e });
    P.push(b.d);
  }
  { // Hornet — air racer
    const b = new PB('Hornet', 'Pylon air racer: a big engine on a tiny plane, checkerboard and all. Very fast, very loud.');
    b.d.livery = 'racer';
    const Y = 0xf2b705;
    const f = b.add('fus_sport', [0, 0, 0], { color: Y });
    const e = b.add('e_piston', [0, 0, -3.45], { parent: f, color: 0x15161a });
    b.d.parts[e].power = 1.8;
    b.add('ck_bubble', [0, 0.42, 0.2], { parent: f, color: 0x15161a });
    for (const i of b.pair('w_taper', [0.25, -0.25, -0.3], { parent: f, color: Y })) b.d.parts[i].scale = [0.72, 1, 1];
    b.pair('t_hstab', [0, 0.05, 2.75], { parent: f, color: Y });
    b.add('t_vfin', [0, 0.15, 2.55], { parent: f, color: 0x15161a });
    b.pair('g_main', [1.1, -0.32, -1.15], { parent: f, color: Y });
    b.add('g_tail', [0, -0.15, 2.8], { parent: f });
    P.push(b.d);
  }
  { // Rocket — a real launcher: stands on its fins, goes straight up
    const b = new PB('Rocket', 'A real space rocket! It starts standing up. Full throttle to launch, keep it pointing up, and fly all the way to space.');
    Object.assign(b.d, { livery: 'rocket', vertical: true });
    const f = b.add('fus_rocket', [0, 0, 0], { color: 0xf2f2ee });
    const core = b.add('e_rocket', [0, 0, -2.4], { parent: f, color: 0x2a2c30 });
    Object.assign(b.d.parts[core], { scale: [2, 2, 2], power: 0.35, burn: 120 });
    for (const [x, y] of [[1.33, 0], [-1.33, 0], [0, 1.33], [0, -1.33]]) {
      const i = b.add('e_rocket', [x, y, -0.16], { parent: f, color: 0xf2f2ee });
      Object.assign(b.d.parts[i], { scale: [1.3, 1.3, 1.3], power: 0.22, burn: 40 });
    }
    for (const a of [45, 135, 225, 315]) {
      const t = THREE.MathUtils.degToRad(a), i = b.add('t_vfin', [-Math.sin(t) * 0.85, Math.cos(t) * 0.85, 3.7], { parent: f, rot: [0, 0, a], color: 0xc8102e });
      b.d.parts[i].scale = [1.4, 1.4, 1.4];
    }
    b.add('x_rcs', [0, 0, -5.0], { parent: f, color: 0xf2f2ee });
    P.push(b.d);
  }
  { // Dirt Bike — motocross: it balances itself, leans into turns and pulls wheelies
    const b = new PB('Dirt Bike', 'Motocross bike with knobby tyres and long bouncy forks. Gas to go, steer to lean into turns, full gas for a wheelie!');
    b.d.livery = 'dirtbike';
    const f = b.add('b_dirt', [0, 0, 0], { color: 0xe8601c });
    b.add('b_fork_dirt', DIRT_AT.fork, { parent: f, color: 0xe8601c });
    b.add('b_swing_dirt', DIRT_AT.rear, { parent: f });
    b.add('b_single', DIRT_AT.engine, { parent: f });
    P.push(b.d);
  }
  { // Sport Bike — a road racer: full fairing, clip-ons, a fat slick, very fast
    const b = new PB('Sport Bike', 'Racing motorbike with a full fairing and a fat slick tyre. Tuck in and go very fast. Brake hard for a stoppie!');
    b.d.livery = 'sportbike';
    const f = b.add('b_sport', [0, 0, 0], { color: 0x1d4e89 });
    b.add('b_fork_road', SPORT_AT.fork, { parent: f, color: 0x15161a });
    b.add('b_swing_road', SPORT_AT.rear, { parent: f });
    b.add('b_four', SPORT_AT.engine, { parent: f });
    P.push(b.d);
  }
  { // SR-71 Blackbird: chined body, thin delta wing, spike-inlet ramjets mid-wing, canted all-moving fins on the nacelles
    const b = new PB('SR-71 Blackbird', 'Mach 3 spy plane. It needs the whole runway! Full throttle lights the afterburners: climb above 60,000 ft and it keeps getting faster.');
    b.d.livery = 'blackbird';
    const K = 0x15171d;
    const f = b.add('fus_chine', [0, 0, 0], { color: K });
    b.add('ck_tandem', [0, 0.72, -10.6], { parent: f, color: K });
    const wp = [1.1, 0, 2.65], w = b.pair('w_delta', wp, { parent: f, color: K, rot: [2, 0, 0] });
    for (const i of w) b.d.parts[i].scale = [1.6, 1, 1.72];
    const e = b.pair('e_ramjet', [3.7, 0, -2.6], { parent: w[0], color: K });
    for (const i of b.pair('t_allmove', [3.7, 1.12, 9.9], { parent: e[0], color: K, rot: [0, 0, 15] })) b.d.parts[i].scale = [1.3, 1.05, 1.3];
    b.d.parts[b.add('g_retract_nose', [0, -0.45, -10.2], { parent: f })].scale = [1.3, 1.3, 1.3];
    for (const i of b.pair('g_retract', [2.2, -0.3, 5.2], { parent: w[0] })) b.d.parts[i].scale = [1.35, 1.35, 1.35];
    P.push(b.d);
  }
  { // Speedboat — a deep-V bowrider with a big outboard
    const b = new PB('Speedboat', 'A fast speedboat with a big outboard motor. Full gas: the bow comes up, then it zooms up on the plane!');
    const f = b.add('h_speed', [0, 0, 0], { color: 0xc8102e });
    b.add('m_outboard', BOAT_AT.speedOutboard, { parent: f });
    P.push(b.d);
  }
  { // Jet Ski — ride it like a motorbike on the water
    const b = new PB('Jet Ski', 'A zippy jet ski. Squirts water out the back to go, leans into the turns and leaves a big wake.');
    const f = b.add('h_jetski', [0, 0, 0], { color: 0xf2b705 });
    b.add('m_jet', BOAT_AT.skiJet, { parent: f });
    P.push(b.d);
  }
  { // Fireboat — a harbour fireboat with three water cannons
    const b = new PB('Fireboat', 'A big red harbour fireboat. Press the smoke button (or Space) to fire the water cannons!');
    const f = b.add('h_work', [0, 0, 0], { color: 0xc8102e });
    const wz = -0.4, wh = b.add('b_wheelhouse', [0, BOAT_AT.workDeck(wz) - 0.02, wz], { parent: f, color: 0xf2f2ee });
    b.add('b_cannon', [0, BOAT_AT.workDeck(-3.3) - 0.02, -3.3], { parent: f, color: 0xc8102e });
    b.add('b_cannon', [0, BOAT_AT.workDeck(wz) + 2.19, wz + 0.4], { parent: wh, color: 0xf2b705 });
    b.add('b_cannon', [0, BOAT_AT.workDeck(3.2) - 0.02, 3.2], { parent: f, color: 0xc8102e, rot: [0, 180, 0] });
    for (const x of [0.62, -0.62]) b.add('m_inboard', [x, BOAT_AT.workBottom(x, 2.9) + 0.01, 2.9], { parent: f });
    P.push(b.d);
  }
  { // Pontoon — the party boat
    const b = new PB('Pontoon', 'A party boat: two big tubes, comfy couches and a sunshade. Slow, steady and almost impossible to tip over.');
    const f = b.add('h_pontoon', [0, 0, 0], { color: 0x1d4e89 });
    b.add('m_outboard', BOAT_AT.pontoonOutboard, { parent: f, color: 0xf2f2ee });
    P.push(b.d);
  }
  return P;
}

export function cloneDesign(d) { return JSON.parse(JSON.stringify(d)); }
export function encodeDesign(d) {
  const slim = { n: d.name, ...(d.livery ? { l: d.livery } : {}), ...(d.vertical ? { v: 1 } : {}), p: d.parts.map((p) => [p.id, p.pos.map((v) => +v.toFixed(3)), p.quat.map((v) => +v.toFixed(4)), p.mirror ? 1 : 0, p.color, p.parent, ...(p.scale || p.power != null || p.burn != null ? [p.scale ? p.scale.map((v) => +v.toFixed(3)) : 0] : []), ...(p.power != null || p.burn != null ? [{ w: p.power, b: p.burn }] : [])]) };
  return btoa(unescape(encodeURIComponent(JSON.stringify(slim))));
}
const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
const tuneOf = (t) => (t && typeof t === 'object' ? { ...(inRange(t.w, POWER_RANGE) ? { power: t.w } : {}), ...(inRange(t.b, BURN_RANGE) ? { burn: t.b } : {}) } : {});
export function decodeDesign(s) {
  const slim = JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
  return { name: slim.n || 'Imported', ...(typeof slim.l === 'string' && LIVERIES[slim.l] ? { livery: slim.l } : {}), ...(slim.v ? { vertical: true } : {}), parts: slim.p.filter((a) => PARTS[a[0]]).map((a) => ({ id: a[0], pos: a[1], quat: a[2], mirror: !!a[3], color: a[4], parent: a[5], ...(Array.isArray(a[6]) && a[6].length === 3 && a[6].every((v) => Number.isFinite(v) && v > 0) ? { scale: a[6] } : {}), ...tuneOf(a[7]) })) };
}
