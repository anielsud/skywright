// Ground contact against built structures (stunt ramps, loops, banked turns...), on top of the terrain height query.
//
// A CollisionMesh is a triangle soup in a dense 3D grid (built once): wheel rays and hull points only test the
// triangles in the few cells they touch. Triangles are one-sided: the normal points out of the solid, to the side you
// drive on, so a wheel ray hits a loop's deck from inside it, upside down, and never the back of anything.
// Every triangle has a depth: how far behind its face a point still counts as inside (a thin loop deck: its thickness;
// a ramp: about a metre), so hull points are pushed out of the nearest face.
//
// groundUnder() and groundAtPoint() are what the flight model calls: the terrain (env.groundAt) as before, and a
// structure's surface where one is nearer. Without structures nearby (env.surfRay/surfPoint return null) they return
// exactly what env.groundAt did, so physics away from structures is unchanged.
import * as THREE from 'three';

export const SURFACES = ['runway', 'sand', 'rock', 'grass', 'slick']; // surface types a triangle can have (ids index this; 'slick': a wet ramp a hull slides up (waterPark.js))

export class CollisionMesh {
  constructor(cell = 4) { this.cell = cell; this.raw = []; this.n = 0; }
  // add a triangle (corners copied); type: index into SURFACES; depth: metres behind the face that are still inside;
  // na/nb/nc (optional): smooth vertex normals, so wheels roll round a curved deck instead of bumping over its facets
  tri(a, b, c, type = 0, depth = 1, na = null, nb = null, nc = null) {
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z, e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-9) return; // degenerate
    nx /= l; ny /= l; nz /= l;
    this.raw.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, type, depth);
    for (const v of [na, nb, nc]) if (v && v.x * nx + v.y * ny + v.z * nz > 0.2) this.raw.push(v.x, v.y, v.z); else this.raw.push(nx, ny, nz);
    this.n++;
  }
  // Pack into typed arrays and bin every triangle (with the slab behind it) into the grid cells its box overlaps.
  build() {
    const n = this.n, R = this.raw, cs = this.cell, W = 20;
    const VN = (this.VN = new Float32Array(n * 9));
    const A = (this.A = new Float32Array(n * 3)), E1 = (this.E1 = new Float32Array(n * 3)), E2 = (this.E2 = new Float32Array(n * 3));
    const N = (this.N = new Float32Array(n * 3)), D = (this.D = new Float32Array(n)), T = (this.T = new Uint8Array(n));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], box = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const r = i * W;
      for (let k = 0; k < 9; k++) VN[i * 9 + k] = R[r + 11 + k];
      for (let k = 0; k < 3; k++) { A[i * 3 + k] = R[r + k]; E1[i * 3 + k] = R[r + 3 + k] - R[r + k]; E2[i * 3 + k] = R[r + 6 + k] - R[r + k]; }
      const e1 = [E1[i * 3], E1[i * 3 + 1], E1[i * 3 + 2]], e2 = [E2[i * 3], E2[i * 3 + 1], E2[i * 3 + 2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz; T[i] = R[r + 9]; D[i] = R[r + 10];
      const dep = D[i];
      for (let k = 0; k < 3; k++) {
        const nk = [nx, ny, nz][k];
        let mn = Infinity, mx = -Infinity;
        for (let c = 0; c < 3; c++) { const v = R[r + c * 3 + k]; mn = Math.min(mn, v, v - nk * dep); mx = Math.max(mx, v, v - nk * dep); }
        box[i * 6 + k] = mn; box[i * 6 + 3 + k] = mx; lo[k] = Math.min(lo[k], mn); hi[k] = Math.max(hi[k], mx);
      }
    }
    this.raw = null;
    if (!n) { this.lo = [0, 0, 0]; this.hi = [-1, -1, -1]; return this; }
    const o = (this.lo = lo.map((v) => v - 0.01)); this.hi = hi;
    const nx = (this.nx = Math.ceil((hi[0] - o[0]) / cs) + 1), ny = (this.ny = Math.ceil((hi[1] - o[1]) / cs) + 1), nz = (this.nz = Math.ceil((hi[2] - o[2]) / cs) + 1);
    const cnt = new Uint32Array(nx * ny * nz + 1);
    const each = (i, f) => {
      const b = i * 6, x0 = Math.floor((box[b] - o[0]) / cs), y0 = Math.floor((box[b + 1] - o[1]) / cs), z0 = Math.floor((box[b + 2] - o[2]) / cs);
      const x1 = Math.floor((box[b + 3] - o[0]) / cs), y1 = Math.floor((box[b + 4] - o[1]) / cs), z1 = Math.floor((box[b + 5] - o[2]) / cs);
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f((z * ny + y) * nx + x);
    };
    for (let i = 0; i < n; i++) each(i, (c) => cnt[c + 1]++);
    for (let c = 1; c < cnt.length; c++) cnt[c] += cnt[c - 1];
    const fill = cnt.slice(), items = new Uint32Array(cnt[cnt.length - 1]);
    for (let i = 0; i < n; i++) each(i, (c) => { items[fill[c]++] = i; });
    this.start = cnt; this.items = items; this.stamp = new Uint32Array(n); this.mark = 0;
    // highest structure per 2D column cell (World.maxGround: the flight model skips contacts well above it)
    const top = (this.top2 = new Float32Array(nx * nz).fill(-Infinity));
    for (let i = 0; i < n; i++) {
      const b = i * 6, x0 = Math.floor((box[b] - o[0]) / cs), z0 = Math.floor((box[b + 2] - o[2]) / cs), x1 = Math.floor((box[b + 3] - o[0]) / cs), z1 = Math.floor((box[b + 5] - o[2]) / cs);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) top[z * nx + x] = Math.max(top[z * nx + x], box[b + 4]);
    }
    return this;
  }
  // overlaps the box [x0..x1] x [y0..y1] x [z0..z1] the structures at all?
  near(x0, y0, z0, x1, y1, z1) { const lo = this.lo, hi = this.hi; return x1 >= lo[0] && x0 <= hi[0] && y1 >= lo[1] && y0 <= hi[1] && z1 >= lo[2] && z0 <= hi[2]; }
  // the highest structure over (x, z), or -Infinity
  topAt(x, z) {
    if (!this.top2) return -Infinity;
    const i = Math.floor((x - this.lo[0]) / this.cell), k = Math.floor((z - this.lo[2]) / this.cell);
    return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -Infinity : this.top2[k * this.nx + i];
  }
  // visit the triangles in the cells of a box (each once)
  cells(x0, y0, z0, x1, y1, z1, f) {
    const o = this.lo, cs = this.cell, nx = this.nx, ny = this.ny, nz = this.nz;
    const i0 = Math.max(0, Math.floor((x0 - o[0]) / cs)), j0 = Math.max(0, Math.floor((y0 - o[1]) / cs)), k0 = Math.max(0, Math.floor((z0 - o[2]) / cs));
    const i1 = Math.min(nx - 1, Math.floor((x1 - o[0]) / cs)), j1 = Math.min(ny - 1, Math.floor((y1 - o[1]) / cs)), k1 = Math.min(nz - 1, Math.floor((z1 - o[2]) / cs));
    if (i0 > i1 || j0 > j1 || k0 > k1) return;
    const m = ++this.mark, st = this.stamp, S = this.start, I = this.items;
    if (m === 0xffffffff) { st.fill(0); this.mark = 1; }
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = (k * ny + j) * nx + i;
      for (let q = S[c]; q < S[c + 1]; q++) { const t = I[q]; if (st[t] !== this.mark) { st[t] = this.mark; f(t); } }
    }
  }
  // Nearest front-face hit of the segment o + d*t, t in [0, len] (d unit). Returns { t, n, type } or null.
  ray(o, d, len, out = { t: 0, n: new THREE.Vector3(), type: '' }) {
    if (!this.start) return null;
    const ex = o.x + d.x * len, ey = o.y + d.y * len, ez = o.z + d.z * len;
    if (!this.near(Math.min(o.x, ex), Math.min(o.y, ey), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.y, ey), Math.max(o.z, ez))) return null;
    const A = this.A, E1 = this.E1, E2 = this.E2, N = this.N;
    let best = len, hit = -1, hu = 0, hv = 0;
    this.cells(Math.min(o.x, ex), Math.min(o.y, ey), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.y, ey), Math.max(o.z, ez), (i) => {
      const i3 = i * 3;
      if (d.x * N[i3] + d.y * N[i3 + 1] + d.z * N[i3 + 2] >= 0) return; // back face
      const e1x = E1[i3], e1y = E1[i3 + 1], e1z = E1[i3 + 2], e2x = E2[i3], e2y = E2[i3 + 1], e2z = E2[i3 + 2];
      const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x; // Möller-Trumbore
      const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) return;
      const inv = 1 / det, tx = o.x - A[i3], ty = o.y - A[i3 + 1], tz = o.z - A[i3 + 2];
      const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d.x * qx + d.y * qy + d.z * qz) * inv; if (v < 0 || u + v > 1) return;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t >= 0 && t < best) { best = t; hit = i; hu = u; hv = v; }
    });
    if (hit < 0) return null;
    const VN = this.VN, k = hit * 9, w0 = 1 - hu - hv;
    out.t = best; out.n.set(w0 * VN[k] + hu * VN[k + 3] + hv * VN[k + 6], w0 * VN[k + 1] + hu * VN[k + 4] + hv * VN[k + 7], w0 * VN[k + 2] + hu * VN[k + 5] + hv * VN[k + 8]).normalize();
    out.type = SURFACES[this.T[hit]] || 'runway';
    return out;
  }
  // Is p inside a structure (behind a face, within its depth, over the face)? The shallowest such face:
  // { pen, n, type } (pen: how far to push p out along n), or null.
  point(p, out = { pen: 0, n: new THREE.Vector3(), type: '' }) {
    if (!this.start || !this.near(p.x, p.y, p.z, p.x, p.y, p.z)) return null;
    const A = this.A, E1 = this.E1, E2 = this.E2, N = this.N, D = this.D;
    let best = Infinity, hit = -1;
    this.cells(p.x, p.y, p.z, p.x, p.y, p.z, (i) => {
      const i3 = i * 3, nx = N[i3], ny = N[i3 + 1], nz = N[i3 + 2];
      const wx = p.x - A[i3], wy = p.y - A[i3 + 1], wz = p.z - A[i3 + 2];
      const s = wx * nx + wy * ny + wz * nz;
      if (s >= 0 || s < -D[i] || -s >= best) return;
      // barycentric coordinates of p projected onto the face
      const e1x = E1[i3], e1y = E1[i3 + 1], e1z = E1[i3 + 2], e2x = E2[i3], e2y = E2[i3 + 1], e2z = E2[i3 + 2];
      const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z;
      const d20 = wx * e1x + wy * e1y + wz * e1z, d21 = wx * e2x + wy * e2y + wz * e2z, den = d00 * d11 - d01 * d01;
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v < 0 || w < 0 || v + w > 1) return;
      best = -s; hit = i;
    });
    if (hit < 0) return null;
    // Behind a face is not enough: p must be nearer to a face it is behind than to any face it is in front of. Riding up
    // a kicker, the bike's belly is just above the sloped top but behind the lip's end face (within its depth): without
    // this it counted as ~1 m inside the ramp and was shoved back along the lip's normal (the "glitch" jolts).
    let outside = false;
    this.cells(p.x - best, p.y - best, p.z - best, p.x + best, p.y + best, p.z + best, (i) => {
      if (outside) return;
      const i3 = i * 3, wx = p.x - A[i3], wy = p.y - A[i3 + 1], wz = p.z - A[i3 + 2];
      const s = wx * N[i3] + wy * N[i3 + 1] + wz * N[i3 + 2];
      if (s < 0 || s >= best) return;
      const e1x = E1[i3], e1y = E1[i3 + 1], e1z = E1[i3 + 2], e2x = E2[i3], e2y = E2[i3 + 1], e2z = E2[i3 + 2];
      const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z;
      const d20 = wx * e1x + wy * e1y + wz * e1z, d21 = wx * e2x + wy * e2y + wz * e2z, den = d00 * d11 - d01 * d01;
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v >= 0 && w >= 0 && v + w <= 1) outside = true;
    });
    if (outside) return null;
    out.pen = best; out.n.set(N[hit * 3], N[hit * 3 + 1], N[hit * 3 + 2]); out.type = SURFACES[this.T[hit]] || 'runway';
    return out;
  }
}

