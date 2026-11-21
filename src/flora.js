// Vegetation, rocks and ground cover.
//  - Trees are built from alpha-tested cards textured with a photographic foliage atlas (assets/flora/foliage_*.webp,
//    assembled offline by tools/flora/build_atlas.py from CC0 Poly Haven leaf / twig / grass scans): spruce sprays,
//    leaf clusters, palm fronds, bark. Several variants and age classes per species, colour-varied per instance.
//  - Foliage shading: crown ambient occlusion baked into vertex colours (dark inside / underneath), light transmitted
//    through backlit leaves, trunk sway plus branch-tip flutter in the wind.
//  - Placement is streamed in 275 m cells around the camera from a deterministic candidate sequence:
//    cells near the camera evaluate all candidates (dense forest), far cells only the first few (a sparse
//    subset of the same trees), so nothing pops when a cell goes dense. Works on the endless outer tiles too.
//    Forest structure: clumps and clearings, smaller trees and shrubs at the edges, species zoned by altitude,
//    riparian trees along water, hedgerows around fields, lone field trees, palms along beaches, fallen logs.
//  - LOD: near (shadow casting) / mid (full model) / far: octahedral impostors -- every variant photographed from
//    up to 64 directions over the hemisphere (albedo + normals), blended between the three nearest views and lit
//    like the models, so distant forests look right from the side and from straight above. ONE draw call for all
//    of them. Models and impostors cross-fade with a dither.
//  - Ground cover: photo grass tufts, flowers, ferns under the trees / desert scrub in a ring around the camera.
// All generation is time-sliced (a few ms per frame) so streaming never hitches, even on a tablet.
//
// API for other systems (e.g. real-world land use):
//   flora.setForestMask(fn, bare?)  fn(x, z) -> 0..1 forest density (null: back to the built-in noise / world.forestAt);
//                            bare(x, z) -> true where nothing at all grows (a city's pavements)
//   flora.addTrees(list)     [{ x, z, kind?: 'conifer'|'broadleaf'|'palm'|'shrub'|..., scale? }] extra trees
//   flora.clearTrees()       remove everything added with addTrees
import * as THREE from 'three';
import { mulberry32, smoothstep } from './noise.js';
import { FOG } from './shaders.js';

const V3 = THREE.Vector3;
const CELL = 275; // 22000 / 80: cells tile the core map and the 5500 m outer tiles exactly
const STRIDE = 6; // per instance: x, y, z, scale, variant, yaw
const IMP_CH = 6; // impostor chunks: 6 x 6 cells (1650 m), each its own draw with a bounding sphere (frustum culled)
const SMALL_FAR = 1400; // shrubs, logs and stones vanish into the ground texture beyond this
const AT = 2048; // foliage atlas layout size (the 1024 version is the same layout scaled)
// atlas regions in AT pixels -- mirrored in tools/flora/build_atlas.py (REG)
const REG = {
  spray: [0, 0, 1024, 512], broad: [1024, 0, 512, 512], birch: [1536, 0, 512, 512],
  frond: [0, 512, 1024, 512], tropic: [1024, 512, 512, 512], fern: [1536, 512, 512, 512],
  grass: [0, 1024, 1024, 256], flower: [0, 1280, 512, 256], scrub: [512, 1280, 512, 256],
  bark: [1024, 1024, 512, 512], birchbark: [1536, 1024, 256, 512], pine: [0, 1536, 1024, 512],
  juniper: [1024, 1536, 512, 512], white: [1984, 1984, 64, 64],
};
// [u0, v0, u1, v1]; the texture is not flipped, so v0 is the top row of the region
const UV = Object.fromEntries(Object.entries(REG).map(([k, [x, y, w, h]]) => [k, [(x + 2) / AT, (y + 2) / AT, (x + w - 2) / AT, (y + h - 2) / AT]]));
UV.whiteP = [(1984 + 32) / AT, (1984 + 32) / AT];

// cand: candidates per dense cell, base: per far cell, dense / far: radii (m), lo: model -> impostor distance,
// near: shadow-casting model radius, budget: ms per frame, imp: impostor buffer, oct: impostor views per axis, cs: px per view
const TIER = {
  low: { cand: 450, base: 40, dense: 1300, far: 5000, lo: 150, near: 90, budget: 2, imp: 60000, oct: 4, cs: 64, atlas: 1024 },
  medium: { cand: 800, base: 60, dense: 2000, far: 6000, lo: 190, near: 120, budget: 3, imp: 120000, oct: 6, cs: 48, atlas: 1024 },
  high: { cand: 1700, base: 150, dense: 3200, far: 9500, lo: 270, near: 160, budget: 5, imp: 350000, oct: 8, cs: 80, atlas: 2048 },
  ultra: { cand: 2400, base: 240, dense: 4200, far: 12000, lo: 380, near: 220, budget: 7, imp: 600000, oct: 8, cs: 112, atlas: 2048 },
};
const GRASS = { low: null, medium: { R: 60, per: 1 / 1.2, cap: 16000, agl: 120 }, high: { R: 110, per: 1 / 0.55, cap: 110000, agl: 200 }, ultra: { R: 150, per: 1 / 0.4, cap: 240000, agl: 260 } };

// ---------------------------------------------------------------- photographic foliage atlas
const ATLASES = {};
function foliageAtlas(size) {
  if (ATLASES[size]) return ATLASES[size];
  const tex = new THREE.Texture();
  tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 8;
  const A = (ATLASES[size] = { tex, ready: false });
  if (typeof Image === 'undefined') return A;
  const img = new Image(); img.decoding = 'async';
  img.onload = () => { tex.image = img; tex.needsUpdate = true; A.ready = true; };
  img.onerror = () => { tex.image = fallbackAtlas(); tex.needsUpdate = true; A.ready = true; };
  img.src = new URL(`../assets/flora/foliage_${size}.webp`, import.meta.url).href;
  return A;
}
// started at import so the picture is decoded long before the first flight starts
foliageAtlas(typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 1024 : 2048);
// if the atlas can't be loaded (offline before it was ever cached): blotchy silhouettes, so trees still read as trees
function fallbackAtlas() {
  const S = 512, k = S / AT, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), r = mulberry32(7);
  for (const [name, [x, y, w, h]] of Object.entries(REG)) {
    const bark = name.includes('bark'), col = name === 'white' ? '#fff' : name === 'birchbark' ? '#ddd8cc' : bark ? '#5a4a3c' : '#4d6b2e';
    g.fillStyle = col;
    if (bark || name === 'white') { g.fillRect(x * k, y * k, w * k, h * k); continue; }
    for (let i = 0; i < 60; i++) { g.beginPath(); g.arc((x + w * (0.15 + r() * 0.7)) * k, (y + h * (0.2 + r() * 0.6)) * k, Math.min(w, h) * k * (0.04 + r() * 0.06), 0, 7); g.fill(); }
  }
  return cv;
}

// ---------------------------------------------------------------- geometry building
class GB {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.w = []; this.i = []; }
  v(p, n, u, v, c, w = 0) { this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.t.push(u, v); this.c.push(c.r, c.g, c.b); this.w.push(w); return this.p.length / 3 - 1; }
  // a three.js geometry, vertex coloured; uv: a REG name to map its own uvs into (bark), or the solid white texel
  geo(g, colFn, uv = null, vRep = 1, wind = 0) {
    const base = this.p.length / 3, P = g.attributes.position, N = g.attributes.normal, T = g.attributes.uv, c = new THREE.Color();
    for (let k = 0; k < P.count; k++) {
      this.p.push(P.getX(k), P.getY(k), P.getZ(k)); this.n.push(N.getX(k), N.getY(k), N.getZ(k));
      if (uv && T) { const R = UV[uv]; this.t.push(R[0] + (R[2] - R[0]) * T.getX(k), R[1] + (R[3] - R[1]) * ((T.getY(k) * vRep) % 1.0001)); } else this.t.push(UV.whiteP[0], UV.whiteP[1]);
      colFn(c, P.getX(k), P.getY(k), P.getZ(k)); this.c.push(c.r, c.g, c.b); this.w.push(wind);
    }
    if (g.index) for (const k of g.index.array) this.i.push(base + k); else for (let k = 0; k < P.count; k++) this.i.push(base + k);
  }
  // a strip card along a spine: u runs along the spine, v across (left -> right)
  card(pts, side, widths, uv, colFn, nrmFn, windFn) {
    const c = new THREE.Color(), q = new V3(); let prev = null;
    pts.forEach((p, k) => {
      const t = k / (pts.length - 1), u = uv[0] + (uv[2] - uv[0]) * t, w = widths[k] / 2, wd = windFn ? windFn(t) : t;
      const L = q.copy(p).addScaledVector(side, -w), a = this.v(L, nrmFn(L), u, uv[1], colFn(c, L, t), wd);
      const R = q.copy(p).addScaledVector(side, w), b = this.v(R, nrmFn(R), u, uv[3], colFn(c, R, t), wd);
      if (prev) this.i.push(prev[0], a, prev[1], prev[1], a, b);
      prev = [a, b];
    });
  }
  // a free quad centred at p with axes ax/ay (half extents included)
  quad(p, ax, ay, uv, col, nrmFn, wind = 0.5) { // -ay edge maps to the bottom of the atlas region
    const q = new V3();
    const k = [[-1, -1, uv[0], uv[3]], [1, -1, uv[2], uv[3]], [1, 1, uv[2], uv[1]], [-1, 1, uv[0], uv[1]]]
      .map(([sx, sy, u, v]) => { q.copy(p).addScaledVector(ax, sx).addScaledVector(ay, sy); return this.v(q, nrmFn(q), u, v, col, wind * (0.6 + 0.4 * (sy + 1) / 2)); });
    this.i.push(k[0], k[1], k[2], k[0], k[2], k[3]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('wind', new THREE.Float32BufferAttribute(this.w, 1));
    g.setIndex(this.i); g.computeBoundingBox(); g.computeBoundingSphere(); return g;
  }
}
function limb(a, b, r0, r1, seg = 5) {
  const len = a.distanceTo(b), g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), new V3().subVectors(b, a).normalize())); g.translate(a.x, a.y, a.z); return g;
}
const randUnit = (r, v = new V3()) => { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return v.set(s * Math.cos(a), z, s * Math.sin(a)); };
const perp = (n) => { const a = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0); return new V3().crossVectors(n, a).normalize(); };
const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const barkCol = (col) => (c, x, y) => c.copy(col).multiplyScalar(0.55 + 0.45 * Math.min(1, y / 3)); // darker at the root (soil, moss)
// a cluster of leaf cards facing every way (broadleaf crowns, junipers, shrubs). ao(p) -> 0..1 how exposed the spot is
function cluster(b, r, c0, s, n, uv, tint, ao, nrm, wind = 0.7) {
  const col = new THREE.Color(), p = new V3(), nn = new V3();
  for (let q = 0; q < n; q++) {
    p.copy(c0).addScaledVector(randUnit(r), s * 0.45);
    randUnit(r, nn); nn.y = Math.abs(nn.y) * 0.7 + 0.25; nn.normalize();
    const ax = perp(nn), ay = new V3().crossVectors(nn, ax), sz = s * (0.6 + r() * 0.25), rot = r() * Math.PI;
    const ax2 = ax.clone().multiplyScalar(Math.cos(rot)).addScaledVector(ay, Math.sin(rot)).multiplyScalar(sz), ay2 = new V3().crossVectors(nn, ax2);
    col.copy(tint).multiplyScalar(0.18 + 0.95 * ao(p) * (0.9 + r() * 0.2));
    b.quad(p, ax2, ay2, uv, col, nrm, wind);
  }
}

