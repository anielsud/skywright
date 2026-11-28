// A real city's buildings (New York): every OpenStreetMap building and building:part (© OpenStreetMap contributors,
// ODbL), baked by tools/realworld/city.py into a compact binary of footprints and heights (city.bin.gz, ~40 bytes a
// building; see city.py for the layout). Here they become meshes drawn with the towns' building kit (buildings.js:
// the facade atlas, interior-mapped windows lit at night), written straight into quantised typed arrays:
//  - tall buildings (>= 20 m, or big): the skyline. Built when the flight loads, merged per 2 km, sorted by height so
//    far away only the tallest are drawn (draw ranges). Setbacks and spires are the OSM building:parts.
//  - low buildings (houses, brownstones, walk-ups): built tile by tile (1 km) around the camera, a few ms per frame,
//    and dropped again behind it.
// Styles by height, age, material and use: glass curtain walls (reflective, floor lines), pre-war masonry towers,
// brick walk-ups and brownstones, clapboard houses with pitched roofs, warehouses; water towers and plant rooms on
// the roofs. Collisions: an oriented box per building.
import * as THREE from 'three';
import { STEP, slice } from './stepClock.js';
import { buildingMaterial, buildingDepthMaterial, furnMaterial, furnDepthMaterial, dmgAttr, C, facade, facadeSpec, floodlit, linHex, LY0, LYS } from './buildings.js';
import { toLocal } from './realworld.js';
import { OcclusionBuffer, OCC_LAYER, inscribedBox, binBounds, worldBounds, shadowsSeeOccluded } from './occlusion.js';
import { SNAP, chunkLines, linesIndex } from './layout/setbacks.js';
import { decodeLayout } from './layout/format.js';
import { roadIndex, LATER, setBack, holeInside, fitBox, footBoxes, boundBox, inParts, irregular, lazyParts, packRing, unpackRing, FOOT, MAJOR, streetWalls, PASSAGE, clip, intrusion, WORK, workSince, Refiner, fillBare } from './setback.js';

const PQ = 16; // GPU position units per metre: int16 positions relative to each mesh's centre (+-2 km, 6 cm steps)
const GROUP = 2; // tall buildings: the far ones drawn by height, by their distance to these GROUP x GROUP data tiles
const TALL_CELL = 500, LOW_CELL = 500; // (m) one mesh per cell (by a footprint's middle): culled each on its own
const FURN_CELL = 1000; // (m) roof furniture: an InstancedMesh per kind per FURN_CELL cell of a tall group (a low tile's: per tile), culled each on its own (FurnK)
const LOW_R = { low: 900, medium: 1600, high: 2400, ultra: 2600 }; // low buildings within this distance of the camera
const DENSE = 12; // tall buildings within ~300 m (CityScenery.dense): a built-up spot
const SUP = 25; // (m) the cells base() looks for what stands under a part in
const REACH = 24, FRONT = 40, CONE = 0; // (m) a wall facing a street within REACH of its pavement (CONE: setback.js streetWalls, out in front of it at any angle) is a street front (shop fronts, doors: the city's streets are drawn narrower than the real ones, and a forecourt or plaza can stand between); else the walls facing the nearest street within FRONT
// occlusion culling (occlude(), occlusion.js): with the camera within h m of the ground, the occluders within r m, at most
// max of them (the biggest on screen first) and about `corners` pixel corners' worth of rays a frame; low buildings
// occlude from lowA m2 of footprint (tall ones whatever their size)
export const OCC = { on: true, h: 150, r: 1000, max: 64, corners: 40000, lowA: 300 };
const LEVELS = [150, 70, 35, 0]; // tall meshes, sorted by height: a far mesh draws only buildings >= LEVELS[k] m
const LEVEL_D = { low: [5000, 3000, 1800], medium: [8000, 5000, 3000], high: [14000, 8000, 5000], ultra: [15000, 9000, 5500] };
// far meshes (CityScenery.farBuilding, made after load: farStep): a 500 m cell of tall buildings whose box is more than FAR.d m from the camera
// is drawn from a cheaper copy of its buildings: footprints simplified to FAR_TOL m (3/4 of a pixel at FAR.d, 1280 x
// 720, 60 degree view), no passages; its upright triangles sorted into SECT compass sectors by the way they face, so
// the sectors facing wholly away from the camera are left out of the draw range (back faces: never drawn anyway)
export const FAR = { d: 1000 }; const FAR_TOL = 1.2, SECT = 16; // (FAR.d: tools/test/jobs/bldfar.js draws the cells near, Infinity, to compare)
// the 2 km group meshes (drawn past the cells' range, 3.2 km and more at Low) from copies simplified to FAR_TOL_G (half
// a pixel at 3 km); room after a group's vertices for the copies' own, a share of its own count (a building whose copy
// doesn't fit is copied as it is: its sectors still left out)
const FAR_TOL_G = 2.4, FAR_ROOM = 0.22;
const FAR_NP = 24; // (farRec: numbers kept per building)
const FURN_D = { low: 1300, medium: 2400, high: 4000, ultra: 4500 }; // roof furniture (its instances, FurnK) drawn within this of a tall group
// roof furniture per tier: tank sides, rooftop units, hatches; both faces of a tank's stand (seen through it)
// (Low: no platform beams under a tank, no stair bulkheads on the walk-ups, which have no elevator)
const FURN = { low: { seg: 6, units: 0, hatch: 0, both: false, platform: false, stair: false, tanks: 0.75 }, medium: { seg: 8, units: 1, hatch: 1, both: false, platform: true, stair: true },
  high: { seg: 10, units: 2, hatch: 2, both: true, platform: true, stair: true }, ultra: { seg: 12, units: 3, hatch: 2, both: true, platform: true, stair: true } };
const half = THREE.DataUtils.toHalfFloat;
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ---------------- palettes (tints over the photo atlas cells) ----------------
const PAL = {
  brick: [0x9a6050, 0x8a5446, 0x8e6656, 0x7a4e42, 0xa88068, 0xa8947e, 0xc8bca8, 0x94604e, 0xd8d2c8],
  brown: [0x5e3426, 0x6c3e2c, 0x523024, 0x74462f], // (vertex colours are linear: these read as chocolate sandstone on the pale ashlar cell)
  lime: [0xe6dcc6, 0xd6c8ac, 0xcfc2a8, 0xe8e2d4, 0xc8bca4, 0xdcd4c4],
  glass: [0x8fb0c8, 0x7aa0a8, 0xb4c2cc, 0x5a6c7c, 0x9aaabb, 0x9fb4a8, 0x6f8aa8, 0xc0c8cc],
  concrete: [0xd0ccc4, 0xb8b4ac, 0xdcd8d0, 0xc4c0b6],
  siding: [0xeae6dc, 0xd8dce0, 0xe4d4b4, 0xc8d4c0, 0xf0e8e0, 0xd8c8b8],
  kiosk: [0x2e4a3a, 0x5a2420, 0x26304a, 0x2c2c2e, 0x6a5428, 0x3a3e42], // (a kiosk's frames and fascia: dark green, oxblood, navy, black, bronze, gunmetal)
  roofs: [0x5a5c60, 0x6a6c70, 0x7a6a5c, 0x6e4a3c, 0x4e5056],
};
// roofs and what stands on them (sRGB, as the photos show them: stored as MeshW's linear bytes)
const L = (a) => (Array.isArray(a) ? a.map(linHex) : linHex(a));
const ROOF = {
  membrane: L([0xd6d6d2, 0xcacac6, 0xdedcd6, 0xc2c6c8, 0xe2e2de]), silver: L([0xdcdcda, 0xcacac8, 0xbebebc]), tar: L([0x7a7876, 0x6a6866, 0x86827c]),
  gravel: L([0xd8d0c2, 0xc6beb0, 0xbab4a8]), pavers: L([0xcaa48c, 0xbca088, 0xd4c4ac]), green: L([0x8ca472, 0x9cb07c]),
  plant: L([0xc4c6c8, 0xb2b6b8, 0xd2d0cc]), unit: L([0xd8d8d4, 0xc8c8c4, 0xb8bab8]), screen: L(0xb4b8bc), hatch: L(0x4a4c4e), hatchLight: L(0xb8b8b4),
  copper: L([0x6c9c88, 0x5e8f7c, 0x78a896]), slate: L(0x55585e),
};
const TANK = { staves: L([0xf4f0e8, 0xe6ded2, 0xd8cab8, 0xfcfaf4, 0xd0c8be]), cone: L([0xb8987a, 0xa48a6c, 0x9a9a98, 0x7a7a78, 0xb0aca4]), steel: L(0x343434) };

// ---------------- mesh writer: the buildings.js vertex layout, quantised ----------------
export class MeshW {
  constructor(cx, cz, cap = 8192) { this.cx = cx; this.cz = cz; this.n = 0; this.ni = 0; this.cap = 0; this.idx = new Uint32Array(cap * 2); this.grow(cap); this.seed = 0; this.yg = 0; this.top = 0; this.late = false; this.lidx = new Uint32Array(1024); this.lni = 0; this.fw = null; }
  // Late triangles (roof furniture): their vertices go with the building's (one run, destruction.js), their indices
  // to a second list drawn after all the others, so a draw range can leave them out far away (CityScenery.update)
  setLate(on) { if (on === this.late) return; [this.idx, this.lidx] = [this.lidx, this.idx]; [this.ni, this.lni] = [this.lni, this.ni]; this.late = on; }
  grow(need) {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2), cp = (A, T, k) => { const b = new T(cap * k); if (A) b.set(A.subarray(0, this.n * k)); return b; };
    this.pos = cp(this.pos, Int16Array, 3); this.nor = cp(this.nor, Int8Array, 3); this.uv = cp(this.uv, Uint16Array, 2); this.col = cp(this.col, Uint8Array, 3); this.atl = cp(this.atl, Uint8Array, 4); this.cap = cap;
  }
  growI(k) { if (this.ni + k > this.idx.length) { const b = new Uint32Array(Math.max(this.ni + k, this.idx.length * 2)); b.set(this.idx); this.idx = b; } }
  color(hex) { this.cr = (hex >> 16) & 255; this.cg = (hex >> 8) & 255; this.cb = hex & 255; }
  v(x, y, z, nx, ny, nz, u, w, cell) {
    const i = this.n++, P = this.pos, N = this.nor, Cl = this.col, A = this.atl, U = this.uv, k = i * 3, a = i * 4;
    P[k] = Math.round((x - this.cx) * PQ); P[k + 1] = Math.round(y * PQ); P[k + 2] = Math.round((z - this.cz) * PQ);
    N[k] = nx * 127; N[k + 1] = ny * 127; N[k + 2] = nz * 127;
    U[i * 2] = half(u); U[i * 2 + 1] = half(w);
    Cl[k] = this.cr; Cl[k + 1] = this.cg; Cl[k + 2] = this.cb;
    A[a] = cell; A[a + 1] = this.seed; A[a + 2] = Math.max(0, Math.min(255, (y - this.yg + LY0) * LYS)); A[a + 3] = this.top;
    return i;
  }
  // room for k more vertices and m more indices (the checks inline: grow / growI only when it's full)
  room(k, m) { if (this.n + k > this.cap) this.grow(this.n + k); if (this.ni + m > this.idx.length) this.growI(m); }
  // vertical wall seen from outside, a -> b: u counts bays (from u0: a facade program's door is bay 0), v floors (from
  // yf, the floor datum)
  // (t0, t1: only that stretch of it, its bays where the whole wall's are: a wall broken by a passage)
  wall(ax, az, bx, bz, y0, y1, yf, cell, bay, fl, u0 = 0, t0 = 0, t1 = 1) {
    const L = Math.hypot(bx - ax, bz - az); if (L < 0.05 || y1 - y0 < 0.05 || (t1 - t0) * L < 0.05) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux, nb = Math.max(1, Math.round(L / bay)), v0 = (y0 - yf) / fl, v1 = (y1 - yf) / fl;
    // (a facade program's ground floor reads the height above the floor, atl.z, which stops 60 m up: a taller wall is
    // two quads, so the lower one's heights interpolate true)
    const ys = this.yg + 255 / LYS - LY0 - 4; if (y1 > ys + 1 && y0 < ys - 1 && facadeSpec(cell)?.gH > 0) { this.wall(ax, az, bx, bz, y0, ys, yf, cell, bay, fl, u0, t0, t1); this.wall(ax, az, bx, bz, ys, y1, yf, cell, bay, fl, u0, t0, t1); return; }
    if (this.n + 4 > this.cap) this.grow(this.n + 4); if (this.ni + 6 > this.idx.length) this.growI(6);
    const o = this.n, x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1, ua = u0 + nb * t0, ub = u0 + nb * t1;
    // the four corners written straight in (what v() writes: (x0, y0) (x1, y0) (x1, y1) (x0, y1), each value once)
    const P = this.pos, N = this.nor, U = this.uv, Cl = this.col, A = this.atl, k = o * 3, a = o * 4, w = o * 2;
    const px0 = Math.round((x0 - this.cx) * PQ), pz0 = Math.round((z0 - this.cz) * PQ), px1 = Math.round((x1 - this.cx) * PQ), pz1 = Math.round((z1 - this.cz) * PQ), py0 = Math.round(y0 * PQ), py1 = Math.round(y1 * PQ);
    P[k] = px0; P[k + 1] = py0; P[k + 2] = pz0; P[k + 3] = px1; P[k + 4] = py0; P[k + 5] = pz1; P[k + 6] = px1; P[k + 7] = py1; P[k + 8] = pz1; P[k + 9] = px0; P[k + 10] = py1; P[k + 11] = pz0;
    const qx = nx * 127, qz = nz * 127; for (let j = k; j < k + 12; j += 3) { N[j] = qx; N[j + 1] = 0; N[j + 2] = qz; }
    const ha = half(ua), hb = half(ub), h0 = half(v0), h1 = half(v1); U[w] = ha; U[w + 1] = h0; U[w + 2] = hb; U[w + 3] = h0; U[w + 4] = hb; U[w + 5] = h1; U[w + 6] = ha; U[w + 7] = h1;
    const cr = this.cr, cg = this.cg, cb = this.cb; for (let j = k; j < k + 12; j += 3) { Cl[j] = cr; Cl[j + 1] = cg; Cl[j + 2] = cb; }
    const l0 = Math.max(0, Math.min(255, (y0 - this.yg + LY0) * LYS)), l1 = Math.max(0, Math.min(255, (y1 - this.yg + LY0) * LYS)), sd = this.seed, tp = this.top;
    for (let j = 0; j < 4; j++) { const b = a + j * 4; A[b] = cell; A[b + 1] = sd; A[b + 2] = j < 2 ? l0 : l1; A[b + 3] = tp; }
    this.n = o + 4;
    const I = this.idx, i = this.ni; I[i] = o; I[i + 1] = o + 1; I[i + 2] = o + 2; I[i + 3] = o; I[i + 4] = o + 2; I[i + 5] = o + 3; this.ni += 6;
  }
  // any planar polygon (counter-clockwise from its front), uv in metres / s from its first point
  poly(P, cell, s = 3) {
    const n = P.length; if (n < 3) return;
    const a = P[0], b = P[1], c = P[n - 1];
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    // in-plane axes for the uv
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    this.room(n, (n - 2) * 3);
    const o = this.n;
    for (const p of P) { const dx = p[0] - a[0], dy = p[1] - a[1], dz = p[2] - a[2]; this.v(p[0], p[1], p[2], nx, ny, nz, (dx * tx + dy * ty + dz * tz) / s, (dx * bx + dy * by + dz * bz) / s, cell); }
    for (let k = 1; k < n - 1; k++) { const I = this.idx, j = this.ni; I[j] = o; I[j + 1] = o + k; I[j + 2] = o + k + 1; this.ni += 3; }
  }
  // a planar polygon with its own uvs (UV: [u, v] per point; counter-clockwise from its front)
  q(P, UV, cell) {
    const n = P.length, a = P[0], b = P[1], c = P[n - 1];
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.room(n, (n - 2) * 3);
    const o = this.n;
    for (let k = 0; k < n; k++) this.v(P[k][0], P[k][1], P[k][2], nx, ny, nz, UV[k][0], UV[k][1], cell);
    for (let k = 1; k < n - 1; k++) { const I = this.idx, j = this.ni; I[j] = o; I[j + 1] = o + k; I[j + 2] = o + k + 1; this.ni += 3; }
  }
  // a surface of revolution about the upright through (x, z): rows [radius, y, v, normal out, normal up] round seg
  // sides, smooth (the vertices shared round it and down it); u from 0 to uMax round it. apex: the last row is a point
  // (one vertex, its normal straight up)
  lathe(x, z, rows, seg, cell, uMax, apex = false) {
    const m = seg + 1, nr = rows.length - (apex ? 1 : 0); this.room(m * nr + 1, seg * (rows.length - 1) * 6);
    const o = this.n;
    for (let j = 0; j < nr; j++) { const [r, y, v, no, nu] = rows[j]; for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a); this.v(x + s * r, y, z + c * r, s * no, nu, c * no, (k / seg) * uMax, v, cell); } }
    if (apex) { const [, y, v] = rows[nr]; this.v(x, y, z, 0, 1, 0, uMax / 2, v, cell); }
    const I = this.idx;
    for (let j = 0; j < rows.length - 1; j++) for (let k = 0; k < seg; k++) {
      const a = o + j * m + k, b = a + m, i = this.ni;
      if (apex && j === nr - 1) { I[i] = a; I[i + 1] = a + 1; I[i + 2] = o + nr * m; this.ni += 3; } else { I[i] = a; I[i + 1] = a + 1; I[i + 2] = b + 1; I[i + 3] = a; I[i + 4] = b + 1; I[i + 5] = b; this.ni += 6; }
    }
  }
  // flat roof over a footprint (x, z pairs) with holes, at height y, facing up (down: a ceiling, facing down)
  roof(P, holes, y, cell, down = false) {
    let tris = !holes.length && earFast(P);
    if (!tris) {
      const ct = P.map((p) => new THREE.Vector2(p[0], p[1])), hs = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
      try { tris = THREE.ShapeUtils.triangulateShape(ct, hs).flat(); } catch (e) { return; }
    }
    const all = holes.length ? [...P, ...holes.flat()] : P, n = all.length, ox = P[0][0], oz = P[0][1], nt = tris.length;
    this.room(n, nt);
    const o = this.n, Pp = this.pos, N = this.nor, U = this.uv, Cl = this.col, A = this.atl, py = Math.round(y * PQ), ny = (down ? -1 : 1) * 127;
    const ly = Math.max(0, Math.min(255, (y - this.yg + LY0) * LYS)), cr = this.cr, cg = this.cg, cb = this.cb, sd = this.seed, tp = this.top;
    for (let j = 0; j < n; j++) { // (v(p[0], y, p[1], 0, +-1, 0, ...), written straight in)
      const p = all[j], i = o + j, k = i * 3, a = i * 4;
      Pp[k] = Math.round((p[0] - this.cx) * PQ); Pp[k + 1] = py; Pp[k + 2] = Math.round((p[1] - this.cz) * PQ);
      N[k] = 0; N[k + 1] = ny; N[k + 2] = 0;
      U[i * 2] = half((p[0] - ox) / 3); U[i * 2 + 1] = half((p[1] - oz) / 3);
      Cl[k] = cr; Cl[k + 1] = cg; Cl[k + 2] = cb;
      A[a] = cell; A[a + 1] = sd; A[a + 2] = ly; A[a + 3] = tp;
    }
    this.n = o + n;
    const I = this.idx;
    for (let t = 0; t < nt; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2], Aa = all[a], B = all[b], Cc = all[c], up = ((B[1] - Aa[1]) * (Cc[0] - Aa[0]) - (B[0] - Aa[0]) * (Cc[1] - Aa[1]) > 0) !== down;
      const j = this.ni; I[j] = o + a; I[j + 1] = o + (up ? b : c); I[j + 2] = o + (up ? c : b); this.ni += 3;
    }
  }
  // oriented box (centre, axis u, half sizes), sides + top
  box(cx, cz, ux, uz, hu, hn, y0, y1, cell, s = 3) {
    const nx = -uz, nz = ux, c = (a, b) => [cx + ux * a + nx * b, cz + uz * a + nz * b];
    const Q = [c(-hu, hn), c(hu, hn), c(hu, -hn), c(-hu, -hn)];
    for (let k = 0; k < 4; k++) { const p = Q[k], q = Q[(k + 1) % 4]; this.poly([[p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]], cell, s); }
    this.poly([[Q[0][0], y1, Q[0][1]], [Q[1][0], y1, Q[1][1]], [Q[2][0], y1, Q[2][1]], [Q[3][0], y1, Q[3][1]]], cell, s);
  }
  // upright frustum, seg sides, optional point / flat cap
  cyl(cx, cz, y0, y1, r0, r1, seg, cell, cap = false) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2, p = (a, r, y) => [cx + Math.sin(a) * r, y, cz + Math.cos(a) * r];
      if (r1 > 0.01) this.poly([p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1)], cell);
      else this.poly([p(a0, r0, y0), p(a1, r0, y0), [cx, y1, cz]], cell);
      if (cap && r1 > 0.01) this.poly([p(a0, r1, y1), p(a1, r1, y1), [cx, y1, cz]], cell);
    }
  }
  geometry() {
    this.setLate(false);
    this.main = this.ni; // (the late indices follow the others: a draw range up to main leaves them out)
    if (this.lni) { this.growI(this.lni); this.idx.set(this.lidx.subarray(0, this.lni), this.ni); this.ni += this.lni; this.lni = 0; }
    this.lidx = null;
    const g = new THREE.BufferGeometry(), n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('uv', new THREE.Float16BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('atl', new THREE.BufferAttribute(this.atl.slice(0, n * 4), 4, false));
    g.setAttribute('dmg', dmgAttr(n, this.dmgW)); // (destruction.js)
    const I = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? I.slice() : Uint16Array.from(I), 1));
    g.computeBoundingSphere();
    this.pos = this.nor = this.uv = this.col = this.atl = null; this.idx = null;
    this.geo = g; // (destruction.js finds a building's vertices through the writer that wrote them)
    return g;
  }
  mesh(mat) {
    const g = this.geometry();
    // static: once on the GPU the JS copies only cost memory (collisions use their own boxes)
    for (const a of [...Object.values(g.attributes), g.index]) a.onUpload(function () { this.array = new this.array.constructor(0); this.sent = true; });
    const m = new THREE.Mesh(g, mat); m.customDepthMaterial = buildingDepthMaterial();
    m.position.set(this.cx, 0, this.cz); m.scale.setScalar(1 / PQ); m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}

