// Procedural vegetation: several variants per species, distance LOD, scattered rocks/bushes and a grass carpet near the camera.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32, smoothstep } from './noise.js';
import { swayMaterial } from './shaders.js';

function colorize(g, fn) {
  const geo = g.index ? g.toNonIndexed() : g; geo.deleteAttribute('uv');
  const p = geo.attributes.position, a = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) { fn(c, p.getX(i), p.getY(i), p.getZ(i)); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo;
}
const jitter = (g, r, amt) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (r() - 0.5) * amt, p.getY(i) + (r() - 0.5) * amt, p.getZ(i) + (r() - 0.5) * amt); return g; };
// a tapered limb from a to b
function limb(a, b, r0, r1, seg = 5) {
  const len = a.distanceTo(b), g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize());
  g.applyQuaternion(q); g.translate(a.x, a.y, a.z); return g;
}
const bark = (hex, v = 0.15) => (c, x, y, z) => c.set(hex).multiplyScalar(1 - v + Math.sin(y * 7 + x * 3) * v * 0.5);
const leafy = (base, r, top) => (c, x, y, z) => { c.set(base).multiplyScalar(0.55 + 0.6 * smoothstep(0, top, y) + (r() - 0.5) * 0.18); };

const SPECIES = {
  pine(r) {
    const H = 14 + r() * 10, parts = [];
    parts.push(colorize(limb(new THREE.Vector3(), new THREE.Vector3((r() - 0.5) * 0.4, H, (r() - 0.5) * 0.4), 0.35, 0.05, 6), bark(0x4a3423)));
    const tiers = 6 + Math.floor(r() * 4);
    for (let k = 0; k < tiers; k++) {
      const t = k / tiers, y = H * (0.22 + t * 0.72), rad = (1 - t) * (H * 0.24) + 0.5;
      const cone = new THREE.ConeGeometry(rad, H * 0.2, 10, 2, false);
      const p = cone.attributes.position;
      for (let i = 0; i < p.count; i++) { const yy = p.getY(i); if (yy < 0) { const a = Math.atan2(p.getZ(i), p.getX(i)); const star = 1 + 0.22 * Math.sin(a * 5 + k) + (r() - 0.5) * 0.25; p.setX(i, p.getX(i) * star); p.setZ(i, p.getZ(i) * star); p.setY(i, yy - r() * 0.8 - 0.3); } }
      cone.translate(0, y, 0);
      parts.push(colorize(cone, leafy(0x1e3d22, r, H)));
    }
    return { geo: mergeGeometries(parts), H, R: H * 0.25, lo: () => colorize(new THREE.ConeGeometry(H * 0.24, H * 0.9, 6).translate(0, H * 0.55, 0), (c, x, y) => c.set(0x1f3d22).multiplyScalar(0.6 + 0.5 * y / H)) };
  },
  broadleaf(r, opts = {}) {
    const H = (opts.h || 9) + r() * 6, parts = [], top = new THREE.Vector3((r() - 0.5) * 1, H * 0.55, (r() - 0.5) * 1);
    const trunkCol = opts.birch ? 0xd8d4c8 : 0x4f3a28;
    parts.push(colorize(limb(new THREE.Vector3(), top, H * 0.035 + 0.15, H * 0.02, 7), opts.birch ? (c, x, y) => c.set(Math.sin(y * 9) > 0.7 ? 0x2a2622 : 0xd8d4c8) : bark(trunkCol)));
    const nb = 4 + Math.floor(r() * 3), clusters = [];
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + r(), el = 0.5 + r() * 0.6, L = H * (0.25 + r() * 0.2);
      const end = top.clone().add(new THREE.Vector3(Math.cos(a) * Math.cos(el) * L, Math.sin(el) * L, Math.sin(a) * Math.cos(el) * L));
      parts.push(colorize(limb(top.clone().setY(top.y * (0.8 + r() * 0.2)), end, H * 0.018, H * 0.008, 5), bark(trunkCol)));
      clusters.push(end);
    }
    clusters.push(top.clone().setY(H * 0.8));
    const leaf = opts.color || 0x3e6a2a;
    for (const c0 of clusters) {
      const s = H * (0.16 + r() * 0.09) * (opts.birch ? 0.7 : 1);
      const blob = jitter(new THREE.IcosahedronGeometry(s, 1), r, s * 0.35); blob.scale(1, 0.8, 1); blob.translate(c0.x, c0.y, c0.z);
      parts.push(colorize(blob, leafy(leaf, r, H)));
    }
    return { geo: mergeGeometries(parts), H, R: H * 0.4, lo: () => { const g = new THREE.IcosahedronGeometry(H * 0.36, 0).scale(1, 0.8, 1).translate(0, H * 0.72, 0); return mergeGeometries([colorize(g, (c, x, y) => c.set(leaf).multiplyScalar(0.5 + 0.6 * y / H)), colorize(new THREE.CylinderGeometry(0.2, 0.3, H * 0.5, 4).translate(0, H * 0.25, 0), bark(trunkCol))]); } };
  },
  palm(r) {
    const H = 8 + r() * 7, parts = [], bend = (r() - 0.5) * 3, segs = 9;
    let prev = new THREE.Vector3();
    for (let k = 1; k <= segs; k++) { const t = k / segs, p = new THREE.Vector3(bend * t * t, H * t, bend * 0.3 * t * t); parts.push(colorize(limb(prev, p, 0.3 - 0.1 * t + 0.03, 0.28 - 0.1 * t, 7), (c, x, y) => c.set(0x7a6247).multiplyScalar(0.8 + 0.25 * Math.sin(y * 6)))); prev = p; }
    const crown = prev;
    for (let f = 0; f < 9; f++) {
      const a = (f / 9) * Math.PI * 2 + r() * 0.3, len = 4 + r() * 2;
      const pos = [], idx = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8, d = new THREE.Vector3(Math.cos(a) * len * t, len * (0.35 * t - 0.75 * t * t) , Math.sin(a) * len * t), wd = 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.1));
        const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(wd);
        const c = crown.clone().add(d);
        pos.push(c.x - side.x, c.y - 0.25 * wd, c.z - side.z, c.x, c.y + 0.12, c.z, c.x + side.x, c.y - 0.25 * wd, c.z + side.z);
        if (k) { const o = (k - 1) * 3; idx.push(o, o + 3, o + 1, o + 1, o + 3, o + 4, o + 1, o + 4, o + 2, o + 2, o + 4, o + 5); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      parts.push(colorize(g, (c) => c.set(f % 2 ? 0x2f6b23 : 0x3c7d2b).multiplyScalar(0.85 + r() * 0.3)));
    }
    for (let k = 0; k < 4; k++) parts.push(colorize(new THREE.SphereGeometry(0.18, 6, 4).translate(crown.x + (r() - 0.5) * 0.5, crown.y - 0.4, crown.z + (r() - 0.5) * 0.5), (c) => c.set(0x5a4020)));
    return { geo: mergeGeometries(parts), H, R: 4, double: true, lo: () => mergeGeometries([colorize(new THREE.CylinderGeometry(0.2, 0.3, H, 4).translate(bend * 0.5, H / 2, 0), (c) => c.set(0x7a6247)), colorize(new THREE.ConeGeometry(4, 1.5, 6).translate(crown.x, crown.y - 0.6, crown.z), (c) => c.set(0x35742a))]) };
  },
  saguaro(r) {
    const H = 6 + r() * 6, parts = [], col = (c, x, y, z) => c.set(0x3f6b3a).multiplyScalar(0.8 + 0.25 * Math.cos(Math.atan2(z, x) * 12));
    parts.push(colorize(new THREE.CapsuleGeometry(0.42, H - 0.8, 4, 12).translate(0, H / 2, 0), col));
    const arms = 1 + Math.floor(r() * 3);
    for (let k = 0; k < arms; k++) {
      const a = r() * Math.PI * 2, y0 = H * (0.35 + r() * 0.3), out = 1.1 + r() * 0.5, up = 1.5 + r() * 2;
      parts.push(colorize(new THREE.CapsuleGeometry(0.3, out, 3, 8).rotateZ(Math.PI / 2).translate(out / 2, 0, 0).rotateY(a).translate(0, y0, 0), col));
      parts.push(colorize(new THREE.CapsuleGeometry(0.3, up, 3, 8).translate(Math.cos(a) * out, y0 + up / 2, -Math.sin(a) * out), col));
    }
    return { geo: mergeGeometries(parts), H, R: 1.5, lo: () => colorize(new THREE.CylinderGeometry(0.45, 0.45, H, 5).translate(0, H / 2, 0), (c) => c.set(0x3f6b3a)) };
  },
  shrub(r, opts = {}) {
    const s = (opts.s || 1.2) + r() * 1.2, parts = [];
    for (let k = 0; k < 4; k++) { const b = jitter(new THREE.IcosahedronGeometry(s * (0.5 + r() * 0.4), 1), r, s * 0.3).translate((r() - 0.5) * s, s * 0.45, (r() - 0.5) * s); parts.push(colorize(b, leafy(opts.color || 0x4a6a2e, r, s * 1.2))); }
    return { geo: mergeGeometries(parts), H: s, R: s, lo: () => colorize(new THREE.IcosahedronGeometry(s * 0.8, 0).translate(0, s * 0.4, 0), (c) => c.set(opts.color || 0x4a6a2e).multiplyScalar(0.8)) };
  },
  rock(r, opts = {}) {
    const s = (opts.s || 1.5) + r() * 3;
    const g = jitter(new THREE.DodecahedronGeometry(s, 1), r, s * 0.45); g.scale(1.3, 0.7, 1); g.translate(0, s * 0.25, 0);
    const geo = colorize(g, (c, x, y) => c.set(opts.color || 0x7a756d).multiplyScalar(0.7 + 0.3 * y / s + (r() - 0.5) * 0.15));
    return { geo, H: s, R: s, rock: true, lo: () => geo };
  },
  dead(r) {
    const H = 6 + r() * 5, parts = [], top = new THREE.Vector3(0, H * 0.6, 0);
    parts.push(colorize(limb(new THREE.Vector3(), top, 0.25, 0.12, 5), bark(0x6a5a48)));
    for (let k = 0; k < 5; k++) { const a = r() * 6.28, e = top.clone().add(new THREE.Vector3(Math.cos(a) * 2.5, 1 + r() * 3, Math.sin(a) * 2.5)); parts.push(colorize(limb(top.clone().setY(top.y * (0.6 + r() * 0.4)), e, 0.1, 0.03, 4), bark(0x6a5a48))); }
    return { geo: mergeGeometries(parts), H, R: 2.5, lo: () => colorize(limb(new THREE.Vector3(), top, 0.25, 0.1, 4), bark(0x6a5a48)) };
  },
};

