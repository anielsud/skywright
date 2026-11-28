// Water parks: an aquatic stunt park for boats (and anything that floats) on open water at every real location with
// room for one (loc.waterPark): floating launch ramps you hit flat out and fly off, a MEGA JUMP over an island, a
// container barge or a log raft, a boost strip on the water, a hoop to jump through, a buoy slalom, a waterfall you
// drive through, grandstands, flags and a start arch on pontoons. Boats start at the arch ('At the water park').
//
// Where: found from the real data (findWaterSite): deep enough open water (no land, shallows, bridges, buildings on
// stilts, the airfield) with a margin all round, clear of the marina and its channel, near the location's hint.
// Built with the stunt builders' kit (stuntKit.js Site: a few merged meshes on shared materials, one CollisionMesh)
// so nothing new compiles mid-flight. The ramps are 'slick' (collide.js): a wet plastic deck a hull slides up.
//
// How boats fly: the hull points ride up the ramp (aircraft.js contacts; a submerged ramp foot counts, collide.js
// groundAtPoint). Out of the water a boat's motor has nothing to push on, so the boost strip carries it to its speed
// and on up the ramp to the lip, the same for a jet ski or a fireboat. In the air, Arcade and Pilot hold a boat level
// with its flight, nose a touch up, so it lands flat on its hull (a nose-heavy hull would dive off the lip); Sim
// leaves it alone. A boat stranded high and dry on a ramp or the island is pushed back into the water.
//
// Park frame (stuntKit Site): metres from the park's origin on the water, x along the course, z across it.
//   z = 0   (main lane): start arch, boost strip, MEGA JUMP ramp, the island / barge / raft, the splashdown buoys
//   z = +38 (kickers):   a small and a medium kicker, the hoop
//   z = -38 (slalom):    five buoy gates to weave through, the waterfall
import * as THREE from 'three';
import { mulberry32, clamp } from './noise.js';
import { Site, THEMES, V, Y, PAINT, DIRT, col, kicker, stuntMaterials, ATLAS } from './stuntKit.js';
import { toLocal } from './realworld.js';
import { naturalGround } from './layout/rules.js';

const SLICK = 4; // collide.js SURFACES: 'slick'
const DEG = Math.PI / 180;

// the course (park frame): where everything goes
const C = {
  x0: -175, x1: 120, z0: -72, z1: 72, // the footprint (what must be open, deep water), plus the margin below
  margin: 45, depth: 2.6,
  start: -122, arch: -106,
  main: { z: 0, boost: [-56, 0], target: 23, x: 0, H: 3.4, deg: 21, w: 6, sub: 1.2 }, // the MEGA JUMP
  kick: { z: 38, ramps: [[-62, 1.0, 14, 4], [4, 1.9, 18, 4.5]], boost: 22, target: 17, hoopDx: 17, hoopR: 6.5, hoopY: 4.2 },
  slalom: { z: -38, x0: -100, dx: 34, n: 5, off: 5, half: 4.5 },
  fall: { z: -38, x: 76, w: 7.5, h: 8 }, // the waterfall
  stands: [[16, 1, 30], [16, -1, 30]], // x, side, length (at z = side * 62)
};
const lane = (z) => (s) => ({ p: V(s, 0, z), t: V(1, 0, 0), r: V(0, 0, 1) });

