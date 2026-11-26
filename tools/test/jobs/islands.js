// Job: Bora Bora (islands; one World, built once; every vehicle swapped into it once). Run by tools/test/jobs.py; see
// harness.js for T and the rules (build once, step with T.advance, draw fixed frame counts only for drawing claims,
// wait on states). The steps, in order (D = frames drawn, S = game time stepped without drawing):
//   islands: build + Kestrel from the runway   the first T.start here builds the islands. The tour flight (smoke.js
//       tour(): D 3 frames at full power on the real loop, S 3 s, D every cockpit view + 2) and tourChecks; then the
//       shader sweep's scene phase (streaming quiet first: T.settle; sceneDrawn D 3; events: nyc job only):
//       no stalls, nothing waited for its shader
//   islands: startbakes-stunts                 startbakes.js stuntsIn(world) + stuntsChecks (no flight work)
//   islands: Albatross (water start), islands: Kite (air start)   swapped in; S 2 s at full power: still flying,
//       finite, in one piece (smoke.py's 'quick' steps)
//   islands: Speedboat from the marina         the AudioContext started here (no recorded clips: a boat's motor voice
//       is synthesized, motorSound.js, so the 131-clip decode stays in the hangar job), full gas, D frames until the
//       motor voice's output gain is up (at most 30): the engine is audible (smoke.js fly()'s `motor` check; not
//       judged if the audio clock is stalled, as smoke did); then the tour (D) and tourChecks; the AudioContext is
//       suspended again (nothing else here is heard)
//   islands: Rocket on the pad                 padcheck.js rocket('islands') + rocketChecks (S)
//   islands: SR-71 land from the approach, then Mach 2.5+ above 60k ft   swapped in once (the landing challenge's
//       approach start); sr71flight.js land() flown to a stop (S: Aircraft.step with the game loop paused, as smoke.py
//       did), smoke.py's sr71_land verdicts; one screenshot on the runway; then put on the runway start
//       (Aircraft.spawn where buildFlight puts a runway start: a teleport, not another swap) and climb() flown,
//       smoke.py's sr71_climb verdicts
//   islands: SR-71 water crash                 shadercheck.js crash('islands'): streaming quiet, S to the impact, D 5:
//       parts come off, no stalls, nothing waited for its shader
//   islands: start-rule wiring                 wiring.js wiringChecks(T, started): every vehicle above started where
//       the start rule says
// No page errors: the harness fails the step they happen in.
// Dropped (#278): smoke's second islands build and its Dirt Bike there (canyon-lauterbrunnen carries "a second map in
// one session compiles nothing new", #187); the sweep's streaming phase (#275's probe and the stall counter in every
// step). Keep BASE's time and weather (T.start's cfg: start, mode, realism, landStart, boatStart only), or the islands
// are built again.
import { tour, tourChecks } from '../smoke.js';
import { rocket, rocketChecks } from '../padcheck.js';
import { sceneDrawn, crash, phaseChecks } from '../shadercheck.js'; // (event effects fire in the nyc job only: they are the same at every place)
import { stuntsIn, stuntsChecks } from '../startbakes.js';
import { isMotor } from '../../../src/motorSound.js';

const LOC = 'islands', SR71 = 'SR-71 Blackbird';
const MACH_MIN = 2.5, ALT_MIN_FT = 60000; // (smoke.py)
const ENGINE_FRAMES = 30; // at most this many frames for the boat's motor voice to come up (CI: 1-2; a fast machine: a few)

