// The in-page half of tools/test/jobs.py: one boot, one page, one job (tools/test/jobs/<job>.js), its checks run as
// named steps against flights started in a shared World. jobs.py boots the page, then calls runJob(job, opts), which
// imports ./<job>.js and awaits its `export async function run(T)`.
//
// THE RULES (#278): test only what needs testing. On CI (software GPU) a drawn frame costs 1-2 s, building a map
// 22-50 s, swapping a vehicle 10-30 s. So
//   - build each map once per job: the first T.start at a place builds its World, every later T.start there swaps the
//     vehicle into it (keep BASE's time and weather: a different time, weather or moon builds a new World);
//   - step the game with T.advance / T.stepUntil (no drawing); draw frames (T.frames(n), fixed counts) only for claims
//     about drawing: shaders, cockpit views, the real loop running;
//   - never wait for wall-clock time: every wait is on a game state (T.until, T.untilFrames, T.stepUntil) or a frame
//     count. Their time limits are safety nets only: generous, and they fail loudly, naming what was awaited.
//
// ---------------------------------------------------------------------------------------------------------------
// API: a job file
//
//   export async function run(T) {
//     await T.step('nyc: build + Dragonfly from the helipad', async () => {
//       const s = await T.start('Dragonfly', 'nyc');           // builds New York (first flight here)
//       T.check('starts on the helipad', s.start === 'helipad', `started at ${s.start}`);
//       return `${s.how} in ${(s.ms / 1000).toFixed(1)} s`;   // (optional detail for the PASS line)
//     });
//     await T.step('nyc: Rocket on the pad', async () => { await T.start('Rocket', 'nyc'); ... }); // swapped in
//   }
//
// Steps (each prints one PASS/FAIL line in jobs.py with its wall time, frames drawn and game seconds stepped)
//   T.step(name, fn, { timeout = 600, allowStalls = false }) -> Promise<boolean ok>
//       Runs `await fn(T)` as a named step. It fails if fn throws, if a T.check inside it fails, if the page logs a
//       console error / uncaught exception / failed request of ours while it runs (jobs.py attributes those), or if a
//       shader program compiled mid-flight during it (a stall: main.js's window.__inflightCompiles; every step checks
//       this unless allowStalls). fn's return value, if a string (or { detail }), is shown on the PASS line.
//       `timeout` (seconds; doubled with --ci) is a safety net: when it fires, the step fails naming what it was
//       waiting for and every later step is skipped (the page is in an unknown state). Steps don't nest.
//   T.check(name, ok, detail = '') -> boolean     one named check; inside a step it is part of that step (a failed
//       check fails the step), outside a step it is a result line of its own.
//   T.checks([[name, ok, detail], ...]) -> boolean    several (the old suites' xxxChecks(r) helpers return this shape)
//   T.log(msg)                                     an info line under the current step
//   T.shot(name) -> Promise                        a screenshot, <out>/<job>-<name>.png (jobs.py takes it)
//   T.job, T.ci (true with --ci: no frame-time limits), T.quality, T.S (window.__sky), T.F (the flight), T.THREE
//
// Flights (all resolve on game state; `name` is a stock preset's name or a design object)
//   T.start(name, location, cfg = {}) -> { F, how: 'new World' | 'swapped in', ms, frames, start, kind }
//       Starts `name` at `location` with BASE + cfg (cfg: start, mode, realism, landStart, boatStart, ...; anything a
//       flight config takes). If the current flight is at the same place, time, weather and moon it swaps the vehicle
//       into the same World (__sky.swapVehicle), else it ends it and builds the place. Resolves once the new flight's
//       clock runs and the loading screen's warm-up is over (F.t > 0 && !F.warm). Throttle, gas and keys released.
//       `start` is where it started (F.cfgStart: 'runway', 'air', 'pad', 'helipad', 'park', 'road', 'marina', ...).
//   T.restart() -> same shape    restart the current flight (pause > Restart): same vehicle, same World
//   T.end() -> Promise           back to the hangar (the World is freed)
//
// Game time (no frames drawn)
//   T.advance(sec, dt = 1/60) -> game seconds stepped   (__sky.advance; throws if it could step nothing: the flight
//       is paused, warming up or gone)
//   T.stepUntil(cond, { max = 60, dt = 1/60, what, soft = false }) -> game seconds taken
//       steps dt at a time until cond() is true; after `max` game seconds it throws (soft: returns false)
//   T.go(on = true)              full power the way a player gets going (throttle; gas pedal for cars and boats; W
//       for bikes), or everything off
//   T.state() -> { t, pos, vel, alive, parts, speed, alt, up, dead } (pos/vel: finite)
//   T.teleport({ pos, q, heading, v = 0 })   put the vehicle at pos ([x,y,z] or a Vector3), attitude q ([x,y,z,w] or
//       a Quaternion) or heading (radians, 0 = facing -Z), velocity v ([x,y,z], or a number: forward speed m/s);
//       spin zeroed
//
// Drawing
//   T.frames(n) -> { frames, ms }        wait for n frames drawn by the page's own loop (requestAnimationFrame)
//   T.untilFrames(cond, { max = 60, what })  check cond() once per drawn frame; throws after max frames
//   T.until(cond, { what, timeout = 120 })   poll a state (every 20 ms) that the game reaches by itself (a DOM
//       change, an async load); throws after the safety timeout
//   T.settle({ quiet = 2, max = 40, chunk = 0.5 }) -> { rounds, frames, late }
//       streaming quiet: holds the vehicle where it is and repeats [step `chunk` game s (the world streams in round
//       it), draw one frame (new objects compile: late shows are counted)] until `quiet` rounds in a row add no late
//       show and the World says it is loaded. Use before a check that must not see streaming's late shows.
//
// Shader counters
//   T.counters() -> { stall, late, programs, drawn, stepped }   (main.js's window.__inflightCompiles, __lateShows,
//       renderer.info.programs, frames drawn and game seconds stepped so far)
//   T.since(c0) -> the same, as deltas since c0
//   T.noStalls(name, c0) / T.noLateShows(name, c0) -> boolean    a check that nothing stalled / waited for its shader
//       since c0 (with the shader names from main.js's '[shaders]' messages when it fails)
//
// The same flight helpers are exported as plain functions (startFlight, restart, endFlight, frames, advance,
// stepUntil, until, untilFrames, settle, teleport, go, state, counters, since, BASE) for the old suites' modules
// (smoke.js, padcheck.js, shadercheck.js, ...), so their checks can run against a flight a job already started.
// ---------------------------------------------------------------------------------------------------------------

