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