export async function run(T) {
  const started = []; // { name, location, cfg, start } per vehicle started here (wiring.js)
  const note = (name, s, F = T.F) => { const c = F.cfg; started.push({ name, location: LOC, cfg: { start: c.start, mode: c.mode, landStart: c.landStart, boatStart: c.boatStart }, start: s.start ?? F.cfgStart }); };
  const begun = (s) => `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}`;

  await T.step(`${LOC}: build + Kestrel from the runway`, async () => {
    const s = await T.start('Kestrel', LOC); note('Kestrel', s);
    const f = await tour();
    T.checks(tourChecks(f));
    const q = await T.settle();
    const scene = await sceneDrawn();
    T.checks(phaseChecks('scene', scene));
    return `${begun(s)}; ${f.ride?.speed.toFixed(0)} m/s, ${f.views} cockpit view(s); settled in ${q.rounds} rounds, ${scene.objects} hidden/culled shown`;
  });

  await T.step(`${LOC}: startbakes-stunts`, async () => {
    const r = await stuntsIn(T.F.world, LOC);
    T.checks(stuntsChecks(r));
    return r.searched ? `site (${r.planned?.x}, ${r.planned?.z})` : 'no site search here';
  });

  for (const [name, what] of [['Albatross', 'water start'], ['Kite', 'air start']]) {
    await T.step(`${LOC}: ${name} (${what})`, async () => {
      const s = await T.start(name, LOC); note(name, s);
      T.go(true); T.advance(2); const q = T.state(); T.go(false);
      if (!T.check('still flying (the flight did not end on its own)', !!q)) return '';
      T.check('finite position and velocity', q.pos && q.vel, '');
      T.check('in one piece', q.parts > 0, `${q.alive}/${q.parts} parts`);
      return `${begun(s)}; after 2 s ${q.speed.toFixed(0)} m/s, alt ${q.alt.toFixed(0)} m, ${q.alive}/${q.parts} parts`;
    });
  }

  await T.step(`${LOC}: Speedboat from the marina`, async () => {
    const A = T.S.audio;
    // the AudioContext alone: a boat's motor voice is synthesized (motorSound.js), so no clip need decode (that, every
    // clip, is the hangar job's check); the voices that would use a clip fall back to synth, as before clips arrive
    if (!A.ctx) A.loadSamples = async () => {};
    A.init();
    if (A.ctx?.state === 'suspended') A.ctx.resume();
    await T.until(() => A.ctx?.state === 'running', { what: 'the AudioContext to run', timeout: 30 });
    const s = await T.start('Speedboat', LOC, { boatStart: 'marina' }); note('Speedboat', s);
    const heard = await engineAudible(T);
    const f = await tour();
    T.checks(tourChecks(f));
    A.ctx.suspend(); // (nothing else in this job is listened to)
    return `${begun(s)}; ${heard}; ${f.ride?.speed.toFixed(1)} m/s, ${f.views} cockpit view(s)`;
  });

  await T.step(`${LOC}: Rocket on the pad`, async () => {
    const r = await rocket(LOC); note('Rocket', r);
    T.checks(rocketChecks(r));
    return `start ${r.start}; ${r.burn.height.toFixed(0)} m up after ${r.burn.seconds.toFixed(1)} s`;
  });

  await T.step(`${LOC}: SR-71 land from the approach, then Mach ${MACH_MIN}+ above ${ALT_MIN_FT / 1000}k ft`, async () => {
    await srMod();
    const s = await T.start(SR71, LOC, { mode: 'landing' }); note(SR71, s);
    const land = sr71Land(T);
    await sr71Shot(T, 'sr71-landed');
    const climb = sr71Climb(T);
    return `${begun(s)}; ${land}; ${climb}`;
  });

  await T.step(`${LOC}: SR-71 water crash`, async () => {
    const F = T.F; F.paused = false; T.go(false); T.S.rig.init = false; // (the camera jumps to it)
    const r = await crash(LOC);
    T.checks(phaseChecks('crash', r));
    return `into ${r.target}: ${r.partsLost} parts lost`;
  });

  await T.step(`${LOC}: start-rule wiring`, async () => {
    const { wiringChecks } = await import('./wiring.js');
    await wiringChecks(T, started);
    return started.map((v) => `${v.name}: ${v.start}`).join(', ');
  });
}

// Full gas on the real loop until the motor voice's output gain is up (smoke.js fly(): `motor`, judged by smoke.py:
// silent if under 0.01 at full throttle, not judged when the audio clock is stalled, #180).
async function engineAudible(T) {
  const A = T.S.audio, ac = T.F.ac;
  const e = ac.parts.find((p) => p.alive && p.engine && isMotor(p.engine.sound));
  if (!T.check('it has a motor-voiced engine (a car, bike or boat engine sound)', !!e, ac.parts.filter((p) => p.engine).map((p) => p.engine.sound).join(', ') || 'no engine')) return 'no motor voice';
  const kind = e.engine.sound, gain = () => A.voices[kind]?.out.gain.value ?? 0, a0 = A.ctx.currentTime;
  T.go(true);
  let k = 0;
  for (; k < ENGINE_FRAMES && gain() < 0.01; k++) await T.frames(1, { what: `the ${kind} motor voice to come up (frame ${k + 1})` });
  const g = gain(), clock = A.ctx.currentTime - a0;
  if (g < 0.01 && clock < 0.05) { T.log(`audio clock stalled (${clock.toFixed(3)} s over ${k} frames): engine sound not checked`); return 'audio clock stalled: engine not checked'; }
  T.check(`its ${kind} engine is audible at full throttle`, g >= 0.01, `voice gain ${g.toFixed(3)} after ${k} frame(s), audio clock +${clock.toFixed(2)} s, voice ${A.voices[kind] ? 'made' : 'never made'}`);
  return `${kind} engine ${g.toFixed(2)}`;
}

