// Where the stunt sites go, found from the real-world data at world build (before the terrain is made: the sites
// level the ground under them). Deterministic: a fixed seed and the location's own data, so a site is the same every
// time and on every device.
//
// findSite: a stunt park's pad. First a map of open ground round a centre (loc.stunts.near): every cell tested for dry
// land well above the water, no buildings, roads, rails, rivers or lakes (the landcover map marks all of those, with a
// margin round each building), not in a mapped wood, not under tree canopy where the imagery shows it (a city park's
// trees), clear of the airfield; and how far each open cell is from blocked ground. The roomiest spots (ties broken by a
// fixed seed) are tried at every heading on a grid over the pad and a clearance margin, with no water where the
// levelling reaches. The flattest wins (height range and spread over the pad), a little in favour of the centre; then
// the best one is refined.
//
// findGap: the Grand Canyon's daredevil jump. Across a real gap in the terrain: from a hint (a spot on the rim and a
// rough direction), lines are tried at offsets and turns; each must leave level rim ground, drop at least `dip`
// metres, and come back up to level ground on the far side, with a level run-up behind it and a level run-out
// beyond, both clear of roads and buildings. The narrowest gap wins.
import { mulberry32 } from './noise.js';
import { toLocal } from './realworld.js';

const AIRPORT = { x0: -380, x1: 580, z: 1250 }; // the game's airfield: runways, apron, the launch complex (launchpad.js)

const centre = (w, near) => (near.lat != null ? toLocal(w.real.meta, near.lat, near.lon) : [near[0], near[1]]);

