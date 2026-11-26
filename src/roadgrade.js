// Road engineering: grade-limited routing, vertical profiles, cut-and-fill, bridges and the road surface physics reads.
//  - route(): A* over a ~40 m cost grid built from the raw terrain. Edges steeper than the road's ruling grade cost
//    far more than going round, so climbs come out as traverses and switchbacks along the contours; water costs a
//    bridge. smoothPath() turns the grid path into a curve.
//  - profileRoad(): the road's own elevation profile: the balanced cut/fill line between the terrain's upper and
//    lower grade envelopes (so it never exceeds the grade), smoothed into vertical curves, held above water and
//    pinned to the roads it joins. Where it runs well above the ground or over water it becomes a bridge.
//  - carveGrid(): cuts and fills that profile into a heightfield: a bench at road level, then slope-limited
//    embankments/cuttings back to the terrain.
//  - RoadSurface: segment index over every road and bridge. World.sampleGrid returns the road profile inside a
//    road's footprint (and the embankment just outside it); World.groundAt also returns bridge decks.
import * as THREE from 'three';
import { clamp, smoothstep } from './noise.js';

export const GRADE = { highway: 0.08, main: 0.1, street: 0.12, lane: 0.14, rail: 0.035, real: 0.2 };
export const VERGE = 1.5; // gravel verge beside the tarmac (part of the drivable footprint)
const FILL = 0.6, CUT = 0.9; // embankment / cutting side slopes (rise per metre out)
const SEG = 9, BLEND = 3, UNDER = 9, MINOR_RANK = 1e7, MINOR_EDGE = 1.5; // (UNDER: a tunnel's cover, metres: profileRoad) // RoadSurface: floats per segment; metres a major road hands over to a minor one in, at its edge

// Bilinear sampler over a (R+1)^2 core grid (the raw fine heights, before any carving).
export function gridSampler(w, H, R) {
  const st = w.size / R, W = R + 1, half = w.half;
  return (x, z) => {
    const fx = clamp((x + half) / st, 0, R - 1e-3), fz = clamp((z + half) / st, 0, R - 1e-3);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * W + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + W] * (1 - u) + H[k + W + 1] * u) * v;
  };
}

// ---------------- routing ----------------
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]];
const DLEN = DIRS.map(([a, b]) => Math.hypot(a, b)), DUX = DIRS.map(([a, b], k) => a / DLEN[k]), DUZ = DIRS.map(([a, b], k) => b / DLEN[k]);

// Cost grid over the core: heights, water and no-go cells (airport, map edge). blocked(x,z) -> true for no-go.
export function planGrid(w, terr, wetAt, blocked, cell = 40) {
  const n = Math.floor(w.size / cell) + 1, x0 = -w.half, N = n * n;
  const h = new Float32Array(N), wet = new Uint8Array(N), block = new Uint8Array(N);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + i * cell, z = x0 + j * cell, k = j * n + i;
    h[k] = terr(x, z); wet[k] = wetAt(x, z, h[k]) ? 1 : 0; block[k] = blocked(x, z) ? 1 : 0;
  }
  // route over the landform, not every eroded gully: a 3x3 closing fills gullies ~80 m across (the profile then
  // bridges or fills them, from the real ground). Unlike a blur it keeps ridges and valley floors where they are.
  morph2(h, n, 1, true); morph2(h, n, 1, false);
  return { n, cell, x0, h, wet, block, g: new Float32Array(N), par: new Int32Array(N), din: new Int8Array(N), closed: new Uint8Array(N) };
}
// separable square max (mx) or min filter, in place
function morph2(h, n, r, mx) {
  const t = new Float32Array(h.length), M = n - 1, f = mx ? Math.max : Math.min;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let a = h[j * n + i]; for (let d = -r; d <= r; d++) a = f(a, h[j * n + clamp(i + d, 0, M)]); t[j * n + i] = a; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let a = t[j * n + i]; for (let d = -r; d <= r; d++) a = f(a, t[clamp(j + d, 0, M) * n + i]); h[j * n + i] = a; }
}

// A* from (ax,az) to (bx,bz). o: { gmax, water: cost factor per metre over water, turn, alt (per 100 m above
// o.h0), margin (m around the endpoints' box that the search may use) }. Returns world points (y = 0) or null.
export function route(G, ax, az, bx, bz, o) {
  const { n, cell, x0, h, wet, block, g, par, din, closed } = G, road = G.road;
  const node = (x, z) => clamp(Math.round((z - x0) / cell), 0, n - 1) * n + clamp(Math.round((x - x0) / cell), 0, n - 1);
  const s = node(ax, az), t = node(bx, bz), ti = t % n, tj = (t / n) | 0;
  const M = Math.ceil((o.margin ?? 2500) / cell);
  const i0 = Math.max(0, Math.min(s % n, ti) - M), i1 = Math.min(n - 1, Math.max(s % n, ti) + M);
  const j0 = Math.max(0, Math.min((s / n) | 0, tj) - M), j1 = Math.min(n - 1, Math.max((s / n) | 0, tj) + M);
  for (let j = j0; j <= j1; j++) { const a = j * n + i0, b = j * n + i1 + 1; g.fill(Infinity, a, b); closed.fill(0, a, b); }
  const gmax = o.gmax, water = o.water ?? 8, turn = (o.turn ?? 0.4) * cell, alt = o.alt || 0, h0 = o.h0 ?? 0, HW = o.hw ?? 1.25;
  // binary heap of (f, node)
  let hf = new Float64Array(4096), hn = new Int32Array(4096), hs = 0;
  const push = (f, k) => {
    if (hs === hf.length) { const f2 = new Float64Array(hs * 2), n2 = new Int32Array(hs * 2); f2.set(hf); n2.set(hn); hf = f2; hn = n2; }
    let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hf[i] = hf[p]; hn[i] = hn[p]; i = p; } hf[i] = f; hn[i] = k;
  };
  const pop = () => {
    const k = hn[0], f = hf[--hs], kk = hn[hs]; let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && hf[c + 1] < hf[c]) c++; if (hf[c] >= f) break; hf[i] = hf[c]; hn[i] = hn[c]; i = c; }
    hf[i] = f; hn[i] = kk; return k;
  };
  g[s] = 0; din[s] = -1; par[s] = -1; push(0, s);
  let found = false;
  while (hs) {
    const k = pop(); if (closed[k]) continue;
    if (k === t) { found = true; break; }
    closed[k] = 1;
    const i = k % n, j = (k / n) | 0, hk = h[k], dk = din[k], gk = g[k];
    for (let d = 0; d < 16; d++) {
      const ni = i + DIRS[d][0], nj = j + DIRS[d][1];
      if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
      const nk = nj * n + ni; if (closed[nk] || (block[nk] && nk !== t)) continue;
      const L = DLEN[d] * cell;
      let dh = Math.abs(h[nk] - hk);
      if (DLEN[d] > 2) { // knight move: the cells it passes between count too
        const mi = i + Math.round(DIRS[d][0] / 2), mj = j + Math.round(DIRS[d][1] / 2), mh = h[mj * n + mi];
        dh = Math.max(dh, Math.abs(mh - hk) * 2, Math.abs(h[nk] - mh) * 2) * 0.75 + dh * 0.25;
      }
      const gr = dh / L, q = gr / gmax, w2 = wet[nk] + wet[k];
      // over water the deck still has to keep the grade (mountain streams are no shortcut uphill)
      let c = gr <= gmax ? L * (1 + 1.5 * q * q) : L * (2.5 + 20 * (q - 1) + 60 * (q - 1) * (q - 1));
      if (w2) c += L * (water - 1) * w2 * 0.5; // a bridge: dear
      if (road && road[k] && road[nk]) c = L * 0.3; // along a road already built
      if (alt) c += L * alt * Math.max(0, h[nk] - h0) / 100;
      if (dk >= 0) c += turn * (1 - (DUX[dk] * DUX[d] + DUZ[dk] * DUZ[d]));
      const ng = gk + c;
      if (ng < g[nk]) {
        g[nk] = ng; par[nk] = k; din[nk] = d;
        push(ng + HW * cell * Math.hypot(ni - ti, nj - tj), nk);
      }
    }
  }
  if (!found) return null;
  const out = []; for (let k = t; k >= 0; k = par[k]) out.push(new THREE.Vector3(x0 + (k % n) * cell, 0, x0 + ((k / n) | 0) * cell));
  out.reverse();
  out[0].set(ax, 0, az); out[out.length - 1].set(bx, 0, bz);
  return out;
}