// ---------------- roof furniture: instanced ----------------
// The roof furniture (CityScenery.roofTop, crown) is instances of a unit shape per kind, not vertices in the merged
// meshes: 'box' (bulkheads, plant rooms, rooftop units, hatches: four walls and a top, buildings.js furnMaterial uv
// modes 1-3) and 'tank' (a water tank on its stand: the stand's sides, the platform's beams, the staves and the conical
// roof, its heights a + b * legs + c * diameter). One InstancedMesh per kind per 500 m cell, a child of the cell's
// mesh (hidden with it; its own frustum and occlusion tests, its own distance: CityScenery.update); a building's
// instances are a run in each (destruction.js: their dmg flags, like its vertices').
// The unit shapes (per tier: a tank's sides, both faces of its stand, its platform)
const FURN_GEO = new Map();
function furnGeo(kind, F) {
  const key = kind + (kind === 'tank' ? `${F.seg}${F.both}${F.platform}` : ''); let g = FURN_GEO.get(key); if (g) return g;
  const P = [], N = [], UV = [], V = [], E = [], I = [];
  const vert = (x, y, z, nx, ny, nz, u, v, cell, col, mode, world = 0, a = 0, b = 0) => { P.push(x, y, z); N.push(nx, ny, nz); UV.push(u, v); V.push(cell, col, mode, world); E.push(a, b); return P.length / 3 - 1; };
  const quad = (o) => I.push(o, o + 1, o + 2, o, o + 2, o + 3);
  // an upright quad a -> b ((u, n) points, local x = u, z = n), y and fe from each end's (ya, ea, eb) at the bottom and top
  const side = (a, b, cell, col, mode, y0, a0, b0, y1, a1, b1) => {
    const du = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(du, dn), nx = -dn / L, nz = du / L;
    quad(vert(a[0], y0, a[1], nx, 0, nz, 0, 0, cell, col, mode, 0, a0, b0)); vert(b[0], y0, b[1], nx, 0, nz, 1, 0, cell, col, mode, 0, a0, b0);
    vert(b[0], y1, b[1], nx, 0, nz, 1, 1, cell, col, mode, 0, a1, b1); vert(a[0], y1, a[1], nx, 0, nz, 0, 1, cell, col, mode, 0, a1, b1);
  };
  const ring = (s) => [[-s, s], [s, s], [s, -s], [-s, -s]];
  if (kind === 'box') { // CityScenery.block: walls (the instance's cell and first colour), a top (its top cell and second colour)
    const Q = ring(0.5);
    for (let k = 0; k < 4; k++) side(Q[k], Q[(k + 1) % 4], 255, 0, k % 2 ? 2 : 1, 0, 0, 0, 1, 0, 0);
    const o = P.length / 3; for (const [u, n] of Q) vert(u, 1, n, 0, 1, 0, u + 0.5, 0.5 - n, 254, 1, 3); quad(o);
  } else { // CityScenery.tank, its diameter 1
    const Q = ring(0.4); // the stand: legs high (both faces at High)
    for (let k = 0; k < 4; k++) { const a = Q[k], b = Q[(k + 1) % 4]; side(a, b, C.FRAME, 2, 0, 0, 0, 0, 0, 0, 1); if (F.both) side(b, a, C.FRAME, 2, 0, 0, 0, 0, 0, 0, 1); }
    if (F.platform) { const Pq = ring(0.51); for (let k = 0; k < 4; k++) side(Pq[k], Pq[(k + 1) % 4], C.METAL, 2, 4, 0, 0, 1, 0, 0.4, 1); } // (its beams, 0.4 m deep)
    // MeshW.lathe's rows [radius, c, v, normal out, normal up, a]: smooth round seg sides, aligned to the world's axes
    const lathe = (rows, cell, col, mode, uMax) => {
      const seg = F.seg, m = seg + 1, o = P.length / 3;
      for (const [r, y, v, no, nu, a] of rows) for (let k = 0; k <= seg; k++) { const t = (k / seg) * Math.PI * 2, s = Math.sin(t), c = Math.cos(t); vert(s * r, y, c * r, s * no, nu, c * no, (k / seg) * uMax, v, cell, col, mode, 1, a, 1); }
      for (let j = 0; j < rows.length - 1; j++) for (let k = 0; k < seg; k++) { const a = o + j * m + k, b = a + m; I.push(a, a + 1, b + 1, a, b + 1, b); }
    };
    const ro = 0.54, rise = ro * 0.62, k = rise / ro, cn = 1 / Math.hypot(1, k);
    lathe([[0.5, 0, 0, 1, 0, 0.4], [0.5, 0.95, 1, 1, 0, 0.4]], C.WTANK, 0, 5, 1); // the staves (bays round it: uv mode 5)
    lathe([[ro, 0.95, 0, k * cn, cn, 0.32], [0, 0.95 + rise, Math.hypot(ro, rise) / 3, k * cn, cn, 0.4]], C.TRIM, 1, 6, (2 * Math.PI * ro) / 3); // its roof
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setAttribute('fv', new THREE.BufferAttribute(new Uint8Array(V), 4)); g.setAttribute('fe', new THREE.Float32BufferAttribute(E, 2));
  g.setIndex(I); FURN_GEO.set(key, g);
  return g;
}
const freeOnUpload = function () { this.array = new this.array.constructor(0); };
// One kind's instances in one cell, as they're written (positions in metres from the writer's centre), then its mesh
export class FurnK {
  constructor(kind) { this.kind = kind; this.n = 0; this.cap = 0; this.geo = null; this.grow(8); }
  grow(need) {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2), cp = (A, T, k) => { const b = new T(cap * k); if (A) b.set(A.subarray(0, this.n * k)); return b; };
    this.mx = cp(this.mx, Float32Array, 16); this.fi = cp(this.fi, Uint8Array, 4); this.ca = cp(this.ca, Uint8Array, 3); this.cb = cp(this.cb, Uint8Array, 3); this.fl = cp(this.fl, Float32Array, 1); this.ex = cp(this.ex, Float32Array, 6); this.cap = cap;
  }
  // at (x, y, z), its x axis along (ux, uz) (its z axis (-uz, ux), as CityScenery.roofTop's at()), the unit shape scaled
  // (sx, sy, sz); fl, the cells, seed, ly, colours (hex bytes): buildings.js furnMaterial; r, h: its reach round (x, z)
  // and its height (its box, for culling)
  add(x, y, z, ux, uz, sx, sy, sz, fl, c0, c1, seed, ly, ca, cb, r, h) {
    if (this.n >= this.cap) this.grow(this.n + 1);
    const i = this.n++, M = this.mx, o = i * 16, f = i * 4, c = i * 3, e = i * 6;
    M[o] = ux * sx; M[o + 1] = 0; M[o + 2] = uz * sx; M[o + 3] = 0; M[o + 4] = 0; M[o + 5] = sy; M[o + 6] = 0; M[o + 7] = 0;
    M[o + 8] = -uz * sz; M[o + 9] = 0; M[o + 10] = ux * sz; M[o + 11] = 0; M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
    this.fi[f] = c0; this.fi[f + 1] = c1; this.fi[f + 2] = seed; this.fi[f + 3] = ly;
    this.ca[c] = (ca >> 16) & 255; this.ca[c + 1] = (ca >> 8) & 255; this.ca[c + 2] = ca & 255; this.cb[c] = (cb >> 16) & 255; this.cb[c + 1] = (cb >> 8) & 255; this.cb[c + 2] = cb & 255;
    this.fl[i] = fl;
    const X = this.ex; X[e] = x - r; X[e + 1] = y; X[e + 2] = z - r; X[e + 3] = x + r; X[e + 4] = y + h; X[e + 5] = z + r;
  }
  // its InstancedMesh, at (cx, cz) (the writer's centre); own: its own copy of the unit shape's vertices (a mesh disposed
  // with its low tile: a shared attribute freed would leave the others' vertex arrays pointing at nothing)
  mesh(mat, F, own, cx, cz) {
    const n = this.n, U = furnGeo(this.kind, F), g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(U.attributes)) g.setAttribute(k, own ? a.clone() : a);
    g.setIndex(own ? U.index.clone() : U.index);
    const inst = (A, k, norm = false) => { const a = new THREE.InstancedBufferAttribute(A, k, norm); a.onUpload(freeOnUpload); return a; };
    g.setAttribute('fi', inst(this.fi.slice(0, n * 4), 4)); g.setAttribute('fcA', inst(this.ca.slice(0, n * 3), 3, true)); g.setAttribute('fcB', inst(this.cb.slice(0, n * 3), 3, true));
    g.setAttribute('fl', inst(this.fl.slice(0, n), 1)); g.setAttribute('dmg', inst(dmgAttr(n, this.dmgW).array, 1)); // (destruction.js)
    const m = new THREE.InstancedMesh(g, mat, n); m.instanceMatrix.array.set(this.mx.subarray(0, n * 16)); m.instanceMatrix.onUpload(freeOnUpload);
    m.customDepthMaterial = furnDepthMaterial(); m.position.set(cx, 0, cz); m.matrixAutoUpdate = false; m.updateMatrix();
    // its box and sphere (three's culling), its boxes in 4 x 4 columns (occlusion.js worldBounds)
    const X = this.ex, bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n * 6; i += 6) for (let a = 0; a < 3; a++) { bb[a] = Math.min(bb[a], X[i + a]); bb[a + 3] = Math.max(bb[a + 3], X[i + 3 + a]); }
    m.boundingBox = new THREE.Box3(new THREE.Vector3(bb[0], bb[1], bb[2]), new THREE.Vector3(bb[3], bb[4], bb[5])); m.boundingSphere = m.boundingBox.getBoundingSphere(new THREE.Sphere());
    const B = 4, cols = new Float64Array(B * B * 6).fill(Infinity), sx = B / Math.max(1e-9, bb[3] - bb[0]), sz = B / Math.max(1e-9, bb[5] - bb[2]);
    for (let q = 0; q < B * B; q++) cols.fill(-Infinity, q * 6 + 3, q * 6 + 6);
    for (let i = 0; i < n * 6; i += 6) {
      const q = (Math.min(B - 1, Math.floor(((X[i] + X[i + 3]) / 2 - bb[0]) * sx)) * B + Math.min(B - 1, Math.floor(((X[i + 2] + X[i + 5]) / 2 - bb[2]) * sz))) * 6;
      for (let a = 0; a < 3; a++) { cols[q + a] = Math.min(cols[q + a], X[i + a]); cols[q + 3 + a] = Math.max(cols[q + 3 + a], X[i + 3 + a]); }
    }
    const L = []; for (let q = 0; q < B * B; q++) if (cols[q * 6] <= cols[q * 6 + 3]) L.push(...cols.subarray(q * 6, q * 6 + 6));
    m.userData.occL = L;
    this.geo = g; this.dmgW = null; this.mx = this.fi = this.ca = this.cb = this.fl = this.ex = null; // (the JS copies: uploaded and dropped)
    return m;
  }
}
// a cell's writers, one per kind, positions from (cx, cz)
const furnW = (cx, cz) => ({ cx, cz, box: new FurnK('box'), tank: new FurnK('tank') });
const lyOf = (M, y) => Math.max(0, Math.min(255, (y - M.yg + LY0) * LYS)); // (MeshW.v's atl.z)

// A roof's triangles without holes, as THREE.ShapeUtils.triangulateShape gives them (its earcut, 2.2.4, in three r170):
// the same linked ring, the same ear tests in the same order, so the same triangles, flat [a, b, c, ...]. Only the
// common case: no holes, at most 80 points (earcut's z-order hashing starts past that), no repeated end point
// (triangulateShape drops it), every ear found in earcut's first pass; null otherwise (the full triangulateShape then).
const EAR = { nx: new Int32Array(81), pv: new Int32Array(81) };
function earFast(P) {
  const n = P.length; if (n < 3 || n > 80) return null;
  const L = P[n - 1], F = P[0]; if (L[0] === F[0] && L[1] === F[1]) return null;
  let sum = 0; for (let i = 0, j = n - 1; i < n; j = i++) sum += (P[j][0] - P[i][0]) * (P[i][1] + P[j][1]);
  const nx = EAR.nx, pv = EAR.pv, fwd = sum > 0; // (earcut's linkedList(.., clockwise = true): in order if its signed area > 0, else backwards)
  for (let i = 0; i < n; i++) { if (fwd) { nx[i] = (i + 1) % n; pv[i] = (i + n - 1) % n; } else { nx[i] = (i + n - 1) % n; pv[i] = (i + 1) % n; } }
  let ear = fwd ? n - 1 : 0; // (the last node inserted)
  const del = (e) => { nx[pv[e]] = nx[e]; pv[nx[e]] = pv[e]; };
  if (P[ear][0] === P[nx[ear]][0] && P[ear][1] === P[nx[ear]][1]) { del(ear); ear = nx[ear]; }
  if (nx[ear] === pv[ear]) return [];
  const area = (p, q, r) => (P[q][1] - P[p][1]) * (P[r][0] - P[q][0]) - (P[q][0] - P[p][0]) * (P[r][1] - P[q][1]);
  const out = []; let stop = ear;
  while (pv[ear] !== nx[ear]) {
    const a = pv[ear], b = ear, c = nx[ear];
    let ok = area(a, b, c) < 0;
    if (ok) { // (earcut isEar: no other point of the ring in the triangle)
      const ax = P[a][0], ay = P[a][1], bx = P[b][0], by = P[b][1], cx = P[c][0], cy = P[c][1];
      const x0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx), y0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy), x1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx), y1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      for (let m = nx[c]; m !== a; m = nx[m]) {
        const px = P[m][0], py = P[m][1];
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1 && (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py) && area(pv[m], m, nx[m]) >= 0) { ok = false; break; }
      }
    }
    if (ok) { out.push(a, b, c); del(b); ear = nx[c]; stop = nx[c]; continue; }
    ear = c;
    if (ear === stop) return null; // (earcut's later passes: filtering, curing, splitting)
  }
  return out;
}