// ---------- finding a site ----------
const centre = (w, near) => (near?.lat != null ? toLocal(w.real.meta, near.lat, near.lon) : near || [0, 0]);
const AIRPORT = { x0: -500, x1: 800, z: 1900 };
// cfg: loc.waterPark. Returns { x, z, yaw, depth, ... } or null.
export function findWaterSite(w, cfg) {
  const t0 = performance.now(), R = w.real, rnd = mulberry32(cfg.seed ?? 211), M = w.marina, P = new THREE.Vector3();
  const [cx, cz] = centre(w, cfg.near), rad = cfg.r ?? 2500, lim = w.size / 2 - 300, need = cfg.depth ?? C.depth;
  const why = { edge: 0, airport: 0, land: 0, shallow: 0, bridge: 0, built: 0, marina: 0 };
  const no = (k) => { why[k]++; return -1; };
  // the water at (x, z) and the floor under it, or null on land. With the baked layout (#294) its chunks are the ground
  // the park will sit on, but most aren't meshed yet while the World is built: there, their natural ground away from the
  // roads (the hi grid's points, shore-snapped: layout/rules.js naturalGround) and the water over it as World.groundAt
  // has it; paving (a street, a quay, a city's lot: World.groundAt's 'runway') is land in the layout too
  const nat = w.layout ? naturalGround(w) : null, S = w.layout?.size;
  const water = (x, z) => {
    const g = w.groundAt(x, z), k = Math.floor(x / S) + ',' + Math.floor(z / S);
    if (nat && g.type !== 'runway' && w.layout.index.has(k) && !(w.layout.on && w.layout.active.has(k))) { const f = nat(x, z), wt = w.waterOver(x, z, f); return wt ? { h: wt.h, floor: f } : null; }
    return g.type === 'water' ? { h: g.h, floor: w.heightAt(x, z) } : null;
  };
  // the water depth at (x, z) if it is open water a boat may use, else -1
  const depth = (x, z) => {
    if (Math.abs(x) > lim || Math.abs(z) > lim || (R && R.inHi(x, z) < 200)) return no('edge');
    if (x > AIRPORT.x0 && x < AIRPORT.x1 && Math.abs(z) < AIRPORT.z) return no('airport');
    const g = water(x, z); if (!g) return no('land');
    const d = g.h - g.floor; if (d < 1) return no('shallow');
    if (w.roadSurf?.q(x, z, true)) return no('bridge');
    if (w.towns?.hit?.(P.set(x, g.h + 2, z)) || w.towns?.hit?.(P.set(x, g.h + 6, z))) return no('built'); // (overwater bungalows, piers)
    if (M) { const [lx, lz] = M.L(x, z); if (Math.hypot(x - M.x, z - M.z) < 380 || (lz > -40 && lz < (M.site.channel ?? 300) + 120 && Math.abs(lx) < 90)) return no('marina'); }
    return d;
  };
  const hx = (C.x1 - C.x0) / 2, hz = (C.z1 - C.z0) / 2, mx = (C.x1 + C.x0) / 2; // (the footprint's half size and its middle along x)
  let tested = 0;
  const evaluate = (x, z, yaw, step) => {
    tested++;
    const c = Math.cos(yaw), s = Math.sin(yaw), Pt = (u, v) => [x + u * c + v * s, z - u * s + v * c];
    let lo = Infinity, sum = 0, n = 0;
    for (let u = C.x0 - C.margin; u <= C.x1 + C.margin + 1e-6; u += step) for (let v = C.z0 - C.margin; v <= C.z1 + C.margin + 1e-6; v += step) {
      const [px, pz] = Pt(u, v), d = depth(px, pz), inner = u >= C.x0 && u <= C.x1 && v >= C.z0 && v <= C.z1;
      if (d < 0 || (inner && d < need)) return null;
      if (inner) { lo = Math.min(lo, d); sum += Math.min(d, 20); n++; }
    }
    const [ox, oz] = Pt(mx, 0);
    const mean = sum / n; // (cfg.shallow: a lagoon's turquoise shallows look best: as near this depth as there is room)
    return { x, z, yaw, depth: lo, mean, score: (Math.hypot(ox - cx, oz - cz) / rad) * (cfg.distW ?? 3) + (cfg.shallow ? Math.abs(mean - cfg.shallow) * 0.5 : Math.max(0, 5 - mean) * 0.3) };
  };
  // 1. a map of usable water round the centre and how far each cell is from the nearest unusable one (chamfer)
  const g = Math.max(24, rad / 100), N = Math.ceil((2 * rad) / g) + 1, x0 = cx - rad, z0 = cz - rad, D = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = x0 + i * g, z = z0 + j * g; D[j * N + i] = Math.hypot(x - cx, z - cz) <= rad && depth(x, z) >= need ? 1e9 : 0; }
  const dd = g * Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; let d = D[k]; if (!d) continue; if (i) d = Math.min(d, D[k - 1] + g); if (j) d = Math.min(d, D[k - N] + g); if (i && j) d = Math.min(d, D[k - N - 1] + dd); if (j && i < N - 1) d = Math.min(d, D[k - N + 1] + dd); D[k] = d; }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) { const k = j * N + i; let d = D[k]; if (!d) continue; if (i < N - 1) d = Math.min(d, D[k + 1] + g); if (j < N - 1) d = Math.min(d, D[k + N] + g); if (i < N - 1 && j < N - 1) d = Math.min(d, D[k + N + 1] + dd); if (j < N - 1 && i) d = Math.min(d, D[k + N - 1] + dd); D[k] = d; }
  // 2. the roomy spots (the park's half width and its margin), nearest the hint first; each tried at every heading
  const spots = [], room = (hz + C.margin) * 0.9;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (D[j * N + i] >= room) { const x = x0 + i * g + (rnd() - 0.5) * g * 0.5, z = z0 + j * g + (rnd() - 0.5) * g * 0.5; spots.push([Math.hypot(x - cx, z - cz) - Math.min(D[j * N + i], hx) * 0.5, x, z]); }
  spots.sort((a, b) => a[0] - b[0]);
  // spread out (one in every 80 m), coarse at every heading; the best few checked finely, then refined round the best
  const picked = []; for (const sp of spots) { if (picked.length >= (cfg.tries || 40)) break; if (!picked.some((q) => Math.hypot(q[1] - sp[1], q[2] - sp[2]) < 80)) picked.push(sp); }
  const yaws = cfg.yaw != null ? [cfg.yaw] : Array.from({ length: 12 }, (_, k) => (k * Math.PI) / 12), coarse = []; // (half a turn: the footprint is a rectangle round its middle)
  for (const [, x, z] of picked) for (const yaw of yaws) {
    const c = Math.cos(yaw), s = Math.sin(yaw), q = evaluate(x - mx * c, z + mx * s, yaw, 40); // (the spot is the footprint's middle: the origin is mx behind it)
    if (q) coarse.push(q);
  }
  coarse.sort((a, b) => a.score - b.score);
  let best = null;
  for (const q of coarse.slice(0, 8)) { const f = evaluate(q.x, q.z, q.yaw, 15); if (f && (!best || f.score < best.score)) best = f; }
  if (best) for (let k = 0; k < 30; k++) {
    const x = best.x + (rnd() - 0.5) * 100, z = best.z + (rnd() - 0.5) * 100, yaw = cfg.yaw ?? best.yaw + (rnd() - 0.5) * 0.3;
    const f = evaluate(x, z, yaw, 15); if (f && f.score < best.score) best = f;
  }
  // the course runs either way along the rectangle: towards the hint's side of the water (the start nearer the shore you see from)
  if (best && cfg.yaw == null) { const c = Math.cos(best.yaw), s = Math.sin(best.yaw), [ax, az] = [best.x + C.x0 * c, best.z - C.x0 * s], [bx, bz] = [best.x + C.x1 * c, best.z - C.x1 * s]; if (Math.hypot(bx - cx, bz - cz) < Math.hypot(ax - cx, az - cz)) { const m2x = best.x + mx * c, m2z = best.z - mx * s; best.yaw += Math.PI; best.x = m2x - mx * Math.cos(best.yaw); best.z = m2z + mx * Math.sin(best.yaw); } }
  if (!best) console.warn('[waterpark] site search: candidates failed on', JSON.stringify(why));
  else Object.assign(best, { why, tested, spots: spots.length, ms: Math.round(performance.now() - t0), x: Math.round(best.x * 10) / 10, z: Math.round(best.z * 10) / 10 });
  return best;
}

