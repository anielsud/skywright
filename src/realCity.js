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
import { buildingMaterial, buildingDepthMaterial, dmgAttr, C, BLD_U } from './buildings.js';
import { toLocal } from './realworld.js';

const PQ = 16; // GPU position units per metre: int16 positions relative to each mesh's centre (+-2 km, 6 cm steps)
const GROUP = 2; // tall buildings: one mesh per GROUP x GROUP data tiles
const LOW_R = { low: 900, medium: 1600, high: 2400, ultra: 2600 }; // low buildings within this distance of the camera
const LEVELS = [150, 70, 35, 0]; // tall meshes, sorted by height: a far mesh draws only buildings >= LEVELS[k] m
const LEVEL_D = { low: [5000, 3000, 1800], medium: [8000, 5000, 3000], high: [14000, 8000, 5000], ultra: [15000, 9000, 5500] };
const half = THREE.DataUtils.toHalfFloat;
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ---------------- palettes (tints over the photo atlas cells) ----------------
const PAL = {
  brick: [0x9a6050, 0x8a5446, 0x8e6656, 0x7a4e42, 0xa88068, 0xa8947e, 0xc8bca8, 0x94604e, 0xd8d2c8],
  brown: [0x7a4e3c, 0x8a5c44, 0x6e4636, 0x94664c],
  lime: [0xe6dcc6, 0xd6c8ac, 0xcfc2a8, 0xe8e2d4, 0xc8bca4, 0xdcd4c4],
  glass: [0x8fb0c8, 0x7aa0a8, 0xb4c2cc, 0x5a6c7c, 0x9aaabb, 0x9fb4a8, 0x6f8aa8, 0xc0c8cc],
  concrete: [0xd0ccc4, 0xb8b4ac, 0xdcd8d0, 0xc4c0b6],
  siding: [0xeae6dc, 0xd8dce0, 0xe4d4b4, 0xc8d4c0, 0xf0e8e0, 0xd8c8b8],
  roofs: [0x5a5c60, 0x6a6c70, 0x7a6a5c, 0x6e4a3c, 0x4e5056],
};