const SPECIES = {
  // Norway spruce / fir: whorls of drooping branch sprays around a dark inner cone. o.young: dense small cone,
  // o.krumm: wind-stunted treeline shrub, o.larch: open crown of light-green pine sprays
  spruce(r, o = {}) {
    const b = new GB(), H = (o.h || 19) + r() * (o.hv ?? 11), Rm = H * (o.w || 0.2) * (0.85 + r() * 0.3), base = H * (o.base ?? (0.04 + r() * 0.12));
    const tint = lin(...(o.tint || [0.4, 0.46, 0.42])), cy = H * 0.4, tmp = new V3(), uvS = o.larch ? UV.pine : UV.spray;
    const nrm = (p) => tmp.set(p.x, (p.y - cy) * 0.3 + Rm * 0.5, p.z).normalize();
    b.geo(limb(new V3(), new V3(0, H * 0.97, 0), H * 0.017 + 0.12, 0.05, 7), barkCol(lin(0.62, 0.52, 0.46)), 'bark', 3);
    if (!o.larch) b.geo(new THREE.ConeGeometry(Rm * 0.55, H * 0.86 - base, 8, 1, true).translate(0, base + (H * 0.86 - base) / 2 + 0.5, 0), (c) => c.setRGB(0.05, 0.075, 0.045));
    const nW = (o.larch ? 10 : 13) + Math.floor(r() * 4);
    for (let w = 0; w < nW; w++) {
      const t = w / (nW - 1), y = base + 0.8 + (H * 0.95 - base - 0.8) * Math.pow(t, 0.95);
      const L = Rm * Math.pow(1 - t, o.krumm ? 0.5 : 0.95) * (0.8 + r() * 0.4) + 0.7, nb = t > 0.85 ? 3 : (o.larch ? 5 : 7) + (r() < 0.5 ? 1 : 0);
      const droop = (o.larch ? 0.05 : 0.12) + 0.35 * (1 - t);
      for (let k = 0; k < nb; k++) {
        const a = (k / nb) * Math.PI * 2 + w * 2.4 + r() * 0.6, dir = new V3(Math.cos(a), 0, Math.sin(a)), Lk = L * (0.8 + r() * 0.35);
        const p0 = dir.clone().multiplyScalar(0.15).setY(y), p1 = dir.clone().multiplyScalar(Lk * 0.5).setY(y + Lk * (0.05 - droop * 0.25)), p2 = dir.clone().multiplyScalar(Lk).setY(y - Lk * droop + Lk * 0.04);
        // alternate flat and steeply rolled (hanging) sprays, so the crown reads as solid from the side as well as from above
        const roll = (k % 2 ? (r() < 0.5 ? -1 : 1) * (0.9 + r() * 0.4) : (r() - 0.5) * 0.8), side = new V3(-dir.z, 0, dir.x).multiplyScalar(Math.cos(roll)).add(new V3(0, Math.sin(roll), 0));
        const wd = Lk * (o.larch ? 0.75 : 0.95);
        // crown AO: lower whorls and the inner part of each spray are shaded by the rest of the tree
        const ao = 0.4 + 0.6 * Math.pow(t, 0.7), tf = 0.85 + r() * 0.3;
        b.card([p0, p1, p2], side, [wd * 0.7, wd, wd * 0.8], uvS, (c, p, s) => c.copy(tint).multiplyScalar(tf * (0.32 + 0.68 * ao * (0.45 + 0.55 * s))), nrm, (s) => s * (0.4 + 0.6 * (1 - t)));
      }
    }
    for (let k = 0; k < 2; k++) { // leader
      const a = k * Math.PI / 2, side = new V3(Math.cos(a), 0, Math.sin(a));
      b.card([new V3(0, H * 0.84, 0), new V3(0, H * 1.03, 0)], side, [H * 0.07, H * 0.05], uvS, (c) => c.copy(tint).multiplyScalar(1.05), nrm, () => 0.5);
    }
    return { geo: b.build(), H, R: Rm, sway: o.krumm ? 0.1 : 0.22 };
  },
  // deciduous tree: trunk + limbs carrying leaf clusters; o.birch: slender white trunk, small light leaves
  broadleaf(r, o = {}) {
    const b = new GB(), H = (o.h || 12) + r() * (o.hv ?? 6), top = new V3((r() - 0.5), H * (o.birch ? 0.45 : 0.42), (r() - 0.5));
    const birch = !!o.birch, bark = birch ? barkCol(lin(1, 1, 1)) : barkCol(lin(0.55, 0.48, 0.42)), bUV = birch ? 'birchbark' : 'bark';
    b.geo(limb(new V3(), top, H * 0.035 + 0.15, H * 0.02, 7), bark, bUV, 2);
    const nb = 5 + Math.floor(r() * 3), ends = [];
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + r(), el = 0.45 + r() * 0.65, L = H * (0.27 + r() * 0.17) * (o.spread || 1);
      const start = top.clone().setY(top.y * (0.8 + r() * 0.2)), end = top.clone().add(new V3(Math.cos(a) * Math.cos(el) * L, Math.sin(el) * L, Math.sin(a) * Math.cos(el) * L));
      b.geo(limb(start, end, H * 0.02, H * 0.008, 5), bark, bUV, 1, 0.2); ends.push(end);
      // secondary branches spread the foliage through the whole crown volume
      const mid = start.clone().lerp(end, 0.55 + r() * 0.2), a2 = a + (r() - 0.5) * 1.6, L2 = L * 0.5;
      const e2 = mid.clone().add(new V3(Math.cos(a2) * L2, (0.1 + r() * 0.4) * L2, Math.sin(a2) * L2));
      b.geo(limb(mid, e2, H * 0.009, H * 0.004, 4), bark, bUV, 1, 0.4); ends.push(e2);
    }
    ends.push(top.clone().setY(H * 0.86), top.clone().add(new V3((r() - 0.5) * H * 0.3, H * 0.2, (r() - 0.5) * H * 0.3)));
    const cen = new V3(0, H * 0.66, 0), Rc = H * 0.36 * (o.spread || 1), tint = lin(...(o.tint || [0.48, 0.52, 0.36])), tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY((p.y - cen.y) + Rc * 0.45).normalize();
    const ao = (p) => Math.min(1, 0.25 + 0.55 * Math.min(1, tmp.subVectors(p, cen).length() / Rc) + 0.45 * Math.max(0, (p.y - cen.y) / Rc + 0.3));
    const uv = o.uv || (birch ? UV.birch : UV.broad);
    for (const c0 of ends) { const s = H * (0.22 + r() * 0.08) * (birch ? 0.8 : 1); cluster(b, r, c0, s * 1.5, birch ? 5 : 6, uv, tint, ao, nrm); }
    return { geo: b.build(), H, R: Rc, sway: birch ? 0.35 : 0.28 };
  },
  juniper(r, o = {}) { // small gnarled desert conifer: short twisted stems, blue-green spray clumps
    const b = new GB(), H = (o.h || 3) + r() * 4, tint = lin(...(o.tint || [0.62, 0.66, 0.6])), cen = new V3(0, H * 0.55, 0), Rc = H * 0.45, tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY(p.y - cen.y + Rc * 0.5).normalize();
    const ao = (p) => Math.min(1, 0.3 + 0.6 * Math.min(1, tmp.subVectors(p, cen).length() / Rc) + 0.3 * Math.max(0, (p.y - cen.y) / Rc));
    for (let k = 0; k < 2; k++) b.geo(limb(new V3(), new V3((r() - 0.5) * H * 0.4, H * 0.5, (r() - 0.5) * H * 0.4), 0.18, 0.08, 5), barkCol(lin(0.6, 0.5, 0.42)), 'bark', 1);
    const n = 6 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) { const c0 = randUnit(r).multiply(new V3(Rc * 0.7, Rc * 0.55, Rc * 0.7)).add(cen); cluster(b, r, c0, H * 0.38, 4, UV.juniper, tint, ao, nrm, 0.4); }
    return { geo: b.build(), H, R: Rc, sway: 0.12 };
  },
  palm(r) {
    // ringed trunk (leaf scars every ~35 cm, a flared base, slightly curved), 18 drooping fronds with a darker rachis,
    // frond boots and a coconut cluster where they meet
    const b = new GB(), H = 8 + r() * 9, bend = (r() - 0.5) * 4, segs = Math.round(H / 0.36);
    let prev = new V3();
    const trunkCol = (c, x, y) => c.setRGB(0.78, 0.72, 0.62).multiplyScalar(0.62 + 0.25 * Math.sin(y * 5.3) ** 2 + 0.13 * Math.min(1, y / 2));
    for (let k = 1; k <= segs; k++) {
      const t = k / segs, p = new V3(bend * t * t, H * t, bend * 0.3 * t * t), rad = 0.24 - 0.08 * t + 0.16 * Math.max(0, 1 - t * 9) ** 2;
      b.geo(limb(prev, p, rad + 0.025, rad - 0.01, 10), trunkCol, 'bark', 1, t * 0.3); prev = p; // each segment wider at its foot: a ring
    }
    const crown = prev, tint = lin(0.66, 0.74, 0.46), col = new THREE.Color(), up = new V3(0, 1, 0);
    for (let k = 0; k < 7; k++) { const a = k * 0.9; b.geo(new THREE.SphereGeometry(0.28, 8, 6).scale(1, 1.6, 1).translate(crown.x + Math.cos(a) * 0.18, crown.y - 0.25 - k * 0.04, crown.z + Math.sin(a) * 0.18), (c) => c.setRGB(0.42, 0.33, 0.2)); } // frond boots
    const nF = 18;
    for (let f = 0; f < nF; f++) {
      const old = f >= 14, a = (f / nF) * Math.PI * 2 * 1.618 + r() * 0.3, len = (old ? 3.6 : 4.6) + r() * 2.2, dk = old ? 1.4 + r() * 0.5 : 0.5 + r() * 0.6, rise = old ? 0 : 0.3 + r() * 0.35;
      const dir = new V3(Math.cos(a), 0, Math.sin(a)), side = new V3(-dir.z, 0, dir.x), uv = UV.frond, n = 10, twist = (r() - 0.5) * 0.5;
      let row = null;
      for (let k = 0; k <= n; k++) {
        const t = k / n, c = crown.clone().addScaledVector(dir, len * t).addScaledVector(up, len * (rise * t - dk * t * t)), w = 1.3 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) + 0.08;
        const sd = side.clone().applyAxisAngle(dir, twist * t), nr = dir.clone().multiplyScalar(0.4).add(up).normalize(), u = uv[0] + (uv[2] - uv[0]) * t;
        col.copy(tint).multiplyScalar((old ? 0.45 : 0.6) + 0.42 * t); if (old) col.lerp(lin(0.52, 0.42, 0.24), 0.55); // the lowest fronds are dying back
        const fold = 0.42 * w; // the leaflets hang down either side of the rachis (a V section)
        const L = c.clone().addScaledVector(sd, -w).addScaledVector(up, -fold), M = c.clone().addScaledVector(up, 0.05), R = c.clone().addScaledVector(sd, w).addScaledVector(up, -fold);
        const ids = [b.v(L, nr, u, uv[1], col, t), b.v(M, nr, u, (uv[1] + uv[3]) / 2, col.clone().multiplyScalar(0.8), t * 0.8), b.v(R, nr, u, uv[3], col, t)];
        if (row) b.i.push(row[0], ids[0], row[1], row[1], ids[0], ids[1], row[1], ids[1], row[2], row[2], ids[1], ids[2]);
        row = ids;
      }
    }
    for (let k = 0; k < 6; k++) b.geo(new THREE.SphereGeometry(0.17, 8, 6).translate(crown.x + (r() - 0.5) * 0.55, crown.y - 0.42 - r() * 0.2, crown.z + (r() - 0.5) * 0.55), (c) => c.setRGB(0.3 + r() * 0.15, 0.24, 0.08)); // coconuts
    return { geo: b.build(), H: H + 1.5, R: 4.8, sway: 0.5 };
  },
  saguaro(r) {
    const b = new GB(), H = 6 + r() * 6, col = (c, x, y, z) => c.setRGB(0.085, 0.11, 0.07).multiplyScalar(0.85 + 0.3 * Math.cos(Math.atan2(z, x) * 12));
    b.geo(new THREE.CapsuleGeometry(0.42, H - 0.8, 2, 10).translate(0, H / 2, 0), col);
    const arms = 1 + Math.floor(r() * 3);
    for (let k = 0; k < arms; k++) {
      const a = r() * Math.PI * 2, y0 = H * (0.35 + r() * 0.3), out = 1.1 + r() * 0.5, up = 1.5 + r() * 2;
      b.geo(new THREE.CapsuleGeometry(0.3, out, 2, 6).rotateZ(Math.PI / 2).translate(out / 2, 0, 0).rotateY(a).translate(0, y0, 0), col);
      b.geo(new THREE.CapsuleGeometry(0.3, up, 2, 6).translate(Math.cos(a) * out, y0 + up / 2, -Math.sin(a) * out), col);
    }
    return { geo: b.build(), H, R: 1.2, sway: 0 };
  },
  shrub(r, o = {}) {
    const b = new GB(), s = (o.s || 1.2) + r() * 1.0, tint = lin(...(o.tint || [0.7, 0.72, 0.5])), cen = new V3(0, s * 0.4, 0), tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY(p.y - cen.y + s * 0.6).normalize(), col = new THREE.Color();
    const ao = (p) => Math.min(1, 0.3 + 0.5 * Math.min(1, tmp.subVectors(p, cen).length() / s) + 0.4 * Math.max(0, (p.y - cen.y) / s));
    if (o.scrub) { // crossed vertical cards with the twiggy scrub texture
      for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI + r() * 0.3, ax = new V3(Math.cos(a) * s, 0, Math.sin(a) * s); b.quad(new V3(0, s * 0.6, 0), ax, new V3(0, s * 0.6, 0), UV.scrub, col.copy(tint), nrm, 0.4); }
    } else for (let k = 0; k < 4; k++) cluster(b, r, new V3((r() - 0.5) * s, s * (0.35 + r() * 0.2), (r() - 0.5) * s), s * 1.1, 4, o.uv || UV.broad, tint, ao, nrm);
    return { geo: b.build(), H: s * 1.2, R: s, sway: 0.15, small: true };
  },
  dead(r) {
    const b = new GB(), H = 6 + r() * 7, top = new V3(0, H * 0.6, 0), bark = barkCol(lin(0.75, 0.7, 0.66));
    b.geo(limb(new V3(), top, 0.25, 0.12, 6), bark, 'bark', 1);
    for (let k = 0; k < 6; k++) { const a = r() * 6.28, e = top.clone().add(new V3(Math.cos(a) * 2.5, 1 + r() * 3, Math.sin(a) * 2.5)); b.geo(limb(top.clone().setY(top.y * (0.5 + r() * 0.5)), e, 0.1, 0.03, 4), bark, 'bark', 1); }
    return { geo: b.build(), H, R: 2.5, sway: 0 };
  },
  log(r) { // fallen trunk with a few snapped branch stubs, half sunk into the forest floor
    const b = new GB(), L = 6 + r() * 8, R0 = 0.22 + r() * 0.2, bark = (c, x) => c.setRGB(0.55, 0.5, 0.42).multiplyScalar(0.7 + 0.3 * Math.sin(x * 1.3));
    b.geo(limb(new V3(-L / 2, R0 * 0.6, 0), new V3(L / 2, R0 * 0.5, 0), R0, R0 * 0.6, 7), bark, 'bark', 2);
    for (let k = 0; k < 4; k++) { const x = (r() - 0.5) * L * 0.8, a = r() * 6.28; b.geo(limb(new V3(x, R0, 0), new V3(x + 0.3, R0 + Math.cos(a) * 1.2, Math.sin(a) * 1.2), 0.06, 0.03, 4), bark, 'bark', 1); }
    return { geo: b.build(), H: R0 * 2, R: L / 2, sway: 0, small: true, noHit: true };
  },
  rock(r, o = {}) {
    const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position, d = new V3();
    const ph = [r() * 6, r() * 6, r() * 6, r() * 6], sx = 1.1 + r() * 0.5, sy = 0.55 + r() * 0.35;
    for (let i = 0; i < P.count; i++) { // smooth function of direction so shared corners stay welded
      d.set(P.getX(i), P.getY(i), P.getZ(i)).normalize();
      const k = 1 + 0.22 * Math.sin(d.x * 3.1 + ph[0]) * Math.cos(d.z * 2.7 + ph[1]) + 0.14 * Math.sin(d.y * 5.3 + d.x * 4 + ph[2]) + 0.08 * Math.sin(d.z * 9 + ph[3]);
      P.setXYZ(i, d.x * k * sx, Math.max(-0.3, d.y * k * sy), d.z * k);
    }
    g.translate(0, 0.15, 0); g.computeVertexNormals(); // non-indexed: faceted
    const uv = new Float32Array(P.count * 2), col = new Float32Array(P.count * 3), N = g.attributes.normal, tint = lin(...(o.tint || [1, 1, 1])), c = new THREE.Color();
    const moss = o.moss ? lin(...o.moss) : null;
    for (let i = 0; i < P.count; i += 3) { // box mapping per face
      const nx = Math.abs(N.getX(i)), ny = Math.abs(N.getY(i)), nz = Math.abs(N.getZ(i));
      for (let j = i; j < i + 3; j++) {
        const x = P.getX(j), y = P.getY(j), z = P.getZ(j);
        const [u, v] = ny > nx && ny > nz ? [x, z] : nx > nz ? [z, y] : [x, y];
        uv[j * 2] = u * 0.18 + ph[0]; uv[j * 2 + 1] = v * 0.18 + ph[1];
        c.copy(tint).multiplyScalar(0.75 + 0.3 * N.getY(i)); // dark crevices underneath
        if (moss) c.lerp(moss, smoothstep(0.35, 0.8, N.getY(i)) * (0.55 + 0.4 * Math.sin(x * 3 + ph[2]) * Math.sin(z * 2.6 + ph[3])));
        col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(P.count), 1)); g.computeBoundingBox(); g.computeBoundingSphere();
    return { geo: g, H: 0.9 * sy + 0.15, R: sx, rock: true, sway: 0 };
  },
};

