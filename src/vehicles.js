// Road traffic, parked cars and airport ground vehicles (models: src/trafficModels.js, built by tools/traffic/build.mjs
// from CC BY models), plus the train (still built here from simple shapes).
//
// All the vehicles on screen are one THREE.BatchedMesh (one material, one draw call): each car is an instance whose
// geometry is its type's level of detail for its distance (lod0 near, with its wheels as separate instances that
// spin; lod1 and lod2 farther, wheels merged in). The models load in the background: until they arrive the cars
// already drive (and sound), just unseen.
import * as THREE from 'three';
import { FIRE } from './airportBuildings.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32, clamp } from './noise.js';
import { glowTexture } from './materials.js';
import { lanePaths } from './roads.js';
import { trafficModels, trafficModelsNow } from './trafficModels.js';

// ---------- simple shapes (the train) ----------
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
const DARK = 0x14181d, GLASS = 0x1c2733;

// the contact shadow: a soft rounded rectangle (alpha), darkest under the middle of the car
let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const W = 64, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.abs((x + 0.5) / W * 2 - 1), v = Math.abs((y + 0.5) / H * 2 - 1); // 0 centre .. 1 edge
    const d = Math.hypot(Math.max(0, u - 0.5) / 0.5, Math.max(0, v - 0.72) / 0.28); // rounded-rect distance past the core (the core ~ the car's footprint: the patch is 1.8 x its width, 1.3 x its length)
    const a = Math.max(0, 1 - d) ** 0.9;
    img.data.set([255, 255, 255, Math.round(a * 255)], (y * W + x) * 4);
  }
  g.putImageData(img, 0, 0);
  _blobTex = new THREE.CanvasTexture(cv); _blobTex.colorSpace = THREE.NoColorSpace;
  return _blobTex;
}

// ---------- who drives where ----------
// relative odds of each model by lane kind; NYC adds its yellow cabs and buses
const MIX = {
  sedan: 14, hatch: 10, compact: 8, suv: 12, wagon: 6, minivan: 6, coupe: 4, sport: 1.5, pickup: 8, offroad: 4,
  taxi: 0.6, police: 1, postvan: 2, utility: 2, towtruck: 0.7, garbage: 0.8, ambulance: 0.5, firetruck: 0.3, citybus: 2, schoolbus: 0.8, tanker: 1.2,
};
const CITY = { taxi: 26, citybus: 4, police: 2, postvan: 3, garbage: 1.5, ambulance: 1 };
const PARK = { sedan: 10, hatch: 9, compact: 9, suv: 9, wagon: 5, minivan: 5, coupe: 3, sport: 0.6, pickup: 6, offroad: 3, postvan: 0.8, utility: 0.6 };
const NO_STREET = new Set(['tanker']); // (town streets: no fuel tankers)
const PAINT = [0xc8102e, 0xf2f2ee, 0x1d4e89, 0x202326, 0x8a9099, 0xd0d3d6, 0x2e6b3f, 0x6fb7e9, 0x7a2030, 0xe8a43c, 0x3b3f6b, 0xf2f2ee, 0x202326, 0xb0b4b8, 0x5a3a28, 0xe6dccb];
const PAINTED = new Set(['sedan', 'hatch', 'compact', 'suv', 'wagon', 'minivan', 'coupe', 'sport', 'pickup', 'offroad']); // (the rest wear their own livery)
function picker(r, odds) { const k = Object.keys(odds), w = k.map((t) => odds[t]), tot = w.reduce((a, b) => a + b, 0); return () => { let x = r() * tot; for (let i = 0; i < k.length; i++) if ((x -= w[i]) < 0) return k[i]; return k[0]; }; }
// distances (m) where a vehicle switches to lod1 and lod2, per quality
const LOD = { low: [35, 150], medium: [50, 220], high: [70, 320] };
const DEFAULT = { L: 4.6, W: 1.9, head: [[-0.6, 0.7, -2.3], [0.6, 0.7, -2.3]], tail: [[-0.6, 0.8, 2.3], [0.6, 0.8, 2.3]], wheels: [] }; // (until the models arrive)