const sky = () => window.__sky;
let SCALE = 1; // (safety timeouts x2 with --ci)

// The flight config every job flight starts from. Keep time and weather: they are part of the World's key, so changing
// them builds a new World (22-50 s on CI). landStart/boatStart undefined: the start rule's defaults, not whatever the
// last flight or the page's saved flight setup asked for.
export const BASE = Object.freeze({ online: false, mode: 'free', start: 'runway', landStart: undefined, boatStart: undefined, weather: 'clear', time: 10, realism: 'pilot' });

// ---------- counters: frames drawn, game seconds stepped, shader messages ----------
let drawn = 0, stepped = 0, waiting = '';
{ const tick = () => { drawn++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
const shaderLog = []; // main.js's '[shaders] ...' warnings and infos, in order
for (const level of ['warn', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[shaders]')) shaderLog.push(a.join(' ')); orig(...a); };
}
// count the game seconds every caller steps (the old suites call __sky.advance directly)
{
  const S = sky(), adv = S.advance;
  if (!adv.__counted) {
    S.advance = function (seconds, dt) { const F = S.F, t0 = F?.t ?? 0, r = adv.call(this, seconds, dt); if (F && S.F === F) stepped += F.t - t0; return r; };
    S.advance.__counted = true;
  }
}

export function counters() {
  const S = sky();
  return { stall: window.__inflightCompiles || 0, late: window.__lateShows || 0, programs: S.renderer.info.programs?.length ?? 0, drawn, stepped, log: shaderLog.length };
}
export function since(c0) {
  const c = counters();
  return { stall: c.stall - c0.stall, late: c.late - c0.late, programs: c.programs - c0.programs, drawn: c.drawn - c0.drawn, stepped: c.stepped - c0.stepped, messages: shaderLog.slice(c0.log) };
}

// ---------- waits (each with a safety net that fails loudly) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (what) => (waiting = what);

// Poll a state the game reaches on its own (every 20 ms); throws after the safety timeout (seconds).
export async function until(cond, { what = 'a condition', timeout = 120 } = {}) {
  const t0 = performance.now(), lim = timeout * SCALE * 1000; say(what);
  while (!cond()) { if (performance.now() - t0 > lim) throw new Error(`safety timeout: ${what} not reached in ${Math.round(lim / 1000)} s`); await sleep(20); }
  say('');
}
// n frames drawn by the page's own loop. (Safety: 60 s + 30 s a frame; a software GPU draws one every 1-4 s.)
export function frames(n = 1, { what } = {}) {
  const t0 = performance.now(), lim = (60 + 30 * n) * SCALE * 1000; say(what || `${n} frame(s) drawn`);
  return new Promise((res, rej) => {
    let k = 0;
    const timer = setTimeout(() => rej(new Error(`safety timeout: ${k} of ${n} frames drawn in ${Math.round(lim / 1000)} s`)), lim);
    const f = () => { if (++k >= n) { clearTimeout(timer); say(''); res({ frames: n, ms: performance.now() - t0 }); } else requestAnimationFrame(f); };
    if (n <= 0) { clearTimeout(timer); res({ frames: 0, ms: 0 }); } else requestAnimationFrame(f);
  });
}
// cond() checked once per drawn frame; throws after `max` frames
export async function untilFrames(cond, { max = 60, what = 'a condition' } = {}) {
  for (let k = 0; !cond(); k++) { if (k >= max) throw new Error(`${what}: not reached in ${max} frames`); await frames(1, { what: `${what} (frame ${k + 1} of at most ${max})` }); }
}

// ---------- game time ----------
export function advance(sec, dt = 1 / 60) {
  const S = sky(), F = S.F; if (!F) throw new Error('advance: no flight');
  const t0 = F.t; S.advance(sec, dt); const d = (S.F === F ? F.t : t0) - t0;
  if (sec > 0 && d <= 0) throw new Error(`advance(${sec}) stepped nothing: the flight is ${S.F !== F ? 'gone' : F.paused ? 'paused' : F.warm?.pending ? 'still warming up' : 'stuck'}`);
  return d;
}
export function stepUntil(cond, { max = 60, dt = 1 / 60, what = 'a condition', soft = false } = {}) {
  const S = sky(), F = S.F; if (!F) throw new Error('stepUntil: no flight');
  const t0 = F.t;
  while (!cond()) {
    if (S.F !== F) throw new Error(`stepUntil: the flight ended while waiting for ${what}`);
    if (F.t - t0 >= max) { if (soft) return false; throw new Error(`${what}: not reached in ${max} game seconds`); }
    advance(dt, dt);
  }
  return F.t - t0;
}

// ---------- flights ----------
const preset = (name) => {
  if (typeof name !== 'string') return name;
  const d = sky().presets.find((p) => p.name === name); if (!d) throw new Error(`no stock vehicle named ${name}`);
  return d;
};
const loadingShown = () => document.getElementById('loading')?.classList.contains('show');
function release() { const c = sky().controls; c.setThrottle(0); c.pedal.gas = 0; c.keys.clear?.(); }
// the next flight (not `old`) running: clock started, loading screen's warm-up over
async function running(old, what, t0) {
  const S = sky();
  await until(() => {
    if (!S.F && !loadingShown()) throw new Error(`${what}: the flight failed to start (see the page's console error)`);
    return S.F && S.F !== old && S.F.t > 0 && !S.F.warm;
  }, { what, timeout: 300 });
  const F = S.F;
  return { F, ms: performance.now() - t0, start: F.cfgStart, kind: F.kind };
}

export async function startFlight(name, location, cfg = {}) {
  const S = sky(), d = preset(name), want = { ...BASE, location, ...cfg }, old = S.F, t0 = performance.now(), f0 = drawn;
  const swap = !!old && old.cfg.location === want.location && old.cfg.time === want.time && old.cfg.weather === want.weather && old.cfg.moon === (want.moon ?? old.cfg.moon);
  release();
  if (swap) { Object.assign(old.cfg, want); S.swapVehicle(d); }
  else { if (old) S.endFlight(); S.hangar.load(d); S.startFlight(want); }
  const r = await running(old, `${d.name} at ${location} to start (${swap ? 'swapped in' : 'new World'})`, t0);
  return { ...r, how: swap ? 'swapped in' : 'new World', frames: drawn - f0 };
}
export async function restart() {
  const S = sky(), old = S.F, t0 = performance.now(), f0 = drawn; if (!old) throw new Error('restart: no flight');
  release(); S.restartFlight();
  const r = await running(old, `${old.ac.design.name} to restart`, t0);
  return { ...r, how: 'restarted', frames: drawn - f0 };
}
export async function endFlight() {
  const S = sky(); if (!S.F) return;
  S.endFlight();
  await until(() => !S.F && document.getElementById('hangar-ui')?.style.display === '', { what: 'the hangar after ending the flight', timeout: 60 });
}

// the controls a player uses to get going: the throttle (planes, helicopters, rockets), the gas pedal (cars, boats), W (bikes)
export function go(on = true) {
  const S = sky(), ac = S.F.ac, c = S.controls;
  if (ac.isBike) { if (on) c.keys.add('w'); else c.keys.delete('w'); }
  else if (c.vehicle === 'car') c.pedal.gas = on ? 1 : 0;
  else c.setThrottle(on ? 1 : 0);
}
const finite = (v) => [v.x, v.y, v.z].every(Number.isFinite);
export function state() {
  const F = sky().F; if (!F) return null; const a = F.ac;
  return { t: F.t, pos: finite(a.x), vel: finite(a.v), alive: a.parts.filter((p) => p.alive).length, parts: a.parts.length, speed: a.v.length(), alt: a.x.y, up: a.up.y, dead: !!a.dead };
}
const arr = (v) => (Array.isArray(v) ? v : v.toArray());
export function teleport({ pos, q, heading, v = 0 } = {}) {
  const S = sky(), ac = S.F.ac;
  if (pos) ac.x.fromArray(arr(pos));
  if (q) ac.q.fromArray(arr(q));
  else if (heading != null) ac.q.setFromAxisAngle(new S.THREE.Vector3(0, 1, 0), heading);
  if (typeof v === 'number') ac.v.set(0, 0, -v).applyQuaternion(ac.q); else ac.v.fromArray(arr(v));
  ac.w?.set?.(0, 0, 0);
}

// Streaming quiet: see the header. Frame-count and state based (no wall clock).
export async function settle({ quiet = 2, max = 40, chunk = 0.5 } = {}) {
  const S = sky(), F = S.F; if (!F) throw new Error('settle: no flight');
  const ac = F.ac, x = ac.x.clone(), q = ac.q.clone(), pin = () => { ac.x.copy(x); ac.q.copy(q); ac.v.set(0, 0, 0); ac.w?.set?.(0, 0, 0); };
  const c0 = counters(); let calm = 0, rounds = 0;
  while (calm < quiet) {
    if (++rounds > max) throw new Error(`streaming never went quiet: ${max} rounds, ${since(c0).late} late shows`);
    const late = window.__lateShows || 0;
    for (let i = Math.max(1, Math.round(chunk * 60)); i > 0 && S.F === F; i--) { pin(); advance(1 / 60); }
    pin(); await frames(1, { what: `streaming to go quiet (round ${rounds})` });
    if (S.F !== F) throw new Error('settle: the flight ended');
    calm = (window.__lateShows || 0) === late && F.world.loaded?.() !== false ? calm + 1 : 0;
  }
  pin();
  const d = since(c0);
  return { rounds, frames: d.drawn, late: d.late };
}

// ---------- reporting (read by jobs.py from the console) ----------
const TAG = '\u0001T';
const emit = (ev) => console.debug(TAG + JSON.stringify(ev));
const describe = (e) => (e?.stack && !String(e.stack).startsWith(String(e.message)) ? `${e.message} (${String(e.stack).split('\n')[1]?.trim() ?? ''})` : String(e?.stack || e?.message || e));
const shaderNames = (msgs) => msgs.filter((m) => /compiled in flight|stalling/.test(m)).join(' | ').slice(0, 800);

class SafetyTimeout extends Error {}

function makeT(job, opts) {
  let cur = null, aborted = '', failed = 0, shotId = 0;
  const acks = new Set();
  const T = {
    job, ci: !!opts.ci, quality: opts.quality,
    get S() { return sky(); }, get F() { return sky().F; }, get THREE() { return sky().THREE; },
    BASE,

    async step(name, fn, { timeout = 600, allowStalls = false } = {}) {
      if (cur) throw new Error(`T.step('${name}') inside T.step('${cur.name}'): steps don't nest`);
      if (aborted) { emit({ e: 'begin', name, timeout: 0 }); emit({ e: 'end', name, ok: false, ms: 0, frames: 0, stepped: 0, error: `not run: ${aborted}` }); failed++; return false; }
      const lim = timeout * SCALE, c0 = counters(), t0 = performance.now();
      cur = { name, bad: 0 };
      emit({ e: 'begin', name, timeout: lim });
      let ok = true, error = '', detail = '', timer = null;
      try {
        const r = await Promise.race([
          Promise.resolve().then(() => fn(T)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new SafetyTimeout(`safety timeout after ${Math.round(lim)} s${waiting ? `, waiting for ${waiting}` : ''}`)), lim * 1000); }),
        ]);
        detail = typeof r === 'string' ? r : (r && typeof r.detail === 'string' ? r.detail : '');
      } catch (e) {
        ok = false; error = e instanceof SafetyTimeout ? e.message : describe(e);
        if (e instanceof SafetyTimeout) aborted = `'${name}' hit its safety timeout`;
      } finally { clearTimeout(timer); }
      const d = since(c0);
      if (!allowStalls && d.stall > 0) { ok = false; error = (error ? error + '; ' : '') + `${d.stall} shader program(s) compiled mid-flight, stalling a frame: ${shaderNames(d.messages)}`; }
      if (cur.bad) ok = false;
      emit({ e: 'end', name, ok, ms: performance.now() - t0, frames: d.drawn, stepped: d.stepped, stalls: d.stall, late: d.late, detail, error });
      cur = null; waiting = '';
      if (!ok) failed++;
      return ok;
    },
    check(name, ok, detail = '') {
      ok = !!ok;
      emit({ e: 'check', name, ok, detail: detail == null ? '' : String(detail), inStep: !!cur });
      if (!ok) { if (cur) cur.bad++; else failed++; }
      return ok;
    },
    checks(list) { let all = true; for (const [n, ok, d] of list) all = T.check(n, ok, d) && all; return all; },
    log(msg) { emit({ e: 'log', msg: String(msg) }); },
    async shot(name) {
      const id = ++shotId; emit({ e: 'shot', id, name });
      await until(() => acks.has(id), { what: `screenshot ${name}`, timeout: 120 }); acks.delete(id);
    },
    ack(id) { acks.add(id); return 1; }, // (jobs.py, once it has the screenshot)

    start: startFlight, restart, end: endFlight,
    advance, stepUntil, go, state, teleport,
    frames, untilFrames, until, settle,
    counters, since,
    noStalls(name, c0) { const d = since(c0); return T.check(name, d.stall === 0, d.stall ? `${d.stall} compiled mid-flight: ${shaderNames(d.messages)}` : ''); },
    noLateShows(name, c0) { const d = since(c0); return T.check(name, d.late === 0, d.late ? `${d.late} waited for their shader: ${d.messages.filter((m) => /shown when compiled/.test(m)).join(' | ').slice(0, 800)}` : ''); },
    get failed() { return failed; },
  };
  return T;
}

// Called by jobs.py (not awaited: it reads the events as they come). opts: { quality, ci }
export async function runJob(job, opts = {}) {
  SCALE = opts.ci ? 2 : 1;
  const T = (window.__T = makeT(job, opts));
  try {
    const mod = await import(`./${job}.js`);
    if (typeof mod.run !== 'function') throw new Error(`tools/test/jobs/${job}.js has no export run(T)`);
    await mod.run(T);
    emit({ e: 'done', ok: T.failed === 0 });
  } catch (e) {
    emit({ e: 'done', ok: false, error: describe(e) });
  }
}