// A location's water park (one: loc.waterPark), with its own materials (the same shader programs as the stunt park's).
export class WaterParks {
  static create(world, cfg) {
    try {
      const t0 = performance.now(), site = cfg.x != null ? { x: cfg.x, z: cfg.z, yaw: cfg.yaw || 0, fixed: true, ms: 0 } : findWaterSite(world, cfg);
      if (!site) { console.warn(`[waterpark] no open water for a water park at ${world.loc.id}`); return null; }
      return new WaterParks(world, cfg, site, t0);
    } catch (e) { console.warn('[waterpark]', e); return null; }
  }
  constructor(world, cfg, site, t0) {
    const base = THEMES[cfg.theme || 'tropical'], t1 = performance.now();
    this.theme = { ...base, signs: { ...base.signs, name: 'WATER PARK', jump: 'MEGA JUMP', wall: 'SLALOM', words: { loop: 'HOOP', banked: 'BOOST', tabletop: 'KICKERS', whoops: 'SPLASH!' } } };
    const all = stuntMaterials(this.theme); this.mats = { paint: all.paint, sign: all.sign, lamp: all.lamp };
    all.earth.map.dispose(); all.earth.dispose(); all.pool.dispose(); // (no dirt or light pools on the water)
    this.site = site;
    this.park = new WaterPark(world, site, this.theme, this.mats, cfg);
    this.sites = [this.park]; this.start = this.park.start;
    this.stats = { ...this.park.stats, buildMs: Math.round(performance.now() - t1), planMs: Math.round(t1 - t0) };
  }
  topAt(x, z) { return this.park.topAt(x, z); }
  inside(x, z, m = 0) { return this.park.inside(x, z, m); }
  update(dt, world, cam) {
    const night = world.night || (world.W?.dark ?? 0) > 0.55;
    if (night !== this.night) { this.night = night; this.mats.lamp.emissiveIntensity = night ? 7 : 0.4; this.mats.sign.emissiveIntensity = night ? 0.9 : 0.25; }
    this.park.update(night, cam, dt);
  }
  drive(ac, dt) { return this.park.drive(ac, dt); }
  dispose() { this.park.dispose(); for (const m of Object.values(this.mats)) { m.map?.dispose(); m.dispose(); } }
}

export class WaterPark extends Site {
  constructor(world, site, theme, mats, cfg) {
    const t0 = performance.now(), wl = world.groundAt(site.x, site.z).h;
    super(world, V(site.x, wl, site.z), site.yaw, theme, cfg.seed ?? 4242);
    this.course = C; this.ramps = []; this.zones = []; this.gates = []; this.hoops = []; this.falls = [];
    this.build();
    this.cm.build();
    this.buildMeshes(world, mats, 'waterPark');
    this.hideAt = 7000;
    const back = this.Wd(V(-1, 0, 0)), side = this.Wd(V(0, 0, 1)), pos = this.W(V(C.start, 0, C.main.z));
    this.start = { id: 'waterpark', pos, heading: this.heading(1), at: (slot = 0) => pos.clone().addScaledVector(back, 14 * Math.ceil(slot / 2)).addScaledVector(side, slot ? (slot % 2 ? -9 : 9) : 0) };
    this.st = new WeakMap();
    this.stats.buildMs = Math.round(performance.now() - t0);
  }
  inside(x, z, m = 0) { const [lx, lz] = this.local(x, z); return lx > C.x0 - m && lx < C.x1 + m && lz > C.z0 - m && lz < C.z1 + m; }