// ---------------- mesh writer: the buildings.js vertex layout, quantised ----------------
export class MeshW {
  constructor(cx, cz, cap = 8192) { this.cx = cx; this.cz = cz; this.n = 0; this.ni = 0; this.cap = 0; this.idx = new Uint32Array(cap * 2); this.grow(cap); this.seed = 0; this.yg = 0; }
  grow(need) {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2), cp = (A, T, k) => { const b = new T(cap * k); if (A) b.set(A.subarray(0, this.n * k)); return b; };
    this.pos = cp(this.pos, Int16Array, 3); this.nor = cp(this.nor, Int8Array, 3); this.uv = cp(this.uv, Uint16Array, 2); this.col = cp(this.col, Uint8Array, 3); this.atl = cp(this.atl, Uint8Array, 4); this.cap = cap;
  }
  growI(k) { if (this.ni + k > this.idx.length) { const b = new Uint32Array(Math.max(this.ni + k, this.idx.length * 2)); b.set(this.idx); this.idx = b; } }
  color(hex) { this.cr = (hex >> 16) & 255; this.cg = (hex >> 8) & 255; this.cb = hex & 255; }
  v(x, y, z, nx, ny, nz, u, w, cell) {
    const i = this.n++, P = this.pos, k = i * 3;
    P[k] = Math.round((x - this.cx) * PQ); P[k + 1] = Math.round(y * PQ); P[k + 2] = Math.round((z - this.cz) * PQ);
    this.nor[k] = nx * 127; this.nor[k + 1] = ny * 127; this.nor[k + 2] = nz * 127;
    this.uv[i * 2] = half(u); this.uv[i * 2 + 1] = half(w);
    this.col[k] = this.cr; this.col[k + 1] = this.cg; this.col[k + 2] = this.cb;
    const a = i * 4; this.atl[a] = cell; this.atl[a + 1] = this.seed; this.atl[a + 2] = Math.max(0, Math.min(255, (y - this.yg) * 8));
    return i;
  }
  // vertical wall seen from outside, a -> b: u counts bays, v floors (from yf, the floor datum)
  wall(ax, az, bx, bz, y0, y1, yf, cell, bay, fl) {
    const L = Math.hypot(bx - ax, bz - az); if (L < 0.05 || y1 - y0 < 0.05) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux, nb = Math.max(1, Math.round(L / bay)), v0 = (y0 - yf) / fl, v1 = (y1 - yf) / fl;
    this.grow(this.n + 4); this.growI(6);
    const o = this.n;
    this.v(ax, y0, az, nx, 0, nz, 0, v0, cell); this.v(bx, y0, bz, nx, 0, nz, nb, v0, cell); this.v(bx, y1, bz, nx, 0, nz, nb, v1, cell); this.v(ax, y1, az, nx, 0, nz, 0, v1, cell);
    const I = this.idx, k = this.ni; I[k] = o; I[k + 1] = o + 1; I[k + 2] = o + 2; I[k + 3] = o; I[k + 4] = o + 2; I[k + 5] = o + 3; this.ni += 6;
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
    this.grow(this.n + n); this.growI((n - 2) * 3);
    const o = this.n;
    for (const p of P) { const dx = p[0] - a[0], dy = p[1] - a[1], dz = p[2] - a[2]; this.v(p[0], p[1], p[2], nx, ny, nz, (dx * tx + dy * ty + dz * tz) / s, (dx * bx + dy * by + dz * bz) / s, cell); }
    for (let k = 1; k < n - 1; k++) { const I = this.idx, j = this.ni; I[j] = o; I[j + 1] = o + k; I[j + 2] = o + k + 1; this.ni += 3; }
  }
  // flat roof over a footprint (x, z pairs) with holes, at height y, facing up
  roof(P, holes, y, cell) {
    const ct = P.map((p) => new THREE.Vector2(p[0], p[1])), hs = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(ct, hs); } catch (e) { return; }
    const all = [...P, ...holes.flat()], n = all.length, ox = P[0][0], oz = P[0][1];
    this.grow(this.n + n); this.growI(tris.length * 3);
    const o = this.n;
    for (const p of all) this.v(p[0], y, p[1], 0, 1, 0, (p[0] - ox) / 3, (p[1] - oz) / 3, cell);
    for (const [a, b, c] of tris) {
      const A = all[a], B = all[b], Cc = all[c], up = (B[1] - A[1]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[1] - A[1]) > 0;
      const I = this.idx, j = this.ni; I[j] = o + a; I[j + 1] = o + (up ? b : c); I[j + 2] = o + (up ? c : b); this.ni += 3;
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
    for (const a of [...Object.values(g.attributes), g.index]) a.onUpload(function () { this.array = new this.array.constructor(0); });
    const m = new THREE.Mesh(g, mat); m.customDepthMaterial = buildingDepthMaterial();
    m.position.set(this.cx, 0, this.cz); m.scale.setScalar(1 / PQ); m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}

