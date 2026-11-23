// Living world: cars on the road, bird flocks, hot-air balloons, boats and a pattern-flying light aircraft.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { partMatrix } from './design.js';
import { mulberry32, clamp } from './noise.js';
import { M, glowTexture } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { Vehicles } from './vehicles.js';
import { assemble, kitify } from './planeDetail.js';
import { NavLights, lightLayout, heliLamps } from './navLights.js';

// Merge a static object tree into one mesh per material (huge draw-call saving for parked planes etc.).
export function mergeByMaterial(root, skip = () => false) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4();
  const buckets = new Map(), skipped = new Set();
  root.traverse((o) => {
    if (skip(o)) { o.traverse((c) => skipped.add(c)); return; }
    if (skipped.has(o) || !o.isMesh || !o.visible || o.isInstancedMesh) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1', 'livPos'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(m);
    if (m.determinant() < 0) { // mirrored: restore outward winding
      for (const k of ['position', 'normal', 'uv', 'uv1']) { const a = g.attributes[k]; if (!a) continue; const n = a.itemSize; for (let t = 0; t < a.count; t += 3) for (let c = 0; c < n; c++) { const x = a.array[(t + 1) * n + c]; a.array[(t + 1) * n + c] = a.array[(t + 2) * n + c]; a.array[(t + 2) * n + c] = x; } }
    }
    g.clearGroups();
    const key = o.material.uuid; if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [], shadow: o.castShadow });
    buckets.get(key).geos.push(g);
  });
  const out = new THREE.Group();
  out.position.copy(root.position); out.quaternion.copy(root.quaternion); out.scale.copy(root.scale);
  for (const { mat, geos, shadow } of buckets.values()) {
    if (!geos.every((g) => g.attributes.uv1)) for (const g of geos) g.deleteAttribute('uv1'); // panel-skin uv1 only if every piece has it
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat); mesh.castShadow = shadow && !mat.transparent; mesh.receiveShadow = true; out.add(mesh);
  }
  return out;
}

export function buildStatic(design) {
  const g = new THREE.Group(); const m = new THREE.Matrix4(), objs = [];
  design.parts.forEach((p, i) => {
    const d = PARTS[p.id]; if (!d) return;
    const o = d.build(p.color, { detail: 1 }); partMatrix(p, m); m.decompose(o.position, o.quaternion, o.scale);
    g.add(o); objs[i] = o;
  });
  assemble(design, objs, g, { near: false, quick: true }); // fillets, pylons, wells and doors, a coarse skin blend (merged later, so no extra draw calls)
  kitify(g); // all small fittings share one material, so they merge into one mesh
  for (const o of objs) if (o) o.traverse((c) => { if (c.isMesh) { c.castShadow = !c.material.transparent; c.receiveShadow = true; } if (c.userData.isDisc || c.userData.planeLight) c.visible = false; }); // parked: lights off
  // rest on the ground: lowest point at y=0
  const box = new THREE.Box3().setFromObject(g);
  g.children.forEach((c) => (c.position.y -= box.min.y));
  g.userData.props = []; g.traverse((c) => { if (c.userData.prop) g.userData.props.push(c.userData.prop); });
  return g;
}
// buildStatic merged into one mesh per material (the airport's parked planes). Each design is built once per session
// and later flights get a clone sharing its geometry and materials (World.dispose may dispose that geometry: three.js
// uploads it again when it is next drawn). Keyed by the whole design, so an edited copy of a stock design gets its own.
const _parked = new Map();
export function parkedStatic(design) {
  const k = JSON.stringify(design);
  let t = _parked.get(k);
  if (!t) { if (_parked.size >= 16) _parked.delete(_parked.keys().next().value); _parked.set(k, (t = mergeByMaterial(buildStatic(design)))); }
  return t.clone();
}