// ---------------------------------------------------------------- biomes
// Which species grow where. dens(e) = chance per candidate (summed over species); e: { h, s (slope), F (forest 0..1),
// C (canopy clumping 0..1), E (forest edge 0..1), wl (height above water), open (1 - F) }.
// kind: what addTrees({kind}) maps to.
function biome(loc, wl) {
  const sn = loc.snowline;
  if (loc.id === 'alpine') {
    // zonation: mixed broadleaf in the valley -> spruce -> larch -> krummholz -> rock and snow
    const tl = sn - 170, z = (e, a, b, c, d) => smoothstep(a, b, e.h) * (1 - smoothstep(c, d, e.h)), ok = (s, a = 0.3, b = 0.5) => 1 - smoothstep(a, b, s);
    return [
      { sp: 'spruce', kind: 'conifer', variants: 4, dens: (e) => e.F * e.C * 1.05 * z(e, -1e3, -1e3, tl - 420, tl - 180) * (0.55 + 0.45 * smoothstep(200, 450, e.h)) * ok(e.s, 0.3, 0.5) },
      { sp: 'spruce', opts: { h: 7, hv: 6, w: 0.28, base: 0.02, tint: [0.46, 0.52, 0.42] }, variants: 2, dens: (e) => (e.E * 0.55 + e.F * (1 - e.C) * 0.25) * z(e, -1e3, -1e3, tl - 250, tl - 80) * ok(e.s) },
      { sp: 'spruce', opts: { larch: true, h: 17, w: 0.17, tint: [0.62, 0.66, 0.4] }, variants: 2, dens: (e) => (e.F * 0.35 + 0.02) * z(e, tl - 520, tl - 380, tl - 120, tl) * ok(e.s, 0.45, 0.65) },
      { sp: 'spruce', opts: { krumm: true, h: 1.8, hv: 2, w: 0.5, base: 0, tint: [0.42, 0.48, 0.4] }, variants: 2, dens: (e) => (0.1 + e.F * 0.4) * z(e, tl - 240, tl - 120, tl + 20, tl + 110) * ok(e.s, 0.5, 0.7) },
      { sp: 'broadleaf', kind: 'broadleaf', opts: { tint: [0.4, 0.47, 0.3] }, variants: 3, dens: (e) => (e.F * e.C * 0.55 + e.open * 0.006 + 0.5 * e.riv) * (1 - smoothstep(380, 600, e.h)) * ok(e.s, 0.25, 0.4) },
      { sp: 'broadleaf', opts: { birch: true, h: 9, tint: [0.56, 0.6, 0.38] }, variants: 2, dens: (e) => (e.E * 0.15 + 0.015 + 0.2 * e.riv) * (1 - smoothstep(550, 800, e.h)) * ok(e.s, 0.25, 0.4) },
      { sp: 'shrub', kind: 'shrub', opts: { uv: UV.birch, tint: [0.46, 0.52, 0.34] }, variants: 2, dens: (e) => (0.03 + e.E * 0.25 + e.F * 0.06) * (1 - smoothstep(sn - 100, sn, e.h)) * ok(e.s, 0.4, 0.6) },
      { sp: 'log', variants: 2, denseOnly: true, dens: (e) => e.F * e.C * 0.02 * (1 - smoothstep(tl - 200, tl, e.h)) * ok(e.s) },
      { sp: 'dead', variants: 1, dens: (e) => (0.002 + e.F * 0.005) * z(e, 300, 500, tl - 50, tl + 50) },
      { sp: 'rock', opts: { tint: [0.34, 0.35, 0.4], moss: [0.16, 0.2, 0.08] }, variants: 3, rock: true, dens: (e) => (0.02 + 0.22 * smoothstep(0.22, 0.5, e.s) + 0.12 * smoothstep(sn - 500, sn - 200, e.h) + e.F * 0.015) * (1 - smoothstep(sn - 120, sn + 40, e.h)) },
    ];
  }
  if (loc.id === 'islands') {
    const ok = (s, a = 0.45, b = 0.65) => 1 - smoothstep(a, b, s);
    return [
      // coconut palms: groves along the beaches, scattered inland
      { sp: 'palm', kind: 'palm', variants: 5, dens: (e) => (0.75 * smoothstep(0.8, 2, e.wl) * (1 - smoothstep(14, 40, e.wl)) * (0.35 + 0.65 * e.C) + e.F * 0.1 * (1 - smoothstep(40, 90, e.wl)) + e.open * 0.01) * ok(e.s, 0.3, 0.5) },
      // rainforest canopy: big-leaved trees, dense, with smaller understorey trees at the edges
      { sp: 'broadleaf', kind: 'broadleaf', opts: { h: 14, hv: 8, spread: 1.15, uv: UV.tropic, tint: [0.42, 0.55, 0.36] }, variants: 3, dens: (e) => (e.F * (0.5 + 0.6 * e.C) + 0.02) * smoothstep(6, 16, e.wl) * ok(e.s) },
      { sp: 'broadleaf', opts: { h: 9, hv: 4, uv: UV.broad, tint: [0.44, 0.56, 0.34] }, variants: 2, dens: (e) => (e.E * 0.5 + e.F * 0.25 + 0.01) * smoothstep(4, 10, e.wl) * ok(e.s) },
      { sp: 'shrub', kind: 'shrub', opts: { uv: UV.tropic, tint: [0.44, 0.58, 0.36] }, variants: 2, dens: (e) => (0.07 + e.E * 0.3) * smoothstep(1.5, 4, e.wl) * ok(e.s, 0.5, 0.7) },
      { sp: 'rock', opts: { tint: [0.4, 0.38, 0.37], moss: [0.2, 0.26, 0.1] }, variants: 2, rock: true, dens: (e) => 0.008 + 0.25 * smoothstep(0.3, 0.55, e.s) },
    ];
  }
  if (loc.id === 'rim') {
    // the Grand Canyon (real altitudes): open ponderosa pine forest on the rims, pinyon-juniper woodland below
    // ~2150 m and on the canyon's upper terraces, then sparse desert scrub down to the river. No saguaros here.
    const z = (e, a, b, c, d) => smoothstep(a, b, e.h) * (1 - smoothstep(c, d, e.h)), ok = (s, a = 0.3, b = 0.5) => 1 - smoothstep(a, b, s);
    return [
      { sp: 'spruce', kind: 'conifer', opts: { larch: true, h: 17, hv: 13, w: 0.2, base: 0.32, tint: [0.42, 0.47, 0.3] }, variants: 3, dens: (e) => e.F * (0.3 + 0.7 * e.C) * 0.85 * z(e, 1950, 2150, 9e3, 9e3) * ok(e.s, 0.3, 0.5) },
      { sp: 'juniper', opts: { tint: [0.78, 0.82, 0.62] }, variants: 3, dens: (e) => (0.015 + e.F * 0.5 * (0.4 + 0.6 * e.C)) * z(e, 1150, 1350, 2150, 2400) * ok(e.s, 0.35, 0.55) },
      { sp: 'juniper', opts: { h: 4, tint: [0.62, 0.7, 0.48] }, variants: 2, dens: (e) => e.F * 0.3 * z(e, 1500, 1700, 2250, 2450) * ok(e.s, 0.35, 0.55) },
      { sp: 'shrub', kind: 'shrub', opts: { scrub: true, s: 0.8, tint: [0.72, 0.72, 0.56] }, variants: 2, dens: (e) => (0.06 + 0.25 * e.F) * ok(e.s, 0.35, 0.6) },
      { sp: 'dead', variants: 1, dens: (e) => 0.003 * z(e, 1900, 2100, 9e3, 9e3) },
      { sp: 'rock', opts: { tint: [0.95, 0.8, 0.68] }, variants: 4, rock: true, dens: (e) => 0.003 + 0.05 * smoothstep(0.3, 0.6, e.s) }, // pale Kaibab limestone / sandstone
    ];
  }
  // desert: pinyon-juniper woodland on the mesas, saguaro and scrub on the flats, cottonwoods along the river
  const flat =(s, a = 0.22, b = 0.38) => 1 - smoothstep(a, b, s);
  return [
    { sp: 'saguaro', variants: 3, dens: (e) => 0.05 * flat(e.s) * (1 - e.riv) },
    { sp: 'juniper', kind: 'conifer', opts: { tint: [0.95, 0.9, 0.66] }, variants: 3, dens: (e) => (0.03 + e.F * 0.3 * (0.4 + 0.6 * e.C)) * flat(e.s, 0.3, 0.45) },
    { sp: 'juniper', opts: { h: 5, tint: [0.85, 0.85, 0.6] }, variants: 2, dens: (e) => e.F * 0.12 * flat(e.s, 0.3, 0.45) },
    { sp: 'shrub', kind: 'shrub', opts: { scrub: true, s: 1.2, tint: [0.72, 0.72, 0.58] }, variants: 2, dens: (e) => 0.4 * flat(e.s, 0.25, 0.4) },
    { sp: 'dead', variants: 1, dens: (e) => 0.006 * flat(e.s) },
    { sp: 'broadleaf', kind: 'broadleaf', opts: { h: 13, spread: 1.2, tint: [0.56, 0.6, 0.34] }, variants: 3, dens: (e) => (0.9 * e.riv + 0.004 * e.open) * flat(e.s, 0.25, 0.4) },
    { sp: 'rock', opts: { tint: [0.85, 0.7, 0.62] }, variants: 4, rock: true, dens: (e) => 0.05 + 0.3 * smoothstep(0.2, 0.5, e.s) },
  ];
}

