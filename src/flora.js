// Vegetation, rocks and ground cover.
//  - Trees are built from alpha-tested cards (needle sprays, leaf clusters, palm fronds) painted into a
//    procedural texture atlas at start-up (no downloads), several variants per species, instanced.
//  - Placement is streamed in 275 m cells around the camera from a deterministic candidate sequence:
//    cells near the camera evaluate all candidates (dense forest), far cells only the first few (a sparse
//    subset of the same trees), so nothing pops when a cell goes dense. Works on the endless outer tiles too.
//  - LOD: near (shadow casting) / mid (full model) / far (one camera-facing impostor quad per tree, all trees in
//    ONE draw call). The impostor atlas is rendered from the real models once per flight.
//  - Ground cover: grass tufts / flowers / desert scrub in a ring around the camera when flying low.
// All generation is time-sliced (a few ms per frame) so streaming never hitches, even on a tablet.
import * as THREE from 'three';
import { mulberry32, smoothstep } from './noise.js';
import { FOG, swayMaterial } from './shaders.js';

const V3 = THREE.Vector3;
const CELL = 275; // 22000 / 80: cells tile the core map and the 5500 m outer tiles exactly
const STRIDE = 6; // per instance: x, y, z, scale, variant, yaw
const AT = 1024; // foliage atlas size
// [u0, v0, u1, v1] of an atlas region in canvas pixels (the DataTexture is not flipped: v0 is the top row)
const px = (x, y, w, h) => [x / AT, y / AT, (x + w) / AT, (y + h) / AT];
const UV = { spray: px(0, 0, 512, 512), leaf: px(512, 0, 512, 512), frond: px(0, 512, 512, 512), grass: px(512, 512, 512, 256), flower: px(512, 768, 256, 256), scrub: px(768, 768, 192, 256), white: [992 / AT, 800 / AT] };
const REGIONS = [[0, 0, 512, 512], [512, 0, 512, 512], [0, 512, 512, 512], [512, 512, 512, 256], [512, 768, 256, 256], [768, 768, 256, 256]];

const TIER = {
  low: { cand: 200, base: 30, dense: 1300, far: 5000, lo: 200, near: 120, budget: 2, imp: 40000 },
  medium: { cand: 360, base: 45, dense: 2200, far: 6000, lo: 280, near: 160, budget: 3, imp: 70000 },
  high: { cand: 560, base: 100, dense: 3200, far: 9500, lo: 480, near: 200, budget: 5, imp: 140000 },
};
const GRASS = { low: null, medium: { R: 60, per: 1 / 2.6, cap: 8000 }, high: { R: 95, per: 1 / 1.7, cap: 30000 } };

// ---------------------------------------------------------------- procedural foliage atlas
let ATLAS = null;
function foliageAtlas() {
  if (ATLAS) return ATLAS;
  const cv = document.createElement('canvas'); cv.width = cv.height = AT;
  const g = cv.getContext('2d'), r = mulberry32(4242);
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const line = (x0, y0, x1, y1, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  g.lineCap = 'round';
  { // conifer branch spray: twig from the trunk (left) to the tip (right), side twigs covered in needles
    const S = 512, cy = S / 2, x0 = 10, len = S - 30;
    const env = (t) => S * 0.4 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08 + 0.04)), 0.6) * (1 - 0.3 * t);
    g.fillStyle = hsl(135, 35, 10); g.beginPath(); g.moveTo(x0, cy); // dark body so it reads solid from afar
    for (let t = 0; t <= 1.0001; t += 0.05) g.lineTo(x0 + t * len, cy - env(t) * 0.6 * (0.85 + 0.3 * r()));
    for (let t = 1; t >= -0.0001; t -= 0.05) g.lineTo(x0 + t * len, cy + env(t) * 0.6 * (0.85 + 0.3 * r()));
    g.closePath(); g.fill();
    const needles = (xa, ya, dx, dy, L, light) => {
      const ux = dx / L, uy = dy / L;
      for (let s = 0; s < L; s += 2.7) {
        const x = xa + ux * s, y = ya + uy * s, nl = 7 + r() * 7, tip = s / L > light;
        for (const side of [-1, 1]) {
          const a = (0.85 + r() * 0.5) * side, ca = Math.cos(a), sa = Math.sin(a), nx = ux * ca - uy * sa, ny = ux * sa + uy * ca;
          g.strokeStyle = tip ? hsl(95 + r() * 15, 32, 32 + r() * 12) : hsl(118 + r() * 25, 18 + r() * 14, 14 + r() * 17);
          g.lineWidth = 2.1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + nx * nl, y + ny * nl); g.stroke();
        }
      }
    };
    for (let t = 0.04; t < 0.97; t += 0.045) for (const side of [-1, 1]) {
      const x = x0 + t * len + r() * 8, a = 0.55 + r() * 0.35, L = env(t) * (0.85 + r() * 0.2) / Math.sin(a), dx = Math.cos(a) * L, dy = side * Math.sin(a) * L;
      line(x, cy, x + dx, cy + dy, 2.5, hsl(25, 30, 18)); needles(x, cy, dx, dy, L, 0.72);
    }
    line(x0, cy, x0 + len, cy, 4, hsl(25, 30, 18)); needles(x0, cy, len, 0.0001, len, 0.85);
  }
  { // broadleaf cluster: hundreds of small leaves around a dark core, lighter on top
    const S = 512, cx = 512 + S / 2, cy = S / 2;
    g.fillStyle = hsl(105, 35, 11); g.beginPath();
    for (let k = 0; k <= 26; k++) { const a = (k / 26) * Math.PI * 2, rr = S * (0.25 + r() * 0.09); g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    g.fill();
    for (let i = 0; i < 460; i++) {
      const a = r() * Math.PI * 2, rr = S * 0.44 * Math.sqrt(r()), x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr, top = 1 - y / S;
      const L = 11 + r() * 12;
      g.fillStyle = hsl(80 + r() * 38, 24 + r() * 18, 14 + top * 18 + r() * 14 + (i / 460) * 8);
      g.beginPath(); g.ellipse(x, y, L, L * (0.38 + r() * 0.15), r() * Math.PI, 0, Math.PI * 2); g.fill();
    }
  }
  { // palm frond: rachis along x, long leaflets swept towards the tip
    const S = 512, oy = 512, cy = oy + S / 2;
    for (let t = 0.03; t < 1; t += 0.0105) for (const side of [-1, 1]) {
      const x = 6 + t * (S - 14), L = S * 0.46 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)), 0.7) * (1 - 0.35 * t) * (0.85 + r() * 0.2);
      const a = 1.0 + r() * 0.18, ex = x + Math.cos(a) * L * 0.8, ey = cy + side * Math.sin(a) * L;
      g.fillStyle = hsl(78 + r() * 26, 42 + r() * 18, 20 + r() * 18);
      g.beginPath(); g.moveTo(x - 3, cy); g.quadraticCurveTo((x + ex) / 2 + 5, (cy + ey) / 2, ex, ey); g.lineTo(x + 4, cy); g.fill();
    }
    line(6, cy, S - 8, cy, 5, hsl(55, 40, 36));
  }
  const blades = (ox, oy, W, H, n, spread, lo, hi) => {
    for (let i = 0; i < n; i++) {
      const bx = ox + W / 2 + (r() - 0.5) * W * spread, by = oy + H, h = H * (0.4 + r() * 0.57), lean = (r() - 0.5) * W * 0.35 + (bx - ox - W / 2) * 0.9;
      const tx = bx + lean, ty = by - h, w = 5 + r() * 4;
      const grd = g.createLinearGradient(0, by, 0, ty);
      grd.addColorStop(0, hsl(75, 18, lo + r() * 10)); grd.addColorStop(1, hsl(62 + r() * 22, 30, hi + r() * 18));
      g.fillStyle = grd; g.beginPath(); g.moveTo(bx - w / 2, by);
      g.quadraticCurveTo(bx + lean * 0.3, by - h * 0.6, tx, ty); g.quadraticCurveTo(bx + lean * 0.3 + w * 0.4, by - h * 0.6, bx + w / 2, by); g.fill();
    }
  };
  blades(512, 512, 512, 256, 110, 0.55, 30, 62); // grass tuft (pale: tinted per instance with the ground colour)
  blades(512, 768, 256, 256, 30, 0.6, 32, 60); // meadow flowers
  for (let i = 0; i < 16; i++) {
    const x = 512 + 128 + (r() - 0.5) * 190, y = 768 + 40 + r() * 120, rr = 6 + r() * 5, hue = [0, 50, 280, 45, 0][i % 5], l = i % 5 === 0 || i % 5 === 4 ? 95 : 65;
    g.fillStyle = hsl(hue, i % 5 === 0 ? 0 : 80, l); for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; g.beginPath(); g.arc(x + Math.cos(a) * rr * 0.6, y + Math.sin(a) * rr * 0.6, rr * 0.55, 0, 7); g.fill(); }
    g.fillStyle = hsl(48, 90, 55); g.beginPath(); g.arc(x, y, rr * 0.35, 0, 7); g.fill();
  }
  { // desert scrub (sage / creosote): twiggy bush with small grey-green leaves
    const branch = (x, y, a, L, d) => {
      const ex = x + Math.cos(a) * L, ey = y - Math.sin(a) * L;
      line(x, y, ex, ey, Math.max(1.2, d * 1.2), hsl(30, 18, 28));
      if (d > 0) for (let k = 0; k < 2 + (r() < 0.5 ? 1 : 0); k++) branch(ex, ey, a + (r() - 0.5) * 1.1, L * (0.6 + r() * 0.2), d - 1);
      else for (let k = 0; k < 9; k++) { g.fillStyle = hsl(80 + r() * 30, 14 + r() * 14, 38 + r() * 22); g.beginPath(); g.ellipse(ex + (r() - 0.5) * 22, ey + (r() - 0.5) * 22, 5, 3, r() * 3, 0, 7); g.fill(); }
    };
    for (let k = 0; k < 6; k++) branch(768 + 96 + (r() - 0.5) * 30, 768 + 252, Math.PI / 2 + (r() - 0.5) * 1.4, 70, 3);
  }
  g.fillStyle = '#fff'; g.fillRect(960, 768, 64, 64); // solid texel for trunks and cactus
  // fill transparent texels with each region's average colour so mipmaps don't darken the card edges
  const img = g.getImageData(0, 0, AT, AT), d = img.data;
  for (const [x0, y0, w, h] of REGIONS) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = y0; y < y0 + h; y += 2) for (let x = x0; x < x0 + w; x += 2) { const k = (y * AT + x) * 4; if (d[k + 3] > 200) { sr += d[k]; sg += d[k + 1]; sb += d[k + 2]; n++; } }
    if (!n) continue; sr /= n; sg /= n; sb /= n;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const k = (y * AT + x) * 4; if (d[k + 3] < 10) { d[k] = sr; d[k + 1] = sg; d[k + 2] = sb; } }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer), AT, AT, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.needsUpdate = true;
  return (ATLAS = tex);
}

