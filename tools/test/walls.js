// In-page part of walls.py: drives cars and bikes into building walls and measures how far anything of theirs gets
// inside a building. Needs a flight running (window.__sky.F) at a place with buildings.
//
// Buildings are read straight from the world's collision grids (towns / a real place's buildings: an entry per
// building with its box in e.ob; New York: a box per entry; the landmarks), not through world.wallBoxes, so the test
// doesn't trust the code it tests. For each chosen building face, the vehicle is set down 14 m out on the street,
// aimed at the face at an angle, given a speed and full gas, and the penetration of every hull point, wheel (centre
// and contact patch) into every building box nearby is tracked.
//   physics: steps the vehicle's own physics at 60 Hz from here (paused flight, F.env), deterministic.
//   game:    puts the flight's own vehicle there and lets the game loop run it in real time (its own controls, events,
//            building damage): what a player gets, and what main did before.
const DT = 1 / 60;

function boxOf(e) {
  if (e.ob) return e.ob;
  if (e.length >= 9) return { x: e[0], z: e[2], ux: e[5], uz: e[6], hl: e[7], hw: e[8] };
  return { x: e[0], z: e[2], ux: 1, uz: 0, hl: e[4], hw: e[4] };
}
// every building within r of (x, z): { x, z, ux, uz, hl, hw, y0, y1, e }
export function buildings(W, x, z, r) {
  const T = W.towns, out = [], seen = new Set();
  const add = (e) => { if (seen.has(e) || !(e[3] > 0)) return; seen.add(e); const b = boxOf(e); if (Math.hypot(b.x - x, b.z - z) < r + Math.hypot(b.hl, b.hw)) out.push({ ...b, y0: e[1], y1: e[1] + e[3], e }); };
  const g = T.city ? T.city.grid : T.grid;
  for (const a of g.values()) for (const e of a) if (e.solid) add(e);
  for (const e of T.landmarks?.boxes || []) add(e);
  return out;
}
// (a building's walls reach the street: New York's boxes start at the footprint's base height, which can sit a
// metre or two above the terrain under it, so a box counts from 2.5 m below its base)
const inside = (B, p) => {
  if (p.y <= B.y0 - 2.5 || p.y >= B.y1) return 0;
  const dx = p.x - B.x, dz = p.z - B.z, u = dx * B.ux + dz * B.uz, v = -dx * B.uz + dz * B.ux;
  const a = B.hl - Math.abs(u), b = B.hw - Math.abs(v);
  return a > 0 && b > 0 ? Math.min(a, b, B.y1 - p.y) : 0;
};
// the vehicle's points in the world: every part's hull points, and each wheel's centre and contact patch
function points(S, ac) {
  const T = S.THREE, out = [], v = new T.Vector3();
  for (const p of ac.parts) {
    if (!p.alive) continue;
    for (const h of p.hull) out.push(ac.worldPoint(h, new T.Vector3()));
    if (p.gear) for (const w of p.gear.wheels) { out.push(ac.worldPoint(v.copy(w.top).addScaledVector(w.dir, w.len), new T.Vector3())); out.push(ac.worldPoint(v.copy(w.top).addScaledVector(w.dir, w.len + w.r), new T.Vector3())); }
  }
  return out;
}
const penetration = (S, ac, boxes) => { let m = 0; for (const p of points(S, ac)) for (const B of boxes) m = Math.max(m, inside(B, p)); return m; };

// Faces with a clear, flat 16 m run-up: [{ B, nx, nz, tx, tz, cx, cz, gy }] (n: out of the face, t: along it)
export function faces(S, near, { r = 1500, max = 3, minH = 6, angles = ANGLES } = {}) {
  const W = S.F.world, all = buildings(W, near.x, near.z, r).filter((B) => B.hl > 3 && B.hw > 3 && B.y1 - B.y0 > minH);
  all.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z));
  const out = [];
  for (const B of all) {
    for (const [s, alongU] of [[1, true], [-1, true], [1, false], [-1, false]]) {
      const nx = alongU ? B.ux * s : -B.uz * s, nz = alongU ? B.uz * s : B.ux * s, half = alongU ? B.hl : B.hw, wide = alongU ? B.hw : B.hl;
      if (wide < 4) continue;
      const cx = B.x + nx * half, cz = B.z + nz * half;
      // a clear lane 16 m out along each run's angle, nothing else solid in it, the ground flat and at the building's foot
      let ok = true; const g0 = W.groundAt(cx + nx * 2, cz + nz * 2).h;
      if (Math.abs(g0 - B.y0) > 2.5) ok = false;
      for (const a of angles) for (let d = 1; d <= 16 && ok; d += 1) {
        const c = Math.cos(a * Math.PI / 180), sn = Math.sin(a * Math.PI / 180), dx = nx * c - nz * sn, dz = nz * c + nx * sn;
        const px = cx + dx * d, pz = cz + dz * d, g = W.groundAt(px, pz).h;
        if (Math.abs(g - g0) > 0.8 || g < W.waterLevel + 0.3) ok = false;
        for (let k = -2; k <= 2 && ok; k += 1) { const q = { x: px - dz * k, y: g + 0.5, z: pz + dx * k }; for (const C of all) if (C !== B && inside(C, q) > 0) { ok = false; break; } }
      }
      if (ok) { out.push({ B, nx, nz, tx: -nz, tz: nx, cx, cz, gy: g0 }); break; }
    }
    if (out.length >= max) break;
  }
  return out;
}

