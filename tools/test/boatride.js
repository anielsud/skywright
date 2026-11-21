// Scripted boat rides (browser module, driven by boatride.py): the game's own Aircraft physics at 60 Hz, no rendering.
//   flat():    every stock boat, in Arcade, Pilot and Sim, on open water with a swell: it floats level, gets up on the
//              plane (a planing hull: the bow rises then levels out; a displacement hull: it reaches hull speed), turns
//              left and right, stops and stays upright. Plus: a kid's random boat builds float (and the ones with a
//              motor in the water move), a capsized boat is set upright (Arcade/Pilot), a boat on land just sits,
//              and nothing that isn't a boat is detected as one.
//   marina(F): the same ride for every stock boat from the marina's start, in a running flight's real world (water,
//              shore, the docks' collision mesh): it starts floating level, facing open water.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { PARTS } from '../../src/parts.js';
import { newPart, analyze } from '../../src/design.js';
import { hullColumns } from '../../src/boat.js';

const UP = new THREE.Vector3(0, 1, 0);
const water = (h = 0) => ({ groundAt: () => ({ h, n: UP.clone(), type: 'water' }), maxGround: () => h, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: h, waveAmp: 0.08 });
const land = (h = 0) => ({ groundAt: () => ({ h, n: UP.clone(), type: 'grass' }), maxGround: () => h, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: h });
const C = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0, ...o });
const bankOf = (ac) => Math.asin(THREE.MathUtils.clamp(new THREE.Vector3(1, 0, 0).applyQuaternion(ac.q).y, -1, 1));
const pitchOf = (ac) => Math.asin(THREE.MathUtils.clamp(ac.forward.y, -1, 1));

// one ride: script(t, ac) -> controls. Returns samples (every 0.1 s) and extremes.
export function run(design, mode, script, { T = 30, env = water(), pos = new THREE.Vector3(), heading = 0, setup = null } = {}) {
  const ac = new Aircraft(design, REALISM[mode]);
  ac.spawn(env, pos.clone(), heading);
  if (setup) setup(ac, env);
  const out = { samples: [], minUp: 1, maxSpeed: 0, maxFn: 0, events: [], start: { up: ac.up.y, pitch: pitchOf(ac), bank: bankOf(ac), wet: ac.boat?.wet ?? 0, x: ac.x.clone() } };
  let prev = Math.atan2(-ac.forward.x, -ac.forward.z), turn = 0;
  for (let f = 0; f * (1 / 60) < T; f++) {
    const t = f / 60; ac.setControls(C(script(t, ac))); ac.step(1 / 60, env);
    for (const e of ac.events.splice(0)) if (['msg', 'impact', 'wreck'].includes(e.type)) out.events.push([+t.toFixed(2), e.type, e.text || '']);
    const fw = ac.forward, h = Math.atan2(-fw.x, -fw.z); let d = h - prev; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; turn += d; prev = h;
    const spd = Math.hypot(ac.v.x, ac.v.z);
    out.minUp = Math.min(out.minUp, ac.up.y); out.maxSpeed = Math.max(out.maxSpeed, spd); out.maxFn = Math.max(out.maxFn, ac.boat?.fn ?? 0);
    if (f % 6 === 0) out.samples.push({ t: +t.toFixed(1), spd: +spd.toFixed(2), turn: +turn.toFixed(3), pitch: +pitchOf(ac).toFixed(3), bank: +bankOf(ac).toFixed(3), up: +ac.up.y.toFixed(3), wet: +(ac.boat?.wet ?? 0).toFixed(2), y: +ac.x.y.toFixed(2) });
    if (ac.dead) { out.dead = true; break; }
  }
  const s0 = out.samples[0]; Object.assign(out.start, { up: s0.up, pitch: s0.pitch, bank: s0.bank, wet: s0.wet }); // (after the first step: afloat?)
  out.final = out.samples.at(-1); out.ac = ac; out.isBoat = ac.isBoat; out.partsLost = ac.stats.partsLost;
  return out;
}
const at = (r, t) => r.samples.reduce((a, s) => (Math.abs(s.t - t) < Math.abs(a.t - t) ? s : a));
const between = (r, t0, t1) => r.samples.filter((s) => s.t >= t0 && s.t <= t1);
const deg = (x) => +(x * 57.2958).toFixed(1);