// which species grow where
function biome(loc) {
  if (loc.id === 'alpine') return [
    { sp: 'pine', w: 6, variants: 5, where: (h, s, n, f) => h < loc.snowline - 120 && s < 0.45 && f > -0.05 },
    { sp: 'broadleaf', w: 1.5, variants: 3, where: (h, s, n, f) => h < 320 && s < 0.25 },
    { sp: 'broadleaf', opts: { birch: true, h: 8, color: 0x6c8a34 }, w: 1, variants: 3, where: (h, s) => h < 500 && s < 0.3 },
    { sp: 'shrub', w: 1.5, variants: 3, where: (h, s) => h < loc.snowline && s < 0.5 },
    { sp: 'rock', w: 1.2, variants: 4, where: (h, s) => s > 0.25 || h > loc.snowline - 400 },
  ];
  if (loc.id === 'islands') return [
    { sp: 'palm', w: 4, variants: 5, where: (h, s, n) => h < 45 && h > loc.water + 0.8 },
    { sp: 'broadleaf', opts: { color: 0x2f6a24, h: 10 }, w: 3, variants: 4, where: (h, s, n, f) => h > 12 && s < 0.5 && f > -0.1 },
    { sp: 'shrub', opts: { color: 0x3a7a2a }, w: 2, variants: 3, where: (h) => h > loc.water + 1 },
    { sp: 'rock', opts: { color: 0x5a524a }, w: 0.6, variants: 3, where: (h, s) => s > 0.3 },
  ];
  return [
    { sp: 'saguaro', w: 3, variants: 5, where: (h, s) => s < 0.3 },
    { sp: 'shrub', opts: { color: 0x7a7a46, s: 0.6 }, w: 4, variants: 4, where: (h, s) => s < 0.4 },
    { sp: 'rock', opts: { color: 0x8e4a2c, s: 2 }, w: 2.5, variants: 5, where: () => true },
    { sp: 'dead', w: 0.4, variants: 2, where: (h, s) => s < 0.25 },
    { sp: 'broadleaf', opts: { color: 0x6a8a3a, h: 11 }, w: 2, variants: 3, where: (h, s, n, f, nearWater) => nearWater },
  ];
}

