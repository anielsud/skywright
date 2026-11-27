// Shader check phases, run in the page by the per-map jobs (tools/test/jobs). See tools/test/README.md, Shader check.
const S = window.__sky;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

// One flight: start it, wait out the loading screen's warm-up, fly for `secs` of flight time at full throttle, end it.
// Returns how many programs compiled behind the loading screen and how many after it (main.js's '[shaders]' count).
export async function fly(name, location, secs = 4) {
  if (S.F) S.endFlight();
  for (let i = 0; i < 100 && S.F; i++) await sleep(50);
  const d = S.presets.find((p) => p.name === name); if (!d) throw new Error(`no preset ${name}`);
  S.hangar.load(d); S.controls.setThrottle(1);
  const c0 = window.__inflightCompiles || 0, p0 = S.renderer.info.programs.length;
  S.startFlight({ location, online: false, start: 'runway', mode: 'free', weather: 'clear', time: 10 });
  for (let i = 0; i < 3000 && !S.F; i++) await sleep(10);
  const F = S.F; if (!F) throw new Error('the flight did not start');
  const t0 = performance.now();
  while (!(F.t > 0) || F.warm) { if (performance.now() - t0 > 120000) throw new Error('the flight clock never started'); await frame(); }
  const p1 = S.renderer.info.programs.length, t1 = F.t;
  while (F.t - t1 < secs && performance.now() - t0 < 180000 && S.F === F) await frame();
  const r = { name, location, warmed: p1 - p0, inflight: (window.__inflightCompiles || 0) - c0, programs: S.renderer.info.programs.length };
  S.endFlight();
  return r;
}

// ---------------- the sweep (#273) ----------------
// Everything a flight can show, on purpose and in a fixed order, so the result never depends on timing or on how far a
// flight happens to get. The phases run against the flight already going (S.F), so a per-map job (tools/test/jobs)
// runs them in the World it has built; each returns its own stall and late-show counts:
//   sceneDrawn():   everything already in the scene drawn: every hidden object shown and culling off for a few frames
//                   (LODs, pools, cockpit cabins, night lights, effects' meshes) - covers new content automatically;
//   eventsFired():  every event effect fired (explosion, splash, sparks, dust on each surface, smoke, flame, sonic
//                   boom...): these must show at once, so they may neither stall a frame nor be held back to compile
//                   (main.js flushNew);
//   crash(loc):     a real crash where the place has something to crash into (a building in New York, water at the
//                   islands, the ground elsewhere), stepped in game time to the impact, then drawn: parts breaking
//                   off, debris, fire, collapse.
// Before the events and the crash the vehicle is held until streaming round it is quiet (harness settle: frame-count
// based), so a late show in the phase is that phase's own. sweep() below is the old one-place-per-flight suite
// (shadercheck.py), with a streaming phase (the map's edges) between events and crash.
import { frames, settle, counters, since, stepUntil, advance } from './jobs/harness.js';

const delta = (c0) => { const d = since(c0); return { stall: d.stall, late: d.late, messages: d.messages }; };

export async function sceneDrawn({ n = 3 } = {}) {
  const F = S.F, c0 = counters(), undo = [];
  // Lights are not drawn things: the scene's light set is part of every lit shader, so showing a hidden one (a landing
  // light's spot, hidden by day) would recompile the lot and test a lighting no player sees. Every light keeps the
  // visibility it has now, also one inside a hidden group opened up below.
  const lit = []; F.scene.traverseVisible((o) => { if (o.isLight) lit.push(o); }); const shown = new Set(lit);
  F.scene.traverse((o) => {
    if (Object.getOwnPropertyDescriptor(o, 'visible')?.get) return; // (held by flushNew: waiting for its shader)
    if (o.isLight) { if (!shown.has(o) && o.visible) { o.visible = false; undo.push(() => (o.visible = true)); } return; }
    if (!o.visible) { o.visible = true; undo.push(() => (o.visible = false)); }
    if (o.frustumCulled) { o.frustumCulled = false; undo.push(() => (o.frustumCulled = true)); }
  });
  try { await frames(n, { what: 'the whole scene drawn' }); } finally { for (const u of undo.reverse()) u(); }
  return { ...delta(c0), objects: undo.length };
}

export async function eventsFired({ n = 5, settled = true } = {}) {
  const F = S.F, { ac, world: W, effects: E } = F, THREE = S.THREE;
  if (settled) await settle();
  const c0 = counters();
  const at = ac.x.clone().add(new THREE.Vector3(0, 0, -25).applyQuaternion(ac.q)), v = ac.v.clone(), up = { x: 0, y: 1, z: 0 };
  E.explosion(at, 2); E.splash(at, 12); E.sparks(at, v, 20); E.puff(at, up, { color: [0.3, 0.3, 0.3], s0: 2, s1: 10, life: 3 });
  for (const s of ['rock', 'grass', 'sand', 'dirt', 'snow', 'runway', 'road', 'water']) E.dust(at, v, s, 3);
  E.spray(at, 20); E.tireSmoke(at, 20); E.engineSmoke(at, v, 0.1); E.flame(at, v, 1); E.burn(at, 1); E.trail(at, [1, 0.3, 0.3], 1);
  E.feathers(at); E.leaves(at);
  F.sonic.boom({ effects: E, world: W });
  await frames(n, { what: 'the event effects drawn' });
  // Then stepped (not drawn) until they've died out: drawn at the next step's fixed 1/60 s a frame they'd stay on screen
  // for its every frame (an explosion's smoke lives up to 12 s), and a screen of smoke, fire and shock rings costs
  // seconds a frame of software WebGL on CI (#278: the New York tour after this paid it). Stepped for the longest life
  // left among the particles, shock rings and flash (the pools also hold the place's own steady smoke, so not "empty").
  const left = (P) => { let m = 0; for (let i = 0; i < P.n; i++) m = Math.max(m, P.max[i] - P.life[i]); return m; }, u = E.boom.userData;
  const out = Math.max(left(E.smoke), left(E.fire), u.on ? u.d - u.t : 0, ...F.sonic.rings.map((r) => r.life - r.t));
  if (out > 0) advance(out + 0.1);
  return { ...delta(c0), out };
}

