// Joining a chunk's baked layout (format.js) and the natural ground around it into one surface: the stored points (roads,
// pavements, kerbs, embankments, the chunk's edge) and the hi grid's points outside them, a constrained Delaunay
// triangulation with the stored edges fixed. Pure (no three.js, no World): the game runs it in a worker (worker.js),
// the bake and the tests call it directly. Nothing here decides a shape: every height is a stored or a grid one.
//
// level 'fine': everything; each triangle gets its kind (format.js KIND) from the fixed edges around it.
// level 'coarse': the chunk's edge points (the same as the fine level's: neighbours always meet), every other grid
// point and one stored point per COARSE_CELL; only the chunk's edge fixed; every triangle ground (the roads far away
// are the imagery's).
import Delaunator from '../../vendor/layout/delaunator.js';
import Constrainautor from '../../vendor/layout/constrainautor.mjs';
import { KIND } from './format.js';

const COARSE_CELL = 8;

// L: a decoded chunk; grid: { x0, z0, sp } the hi grid; G: its heights at L.lat's points (Float32Array ni * nj).
// opts.classify(x, z) (the bake's): each triangle's kind from the regions at its middle, and back in ek each fixed
// edge's kinds either side as those triangles have them (what the flood below then reproduces from the file).
export function meshChunk(L, grid, G, level = 'fine', opts = {}) {
  const t0 = performance.now(), fine = level === 'fine', n = L.px.length, size = L.size * 100;
  const X = [], Z = [], Y = [], PY = [], src = []; // src: the layout point's index, or -1 - (grid point)
  const onEdge = (i) => L.px[i] === 0 || L.pz[i] === 0 || L.px[i] === size || L.pz[i] === size;
  const cells = new Set();
  for (let i = 0; i < n; i++) {
    if (!fine && !onEdge(i)) { const k = Math.floor(L.px[i] / (COARSE_CELL * 100)) * 4096 + Math.floor(L.pz[i] / (COARSE_CELL * 100)); if (cells.has(k)) continue; cells.add(k); }
    X.push(L.x0 + L.px[i] / 100); Z.push(L.z0 + L.pz[i] / 100); Y.push(L.py[i] / 1000); PY.push((L.py[i] + L.pdy[i]) / 1000); src.push(i);
  }
  const { i0, j0, ni, nj } = L.lat;
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
    const k = j * ni + i; if (L.mask[k >> 3] & (1 << (k & 7))) continue;
    if (!fine && ((i0 + i) % 2 || (j0 + j) % 2)) continue;
    const x = grid.x0 + (i0 + i) * grid.sp, z = grid.z0 + (j0 + j) * grid.sp; X.push(x); Z.push(z); Y.push(G[k]); PY.push(G[k]); src.push(-1 - k);
  }
  const N = X.length, coords = new Float64Array(N * 2); for (let k = 0; k < N; k++) { coords[k * 2] = X[k]; coords[k * 2 + 1] = Z[k]; }
  const del = new Delaunator(coords), t1 = performance.now();
  // the fixed edges: the layout's (fine) or the chunk's edge only (coarse)
  const at = new Map(); src.forEach((s, k) => { if (s >= 0) at.set(s, k); });
  const con = new Constrainautor(del), kinds = new Map(), edgeOf = new Map(), why = {}; let fixed = 0, failed = 0;
  for (let e = 0; e < L.ea.length; e++) {
    const a = at.get(L.ea[e]), b = at.get(L.eb[e]); if (a == null || b == null) continue;
    if (!fine && !(onEdge(L.ea[e]) && onEdge(L.eb[e]))) continue;
    try { con.constrainOne(a, b); fixed++; kinds.set(a * N + b, [L.ek[e * 2], L.ek[e * 2 + 1]]); edgeOf.set(Math.min(a, b) * N + Math.max(a, b), e); } catch (err) { failed++; const k = L.ek[e * 2] + '/' + L.ek[e * 2 + 1] + ' ' + String(err.message || err).slice(0, 24); why[k] = (why[k] || 0) + 1; }
  }
  const t2 = performance.now(), T = del.triangles, H = del.halfedges, nt = T.length / 3, tkind = new Uint8Array(nt).fill(fine ? 255 : KIND.ground);
  let ek = null;
  if (fine && opts.classify) { // (the bake: kinds from the regions themselves, and the edges' sides from them)
    for (let t = 0; t < nt; t++) { const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2]; tkind[t] = opts.classify((X[a] + X[b] + X[c]) / 3, (Z[a] + Z[b] + Z[c]) / 3); }
    ek = new Uint8Array(L.ea.length * 2).fill(KIND.out);
    for (let h = 0; h < T.length; h++) { const a = T[h], b = T[h % 3 === 2 ? h - 2 : h + 1], c = T[h % 3 === 0 ? h + 2 : h - 1], e = edgeOf.get(Math.min(a, b) * N + Math.max(a, b)); if (e == null) continue;
      const A = at.get(L.ea[e]), B = at.get(L.eb[e]), left = (X[B] - X[A]) * (Z[c] - Z[A]) - (Z[B] - Z[A]) * (X[c] - X[A]) > 0; ek[e * 2 + (left ? 0 : 1)] = tkind[Math.floor(h / 3)]; }
    // (edges between two kinds that aren't fixed: the bake fixes them, by the points' sources: >= 0 the layout's, < 0 the grid's)
    opts.cuts = []; for (let h = 0; h < T.length; h++) { const o = H[h]; if (o < h) continue; const a = T[h], b = T[h % 3 === 2 ? h - 2 : h + 1]; if (edgeOf.has(Math.min(a, b) * N + Math.max(a, b))) continue; if (tkind[Math.floor(h / 3)] !== tkind[Math.floor(o / 3)]) opts.cuts.push([src[a], src[b]]); }
  } else if (fine) { // each triangle's kind: from a fixed edge beside it, then across the edges that aren't fixed
    const queue = [];
    for (let e = 0; e < T.length; e++) {
      const a = T[e], b = T[e % 3 === 2 ? e - 2 : e + 1], c = T[e % 3 === 0 ? e + 2 : e - 1];
      const kk = kinds.get(a * N + b) || kinds.get(b * N + a); if (!kk) continue;
      const [ea, eb] = kinds.has(a * N + b) ? [a, b] : [b, a];
      const left = (X[eb] - X[ea]) * (Z[c] - Z[ea]) - (Z[eb] - Z[ea]) * (X[c] - X[ea]) > 0, k = left ? kk[0] : kk[1], t = Math.floor(e / 3);
      if (tkind[t] === 255 && k !== 255) { tkind[t] = k; queue.push(t); }
    }
    while (queue.length) { const t = queue.pop(); for (let q = 0; q < 3; q++) { const e = t * 3 + q, o = H[e]; if (o < 0) continue; const u = Math.floor(o / 3); if (tkind[u] !== 255) continue; const a = T[e], b = T[q === 2 ? e - 2 : e + 1]; if (kinds.has(a * N + b) || kinds.has(b * N + a)) continue; tkind[u] = tkind[t]; queue.push(u); } }
    for (let t = 0; t < nt; t++) if (tkind[t] === 255) tkind[t] = KIND.ground;
  }
  // buffers: drawn positions, physics heights, normals, road coordinates (u, v, hw, dj) and lanes
  const pos = new Float32Array(N * 3), phys = new Float32Array(N), road = new Float32Array(N * 4), lane = new Float32Array(N), nrm = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    pos[k * 3] = X[k]; pos[k * 3 + 1] = Y[k]; pos[k * 3 + 2] = Z[k]; phys[k] = PY[k]; const s = src[k];
    if (s >= 0 && L.rhw[s]) { road[k * 4] = L.ru[s]; road[k * 4 + 1] = L.rv[s] / 100; road[k * 4 + 2] = L.rhw[s] / 10; road[k * 4 + 3] = L.rdj[s] / 10; lane[k] = L.rl[s]; } else road[k * 4 + 3] = -1;
  }
  // sorted by kind: one draw group per kind
  const order = Array.from({ length: nt }, (_, t) => t).sort((a, b) => tkind[a] - tkind[b] || a - b), idx = new Uint32Array(nt * 3), tk = new Uint8Array(nt);
  order.forEach((t, q) => { // (wound so the face looks up: three.js draws only the front)
    const a = T[t * 3]; let b = T[t * 3 + 1], c = T[t * 3 + 2];
    if ((Z[c] - Z[a]) * (X[b] - X[a]) - (X[c] - X[a]) * (Z[b] - Z[a]) > 0) { const s = b; b = c; c = s; } // (the normal's y is minus this)
    idx[q * 3] = a; idx[q * 3 + 1] = b; idx[q * 3 + 2] = c; tk[q] = tkind[t]; });
  for (let q = 0; q < nt; q++) { // area-weighted vertex normals
    const a = idx[q * 3], b = idx[q * 3 + 1], c = idx[q * 3 + 2], ux = X[b] - X[a], uy = Y[b] - Y[a], uz = Z[b] - Z[a], vx = X[c] - X[a], vy = Y[c] - Y[a], vz = Z[c] - Z[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; for (const v of [a, b, c]) { nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz; }
  }
  for (let k = 0; k < N; k++) { const l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]) || 1; nrm[k * 3] /= l; nrm[k * 3 + 1] /= l; nrm[k * 3 + 2] /= l; if (nrm[k * 3 + 1] < 0) { nrm[k * 3] *= -1; nrm[k * 3 + 1] *= -1; nrm[k * 3 + 2] *= -1; } }
  let area = 0; for (let q = 0; q < nt; q++) { const a = idx[q * 3], b = idx[q * 3 + 1], c = idx[q * 3 + 2]; area += Math.abs((X[b] - X[a]) * (Z[c] - Z[a]) - (X[c] - X[a]) * (Z[b] - Z[a])) / 2; }
  return { level, pos, phys, nrm, road, lane, idx, tk, ek, stats: { points: N, tris: nt, fixed, failed, why, covered: area / (L.size * L.size), delaunayMs: t1 - t0, constrainMs: t2 - t1, totalMs: performance.now() - t0 } };
}

