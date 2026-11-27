// Far stand-ins: cheap shapes drawn instead of a detailed model once it is far enough away that the difference is
// under a pixel (the airport's terminal and hangars, its parked airliners, the pattern-flying Kestrel).
import * as THREE from 'three';
import { Builder, C } from './buildings.js';

// near/far switch: `near` drawn within `dist` (metres from `centre`, in this object's frame; at the flight camera's 60°
// field of view: a zoomed-in camera switches further out), `far` beyond, a 5% margin either way so it doesn't flicker
// at the line. The renderer calls update() for isLOD objects, once per frame before drawing.
const _p = new THREE.Vector3();
export class FarLOD extends THREE.Object3D {
  constructor(dist, centre = new THREE.Vector3()) {
    super(); this.isLOD = true; this.autoUpdate = true; this.dist = dist; this.centre = centre; this.isFar = false;
    this.near = new THREE.Group(); this.far = new THREE.Group(); this.far.visible = false; this.add(this.near, this.far);
  }
  update(camera) {
    const k = camera.isPerspectiveCamera ? camera.fov / 60 / (camera.zoom || 1) : 1, d = _p.copy(this.centre).applyMatrix4(this.matrixWorld).distanceTo(camera.position) * k;
    const far = this.isFar ? d > this.dist * 0.95 : d > this.dist * 1.05;
    if (far !== this.isFar) { this.isFar = far; this.near.visible = !far; this.far.visible = far; }
  }
}

// A plane's far stand-in: each part as a prism, the convex outline of its vertices seen along the part's thinnest axis
// (a wing's planform, a fuselage's side profile) cut down to at most 8 corners and extruded through that axis's
// extent, in the colour of the part's biggest piece. objs: the parts' objects (under root); parts under minSize metres
// across are left out. Returns faces [[p0, p1, p2(, p3)], col] in root's frame, counter-clockwise seen from outside.
export function standIn(objs, root, minSize = 0.8) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), toPart = new THREE.Matrix4(), m = new THREE.Matrix4(), v = new THREE.Vector3(), faces = [];
  for (const o of objs) {
    if (!o) continue;
    toPart.copy(o.matrixWorld).invert();
    const P = [], sum = [0, 0, 0, 0];
    o.traverse((c) => {
      if (!c.isMesh || !c.visible || c.userData.isDisc || !c.geometry?.attributes.position) return;
      m.multiplyMatrices(toPart, c.matrixWorld);
      const A = c.geometry.attributes.position, step = Math.max(1, Math.floor(A.count / 1500));
      for (let k = 0; k < A.count; k += step) { v.fromBufferAttribute(A, k).applyMatrix4(m); P.push(v.x, v.y, v.z); }
      const mat = Array.isArray(c.material) ? c.material[0] : c.material; if (!mat?.color || mat.transparent) return;
      const ar = area(c.geometry) * Math.abs(c.matrixWorld.determinant()) ** (2 / 3), t = mapAvg(mat.map); // (its surface, in the colour it's drawn: the material's times its texture's average)
      // glossy paint mirrors the sky, and a far plane is seen at a low angle: lighter and bluer than its colour (the
      // stand-in's plain cell doesn't reflect), by about this much at the switch distance
      const gl = (mat.clearcoat ?? 0) > 0 || mat.roughness < 0.45 ? GLOSS : 0;
      for (let i = 0; i < 3; i++) sum[i] += ar * ((1 - gl) * mat.color[RGB[i]] * (t?.[RGB[i]] ?? 1) + gl * SKY[i]);
      sum[3] += ar;
    });
    if (!P.length || !(sum[3] > 0)) continue;
    const col = _col.setRGB(sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]).getHex();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[k + a]); hi[a] = Math.max(hi[a], P[k + a]); }
    const ext = [0, 1, 2].map((a) => hi[a] - lo[a]); if (Math.max(...ext) < minSize) continue;
    const a = ext.indexOf(Math.min(...ext)), u = (a + 1) % 3, w = (a + 2) % 3; // (u, w, a) right-handed
    let H = hull2(P, u, w);
    while (H.length > 8) { // drop the corner that changes the outline least
      let bi = 0, ba = Infinity;
      for (let i = 0; i < H.length; i++) { const p = H[(i + H.length - 1) % H.length], q = H[i], r = H[(i + 1) % H.length], ar = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])); if (ar < ba) { ba = ar; bi = i; } }
      H.splice(bi, 1);
    }
    if (H.length < 3) continue;
    m.multiplyMatrices(inv, o.matrixWorld); const flip = m.determinant() < 0;
    const pt = (h, y) => { const q = [0, 0, 0]; q[u] = h[0]; q[w] = h[1]; q[a] = y; return v.set(q[0], q[1], q[2]).applyMatrix4(m).toArray(); };
    const top = H.map((h) => pt(h, hi[a])), bot = H.map((h) => pt(h, lo[a])), add = (f) => faces.push([flip ? f.reverse() : f, col]);
    for (let i = 1; i + 1 < H.length; i++) { add([top[0], top[i], top[i + 1]]); add([bot[0], bot[i + 1], bot[i]]); }
    if (ext[a] > 0.05) for (let i = 0; i < H.length; i++) { const j = (i + 1) % H.length; add([bot[i], bot[j], top[j], top[i]]); }
  }
  return faces;
}
const RGB = ['r', 'g', 'b'], SKY = [0.58, 0.66, 0.76], GLOSS = 0.35;
const _col = new THREE.Color(), _tri = new THREE.Triangle(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function area(g) {
  const A = g.attributes.position, I = g.index, n = I ? I.count : A.count; let s = 0;
  for (let k = 0; k + 2 < n; k += 3) { const i = I ? I.getX(k) : k, j = I ? I.getX(k + 1) : k + 1, l = I ? I.getX(k + 2) : k + 2; s += _tri.set(_a.fromBufferAttribute(A, i), _b.fromBufferAttribute(A, j), _c.fromBufferAttribute(A, l)).getArea(); }
  return s;
}
// a texture's average colour (linear), from its image drawn 8 x 8 (null where there's no canvas: Node)
const _avg = new WeakMap();
function mapAvg(t) {
  if (!t?.image) return null;
  if (_avg.has(t)) return _avg.get(t);
  let c = null;
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 8; const g = cv.getContext('2d'); g.drawImage(t.image, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data, s = [0, 0, 0]; for (let k = 0; k < d.length; k += 4) for (let i = 0; i < 3; i++) s[i] += d[k + i] / 255 / 64;
    c = new THREE.Color().setRGB(s[0], s[1], s[2], t.colorSpace === THREE.SRGBColorSpace ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace);
  } catch { c = null; }
  _avg.set(t, c); return c;
}
// convex hull (counter-clockwise) of the points' (u, w) coordinates: Andrew's monotone chain
function hull2(P, u, w) {
  const pts = []; for (let k = 0; k < P.length; k += 3) pts.push([P[k + u], P[k + w]]);
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop(); return lo.concat(up);
}
// stand-in faces into a Builder (the towns' building atlas: plain painted cells), framed at (x, y, z, yaw)
export function standInInto(B, faces, x = 0, y = 0, z = 0, yaw = 0) {
  B.setFrame(x, y, z, yaw);
  for (const [f, col] of faces) B._poly(f, f.length === 3 ? [0, 0, 1, 0, 0, 1] : [0, 0, 1, 0, 1, 1, 0, 1], C.TRIM, col);
}
export function standInMesh(faces, mat) { const B = new Builder(); standInInto(B, faces); return new THREE.Mesh(B.toGeometry(), mat); }
