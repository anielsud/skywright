// Crew: seated pilots and drivers with their hands on the controls, and the controls move.
// One figure = two skinned meshes (matte + glossy) sharing one skeleton: two draw calls, whatever the pose. Every
// piece of the figure and of its controls (stick, throttle, yoke, steering wheel, collective, pedals) is rigidly bound
// to one bone, and the bones are posed every frame from the control inputs: the stick / yoke / wheel / pedals move,
// two-bone IK keeps the hands on the grips and the feet on the pedals, and the head looks a little into the turn.
//
// Rig space: origin at the hip point on the seat, forward -Z, up +Y, metres for an adult (the cockpit gives a scale).
// Cockpit builders only declare seats (obj.userData.seats); planeDetail.assemble() dresses them for the vehicle
// (fighter pilot, light-plane pilot with a headset, rescue crew, racing driver, airline crew, astronaut) through addCrew().
// Visual only: nothing here is seen by physics.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from '../vendor/addons/BufferGeometryUtils.js';
import { PARTS } from './parts.js';
import { bodyReady, body, poseBody } from './body.js';
await bodyReady; // (the people's mesh: loaded once, before any figure is built; without it the procedural figure stands in)

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const col = (hex) => new THREE.Color(hex); // linear working colour from sRGB hex

// ---------- materials (shared by every figure) ----------
// Each figure is a few skinned meshes sharing one skeleton, one per material slot: fabric (suits, jerseys: a soft sheen
// and a knit grain), skin, paint (helmet shells: clearcoat), glass (visors, goggle lenses: mirror-like), rubber (gloves,
// boots, soles), metal (buckles, controls) and hair. Colours come from vertex colours, so outfits share the materials.
// Fine surface detail (cloth weave, skin pores, hair strands) is a procedural bump computed from the REST position of
// each vertex (before skinning), so it stays put on the body as the limbs move instead of swimming through the cloth.
let _mats = null;
const BUMP_GLSL = /* glsl */`
  varying vec3 vRest; varying vec3 vRestN;
  float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 crewBump(vec3 n, vec3 viewPos, float h, float k) { // screen-space bump from a scalar height field (k: strength)
    vec3 dpx = dFdx(viewPos), dpy = dFdy(viewPos); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1);
    vec3 g = sign(det) * (dhx * r1 + dhy * r2); return normalize(abs(det) * n - k * g);
  }`;
function crewPatch(m, kind) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRest; varying vec3 vRestN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position; vRestN = normal;');
    const field = {
      // jersey knit: fine crossed ribs plus a soft low-frequency drape (both fade out when smaller than a pixel)
      fabric: 'float fw = length(fwidth(vRest)) * 700.0; float rib = sin(vRest.y * 1400.0 + sin(vRest.x * 900.0) * 1.2) * sin(vRest.x * 1300.0 + vRest.z * 1300.0); float h = mix(rib * 0.3, 0.0, clamp(fw, 0.0, 1.0)) + (vn(vRest * 38.0) - 0.5) * 1.2 + (vn(vRest * 9.0) - 0.5) * 1.6; float k = 0.0008;',
      skin: 'float h = (vn(vRest * 520.0) - 0.5) * 0.25 + (vn(vRest * 90.0) - 0.5) * 0.25; float k = 0.00028;',
      rubber: 'float h = (vn(vRest * 300.0) - 0.5) * 1.0 + (vn(vRest * 30.0) - 0.5) * 1.2; float k = 0.0007;',
      hair: 'float fwh = clamp(length(fwidth(vRest)) * 1500.0, 0.0, 1.0); float h = mix(sin(vRest.x * 2600.0 + vn(vRest * 70.0) * 8.0) * 0.35, 0.0, fwh) + (vn(vRest * vec3(18.0, 30.0, 12.0)) - 0.5) * 1.6; float k = 0.0009;',
      paint: 'float h = (vn(vRest * 900.0) - 0.5) * 0.15; float k = 0.0004;', // orange peel
    }[kind];
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + BUMP_GLSL)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{ ${field} normal = crewBump(normal, -vViewPosition, h, k); }`);
    if (kind === 'skin') sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= vec3(1.0) + (vn(vRest * 28.0) - 0.5) * vec3(0.1, 0.16, 0.16) - (vn(vRest * 7.0) - 0.5) * vec3(-0.04, 0.05, 0.06);`); // blotchy warmth
  };
  m.customProgramCacheKey = () => 'crew-' + kind;
  return m;
}
export function crewMaterials() {
  if (_mats) return _mats;
  const P = (o, kind) => { const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, ...o }); m.name = 'crew_' + kind; return kind ? crewPatch(m, kind) : m; };
  _mats = {
    fabric: P({ roughness: 0.86, metalness: 0, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.35, 0.35, 0.35) }, 'fabric'),
    skin: P({ roughness: 0.5, metalness: 0, specularIntensity: 0.45, sheen: 0.7, sheenRoughness: 0.35, sheenColor: new THREE.Color(0.62, 0.3, 0.22), clearcoat: 0.06, clearcoatRoughness: 0.45 }, 'skin'),
    paint: P({ roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.25 }, 'paint'),
    glass: (() => { const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.04, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.85, iridescenceIOR: 1.6, iridescenceThicknessRange: [180, 520], envMapIntensity: 2.2 }); m.name = 'crew_glass'; return m; })(),
    rubber: P({ roughness: 0.62, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.45 }, 'rubber'),
    metal: (() => { const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 1, envMapIntensity: 1.3 }); m.name = 'crew_metal'; return m; })(),
    hair: P({ roughness: 0.55, metalness: 0, sheen: 1, sheenRoughness: 0.3, sheenColor: new THREE.Color(0.5, 0.45, 0.4) }, 'hair'),
  };
  _mats.matte = _mats.fabric; _mats.gloss = _mats.paint; // older names
  return _mats;
}

// ---------- outfits ----------
// colours: suit, suit2 (vest / trousers), trim (stripes, harness), glove, boot, skin, hair, helmet, helmet2, visor
const SKIN = [0xe0ac8a, 0xb07a55, 0x7a4b32, 0xf0c8a8];
const HAIR = [0x2b1d14, 0x4a3020, 0x111111, 0x8a6a3a];
export const OUTFITS = {
  jet: { head: 'helmet', mask: true, visor: 0x8a6a1e, helmet: 0xdfe2e4, helmet2: 0x4d5560, suit: 0x56603f, suit2: 0x3e4531, trim: 0x2a2c2e, glove: 0x3b2e25, boot: 0x1a1a1a, harness: true },
  space: { head: 'bubble', visor: 0xb08a2a, helmet: 0xf2f2ee, helmet2: 0xc8102e, suit: 0xe9e9e4, suit2: 0xd4d4ce, trim: 0x8a9099, glove: 0xf0f0ea, boot: 0xe2e2dc, harness: false, ring: true },
  light: { head: 'headset', glasses: true, suit: 0x2f5d8a, suit2: 0xb9a57d, trim: 0x2a2c2e, glove: null, boot: 0x3b2a1e, cups: 0x26282b },
  warbird: { head: 'leather', suit: 0x6b4a2e, suit2: 0x5a5f45, trim: 0xd8d2c2, glove: 0x4a3322, boot: 0x2a1d14, harness: true },
  racer: { head: 'helmet', mask: false, visor: 0x1b2127, helmet: 0xf2b705, helmet2: 0x15161a, suit: 0xf2f2ee, suit2: 0xc8102e, trim: 0x15161a, glove: 0x15161a, boot: 0x15161a, harness: true },
  heli: { head: 'helmet', mic: true, visor: 0x14191e, helmet: 0xf2f2ee, helmet2: 0xc8102e, suit: 0xd9531c, suit2: 0x3d3f44, trim: 0xd9dcdf, glove: 0x1d1e20, boot: 0x1a1a1a, stripes: true },
  medic: { head: 'helmet', mic: true, visor: 0x14191e, helmet: 0xf2f2ee, helmet2: 0x2e7d32, suit: 0x2e7d32, suit2: 0x2b2d31, trim: 0xd9dcdf, glove: 0x1d1e20, boot: 0x1a1a1a, stripes: true },
  driver: { head: 'fullface', visor: 0x101418, helmet: 0xe8601c, helmet2: 0x15161a, suit: 0xc8102e, suit2: 0x15161a, trim: 0xf2f2ee, glove: 0x15161a, boot: 0x15161a, harness: true, stripes: true },
  // motorbike riders: a motocross kit (jersey, goggles under a peaked helmet, big boots) and road-racing leathers
  mx: { head: 'fullface', peak: true, visor: 0xd9761c, helmet: 0xf2f2ee, helmet2: 0xe8601c, suit: 0xe8601c, suit2: 0x2b2d31, trim: 0xf2f2ee, glove: 0x15161a, boot: 0xf2f2ee, stripes: true, bigBoots: true },
  sport: { head: 'fullface', visor: 0x1b2127, helmet: 0xf2f2ee, helmet2: 0x1d4e89, suit: 0x1d4e89, suit2: 0xf2f2ee, trim: 0xc8102e, glove: 0x15161a, boot: 0x15161a, stripes: true, hump: true },
  // boats: a cap, sunglasses and an orange life jacket over a T-shirt and shorts-coloured trousers
  boat: { head: 'cap', glasses: true, vest: 0xf26a1b, suit: 0x2f5d8a, suit2: 0x6f7f8f, trim: 0x15161a, glove: null, boot: 0xe8e8e2, cap: 0xf2f2ee, tee: true, shorts: true }, // T-shirt and shorts under the life jacket
  airline: { head: 'headset', shirt: true, suit: 0xf2f2f0, suit2: 0x1b2433, trim: 0x15161a, glove: null, boot: 0x111111, cups: 0x26282b, epaulettes: 0xd4a82a },
};