// physics lookup over a fine mesh: a grid of CELL-metre cells listing the triangles touching each
const CELL = 4;
export function physIndex(L, m) {
  const nc = Math.ceil(L.size / CELL), cnt = new Uint32Array(nc * nc + 1), P = m.pos, I = m.idx, nt = I.length / 3, box = (q) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let r = 0; r < 3; r++) { const v = I[q * 3 + r]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
    const c = (v, o) => Math.max(0, Math.min(nc - 1, Math.floor((v - o) / CELL))); return [c(x0, L.x0), c(x1, L.x0), c(z0, L.z0), c(z1, L.z0)]; };
  for (let q = 0; q < nt; q++) { const [a, b, c, d] = box(q); for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) cnt[j * nc + i + 1]++; }
  for (let k = 1; k < cnt.length; k++) cnt[k] += cnt[k - 1];
  const list = new Uint32Array(cnt[nc * nc]), fill = cnt.slice(0, nc * nc);
  for (let q = 0; q < nt; q++) { const [a, b, c, d] = box(q); for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) list[fill[j * nc + i]++] = q; }
  return { nc, start: cnt, list };
}
// the physics height at (x, z) on a chunk's fine mesh (NaN outside it); out (optional): [triangle, nx, ny, nz]
export function physAt(L, m, ix, x, z, out) {
  const fx = (x - L.x0) / CELL, fz = (z - L.z0) / CELL; if (!(fx >= 0 && fz >= 0 && fx < ix.nc && fz < ix.nc)) return NaN;
  const k = Math.floor(fz) * ix.nc + Math.floor(fx), P = m.pos, I = m.idx, Y = m.phys;
  for (let s = ix.start[k]; s < ix.start[k + 1]; s++) {
    const q = ix.list[s], a = I[q * 3], b = I[q * 3 + 1], c = I[q * 3 + 2], ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (d === 0) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2, E = -1e-7;
    if (l1 < E || l2 < E || l3 < E) continue;
    if (out) { const ux = bx - ax, uy = Y[b] - Y[a], uz = bz - az, vx = cx - ax, vy = Y[c] - Y[a], vz = cz - az; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; out[0] = q; out[1] = nx / l; out[2] = ny / l; out[3] = nz / l; }
    return l1 * Y[a] + l2 * Y[b] + l3 * Y[c];
  }
  return NaN;
}
