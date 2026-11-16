// Destructible buildings. Fly into a house, a chalet or a skyscraper and it takes the blow in proportion to it (the
// kinetic energy the plane brings in, by its speed, its mass and the angle it comes in at, against the energy the
// building can soak up, by its volume): a small hit punches a hole (or knocks off a corner, the roof, a chimney), a big
// one brings the whole building down floor by floor in a cloud of dust, and a tall tower hit high up loses its top:
// the floors above come down, or the whole top section topples off and smashes into the street. Cartoon-safe: bricks,
// glass, dust, smoke and small fires, nobody inside.
//
// How it's cheap: every building is one contiguous run of vertices in its chunk's merged mesh (towns.js,
// realBuildings.js, realCity.js record the run on its collision entry). A one-byte `dmg` vertex attribute
// (buildings.js) marks a damaged building with a slot in a small float texture (the height it has fallen to and the
// holes through it, which the building shader discards with jagged, sooty edges) or 255 for gone (dropped in the
// vertex shader). Damaging a building uploads a few bytes; no mesh is rebuilt. The shadow maps use the same test.
// Its collision entry follows: the height drops to the rubble and holes are let through, so you can fly through the
// gap afterwards.
//
// Effects, all pooled and sized per quality tier: debris chunks wearing the building's own facade (instanced, the
// building material), glass shards, dust (the shared smoke particles), a rubble mound, a scorch mark, small fires
// and lingering smoke, a burnt cavity behind each hole, and for a toppling top section one rigid proxy box drawn with
// the building material. Damage lasts the whole flight (New York's low tiles stream out and back in: their damage is
// re-applied by restore()).
//
// Events for sound (pushed to the flight's events, see main.js): {type: 'building_hit', pos, power 0..1, glass,
// material, size} on every blow, and {type: 'collapse', pos, size, phase: 'start' | 'end'} when a building (or a
// top section) comes down and when it has settled; the toppled top hitting the ground is a 'building_hit' too.
import * as THREE from 'three';
import { DMG, DMG_SLOTS, DMG_HOLES, C, buildingMaterial, buildingDepthMaterial } from './buildings.js';
import { FOG } from './shaders.js';

const K_BLD = 800; // J per m³ of building: the energy that brings it down
const K_HOLE = 9000; // J per m³ punched out of it
const G = 9.81;
const TIER = {
  low: { chunks: 110, shards: 50, dust: 0.3, fires: 3, mounds: 24, shadows: false },
  medium: { chunks: 240, shards: 120, dust: 0.5, fires: 5, mounds: 40, shadows: false },
  high: { chunks: 480, shards: 260, dust: 1, fires: 9, mounds: 64, shadows: true },
  ultra: { chunks: 720, shards: 380, dust: 1.2, fires: 12, mounds: 64, shadows: true },
};
const CELLPX = { low: 128, medium: 192, high: 256, ultra: 384 };
const ROW = (1 + DMG_HOLES) * 4; // floats per damage slot
const PARK = new THREE.Matrix4().compose(new THREE.Vector3(0, -1e4, 0), new THREE.Quaternion(), new THREE.Vector3(1e-4, 1e-4, 1e-4));
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
const MATERIAL = (cell) => ([C.WOOD, C.WOOD_WIN, C.WOOD_WIN2, C.WOOD_DOOR, C.BOARDS, C.CLAP, C.CLAP_WIN, C.CLAP_DOOR, C.DARKWOOD, C.THATCH].includes(cell) ? 'wood'
  : [C.BRICK, C.BRICK_WIN].includes(cell) ? 'brick' : [C.STONE, C.STONE_WIN, C.ADOBE, C.ADOBE_WIN, C.ADOBE_WIN2, C.ADOBE_DOOR, C.CHURCH_WIN].includes(cell) ? 'stone'
    : cell === C.GLASS ? 'glass' : [C.METAL, C.SEAM, C.HANGAR_DOOR].includes(cell) ? 'metal' : 'concrete');

