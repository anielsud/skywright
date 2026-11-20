// Launch pad check (run in the page by padcheck.py). See padcheck.py for what it checks.
const S = window.__sky;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

// end any flight, load a preset and start a flight; resolves as soon as the flight exists (before its first step)
async function start(name, location) {
  if (S.F) S.endFlight();
  for (let i = 0; i < 100 && S.F; i++) await sleep(50);
  const d = S.presets.find((p) => p.name === name); if (!d) throw new Error(`no preset ${name}`);
  S.hangar.load(d); S.controls.setThrottle(0);
  S.startFlight({ location, online: false, start: 'runway', mode: 'free', weather: 'clear', time: 10 });
  for (let i = 0; i < 3000 && !S.F; i++) await sleep(10);
  if (!S.F) throw new Error('the flight did not start');
  return S.F;
}
// wait (by frames) until the flight clock runs and the loading screen's shader warm-up is over
async function running(F, wall = 120000) { const t0 = performance.now(); while (!(F.t > 0) || F.warm) { if (performance.now() - t0 > wall) throw new Error('the flight clock never started'); await frame(); } }
// step frames until done() or the wall-clock limit
async function frames(done, wall = 60000) { const t0 = performance.now(); while (!done()) { if (performance.now() - t0 > wall) return false; await frame(); } return true; }

// the spawn pose exactly as buildFlight left it (no physics step has run yet)
export async function spawn(name, location) {
  const F = await start(name, location);
  if (F.t) throw new Error('the flight stepped before the spawn pose was read');
  const r = { name, location, start: F.cfgStart, x: F.ac.x.toArray(), q: F.ac.q.toArray(), v: F.ac.v.toArray() };
  await running(F);
  return r;
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
  await frames(() => { drift = Math.max(drift, ac.x.distanceTo(x0)); tilt = Math.max(tilt, ac.q.angleTo(q0)); vmax = Math.max(vmax, ac.v.length()); if (!ac.onGround) off++; n++; return F.t - t0 >= hold; });
  r.hold = { seconds: F.t - t0, frames: n, drift, tilt, vmax, offGround: off, events: [...new Set(ev)], dmg: dmg(), engines: F.eng.on };
  // full throttle: the clamps let go, it rises past the tower without touching it
  ev.length = 0; S.controls.setThrottle(1);
  const tw = P.tower, t1 = F.t, hp = new T.Vector3(); let rel = null, clear = Infinity, hits = 0, tiltLow = 0, armAtRelease = null;
  await frames(() => {
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
  r.inflightCompiles = window.__inflightCompiles || 0;
  return r;
}