  // ---------- building ----------
  build() {
    const T = this.T, r = this.rnd, M = C.main, K = C.kick, flagC = T.flags.map(col);
    // the MEGA JUMP: a boost strip into a big floating ramp, over the island (barge, raft), splashdown buoys beyond
    this.boostStrip(M.z, M.boost[0], M.boost[1], M.w + 1, M.target);
    const mega = this.ramp(M.x, M.z, M.H, M.deg, M.w, M.sub, { name: 'mega', big: true });
    this.zones.push({ x0: M.boost[0], x1: mega.x1, z: M.z, w: M.w + 1.5, target: M.target, push: 80, ramp: mega }); // (on up the ramp to the lip: out of the water the motor has nothing to push on)
    this.obstacle(mega.x1 + 6, M.z);
    const sx = mega.x1 + 48; for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; this.buoy(sx + Math.cos(a) * 24, M.z + Math.sin(a) * 14, k % 2 ? 0xffd21e : 0xff7a1a, 0.9); }
    this.splashAt = { x0: mega.x1, x1: sx + 30 };
    this.gantry(M.boost[0] + 2, M.z, M.w + 3);
    for (const s of [-1, 1]) this.flag(V(mega.x1 - 1, 0.6, M.z + s * (M.w + 0.55)), flagC[s > 0 ? 0 : 2 % flagC.length]);
    this.duck(sx + 4, M.z - 24, 1.6);
    // the kickers' lane: a small and a medium kicker, then the hoop
    for (const [x, H, deg, w] of K.ramps) { // (each with a short boost strip before it: a slow tug gets over it too)
      const r = this.ramp(x, K.z, H, deg, w, 0.8, { name: H < 1.5 ? 'small' : 'medium' });
      this.boostStrip(K.z, x - K.boost, x, w + 0.5, K.target, false);
      this.zones.push({ x0: x - K.boost, x1: r.x1, z: K.z, w: w + 1, target: K.target, push: 60, ramp: r });
    }
    const med = this.ramps.at(-1);
    this.hoop(med.x1 + K.hoopDx, K.z, K.hoopY, K.hoopR);
    this.sign(V(K.ramps[0][0] - 10, 0, K.z + 9), 'tabletop', 4.5, -1); this.float(K.ramps[0][0] - 10, K.z + 9, 5.5, 2);
    // the slalom's lane: gates of buoys to weave through, then the waterfall
    const S = C.slalom;
    for (let i = 0; i < S.n; i++) {
      const x = S.x0 + i * S.dx, zc = S.z + (i % 2 ? S.off : -S.off), c = i % 2 ? 0xe0262a : 0xf4f4f4;
      for (const s of [-1, 1]) { this.buoy(x, zc + s * S.half, c, 1.3); this.flag(V(x, 1.55, zc + s * S.half), flagC[(i + (s > 0 ? 1 : 0)) % flagC.length]); }
      this.gates.push({ x, zc, half: S.half });
    }
    this.sign(V(S.x0 - 12, 0, S.z - 9), 'wall', 4.5, 1); this.float(S.x0 - 12, S.z - 9, 5.5, 2);
    this.waterfall(C.fall.x, C.fall.z, C.fall.w, C.fall.h);
    // lane ropes between the lanes, the start arch, grandstands on pontoons, flags round the edge
    for (const z of [-19, 19]) this.rope(z, -128, 96);
    this.arch(C.arch, M.z);
    for (const [x, f, len] of C.stands) { const z = f * 62; this.deckBox(x, z + f * 3, len + 3, 9, 0.45, 0x8a9096); this.stand(x, z, len, f); }
    for (let x = C.x0 + 10; x <= C.x1 - 10; x += 26) for (const z of [C.z0 + 4, C.z1 - 4]) { if (C.stands.some(([sx, f, len]) => Math.sign(z) === f && Math.abs(x - sx) < len / 2 + 6)) continue; this.buoy(x, z, 0xf4f4f4, 0.8); this.flag(V(x, 1.15, z), flagC[Math.floor(r() * flagC.length)]); }
  }
  // a floating ramp at (x0, lane z): a kicker of height H above the water (its foot `sub` under it, so a hull meets a
  // gentle slope at the waterline) at `deg` at the lip, w half width; a slope down the back, pontoons along the sides
  ramp(x0, z, H, deg, w, sub, { name = '', big = false } = {}) {
    const Pn = this.G.paint, T = this.T, k = kicker(H + sub, deg), L = k.L, h = (s) => k.h(s - x0) - sub, pth = lane(z);
    const ka = col(T.kicker[0]), kb = col(T.kicker[1]), side = col(big ? 0xf4f4f4 : T.kicker[2]), wet = col(0x5a6a70);
    // the deck: stripes, a white edge (under water: darker, weedy)
    this.sweep(Pn, { s0: x0, s1: x0 + L, n: big ? 22 : 12, path: pth, cross: (s) => { const y = h(s); return [[-w, y], [-w + 0.45, y], [w - 0.45, y], [w, y]]; },
      color: (s, kk, y) => (y < -0.15 ? wet : kk !== 1 ? col(0xf4f4f4) : (Math.floor((s - x0) * 0.8) % 2 ? ka : kb)), type: () => SLICK, depth: 1.6, floor: -sub, band: sub, wallColor: (y) => (y < -0.01 ? wet : side), wallType: PAINT, caps: false });
    // the back: down from the lip at 32 degrees (a boat coming the wrong way rides over it rather than into a wall)
    const bk = Math.tan(32 * DEG), bL = (H + sub) / bk;
    this.sweep(Pn, { s0: x0 + L, s1: x0 + L + bL, n: 2, path: pth, cross: (s) => { const y = H - (s - x0 - L) * bk; return [[-w, y], [w, y]]; }, color: (s, kk, y) => (y < 0 ? wet : side), type: () => PAINT, depth: 1.4, floor: -sub, band: sub, wallColor: (y) => (y < -0.01 ? wet : side), wallType: PAINT, caps: false });
    // pontoons along both sides at the waterline, rails along the top edge
    const len = L + bL;
    for (const s of [-1, 1]) {
      this.tube(Pn, V(x0 + 1, 0.05, z + s * (w + 0.55)), V(x0 + len - 0.5, 0.05, z + s * (w + 0.55)), 0.62, 0.62, 10, col(big ? 0xffd21e : 0xf4f4f4));
      for (let u = 0.5; u < L; u += big ? 2.5 : 2) { const y = h(x0 + u); if (y > 0.3) this.box(Pn, x0 + u, y, z + s * (w - 0.1), 0.08, 0.8, 0.08, 0, col(0xdddddd)); }
      const rail = []; for (let u = 0.5; u <= L; u += 1.5) { const y = h(x0 + u); if (y > 0.3) rail.push(V(x0 + u, y + 0.8, z + s * (w - 0.1))); }
      for (let i = 0; i + 1 < rail.length; i++) this.tube(Pn, rail[i], rail[i + 1], 0.06, 0.06, 4, col(big ? 0xe0262a : T.kicker[0]), false);
    }
    // chevrons up the deck (MEGA JUMP), a lip stripe
    if (big) for (let u = 2.5; u < L - 2; u += 4) { const a = h(x0 + u) + 0.03, b = h(x0 + u + 3) + 0.03; this.signQuad([V(x0 + u, a, z - 2.4), V(x0 + u, a, z + 2.4), V(x0 + u + 3, b, z + 2.4), V(x0 + u + 3, b, z - 2.4)], ATLAS.chev); }
    const r = { name, x0, x1: x0 + L, xb: x0 + len, z, w, H, deg, L };
    this.ramps.push(r);
    return r;
  }
  // a glowing strip of chevrons floating on the water: drive over it and you're pushed to `target` m/s
  boostStrip(z, xa, xb, w, target, board = true) {
    this.deckBox((xa + xb) / 2, z, xb - xa, 2 * w, 0.12, 0x1a1a1a, null, -0.12);
    for (let x = xa; x < xb - 0.1; x += 4) this.signQuad([V(x, 0.14, z - w + 0.3), V(x, 0.14, z + w - 0.3), V(x + 4, 0.14, z + w - 0.3), V(x + 4, 0.14, z - w + 0.3)], ATLAS.chev);
    if (board) { this.sign(V(xa - 2, 0, z + w + 5), 'banked', 4, -1); this.float(xa - 2, z + w + 5, 5, 2); }
    for (const s of [-1, 1]) for (let x = xa; x <= xb; x += 8) this.buoy(x, z + s * (w + 1.2), 0xffb000, 0.55);
  }
  // what the MEGA JUMP flies over: the theme's island (palms on a sandbar), container barge or log raft. Solid.
  obstacle(x0, z) {
    const Pn = this.G.paint, T = this.T, kind = T.jump.kind, L = 14, w = 6;
    if (kind === 'lava') { // a little sand island: a round dome of sand, wet at the edge, palms leaning out at its sides, lava rocks
      const sand = col(T.pad[0]), wetS = col(T.pad[1]), grass = col(0x6aa84a), hh = 1.4, W = 10, n = 10, x1 = x0 + L + 3, xa = x0 - 3;
      const half = (s) => W * Math.sqrt(Math.max(0, Math.sin(clamp((s - xa) / (x1 - xa), 0, 1) * Math.PI)));
      this.sweep(Pn, { s0: xa, s1: x1, n: 16, path: lane(z), cross: (s) => { const hw = half(s) + 0.01; return Array.from({ length: n + 1 }, (_, k) => { const a = -hw + (2 * hw * k) / n, e = 1 - (a / hw) ** 2; return [a, -0.5 + (hh + 0.5) * Math.sqrt(e) * Math.min(1, hw / 4)]; }); },
        color: (s, k) => (k === 0 || k === n - 1 ? wetS : (k === 4 || k === 5) && half(s) > W * 0.8 ? grass : sand), type: () => DIRT, depth: 2, floor: -0.5, walls: false });
      this.obstacleAt = { x0: xa, x1, top: hh };
      const mid = (xa + x1) / 2;
      for (const [dx, sz, h] of [[-3, -1, 6.5], [2, -1, 5.5], [-1, 1, 6], [3.5, 1, 5]]) this.palm(V(mid + dx, 0.6, z + sz * 7.5), h);
      for (let i = 0; i < 7; i++) { const a = this.rnd() * Math.PI * 2; this.boulder(V(mid + Math.cos(a) * (L / 2 + 2), -0.25, z + Math.sin(a) * (W - 0.8)), 0.5 + this.rnd() * 0.6); }
      return;
    }
    // a barge (or a raft): a hull with raked ends, its deck 1 m up
    const dk = kind === 'timber' ? col(0x9a6a3a) : col(0x4a4e54), hullC = kind === 'timber' ? col(0x7a5228) : col(0x2e3a48), y = kind === 'timber' ? 0.7 : 1.0;
    this.sweep(Pn, { s0: x0, s1: x0 + L, n: 6, path: lane(z), cross: (s) => { const e = Math.min(1, (s - x0) / 2.5, (x0 + L - s) / 2.5), yy = -0.8 + (y + 0.8) * Math.max(0.35, e); return [[-w, yy], [w, yy]]; }, color: () => dk, type: () => PAINT, depth: 1.5, floor: -0.8, wallColor: () => hullC, wallType: PAINT });
    if (kind === 'containers') { // a row of shipping containers
      const cc = T.jump.bands.map(col);
      for (let i = 0; i < 2; i++) for (let j = -1; j <= 1; j++) this.box(Pn, x0 + 3.8 + i * 6.4, y, z + j * 2.5, 6.1, 2.45, 2.4, (this.rnd() - 0.5) * 0.05, cc[(i * 3 + j + 1) % cc.length], [PAINT, 1.2]);
      this.obstacleAt = { x0, x1: x0 + L, top: y + 2.45 };
    } else { // a log raft with a woodpile and a little hut
      for (let i = 0; i < 7; i++) this.tube(Pn, V(x0 + 0.5, y - 0.15, z - w + 0.85 + i * 1.7), V(x0 + L - 0.5, y - 0.15, z - w + 0.85 + i * 1.7), 0.42, 0.42, 7, col(i % 2 ? 0x8a5a30 : 0x7a4e2a));
      this.box(Pn, x0 + 9, y + 0.2, z, 4, 2.2, 3.6, 0, col(0xb07a44), [PAINT, 1.2]); // the hut
      for (const s of [-1, 1]) this.quad(Pn, V(x0 + 6.8, y + 2.4, z + s * 2.1), V(x0 + 11.2, y + 2.4, z + s * 2.1), V(x0 + 11.2, y + 3.4, z), V(x0 + 6.8, y + 3.4, z), col(0xd52b1e), null, V(0, 1, s));
      this.obstacleAt = { x0, x1: x0 + L, top: y + 2.4 };
      for (let i = 0; i < 6; i++) this.tube(Pn, V(x0 + 2 + (i % 3) * 0.7, y + 0.6 + Math.floor(i / 3) * 0.7, z - 2.5), V(x0 + 2 + (i % 3) * 0.7, y + 0.6 + Math.floor(i / 3) * 0.7, z + 2.5), 0.33, 0.33, 6, col(0x9a6a3a));
    }
    for (const s of [-1, 1]) this.flag(V(x0 + 1, y, z + s * (w - 0.6)), col(T.flags[s > 0 ? 0 : 1]));
  }
  // a hoop to jump through, standing in the water across the lane (no collision: you fly through it)
  hoop(x, z, yc, R) {
    const Pn = this.G.paint, T = this.T, n = 36, cs = [col(T.loop[0]), col(T.loop[2]), col(0xf4f4f4)];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, p0 = V(x, yc + R * Math.sin(a0), z + R * Math.cos(a0)), p1 = V(x, yc + R * Math.sin(a1), z + R * Math.cos(a1));
      if (p0.y < -0.6 && p1.y < -0.6) continue;
      this.tube(Pn, p0, p1, 0.42, 0.42, 7, cs[Math.floor(i / 3) % 3], false);
    }
    for (const s of [-1, 1]) { const zz = z + s * Math.sqrt(Math.max(0, R * R - yc * yc)); this.tube(Pn, V(x - 2.2, 0.05, zz), V(x + 2.2, 0.05, zz), 0.7, 0.7, 10, col(0xf4f4f4)); }
    const lm = this.G.lamp; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, p = V(x - 0.45, yc + (R - 0.05) * Math.sin(a), z + (R - 0.05) * Math.cos(a)); if (p.y > 0.5) this.box(lm, p.x, p.y - 0.15, p.z, 0.12, 0.3, 0.3, 0, col(0xffffff)); }
    this.hoops.push({ x, z, yc, R });
  }
  // a waterfall across the lane: two towers on pontoons, a beam with the SPLASH! board, a curtain of falling water
  waterfall(x, z, w, h) {
    const Pn = this.G.paint, T = this.T, r = this.rnd, a = col(T.archC[0]), b = col(T.archC[1]);
    for (const s of [-1, 1]) {
      const zz = z + s * (w + 0.9);
      this.box(Pn, x, -0.5, zz, 3.4, 1.0, 3.4, 0, col(0xf4f4f4), [PAINT, 1.2]);
      this.box(Pn, x, 0.5, zz, 1.4, h + 0.6, 1.4, 0, s > 0 ? a : b, [PAINT, 1.0]);
    }
    this.box(Pn, x, h, z, 1.6, 1.1, 2 * w + 3.2, 0, a);
    this.box(Pn, x, h - 0.25, z, 2.2, 0.35, 2 * w + 1, 0, col(0x7ab8c8)); // the trough the water spills from
    const sq = (xx, f) => [V(xx, h + 1.15, z - 4.5 * f), V(xx, h + 1.15, z + 4.5 * f), V(xx, h + 3.2, z + 4.5 * f), V(xx, h + 3.2, z - 4.5 * f)];
    this.signQuad(sq(x - 0.85, 1), ATLAS.whoops); this.signQuad(sq(x + 0.85, -1), ATLAS.whoops);
    this.box(Pn, x, h + 1.1, z, 0.12, 2.2, 9.2, 0, col(0x2c2c2c));
    // the curtain: ribbons of water from the trough down to the surface, each swaying a little, white and aqua
    const wc = [col(0xeaf6fa), col(0xbfe6ee), col(0xffffff), col(0x9fd8e4)];
    for (let i = 0; i < 44; i++) {
      const zz = z - w + 0.3 + ((2 * w - 0.6) * (i + r() * 0.6)) / 44, c = wc[i % 4], wd = 0.12 + r() * 0.14, dx = (r() - 0.5) * 0.5;
      let p0 = V(x + 0.15 + dx * 0.2, h - 0.4, zz);
      for (let k = 1; k <= 3; k++) {
        const p1 = V(x + 0.2 + dx * (k / 3) + (r() - 0.5) * 0.2, h - 0.4 - ((h - 0.35) * k) / 3, zz + (r() - 0.5) * 0.15);
        for (const f of [-1, 1]) this.quad(Pn, V(p0.x, p0.y, p0.z - wd), V(p0.x, p0.y, p0.z + wd), V(p1.x, p1.y, p1.z + wd * 1.4), V(p1.x, p1.y, p1.z - wd * 1.4), c, null, V(f, 0, 0));
        p0 = p1;
      }
    }
    for (let i = 0; i < 9; i++) this.cyl(Pn, x + (r() - 0.5) * 2.4, -0.2, z - w + ((2 * w) * (i + 0.5)) / 9, 1.3, 0.7, 0.42, 7, col(0xffffff)); // foam where it lands
    this.falls.push({ x, z, w, h });
  }
  // the start arch: an inflatable arch on two pontoons, the park's name facing the start, START on its back
  arch(ax, az) {
    const Pn = this.G.paint, T = this.T, c0 = col(T.archC[0]), c1 = col(0xf4f4f4), R = 12, tube = 1.0, segA = 26, segT = 8;
    for (let i = 0; i < segA; i++) for (let j = 0; j < segT; j++) {
      const P = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2, rr = R + tube * Math.cos(b); return V(ax + tube * Math.sin(b), 0.9 + rr * Math.sin(a), az + rr * Math.cos(a)); };
      const Nn = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2; return V(Math.sin(b), Math.cos(b) * Math.sin(a), Math.cos(b) * Math.cos(a)); };
      this.quad(Pn, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), i % 4 < 2 ? c0 : c1, null, Nn(i + 0.5, j + 0.5), [Nn(i, j), Nn(i + 1, j), Nn(i + 1, j + 1), Nn(i, j + 1)]);
    }
    for (const s of [-1, 1]) { this.box(Pn, ax, -0.5, az + s * R, 3.2, 1.4, 3.2, 0, col(0x333333), [PAINT, 1.2]); this.tube(Pn, V(ax - 2.4, 0.05, az + s * R), V(ax + 2.4, 0.05, az + s * R), 0.8, 0.8, 10, col(0xf4f4f4)); }
    const bq = (x, f) => [V(x, 10.4, az - 7 * f), V(x, 10.4, az + 7 * f), V(x, 13, az + 7 * f), V(x, 13, az - 7 * f)];
    this.signQuad(bq(ax - 1.1, 1), ATLAS.name); this.signQuad(bq(ax + 1.1, -1), ATLAS.start);
    this.box(Pn, ax, 10.3, az, 2, 2.8, 14.4, 0, col(0x2c2c2c));
    const lm = this.G.lamp; for (let k = -3; k <= 3; k++) this.box(lm, ax - 1.05, 9.9, az + k * 2, 0.1, 0.35, 0.7, 0, col(0xffffff));
  }
  // a gantry over a lane on two pontoon towers, the MEGA JUMP board on its beam facing the boats coming in
  gantry(x, z, hw) {
    const Pn = this.G.paint, T = this.T, a = col(T.archC[0]), h = 9.5;
    for (const s of [-1, 1]) {
      const zz = z + s * hw;
      this.box(Pn, x, -0.5, zz, 3, 1.1, 3, 0, col(0xf4f4f4), [PAINT, 1.2]);
      for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) this.box(Pn, x + dx, 0.6, zz + dz, 0.18, h - 0.6, 0.18, 0, a);
      for (let y = 1.4; y < h; y += 1.7) { this.box(Pn, x, y, zz - 0.6, 1.36, 0.1, 0.1, 0, a); this.box(Pn, x, y, zz + 0.6, 1.36, 0.1, 0.1, 0, a); this.box(Pn, x - 0.6, y + 0.85, zz, 0.1, 0.1, 1.36, 0, a); this.box(Pn, x + 0.6, y + 0.85, zz, 0.1, 0.1, 1.36, 0, a); }
    }
    this.box(Pn, x, h, z, 1.4, 0.5, 2 * hw + 1.6, 0, a);
    const bq = (xx, f) => [V(xx, h + 0.5, z - 6.2 * f), V(xx, h + 0.5, z + 6.2 * f), V(xx, h + 3.4, z + 6.2 * f), V(xx, h + 3.4, z - 6.2 * f)];
    this.signQuad(bq(x - 0.75, 1), ATLAS.jump); this.box(Pn, x, h + 0.45, z, 1.3, 3.05, 12.6, 0, col(0x2c2c2c));
    const lm = this.G.lamp; for (let k = -4; k <= 4; k++) this.box(lm, x - 0.72, h - 0.05, z + k * 1.4, 0.1, 0.3, 0.6, 0, col(0xffffff));
  }
  // a giant inflatable rubber duck bobbing by the splashdown (scenery: you can drive into it, it doesn't mind)
  duck(x, z, s) {
    const Pn = this.G.paint, yel = col(0xffd21e), org = col(0xff7a1a), blk = col(0x111111), wht = col(0xffffff);
    const blob = (cx, cy, cz, rx, ry, rz, c, seg = 14, rings = 8) => {
      const P = (i, j) => { const a = (i / seg) * Math.PI * 2, b = (j / rings) * Math.PI - Math.PI / 2; return V(cx + Math.cos(b) * Math.cos(a) * rx, cy + Math.sin(b) * ry, cz + Math.cos(b) * Math.sin(a) * rz); };
      const N = (i, j) => { const a = (i / seg) * Math.PI * 2, b = (j / rings) * Math.PI - Math.PI / 2; return V(Math.cos(b) * Math.cos(a) / rx, Math.sin(b) / ry, Math.cos(b) * Math.sin(a) / rz).normalize(); };
      for (let i = 0; i < seg; i++) for (let j = 0; j < rings; j++) { const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]; if (q.every((p) => p.y < -0.3)) continue; this.quad(Pn, ...q, c, null, N(i + 0.5, j + 0.5), [N(i, j), N(i + 1, j), N(i + 1, j + 1), N(i, j + 1)]); }
    };
    blob(x, 1.2 * s, z, 3.4 * s, 2.0 * s, 2.6 * s, yel); // body
    blob(x + 2.9 * s, 2.0 * s, z, 1.0 * s, 1.2 * s, 1.6 * s, yel, 10, 6); // tail
    blob(x - 2.0 * s, 4.4 * s, z, 1.7 * s, 1.7 * s, 1.7 * s, yel); // head
    blob(x - 3.7 * s, 4.1 * s, z, 0.9 * s, 0.3 * s, 0.85 * s, org, 10, 6); // beak
    for (const e of [-1, 1]) { blob(x - 3.25 * s, 4.95 * s, z + e * 0.75 * s, 0.32 * s, 0.38 * s, 0.32 * s, wht, 8, 5); blob(x - 3.5 * s, 5.0 * s, z + e * 0.78 * s, 0.16 * s, 0.2 * s, 0.16 * s, blk, 8, 5); }
  }
  // ---- small things ----
  boulder(p, s) { // a lava rock (stuntKit's rock, on the paint mesh)
    const g = new THREE.IcosahedronGeometry(s, 0), pos = g.attributes.position, c = col(this.T.rocks).multiplyScalar(0.8 + this.rnd() * 0.3);
    for (let i = 0; i < pos.count; i += 3) { const v = [0, 1, 2].map((k) => V().fromBufferAttribute(pos, i + k).multiply(V(1, 0.6, 1)).add(p).add(V(0, s * 0.3, 0))); this.tri(this.G.paint, v[0], v[1], v[2], c); }
    g.dispose();
  }
  buoy(x, z, c, s = 1) { const Pn = this.G.paint; this.cyl(Pn, x, -0.4 * s, z, 0.55 * s, 0.5 * s, 1.0 * s, 9, col(c)); this.cyl(Pn, x, 0.6 * s, z, 0.5 * s, 0.12 * s, 0.45 * s, 9, col(c), true); this.cyl(Pn, x, 0.25 * s, z, 0.57 * s, 0.57 * s, 0.14 * s, 9, col(0xf4f4f4), false); }
  rope(z, xa, xb) { const Pn = this.G.paint, cs = [col(0xe0262a), col(0xf4f4f4), col(0x2a86f0)]; let i = 0; for (let x = xa; x <= xb; x += 3, i++) this.cyl(Pn, x, -0.12, z, 0.24, 0.24, 0.34, 6, cs[Math.floor(i / 2) % 3]); }
  // a floating deck (visual only unless coll), its top at y; under it a dark skirt to the water
  deckBox(x, z, lx, lz, y, c, coll = [PAINT, 1.2], y0 = -0.5) { this.box(this.G.paint, x, y0, z, lx, y - y0, lz, 0, col(0x5a5e66), coll, col(c)); }
  float(x, z, lx, lz) { this.deckBox(x, z, lx, lz, 0.35, 0xd8d0c0, null); }

  // ---------- per frame ----------
  // A boat (or anything afloat) in the park: the boost strip and the ramps; a boat in the air held level (Arcade,
  // Pilot); a stranded one pushed back in; big air, splashdowns, the hoop, the slalom and the waterfall told.
  drive(ac, dt) {
    if (ac.dead || !this.inside(ac.x.x, ac.x.z, 40)) { this.st.delete(ac); return null; }
    if (!ac.isBoat && !(ac._floats ??= ac.parts.some((p) => p.gear?.float))) return null;
    let st = this.st.get(ac); if (!st) this.st.set(ac, (st = { air: 0, ramp: null, maxY: 0, boost: 0, gate: -1, hits: 0, stuck: 0, prev: this.Lp(ac.x), peak: false }));
    const msgs = [], lp = this.Lp(ac.x), vl = this.Ld(ac.v), fwd = V(0, 0, -1).applyQuaternion(ac.q), wet = ac.boat ? ac.boat.wet : ac.onGround ? 1 : 0;
    const onRamp = this.ramps.find((r) => lp.x > r.x0 - 1 && lp.x < r.xb + 1 && Math.abs(lp.z - r.z) < r.w + 1.5 && lp.y > -2);
    const grounded = ac.onGround, dry = wet < 0.01;
    // the boost: up to its speed (on the strip and on up the ramp), along the way you're pointing
    for (const Z of this.zones) {
      if (!grounded || lp.x < Z.x0 || lp.x > Z.x1 || Math.abs(lp.z - Z.z) > Z.w || this.Ld(fwd).x < 0.7) continue;
      const v = ac.v.dot(fwd); if (v < Z.target) { ac.v.addScaledVector(fwd, Math.min(Z.target - v, Z.push * dt)); if (st.boost <= 0) msgs.push({ center: 'BOOST!' }); st.boost = 1.5; }
    }
    st.boost -= dt;
    if (grounded && dry && onRamp) { st.ramp = onRamp; st.air = 0; st.maxY = lp.y; st.peak = false; }
    if (!grounded && dry) { // in the air
      st.air += dt; st.maxY = Math.max(st.maxY, lp.y);
      if (st.ramp) {
        if (ac.isBoat && ac.R.assist > 0) this.airHold(ac, dt);
        if (st.ramp.name === 'mega' && !st.peak && vl.y <= 0 && st.air > 0.3) { st.peak = true; msgs.push({ center: 'MEGA JUMP!', slowmo: 1.3 }); }
      }
    } else if (!dry) { // back in the water
      if (st.ramp && st.air > 0.5) {
        const up = ac.up.y;
        msgs.push({ toast: `BIG AIR! ${st.air.toFixed(1)} s · ${Math.max(0, st.maxY).toFixed(1)} m up`, good: true });
        if (st.air > 0.9) msgs.push({ center: up > 0.7 ? 'SPLASHDOWN!' : 'SPLAT!', splash: ac.x.clone().setY(this.O.y + 0.2), power: Math.min(14, 4 + st.air * 4) });
      }
      st.air = 0; st.ramp = null; st.peak = false;
    }
    // stranded high and dry on a ramp or the island (its motor can't reach the water): slid back in, the way it points
    const stranded = grounded && dry && ac.v.length() < 1.5 && lp.y > -0.5;
    st.stuck = stranded ? st.stuck + dt : 0;
    if (st.stuck > 1.5) { const f = V(fwd.x, 0, fwd.z).normalize(); ac.v.addScaledVector(f, 5).y += 1.5; st.stuck = 0; msgs.push({ toast: 'Pushed back into the water!' }); }
    // crossing things: the hoop, the slalom gates, the waterfall
    const p0 = st.prev, cross = (x) => (p0.x < x) !== (lp.x < x), at = (x, k) => (p0[k] + (lp[k] - p0[k]) * ((x - p0.x) / (lp.x - p0.x || 1e-6)));
    for (const H of this.hoops) if (cross(H.x) && Math.hypot(at(H.x, 'z') - H.z, at(H.x, 'y') - H.yc) < H.R - 0.3) msgs.push({ center: dry ? 'HOOP JUMP!' : 'THROUGH THE HOOP!' });
    for (const F of this.falls) if (cross(F.x) && Math.abs(at(F.x, 'z') - F.z) < F.w && at(F.x, 'y') < F.h) {
      msgs.push({ center: 'SPLASH!', splash: ac.x.clone(), power: 9 });
      for (let k = -1; k <= 1; k++) msgs.push({ splash: this.W(V(F.x, 0.3, at(F.x, 'z') + k * 2)), power: 6 });
    }
    this.gates.forEach((G, i) => {
      if (!(p0.x < G.x && lp.x >= G.x)) return; // (going down the lane)
      const ok = Math.abs(at(G.x, 'z') - G.zc) < G.half;
      if (i === 0) { st.gate = 1; st.hits = ok ? 1 : 0; return; } // (into the slalom: counting)
      if (st.gate !== i) return;
      st.gate = i + 1; if (ok) st.hits++;
      if (i === this.gates.length - 1) msgs.push(st.hits === this.gates.length ? { center: 'PERFECT SLALOM!', toast: `Slalom: all ${st.hits} gates!`, good: true } : { toast: `Slalom: ${st.hits} of ${this.gates.length} gates` });
    });
    st.prev = lp;
    return msgs.length ? msgs : null;
  }
  // In the air off a ramp (Arcade, Pilot): eased level with the flight path, the nose a touch up, wings level, its
  // spin damped, so it comes down flat on its hull (a nose-heavy hull would dive off the lip; one hit off-centre would
  // roll). How far and how high it flies is its speed's.
  airHold(ac, dt) {
    const vh = Math.hypot(ac.v.x, ac.v.z); if (vh < 4 || ac.up.y < 0) return;
    const pitch = clamp(Math.atan2(ac.v.y, vh) * 0.4, -0.3, 0.3) + 0.06, f = V((ac.v.x / vh) * Math.cos(pitch), Math.sin(pitch), (ac.v.z / vh) * Math.cos(pitch));
    const up = Y.clone().addScaledVector(f, -f.y).normalize(), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.clone().cross(up), up, f.clone().negate()));
    ac.q.slerp(q, Math.min(1, 3 * ac.R.assist * dt)).normalize(); ac.w.multiplyScalar(Math.max(0, 1 - 6 * dt));
  }
}
