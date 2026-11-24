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
const SEG = 9, BLEND = 3; // RoadSurface: floats per segment; metres a major road hands over to a minor one in, at its edge

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
// Mark the cells an existing road runs through: routing along them is cheap, so new roads share its corridor and
// branch off where they need to (see trimShared).
export function markRoad(G, pts) {
  const { n, cell, x0 } = G; G.road = G.road || new Uint8Array(n * n);
  for (const p of pts) {
    const i0 = Math.round((p.x - x0) / cell), j0 = Math.round((p.z - x0) / cell);
    for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) if (i >= 0 && j >= 0 && i < n && j < n) G.road[j * n + i] = 1;
  }
}
const onRoad = (G, p) => { const i = Math.round((p.x - G.x0) / G.cell), j = Math.round((p.z - G.x0) / G.cell); return !!G.road?.[j * G.n + i]; };
// Drop the stretches of a routed path that run along existing roads (at its start and, if atEnd, its end).
export function trimShared(G, P, atEnd = true) {
  let a = 0, b = P.length - 1;
  while (a < b - 1 && onRoad(G, P[a + 1])) a++;
  while (atEnd && b > a + 1 && onRoad(G, P[b - 1])) b--;
  return P.slice(a, b + 1);
}
// re-read the heights in a box (towns flattened after the grid was made)
export function regrid(G, terr, x0, z0, x1, z1) {
  const c = (v) => clamp(Math.round((v - G.x0) / G.cell), 0, G.n - 1);
  for (let j = c(z0); j <= c(z1); j++) for (let i = c(x0); i <= c(x1); i++) G.h[j * G.n + i] = terr(G.x0 + i * G.cell, G.x0 + j * G.cell);
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

// The highest dry ground reachable from (ax,az) without any step steeper than gmax, within maxDist: where a
// switchback road can actually climb to. Returns a world point (y = its height) or null.
export function highestReachable(G, ax, az, gmax, maxDist, minDist = 0) {
  const { n, cell, x0, h, wet, block } = G, s = clamp(Math.round((az - x0) / cell), 0, n - 1) * n + clamp(Math.round((ax - x0) / cell), 0, n - 1);
  const seen = new Uint8Array(n * n), q = [s]; seen[s] = 1; let best = -1;
  while (q.length) {
    const k = q.pop(), i = k % n, j = (k / n) | 0, d = Math.hypot(x0 + i * cell - ax, x0 + j * cell - az);
    if (d >= minDist && !wet[k] && (best < 0 || h[k] > h[best])) best = k;
    for (let e = 0; e < 16; e++) {
      const ni = i + DIRS[e][0], nj = j + DIRS[e][1]; if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nk = nj * n + ni; if (seen[nk] || block[nk] || Math.abs(h[nk] - h[k]) > gmax * DLEN[e] * cell) continue;
      if (Math.hypot(x0 + ni * cell - ax, x0 + nj * cell - az) > maxDist) continue;
      seen[nk] = 1; q.push(nk);
    }
  }
  return best < 0 ? null : new THREE.Vector3(x0 + (best % n) * cell, h[best], x0 + ((best / n) | 0) * cell);
}

// Cut out loops: where a path comes back within d of where it was a little earlier (routes joined at a waypoint).
export function unloop(P, d, win = 40) {
  const out = P.slice();
  for (let i = 0; i < out.length; i++) for (let j = Math.min(out.length - 1, i + win); j > i + 2; j--) {
    if ((out[i].x - out[j].x) ** 2 + (out[i].z - out[j].z) ** 2 < d * d) { out.splice(i + 1, j - i - 1); break; }
  }
  return out;
}
// Where polyline A crosses polyline B (B already has its heights): [{ i: index on A, y: B's height there }], so A can
// be pinned to meet B at grade.
export function crossings(A, B, closedB = false) {
  const out = [], m = B.length;
  for (let i = 0; i < A.length - 1; i++) {
    const p = A[i], q = A[i + 1];
    for (let j = 0; j < (closedB ? m : m - 1); j++) {
      const r = B[j], s = B[(j + 1) % m];
      if (Math.max(r.x, s.x) < Math.min(p.x, q.x) || Math.min(r.x, s.x) > Math.max(p.x, q.x) || Math.max(r.z, s.z) < Math.min(p.z, q.z) || Math.min(r.z, s.z) > Math.max(p.z, q.z)) continue;
      const d1x = q.x - p.x, d1z = q.z - p.z, d2x = s.x - r.x, d2z = s.z - r.z, den = d1x * d2z - d1z * d2x; if (Math.abs(den) < 1e-9) continue;
      const t = ((r.x - p.x) * d2z - (r.z - p.z) * d2x) / den, u = ((r.x - p.x) * d1z - (r.z - p.z) * d1x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push({ i: t < 0.5 ? i : i + 1, y: r.y + (s.y - r.y) * u });
    }
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
export function simplifyPath(P, tol) { return simplify(P, tol); }
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
    if (k < n0) { t[k] = o.terr(p.x, p.z); wet[k] = o.wetAt(p.x, p.z, t[k]) ? 1 : 0; } else { t[k] = t[idx(k)]; wet[k] = wet[idx(k)]; }
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
    for (let k = 0; k < n; k++) W[k] = wet[k] ? Math.max(t[k], o.wl) + o.clear : o.wl + 1;
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
    const sp = pin.s ?? s[pin.i], m = PS.find((q) => Math.abs(q.s - sp) < 2);
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
export function carveGrid(w, roads, H, R, st, bench = 0.75) {
  const W = R + 1, half = w.half, wl = w.waterLevel, N = W * W;
  const bd = new Float32Array(N).fill(Infinity), by = new Float32Array(N);
  const reach = st * bench + 46;
  for (const rd of roads) {
    const hw = rd.width / 2 + VERGE, P = rd.pts, rr = Math.ceil((hw + reach) / st);
    for (let i = 0; i < P.length; i++) {
      if (rd.bridge?.[i]) continue;
      const p = P[i], i0 = Math.round((p.x + half) / st), j0 = Math.round((p.z + half) / st);
      for (let j = j0 - rr; j <= j0 + rr; j++) for (let ii = i0 - rr; ii <= i0 + rr; ii++) {
        if (ii < 0 || j < 0 || ii > R || j > R) continue;
        const e = Math.hypot(-half + ii * st - p.x, -half + j * st - p.z) - hw, k = j * W + ii;
        if (e < bd[k] && e < reach) { bd[k] = e; by[k] = p.y; }
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
  pinUnder(w, roads, H, R, st);
}
// push grid vertices down wherever the triangulated surface would rise above a road's footprint
function pinUnder(w, roads, H, R, st) {
  const W = R + 1, half = w.half;
  const lower = (k, y) => { if (H[k] > y) H[k] = y; };
  for (let pass = 0; pass < 2; pass++) for (const rd of roads) {
    const P = rd.pts, n = P.length, hw = rd.width / 2 + VERGE;
    for (let i = 0; i < n; i++) {
      if (rd.bridge?.[i]) continue;
      const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      for (const f of [-1, -0.5, 0, 0.5, 1]) for (const al of [-2, 2]) {
        const x = p.x - dz * hw * f + dx * al, z = p.z + dx * hw * f + dz * al;
        const fx = (x + half) / st, fz = (z + half) / st; if (fx < 0 || fz < 0 || fx >= R || fz >= R) continue;
        const ii = fx | 0, j = fz | 0, u = fx - ii, v = fz - j, y = p.y - 0.05;
        const ka = j * W + ii, kb = ka + W, kc = kb + 1, kd = ka + 1; // triangles (a,b,d) + (b,c,d), as World.triAt
        const val = u + v <= 1 ? H[ka] + (H[kd] - H[ka]) * u + (H[kb] - H[ka]) * v : H[kc] + (H[kb] - H[kc]) * (1 - u) + (H[kd] - H[kc]) * (1 - v);
        if (val <= y) continue;
        if (u + v <= 1) { lower(ka, y); lower(kb, y); lower(kd, y); } else { lower(kb, y); lower(kc, y); lower(kd, y); }
      }
    }
  }
}

// ---------------- the surface physics reads ----------------
// Segment index over all roads (and rail) on the ground, plus bridge decks. q(x,z,deck) finds the segment whose
// footprint edge is nearest: sets .y (road height there), .e (distance beyond the footprint edge, <= 0 inside),
// .g (grade along it, signed by dx/dz) and returns true; false when no road is within reach.
export class RoadSurface {
  constructor(w, roads, skirt) {
    this.half = w.half; this.S = skirt; this.cell = 32;
    const C = this.cell, nC = (this.nC = Math.ceil(w.size / C) + 1);
    const segs = []; // ax, az, bx, bz, ay, by, hw, deck, rank (the order the profiles were made in: lower = the major road)
    roads.forEach((rd, ri) => {
      const P = rd.pts, n = P.length, last = rd.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = P[i], b = P[(i + 1) % n], br = !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % n]);
        // deck flags: 1 = deck, +2 / +4 = the deck carries on before / after (a joint, round; an abutment end is square)
        const isD = (k) => !!(rd.bridge?.[(k + n) % n] && rd.bridge?.[(k + 1 + n) % n]) && (rd.closed || (k >= 0 && k < n - 1));
        segs.push(a.x, a.z, b.x, b.z, a.y, b.y, br ? rd.width / 2 + 1 : rd.width / 2 + VERGE, br ? 1 + (isD(i - 1) ? 2 : 0) + (isD(i + 1) ? 4 : 0) : 0, rd.rank ?? ri);
      }
    });
    const S = (this.seg = new Float32Array(segs)), ns = S.length / SEG;
    const cnt = new Int32Array(nC * nC + 1), cells = (s, fn) => {
      const r = S[s * SEG + 6] + (S[s * SEG + 7] ? 0.5 : skirt) + 1;
      const o = s * SEG, xa = Math.min(S[o], S[o + 2]) - r, xb = Math.max(S[o], S[o + 2]) + r, za = Math.min(S[o + 1], S[o + 3]) - r, zb = Math.max(S[o + 1], S[o + 3]) + r;
      for (let cj = Math.max(0, Math.floor((za + this.half) / C)); cj <= Math.min(nC - 1, Math.floor((zb + this.half) / C)); cj++)
        for (let ci = Math.max(0, Math.floor((xa + this.half) / C)); ci <= Math.min(nC - 1, Math.floor((xb + this.half) / C)); ci++) fn(cj * nC + ci);
    };
    for (let s = 0; s < ns; s++) cells(s, (c) => cnt[c + 1]++);
    for (let c = 0; c < nC * nC; c++) cnt[c + 1] += cnt[c];
    const ids = new Int32Array(cnt[nC * nC]), fill = cnt.slice();
    for (let s = 0; s < ns; s++) cells(s, (c) => (ids[fill[c]++] = s));
    this.start = cnt; this.ids = ids;
    this.y = 0; this.e = 0; this.g = 0; this.In = new Float64Array(40); this.ord = new Int32Array(8); this.nIn = 0;
  }
  // deck: bridge decks only, and where decks cross (an overpass) the highest one not above y + 2 (any, without y)
  q(x, z, deck = false, y = Infinity) {
    const C = this.cell, ci = Math.floor((x + this.half) / C), cj = Math.floor((z + this.half) / C), nC = this.nC;
    if (ci < 0 || cj < 0 || ci >= nC || cj >= nC) return false;
    const c = cj * nC + ci, a = this.start[c], b = this.start[c + 1];
    if (a === b) return false;
    const S = this.seg, want = deck ? 1 : 0; this.nIn = 0;
    let best = deck ? 0.5 : this.S, top = -Infinity, hit = false; // (decks: best = e of the current pick)
    for (let k = a; k < b; k++) {
      const o = this.ids[k] * SEG, f = S[o + 7]; if ((f & 1) !== want) continue;
      const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, L2 = dx * dx + dz * dz || 1;
      const t0 = ((x - ax) * dx + (z - az) * dz) / L2; if (deck && ((t0 < -0.01 && !(f & 2)) || (t0 > 1.01 && !(f & 4)))) continue; // decks end square at their abutments
      const t = clamp(t0, 0, 1), px = ax + dx * t - x, pz = az + dz * t - z;
      const e = Math.sqrt(px * px + pz * pz) - S[o + 6], yy = S[o + 4] + (S[o + 5] - S[o + 4]) * t;
      // decks: the nearest centreline on the same level; a deck a level up (an overpass) wins outright
      if (!deck && e < 0) this.inside(S[o + 8], e, yy, (S[o + 5] - S[o + 4]) * dx / L2, (S[o + 5] - S[o + 4]) * dz / L2);
      if (deck ? e < 0.5 && yy < y + 2 && (!hit || yy > top + 2.5 || (yy > top - 2.5 && e < best)) : e < best) {
        best = e; top = yy; hit = true; this.y = yy; this.e = e; this.gx = (S[o + 5] - S[o + 4]) * dx / L2; this.gz = (S[o + 5] - S[o + 4]) * dz / L2;
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
  blend() {
    const R = this.In, n = this.nIn, ord = this.ord; for (let k = 0; k < n; k++) ord[k] = k;
    for (let a = 1; a < n; a++) { const v = ord[a]; let b = a - 1; while (b >= 0 && R[ord[b] * 5] < R[v * 5]) { ord[b + 1] = ord[b]; b--; } ord[b + 1] = v; } // minor first
    let k = ord[0] * 5, y = R[k + 2], gx = R[k + 3], gz = R[k + 4];
    for (let a = 1; a < n; a++) { k = ord[a] * 5; const w = smoothstep(0, BLEND, -R[k + 1]); y += (R[k + 2] - y) * w; gx += (R[k + 3] - gx) * w; gz += (R[k + 4] - gz) * w; }
    this.y = y; this.gx = gx; this.gz = gz;
  }
  // ground height with the road on it: the profile inside the footprint, then the embankment (the base surface
  // clamped to the side slopes from the footprint edge), fading back to the base surface by the skirt's end
  over(base) {
    const e = this.e; if (e <= 0) return this.y;
    const c = clamp(base, this.y - FILL * e, this.y + CUT * e);
    return c + (base - c) * smoothstep(this.S * 0.6, this.S, e);
  }
}
