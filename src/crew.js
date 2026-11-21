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
import { bodyReady, body, person, poseBody, handModel, torsoPoints, bodyDims, spinePose, armRest } from './body.js';
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
  wheel: { col: V(0, 0.28, -0.52), tilt: 0.42, wheelR: 0.19, spokes: [Math.PI / 2, Math.PI * 1.18, Math.PI * 1.82] }, // (spoke angles from 3 o'clock, anticlockwise)
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

const POSTURES = new Map(); // (solved postures: person, seat and controls -> v)
class Rig {
  constructor(kind, ctl, outfit, seed, opts = {}) {
    this.kind = kind; this.ctl = ctl; this.o = outfit; this.seed = seed;
    this.pegs = opts.pegs || [V(-0.24, -0.62, 0.0), V(0.24, -0.62, 0.0)]; this.groundY = opts.groundY ?? -1.1;
    // a vehicle may declare its own control placement (opts.helm: seatControls(), e.g. a wheel's centre and tilt, a
    // stick's base); otherwise the generic set for these controls
    const C = opts.helm ? { ...(CTL[ctl] || CTL.none), ...Object.fromEntries(Object.entries(opts.helm).map(([k, v]) => [k, v?.isVector3 ? v.clone() : v])) } : CTL[ctl] || CTL.none; this.body = outfit.head !== 'bubble' && body() ? person(PEOPLE[seed % PEOPLE.length]) : null;
    const HM = this.body ? handModel(this.body) : null; this.armRest = this.body ? armRest(this.body) : null;
    // proportions: the body mesh's own (measured from its joints, so its limbs aren't stretched), else the procedural set
    const D = this.D = HM ? { ...DIM, ...bodyDims(this.body) } : DIM;
    this.C = C;
    // the hand's grip geometry: the body mesh's measured hand, or the procedural fist (bar 6.2 cm past the wrist, 1.6 cm
    // under the bone line, thumb on the inboard side)
    this.hand = HM ? { G: (k, r) => HM[k].G(r), thumb: { R: HM.R.thumb, L: HM.L.thumb } } : { G: () => V(0, 0.062, -0.016), thumb: { R: -1, L: 1 } };
    this.opts = opts; this.col = C.col ? C.col.clone() : null;
    this.state = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
    this.q = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.p = Array.from({ length: NB }, () => V());
    // posture: solved once for this person in this seat at these controls (cached), then only the arms follow the
    // controls each frame
    this.configure(HM && opts.seat ? this.solvePosture() : this.defaultPosture());
    this.pose(this.state);
  }
  defaultPosture() {
    const reach = this.ctl === 'wheel' || this.ctl === 'stick' || this.ctl === 'cyclic' || this.ctl === 'yoke';
    return { lean: 0.3, flex: this.ctl === 'bars' ? 0.15 : 0.5, prot: this.ctl === 'bars' ? 0.15 : reach ? 0.22 : 0.08, slide: 0, shin: 0.21, splay: 0, colZ: 0, colY: 0 };
  }
  // Set the rig up for a posture v: { lean (the pelvis rolled back), flex (the back's forward bend over four
  // vertebrae), prot (the shoulders forward), slide (the body forward on the cushion, off the seat back), shin (the
  // shins' forward lean, feet on the floor), splay (knees and feet apart), colZ / colY (a wheel's helm adjusted towards
  // the driver / up) }. The seat fit, shoulders, hips and the torso obstacle all follow from it.
  configure(v) {
    const D = this.D, o = this.o, ctl = this.ctl, HM = !!this.body, st = this.opts.seat, C = this.C;
    this.v = v;
    this.spine = HM ? spinePose(D, v.flex, v.prot, this.body) : null;
    const spineQ = this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), HM && ctl !== 'bars' ? v.lean : D.lean);
    this.base = V();
    // the torso as an obstacle for the arms: its cross-section at each height up the spine (an ellipse round the
    // middle of the measured, posed torso), padded by what's worn over it
    const T2 = HM ? torsoPoints(D, this.spine, this.body) : null;
    if (T2) { const wear = o.vest ? 0.04 : o.tee || o.shirt ? 0.006 : 0.012, ell = [];
      for (let y = 0.05; y <= D.spine + 0.02; y += 0.025) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const p of T2.spine) if (Math.abs(p.y - y) < 0.02) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
        if (Number.isFinite(x0)) ell.push({ y, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2 + wear, rz: (z1 - z0) / 2 + wear }); }
      this.torsoEll = ell; }
    // sitting in the seat: the body's lowest point (plus clothing) on the cushion, sunk a little, and its back (plus
    // what's worn on it) against the seat back, then slid forward by v.slide
    if (T2 && st) {
      const sM = new THREE.Matrix4().compose(V(0, 0.03, 0), spineQ, V(1, 1, 1)), pts = [...T2.hips, ...T2.spine.map((p) => p.clone().applyMatrix4(sM))];
      const seatT = o.shorts ? 0.008 : 0.012, backT = o.vest ? 0.034 : o.tee || o.shirt ? 0.006 : 0.012;
      let minY = Infinity; for (const p of pts) minY = Math.min(minY, p.y - seatT);
      const dy = st.panTop - 0.012 - minY, tk = Math.tan(st.tilt); let dz = Infinity;
      for (const p of pts) { const y = p.y + dy; if (y < st.panTop + 0.06 || y > st.backTop) continue; dz = Math.min(dz, st.backZ + tk * (y - st.panTop) + 0.008 - (p.z + backT)); }
      this.base.set(0, dy, (Number.isFinite(dz) ? dz : 0) - v.slide);
      this.seatY = st.panTop; this.floorY = st.floor != null && st.feet !== 'pedals' ? st.floor : null;
    }
    this.spinePos = V(0, 0.03, 0).add(this.base);
    const sp = (x, y, z) => V(x, y, z).applyQuaternion(spineQ).add(this.spinePos);
    this.joints(sp);
    this.hipR = V(D.hipW, 0, 0).add(this.base); this.hipL = V(-D.hipW, 0, 0).add(this.base);
    this.shinLean = v.shin; this.splay = v.splay;
    if (this.col) this.col.set(C.col.x, C.col.y + (v.colY || 0), C.col.z + (v.colZ || 0));
  }
  // How good a posture is, once posed: the arms' comfort (the comfort solve's own cost), the hips' and knees' angles
  // against a relaxed seated person's (hip about 95 degrees between thigh and back, knee about 105), the back near its
  // relaxed bend, the loss of the seat back's support when slid forward, a helm moved from where the vehicle put it,
  // and obstacles: a wheel's rim must clear the thighs and the chest.
  postureCost() {
    this.pose(this.state);
    const D = this.D, p = this.p, q = this.q, v = this.v; let c = 0;
    const parts = this.costParts = {}; for (const k of ['R', 'L']) c += this.armAngles?.[k]?.cost ?? 0; parts.arms = c;
    const up = V(0, 1, 0).applyQuaternion(q[B.spine]);
    for (const [th, sh] of [[B.thighR, B.shinR], [B.thighL, B.shinL]]) {
      const td = V(0, 1, 0).applyQuaternion(q[th]), sd = V(0, 1, 0).applyQuaternion(q[sh]);
      const hip = Math.acos(clamp(up.dot(td), -1, 1)), knee = Math.PI - Math.acos(clamp(td.dot(sd), -1, 1));
      c += ((hip - 1.66) / 0.45) ** 2 + ((knee - 1.85) / 0.5) ** 2;
    }
    parts.legs = c - parts.arms;
    const st = this.opts.seat, leanTo = st ? clamp(st.tilt + 0.05, 0.15, 0.5) : 0.25; // (lying back into a raked seat is relaxed)
    const c0 = c; c += ((v.lean - leanTo) / 0.15) ** 2 + ((v.flex - 0.4) / 0.3) ** 2 + (v.prot / 0.3) ** 2 + (v.slide / 0.06) ** 2 + (v.splay / 0.1) ** 2; parts.posture = c - c0; // (knees wide apart is no way to sit)
    if (this.ctl === 'wheel') {
      c += ((v.colZ || 0) / 0.08) ** 2 + ((v.colY || 0) / 0.08) ** 2; // (a tilt helm adjusts: some cost)
      const rimR = 0.017, spInv = q[B.spine].clone().invert(), ELL = this.torsoEll, P = V();
      let hit = 0;
      for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2; P.set(Math.cos(a) * this.C.wheelR, Math.sin(a) * this.C.wheelR, 0).applyQuaternion(q[B.ctlA]).add(p[B.ctlA]);
        for (const [th, sh] of [[B.thighR, B.shinR], [B.thighL, B.shinL]]) { // the thigh as a capsule, hip to knee
          const a0 = p[th], ab = p[sh].clone().sub(a0), t = clamp(P.clone().sub(a0).dot(ab) / ab.lengthSq(), 0, 1), dd = P.distanceTo(a0.clone().addScaledVector(ab, t));
          hit = Math.max(hit, (D.thighTop ?? 0.075) + rimR + 0.02 - dd); }
        if (ELL) { const L = P.clone().sub(p[B.spine]).applyQuaternion(spInv), fy = (L.y - ELL[0].y) / 0.025, i0 = Math.floor(fy);
          if (i0 >= 0 && i0 < ELL.length - 1) { const e = ELL[i0], e1 = ELL[i0 + 1], w = fy - i0, rx = e.rx + (e1.rx - e.rx) * w + rimR + 0.03, rz = e.rz + (e1.rz - e.rz) * w + rimR + 0.03;
            const qd = Math.hypot((L.x - (e.cx + (e1.cx - e.cx) * w)) / rx, (L.z - (e.cz + (e1.cz - e.cz) * w)) / rz); if (qd < 1) hit = Math.max(hit, (1 - qd) * Math.min(rx, rz)); } } }
      parts.helm = ((v.colZ || 0) / 0.08) ** 2 + ((v.colY || 0) / 0.08) ** 2; parts.hit = hit > 0 ? (hit / 0.01) ** 2 * 4 : 0; c += parts.hit;
    }
    return c;
  }
  // The posture for this person in this seat at these controls: coordinate descent over v from a relaxed start,
  // each variable stepped both ways while it helps, the steps halving each pass. Cached per person, seat and controls.
  solvePosture() {
    const key = [this.kind, this.ctl, this.seed % PEOPLE.length, JSON.stringify(this.opts.seat), JSON.stringify(this.opts.helm || null)].join('|');
    if (POSTURES.has(key)) { const r = POSTURES.get(key); this.gripA = r.gripA && { ...r.gripA }; return { ...r.v }; }
    const VARS = [['lean', 0.05, 0.5, 0.08], ['flex', 0, 0.9, 0.12], ['prot', 0, 0.35, 0.06], ['slide', 0, 0.14, 0.03], ['shin', 0.05, 1.1, 0.12], ['splay', 0, 0.35, 0.08]];
    if (this.ctl === 'wheel') VARS.push(['colZ', -0.05, 0.05, 0.025], ['colY', -0.05, 0.05, 0.025]); // (a tilt helm's few centimetres; where the helm is, is the vehicle's)
    this.solving = true;
    const cost = (vv) => { this.configure(vv); return this.postureCost(); };
    const descend = (v, best) => {
      for (let pass = 0; pass < 4; pass++) for (const [k, lo, hi, step0] of VARS) {
        const step = step0 / 2 ** pass;
        for (const dir of [1, -1]) for (let n = 0; n < 4; n++) {
          const t = { ...v, [k]: clamp(v[k] + dir * step, lo, hi) }; if (t[k] === v[k]) break;
          const c = cost(t); if (c < best - 1e-4) { best = c; v = t; } else break;
        }
      }
      return { v, c: best };
    };
    // several starts (for a wheel, a coarse grid of helm positions; the descent alone gets stuck, e.g. knees spread
    // round a low wheel when raising it would be better), the best two descended, the better kept
    const v0 = this.defaultPosture(), starts = [];
    if (this.ctl === 'wheel') for (const colZ of [-0.05, 0, 0.05]) for (const colY of [-0.05, 0, 0.05]) { const t = { ...v0, colZ, colY }; delete this.armSol; starts.push({ v: t, c: cost(t), gripA: this.gripA && { ...this.gripA } }); } // (the rim grip is searched fully once, then refined locally)
    else { delete this.armSol; starts.push({ v: v0, c: cost(v0) }); }
    starts.sort((a, b) => a.c - b.c);
    let win = null;
    for (const st0 of starts.slice(0, 2)) { this.gripA = st0.gripA && { ...st0.gripA }; delete this.armSol; cost(st0.v); const r = descend(st0.v, cost(st0.v)); r.gripA = this.gripA && { ...this.gripA }; if (!win || r.c < win.c) win = r; }
    let v = win.v, best = win.c; this.gripA = win.gripA; delete this.armSol;
    this.solving = false; this.postureScore = best;
    POSTURES.set(key, { v: { ...v }, gripA: this.gripA && { ...this.gripA } });
    return v;
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
      // a hand at angle a round the rim from 12 o'clock (the right hand at -a): its centre and the rim's tangent, the
      // thumb towards 12 o'clock. Where on the rim each hand holds is chosen once, for comfort (pose), then kept, so
      // the hands turn with the wheel
      this.rimAt = (k, a0) => { const a = k === 'R' ? -a0 : a0; return { c: V(Math.sin(-a) * C.wheelR, Math.cos(a) * C.wheelR, 0).applyQuaternion(q[B.ctlA]).add(this.col), axis: V(Math.cos(a), Math.sin(a), 0).multiplyScalar(Math.sign(a)).applyQuaternion(q[B.ctlA]) }; };
      for (const k of ['R', 'L']) { const g = this.rimAt(k, this.gripA?.[k] ?? 1.15); hands[k] = g.c; axes[k] = g.axis; radii[k] = 0.017; }
    } else if (this.ctl === 'bars') { // on the grips (rig space, from the fork), else resting on the tank
      hands.L = s.hands?.[0] || V(-0.2, 0.05, -0.42); hands.R = s.hands?.[1] || V(0.2, 0.05, -0.42); axes.L = V(1, 0, 0); axes.R = V(-1, 0, 0); radii.L = radii.R = 0.016; // (thumbs inboard)
      feet.L = this.pegs[0].clone().lerp(V(this.pegs[0].x - 0.1, this.groundY + 0.06, this.pegs[0].z - 0.12), s.foot || 0); // a foot down when stopped
      feet.R = this.pegs[1].clone();
      return { hands, feet, axes, radii };
    } else {
      this.restHands = true; // resting on the thighs: placed on them once the legs are posed (pose)
    }
    // pedals: rudder pedals swing fore and aft; a car has a throttle pedal under the right foot
    const pz = C.pedZ ?? -0.86, py = C.pedY ?? -0.34; // (pedals: the vehicle may say where)
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
    // the shoulder-wrist line (ph). Each candidate is built exactly as the rig will build it (the upper arm and forearm
    // frames from the bend plane, as limb() does) and scored by the twists the body really goes through, measured
    // against its own rest pose (armRest): the humerus turning about its axis in the shoulder, and the forearm turning
    // between elbow and hand (comfortable to about +-60 and +-70 degrees; beyond about 90 and 100 they're ruled out).
    // Also the upper arm's direction (hanging a little forward and out is best) and the wrist's bend (flexion and
    // extension to about 60, sideways to about 20, ruled out past 80 and 35). The first solve searches everything; then
    // each frame refines round the previous answer, so steering moves the arm smoothly.
    const comfortArm = (k, S, c, X, G, hint) => {
      const L1 = D.upper, L2 = D.fore, sx = k === 'R' ? 1 : -1, relaxed = V(sx * 0.18, -1, -0.32).normalize();
      const Y0 = c.clone().sub(S); Y0.addScaledVector(X, -Y0.dot(X)).normalize(); const Z0 = V().crossVectors(X, Y0);
      const Yt = V(), Zt = V(), Wt = V(), d = V(), E = V(), u = V(), f = V(), pole = V(), u0 = V(), v0 = V(), th2 = V(), Nn = V(), M4 = new THREE.Matrix4();
      const AR = this.armRest?.[k], spInv = q[B.spine].clone().invert(), wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const ELL = this.torsoEll, spP = p[B.spine], ap = V();
      // [from (0 shoulder / 1 elbow), to (1 elbow / 2 wrist), how far, the arm's radius there]
      const SAMPLES = [[0, 1, 0.45, 0.05], [0, 1, 0.7, 0.048], [0, 1, 1.0, 0.045], [1, 2, 0.25, 0.042], [1, 2, 0.5, 0.038], [1, 2, 0.75, 0.033]];
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
        // the bones' frames as limb() makes them: N the bend plane's normal (side -1 for arms), z = N x y, x = y x z
        Nn.crossVectors(pole, d).multiplyScalar(-1).normalize();
        const uz = V().crossVectors(Nn, u).normalize(), ux = V().crossVectors(u, uz), fz = V().crossVectors(Nn, f).normalize(), fx = V().crossVectors(f, fz);
        // forearm twist: the hand's X about the forearm's axis, against the rest pose's
        th2.copy(X).addScaledVector(f, -X.dot(f)).normalize(); const tau = wrapA(Math.atan2(V().crossVectors(fx, th2).dot(f), fx.dot(th2)) - (AR ? AR.twist0 : 0));
        // humeral rotation: the upper arm's frame in the spine's, against the rest pose's; its twist about the arm
        let hum = 0; if (AR) { const qU = new THREE.Quaternion().setFromRotationMatrix(M4.makeBasis(ux, u, uz)), rel = AR.uInSpine.clone().invert().multiply(spInv.clone().multiply(qU)); hum = wrapA(2 * Math.atan2(rel.y, rel.w)); }
        // the arm stays outside the torso: points along the upper arm and forearm (each padded by the arm's radius)
        // against the torso's cross-sections; the cost grows with how deep any goes in
        let inside = 0;
        if (ELL) for (const [a0, a1, t, rad] of SAMPLES) {
          ap.copy(a0 === 0 ? S : E).lerp(a1 === 1 ? E : Wt, t).sub(spP).applyQuaternion(spInv);
          const fy = (ap.y - ELL[0].y) / 0.025, i0 = Math.floor(fy); if (i0 < 0 || i0 >= ELL.length - 1) continue;
          const e = ELL[i0], e1 = ELL[i0 + 1], w2 = fy - i0, cx = e.cx + (e1.cx - e.cx) * w2, cz = e.cz + (e1.cz - e.cz) * w2, rx = e.rx + (e1.rx - e.rx) * w2 + rad, rz = e.rz + (e1.rz - e.rz) * w2 + rad;
          const q2 = Math.hypot((ap.x - cx) / rx, (ap.z - cz) / rz); if (q2 < 1) inside = Math.max(inside, (1 - q2) * Math.min(rx, rz)); }
        let cost = (sh / 0.8) ** 2 + (flex / 1.05) ** 2 + (dev / 0.35) ** 2 + (tau / 1.2) ** 2 + (hum / 1.0) ** 2 + miss * 1e4 + (inside / 0.01) ** 2 * 4;
        if (Math.abs(tau) > 1.75 || Math.abs(hum) > 1.6 || Math.abs(flex) > 1.4 || Math.abs(dev) > 0.6) cost += 1e3; // (past the joints' range)
        if (out) { out.W = Wt.clone(); out.Y = Yt.clone(); out.pole = pole.clone(); out.angles = { sh, hum, tau, flex, dev, cost, inside }; }

        return cost;
      };
      const prev = (this.armSol ||= {})[k];
      let best = { c: Infinity, th: 0, ph: 0 };
      const grid = (th0, ph0, span, n) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const th = th0 + span * (i / (n - 1) - 0.5) * 2, ph = ph0 + span * (j / (n - 1) - 0.5) * 2, cc = score(th, ph); if (cc < best.c) best = { c: cc, th, ph }; } };
      const prevC = prev ? score(prev.th, prev.ph) : Infinity;
      if (prev && prevC < 500) { best = { c: prevC, th: prev.th, ph: prev.ph }; grid(prev.th, prev.ph, 0.25, 9); } // (an answer from out of reach or past a joint's range is no place to refine from: search afresh)
      else grid(0, 0, Math.PI, 49);
      for (const span of [0.12, 0.04, 0.012]) grid(best.th, best.ph, span, 7);
      this.armSol[k] = { th: best.th, ph: best.ph };
      const out = {}; score(best.th, best.ph, out); (this.armAngles ||= {})[k] = { ...Object.fromEntries(Object.entries(out.angles).map(([kk, v]) => [kk, +(kk === 'cost' || kk === 'inside' ? v : v * 180 / Math.PI).toFixed(3)])), at: this.gripA?.[k] != null ? +(this.gripA[k] * 180 / Math.PI).toFixed(0) : null }; void hint; return out;
    };
    const arm = (k, S, iu, iff, ih, hint) => {
      const c = hands[k], rest = this.restN?.[k], r = radii[k] ?? 0.03, G = this.hand.G(k, rest ? 0 : r), M = new THREE.Matrix4();
      const X = (axes[k] || V(k === 'R' ? -1 : 1, 0, 0)).clone().normalize().multiplyScalar(this.hand.thumb[k]);
      const Y = c.clone().sub(S); Y.addScaledVector(X, -Y.dot(X)).normalize();
      const Z = V(), W = V();
      if (!rest) { // a hand on a bar: the most comfortable arm that holds it (see comfortArm)
        if (this.rimAt && this.gripA?.[k] == null) { // first solve on a wheel: also choose where round the rim to hold (1 to 4 o'clock)
          let bestA = null;
          // not where a spoke meets the rim: a hand (about 9 cm across) plus the spoke takes about 0.32 rad of a 19 cm rim
          const clear = (a0) => { const at3 = k === 'R' ? Math.PI / 2 - a0 : Math.PI / 2 + a0; return this.C.spokes.every((sp) => Math.abs(Math.atan2(Math.sin(at3 - sp), Math.cos(at3 - sp))) > 0.32); };
          for (let a0 = 0.55; a0 <= 2.1; a0 += 0.075) { if (!clear(a0)) continue; const g = this.rimAt(k, a0), Xa = g.axis.clone().normalize().multiplyScalar(this.hand.thumb[k]);
            delete this.armSol?.[k]; const o2 = comfortArm(k, S, g.c, Xa, G, hint), cc = o2.angles.cost; if (!bestA || cc < bestA.c) bestA = { c: cc, a0, sol: { ...this.armSol[k] } }; }
          (this.gripA ||= {})[k] = bestA.a0; this.armSol[k] = bestA.sol;
          const g = this.rimAt(k, bestA.a0); c.copy(g.c); hands[k] = g.c; axes[k] = g.axis; X.copy(g.axis).normalize().multiplyScalar(this.hand.thumb[k]);
          this.grips[k] = { r, c: g.c, axis: g.axis };
        }
        if (this.rimAt && this.solving && this.gripA?.[k] != null) { // while the posture is being solved, the grip may move round the rim too
          const clear = (a0) => { const at3 = k === 'R' ? Math.PI / 2 - a0 : Math.PI / 2 + a0; return this.C.spokes.every((sp) => Math.abs(Math.atan2(Math.sin(at3 - sp), Math.cos(at3 - sp))) > 0.32); };
          let bestA = null; const a00 = this.gripA[k], keep = this.armSol?.[k] && { ...this.armSol[k] };
          for (const a0 of [a00 - 0.1, a00, a00 + 0.1]) { if (a0 < 0.55 || a0 > 2.1 || !clear(a0)) continue; if (keep) this.armSol[k] = { ...keep };
            const g = this.rimAt(k, a0), Xa = g.axis.clone().normalize().multiplyScalar(this.hand.thumb[k]), cc = comfortArm(k, S, g.c, Xa, G, hint).angles.cost; if (!bestA || cc < bestA.c) bestA = { c: cc, a0, sol: { ...this.armSol[k] } }; }
          if (bestA) { this.gripA[k] = bestA.a0; this.armSol[k] = bestA.sol; const g = this.rimAt(k, bestA.a0); c.copy(g.c); hands[k] = g.c; axes[k] = g.axis; X.copy(g.axis).normalize().multiplyScalar(this.hand.thumb[k]); this.grips[k] = { r, c: g.c, axis: g.axis }; }
        }
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
      feet[k] = V(hip.x * (1.25 + (this.splay || 0) * 1.5), ay, kz - D.shin * Math.sin(ph));
    }
    const kS = kR.clone(); kS.x += this.splay || 0; // (knees apart)
    limb(this.hipR, feet.R, D.thigh, D.shin, kS, B.thighR, B.shinR, 1);
    limb(this.hipL, feet.L, D.thigh, D.shin, V(-kS.x, kS.y, kS.z), B.thighL, B.shinL, 1);
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
  const BP = rig.body ? poseBody({ p: rig.p, q: rig.q, B, DIM: rig.D, grips: rig.grips, spine: rig.spine, body: rig.body, footFlat: rig.floorY != null }, { seat: rig.ctl === 'bars' ? { y: -0.08, back: null } : rig.seatY != null ? { y: rig.seatY - 0.012, back: null } : { y: -0.09, back: 0.125 } }) : null;
  const GF = BP ? garmentFields() : null; // (what's worn where on the body: garmentFields below)
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
      // under the clothes the body takes the colour of the outermost garment covering it (so where a shell lies close
      // to the skin nothing else shows through); elsewhere skin (a glove's cuff on the wrist, a hood round the neck)
      else if (GF.tint[i] >= 0) { const g = GF.list[GF.tint[i]]; hex = g.hex; sl = g.slot; }
      else if (sg.startsWith('fArm') && o.glove && t > 0.76) { hex = o.glove; sl = 'rubber'; } // (from under the cuff)
      else if (sg === 'spine' && !neckSkin) hex = o.suit;
      else { hex = skin; sl = 'skin'; }
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
  // A foot's frame: its points in the body's rest pose (standing, the sole on the ground at y = 0) and the rigid turn
  // and shift that best take them to where the posed foot is (from the heel's, the toes' and the two sides' middles,
  // matched between the two), so shoes can be shaped standing and then put on the foot as it's posed.
  function footFrame(sd) {
    const _feet = footFrame.c || (footFrame.c = {}); if (sd in _feet) return _feet[sd]; // (per figure: this function is)
    const S = rig.body, k = 1.07, ank = S.bones[S.byName['foot.' + sd]].h.clone().multiplyScalar(k), ids = [], src = [], pos = [];
    for (let i = 0; i < BP.seg.length; i++) if (BP.seg[i] === 'shin' + sd && S.pos[i * 3 + 1] * k < ank.y + 0.02) { ids.push(i); src.push(V(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(k)); pos.push(V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2])); }
    if (ids.length < 30) return (_feet[sd] = null);
    const mid = (sel) => { const a = V(), b = V(); let m = 0; src.forEach((p, j) => { if (sel(p)) { a.add(p); b.add(pos[j]); m++; } }); return m ? [a.divideScalar(m), b.divideScalar(m)] : null; };
    let z0 = Infinity, z1 = -Infinity, x0 = Infinity, x1 = -Infinity; for (const p of src) { if (p.y > ank.y - 0.02) continue; z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
    const low = (p) => p.y < ank.y - 0.02, heel = mid((p) => low(p) && p.z > z1 - 0.04), toe = mid((p) => low(p) && p.z < z0 + 0.05), lf = mid((p) => low(p) && p.x < x0 + 0.02), rt = mid((p) => low(p) && p.x > x1 - 0.02), all = mid(() => true);
    if (!heel || !toe || !lf || !rt) return (_feet[sd] = null);
    const fr = (h, t, l, r) => { const zz = h.clone().sub(t).normalize(), xx = r.clone().sub(l); xx.addScaledVector(zz, -xx.dot(zz)).normalize(); return new THREE.Matrix4().makeBasis(xx, zz.clone().cross(xx), zz); };
    const rot = new THREE.Quaternion().setFromRotationMatrix(fr(heel[1], toe[1], lf[1], rt[1]).multiply(fr(heel[0], toe[0], lf[0], rt[0]).transpose()));
    const M = new THREE.Matrix4().compose(all[1].clone().sub(all[0].clone().applyQuaternion(rot)), rot, V(1, 1, 1)); // (source -> rig space)
    return (_feet[sd] = { ids, src, ank, rot, M, floor: Math.min(...src.map((p) => p.y)) });
  }
  // The surface clothes are made on: the body relaxed (its small hollows eased: the spine's groove, between the toes),
  // each point moved only outward along its normal and at most 6 mm, and its normals. Every garment shell is this
  // surface pushed out by its thickness, so a garment worn over another always stands clear of it.
  let _cloth = null;
  function clothBase() {
    if (_cloth) return _cloth;
    const n = BP.pos.length / 3, nb = Array.from({ length: n }, () => new Set()), ix = BP.index, Q = Float32Array.from(BP.pos);
    for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { nb[ix[f + e]].add(ix[f + (e + 1) % 3]); nb[ix[f + (e + 1) % 3]].add(ix[f + e]); }
    const P0 = BP.pos;
    for (let it = 0; it < 8; it++) { const T = Q.slice(); for (let v = 0; v < n; v++) { if (!nb[v].size) continue; let x = 0, y = 0, z = 0; for (const u of nb[v]) { x += T[u * 3]; y += T[u * 3 + 1]; z += T[u * 3 + 2]; } const m = nb[v].size; Q[v * 3] = T[v * 3] * 0.4 + x / m * 0.6; Q[v * 3 + 1] = T[v * 3 + 1] * 0.4 + y / m * 0.6; Q[v * 3 + 2] = T[v * 3 + 2] * 0.4 + z / m * 0.6; }
      for (let v = 0; v < n; v++) { const d = (Q[v * 3] - P0[v * 3]) * BP.nrm[v * 3] + (Q[v * 3 + 1] - P0[v * 3 + 1]) * BP.nrm[v * 3 + 1] + (Q[v * 3 + 2] - P0[v * 3 + 2]) * BP.nrm[v * 3 + 2]; for (let c = 0; c < 3; c++) Q[v * 3 + c] = P0[v * 3 + c] + BP.nrm[v * 3 + c] * clamp(d, 0, 0.006); } } // (along the normal only, a point drifting over the surface would move the cut lines; and at most 6 mm: cloth bridges a hollow, it doesn't fill it)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Q, 3)); g.setIndex(new THREE.BufferAttribute(new Uint32Array(ix), 1)); g.computeVertexNormals();
    return (_cloth = { pos: Q, nrm: g.attributes.normal.array });
  }
  // Clothing grown from the body: the triangles of a region, pushed out along the body's normals by the garment's
  // thickness (a thicker roll at its open edges: the hem). It keeps the body's skin weights, so it moves with it.
  // field(i) >= 0 inside the garment; triangles crossing its edge are clipped along the zero line, so hems are clean
  // curves however the body is meshed. smooth > 0 relaxes the shell (foam, padding: no body detail through it); base:
  // made on the clothes' surface (clothBase) instead of the skin.
  const bodyShell = (field, off, hex, slot, { hem = 1.6, smooth = 0, base = false, skinHem = false } = {}) => {
    if (!BP) return;
    const BPOS = base ? clothBase().pos : BP.pos, BNRM = base ? clothBase().nrm : BP.nrm; // (garments: all on one relaxed surface, so the layers can't cross)
    // field: one function of the vertex (or an array of them: the garment is where they're all >= 0, each clipped in
    // turn, so a band between two lines or a neckline meeting a hem keeps both edges exact)
    const n = BP.pos.length / 3, FL = (Array.isArray(field) ? field : [field]).map((f) => { const F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = BP.eye[i] ? -1 : f(i); return F; }), NF = FL.length;
    const P = [], N = [], P0 = [], N0 = [], SI = [], SW = [], rimV = [], ix = [], ids = new Map(), col3 = new THREE.Color(hex);
    const emit = (r) => { if (ids.has(r.k)) return ids.get(r.k); P.push(r.p.x, r.p.y, r.p.z); N.push(r.n.x, r.n.y, r.n.z); P0.push(r.p0.x, r.p0.y, r.p0.z); N0.push(r.n0.x, r.n0.y, r.n0.z); for (let q = 0; q < 4; q++) { SI.push(BP.skinIndex[r.src * 4 + q]); SW.push(BP.skinWeight[r.src * 4 + q]); } rimV.push(r.rim ? 1 : 0); const id = P.length / 3 - 1; ids.set(r.k, id); return id; };
    const vrec = new Map(), rec = (i) => { if (!vrec.has(i)) vrec.set(i, { k: 'v' + i, p: V(BPOS[i * 3], BPOS[i * 3 + 1], BPOS[i * 3 + 2]), n: V(BNRM[i * 3], BNRM[i * 3 + 1], BNRM[i * 3 + 2]), p0: V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]), n0: V(BP.nrm[i * 3], BP.nrm[i * 3 + 1], BP.nrm[i * 3 + 2]), src: i, f: FL.map((F) => F[i]), rim: false }); return vrec.get(i); };
    const crec = new Map(), cut = (a2, b2, j) => { const [u, w] = a2.k < b2.k ? [a2, b2] : [b2, a2], key = j + ':' + u.k + '|' + w.k; if (crec.has(key)) return crec.get(key);
      const t2 = u.f[j] / (u.f[j] - w.f[j]), nl = u.n.clone().lerp(w.n, t2), r = { k: key, p: u.p.clone().lerp(w.p, t2), n: nl.length() > 0.6 ? nl.normalize() : (u.f[j] >= 0 ? u.n : w.n).clone(), // (across a crease: the inside point's normal)
        p0: u.p0.clone().lerp(w.p0, t2), n0: (() => { const m = u.n0.clone().lerp(w.n0, t2); return m.length() > 0.6 ? m.normalize() : (u.f[j] >= 0 ? u.n0 : w.n0).clone(); })(), src: u.f[j] >= 0 ? u.src : w.src, f: u.f.map((x, q) => x + (w.f[q] - x) * t2), rim: true };
      r.f[j] = 0; crec.set(key, r); return r; };
    for (let f = 0; f < BP.index.length; f += 3) {
      let poly = [rec(BP.index[f]), rec(BP.index[f + 1]), rec(BP.index[f + 2])];
      for (let j = 0; j < NF && poly.length; j++) { if (poly.every((r) => r.f[j] >= 0)) continue; const out = [];
        for (let e = 0; e < poly.length; e++) { const a2 = poly[e], b2 = poly[(e + 1) % poly.length]; if (a2.f[j] >= 0) out.push(a2); if ((a2.f[j] >= 0) !== (b2.f[j] >= 0)) out.push(cut(a2, b2, j)); }
        poly = out.length >= 3 ? out : []; }
      if (poly.length < 3) continue; const pi = poly.map(emit);
      for (let q = 1; q < pi.length - 1; q++) ix.push(pi[0], pi[q], pi[q + 1]);
    }
    if (!ix.length) return;
    // open edges (cut or the mesh's own) roll into a hem
    const ecount = new Map(); for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { const a2 = ix[f + e], b2 = ix[f + (e + 1) % 3], key = a2 < b2 ? a2 * 1e6 + b2 : b2 * 1e6 + a2; ecount.set(key, (ecount.get(key) || 0) + 1); }
    for (const [key, c] of ecount) if (c === 1) { rimV[Math.floor(key / 1e6)] = 1; rimV[key % 1e6] = 1; }
    const nv = P.length / 3, Q = new Float32Array(nv * 3);
    { // (the hem's direction out, eased along the hem: one odd normal at a crease would throw a spike out of the edge)
      const rn = new Map(); for (const [key, c] of ecount) if (c === 1) { const a2 = Math.floor(key / 1e6), b2 = key % 1e6; (rn.get(a2) || rn.set(a2, []).get(a2)).push(b2); (rn.get(b2) || rn.set(b2, []).get(b2)).push(a2); }
      for (let it = 0; it < 4; it++) { const T = N.slice(); for (const [v, nbs] of rn) { let x = T[v * 3] * 2, y = T[v * 3 + 1] * 2, z = T[v * 3 + 2] * 2; for (const u of nbs) { x += T[u * 3]; y += T[u * 3 + 1]; z += T[u * 3 + 2]; } const l = Math.hypot(x, y, z) || 1; N[v * 3] = x / l; N[v * 3 + 1] = y / l; N[v * 3 + 2] = z / l; } } }
    // (skinHem: the hem follows the skin itself, not the relaxed base's bridge over a hollow, so a collar round an ankle
    // never stands off in the air; along the relaxed surface's normal, as the skin's own can be wild at a crease)
    for (let v = 0; v < nv; v++) { const d = (typeof off === 'function' ? off(v) : off) * (rimV[v] ? hem : 1), [PP, NN] = skinHem && rimV[v] ? [P0, N] : [P, N]; for (let c = 0; c < 3; c++) Q[v * 3 + c] = PP[v * 3 + c] + NN[v * 3 + c] * d; }
    if (smooth) { const nb = Array.from({ length: nv }, () => new Set()); for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { nb[ix[f + e]].add(ix[f + (e + 1) % 3]); nb[ix[f + (e + 1) % 3]].add(ix[f + e]); }
      for (let it = 0; it < smooth; it++) { const T = Q.slice(); for (let v = 0; v < nv; v++) { if (rimV[v] || !nb[v].size) continue; let x = 0, y = 0, z = 0; for (const u of nb[v]) { x += T[u * 3]; y += T[u * 3 + 1]; z += T[u * 3 + 2]; } const m = nb[v].size; Q[v * 3] = T[v * 3] * 0.4 + x / m * 0.6; Q[v * 3 + 1] = T[v * 3 + 1] * 0.4 + y / m * 0.6; Q[v * 3 + 2] = T[v * 3 + 2] * 0.4 + z / m * 0.6; } }
      // (relaxing shrinks a shell over the convex parts, shoulders, toes: never closer to the body than 0.6 of its thickness)
      for (let v = 0; v < nv; v++) { if (rimV[v]) continue; const d0 = (typeof off === 'function' ? off(v) : off) * 0.6, d = (Q[v * 3] - P[v * 3]) * N[v * 3] + (Q[v * 3 + 1] - P[v * 3 + 1]) * N[v * 3 + 1] + (Q[v * 3 + 2] - P[v * 3 + 2]) * N[v * 3 + 2];
        if (d < d0) for (let c = 0; c < 3; c++) Q[v * 3 + c] += N[v * 3 + c] * (d0 - d); } }
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
  if (BP && o.harness) harness();
  else if (o.harness) { // shoulder straps, lap belt and the buckle
    // shoulder straps: over the shoulder from behind, then down the chest's surface to the buckle
    for (const sx of [-1, 1]) {
      const path = [V(sx * 0.1, D.shoulderUp - 0.02, 0.1), V(sx * 0.1, D.shoulderUp + 0.035, 0.0), front(sx * 0.1, 0.41, 0.012), front(sx * 0.09, 0.32, 0.012), front(sx * 0.075, 0.22, 0.012), front(sx * 0.05, 0.14, 0.012)];
      for (let i = 0; i < path.length - 1; i++) at(B.spine, capAB(path[i], path[i + 1], 0.02, 0.02, { sz: 0.45, seg: 6, ring: 1, hint: V(sx, 0, 0) }), o.trim);
    }
    at(B.hips, capAB(V(-0.125, 0.07, -0.108), V(0.125, 0.07, -0.108), 0.019, 0.019, { seg: 6, sz: 0.6 }), o.trim); // lap belt
    const bk = front(0, 0.14, 0.022); at(B.spine, boxG(0.07, 0.07, 0.025, bk), 0x9aa0a6, true);
  }
  // What's worn where on the body, as fields over its vertices (> 0 inside the garment, metres), each measured where
  // the point is on the body standing in its rest pose (the source mesh): so every cut line (waist, cuffs, sleeve hems,
  // necklines, stripes, a shoe's collar) is a clean curve across the mesh's bones and triangles, whatever the posture.
  // Listed inside out; each becomes a shell (bodyShell) over the one before, and the body under them takes the colour
  // of the outermost garment covering it.
  function garmentFields() {
    const S = rig.body, k = 1.07, J = (nm) => S.bones[S.byName[nm]].h.clone().multiplyScalar(k), n = BP.pos.length / 3;
    const X = (i) => S.pos[i * 3] * k, Y = (i) => S.pos[i * 3 + 1] * k, Z = (i) => S.pos[i * 3 + 2] * k;
    const sg = BP.seg, tA = BP.along, torso = (i) => sg[i] === 'spine' || sg[i] === 'hips', is = (i, s) => sg[i].startsWith(s);
    const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), nk = J('neck01'), Ls = nk.y - hipC.y;
    // the torso's side: just inside the upper arms where they hang beside the chest (bands round the body stop there)
    let xArm = Infinity; const shY = J('upperarm01.R').y;
    for (let i = 0; i < n; i++) if (is(i, 'uArm') && Y(i) < shY - 0.1) xArm = Math.min(xArm, Math.abs(X(i)));
    const xSide = Number.isFinite(xArm) ? xArm - 0.004 : 0.15, an = { R: J('foot.R'), L: J('foot.L') }, ank = (i) => an[sg[i].slice(-1)];
    // round the ankle, by where a point is now: up the shin (the shin bone's frame: 0 at the knee, D.shin at the ankle)
    // and, for a shoe's collar, in the foot's frame (footFrame: the foot standing, as rigid), so a collar is a level
    // cut round the ankle whatever the skin round a bent ankle does
    const lS = new Float32Array(n), lF = new Float32Array(n * 2), sInv = { R: R(B.shinR).invert(), L: R(B.shinL).invert() }, fInv = {}, q = V();
    for (const sd of ['R', 'L']) { const ff = footFrame(sd); fInv[sd] = ff ? ff.M.clone().invert() : null; }
    for (let i = 0; i < n; i++) if (is(i, 'shin')) { const sd = sg[i].slice(-1); q.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]); lS[i] = q.clone().applyMatrix4(sInv[sd]).y;
      if (fInv[sd]) { q.applyMatrix4(fInv[sd]); lF[i * 2] = q.y; lF[i * 2 + 1] = q.z; } else { lF[i * 2] = Y(i); lF[i * 2 + 1] = Z(i); } }
    const shaftH = o.bigBoots ? 0.26 : o.tee ? 0 : 0.09, yHem = hipC.y + 0.05, yBand = hipC.y + 0.1; // (the top's hem; the trousers' waistband)
    // Necklines, rising away from the neck so they never reach out onto the shoulders: a suit's collar round the base
    // of the neck, level; a crew neck 5.5 cm under the neck joint in front, 3 at the sides, 2 behind. (Every field is
    // by position wherever the body parts it spans meet: a value that jumped at a part's boundary would leave a sliver
    // of garment along it when two fields are clipped in turn.)
    const rise = (i) => (sg[i] === 'head' ? 0 : 0.8 * Math.max(0, Math.hypot(X(i) - nk.x, Z(i) - nk.z) - 0.075)); // (not under the chin: the head's parts meet the body's only round the neck)
    const suitNeck = (i) => nk.y + 0.015 + rise(i) - Y(i);
    const crewNeck = (i) => { const dx = X(i) - nk.x, dz = Z(i) - nk.z, c2 = Math.cos(Math.atan2(dx, -dz));
      return nk.y - (0.03 + 0.025 * c2 * (c2 > 0 ? 1 : 0.4)) + rise(i) - Y(i); };
    // (a garment: one or more fields, inside where all are >= 0)
    const list = [], add = (name, fs, hex, slot, off, opt = {}) => { const F = (Array.isArray(fs) ? fs : [fs]).map((f) => { const A = new Float32Array(n); for (let i = 0; i < n; i++) A[i] = BP.eye[i] ? -1 : f(i); return A; }); list.push({ name, F, hex, slot, off, hem: 1.4, ...opt }); return F; };
    if (o.tee) { // T-shirt (sleeves to just above the elbow, tucked into the shorts) with a ribbed collar, and shorts to above the knee
      add('tee', [(i) => torso(i) ? Y(i) - (hipC.y - 0.02) : is(i, 'uArm') ? (0.42 - tA[i]) * D.upper : -1, crewNeck], o.suit, 'fabric', 0.005, { hem: 1.6 });
      add('collar', [(i) => torso(i) ? crewNeck(i) : -1, (i) => 0.015 - crewNeck(i)], o.suit, 'fabric', 0.0075, { hem: 1.2 }); // (1.5 cm wide)
      if (o.shorts) add('shorts', (i) => torso(i) ? yBand + 0.02 - Y(i) : is(i, 'thigh') ? (0.6 - tA[i]) * D.thigh : -1, o.suit2, 'fabric', 0.009, { hem: 1.5 });
    } else {
      // trousers up to the waistband and tucked 3 cm into the boots; the suit (or shirt) over them from the neck to its
      // hem below the waistband, to the cuffs (a gloved hand's cuff goes into the glove), a shirt's sleeves short
      add('trousers', (i) => torso(i) ? yBand - Y(i) : is(i, 'thigh') ? 1 : is(i, 'shin') ? D.shin - Math.max(0.03, shaftH - 0.03) - lS[i] : -1, o.suit2, 'fabric', 0.006, { hem: 1.3 }); // (its hems roll under whatever's over them)
      const topF = [(i) => torso(i) || sg[i] === 'head' ? Y(i) - yHem : is(i, 'uArm') ? (o.shirt ? (0.55 - tA[i]) * D.upper : 1) : is(i, 'fArm') && !o.shirt ? ((o.glove ? 0.86 : 0.97) - tA[i]) * D.fore : -1, suitNeck];
      add('top', topF, o.suit, 'fabric', 0.0085);
      // stripes: bands round the chest, ending at its sides under the arms
      if (o.stripes) for (const s of [0.42, 0.64]) { const yc = hipC.y + 0.03 + s * (Ls - 0.03);
        add('stripe', [...topF, (i) => (torso(i) || is(i, 'uArm')) ? Y(i) - (yc - 0.0125) : -1, (i) => yc + 0.0125 - Y(i), (i) => xSide - Math.abs(X(i))], o.trim, 'fabric', 0.01, { hem: 1 }); }
      // a fighter pilot's survival vest: chest and back from the waist to under the collar (a V in front), open at the arms
      if (o.mask === true) add('vest', [(i) => (torso(i) || is(i, 'uArm')) ? Y(i) - (hipC.y + 0.09) : -1, (i) => xSide - 0.012 - Math.abs(X(i)),
        (i) => nk.y - 0.05 - 0.13 * clamp(1 - Math.abs(X(i) - nk.x) / 0.08, 0, 1) * sstep(nk.z - 0.02, nk.z - 0.07, Z(i)) - Y(i)], o.suit2, 'fabric', 0.016, { hem: 1.25 });
    }
    // a warbird pilot's silk scarf: a soft roll round the base of the neck
    if (o.head === 'leather') add('scarf', [(i) => torso(i) || sg[i] === 'head' || is(i, 'uArm') ? Y(i) - (nk.y - 0.02) : -1, (i) => nk.y + 0.04 - Y(i), (i) => 0.085 - Math.hypot(X(i) - nk.x, Z(i) - nk.z)], 0xf2f2ee, 'fabric', 0.012, { hem: 1.2 });
    // shoes / boots: the foot up to a collar round the ankle (just under the ankle bone, a little lower at the heel and
    // higher over the instep) or to the boot's top
    add('shoe', (i) => !is(i, 'shin') ? -1 : shaftH ? lS[i] - (D.shin - shaftH) : ank(i).y - 0.012 - 0.05 * (lF[i * 2 + 1] - ank(i).z) - lF[i * 2], o.boot, 'rubber', shaftH ? 0.013 : 0.006, shaftH ? { hem: 0.3 } : { hem: 0.4, skinHem: true }); // (thin edges: a low shoe's collar hugs the ankle, a boot's top slips under the trousers)
    // the body's tint: the outermost garment covering a point and all its neighbours (so no triangle the hem crosses
    // takes the garment's colour out past it)
    const tint = new Int16Array(n).fill(-1), ix = BP.index;
    list.forEach((g, gi) => { const G = g.F[0].map((x, i) => Math.min(...g.F.map((F) => F[i]))), m = G.slice(); for (let f = 0; f < ix.length; f += 3) { const mn = Math.min(G[ix[f]], G[ix[f + 1]], G[ix[f + 2]]); for (let e = 0; e < 3; e++) if (mn < m[ix[f + e]]) m[ix[f + e]] = mn; }
      for (let i = 0; i < n; i++) if (m[i] >= 0) tint[i] = gi; });
    return { list, tint, shaftH, shoe: list.at(-1) };
  }
  // A ribbon lying on a surface (straps, belts, a tie): points along it, the surface's outward normal at each, its
  // width at each (metres) and thickness; a closed flat section, its inner face on the points.
  function ribbon(pts, nrm, wid, th) {
    const pos = [], idx = [], N = pts.length;
    for (let k2 = 0; k2 < N; k2++) { const tg = pts[Math.min(N - 1, k2 + 1)].clone().sub(pts[Math.max(0, k2 - 1)]).normalize(), out = nrm[k2].clone().addScaledVector(tg, -nrm[k2].dot(tg)).normalize(), w = V().crossVectors(tg, out).normalize(), hw = (typeof wid === 'function' ? wid(k2 / (N - 1)) : wid) / 2;
      for (const [a, d] of [[-hw, 0], [hw, 0], [hw * 0.94, th], [-hw * 0.94, th]]) { const q = pts[k2].clone().addScaledVector(w, a).addScaledVector(out, d); pos.push(q.x, q.y, q.z); } }
    for (let k2 = 0; k2 < N - 1; k2++) for (let q = 0; q < 4; q++) { const a0 = k2 * 4 + q, a1 = k2 * 4 + ((q + 1) % 4), b0 = a0 + 4, b1 = a1 + 4; idx.push(a0, a1, b1, a0, b1, b0); }
    for (const [k2, f] of [[0, 1], [N - 1, 0]]) { const b = k2 * 4; if (f) idx.push(b, b + 1, b + 2, b, b + 2, b + 3); else idx.push(b, b + 2, b + 1, b, b + 3, b + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    { const k0 = (N >> 1) * 4 + 2, nn = V().fromBufferAttribute(g.attributes.normal, k0), o2 = nrm[N >> 1]; if (nn.dot(o2) < 0) { const ia = g.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } g.computeVertexNormals(); } } // (the outer face faces out)
    return g;
  }

  // The body's surface in the spine's frame, for what's laid on it (harness straps, a tie, epaulettes): the posed
  // mesh's torso (and the tops of the upper arms: the shoulders' skin is theirs), and onto(P, d): the outermost point
  // of it along the ray from P in direction d (within r of the ray), plus `off` along d. Whatever's laid there clears
  // the clothes under it by standing off the outermost shell's thickness.
  function torsoSurface(more = () => false) {
    const sinv = R(B.spine).invert(), pts = [];
    const use = (i) => { const g = seg(i); return !BP.eye[i] && (g === 'spine' || g === 'hips' || (g.startsWith('uArm') && tt(i) < 0.25) || more(g, tt(i))); }, at3 = (i) => V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sinv);
    for (let f = 0; f < BP.index.length; f += 3) { const [a, b, c] = [BP.index[f], BP.index[f + 1], BP.index[f + 2]]; if (!use(a) || !use(b) || !use(c)) continue; // (each triangle's corners, edge middles and centre: dense enough that no ray slips between)
      const pa = at3(a), pb = at3(b), pc = at3(c); pts.push(pa, pb, pc, pa.clone().lerp(pb, 0.5), pb.clone().lerp(pc, 0.5), pc.clone().lerp(pa, 0.5), pa.clone().add(pb).add(pc).multiplyScalar(1 / 3)); }
    const wear = Math.max(...GF.list.filter((g) => g.slot === 'fabric').map((g) => g.off), 0) + 0.006 + 0.002, q = V(); // (the thickest shell, on the clothes' surface up to 6 mm out)
    const onto = (P, d, off = wear, r = 0.014) => { let best = 0; for (const p of pts) { q.copy(p).sub(P); const t = q.dot(d); if (t > best && q.addScaledVector(d, -t).lengthSq() < r * r) best = t; }
      return best > 0 ? P.clone().addScaledVector(d, best + off) : null; }; // (only ahead of P, which is inside the body)
    const cz = (y) => { let s2 = 0, m = 0; for (const p of pts) if (Math.abs(p.y - y) < 0.02 && Math.abs(p.x) < 0.1) { s2 += p.z; m++; } return m ? s2 / m : 0; }; // (the torso's middle, front to back)
    return { pts, onto, cz, wear };
  }
  // a run of surface points (each [point, outward direction]) relaxed into a smooth line, then kept on the surface
  function lay(S, run, it = 4) {
    let P = run.map((r) => r[0]); const Dn = run.map((r) => r[1]);
    for (let k2 = 0; k2 < it; k2++) { P = P.map((p, j) => (j === 0 || j === P.length - 1 ? p : p.clone().multiplyScalar(0.5).addScaledVector(P[j - 1], 0.25).addScaledVector(P[j + 1], 0.25)));
      P = P.map((p, j) => { const s2 = S.onto(p.clone().addScaledVector(Dn[j], -0.15), Dn[j]); return s2 && s2.clone().sub(p).dot(Dn[j]) > 0 ? s2 : p; }); }
    return { P, N: Dn };
  }

  // A racing harness on the body: two shoulder straps from behind the seat back, up the back, over the shoulders
  // (round each shoulder's measured top) and down the chest to the buckle; a lap belt round the front of the pelvis
  // from beside the hips; the round quick-release buckle where they meet. All lie on the clothes' surface.
  function harness() {
    const S = torsoSurface((g, t) => g.startsWith('thigh') && t < 0.12), sp = rig.spine, shY = sp ? (sp.sh.R.y + sp.sh.L.y) / 2 : D.shoulderUp;
    const yL = 0.06, yBk = yL + 0.03, F = V(0, 0, -1), Bk = V(0, 0, 1), W2 = 0.045, T2 = 0.003, M2 = R(B.hips).invert().multiply(R(B.spine));
    for (const sx of [-1, 1]) {
      const xs = sx * 0.095, run = [], push = (p, d) => { const s2 = S.onto(p, d); if (s2) run.push([s2, d]); };
      for (let y = yBk + 0.03; y <= shY - 0.08; y += 0.012) { const t = (y - yBk - 0.03) / (shY - 0.08 - yBk - 0.03); push(V(sx * 0.03 + (xs - sx * 0.03) * Math.min(1, t * 1.6), y, S.cz(y)), F); }
      const C = V(xs, shY - 0.1, S.cz(shY - 0.1));
      for (let k2 = 1; k2 < 16; k2++) { const ph = (k2 / 16) * Math.PI; push(C, V(0, Math.sin(ph), -Math.cos(ph))); } // (over the shoulder)
      for (let y = shY - 0.08; y >= shY - 0.3; y -= 0.012) push(V(xs, y, S.cz(y)), Bk);
      if (run.length < 4) continue; const { P, N } = lay(S, run); at(B.spine, ribbon(P, N, W2, T2), o.trim);
    }
    { // lap belt: low round the belly, just above the thighs, from beside one hip to the other (rays out from the
      // torso's axis), then the buckle
      const run = [], c = V(0, yL, S.cz(yL) + 0.02);
      for (let a = -1.4; a <= 1.4001; a += 0.05) { const d = V(Math.sin(a), 0, -Math.cos(a)), s2 = S.onto(c, d); if (s2) run.push([s2, d]); }
      if (run.length >= 4) { const { P, N } = lay(S, run, 3); at(B.hips, ribbon(P.map((p) => p.clone().applyMatrix4(M2)), N.map((d) => d.clone().transformDirection(M2)), W2 * 1.1, T2), o.trim); }
    }
    const bk = S.onto(V(0, yBk - 0.01, S.cz(yBk)), F, S.wear + T2 + 0.003);
    if (bk) { const disc = new THREE.CylinderGeometry(0.036, 0.04, 0.012, 32).rotateX(Math.PI / 2); disc.translate(bk.x, bk.y, bk.z - 0.004); at(B.spine, disc, 0x9aa0a6, 'metal');
      const knob = new THREE.CylinderGeometry(0.014, 0.016, 0.008, 6).rotateX(Math.PI / 2); knob.translate(bk.x, bk.y, bk.z - 0.013); at(B.spine, knob, 0x2a2c30, 'metal'); }
  }
  // An airline captain's tie down the shirt front from the collar, and epaulettes on the shoulders' measured tops
  function tieAndEpaulettes() {
    const S = torsoSurface(), sp = rig.spine, F = V(0, 0, -1), Up = V(0, 1, 0), y0 = 0.94 * D.spine, y1 = 0.36 * D.spine, run = [];
    for (let y = y0; y >= y1; y -= 0.012) { const s2 = S.onto(V(0, y, S.cz(y)), F); if (s2) run.push([s2, F]); }
    if (run.length > 4) { const { P, N } = lay(S, run, 3); at(B.spine, ribbon(P, N, (t) => (t < 0.08 ? 0.03 : 0.034 + 0.042 * Math.min(1, (t - 0.08) / 0.85)) * (t > 0.95 ? Math.max(0.25, 1 - (t - 0.95) / 0.05 * 0.75) : 1), 0.005), o.trim); }
    // epaulettes: stiff boards from near the collar out to the shoulder's point, resting on the shoulder's measured top
    // (lifted till the whole length clears it)
    for (const sx of [-1, 1]) { const sh = sp ? sp.sh[sx > 0 ? 'R' : 'L'] : V(sx * 0.19, D.shoulderUp, 0.02), top = [];
      for (let t = 0; t <= 1.0001; t += 0.125) { const s2 = S.onto(V(sh.x * (0.45 + 0.5 * t), sh.y - 0.1, sh.z), Up); if (s2) top.push([t, s2]); }
      if (top.length < 4) continue; const a0 = top[0][1], a1 = top.at(-1)[1]; let lift = 0;
      for (const [t, p] of top) lift = Math.max(lift, p.y - (a0.y + (a1.y - a0.y) * t));
      const P = [], N = [], dir = a1.clone().sub(a0).normalize(), nUp = Up.clone().addScaledVector(dir, -dir.y).normalize();
      for (let k2 = 0; k2 <= 8; k2++) { P.push(a0.clone().lerp(a1, k2 / 8).add(V(0, lift, 0))); N.push(nUp); }
      at(B.spine, ribbon(P, N, 0.048, 0.006), 0x15161a, 'fabric');
      at(B.spine, ribbon(P.map((p) => p.clone().addScaledVector(nUp, 0.006)), N, 0.04, 0.0015), o.epaulettes, true); }
  }
  if (o.hump) { // leathers' aero hump: on the measured back between the shoulder blades (sunk 2 cm into the suit there)
    let c = V(0, D.shoulderUp - 0.06, 0.12);
    if (BP) { const S = torsoSurface(), sp = rig.spine, y = (sp ? (sp.sh.R.y + sp.sh.L.y) / 2 : D.shoulderUp) - 0.1, b = S.onto(V(0, y, S.cz(y)), V(0, 0, 1), S.wear + 0.04); if (b) c = b; }
    at(B.spine, ellipsoid(c, 0.09, 0.12, 0.06, { w: 24 }), o.suit, true); }
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
  if (!BP && o.mask === true) at(B.spine, shell(0.14, 0.39, 1.07, o.suit2), o.suit2); // survival vest (on the body mesh: garmentFields)
  // the clothes over the body mesh, inside out (garmentFields): trousers, the suit or shirt, its stripes, a vest, a
  // T-shirt with its ribbed collar and shorts, shoes and boots
  if (BP) for (const g of GF.list) bodyShell(g.F.map((F) => (i) => F[i]), g.off, g.hex, g.slot, { hem: g.hem, base: true, skinHem: !!g.skinHem });
  if (!BP && o.tee) { // crew-neck collar and a rolled hem round the waist
    at(B.spine, torusAB(0.06, 0.007, Math.PI * 2, 32).rotateX(Math.PI / 2).translate(0, D.shoulderUp + 0.005, 0.005), o.suit, 'fabric');
    { const r0 = tRows.find((r) => r[0] === B.spine && r[1] >= 0.075); const h = torusAB(1, 0.006, Math.PI * 2, 40); h.scale(r0[2] * 1.03, r0[3] * 1.03, 1); h.rotateX(Math.PI / 2); h.translate(0, 0.075, r0[4]); at(B.spine, h, o.suit, 'fabric'); }
  }
  if (BP && o.shirt) tieAndEpaulettes();
  else if (o.shirt) { // tie and epaulettes
    at(B.spine, capAB(V(0, D.shoulderUp - 0.02, -0.115), V(0, 0.16, -0.122), 0.022, 0.03, { sz: 0.25, seg: 6 }), o.trim);
    for (const sx of [-1, 1]) { const sh = rig.spine ? rig.spine.sh[sx > 0 ? 'R' : 'L'] : V(sx * 0.19, D.shoulderUp, 0.02), ex = sh.x * 0.78, ey = sh.y + (rig.spine ? 0.055 : 0.03), ez = sh.z; // (on the solved shoulders)
      at(B.spine, boxG(0.09, 0.012, 0.045, V(ex, ey, ez)), 0x15161a); at(B.spine, boxG(0.092, 0.014, 0.008, V(ex, ey + 0.002, ez)), o.epaulettes, true); }
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
  if (!BP && o.head === 'leather') at(B.head, torusAB(0.062, 0.022, Math.PI * 2, 28).rotateX(Math.PI / 2).translate(0, 0.03, 0), 0xf2f2ee); // silk scarf
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
  // A shoe's sole, made for the foot it's on (the upper is the 'shoe' garment: a shell grown from the foot up to its
  // collar, so it holds the whole foot and meets the leg along a clean line). In the foot's rest frame (standing,
  // footFrame) the foot is sliced heel to toe and each slice's width measured; the sole is a slab 22 mm thick under
  // the upper (as wide as the upper: the foot plus the upper's thickness), its toe sprung up a little, then put on
  // the foot as it's posed.
  function shoe(sb, hex, shaftH) {
    const ff = footFrame(sb === B.shinR ? 'R' : 'L'); if (!ff) return;
    const { src, floor, M } = ff, OFF = GF.shoe.off, low = src.filter((p) => p.y < floor + 0.03);
    let z0 = Infinity, z1 = -Infinity; for (const p of low) { z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const N = 18, slices = [];
    for (let k2 = 0; k2 <= N; k2++) { const z = z1 + (z0 - z1) * (k2 / N), w = Math.max(0.006, (z1 - z0) / N * 0.9) * (k2 === 0 || k2 === N ? 2 : 1); let x0 = Infinity, x1 = -Infinity;
      for (const p of low) if (Math.abs(p.z - z) < w) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
      if (Number.isFinite(x0)) slices.push({ z, x0, x1 }); }
    if (slices.length < 3) return;
    { const h = slices[0], t2 = slices[slices.length - 1]; slices.unshift({ ...h, z: h.z + OFF }); slices.push({ ...t2, z: t2.z - OFF }); } // (out to the upper's heel and toe)
    const raw = slices.map((sl) => ({ ...sl }));
    for (let it = 0; it < 2; it++) for (let k2 = 1; k2 < slices.length - 1; k2++) for (const f of ['x0', 'x1']) slices[k2][f] = (slices[k2 - 1][f] + 2 * slices[k2][f] + slices[k2 + 1][f]) / 4;
    slices.forEach((sl, k2) => { sl.x0 = Math.min(sl.x0, raw[k2].x0); sl.x1 = Math.max(sl.x1, raw[k2].x1); }); // (smoothed, but never narrower than the foot)
    const top = floor - OFF * 0.6 + 0.004, Mi = R(sb).invert().multiply(M), M2 = slices.length, sp = [], si = [], TH = 0.022;
    slices.forEach((sl, k2) => { const t = k2 / (M2 - 1), end = k2 === 0 || k2 === M2 - 1 ? 0 : 1, cx = (sl.x0 + sl.x1) / 2, rx = ((sl.x1 - sl.x0) / 2 + OFF + 0.002) * (0.7 + 0.3 * end), spring = 0.006 * Math.pow(Math.max(0, t - 0.8) / 0.2, 2);
      for (const [x, y] of [[-rx, 0], [rx, 0], [rx, -TH], [-rx, -TH]]) { const q = V(cx + x, top + y + spring * (1 + y / TH * 0.3), sl.z).applyMatrix4(Mi); sp.push(q.x, q.y, q.z); } });
    for (let k2 = 0; k2 < M2 - 1; k2++) for (let q = 0; q < 4; q++) { const a0 = k2 * 4 + q, a1 = k2 * 4 + ((q + 1) % 4), b0 = a0 + 4, b1 = a1 + 4; si.push(a0, b1, b0, a0, a1, b1); }
    for (const [k2, f] of [[0, 1], [M2 - 1, 0]]) { const b = k2 * 4; if (f) si.push(b, b + 2, b + 1, b, b + 3, b + 2); else si.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setIndex(si); sg.computeVertexNormals();
    { const mid = (M2 >> 1) * 4, c = V(), q = V(); for (let j = 0; j < 4; j++) c.add(V().fromBufferAttribute(sg.attributes.position, mid + j)); c.multiplyScalar(0.25);
      q.fromBufferAttribute(sg.attributes.position, mid + 2).sub(c); if (q.dot(V().fromBufferAttribute(sg.attributes.normal, mid + 2)) < 0) { const ia = sg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } sg.computeVertexNormals(); } } // (faces outward)
    at(sb, sg, shaftH > 0 && !o.bigBoots ? 0x2a2622 : 0xf2f0ea, 'rubber');
    // the toe cap: a rounded box over the front of the foot (a superellipsoid as wide and high as the toes are, plus
    // the upper's thickness, from the sole up), so the toes don't show through; it sinks into the upper behind the ball
    // of the foot along a smooth seam
    { const cz = Math.min(...src.map((p) => p.z)) + 0.055, T = src.filter((p) => p.z < cz && p.y < floor + 0.04); // (the toes)
      if (T.length > 10) { let x0 = Infinity, x1 = -Infinity, y1 = -Infinity, zf = Infinity; for (const p of T) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); zf = Math.min(zf, p.z); }
        const yb = top - 0.002, c = V((x0 + x1) / 2, yb, cz), ne = 3, mf = (q, r) => Math.abs(q.x / r.x) ** ne + Math.abs(q.y / r.y) ** ne + Math.abs(q.z / r.z) ** ne;
        const r = V((x1 - x0) / 2 + OFF + 0.004, y1 - yb + OFF + 0.004, cz - zf + OFF + 0.004); // (over the upper, which stands up to 6 mm further out on the clothes' surface)
        let mx = 0; for (const p of T) mx = Math.max(mx, mf(p.clone().sub(c), V(r.x - OFF, r.y - OFF, r.z - OFF))); const kk = clamp(mx ** (1 / ne), 1, 1.06); r.multiplyScalar(kk); // (holds the toes)
        const NU = 32, NV2 = 12, cp = [], ci = []; // (the upper half, front and back: u round the vertical, v from the sole up)
        for (let j = 0; j <= NV2; j++) for (let i = 0; i <= NU; i++) { const u = (i / NU) * 2 * Math.PI, v = (j / NV2) * Math.PI / 2, cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
          const sg2 = (x) => Math.sign(x) * Math.abs(x) ** (2 / ne), rz = su > 0 ? r.z : 0.03; const q = V(sg2(cu) * sg2(cv) * r.x * (su > 0 ? 1 : 1 + 0.1 * su), sg2(sv) * r.y, sg2(su) * sg2(cv) * rz); q.z = -q.z; q.add(c).applyMatrix4(Mi); cp.push(q.x, q.y, q.z); }
        for (let j = 0; j < NV2; j++) for (let i = 0; i < NU; i++) { const a0 = j * (NU + 1) + i, a1 = a0 + 1, b0 = a0 + NU + 1, b1 = b0 + 1; ci.push(a0, a1, b1, a0, b1, b0); }
        const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3)); cg.setIndex(ci); cg.computeVertexNormals();
        { const k0 = (NV2 >> 1) * (NU + 1) + (NU >> 2) * 3, nn = V().fromBufferAttribute(cg.attributes.normal, k0), pp = V().fromBufferAttribute(cg.attributes.position, k0), cc = c.clone().applyMatrix4(Mi); if (nn.dot(pp.sub(cc)) < 0) { const ia = cg.index.array; for (let f = 0; f < ia.length; f += 3) { const t2 = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t2; } cg.computeVertexNormals(); } }
        at(sb, cg, hex, 'rubber'); } }
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
      at(B.ctlC, boxG(0.1, 0.06, 0.34, V(C.thrBase.x, C.thrBase.y - 0.02, C.thrBase.z - 0.02)), 0x2b2d31); // throttle quadrant (on the rig's fixed frame, where the vehicle put it: not on the hips, which move with the seat fit)
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
    for (const a of C.spokes) at(B.ctlA, capAB(V(0, 0, 0), V(Math.cos(a) * C.wheelR, Math.sin(a) * C.wheelR, 0), 0.012, 0.012, { seg: 6 }), 0x8a8f96, true);
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
export function buildCrew(outfitKey, ctl = 'stick', { seed = 0, colors = null, pegs = null, groundY, seat = null, helm = null } = {}) {
  const outfit = { ...(OUTFITS[outfitKey] || OUTFITS.light), ...(colors || {}) };
  const rig = new Rig(outfitKey, ctl, outfit, seed, { pegs, groundY, seat, helm });
  const key = outfitKey + '|' + ctl + '|' + (seed % 4) + '|' + JSON.stringify(colors || 0) + (pegs ? '|' + JSON.stringify(pegs.map((v) => v.toArray().map((x) => +x.toFixed(3)))) : '') + (seat ? '|' + JSON.stringify(seat) : '') + (helm ? '|' + JSON.stringify(helm) : '');
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
// A seat's surfaces in the figure's rig space (seat point p, figure scale s). fit is either
//   { at, dims: seatGeo's [width, backH, panL, tilt], floor?, feet? } for a seat built with seatGeo, or
//   { surf: { panTop, backZ, tilt, backTop }, floor?, feet? } declared directly (part coordinates: the cushion's top
//      height, the seat back's front face where it meets the cushion (z), its rake back from vertical (radians), the
//      back's top height);
// floor: the floor's height under the feet; feet: 'floor' (the default when there's a floor) or 'pedals' (the feet
// on the controls' pedals instead).
function seatSurfaces(fit, p, s) {
  const floor = fit.floor != null ? (fit.floor - p[1]) / s : null, feet = fit.feet || (floor != null ? 'floor' : 'pedals');
  if (fit.surf) { const f = fit.surf; return { panTop: (f.panTop - p[1]) / s, backZ: (f.backZ - p[2]) / s, tilt: f.tilt ?? 0, backTop: (f.backTop - p[1]) / s, floor, feet }; }
  const [w, backH, , tilt] = fit.dims, [ax, ay, az] = fit.at; void ax;
  return { panTop: (ay + 0.02 + 0.126 * w - p[1]) / s, backZ: (az + 0.02 - p[2]) / s, tilt, backTop: (ay + backH * Math.cos(tilt) - p[1]) / s, floor, feet };
}
// A seat's own control placement (seat.controls, part units relative to the seat point; seat.helm is the wheel's
// shorthand { col, tilt }) over the generic CTL set: vectors and lengths scale into the figure's rig space, angles
// (keys ending in 'tilt' or 'Ang') don't.
function seatControls(st, s) {
  const src = { ...(st.helm ? { col: st.helm.col, tilt: st.helm.tilt } : {}), ...(st.controls || {}) }, out = {};
  for (const [k, v] of Object.entries(src)) { if (v == null) continue; out[k] = Array.isArray(v) ? V(...v).divideScalar(s) : /(tilt|Ang)$/.test(k) ? v : v / s; }
  return Object.keys(out).length ? out : null;
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
      const seat = st.fit && ctl !== 'bars' ? seatSurfaces(st.fit, st.p, st.s || 1) : null, ctlSet = seatControls(st, st.s || 1);
      const c = buildCrew(outfit, ctl, { seed: i * 3 + k, colors, pegs, groundY, seat, helm: ctlSet });
      Object.assign(c.userData.crewRig, { role: st.role || 'pilot', kind, ctl, part: i, seat: k }); // (stations.js names the cockpit views from these)
      c.position.set(...st.p); if (st.quat) c.quaternion.fromArray(st.quat); else if (st.yaw) c.rotation.y = st.yaw;
      if (fit) c.scale.copy(fit); else c.scale.setScalar(st.s || 1);
      obj.add(c); list.push(c.userData.crewRig);
    });
    obj.userData.crew = list; rigs.push(...list);
  });
  return rigs;
}
