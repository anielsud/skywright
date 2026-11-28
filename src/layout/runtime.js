// The baked road layout in a World (#294, behind a flag while it's tried out: format.js layoutWanted). A place's chunks
// stream in about the camera (LOAD_D; dropped past DROP_D; the start's fetched with the place and meshed while the World
// is built: early): each fetched, meshed in a pool of workers (mesh.js, and what it's drawn with,
// draw.js; fine within FINE_D, coarse beyond, the same edge points at both levels; fine near the camera's track first,
// then coarse, so the start's first view is in before the loading screen goes and what's ahead before it's in reach; a
// chunk is drawn from its first mesh in, coarse until fine, today's ground and roads until then), drawn as one mesh (the ground
// with the terrain's own material, the streets with the layout's and today's pavement), and physics (World.sampleGrid /
// groundAt) reading its fine mesh. Inside an active chunk, today's roads, kerbs, junction boxes, pavements and ground
// (coarse, patch and detail) don't draw (clip: a mask of the active chunks their shaders read); where an active chunk
// meets today's ground (past the layout's extent, a chunk that failed a check, or one not in yet) a skirt closes the gap, and on
// the extent's outer edge its ground takes today's terrain's heights (edgeH). The extent (tools/bake/layout.mjs extentOf)
// covers the World's core and every chunk with roads; a chunk with nothing of the network in reach is only ground, worked
// out here, not fetched (format.js groundBytes). The airfield's runways, apron and
// landside road, the stunt sites' pads and the land past the core are in the natural ground (rules.js groundNode). Bridges' decks and tunnels' tubes stay today's (roads.js), the layout meeting them at their heights, a skirt closes the gap.
import * as THREE from 'three';
import { decodeLayout, KIND, indexChunks, groundBytes } from './format.js';
import { meshChunk, physIndex, physAt, latticeOf, EDGE_STEP, ZEBRA_IN, ZEBRA_OUT } from './mesh.js';
import { drawBuffers, railBuffers } from './draw.js';
import { groundGrid, latticeHeights } from './rules.js';
import { sidewalkMaterial, pathMaterial, regionLook, REGION } from '../roadSurface.js';
// the gravel (tracks and verges): a region's own where it differs (Bora Bora's tracks and verges are coral sand and dirt)
const GRAVEL = { fr: 0xc8b48e };
import { terrainMaterial, waterMaterial, FOG } from '../shaders.js';

