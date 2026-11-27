// Conservative occlusion culling on the CPU (realCity.js CityScenery.occlude): near the ground most of a city's
// building meshes in the frustum are behind the buildings nearest the camera (tools/test/jobs/bldcull.js: 86-97% of
// their triangles at street level). Each frame, boxes inscribed in the nearest buildings (occluders: wholly inside
// their walls) are drawn into a coarse depth buffer, and a mesh whose bounds are behind them at every pixel they
// cover on screen is taken off the main camera's layers (OCC_LAYER: still drawn into the shadow maps).
//
// Conservative throughout, so nothing that could be seen is hidden:
//  - an occluder covers a pixel only if the rays through all four of its corners hit the box (the rays that hit a
//    convex box from outside it form a convex cone: then every ray through the pixel does), and its depth there is
//    the farthest of the four entry depths (the entry depth is the largest of the front faces' plane depths, each of
//    which over a pixel is largest at a corner);
//  - a mesh is hidden only if every pixel of its bounds' screen rectangle (rounded outwards) holds an occluder
//    nearer than the nearest corner of its bounds; bounds reaching the camera's near plane are never hidden.

export const OCC_LAYER = 3; // (cascades.js has 2: NEAR_SHADOW)
export const BW = 128, BH = 64; // the depth buffer (pixels)

