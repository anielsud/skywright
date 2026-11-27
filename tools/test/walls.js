// In-page part of walls.py: drives cars and bikes into building walls and measures how far anything of theirs gets
// inside a building. Needs a flight running (window.__sky.F) at a place with buildings.
//
// Buildings are read straight from the world's collision grids (towns / a real place's buildings: an entry per
// building with its box in e.ob, or its own boxes in e.parts; New York: a box per entry, or its e.parts; the landmarks), not through world.wallBoxes, so the test
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
  // (an entry's own box first, with room to spare: New York's e.parts are made on first read (setback.js), and reading
  // them for every building in the city, as this did for the nyc job's crash, cost 7-9 s and made 150,000 of them)
  const add = (e) => { if (seen.has(e) || !(e[3] > 0)) return; seen.add(e); const o = boxOf(e), d = Math.hypot(o.hl, o.hw); if (Math.hypot(o.x - x, o.z - z) >= r + 2 * d + 50) return; for (const b of e.parts || [o]) if (Math.hypot(b.x - x, b.z - z) < r + Math.hypot(b.hl, b.hw)) out.push({ ...b, y0: e[1], y1: e[1] + e[3], e }); }; // (an irregular building: each of its own boxes, e.parts)
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
const LANE = Math.hypot(16, 2) + 0.01; // m: the farthest point faces() tests from a face's middle (16 m out, 2 m aside)
export function faces(S, near, { r = 1500, max = 3, minH = 6, angles = ANGLES } = {}) {
  const W = S.F.world, every = buildings(W, near.x, near.z, r), all = every.filter((B) => B.hl > 3 && B.hw > 3 && B.y1 - B.y0 > minH);
  all.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z));
  const out = [];
  for (const B of all) {
    for (const [s, alongU] of [[1, true], [-1, true], [1, false], [-1, false]]) {
      const nx = alongU ? B.ux * s : -B.uz * s, nz = alongU ? B.uz * s : B.ux * s, half = alongU ? B.hl : B.hw, wide = alongU ? B.hw : B.hl;
      if (wide < 4) continue;
      const cx = B.x + nx * half, cz = B.z + nz * half;
      // a clear lane 16 m out along each run's angle, nothing else solid in it, the ground flat and at the building's foot
      // (only buildings that can reach the lane are tested: every point tested is within LANE m of the face's middle, and a
      // box holds a point only within its half-diagonal of its centre. Testing all of them, thousands at New York, took
      // 7 s of the nyc job's crash step under software WebGL's CPU share)
      const lane = every.filter((C) => C !== B && Math.hypot(C.x - cx, C.z - cz) < LANE + Math.hypot(C.hl, C.hw));
      let ok = true; const g0 = W.groundAt(cx + nx * 2, cz + nz * 2).h;
      if (Math.abs(g0 - B.y0) > 2.5) ok = false;
      for (const a of angles) for (let d = 0.5; d <= 16 && ok; d += 0.5) { // (from just off the face: another of an irregular building's boxes may stand a little proud of it)
        const c = Math.cos(a * Math.PI / 180), sn = Math.sin(a * Math.PI / 180), dx = nx * c - nz * sn, dz = nz * c + nx * sn;
        const px = cx + dx * d, pz = cz + dz * d, g = W.groundAt(px, pz).h;
        if (Math.abs(g - g0) > 0.8 || g < W.waterLevel + 0.3) ok = false;
        for (let k = -2; k <= 2 && ok; k += 1) { const q = { x: px - dz * k, y: g + 0.5, z: pz + dx * k }; for (const C of lane) if (inside(C, q) > 0) { ok = false; break; } }
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
export function physicsRun(S, design, f, v, a, realism = 'pilot', T = 2.5, near = buildings(S.F.world, f.cx, f.cz, 60)) {
  const F = S.F, ac = new S.Aircraft(JSON.parse(JSON.stringify(design)), S.REALISM[realism]);
  setUp(S, ac, f, v, a);
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
// the game loop: the flight's own vehicle, the pedal held down; resolves when done. With __sky.advance the game's own
// frame step runs a frame at a time from here (no drawing, no waiting for frames), else in real time
export function gameRun(S, f, v, a, T = 2.5) {
  const F = S.F, ac = F.ac, near = buildings(F.world, f.cx, f.cz, 60);
  setUp(S, ac, f, v, a); F.paused = false; F.eng.on = true; ac.engineRunning = true;
  S.controls.pedal.gas = 1; S.controls.setThrottle?.(1);
  let maxPen = 0, closest = Infinity; const t0 = performance.now();
  if (S.advance) {
    for (let i = 0; i < T * 60 && !ac.dead; i++) { S.advance(1 / 60); maxPen = Math.max(maxPen, penetration(S, ac, near)); closest = Math.min(closest, Math.hypot(ac.x.x - f.cx, ac.x.z - f.cz)); }
    S.controls.pedal.gas = 0; S.controls.setThrottle?.(0); F.paused = true;
    return Promise.resolve({ maxPen: +maxPen.toFixed(3), closest: +closest.toFixed(2), up: +ac.up.y.toFixed(2), dead: !!ac.dead });
  }
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

// Does world.wallBoxes give a car every building, with its own box? For every building in the place's collision grids
// (read directly, as buildings() does): asked at its centre, and 1 m out from the middle of each face with a car's
// reach (1.5 m), the building must be among the boxes, with the same footprint, base and top.
export function registered(W) {
  const all = buildings(W, 0, 0, 1e9).filter((B) => B.e[3] > 0.3), out = [];
  let bad = 0, missing = 0, n = 0;
  const K = ['x', 'z', 'ux', 'uz', 'hl', 'hw', 'y0', 'y1'];
  const has = (B, x, z, r) => { const mine = W.wallBoxes(x, z, r).filter((q) => q.e === B.e); if (!mine.length) return 'missing'; if (mine.some((q) => K.every((k) => Math.abs(q[k] - B[k]) <= 1e-6))) return null; const got = mine[0]; for (const k of K) if (Math.abs(got[k] - B[k]) > 1e-6) return `${k} ${got[k]} vs ${B[k]}`; return null; }; // (an irregular building: one of its boxes)
  for (const B of all) {
    n++;
    const at = [[B.x, B.z, 0.5]];
    for (const [s, alongU] of [[1, true], [-1, true], [1, false], [-1, false]]) { const nx = alongU ? B.ux * s : -B.uz * s, nz = alongU ? B.uz * s : B.ux * s, d = (alongU ? B.hl : B.hw) + 1; at.push([B.x + nx * d, B.z + nz * d, 1.5]); }
    for (const [x, z, r] of at) { const why = has(B, x, z, r); if (why) { why === 'missing' ? missing++ : bad++; if (out.length < 4) out.push(`(${x.toFixed(0)}, ${z.toFixed(0)}): ${why}`); break; } }
  }
  return { n, missing, bad, examples: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Node tier (tools/test/node/run.mjs). What the test must prove: the wall-contact code (aircraft.js wallContacts) keeps
// cars and bikes out of buildings, at any speed and angle; and each place's buildings reach it (world.wallBoxes gives
// every building, with its own box). So:
//   contact:  stand-in buildings on flat ground (one like a town's or a village's, square to the street; one turned
//             27 degrees, like an OpenStreetMap footprint; a New York tower whose box starts 1.5 m above the street; an L
//             of two boxes, hit where its wall passes from one box to the other),
//             driven into by the Dune Buggy and the Dirt Bike at 5, 15, 30 and 45 m/s, straight on, at 35 degrees and at
//             60 degrees the other way, full gas: every hull point and wheel checked against the box every frame, none
//             more than 0.1 m inside, and the straight-on runs reach the wall;
//   place:    New York (its city boxes), Lauterbrunnen (OpenStreetMap buildings) and the Alpine Valley town (generated):
//             every building is among world.wallBoxes, with its own box; building faces with a clear, flat run-up near
//             the start, and both vehicles driven into each at 30 m/s straight on and 15 m/s at 35 degrees on the
//             place's real ground and buildings, staying out and reaching the wall.
// The game loop's own runs (the flight's vehicle, its pedal, building damage) are in the browser (walls.py).
export const PLACES = ['nyc', 'lauterbrunnen'], VEHICLES = ['Dune Buggy', 'Dirt Bike'], TOL = 0.1;
export const STANDINS = {
  street: { x: 0, z: 0, yaw: 0, hl: 12, hw: 8, y0: 0, h: 20 },
  osm: { x: 400, z: 0, yaw: 0.47, hl: 9, hw: 6, y0: 0, h: 9 },
  tower: { x: 800, z: 0, yaw: 0, hl: 15, hw: 15, y0: 1.5, h: 120 },
  // an L as setback.js footBoxes makes it: two boxes of one building (e.parts), overlapping; driven into where the
  // wall they share passes from one box to the other (the seam)
  lshape: { x: 1200, z: 0, yaw: 0.3, hl: 12, hw: 4, y0: 0, h: 15, parts: [[0, 0, 12, 4], [-8, 8, 4, 8]], seam: [-12, 4, -1, 0] },
};
export const nodeSuite = { files: ['src/aircraft.js', 'src/world.js', 'src/buildings.js', 'src/realBuildings.js', 'src/realCity.js', 'src/destruction.js', 'src/bike*.js', 'src/drive.js', 'tools/test/walls.js', 'tools/test/node/world.mjs'], headless: true };
export function cases() {
  return [
    ...PLACES.map((loc) => ({ id: `${loc} buildings`, kind: 'place', loc, world: loc })),
    ...VEHICLES.flatMap((name) => Object.keys(STANDINS).map((box) => ({ id: `contact ${name} ${box}`, kind: 'contact', name, box }))),
  ];
}
// flat ground with the stand-in buildings, and main.js's env over it
async function standInWorld() {
  const THREE = await import('three'), up = new THREE.Vector3(0, 1, 0), boxes = {};
  for (const [k, s] of Object.entries(STANDINS)) {
    const e = [s.x, s.y0, s.z, s.h], ux = Math.cos(s.yaw), uz = -Math.sin(s.yaw); e.solid = true;
    boxes[k] = (s.parts || [[0, 0, s.hl, s.hw]]).map(([u, v, hl, hw]) => ({ x: s.x + u * ux - v * uz, z: s.z + u * uz + v * ux, ux, uz, hl, hw, y0: s.y0, y1: s.y0 + s.h, e }));
    if (s.parts) e.parts = boxes[k];
  }
  const env = {
    groundAt: () => ({ h: 0, n: up.clone(), type: 'runway' }), maxGround: () => 0, windAt: () => new THREE.Vector3(), night: false, groundHeightAtSpawn: 0,
    walls: (x, z, r, out = []) => { out.length = 0; for (const B of Object.values(boxes).flat()) if (Math.hypot(B.x - x, B.z - z) < r + Math.hypot(B.hl, B.hw)) out.push(B); return out; },
  };
  return { boxes, env };
}
const faceOf = (B, sm) => { // (its +u face: hl out from the middle; an L's: at the seam, [u, v, nu, nv] in its frame)
  if (sm) { const nx = sm[2] * B.ux - sm[3] * B.uz, nz = sm[2] * B.uz + sm[3] * B.ux, S = STANDINS.lshape; return { B, nx, nz, tx: -nz, tz: nx, cx: S.x + sm[0] * B.ux - sm[1] * B.uz, cz: S.z + sm[0] * B.uz + sm[1] * B.ux, gy: 0 }; }
  const nx = B.ux, nz = B.uz; return { B, nx, nz, tx: -nz, tz: nx, cx: B.x + nx * B.hl, cz: B.z + nz * B.hl, gy: 0 };
};
export async function runCase(c, { presets }) {
  const { Aircraft, REALISM } = await import('../../src/aircraft.js'), THREE = await import('three'), d = presets.find((p) => p.name === c.name), out = [];
  const add = (name, ok, why = '') => out.push({ name, ok: !!ok, why });
  const judgeRuns = (where, name, runs) => {
    const worst = runs.reduce((a, x) => (x.maxPen > (a?.maxPen ?? -1) ? x : a), null), far = runs.filter((x) => x.a === 0 && x.v >= 15 && x.closest > 4);
    add(`${where}: ${name} stays out of the buildings (${runs.length} runs)`, runs.length && worst.maxPen <= TOL, worst ? `deepest ${worst.maxPen} m (${worst.face != null ? `face ${worst.face}, ` : ''}${worst.v} m/s, ${worst.a} deg)` : 'no runs');
    add(`${where}: ${name} reaches the wall`, runs.length && !far.length, far.length ? `${far.length} straight-on runs stopped short` : 'every straight-on run hit it');
  };
  if (c.kind === 'contact') {
    const { boxes, env } = await standInWorld(), Bs = boxes[c.box], S = { F: { env, world: null }, THREE, Aircraft, REALISM, presets }, runs = [];
    for (const v of SPEEDS) for (const a of ANGLES) runs.push({ v, a, ...physicsRun(S, d, faceOf(Bs[0], STANDINS[c.box].seam), v, a, 'pilot', 2.5, Bs) });
    judgeRuns(`stand-in ${c.box} building`, c.name, runs);
    return out;
  }
  const { worldAt, skyOf } = await import('./node/world.mjs'), w = await worldAt(c.loc), W = w.world, S = skyOf(w, presets);
  W.reset(); W.gust.set(0, 0, 0); W.gustT.set(0, 0, 0);
  const reg = registered(W);
  add(`${c.loc}: every building is a wall box, with its own box`, reg.n > 0 && !reg.missing && !reg.bad, `${reg.n} buildings: ${reg.missing} missing, ${reg.bad} with another box${reg.examples.length ? '; ' + reg.examples.join('; ') : ''}`);
  const near = W.landStart('park')?.pos ?? new THREE.Vector3(W.runway.x, 0, W.runway.len / 2 - 60); // (where the old browser test's Dune Buggy started: the stunt park's arch, or the runway)
  const fs = faces(S, near, { max: 3 });
  add(`${c.loc}: clear building faces found`, fs.length >= 1, `${fs.length}: ` + fs.map((f) => `${(2 * f.B.hl).toFixed(1)}x${(2 * f.B.hw).toFixed(1)} m, ${(f.B.y1 - f.B.y0).toFixed(1)} m tall`).join(', '));
  for (const name of VEHICLES) {
    const dd = presets.find((p) => p.name === name), runs = [];
    fs.forEach((f, k) => { for (const [v, a] of [[30, 0], [15, 35]]) runs.push({ face: k, v, a, ...physicsRun(S, dd, f, v, a) }); });
    judgeRuns(c.loc, name, runs);
  }
  return out;
}