// ---------- geometry helpers ----------
const UP = V(0, 1, 0), FWD = V(0, 0, -1);
// rotation taking +Y to dir, with local -Z as close as possible to hint (forward)
function basis(dir, hint = FWD, out = new THREE.Quaternion()) {
  const y = dir.clone().normalize(); let h = hint.clone();
  if (Math.abs(h.dot(y)) > 0.97) h = Math.abs(y.y) < 0.9 ? UP.clone() : V(1, 0, 0);
  const z = h.addScaledVector(y, -h.dot(y)).normalize().negate(), x = y.clone().cross(z).normalize();
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// tapered capsule along +Y from 0 to L (radius r0 at the bottom, r1 at the top), optional elliptic section (sx, sz)
function capsule(L, r0, r1 = r0, { sx = 1, sz = 1, seg = 16, ring = 5 } = {}) {
  const pts = [];
  for (let i = 0; i <= ring; i++) { const a = -Math.PI / 2 + (i / ring) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r0, Math.sin(a) * r0)); }
  for (let i = 0; i <= ring; i++) { const a = (i / ring) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r1 + 1e-4, L + Math.sin(a) * r1)); }
  pts[0].x = 1e-4; pts[pts.length - 1].x = 1e-4;
  const g = new THREE.LatheGeometry(pts, seg); g.scale(sx, 1, sz); return g;
}
// capsule from a to b (rig points)
function capAB(a, b, r0, r1 = r0, o = {}) {
  const d = b.clone().sub(a), g = capsule(d.length(), r0, r1, o);
  g.applyMatrix4(new THREE.Matrix4().compose(a, basis(d, o.hint || FWD), V(1, 1, 1))); return g;
}
function ellipsoid(c, rx, ry, rz, { w = 24, h = 16, phi = [0, Math.PI * 2], th = [0, Math.PI] } = {}) {
  const g = new THREE.SphereGeometry(1, w, h, phi[0], phi[1], th[0], th[1]); g.scale(rx, ry, rz); g.translate(c.x, c.y, c.z); return g;
}
// front-facing spherical patch (centre of the patch towards -Z): half-angle a around, theta band t0..t1 from the top
const frontPatch = (r, a, t0, t1, w = 16, h = 6) => new THREE.SphereGeometry(r, w, h, Math.PI * 1.5 - a, a * 2, t0, t1 - t0);
function torusAB(R, r, arc, seg = 24) { return new THREE.TorusGeometry(R, r, 6, seg, arc); }
function boxG(sx, sy, sz, c) { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(c.x, c.y, c.z); return g; }
// A smooth skinned tube through stations (rig space, rest pose): { c: centre, z: depth axis hint, rx, rz, col, b: [bone0, bone1],
// w: weight of bone1 }. Each ring is a superellipse (n = 2 ellipse, larger = squarer); the ends are closed with a domed cap.
// Rings near a joint are shared between the two bones (linear blend skinning), so elbows, knees, the waist and the
// neck bend as one surface instead of separate sticks.
function loft(st0, { seg = 14, n = 2, capA = true, capB = true, folds = 0, step = 0.012 } = {}) {
  // Densify: Catmull-Rom through the stations (centres, radii, the depth axis), one ring every `step` metres, so the
  // surface is smooth along its length too; skin weights and colours interpolate (colours snap to the nearer station).
  const st = [];
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  for (let i = 0; i < st0.length - 1; i++) {
    const a = st0[Math.max(0, i - 1)], b = st0[i], c = st0[i + 1], d = st0[Math.min(st0.length - 1, i + 2)];
    const m = Math.max(1, Math.ceil(b.c.distanceTo(c.c) / step));
    for (let k = 0; k < m; k++) {
      const t = k / m, w = (b.b[0] === c.b[0] && b.b[1] === c.b[1]) ? (b.w || 0) + ((c.w || 0) - (b.w || 0)) * t : (t < 0.5 ? b.w : c.w);
      st.push({ c: V(cr(a.c.x, b.c.x, c.c.x, d.c.x, t), cr(a.c.y, b.c.y, c.c.y, d.c.y, t), cr(a.c.z, b.c.z, c.c.z, d.c.z, t)),
        z: b.z.clone().lerp(c.z, t).normalize(), rx: Math.max(1e-3, cr(a.rx, b.rx, c.rx, d.rx, t)), rz: Math.max(1e-3, cr(a.rz, b.rz, c.rz, d.rz, t)),
        col: t < 0.5 ? b.col : c.col, b: t < 0.5 || (b.b[0] === c.b[0] && b.b[1] === c.b[1]) ? b.b : c.b, w, fold: (b.fold || 0) + ((c.fold || 0) - (b.fold || 0)) * t,
        fF: cr(a.fF ?? 1, b.fF ?? 1, c.fF ?? 1, d.fF ?? 1, t), fB: cr(a.fB ?? 1, b.fB ?? 1, c.fB ?? 1, d.fB ?? 1, t), fX: cr(a.fX ?? 1, b.fX ?? 1, c.fX ?? 1, d.fX ?? 1, t) });
    }
  }
  st.push(st0.at(-1));
  const N = st.length, pos = [], col = [], si = [], sw = [], idx = [], T = V(), x = V(), z = V(), c = new THREE.Color();
  const e = 2 / n, f = (v) => Math.sign(v) * Math.abs(v) ** e;
  const push = (p, s) => { pos.push(p.x, p.y, p.z); c.set(s.col); col.push(c.r, c.g, c.b); si.push(s.b[0], s.b[1], 0, 0); sw.push(1 - (s.w || 0), s.w || 0, 0, 0); };
  for (let i = 0; i < N; i++) {
    const s = st[i]; T.copy(st[Math.min(N - 1, i + 1)].c).sub(st[Math.max(0, i - 1)].c).normalize();
    z.copy(s.z).addScaledVector(T, -s.z.dot(T)).normalize(); x.crossVectors(T, z).normalize(); z.crossVectors(x, T);
    s._T = T.clone();
    const jw = folds ? Math.max(0, 1 - Math.abs((s.w || 0) - 0.5) * 2.2) * folds + (s.fold || 0) : 0; // strongest mid-joint
    for (let j = 0; j < seg; j++) { const a = (j / seg) * Math.PI * 2;
      const fk = jw ? 1 + jw * (0.05 * Math.sin(i * 1.9 + Math.sin(a * 2 + i * 0.7) * 1.5) * (0.6 + 0.4 * Math.sin(a * 3 + i)) + 0.025 * Math.sin(a * 5 + i * 2.3)) : 1;
      const sa = Math.sin(a), rzA = s.rz * ((s.fB ?? 1) + ((s.fF ?? 1) - (s.fB ?? 1)) * (0.5 + 0.5 * sa)), rxA = s.rx * (s.fX ?? 1); // muscles: front / back / sides
      push(s.c.clone().addScaledVector(x, f(Math.cos(a)) * rxA * fk).addScaledVector(z, f(sa) * rzA * fk), s); }
  }
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * seg + j, b = i * seg + (j + 1) % seg, cc = a + seg, d = b + seg; idx.push(a, cc, b, b, cc, d);
  }
  const cap = (i, dir) => {
    const s = st[i], k = pos.length / 3; push(s.c.clone().addScaledVector(s._T, dir * Math.min(s.rx, s.rz) * 0.7), s);
    for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg; if (dir < 0) idx.push(k, a, b); else idx.push(k, b, a); }
  };
  if (capA) cap(0, -1); if (capB) cap(N - 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}


// A displaced ellipsoid on a latitude/longitude grid: u = angle round from the front (-Z, + to the right), v = latitude.
// disp(u, v) adds metres along the surface's outward direction (sculpting: noses, chins, eye sockets, chin bars);
// hole(u, v) leaves a face open (a helmet's eye port). Welded, so it shades as one smooth surface.
function dsphere(c, rx, ry, rz, disp = null, { w = 48, h = 32, hole = null, v0 = -Math.PI / 2, v1 = Math.PI / 2 } = {}) {
  const pos = [], idx = [], P = (u, v) => { const d = V(Math.cos(v) * Math.sin(u), Math.sin(v), -Math.cos(v) * Math.cos(u)), dr = disp ? disp(u, v) : 0;
    return V(c.x + d.x * (rx + dr), c.y + d.y * (ry + dr), c.z + d.z * (rz + dr)); };
  for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) { const v = v1 - (j / h) * (v1 - v0), u = -Math.PI + (i / w) * Math.PI * 2, p = P(u, v); pos.push(p.x, p.y, p.z); }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const um = -Math.PI + ((i + 0.5) / w) * Math.PI * 2, vm = v1 - ((j + 0.5) / h) * (v1 - v0); if (hole && hole(um, vm)) continue;
    const a = j * (w + 1) + i, b = a + 1, cc = a + w + 1, d = cc + 1; idx.push(a, b, cc, b, d, cc);
  }
  let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g = mergeVertices(g, 1e-5); g.computeVertexNormals(); return g;
}
const gs = (a, b, sa, sb) => Math.exp(-((a / sa) ** 2) - ((b / sb) ** 2));
// a point on a dsphere's surface (same parametrisation), pushed out by `off`
// a smooth disc-shaped patch on a dsphere's surface: centre (cu, cv), radii (ru, rv) in radians, `tilt` rotates it,
// `drop` makes it teardrop-shaped (aviator lenses); rings x segs, standing `off` off the surface
function dsPatch(c, rx, ry, rz, disp, cu, cv, ru, rv, off, { tilt = 0, drop = 0, rings = 6, segs = 32 } = {}) {
  const pos = [dsPoint(c, rx, ry, rz, disp, cu, cv, off)], idx = [];
  for (let r = 1; r <= rings; r++) for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2, t = r / rings, ca = Math.cos(a), sa = Math.sin(a), stretch = 1 + drop * Math.max(0, -sa) * Math.max(0, ca * Math.sign(cu || 1));
    const du = ca * ru * t * stretch, dv = sa * rv * t * stretch, u = cu + du * Math.cos(tilt) - dv * Math.sin(tilt), v = cv + du * Math.sin(tilt) + dv * Math.cos(tilt);
    pos.push(dsPoint(c, rx, ry, rz, disp, u, v, off));
  }
  for (let k = 0; k < segs; k++) idx.push(0, 1 + k, 1 + (k + 1) % segs);
  for (let r = 1; r < rings; r++) for (let k = 0; k < segs; k++) { const a = 1 + (r - 1) * segs + k, b = 1 + (r - 1) * segs + (k + 1) % segs, cc = a + segs, d = b + segs; idx.push(a, cc, b, b, cc, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos.flatMap((p) => [p.x, p.y, p.z]), 3)); g.setIndex(idx); g.computeVertexNormals();
  const n = g.attributes.normal; let flip = 0; for (let k = 0; k < n.count; k++) flip += n.getZ(k) * -1; // outward = mostly towards -Z for a face patch
  if (flip < 0) { const ix = g.index.array; for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; } g.computeVertexNormals(); }
  return g;
}
function dsPoint(c, rx, ry, rz, disp, u, v, off = 0) { const d = V(Math.cos(v) * Math.sin(u), Math.sin(v), -Math.cos(v) * Math.cos(u)), dr = (disp ? disp(u, v) : 0) + off; return V(c.x + d.x * (rx + dr), c.y + d.y * (ry + dr), c.z + d.z * (rz + dr)); }
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapU = (u) => Math.atan2(Math.sin(u), Math.cos(u));
// The face, sculpted (metres): eye sockets, brow, nose bridge and tip, nostril wings, cheekbones, lips, chin, jaw taper
function faceDisp(u, v) {
  const au = Math.abs(u); let d = 0;
  d -= 0.009 * sstep(-0.05, -0.75, v) * sstep(0.35, 1.3, au);            // jaw narrows below the cheeks
  d += 0.009 * gs(u, v + 0.52, 0.3, 0.13);                                 // chin
  d -= 0.0095 * gs(au - 0.37, v - 0.14, 0.16, 0.085);                       // eye sockets
  d += 0.0055 * gs(au - 0.3, v - 0.25, 0.32, 0.05);                         // brow ridge
  const nose = v > 0.24 ? 0 : v > -0.03 ? 0.004 + 0.022 * ((0.24 - v) / 0.27) ** 1.6 : 0.026 * Math.max(0, 1 - (-0.03 - v) / 0.085) ** 1.4;
  d += nose * Math.exp(-((u / (0.075 + 0.035 * sstep(0.2, -0.05, v))) ** 2)); // bridge -> tip
  d += 0.0075 * gs(au - 0.13, v + 0.075, 0.06, 0.04);                       // nostril wings
  d += 0.0055 * gs(au - 0.52, v - 0.03, 0.26, 0.1);                         // cheekbones
  d -= 0.0012 * gs(au - 0.6, v + 0.17, 0.2, 0.12);                          // below the cheekbones (soft: no gaunt faces)
  d += 0.0062 * gs(u, v + 0.175, 0.22, 0.035) + 0.0058 * gs(u, v + 0.245, 0.18, 0.03) - 0.0042 * gs(u, v + 0.21, 0.24, 0.011); // lips, mouth line
  d -= 0.004 * gs(au - 1.05, v - 0.22, 0.25, 0.2);                          // temples
  d += 0.008 * gs(au - Math.PI, v - 0.1, 0.9, 0.5);                         // back of the skull
  return d;
}
// pieces → two merged skinned geometries (matte, gloss)
const SLOTS = ['fabric', 'skin', 'paint', 'glass', 'rubber', 'metal', 'hair'];
class Kit {
  constructor() { this.p = Object.fromEntries(SLOTS.map((k) => [k, []])); }
  add(geo, hex, bone, gloss = false, m = null) {
    const g = geo; if (m) g.applyMatrix4(m);
    const slot = typeof gloss === 'string' ? gloss : gloss ? 'paint' : 'fabric';
    if (g.attributes.skinIndex) { this.p[slot].push(g); return this; } // a loft: brings its own colours + weights
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    const n = g.attributes.position.count, c = col(hex), cs = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { cs[i * 3] = c.r; cs[i * 3 + 1] = c.g; cs[i * 3 + 2] = c.b; si[i * 4] = bone; sw[i * 4] = 1; }
    g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    this.p[slot].push(g); return this;
  }
  build() { const o = {}; for (const k in this.p) { const l = this.p[k]; for (const g of l) { if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); } for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'skinIndex', 'skinWeight'].includes(a)) g.deleteAttribute(a); } o[k] = l.length ? mergeGeometries(l) : null; } return o; }
}

// ---------- the rig ----------
// Bones (flat, all children of the rig root; transforms in rig space)
const B = { hips: 0, spine: 1, head: 2, uArmR: 3, fArmR: 4, uArmL: 5, fArmL: 6, thighR: 7, shinR: 8, thighL: 9, shinL: 10, ctlA: 11, ctlB: 12, pedR: 13, pedL: 14, ctlC: 15 };
const NB = 16;
const DIM = { lean: 0.2, spine: 0.5, shoulderW: 0.19, shoulderUp: 0.44, upper: 0.29, fore: 0.27, hand: 0.05, hipW: 0.1, thigh: 0.45, shin: 0.43, ankle: 0.07 };

// Where the controls are, per control kind (rig space, scale 1). Each returns the rest transforms of its bones and
// how to pose them from the inputs.
const CTL = {
  stick: { // centre stick between the knees, throttle on the left console
    stickBase: V(0, -0.1, -0.44), stickLen: 0.36, thrBase: V(-0.3, 0.06, -0.12), thrLen: 0.17,
  },
  cyclic: { // helicopter: cyclic between the knees, collective lever beside the seat (raised with the throttle)
    stickBase: V(0, -0.12, -0.42), stickLen: 0.42, collBase: V(-0.27, 0.02, 0.1), collLen: 0.42,
  },
  yoke: { colBase: V(0, -0.3, -0.62), colLen: 0.62, yokeR: 0.15 },
  wheel: { col: V(0, 0.28, -0.52), tilt: 0.42, wheelR: 0.19 },
  bars: {}, // a motorbike: hands on the fork's grips (given every frame), feet on the pegs, the body leans and tucks
  none: {},
};

