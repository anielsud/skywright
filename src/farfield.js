// Far terrain: one cheap camera-centred mesh that carries the land on from the streamed tiles out to the haze (~120 km),
// so from high up the world fades into the sky instead of ending at a straight edge. It is built from cells aligned
// with the tile grid, coarser further out (8 / 4 / 2 quads a side), coloured per vertex with the same ground palette
// as the bake. A cell is hidden (collapsed in the vertex shader, via a small mask texture) wherever the core map or a
// streamed tile already draws that ground, so the two never overlap. Only for looks: physics never samples it.
import * as THREE from 'three';
import { now, slice } from './stepClock.js';
import { FOG } from './shaders.js';

const SEA_DROP = 100; // drowned vertices sit at least this far under the sea, so coasts can't z-fight from far away
const SECTORS = 64; // the merged cells are ordered by bearing from the field's centre, in this many sectors (see cull)
const _fr = new THREE.Frustum(), _pv = new THREE.Matrix4();

export class FarField {
  constructor(world, tiles) {
    this.w = world; this.tiles = tiles; this.T = tiles.size;
    this.base = (x, z) => world.loc.height(world.noise, x, z); // erosion is finer than the far grid: skip its cost
    this.cells = new Map(); // 'i,j,segs' -> cell data (cached across rebuilds)
    this.maxR = world.qName === 'low' ? 16 : 22; this.R = this.maxR; // radius in tiles
    this.M = 2 * (this.maxR + 3) + 1; // mask texture size (cells)
    this.maskData = new Uint8Array(this.M * this.M);
    this.mask = new THREE.DataTexture(this.maskData, this.M, this.M, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter; this.mask.needsUpdate = true;
    // shared with the water, which skips cells that are dry land all over
    const wU = world.waterMat.userData.U;
    this.U = { farMask: wU.farMask, farMaskOrigin: wU.farMaskOrigin, farMaskSize: wU.farMaskSize, farCell: wU.farCell };
    this.U.farMask.value = this.mask; this.U.farMaskSize.value = this.M; this.U.farCell.value = this.T;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOG, this.U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute vec2 cell; uniform sampler2D farMask; uniform vec2 farMaskOrigin; uniform float farMaskSize; uniform float farCell;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
        // every vertex of a cell carries the cell's index: hidden cells collapse to a point off screen (no fragments at all)
        if (texture2D(farMask, (cell - farMaskOrigin + 0.5) / farMaskSize).r > 0.6) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'farfield';
    // Two meshes share the one geometry (one draw call, two only when the view straddles the first sector). Each one,
    // just before it draws for a camera, sets the draw range to the sectors that camera's frustum touches: the camera
    // sees ~a third of the ring, the rest (behind and to the sides) is never sent. Exact per sector box, any camera.
    const g0 = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(g0, mat); this.mesh2 = new THREE.Mesh(g0, mat);
    for (const [m, part] of [[this.mesh, 0], [this.mesh2, 1]]) {
      m.frustumCulled = false; m.visible = false;
      m.onBeforeRender = (r, sc, cam, geo) => { const d = this.cull(cam, part); geo.setDrawRange(d[0], d[1]); m.userData.drawn = d[1] / 3; };
      world.group.add(m);
    }
    this.sec = null; this.vis = new Uint8Array(SECTORS);
    this.center = null; this.job = null; this.maskDirty = true; this.dirty = 0;
    this.templates = new Map();
    this.applyRadius();
  }
  // Auto quality: a smaller far field when the tablet is struggling (cached cells are reused, nothing is regenerated)
  setPerfLevel(level) {
    const R = level >= 2 ? Math.min(this.maxR, 15) : this.maxR;
    if (R !== this.R) { this.R = R; this.applyRadius(); this.center = null; }
  }
  applyRadius() { FOG.fogEnd.value = this.fadeEnd(); }
  fadeEnd() { return (this.R - 1) * this.T; } // everything is fully hazed by here, inside the far field's ragged rim
  viewDist() { return (this.R + 1.5) * this.T; } // camera far plane

  // the index range(s) for this camera: the shortest run of sectors (cyclic) that holds every sector in its frustum;
  // part 0 is that run (up to the last sector), part 1 the rest of it when it wraps past the last sector
  cull(cam, part) {
    const S = this.sec; if (!S) return [0, part ? 0 : Infinity];
    _fr.setFromProjectionMatrix(_pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const v = this.vis; let any = false;
    for (let s = 0; s < SECTORS; s++) any = (v[s] = S.count[s] > 0 && _fr.intersectsBox(S.box[s]) ? 1 : 0) || any;
    if (!any) return [0, 0];
    // the longest cyclic gap of sectors not needed: draw everything else
    let best = 0, bestEnd = 0, run = 0;
    for (let q = 0; q < 2 * SECTORS; q++) { if (v[q % SECTORS]) run = 0; else if (++run > best && run <= SECTORS) { best = run; bestEnd = q % SECTORS; } }
    const a = best ? (bestEnd + 1) % SECTORS : 0, b = best ? (bestEnd - best + SECTORS) % SECTORS : SECTORS - 1; // first, last sector drawn
    const end = (s) => S.start[s] + S.count[s];
    if (a <= b) return part ? [0, 0] : [S.start[a], end(b) - S.start[a]];
    return part ? [0, end(b)] : [S.start[a], S.total - S.start[a]];
  }

  segsFor(d) { return d <= 7.5 ? 8 : d <= 13 ? 4 : 2; }

  update(cam, budget) {
    const T = this.T, ci = Math.floor(cam.x / T), cj = Math.floor(cam.z / T);
    if (!this.center || this.center.i !== ci || this.center.j !== cj) {
      this.center = { i: ci, j: cj };
      this.job = this.rebuild(cam.x / T, cam.z / T, ci, cj);
      if (!this.mesh.visible) while (!this.job.next().done); // first build: all at once (it's part of loading)
    }
    // cells dropped by invalidate(): one rebuild for them all, at most every 1.5 s, never cutting into one in progress
    // (stepClock.js: under the test stepper, 1.5 s of game time and 4 cells a step per ms of budget)
    else if (this.dirty && !this.job && now() - this.dirty > 1500) { this.dirty = 0; this.job = this.rebuild(cam.x / T, cam.z / T, ci, cj); }
    if (this.job) { const more = slice(budget, Math.round(budget * 4)); while (more()) if (this.job.next().done) { this.job = null; break; } }
    if (this.maskDirty && this.origin) this.writeMask();
  }

  *rebuild(cx, cz, ci, cj) {
    const R = this.R, want = [];
    for (let i = Math.floor(cx - R); i <= Math.ceil(cx + R); i++) for (let j = Math.floor(cz - R); j <= Math.ceil(cz + R); j++) {
      if (this.tiles.inCore(i, j)) continue;
      const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz);
      if (d > R || d < 2.5) continue; // the nearest ring is always covered by streamed tiles
      want.push({ i, j, d, segs: this.segsFor(d) });
    }
    want.sort((a, b) => a.d - b.d);
    const used = new Set();
    for (const c of want) {
      const k = c.i + ',' + c.j + ',' + c.segs; used.add(k);
      if (!this.cells.has(k)) { this.cells.set(k, this.buildCell(c.i, c.j, c.segs)); yield; }
    }
    for (const k of this.cells.keys()) if (!used.has(k)) this.cells.delete(k);
    // merge into one geometry (one draw call)
    let nv = 0, ni = 0;
    // (a cell invalidate() dropped while this job was under way is built again here: a few small cells, no hitch)
    const list = want.map((c) => { const k = c.i + ',' + c.j + ',' + c.segs; let cell = this.cells.get(k); if (!cell) this.cells.set(k, (cell = this.buildCell(c.i, c.j, c.segs))); return cell; });
    const shown = new Map(); for (const c of list) shown.set(c.i + ',' + c.j, c);
    // ordered by sector (bearing of the cell's centre from cx,cz), each sector's index range and bounding box kept (cull)
    const secOf = (c) => Math.min(SECTORS - 1, Math.floor(((Math.atan2(c.j + 0.5 - cz, c.i + 0.5 - cx) / (2 * Math.PI)) + 1) % 1 * SECTORS));
    for (const c of list) c.sec = secOf(c);
    list.sort((p, q) => p.sec - q.sec);
    const sec = { start: new Int32Array(SECTORS), count: new Int32Array(SECTORS), box: [...Array(SECTORS)].map(() => new THREE.Box3()), total: 0 };
    for (const c of list) { nv += c.pos.length / 3; ni += this.template(c.segs).length; }
    // compact attributes (8-bit normals and colours, 16-bit cell index): less to upload each time the field moves
    const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 3), col = new Uint8Array(nv * 3), cell = new Int16Array(nv * 2), idx = new Uint32Array(ni);
    let v = 0, q = 0;
    for (let m = 0; m < list.length; m++) {
      const c = list[m], n = c.pos.length / 3, tpl = this.template(c.segs);
      if (!sec.count[c.sec]) sec.start[c.sec] = q;
      sec.count[c.sec] += tpl.length; const bx = sec.box[c.sec];
      for (let a = 0; a < n; a++) { const y = c.pos[a * 3 + 1]; if (y < bx.min.y) bx.min.y = y; if (y > bx.max.y) bx.max.y = y; }
      bx.min.x = Math.min(bx.min.x, c.i * this.T); bx.max.x = Math.max(bx.max.x, (c.i + 1) * this.T); bx.min.z = Math.min(bx.min.z, c.j * this.T); bx.max.z = Math.max(bx.max.z, (c.j + 1) * this.T);
      pos.set(c.pos, v * 3); nrm.set(c.nrm, v * 3); col.set(c.col, v * 3);
      for (let a = 0; a < n; a++) { cell[(v + a) * 2] = c.i; cell[(v + a) * 2 + 1] = c.j; }
      for (let a = 0; a < tpl.length; a++) idx[q + a] = tpl[a] + v;
      v += n; q += tpl.length;
      if (m % 200 === 199) yield;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setAttribute('cell', new THREE.BufferAttribute(cell, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    sec.total = idx.length;
    this.mesh.geometry.dispose(); this.mesh.geometry = this.mesh2.geometry = g; this.mesh.visible = this.mesh2.visible = true; this.sec = sec;
    const h = (this.M - 1) / 2;
    this.origin = { i: Math.floor(cx) - h, j: Math.floor(cz) - h }; this.shown = shown;
    this.writeMask();
  }
  // the ground under (x0,z0)-(x1,z1) has better data now (tiles.js invalidate): drop the cells there, rebuild soon
  invalidate(x0, z0, x1, z1) {
    const T = this.T; let any = false;
    for (const [k, c] of this.cells) if (!(c.i * T > x1 || (c.i + 1) * T < x0 || c.j * T > z1 || (c.j + 1) * T < z0)) { this.cells.delete(k); any = true; }
    if (any && !this.dirty) this.dirty = now();
  }
  // Per cell, 2 bits: is it already drawn by the core map or a streamed tile (a tile that is all sea counts: the sea
  // covers it), and is its ground dry land all over (then the water skips it).
  writeMask() {
    this.maskDirty = false;
    const M = this.M, o = this.origin, d = this.maskData, TT = this.tiles;
    for (let b = 0; b < M; b++) for (let a = 0; a < M; a++) {
      const i = o.i + a, j = o.j + b, key = TT.key(i, j), t = TT.tiles.get(key);
      const hidden = TT.inCore(i, j) || !!t, land = t ? t.land : !TT.inCore(i, j) && !!this.shown.get(key)?.land;
      d[b * M + a] = ((hidden ? 2 : 0) + (land ? 1 : 0)) * 85;
    }
    this.mask.needsUpdate = true;
    this.U.farMaskOrigin.value.set(o.i, o.j);
  }

  // index list for one cell: the grid, then skirts hanging from its four edges (hide cracks against coarser/finer neighbours)
  template(segs) {
    let t = this.templates.get(segs); if (t) return t;
    const n = segs + 1, idx = [];
    for (let b = 0; b < segs; b++) for (let a = 0; a < segs; a++) { const A = b * n + a, B = (b + 1) * n + a, C = B + 1, D = A + 1; idx.push(A, B, D, B, C, D); }
    const edges = [(m) => m, (m) => (n - 1) * n + m, (m) => m * n, (m) => m * n + n - 1];
    edges.forEach((f, e) => {
      const base = n * n + e * n;
      for (let m = 0; m < n - 1; m++) { const t0 = f(m), t1 = f(m + 1), s0 = base + m, s1 = base + m + 1; idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0); }
    });
    t = new Uint32Array(idx); this.templates.set(segs, t); return t;
  }
  buildCell(i, j, segs) {
    const W = this.w, T = this.T, st = T / segs, n = segs + 1, P = n + 2, x0 = i * T, z0 = j * T, wl = W.waterLevel;
    // the ring next to the tiles uses the full (eroded) height function, so it lines up with their edges
    const hf = segs >= 8 ? W.height : this.base;
    // a real place's streamed data (geostream.js): no finer than this cell needs (z8 ~ 420 m, z6 ~ 1.7 km a pixel), so
    // the near-camera zoom arriving never rebuilds the far field
    const RD = W.real; if (RD) RD.zMax = segs >= 4 ? 8 : 6;
    const H = new Float32Array(P * P); // one extra sample all round, for normals that continue across cells
    for (let b = 0; b < P; b++) for (let a = 0; a < P; a++) H[b * P + a] = hf(x0 + (a - 1) * st, z0 + (b - 1) * st);
    const nv = n * n + 4 * n, pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 3), col = new Uint8Array(nv * 3);
    const c = new THREE.Color(), nn = new THREE.Vector3();
    let land = true;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const k = b * n + a, p = (b + 1) * P + a + 1, h = H[p], x = x0 + a * st, z = z0 + b * st;
      nn.set(H[p - 1] - H[p + 1], 2 * st, H[p - P] - H[p + P]).normalize();
      W.baseColor(x, z, h, 1 - nn.y, c);
      // the bake's bytes are read back as sRGB and brightened a touch by the terrain material; AO ~ 0.9 cancels that out
      c.convertSRGBToLinear();
      pos[k * 3] = x; pos[k * 3 + 1] = h < wl ? Math.min(h, wl - SEA_DROP) : h; pos[k * 3 + 2] = z;
      if (h < wl + 20) land = false;
      nrm[k * 3] = Math.round(nn.x * 127); nrm[k * 3 + 1] = Math.round(nn.y * 127); nrm[k * 3 + 2] = Math.round(nn.z * 127);
      col[k * 3] = Math.min(255, Math.round(c.r * 255)); col[k * 3 + 1] = Math.min(255, Math.round(c.g * 255)); col[k * 3 + 2] = Math.min(255, Math.round(c.b * 255));
    }
    const drop = st * 0.5 + 100, edges = [(m) => m, (m) => (n - 1) * n + m, (m) => m * n, (m) => m * n + n - 1];
    edges.forEach((f, e) => {
      for (let m = 0; m < n; m++) {
        const s = f(m), k = n * n + e * n + m;
        pos[k * 3] = pos[s * 3]; pos[k * 3 + 1] = pos[s * 3 + 1] - drop; pos[k * 3 + 2] = pos[s * 3 + 2];
        for (let q = 0; q < 3; q++) { nrm[k * 3 + q] = nrm[s * 3 + q]; col[k * 3 + q] = col[s * 3 + q]; }
      }
    });
    if (RD) RD.zMax = 10;
    return { i, j, segs, pos, nrm, col, land };
  }
  info() { return `${this.cells.size} cells, ${this.mesh.geometry.attributes.position?.count ?? 0} verts, R=${this.R}`; }
  dispose() { FOG.fogEnd.value = 1e9; this.w.group.remove(this.mesh, this.mesh2); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mask.dispose(); }
}
