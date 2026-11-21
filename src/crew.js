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
import { bodyReady, body, person, poseBody, handModel, torsoPoints, bodyDims, spinePose } from './body.js';
const LIP_BONES = /^oris/; // the mouth's ring muscle in the body mesh's skeleton: its skin is the lips
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
// who each seed is (the body mesh's macro targets, body.js person()): ancestry loosely matching the skin tone, sex,
// age, build and height, so two crew side by side are two different people
const PEOPLE = [
  { anc: [0.1, 0.2, 0.7], male: 0.95, age: 0.12, muscle: 0.25, weight: 0.15, height: 0.25 },
  { anc: [0.15, 0.55, 0.3], male: 0.04, age: 0.05, muscle: 0.0, weight: -0.25, height: -0.45 },
  { anc: [0.85, 0.05, 0.1], male: 0.92, age: 0.28, muscle: 0.4, weight: 0.45, height: 0.45 },
  { anc: [0.0, 0.1, 0.9], male: 0.06, age: 0.18, muscle: 0.1, weight: 0.1, height: -0.1 },
];
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
  boat: { head: 'cap', glasses: true, vest: 0xf26a1b, suit: 0x2f5d8a, suit2: 0x6f7f8f, trim: 0x15161a, glove: null, boot: 0x7a4a2c, cap: 0xf2f2ee, tee: true, shorts: true }, // T-shirt and shorts under the life jacket
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
function torusAB(R, r, arc, seg = 24, rad = 6) { return new THREE.TorusGeometry(R, r, rad, seg, arc); }
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
const B = { hips: 0, spine: 1, head: 2, uArmR: 3, fArmR: 4, uArmL: 5, fArmL: 6, thighR: 7, shinR: 8, thighL: 9, shinL: 10, ctlA: 11, ctlB: 12, pedR: 13, pedL: 14, ctlC: 15, handR: 16, handL: 17 };
const NB = 18;
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
    const C = CTL[ctl] || CTL.none; this.body = outfit.head !== 'bubble' && body() ? person(PEOPLE[seed % PEOPLE.length]) : null;
    const HM = this.body ? handModel(this.body) : null;
    // proportions: the body mesh's own (measured from its joints, so its limbs aren't stretched), else the procedural set
    const D = this.D = HM ? { ...DIM, ...bodyDims(this.body) } : DIM;
    this.C = C;
    // the hand's grip geometry: the body mesh's measured hand, or the procedural fist (bar 6.2 cm past the wrist, 1.6 cm
    // under the bone line, thumb on the inboard side)
    this.hand = HM ? { G: (k, r) => HM[k].G(r), thumb: { R: HM.R.thumb, L: HM.L.thumb } } : { G: () => V(0, 0.062, -0.016), thumb: { R: -1, L: 1 } };
    // the seated spine (body mesh): the pelvis rolls back (lean), the back bends forward over four vertebrae (flex) and
    // the shoulders come forward towards the hands (protract); the rig's shoulders and neck are where that leaves them
    const reach = ctl === 'wheel' || ctl === 'stick' || ctl === 'cyclic' || ctl === 'yoke';
    this.spine = HM ? spinePose(D, ctl === 'bars' ? 0.15 : 0.5, ctl === 'bars' ? 0.15 : reach ? 0.22 : 0.08, this.body) : null;
    const lean = HM && ctl !== 'bars' ? 0.3 : D.lean;
    // static joints
    const spineQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), lean);
    this.spineQ = spineQ;
    // sitting in the seat: given the seat's surfaces (opts.seat, rig space: cushion top, the seat back's front face at
    // the cushion and its rake), the body moves so its lowest point (plus clothing) rests on the cushion, sunk a
    // little, and its back (plus what's worn on it) meets the seat back. The controls stay where the vehicle put them.
    this.base = V();
    const TP = opts.seat && HM ? torsoPoints(D, this.spine, this.body) : null;
    if (TP) {
      const st = opts.seat, sM = new THREE.Matrix4().compose(V(0, 0.03, 0), spineQ, V(1, 1, 1)), pts = [...TP.hips, ...TP.spine.map((p) => p.clone().applyMatrix4(sM))];
      const seatT = outfit.shorts ? 0.008 : 0.012, backT = outfit.vest ? 0.034 : outfit.tee || outfit.shirt ? 0.006 : 0.012;
      let minY = Infinity; for (const p of pts) minY = Math.min(minY, p.y - seatT);
      const dy = st.panTop - 0.012 - minY, tk = Math.tan(st.tilt); let dz = Infinity;
      for (const p of pts) { const y = p.y + dy; if (y < st.panTop + 0.06 || y > st.backTop) continue; dz = Math.min(dz, st.backZ + tk * (y - st.panTop) + 0.008 - (p.z + backT)); }
      this.base.set(0, dy, Number.isFinite(dz) ? dz : 0);
      this.seatY = st.panTop; if (st.floor != null) this.floorY = st.floor;
    }
    this.spinePos = V(0, 0.03, 0).add(this.base);
    const sp = (x, y, z) => V(x, y, z).applyQuaternion(spineQ).add(this.spinePos);
    this.joints(sp);
    this.hipR = V(D.hipW, 0, 0).add(this.base); this.hipL = V(-D.hipW, 0, 0).add(this.base);
    // a seated person's shins lean forward 12 degrees, or further if the seat is low for their legs: as far as keeps the
    // knees' tops within 6 cm of the hips (tall people sit with their feet further out)
    this.shinLean = 0.21;
    if (opts.seat?.floor != null) { const ay = opts.seat.floor + (D.ankleH ?? 0.07), c = (this.hipR.y + 0.06 - (D.thighTop ?? 0.075) - ay) / D.shin; this.shinLean = clamp(Math.acos(clamp(c, -1, 1)), 0.21, 1.0); }
    // the wheel comes to the seated driver: its column slides (along the rig's z) until the hands' grips are a relaxed
    // reach from the shoulders (the wrist at 78% of the arm's length, plus the hand), elbows bent about 120 degrees as a relaxed driver's are
    this.col = C.col ? C.col.clone() : null;
    if (ctl === 'wheel') {
      const tq = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -C.tilt), off = V(Math.sin(1.15) * C.wheelR, Math.cos(1.15) * C.wheelR, 0).applyQuaternion(tq);
      const want = 0.78 * (D.upper + D.fore) + this.hand.G('R', 0.017).length(), dist = (dz) => V(C.col.x, this.col.y, C.col.z + dz).add(off).distanceTo(this.shR);
      // and clear of the thighs: every point of the rim that is over a thigh (each thigh a line from its hip to its knee,
      // feet on the floor; its top the measured thigh surface) stays 3 cm above it. The rim's bottom, between the
      // knees, needn't.
      const fl = opts.seat?.floor, thighs = fl == null ? [] : [this.hipR, this.hipL].map((hip) => {
        const ky = fl + (D.ankleH ?? 0.07) + D.shin * Math.cos(this.shinLean), dy = hip.y - ky, kz = hip.z - Math.sqrt(Math.max(0, D.thigh * D.thigh - dy * dy)) * 0.995;
        return { a: hip.clone(), b: V(hip.x * 1.25, ky, kz) }; });
      const rimNeed = () => { let need = -Infinity; for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2, p = V(Math.cos(a) * C.wheelR, Math.sin(a) * C.wheelR, 0).applyQuaternion(tq).add(this.col);
        for (const t of thighs) { if ((p.z - t.a.z) * (p.z - t.b.z) > 0) continue; const c = t.a.clone().lerp(t.b, (p.z - t.a.z) / (t.b.z - t.a.z));
          if (Math.abs(p.x - c.x) < 0.08) need = Math.max(need, c.y + (D.thighTop ?? 0.075) + 0.03 - p.y); } } return need; };
      for (let pass = 0; pass < 4; pass++) {
        let lo = -0.3, hi = 0.4; // dist falls as dz grows (the wheel nears the driver)
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (dist(m) > want) lo = m; else hi = m; }
        this.col.z = C.col.z + (lo + hi) / 2;
        const need = rimNeed(); if (need > 0.002) this.col.y += need; else break; // (raised: the reach is solved again)
      }
    }
    this.state = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
    this.q = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.p = Array.from({ length: NB }, () => V());
    this.pose(this.state);
  }
  // neck and shoulders on the spine (sp: spine-local -> rig space): the posed spine's, else the procedural proportions
  joints(sp) {
    const D = this.D, S = this.spine;
    if (S) { this.neck = sp(S.neck.x, S.neck.y, S.neck.z); this.shR = sp(S.sh.R.x, S.sh.R.y, S.sh.R.z); this.shL = sp(S.sh.L.x, S.sh.L.y, S.sh.L.z); return; }
    this.neck = sp(0, D.spine, 0.0); this.shR = sp(D.shoulderW, D.shoulderUp, D.shoulderZ ?? 0.02); this.shL = sp(-D.shoulderW, D.shoulderUp, D.shoulderZ ?? 0.02);
  }
  // control bone transforms + hand/foot targets
  controls(s) {
    const C = this.C, p = this.p, q = this.q, hands = {}, feet = {}, axes = {}, radii = {}; // a grip: its bar's centre (hands), direction towards the thumb (axes) and radius
    const e = new THREE.Euler();
    if (this.ctl === 'stick' || this.ctl === 'cyclic') {
      // stick: pitch back (+) tilts the grip towards the pilot (+z), roll right (+) tilts it right
      p[B.ctlA].copy(C.stickBase); q[B.ctlA].setFromEuler(e.set(s.pitch * 0.32, 0, -s.roll * 0.3));
      const grip = V(0, C.stickLen, 0).applyQuaternion(q[B.ctlA]).add(C.stickBase);
      hands.R = V(0, C.stickLen - 0.03, 0).applyQuaternion(q[B.ctlA]).add(C.stickBase); axes.R = V(0, 1, 0).applyQuaternion(q[B.ctlA]); radii.R = 0.024; void grip;
      if (this.ctl === 'stick') {
        p[B.ctlB].copy(C.thrBase); q[B.ctlB].setFromEuler(e.set(-0.55 + s.thr * 1.1, 0, 0)); // forward = more throttle
        hands.L = V(0, C.thrLen, 0).applyQuaternion(q[B.ctlB]).add(C.thrBase); axes.L = V(0, 1, 0).applyQuaternion(q[B.ctlB]); radii.L = 0.028;
      } else {
        // collective: lever from a pivot behind, pointing forward; raised with the throttle
        p[B.ctlB].copy(C.collBase); q[B.ctlB].setFromEuler(e.set(-Math.PI / 2 + 0.18 + s.thr * 0.35, 0, 0));
        hands.L = V(0, C.collLen - 0.04, 0).applyQuaternion(q[B.ctlB]).add(C.collBase); axes.L = V(0, 1, 0).applyQuaternion(q[B.ctlB]); radii.L = 0.024;
      }
    } else if (this.ctl === 'yoke') {
      // column hinged at the floor: pull = back; the yoke turns about the column's top axis
      p[B.ctlA].copy(C.colBase); q[B.ctlA].setFromEuler(e.set(0.42 + s.pitch * 0.14, 0, 0));
      const top = V(0, C.colLen, 0).applyQuaternion(q[B.ctlA]).add(C.colBase);
      // the yoke stands nearly upright facing the pilot and turns about the axis towards the pilot (local Z)
      p[B.ctlB].copy(top); q[B.ctlB].setFromEuler(e.set(0.12, 0, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -s.roll * 0.7));
      for (const [k, sx] of [['R', 1], ['L', -1]]) { hands[k] = V(sx * C.yokeR * 1.025, 0.03, 0.0).applyQuaternion(q[B.ctlB]).add(top); axes[k] = V(sx * 0.075, 1, 0).applyQuaternion(q[B.ctlB]); radii[k] = 0.022; } // (the horns)
    } else if (this.ctl === 'wheel') {
      const tq = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -C.tilt); // the wheel's face looks up and back at the driver; its column runs forward and down into the dash
      p[B.ctlA].copy(this.col); q[B.ctlA].copy(tq).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), s.steer));
      for (const [k, a] of [['R', -1.15], ['L', 1.15]]) { hands[k] = V(Math.sin(-a) * C.wheelR, Math.cos(a) * C.wheelR, 0).applyQuaternion(q[B.ctlA]).add(this.col); axes[k] = V(Math.cos(a), Math.sin(a), 0).multiplyScalar(Math.sign(a)).applyQuaternion(q[B.ctlA]); radii[k] = 0.017; } // (the rim's tangent, thumbs towards 12 o'clock)
    } else if (this.ctl === 'bars') { // on the grips (rig space, from the fork), else resting on the tank
      hands.L = s.hands?.[0] || V(-0.2, 0.05, -0.42); hands.R = s.hands?.[1] || V(0.2, 0.05, -0.42); axes.L = V(1, 0, 0); axes.R = V(-1, 0, 0); radii.L = radii.R = 0.016; // (thumbs inboard)
      feet.L = this.pegs[0].clone().lerp(V(this.pegs[0].x - 0.1, this.groundY + 0.06, this.pegs[0].z - 0.12), s.foot || 0); // a foot down when stopped
      feet.R = this.pegs[1].clone();
      return { hands, feet, axes, radii };
    } else {
      this.restHands = true; // resting on the thighs: placed on them once the legs are posed (pose)
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
    return { hands, feet, axes, radii };
  }
  pose(s) {
    const D = this.D, p = this.p, q = this.q, { hands, feet, axes, radii } = this.controls(s), bars = this.ctl === 'bars';
    if (bars) { // a rider: bent forward over the tank (more when tucked at speed), leaning further into a turn than the bike
      const fwd = (this.o.hump ? 0.6 : 0.42) + (s.tuck || 0) * (this.o.hump ? 0.42 : 0.22), lean = s.lean || 0;
      this.hipAt = V(lean * 0.12, -Math.abs(lean) * 0.03, (s.tuck || 0) * 0.04);
      this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -lean).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -fwd));
      this.spinePos = V(0, 0.03, 0).add(this.hipAt);
      const sp = (x, y, z) => V(x, y, z).applyQuaternion(this.spineQ).add(this.spinePos);
      this.joints(sp);
      this.hipR = V(D.hipW, 0, 0).add(this.hipAt); this.hipL = V(-D.hipW, 0, 0).add(this.hipAt);
    }
    if (bars) p[B.hips].copy(this.hipAt); else p[B.hips].copy(this.base);
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
    // riders: elbows bent back and a little out and down (not winged out sideways), knees forward against the tank
    // (a sport rider's knees go out over the fairing's sides, gripping the tank, not through the fairing)
    const eR = bars ? V(0.45, -0.45, 0.75) : V(0.55, -0.8, 0.25), kR = bars ? (this.o.hump ? V(0.5, 0.5, -0.9) : V(0.35, 0.6, -1)) : V(0.1, 1, -0.4);
    // the elbow settles where the forearm crosses its bar square, on whichever side is nearer the usual elbow direction
    const gripPole = (S, T, a, b, hint, t) => {
      const d = T.clone().sub(S), L = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3); d.normalize();
      const x = (a * a - b * b + L * L) / (2 * L), y = Math.sqrt(Math.max(1e-6, a * a - x * x)), tn = t.clone().normalize();
      const u = tn.clone().addScaledVector(d, -tn.dot(d)), tp = u.length(); if (tp < 1e-3) return hint; u.divideScalar(tp);
      const v = V().crossVectors(d, u), c = clamp((L - x) * tn.dot(d) / (y * tp), -1, 1), sn = Math.sqrt(1 - c * c);
      const p1 = u.clone().multiplyScalar(c).addScaledVector(v, sn), p2 = u.clone().multiplyScalar(c).addScaledVector(v, -sn);
      const h = hint.clone().addScaledVector(d, -hint.dot(d)).normalize();
      return p1.dot(h) >= p2.dot(h) ? p1 : p2;
    };
    // Each hand is placed on its grip first and the arm follows. The hand's frame: X along the bar (the thumb's side
    // from the hand's measurements), Y (wrist to knuckles) square to the bar and in line with the forearm (a straight
    // wrist), Z = X x Y; the wrist is where the bar's centre sits in that frame (this.hand.G(r)) away from the bar.
    // The forearm's direction depends on where the wrist is, so hand and arm are solved together (a few rounds).
    // A hand at rest on a surface (restN: its normal) instead lies flat on it: the back of the hand along the normal,
    // the fingers along the forearm's direction in the surface's plane, the palm's centre on the contact point.
    // Holding a bar leaves two things free: how far the hand rolls round the bar (th) and how the elbow swings round
    // the shoulder-wrist line (ph). Each candidate is scored against the arm's neutral, relaxed angles: the upper arm
    // hanging mostly down (a little forward and out), the forearm near its mid twist (thumb up, as in a handshake,
    // pronation and supination each comfortable to about 70 degrees), the wrist near straight (flexion/extension to
    // about 60, sideways deviation to about 20). Cost rises with the square of each departure; out of reach is
    // ruled out. The first solve searches everything; after that (every frame, steering) it refines round the
    // previous answer, so the arm moves smoothly.
    const comfortArm = (k, S, c, X, G, hint) => {
      const L1 = D.upper, L2 = D.fore, sx = k === 'R' ? 1 : -1, relaxed = V(sx * 0.18, -1, -0.32).normalize();
      const Y0 = c.clone().sub(S); Y0.addScaledVector(X, -Y0.dot(X)).normalize(); const Z0 = V().crossVectors(X, Y0);
      const Yt = V(), Zt = V(), Wt = V(), d = V(), E = V(), u = V(), f = V(), pole = V(), u0 = V(), v0 = V(), tr = V(), th2 = V();
      const score = (th, ph, out) => {
        Yt.copy(Y0).multiplyScalar(Math.cos(th)).addScaledVector(Z0, Math.sin(th)); Zt.crossVectors(X, Yt);
        Wt.copy(c).addScaledVector(X, -G.x).addScaledVector(Yt, -G.y).addScaledVector(Zt, -G.z);
        d.copy(Wt).sub(S); const L0 = d.length(), L = clamp(L0, Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.002), miss = Math.abs(L0 - L); d.divideScalar(L0); // (out of reach: the arm reaches as far as it can, at a large cost)
        const x = (L1 * L1 - L2 * L2 + L * L) / (2 * L), y = Math.sqrt(Math.max(0, L1 * L1 - x * x));
        u0.set(0, -1, 0).addScaledVector(d, d.y); if (u0.lengthSq() < 1e-6) u0.set(0, 0, -1).addScaledVector(d, -d.z); u0.normalize(); v0.crossVectors(d, u0);
        pole.copy(u0).multiplyScalar(Math.cos(ph)).addScaledVector(v0, Math.sin(ph));
        E.copy(S).addScaledVector(d, x).addScaledVector(pole, y); u.copy(E).sub(S).divideScalar(L1); f.copy(Wt).sub(E).normalize();
        const sh = Math.acos(clamp(u.dot(relaxed), -1, 1));
        const flex = Math.atan2(f.dot(Zt), f.dot(Yt)), dev = Math.asin(clamp(f.dot(X), -1, 1));
        tr.copy(u).negate().addScaledVector(f, u.dot(f)); th2.copy(X).addScaledVector(f, -X.dot(f)); // (thumb-up reference, the thumb's actual direction, both across the forearm)
        const tw = tr.lengthSq() > 1e-6 && th2.lengthSq() > 1e-6 ? Math.acos(clamp(tr.normalize().dot(th2.normalize()), -1, 1)) : 0;
        const cost = (sh / 0.8) ** 2 + (flex / 1.05) ** 2 + (dev / 0.35) ** 2 + (tw / 1.2) ** 2 + miss * 1e4;
        if (out) { out.W = Wt.clone(); out.Y = Yt.clone(); out.pole = pole.clone(); }
        return cost;
      };
      const prev = (this.armSol ||= {})[k];
      let best = { c: Infinity, th: 0, ph: 0 };
      const grid = (th0, ph0, span, n) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const th = th0 + span * (i / (n - 1) - 0.5) * 2, ph = ph0 + span * (j / (n - 1) - 0.5) * 2, cc = score(th, ph); if (cc < best.c) best = { c: cc, th, ph }; } };
      if (prev) { best = { c: score(prev.th, prev.ph), th: prev.th, ph: prev.ph }; grid(prev.th, prev.ph, 0.25, 9); }
      else grid(0, 0, Math.PI, 49);
      for (const span of [0.12, 0.04, 0.012]) grid(best.th, best.ph, span, 7);
      this.armSol[k] = { th: best.th, ph: best.ph };
      const out = {}; score(best.th, best.ph, out); void hint; return out;
    };
    const arm = (k, S, iu, iff, ih, hint) => {
      const c = hands[k], rest = this.restN?.[k], r = radii[k] ?? 0.03, G = this.hand.G(k, rest ? 0 : r), M = new THREE.Matrix4();
      const X = (axes[k] || V(k === 'R' ? -1 : 1, 0, 0)).clone().normalize().multiplyScalar(this.hand.thumb[k]);
      const Y = c.clone().sub(S); Y.addScaledVector(X, -Y.dot(X)).normalize();
      const Z = V(), W = V();
      if (!rest) { // a hand on a bar: the most comfortable arm that holds it (see comfortArm)
        const sol = comfortArm(k, S, c, X, G, hint);
        Y.copy(sol.Y); Z.crossVectors(X, Y); W.copy(sol.W);
        limb(S, W, D.upper, D.fore, sol.pole, iu, iff, -1);
        p[ih].copy(W); q[ih].setFromRotationMatrix(M.makeBasis(X, Y, Z));
        const Yf = V(0, 1, 0).applyQuaternion(q[iff]), Xf = V(1, 0, 0).applyQuaternion(q[iff]), Xh = X.clone().addScaledVector(Yf, -X.dot(Yf));
        if (Xh.lengthSq() > 1e-6) { const tw = Math.atan2(V().crossVectors(Xf, Xh).dot(Yf), Xf.dot(Xh.normalize())); q[iff].premultiply(new THREE.Quaternion().setFromAxisAngle(Yf, tw / 2)); }
        return;
      }
      const frameUp = () => { if (rest) { Z.copy(rest); Y.addScaledVector(Z, -Y.dot(Z)).normalize(); X.crossVectors(Y, Z).normalize(); } else Z.crossVectors(X, Y); W.copy(c).addScaledVector(X, -G.x).addScaledVector(Y, -G.y).addScaledVector(Z, -G.z); };
      for (let it = 0; it < 4; it++) {
        frameUp();
        limb(S, W, D.upper, D.fore, rest ? hint : gripPole(S, W, D.upper, D.fore, hint, X), iu, iff, -1);
        const f = W.clone().sub(p[iff]).normalize(); if (!rest) f.addScaledVector(X, -f.dot(X)); if (f.lengthSq() > 1e-6) Y.copy(f.normalize());
      }
      frameUp();
      limb(S, W, D.upper, D.fore, rest ? hint : gripPole(S, W, D.upper, D.fore, hint, X), iu, iff, -1);
      p[ih].copy(W); q[ih].setFromRotationMatrix(M.makeBasis(X, Y, Z));
      // the forearm takes half the twist between elbow and hand (the radius rolls over the ulna along its length)
      const Yf = V(0, 1, 0).applyQuaternion(q[iff]), Xf = V(1, 0, 0).applyQuaternion(q[iff]), Xh = X.clone().addScaledVector(Yf, -X.dot(Yf));
      if (Xh.lengthSq() > 1e-6) { const tw = Math.atan2(V().crossVectors(Xf, Xh).dot(Yf), Xf.dot(Xh.normalize())); q[iff].premultiply(new THREE.Quaternion().setFromAxisAngle(Yf, tw / 2)); }
    };
    // feet on the floor (a seat that declares one, with nothing to press): each ankle at its height above the floor,
    // the shin leaning 12 degrees forward of vertical and the thigh reaching it from the hip; the feet a little wider
    // than the hips
    if (this.floorY != null && !bars) for (const [k, hip] of [['R', this.hipR], ['L', this.hipL]]) {
      const ph = this.shinLean, ay = this.floorY + (D.ankleH ?? 0.07), ky = ay + D.shin * Math.cos(ph), dy = hip.y - ky;
      const dz = Math.sqrt(Math.max(0, D.thigh * D.thigh - dy * dy)) * 0.995, kz = hip.z - dz;
      feet[k] = V(hip.x * 1.25, ay, kz - D.shin * Math.sin(ph));
    }
    limb(this.hipR, feet.R, D.thigh, D.shin, kR, B.thighR, B.shinR, 1);
    limb(this.hipL, feet.L, D.thigh, D.shin, V(-kR.x, kR.y, kR.z), B.thighL, B.shinL, 1);
    // hands at rest lie on the thighs' top surface two thirds of the way to the knee, a hand on a gently curved surface
    // (a grip on a broad bar across the thigh, thumbs inboard)
    if (this.restHands) for (const [k, it] of [['R', B.thighR], ['L', B.thighL]]) {
      radii[k] = 0.2; axes[k] = V(k === 'R' ? -1 : 1, 0, 0);
      // a hand at rest lies on a surface: the palm on the thigh's top, two thirds of the way to the knee at most, at
      // the point where the wrist is a relaxed reach from the shoulder (85% of the arm), so the elbow stays bent
      const sh = k === 'R' ? this.shR : this.shL, G0 = this.hand.G(k, 0), n = V(0, 0, -1).applyQuaternion(q[it]), along = V(0, 1, 0).applyQuaternion(q[it]);
      const surf = (t) => V(0, t * D.thigh, -(D.thighTop ?? 0.075)).applyQuaternion(q[it]).add(p[it]), wrist = (t) => surf(t).addScaledVector(along, -G0.y).addScaledVector(n, -G0.z);
      const want = 0.85 * (D.upper + D.fore); let lo = 0.05, hi = 0.7;
      for (let m2 = 0; m2 < 24; m2++) { const m = (lo + hi) / 2; if (wrist(m).distanceTo(sh) < want) lo = m; else hi = m; }
      hands[k] = surf((lo + hi) / 2); (this.restN ||= {})[k] = n; // (radius 0.2: only how the fingers relax over the curve)
    }
    this.grips = { R: { r: radii.R ?? 0.03, c: hands.R, axis: axes.R }, L: { r: radii.L ?? 0.03, c: hands.L, axis: axes.L } };
    arm('R', this.shR, B.uArmR, B.fArmR, B.handR, eR);
    arm('L', this.shL, B.uArmL, B.fArmL, B.handL, V(-eR.x, eR.y, eR.z));
  }
}