// ---------------------------------------------------------------- shaders
const DITHER_GLSL = 'float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }';
// light through thin leaves: strongest looking towards the sun, shadowed like the direct light
const TRANSLUCENCY_GLSL = `
  #if NUM_DIR_LIGHTS > 0
  { vec3 Ld = directionalLights[0].direction;
    float back = pow(clamp(dot(geometryViewDir, -Ld), 0.0, 1.0), 3.0);
    float wrap = clamp(dot(-geometryNormal, Ld), 0.0, 1.0);
    vec3 trans = diffuseColor.rgb * vec3(0.9, 1.0, 0.45) * directLight.color * (back * 1.2 + wrap * 0.3) * uTransl;
    reflectedLight.directDiffuse += trans; }
  #endif`;
// wind: whole-tree sway grows with height, branch tips flutter faster
const WIND_GLSL = `
  #ifdef USE_INSTANCING
    vec3 ip = instanceMatrix[3].xyz;
    float sway = sin(uTime * 1.1 + ip.x * 0.05 + ip.z * 0.07) + 0.5 * sin(uTime * 2.3 + ip.z * 0.13);
    float hh = max(0.0, transformed.y - 1.0);
    transformed.xz += vec2(1.0, 0.6) * sway * uSway * hh * hh * 0.004;
    float ph = dot(position, vec3(1.7, 2.3, 1.3)) + ip.x * 0.3;
    transformed += vec3(sin(uTime * 6.3 + ph), sin(uTime * 7.9 + ph * 1.3) * 0.6, cos(uTime * 5.7 + ph)) * wind * 0.06 * uSway * 4.0;
  #endif`;

// The terrain's baked sun shadow (mountains shading the valleys at low sun) also falls on everything that grows there.
let TSH = null; // shared uniforms, set by the Flora constructor from the terrain material
const TSHADOW_UNI = 'uniform sampler2D tTShadow; uniform vec2 uSOrig; uniform float uSSpan; uniform float uShadowOn;';
function terrainShadowed(sh) {
  if (!TSH) return;
  Object.assign(sh.uniforms, TSH);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + TSHADOW_UNI)
    .replace('#include <lights_fragment_begin>', `float floraTS = 1.0;
      #ifdef USE_FOG
        { vec2 st = (vFogWorldPos.xz - uSOrig) / uSSpan; if (st.x > 0.0 && st.y > 0.0 && st.x < 1.0 && st.y < 1.0) floraTS = mix(1.0, texture2D(tTShadow, st).r, uShadowOn); }
      #endif
      ` + THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= floraTS;'));
}