// Cut out loops: where a path comes back within d of where it was a little earlier (routes joined at a waypoint).
export function unloop(P, d, win = 40) {
  const out = P.slice();
  for (let i = 0; i < out.length; i++) for (let j = Math.min(out.length - 1, i + win); j > i + 2; j--) {
    if ((out[i].x - out[j].x) ** 2 + (out[i].z - out[j].z) ** 2 < d * d) { out.splice(i + 1, j - i - 1); break; }
  }
  return out;
}

// Douglas-Peucker (open polyline, xz)
function simplify(P, tol) {
  const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
  const st = [[0, P.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const A = P[a], B = P[b], dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((P[i].x - A.x) * dz - (P[i].z - A.z) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return P.filter((_, i) => keep[i]);
}
// split segments longer than maxL (so corner cutting stays local)
function densify(P, maxL, closed) {
  const out = [], n = P.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = P[i], b = P[(i + 1) % n], k = Math.max(1, Math.ceil(a.distanceTo(b) / maxL));
    for (let s = 0; s < k; s++) out.push(a.clone().lerp(b, s / k));
  }
  if (!closed) out.push(P[n - 1].clone());
  return out;
}
function chaikin(P, closed, iters) {
  for (let it = 0; it < iters; it++) {
    const out = [], n = P.length;
    if (!closed) out.push(P[0].clone());
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = P[i], b = P[(i + 1) % n];
      out.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
    }
    if (!closed) out.push(P[n - 1].clone());
    P = out;
  }
  return P;
}
// grid path -> smooth curve (still to be resampled)
export function smoothPath(P, { closed = false, tol = 14, maxL = 55, iters = 3 } = {}) {
  let Q = closed ? P : simplify(P, tol);
  Q = densify(Q, maxL, closed);
  return chaikin(Q, closed, iters);
}
// Ease every bend tighter than radius rmin (an evenly spaced path, ~8 m): points on a tight bend are pulled toward
// their neighbours' midpoint until it opens up (ends stay put). Keeps the ribbons from folding over on themselves.
export function relaxCurves(P, rmin, closed = false, iters = 60) {
  const n = P.length, k = 2;
  const radius = (i) => {
    const a = P[closed ? (i - k + n) % n : Math.max(0, i - k)], b = P[i], c = P[closed ? (i + k) % n : Math.min(n - 1, i + k)];
    const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z, lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    if (lu < 1e-3 || lv < 1e-3) return Infinity;
    const ang = Math.acos(clamp((ux * vx + uz * vz) / (lu * lv), -1, 1));
    return ang < 1e-4 ? Infinity : (lu + lv) / 2 / ang;
  };
  for (let it = 0; it < iters; it++) {
    const tight = [];
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) if (radius(i) < rmin) tight.push(i);
    if (!tight.length) break;
    const mark = new Uint8Array(n);
    for (const i of tight) for (let d = -3; d <= 3; d++) { const j = closed ? (i + d + n) % n : i + d; if (j > 0 && j < n - 1 || (closed && j >= 0 && j < n)) mark[j] = 1; }
    const Q = P.map((p) => p.clone());
    for (let i = 0; i < n; i++) if (mark[i]) { const a = Q[(i - 1 + n) % n], c = Q[(i + 1) % n]; P[i].x += ((a.x + c.x) / 2 - P[i].x) * 0.5; P[i].z += ((a.z + c.z) / 2 - P[i].z) * 0.5; }
  }
  return P;
}