// ---------------------------------------------------------------- geometry building
class GB {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; }
  v(p, n, u, v, c) { this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.t.push(u, v); this.c.push(c.r, c.g, c.b); return this.p.length / 3 - 1; }
  // a three.js geometry, vertex coloured, using the atlas' solid white texel
  geo(g, colFn) {
    const base = this.p.length / 3, P = g.attributes.position, N = g.attributes.normal, c = new THREE.Color();
    for (let k = 0; k < P.count; k++) { this.p.push(P.getX(k), P.getY(k), P.getZ(k)); this.n.push(N.getX(k), N.getY(k), N.getZ(k)); this.t.push(UV.white[0], UV.white[1]); colFn(c, P.getX(k), P.getY(k), P.getZ(k)); this.c.push(c.r, c.g, c.b); }
    if (g.index) for (const k of g.index.array) this.i.push(base + k); else for (let k = 0; k < P.count; k++) this.i.push(base + k);
  }
  // a strip card along a spine: u runs along the spine, v across (left -> right)
  card(pts, side, widths, uv, colFn, nrmFn) {
    const c = new THREE.Color(), q = new V3(); let prev = null;
    pts.forEach((p, k) => {
      const t = k / (pts.length - 1), u = uv[0] + (uv[2] - uv[0]) * t, w = widths[k] / 2;
      const L = q.copy(p).addScaledVector(side, -w), a = this.v(L, nrmFn(L), u, uv[1], colFn(c, L, t));
      const R = q.copy(p).addScaledVector(side, w), b = this.v(R, nrmFn(R), u, uv[3], colFn(c, R, t));
      if (prev) this.i.push(prev[0], a, prev[1], prev[1], a, b);
      prev = [a, b];
    });
  }
  // a free quad centred at p with axes ax/ay (half extents included)
  quad(p, ax, ay, uv, col, nrmFn) { // -ay edge maps to the bottom of the atlas region
    const c = col, q = new V3();
    const k = [[-1, -1, uv[0], uv[3]], [1, -1, uv[2], uv[3]], [1, 1, uv[2], uv[1]], [-1, 1, uv[0], uv[1]]]
      .map(([sx, sy, u, v]) => { q.copy(p).addScaledVector(ax, sx).addScaledVector(ay, sy); return this.v(q, nrmFn(q), u, v, c); });
    this.i.push(k[0], k[1], k[2], k[0], k[2], k[3]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
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
const barkFn = (col, v = 0.25) => (c, x, y, z) => c.copy(col).multiplyScalar(1 - v + v * Math.sin(y * 5.3 + x * 9 + z * 7));
// a cluster of randomly oriented leaf cards (broadleaf crowns, junipers, shrubs)
function cluster(b, r, c0, s, n, uv, tint, cen, Rc, Htop, nrm) {
  const col = new THREE.Color(), p = new V3(), nn = new V3();
  for (let q = 0; q < n; q++) {
    p.copy(c0).addScaledVector(randUnit(r), s * 0.45);
    randUnit(r, nn); nn.y = Math.abs(nn.y) * 0.6 + 0.2; nn.normalize();
    const ax = perp(nn), ay = new V3().crossVectors(nn, ax), sz = s * (0.6 + r() * 0.25), rot = r() * Math.PI;
    const ax2 = ax.clone().multiplyScalar(Math.cos(rot)).addScaledVector(ay, Math.sin(rot)).multiplyScalar(sz), ay2 = new V3().crossVectors(nn, ax2);
    const out = Math.min(1, p.distanceTo(cen) / Rc);
    col.copy(tint).multiplyScalar(0.42 + 0.38 * Math.min(1, p.y / Htop) + 0.3 * out);
    b.quad(p, ax2, ay2, uv, col, nrm);
  }
}

const SPECIES = {
  spruce(r, o) {
    const b = new GB(), H = (o.h || 17) + r() * 10, Rm = H * (o.w || 0.21) * (0.85 + r() * 0.3), base = H * (0.05 + r() * 0.1);
    const tint = lin(...(o.tint || [0.6, 0.52, 0.55])), cy = H * 0.4, tmp = new V3();
    const nrm = (p) => tmp.set(p.x, (p.y - cy) * 0.25 + Rm * 0.6, p.z).normalize();
    b.geo(limb(new V3(), new V3(0, H * 0.97, 0), H * 0.016 + 0.15, 0.05, 6), barkFn(lin(0.15, 0.1, 0.07)));
    b.geo(new THREE.ConeGeometry(Rm * 0.42, H * 0.86 - base, 7, 1, true).translate(0, base + (H * 0.86 - base) / 2 + 0.5, 0), (c) => c.setRGB(0.022, 0.04, 0.024));
    const nW = 12 + Math.floor(r() * 4);
    for (let w = 0; w < nW; w++) {
      const t = w / (nW - 1), y = base + 0.8 + (H * 0.95 - base - 0.8) * Math.pow(t, 0.95);
      const L = Rm * Math.pow(1 - t, 0.95) * (0.85 + r() * 0.3) + 0.7, nb = t > 0.85 ? 3 : 5 + (r() < 0.5 ? 1 : 0);
      const droop = 0.12 + 0.35 * (1 - t), ao = 0.55 + 0.45 * t;
      for (let k = 0; k < nb; k++) {
        const a = (k / nb) * Math.PI * 2 + w * 2.4 + r() * 0.5, dir = new V3(Math.cos(a), 0, Math.sin(a));
        const p0 = dir.clone().multiplyScalar(0.15).setY(y), p1 = dir.clone().multiplyScalar(L * 0.5).setY(y + L * (0.05 - droop * 0.25)), p2 = dir.clone().multiplyScalar(L).setY(y - L * droop + L * 0.04);
        const roll = (r() - 0.5) * 1.3, side = new V3(-dir.z, 0, dir.x).multiplyScalar(Math.cos(roll)).add(new V3(0, Math.sin(roll), 0));
        const wd = L * 0.95;
        b.card([p0, p1, p2], side, [wd * 0.7, wd, wd * 0.8], UV.spray, (c, p, s) => c.copy(tint).multiplyScalar(ao * (0.55 + 0.45 * s)), nrm);
      }
    }
    for (let k = 0; k < 2; k++) { // leader
      const a = k * Math.PI / 2, side = new V3(Math.cos(a), 0, Math.sin(a));
      b.card([new V3(0, H * 0.84, 0), new V3(0, H * 1.03, 0)], side, [H * 0.07, H * 0.05], UV.spray, (c) => c.copy(tint), nrm);
    }
    return { geo: b.build(), H, R: Rm, sway: 0.25 };
  },
  broadleaf(r, o = {}) {
    const b = new GB(), H = (o.h || 10) + r() * 5, top = new V3((r() - 0.5), H * (o.birch ? 0.45 : 0.5), (r() - 0.5));
    const bark = o.birch ? (c, x, y) => c.setRGB(...(Math.sin(y * 9 + x * 20) > 0.75 ? [0.05, 0.045, 0.04] : [0.62, 0.6, 0.55])) : barkFn(lin(0.11, 0.08, 0.06));
    b.geo(limb(new V3(), top, H * 0.035 + 0.15, H * 0.02, 7), bark);
    const nb = 4 + Math.floor(r() * 3), ends = [];
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + r(), el = 0.5 + r() * 0.6, L = H * (0.25 + r() * 0.17);
      const end = top.clone().add(new V3(Math.cos(a) * Math.cos(el) * L, Math.sin(el) * L, Math.sin(a) * Math.cos(el) * L));
      b.geo(limb(top.clone().setY(top.y * (0.8 + r() * 0.2)), end, H * 0.018, H * 0.008, 5), bark); ends.push(end);
    }
    ends.push(top.clone().setY(H * 0.85), top.clone().add(new V3((r() - 0.5) * H * 0.3, H * 0.15, (r() - 0.5) * H * 0.3)));
    const cen = new V3(0, H * 0.68, 0), Rc = H * 0.35, tint = lin(...(o.tint || [0.58, 0.5, 0.34])), tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY((p.y - cen.y) + Rc * 0.5).normalize();
    for (const c0 of ends) { const s = H * (0.2 + r() * 0.08) * (o.birch ? 0.75 : 1); cluster(b, r, c0, s * 1.6, o.birch ? 5 : 6, o.uv || UV.leaf, tint, cen, Rc, H, nrm); }
    return { geo: b.build(), H, R: Rc, sway: 0.3 };
  },
  juniper(r, o = {}) { // small gnarled desert conifer: short twisted stems, blue-green spray clumps
    const b = new GB(), H = 3 + r() * 4, tint = lin(...(o.tint || [0.6, 0.4, 0.45])), cen = new V3(0, H * 0.55, 0), Rc = H * 0.45, tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY(p.y - cen.y + Rc * 0.5).normalize();
    for (let k = 0; k < 2; k++) b.geo(limb(new V3(), new V3((r() - 0.5) * H * 0.4, H * 0.5, (r() - 0.5) * H * 0.4), 0.18, 0.08, 5), barkFn(lin(0.17, 0.12, 0.09)));
    const n = 5 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) { const c0 = randUnit(r).multiply(new V3(Rc * 0.7, Rc * 0.55, Rc * 0.7)).add(cen); cluster(b, r, c0, H * 0.32, 4, UV.spray, tint, cen, Rc, H, nrm); }
    return { geo: b.build(), H, R: Rc, sway: 0.15 };
  },
  palm(r) {
    const b = new GB(), H = 8 + r() * 7, bend = (r() - 0.5) * 3, segs = 6;
    let prev = new V3();
    for (let k = 1; k <= segs; k++) { const t = k / segs, p = new V3(bend * t * t, H * t, bend * 0.3 * t * t); b.geo(limb(prev, p, 0.3 - 0.1 * t + 0.03, 0.28 - 0.1 * t, 6), (c, x, y) => c.setRGB(0.2, 0.15, 0.1).multiplyScalar(0.8 + 0.3 * Math.sin(y * 7))); prev = p; }
    const crown = prev, tint = lin(0.8, 0.8, 0.62), col = new THREE.Color(), up = new V3(0, 1, 0);
    const nF = 10;
    for (let f = 0; f < nF; f++) {
      const a = (f / nF) * Math.PI * 2 + r() * 0.3, len = 4.2 + r() * 2.2, dk = 0.45 + r() * 0.6, rise = 0.25 + r() * 0.3;
      const dir = new V3(Math.cos(a), 0, Math.sin(a)), side = new V3(-dir.z, 0, dir.x), uv = UV.frond, n = 5;
      let row = null;
      for (let k = 0; k <= n; k++) {
        const t = k / n, c = crown.clone().addScaledVector(dir, len * t).addScaledVector(up, len * (rise * t - dk * t * t)), w = 1.15;
        const nr = dir.clone().multiplyScalar(0.4).add(up).normalize(), u = uv[0] + (uv[2] - uv[0]) * t;
        col.copy(tint).multiplyScalar(0.6 + 0.4 * t);
        const L = c.clone().addScaledVector(side, -w).addScaledVector(up, -0.35 * w), M = c.clone().addScaledVector(up, 0.06), R = c.clone().addScaledVector(side, w).addScaledVector(up, -0.35 * w);
        const ids = [b.v(L, nr, u, uv[1], col), b.v(M, nr, u, (uv[1] + uv[3]) / 2, col), b.v(R, nr, u, uv[3], col)];
        if (row) b.i.push(row[0], ids[0], row[1], row[1], ids[0], ids[1], row[1], ids[1], row[2], row[2], ids[1], ids[2]);
        row = ids;
      }
    }
    for (let k = 0; k < 3; k++) b.geo(new THREE.IcosahedronGeometry(0.2, 0).translate(crown.x + (r() - 0.5) * 0.5, crown.y - 0.35, crown.z + (r() - 0.5) * 0.5), (c) => c.setRGB(0.12, 0.08, 0.03));
    return { geo: b.build(), H: H + 1.5, R: 4, sway: 0.5 };
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
    const b = new GB(), s = (o.s || 1.2) + r() * 1.0, tint = lin(...(o.tint || [0.7, 0.62, 0.45])), cen = new V3(0, s * 0.4, 0), tmp = new V3();
    const nrm = (p) => tmp.subVectors(p, cen).setY(p.y - cen.y + s * 0.6).normalize(), col = new THREE.Color();
    if (o.scrub) { // crossed vertical cards with the twiggy scrub texture
      for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI + r() * 0.3, ax = new V3(Math.cos(a) * s, 0, Math.sin(a) * s); b.quad(new V3(0, s * 0.6, 0), ax, new V3(0, s * 0.6, 0), UV.scrub, col.copy(tint), nrm); }
    } else for (let k = 0; k < 3; k++) cluster(b, r, new V3((r() - 0.5) * s, s * 0.45, (r() - 0.5) * s), s * 1.1, 4, UV.leaf, tint, cen, s, s * 1.2, nrm);
    return { geo: b.build(), H: s * 1.2, R: s, sway: 0.15, small: true };
  },
  dead(r) {
    const b = new GB(), H = 6 + r() * 5, top = new V3(0, H * 0.6, 0), bark = barkFn(lin(0.22, 0.19, 0.16));
    b.geo(limb(new V3(), top, 0.25, 0.12, 5), bark);
    for (let k = 0; k < 5; k++) { const a = r() * 6.28, e = top.clone().add(new V3(Math.cos(a) * 2.5, 1 + r() * 3, Math.sin(a) * 2.5)); b.geo(limb(top.clone().setY(top.y * (0.6 + r() * 0.4)), e, 0.1, 0.03, 4), bark); }
    return { geo: b.build(), H, R: 2.5, sway: 0 };
  },
  rock(r, o = {}) {
    const g = new THREE.IcosahedronGeometry(1, 1), P = g.attributes.position, d = new V3();
    const ph = [r() * 6, r() * 6, r() * 6, r() * 6], sx = 1.1 + r() * 0.5, sy = 0.55 + r() * 0.35;
    for (let i = 0; i < P.count; i++) { // smooth function of direction so shared corners stay welded
      d.set(P.getX(i), P.getY(i), P.getZ(i)).normalize();
      const k = 1 + 0.22 * Math.sin(d.x * 3.1 + ph[0]) * Math.cos(d.z * 2.7 + ph[1]) + 0.14 * Math.sin(d.y * 5.3 + d.x * 4 + ph[2]) + 0.08 * Math.sin(d.z * 9 + ph[3]);
      P.setXYZ(i, d.x * k * sx, Math.max(-0.3, d.y * k * sy), d.z * k);
    }
    g.translate(0, 0.15, 0); g.computeVertexNormals(); // non-indexed: faceted
    const uv = new Float32Array(P.count * 2), col = new Float32Array(P.count * 3), N = g.attributes.normal, tint = lin(...(o.tint || [1, 1, 1])), c = new THREE.Color();
    for (let i = 0; i < P.count; i += 3) { // box mapping per face
      const nx = Math.abs(N.getX(i)), ny = Math.abs(N.getY(i)), nz = Math.abs(N.getZ(i));
      for (let j = i; j < i + 3; j++) {
        const x = P.getX(j), y = P.getY(j), z = P.getZ(j);
        const [u, v] = ny > nx && ny > nz ? [x, z] : nx > nz ? [z, y] : [x, y];
        uv[j * 2] = u * 0.18 + ph[0]; uv[j * 2 + 1] = v * 0.18 + ph[1];
        c.copy(tint).multiplyScalar(0.8 + 0.25 * N.getY(i));
        col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeBoundingBox(); g.computeBoundingSphere();
    return { geo: g, H: 0.9 * sy + 0.15, R: sx, rock: true, sway: 0 };
  },
};

// Which species grow where. dens(h, slope, forest 0..1) = chance per candidate (summed over species).
function biome(loc, wl) {
  const sn = loc.snowline;
  if (loc.id === 'alpine') {
    const tl = (h) => 1 - smoothstep(sn - 380, sn - 130, h), ok = (s, a = 0.35, b = 0.55) => 1 - smoothstep(a, b, s);
    return [
      { sp: 'spruce', variants: 4, dens: (h, s, F) => (F * 0.95 + 0.03) * tl(h) * ok(s) },
      { sp: 'spruce', opts: { h: 12, w: 0.26, tint: [0.66, 0.6, 0.5] }, variants: 1, dens: (h, s, F) => (F * 0.12 + 0.01) * tl(h + 150) * ok(s) },
      { sp: 'broadleaf', variants: 2, dens: (h, s, F) => (F * 0.1 + 0.012) * (1 - smoothstep(350, 550, h)) * ok(s, 0.2, 0.35) },
      { sp: 'broadleaf', opts: { birch: true, h: 8, tint: [0.75, 0.7, 0.4] }, variants: 2, dens: (h, s, F) => (F * 0.08 + 0.02) * (1 - smoothstep(500, 750, h)) * ok(s, 0.25, 0.4) },
      { sp: 'shrub', variants: 1, dens: (h, s) => 0.04 * (1 - smoothstep(sn - 100, sn, h)) * ok(s, 0.4, 0.6) },
      { sp: 'rock', opts: { tint: [0.32, 0.34, 0.4] }, variants: 3, rock: true, dens: (h, s) => (0.035 + 0.3 * smoothstep(0.22, 0.5, s) + 0.16 * smoothstep(sn - 500, sn - 200, h)) * (1 - smoothstep(sn - 120, sn + 40, h)) },
    ];
  }
  if (loc.id === 'islands') return [
    { sp: 'palm', variants: 4, dens: (h, s, F) => (0.4 * (1 - smoothstep(18, 45, h - wl)) + F * 0.15 * (1 - smoothstep(40, 90, h))) * (1 - smoothstep(0.3, 0.5, s)) },
    { sp: 'broadleaf', opts: { h: 10, tint: [0.55, 0.75, 0.5] }, variants: 3, dens: (h, s, F) => (F * 0.9 + 0.04) * smoothstep(wl + 6, wl + 14, h) * (1 - smoothstep(0.45, 0.65, s)) },
    { sp: 'shrub', opts: { tint: [0.55, 0.75, 0.45] }, variants: 2, dens: (h, s) => 0.09 * smoothstep(wl + 1.5, wl + 4, h) * (1 - smoothstep(0.5, 0.7, s)) },
    { sp: 'rock', opts: { tint: [0.55, 0.52, 0.5] }, variants: 2, rock: true, dens: (h, s) => 0.01 + 0.3 * smoothstep(0.3, 0.55, s) },
  ];
  const flat = (s, a = 0.22, b = 0.38) => 1 - smoothstep(a, b, s);
  return [
    { sp: 'saguaro', variants: 3, dens: (h, s) => 0.05 * flat(s) },
    { sp: 'juniper', variants: 2, dens: (h, s, F) => (0.05 + F * 0.12) * flat(s, 0.3, 0.45) },
    { sp: 'shrub', opts: { scrub: true, s: 1.2, tint: [0.62, 0.6, 0.48] }, variants: 2, dens: (h, s) => 0.45 * flat(s, 0.25, 0.4) },
    { sp: 'dead', variants: 1, dens: (h, s) => 0.006 * flat(s) },
    { sp: 'broadleaf', opts: { h: 11, tint: [0.8, 0.7, 0.4] }, variants: 2, dens: (h, s) => 0.7 * (1 - smoothstep(wl + 4, wl + 14, h)) * flat(s, 0.25, 0.4) },
    { sp: 'rock', opts: { tint: [0.85, 0.7, 0.62] }, variants: 4, rock: true, dens: (h, s) => 0.06 + 0.3 * smoothstep(0.2, 0.5, s) },
  ];
}

// ---------------------------------------------------------------- shaders
// shared tweaks for every vegetation material: alpha that survives mipmapping (no thinning with distance),
// lighting that ignores card back-faces, optional hide-beyond-LOD-distance for the mid-range meshes
function vegPatch(mat, { cut = null, key = '' } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    Object.assign(sh.uniforms, FOG);
    if (cut) {
      sh.uniforms.uLoCut = cut;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uLoCut;')
        .replace('#include <project_vertex>', `#ifdef USE_INSTANCING
          if (distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, cameraPosition) > uLoCut) transformed = vec3(0.0);
        #endif
        #include <project_vertex>`);
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `#ifdef USE_MAP
        { vec2 mt = vMapUv * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
          diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; }
      #endif
      #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
  };
  mat.customProgramCacheKey = () => 'veg' + key + (cut ? 'c' : '');
  return mat;
}

// one camera-facing quad per tree, every variant in one draw call; reads its picture from the impostor atlas
function impostorMaterial(tex, uVar, nv, cut) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, { uVar, uLoCut: cut });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute vec4 iPos; attribute vec2 iData; uniform vec4 uVar[${nv}]; uniform float uLoCut; varying float vTint;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vec4 vr = uVar[int(iData.x + 0.5)];
        vec3 toCam = cameraPosition - iPos.xyz; float cDist = length(toCam); vec3 vd = toCam / max(cDist, 1e-3);
        vec3 rr = cross(vec3(0.0, 1.0, 0.0), vd); float rl = dot(rr, rr);
        vec3 bRight = rl > 1e-6 ? rr * inversesqrt(rl) : vec3(1.0, 0.0, 0.0);
        vec3 bUp = normalize(mix(vec3(0.0, 1.0, 0.0), cross(vd, bRight), 0.35));
        vMapUv = vr.xy + uv * vr.z;
        vTint = 0.85 + 0.3 * fract(iData.y * 7.31);`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(bRight * position.x * 1.3 + vec3(0.0, 1.0, 0.0) * (position.y - 0.35) + vd * 0.75);')
      .replace('#include <begin_vertex>', `float bS = vr.w * iPos.w;
        vec3 transformed = iPos.xyz + bRight * position.x * bS + bUp * position.y * bS;
        if (cDist < uLoCut) transformed = iPos.xyz;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vTint;')
      .replace('#include <alphatest_fragment>', `{ vec2 mt = vMapUv * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
          diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; }
        diffuseColor.rgb *= vTint;
        #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
  };
  mat.customProgramCacheKey = () => 'impostor' + nv;
  return mat;
}

const hash2 = (i, j, s) => ((Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(s, 83492791)) >>> 0);
let lastFlora = null;

export class Flora {
  constructor(world) {
    if (lastFlora) lastFlora.dispose(); lastFlora = this; // one flight at a time: free the previous impostor atlas
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const W = world, loc = W.loc, r = mulberry32(loc.seed * 3 + 11);
    this.T = TIER[W.qName] || TIER.medium; this.perfLevel = 0;
    this.loCut = { value: this.T.lo };
    const atlas = foliageAtlas(), rockD = W.detailU.rD.value, rockN = W.detailU.rN.value;
    this.rockTex = rockD;
    // materials
    const mats = {};
    const leafMat = (sway, cut) => mats['l' + sway + cut] || (mats['l' + sway + cut] = vegPatch(swayMaterial(new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 }), sway), { cut: cut ? this.loCut : null, key: 'l' + sway }));
    const rockMat = (cut) => mats['r' + cut] || (mats['r' + cut] = vegPatch(new THREE.MeshStandardMaterial({ map: rockD, normalMap: rockN, vertexColors: true, roughness: 0.95 }), { cut: cut ? this.loCut : null, key: 'r' }));
    // species variants
    this.groups = biome(loc, W.waterLevel); this.vars = [];
    for (const gr of this.groups) {
      gr.vars = [];
      for (let v = 0; v < gr.variants; v++) {
        const m = SPECIES[gr.sp](r, gr.opts || {}), idx = this.vars.length;
        const bb = m.geo.boundingBox, S = Math.max(bb.max.y, 2 * Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z)) * 1.02;
        const V = { idx, sp: gr.sp, model: m, S, rock: !!m.rock, hit: !m.rock, cast: !m.rock && !m.small, nNear: 0, nHi: 0 };
        V.near = this.mkInst(m.geo, m.rock ? rockMat(false) : leafMat(m.sway, false), 64); V.near.castShadow = V.cast && W.q.shadows; V.near.receiveShadow = true;
        V.hi = this.mkInst(m.geo, m.rock ? rockMat(true) : leafMat(m.sway, true), 256); V.hi.receiveShadow = W.qName === 'high';
        gr.vars.push(V); this.vars.push(V);
      }
    }
    // impostor atlas: every variant photographed from the side into one texture
    const NV = this.vars.length, grid = Math.ceil(Math.sqrt(NV)), cs = W.qName === 'low' ? 128 : 256;
    this.impGrid = grid; this.impCell = cs;
    this.impRT = new THREE.WebGLRenderTarget(grid * cs, grid * cs, { colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    this.uVar = { value: this.vars.map((V, i) => new THREE.Vector4((i % grid) / grid, Math.floor(i / grid) / grid, 1 / grid, V.S)) };
    this.capture(atlas);
    this.impMat = impostorMaterial(this.impRT.texture, this.uVar, NV, this.loCut);
    this.impBufs = [this.impBuf(this.T.imp), this.impBuf(this.T.imp)];
    this.imp = new THREE.Mesh(this.impBufs[0].g, this.impMat); this.imp.frustumCulled = false; this.group.add(this.imp);
    // streamed cells
    this.cells = new Map(); this.queue = []; this.wantAt = null; this.nearAt = null; this.impAt = null; this.impDirty = true; this.nearDirty = true; this.frame = 0; this.lastImp = -99;
    this.felled = new Map();
    this.cover = new GroundCover(this);
  }
  mkInst(geo, mat, cap) {
    const m = new THREE.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.count = 0; m.visible = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(m); return m;
  }
  grow(V, which, need) {
    const old = V[which], cap = Math.max(need, old.instanceMatrix.count * 2), m = this.mkInst(old.geometry, old.material, cap);
    m.castShadow = old.castShadow; m.receiveShadow = old.receiveShadow;
    this.group.remove(old); old.dispose(); V[which] = m;
  }
  // impostor instance buffers: two of them, so a rebuild can be spread over frames and swapped in when done
  impBuf(cap) {
    const g = new THREE.InstancedBufferGeometry(), q = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv); g.setAttribute('normal', q.attributes.normal);
    const pos = new Float32Array(cap * 4), data = new Float32Array(cap * 2);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iData', new THREE.InstancedBufferAttribute(data, 2).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    return { g, pos, data, cap };
  }
  // render each variant (unlit albedo) into its atlas cell, side-on, base at the bottom
  capture(atlas) {
    const R = this.w.renderer, rt = this.impRT, cs = this.impCell, grid = this.impGrid;
    const rockReady = !!(this.rockTex.image && (this.rockTex.image.complete !== false) && this.rockTex.image.width);
    const leaf = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
    const rock = new THREE.MeshBasicMaterial({ map: rockReady ? this.rockTex : null, vertexColors: true, color: rockReady ? 0xffffff : 0x8a8580 });
    const scene = new THREE.Scene(), mesh = new THREE.Mesh(undefined, leaf), cam = new THREE.OrthographicCamera();
    scene.add(mesh);
    const prevRT = R.getRenderTarget(), prevAuto = R.autoClear, prevCC = R.getClearColor(new THREE.Color()), prevCA = R.getClearAlpha();
    R.autoClear = false;
    const avg = { leaf: new THREE.Color(0.03, 0.06, 0.03), rock: new THREE.Color(0.3, 0.28, 0.26) };
    this.vars.forEach((V, i) => {
      const S = V.S, x = (i % grid) * cs, y = Math.floor(i / grid) * cs;
      cam.left = -S / 2; cam.right = S / 2; cam.top = S; cam.bottom = 0; cam.near = 0.1; cam.far = S * 4; cam.position.set(0, 0, S * 2); cam.updateProjectionMatrix();
      mesh.geometry = V.model.geo; mesh.material = V.rock ? rock : leaf;
      rt.viewport.set(x, y, cs, cs); rt.scissor.set(x, y, cs, cs); rt.scissorTest = true;
      R.setRenderTarget(rt); R.setClearColor(V.rock ? avg.rock : avg.leaf, 0); R.clear(true, true, false);
      R.render(scene, cam);
    });
    rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height); rt.scissor.set(0, 0, rt.width, rt.height);
    R.setRenderTarget(prevRT); R.autoClear = prevAuto; R.setClearColor(prevCC, prevCA);
    leaf.dispose(); rock.dispose();
    this.rockCaptured = rockReady; this.atlasRef = atlas;
  }

  // ------------------------------------------------ placement
  key(i, j) { return i + ',' + j; }
  // Evaluate the cell's deterministic candidate sequence. The first T.base candidates form the sparse far layer;
  // a dense cell evaluates all T.cand, so its trees are a superset of its far trees (same positions).
  genCell(cell, dense) {
    const W = this.w, T = this.T, x0 = cell.ci * CELL, z0 = cell.cj * CELL, wl = W.waterLevel;
    const r = mulberry32(hash2(cell.ci, cell.cj, W.loc.seed)), nC = dense ? T.cand : T.base;
    const out = [];
    const pad = 400, towns = W.net.towns.filter((t) => Math.abs(t.c.x - x0 - CELL / 2) < CELL / 2 + 360 * t.size + pad && Math.abs(t.c.z - z0 - CELL / 2) < CELL / 2 + 360 * t.size + pad);
    const fields = W.net.fields.filter((f) => Math.abs(f.x - x0 - CELL / 2) < CELL / 2 + f.sx + f.sz && Math.abs(f.z - z0 - CELL / 2) < CELL / 2 + f.sx + f.sz);
    const roadNear = W.nearRoad(x0 + CELL / 2, z0 + CELL / 2, CELL * 0.72 + 14);
    const airport = x0 + CELL > -380 && x0 < 660 && z0 + CELL > -1400 && z0 < 1400;
    const G = this.groups, dens = new Float32Array(G.length);
    let nBase = 0;
    for (let i = 0; i < nC; i++) {
      if (i === T.base) nBase = out.length / STRIDE;
      const x = x0 + r() * CELL, z = z0 + r() * CELL, u = r(), u2 = r(), u3 = r(), u4 = r(), yaw = r() * Math.PI * 2;
      if (airport && Math.abs(x - 140) < 520 && Math.abs(z) < 1400) continue;
      const h = W.sampleGrid(x, z); if (h < wl + 0.7) continue;
      const hx = W.sampleGrid(x + 4, z), hz = W.sampleGrid(x, z + 4), s = 1 - 4 / Math.hypot(hx - h, 4, hz - h);
      const F = smoothstep(-0.02, 0.18, W.noise.fbm(x / 260 + 7, z / 260, 3));
      let tot = 0; for (let k = 0; k < G.length; k++) { dens[k] = Math.max(0, G[k].dens(h, s, F)); tot += dens[k]; }
      if (u >= Math.min(1, tot)) continue;
      if (towns.length && towns.some((t) => (t.c.x - x) ** 2 + (t.c.z - z) ** 2 < (360 * t.size) ** 2)) continue;
      if (fields.length && fields.some((f) => Math.abs(x - f.x) < f.sx + f.sz && Math.abs(z - f.z) < f.sx + f.sz)) continue;
      if (roadNear && W.nearRoad(x, z, 11)) continue;
      let t = u2 * tot, k = 0; while (k < G.length - 1 && (t -= dens[k]) > 0) k++;
      const gr = G[k], V = gr.vars[Math.floor(u3 * gr.vars.length)];
      if (gr.rock) {
        const sc = 1.0 + u4 * u4 * 5;
        out.push(x, h - s * sc * 0.6, z, sc, V.idx, yaw);
        const ns = Math.floor(u4 * 7) % 4; // a few smaller stones around the bigger ones
        for (let q = 0; q < ns; q++) {
          const a = yaw * 3 + q * 2.1, d = sc * (1.2 + ((q * 0.37 + u) % 1) * 1.4), xx = x + Math.cos(a) * d, zz = z + Math.sin(a) * d, s2 = sc * (0.25 + ((u2 + q * 0.29) % 1) * 0.3);
          out.push(xx, W.sampleGrid(xx, zz) - s * s2 * 0.6, zz, s2, gr.vars[(V.idx + q + 1) % gr.vars.length].idx, yaw + q);
        }
      } else out.push(x, h - 0.2 - s * 1.5, z, 0.72 + u4 * 0.56, V.idx, yaw);
    }
    if (nC <= T.base) nBase = out.length / STRIDE;
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
      if (c.data && c.tile !== undefined && c.tile !== this.tileOf(c)) c.data = null; // the ground under it was re-meshed
      if (c.data && !dense && c.dense) { c.dense = false; c.n = c.nBase; c.data = c.data.slice(0, c.nBase * STRIDE); this.impDirty = true; }
      if (!c.data || (dense && !c.dense)) { c.wantDense = dense; want.push(c); }
    }
    for (const [key, c] of this.cells) if (c.mark !== this.frame && c.d > Rf * 1.05) { this.cells.delete(key); this.impDirty = true; }
    // sparse far layer first everywhere close, then densify nearest-first
    this.queue = want.sort((a, b) => a.d - b.d);
  }
  update(cam, budgetMs) {
    this.frame++;
    if (!this.wantAt || this.wantAt.distanceToSquared(cam) > 150 * 150 || this.tilesDirty) { this.tilesDirty = false; this.wantAt = cam.clone(); this.plan(cam); }
    if (!this.rockCaptured && this.rockTex.image && this.rockTex.image.width) this.capture(this.atlasRef);
    // time-sliced generation
    const t0 = performance.now(), budget = budgetMs ?? (this.started ? this.T.budget : 40); this.started = true;
    while (this.queue.length && performance.now() - t0 < budget) {
      const c = this.queue.shift();
      if (!this.cells.has(c.key)) continue;
      if (this.tileOf(c) === undefined) continue; // outer tile not built yet: try again when it is
      this.genCell(c, c.wantDense);
      this.impDirty = true; if (c.d < this.T.lo + 600) this.nearDirty = true;
    }
    this.updateNear(cam);
    if (!this.impJob && ((this.impDirty && this.frame - this.lastImp > 12) || !this.impAt || this.impAt.distanceToSquared(cam) > 70 * 70)) this.impJob = this.updateImpostors(cam);
    if (this.impJob) { const t1 = performance.now(), b2 = Math.max(1.2, budget - (t1 - t0)); while (performance.now() - t1 < b2) if (this.impJob.next().done) { this.impJob = null; break; } }
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
          const tn = 0.85 + 0.3 * ((d[o + 5] * 7.31) % 1), ca = m.instanceColor.array; ca[idx * 3] = tn; ca[idx * 3 + 1] = tn; ca[idx * 3 + 2] = tn;
        }
      }
      if (!overflow) break;
      for (const V of vars) { if (V.nNear > V.near.instanceMatrix.count) this.grow(V, 'near', V.nNear * 1.5 | 0); if (V.nHi > V.hi.instanceMatrix.count) this.grow(V, 'hi', V.nHi * 1.5 | 0); V.nNear = V.nHi = 0; }
    }
    for (const V of vars) for (const [m, n] of [[V.near, V.nNear], [V.hi, V.nHi]]) { m.count = n; m.visible = n > 0; if (n) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; } }
  }
  // every tree beyond the LOD distance as one impostor quad (sparse far cells + dense near cells).
  // A generator: fills the back buffer a slice at a time, then swaps it in.
  *updateImpostors(cam) {
    this.impDirty = false; this.impAt = cam.clone(); this.lastImp = this.frame;
    const cx = cam.x, cy = cam.y, cz = cam.z, inner = Math.max(0, this.loCut.value - 110), in2 = inner * inner;
    let B = this.impBufs[1], n = 0, budget = 0;
    for (const c of [...this.cells.values()]) {
      if (!c.data) continue;
      const cnt = c.dense ? c.n : c.nBase, d = c.data;
      const fx = Math.max(Math.abs(c.ci * CELL - cx), Math.abs((c.ci + 1) * CELL - cx)), fz = Math.max(Math.abs(c.cj * CELL - cz), Math.abs((c.cj + 1) * CELL - cz));
      const fy = Math.max(Math.abs(cy - c.y0), Math.abs(cy - c.y1));
      if (fx * fx + fz * fz + fy * fy < in2) continue; // cell entirely inside the full-model range
      if (n + cnt > B.cap) { // grow the back buffer, keeping what's written so far
        const nb = this.impBuf(Math.ceil((n + cnt) * 1.4)); nb.pos.set(B.pos.subarray(0, n * 4)); nb.data.set(B.data.subarray(0, n * 2));
        B.g.dispose(); this.impBufs[1] = B = nb;
      }
      const P = B.pos, D = B.data;
      for (let k = 0; k < cnt; k++) {
        const o = k * STRIDE, x = d[o], y = d[o + 1], z = d[o + 2];
        if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 < in2) continue;
        P[n * 4] = x; P[n * 4 + 1] = y; P[n * 4 + 2] = z; P[n * 4 + 3] = d[o + 3]; D[n * 2] = d[o + 4]; D[n * 2 + 1] = d[o + 5]; n++;
      }
      if ((budget += cnt + 8) > 6000) { budget = 0; yield; }
    }
    const g = B.g; g.instanceCount = n;
    for (const a of [g.attributes.iPos, g.attributes.iData]) { a.clearUpdateRanges?.(); a.addUpdateRange?.(0, n * a.itemSize); a.needsUpdate = true; }
    this.impBufs.reverse(); this.imp.geometry = g;
  }
  setPerf(level) {
    this.perfLevel = level;
    this.loCut.value = this.T.lo * (level >= 2 ? 0.7 : 1);
    this.wantAt = null; this.nearDirty = true; this.impDirty = true;
    this.cover.setPerf(level);
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
  dispose() { this.impRT.dispose(); this.impBufs?.forEach((b) => b.g.dispose()); this.impMat?.dispose(); this.cover?.dispose(); }
}

