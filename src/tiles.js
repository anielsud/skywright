// Endless terrain: square tiles generated on the fly around the camera, beyond the detailed core map.
// Each tile samples the location's analytic height function, so the land carries on seamlessly
// (mountain ranges, mesas, open ocean...). Nearer tiles get more vertices; edge skirts hide LOD seams.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { FOG } from './shaders.js';

const RADIUS = 4.3; // tiles (centre distance) kept around the camera

export class TerrainTiles {
  constructor(world) {
    this.w = world;
    this.size = world.size / 4; // the core map is exactly 4x4 tiles: indices -2..1
    this.tiles = new Map(); this.queue = [];
    this.group = new THREE.Group(); world.group.add(this.group);
    const detail = world.detailTexture();
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.95 });
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOG);
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
          vec4 t1 = texture2D(map, vMapUv); vec4 t2 = texture2D(map, vMapUv * 0.137 + 0.31);
          diffuseColor.rgb *= mix(t1.rgb, t2.rgb, 0.5) * 1.3;
        #endif`);
    };
    this.mat.customProgramCacheKey = () => 'outer-terrain';
    this.trees = new Map(); // flora kind -> pooled InstancedMesh for all outer tiles
    this.lastCam = null;
  }
  key(i, j) { return i + ',' + j; }
  inCore(i, j) { return i >= -2 && i <= 1 && j >= -2 && j <= 1; }
  segsFor(d) { const q = this.w.qName; const base = q === 'high' ? 112 : q === 'low' ? 56 : 80; return d <= 1.6 ? base : d <= 2.6 ? base / 2 : base / 4; }

  update(cam) {
    const T = this.size, ci = cam.x / T, cj = cam.z / T;
    if (!this.lastCam || Math.hypot(cam.x - this.lastCam.x, cam.z - this.lastCam.z) > T * 0.2) {
      this.lastCam = cam.clone();
      // which tiles should exist, and at what detail
      const want = new Map();
      for (let i = Math.floor(ci - RADIUS); i <= Math.ceil(ci + RADIUS); i++) for (let j = Math.floor(cj - RADIUS); j <= Math.ceil(cj + RADIUS); j++) {
        if (this.inCore(i, j)) continue;
        const d = Math.hypot(i + 0.5 - ci, j + 0.5 - cj); if (d > RADIUS) continue;
        want.set(this.key(i, j), { i, j, d, segs: this.segsFor(d) });
      }
      for (const [k, t] of this.tiles) if (!want.has(k)) { this.drop(t); this.tiles.delete(k); }
      this.queue = [...want.values()].filter((t) => { const have = this.tiles.get(this.key(t.i, t.j)); return !have || have.segs !== t.segs; }).sort((a, b) => a.d - b.d);
    }
    // work is time-sliced (a few ms per frame) so streaming never causes a hitch, even on a tablet
    const t0 = performance.now(), budget = 4;
    while (performance.now() - t0 < budget) {
      if (!this.job) {
        if (this.queue.length) { const t = this.queue.shift(); this.job = { t, it: this.build(t.i, t.j, t.segs) }; }
        else if (this.treesDirty) { this.treesDirty = false; this.rebuildTrees(); this.job = { water: true, it: this.updateWaterDepth(cam) }; }
        else break;
      }
      const r = this.job.it.next();
      if (r.done) {
        if (this.job.t) { const t = this.job.t, k = this.key(t.i, t.j), old = this.tiles.get(k); if (old) this.drop(old); this.tiles.set(k, r.value); this.treesDirty = true; }
        this.job = null;
      }
    }
  }

  *build(i, j, segs) {
    const W = this.w, T = this.size, x0 = i * T, z0 = j * T, st = T / segs, n = segs + 1;
    const H = new Float32Array(n * n);
    let anyLand = false;
    for (let b = 0; b < n; b++) { for (let a = 0; a < n; a++) { const h = W.loc.height(W.noise, x0 + a * st, z0 + b * st); H[b * n + a] = h; if (h > W.waterLevel + 0.5) anyLand = true; } if (b % 8 === 7) yield; }
    const tile = { i, j, segs, H, st, x0, z0, n, mesh: null, trees: [] };
    if (!anyLand) return tile; // open water: nothing to draw, the sea plane covers it
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), c = new THREE.Color();
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const k = b * n + a, x = x0 + a * st, z = z0 + b * st, h = H[k];
      const hx = H[b * n + Math.min(n - 1, a + 1)] - H[b * n + Math.max(0, a - 1)], hz = H[Math.min(n - 1, b + 1) * n + a] - H[Math.max(0, b - 1) * n + a];
      const ny = 2 * st / Math.hypot(hx, 2 * st, hz);
      W.baseColor(x, z, h, 1 - ny, c);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z; col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; uv[k * 2] = x / 40; uv[k * 2 + 1] = z / 40;
      if (a === n - 1 && b % 8 === 7) yield;
    }
    const idx = [];
    for (let b = 0; b < segs; b++) for (let a = 0; a < segs; a++) { // same split as sample(): (a,b,d) + (b,c,d)
      const A = b * n + a, B = (b + 1) * n + a, C = (b + 1) * n + a + 1, D = b * n + a + 1;
      idx.push(A, B, D, B, C, D);
    }
    // skirts: a curtain hanging below each edge hides cracks against neighbours of a different detail
    const skirt = (list) => { const base = pos.length / 3 + extra.length / 3; list.forEach((k) => { extra.push(pos[k * 3], pos[k * 3 + 1] - 60, pos[k * 3 + 2]); ecol.push(col[k * 3] * 0.6, col[k * 3 + 1] * 0.6, col[k * 3 + 2] * 0.6); euv.push(0, 0); }); for (let m = 0; m < list.length - 1; m++) { const t0 = list[m], t1 = list[m + 1], s0 = base + m, s1 = base + m + 1; idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0); } };
    const extra = [], ecol = [], euv = [], edge = (f) => Array.from({ length: n }, (_, m) => f(m));
    skirt(edge((m) => m)); skirt(edge((m) => (n - 1) * n + m)); skirt(edge((m) => m * n)); skirt(edge((m) => m * n + n - 1));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([...pos, ...extra]), 3));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from([...col, ...ecol]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from([...uv, ...euv]), 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.mat); mesh.receiveShadow = true;
    this.group.add(mesh); tile.mesh = mesh;
    // scatter a few hundred simple trees on nearer tiles
    if (segs >= this.segsFor(2)) this.scatter(tile);
    return tile;
  }
  scatter(tile) {
    const W = this.w, kinds = W.flora?.kinds?.filter((k) => k.lo) || []; if (!kinds.length) return;
    const r = mulberry32((tile.i * 73856093) ^ (tile.j * 19349663));
    for (let t = 0; t < 900 && tile.trees.length < 320; t++) {
      const x = tile.x0 + r() * this.size, z = tile.z0 + r() * this.size, h = this.sample(x, z, tile);
      if (h < W.waterLevel + 1) continue;
      const hx = this.sample(x + 20, z, tile), hz = this.sample(x, z + 20, tile), slope = 1 - 20 / Math.hypot(hx - h, 20, hz - h);
      const f = W.noise.fbm(x / 260 + 7, z / 260, 3); if (f < 0.05 && r() < 0.85) continue;
      const k = kinds[Math.floor(r() * kinds.length)];
      if (!k.where(h, slope, 0, f, false)) continue;
      tile.trees.push({ k, x, y: h - 0.2, z, s: 0.8 + r() * 0.5, yaw: r() * 6.28 });
    }
  }
  rebuildTrees() {
    const byKind = new Map();
    for (const t of this.tiles.values()) for (const tr of t.trees) { if (!byKind.has(tr.k)) byKind.set(tr.k, []); byKind.get(tr.k).push(tr); }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const [k, list] of byKind) {
      let im = this.trees.get(k);
      if (!im || im.instanceMatrix.count < list.length) {
        if (im) { this.group.remove(im); im.dispose(); }
        im = new THREE.InstancedMesh(k.lo.geometry, k.loMat, Math.ceil(list.length * 1.5) + 64); im.frustumCulled = false; this.trees.set(k, im); this.group.add(im);
      }
      list.forEach((tr, n) => { q.setFromAxisAngle(up, tr.yaw); m.compose(p.set(tr.x, tr.y, tr.z), q, s.setScalar(tr.s)); im.setMatrixAt(n, m); });
      im.count = list.length; im.instanceMatrix.needsUpdate = true;
    }
    for (const [k, im] of this.trees) if (!byKind.has(k)) im.count = 0;
  }
  // Sea-floor heights around the camera for the water shader (shallows and surf beyond the core map)
  *updateWaterDepth(cam) {
    const W = this.w, U = W.waterMat?.userData.U; if (!U) return;
    const R = 160, span = this.size * 8.6, ox = Math.round(cam.x / 2000) * 2000 - span / 2, oz = Math.round(cam.z / 2000) * 2000 - span / 2;
    if (!this.depthData) { this.depthData = new Uint16Array(R * R); this.depthTex = new THREE.DataTexture(this.depthData, R, R, THREE.RedFormat, THREE.HalfFloatType); this.depthTex.magFilter = this.depthTex.minFilter = THREE.LinearFilter; }
    const tmp = new Uint16Array(R * R);
    for (let j = 0; j < R; j++) { for (let i = 0; i < R; i++) tmp[j * R + i] = THREE.DataUtils.toHalfFloat(W.sampleGrid(ox + (i + 0.5) * span / R, oz + (j + 0.5) * span / R)); if (j % 16 === 15) yield; }
    this.depthData.set(tmp);
    this.depthTex.needsUpdate = true;
    U.outerTex.value = this.depthTex; U.outerOrigin.value.set(ox, oz); U.outerSize.value = span;
  }
  drop(t) { if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); } }

  // height at (x,z) from a built tile (matches its triangles), else straight from the height function
  sample(x, z, tile = null) {
    const T = this.size;
    const t = tile || this.tiles.get(this.key(Math.floor(x / T), Math.floor(z / T)));
    if (!t) return this.w.loc.height(this.w.noise, x, z);
    const fx = Math.min(t.segs - 1e-6, Math.max(0, (x - t.x0) / t.st)), fz = Math.min(t.segs - 1e-6, Math.max(0, (z - t.z0) / t.st));
    const a0 = Math.floor(fx), b0 = Math.floor(fz), u = fx - a0, v = fz - b0, n = t.n, H = t.H;
    const A = H[b0 * n + a0], B = H[(b0 + 1) * n + a0], C = H[(b0 + 1) * n + a0 + 1], D = H[b0 * n + a0 + 1];
    if (u + v <= 1) return A + (D - A) * u + (B - A) * v;
    return C + (B - C) * (1 - u) + (D - C) * (1 - v);
  }
  dispose() { for (const t of this.tiles.values()) this.drop(t); for (const im of this.trees.values()) im.dispose(); this.w.group.remove(this.group); }
}