function ikTwo(S, T, a, b, pole, outE, outP = null) {
  const d = T.clone().sub(S), L = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3); d.normalize();
  const x = (a * a - b * b + L * L) / (2 * L), y = Math.sqrt(Math.max(0, a * a - x * x));
  const p = pole.clone().addScaledVector(d, -pole.dot(d)); if (p.lengthSq() < 1e-8) p.set(0, -1, 0); p.normalize();
  if (outP) outP.copy(p);
  return outE.copy(S).addScaledVector(d, x).addScaledVector(p, y);
}

class Rig {
  constructor(kind, ctl, outfit, seed, opts = {}) {
    this.kind = kind; this.ctl = ctl; this.o = outfit; this.seed = seed;
    this.pegs = opts.pegs || [V(-0.24, -0.62, 0.0), V(0.24, -0.62, 0.0)]; this.groundY = opts.groundY ?? -1.1;
    const C = CTL[ctl] || CTL.none, D = DIM;
    this.C = C;
    // static joints
    const spineQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), D.lean);
    this.spineQ = spineQ; this.spinePos = V(0, 0.03, 0);
    const sp = (x, y, z) => V(x, y, z).applyQuaternion(spineQ).add(this.spinePos);
    this.neck = sp(0, D.spine, 0.0);
    this.shR = sp(D.shoulderW, D.shoulderUp, 0.02); this.shL = sp(-D.shoulderW, D.shoulderUp, 0.02);
    this.hipR = V(D.hipW, 0, 0); this.hipL = V(-D.hipW, 0, 0);
    this.state = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
    this.q = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.p = Array.from({ length: NB }, () => V());
    this.pose(this.state);
  }
  // control bone transforms + hand/foot targets
  controls(s) {
    const C = this.C, p = this.p, q = this.q, hands = {}, feet = {};
    const e = new THREE.Euler();
    if (this.ctl === 'stick' || this.ctl === 'cyclic') {
      // stick: pitch back (+) tilts the grip towards the pilot (+z), roll right (+) tilts it right
      p[B.ctlA].copy(C.stickBase); q[B.ctlA].setFromEuler(e.set(s.pitch * 0.32, 0, -s.roll * 0.3));
      const grip = V(0, C.stickLen, 0).applyQuaternion(q[B.ctlA]).add(C.stickBase);
      hands.R = grip.clone().add(V(0.015, -0.015, 0.02));
      if (this.ctl === 'stick') {
        p[B.ctlB].copy(C.thrBase); q[B.ctlB].setFromEuler(e.set(-0.55 + s.thr * 1.1, 0, 0)); // forward = more throttle
        hands.L = V(0, C.thrLen, 0).applyQuaternion(q[B.ctlB]).add(C.thrBase).add(V(-0.01, 0.01, 0.0));
      } else {
        // collective: lever from a pivot behind, pointing forward; raised with the throttle
        p[B.ctlB].copy(C.collBase); q[B.ctlB].setFromEuler(e.set(-Math.PI / 2 + 0.18 + s.thr * 0.35, 0, 0));
        hands.L = V(0, C.collLen, 0).applyQuaternion(q[B.ctlB]).add(C.collBase).add(V(0, 0.03, 0));
      }
    } else if (this.ctl === 'yoke') {
      // column hinged at the floor: pull = back; the yoke turns about the column's top axis
      p[B.ctlA].copy(C.colBase); q[B.ctlA].setFromEuler(e.set(0.42 + s.pitch * 0.14, 0, 0));
      const top = V(0, C.colLen, 0).applyQuaternion(q[B.ctlA]).add(C.colBase);
      // the yoke stands nearly upright facing the pilot and turns about the axis towards the pilot (local Z)
      p[B.ctlB].copy(top); q[B.ctlB].setFromEuler(e.set(0.12, 0, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -s.roll * 0.7));
      for (const [k, sx] of [['R', 1], ['L', -1]]) hands[k] = V(sx * C.yokeR, 0.02, 0.0).applyQuaternion(q[B.ctlB]).add(top);
    } else if (this.ctl === 'wheel') {
      const tq = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), C.tilt); // wheel plane leans back towards the driver
      p[B.ctlA].copy(C.col); q[B.ctlA].copy(tq).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), s.steer));
      for (const [k, a] of [['R', -1.15], ['L', 1.15]]) hands[k] = V(Math.sin(-a) * C.wheelR, Math.cos(a) * C.wheelR, 0.02).applyQuaternion(q[B.ctlA]).add(C.col);
    } else if (this.ctl === 'bars') { // on the grips (rig space, from the fork), else resting on the tank
      hands.L = s.hands?.[0] || V(-0.2, 0.05, -0.42); hands.R = s.hands?.[1] || V(0.2, 0.05, -0.42);
      feet.L = this.pegs[0].clone().lerp(V(this.pegs[0].x - 0.1, this.groundY + 0.06, this.pegs[0].z - 0.12), s.foot || 0); // a foot down when stopped
      feet.R = this.pegs[1].clone();
      return { hands, feet };
    } else {
      hands.R = V(0.16, 0.0, -0.32); hands.L = V(-0.16, 0.0, -0.32); // resting on the thighs
    }
    // pedals: rudder pedals swing fore and aft; a car has a throttle pedal under the right foot
    const pz = -0.86, py = -0.34;
    if (this.ctl === 'wheel') {
      p[B.pedR].set(0.12, py, pz); q[B.pedR].setFromEuler(e.set(-0.5 - s.thr * 0.35, 0, 0));
      p[B.pedL].set(-0.14, py, pz + 0.02); q[B.pedL].setFromEuler(e.set(-0.5, 0, 0));
    } else {
      p[B.pedR].set(0.13, py, pz - s.yaw * 0.06); q[B.pedR].setFromEuler(e.set(-0.35, 0, 0));
      p[B.pedL].set(-0.13, py, pz + s.yaw * 0.06); q[B.pedL].setFromEuler(e.set(-0.35, 0, 0));
    }
    feet.R = V(0, 0.1, 0.05).applyQuaternion(q[B.pedR]).add(p[B.pedR]);
    feet.L = V(0, 0.1, 0.05).applyQuaternion(q[B.pedL]).add(p[B.pedL]);
    return { hands, feet };
  }
  pose(s) {
    const D = DIM, p = this.p, q = this.q, { hands, feet } = this.controls(s), bars = this.ctl === 'bars';
    if (bars) { // a rider: bent forward over the tank (more when tucked at speed), leaning further into a turn than the bike
      const fwd = (this.o.hump ? 0.6 : 0.42) + (s.tuck || 0) * (this.o.hump ? 0.42 : 0.22), lean = s.lean || 0;
      this.hipAt = V(lean * 0.12, -Math.abs(lean) * 0.03, (s.tuck || 0) * 0.04);
      this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -lean).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -fwd));
      this.spinePos = V(0, 0.03, 0).add(this.hipAt);
      const sp = (x, y, z) => V(x, y, z).applyQuaternion(this.spineQ).add(this.spinePos);
      this.neck = sp(0, D.spine, 0.0); this.shR = sp(D.shoulderW, D.shoulderUp, 0.02); this.shL = sp(-D.shoulderW, D.shoulderUp, 0.02);
      this.hipR = V(D.hipW, 0, 0).add(this.hipAt); this.hipL = V(-D.hipW, 0, 0).add(this.hipAt);
    }
    if (bars) p[B.hips].copy(this.hipAt); else p[B.hips].set(0, 0, 0);
    q[B.hips].identity();
    p[B.spine].copy(this.spinePos); q[B.spine].copy(this.spineQ);
    p[B.head].copy(this.neck);
    if (bars) q[B.head].setFromEuler(new THREE.Euler(-0.1, s.look * 0.5, (s.bikeLean || 0) * 0.55 + (s.lean || 0) * 0.5, 'YXZ')); // eyes level, looking up the road
    else q[B.head].setFromEuler(new THREE.Euler(-0.08 + s.pitch * 0.05, s.look, s.look * 0.15, 'YXZ'));
    const E = V(), P = V();
    // Both bones of a limb take their twist from the plane the limb bends in (the bend direction P is perpendicular to
    // shoulder->hand, so it is never along either bone). A fixed 'forward' hint flipped the twist by up to 110 degrees
    // in one frame whenever a forearm or shin pointed along it, as a rider's forearms do towards the grips.
    // side -1 (arms): local -Z away from the elbow, the inside of the arm; +1 (legs): local -Z towards the knee, so the toes point forward.
    // The frame is built from the bend plane's normal N (both bones lie in that plane, so it is always well defined).
    const N = V(), M4 = new THREE.Matrix4();
    const frame = (dir, out) => { const y = dir.normalize(), z = V().crossVectors(N, y).normalize(); return out.setFromRotationMatrix(M4.makeBasis(V().crossVectors(y, z), y, z)); };
    const limb = (S, T, a, b, pole, iu, iff, side) => {
      ikTwo(S, T, a, b, pole, E, P);
      N.crossVectors(P, T.clone().sub(S).normalize()).multiplyScalar(side).normalize();
      p[iu].copy(S); frame(E.clone().sub(S), q[iu]);
      p[iff].copy(E); frame(T.clone().sub(E), q[iff]);
    };
    const handL = D.fore + D.hand;
    // riders: elbows bent back and a little out and down (not winged out sideways), knees forward against the tank
    // (a sport rider's knees go out over the fairing's sides, gripping the tank, not through the fairing)
    const eR = bars ? V(0.45, -0.45, 0.75) : V(0.55, -0.8, 0.25), kR = bars ? (this.o.hump ? V(0.5, 0.5, -0.9) : V(0.35, 0.6, -1)) : V(0.1, 1, -0.4);
    limb(this.shR, hands.R, D.upper, handL, eR, B.uArmR, B.fArmR, -1);
    limb(this.shL, hands.L, D.upper, handL, V(-eR.x, eR.y, eR.z), B.uArmL, B.fArmL, -1);
    limb(this.hipR, feet.R, D.thigh, D.shin, kR, B.thighR, B.shinR, 1);
    limb(this.hipL, feet.L, D.thigh, D.shin, V(-kR.x, kR.y, kR.z), B.thighL, B.shinL, 1);
  }
}

