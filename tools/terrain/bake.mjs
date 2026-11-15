// Offline terrain bake: runs a landscape-evolution simulation over the 26 km core of each built-in location and
// writes assets/terrain/<id>.bin (see src/terrainBake.js for the format and how the game reads it).
//
//   node --import ./tools/terrain/hooks.mjs tools/terrain/bake.mjs [alpine islands] [--n 2049]
//        [--cache dir] [--preview dir]
// Run it again whenever a location's height function (world.js LOCATIONS) or erosion settings change: the game
// checks probe heights stored in the file and ignores a stale bake. ~5-15 min per location at 2049 (13 m cells).
//
// The input is the location's analytic height function (LOCATIONS[id].height + the analytic gullies of
// src/erosion.js), exactly what the game uses outside the baked area. On top of it:
//   0. (alpine, islands) landscape from uplift (Cordonnier et al. 2016): the analytic terrain is the uplift rate,
//      the stream-power law runs to near steady state, and its relief (scaled to the analytic relief around it)
//      replaces the analytic relief below ~2 km. This makes the dendritic valleys and sharp ridges, with no
//      closed bowls; the remaining basins are breached (outflow channel cut, floor partly filled).
//   1. fluvial erosion: stream-power law, solved implicitly along the D8 flow tree (Braun & Willett 2013), with
//      depressions routed by priority-flood (what is still a closed basin at the end becomes a lake).
//   2. sediment: what the channels remove is carried downstream and dropped where the slope flattens
//      (alluvial fans at valley mouths, flat valley floors), by a transport-capacity pass over the same tree.
//   3. talus: steep rock sheds debris that piles up below cliffs (scree aprons), without flattening the cliffs.
//   4. hillslope diffusion: softens the creep-dominated slopes between gullies.
// It then derives the maps the renderer uses: river/stream coverage (from drainage area, with widths), drainage
// (log area), deposition (scree + alluvium) and wetness. The game adds the stored height difference to the
// analytic function, faded out towards the edge of the baked area, so the land beyond stays seamless.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync, deflateSync } from 'node:zlib';
import { LOCATIONS } from '../../src/world.js';
import { makeNoise, mulberry32 } from '../../src/noise.js';
import { erode } from '../../src/erosion.js';
import { BAKE } from '../../src/terrainBake.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ids = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const N = +opt('--n', BAKE.n), PREVIEW = opt('--preview', null), CACHE = opt('--cache', null);
const C = BAKE.span / (N - 1), X0 = -BAKE.span / 2;
const OUT = new URL('../../assets/terrain/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// per-location simulation settings
const SIM = {
  alpine: { uplift: { K: 0.03, u: 8, iters: 250, pow: 1, maxS: 1.1, macro: 2500, gain: 0.85, mix: 1, fine: 160, detail: 0.35 }, K: 0.0005, iters: 20, dt: 1, m: 0.5, talus: 0.9, shed: 0.12, talusIters: 12, diff: 0.06, sedK: 0.55, rivA: 1.2e6, rivW: 6, wet: true },
  islands: { uplift: { K: 0.03, u: 6, iters: 250, pow: 1, maxS: 1.0, macro: 1500, gain: 0.85, mix: 1, fine: 120, detail: 0.3 }, K: 0.0005, iters: 20, dt: 1, m: 0.5, talus: 0.9, shed: 0.08, talusIters: 10, diff: 0.08, sedK: 0.6, rivA: 0.8e6, rivW: 5, wet: true },
};

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const D8L = D8.map(([a, b]) => Math.hypot(a, b) * C);
const NB = D8.map(([a, b]) => b * N + a);

// binary min-heap of (key, index) for priority-flood
class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    let i = this.n++; const K = this.k, V = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v, top = V[0], key = K[--this.n], val = V[this.n];
    let i = 0; const n = this.n;
    for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
    K[i] = key; V[i] = val; this.popKey = K[0]; return top;
  }
}