// cfg: loc.stunts; L: the layout (pad half sizes, flat margin, blend). Returns { x, z, yaw, ...stats } or null.
export function findSite(w, cfg, L) {
  const t0 = performance.now(), R = w.real, rnd = mulberry32(cfg.seed ?? 117);
  const [cx, cz] = centre(w, cfg.near || [0, 0]), rad = cfg.r || 3000;
  const hx = L.pad[0] + 12, hz = L.pad[1] + 12; // the pad and a margin: clear land
  const ox = L.pad[0] + L.flat + L.blend * 0.6, oz = L.pad[1] + L.flat + L.blend * 0.6; // and no water this far out (it would be levelled)
  const lim = w.size / 2 - 300, wl = w.waterLevel, above = cfg.minAbove ?? 0.8, maxF = cfg.maxForest ?? 0.25;
  const _c = { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }, lerp(o, t) { this.r += (o.r - this.r) * t; this.g += (o.g - this.g) * t; this.b += (o.b - this.b) * t; return this; } }; // (lerp: RealData.color blends near the imagery's edge)
  const canopy = (x, z) => { R.color(x, z, _c); const s = _c.r + _c.g + _c.b, exg = (2 * _c.g - _c.r - _c.b) / (s || 1); return s / 3 < 0.315 && exg > 0.08; }; // dark green in the photo: trees
  const wet = (x, z) => w.height(x, z) < wl + above || (R && R.waterAt(x, z, 8) != null);
  const why = { edge: 0, airport: 0, water: 0, built: 0, wood: 0, canopy: 0, shore: 0 }; // (why candidates failed: the report)
  const no = (k) => { why[k]++; return null; };
  const point = (x, z) => { // null: not here; else [h, forest, canopy]
    if (Math.abs(x) > lim || Math.abs(z) > lim || (R && R.inHi(x, z) < 200)) return no('edge');
    if (x > AIRPORT.x0 - 30 && x < AIRPORT.x1 + 30 && Math.abs(z) < AIRPORT.z + 30) return no('airport');
    const h = w.height(x, z);
    if (h < wl + above) return no('water');
    if (!R) return [h, 0, 0];
    if (R.waterAt(x, z, 8) != null) return no('water');
    if (R.bare(x, z)) return no('built'); // buildings, roads, rails (and lakes: the landcover map marks them too)
    const f = R.forest(x, z) ?? 0; if (f > maxF) return no('wood'); // a wood
    return [h, f, cfg.canopy && canopy(x, z) ? 1 : 0];
  };
  let tested = 0;
  const evaluate = (x, z, yaw, step) => {
    tested++;
    const c = Math.cos(yaw), s = Math.sin(yaw), P = (u, v) => [x + u * c + v * s, z - u * s + v * c];
    let n = 0, sum = 0, sum2 = 0, lo = Infinity, hi = -Infinity, fs = 0, cn = 0;
    const nu = Math.ceil((2 * hx) / step), nv = Math.ceil((2 * hz) / step);
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const [px, pz] = P(-hx + (2 * hx * i) / nu, -hz + (2 * hz * j) / nv), q = point(px, pz);
      if (!q) return null;
      n++; sum += q[0]; sum2 += q[0] * q[0]; lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); fs += q[1]; cn += q[2];
    }
    if (cn / n > (cfg.maxCanopy ?? 0.12)) return no('canopy'); // under the trees
    // the ring the levelling reaches: no water in it
    for (const [a, b] of [[ox, oz], [(hx + ox) / 2, (hz + oz) / 2]]) {
      const m = Math.ceil((4 * (a + b)) / (step * 1.5));
      for (let k = 0; k < m; k++) {
        const t = (k / m) * 4 * (a + b), [u, v] = t < 2 * a ? [-a + t, -b] : t < 2 * a + 2 * b ? [a, -b + t - 2 * a] : t < 4 * a + 2 * b ? [a - (t - 2 * a - 2 * b), b] : [-a, b - (t - 4 * a - 2 * b)];
        const [px, pz] = P(u, v); if (wet(px, pz)) return no('shore');
      }
    }
    const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return { x, z, yaw, range: hi - lo, sd, canopy: cn / n, forest: fs / n, h: mean, score: hi - lo + 2 * sd + (cn / n) * 60 + (fs / n) * (cfg.forestW ?? 6) + (Math.hypot(x - cx, z - cz) / rad) * (cfg.distW ?? 2) };
  };
  // 1. a map of open ground round the centre: each cell clear (dry, nothing built, no wood, no canopy) or not, and how
  //    far it is to the nearest blocked cell (a chamfer distance transform)
  const g = Math.max(16, rad / 120), N = Math.ceil((2 * rad) / g) + 1, x0 = cx - rad, z0 = cz - rad, D = new Float32Array(N * N), C = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + i * g, z = z0 + j * g, q = Math.hypot(x - cx, z - cz) <= rad ? point(x, z) : null; D[j * N + i] = q ? 1e9 : 0;
    C[(j + 1) * (N + 1) + i + 1] = (q ? q[2] : 1) + C[j * (N + 1) + i + 1] + C[(j + 1) * (N + 1) + i] - C[j * (N + 1) + i]; // (summed: canopy round a spot)
  }
  const dd = g * Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; let d = D[k]; if (!d) continue; if (i) d = Math.min(d, D[k - 1] + g); if (j) d = Math.min(d, D[k - N] + g); if (i && j) d = Math.min(d, D[k - N - 1] + dd); if (j && i < N - 1) d = Math.min(d, D[k - N + 1] + dd); D[k] = d; }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) { const k = j * N + i; let d = D[k]; if (!d) continue; if (i < N - 1) d = Math.min(d, D[k + 1] + g); if (j < N - 1) d = Math.min(d, D[k + N] + g); if (i < N - 1 && j < N - 1) d = Math.min(d, D[k + N + 1] + dd); if (j < N - 1 && i) d = Math.min(d, D[k + N - 1] + dd); D[k] = d; }
  // 2. the spots with room for the pad's width, roomiest and least wooded first (ties shuffled by the seed); each tried at every heading
  const spots = [];
  const rr = Math.max(1, Math.round(hz / g)), box = (i, j) => { const a0 = Math.max(0, i - rr), b0 = Math.max(0, j - rr), a1 = Math.min(N, i + rr + 1), b1 = Math.min(N, j + rr + 1), W = N + 1; return (C[b1 * W + a1] - C[b0 * W + a1] - C[b1 * W + a0] + C[b0 * W + a0]) / ((a1 - a0) * (b1 - b0)); };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (D[j * N + i] >= hz * 0.85) spots.push([Math.min(D[j * N + i], hx) - 400 * box(i, j) + rnd() * g * 0.5, x0 + i * g + (rnd() - 0.5) * g, z0 + j * g + (rnd() - 0.5) * g]);
  spots.sort((a, b) => b[0] - a[0]);
  let best = null;
  const yaws = cfg.yaw != null ? [cfg.yaw] : Array.from({ length: 24 }, (_, k) => (k * Math.PI) / 24);
  for (const [, x, z] of spots.slice(0, cfg.tries || 300)) for (const yaw of yaws) {
    { const c = Math.cos(yaw), s = Math.sin(yaw); if ([[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([u, v]) => !point(x + u * hx * c + v * hz * s, z - u * hx * s + v * hz * c))) continue; } // (the corners first: cheap)
    const q = evaluate(x, z, yaw, 40); if (!q || (best && q.score > best.score + 4)) continue; // (coarse, then fine)
    const f = evaluate(x, z, yaw, 12); if (f && (!best || f.score < best.score)) best = f;
  }
  if (best) for (let k = 0; k < 120; k++) { // refine round the best
    const x = best.x + (rnd() - 0.5) * 80, z = best.z + (rnd() - 0.5) * 80, yaw = cfg.yaw ?? best.yaw + (rnd() - 0.5) * 0.35;
    const f = evaluate(x, z, yaw, 12); if (f && f.score < best.score) best = f;
  }
  if (!best) console.warn('[stunts] site search: candidates failed on', JSON.stringify(why));
  if (best) Object.assign(best, { why, tested, spots: spots.length, ms: Math.round(performance.now() - t0), x: Math.round(best.x * 10) / 10, z: Math.round(best.z * 10) / 10 });
  return best;
}