export class Destruction {
  constructor(world) {
    const W = (this.w = world);
    this.T = TIER[W.qName] || TIER[W.qBase] || TIER.medium;
    this.group = new THREE.Group(); this.group.name = 'destruction'; W.group.add(this.group);
    this.states = new Map(); // building key (collision entry .dk) -> its damage state
    this.time = 0; this.events = []; this.fires = []; this.anims = []; this.proxies = []; this.later = [];
    this.fx = null; this.onImpact = null; // (main.js: the flight's effects; multiplayer relay of our own blows)
    // damage slots (rows of DMG.tex): fresh for every flight
    DMG.data.fill(0); for (let s = 0; s < DMG_SLOTS; s++) DMG.data[s * ROW] = 1e9;
    DMG.tex.needsUpdate = true;
    this.free = []; for (let s = DMG_SLOTS - 2; s >= 1; s--) this.free.push(s);
    this.slotOwner = new Array(DMG_SLOTS).fill(null);
    this.texDirty = false;
    const cellPx = CELLPX[W.qName] ?? 256;
    // debris chunks + rubble mounds: the building material, instanced (each chunk shows its building's facade cell, tint)
    this.bmat = buildingMaterial({ cellPx, interiors: false });
    this.chunks = this.pool(chunkGeo(), this.T.chunks, true);
    this.mounds = this.pool(moundGeo(), this.T.mounds, true);
    this.mounds.mesh.castShadow = false;
    // glass shards: bright, glinting, tumbling
    const sm = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.4, roughness: 0.06, side: THREE.DoubleSide, envMapIntensity: 1.6 });
    this.shards = this.pool(shardGeo(), this.T.shards, false, sm);
    // burnt cavities behind holes (the inside of a sphere, clipped to the building's box) and scorch marks
    this.cav = this.cavities(48);
    this.scorch = this.scorches(48);
    this.ready = true;
  }

  // ---------------- pools ----------------
  // an InstancedMesh with per-instance rigid-body state; building-material pools carry instanced atl + color
  pool(geo, n, bld, mat) {
    const P = { n, i: 0, used: 1, awake: 0, P: new Float32Array(n * 3), V: new Float32Array(n * 3), Q: new Float32Array(n * 4), Wv: new Float32Array(n * 3), S: new Float32Array(n * 3), age: new Float32Array(n), st: new Uint8Array(n), life: new Float32Array(n) };
    if (bld) {
      P.atl = new THREE.InstancedBufferAttribute(new Uint8Array(n * 4), 4, false); P.col = new THREE.InstancedBufferAttribute(new Uint8Array(n * 3).fill(200), 3, true);
      P.atl.setUsage(THREE.DynamicDrawUsage); P.col.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('atl', P.atl); geo.setAttribute('color', P.col);
    }
    const m = new THREE.InstancedMesh(geo, mat || this.bmat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (!bld) { m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    for (let k = 0; k < n; k++) m.setMatrixAt(k, ZERO);
    m.setMatrixAt(0, PARK); // (one instance always drawn: its shaders, and its shadow shader, compile behind the loading screen)
    m.count = 1; m.frustumCulled = false; m.castShadow = bld && this.T.shadows; m.receiveShadow = true;
    this.group.add(m); P.mesh = m;
    return P;
  }
  take(P) {
    const k = P.i; P.i = (P.i + 1) % P.n; if (P.i === 0) P.i = 1; // (instance 0 stays parked)
    P.used = Math.max(P.used, k + 1); P.mesh.count = P.used;
    return k;
  }
  // a piece of debris: position, velocity, size (x, y, z), look ([cell, r, g, b] for building pieces, colour for shards)
  spawn(P, x, y, z, vx, vy, vz, sx, sy, sz, look, spin = 4, life = 0) {
    const k = this.take(P);
    P.P.set([x, y, z], k * 3); P.V.set([vx, vy, vz], k * 3); P.S.set([sx, sy, sz], k * 3);
    _q.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)); P.Q.set([_q.x, _q.y, _q.z, _q.w], k * 4);
    P.Wv.set([rnd(spin), rnd(spin), rnd(spin)], k * 3); P.age[k] = 0; P.st[k] = 1; P.life[k] = life;
    if (P.atl) {
      P.atl.array.set([look[0], (Math.random() * 255) | 0, 40, 0], k * 4); P.col.array.set([look[1], look[2], look[3]], k * 3);
      P.atl.addUpdateRange(k * 4, 4); P.col.addUpdateRange(k * 3, 3); P.atl.needsUpdate = P.col.needsUpdate = true;
    } else { P.mesh.instanceColor.setXYZ(k, look.r, look.g, look.b); P.mesh.instanceColor.needsUpdate = true; }
    return k;
  }
  step(P, dt, shard) {
    const W = this.w, m = P.mesh, wl = W.waterLevel ?? -1e9;
    let dirty = false;
    for (let k = 1; k < P.used; k++) {
      const st = P.st[k]; if (!st) continue;
      P.age[k] += dt;
      if (st === 2) { // asleep (rubble): shards fade away, chunks stay
        if (shard && P.age[k] > P.life[k]) { P.st[k] = 0; m.setMatrixAt(k, ZERO); dirty = true; }
        continue;
      }
      const i3 = k * 3, i4 = k * 4, p = P.P, v = P.V;
      const drag = shard ? 1.6 : 0.05;
      v[i3] *= 1 - drag * dt; v[i3 + 2] *= 1 - drag * dt; v[i3 + 1] = v[i3 + 1] * (1 - drag * 0.5 * dt) - G * dt;
      if (shard && v[i3 + 1] < -14) v[i3 + 1] = -14; // (thin plates flutter down)
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      const w = P.Wv, wl2 = Math.hypot(w[i3], w[i3 + 1], w[i3 + 2]);
      _q.set(P.Q[i4], P.Q[i4 + 1], P.Q[i4 + 2], P.Q[i4 + 3]);
      if (wl2 > 1e-4) { _q2.setFromAxisAngle(_v.set(w[i3] / wl2, w[i3 + 1] / wl2, w[i3 + 2] / wl2), wl2 * dt); _q.premultiply(_q2); P.Q.set([_q.x, _q.y, _q.z, _q.w], i4); }
      const r = shard ? 0.05 : Math.min(P.S[i3], P.S[i3 + 1], P.S[i3 + 2]) * 0.45;
      const gy = W.heightAt(p[i3], p[i3 + 2]);
      if (gy < wl && p[i3 + 1] < wl) { // into the water: a splash, gone
        if (!shard && P.S[i3] > 0.8 && this.fx) this.fx.spray({ x: p[i3], y: wl, z: p[i3 + 2] }, Math.min(20, -v[i3 + 1]));
        P.st[k] = 0; m.setMatrixAt(k, ZERO); dirty = true; continue;
      }
      if (p[i3 + 1] - r < gy) {
        p[i3 + 1] = gy + r;
        if (v[i3 + 1] < 0) {
          const hard = -v[i3 + 1];
          v[i3 + 1] = hard > 3 && !shard ? hard * 0.25 : 0; v[i3] *= 0.55; v[i3 + 2] *= 0.55; w[i3] *= 0.5; w[i3 + 1] *= 0.5; w[i3 + 2] *= 0.5;
          if (!shard && hard > 7 && P.S[i3] > 0.9 && this.fx && Math.random() < 0.35) this.fx.dust({ x: p[i3], y: gy, z: p[i3 + 2] }, { x: v[i3], z: v[i3 + 2] }, 'rock', 2);
        }
        if (Math.hypot(v[i3], v[i3 + 1], v[i3 + 2]) < (shard ? 1.5 : 0.9)) { P.st[k] = 2; v[i3] = v[i3 + 1] = v[i3 + 2] = 0; P.age[k] = 0; if (shard) P.life[k] = 2 + Math.random() * 3; }
      }
      if (P.age[k] > 25) { P.st[k] = 2; P.age[k] = 0; if (shard) P.life[k] = 1; } // (never tumbling forever)
      _v.set(p[i3], p[i3 + 1], p[i3 + 2]); _s.set(P.S[i3], P.S[i3 + 1], P.S[i3 + 2]);
      m.setMatrixAt(k, _m.compose(_v, _q, _s)); dirty = true;
    }
    if (dirty) m.instanceMatrix.needsUpdate = true;
  }
  // burnt cavities: BackSide spheres, each clipped to its building's box (instanced obA: x, z, ux, uz; obB: hl, hw, y0, y1)
  cavities(n) {
    const g = new THREE.SphereGeometry(1, 18, 12);
    const A = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4), B = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    g.setAttribute('obA', A); g.setAttribute('obB', B);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 1, side: THREE.BackSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOG); // (the global height-fog hook this replaces, shaders.js)
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 obA; attribute vec4 obB; varying vec4 vObA; varying vec4 vObB; varying vec3 vCw;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvObA = obA; vObB = obB; vCw = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vObA; varying vec4 vObB; varying vec3 vCw; float cvH(vec3 p) { return fract(sin(dot(p, vec3(12.99, 78.23, 37.72))) * 43758.55); }')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          { vec2 d = vCw.xz - vObA.xy; float u = dot(d, vObA.zw), w = dot(d, vec2(-vObA.w, vObA.z));
            if (abs(u) > vObB.x || abs(w) > vObB.y || vCw.y > vObB.w || vCw.y < vObB.z) discard; }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float cvE = step(0.94, cvH(floor(vCw * 4.5))) * step(0.4, cvH(floor(vCw * 0.8))); diffuseColor.rgb *= 0.5 + 0.7 * cvH(floor(vCw * 2.5));
          totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * cvE * 2.2; // embers`);
    };
    mat.customProgramCacheKey = () => 'cavity1';
    const m = new THREE.InstancedMesh(g, mat, n); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < n; k++) m.setMatrixAt(k, ZERO);
    m.setMatrixAt(0, PARK); m.count = 1; m.frustumCulled = false;
    this.group.add(m);
    return { m, A, B, n, i: 1, used: 1 };
  }
  scorches(n) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    for (let k = 0; k < 40; k++) { // blotchy soot, darkest in the middle
      const a = Math.random() * 6.28, d = Math.random() * 38, x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d, r = 14 + Math.random() * 26;
      const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(14,11,8,0.7)'); gr.addColorStop(1, 'rgba(20,16,12,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, n);
    for (let k = 0; k < n; k++) m.setMatrixAt(k, ZERO);
    m.setMatrixAt(0, PARK); m.count = 1; m.frustumCulled = false; m.renderOrder = 1;
    this.group.add(m);
    return { m, n, i: 1, used: 1 };
  }
  ring(R) { const k = R.i; R.i = (R.i + 1) % R.n || 1; R.used = Math.max(R.used, k + 1); R.m.count = R.used; return k; }

  // ---------------- buildings: state, look, slots, flags ----------------
  // a collision entry's box: { x, z, ux, uz, hl, hw } (towns/OSM: e.ob; New York: the box in the entry; else a square)
  box(e) {
    if (e.ob) return e.ob;
    if (e.length >= 9) return { x: e[0], z: e[2], ux: e[5], uz: e[6], hl: e[7], hw: e[8] };
    return { x: e[0], z: e[2], ux: 1, uz: 0, hl: e[4], hw: e[4] };
  }
  get(e) {
    let B = this.states.get(e.dk);
    if (B) return B;
    const ob = this.box(e), y0 = e[1], y1 = e[1] + e[3], h = Math.max(2, e[3]);
    const V = Math.max(30, 4 * ob.hl * ob.hw * h * (e.ob || e.length >= 9 ? 1 : 0.8));
    B = { dk: e.dk, ents: [e], ob, y0, y1, h, V, hp: V * K_BLD, E: 0, slot: 0, flag: 0, holes: [], cut: 1e9, rubble: y0, collapsed: false, top: false, anim: null, born: this.time, look: this.look(e), type: e.type, cav: [] };
    this.states.set(e.dk, B);
    return B;
  }
  // what it's made of: wall cell + colour, roof colour, glass (from its vertices when the arrays are still around)
  look(e) {
    if (e.look) return e.look;
    const L = { cell: C.PLAIN, col: 0xd8d0c4, rcol: 0x6a6460, glass: false };
    const [h, s0, n] = e.rng?.[0] || [];
    const g = h?.geo, atl = g?.attributes.atl?.array, col = g?.attributes.color?.array, nor = g?.attributes.normal?.array;
    if (!atl || atl.length < (s0 + n) * 4 || !col || !nor) return L;
    const cnt = new Map(); let wr = 0, wg = 0, wb = 0, wn = 0, rr = 0, rg = 0, rb = 0, rn = 0, glass = 0;
    for (let i = s0; i < s0 + n; i += 4) {
      const ny = nor[i * 3 + 1], cell = atl[i * 4];
      if (Math.abs(ny) < 40) { cnt.set(cell, (cnt.get(cell) || 0) + 1); wr += col[i * 3]; wg += col[i * 3 + 1]; wb += col[i * 3 + 2]; wn++; if (cell === C.GLASS) glass++; }
      else if (ny > 40) { rr += col[i * 3]; rg += col[i * 3 + 1]; rb += col[i * 3 + 2]; rn++; }
    }
    let best = -1; for (const [c, k] of cnt) if (k > best) { best = k; L.cell = c; }
    if (wn) L.col = ((wr / wn) << 16) | ((wg / wn) << 8) | (wb / wn);
    if (rn) L.rcol = ((rr / rn) << 16) | ((rg / rn) << 8) | (rb / rn);
    L.glass = glass > wn * 0.3;
    return L;
  }
  // write a building's dmg byte (0 intact, slot, 255 gone) into its vertex runs
  setFlag(B, val) {
    B.flag = val;
    for (const e of B.ents) for (const [h, s, n] of e.rng || []) {
      if (!n) continue;
      const a = h.geo?.attributes.dmg;
      if (!a) { (h.dmgW || (h.dmgW = [])).push([s, n, val]); continue; } // (its mesh isn't built yet: when it is)
      // static meshes free their arrays once uploaded (realCity.js): a zeroed stand-in, of which only this run uploads
      if (a.array.length !== a.count) a.array = new Uint8Array(a.count);
      a.array.fill(val, s, s + n); a.addUpdateRange(s, n); a.needsUpdate = true;
    }
  }
  slotFor(B) {
    if (B.slot) return B.slot;
    if (!this.free.length) { // all in use: the oldest damaged building is simply gone (its rubble stays)
      let old = null; for (const o of this.slotOwner) if (o && o !== B && (!old || o.born < old.born) && !o.anim) old = o;
      if (old) { const s = old.slot; this.clearSlot(s); old.slot = 0; this.setFlag(old, 255); this.free.push(s); }
      else return 0;
    }
    const s = this.free.pop(); B.slot = s; this.slotOwner[s] = B;
    const o = s * ROW; DMG.data.fill(0, o, o + ROW); DMG.data[o] = 1e9; DMG.data[o + 1] = 0; DMG.data[o + 2] = 1; // power out
    this.texDirty = true;
    this.setFlag(B, s);
    return s;
  }
  clearSlot(s) { const o = s * ROW; DMG.data.fill(0, o, o + ROW); DMG.data[o] = 1e9; this.slotOwner[s] = null; this.texDirty = true; }
  setCut(B, y, jag) {
    B.cut = y; const s = this.slotFor(B); if (!s) return;
    DMG.data[s * ROW] = y; DMG.data[s * ROW + 1] = jag; this.texDirty = true;
    const top = Math.max(y - jag * 0.5, B.rubble); // collisions: down to the jagged stump / the rubble
    for (const e of B.ents) e[3] = Math.max(0, top - e[1]);
  }
  addHole(B, x, y, z, r) {
    const s = this.slotFor(B); if (!s) return -1;
    let k = B.holes.length;
    if (k >= DMG_HOLES) { // full: the nearest hole grows to swallow this one
      let bd = 1e9; for (let j = 0; j < B.holes.length; j++) { const h = B.holes[j], d = Math.hypot(h[0] - x, h[1] - y, h[2] - z); if (d < bd) { bd = d; k = j; } }
      const h = B.holes[k], R = Math.max(h[3], (bd + h[3] + r) / 2);
      if (bd > 0.01) { const t = (R - h[3]) / bd; x = h[0] + (x - h[0]) * t; y = h[1] + (y - h[1]) * t; z = h[2] + (z - h[2]) * t; } else { x = h[0]; y = h[1]; z = h[2]; }
      r = Math.min(R, Math.max(B.ob.hl, B.ob.hw) * 1.2);
    }
    B.holes[k] = [x, y, z, r];
    DMG.data.set([x, y, z, r], s * ROW + 4 + k * 4); this.texDirty = true;
    return k;
  }
  // New York's low tiles stream back in: put back what had happened to this building
  restore(e) {
    const B = this.states.get(e.dk); if (!B) return;
    const i = B.ents.findIndex((x) => x.dk === e.dk); if (i >= 0) B.ents[i] = e; else B.ents.push(e);
    if (B.flag) for (const [h, s, n] of e.rng || []) (h.dmgW || (h.dmgW = [])).push([s, n, B.flag]);
    if (B.cut < 1e8) e[3] = Math.max(0, Math.max(B.cut - 1, B.rubble) - e[1]);
  }
  // a point inside a building, but in one of its holes (main.js: no hit there)
  passes(e, p) {
    const B = e.dk && this.states.get(e.dk); if (!B) return false;
    if (B.anim && p.y > B.anim.to + 1.5) return true; // coming down: it gives way
    if (!B.holes.length) return false;
    for (const h of B.holes) if ((p.x - h[0]) ** 2 + (p.y - h[1]) ** 2 + (p.z - h[2]) ** 2 < (h[3] * 0.85) ** 2) return true;
    return false;
  }
  // outward normal of the building's face nearest p
  normal(B, p, out) {
    const o = B.ob, dx = p.x - o.x, dz = p.z - o.z, u = dx * o.ux + dz * o.uz, w = -dx * o.uz + dz * o.ux;
    const pu = o.hl - Math.abs(u), pw = o.hw - Math.abs(w), py = Math.min(B.cut, B.y1) - p.y;
    if (py < pu && py < pw) return out.set(0, 1, 0);
    if (pu < pw) return out.set(o.ux * Math.sign(u || 1), 0, o.uz * Math.sign(u || 1));
    return out.set(-o.uz * Math.sign(w || 1), 0, o.ux * Math.sign(w || 1));
  }

  // ---------------- impacts ----------------
  // One of the aircraft's parts is inside building entry e at wp: how much of the blow the plane still takes (1: all of
  // it, like an unbreakable wall; less when the building gives way). Called every frame of contact; the building
  // itself takes one blow per contact (one per 0.35 s).
  impact(e, wp, ac, part) {
    if (!e.dk || !this.ready) return 1;
    const B = this.get(e);
    const v = ac.v, sp = v.length(); if (sp < 5) return 1;
    const n = this.normal(B, wp, new THREE.Vector3());
    const vn = Math.max(Math.abs(v.dot(n)), 0.35 * sp); // (a glancing blow still digs in)
    // head on (the aircraft's own path runs into the building): all of it goes in; a wingtip clipping a corner: that part
    const cat = part?.d?.cat || '', light = /wing|tail|gear|prop|extra/.test(cat) && !this.onCourse(B, ac.x, v, sp, (ac.radius || 6) + 8);
    const m = light ? Math.min(ac.mass * 0.5, (part.mass || 50) * 4) : ac.mass;
    let E = 0.5 * m * vn * vn;
    if (B.lastAc === ac && this.time - B.lastHit < 0.35) { // the same contact: only a heavier part coming in adds to it
      if (E <= B.lastE * 1.05) return B.give ?? 1;
      E -= B.lastE; B.lastE += E;
    } else { B.lastE = E; B.give = 1; }
    B.lastAc = ac; B.lastHit = this.time;
    const dir = v.clone().divideScalar(sp);
    B.give = Math.min(B.give ?? 1, this.damage(B, E, wp.clone(), dir, n, sp));
    this.onImpact?.({ p: [wp.x, wp.y, wp.z].map((x) => Math.round(x * 10) / 10), E: Math.round(E), d: [dir.x, dir.y, dir.z].map((x) => Math.round(x * 100) / 100), s: Math.round(sp) });
    return B.give;
  }
  onCourse(B, x, v, sp, dist) {
    const o = B.ob, top = Math.min(B.cut, B.y1);
    for (let s = 0; s <= dist; s += 1) {
      const px = x.x + v.x / sp * s, py = x.y + v.y / sp * s, pz = x.z + v.z / sp * s, dx = px - o.x, dz = pz - o.z;
      if (py > B.y0 && py < top && Math.abs(dx * o.ux + dz * o.uz) < o.hl && Math.abs(-dx * o.uz + dz * o.ux) < o.hw) return true;
    }
    return false;
  }
  // a blow from another pilot (net.js): the same building, the same energy
  remote(m) {
    const ok = (x) => Number.isFinite(x) && Math.abs(x) < 1e6;
    if (!m || !Array.isArray(m.p) || !Array.isArray(m.d) || !m.p.every(ok) || !m.d.every(ok) || !(m.E > 0 && m.E < 1e11)) return;
    const p = new THREE.Vector3(...m.p), e = this.w.towns.hit(p); if (!e?.dk) return;
    const B = this.get(e), dir = new THREE.Vector3(...m.d).normalize();
    this.damage(B, m.E, p, dir, this.normal(B, p, new THREE.Vector3()), m.s || 40);
  }
  // energy E (J) into building B at p, travelling along dir (unit), hitting the face with normal n. Returns the give.
  // second: a knock-on blow (a neighbour, falling debris), which never knocks on again
  damage(B, E, p, dir, n, speed, second = false) {
    const fx = this.fx; if (!fx) return 1;
    B.E += E;
    const f = E / B.hp, F = B.E / B.hp, L = B.look, tall = B.h > 40;
    const power = Math.min(1, Math.sqrt(E / 4e7));
    this.events.push({ type: 'building_hit', pos: p.clone(), power, glass: L.glass, material: MATERIAL(L.cell), size: B.h });
    this.special(B, p, f);
    if (B.collapsed || (B.anim && B.anim.full)) { this.burst(B, p, dir, n, Math.min(E, 2e6), 0.4); return 0.7; }
    let give = 1;
    const hi = (p.y - B.y0) / B.h;
    if (tall && !B.top && F >= 0.15 && F < 1.4 && hi > 0.3) { this.topCollapse(B, p, dir, n, hi > 0.6 ? 'topple' : 'pancake'); give = 0.65; }
    else if (F >= 1 || (B.top && F >= 1.4)) { this.collapse(B, p, dir); give = 0.6; }
    else {
      const maxR = Math.min(Math.max(B.ob.hl, B.ob.hw) * 0.9, Math.min(B.ob.hl, B.ob.hw) * 1.1, tall ? 16 : 8);
      const r = Math.min(maxR, Math.cbrt((3 * E) / (4 * Math.PI * K_HOLE)));
      if (r > 0.9) {
        const c = p.clone().addScaledVector(n, -r * 0.25); // (centred a little inside: the hole goes in, not out)
        const k = this.addHole(B, c.x, c.y, c.z, r);
        if (k >= 0) this.cavity(B, k, n.y > 0.5);
        give = 0.85;
      }
    }
    this.burst(B, p, dir, n, E, f);
    if (f > 2.5 && !second) this.spread(B, p, dir, Math.min(E - B.hp, 4e9)); // a big blow knocks into the neighbours too
    return give;
  }
  // something special about this building
  special(B, p, f) {
    const fx = this.fx;
    if (B.type === 'waterTower' && !B.splashed && f > 0.05) { B.splashed = true; const top = new THREE.Vector3(B.ob.x, Math.min(B.cut, B.y1) - 3, B.ob.z); fx.splash(top, 60); fx.splash(top, 40); for (let k = 0; k < 40; k++) fx.smoke.add(top.x + rnd(4), top.y, top.z + rnd(4), rnd(10), 2 + Math.random() * 10, rnd(10), 2.5, 2, 8, 0.92, 0.95, 1, 0.8, 0.6, 9.8); }
    else if (B.type === 'gasStation' && !B.boomed && f > 0.05) { B.boomed = true; fx.explosion(p, 2.2); this.fire(p.x, B.y0 + 1, p.z, 1.6, 80); this.events.push({ type: 'building_hit', pos: p.clone(), power: 1, glass: false, material: 'fuel', size: B.h }); }
    else if (B.type === 'silo' && !B.dusted && f > 0.05) { B.dusted = true; for (let k = 0; k < 50 * this.T.dust; k++) fx.smoke.add(p.x + rnd(3), p.y + rnd(3), p.z + rnd(3), rnd(9), 1 + Math.random() * 6, rnd(9), 6 + Math.random() * 4, 2, 14, 0.92, 0.82, 0.5, 0.75, 0.7, -0.15); }
  }
  // debris, glass and dust flying out of the hit
  burst(B, p, dir, n, E, f) {
    const fx = this.fx, T = this.T, L = B.look, k = Math.min(1, Math.sqrt(E / 3e7));
    const [cell, r, g, b] = this.lookArr(L.cell, L.col), rc = this.lookArr(C.SLATE, L.rcol ?? 0x6a6460, 1.6);
    const nCh = Math.round((6 + 50 * k) * T.chunks / 480), sz = 0.35 + 1.1 * k;
    for (let i = 0; i < nCh; i++) {
      const sp = 3 + Math.random() * (6 + 14 * k), out = 0.6 + Math.random();
      const s = sz * (0.4 + Math.random() * 0.9);
      const look = n.y > 0.5 && Math.random() < 0.6 ? rc : Math.random() < 0.15 ? [C.CONCRETE, 200, 196, 188] : [cell, r, g, b];
      this.spawn(this.chunks, p.x + rnd(1), p.y + rnd(1), p.z + rnd(1), n.x * sp * out + dir.x * sp * 0.5 + rnd(3), n.y * sp + Math.random() * 6, n.z * sp * out + dir.z * sp * 0.5 + rnd(3), s, s * (0.5 + Math.random() * 0.6), s * (0.6 + Math.random() * 0.6), look, 6);
    }
    const nGl = Math.round((L.glass ? 18 + 50 * k : 4 + 10 * k) * T.shards / 260);
    for (let i = 0; i < nGl; i++) { const sp = 3 + Math.random() * 10; this.spawn(this.shards, p.x + rnd(2), p.y + rnd(2), p.z + rnd(2), n.x * sp + rnd(4), Math.random() * 5, n.z * sp + rnd(4), 0.25 + Math.random() * 0.5, 0.25 + Math.random() * 0.6, 1, glassCol(L), 10); }
    if (nGl > 3) for (let i = 0; i < 12; i++) fx.fire.add(p.x, p.y, p.z, n.x * 8 + rnd(6), Math.random() * 4, n.z * 8 + rnd(6), 0.5 + Math.random() * 0.6, 0.18, 0.05, 0.8, 0.95, 1, 1, 0.6, 9.8); // glints
    const dc = this.dustCol(L), nD = Math.round((4 + 24 * k) * T.dust);
    for (let i = 0; i < nD; i++) fx.smoke.add(p.x + rnd(1.5), p.y + rnd(1.5), p.z + rnd(1.5), n.x * (2 + Math.random() * 7) + rnd(2), 0.5 + Math.random() * 2.5, n.z * (2 + Math.random() * 7) + rnd(2), 3 + Math.random() * 4, 1.5 + 2 * k, 6 + 14 * k, dc[0], dc[1], dc[2], 0.7, 0.8, -0.12);
  }
  lookArr(cell, hex, k = 1) { _c.setHex(hex).multiplyScalar(k); return [cell, Math.min(255, _c.r * 255) | 0, Math.min(255, _c.g * 255) | 0, Math.min(255, _c.b * 255) | 0]; }
  dustCol(L) { _c.setHex(L.col).lerp(new THREE.Color(0xb4aca0), 0.6); return [_c.r, _c.g, _c.b]; }
  // the burnt hollow behind a hole (roof holes: only the half below the roof)
  cavity(B, k, roof) {
    const R = this.cav, h = B.holes[k], o = B.ob;
    let i = B.cav[k]; if (i == null) { i = this.ring(R); B.cav[k] = i; }
    R.m.setMatrixAt(i, _m.compose(_v.set(h[0], h[1], h[2]), _q.identity(), _s.setScalar(h[3] * 0.97)));
    R.A.setXYZW(i, o.x, o.z, o.ux, o.uz); R.B.setXYZW(i, o.hl + 0.15, o.hw + 0.15, B.y0 - 1, roof ? h[1] + 0.2 : Math.min(B.cut, B.y1) + 0.2);
    R.m.instanceMatrix.needsUpdate = true; R.A.needsUpdate = R.B.needsUpdate = true;
  }
  dropCavities(B) { for (const i of B.cav) if (i != null) this.cav.m.setMatrixAt(i, ZERO); this.cav.m.instanceMatrix.needsUpdate = true; B.cav = []; }
  // the neighbours around a big blow (sampled: a ring of points around the building)
  spread(B, p, dir, E) {
    if (E <= 0) return;
    const R = Math.min(70, 10 + Math.sqrt(E) / 300), r0 = Math.max(B.ob.hl, B.ob.hw), hits = [];
    for (const e of this.near(p.x + dir.x * R * 0.3, p.z + dir.z * R * 0.3, r0 + R)) {
      if (!e.dk || e.dk === B.dk || e[1] + e[3] < p.y - 30) continue;
      const dd = Math.hypot(e[0] - p.x, e[2] - p.z) - Math.max(this.box(e).hl, this.box(e).hw); if (dd > R) continue;
      const share = E * 0.3 * Math.max(0.1, 1 - Math.max(0, dd) / R);
      const q = new THREE.Vector3(e[0], Math.min(p.y, e[1] + e[3] * 0.6), e[2]), dn = q.clone().sub(p).setY(0).normalize();
      hits.push({ t: this.time + 0.15 + Math.max(0, dd) / 45, e, E: share, p: q, dir: dn });
    }
    this.later.push(...hits.sort((a, b) => b.E - a.E).slice(0, 6)); // (the nearest few: a domino, not the whole block)
  }

  // ---------------- collapses ----------------
  collapse(B, p, dir) {
    if (B.anim?.full || B.collapsed) return;
    this.dropCavities(B); B.holes = []; if (B.slot) DMG.data.fill(0, B.slot * ROW + 4, B.slot * ROW + ROW);
    const from = Math.min(B.cut, B.y1), rubbleH = Math.min(14, Math.max(1.4, Math.min(B.ob.hl, B.ob.hw) * 0.7), 1.2 + B.h * 0.1);
    B.rubble = B.y0 + rubbleH * 0.7;
    const T = Math.min(9, Math.max(1.4, 0.9 + Math.sqrt((from - B.y0) / G) * 1.4));
    if (B.anim) this.anims.splice(this.anims.indexOf(B), 1); // (the top was already coming down: now all of it)
    B.anim = { full: true, from, to: B.y0 + 0.6, T, t: 0, acc: 0, dacc: 0, rubbleH, mound: this.mound(B, B.y0, rubbleH, 0.02), dir: dir.clone(), base: B.y0 };
    this.anims.push(B);
    this.bringDown(B, B.anim);
    this.events.push({ type: 'collapse', pos: new THREE.Vector3(B.ob.x, B.y0, B.ob.z), size: B.h, phase: 'start' });
  }
  // a tall tower hit high up: the floors above come down onto the stump (pancake), or the top section topples off
  topCollapse(B, p, dir, n, mode) {
    B.top = true; this.dropCavities(B);
    const cutY = Math.max(B.y0 + B.h * 0.25, p.y - 4), jag = 3;
    if (mode === 'topple' && this.proxies.length < 3) {
      this.setCut(B, cutY, jag);
      let top = B.y1, hl = B.ob.hl, hw = B.ob.hw; const o = B.ob, same = [B.dk];
      for (const C2 of this.stacked(B, cutY)) {
        same.push(C2.dk);
        top = Math.max(top, C2.y1); C2.top = true; this.dropCavities(C2); this.setCut(C2, cutY, jag); C2.collapsed = C2.y0 >= cutY;
        const b = C2.ob; for (const [su, sw] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const x = b.x + b.ux * b.hl * su - b.uz * b.hw * sw - o.x, z = b.z + b.uz * b.hl * su + b.ux * b.hw * sw - o.z; hl = Math.max(hl, Math.abs(x * o.ux + z * o.uz)); hw = Math.max(hw, Math.abs(-x * o.uz + z * o.ux)); }
      }
      this.topple(B, cutY, dir, top, hl, hw, same);
      this.burst(B, new THREE.Vector3(p.x, cutY, p.z), dir, n, 3e7, 1);
      B.anim = null;
      this.mound(B, cutY - jag * 0.6, Math.min(4, B.ob.hw * 0.3), 1);
      this.fire(B.ob.x + rnd(B.ob.hl * 0.4), cutY, B.ob.z + rnd(B.ob.hw * 0.4), 1.4, 120);
      this.events.push({ type: 'collapse', pos: new THREE.Vector3(B.ob.x, cutY, B.ob.z), size: B.y1 - cutY, phase: 'start' });
      return;
    }
    const from = Math.min(B.cut, B.y1), T = Math.min(8, Math.max(1.5, Math.sqrt((from - cutY) / G) * 1.6));
    B.anim = { full: false, from, to: cutY, T, t: 0, acc: 0, dacc: 0, rubbleH: Math.min(5, B.ob.hw * 0.35), mound: this.mound(B, cutY - jag * 0.6, Math.min(5, B.ob.hw * 0.35), 0.02), dir: dir.clone(), base: B.y0, jag };
    this.anims.push(B);
    this.bringDown(B, B.anim);
    this.events.push({ type: 'collapse', pos: new THREE.Vector3(B.ob.x, cutY, B.ob.z), size: from - cutY, phase: 'start' });
  }
  // rubble mound over the building's footprint (k: how grown it is, 0..1)
  mound(B, y, h, k) {
    const P = this.mounds, o = B.ob, i = this.take(P), L = B.look;
    _c.setHex(L.col).lerp(new THREE.Color(0x6a645c), 0.55).multiplyScalar(0.8);
    P.atl.array.set([Math.random() < 0.5 ? C.GRAVEL : C.COBBLE, (Math.random() * 255) | 0, 40, 0], i * 4); P.col.array.set([_c.r * 255, _c.g * 255, _c.b * 255], i * 3);
    P.atl.addUpdateRange(i * 4, 4); P.col.addUpdateRange(i * 3, 3); P.atl.needsUpdate = P.col.needsUpdate = true;
    P.st[i] = 2; // (not simulated)
    const M = { i, x: o.x, y, z: o.z, sx: o.hl * 1.08, sz: o.hw * 1.08, h, yaw: Math.atan2(-o.uz, o.ux) };
    this.setMound(M, k);
    return M;
  }
  setMound(M, k) {
    const e = Math.max(0.02, k);
    this.mounds.mesh.setMatrixAt(M.i, _m.compose(_v.set(M.x, M.y - 0.3, M.z), _q.setFromAxisAngle(_v2.set(0, 1, 0), M.yaw), _s.set(M.sx * (0.7 + 0.3 * e), M.h * e, M.sz * (0.7 + 0.3 * e))));
    this.mounds.mesh.instanceMatrix.needsUpdate = true;
  }
  // broken slabs of wall and roof lying on a rubble mound (asleep: rubble, not simulated)
  pile(B, M) {
    const L = B.look, n = Math.min(40, Math.round((8 + Math.sqrt(B.V) * 0.25) * this.T.chunks / 480)), wall = this.lookArr(L.cell, L.col), roof = this.lookArr(C.SLATE, L.rcol ?? 0x6a6460, 1.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * 0.85, u = Math.cos(a) * r, w = Math.sin(a) * r, cs = Math.cos(M.yaw), sn = Math.sin(M.yaw);
      const lx = u * M.sx, lz = w * M.sz, x = M.x + lx * cs + lz * sn, z = M.z - lx * sn + lz * cs, y = M.y - 0.3 + M.h * Math.sqrt(Math.max(0, 1 - r * r)) * 0.85;
      const s = 0.8 + Math.random() * (1.2 + Math.min(3, Math.sqrt(B.V) / 60));
      const k = this.spawn(this.chunks, x, y, z, 0, 0, 0, s, s * (0.25 + Math.random() * 0.3), s * (0.5 + Math.random() * 0.5), Math.random() < 0.3 ? roof : wall, 0);
      this.chunks.st[k] = 2; _q.setFromEuler(new THREE.Euler(rnd(0.6), Math.random() * 6.3, rnd(0.6)));
      this.chunks.mesh.setMatrixAt(k, _m.compose(_v.set(x, y, z), _q, _s.set(s, s * 0.4, s * 0.8)));
    }
    this.chunks.mesh.instanceMatrix.needsUpdate = true;
  }
  scorchAt(x, y, z, r) {
    const R = this.scorch, i = this.ring(R);
    R.m.setMatrixAt(i, _m.compose(_v.set(x, y + 0.15, z), _q.setFromAxisAngle(_v2.set(0, 1, 0), Math.random() * 6.3), _s.set(r * 2, 1, r * 2)));
    R.m.instanceMatrix.needsUpdate = true;
  }
  fire(x, y, z, k, life) { this.fires.push({ x, y, z, k, t: 0, life: life * (0.7 + Math.random() * 0.6), smoke: 90 + Math.random() * 60 }); }
  stepAnim(B, dt) {
    const a = B.anim, fx = this.fx, T = this.T, o = B.ob, L = B.look;
    a.t += dt; const k = Math.min(1, a.t / a.T), y = a.from - (a.from - a.to) * k * k; // falling faster and faster
    this.setCut(B, y, a.full ? 2 + Math.min(4, B.h * 0.05) : a.jag);
    if (a.mound) this.setMound(a.mound, 0.02 + 0.98 * Math.min(1, k * 1.15));
    // chunks off the falling edge, dust pouring out of each floor as it goes, a rolling cloud along the street
    const big = Math.min(1, Math.sqrt(B.V) / 300) * (a.quiet ? 0.4 : 1), per = Math.max(o.hl, o.hw);
    a.acc += dt * (14 + 70 * big) * T.chunks / 480 * (a.quiet ? 0.3 : 1);
    const look = this.lookArr(L.cell, L.col);
    while (a.acc >= 1) {
      a.acc--;
      const s = Math.random() * 4, side = Math.floor(s), t = s - side, [u, w] = side === 0 ? [t * 2 - 1, 1] : side === 1 ? [1, t * 2 - 1] : side === 2 ? [t * 2 - 1, -1] : [-1, t * 2 - 1];
      const lx = u * o.hl, lw = w * o.hw, x = o.x + lx * o.ux - lw * o.uz, z = o.z + lx * o.uz + lw * o.ux;
      const nx = (x - o.x) / per, nz = (z - o.z) / per, sz = 0.6 + Math.random() * (1.6 + 3 * big);
      this.spawn(this.chunks, x, y - Math.random() * 3, z, nx * (2 + Math.random() * 6) + a.dir.x * 2, -Math.random() * 4, nz * (2 + Math.random() * 6) + a.dir.z * 2, sz, sz * (0.4 + Math.random() * 0.5), sz * (0.6 + Math.random() * 0.5), Math.random() < 0.25 ? this.lookArr(C.SLATE, L.rcol, 1.6) : look, 3);
      if (L.glass && Math.random() < 0.8) this.spawn(this.shards, x, y, z, nx * 6 + rnd(3), Math.random() * 2, nz * 6 + rnd(3), 0.3 + Math.random() * 0.5, 0.3 + Math.random() * 0.5, 1, glassCol(L), 9);
    }
    const dc = this.dustCol(L);
    a.dacc += dt * (8 + 55 * big) * T.dust * (a.quiet ? 0.3 : 1);
    while (a.dacc >= 1) {
      a.dacc--;
      const ang = Math.random() * 6.28, cs = Math.cos(ang), sn = Math.sin(ang), r = per * (0.7 + Math.random() * 0.5);
      if (Math.random() < 0.45) fx.smoke.add(o.x + cs * r, y - Math.random() * 4, o.z + sn * r, cs * (3 + Math.random() * 5), 1 + Math.random() * 2, sn * (3 + Math.random() * 5), 4 + Math.random() * 3 + 6 * big, 2 + 4 * big, 7 + 26 * big, dc[0], dc[1], dc[2], 0.75, 0.7, -0.08);
      else { // at the foot: billowing out along the ground and up
        const sp = 5 + Math.random() * (8 + 12 * big), gy = a.full ? a.base : this.w.heightAt(o.x + cs * r, o.z + sn * r);
        fx.smoke.add(o.x + cs * r, gy + 1 + Math.random() * 3, o.z + sn * r, cs * sp, 0.5 + Math.random() * 3, sn * sp, 5 + Math.random() * 4 + 8 * big, 3 + 5 * big, 9 + 34 * big, dc[0], dc[1], dc[2], 0.8, 0.55, -0.1);
      }
    }
    if (k >= 1) this.settle(B);
  }
  settle(B) {
    const a = B.anim, o = B.ob; B.anim = null;
    this.anims.splice(this.anims.indexOf(B), 1);
    if (!a.mound) { B.collapsed = B.y0 >= a.to - 1; return; } // (a part that stood on another building: gone with it)
    this.setMound(a.mound, 1);
    this.pile(B, a.mound);
    const gy = this.w.heightAt(o.x, o.z), r = Math.max(o.hl, o.hw);
    this.scorchAt(o.x, gy, o.z, r * 1.5 + 4);
    const nf = a.full ? 1 + (B.V > 4000 ? 1 : 0) + (B.V > 30000 ? 1 : 0) : 1;
    for (let k = 0; k < nf; k++) this.fire(o.x + rnd(o.hl * 0.6), a.full ? B.rubble : a.to, o.z + rnd(o.hw * 0.6), 0.8 + Math.random() * 0.8, 70);
    if (a.full) { B.collapsed = true; for (const e of B.ents) e[3] = Math.max(0, B.rubble - e[1]); }
    else this.scorchAt(o.x, gy, o.z, r + 6); // (the debris that rained down from the top)
    this.events.push({ type: 'collapse', pos: new THREE.Vector3(o.x, a.to, o.z), size: B.h, phase: 'end' });
  }
  // collision entries (every scenery keeps them in 50 m cells) within r of x, z
  near(x, z, r) {
    const out = new Set(), T = this.w.towns;
    for (const g of [T.grid, T.city?.grid]) {
      if (!g) continue;
      for (let i = Math.floor((x - r) / 50); i <= Math.floor((x + r) / 50); i++) for (let j = Math.floor((z - r) / 50); j <= Math.floor((z + r) / 50); j++) for (const e of g.get(i + ',' + j) || []) out.add(e);
    }
    return out;
  }
  // the rest of the same building above height y: New York's towers are several OSM parts, overlapping tiers and
  // setbacks standing on each other (and masts, plain collision boxes: just lowered)
  stacked(B, y) {
    const o = B.ob, out = [], inBox = (b, x, z, pad) => { const dx = x - b.x, dz = z - b.z; return Math.abs(dx * b.ux + dz * b.uz) < b.hl + pad && Math.abs(-dx * b.uz + dz * b.ux) < b.hw + pad; };
    for (const e of this.near(o.x, o.z, Math.hypot(o.hl, o.hw) + 2)) {
      if (e.dk === B.dk || e[1] + e[3] < y + 1) continue;
      const b = this.box(e); if (!inBox(o, b.x, b.z, 1) && !inBox(b, o.x, o.z, 1)) continue;
      if (!e.dk) { if (e.solid) e[3] = Math.max(0, y - e[1]); continue; }
      const C2 = this.get(e); if (!C2.anim && !C2.collapsed && C2.cut > y + 1) out.push(C2);
    }
    return out;
  }
  // ...which come down with it, at the same pace
  bringDown(B, a) {
    for (const C2 of this.stacked(B, a.to)) {
      C2.top = true; this.dropCavities(C2);
      C2.anim = { full: false, from: Math.min(C2.cut, C2.y1), to: Math.max(a.to, C2.y0) - (C2.y0 >= a.to - 1 ? 3 : 0), T: a.T, t: 0, acc: 0, dacc: 0, rubbleH: 0, mound: null, dir: a.dir, base: B.y0, jag: a.jag ?? 2, quiet: true };
      this.anims.push(C2);
    }
  }
  // ---------------- the toppling top section: one rigid box drawn with the building material ----------------
  topple(B, cutY, dir, top, hl, hw, same) {
    const o = { ...B.ob, hl, hw }, H = top - cutY; if (H < 3) return;
    const mat = this.w.towns.mat || this.w.towns.city?.mat; if (!mat) return;
    const geo = proxyGeo(o.hl * 2, H, o.hw * 2, B.look);
    const mesh = new THREE.Mesh(geo, mat); mesh.customDepthMaterial = buildingDepthMaterial(); mesh.castShadow = this.T.shadows; mesh.receiveShadow = true;
    const yaw = Math.atan2(-o.uz, o.ux);
    mesh.quaternion.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    mesh.position.set(o.x, cutY + H / 2, o.z);
    this.group.add(mesh);
    const d = new THREE.Vector3(dir.x, 0, dir.z); if (d.lengthSq() < 1e-4) d.set(1, 0, 0); d.normalize();
    // pivot: the bottom edge on the side it falls toward (the box's support point along d)
    const ax = new THREE.Vector3(o.ux, 0, o.uz), az = new THREE.Vector3(-o.uz, 0, o.ux);
    const reach = Math.abs(d.dot(ax)) * o.hl + Math.abs(d.dot(az)) * o.hw;
    const pivot = new THREE.Vector3(o.x, cutY, o.z).addScaledVector(d, reach * 0.8);
    const axis = new THREE.Vector3(0, 1, 0).cross(d).normalize();
    this.proxies.push({ mesh, B, H, hx: o.hl, hz: o.hw, pivot, axis, q0: mesh.quaternion.clone(), c0: mesh.position.clone(), th: 0, om: 0.15, phase: 0, v: new THREE.Vector3(), w: new THREE.Vector3(), t: 0, mass: 4 * o.hl * o.hw * H * 220, hit: new Set(same) /* (not its own stumps) */, release: 0.35 + Math.random() * 0.25 });
  }
  stepProxy(P, dt) {
    const W = this.w, m = P.mesh; P.t += dt;
    if (P.phase === 0) { // tipping over the edge
      P.om += (1.6 * G / Math.max(6, P.H)) * Math.sin(P.th + 0.25) * dt; P.th += P.om * dt;
      _q.setFromAxisAngle(P.axis, P.th);
      m.position.copy(P.c0).sub(P.pivot).applyQuaternion(_q).add(P.pivot);
      m.quaternion.copy(P.q0).premultiply(_q);
      if (P.th > P.release) { // off the edge: free fall, keeping its spin
        P.phase = 1; P.w.copy(P.axis).multiplyScalar(P.om * 0.8);
        P.v.copy(P.w).cross(_v.copy(m.position).sub(P.pivot));
      }
    } else {
      P.v.y -= G * dt; m.position.addScaledVector(P.v, dt);
      const wl = P.w.length(); if (wl > 1e-4) { _q.setFromAxisAngle(_v.copy(P.w).divideScalar(wl), wl * dt); m.quaternion.premultiply(_q); }
    }
    m.updateMatrixWorld();
    // the lowest corner: on the ground (or in the water), or into another building on the way down
    let low = Infinity, lp = null;
    for (let k = 0; k < 8; k++) {
      _v.set(k & 1 ? P.hx : -P.hx, k & 2 ? P.H / 2 : -P.H / 2, k & 4 ? P.hz : -P.hz).applyMatrix4(m.matrixWorld);
      const g = Math.max(W.heightAt(_v.x, _v.z), W.waterLevel ?? -1e9), d = _v.y - g;
      if (d < low) { low = d; lp = _v.clone(); }
      if (P.phase === 1 && k % 2 === 0) { const e = W.towns.hit(_v); if (e?.dk && !P.hit.has(e.dk)) { P.hit.add(e.dk); const B2 = this.get(e); const vv = P.v.length(); this.damage(B2, Math.min(0.5 * P.mass * vv * vv * 0.4, B2.hp * 1.5), _v.clone(), P.v.clone().normalize(), this.normal(B2, _v, new THREE.Vector3()), vv, true); } }
    }
    if ((P.phase === 1 && low < 0.3) || P.t > 14) this.shatter(P, lp || m.position);
  }
  shatter(P, at) {
    const fx = this.fx, m = P.mesh, B = P.B, L = B.look, T = this.T;
    this.proxies.splice(this.proxies.indexOf(P), 1); this.group.remove(m); m.geometry.dispose();
    const vol = 8 * P.hx * P.hz * P.H / 8, big = Math.min(1, Math.sqrt(vol) / 250);
    const look = this.lookArr(L.cell, L.col), n = Math.round(T.chunks * (0.25 + 0.35 * big));
    for (let i = 0; i < n; i++) {
      _v.set(rnd(P.hx), rnd(P.H / 2), rnd(P.hz)).applyMatrix4(m.matrixWorld);
      const s = 0.8 + Math.random() * (1.5 + 3 * big);
      this.spawn(this.chunks, _v.x, Math.max(_v.y, at.y + 0.5), _v.z, P.v.x * 0.3 + rnd(8), Math.random() * 9, P.v.z * 0.3 + rnd(8), s, s * (0.4 + Math.random() * 0.5), s * (0.6 + Math.random() * 0.5), Math.random() < 0.2 ? this.lookArr(C.SLATE, L.rcol, 1.6) : look, 4);
    }
    if (L.glass) for (let i = 0; i < T.shards * 0.4; i++) { _v.set(rnd(P.hx), rnd(P.H / 2), rnd(P.hz)).applyMatrix4(m.matrixWorld); this.spawn(this.shards, _v.x, _v.y, _v.z, rnd(12), Math.random() * 8, rnd(12), 0.3 + Math.random() * 0.6, 0.3 + Math.random() * 0.6, 1, glassCol(L), 10); }
    const dc = this.dustCol(L), gy = this.w.heightAt(at.x, at.z);
    for (let i = 0; i < (60 + 120 * big) * T.dust; i++) { const a = Math.random() * 6.28, sp = 4 + Math.random() * (10 + 16 * big); fx.smoke.add(at.x + Math.cos(a) * 4, gy + 1 + Math.random() * 6, at.z + Math.sin(a) * 4, Math.cos(a) * sp, 1 + Math.random() * 5, Math.sin(a) * sp, 8 + Math.random() * 8, 5 + 4 * big, 20 + 30 * big, dc[0], dc[1], dc[2], 0.8, 0.5, -0.1); }
    // the pile where it landed, a scorch, a fire
    const fake = { ob: { x: at.x, z: at.z, ux: B.ob.ux, uz: B.ob.uz, hl: Math.max(P.hx, P.H * 0.35), hw: Math.max(P.hz, P.H * 0.2) }, look: L };
    const M = this.mound(fake, gy, Math.min(8, 1.5 + P.H * 0.06), 1);
    this.scorchAt(at.x, gy, at.z, Math.max(fake.ob.hl, fake.ob.hw) + 5);
    this.fire(at.x, gy + M.h * 0.6, at.z, 1.2, 90);
    this.events.push({ type: 'building_hit', pos: at.clone(), power: 1, glass: L.glass, material: MATERIAL(L.cell), size: P.H });
    this.events.push({ type: 'collapse', pos: at.clone(), size: P.H, phase: 'end' });
    // flattens what it lands on
    const e = this.w.towns.hit({ x: at.x, y: gy + 3, z: at.z }); if (e?.dk && !P.hit.has(e.dk)) { const B2 = this.get(e); this.damage(B2, B2.hp * 1.2, at.clone().setY(gy + 3), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0), 30, true); }
  }

  // ---------------- per frame ----------------
  // dt: the flight's (slow-motion) step; cam: camera position; out: the flight's event list (sounds)
  update(dt, fx, cam, out) {
    this.fx = fx; this.time += dt;
    if (this.later.length) for (let i = this.later.length - 1; i >= 0; i--) { const L = this.later[i]; if (this.time >= L.t) { this.later.splice(i, 1); const B = this.get(L.e); this.damage(B, Math.min(L.E, B.hp * 2), L.p, L.dir, this.normal(B, L.p, new THREE.Vector3()), 30, true); } }
    for (let i = this.anims.length - 1; i >= 0; i--) this.stepAnim(this.anims[i], dt);
    for (let i = this.proxies.length - 1; i >= 0; i--) this.stepProxy(this.proxies[i], dt);
    this.step(this.chunks, dt, false); this.step(this.shards, dt, true);
    // fires: the nearest few burn, then smoulder
    if (this.fires.length) {
      const near = this.fires.filter((f) => f.t < f.life + f.smoke).sort((a, b) => ((a.x - cam.x) ** 2 + (a.z - cam.z) ** 2) - ((b.x - cam.x) ** 2 + (b.z - cam.z) ** 2));
      for (let i = 0; i < near.length; i++) {
        const f = near[i]; f.t += dt;
        if (i >= this.T.fires || (f.x - cam.x) ** 2 + (f.z - cam.z) ** 2 > 4000 ** 2) continue;
        const p = { x: f.x + rnd(1.5), y: f.y, z: f.z + rnd(1.5) };
        if (f.t < f.life) { if (Math.random() < 0.7) fx.burn(p, f.k * (f.t < f.life - 10 ? 1 : (f.life - f.t) / 10)); }
        else if (Math.random() < dt * 6) { const g = 0.18 + Math.random() * 0.1; fx.smoke.add(p.x, p.y + 1, p.z, rnd(0.6), 2.5 + Math.random() * 2, rnd(0.6), 10, 2, 14, g, g, g, 0.45 * (1 - (f.t - f.life) / f.smoke), 0.3, -0.3); }
      }
      if (this.fires.length > 60) this.fires = this.fires.filter((f) => f.t < f.life + f.smoke);
    }
    if (this.texDirty) { DMG.tex.needsUpdate = true; this.texDirty = false; }
    if (out && this.events.length) out.push(...this.events.splice(0));
  }
  info() { let s = 0; for (const B of this.states.values()) if (B.slot) s++; return { buildings: this.states.size, slots: s, chunks: this.chunks.used, anims: this.anims.length, proxies: this.proxies.length, fires: this.fires.length }; }
}