export class Vehicles {
  constructor(scene, world) {
    this.world = world; this.group = new THREE.Group(); scene.add(this.group);
    const r = (this.r = mulberry32(world.loc.seed + 77));
    const city = world.loc.id === 'nyc', mix = { ...MIX }; if (city) for (const t in CITY) mix[t] += CITY[t];
    const pick = picker(r, mix), pickStreet = picker(r, Object.fromEntries(Object.entries(mix).filter(([t]) => !NO_STREET.has(t))));
    const pickPark = picker(r, city ? { ...PARK, taxi: 6 } : PARK);
    const color = (type) => PAINTED.has(type) ? PAINT[Math.floor(r() * PAINT.length)] : 0xffffff;
    // traffic on the lanes
    this.paths = lanePaths(world.net);
    this.cars = [];
    const want = { low: 70, medium: 140, high: 240 }[world.qBase] || 140;
    const totalLen = this.paths.reduce((a, p) => a + p.total, 0);
    for (const p of this.paths) {
      const n = Math.max(1, Math.round((want * p.total) / totalLen));
      for (let k = 0; k < n; k++) {
        const type = p.kind === 'street' ? pickStreet() : pick();
        this.cars.push({ path: p, s: (k / n) * p.total + r() * 10, v: p.speed * 0.8, want: p.speed * (0.8 + r() * 0.35), type, color: color(type), brake: 0, roll: 0 });
      }
    }
    // parked cars (towns + airport lot): static
    this.parked = [];
    const park = (p, yaw) => { const type = pickPark(); this.parked.push({ p, yaw, type, color: color(type) }); };
    // driveways / squares where the scenery lays them out; otherwise a few along each town's main street
    for (const sp of world.towns?.parkSpots || []) park(new THREE.Vector3(sp.x, 0, sp.z), sp.yaw);
    if (!world.towns?.parkSpots?.length) for (const t of world.net.towns) for (let k = 0; k < 26 * t.size; k++) {
      const side = new THREE.Vector3(-t.dir.z, 0, t.dir.x), along = (r() - 0.5) * 480 * t.size, off = (r() < 0.5 ? -1 : 1) * 5.6;
      park(t.c.clone().addScaledVector(t.dir, along).addScaledVector(side, off), Math.atan2(-t.dir.x, -t.dir.z) + (r() < 0.5 ? Math.PI : 0));
    }
    for (let row = 0; row < 4; row++) for (let k = 0; k < 16; k++) if (r() < 0.8) park(new THREE.Vector3(350 + row * 7, 0, 56 + k * 3.2), Math.PI / 2); // (the airport car park, x 346..376, z 52..112)
    // the fire station's crash tenders on its forecourt, facing out (airportBuildings.js FIRE: bays face -z)
    for (const dx of [-6.4, 6.4]) this.parked.push({ p: new THREE.Vector3(FIRE.x + dx, 0, FIRE.z - 15), yaw: 0, type: 'firetruck', color: 0xc8282e });
    // two spare baggage carts by the terminal
    for (let k = 0; k < 2; k++) this.parked.push({ p: new THREE.Vector3(268, 0, 88 + k * 3.3), yaw: 0, type: 'cart', color: 0xffffff });
    // airport ground vehicles driving around the apron: the fuel tanker, a yellow follow-me car and a tug pulling three
    // baggage carts (tow: the carts drawn along the path behind it)
    const apron = [[120, -128], [120, 128], [250, 128], [250, -128]].map(([x, z]) => new THREE.Vector3(x, 0, z)); // (between the stands' boxes: world.js STANDS)
    const ap = { pts: [], speed: 7, kind: 'apron' }; for (let i = 0; i < 4; i++) { const a = apron[i], b = apron[(i + 1) % 4]; for (let t = 0; t < 1; t += 0.02) ap.pts.push(a.clone().lerp(b, t)); }
    ap.len = []; let L = 0; ap.pts.forEach((q, i) => { if (i) L += q.distanceTo(ap.pts[i - 1]); ap.len.push(L); }); ap.total = L + ap.pts.at(-1).distanceTo(ap.pts[0]);
    this.cars.push({ path: ap, s: 0, v: 6, want: 7, type: 'tanker', color: 0xffffff, brake: 0, roll: 0 }, { path: ap, s: ap.total * 0.5, v: 6, want: 6, type: 'offroad', color: 0xf2b705, brake: 0, roll: 0 },
      { path: ap, s: ap.total * 0.25, v: 4, want: 4.5, type: 'tug', color: 0xffffff, brake: 0, roll: 0, tow: 3 });
    for (const c of this.parked) c.p.y = world.sampleGrid(c.p.x, c.p.z) + 0.03;
    this.drawDist = { low: 1200, medium: 1800, high: 3000 }[world.qBase] || 1800;
    this.lod = LOD[world.qBase] || LOD.medium;
    this.models = {}; // type -> meta (L, wheels, lights), once loaded
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
    // (ready: the cars' models are in, or failed: main.js holds the loading screen until then: frame)
    const M = trafficModelsNow();
    if (M !== undefined) { if (M) this.buildBatch(M); this.ready = true; }
    else { this.ready = false; trafficModels(world.qBase).then((M) => { if (M && !this.disposed) this.buildBatch(M); this.ready = true; }); }
  }
  model(type) { return this.models[type] || DEFAULT; }
  // the batch: every level of detail of every type that's used, and a fixed pool of instances re-dealt each frame
  buildBatch(M) {
    const used = new Set([...this.cars, ...this.parked].map((c) => c.type).filter((t) => M.geo[t]));
    let nv = 0, ni = 0; const geos = [];
    for (const t of used) { const g = M.geo[t]; for (const x of [...g.lod, ...g.wheels]) { geos.push(x); nv += x.attributes.position.count; ni += x.index.count; } }
    const q = this.world.qBase, bodies = { low: 260, medium: 420, high: 700 }[q] || 420, wheels = { low: 120, medium: 200, high: 320 }[q] || 200;
    const B = (this.batch = new THREE.BatchedMesh(bodies + wheels, nv, ni, M.material));
    B.frustumCulled = false; B.sortObjects = false; B.castShadow = q === 'high'; B.receiveShadow = true; this.world.nearShadow?.(B);
    this.gid = {};
    for (const t of used) { const g = M.geo[t]; this.gid[t] = { lod: g.lod.map((x) => B.addGeometry(x)), wheels: g.wheels.map((x) => B.addGeometry(x)) }; this.models[t] = M.meta[t]; }
    const g0 = this.gid[used.values().next().value].lod[0];
    this.slots = []; for (let i = 0; i < bodies + wheels; i++) { const k = B.addInstance(g0); B.setVisibleAt(k, false); this.slots.push(k); }
    this.nBodies = bodies;
    this.group.add(B);
    // a soft dark patch under each car (one more draw call for all of them): its contact with the road. Without it a
    // car on Low/Medium (no shadow maps) seems to hover; on High it's lighter, under the real shadow.
    const blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.15, 0); // (15 cm up: road meshes stand a little above the lane line the cars follow; still under every car's floor)
    const bm = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000, transparent: true, opacity: q === 'high' ? 0.5 : 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const blobs = (this.blobs = new THREE.InstancedMesh(blob, bm, bodies)); blobs.count = 0; blobs.frustumCulled = false; blobs.renderOrder = -1;
    this.group.add(blobs);
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
  update(dt, camPos) {
    this.t += dt;
    const W = this.world, night = W.night || W.W.dark > 0.5, B = this.batch;
    const m4 = this._m4 ??= new THREE.Matrix4(), w4 = this._w4 ??= new THREE.Matrix4(), q = this._q ??= new THREE.Quaternion(), p = this._p ??= new THREE.Vector3(), d = this._d ??= new THREE.Vector3(), one = this._one ??= new THREE.Vector3(1, 1, 1);
    const eu = this._eu ??= new THREE.Euler(), lv = this._lv ??= new THREE.Vector3(), col = this._col ??= new THREE.Color(), wp = this._wp ??= new THREE.Vector3(), wq = this._wq ??= new THREE.Quaternion(), X = this._X ??= new THREE.Vector3(1, 0, 0);
    const R2 = this.drawDist * this.drawDist, show = night ? 1 : 0, LP = this.lp, LC = this.lc, [d1, d2] = this.lod;
    let nl = 0; // lights written (packed: only the cars drawn this frame)
    const put = (lp, c0, c1, c2, on) => { const v = lv.set(lp[0], lp[1], lp[2]).applyQuaternion(q).add(p), o = nl * 3; LP[o] = v.x; LP[o + 1] = v.y; LP[o + 2] = v.z; LC[o] = c0 * on; LC[o + 1] = c1 * on; LC[o + 2] = c2 * on; nl++; };
    // instances: bodies from the front of the pool, wheels from the back (so a crowded frame drops wheels, not cars)
    this.nBlob = 0; this._bs ??= new THREE.Vector3(); this._b4 ??= new THREE.Matrix4();
    let nb = 0, nw = 0; const S = this.slots, NS = S ? S.length : 0, NW = NS - (this.nBodies || 0);
    const draw = (c, mdl, dist2) => {
      if (!B || nb >= NS - NW) return;
      const G = this.gid[c.type]; if (!G) return;
      const lod = dist2 < d1 * d1 ? 0 : dist2 < d2 * d2 ? 1 : 2, k = S[nb++];
      B.setGeometryIdAt(k, G.lod[lod]); B.setMatrixAt(k, m4); B.setColorAt(k, col.set(c.color)); B.setVisibleAt(k, true);
      if (lod < 2) { this._bs.set(mdl.W * 1.8, 1, mdl.L * 1.3); this._b4.makeScale(this._bs.x, 1, this._bs.z).premultiply(m4); this.blobs.setMatrixAt(this.nBlob++, this._b4); } // (far: too small to matter)
      if (lod === 0) for (let j = 0; j < mdl.wheels.length && nw < NW; j++) {
        const w = mdl.wheels[j], kw = S[NS - 1 - nw++];
        wq.setFromAxisAngle(X, -(c.roll || 0) / w[3]); wp.set(w[0], w[1], w[2]);
        w4.compose(wp, wq, one).premultiply(m4);
        B.setGeometryIdAt(kw, G.wheels[j]); B.setMatrixAt(kw, w4); B.setColorAt(kw, col); B.setVisibleAt(kw, true);
      }
    };
    // parked cars near the camera
    if (B && camPos) for (const c of this.parked) {
      const dd = (c.p.x - camPos.x) ** 2 + (c.p.z - camPos.z) ** 2; if (dd > R2) continue;
      q.setFromAxisAngle(this._Y ??= new THREE.Vector3(0, 1, 0), c.yaw); m4.compose(c.p, q, one);
      draw(c, this.model(c.type), dd);
    }
    for (const L of this.lanes) {
      const { path, list } = L;
      // car following along the lane
      if (list.length === 1) { const c = list[0], dv = clamp(c.want - c.v, -6 * dt, 2.2 * dt); c.brake = dv < -0.5 * dt ? 1 : Math.max(0, c.brake - dt * 2); c.v = Math.max(0, c.v + dv); c.s = (c.s + c.v * dt) % path.total; c.roll += c.v * dt; }
      else {
        list.sort((a, b) => a.s - b.s);
        for (let i = 0; i < list.length; i++) {
          const c = list[i], ahead = list[(i + 1) % list.length];
          const gap = (ahead.s - c.s + path.total) % path.total - this.model(ahead.type).L * 0.5 - this.model(c.type).L * 0.5;
          const want = Math.min(c.want, Math.max(0, (gap - 6) / 1.6));
          const dv = clamp(want - c.v, -6 * dt, 2.2 * dt);
          c.brake = dv < -0.5 * dt ? 1 : Math.max(0, c.brake - dt * 2);
          c.v = Math.max(0, c.v + dv); c.s = (c.s + c.v * dt) % path.total; c.roll += c.v * dt;
        }
      }
      if (camPos) { const dl = Math.hypot(L.cx - camPos.x, L.cz - camPos.z) - L.r; if (dl > this.drawDist) continue; } // the whole lane is too far to see: simulate only
      for (const c of list) {
        this.pathPoint(path, c.s, p, d);
        const dd = camPos ? (p.x - camPos.x) ** 2 + (p.z - camPos.z) ** 2 : 0;
        if (dd > R2) continue;
        const mdl = this.model(c.type);
        // pitch with the road's grade (no per-frame allocations: reuse eu)
        const yaw = Math.atan2(-d.x, -d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        q.setFromEuler(eu.set(pitch, yaw, 0, 'YXZ'));
        m4.compose(p, q, one); draw(c, mdl, dd);
        const tail = Math.max(show * 0.5, c.brake ? 1 : 0);
        if (show || tail) { put(mdl.head[0], 1, 0.95, 0.8, show); put(mdl.head[1], 1, 0.95, 0.8, show); put(mdl.tail[0], 1, 0.08, 0.04, tail); put(mdl.tail[1], 1, 0.08, 0.04, tail); }
        if (c.tow) { // the towed carts, each on the path behind the one ahead (3.3 m apart, drawbar included)
          const cm = this.model('cart'), cart = (this._cart ??= { type: 'cart', color: 0xffffff, roll: 0 });
          for (let k = 0; k < c.tow; k++) {
            this.pathPoint(path, c.s - mdl.L / 2 - 0.4 - cm.L * (k + 0.5) - 0.4 * k, p, d);
            q.setFromEuler(eu.set(0, Math.atan2(-d.x, -d.z), 0, 'YXZ')); m4.compose(p, q, one);
            draw(cart, cm, (p.x - (camPos?.x ?? p.x)) ** 2 + (p.z - (camPos?.z ?? p.z)) ** 2);
          }
        }
      }
    }
    // hide the instances dealt last frame but not this one
    if (B) {
      for (let i = nb; i < (this.nbLast || 0); i++) B.setVisibleAt(S[i], false);
      for (let i = nw; i < (this.nwLast || 0); i++) B.setVisibleAt(S[NS - 1 - i], false);
      this.nbLast = nb; this.nwLast = nw;
      const bl = this.blobs; bl.count = this.nBlob; if (this.nBlob) { bl.instanceMatrix.clearUpdateRanges(); bl.instanceMatrix.addUpdateRange(0, this.nBlob * 16); bl.instanceMatrix.needsUpdate = true; }
    }
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
  dispose() { this.disposed = true; this.group.parent?.remove(this.group); this.batch?.dispose(); this.blobs?.geometry.dispose(); this.blobs?.material.dispose(); this.blobs?.dispose(); }
}
