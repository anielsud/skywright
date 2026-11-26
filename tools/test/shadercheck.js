// Shader check (run in the page by shadercheck.py). See shadercheck.py for what it checks.
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
// One flight at `location`, then everything a flight can show, on purpose and in a fixed order, so the result never
// depends on timing or on how far a flight happens to get:
//   1. everything already in the scene drawn once: every hidden object shown and culling off for a few frames (LODs,
//      pools, cockpit cabins, night lights, effects' meshes) - covers new content automatically, nothing is listed;
//   2. every event effect fired (explosion, splash, sparks, dust on each surface, smoke, flame, sonic boom...): these
//      must show at once, so they may neither stall a frame nor be held back to compile (main.js flushNew);
//   3. streaming: the vehicle moved to the map's edge in each direction, so tiles, traffic and the rest stream in;
//      new shaders are allowed there (shown when compiled), stalls are not;
//   4. a real crash where the place has something to crash into (a building in New York, water at the islands,
//      the ground elsewhere): parts breaking off, debris, fire, collapse.
// Returns, per phase, the stalls (main.js's counter: programs compiled during a frame's draw) and the late shows.
const count = () => ({ stall: window.__inflightCompiles || 0, late: window.__lateShows || 0 });
const since = (c0) => { const c = count(); return { stall: c.stall - c0.stall, late: c.late - c0.late }; };
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
// (at least `n` frames drawn as well as `ms`: on CI's software GPU a frame takes seconds, and only drawn frames compile)
const wait = async (F, ms, n = 10) => { const t0 = performance.now(); let k = 0; while ((performance.now() - t0 < ms || k < n) && S.F === F) { await frame(); k++; } };

// Hold the vehicle where it is until nothing new has needed a shader for 2 s (streaming around it has settled), so a
// late show in the phase that follows is that phase's own, not streaming's.
async function settle(F, ac) {
  const x = ac.x.clone(), q = ac.q.clone(); let last = count().late, t = performance.now(); const t0 = t;
  let k = 0;
  while (S.F === F && (performance.now() - t < 2000 || k < 20) && performance.now() - t0 < 60000) {
    ac.x.copy(x); ac.q.copy(q); ac.v.set(0, 0, 0); ac.w?.set?.(0, 0, 0); await frame(); k++;
    const n = count().late; if (n !== last) { last = n; t = performance.now(); k = 0; }
  }
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
  const { ac, world: W, effects: E } = F, THREE = S.THREE;

  await settle(F, ac);
  // 1. everything in the scene, drawn
  let c = count(); const undo = [];
  F.scene.traverse((o) => {
    if (Object.getOwnPropertyDescriptor(o, 'visible')?.get) return; // (held by flushNew: waiting for its shader)
    if (!o.visible) { o.visible = true; undo.push(() => (o.visible = false)); }
    if (o.frustumCulled) { o.frustumCulled = false; undo.push(() => (o.frustumCulled = true)); }
  });
  await frames(3); for (const u of undo.reverse()) u();
  r.phases.scene = { ...since(c), objects: undo.length };

  // 2. every event effect, in front of the camera
  c = count();
  const at = ac.x.clone().add(new THREE.Vector3(0, 0, -25).applyQuaternion(ac.q)), v = ac.v.clone(), up = { x: 0, y: 1, z: 0 };
  E.explosion(at, 2); E.splash(at, 12); E.sparks(at, v, 20); E.puff(at, up, { color: [0.3, 0.3, 0.3], s0: 2, s1: 10, life: 3 });
  for (const s of ['rock', 'grass', 'sand', 'dirt', 'snow', 'runway', 'road', 'water']) E.dust(at, v, s, 3);
  E.spray(at, 20); E.tireSmoke(at, 20); E.engineSmoke(at, v, 0.1); E.flame(at, v, 1); E.burn(at, 1); E.trail(at, [1, 0.3, 0.3], 1);
  E.feathers(at); E.leaves(at);
  F.sonic.boom({ effects: E, world: W });
  await wait(F, 1500);
  r.phases.events = since(c);

  // 3. streaming, at the map's edge in each direction
  c = count();
  const far = W.half + 3000;
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    ac.x.set(dx * far, W.groundAt(dx * far, dz * far).h + 700, dz * far); ac.v.set(dx * 70, 0, dz * 70);
    await wait(F, 5000, 30);
  }
  r.phases.streaming = since(c);

  // 4. a real crash
  c = count();
  let target = null;
  if (location === 'nyc') {
    const boxes = W.wallBoxes(0, 0, 3000); let best = null;
    for (const b of boxes) if (b.y1 - b.y0 > 25 && (!best || Math.hypot(b.x, b.z) < Math.hypot(best.x, best.z))) best = b;
    if (best) { const y = (best.y0 + best.y1) / 2, n = Math.max(best.hl, best.hw) + 120; ac.x.set(best.x - n, y, best.z); ac.v.set(90, 0, 0); target = 'building'; }
  } else if (location === 'islands') {
    for (let k = 0; k < 400 && !target; k++) { const x = (k % 20 - 10) * 300, z = (Math.floor(k / 20) - 10) * 300; if (W.groundAt(x, z).type === 'water') { ac.x.set(x, 40, z); ac.v.set(30, -60, 0); target = 'water'; } }
  }
  if (!target) { const g = W.groundAt(0, 0).h; ac.x.set(0, g + 40, 0); ac.v.set(30, -70, 0); target = 'ground'; }
  ac.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0);
  const v0 = ac.v.clone(); await settle(F, ac); c = count(); ac.v.copy(v0); // (streaming round the crash site done first)
  // stepped in game time up to the impact (a slow GPU would take minutes of frames to get there), then drawn
  const lost0 = ac.stats?.partsLost ?? 0;
  for (let i = 0; i < 40 && S.F === F && (ac.stats?.partsLost ?? 0) === lost0; i++) { S.advance(0.1); await frame(); }
  await wait(F, 3000, 30);
  r.phases.crash = { ...since(c), target, partsLost: (ac.stats?.partsLost ?? 0) - lost0 };

  r.programs = S.renderer.info.programs.length;
  if (S.F === F) S.endFlight();
  return r;
}
