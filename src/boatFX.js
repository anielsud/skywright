// A boat's spray and wake (main.js makes one for a boat flight, before the shaders are compiled).
// - spray: a sheet off each side of the bow where the bow wave meets the hull, a rooster tail off the motor when it is
//   up on the plane, a burst off the outside of a hard turn, a splash when the hull slams down; the fire monitors'
//   jets of water (the smoke button). All of it is Effects' smoke particles (white): no new materials.
// - wake: one ribbon mesh lying on the water (a foam trail from the transom and the two arms of the V spreading out
//   from it), rebuilt each frame from a ring of points dropped behind the boat. One draw call, one material.
import * as THREE from 'three';
import { clamp } from './noise.js';

const N = 160; // wake points kept
let wakeMat = null;
const _v = new THREE.Vector3(), _xb = new THREE.Vector3(), _zb = new THREE.Vector3(), _p = new THREE.Vector3();

export class BoatFX {
  constructor(scene, ac) {
    this.ac = ac; this.scene = scene;
    this.pts = []; this.dropT = 0; this.t = 0;
    const g = (this.geo = new THREE.BufferGeometry());
    this.pos = new Float32Array(N * 6 * 3); this.col = new Float32Array(N * 6 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint16Array((N - 1) * 3 * 6); let k = 0;
    for (let i = 0; i < N - 1; i++) for (let s = 0; s < 3; s++) { const a = i * 6 + s * 2, b = a + 1, c = a + 6, d = a + 7; idx.set([a, c, b, b, c, d], k); k += 6; }
    g.setIndex(new THREE.BufferAttribute(idx, 1)); g.setDrawRange(0, 0);
    this.mat = wakeMat || (wakeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide })); // (kept between flights: its shader too)
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; this.mesh.name = 'wake';
    scene.add(this.mesh);
    // the stern and the hull's half beam, in the design frame (from the floating columns)
    const b = ac.boat; let zMax = -Infinity, xMax = 0; for (const c of b.cols) { zMax = Math.max(zMax, c.b.z); xMax = Math.max(xMax, Math.abs(c.b.x)); }
    this.stern = new THREE.Vector3(0, Infinity, zMax); for (const c of b.cols) if (c.n && c.b.z > zMax - b.L * 0.12) this.stern.y = Math.min(this.stern.y, c.b.y);
    this.half = Math.max(0.3, xMax);
  }
  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); }

  update(dt, effects) {
    const ac = this.ac, b = ac.boat; this.t += dt;
    if (!b || ac.dead) { this.geo.setDrawRange(0, 0); return; }
    const u = b.speed, spd = Math.abs(u), q = ac.q;
    _xb.set(1, 0, 0).applyQuaternion(q); _zb.set(0, 0, -1).applyQuaternion(q);
    const stern = ac.worldPoint(this.stern, _p), sCol = this.sternColumn(), wl = sCol?.wl;
    const sternWet = wl != null && stern.y < wl + 0.25;
    // ---- wake: a point every ~0.08 s while moving through the water ----
    this.dropT -= dt;
    if (sternWet && spd > 1.2 && this.dropT <= 0) {
      this.dropT = 0.08;
      this.pts.unshift({ x: stern.x, z: stern.z, y: wl + 0.05, sx: _xb.x, sz: _xb.z, age: 0, k: clamp((spd - 1.2) / 10, 0.15, 1), w0: this.half * 0.7, spread: 0.2 + spd * 0.04 });
      if (this.pts.length > N) this.pts.length = N;
    }
    for (const p of this.pts) p.age += dt;
    while (this.pts.length && this.pts.at(-1).age > 14) this.pts.pop();
    this.buildWake();
    if (!sternWet && b.wet < 0.01) return;
    // ---- spray ----
    const pool = effects.smoke, V = ac.v;
    if (spd > 3 && b.wet > 0.02) for (const side of [1, -1]) { // bow: a sheet thrown out sideways where the bow wave climbs the hull
      const c = this.bowColumn(side); if (!c) continue;
      const p = ac.worldPoint(c.b, _p), n = Math.min(3, spd * 0.12) * (0.6 + Math.random() * 0.8);
      for (let i = 0; i < n; i++) {
        const out = spd * (0.12 + Math.random() * 0.12), up = 1 + spd * (0.08 + Math.random() * 0.08);
        pool.add(p.x + _xb.x * side * 0.2, c.wl + 0.15, p.z + _xb.z * side * 0.2, V.x * 0.55 + _xb.x * side * out, up, V.z * 0.55 + _xb.z * side * out,
          0.7 + Math.random() * 0.5, 0.25, 1.4 + spd * 0.05, 0.95, 0.97, 1, 0.55, 0.6, 9.8);
      }
    }
    // the motor's rooster tail, up on the plane
    for (const mo of b.motors) {
      if (!mo.part.alive || mo.bite < 0.5 || spd < 7 || !mo.e.spoolT) continue;
      const p = ac.worldPoint(mo.thrustAt, _p), k = clamp((spd - 7) / 12, 0, 1) * mo.e.spoolT;
      for (let i = 0; i < 2 * k + Math.random(); i++) pool.add(p.x, (wl ?? p.y) + 0.1, p.z, V.x * 0.35 - _zb.x * spd * 0.12 + (Math.random() - 0.5), 2 + spd * (0.15 + Math.random() * 0.12), V.z * 0.35 - _zb.z * spd * 0.12 + (Math.random() - 0.5),
        0.9 + Math.random() * 0.6, 0.4, 2.2 + spd * 0.06, 0.96, 0.98, 1, 0.5 * k + 0.15, 0.5, 9.8);
    }
    // a hard turn: a fan of spray off the outside of the stern
    const turn = ac.wW.y * u; // (+: turning left)
    if (Math.abs(turn) > 3 && spd > 5) {
      const side = turn > 0 ? 1 : -1, p = stern.clone().addScaledVector(_xb, side * this.half), k = clamp((Math.abs(turn) - 3) / 8, 0, 1);
      for (let i = 0; i < 3 * k + Math.random(); i++) pool.add(p.x, (wl ?? p.y) + 0.1, p.z, V.x * 0.4 + _xb.x * side * spd * 0.3, 1.5 + spd * 0.2 * Math.random(), V.z * 0.4 + _xb.z * side * spd * 0.3,
        0.9 + Math.random() * 0.5, 0.4, 2.5, 0.96, 0.98, 1, 0.55, 0.5, 9.8);
    }
    // slamming down off a wave
    if (ac.v.y < -2.5 && b.wet > 0.05 && this.t - (this.slamT ?? -9) > 0.4) { this.slamT = this.t; effects.splash(new THREE.Vector3(ac.x.x, (wl ?? ac.x.y) + 0.1, ac.x.z), Math.min(14, -ac.v.y * 3)); }
  }
  // a fire monitor's jet (main.js, while the smoke button is on)
  cannon(p, effects) {
    const ac = this.ac, C = p.d.cannon; if (!C) return;
    const tip = ac.worldPoint(_v.set(...C.tip).applyMatrix4(p.m), new THREE.Vector3()), dir = new THREE.Vector3(...C.dir).transformDirection(p.m).applyQuaternion(ac.q);
    for (let i = 0; i < 4; i++) {
      const s = 22 + Math.random() * 3, j = 0.04;
      effects.smoke.add(tip.x, tip.y, tip.z, ac.v.x + (dir.x + (Math.random() - 0.5) * j) * s, ac.v.y + (dir.y + (Math.random() - 0.5) * j) * s, ac.v.z + (dir.z + (Math.random() - 0.5) * j) * s,
        2.4 + Math.random() * 0.6, 0.25, 2.4, 0.9, 0.95, 1, 0.65, 0.12, 9.8);
    }
  }
  bowColumn(side) { // the most forward wet bottom column on one side
    let best = null; for (const c of this.ac.boat.cols) if (c.n && c.wet > 0.2 && c.b.x * side > 0 && (!best || c.b.z < best.b.z)) best = c; return best;
  }
  sternColumn() { let best = null; for (const c of this.ac.boat.cols) if (c.wl != null && (!best || c.b.z > best.b.z)) best = c; return best; }
  // three strips over the points: the foam trail (white, widening and fading) and the two arms of the V
  buildWake() {
    const P = this.pts, n = P.length, pos = this.pos, col = this.col;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    for (let i = 0; i < n; i++) {
      const p = P[i], fade = clamp(1 - p.age / 14, 0, 1), young = clamp(p.age / 0.25, 0, 1), k = p.k * young;
      const w = p.w0 + p.age * 0.45, arm = p.w0 + p.age * p.spread * 3.2, aw = 0.35 + p.age * 0.12;
      const strips = [[-w, w, 0.42 * fade * fade * k], [arm - aw, arm + aw, 0.24 * fade * fade * k], [-arm - aw, -arm + aw, 0.24 * fade * fade * k]];
      strips.forEach(([a, c, alpha], s) => {
        const o = (i * 6 + s * 2) * 3, oc = (i * 6 + s * 2) * 4;
        pos[o] = p.x + p.sx * a; pos[o + 1] = p.y; pos[o + 2] = p.z + p.sz * a;
        pos[o + 3] = p.x + p.sx * c; pos[o + 4] = p.y; pos[o + 5] = p.z + p.sz * c;
        for (const e of [0, 4]) { col[oc + e] = 0.93; col[oc + e + 1] = 0.96; col[oc + e + 2] = 0.98; col[oc + e + 3] = alpha; }
      });
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 18);
  }
}