// One run into face f at speed v (m/s) and angle a (deg from straight on); mode 'physics' or 'game'
function setUp(S, ac, f, v, a) {
  const T = S.THREE, rad = a * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const dx = f.nx * c - f.nz * s, dz = f.nz * c + f.nx * s; // from the face out to the start
  const start = new T.Vector3(f.cx + dx * 14, 0, f.cz + dz * 14);
  ac.spawn(S.F.env, start, Math.atan2(dx, dz)); // facing back towards the face (heading 0 = -z)
  ac.v.set(-dx * v, 0, -dz * v); ac.engineRunning = true;
  return start;
}
export function physicsRun(S, design, f, v, a, realism = 'pilot', T = 2.5) {
  const F = S.F, ac = new S.Aircraft(JSON.parse(JSON.stringify(design)), S.REALISM[realism]);
  setUp(S, ac, f, v, a);
  const near = buildings(F.world, f.cx, f.cz, 60);
  let maxPen = 0, closest = Infinity, wallEvents = 0;
  for (let i = 0; i < T / DT; i++) {
    ac.setControls({ pitch: 0, roll: 0, yaw: 0, throttle: 1, rev: 0, hand: 0 }); ac.brake = 0;
    ac.step(DT, F.env);
    for (const e of ac.events.splice(0)) if (e.type === 'wall') wallEvents++;
    maxPen = Math.max(maxPen, penetration(S, ac, near));
    closest = Math.min(closest, Math.hypot(ac.x.x - f.cx, ac.x.z - f.cz));
  }
  return { maxPen: +maxPen.toFixed(3), closest: +closest.toFixed(2), wallEvents, up: +ac.up.y.toFixed(2), dead: !!ac.dead };
}
// the game loop: the flight's own vehicle, the pedal held down; resolves when done
export function gameRun(S, f, v, a, T = 2.5) {
  const F = S.F, ac = F.ac, near = buildings(F.world, f.cx, f.cz, 60);
  setUp(S, ac, f, v, a); F.paused = false; F.eng.on = true; ac.engineRunning = true;
  S.controls.pedal.gas = 1; S.controls.setThrottle?.(1);
  let maxPen = 0, closest = Infinity; const t0 = performance.now();
  return new Promise((res) => {
    const tick = () => {
      maxPen = Math.max(maxPen, penetration(S, ac, near)); closest = Math.min(closest, Math.hypot(ac.x.x - f.cx, ac.x.z - f.cz));
      if (performance.now() - t0 < T * 1000 && !ac.dead) requestAnimationFrame(tick);
      else { S.controls.pedal.gas = 0; S.controls.setThrottle?.(0); F.paused = true; res({ maxPen: +maxPen.toFixed(3), closest: +closest.toFixed(2), up: +ac.up.y.toFixed(2), dead: !!ac.dead }); }
    };
    requestAnimationFrame(tick);
  });
}

export const SPEEDS = [5, 15, 30, 45], ANGLES = [0, 35, -60];
// physics runs: every vehicle x face x speed x angle
export function run(S, names, { speeds = SPEEDS, angles = ANGLES, max = 3, realism = 'pilot' } = {}) {
  const F = S.F; F.paused = true;
  const fs = faces(S, F.ac.x, { max, angles }), out = [];
  for (const name of names) {
    const d = S.presets.find((p) => p.name === name);
    fs.forEach((f, k) => { for (const v of speeds) for (const a of angles) out.push({ name, face: k, v, a, ...physicsRun(S, d, f, v, a, realism) }); });
  }
  return { faces: fs.map((f) => ({ x: +f.cx.toFixed(1), z: +f.cz.toFixed(1), h: +(f.B.y1 - f.B.y0).toFixed(1), size: [+(2 * f.B.hl).toFixed(1), +(2 * f.B.hw).toFixed(1)] })), runs: out };
}