// The largest box (in b's frame: b = obb(P)) found inside footprint P minus holes, its sides `shrink` m inside the
// walls at least: a near-rectangle its own box cut back; else the footprint's inside sampled on a grid of up to 32 x 32 cells, the largest rectangle of cells
// inside, cut back by shrink and a cell (a cell's centre inside doesn't make the whole cell inside), then checked
// exactly (corners inside, no wall crossing it). null if nothing worth having (under 3 m across) or the check fails.
export function inscribedBox(P, holes, b, shrink = 2) {
  const { cx, cz, ux, uz, hl, hw } = b;
  if (hw - shrink < 1.5) return null;
  const rings = [P, ...holes].map((R) => R.map((p) => [(p[0] - cx) * ux + (p[1] - cz) * uz, -(p[0] - cx) * uz + (p[1] - cz) * ux]));
  // (most are near-rectangles: their own box cut back, if that passes the check)
  if (!holes.length && rectInside(rings, -hl + shrink, hl - shrink, -hw + shrink, hw - shrink)) return { cx, cz, ux, uz, hl: hl - shrink, hw: hw - shrink };
  const cell = Math.max(0.5, (2 * hl) / 32, (2 * hw) / 32), nu = Math.max(1, Math.ceil((2 * hl) / cell)), nv = Math.max(1, Math.ceil((2 * hw) / cell));
  const hgt = new Int32Array(nu), xs = [];
  let best = 0, bi0 = 0, bi1 = 0, bj0 = 0, bj1 = 0;
  const st = new Int32Array(nu + 1);
  for (let j = 0; j < nv; j++) {
    const v = -hw + (j + 0.5) * cell; xs.length = 0;
    for (const R of rings) for (let k = 0, n = R.length; k < n; k++) { const a = R[k], c = R[(k + 1) % n]; if ((a[1] > v) !== (c[1] > v)) xs.push(a[0] + ((v - a[1]) * (c[0] - a[0])) / (c[1] - a[1])); }
    xs.sort((p, q) => p - q);
    let s = 0;
    for (let i = 0; i < nu; i++) {
      const u = -hl + (i + 0.5) * cell;
      while (s < xs.length && xs[s] <= u) s++;
      hgt[i] = s & 1 ? hgt[i] + 1 : 0; // (inside: an odd number of crossings to its left)
    }
    // the largest rectangle under this row's histogram (a stack of rising heights)
    let sp = 0;
    for (let i = 0; i <= nu; i++) {
      const h = i < nu ? hgt[i] : 0;
      while (sp && hgt[st[sp - 1]] >= h) {
        const top = hgt[st[--sp]], left = sp ? st[sp - 1] + 1 : 0, w = i - left;
        const ar = Math.max(0, top * cell - 2 * (shrink + cell)) * Math.max(0, w * cell - 2 * (shrink + cell)); // (scored as it will be cut back)
        if (ar > best) { best = ar; bi0 = left; bi1 = i; bj1 = j + 1; bj0 = j + 1 - top; }
      }
      st[sp++] = i;
    }
  }
  if (!best) return null;
  const m = shrink + cell, u0 = -hl + bi0 * cell + m, u1 = -hl + bi1 * cell - m, v0 = -hw + bj0 * cell + m, v1 = -hw + bj1 * cell - m;
  if (u1 - u0 < 3 || v1 - v0 < 3) return null;
  if (!rectInside(rings, u0, u1, v0, v1)) return null;
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  return { cx: cx + um * ux - vm * uz, cz: cz + um * uz + vm * ux, ux, uz, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2 };
}
// rectangle [u0, u1] x [v0, v1] inside rings[0] and outside the others: its corners inside, no edge of any ring touching it
function rectInside(rings, u0, u1, v0, v1) {
  const inR = (R, x, z) => { let c = false; for (let i = 0, j = R.length - 1; i < R.length; j = i++) { const a = R[i], b = R[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  for (const [x, z] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) { if (!inR(rings[0], x, z)) return false; for (let h = 1; h < rings.length; h++) if (inR(rings[h], x, z)) return false; }
  for (const R of rings) for (let k = 0, n = R.length; k < n; k++) {
    const a = R[k], c = R[(k + 1) % n], dx = c[0] - a[0], dz = c[1] - a[1];
    let t0 = 0, t1 = 1, ok = true; // (Liang-Barsky: the part of the edge within the closed rectangle)
    for (const [p, q] of [[-dx, a[0] - u0], [dx, u1 - a[0]], [-dz, a[1] - v0], [dz, v1 - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p; if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (ok && t0 <= t1) return false;
  }
  return true;
}

// The depth buffer and its two operations: draw an occluder box, test a mesh's bounds. Depths are view-space depths
// (metres along the camera's axis); a pixel holds the nearest occluder's (Infinity: none).
export class OcclusionBuffer {
  constructor() {
    this.depth = new Float32Array(BW * BH);
    this.E = new Float32Array((BW + 1) * (BH + 1)); // an occluder's entry depth through each pixel corner (scratch)
    this.rx = new Float32Array(BW + 1); this.ry = new Float32Array(BH + 1); // each pixel corner's ray: (rx, ry, -1) in view space
    this.V = new Float64Array(16); this.P = new Float64Array(16); this.near = 0.1;
    this.v = new Float64Array(24); // (8 corners in view space: scratch)
    this.stats = { occluders: 0, corners: 0, pixels: 0, tested: 0, hidden: 0 };
  }
  begin(cam) {
    this.V.set(cam.matrixWorldInverse.elements); this.P.set(cam.projectionMatrix.elements); this.near = cam.near;
    const P = this.P; // (ndc x = P0 x - P8 for z = -1: three's perspective matrix, view offsets included)
    for (let i = 0; i <= BW; i++) this.rx[i] = (-1 + (2 * i) / BW + P[8]) / P[0];
    for (let j = 0; j <= BH; j++) this.ry[j] = (-1 + (2 * j) / BH + P[9]) / P[5];
    this.depth.fill(Infinity);
    const s = this.stats; s.occluders = s.corners = s.pixels = s.tested = s.hidden = 0;
  }
  // the screen rectangle (pixel corners, clamped) of the view-space points v[0..3n): null if none in front of the near
  // plane. With `clip` (a box's 8 corners, three.js Box3 corner order): its edges cut at the near plane count too.
  rect(n, clip) {
    const v = this.v, P = this.P, zn = -this.near;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, any = false;
    const add = (x, y, z) => { const w = -z, px = (((P[0] * x + P[8] * z) / w + 1) * BW) / 2, py = (((P[5] * y + P[9] * z) / w + 1) * BH) / 2; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; any = true; };
    for (let k = 0; k < n; k++) if (v[k * 3 + 2] < zn) add(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
    if (clip) for (const [a, b] of EDGES) {
      const za = v[a * 3 + 2], zb = v[b * 3 + 2]; if ((za < zn) === (zb < zn)) continue;
      const t = (zn - za) / (zb - za); add(v[a * 3] + (v[b * 3] - v[a * 3]) * t, v[a * 3 + 1] + (v[b * 3 + 1] - v[a * 3 + 1]) * t, zn);
    }
    return any ? [x0, x1, y0, y1] : null;
  }
  // an oriented box: centre (x, y, z), horizontal axis (ux, uz), half sizes hl (along it), hw (across), hh (up).
  // Returns the pixels it wrote (0: off screen, or the camera inside it).
  box(x, y, z, ux, uz, hl, hw, hh) {
    const V = this.V, v = this.v;
    // centre and axes in view space
    const cx = V[0] * x + V[4] * y + V[8] * z + V[12], cy = V[1] * x + V[5] * y + V[9] * z + V[13], cz = V[2] * x + V[6] * y + V[10] * z + V[14];
    const ax = [V[0] * ux + V[8] * uz, V[1] * ux + V[9] * uz, V[2] * ux + V[10] * uz], bx = [-V[0] * uz + V[8] * ux, -V[1] * uz + V[9] * ux, -V[2] * uz + V[10] * ux], up = [V[4], V[5], V[6]];
    const A = [ax, bx, up], Hs = [hl, hw, hh], cc = A.map((a) => a[0] * cx + a[1] * cy + a[2] * cz);
    if (Math.abs(cc[0]) <= hl && Math.abs(cc[1]) <= hw && Math.abs(cc[2]) <= hh) return 0; // (the camera's inside it)
    let k = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      v[k++] = cx + ax[0] * hl * sx + bx[0] * hw * sz + up[0] * hh * sy; v[k++] = cy + ax[1] * hl * sx + bx[1] * hw * sz + up[1] * hh * sy; v[k++] = cz + ax[2] * hl * sx + bx[2] * hw * sz + up[2] * hh * sy;
    }
    const r = this.rect(8, true); if (!r) return 0;
    const i0 = Math.max(0, Math.ceil(r[0])), i1 = Math.min(BW, Math.floor(r[1])), j0 = Math.max(0, Math.ceil(r[2])), j1 = Math.min(BH, Math.floor(r[3]));
    if (i1 <= i0 || j1 <= j0) return 0; // (no whole pixel)
    const E = this.E, rx = this.rx, ry = this.ry, near = this.near, W1 = BW + 1;
    const a0x = ax[0], a0y = ax[1], a0z = ax[2], a1x = bx[0], a1y = bx[1], a1z = bx[2], a2x = up[0], a2y = up[1], a2z = up[2];
    const c0 = cc[0], c1 = cc[1], c2 = cc[2];
    for (let j = j0; j <= j1; j++) {
      const ryj = ry[j];
      for (let i = i0; i <= i1; i++) {
        const dx = rx[i];
        let lo = -Infinity, hi = Infinity, d, p, q;
        // slab by slab: along axis a, the ray t (dx, ry, -1) is at t*d - c; inside where |t*d - c| <= h
        d = a0x * dx + a0y * ryj - a0z; if (d > 1e-9 || d < -1e-9) { p = (c0 - hl) / d; q = (c0 + hl) / d; if (p > q) { const s = p; p = q; q = s; } if (p > lo) lo = p; if (q < hi) hi = q; } else if (Math.abs(c0) > hl) hi = -Infinity;
        d = a1x * dx + a1y * ryj - a1z; if (d > 1e-9 || d < -1e-9) { p = (c1 - hw) / d; q = (c1 + hw) / d; if (p > q) { const s = p; p = q; q = s; } if (p > lo) lo = p; if (q < hi) hi = q; } else if (Math.abs(c1) > hw) hi = -Infinity;
        d = a2x * dx + a2y * ryj - a2z; if (d > 1e-9 || d < -1e-9) { p = (c2 - hh) / d; q = (c2 + hh) / d; if (p > q) { const s = p; p = q; q = s; } if (p > lo) lo = p; if (q < hi) hi = q; } else if (Math.abs(c2) > hh) hi = -Infinity;
        E[j * W1 + i] = lo <= hi && lo >= near ? lo : Infinity;
      }
    }
    const D = this.depth; let n = 0;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const e = j * W1 + i, m = Math.max(E[e], E[e + 1], E[e + W1], E[e + W1 + 1]);
      if (m < D[j * BW + i]) { D[j * BW + i] = m; n++; }
    }
    const s = this.stats; s.occluders++; s.corners += (i1 - i0 + 1) * (j1 - j0 + 1); s.pixels += n;
    return n;
  }
  // world-space boxes (flat: x0 y0 z0 x1 y1 z1, ...): every one behind the occluders at every pixel it covers?
  hidden(L) {
    this.stats.tested++;
    let on = false;
    for (let k = 0; k < L.length; k += 6) { const h = this.boxHidden(L, k); if (!h) return false; if (h === 1) on = true; }
    if (on) this.stats.hidden++;
    return on; // (all of it off screen: three's frustum test's business)
  }
  // 0: some of box o of b can be seen; 1: it's behind the occluders; 2: it's off screen
  boxHidden(b, o) {
    const V = this.V, v = this.v;
    let k = 0, dmin = Infinity;
    for (const x of [b[o], b[o + 3]]) for (const y of [b[o + 1], b[o + 4]]) for (const z of [b[o + 2], b[o + 5]]) {
      const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
      if (vz > -this.near) return 0; // (reaches the near plane: never)
      v[k++] = V[0] * x + V[4] * y + V[8] * z + V[12]; v[k++] = V[1] * x + V[5] * y + V[9] * z + V[13]; v[k++] = vz;
      if (-vz < dmin) dmin = -vz;
    }
    const r = this.rect(8, false);
    const i0 = Math.max(0, Math.floor(r[0])), i1 = Math.min(BW, Math.ceil(r[1])), j0 = Math.max(0, Math.floor(r[2])), j1 = Math.min(BH, Math.ceil(r[3]));
    if (i1 <= i0 || j1 <= j0) return 2;
    const D = this.depth;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if (!(D[j * BW + i] < dmin)) return 0;
    return 1;
  }
}
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]; // (corner k: bit 2 x, bit 1 y, bit 0 z)

// A mesh's bounds, tighter than one box round it all (a cell's one tower makes its box a tower over the whole cell):
// its triangles sorted into n x n columns of its box by their first corner, each column the box round its triangles
// (each triangle wholly in its column's box). From its positions and indices while they're still here (before upload):
// local boxes, flat [x0 y0 z0 x1 y1 z1, ...], the empty columns left out. Kept on the mesh (userData.occL).
export function binBounds(m, pos, idx, count, n) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < count; k++) { const v = idx[k] * 3, x = pos[v], z = pos[v + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const B = new Float64Array(n * n * 6); for (let b = 0; b < n * n; b++) B.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
  const sx = n / Math.max(1e-9, x1 - x0), sz = n / Math.max(1e-9, z1 - z0);
  for (let k = 0; k + 2 < count; k += 3) {
    const v0 = idx[k] * 3, b = (Math.min(n - 1, Math.floor((pos[v0] - x0) * sx)) * n + Math.min(n - 1, Math.floor((pos[v0 + 2] - z0) * sz))) * 6;
    for (let c = 0; c < 3; c++) {
      const v = idx[k + c] * 3;
      for (let a = 0; a < 3; a++) { const q = pos[v + a]; if (q < B[b + a]) B[b + a] = q; if (q > B[b + 3 + a]) B[b + 3 + a] = q; }
    }
  }
  const out = []; for (let b = 0; b < n * n; b++) if (B[b * 6] <= B[b * 6 + 3]) out.push(...B.subarray(b * 6, b * 6 + 6));
  m.userData.occL = out;
}
// ...in the world: [x0 y0 z0 x1 y1 z1] boxes, flat (computed once and kept: static meshes). Without binBounds' boxes,
// the geometry's box.
export function worldBounds(m) {
  if (m.userData.occB) return m.userData.occB;
  m.updateWorldMatrix(true, false);
  let L = m.userData.occL;
  if (!L) { const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox; L = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z]; }
  const e = m.matrixWorld.elements, out = new Float64Array(L.length);
  for (let k = 0; k < L.length; k += 6) { // (eight corners through the matrix: its box)
    let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
    for (const x of [L[k], L[k + 3]]) for (const y of [L[k + 1], L[k + 4]]) for (const z of [L[k + 2], L[k + 5]]) {
      const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (X < a0) a0 = X; if (X > b0) b0 = X; if (Y < a1) a1 = Y; if (Y > b1) b1 = Y; if (Z < a2) a2 = Z; if (Z > b2) b2 = Z;
    }
    out.set([a0, a1, a2, b0, b1, b2], k);
  }
  m.userData.occL = null;
  return (m.userData.occB = out);
}
// The shadow maps draw what the main camera's layers allow (three r170 WebGLShadowMap tests objects' layers against
// the camera being rendered, not the shadow camera): a mesh taken off the main camera by occlusion still casts its
// shadow, the camera's OCC_LAYER on for the shadow pass only. Once per renderer.
export function shadowsSeeOccluded(renderer) {
  const sm = renderer.shadowMap; if (sm.occWrapped) return;
  const f = sm.render; sm.occWrapped = true;
  sm.render = function (lights, scene, camera) {
    const had = camera.layers.isEnabled(OCC_LAYER); if (!had) camera.layers.enable(OCC_LAYER);
    try { f.call(this, lights, scene, camera); } finally { if (!had) camera.layers.disable(OCC_LAYER); }
  };
}
