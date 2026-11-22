// Crew rigs under stress (browser module, driven by riders.py): every stock vehicle with people in it is stepped with
// the game's own physics at 60 Hz while its controls sweep, and each person's skeleton is checked every frame:
//   - the arms hold together: each hand bone sits at the end of its forearm (a hand that can't reach its grip lets go;
//     it never stretches the skin between forearm and hand);
//   - nothing flies off: every bone stays within 1.5 m of the hips (rig metres);
//   - the cost: milliseconds spent posing the crew per frame (min / mean of the run).
// Then the bikes lose their forks (the fork part breaks off and flies away, as in a crash): the riders must let go and
// stay in one piece. Physics + rig only, no rendering.
import * as THREE from 'three';
import { Aircraft, REALISM } from '../../src/aircraft.js';

const flat = (h = 0) => ({ groundAt: () => ({ h, n: new THREE.Vector3(0, 1, 0), type: 'runway' }), maxGround: () => h, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: h });
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ARMS = [[3, 4, 16], [5, 6, 17]]; // (crew.js B: uArmR, fArmR, handR / uArmL, fArmL, handL)

function crews(ac) { const out = []; for (const p of ac.parts) for (const r of p.obj.userData.crew || []) out.push(r); return out; }

// how far each hand bone is from the end of its forearm, and the furthest any bone is from the hips (rig metres)
export function skeletonCheck(r) {
  const rig = r.rig, p = rig.p, q = rig.q, D = rig.D; let gap = 0, far = 0;
  for (const [, f, h] of ARMS) { const end = V(0, D.fore, 0).applyQuaternion(q[f]).add(p[f]); gap = Math.max(gap, end.distanceTo(p[h])); }
  for (let i = 0; i < 11; i++) far = Math.max(far, p[i].distanceTo(p[0]));
  for (const i of [16, 17]) far = Math.max(far, p[i].distanceTo(p[0]));
  return { gap, far, finite: p.every((v) => Number.isFinite(v.x + v.y + v.z)) && q.every((v) => Number.isFinite(v.x + v.y + v.z + v.w)) };
}

// times every crew update of this vehicle (ms per frame, summed over its people)
function timed(ac) {
  const t = { ms: 0, frames: 0, per: [] };
  for (const r of crews(ac)) { const u = r.update.bind(r); r.update = (c, dt) => { const t0 = performance.now(); const m = u(c, dt); t.ms += performance.now() - t0; return m; }; }
  return t;
}

export function run(design, { T = 6, mode = 'pilot', breakFork = false, script = null } = {}) {
  const ac = new Aircraft(design, REALISM[mode]), env = flat();
  ac.spawn(env, V(0, 0, 0), 0, {});
  const people = crews(ac); if (!people.length) return null;
  const tm = timed(ac), dt = 1 / 60, out = { name: design.name, people: people.length, gap: 0, far: 0, finite: true, letGo: 0, held: null, msBefore: [], msAfter: [], broke: null, events: [] };
  let deb = null;
  for (let f = 0; f * dt < T; f++) {
    const t = f * dt;
    const c = script ? script(t, ac) : { throttle: 0.6, pitch: Math.sin(t * 2.1) * 0.8, roll: Math.sin(t * 1.3), yaw: Math.sin(t * 0.7) * 0.6, rev: 0, hand: 0 };
    ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 0, rev: 0, hand: 0, ...c });
    if (breakFork && !deb && t >= 1.5) {
      const fork = ac.parts.find((p) => p.alive && (() => { let g = false; p.obj.traverse((o) => { if (o.userData.grips) g = true; }); return g; })());
      if (fork) { ac.breakPart(fork.i, 'impact'); for (const e of ac.events) if (e.type === 'debris') deb = e.debris; out.broke = fork.p.id; }
    }
    if (deb) { deb.v.set(4, 6, -25); deb.step(dt, env); deb.group.position.copy(deb.x); deb.group.quaternion.copy(deb.q); deb.group.updateMatrixWorld(true); } // (flying away fast)
    tm.ms = 0; ac.step(dt, env);
    for (const e of ac.events.splice(0)) if (['msg', 'wreck'].includes(e.type)) out.events.push([+t.toFixed(2), e.type, e.text || '']);
    if (f > 2) (deb ? out.msAfter : out.msBefore).push(tm.ms);
    for (const r of people) { const s = skeletonCheck(r); if (f > 0) { out.gap = Math.max(out.gap, s.gap); out.far = Math.max(out.far, s.far); out.finite &&= s.finite; } }
    for (const r of people) for (const k of ['R', 'L']) if (r.rig.grab?.[k] && r.rig.grab[k].t < 1) out.letGo++; // (hand-frames off their grips)
    out.held = people.every((r) => ['R', 'L'].every((k) => !r.rig.grab?.[k] || r.rig.grab[k].t >= 1)); // (at the end)
    if (ac.dead) break;
  }
  const stat = (a) => a.length ? { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p95: +[...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)].toFixed(3) } : null;
  out.msBefore = stat(out.msBefore); out.msAfter = stat(out.msAfter);
  out.gap = +out.gap.toFixed(4); out.far = +out.far.toFixed(3);
  return out;
}

export function plan(presets) {
  const out = [];
  for (const d of presets) {
    const r = run(d); if (!r) continue;
    const bad = [];
    if (!r.finite) bad.push('NaN in the skeleton');
    if (r.gap > 0.01) bad.push(`hand ${(r.gap * 100).toFixed(1)} cm off its forearm`);
    if (r.far > 1.5) bad.push(`a bone ${r.far.toFixed(2)} m from the hips`);
    if (r.letGo) bad.push(`a hand let go of an intact control (${r.letGo} hand-frames)`);
    out.push({ ...r, check: 'ride', ok: !bad.length, why: bad.join('; ') });
  }
  for (const d of presets.filter((d) => d.parts.some((p) => /^b_fork/.test(p.id)))) {
    const r = run(d, { breakFork: true, T: 4, script: (t) => ({ throttle: 0.5, roll: Math.sin(t * 2) * 0.5 }) }); if (!r) continue;
    const bad = [];
    if (!r.broke) bad.push('fork did not break off');
    if (!r.finite) bad.push('NaN in the skeleton');
    if (r.gap > 0.01) bad.push(`hand ${(r.gap * 100).toFixed(1)} cm off its forearm`);
    if (r.far > 1.5) bad.push(`a bone ${r.far.toFixed(2)} m from the hips`);
    if (r.held) bad.push('still holding the handlebars that flew away');
    if (r.msAfter && r.msBefore && r.msAfter.mean > r.msBefore.mean * 2 + 0.2) bad.push(`posing cost jumped ${r.msBefore.mean} -> ${r.msAfter.mean} ms after the fork went`);
    out.push({ ...r, check: 'fork lost', ok: !bad.length, why: bad.join('; ') });
  }
  return out;
}