// The standard ride: full gas 0-9 s, left 9-13, right 13-17 (gas 0.8), brake / reverse to a stop 17-27, wait.
const RIDE = (k = 1) => (t, ac) => t < 9 ? { throttle: k } : t < 13 ? { throttle: 0.8 * k, roll: -1 } : t < 17 ? { throttle: 0.8 * k, roll: 1 } : t < 27 ? { rev: ac.groundSpeed > 0.25 ? 1 : 0 } : {};
// on a river (~50 m of navigable channel): up on the plane, slow down, then an S-bend (left, right, left) at low speed
const RIVER = (t, ac) => t < 6 ? { throttle: 0.6 } : t < 9 ? { rev: ac.groundSpeed > 4 ? 1 : 0, throttle: ac.groundSpeed > 4 ? 0 : 0.2 } : t < 10.5 ? { throttle: 0.25, roll: -0.7 } : t < 13.5 ? { throttle: 0.25, roll: 0.7 } : t < 15 ? { throttle: 0.25, roll: -0.7 } : t < 27 ? { rev: ac.groundSpeed > 0.25 ? 1 : 0 } : {};
function judge(name, d, r, extra = [], { river = false, sim = false } = {}) {
  const planing = r.ac.boat.planing >= 0.8, P = between(r, 0.3, river ? 6 : 9), maxPitch = Math.max(...P.map((s) => s.pitch)), cruise = at(r, river ? 5.8 : 8.5);
  const left = river ? at(r, 10.5).turn - at(r, 9).turn : at(r, 13).turn - at(r, 9).turn, right = river ? at(r, 13.5).turn - at(r, 10.5).turn : at(r, 17).turn - at(r, 13).turn, need = river ? (sim ? 0.06 : 0.2) : 0.6, /* (a heavy fireboat in Sim answers its rudder slowly at low speed) */ stop = at(r, 26.5), end = r.final;
  const conds = [
    [r.isBoat, 'not detected as a boat'], [!r.dead, 'wrecked'], [!r.partsLost, `lost ${r.partsLost} parts`],
    [r.start.wet > 0.05, 'not afloat at the start'], [Math.abs(r.start.pitch) < 0.05 && Math.abs(r.start.bank) < 0.05, `not level at the start (pitch ${deg(r.start.pitch)}°, bank ${deg(r.start.bank)}°)`],
    ...(planing ? [[r.maxFn > 1.2, `never got on the plane (Fn ${r.maxFn.toFixed(2)})`], [maxPitch > 0.06, `the bow never rose (${deg(maxPitch)}°)`], [Math.abs(cruise.pitch) < 0.09, `not level on the plane (${deg(cruise.pitch)}°)`]]
      : [[r.maxSpeed > 4.5, `slow (${r.maxSpeed.toFixed(1)} m/s)`]]),
    [left > need, `left turn ${deg(left)}°`], [right < -need, `right turn ${deg(right)}°`],
    [r.minUp > 0.7, `nearly capsized (up ${r.minUp.toFixed(2)})`], [stop.spd < 0.8, `still moving at 26.5 s (${stop.spd} m/s)`], [end.up > 0.97, `not upright at the end (${end.up})`],
    ...extra,
  ];
  const bad = conds.filter(([ok]) => !ok).map(([, w]) => w);
  return { name, ok: !bad.length, why: bad.join('; '), top: +r.maxSpeed.toFixed(1), fn: +r.maxFn.toFixed(2), bowUp: deg(maxPitch), cruise: deg(cruise.pitch), left: deg(left), right: deg(right), bank: deg(Math.max(...r.samples.map((s) => Math.abs(s.bank)))), minUp: +r.minUp.toFixed(2), planing, events: r.events.slice(0, 4) };
}

// ---------- a kid's own boats: a random hull (maybe resized), a motor where the hangar would put it, maybe extras ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export function kidBoats(n = 10, seed = 5) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], out = [];
  const hulls = Object.keys(PARTS).filter((id) => PARTS[id].boatHull), motors = ['m_outboard', 'm_jet', 'm_inboard'];
  for (let k = 0; k < n; k++) {
    const hid = pick(hulls), sc = R() < 0.5 ? null : [0.8 + R() * 0.5, 0.8 + R() * 0.5, 0.8 + R() * 0.5], parts = [newPart(hid, [0, 0, 0], { color: pick([0xc8102e, 0xf2b705, 0x1d4e89, 0x2e6b3f]) })];
    if (sc) parts[0].scale = sc;
    const s = sc || [1, 1, 1], cols = hullColumns(hid).map((c) => ({ x: c.x * s[0], z: c.z * s[2], y0: c.y0 * s[1], y1: c.y1 * s[1] }));
    const zMax = Math.max(...cols.map((c) => c.z)), stern = cols.filter((c) => c.z > zMax - 0.3 && Math.abs(c.x) < 0.5);
    const top = Math.max(...stern.map((c) => c.y1)), bot = Math.min(...stern.map((c) => c.y0)), mid = cols.filter((c) => Math.abs(c.x) < 0.4 && Math.abs(c.z - zMax * 0.5) < 0.5);
    const m = pick(motors), zT = zMax + (cols[0] ? 0.0 : 0);
    if (m === 'm_outboard') parts.push(newPart(m, [0, top, zT + 0.15], { parent: 0 }));
    else if (m === 'm_jet') parts.push(newPart(m, [0, bot + 0.02, zT + 0.15], { parent: 0 }));
    else { const b = Math.min(...cols.filter((c) => Math.abs(c.z - (zMax - 1.2)) < 0.4 && Math.abs(c.x) < 0.3).map((c) => c.y0)); parts.push(newPart(m, [0, b + 0.02, zMax - 1.6], { parent: 0 })); }
    if (R() < 0.4 && mid.length) parts.push(newPart(pick(['b_cannon', 'x_ballast', 'c_lightbar']), [0, Math.max(...mid.map((c) => c.y1)), zMax * 0.3], { parent: 0 }));
    out.push({ name: `kid boat ${k} (${hid}${sc ? ' resized' : ''}, ${m})`, parts });
  }
  return out;
}

