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
