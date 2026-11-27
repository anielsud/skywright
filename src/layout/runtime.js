// The baked road layout in a World (#294, behind a flag while it's tried out: format.js layoutWanted). A place's chunks
// stream in about the camera (LOAD_D): each fetched, meshed in a worker (mesh.js; fine within FINE_D, coarse beyond, the
// same edge points at both levels; the nearest asked first, so the start is ready first), drawn as one mesh (the ground
// with the terrain's own material, the streets with the layout's and today's pavement), and physics (World.sampleGrid /
// groundAt) reading its fine mesh. Inside an active chunk, today's roads, kerbs, junction boxes, pavements and ground
// (coarse, patch and detail) don't draw (clip: a mask of the active chunks their shaders read); where an active chunk
// meets today's ground (a chunk not baked: a bridge, a tunnel, no roads; or not in yet), a skirt closes the gap.
import * as THREE from 'three';
import { decodeLayout, KIND } from './format.js';
import { meshChunk, physIndex, physAt, latticeOf } from './mesh.js';
import { sidewalkMaterial, regionLook, REGION } from '../roadSurface.js';
// the gravel (tracks and verges): a region's own where it differs (Bora Bora's tracks and verges are coral sand and dirt)
const GRAVEL = { fr: 0xc8b48e };
import { terrainMaterial, FOG } from '../shaders.js';