// ---------------- vertical profile ----------------
// rd.pts (resampled, ~8 m) get .y; rd.bridge[i], rd.terr[i] (ground under the road) are set.
// o: { g: ruling grade, terr(x,z), wetAt(x,z,h), wl: water level, clear: deck clearance over water,
//      pins: [{ i, y }], smooth: half-window (samples), bridges: true to make bridges, fixed: per-point deck flags }
export function profileRoad(rd, o) {
  const P = rd.pts, n0 = P.length, closed = !!rd.closed;
  // closed roads: work on three laps and keep the middle one (no seam)
  const reps = closed ? 3 : 1, n = n0 * reps, idx = (k) => k % n0;
  const s = new Float64Array(n), t = new Float64Array(n), wet = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const p = P[idx(k)];
    if (k) { const q = P[idx(k - 1)]; s[k] = s[k - 1] + Math.hypot(p.x - q.x, p.z - q.z); }
    if (k < n0) { t[k] = o.terr(p.x, p.z) - (o.under?.[k] ? UNDER : 0); wet[k] = o.under?.[k] ? 0 : o.wetAt(p.x, p.z, t[k]) ? 1 : 0; } else { t[k] = t[idx(k)]; wet[k] = wet[idx(k)]; } // (o.under: a tunnel's points: follow the ground UNDER metres down)
  }
  // a tunnel's points (o.under): straight from one portal to the other, as tunnels are, only dipping where the ground
  // (a river bed, a valley) is less than UNDER metres over that line: never the hill's bumps far above it (#228)
  if (o.under) for (let k = 0; k < n0; k++) {
    if (!o.under[k] || (k > 0 && o.under[k - 1])) continue;
    let e = k; while (e + 1 < n0 && o.under[e + 1]) e++;
    const a = Math.max(0, k - 1), b = Math.min(n0 - 1, e + 1), ta = o.under[a] ? t[a] + UNDER : t[a], tb = o.under[b] ? t[b] + UNDER : t[b];
    for (let q = k; q <= e; q++) t[q] = Math.min(ta + (tb - ta) * (s[q] - s[a]) / Math.max(1, s[b] - s[a]), t[q]);
    k = e;
  }
  const g = o.g, fx = o.fixed;
  // what the road should hug: the ground with narrow dips (streams, gullies) closed over, to bridge or fill, and narrow
  // spurs opened, to cut through
  const base = morph(morph(t, o.span ?? 10, true), o.spur ?? 6, false);
  // upper (cut-only) and lower (fill-only) envelopes; their mean is the balanced line, and keeps the grade
  const U = Float64Array.from(base), L = Float64Array.from(base);
  for (let k = 1; k < n; k++) { const d = g * (s[k] - s[k - 1]); U[k] = Math.min(U[k], U[k - 1] + d); L[k] = Math.max(L[k], L[k - 1] - d); }
  for (let k = n - 2; k >= 0; k--) { const d = g * (s[k + 1] - s[k]); U[k] = Math.min(U[k], U[k + 1] + d); L[k] = Math.max(L[k], L[k + 1] - d); }
  let y = new Float64Array(n); for (let k = 0; k < n; k++) y[k] = (U[k] + L[k]) / 2;
  // vertical curves: box-smooth twice (a weighted mean of a grade-limited line keeps the grade)
  const m = o.smooth ?? 3;
  for (let pass = 0; pass < 2; pass++) {
    const y2 = new Float64Array(n);
    for (let k = 0; k < n; k++) { let a = 0, c = 0; for (let q = Math.max(0, k - m); q <= Math.min(n - 1, k + m); q++) { a += y[q]; c++; } y2[k] = a / c; }
    y = y2;
  }
  // hold decks above water (rivers: above their banks), and every road above the water level
  if (o.wl !== undefined) {
    const W = new Float64Array(n).fill(-Infinity);
    for (let k = 0; k < n; k++) W[k] = o.under?.[idx(k)] ? -Infinity : wet[k] ? Math.max(t[k], o.wl) + o.clear : o.wl + 1; // (a tunnel goes under rivers and the sea)
    for (let k = 1; k < n; k++) W[k] = Math.max(W[k], W[k - 1] - g * (s[k] - s[k - 1]));
    for (let k = n - 2; k >= 0; k--) W[k] = Math.max(W[k], W[k + 1] - g * (s[k + 1] - s[k]));
    for (let k = 0; k < n; k++) y[k] = Math.max(y[k], W[k]);
  }
  // fixed decks (mapped bridges): straight between their ends
  if (fx) for (let a = 0; a < n0; a++) {
    if (!fx[a] || (a > 0 && fx[a - 1])) continue;
    let b = a; while (b + 1 < n0 && fx[b + 1]) b++;
    const ya = y[Math.max(0, a - 1)], yb = y[Math.min(n0 - 1, b + 1)];
    for (let k = a; k <= b; k++) y[k] = ya + (yb - ya) * (s[k] - s[a]) / Math.max(1, s[b] - s[a]);
  }
  // pins: where this road joins another, meet it exactly (a grade-limited cone around the junction). A pin is at a
  // point (i) or anywhere along the road (s, metres from its start: a crossing between two points). Pins closer than
  // 2 m are one junction (their mean). Every pin is met: where two of them are further apart in height than the grade
  // allows over the distance between them (a real road steeper than its class), their cones widen to that grade, so
  // the road runs straight from one junction to the other instead of the last pin's cone pulling the first off its
  // junction (#228: a 23 m step where two Lauterbrunnen roads met end to end).
  const lap = closed ? s[n0] : 0, PS = [];
  for (const pin of o.pins || []) {
    const sp = pin.s ?? s[pin.i], m = PS.find((q) => Math.abs(q.s - sp) < 2 && Math.abs(q.y - pin.y) < 0.15); // (two junctions close together at different heights stay two pins: each is met)
    if (m) { m.y = (m.y * m.c + pin.y) / (m.c + 1); m.c++; } else PS.push({ s: sp, y: pin.y, c: 1 });
  }
  for (const p of PS) { p.g = g; for (const q of PS) if (q !== p) p.g = Math.max(p.g, Math.abs(p.y - q.y) / Math.abs(p.s - q.s)); }
  for (const p of PS) for (let r = 0; r < reps; r++) {
    const sp = p.s + r * lap;
    for (let k = 0; k < n; k++) { const d = p.g * Math.abs(s[k] - sp); y[k] = clamp(y[k], p.y - d, p.y + d); }
  }
  const off = closed ? n0 : 0;
  rd.terr = new Float32Array(n0); rd.wet = new Uint8Array(n0);
  for (let i = 0; i < n0; i++) { P[i].y = y[i + off]; rd.terr[i] = t[i + off]; rd.wet[i] = wet[i + off]; }
  rd.bridge = fx ? Array.from(fx, Boolean) : o.bridges === false ? new Array(n0).fill(false) : classifyBridges(rd);
  return rd;
}

// 1D morphological closing (close = true: max then min filter, fills dips narrower than 2r samples) or opening
function morph(a, r, close) {
  const n = a.length, f = (src, mx) => { const o = new Float64Array(n); for (let k = 0; k < n; k++) { let v = src[k]; for (let q = Math.max(0, k - r); q <= Math.min(n - 1, k + r); q++) v = mx ? Math.max(v, src[q]) : Math.min(v, src[q]); o[k] = v; } return o; };
  return close ? f(f(a, true), false) : f(f(a, false), true);
}