// ---------- building a figure (rest pose geometry, bone-local pieces baked through the rest transforms) ----------
function figureGeometry(rig) {
  const o = rig.o, k = new Kit(), D = DIM, seed = rig.seed;
  const skin = SKIN[seed % SKIN.length], hair = HAIR[(seed * 7 + 1) % HAIR.length];
  const R = (i) => new THREE.Matrix4().compose(rig.p[i], rig.q[i], V(1, 1, 1));
  const route = (hex, gloss) => (typeof gloss === 'string' ? gloss : gloss ? (hex === o.visor ? 'glass' : 'paint') : hex === skin ? 'skin' : hex === hair ? 'hair' : (hex === o.glove || hex === o.boot || hex === 0x1d1d1f || hex === 0x15161a) ? 'rubber' : 'fabric');
  const at = (i, geo, hex, gloss = false) => k.add(geo, hex, i, route(hex, gloss), geo.attributes.skinIndex ? null : R(i)); // (a loft is built in rig space)
  // ---- the body: the skinned human mesh posed onto this rig (body.js), coloured by what the outfit covers ----
  const BP = o.head !== 'bubble' && body() ? poseBody({ p: rig.p, q: rig.q, B, DIM }, { seat: rig.ctl === 'bars' ? { y: -0.08, back: null } : { y: -0.09, back: 0.125 } }) : null;
  if (BP) {
    const n = BP.pos.length / 3, cols = new Float32Array(n * 3), slotOf = new Array(n), c = new THREE.Color();
    const neckSkin = o.head === 'headset' || o.head === 'leather' || o.head === 'cap';
    for (let i = 0; i < n; i++) {
      const sg = BP.seg[i], t = BP.along[i]; let hex = o.suit, sl = 'fabric';
      if (BP.eye[i] === 3) { hex = 0x8a5a52; sl = 'skin'; } else if (BP.eye[i]) { hex = 0xf1ece4; sl = 'paint'; }
      else if (sg === 'head') { hex = skin; sl = 'skin'; }
      else if (sg.startsWith('hand')) { hex = o.glove ?? skin; sl = o.glove ? 'rubber' : 'skin'; }
      else if (sg.startsWith('fArm')) { if (o.tee || o.shirt) { hex = skin; sl = 'skin'; } else if (o.glove && t > 0.82) { hex = o.glove; sl = 'rubber'; } }
      else if (sg.startsWith('uArm')) { if ((o.tee && t > 0.42) || (o.shirt && t > 0.85)) { hex = skin; sl = 'skin'; } }
      else if (sg === 'hips') hex = o.suit2;
      else if (sg === 'spine') { if (t < 0.12) hex = o.suit2; if (neckSkin && t > 1.02) { hex = skin; sl = 'skin'; } }
      else if (sg.startsWith('thigh')) { hex = o.suit2; if (o.shorts && t > 0.62) { hex = skin; sl = 'skin'; } }
      else if (sg.startsWith('shin')) { hex = o.shorts ? skin : o.suit2; sl = o.shorts ? 'skin' : 'fabric'; }
      c.set(hex); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; slotOf[i] = sl;
    }
    const full = new THREE.BufferGeometry(); full.setAttribute('position', new THREE.BufferAttribute(BP.pos, 3)); full.setIndex(new THREE.BufferAttribute(new Uint32Array(BP.index), 1)); full.computeVertexNormals();
    BP.nrm = full.attributes.normal.array;
    const bySlot = {};
    for (let f = 0; f < BP.index.length; f += 3) { const a0 = BP.index[f], a1 = BP.index[f + 1], a2 = BP.index[f + 2]; const sl = slotOf[a0] === slotOf[a1] ? slotOf[a0] : slotOf[a2]; (bySlot[sl] ||= []).push(a0, a1, a2); }
    for (const [sl, ix] of Object.entries(bySlot)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(BP.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(BP.nrm, 3)); g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(BP.skinIndex, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(BP.skinWeight, 4)); g.setIndex(ix);
      k.add(g, 0, B.spine, sl);
    }
  }
  // Clothing grown from the body: the triangles of a region, pushed out along the body's normals by the garment's
  // thickness (a thicker roll at its open edges: the hem). It keeps the body's skin weights, so it moves with it.
  // field(i) >= 0 inside the garment; triangles crossing its edge are clipped along the zero line, so hems are clean
  // curves however the body is meshed. smooth > 0 relaxes the shell (foam, padding: no body detail through it).
  const bodyShell = (field, off, hex, slot, { hem = 1.6, smooth = 0 } = {}) => {
    if (!BP) return;
    const n = BP.pos.length / 3, F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = BP.eye[i] ? -1 : field(i);
    const P = [], N = [], SI = [], SW = [], rimV = [], ix = [], vmap = new Map(), col3 = new THREE.Color(hex);
    const push = (p, nn, src, rim) => { P.push(p.x, p.y, p.z); N.push(nn.x, nn.y, nn.z); for (let q = 0; q < 4; q++) { SI.push(BP.skinIndex[src * 4 + q]); SW.push(BP.skinWeight[src * 4 + q]); } rimV.push(rim ? 1 : 0); return P.length / 3 - 1; };
    const orig = (i) => { if (!vmap.has(i)) vmap.set(i, push(V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]), V(BP.nrm[i * 3], BP.nrm[i * 3 + 1], BP.nrm[i * 3 + 2]), i, false)); return vmap.get(i); };
    const emap = new Map(), cut = (a2, b2) => { const key = a2 < b2 ? a2 * 65536 + b2 : b2 * 65536 + a2; if (emap.has(key)) return emap.get(key);
      const t2 = F[a2] / (F[a2] - F[b2]), A = V(BP.pos[a2 * 3], BP.pos[a2 * 3 + 1], BP.pos[a2 * 3 + 2]), Bv = V(BP.pos[b2 * 3], BP.pos[b2 * 3 + 1], BP.pos[b2 * 3 + 2]);
      const nA = V(BP.nrm[a2 * 3], BP.nrm[a2 * 3 + 1], BP.nrm[a2 * 3 + 2]), nB = V(BP.nrm[b2 * 3], BP.nrm[b2 * 3 + 1], BP.nrm[b2 * 3 + 2]);
      const id = push(A.lerp(Bv, t2), nA.lerp(nB, t2).normalize(), F[a2] >= 0 ? a2 : b2, true); emap.set(key, id); return id; };
    for (let f = 0; f < BP.index.length; f += 3) {
      const tri = [BP.index[f], BP.index[f + 1], BP.index[f + 2]], ins = tri.map((i) => F[i] >= 0), nIn = ins.filter(Boolean).length;
      if (!nIn) continue;
      if (nIn === 3) { ix.push(orig(tri[0]), orig(tri[1]), orig(tri[2])); continue; }
      const poly = []; for (let e = 0; e < 3; e++) { const a2 = tri[e], b2 = tri[(e + 1) % 3]; if (F[a2] >= 0) poly.push(orig(a2)); if ((F[a2] >= 0) !== (F[b2] >= 0)) poly.push(cut(a2, b2)); }
      for (let q = 1; q < poly.length - 1; q++) ix.push(poly[0], poly[q], poly[q + 1]);
    }
    if (!ix.length) return;
    // open edges (cut or the mesh's own) roll into a hem
    const ecount = new Map(); for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { const a2 = ix[f + e], b2 = ix[f + (e + 1) % 3], key = a2 < b2 ? a2 * 1e6 + b2 : b2 * 1e6 + a2; ecount.set(key, (ecount.get(key) || 0) + 1); }
    for (const [key, c] of ecount) if (c === 1) { rimV[Math.floor(key / 1e6)] = 1; rimV[key % 1e6] = 1; }
    const nv = P.length / 3, Q = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { const d = (typeof off === 'function' ? off(v) : off) * (rimV[v] ? hem : 1); for (let c = 0; c < 3; c++) Q[v * 3 + c] = P[v * 3 + c] + N[v * 3 + c] * d; }
    if (smooth) { const nb = Array.from({ length: nv }, () => new Set()); for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { nb[ix[f + e]].add(ix[f + (e + 1) % 3]); nb[ix[f + (e + 1) % 3]].add(ix[f + e]); }
      for (let it = 0; it < smooth; it++) { const T = Q.slice(); for (let v = 0; v < nv; v++) { if (rimV[v] || !nb[v].size) continue; let x = 0, y = 0, z = 0; for (const u of nb[v]) { x += T[u * 3]; y += T[u * 3 + 1]; z += T[u * 3 + 2]; } const m = nb[v].size; Q[v * 3] = T[v * 3] * 0.4 + x / m * 0.6; Q[v * 3 + 1] = T[v * 3 + 1] * 0.4 + y / m * 0.6; Q[v * 3 + 2] = T[v * 3 + 2] * 0.4 + z / m * 0.6; } } }
    const C = new Float32Array(nv * 3); for (let v = 0; v < nv; v++) { C[v * 3] = col3.r; C[v * 3 + 1] = col3.g; C[v * 3 + 2] = col3.b; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Q, 3)); g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4)); g.setIndex(ix); g.computeVertexNormals();
    k.add(g, 0, B.spine, slot);
  };
  const wOf = (i, bone) => { let w = 0; for (let q = 0; q < 4; q++) if (BP.skinIndex[i * 4 + q] === bone) w += BP.skinWeight[i * 4 + q]; return w; };
  const seg = (i) => BP.seg[i], tt = (i) => BP.along[i];
  // ---- body: one skinned surface per chain (torso, neck, each arm, each leg), shared across joints ----
  const P = (i, x, y, z) => V(x, y, z).applyMatrix4(R(i)); // bone-local point -> rig space (rest pose)
  const ax = (i, a) => a.clone().applyQuaternion(rig.q[i]); // bone-local axis -> rig space
  const ZF = V(0, 0, -1);
  // torso: pelvis (hips bone) up through the waist, chest and shoulders (spine bone); [bone, y, rx, rz, z offset, colour, weight of spine]
  const band = (y) => o.stripes && [0.2, 0.32].some((b) => Math.abs(y - b) < 0.019);
  const tRows = [
    [B.hips, -0.085, 0.07, 0.06, 0.02, o.suit2, 0], [B.hips, -0.06, 0.145, 0.11, 0.02, o.suit2, 0], [B.hips, -0.015, 0.168, 0.122, 0.015, o.suit2, 0],
    [B.hips, 0.04, 0.16, 0.118, 0.005, o.suit2, 0.15], [B.spine, 0.06, 0.15, 0.11, 0, o.suit2, 0.6], [B.spine, 0.075, 0.149, 0.11, 0, o.suit, 0.65],
    [B.spine, 0.14, 0.148, 0.108, -0.005, o.suit, 0.9], [B.spine, 0.18, 0.152, 0.11, -0.008, o.suit, 1], [B.spine, 0.2, 0.155, 0.112, -0.01, o.suit, 1],
    [B.spine, 0.22, 0.16, 0.114, -0.012, o.suit, 1], [B.spine, 0.3, 0.172, 0.118, -0.012, o.suit, 1], [B.spine, 0.32, 0.176, 0.117, -0.01, o.suit, 1],
    [B.spine, 0.34, 0.18, 0.115, -0.006, o.suit, 1], [B.spine, 0.39, 0.18, 0.106, 0, o.suit, 1], [B.spine, 0.43, 0.162, 0.088, 0.005, o.suit, 1],
    [B.spine, 0.465, 0.11, 0.07, 0.008, o.suit, 1], [B.spine, 0.485, 0.06, 0.05, 0.008, o.suit, 1],
  ];
  const gg = (x, m, w2) => Math.exp(-(((x - m) / w2) ** 2));
  const tSt = tRows.map(([i, y, rx, rz, zo, c, w]) => ({ c: P(i, 0, y, zo), z: ax(i, ZF), rx, rz, col: band(y) ? o.trim : c, b: [B.hips, B.spine], w,
    fF: i === B.spine ? 1 + 0.08 * gg(y, 0.34, 0.05) - 0.03 * gg(y, 0.2, 0.05) : 1, fB: i === B.spine ? 1 + 0.06 * gg(y, 0.37, 0.06) - 0.02 * gg(y, 0.14, 0.05) : 1 + 0.1 * gg(y, -0.04, 0.04) }));
  if (!BP) at(B.spine, loft(tSt, { seg: 36, n: 2.4, folds: 0.5 }), o.suit);
  // a layer worn over the chest (vest, life jacket): the torso's own shape, puffed out by k, between two heights
  const shell = (y0, y1, k, col) => loft(tRows.filter((r) => r[0] === B.spine && r[1] >= y0 && r[1] <= y1)
    .map(([i, y, rx, rz, zo]) => ({ c: P(i, 0, y, zo), z: ax(i, ZF), rx: rx * k, rz: rz * k, col, b: [B.spine, B.spine], w: 0 })), { seg: 36, n: 2.4, capA: false, capB: false });
  // a point on the torso's front at height y (spine bone), x across, standing off by `off`
  const front = (x, y, off = 0) => {
    const rs = tRows.filter((r) => r[0] === B.spine), j = Math.max(1, rs.findIndex((r) => r[1] >= y)), a = rs[j - 1], b = rs[j], t = clamp((y - a[1]) / (b[1] - a[1]), 0, 1);
    const rx = a[2] + (b[2] - a[2]) * t, rz = a[3] + (b[3] - a[3]) * t, zo = a[4] + (b[4] - a[4]) * t, u = Math.min(0.98, Math.abs(x) / rx);
    return V(x, y, zo - (rz * (1 - u ** 2.4) ** (1 / 2.4) + off));
  };
  // neck: from the shoulders into the head (or the helmet)
  const neckCol = o.head === 'headset' || o.head === 'leather' || o.head === 'cap' ? skin : o.suit;
  if (!BP) at(B.spine, loft([[B.spine, 0.42, 0, 0], [B.spine, 0.47, 0.3, 0.004], [B.head, 0.02, 0.75, 0], [B.head, 0.07, 1, -0.005]].map(([i, y, w, zo]) =>
    ({ c: P(i, 0, y, zo), z: ax(i, ZF), rx: 0.058, rz: 0.06, col: neckCol, b: [B.spine, B.head], w, fF: 0.95, fB: 1.05 })), { seg: 24 }), neckCol, neckCol === skin ? 'skin' : 'fabric');
  // a limb from bone u through the joint into bone f: [s along the bone, rx (across the bend plane), rz, colour]
  const limbLoft = (u, f, lenU, up, fo, join = 0.055, root = null) => {
    const st = [], E = P(f, 0, 0, 0);
    for (const [sv, rx, rz, c, m] of up) { const pt = P(u, 0, sv, 0), d = lenU - sv; st.push({ c: pt, z: ax(u, ZF), rx, rz, col: c, b: [u, f], w: d < join ? 0.5 - d / join * 0.5 : 0, ...(m || {}) }); }
    st.push({ c: E, z: ax(u, ZF).add(ax(f, ZF)).normalize(), rx: (up.at(-1)[1] + fo[0][1]) / 2, rz: (up.at(-1)[2] + fo[0][2]) / 2, col: fo[0][3], b: [u, f], w: 0.5 });
    for (const [sv, rx, rz, c, m] of fo) st.push({ c: P(f, 0, sv, 0), z: ax(f, ZF), rx, rz, col: c, b: [u, f], w: sv < join ? 0.5 + sv / join * 0.5 : 1, ...(m || {}) });
    if (root) for (let i = 0; i < root.length; i++) { st[i].b = [root[i][0], u]; st[i].w = root[i][1]; } // first stations shared with the parent
    return loft(st, { seg: 24, folds: 1 });
  };
  // a garment over a limb: the limb's own stations from the shoulder / hip to `end` along the upper bone, puffed out
  // (loose fabric stands off the skin), open at the end with a rolled hem
  const sleeve = (u, f, lenU, up, end, k, add, col) => {
    const st = up.filter((r) => r[0] <= end).map(([sv, rx, rz, , m]) => ({ c: P(u, 0, sv, 0), z: ax(u, ZF), rx: rx * k + add, rz: rz * k + add, col, b: [u, f], w: 0, ...(m || {}), fold: 0.6 }));
    const er = up.find((r) => r[0] > end) || up.at(-1), e = st.at(-1);
    st.push({ c: P(u, 0, end, 0), z: ax(u, ZF), rx: er[1] * k * 1.04 + add, rz: er[2] * k * 1.04 + add, col, b: [u, f], w: 0, fold: 0.6 });
    at(u, loft(st, { seg: 28, capA: false, capB: false, folds: 0.3 }), col, 'fabric');
    const hem = torusAB(1, 0.006, Math.PI * 2, 32); hem.scale(er[1] * k * 1.04 + add, er[2] * k * 1.04 + add, 1); hem.rotateX(Math.PI / 2);
    hem.translate(0, end, 0); at(u, hem, col, 'fabric'); void e; // (bone-local: at() puts it on the bone)
  };
  if (o.harness) { // shoulder straps, lap belt and the buckle
    // shoulder straps: over the shoulder from behind, then down the chest's surface to the buckle
    for (const sx of [-1, 1]) {
      const path = [V(sx * 0.1, D.shoulderUp - 0.02, 0.1), V(sx * 0.1, D.shoulderUp + 0.035, 0.0), front(sx * 0.1, 0.41, 0.012), front(sx * 0.09, 0.32, 0.012), front(sx * 0.075, 0.22, 0.012), front(sx * 0.05, 0.14, 0.012)];
      for (let i = 0; i < path.length - 1; i++) at(B.spine, capAB(path[i], path[i + 1], 0.02, 0.02, { sz: 0.45, seg: 6, ring: 1, hint: V(sx, 0, 0) }), o.trim);
    }
    at(B.hips, capAB(V(-0.125, 0.07, -0.108), V(0.125, 0.07, -0.108), 0.019, 0.019, { seg: 6, sz: 0.6 }), o.trim); // lap belt
    const bk = front(0, 0.14, 0.022); at(B.spine, boxG(0.07, 0.07, 0.025, bk), 0x9aa0a6, true);
  }
  if (o.hump) at(B.spine, ellipsoid(V(0, D.shoulderUp - 0.06, 0.12), 0.09, 0.12, 0.06, { w: 12 }), o.suit, true); // leathers' aero hump
  if (BP && o.vest) { // a life jacket grown from the torso: thick foam, two black straps round it
    const torso = (i) => { const w = wOf(i, B.spine) - 0.62; return seg(i) === 'spine' ? Math.min(w, tt(i) - 0.16, 0.95 - tt(i)) : seg(i) === 'head' ? -1 : w; }; // (continuous: smooth armholes)
    bodyShell(torso, 0.045, o.vest, 'fabric', { hem: 0.85, smooth: 14 }); // foam: bulky and smooth
    for (const y of [0.42, 0.66]) bodyShell((i) => Math.min(torso(i), 0.028 - Math.abs(tt(i) - y)), 0.051, 0x15161a, 'fabric', { hem: 1, smooth: 14 });
  }
  if (!BP && o.vest) { // a life jacket: chunky foam front and back, a collar, two buckles
    at(B.spine, shell(0.075, 0.39, 1.16, o.vest), o.vest);
    at(B.spine, torusAB(0.085, 0.03, Math.PI * 2, 14).rotateX(Math.PI / 2).translate(0, D.shoulderUp + 0.02, 0.0), o.vest);
    // straps round the jacket with side-release buckles, a front zip, and the foam panels' seams
    for (const [y0, y1] of [[0.18, 0.2], [0.3, 0.32]]) at(B.spine, shell(y0, y1, 1.19, 0x15161a), 0x15161a, 'fabric');
    for (const y of [0.19, 0.31]) { const bp = front(0.03, y, 0.03); at(B.spine, boxG(0.05, 0.028, 0.016, bp), 0x15161a, 'rubber'); at(B.spine, boxG(0.012, 0.022, 0.017, bp.clone().add(V(-0.01, 0, -0.002))), 0x9aa0a6, 'metal'); }
    { const z0 = front(0, 0.38, 0.026), z1 = front(0, 0.09, 0.03); at(B.spine, capAB(z0, z1, 0.0035, 0.0035, { sz: 0.6 }), 0x2a2c30, 'rubber'); } // zip
    for (const sx of [-1, 1]) { const a0 = front(sx * 0.09, 0.39, 0.024), a1 = front(sx * 0.11, 0.08, 0.026); at(B.spine, capAB(a0, a1, 0.0025, 0.0025, { sz: 0.5 }), 0xc4561a, 'fabric'); } // panel seams
  }
  if (o.mask === true) at(B.spine, shell(0.14, 0.39, 1.07, o.suit2), o.suit2); // survival vest
  if (BP && !o.tee) { // full suits / jerseys and trousers, grown from the body and relaxed so it reads as cloth over a body
    const top = (i) => seg(i) === 'spine' ? 0.985 - tt(i) : seg(i) === 'hips' ? 0.2 - (1 - wOf(i, B.spine)) : seg(i).startsWith('uArm') ? 1 : seg(i).startsWith('fArm') ? (o.glove ? 0.86 : 0.97) - tt(i) : -1;
    bodyShell(top, 0.007, o.suit, 'fabric', { hem: 1.4, smooth: 10 });
    bodyShell((i) => seg(i) === 'hips' ? 1 : seg(i) === 'spine' ? 0.15 - tt(i) : seg(i).startsWith('thigh') ? 1 : seg(i).startsWith('shin') ? 0.9 - tt(i) : -1, 0.007, o.suit2, 'fabric', { hem: 1.4, smooth: 4 });
    if (o.stripes) for (const y of [0.42, 0.64]) bodyShell((i) => Math.min(top(i), seg(i) === 'spine' ? 0.025 - Math.abs(tt(i) - y) : -1), 0.0085, o.trim, 'fabric', { hem: 1, smooth: 10 });
  }
  if (BP && o.tee) bodyShell((i) => seg(i) === 'spine' || seg(i) === 'hips' ? 0.985 - tt(i) : seg(i).startsWith('uArm') ? 0.42 - tt(i) : -1, 0.005, o.suit, 'fabric'); // the T-shirt
  if (BP && o.shorts) bodyShell((i) => seg(i) === 'hips' ? 1 : seg(i) === 'spine' ? 0.17 - tt(i) : seg(i).startsWith('thigh') ? 0.62 - tt(i) : -1, 0.008, o.suit2, 'fabric'); // the shorts
  if (!BP && o.tee) { // crew-neck collar and a rolled hem round the waist
    at(B.spine, torusAB(0.06, 0.007, Math.PI * 2, 32).rotateX(Math.PI / 2).translate(0, D.shoulderUp + 0.005, 0.005), o.suit, 'fabric');
    { const r0 = tRows.find((r) => r[0] === B.spine && r[1] >= 0.075); const h = torusAB(1, 0.006, Math.PI * 2, 40); h.scale(r0[2] * 1.03, r0[3] * 1.03, 1); h.rotateX(Math.PI / 2); h.translate(0, 0.075, r0[4]); at(B.spine, h, o.suit, 'fabric'); }
  }
  if (o.shirt) { // tie and epaulettes
    at(B.spine, capAB(V(0, D.shoulderUp - 0.02, -0.115), V(0, 0.16, -0.122), 0.022, 0.03, { sz: 0.25, seg: 6 }), o.trim);
    for (const sx of [-1, 1]) at(B.spine, boxG(0.09, 0.012, 0.045, V(sx * 0.15, D.shoulderUp + 0.03, 0.01)), 0x15161a), at(B.spine, boxG(0.092, 0.014, 0.008, V(sx * 0.15, D.shoulderUp + 0.032, 0.01)), o.epaulettes, true);
  }
  // arms: sleeve, elbow, forearm and a gloved (or bare) fist
  const hand = o.glove ?? skin;
  const fore = o.shirt || o.tee ? skin : o.suit, cuff = o.glove ? o.glove : fore;
  for (const [u, f, sx] of [[B.uArmR, B.fArmR, 1], [B.uArmL, B.fArmL, -1]]) {
    // the arm as a body: deltoid, biceps (front) and triceps (back), the forearm's bulk near the elbow tapering to a
    // flat wrist. Fully sleeved outfits are that shape in fabric; a T-shirt or a short-sleeved shirt is bare skin
    // with a loose sleeve over the top
    const bare = o.tee || o.shirt, bc = bare ? skin : o.suit, fc = bare ? skin : fore;
    const UP = [[-0.01, 0.061, 0.063, bc, { fX: 1.04 }], [0.05, 0.059, 0.059, bc, { fX: 1.08, fB: 1.04 }], [0.11, 0.051, 0.053, bc, { fF: 1.17, fB: 1.1 }],
      [0.17, 0.047, 0.049, bc, { fF: 1.15, fB: 1.05 }], [0.235, 0.043, 0.042, bc], [0.268, 0.042, 0.04, bc]];
    const FO = [[0.03, 0.046, 0.043, fc, { fX: 1.06 }], [0.075, 0.049, 0.044, fc, { fX: 1.1, fF: 1.05 }], [0.14, 0.041, 0.036, fc], [0.2, 0.034, 0.028, fc],
      ...(o.glove ? [[D.fore - 0.07, 0.032, 0.025, fc], [D.fore - 0.065, 0.043, 0.04, cuff]] : []), [D.fore - 0.01, o.glove ? 0.044 : 0.031, o.glove ? 0.04 : 0.022, cuff, o.glove ? {} : { fX: 1.06 }]];
    if (!BP) { at(u, ellipsoid(V(0, 0.02, 0.004), 0.06, 0.066, 0.062), o.suit, 'fabric'); // shoulder (under the sleeve)
    at(u, limbLoft(u, f, D.upper, UP, FO), bc, bare ? 'skin' : 'fabric');
    if (o.tee) sleeve(u, f, D.upper, UP, 0.13, 1.16, 0.006, o.suit);
    else if (o.shirt) sleeve(u, f, D.upper, UP, 0.2, 1.12, 0.006, o.suit); }
    // a gloved (or bare) hand gripping a bar along local X: palm, four curled fingers in three phalanges, a thumb wrapped
    // over them, and (gloves) a hard knuckle guard on the back
    if (BP) continue; // (the body mesh has its own hands)
    const hs = o.glove ? 'rubber' : 'skin', hy = D.fore;
    at(f, ellipsoid(V(0, hy + 0.035, 0.002), 0.042, 0.05, 0.026), hand, hs); // palm / back of the hand
    const ctr = V(0, hy + 0.062, -0.016), rad = 0.021;
    [[-0.027, 0.0088, 0.95], [-0.009, 0.0096, 1.05], [0.009, 0.0094, 1.0], [0.026, 0.0082, 0.85]].forEach(([x, r, l]) => {
      const xs = x * sx, pts = []; for (let k2 = 0; k2 <= 6; k2++) { const th = (k2 / 6) * Math.PI * 1.15 * l; pts.push(V(xs, ctr.y + Math.cos(th) * rad, ctr.z + 0.006 - Math.sin(th) * rad)); }
      for (let k2 = 0; k2 < pts.length - 1; k2++) at(f, capAB(pts[k2], pts[k2 + 1], r * (1 - k2 * 0.04), r * (1 - (k2 + 1) * 0.04), { seg: 12, ring: 3 }), hand, hs);
    });
    at(f, capAB(V(sx * -0.034, hy + 0.018, -0.012), V(sx * -0.03, hy + 0.05, -0.034), 0.012, 0.011, { seg: 12 }), hand, hs); // thumb
    at(f, capAB(V(sx * -0.03, hy + 0.05, -0.034), V(sx * -0.008, hy + 0.068, -0.042), 0.011, 0.0095, { seg: 12 }), hand, hs);
    if (o.glove) at(f, ellipsoid(V(0, hy + 0.06, 0.016), 0.04, 0.012, 0.014), 0x2a2c30, 'rubber'); // knuckle guard
  }
  // legs and boots
  const L2 = o.suit2;
  for (const [t, s] of [[B.thighR, B.shinR], [B.thighL, B.shinL]]) {
    const bareL = !!o.shorts, lc = bareL ? skin : L2;
    const TH = [[-0.03, 0.084, 0.084, lc, { fB: 1.06 }], [0.04, 0.088, 0.086, lc, { fB: 1.08 }], [0.16, 0.08, 0.077, lc, { fF: 1.1, fX: 1.04 }], [0.3, 0.068, 0.064, lc, { fF: 1.06 }], [0.4, 0.058, 0.056, lc, { fF: 1.05 }]];
    const SH = [[0.04, 0.055, 0.056, lc, { fF: 1.06 }], [0.12, 0.054, 0.058, lc, { fB: 1.22, fX: 1.04 }], [0.22, 0.046, 0.048, lc, { fB: 1.12 }], [D.shin - 0.07, 0.036, 0.036, lc], [D.shin - 0.02, 0.034, 0.034, lc]];
    if (!BP) { at(t, limbLoft(t, s, D.thigh, TH, SH, 0.07, [[B.hips, 0.45], [B.hips, 0.85]]), lc, bareL ? 'skin' : 'fabric');
    if (bareL) sleeve(t, s, D.thigh, TH, 0.3, 1.05, 0.006, L2); } // shorts: loose legs ending above the knee
    // a boot: shaft round the ankle, foot and toe box on a sole with a heel block; motocross boots go up the shin with
    // a shin plate and three buckle straps
    if (BP) { const sd = s === B.shinR ? 'shinR' : 'shinL'; bodyShell((i) => seg(i) === sd ? tt(i) - (o.bigBoots ? 0.5 : 0.93) : -1, o.bigBoots ? 0.014 : 0.016, o.boot, 'rubber', { hem: 1.2, smooth: 24 }); continue; }
    at(s, capsule(0.11, 0.047, 0.051).translate(0, D.shin - 0.09, 0.0), o.boot, 'rubber');
    at(s, ellipsoid(V(0, D.shin + 0.006, -0.056), 0.049, 0.042, 0.112), o.boot, 'rubber');
    at(s, ellipsoid(V(0, D.shin + 0.0, -0.13), 0.043, 0.033, 0.045), o.boot, 'rubber'); // toe box
    at(s, ellipsoid(V(0, D.shin + 0.037, -0.062), 0.052, 0.012, 0.122, { w: 28, h: 8 }), 0x1d1d1f, 'rubber'); // sole
    at(s, boxG(0.07, 0.022, 0.05, V(0, D.shin + 0.038, 0.035)), 0x1d1d1f, 'rubber'); // heel
    if (o.bigBoots) {
      at(s, capsule(0.24, 0.059, 0.063).translate(0, D.shin - 0.26, 0), o.boot, 'rubber');
      at(s, ellipsoid(V(0, D.shin - 0.16, -0.05), 0.045, 0.13, 0.022), 0x2a2c30, 'rubber'); // shin plate
      for (const y of [D.shin - 0.22, D.shin - 0.14, D.shin - 0.06]) {
        at(s, new THREE.TorusGeometry(0.063, 0.006, 6, 28).rotateX(Math.PI / 2).translate(0, y, 0), 0x2a2c30, 'rubber');
        at(s, boxG(0.012, 0.022, 0.03, V(0.066 * (s === B.shinR ? 1 : -1), y, 0.0)), 0xc0c4c8, 'metal'); // buckle
      }
    }
  }
  // head: per outfit, all sculpted surfaces on the head bone
  const hc = BP ? BP.head.centre.clone() : V(0, 0.135, -0.01);
  if (o.head === 'leather') at(B.head, torusAB(0.062, 0.022, Math.PI * 2, 28).rotateX(Math.PI / 2).translate(0, 0.03, 0), 0xf2f2ee); // silk scarf
  const HR = BP ? [BP.head.radii.x, BP.head.radii.y, BP.head.radii.z] : [0.087, 0.112, 0.104]; // a touch generous: heads must read at play distance, not just in close-up
  const eyesAt = [];
  const meshFace = (withHair = true) => { // the body mesh's head: irises on its eyeballs, hair grown out of its scalp
    const hinv = R(B.head).invert(), P3 = (i) => V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv);
    for (const e of [1, 2]) {
      const pts = []; for (let i = 0; i < BP.eye.length; i++) if (BP.eye[i] === e) pts.push(P3(i));
      if (!pts.length) continue; const c0 = pts.reduce((a, p) => a.add(p), V()).multiplyScalar(1 / pts.length), rr = pts.reduce((m, p) => Math.max(m, p.distanceTo(c0)), 0); eyesAt.push({ c: c0, r: rr });
      at(B.head, ellipsoid(c0.clone().add(V(0, 0, -rr * 0.93)), rr * 0.48, rr * 0.5, rr * 0.12), 0x4a3524, 'paint'); // iris
      at(B.head, ellipsoid(c0.clone().add(V(0, 0, -rr * 1.0)), rr * 0.22, rr * 0.23, rr * 0.06), 0x050505, 'paint'); // pupil
    }
    if (!withHair) return;
    // hair: grown from the scalp above the hairline (clean edge, thinning to nothing at it)
    const edge = (u) => { const au = Math.abs(u); return (au < 0.8 ? 0.48 - 0.12 * (au / 0.8) ** 2 : au < 1.7 ? 0.36 - 0.34 * ((au - 0.8) / 0.9) : -0.02 - 0.4 * Math.min(1, (au - 1.7) / 1.2)) + 0.02 * Math.sin(u * 13); };
    bodyShell((i) => { if (BP.seg[i] !== 'head') return -1; const p = P3(i), u = Math.atan2(p.x - hc.x, -(p.z - hc.z)), v = Math.asin(Math.max(-1, Math.min(1, (p.y - hc.y) / HR[1]))); return v - edge(u); }, 0.008, hair, 'hair', { hem: 0.2, smooth: 2 });
  };
  const face = (withHair = true) => { if (BP) return meshFace(withHair);
    at(B.head, dsphere(hc, ...HR, faceDisp), skin, 'skin');
    for (const sx of [-1, 1]) {
      const eu = sx * 0.37, ev = 0.14, ec = dsPoint(hc, ...HR, faceDisp, eu, ev, -0.0035), fw = V(0, 0, -1);
      at(B.head, ellipsoid(ec, 0.0122, 0.0122, 0.0122), 0xf1ece4, 'paint'); // eyeball, bulging a little out of the socket
      at(B.head, ellipsoid(ec.clone().addScaledVector(fw, 0.0113), 0.0058, 0.006, 0.0016), 0x4a3524, 'paint'); // iris
      at(B.head, ellipsoid(ec.clone().addScaledVector(fw, 0.0124), 0.0027, 0.0028, 0.0008), 0x050505, 'paint'); // pupil
      at(B.head, ellipsoid(ec.clone().add(V(0, 0.0008, 0.0004)), 0.0134, 0.0132, 0.0134, { th: [0, Math.PI * 0.31] }), skin, 'skin'); // upper lid
      at(B.head, ellipsoid(ec.clone().add(V(0, -0.0006, 0.0004)), 0.013, 0.0128, 0.013, { th: [Math.PI * 0.8, Math.PI * 0.2] }), skin, 'skin'); // lower lid
      { const b0 = dsPoint(hc, ...HR, faceDisp, sx * 0.12, 0.27, 0.0015), b1 = dsPoint(hc, ...HR, faceDisp, sx * 0.33, 0.3, 0.0015), b2 = dsPoint(hc, ...HR, faceDisp, sx * 0.55, 0.26, 0.0012); // brow: an arch along the brow ridge
        at(B.head, capAB(b0, b1, 0.0028, 0.0026, { sz: 0.45, seg: 10, hint: V(0, 1, 0) }), hair, 'hair'); at(B.head, capAB(b1, b2, 0.0026, 0.0015, { sz: 0.45, seg: 10, hint: V(0, 1, 0) }), hair, 'hair'); }
      at(B.head, ellipsoid(V(sx * 0.082, hc.y - 0.002, hc.z + 0.006), 0.012, 0.028, 0.02), skin, 'skin'); // ear
      at(B.head, ellipsoid(V(sx * 0.088, hc.y - 0.002, hc.z + 0.006), 0.005, 0.018, 0.012), skin, 'skin'); // ear rim
    }
    if (withHair) { // hair: a shell over the scalp, thinning to nothing at an uneven hairline, a side part, clumps on top
      const edge = (u) => { const au = Math.abs(u); return (au < 0.95 ? 0.5 - 0.1 * (au / 0.95) ** 2 : au < 2.2 ? 0.4 - 0.32 * ((au - 0.95) / 1.25) : 0.08 - 0.25 * ((au - 2.2) / 0.94)) + 0.025 * Math.sin(u * 13) + 0.015 * Math.sin(u * 29 + 1); };
      at(B.head, dsphere(hc, HR[0], HR[1], HR[2], (u, v) => { const e = edge(u), t = sstep(e, e + 0.1, v); return 0.0018 + (0.0055 + 0.004 * gs(u - 0.25, v - 1.0, 0.6, 0.5) + 0.0025 * (Math.sin(u * 19 + v * 6) * 0.5 + Math.sin(u * 8 - v * 13) * 0.5)) * t - 0.0018 * gs(u + 0.22, v - 1.05, 0.03, 0.5) + faceDisp(u, v); },
        { w: 128, h: 80, hole: (u, v) => v < edge(u) }), hair, 'hair');
    }
  };
  // helmets: one sculpted shell with the eye port left open; a motocross chin "beak", goggles in the port (frame,
  // mirrored lens, strap) and a long peak; road / car helmets close the port with a big visor; jet helmets are open
  // below the visor
  const helmetShell = (big, kind) => {
    const port = kind === 'jet' ? (u, v) => Math.abs(u) < 0.95 && v < 0.33 && v > -0.95 : (u, v) => Math.abs(u) < 0.78 && v > -0.02 && v < 0.32;
    const disp = (u, v) => {
      const au = Math.abs(u); let d = 0.004 * gs(u, v - 1.25, 0.25, 0.25) + 0.006 * gs(au - Math.PI, v + 0.1, 0.8, 0.4); // crown ridge, rear spoiler
      if (kind === 'mx') d += 0.055 * gs(u, v + 0.3, 0.33, 0.17) * sstep(0.05, -0.15, v); // the chin beak
      if (kind === 'road') d += 0.012 * gs(u, v + 0.3, 0.6, 0.2);
      return d;
    };
    return dsphere(hc, 0.128 * big, 0.136 * big, 0.143 * big, disp, { hole: (u, v) => port(u, v) || v < (kind === 'jet' ? -0.55 : -0.78) });
  };
  const portRing = (big, inset, out) => { // a closed path round the eye port, standing `out` off the shell
    const pts = [], N = 40;
    for (let k2 = 0; k2 < N; k2++) { const t = (k2 / N) * Math.PI * 2, uu = Math.sign(Math.cos(t)) * Math.abs(Math.cos(t)) ** 0.35 * (0.78 - inset), vv = 0.15 + Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** 0.5 * (0.17 - inset * 0.6);
      const d = V(Math.cos(vv) * Math.sin(uu), Math.sin(vv), -Math.cos(vv) * Math.cos(uu)); pts.push(V(hc.x + d.x * (0.128 * big + out), hc.y + d.y * (0.136 * big + out), hc.z + d.z * (0.143 * big + out))); }
    return pts;
  };
  if (o.head === 'helmet' || o.head === 'fullface' || o.head === 'bubble') {
    const big = o.head === 'bubble' ? 1.18 : 1, kind = o.head === 'bubble' ? 'bubble' : o.peak ? 'mx' : o.head === 'fullface' ? 'road' : 'jet';
    if (kind !== 'bubble') face(false);
    if (kind === 'bubble') at(B.head, ellipsoid(hc, 0.128 * big, 0.135 * big, 0.142 * big, { w: 48, h: 32, th: [0, Math.PI * 0.66] }), o.helmet, 'paint');
    else at(B.head, helmetShell(big, kind), o.helmet, 'paint');
    if (kind !== 'bubble') at(B.head, dsphere(hc, 0.1295, 0.1375, 0.1445, null, { hole: (u, v) => Math.abs(u) > 0.09 || v < 0.3 }), o.helmet2, 'paint'); // centre stripe
    if (kind === 'mx') {
      const ring = portRing(big, 0.0, 0.016);
      for (let k2 = 0; k2 < ring.length; k2++) at(B.head, capAB(ring[k2], ring[(k2 + 1) % ring.length], 0.0105, 0.0105, { seg: 10, ring: 2 }), 0x15161a, 'rubber'); // goggle frame
      at(B.head, dsphere(hc, 0.128 + 0.021, 0.136 + 0.021, 0.143 + 0.021, null, { hole: (u, v) => !(Math.abs(u) < 0.74 && v > 0.0 && v < 0.3) }), o.visor, 'glass'); // lens
      at(B.head, dsphere(hc, 0.131, 0.139, 0.146, null, { hole: (u, v) => !(v > 0.08 && v < 0.24 && Math.abs(u) > 0.74) }), o.helmet2, 'fabric'); // strap
      const pk = new THREE.Shape(); pk.moveTo(-0.08, 0); pk.quadraticCurveTo(-0.115, 0.1, -0.065, 0.165); pk.lineTo(0.065, 0.165); pk.quadraticCurveTo(0.115, 0.1, 0.08, 0); pk.closePath();
      const pg = new THREE.ExtrudeGeometry(pk, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 16 });
      pg.rotateX(-Math.PI / 2); // shape +Y -> forward (-Z)
      { const pp = pg.attributes.position; for (let k2 = 0; k2 < pp.count; k2++) { const x = pp.getX(k2); pp.setY(k2, pp.getY(k2) - 0.6 * x * x); } pg.computeVertexNormals(); } // curved across
      pg.rotateX(0.2); // tipped up
      const anchor = dsPoint(hc, 0.128, 0.136, 0.143, null, 0, 0.5, 0.004); pg.translate(anchor.x, anchor.y, anchor.z + 0.03); at(B.head, pg, o.helmet2, 'paint'); // peak
      const beak = (u, v) => 0.055 * gs(u, v + 0.3, 0.33, 0.17) * sstep(0.05, -0.15, v);
      for (const uu of [-0.16, 0, 0.16]) { const vp = dsPoint(hc, 0.128, 0.136, 0.143, beak, uu, -0.22, 0.001); at(B.head, boxG(0.012, 0.005, 0.018, vp), 0x15161a, 'rubber'); } // chin vents
    } else if (kind === 'road' || kind === 'jet') {
      at(B.head, dsphere(hc, 0.128 + 0.012, 0.136 + 0.012, 0.143 + 0.012, null, { hole: (u, v) => !(Math.abs(u) < (kind === 'jet' ? 1.0 : 0.85) && v > (kind === 'jet' ? -0.15 : -0.04) && v < 0.36) }), o.visor, 'glass'); // visor
      for (const sx of [-1, 1]) at(B.head, new THREE.CylinderGeometry(0.014, 0.014, 0.006, 16).rotateZ(Math.PI / 2).translate(sx * 0.137, hc.y + 0.02, hc.z - 0.02), 0x2a2c30, 'rubber'); // visor pivots
    } else { // spacesuit: big gold visor
      const vis = frontPatch(0.148 * big, 1.05, Math.PI * 0.3, Math.PI * 0.72, 36, 16); vis.translate(hc.x, hc.y, hc.z); at(B.head, vis, o.visor, 'glass');
    }
    if (o.mask) { // oxygen mask over nose and mouth, with the hose down to the chest
      at(B.head, ellipsoid(V(0, hc.y - 0.045, hc.z - 0.11), 0.05, 0.055, 0.045), 0x4c5047, 'rubber');
      at(B.head, capAB(V(0.02, hc.y - 0.08, hc.z - 0.12), V(0.06, hc.y - 0.17, hc.z - 0.1), 0.014, 0.014), 0x2a2c2e, 'rubber');
      for (const sx of [-1, 1]) at(B.head, ellipsoid(V(sx * 0.1, hc.y - 0.02, hc.z - 0.04), 0.012, 0.012, 0.03), 0x9aa0a6, 'metal');
    }
    if (o.mic) at(B.head, capAB(V(0.11, hc.y - 0.02, hc.z - 0.02), V(0.035, hc.y - 0.055, hc.z - 0.11), 0.006, 0.009), 0x15161a, 'rubber');
    if (o.ring) at(B.head, torusAB(0.16, 0.022, Math.PI * 2, 48).rotateX(Math.PI / 2).translate(0, 0.02, 0), o.trim, 'paint');
  } else if (o.head === 'headset') {
    face();
    at(B.head, torusAB(0.1, 0.008, Math.PI, 32).translate(0, hc.y + 0.008, hc.z + 0.012), o.cups, 'rubber'); // headband
    for (const sx of [-1, 1]) { const cup = new THREE.CylinderGeometry(0.038, 0.041, 0.034, 28); cup.rotateZ(Math.PI / 2); cup.translate(sx * 0.1, hc.y, hc.z + 0.012); at(B.head, cup, o.cups, 'rubber');
      const pad = new THREE.TorusGeometry(0.03, 0.01, 8, 24).rotateY(Math.PI / 2).translate(sx * 0.086, hc.y, hc.z + 0.012); at(B.head, pad, 0x15161a, 'rubber'); }
    at(B.head, capAB(V(-0.1, hc.y - 0.02, hc.z - 0.005), V(-0.035, hc.y - 0.052, hc.z - 0.098), 0.004, 0.005), 0x15161a, 'rubber'); // boom mic
    at(B.head, ellipsoid(V(-0.032, hc.y - 0.054, hc.z - 0.1), 0.009, 0.008, 0.01), 0x15161a, 'rubber');
    if (o.glasses) aviators();
  } else if (o.head === 'cap') {
    face();
    // a baseball cap: six-panel crown down to just above the ears, a button on top, the brim forward, curved and tipped down
    const capR = [HR[0] + 0.024, HR[1] + 0.022, HR[2] + 0.026]; // clear of the hair under it
    if (BP) { const hinv2 = R(B.head).invert(), capLine = (u) => (Math.abs(u) < 0.9 ? 0.3 : 0.3 - 0.2 * Math.min(1, (Math.abs(u) - 0.9) / 0.9));
      bodyShell((i) => { if (seg(i) !== 'head') return -1; const p = V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv2), u = Math.atan2(p.x - hc.x, -(p.z - hc.z)), v = Math.asin(clamp((p.y - hc.y) / HR[1], -1, 1)); return v - capLine(u); }, 0.022, o.cap, 'fabric', { hem: 1.1 }); }
    else at(B.head, dsphere(hc, ...capR, (u, v) => 0.004 * gs(u, v - 0.6, 0.6, 0.4), { w: 64, h: 40, hole: (u, v) => v < (Math.abs(u) < 0.9 ? 0.3 : 0.3 - 0.2 * Math.min(1, (Math.abs(u) - 0.9) / 0.9)) }), o.cap, 'fabric');
    at(B.head, ellipsoid(V(hc.x, hc.y + capR[1] + 0.002, hc.z), 0.01, 0.006, 0.01), o.cap, 'fabric'); // button
    const pk = new THREE.Shape(); pk.moveTo(-0.085, 0); pk.quadraticCurveTo(-0.095, 0.07, -0.04, 0.095); pk.quadraticCurveTo(0, 0.102, 0.04, 0.095); pk.quadraticCurveTo(0.095, 0.07, 0.085, 0); pk.quadraticCurveTo(0, 0.02, -0.085, 0); pk.closePath();
    const pg = new THREE.ExtrudeGeometry(pk, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 16 });
    pg.rotateX(-Math.PI / 2); // shape +Y -> forward (-Z)
    { const pp = pg.attributes.position; for (let k2 = 0; k2 < pp.count; k2++) { const x = pp.getX(k2); pp.setY(k2, pp.getY(k2) - 2.2 * x * x); } pg.computeVertexNormals(); } // curved down at the sides
    pg.rotateX(-0.14);
    let an = dsPoint(hc, ...capR, null, 0, 0.3, 0).add(V(0, -0.004, 0.012));
    if (BP) { // on the mesh head: the crown's front edge (the scalp at the cap line, straight ahead, plus the crown's thickness)
      const hinv3 = R(B.head).invert(), nm3 = new THREE.Matrix3().getNormalMatrix(hinv3); let best = null;
      for (let i = 0; i < BP.seg.length; i++) { if (BP.seg[i] !== 'head' || BP.eye[i]) continue; const p = V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv3);
        const u = Math.atan2(p.x - hc.x, -(p.z - hc.z)), v = Math.asin(clamp((p.y - hc.y) / HR[1], -1, 1)), sc = Math.abs(u) * 2 + Math.abs(v - 0.3); if (!best || sc < best.sc) best = { sc, i, p }; }
      if (best) { const nn = V(BP.nrm[best.i * 3], BP.nrm[best.i * 3 + 1], BP.nrm[best.i * 3 + 2]).applyMatrix3(nm3).normalize(); an = best.p.clone().addScaledVector(nn, 0.022).add(V(0, -0.006, 0.02)); }
    }
    pg.translate(an.x, an.y, an.z); at(B.head, pg, o.cap, 'fabric');
    aviators(true);
  } else if (o.head === 'leather') {
    face(false);
    at(B.head, dsphere(hc, HR[0] + 0.01, HR[1] + 0.008, HR[2] + 0.01, (u, v) => 0.002 * Math.sin(v * 30), { hole: (u, v) => Math.abs(u) < 0.95 && v < 0.36 && v > -0.6 || v < -0.6 }), 0x5a3a22, 'rubber');
    for (const sx of [-1, 1]) {
      const ring = torusAB(0.026, 0.007, Math.PI * 2, 24); ring.rotateX(-0.6); ring.translate(sx * 0.035, hc.y + 0.078, hc.z - 0.078); at(B.head, ring, 0x9aa0a6, 'metal');
      at(B.head, ellipsoid(V(sx * 0.035, hc.y + 0.078, hc.z - 0.082), 0.022, 0.022, 0.006), 0x6f8fa0, 'glass');
    }
    at(B.head, capAB(V(-0.06, hc.y + 0.083, hc.z - 0.05), V(0.06, hc.y + 0.083, hc.z - 0.05), 0.007, 0.007), 0x3a2618, 'rubber');
  }
  function aviators(bold = false) { // two big lenses on the face, a bar across the top and arms back to the ears
    const k = bold ? 1.2 : 1, fr = bold ? 0x15161a : 0xb9a77a;
    if (BP && eyesAt.length === 2) { // on the mesh face: lenses in front of its eyes, a bridge, arms back over the ears
      const fs = bold ? 'rubber' : 'metal';
      for (const e of eyesAt) {
        const lc = e.c.clone().add(V(0, -e.r * 0.15, -e.r * 1.75)), sx = Math.sign(e.c.x - hc.x) || 1;
        const lens = new THREE.SphereGeometry(1, 32, 16); lens.scale(e.r * 1.6 * k, e.r * 1.25 * k, e.r * 0.3); lens.translate(lc.x, lc.y, lc.z); at(B.head, lens, 0x0b0d10, 'glass');
        const rim = new THREE.TorusGeometry(1, 0.07, 8, 40); rim.scale(e.r * 1.65 * k, e.r * 1.3 * k, e.r); rim.translate(lc.x, lc.y, lc.z - e.r * 0.05); at(B.head, rim, fr, fs);
        at(B.head, capAB(lc.clone().add(V(sx * e.r * 1.6 * k, e.r * 0.3, 0)), V(hc.x + sx * HR[0] * 0.98, lc.y + e.r * 0.3, hc.z + HR[2] * 0.15), 0.0022 * k, 0.0022 * k), fr, fs); // arm
      }
      const [a0, a1] = eyesAt.map((e) => e.c.clone().add(V(0, e.r * 0.55, -e.r * 1.8))); at(B.head, capAB(a0, a1, 0.0022 * k, 0.0022 * k), fr, fs); // bridge
      return;
    }
    for (const sx of [-1, 1]) {
      at(B.head, dsPatch(hc, ...HR, faceDisp, sx * 0.37, 0.12, 0.22 * k, 0.135 * k, 0.01, { tilt: sx * 0.1, drop: 0.3 }), 0x0b0d10, 'glass'); // lens
      at(B.head, dsPatch(hc, ...HR, faceDisp, sx * 0.37, 0.12, 0.235 * k, 0.15 * k, 0.0098, { tilt: sx * 0.1, drop: 0.3, rings: 1 }), fr, bold ? 'rubber' : 'metal'); // rim
      at(B.head, capAB(dsPoint(hc, ...HR, faceDisp, sx * 0.62, 0.17, 0.01), V(sx * (HR[0] + 0.004), hc.y + 0.02, hc.z + 0.01), 0.0022 * k, 0.0022 * k), fr, bold ? 'rubber' : 'metal'); // arm
    }
    at(B.head, capAB(dsPoint(hc, ...HR, faceDisp, -0.6, 0.23, 0.011), dsPoint(hc, ...HR, faceDisp, 0.6, 0.23, 0.011), 0.0024 * k, 0.0024 * k), fr, bold ? 'rubber' : 'metal'); // top bar
  }
  // ---- controls ----
  const C = rig.C, blk = 0x15161a, metal = 0x6b7077;
  if (rig.ctl === 'stick' || rig.ctl === 'cyclic') {
    at(B.ctlA, capsule(0.06, 0.05, 0.035, { seg: 10 }).translate(0, -0.02, 0), blk); // rubber boot
    at(B.ctlA, capsule(C.stickLen - 0.06, 0.013, 0.013, { seg: 6 }), metal, true);
    at(B.ctlA, capsule(0.1, 0.022, 0.026, { seg: 8 }).translate(0, C.stickLen - 0.06, 0), blk); // grip
    at(B.ctlA, ellipsoid(V(0, C.stickLen + 0.04, -0.012), 0.008, 0.008, 0.008), 0xc8102e, true); // trigger / button
    if (rig.ctl === 'stick') {
      at(B.hips, boxG(0.1, 0.06, 0.34, V(C.thrBase.x, C.thrBase.y - 0.02, C.thrBase.z - 0.02)), 0x2b2d31); // throttle quadrant
      at(B.ctlB, capsule(C.thrLen, 0.01, 0.01, { seg: 6 }), metal, true);
      at(B.ctlB, ellipsoid(V(0, C.thrLen, 0), 0.026, 0.03, 0.04), blk);
    } else {
      at(B.ctlB, capsule(C.collLen, 0.016, 0.016, { seg: 6 }), metal, true);
      at(B.ctlB, capsule(0.12, 0.024, 0.024, { seg: 8 }).translate(0, C.collLen - 0.1, 0), blk);
    }
  } else if (rig.ctl === 'yoke') {
    at(B.ctlA, capsule(C.colLen, 0.035, 0.03, { seg: 8 }), 0x3a3d42);
    // yoke: a "ram's horn" bar with two grips, in the plane facing the pilot (local XY of ctlB after the tilt)
    const bar = capAB(V(-C.yokeR, 0.0, 0), V(C.yokeR, 0.0, 0), 0.018, 0.018, { seg: 6 }); at(B.ctlB, bar, blk);
    for (const sx of [-1, 1]) at(B.ctlB, capAB(V(sx * C.yokeR, -0.02, 0), V(sx * C.yokeR * 1.05, 0.08, 0), 0.022, 0.022, { seg: 8 }), blk);
    at(B.ctlB, boxG(0.08, 0.05, 0.04, V(0, 0.0, 0.01)), 0x3a3d42);
  } else if (rig.ctl === 'wheel') {
    const rim = torusAB(C.wheelR, 0.017, Math.PI * 2, 28); at(B.ctlA, rim, blk);
    for (const a of [Math.PI / 2, Math.PI * 1.18, Math.PI * 1.82]) at(B.ctlA, capAB(V(0, 0, 0), V(Math.cos(a) * C.wheelR, Math.sin(a) * C.wheelR, 0), 0.012, 0.012, { seg: 6 }), 0x8a8f96, true);
    at(B.ctlA, new THREE.CylinderGeometry(0.045, 0.05, 0.04, 14).rotateX(Math.PI / 2), 0x2b2d31);
    at(B.ctlA, ellipsoid(V(0, C.wheelR, 0.0), 0.02, 0.012, 0.02), 0xe8601c); // top-centre marker
    at(B.ctlA, capAB(V(0, 0, -0.02), V(0, 0, -0.42), 0.025, 0.03, { seg: 8 }), 0x2b2d31); // column, forward into the dash
  }
  // pedals
  if (rig.ctl !== 'bars') for (const i of [B.pedR, B.pedL]) {
    at(i, boxG(0.085, 0.16, 0.018, V(0, 0.07, 0)), rig.ctl === 'wheel' && i === B.pedR ? 0x9aa0a6 : 0x2b2d31);
    at(i, capAB(V(0, 0.0, 0.02), V(0, 0.14, 0.1), 0.01, 0.01, { seg: 5 }), 0x2b2d31);
  }
  return k.build();
}

