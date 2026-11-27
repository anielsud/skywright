// Job: the Grand Canyon, then Lauterbrunnen, in one session (two places, each built once; the second must not compile
// in flight what the first showed: the #187 check). Run by tools/test/jobs.py; see harness.js for T and the rules
// (build once, step with T.advance, draw fixed frame counts only for drawing claims, wait on states).
//
//   audio: engine voices    the AudioContext runs, without decoding the 131 clips (cars' and bikes' engines are
//                           synthesized: src/motorSound.js; the clips are the hangar job's)
//   canyon (built by the first flight):
//   - Dirt Bike from the stunt park (builds the canyon), then its tour (smoke.js tour(): 3 frames drawn at full power on
//     the real loop, 3 s stepped, every cockpit view drawn) and its engine voice audible
//   - Dune Buggy swapped in at the stunt park: the same tour and engine check (then the AudioContext is suspended)
//   - the shader sweep: streaming quiet, the whole scene drawn (3 frames); the Dune Buggy's ground crash (stepped to the
//     impact, 5 frames drawn; parts must come off)
//   - Rocket swapped in on the pad: padcheck.js rocket() (stepped)
//   lauterbrunnen (built by the Rocket's flight there: the pad check needs no extra swap):
//   - Rocket on the pad (padcheck); startbakes-stunts (stuntsIn: no flight needed); streaming quiet and the whole scene
//     drawn; #187: nothing compiled mid-flight from before the build to here
//   - the restart suite (restart.py's checks, driven here; the fresh-start memory comparison local only), ordered so
//     no flight is started twice: damage, restart (also the launch pad start type's restart), whole again; 2 more
//     restarts (damage before the last): memory flat; back to the hangar frees the World, a fresh Rocket start builds
//     a new one with the same spawn, and (local runs only) holds the same GPU memory as that World damaged and restarted
//     (both measured with streaming quiet round the spawn and the flora held still, #291); one start type per kind of spawn (air, stunt park, water park: see STARTS), each
//     swapped into that World, restarted, then 4 s stepped on (runway, street and marina: the startchoice Node suite)
//   - start-rule wiring (wiring.js wiringChecks) over every flight started here
// Keep BASE's time and weather (T.start's cfg: start, mode, realism, landStart, boatStart only), or a place is built
// again.
import { tour, tourChecks } from '../smoke.js';
import { rocket, rocketChecks } from '../padcheck.js';
import { sceneDrawn, crash, phaseChecks } from '../shadercheck.js';
import { stuntsIn, stuntsChecks } from '../startbakes.js';
import { snap, damage, damaged, whole, settled, damageChecks, memoryChecks, freshChecks, startTypeCheck } from '../restart.js';

const L = 'lauterbrunnen';
// The start types restarted after the launch pad (that one is the Rocket's, restarted in the damage step), each swapped
// into the fresh World, then restarted. A restart runs the same code for every start type (main.js restartFlight:
// endFlight(true) keeps the World and reset()s it, buildFlight starts the same cfg again); start types differ only in
// where buildFlight puts the vehicle and what the 4 s after it drive through. One per kind of start, each the one
// whose 4 s run over state World.reset() puts back:
//   air          planAirStart and an airborne spawn with speed and throttle (main.js alone: Node can't reach it)
//   stunt park   a car on the ground at the stunt park's arch (its ramps, boosts and state: World.reset)
//   water park   a boat afloat at the water park's arch (its boosts and state: World.reset)
// runway, street and marina put the vehicle down the same way from a different spot (Aircraft.spawn at the World's
// answer): the startchoice Node suite's Lauterbrunnen case checks that a restart gives each of them (and the two above)
// the same start and spawn pose as a fresh start, after damage and World.reset.
const STARTS = [
  ['air', 'Kestrel', { start: 'air' }],
  ['stunt park', 'Dune Buggy', { landStart: 'park' }],
  ['water park', 'Speedboat', { boatStart: 'waterpark' }],
];