// Bridge where the road crosses water or runs > 5 m above the ground, out to where it is back near the ground.
function classifyBridges(rd) {
  const P = rd.pts, n = P.length, dz = (i) => P[i].y - rd.terr[i];
  const B = new Uint8Array(n);
  for (let i = 0; i < n; i++) B[i] = rd.wet[i] || dz(i) > 5 ? 1 : 0;
  // grow each run until the deck is within ~1.2 m of the ground (abutments on land)
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    if (!B[i]) continue;
    for (let k = i - 1; k >= 0 && !B[k] && (dz(k) > 1.2 || rd.wet[k]); k--) B[k] = 2;
    for (let k = i + 1; k < n && !B[k] && (dz(k) > 1.2 || rd.wet[k]); k++) B[k] = 2;
  }
  // close short gaps; drop short dry spans (they stay embankments)
  for (let i = 0; i < n; i++) if (!B[i]) { let k = i; while (k < n && !B[k]) k++; if (i > 0 && k < n && k - i < 5) for (let q = i; q < k; q++) B[q] = 2; i = k; }
  for (let i = 0; i < n; i++) if (B[i]) {
    let k = i, w = false; while (k < n && B[k]) { w = w || rd.wet[k]; k++; }
    if (!w && k - i < 5) for (let q = i; q < k; q++) B[q] = 0;
    else { if (i > 0) B[i - 1] = 1; if (k < n) B[k] = 1; } // one more sample each end: the deck lands on its abutment
    i = k;
  }
  return Array.from(B, Boolean);
}

