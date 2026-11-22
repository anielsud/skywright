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
import { bodyReady, body, person, poseBody, handModel, torsoPoints, bodyDims, spinePose, armRest, headSize, limbRadii } from './body.js';
const LIP_BONES = /^oris/; // the mouth's ring muscle in the body mesh's skeleton: its skin is the lips
await bodyReady; // (the people's mesh: loaded once, before any figure is built; without it the procedural figure stands in)
// Helmet models (assets/people/helmets.*, made by tools/people/helmets.py from three Sketchfab models): unit width, facing
// -Z, centred on their eye point; parts by role (shell, accent, visor, liner, rubber, metal, baked colours). Without them
// the procedural helmets stand in.
const HELMETS = await (async () => {
  try {
    const base = new URL('../assets/people/', import.meta.url);
    const [meta, bin] = await Promise.all([fetch(new URL('helmets.json', base)).then((r) => r.json()), fetch(new URL('helmets.bin', base)).then((r) => r.arrayBuffer())]);
    const q = new Int16Array(bin, 0, meta.verts * 3), pos = Float32Array.from(q, (v) => (v / 32767) * meta.posScale), co = meta.verts * 6, col = new Uint8Array(bin, co, meta.verts * 3), io = co + meta.verts * 3 + ((4 - ((meta.verts * 9) % 4)) % 4); // (positions stored as 16-bit fractions of posScale)
    return { meta: meta.helmets, pos, col, idx: new Uint16Array(bin, io, meta.indices) };
  } catch (e) { console.warn('helmet models unavailable: procedural helmets instead', e); return null; }
})();
// one helmet's parts as geometries (model units), each with its role, slot and source colours (linear)
function helmetParts(name) {
  const H = HELMETS?.meta[name]; if (!H) return null;
  return H.parts.map((pt) => {
    const g = new THREE.BufferGeometry(), c = new THREE.Color(), cs = new Float32Array(pt.nv * 3);
    for (let i = 0; i < pt.nv; i++) { const k = (pt.v0 + i) * 3; c.setRGB(HELMETS.col[k] / 255, HELMETS.col[k + 1] / 255, HELMETS.col[k + 2] / 255, THREE.SRGBColorSpace); cs[i * 3] = c.r; cs[i * 3 + 1] = c.g; cs[i * 3 + 2] = c.b; }
    g.setAttribute('position', new THREE.Float32BufferAttribute(HELMETS.pos.slice(pt.v0 * 3, (pt.v0 + pt.nv) * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(HELMETS.idx.subarray(pt.i0, pt.i0 + pt.ni)), 1)); g.computeVertexNormals();
    return { role: pt.role, slot: pt.slot, g };
  });
}

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

// The astronaut's bubble helmet: clear glass like a canopy's (faint where you look straight through, mirror-like at
// grazing angles; premultiplied, so reflections add on top instead of fading with the low opacity). Added to the shared
// materials as the 'clear' slot the first time a bubble is built.
function clearMaterial() {
  const mats = crewMaterials(); if (mats.clear) return mats.clear;
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.06, clearcoat: 1, clearcoatRoughness: 0.02,
    envMapIntensity: 1.5, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
  m.onBeforeCompile = (sh) => {
    THREE.Material.prototype.onBeforeCompile.call(m, sh); // (the shared fog uniforms)
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
      float ga = mix(diffuseColor.a, 0.85, fres);
      gl_FragColor = vec4(totalDiffuse * ga + max(outgoingLight - totalDiffuse, 0.0), ga);`)
      .replace('#include <fog_fragment>', 'vec3 preFog = gl_FragColor.rgb;\n#include <fog_fragment>\ngl_FragColor.rgb = mix(preFog, gl_FragColor.rgb, gl_FragColor.a);');
  };
  m.customProgramCacheKey = () => 'crew-clear'; m.name = 'crew_clear';
  return (mats.clear = m);
}
// The gold film's colour: a layer that multiplies whatever is behind it (the face, the sky) by its colour, drawn before
// the bubble's reflections. Not fogged (a multiply toward fog colour would darken it at range). The 'gold' slot.
function goldFilmMaterial() {
  const mats = crewMaterials(); if (mats.gold) return mats.gold;
  return (mats.gold = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, name: 'crew_gold' }));
}
// The astronaut's gold sun visor: the same premultiplied glass, but metallic gold (reflections come back gold); with
// the 'gold' film under it the face shows through dimmed and warm. Front faces only, so from inside (the astronaut's
// own view) it isn't drawn. The 'tint' slot.
function tintMaterial() {
  const mats = crewMaterials(); if (mats.tint) return mats.tint;
  const m = clearMaterial().clone(); Object.assign(m, { roughness: 0.04, metalness: 0.95, opacity: 0.25, envMapIntensity: 2.2 });
  m.onBeforeCompile = clearMaterial().onBeforeCompile; m.customProgramCacheKey = () => 'crew-tint'; m.name = 'crew_tint';
  return (mats.tint = m);
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
  space: { head: 'bubble', visor: 0xb08a2a, helmet: 0xf2f2ee, helmet2: 0xc8102e, suit: 0xe9e9e4, suit2: 0xd4d4ce, trim: 0x8a9099, glove: 0xf0f0ea, boot: 0xe2e2dc, harness: false, ring: true, bulk: 0.024, gloveT: 0.004 }, // (bulk: the pressure suit's stand-off from the body; gloveT: the glove's thickness)
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
// A helmet's outer shell from the head inside it (measured half-sizes, as headSize): the liner and shell add 2.2 cm at
// the sides (the measured width already reaches the ears), 2.8 over the crown and 2.4 front and back, so the shell is
// longer than wide like a real one and every head gets a helmet its own size.
function helmetRadii(HR) { return [HR[0] + 0.022, HR[1] + 0.028, HR[2] + 0.024]; }
// The open edges of an indexed mesh (edges used by one triangle), chained into loops of vertex indices.
function boundaryLoops(g) {
  const ix = g.index.array, cnt = new Map(), next = new Map(), key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { const a = ix[f + e], b = ix[f + (e + 1) % 3]; if (a !== b) cnt.set(key(a, b), (cnt.get(key(a, b)) || 0) + 1); }
  for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { const a = ix[f + e], b = ix[f + (e + 1) % 3]; if (a !== b && cnt.get(key(a, b)) === 1) next.set(a, b); }
  const loops = [], seen = new Set();
  for (const s0 of next.keys()) { if (seen.has(s0)) continue; const L = []; let v = s0; while (v !== undefined && !seen.has(v)) { seen.add(v); L.push(v); v = next.get(v); } if (L.length > 4) loops.push(L); }
  return loops;
}
// A hole cut from a grid has a staircase edge: smooth each open edge along its loop in place, keeping it on the surface
// (onto: a point's projection onto it). Returns the loops as points.
function hemEdges(g, onto, its = 10) {
  const P = g.attributes.position, out = [];
  for (const L of boundaryLoops(g)) {
    let pts = L.map((i) => V().fromBufferAttribute(P, i)); const n = pts.length;
    for (let k = 0; k < its; k++) pts = pts.map((p, j) => onto(pts[(j + n - 1) % n].clone().add(pts[(j + 1) % n]).multiplyScalar(0.25).addScaledVector(p, 0.5)));
    L.forEach((i, j) => P.setXYZ(i, pts[j].x, pts[j].y, pts[j].z)); out.push(pts);
  }
  P.needsUpdate = true; g.computeVertexNormals(); return out;
}
// projection onto a dsphere's surface (same parametrisation)
const ontoDS = (c, rx, ry, rz, disp, off = 0) => (p) => { const x = (p.x - c.x) / rx, y = (p.y - c.y) / ry, z = (p.z - c.z) / rz, l = Math.hypot(x, y, z) || 1;
  return dsPoint(c, rx, ry, rz, disp, Math.atan2(x, -z), Math.asin(clamp(y / l, -1, 1)), off); };
// a round tube of radius r along a closed loop of points (a rolled edge)
function tubeLoop(pts, r, seg = 8) {
  const n = pts.length, pos = [], idx = []; let nr = null;
  for (let j = 0; j < n; j++) {
    const t = pts[(j + 1) % n].clone().sub(pts[(j + n - 1) % n]).normalize();
    nr = (nr || (Math.abs(t.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0))).clone(); nr.addScaledVector(t, -nr.dot(t)).normalize(); const bn = t.clone().cross(nr);
    for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2, q = pts[j].clone().addScaledVector(nr, Math.cos(a) * r).addScaledVector(bn, Math.sin(a) * r); pos.push(q.x, q.y, q.z); }
  }
  for (let j = 0; j < n; j++) for (let k = 0; k < seg; k++) { const a = j * seg + k, b = j * seg + (k + 1) % seg, c = ((j + 1) % n) * seg + k, d = ((j + 1) % n) * seg + (k + 1) % seg; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// A surface from a point function P(u, v) over u round (-PI..PI), v up (v0..v1), as dsphere's grid; hole(u, v) leaves
// a face open. Welded.
function gsurf(P, { w = 128, h = 96, hole = null, v0 = -Math.PI / 2, v1 = Math.PI / 2 } = {}) {
  const pos = [], idx = [];
  for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) { const p = P(-Math.PI + (i / w) * Math.PI * 2, v1 - (j / h) * (v1 - v0)); pos.push(p.x, p.y, p.z); }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (hole && hole(-Math.PI + ((i + 0.5) / w) * Math.PI * 2, v1 - ((j + 0.5) / h) * (v1 - v0))) continue;
    const a = j * (w + 1) + i, b = a + 1, cc = a + w + 1, d = cc + 1; idx.push(a, b, cc, b, d, cc);
  }
  let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g = mergeVertices(g, 1e-5); g.computeVertexNormals(); return g;
}
// how far a ray from c along unit d runs before leaving the ellipsoid (centre e, radii r); 0 if it never is inside it
function rayOut(c, d, e, r) {
  const ox = (c.x - e.x) / r[0], oy = (c.y - e.y) / r[1], oz = (c.z - e.z) / r[2], dx = d.x / r[0], dy = d.y / r[1], dz = d.z / r[2];
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (ox * dx + oy * dy + oz * dz), cc = ox * ox + oy * oy + oz * oz - 1, disc = b * b - 4 * a * cc;
  return disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
}
const smax = (a, b, k) => (a + b + Math.sqrt((a - b) ** 2 + k * k)) / 2;
function flipWinding(g) { const ia = g.index.array; for (let f = 0; f < ia.length; f += 3) { const t = ia[f + 1]; ia[f + 1] = ia[f + 2]; ia[f + 2] = t; } g.index.needsUpdate = true; g.computeVertexNormals(); return g; }
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
    const keep = g.userData.keepColor && g.attributes.color; // (a model's own vertex colours)
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(keep && k === 'color')) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    const n = g.attributes.position.count, c = col(hex), cs = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { cs[i * 3] = c.r; cs[i * 3 + 1] = c.g; cs[i * 3 + 2] = c.b; si[i * 4] = bone; sw[i * 4] = 1; }
    if (!keep) g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
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

// ---------- cockpit obstacles ----------
// A seat may declare what's round it (seat.obstacles, in part coordinates like the seat itself), and the posture solve
// keeps the body clear of it (postureCost: head, torso, legs and feet; comfortArm: the arms, per candidate):
//   { plane: [nx, ny, nz], at: [x, y, z] }   the body stays on the side the normal points to (a floor, a wall)
//   { box: [cx, cy, cz], size: [sx, sy, sz], rot?: [rx, ry, rz] }   a solid box (a panel, a console; rot: Euler XYZ)
//   { capsule: [[ax, ay, az], [bx, by, bz]], r }   a solid rod (a column, a frame tube)
//   { inside: [[z, w, h, yc, n?, wb?], ...], ex?, ey?, below?, wBelow?, top? }   a space the body stays inside (a
//      canopy, a cab, a bubble), centred on x = 0: its cross-section at z (rows in z order, interpolated; no constraint
//      outside their range) is |x / w|^ex + |(y - yc) / h|^ey <= 1 (an ellipse by default; a row's n sets both
//      exponents; w = 0 closes it there). Below yc it goes on down as vertical walls (below: 'walls', the default, wb
//      apart or wBelow x as wide) or mirrors ('mirror': an ellipsoid); above `top` it is open (a well's walls stop at
//      the coaming).
//   { well: [ring, ring, ...] }   a well the body stays inside (a cockpit tub): rings of [x, y, z] points round its wall,
//      the top ring first, each with as many points (point k of each ring on one line down the wall). Inside it, at a
//      height, its section is the polygon through each line's point there (a line's top point above it: the wall goes
//      on straight up, as the canopy's skirt does); above every ring's top and below its bottom it is open.
// Each may also name the body parts it concerns (parts: any of head, torso, arms, hands, legs, feet; all by default), a
// margin (the clearance wanted, rig metres; 2 cm for the head, 1 cm otherwise) and a name (for clearance reports).
// A seat that declares obstacles also gets its own controls' levers as obstacles for the legs (stick, throttle, yoke
// column), from where the controls put them.
function prepObstacle(d) {
  const o = { name: d.name || '', parts: d.parts || null, margin: d.margin };
  if (d.plane) { o.k = 'plane'; o.n = V(...d.plane).normalize(); o.d = o.n.dot(V(...d.at)); }
  else if (d.box) { o.k = 'box'; o.c = V(...d.box); o.h = V(...d.size).multiplyScalar(0.5); const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(d.rot || [0, 0, 0]))); o.ax = [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)].map((a) => a.applyQuaternion(q)); }
  else if (d.capsule) { o.k = 'cap'; o.a = V(...d.capsule[0]); o.b = V(...d.capsule[1]); o.r = d.r || 0; }
  else if (d.well) { o.k = 'well'; o.rings = d.well; o.y0 = Math.min(...d.well.at(-1).map((p) => p[1])); o.y1 = Math.max(...d.well[0].map((p) => p[1])); o.xz = new Float64Array(d.well[0].length * 2);
    const R0 = d.well[0], n = R0.length; o.cx = R0.reduce((a, p) => a + p[0], 0) / n; o.cz = R0.reduce((a, p) => a + p[2], 0) / n; o.ang = R0.map((p) => Math.atan2(p[0] - o.cx, p[2] - o.cz)); }
  else if (d.inside) { o.k = 'tube'; o.rows = d.inside; o.ex = d.ex ?? 2; o.ey = d.ey ?? 2; o.below = d.below || 'walls'; o.wBelow = d.wBelow ?? 1; o.top = d.top ?? Infinity; }
  return o;
}
// a tube's cross-section at z: [w, h, yc, n, wb] (null outside its rows; one shared array, read it at once)
const _sec = [0, 0, 0, null, null];
function tubeSection(o, z) {
  const R = o.rows, n = R.length; if (z < R[0][0] || z > R[n - 1][0]) return null;
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m][0] < z) lo = m; else hi = m; } // (rows in z order)
  const a = R[lo], b = R[hi], t = (z - a[0]) / (b[0] - a[0] || 1), f = (k) => (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * t;
  _sec[0] = f(1); _sec[1] = f(2); _sec[2] = f(3); _sec[3] = a[4] != null ? f(4) : null; _sec[4] = a[5] != null ? f(5) : null; return _sec;
}
// how far a point (x, y) is inside a section (negative: outside), to first order (exact for a circle, and near the edge)
function sectionClear(o, sec, x, y) {
  if (y > o.top) return Infinity;
  let [w, h, yc, n, wb] = sec, yy = y - yc; const ex = n ?? o.ex, ey = n ?? o.ey;
  if (yy < 0) { if (o.below === 'walls') { yy = 0; w = wb ?? w * o.wBelow; } else yy = -yy; }
  if (w < 1e-4 || h < 1e-4) return -Math.hypot(x, yy); // (closed here)
  const ax = Math.abs(x) / w, ay = yy / h, lim = Math.min(w, h);
  if (ex === 2 && ey === 2) { const G = Math.hypot(ax, ay); return G < 1e-6 ? lim : Math.min(lim, (1 - G) / Math.max(Math.hypot(ax / w, ay / h) / G, 1e-6)); } // (an ellipse)
  const F = ax ** ex + ay ** ey, m = (ex + ey) / 2;
  if (F < 1e-12) return lim;
  const k = F ** (1 / m - 1) / m, gx = (k * ex * ax ** (ex - 1)) / w, gy = (k * ey * ay ** (ey - 1)) / h;
  return Math.min(lim, (1 - F ** (1 / m)) / Math.max(Math.hypot(gx, gy), 1e-6));
}
// A sphere (centre c, radius r, part space) against an obstacle: the gap between them (negative: how deep it is in).
// A sphere inside a tube: its slices at z - r .. z + r, each a disc inside that z's section.
const _ov = V();
const SLICES = [0, -0.5, 0.5, -1, 1], SLICES3 = [0, -1, 1];
function obstacleClear(o, c, r, coarse = false) {
  if (o.k === 'plane') return o.n.dot(c) - o.d - r;
  if (o.k === 'box') {
    _ov.copy(c).sub(o.c); let out = 0, inn = -Infinity;
    for (let i = 0; i < 3; i++) { const q = Math.abs(_ov.dot(o.ax[i])) - o.h.getComponent(i); if (q > 0) out += q * q; inn = Math.max(inn, q); }
    return (out > 0 ? Math.sqrt(out) : inn) - r;
  }
  if (o.k === 'cap') {
    const abx = o.b.x - o.a.x, aby = o.b.y - o.a.y, abz = o.b.z - o.a.z, L2 = abx * abx + aby * aby + abz * abz || 1;
    const t = clamp(((c.x - o.a.x) * abx + (c.y - o.a.y) * aby + (c.z - o.a.z) * abz) / L2, 0, 1);
    return Math.hypot(c.x - o.a.x - abx * t, c.y - o.a.y - aby * t, c.z - o.a.z - abz * t) - o.r - r;
  }
  if (o.k === 'well') return wellClear(o, c, r);
  let best = Infinity;
  for (const f of coarse ? SLICES3 : SLICES) { const sec = tubeSection(o, c.z + f * r); if (sec) best = Math.min(best, sectionClear(o, sec, c.x, c.y) - r * Math.sqrt(1 - f * f)); }
  return best;
}
// A sphere in a well: its centre's height's section (each wall line's point there), the distance to the polygon's edges
// (negative outside it) less the radius
function wellClear(o, c, r) {
  if (c.y > o.y1 || c.y < o.y0) return Infinity;
  const R = o.rings, n = R[0].length, xz = o.xz, col = (k) => { // wall line k's point at the centre's height
    let x = R[0][k][0], z = R[0][k][2];
    if (c.y < R[0][k][1]) for (let j = 1; j < R.length; j++) { const a = R[j - 1][k], b = R[j][k]; if (c.y >= b[1] || j === R.length - 1) { const t = clamp((a[1] - c.y) / (a[1] - b[1] || 1), 0, 1); x = a[0] + (b[0] - a[0]) * t; z = a[2] + (b[2] - a[2]) * t; break; } }
    xz[k * 2] = x; xz[k * 2 + 1] = z;
  };
  // only the wall near the point's bearing from the well's middle (the section is near enough star-shaped round it): the
  // nearest edge is among them, and whether the point is inside is which side of the edge it crosses
  const th = Math.atan2(c.x - o.cx, c.z - o.cz); let k0 = 0, best = Infinity;
  for (let k = 0; k < n; k++) { const d = Math.abs(Math.atan2(Math.sin(o.ang[k] - th), Math.cos(o.ang[k] - th))); if (d < best) { best = d; k0 = k; } }
  const W = Math.min(4, n >> 1), ks = []; for (let i = -W; i <= W; i++) { const k = (k0 + i + n) % n; ks.push(k); col(k); }
  let d2 = Infinity, inside = true;
  for (let i = 1; i < ks.length; i++) {
    const ja = ks[i - 1], jb = ks[i], ax = xz[ja * 2], az = xz[ja * 2 + 1], ex = xz[jb * 2] - ax, ez = xz[jb * 2 + 1] - az;
    const t = clamp(((c.x - ax) * ex + (c.z - az) * ez) / (ex * ex + ez * ez || 1), 0, 1), dx = c.x - ax - ex * t, dz = c.z - az - ez * t, dd = dx * dx + dz * dz;
    if (dd < d2) { d2 = dd; inside = (ex * (c.z - az) - ez * (c.x - ax)) * (ex * (o.cz - az) - ez * (o.cx - ax)) >= 0; } // (on the middle's side of it)
  }
  return (inside ? 1 : -1) * Math.sqrt(d2) - r;
}
// The seat's obstacles, prepared once per rig: part space, with the rig -> part transform (seat point, figure scale,
// the seat's turn) and the controls' levers added. null when the seat declares none.
function seatObstaclesOf(rig) {
  if (rig._obs !== undefined) return rig._obs;
  const d = rig.opts.seat?.obstacles; if (!d?.list?.length) return (rig._obs = null);
  const X = { p: V(...d.p), s: d.s, q: d.q ? new THREE.Quaternion().fromArray(d.q) : new THREE.Quaternion(), list: d.list.map(prepObstacle) };
  X.toPart = (c, out = V()) => out.copy(c).multiplyScalar(X.s).applyQuaternion(X.q).add(X.p);
  const C = rig.C, lever = (name, a, b, r) => X.list.push({ k: 'cap', name, parts: ['legs'], a: X.toPart(a), b: X.toPart(b), r: r * X.s });
  if (C.stickBase && (rig.ctl === 'stick' || rig.ctl === 'cyclic')) lever('stick', C.stickBase, C.stickBase.clone().add(V(0, C.stickLen, 0)), 0.022);
  if (C.thrBase && rig.ctl === 'stick') lever('throttle', C.thrBase, V(0, C.thrLen, 0).applyEuler(new THREE.Euler(-0.55 + 0.4 * 1.1, 0, 0)).add(C.thrBase), 0.02);
  if (C.colBase && rig.ctl === 'yoke') lever('column', C.colBase, V(0, C.colLen, 0).applyEuler(new THREE.Euler(0.42, 0, 0)).add(C.colBase), 0.035);
  // an obstacle the body (as first posed: the relaxed start, or a cached solve) is already deep in is one this person
  // can't get clear of by sitting differently (a resized cockpit buried in its body): it is left out, rather than the
  // posture contorting against it
  const P = V(); for (const sp of bodySpheres(rig, rig.floorY != null ? POSE_OBST : POSE_OBST_PEDALS)) { X.toPart(sp.c, P); for (const o of X.list) if (!o.parts || o.parts.includes(sp.g)) if (obstacleClear(o, P, sp.r * X.s) / X.s < -DEEP_IN) o.skip = true; }
  X.list = X.list.filter((o) => !o.skip);
  return (rig._obs = X.list.length ? X : null);
}
// The posed body as spheres (rig space), by part: the head (measured, or the helmet's shell), the torso (its measured
// cross-sections), each arm, hand, thigh, shin and foot as a capsule round its bone (measured thickness plus clothing).
function bodySpheres(rig, groups) {
  const p = rig.p, q = rig.q, D = rig.D, o = rig.o, out = [], want = (g) => !groups || groups.includes(g);
  const M = (rig._bodyM ||= { head: rig.body ? headSize(rig.body) : null, limb: rig.body ? limbRadii(rig.body) : null });
  const pad = o.vest ? 0.02 : o.tee || o.shirt ? 0.004 : 0.01, LR = M.limb || LIMB0;
  const seg = (g, name, a, b, r) => { const n = Math.max(2, Math.ceil(a.distanceTo(b) / r) + 1); for (let i = 0; i < n; i++) out.push({ g, name, c: a.clone().lerp(b, i / (n - 1)), r }); };
  const limb = (g, name, i, a, b, L) => { const d = V(L.off[0], 0, L.off[1]).applyQuaternion(q[i]); seg(g, name, a.clone().add(d), b.clone().add(d), L.r + pad); }; // (round the flesh's middle, off the bone)
  if (want('head')) {
    const helm = o.head === 'helmet' || o.head === 'fullface' || o.head === 'bubble', big = o.head === 'bubble' ? 1.18 : 1;
    const hc = M.head ? M.head.centre : V(0, 0.135, -0.01), r = helm ? (M.head && o.head !== 'bubble' ? (helmetRadii([M.head.radii.x, M.head.radii.y, M.head.radii.z])[1] + helmetRadii([M.head.radii.x, M.head.radii.y, M.head.radii.z])[2]) / 2 : 0.14 * big) : M.head ? (M.head.radii.y + M.head.radii.z) / 2 + 0.01 : 0.115;
    out.push({ g: 'head', name: 'head', c: hc.clone().applyQuaternion(q[B.head]).add(p[B.head]), r });
  }
  if (want('torso') && rig.torsoEll) rig.torsoEll.forEach((e, i) => { if (i % 2) return;
    const r = e.rz; for (const sx of [-1, 0, 1]) out.push({ g: 'torso', name: 'torso', c: V(e.cx + sx * Math.max(0, e.rx - r), e.y, e.cz).applyQuaternion(q[B.spine]).add(p[B.spine]), r }); });
  for (const [k, uA, fA, hA, th, sh] of [['R', B.uArmR, B.fArmR, B.handR, B.thighR, B.shinR], ['L', B.uArmL, B.fArmL, B.handL, B.thighL, B.shinL]]) {
    if (want('arms')) { limb('arms', 'uArm' + k, uA, p[uA], p[fA], LR.uArm); limb('arms', 'fArm' + k, fA, p[fA], p[hA], LR.fArm); }
    if (want('hands')) seg('hands', 'hand' + k, p[hA], V(0, 0.09, 0).applyQuaternion(q[hA]).add(p[hA]), 0.032);
    const ankle = V(0, D.shin, 0).applyQuaternion(q[sh]).add(p[sh]);
    if (want('legs')) { limb('legs', 'thigh' + k, th, p[th], p[sh], LR.thigh); limb('legs', 'shin' + k, sh, p[sh], ankle, LR.shin); }
    if (want('feet')) { // the measured foot (heel to toe, along the sole) in its shoe: flat on a floor (poseBody levels it), else square to the shin as it stands (the shin bone's frame: +Y down it, -Z forward)
      const F = LR.foot || { toe: -0.19, heel: 0.05, sole: 0.07, r: 0.045 }, shoe = o.bigBoots ? 0.04 : 0.025, r = F.r + shoe, h = r - F.sole - shoe; // (a shoe's sole and toe box: a couple of centimetres round the foot)
      const at = (z) => (rig.floorY == null ? V(0, D.shin - h, z).applyQuaternion(q[sh]).add(p[sh]) : ankle.clone().add(V(0, h, z)));
      seg('feet', 'foot' + k, at(F.heel + shoe - r), at(F.toe - shoe + r), r); }
  }
  return out;
}
// The obstacles' cost for the posed body's parts in `groups`: each sphere closer than the margin to an obstacle, by the
// square of how much closer (in centimetres, x4: the wheel rim's `hit` term's scale).
const LIMB0 = { uArm: { r: 0.045, off: [0, 0] }, fArm: { r: 0.038, off: [0, 0] }, thigh: { r: 0.075, off: [0, 0] }, shin: { r: 0.05, off: [0, 0] } }; // (the procedural figure's)
const DEEP_IN = 0.06; // (rig metres: deeper than this in an obstacle at the start, it's out of reach; see seatObstaclesOf)
const HEAD_MARGIN = 0.02; // (the head: 2 cm, a helmet's or a head's own size is only near enough a sphere)
// (the arms: comfortArm, per candidate; the feet only when they stand on a floor: on pedals they're where the pedals are)
const POSE_OBST = ['head', 'torso', 'legs', 'feet'], POSE_OBST_PEDALS = ['head', 'torso', 'legs'];
function obstacleCost(rig, groups = rig.floorY != null ? POSE_OBST : POSE_OBST_PEDALS) {
  const X = seatObstaclesOf(rig); if (!X) return 0;
  let c = 0; const P = V();
  for (const sp of bodySpheres(rig, groups)) { X.toPart(sp.c, P);
    for (const o of X.list) { if (o.parts && !o.parts.includes(sp.g)) continue; const m = o.margin ?? (sp.g === 'head' ? HEAD_MARGIN : 0.01), cl = obstacleClear(o, P, sp.r * X.s) / X.s; if (cl < m) c += ((m - cl) / 0.01) ** 2 * 4; } }
  return c;
}
// For comfortArm: the obstacles an arm from shoulder S could reach (null if none), then each candidate's cost (the elbow,
// the middle of the upper arm and of the forearm, as spheres of the measured arm's thickness). Refining round the last
// answer (every frame, and through the posture solve) the elbow moves a few centimetres at most: only the obstacles
// within 15 cm of where the arm was are tested.
function armObstacles(rig, S, k) {
  const X = seatObstaclesOf(rig); if (!X) return null;
  const LR = (rig._bodyM ||= { head: rig.body ? headSize(rig.body) : null, limb: rig.body ? limbRadii(rig.body) : null }).limb || LIMB0, pad = rig.o.vest ? 0.02 : rig.o.tee || rig.o.shirt ? 0.004 : 0.01;
  // (round the bones: the arms' flesh is near enough centred on them, and the candidate's bone frames aren't built yet)
  const rU = LR.uArm.r + Math.hypot(...LR.uArm.off) + pad, rF = LR.fArm.r + Math.hypot(...LR.fArm.off) + pad;
  const P = X.toPart(S), reach = (rig.D.upper + rig.D.fore + 0.1) * X.s, el = rig.armSol?.[k] && rig.p[k === 'R' ? B.fArmR : B.fArmL];
  const E = el && X.toPart(el), F = el && X.toPart(el.clone().lerp(rig.p[k === 'R' ? B.handR : B.handL], 0.5));
  const list = X.list.filter((o) => (!o.parts || o.parts.includes('arms')) && (el ? Math.min(obstacleClear(o, E, rU * X.s), obstacleClear(o, F, rF * X.s)) < 0.15 * X.s : o.k === 'tube' || o.k === 'well' || obstacleClear(o, P, 0) < reach));
  // (the middle of the upper arm only where an obstacle is near the shoulder: the elbow and the forearm usually decide)
  return list.length ? { X, list, rU: rU * X.s, rF: rF * X.s, P: V(), A: V(), to: 3, from: list.some((o) => obstacleClear(o, P, 0) < (rig.D.upper * 0.5 + rU + 0.05) * X.s) ? 0 : 1 } : null;
}
function armObstacleCost(OB, S, E, W) {
  if (!OB) return 0;
  const { X, list, P, A } = OB; let c = 0;
  for (let i = OB.from; i < OB.to; i++) {
    X.toPart(i === 0 ? A.copy(S).lerp(E, 0.5) : i === 1 ? A.copy(E) : A.copy(E).lerp(W, 0.5), P); const r = i === 2 ? OB.rF : OB.rU;
    for (const o of list) { const m = o.margin ?? 0.01, cl = obstacleClear(o, P, r, true) / X.s; if (cl < m) c += ((m - cl) / 0.01) ** 2 * 4; }
  }
  return c;
}
// Clearances of the posed body (every part, the hands too) from the seat's obstacles: per body part, the smallest gap
// (rig metres; negative: in it) and the obstacle it's to. For checking a cockpit's fit (tools, debug views).
export function crewClearance(rig) {
  const X = seatObstaclesOf(rig); if (!X) return null;
  const out = {}, P = V();
  for (const sp of bodySpheres(rig, null)) { X.toPart(sp.c, P);
    for (const o of X.list) { if (o.parts && !o.parts.includes(sp.g)) continue; const cl = obstacleClear(o, P, sp.r * X.s) / X.s; if (!out[sp.name] || cl < out[sp.name].clear) out[sp.name] = { clear: +cl.toFixed(4), to: o.name || o.k }; } }
  return out;
}
// The prepared obstacles and the body spheres (for drawing them: part space, and rig space)
export function crewObstacles(rig) { const X = seatObstaclesOf(rig); return X && { ...X, spheres: bodySpheres(rig, null) }; }

// ---------- riders ('bars' seats): the vehicle's geometry round the rider (rig space; see rideGeometry) ----------
// Bodywork is given as superLoft sections { z, hw, top, bot, n, cx? } (z ascending, linear between sections), the way
// the vehicle lofts it. loftAt: the section at z (null outside the loft).
function loftAt(secs, z) {
  if (!secs?.length || z < secs[0].z || z > secs.at(-1).z) return null;
  let i = 0; while (i < secs.length - 2 && z > secs[i + 1].z) i++;
  const a = secs[i], b = secs[i + 1] || a, t = b.z > a.z ? (z - a.z) / (b.z - a.z) : 0, L = (k, d = 0) => (a[k] ?? d) + ((b[k] ?? d) - (a[k] ?? d)) * t;
  return { hw: L('hw'), top: L('top'), bot: L('bot'), n: L('n', 3), cx: L('cx') };
}
// how deep a ball (centre P, radius r) is inside a loft (0: outside)
function loftDepth(secs, P, r) {
  const s = loftAt(secs, P.z); if (!s) return 0;
  const hw = s.hw + r, hh = (s.top - s.bot) / 2 + r, mid = (s.top + s.bot) / 2;
  const qd = Math.abs(P.x - s.cx) / hw, qy = Math.abs(P.y - mid) / hh; if (qd >= 1 || qy >= 1) return 0;
  const m = (qd ** s.n + qy ** s.n) ** (1 / s.n); return m < 1 ? (1 - m) * Math.min(hw, hh) : 0;
}
// the gap between a ball (a knee) and a loft's side (negative: pressed in), and the loft's half-width there; beside the
// loft's side (within its height) the gap is horizontal, above or below it the distance to its top or bottom edge
function loftGap(secs, P, r) {
  const s = loftAt(secs, P.z); if (!s) return null;
  const hh = (s.top - s.bot) / 2, mid = (s.top + s.bot) / 2, dy = Math.abs(P.y - mid), dx = Math.abs(P.x - s.cx);
  if (dy < hh) { const w = s.hw * Math.max(0, 1 - (dy / hh) ** s.n) ** (1 / s.n); return { gap: dx - r - w, w }; }
  return { gap: Math.hypot(Math.max(0, dx - s.hw * 0.7), dy - hh) - r, w: 0 };
}
// the cushion's top at z, a little off its centre line (where the seat bones bear)
function saddleTop(secs, z, x0 = 0.06) {
  const s = loftAt(secs, clamp(z, secs[0].z, secs.at(-1).z)), hh = (s.top - s.bot) / 2, mid = (s.top + s.bot) / 2;
  return mid + hh * Math.max(0, 1 - Math.min(1, x0 / s.hw) ** s.n) ** (1 / s.n);
}
const rideHitsCost = (h) => Object.values(h).reduce((c, d) => c + (d / 0.01) ** 2 * 4, 0); // (a centimetre into the bodywork costs as much as a joint well off its comfort)
const RIDES = new Map(); // (solved rider postures: person, vehicle geometry -> v)

// A gloved hand grips as a hand whose palm and fingers are thicker by the glove (t, metres): the bar sits that much
// further off the palm (the rig places the hand by G), and the fingers wrap a bar that much thicker (body.js curls them
// round rig.grips), so the glove's surface, not the skin under it, is what meets the bar.
function gloved(HM, t) { if (!HM || !t) return HM; const o = {}; for (const s of ['R', 'L']) o[s] = { ...HM[s], G: (r) => HM[s].G(r + t) }; return o; }
function glovedGrips(rig) { const t = rig.o.gloveT, g = rig.grips; if (!t || !g) return g; const o = {}; for (const s of ['R', 'L']) o[s] = g[s] && { ...g[s], r: g[s].r + t }; return o; }

const POSTURES = new Map(); // (solved postures: person, seat and controls -> v)
const ADJ_KEYS = ['pedZ', 'pedY', 'seatZ', 'seatY']; // (what a vehicle may declare adjustable: Rig.adjustVars)
class Rig {
  constructor(kind, ctl, outfit, seed, opts = {}) {
    this.kind = kind; this.ctl = ctl; this.o = outfit; this.seed = seed;
    this.pegs = opts.pegs || [V(-0.24, -0.62, 0.0), V(0.24, -0.62, 0.0)]; this.groundY = opts.groundY ?? -1.1;
    // a vehicle may declare its own control placement (opts.helm: seatControls(), e.g. a wheel's centre and tilt, a
    // stick's base); otherwise the generic set for these controls
    const C = opts.helm ? { ...(CTL[ctl] || CTL.none), ...Object.fromEntries(Object.entries(opts.helm).map(([k, v]) => [k, v?.isVector3 ? v.clone() : v])) } : CTL[ctl] || CTL.none; this.body = (outfit.head !== 'bubble' || outfit.bulk) && body() ? person(PEOPLE[seed % PEOPLE.length]) : null;
    const HM = this.body ? gloved(handModel(this.body), outfit.gloveT) : null; this.armRest = this.body ? armRest(this.body) : null;
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
    if (ctl === 'bars' && opts.ride) this.configureRide(this.solveRide()); // (a rider: solved on the vehicle's declared geometry)
    else this.configure(HM && opts.seat ? this.solvePosture() : this.defaultPosture());
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
    const D = this.D, o = this.o, ctl = this.ctl, HM = !!this.body, st = this.railSeat(v), C = this.C;
    this.v = v;
    this.spine = HM ? spinePose(D, v.flex, v.prot, this.body) : null;
    const spineQ = this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), HM && ctl !== 'bars' ? v.lean : D.lean);
    this.base = V();
    // the torso as an obstacle for the arms: its cross-section at each height up the spine (an ellipse round the
    // middle of the measured, posed torso), padded by what's worn over it
    const T2 = HM ? torsoPoints(D, this.spine, this.body) : null;
    if (T2) { const wear = o.bulk ? o.bulk + 0.006 : o.vest ? 0.04 : o.tee || o.shirt ? 0.006 : 0.012, ell = [];
      for (let y = 0.05; y <= D.spine + 0.02; y += 0.025) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const p of T2.spine) if (Math.abs(p.y - y) < 0.02) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
        if (Number.isFinite(x0)) ell.push({ y, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2 + wear, rz: (z1 - z0) / 2 + wear }); }
      this.torsoEll = ell; }
    // sitting in the seat: the body's lowest point (plus clothing) on the cushion, sunk a little, and its back (plus
    // what's worn on it) against the seat back, then slid forward by v.slide
    if (T2 && st) {
      const sM = new THREE.Matrix4().compose(V(0, 0.03, 0), spineQ, V(1, 1, 1)), pts = [...T2.hips, ...T2.spine.map((p) => p.clone().applyMatrix4(sM))];
      const seatT = o.bulk ? o.bulk * 0.6 : o.shorts ? 0.008 : 0.012, backT = o.bulk ? o.bulk * 0.8 : o.vest ? 0.034 : o.tee || o.shirt ? 0.006 : 0.012;
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
    const c0 = c; c += ((v.lean - leanTo) / 0.15) ** 2 + ((v.flex - 0.2) / 0.3) ** 2 + (v.prot / 0.3) ** 2 + (v.slide / 0.06) ** 2 + (v.splay / 0.1) ** 2; parts.posture = c - c0; // (knees wide apart is no way to sit)
    if (this.C.adjust) { parts.adjust = this.adjustCost(v); c += parts.adjust; }
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
    parts.obst = obstacleCost(this); c += parts.obst; // (the seat's declared obstacles: canopy, panel, walls; see obstacleCost)
    return c;
  }
  // The posture for this person in this seat at these controls: coordinate descent over v from a relaxed start,
  // each variable stepped both ways while it helps, the steps halving each pass. Cached per person, seat and controls.
  solvePosture() {
    const key = [this.kind, this.ctl, this.seed % PEOPLE.length, JSON.stringify(this.opts.seat), JSON.stringify(this.opts.helm || null)].join('|');
    if (POSTURES.has(key)) { const r = POSTURES.get(key); this.gripA = r.gripA && { ...r.gripA }; this.postureScore = r.score; return { ...r.v }; }
    const VARS = [['lean', 0.05, 0.5, 0.08], ['flex', 0, 0.9, 0.12], ['prot', 0, 0.35, 0.06], ['slide', 0, 0.14, 0.03], ['shin', 0.05, 1.1, 0.12], ['splay', 0, 0.35, 0.08]];
    if (this.ctl === 'wheel') VARS.push(['colZ', -0.05, 0.05, 0.025], ['colY', -0.05, 0.05, 0.025]); // (a tilt helm's few centimetres; where the helm is, is the vehicle's)
    VARS.push(...this.adjustVars()); // (pedals, a seat on rails: whatever the vehicle declared adjustable, within its travel)
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
    const v0 = { ...this.defaultPosture(), ...this.adjustStart() }, starts = [];
    if (this.ctl === 'wheel') for (const colZ of [-0.05, 0, 0.05]) for (const colY of [-0.05, 0, 0.05]) { const t = { ...v0, colZ, colY }; delete this.armSol; starts.push({ v: t, c: cost(t), gripA: this.gripA && { ...this.gripA } }); } // (the rim grip is searched fully once, then refined locally)
    else for (const t of this.adjustStarts(v0)) { delete this.armSol; starts.push({ v: t, c: cost(t) }); } // (with adjustable pedals or seat, a coarse grid of their settings)
    starts.sort((a, b) => a.c - b.c);
    let win = null;
    for (const st0 of starts.slice(0, 2)) { this.gripA = st0.gripA && { ...st0.gripA }; delete this.armSol; cost(st0.v); const r = descend(st0.v, cost(st0.v)); r.gripA = this.gripA && { ...this.gripA }; if (!win || r.c < win.c) win = r; }
    let v = win.v, best = win.c; this.gripA = win.gripA; delete this.armSol;
    this.solving = false; this.postureScore = best;
    POSTURES.set(key, { v: { ...v }, gripA: this.gripA && { ...this.gripA }, score: best });
    return v;
  }
  // ---- adjustable controls and seat ----
  // A vehicle may declare what adjusts and how far (C.adjust, rig space, offsets from where it put things: pedZ / pedY
  // the rudder pedals aft / up, seatZ / seatY the seat on its rails aft / up; [lo, hi] each). The posture solve
  // chooses them once, as extra variables, like a wheel's tilt helm; the pedals are drawn where they were set (they're
  // the rig's), the seat's own mesh is moved by addCrew (railSeatMesh).
  adjustVars() {
    const A = this.C.adjust; if (!A) return [];
    return ADJ_KEYS.filter((k) => A[k]).map((k) => [k, A[k][0], A[k][1], Math.max(0.01, (A[k][1] - A[k][0]) / 4)]);
  }
  // the solve starts from where the vehicle put things (or the nearest end of the travel)
  adjustStart() { const out = {}; for (const [k, lo, hi] of this.adjustVars()) out[k] = clamp(0, lo, hi); return out; }
  // starts for the solve over the adjustments' coarse grid (each at either end of its travel and where it was put):
  // the descent alone stops short, e.g. a short pilot sliding off the seat back rather than bringing the seat forward
  adjustStarts(v0) {
    let out = [v0];
    for (const [k, lo, hi] of this.adjustVars()) out = out.flatMap((v) => [...new Set([lo, clamp(0, lo, hi), hi])].map((x) => ({ ...v, [k]: x })));
    return out;
  }
  // an adjustment is cheap (a lever and a slide): a little cost, for a definite answer near where things were put
  adjustCost(v) { let c = 0; for (const [k] of this.adjustVars()) c += 0.5 * ((v[k] || 0) / 0.15) ** 2; return c; }
  // the seat's surfaces moved along its rails by v.seatZ / v.seatY (the floor stays)
  railSeat(v) {
    const st = this.opts.seat; if (!st || !(v.seatZ || v.seatY)) return st;
    const dz = v.seatZ || 0, dy = v.seatY || 0;
    return { ...st, panTop: st.panTop + dy, backTop: st.backTop + dy, backZ: st.backZ + dz };
  }
  // ---- riders ('bars' with opts.ride: rideGeometry) ----
  // A rider's posture v: { hz (the pelvis's place along the saddle, rig z), fwd (the torso's forward lean from the
  // hips), flex (the back's bend), prot (the shoulders forward), kOut (the knees' swing out round the hip-peg line),
  // hy (standing: the pelvis's height above the saddle; an 'attack' stance only) }.
  // The pelvis sits on the saddle's top at hz (the body's lowest point on the cushion, sunk a little); hands on the
  // grips and feet on the pegs are the vehicle's, so the rest follows.
  configureRide(v) {
    this.configure({ ...v, lean: 0, slide: 0, shin: 0.21, splay: 0 }); this.v = v;
    const R = this.opts.ride, D = this.D, T2 = this.body ? torsoPoints(D, this.spine, this.body) : null;
    if (this.rideGrips === undefined) this.rideGrips = R.grips?.length === 2 ? R.grips.map((g) => V(...g)) : null;
    let minY = -0.08; if (T2) { minY = Infinity; for (const p of T2.hips) minY = Math.min(minY, p.y - 0.012); } // (plus leathers)
    const top = saddleTop(R.saddle, v.hz);
    this.base.set(R.saddle[0].cx || 0, top - 0.012 - minY + (v.hy || 0), v.hz); this.rideSeatY = top - 0.012; // (hy: standing up off the saddle, an attack stance)
  }
  // per frame: the solved posture, bent further forward when tucked at speed (as far as the bodywork lets the chest
  // go), leaning further into a turn than the bike
  rideFrame(s) {
    const D = this.D, v = this.v, lean = s.lean || 0, tuck = s.tuck || 0, fwd = v.fwd + tuck * ((this.fwdTuck ?? v.fwd) - v.fwd);
    this.hipAt = this.base.clone().add(V(lean * 0.12, -Math.abs(lean) * 0.03, tuck * 0.04));
    this.spineQ = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -lean).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -fwd));
    this.spinePos = V(0, 0.03, 0).add(this.hipAt);
    const sp = (x, y, z) => V(x, y, z).applyQuaternion(this.spineQ).add(this.spinePos);
    this.joints(sp);
    this.hipR = V(D.hipW, 0, 0).add(this.hipAt); this.hipL = V(-D.hipW, 0, 0).add(this.hipAt);
  }
  // the knee's pole (the direction it bends towards): forward and up, swung out by kOut; each frame, a knee that the
  // hips' lean would push into the bodywork swings out until it clears
  rideKnee(k, foot) {
    const sx = k === 'R' ? 1 : -1, hip = k === 'R' ? this.hipR : this.hipL, R = this.opts.ride, D = this.D, E = V();
    const pole = (a) => V(sx * Math.sin(a), 0.55 * Math.cos(a), -Math.cos(a));
    let a = this.v.kOut; if (this.solving) return pole(a);
    for (let n = 0; n < 8; n++) {
      ikTwo(hip, foot, D.thigh, D.shin, pole(a), E);
      const g = Math.min(...R.around.map((L) => loftGap(L, E, 0.055)?.gap ?? 1)); if (g > -0.01) break; a += 0.06;
    }
    return pole(a);
  }
  // obstacles: how deep the legs, torso, arms and head go into the bodywork (each part's deepest, summed)
  rideHits() {
    const p = this.p, q = this.q, R = this.opts.ride, P = V(), deep = (pt, r) => Math.max(0, ...R.around.map((L) => loftDepth(L, pt, r)));
    const seg = (a, b, list) => { let h = 0; for (const [t, r] of list) h = Math.max(h, deep(P.copy(a).lerp(b, t), r)); return h; };
    const hit = { legs: 0, torso: 0, arms: 0, head: 0 };
    for (const [th, sh] of [[B.thighR, B.shinR], [B.thighL, B.shinL]]) {
      const ank = V(0, this.D.shin, 0).applyQuaternion(q[sh]).add(p[sh]);
      hit.legs += seg(p[th], p[sh], [[0.45, 0.07], [0.7, 0.062], [0.9, 0.055]]) + seg(p[sh], ank, [[0.15, 0.05], [0.4, 0.045], [0.7, 0.04]]);
    }
    for (const [u, f, h] of [[B.uArmR, B.fArmR, B.handR], [B.uArmL, B.fArmL, B.handL]]) hit.arms += seg(p[u], p[f], [[0.3, 0.05], [0.7, 0.047], [1, 0.045]]) + seg(p[f], p[h], [[0.3, 0.04], [0.6, 0.036]]);
    if (this.torsoEll) for (const e of this.torsoEll) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2;
      P.set(e.cx + e.rx * Math.cos(a), e.y, e.cz + e.rz * Math.sin(a)).applyQuaternion(q[B.spine]).add(p[B.spine]); hit.torso = Math.max(hit.torso, deep(P, -0.015)); } // (the chest may rest on the tank: a centimetre and a half of leathers and belly gives)
    hit.head = deep(V(0, 0.12, -0.02).applyQuaternion(q[B.head]).add(p[B.head]), 0.13);
    return hit;
  }
  // How good a rider's posture is, once posed: the arms' comfort on the grips (comfortArm's cost), the hips and knees
  // (flexion near a seated person's, knees not spread wide), the knees against the bodywork (pressed to it for a 'grip'
  // seat, else close to it), the back near its relaxed lean and bend, the neck not craned too far back to see the road,
  // and nothing through the bodywork.
  rideCost() {
    this.pose(this.state);
    const p = this.p, q = this.q, v = this.v, R = this.opts.ride, parts = this.costParts = {}; let c = 0;
    for (const k of ['R', 'L']) c += this.armAngles?.[k]?.cost ?? 0; parts.arms = c;
    const up = V(0, 1, 0).applyQuaternion(q[B.spine]), fit = this.riderFit = { knees: R.knees || 'near' };
    let legs = 0, knees = 0;
    for (const [k, th, sh] of [['R', B.thighR, B.shinR], ['L', B.thighL, B.shinL]]) {
      const td = V(0, 1, 0).applyQuaternion(q[th]), sd = V(0, 1, 0).applyQuaternion(q[sh]);
      const hip = Math.acos(clamp(up.dot(td), -1, 1)), knee = Math.PI - Math.acos(clamp(td.dot(sd), -1, 1)), abd = Math.atan2(Math.abs(td.x), Math.hypot(td.y, td.z));
      legs += ((hip - (R.legs?.hip ?? 1.66)) / 0.6) ** 2 + ((knee - (R.legs?.knee ?? 1.85)) / 0.6) ** 2 + (Math.max(0, abd - 0.12) / 0.25) ** 2; // (the riding position's own hip and knee angles, else a seated person's)
      if (hip < 0.7 || knee < 0.75) legs += 1e3; // (past the joints' range)
      let g = null; for (const L of R.around) { const r = loftGap(L, p[sh], 0.055); if (r && (!g || r.gap < g.gap)) g = r; }
      const gap = g ? g.gap : 0.3;
      knees += R.knees === 'grip' ? ((gap + 0.005) / 0.015) ** 2 : (Math.max(0, gap - 0.03) / 0.05) ** 2;
      fit[k] = { kneeAt: p[sh].toArray().map((x) => +x.toFixed(3)), gap: +gap.toFixed(3), halfWidth: g ? +g.w.toFixed(3) : null, hip: +(hip * 57.3).toFixed(0), knee: +(knee * 57.3).toFixed(0), abd: +(abd * 57.3).toFixed(0) };
    }
    parts.legs = legs; parts.knees = knees; c += legs + knees;
    // elbows bent, not locked straight (the arms steer; they don't prop the rider up), nor folded tight
    let elb = 0; for (const [u, f, h] of [[B.uArmR, B.fArmR, B.handR], [B.uArmL, B.fArmL, B.handL]]) { const a = p[f].clone().sub(p[u]).normalize(), b2 = p[h].clone().sub(p[f]).normalize(), bend = Math.acos(clamp(a.dot(b2), -1, 1)); elb += (Math.max(0, 0.6 - bend) / 0.2) ** 2 + (Math.max(0, bend - 1.6) / 0.3) ** 2; fit['elbow' + (u === B.uArmR ? 'R' : 'L')] = +(bend * 57.3).toFixed(0); }
    parts.elbows = elb; c += elb;
    const neck = v.fwd + v.flex * 0.5; // (the head is held level: the neck extends as the back goes down)
    parts.posture = ((v.fwd - (R.lean ?? 0.35)) / 0.2) ** 2 + ((v.flex - 0.3) / 0.3) ** 2 + (v.prot / 0.3) ** 2 + ((v.hz - (R.hz0 ?? 0)) / 0.06) ** 2 + (Math.max(0, neck - 0.9) / 0.3) ** 2; c += parts.posture;
    const hit = rideHitsCost(this.lastHits = this.rideHits()); parts.hit = hit; this.riderFit.hits = this.lastHits; c += hit;
    return c;
  }
  // The rider's posture on this vehicle: coordinate descent over v from several starts (upright to tucked, knees in
  // and out), the best two descended, the better kept; then how far a tuck may bend the back before the chest meets the
  // bodywork. Cached per person and vehicle geometry.
  solveRide() {
    const R = this.opts.ride, key = [this.kind, this.seed % PEOPLE.length, JSON.stringify(R), JSON.stringify(this.pegs)].join('|');
    if (RIDES.has(key)) { const r = RIDES.get(key); this.fwdTuck = r.fwdTuck; this.postureScore = r.score; this.riderFit = r.fit; return { ...r.v }; }
    const z0 = R.saddle[0].z, z1 = R.saddle.at(-1).z, hz0 = R.hz0 ?? 0;
    const VARS = [['hz', Math.max(z0 + 0.08, hz0 - 0.2), Math.min(z1 - 0.12, hz0 + 0.2), 0.04], ['fwd', 0, 1.35, 0.12], ['flex', 0, 0.9, 0.12], ['prot', 0, 0.35, 0.06], ['kOut', -0.3, 1.4, 0.15]];
    if (R.stance === 'attack') VARS.push(['hy', 0.04, 0.3, 0.04]); // (standing on the pegs: how far up off the saddle)
    this.solving = true;
    const cost = (vv) => { this.configureRide(vv); return this.rideCost(); };
    const descend = (v, best) => {
      for (let pass = 0; pass < 4; pass++) for (const [k, lo, hi, step0] of VARS) {
        const step = step0 / 2 ** pass;
        for (const dir of [1, -1]) for (let n = 0; n < 5; n++) {
          const t = { ...v, [k]: clamp(v[k] + dir * step, lo, hi) }; if (t[k] === v[k]) break;
          const c = cost(t); if (c < best - 1e-4) { best = c; v = t; } else break;
        }
      }
      return { v, c: best };
    };
    const starts = [];
    for (const fwd of [0.3, 0.7, 1.05, R.lean]) for (const kOut of [0.15, 0.6]) { const t = { hz: clamp(hz0, VARS[0][1], VARS[0][2]), fwd, flex: 0.3, prot: 0.1, kOut, ...(R.stance === 'attack' ? { hy: 0.14 } : {}) }; delete this.armSol; starts.push({ v: t, c: cost(t) }); }
    starts.sort((a, b) => a.c - b.c);
    let win = null;
    for (const s0 of starts.slice(0, 2)) { delete this.armSol; const r = descend(s0.v, cost(s0.v)); if (!win || r.c < win.c) win = r; }
    const v = win.v; delete this.armSol;
    // the tuck: as far as the outfit's (a road racer's further), short of the chest or head meeting the bodywork
    let fwdTuck = v.fwd; const gain = this.o.hump ? 0.42 : 0.22;
    for (let f = v.fwd + 0.03; f <= v.fwd + gain + 1e-6; f += 0.03) { this.configureRide({ ...v, fwd: f }); this.pose(this.state); const h = this.rideHits(); if (h.torso + h.head > 0.004) break; fwdTuck = f; }
    delete this.armSol; this.configureRide(v); this.postureScore = this.rideCost(); delete this.armSol;
    this.solving = false; this.fwdTuck = fwdTuck; this.riderFit.fwdTuck = +fwdTuck.toFixed(3);
    RIDES.set(key, { v: { ...v }, fwdTuck, score: this.postureScore, fit: this.riderFit });
    return { ...v };
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
      hands.L = s.hands?.[0] || this.rideGrips?.[0] || V(-0.2, 0.05, -0.42); hands.R = s.hands?.[1] || this.rideGrips?.[1] || V(0.2, 0.05, -0.42); axes.L = V(1, 0, 0); axes.R = V(-1, 0, 0); radii.L = radii.R = 0.016; // (thumbs inboard)
      feet.L = this.pegs[0].clone().lerp(V(this.pegs[0].x - 0.1, this.groundY + 0.06, this.pegs[0].z - 0.12), s.foot || 0); // a foot down when stopped
      feet.R = this.pegs[1].clone();
      return { hands, feet, axes, radii };
    } else {
      this.restHands = true; // resting on the thighs: placed on them once the legs are posed (pose)
    }
    // pedals: rudder pedals swing fore and aft; a car has a throttle pedal under the right foot
    const pz = (C.pedZ ?? -0.86) + (this.v?.pedZ || 0), py = (C.pedY ?? -0.34) + (this.v?.pedY || 0); // (pedals: the vehicle may say where, and how far they adjust)
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
    if (bars && this.opts.ride) this.rideFrame(s);
    else if (bars) { // a rider: bent forward over the tank (more when tucked at speed), leaning further into a turn than the bike
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
      const OB = armObstacles(this, S, k); // (the seat's obstacles within the arm's reach: walls, canopy, panel)
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
          const e = ELL[i0], e1 = ELL[i0 + 1], w2 = fy - i0, cx = e.cx + (e1.cx - e.cx) * w2, cz = e.cz + (e1.cz - e.cz) * w2, rx = e.rx + (e1.rx - e.rx) * w2 + rad + (this.o.bulk || 0), rz = e.rz + (e1.rz - e.rz) * w2 + rad + (this.o.bulk || 0); // (a suit's sleeve is as thick as its body)
          const q2 = Math.hypot((ap.x - cx) / rx, (ap.z - cz) / rz); if (q2 < 1) inside = Math.max(inside, (1 - q2) * Math.min(rx, rz)); }
        let cost = (sh / 0.8) ** 2 + (flex / 1.05) ** 2 + (dev / 0.35) ** 2 + (tau / 1.2) ** 2 + (hum / 1.0) ** 2 + miss * 1e4 + (inside / 0.01) ** 2 * 4;
        cost += armObstacleCost(OB, S, E, Wt);
        if (Math.abs(tau) > 1.75 || Math.abs(hum) > 1.6 || Math.abs(flex) > 1.4 || Math.abs(dev) > 0.6) cost += 1e3; // (past the joints' range)
        if (out) { out.W = Wt.clone(); out.Y = Yt.clone(); out.pole = pole.clone(); out.angles = { sh, hum, tau, flex, dev, cost, inside }; }

        return cost;
      };
      const prev = (this.armSol ||= {})[k];
      let best = { c: Infinity, th: 0, ph: 0 };
      const grid = (th0, ph0, span, n) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const th = th0 + span * (i / (n - 1) - 0.5) * 2, ph = ph0 + span * (j / (n - 1) - 0.5) * 2, cc = score(th, ph); if (cc < best.c) best = { c: cc, th, ph }; } };
      const prevC = prev ? score(prev.th, prev.ph) : Infinity;
      if (prev && prevC < 500) { best = { c: prevC, th: prev.th, ph: prev.ph }; grid(prev.th, prev.ph, 0.25, 9); } // (an answer from out of reach or past a joint's range is no place to refine from: search afresh)
      else { if (prev) grid(prev.th, prev.ph, 0.8, 13); if (!(best.c < 500)) { const f0 = OB?.from; if (OB) { OB.from = 1; OB.to = 2; } grid(0, 0, Math.PI, 49); if (OB) { OB.from = f0; OB.to = 3; best.c = score(best.th, best.ph); } } } // (first a wider look round the last answer: an arm kept off a wall can sit near a joint's limit; the full search tests only the elbow against obstacles)
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
    limb(this.hipR, feet.R, D.thigh, D.shin, bars && this.opts.ride ? this.rideKnee('R', feet.R) : kS, B.thighR, B.shinR, 1);
    limb(this.hipL, feet.L, D.thigh, D.shin, bars && this.opts.ride ? this.rideKnee('L', feet.L) : V(-kS.x, kS.y, kS.z), B.thighL, B.shinL, 1);
    // hands at rest lie on the thighs' top surface two thirds of the way to the knee, a hand on a gently curved surface
    // (a grip on a broad bar across the thigh, thumbs inboard)
    if (this.restHands) for (const [k, it] of [['R', B.thighR], ['L', B.thighL]]) {
      radii[k] = 0.2; axes[k] = V(k === 'R' ? -1 : 1, 0, 0);
      // a hand at rest lies on a surface: the palm on the thigh's top, two thirds of the way to the knee at most, at
      // the point where the wrist is a relaxed reach from the shoulder (85% of the arm), so the elbow stays bent
      const sh = k === 'R' ? this.shR : this.shL, G0 = this.hand.G(k, 0), n = V(0, 0, -1).applyQuaternion(q[it]), along = V(0, 1, 0).applyQuaternion(q[it]);
      const surf = (t) => V(0, t * D.thigh, -((D.thighTop ?? 0.075) + (this.o.bulk || 0) * 1.5)).applyQuaternion(q[it]).add(p[it]), wrist = (t) => surf(t).addScaledVector(along, -G0.y).addScaledVector(n, -G0.z);
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
  const BP = rig.body ? poseBody({ p: rig.p, q: rig.q, B, DIM: rig.D, grips: glovedGrips(rig), spine: rig.spine, body: rig.body, footFlat: rig.floorY != null }, { seat: rig.ctl === 'bars' ? { y: rig.rideSeatY ?? -0.08, back: null, over: rig.opts.ride ? (x, z) => { const sc = loftAt(rig.opts.ride.saddle, z); return !!sc && Math.abs(x - (sc.cx || 0)) < sc.hw; } : null } : rig.seatY != null ? { y: rig.seatY - 0.012, back: null } : { y: -0.09, back: 0.125 } }) : null;
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
  if (o.hump) { // leathers' aero hump: a fairing grown from the measured back, from just under the collar down the spine
    // (30 cm), tallest (7 cm) behind the helmet and tapering to a tail, its edges blending flush into the suit. Each grid
    // point is the back's surface (a ray backward from the torso's middle) pushed further back by the hump's height there.
    if (BP) {
      const S = torsoSurface(), sp = rig.spine, yTop = (sp ? sp.neck.y : D.shoulderUp + 0.05) - 0.05, LEN = 0.3, NS = 24, NX = 16, pos = [], idx = [];
      for (let j = 0; j <= NS; j++) {
        const s = j / NS, y = yTop - s * LEN, w = 0.092 * (1 - 0.55 * s), H = 0.075 * Math.sqrt(sstep(0, 0.18, s)) * (1 - s) ** 1.1;
        for (let i2 = 0; i2 <= NX; i2++) {
          const t = -1 + (2 * i2) / NX, x = t * w, b = S.onto(V(x, y, S.cz(y)), V(0, 0, 1), S.wear - 0.002) || V(x, y, S.cz(y) + 0.1);
          b.z += H * Math.max(0, 1 - t * t) ** 0.45; pos.push(b.x, b.y, b.z);
        }
      }
      for (let j = 0; j < NS; j++) for (let i2 = 0; i2 < NX; i2++) { const a = j * (NX + 1) + i2, b = a + 1, c = a + NX + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      { const n = V().fromBufferAttribute(g.attributes.normal, (NS >> 1) * (NX + 1) + (NX >> 1)); if (n.z < 0) flipWinding(g); } // (facing back, +Z)
      at(B.spine, g, o.suit, 'fabric'); // (the leathers' own finish)
    }
  }
  if (BP && o.vest) lifeJacket(o.vest);
  if (BP && o.bulk) spaceSuit(); // (a pressure suit, gloves, boots, neck ring and bubble helmet)
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
  // T-shirt with its ribbed collar and shorts, shoes and boots (in a pressure suit, spaceSuit makes the rest: only the shoe's upper is from here)
  if (BP) for (const g of GF.list) if (!o.bulk || g.name === 'shoe') bodyShell(g.F.map((F) => (i) => F[i]), g.off, g.hex, g.slot, { hem: g.hem, base: true, skinHem: !!g.skinHem });
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
    if (BP) { if (!o.bulk) shoe(s, o.boot, o.bigBoots ? 0.26 : o.tee ? 0 : 0.09); continue; }
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
  // helmets: a shell modelled on the head inside it. Its form is the union (a smooth max along rays from the head's
  // centre) of the cranium shell (helmetRadii) and, on full-face helmets, a chin bar round the measured jaw and chin:
  // 2.5 cm clear of the chin in front and below it, wider than the jaw by the liner (a motocross bar reaches further
  // forward and comes to a point, its mouthpiece vented). The neck opening is cut along a line in side view from the
  // nape (the base of the skull, 10.5 cm below the eyes) down to under the chin bar, so its edge sweeps down to the
  // front as on a real helmet; a jet helmet is cut higher and open in front. The eye port is centred on the measured
  // eyes; every opening is hemmed with a rolled rubber edge over a dark liner. Road / car helmets close the port with a
  // visor on side pivots; a motocross helmet takes goggles in a bigger port and a peak continuing the forehead.
  const HS = BP ? helmetRadii(HR) : [0.128, 0.136, 0.143];
  const eyeY = () => (eyesAt.length ? eyesAt.reduce((a, e) => a + e.c.y, 0) / eyesAt.length : hc.y + Math.sin(0.15) * HS[1]);
  const eyeZ = () => (eyesAt.length ? eyesAt.reduce((a, e) => a + e.c.z, 0) / eyesAt.length : hc.z - HS[2] * 0.7);
  const se = (x, a, p = 6) => Math.abs(x / a) ** p; // (superellipse terms: round-cornered openings)
  // the mesh head (head bone space): the face's depth at (x, y), the chin, the jaw's half-width
  const headPts = BP ? (() => { const hinv = R(B.head).invert(), a = []; for (let i = 0; i < BP.seg.length; i++) if (BP.seg[i] === 'head' && !BP.eye[i]) a.push(V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hinv)); return a; })() : [];
  const frontAt = (x, y, w = 0.008) => { let z = Infinity; for (const p of headPts) if (Math.abs(p.x - x) < w && Math.abs(p.y - y) < w && p.z < z) z = p.z; return Number.isFinite(z) ? z : hc.z - HR[2] * 0.95; };
  const chinPt = (() => { const mid = headPts.filter((p) => Math.abs(p.x - hc.x) < 0.012); if (!mid.length) return V(0, hc.y - 0.13, hc.z - 0.08);
    const zMin = Math.min(...mid.map((p) => p.z)); let c = null; for (const p of mid) if (p.z < zMin + 0.045 && p.y < hc.y - 0.04 && (!c || p.y < c.y)) c = p; return c ? c.clone() : V(0, hc.y - 0.13, hc.z - 0.08); })();
  const jawW = (() => { const y = chinPt.y + 0.05; let m = 0; for (const p of headPts) if (Math.abs(p.y - y) < 0.008 && p.z < hc.z) m = Math.max(m, Math.abs(p.x - hc.x)); return m || 0.055; })();
  const helmetForm = (kind) => {
    const full = kind === 'road' || kind === 'mx', ey = eyeY();
    const CE = kind === 'mx' ? V(0, chinPt.y + 0.03, chinPt.z + 0.03) : V(0, chinPt.y + 0.032, chinPt.z + 0.052), CR = kind === 'mx' ? [jawW + 0.006, 0.075, 0.1] : [jawW + 0.008, 0.072, 0.077];
    const dirOf = (u, v) => V(Math.cos(v) * Math.sin(u), Math.sin(v), -Math.cos(v) * Math.cos(u));
    const vChin = Math.atan2(chinPt.y + 0.025 - hc.y, hc.z - (CE.z - CR[2])); // (the chin bar's front at mouth height: the mouthpiece, its vents)
    const ridge = (u, v) => { const au = Math.abs(u); let d = 0.004 * gs(u, v - 1.25, 0.25, 0.25) + 0.006 * gs(au - Math.PI, v + 0.1, 0.8, 0.4); // crown ridge, rear spoiler
      if (kind === 'mx') d += 0.058 * Math.max(0, 1 - au / 0.5) ** 1.5 * gs(0, v - vChin + 0.05, 1, 0.3); // the mouthpiece: a wedge coming to a point in front (V-shaped seen from above)
      return d; };
    const rad = (u, v) => { const d = dirOf(u, v), r1 = rayOut(hc, d, hc, HS); return (full ? smax(r1, rayOut(hc, d, CE, CR), 0.03) : r1) + ridge(u, v); };
    const P = (u, v, off = 0) => hc.clone().addScaledVector(dirOf(u, v), rad(u, v) + (typeof off === 'function' ? off(u, v) : off));
    const uvOf = (p) => { const d = p.clone().sub(hc).normalize(); return [Math.atan2(d.x, -d.z), Math.asin(clamp(d.y, -1, 1))]; };
    const onto = (off) => (p) => P(...uvOf(p), off);
    const normal = (u, v) => { const e = 0.01, a = P(u + e, v).sub(P(u - e, v)), b = P(u, v + e).sub(P(u, v - e)); return b.cross(a).normalize(); };
    // the neck line: from the nape down to under the chin (a jet helmet's: over the jaw hinge to the cheek)
    const zb = hc.z + HS[2], yb = ey - 0.105, zf = full ? CE.z - CR[2] : eyeZ() + 0.02, yf = full ? CE.y - CR[1] + (kind === 'mx' ? 0.012 : 0.008) : ey - 0.075;
    const below = (p) => p.y < yb + (yf - yb) * clamp((p.z - zb) / (zf - zb), 0, 1);
    const ev = uvOf(V(0, ey, eyeZ()))[1];
    return { P, onto, normal, below, PV: ev, vChin, full };
  };
  // a surface over the shell (radial offset off: a number or (u, v) => metres), cut by hole(u, v); hemmed, optionally
  // lined (`liner` inside) with a rolled edge
  const shellPart = (F, off, hole, hex, slot, { liner = 0, rim = 0, rimHex = 0x15161a, w = 128, h = 96 } = {}) => {
    const g = gsurf((u, v) => F.P(u, v, off), { w, h, hole }), loops = hemEdges(g, F.onto(off), 24); at(B.head, g, hex, slot);
    if (liner) { const lo = (u, v) => (typeof off === 'function' ? off(u, v) : off) - liner, gi = gsurf((u, v) => F.P(u, v, lo), { w, h, hole }); hemEdges(gi, F.onto(lo), 24); at(B.head, flipWinding(gi), 0x26272a, 'fabric'); }
    if (rim) for (const L of loops) at(B.head, tubeLoop(L.map((p) => { const d = p.clone().sub(hc), l = d.length(); return hc.clone().addScaledVector(d, 1 - liner / 2 / l); }), rim), rimHex, 'rubber');
    return loops;
  };
  // Road (full-face) and motocross helmets, assembled from reference photographs: their side profiles traced in a frame
  // at the eyes (centimetres forward f and up u, for a face 11.5 cm from eye to chin; scaled to this face's). Both sit
  // low and level: the bottom edge 14.5 / 15 cm below the eyes all round, tucked in to the neck. A road helmet's chin bar
  // stands 3 to 4 cm ahead of the mouth, its face slanting back underneath, and a big visor runs from the forehead down
  // to the chin bar and back to its pivot 12 cm behind the eyes. A motocross chin bar reaches 13 cm ahead of the eyes,
  // its top rising to a pointed mouthpiece, under a tall goggle port and a wide peak level with the crown. The shell is a
  // stack of horizontal slices: back and sides from the head fit (helmetRadii, slightly boxy), the front from the traced
  // profile below the forehead and the head's forehead above, and every slice pushed out wherever the head inside it
  // (measured, row by row) would come closer than the liner (2 cm; 1.5 in front of the face behind a visor or goggles).
  const HREF = {
    road: { bottom: -14.5, top: 5, crown: 13.8, nChin: 2.2, chinTop: -4.5,
      front: [[-14.5, 1.6], [-13.6, 2.6], [-11.6, 4.7], [-8.1, 5.7], [-6, 5.8], [-4.3, 5.6], [0, 4.6], [3, 3.3], [5, 1.9]],
      port: [[-7.5, 3.8], [-2, 5.0], [3, 5.4], [14, 4.2], [14, -4.6], [4.5, -5.0], [-2, -4.6], [-7.5, -2.8]],
      visor: [[-12.8, 0.6], [-10.5, 3.6], [-6, 5.7], [2, 6.3], [16, 5.2], [16, -5.4], [4.5, -5.9], [-3, -5.5], [-9, -3.3], [-12.8, -1.2]], pivot: [-12.3, -0.2],
      vent: { x: 2.0, u: [-9.6, -8.3], f: 3.5 } },
    mx: { bottom: -15, top: 6.7, crown: 13.6, nChin: 1.35, chinTop: -3.2,
      front: [[-15, 9.5], [-14.6, 10.8], [-13.3, 11.9], [-10, 12.7], [-7.5, 12.2], [-5.4, 11.25], [-4.2, 9.8], [-3.6, 8.2], [-3.1, 4.5], [-2.6, 3.0], [0, 2.6], [4, 2.4], [6.7, 2.1]],
      port: null, goggle: { th: 1.22, uc: 0.6, hu: 6.0 }, // (the port: round-cornered, 70 degrees either side, 12 cm tall about the eyes)
      vent: { x: 1.5, u: [-9.4, -6.6], f: 10.0 },
      peak: { root: -7, tip: 10.5, rootU: 12.9, tipU: 11.4, half: [8.0, 9.5], thick: 0.6 } },
  };
  const lerpCurve = (pts, u) => { if (u <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (u <= pts[i][0]) { const [u0, f0] = pts[i - 1], [u1, f1] = pts[i]; return f0 + (f1 - f0) * (u - u0) / (u1 - u0); } return pts[pts.length - 1][1]; };
  const inPoly = (poly, f, u) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [fi, ui] = poly[i], [fj, uj] = poly[j]; if ((ui > u) !== (uj > u) && f < (fj - fi) * (u - ui) / (uj - ui) + fi) c = !c; } return c; };
  const refHelmet = (kind) => {
    const R0 = HREF[kind], ey = eyeY(), ez = eyeZ() - 0.011, fk = (ey - chinPt.y) / 0.115, cm = 0.01 * fk; // (ez: the front of the eyes)
    const yB = ey + R0.bottom * cm, yC = hc.y + HS[1];
    const uOf = (y) => (y - ey) / cm, fOf = (z) => (ez - z) / cm;
    // the head, row by row (4 mm): its half-width, back and front
    const rows = new Map(); for (const p of headPts) { const k2 = Math.round(p.y / 0.004), r = rows.get(k2) || { x: 0, zb: -1, zf: 1 }; r.x = Math.max(r.x, Math.abs(p.x - hc.x)); r.zb = Math.max(r.zb, p.z); r.zf = Math.min(r.zf, p.z); rows.set(k2, r); }
    const headRow = (y) => { let r = null; for (let d = -2; d <= 2; d++) { const q = rows.get(Math.round(y / 0.004) + d); if (q) r = r ? { x: Math.max(r.x, q.x), zb: Math.max(r.zb, q.zb), zf: Math.min(r.zf, q.zf) } : { ...q }; } return r; };
    const fh = headRow(ey + 0.04), HSf = fh ? hc.z - fh.zf + 0.022 : HS[2]; // (the dome's front: the forehead, not the nose)
    // the traced front moves forward as one wherever this face needs its port further out (a nose further forward than
    // the photograph's), so the chin bar keeps its reach ahead of the visor or goggles
    const shiftF = (() => { let m = 0; for (let u = R0.chinTop + 0.5; u <= R0.top; u += 0.25) { const y = ey + u * cm, hr = headRow(y); if (hr) m = Math.max(m, (ez - lerpCurve(R0.front, u) * cm) - (hr.zf - 0.015)); } return m; })();
    const rawSlice = (y) => {
      const u = uOf(y), k = y >= hc.y ? Math.sqrt(Math.max(0, 1 - ((y - hc.y) / HS[1]) ** 2)) : 1 - 0.1 * ((hc.y - y) / (hc.y - yB)) ** 2;
      let a = HS[0] * k, zb = hc.z + HS[2] * k, zf = hc.z - HSf * k;
      const zt = ez - lerpCurve(R0.front, u) * cm - shiftF, w = sstep(R0.top - 1.5, R0.top + 1.5, u); zf = Math.min(zt * (1 - w) + zf * w, hc.z);
      const hr = headRow(y), q = hr ? [hr.x + 0.02, hr.zb + 0.022 - hc.z, hc.z - hr.zf + (u > R0.chinTop ? 0.015 : 0.022)] : [0, 0, 0];
      return [a, zb - hc.z, hc.z - zf, ...q];
    };
    // tabulated down the height and smoothed (Gaussian, 13 mm): the head's rows first spread 1 cm either way so the
    // smoothed clearance still holds, then the shell takes the larger of its own shape and that clearance
    const NT = 240, TY = (i) => yB + (yC - yB) * (i / NT), raw = Array.from({ length: NT + 1 }, (_, i) => rawSlice(TY(i)));
    const smooth = (col, sig) => { const st = (yC - yB) / NT, K = Math.ceil((2.5 * sig) / st); return raw.map((_, i) => { let sw = 0, sv = 0; for (let d = -K; d <= K; d++) { const j = clamp(i + d, 0, NT), wgt = Math.exp(-0.5 * ((d * st) / sig) ** 2); sw += wgt; sv += wgt * col(j); } return sv / sw; }); };
    const spread = (c) => (j) => { const st = (yC - yB) / NT, K = Math.ceil(0.01 / st); let m = 0; for (let d = -K; d <= K; d++) m = Math.max(m, raw[clamp(j + d, 0, NT)][c]); return m; };
    const domeFrom = ey + (R0.top + 3) * cm; // (above the traced front the dome is already smooth, and smoothing would only point its crown)
    const tab = [0, 1, 2].map((c) => { const own = smooth((j) => raw[j][c], c === 2 ? 0.006 : 0.013), req = smooth(spread(c + 3), 0.013); return own.map((v2, i) => Math.max(TY(i) > domeFrom ? raw[i][c] : v2, req[i])); });
    const slice = (y) => {
      const x = clamp((y - yB) / (yC - yB), 0, 1) * NT, i = Math.min(NT - 1, Math.floor(x)), f2 = x - i, g = (c) => tab[c][i] + (tab[c][i + 1] - tab[c][i]) * f2;
      let a = g(0), db = g(1), df = g(2); if (y >= yC - 1e-6) { a = db = df = 0; }
      const tk = 0.012 * (1 - sstep(0, 0.018, y - yB)); a -= tk; db -= tk; df -= tk; // (tucked in to the neck at the bottom)
      const u = uOf(y); return { a: Math.max(a, 0), df: Math.max(df, 0), db: Math.max(db, 0), nF: R0.nChin + (2 - R0.nChin) * sstep(R0.chinTop, R0.chinTop + 1.5, u), nB: 2.3 };
    };
    const polar = (S, th) => { const c = Math.cos(th), sn = Math.sin(th), front = c > 0, d = front ? S.df : S.db, n = front ? S.nF : S.nB; return S.a > 1e-6 && d > 1e-6 ? 1 / ((Math.abs(sn) / S.a) ** n + (Math.abs(c) / d) ** n) ** (1 / n) : 0; };
    const inside = (p) => p.y >= yB && p.y < yC && Math.hypot(p.x - hc.x, p.z - hc.z) <= polar(slice(p.y), Math.atan2(p.x - hc.x, hc.z - p.z));
    const yAt = (v) => yB + (yC - yB) * Math.sin(((v + Math.PI / 2) / Math.PI) * Math.PI / 2); // (rows close together near the crown)
    const B0 = (u, v) => { const y = yAt(v), r = polar(slice(y), u); return V(hc.x + r * Math.sin(u), y, hc.z - r * Math.cos(u)); };
    const normal = (u, v) => { const e = 0.004, a = B0(u + e, v).sub(B0(u - e, v)), b = B0(u, Math.min(v + e, Math.PI / 2)).sub(B0(u, v - e)), n = b.cross(a); return n.lengthSq() > 1e-14 ? n.normalize() : V(0, 1, 0); };
    const P = (u, v, off = 0) => { const o2 = typeof off === 'function' ? off(u, v) : off, b = B0(u, v); return o2 ? b.addScaledVector(normal(u, v), o2) : b; };
    const uvOf = (p) => { const y = clamp(p.y, yB, yC); return [Math.atan2(p.x - hc.x, hc.z - p.z), Math.asin(clamp((y - yB) / (yC - yB), 0, 1)) * 2 - Math.PI / 2]; };
    const onto = (off) => (p) => { if (!off) return P(...uvOf(p)); let y0 = p.y, uv = null; // (an offset layer: find the base point under p, then step out along its normal)
      for (let it = 0; it < 3; it++) { uv = uvOf(V(p.x, y0, p.z)); y0 = p.y - normal(...uv).y * (typeof off === 'function' ? off(...uv) : off); } return P(...uv, off); };
    const fu = (p) => [fOf(p.z), uOf(p.y)];
    const surfAt = (f, u, sx) => { const y = ey + u * cm, v = Math.asin(clamp((y - yB) / (yC - yB), 0, 1)) * 2 - Math.PI / 2; let best = null; for (let i = 0; i <= 200; i++) { const uu = sx * (i / 200) * Math.PI, q = B0(uu, v), e = Math.abs(fOf(q.z) - f); if (!best || e < best[0]) best = [e, uu]; } return [best[1], v]; };
    return { P, onto, normal, fu, surfAt, inside, R0, cm, ey, ez, uOf, fOf, yC, yB, kind, shiftF };
  };
  // a thin plate from a point function Q(s, t) (s: 0..1 root to tip, t: -1..1 across) with thickness th(s, t), downward
  function plate(Q, th, ns = 16, nt = 24) {
    const pos = [], idx = [], W = nt + 1, L = (ns + 1) * W;
    for (const lay of [0, 1]) for (let i = 0; i <= ns; i++) for (let j = 0; j <= nt; j++) { const q = Q(i / ns, -1 + (2 * j) / nt); if (lay) q.y -= th(i / ns, -1 + (2 * j) / nt); pos.push(q.x, q.y, q.z); }
    const id = (lay, i, j) => lay * L + i * W + j;
    for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) { idx.push(id(0, i, j), id(0, i + 1, j), id(0, i, j + 1), id(0, i + 1, j), id(0, i + 1, j + 1), id(0, i, j + 1)); idx.push(id(1, i, j), id(1, i, j + 1), id(1, i + 1, j), id(1, i + 1, j), id(1, i, j + 1), id(1, i + 1, j + 1)); }
    const side = (a, b) => { idx.push(id(0, ...a), id(1, ...a), id(0, ...b), id(1, ...a), id(1, ...b), id(0, ...b)); };
    for (let i = 0; i < ns; i++) { side([i + 1, 0], [i, 0]); side([i, nt], [i + 1, nt]); }
    for (let j = 0; j < nt; j++) { side([0, j], [0, j + 1]); side([ns, j + 1], [ns, j]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  const buildRefHelmet = (kind) => {
    const F = refHelmet(kind), R0 = F.R0, LINER = 0.012, at0 = (u, v) => F.fu(F.P(u, v));
    const G = R0.goggle, fPort = 4.6 + F.shiftF / F.cm, inGog = (u, v, k2 = 1) => { const [f, uu] = F.fu(F.P(u, v)); return f < fPort && se(u, G.th * k2, 6) + se(uu - G.uc, G.hu * k2, 6) < 1; }; // (behind the chin bar)
    const loops = shellPart(F, 0, (u, v) => (R0.port ? inPoly(R0.port, ...at0(u, v)) : inGog(u, v)), o.helmet, 'paint', { liner: LINER, rim: 0.0075, w: 144, h: 112 }); // shell
    // the stripe: a band of constant width from above the port over the crown and down the back
    shellPart(F, 0.0015, (u, v) => { const p = F.P(u, v), [f, uu] = F.fu(p); return Math.abs(p.x - hc.x) > 0.012 || uu < (f > -4 ? R0.top + 1.8 : -2); }, o.helmet2, 'paint', { w: 192 });
    const vent = R0.vent; shellPart(F, 0.0015, (u, v) => { const p = F.P(u, v), [f, uu] = F.fu(p); return !(Math.abs(p.x - hc.x) < vent.x * F.cm && uu > vent.u[0] && uu < vent.u[1] && f > vent.f); }, 0x15161a, 'rubber', { w: 192, h: 160 }); // chin vent
    if (kind === 'road') {
      shellPart(F, 0.007, (u, v) => { const [f, uu] = at0(u, v); return !inPoly(R0.visor, f, uu); }, o.visor, 'glass', { rim: 0.0025, w: 144, h: 112 }); // visor
      for (const sx of [-1, 1]) { const [uu, vv] = F.surfAt(R0.pivot[0], R0.pivot[1], sx), pp = F.P(uu, vv, 0.004);
        at(B.head, new THREE.CylinderGeometry(0.016, 0.016, 0.008, 24).applyQuaternion(basis(F.normal(uu, vv))).translate(pp.x, pp.y, pp.z), 0x2a2c30, 'rubber'); } // visor pivots
    } else {
      // goggles: a deep foam frame along the port's edge (standing 1.2 cm off the shell), the lens a smooth sheet across
      // the frame (ruled between its top and bottom runs, bowed out 8 mm), the strap from its sides round the back
      const port = loops.map((L) => ({ L, m: L.reduce((a2, q) => a2.add(q), V()).multiplyScalar(1 / L.length) })).filter(({ m }) => F.uOf(m.y) > R0.bottom + 3).map(({ L }) => L)[0];
      if (port) {
        const out = (q, d) => q.clone().add(q.clone().sub(hc).setY(0).normalize().multiplyScalar(d)), frame = port.map((q) => out(q, 0.012));
        at(B.head, tubeLoop(frame, 0.011, 10), 0x15161a, 'rubber');
        const th = (q) => Math.atan2(q.x - hc.x, hc.z - q.z), yc = frame.reduce((a2, q) => a2 + q.y, 0) / frame.length;
        const run = (top) => frame.filter((q) => (q.y > yc) === top).map((q) => [th(q), q]).sort((a2, b2) => a2[0] - b2[0]);
        const T = run(true), Bm = run(false), at2 = (R, t) => { if (t <= R[0][0]) return R[0][1]; for (let i = 1; i < R.length; i++) if (t <= R[i][0]) { const [t0, q0] = R[i - 1], [t1, q1] = R[i]; return q0.clone().lerp(q1, (t - t0) / (t1 - t0 || 1)); } return R[R.length - 1][1]; };
        const t0 = Math.max(T[0][0], Bm[0][0]), t1 = Math.min(T[T.length - 1][0], Bm[Bm.length - 1][0]), NU = 40, NV = 12, pos = [], idx = [];
        for (let i = 0; i <= NU; i++) { const t = t0 + (t1 - t0) * (i / NU), a2 = at2(T, t), b2 = at2(Bm, t); for (let j = 0; j <= NV; j++) { const s2 = j / NV, q = out(a2.clone().lerp(b2, s2), 0.006 + 0.008 * Math.sin(Math.PI * s2) * Math.sin(Math.PI * (i / NU))); pos.push(q.x, q.y, q.z); } }
        for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a2 = i * (NV + 1) + j, b2 = a2 + NV + 1; idx.push(a2, a2 + 1, b2, b2, a2 + 1, b2 + 1); }
        const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setIndex(idx); lg.computeVertexNormals();
        { const n = V().fromBufferAttribute(lg.attributes.normal, (NU >> 1) * (NV + 1) + (NV >> 1)); if (n.z > 0) flipWinding(lg); } at(B.head, lg, o.visor, 'glass'); // lens (facing forward)
      }
      shellPart(F, 0.005, (u, v) => { const uu = F.fu(F.P(u, v))[1]; return !(uu > G.uc - 2 && uu < G.uc + 2 && Math.abs(u) > G.th * 0.98); }, 0x15161a, 'fabric', { w: 128, h: 112 }); // strap
      // the peak, as in the photograph: a plate along a straight line from the crown (7 cm behind the eyes, its root buried
      // in the dome so it grows out of the forehead) falling a little to the tip (10.5 cm ahead), curved 1.6 cm across and
      // widening toward the tip; under it a wedge fills down to the shell (up to 3 cm deep in the middle, 6 mm at the edges)
      const pk = R0.peak, uScale = F.uOf(F.yC) / R0.crown, cm = F.cm;
      const topAt = (x, z) => { let lo = hc.y - 0.05, hi = F.yC; if (!F.inside(V(x, lo, z))) return -Infinity; for (let it = 0; it < 24; it++) { const y = (lo + hi) / 2; if (F.inside(V(x, y, z))) lo = y; else hi = y; } return lo; };
      const at3 = (s2, t) => { const f = pk.root + (pk.tip - pk.root) * s2 - 2.2 * t * t * s2; return [hc.x + t * (pk.half[0] + (pk.half[1] - pk.half[0]) * s2) * cm, F.ez - f * cm]; };
      const Q = (s2, t) => { const [x, z] = at3(s2, t); return V(x, F.ey + (pk.rootU + (pk.tipU - pk.rootU) * s2) * uScale * cm - 1.6 * t * t * cm, z); };
      const TH = (s2, t) => { const [x, z] = at3(s2, t), sh = topAt(x, z); if (!Number.isFinite(sh)) return pk.thick * cm; const deep = (pk.thick + (3 - pk.thick) * (1 - t * t)) * cm; return clamp(Q(s2, t).y - (sh - 0.004), pk.thick * cm, deep); };
      at(B.head, plate(Q, TH, 24, 28), o.helmet2, 'paint');
    }
  };
  // A model helmet (helmetParts) on this head, scaled evenly (its own proportions kept) to the head's width plus the
  // liner (helmetRadii) and the model's own allowance (MODEL_FIT: the racing helmet's interior is 0.42 of its width
  // either side, so 1 cm; a model that is solid inside can instead be stretched per axis to hide the head), its eye
  // point on the measured eyes, then moved forward if its visor or chin bar would touch the nose or chin. Parts take the outfit's colours by role (shell: helmet, accent: helmet2, visor: visor),
  // the rest keep the model's.
  const MODEL_FIT = { road: { pad: 0.01 }, mx: { pad: 0.01, mouth: true } };
  const modelHelmet = (name) => {
    const parts = helmetParts(name), H = HELMETS.meta[name], E = V(...H.eye), fit = MODEL_FIT[name] || { pad: 0.01 }; if (!parts) return false;
    const eyeAt = V(0, eyeY(), eyeZ()), w = 2 * HS[0] + fit.pad, S = V(w, w, w);
    if (fit.perAxis) { // (a solid model: stretched so its dome clears the top of the head by 3 cm and the back by 2.6)
      let top = -Infinity, back = -Infinity, low = Infinity, hTop = -Infinity, hBack = -Infinity, hLow = Infinity;
      for (const p of parts) if (p.role === 'shell') { const P = p.g.attributes.position; for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (Math.abs(x) < 0.12 && z > E.z + 0.1 && z < E.z + 0.45) top = Math.max(top, y); if (Math.abs(x) < 0.12 && Math.abs(y - E.y) < 0.15) back = Math.max(back, z); if (z > E.z + 0.25) low = Math.min(low, y); } }
      for (const q of headPts) { hTop = Math.max(hTop, q.y); hBack = Math.max(hBack, q.z); if (q.z > hc.z) hLow = Math.min(hLow, q.y); }
      S.y = Math.max(w * 0.9, (hTop + 0.03 - eyeAt.y) / (top - E.y), (eyeAt.y - (hLow - 0.01)) / (E.y - low)); S.z = Math.max(w * 0.9, (hBack + 0.026 - eyeAt.z) / (back - E.z)); // (and its back edge down past the bottom of the skull)
    }
    let f = (q) => q.clone().sub(E).multiply(S).add(eyeAt);
    // the visor / lens and chin bar clear the face: moved forward until the nose tip and the chin are 1.5 cm behind them
    const noseY = eyeY() - 0.04, nose = V(0, noseY, frontAt(0, noseY)), chin = chinPt.clone(); let shift = 0;
    for (const p of parts) if (p.role === 'visor' || p.role === 'shell') { const P = p.g.attributes.position; for (let i = 0; i < P.count; i++) { const q = f(V().fromBufferAttribute(P, i)); if (Math.abs(q.x) > 0.02) continue;
      for (const fp of p.role === 'visor' ? [nose] : [chin]) if (Math.abs(q.y - fp.y) < 0.012 && q.z > fp.z - 0.05) shift = Math.max(shift, q.z - (fp.z - 0.015)); } }
    if (shift > 0) { const f0 = f; f = (q) => f0(q).add(V(0, 0, -Math.min(shift, 0.03))); }
    const hexOf = { shell: o.helmet, accent: o.helmet2, visor: o.visor };
    if (fit.mouth) { // the mouthpiece's filter foam: dark, between the mouth and an open-vented chin bar
      const my = eyeY() - 0.072 * ((eyeY() - chinPt.y) / 0.115), mz = frontAt(0, my) - 0.014;
      at(B.head, ellipsoid(V(0, my, mz), 0.042, 0.032, 0.012, { w: 24, h: 12 }), 0x161618, 'rubber');
    }
    for (const p of parts) {
      const P = p.g.attributes.position; for (let i = 0; i < P.count; i++) { const q = f(V().fromBufferAttribute(P, i)); P.setXYZ(i, q.x, q.y, q.z); } p.g.computeVertexNormals();
      if (hexOf[p.role] == null) p.g.userData.keepColor = true;
      at(B.head, p.g, hexOf[p.role] ?? 0xffffff, p.slot);
    }
    return true;
  };
  if (BP && o.bulk) spaceHelmet(); else if (BP && o.head === 'fullface') { face(false); if (!(HELMETS && modelHelmet(o.peak ? 'mx' : 'road'))) buildRefHelmet(o.peak ? 'mx' : 'road'); } else if (o.head === 'helmet' || o.head === 'fullface' || o.head === 'bubble') {
    const big = o.head === 'bubble' ? 1.18 : 1, kind = o.head === 'bubble' ? 'bubble' : o.peak ? 'mx' : o.head === 'fullface' ? 'road' : 'jet';
    if (kind !== 'bubble') face(false);
    const F = kind === 'bubble' ? null : helmetForm(kind), PV = F ? F.PV : 0.15, LINER = 0.012;
    const onShell = (u, v) => F.P(u, v); // (the bare shell's point: holes are decided there, so every layer cuts alike)
    if (kind === 'bubble') at(B.head, ellipsoid(hc, 0.128 * big, 0.135 * big, 0.142 * big, { w: 48, h: 32, th: [0, Math.PI * 0.66] }), o.helmet, 'paint');
    else {
      const port = kind === 'jet' ? (u, v) => se(u, 0.98) + se(Math.max(0, v - PV), 0.2) < 1 && v > PV - 1.1
        : kind === 'mx' ? (u, v) => se(u, 0.86) + se(v - PV + 0.02, 0.22) < 1 : (u, v) => se(u, 0.8) + se(v - PV - 0.01, 0.185) < 1;
      shellPart(F, 0, (u, v) => port(u, v) || F.below(onShell(u, v)), o.helmet, 'paint', { liner: LINER, rim: 0.0075 });
      // the stripe: a band of constant width (not angle) from above the port over the crown and down the back, 1.5 mm out
      shellPart(F, 0.0015, (u, v) => Math.abs(onShell(u, v).x - hc.x) > 0.012 || v < (Math.cos(u) > 0 ? PV + 0.32 : -0.15), o.helmet2, 'paint', { w: 192 });
    }
    if (kind === 'mx') {
      const ring = []; for (let k2 = 0; k2 < 56; k2++) { const t = (k2 / 56) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t); ring.push(F.P(Math.sign(c) * Math.abs(c) ** (1 / 3) * 0.88, PV - 0.02 + Math.sign(sn) * Math.abs(sn) ** (1 / 3) * 0.23, 0.007)); }
      at(B.head, tubeLoop(ring, 0.011, 10), 0x15161a, 'rubber'); // goggle frame, round the port's edge
      shellPart(F, 0.013, (u, v) => se(u, 0.87, 4) + se(v - PV + 0.02, 0.22, 4) > 1, o.visor, 'glass', { w: 96, h: 72 }); // lens
      shellPart(F, 0.004, (u, v) => !(v > PV - 0.07 && v < PV + 0.07 && Math.abs(u) > 0.86), 0x15161a, 'fabric', { w: 96 }); // strap
      shellPart(F, 0.0015, (u, v) => se(u, 0.15, 6) + se(v - F.vChin + 0.02, 0.032, 4) > 1, 0x15161a, 'rubber', { w: 192, h: 192 }); // mouthpiece vent (a slot across the point)
      // the peak: wide at the forehead and wrapped round it, continuing the forehead's line forward and up
      const pk = new THREE.Shape(); pk.moveTo(-0.1, 0); pk.quadraticCurveTo(-0.11, 0.07, -0.07, 0.125); pk.lineTo(-0.02, 0.135); pk.lineTo(0, 0.128); pk.lineTo(0.02, 0.135); pk.lineTo(0.07, 0.125); pk.quadraticCurveTo(0.11, 0.07, 0.1, 0); pk.closePath();
      const pg = new THREE.ExtrudeGeometry(pk, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 16 });
      pg.rotateX(-Math.PI / 2); // shape +Y -> forward (-Z)
      { const pp = pg.attributes.position; for (let k2 = 0; k2 < pp.count; k2++) { const x = pp.getX(k2), zf = -pp.getZ(k2); pp.setZ(k2, pp.getZ(k2) + x * x / (2 * HS[0]) * (1 - zf / 0.2)); pp.setY(k2, pp.getY(k2) - 0.4 * x * x); } pg.computeVertexNormals(); } // wrapped round the forehead at its root
      pg.rotateX(0.3); // tipped up
      const anchor = F.P(0, PV + 0.27, 0); pg.translate(anchor.x, anchor.y, anchor.z + 0.01); at(B.head, pg, o.helmet2, 'paint');
      for (const sx of [-1, 1]) { const uu = sx * 0.7, vv = PV + 0.3, sp = F.P(uu, vv, 0.003); at(B.head, new THREE.CylinderGeometry(0.006, 0.006, 0.004, 12).applyQuaternion(basis(F.normal(uu, vv))).translate(sp.x, sp.y, sp.z), 0x9aa0a6, 'metal'); } // its screws
    } else if (kind === 'road' || kind === 'jet') {
      const ua = kind === 'jet' ? 1.04 : 0.94, vc = kind === 'jet' ? PV - 0.04 : PV + 0.02, vb = kind === 'jet' ? 0.27 : 0.22, VO = 0.007;
      shellPart(F, VO, (u, v) => se(u, ua, 4) + se(v - vc, vb, 4) > 1, o.visor, 'glass', { rim: 0.0025 }); // visor
      for (const sx of [-1, 1]) { const uu = sx * (ua + 0.05), pp = F.P(uu, vc + 0.03, 0.002);
        at(B.head, new THREE.CylinderGeometry(0.014, 0.014, 0.007, 20).applyQuaternion(basis(F.normal(uu, vc + 0.03))).translate(pp.x, pp.y, pp.z), 0x2a2c30, 'rubber'); } // visor pivots, on the shell
      if (F.full) shellPart(F, 0.0015, (u, v) => se(u, 0.14, 4) + se(v - F.vChin, 0.04, 4) > 1, 0x15161a, 'rubber', { w: 192, h: 144 }); // chin vent
    } else { // spacesuit: big gold visor
      const vis = frontPatch(0.148 * big, 1.05, Math.PI * 0.3, Math.PI * 0.72, 36, 16); vis.translate(hc.x, hc.y, hc.z); at(B.head, vis, o.visor, 'glass');
    }
    const fk = HR[1] / 0.111, ey = eyeY(); // (face proportions scale with the head)
    if (o.mask) { // oxygen mask over nose and mouth: a rubber cup from the cheeks out past the nose tip, a valve, a hose to the chest, straps to the helmet
      const ym = ey - 0.06 * fk, zN = frontAt(0, ey - 0.045 * fk), zC = frontAt(0.035 * fk, ym, 0.01), rz = zC - zN + 0.016, cc = V(0, ym, zC);
      at(B.head, ellipsoid(cc, 0.04 * fk, 0.052 * fk, rz, { w: 32, h: 20, phi: [Math.PI, Math.PI] }), 0x4c5047, 'paint'); // the cup (front half of an ellipsoid)
      at(B.head, tubeLoop(Array.from({ length: 40 }, (_, k2) => { const t = (k2 / 40) * Math.PI * 2; return V(Math.cos(t) * 0.04 * fk, ym + Math.sin(t) * 0.052 * fk, zC + 0.002); }), 0.004), 0x2a2c2e, 'rubber'); // its seal
      const valve = V(0, ym - 0.012 * fk, zC - rz + 0.004); at(B.head, new THREE.CylinderGeometry(0.014, 0.016, 0.016, 20).rotateX(Math.PI / 2).translate(valve.x, valve.y, valve.z - 0.004), 0x2a2c2e, 'rubber');
      at(B.head, capAB(valve.clone().add(V(0.004, -0.008, 0)), V(0.05, hc.y - 0.2, hc.z - 0.1), 0.012, 0.013), 0x2a2c2e, 'rubber'); // hose
      for (const sx of [-1, 1]) { const ha = V(sx * 0.038 * fk, ym + 0.01, zC + 0.004), hb = F.P(sx * 1.15, PV - 0.32, -0.004); at(B.head, capAB(ha, hb, 0.004, 0.004, { seg: 8 }), 0x2a2c2e, 'rubber');
        at(B.head, ellipsoid(hb, 0.011, 0.011, 0.011), 0x9aa0a6, 'metal'); } // straps, bayonet fittings
    }
    if (o.mic) { // boom mic from inside the helmet's cheek to just off the corner of the mouth
      const mouth = V(0.022 * fk, ey - 0.075 * fk, 0), base = F.P(1.25, PV - 0.38, -LINER * 0.6); mouth.z = frontAt(mouth.x, mouth.y) - 0.012;
      at(B.head, capAB(base, mouth, 0.004, 0.004, { seg: 10 }), 0x15161a, 'rubber'); at(B.head, ellipsoid(mouth, 0.008, 0.007, 0.009), 0x15161a, 'rubber');
    }
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
  // ---- the astronaut (outfit.bulk): a pressure suit, gloves and boots made for the body they're on, a neck ring and a
  // clear bubble helmet sized from the measured head ----
  // A garment that stands well off the body (an inflated suit, a glove): like bodyShell (a region of the body's
  // triangles, clipped clean along field's zero line, keeping the body's skin weights), but the stand-off varies over
  // the body (off(i), metres, per body vertex) and the shell is relaxed after it's pushed out, so it bridges the body's
  // hollows like a pressurised layer instead of showing them. subdiv splits each triangle in four (fine surface
  // detail); detail(src, along, p) then adds metres along the relaxed shell's normals (folds, bellows); seatY squashes
  // what hangs below the cushion onto it.
  function growShell(field, off, hex, slot, { smooth = 0, subdiv = 0, detail = null, seatY = null, back = null, fill = null } = {}) {
    const n = BP.pos.length / 3, F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = BP.eye[i] ? -1 : field(i);
    const P = [], NN = [], SK = [], OF = [], SRC = [], AL = [], vmap = new Map(), emap = new Map();
    const bp = (i) => V(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]), bn = (i) => V(BP.nrm[i * 3], BP.nrm[i * 3 + 1], BP.nrm[i * 3 + 2]);
    const skinOf = (i) => { const m = new Map(); for (let q = 0; q < 4; q++) { const w = BP.skinWeight[i * 4 + q]; if (w > 0) m.set(BP.skinIndex[i * 4 + q], (m.get(BP.skinIndex[i * 4 + q]) || 0) + w); } return m; };
    const mixS = (a, b, t) => { const m = new Map(); for (const [k2, w] of a) m.set(k2, w * (1 - t)); for (const [k2, w] of b) m.set(k2, (m.get(k2) || 0) + w * t); return m; };
    const add = (p, nn, sk, of, src, al) => { P.push(p); NN.push(nn); SK.push(sk); OF.push(of); SRC.push(src); AL.push(al); return P.length - 1; };
    const orig = (i) => { if (!vmap.has(i)) vmap.set(i, add(bp(i), bn(i), skinOf(i), off(i), i, BP.along[i])); return vmap.get(i); };
    const cut = (a, b) => { const key = a < b ? a * 65536 + b : b * 65536 + a; if (emap.has(key)) return emap.get(key); const t = F[a] / (F[a] - F[b]);
      const id = add(bp(a).lerp(bp(b), t), bn(a).lerp(bn(b), t).normalize(), mixS(skinOf(a), skinOf(b), t), off(a) * (1 - t) + off(b) * t, F[a] >= 0 ? a : b, BP.along[a] * (1 - t) + BP.along[b] * t); emap.set(key, id); return id; };
    let ix = [];
    for (let f = 0; f < BP.index.length; f += 3) {
      const tri = [BP.index[f], BP.index[f + 1], BP.index[f + 2]], nIn = tri.filter((i) => F[i] >= 0).length; if (!nIn) continue;
      if (nIn === 3) { ix.push(orig(tri[0]), orig(tri[1]), orig(tri[2])); continue; }
      const poly = []; for (let e = 0; e < 3; e++) { const a = tri[e], b = tri[(e + 1) % 3]; if (F[a] >= 0) poly.push(orig(a)); if ((F[a] >= 0) !== (F[b] >= 0)) poly.push(cut(a, b)); }
      for (let q = 1; q < poly.length - 1; q++) ix.push(poly[0], poly[q], poly[q + 1]);
    }
    if (!ix.length) return null;
    // relax: each vertex (not on an open edge) towards its neighbours' mean and back a little past where it was, its
    // times (Taubin's smoothing: it evens out bumps without shrinking the whole the way plain averaging does)
    const relax = (Q, ix, its) => { const nv = Q.length / 3, rim = new Uint8Array(nv), ec = new Map(), nb = Array.from({ length: nv }, () => new Set());
      for (let f = 0; f < ix.length; f += 3) for (let e = 0; e < 3; e++) { const a = ix[f + e], b = ix[f + (e + 1) % 3], key = a < b ? a * 1e6 + b : b * 1e6 + a; ec.set(key, (ec.get(key) || 0) + 1); nb[a].add(b); nb[b].add(a); }
      for (const [key, c] of ec) if (c === 1) { rim[Math.floor(key / 1e6)] = 1; rim[key % 1e6] = 1; }
      for (let it = 0; it < its * 2; it++) { const T = Q.slice(), lam = it % 2 ? -0.63 : 0.6; for (let v = 0; v < nv; v++) { if (rim[v] || !nb[v].size) continue; let x = 0, y = 0, z = 0; for (const u of nb[v]) { x += T[u * 3]; y += T[u * 3 + 1]; z += T[u * 3 + 2]; } const m = nb[v].size; Q[v * 3] += (x / m - T[v * 3]) * lam; Q[v * 3 + 1] += (y / m - T[v * 3 + 1]) * lam; Q[v * 3 + 2] += (z / m - T[v * 3 + 2]) * lam; } } };
    { // pushed out and relaxed at the body's own resolution (so the relaxing reaches across the body's forms), then split
      const n0 = P.length, Q0 = new Float32Array(n0 * 3); for (let v = 0; v < n0; v++) { const p = P[v].clone().addScaledVector(NN[v], OF[v]); Q0[v * 3] = p.x; Q0[v * 3 + 1] = p.y; Q0[v * 3 + 2] = p.z; }
      relax(Q0, ix, smooth); for (let v = 0; v < n0; v++) { P[v].set(Q0[v * 3], Q0[v * 3 + 1], Q0[v * 3 + 2]); OF[v] = 0; }
      if (fill) { fill(P, SRC); for (let v = 0; v < n0; v++) { Q0[v * 3] = P[v].x; Q0[v * 3 + 1] = P[v].y; Q0[v * 3 + 2] = P[v].z; } relax(Q0, ix, 4); for (let v = 0; v < n0; v++) P[v].set(Q0[v * 3], Q0[v * 3 + 1], Q0[v * 3 + 2]); } } // (fill: filling hollows, then relaxed again)
    for (let sd = 0; sd < subdiv; sd++) { // each triangle into four, through its edges' midpoints
      const mid = new Map(), m = (a, b) => { const key = a < b ? a * 1e6 + b : b * 1e6 + a; if (!mid.has(key)) mid.set(key, add(P[a].clone().lerp(P[b], 0.5), NN[a].clone().add(NN[b]).normalize(), mixS(SK[a], SK[b], 0.5), 0, SRC[a], (AL[a] + AL[b]) / 2)); return mid.get(key); };
      const out = []; for (let f = 0; f < ix.length; f += 3) { const [a, b, c] = [ix[f], ix[f + 1], ix[f + 2]], ab = m(a, b), bc = m(b, c), ca = m(c, a); out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); } ix = out;
    }
    const nv = P.length, Q = new Float32Array(nv * 3); for (let v = 0; v < nv; v++) { Q[v * 3] = P[v].x; Q[v * 3 + 1] = P[v].y; Q[v * 3 + 2] = P[v].z; }
    if (subdiv) relax(Q, ix, 2 * subdiv); // (rounds off the split facets)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Q, 3)); g.setIndex(ix);
    if (detail) { g.computeVertexNormals(); const nr = g.attributes.normal, p = V(); for (let v = 0; v < nv; v++) { p.set(Q[v * 3], Q[v * 3 + 1], Q[v * 3 + 2]); const d = detail(SRC[v], AL[v], p); Q[v * 3] += nr.getX(v) * d; Q[v * 3 + 1] += nr.getY(v) * d; Q[v * 3 + 2] += nr.getZ(v) * d; } }
    if (back) for (let v = 0; v < nv; v++) { // (back: a seat back's surfaces, rig space: the torso behind it squashes onto it)
      const y = Q[v * 3 + 1], sg = seg(SRC[v]); if ((sg !== 'spine' && sg !== 'hips') || y < back.panTop + 0.03 || y > back.backTop) continue; const zb = back.backZ + Math.tan(back.tilt) * (y - back.panTop) - 0.003;
      if (Q[v * 3 + 2] > zb) Q[v * 3 + 2] = zb + (Q[v * 3 + 2] - zb) * 0.1; }
    if (seatY != null) for (let v = 0; v < nv; v++) { const sg = seg(SRC[v]); if ((sg === 'hips' || sg.startsWith('thigh')) && Q[v * 3 + 1] < seatY) Q[v * 3 + 1] = seatY - (seatY - Q[v * 3 + 1]) * 0.15; }
    const C = new Float32Array(nv * 3), SI = new Uint16Array(nv * 4), SW = new Float32Array(nv * 4), c3 = new THREE.Color(hex);
    for (let v = 0; v < nv; v++) { C[v * 3] = c3.r; C[v * 3 + 1] = c3.g; C[v * 3 + 2] = c3.b; const ent = [...SK[v]].sort((a, b) => b[1] - a[1]).slice(0, 4), tot = ent.reduce((s2, e) => s2 + e[1], 0) || 1; ent.forEach(([bn2, w], q) => { SI[v * 4 + q] = bn2; SW[v * 4 + q] = w / tot; }); }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
    g.computeVertexNormals(); k.add(g, 0, B.spine, slot);
    return { g, Q, SRC, AL };
  }
  // a body region's cross-section at height y along a bone (bone-local: its centre and half-widths across and deep)
  function section(bone, sg, y, band = 0.012) {
    const inv = R(bone).invert(), v = V(); let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < BP.seg.length; i++) { if (BP.seg[i] !== sg) continue; v.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(inv); if (Math.abs(v.y - y) > band) continue; x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
    return Number.isFinite(x0) ? { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2 } : null;
  }
  // a closed tube round an ellipse (bone-local, square to the bone at height y)
  function ellipseTube(s, y, rad, n = 40) { return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: n }, (_, k2) => { const a = (k2 / n) * Math.PI * 2; return V(s.cx + Math.cos(a) * s.rx, y, s.cz + Math.sin(a) * s.rz); }), true), n * 2, rad, 10, true); }
  // Where the neck ring and the bubble go, from the measured head (spine-local: the bubble is fixed to the suit's neck
  // ring and the head turns inside it). The ring is centred on the neck joint, square to the line from there to the
  // middle of the head; the bubble is a sphere centred on that line, the smallest that clears the head by 2.2 cm in
  // every turn the rig gives it (looking round 0.6 rad either way, nodding with the stick), its bottom cut where it
  // meets the ring. The ring is at least wide enough to clear the suit round the neck.
  function bubbleFit() {
    if (bubbleFit.v) return bubbleFit.v;
    const sInv = R(B.spine).invert(), hInv = R(B.head).invert(), hp = [], pts = [], v = V(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i < BP.seg.length; i += 2) if (BP.seg[i] === 'head') { v.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(hInv); if (v.y > 0.03) hp.push(v.clone()); }
    for (const look of [-0.6, -0.3, 0, 0.3, 0.6]) for (const pitch of [-1, 0, 1]) { q.setFromEuler(e.set(-0.08 + pitch * 0.05, look, look * 0.15, 'YXZ')); for (const p of hp) pts.push(p.clone().applyQuaternion(q).add(rig.p[B.head]).applyMatrix4(sInv)); }
    const Rc = rig.spine ? rig.spine.neck.clone() : V(0, D.spine, 0), A = pts.reduce((a, p) => a.add(p), V()).multiplyScalar(1 / pts.length).sub(Rc).normalize();
    let best = null;
    for (let t = 0; t <= 0.3; t += 0.004) { const Cc = Rc.clone().addScaledVector(A, t); let m = 0; for (const p of pts) m = Math.max(m, p.distanceToSquared(Cc)); const Rb = Math.sqrt(m) + 0.022; if (Rb > t + 0.04 && (!best || Rb < best.Rb)) best = { t, Rb }; }
    let nr = 0; for (let i = 0; i < BP.seg.length; i++) { const sg = BP.seg[i]; if (sg !== 'spine' && sg !== 'head') continue; v.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sInv).sub(Rc); const d = v.dot(A), r = v.addScaledVector(A, -d).length(); if (Math.abs(d) < 0.012 && r < 0.1) nr = Math.max(nr, r); }
    const need = nr + o.bulk + 0.015; if (best.Rb * best.Rb - best.t * best.t < need * need) best.Rb = Math.sqrt(need * need + best.t * best.t);
    const rr = Math.sqrt(best.Rb * best.Rb - best.t * best.t);
    const Fw = V(0, 0, -1).applyQuaternion(rig.q[B.head]).applyQuaternion(rig.q[B.spine].clone().invert()); Fw.addScaledVector(A, -Fw.dot(A)).normalize();
    const Z = Fw.clone().negate(), X = V().crossVectors(A, Z).normalize(), M = new THREE.Matrix4().makeBasis(X, A, Z).setPosition(Rc);
    return (bubbleFit.v = { Rc, A, M, t: best.t, Rb: best.Rb, rr, nr, pts });
  }
  // The suit: the body below the neck ring and above the wrists and boots, 2.4 cm out (more round the torso, less down
  // the forearms and shins), relaxed so it's smooth and full, with soft creases round the limbs and convolute bellows at
  // the elbows and knees (rings 2.4 cm apart, fading out 7 cm from the joint); the suit's own joint, wrist and neck
  // rings in trim. The gloves are the hands' own surface 4 mm out, with gauntlets flaring from the wrist rings; the
  // boots are shoes made for the feet (shoe()) with bulky shafts round the measured lower leg over the suit's legs.
  function spaceSuit() {
    const bulk = o.bulk, gt = o.gloveT || 0, bf = bubbleFit(), sInv = R(B.spine).invert(), v = V();
    const neckCut = (i) => { v.set(BP.pos[i * 3], BP.pos[i * 3 + 1], BP.pos[i * 3 + 2]).applyMatrix4(sInv).sub(bf.Rc); const d = v.dot(bf.A), r = v.addScaledVector(bf.A, -d).length(); return Math.max(-(d + 0.012), r - (bf.rr + 0.01)); };
    const WR = 0.9, AK = 0.75; // (the wrist rings and the boot tops, along the forearm / shin)
    const field = (i) => { const sg = seg(i), t = tt(i); return sg === 'spine' || sg === 'head' ? neckCut(i) : sg === 'hips' || sg.startsWith('uArm') || sg.startsWith('thigh') ? 1 : sg.startsWith('fArm') ? WR - t : sg.startsWith('shin') ? AK - t : -1; };
    const off = (i) => { const sg = seg(i); return sg === 'spine' || sg === 'hips' ? bulk * 1.15 : sg.startsWith('fArm') ? bulk * 0.85 : sg.startsWith('shin') ? bulk * 0.9 : bulk; };
    const len = { uArm: D.upper, fArm: D.fore, thigh: D.thigh, shin: D.shin };
    const detail = (src, al, p) => {
      const sg = seg(src), base = sg.replace(/[RL]$/, ''), L = len[base];
      if (!L) return 0.0011 * Math.sin(p.y * 90 + 2.2 * Math.sin(p.x * 31 + p.z * 17)) * (sg === 'hips' || tt(src) < 0.35 ? 1 : 0.4); // (creases round the waist, fainter up the chest)
      const s = (base === 'uArm' || base === 'thigh' ? 1 - al : al) * L; // metres from the elbow / knee
      if (s < 0.075) return 0.008 * (0.5 + 0.5 * Math.cos(2 * Math.PI * s / 0.024)) * sstep(0.075, 0.045, s); // bellows
      return 0.0022 * Math.sin(2 * Math.PI * s / 0.065 + 1.6 * Math.sin(p.x * 47 + p.z * 39 + p.y * 11)); // soft creases round the limb
    };
    // An inflated torso hides the body's forms: about the torso's axis (the middle of its section at each height), each
    // point of the suit's torso goes out to the largest radius found near it (round the body within 15 degrees, up and
    // down within 4.5 cm), blurred, so the chest is one smooth curve and the hollows under and between forms are bridged.
    const shY = rig.spine ? (rig.spine.sh.R.y + rig.spine.sh.L.y) / 2 : D.shoulderUp;
    const fillHollows = (P, SRC) => {
      const inv = R(B.spine).invert(), Mw = R(B.spine), H = 0.015, NA = 48, ids = [], L = [];
      for (let v = 0; v < P.length; v++) { const sg = seg(SRC[v]); if (sg === 'spine' || sg === 'hips') { ids.push(v); L.push(P[v].clone().applyMatrix4(inv)); } }
      if (!L.length) return;
      let y0 = Infinity, y1 = -Infinity; for (const p of L) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      const NY = Math.ceil((y1 - y0) / H) + 1, cx = new Float32Array(NY), cz = new Float32Array(NY), lo = Array.from({ length: NY }, () => [Infinity, -Infinity, Infinity, -Infinity]);
      for (const p of L) { const b = lo[Math.round((p.y - y0) / H)]; b[0] = Math.min(b[0], p.x); b[1] = Math.max(b[1], p.x); b[2] = Math.min(b[2], p.z); b[3] = Math.max(b[3], p.z); }
      for (let yi = 0; yi < NY; yi++) { const b = lo[yi]; cx[yi] = Number.isFinite(b[0]) ? (b[0] + b[1]) / 2 : NaN; cz[yi] = Number.isFinite(b[2]) ? (b[2] + b[3]) / 2 : NaN; }
      for (let yi = 0; yi < NY; yi++) if (Number.isNaN(cx[yi])) { cx[yi] = yi ? cx[yi - 1] : 0; cz[yi] = yi ? cz[yi - 1] : 0; }
      for (let it = 0; it < 4; it++) for (let yi = 1; yi < NY - 1; yi++) { cx[yi] = (cx[yi - 1] + 2 * cx[yi] + cx[yi + 1]) / 4; cz[yi] = (cz[yi - 1] + 2 * cz[yi] + cz[yi + 1]) / 4; }
      const A = (x, z, yi) => ((Math.round((Math.atan2(x - cx[yi], -(z - cz[yi])) / (2 * Math.PI)) * NA) % NA) + NA) % NA;
      let g = new Float32Array(NA * NY).fill(-1);
      for (const p of L) { const yi = Math.round((p.y - y0) / H), k2 = A(p.x, p.z, yi) + yi * NA, r = Math.hypot(p.x - cx[yi], p.z - cz[yi]); if (r > g[k2]) g[k2] = r; }
      const d = new Float32Array(NA * NY).fill(-1); // dilate
      for (let yi = 0; yi < NY; yi++) for (let ai = 0; ai < NA; ai++) { let m = -1; for (let dy = -3; dy <= 3; dy++) { const y2 = yi + dy; if (y2 < 0 || y2 >= NY) continue; for (let da = -2; da <= 2; da++) m = Math.max(m, g[((ai + da + NA) % NA) + y2 * NA]); } d[ai + yi * NA] = m; }
      for (let it = 0; it < 4; it++) { g = d.slice(); for (let yi = 0; yi < NY; yi++) for (let ai = 0; ai < NA; ai++) { let sm = 0, n2 = 0; for (let dy = -1; dy <= 1; dy++) { const y2 = yi + dy; if (y2 < 0 || y2 >= NY) continue; for (let da = -1; da <= 1; da++) { const w = g[((ai + da + NA) % NA) + y2 * NA]; if (w >= 0) { sm += w; n2++; } } } if (n2) d[ai + yi * NA] = sm / n2; } }
      L.forEach((p, j) => { const yi = Math.round((p.y - y0) / H), r = Math.hypot(p.x - cx[yi], p.z - cz[yi]), gr = d[A(p.x, p.z, yi) + yi * NA];
        const w = sstep(shY + 0.02, shY - 0.06, p.y); if (!(gr > r) || r < 1e-4 || w <= 0) return; // (up to the shoulders: the yoke and neck keep their shape)
        const k2 = 1 + (gr / r - 1) * w; p.x = cx[yi] + (p.x - cx[yi]) * k2; p.z = cz[yi] + (p.z - cz[yi]) * k2; P[ids[j]].copy(p.applyMatrix4(Mw)); });
    };
    const suit = growShell(field, off, o.suit, 'fabric', { smooth: 30, subdiv: 2, detail, seatY: rig.seatY ?? null, back: rig.ctl !== 'bars' ? rig.opts.seat : null, fill: fillHollows });
    // gloves: the hand 4 mm out; a gauntlet flaring from under the wrist ring
    growShell((i) => { const sg = seg(i); return sg.startsWith('hand') ? 1 : sg.startsWith('fArm') ? tt(i) - (WR - 0.03) : -1; },
      (i) => (seg(i).startsWith('fArm') ? gt + bulk * 0.75 * sstep(WR + 0.1, WR - 0.01, tt(i)) : gt), o.glove, 'rubber', { smooth: 1 });
    for (const [fa, sg] of [[B.fArmR, 'fArmR'], [B.fArmL, 'fArmL']]) { // wrist rings: round the sleeve's end as built
      const inv = R(fa).invert(), p = V(); let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let q = 0; q < suit.SRC.length; q++) { if (seg(suit.SRC[q]) !== sg || suit.AL[q] < WR - 0.03) continue; p.set(suit.Q[q * 3], suit.Q[q * 3 + 1], suit.Q[q * 3 + 2]).applyMatrix4(inv); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      if (!Number.isFinite(x0)) continue; const r = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2 + 0.003, rz: (z1 - z0) / 2 + 0.003 };
      at(fa, ellipseTube(r, WR * D.fore, 0.008), o.trim, 'metal'); at(fa, ellipseTube({ ...r, rx: r.rx + 0.002, rz: r.rz + 0.002 }, WR * D.fore - 0.012, 0.005), o.helmet2, 'paint'); }
    for (const sb of [B.shinR, B.shinL]) spaceBoot(sb, bulk);
  }
  // a moon boot: the shoe made for the foot, and a bulky shaft grown from the lower leg (the shin above the ankle up
  // to 58 % of the way from the knee) over the suit's leg: snug where it meets the shoe, standing off as far as the suit
  // above it, relaxed smooth; a rolled top round its measured upper edge
  function spaceBoot(sb, bulk) {
    shoe(sb, o.boot, 0);
    const sg = sb === B.shinR ? 'shinR' : 'shinL', T0 = 0.58, T1 = 1 - 0.012 / D.shin; // (along the shin: the shaft's top, and 1.2 cm above the ankle)
    const sh = growShell((i) => (seg(i) === sg ? Math.min(tt(i) - T0, T1 - tt(i)) : -1), (i) => 0.012 + (bulk * 0.9 + 0.007 - 0.012) * sstep(T1, T1 - 0.15, tt(i)), o.boot, 'rubber', { smooth: 10 });
    if (!sh) return;
    const inv = R(sb).invert(), p = V(), y = T0 * D.shin; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let q = 0; q < sh.SRC.length; q++) { if (sh.AL[q] > T0 + 0.03) continue; p.set(sh.Q[q * 3], sh.Q[q * 3 + 1], sh.Q[q * 3 + 2]).applyMatrix4(inv); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    if (Number.isFinite(x0)) at(sb, ellipseTube({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2 + 0.002, rz: (z1 - z0) / 2 + 0.002 }, y, 0.008), o.boot, 'rubber'); // rolled top
  }
  // The helmet: the face (the body mesh's, eyes and hair) inside a bubble on the neck ring (bubbleFit), a suit collar
  // flaring from round the neck up under the ring, the ring itself (trim, a red band), and the visor assembly over it.
  function spaceHelmet() {
    meshFace(true);
    const bf = bubbleFit(), { t, Rb, rr, nr } = bf, SPM = HELMETS && HELMETS.meta.space;
    // with the helmet model: level (its ring flat to the horizon, whatever the torso's lean in the seat) at the neck: a
    // frame on the spine whose up is the rig's (the vehicle's) up and whose front is the rig's front; the procedural
    // bubble follows the head's axis
    let M = bf.M;
    if (SPM) { const sq = new THREE.Quaternion(); R(B.spine).decompose(V(), sq, V()); const si = sq.clone().invert(), Y = V(0, 1, 0).applyQuaternion(si), Zr = V(0, 0, 1).applyQuaternion(si);
      const Z = Zr.addScaledVector(Y, -Zr.dot(Y)).normalize(), X = V().crossVectors(Y, Z).normalize(); M = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(bf.Rc); }
    const put = (g, hex, slot) => { g.applyMatrix4(M); at(B.spine, g, hex, slot); };
    const lathe = (pts, n = 64) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), n);
    if (!SPM) put(lathe([[nr + o.bulk * 0.9, -0.05], [rr - 0.012, -0.03], [rr - 0.002, -0.022]]), o.suit, 'fabric'); // collar (the model helmet brings its own, flared to its ring)
    const SP = HELMETS && helmetParts('space'), best_Rb = () => bf.Rb; if (SP) { if (!k.p.tint) k.p.tint = []; if (!k.p.gold) k.p.gold = []; tintMaterial(); goldFilmMaterial(); }
    if (SP) { // the space helmet model, seated by its neck ring: the ring's lower lip (tilted 13 degrees on the model) turned
      // flat onto the suit's ring, scaled to its radius (1 cm over it), its lip on the collar
      const RG = HELMETS.meta.space.ring, n = V(...RG.n), bot = V(...RG.c), qr = new THREE.Quaternion().setFromUnitVectors(n, V(0, 1, 0)), q = V();
      // grown (from the ring's own size) until the head as it sits (looking ahead) is 1.5 cm inside the shell: a dome (0.43 of its width round its middle) over a cylinder of that radius down to the ring
      const toLocal = R(B.spine).invert().premultiply(M.clone().invert()), lq0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0, 0, 'YXZ'));
      const here = headPts.map((p) => p.clone().applyQuaternion(lq0).add(rig.p[B.head]).applyMatrix4(toLocal)), hb = new THREE.Box3().setFromPoints(here); // (the head as it sits, looking ahead, in the level frame)
      const hcx = (hb.min.x + hb.max.x) / 2, hcz = (hb.min.z + hb.max.z) / 2, ringY = -0.03; // (the helmet stands over the head's middle, its ring at the collar)
      const place = (s2) => { const o2 = V().sub(bot).applyQuaternion(qr).multiplyScalar(s2); return V(hcx - o2.x, ringY, hcz - o2.z); }; // (where the ring's lip goes so the dome's middle is over the head)
      const mid = (s2) => V().sub(bot).applyQuaternion(qr).multiplyScalar(s2).add(place(s2));
      const inside = (p, c, R2) => (p.y <= c.y && p.y >= ringY ? Math.hypot(p.x - c.x, p.z - c.z) : p.distanceTo(c)) < R2;
      let sc = (rr + 0.01) / RG.r; for (let it = 0; it < 30; it++) { const c = mid(sc); if (here.every((p) => inside(p, c, 0.43 * sc - 0.015))) break; sc *= 1.02; }
      const Rring = RG.r * sc, pl = place(sc); put(lathe([[nr + o.bulk * 0.9, -0.075], [nr + o.bulk + 0.02, -0.055], [Rring * 0.92, -0.036], [Rring - 0.003, -0.03]]).translate(pl.x, 0, pl.z), o.suit, 'fabric'); // the suit's collar flaring out to the helmet's ring
      for (const p of SP) { const P = p.g.attributes.position; for (let i = 0; i < P.count; i++) { q.fromBufferAttribute(P, i).sub(bot).applyQuaternion(qr).multiplyScalar(sc).add(pl); P.setXYZ(i, q.x, q.y, q.z); } p.g.computeVertexNormals();
        if (p.role === 'visor') { put(p.g.clone(), 0x6a5220, 'gold'); put(p.g, 0xd9a83a, 'tint'); continue; } // (the gold sun visor: a gold film and gold reflections)
        p.g.userData.keepColor = true; put(p.g, 0xffffff, p.slot); }
      return;
    }
    put(lathe([[rr - 0.006, 0.006], [rr - 0.006, -0.03], [rr + 0.004, -0.034], [rr + 0.013, -0.028], [rr + 0.015, -0.004], [rr + 0.01, 0.006], [rr - 0.006, 0.006]].reverse()), o.trim, 'metal'); // neck ring
    put(lathe([[rr + 0.0165, -0.02], [rr + 0.0165, -0.011]]), o.helmet2, 'paint'); // its red band
    if (!k.p.clear) k.p.clear = []; if (!k.p.tint) k.p.tint = []; if (!k.p.gold) k.p.gold = []; clearMaterial(); tintMaterial(); goldFilmMaterial();
    const v0 = -Math.asin(clamp(t / Rb, 0, 0.99)), Cc = V(0, t, 0), se4 = (x, a2) => Math.abs(x / a2) ** 4;
    put(dsphere(Cc, Rb, Rb, Rb, null, { w: 64, h: 40, v0 }), 0xdde6ee, 'clear'); // the pressure bubble
    // the visor assembly, as on NASA's EMU (traced from a front photograph, in bubble radii R about its centre): a white
    // shell over the bubble's top, back and sides, open in front from 52 degrees below the middle to 70 above and 80 either
    // side; the gold sun visor down across that opening, overlapping its edge; a lamp box on a bracket at each upper side
    // (1.3 R out, 0.66 R up: two round lenses)
    const Rs = Rb + 0.014, Rv = Rs + 0.005, open = (u, v) => se4(u, 1.4) + se4(v - 0.17, 1.05) < 1;
    { const g = dsphere(Cc, Rs, Rs, Rs, null, { w: 128, h: 80, v0: v0 + 0.05, hole: open }), loops = hemEdges(g, ontoDS(Cc, Rs, Rs, Rs, null), 16); put(g, o.helmet, 'paint');
      for (const L of loops) put(tubeLoop(L.map((q) => Cc.clone().addScaledVector(q.clone().sub(Cc), (Rs - 0.004) / Rs)), 0.007), o.helmet, 'paint'); } // shell, rolled edges
    { const vh = (u, v) => se4(u, 1.47) + se4(v - 0.17, 1.12) > 1, mk = () => dsphere(Cc, Rv, Rv, Rv, null, { w: 128, h: 80, hole: vh });
      const g = mk(), loops = hemEdges(g, ontoDS(Cc, Rv, Rv, Rv, null), 16); put(g, 0x6a5220, 'gold'); // the gold film: what's behind it, dimmed and gold
      const g2 = mk(); hemEdges(g2, ontoDS(Cc, Rv, Rv, Rv, null), 16); put(g2, 0xd9a83a, 'tint'); // its gold mirror
      for (const L of loops) put(tubeLoop(L, 0.004), o.trim, 'metal'); } // its frame
    for (const sx of [-1, 1]) { // lamps
      const R1 = Rb, lc = Cc.clone().add(V(sx * 1.3 * R1, 0.66 * R1, -0.05 * R1)), bw = 0.36 * R1, bh = 0.54 * R1, bd = 0.46 * R1;
      put(boxG(bw, bh, bd, lc), 0xe8e8e2, 'paint');
      for (const [dy, rl] of [[0.15, 0.13], [-0.15, 0.11]]) { const lp = lc.clone().add(V(0, dy * R1, -bd / 2 - 0.002)); put(new THREE.CylinderGeometry(rl * R1, rl * R1, 0.006, 24).rotateX(Math.PI / 2).translate(lp.x, lp.y, lp.z), 0xcfd6dc, 'glass'); }
      const a0 = Cc.clone().add(V(sx * 0.82 * Rs, 0.5 * Rs, 0.12 * Rs)); put(capAB(a0, lc.clone().add(V(-sx * bw * 0.4, -0.12 * R1, 0.08 * R1)), 0.01, 0.01), 0x9aa0a6, 'metal'); // bracket
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
  // toe brakes (a light plane's rudder pedals, controls.toeBrakes): each pedal on an arm down to its pivot on the
  // floor, the brake cylinder from the pedal's top forward to the floor, rubber treads across the pad
  if (C.toeBrakes && rig.ctl !== 'bars' && rig.floorY == null) for (const i of [B.pedR, B.pedL]) {
    at(i, capAB(V(0, -0.015, -0.02), V(0, 0.13, -0.02), 0.011, 0.011, { seg: 6 }), 0x8b9097, true); // pedal arm
    at(i, capAB(V(-0.055, -0.015, -0.02), V(0.055, -0.015, -0.02), 0.012, 0.012, { seg: 6 }), 0x2b2d31); // pivot
    at(i, capAB(V(0, 0.12, -0.035), V(0, 0.0, -0.17), 0.014, 0.012, { seg: 8 }), 0x15161a); // brake cylinder
    at(i, capAB(V(0, 0.125, -0.025), V(0, 0.105, -0.06), 0.005, 0.005, { seg: 5 }), 0xc9ccd1, true); // its rod
    for (let k = 0; k < 4; k++) at(i, boxG(0.08, 0.008, 0.006, V(0, 0.03 + k * 0.032, 0.011)), 0x15161a); // treads
  }
  return k.build();
}

// Where the figure looks from (rig space, rest pose, head straight): just behind the eyes on the head bone.
function eyePoint(rig) {
  const r = new Rig(rig.kind, rig.ctl, rig.o, rig.seed, { pegs: rig.pegs, groundY: rig.groundY, ride: rig.opts.ride }); // (posed at rest)
  const k = rig.o.head === 'bubble' && !r.body ? 1.18 : 1; // (the old procedural bubble's big head; the mesh body's head is its own)
  return V(0, 0.155, -0.075 * k).applyQuaternion(r.q[B.head]).add(r.p[B.head]);
}

const geoCache = new Map();
// outfit: OUTFITS key or object; ctl: 'stick' | 'cyclic' | 'yoke' | 'wheel' | 'none'; seed picks skin/hair tones
export function buildCrew(outfitKey, ctl = 'stick', { seed = 0, colors = null, pegs = null, groundY, seat = null, helm = null, ride = null } = {}) {
  const outfit = { ...(OUTFITS[outfitKey] || OUTFITS.light), ...(colors || {}) };
  const rig = new Rig(outfitKey, ctl, outfit, seed, { pegs, groundY, seat, helm, ride });
  const key = outfitKey + '|' + ctl + '|' + (seed % 4) + '|' + JSON.stringify(colors || 0) + (pegs ? '|' + JSON.stringify(pegs.map((v) => v.toArray().map((x) => +x.toFixed(3)))) : '') + (seat ? '|' + JSON.stringify(seat) : '') + (helm ? '|' + JSON.stringify(helm) : '') + (ride ? '|' + JSON.stringify(ride) : '');
  if (!geoCache.has(key)) geoCache.set(key, figureGeometry(rig));
  const geos = geoCache.get(key), mats = crewMaterials();
  const root = new THREE.Group(); root.name = 'crew';
  const bones = []; for (let i = 0; i < NB; i++) { const b = new THREE.Bone(); b.position.copy(rig.p[i]); b.quaternion.copy(rig.q[i]); root.add(b); bones.push(b); }
  root.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(bones);
  for (const [k, g] of Object.entries(geos)) {
    if (!g) continue;
    const m = new THREE.SkinnedMesh(g, mats[k] || mats.fabric); m.userData.near = true; m.userData.crew = true; m.userData.cosmetic = true; m.castShadow = k !== 'clear' && k !== 'tint' && k !== 'gold'; if (k === 'gold') m.renderOrder = 1; if (k === 'tint') m.renderOrder = 2; m.receiveShadow = true; // (clear glass casts no shadow)
    m.frustumCulled = false; // a few hundred triangles; skinned bounds would otherwise need a refresh as the pose changes
    root.add(m); m.bind(skel, new THREE.Matrix4());
  }
  const smooth = { pitch: 0, roll: 0, yaw: 0, thr: 0.4, steer: 0, look: 0, lean: 0, tuck: 0, foot: 0, bikeLean: 0 };
  root.userData.crewRig = {
    rig, root,
    eye: eyePoint(rig), // rig space: between the eyes, head straight (cockpit view, stations.js)
    // where the eyes are now (rig space): a motorbike rider bends over the tank and leans into turns (stations.js)
    eyeNow(out = V()) { return out.set(0, 0.155, -0.075 * (outfit.head === 'bubble' && !rig.body ? 1.18 : 1)).applyQuaternion(rig.q[B.head]).add(rig.p[B.head]); },
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
// A seat's adjustable controls and seat (seat.adjust, part units: { pedZ, pedY, seatZ, seatY: [lo, hi] }, offsets
// from where the seat declares them, + = aft / up) into the figure's rig space, alongside its control placement.
// Only a seat with crew controls adjusts its pedals; a seat's rails adjust for anyone.
function seatAdjust(st, s, ctlSet) {
  const A = st.adjust; if (!A) return ctlSet;
  const adj = {}; for (const [k, r] of Object.entries(A)) if (Array.isArray(r) && r.length === 2 && (st.role !== 'crew' || k.startsWith('seat'))) adj[k] = [r[0] / s, r[1] / s];
  return Object.keys(adj).length ? { ...(ctlSet || {}), adjust: adj } : ctlSet;
}
// The seat on its rails: the vehicle built it before anyone sat in it, as its own mesh(es) tagged
// userData.seatRail = the seat's index; once the figure's posture (and with it the seat's travel) is solved, they move
// by that much (rig space -> the part's space, then into each mesh's parent's).
function railSeatMesh(obj, st, k, rig) {
  const dz = rig?.v?.seatZ || 0, dy = rig?.v?.seatY || 0; if (!dz && !dy) return;
  const s = st.s || 1, d = V(0, dy * s, dz * s); obj.updateMatrixWorld(true);
  obj.traverse((m) => {
    if (m.userData.seatRail !== k || !m.parent) return;
    const a = m.parent.worldToLocal(obj.localToWorld(V())), b = m.parent.worldToLocal(obj.localToWorld(d.clone()));
    m.position.add(b.sub(a)); m.updateMatrix();
  });
}
// A seat's obstacles (st.obstacles: see prepObstacle, part coordinates) with where the figure sits in the part (seat
// point, scale, turn), so the rig can take its body into part space to test them. Plain data (it keys the posture cache).
function seatObstacles(st) {
  const q = st.quat ? [...st.quat] : st.yaw ? new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), st.yaw).toArray() : null;
  return { p: [...st.p], s: st.s || 1, q, list: st.obstacles };
}
// A rider's seat ('bars') may declare the vehicle's geometry round the rider, in the part's coordinates:
//   saddle: the cushion's superLoft sections ({ z, hw, top, bot, n }, z ascending): the rider sits on its top,
//           wherever along it is most comfortable
//   around: [sections, ...] the bodywork the rider straddles and reaches over (tank, fairing panels, shrouds, a jet
//           ski's hood): legs, torso and arms stay outside it, the knees just outside it
//   knees: 'grip' (pressed against it, as a road racer or a motocross rider grips the tank) or 'near' (the default)
//   lean: the torso's forward lean (radians from upright) the riding position is built round: a road racer's crouch,
//         a motocross attack stance, a jet ski's upright seat (the default 0.35); the solve balances it against the rest
// and the grips are those of whichever part carries userData.grips nearest the seat (a fork, a jet ski's own bars), at
// rest. All of it into the rider's rig space (seat point at, the part's scale ps, the rider's scale sc). Null without
// a saddle (the rider then poses by the old fixed rules).
function rideGeometry(st, obj, objs, ps, sc) {
  if (!st.saddle?.length) return null;
  const at = V(...st.p), r3 = (x) => +x.toFixed(4);
  const secs = (L) => L.map((s) => ({ z: r3((s.z - at.z) * ps.z / sc), hw: r3(s.hw * ps.x / sc), top: r3((s.top - at.y) * ps.y / sc), bot: r3((s.bot - at.y) * ps.y / sc), n: s.n || 3, cx: r3(((s.cx || 0) - at.x) * ps.x / sc) }));
  let grips = null; const root = obj.parent, toR = (o, p) => { const out = p.clone(); for (let x = o; x && x !== root; x = x.parent) { x.updateMatrix(); out.applyMatrix4(x.matrix); } return out; };
  obj.updateMatrix(); const inv = obj.matrix.clone().invert(), here = toR(obj, at);
  let best = null, bd = Infinity; for (const o of objs) { if (!o?.userData.grips) continue; const d = toR(o, V()).distanceTo(here); if (d < bd) { bd = d; best = o; } }
  if (best) grips = best.userData.grips.map((g) => toR(g.o, g.p).applyMatrix4(inv).sub(at).multiply(ps).divideScalar(sc).toArray().map(r3)).sort((a, b) => a[0] - b[0]);
  else if (st.grips?.length === 2) grips = st.grips.map((g) => V(...g).sub(at).multiply(ps).divideScalar(sc).toArray().map(r3));
  // (optional: hz0, where the pelvis prefers to be along the saddle (part z, from the seat point); legs, the hip and knee
  // angles this riding position prefers (radians; a seated person's by default); stance 'attack', standing on the pegs)
  return { saddle: secs(st.saddle), around: (st.around || []).map(secs), knees: st.knees || 'near', lean: st.lean ?? 0.35, grips,
    ...(st.hz0 != null ? { hz0: r3(st.hz0 * ps.z / sc) } : {}), ...(st.legs ? { legs: st.legs } : {}), ...(st.stance ? { stance: st.stance } : {}) };
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
      let fit = null, ride = null;
      if (ctl === 'bars') { // a rider in the bike's colours, feet on the frame's pegs (seat space -> rig space)
        outfit = st.rider || 'mx'; colors = { suit: p.color ?? OUTFITS[outfit].suit, helmet2: p.color ?? OUTFITS[outfit].helmet2 };
        const ps = V(Math.abs(obj.scale.x) || 1, Math.abs(obj.scale.y) || 1, Math.abs(obj.scale.z) || 1), sc = (st.s || 1) * Math.cbrt(ps.x * ps.y * ps.z);
        fit = V(sc / ps.x, sc / ps.y, sc / ps.z);
        const at = V(...st.p); pegs = (st.pegs || []).map((q) => V(...q).sub(at).multiply(ps).divideScalar(sc)); if (pegs.length !== 2) pegs = null;
        if (st.ground != null) groundY = (st.ground - st.p[1]) * ps.y / sc;
        ride = rideGeometry(st, obj, objs, ps, sc);
      }
      if (st.harness && ctl !== 'bars' && OUTFITS[outfit] && OUTFITS[outfit].harness === undefined) colors = { ...(colors || {}), harness: true }; // (a seat with its own harness: whoever sits in it wears it)
      // a seat built with seatGeo declares it (fit: { at: where its geometry was placed, dims: seatGeo's arguments }), so
      // the figure can sit on its actual surfaces
      const seat = st.fit && ctl !== 'bars' ? seatSurfaces(st.fit, st.p, st.s || 1) : null, ctlSet = seatAdjust(st, st.s || 1, seatControls(st, st.s || 1));
      if (seat && st.obstacles) seat.obstacles = seatObstacles(st); // (what's round the seat: the posture keeps clear of it)
      const c = buildCrew(outfit, ctl, { seed: i * 3 + k, colors, pegs, groundY, seat, helm: ctlSet, ride });

      Object.assign(c.userData.crewRig, { role: st.role || 'pilot', kind, ctl, part: i, seat: k }); // (stations.js names the cockpit views from these)
      c.position.set(...st.p); if (st.quat) c.quaternion.fromArray(st.quat); else if (st.yaw) c.rotation.y = st.yaw;
      if (fit) c.scale.copy(fit); else c.scale.setScalar(st.s || 1);
      railSeatMesh(obj, st, k, c.userData.crewRig.rig);
      obj.add(c); list.push(c.userData.crewRig);
    });
    obj.userData.crew = list; rigs.push(...list);
  });
  return rigs;
}
export { prepObstacle, obstacleClear }; // (interior.js reads the seats' containing obstacles as each cockpit's interior)