// Where the figure looks from (rig space, rest pose, head straight): just behind the eyes on the head bone.
function eyePoint(rig) {
  const r = new Rig(rig.kind, rig.ctl, rig.o, rig.seed, { pegs: rig.pegs, groundY: rig.groundY }); // (posed at rest)
  const k = rig.o.head === 'bubble' ? 1.18 : 1;
  return V(0, 0.155, -0.075 * k).applyQuaternion(r.q[B.head]).add(r.p[B.head]);
}

const geoCache = new Map();
// outfit: OUTFITS key or object; ctl: 'stick' | 'cyclic' | 'yoke' | 'wheel' | 'none'; seed picks skin/hair tones
export function buildCrew(outfitKey, ctl = 'stick', { seed = 0, colors = null, pegs = null, groundY } = {}) {
  const outfit = { ...(OUTFITS[outfitKey] || OUTFITS.light), ...(colors || {}) };
  const rig = new Rig(outfitKey, ctl, outfit, seed, { pegs, groundY });
  const key = outfitKey + '|' + ctl + '|' + (seed % 4) + '|' + JSON.stringify(colors || 0) + (pegs ? '|' + JSON.stringify(pegs.map((v) => v.toArray().map((x) => +x.toFixed(3)))) : '');
  if (!geoCache.has(key)) geoCache.set(key, figureGeometry(rig));
  const geos = geoCache.get(key), mats = crewMaterials();
  const root = new THREE.Group(); root.name = 'crew';
  const bones = []; for (let i = 0; i < NB; i++) { const b = new THREE.Bone(); b.position.copy(rig.p[i]); b.quaternion.copy(rig.q[i]); root.add(b); bones.push(b); }
  root.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(bones);
  for (const [k, g] of Object.entries(geos)) {
    if (!g) continue;
    const m = new THREE.SkinnedMesh(g, mats[k] || mats.fabric); m.userData.near = true; m.userData.crew = true; m.userData.cosmetic = true; m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false; // a few hundred triangles; skinned bounds would otherwise need a refresh as the pose changes
    root.add(m); m.bind(skel, new THREE.Matrix4());
  }
  const smooth = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
  root.userData.crewRig = {
    rig, root,
    eye: eyePoint(rig), // rig space: between the eyes, head straight (cockpit view, stations.js)
    // where the eyes are now (rig space): a motorbike rider bends over the tank and leans into turns (stations.js)
    eyeNow(out = V()) { return out.set(0, 0.155, -0.075 * (outfit.head === 'bubble' ? 1.18 : 1)).applyQuaternion(rig.q[B.head]).add(rig.p[B.head]); },
    // first person: the head and torso (with whatever they wear) shrink to nothing so the camera in the head sees out;
    // hands, arms, legs and the controls stay
    firstPerson(on) { const k = on ? 1e-4 : 1; for (const i of [B.head, B.spine]) bones[i].scale.setScalar(k); },
    // c: { pitch, roll, yaw, throttle, steer } (stick back = +pitch, right = +roll and +yaw); returns true while still moving
    update(c, dt) {
      const k = Math.min(1, (dt || 0.016) * 12), s = smooth;
      const tgt = { pitch: clamp(c.pitch || 0, -1, 1), roll: clamp(c.roll || 0, -1, 1), yaw: clamp(c.yaw || 0, -1, 1), thr: clamp(c.throttle ?? 0.4, 0, 1), steer: clamp(c.steer || 0, -1.7, 1.7) };
      tgt.look = clamp(-(tgt.roll * 0.35 + tgt.yaw * 0.25) + tgt.steer * 0.25, -0.6, 0.6);
      if (rig.ctl === 'bars') { tgt.lean = clamp(c.lean || 0, -0.6, 0.6); tgt.tuck = clamp(c.tuck || 0, 0, 1); tgt.foot = clamp(c.foot || 0, 0, 1); tgt.bikeLean = clamp(c.bikeLean || 0, -1, 1); s.hands = c.hands || null; }
      let moving = false;
      for (const a in tgt) { const kk = a === 'look' ? k * 0.35 : k; const v = s[a] + (tgt[a] - s[a]) * kk; if (Math.abs(v - tgt[a]) > 1e-3) moving = true; s[a] = v; }
      rig.pose(s);
      for (let i = 0; i < NB; i++) { bones[i].position.copy(rig.p[i]); bones[i].quaternion.copy(rig.q[i]); }
      return moving;
    },
  };
  return root;
}