// ---------------- carving ----------------
// Cut and fill every road's profile into a (R+1)^2 heightfield of spacing st over the core: each vertex takes its
// nearest road point; inside the bench (half width + k*st) it is set just below the road, beyond that it is
// clamped to the embankment/cutting slopes. Water is not filled and land is not cut below the water level.
// Then any triangle still poking up into a road's footprint is pushed down under it.
export function carveGrid(w, roads, H, R, st, bench = 0.75, junctions = []) {
  const W = R + 1, half = w.half, wl = w.waterLevel, N = W * W;
  const bd = new Float32Array(N).fill(Infinity), by = new Float32Array(N);
  const reach = st * bench + 46;
  for (const rd of roads) {
    const hw = rd.width / 2 + VERGE, P = rd.pts;
    for (let i = 0; i < P.length; i++) {
      if (rd.bridge?.[i] || rd.tube?.[i]) continue; // (a bridge's deck, a tunnel's tube: not on the ground)
      const p = P[i], i0 = Math.round((p.x + half) / st), j0 = Math.round((p.z + half) / st);
      // as far out as this point's embankment or cutting reaches: a road at the ground's height needs only its bench
      // (a city's streets: most of them; the 46 m search round every point was ~1 s of New York's load)
      const nearPortal = rd.tube && (rd.tube[i + 1] || rd.tube[i + 2] || rd.tube[i - 1] || rd.tube[i - 2]); // (the last of a tunnel's cutting: just its bench, or it would cut into the hill over the tube's mouth; the portal's headwall hides the face)
      const g = H[clamp(j0, 0, R) * W + clamp(i0, 0, R)], rl = nearPortal ? st * bench : Math.min(reach, st * bench + Math.abs(p.y - g) / FILL + st), rr = Math.ceil((hw + rl) / st);
      for (let j = j0 - rr; j <= j0 + rr; j++) for (let ii = i0 - rr; ii <= i0 + rr; ii++) {
        if (ii < 0 || j < 0 || ii > R || j > R) continue;
        const e = Math.hypot(-half + ii * st - p.x, -half + j * st - p.z) - hw, k = j * W + ii;
        if (e < bd[k] && e < rl) { bd[k] = e; by[k] = p.y; }
      }
    }
  }
  const b0 = st * bench;
  for (let k = 0; k < N; k++) {
    const e = bd[k]; if (e === Infinity) continue;
    const h0 = H[k], y = by[k], eb = e - b0;
    let h = eb <= 0 ? y - 0.05 : clamp(h0, y - FILL * eb, y + CUT * eb);
    if (h0 < wl && eb > 0) h = h0; // no filling of lakes and the sea beside a road
    if (h < h0) h = Math.max(h, Math.min(h0, wl + 0.3)); // no new water from cuttings
    H[k] = h;
  }
  pinUnder(w, roads, H, R, st, junctions);
}
// Push grid vertices down wherever the triangulated surface would rise above a road's footprint. Exact: every
// footprint quad between two road points (its edges where the road meshes put them, roads.js frame) is checked
// against every grid triangle it overlaps. Plane and road are both linear over it: under at the quad's four corners,
// under all over it (nearly always); else the quad is clipped to the triangle and the worst is at a corner of what
// is left. There the triangle's corners go down, the nearest the most (the least change that brings the worst point
// under), until it is under everywhere. Lowering never lifts another triangle, so one pass is enough. (#228: three
// samples across and two along every 8 m missed the triangles' own corners and edges, and the stretch onto a bridge:
// beyond the detail mesh the ground showed through the road.)
const PIN = 0.05; // metres the ground stays under a road
export const PAVE = { main: 4.5, street: 3.5 }; // a city street's pavements: metres out from the tarmac's edge (roads.js)
// A city's open ground (roads.js cityGround) lies CITY_TOP over the tarmac: the slabs' top (0.15 m kerb + the tarmac's
// lift, roads.js TARMAC_LIFT) less a centimetre. Off a city street's footprint (tarmac and verge) RoadSurface.over
// ramps up to it over PAVE_RAMP metres (under the slabs: no kerb in physics, a 4-9% rise) and from there hands over to
// that ground (World.cityAt) by CITY_BAND metres out (the ground between two streets at different heights is a slope
// from one to the other, and cityAt's grid, 40-57 m, is too coarse to have it right just beside them). SLAB: how far
// past a city street's footprint its pavement's slabs reach (roads.js roadMesh).
export const CITY_TOP = 0.18, PAVE_RAMP = 2, CITY_BAND = 12, SLAB = PAVE.main - VERGE;
function pinUnder(w, roads, H, R, st, junctions = []) {
  const W = R + 1, half = w.half, q = new Float64Array(8), tri = [0, 0, 0], wt = [0, 0, 0];
  let poly = new Float64Array(32), tmp = new Float64Array(32), np = 0; // (the clipped polygon: np floats, x, z pairs)
  // clip the polygon to the half plane (x - ax) * nx + (z - az) * nz >= 0
  const clip = (ax, az, nx, nz) => {
    let m = 0;
    for (let k = 0; k < np; k += 2) {
      const px = poly[k], pz = poly[k + 1], k2 = (k + 2) % np, qx = poly[k2], qz = poly[k2 + 1];
      const dp = (px - ax) * nx + (pz - az) * nz, dq = (qx - ax) * nx + (qz - az) * nz;
      if (dp >= 0) { tmp[m++] = px; tmp[m++] = pz; }
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); tmp[m++] = px + (qx - px) * t; tmp[m++] = pz + (qz - pz) * t; }
    }
    const sw = poly; poly = tmp; tmp = sw; np = m;
  };
  // the polygon q (nq floats: x, z pairs, convex) under the plane r0 + rx x + rz z (low: its lowest)
  const pin = (nq, r0, rx, rz, low) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < nq; k += 2) { x0 = Math.min(x0, q[k]); x1 = Math.max(x1, q[k]); z0 = Math.min(z0, q[k + 1]); z1 = Math.max(z1, q[k + 1]); }
    const i0 = Math.max(0, Math.floor((x0 + half) / st)), i1 = Math.min(R - 1, Math.floor((x1 + half) / st)), j0 = Math.max(0, Math.floor((z0 + half) / st)), j1 = Math.min(R - 1, Math.floor((z1 + half) / st));
    for (let gj = j0; gj <= j1; gj++) for (let gi = i0; gi <= i1; gi++) for (let h = 0; h < 2; h++) {
      // the cell's triangles, as World.triAt: h 0 = (a, b, d), h 1 = (b, c, d); a = (gi, gj), b = (gi, gj+1), c = (gi+1, gj+1), d = (gi+1, gj)
      const ka = gj * W + gi, kb = ka + W;
      if (h === 0) { tri[0] = ka; tri[1] = kb; tri[2] = ka + 1; } else { tri[0] = kb; tri[1] = kb + 1; tri[2] = ka + 1; }
      if (Math.max(H[tri[0]], H[tri[1]], H[tri[2]]) <= low) continue; // (all three corners under the road's lowest end: most of them, carved already)
      const xa = -half + gi * st, za = -half + gj * st;
      for (let it = 0; it < 4; it++) {
        // plane - road, linear: c0 + cx x + cz z
        const px = h === 0 ? (H[ka + 1] - H[ka]) / st : (H[kb + 1] - H[kb]) / st, pz = h === 0 ? (H[kb] - H[ka]) / st : (H[kb + 1] - H[ka + 1]) / st;
        const c0 = (h === 0 ? H[ka] : H[kb] + H[ka + 1] - H[kb + 1]) - px * xa - pz * za - r0, cx = px - rx, cz = pz - rz;
        // under at the quad's four corners: under all over it
        if (it === 0) { let mx = -Infinity; for (let k = 0; k < nq; k += 2) mx = Math.max(mx, c0 + cx * q[k] + cz * q[k + 1]); if (mx <= 1e-4) break; }
        // else over the quad clipped to the triangle: the worst is at one of its corners
        if (it === 0) {
          for (let k = 0; k < nq; k++) poly[k] = q[k];
          np = nq;
          if (h === 0) { clip(xa, za, 1, 0); clip(xa, za, 0, 1); clip(xa + st, za, -1, -1); } // (x >= xa, z >= za, x + z <= xa + za + st)
          else { clip(xa + st, za, -1, 0); clip(xa, za + st, 0, -1); clip(xa + st, za, 1, 1); } // (x <= xa + st, z <= za + st, x + z >= xa + za + st)
          if (np < 6) break;
        }
        let worst = 1e-4, wx = 0, wz = 0;
        for (let k = 0; k < np; k += 2) { const d = c0 + cx * poly[k] + cz * poly[k + 1]; if (d > worst) { worst = d; wx = poly[k]; wz = poly[k + 1]; } }
        if (worst <= 1e-4) break;
        if (it === 3) { for (let k = 0; k < 3; k++) H[tri[k]] -= worst; break; } // (still above: the whole triangle down)
        // the least change that brings the worst point under: each corner down in proportion to its weight there
        const u = (wx - xa) / st, v = (wz - za) / st;
        if (h === 0) { wt[0] = 1 - u - v; wt[1] = v; wt[2] = u; } else { wt[0] = 1 - u; wt[1] = u + v - 1; wt[2] = 1 - v; }
        const s2 = wt[0] * wt[0] + wt[1] * wt[1] + wt[2] * wt[2];
        for (let k = 0; k < 3; k++) H[tri[k]] -= worst * Math.max(0, wt[k]) / s2;
      }
    }
  };
  for (const rd of roads) {
    const P = rd.pts, n = P.length, closed = !!rd.closed, hw = rd.width / 2 + (w.loc?.city && (rd.kind === 'main' || rd.kind === 'street') && !rd.baked ? PAVE[rd.kind] : VERGE); // (a city street: out to its pavements' edge, roads.js)
    const F = new Float64Array(n * 2); // (each point's right vector, as roads.js frame)
    for (let i = 0; i < n; i++) { const a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1; F[i * 2] = -(b.z - a.z) / l; F[i * 2 + 1] = (b.x - a.x) / l; }
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if ((rd.bridge?.[i] && rd.bridge?.[j]) || rd.tube?.[i] || rd.tube?.[j]) continue; // (a deck, and a tunnel's tube up to its portal, where the headwall is: not on the ground. A deck's last point is on its abutment)
      const A = P[i], B = P[j], ax = F[i * 2], az = F[i * 2 + 1], bx = F[j * 2], bz = F[j * 2 + 1];
      const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz; if (L2 < 1e-6) continue;
      q[0] = A.x - ax * hw; q[1] = A.z - az * hw; q[2] = B.x - bx * hw; q[3] = B.z - bz * hw; q[4] = B.x + bx * hw; q[5] = B.z + bz * hw; q[6] = A.x + ax * hw; q[7] = A.z + az * hw;
      // the road over the quad: its profile along the centre line, carried straight across (linear: r0 + rx x + rz z)
      const g = (B.y - A.y) / L2, rx = g * dx, rz = g * dz, r0 = A.y - PIN - rx * A.x - rz * A.z, low = Math.min(A.y, B.y) - PIN;
      pin(8, r0, rx, rz, low);
    }
  }
  // junction boxes (junctions.js): their triangles, each a plane (level, or a warped box's); a city's corner
  // pavements, row to row (each row level across at its kerb's height: under the lower of the two)
  for (const J of junctions) {
    const V = J.vtx, Y = J.hy, T = J.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t], b = T[t + 1], c = T[t + 2]; for (let k = 0; k < 3; k++) { q[k * 2] = V[T[t + k] * 2]; q[k * 2 + 1] = V[T[t + k] * 2 + 1]; }
      const [r0, rx, rz] = plane(V[a * 2], V[a * 2 + 1], Y[a], V[b * 2], V[b * 2 + 1], Y[b], V[c * 2], V[c * 2 + 1], Y[c]);
      pin(6, r0 - PIN, rx, rz, Math.min(Y[a], Y[b], Y[c]) - PIN);
    }
    for (const rows of J.pave) for (let k = 1; k < rows.length; k++) { const a = rows[k - 1], b = rows[k], r0 = Math.min(a.y, b.y) - PIN; q[0] = a.k[0]; q[1] = a.k[1]; q[2] = b.k[0]; q[3] = b.k[1]; q[4] = b.o[0]; q[5] = b.o[1]; q[6] = a.o[0]; q[7] = a.o[1]; pin(8, r0, 0, 0, r0); }
  }
}