// ---------------- reading city.bin ----------------
function readRec(U, S, o, q, cx, cz, R) {
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
const c565 = (c) => { const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31; return ((r * 255 / 31) << 16) | ((g * 255 / 63) << 8) | (b * 255 / 31); };
const pick = (a, h) => a[Math.floor(h * a.length) % a.length];

// ---------------- the city ----------------
export class CityScenery {
  constructor(world, D, group) {
    const W = (this.w = world);
    this.D = D; this.group = group; this.city = D.city; const H = D.city.hdr;
    this.q = H.q; this.T = H.tile;
    this.qn = W.qName;
    this.grid = new Map(); // 50 m cells -> collision boxes
    this.lowR = LOW_R[W.qName] ?? 1600;
    this.detail = W.qBase === 'high'; // parapets, shop fronts and roof furniture (medium / low: plain walls and roofs, half the vertices)
    this.levelD = LEVEL_D[W.qName] ?? LEVEL_D.medium;
    this.mat = buildingMaterial({ cellPx: { low: 128, medium: 192, ultra: 384 }[W.qName] ?? 256, interiors: W.qName !== 'low', glass: true });
    // (lit windows: set in update, dimmer than a village's; thousands of them in view)
    this.tiles = new Map(); for (const t of H.tiles) this.tiles.set(t[0] + ',' + t[1], { i: t[0], j: t[1], off: t[2], nTall: t[3], nLow: t[4], low: null });
    const cfg = W.loc.city || {};
    this.masts = (cfg.masts || []).map((m) => { const [x, z] = toLocal(D.meta, m.lat, m.lon); return { ...m, x, z }; });
    this.hole = cfg.statue ? toLocal(D.meta, cfg.statue.lat, cfg.statue.lon) : null; // footprints there: drawn as a model
    const t0 = performance.now();
    this.stats = { tall: 0, low: 0, tris: 0 };
    this.buildTall();
    this.msTall = performance.now() - t0;
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
    this.tallMeshes = [];
    const R = {};
    for (const [k, ts] of groups) {
      // all the group's tall records, tallest first
      const recs = [];
      for (const t of ts) {
        const [cx, cz] = this.tileCentre(t.i, t.j);
        let o = t.off;
        for (let r = 0; r < t.nTall; r++) { readRec(U, S, o, this.q, cx, cz, R); recs.push({ o, cx, cz, top: R.top + R.mh * 0 }); o = R.next; }
        t.lowOff = o;
      }
      recs.sort((a, b) => b.top - a.top);
      const [gi, gj] = k.split(',').map(Number), gcx = H.x0 + (gi + 0.5) * GROUP * H.tile, gcz = H.z0 + (gj + 0.5) * GROUP * H.tile;
      const M = new MeshW(gcx, gcz, 16384), lv = [];
      let li = 0;
      for (const rc of recs) {
        while (li < LEVELS.length - 1 && rc.top < LEVELS[li]) { lv.push(M.ni); li++; }
        readRec(U, S, rc.o, this.q, rc.cx, rc.cz, R);
        if (this.skipped(R)) continue;
        this.building(M, R, true);
        this.stats.tall++;
      }
      while (lv.length < LEVELS.length - 1) lv.push(M.ni);
      if (!M.n) continue;
      const mesh = M.mesh(this.mat);
      mesh.castShadow = W_SHADOW(this.w); mesh.receiveShadow = true;
      this.group.add(mesh);
      this.stats.tris += M.ni / 3;
      this.tallMeshes.push({ m: mesh, x: gcx, z: gcz, lv, all: M.ni });
    }
    for (const t of this.tiles.values()) if (t.lowOff == null) t.lowOff = t.off; // (tiles with no tall buildings)
  }

  skipped(R) { if (!this.hole) return false; const p = R.P[0]; return Math.hypot(p[0] - this.hole[0], p[1] - this.hole[1]) < 60; }

  // ---------------- one building (or part) ----------------
  building(M, R, tall) {
    const W = this.w;
    let P = simplify(R.P, tall ? 0.35 : 0.5);
    if (P.length < 3) return;
    if (area2(P) < 0) P.reverse();
    const holes = R.holes.map((h) => { const Q = simplify(h, 0.5); if (area2(Q) < 0) Q.reverse(); return Q; }).filter((h) => h.length >= 3);
    const A = Math.abs(area2(P)) - holes.reduce((s, h) => s + Math.abs(area2(h)), 0);
    if (A < 6) return;
    const part = R.flags & 1, hseed = hash(Math.round(P[0][0] * 4), Math.round(P[0][1] * 4)), h2 = hash(R.o, 7), h3 = hash(R.o, 13);
    const gm = (R.g0 + R.g1) / 2;
    // height: the tag (NYC: measured roof heights), else levels, else by use and size
    let top = R.top > 0 ? R.top : R.lv > 0 ? R.lv * 3.2 + 1 : R.kind === 0 ? 8 : R.kind === 2 ? 3.5 : A > 400 ? 12 : 9.5;
    top = Math.max(top, R.mh + 2.5);
    const yTop = gm + top, yBase = part && R.mh > 0.5 ? gm + R.mh : R.g0 - 3, yFloor = part && R.mh > 0.5 ? gm + R.mh : R.g0;
    const H = top - (part ? R.mh : 0);
    // ---- style
    const date = (R.flags >> 8) & 7, glassTag = R.flags & 4, brickTag = R.flags & 8, stoneTag = R.flags & 16, concTag = R.flags & 32, metalTag = R.flags & 64;
    let st; // { cell, col, bay, fl, ground: cell for the ground floor band, roof: 'flat' | 'gable' | 'hip', rcell, rcol, parapet }
    const kind = R.kind;
    if (kind === 3) st = { cell: C.STONE_WIN, col: pick(PAL.lime, hseed), bay: 3, fl: 4.5 };
    else if (top >= 25 || tall) {
      let pg = date >= 6 ? 0.88 : date === 5 ? 0.6 : date === 4 ? 0.4 : date >= 1 ? 0.02 : top > 150 ? 0.72 : top > 70 ? 0.48 : 0.22;
      if (glassTag) pg = 1; else if (brickTag || stoneTag) pg = 0;
      if (h2 < pg || metalTag) st = { cell: C.GLASS, col: R.flags & 128 ? c565(R.col) : pick(PAL.glass, hseed), bay: 6, fl: 4, glass: true }; // (wide bays: fewer, bolder mullions, less moire far away)
      else if (date >= 1 && date <= 3 || (date === 0 && h3 < 0.62) || brickTag || stoneTag) {
        // pre-war: limestone or brick, small windows, deep reveals
        const stone = stoneTag || (!brickTag && h3 < 0.5);
        st = stone ? { cell: C.STONE_WIN, col: pick(PAL.lime, hseed), bay: 2.6, fl: 3.5 } : { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.8, fl: 3.3 };
        st.prewar = true;
      } else st = { cell: concTag || h3 < 0.8 ? C.APT : C.WIN_TALL, col: pick(PAL.concrete, hseed), bay: 3, fl: 3.4 };
      if (top < 120 && !st.glass && kind !== 6 && hash(R.o, 3) < 0.6) st.ground = pick([C.SHOP_N, C.SHOP2_N, C.SHOP3_N, C.SHOP3_N], hash(R.o, 5));
      else if (st.glass) st.ground = C.SHOP3_N;
    } else if (kind === 4) st = h2 < 0.45 ? { cell: C.BRICK, col: pick(PAL.brick, hseed), bay: 3, fl: 4 } : h2 < 0.8 ? { cell: C.CONCRETE, col: pick(PAL.concrete, hseed), bay: 3, fl: 4 } : { cell: C.METAL, col: 0xc8ccd0, bay: 3, fl: 4 };
    else if (kind === 2) st = { cell: C.GARAGE, col: pick(PAL.concrete, hseed), bay: 3, fl: 3 };
    else if ((kind === 0 || kind === 7) && A < 200 && top < 11.5 && h2 < 0.55 && !brickTag) {
      // a detached / semi-detached house: clapboard siding, pitched roof
      st = { cell: C.CLAP_WIN, col: pick(PAL.siding, hseed), bay: 3, fl: 3, roof: h3 < 0.65 ? 'gable' : 'hip', rcell: h3 < 0.3 ? C.SHINGLE : C.SLATE, rcol: pick(PAL.roofs, h3) };
    } else if (A < 220 && top < 20) {
      // row houses: brownstones and brick
      st = h2 < 0.35 ? { cell: C.STONE_WIN, col: pick(PAL.brown, hseed), bay: 2.4, fl: 3.4 } : { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.6, fl: 3.1 };
      st.cornice = true;
    } else {
      // walk-ups, lofts, shops
      st = h2 < 0.62 ? { cell: C.BRICK_WIN, col: pick(PAL.brick, hseed), bay: 2.8, fl: 3.2 } : h2 < 0.82 ? { cell: C.STONE_WIN, col: pick(PAL.lime, hseed), bay: 2.6, fl: 3.4 } : { cell: C.APT, col: pick(PAL.concrete, hseed), bay: 3, fl: 3.1 };
      if (kind === 5 || (kind === 7 && h3 < 0.45)) st.ground = pick([C.SHOP_N, C.SHOP2_N, C.SHOP3_N, C.SHOP, C.SHOP2], hash(R.o, 5));
      st.cornice = true;
    }
    if (R.flags & 128 && !st.glass) st.col = c565(R.col);
    // ---- roof shape
    let roof = st.roof || 'flat', rise = 0;
    const rc = R.roof; // 1 gabled 2 hipped 3 pyramidal 4 dome 5 onion 6 skillion 7 round 8 gambrel 9 mansard 10 cone 11 flat
    if (rc === 1 || rc === 8 || rc === 7 || rc === 6) roof = 'gable'; else if (rc === 2 || rc === 9) roof = 'hip'; else if (rc === 3 || rc === 10) roof = 'pyramid'; else if (rc === 4 || rc === 5) roof = 'dome'; else if (rc === 11) roof = 'flat';
    let box = null;
    if (roof === 'gable' || roof === 'hip') { box = obb(P); if (!box || box.hw > 14 || A / box.ar < 0.7) roof = 'flat'; }
    if (roof !== 'flat') {
      const rad = Math.sqrt(A / Math.PI);
      rise = R.rh > 0 ? R.rh : roof === 'pyramid' ? Math.min(H * 0.6, rad * 1.6) : roof === 'dome' ? Math.min(H * 0.5, rad) : Math.min(box.hw * 0.75, 5);
      rise = Math.min(rise, H - 1);
    }
    const eave = yTop - rise, n0 = M.n; let wt = false;
    M.seed = (hseed * 255) | 0; M.yg = yFloor; M.color(st.col);
    // ---- walls: an optional ground floor band (shops / lobby), then the floors
    const gTop = this.detail && st.ground != null && eave - yFloor > 8 ? yFloor + 4.2 : null;
    const ring = (Q, inner) => {
      const n = Q.length;
      for (let k = 0; k < n; k++) {
        const a = Q[k], b = Q[(k + 1) % n], [p, r] = inner ? [a, b] : [b, a]; // outer walls b -> a (outside on the front)
        if (gTop != null) { M.wall(p[0], p[1], r[0], r[1], yBase, gTop, yFloor, st.ground, 3, 4.2); M.wall(p[0], p[1], r[0], r[1], gTop, eave, yFloor, st.cell, st.bay, st.fl); }
        else M.wall(p[0], p[1], r[0], r[1], yBase, eave, yFloor, st.cell, st.bay, st.fl);
      }
    };
    ring(P, false); for (const h of holes) ring(h, true);
    // ---- roof
    const flatCell = st.glass ? C.SEAM : h3 < 0.6 ? C.ASPHALT : C.GRAVEL; // tar and gravel roofs (the photo cells are bright: the tint barely reaches them)
    if (roof === 'flat') {
      const parapet = this.detail && (tall || A > 120) && !part ? (st.glass ? 1.2 : st.cornice || st.prewar ? 1.0 : 0.9) : 0;
      if (parapet) {
        M.color(st.glass ? 0x9aa0a6 : st.col);
        for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; M.wall(b[0], b[1], a[0], a[1], eave, eave + parapet, eave, st.glass ? C.METAL : st.cell === C.BRICK_WIN ? C.BRICK : st.cell === C.CLAP_WIN ? C.CLAP : C.STONE, 3, 3); }
      }
      M.color(st.glass ? 0x6e7074 : pick([0x6a6660, 0x5c5a56, 0x76706a, 0x54524f, 0x4a4846], h3)); // tar, gravel, concrete
      M.roof(P, holes, eave, flatCell);
      // roof furniture: a plant room on the towers, water tanks on the pre-war and walk-up roofs
      if (this.detail && !part && A > 250) {
        const b = box || obb(P);
        if (b && A / b.ar > 0.6) {
          if (tall && top > 35 && hash(R.o, 17) < 0.7) {
            M.color(st.glass ? 0x9aa0a6 : pick(PAL.concrete, h3));
            M.box(b.cx, b.cz, b.ux, b.uz, b.hl * 0.45, b.hw * 0.5, eave, eave + 4 + h3 * 3, st.glass ? C.METAL : C.CONCRETE);
          }
          if (!st.glass && top > 14 && top < 90 && hash(R.o, 19) < (st.prewar || st.cornice ? 0.45 : 0.15)) { this.waterTower(M, b, eave, hash(R.o, 23)); wt = true; }
        }
      }
    } else if (roof === 'gable' || roof === 'hip') {
      const b = box, yaw = Math.atan2(b.ux, b.uz);
      this.pitched(M, b, eave, rise, roof, st.rcell ?? C.SLATE, st.rcol ?? pick(PAL.roofs, h3), st.cell === C.CLAP_WIN ? C.CLAP : st.cell, st.col, yaw);
    } else {
      // spires and domes over the footprint: to the centroid
      let cx = 0, cz = 0; for (const p of P) { cx += p[0]; cz += p[1]; } cx /= P.length; cz /= P.length;
      M.color(st.glass ? 0xb8c0c8 : st.col);
      const rows = roof === 'dome' ? 4 : 1, cell = st.glass ? C.METAL : C.STONE;
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
    const b = box || obb(P);
    if (!b) return;
    const t = this.addBox({ cx: b.cx, cz: b.cz, ux: b.ux, uz: b.uz, hl: b.hl * (A / b.ar > 0.7 ? 1 : 0.85), hw: b.hw * (A / b.ar > 0.7 ? 1 : 0.85) }, part && R.mh > 0.5 ? yBase : R.g0 - 1, yTop, this.curTile);
    // destructible (destruction.js): its vertices, what it's made of; damage done earlier this flight comes back with it
    t.dk = 'c' + R.o; t.rng = [[M, n0, M.n - n0]]; t.look = { cell: st.cell, col: st.col, rcol: 0x5c5a56, glass: !!st.glass }; if (wt) t.type = 'waterTower';
    W.destruct?.restore(t);
  }
  pitched(M, b, y, rise, roof, cell, col, gcell, gcol, yaw) {
    const { cx, cz, ux, uz, hl, hw } = b, nx = -uz, nz = ux, o = 0.4, ex = hw + o, el = hl + o, ye = y - o * rise / hw, yr = y + rise;
    const p = (a, c, yy) => [cx + ux * a + nx * c, yy, cz + uz * a + nz * c];
    M.color(col);
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
  // the wooden water tank on its steel legs (a New York roof classic)
  waterTower(M, b, y, h) {
    const r = Math.min(2.2 + h * 1.2, b.hw * 0.8), o = Math.max(0, b.hl - r - 0.6) * (h < 0.5 ? -1 : 1), x = b.cx + b.ux * o, z = b.cz + b.uz * o, legs = 3.5; // at one end (clear of a plant room)
    M.color(0x3a3a3a);
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) M.box(x + a * r * 0.6, z + c * r * 0.6, 1, 0, 0.15, 0.15, y, y + legs, C.METAL);
    M.color(pick([0x8a6a50, 0x7a5c44, 0x9a7a5a, 0x6a5040], h));
    M.cyl(x, z, y + legs, y + legs + r * 1.6, r, r, 10, C.BOARDS);
    M.color(0x4a4440); M.cyl(x, z, y + legs + r * 1.6, y + legs + r * 1.6 + r * 0.6, r * 1.05, 0, 10, C.SLATE);
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
  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) {
      if (p.y > t[1] + t[3] || p.y < t[1]) continue;
      const dx = p.x - t[0], dz = p.z - t[2];
      if (Math.abs(dx * t[5] + dz * t[6]) < t[7] && Math.abs(-dx * t[6] + dz * t[5]) < t[8]) return t;
    }
    return null;
  }

  // ---------------- low buildings: streamed by tile ----------------
  buildLowStep(t, budget) {
    const U = this.city.U, S = this.city.S, R = {}, t0 = performance.now();
    const st = t.st || (t.st = { o: t.lowOff, r: 0, M: new MeshW(...this.tileCentre(t.i, t.j), 4096) });
    const minA = this.qn === 'low' ? 60 : this.qn === 'medium' ? 25 : 0;
    this.curTile = t.i + ',' + t.j;
    while (st.r < t.nLow) {
      readRec(U, S, st.o, this.q, ...this.tileCentre(t.i, t.j), R); st.o = R.next; st.r++;
      if (this.skipped(R)) continue;
      if (minA && Math.abs(area2(R.P)) < minA) break; // sorted by area: the rest are smaller still
      this.building(st.M, R, false);
      if ((st.r & 31) === 0 && performance.now() - t0 > budget) { this.curTile = null; return false; }
    }
    this.curTile = null;
    const M = st.M; t.st = null;
    if (M.n) {
      t.low = M.mesh(this.mat); t.low.castShadow = W_SHADOW(this.w); t.low.receiveShadow = true;
      t.tris = M.ni / 3; this.group.add(t.low);
    } else t.low = true;
    return true;
  }
  dropLow(t) {
    if (t.low && t.low !== true) { this.group.remove(t.low); t.low.geometry.dispose(); }
    t.low = null; t.st = null; t.tris = 0;
    const key = t.i + ',' + t.j;
    if (t.keys) for (const k of t.keys) { const a = this.grid.get(k); if (a) { const b = a.filter((x) => x.tile !== key); if (b.length) this.grid.set(k, b); else this.grid.delete(k); } }
    t.keys = null;
  }
  update(dt, cam) {
    if (!cam) return;
    const H = this.city.hdr, T = H.tile;
    // tall meshes: fewer buildings far away (draw range by height level)
    for (const g of this.tallMeshes) {
      const d = Math.hypot(g.x - cam.x, g.z - cam.z) - T * GROUP * 0.7;
      let n = g.all;
      for (let k = 0; k < this.levelD.length; k++) if (d > this.levelD[this.levelD.length - 1 - k]) n = g.lv[this.levelD.length - 1 - k];
      g.m.geometry.setDrawRange(0, n); g.m.visible = n > 0;
      g.m.castShadow = this.shadows && d < 2500; // (shadow maps reach a few km: no need to draw the far skyline into them)
    }
    // low tiles: plan every ~100 m of camera movement, build one tile at a time (a few ms a frame)
    const R = this.lowR;
    if (!this.lastPlan || Math.hypot(cam.x - this.lastPlan.x, cam.z - this.lastPlan.z) > 100) {
      this.lastPlan = { x: cam.x, z: cam.z };
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
    while (this.queue.length) {
      const t = this.queue[0];
      if (t.low) { this.queue.shift(); continue; }
      if (this.buildLowStep(t, budget)) this.queue.shift();
      break;
    }
    this.mat.emissiveIntensity = this.w.night ? 1.6 : 0;
    BLD_U.uDay.value = Math.max(0.05, Math.min(1, ((this.w.sunElev ?? 0.5) + 0.05) * 3)) * (1 - 0.5 * (this.w.W?.dark ?? 0));
  }
  // everything near the camera built (the loading screen waits for this on the first frames)
  get ready() { return !this.queue.length || this.queue.every((t) => !!t.low); }
  info() {
    let lowTris = 0, lowTiles = 0; for (const t of this.tiles.values()) if (t.low && t.low !== true) { lowTris += t.tris; lowTiles++; }
    return { tall: this.stats.tall, tallTris: this.stats.tris, tallMeshes: this.tallMeshes.length, lowTiles, lowTris, msTall: this.msTall };
  }
}
const W_SHADOW = (W) => W.qBase === 'high';