const _o = new THREE.Vector3();
const LIFT = 0.4; // wheel rays start this far above the strut top, so a fully compressed wheel still finds the deck it sits on
// What a wheel strut from `top` along `down` (unit, world) stands on within `reach`: env.groundAt's result plus
// d (distance along the strut to the surface). A structure's surface wins where it is nearer than the terrain.
export function groundUnder(env, top, down, reach) {
  const g = env.groundAt(top.x, top.z, top.y);
  const cosd = Math.max(0.35, -down.dot(g.n));
  g.d = (top.y - g.h) / cosd;
  if (env.surfRay) {
    const lim = Math.min(g.d, reach) + LIFT;
    if (lim > 0) {
      const s = env.surfRay(_o.copy(top).addScaledVector(down, -LIFT), down, lim);
      // (a face nearly side-on to the strut, the riser of a step or a ramp's side, is no ground to stand on: a wheel ray
      // clipping it read as a landing at the full closing speed and snapped the gear (a bike at a 24 cm step onto the
      // canyon jump's run-up, at 33 m/s). The body's hull points meet such faces as a hit instead.)
      if (s && -down.dot(s.n) > 0.35) { g.d = s.t - LIFT; g.n = s.n.clone(); g.type = s.type; g.stunt = true; }
    }
  }
  return g;
}
// The ground for a hull point p: env.groundAt's result, or, where p is inside a structure, a stand-in whose h puts the
// penetration (h - p.y) right and whose n is the face's normal (g.stunt = true; push p out along n, not up).
// Under water a structure still counts: the foot of a floating ramp (waterPark.js) or a slipway is solid below the surface.
export function groundAtPoint(env, p) {
  const g = env.groundAt(p.x, p.z, p.y);
  if ((p.y <= g.h && g.type !== 'water') || !env.surfPoint) return g;
  const s = env.surfPoint(p);
  return s ? { h: p.y + s.pen, n: s.n.clone(), type: s.type, stunt: true } : g;
}