const FINE_D = 900, LOAD_D = 2500; // metres from the camera to a chunk's middle: fine within FINE_D; fetched within LOAD_D
// the meshing workers: a pool sharing one queue (a core or two left for the page and the GPU process)
const POOL = Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 2));
// how far ahead (s) the camera's track is looked along, at its speed, for what to fetch and mesh first (prefetch: a
// chunk ahead meshed before it's in reach); and the main thread's time (ms) a frame gives arrived meshes (at least one)
const AHEAD = 4, BUDGET = 6;
// a chunk further than DROP_D from the camera is dropped (its meshes, physics and bytes; fetched and meshed again on the
// way back, within LOAD_D: the gap between the two keeps one at the edge from coming and going)
const DROP_D = 4000;
const loader = new THREE.TextureLoader(), texCache = new Map();
const tex = (name) => { if (!texCache.has(name)) { const t = loader.load(`tex/roads/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; texCache.set(name, t); } return texCache.get(name); };
const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export class Layout {
  // index: the place's layout/index.json ({ size, chunks: [{ ix, iz, file }], ground: [[iz, ix0, ix1]] (chunks only
  // ground: no file, format.js groundBytes), fallback }); dir: where its files are
  constructor(w, index, dir) {
    this.w = w; this.on = false; this.dir = dir; this.size = index.size; this.group = new THREE.Group(); this.group.name = 'layout';
    const cs = indexChunks(index); this.index = new Map(cs.map((c) => [c.ix + ',' + c.iz, c])); this.chunks = new Map(); this.active = new Map(); this.queue = new Map(); this.busy = 0; this.loading = 0; this.uids = 0; this.done = []; this.cam = { x: 0, z: 0 }; this.vel = { x: 0, z: 0, t: 0, px: 0, pz: 0 }; this.drawn = new Set(); this.workers = [];
    // the active chunks' mask, a texel a chunk over the square holding every baked chunk (today's materials don't draw where
    // it's set; New York's reach past the hi square)
    const S = this.size, ix0 = Math.min(0, ...cs.map((c) => c.ix)), iz0 = Math.min(0, ...cs.map((c) => c.iz)); this.gx0 = ix0 * S; this.gz0 = iz0 * S; this.gn = Math.max(1, ...cs.map((c) => Math.max(c.ix - ix0, c.iz - iz0) + 1));
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
  // today's water materials (World.buildWater: ShaderMaterials, their world position vW): not drawn inside an active chunk
  clipWater(...mats) {
    const U = this.U;
    for (const m of mats) {
      if (!m || m.userData.layoutClip) continue; m.userData.layoutClip = true;
      const key = m.customProgramCacheKey();
      m.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, U);
        sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'uniform sampler2D layMask; uniform vec4 layGrid;\nvoid main() {\n  { vec2 lc = floor((vW.xz - layGrid.xy) / layGrid.z); if (lc.x >= 0.0 && lc.y >= 0.0 && lc.x < layGrid.w && lc.y < layGrid.w && texture2D(layMask, (lc + 0.5) / layGrid.w).r > 0.5) discard; }'); };
      m.customProgramCacheKey = () => key + '|layoutWater';
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
    this.mats = { skirt, ground, tarmac: roadMat('asphalt_d', 0x5a5a5c, true, yellow), alley: roadMat('asphalt_d', 0x5a5a5c), gravel: roadMat('gravel_d', loc.desert ? 0x9c8468 : GRAVEL[REGION[loc.id]] ?? 0xa09684), pavers: roadMat('sidewalk_d', 0xa89a88), walk: sidewalkMaterial(), track: pathMaterial(REGION[loc.id]) }; // (track: the gravel's, today's tracks' look, its ruts)
    // (a railway's bed, its sleepers and rails (realBuildings.js's look), a rail bridge's deck and a rail tunnel's tube (roads.js's))
    Object.assign(this.mats, { ballast: roadMat('gravel_d', 0x4e463e), sleeper: new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.95 }), steel: new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 0.8, roughness: 0.4 }),
      deck: new THREE.MeshStandardMaterial({ color: 0x9a968e, roughness: 0.9 }), tube: new THREE.MeshStandardMaterial({ color: 0x6e6c66, emissive: 0x2a2924, roughness: 0.9, side: THREE.DoubleSide }) });
    this.matList = [this.mats.ground, this.mats.alley, this.mats.gravel, this.mats.pavers, this.mats.ballast];
    // the water: today's plane and shore mesh (World.buildWater) don't draw inside an active chunk, whose own water is its
    // surface's part under the water level (water()), so the shore is the layout's ground's, not today's carved grid's
    const w = this.w; if (w.waterMat) { this.clipWater(w.waterMat, ...(w.shoreWater?.children || []).map((o) => o.material)); this.mats.water = waterMaterial({ U: w.waterMat.userData.U, shore: true, vdepth: true }); }
    this.ensurePool();
  }
  // the meshing workers (once: early, or start)
  ensurePool() {
    // (the arrived meshes: drawn straight away until the first view is in (behind the loading screen), then a few a frame (update))
    if (this.workers.length || typeof Worker === 'undefined') return;
    this.workers = typeof Worker !== 'undefined' ? Array.from({ length: POOL }, () => { const wk = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); wk.jobs = [];
      wk.onmessage = (ev) => { const t0 = performance.now(); wk.jobs.shift(); this.busy--; const st = this.stats; if (st) { st.meshed++; st.workMs += ev.data.ms; } if (this.eager()) this.arrive(ev.data); else this.done.push(ev.data); this.pump(); this.note(t0); };
      wk.onerror = (e) => { e.preventDefault?.(); this.busy--; console.warn('[layout] a chunk failed to mesh:', wk.jobs.shift(), e.message); this.pump(); }; return wk; }) : []; // (a mesh that throws: that chunk stays today's, the worker goes on)
  }
  // the natural ground at a chunk's grid points (rules.js groundNode: today's terrain base without the roads' carving)
  lattice(L) { const grid = groundGrid(this.w); return { grid, G: latticeHeights(this.w, grid, latticeOf(L, grid)) }; }
  // a chunk's file, fetched and decoded (once)
  load(k) {
    let c = this.chunks.get(k); if (c) return c.ready.then(() => c); const e = this.index.get(k);
    c = { k, uid: ++this.uids, ix: e.ix, iz: e.iz, cx: (e.ix + 0.5) * this.size, cz: (e.iz + 0.5) * this.size, m: {}, phys: null, mesh: null, shown: null, asked: new Set() }; this.chunks.set(k, c);
    const pre = e.file && this.pre?.get(e.file); if (pre) { this.pre.delete(e.file); c.buf = pre; c.L = decodeLayout(pre); c.ready = Promise.resolve(); return c.ready.then(() => c); } // (fetched with the place: realworld.js loadReal)
    if (!e.file) { c.buf = groundBytes(e.ix, e.iz, !!this.w.loc.city).buffer; c.L = decodeLayout(c.buf); c.ready = Promise.resolve(); return c.ready.then(() => c); } // (only ground: worked out, not fetched)
    this.loading++; c.ready = (async () => {
      { const r = await fetch(this.dir + e.file), s = r.body.pipeThrough(new DecompressionStream('gzip')); c.buf = await new Response(s).arrayBuffer(); } c.L = decodeLayout(c.buf); })().finally(() => { if (!--this.loading) this.pump(); }); // (the last fetch in: what was held for it, pump)
    return c.ready.then(() => c);
  }
  ask(c, level) { if (c.asked.has(level)) return; c.asked.add(level); this.queue.set(c.k + ':' + level, [c, level]); this.pump(); }
  // a point's distance (m) from the camera's track: from the camera to where it will be AHEAD s on at its speed
  dAhead(x, z) { const a = this.cam, v = this.vel, ex = v.x * AHEAD, ez = v.z * AHEAD, l = ex * ex + ez * ez, t = l ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l)) : 0; return Math.hypot(x - a.x - ex * t, z - a.z - ez * t); }
  // the order meshes are made in (lowest first): fine within FINE_D of the camera's track, the nearest first; then coarse
  // for the rest in reach (what's drawn further off); then fine for those (their physics, what stands on them)
  prio(c, level) { const d = this.dAhead(c.cx, c.cz); return level === 'fine' ? (d < FINE_D ? d : 2e5 + d) : 1e5 + d; }
  // how many meshes a worker is given at once: while the loading screen is up the main thread is busy for 100s of ms at a
  // time (the World, the shaders), and a worker that had to wait for it to be given its next stood idle; in flight, two
  // (the order can still change with the camera's track)
  depth() { return this.giving ? Infinity : this.eager() ? 4 : 2; }
  // the next meshes to make, up to depth() per worker
  pump() {
    if (this.hold) return; // (early: every ask in first, then given out in order)
    while (this.queue.size && (!this.workers.length || this.busy < this.workers.length * this.depth())) {
      let best = null, bp = Infinity; for (const [q, [c, level]] of this.queue) { const p = this.prio(c, level); if (p < bp) { bp = p; best = q; } }
      if (bp >= 2e5 && (this.giving || (this.loading && this.eager()))) break; // (the first view's fine far off waits for every fetch: a worker isn't taken from what the loading screen waits for)
      const [c, level] = this.queue.get(best); this.queue.delete(best); const { grid, G } = this.lattice(c.L), edgeH = this.edgeH(c), wl = this.w.waterLevel; // (the water drawn only where the World has some: show)
      if (this.workers.length) { const wk = this.workers.reduce((a, b) => (b.jobs.length < a.jobs.length ? b : a)); wk.jobs.push(c.k + ':' + level); this.busy++; wk.postMessage({ id: c.k, uid: c.uid, buf: c.buf.slice(0), grid, G, level, edgeH, wl }, [G.buffer]); }
      else { const m = meshChunk(c.L, grid, G, level, edgeH), d = this.mats ? drawBuffers(m, wl) : null; if (d) d.rails = level === 'fine' ? railBuffers(c.L, m) : null; this.got(c, level, m, d); } // (Node: no workers; the same functions)
    }
  }
  // until the first view is in (behind the loading screen) a mesh is drawn as it arrives; then a few a frame (update)
  eager() { const st = this.stats; return !st || (st.firstViewMs == null && performance.now() - st.t0 < 10000); }
  arrive(r) { const c = this.chunks.get(r.id); if (c && c.uid === r.uid) this.got(c, r.level, r.m, r.d); } // (not a dropped chunk's: unload)
  // the main thread's time in layout work from t0 (a frame's update, an arrived mesh): the longest, and how many over 50 ms in flight
  note(t0) { const ms = performance.now() - t0, st = this.stats; if (!st) return; if (st.firstViewMs == null) { st.loadMainMax = Math.max(st.loadMainMax, ms); return; } st.mainMax = Math.max(st.mainMax, ms); if (ms > 50) st.long++; }
  // on each side of a chunk with no layout chunk beside it (the layout's outer edge), today's terrain there at the side's
  // edge points (World.sampleGrid without the layout), for its ground to meet (mesh.js edgeH); null if none
  edgeH(c) {
    const L = c.L, S = L.size, n = Math.round(S / EDGE_STEP) + 1, w = this.w; let out = null;
    for (const [sd, dx, dz] of [['w', -1, 0], ['e', 1, 0], ['s', 0, -1], ['n', 0, 1]]) { if (this.index.has((c.ix + dx) + ',' + (c.iz + dz))) continue;
      const H = new Float32Array(n), was = this.on; this.on = false;
      for (let i = 0; i < n; i++) { const u = i * EDGE_STEP; H[i] = dx ? w.sampleGrid(dx < 0 ? L.x0 : L.x0 + S, L.z0 + u) : w.sampleGrid(L.x0 + u, dz < 0 ? L.z0 : L.z0 + S); }
      this.on = was; (out ||= {})[sd] = H; }
    const has = (dx, dz) => this.index.has((c.ix + dx) + ',' + (c.iz + dz)), cs = [[0, 0, -1, -1], [S, 0, 1, -1], [0, S, -1, 1], [S, S, 1, 1]].map(([u, v, dx, dz]) => { if (has(dx, 0) && has(0, dz) && has(dx, dz)) return null; const was = this.on; this.on = false; const h = w.sampleGrid(L.x0 + u, L.z0 + v); this.on = was; return h; });
    if (cs.some((h) => h != null)) (out ||= {}).c = cs;
    return out;
  }
  // a mesh arrived (d: what it's drawn with, draw.js; null: tools, nothing drawn)
  got(c, level, m, d) {
    c.m[level] = m; if (d) (c.d ||= {})[level] = d;
    const st = this.stats; this.ringCheck();
    if (level === 'fine' && !c.phys) { // physics starts with the fine mesh
      c.phys = physIndex(c.L, m); this.active.set(c.k, c); this.on = true;
      if (this.mats) this.railsFor(c, d?.rails);
      const box = { x0: c.L.x0, z0: c.L.z0, x1: c.L.x0 + c.L.size, z1: c.L.z0 + c.L.size, k: c.k }; if (this.place) for (const f of this.subs) f(box); // (what stands on it re-placed: onActive)
    }
    if (!this.mats) return; // (no drawing: tools)
    // (drawn at the level wanted, or at whatever level came first: coarse shows until fine is in, never today's roads
    // after; behind the loading screen now, in flight by update, a frame after the physics, within its budget)
    if (this.eager()) { const want = Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) < FINE_D ? 'fine' : 'coarse'; if (level === want || !c.shown) this.show(c, c.d?.[want] ? want : level); }
    this.progress();
  }
  // the share of the first view in (the ring fine and drawn, the rest drawn): the loading screen's progress; 1: in, or
  // given up waiting (eager)
  progress() { const st = this.stats; if (!st || st.firstViewMs != null || !this.eager()) return 1; let n = 0; const F = this.first; for (const k of F.ring) n += this.chunks.get(k)?.m.fine && this.drawn.has(k) ? 1 : 0; for (const k of F.view) n += this.drawn.has(k) ? 1 : 0;
    if (n < st.ring + st.view) return n / (st.ring + st.view); st.firstViewMs = performance.now() - st.t0; return 1; }
  // the skirts about a drawn chunk (m: its mesh, either level: the same edge points): on each side whose neighbour isn't
  // drawn (and the neighbour's facing it, gone)
  skirtsFor(c, m) {
    for (const [dx, dz] of SIDES) { const nk = (c.ix + dx) + ',' + (c.iz + dz), back = nk + ':' + (-dx) + ',' + (-dz);
      if (this.drawn.has(nk)) { const s = this.skirts.get(back); if (s) { this.group.remove(s); s.geometry.dispose(); this.skirts.delete(back); } continue; }
      const me = this.skirt(c, m, dx, dz); if (me) this.skirts.set(c.k + ':' + dx + ',' + dz, me); }
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
    const d = c.d?.[level]; if (!d) return;
    if (!this.drawn.has(c.k)) { // the mask (today's ground and roads not drawn there) and the skirts start with its first drawing
      this.drawn.add(c.k); const i = (c.L.x0 - this.gx0) / this.size, j = (c.L.z0 - this.gz0) / this.size; if (i >= 0 && j >= 0 && i < this.gn && j < this.gn) { this.maskData[j * this.gn + i] = 255; this.mask.needsUpdate = true; }
      this.skirtsFor(c, c.m[level]); }
    if (!c.mesh) { c.mesh = new THREE.Group(); c.mesh.name = 'layout ' + c.L.ix + ',' + c.L.iz; this.group.add(c.mesh); }
    for (const o of c.mesh.children) o.geometry.dispose(); c.mesh.clear();
    // the surface (ground, alleys, gravel, pavers); the carriageway, kerbs and pavements from the street ribbons below
    // (draw.js drawBuffers, in the worker: the main thread only wraps its arrays)
    const s = d.surf, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(s.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(s.nrm, 3)); g.setAttribute('aAng', new THREE.BufferAttribute(s.ang, 1)); g.setIndex(new THREE.BufferAttribute(s.idx, 1));
    for (let q = 0; q < s.groups.length; q += 3) g.addGroup(s.groups[q], s.groups[q + 1], s.groups[q + 2]);
    g.computeBoundingSphere(); const surf = new THREE.Mesh(g, this.matList); surf.receiveShadow = true; c.mesh.add(surf);
    if (d.water && this.mats.water) { const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.BufferAttribute(d.water.pos, 3)); wg.setAttribute('aDepth', new THREE.BufferAttribute(d.water.dep, 1)); wg.computeBoundingSphere(); const wm = new THREE.Mesh(wg, this.mats.water); wm.name = 'layout water'; c.mesh.add(wm); }
    for (const [name, mat] of [['tarmac', this.mats.tarmac], ['walk', this.mats.walk], ['track', this.mats.track]]) { const p = d.parts[name]; if (!p) continue;
      const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(p.pos, 3)); gg.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3)); for (const [a, [A, size]] of Object.entries(p.attrs)) gg.setAttribute(a, new THREE.BufferAttribute(A, size));
      gg.computeBoundingSphere(); const me = new THREE.Mesh(gg, mat); me.receiveShadow = true; c.mesh.add(me); }
    if (c.rails) for (const o of c.rails.children) if (o.userData.near) o.visible = level === 'fine'; // (the rails and sleepers: near only, sub-pixel further)
    c.shown = level;
  }
  // a chunk's railways (draw.js railBuffers, made in the worker): their meshes, and a rail bridge's piers down to today's
  // ground (the World's terrain: here)
  railsFor(c, rb) {
    if (!rb) return; const grp = new THREE.Group(); grp.name = 'layout rails ' + c.k;
    const add = (k, P, N) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); if (N) g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); else g.computeVertexNormals();
      if (k === 'ballast') { const nv = P.length / 3; g.setAttribute('aRoad', new THREE.BufferAttribute(new Float32Array(nv * 4), 4)); g.setAttribute('aLane', new THREE.BufferAttribute(new Float32Array(nv), 1)); }
      g.computeBoundingSphere(); const me = new THREE.Mesh(g, this.mats[k]); me.receiveShadow = true; me.castShadow = k === 'deck'; me.userData.near = k === 'steel' || k === 'sleeper'; grp.add(me); };
    for (const k of Object.keys(rb.pos)) add(k, rb.pos[k], rb.nrm[k]);
    // (a deck's piers, where it's 3 m or more over the ground)
    const pr = [], R = rb.piers, quad = (a, b, cc, d) => { for (const v of [a, b, cc, a, cc, d]) pr.push(v[0], v[1], v[2]); };
    for (let q = 0; q < R.length; q += 6) { const x = R[q], z = R[q + 1], top = R[q + 2], gy = this.w.sampleGrid(x, z); if (top - gy < 3) continue; const ux = R[q + 3], uz = R[q + 4], hx = 0.8, hz = R[q + 5], cx = (a, o) => [x + ux * a - uz * o, z + uz * a + ux * o];
      for (const [a0, o0, a1, o1] of [[-hx, -hz, hx, -hz], [hx, -hz, hx, hz], [hx, hz, -hx, hz], [-hx, hz, -hx, -hz]]) { const p = cx(a0, o0), qq = cx(a1, o1); quad([p[0], gy - 1, p[1]], [qq[0], gy - 1, qq[1]], [qq[0], top, qq[1]], [p[0], top, p[1]]); } }
    if (pr.length) add('deck', new Float32Array(pr), null);
    c.rails = grp; this.group.add(grp);
  }
  // the place's start, about (World's constructor, before the rest of the World is built: main.js startFlight's guess):
  // the chunks within LOAD_D of it that are in hand (pre: fetched with the place, realworld.js loadReal; only ground)
  // given to the workers now, fine within FINE_D, coarse beyond, so they're meshed while the World is built. Not those
  // on the layout's outer edge (their edge heights are today's terrain's, not built yet): those once it is (edges).
  early(x, z, pre, edges = false) {
    this.pre = pre; this.ensurePool(); if (!this.workers.length) return; const S = this.size, has = (i, j) => this.index.has(i + ',' + j); this.cam.x = x; this.cam.z = z; this.giving = this.hold = true;
    for (const [k, e] of this.index) { const d = Math.hypot((e.ix + 0.5) * S - x, (e.iz + 0.5) * S - z); if (d > LOAD_D || (e.file && !pre?.has(e.file))) continue;
      let edge = false; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (!has(e.ix + a, e.iz + b)) edge = true; if (edge !== edges) continue;
      const c = this.chunks.get(k) || (this.load(k), this.chunks.get(k)); this.ask(c, 'fine'); if (d >= FINE_D) this.ask(c, 'coarse'); }
    this.hold = false; this.pump(); this.giving = false; this.earlyT = performance.now(); this.earlyAt = [x, z];
  }
  // the flight's start (main.js buildFlight, at the spawn, before its shaders compile): its chunks fetched and meshed
  // from now (those early() gave out, already), and the first view (World.loaded holds the loading screen for it): fine
  // within FINE_D, drawn within LOAD_D
  begin(x, z) {
    const S = this.size, ring = [], view = []; this.cam.x = x; this.cam.z = z; Object.assign(this.vel, { x: 0, z: 0, t: 0 });
    for (const k of this.index.keys()) { const [i, j] = k.split(',').map(Number), d = Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z); if (d < FINE_D) ring.push(k); else if (d <= LOAD_D) view.push(k); }
    // (goto.py --stats: ring / view how many, firstRingMs the ring fine, firstViewMs all of it drawn (from here; earlyMs:
    // early() was that long before); in flight mainMax / long the main thread's layout work (ms, and how many over 50 ms),
    // backlog the most fine meshes waiting within FINE_D, coarseNear the most chunks within FINE_D not drawn fine 2 s
    // after they came in range, chunks / dropped how many are held / were dropped)
    this.first = { ring, view };
    this.stats = { t0: performance.now(), earlyMs: this.earlyT ? Math.round(performance.now() - this.earlyT) : null, earlyOff: this.earlyAt ? Math.round(Math.hypot(x - this.earlyAt[0], z - this.earlyAt[1])) : null, earlyRing: ring.filter((k) => this.chunks.get(k)?.asked.has('fine')).length, ring: ring.length, view: view.length, firstRingMs: null, firstViewMs: null, pool: this.workers.length, meshed: 0, workMs: 0, loadMainMax: 0, mainMax: 0, long: 0, backlog: 0, coarseNear: 0, coarseNearFrames: 0, frames: 0, chunks: 0, dropped: 0 };
    this.nearT = new Map(); this.lastScan = null; this.scan(); this.ringCheck(); this.progress();
  }
  ringCheck() { const st = this.stats; if (st && st.firstRingMs == null && this.first.ring.every((k) => this.chunks.get(k)?.m.fine)) st.firstRingMs = performance.now() - st.t0; }
  // a chunk dropped (beyond DROP_D): its meshes, rails and skirts gone (its drawn neighbours given a skirt on that side),
  // its mask and physics off, its bytes freed; a mesh of it still on the way is let go (arrive: uid)
  unload(c) {
    for (const lv of ['fine', 'coarse']) this.queue.delete(c.k + ':' + lv);
    this.done = this.done.filter((r) => r.id !== c.k);
    for (const g of [c.mesh, c.rails]) if (g) { for (const o of g.children) o.geometry.dispose(); this.group.remove(g); }
    for (const [dx, dz] of SIDES) { const key = c.k + ':' + dx + ',' + dz, sk = this.skirts.get(key); if (sk) { this.group.remove(sk); sk.geometry.dispose(); this.skirts.delete(key); } }
    if (this.drawn.has(c.k)) { this.drawn.delete(c.k); const i = (c.L.x0 - this.gx0) / this.size, j = (c.L.z0 - this.gz0) / this.size; if (i >= 0 && j >= 0 && i < this.gn && j < this.gn) { this.maskData[j * this.gn + i] = 0; this.mask.needsUpdate = true; }
      for (const [dx, dz] of SIDES) { const nb = this.chunks.get((c.ix + dx) + ',' + (c.iz + dz)); if (!nb || !this.drawn.has(nb.k) || !nb.shown) continue; const me = this.skirt(nb, nb.m[nb.shown], -dx, -dz); if (me) this.skirts.set(nb.k + ':' + (-dx) + ',' + (-dz), me); } }
    this.active.delete(c.k); this.chunks.delete(c.k); this.on = this.active.size > 0; if (this.stats) this.stats.dropped++;
  }
  // the chunks within LOAD_D of the camera's track fetched and asked for: fine, and coarse for those beyond FINE_D
  scan() {
    const x = this.cam.x, z = this.cam.z, ex = x + this.vel.x * AHEAD, ez = z + this.vel.z * AHEAD;
    if (this.lastScan && Math.hypot(x - this.lastScan[0], z - this.lastScan[1]) < 100 && Math.hypot(ex - this.lastScan[2], ez - this.lastScan[3]) < 100) return;
    this.lastScan = [x, z, ex, ez]; const S = this.size; // (about every 100 m: which are in reach, and which are past DROP_D)
    if (this.mats) for (const c of [...this.chunks.values()]) if (c.L && Math.hypot(c.cx - x, c.cz - z) > DROP_D) this.unload(c);
    for (let i = Math.floor((Math.min(x, ex) - LOAD_D) / S); i <= Math.floor((Math.max(x, ex) + LOAD_D) / S); i++) for (let j = Math.floor((Math.min(z, ez) - LOAD_D) / S); j <= Math.floor((Math.max(z, ez) + LOAD_D) / S); j++) {
      const k = i + ',' + j; if (!this.index.has(k) || this.chunks.has(k) || this.dAhead((i + 0.5) * S, (j + 0.5) * S) > LOAD_D) continue;
      this.load(k).then((c) => { this.ask(c, 'fine'); if (this.mats && Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) >= FINE_D) this.ask(c, 'coarse'); }).catch(() => {}); }
  }
  // each frame: the camera's track; the chunks about it fetched and asked for (fine near, coarse further); the meshes
  // arrived drawn (a few a frame); each drawn at its level
  update(cam) {
    const t0 = performance.now(), x = cam.position.x, z = cam.position.z, v = this.vel; this.cam.x = x; this.cam.z = z;
    if (!this.stats) this.begin(x, z);
    // (the camera's ground speed, smoothed over about half a second; a jump (a restart, goto.py) isn't a speed)
    const dt = (t0 - v.t) / 1000; if (!v.t || dt > 2) Object.assign(v, { t: t0, px: x, pz: z });
    else if (dt > 0.05) { const vx = (x - v.px) / dt, vz = (z - v.pz) / dt, k = Math.min(1, dt / 0.5); if (Math.hypot(vx, vz) > 3000) { v.x = v.z = 0; } else { v.x += (vx - v.x) * k; v.z += (vz - v.z) * k; } Object.assign(v, { t: t0, px: x, pz: z }); }
    this.scan();
    // (the drawings due, the nearest first: a level wanted that's in, or a chunk's first; then the arrived meshes (their
    // physics), the nearest first: within the frame's BUDGET, and at least one of the two)
    const due = []; if (this.mats) for (const c of this.chunks.values()) { if (!c.d) continue; const d = Math.hypot(c.cx - x, c.cz - z), want = d < FINE_D ? 'fine' : 'coarse';
      if (want === 'coarse' && c.shown && !c.asked.has('coarse')) this.ask(c, 'coarse');
      const lv = c.d[want] ? want : !c.shown ? Object.keys(c.d)[0] : null; if (lv && lv !== c.shown) due.push([d, c, lv]); } // (not drawn yet: whatever level is in)
    due.sort((a, b) => a[0] - b[0]); let did = 0;
    for (const [, c, lv] of due) { if (did && performance.now() - t0 >= BUDGET) break; this.show(c, lv); did++; }
    for (let n = 0; this.done.length && ((!did && !n) || performance.now() - t0 < BUDGET); n++) { let b = 0, bp = Infinity; this.done.forEach((r, q) => { const c = this.chunks.get(r.id), p = c ? this.prio(c, r.level) : 0; if (p < bp) { bp = p; b = q; } }); this.arrive(this.done.splice(b, 1)[0]); }
    const st = this.stats; this.progress(); if (st.firstViewMs != null && this.mats) { st.frames++; // (in flight: what's waiting, what's late)
      let back = 0; for (const [c, level] of this.queue.values()) if (level === 'fine' && Math.hypot(c.cx - x, c.cz - z) < FINE_D) back++; st.backlog = Math.max(st.backlog, back);
      const S = this.size, r = Math.ceil(FINE_D / S), seen = new Set(); let late = 0;
      for (let i = Math.floor(x / S) - r; i <= Math.floor(x / S) + r; i++) for (let j = Math.floor(z / S) - r; j <= Math.floor(z / S) + r; j++) { const k = i + ',' + j; if (!this.index.has(k) || Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) >= FINE_D) continue;
        seen.add(k); if (!this.nearT.has(k)) this.nearT.set(k, t0); if (this.chunks.get(k)?.shown !== 'fine' && t0 - this.nearT.get(k) > 2000) late++; }
      for (const k of this.nearT.keys()) if (!seen.has(k)) this.nearT.delete(k);
      st.coarseNear = Math.max(st.coarseNear, late); if (late) st.coarseNearFrames++; st.chunks = this.chunks.size; }
    this.note(t0);
  }
  // whether the first view is in (World.loaded: the loading screen waits for it)
  viewReady() { return this.progress() >= 1; }
  // load and mesh (fine) every chunk within r of (x, z) now (tools and tests; the game streams them in update): how many
  async prime(x, z, r) {
    this.cam.x = x; this.cam.z = z; const S = this.size, n = Math.ceil(r / S), ks = [];
    for (let i = Math.floor(x / S) - n; i <= Math.floor(x / S) + n; i++) for (let j = Math.floor(z / S) - n; j <= Math.floor(z / S) + n; j++) { const k = i + ',' + j; if (this.index.has(k) && Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) <= r) ks.push(k); }
    const cs = await Promise.all(ks.map((k) => this.load(k))); for (const c of cs) this.ask(c, 'fine');
    while (this.queue.size || this.busy || this.done.length) { while (this.done.length) this.arrive(this.done.shift()); if (this.workers.length) await new Promise((res) => setTimeout(res, 20)); else this.pump(); }
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
    const air = k <= KIND.bank && w.airfieldPaved?.(x, z); // (the airfield's runways, taxiways and apron: their meshes over this ground, World.groundAt's 'runway', at least runway height)
    if (air) return { h: Math.max(h, w.loc.rwyH), n: new THREE.Vector3(0, 1, 0), type: 'runway' };
    const type = k === KIND.verge || k === KIND.gravel || k === KIND.ballast ? 'sand' : k >= KIND.tarmac || lot ? 'runway' : n.y < 0.8 ? 'rock' : w.loc.desert && !(w.real && w.real.forest(x, z) > 0.45) ? 'sand' : 'grass'; // (a desert's ground: sand, but pine needles under the rims' forests, as World.groundAt)
    return { h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  dispose() { for (const wk of this.workers || []) wk.terminate(); for (const c of this.chunks.values()) for (const o of [...(c.mesh?.children || []), ...(c.rails?.children || [])]) o.geometry.dispose(); for (const s of this.skirts.values()) s.geometry.dispose(); this.mask.dispose(); }
}

// a paved surface: its photo texture over a base colour (world-space, metres), and on the tarmac the markings from the
// layout's road coordinates for the carriageway's four nearest streets' lines (mesh.js rib.mark; aM0 .. aM7, two per line:
// along, across, past each of its four nearest mouths, half width (0: none), lanes | one-way 16 | painted 32 | zebra 64;
// aM8, aM9: each line's stretch along it), the street nearest past its half width taken per fragment, and its nearest mouth: lane lines, the centre line (New
// York's double yellow) and a crossing's zebra at each junction's mouth (tools/bake/markcheck.mjs picks the same)
// a street line's distance past its nearest mouth (of four), and its score: how far past its half width (beyond its
// stretch along the line, S: from its stretch's end), less 1e4 inside
// its carriageway within its crossing's band, for a line nearest somewhere in the triangle (lane bits 128; two streets
// overlapping without a junction: the crossing's street holds the band, so its zebra stays whole); the lowest score is taken (tools/bake/markcheck.mjs mark: the same)
const MARK_GLSL = `float mDj(vec4 A, vec4 B) { float dj = abs(A.w) < abs(A.z) ? A.w : A.z; dj = abs(B.x) < abs(dj) ? B.x : dj; return abs(B.y) < abs(dj) ? B.y : dj; }
float mScore(vec4 A, vec4 B, vec2 S) { if (B.z <= 0.0) return 1e9; float ex = max(0.0, max(S.x - A.x, A.x - S.y)), d = sqrt(A.y * A.y + ex * ex) - B.z, dj = mDj(A, B); return d < 0.0 && B.w >= 128.0 && mod(floor(B.w / 64.0), 2.0) > 0.5 && dj > ${ZEBRA_IN.toFixed(1)} && dj < ${ZEBRA_OUT.toFixed(1)} ? d - 1e4 : d; }`;
function roadMat(texName, color, marks = false, yellow = 0) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }), T = tex(texName);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG); sh.uniforms.tDet = { value: T }; sh.uniforms.uYellow = { value: yellow }; // (the shared fog's uniforms: every custom hook must add them)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aM0; attribute vec4 aM1; attribute vec4 aM2; attribute vec4 aM3; attribute vec4 aM4; attribute vec4 aM5; attribute vec4 aM6; attribute vec4 aM7; attribute vec4 aM8; attribute vec4 aM9; varying vec4 vM0; varying vec4 vM1; varying vec4 vM2; varying vec4 vM3; varying vec4 vM4; varying vec4 vM5; varying vec4 vM6; varying vec4 vM7; varying vec4 vM8; varying vec4 vM9; varying vec2 vLW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvM0 = aM0; vM1 = aM1; vM2 = aM2; vM3 = aM3; vM4 = aM4; vM5 = aM5; vM6 = aM6; vM7 = aM7; vM8 = aM8; vM9 = aM9; vLW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tDet; uniform float uYellow; varying vec4 vM0; varying vec4 vM1; varying vec4 vM2; varying vec4 vM3; varying vec4 vM4; varying vec4 vM5; varying vec4 vM6; varying vec4 vM7; varying vec4 vM8; varying vec4 vM9; varying vec2 vLW;\n' + MARK_GLSL)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 det = texture2D(tDet, vLW / 3.0).rgb; diffuseColor.rgb *= 0.55 + 0.9 * dot(det, vec3(0.333));
        ${marks ? `{
          float f0 = fwidth(vM0.y), f1 = fwidth(vM2.y), f2 = fwidth(vM4.y), f3 = fwidth(vM6.y), g0 = fwidth(vM0.x), g1 = fwidth(vM2.x), g2 = fwidth(vM4.x), g3 = fwidth(vM6.x);
          float d0 = mScore(vM0, vM1, vM8.xy), d1 = mScore(vM2, vM3, vM8.zw), d2 = mScore(vM4, vM5, vM9.xy), d3 = mScore(vM6, vM7, vM9.zw);
          vec4 A = vM0, B = vM1; float fv = f0, fu = g0, bd = d0;
          if (d1 < bd) { A = vM2; B = vM3; fv = f1; fu = g1; bd = d1; }
          if (d2 < bd) { A = vM4; B = vM5; fv = f2; fu = g2; bd = d2; }
          if (d3 < bd) { A = vM6; B = vM7; fv = f3; fu = g3; }
          float vLane = B.w, dj = mDj(A, B);
          float v = A.y, u = A.x, hw = B.z, aa = fv * 0.8 + 0.005, ua = fu * 0.8 + 0.005;
          float lanes = max(1.0, mod(vLane, 16.0)), oneway = mod(floor(vLane / 16.0), 2.0), painted = mod(floor(vLane / 32.0), 2.0), zebra = mod(floor(vLane / 64.0), 2.0);
          float paint = 0.0; vec3 col = vec3(0.92);
          if (hw > 0.5 && dj > 0.5) { // (dj below 0: inside the junction's circle)
            float dash = step(fract(u / 9.0), 0.45) * painted;
            if (oneway < 0.5) { // two-way: the centre line, and lane lines each side
              float c = uYellow > 0.5 ? max(1.0 - smoothstep(0.05, 0.05 + aa, abs(abs(v) - 0.12)), 0.0) : (1.0 - smoothstep(0.06, 0.06 + aa, abs(v))) * dash;
              if (c > 0.0) { paint = c; col = uYellow > 0.5 ? vec3(0.85, 0.66, 0.12) : vec3(0.92); }
              float per = max(1.0, floor(lanes / 2.0)), lw = hw / per;
              for (int k = 1; k < 4; k++) { if (float(k) >= per) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(abs(v) - lw * float(k)))) * dash); }
            } else { float lw = 2.0 * hw / lanes; for (int k = 1; k < 6; k++) { if (float(k) >= lanes) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(v + hw - lw * float(k)))) * dash); } }
            if (zebra > 0.5 && dj > ${ZEBRA_IN.toFixed(1)} && dj < ${ZEBRA_OUT.toFixed(1)} && abs(v) < hw - 0.3) { paint = max(paint, step(0.5, fract(v / 1.2))); col = vec3(0.92); } // (the zebra)
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, col, paint * 0.9);
        }` : ''}`);
  };
  m.customProgramCacheKey = () => 'layoutRoad|' + texName + '|' + marks;
  return m;
}