// the plane through three points: [r0, rx, rz] (y = r0 + rx x + rz z)
export function plane(ax, az, ay, bx, bz, by, cx, cz, cy) {
  const ux = bx - ax, uz = bz - az, uy = by - ay, vx = cx - ax, vz = cz - az, vy = cy - ay, den = ux * vz - uz * vx;
  if (Math.abs(den) < 1e-9) return [(ay + by + cy) / 3, 0, 0];
  const rx = (uy * vz - uz * vy) / den, rz = (ux * vy - uy * vx) / den; return [ay - rx * ax - rz * az, rx, rz];
}
// a junction box's height at (x, z) (junctions.js: its triangles, vtx and hy), and its slope (boxAt.gx, .gz); NaN off it
export function boxAt(B, x, z) {
  const V = B.vtx, Y = B.hy, T = B.tris;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 2, b = T[t + 1] * 2, c = T[t + 2] * 2, ax = V[a], az = V[a + 1], bx = V[b], bz = V[b + 1], cx = V[c], cz = V[c + 1];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(den) < 1e-12) continue;
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den, wc = 1 - wa - wb;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
    const ya = Y[T[t]], yb = Y[T[t + 1]], yc = Y[T[t + 2]];
    if (B.flat) { boxAt.gx = 0; boxAt.gz = 0; return ya; }
    { const ux = bx - ax, uz = bz - az, uy = yb - ya, vx = cx - ax, vz = cz - az, vy = yc - ya, dd = ux * vz - uz * vx || 1e-9; boxAt.gx = (uy * vz - uz * vy) / dd; boxAt.gz = (ux * vy - uy * vx) / dd; } // (its slope: plane(), without the allocation)
    return ya * wa + yb * wb + yc * wc;
  }
  return NaN;
}
// point in polygon ([x, z, ...]), and the distance to its edges (junction boxes, junctions.js)
export function inside(poly, x, z) { let c = false; const n = poly.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
// the distance from (x, z) to the polygon's edges
// (edgeDist.at: the nearest edge, by the index of its first point; edgeDist.t: how far along it, 0..1; edgeDist.inside:
// whether (x, z) is inside, as inside())
export function edgeDist(poly, x, z) {
  let d2 = Infinity, c = false; const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) { const ax = poly[j * 2], az = poly[j * 2 + 1], dx = poly[i * 2] - ax, dz = poly[i * 2 + 1] - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t - x, pz = az + dz * t - z, e = px * px + pz * pz; if (e < d2) { d2 = e; edgeDist.at = j; edgeDist.t = t; } const zi = poly[i * 2 + 1]; if ((zi > z) !== (az > z) && x < (ax - poly[i * 2]) * (z - zi) / (az - zi) + poly[i * 2]) c = !c; }
  edgeDist.inside = c; return Math.sqrt(d2);
}
// ---------------- the surface physics reads ----------------
// Segment index over all roads (and rail) on the ground, plus bridge decks. q(x,z,deck) finds the segment whose
// footprint edge is nearest: sets .y (road height there), .e (distance beyond the footprint edge, <= 0 inside),
// .g (grade along it, signed by dx/dz) and returns true; false when no road is within reach.
export class RoadSurface {
  // bench: metres of level ground beside the footprint before a cutting rises (World.detailBench: the near-camera
  // detail mesh samples this surface every DS metres; a cutting rising right at the road's edge reached in over it)
  // junctions: the junction boxes (junctions.js, net.junctions): inside one the surface is its level height
  constructor(w, roads, skirt, bench = 0, junctions = []) {
    this.half = w.half; this.S = skirt; this.cell = 32; this.B = bench;
    const C = this.cell, nC = (this.nC = Math.ceil(w.size / C) + 1);
    // ax, az, bx, bz, ay, by, hw, deck, rank (the order the profiles were made in: lower = the major road); and how far
    // out each segment's embankment reaches (its height off the ground / the fill slope: a street at the ground's
    // height, just its verge). Registering every segment out to the full skirt was ~10M cell entries in New York.
    let ns = 0; for (const rd of roads) ns += rd.closed ? rd.pts.length : rd.pts.length - 1;
    const S = (this.seg = new Float32Array(ns * SEG)), reach = new Float32Array(ns), ground = w.Hh ? (x, z) => w.triAt(w.Hh, w.hR + 1, clamp((x + w.half) / w.hStep, 0, w.hR - 1e-3), clamp((z + w.half) / w.hStep, 0, w.hR - 1e-3)) : null;
    let s0 = 0;
    const cs = (this.cs = new Uint8Array(ns)), sf = (this.sf = new Uint8Array(ns)), city = !!w.loc?.city; this.k = 0; this.surf = 0; // (sf: a way off the street network's surface, roadnet.js SURF: World.groundAt's gravel) // (cs: a city street's segment, on the ground: its pavements and the open ground round it at the slabs' level, over)
    roads.forEach((rd, ri) => {
      const P = rd.pts, n = P.length, last = rd.closed ? n : n - 1, street = city && (rd.kind === 'main' || rd.kind === 'street' || rd.minor) && !rd.baked; // (a city's pedestrian streets and alleys too: the open ground beside them is at their level, with no kerb)
      for (let i = 0; i < last; i++, s0++) {
        if (rd.minor) sf[s0] = (rd.surf || 0) | 4; // (4: off the street network)
        const a = P[i], b = P[(i + 1) % n], tu = !!(rd.tube?.[i] && rd.tube?.[(i + 1) % n]), br = tu || !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % n]); // (a tunnel's tube: a deck underground, flag 8)
        // deck flags: 1 = deck, +2 / +4 = the deck carries on before / after (a joint, round; an abutment end is square)
        const isD = (k) => !!((rd.bridge?.[(k + n) % n] && rd.bridge?.[(k + 1 + n) % n]) || (rd.tube?.[(k + n) % n] && rd.tube?.[(k + 1 + n) % n])) && (rd.closed || (k >= 0 && k < n - 1));
        const o = s0 * SEG; S[o] = a.x; S[o + 1] = a.z; S[o + 2] = b.x; S[o + 3] = b.z; S[o + 4] = a.y; S[o + 5] = b.y; S[o + 6] = br ? rd.width / 2 + 1 : rd.width / 2 + VERGE; S[o + 7] = br ? 1 + (isD(i - 1) ? 2 : 0) + (isD(i + 1) ? 4 : 0) + (tu ? 8 : 0) : 0; S[o + 8] = rd.rank ?? ri;
        reach[s0] = br || !ground ? skirt : Math.min(skirt, Math.max(Math.abs(a.y - ground(a.x, a.z)), Math.abs(b.y - ground(b.x, b.z))) / FILL + 4 + bench);
        if (street && !br) { cs[s0] = rd.kind === 'main' ? 2 : 1; reach[s0] = Math.max(reach[s0], CITY_BAND + 1); } // (a city street: out to its hand-over to the open ground)
      }
    });
    const cnt = new Int32Array(nC * nC + 1), cells = (s, fn) => {
      const r = S[s * SEG + 6] + (S[s * SEG + 7] ? 0.5 : reach[s]) + 1;
      const o = s * SEG, xa = Math.min(S[o], S[o + 2]) - r, xb = Math.max(S[o], S[o + 2]) + r, za = Math.min(S[o + 1], S[o + 3]) - r, zb = Math.max(S[o + 1], S[o + 3]) + r;
      for (let cj = Math.max(0, Math.floor((za + this.half) / C)); cj <= Math.min(nC - 1, Math.floor((zb + this.half) / C)); cj++)
        for (let ci = Math.max(0, Math.floor((xa + this.half) / C)); ci <= Math.min(nC - 1, Math.floor((xb + this.half) / C)); ci++) fn(cj * nC + ci);
    };
    for (let s = 0; s < ns; s++) cells(s, (c) => cnt[c + 1]++);
    for (let c = 0; c < nC * nC; c++) cnt[c + 1] += cnt[c];
    const ids = new Int32Array(cnt[nC * nC]), fill = cnt.slice();
    for (let s = 0; s < ns; s++) cells(s, (c) => (ids[fill[c]++] = s));
    this.start = cnt; this.ids = ids;
    // the junction boxes per cell
    this.jb = junctions; const jc = new Map();
    junctions.forEach((B, b) => { const [x0, z0, x1, z1] = B.bb; for (let cj = Math.max(0, Math.floor((z0 + this.half) / C)); cj <= Math.min(nC - 1, Math.floor((z1 + this.half) / C)); cj++) for (let ci = Math.max(0, Math.floor((x0 + this.half) / C)); ci <= Math.min(nC - 1, Math.floor((x1 + this.half) / C)); ci++) { const c = cj * nC + ci; let L = jc.get(c); if (!L) jc.set(c, (L = [])); L.push(b); } });
    this.jcell = jc;
    this.y = 0; this.e = 0; this.g = 0; this.In = new Float64Array(40); this.ord = new Int32Array(8); this.nIn = 0; this.Out = new Float64Array(32); this.nOut = 0; // (Out: the city streets just beyond whose footprints (x, z) is, near)
  }
  // deck: bridge decks only, and where decks cross (an overpass) the highest one not above y + 2 (any, without y)
  q(x, z, deck = false, y = Infinity) {
    const C = this.cell, ci = Math.floor((x + this.half) / C), cj = Math.floor((z + this.half) / C), nC = this.nC;
    if (ci < 0 || cj < 0 || ci >= nC || cj >= nC) return false;
    const c = cj * nC + ci, a = this.start[c], b = this.start[c + 1], jl = deck ? null : this.jcell.get(c);
    if (a === b && !jl) return false;
    const S = this.seg, want = deck ? 1 : 0; this.nIn = 0; this.nOut = 0; this.surf = 0;
    let best = deck ? 0.5 : this.S, top = -Infinity, hit = false; // (decks: best = e of the current pick)
    // in a junction's box: its level height, the major surface there (rank -1: over every road's, handing over to the
    // arms in the last BLEND metres to its edge, where they are level with it too)
    // (its footprint, as a road's: out to a verge beyond its kerbs, VERGE; not past its mouths, where the arms go on)
    if (jl) for (const id of jl) {
      const B = this.jb[id], bb = B.bb; if (x < bb[0] - VERGE || x > bb[2] + VERGE || z < bb[1] - VERGE || z > bb[3] + VERGE) continue;
      const d = edgeDist(B.box, x, z), inB = edgeDist.inside, at = edgeDist.at; if (!inB && (d > VERGE || B.open[at])) continue;
      // (its height there: the box's triangles; just outside, along its kerb, the kerb's)
      const e = inB ? -d - VERGE : d - VERGE;
      let yy = inB ? (B.flat ? B.y : boxAt(B, x, z)) : NaN, gx = 0, gz = 0;
      if (Number.isNaN(yy)) { const nb = B.box.length / 2; yy = B.ey[at] + (B.ey[(at + 1) % nb] - B.ey[at]) * edgeDist.t; } else if (!B.flat) { gx = boxAt.gx; gz = boxAt.gz; }
      this.inside(-1, inB ? -BLEND - d : -BLEND * (1 - d / VERGE), yy, gx, gz); // (in the blend: all the box inside it, so the surface is the one it draws, whatever else passes there; handing over across its verge)
      if (e < best) { best = e; hit = true; this.y = yy; this.e = e; this.gx = gx; this.gz = gz; }
    }
    for (let k = a; k < b; k++) {
      const o = this.ids[k] * SEG, f = S[o + 7]; if ((f & 1) !== want) continue;
      const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, L2 = dx * dx + dz * dz || 1;
      const t0 = ((x - ax) * dx + (z - az) * dz) / L2; if (deck && ((t0 < -0.01 && !(f & 2)) || (t0 > 1.01 && !(f & 4)))) continue; // decks end square at their abutments
      const t = clamp(t0, 0, 1), px = ax + dx * t - x, pz = az + dz * t - z;
      const e = Math.sqrt(px * px + pz * pz) - S[o + 6], yy = S[o + 4] + (S[o + 5] - S[o + 4]) * t;
      if (deck && (f & 8) && !(yy > y - 7)) continue; // (a tunnel's floor: only for what is down in the tunnel, not on the hill above it)
      // decks: the nearest centreline on the same level; a deck a level up (an overpass) wins outright
      if (!deck && e < 0) this.inside(S[o + 8] + (this.sf[this.ids[k]] & 4 ? MINOR_RANK : 0), e, yy, (S[o + 5] - S[o + 4]) * dx / L2, (S[o + 5] - S[o + 4]) * dz / L2);
      else if (!deck && e < CITY_BAND && this.cs[this.ids[k]]) this.near(S[o + 8], e, yy, this.cs[this.ids[k]] === 2 ? SLAB : PAVE.street - VERGE);
      const eb = !deck && e > 0 && (this.sf[this.ids[k]] & 4) ? e + MINOR_EDGE : e; // (beyond the footprints: a street's embankment before a way off the street network's, where the two meet)
      if (deck ? e < ((f & 8) ? 1.5 : 0.5) && yy < y + 2 && (!hit || yy > top + 2.5 || (yy > top - 2.5 && e < best)) : eb < best) {
        best = deck ? e : eb; top = yy; hit = true; this.k = this.ids[k]; this.surf = this.sf[this.k] & 3; this.y = yy; this.e = e; this.gx = (S[o + 5] - S[o + 4]) * dx / L2; this.gz = (S[o + 5] - S[o + 4]) * dz / L2;
      }
    }
    if (!deck && this.nIn > 1) this.blend();
    return hit;
  }
  // where footprints overlap (a junction, roads side by side): one surface, not whichever edge is nearest (that jumps
  // between the roads' heights, a wall across the junction, #228). The major road (lowest rank) holds inside its
  // footprint and hands over to the minor one over the last BLEND metres to its edge. inside(): records a road (x, z)
  // is inside, each road once (its deepest segment).
  inside(rank, e, y, gx, gz) {
    const R = this.In; let k = 0;
    while (k < this.nIn && R[k * 5] !== rank) k++;
    if (k < this.nIn) { if (e >= R[k * 5 + 1]) return; } else { if (k >= 8) return; this.nIn++; }
    R[k * 5] = rank; R[k * 5 + 1] = e; R[k * 5 + 2] = y; R[k * 5 + 3] = gx; R[k * 5 + 4] = gz;
  }
  // a city street (x, z) lies just beyond (within CITY_BAND of its footprint): each street once, its nearest segment;
  // sl: how far past its footprint its slabs reach
  near(rank, e, y, sl) {
    const R = this.Out; let k = 0;
    while (k < this.nOut && R[k * 4] !== rank) k++;
    if (k < this.nOut) { if (e >= R[k * 4 + 1]) return; } else { if (k >= 8) return; this.nOut++; }
    R[k * 4] = rank; R[k * 4 + 1] = e; R[k * 4 + 2] = y; R[k * 4 + 3] = sl;
  }
  blend() {
    const R = this.In, n = this.nIn, ord = this.ord; for (let k = 0; k < n; k++) ord[k] = k;
    for (let a = 1; a < n; a++) { const v = ord[a]; let b = a - 1; while (b >= 0 && R[ord[b] * 5] < R[v * 5]) { ord[b + 1] = ord[b]; b--; } ord[b + 1] = v; } // minor first
    // (a street hands over to a way off the street network in its verge only, VERGE: never on its tarmac, whatever the
    // way's grade where it meets the street)
    let k = ord[0] * 5, y = R[k + 2], gx = R[k + 3], gz = R[k + 4], prev = R[k];
    for (let a = 1; a < n; a++) { k = ord[a] * 5; const w = smoothstep(0, prev >= MINOR_RANK && R[k] < MINOR_RANK ? VERGE : BLEND, -R[k + 1]); prev = R[k]; y += (R[k + 2] - y) * w; gx += (R[k + 3] - gx) * w; gz += (R[k + 4] - gz) * w; }
    this.y = y; this.gx = gx; this.gz = gz;
  }
  // ground height with the road on it: the profile inside the footprint, then the embankment (the base surface
  // clamped to the side slopes from the footprint edge; a cutting from the bench's edge), fading back to the base
  // surface by the skirt's end.
  // Beside a city street the ground is its pavement and then the open ground beyond at the slabs' level (base is that
  // already: World.cityAt), not an embankment: up PAVE_RAMP metres from the footprint's edge to the slabs' top, then
  // by CITY_BAND to base (where base is more than a metre or so off the slabs, a real embankment or cutting or a park
  // lower down, the slopes as anywhere else). Several streets near (a junction's corner, between two streets at
  // different heights): each one's ramp and hand-over, weighted by how near it is (fading out by CITY_BAND), so there
  // is no step where one street's side meets another's; and never over a street's slabs.
  over(base) {
    const e = this.e; if (e <= 0) return this.y;
    const c = clamp(base, this.y - FILL * e, this.y + CUT * Math.max(0, e - this.B)), h = c + (base - c) * smoothstep(this.S * 0.6, this.S, e);
    if (!this.cs[this.k]) return h;
    const R = this.Out; let sw = 0, sp = 0, sk = 0, cap = Infinity, floor = -Infinity;
    for (let i = 0; i < this.nOut; i++) {
      const ei = R[i * 4 + 1], yi = R[i * 4 + 2], sl = R[i * 4 + 3], d = base - yi - CITY_TOP, w = (1 - smoothstep(CITY_BAND * 0.6, CITY_BAND, ei)) / ((ei + 0.5) * (ei + 0.5)), ramp = yi + CITY_TOP * smoothstep(0, PAVE_RAMP, ei);
      sw += w; sp += w * (ramp + d * smoothstep(PAVE_RAMP, CITY_BAND, ei)); sk += w * (1 - smoothstep(0.8, 1.6, Math.abs(d)));
      if (ei < SLAB + 1) cap = Math.min(cap, yi + CITY_TOP + 50 * smoothstep(SLAB, SLAB + 1, ei)); // (under a street's slabs: no higher than their top, whatever is beyond)
      if (ei < sl + 1) floor = Math.max(floor, ramp - 50 * smoothstep(sl, sl + 1, ei)); // (and no lower than its ramp up to them: where the ground beyond falls away, a cutting or a bank, it does so past the slabs, which lie on it, #228 042034)
    }
    if (sw < 1e-9) return h + (base - h) * (1 - smoothstep(0.8, 1.6, Math.abs(base - this.y - CITY_TOP))); // (past them all: the open ground itself)
    const r = Math.max(h + (sp / sw - h) * (sk / sw), floor);
    return r < cap ? r : cap;
  }
}