// Priority-flood (Barnes 2014) with epsilon: raises every depression just enough to drain. Outlets are the map
// border and the sea. Returns the fill depth per cell (0 where nothing was filled).
function fillDepressions(h, outlet, eps = 1e-3, parent = null) {
  const closed = new Uint8Array(N * N), heap = new Heap(N * N), depth = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const x = i % N, z = (i / N) | 0;
    if (x === 0 || z === 0 || x === N - 1 || z === N - 1 || outlet[i]) { closed[i] = 1; heap.push(h[i], i); }
  }
  while (heap.n) {
    const i = heap.pop(), hi = h[i], x = i % N, z = (i / N) | 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + D8[d][0], zz = z + D8[d][1]; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
      const j = i + NB[d]; if (closed[j]) continue;
      closed[j] = 1; if (parent) parent[j] = i;
      if (h[j] <= hi + eps) { depth[j] = hi + eps - h[j]; h[j] = hi + eps; }
      heap.push(h[j], j);
    }
  }
  return depth;
}

// D8 receivers, drainage area and a topological stack (outlets first) for the current surface
function flowTree(h, outlet, rnd = null) {
  const rcv = new Int32Array(N * N), rl = new Float32Array(N * N), ndon = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = z * N + x; rcv[i] = i; rl[i] = C;
    if (x === 0 || z === 0 || x === N - 1 || z === N - 1 || outlet[i]) continue;
    let best = 0;
    if (rnd) { let tot = 0; for (let d = 0; d < 8; d++) { const s = (h[i] - h[i + NB[d]]) / D8L[d]; if (s > 0) tot += s * s; } let t = rnd() * tot; for (let d = 0; d < 8 && tot > 0; d++) { const s = (h[i] - h[i + NB[d]]) / D8L[d]; if (s <= 0) continue; rcv[i] = i + NB[d]; rl[i] = D8L[d]; if ((t -= s * s) <= 0) break; } continue; }
    for (let d = 0; d < 8; d++) { const j = i + NB[d], s = (h[i] - h[j]) / D8L[d]; if (s > best) { best = s; rcv[i] = j; rl[i] = D8L[d]; } }
  }
  // donors (CSR) then stack by DFS from the outlets
  for (let i = 0; i < N * N; i++) if (rcv[i] !== i) ndon[rcv[i]]++;
  const off = new Int32Array(N * N + 1); for (let i = 0; i < N * N; i++) off[i + 1] = off[i] + ndon[i];
  const don = new Int32Array(off[N * N]), fill = off.slice(0, N * N);
  for (let i = 0; i < N * N; i++) if (rcv[i] !== i) don[fill[rcv[i]]++] = i;
  const stack = new Int32Array(N * N), tmp = new Int32Array(N * N); let ns = 0;
  for (let i = 0; i < N * N; i++) {
    if (rcv[i] !== i) continue;
    let t = 0; tmp[t++] = i;
    while (t) { const k = tmp[--t]; stack[ns++] = k; for (let q = off[k]; q < off[k + 1]; q++) tmp[t++] = don[q]; }
  }
  const area = new Float32Array(N * N).fill(C * C);
  for (let s = ns - 1; s >= 0; s--) { const i = stack[s]; if (rcv[i] !== i) area[rcv[i]] += area[i]; }
  return { rcv, rl, stack, area };
}

