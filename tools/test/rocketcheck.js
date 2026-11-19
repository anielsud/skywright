// Rocket handling check (browser body, driven by rocketcheck.py). No flight scene: the Rocket preset is flown on flat
// ground in still air at a fixed 1/60 s with scripted stick input, steering relative to a fixed camera behind it.
//   1. hold: in Arcade and Pilot, launch, push the stick for 1.2 s (pitch, then sideways), let go: the nose must stay
//      where it was pointed (within HOLD_DEG of where it settled 0.75 s after letting go, for the next 6 s) and must
//      not swing back towards where it started.
//   2. balance: a rocket with three fins (radial copies) flies straight up in Sim with no input: no roll and no
//      lean from the fins (a 3-way set has no net side force or roll).
const S = window.__sky, T = S.THREE;
const HOLD_DEG = 3, deg = 180 / Math.PI, dt = 1 / 60, up = new T.Vector3(0, 1, 0);
const env = { groundAt: () => ({ h: 0, n: up.clone(), type: 'runway' }), maxGround: () => 0, windAt: () => new T.Vector3(), onDebrisHit() {}, night: false, groundHeightAtSpawn: 0 };
const camQ = new T.Quaternion(); // looking north (-z), level: the stick's up/down/left/right are the screen's
const rocket = () => JSON.parse(JSON.stringify(S.presets.find((p) => p.name === 'Rocket')));
function fly(design, realism, at, dur) {
  let s = 777; Math.random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ac = new S.Aircraft(design, S.REALISM[realism]); ac.viewQ = camQ; ac.engineRunning = true;
  ac.spawn(env, new T.Vector3(0, 0, 0), 0, { pitch: Math.PI / 2 });
  const log = [];
  for (let i = 0, t = 0; t < dur; i++, t += dt) {
    const c = at(t); ac.setControls({ pitch: c.pitch || 0, roll: c.roll || 0, yaw: 0, throttle: 1 }); ac.step(dt, env);
    log.push({ t, nose: ac.forward, w: ac.w.clone(), x: ac.x.clone(), dead: ac.dead });
  }
  return log;
}
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * deg;
const res = [];
for (const realism of ['arcade', 'pilot']) for (const [name, stick] of [['pitch over', { pitch: 1 }], ['sideways', { roll: 1 }]]) {
  const t0 = 4, t1 = 5.2, log = fly(rocket(), realism, (t) => (t >= t0 && t < t1 ? stick : {}), 13);
  const at = (t) => log[Math.min(log.length - 1, Math.round(t / dt))];
  const start = at(t0).nose, rel = at(t1).nose, settle = at(t1 + 0.75).nose;
  let drift = 0, back = 0; const far = ang(start, settle);
  for (const r of log) if (r.t > t1 + 0.75) { drift = Math.max(drift, ang(r.nose, settle)); back = Math.max(back, far - ang(start, r.nose)); }
  const bad = [];
  if (log.some((r) => r.dead)) bad.push('crashed');
  if (far < 20) bad.push(`the stick only turned the nose ${far.toFixed(1)}°`);
  if (drift > HOLD_DEG) bad.push(`the nose drifted ${drift.toFixed(1)}° after letting go (limit ${HOLD_DEG}°)`);
  if (back > 2) bad.push(`the nose swung ${back.toFixed(1)}° back towards where it started`);
  res.push({ label: `${realism}: ${name}`, bad, info: `turned ${far.toFixed(1)}° (${ang(start, rel).toFixed(1)}° at release), then held within ${drift.toFixed(2)}°, swung back ${Math.max(0, back).toFixed(2)}°` });
}
{ // three fins, copied round the body
  // (built here the way the hangar's 3-way symmetry copies a fin, so the check also runs on older builds)
  const d = rocket(), fins = d.parts.filter((p) => p.id === 't_vfin'), f0 = { ...fins[0], quat: [0, 0, 0, 1], pos: [0, 0.85, fins[0].pos[2]] };
  const turn = (a) => { const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), a); return { ...f0, pos: [-Math.sin(a) * 0.85, Math.cos(a) * 0.85, f0.pos[2]], quat: q.toArray() }; };
  d.parts = d.parts.filter((p) => p.id !== 't_vfin').concat([0, 1, 2].map((k) => turn((k * 2 * Math.PI) / 3)));
  const st = S.analyze(d), log = fly(d, 'sim', () => ({}), 10), end = log.at(-1);
  const roll = Math.max(...log.slice(60).map((r) => Math.abs(r.w.z))) * deg, lean = ang(end.nose, up), side = Math.hypot(end.x.x, end.x.z);
  const bad = [];
  if (d.parts.filter((p) => p.id === 't_vfin').length !== 3) bad.push('not three fins');
  if (roll > 2) bad.push(`rolls at ${roll.toFixed(2)}°/s`);
  if (lean > 2) bad.push(`leans ${lean.toFixed(2)}° off vertical`);
  if (side > 0.01 * end.x.y + 1) bad.push(`drifts ${side.toFixed(1)} m sideways in ${end.x.y.toFixed(0)} m of climb`);
  res.push({ label: 'sim: three-fin rocket, hands off', bad, info: `${st.finArea.toFixed(2)} m² of fin; max roll ${roll.toFixed(3)}°/s, lean ${lean.toFixed(3)}°, ${side.toFixed(2)} m sideways at ${end.x.y.toFixed(0)} m` });
}
return res;
