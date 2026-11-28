// The baked road layout in a World (#294, behind a flag while it's tried out: format.js layoutWanted). A place's chunks
// stream in about the camera (LOAD_D): each fetched, meshed in a worker (mesh.js; fine within FINE_D, coarse beyond, the
// same edge points at both levels; the nearest asked first, so the start is ready first), drawn as one mesh (the ground
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
import { meshChunk, physIndex, physAt, latticeOf, EDGE_STEP, MARK } from './mesh.js';
import { groundGrid, latticeHeights, portalsOf, DECK_SIDE, DECK_DEPTH, TUBE_SIDE, TUBE_H, PORTAL_TOP, PORTAL_T, PORTAL_FOOT, SILL } from './rules.js';
import { railPieces, railSide, RAIL_TOP, SLEEPER_TOP, SLEEPER_STEP, GAUGE, SLEEPER_L } from './rails.js';
import { sidewalkMaterial, pathMaterial, regionLook, REGION } from '../roadSurface.js';
// the gravel (tracks and verges): a region's own where it differs (Bora Bora's tracks and verges are coral sand and dirt)
const GRAVEL = { fr: 0xc8b48e };
import { terrainMaterial, waterMaterial, FOG } from '../shaders.js';

const FINE_D = 900, LOAD_D = 2500; // metres from the camera to a chunk's middle: fine within FINE_D; fetched within LOAD_D
const loader = new THREE.TextureLoader(), texCache = new Map();
const tex = (name) => { if (!texCache.has(name)) { const t = loader.load(`tex/roads/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; texCache.set(name, t); } return texCache.get(name); };
const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export class Layout {
  // index: the place's layout/index.json ({ size, chunks: [{ ix, iz, file }], ground: [[iz, ix0, ix1]] (chunks only
  // ground: no file, format.js groundBytes), fallback }); dir: where its files are
  constructor(w, index, dir) {
    this.w = w; this.on = false; this.dir = dir; this.size = index.size; this.group = new THREE.Group(); this.group.name = 'layout';
    const cs = indexChunks(index); this.index = new Map(cs.map((c) => [c.ix + ',' + c.iz, c])); this.chunks = new Map(); this.active = new Map(); this.queue = new Map(); this.busy = false; this.cam = { x: 0, z: 0 };
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
  // a chunk's water: the part of its ground (the shown level's) under the water level, cut along it through the very
  // triangles the ground is drawn with (as World.buildShoreWater does on today's grid), each corner given the depth of
  // the ground under it (the shallows, the foam); null if none of it is under water
  water(m) {
    const wl = this.w.waterLevel, P = m.pos, I = m.idx, out = [], dep = [], poly = [];
    if (!(wl > -Infinity)) return null;
    for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] > KIND.bank) continue; // (the ground and its banks: a paved region is never water, World.groundAt)
      const v = [I[q * 3], I[q * 3 + 1], I[q * 3 + 2]]; if (P[v[0] * 3 + 1] >= wl && P[v[1] * 3 + 1] >= wl && P[v[2] * 3 + 1] >= wl) continue;
      poly.length = 0;
      for (let r = 0; r < 3; r++) { const a = v[r], b = v[(r + 1) % 3], ya = P[a * 3 + 1], yb = P[b * 3 + 1];
        if (ya < wl) poly.push(P[a * 3], P[a * 3 + 2], wl - ya);
        if ((ya < wl) !== (yb < wl)) { const t = (ya - wl) / (ya - yb); poly.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t, 0); } }
      for (let k = 1; k + 1 < poly.length / 3; k++) for (const e of [0, k, k + 1]) { out.push(poly[e * 3], wl, poly[e * 3 + 1]); dep.push(poly[e * 3 + 2]); } }
    if (!out.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1)); g.computeBoundingSphere();
    const me = new THREE.Mesh(g, this.mats.water); me.name = 'layout water'; return me;
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
    this.worker = typeof Worker !== 'undefined' ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) : null;
    if (this.worker) this.worker.onmessage = (ev) => { this.busy = false; const c = this.chunks.get(ev.data.id); if (c) this.got(c, ev.data.level, ev.data.m); this.pump(); };
  }
  // the natural ground at a chunk's grid points (rules.js groundNode: today's terrain base without the roads' carving)
  lattice(L) { const grid = groundGrid(this.w); return { grid, G: latticeHeights(this.w, grid, latticeOf(L, grid)) }; }
  // a chunk's file, fetched and decoded (once)
  load(k) {
    let c = this.chunks.get(k); if (c) return c.ready.then(() => c); const e = this.index.get(k);
    c = { k, ix: e.ix, iz: e.iz, cx: (e.ix + 0.5) * this.size, cz: (e.iz + 0.5) * this.size, m: {}, phys: null, mesh: null, shown: null, asked: new Set() }; this.chunks.set(k, c);
    c.ready = (async () => { if (!e.file) c.buf = groundBytes(e.ix, e.iz, !!this.w.loc.city).buffer; // (only ground: worked out, not fetched)
      else { const r = await fetch(this.dir + e.file), s = r.body.pipeThrough(new DecompressionStream('gzip')); c.buf = await new Response(s).arrayBuffer(); } c.L = decodeLayout(c.buf); })();
    return c.ready.then(() => c);
  }
  ask(c, level) { if (c.asked.has(level)) return; c.asked.add(level); this.queue.set(c.k + ':' + level, [c, level]); this.pump(); }
  // the next mesh to make: the nearest chunk's (fine before coarse at the same distance)
  pump() {
    if (this.busy || !this.queue.size) return;
    let best = null, bd = Infinity; for (const [q, [c, level]] of this.queue) { const d = Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) + (level === 'coarse' ? 1 : 0); if (d < bd) { bd = d; best = q; } }
    const [c, level] = this.queue.get(best); this.queue.delete(best); const { grid, G } = this.lattice(c.L), edgeH = this.edgeH(c);
    if (this.worker) { this.busy = true; this.worker.postMessage({ id: c.k, buf: c.buf.slice(0), grid, G, level, edgeH }, [G.buffer]); }
    else { this.got(c, level, meshChunk(c.L, grid, G, level, edgeH)); this.pump(); } // (Node: no workers; the same function)
  }
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
  got(c, level, m) {
    c.m[level] = m;
    const st = this.stats; if (st && st.firstRingMs == null && st.ring.every((k) => this.chunks.get(k)?.m.fine)) st.firstRingMs = performance.now() - st.t0;
    if (level === 'fine' && !c.phys) { // physics, the mask and the skirts start with the fine mesh
      c.phys = physIndex(c.L, m); this.active.set(c.k, c); this.on = true;
      const i = (c.L.x0 - this.gx0) / this.size, j = (c.L.z0 - this.gz0) / this.size; if (i >= 0 && j >= 0 && i < this.gn && j < this.gn) { this.maskData[j * this.gn + i] = 255; this.mask.needsUpdate = true; }
      if (this.mats) { this.skirtsFor(c); this.railsFor(c); }
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
    const ribG = m.rib.kind.includes(KIND.gravel), matOf = (k) => (k === KIND.ground || k === KIND.bank ? 0 : k === KIND.alley ? 1 : k === KIND.verge || (k === KIND.gravel && !ribG) ? 2 : k === KIND.pavers ? 3 : k === KIND.ballast ? 4 : -1); // (the gravel: with the streets' ribbons below when it's there)
    for (let q = 0; q < m.tk.length;) { const mi = matOf(m.tk[q]); let e = q; while (e < m.tk.length && matOf(m.tk[e]) === mi) e++; if (mi >= 0) g.addGroup(q * 3, (e - q) * 3, mi); q = e; }
    g.computeBoundingSphere(); const surf = new THREE.Mesh(g, this.matList); surf.receiveShadow = true; c.mesh.add(surf);
    if (this.mats.water) { const wm = this.water(m); if (wm) c.mesh.add(wm); }
    const r = m.rib, n = r.kind.length; if (n) {
      const pick = (want) => { const at = []; for (let v = 0; v < n; v += 3) if (want(r.kind[v])) at.push(v); return at; };
      const part = (vs, mat, attrs) => { const k = vs.length * 3, P = new Float32Array(k * 3), N = new Float32Array(k * 3), A = attrs.map(([, size]) => new Float32Array(k * size));
        vs.forEach((v0, t) => { for (let q = 0; q < 3; q++) { const v = v0 + q, o = t * 3 + q; P.set(r.pos.subarray(v * 3, v * 3 + 3), o * 3); N.set(r.nrm.subarray(v * 3, v * 3 + 3), o * 3); attrs.forEach(([, size, f], a) => A[a].set(f(v), o * size)); } });
        const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(P, 3)); gg.setAttribute('normal', new THREE.BufferAttribute(N, 3)); attrs.forEach(([name, size], a) => gg.setAttribute(name, new THREE.BufferAttribute(A[a], size)));
        gg.computeBoundingSphere(); const me = new THREE.Mesh(gg, mat); me.receiveShadow = true; c.mesh.add(me); };
      part(pick((k) => k === KIND.tarmac), this.mats.tarmac, [0, 1, 2, 3, 4, 5].map((a) => ['aM' + a, 4, (v) => r.mark.subarray(v * MARK + a * 4, v * MARK + a * 4 + 4)]));
      // (the pavement and its kerb with today's material: uv = metres across from the street's centre line, along; rinfo = half width, -, seed)
      part(pick((k) => k === KIND.kerb || k === KIND.pave), this.mats.walk, [['uv', 2, (v) => [r.road[v * 4 + 1], r.road[v * 4]]], ['rinfo', 3, (v) => [r.road[v * 4 + 2], 0, 3]], ['rjunc', 4, () => [99, 99, 0, 0]]]);
      // (the gravel with today's tracks' material: uv = across, along; rinfo = half width (half a metre more: its ragged edge
      // stays inside the gravel's own triangles, there's nothing under it), the gravel look 2, seed)
      const trk = pick((k) => k === KIND.gravel); if (trk.length) part(trk, this.mats.track, [['uv', 2, (v) => [r.road[v * 4 + 1], r.road[v * 4]]], ['rinfo', 3, (v) => [r.road[v * 4 + 2] + 0.5, 2, r.id[v] % 97]], ['rjunc', 4, () => [99, 99, 0, 0]]]);
    }
    if (c.rails) for (const o of c.rails.children) if (o.userData.near) o.visible = level === 'fine'; // (the rails and sleepers: near only, sub-pixel further)
    c.shown = level;
  }
  // a chunk's railways (rails.js): the rails and sleepers laid on its surface (or a deck's, a tube's own profile), and a
  // rail bridge's deck, a rail tunnel's tube and portals (a road's are roads.js's, but for its headwall raised under a way over it)
  railsFor(c) {
    const L = c.L, m = c.m.fine, at = (x, z) => physAt(L, m, c.phys, x, z), pcs = railPieces(L, at), ports = portalsOf(L.net.runs); if (!pcs.length && !L.net.runs.some((r) => r.kind === 'rail' && r.off) && !ports.some((p) => p.top > PORTAL_TOP)) return;
    const G = { steel: [], sleeper: [], deck: [], tube: [], ballast: [] }, quad = (A, a, b, cc, d) => A.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    for (const pc of pcs) { const P = pc.P, n = P.length / 5, half = GAUGE[pc.cls] / 2;
      // the rails: a head 7 cm wide RAIL_TOP over the bed, its sides down to the sleepers
      for (const sd of [-1, 1]) { const S = railSide(pc, sd * half, at, true), k = S.length / 5, a = (i, w, dy) => [S[i * 5] - S[i * 5 + 4] * w, S[i * 5 + 2] + dy, S[i * 5 + 1] + S[i * 5 + 3] * w];
        for (let i = 0; i + 1 < k; i++) { quad(G.steel, a(i, -0.035, RAIL_TOP), a(i, 0.035, RAIL_TOP), a(i + 1, 0.035, RAIL_TOP), a(i + 1, -0.035, RAIL_TOP)); quad(G.steel, a(i, -0.035, SLEEPER_TOP), a(i, -0.035, RAIL_TOP), a(i + 1, -0.035, RAIL_TOP), a(i + 1, -0.035, SLEEPER_TOP)); quad(G.steel, a(i, 0.035, RAIL_TOP), a(i, 0.035, SLEEPER_TOP), a(i + 1, 0.035, SLEEPER_TOP), a(i + 1, 0.035, RAIL_TOP)); } }
      // the sleepers: every SLEEPER_STEP m along, their ends on the bed
      const sl = SLEEPER_L[pc.cls] / 2, E0 = railSide(pc, -sl, at), E1 = railSide(pc, sl, at); let acc = SLEEPER_STEP / 2;
      for (let i = 0; i + 1 < n; i++) { const l = Math.hypot(P[i * 5 + 5] - P[i * 5], P[i * 5 + 6] - P[i * 5 + 1]); while (acc < l) { const t = acc / l, f = (Q, k) => Q[i * 5 + k] + (Q[i * 5 + 5 + k] - Q[i * 5 + k]) * t, ux = P[i * 5 + 3] * 0.11, uz = P[i * 5 + 4] * 0.11;
          const a = [f(E0, 0), f(E0, 2) + SLEEPER_TOP, f(E0, 1)], b = [f(E1, 0), f(E1, 2) + SLEEPER_TOP, f(E1, 1)]; quad(G.sleeper, [a[0] - ux, a[1], a[2] - uz], [b[0] - ux, b[1], b[2] - uz], [b[0] + ux, b[1], b[2] + uz], [a[0] + ux, a[1], a[2] + uz]); acc += SLEEPER_STEP; } acc -= l; }
      if (!pc.off) continue;
      // on a deck or in a tube: its bed (level across), and under it the deck (top, sides and parapets, underside), or round it the tube
      const hw = pc.hw, at3 = (k, o, dy) => [P[k * 5] - P[k * 5 + 4] * o, P[k * 5 + 2] + dy, P[k * 5 + 1] + P[k * 5 + 3] * o];
      for (let i = 0; i + 1 < n; i++) { quad(G.ballast, at3(i, -hw, 0), at3(i, hw, 0), at3(i + 1, hw, 0), at3(i + 1, -hw, 0));
        if (pc.off === 'deck') { const W = hw + DECK_SIDE; quad(G.deck, at3(i, -W, -0.01), at3(i, W, -0.01), at3(i + 1, W, -0.01), at3(i + 1, -W, -0.01)); quad(G.deck, at3(i, W, -DECK_DEPTH), at3(i, -W, -DECK_DEPTH), at3(i + 1, -W, -DECK_DEPTH), at3(i + 1, W, -DECK_DEPTH));
          for (const sd of [-1, 1]) { quad(G.deck, at3(i, W * sd, -DECK_DEPTH), at3(i + 1, W * sd, -DECK_DEPTH), at3(i + 1, W * sd, 0.7), at3(i, W * sd, 0.7)); quad(G.deck, at3(i, (W - 0.3) * sd, 0.7), at3(i + 1, (W - 0.3) * sd, 0.7), at3(i + 1, (W - 0.3) * sd, -0.01), at3(i, (W - 0.3) * sd, -0.01)); quad(G.deck, at3(i, W * sd, 0.7), at3(i + 1, W * sd, 0.7), at3(i + 1, (W - 0.3) * sd, 0.7), at3(i, (W - 0.3) * sd, 0.7)); } }
        else { const W = hw + TUBE_SIDE; for (const sd of [-1, 1]) { quad(G.tube, at3(i, W * sd, -0.3), at3(i + 1, W * sd, -0.3), at3(i + 1, W * sd, TUBE_H * 0.8), at3(i, W * sd, TUBE_H * 0.8)); quad(G.tube, at3(i, W * sd, TUBE_H * 0.8), at3(i + 1, W * sd, TUBE_H * 0.8), at3(i + 1, W * 0.55 * sd, TUBE_H), at3(i, W * 0.55 * sd, TUBE_H)); }
          quad(G.tube, at3(i, -W * 0.55, TUBE_H), at3(i + 1, -W * 0.55, TUBE_H), at3(i + 1, W * 0.55, TUBE_H), at3(i, W * 0.55, TUBE_H)); } }
      // (a deck's piers, every ~30 m where it's 3 m or more over the ground)
      if (pc.off === 'deck') for (let i = 15; i < n - 1; i += 15) { const x = P[i * 5], z = P[i * 5 + 1], gy = this.w.sampleGrid(x, z), top = P[i * 5 + 2] - DECK_DEPTH; if (top - gy < 3) continue; const ux = P[i * 5 + 3], uz = P[i * 5 + 4], hx = 0.8, hz = hw + DECK_SIDE - 0.4, cx = (a, o) => [x + ux * a - uz * o, z + uz * a + ux * o];
        for (const [a0, o0, a1, o1] of [[-hx, -hz, hx, -hz], [hx, -hz, hx, hz], [hx, hz, -hx, hz], [-hx, hz, -hx, -hz]]) { const p = cx(a0, o0), q = cx(a1, o1); quad(G.deck, [p[0], gy - 1, p[1]], [q[0], gy - 1, q[1]], [q[0], top, q[1]], [p[0], top, p[1]]); } } }
    // a rail tunnel's portals: the headwall round its mouth (as roads.js's), centred on the portal
    for (const p of ports) { if (p.x < L.x0 || p.x >= L.x0 + L.size || p.z < L.z0 || p.z >= L.z0 + L.size) continue; const T = PORTAL_T / 2, pt = (u, v, y) => [p.x + p.dx * u - p.dz * v, p.y + y, p.z + p.dz * u + p.dx * v];
      const box = (v0, v1, y0, y1) => { for (const u of [-T, T]) quad(G.tube, pt(u, v0, y0), pt(u, v1, y0), pt(u, v1, y1), pt(u, v0, y1)); quad(G.tube, pt(-T, v0, y1), pt(-T, v1, y1), pt(T, v1, y1), pt(T, v0, y1)); for (const v of [v0, v1]) quad(G.tube, pt(-T, v, y0), pt(T, v, y0), pt(T, v, y1), pt(-T, v, y1)); };
      if (!p.rail) { if (p.top > PORTAL_TOP) box(-p.W, p.W, PORTAL_TOP - 0.01, p.top); continue; } // (a road's portal is roads.js's: where a way runs over it, its headwall raised to under that way, rules.js portalsOf)
      box(-p.W, -p.hwT, -PORTAL_FOOT, p.top); box(p.hwT, p.W, -PORTAL_FOOT, p.top); box(-p.hwT, p.hwT, TUBE_H, p.top); box(-p.hwT, p.hwT, -SILL, -0.05); } // (its wings PORTAL_FOOT deep, a sill across the mouth: roads.js's)
    const grp = new THREE.Group(); grp.name = 'layout rails ' + c.k;
    for (const [k, A] of Object.entries(G)) { if (!A.length) continue; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(A, 3)); if (k === 'ballast') { const nv = A.length / 3; g.setAttribute('aRoad', new THREE.Float32BufferAttribute(new Float32Array(nv * 4), 4)); g.setAttribute('aLane', new THREE.Float32BufferAttribute(new Float32Array(nv), 1)); }
      g.computeVertexNormals(); g.computeBoundingSphere(); const me = new THREE.Mesh(g, this.mats[k]); me.receiveShadow = true; me.castShadow = k === 'deck'; me.userData.near = k === 'steel' || k === 'sleeper'; grp.add(me); }
    c.rails = grp; this.group.add(grp);
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
    const air = k <= KIND.bank && w.airfieldPaved?.(x, z); // (the airfield's runways, taxiways and apron: their meshes over this ground, World.groundAt's 'runway', at least runway height)
    if (air) return { h: Math.max(h, w.loc.rwyH), n: new THREE.Vector3(0, 1, 0), type: 'runway' };
    const type = k === KIND.verge || k === KIND.gravel || k === KIND.ballast ? 'sand' : k >= KIND.tarmac || lot ? 'runway' : n.y < 0.8 ? 'rock' : w.loc.desert && !(w.real && w.real.forest(x, z) > 0.45) ? 'sand' : 'grass'; // (a desert's ground: sand, but pine needles under the rims' forests, as World.groundAt)
    return { h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  dispose() { this.worker?.terminate(); for (const c of this.chunks.values()) for (const o of [...(c.mesh?.children || []), ...(c.rails?.children || [])]) o.geometry.dispose(); for (const s of this.skirts.values()) s.geometry.dispose(); this.mask.dispose(); }
}

// a paved surface: its photo texture over a base colour (world-space, metres), and on the tarmac the markings from the
// layout's road coordinates for the carriageway's three nearest streets (mesh.js rib.mark; aM0 .. aM5, two per street:
// along, across, past each of its four nearest mouths, half width (0: none), lanes | one-way 16 | painted 32 | zebra 64), the street nearest past its half width taken per fragment, and its nearest mouth: lane lines, the centre line (New
// York's double yellow) and a crossing's zebra at each junction's mouth (tools/bake/markcheck.mjs picks the same)
function roadMat(texName, color, marks = false, yellow = 0) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }), T = tex(texName);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG); sh.uniforms.tDet = { value: T }; sh.uniforms.uYellow = { value: yellow }; // (the shared fog's uniforms: every custom hook must add them)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aM0; attribute vec4 aM1; attribute vec4 aM2; attribute vec4 aM3; attribute vec4 aM4; attribute vec4 aM5; varying vec4 vM0; varying vec4 vM1; varying vec4 vM2; varying vec4 vM3; varying vec4 vM4; varying vec4 vM5; varying vec2 vLW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvM0 = aM0; vM1 = aM1; vM2 = aM2; vM3 = aM3; vM4 = aM4; vM5 = aM5; vLW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tDet; uniform float uYellow; varying vec4 vM0; varying vec4 vM1; varying vec4 vM2; varying vec4 vM3; varying vec4 vM4; varying vec4 vM5; varying vec2 vLW;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 det = texture2D(tDet, vLW / 3.0).rgb; diffuseColor.rgb *= 0.55 + 0.9 * dot(det, vec3(0.333));
        ${marks ? `{
          float f0 = fwidth(vM0.y), f1 = fwidth(vM2.y), f2 = fwidth(vM4.y), g0 = fwidth(vM0.x), g1 = fwidth(vM2.x), g2 = fwidth(vM4.x);
          float d0 = vM1.z > 0.0 ? abs(vM0.y) - vM1.z : 1e9, d1 = vM3.z > 0.0 ? abs(vM2.y) - vM3.z : 1e9, d2 = vM5.z > 0.0 ? abs(vM4.y) - vM5.z : 1e9;
          vec4 A = vM0, B = vM1; float fv = f0, fu = g0, bd = d0;
          if (d1 < bd) { A = vM2; B = vM3; fv = f1; fu = g1; bd = d1; }
          if (d2 < bd) { A = vM4; B = vM5; fv = f2; fu = g2; }
          float vLane = B.w, dj = abs(A.w) < abs(A.z) ? A.w : A.z; dj = abs(B.x) < abs(dj) ? B.x : dj; dj = abs(B.y) < abs(dj) ? B.y : dj;
          float v = A.y, u = A.x, hw = B.z, aa = fv * 0.8 + 0.005, ua = fu * 0.8 + 0.005;
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