// shared tweaks for every vegetation material: alpha that survives mipmapping (no thinning with distance),
// lighting that ignores card back-faces, translucency, wind, and the dithered hand-over to the impostors
function vegPatch(mat, { cut = null, band = null, key = '', sway = 0, leaf = true } = {}) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, { uSway: { value: sway }, uTransl: { value: leaf ? 1 : 0 } });
    if (cut) Object.assign(sh.uniforms, { uLoCut: cut, uBand: band });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uSway; attribute float wind; ${cut ? 'uniform float uLoCut; uniform float uBand; varying float vFadeT;' : ''}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (sway ? WIND_GLSL : ''));
    if (cut) {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#ifdef USE_INSTANCING
          float iDist = distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, cameraPosition);
          vFadeT = smoothstep(uLoCut - uBand, uLoCut, iDist);
          if (iDist > uLoCut) transformed = vec3(0.0);
        #endif
        #include <project_vertex>`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying float vFadeT; ${DITHER_GLSL}`)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (ign(gl_FragCoord.xy) < vFadeT) discard;');
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTransl;')
      .replace('#include <alphatest_fragment>', `#ifdef USE_MAP
        { vec2 mt = vMapUv * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
          diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; }
      #endif
      #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENCY_GLSL);
    terrainShadowed(sh);
};
  mat.customProgramCacheKey = () => 'veg2' + key + (cut ? 'c' : '') + sway;
  return mat;
}

// hemi-octahedral view directions: the square [-1,1]^2 covers the upper hemisphere, its border is the horizon
const OCT_GLSL = `
  vec2 hemiOctEnc(vec3 d) { d.y = max(d.y, 0.0); d /= (abs(d.x) + abs(d.y) + abs(d.z)); return vec2(d.x + d.z, d.x - d.z); }
  vec3 hemiOctDec(vec2 e) { vec2 p = vec2(e.x + e.y, e.x - e.y) * 0.5; return normalize(vec3(p.x, 1.0 - abs(p.x) - abs(p.y), p.y)); }
  void frameBasis(vec3 d, out vec3 fx, out vec3 fy) { vec3 up = abs(d.y) > 0.999 ? vec3(0.0, 0.0, -1.0) : vec3(0.0, 1.0, 0.0); fx = normalize(cross(up, d)); fy = cross(d, fx); }`;
function hemiOctDec(ex, ey, v = new V3()) { const px = (ex + ey) / 2, pz = (ex - ey) / 2; return v.set(px, 1 - Math.abs(px) - Math.abs(pz), pz).normalize(); }
function frameBasis(d) { const up = Math.abs(d.y) > 0.999 ? new V3(0, 0, -1) : new V3(0, 1, 0), fx = new V3().crossVectors(up, d).normalize(); return [fx, new V3().crossVectors(d, fx)]; }

// One camera-facing quad per far tree, every variant in one draw call. It picks the three captured views nearest
// to the actual view direction (in the tree's own frame, so yaw is honoured), blends them, and lights the result
// with the captured normals.
function impostorMaterial(F) {
  const mat = new THREE.MeshStandardMaterial({ map: F.impRT.textures[0], alphaTest: 0.5, roughness: 0.85, side: THREE.DoubleSide });
  const N = F.oct, nv = F.vars.length;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, { uVar: F.uVar, uLoCut: F.loCut, uBand: F.band, tImpN: { value: F.impRT.textures[1] }, uDims: { value: new THREE.Vector2(F.impGX * N, F.impGY * N) }, uTransl: { value: 0.7 } });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute vec4 iPos; attribute vec2 iData; uniform vec4 uVar[${nv}]; uniform float uLoCut; uniform float uBand; uniform vec2 uDims;
        varying vec2 vL0; varying vec2 vL1; varying vec2 vL2; varying vec4 vB01; varying vec2 vB2; varying vec3 vWt; varying vec2 vYaw; varying vec3 vTint; varying float vFadeT;
        ${OCT_GLSL}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vec4 vr = uVar[int(iData.x + 0.5)];
        float sc = abs(iPos.w), R = vr.z * sc; // negative scale: a small variant (shrub, log, stone)
        vec3 C = iPos.xyz + vec3(0.0, vr.w * sc, 0.0);
        vec3 toCam = cameraPosition - C; float cDist = length(toCam); vec3 vw = toCam / max(cDist, 1e-3);
        float cy = cos(iData.y), sy = sin(iData.y); vYaw = vec2(cy, sy);
        vec3 vo = vec3(cy * vw.x - sy * vw.z, vw.y, sy * vw.x + cy * vw.z); // view direction in the tree's frame
        vec2 g = (hemiOctEnc(vo) * 0.5 + 0.5) * ${(N - 1).toFixed(1)};
        vec2 f0 = min(floor(g), vec2(${(N - 2).toFixed(1)})), fr = g - f0;
        vec2 fa, fb, fc; vec3 wt;
        if (fr.x + fr.y < 1.0) { fa = f0; fb = f0 + vec2(1.0, 0.0); fc = f0 + vec2(0.0, 1.0); wt = vec3(1.0 - fr.x - fr.y, fr.x, fr.y); }
        else { fa = f0 + vec2(1.0); fb = f0 + vec2(1.0, 0.0); fc = f0 + vec2(0.0, 1.0); wt = vec3(fr.x + fr.y - 1.0, 1.0 - fr.y, 1.0 - fr.x); }
        vWt = wt;
        vec3 bx, by; frameBasis(vw, bx, by);
        vec3 offW = (bx * position.x + by * position.y) * 2.0; // in units of R
        vec3 offO = vec3(cy * offW.x - sy * offW.z, offW.y, sy * offW.x + cy * offW.z);
        vec2 blk = vr.xy * ${N.toFixed(1)};
        vec3 fx, fy, fd;
        fd = hemiOctDec(fa / ${(N - 1).toFixed(1)} * 2.0 - 1.0); frameBasis(fd, fx, fy); vL0 = vec2(dot(offO, fx), dot(offO, fy)) * 0.5 + 0.5;
        fd = hemiOctDec(fb / ${(N - 1).toFixed(1)} * 2.0 - 1.0); frameBasis(fd, fx, fy); vL1 = vec2(dot(offO, fx), dot(offO, fy)) * 0.5 + 0.5;
        fd = hemiOctDec(fc / ${(N - 1).toFixed(1)} * 2.0 - 1.0); frameBasis(fd, fx, fy); vL2 = vec2(dot(offO, fx), dot(offO, fy)) * 0.5 + 0.5;
        vB01 = vec4(blk + fa, blk + fb); vB2 = blk + fc;
        float tq = fract(iData.y * 7.31), tw = fract(iData.y * 3.17) - 0.5;
        vTint = (0.82 + 0.36 * tq) * vec3(1.0 + tw * 0.22, 1.0, 1.0 - tw * 0.22);
        vFadeT = smoothstep(uLoCut - uBand, uLoCut, cDist);`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vw;')
      .replace('#include <begin_vertex>', `vec3 transformed = C + (bx * position.x + by * position.y) * 2.0 * R;
        if (cDist < uLoCut - uBand || (iPos.w < 0.0 && cDist > ${SMALL_FAR.toFixed(1)})) transformed = C; // full model here / too small to see`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D tImpN; uniform vec2 uDims; uniform float uTransl;
        varying vec2 vL0; varying vec2 vL1; varying vec2 vL2; varying vec4 vB01; varying vec2 vB2; varying vec3 vWt; varying vec2 vYaw; varying vec3 vTint; varying float vFadeT;
        ${DITHER_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (ign(gl_FragCoord.xy) >= vFadeT) discard;
        vec2 u0 = (vB01.xy + clamp(vL0, 0.004, 0.996)) / uDims, u1 = (vB01.zw + clamp(vL1, 0.004, 0.996)) / uDims, u2 = (vB2 + clamp(vL2, 0.004, 0.996)) / uDims;
        vec4 a0 = texture2D(map, u0), a1 = texture2D(map, u1), a2 = texture2D(map, u2);
        vec4 impA = a0 * vWt.x + a1 * vWt.y + a2 * vWt.z;`)
      .replace('#include <map_fragment>', `diffuseColor *= vec4(impA.rgb * vTint * 0.8, impA.a); // no shadow map out here: stand-in for the crown's self-shadowing
        { vec2 mt = u0 * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
          diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; }`)
      .replace('#include <normal_fragment_begin>', `// (the normals are read after the alpha test: most of a distant forest's fragments are discarded)
        vec3 impN = (texture2D(tImpN, u0).xyz * vWt.x + texture2D(tImpN, u1).xyz * vWt.y + texture2D(tImpN, u2).xyz * vWt.z) * 2.0 - 1.0;
        vec3 impNO = normalize(impN);
        vec3 impNW = vec3(vYaw.x * impNO.x + vYaw.y * impNO.z, impNO.y, -vYaw.y * impNO.x + vYaw.x * impNO.z);
        vec3 normal = normalize((viewMatrix * vec4(impNW, 0.0)).xyz); vec3 nonPerturbedNormal = normal;`)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENCY_GLSL);
    terrainShadowed(sh);
};
  mat.customProgramCacheKey = () => 'octimp' + nv + 'x' + N;
  return mat;
}

// flag an instanced mesh's first n instances for upload (not its whole capacity: the buffers keep growth room)
function upload(m, n) {
  for (const a of [m.instanceMatrix, m.instanceColor]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
}
const hash2 = (i, j, s) => ((Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(s, 83492791)) >>> 0);
let lastFlora = null;
const GN = 12; // per-cell grid of terrain / forest samples (23 m apart) that candidates interpolate

export class Flora {
  constructor(world) {
    if (lastFlora) lastFlora.dispose(); lastFlora = this; // one flight at a time: free the previous impostor atlas
    const t0 = performance.now();
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const W = world, loc = W.loc, r = mulberry32(loc.seed * 3 + 11);
    this.T = TIER[W.qName] || TIER.medium; this.perfLevel = 0;
    this.loCut = { value: this.T.lo }; this.band = { value: Math.min(40, this.T.lo * 0.15) };
    this.atlas = foliageAtlas(this.T.atlas);
    const atlas = this.atlas.tex, rockD = W.detailU.rD.value, rockN = W.detailU.rN.value;
    this.rockTex = rockD; this.mask = null; this.extra = new Map(); this.extraN = 0;
    const TU = W.terrainMat?.userData.U;
    TSH = TU ? { tTShadow: TU.shadowTex, uSOrig: TU.sOrig, uSSpan: TU.sSpan, uShadowOn: TU.shadowOn } : null;
    // materials
    const mats = {};
    const leafMat = (sway, cut) => mats['l' + sway + cut] || (mats['l' + sway + cut] = vegPatch(new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78 }), { cut: cut ? this.loCut : null, band: this.band, key: 'l', sway }));
    const rockMat = (cut) => mats['r' + cut] || (mats['r' + cut] = vegPatch(new THREE.MeshStandardMaterial({ map: rockD, normalMap: rockN, vertexColors: true, roughness: 0.95 }), { cut: cut ? this.loCut : null, band: this.band, key: 'r', leaf: false }));
    this.mats = mats;
    // species variants
    this.groups = biome(loc.flora ? { ...loc, id: loc.flora.biome, snowline: loc.flora.snowline } : loc, W.waterLevel); this.vars = []; // real places borrow a biome (realworld.js)
    for (const gr of this.groups) {
      gr.vars = [];
      for (let v = 0; v < gr.variants; v++) {
        const m = SPECIES[gr.sp](r, gr.opts || {}), idx = this.vars.length;
        const V = { idx, sp: gr.sp, model: m, rock: !!m.rock, hit: !m.rock && !m.noHit, cast: !m.rock && !m.small, small: !!m.small || !!m.rock, nNear: 0, nHi: 0 };
        V.near = this.mkInst(m.geo, m.rock ? rockMat(false) : leafMat(m.sway, false), 64); V.near.castShadow = V.cast && W.q.shadows; V.near.receiveShadow = true; W.nearShadow?.(V.near);
        V.hi = this.mkInst(m.geo, m.rock ? rockMat(true) : leafMat(m.sway, true), 256); V.hi.receiveShadow = W.qName === 'high' || W.qName === 'ultra';
        gr.vars.push(V); this.vars.push(V);
      }
    }
    this.kinds = {}; for (const gr of this.groups) if (gr.kind) this.kinds[gr.kind] = gr;
    // octahedral impostor atlas: every variant from oct x oct directions, albedo + normals (MRT)
    const NV = this.vars.length, N = (this.oct = this.T.oct);
    const maxT = Math.min(W.renderer.capabilities.maxTextureSize, 8192);
    let cs = this.T.cs, gx = Math.ceil(Math.sqrt(NV)), gy = Math.ceil(NV / gx);
    while (Math.max(gx, gy) * N * cs > maxT && cs > 32) cs /= 2;
    this.impGX = gx; this.impGY = gy; this.impCell = cs;
    // (no depth buffer: capture() renders with depth into a temporary target and copies the result here)
    this.impRT = new THREE.WebGLRenderTarget(gx * N * cs, gy * N * cs, { count: 2, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.impRT.textures[0].colorSpace = THREE.SRGBColorSpace;
    this.uVar = { value: this.vars.map((V, i) => { const bs = V.model.geo.boundingSphere; V.bR = bs.radius * 1.02; V.bC = bs.center.clone(); return new THREE.Vector4(i % gx, Math.floor(i / gx), V.bR, bs.center.y); }) };
    this.captured = false;
    this.impMat = impostorMaterial(this);
    // impostors live in spatial chunks: off-screen chunks are culled, and a chunk is rebuilt (and re-uploaded) only when
    // one of its cells changes, not the whole forest every time
    this.imp = new THREE.Group(); this.imp.visible = false; this.group.add(this.imp);
    this.impCh = new Map(); this.impDirtyCh = new Set(); this.impN = 0; this.impTmp = { pos: new Float32Array(0), data: new Float32Array(0) };
    for (const V of this.vars) V.ext = Math.abs(V.bC.y) + V.bR * 1.42; // reach of a quad from the tree's foot, per unit scale
    if (this.atlas.ready) this.capture();
    // streamed cells
    this.cells = new Map(); this.queue = []; this.wantAt = null; this.nearAt = null; this.impDirty = true; this.nearDirty = true; this.frame = 0; this.lastImp = -99; this.cellMs = 1;
    this.felled = new Map();
    this.cover = new GroundCover(this);
    this.buildMs = performance.now() - t0;
  }
  mkInst(geo, mat, cap) {
    const m = new THREE.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.count = 0; m.visible = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(m); return m;
  }
  grow(V, which, need) {
    const old = V[which], cap = Math.max(need, old.instanceMatrix.count * 2), m = this.mkInst(old.geometry, old.material, cap);
    m.castShadow = old.castShadow; m.receiveShadow = old.receiveShadow; m.layers.mask = old.layers.mask;
    this.group.remove(old); old.dispose(); V[which] = m;
  }
  // an impostor chunk's instance buffers
  impBuf(cap) {
    const g = new THREE.InstancedBufferGeometry(), q = new THREE.PlaneGeometry(1, 1);
    g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv); g.setAttribute('normal', q.attributes.normal);
    const pos = new Float32Array(cap * 4), data = new Float32Array(cap * 2);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iData', new THREE.InstancedBufferAttribute(data, 2).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere();
    return { g, pos, data, cap };
  }
  // Photograph every variant from oct x oct directions over the upper hemisphere into the impostor atlas:
  // attachment 0 = albedo (unlit, with the baked crown AO), attachment 1 = normals in the tree's own frame.
  capture() {
    const t0 = performance.now();
    const R = this.w.renderer, cs = this.impCell, N = this.oct, gx = this.impGX;
    const rt = new THREE.WebGLRenderTarget(this.impRT.width, this.impRT.height, { count: 2, generateMipmaps: false, depthBuffer: true });
    rt.textures[0].colorSpace = THREE.SRGBColorSpace;
    const rockReady = !!(this.rockTex.image && (this.rockTex.image.complete !== false) && this.rockTex.image.width);
    const mrt = (map, color) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, side: THREE.DoubleSide, vertexColors: true,
        uniforms: { map: { value: map }, uCol: { value: new THREE.Color(color) }, uHasMap: { value: map ? 1 : 0 } },
        vertexShader: `out vec2 vUv; out vec3 vCol; out vec3 vN; void main() { vUv = uv; vCol = color; vN = normal; vec4 p = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            p = instanceMatrix * p;
          #endif
          gl_Position = projectionMatrix * viewMatrix * p; }`,
        fragmentShader: `precision highp float; uniform sampler2D map; uniform vec3 uCol; uniform float uHasMap; in vec2 vUv; in vec3 vCol; in vec3 vN;
          layout(location = 0) out vec4 oAlb; layout(location = 1) out vec4 oNrm;
          void main() { vec4 t = vec4(1.0);
            if (uHasMap > 0.5) { t = texture(map, vUv); vec2 mt = vUv * vec2(textureSize(map, 0)), dx = dFdx(mt), dy = dFdy(mt);
              t.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; } // keep thin leaves at this small size
            if (t.a < 0.5) discard;
            // linear in and out: the sampler decodes the sRGB map, the sRGB render target encodes on write
            oAlb = vec4(t.rgb * vCol * uCol, 1.0); oNrm = vec4(normalize(vN) * 0.5 + 0.5, 1.0); }`,
      });
      m.map = map; // makes three set the sampler's colour space
      return m;
    };
    const leaf = mrt(this.atlas.tex, 0xffffff), rock = mrt(rockReady ? this.rockTex : null, rockReady ? 0xffffff : 0x8a8580);
    // ONE render: every view of every variant is an instance, rotated into the view's frame and moved to its tile
    // (orthographic, so turning the tree is the same as moving the camera). Tiles are 2 units = cs px apart.
    const gy = this.impGY, scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(0, gx * N * 2, gy * N * 2, 0, 0.01, 10);
    const d = new V3(), m4 = new THREE.Matrix4(), rot = new THREE.Matrix4(), sc = new THREE.Matrix4(), tr = new THREE.Matrix4(), meshes = [];
    this.vars.forEach((V, i) => {
      const bx = (i % gx) * N, by = Math.floor(i / gx) * N, Rb = V.bR;
      const im = new THREE.InstancedMesh(V.model.geo, V.rock ? rock : leaf, N * N); im.frustumCulled = false;
      for (let fi = 0; fi < N; fi++) for (let fj = 0; fj < N; fj++) {
        hemiOctDec(fi / (N - 1) * 2 - 1, fj / (N - 1) * 2 - 1, d);
        const [fx, fy] = frameBasis(d);
        rot.makeBasis(fx, fy, d).transpose(); // world -> (right, up, towards the viewer)
        m4.makeTranslation((bx + fi) * 2 + 1, (by + fj) * 2 + 1, -5).multiply(sc.makeScale(1 / Rb, 1 / Rb, 1 / Rb)).multiply(rot).multiply(tr.makeTranslation(-V.bC.x, -V.bC.y, -V.bC.z));
        im.setMatrixAt(fi * N + fj, m4);
      }
      scene.add(im); meshes.push(im);
    });
    const prevRT = R.getRenderTarget(), prevAuto = R.autoClear, prevCC = R.getClearColor(new THREE.Color()), prevCA = R.getClearAlpha();
    R.autoClear = false;
    R.setRenderTarget(rt); R.setClearColor(0x2a3a22, 0); R.clear(true, true, false);
    R.render(scene, cam);
    // copy into the depth-less atlas (saves a full-size depth buffer for the rest of the flight); three builds its mipmaps
    const copy = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, uniforms: { tA: { value: rt.textures[0] }, tN: { value: rt.textures[1] } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
      fragmentShader: `precision highp float; uniform sampler2D tA; uniform sampler2D tN; layout(location = 0) out vec4 oA; layout(location = 1) out vec4 oN;
        void main() { ivec2 p = ivec2(gl_FragCoord.xy); oA = texelFetch(tA, p, 0); oN = texelFetch(tN, p, 0); }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copy), cs2 = new THREE.Scene(); quad.frustumCulled = false; cs2.add(quad);
    R.setRenderTarget(this.impRT); R.render(cs2, cam);
    quad.geometry.dispose(); copy.dispose(); rt.dispose();
    R.setRenderTarget(prevRT); R.autoClear = prevAuto; R.setClearColor(prevCC, prevCA);
    meshes.forEach((m) => m.dispose());
    leaf.dispose(); rock.dispose();
    this.rockCaptured = rockReady; this.captured = true; this.imp.visible = true;
    this.captureMs = performance.now() - t0;
  }

  // ------------------------------------------------ forest map
  // 0..1 how much forest grows at x,z: an injected mask (real land use), the terrain's own forest map, or noise
  forestAt(x, z) {
    if (this.mask) { const v = this.mask(x, z); if (v != null) return v; }
    if (this.w.forestAt) return this.w.forestAt(x, z);
    return smoothstep(-0.02, 0.18, this.w.noise.fbm(x / 260 + 7, z / 260, 3));
  }
  setForestMask(fn, bare = null) { this.mask = fn || null; this.bare = bare; this.reset(); } // bare(x, z): nothing grows there (a city's pavements)
  // extra trees from outside (e.g. OpenStreamMap): [{ x, z, kind?, scale? }]
  addTrees(list) {
    for (const t of list) {
      const gr = this.kinds[t.kind] || this.kinds.broadleaf || this.kinds.conifer || this.groups[0], key = this.key(Math.floor(t.x / CELL), Math.floor(t.z / CELL));
      let a = this.extra.get(key); if (!a) this.extra.set(key, (a = []));
      a.push(t.x, t.z, t.scale || 0.8 + ((t.x * 7.13 + t.z * 3.7) % 1 + 1) % 1 * 0.4, gr.vars[Math.abs(Math.floor(t.x * 13 + t.z * 7)) % gr.vars.length].idx); this.extraN++;
      const c = this.cells.get(key); if (c) { c.data = null; this.cellChanged(c); }
    }
    this.wantAt = null;
  }
  clearTrees() { this.extra.clear(); this.extraN = 0; this.reset(); }
  reset() { for (const c of this.cells.values()) this.cellChanged(c); this.cells.clear(); this.felled.clear(); this.wantAt = null; this.nearDirty = true; }
  // a cell's trees changed (generated, densified, thinned, dropped): its impostor chunk needs a rebuild
  cellChanged(c) { this.impDirtyCh.add(Math.floor(c.ci / IMP_CH) + ',' + Math.floor(c.cj / IMP_CH)); this.impDirty = true; }

  // ------------------------------------------------ placement
  key(i, j) { return i + ',' + j; }
  // coarse samples over the cell: height, forest density, canopy clumping
  cellGrid(x0, z0) {
    const W = this.w, n = W.noise, M = GN + 1, h = new Float32Array(M * M), F = new Float32Array(M * M), C = new Float32Array(M * M), st = CELL / GN;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const x = x0 + i * st, z = z0 + j * st, k = j * M + i;
      h[k] = W.sampleGrid(x, z); F[k] = this.forestAt(x, z);
      // clumps of trees and small clearings inside the forest (30-80 m)
      C[k] = smoothstep(-0.45, 0.15, n.n2(x / 70 + 31, z / 70) + 0.5 * n.n2(x / 23, z / 23 + 17));
    }
    return { h, F, C, st };
  }
  // the hedgerow / tree-line trees around a farm field
  hedgerow(f, x0, z0, out, r) {
    if (f.pivot || this.w.loc.desert) return;
    const gr = this.kinds.broadleaf; if (!gr) return;
    const ca = Math.cos(f.ang), sa = Math.sin(f.ang), n = this.w.noise;
    for (const [sxx, szz, ax] of [[f.sx + 3, f.sz, 1], [f.sz + 3, f.sx, 0]]) for (const sg of [-1, 1]) {
      for (let t = -szz; t <= szz; t += 7 + r() * 4) {
        const u = ax ? sg * sxx : t, v = ax ? t : sg * sxx, x = f.x + u * ca - v * sa, z = f.z + u * sa + v * ca;
        if (x < x0 || x >= x0 + CELL || z < z0 || z >= z0 + CELL) continue;
        if (n.n2(x / 60, z / 60 + 5) < -0.15 || this.w.nearRoad(x, z, 8)) continue; // gaps in the hedge
        const h = this.w.sampleGrid(x, z);
        out.push(x, h - 0.2, z, 0.55 + r() * 0.5, gr.vars[Math.floor(r() * gr.vars.length)].idx, r() * 6.283);
      }
    }
  }
  // Evaluate the cell's deterministic candidate sequence. The first T.base candidates form the sparse far layer;
  // a dense cell evaluates all T.cand, so its trees are a superset of its far trees (same positions).
  genCell(cell, dense) {
    const W = this.w, T = this.T, x0 = cell.ci * CELL, z0 = cell.cj * CELL, wl = W.waterLevel;
    const r = mulberry32(hash2(cell.ci, cell.cj, W.loc.seed)), nC = dense ? T.cand : T.base;
    const out = [];
    const pad = 400, towns = W.net.towns.filter((t) => Math.abs(t.c.x - x0 - CELL / 2) < CELL / 2 + 360 * t.size + pad && Math.abs(t.c.z - z0 - CELL / 2) < CELL / 2 + 360 * t.size + pad);
    const fields = W.net.fields.filter((f) => Math.abs(f.x - x0 - CELL / 2) < CELL / 2 + f.sx + f.sz + 10 && Math.abs(f.z - z0 - CELL / 2) < CELL / 2 + f.sx + f.sz + 10);
    const roadNear = W.nearRoad(x0 + CELL / 2, z0 + CELL / 2, CELL * 0.72 + 14);
    const airport = x0 + CELL > -380 && x0 < 660 && z0 + CELL > -1400 && z0 < 1400;
    const inField = (x, z, m) => fields.some((f) => { const dx = x - f.x, dz = z - f.z; if (f.pivot) return dx * dx + dz * dz < (f.sx + m) ** 2; const ca = Math.cos(f.ang), sa = Math.sin(f.ang); return Math.abs(dx * ca + dz * sa) < f.sx + m && Math.abs(-dx * sa + dz * ca) < f.sz + m; });
    // fixed trees first (they belong to the far layer too): injected ones, hedgerows
    const ex = this.extra.get(cell.key);
    if (ex) for (let k = 0; k < ex.length; k += 4) out.push(ex[k], W.sampleGrid(ex[k], ex[k + 1]) - 0.2, ex[k + 1], ex[k + 2], ex[k + 3], (ex[k] * 1.7 + ex[k + 1]) % 6.283);
    const rh = mulberry32(hash2(cell.ci, cell.cj, 4321));
    for (const f of fields) this.hedgerow(f, x0, z0, out, rh);
    const G = this.groups, dens = new Float32Array(G.length), grid = this.cellGrid(x0, z0), M = GN + 1;
    const e = { h: 0, s: 0, F: 0, C: 0, E: 0, wl: 0, open: 0, riv: 0 };
    const nFixed = out.length / STRIDE;
    let nBase = 0;
    for (let i = 0; i < nC; i++) {
      if (i === T.base) nBase = out.length / STRIDE;
      const fx = r(), fz = r(), u = r(), u2 = r(), u3 = r(), u4 = r(), yaw = r() * Math.PI * 2, x = x0 + fx * CELL, z = z0 + fz * CELL;
      // interpolate the coarse grid
      const gx = fx * GN, gz = fz * GN, ix = Math.min(GN - 1, gx | 0), iz = Math.min(GN - 1, gz | 0), tx = gx - ix, tz = gz - iz, k00 = iz * M + ix;
      const bil = (A) => (A[k00] * (1 - tx) + A[k00 + 1] * tx) * (1 - tz) + (A[k00 + M] * (1 - tx) + A[k00 + M + 1] * tx) * tz;
      const hg = bil(grid.h); if (hg < wl + 0.5) continue;
      e.h = W.loc.flora ? W.loc.flora.h(hg) : hg; e.wl = hg - wl + (W.loc.flora?.wl || 0); // real places: altitudes mapped onto the borrowed biome's
      const dhx = ((grid.h[k00 + 1] - grid.h[k00]) * (1 - tz) + (grid.h[k00 + M + 1] - grid.h[k00 + M]) * tz) / grid.st, dhz = ((grid.h[k00 + M] - grid.h[k00]) * (1 - tx) + (grid.h[k00 + M + 1] - grid.h[k00 + 1]) * tx) / grid.st;
      e.s = 1 - 1 / Math.sqrt(1 + dhx * dhx + dhz * dhz);
      e.F = bil(grid.F); e.C = bil(grid.C); e.E = e.F * (1 - e.F) * 4 * (0.5 + 0.5 * (1 - e.C)); e.open = 1 - e.F;
      e.riv = 1 - smoothstep(1.5, 9, e.wl);
      let tot = 0; for (let k = 0; k < G.length; k++) { dens[k] = G[k].denseOnly && i < T.base ? 0 : Math.max(0, G[k].dens(e)); tot += dens[k]; }
      if (u >= Math.min(1, tot)) continue;
      if (airport && Math.abs(x - 140) < 520 && Math.abs(z) < 1400) continue;
      if (towns.length && towns.some((t) => (t.c.x - x) ** 2 + (t.c.z - z) ** 2 < (360 * t.size) ** 2)) continue;
      if (fields.length && inField(x, z, 2)) continue;
      if (roadNear && W.nearRoad(x, z, 11)) continue;
      const h = W.sampleGrid(x, z); if (h < wl + 0.7) continue;
      if (this.bare && this.bare(x, z)) continue;
      if (W.landAt && W.landAt(x, z, e.land || (e.land = [0, 0, 0, 0]))[0] > 0.3) continue; // not in rivers and lakes (world.js terrain bake)
      if (W.real?.waterAt(x, z, 16) != null) continue; // nor in real rivers above the water level (realworld.js)
      let t = u2 * tot, k = 0; while (k < G.length - 1 && (t -= dens[k]) > 0) k++;
      const gr = G[k], V = gr.vars[Math.floor(u3 * gr.vars.length)];
      if (gr.rock) {
        const sc = 1.0 + u4 * u4 * 5;
        out.push(x, h - e.s * sc * 0.6, z, sc, V.idx, yaw);
        const ns = Math.floor(u4 * 7) % 4; // a few smaller stones around the bigger ones
        for (let q = 0; q < ns; q++) {
          const a = yaw * 3 + q * 2.1, d = sc * (1.2 + ((q * 0.37 + u) % 1) * 1.4), xx = x + Math.cos(a) * d, zz = z + Math.sin(a) * d, s2 = sc * (0.25 + ((u2 + q * 0.29) % 1) * 0.3);
          out.push(xx, W.sampleGrid(xx, zz) - e.s * s2 * 0.6, zz, s2, gr.vars[(V.idx - gr.vars[0].idx + q + 1) % gr.vars.length].idx, yaw + q);
        }
      } else {
        // trees in the open and at the forest edge grow a little smaller; old giants inside the stands
        const sc = (0.68 + u4 * 0.6) * (0.8 + 0.25 * e.F);
        out.push(x, h - 0.2 - e.s * 1.5, z, sc, V.idx, yaw);
      }
    }
    if (nC <= T.base) nBase = out.length / STRIDE;
    nBase = Math.max(nBase, nFixed);
    cell.data = new Float32Array(out); cell.n = out.length / STRIDE; cell.nBase = nBase; cell.dense = dense;
    let y0 = Infinity, y1 = -Infinity; for (let k = 1; k < out.length; k += STRIDE) { if (out[k] < y0) y0 = out[k]; if (out[k] > y1) y1 = out[k]; }
    cell.y0 = y0; cell.y1 = y1;
    cell.tile = this.tileOf(cell);
  }
  tileOf(cell) { // the outer terrain tile a cell sits on (null inside the core map)
    const T = this.w.tiles; if (!T) return null;
    const ti = Math.floor(cell.ci * CELL / T.size), tj = Math.floor(cell.cj * CELL / T.size);
    if (T.inCore(ti, tj)) return null;
    return T.tiles.get(T.key(ti, tj)) || undefined; // undefined: tile not streamed in yet
  }
  // called by TerrainTiles whenever it may have built or dropped tiles: re-plan only if the set really changed
  tilesChanged(tiles) {
    if (!tiles) { this.tilesDirty = true; return; }
    const ids = this.tileIds || (this.tileIds = new WeakMap());
    let sig = 0, n = 0;
    for (const t of tiles.values()) { let id = ids.get(t); if (!id) ids.set(t, (id = ++this.tileSerial || (this.tileSerial = 1))); sig = (sig * 31 + id) | 0; n++; }
    if (sig !== this.tileSig || n !== this.tileN) { this.tileSig = sig; this.tileN = n; this.tilesDirty = true; }
  }

  // decide which cells should exist, dense or sparse, around the camera
  plan(cam) {
    const T = this.T, k = this.perfLevel >= 2 ? 0.6 : 1, Rd = T.dense * k, Rf = T.far * k;
    const i0 = Math.floor((cam.x - Rf) / CELL), i1 = Math.floor((cam.x + Rf) / CELL), j0 = Math.floor((cam.z - Rf) / CELL), j1 = Math.floor((cam.z + Rf) / CELL);
    const want = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const d = Math.hypot((i + 0.5) * CELL - cam.x, (j + 0.5) * CELL - cam.z); if (d > Rf) continue;
      const key = this.key(i, j), dense = d < Rd; let c = this.cells.get(key);
      if (!c) { c = { ci: i, cj: j, key, data: null, n: 0, nBase: 0, dense: false, tile: null }; this.cells.set(key, c); }
      c.mark = this.frame; c.d = d;
      if (c.data && c.tile !== undefined && c.tile !== this.tileOf(c)) { c.data = null; this.cellChanged(c); } // the ground under it was re-meshed
      if (c.data && !dense && c.dense) { c.dense = false; c.n = c.nBase; c.data = c.data.slice(0, c.nBase * STRIDE); this.cellChanged(c); }
      if (!c.data || (dense && !c.dense)) { c.wantDense = dense; want.push(c); }
    }
    for (const [key, c] of this.cells) if (c.mark !== this.frame && c.d > Rf * 1.05) { this.cells.delete(key); this.cellChanged(c); }
    // sparse far layer first everywhere close, then densify nearest-first
    this.queue = want.sort((a, b) => a.d - b.d);
  }
  update(cam, budgetMs) {
    this.frame++;
    if (!this.captured && this.atlas.ready) this.capture();
    if (!this.wantAt || this.wantAt.distanceToSquared(cam) > 150 * 150 || this.tilesDirty) { this.tilesDirty = false; this.wantAt = cam.clone(); this.plan(cam); }
    if (this.captured && !this.rockCaptured && this.rockTex.image && this.rockTex.image.width) this.capture();
    // time-sliced generation
    const t0 = performance.now(), budget = budgetMs ?? (this.started ? this.T.budget : 40); this.started = true;
    // a cell is only started if it should fit in what's left of the budget (one is always allowed): overrunning the
    // budget by a whole cell is what made a streaming frame miss the display's refresh
    let done = 0;
    while (this.queue.length && performance.now() - t0 + (done ? this.cellMs : 0) < budget) {
      const c = this.queue.shift();
      if (!this.cells.has(c.key)) continue;
      if (this.tileOf(c) === undefined) continue; // outer tile not built yet: try again when it is
      const t1 = performance.now();
      this.genCell(c, c.wantDense); done++;
      this.cellMs += (performance.now() - t1 - this.cellMs) * 0.2; // typical cost of one cell (EMA)
      this.cellChanged(c); if (c.d < this.T.lo + 600) this.nearDirty = true;
    }
    this.updateNear(cam);
    if (!this.impJob && this.impDirty && this.frame - this.lastImp > 12) this.impJob = this.updateImpostors();
    if (this.impJob) {
      const t1 = performance.now(), b2 = Math.max(1.2, budget - (t1 - t0)); this.impUp = 0;
      while (performance.now() - t1 < b2) { const r = this.impJob.next(); if (r.done) { this.impJob = null; break; } if (r.value === 'frame') break; }
    }
    this.placeImpostors(cam);
    this.cover.update(cam);
  }
  // full models for trees within the LOD distance (+ margin; the shader hides the ones past it exactly)
  updateNear(cam) {
    if (!this.nearDirty && this.nearAt && this.nearAt.distanceToSquared(cam) < 20 * 20) return;
    this.nearDirty = false; this.nearAt = cam.clone();
    const lo = this.loCut.value + 35, lo2 = lo * lo, nr = Math.min(this.T.near, this.loCut.value * 0.7), nr2 = nr * nr;
    for (const V of this.vars) V.nNear = V.nHi = 0;
    const i0 = Math.floor((cam.x - lo) / CELL), i1 = Math.floor((cam.x + lo) / CELL), j0 = Math.floor((cam.z - lo) / CELL), j1 = Math.floor((cam.z + lo) / CELL);
    const vars = this.vars;
    for (let pass = 0; pass < 2; pass++) {
      let overflow = false;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = this.cells.get(this.key(i, j)); if (!c || !c.data) continue;
        const d = c.data, n = c.dense ? c.n : c.nBase;
        for (let k = 0; k < n; k++) {
          const o = k * STRIDE, x = d[o], y = d[o + 1], z = d[o + 2], dd = (x - cam.x) ** 2 + (y - cam.y) ** 2 + (z - cam.z) ** 2;
          if (dd > lo2) continue;
          const V = vars[d[o + 4]], near = dd < nr2, which = near ? 'near' : 'hi', idx = near ? V.nNear++ : V.nHi++, m = V[which];
          if (idx >= m.instanceMatrix.count) { overflow = true; continue; }
          const s = d[o + 3], cy = Math.cos(d[o + 5]) * s, sy = Math.sin(d[o + 5]) * s, e = m.instanceMatrix.array, b = idx * 16;
          e[b] = cy; e[b + 1] = 0; e[b + 2] = -sy; e[b + 3] = 0; e[b + 4] = 0; e[b + 5] = s; e[b + 6] = 0; e[b + 7] = 0;
          e[b + 8] = sy; e[b + 9] = 0; e[b + 10] = cy; e[b + 11] = 0; e[b + 12] = x; e[b + 13] = y; e[b + 14] = z; e[b + 15] = 1;
          // per-tree colour: brightness and a slight warm / cool shift (same formula as the impostors)
          const yw = d[o + 5], tq = (((yw * 7.31) % 1) + 1) % 1, tw = (((yw * 3.17) % 1) + 1) % 1 - 0.5, tn = 0.82 + 0.36 * tq, ca = m.instanceColor.array;
          ca[idx * 3] = tn * (1 + tw * 0.22); ca[idx * 3 + 1] = tn; ca[idx * 3 + 2] = tn * (1 - tw * 0.22);
        }
      }
      if (!overflow) break;
      for (const V of vars) { if (V.nNear > V.near.instanceMatrix.count) this.grow(V, 'near', V.nNear * 1.5 | 0); if (V.nHi > V.hi.instanceMatrix.count) this.grow(V, 'hi', V.nHi * 1.5 | 0); V.nNear = V.nHi = 0; }
    }
    for (const V of vars) for (const [m, n] of [[V.near, V.nNear], [V.hi, V.nHi]]) { m.count = n; m.visible = n > 0; if (n) upload(m, n); }
  }
  // Chunks entirely beyond SMALL_FAR skip their small things (stored last): no re-upload, just a shorter draw
  placeImpostors(cam) {
    for (const [key, ch] of this.impCh) {
      const sp = ch.B.g.boundingSphere, d = Math.hypot(sp.center.x - cam.x, sp.center.y - cam.y, sp.center.z - cam.z) - sp.radius;
      const far = d > SMALL_FAR + (ch.far ? 0 : 150); // (hysteresis; a far chunk is always wholly past SMALL_FAR)
      if (far !== ch.far) { ch.far = far; ch.B.g.instanceCount = far ? ch.nBig : ch.n; }
      ch.mesh.visible = ch.B.g.instanceCount > 0;
    }
  }
  // Every tree as one impostor quad (the shader collapses the ones inside the full-model range, and small ones far
  // away), grouped in spatial chunks. Only chunks whose cells changed are rebuilt; each is swapped in whole (its
  // count and upload flagged once it's filled). A generator: a slice at a time, and at most ~3 MB of uploads a frame.
  *updateImpostors() {
    this.impDirty = false; this.lastImp = this.frame;
    const vars = this.vars, keys = [...this.impDirtyCh]; this.impDirtyCh.clear();
    let budget = 0;
    for (const key of keys) {
      const [ki, kj] = key.split(',').map(Number), list = [];
      let cnt = 0;
      for (let i = ki * IMP_CH; i < (ki + 1) * IMP_CH; i++) for (let j = kj * IMP_CH; j < (kj + 1) * IMP_CH; j++) {
        const c = this.cells.get(this.key(i, j)); if (!c || !c.data) continue;
        list.push(c); cnt += c.dense ? c.n : c.nBase;
      }
      let ch = this.impCh.get(key);
      if (!cnt) { if (ch) { this.imp.remove(ch.mesh); ch.B.g.dispose(); this.impN -= ch.n; this.impCh.delete(key); } continue; }
      if (!ch) { const B = this.impBuf(Math.ceil(cnt * 1.3)), mesh = new THREE.Mesh(B.g, this.impMat); this.imp.add(mesh); this.impCh.set(key, (ch = { B, mesh, n: 0 })); }
      // filled into scratch arrays over several slices, then copied into the chunk's buffers in one go: the chunk keeps
      // drawing (and, if it was off screen, uploading) its old content consistently until then
      const T = this.impTmp; if (T.pos.length < cnt * 4) { T.pos = new Float32Array(cnt * 4 * 1.3 | 0); T.data = new Float32Array(cnt * 2 * 1.3 | 0); }
      const P = T.pos, D = T.data;
      // trees first, then the small things: a chunk that is all far away just draws fewer (see placeImpostors)
      let n = 0, nBig = 0, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, ext = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (const c of list) {
          const d = c.data, m = c.dense ? c.n : c.nBase;
          for (let k = 0; k < m; k++) {
            const o = k * STRIDE, V = vars[d[o + 4]]; if (V.small !== (pass === 1)) continue;
            const x = d[o], y = d[o + 1], z = d[o + 2], sc = d[o + 3];
            P[n * 4] = x; P[n * 4 + 1] = y; P[n * 4 + 2] = z; P[n * 4 + 3] = pass ? -sc : sc; D[n * 2] = d[o + 4]; D[n * 2 + 1] = d[o + 5]; n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
            const e = V.ext * sc; if (e > ext) ext = e;
          }
          if ((budget += m + 8) > 8000) { budget = 0; yield; }
        }
        if (!pass) nBig = n;
      }
      const B = n > ch.B.cap ? this.impBuf(Math.ceil(n * 1.3)) : ch.B, g = B.g;
      B.pos.set(P.subarray(0, n * 4)); B.data.set(D.subarray(0, n * 2));
      g.boundingSphere.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      g.boundingSphere.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + ext;
      for (const a of [g.attributes.iPos, g.attributes.iData]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
      if (B !== ch.B) { ch.B.g.dispose(); ch.B = B; ch.mesh.geometry = g; }
      this.impN += n - ch.n; ch.n = n; ch.nBig = nBig; ch.far = null; // placeImpostors sets the count
      if ((this.impUp += n * 24) > 3e6) yield 'frame'; // spread big re-uploads over frames
    }
  }
  setPerf(level) {
    this.perfLevel = level;
    this.loCut.value = this.T.lo * (level >= 2 ? 0.7 : 1);
    this.wantAt = null; this.nearDirty = true; this.impDirty = true;
    this.cover.setPerf(level);
  }
  // stats for the test kit / debugging
  stats() {
    let cells = 0, trees = 0; for (const c of this.cells.values()) if (c.data) { cells++; trees += c.dense ? c.n : c.nBase; }
    let models = 0; for (const V of this.vars) models += V.nNear + V.nHi;
    return { buildMs: Math.round(this.buildMs), captureMs: Math.round(this.captureMs || 0), variants: this.vars.length, cells, trees, models, impostors: this.impN, impChunks: this.impCh.size, grass: this.cover.grass?.count || 0, impAtlas: `${this.impRT.width}x${this.impRT.height}`, oct: this.oct };
  }
  hit(p) {
    const c = this.cells.get(this.key(Math.floor(p.x / CELL), Math.floor(p.z / CELL))); if (!c || !c.data) return null;
    const d = c.data, n = c.dense ? c.n : c.nBase;
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE, V = this.vars[d[o + 4]]; if (!V.hit) continue;
      const dx = p.x - d[o], dz = p.z - d[o + 2], s = d[o + 3], rr = Math.max(1.2, V.model.R * s * 0.5);
      if (dx * dx + dz * dz > rr * rr) continue;
      const id = c.key + ':' + k; let t = this.felled.get(id);
      if (!t) t = [d[o], d[o + 1], d[o + 2], V.model.H * s, rr];
      if (p.y < t[1] + t[3] && p.y > t[1]) { this.felled.set(id, t); return t; } // caller flattens t[3] once hit
    }
    return null;
  }
  dispose() {
    this.impRT.dispose(); for (const ch of this.impCh?.values() || []) ch.B.g.dispose(); this.impMat?.dispose(); this.cover?.dispose();
    for (const m of Object.values(this.mats || {})) m.dispose();
    for (const V of this.vars || []) V.model.geo.dispose();
  }
}

