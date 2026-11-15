// Endless terrain: square tiles generated on the fly around the camera, beyond the detailed core map.
// Each tile samples the location's analytic height function, so the land carries on seamlessly
// (mountain ranges, mesas, open ocean...). Nearer tiles get more vertices; edge skirts hide LOD seams.
// Each tile bakes its own albedo/AO/normal maps with exactly the core's bake (World.bakeMaps) and draws with the
// core's terrain material, so crossing the edge of the core map doesn't change the look of the ground.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { terrainMaterial } from './shaders.js';
import { Flora } from './flora.js';

const RADIUS = 4.3; // tiles (centre distance) kept around the camera

export class TerrainTiles {
  constructor(world) {
    this.w = world;
    this.size = world.size / 4; // the core map is exactly 4x4 tiles: indices -2..1
    this.tiles = new Map(); this.queue = [];
    this.group = new THREE.Group(); world.group.add(this.group);
    // texels per tile at full detail: the core's bake spacing
    this.texR = Math.round(world.q.bake / 4);
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); this.white.needsUpdate = true;
    this.trees = new Map(); // flora kind -> { near, hi, lo } pooled InstancedMeshes for all outer tiles
    this.lastCam = null; this.treeCam = null;
  }
  key(i, j) { return i + ',' + j; }
  inCore(i, j) { return i >= -2 && i <= 1 && j >= -2 && j <= 1; }
  // texture divisor by distance (tile centre distance, in tiles): full core detail nearby, coarser further out
  lodFor(d) { return d <= 1.6 ? 1 : d <= 2.6 ? 2 : 4; }

  update(cam) {
    const T = this.size, ci = cam.x / T, cj = cam.z / T;
    if (!this.lastCam || Math.hypot(cam.x - this.lastCam.x, cam.z - this.lastCam.z) > T * 0.2) {
      this.lastCam = cam.clone();
      // which tiles should exist, and at what detail
      const want = new Map();
      for (let i = Math.floor(ci - RADIUS); i <= Math.ceil(ci + RADIUS); i++) for (let j = Math.floor(cj - RADIUS); j <= Math.ceil(cj + RADIUS); j++) {
        if (this.inCore(i, j)) continue;
        const d = Math.hypot(i + 0.5 - ci, j + 0.5 - cj); if (d > RADIUS) continue;
        want.set(this.key(i, j), { i, j, d, lod: this.lodFor(d) });
      }
      for (const [k, t] of this.tiles) if (!want.has(k)) { this.drop(t); this.tiles.delete(k); this.treesDirty = true; }
      this.queue = [...want.values()].filter((t) => { const have = this.tiles.get(this.key(t.i, t.j)); return !have || have.lod !== t.lod; }).sort((a, b) => a.d - b.d);
    }
    // work is time-sliced (a few ms per frame) so streaming never causes a hitch, even on a tablet
    const t0 = performance.now(), budget = 4;
    while (performance.now() - t0 < budget) {
      if (!this.job) {
        if (this.queue.length) { const t = this.queue.shift(); this.job = { t, it: this.build(t.i, t.j, t.lod) }; }
        else if (this.treesDirty) { this.treesDirty = false; this.treeCam = null; this.job = { water: true, it: this.updateWaterDepth(cam) }; }
        else break;
      }
      const r = this.job.it.next();
      if (r.done) {
        if (this.job.t) { const t = this.job.t, k = this.key(t.i, t.j), old = this.tiles.get(k); if (old) this.drop(old); this.tiles.set(k, r.value); this.treesDirty = true; }
        this.job = null;
      }
    }
    // trees: near / detailed / simple tiers by distance, like the core's flora
    if (!this.treeCam || this.treeCam.distanceToSquared(cam) > 40 * 40) { this.treeCam = cam.clone(); this.layoutTrees(cam); }
  }

  *build(i, j, lod) {
    const W = this.w, T = this.size, x0 = i * T, z0 = j * T;
    const R = this.texR / lod, st = T / R, segs = R / 2, n = segs + 1; // mesh vertices on every other texel
    // mesh heights first: a tile that's all sea needs nothing else
    const H = new Float32Array(n * n);
    let anyLand = false;
    for (let b = 0; b < n; b++) { for (let a = 0; a < n; a++) { const h = W.height(x0 + a * 2 * st, z0 + b * 2 * st); H[b * n + a] = h; if (h > W.waterLevel + 0.5) anyLand = true; } if (b % 8 === 7) yield; }
    const tile = { i, j, lod, segs, H, st: 2 * st, x0, z0, n, mesh: null, trees: [], hit: new Map() };
    if (!anyLand) return tile; // open water: nothing to draw, the sea plane covers it
    // texel heights, padded so AO and normals continue across tile edges (and into the core)
    const pad = W.bakePad(st), TW = R + 1, PW = TW + 2 * pad, Hp = new Float32Array(PW * PW);
    for (let b = 0; b < PW; b++) {
      for (let a = 0; a < PW; a++) {
        const gi = a - pad, gj = b - pad;
        Hp[b * PW + a] = gi >= 0 && gj >= 0 && gi <= R && gj <= R && !(gi & 1) && !(gj & 1) ? H[(gj >> 1) * n + (gi >> 1)] : W.height(x0 + gi * st, z0 + gj * st);
      }
      if (b % 4 === 3) yield;
    }
    const maps = { alb: new Uint8Array(TW * TW * 4), nor: new Uint8Array(TW * TW * 4) };
    yield* W.bakeMaps(Hp, R, pad, x0, z0, st, null, maps);
    const albedo = W.dataTex(maps.alb, TW, true), normal = W.dataTex(maps.nor, TW);
    const mat = terrainMaterial({ detailU: W.detailU, albedo, normal, shadow: this.white, shadowOn: 0, orig: new THREE.Vector2(x0 - st / 2, z0 - st / 2), span: T + st }, true);
    // mesh (normals and colour come from the baked maps)
    const pos = new Float32Array(n * n * 3);
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) { const k = b * n + a; pos[k * 3] = x0 + a * 2 * st; pos[k * 3 + 1] = H[k]; pos[k * 3 + 2] = z0 + b * 2 * st; }
    const idx = [];
    for (let b = 0; b < segs; b++) for (let a = 0; a < segs; a++) { // same split as sample(): (a,b,d) + (b,c,d)
      const A = b * n + a, B = (b + 1) * n + a, C = (b + 1) * n + a + 1, D = b * n + a + 1;
      idx.push(A, B, D, B, C, D);
    }
    // skirts: a curtain hanging below each edge hides cracks against neighbours of a different detail (and the core)
    const extra = [], edge = (f) => Array.from({ length: n }, (_, m) => f(m));
    const skirt = (list) => { const base = n * n + extra.length / 3; list.forEach((k) => extra.push(pos[k * 3], pos[k * 3 + 1] - 60, pos[k * 3 + 2])); for (let m = 0; m < list.length - 1; m++) { const t0 = list[m], t1 = list[m + 1], s0 = base + m, s1 = base + m + 1; idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0); } };
    skirt(edge((m) => m)); skirt(edge((m) => (n - 1) * n + m)); skirt(edge((m) => m * n)); skirt(edge((m) => m * n + n - 1));
    const all = new Float32Array(pos.length + extra.length); all.set(pos); all.set(extra, pos.length);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(all, 3));
    const nrm = new Float32Array(all.length); for (let q = 1; q < nrm.length; q += 3) nrm[q] = 1; // unused (the shader takes the baked normal) but must be finite
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(idx); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat); mesh.receiveShadow = true;
    this.group.add(mesh); tile.mesh = mesh;
    if (lod === 1) yield* this.scatter(tile);
    return tile;
  }
  // Trees at the same density and with the same rules as the core's flora (forest clumps, species by height/slope).
  *scatter(tile) {
    const W = this.w, F = W.flora; if (!F?.kinds?.length) return;
    const r = mulberry32((tile.i * 73856093) ^ (tile.j * 19349663)), A = this.size ** 2, tint = new THREE.Color();
    const tries = Math.round(F.rate.tries * A), max = Math.round(F.rate.max * A);
    const wet = (x, z) => this.sample(x, z, tile) < W.waterLevel + 1;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let t = 0; t < tries && tile.trees.length < max; t++) {
      if (t % 400 === 399) yield;
      const x = tile.x0 + r() * this.size, z = tile.z0 + r() * this.size, h = this.sample(x, z, tile);
      if (h < W.waterLevel) continue;
      const e = 1.5, hx = this.sample(x + e, z, tile), hz = this.sample(x, z + e, tile), s = 1 - e / Math.hypot(h - hx, e, h - hz);
      const n = W.noise.n2(x / 90, z / 90), f = W.noise.fbm(x / 260 + 7, z / 260, 3);
      if (f < 0.05 && r() < 0.85) continue;
      const nearWater = wet(x + 60, z) || wet(x - 60, z) || wet(x, z + 60) || wet(x, z - 60);
      const k = F.pick(r); if (!k.where(h, s, n, f, nearWater)) continue;
      const s0 = 0.75 + r() * 0.55, yaw = r() * Math.PI * 2;
      q.setFromAxisAngle(up, yaw); m.compose(p.set(x, h - 0.15, z), q, sc.setScalar(s0));
      Flora.tint(r, tint);
      tile.trees.push({ k, x, z, m: m.toArray(new Float32Array(16)), c: [tint.r, tint.g, tint.b] });
      if (!k.model.rock) { const key = Math.floor(x / 50) + ',' + Math.floor(z / 50); if (!tile.hit.has(key)) tile.hit.set(key, []); tile.hit.get(key).push([x, h, z, k.model.H * s0, Math.max(1.2, k.model.R * s0 * 0.5)]); }
    }
  }
  pool(k, need) {
    let p = this.trees.get(k);
    if (p && p.cap >= need) return p;
    if (p) for (const im of [p.near, p.hi, p.lo]) { this.group.remove(im); im.dispose(); }
    const F = this.w.flora, cap = Math.ceil(need * 1.5) + 64;
    const mk = (geo, mat) => { const im = new THREE.InstancedMesh(geo, mat, cap); im.frustumCulled = false; im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); im.count = 0; this.group.add(im); return im; };
    p = { cap, near: mk(k.model.geo, k.mat), hi: mk(k.model.geo, k.mat), lo: mk(F.loGeo(k), k.loMat) };
    p.near.castShadow = this.w.q.shadows; p.near.receiveShadow = true;
    this.trees.set(k, p); return p;
  }
  layoutTrees(cam) {
    const F = this.w.flora; if (!F) return;
    const n2 = 170 * 170, d2 = F.loDist ** 2, far = F.farDist, far2 = far * far, T = this.size;
    const byKind = new Map();
    for (const t of this.tiles.values()) {
      if (!t.trees.length) continue;
      const dx = Math.max(0, t.x0 - cam.x, cam.x - t.x0 - T), dz = Math.max(0, t.z0 - cam.z, cam.z - t.z0 - T);
      if (dx * dx + dz * dz > far2) continue;
      for (const tr of t.trees) { let l = byKind.get(tr.k); if (!l) byKind.set(tr.k, (l = [])); l.push(tr); }
    }
    for (const [k, list] of byKind) {
      const p = this.pool(k, list.length), cnt = { near: 0, hi: 0, lo: 0 };
      for (const tr of list) {
        const dd = (tr.x - cam.x) ** 2 + (tr.z - cam.z) ** 2; if (dd > far2) continue;
        const tier = dd < n2 ? 'near' : dd < d2 ? 'hi' : 'lo', im = p[tier], c = cnt[tier]++;
        im.instanceMatrix.array.set(tr.m, c * 16); im.instanceColor.array.set(tr.c, c * 3);
      }
      for (const tier of ['near', 'hi', 'lo']) { const im = p[tier]; im.count = cnt[tier]; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
    }
    for (const [k, p] of this.trees) if (!byKind.has(k)) p.near.count = p.hi.count = p.lo.count = 0;
  }
  treeHit(pt) {
    const T = this.size, t = this.tiles.get(this.key(Math.floor(pt.x / T), Math.floor(pt.z / T)));
    const arr = t?.hit.get(Math.floor(pt.x / 50) + ',' + Math.floor(pt.z / 50)); if (!arr) return null;
    for (const h of arr) { const dx = pt.x - h[0], dz = pt.z - h[2]; if (dx * dx + dz * dz < h[4] * h[4] && pt.y < h[1] + h[3] && pt.y > h[1]) return h; }
    return null;
  }
  // Sea-floor heights around the camera for the water shader (shallows and surf beyond the core map)
  *updateWaterDepth(cam) {
    const W = this.w, U = W.waterMat?.userData.U; if (!U) return;
    const R = 512, span = this.size * 8.6, // ~92 m texels: about the core's own water-depth spacing, so shorelines match across the edge
      ox = Math.round(cam.x / 2000) * 2000 - span / 2, oz = Math.round(cam.z / 2000) * 2000 - span / 2;
    if (!this.depthData) { this.depthData = new Uint16Array(R * R); this.depthTex = new THREE.DataTexture(this.depthData, R, R, THREE.RedFormat, THREE.HalfFloatType); this.depthTex.magFilter = this.depthTex.minFilter = THREE.LinearFilter; }
    const tmp = new Uint16Array(R * R);
    for (let j = 0; j < R; j++) { for (let i = 0; i < R; i++) tmp[j * R + i] = THREE.DataUtils.toHalfFloat(W.sampleGrid(ox + (i + 0.5) * span / R, oz + (j + 0.5) * span / R)); if (j % 4 === 3) yield; }
    this.depthData.set(tmp);
    this.depthTex.needsUpdate = true;
    U.outerTex.value = this.depthTex; U.outerOrigin.value.set(ox, oz); U.outerSize.value = span;
  }
  drop(t) {
    if (!t.mesh) return;
    this.group.remove(t.mesh); t.mesh.geometry.dispose();
    const U = t.mesh.material.userData.U; U.albedoTex.value.dispose(); U.normTex.value.dispose(); t.mesh.material.dispose();
  }

  // height at (x,z) from a built tile (matches its triangles), else straight from the height function
  sample(x, z, tile = null) {
    const T = this.size;
    const t = tile || this.tiles.get(this.key(Math.floor(x / T), Math.floor(z / T)));
    if (!t) return this.w.height(x, z);
    const fx = Math.min(t.segs - 1e-6, Math.max(0, (x - t.x0) / t.st)), fz = Math.min(t.segs - 1e-6, Math.max(0, (z - t.z0) / t.st));
    const a0 = Math.floor(fx), b0 = Math.floor(fz), u = fx - a0, v = fz - b0, n = t.n, H = t.H;
    const A = H[b0 * n + a0], B = H[(b0 + 1) * n + a0], C = H[(b0 + 1) * n + a0 + 1], D = H[b0 * n + a0 + 1];
    if (u + v <= 1) return A + (D - A) * u + (B - A) * v;
    return C + (B - C) * (1 - u) + (D - C) * (1 - v);
  }
  dispose() {
    for (const t of this.tiles.values()) this.drop(t);
    for (const p of this.trees.values()) for (const im of [p.near, p.hi, p.lo]) im.dispose();
    this.white.dispose(); this.w.group.remove(this.group);
  }
}
