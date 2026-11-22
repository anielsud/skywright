// Road traffic with proper procedural car models, a train, airport ground vehicles and parked cars.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32, clamp } from './noise.js';
import { glowTexture } from './materials.js';
import { lanePaths } from './roads.js';

// ---------- model kit ----------
function vcol(g, hex) {
  const geo = g.index ? g.toNonIndexed() : g; const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); geo.deleteAttribute('uv'); return geo;
}
// side profile (x = length, forward = -z later), extruded across the width
function sideExtrude(pts, width, bevel = 0.06) {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -(width - bevel * 2) / 2); g.rotateY(Math.PI / 2); // length now along -z ... +z
  return g;
}
const DARK = 0x14181d, GLASS = 0x1c2733, TIRE = 0x161616, RIM = 0xb8bcc2, BODY = 0xffffff, CHROME = 0xd0d4d8, TAIL = 0x8a1010, HEAD = 0xf4f0e0;
function wheelSet(geos, xs, zs, r, w) {
  for (const x of xs) for (const z of zs) {
    geos.push(vcol(new THREE.CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2).translate(x, r, z), TIRE));
    geos.push(vcol(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 10).rotateZ(Math.PI / 2).translate(x, r, z), RIM));
  }
}
function lights(geos, halfW, zf, zr, yf, yr) {
  for (const s of [-1, 1]) {
    geos.push(vcol(new THREE.BoxGeometry(0.34, 0.12, 0.06).translate(s * (halfW - 0.28), yf, zf), HEAD));
    geos.push(vcol(new THREE.BoxGeometry(0.32, 0.14, 0.06).translate(s * (halfW - 0.26), yr, zr), TAIL));
  }
}
const CAR = {
  sedan() {
    const L = 4.6, W = 1.82, g = [];
    g.push(vcol(sideExtrude([[-2.3, 0.32], [2.3, 0.32], [2.32, 0.72], [2.2, 0.86], [1.25, 0.95], [-1.4, 0.95], [-2.25, 0.8], [-2.32, 0.55]], W), BODY));
    g.push(vcol(sideExtrude([[1.15, 0.94], [0.45, 1.38], [-0.85, 1.4], [-1.45, 0.94]], W - 0.18, 0.03), GLASS));
    g.push(vcol(sideExtrude([[0.42, 1.38], [0.38, 1.43], [-0.82, 1.45], [-0.86, 1.39]], W - 0.22, 0.03), BODY));
    g.push(vcol(new THREE.BoxGeometry(W - 0.1, 0.18, 0.1).translate(0, 0.4, -2.33), DARK)); g.push(vcol(new THREE.BoxGeometry(W - 0.1, 0.18, 0.1).translate(0, 0.4, 2.33), DARK));
    for (const s of [-1, 1]) g.push(vcol(new THREE.BoxGeometry(0.14, 0.08, 0.16).translate(s * (W / 2 + 0.05), 1.0, -0.95), BODY));
    wheelSet(g, [-W / 2 + 0.12, W / 2 - 0.12], [-1.45, 1.4], 0.33, 0.22); lights(g, W / 2, -2.33, 2.33, 0.72, 0.78);
    return { geo: mergeGeometries(g), L, W, H: 1.45, head: [[-0.62, 0.72, -2.35], [0.62, 0.72, -2.35]], tail: [[-0.64, 0.78, 2.35], [0.64, 0.78, 2.35]] };
  },
  hatch() {
    const L = 3.9, W = 1.75, g = [];
    g.push(vcol(sideExtrude([[-1.95, 0.32], [1.95, 0.32], [1.97, 0.75], [1.85, 0.88], [1.05, 0.98], [-1.9, 1.0], [-1.97, 0.55]], W), BODY));
    g.push(vcol(sideExtrude([[0.95, 0.97], [0.3, 1.42], [-1.6, 1.44], [-1.9, 0.99]], W - 0.18, 0.03), GLASS));
    g.push(vcol(sideExtrude([[0.28, 1.42], [0.24, 1.48], [-1.58, 1.5], [-1.62, 1.43]], W - 0.22, 0.03), BODY));
    wheelSet(g, [-W / 2 + 0.12, W / 2 - 0.12], [-1.25, 1.25], 0.31, 0.2); lights(g, W / 2, -1.98, 1.98, 0.74, 0.95);
    return { geo: mergeGeometries(g), L, W, H: 1.5, head: [[-0.6, 0.74, -2.0], [0.6, 0.74, -2.0]], tail: [[-0.6, 0.95, 2.0], [0.6, 0.95, 2.0]] };
  },
  suv() {
    const L = 4.8, W = 1.95, g = [];
    g.push(vcol(sideExtrude([[-2.4, 0.45], [2.4, 0.45], [2.42, 1.0], [2.25, 1.12], [1.35, 1.18], [-2.35, 1.2], [-2.42, 0.7]], W), BODY));
    g.push(vcol(sideExtrude([[1.25, 1.17], [0.6, 1.72], [-2.15, 1.74], [-2.3, 1.19]], W - 0.16, 0.03), GLASS));
    g.push(vcol(sideExtrude([[0.58, 1.72], [0.55, 1.8], [-2.12, 1.82], [-2.16, 1.73]], W - 0.2, 0.03), BODY));
    g.push(vcol(new THREE.BoxGeometry(W - 0.4, 0.06, 2.2).translate(0, 1.86, -0.6), DARK)); // roof rails
    wheelSet(g, [-W / 2 + 0.14, W / 2 - 0.14], [-1.5, 1.45], 0.4, 0.26); lights(g, W / 2, -2.43, 2.43, 0.95, 1.05);
    return { geo: mergeGeometries(g), L, W, H: 1.85, head: [[-0.66, 0.95, -2.45], [0.66, 0.95, -2.45]], tail: [[-0.7, 1.05, 2.45], [0.7, 1.05, 2.45]] };
  },
  pickup() {
    const L = 5.3, W = 1.95, g = [];
    g.push(vcol(sideExtrude([[-2.65, 0.5], [2.65, 0.5], [2.67, 1.05], [2.5, 1.15], [1.5, 1.2], [0.1, 1.2], [0.1, 1.12], [-2.6, 1.12], [-2.67, 0.7]], W), BODY));
    g.push(vcol(sideExtrude([[1.4, 1.19], [0.85, 1.75], [0.2, 1.77], [0.15, 1.2]], W - 0.16, 0.03), GLASS));
    g.push(vcol(sideExtrude([[0.84, 1.75], [0.82, 1.82], [0.18, 1.84], [0.15, 1.76]], W - 0.2, 0.03), BODY));
    g.push(vcol(new THREE.BoxGeometry(W - 0.3, 0.05, 2.5).translate(0, 1.08, 1.35), DARK)); // bed floor
    wheelSet(g, [-W / 2 + 0.14, W / 2 - 0.14], [-1.75, 1.75], 0.42, 0.28); lights(g, W / 2, -2.68, 2.68, 0.98, 1.0);
    return { geo: mergeGeometries(g), L, W, H: 1.85, head: [[-0.68, 0.98, -2.7], [0.68, 0.98, -2.7]], tail: [[-0.8, 1.0, 2.7], [0.8, 1.0, 2.7]] };
  },
  van() {
    const L = 5.2, W = 2.0, g = [];
    g.push(vcol(sideExtrude([[-2.6, 0.42], [2.6, 0.42], [2.62, 1.0], [2.3, 1.2], [1.6, 2.15], [-2.55, 2.2], [-2.62, 0.7]], W), BODY));
    g.push(vcol(sideExtrude([[2.25, 1.22], [1.6, 2.05], [0.9, 2.08], [0.9, 1.25]], W + 0.01, 0.02), GLASS));
    wheelSet(g, [-W / 2 + 0.14, W / 2 - 0.14], [-1.75, 1.75], 0.36, 0.25); lights(g, W / 2, -2.63, 2.63, 0.95, 1.1);
    return { geo: mergeGeometries(g), L, W, H: 2.2, head: [[-0.7, 0.95, -2.65], [0.7, 0.95, -2.65]], tail: [[-0.8, 1.1, 2.65], [0.8, 1.1, 2.65]] };
  },
  bus() {
    const L = 11.5, W = 2.5, g = [];
    g.push(vcol(sideExtrude([[-5.75, 0.45], [5.75, 0.45], [5.8, 2.9], [5.6, 3.15], [-5.6, 3.15], [-5.8, 2.9]], W, 0.1), BODY));
    g.push(vcol(new THREE.BoxGeometry(W + 0.02, 0.95, 9.6).translate(0, 2.0, 0.5), GLASS));
    g.push(vcol(new THREE.BoxGeometry(W - 0.2, 1.4, 0.05).translate(0, 1.9, -5.82), GLASS));
    wheelSet(g, [-W / 2 + 0.16, W / 2 - 0.16], [-3.8, 3.6], 0.5, 0.32); lights(g, W / 2, -5.83, 5.83, 0.9, 1.1);
    return { geo: mergeGeometries(g), L, W, H: 3.15, head: [[-0.95, 0.9, -5.85], [0.95, 0.9, -5.85]], tail: [[-1.0, 1.1, 5.85], [1.0, 1.1, 5.85]] };
  },
  truck() {
    const L = 12, W = 2.5, g = [];
    g.push(vcol(sideExtrude([[-6, 0.6], [-3.6, 0.6], [-3.6, 2.4], [-4.0, 2.95], [-5.9, 2.95], [-6.0, 2.4]], W), BODY));
    g.push(vcol(sideExtrude([[-5.95, 1.7], [-5.7, 2.75], [-4.4, 2.75], [-4.4, 1.7]], W + 0.01, 0.02), GLASS));
    g.push(vcol(new THREE.BoxGeometry(W, 3.0, 8.6).translate(0, 2.4, 1.6), 0xe6e6e6)); // trailer box (stays light)
    g.push(vcol(new THREE.BoxGeometry(W - 0.4, 0.4, 11).translate(0, 0.65, 0.2), DARK));
    wheelSet(g, [-W / 2 + 0.16, W / 2 - 0.16], [-4.9, -1.8, 4.2, 5.2], 0.52, 0.34); lights(g, W / 2, -6.02, 5.92, 1.0, 1.1);
    return { geo: mergeGeometries(g), L, W, H: 3.9, head: [[-1, 1.0, -6.05], [1, 1.0, -6.05]], tail: [[-1.05, 1.1, 5.95], [1.05, 1.1, 5.95]] };
  },
  tanker() {
    const L = 11, W = 2.5, g = [];
    g.push(vcol(sideExtrude([[-5.5, 0.6], [-3.2, 0.6], [-3.2, 2.4], [-3.6, 2.95], [-5.4, 2.95], [-5.5, 2.4]], W), BODY));
    g.push(vcol(sideExtrude([[-5.45, 1.7], [-5.2, 2.75], [-4.0, 2.75], [-4.0, 1.7]], W + 0.01, 0.02), GLASS));
    g.push(vcol(new THREE.CylinderGeometry(1.15, 1.15, 7.6, 18).rotateX(Math.PI / 2).translate(0, 2.0, 1.5), 0xd8dadd));
    g.push(vcol(new THREE.BoxGeometry(W - 0.4, 0.4, 10.4).translate(0, 0.65, 0.1), DARK));
    wheelSet(g, [-W / 2 + 0.16, W / 2 - 0.16], [-4.4, -1.6, 3.6, 4.6], 0.52, 0.34); lights(g, W / 2, -5.52, 5.45, 1.0, 1.1);
    return { geo: mergeGeometries(g), L, W, H: 3.5, head: [[-1, 1.0, -5.55], [1, 1.0, -5.55]], tail: [[-1.05, 1.1, 5.5], [1.05, 1.1, 5.5]] };
  },
};
const TYPES = ['sedan', 'sedan', 'hatch', 'hatch', 'suv', 'suv', 'pickup', 'van', 'bus', 'truck', 'tanker'];
const PAINT = [0xc8102e, 0xf2f2ee, 0x1d4e89, 0x202326, 0x8a9099, 0xd0d3d6, 0x2e6b3f, 0x6fb7e9, 0x7a2030, 0xe8a43c, 0x3b3f6b, 0xf2f2ee, 0x202326, 0xb0b4b8];