// ---------------- reading city.bin ----------------
export function readRec(U, S, o, q, cx, cz, R) {
  const w0 = U[o], n = w0 & 4095, nh = w0 >> 12;
  R.flags = U[o + 1]; R.top = S[o + 2] / 4; R.mh = S[o + 3] / 4; R.g0 = S[o + 4] / 4; R.g1 = R.g0 + U[o + 5] / 4;
  const k6 = U[o + 6]; R.kind = k6 & 15; R.roof = (k6 >> 4) & 15; R.lv = k6 >> 8; R.rh = S[o + 7] / 4; R.col = U[o + 8]; R.name = U[o + 9]; R.o = o;
  let p = o + 10;
  const ring = (m) => { const P = []; let x = 0, z = 0; for (let k = 0; k < m; k++) { x += S[p++]; z += S[p++]; P.push([cx + x / q, cz + z / q]); } return P; };
  R.P = ring(n); R.holes = [];
  for (let h = 0; h < nh; h++) { const m = U[p++]; R.holes.push(ring(m)); }
  R.next = p;
  return R;
}
// drop repeated / collinear points (the footprints are surveyed to the centimetre: lots of tiny wiggles)
function simplify(P, tol) {
  let Q = P.filter((p, i) => { const a = P[(i + P.length - 1) % P.length]; return Math.hypot(p[0] - a[0], p[1] - a[1]) > 0.25; });
  for (let pass = 0; pass < 2 && Q.length > 3; pass++) {
    const out = [];
    for (let i = 0; i < Q.length; i++) {
      const a = out.length ? out[out.length - 1] : Q[Q.length - 1], b = Q[i], c = Q[(i + 1) % Q.length];
      const ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez) || 1, d = Math.abs((b[0] - a[0]) * ez - (b[1] - a[1]) * ex) / L;
      if (d > tol || Q.length - (i - out.length) <= 3) out.push(b);
    }
    Q = out;
  }
  return Q;
}
// A footprint ring for the far meshes: the indices of the points kept, dropped while every point of the ring between
// a dropped point's kept neighbours stays within tol of the line joining them (the error never adds up past tol);
// lock(i): a point that stays (where a wall's facade program changes). null: nothing to drop, or the ring would turn.
function farRing(P, tol, lock) {
  const n = P.length; if (n <= 3) return null;
  const keep = new Uint8Array(n).fill(1); let kept = n;
  const dev = (a, c) => { // (the furthest of the points between a and c from the segment a-c, or past tol)
    const A = P[a], B = P[c], ex = B[0] - A[0], ez = B[1] - A[1], L2 = ex * ex + ez * ez;
    for (let i = (a + 1) % n; i !== c; i = (i + 1) % n) {
      const p = P[i]; let t = L2 > 1e-9 ? ((p[0] - A[0]) * ex + (p[1] - A[1]) * ez) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(A[0] + ex * t - p[0], A[1] + ez * t - p[1]) > tol) return false;
    }
    return true;
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < n && kept > 3; i++) {
      if (!keep[i] || lock?.(i)) continue;
      let a = (i + n - 1) % n; while (!keep[a]) a = (a + n - 1) % n;
      let c = (i + 1) % n; while (!keep[c]) c = (c + 1) % n;
      if (dev(a, c)) { keep[i] = 0; kept--; changed = true; }
    }
    if (!changed) break;
  }
  if (kept === n) return null;
  const K = []; for (let i = 0; i < n; i++) if (keep[i]) K.push(i);
  const a0 = area2(P), a1 = area2(K.map((i) => P[i]));
  return a1 * a0 > 0 && Math.abs(a1) > Math.abs(a0) * 0.5 ? K : null;
}
// What a tall building's far copies are made from, kept at load as it is written (farRec, into its group's pack: no
// simplifying, no sorting; packed small by farDone): FAR_NP numbers each (prm), its rings (np, first point, first wall
// start), their points in the mesh's int16 units (pts: the near walls' corners exactly), the street walls (str), where
// each wall's indices start in the group's index (edges), its collision entry (t: damage)
const farPack = () => ({ prm: [], rings: [], pts: [], str: [], edges: [], t: [], cell: 0, top: 0, n: 0 });
function farRec(M, pk, o) {
  const r = pk.n++, F2 = o.F2, q = (v, c) => Math.round((v - c) * PQ);
  pk.prm.push(pk.top, pk.cell, (o.cut ? 1 : 0) | (o.flat ? 2 : 0) | (F2 ? 4 : 0) | (F2?.endDoor ? 8 : 0) | (o.street ? 16 : 0), F2?.front ?? 0, F2?.rear ?? 0,
    o.st.col, o.st.bay, o.st.cell, o.st.fl, o.rLook?.col ?? 0, o.rLook?.cell ?? 0, M.seed, o.yBase, o.wTop, o.yfV, o.flV, o.yFloor, o.eave, o.topW, o.iR0, o.iR1, M.ni, pk.rings.length / 3, 1 + o.holes.length);
  [o.P, ...o.holes].forEach((Q, h) => {
    pk.rings.push(Q.length, pk.pts.length / 2, pk.edges.length);
    for (let k = 0; k < Q.length; k++) { pk.pts.push(q(Q[k][0], M.cx), q(Q[k][1], M.cz)); pk.str.push(!h && o.street?.[k] ? 1 : 0); }
    pk.edges.push(...(h ? o.wIh[h - 1] : o.wIo));
  });
  pk.t.push(null);
  return r;
}
const farDone = (pk) => ({ prm: Float32Array.from(pk.prm), rings: Int32Array.from(pk.rings), pts: Int16Array.from(pk.pts), str: Uint8Array.from(pk.str), edges: Int32Array.from(pk.edges), t: pk.t, n: pk.n });
const farBytes = (pk) => pk.prm.byteLength + pk.rings.byteLength + pk.pts.byteLength + pk.str.byteLength + pk.edges.byteLength + pk.t.length * 8;
// an attribute's items [base, base + n) set from src (a mesh's arrays go once uploaded: MeshW.mesh; then a zeroed
// stand-in, of which only that range uploads)
function farPut(a, src, base, n) {
  const k = a.itemSize;
  if (!a.sent) { a.array.set(src.subarray(0, n * k), base * k); a.needsUpdate = true; return; }
  if (a.array.length !== a.count * k) a.array = new a.array.constructor(a.count * k);
  a.array.set(src.subarray(0, n * k), base * k); a.addUpdateRange(base * k, n * k); a.needsUpdate = true;
}
// a 32-bit hash over ints (tools/test/jobs/bld-hash.js: the far copies made the same every run)
const farMix = (h, A, n) => { for (let i = 0; i < n; i++) { h = Math.imul(h ^ (A[i] | 0), 0x5bd1e995); h ^= h >>> 15; } return h >>> 0; };
const inside = (P, x, z) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const area2 = (P) => { let a = 0; for (let k = 0; k < P.length; k++) { const p = P[k], c = P[(k + 1) % P.length]; a += p[0] * c[1] - c[0] * p[1]; } return a / 2; };
// oriented bounding box: the edge direction giving the smallest rectangle
function obb(P) {
  let best = null;
  const n = P.length, step = Math.max(1, Math.floor(n / 24));
  for (let k = 0; k < n; k += step) {
    const a = P[k], c = P[(k + 1) % n], ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez); if (L < 0.5) continue;
    const ux = ex / L, uz = ez / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of P) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.ar) best = { ar, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz } = best, hl = (best.u1 - best.u0) / 2, hw = (best.v1 - best.v0) / 2;
  const um = (best.u0 + best.u1) / 2, vm = (best.v0 + best.v1) / 2;
  const cx = um * ux - vm * uz, cz = um * uz + vm * ux;
  if (hw > hl) { [hl, hw] = [hw, hl]; [ux, uz] = [-uz, ux]; }
  return { cx, cz, ux, uz, hl, hw, ar: best.ar };
}
// a point's distance from a clear zone's centre line (setback.js segment: [ax, az, bx, bz, r, ...])
const segD = (s, x, z) => { const dx = s[2] - s[0], dz = s[3] - s[1], L2 = dx * dx + dz * dz || 1e-9; let t = ((x - s[0]) * dx + (z - s[1]) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z); };
// a wall p -> r cut where it goes in and out of the region inn(x, z) says: [[t0, t1, in], ...] (sampled every 50 cm,
// each change pinned down to a centimetre)
function spans(p, r, inn) {
  const L = Math.hypot(r[0] - p[0], r[1] - p[1]), m = Math.max(2, Math.ceil(L / 0.5)), at = (t) => inn(p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t), out = [];
  let t0 = 0, s0 = at(0);
  for (let i = 1; i <= m; i++) {
    const t = i / m, si = at(t); if (si === s0) continue;
    let lo = (i - 1) / m, hi = t; for (let k = 0; k < 6; k++) { const md = (lo + hi) / 2; if (at(md) === s0) lo = md; else hi = md; }
    out.push([t0, hi, s0]); t0 = hi; s0 = si;
  }
  out.push([t0, 1, s0]);
  return out;
}
const c565 = (c) => { const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31; return ((r * 255 / 31) << 16) | ((g * 255 / 63) << 8) | (b * 255 / 31); };
const pick = (a, h) => a[Math.floor(h * a.length) % a.length];

// an irregular building's boxes (setback.js footBoxes), each kept off the street (fitBox) unless a road runs through
// the building (fit: false); null if footBoxes has none. quick: the boxes beside a passage, at load (footBoxes quick)
function cityParts(city, Q, H, q, fit, quick = false, I = null) { /* (I: the lines to fit to; null: city.roads) */
  const FS = city.footStats, t0 = performance.now(), B = footBoxes(Q, H, q.ux, q.uz, true, null, quick), out = B && fit ? (quick ? B.map((f) => fitBox(I || city.roads, f)) : fillBare(Q, H, q.ux, q.uz, B, (f) => fitBox(I || city.roads, f))) : B;
  if (out && B.refine) out.refine = true; // (a huge one under FOOT.retry: cut into squares after load, CityScenery.refiner)
  FS.irr++; if (B) { FS.boxes += B.length; FS.max = Math.max(FS.max, B.length); } FS.ms += performance.now() - t0;
  return out;
}
// ...worked out when something first asks (setback.js lazyParts), from its footprint kept compact till then (out here,
// not in CityScenery.building: a closure there would keep the whole tile's mesh writer alive with it). exact: the
// footprint kept as it is (a big one, FOOT.eager: a few hundred of them, its boxes exactly what they'd be at load;
// packRing's floats would move its points a millimetre). tile: the city tile it stands in (its building lines, TileLines)
function lazyBoxes(city, t, P, holes, q, fit, fallback, exact = false, tile = null) {
  const fp = exact ? P : packRing(P), hp = exact ? holes : holes.map(packRing), un = exact ? (a) => a : unpackRing;
  let I = null; const parts = () => cityParts(city, un(fp), hp.map(un), q, fit, false, I) || fallback;
  lazyParts(t, () => {
    if (city.lines && tile && !(I = city.lines.get(tile))) return LATER; // (the baked layout's lines about its tile not in yet: its entry's box till they are)
    const t0 = performance.now(), w0 = { ...WORK }, B = parts(), FS = city.footStats, dt = performance.now() - t0, w = workSince(w0);
    if (B?.refine) city.refiner.add(un(fp), hp.map(un), q.ux, q.uz, (T) => { if (city.w.destruct?.states.has(t.dk)) return; t.parts = fit ? T.map((f) => fitBox(I || city.roads, f)) : T; FS.boxes += T.length; FS.max = Math.max(FS.max, T.length); }); // (still bare: cut into squares, a piece at a time, setback.js Refiner)
    if (dt > FS.lazy) { FS.lazy = dt; FS.lazyRedo = parts; } // (lazyRedo: the slowest one again, for tools/test/setbacks.js: info)
    if (w.cells + w.verts > (FS.lazyWork?.cells ?? 0) + (FS.lazyWork?.verts ?? 0)) FS.lazyWork = { ...w, walls: exact ? fp.length : fp.length / 2, boxes: B?.length ?? 0, big: exact }; // (the most work any one took: tools/test/setbacks.js)
    return B;
  });
}

// o[k] worked out by make the first time it's read (then a plain property)
const lazy = (o, k, make) => Object.defineProperty(o, k, { configurable: true, enumerable: true, get() { const v = make(); Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: true }); return v; }, set(v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: true }); } });

// The building lines a city tile's buildings are set back from, on the baked layout with its overlay (#294, ?layout=1:
// layout/setbacks.js): the low buildings (streamed by tile) and the lazy collision boxes (tall or low) read them, so no
// building consults today's roads and no road index (setback.js roadIndex) is made. A tile's are its region's (its
// records' box, LINES_PAD out: what the furthest reach any check makes, streetWalls' FRONT, finds) from the layout chunks
// over it (each chunk's lines: chunkLines, from its file, the Layout's own decode if it has it), in the index's order,
// and today's lines baked into the overlay where no chunk is baked (ov.kept). Deterministic: the same chunks, the same
// lines, whenever they arrive. get(t): its index, or null while a chunk is still coming (fetched then; a low tile waits
// for it: update; a lazy box is its entry's box till then).
const LINES_PAD = 64;
class TileLines {
  constructor(city, LY, ov) {
    this.city = city; this.LY = LY; this.kept = ov.kept; this.S = ov.S; this.ord = new Map([...LY.index.keys()].map((k, i) => [k, i]));
    this.by = new Map(); this.chunk = new Map(); this.coming = new Set(); this.stats = { tiles: 0, segs: 0, ms: 0, chunks: 0 };
  }
  // the tile's records' box, LINES_PAD out
  box(t) {
    const C = this.city, U = C.city.U, S = C.city.S, q = C.q, [cx, cz] = C.tileCentre(t.i, t.j); let o = t.off, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let r = 0; r < t.nTall + t.nLow; r++) { // (readRec's layout, the outer ring only: supIndex)
      const w0 = U[o], n = w0 & 4095, nh = w0 >> 12; let p = o + 10, x = 0, z = 0;
      for (let k = 0; k < n; k++) { x += S[p++]; z += S[p++]; const X = cx + x / q, Z = cz + z / q; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z; }
      for (let h = 0; h < nh; h++) p += 2 * U[p] + 1;
      o = p;
    }
    if (x0 === Infinity) { x0 = x1 = cx; z0 = z1 = cz; }
    return { x0: x0 - LINES_PAD, z0: z0 - LINES_PAD, x1: x1 + LINES_PAD, z1: z1 + LINES_PAD };
  }
  // the layout chunks over a tile's box, in the index's order
  keys(b) { const L = this.LY, S = L.size, ks = []; for (let i = Math.floor(b.x0 / S); i <= Math.floor(b.x1 / S); i++) for (let j = Math.floor(b.z0 / S); j <= Math.floor(b.z1 / S); j++) if (L.index.has(i + ',' + j)) ks.push(i + ',' + j); return ks.sort((a, c) => this.ord.get(a) - this.ord.get(c)); }
  // a chunk's lines, if in (else fetched: not through Layout.load, whose chunks it then meshes and waits for)
  lines(k) {
    const have = this.chunk.get(k); if (have) return have;
    const L = this.LY, c = L.chunks.get(k), e = L.index.get(k);
    if (c?.L || !e.file) { const s = c?.L ? chunkLines(c.L, this.S) : []; this.chunk.set(k, s); this.stats.chunks++; return s; } // (a chunk only ground, no file: no streets)
    if (!this.coming.has(k)) { this.coming.add(k);
      (async () => { const r = await fetch(L.dir + e.file), s = r.body.pipeThrough(new DecompressionStream('gzip')); return decodeLayout(await new Response(s).arrayBuffer()); })()
        .then((D) => { if (!this.chunk.has(k)) { this.chunk.set(k, chunkLines(D, this.S)); this.stats.chunks++; } }, (err) => { console.warn('[setbacks] layout chunk', k, err); this.chunk.set(k, []); }).finally(() => this.coming.delete(k)); }
    return null;
  }
  get(t) {
    const I = this.by.get(t); if (I) return I;
    const b = t.lbox || (t.lbox = this.box(t)), ks = t.lks || (t.lks = this.keys(b)); let ready = true;
    for (const k of ks) if (!this.lines(k)) ready = false;
    if (!ready) return null;
    const t0 = performance.now(), J = linesIndex(ks.map((k) => this.chunk.get(k)), this.kept, this.S, b); this.by.set(t, J);
    this.stats.tiles++; this.stats.segs += J.segs.length; this.stats.ms += performance.now() - t0;
    return J;
  }
  // every chunk any of tiles' boxes needs, in (tools and tests: the game fetches them as tiles want them)
  async prime(tiles = this.city.tiles.values()) {
    const ks = new Set(); for (const t of tiles) { const b = t.lbox || (t.lbox = this.box(t)); for (const k of (t.lks ||= this.keys(b))) ks.add(k); }
    for (const k of ks) this.lines(k);
    while (this.coming.size) await new Promise((r) => setTimeout(r, 5));
    return ks.size;
  }
}

// ---------------- the city ----------------
export class CityScenery {
  constructor(world, D, group) {
    const W = (this.w = world);
    this.D = D; this.group = group; this.city = D.city; const H = D.city.hdr;
    this.q = H.q; this.T = H.tile;
    this.qn = W.qName;
    this.grid = new Map(); // 50 m cells -> collision boxes
    this.lowR = LOW_R[W.qName] ?? 1600;
    this.furn = FURN[W.qName] ?? FURN.medium; this.furnD = FURN_D[W.qName] ?? FURN_D.medium; // roof furniture: every tier, its detail by tier
    this.roofStats = { flat: 0, tanks: 0, bulkheads: 0, plant: 0, units: 0, hatches: 0, cake: 0, screen: 0, copper: 0, flood: 0, crownBox: 0, cells: {}, cols: new Set() }; // (what the roofs got: tools/test/bldcheck.js; crownBox: a crown's plant room or cap, a box instance like the roofs')
    this.furnMade = { box: 0, tank: 0 }; // (roof furniture instances made, tall and low, every low tile build: roofStats' counts)
    this.levelD = LEVEL_D[W.qName] ?? LEVEL_D.medium;
    const mo = { cellPx: { low: 128, medium: 192, ultra: 384 }[W.qName] ?? 256, interiors: W.qName !== 'low', glass: true };
    this.mat = buildingMaterial(mo); this.fmat = furnMaterial(mo, TANK.steel); // (fmat: the roof furniture's instances, FurnK)
    // (lit windows: set in update, dimmer than a village's; thousands of them in view)
    this.tiles = new Map(); let ord0 = 0; for (const t of H.tiles) { this.tiles.set(t[0] + ',' + t[1], { i: t[0], j: t[1], off: t[2], nTall: t[3], nLow: t[4], low: null, ord0 }); ord0 += t[3]; } // (ord0: its first tall record's place in city.bin's order)
    const cfg = W.loc.city || {};
    this.masts = (cfg.masts || []).map((m) => { const [x, z] = toLocal(D.meta, m.lat, m.lon); return { ...m, x, z }; });
    this.hole = cfg.statue ? toLocal(D.meta, cfg.statue.lat, cfg.statue.lon) : null; // footprints there: drawn as a model
    // rooftop helipads (helipad.js): the tallest flat roof at each point is found while the skyline is built (h.roof)
    this.helipads = (cfg.helipads || []).map((h) => { const [x, z] = toLocal(D.meta, h.lat, h.lon), L = h.look && toLocal(D.meta, h.look.lat, h.look.lon); return { ...h, x, z, look: L ? { x: L[0], z: L[1] } : null, roof: null }; });
    const t0 = performance.now(), w0 = { ...WORK };
    this.stats = { tall: 0, low: 0, tris: 0 };
    // the baked setbacks (#294, ?layout=1: layout/setbacks.js): what each tall building's road checks answered, against
    // the layout's building lines, and its ground from the layout's surface (tap); then the road index and the density
    // map are made only when something else first asks (a low tile, a lazy collision box). Recording: the bake's run.
    const BK = CityScenery.bake; this.ov = BK ? null : D.setbacks?.n === H.tiles.reduce((n, t) => n + t[3], 0) ? D.setbacks : null; this.tp = null; this.ovStats = { used: 0, miss: 0 };
    // Then the low buildings and the lazy collision boxes read each tile's building lines (TileLines; this.curLines: the
    // tile being built's); anything else asking for roads (none known: ROADS.built counts it) gets today's index.
    this.lines = !BK && this.ov?.kept && W.layout ? new TileLines(this, W.layout, this.ov) : null; this.curLines = null;
    const today = () => { const t1 = performance.now(), I = roadIndex(W); this.setbacks.ms += performance.now() - t1; return I; };
    if (BK) { this.roads = BK.roads; this.tapes = []; } else if (this.lines) { let I = null; Object.defineProperty(this, 'roads', { configurable: true, enumerable: true, get: () => this.curLines || (I ||= today()) }); }
    else if (this.ov) lazy(this, 'roads', today);
    else this.roads = roadIndex(W);
    this.setbacks = { cut: 0, dropped: 0, through: 0, ms: performance.now() - t0 }; // set back from the streets (setback.js; ms: the index and the cuts)
    this.footStats = { n: 0, irr: 0, boxes: 0, max: 0, ms: 0, lazy: 0, load: 0 }; // (the collision boxes: ms in footBoxes, whenever; lazy: the slowest worked out after load; load: at load)
    this.refiner = new Refiner(); // (a huge footprint's boxes, a piece at a time after load: setback.js tiledBoxes)
    this.farStats = { tris: 0, groupTris: 0, verts: 0, nearVerts: 0, room: 0, over: 0, ms: 0, maxMs: 0, steps: 0, built: 0, done: 0, kept: 0, keptI: 0, hash: 0, groupNear: 0 }; // (the far copies, made after load: farStep)
    this.farQ = null; // (their jobs, nearest their switch first: farPlan)
    if (!this.ov) this.density(); this.sup = new Map(); this.supTiles = new Set(); this.grounded = 0; this.nested = 0; this.kiosks = 0; this.passages = []; this.gf = { front: 0, ground: 0, parts: 0, miss: [] };
    this.buildTall();
    this.msTall = performance.now() - t0; this.loadWork = { ...workSince(w0), irr: this.footStats.irr, n: this.footStats.n }; // (setback.js WORK at load: tools/test/setbacks.js)
    this.queue = []; this.lastPlan = null; this.shadows = W_SHADOW(W);
  }
  tileCentre(i, j) { const H = this.city.hdr; return [H.x0 + (i + 0.5) * H.tile, H.z0 + (j + 0.5) * H.tile]; }