// ---------- the SR-71's scripted flights (sr71flight.js; smoke.py sr71_start/sr71_climb/sr71_land, in game time) ----------
// The game loop is paused and the autopilot flies the aircraft through Aircraft.step, much faster than real time. The
// generators run to their end synchronously (each is bounded by its own maxTime in game seconds): yielding between
// chunks would let the loop draw a frame each time (1-2 s apiece on CI).
let SRF = null;
const srMod = async () => (SRF ??= await import('../sr71flight.js'));
const flyOut = (gen) => { const out = []; for (const st of gen) { out.push(st); if (st.dead || st.wrecked) break; } return out; };
const broke = (states) => states.flatMap((st) => st.msgs || []).filter((m) => /broke|snapped|collapsed/.test(m));

// sr71_land: from the approach start, flown to a stop. Verdicts: intact, touched down, stopped on the runway.
function sr71Land(T) {
  const S = T.S, F = T.F, m = F.mission, w = F.world, L = w.runway.len;
  T.advance(0.5); // (settled half a second, as smoke.py)
  F.paused = true; F.eng.on = true; F.ac.engineRunning = true;
  const rwy = { x: m.rwyX, h: w.loc.rwyH, s: m.side, aimZ: m.side * (L / 2 - 380), len: L, width: w.runway.width };
  const vApp = Math.min(110, Math.max(32, S.analyze(F.ac.design).stall * 1.45));
  const states = flyOut(SRF.land(F.ac, F.env, rwy, { chunk: 20, vApp }));
  if (!T.check('the scripted landing ran', states.length > 0)) return 'no landing';
  const last = states.at(-1), td = last.td;
  T.check('lands intact', !last.dead && !last.wrecked && last.alive >= last.parts,
    `${last.alive}/${last.parts} parts, touchdown ${JSON.stringify(td)}; ${states.flatMap((st) => st.msgs || []).slice(-6).join('; ')}`);
  if (!T.check('touches down', !!td, `${last.altFt} ft, ${last.V} m/s`)) return 'never touched down';
  T.check('stops on the runway', !!(last.stopped && last.onRwy), `touchdown ${JSON.stringify(td)}, now at x ${last.x} z ${last.z}, ${last.V} m/s`);
  // the climb and the crash after it are free flying: the landing challenge is over
  F.mission?.dispose?.(); F.mission = null;
  return `touchdown ${td.vs} m/s down at ${td.V} m/s, ${td.x} m off the centreline, stopped ${last.onRwy ? 'on the runway' : 'off it'} (${last.t.toFixed(0)} s flown)`;
}

// one picture (the flight unpaused for a step so the chase camera comes to it; throttle off: the parking brake holds)
async function sr71Shot(T, name) {
  const S = T.S, F = T.F;
  S.controls.setThrottle(0); F.paused = false; S.rig.set('chase'); S.rig.init = false;
  T.advance(1 / 30);
  await T.shot(name);
  F.paused = true;
}

// sr71_climb: from the runway start, take off, climb, accelerate. Verdicts: nothing broke, intact, over Mach 2.5 above
// 60,000 ft.
function sr71Climb(T) {
  const S = T.S, F = T.F, ac = F.ac, w = F.world, r = w.runways?.[0] || w.runway;
  // where buildFlight puts a runway start (a teleport: the same World, no second swap); flaps up as a runway start has them
  ac.spawn(F.env, new S.THREE.Vector3(r.x, 0, r.len / 2 - 60), 0); ac.flaps = 0; ac.brake = 0;
  F.paused = true; F.eng.on = true; ac.engineRunning = true;
  const d0 = ac.stats.distance, t0 = ac.time;
  const states = flyOut(SRF.climb(ac, F.env, { ground: w.loc.rwyH, chunk: 60, maxTime: 1200 }));
  if (!T.check('the scripted climb ran', states.length > 0)) return 'no climb';
  const last = states.at(-1), bad = broke(states);
  T.check('nothing broke', !bad.length, bad.slice(0, 4).join('; '));
  T.check('climbs intact', !last.dead && !last.wrecked && last.alive >= last.parts, `${last.alive}/${last.parts} parts at ${last.altFt} ft, Mach ${last.mach}`);
  T.check(`over Mach ${MACH_MIN} above ${ALT_MIN_FT} ft`, last.best60 >= MACH_MIN,
    `Mach ${last.best60.toFixed(2)} above ${ALT_MIN_FT} ft (best Mach ${last.best.mach.toFixed(2)} at ${(last.best.alt / 0.3048).toFixed(0)} ft)`);
  const lo = last.liftoff || {};
  return `lift-off ${lo.V} m/s after a ${last.roll == null ? '?' : Math.round(last.roll - d0)} m roll; Mach ${last.best60.toFixed(2)} above ${ALT_MIN_FT} ft `
    + `(now Mach ${last.mach.toFixed(2)} at ${last.altFt} ft, ${(last.t - t0).toFixed(0)} s), skin ${last.skinC} C, ${last.alive}/${last.parts} parts`;
}
