// Endless terrain: square tiles generated on the fly around the camera, beyond the detailed core map.
// Each tile samples the location's analytic height function, so the land carries on seamlessly
// (mountain ranges, mesas, open ocean...). Nearer tiles get more vertices; edge skirts hide LOD seams.
// Each tile bakes its own albedo/AO/normal maps with exactly the core's bake (World.bakeMaps) and draws with the
// core's terrain material, so crossing the edge of the core map doesn't change the look of the ground.
import * as THREE from 'three';
import { terrainMaterial } from './shaders.js';
import { FarField } from './farfield.js';

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
    this.lastCam = null; this.treeCam = null;
    this.far = new FarField(world, this); // coarse land beyond the tiles, out to the haze
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
      for (const [k, t] of this.tiles) if (!want.has(k)) { this.drop(t); this.tiles.delete(k); this.treesDirty = true; this.far.maskDirty = true; }
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
        if (this.job.t) { const t = this.job.t, k = this.key(t.i, t.j), old = this.tiles.get(k); if (old) this.drop(old); this.tiles.set(k, r.value); this.treesDirty = true; this.far.maskDirty = true; }
        this.job = null;
      }
    }
    this.far.update(cam, this.queue.length || this.job ? 1.5 : 3);
    // vegetation lives in Flora; tell it when the tiles under it change
    if (!this.treeCam || this.treeCam.distanceToSquared(cam) > 40 * 40) { this.treeCam = cam.clone(); this.layoutTrees(cam); }
  }

  *build(i, j, lod) {
    const W = this.w, T = this.size, x0 = i * T, z0 = j * T;
    const R = this.texR / lod, st = T / R, segs = R / 2, n = segs + 1; // mesh vertices on every other texel
    // mesh heights first: a tile that's all sea needs nothing else
    const H = new Float32Array(n * n);
    let anyLand = false;
    for (let b = 0; b < n; b++) { for (let a = 0; a < n; a++) { const h = W.shoreSnap(W.height(x0 + a * 2 * st, z0 + b * 2 * st)); H[b * n + a] = h; if (h > W.waterLevel + 0.5) anyLand = true; } if (b % 8 === 7) yield; }
    let minH = Infinity; for (let k = 0; k < H.length; k++) if (H[k] < minH) minH = H[k];
    const tile = { i, j, lod, segs, H, st: 2 * st, x0, z0, n, mesh: null, trees: [], hit: new Map(), land: minH > W.waterLevel + 20 };
    if (!anyLand) return tile; // open water: nothing to draw, the sea plane covers it
    // texel heights, padded so AO and normals continue across tile edges (and into the core)
    const pad = W.bakePad(st), TW = R + 1, PW = TW + 2 * pad, Hp = new Float32Array(PW * PW);
    for (let b = 0; b < PW; b++) {
      for (let a = 0; a < PW; a++) {
        const gi = a - pad, gj = b - pad;
        Hp[b * PW + a] = gi >= 0 && gj >= 0 && gi <= R && gj <= R && !(gi & 1) && !(gj & 1) ? H[(gj >> 1) * n + (gi >> 1)] : W.shoreSnap(W.height(x0 + gi * st, z0 + gj * st));
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
  // Vegetation on the outer tiles is streamed by Flora (src/flora.js) in the same cells as the core, sampling
  // these tiles' heights; it only needs to hear when the set of built tiles changes, to re-seat trees on re-meshed ground.
  *scatter() {}
  layoutTrees() { this.w.flora?.tilesChanged?.(this.tiles); }
  treeHit() { return null; } // Flora.hit covers the outer tiles too
  // Sea-floor heights around the camera for the water shader (shallows and surf beyond the core map)
  *updateWaterDepth(cam) {
    const W = this.w, U = W.waterMat?.userData.U; if (!U) return;
    const R = 512, span = this.size * 8.6, // ~92 m texels: about the core's own water-depth spacing, so shorelines match across the edge
      ox = Math.round(cam.x / 2000) * 2000 - span / 2, oz = Math.round(cam.z / 2000) * 2000 - span / 2;
    if (!this.depthData) { this.depthData = new Uint16Array(R * R); this.depthTex = new THREE.DataTexture(this.depthData, R, R, THREE.RedFormat, THREE.HalfFloatType); this.depthTex.magFilter = this.depthTex.minFilter = THREE.LinearFilter; }
    const tmp = new Uint16Array(R * R);
    // relative to the water level, like the core's height maps: half floats are fine-grained near zero, i.e. at the shore
    for (let j = 0; j < R; j++) { for (let i = 0; i < R; i++) tmp[j * R + i] = THREE.DataUtils.toHalfFloat(W.sampleGrid(ox + (i + 0.5) * span / R, oz + (j + 0.5) * span / R) - W.waterLevel); if (j % 4 === 3) yield; }
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
    this.white.dispose(); this.w.group.remove(this.group);
    this.far.dispose();
  }
}
