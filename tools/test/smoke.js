// In-page part of smoke.py's tour (see smoke.py). Needs window.__sky.
const S = window.__sky;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (ms = 1000) => new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), ms); }); // (one frame drawn, or ms passed: a software GPU on CI draws one every few seconds)
const BASE = { online: false, mode: 'free', start: 'runway', weather: 'clear', time: 10, realism: 'pilot' };

// Start `name` at `location` with the flight config `cfg` (over BASE). Where the current flight is at the same place
// (same World key: place, quality, time, weather), the vehicle is swapped in (a restart with a new design: the World is
// kept, ~1 s), else a new flight builds the place (3-6 s). Resolves once the flight clock runs and the loading screen's
// shader warm-up is over.
export async function start(name, location, cfg = {}) {
  const d = S.presets.find((p) => p.name === name); if (!d) throw new Error(`no preset ${name}`);
  const want = { ...BASE, location, ...cfg }, old = S.F, t0 = performance.now();
  const swap = !!old && old.cfg.location === want.location && old.cfg.time === want.time && old.cfg.weather === want.weather && old.cfg.moon === (want.moon ?? old.cfg.moon);
  S.controls.setThrottle(0); S.controls.pedal.gas = 0; S.controls.keys.clear?.();
  if (swap) { Object.assign(old.cfg, want); S.swapVehicle(d); }
  else {
    if (old) S.endFlight();
    S.hangar.load(d); S.startFlight(want);
  }
  while (!(S.F && S.F !== old && S.F.t > 0)) { if (performance.now() - t0 > 120000) throw new Error(`${name} at ${location}: the flight did not start in 120 s`); await sleep(10); }
  while (S.F.warm) { if (performance.now() - t0 > 150000) throw new Error('the loading screen never went'); await sleep(10); }
  const F = S.F;
  return { how: swap ? 'swapped in' : 'new World', kept: !!old && F.world === old.world, ms: performance.now() - t0, start: F.cfgStart, kind: F.kind };
}

// the controls a player uses to get going: the throttle (planes, helicopters, rockets), the gas pedal (cars, boats), W (bikes)
function go(on) {
  const ac = S.F.ac, c = S.controls;
  if (ac.isBike) { if (on) c.keys.add('w'); else c.keys.delete('w'); }
  else if (c.vehicle === 'car') c.pedal.gas = on ? 1 : 0;
  else c.setThrottle(on ? 1 : 0);
}
const finite = (v) => [v.x, v.y, v.z].every(Number.isFinite);
export function state() {
  const F = S.F; if (!F) return null; const a = F.ac;
  return { t: F.t, pos: finite(a.x), vel: finite(a.v), alive: a.parts.filter((p) => p.alive).length, parts: a.parts.length, speed: a.v.length(), alt: a.x.y, up: a.up.y, dead: !!a.dead };
}

// A tour flight on the real game loop (frames drawn, the engine heard): full power for `secs` of wall time, then `more`
// game seconds stepped without drawing (advance), then every cockpit view drawn once. Returns the measurements; smoke.py
// judges them.
export async function fly(secs = 2, more = 3) {
  const F = S.F, a0 = S.audio.ctx?.currentTime ?? 0, c0 = window.__inflightCompiles || 0;
  go(true);
  const t0 = F.t, w0 = performance.now();
  await sleep(secs * 1000);
  for (let i = 0; i < 300 && S.F === F && F.t === t0; i++) await sleep(100); // (software WebGL on a CI runner can take seconds per frame: wait up to 30 s for the first one)
  const ran = F.t - t0, wall = (performance.now() - w0) / 1000;
  // cars, bikes and boats have their own synthesized engine voice (src/motorSound.js): it must be running and audible
  const e = F.ac.parts.find((p) => p.alive && p.engine && S.audio.voices[p.engine.sound]?.motor);
  const motor = e ? { kind: e.engine.sound, gain: S.audio.voices[e.engine.sound].out.gain.value } : null;
  // a stalled audio clock (no output device, e.g. a Mac whose speakers went away) freezes every ramped gain (#180)
  const stalled = (S.audio.ctx?.currentTime ?? 0) - a0 < wall * 0.25;
  if (more) S.advance(more);
  const ride = state();
  // every cockpit view (one per seat, src/stations.js), the way the camera button steps through them, each drawn
  const ac = F.ac; S.rig.set('cockpit', ac); const views = ac.stations.length, names = [];
  for (let k = 0; k < views; k++) { names.push(S.rig.stationName(ac)); await frame(); S.rig.next(ac); }
  await frame();
  const leftCockpit = S.rig.mode !== 'cockpit';
  S.rig.set('chase'); await frame();
  go(false);
  return { ran, wall, motor, stalled, ride, views, names, leftCockpit, compiles: (window.__inflightCompiles || 0) - c0, end: state() };
}