export async function run(T) {
  const S = T.S, started = [];
  // every flight started here, for the start-rule wiring: the flight's own cfg and where it started
  const rec = (name) => {
    const F = T.F, c = F.cfg;
    started.push({ name, location: c.location, cfg: { start: c.start, mode: c.mode, realism: c.realism, landStart: c.landStart, boatStart: c.boatStart }, start: F.cfgStart });
  };

  await T.step('audio: engine voices (no clips decoded)', async () => {
    const A = S.audio;
    // init() starts the 131 clips decoding (~30 s of CPU on CI): not needed here, the engine voices checked are
    // synthesized (motorSound.js), so the loader is skipped for this init only
    A.loadSamples = async () => {};
    try { A.init(); } finally { delete A.loadSamples; }
    if (A.ctx?.state === 'suspended') A.ctx.resume();
    await T.until(() => A.ctx?.state === 'running', { what: 'the AudioContext to run', timeout: 30 });
    return `AudioContext running at ${A.ctx.sampleRate} Hz`;
  });

  // ---------------- the Grand Canyon ----------------
  await T.step('canyon: build + Dirt Bike (stunt park)', async () => {
    const s = await T.start('Dirt Bike', 'canyon', { landStart: 'park' }); rec('Dirt Bike');
    return `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}`;
  });
  await T.step('canyon: Dirt Bike: tour, cockpit views, engine', () => tourWithEngine(T));

  await T.step('canyon: Dune Buggy swapped in (stunt park)', async () => {
    const s = await T.start('Dune Buggy', 'canyon', { landStart: 'park' }); rec('Dune Buggy');
    return `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}`;
  });
  await T.step('canyon: Dune Buggy: tour, cockpit views, engine', async () => {
    try { return await tourWithEngine(T); } finally { await S.audio.ctx?.suspend(); } // (no more sound checked: spare the CPU)
  });

  await T.step('canyon: sweep: scene drawn', async () => {
    const q = await T.settle(), r = await sceneDrawn();
    T.checks(phaseChecks('canyon scene', r));
    return `streaming quiet in ${q.rounds} rounds; ${r.objects} hidden/culled things shown`;
  });
  await T.step('canyon: sweep: ground crash (Dune Buggy)', async () => {
    const r = await crash('canyon');
    T.checks(phaseChecks('canyon crash', r));
    return `into the ${r.target}: ${r.partsLost} parts lost`;
  });

  let canyonWorld = null;
  await T.step('canyon: Rocket on the pad', async () => {
    const r = await rocket('canyon'); rec('Rocket'); canyonWorld = T.F.world;
    T.checks(rocketChecks(r));
    return `start ${r.start}, ${r.burn.height.toFixed(0)} m up after ${r.burn.seconds.toFixed(1)} s`;
  });

  // the start rule's wiring is checked against the World that is up (wiring.js): canyon's starts now, before it goes
  await T.step('canyon: start-rule wiring', async () => {
    const { wiringChecks } = await import('./wiring.js');
    return wiringChecks(T, started.filter((s) => s.location === 'canyon'));
  });

  // ---------------- Lauterbrunnen ----------------
  let c187 = null;
  await T.step(`${L}: build + Rocket on the pad`, async () => {
    c187 = T.counters();
    const r = await rocket(L); rec('Rocket');
    T.check('a new World for the second place', T.F.cfg.location === L && T.F.world !== canyonWorld, `at ${T.F.cfg.location}`);
    T.checks(rocketChecks(r));
    return `start ${r.start}, ${r.burn.height.toFixed(0)} m up after ${r.burn.seconds.toFixed(1)} s; ${T.since(c187).programs} programs added`;
  });
  await T.step(`${L}: startbakes-stunts`, async () => {
    const r = await stuntsIn(T.F.world, L);
    T.checks(stuntsChecks(r));
    return r.searched ? `site (${r.planned?.x}, ${r.planned?.z}); ${JSON.stringify(r.ms)}` : 'no site search here';
  });
  await T.step(`${L}: sweep: scene drawn + #187`, async () => {
    const q = await T.settle(), r = await sceneDrawn();
    T.checks(phaseChecks(`${L} scene`, r));
    // #187 (shadercheck.py --fly): a second place compiled in flight the programs the first had already shown (the
    // crew's). From before this place was built to here, its first flight (the Rocket, flown at the canyon too) and its
    // whole scene drawn: nothing compiled mid-flight. (Every later step here fails on a stall as well.)
    const d = T.since(c187);
    T.check('#187: the second place compiles nothing in flight (crew, vehicle, world programs)', d.stall === 0,
      d.stall ? `${d.stall} compiled mid-flight: ${d.messages.filter((m) => /compiled in flight|stalling/.test(m)).join(' | ').slice(0, 800)}` : `${d.programs} programs added behind the loading screen, ${d.drawn} frames drawn`);
    return `streaming quiet in ${q.rounds} rounds; ${r.objects} hidden/culled things shown`;
  });

  // the restart suite (restart.py, at Lauterbrunnen). The Rocket's flight is the one restarted.
  let s0, s1; const snaps = [];
  await T.step(`${L}: restart: damage, restart, whole again`, async () => {
    s0 = snap(S);
    const d = damage(S);
    T.advance(3); // (the game brings them down: debris, dust, fires; stepped, not drawn)
    const dd = damaged(S);
    await T.restart(); s1 = await settled(S, { mem: true }); snaps.push(s1); // (the first of the memory check's restarts)
    T.checks(damageChecks(L, d, dd, s0, s1, whole(S)));
    // the launch pad start type: this restart, as it started (s0), then 4 s on (no throttle: it sits on the pad)
    T.advance(4);
    T.check(...startTypeCheck(L, 'launch pad', s0, s1, snap(S), false, s0.world));
    return `${d.buildings} buildings hit, ${dd.chunks} debris; world ${s0.world} kept`;
  });
  await T.step(`${L}: restart: memory flat over 3 restarts`, async () => {
    for (const k of [1, 2]) {
      if (k === 2) { damage(S); T.advance(1.5); } // (damage before every other restart; the first had it above)
      await T.restart(); snaps.push(await settled(S, { mem: true }));
    }
    T.checks(memoryChecks(L, snaps, s0.world));
    const g = snaps.map((s) => s.geometries).join(' '), t = snaps.map((s) => s.textures).join(' ');
    return `geometries ${g}, textures ${t}`;
  });
  let s2;
  await T.step(`${L}: restart: hangar frees the World; fresh start`, async () => {
    await T.end();
    const kept = !!S.kept;
    const s = await T.start('Rocket', L); rec('Rocket');
    // the memory comparison, like with like (#291): this World measured, then damaged, restarted and measured the same
    // way. The flora (trees: its cells and impostors, the slowest streamer, ~23 game s to finish at Low) is held still
    // for both, so neither has more of it streamed in than the other, without waiting for it; everything else streams
    // quiet round the spawn (T.settle) before each. Local runs only (compareMemory): its ~11 more drawn frames, 6 game s
    // and a restart are still ~25-50 s under SwiftShader, on a CI job near the critical path; CI skips that work, not
    // just the verdict (its flat-over-restarts checks still catch a leak)
    if (T.ci) {
      s2 = await settled(S);
      T.checks(freshChecks(L, kept, s0, s1, s2, null));
      return `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}; GPU memory comparison skipped (CI)`;
    }
    const fl = T.F.world.flora; if (fl) fl.update = () => {}; // (held: what it has built at the start stays as it is)
    let r;
    try {
      await T.settle(); await memQuiet(T); s2 = await settled(S, { mem: true });
      damage(S); T.advance(3); await T.restart();
      await T.settle(); await memQuiet(T); r = await settled(S, { mem: true });
    } finally { if (fl) delete fl.update; }
    T.checks(freshChecks(L, kept, s0, s1, s2, r));
    return `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}; geometries ${s2.geometries} / ${r.geometries}, textures ${s2.textures} / ${r.textures}`;
  });
  for (const [label, name, cfg] of STARTS) {
    await T.step(`${L}: restart: ${label} (${name})`, async () => {
      await T.start(name, L, cfg); rec(name);
      const f = await settled(S);
      await T.restart();
      const r = await settled(S);
      T.go(true); T.advance(4); const e = snap(S); T.go(false);
      T.check(...startTypeCheck(L, label, f, r, e, true, s2.world));
      return `start ${f.start}`;
    });
  }

  // ---------------- the start rules, over every flight started here ----------------
  await T.step(`${L}: start-rule wiring`, async () => {
    const { wiringChecks } = await import('./wiring.js');
    return wiringChecks(T, started.filter((s) => s.location === L));
  });
}