// ---------------------------------------------------------------- ground cover
// Photo grass tufts (tinted with the ground's own colour) in clumps, meadow flowers, ferns under the trees,
// desert scrub, in 16 m cells around the camera.
class GroundCover {
  constructor(flora) {
    this.f = flora; const W = flora.w; this.P = GRASS[W.qName] || null; this.level = 0;
    this.cells = new Map(); this.at = null;
    if (!this.P) return;
    this.R = { value: this.P.R };
    const mat = new THREE.MeshStandardMaterial({ map: flora.atlas.tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOG, { uGR: this.R, uTransl: { value: 0.8 } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uGR;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 gp = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
          transformed *= smoothstep(uGR, uGR * 0.72, distance(gp, cameraPosition));
          float gs = sin(uTime * 1.9 + gp.x * 0.35 + gp.z * 0.21) + 0.4 * sin(uTime * 3.7 + gp.z * 0.5);
          transformed.xz += vec2(gs, gs * 0.6) * 0.12 * transformed.y;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTransl;')
        .replace('#include <alphatest_fragment>', `{ vec2 mt = vMapUv * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
            diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.12; }
          #include <alphatest_fragment>`)
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANSLUCENCY_GLSL);
      terrainShadowed(sh);
};
    mat.customProgramCacheKey = () => 'groundcover2';
    this.mat = mat;
    // crossed cards, normals straight up so they light like the ground; split: each card shows a different slice of the strip
    const tuft = (uv, w, h, n = 3, split = 1) => {
      const b = new GB(), up = new V3(0, 1, 0), c = new THREE.Color(1, 1, 1);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI + k * 0.4, ax = new V3(Math.cos(a) * w / 2, 0, Math.sin(a) * w / 2), sl = k % split, du = (uv[2] - uv[0]) / split;
        b.quad(new V3(Math.cos(a + 1.6) * w * 0.15 * (k - 1), h / 2, Math.sin(a + 1.6) * w * 0.15 * (k - 1)), ax, new V3(0, h / 2, 0), [uv[0] + du * sl, uv[1], uv[0] + du * (sl + 1), uv[3]], c, () => up);
      }
      const g = b.build(); g.deleteAttribute('color'); return g;
    };
    const desert = !!W.loc.desert;
    this.desert = desert;
    this.grass = new THREE.InstancedMesh(tuft(UV.grass, 0.75, 0.6, 4, 4), mat, this.P.cap);
    this.extra = new THREE.InstancedMesh(desert ? tuft(UV.scrub, 1.6, 0.8) : tuft(UV.flower, 1.1, 0.55), mat, Math.ceil(this.P.cap / 4));
    this.fern = new THREE.InstancedMesh(tuft(UV.fern, 1.4, 1.1, 2), mat, Math.ceil(this.P.cap / 5));
    for (const m of [this.grass, this.extra, this.fern]) {
      m.frustumCulled = false; m.count = 0; m.receiveShadow = W.qName === 'high' || W.qName === 'ultra'; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      flora.group.add(m);
    }
  }
  setPerf(level) { this.level = level; this.at = null; }
  // one 16 m cell: instance matrices + colours for its tufts
  gen(ci, cj) {
    const W = this.f.w, CS = 16, x0 = ci * CS, z0 = cj * CS, loc = W.loc, wl = W.waterLevel, r = mulberry32(hash2(ci, cj, 977)), nz = W.noise;
    const desert = this.desert, n = Math.round(CS * CS * this.P.per * (desert ? 0.5 : 1));
    const cc = [0, 1].flatMap((b) => [0, 1].map((a) => { const x = x0 + a * CS, z = z0 + b * CS, h = W.sampleGrid(x, z), s = 1 - 6 / Math.hypot(W.sampleGrid(x + 6, z) - h, 6, W.sampleGrid(x, z + 6) - h); return W.baseColor(x, z, h, s, new THREE.Color()); }));
    const F = this.f.forestAt(x0 + CS / 2, z0 + CS / 2);
    const roadNear = W.nearRoad(x0 + CS / 2, z0 + CS / 2, CS * 0.72 + 6), apt = Math.abs(x0 - 140) < 800 && Math.abs(z0) < 1500;
    const g = [], gc = [], e = [], ec = [], fe = [], fc = [], c = new THREE.Color(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0), p = new V3(), sc = new V3();
    const white = new THREE.Color(1, 1, 1), straw = desert ? lin(0.42, 0.33, 0.17) : lin(0.32, 0.36, 0.14);
    for (let i = 0; i < n; i++) {
      const fx = r(), fz = r(), u = r(), u2 = r(), x = x0 + fx * CS, z = z0 + fz * CS;
      // clumping: dense patches and thin bits
      const cl = nz.n2(x / 7.3 + 3, z / 7.3) * 0.6 + nz.n2(x / 2.1, z / 2.1) * 0.4;
      if (u < smoothstep(0.1, -0.6, cl) * 0.6) continue;
      const h = W.sampleGrid(x, z); if (h < wl + 0.6) continue;
      if (W.real?.waterAt(x, z, 10) != null) continue; // real rivers (realworld.js)
      if (h > loc.snowline + 40) continue;
      const s = 1 - 3 / Math.hypot(W.sampleGrid(x + 3, z) - h, 3, W.sampleGrid(x, z + 3) - h); if (s > 0.42) continue;
      if (roadNear && W.nearRoad(x, z, 4)) continue;
      if (this.f.bare && this.f.bare(x, z)) continue;
      if (apt && W.groundAt(x, z).type === 'runway') continue;
      c.copy(cc[0]).lerp(cc[1], fx).lerp(c.clone().copy(cc[2]).lerp(cc[3], fx), fz).multiplyScalar(0.95 + u * 0.35); c.lerp(straw, desert ? 0.55 : 0.12 + 0.3 * smoothstep(0.1, 0.6, cl) * u2);
      const isFern = !desert && F > 0.45 && u2 < 0.12 + 0.25 * F;
      const isExtra = !isFern && (desert ? u2 < 0.3 : (u2 < 0.05 + 0.12 * smoothstep(0.35, 0.7, nz.n2(x / 40, z / 40 + 9))) && F < 0.5);
      if (isExtra && !desert) c.lerp(white, 0.55);
      if (isFern) c.set(0.85, 0.9, 0.75).multiplyScalar(0.7 + u * 0.35);
      const k = (isFern ? 0.8 : 0.6) + u * 0.8; q.setFromAxisAngle(up, u2 * 40); sc.set(k, k * (0.7 + fx * 0.6), k); m.compose(p.set(x, h - 0.05, z), q, sc);
      if (isFern) { m.toArray(fe, fe.length); fc.push(c.r, c.g, c.b); } else if (isExtra) { m.toArray(e, e.length); ec.push(c.r, c.g, c.b); } else { m.toArray(g, g.length); gc.push(c.r, c.g, c.b); }
    }
    return { g: new Float32Array(g), gc: new Float32Array(gc), e: new Float32Array(e), ec: new Float32Array(ec), f: new Float32Array(fe), fc: new Float32Array(fc) };
  }
  update(cam) {
    if (!this.P) return;
    const W = this.f.w, agl = cam.y - Math.max(W.sampleGrid(cam.x, cam.z), W.waterLevel);
    const on = this.level < 2 && agl < this.P.agl;
    this.grass.visible = this.extra.visible = this.fern.visible = on; if (!on) return;
    const R = this.P.R * (this.level >= 1 ? 0.7 : 1); this.R.value = R;
    const CS = 16, ci = Math.floor(cam.x / CS), cj = Math.floor(cam.z / CS), key = ci + ',' + cj + ':' + R;
    if (this.at === key && !this.pending) return;
    this.at = key; this.pending = false;
    const rc = Math.ceil(R / CS), t0 = performance.now(), list = [];
    for (let i = ci - rc; i <= ci + rc; i++) for (let j = cj - rc; j <= cj + rc; j++) {
      const dx = Math.max(0, Math.abs((i + 0.5) * CS - cam.x) - CS / 2), dz = Math.max(0, Math.abs((j + 0.5) * CS - cam.z) - CS / 2);
      if (dx * dx + dz * dz > R * R) continue;
      const k = i + ',' + j; let c = this.cells.get(k);
      if (!c) { if (performance.now() - t0 > 2.5) { this.pending = true; continue; } c = this.gen(i, j); this.cells.set(k, c); }
      c.used = this.at; list.push(c);
    }
    if (this.cells.size > list.length * 3) for (const [k, c] of this.cells) if (c.used !== this.at) this.cells.delete(k);
    for (const [m, a, b] of [[this.grass, 'g', 'gc'], [this.extra, 'e', 'ec'], [this.fern, 'f', 'fc']]) {
      const cap = m.instanceMatrix.count; let n = 0;
      for (const c of list) { const cnt = Math.min(c[a].length / 16, cap - n); if (cnt <= 0) break; m.instanceMatrix.array.set(c[a].subarray(0, cnt * 16), n * 16); m.instanceColor.array.set(c[b].subarray(0, cnt * 3), n * 3); n += cnt; }
      m.count = n; if (n) upload(m, n);
    }
  }
  dispose() { this.cells.clear(); this.mat?.dispose(); for (const m of [this.grass, this.extra, this.fern]) m?.geometry.dispose(); }
}