const glassCol = (L) => (L.glass ? { r: 0.75 + Math.random() * 0.25, g: 0.9 + Math.random() * 0.1, b: 1 } : { r: 0.85, g: 0.92, b: 1 });

// ---------------- geometry ----------------
// a chunk: a box with its corners knocked about; each face shows part of one facade bay
function chunkGeo() {
  const g = new THREE.BoxGeometry(1, 1, 1), p = g.attributes.position, uv = g.attributes.uv;
  const off = {}; const r = () => (Math.random() - 0.5) * 0.36;
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.sign(p.getX(i))}${Math.sign(p.getY(i))}${Math.sign(p.getZ(i))}`; off[k] ??= [r(), r(), r()];
    p.setXYZ(i, p.getX(i) + off[k][0], p.getY(i) + off[k][1], p.getZ(i) + off[k][2]);
    // most faces: the plain wall at the edge of a facade bay (beside and below the window); one face: a bit of window
    const f = Math.floor(i / 4), win = f === 4;
    uv.setXY(i, win ? 0.3 + uv.getX(i) * 0.4 : 0.01 + uv.getX(i) * 0.22 + (f % 2) * 0.75, win ? 0.35 + uv.getY(i) * 0.4 : 0.02 + uv.getY(i) * 0.2 + (f % 3 === 1 ? 0.78 : 0));
  }
  g.computeVertexNormals();
  return g;
}
function shardGeo() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.4, 0, 0.5, -0.5, 0, 0.1, 0.6, 0, 0.5, -0.5, 0, 0.45, 0.3, 0, 0.1, 0.6, 0], 3));
  g.computeVertexNormals();
  return g;
}
// a lumpy low dome (unit radius, unit height), uv tiled so the gravel photo reads as rubble at any size
function moundGeo() {
  const g = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), p = g.attributes.position, uv = g.attributes.uv;
  const h = (x, z) => Math.sin(x * 7.3 + z * 3.1) * 0.5 + Math.sin(x * 2.7 - z * 8.9) * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.18 * h(x, z) * Math.sin(y * Math.PI);
    p.setXYZ(i, x * k, Math.max(0, y * (0.9 + 0.25 * h(z, x))), z * k);
    uv.setXY(i, (x + 1) * 3, (z + 1) * 3);
  }
  g.computeVertexNormals();
  return g;
}
// the toppling top: a box W x H x D (centred) with the building's facade on its sides, roof on top, a broken base
function proxyGeo(Wd, H, D, L) {
  const pos = [], nor = [], uv = [], col = [], atl = [], idx = [];
  const hw = Wd / 2, hh = H / 2, hd = D / 2, bay = L.glass ? 6 : 3, fl = L.glass ? 4 : 3;
  _c.setHex(L.col); const wc = [_c.r * 255, _c.g * 255, _c.b * 255]; _c.setHex(L.rcol ?? 0x5c5a56); const rcc = [_c.r * 255, _c.g * 255, _c.b * 255];
  const face = (P, n, u1, v1, cell, cc) => {
    const o = pos.length / 3;
    for (let k = 0; k < 4; k++) { pos.push(...P[k]); nor.push(...n); col.push(...cc); atl.push(cell, 77, 200, 0); }
    uv.push(0, 0, u1, 0, u1, v1, 0, v1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const nb = (L2) => Math.max(1, Math.round(L2 / bay)), v1 = H / fl;
  face([[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], [0, 0, 1], nb(Wd), v1, L.cell, wc);
  face([[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]], [0, 0, -1], nb(Wd), v1, L.cell, wc);
  face([[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], [1, 0, 0], nb(D), v1, L.cell, wc);
  face([[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]], [-1, 0, 0], nb(D), v1, L.cell, wc);
  face([[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], [0, 1, 0], Wd / 3, D / 3, L.glass ? C.SEAM : C.ASPHALT, rcc);
  face([[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]], [0, -1, 0], Wd / 3, D / 3, C.CONCRETE, [70, 64, 58]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col.map((x) => x | 0)), 3, true));
  g.setAttribute('atl', new THREE.BufferAttribute(new Uint8Array(atl), 4, false)); g.setAttribute('dmg', new THREE.BufferAttribute(new Uint8Array(24), 1));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}
