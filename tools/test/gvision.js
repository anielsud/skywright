// G-vision and the g-driven cockpit eye (browser module, driven by gvision.py). Physics + rig + page overlay, no 3D
// rendering:
//   - the haze model (gvision.js): a crash-sized one-frame spike never shows; holding 7 g greys the view over seconds,
//     a g-suit seat (jet, space) not at 4.5 g; -3 g reds it; easing off clears it in about two seconds; and at its
//     worst the overlay never goes opaque anywhere (the view can always be seen through);
//   - in the cockpit view of every stock plane that seats a crew, a hard pull moves the eye with the pilot's head (down
//     into the seat / forward with the swing) by no more than the seat's clamp, and back once the g is off.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { GVision, gTarget } from '../../src/gvision.js';
import { stationEye } from '../../src/stations.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const flat = () => ({ groundAt: () => ({ h: 0, n: V(0, 1, 0), type: 'runway' }), maxGround: () => 0, windAt: () => V(), night: false, groundHeightAtSpawn: 0 });

// worst opacity the two layers stack to (ring edge over haze)
const worst = (gv, k) => { const Y = gv.layers[k]; return 1 - (1 - Math.max(0, Y.a)) * (1 - Math.max(0, Y.h)); };

function model() {
  const out = [], host = document.createElement('div'); document.body.append(host);
  const run = (fn) => { const gv = new GVision(host); const r = fn(gv); gv.dispose(); return r; };
  const hold = (gv, g, T, suit = false) => { for (let t = 0; t < T; t += 1 / 60) gv.step(1 / 60, g, suit, true); };
  const add = (check, ok, info) => out.push({ check, ok: !!ok, ...info });
  add('spike', ...run((gv) => { hold(gv, 1, 1); gv.step(1 / 60, 20, false, true); gv.step(1 / 60, 20, false, true); hold(gv, 1, 0.2); return [gv.grey < 0.03, { grey: +gv.grey.toFixed(3) }]; }));
  add('landing', ...run((gv) => { hold(gv, 6, 0.25); return [gv.grey < 0.1, { grey: +gv.grey.toFixed(3) }]; }));
  add('7 g held', ...run((gv) => { const at = []; for (const T of [1, 2, 4, 6]) { hold(gv, 7, T - (at.length ? [1, 2, 4, 6][at.length - 1] : 0)); at.push(+gv.grey.toFixed(2)); } return [at[0] < 0.6 && at[3] > 0.85, { grey: at, worstAlpha: +worst(gv, 'grey').toFixed(2), centre: gv.layers.grey.h }]; }));
  add('see through', ...run((gv) => { hold(gv, 12, 20); return [worst(gv, 'grey') <= 0.92 && gv.layers.grey.h <= 0.55, { worstAlpha: +worst(gv, 'grey').toFixed(3), centre: gv.layers.grey.h }]; }));
  add('g-suit 4.5 g', ...run((gv) => { hold(gv, 4.5, 6, true); return [gv.grey === 0, { grey: gv.grey }]; }));
  add('no suit 4.5 g', ...run((gv) => { hold(gv, 4.5, 6, false); return [gv.grey > 0.2, { grey: +gv.grey.toFixed(3) }]; }));
  add('-3 g red', ...run((gv) => { hold(gv, -3, 6); return [gv.red > 0.6 && gv.grey === 0 && worst(gv, 'red') < 0.9, { red: +gv.red.toFixed(3), worstAlpha: +worst(gv, 'red').toFixed(2) }]; }));
  add('recovers', ...run((gv) => { hold(gv, 9, 8); const top = gv.grey; hold(gv, 1, 2.5); return [top > 0.9 && gv.grey < 0.06 && gv.layers.grey.a < 0.05, { from: +top.toFixed(2), after: +gv.grey.toFixed(3) }]; }));
  add('chase cam hides', ...run((gv) => { hold(gv, 9, 8); gv.step(1 / 60, 9, false, false); return [gv.layers.grey.a === 0 && gv.layers.grey.h === 0 && gv.grey > 0.9, {}]; }));
  add('targets', [gTarget(1, false) === 0 && gTarget(3, false) === 0 && gTarget(-1, false) === 0 && gTarget(10, true) === 1 && gTarget(-5, false) === -1, {}][0], {});
  host.remove();
  return out;
}