// Breach closed basins: real mountains drain, analytic noise is full of closed bowls. Each basin's floor is raised by
// part of its depth (sediment infill: flat basin floors) and a channel is cut from its lowest point along the
// priority-flood path to the outlet, descending gently. Erosion then widens the cut into a valley.
function breach(h, outlet, infill) {
  const parent = new Int32Array(N * N).fill(-1), hf = h.slice();
  const depth = fillDepressions(hf, outlet, 1e-3, parent);
  const lab = new Int32Array(N * N).fill(-1), q = new Int32Array(N * N);
  let nb = 0, carved = 0;
  for (let i0 = 0; i0 < N * N; i0++) {
    if (lab[i0] >= 0 || depth[i0] < 0.5) continue;
    let qn = 0, qh = 0, pit = i0; q[qn++] = i0; lab[i0] = nb;
    while (qh < qn) {
      const i = q[qh++], x = i % N, z = (i / N) | 0; if (h[i] < h[pit]) pit = i;
      for (let d = 0; d < 8; d++) { const xx = x + D8[d][0], zz = z + D8[d][1]; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue; const j = zz * N + xx; if (lab[j] < 0 && depth[j] >= 0.5) { lab[j] = nb; q[qn++] = j; } }
    }
    nb++;
    const spill = hf[pit], Lb = h[pit] + (spill - h[pit]) * infill;
    for (let k = 0; k < qn; k++) { const i = q[k]; if (h[i] < Lb) h[i] = Lb; }
    // cut the outflow: from the pit along the flood parents to the outlet, never rising, 3 cells wide
    let p = pit, lvl = Lb, steps = 0;
    while (p >= 0 && !outlet[p] && steps++ < N * 4) {
      const x = p % N, z = (p / N) | 0;
      if (h[p] > lvl) { carved += h[p] - lvl; h[p] = lvl; }
      for (let d = 0; d < 4; d++) { const xx = x + D8[d][0], zz = z + D8[d][1]; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue; const j = zz * N + xx; if (h[j] > lvl + C * 0.6) h[j] = lvl + C * 0.6; }
      const pp = parent[p]; if (pp < 0) break;
      lvl = Math.min(lvl - C * 0.004, h[pp]);
      p = pp;
      if (depth[p] < 0.5 && h[p] < lvl - 20) break; // well below the line again: the natural slope takes over
    }
  }
  return { nb, carved };
}