function colored(geo, c) { const g = geo.index ? geo.toNonIndexed() : geo; const n = g.attributes.position.count, a = new Float32Array(n * 3), cc = new THREE.Color(c); for (let i = 0; i < n; i++) { a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }

export class Traffic {
  constructor(scene, world, presets) {
    this.scene = scene; this.world = world; this.group = new THREE.Group(); scene.add(this.group);
    this.r = mulberry32(world.loc.seed + 5);
    this.vehicles = new Vehicles(scene, world); this.buildBirds(); this.buildHeli();
    if (world.loc.balloons) this.buildBalloons();
    if (world.loc.boats) this.buildBoats();
    this.buildPatternPlane(presets);
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
      let b = new THREE.Group();
      const em = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide })); em.position.y = 16; b.add(em);
      const basket = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 1.4), new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 1 })); b.add(basket);
      const burner = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), M.light(0xffa040).clone()); burner.position.y = 3; b.add(burner);
      for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 4.5), M.black()); r.position.set(x * 1.5, 2.6, z * 1.5); b.add(r); }
      b.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const bm = mergeByMaterial(b, (o) => o === burner); bm.add(burner); b = bm;
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
      do { x = (this.r() - 0.5) * 12000; z = (this.r() - 0.5) * 12000; tries++; } while ((this.world.heightAt(x, z) > -8 || this.world.waterParks?.inside(x, z, 700)) && tries < 200); // (their circles keep clear of the water park)
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
    const props = []; obj.traverse((c) => { if (c.userData.prop) props.push(c.userData.prop); });
    const merged = mergeByMaterial(obj, (o) => props.includes(o));
    obj.updateMatrixWorld(true);
    for (const pr of props) { const mw = pr.matrixWorld.clone(); merged.add(pr); mw.decompose(pr.position, pr.quaternion, pr.scale); }
    merged.userData.props = props;
    const h = this.world.loc.rwyH + 320;
    const pts = [[-700, -1400], [-700, 1400], [-450, 1900], [0, 2050], [450, 1900], [700, 1400], [700, -1400], [450, -1900], [0, -2050], [-450, -1900]].map(([x, z]) => new THREE.Vector3(x - 600, h, z));
    this.pattern = { obj: merged, curve: new THREE.CatmullRomCurve3(pts, true), t: 0, speed: 52 };
    this.pattern.len = this.pattern.curve.getLength();
    this.pattern.nav = new NavLights(merged, lightLayout(obj, design.parts.map((p, i) => ({ obj: obj.children[i], d: PARTS[p.id], i })), 'plane'), { phase: 0.5 }); // running lights, landing lights on in the circuit
    this.group.add(merged);
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
    P.nav.update(dt, { land: 1 });
  }
  // ---------- helicopter shuttling between town and airport ----------
  buildHeli() {
    const W = this.world, t = W.net.towns[0]; if (!t) return;
    const g = new THREE.Group(), paint = M.paint(0xc8102e), dark = M.darkMetal();
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), paint); body.scale.set(1, 1, 1.6); g.add(body);
    const glass = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2), M.glass()); glass.rotation.x = -Math.PI / 2.4; glass.position.set(0, 0.2, -1.2); g.add(glass);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.35, 6, 8), paint); boom.rotation.x = Math.PI / 2; boom.position.set(0, 0.3, 4.4); g.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.9), paint); fin.position.set(0, 1, 7.2); g.add(fin);
    for (const s2 of [-0.9, 0.9]) { const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 6), dark); skid.rotation.x = Math.PI / 2; skid.position.set(s2, -1.6, 0); g.add(skid); }
    const rotor = new THREE.Group(); for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 11), dark); b.rotation.y = k * Math.PI / 2; rotor.add(b); } rotor.position.y = 1.7; g.add(rotor);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.5, 32), M.propDisc()); disc.rotation.x = -Math.PI / 2; disc.position.y = 1.72; g.add(disc);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2, 0.2), dark); tail.position.set(0.3, 1, 7.3); g.add(tail);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group.add(g);
    const a = new THREE.Vector3(250, W.loc.rwyH, -60), b = t.c.clone().setY(W.sampleGrid(t.c.x, t.c.z));
    this.heli = { g, rotor, tail, a, b, t: 0, phase: 0, nav: new NavLights(g, heliLamps({ side: 1.45, top: [0, 1.25, 1.2], belly: [0, -1.45, 0.2], tail: [0, 1.05, 7.7], nose: [0, -1.1, -1.9] }), { phase: 0.9 }) };
  }
  updateHeli(dt) {
    const H = this.heli; if (!H) return;
    H.t += dt; const cycle = 120, u = (H.t % cycle) / cycle; // hover-climb-cruise-descend-sit, both ways
    const leg = u < 0.5 ? u * 2 : (u - 0.5) * 2, from = u < 0.5 ? H.a : H.b, to = u < 0.5 ? H.b : H.a;
    const k = Math.min(1, Math.max(0, (leg - 0.15) / 0.7)), e = k * k * (3 - 2 * k);
    const p = from.clone().lerp(to, e); const lift = Math.sin(Math.min(1, Math.max(0, (leg - 0.05) / 0.9)) * Math.PI);
    p.y = Math.max(this.world.sampleGrid(p.x, p.z), from.y + (to.y - from.y) * e) + 2 + lift * 160;
    const dir = to.clone().sub(from).setY(0).normalize();
    H.g.position.copy(p); H.g.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0); H.g.rotateX(-0.15 * Math.sin(k * Math.PI));
    H.rotor.rotation.y += dt * (leg > 0.03 && leg < 0.97 ? 30 : 6); H.tail.rotation.x += dt * 50;
    H.nav.update(dt, { land: p.y - this.world.sampleGrid(p.x, p.z) < 250 ? 1 : 0 }); // searchlight on near the ground
  }
  update(dt, fx, cam) {
    this.vehicles.update(dt, cam); this.updateBirds(dt); this.updateHeli(dt);
    if (cam) { this.world.flora.update(cam); this.world.towns.update(dt, this.world.t, fx, cam); }
    if (this.balloons) this.updateBalloons(dt);
    if (this.boats) this.updateBoats(dt, fx);
    this.updatePattern(dt);
  }
  dispose() { this.scene.remove(this.group); this.vehicles.dispose(); }
}