  // ---------------- tall buildings: all at load, merged per GROUP x GROUP tiles ----------------
  buildTall() {
    const H = this.city.hdr, U = this.city.U, S = this.city.S, groups = new Map();
    for (const t of this.tiles.values()) {
      if (!t.nTall) continue;
      const k = Math.floor(t.i / GROUP) + ',' + Math.floor(t.j / GROUP);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    this.tallGroups = [];
    const R = {};
    for (const [k, ts] of groups) {
      // all the group's tall records, tallest first
      const recs = [];
      for (const t of ts) {
        const [cx, cz] = this.tileCentre(t.i, t.j);
        let o = t.off;
        for (let r = 0; r < t.nTall; r++) { readRec(U, S, o, this.q, cx, cz, R); recs.push({ o, cx, cz, top: R.top + R.mh * 0, t, ord: t.ord0 + r }); o = R.next; } // (ord: its place in city.bin's order, the baked setbacks')
        t.lowOff = o;
      }
      recs.sort((a, b) => b.top - a.top);
      // The group's buildings, written into one vertex buffer (one writer: destruction.js finds a building's vertices
      // through it), with their far copies (made after load: farStep; mostly the same triangles, a few vertices of their
      // own in the room after the buildings'), are drawn three ways, each through an index buffer of its own over them:
      //  - near (all heights drawn): one mesh per TALL_CELL cell, each culled on its own by three's frustum test (in
      //    every pass: the shadow map's too), its buildings tallest first (any late indices last; the roof furniture is instances: FurnK, one InstancedMesh per kind per FURN_CELL);
      //  - a cell past FAR.d: its far copies, one mesh per cell (farCell), its back-facing sectors left out;
      //  - far (only the tall ones): the whole group, tallest first, so a draw range by height level is one draw call (its
      //    near buildings till their coarser far copies are written over its index).
      const [gi, gj] = k.split(',').map(Number), gcx = H.x0 + (gi + 0.5) * GROUP * H.tile, gcz = H.z0 + (gj + 0.5) * GROUP * H.tile;
      const M = new MeshW(gcx, gcz, 16384), lv = [], cells = new Map(), occ = [], fws = new Map(); // (fws: each cell's roof furniture, FurnK)
      const pk = (M.far = farPack()), ckOf = new Map(); // (what the far copies are made from, later: farRec; ckOf: the cells, numbered)
      let li = 0;
      for (const rc of recs) {
        while (li < LEVELS.length - 1 && rc.top < LEVELS[li]) { lv.push(M.ni); li++; }
        readRec(U, S, rc.o, this.q, rc.cx, rc.cz, R);
        if (this.skipped(R)) continue;
        const ck = this.cellKey(R.P, TALL_CELL), a = M.ni, la = M.lni, v0 = M.n;
        pk.cell = ckOf.get(ck) ?? ckOf.set(ck, ckOf.size).get(ck); pk.top = rc.top;
        const fk = this.cellKey(R.P, FURN_CELL); M.fw = fws.get(fk); if (!M.fw) fws.set(fk, (M.fw = furnW(...this.cellCentre(fk, FURN_CELL))));
        this.lastFoot = this.lastBase = null; this.curOrd = rc.ord; this.bt = rc.t; this.building(M, R, true); this.curOrd = null; this.tp = null; this.bt = null;
        const ob = M.n > v0 && this.occluder(R, true); if (ob) { ob.ck = ck; occ.push(ob); (rc.t.occ || (rc.t.occ = [])).push(ob); }
        let c = cells.get(ck); if (!c) cells.set(ck, (c = []));
        c.push(a, M.ni, la, M.lni, rc.top); // (its main and late index runs)
        this.stats.tall++;
      }
      while (lv.length < LEVELS.length - 1) lv.push(M.ni);
      M.far = null;
      if (!M.n) continue;
      // room after the buildings' vertices for the far copies' own (made later: farStep), copies of the first vertex
      // till then (the bounds as they were; nothing draws them)
      const nearN = M.n, room = Math.ceil(nearN * FAR_ROOM) + 64;
      M.grow(nearN + room); for (let i = nearN; i < nearN + room; i++) M.pos.copyWithin(i * 3, 0, 3);
      M.n += room;
      const far = M.mesh(this.mat), G = far.geometry, I = G.index.array, P = G.attributes.position.array;
      far.castShadow = W_SHADOW(this.w); far.receiveShadow = true;
      const g = { m: far, x: gcx, z: gcz, lv, all: M.ni, main: M.main, nearN, cells: [], furn: [] }, cellM = new Map();
      for (const fw of fws.values()) this.furnMeshes(fw, g.furn, false, W_SHADOW(this.w));
      // (far: only what is drawn far, the levels down to the lowest a far group draws; no roof furniture; its far copy
      // written over it later, farStep)
      G.setIndex(new THREE.BufferAttribute(I.slice(0, lv[LEVELS.length - 2]), 1)); G.index.onUpload(function () { this.array = new this.array.constructor(0); this.sent = true; });
      binBounds(far, P, G.index.array, G.index.count, 8); // (its bounds in columns, while its vertices are here: occlude())
      g.far = { M, I, pk: farDone(pk), room, used: 0, cells: [], jobs: 0 }; // (I: the whole index, till the far copies are made)
      this.farStats.kept += farBytes(g.far.pk); this.farStats.keptI += I.byteLength;
      for (const [ck, c] of cells) {
        let n = 0; for (let q = 0; q < c.length; q += 5) n += c[q + 1] - c[q] + c[q + 3] - c[q + 2];
        const J = new (I.constructor)(n), clv = [];
        let o = 0, cli = 0;
        for (let q = 0; q < c.length; q += 5) {
          while (cli < LEVELS.length - 1 && c[q + 4] < LEVELS[cli]) { clv.push(o); cli++; }
          J.set(I.subarray(c[q], c[q + 1]), o); o += c[q + 1] - c[q];
        }
        while (clv.length < LEVELS.length - 1) clv.push(o);
        const main = o;
        for (let q = 0; q < c.length; q += 5) { J.set(I.subarray(M.main + c[q + 2], M.main + c[q + 3]), o); o += c[q + 3] - c[q + 2]; }
        if (!n) continue;
        const cg = new THREE.BufferGeometry();
        for (const [k, at] of Object.entries(G.attributes)) cg.setAttribute(k, at); // (shared: uploaded once)
        cg.setIndex(new THREE.BufferAttribute(J, 1)); cg.index.onUpload(function () { this.array = new this.array.constructor(0); });
        // its bounds: its own vertices' (three's culling test; the shared buffer's would be the whole group's)
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let q = 0; q < n; q++) { const v = J[q] * 3, x = P[v], y = P[v + 1], z = P[v + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
        cg.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)); cg.boundingSphere = cg.boundingBox.getBoundingSphere(new THREE.Sphere());
        const m = new THREE.Mesh(cg, this.mat); m.customDepthMaterial = far.customDepthMaterial; binBounds(m, P, J, n, 4);
        m.position.copy(far.position); m.scale.copy(far.scale); m.matrixAutoUpdate = false; m.updateMatrix();
        m.castShadow = far.castShadow; m.receiveShadow = true; m.visible = false;
        this.group.add(m);
        const [x, z] = this.cellCentre(ck, TALL_CELL), cell = { m, x, z, lv: clv, all: n, main, fm: null, box: [far.position.x + x0 / PQ, y0 / PQ, far.position.z + z0 / PQ, far.position.x + x1 / PQ, y1 / PQ, far.position.z + z1 / PQ] };
        g.cells.push(cell); cellM.set(ck, m); g.far.cells[ckOf.get(ck)] = cell;
      }
      for (const ob of occ) ob.m = cellM.get(ob.ck); // (an occluder counts only while its cell mesh is drawn)
      this.group.add(far);
      this.stats.tris += M.ni / 3; this.farStats.nearVerts += nearN; this.farStats.room += room;
      this.tallGroups.push(g);
    }
    this.tallMeshes = this.tallGroups.flatMap((g) => g.cells); // (the near meshes: every building of the group once)
    for (const t of this.tiles.values()) if (t.lowOff == null) t.lowOff = t.off; // (tiles with no tall buildings)
  }

