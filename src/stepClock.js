// Streaming under the test stepper. In play, the streaming systems (terrain tiles, far field, flora, road tiles, city
// blocks, minimap, geodata) each work to a wall-clock budget per frame and debounce / re-plan in wall time, so a
// frame never hitches. Under window.__sky.advance (tests: many game steps per real frame, no drawing) wall time says
// nothing about game time, and a slow machine (CI) would stream less per game second than a fast one: a test's
// verdict would depend on the machine. So while the stepper runs, STEP.on is set and
//  - each budgeted loop gets a fixed number of work units per step instead of milliseconds (slice(ms, units));
//  - now() is a game clock (ms), advanced by each step's dt, for debounces and re-plan intervals.
// Outside the stepper both are exactly what they were (performance.now(), ms budgets). now() stays monotonic across
// the switch: it continues from wherever the game clock got to.
export const STEP = { on: false, ms: 0, skew: 0 };
export const now = () => (STEP.on ? STEP.ms : performance.now() + STEP.skew);
// a budget for one frame's (or step's) loop: more() is true while there is room for another unit of work
export function slice(ms, units) {
  if (STEP.on) { let n = 0; return () => n++ < units; }
  const t0 = performance.now(); return () => performance.now() - t0 < ms;
}
// the stepper: run fn with the game clock on; step(dt) advances it by one step's game time (s)
export function stepping(fn) {
  if (STEP.on) return fn();
  STEP.ms = performance.now() + STEP.skew; STEP.on = true;
  try { return fn(); } finally { STEP.on = false; STEP.skew = Math.max(STEP.skew, STEP.ms - performance.now()); }
}
export function stepTick(dt) { STEP.ms += dt * 1000; }