// ---------- building a figure (rest pose geometry, bone-local pieces baked through the rest transforms) ----------
function figureGeometry(rig) {
  const o = rig.o, k = new Kit(), D = rig.D, seed = rig.seed;
  const skin = SKIN[seed % SKIN.length], hair = HAIR[(seed * 7 + 1) % HAIR.length];
  const R = (i) => new THREE.Matrix4().compose(rig.p[i], rig.q[i], V(1, 1, 1));
  const route = (hex, gloss) => (typeof gloss === 'string' ? gloss : gloss ? (hex === o.visor ? 'glass' : 'paint') : hex === skin ? 'skin' : hex === hair ? 'hair' : (hex === o.glove || hex === o.boot || hex === 0x1d1d1f || hex === 0x15161a) ? 'rubber' : 'fabric');
  const at = (i, geo, hex, gloss = false) => k.add(geo, hex, i, route(hex, gloss), geo.attributes.skinIndex ? null : R(i)); // (a loft is built in rig space)
  // ---- the body: the skinned human mesh posed onto this rig (body.js), coloured by what the outfit covers ----
  const BP = rig.body ? poseBody({ p: rig.p, q: rig.q, B, DIM: rig.D, grips: rig.grips, spine: rig.spine, body: rig.body }, { seat: rig.ctl === 'bars' ? { y: -0.08, back: null } : rig.seatY != null ? { y: rig.seatY - 0.012, back: null } : { y: -0.09, back: 0.125 } }) : null;
  // a crew neckline round the base of the neck (spine-local, by where each point is, so it's smooth across the mesh's
  // bones): 5.5 cm under the neck joint in front, 3 at the sides, 2 behind. > 0 below it (inside the shirt), metres.
  const neckF = BP ? (() => { const sinv = R(B.spine).invert(), nk = rig.spine ? rig.spine.neck : V(0, D.spine, 0), v = V();
    return (i) => { v.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sinv); const c2 = Math.cos(Math.atan2(v.x - nk.x, -(v.z - nk.z))); return (nk.y - (0.03 + 0.025 * c2 * (c2 > 0 ? 1 : 0.4))) - v.y; }; })() : null;
  // lips: the skin the mouth's ring muscle carries (by the mesh's own weights), shading from the skin to a lip tone
  const SRC = rig.body, lipBone = SRC ? SRC.bones.map((b) => LIP_BONES.test(b.name)) : [], LIP = new THREE.Color(0x9a4f4a);
  const lipW = (i) => { let w = 0; for (let k2 = 0; k2 < 4; k2++) if (lipBone[SRC.bi[i * 4 + k2]]) w += SRC.bw[i * 4 + k2] / 255; return w; };
  if (BP) {
    const n = BP.pos.length / 3, cols = new Float32Array(n * 3), slotOf = new Array(n), c = new THREE.Color();
    const neckSkin = o.head === 'headset' || o.head === 'leather' || o.head === 'cap';
    for (let i = 0; i < n; i++) {
      const sg = BP.seg[i], t = BP.along[i]; let hex = o.suit, sl = 'fabric';
      if (BP.eye[i] === 3) { hex = 0x8a5a52; sl = 'skin'; } else if (BP.eye[i]) { hex = 0xf1ece4; sl = 'paint'; }
      else if (sg === 'head') { hex = skin; sl = 'skin'; const lw = lipW(i); if (lw > 0.35) { c.set(skin).lerp(LIP, Math.min(1, (lw - 0.35) / 0.35) * 0.55); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; slotOf[i] = sl; continue; } }
      else if (sg.startsWith('hand')) { hex = o.glove ?? skin; sl = o.glove ? 'rubber' : 'skin'; }
      else if (sg.startsWith('fArm')) { if (o.tee || o.shirt) { hex = skin; sl = 'skin'; } else if (o.glove && t > 0.82) { hex = o.glove; sl = 'rubber'; } }
      else if (sg.startsWith('uArm')) { if ((o.tee && t > 0.42) || (o.shirt && t > 0.85) || ((o.tee || o.shirt) && neckF(i) < 0)) { hex = skin; sl = 'skin'; } }
      else if (sg === 'hips') hex = o.suit2;
      else if (sg === 'spine') { if (t < 0.12) hex = o.suit2; if ((neckSkin && t > 1.02) || ((o.tee || o.shirt) && neckF(i) < 0)) { hex = skin; sl = 'skin'; } }
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
    return { Q, ix, rimV, ecount }; // (the shell as built: what's attached to it follows its real edge)
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
  if (BP && o.vest) lifeJacket(o.vest);
  // A life jacket made as one: foam panels round the torso on a grid about the spine's axis (angle round it, height up
  // it), so its edges are the curves it's cut to (a V neck, armholes down to the armpits, a scooped back neck) and not
  // the body mesh's triangles. The torso's radius from the axis is measured from the posed body in each (angle, height)
  // cell; the foam sits 4 mm off it (over the T-shirt), 35 mm thick in front, 30 at the back, thin under the arms, its
  // edges rounded, stitched channels down the panels. Padded straps go over the shoulders (on the shoulders' measured
  // tops), two webbing belts round it with buckles across the zip, zip tape down the front edges. All on the spine.
  function lifeJacket(hex) {
    const sinv = R(B.spine).invert(), NA = 48, YB = 0.005, H = 0.016, pts = [], armPts = [];
    { // the torso's surface, densely: each torso triangle's corners, edge midpoints and centre
      const isT = (i) => { const g = seg(i); return g === 'spine' || g === 'hips'; }, P = (i) => V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sinv);
      for (let f = 0; f < BP.index.length; f += 3) { const [a2, b2, c2] = [BP.index[f], BP.index[f + 1], BP.index[f + 2]]; if (!isT(a2) || !isT(b2) || !isT(c2) || BP.eye[a2]) continue;
        const pa = P(a2), pb = P(b2), pc = P(c2); pts.push(pa, pb, pc, pa.clone().lerp(pb, 0.5), pb.clone().lerp(pc, 0.5), pc.clone().lerp(pa, 0.5), pa.clone().add(pb).add(pc).multiplyScalar(1 / 3)); }
      // the skin over the shoulder blades and the top of the chest is the upper arms' (by the mesh's weights): it counts
      // where the front and back panels are, near the shoulders, not where the arms hang beside the body
      for (let i = 0; i < BP.seg.length; i++) if (seg(i).startsWith('uArm') && tt(i) < 0.3) armPts.push(P(i)); }
    const S = rig.spine, shY = S ? (S.sh.R.y + S.sh.L.y) / 2 : D.shoulderUp, yTop = shY + 0.06, NY = Math.ceil((yTop - YB) / H) + 1;
    // the torso's centre line (the spine bone runs down its back): the middle of its cross-section at each height,
    // smoothed; radii and angles are measured about it
    const cx = new Float32Array(NY), cz = new Float32Array(NY);
    for (let yi = 0; yi < NY; yi++) { const y = YB + yi * H; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of pts) if (Math.abs(p.y - y) < 0.025) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      cx[yi] = Number.isFinite(x0) ? (x0 + x1) / 2 : 0; cz[yi] = Number.isFinite(z0) ? (z0 + z1) / 2 : -0.08; }
    for (let it = 0; it < 4; it++) for (let yi = 1; yi < NY - 1; yi++) { cx[yi] = (cx[yi - 1] + 2 * cx[yi] + cx[yi + 1]) / 4; cz[yi] = (cz[yi - 1] + 2 * cz[yi] + cz[yi + 1]) / 4; }
    const nTorso = pts.length; // (the torso's own points: the straps rest on these)
    for (const p of armPts) { const yi = clamp(Math.round((p.y - YB) / H), 0, NY - 1), a = Math.abs(Math.atan2(p.x - cx[yi], -(p.z - cz[yi]))); if (p.y > shY - 0.13 && (a < 1.05 || a > 2.1)) pts.push(p); }
    const cAt = (y) => { const f = clamp((y - YB) / H, 0, NY - 1.001), i0 = Math.floor(f), t = f - i0; return [cx[i0] + (cx[i0 + 1] - cx[i0]) * t, cz[i0] + (cz[i0 + 1] - cz[i0]) * t]; };
    // radius grid: max radius per cell, gaps filled from neighbours, then smoothed
    const rad = new Float32Array(NA * NY).fill(-1), A = (th) => ((Math.round((th / (2 * Math.PI)) * NA) % NA) + NA) % NA;
    for (const p of pts) { const yi = Math.round((p.y - YB) / H); if (yi < 0 || yi >= NY) continue; const dx = p.x - cx[yi], dz = p.z - cz[yi], r = Math.hypot(dx, dz), k2 = A(Math.atan2(dx, -dz)) + yi * NA; if (r > rad[k2]) rad[k2] = r; }
    for (let pass = 0; pass < 40; pass++) { let left = 0; for (let yi = 0; yi < NY; yi++) for (let ai = 0; ai < NA; ai++) { const k2 = ai + yi * NA; if (rad[k2] >= 0) continue; let sm = 0, n = 0;
      for (const [da, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const y2 = yi + dy; if (y2 < 0 || y2 >= NY) continue; const v = rad[((ai + da + NA) % NA) + y2 * NA]; if (v >= 0) { sm += v; n++; } }
      if (n) rad[k2] = sm / n; else left++; } if (!left) break; }
    for (let it = 0; it < 3; it++) { const T = rad.slice(); for (let yi = 0; yi < NY; yi++) for (let ai = 0; ai < NA; ai++) { let m = T[ai + yi * NA]; for (const da of [-1, 1]) m = Math.max(m, T[((ai + da + NA) % NA) + yi * NA]); rad[ai + yi * NA] = 0.5 * T[ai + yi * NA] + 0.5 * m; } } // (a jacket bridges hollows)
    const rAt = (th, y) => { const f = ((th / (2 * Math.PI)) * NA % NA + NA) % NA, a0 = Math.floor(f), a1 = (a0 + 1) % NA, ta = f - a0, fy = clamp((y - YB) / H, 0, NY - 1.001), y0 = Math.floor(fy), ty = fy - y0;
      const g2 = (ai, yi) => rad[ai + yi * NA]; return (g2(a0, y0) * (1 - ta) + g2(a1, y0) * ta) * (1 - ty) + (g2(a0, y0 + 1) * (1 - ta) + g2(a1, y0 + 1) * ta) * ty; };
    // the cut: hem low on the hips, the top edge round the body (|angle| from the front)
    const yB = Math.max(YB + 0.02, shY - 0.36), KP = [[0, shY - 0.2], [0.24, shY - 0.11], [0.55, shY - 0.02], [0.8, shY + 0.02], [1.08, shY - 0.07], [1.57, shY - 0.14], [2.02, shY - 0.06], [2.3, shY + 0.03], [2.7, shY + 0.03], [Math.PI, shY + 0.02]]; // (the back rises to the base of the neck)
    const topAt = (th) => { const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th))); for (let k2 = 1; k2 < KP.length; k2++) if (a <= KP[k2][0]) { const [a0, y0] = KP[k2 - 1], [a1, y1] = KP[k2], t = (a - a0) / (a1 - a0); return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * t)); } return KP[KP.length - 1][1]; };
    const thickAt = (th) => { const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th))); return a < 1.15 ? 0.035 : a > 1.95 ? 0.03 : 0.012 + 0.02 * Math.pow(Math.abs(a - 1.55) / 0.4, 2); };
    const ZG = 0.085, NU = 120, NV = 22, gap = 0.004;
    const surf = (u, v, outer) => { // u: 0..1 round from one side of the zip, through the back, to the other; v: 0..1 hem to top
      const th = ZG + u * (2 * Math.PI - 2 * ZG), y0 = yB, y1 = topAt(th), y = y0 + (y1 - y0) * v, r0 = rAt(th, y) + gap;
      const eu = Math.min(u, 1 - u) * (2 * Math.PI - 2 * ZG) * r0, ev = Math.min(v * (y1 - y0), (1 - v) * (y1 - y0)), e = Math.min(eu, ev), round = Math.sqrt(clamp(e / 0.018, 0, 1));
      const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th))), chan = 1 - 0.18 * Math.exp(-(((a - 0.5) / 0.035) ** 2)) - 0.18 * Math.exp(-(((a - 2.65) / 0.035) ** 2)) - 0.12 * Math.exp(-(((y - (yB + 0.5 * (y1 - yB))) / 0.01) ** 2)) * (a < 1.1 || a > 2.0 ? 1 : 0);
      const r = outer ? r0 + Math.max(0.003, thickAt(th) * round * chan) : r0;
      const [ox, oz] = cAt(y); return V(ox + Math.sin(th) * r, y, oz - Math.cos(th) * r); };
    const pos = [], idx = [], cols = [], cv = new THREE.Color(hex), zt = new THREE.Color(0x1d1e20);
    const grid = (outer) => { const base = pos.length / 3; for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { const p = surf(i / NU, j / NV, outer); pos.push(p.x, p.y, p.z); const c = outer && (i < 2 || i > NU - 2) ? zt : cv; cols.push(c.r, c.g, c.b); } return base; };
    const O = grid(true), I = grid(false), at2 = (b, i, j) => b + j * (NU + 1) + i;
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { idx.push(at2(O, i, j), at2(O, i + 1, j), at2(O, i + 1, j + 1), at2(O, i, j), at2(O, i + 1, j + 1), at2(O, i, j + 1)); idx.push(at2(I, i, j), at2(I, i + 1, j + 1), at2(I, i + 1, j), at2(I, i, j), at2(I, i, j + 1), at2(I, i + 1, j + 1)); }
    for (let i = 0; i < NU; i++) for (const j of [0, NV]) { const f = j ? 1 : -1, a0 = at2(O, i, j), a1 = at2(O, i + 1, j), b0 = at2(I, i, j), b1 = at2(I, i + 1, j); if (f > 0) idx.push(a0, b1, a1, a0, b0, b1); else idx.push(a0, a1, b1, a0, b1, b0); }
    for (let j = 0; j < NV; j++) for (const i of [0, NU]) { const f = i ? 1 : -1, a0 = at2(O, i, j), a1 = at2(O, i, j + 1), b0 = at2(I, i, j), b1 = at2(I, i, j + 1); if (f > 0) idx.push(a0, a1, b1, a0, b1, b0); else idx.push(a0, b1, a1, a0, b0, b1); }
    const jg = new THREE.BufferGeometry(); jg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); jg.setIndex(idx);
    // winding check: the outer surface must face away from the axis
    jg.computeVertexNormals(); { const k0 = at2(O, NU >> 1, NV >> 1), nn = V().fromBufferAttribute(jg.attributes.normal, k0), pp = V().fromBufferAttribute(jg.attributes.position, k0), [ox, oz] = cAt(pp.y); if (nn.x * (pp.x - ox) + nn.z * (pp.z - oz) < 0) { const ia = jg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } jg.computeVertexNormals(); } }
    at(B.spine, jg, hex, 'fabric');
    // webbing belts round the foam, and their buckles across the zip
    for (const yb of [yB + 0.06, yB + 0.16]) {
      const bp = [], bi = [], NB2 = 96, W2 = 0.016;
      for (let k2 = 0; k2 <= NB2; k2++) { const u = k2 / NB2, th = ZG + u * (2 * Math.PI - 2 * ZG); for (const [dy, dr] of [[-W2, 0.0], [W2, 0.0], [W2, 0.003], [-W2, 0.003]]) { const y = yb + dy, rr = rAt(th, y) + gap + thickAt(th) + 0.0015 + dr, [ox, oz] = cAt(y); bp.push(ox + Math.sin(th) * rr, y, oz - Math.cos(th) * rr); } }
      for (let k2 = 0; k2 < NB2; k2++) for (let q2 = 0; q2 < 4; q2++) { const a0 = k2 * 4 + q2, a1 = k2 * 4 + ((q2 + 1) % 4), b0 = a0 + 4, b1 = a1 + 4; bi.push(a0, b0, b1, a0, b1, a1); }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); bg.setIndex(bi); bg.computeVertexNormals(); at(B.spine, bg, 0x15161a, 'rubber');
      const rf = rAt(0, yb) + gap + thickAt(0) + 0.004, [ox, oz] = cAt(yb); at(B.spine, boxG(0.06, 0.036, 0.012, V(ox, yb, oz - rf)), 0x222326, 'rubber'); at(B.spine, boxG(0.02, 0.028, 0.014, V(ox, yb, oz - rf - 0.002)), 0x3a3c40, 'rubber'); // buckle
    }
    // padded straps over the shoulders, sewn onto the panels: each end lies on its panel's outer face, 5 cm down from
    // its top edge, and the strap runs up off it, over the shoulder's measured top and down onto the other panel. Its
    // thickness direction turns from the front panel's surface normal, through straight up, to the back panel's.
    const uOf = (th) => ((th > 0 ? th : 2 * Math.PI + th) - ZG) / (2 * Math.PI - 2 * ZG);
    const onPanel = (th, below) => { const y1 = topAt(th), v = clamp(1 - below / (y1 - yB), 0, 1); return surf(uOf(th), v, true); };
    const nrm = (th, y) => { const [ox, oz] = cAt(y), p = V(ox + Math.sin(th), y, oz - Math.cos(th)); return p.sub(V(ox, y, oz)).normalize(); };
    for (const sx of [-1, 1]) {
      const tf = sx * 0.8, tb = sx * 2.3, F = onPanel(tf, 0.05), Bk = onPanel(tb, 0.05), Ft = onPanel(tf, 0.0), Bt = onPanel(tb, 0.0);
      const topY = (x, z) => { let m = -Infinity; for (let q = 0; q < nTorso; q++) { const p = pts[q]; if (Math.abs(p.x - x) < 0.02 && Math.abs(p.z - z) < 0.02 && p.y < shY + 0.12) m = Math.max(m, p.y); } return Number.isFinite(m) ? m : shY + 0.05; };
      const path = [F, Ft.clone().add(V(0, 0.01, 0))];
      for (const t of [0.25, 0.4, 0.55, 0.7]) { const m = Ft.clone().lerp(Bt, t); m.y = topY(m.x, m.z) + gap; path.push(m); } // (snug: on the body between the panels)
      path.push(Bt.clone().add(V(0, 0.01, 0)), Bk);
      const cur = new THREE.CatmullRomCurve3(path), NS = 32, sp2 = [], si2 = [], WS = 0.032, TS = 0.016, nF = nrm(tf, F.y), nB = nrm(tb, Bk.y), UP = V(0, 1, 0);
      for (let k2 = 0; k2 <= NS; k2++) { const t = k2 / NS, p = cur.getPoint(t), tg = cur.getTangent(t);
        const hint = t < 0.5 ? nF.clone().lerp(UP, Math.min(1, t / 0.35)) : UP.clone().lerp(nB, Math.min(1, (t - 0.65) / 0.35 > 0 ? (t - 0.65) / 0.35 : 0));
        const out = hint.addScaledVector(tg, -hint.dot(tg)).normalize(), wd = V().crossVectors(tg, out).normalize();
        for (const [w, d] of [[-WS, 0], [WS, 0], [WS * 0.85, TS], [-WS * 0.85, TS]]) { const q = p.clone().addScaledVector(wd, w).addScaledVector(out, d - 0.004); sp2.push(q.x, q.y, q.z); } }
      for (let k2 = 0; k2 < NS; k2++) for (let q2 = 0; q2 < 4; q2++) { const a0 = k2 * 4 + q2, a1 = k2 * 4 + ((q2 + 1) % 4), b0 = a0 + 4, b1 = a1 + 4; si2.push(a0, b0, b1, a0, b1, a1); }
      for (const [k2, f] of [[0, 1], [NS, 0]]) { const b = k2 * 4; if (f) si2.push(b, b + 2, b + 1, b, b + 3, b + 2); else si2.push(b, b + 1, b + 2, b, b + 2, b + 3); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp2, 3)); sg.setIndex(si2); sg.computeVertexNormals();
      { const k0 = (NS >> 1) * 4 + 2, nn = V().fromBufferAttribute(sg.attributes.normal, k0); if (nn.y < 0) { const ia = sg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } sg.computeVertexNormals(); } } // (the top of the strap faces up over the shoulder)
      at(B.spine, sg, hex, 'fabric');
    }
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
  if (BP && o.tee) { // the T-shirt: a crew neck cut round the base of the neck (by where each point is, so the line is
    // smooth across the mesh's bones: 5.5 cm under the neck joint in front, 3 at the sides, 2 behind), sleeves to
    // just above the elbow, and a ribbed collar band along the neckline
    const teeF = (i) => { const g = seg(i), nf = neckF(i) * 20; return g === 'spine' || g === 'hips' ? Math.min(nf, 1) : g.startsWith('uArm') ? Math.min(nf, 0.42 - tt(i)) : -1; };
    bodyShell(teeF, 0.005, o.suit, 'fabric');
    bodyShell((i) => { const f = teeF(i); return seg(i).startsWith('uArm') ? -1 : Math.min(f, 0.3 - f); }, 0.0075, o.suit, 'fabric', { hem: 1.2 }); // collar rib (1.5 cm wide)
  }
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
    const hs = o.glove ? 'rubber' : 'skin', hy = 0, hb = f === B.fArmR ? B.handR : B.handL; // (on the hand bone: origin at the wrist)
    at(hb, ellipsoid(V(0, hy + 0.035, 0.002), 0.042, 0.05, 0.026), hand, hs); // palm / back of the hand
    const ctr = V(0, hy + 0.062, -0.016), rad = 0.021;
    [[-0.027, 0.0088, 0.95], [-0.009, 0.0096, 1.05], [0.009, 0.0094, 1.0], [0.026, 0.0082, 0.85]].forEach(([x, r, l]) => {
      const xs = x * sx, pts = []; for (let k2 = 0; k2 <= 6; k2++) { const th = (k2 / 6) * Math.PI * 1.15 * l; pts.push(V(xs, ctr.y + Math.cos(th) * rad, ctr.z + 0.006 - Math.sin(th) * rad)); }
      for (let k2 = 0; k2 < pts.length - 1; k2++) at(hb, capAB(pts[k2], pts[k2 + 1], r * (1 - k2 * 0.04), r * (1 - (k2 + 1) * 0.04), { seg: 12, ring: 3 }), hand, hs);
    });
    at(hb, capAB(V(sx * -0.034, hy + 0.018, -0.012), V(sx * -0.03, hy + 0.05, -0.034), 0.012, 0.011, { seg: 12 }), hand, hs); // thumb
    at(hb, capAB(V(sx * -0.03, hy + 0.05, -0.034), V(sx * -0.008, hy + 0.068, -0.042), 0.011, 0.0095, { seg: 12 }), hand, hs);
    if (o.glove) at(hb, ellipsoid(V(0, hy + 0.06, 0.016), 0.04, 0.012, 0.014), 0x2a2c30, 'rubber'); // knuckle guard
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
    if (BP) { shoe(s, o.boot, o.bigBoots ? 0.26 : o.tee ? 0 : 0.09); continue; }
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
    // brows: a strip of hair on the brow ridge in an arch over each eye (from its measured centre and size), laid on
    // the forehead's measured surface 1 mm out, fullest at the inner end and tapering outward
    const headPts = []; for (let i = 0; i < BP.seg.length; i++) if (BP.seg[i] === 'head' && !BP.eye[i]) headPts.push(P3(i));
    const front = (x, y) => { let zs = 0, ws = 0; for (const p of headPts) { const d2 = (p.x - x) ** 2 + (p.y - y) ** 2; if (d2 < 0.009 ** 2 && p.z < hc.z) { const w = 1 / (d2 + 1e-6); zs += p.z * w; ws += w; } } return ws ? V(x, y, zs / ws) : null; }; // (the surface's depth there, weighted to the nearest points)
    for (const e of eyesAt) {
      const sx = Math.sign(e.c.x - hc.x) || 1, pts2 = [], NB2 = 10;
      for (let k2 = 0; k2 <= NB2; k2++) { const sP = k2 / NB2, x = e.c.x + sx * e.r * (-1.05 + 2.2 * sP), y = e.c.y + e.r * (1.55 + 0.35 * Math.sin(Math.PI * Math.min(1, sP * 1.3)) - 0.25 * sP), f = front(x, y); if (f) pts2.push({ p: f, w: e.r * (0.42 - 0.26 * sP) }); }
      if (pts2.length < 4) continue;
      const bp = [], bi = []; pts2.forEach(({ p, w }, k2) => { const nx = pts2[Math.min(k2 + 1, pts2.length - 1)].p.clone().sub(pts2[Math.max(k2 - 1, 0)].p).normalize(), up2 = V(0, 1, 0).addScaledVector(nx, -nx.y).normalize();
        const out2 = p.clone().sub(hc).normalize(); for (const sgn of [-1, 1]) { const q = p.clone().addScaledVector(up2, sgn * w / 2).addScaledVector(out2, 0.0015); bp.push(q.x, q.y, q.z); } }); // (1.5 mm out along the head's outward direction)
      for (let k2 = 0; k2 < pts2.length - 1; k2++) { const a0 = k2 * 2; bi.push(a0, a0 + 1, a0 + 3, a0, a0 + 3, a0 + 2); }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); bg.setIndex(bi); bg.computeVertexNormals();
      { const nn = V().fromBufferAttribute(bg.attributes.normal, 0); if (nn.z > 0) { const ia = bg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } bg.computeVertexNormals(); } } // (facing forward, -Z)
      at(B.head, bg, hair, 'hair');
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
    const capLine = (u) => (Math.abs(u) < 0.9 ? 0.3 : 0.3 - 0.2 * Math.min(1, (Math.abs(u) - 0.9) / 0.9));
    if (BP) {
      // the crown grows from the scalp above the cap line; the brim grows from the crown's own front edge and the button
      // sits on the crown's top, so both follow whatever head the cap is on
      const hinv2 = R(B.head).invert(), uv = (p) => [Math.atan2(p.x - hc.x, -(p.z - hc.z)), Math.asin(clamp((p.y - hc.y) / HR[1], -1, 1))];
      const crown = bodyShell((i) => { if (seg(i) !== 'head') return -1; const [u, v] = uv(V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv2)); return v - capLine(u); }, 0.022, o.cap, 'fabric', { hem: 1.1 });
      if (crown) {
        const nv = crown.Q.length / 3, P = (v) => V(crown.Q[v * 3], crown.Q[v * 3 + 1], crown.Q[v * 3 + 2]).applyMatrix4(hinv2);
        let top = null; for (let v = 0; v < nv; v++) { const p = P(v); if (!top || p.y > top.y) top = p; }
        at(B.head, ellipsoid(top.clone().add(V(0, 0.002, 0)), 0.01, 0.006, 0.01), o.cap, 'fabric'); // button
        // the crown's open edge (edges used by one triangle), its front arc ordered round the head and resampled
        const UM = 1.15, edge = [], seen = new Set();
        for (const [key, c] of crown.ecount) if (c === 1) for (const v of [Math.floor(key / 1e6), key % 1e6]) { if (seen.has(v)) continue; seen.add(v); const p = P(v), [u] = uv(p); if (Math.abs(u) < UM + 0.15) edge.push({ u, p }); }
        edge.sort((a, b) => a.u - b.u);
        if (edge.length > 8) {
          const NS = 48, at2 = (u) => { let k2 = edge.findIndex((e) => e.u >= u); if (k2 <= 0) k2 = 1; if (k2 < 0 || k2 >= edge.length) k2 = edge.length - 1; const a = edge[k2 - 1], b = edge[k2]; return a.p.clone().lerp(b.p, clamp((u - a.u) / (b.u - a.u || 1), 0, 1)); };
          let rim = Array.from({ length: NS + 1 }, (_, k2) => at2(-UM + (2 * UM * k2) / NS));
          for (let it = 0; it < 4; it++) rim = rim.map((p, k2) => (k2 === 0 || k2 === NS ? p : p.clone().multiplyScalar(0.5).addScaledVector(rim[k2 - 1], 0.25).addScaledVector(rim[k2 + 1], 0.25))); // (the mesh edge is jagged)
          // the brim: from each point of that edge outward and forward, longest at the front and nothing at the ends,
          // tipped down, more so towards the sides (the brim's curve); 6 mm thick
          const LM = 0.075, TH = 0.006, NL = 8, pos = [], idx = [];
          const ptAt = (k2, j2) => { const u = -UM + (2 * UM * k2) / NS, t = u / UM, p = rim[k2], L = LM * Math.pow(Math.max(0, 1 - t * t), 0.55) * (j2 / NL);
            const rad = V(p.x - hc.x, 0, p.z - hc.z).normalize(), d = rad.lerp(V(0, 0, -1), 0.45).normalize(), tip = 0.16 + 0.35 * t * t;
            return p.clone().addScaledVector(d, L * Math.cos(tip)).add(V(0, -L * Math.sin(tip), 0)); };
          const g2 = (k2, j2, side) => { const p = ptAt(k2, j2); p.y += side * TH / 2 * (j2 === 0 ? 0.6 : 1); pos.push(p.x, p.y, p.z); return pos.length / 3 - 1; };
          const grid = [-1, 1].map((sd) => Array.from({ length: NS + 1 }, (_, k2) => Array.from({ length: NL + 1 }, (_, j2) => g2(k2, j2, sd))));
          for (let k2 = 0; k2 < NS; k2++) for (let j2 = 0; j2 < NL; j2++) { const [B0, T0] = grid;
            idx.push(T0[k2][j2], T0[k2 + 1][j2], T0[k2 + 1][j2 + 1], T0[k2][j2], T0[k2 + 1][j2 + 1], T0[k2][j2 + 1]);
            idx.push(B0[k2][j2], B0[k2 + 1][j2 + 1], B0[k2 + 1][j2], B0[k2][j2], B0[k2][j2 + 1], B0[k2 + 1][j2 + 1]); }
          for (let k2 = 0; k2 < NS; k2++) { const [B0, T0] = grid; // the outer edge, closed
            idx.push(T0[k2][NL], T0[k2 + 1][NL], B0[k2 + 1][NL], T0[k2][NL], B0[k2 + 1][NL], B0[k2][NL]); }
          const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setIndex(idx);
          // winding: the top must face up
          bg.computeVertexNormals(); const nTop = V().fromBufferAttribute(bg.attributes.normal, grid[1][NS / 2][NL / 2]); if (nTop.y < 0) { const ia = bg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } bg.computeVertexNormals(); }
          at(B.head, bg, o.cap, 'fabric');
        }
      }
    } else {
      const capR = [HR[0] + 0.024, HR[1] + 0.022, HR[2] + 0.026]; // clear of the hair under it
      at(B.head, dsphere(hc, ...capR, (u, v) => 0.004 * gs(u, v - 0.6, 0.6, 0.4), { w: 64, h: 40, hole: (u, v) => v < capLine(u) }), o.cap, 'fabric');
      at(B.head, ellipsoid(V(hc.x, hc.y + capR[1] + 0.002, hc.z), 0.01, 0.006, 0.01), o.cap, 'fabric'); // button
      const pk = new THREE.Shape(); pk.moveTo(-0.085, 0); pk.quadraticCurveTo(-0.095, 0.07, -0.04, 0.095); pk.quadraticCurveTo(0, 0.102, 0.04, 0.095); pk.quadraticCurveTo(0.095, 0.07, 0.085, 0); pk.quadraticCurveTo(0, 0.02, -0.085, 0); pk.closePath();
      const pg = new THREE.ExtrudeGeometry(pk, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 16 });
      pg.rotateX(-Math.PI / 2);
      { const pp = pg.attributes.position; for (let k2 = 0; k2 < pp.count; k2++) { const x = pp.getX(k2); pp.setY(k2, pp.getY(k2) - 2.2 * x * x); } pg.computeVertexNormals(); }
      pg.rotateX(-0.14); const an = dsPoint(hc, ...capR, null, 0, 0.3, 0).add(V(0, -0.004, 0.012)); pg.translate(an.x, an.y, an.z); at(B.head, pg, o.cap, 'fabric');
    }
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
  // A shoe (or boot, with a shaft up the leg) made for the foot it's on, in the shin bone's frame: the foot is sliced
  // heel to toe and each slice's width and height measured from the body mesh; the upper is lofted round those slices
  // 5 mm off the foot (rounded cross-sections, closed at heel and toe), on a flat sole slab 22 mm thick with the toe
  // sprung up a little. A boot's shaft is lofted round the measured leg.
  function shoe(sb, hex, shaftH) {
    const sinv = R(sb).invert(), sd = sb === B.shinR ? 'shinR' : 'shinL', fp = [], lp = [];
    for (let i = 0; i < BP.seg.length; i++) { if (seg(i) !== sd) continue; const p = V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sinv); if (p.y > D.shin - 0.035) fp.push(p); else if (p.y > D.shin - shaftH - 0.03) lp.push(p); }
    if (fp.length < 20) return;
    let z0 = Infinity, z1 = -Infinity, ys = -Infinity; for (const p of fp) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); ys = Math.max(ys, p.y); }
    const N = 18, OFF = 0.005, slices = [];
    for (let k2 = 0; k2 <= N; k2++) { const z = z1 + (z0 - z1) * (k2 / N), w = Math.max(0.006, (z1 - z0) / N * 0.9) * (k2 === 0 || k2 === N ? 2 : 1); let x0 = Infinity, x1 = -Infinity, yt = Infinity;
      for (const p of fp) if (Math.abs(p.z - z) < w) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); yt = Math.min(yt, p.y); }
      if (Number.isFinite(x0)) slices.push({ z, x0, x1, yt }); }
    if (slices.length > 2) { const h = slices[0], tt2 = slices[slices.length - 1]; slices.unshift({ ...h, z: h.z + 0.01 }); slices.push({ ...tt2, z: tt2.z - 0.012 }); } // (past the heel and the toes, so the closing ends are clear of the foot)
    const raw = slices.map((sl) => ({ ...sl }));
    for (let it = 0; it < 2; it++) for (let k2 = 1; k2 < slices.length - 1; k2++) for (const f of ['x0', 'x1', 'yt']) slices[k2][f] = (slices[k2 - 1][f] + 2 * slices[k2][f] + slices[k2 + 1][f]) / 4;
    slices.forEach((sl, k2) => { sl.x0 = Math.min(sl.x0, raw[k2].x0); sl.x1 = Math.max(sl.x1, raw[k2].x1); sl.yt = Math.min(sl.yt, raw[k2].yt); }); // (smoothed, but never inside the foot)
    const sole = ys + OFF, M = slices.length, RG = 20, up = [], ui = [];
    // upper: each slice an ellipse over the foot's width, from the sole to the slice's top; the ends taper shut
    slices.forEach((sl, k2) => { const t = k2 / (M - 1), end = k2 === 0 || k2 === M - 1 ? 0 : 1, cx = (sl.x0 + sl.x1) / 2, rx = ((sl.x1 - sl.x0) / 2 + OFF) * (0.6 + 0.4 * end);
      const top = sl.yt - OFF - 0.003 * Math.max(0, (t - 0.6) / 0.4), ry = (sole - top) / 2 * (0.6 + 0.4 * end), cy = sole - ry, spring = 0.004 * Math.pow(Math.max(0, t - 0.8) / 0.2, 2);
      // over the heel the upper is cut level at the collar (1.2 cm under the ankle joint), so it meets the leg cleanly;
      // in front of the ankle it closes over the instep and the toes
      const collar = t < 0.3 ? D.shin + 0.012 - Math.max(0, (t - 0.2) / 0.1) * 0.12 : -Infinity; // (the heel cup, rising into the throat)
      for (let r2 = 0; r2 < RG; r2++) { const a = (r2 / RG) * Math.PI * 2, sy = Math.sin(a), yy = sy > 0 ? cy + ry * Math.pow(sy, 0.5) : cy + ry * sy; up.push(cx + Math.cos(a) * rx, Math.max(collar, Math.min(sole, yy)) - spring, sl.z); } });
    for (let k2 = 0; k2 < M - 1; k2++) for (let r2 = 0; r2 < RG; r2++) { const a0 = k2 * RG + r2, a1 = k2 * RG + ((r2 + 1) % RG), b0 = a0 + RG, b1 = a1 + RG; ui.push(a0, b0, b1, a0, b1, a1); }
    const cap = (k2, flip) => { const c = up.length / 3; let x = 0, y = 0, z = 0; for (let r2 = 0; r2 < RG; r2++) { x += up[(k2 * RG + r2) * 3]; y += up[(k2 * RG + r2) * 3 + 1]; z += up[(k2 * RG + r2) * 3 + 2]; } up.push(x / RG, y / RG, z / RG);
      for (let r2 = 0; r2 < RG; r2++) { const a0 = k2 * RG + r2, a1 = k2 * RG + ((r2 + 1) % RG); if (flip) ui.push(c, a1, a0); else ui.push(c, a0, a1); } };
    cap(0, true); cap(M - 1, false);
    const ug = new THREE.BufferGeometry(); ug.setAttribute('position', new THREE.Float32BufferAttribute(up, 3)); ug.setIndex(ui); ug.computeVertexNormals();
    { const k0 = Math.floor(M / 2) * RG + Math.floor(RG / 4), n2 = V().fromBufferAttribute(ug.attributes.normal, k0); if (n2.y < 0) { const ia = ug.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } ug.computeVertexNormals(); } } // (that sample is on the underside: it must face +Y, down, in the shin's frame)
    at(sb, ug, hex, 'rubber'); // (smooth leather)
    // sole: a slab under the upper's outline, its toe sprung like the upper's
    const sp = [], si = [], TH = 0.022;
    slices.forEach((sl, k2) => { const t = k2 / (M - 1), end = k2 === 0 || k2 === M - 1 ? 0 : 1, cx = (sl.x0 + sl.x1) / 2, rx = ((sl.x1 - sl.x0) / 2 + OFF + 0.003) * (0.65 + 0.35 * end), spring = 0.004 * Math.pow(Math.max(0, t - 0.8) / 0.2, 2);
      for (const [x, y] of [[-rx, -0.004], [rx, -0.004], [rx, TH], [-rx, TH]]) sp.push(cx + x, sole + y - spring * (1 - y / TH * 0.3), sl.z); });
    for (let k2 = 0; k2 < M - 1; k2++) for (let q = 0; q < 4; q++) { const a0 = k2 * 4 + q, a1 = k2 * 4 + ((q + 1) % 4), b0 = a0 + 4, b1 = a1 + 4; si.push(a0, b1, b0, a0, a1, b1); }
    for (const [k2, f] of [[0, 1], [M - 1, 0]]) { const b = k2 * 4; if (f) si.push(b, b + 2, b + 1, b, b + 3, b + 2); else si.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setIndex(si); sg.computeVertexNormals();
    at(sb, sg, 0xf2f0ea, 'rubber');
    // boot shaft: the leg's measured section at each height, 6 mm off it, up to shaftH above the ankle
    if (shaftH > 0 && lp.length > 20) {
      const NS2 = 8, rr = [], ri = [], RG2 = 20;
      for (let k2 = 0; k2 <= NS2; k2++) { const y = D.shin - 0.02 - shaftH * (k2 / NS2); let x0 = Infinity, x1 = -Infinity, q0 = Infinity, q1 = -Infinity;
        for (const p of lp) if (Math.abs(p.y - y) < 0.015) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); q0 = Math.min(q0, p.z); q1 = Math.max(q1, p.z); }
        if (!Number.isFinite(x0)) continue; for (let r2 = 0; r2 < RG2; r2++) { const a = (r2 / RG2) * Math.PI * 2; rr.push((x0 + x1) / 2 + Math.cos(a) * ((x1 - x0) / 2 + 0.006), y, (q0 + q1) / 2 + Math.sin(a) * ((q1 - q0) / 2 + 0.006)); } }
      const NR = rr.length / 3 / RG2; for (let k2 = 0; k2 < NR - 1; k2++) for (let r2 = 0; r2 < RG2; r2++) { const a0 = k2 * RG2 + r2, a1 = k2 * RG2 + ((r2 + 1) % RG2), b0 = a0 + RG2, b1 = a1 + RG2; ri.push(a0, a1, b1, a0, b1, b0); }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(rr, 3)); bg.setIndex(ri); bg.computeVertexNormals(); at(sb, bg, hex, 'rubber');
    }
  }
  // A glasses arm from its hinge back along the side of the head, over the top of the ear where it meets the skull,
  // then down behind it. The ear is found on the mesh head: where the side of the head stands out from the temple in
  // front of it by more than 8 mm. The arm hugs the measured surface 3.5 mm out.
  function earArm(hinge, sx, rad) {
    const hinv = R(B.head).invert(), pts = [];
    for (let i = 0; i < BP.seg.length; i++) { if (BP.seg[i] !== 'head' || BP.eye[i]) continue; const p = V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv); if ((p.x - hc.x) * sx > 0.03) pts.push(p); }
    const side = (y, z, w = 0.007) => { let m = null; for (const p of pts) if (Math.abs(p.y - y) < w && Math.abs(p.z - z) < w) { const l = (p.x - hc.x) * sx; if (m === null || l > m) m = l; } return m; };
    const zT = hinge.z + 0.05, ys = [], zs = []; let top = -Infinity, back = -Infinity;
    for (let y = hinge.y - 0.07; y <= hinge.y + 0.015; y += 0.003) ys.push(y); // (the ear's top is about at the brow, the hinge's height: above it the skull widens and is no ear)
    for (let z = hinge.z + 0.06; z <= hinge.z + 0.16; z += 0.004) zs.push(z);
    const ear = [];
    for (const y of ys) { const t = side(y, zT); if (t === null) continue; for (const z of zs) { const l = side(y, z); if (l !== null && l - t > 0.008) { ear.push([y, z]); top = Math.max(top, y); } } }
    for (const [y, z] of ear) if (y > top - 0.012) back = Math.max(back, z); // (the helix's back edge, near its top)
    if (!Number.isFinite(top)) { top = hinge.y; back = hinge.z + 0.11; } // (no ear found: straight back)
    const armY = top - 0.003, path = [hinge.clone()], end = back + 0.006; // (in the crease where the ear's top meets the head)
    const on = (y, z) => { const l = side(y, z, 0.013); return V(hc.x + sx * ((l ?? HR[0]) + 0.0035), y, z); };
    for (let z = hinge.z + 0.012; z <= end; z += 0.01) { const t = clamp((z - hinge.z) / (0.5 * (end - hinge.z)), 0, 1); path.push(on(hinge.y + (armY - hinge.y) * t, z)); }
    for (let d = 0.008; d <= 0.032; d += 0.008) path.push(on(armY - d, end + 0.004 * (d / 0.032))); // down behind the ear
    for (let it = 0; it < 3; it++) for (let k2 = 1; k2 < path.length - 1; k2++) { // (the sampled surface is noisy: smooth the run, keeping it clear of the skin)
      const m = path[k2 - 1].clone().add(path[k2 + 1]).multiplyScalar(0.5), keep = (path[k2].x - hc.x) * sx; path[k2].lerp(m, 0.6); if ((path[k2].x - hc.x) * sx < keep) path[k2].x = hc.x + sx * keep; }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), 48, rad, 8, false);
  }
  function aviators(bold = false) { // two big lenses on the face, a bar across the top and arms back to the ears
    const k = bold ? 1.2 : 1, fr = bold ? 0x15161a : 0xb9a77a;
    if (BP && eyesAt.length === 2) { // on the mesh face: lenses in front of its eyes, a bridge, arms back over the ears
      const fs = bold ? 'rubber' : 'metal';
      for (const e of eyesAt) {
        const lc = e.c.clone().add(V(0, -e.r * 0.15, -e.r * 1.75)), sx = Math.sign(e.c.x - hc.x) || 1;
        const lens = new THREE.SphereGeometry(1, 32, 16); lens.scale(e.r * 1.6 * k, e.r * 1.25 * k, e.r * 0.3); lens.translate(lc.x, lc.y, lc.z); at(B.head, lens, 0x0b0d10, 'glass');
        const rim = new THREE.TorusGeometry(1, 0.07, 8, 40); rim.scale(e.r * 1.65 * k, e.r * 1.3 * k, e.r); rim.translate(lc.x, lc.y, lc.z - e.r * 0.05); at(B.head, rim, fr, fs);
        const hinge = lc.clone().add(V(sx * e.r * 1.6 * k, e.r * 0.3, 0)); at(B.head, earArm(hinge, sx, 0.0022 * k), fr, fs); // arm, over the ear
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
    const rim = torusAB(C.wheelR, 0.017, Math.PI * 2, 72, 16); at(B.ctlA, rim, blk);
    for (const a of [Math.PI / 2, Math.PI * 1.18, Math.PI * 1.82]) at(B.ctlA, capAB(V(0, 0, 0), V(Math.cos(a) * C.wheelR, Math.sin(a) * C.wheelR, 0), 0.012, 0.012, { seg: 6 }), 0x8a8f96, true);
    at(B.ctlA, new THREE.CylinderGeometry(0.045, 0.05, 0.04, 14).rotateX(Math.PI / 2), 0x2b2d31);
    at(B.ctlA, ellipsoid(V(0, C.wheelR, 0.0), 0.02, 0.012, 0.02), 0xe8601c); // top-centre marker
    at(B.ctlA, capAB(V(0, 0, -0.02), V(0, 0, -(0.42 + (rig.col.z - C.col.z) / Math.cos(C.tilt))), 0.025, 0.03, { seg: 8 }), 0x2b2d31); // column, forward and down into the dash (reaching as deep as it did before the wheel came towards the driver)
  }
  // pedals
  if (rig.ctl !== 'bars' && rig.floorY == null) for (const i of [B.pedR, B.pedL]) {
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
export function buildCrew(outfitKey, ctl = 'stick', { seed = 0, colors = null, pegs = null, groundY, seat = null } = {}) {
  const outfit = { ...(OUTFITS[outfitKey] || OUTFITS.light), ...(colors || {}) };
  const rig = new Rig(outfitKey, ctl, outfit, seed, { pegs, groundY, seat });
  const key = outfitKey + '|' + ctl + '|' + (seed % 4) + '|' + JSON.stringify(colors || 0) + (pegs ? '|' + JSON.stringify(pegs.map((v) => v.toArray().map((x) => +x.toFixed(3)))) : '') + (seat ? '|' + JSON.stringify(seat) : '');
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
// seatGeo's surfaces (partDetail.js: pan top 0.02 + 0.126 x width; the back's front face 2 cm behind the origin, raked
// back by tilt, up to backH along the rake) in a figure's rig space (seat point p, figure scale s)
function seatSurfaces(fit, p, s) {
  const [w, backH, , tilt] = fit.dims, [ax, ay, az] = fit.at;
  return { panTop: (ay + 0.02 + 0.126 * w - p[1]) / s, backZ: (az + 0.02 - p[2]) / s, tilt, backTop: (ay + backH * Math.cos(tilt) - p[1]) / s, floor: fit.floor != null ? (fit.floor - p[1]) / s : null };
}
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
      // a seat built with seatGeo declares it (fit: { at: where its geometry was placed, dims: seatGeo's arguments }), so
      // the figure can sit on its actual surfaces
      const seat = st.fit && ctl !== 'bars' ? seatSurfaces(st.fit, st.p, st.s || 1) : null;
      const c = buildCrew(outfit, ctl, { seed: i * 3 + k, colors, pegs, groundY, seat });
      Object.assign(c.userData.crewRig, { role: st.role || 'pilot', kind, ctl, part: i, seat: k }); // (stations.js names the cockpit views from these)
      c.position.set(...st.p); if (st.quat) c.quaternion.fromArray(st.quat); else if (st.yaw) c.rotation.y = st.yaw;
      if (fit) c.scale.copy(fit); else c.scale.setScalar(st.s || 1);
      obj.add(c); list.push(c.userData.crewRig);
    });
    obj.userData.crew = list; rigs.push(...list);
  });
  return rigs;
}