  // A cell's far mesh (c: the cell), over its group's vertices (G: the group mesh's geometry; J: its far copies'
  // triangles, S: each one's sector, farBuilding): its upright triangles sorted into SECT compass sectors by the way
  // they face, the rest (roofs) after them, then the sectors again: [S0 .. S15, rest, S0 .. S13], so the sectors facing
  // the camera (a run round the compass) and the rest are one draw range (farRange: a run that goes round past S15 into
  // the second copy ends by S13, as at least one sector is left out then). Its bounds the near mesh's (the copies stand
  // within the buildings' footprints).
  farCell(J, S, G, c, gm) {
    const cnt = new Int32Array(SECT + 1); for (const v of S) cnt[v < 0 ? SECT : v]++;
    const off = new Int32Array(SECT + 2); for (let j = 0; j <= SECT; j++) off[j + 1] = off[j] + cnt[j] * 3;
    const oE = off[SECT + 1], K = new (J.constructor)(oE + off[SECT - 2]), at = off.slice(0, SECT + 1);
    for (let t = 0; t < S.length; t++) { const j = S[t] < 0 ? SECT : S[t], w = at[j]; K[w] = J[t * 3]; K[w + 1] = J[t * 3 + 1]; K[w + 2] = J[t * 3 + 2]; at[j] += 3; }
    K.copyWithin(oE, 0, off[SECT - 2]);
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(G.attributes)) g.setAttribute(k, a); // (shared: uploaded once)
    g.setIndex(new THREE.BufferAttribute(K, 1)); g.index.onUpload(function () { this.array = new this.array.constructor(0); this.sent = true; });
    const ng = c.m.geometry; g.boundingBox = ng.boundingBox.clone(); g.boundingSphere = ng.boundingSphere.clone();
    g.setDrawRange(0, oE);
    const m = new THREE.Mesh(g, this.mat); m.customDepthMaterial = gm.customDepthMaterial; m.userData.occL = c.m.userData.occL;
    m.position.copy(gm.position); m.scale.copy(gm.scale); m.matrixAutoUpdate = false; m.updateMatrix();
    m.castShadow = c.m.castShadow; m.receiveShadow = true; m.visible = false;
    this.group.add(m);
    const B = c.box; m.userData.far = { off: off.subarray(0, SECT + 1), oE, cx: (B[0] + B[3]) / 2, cz: (B[2] + B[5]) / 2, r: Math.hypot(B[3] - B[0], B[5] - B[2]) / 2 }; // (its middle and its reach round it, level: farRange)
    return m;
  }
  // a cell's far mesh's draw range (farCell) for the camera at c: the sectors that face wholly away from it from
  // anywhere in the cell left out (all: everything, for the shadow maps, which draw the faces turned from the sun)
  farRange(m, c, all) {
    const F = m.userData.far, o = F.off, oE = F.oE, K = SECT, g = m.geometry, dx = c.x - F.cx, dz = c.z - F.cz, D = Math.hypot(dx, dz);
    if (all || D <= F.r * 1.01) { g.setDrawRange(0, oE); return; }
    // sector j faces away from every point of the cell if each normal in it is more than 90 degrees + asin(r / D) from
    // the way to the camera
    const th = Math.atan2(dz, dx), lim = Math.PI / 2 + Math.asin(F.r / D), sw = (2 * Math.PI) / K;
    let cull = 0;
    for (let j = 0; j < K; j++) { let d = Math.abs(((th - (j + 0.5) * sw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) - sw / 2; if (d > lim) cull |= 1 << j; }
    if (!cull) { g.setDrawRange(0, oE); return; }
    let a = 0; while (!((cull >> ((a + K - 1) % K)) & 1) || (cull >> a) & 1) a++; // (the first sector drawn after a culled one)
    let w = 0; while (w < K && !((cull >> ((a + w) % K)) & 1)) w++;
    let s, e;
    if (a + w > K) { s = o[a]; e = oE + o[a + w - K]; } // (round past the last sector: through the rest into the second run)
    else if (a + w > K - 2 || o[K] - o[a + w] <= o[a]) { s = o[a]; e = oE; } // (on to the rest, a few culled sectors drawn too)
    else { s = o[K]; e = oE + o[a + w]; }
    g.setDrawRange(s, e - s);
  }
  // the cell (e m square) a footprint's middle is in: (i + 32768) * 65536 + j + 32768
  // (t: within that data tile's cells, a footprint whose middle is past its edge too)
  cellKey(P, e, t = null) {
    const H = this.city.hdr; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
    let i = Math.floor(((x0 + x1) / 2 - H.x0) / e), j = Math.floor(((z0 + z1) / 2 - H.z0) / e);
    if (t) { const n = Math.round(H.tile / e); i = Math.min(Math.max(i, t.i * n), t.i * n + n - 1); j = Math.min(Math.max(j, t.j * n), t.j * n + n - 1); }
    return (i + 32768) * 65536 + j + 32768;
  }
  cellCentre(k, e) { const H = this.city.hdr; return [H.x0 + (Math.floor(k / 65536) - 32768 + 0.5) * e, H.z0 + ((k % 65536) - 32768 + 0.5) * e]; }
  skipped(R) { if (!this.hole) return false; const p = R.P[0]; return Math.hypot(p[0] - this.hole[0], p[1] - this.hole[1]) < 60; }

  // How built-up a spot is: the tall buildings (city.bin's tall flag: 20 m and up, or big) counted in 100 m cells, once
  // at load. dense(x, z): a dozen or more within a block or two (Midtown, downtown Brooklyn, Jersey City's waterfront),
  // where a small untagged building is a kiosk, a booth or a pavilion, not a clapboard house (Queens, Staten Island).
  density() {
    const U = this.city.U, S = this.city.S, R = {}, D = (this.dens = new Map());
    for (const t of this.tiles.values()) {
      if (!t.nTall) continue;
      const [cx, cz] = this.tileCentre(t.i, t.j); let o = t.off;
      for (let r = 0; r < t.nTall; r++) { readRec(U, S, o, this.q, cx, cz, R); o = R.next; if (R.flags & 1) continue; const k = Math.floor(R.P[0][0] / 100) + ',' + Math.floor(R.P[0][1] / 100); D.set(k, (D.get(k) || 0) + 1); }
    }
  }
  dense(x, z) {
    if (!this.dens) this.density(); // (the baked setbacks: made when a low tile first asks)
    const i = Math.floor(x / 100), j = Math.floor(z / 100); let n = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += this.dens.get(i + a + ',' + (j + b)) || 0;
    return n >= DENSE;
  }
  // What stands under a building:part, from the other records round it (supIndex), its footprint sampled (the middle,
  // and part way out to each corner):
  //  - a part raised off the ground (min_height) with nothing under it: city.py drops a building's outline when its
  //    parts cover most of it, counting the parts up in the air too, so a tower whose podium was only mapped as the
  //    outline floats on its upper parts (Madison Avenue at 47th: twelve metres of nothing under a brick tower). If
  //    under most of the points no other building or part stands up to its underside, it is grounded (built down to
  //    the street; one over a street, a skybridge or an arch over the road, stays up in the air): returns 0.
  //  - a part on the ground standing inside a lower one (a tower mapped from the street up inside its podium, the
  //    wedding cake's tiers all from the ground): its walls start on the podium's roof (returns that height), so the
  //    podium's ground floor is the one on the street and the walls don't fight over it.
  // Else its own min_height.
  base(R, P, mh, top) { return (this.lastBase = this.tap('base', () => { const b = this.baseOf(R, P, mh, top); return b === mh ? null : b; }) ?? mh); } // (the last one kept: occluder(); the baked setbacks keep only one that moved)
  // A road-dependent answer for the building being built (k: which; f: works it out): the baked setbacks' (this.tp: its
  // tape, layout/setbacks.js) if there are any, else f's. The bake's run (tp.rec) records each. An answer the tape
  // hasn't got: worked out (g, base, box: none stored means none). (raw: today's answers as they are, for checks)
  tap(k, f) {
    const T = this.tp; if (!T) return f();
    if (T.rec) { const v = SNAP[k] && !T.raw ? SNAP[k](f()) : f(); (T[k] || (T[k] = [])).push(v); return v; } // (as the overlay keeps it: the bake builds with what the game will)
    const q = T[k], i = T.at[k] || 0; if (q && i < q.length) { T.at[k] = i + 1; return q[i]; }
    if (k === 'g' || k === 'base' || k === 'box') return null;
    this.ovStats.miss++; return f();
  }
  baseOf(R, P, mh, top) {
    let cx = 0, cz = 0; for (const p of P) { cx += p[0]; cz += p[1]; } cx /= P.length; cz /= P.length;
    const pts = [[cx, cz]], step = Math.max(1, Math.floor(P.length / 8));
    for (let k = 0; k < P.length; k += step) pts.push([cx + (P[k][0] - cx) * 0.6, cz + (P[k][1] - cz) * 0.6]);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const H = this.city.hdr, T = H.tile;
    for (let i = Math.floor((x0 - 60 - H.x0) / T); i <= Math.floor((x1 + 60 - H.x0) / T); i++) for (let j = Math.floor((z0 - 60 - H.z0) / T); j <= Math.floor((z1 + 60 - H.z0) / T); j++) this.supIndex(i, j);
    const U = this.city.U, S = this.city.S, Q = {}, up = mh > 0.5;
    let held = 0, pod = Infinity;
    for (const [x, z] of pts) {
      const c = this.sup.get(Math.floor(x / SUP) * 65536 + Math.floor(z / SUP)); let best = -1;
      if (c) for (const e of c) {
        if (e[0] === R.o || x < e[1] || x > e[3] || z < e[2] || z > e[4]) continue;
        if (up ? e[5] > mh - 1 || e[6] < mh - 1.5 : e[5] > 0.5 || e[6] > top - 1 || e[6] < 3 || e[6] <= best) continue;
        readRec(U, S, e[0], this.q, e[7], e[8], Q); if (!inside(Q.P, x, z)) continue;
        if (up) { held++; break; }
        best = e[6];
      }
      if (!up) { if (best < 0) return mh; pod = Math.min(pod, best); }
    }
    if (up) return held < pts.length * 0.5 && intrusion(this.roads, P) < 0.5 ? 0 : mh;
    return pod - 0.3;
  }
  // every record of tile (i, j) (tall and low) filed by its box in SUP m cells: [o, x0, z0, x1, z1, min height, top, tile centre]
  supIndex(i, j) {
    const key = i + ',' + j; if (this.supTiles.has(key)) return; this.supTiles.add(key);
    const t = this.tiles.get(key); if (!t) return;
    const U = this.city.U, S = this.city.S, q = this.q, [cx, cz] = this.tileCentre(i, j); let o = t.off;
    for (let r = 0; r < t.nTall + t.nLow; r++) { // (readRec's layout, the outer ring's box only: no arrays)
      const w0 = U[o], n = w0 & 4095, nh = w0 >> 12, rt = S[o + 2] / 4, mh = S[o + 3] / 4, lv = U[o + 6] >> 8, o0 = o;
      let p = o + 10, x = 0, z = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < n; k++) { x += S[p++]; z += S[p++]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      for (let h = 0; h < nh; h++) p += 2 * U[p] + 1;
      o = p; x0 = cx + x0 / q; x1 = cx + x1 / q; z0 = cz + z0 / q; z1 = cz + z1 / q;
      const top = rt > 0 ? rt : lv > 0 ? lv * 3.2 + 1 : 8, e = [o0, x0, z0, x1, z1, mh, top, cx, cz];
      if ((x1 - x0) * (z1 - z0) > 250000) continue; // (a footprint half a kilometre across is not anyone's podium)
      for (let a = Math.floor(x0 / SUP); a <= Math.floor(x1 / SUP); a++) for (let b = Math.floor(z0 / SUP); b <= Math.floor(z1 / SUP); b++) { const k = a * 65536 + b; let c = this.sup.get(k); if (!c) this.sup.set(k, (c = [])); c.push(e); }
    }
  }

  // ---------------- one building (or part) ----------------
  // a record's footprint as built: simplified, counter-clockwise, set back from the streets (setback.js: cut back off the
  // roadway and pavement; null if too little is left), its courtyards (those the cut reaches are filled in)
  footprint(R, tall) { return (this.lastFoot = this.footprintOf(R, tall)); } // (the last one kept: occluder())
  footprintOf(R, tall) {
    let P = simplify(R.P, tall ? 0.35 : 0.5);
    if (P.length < 3) return null;
    if (area2(P) < 0) P.reverse();
    let holes = R.holes.map((h) => { const Q = simplify(h, 0.5); if (area2(Q) < 0) Q.reverse(); return Q; }).filter((h) => h.length >= 3);
    const major = R.top >= MAJOR.height || R.lv >= 8 || Math.abs(area2(P)) >= MAJOR.area;
    const pass = { h: (R.top > 0 ? R.top : R.lv * 3.2 + 1) - R.mh, tagged: R.top > 0 || R.lv > 0 }; // (a passage under it: setback.js PASSAGE)
    const ts = performance.now(), sb = this.tap('sb', () => setBack(this.roads, P, major, false, pass)); this.setbacks.ms += performance.now() - ts;
    if (sb.drop) { this.setbacks.dropped++; return null; }
    if (sb.through) { this.setbacks.through++; return { P, holes, p0: P[0], through: true, pass: sb.pass }; }
    const p0 = P[0]; // (the building's look is seeded from its mapped corner: a cut one keeps it)
    if (sb.cut) { this.setbacks.cut++; P = area2(sb.P) < 0 ? sb.P.slice().reverse() : sb.P; holes = holes.filter((h) => holeInside(P, h)); }
    return { P, holes, p0, cut: sb.cut };
  }
  building(M, R, tall) {
    const W = this.w;
    // a tall one's tape (the baked setbacks: tap), its ground from the layout's surface first
    this.tp = !tall || this.curOrd == null ? null : this.tapes ? (this.tapes[this.curOrd] = { rec: true, raw: !!CityScenery.bake?.raw }) : this.ov ? this.ov.tapes[this.curOrd] && { ...this.ov.tapes[this.curOrd], at: {} } : null;
    if (this.tp && !this.tp.rec) this.ovStats.used++;
    const g = this.tap('g', () => CityScenery.bake?.ground.get(R.o) ?? null); if (g) { R.g0 = (R.g0 * 4 + g[0]) / 4; R.g1 = (R.g1 * 4 + g[1]) / 4; } // (quarter metres, from city.bin's)
    const F = this.footprint(R, tall);
    if (!F) return;
    const { P, holes, p0 } = F;
    const A = Math.abs(area2(P)) - holes.reduce((s, h) => s + Math.abs(area2(h)), 0);
    if (A < 6) return;
    const part = R.flags & 1, hseed = hash(Math.round(p0[0] * 4), Math.round(p0[1] * 4)), h2 = hash(R.o, 7), h3 = hash(R.o, 13);
    const LY = W.layout?.on && W.layout.place ? W.layout : null; if (LY) { // (a baked layout chunk, #294 ?layout=1: the ground under it the layout's, not the bake's)
      let a = Infinity, b = -Infinity; for (const p of P) { const y = LY.heightAt(p[0], p[1]); if (!(y === y)) { a = Infinity; break; } a = Math.min(a, y); b = Math.max(b, y); }
      if (a < Infinity) { R.g0 = a; R.g1 = b; } }
    const gm = (R.g0 + R.g1) / 2;
    let mx = 0, mz = 0; for (const p of P) { mx += p[0]; mz += p[1]; } mx /= P.length; mz /= P.length;
    // a part up in the air with nothing under it: down to the street; one on the ground inside a lower one: on its roof (base())
    let mh = R.mh;
    if (part) { const b = this.base(R, P, mh, R.top > 0 ? R.top : R.lv * 3.2 + 1); if (b !== mh) { if (b < mh) this.grounded++; else this.nested++; mh = b; } }
    const kind = R.kind, dense = this.tap('dense', () => this.dense(mx, mz)), tagged = R.top > 0 || R.lv > 0;
    // a small structure in a built-up spot (a kiosk, a newsstand, a booth, a pavilion in a plaza: Times Square's police
    // booth, the cafe kiosks in Bryant Park): one storey of shop windows under a flat roof, not a clapboard house
    const kiosk = !part && dense && A < 120 && kind !== 0 && kind !== 1 && kind !== 3 && (!tagged || R.top < 7);
    // height: the tag (NYC: measured roof heights), else levels, else by use and size
    let top = R.top > 0 ? R.top : R.lv > 0 ? R.lv * 3.2 + 1 : kiosk ? (A < 40 ? 3.2 : 4.5) : kind === 0 ? 8 : kind === 2 ? 3.5 : A > 400 ? 12 : 9.5;
    top = Math.max(top, mh + 2.5);
    const raised = part && mh > 0.5, yTop = gm + top, yBase = raised ? gm + mh : R.g0 - 3, yFloor = raised ? gm + mh : R.g0;
    const H = top - (part ? mh : 0);
    // ---- style
    const date = (R.flags >> 8) & 7, glassTag = R.flags & 4, brickTag = R.flags & 8, stoneTag = R.flags & 16, concTag = R.flags & 32, metalTag = R.flags & 64;
    let st; // { cell, col, bay, fl, ground: cell for the ground floor band, roof: 'flat' | 'gable' | 'hip', rcell, rcol, parapet }
    if (kiosk) { st = { cell: C.SHOPFRONT, col: pick(PAL.kiosk, hseed), bay: 3, fl: top - 0.4, kiosk: true }; this.kiosks++; }
    else if (kind === 3) st = { cell: C.LIME_WIN, col: pick(PAL.lime, hseed), bay: 3, fl: 4.5 };
    else if (top >= 25 || tall) {
      let pg = date >= 6 ? 0.88 : date === 5 ? 0.6 : date === 4 ? 0.4 : date >= 1 ? 0.02 : top > 150 ? 0.72 : top > 70 ? 0.48 : 0.22;
      if (glassTag) pg = 1; else if (brickTag || stoneTag) pg = 0;
      if (h2 < pg || metalTag) st = { cell: C.GLASS, col: R.flags & 128 ? c565(R.col) : pick(PAL.glass, hseed), bay: 6, fl: 4, glass: true }; // (wide bays: fewer, bolder mullions, less moire far away)
      else if (date >= 1 && date <= 3 || (date === 0 && h3 < 0.62) || brickTag || stoneTag) {
        // pre-war: limestone (ashlar, tall sash windows under lintels) or brick, deep reveals
        const stone = stoneTag || (!brickTag && h3 < 0.5);
        st = stone ? { cell: C.LIME_WIN, col: pick(PAL.lime, hseed), bay: 2.6, fl: 3.5 } : { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.8, fl: 3.3 };
        st.prewar = true;
      } else st = { cell: concTag || h3 < 0.8 ? C.APT : C.WIN_TALL, col: pick(PAL.concrete, hseed), bay: 3, fl: 3.4 };
      if (top < 120 && !st.glass && kind !== 6 && hash(R.o, 3) < 0.6) st.ground = true; // (shop fronts: facades())
      else if (st.glass) st.ground = true;
    } else if (kind === 4) st = h2 < 0.45 ? { cell: C.BRICK, col: pick(PAL.brick, hseed), bay: 3, fl: 4 } : h2 < 0.8 ? { cell: C.CONCRETE, col: pick(PAL.concrete, hseed), bay: 3, fl: 4 } : { cell: C.METAL, col: 0xc8ccd0, bay: 3, fl: 4 };
    else if (kind === 2) st = { cell: C.GARAGE, col: pick(PAL.concrete, hseed), bay: 3, fl: 3 };
    else if ((kind === 0 || kind === 7) && !dense && A < 200 && top < 11.5 && h2 < 0.55 && !brickTag) { // (among the towers a house is a townhouse: a brownstone, below)
      // a detached / semi-detached house: clapboard siding, pitched roof
      st = { cell: C.CLAP_WIN, col: pick(PAL.siding, hseed), bay: 3, fl: 3, roof: h3 < 0.65 ? 'gable' : 'hip', rcell: h3 < 0.3 ? C.SHINGLE : C.SLATE, rcol: pick(PAL.roofs, h3) };
    } else if (A < 220 && top < 20) {
      // row houses: brownstones and brick
      st = h2 < 0.35 ? { cell: C.BROWN_WIN, col: pick(PAL.brown, hseed), bay: 2.4, fl: 3.4 } : { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.6, fl: 3.1 };
      st.cornice = true; st.row = true;
    } else {
      // walk-ups, lofts, shops
      st = h2 < 0.62 ? { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.8, fl: 3.2 } : h2 < 0.82 ? { cell: C.LIME_WIN, col: pick(PAL.lime, hseed), bay: 2.6, fl: 3.4 } : { cell: C.APT, col: pick(PAL.concrete, hseed), bay: 3, fl: 3.1 };
      if (kind === 5 || (kind === 7 && h3 < 0.45)) st.ground = true;
      st.cornice = true;
    }
    if (R.flags & 128 && !st.glass) st.col = c565(R.col);
    // ---- roof shape
    let roof = st.roof || 'flat', rise = 0;
    const rc = R.roof; // 1 gabled 2 hipped 3 pyramidal 4 dome 5 onion 6 skillion 7 round 8 gambrel 9 mansard 10 cone 11 flat
    if (rc === 6) roof = 'skillion'; else if (rc === 1 || rc === 8 || rc === 7) roof = 'gable'; else if (rc === 2 || rc === 9) roof = 'hip'; else if (rc === 3 || rc === 10) roof = 'pyramid'; else if (rc === 4 || rc === 5) roof = 'dome'; else if (rc === 11) roof = 'flat';
    if (st.kiosk) roof = 'flat';
    let box = null;
    const fit = (b) => { const t0 = performance.now(), f = fitBox(this.roads, { x: b.cx, z: b.cz, ux: b.ux, uz: b.uz, hl: b.hl, hw: b.hw }); this.setbacks.ms += performance.now() - t0; return f; }; // (a box kept off the street, setback.js: an irregular footprint's reaches past its walls)
    if (roof === 'gable' || roof === 'hip' || roof === 'skillion') { box = obb(P); if (!box || box.hw > 14 || A / box.ar < 0.7 || (!F.through && this.tap('roof', () => !!fit(box).fit))) roof = 'flat'; } // (no pitched roof over the pavement)
    // a glass tower's sloped top (a skillion, a gable: the slanted crowns of Midtown's curtain walls) is its curtain wall
    // carried up at a slant, not a slate roof; a masonry building's pitched roof keeps to a roof's pitch (a roof:height
    // tag as tall as the building made its whole front a wall of slates)
    const glassTop = st.glass && roof !== 'flat';
    if (roof !== 'flat') {
      const rad = Math.sqrt(A / Math.PI);
      rise = R.rh > 0 ? R.rh : roof === 'pyramid' ? Math.min(H * 0.6, rad * 1.6) : roof === 'dome' ? Math.min(H * 0.5, rad) : Math.min(box.hw * (roof === 'skillion' ? 0.5 : 0.75), 5);
      if (!glassTop && box) rise = Math.min(rise, box.hw * (roof === 'skillion' ? 1.2 : 1.6)); // (at most ~58 degrees)
      rise = Math.min(rise, H - 1);
    }
    // a helipad's building (the tallest flat roof at its point): a bare roof for the deck, and it can't be knocked down
    const pad = tall && roof === 'flat' ? this.helipads.find((h) => inside(P, h.x, h.z)) : null;
    // ---- a crown, on a tower whose data gives it no shape of its own (no building:parts, no roof tag, a near-rectangle,
    // no mast or helipad on it). From the aerial photos: the pre-war towers step back near the top ("wedding cake"
    // setbacks) under a copper roof gone green, a slate hip, or a flat top with its plant room; the glass towers hide
    // their plant behind a louvred screen carried up past the roof. Its height comes off the top of the walls: the
    // measured roof height stays the building's top.
    let crown = null;
    if (tall && !part && roof === 'flat' && rc === 0 && top > 70 && !pad && !this.masts.some((m) => inside(P, m.x, m.z))) {
      const b = obb(P), hc = hash(R.o, 29);
      if (b && A / b.ar > 0.78 && b.hw > 9) {
        if (st.glass) crown = hc < 0.75 ? { kind: 'screen', h: Math.min(10, 5 + top * 0.015), b } : null;
        else if (st.prewar) crown = { kind: 'cake', h: Math.max(12, Math.min(45, top * 0.2)), tiers: top > 150 && b.hw > 14 ? 2 : 1, cap: hc < 0.4 ? 'copper' : hc < 0.65 ? 'slate' : 'flat', b };
      }
    }
    const eave = yTop - rise - (crown ? crown.h : 0), n0 = M.n, f0 = M.fw && [M.fw.box.n, M.fw.tank.n]; let wt = false;
    if (pad && !(pad.roof && pad.roof.y >= eave)) pad.roof = { y: eave, box: box || obb(P), P, g: gm };
    M.seed = (hseed * 255) | 0; M.yg = yFloor; M.color(st.col);
    // ---- walls: one quad a wall, the whole facade drawn by its program (buildings.js facade): the ground floor (shop
    // fronts, a rusticated base, the door) on the walls facing a street, the string course over it, the floors, and
    // the parapet carried up past a flat roof with its cornice. The floors are fitted between the ground floor and the
    // eave, so the cornice sits on a whole floor.
    const parapet = roof === 'flat' && !part && crown?.kind !== 'screen' && (tall || A > 120 || st.cornice) ? (st.glass ? 1.2 : st.cornice || st.prewar ? 1.0 : 0.9) : 0;
    // (a part standing on the street gets its ground floor too: in Midtown most towers are their building:parts)
    const F2 = raised ? null : this.facades(st, kind, parapet > 0, eave - yFloor);
    let yfV = yFloor, flV = st.fl;
    if (F2) { const up = eave - yFloor - F2.gH, nU = Math.max(1, Math.round(up / st.fl)); flV = up / nU; yfV = F2.gH > 0 ? yFloor + F2.gH - flV : yFloor; M.top = parapet ? nU + (F2.gH > 0 ? 1 : 0) : 0; }
    const street = F2 ? this.tap('walls', () => streetWalls(this.roads, P, REACH, F2.gH > 0 && !st.row && st.cell !== C.CLAP_WIN ? FRONT : 0, CONE)) : null, wTop = eave + parapet; // (the fallback: not for a house)
    // (what the streets got, for tools/test/bldcheck.js: the buildings other than houses and sheds standing on the
    // street with a wall facing one, and those whose street walls have a ground floor of their own)
    if (!raised && !st.kiosk && !st.row && st.cell !== C.CLAP_WIN && kind !== 2 && eave - yFloor >= 7) {
      const fr = street || this.tap('walls', () => streetWalls(this.roads, P, REACH, FRONT, CONE)), G = this.gf;
      if (fr.some(Boolean)) { G.front++; if (part) G.parts++; if (F2?.gH > 0) G.ground++; else if (G.miss.length < 5) G.miss.push([Math.round(mx), Math.round(mz), st.cell, Math.round(eave - yFloor)]); }
    }
    // a passage under it (setback.js PASSAGE: a road through a tall building): its walls stop at the passage's
    // underside where they cross the road, walls line it either side and a ceiling closes it over the road
    const pass = F.pass?.length ? F.pass : null, yPass = pass ? R.g1 + PASSAGE.clear : 0, cut = pass && yPass > yBase + 0.5 && yPass < eave - 2;
    const inPass = (x, z) => pass.some((s) => segD(s, x, z) < s[4]);
    const ring = (Q, inner, wI) => { // (wI: where each wall's indices start, and the last one's end: the far copy, farRec)
      const n = Q.length;
      for (let k = 0; k < n; k++) {
        wI?.push(M.ni);
        const a = Q[k], b = Q[(k + 1) % n], [p, r] = inner ? [a, b] : [b, a]; // outer walls b -> a (outside on the front)
        const front = !!street && !inner && street[k], nb = Math.max(1, Math.round(Math.hypot(r[0] - p[0], r[1] - p[1]) / st.bay));
        const wall = (y0, t0, t1) => {
          if (F2) M.wall(p[0], p[1], r[0], r[1], y0, wTop, yfV, front ? F2.front : F2.rear, st.bay, flV, front && !F2.endDoor ? -Math.floor(nb / 2) : 0, t0, t1);
          else M.wall(p[0], p[1], r[0], r[1], y0, wTop, yFloor, st.cell, st.bay, st.fl, 0, t0, t1);
        };
        if (!cut) { wall(yBase, 0, 1); continue; }
        for (const [t0, t1, over] of spans(p, r, inPass)) wall(over ? yPass : yBase, t0, t1);
      }
      wI?.push(M.ni);
    };
    const topW = M.top, wIo = M.far && [], wIh = holes.map(() => M.far && []); // (the walls' index runs and floor count: the far copy, farBuilding)
    ring(P, false, wIo); holes.forEach((h, k) => ring(h, true, wIh[k]));
    M.top = 0;
    if (cut) { this.passage(M, P, pass, yBase, yPass, inPass); this.passages.push([mx, mz, pass.length]); }
    // ---- roof
    let rLook = null, iR0 = M.ni, iR1 = M.ni;
    if (roof === 'flat') {
      rLook = this.roofLook(st, kind, top, hash(R.o, 37), hash(R.o, 41));
      M.color(rLook.col); iR0 = M.ni; M.roof(P, holes, eave, rLook.cell);
      const RS = this.roofStats; RS.flat++; RS.cells[rLook.cell] = (RS.cells[rLook.cell] || 0) + 1; RS.cols.add(rLook.col);
      iR1 = M.ni;
      if (crown) this.crown(M, R, st, P, crown, eave, yTop, yfV, flV, F2, rLook);
      // roof furniture (instances, FurnK: drawn near only): water tanks, bulkheads, plant rooms, rooftop units, hatches
      else if (!part && !pad && A > 60) {
        const b = box || obb(P);
        if (b && A / b.ar > 0.6 && b.hw > 2.2) { M.setLate(true); wt = this.roofTop(M, R, st, kind, P, b, eave, A, top, tall, rLook); M.setLate(false); }
      }
    } else if (roof === 'gable' || roof === 'hip' || roof === 'skillion') {
      const b = box, yaw = Math.atan2(b.ux, b.uz);
      if (glassTop) this.pitched(M, b, eave, rise, roof, C.GLASS, st.col, C.GLASS, st.col, yaw);
      else this.pitched(M, b, eave, rise, roof, st.rcell ?? C.SLATE, st.rcol ?? pick(PAL.roofs, h3), st.cell === C.CLAP_WIN ? C.CLAP : st.cell, st.col, yaw);
    } else {
      // spires and domes over the footprint: to the centroid
      let cx = 0, cz = 0; for (const p of P) { cx += p[0]; cz += p[1]; } cx /= P.length; cz /= P.length;
      M.color(st.glass ? 0xb8c0c8 : st.col);
      const rows = roof === 'dome' ? 4 : 1, cell = st.glass ? C.METAL : C.LIME;
      for (let r = 0; r < rows; r++) {
        const t0 = r / rows, t1 = (r + 1) / rows, s0 = roof === 'dome' ? Math.cos(t0 * Math.PI / 2) : 1 - t0, s1 = roof === 'dome' ? Math.cos(t1 * Math.PI / 2) : 1 - t1;
        const y0 = eave + rise * (roof === 'dome' ? Math.sin(t0 * Math.PI / 2) : t0), y1 = eave + rise * (roof === 'dome' ? Math.sin(t1 * Math.PI / 2) : t1);
        for (let k = 0; k < P.length; k++) {
          const a = P[k], b = P[(k + 1) % P.length];
          const A0 = [cx + (a[0] - cx) * s0, y0, cz + (a[1] - cz) * s0], B0 = [cx + (b[0] - cx) * s0, y0, cz + (b[1] - cz) * s0];
          if (s1 < 0.01) M.poly([B0, A0, [cx, y1, cz]], cell);
          else M.poly([B0, A0, [cx + (a[0] - cx) * s1, y1, cz + (a[1] - cz) * s1], [cx + (b[0] - cx) * s1, y1, cz + (b[1] - cz) * s1]], cell);
        }
      }
    }
    // ---- landmark extras (antenna masts: on the tallest building at the point, which comes first), collisions
    for (const m of this.masts) {
      if (m.done || !tall || !inside(P, m.x, m.z) || gm + m.top < yTop + 5) continue;
      m.done = true;
      M.color(0xd8dce0); M.cyl(m.x, m.z, yTop - 1, gm + m.top, 2.2, 0.3, 8, C.METAL);
      this.addBox({ cx: m.x, cz: m.z, ux: 1, uz: 0, hl: 2, hw: 2 }, yTop, gm + m.top, null);
    }
    // ---- its far copy (a tall group's far writer: farBuilding)
    const far = M.far ? farRec(M, M.far, { P, holes, wIo, wIh, iR0, iR1, topW, cut, F2, st, street, yBase, wTop, yfV, flV, yFloor, eave, rLook, flat: roof === 'flat' }) : -1;
    const b0 = box || obb(P);
    if (!b0) return;
    // the collision boxes: a near-rectangle's own box; an irregular footprint (an L, a U, a cross, a courtyard, a
    // trapezoid on a diagonal street) a few that hug its walls (setback.js footBoxes), so no box reaches out over its
    // yard or the street; each kept off the street (fitBox), unless a road runs through the building. An irregular
    // one's are worked out when something first needs them (lazyParts): its entry's box until then is the one round
    // its footprint, a metre out (FOOT.out: no box of its own reaches further), for the grid and the quick tests
    const tb = performance.now(), irr = (Q, H, q) => H.length || irregular(Q, Math.abs(area2(Q)) - H.reduce((m, h) => m + Math.abs(area2(h)), 0), q.cx, q.cz, q.ux, q.uz, q.hl, q.hw);
    let one = { cx: b0.cx, cz: b0.cz, ux: b0.ux, uz: b0.uz, hl: b0.hl, hw: b0.hw }; // (a near-rectangle: its box, off the street)
    let cut1 = false; if (!F.through) { const fb = this.tap('box', () => { const f = fit(one); return f.fit ? [f.x, f.z, f.hl, f.hw] : null; }), f = fb ? { x: fb[0], z: fb[1], ux: one.ux, uz: one.uz, hl: fb[2], hw: fb[3], fit: true } : { x: one.cx, z: one.cz, ux: one.ux, uz: one.uz, hl: one.hl, hw: one.hw }; cut1 = !!f.fit && 4 * f.hl * f.hw < 0.93 * A; one = { cx: f.x, cz: f.z, ux: f.ux, uz: f.uz, hl: f.hl, hw: f.hw }; }
    one = [{ x: one.cx, z: one.cz, ux: one.ux, uz: one.uz, hl: one.hl, hw: one.hw }];
    const lazy = cut1 || irr(P, holes, b0); // (cut1: its box moved in off the street leaves a slice of it bare, a trapezoid's along a slanted front: boxes that hug its walls)
    // over a passage: the whole building from the passage's underside up; below it, the parts either side of the road
    // (boxes kept off it: they stay standing, the rubble covers them if it comes down)
    if (cut) for (const C of this.tap('bp', () => this.besidePass(P, pass).map((Q) => { const q = obb(Q); if (!q) return [];
      return ((irr(Q, [], q) && cityParts(this, Q, [], q, true, true)) || [fit(q)]).filter((f) => intrusion(this.roads, [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => [f.x + f.ux * f.hl * u - f.uz * f.hw * v, f.z + f.uz * f.hl * u + f.ux * f.hw * v])) < 0.25); }))) {
      if (C.length) this.addParts(C, R.g0 - 1, yPass, this.curTile).below = true;
    }
    const y0 = cut ? yPass : raised ? yBase : R.g0 - 1, O = FOOT.out;
    const t = lazy ? this.addBox({ cx: b0.cx, cz: b0.cz, ux: b0.ux, uz: b0.uz, hl: b0.hl + O, hw: b0.hw + O }, y0, yTop, this.curTile) : this.addParts(one, y0, yTop, this.curTile);
    // (a big one too (FOOT.eager): its footprint kept exact. Under FOOT.retry covered (a campus of wings, a block of
    // courtyards): its first pass's boxes, then the footprint cut into squares a piece at a time (setback.js Refiner),
    // unless it's been hit by then)
    if (lazy) lazyBoxes(this, t, P, holes, { cx: b0.cx, cz: b0.cz, ux: b0.ux, uz: b0.uz }, !F.through, one, A > FOOT.eager, this.bt);
    this.footStats.n++; this.footStats.load += performance.now() - tb;
    if (F.through) t.through = true;
    if (cut) t.passage = true;
    if (pad) { t.fixed = true; return; } // (no damage key: destruction.js leaves it standing, whatever falls around it)
    // destructible (destruction.js): its vertices, what it's made of; damage done earlier this flight comes back with it
    t.dk = 'c' + R.o; t.rng = [[M, n0, M.n - n0]];
    if (f0) { const B = M.fw.box, K = M.fw.tank; if (B.n > f0[0]) t.rng.push([B, f0[0], B.n - f0[0]]); if (K.n > f0[1]) t.rng.push([K, f0[1], K.n - f0[1]]); } // (its roof furniture's instances: hidden with it)
    if (far >= 0) M.far.t[far] = t; // (its far copy's own vertices, when they're made: damaged with it, farStep)
    t.look = { cell: st.cell, col: st.col, rcol: rLook?.col ?? 0x5c5a56, glass: !!st.glass }; if (wt) t.type = 'waterTower';
    W.destruct?.restore(t);
  }
  // A building's far copy (record r of the group's pack, gf: its g.far), its triangles listed in L, three a triangle
  // (gf.I's: the group's own vertices; -1 - v: vertex v of F's, the job's writer, the same centre), its sector in S
  // (the way it faces, for farCell; -1: not upright): the walls round its footprint simplified (farRing: tol; a point
  // where the street walls start or stop kept, so each wall keeps its facade program; tol < 0: none), a wall left as
  // it was the near one (its bays, windows and lit windows the same), a wall that spans several written anew as
  // building() writes one; its flat roof over the simplified footprint (the near one if nothing was dropped); a
  // passage's walls as they are (the passage itself left out: from far away it's under the building); the rest
  // (crowns, pitched roofs, spires, masts) the near triangles.
  farBuilding(gf, r, tol, F, L, S) {
    const pk = gf.pk, A = pk.prm, o = r * FAR_NP, I = gf.I, cx = F.cx, cz = F.cz, fl = A[o + 2], cut = fl & 1, F2 = fl & 4, end = fl & 8;
    const front = A[o + 3], rear = A[o + 4], col = A[o + 5], bay = A[o + 6], cell = A[o + 7], flo = A[o + 8], yBase = A[o + 12], wTop = A[o + 13], yfV = A[o + 14], flV = A[o + 15], yFloor = A[o + 16];
    const sw = (2 * Math.PI) / SECT, sec = (px, pz, rx, rz) => { const nx = pz - rz, nz = rx - px; return nx || nz ? Math.min(SECT - 1, Math.floor(((Math.atan2(nz, nx) + 2 * Math.PI) % (2 * Math.PI)) / sw)) : -1; }; // (an upright wall p -> r: the way its winding faces)
    const near = (i0, i1, sc) => { for (let j = i0; j < i1; j += 3) { L.push(I[j], I[j + 1], I[j + 2]); S.push(sc); } };
    const own = (sc) => { const X = F.idx; for (let j = 0; j < F.ni; j += 3) { L.push(-1 - X[j], -1 - X[j + 1], -1 - X[j + 2]); S.push(sc); } F.ni = 0; };
    F.seed = A[o + 11]; F.yg = yFloor;
    let same = true, Ps = null; const Hs = [];
    for (let h = 0; h < A[o + 23]; h++) {
      const rg = (A[o + 22] + h) * 3, np = pk.rings[rg], po = pk.rings[rg + 1], eo = pk.rings[rg + 2], E = pk.edges, Pt = pk.pts, inner = h > 0;
      const Q = []; for (let k = 0; k < np; k++) Q.push([cx + Pt[(po + k) * 2] / PQ, cz + Pt[(po + k) * 2 + 1] / PQ]);
      const fr = !inner && fl & 16 ? (k) => pk.str[po + k] : null;
      const K = cut || tol < 0 ? null : farRing(Q, tol, fr ? (i) => fr((i + np - 1) % np) !== fr(i) : null), m = K ? K.length : np;
      if (K) same = false;
      F.color(col); F.top = A[o + 18];
      for (let q = 0; q < m; q++) {
        const ka = K ? K[q] : q, kb = K ? K[(q + 1) % m] : (q + 1) % np, [pi, ri] = inner ? [ka, kb] : [kb, ka]; // (outer walls b -> a: outside on the front)
        const sc = sec(Pt[(po + pi) * 2], Pt[(po + pi) * 2 + 1], Pt[(po + ri) * 2], Pt[(po + ri) * 2 + 1]);
        if (kb === (ka + 1) % np) { near(E[eo + ka], E[eo + ka + 1], sc); continue; } // (as it was)
        const p = Q[pi], rr = Q[ri], fw = !!fr && !!fr(ka), nb = Math.max(1, Math.round(Math.hypot(rr[0] - p[0], rr[1] - p[1]) / bay));
        if (F2) F.wall(p[0], p[1], rr[0], rr[1], yBase, wTop, yfV, fw ? front : rear, bay, flV, fw && !end ? -Math.floor(nb / 2) : 0);
        else F.wall(p[0], p[1], rr[0], rr[1], yBase, wTop, yFloor, cell, bay, flo, 0);
        own(sc);
      }
      F.top = 0;
      const Qs = K ? K.map((i) => Q[i]) : Q; if (inner) Hs.push(Qs); else Ps = Qs;
    }
    if (fl & 2) {
      if (same) near(A[o + 19], A[o + 20], -1);
      else { F.color(A[o + 9]); F.roof(Ps, Hs, A[o + 17], A[o + 10]); own(-1); }
    }
    near(A[o + 20], A[o + 21], -1);
  }
  // The far copies are made after load, a job at a time (each cell's copies; each group's coarser ones for its group
  // mesh), the jobs nearest the distance their mesh switches at first; a few buildings a frame (budget ms, or under the
  // test stepper units: stepClock.js). Until a cell's (a group's) copies exist it draws its near meshes as it did.
  farPlan(cam) {
    if (!this.farQ) {
      this.farQ = [];
      for (const g of this.tallGroups) {
        const gf = g.far; if (!gf) continue;
        const per = gf.cells.map(() => []); for (let r = 0; r < gf.pk.n; r++) per[gf.pk.prm[r * FAR_NP + 1]].push(r);
        per.forEach((recs, ci) => { if (recs.length && gf.cells[ci]) { this.farQ.push({ g, ci, recs, k: 0 }); gf.jobs++; } });
        const recs = []; for (let r = 0; r < gf.pk.n && gf.pk.prm[r * FAR_NP] >= LEVELS[LEVELS.length - 2]; r++) recs.push(r);
        if (recs.length) { this.farQ.push({ g, ci: -1, recs, k: 0 }); gf.jobs++; }
        if (!gf.jobs) this.farFree(g);
      }
    }
    if (!cam) return;
    const T = this.city.hdr.tile, nl = this.levelD.length;
    for (const j of this.farQ) {
      if (j.ci < 0) { const d = Math.hypot(j.g.x - cam.x, j.g.z - cam.z) - T * GROUP * 0.7; j.key = Math.abs(d - this.levelD[nl - 1]); continue; }
      const B = j.g.far.cells[j.ci].box, bx = Math.max(B[0] - cam.x, 0, cam.x - B[3]), by = Math.max(B[1] - cam.y, 0, cam.y - B[4]), bz = Math.max(B[2] - cam.z, 0, cam.z - B[5]);
      j.key = Math.abs(Math.hypot(bx, by, bz) - FAR.d);
    }
    const cur = this.farQ[0]?.F ? this.farQ.shift() : null; // (one under way stays first)
    this.farQ.sort((a, b) => a.key - b.key); if (cur) this.farQ.unshift(cur);
  }
  farStep(budget) {
    const Q = this.farQ; if (!Q?.length) return;
    const t0 = performance.now(), more = slice(budget, Math.ceil(budget * 16)), FS = this.farStats; let n = 0;
    while (Q.length && more()) {
      const j = Q[0], gf = j.g.far, grp = j.ci < 0;
      if (!j.F) { j.F = new MeshW(gf.M.cx, gf.M.cz, 1024); j.L = []; j.S = []; j.runs = []; j.lv = []; j.li = 0; }
      const r = j.recs[j.k++], F = j.F, n0 = F.n, l0 = j.L.length, s0 = j.S.length;
      if (grp) while (j.li < LEVELS.length - 1 && gf.pk.prm[r * FAR_NP] < LEVELS[j.li]) { j.lv.push(j.L.length); j.li++; }
      this.farBuilding(gf, r, grp ? FAR_TOL_G : FAR_TOL, F, j.L, j.S);
      if (gf.used + F.n > gf.room) { F.n = n0; F.ni = 0; j.L.length = l0; j.S.length = s0; this.farBuilding(gf, r, -1, F, j.L, j.S); FS.over++; } // (no room left: as it is)
      if (F.n > n0) j.runs.push(r, n0, F.n - n0);
      n++;
      if (j.k === j.recs.length) { Q.shift(); this.farFinish(j); }
    }
    const ms = performance.now() - t0; FS.steps++; FS.built += n; FS.ms += ms; FS.maxMs = Math.max(FS.maxMs, ms); if (!Q.length) FS.done = FS.steps;
  }
  farFlush() { this.farPlan(null); while (this.farQ.length) this.farStep(Infinity); }
  // a job's copies done: its own vertices into the group's room (damage already done to them written in, their run
  // added to the building's: destruction.js), its mesh
  farFinish(j) {
    const g = j.g, gf = g.far, F = j.F, G = gf.M.geo, base = g.nearN, b0 = base + gf.used, FS = this.farStats, at = G.attributes;
    if (F.n) {
      farPut(at.position, F.pos, b0, F.n); farPut(at.normal, F.nor, b0, F.n); farPut(at.uv, F.uv, b0, F.n); farPut(at.color, F.col, b0, F.n); farPut(at.atl, F.atl, b0, F.n);
      const dm = new Uint8Array(F.n), ds = this.w.destruct?.states;
      for (let q = 0; q < j.runs.length; q += 3) { const t = gf.pk.t[j.runs[q]]; if (!t) continue; const e = [gf.M, b0 + j.runs[q + 1], j.runs[q + 2]]; t.rng.push(e); const f = ds?.get(t.dk)?.flag; if (f) dm.fill(f, j.runs[q + 1], j.runs[q + 1] + j.runs[q + 2]); }
      farPut(at.dmg, dm, b0, F.n);
      gf.used += F.n; FS.verts += F.n;
    }
    const L = j.L, J = new (gf.I.constructor)(L.length); for (let k = 0; k < L.length; k++) { const v = L[k]; J[k] = v >= 0 ? v : b0 - 1 - v; }
    FS.hash = (FS.hash + farMix(farMix(farMix(0x9747b28c, L, L.length), F.pos, F.n * 3), F.atl, F.n * 4)) >>> 0; // (order-free: a sum)
    if (j.ci >= 0) { const c = gf.cells[j.ci]; c.fm = this.farCell(J, j.S, G, c, g.m); FS.tris += L.length / 3; }
    else { // (the group mesh's index, written over: never longer than the near one it replaces, level for level)
      while (j.lv.length < LEVELS.length - 1) j.lv.push(L.length);
      const ix = g.m.geometry.index;
      if (L.length <= ix.count) { farPut(ix, J, 0, L.length); g.lvF = j.lv; FS.groupTris += L.length / 3; FS.groupNear += g.lv[LEVELS.length - 2] / 3; }
    }
    j.F = j.L = j.S = null;
    if (!--gf.jobs) this.farFree(g);
  }
  farFree(g) { g.far.I = null; g.far.pk = null; } // (what they were made from: dropped)
  // A building's facade programs (buildings.js facade): { front: the walls facing a street, rear: the others, gH: its
  // ground floor's height, endDoor: the door at the wall's end (a row house's stoop), not its middle }. From the
  // reference photos: tenement and loft storefronts (a sign fascia and transom over display windows, a door every few
  // bays, the cornice over them), Striver's Row and the pre-war apartment houses (a rusticated stone base, the
  // entrance between pilasters, a string course, a bracketed cornice), brownstones (a raised rusticated basement under
  // the parlour floor), glass towers (a lobby of glass, a metal parapet), clapboard houses and warehouses (a door, a
  // loading door). null: plain walls (building parts, garages, anything too short for a ground floor of its own).
  facades(st, kind, parapet, hFl) {
    if (st.kiosk) return null; // (shop windows all round: its own cell)
    const u = st.cell, plain = { [C.LIME_WIN]: C.LIME, [C.BROWN_WIN]: C.LIME, [C.BRICK_WIN]: C.BRICK, [C.APT]: C.CONCRETE, [C.WIN_TALL]: C.CONCRETE, [C.GLASS]: C.METAL }[u] ?? u;
    const top = parapet ? plain : -1, cornice = parapet && !st.glass && (st.prewar || st.cornice || kind === 3);
    const brick = u === C.BRICK_WIN, stone = 0xd8ccb4; // (a brick building's base, string course and cornice: limestone)
    const mk = (o) => {
      if (o.gH > 0 && hFl - o.gH < 2.4) o = {}; // (no room for a floor over the ground floor: the floors' v would blow up)
      // (the cornice: cut stone or painted metal, cream over brick, whatever the parapet behind it is made of)
      const fr = cornice ? { top: C.LIME, bandCol: brick ? stone : undefined, ...o } : { top, ...o };
      return { front: facade({ upper: u, cornice, ...fr }), rear: facade({ upper: u, top, cornice: false }), gH: o.gH ?? 0, endDoor: !!o.endDoor };
    };
    if (kind === 2 || hFl < 4) return null;
    if (st.glass) return hFl >= 6.5 ? mk({ ground: C.SHOP3_N, gH: hFl > 9 ? 5 : hFl - 3, band: 0.35, bandCell: C.METAL, bandCol: 0x2a2c30 }) : mk({}); // (a low glass block: its lobby a storey, one floor over it)
    if (st.ground != null && hFl > 7) return mk({ ground: C.SHOPFRONT, door2: C.SHOP_DOOR, every: 3, gH: hFl > 30 ? 4.6 : 4.0, band: 0.55, bandCell: C.LIME, bandCol: brick ? stone : null, shop: true });
    if (u === C.CLAP_WIN) return mk({ ground: C.CLAP_WIN, gH: 3, door: C.CLAP_DOOR });
    if (u === C.BRICK || u === C.CONCRETE || u === C.METAL) return mk({ ground: u, gH: 4, door: C.GARAGE });
    if (kind === 3) return mk({ ground: u, gH: st.fl, door: C.RUST_DOOR });
    if (u === C.APT || u === C.WIN_TALL) return mk({ ground: u, gH: st.fl, door: C.SHOP_DOOR });
    if (st.row) // row houses: a raised basement, the door at one end
      return mk({ ground: C.RUST, door: C.RUST_DOOR, gH: 2.6, band: 0.3, bandCell: C.LIME, groundCol: brick ? 0x9a8670 : null, bandCol: brick ? 0x9a8670 : null, endDoor: true });
    if (hFl < 7) return mk({});
    // apartment houses and pre-war towers: a rusticated base (double height on a tower), the entrance in the middle
    return mk({ ground: C.RUST, door: C.RUST_DOOR, gH: hFl > 30 ? 5 : 3.6, band: hFl > 30 ? 0.5 : 0.35, bandCell: C.LIME, groundCol: brick ? stone : null, bandCol: brick ? stone : null });
  }
  // A passage under a building, where a road runs through it (setback.js PASSAGE): each clear zone's two sides lined
  // with walls from the street up to the underside, inside the footprint and outside the other zones (concrete, facing
  // the road), and the underside a ceiling over the road. Walls and ceiling only where the footprint is.
  passage(M, P, segs, y0, y1, inPass) {
    M.color(0xa8a49c);
    for (const s of segs) {
      const [ax, az, bx, bz, r] = s, L = Math.hypot(bx - ax, bz - az); if (L < 0.5) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux, others = segs.filter((o) => o !== s);
      for (const sd of [1, -1]) { // (the left side's wall faces right: drawn b -> a)
        const oa = [ax + nx * r * sd, az + nz * r * sd], ob = [bx + nx * r * sd, bz + nz * r * sd], [p, q] = sd > 0 ? [ob, oa] : [oa, ob];
        for (const [t0, t1, ok] of spans(p, q, (x, z) => inside(P, x, z) && !others.some((o) => segD(o, x, z) < o[4] - 0.05))) if (ok) M.wall(p[0], p[1], q[0], q[1], y0, y1, y0, C.CONCRETE, 3, 3, 0, t0, t1);
      }
      let Q = clip(P, ux, uz, ax, az, 0); if (Q.length >= 3) Q = clip(Q, -ux, -uz, bx, bz, 0);
      if (Q.length >= 3) Q = clip(Q, nx, nz, ax, az, -r); if (Q.length >= 3) Q = clip(Q, -nx, -nz, ax, az, -r);
      if (Q.length >= 3 && Math.abs(area2(Q)) > 0.5) M.roof(area2(Q) < 0 ? Q.slice().reverse() : Q, [], y1, C.CONCRETE, true);
    }
  }
  // the footprint's parts beside the roads through it (for their collision boxes): cut along each road's clear zone,
  // both sides kept (the six longest roads; pieces of 15 m2 and more)
  besidePass(P, segs) {
    let parts = [P];
    for (const s of segs.slice().sort((a, b) => Math.hypot(b[2] - b[0], b[3] - b[1]) - Math.hypot(a[2] - a[0], a[3] - a[1])).slice(0, 6)) {
      const [ax, az, bx, bz, r] = s, L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L, next = [];
      for (const Q of parts) for (const sd of [1, -1]) { const K = clip(Q, nx * sd, nz * sd, ax, az, r); if (K.length >= 3 && Math.abs(area2(K)) >= 15) next.push(K); }
      parts = next;
    }
    return parts;
  }
  pitched(M, b, y, rise, roof, cell, col, gcell, gcol, yaw) {
    const { cx, cz, ux, uz, hl, hw } = b, nx = -uz, nz = ux, o = 0.4, ex = hw + o, el = hl + o, ye = y - o * rise / hw, yr = y + rise;
    const p = (a, c, yy) => [cx + ux * a + nx * c, yy, cz + uz * a + nz * c];
    M.color(col);
    if (roof === 'skillion') { // one slope, up from the eave on one long side to the top of a wall on the other
      M.poly([p(-el, ex, ye), p(el, ex, ye), p(el, -hw, yr), p(-el, -hw, yr)], cell);
      M.color(gcol);
      M.poly([p(hl, hw, y), p(hl, -hw, y), p(hl, -hw, yr)], gcell); M.poly([p(-hl, -hw, y), p(-hl, hw, y), p(-hl, -hw, yr)], gcell);
      M.poly([p(hl, -hw, y), p(-hl, -hw, y), p(-hl, -hw, yr), p(hl, -hw, yr)], gcell);
      return;
    }
    if (roof === 'gable') {
      M.poly([p(-el, ex, ye), p(el, ex, ye), p(el, 0, yr), p(-el, 0, yr)], cell);
      M.poly([p(el, -ex, ye), p(-el, -ex, ye), p(-el, 0, yr), p(el, 0, yr)], cell);
      M.color(gcol);
      M.poly([p(hl, hw, y), p(hl, -hw, y), p(hl, 0, yr)], gcell); M.poly([p(-hl, -hw, y), p(-hl, hw, y), p(-hl, 0, yr)], gcell);
    } else {
      const r = Math.max(0, el - ex);
      M.poly([p(-el, ex, ye), p(el, ex, ye), p(r, 0, yr), p(-r, 0, yr)], cell);
      M.poly([p(el, -ex, ye), p(-el, -ex, ye), p(-r, 0, yr), p(r, 0, yr)], cell);
      M.poly([p(el, ex, ye), p(el, -ex, ye), p(r, 0, yr)], cell);
      M.poly([p(-el, -ex, ye), p(-el, ex, ye), p(-r, 0, yr)], cell);
    }
  }
  // ---------------- roofs ----------------
  // A flat roof's surface (from the aerial photos: most of Manhattan's flat roofs are light, white and grey sheet
  // membranes or aluminium-coated tar, with black tar on older walk-ups, gravel ballast, a few quarry-tiled terraces and
  // planted roofs): { cell, col (MeshW's linear bytes), kind }
  roofLook(st, kind, top, u, v) {
    const k = st.glass ? (u < 0.5 ? 'membrane' : u < 0.8 ? 'silver' : 'gravel')
      : u < 0.3 ? 'membrane' : u < 0.48 ? 'silver' : u < 0.68 ? 'tar' : u < 0.88 ? 'gravel' : u < 0.96 || top > 40 ? 'pavers' : 'green';
    return { cell: { membrane: C.ROOF_MEMBRANE, silver: C.ROOF_TAR, tar: C.ROOF_TAR, gravel: C.ROOF_GRAVEL, pavers: C.PAVERS, green: C.ROOF_GRAVEL }[k], col: pick(ROOF[k], v), kind: k };
  }
  // a box standing on a roof (bulkheads, plant rooms, rooftop units; a hatch: no walls, its top topCell, s m a repeat):
  // its four walls and a tarred top. An instance (FurnK 'box') where the writer has its cell's (always, in the city)
  block(M, x, z, ux, uz, hu, hn, y0, y1, cell, col, top = ROOF.tar[0], topCell = C.ROOF_TAR, s = 3) {
    if (M.fw) { M.fw.box.add(x - M.fw.cx, y0, z - M.fw.cz, ux, uz, 2 * hu, Math.max(y1 - y0, 1e-4), 2 * hn, s, cell, topCell, M.seed, lyOf(M, y0), col, top, Math.hypot(hu, hn), y1 - y0); return; }
    const nx = -uz, nz = ux, Q = [[-hu, hn], [hu, hn], [hu, -hn], [-hu, -hn]].map(([a, b]) => [x + ux * a + nx * b, z + uz * a + nz * b]);
    M.color(col);
    for (let k = 0; k < 4; k++) { const p = Q[k], q = Q[(k + 1) % 4]; M.wall(p[0], p[1], q[0], q[1], y0, y1, y0, cell, 3, 3); }
    M.color(top); M.poly(Q.map((p) => [p[0], y1, p[1]]), topCell, s);
  }
  // The wooden water tank on its steel stand (traced from the SoHo and Midtown rooftop photos): silver-grey cedar staves
  // bound with steel hoops (WTANK, v 0..1 the whole tank), a low conical roof with a little overhang, on a deep steel
  // platform, the stand cross-braced (FRAME, cut out) and anything from a metre to two storeys tall. D: the tank's
  // diameter, legs: the stand's height
  tank(M, x, z, ux, uz, D, y, legs, h) { // (an instance, FurnK 'tank': its stand's corners reach 0.72 D out, its roof 1.28 D over the legs and platform)
    M.fw.tank.add(x - M.fw.cx, y, z - M.fw.cz, ux, uz, D, D, D, legs, 0, 0, M.seed, lyOf(M, y), pick(TANK.staves, h), pick(TANK.cone, (h * 7.3) % 1), 0.73 * D, legs + 0.4 + 1.29 * D);
  }
  // A flat roof's furniture (instances, FurnK: drawn near only), from the rooftop photos: on the pre-war apartment houses
  // and walk-ups the water tank on its stand at one end and the stair / elevator bulkhead at the other, in the
  // building's own brick or stone; on the towers a plant room (louvred, or the building's masonry); rooftop units and
  // hatches scattered between (Medium up). Returns whether it got a tank (destruction.js: the splash).
  roofTop(M, R, st, kind, P, b, y, A, top, tall, look) {
    const F = this.furn, RS = this.roofStats, hh = (k) => hash(R.o, k), { cx, cz, ux, uz, hl, hw } = b, nx = -uz, nz = ux;
    const at = (u, n) => [cx + ux * u + nx * n, cz + uz * u + nz * n], taken = [];
    const fits = (u, n, hu, hn) => { // (inside the footprint, clear of the parapet and of what's already there)
      if (Math.abs(u) + hu > hl - 0.6 || Math.abs(n) + hn > hw - 0.6) return false;
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) { const q = at(u + a * hu, n + c * hn); if (!inside(P, q[0], q[1])) return false; }
      for (const t of taken) if (Math.abs(u - t[0]) < hu + t[2] + 0.5 && Math.abs(n - t[1]) < hn + t[3] + 0.5) return false;
      taken.push([u, n, hu, hn]); return true;
    };
    const glass = !!st.glass, masonry = { [C.BRICK_WIN]: C.BRICK, [C.LIME_WIN]: C.LIME, [C.BROWN_WIN]: C.LIME, [C.BRICK]: C.BRICK }[st.cell] ?? C.CONCRETE;
    const side = hh(43) < 0.5 ? 1 : -1; let wt = false;
    // the bulkhead / plant room
    if (glass || (tall && top > 35)) {
      const pu = Math.min(hl * 0.42, 14), pn = Math.min(hw * 0.5, 10), ph = 4 + hh(47) * 3, u = -side * Math.max(0, hl - pu - 0.6) * 0.6 * hh(53);
      const lv = glass || hh(59) < 0.35;
      if (fits(u, 0, pu, pn)) { const q = at(u, 0); this.block(M, q[0], q[1], ux, uz, pu, pn, y, y + ph, lv ? C.LOUVRE : masonry, lv ? pick(ROOF.plant, hh(61)) : st.col); RS.plant++; }
    } else if (top > 17 || (top > 9 && F.stair)) {
      const big = top > 17, bu = Math.min(big ? 2.6 : 1.7, hl * 0.4), bn = Math.min(big ? 1.9 : 1.3, hw * 0.4), bh = big ? 3.4 : 2.6;
      const u = -side * Math.max(0, hl - bu - 0.8) * (0.4 + 0.6 * hh(53)), n = (hh(61) - 0.5) * Math.max(0, hw - bn - 0.8);
      if (fits(u, n, bu, bn)) { const q = at(u, n); this.block(M, q[0], q[1], ux, uz, bu, bn, y, y + bh, masonry, st.col); RS.bulkheads++; }
    }
    // the water tank(s): buildings over six storeys need one (and plenty of lower ones kept theirs); none on glass
    const prewar = st.prewar || st.cornice, pT = glass ? 0 : prewar ? (top > 17 ? 0.7 : 0.3) : kind === 4 ? 0.4 : st.cell === C.APT ? 0.3 : 0.15;
    if (top > 12 && top < 150 && hh(19) < pT * (F.tanks ?? 1)) { // (Low: three in four of them)
      const D = Math.min(2.6 + Math.sqrt(A) * 0.06 + hh(23) * 1.3, 6.4, hw * 1.5 - 1.4);
      if (D >= 2.6) {
        const r = D / 2, legs = hh(67) < 0.5 ? 1 + hh(71) * 1.5 : 3 + hh(71) * 3.5, u = side * Math.max(0, hl - r - 0.9) * (0.55 + 0.45 * hh(73)), n = (hh(79) - 0.5) * Math.max(0, hw - r - 0.9);
        for (const [n2, go] of [[n, true], [n + (n > 0 ? -1 : 1) * D * 1.25, A > 1000 && hh(89) < 0.4]]) {
          if (!go || !fits(u, n2, r * 1.05, r * 1.05)) break;
          const q = at(u, n2); this.tank(M, q[0], q[1], ux, uz, D, y, legs, go === true && n2 === n ? hh(83) : hh(85)); wt = true; RS.tanks++;
        }
      }
    }
    // rooftop units (louvred cabinets) and hatches
    for (let k = 0; k < F.units; k++) {
      if (hh(97 + k) > (glass || tall ? 0.8 : 0.45)) continue;
      const uu = 0.6 + hh(101 + k) * 0.8, un = 0.45 + hh(103 + k) * 0.5, u = (hh(107 + k) - 0.5) * 2 * Math.max(0, hl - uu - 1), n = (hh(109 + k) - 0.5) * 2 * Math.max(0, hw - un - 1);
      if (fits(u, n, uu, un)) { const q = at(u, n); this.block(M, q[0], q[1], ux, uz, uu, un, y, y + 1.1 + hh(113 + k) * 0.8, C.LOUVRE, pick(ROOF.unit, hh(127 + k)), ROOF.unit[0]); RS.units++; }
    }
    for (let k = 0; k < F.hatch; k++) {
      const u = (hh(131 + k) - 0.5) * 2 * Math.max(0, hl - 2), n = (hh(137 + k) - 0.5) * 2 * Math.max(0, hw - 2);
      if (!fits(u, n, 0.5, 0.5)) continue;
      const q = at(u, n), hc = look.kind === 'tar' ? ROOF.hatchLight : ROOF.hatch; this.block(M, q[0], q[1], ux, uz, 0.5, 0.5, y + 0.15, y + 0.15, C.METAL, hc, hc, C.METAL, 1); RS.hatches++;
    }
    return wt;
  }
  // A tall tower's crown (building(): crown { kind, h, b }), from the walls' top (eave) to its measured top
  crown(M, R, st, P, cr, eave, yTop, yfV, flV, F2, look) {
    const RS = this.roofStats, { b } = cr;
    // floodlit at night (buildings.js floodlit: lit from below, dusk to 2 a.m.), from the night photos: most of the
    // pre-war towers' crowns and caps, half the flat-topped ones, a few of the glass towers' screens
    const fh = hash(R.o, 71), flood = cr.kind === 'screen' ? fh < 0.35 : cr.cap === 'flat' ? fh < 0.5 : fh < 0.85, lit = (id) => (flood ? floodlit(id) : id);
    if (flood) RS.flood++;
    if (cr.kind === 'screen') { // a louvred screen round the roof (both faces: from above its inside shows too), the plant behind it
      M.color(ROOF.screen); const lv = lit(C.LOUVRE);
      for (let k = 0; k < P.length; k++) { const a = P[k], c = P[(k + 1) % P.length]; M.wall(c[0], c[1], a[0], a[1], eave, yTop, eave, lv, 3, 3); M.wall(a[0], a[1], c[0], c[1], eave, yTop, eave, C.LOUVRE, 3, 3); }
      M.setLate(true); this.block(M, b.cx, b.cz, b.ux, b.uz, b.hl * 0.4, b.hw * 0.45, eave, yTop - 1.5, C.LOUVRE, pick(ROOF.plant, hash(R.o, 61))); M.setLate(false); RS.crownBox++;
      RS.screen++; RS.crowns?.push([b.cx, b.cz, 'screen', Math.round(yTop)]); return;
    }
    // wedding-cake setbacks: one or two tiers stepped in, each to a whole floor with its cornice; the top one capped
    const rect = (s) => { const Q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [b.cx + b.ux * a * b.hl * s - b.uz * c * b.hw * s, b.cz + b.uz * a * b.hl * s + b.ux * c * b.hw * s]); return area2(Q) < 0 ? Q.reverse() : Q; };
    const n = cr.tiers, sOf = (t) => (n === 1 ? 0.7 : 1 - 0.2 * t), sN = sOf(n);
    const capR = cr.cap === 'flat' ? 0 : Math.min(b.hw * sN * 0.8, cr.h * 0.45), cell = lit(F2 ? F2.front : st.cell);
    let y0 = eave;
    for (let t = 1; t <= n; t++) {
      const last = t === n, want = eave + ((cr.h - capR) * t) / n, nf = Math.max(1, Math.round((want - yfV) / flV)), yk = Math.max(y0 + flV * 0.99, yfV + nf * flV);
      const par = last && cr.cap !== 'flat' ? 0 : 1.0, Q = rect(sOf(t));
      M.color(st.col); M.top = par ? Math.round((yk - yfV) / flV) : 0;
      for (let k = 0; k < 4; k++) { const a = Q[k], c = Q[(k + 1) % 4]; M.wall(c[0], c[1], a[0], a[1], y0 - 0.5, yk + par, yfV, cell, st.bay, flV); }
      M.top = 0;
      if (last && cr.cap !== 'flat') {
        const copper = cr.cap === 'copper', bt = { cx: b.cx, cz: b.cz, ux: b.ux, uz: b.uz, hl: b.hl * sOf(t), hw: b.hw * sOf(t) };
        this.pitched(M, bt, yk, Math.max(3, yTop - yk), 'hip', lit(copper ? C.SEAM : C.SLATE), copper ? pick(ROOF.copper, hash(R.o, 31)) : ROOF.slate, cell, st.col, 0);
        if (copper) RS.copper++;
      } else { M.color(look.col); M.roof(Q, [], yk, look.cell); }
      y0 = yk;
    }
    if (cr.cap === 'flat') { M.setLate(true); this.block(M, b.cx, b.cz, b.ux, b.uz, b.hl * sN * 0.45, b.hw * sN * 0.5, y0, y0 + 4, C.LIME, st.col); M.setLate(false); RS.crownBox++; }
    RS.cake++; RS.crowns?.push([b.cx, b.cz, cr.cap, Math.round(yTop)]);
  }

  // ---------------- collisions: oriented boxes in a 50 m grid ----------------
  addBox(b, y0, y1, tileKey) {
    const t = [b.cx, y0, b.cz, y1 - y0, Math.hypot(b.hl, b.hw), b.ux, b.uz, b.hl, b.hw];
    t.solid = true; t.tile = tileKey;
    const r = t[4], k0 = Math.floor((b.cx - r) / 50), k1 = Math.floor((b.cx + r) / 50), j0 = Math.floor((b.cz - r) / 50), j1 = Math.floor((b.cz + r) / 50);
    for (let i = k0; i <= k1; i++) for (let j = j0; j <= j1; j++) { const k = i + ',' + j; let a = this.grid.get(k); if (!a) this.grid.set(k, (a = [])); a.push(t); }
    if (tileKey) { const T = this.tiles.get(tileKey); (T.keys || (T.keys = new Set())); for (let i = k0; i <= k1; i++) for (let j = j0; j <= j1; j++) T.keys.add(i + ',' + j); }
    return t;
  }
  // a building's boxes (setback.js footBoxes: [{ x, z, ux, uz, hl, hw }]): one collision entry, its box the one
  // round them all, the boxes themselves in t.parts (what's solid: hit, World.wallBoxes; its damage is the building's)
  addParts(B, y0, y1, tileKey) {
    const b = B.length > 1 ? boundBox(B) : B[0], t = this.addBox({ cx: b.x, cz: b.z, ux: b.ux, uz: b.uz, hl: b.hl, hw: b.hw }, y0, y1, tileKey);
    if (B.length > 1) t.parts = B;
    return t;
  }
  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) {
      if (p.y > t[1] + t[3] || p.y < t[1]) continue;
      const dx = p.x - t[0], dz = p.z - t[2];
      if (Math.abs(dx * t[5] + dz * t[6]) < t[7] && Math.abs(-dx * t[6] + dz * t[5]) < t[8] && (!t.parts || inParts(t.parts, p.x, p.z))) return t;
    }
    return null;
  }

  // ---------------- low buildings: streamed by tile ----------------
  buildLowStep(t, budget) {
    const U = this.city.U, S = this.city.S, R = {}, t0 = performance.now(), r0 = t.st?.r ?? 0; // (r0: under the test stepper, 32 records per ms of budget a step, stepClock.js)
    const st = t.st || (t.st = { o: t.lowOff, r: 0, cells: new Map() }); // (one writer per LOW_CELL cell of the tile)
    const minA = this.qn === 'low' ? 60 : this.qn === 'medium' ? 25 : 0;
    this.curTile = t.i + ',' + t.j; this.bt = t; this.curLines = this.lines?.get(t) || null; /* (its building lines: TileLines) */
    while (st.r < t.nLow) {
      readRec(U, S, st.o, this.q, ...this.tileCentre(t.i, t.j), R); st.o = R.next; st.r++;
      if (this.skipped(R)) continue;
      if (minA && Math.abs(area2(R.P)) < minA) break; // sorted by area: the rest are smaller still
      const ck = this.cellKey(R.P, LOW_CELL, t); let M = st.cells.get(ck);
      if (!M) { st.cells.set(ck, (M = new MeshW(...this.cellCentre(ck, LOW_CELL), 4096))); M.fw = st.fw || (st.fw = furnW(...this.tileCentre(t.i, t.j))); }
      const v0 = M.n; this.lastFoot = this.lastBase = null; this.building(M, R, false);
      const ob = M.n > v0 && this.occluder(R, false); if (ob) { ob.ck = ck; (st.occ || (st.occ = [])).push(ob); }
      if ((st.r & 31) === 0 && (STEP.on ? st.r - r0 >= budget * 32 : performance.now() - t0 > budget)) { this.curTile = this.bt = this.curLines = null; return false; }
    }
    this.curTile = this.bt = this.curLines = null;
    t.st = null; t.low = true; t.meshes = []; t.tris = 0; // (t.low: built; t.meshes: its cells' meshes)
    const cellM = new Map();
    for (const [ck, M] of st.cells) {
      if (!M.n) continue;
      const m = M.mesh(this.mat); m.castShadow = W_SHADOW(this.w); m.receiveShadow = true; binBounds(m, m.geometry.attributes.position.array, m.geometry.index.array, m.geometry.index.count, 4); // (its bounds in columns: occlude())
      t.tris += M.ni / 3; t.meshes.push(m); this.group.add(m); cellM.set(ck, m);
    }
    t.occL = (st.occ || []).filter((ob) => (ob.m = cellM.get(ob.ck)));
    t.furn = []; this.furnMeshes(st.fw, t.furn, true, W_SHADOW(this.w));
    return true;
  }
  // a cell's roof furniture (its writers, furnW): an InstancedMesh per kind, into the scene and the list L (own: their
  // own copy of the unit shapes, a low tile's: disposed with it)
  furnMeshes(fw, L, own, sh) {
    if (!fw) return;
    for (const K of [fw.box, fw.tank]) {
      if (!K.n) continue;
      this.furnMade[K.kind] += K.n;
      const f = K.mesh(this.fmat, this.furn, own, fw.cx, fw.cz); f.userData.kind = K.kind; f.castShadow = sh; f.receiveShadow = true; f.visible = own; L.push(f); this.group.add(f);
    }
  }
  // the roof furniture instances standing now (tall: in the cells' meshes; low: the tiles built), by kind
  furnCount() {
    const out = { tall: { box: 0, tank: 0 }, low: { box: 0, tank: 0 }, made: { ...this.furnMade }, meshes: 0 };
    const add = (L, o) => { for (const f of L || []) { o[f.userData.kind] += f.count; out.meshes++; } };
    for (const g of this.tallGroups) add(g.furn, out.tall);
    for (const t of this.tiles.values()) add(t.furn, out.low);
    return out;
  }
  dropLow(t) {
    for (const m of t.meshes || []) { this.group.remove(m); m.geometry.dispose(); }
    for (const f of t.furn || []) { this.group.remove(f); f.geometry.dispose(); f.dispose(); }
    t.furn = null;
    t.low = null; t.meshes = null; t.st = null; t.tris = 0; t.occL = null;
    const key = t.i + ',' + t.j;
    if (t.keys) for (const k of t.keys) { const a = this.grid.get(k); if (a) { const b = a.filter((x) => x.tile !== key); if (b.length) this.grid.set(k, b); else this.grid.delete(k); } }
    t.keys = null;
  }
  update(dt, cam) {
    if (!cam) return;
    const H = this.city.hdr, T = H.tile;
    // tall buildings: fewer far away (draw range by height level, the whole group one mesh); near, every height, a
    // mesh per cell (culled each on its own), the roof furniture (its indices last) only nearer still
    const nl = this.levelD.length;
    for (const g of this.tallGroups) {
      const d = Math.hypot(g.x - cam.x, g.z - cam.z) - T * GROUP * 0.7, near = d <= this.levelD[nl - 1], sh = this.shadows && d < 2500; // (shadow maps reach a few km: no need to draw the far skyline into them)
      for (const c of g.cells) {
        const f = c.fm, B = c.box;
        if (!near) { c.m.visible = false; if (f) f.visible = false; continue; }
        // (past FAR.d from the cell's box: its far mesh, farCell)
        const bx = Math.max(B[0] - cam.x, 0, cam.x - B[3]), by = Math.max(B[1] - cam.y, 0, cam.y - B[4]), bz = Math.max(B[2] - cam.z, 0, cam.z - B[5]), far = !!f && bx * bx + by * by + bz * bz > FAR.d * FAR.d;
        c.m.visible = !far; if (f) f.visible = far;
        if (far) { f.castShadow = sh; this.farRange(f, cam, sh); continue; }
        c.m.geometry.setDrawRange(0, d > this.furnD ? c.main : c.all); c.m.castShadow = sh;
      }
      for (const f of g.furn) { f.visible = near && d <= this.furnD; f.castShadow = sh; } // (its roof furniture's instances, FurnK)
      const lv = g.lvF || g.lv; let n = 0; if (!near) for (let k = 0; k < nl; k++) if (d > this.levelD[nl - 1 - k]) n = lv[nl - 1 - k]; // (lvF: its far copies, once made)
      g.m.geometry.setDrawRange(0, n); g.m.visible = n > 0; g.m.castShadow = sh;
    }
    // low tiles: plan every ~100 m of camera movement, build one tile at a time (a few ms a frame)
    const R = this.lowR;
    if (!this.lastPlan || Math.hypot(cam.x - this.lastPlan.x, cam.z - this.lastPlan.z) > 100) {
      this.lastPlan = { x: cam.x, z: cam.z }; this.farMoved = true;
      const want = [];
      for (const t of this.tiles.values()) {
        if (!t.nLow) continue;
        const [cx, cz] = this.tileCentre(t.i, t.j), d = Math.max(0, Math.hypot(cx - cam.x, cz - cam.z) - T * 0.7);
        if (d < R) { if (!t.low) want.push([d, t]); }
        else if (d > R + 600 && (t.low || t.st)) this.dropLow(t);
      }
      this.queue = want.sort((a, b) => a[0] - b[0]).map((w) => w[1]);
    }
    const budget = this.qn === 'low' || this.qn === 'medium' ? 3 : 5;
    const LY = this.w.layout; let go = true; if (LY && this.queue.length && !this.queue[0].low) { // (a baked layout chunk not in yet under the next tile: the first tile whose ground is ready first, #294)
      const ready = (t) => { const [cx, cz] = this.tileCentre(t.i, t.j); return LY.readyIn(cx - T / 2 - 40, cz - T / 2 - 40, cx + T / 2 + 40, cz + T / 2 + 40); };
      const k = this.queue.findIndex((t) => t.st || (ready(t) && (!this.lines || this.lines.get(t)))); if (k < 0) go = false; /* (and its building lines in: TileLines) */ else if (k > 0) this.queue.unshift(...this.queue.splice(k, 1)); }
    while (go && this.queue.length) {
      const t = this.queue[0];
      if (t.low) { this.queue.shift(); continue; }
      if (this.buildLowStep(t, budget)) this.queue.shift();
      break;
    }
    if (!this.queue.length && this.refiner.jobs.length) this.refiner.step(STEP.on ? Infinity : 1, STEP.on ? 2 : Infinity); // (the low tiles first; then a huge footprint's boxes, a millisecond a frame)
    if (!this.queue.length) { if (!this.farQ || this.farMoved) { this.farPlan(cam); this.farMoved = false; } this.farStep(budget); } // (then the far copies: farStep)
    const k = this.w.lightsK ?? (this.w.night ? 1 : 0); this.mat.emissiveIntensity = this.fmat.emissiveIntensity = 1.6 * Math.min(1, k / 0.12); // (buildings.js updateBuildingLights: which windows, by hour)
  }
  // A box wholly inside the building just built (its walls from footprint(), its record): from the ground to under its
  // eave, inscribed in its footprint 2 m in from the walls (occlusion.js inscribedBox; not its collision boxes, which
  // can stand out past its walls, #295). None for what doesn't stand on the street all the way up (a passage or a road
  // through it, a part raised off the ground or standing on a podium), one too small to matter, or one whose height
  // building() doesn't take from the record (untagged; a kiosk). Its eave is taken as low as building() could put it:
  // under the tallest crown it could get, a pitched roof's or a spire's rise at its most. (occlude() also leaves it out
  // while the camera is in the building, its walls seen from inside, or within a metre of it: the near plane.)
  occluder(R, tall) {
    const F = this.lastFoot; if (!F || F.through || F.pass?.length || !(R.top > 0 || R.lv > 0)) return null;
    const part = R.flags & 1, mh = part ? this.lastBase ?? R.mh : R.mh;
    if (part && mh > 0.5) return null;
    let top = R.top > 0 ? R.top : R.lv * 3.2 + 1; if (top < 7) return null;
    const A = Math.abs(area2(F.P)) - F.holes.reduce((s, h) => s + Math.abs(area2(h)), 0); if (A < (tall ? 120 : OCC.lowA)) return null;
    top = Math.max(top, mh + 2.5);
    const rc = R.roof, H = top - (part ? mh : 0);
    let cut = rc === 0 || rc === 11 ? (tall && !part && rc === 0 && top > 70 ? Math.max(12, Math.min(45, top * 0.2)) : 0) : R.rh > 0 ? R.rh : Math.max(5, H * 0.6);
    if (top < 11.5) cut = Math.max(cut, 5); // (a house's pitched roof)
    const y0 = R.g0, y1 = (R.g0 + R.g1) / 2 + top - cut - 0.5;
    if (y1 - y0 < 5) return null;
    const b = obb(F.P), q = b && inscribedBox(F.P, F.holes, b, 2); if (!q) return null;
    const hh = (y1 - y0) / 2;
    return { x: q.cx, y: y0 + hh, z: q.cz, ux: q.ux, uz: q.uz, hl: q.hl, hw: q.hw, hh, r: Math.hypot(q.hl, q.hw, hh), a: (q.hl + q.hw) * hh, dk: 'c' + R.o, ck: 0, m: null, s: 0, b: [b.cx, b.cz, b.ux, b.uz, b.hl + 1, b.hw + 1, (R.g0 + R.g1) / 2 + top + 1] };
  }
  // Occlusion culling near the ground (occlusion.js): the building meshes behind the nearest buildings taken off the
  // camera's layers for this frame (still in the shadow maps). With the frame's final camera, right before it's drawn
  // (main.js; not from update(): traffic calls that before the camera has moved for the frame).
  occlude(cam, renderer) {
    if (renderer) shadowsSeeOccluded(renderer);
    const hid = this.occHidden || (this.occHidden = []), W = this.w;
    for (const m of hid) m.layers.set(0); // (a cell mesh and its roof furniture each tested and hidden on its own)
    hid.length = 0;
    const S = this.occStats || (this.occStats = { on: false, cands: 0, occluders: 0, corners: 0, pixels: 0, tested: 0, hidden: 0, tris: 0, ms: 0 });
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements, x = e[12], y = e[13], z = e[14];
    S.on = OCC.on && y - W.heightAt(x, z) < OCC.h;
    if (!S.on) { S.cands = S.occluders = S.corners = S.pixels = S.tested = S.hidden = S.tris = S.ms = 0; return; }
    const t0 = performance.now(), B = this.occBuf || (this.occBuf = new OcclusionBuffer());
    B.begin(cam);
    // the occluders of the tiles within r: in front of the camera, standing undamaged (destruction.js), drawn
    const fx = -e[8], fy = -e[9], fz = -e[10], H = this.city.hdr, T = H.tile, R = OCC.r, ds = W.destruct?.states;
    const C = this.occCand || (this.occCand = []); C.length = 0;
    for (let i = Math.floor((x - R - H.x0) / T); i <= Math.floor((x + R - H.x0) / T); i++) for (let j = Math.floor((z - R - H.z0) / T); j <= Math.floor((z + R - H.z0) / T); j++) {
      const t = this.tiles.get(i + ',' + j); if (!t) continue;
      for (const L of [t.occ, t.occL]) if (L) for (const o of L) {
        const dx = o.x - x, dy = o.y - y, dz = o.z - z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R * R || dx * fx + dy * fy + dz * fz < -o.r || !o.m?.visible || !o.m.parent || ds?.has(o.dk)) continue;
        const b = o.b, bx = x - b[0], bz = z - b[1]; // (the camera in the building, or within a metre of its walls: its walls don't hide anything from it)
        if (y < b[6] && Math.abs(bx * b[2] + bz * b[3]) < b[4] && Math.abs(-bx * b[3] + bz * b[2]) < b[5]) continue;
        o.s = o.a / Math.max(d2, 1); C.push(o);
      }
    }
    C.sort((a, b) => b.s - a.s);
    const st = B.stats;
    for (let k = 0; k < C.length && k < OCC.max * 2 && st.occluders < OCC.max && st.corners < OCC.corners; k++) { const o = C[k]; B.box(o.x, o.y, o.z, o.ux, o.uz, o.hl, o.hw, o.hh); }
    // the building meshes being drawn: hidden where wholly behind them
    let tris = 0;
    const test = (m) => {
      if (!m.visible || !B.hidden(worldBounds(m))) return;
      m.layers.set(OCC_LAYER); hid.push(m);
      const g = m.geometry; tris += (Math.min(g.index.count, g.drawRange.count) / 3) * (m.isInstancedMesh ? m.count : 1);
    };
    for (const g of this.tallGroups) { test(g.m); for (const c of g.cells) { test(c.m); if (c.fm) test(c.fm); } for (const f of g.furn) test(f); } // (the roof furniture's instances: their own boxes, FurnK.mesh)
    for (const t of this.tiles.values()) { if (t.meshes) for (const m of t.meshes) test(m); if (t.furn) for (const f of t.furn) test(f); }
    Object.assign(S, { cands: C.length, occluders: st.occluders, corners: st.corners, pixels: st.pixels, tested: st.tested, hidden: st.hidden, tris, ms: performance.now() - t0 });
  }
  // everything near the camera built (the loading screen waits for this on the first frames)
  get ready() { return !this.queue.length || this.queue.every((t) => !!t.low); }
  info() {
    let lowTris = 0, lowTiles = 0, lowMeshes = 0; for (const t of this.tiles.values()) if (t.meshes?.length) { lowTris += t.tris; lowTiles++; lowMeshes += t.meshes.length; }
    let occT = 0, occL = 0; for (const t of this.tiles.values()) { occT += t.occ?.length ?? 0; occL += t.occL?.length ?? 0; }
    return { tall: this.stats.tall, tallTris: this.stats.tris, farTris: this.farStats.tris, tallMeshes: this.tallMeshes.length, lowTiles, lowMeshes, lowTris, msTall: this.msTall, occluders: { tall: occT, low: occL } };
  }
}
const W_SHADOW = (W) => W.qBase === 'high';