// The tour flight (smoke.js tour) and, right after it, the engine voice: cars' and bikes' engines are synthesized voices
// (motorSound.js) that audio.update drives every step; over the tour's drawn frames at full power the audio clock runs,
// so the voice's output gain has reached its level. Read at once (tour() lets go of the gas just before it returns; no
// step has run since). smoke.py's verdict: audible (gain >= 0.01) unless the audio clock stalled (no output device, #180):
// stalled meaning it ran under AUDIO_RUN s over the whole tour (an absolute advance, not a share of wall time).
const AUDIO_RUN = 0.3;
async function tourWithEngine(T) {
  const S = T.S, A = S.audio, a0 = A.ctx?.currentTime ?? 0;
  const f = await tour();
  const F = S.F, e = F?.ac.parts.find((p) => p.alive && p.engine && A.voices[p.engine.sound]?.motor);
  const m = e ? { kind: e.engine.sound, gain: A.voices[e.engine.sound].out.gain.value } : null;
  const ran = (A.ctx?.currentTime ?? 0) - a0, stalled = ran < AUDIO_RUN;
  T.checks(tourChecks(f));
  T.check('its engine voice plays, audible at full power', !!m && (m.gain >= 0.01 || stalled),
    !m ? 'no engine voice running (audio.voices)' : `${m.kind} gain ${m.gain.toFixed(3)}, audio clock +${ran.toFixed(2)} s${stalled ? ' (audio clock stalled: level not checked)' : ''}`);
  const r = f.ride;
  return `${f.ran.toFixed(2)} s over ${f.frames} frames; ${r ? `${r.speed.toFixed(0)} m/s, ` : ''}${f.views} cockpit view(s)${m ? `, engine ${m.gain.toFixed(2)}` : ''}`;
}

// a new World's textures stream in over its first moments: drawn frames until GPU memory holds still for 3 in a row
// (restart.py waited 600 ms of wall clock for the same)
async function memQuiet(T) {
  const m = () => { const i = T.S.renderer.info.memory; return `${i.textures}/${i.geometries}`; };
  let last = m(), calm = 0;
  await T.untilFrames(() => { const k = m(); calm = k === last ? calm + 1 : 0; last = k; return calm >= 3; }, { max: 120, what: 'GPU memory to hold still after the fresh start' });
}