// cfg: loc.stunts.evel = { near: [x, z] (on the launch rim), heading (deg: the jump runs along (cos, sin) in x, z),
// span (m of sideways offsets to try), turn (deg either way), dip (m) }. Returns the line and the rims, or null.
export function findGap(w, cfg) {
  const t0 = performance.now(), R = w.real, H = (x, z) => w.height(x, z);
  const [nx0, nz0] = centre(w, cfg.near), dipMin = cfg.dip ?? 150, lim = w.size / 2 - 500;
  const RUN = cfg.run ?? 300, OUT = cfg.out ?? 230; // run-up behind the launch rim, run-out beyond the far rim
  const clear = (x, z) => !(R && R.bare(x, z)) && Math.abs(x) < lim && Math.abs(z) < lim;
  let best = null, tried = 0;
  for (let off = -(cfg.span ?? 140); off <= (cfg.span ?? 140); off += 10) for (let da = -(cfg.turn ?? 16); da <= (cfg.turn ?? 16); da += 2) {
    tried++;
    const a = ((cfg.heading + da) * Math.PI) / 180, dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    const ax = nx0 + px * off, az = nz0 + pz * off, h0 = H(ax, az), at = (s) => H(ax + dx * s, az + dz * s);
    // the launch rim: where the ground first drops 6 m below where we stand
    let e = -1; for (let s = 10; s < 400; s += 10) if (at(s) < h0 - 6) { e = s; break; }
    if (e < 0) continue;
    // the bottom, then the far rim: the first spot back up near the launch height with level ground beyond
    let lo = Infinity, b = -1;
    for (let s = e; s < e + 700; s += 10) {
      const h = at(s); lo = Math.min(lo, h);
      if (h0 - lo < dipMin || h < h0 - 45 || h > h0 + 3) continue;
      let fl = Infinity, fh = -Infinity; for (let u = 0; u <= 300; u += 15) { const g = at(s + u); fl = Math.min(fl, g); fh = Math.max(fh, g); }
      if (fl >= h - 3 && fh - fl < 14) { b = s; break; }
    }
    if (b < 0 || (best && b - e > best.gap + 20)) continue;
    // level run-up behind, and clear of roads and buildings near both rims
    let rl = Infinity, rh = -Infinity, ok = true;
    for (let u = 0; u <= RUN; u += 15) { const g = at(e - u); rl = Math.min(rl, g); rh = Math.max(rh, g); }
    if (rh - rl > 14) continue;
    for (const o of [-25, -12, 0, 12, 25]) {
      for (let u = 10; u <= RUN && ok; u += 10) ok = clear(ax + dx * (e - u) + px * o, az + dz * (e - u) + pz * o);
      for (let u = 0; u <= OUT && ok; u += 10) ok = clear(ax + dx * (b + u) + px * o, az + dz * (b + u) + pz * o);
    }
    if (!ok) continue;
    // the rims to 2 m: the launch edge (4 m below the plateau behind it) and the far edge (back within 4 m of the far plateau)
    let hA = 0, nA = 0; for (let u = 30; u <= 300; u += 15) { hA += at(e - u); nA++; } hA /= nA;
    let hB = 0, nB = 0; for (let u = 30; u <= 250; u += 15) { hB += at(b + u); nB++; } hB /= nB;
    let eA = e; for (let s = e - 20; s <= e; s += 2) if (at(s) < hA - 4) { eA = s; break; }
    let eB = b; for (let s = b; s >= b - 40; s -= 2) { if (at(s) < hB - 4) break; eB = s; }
    const gap = eB - eA, dip = Math.min(hA, hB) - lo;
    if (dip < dipMin) continue;
    if (!best || gap < best.gap) best = { x: ax + dx * eA, z: az + dz * eA, dx, dz, heading: cfg.heading + da, gap, dip, hA, hB, lo };
  }
  if (best) Object.assign(best, { yaw: Math.atan2(-best.dz, best.dx), tried, ms: Math.round(performance.now() - t0) });
  return best;
}
