// What a flight start cost on this device, for the analytics events flight_ready and flight_perf (main.js).
//
// flight_ready: once per flight start (new World, restart, vehicle swap), when the loading screen goes away.
//   Phase times, ms, consecutive (they add up to total_ms, give or take rounding):
//     load_ms         Start pressed -> the place's baked data and the street cars' models loaded (startFlight)
//     world_ms        -> the World built (buildFlight `new World`; ~0 for a kept World: world 'kept')
//     setup_ms        -> vehicle, traffic, missions, HUD set up, just before the shader compile starts
//     compile_ms      -> every shader compiled (compileAsync resolved, or its 15 s safety timer fired: compile_via)
//     first_frame_ms  -> the first warm frame drawn (it also draws every hidden shadow caster: warmShaders)
//     effects_ms      -> the shaders as lit by a crash's flash compiled (compileWith; same 15 s safety timer)
//     settle_ms       -> the loading screen down: the World reported loaded (ready_via 'loaded') or the 3 s give-up
//                        fired ('giveup')
//     total_ms        Start pressed -> loading screen down
//   Inside world_ms, for a new World of a real place: towns_ms (RealScenery: buildings, rails, rivers...) and
//   city_ms (a city's tall buildings, part of towns_ms); null otherwise.
//   world 'new' | 'kept'; programs_new: shader programs made during the start, programs_total: all held;
//   frames_hidden: frames drawn under the loading screen.
//   Context: location, kind, start; quality (the setting), quality_tier (resolved), perf_level (Auto's shedding level,
//   0-3), res_scale; touch, dpr, canvas_w/h (drawing buffer px), parallel_compile (KHR_parallel_shader_compile),
//   gpu (a coarse family only, never the renderer string: apple adreno mali intel nvidia amd swiftshader other).
//   Every event also carries the device's $os, $browser, $device_type, cpu_cores, memory_gb (analytics.js).
// flight_perf: frame times over the first 10 s of flight after the loading screen (paused and hidden time not
//   counted), sent when the 10 s are in or when the flight ends first (complete false). frames, seconds,
//   ms_p50 / ms_p95 / ms_max (frame ms), over_50 (frames slower than 50 ms), gaps (frames over 1 s, left out: tab
//   switches), perf_level / res_scale at the end; plus location, kind, quality_tier, world, gpu.
// Anonymous: numbers and coarse labels only. Sent through analytics.capture, so the Settings opt-out (and local
// checkouts being off) apply as to every event. Tests read the same record as window.__sky.lastStart.

export const PERF_WINDOW_MS = 10000;
const PHASES = [['load_ms', 'data'], ['world_ms', 'world'], ['setup_ms', 'setup'], ['compile_ms', 'compiled'], ['first_frame_ms', 'frame'], ['effects_ms', 'effects'], ['settle_ms', 'ready']];

export function newStart(programs) { return { t0: performance.now(), marks: {}, via: {}, p0: programs, world: null, towns: null, city: null }; }
// the first time only (a safety timer firing after the real finish doesn't move it)
export function mark(r, name, t = performance.now()) { if (r && r.marks[name] == null) r.marks[name] = t; }

export function phases(r) {
  const out = {}; let prev = r.t0;
  for (const [k, m] of PHASES) { const t = r.marks[m]; out[k] = t == null ? null : Math.round(t - prev); if (t != null) prev = t; }
  out.total_ms = r.marks.ready == null ? null : Math.round(r.marks.ready - r.t0);
  return out;
}

export function gpuFamily(gl) {
  let s = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info'); // (deprecated in Firefox, which then sanitizes RENDERER itself)
    s = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '').toLowerCase();
  } catch { return 'other'; }
  // the GPU before the vendor: ANGLE on a Mac says "ANGLE (Apple, ANGLE Metal Renderer: AMD Radeon ...)"
  if (/swiftshader/.test(s)) return 'swiftshader';
  if (/adreno/.test(s)) return 'adreno';
  if (/mali/.test(s)) return 'mali';
  if (/nvidia|geforce|quadro|tegra/.test(s)) return 'nvidia';
  if (/amd|radeon|ati /.test(s)) return 'amd';
  if (/intel/.test(s)) return 'intel';
  if (/apple/.test(s)) return 'apple';
  return 'other';
}

// frame ms list -> the stats flight_perf carries
export function frameStats(ms) {
  const a = [...ms].sort((x, y) => x - y), q = (p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  const r = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return { frames: a.length, seconds: Math.round(a.reduce((s, v) => s + v, 0) / 100) / 10, ms_p50: r(q(0.5)), ms_p95: r(q(0.95)), ms_max: r(a[a.length - 1] ?? null), over_50: a.filter((v) => v > 50).length };
}