const FINE_D = 900, LOAD_D = 2500; // metres from the camera to a chunk's middle: fine within FINE_D; fetched within LOAD_D
const loader = new THREE.TextureLoader(), texCache = new Map();
const tex = (name) => { if (!texCache.has(name)) { const t = loader.load(`tex/roads/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; texCache.set(name, t); } return texCache.get(name); };
const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export class Layout {
  // index: the place's layout/index.json ({ size, chunks: [{ ix, iz, file }], fallback }); dir: where its files are
  constructor(w, index, dir) {
    this.w = w; this.on = false; this.dir = dir; this.size = index.size; this.group = new THREE.Group(); this.group.name = 'layout';
    this.index = new Map(index.chunks.map((c) => [c.ix + ',' + c.iz, c])); this.chunks = new Map(); this.active = new Map(); this.queue = new Map(); this.busy = false; this.cam = { x: 0, z: 0 };
    // the active chunks' mask, a texel a chunk over the hi square (today's materials don't draw where it's set)
    const H = w.real.hi, S = this.size; this.gx0 = Math.floor(H.x0 / S) * S; this.gz0 = Math.floor(H.z0 / S) * S; this.gn = Math.ceil((H.x0 + H.size - this.gx0) / S) + 1;
    this.maskData = new Uint8Array(this.gn * this.gn); this.mask = new THREE.DataTexture(this.maskData, this.gn, this.gn, THREE.RedFormat, THREE.UnsignedByteType); this.mask.needsUpdate = true;
    this.U = { layMask: { value: this.mask }, layGrid: { value: new THREE.Vector4(this.gx0, this.gz0, S, this.gn) } };
    this.out = [0, 0, 1, 0]; this.skirts = new Map(); this.subs = []; this.o2 = [0, 0, 0, 0];
    this.place = !(typeof location !== 'undefined' && /[?&]layplace=0\b/.test(location.search || '')); // (false: what stands on the roads placed as before this (?layplace=0, to compare shots))
  }
  // fn(box: { x0, z0, x1, z1 }) each time a chunk's surface arrives (physics on there): what was placed on today's ground
  // and roads within it (lamps, signals, trees, lanes) re-placed on the layout's
  onActive(fn) { this.subs.push(fn); }
  // today's ground and road materials: not drawn inside an active chunk
  clip(...mats) {
    const U = this.U;
    for (const m of mats) {
      if (!m || m.userData.layoutClip) continue; m.userData.layoutClip = true;
      const ob = m.onBeforeCompile, key = m.customProgramCacheKey();
      m.onBeforeCompile = function (sh, r) {
        ob.call(this, sh, r); Object.assign(sh.uniforms, U);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vLayXZ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vLayXZ; uniform sampler2D layMask; uniform vec4 layGrid;')
          .replace('void main() {', 'void main() {\n  { vec2 lc = floor((vLayXZ - layGrid.xy) / layGrid.z); if (lc.x >= 0.0 && lc.y >= 0.0 && lc.x < layGrid.w && lc.y < layGrid.w && texture2D(layMask, (lc + 0.5) / layGrid.w).r > 0.5) discard; }');
      };
      m.customProgramCacheKey = () => key + '|layout2';
    }
  }
  // maps: the terrain's (World.terrainMaps) for the ground's material
  start(maps) {
    const loc = this.w.loc, look = regionLook(loc.id), yellow = look.yellow ? 1 : 0, skirt = terrainMaterial(maps, 'detail'); skirt.side = THREE.DoubleSide;
    // (the ground: the terrain's own material, a city's paving turned to each triangle's street (aAng), not the world's axes)
    const ground = terrainMaterial(maps, 'detail'), ob = ground.onBeforeCompile; ground.onBeforeCompile = function (sh, r) { ob.call(this, sh, r);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aAng; varying float vAng;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvAng = aAng;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAng; vec2 layRot(vec2 p) { float c = cos(vAng), s = sin(vAng); return vec2(c * p.x + s * p.y, -s * p.x + c * p.y); }').replace('cityPave(vTW.xz,', 'cityPave(layRot(vTW.xz),'); }; // (only the slabs turned: cityPaved reads the land cover where the point really is)
    ground.customProgramCacheKey = () => 'layoutGround';
    // (yellow centre lines where today's roads paint them, the US places (roadSurface.js LOOK); a desert's verges and dirt
    // tracks a warm brown, the islands' coral sand, not the Alps' grey gravel)
    this.mats = { skirt, ground, tarmac: roadMat('asphalt_d', 0x5a5a5c, true, yellow), alley: roadMat('asphalt_d', 0x5a5a5c), gravel: roadMat('gravel_d', loc.desert ? 0x9c8468 : GRAVEL[REGION[loc.id]] ?? 0xa09684), pavers: roadMat('sidewalk_d', 0xa89a88), walk: sidewalkMaterial() };
    this.matList = [this.mats.ground, this.mats.alley, this.mats.gravel, this.mats.pavers];
    this.worker = typeof Worker !== 'undefined' ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) : null;
    if (this.worker) this.worker.onmessage = (ev) => { this.busy = false; const c = this.chunks.get(ev.data.id); if (c) this.got(c, ev.data.level, ev.data.m); this.pump(); };
  }
  // the hi grid's heights at a chunk's grid points (the natural ground the layout meets)
  lattice(L) {
    const H = this.w.real.hi, grid = { x0: H.x0, z0: H.z0, sp: H.sp, wl: this.w.loc.shore ? this.w.waterLevel : -Infinity }, lat = latticeOf(L, grid), out = new Float32Array(lat.ni * lat.nj);
    for (let j = 0; j < lat.nj; j++) for (let i = 0; i < lat.ni; i++) out[j * lat.ni + i] = H.H[Math.max(0, Math.min(H.n - 1, lat.j0 + j)) * H.n + Math.max(0, Math.min(H.n - 1, lat.i0 + i))];
    return { grid, G: out };
  }
  // a chunk's file, fetched and decoded (once)
  load(k) {
    let c = this.chunks.get(k); if (c) return c.ready.then(() => c); const e = this.index.get(k);
    c = { k, ix: e.ix, iz: e.iz, cx: (e.ix + 0.5) * this.size, cz: (e.iz + 0.5) * this.size, m: {}, phys: null, mesh: null, shown: null, asked: new Set() }; this.chunks.set(k, c);
    c.ready = (async () => { const r = await fetch(this.dir + e.file), s = r.body.pipeThrough(new DecompressionStream('gzip')); c.buf = await new Response(s).arrayBuffer(); c.L = decodeLayout(c.buf); })();
    return c.ready.then(() => c);
  }
  ask(c, level) { if (c.asked.has(level)) return; c.asked.add(level); this.queue.set(c.k + ':' + level, [c, level]); this.pump(); }
  // the next mesh to make: the nearest chunk's (fine before coarse at the same distance)
  pump() {
    if (this.busy || !this.queue.size) return;
    let best = null, bd = Infinity; for (const [q, [c, level]] of this.queue) { const d = Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) + (level === 'coarse' ? 1 : 0); if (d < bd) { bd = d; best = q; } }
    const [c, level] = this.queue.get(best); this.queue.delete(best); const { grid, G } = this.lattice(c.L);
    if (this.worker) { this.busy = true; this.worker.postMessage({ id: c.k, buf: c.buf.slice(0), grid, G, level }, [G.buffer]); }
    else { this.got(c, level, meshChunk(c.L, grid, G, level)); this.pump(); } // (Node: no workers; the same function)
  }
  got(c, level, m) {
    c.m[level] = m;
    const st = this.stats; if (st && st.firstRingMs == null && st.ring.every((k) => this.chunks.get(k)?.m.fine)) st.firstRingMs = performance.now() - st.t0;
    if (level === 'fine' && !c.phys) { // physics, the mask and the skirts start with the fine mesh
      c.phys = physIndex(c.L, m); this.active.set(c.k, c); this.on = true;
      const i = (c.L.x0 - this.gx0) / this.size, j = (c.L.z0 - this.gz0) / this.size; if (i >= 0 && j >= 0 && i < this.gn && j < this.gn) { this.maskData[j * this.gn + i] = 255; this.mask.needsUpdate = true; }
      if (this.mats) this.skirtsFor(c);
      const box = { x0: c.L.x0, z0: c.L.z0, x1: c.L.x0 + c.L.size, z1: c.L.z0 + c.L.size, k: c.k }; if (this.place) for (const f of this.subs) f(box); // (what stands on it re-placed: onActive)
    }
    if (!this.mats) return; // (no drawing: tools)
    const want = Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) < FINE_D ? 'fine' : 'coarse';
    if (c.phys && (level === want || !c.shown)) this.show(c, c.m[want] ? want : 'fine');
  }
  // the skirts about an active chunk: on each side whose neighbour isn't active (and the neighbour's facing it, gone)
  skirtsFor(c) {
    for (const [dx, dz] of SIDES) { const nk = (c.ix + dx) + ',' + (c.iz + dz), back = nk + ':' + (-dx) + ',' + (-dz);
      if (this.active.has(nk)) { const s = this.skirts.get(back); if (s) { this.group.remove(s); s.geometry.dispose(); this.skirts.delete(back); } continue; }
      const me = this.skirt(c, c.m.fine, dx, dz); if (me) this.skirts.set(c.k + ':' + dx + ',' + dz, me); }
  }
  // a wall on one side of a chunk from its edge to today's ground there: the two needn't meet, and without it the sky
  // showed through (#297: the white sliver at Lauterbrunnen's chunk, where a road's bank met today's ground metres off)
  skirt(c, m, dx, dz) {
    const L = c.L, P = m.pos, n = P.length / 3, w = this.w, out = [], nrm = [];
    const onSide = (k) => (dx ? P[k * 3] === (dx < 0 ? L.x0 : L.x0 + L.size) : P[k * 3 + 2] === (dz < 0 ? L.z0 : L.z0 + L.size));
    const ks = []; for (let k = 0; k < n; k++) if (onSide(k)) ks.push(k); ks.sort((a, b) => (dx ? P[a * 3 + 2] - P[b * 3 + 2] : P[a * 3] - P[b * 3]));
    const was = this.on; this.on = false; const T = ks.map((k) => w.sampleGrid(P[k * 3], P[k * 3 + 2])); this.on = was; // (today's ground: World.sampleGrid without the layout)
    for (let q = 0; q + 1 < ks.length; q++) { const a = ks[q], b = ks[q + 1], ya = P[a * 3 + 1], yb = P[b * 3 + 1], lo = Math.min(ya, yb, T[q], T[q + 1]) - 0.3, hi = Math.max(ya, yb, T[q], T[q + 1]);
      if (hi - lo < 0.35) continue; const A = [P[a * 3], P[a * 3 + 2]], B = [P[b * 3], P[b * 3 + 2]];
      out.push(A[0], hi, A[1], B[0], hi, B[1], B[0], lo, B[1], A[0], hi, A[1], B[0], lo, B[1], A[0], lo, A[1]); for (let v = 0; v < 6; v++) nrm.push(dx, 0, dz); }
    if (!out.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.computeBoundingSphere();
    const me = new THREE.Mesh(g, this.mats.skirt); me.name = 'layout skirt'; this.group.add(me); return me;
  }
  show(c, level) {
    const m = c.m[level]; if (!m) return;
    if (!c.mesh) { c.mesh = new THREE.Group(); c.mesh.name = 'layout ' + c.L.ix + ',' + c.L.iz; this.group.add(c.mesh); }
    for (const o of c.mesh.children) o.geometry.dispose(); c.mesh.clear();
    // the surface (ground, alleys, gravel, pavers); the carriageway, kerbs and pavements from the street ribbons below
    // (the paving's angle is a triangle's (mesh.js ang): a corner shared by triangles of two angles gets a copy for each)
    const N0 = m.pos.length / 3, vAng = new Float32Array(N0).fill(NaN), dup = [], dAng = [], idx = m.idx.slice();
    for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] > KIND.bank) continue; const a = m.ang[q]; for (let r = 0; r < 3; r++) { const v = idx[q * 3 + r]; if (vAng[v] !== vAng[v]) vAng[v] = a; else if (vAng[v] !== a) { idx[q * 3 + r] = N0 + dup.length; dup.push(v); dAng.push(a); } } }
    const n1 = N0 + dup.length, pos = new Float32Array(n1 * 3), nrm = new Float32Array(n1 * 3), ang = new Float32Array(n1); pos.set(m.pos); nrm.set(m.nrm);
    for (let k = 0; k < N0; k++) ang[k] = vAng[k] === vAng[k] ? vAng[k] : 0; dup.forEach((v, i) => { pos.set(m.pos.subarray(v * 3, v * 3 + 3), (N0 + i) * 3); nrm.set(m.nrm.subarray(v * 3, v * 3 + 3), (N0 + i) * 3); ang[N0 + i] = dAng[i]; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    const matOf = (k) => (k === KIND.ground || k === KIND.bank ? 0 : k === KIND.alley ? 1 : k === KIND.verge || k === KIND.gravel ? 2 : k === KIND.pavers ? 3 : -1);
    for (let q = 0; q < m.tk.length;) { const mi = matOf(m.tk[q]); let e = q; while (e < m.tk.length && matOf(m.tk[e]) === mi) e++; if (mi >= 0) g.addGroup(q * 3, (e - q) * 3, mi); q = e; }
    g.computeBoundingSphere(); const surf = new THREE.Mesh(g, this.matList); surf.receiveShadow = true; c.mesh.add(surf);
    const r = m.rib, n = r.kind.length; if (n) {
      const pick = (want) => { const at = []; for (let v = 0; v < n; v += 3) if (want(r.kind[v])) at.push(v); return at; };
      const part = (vs, mat, attrs) => { const k = vs.length * 3, P = new Float32Array(k * 3), N = new Float32Array(k * 3), A = attrs.map(([, size]) => new Float32Array(k * size));
        vs.forEach((v0, t) => { for (let q = 0; q < 3; q++) { const v = v0 + q, o = t * 3 + q; P.set(r.pos.subarray(v * 3, v * 3 + 3), o * 3); N.set(r.nrm.subarray(v * 3, v * 3 + 3), o * 3); attrs.forEach(([, size, f], a) => A[a].set(f(v), o * size)); } });
        const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(P, 3)); gg.setAttribute('normal', new THREE.BufferAttribute(N, 3)); attrs.forEach(([name, size], a) => gg.setAttribute(name, new THREE.BufferAttribute(A[a], size)));
        gg.computeBoundingSphere(); const me = new THREE.Mesh(gg, mat); me.receiveShadow = true; c.mesh.add(me); };
      part(pick((k) => k === KIND.tarmac), this.mats.tarmac, [['aRoad', 4, (v) => r.road.subarray(v * 4, v * 4 + 4)], ['aLane', 1, (v) => [r.lane[v]]]]);
      // (the pavement and its kerb with today's material: uv = metres across from the street's centre line, along; rinfo = half width, -, seed)
      part(pick((k) => k === KIND.kerb || k === KIND.pave), this.mats.walk, [['uv', 2, (v) => [r.road[v * 4 + 1], r.road[v * 4]]], ['rinfo', 3, (v) => [r.road[v * 4 + 2], 0, 3]], ['rjunc', 4, () => [99, 99, 0, 0]]]);
    }
    c.shown = level;
  }
  // each frame: the chunks about the camera fetched and asked for (fine near, coarse further); each drawn at its level
  update(cam) {
    const x = cam.position.x, z = cam.position.z; this.cam.x = x; this.cam.z = z;
    if (!this.stats) { const S = this.size, ring = []; for (const k of this.index.keys()) { const [i, j] = k.split(',').map(Number); if (Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) < FINE_D) ring.push(k); } this.stats = { t0: performance.now(), ring, firstRingMs: null }; } // (the first ring: the chunks fine about the first camera, meshed: goto.py --stats)
    if (!this.lastScan || Math.hypot(x - this.lastScan[0], z - this.lastScan[1]) > 100) { this.lastScan = [x, z]; // (about every 100 m: which are in reach)
      const S = this.size, r = Math.ceil(LOAD_D / S);
      for (let i = Math.floor(x / S) - r; i <= Math.floor(x / S) + r; i++) for (let j = Math.floor(z / S) - r; j <= Math.floor(z / S) + r; j++) {
        const k = i + ',' + j; if (!this.index.has(k) || this.chunks.has(k) || Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) > LOAD_D) continue;
        this.load(k).then((c) => this.ask(c, 'fine')).catch(() => {}); } }
    for (const c of this.chunks.values()) { if (!c.phys || !this.mats) continue; const want = Math.hypot(c.cx - x, c.cz - z) < FINE_D ? 'fine' : 'coarse';
      if (want === 'coarse' && !c.asked.has('coarse')) this.ask(c, 'coarse');
      if (want !== c.shown && c.m[want]) this.show(c, want); }
  }
  // load and mesh (fine) every chunk within r of (x, z) now (tools and tests; the game streams them in update): how many
  async prime(x, z, r) {
    this.cam.x = x; this.cam.z = z; const S = this.size, n = Math.ceil(r / S), ks = [];
    for (let i = Math.floor(x / S) - n; i <= Math.floor(x / S) + n; i++) for (let j = Math.floor(z / S) - n; j <= Math.floor(z / S) + n; j++) { const k = i + ',' + j; if (this.index.has(k) && Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) <= r) ks.push(k); }
    const cs = await Promise.all(ks.map((k) => this.load(k))); for (const c of cs) this.ask(c, 'fine');
    while (this.queue.size || this.busy) { if (this.worker) await new Promise((res) => setTimeout(res, 20)); else this.pump(); }
    return cs.length;
  }
  // the height to place things at (x, z) on (lamps, signals, lanes, building bases): the surface's, NaN outside the active chunks
  placeY(x, z) { return this.place && this.on ? this.heightAt(x, z) : NaN; }
  // the physics height at (x, z) (NaN outside the active chunks)
  heightAt(x, z, out) { const c = this.active.get(Math.floor(x / this.size) + ',' + Math.floor(z / this.size)); return c ? physAt(c.L, c.m.fine, c.phys, x, z, out) : NaN; }
  // whether every chunk over the square x0..x1, z0..z1 that will be in (baked, in reach of the camera) is in: what's
  // built over it then stands on the layout's surface, not today's ground (realCity.js: a low tile waits for it)
  readyIn(x0, z0, x1, z1) {
    const S = this.size; if (!this.place) return true;
    for (let i = Math.floor(x0 / S); i <= Math.floor(x1 / S); i++) for (let j = Math.floor(z0 / S); j <= Math.floor(z1 / S); j++) { const k = i + ',' + j; if (!this.index.has(k) || this.active.has(k)) continue;
      if (this.chunks.has(k) || Math.hypot((i + 0.5) * S - this.cam.x, (j + 0.5) * S - this.cam.z) <= LOAD_D) return false; }
    return true;
  }
  // the surface kind (format.js KIND) at (x, z), -1 outside the active chunks
  kindAt(x, z) { if (!this.place) return -1; const c = this.active.get(Math.floor(x / this.size) + ',' + Math.floor(z / this.size)); if (!c) return -1; const h = physAt(c.L, c.m.fine, c.phys, x, z, this.o2); return h === h ? c.m.fine.tk[this.o2[0]] : -1; }
  // whether (x, z) is on the layout's paving (tarmac, kerb, pavement, verge, pavers, gravel, an alley): nothing grows there
  pavedAt(x, z) { const k = this.kindAt(x, z); return k >= KIND.tarmac && k !== KIND.out; }
  // the street nearest (x, z) in an active chunk (not the ways off the network), within reach of its centre line:
  // { px, pz (the nearest point of its centre line), nx, nz (from there towards (x, z)), d, hw, pave } or null
  edgeAt(x, z, reach = 30) {
    const c = this.place && this.active.get(Math.floor(x / this.size) + ',' + Math.floor(z / this.size)); if (!c) return null;
    let best = null, bd = reach;
    for (const r of c.L.net.runs) { if (r.minor) continue; const P = r.pts;
      for (let i = 0; i + 3 < P.length; i += 2) { const ax = P[i], az = P[i + 1], ex = P[i + 2] - ax, ez = P[i + 3] - az, l = ex * ex + ez * ez, t = l ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l)) : 0, px = ax + ex * t, pz = az + ez * t, d = Math.hypot(x - px, z - pz);
        if (d < bd) { bd = d; const ll = Math.sqrt(l) || 1; let nx = -ez / ll, nz = ex / ll; if ((x - px) * nx + (z - pz) * nz < 0) { nx = -nx; nz = -nz; } best = { px, pz, nx, nz, d, hw: r.hw, pave: r.pave }; } } }
    return best;
  }
  // World.groundAt's answer inside an active chunk (null outside): height, normal, surface type
  ground(x, z) {
    const o = this.out, c = this.active.get(Math.floor(x / this.size) + ',' + Math.floor(z / this.size)); if (!c) return null;
    const h = physAt(c.L, c.m.fine, c.phys, x, z, o); if (!(h === h)) return null;
    const k = c.m.fine.tk[o[0]], w = this.w, n = new THREE.Vector3(o[1], o[2], o[3]), lot = k <= KIND.bank && w.cityD && w.cityPaved(x, z) > 0.5 && w.real.bare(x, z); // (a city's paved lots, as World.groundAt says)
    const type = k === KIND.verge || k === KIND.gravel ? 'sand' : k >= KIND.tarmac || lot ? 'runway' : n.y < 0.8 ? 'rock' : w.loc.desert && !(w.real && w.real.forest(x, z) > 0.45) ? 'sand' : 'grass'; // (a desert's ground: sand, but pine needles under the rims' forests, as World.groundAt)
    return { h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  dispose() { this.worker?.terminate(); for (const c of this.chunks.values()) for (const o of c.mesh?.children || []) o.geometry.dispose(); for (const s of this.skirts.values()) s.geometry.dispose(); this.mask.dispose(); }
}

// a paved surface: its photo texture over a base colour (world-space, metres), and on the tarmac the markings from the
// layout's road coordinates (aRoad: along, across, half width, from the junction's mouth; aLane: lanes | one-way 16 |
// painted 32): lane lines, the centre line (New York's double yellow) and a crossing's zebra at each junction's mouth
function roadMat(texName, color, marks = false, yellow = 0) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }), T = tex(texName);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG); sh.uniforms.tDet = { value: T }; sh.uniforms.uYellow = { value: yellow }; // (the shared fog's uniforms: every custom hook must add them)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aRoad; attribute float aLane; varying vec4 vRoad; varying float vLane; varying vec2 vLW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vLane = aLane; vLW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tDet; uniform float uYellow; varying vec4 vRoad; varying float vLane; varying vec2 vLW;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 det = texture2D(tDet, vLW / 3.0).rgb; diffuseColor.rgb *= 0.55 + 0.9 * dot(det, vec3(0.333));
        ${marks ? `{
          float v = vRoad.y, u = vRoad.x, hw = vRoad.z, dj = vRoad.w, aa = fwidth(v) * 0.8 + 0.005, ua = fwidth(u) * 0.8 + 0.005;
          float lanes = max(1.0, mod(vLane, 16.0)), oneway = mod(floor(vLane / 16.0), 2.0), painted = mod(floor(vLane / 32.0), 2.0), zebra = step(64.0, vLane);
          float paint = 0.0; vec3 col = vec3(0.92);
          if (hw > 0.5 && dj > 0.5) { // (dj below 0: inside the junction's circle)
            float dash = step(fract(u / 9.0), 0.45) * painted;
            if (oneway < 0.5) { // two-way: the centre line, and lane lines each side
              float c = uYellow > 0.5 ? max(1.0 - smoothstep(0.05, 0.05 + aa, abs(abs(v) - 0.12)), 0.0) : (1.0 - smoothstep(0.06, 0.06 + aa, abs(v))) * dash;
              if (c > 0.0) { paint = c; col = uYellow > 0.5 ? vec3(0.85, 0.66, 0.12) : vec3(0.92); }
              float per = max(1.0, floor(lanes / 2.0)), lw = hw / per;
              for (int k = 1; k < 4; k++) { if (float(k) >= per) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(abs(v) - lw * float(k)))) * dash); }
            } else { float lw = 2.0 * hw / lanes; for (int k = 1; k < 6; k++) { if (float(k) >= lanes) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(v + hw - lw * float(k)))) * dash); } }
            if (zebra > 0.5 && dj > 0.5 && dj < 3.5 && abs(v) < hw - 0.3) { paint = max(paint, step(0.5, fract(v / 1.2))); col = vec3(0.92); } // (the zebra)
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, col, paint * 0.9);
        }` : ''}`);
  };
  m.customProgramCacheKey = () => 'layoutRoad|' + texName + '|' + marks;
  return m;
}