// Put the vehicle on a collision course (a building in New York, water at the islands, the ground elsewhere), let
// streaming round it go quiet, step to the impact (something breaks off) in game time, then draw n frames.
export async function crash(location = S.F.world.loc?.id, { n = 5 } = {}) {
  const F = S.F, { ac, world: W } = F, THREE = S.THREE;
  let target = null;
  if (location === 'nyc') {
    const boxes = W.wallBoxes(0, 0, 3000); let best = null;
    for (const b of boxes) if (b.y1 - b.y0 > 25 && (!best || Math.hypot(b.x, b.z) < Math.hypot(best.x, best.z))) best = b;
    if (best) { const y = (best.y0 + best.y1) / 2, k = Math.max(best.hl, best.hw) + 120; ac.x.set(best.x - k, y, best.z); ac.v.set(90, 0, 0); target = 'building'; }
  } else if (location === 'islands') {
    for (let k = 0; k < 400 && !target; k++) { const x = (k % 20 - 10) * 300, z = (Math.floor(k / 20) - 10) * 300; if (W.groundAt(x, z).type === 'water') { ac.x.set(x, 40, z); ac.v.set(30, -60, 0); target = 'water'; } }
  }
  if (!target) { const g = W.groundAt(0, 0).h; ac.x.set(0, g + 40, 0); ac.v.set(30, -70, 0); target = 'ground'; }
  ac.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0);
  const v0 = ac.v.clone(); await settle(); ac.v.copy(v0); // (streaming round the crash site done first)
  const c0 = counters(), lost0 = ac.stats?.partsLost ?? 0;
  const hit = stepUntil(() => (ac.stats?.partsLost ?? 0) !== lost0 || S.F !== F, { max: 6, what: `the crash into ${target}`, soft: true }) !== false;
  if (S.F === F) await frames(n, { what: 'the crash drawn' });
  return { ...delta(c0), target, hit, partsLost: (ac.stats?.partsLost ?? 0) - lost0 };
}

// [[name, ok, detail]] for T.checks: a phase result as checks (stalls never; late shows not in the event or crash phase)
export function phaseChecks(where, r, { late = true } = {}) {
  const out = [[`${where}: no stalls`, !r.stall, r.stall ? `${r.stall} compiled mid-flight: ${r.messages.filter((m) => /stalling/.test(m)).join(' | ').slice(0, 600)}` : '']];
  if (late) out.push([`${where}: nothing waited for its shader`, !r.late, r.late ? `${r.late}: ${r.messages.filter((m) => /shown when compiled/.test(m)).join(' | ').slice(0, 600)}` : '']);
  if ('partsLost' in r) out.push([`${where}: the crash happened (into ${r.target})`, r.partsLost > 0, `${r.partsLost} parts lost`]);
  return out;
}

export async function sweep(name, location) {
  if (S.F) S.endFlight();
  for (let i = 0; i < 100 && S.F; i++) await sleep(50);
  const d = S.presets.find((p) => p.name === name); if (!d) throw new Error(`no preset ${name}`);
  S.hangar.load(d); S.controls.setThrottle(1);
  const p0 = S.renderer.info.programs.length;
  S.startFlight({ location, online: false, start: 'air', mode: 'free', weather: 'clear', time: 10 });
  for (let i = 0; i < 3000 && !S.F; i++) await sleep(10);
  const F = S.F; if (!F) throw new Error('the flight did not start');
  const t0 = performance.now();
  while (!(F.t > 0) || F.warm) { if (performance.now() - t0 < 180000) await frame(); else throw new Error('the flight clock never started'); }
  const r = { name, location, warmed: S.renderer.info.programs.length - p0, phases: {} };
  const { ac, world: W } = F;
  await settle();
  r.phases.scene = await sceneDrawn();
  r.phases.events = await eventsFired({ settled: false });
  // streaming, at the map's edge in each direction
  const c0 = counters(), far = W.half + 3000;
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    ac.x.set(dx * far, W.groundAt(dx * far, dz * far).h + 700, dz * far); ac.v.set(dx * 70, 0, dz * 70);
    await frames(30, { what: 'streaming at the edge' });
  }
  r.phases.streaming = delta(c0);
  r.phases.crash = await crash(location);
  r.programs = S.renderer.info.programs.length;
  if (S.F === F) S.endFlight();
  return r;
}
