// Living world: cars on the road, bird flocks, hot-air balloons, boats and a pattern-flying light aircraft.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { partMatrix } from './design.js';
import { mulberry32, clamp } from './noise.js';
import { M, glowTexture } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';

export function buildStatic(design) {
  const g = new THREE.Group(); const m = new THREE.Matrix4();
  for (const p of design.parts) {
    const d = PARTS[p.id]; if (!d) continue;
    const o = d.build(p.color); partMatrix(p, m); m.decompose(o.position, o.quaternion, o.scale);
    o.traverse((c) => { if (c.isMesh) { c.castShadow = !c.material.transparent; c.receiveShadow = true; } if (c.userData.isDisc) c.visible = false; });
    g.add(o);
  }
  // rest on the ground: lowest point at y=0
  const box = new THREE.Box3().setFromObject(g);
  g.children.forEach((c) => (c.position.y -= box.min.y));
  g.userData.props = []; g.traverse((c) => { if (c.userData.prop) g.userData.props.push(c.userData.prop); });
  return g;
}

function colored(geo, c) { const g = geo.index ? geo.toNonIndexed() : geo; const n = g.attributes.position.count, a = new Float32Array(n * 3), cc = new THREE.Color(c); for (let i = 0; i < n; i++) { a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }

export class Traffic {
  constructor(scene, world, presets) {
    this.scene = scene; this.world = world; this.group = new THREE.Group(); scene.add(this.group);
    this.r = mulberry32(world.loc.seed + 5);
    this.buildCars(); this.buildBirds();
    if (world.loc.balloons) this.buildBalloons();
    if (world.loc.boats) this.buildBoats();
    this.buildPatternPlane(presets);
  }
  // ---------- cars ----------
  buildCars() {
    const parts = [
      colored(new THREE.BoxGeometry(1.9, 0.7, 4.4).translate(0, 0.65, 0), 0xffffff),
      colored(new THREE.BoxGeometry(1.7, 0.6, 2.3).translate(0, 1.25, 0.2), 0x20262e),
    ];
    for (const [x, z] of [[-0.9, -1.4], [0.9, -1.4], [-0.9, 1.4], [0.9, 1.4]]) parts.push(colored(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 10).rotateZ(Math.PI / 2).translate(x, 0.34, z), 0x111111));
    const geo = mergeGeometries(parts); geo.computeVertexNormals();
    const truck = mergeGeometries([colored(new THREE.BoxGeometry(2.4, 2.6, 7).translate(0, 2.0, 1.2), 0xffffff), colored(new THREE.BoxGeometry(2.3, 2.0, 2.0).translate(0, 1.5, -3.4), 0x2b2f36),
      ...[[-1.1, -3.2], [1.1, -3.2], [-1.1, 3], [1.1, 3]].map(([x, z]) => colored(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 10).rotateZ(Math.PI / 2).translate(x, 0.5, z), 0x111111))]);
    truck.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5 });
    const n = 46;
    this.carMesh = new THREE.InstancedMesh(geo, mat, n); this.truckMesh = new THREE.InstancedMesh(truck, mat, 8);
    this.carMesh.castShadow = this.truckMesh.castShadow = true;
    const cols = [0xc8102e, 0xf2f2ee, 0x1d4e89, 0x222222, 0x8a9099, 0xf2b705, 0x2e6b3f, 0x6fb7e9];
    this.cars = [];
    const L = this.world.road.samples.length;
    for (let i = 0; i < n + 8; i++) {
      const truckK = i >= n;
      const c = { s: this.r() * L, speed: (truckK ? 14 : 16 + this.r() * 12) / 13 * (this.r() < 0.5 ? 1 : -1), truck: truckK, idx: truckK ? i - n : i };
      this.cars.push(c);
      (truckK ? this.truckMesh : this.carMesh).setColorAt(c.idx, new THREE.Color(cols[i % cols.length]));
    }
    this.group.add(this.carMesh, this.truckMesh);
    // head/tail lights
    const lp = new Float32Array(this.cars.length * 4 * 3), lc = new Float32Array(this.cars.length * 4 * 3);
    for (let i = 0; i < this.cars.length; i++) for (let k = 0; k < 4; k++) { const c = k < 2 ? [1, 0.95, 0.8] : [1, 0.1, 0.05]; lc.set(c, (i * 4 + k) * 3); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    this.carLights = new THREE.Points(lg, new THREE.PointsMaterial({ size: 1.6, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.carLights.frustumCulled = false; this.group.add(this.carLights);
  }
  updateCars(dt) {
    const S = this.world.road.samples, L = S.length;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), d = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const lp = this.carLights.geometry.attributes.position.array;
    this.carLights.visible = this.world.night || this.world.W.dark > 0.5;
    this.cars.forEach((c, ci) => {
      c.s = (c.s + c.speed * dt + L) % L;
      const i0 = Math.floor(c.s), t = c.s - i0, a = S[i0 % L], b = S[(i0 + 1) % L];
      p.lerpVectors(a, b, t);
      d.subVectors(b, a).normalize(); if (c.speed < 0) d.negate();
      const right = new THREE.Vector3(-d.z, 0, d.x);
      p.addScaledVector(right, 2.2);
      q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(d.x, 0, d.z).normalize());
      const pitch = Math.asin(clamp(d.y, -1, 1)); q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
      m.compose(p, q, one);
      (c.truck ? this.truckMesh : this.carMesh).setMatrixAt(c.idx, m);
      const fw = d.clone(), len = c.truck ? 4.4 : 2.2;
      for (let k = 0; k < 4; k++) {
        const side = k % 2 ? 0.7 : -0.7, f = k < 2 ? len : -len;
        lp[(ci * 4 + k) * 3] = p.x + fw.x * f + right.x * side; lp[(ci * 4 + k) * 3 + 1] = p.y + 0.8; lp[(ci * 4 + k) * 3 + 2] = p.z + fw.z * f + right.z * side;
      }
    });
    this.carMesh.instanceMatrix.needsUpdate = true; this.truckMesh.instanceMatrix.needsUpdate = true;
    this.carLights.geometry.attributes.position.needsUpdate = true;
  }
  // ---------- birds ----------
  buildBirds() {
    const g = new THREE.BufferGeometry();
    const v = [0, 0, -0.25, 0, 0, 0.3, -1.1, 1, 0.1, 0, 0, -0.25, 1.1, 1, 0.1, 0, 0, 0.3, 0, 0, -0.35, 0, 0.05, 0.35, 0, -0.1, 0.4];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const n = 140;
    this.birdMesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide, roughness: 1 }), n);
    this.birdMesh.frustumCulled = false;
    this.flocks = [];
    const W = this.world;
    for (let f = 0; f < 7; f++) {
      const cx = (this.r() - 0.5) * 7000, cz = (this.r() - 0.5) * 7000;
      const gh = Math.max(W.heightAt(cx, cz), W.waterLevel);
      const flock = { c: new THREE.Vector3(cx, gh + 60 + this.r() * 220, cz), birds: [], heading: this.r() * 6.28, t: this.r() * 100, seagull: W.loc.id === 'islands' };
      for (let b = 0; b < 20; b++) flock.birds.push({ p: flock.c.clone().add(new THREE.Vector3((this.r() - 0.5) * 30, (this.r() - 0.5) * 10, (this.r() - 0.5) * 30)), v: new THREE.Vector3(), phase: this.r() * 6.28, alive: true });
      this.flocks.push(flock);
    }
    this.group.add(this.birdMesh);
  }
  updateBirds(dt) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let k = 0;
    for (const f of this.flocks) {
      f.t += dt; f.heading += Math.sin(f.t * 0.13) * dt * 0.25;
      const target = f.c.clone().add(new THREE.Vector3(Math.cos(f.heading), Math.sin(f.t * 0.3) * 0.2, Math.sin(f.heading)).multiplyScalar(14 * dt));
      f.c.copy(target);
      if (f.c.length() > 9000) f.heading += Math.PI;
      for (const b of f.birds) {
        if (!b.alive) continue;
        const toC = f.c.clone().sub(b.p);
        b.v.addScaledVector(toC, dt * 0.6).add(new THREE.Vector3(Math.cos(f.heading), 0, Math.sin(f.heading)).multiplyScalar(dt * 6));
        b.v.multiplyScalar(1 - dt * 0.6);
        if (b.v.length() > 16) b.v.setLength(16);
        b.p.addScaledVector(b.v, dt);
        b.phase += dt * (b.v.y > 0 ? 14 : 8);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), b.v.clone().normalize());
        const flap = Math.sin(b.phase);
        s.set(f.seagull ? 1.3 : 0.7, flap * (f.seagull ? 1.0 : 0.6), f.seagull ? 1.2 : 0.7);
        m.compose(b.p, q, s); this.birdMesh.setMatrixAt(k++, m);
      }
    }
    this.birdMesh.count = k; this.birdMesh.instanceMatrix.needsUpdate = true;
    this.birdMesh.material.color.setHex(this.flocks[0]?.seagull ? 0xe8e8e8 : 0x2a2a2a);
  }
  birdStrikes(pos, radius) {
    const hits = [];
    for (const f of this.flocks) {
      if (f.c.distanceToSquared(pos) > (radius + 60) ** 2) continue;
      for (const b of f.birds) if (b.alive && b.p.distanceToSquared(pos) < radius * radius) { b.alive = false; hits.push(b.p.clone()); }
    }
    return hits;
  }
  // ---------- balloons ----------
  buildBalloons() {
    this.balloons = [];
    const prof = []; for (let i = 0; i <= 16; i++) { const t = i / 16; const a = t * Math.PI; prof.push(new THREE.Vector2(Math.sin(a) * (t < 0.8 ? 9 : 9 * (1 - (t - 0.8) * 3.5)) + 0.6, -Math.cos(a) * 11)); }
    prof[0].x = 1.5; prof.reverse();
    const env = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(Math.max(0.01, p.x), p.y)), 24);
    const palettes = [[0xc8102e, 0xf2b705], [0x1d4e89, 0xf2f2ee], [0x2e6b3f, 0xe8601c], [0x7b2d8b, 0x6fb7e9], [0xf2b705, 0x1b2a41]];
    for (let i = 0; i < 6; i++) {
      const pal = palettes[i % palettes.length];
      const g = env.clone(); const pos = g.attributes.position; const col = new Float32Array(pos.count * 3); const c1 = new THREE.Color(pal[0]), c2 = new THREE.Color(pal[1]);
      for (let v = 0; v < pos.count; v++) { const ang = Math.atan2(pos.getZ(v), pos.getX(v)); const c = Math.floor((ang + Math.PI) / (Math.PI * 2) * 12) % 2 ? c1 : c2; col.set([c.r, c.g, c.b], v * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const b = new THREE.Group();
      const em = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide })); em.position.y = 16; b.add(em);
      const basket = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 1.4), new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 1 })); b.add(basket);
      const burner = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), M.light(0xffa040).clone()); burner.position.y = 3; b.add(burner);
      for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 4.5), M.black()); r.position.set(x * 1.5, 2.6, z * 1.5); b.add(r); }
      b.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const x = (this.r() - 0.5) * 6000, z = (this.r() - 0.5) * 6000;
      b.position.set(x, Math.max(this.world.heightAt(x, z), 0) + 250 + this.r() * 500, z);
      b.userData = { burner, t: this.r() * 10, base: b.position.y };
      this.group.add(b); this.balloons.push(b);
    }
  }
  updateBalloons(dt) {
    for (const b of this.balloons) {
      b.userData.t += dt;
      b.position.addScaledVector(this.world.windBase, dt * 0.6);
      b.position.y = b.userData.base + Math.sin(b.userData.t * 0.1) * 30;
      b.rotation.y += dt * 0.02;
      b.userData.burner.visible = Math.sin(b.userData.t * 0.8) > 0.6;
      if (b.position.length() > 9000) b.position.multiplyScalar(-0.9);
    }
  }
  // ---------- boats ----------
  buildBoats() {
    this.boats = [];
    const hull = new THREE.LatheGeometry([new THREE.Vector2(0.01, -5), new THREE.Vector2(1.6, -3), new THREE.Vector2(1.9, 0), new THREE.Vector2(1.7, 4), new THREE.Vector2(0.01, 5)], 12);
    hull.scale(1, 0.25, 1); hull.rotateX(Math.PI / 2); hull.scale(1, 1, 1);
    for (let i = 0; i < 8; i++) {
      let x, z, tries = 0;
      do { x = (this.r() - 0.5) * 12000; z = (this.r() - 0.5) * 12000; tries++; } while (this.world.heightAt(x, z) > -8 && tries < 200);
      const b = new THREE.Group();
      const h = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 10), M.paint(0xf2f2ee)); h.position.y = 0.4; b.add(h);
      const bow = new THREE.Mesh(new THREE.ConeGeometry(1.7, 3, 4), M.paint(0xf2f2ee)); bow.rotation.x = -Math.PI / 2; bow.rotation.y = Math.PI / 4; bow.position.set(0, 0.4, -6.4); bow.scale.set(1, 1, 0.45); b.add(bow);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 3.5), M.paint(i % 2 ? 0x1d4e89 : 0xc8102e)); cab.position.set(0, 1.8, 0.8); b.add(cab);
      if (i % 3 === 0) { const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 12), M.paint(0xdddddd)); mast.position.y = 7; b.add(mast); const sail = new THREE.Mesh(new THREE.PlaneGeometry(5, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide })); sail.position.set(0, 7, 1.5); sail.rotation.y = Math.PI / 2; b.add(sail); }
      b.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      b.position.set(x, this.world.waterLevel, z);
      b.userData = { c: new THREE.Vector3(x, 0, z), r: 150 + this.r() * 300, a: this.r() * 6.28, sp: (0.02 + this.r() * 0.03) * (this.r() < 0.5 ? 1 : -1) };
      this.group.add(b); this.boats.push(b);
    }
  }
  updateBoats(dt, fx) {
    for (const b of this.boats) {
      const u = b.userData; u.a += u.sp * dt;
      const nx = u.c.x + Math.cos(u.a) * u.r, nz = u.c.z + Math.sin(u.a) * u.r;
      if (this.world.heightAt(nx, nz) > -3) { u.sp *= -1; continue; }
      const d = new THREE.Vector3(nx - b.position.x, 0, nz - b.position.z);
      b.position.set(nx, this.world.waterLevel + Math.sin(performance.now() / 700 + u.a) * 0.15, nz);
      if (d.lengthSq() > 1e-6) b.rotation.y = Math.atan2(-d.x, -d.z);
      b.rotation.z = Math.sin(performance.now() / 900 + u.r) * 0.04;
      if (fx && Math.random() < 0.5) { const back = new THREE.Vector3(0, 0, 5).applyEuler(b.rotation).add(b.position); fx.smoke.add(back.x, this.world.waterLevel + 0.3, back.z, (Math.random() - 0.5), 0.2, (Math.random() - 0.5), 6, 1.5, 5, 0.95, 0.97, 1, 0.5, 0.3, 0); }
    }
  }
  // ---------- pattern plane ----------
  buildPatternPlane(presets) {
    const d = presets.find((p) => p.name === 'Kestrel'); if (!d) return;
    const design = JSON.parse(JSON.stringify(d)); design.parts.forEach((p, i) => { if (p.id === 'fus_light') p.color = 0x1d4e89; });
    const obj = new THREE.Group(); const m = new THREE.Matrix4();
    for (const p of design.parts) { const o = PARTS[p.id].build(p.color); partMatrix(p, m); m.decompose(o.position, o.quaternion, o.scale); o.traverse((c) => { if (c.isMesh) c.castShadow = true; }); obj.add(o); }
    obj.userData.props = []; obj.traverse((c) => { if (c.userData.prop) obj.userData.props.push(c.userData.prop); });
    const h = this.world.loc.rwyH + 320;
    const pts = [[-700, -1400], [-700, 1400], [-450, 1900], [0, 2050], [450, 1900], [700, 1400], [700, -1400], [450, -1900], [0, -2050], [-450, -1900]].map(([x, z]) => new THREE.Vector3(x - 600, h, z));
    this.pattern = { obj, curve: new THREE.CatmullRomCurve3(pts, true), t: 0, speed: 52 };
    this.pattern.len = this.pattern.curve.getLength();
    this.group.add(obj);
  }
  updatePattern(dt) {
    const P = this.pattern; if (!P) return;
    P.t = (P.t + (P.speed * dt) / P.len) % 1;
    const p = P.curve.getPointAt(P.t), ahead = P.curve.getPointAt((P.t + 0.004) % 1), ahead2 = P.curve.getPointAt((P.t + 0.012) % 1);
    const fwd = ahead.clone().sub(p).normalize();
    const turn = new THREE.Vector3().crossVectors(fwd, ahead2.clone().sub(ahead).normalize()).y;
    P.obj.position.copy(p);
    P.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
    P.obj.rotateZ(clamp(turn * 25, -0.6, 0.6));
    for (const pr of P.obj.userData.props) pr.userData.spinner.rotation.z += dt * 120;
  }
  update(dt, fx) {
    this.updateCars(dt); this.updateBirds(dt);
    if (this.balloons) this.updateBalloons(dt);
    if (this.boats) this.updateBoats(dt, fx);
    this.updatePattern(dt);
  }
  dispose() { this.scene.remove(this.group); }
}