export class Flora {
  constructor(world) {
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const r = mulberry32(world.loc.seed * 3 + 11), W = world, loc = W.loc;
    const kinds = biome(loc);
    // the whole core is planted (right up to its edge, where the streamed tiles carry on at the same density)
    const total = Math.round(W.q.trees / 0.86 ** 2);
    this.kinds = [];
    const swayCache = {};
    const mkMat = (sway, dbl) => swayCache[sway + '' + dbl] || (swayCache[sway + '' + dbl] = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: dbl ? THREE.DoubleSide : THREE.FrontSide }), sway));
    for (const k of kinds) for (let v = 0; v < k.variants; v++) {
      const m = SPECIES[k.sp](r, k.opts || {});
      const sway = k.sp === 'rock' || k.sp === 'saguaro' || k.sp === 'dead' ? 0 : k.sp === 'palm' ? 0.5 : 0.25;
      this.kinds.push({ ...k, model: m, sway, mat: mkMat(sway, m.double), loMat: mkMat(0, m.double), inst: [] });
    }
    // scatter
    const wsum = this.kinds.reduce((a, k) => a + k.w / k.variants, 0);
    const pick = this.pick = (r) => { let x = r() * wsum; for (const k of this.kinds) { x -= k.w / k.variants; if (x <= 0) return k; } return this.kinds[0]; };
    this.grid = new Map(); let placed = 0, tries = 0;
    const towns = W.net.towns, fields = W.net.fields;
    for (; tries < total * 25 && placed < total; tries++) {
      const x = (r() - 0.5) * W.size, z = (r() - 0.5) * W.size;
      if (Math.abs(x - 140) < 520 && Math.abs(z) < 1400) continue;
      const g = W.groundAt(x, z); if (g.type === 'water' || g.type === 'runway') continue;
      const h = g.h, s = 1 - g.n.y, n = W.noise.n2(x / 90, z / 90), f = W.noise.fbm(x / 260 + 7, z / 260, 3);
      // forests clump; open meadows elsewhere
      if (f < 0.05 && r() < 0.85) continue; // forests clump into patches
      if (towns.some((t) => (t.c.x - x) ** 2 + (t.c.z - z) ** 2 < (360 * t.size) ** 2)) continue;
      if (fields.some((fl) => Math.abs(x - fl.x) < fl.sx + fl.sz && Math.abs(z - fl.z) < fl.sx + fl.sz)) continue;
      if (W.nearRoad(x, z, 12)) continue;
      const nearWater = W.sampleGrid(x + 60, z) < W.waterLevel + 1 || W.sampleGrid(x - 60, z) < W.waterLevel + 1 || W.sampleGrid(x, z + 60) < W.waterLevel + 1 || W.sampleGrid(x, z - 60) < W.waterLevel + 1;
      const k = pick(r); if (!k.where(h, s, n, f, nearWater)) continue;
      const sc = 0.75 + r() * 0.55, yaw = r() * Math.PI * 2;
      k.inst.push([x, h - 0.15, z, sc, yaw]);
      if (!k.model.rock) { const key = Math.floor(x / 50) + ',' + Math.floor(z / 50); if (!this.grid.has(key)) this.grid.set(key, []); this.grid.get(key).push([x, h, z, k.model.H * sc, Math.max(1.2, k.model.R * sc * 0.5)]); }
      placed++;
    }
    // the outer tiles make the same number of attempts per m² as were needed here, so they end up just as wooded
    this.rate = { tries: tries / W.size ** 2, max: 3 * total / W.size ** 2 };
    // instanced meshes: hi + lo for each variant
    for (const k of this.kinds) {
      if (!k.inst.length) continue;
      // three tiers: near (casts shadows), hi (detailed, no shadow work), lo (simple shapes far away)
      k.near = new THREE.InstancedMesh(k.model.geo, k.mat, k.inst.length); k.near.castShadow = W.q.shadows; k.near.receiveShadow = true; k.near.frustumCulled = false;
      k.hi = new THREE.InstancedMesh(k.model.geo, k.mat, k.inst.length); k.hi.frustumCulled = false;
      k.lo = new THREE.InstancedMesh(k.model.lo(), k.loMat, k.inst.length); k.lo.frustumCulled = false;
      const tint = new THREE.Color();
      k.inst.forEach((_, i) => { Flora.tint(r, tint); k.near.setColorAt(i, tint); k.hi.setColorAt(i, tint); k.lo.setColorAt(i, tint); });
      k.near.count = k.hi.count = k.lo.count = 0;
      this.group.add(k.near, k.hi, k.lo);
    }
    this.loDist = { low: 400, medium: 650, high: 1300 }[W.qName] || 650;
    this.farDist = { low: 4500, medium: 6000, high: 9000 }[W.qName] || 6000;
    this.lastLod = null;
    this.buildGrass();
  }
  static tint(r, c) { return c.setHSL(0.08 + r() * 0.05, 0.2 * r(), 0.42 + r() * 0.16).multiplyScalar(2.2); }
  // shared simple far-away shape for a kind (also used by the outer tiles, even for kinds the core didn't place)
  loGeo(k) { return k.lo ? k.lo.geometry : (k.loGeoCache ||= k.model.lo()); }
  // re-bucket instances into near (detailed) / far (simple) meshes
  updateLod(cam) {
    if (this.lastLod && this.lastLod.distanceToSquared(cam) < 40 * 40) return;
    this.lastLod = cam.clone();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const d2 = this.loDist * this.loDist, far2 = this.farDist * this.farDist, n2 = 170 * 170;
    for (const k of this.kinds) {
      if (!k.hi) continue;
      let nn = 0, nh = 0, nl = 0;
      for (const [x, y, z, sc, yaw] of k.inst) {
        const dd = (x - cam.x) ** 2 + (z - cam.z) ** 2; if (dd > far2) continue;
        p.set(x, y, z); q.setFromAxisAngle(up, yaw); s.set(sc, sc, sc); m.compose(p, q, s);
        if (dd < n2) k.near.setMatrixAt(nn++, m); else if (dd < d2) k.hi.setMatrixAt(nh++, m); else k.lo.setMatrixAt(nl++, m);
      }
      k.near.count = nn; k.hi.count = nh; k.lo.count = nl;
      for (const mm of [k.near, k.hi, k.lo]) mm.instanceMatrix.needsUpdate = true;
    }
  }
  // tufts of grass that follow the camera when low
  buildGrass() {
    if (this.w.loc.desert && false) return;
    const n = { low: 0, medium: 3500, high: 20000 }[this.w.qName] ?? 3500; if (!n) return;
    const pos = [], col = [], c = new THREE.Color(), base = new THREE.Color(this.w.loc.desert ? 0xb89a5a : 0x5b7d33);
    for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI, lean = (k % 2 ? 0.15 : -0.12); const cx = Math.cos(a) * 0.12, cz = Math.sin(a) * 0.12; pos.push(-cx, 0, -cz, cx, 0, cz, Math.sin(a) * lean, 1, Math.cos(a) * lean); for (let v = 0; v < 3; v++) { c.copy(base).multiplyScalar(v === 2 ? 1.25 : 0.6); col.push(c.r, c.g, c.b); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    const mat = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }), 0.8);
    this.grass = new THREE.InstancedMesh(g, mat, n); this.grass.frustumCulled = false; this.grass.receiveShadow = true; this.grass.count = 0;
    this.grassN = n; this.group.add(this.grass);
  }
  updateGrass(cam) {
    if (!this.grass) return;
    const W = this.w, agl = cam.y - Math.max(W.sampleGrid(cam.x, cam.z), W.waterLevel);
    if (agl > 160) { this.grass.count = 0; this.grassAt = null; return; }
    if (this.grassAt && this.grassAt.distanceToSquared(cam) < 18 * 18) return;
    this.grassAt = cam.clone();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const R = 75, cell = 1.1; let k = 0;
    const gx0 = Math.floor((cam.x - R) / cell), gz0 = Math.floor((cam.z - R) / cell);
    for (let gx = gx0; gx < gx0 + (2 * R) / cell && k < this.grassN; gx++) for (let gz = gz0; gz < gz0 + (2 * R) / cell && k < this.grassN; gz++) {
      const hsh = Math.sin(gx * 127.1 + gz * 311.7) * 43758.5453, fr = hsh - Math.floor(hsh), fr2 = (fr * 7.31) % 1;
      if (fr < (this.w.loc.desert ? 0.85 : 0.2)) continue;
      const x = gx * cell + fr2 * cell, z = gz * cell + fr * cell;
      if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > R * R) continue;
      const g = W.groundAt(x, z); if (g.type !== 'grass' && g.type !== 'sand') continue; if (g.n.y < 0.85) continue;
      if (W.nearRoad(x, z, 7)) continue;
      const sc = 0.5 + fr2 * 0.7; p.set(x, g.h - 0.05, z); q.setFromAxisAngle(up, fr * 6.28); s.set(sc * 1.6, sc * (0.35 + fr * 0.5), sc * 1.6); m.compose(p, q, s);
      this.grass.setMatrixAt(k++, m);
    }
    this.grass.count = k; this.grass.instanceMatrix.needsUpdate = true;
  }
  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) { const dx = p.x - t[0], dz = p.z - t[2]; if (dx * dx + dz * dz < t[4] * t[4] && p.y < t[1] + t[3] && p.y > t[1]) return t; }
    return null;
  }
  update(cam) { this.updateLod(cam); this.updateGrass(cam); }
}