export class Vehicles {
  constructor(scene, world) {
    this.world = world; this.group = new THREE.Group(); scene.add(this.group);
    const r = (this.r = mulberry32(world.loc.seed + 77));
    this.models = {}; this.meshes = {};
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.32 });
    // traffic on the lanes
    this.paths = lanePaths(world.net);
    this.cars = [];
    const want = { low: 70, medium: 140, high: 240 }[world.qBase] || 140;
    const totalLen = this.paths.reduce((a, p) => a + p.total, 0);
    for (const p of this.paths) {
      const n = Math.max(1, Math.round((want * p.total) / totalLen));
      for (let k = 0; k < n; k++) {
        let type = TYPES[Math.floor(r() * TYPES.length)];
        if (p.kind === 'street' && (type === 'truck' || type === 'tanker')) type = 'sedan';
        this.cars.push({ path: p, s: (k / n) * p.total + r() * 10, v: p.speed * 0.8, want: p.speed * (0.8 + r() * 0.35), type, color: PAINT[Math.floor(r() * PAINT.length)], brake: 0 });
      }
    }
    // parked cars (towns + airport lot): static instances
    this.parked = [];
    // driveways / squares laid out by towns.js; otherwise a few along each town's main street
    for (const sp of world.towns?.parkSpots || []) this.parked.push({ p: new THREE.Vector3(sp.x, 0, sp.z), yaw: sp.yaw, type: TYPES[Math.floor(r() * 5)], color: PAINT[Math.floor(r() * PAINT.length)] });
    if (!world.towns?.parkSpots?.length) for (const t of world.net.towns) for (let k = 0; k < 26 * t.size; k++) {
      const side = new THREE.Vector3(-t.dir.z, 0, t.dir.x), along = (r() - 0.5) * 480 * t.size, off = (r() < 0.5 ? -1 : 1) * 5.6;
      const p = t.c.clone().addScaledVector(t.dir, along).addScaledVector(side, off);
      this.parked.push({ p, yaw: Math.atan2(-t.dir.x, -t.dir.z) + (r() < 0.5 ? Math.PI : 0), type: TYPES[Math.floor(r() * 5)], color: PAINT[Math.floor(r() * PAINT.length)] });
    }
    for (let row = 0; row < 3; row++) for (let k = 0; k < 14; k++) if (r() < 0.75) this.parked.push({ p: new THREE.Vector3(345 + row * 7, 0, 60 + k * 3.2), yaw: Math.PI / 2, type: TYPES[Math.floor(r() * 7)], color: PAINT[Math.floor(r() * PAINT.length)] });
    // airport ground vehicles driving around the apron
    const apron = [[120, -150], [120, 150], [250, 150], [250, -150]].map(([x, z]) => new THREE.Vector3(x, 0, z));
    const ap = { pts: [], speed: 7, kind: 'apron' }; for (let i = 0; i < 4; i++) { const a = apron[i], b = apron[(i + 1) % 4]; for (let t = 0; t < 1; t += 0.02) ap.pts.push(a.clone().lerp(b, t)); }
    ap.len = []; let L = 0; ap.pts.forEach((q, i) => { if (i) L += q.distanceTo(ap.pts[i - 1]); ap.len.push(L); }); ap.total = L + ap.pts.at(-1).distanceTo(ap.pts[0]);
    this.cars.push({ path: ap, s: 0, v: 6, want: 7, type: 'tanker', color: 0xf2f2ee, brake: 0 }, { path: ap, s: ap.total * 0.5, v: 6, want: 6, type: 'van', color: 0xf2b705, brake: 0 });
    // instanced meshes per type
    const counts = {};
    for (const c of [...this.cars, ...this.parked]) counts[c.type] = (counts[c.type] || 0) + 1;
    for (const t in counts) {
      const m = (this.models[t] = CAR[t]());
      const im = new THREE.InstancedMesh(m.geo, mat, counts[t]); im.castShadow = world.qBase === 'high'; im.receiveShadow = true; im.frustumCulled = false; world.nearShadow?.(im);
      im.count = 0; this.meshes[t] = im; this.group.add(im);
    }
    const col = new THREE.Color();
    const idx = {};
    for (const c of this.parked) { c.slot = (idx[c.type] = (idx[c.type] ?? -1) + 1); this.meshes[c.type].setColorAt(c.slot, col.set(c.color)); }
    this.parkedCount = {}; for (const t in idx) this.parkedCount[t] = idx[t] + 1;
    for (const t in this.meshes) { this.meshes[t].count = this.parkedCount[t] || 0; if (!this.meshes[t].instanceColor) this.meshes[t].setColorAt(0, col.set(0xffffff)); this.meshes[t].instanceColor.needsUpdate = true; }
    this.drawDist = { low: 1200, medium: 1800, high: 3000 }[world.qBase] || 1800;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (const c of this.parked) { c.p.y = world.sampleGrid(c.p.x, c.p.z) + 0.03; q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw); m4.compose(c.p, q, one); this.meshes[c.type].setMatrixAt(c.slot, m4); c.m4 = m4.clone(); }
    // lights (points): 2 head + 2 tail per moving car
    const n = this.cars.length * 4;
    this.lp = new Float32Array(n * 3); this.lc = new Float32Array(n * 3);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(this.lp, 3)); lg.setAttribute('color', new THREE.BufferAttribute(this.lc, 3));
    this.lights = new THREE.Points(lg, new THREE.PointsMaterial({ size: 1.4, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(3, 3, 3) }));
    this.lights.frustumCulled = false; this.group.add(this.lights);
    this.buildTrain();
    this.t = 0;
    // Per frame only the cars near the camera cost anything. A city's lanes are thousands of short segments with a car
    // or two each (NYC: ~6000), so the cars are grouped by lane once, and each lane carries a bounding circle: a lane
    // wholly beyond the draw distance is skipped with one distance check (its cars still drive on).
    this.lanes = [];
    const byPath = new Map();
    for (const c of this.cars) { if (!byPath.has(c.path)) byPath.set(c.path, []); byPath.get(c.path).push(c); }
    for (const [path, list] of byPath) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const q of path.pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
      this.lanes.push({ path, list, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2 + 10 });
    }
    this.lightsOn = 0; // light slots written last frame (the rest are past the draw range)
  }
  pathPoint(path, s, out, dirOut) {
    s = ((s % path.total) + path.total) % path.total;
    const L = path.len; let lo = 0, hi = L.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L[mid] <= s) lo = mid; else hi = mid - 1; }
    const a = path.pts[lo], b = path.pts[(lo + 1) % path.pts.length], seg = (lo + 1 < L.length ? L[lo + 1] : path.total) - L[lo];
    const t = seg > 0 ? (s - L[lo]) / seg : 0;
    out.lerpVectors(a, b, t); dirOut.subVectors(b, a).normalize();
    // roads and rail carry their own profile (what physics drives on, bridges included); the apron loop is flat ground
    out.y = path.kind === 'apron' ? this.world.sampleGrid(out.x, out.z) + 0.25 : a.y + (b.y - a.y) * t + 0.02;
    return lo;
  }
  // Parked cars near the camera take the first slots of each type's instances (the moving ones follow): re-chosen every
  // 150 m of camera movement, so the parked cars of the whole map (a city's: hundreds) aren't all drawn every frame.
  placeParked(camPos) {
    const R = this.drawDist + 150, col = new THREE.Color(), n = {};
    for (const c of this.parked) {
      if ((c.p.x - camPos.x) ** 2 + (c.p.z - camPos.z) ** 2 > R * R) { c.slot = undefined; continue; }
      const m = this.meshes[c.type]; c.slot = n[c.type] = (n[c.type] ?? -1) + 1; m.setMatrixAt(c.slot, c.m4); m.setColorAt(c.slot, col.set(c.color));
    }
    for (const t in this.meshes) this.parkedCount[t] = (n[t] ?? -1) + 1;
    this.parkAt = { x: camPos.x, z: camPos.z }; this.parkFull = true; // (upload the parked slots too this frame)
  }
  update(dt, camPos) {
    this.t += dt;
    if (camPos && (!this.parkAt || Math.hypot(camPos.x - this.parkAt.x, camPos.z - this.parkAt.z) > 150)) this.placeParked(camPos);
    const W = this.world, night = W.night || W.W.dark > 0.5;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), d = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const eu = new THREE.Euler(), lv = new THREE.Vector3(), col = new THREE.Color(); // reused per car (no garbage per car per frame)
    const vis = {}; for (const t in this.meshes) vis[t] = this.parkedCount[t] || 0;
    const R2 = this.drawDist * this.drawDist, show = night ? 1 : 0, LP = this.lp, LC = this.lc;
    let nl = 0; // lights written (packed: only the cars drawn this frame)
    const put = (lp, c0, c1, c2, on) => { const v = lv.set(lp[0], lp[1], lp[2]).applyQuaternion(q).add(p), o = nl * 3; LP[o] = v.x; LP[o + 1] = v.y; LP[o + 2] = v.z; LC[o] = c0 * on; LC[o + 1] = c1 * on; LC[o + 2] = c2 * on; nl++; };
    for (const L of this.lanes) {
      const { path, list } = L;
      // car following along the lane
      if (list.length === 1) { const c = list[0], dv = clamp(c.want - c.v, -6 * dt, 2.2 * dt); c.brake = dv < -0.5 * dt ? 1 : Math.max(0, c.brake - dt * 2); c.v = Math.max(0, c.v + dv); c.s = (c.s + c.v * dt) % path.total; }
      else {
        list.sort((a, b) => a.s - b.s);
        for (let i = 0; i < list.length; i++) {
          const c = list[i], ahead = list[(i + 1) % list.length];
          const gap = (ahead.s - c.s + path.total) % path.total - this.models[ahead.type].L * 0.5 - this.models[c.type].L * 0.5;
          const want = Math.min(c.want, Math.max(0, (gap - 6) / 1.6));
          const dv = clamp(want - c.v, -6 * dt, 2.2 * dt);
          c.brake = dv < -0.5 * dt ? 1 : Math.max(0, c.brake - dt * 2);
          c.v = Math.max(0, c.v + dv); c.s = (c.s + c.v * dt) % path.total;
        }
      }
      if (camPos) { const dl = Math.hypot(L.cx - camPos.x, L.cz - camPos.z) - L.r; if (dl > this.drawDist) { for (const c of list) c.slot = undefined; continue; } } // the whole lane is too far to see: simulate only
      for (const c of list) {
        this.pathPoint(path, c.s, p, d);
        if (camPos && (p.x - camPos.x) ** 2 + (p.z - camPos.z) ** 2 > R2) { c.slot = undefined; continue; }
        const mdl = this.models[c.type], mesh = this.meshes[c.type];
        c.slot = vis[c.type]++;
        // pitch with the road's grade (no per-frame allocations: reuse eu)
        const yaw = Math.atan2(-d.x, -d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        q.setFromEuler(eu.set(pitch, yaw, 0, 'YXZ'));
        m4.compose(p, q, one); mesh.setMatrixAt(c.slot, m4); mesh.setColorAt(c.slot, col.set(c.color));
        const tail = Math.max(show * 0.5, c.brake ? 1 : 0);
        if (show || tail) { put(mdl.head[0], 1, 0.95, 0.8, show); put(mdl.head[1], 1, 0.95, 0.8, show); put(mdl.tail[0], 1, 0.08, 0.04, tail); put(mdl.tail[1], 1, 0.08, 0.04, tail); }
      }
    }
    // upload only the slots in use (parked cars first, then this frame's moving ones), not every car in the city
    for (const t in this.meshes) {
      const m = this.meshes[t], n = vis[t], n0 = this.parkFull ? 0 : this.parkedCount[t] || 0; m.count = n;
      if (n > n0) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(n0 * 16, (n - n0) * 16); m.instanceMatrix.needsUpdate = true;
        m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(n0 * 3, (n - n0) * 3); m.instanceColor.needsUpdate = true; }
    }
    this.parkFull = false;
    const lg = this.lights.geometry;
    lg.setDrawRange(0, nl);
    if (nl) for (const a of [lg.attributes.position, lg.attributes.color]) { a.clearUpdateRanges(); a.addUpdateRange(0, nl * 3); a.needsUpdate = true; }
    this.lightsOn = nl;
    this.updateTrain(dt);
  }
  // ---------- train ----------
  buildTrain() {
    const rail = this.world.net.rail; if (!rail) return;
    const path = { pts: [...rail.pts, ...rail.pts.slice().reverse()], bridge: [...rail.bridge, ...rail.bridge.slice().reverse()] };
    path.len = []; let L = 0; path.pts.forEach((q, i) => { if (i) L += q.distanceTo(path.pts[i - 1]); path.len.push(L); }); path.total = L + 1;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.4 });
    const car = (loco) => {
      const g = [];
      const body = sideExtrude(loco ? [[-9, 0.9], [9, 0.9], [9.1, 3.2], [8.2, 4.1], [-9, 4.1]] : [[-10, 0.9], [10, 0.9], [10, 3.8], [9.6, 4.15], [-9.6, 4.15], [-10, 3.8]], 2.9, 0.12);
      g.push(vcol(body, loco ? 0xc8102e : 0xd8dce0));
      g.push(vcol(new THREE.BoxGeometry(2.92, 0.9, loco ? 3 : 17).translate(0, 2.8, loco ? -7.4 : 0), GLASS));
      if (!loco) g.push(vcol(new THREE.BoxGeometry(2.94, 0.25, 19.6).translate(0, 1.6, 0), 0xc8102e));
      for (const z of loco ? [-6, 6] : [-7, 7]) { g.push(vcol(new THREE.BoxGeometry(2.4, 0.7, 3.2).translate(0, 0.6, z), DARK)); }
      return mergeGeometries(g);
    };
    this.train = { path, s: 0, v: 0, cars: [] };
    for (let k = 0; k < 7; k++) { const m = new THREE.Mesh(car(k === 0), mat); m.castShadow = true; this.group.add(m); this.train.cars.push(m); }
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 5) })); hl.position.set(0, 3.4, -9.1); this.train.cars[0].add(hl);
  }
  updateTrain(dt) {
    const T = this.train; if (!T) return;
    const half = T.path.total / 2, inHalf = T.s % half;
    const remain = half - inHalf;
    const want = remain < 300 ? Math.max(2, remain / 300 * 30) : 30;
    T.v += clamp(want - T.v, -2 * dt, 0.8 * dt); T.s = (T.s + T.v * dt) % T.path.total;
    const p = new THREE.Vector3(), d = new THREE.Vector3(), p2 = new THREE.Vector3(), d2 = new THREE.Vector3();
    T.cars.forEach((m, k) => {
      const s = T.s - k * 20.6 - (k ? 1 : 0);
      this.pathPoint(T.path, s, p, d); p.y += 0.25;
      this.pathPoint(T.path, s - 8, p2, d2);
      m.position.copy(p);
      m.lookAt(p.clone().add(p.clone().sub(p2).setLength(10))); m.rotateY(Math.PI);
    });
  }
  dispose() { this.group.parent?.remove(this.group); }
}
