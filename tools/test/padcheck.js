// Launch pad check (run in the page by padcheck.py). See padcheck.py for what it checks. The flight's own time is
// stepped with __sky.advance (no frames drawn), one 1/60 s step at a time so every step can be checked.
import { chooseStart, findWater, LAND_STARTS, BOAT_STARTS } from '../../src/startChoice.js';
const S = window.__sky;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = { online: false, start: 'runway', mode: 'free', weather: 'clear', time: 10 };

// Load a preset and start a flight; resolves as soon as the flight exists (before its first step). Where the current
// flight is at the same place (same World key), the vehicle is swapped in (a restart with a new design: the World is
// kept), else a new flight builds the place.
export async function start(name, location, cfg = {}) {
  const d = S.presets.find((p) => p.name === name); if (!d) throw new Error(`no preset ${name}`);
  const want = { ...BASE, location, ...cfg }, old = S.F;
  S.controls.setThrottle(0); S.controls.pedal.gas = 0;
  if (old && old.cfg.location === location && old.cfg.time === want.time && old.cfg.weather === want.weather) { Object.assign(old.cfg, want); S.swapVehicle(d); }
  else { if (old) S.endFlight(); S.hangar.load(d); S.startFlight(want); }
  for (let i = 0; i < 6000 && !(S.F && S.F !== old); i++) await sleep(5);
  if (!S.F || S.F === old) throw new Error('the flight did not start');
  return S.F;
}
// wait until the flight clock runs and the loading screen's shader warm-up is over (frames: the warm-up draws)
export async function running(F, wall = 120000) { const t0 = performance.now(); while (!(F.t > 0) || F.warm) { if (performance.now() - t0 > wall) throw new Error('the flight clock never started'); await sleep(5); } }
// step the flight 1/60 s at a time (advance) until done() or `limit` game seconds; false if it hit the limit
export function steps(F, done, limit = 60) { const t0 = F.t; while (!done()) { if (F.t - t0 > limit || S.F !== F) return false; S.advance(1 / 60); } return true; }

// the spawn pose exactly as buildFlight left it (no physics step has run yet)
export async function spawn(name, location, cfg = {}) {
  const F = await start(name, location, cfg);
  if (F.t) throw new Error('the flight stepped before the spawn pose was read');
  const r = { name, location, start: F.cfgStart, x: F.ac.x.toArray(), q: F.ac.q.toArray(), v: F.ac.v.toArray() };
  await running(F);
  return r;
}

// Where every stock vehicle would start here, for every start choice (start, mode, land start, boat start), by the
// game's own rule (startChoice.js chooseStart) with this World's answers: no flight started for any of them. Returns
// [{ name, cfg, start, vertical, heli }].
let gearInfo = null;
export function predict(F = S.F) {
  const W = F.world;
  // (as buildFlight reads them off the built Aircraft, whose parts take engine and gear from their PARTS entry)
  gearInfo ??= Object.fromEntries(S.presets.map((d) => { const defs = d.parts.map((p) => S.PARTS[p.id]).filter(Boolean); return [d.name, { gearOK: defs.some((g) => g.gear && (!g.gear.float || g.gear.skid)), hasEngine: defs.some((g) => g.engine) }]; }));
  let water; const w = { water: () => (water === undefined ? (water = findWater(W)) : water), site: (s) => W.startSite(s), siteBusy: () => false, padOK: () => !!W.pad?.stand, landStart: (s) => W.landStart(s), waterPark: () => W.waterParks?.start ?? null };
  const out = [];
  for (const d of S.presets) {
    const st = S.analyze(d), g = gearInfo[d.name];
    for (const start of ['runway', 'air', 'water']) for (const mode of ['free', 'rings', 'landing']) for (const landStart of st.car ? [...LAND_STARTS, 'runway', undefined] : [undefined]) for (const boatStart of st.boat ? [...BOAT_STARTS, undefined] : [undefined]) {
      const cfg = { start, mode, landStart, boatStart };
      out.push({ name: d.name, cfg, start: chooseStart(st, cfg, { ...g, ...w }).start, vertical: !!st.vertical, heli: !!st.heli });
    }
  }
  return out;
}

export async function rocket(location, { name = 'Rocket', hold = 5, burn = 10 } = {}) {
  const T = S.THREE, F = await start(name, location), ac = F.ac, P = F.world.pad, r = { location, name, start: F.cfgStart };
  const ev = [], emit = ac.emit.bind(ac); ac.emit = (type, data) => { ev.push(type); emit(type, data); };
  const nose = () => new T.Vector3(0, 0, -1).applyQuaternion(ac.q).y; // 1 = pointing straight up
  const dmg = () => ac.parts.reduce((a, p) => a + p.dmg, 0), alive = () => ac.parts.filter((p) => p.alive).length;
  r.spawn = { axis: P.axisDist(ac.x.x, ac.x.z), nose: nose(), clamp: !!F.clamp };
  await running(F);
  // 5 s on the stand with the engines off
  S.controls.setThrottle(0);
  const x0 = ac.x.clone(), q0 = ac.q.clone(), t0 = F.t; let drift = 0, tilt = 0, off = 0, n = 0, vmax = 0;
  steps(F, () => { drift = Math.max(drift, ac.x.distanceTo(x0)); tilt = Math.max(tilt, ac.q.angleTo(q0)); vmax = Math.max(vmax, ac.v.length()); if (!ac.onGround) off++; n++; return F.t - t0 >= hold; });
  r.hold = { seconds: F.t - t0, frames: n, drift, tilt, vmax, offGround: off, events: [...new Set(ev)], dmg: dmg(), engines: F.eng.on };
  // full throttle: the clamps let go, it rises past the tower without touching it
  ev.length = 0; S.controls.setThrottle(1);
  const tw = P.tower, t1 = F.t, hp = new T.Vector3(); let rel = null, clear = Infinity, hits = 0, tiltLow = 0, armAtRelease = null;
  steps(F, () => {
    if (rel === null && !F.clamp) { rel = F.t - t1; armAtRelease = P.armT; }
    if (ac.x.y - P.deckY < tw.top - P.top + 20) {
      tiltLow = Math.max(tiltLow, Math.acos(Math.min(1, nose())));
      for (const p of ac.parts) {
        if (!p.alive) continue;
        if (P.hit(ac.worldPoint(p.center, hp))) hits++;
        for (const h of p.hull) {
          ac.worldPoint(h, hp); if (hp.y > tw.top) continue;
          const [lx, lz] = P.toLocal(hp.x, hp.z), dx = Math.max(0, Math.abs(lx - tw.lx) - tw.hw), dz = Math.max(0, Math.abs(lz - tw.lz) - tw.hw);
          clear = Math.min(clear, Math.hypot(dx, dz));
          if (P.hit(hp)) hits++;
        }
      }
    }
    return F.t - t1 >= burn || ac.dead;
  });
  r.burn = { seconds: F.t - t1, releasedAt: rel, armAtRelease, towerClearance: clear, towerHits: hits, tiltBelowTower: tiltLow, events: [...new Set(ev)], dmg: dmg(), alive: alive(), parts: ac.parts.length, height: ac.x.y - P.deckY, towerHeight: tw.top - P.top, arm: P.armT, dead: !!ac.dead };
  S.controls.setThrottle(0);
  r.inflightCompiles = window.__inflightCompiles || 0;
  return r;
}