// a hard pull in a plane: the eye of its pilot seat, against the seat's settled eye
function pull(design) {
  const ac = new Aircraft(design, REALISM.pilot), env = flat();
  ac.spawn(env, V(0, 0, 0), 0, {}); ac.x.y = 1500; ac.v.set(0, 0, -Math.max(70, ac.vStall ? ac.vStall * 2.2 : 120)); ac.onGround = false; ac.syncVisual();
  const st = ac.stations?.find((s) => s.crew && !s.bike); if (!st) return null;
  const gv = new GVision(document.body), dt = 1 / 60, r = { name: design.name, seat: st.name, gMax: 0, eyeMax: 0, eyeDown: 0, clamp: Math.min(0.05 * (st.s || 1), 0.4 * (st.clear ?? st.clear0 ?? 0.05)), grey: 0, finite: true };
  const up = st.up.clone().normalize(), e = V();
  for (let f = 0; f * dt < 7; f++) {
    const t = f * dt;
    ac.setControls({ pitch: t > 1 && t < 4.5 ? 1 : 0, roll: 0, yaw: 0, throttle: t < 4.5 ? 1 : 0.3, rev: 0, hand: 0 });
    ac.step(dt, env); ac.events.length = 0;
    gv.update(dt, ac, st, true);
    stationEye(st, e); const d = e.clone().sub(st.eye);
    r.finite &&= Number.isFinite(d.x + d.y + d.z);
    r.gMax = Math.max(r.gMax, gv.g); r.grey = Math.max(r.grey, gv.grey);
    r.eyeMax = Math.max(r.eyeMax, d.length()); r.eyeDown = Math.max(r.eyeDown, -d.dot(up));
    if (ac.dead || ac.wrecked) break;
  }
  r.eyeEnd = +stationEye(st, e).sub(st.eye).length().toFixed(4);
  const f = ac._crewG?.f; r.gEnd = f ? +f.clone().sub(V(0, 1, 0).applyQuaternion(ac.q)).length().toFixed(2) : 0; // (still under g at the end: a rocket burning, a plane still climbing hard)
  gv.dispose();
  r.ok = r.finite && r.eyeMax <= r.clamp + 1e-4 && (r.gMax < 2.5 || r.eyeMax > 0.004) && (r.gEnd > 0.3 || r.eyeEnd < Math.max(0.01, r.eyeMax * 0.6));
  for (const k of ['gMax', 'eyeMax', 'eyeDown', 'clamp', 'grey']) r[k] = +r[k].toFixed(3);
  return r;
}

// stick stirred about in steady flight: the head looks round but the cockpit view must hold still (it moves with g only)
function stir(design) {
  const once = (stirred) => {
    const ac = new Aircraft(design, REALISM.pilot), env = flat();
    ac.spawn(env, V(0, 0, 0), 0, {}); ac.syncVisual();
    const st = ac.stations?.find((s) => s.crew && !s.bike); if (!st) return null;
    const dt = 1 / 60, e = V(); let m = 0;
    for (let f = 0; f * dt < 3; f++) { const t = f * dt, k = stirred ? 1 : 0; ac.setControls({ pitch: Math.sin(t * 5) * 0.3 * k, roll: Math.sin(t * 3) * k, yaw: Math.sin(t * 2) * k, throttle: 0, rev: 0, hand: 1 }); ac.step(dt, env); ac.events.length = 0; m = Math.max(m, stationEye(st, e).sub(st.eye).length()); }
    return m;
  };
  const still = once(false); if (still == null) return null;
  const m = once(true); // (the vehicle settling on its wheels moves the eye in both runs: that is real g)
  return { check: 'stick stir', name: design.name, eyeMax: +m.toFixed(4), still: +still.toFixed(4), ok: m < still + 0.004 };
}

// one vehicle's cockpit-eye rows: its hard pull and its stick stir (none if it seats no crew)
export function vehicle(d) {
  const out = [];
  let r = null; try { r = pull(d); } catch (err) { out.push({ check: 'pull', name: d.name, ok: false, why: String(err?.stack || err).slice(0, 300) }); return out; }
  if (r) out.push({ check: 'pull', ...r });
  try { const q = stir(d); if (q) out.push(q); } catch (err) { out.push({ check: 'stick stir', name: d.name, ok: false, why: String(err?.stack || err).slice(0, 300) }); }
  return out;
}

// the whole test, as gvision.py prints it (the browser path)
export function plan(presets) { return [...model(), ...presets.flatMap(vehicle)]; }

// Node tier (tools/test/node/run.mjs): the haze model in one case (it only does arithmetic on numbers: the overlay's
// page elements are stand-ins in Node, and no check reads them back), then one case per vehicle. Not headless: the
// cockpit eye follows the crew rig's head, which the visual pass builds and poses.
export const nodeSuite = { files: ['src/gvision.js', 'src/stations.js', 'src/crew.js', 'src/cameras.js', 'src/aircraft.js', 'tools/test/gvision.js'], headless: false };
export function cases({ presets }) { return [{ id: 'haze model', model: true }, ...presets.map((d) => ({ id: d.name, name: d.name, key: 'crew:' + d.name, cost: 2 }))]; } // (key: riders builds the same crews)
const row = (r) => { const { check, ok, name, why, ...info } = r; return { name: `${check}${name ? ' ' + name : ''}`, ok, why: why || (ok ? '' : JSON.stringify(info)), info }; };
export function runCase(c, { presets }) { return (c.model ? model() : vehicle(presets.find((d) => d.name === c.name))).map(row); }