// ---------- amphibians: a stock car or bike with a boat hull bolted underneath (just clear of the ground) ----------
export function amphibians(all) {
  const out = [];
  for (const name of ['Dirt Bike', 'Sport Bike', 'Dune Buggy']) {
    const base = all.find((d) => d.name === name); if (!base) continue;
    for (const hid of ['h_speed', 'h_pontoon']) {
      const d = JSON.parse(JSON.stringify(base)); d.name = `${name} + ${PARTS[hid].name}`; d.parts.push(newPart(hid, [0, 0, 0], { parent: 0 }));
      const probe = new Aircraft(d, REALISM.arcade), hullP = probe.parts.at(-1); // put its keel 12 cm above the tyres' bottoms
      const keel = Math.min(...hullP.hull.map((h) => h.y)), tyres = Math.min(...probe.parts.filter((p) => p.gear).flatMap((p) => p.gear.wheels.map((w) => w.top.y - w.len - w.r)));
      d.parts.at(-1).pos[1] += tyres + 0.12 - keel;
      out.push(d);
    }
  }
  return out;
}
// afloat: it floats upright and level, its wheels paddle it along slowly and it turns; on land: it drives like the car or bike
export function amphibRides(all) {
  const out = [];
  for (const d of amphibians(all)) {
    const st = analyze(d);
    const w = run(d, 'pilot', (t) => (t < 8 ? { throttle: 1 } : { throttle: 1, roll: 1 }), { T: 14 });
    const floats = !w.dead && between(w, 2, 14).every((s) => s.wet > 0.02 && s.up > 0.9), turned = -(at(w, 14).turn - at(w, 8).turn);
    out.push({ name: `${d.name}: afloat, paddles and turns`, ok: st.car && st.boat && w.ac.isCar && w.ac.isBoat && floats && w.maxSpeed > 1 && w.maxSpeed < 6 && turned > 0.25,
      why: `analyze car ${st.car} boat ${!!st.boat}, isCar ${w.ac.isCar} isBoat ${w.ac.isBoat}, floats ${floats} (min up ${w.minUp.toFixed(2)}), top ${w.maxSpeed.toFixed(2)} m/s, turned right ${(turned * 57.3).toFixed(0)}°`, top: +w.maxSpeed.toFixed(1) });
    const l = run(d, 'pilot', (t) => (t < 6 ? { throttle: 0.8 } : { rev: 1 }), { T: 10, env: land(5) });
    out.push({ name: `${d.name}: on land, drives`, ok: !l.dead && !l.partsLost && l.maxSpeed > 6 && l.final.up > 0.9, why: `dead ${!!l.dead}, parts lost ${l.partsLost}, top ${l.maxSpeed.toFixed(1)} m/s, up ${l.final.up}`, top: +l.maxSpeed.toFixed(1) });
  }
  return out;
}

