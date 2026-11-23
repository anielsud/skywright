// Every stock vehicle (Node suite, run by smoke.py too): built as a flight Aircraft with its cockpit views (headless:
// the visual-only assembly is meshcheck's and cockpitcheck's), then 6 s at full power the way smoke.py's flights used to drive it (throttle for planes, the gas for cars, bikes
// and boats), on flat ground (or water for a boat). It must stay finite and in one piece, a bike upright and moving, and
// its engines must have a voice the audio knows (cars, bikes and boats: their synthesized motor, motorSound.js). Every
// cockpit view cycles the way the camera button steps through them, and the button then leaves the cockpit.
// What needs the page (the real World, the frame loop, shaders, audible sound) is smoke.py's tour: one vehicle of each
// kind flown for real.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { analyze } from '../../src/design.js';
import { MOTOR, isMotor } from '../../src/motorSound.js';
import { CameraRig } from '../../src/cameras.js';

export const nodeSuite = { files: ['src/aircraft.js', 'src/design.js', 'src/parts.js', 'src/partDetail.js', 'src/stations.js', 'src/cameras.js', 'src/motorSound.js', 'src/bike*.js', 'src/boat*.js', 'src/carRig.js', 'src/rocket*.js'], headless: true };

// the engine voices audio.js plays (Audio.update: the voice kinds it starts and silences), and main.js engSound
const VOICES = new Set(['piston', 'radial', 'turboprop', 'electric', 'jet', 'fan', 'rocket', 'rotor', ...Object.keys(MOTOR)]);
const engSound = (e) => (e.type === 'rotor' ? 'rotor' : e.sound);

export function cases(ctx) { return ctx.presets.map((d) => ({ id: d.name })); }

export async function runCase(c, ctx) {
  const d = JSON.parse(JSON.stringify(ctx.presets.find((p) => p.name === c.id))), st = analyze(d), out = [];
  const check = (name, ok, why = '') => out.push({ name: `${c.id}: ${name}`, ok: !!ok, why: ok ? '' : why });
  const ac = new Aircraft(d, REALISM.pilot);
  const water = st.boat && !st.car && !st.heli;
  const env = { groundAt: () => ({ h: 0, n: new THREE.Vector3(0, 1, 0), type: water ? 'water' : 'runway' }), maxGround: () => 0, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: 0 };
  ac.spawn(env, new THREE.Vector3(0, 0, 0), 0, st.vertical ? { pitch: Math.PI / 2 } : {});
  const n0 = ac.parts.length;
  check('built', n0 > 0 && ac.stations.length > 0, `${n0} parts, ${ac.stations.length} cockpit views`);
  // the engines' voices
  const eng = ac.parts.filter((p) => p.engine), unknown = eng.map((p) => engSound(p.engine)).filter((s) => s && !VOICES.has(s)); // (no voice of its own: a tail rotor is the rotor's)
  check('engine voices known to the audio', !unknown.length, `no voice for ${unknown.join(', ')}`);
  if ((st.car || st.boat) && !st.heli) check('has a motor voice (car, bike, boat)', eng.some((p) => isMotor(p.engine.sound)), `engines: ${eng.map((p) => p.engine.sound).join(', ') || 'none'}`);
  // full power for 6 s at 60 Hz (the starter is the game's: here the engine just runs)
  ac.engineRunning = true;
  const car = (st.car || st.boat) && !st.heli;
  let bad = null, minUp = 1;
  for (let i = 0; i < 360; i++) {
    ac.setControls(car ? { pitch: 0, roll: 0, yaw: 0, throttle: 1, rev: 0, hand: 0 } : { pitch: 0, roll: 0, yaw: 0, throttle: st.heli ? 0.6 : 1 });
    ac.brake = 0; ac.step(1 / 60, env); ac.events.length = 0;
    minUp = Math.min(minUp, ac.up.y);
    if (![ac.x.x, ac.x.y, ac.x.z, ac.v.x, ac.v.y, ac.v.z, ac.q.x, ac.q.y, ac.q.z, ac.q.w].every(Number.isFinite)) { bad = `non-finite at ${(i / 60).toFixed(2)} s`; break; }
  }
  const alive = ac.parts.filter((p) => p.alive).length, speed = ac.v.length();
  check('6 s at full power: finite', !bad, bad);
  check('6 s at full power: in one piece', !bad && alive === n0 && !ac.dead, `${alive}/${n0} parts${ac.dead ? ', wrecked' : ''}`);
  if (ac.isBike) check('bike rides off upright', minUp > 0.7 && speed > 3, `up ${minUp.toFixed(2)}, ${speed.toFixed(1)} m/s`);
  // every cockpit view, as the camera button steps through them (main.js onAction 'camera': rig.next)
  const rig = new CameraRig(new THREE.PerspectiveCamera(60, 1, 0.2, 60000), { addEventListener() {}, removeEventListener() {}, style: {} });
  rig.set('cockpit', ac);
  const names = [];
  for (let k = 0; k < ac.stations.length; k++) { const s = rig.curStation(ac); names.push(s?.name); rig.next(ac); }
  check('every cockpit view cycles, then out of the cockpit', rig.mode !== 'cockpit' && names.every(Boolean) && new Set(names).size === ac.stations.length,
    `views ${names.join(', ')}; camera now ${rig.mode}`);
  return out;
}