// ---------------------------------------------------------------- ground cover
// Grass tufts (tinted with the ground's own colour), meadow flowers / desert scrub, in 16 m cells around the camera.
class GroundCover {
  constructor(flora) {
    this.f = flora; const W = flora.w; this.P = GRASS[W.qName] || null; this.level = 0;
    this.cells = new Map(); this.at = null;
    if (!this.P) return;
    this.R = { value: this.P.R };
    const atlas = foliageAtlas();
    const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOG, { uGR: this.R });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uGR;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 gp = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
          transformed *= smoothstep(uGR, uGR * 0.72, distance(gp, cameraPosition));
          float gs = sin(uTime * 1.9 + gp.x * 0.35 + gp.z * 0.21) + 0.4 * sin(uTime * 3.7 + gp.z * 0.5);
          transformed.xz += vec2(gs, gs * 0.6) * 0.12 * transformed.y;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `{ vec2 mt = vMapUv * vec2(textureSize(map, 0)); vec2 dx = dFdx(mt), dy = dFdy(mt);
            diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))) * 0.28; }
          #include <alphatest_fragment>`)
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
    };
    mat.customProgramCacheKey = () => 'groundcover';
    const tuft = (uv, w, h) => { // three crossed cards, normals straight up so they light like the ground
      const b = new GB(), up = new V3(0, 1, 0), c = new THREE.Color(1, 1, 1);
      for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI, ax = new V3(Math.cos(a) * w / 2, 0, Math.sin(a) * w / 2); b.quad(new V3(0, h / 2, 0), ax, new V3(0, h / 2, 0), uv, c, () => up); }
      const g = b.build(); g.deleteAttribute('color'); return g;
    };
    const desert = !!W.loc.desert;
    this.grass = new THREE.InstancedMesh(tuft(UV.grass, 1.2, 0.95), mat, this.P.cap);
    this.extra = new THREE.InstancedMesh(desert ? tuft(UV.scrub, 1.4, 1.1) : tuft(UV.flower, 0.6, 0.45), mat, Math.ceil(this.P.cap / 4));
    for (const m of [this.grass, this.extra]) {
      m.frustumCulled = false; m.count = 0; m.receiveShadow = W.qName === 'high'; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      flora.group.add(m);
    }
  }
  setPerf(level) { this.level = level; this.at = null; }
  // one 16 m cell: instance matrices + colours for its tufts
  gen(ci, cj) {
    const W = this.f.w, CS = 16, x0 = ci * CS, z0 = cj * CS, loc = W.loc, wl = W.waterLevel, r = mulberry32(hash2(ci, cj, 977));
    const desert = !!loc.desert, n = Math.round(CS * CS * this.P.per * (desert ? 0.55 : 1));
    const cc = [0, 1].flatMap((b) => [0, 1].map((a) => { const x = x0 + a * CS, z = z0 + b * CS, h = W.sampleGrid(x, z), s = 1 - 6 / Math.hypot(W.sampleGrid(x + 6, z) - h, 6, W.sampleGrid(x, z + 6) - h); return W.baseColor(x, z, h, s, new THREE.Color()); }));
    const roadNear = W.nearRoad(x0 + CS / 2, z0 + CS / 2, CS * 0.72 + 6), apt = Math.abs(x0 - 140) < 800 && Math.abs(z0) < 1500;
    const g = [], gc = [], e = [], ec = [], c = new THREE.Color(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0), p = new V3(), sc = new V3();
    const white = new THREE.Color(1, 1, 1), straw = desert ? lin(0.42, 0.33, 0.17) : lin(0.3, 0.38, 0.12);
    for (let i = 0; i < n; i++) {
      const fx = r(), fz = r(), u = r(), u2 = r(), x = x0 + fx * CS, z = z0 + fz * CS;
      const h = W.sampleGrid(x, z); if (h < wl + 0.6) continue;
      if (h > loc.snowline + 40) continue;
      const s = 1 - 3 / Math.hypot(W.sampleGrid(x + 3, z) - h, 3, W.sampleGrid(x, z + 3) - h); if (s > 0.42) continue;
      if (roadNear && W.nearRoad(x, z, 4)) continue;
      if (apt && W.groundAt(x, z).type === 'runway') continue;
      c.copy(cc[0]).lerp(cc[1], fx).lerp(c.clone().copy(cc[2]).lerp(cc[3], fx), fz).multiplyScalar(1.25 + u * 0.4); c.lerp(straw, desert ? 0.55 : 0.18 + 0.2 * fz * u2);
      const isExtra = desert ? u2 < 0.3 : u2 < 0.035;
      if (isExtra && !desert) c.lerp(white, 0.6);
      const k = 0.6 + u * 0.8; q.setFromAxisAngle(up, u2 * 40); sc.set(k, k * (0.7 + fx * 0.6), k); m.compose(p.set(x, h - 0.05, z), q, sc);
      if (isExtra) { m.toArray(e, e.length); ec.push(c.r, c.g, c.b); } else { m.toArray(g, g.length); gc.push(c.r, c.g, c.b); }
    }
    return { g: new Float32Array(g), gc: new Float32Array(gc), e: new Float32Array(e), ec: new Float32Array(ec) };
  }
  update(cam) {
    if (!this.P) return;
    const W = this.f.w, agl = cam.y - Math.max(W.sampleGrid(cam.x, cam.z), W.waterLevel);
    const on = this.level < 2 && agl < 150;
    this.grass.visible = this.extra.visible = on; if (!on) return;
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
    for (const [m, a, b] of [[this.grass, 'g', 'gc'], [this.extra, 'e', 'ec']]) {
      const cap = m.instanceMatrix.count; let n = 0;
      for (const c of list) { const cnt = Math.min(c[a].length / 16, cap - n); if (cnt <= 0) break; m.instanceMatrix.array.set(c[a].subarray(0, cnt * 16), n * 16); m.instanceColor.array.set(c[b].subarray(0, cnt * 3), n * 3); n += cnt; }
      m.count = n; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
    }
  }
  dispose() { this.cells.clear(); }
}
