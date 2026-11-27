// The baked road layout in a World (#294, behind a flag while it's tried out: format.js layoutWanted). For each baked
// chunk: its surface meshed in a worker (mesh.js; fine near the camera, coarse further away, the same edge points at
// both levels), drawn as one mesh (the ground with the terrain's own material, the paved kinds with the layout's), and
// physics (World.sampleGrid / groundAt) reading the fine mesh. Inside a chunk, today's roads, kerbs, junction boxes,
// pavements and ground (coarse, patch and detail) don't draw (clip: a discard by rectangle in their shaders).
import * as THREE from 'three';
import { decodeLayout, KIND } from './format.js';
import { meshChunk, physIndex, physAt, latticeOf } from './mesh.js';
import { sidewalkMaterial } from '../roadSurface.js';
import { terrainMaterial, FOG } from '../shaders.js';

const FINE_D = 900; // metres from the camera to a chunk's middle within which it draws at the fine level
const loader = new THREE.TextureLoader(), texCache = new Map();
const tex = (name) => { if (!texCache.has(name)) { const t = loader.load(`tex/roads/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; texCache.set(name, t); } return texCache.get(name); };

export class Layout {
  // files: each chunk's decompressed bytes (ArrayBuffer)
  constructor(w, files) {
    this.w = w; this.on = false; this.group = new THREE.Group(); this.group.name = 'layout';
    this.chunks = files.map((buf, k) => { const L = decodeLayout(buf); return { k, buf, L, cx: L.x0 + L.size / 2, cz: L.z0 + L.size / 2, m: {}, ix: null, mesh: null, shown: null, asked: new Set() }; });
    this.U = { layN: { value: 0 }, layR: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(1e9, 1e9, -1e9, -1e9)) } };
    this.out = [0, 0, 1, 0]; this.n = new THREE.Vector3();
  }
  // today's ground and road materials: not drawn inside an active chunk
  clip(...mats) {
    const U = this.U;
    for (const m of mats) {
      if (!m || m.userData.layoutClip) continue; m.userData.layoutClip = true;
      const ob = m.onBeforeCompile, key = m.customProgramCacheKey();
      m.onBeforeCompile = function (sh, r) {
        ob.call(this, sh, r); Object.assign(sh.uniforms, U);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vLayXZ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vLayXZ; uniform int layN; uniform vec4 layR[4];')
          .replace('void main() {', 'void main() {\n  for (int i = 0; i < 4; i++) { if (i >= layN) break; vec4 lr = layR[i]; if (vLayXZ.x > lr.x && vLayXZ.x < lr.z && vLayXZ.y > lr.y && vLayXZ.y < lr.w) discard; }');
      };
      m.customProgramCacheKey = () => key + '|layout';
    }
  }
  // maps: the terrain's (World.terrainMaps) for the ground's material
  start(maps) {
    const yellow = this.w.loc.id === 'nyc' ? 1 : 0;
    const skirt = terrainMaterial(maps, 'detail'); skirt.side = THREE.DoubleSide;
    this.mats = { skirt, ground: terrainMaterial(maps, 'detail'), tarmac: roadMat('asphalt_d', 0x5a5a5c, true, yellow), alley: roadMat('asphalt_d', 0x5a5a5c), gravel: roadMat('gravel_d', 0xa09684), pavers: roadMat('sidewalk_d', 0xa89a88), walk: sidewalkMaterial() };
    this.matList = [this.mats.ground, this.mats.alley, this.mats.gravel, this.mats.pavers];
    this.worker = typeof Worker !== 'undefined' ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) : null;
    if (this.worker) this.worker.onmessage = (ev) => this.got(this.chunks[ev.data.id], ev.data.level, ev.data.m);
    for (const c of this.chunks) this.ask(c, 'fine');
  }
  // the hi grid's heights at a chunk's grid points (the natural ground the layout meets)
  lattice(c) {
    const H = this.w.real.hi, grid = { x0: H.x0, z0: H.z0, sp: H.sp }, lat = latticeOf(c.L, grid), out = new Float32Array(lat.ni * lat.nj);
    for (let j = 0; j < lat.nj; j++) for (let i = 0; i < lat.ni; i++) out[j * lat.ni + i] = H.H[Math.max(0, Math.min(H.n - 1, lat.j0 + j)) * H.n + Math.max(0, Math.min(H.n - 1, lat.i0 + i))];
    return { grid, G: out };
  }
  ask(c, level) {
    if (c.asked.has(level)) return; c.asked.add(level);
    const { grid, G } = this.lattice(c);
    if (this.worker) this.worker.postMessage({ id: c.k, buf: c.buf.slice(0), grid, G, level }, [G.buffer]);
    else this.got(c, level, meshChunk(c.L, grid, G, level)); // (Node: no workers; the same function)
  }
  got(c, level, m) {
    c.m[level] = m;
    if (level === 'fine' && !c.ix) { // physics and the clipping start with the fine mesh
      c.ix = physIndex(c.L, m); const r = this.U.layR.value[this.U.layN.value++]; r.set(c.L.x0, c.L.z0, c.L.x0 + c.L.size, c.L.z0 + c.L.size);
      c.skirt = this.skirt(c, m); this.on = true;
      this.ask(c, 'coarse');
    }
    if (!c.shown) this.show(c, level);
  }
  // where a chunk meets today's ground (no baked chunk beside it), a wall from its edge to today's ground's height there:
  // the two needn't meet (today's roads and banks are its own), and without it the sky showed through (#297: the
  // white sliver at Lauterbrunnen's chunk, where a road's bank met today's ground metres off)
  skirt(c, m) {
    const L = c.L, P = m.pos, n = P.length / 3, w = this.w, sides = [[(x) => x === L.x0, -1, 0], [(x) => x === L.x0 + L.size, 1, 0], [null, 0, -1], [null, 0, 1]], out = [], nrm = [];
    const was = this.on; this.on = false; // (today's ground: World.sampleGrid without the layout)
    for (const [, dx, dz] of sides) {
      if (this.chunks.some((o) => o !== c && o.L.ix === L.ix + dx && o.L.iz === L.iz + dz)) continue; // (a baked chunk beside it: they meet)
      const onSide = (k) => (dx ? P[k * 3] === (dx < 0 ? L.x0 : L.x0 + L.size) : P[k * 3 + 2] === (dz < 0 ? L.z0 : L.z0 + L.size));
      const ks = []; for (let k = 0; k < n; k++) if (onSide(k)) ks.push(k); ks.sort((a, b) => (dx ? P[a * 3 + 2] - P[b * 3 + 2] : P[a * 3] - P[b * 3]));
      const T = ks.map((k) => w.sampleGrid(P[k * 3], P[k * 3 + 2]));
      for (let q = 0; q + 1 < ks.length; q++) { const a = ks[q], b = ks[q + 1], ya = P[a * 3 + 1], yb = P[b * 3 + 1], lo = Math.min(ya, yb, T[q], T[q + 1]) - 0.3, hi = Math.max(ya, yb, T[q], T[q + 1]);
        if (hi - lo < 0.35) continue; const A = [P[a * 3], P[a * 3 + 2]], B = [P[b * 3], P[b * 3 + 2]];
        out.push(A[0], hi, A[1], B[0], hi, B[1], B[0], lo, B[1], A[0], hi, A[1], B[0], lo, B[1], A[0], lo, A[1]); for (let v = 0; v < 6; v++) nrm.push(dx, 0, dz); }
    }
    this.on = was; if (!out.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.computeBoundingSphere();
    const me = new THREE.Mesh(g, this.mats.skirt); me.name = 'layout skirt'; this.group.add(me); return me;
  }
  show(c, level) {
    const m = c.m[level]; if (!m) return;
    if (!c.mesh) { c.mesh = new THREE.Group(); c.mesh.name = 'layout ' + c.L.ix + ',' + c.L.iz; this.group.add(c.mesh); }
    for (const o of c.mesh.children) o.geometry.dispose(); c.mesh.clear();
    // the surface (ground, alleys, gravel, pavers); the carriageway, kerbs and pavements from the street ribbons below
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3)); g.setIndex(new THREE.BufferAttribute(m.idx, 1));
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
  update(cam) {
    for (const c of this.chunks) { if (!c.ix) continue; const want = Math.hypot(cam.position.x - c.cx, cam.position.z - c.cz) < FINE_D ? 'fine' : 'coarse'; if (want === c.shown) continue; if (c.m[want]) this.show(c, want); else this.ask(c, want); }
  }
  // the physics height at (x, z) (NaN outside the active chunks)
  heightAt(x, z, out) {
    for (const c of this.chunks) if (c.ix && x >= c.L.x0 && z >= c.L.z0 && x < c.L.x0 + c.L.size && z < c.L.z0 + c.L.size) return physAt(c.L, c.m.fine, c.ix, x, z, out);
    return NaN;
  }
  // World.groundAt's answer inside an active chunk (null outside): height, normal, surface type
  ground(x, z) {
    const o = this.out, h = this.heightAt(x, z, o); if (!(h === h)) return null;
    const c = this.chunks.find((c) => c.ix && x >= c.L.x0 && z >= c.L.z0 && x < c.L.x0 + c.L.size && z < c.L.z0 + c.L.size), k = c.m.fine.tk[o[0]];
    const w = this.w, n = new THREE.Vector3(o[1], o[2], o[3]), lot = k <= KIND.bank && w.cityD && w.cityPaved(x, z) > 0.5 && w.real.bare(x, z); // (a city's paved lots, as World.groundAt says)
    const type = k === KIND.verge || k === KIND.gravel ? 'sand' : k >= KIND.tarmac || lot ? 'runway' : n.y < 0.8 ? 'rock' : 'grass';
    return { h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  dispose() { this.worker?.terminate(); for (const c of this.chunks) { for (const o of c.mesh?.children || []) o.geometry.dispose(); c.skirt?.geometry.dispose(); } }
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
          float lanes = max(1.0, mod(vLane, 16.0)), oneway = mod(floor(vLane / 16.0), 2.0), painted = step(32.0, vLane);
          float paint = 0.0; vec3 col = vec3(0.92);
          if (hw > 0.5 && painted > 0.5 && (dj < -0.5 || dj > 0.5)) {
            float dash = step(fract(u / 9.0), 0.45);
            if (oneway < 0.5) { // two-way: the centre line, and lane lines each side
              float c = uYellow > 0.5 ? max(1.0 - smoothstep(0.05, 0.05 + aa, abs(abs(v) - 0.12)), 0.0) : (1.0 - smoothstep(0.06, 0.06 + aa, abs(v))) * dash;
              if (c > 0.0) { paint = c; col = uYellow > 0.5 ? vec3(0.85, 0.66, 0.12) : vec3(0.92); }
              float per = max(1.0, floor(lanes / 2.0)), lw = hw / per;
              for (int k = 1; k < 4; k++) { if (float(k) >= per) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(abs(v) - lw * float(k)))) * dash); }
            } else { float lw = 2.0 * hw / lanes; for (int k = 1; k < 6; k++) { if (float(k) >= lanes) break; paint = max(paint, (1.0 - smoothstep(0.06, 0.06 + aa, abs(v + hw - lw * float(k)))) * dash); } }
            if (dj > 0.5 && dj < 3.5 && abs(v) < hw - 0.3) { paint = max(paint, step(0.5, fract(v / 1.2))); col = vec3(0.92); } // (the zebra)
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, col, paint * 0.9);
        }` : ''}`);
  };
  m.customProgramCacheKey = () => 'layoutRoad|' + texName + '|' + marks;
  return m;
}