export function flat(presets, others = []) {
  const out = [];
  for (const d of presets) for (const mode of ['arcade', 'pilot', 'sim']) out.push(judge(`${d.name} ${mode}: plane, turn, stop`, d, run(d, mode, RIDE(), { T: 30 })));
  // capsized: dropped in upside down, Arcade and Pilot put it back the right way up
  for (const d of presets) for (const mode of ['arcade', 'pilot']) {
    const r = run(d, mode, () => ({}), { T: 6, setup: (ac) => { ac.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.97); ac.x.y += 1; } });
    out.push({ name: `${d.name} ${mode}: capsized, self-rights`, ok: !r.dead && r.final.up > 0.97 && r.final.wet > 0.05, why: `up ${r.final.up}, wet ${r.final.wet}`, minUp: +r.minUp.toFixed(2) });
  }
  // on land: it just sits (no thrust, no damage, no explosion)
  for (const d of presets) {
    const r = run(d, 'arcade', (t) => ({ throttle: 1, roll: t > 3 ? 1 : 0 }), { T: 8, env: land(5) });
    out.push({ name: `${d.name}: on land, full gas`, ok: !r.dead && !r.partsLost && r.maxSpeed < 1.5 && r.final.spd < 0.2 && r.final.up > 0.8, why: `dead ${!!r.dead}, parts lost ${r.partsLost}, top ${r.maxSpeed.toFixed(2)} m/s, up ${r.final.up}` });
  }
  // a kid's boats: they float upright; with the motor in the water they go and turn
  for (const d of kidBoats(10, 5)) {
    const st = analyze(d), wetMotor = st.warnings.every((w) => !/out of the water/.test(w[1])), r = run(d, 'arcade', (t) => (t < 8 ? { throttle: 1 } : t < 12 ? { throttle: 0.7, roll: -1 } : {}), { T: 14 });
    const floats = !r.dead && r.final.up > 0.9 && between(r, 2, 14).every((s) => s.wet > 0.02 && s.y > -3); // (one that tips over is set upright again)
    const moves = !wetMotor || r.maxSpeed > 3;
    out.push({ name: d.name, ok: floats && moves && r.isBoat, why: `${r.isBoat ? '' : 'not a boat; '}floats ${floats} (min up ${r.minUp.toFixed(2)}), motor ${wetMotor ? 'in the water' : 'out of the water (warned)'}, top ${r.maxSpeed.toFixed(1)} m/s`, top: +r.maxSpeed.toFixed(1) });
  }
  for (const d of others) { const ac = new Aircraft(d, REALISM.arcade); out.push({ name: `${d.name}: not a boat`, ok: !ac.isBoat, why: ac.isBoat ? 'detected as a boat' : '' }); }
  return out;
}

// In a running flight's world: every stock boat from the marina's start (F.world.marina), in Arcade and Sim.
export function marina(F, presets, all = []) {
  const W = F.world, M = W.marina, out = [], loc = W.loc.id;
  if (!M) return [{ name: `${loc}: marina`, ok: false, why: 'no marina found' }];
  const s = M.start, ahead = (d) => { const p = s.pos.clone().add(new THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading)).multiplyScalar(d)); return W.groundAt(p.x, p.z).type === 'water'; };
  out.push({ name: `${loc}: marina at (${M.x.toFixed(0)}, ${M.z.toFixed(0)})${M.river ? ' on the river' : ''}, ${M.moored.length} boats moored, ${M.cm.n} solid triangles`, ok: [30, 80, 150].every(ahead), why: 'open water ahead of the start: ' + [30, 80, 150].map((d) => `${d} m ${ahead(d)}`).join(', ') });
  const river = M.river;
  // (on the narrow river: part gas, and shorter turns)
  const script = river ? RIVER : RIDE();
  for (const d of presets) for (const mode of ['arcade', 'sim']) {
    const r = run(d, mode, script, { T: 30, env: F.env, pos: s.pos, heading: s.heading });
    const fromDock = r.start.x.distanceTo(new THREE.Vector3(M.x, r.start.x.y, M.z));
    out.push(judge(`${loc} ${d.name} ${mode}`, d, r, [[fromDock < 120, `started ${fromDock.toFixed(0)} m from the marina`]], { river, sim: mode === 'sim' }));
  }
  // an amphibious bike starts afloat at the marina's start too and paddles off (it is a bike that floats)
  const ab = amphibians(all).find((d) => /Dirt Bike \+ Speedboat/.test(d.name));
  if (ab) {
    const r = run(ab, 'pilot', (t) => ({ throttle: 1 }), { T: 8, env: F.env, pos: s.pos, heading: s.heading });
    out.push({ name: `${loc}: an amphibious bike paddles off from the marina`, ok: !r.dead && r.final.up > 0.9 && r.final.wet > 0.02 && r.maxSpeed > 1, why: `dead ${!!r.dead}, up ${r.final.up}, wet ${r.final.wet}, top ${r.maxSpeed.toFixed(2)} m/s` });
  }
  // a car drives out along the pier (the docks are solid)
  const car = all.find((d) => d.name === "Dune Buggy");
  if (car && !river) {
    const p0 = M.W(0, -12), p1 = M.W(0, 30), h = Math.atan2(-(p1.x - p0.x), -(p1.z - p0.z));
    const r = run(car, 'arcade', (t) => (t < 6 ? { throttle: 0.35 } : { rev: 1 }), { T: 9, env: F.env, pos: p0, heading: h });
    const [, lz] = M.L(r.ac.x.x, r.ac.x.z), deckY = M.wl + 0.9;
    out.push({ name: `${loc}: a car drives out on the pier`, ok: !r.dead && lz > 8 && r.ac.x.y > deckY - 0.2, why: `got ${lz.toFixed(1)} m out, ${(r.ac.x.y - deckY).toFixed(2)} m above the deck` });
  }
  return out;
}
