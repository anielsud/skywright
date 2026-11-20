// Wind tunnel check (browser module, driven by tunnelcheck.py). Works on the open tunnel (__sky.tunnel):
//   liftCurve: sweeps the angle of attack through the tunnel's own state update and returns lift against angle.
//   forceMatch: puts a fresh Aircraft of the same design in free flight at the same state (attitude, airspeed,
//     controls, flaps), runs one real flight substep, takes out gravity and engine thrust, and compares the aero force
//     and moment the flight integrated with what the tunnel reports. Simulator air: no assists add forces of their own.
import * as THREE from 'three';
import { Aircraft, REALISM, gravityAt } from '../../src/aircraft.js';

const D2R = Math.PI / 180;

export function liftCurve(t, from = -10, to = 30, step = 1) {
  const st = t.st, keep = { aoa: st.aoa, pivot: st.pivot }; st.pivot = false; t.sweep = null;
  const out = [];
  for (let a = from; a <= to + 1e-9; a += step) { st.aoa = a; t.physics(0); out.push([a, t.Fw.y / 9.81, t.Fw.z / 9.81, t.stalled]); }
  Object.assign(st, keep); t.physics(0);
  return { curve: out, mass: t.ac.mass, stallAt: t.stallAt };
}

const STATES = [
  { aoa: 4, beta: 0, V: 50, elev: 0, ail: 0, rud: 0, flaps: 0 },
  { aoa: -6, beta: 5, V: 120, elev: 0.4, ail: -0.3, rud: 0.2, flaps: 0 },
  { aoa: 12, beta: -8, V: 35, elev: -0.6, ail: 0.7, rud: -0.5, flaps: 2 },
  { aoa: 24, beta: 3, V: 70, elev: 1, ail: 0, rud: 1, flaps: 3 },
  { aoa: 2, beta: 1, V: 450, elev: 0.2, ail: 0.1, rud: 0, flaps: 0 }, // supersonic: wave drag, limited deflection
];

// Aero force (body frame) and moment the flight model integrates in one substep at the tunnel's state.
function flightAero(design, s) {
  const ac = new Aircraft(JSON.parse(JSON.stringify(design)), REALISM.sim);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.aoa * D2R, s.beta * D2R, 0, 'YXZ'));
  ac.q.copy(q); ac.x.set(0, 0, 0); ac.v.set(0, 0, -s.V); ac.w.set(0, 0, 0); ac.trim = 0; // (the air comes from -Z, as in the tunnel)
  ac.flaps = s.flaps; ac.setControls({ pitch: s.elev, roll: s.ail, yaw: s.rud, throttle: 0 });
  const env = { windAt: () => new THREE.Vector3(), maxGround: () => -1e9, groundAt: () => ({ h: -1e9, n: new THREE.Vector3(0, 1, 0), type: 'grass' }) };
  const g = gravityAt(0, ac.v.x * ac.v.x + ac.v.z * ac.v.z); // as substep adds it, from the velocity before the step
  // (mass, CoM and inertia from before the step: a big enough load snaps a wing inside it, which changes them)
  const mass = ac.mass, com = ac.com.clone(), I = ac.I.clone(), dt = 1e-4;
  ac.substep(dt, env);
  const Fw = ac.lastAccel.clone().multiplyScalar(mass);
  Fw.y += g * mass;
  // engine thrust (jets idle at 4 %) and its moment
  const thr = new THREE.Vector3(), Tthr = new THREE.Vector3();
  for (const p of ac.parts) {
    const e = p.engine; if (!e || !p.alive || !e.thrustNow || e.type === 'drive') continue;
    const f = e.dir.clone().multiplyScalar(e.thrustNow); thr.add(f);
    Tthr.addScaledVector(e.pos.clone().sub(com).cross(f), ac.R.thrustTorque);
    if (e.type === 'prop') Tthr.addScaledVector(e.dir, -e.thrustNow * 0.035 * e.spinDir * ac.R.propTorque);
  }
  const F = Fw.applyQuaternion(q.clone().invert()).sub(thr);
  const T = ac.w.clone().divideScalar(dt).applyMatrix3(I).sub(Tthr); // dw = I⁻¹ T (w was 0, so no gyroscopic term)
  return { F, T, rotor: ac.isHeli, bike: ac.isBike, snapped: ac.stats.partsLost };
}

export function forceMatch(t) {
  const st = t.st, keep = { ...st }, out = [];
  st.pivot = false; t.sweep = null; st.air = 'sim'; t.ac.R = REALISM.sim;
  for (const s of STATES) {
    Object.assign(st, s); t.physics(0);
    const Ft = t.F.clone(), Tt = t.T.clone();
    const f = flightAero(t.design, s);
    if (f.rotor) { out.push({ state: s, skipped: 'helicopter rotor forces' }); continue; }
    if (f.bike) { out.push({ state: s, skipped: 'bike balance assist (bike.js) adds its own torques in flight' }); continue; }
    const scaleF = Math.max(1, Ft.length()), scaleT = Math.max(1, Tt.length());
    out.push({ state: s, tunnel: Ft.toArray().map((x) => +x.toFixed(3)), flight: f.F.toArray().map((x) => +x.toFixed(3)),
      errF: f.F.distanceTo(Ft) / scaleF, errT: f.T.distanceTo(Tt) / scaleT });
  }
  Object.assign(st, keep); t.ac.R = REALISM[st.air]; t.physics(0);
  return out;
}