// ---------- dressing a design's seats ----------
// Which crew a vehicle gets: from its parts (rotor = helicopter crew, drive engine = racing driver, rocket + RCS = an
// astronaut, jets = fighter pilot, radial = warbird pilot, airliner nose = airline crew, otherwise a light-plane pilot).
export function crewKind(design, cockpitId) {
  const ids = new Set(design.parts.map((p) => p.id)), has = (f) => design.parts.some((p) => f(PARTS[p.id] || {}, p.id));
  if (cockpitId === 'ck_airliner') return 'airline';
  if (has((d) => d.boatHull)) return 'boat';
  if (has((d) => d.engine?.type === 'rotor')) return 'heli';
  if (has((d) => d.engine?.type === 'drive')) return 'driver';
  if (ids.has('x_rcs') && has((d) => d.engine?.type === 'rocket')) return 'space';
  if (has((d) => d.engine?.type === 'jet' || d.engine?.type === 'rocket')) return 'jet';
  if (ids.has('e_radial')) return 'warbird';
  if (design.livery === 'racer') return 'racer'; // air racer: helmet and race suit
  return 'light';
}
const CTL_OF = { airline: 'yoke', heli: 'cyclic', driver: 'wheel', boat: 'wheel' };

// Add a figure to every declared seat (obj.userData.seats: [{ p: [x,y,z], s, ctl?, yaw? | quat?, role? }]).
// role 'crew' = a passenger / second crew member with no controls. Returns the rigs (also on obj.userData.crew).
export function addCrew(design, objs) {
  const rigs = [];
  design.parts.forEach((p, i) => {
    const obj = objs[i], seats = obj?.userData?.seats; if (!seats?.length) return;
    let kind = crewKind(design, p.id);
    const list = [];
    seats.forEach((st, k) => {
      let outfit = kind, ctl = st.ctl || CTL_OF[kind] || 'stick', colors = null, pegs = null, groundY;
      if (st.role === 'crew') { outfit = kind === 'heli' ? 'medic' : kind; ctl = 'none'; }
      if (kind === 'driver') colors = { helmet: p.color === 0x15161a || p.color == null ? 0xe8601c : 0xf2b705, helmet2: 0x15161a };
      // a rider sits on the frame part, which a kid may have resized, and not evenly (wider, longer, taller): the rider
      // must not be stretched with it. It keeps its own proportions at the frame's average size (scaled back by the
      // frame's own scale), and its pegs and the ground are measured in that unstretched space.
      let fit = null;
      if (ctl === 'bars') { // a rider in the bike's colours, feet on the frame's pegs (seat space -> rig space)
        outfit = st.rider || 'mx'; colors = { suit: p.color ?? OUTFITS[outfit].suit, helmet2: p.color ?? OUTFITS[outfit].helmet2 };
        const ps = V(Math.abs(obj.scale.x) || 1, Math.abs(obj.scale.y) || 1, Math.abs(obj.scale.z) || 1), sc = (st.s || 1) * Math.cbrt(ps.x * ps.y * ps.z);
        fit = V(sc / ps.x, sc / ps.y, sc / ps.z);
        const at = V(...st.p); pegs = (st.pegs || []).map((q) => V(...q).sub(at).multiply(ps).divideScalar(sc)); if (pegs.length !== 2) pegs = null;
        if (st.ground != null) groundY = (st.ground - st.p[1]) * ps.y / sc;
      }
      const c = buildCrew(outfit, ctl, { seed: i * 3 + k, colors, pegs, groundY });
      Object.assign(c.userData.crewRig, { role: st.role || 'pilot', kind, ctl, part: i, seat: k }); // (stations.js names the cockpit views from these)
      c.position.set(...st.p); if (st.quat) c.quaternion.fromArray(st.quat); else if (st.yaw) c.rotation.y = st.yaw;
      if (fit) c.scale.copy(fit); else c.scale.setScalar(st.s || 1);
      obj.add(c); list.push(c.userData.crewRig);
    });
    obj.userData.crew = list; rigs.push(...list);
  });
  return rigs;
}