function simulate(id) {
  const L = LOCATIONS[id], S = SIM[id], noise = makeNoise(L.seed);
  const base = (x, z) => L.height(noise, x, z), height = L.erosion === false ? base : erode(base, { seed: L.seed, ...L.erosion });
  const sea = L.water;
  console.log(`[${id}] sampling ${N}x${N} @ ${C.toFixed(2)} m`);
  let t0 = Date.now();
  const h0 = new Float32Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) h0[z * N + x] = height(X0 + x * C, X0 + z * C);
  console.log(`[${id}]   ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const h = h0.slice();
  // outlets: the map border and real water bodies (sea, lakes) below the water level; small pits are filled
  const outlet = new Uint8Array(N * N), seen = new Uint8Array(N * N), q = new Int32Array(N * N);
  for (let i0 = 0; i0 < N * N; i0++) {
    if (seen[i0] || h0[i0] >= sea) continue;
    let qn = 0, qh = 0; q[qn++] = i0; seen[i0] = 1;
    while (qh < qn) { const i = q[qh++], x = i % N, z = (i / N) | 0; for (let d = 0; d < 4; d++) { const xx = x + D8[d][0], zz = z + D8[d][1]; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue; const j = zz * N + xx; if (!seen[j] && h0[j] < sea) { seen[j] = 1; q[qn++] = j; } } }
    if (qn * C * C > 0.15e6) for (let k = 0; k < qn; k++) outlet[q[k]] = 1;
  }
  // spatially varying erodibility: a little noise so drainage density changes across the map
  const kf = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) { const x = X0 + (i % N) * C, z = X0 + ((i / N) | 0) * C; kf[i] = 0.6 + 0.8 * (noise.fbm(x / 3000 + 31, z / 3000 - 17, 3) * 0.5 + 0.5); }
  const depo = new Float32Array(N * N); // talus + alluvium thickness
  if (S.uplift) {
    // Landscape from uplift (Cordonnier et al. 2016): the analytic terrain becomes the uplift rate, the stream-power
    // law runs to near steady state, and the result (all drainage, sharp ridges, no closed bowls) replaces the analytic
    // relief below the macro scale: final = blur(analytic) + (sim - blur(sim)).
    const hs = new Float32Array(N * N), U = new Float32Array(N * N);
    let mx = 0; for (let i = 0; i < N * N; i++) mx = Math.max(mx, h0[i] - sea);
    for (let i = 0; i < N * N; i++) { U[i] = Math.max(0, (h0[i] - sea) / mx) ** S.uplift.pow; hs[i] = h0[i]; }
    const Kc = S.uplift.K, rnd = mulberry32(L.seed * 31 + 7);
    for (let it = 0; it < S.uplift.iters; it++) {
      if (it % 4 === 0 || it === S.uplift.iters - 1) { const hf = hs.slice(); fillDepressions(hf, outlet, 1e-2); for (let i = 0; i < N * N; i++) hs[i] = hf[i]; } // pits between fills just pause their cell
      const { rcv, rl, stack, area } = flowTree(hs, outlet, rnd);
      for (let s = 0; s < stack.length; s++) {
        const i = stack[s], r = rcv[i]; if (r === i) continue;
        const F = Kc * kf[i] * Math.pow(area[i], S.m) / rl[i];
        hs[i] = (hs[i] + U[i] * S.uplift.u + F * hs[r]) / (1 + F);
      }
      // talus limit: no slope above the angle of repose
      for (let s = 0; s < stack.length; s++) { const i = stack[s], r = rcv[i]; if (r !== i) hs[i] = Math.min(hs[i], hs[r] + rl[i] * S.uplift.maxS); }
      if (it % 25 === 0) console.log(`[${id}]   uplift iter ${it}`);
    }
    const blur = (src, R) => {
      const a = new Float32Array(N * N), b = new Float32Array(N * N);
      for (let pass = 0; pass < 3; pass++) {
        const s0 = pass ? b : src;
        for (let z = 0; z < N; z++) { let acc = 0, cnt = 0; for (let x = -R; x <= R; x++) if (x >= 0 && x < N) { acc += s0[z * N + x]; cnt++; } for (let x = 0; x < N; x++) { a[z * N + x] = acc / cnt; const xo = x - R, xi = x + R + 1; if (xo >= 0) { acc -= s0[z * N + xo]; cnt--; } if (xi < N) { acc += s0[z * N + xi]; cnt++; } } }
        for (let x = 0; x < N; x++) { let acc = 0, cnt = 0; for (let z = -R; z <= R; z++) if (z >= 0 && z < N) { acc += a[z * N + x]; cnt++; } for (let z = 0; z < N; z++) { b[z * N + x] = acc / cnt; const zo = z - R, zi = z + R + 1; if (zo >= 0) { acc -= a[zo * N + x]; cnt--; } if (zi < N) { acc += a[zi * N + x]; cnt++; } } }
      }
      return b;
    };
    const R = Math.round(S.uplift.macro / C / 1.7), l0 = blur(h0, R), ls = blur(hs, R), r1 = Math.max(1, Math.round(S.uplift.fine / C / 1.7)), f0 = blur(h0, r1), fs = blur(hs, 1);
    // the sim's relief is scaled to the analytic relief around it (local RMS at the macro scale), so peaks keep their height
    const sq = (a, b) => { const o = new Float32Array(N * N); for (let i = 0; i < N * N; i++) o[i] = (a[i] - b[i]) ** 2; return o; };
    const v0 = blur(sq(h0, l0), R), vs = blur(sq(hs, ls), R);
    for (let i = 0; i < N * N; i++) {
      // keep sea, lakes and flat valley floors as designed: the sim relief comes in with the analytic relief
      const rel = Math.min(1, Math.max(0, (h0[i] - sea) / 120));
      const g = Math.min(2.5, Math.max(0.6, Math.sqrt((v0[i] + 1) / (vs[i] + 1)))) * S.uplift.gain;
      const sim = l0[i] + ((fs[i] * 0.6 + hs[i] * 0.4) - ls[i]) * g + (h0[i] - f0[i]) * S.uplift.detail;
      h[i] = outlet[i] ? h0[i] : h0[i] + rel * (sim - h0[i]) * S.uplift.mix;
    }
  }
  for (let pass = 0; pass < (S.breach === false ? 0 : 3); pass++) { const b = breach(h, outlet, S.infill ?? 0.12); console.log(`[${id}]   breach: ${b.nb} basins, ${(b.carved * C * C / 1e9).toFixed(3)} km3 cut`); }
  t0 = Date.now();
  let tree;
  let lake = null;
  for (let it = 0; it < S.iters; it++) {
    // water is routed over the depression-filled surface (closed basins hold lakes and spill over their sill);
    // erosion and deposition act on the real surface
    const hf = h.slice(); lake = fillDepressions(hf, outlet);
    tree = flowTree(hf, outlet);
    const { rcv, rl, stack, area } = tree;
    // 1. stream power, implicit (n = 1): h_i' = (h_i + F h_r') / (1 + F), F = K dt A^m / L
    const er = new Float32Array(N * N), sedIn = new Float32Array(N * N);
    for (let s = 0; s < stack.length; s++) {
      const i = stack[s], r = rcv[i]; if (r === i || h[i] <= h[r]) continue;
      const F = S.K * kf[i] * S.dt * Math.pow(area[i], S.m) / rl[i];
      const hn = Math.max((h[i] + F * h[r]) / (1 + F), h[r] + 1e-3);
      if (hn < h[i]) { er[i] = h[i] - hn; h[i] = hn; }
    }
    // 2. sediment: the eroded volume travels downstream (upstream first); it settles where the transport capacity
    // (~ A^m S) drops (alluvial fans, valley floors) and fills lake basins from their inflows
    for (let s = stack.length - 1; s >= 0; s--) {
      const i = stack[s], r = rcv[i];
      let load = sedIn[i] + er[i];
      if (lake[i] > 0) { const dep = Math.min(load, lake[i]); h[i] += dep; depo[i] += dep; load -= dep; }
      else if (r !== i && h[i] > sea) {
        const slope = Math.max(0, (h[i] - h[r]) / rl[i]), cap = S.sedK * Math.pow(area[i], S.m) * slope * S.K * 40;
        if (load > cap) { const dep = Math.min((load - cap) * 0.5, 0.5); h[i] += dep; depo[i] += dep; load -= dep; }
      }
      if (r !== i) sedIn[r] += load;
    }
    // 3. talus: steep cells shed a little debris to lower neighbours; it rolls on while the slope stays above the angle
    if (S.shed > 0 && it >= S.iters - S.talusIters) {
      const T = S.talus;
      for (let pass = 0; pass < 1; pass++) for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
        const i = z * N + x; let tot = 0, best = -1, bs = 0;
        for (let d = 0; d < 8; d++) { const s = (h[i] - h[i + NB[d]]) / D8L[d] - T; if (s > bs) { bs = s; best = d; } }
        if (best < 0) continue;
        const j = i + NB[best], mv = bs * D8L[best] * S.shed * 0.5;
        h[i] -= mv; h[j] += mv; depo[j] += mv; depo[i] = Math.max(0, depo[i] - mv);
      }
    }
    // 4. hillslope diffusion (explicit, small)
    if (S.diff > 0 && it % 2 === 0) {
      const src = h.slice();
      for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
        const i = z * N + x; if (src[i] < sea) continue;
        const lap = src[i - 1] + src[i + 1] + src[i - N] + src[i + N] - 4 * src[i];
        h[i] += S.diff * lap * 0.25;
      }
    }
    if (it % 10 === 0) console.log(`[${id}]   iter ${it} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  // what is still a closed basin now holds a lake: its surface is flat at the spill level
  const hf = h.slice(); lake = fillDepressions(hf, outlet, 1e-4);
  for (let i = 0; i < N * N; i++) h[i] = hf[i];
  // rivers follow the final surface; a little noise on it keeps them from running in dead straight lines over flats
  const hr = h.slice(); for (let i = 0; i < N * N; i++) hr[i] += noise.fbm((X0 + (i % N) * C) / 70, (X0 + ((i / N) | 0) * C) / 70, 2) * 0.6;
  fillDepressions(hr, outlet, 1e-4); tree = flowTree(hr, outlet);
  // drainage area for the maps: multiple-flow-direction (Freeman 1991), so flow on open slopes and fans spreads
  // into braids and sheets instead of D8's ruler-straight lines
  {
    const ord = new Uint32Array(N * N).map((_, i) => i).sort((a, b) => hr[b] - hr[a]);
    const A = new Float32Array(N * N).fill(C * C), w = new Float32Array(8), P = S.mfd ?? 4;
    for (const i of ord) {
      const x = i % N, z = (i / N) | 0; if (x === 0 || z === 0 || x === N - 1 || z === N - 1 || outlet[i]) continue;
      let tot = 0;
      for (let d = 0; d < 8; d++) { const s = (hr[i] - hr[i + NB[d]]) / D8L[d]; w[d] = s > 0 ? s ** P : 0; tot += w[d]; }
      if (tot > 0) for (let d = 0; d < 8; d++) if (w[d] > 0) A[i + NB[d]] += A[i] * w[d] / tot;
    }
    tree.area = A;
  }
  let la = 0, lv = 0; for (let i = 0; i < N * N; i++) if (lake[i] > 0.5) { la++; lv += lake[i]; }
  console.log(`[${id}]   lakes ${(la * C * C / 1e6).toFixed(2)} km2, mean depth ${(lv / Math.max(1, la)).toFixed(1)} m`);
  const dd = Array.from(h, (v, i) => v - h0[i]).sort((a, b) => a - b), pc = (p) => dd[Math.floor(p * (dd.length - 1))].toFixed(1);
  console.log(`[${id}]   dh percentiles 0.1%:${pc(0.001)} 1%:${pc(0.01)} 10%:${pc(0.1)} 50%:${pc(0.5)} 90%:${pc(0.9)} 99%:${pc(0.99)} 99.9%:${pc(0.999)}`);
  console.log(`[${id}]   sim ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { h0, h, depo, tree, S, sea, L, outlet, lake };
}

// derived maps (RGBA8): R = open water coverage (rivers/streams), G = drainage log-area, B = deposition, A = wetness
function deriveMaps({ h, depo, tree, S, sea, lake }) {
  const { area } = tree, maps = new Uint8Array(N * N * 4);
  const cov = new Float32Array(N * N);
  // rivers: every cell above the threshold area splats a soft disc of the river's width (w ~ sqrt(A))
  for (let i = 0; i < N * N; i++) {
    const A = area[i]; if (A < S.rivA || h[i] < sea) continue;
    const w = S.rivW * Math.sqrt(A / S.rivA) ** 0.85, rr = w / 2, x = i % N, z = (i / N) | 0, R = Math.ceil(rr / C + 1);
    const fadeIn = Math.min(1, (A - S.rivA) / S.rivA * 2 + 0.25);
    for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
      const xx = x + a, zz = z + b; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
      const d = Math.hypot(a, b) * C, cv = Math.max(0, Math.min(1, (rr + C * 0.5 - d) / C)) * fadeIn, j = zz * N + xx;
      if (cv > cov[j]) cov[j] = cv;
    }
  }
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = z * N + x, k = i * 4;
    const xl = Math.max(0, x - 1), xr = Math.min(N - 1, x + 1), zl = Math.max(0, z - 1), zr = Math.min(N - 1, z + 1);
    const sl = Math.hypot(h[z * N + xr] - h[z * N + xl], h[zr * N + x] - h[zl * N + x]) / (2 * C);
    const la = Math.log10(area[i] / (C * C)); // 0 .. ~6
    const twi = Math.log(area[i] / C / Math.max(0.01, sl)); // topographic wetness index
    maps[k] = Math.round(Math.max(cov[i], lake[i] > 2 ? 1 : 0) * 255);
    maps[k + 1] = Math.max(0, Math.min(255, Math.round(la / 6 * 255)));
    maps[k + 2] = Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(0, depo[i]) / 40) * 255)));
    maps[k + 3] = Math.max(0, Math.min(255, Math.round((twi - 4) / 14 * 255)));
  }
  return maps;
}

// fade weight: 1 over the core, 0 at the edge of the baked area
const fadeAt = (x, z) => { const d = Math.max(Math.abs(x), Math.abs(z)); const t = Math.min(1, Math.max(0, (BAKE.span / 2 - 120 - d) / (BAKE.span / 2 - 120 - BAKE.core / 2))); return t * t * (3 - 2 * t); };

function write(id, sim, maps) {
  const { h0, h } = sim, M = (N + 1) >> 1;
  // shipped at half resolution (26 m): the game's finest terrain grid is ~21 m, and the sim's 13 m detail is mostly
  // incompressible noise. Rivers (water coverage) stay at full resolution, for crisp banks.
  const down = (src, stride, off) => { // [1 2 1]^2 filter onto every other node
    const out = new Float32Array(M * M);
    for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) {
      let acc = 0, wt = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const X = x * 2 + a, Z = z * 2 + b; if (X < 0 || Z < 0 || X >= N || Z >= N) continue; const w = (2 - Math.abs(a)) * (2 - Math.abs(b)); acc += src[(Z * N + X) * stride + off] * w; wt += w; }
      out[z * M + x] = acc / wt;
    }
    return out;
  };
  const dh = new Float32Array(N * N); for (let i = 0; i < N * N; i++) dh[i] = h[i] - h0[i];
  const dd = down(dh, 1, 0), C2 = C * 2;
  // height difference in 1/8 m steps, faded at the border, stored as row-wise deltas split into two byte planes
  const q = new Int16Array(M * M);
  let maxD = 0;
  for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) {
    const i = z * M + x, d = dd[i] * fadeAt(X0 + x * C2, X0 + z * C2);
    q[i] = Math.max(-32767, Math.min(32767, Math.round(d * 8))); maxD = Math.max(maxD, Math.abs(d));
  }
  const res = new Int16Array(M * M);
  for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) { const i = z * M + x; res[i] = q[i] - (x ? q[i - 1] : z ? q[i - M] : 0); }
  const lo = new Uint8Array(M * M), hi = new Uint8Array(M * M);
  for (let i = 0; i < M * M; i++) { lo[i] = res[i] & 255; hi[i] = (res[i] >> 8) & 255; }
  const half = [1, 2, 3].map((c) => { const f = down(maps, 4, c), p = new Uint8Array(M * M); for (let i = 0; i < M * M; i++) p[i] = Math.round(f[i] * fadeAt(X0 + (i % M) * C2, X0 + ((i / M) | 0) * C2) / 4) * 4; return p; }); // 64 levels: smooth fields, compresses far better
  const water = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) water[i] = Math.round(maps[i * 4] * fadeAt(X0 + (i % N) * C, X0 + ((i / N) | 0) * C));
  // check samples: the game verifies the analytic function still matches what was baked against
  const probes = [];
  for (let k = 0; k < 16; k++) { const x = ((k * 7919) % 97) / 97 * 20000 - 10000, z = ((k * 104729) % 89) / 89 * 20000 - 10000; probes.push([+x.toFixed(1), +z.toFixed(1)]); }
  const noise = makeNoise(sim.L.seed), base = (x, z) => sim.L.height(noise, x, z), height = sim.L.erosion === false ? base : erode(base, { seed: sim.L.seed, ...sim.L.erosion });
  const header = { v: 2, id, dry: !sim.S.wet, n: M, nw: N, span: BAKE.span, core: BAKE.core, scale: 1 / 8, planes: ['dlo', 'dhi', 'drain', 'depo', 'wet', 'water'], probes: probes.map(([x, z]) => [x, z, +height(x, z).toFixed(2)]) };
  const hj = Buffer.from(JSON.stringify(header));
  const body = Buffer.concat([lo, hi, ...half, water].map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  const head = Buffer.alloc(8); head.write('SKYT', 0); head.writeUInt32LE(hj.length, 4);
  const file = gzipSync(Buffer.concat([head, hj, body]), { level: 9 });
  writeFileSync(new URL(`${id}.bin`, OUT), file);
  console.log(`[${id}] wrote ${(file.length / 1048576).toFixed(2)} MB, max |dh| ${maxD.toFixed(1)} m`);
}

// ---- preview PNG (hillshade + water + deposition), for tuning ----
function png(w, hgt, rgb) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * hgt); for (let y = 0; y < hgt; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(hgt, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function preview(id, sim, maps, dir) {
  mkdirSync(dir, { recursive: true });
  for (const [tag, step, ox, oz, W] of [['', Math.max(1, Math.round(N / 1024)), 0, 0, Math.floor(N / Math.max(1, Math.round(N / 1024)))], ['_zoom', 1, Math.floor(N * 0.3), Math.floor(N * 0.3), Math.min(640, Math.floor(N * 0.7) - 1)]])
  for (const [name, hh] of [['before', sim.h0], ['after', sim.h]]) {
    const rgb = new Uint8Array(W * W * 3);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const X = ox + x * step, Z = oz + y * step;
      const i = Z * N + X, xl = Math.max(0, X - 1), xr = Math.min(N - 1, X + 1), zl = Math.max(0, Z - 1), zr = Math.min(N - 1, Z + 1);
      const dx = (hh[Z * N + xr] - hh[Z * N + xl]) / (2 * C), dz = (hh[zr * N + X] - hh[zl * N + X]) / (2 * C);
      const nl = Math.hypot(dx, 1, dz), sh = Math.max(0, (-dx * -0.6 + 1 * 0.6 + -dz * -0.5) / nl / Math.hypot(0.6, 0.6, 0.5));
      let r = 60 + sh * 180, g = 64 + sh * 170, b = 58 + sh * 150;
      if (hh[i] < sim.sea && sim.outlet[i]) { r = 30; g = 60; b = 110; }
      if (name === 'after') { const wv = maps[i * 4] / 255, dv = maps[i * 4 + 2] / 255; r = r * (1 - wv) + 40 * wv + dv * 30; g = g * (1 - wv) + 90 * wv + dv * 15; b = b * (1 - wv) + 200 * wv; }
      rgb[(y * W + x) * 3] = Math.min(255, r); rgb[(y * W + x) * 3 + 1] = Math.min(255, g); rgb[(y * W + x) * 3 + 2] = Math.min(255, b);
    }
    writeFileSync(`${dir}/${id}_${name}${tag}.png`, png(W, W, Buffer.from(rgb.buffer)));
  }
}

for (const id of ids.length ? ids : Object.keys(SIM)) {
  if (!SIM[id]) { console.warn('no sim settings for', id); continue; }
  // --cache dir: keep the (slow) simulation result, so maps and the file format can be iterated on quickly
  let sim;
  const cf = CACHE && `${CACHE}/${id}-${N}.sim`;
  if (cf && existsSync(cf)) {
    const buf = readFileSync(cf), f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), nn = N * N, L = LOCATIONS[id];
    sim = { h0: f.slice(0, nn), h: f.slice(nn, 2 * nn), depo: f.slice(2 * nn, 3 * nn), tree: { area: f.slice(3 * nn, 4 * nn) }, lake: f.slice(4 * nn, 5 * nn), outlet: Uint8Array.from(f.slice(5 * nn, 6 * nn)), S: SIM[id], sea: L.water, L };
    console.log(`[${id}] simulation from cache`);
  } else {
    sim = simulate(id);
    if (cf) { mkdirSync(CACHE, { recursive: true }); const f = new Float32Array(6 * N * N); [sim.h0, sim.h, sim.depo, sim.tree.area, sim.lake, Float32Array.from(sim.outlet)].forEach((a, k) => f.set(a, k * N * N)); writeFileSync(cf, Buffer.from(f.buffer)); }
  }
  const maps = deriveMaps(sim);
  if (PREVIEW) preview(id, sim, maps, PREVIEW);
  write(id, sim, maps);
}
