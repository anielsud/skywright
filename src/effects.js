// Particle effects: smoke, fire, sparks, dust, spray, feathers.
import * as THREE from 'three';
import { Billboards } from './billboard.js';
import { puffTexture, glowTexture } from './materials.js';

class Pool {
  constructor(cap, tex, additive, scene) {
    this.bb = new Billboards(cap, tex, { additive, nearFade: additive ? 0 : 0.6 });
    scene.add(this.bb.mesh);
    this.cap = cap; this.n = 0;
    this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap); this.rot = new Float32Array(cap); this.vr = new Float32Array(cap);
    this.c = new Float32Array(cap * 3); this.a = new Float32Array(cap); this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
  }
  add(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 0.5, grav = 0) {
    let i = this.n;
    if (i >= this.cap) { i = Math.floor(Math.random() * this.cap); } else this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = 0; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.rot[i] = Math.random() * 6.28; this.vr[i] = (Math.random() - 0.5) * 1.2;
    this.c[i * 3] = r; this.c[i * 3 + 1] = g; this.c[i * 3 + 2] = b; this.a[i] = a; this.drag[i] = drag; this.grav[i] = grav;
  }
  update(dt, wind) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) continue;
      // compact
      if (w !== i) {
        for (let k = 0; k < 3; k++) { this.p[w * 3 + k] = this.p[i * 3 + k]; this.v[w * 3 + k] = this.v[i * 3 + k]; this.c[w * 3 + k] = this.c[i * 3 + k]; }
        this.life[w] = this.life[i]; this.max[w] = this.max[i]; this.s0[w] = this.s0[i]; this.s1[w] = this.s1[i]; this.rot[w] = this.rot[i]; this.vr[w] = this.vr[i]; this.a[w] = this.a[i]; this.drag[w] = this.drag[i]; this.grav[w] = this.grav[i];
      }
      const d = Math.max(0, 1 - this.drag[w] * dt);
      this.v[w * 3] = (this.v[w * 3] - wind.x) * d + wind.x; this.v[w * 3 + 1] = this.v[w * 3 + 1] * d - this.grav[w] * dt; this.v[w * 3 + 2] = (this.v[w * 3 + 2] - wind.z) * d + wind.z;
      this.p[w * 3] += this.v[w * 3] * dt; this.p[w * 3 + 1] += this.v[w * 3 + 1] * dt; this.p[w * 3 + 2] += this.v[w * 3 + 2] * dt;
      this.rot[w] += this.vr[w] * dt;
      const t = this.life[w] / this.max[w];
      const size = this.s0[w] + (this.s1[w] - this.s0[w]) * Math.sqrt(t);
      const alpha = this.a[w] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      this.bb.set(w, this.p[w * 3], this.p[w * 3 + 1], this.p[w * 3 + 2], size, this.rot[w], this.c[w * 3], this.c[w * 3 + 1], this.c[w * 3 + 2], alpha);
      w++;
    }
    this.n = w; this.bb.commit(w);
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.smoke = new Pool(3000, puffTexture(), false, scene);
    this.fire = new Pool(1500, glowTexture(), true, scene);
    // One flash light for explosions, reused: the number of lights in the scene is part of every lit shader, so a new
    // light would recompile them all on impact. It's in the scene only while it glows (main.js compiles the shaders
    // with it present too, before the flight starts).
    // Always in the scene (at intensity 0 when idle): adding/removing a light changes the light count, and three.js
    // then recompiles every lit shader mid-crash (#99). Only its intensity ever changes.
    this.boom = new THREE.PointLight(0xffa040, 0, 300, 1.5); this.boom.userData = { t: 0, d: 1.2, i: 0, on: false }; scene.add(this.boom);
  }
  setLighting(world, camera) {
    for (const pool of [this.smoke, this.fire]) pool.bb.updateCamera(camera, world.scene.fog);
    this.smoke.bb.uniforms.litColor.value.copy(world.clouds.uniforms.litColor.value);
    this.smoke.bb.uniforms.shadeColor.value.copy(world.clouds.uniforms.shadeColor.value);
  }
  update(dt, wind) {
    this.smoke.update(dt, wind); this.fire.update(dt, wind);
    const l = this.boom, u = l.userData;
    if (u.on) { u.t += dt; l.intensity = u.i * Math.max(0, 1 - u.t / u.d); if (u.t > u.d) { u.on = false; l.intensity = 0; } }
  }
  rnd(s) { return (Math.random() - 0.5) * s; }
  puff(p, v, opt = {}) {
    const c = opt.color || [0.85, 0.85, 0.85];
    this.smoke.add(p.x, p.y, p.z, v.x, v.y, v.z, opt.life || 3, opt.s0 || 1, opt.s1 || 6, c[0], c[1], c[2], opt.a ?? 0.6, opt.drag ?? 0.6, opt.grav ?? -0.3);
  }
  trail(p, color, size = 1) { // airshow smoke
    this.smoke.add(p.x + this.rnd(0.3), p.y + this.rnd(0.3), p.z + this.rnd(0.3), this.rnd(1), this.rnd(1), this.rnd(1), 9, 1.2 * size, 9 * size, color.r, color.g, color.b, 0.75, 0.3, -0.05);
  }
  engineSmoke(p, v, dark = 0.2) {
    this.smoke.add(p.x, p.y, p.z, v.x * 0.3 + this.rnd(1), v.y * 0.3 + 1, v.z * 0.3 + this.rnd(1), 4, 0.8, 7, dark, dark, dark, 0.55, 0.8, -0.8);
  }
  flame(p, v, size = 1) {
    this.fire.add(p.x + this.rnd(size), p.y + this.rnd(size), p.z + this.rnd(size), v.x + this.rnd(2), v.y + 2 + Math.random() * 3, v.z + this.rnd(2), 0.5 + Math.random() * 0.5, size * 1.5, size * 0.4, 1, 0.45 + Math.random() * 0.2, 0.12, 0.9, 1.5, -2);
  }
  burn(p, intensity = 1) {
    if (Math.random() < intensity * 0.9) this.flame(p, { x: 0, y: 0, z: 0 }, 1.2 * intensity);
    if (Math.random() < intensity * 0.6) this.smoke.add(p.x + this.rnd(2), p.y + 2, p.z + this.rnd(2), this.rnd(1), 4 + Math.random() * 3, this.rnd(1), 8, 2, 16, 0.08, 0.08, 0.08, 0.7, 0.3, -0.4);
  }
  sparks(p, v, n = 10) {
    for (let i = 0; i < n; i++) this.fire.add(p.x, p.y, p.z, v.x * 0.6 + this.rnd(14), Math.random() * 6, v.z * 0.6 + this.rnd(14), 0.3 + Math.random() * 0.6, 0.25, 0.05, 1, 0.75, 0.35, 1, 0.5, 9.8);
  }
  dust(p, v, type, n = 3) {
    const c = type === 'sand' ? [0.78, 0.6, 0.42] : type === 'snow' ? [0.95, 0.96, 1] : type === 'rock' ? [0.55, 0.52, 0.5] : [0.55, 0.5, 0.38];
    for (let i = 0; i < n; i++) this.smoke.add(p.x + this.rnd(1), p.y + 0.3, p.z + this.rnd(1), v.x * 0.2 + this.rnd(3), 1 + Math.random() * 2, v.z * 0.2 + this.rnd(3), 2.5, 1, 6, c[0], c[1], c[2], 0.5, 1.2, -0.2);
  }
  spray(p, speed) {
    const n = Math.min(12, 2 + speed * 0.2);
    for (let i = 0; i < n; i++) this.smoke.add(p.x, p.y + 0.2, p.z, this.rnd(speed * 0.4), 2 + Math.random() * speed * 0.25, this.rnd(speed * 0.4), 1.5, 0.6, 4, 0.95, 0.97, 1, 0.7, 0.8, 7);
  }
  splash(p, power) {
    for (let i = 0; i < 30 + power; i++) this.smoke.add(p.x + this.rnd(4), p.y, p.z + this.rnd(4), this.rnd(power * 0.6), 4 + Math.random() * power * 0.7, this.rnd(power * 0.6), 2.5, 1, 6, 0.95, 0.97, 1, 0.8, 0.5, 9.8);
  }
  tireSmoke(p, speed) {
    for (let i = 0; i < 6; i++) this.smoke.add(p.x, p.y + 0.2, p.z, this.rnd(2), 0.5 + Math.random(), this.rnd(2) + 0, 2, 0.5, 4, 0.82, 0.82, 0.82, 0.55, 1.5, -0.1);
  }
  feathers(p) {
    for (let i = 0; i < 25; i++) this.smoke.add(p.x, p.y, p.z, this.rnd(10), this.rnd(10), this.rnd(10), 3, 0.25, 0.3, 1, 1, 1, 0.9, 2.5, 0.8);
  }
  leaves(p) {
    for (let i = 0; i < 30; i++) this.smoke.add(p.x, p.y, p.z, this.rnd(10), Math.random() * 6, this.rnd(10), 3, 0.3, 0.4, 0.25, 0.45, 0.15, 0.95, 2, 2);
  }
  explosion(p, power = 1) {
    for (let i = 0; i < 60 * power; i++) {
      const d = new THREE.Vector3(this.rnd(2), Math.random(), this.rnd(2)).normalize().multiplyScalar(4 + Math.random() * 14 * power);
      this.fire.add(p.x, p.y + 1, p.z, d.x, d.y, d.z, 0.6 + Math.random() * 0.9, 3 * power, 7 * power, 1, 0.55 + Math.random() * 0.3, 0.15, 1, 2.2, -1);
    }
    for (let i = 0; i < 40 * power; i++) this.smoke.add(p.x + this.rnd(6), p.y + 2 + Math.random() * 4, p.z + this.rnd(6), this.rnd(8), 3 + Math.random() * 8, this.rnd(8), 6 + Math.random() * 6, 4, 22 * power, 0.12, 0.11, 0.1, 0.75, 0.8, -0.6);
    this.sparks(p, { x: 0, z: 0 }, 40);
    const l = this.boom, u = l.userData, live = u.on ? Math.max(0, 1 - u.t / u.d) : 0; // (a second blast re-fires it)
    l.position.copy(p).y += 3; u.i = Math.max(2000 * power, u.i * live); u.t = 0; l.intensity = 0; u.on = true;
  }
  dispose() { this.scene.remove(this.smoke.bb.mesh, this.fire.bb.mesh); this.scene.remove(this.boom); }
}
