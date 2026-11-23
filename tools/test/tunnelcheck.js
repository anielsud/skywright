// Wind tunnel check, in two tiers.
//  Node (this module's nodeSuite, one case per stock vehicle): the tunnel's physics with no scene (WindTunnel.setup,
//   the same Aircraft and starting state open() makes), checked against the flight model:
//   liftCurve: sweeps the angle of attack through the tunnel's own state update and returns lift against angle; a
//     plane's lift must rise and then stall (lift falls away, STALL! shows, the tunnel's own analysis finds the angle).
//   forceMatch: puts a fresh Aircraft of the same design in free flight at the same state (attitude, airspeed,
//     controls, flaps), runs one real flight substep, takes out gravity and engine thrust, and compares the aero force
//     and moment the flight integrated with what the tunnel reports. Simulator air: no assists add forces of their own.
//  Browser (tunnelcheck.py --ui, ui() below): what needs the page, for two vehicles (see tunnelcheck.py).
import * as THREE from 'three';
import { Aircraft, REALISM, gravityAt } from '../../src/aircraft.js';
import { analyze } from '../../src/design.js';
import { WindTunnel } from '../../src/windTunnel.js';

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

export const kindOf = (s) => (s.heli ? 'heli' : s.boat ? 'boat' : s.car && s.wingArea < 0.5 ? 'car' : s.vertical ? 'rocket' : 'plane');

// The lift curve's verdict (a plane's lift rises, then stalls) and the force match's: problems, [] when good.
export function judge(kind, lc, fm) {
  const bad = [], cur = lc.curve, L = cur.map((c) => c[1]), A = cur.map((c) => c[0]);
  let k = 0; for (let j = 1; j < L.length; j++) if (L[j] > L[k]) k = j; // (the first highest: Python's max)
  if (kind === 'plane') {
    let i8 = 0; for (let j = 1; j < A.length; j++) if (Math.abs(A[j] - 8) < Math.abs(A[i8] - 8)) i8 = j;
    let rises = L[k] > L[0] + 0.2 * lc.mass; for (let j = 0; j < Math.max(0, i8); j++) if (!(L[j + 1] >= L[j] - 0.02 * Math.abs(L[k]))) rises = false;
    const stalls = A[k] < A[A.length - 1] && Math.min(...L.slice(k)) < 0.95 * L[k] && cur.slice(k).some((c) => c[3]) && lc.stallAt !== null && lc.stallAt !== undefined;
    if (!rises) bad.push(`lift curve does not rise: ${JSON.stringify(A.flatMap((a, j) => (j % 5 ? [] : [[a, Math.round(L[j])]])))}`);
    if (!stalls) bad.push(`lift curve does not stall: peak ${L[k].toFixed(0)} kg at ${A[k]} deg, ${L[L.length - 1].toFixed(0)} kg at ${A[A.length - 1]} deg`);
  }
  const worst = Math.max(0, ...fm.filter((x) => 'errF' in x).map((x) => Math.max(x.errF, x.errT)));
  if (!(worst <= 1e-6)) bad.push(`forces differ from the flight model (worst relative error ${worst.toExponential(2)}): ${JSON.stringify(fm.filter((x) => x.errF > 1e-6 || x.errT > 1e-6 || Number.isNaN(x.errF) || Number.isNaN(x.errT)).slice(0, 2))}`);
  return { bad, worst, peak: [A[k], Math.round(L[k])] };
}

// ---------- Node tier: one case per stock vehicle ----------
export const nodeSuite = { files: ['src/windTunnel.js', 'src/aircraft.js', 'src/aero*.js', 'tools/test/tunnelcheck.js'], headless: true };
export function cases({ presets }) { return presets.map((d) => ({ id: d.name })); }
export function runCase(c, { presets }) {
  const d = presets.find((p) => p.name === c.id), kind = kindOf(analyze(d));
  const t = new WindTunnel({ tier: 'low' }); t.setup(JSON.parse(JSON.stringify(d)));
  t.model = new THREE.Group(); t.flow = {}; // (physics() turns the model; analyse() reads the smoke's span for the yaw verdict only)
  t.analyse(); // (the stall angle, as the open tunnel's first frame works it out at the starting state)
  const lc = liftCurve(t), fm = forceMatch(t), { bad, worst, peak } = judge(kind, lc, fm);
  const info = `${kind}, stall ${lc.stallAt ?? '-'}°, peak ${JSON.stringify(peak)}, force err ${worst.toExponential(1)}`;
  return [{ name: `${c.id}: lift curve and forces (${info})`, ok: !bad.length, why: bad.join(' | ') || undefined, kind, stallAt: lc.stallAt, peak, force: fm, forceErr: worst }];
}

// ---------- browser: the open tunnel's page-side checks (tunnelcheck.py --ui) ----------
// Waits by frames, not seconds: n frames drawn by the page's own loop (rAF).
export const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
// the hangar settled (nothing loading or restoring) and what it holds on the GPU
export async function settle() {
  const h = window.__sky.hangar;
  for (let k = 0; k < 600 && (h.env.restoring || h.env.loading); k++) await frames(1);
  await frames(10);
  const m = window.__sky.renderer.info.memory; return { geo: m.geometries, tex: m.textures, progs: window.__sky.renderer.info.programs.length };
}