// A quick in-page check (no real-time flying): `secs` game seconds at full power stepped with advance().
export function quick(secs = 2) {
  go(true); S.advance(secs); const s = state(); go(false); return s;
}

// ---------- for the per-map jobs (tools/test/jobs): the tour flight with fixed frame counts, no wall-clock waits ----------
// Against the flight already running (harness T.start): full power on the real game loop for `n` drawn frames (the
// loop runs: the flight clock moves; each steps a fixed 1/60 s, __sky.fixedDt, so the ride judged after them is the
// same game time on any machine, not min(frame time, 1/20) a frame), `more` game seconds stepped (advance), then every
// cockpit view drawn once as the camera button steps through them, and back to the chase view. Judge it with tourChecks.
import { frames as drawFrames, advance } from './jobs/harness.js';
export async function tour({ frames: n = 3, more = 3 } = {}) {
  const F = S.F; if (!F) throw new Error('no flight');
  go(true);
  const t0 = F.t; S.fixedDt = 1 / 60;
  try { await drawFrames(n, { what: 'the tour flight on the real loop' }); } finally { S.fixedDt = null; }
  const ran = S.F === F ? F.t - t0 : 0;
  if (more && S.F === F) advance(more);
  const ride = state();
  const ac = F.ac; S.rig.set('cockpit', ac); const views = ac.stations.length, names = [];
  for (let k = 0; k < views; k++) { names.push(S.rig.stationName(ac)); await drawFrames(1, { what: `cockpit view ${k + 1}` }); S.rig.next(ac); }
  await drawFrames(1);
  const leftCockpit = S.rig.mode !== 'cockpit';
  S.rig.set('chase'); await drawFrames(1);
  go(false);
  return { name: ac.design.name, kind: F.kind, bike: !!ac.isBike, ran, frames: n, ride, views, names, leftCockpit, end: S.F === F ? state() : null };
}
// [[name, ok, detail]] for T.checks (smoke.py's verdicts on a tour flight; its audio check lives in the hangar job)
export function tourChecks(f) {
  const e = f.end, r = f.ride, out = [];
  out.push(['still flying (the flight did not end on its own)', !!(e && r), '']);
  if (!e || !r) return out;
  out.push(['finite position and velocity', r.pos && r.vel && e.pos && e.vel, '']);
  out.push(['the frame loop runs (the flight clock moved over the drawn frames)', f.ran > 0, `${f.ran.toFixed(2)} s over ${f.frames} frames`]);
  out.push(['in one piece', e.parts > 0, `${e.alive}/${e.parts} parts`]);
  if (f.bike) out.push(['the bike stays up and rides off', r.up >= 0.7 && r.speed >= 3, `up ${r.up.toFixed(2)}, ${r.speed.toFixed(1)} m/s`]);
  out.push(['the camera button visits every seat and leaves the cockpit', f.leftCockpit, `${f.views} view(s): ${f.names.join(', ')}`]);
  return out;
}
