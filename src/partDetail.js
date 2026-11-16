// Visual-only detail for individual parts: twisted propeller blades, cowling louvres and exhaust stacks, jet intake
// lips / compressor faces / nozzle petals, oleo landing gear with torque links and brake lines, cockpit fittings.
// Only built when a part is built with { detail } (flight, hangar, traffic). partInfo() builds parts without it, so
// nothing here can change hull points, mass centres or any other physics input.
// Small pieces are tagged near (userData.near): planeDetail's LOD hides them beyond a few dozen metres.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const KEEP = ['position', 'normal', 'uv', 'uv1'];
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
export const mx = (p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => new THREE.Matrix4().compose(V(...p), _q.setFromEuler(_e.set(...r)), V(...s));

// Same attribute set + an index on every geometry so a Bag can merge them.
// Zero-length normals (degenerate tips, collapsed rings) turn into NaN in the lighting shader, and bloom smears a NaN
// pixel into a black block: give them the direction away from the geometry's centre instead.
export function fixNormals(g) {
  const n = g.attributes.normal, p = g.attributes.position; if (!n) return g;
  let c = null;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i), y = n.getY(i), z = n.getZ(i), l = Math.hypot(x, y, z);
    if (l > 1e-6 && Number.isFinite(l)) continue;
    if (!c) { g.computeBoundingBox(); c = g.boundingBox.getCenter(new THREE.Vector3()); }
    const d = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).sub(c); if (d.lengthSq() < 1e-12) d.set(0, 1, 0); d.normalize();
    n.setXYZ(i, d.x, d.y, d.z);
  }
  n.needsUpdate = true; return g;
}
export function norm(g) {
  for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  fixNormals(g);
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.index) { const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
  g.clearGroups(); g.morphAttributes = {};
  return g;
}
// Collects small geometries per material and emits one merged mesh per material (few draw calls even unmerged).
export class Bag {
  constructor() { this.b = new Map(); }
  add(geo, mat, m) { const g = norm(geo); if (m) g.applyMatrix4(m); if (!this.b.has(mat)) this.b.set(mat, []); this.b.get(mat).push(g); return this; }
  merged() { const out = []; for (const [mat, gs] of this.b) out.push([mat, gs.length > 1 ? mergeGeometries(gs) : gs[0]]); this.b.clear(); return out; }
  to(parent, near = false) {
    for (const [mat, gs] of this.b) {
      const mesh = new THREE.Mesh(gs.length > 1 ? mergeGeometries(gs) : gs[0], mat);
      if (near) { mesh.userData.near = true; mesh.castShadow = false; }
      parent.add(mesh);
    }
    this.b.clear(); return parent;
  }
}

// ---------- one material for all small metal / rubber / black fittings ----------
// A 16-texel palette: colour in the map, roughness (G) and metalness (B) in a second texture sampled at the same uv.
// Meshes using one of the stock fitting materials are re-coloured through uv into the kit material when a plane is
// merged, so a whole rigid piece's fittings cost one draw call. (Textured ones, like tyres, keep their own material.)
const KIT = [['steel', 0x8b9097, 1, 0.25], ['darkMetal', 0x2b2d31, 0.7, 0.45], ['aluminum', 0xc9ccd1, 0.9, 0.32], ['chrome', 0xffffff, 1, 0.08],
  ['rubber', 0x1a1a1a, 0, 0.9], ['black', 0x111215, 0.3, 0.6], ['prop', 0x222326, 0.4, 0.5], ['propTip', 0xf2c300, 0.2, 0.5], ['pilot', 0xeaeaea, 0.1, 0.5],
  ['visor', 0x332200, 0.9, 0.1], ['PMexhaust', 0x0d0c0b, 0, 1], ['PMseat', 0x24262a, 0, 0.85], ['brushed', 0xb9bdc3, 0.9, 0.38], ['polished', 0xd8dbe0, 1, 0.12], ['hot', 0x5a4a3e, 0.85, 0.42], ['titanium', 0x7d828a, 0.9, 0.45], ['anodised', 0x9c8c4e, 0.75, 0.35]];
let kitMat = null, kitSlots = null;
export function kitMaterial() {
  if (kitMat) return kitMat;
  const mk = (f) => { const c = document.createElement('canvas'); c.width = KIT.length; c.height = 1; const g = c.getContext('2d'); KIT.forEach((k, i) => { g.fillStyle = f(k); g.fillRect(i, 0, 1, 1); }); const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; };
  const col = mk((k) => '#' + k[1].toString(16).padStart(6, '0')); col.colorSpace = THREE.SRGBColorSpace;
  const rm = mk((k) => `rgb(0,${Math.round(k[3] * 255)},${Math.round(k[2] * 255)})`);
  kitMat = new THREE.MeshStandardMaterial({ map: col, roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: 1 });
  return kitMat;
}
export function kitSlot(mat) {
  if (!kitSlots) {
    kitSlots = new Map();
    KIT.forEach(([k], i) => { const m = k.startsWith('PM') ? PM[k[2].toLowerCase() + k.slice(3)]() : M[k] ? M[k]() : PM.metal(k); kitSlots.set(m, i); });
  }
  return kitSlots.has(mat) ? kitSlots.get(mat) : -1;
}
// geometry (already normalised) re-coloured for kit slot i
export function kitUV(g, i) { const a = g.attributes.uv, u = (i + 0.5) / KIT.length; for (let k = 0; k < a.count; k++) a.setXY(k, u, 0.5); return g; }

// a box or round rod from a to b
export function bar(a, b, w, h = w, round = false, segs = 8) {
  const d = b.clone().sub(a), L = Math.max(1e-4, d.length());
  const g = round ? new THREE.CylinderGeometry(w / 2, h / 2, L, segs, 1, false) : new THREE.BoxGeometry(w, L, h);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1)));
  return g;
}
export const tube = (pts, r, segs = 6, steps = 0) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps || pts.length * 5, r, segs, false);

// Closed loops (all the same length) joined into a skin; optional caps. Winding is checked so normals face outwards.
export function ringLoft(rings, capStart = false, capEnd = false) {
  const n = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const ctr = (r) => r.reduce((s, p) => s.add(p), V()).multiplyScalar(1 / r.length);
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) {
    const a = k * n + i, b = k * n + ((i + 1) % n), c = (k + 1) * n + ((i + 1) % n), d = (k + 1) * n + i;
    idx.push(a, b, c, a, c, d);
  }
  const k = Math.floor((rings.length - 1) / 2), A = rings[k][0], B = rings[k][1], C = rings[k + 1][1];
  if (B.clone().sub(A).cross(C.clone().sub(A)).dot(A.clone().sub(ctr(rings[k]))) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const cap = (k, k2) => {
    const c = ctr(rings[k]), away = c.clone().sub(ctr(rings[k2])), ci = pos.length / 3; pos.push(c.x, c.y, c.z);
    const a = rings[k][0], b = rings[k][1], flip = b.clone().sub(c).cross(a.clone().sub(c)).dot(away) < 0;
    for (let i = 0; i < n; i++) { const a = k * n + i, b = k * n + ((i + 1) % n); flip ? idx.push(ci, a, b) : idx.push(ci, b, a); }
  };
  if (capStart) cap(0, 1);
  if (capEnd) cap(rings.length - 1, rings.length - 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ---------- propellers ----------
// Blade along +X spinning about Z (thrust towards -Z): chord peaks around 40 % radius and rounds off at the tip,
// pitch angle falls from ~50° at the root to ~12° at the tip (constant geometric pitch), flat-bottomed section.
// Returns the blade, its painted tip band and the round shank that plugs into the hub.
export function bladeGeometry(R, { chord = 1, pitch = 1.25, r0 = 0.15, band = 0.08, N = 14 } = {}) {
  const S = 14, rings = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N, r = R * (r0 + (1 - r0) * t);
    let c = R * chord * (0.07 + 0.065 * Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.15)));
    if (t > 0.78) c *= Math.sqrt(Math.max(0.05, 1 - ((t - 0.78) / 0.222) ** 2));
    const beta = Math.atan2(pitch * R, 2 * Math.PI * r), tk = (0.15 - 0.1 * t) * c;
    const d = V(0, -Math.cos(beta), Math.sin(beta)), n = V(0, -Math.sin(beta), -Math.cos(beta)), ring = [];
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2, x = -Math.cos(a) * c * 0.5 + c * 0.15, y = Math.sin(a) * tk * 0.5 * (Math.sin(a) > 0 ? 1 : 0.3);
      ring.push(V(r, 0, 0).addScaledVector(d, x).addScaledVector(n, y));
    }
    rings.push(ring);
  }
  const cut = Math.round(N * (1 - band));
  const blade = ringLoft(rings.slice(0, cut + 1), false, false), tip = ringLoft(rings.slice(cut), false, true);
  const shank = new THREE.CylinderGeometry(R * 0.028, R * 0.034, R * r0 * 1.05, 10); shank.rotateZ(Math.PI / 2); shank.translate(R * r0 * 0.5, 0, 0);
  // one mesh per blade: the colour comes from a two-texel map (u = 0.25 blade, 0.75 painted tip), see PM.blade()
  const paint = (g, u) => { norm(g); const a = g.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u, 0.5); return g; };
  return mergeGeometries([paint(blade, 0.25), paint(tip, 0.75), paint(shank, 0.25)]);
}

// Rotor blade (same frame as the plain box: span +X from the hub, thickness Y, chord Z): symmetric section, swept tip.
export function rotorBlade(R, chord) {
  const rings = [], N = 10, S = 12, th = Math.max(0.025, chord * 0.12);
  for (let k = 0; k <= N; k++) {
    const t = k / N, x = R * (0.04 + 0.93 * t), c = chord * (t > 0.92 ? 1 - (t - 0.92) * 6 : 1), sweep = t > 0.92 ? (t - 0.92) * chord * 2.5 : 0, ring = [];
    for (let i = 0; i < S; i++) { const a = (i / S) * Math.PI * 2; ring.push(V(x, Math.sin(a) * th * 0.5, -Math.cos(a) * c * 0.5 + c * 0.1 + sweep)); }
    rings.push(ring);
  }
  return ringLoft(rings, true, true);
}

// ---------- engines ----------
// Piston / radial / turboprop cowling detail. g: the engine group; profile radius r, length len (cowl from z=0 to len).
export function propEngineDetail(g, { len, radius: r, radial, color, propR }) {
  const paint = PM.skin(color), dark = M.darkMetal(), steel = M.steel(), soot = PM.exhaust(), intake = M.intake();
  const b = new Bag(), nb = new Bag();
  const turbo = !radial && len > 2;
  if (radial) {
    // finned cylinders (replacing the plain ones), pushrod tubes, crankcase nose and reduction-gear dome
    for (const m of g.children.slice()) if (m.geometry?.type === 'CylinderGeometry' && m.material === M.steel()) g.remove(m);
    const nC = 9;
    for (let i = 0; i < nC; i++) {
      const a = (i / nC) * Math.PI * 2, rot = [0, 0, a - Math.PI / 2], c = Math.cos(a), s = Math.sin(a);
      const cyl = new THREE.CylinderGeometry(0.075, 0.085, r * 0.58, 10); cyl.applyMatrix4(mx([c * r * 0.42, s * r * 0.42, 0.1], rot));
      b.add(cyl, dark);
      for (let f = 0; f < 6; f++) { const fin = new THREE.CylinderGeometry(0.12, 0.12, 0.012, 12); fin.applyMatrix4(mx([c * r * (0.24 + f * 0.05), s * r * (0.24 + f * 0.05), 0.1], rot)); b.add(fin, steel); }
      const head = new THREE.BoxGeometry(0.15, 0.1, 0.16); head.applyMatrix4(mx([c * r * 0.6, s * r * 0.6, 0.1], rot)); b.add(head, steel);
      nb.add(bar(V(c * r * 0.6, s * r * 0.6, 0.02), V(c * r * 0.16, s * r * 0.16, 0.0), 0.018, 0.018, true, 5), steel);
    }
    const dome = new THREE.SphereGeometry(r * 0.3, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2); dome.rotateX(-Math.PI / 2); dome.translate(0, 0, 0.0); b.add(dome, steel);
    // cowl flaps (gills) round the cowl's trailing edge, slightly open
    const nG = 18, rr = r * 0.69;
    for (let i = 0; i < nG; i++) {
      const a = (i / nG) * Math.PI * 2, gill = new THREE.BoxGeometry((2 * Math.PI * rr / nG) * 0.94, 0.01, 0.13);
      gill.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.1)); gill.translate(0, -0.006, 0.06);
      gill.applyMatrix4(mx([Math.sin(a) * rr, Math.cos(a) * rr, len - 0.04], [0, 0, -a]));
      b.add(gill, paint);
    }
    // exhaust collector stubs low on each side, with sooty ends
    for (const sx of [-1, 1]) {
      const ex = tube([V(sx * r * 0.55, -r * 0.45, len - 0.25), V(sx * r * 0.68, -r * 0.55, len + 0.05), V(sx * r * 0.74, -r * 0.6, len + 0.3)], 0.06, 8);
      b.add(ex, dark);
      const mouth = new THREE.CircleGeometry(0.055, 10); mouth.applyMatrix4(mx([sx * r * 0.74, -r * 0.6, len + 0.301])); b.add(mouth, soot);
    }
  } else {
    // remove the plain exhaust stubs: replaced by proper stacks below
    for (const m of g.children.slice()) if (m.geometry?.type === 'CylinderGeometry' && m.material === M.darkMetal()) g.remove(m);
    if (turbo) {
      // turboprop: big curved exhaust stacks either side, chin intake scoop under the spinner
      for (const sx of [-1, 1]) {
        const p0 = V(sx * r * 0.55, r * 0.05, len * 0.36), p1 = V(sx * r * 1.0, r * 0.08, len * 0.44), p2 = V(sx * r * 1.12, r * 0.06, len * 0.56);
        b.add(tube([p0, p1, p2], r * 0.2, 12, 14), dark);
        const lip = new THREE.TorusGeometry(r * 0.2, r * 0.025, 6, 16); lip.applyMatrix4(mx(p2.toArray(), [0, sx * 0.5, 0])); b.add(lip, steel);
        const m = new THREE.CircleGeometry(r * 0.19, 14); m.applyMatrix4(mx(p2.clone().add(V(sx * 0.005, 0, 0.01)).toArray(), [0, sx * 0.5, 0])); b.add(m, soot);
      }
      const scoop = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2); scoop.applyMatrix4(mx([0, -r * 0.72, len * 0.22], [Math.PI, 0, 0], [r * 0.42, r * 0.3, len * 0.22])); b.add(scoop, paint);
      const mouth = new THREE.CircleGeometry(1, 16, Math.PI, Math.PI); mouth.applyMatrix4(mx([0, -r * 0.74, 0.012], [0, Math.PI, 0], [r * 0.34, r * 0.22, 1])); b.add(mouth, intake);
    } else {
      // flat-four: two cooling inlets beside the spinner, two short stacks each side under the cowl
      for (const sx of [-1, 1]) {
        const inl = new THREE.CircleGeometry(1, 16, 0, Math.PI); inl.applyMatrix4(mx([sx * r * 0.62, r * 0.05, 0.03], [0, Math.PI, sx * 0.25], [r * 0.2, r * 0.17, 1])); b.add(inl, intake);
        for (const dz of [0, 0.11]) {
          const p0 = V(sx * r * 0.42, -r * 0.78, len * 0.68 + dz), p1 = V(sx * r * 0.46, -r * 1.02, len * 0.76 + dz);
          b.add(bar(p0, p1, 0.05, 0.05, true, 8), dark);
          const m = new THREE.CircleGeometry(0.02, 8); m.applyMatrix4(new THREE.Matrix4().compose(p1.clone().addScaledVector(p1.clone().sub(p0).normalize(), 0.002), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), p1.clone().sub(p0).normalize()), V(1, 1, 1))); b.add(m, soot);
        }
        // oil cooler / cowl flap lip at the bottom rear
      }
      const flap = new THREE.BoxGeometry(r * 0.7, 0.012, 0.16); flap.applyMatrix4(mx([0, -r * 0.88, len - 0.04], [0.35, 0, 0])); b.add(flap, paint);
    }
    // louvres: little raked slots high on each side of the cowl (near only)
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) {
      const z = len * (turbo ? 0.62 : 0.5) + i * 0.04, a = sx * 1.0, rr = r * (turbo ? 1.0 : 0.985);
      const l = new THREE.BoxGeometry(r * 0.16, 0.01, 0.014); l.applyMatrix4(mx([Math.sin(a) * rr, Math.cos(a) * rr, z], [0, 0, -a]));
      nb.add(l, dark);
    }
  }
  // spinner backplate
  const bp = new THREE.CylinderGeometry(r * 0.37, r * 0.37, 0.02, 24); bp.rotateX(Math.PI / 2); bp.translate(0, 0, -0.005); b.add(bp, PM.metal('brushed'));
  b.to(g); nb.to(g, true);
}

// Jet intake lip, twisted compressor/fan blades, exhaust plug or afterburner petals and turbine face.
export function jetEngineDetail(g, { len, radius: r, fan, ab }) {
  const lipMat = PM.metal('polished'), dark = M.darkMetal(), steel = M.steel(), hot = PM.metal('hot');
  const b = new Bag();
  const lipR = fan ? r * 0.94 : r * 0.88;
  const lip = new THREE.TorusGeometry(fan ? r * 0.93 : lipR, r * (fan ? 0.075 : 0.06), 10, 48); lip.translate(0, 0, fan ? 0.03 : 0.02); b.add(lip, lipMat);
  // compressor / fan face: replace the box blades with twisted blades, keep the group (aircraft.js spins userData.fan)
  const fanG = g.userData.fan;
  if (fanG) {
    for (const c of fanG.children.slice()) if (!c.isMesh) fanG.remove(c);
    const nb = fan ? 24 : 18, blades = [], rh = r * 0.28, rt = r * 0.86;
    for (let i = 0; i < nb; i++) {
      const rings = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, rr = rh + (rt - rh) * t, tw = (fan ? 1.05 : 0.85) - 0.45 * t, c = r * (fan ? 0.22 : 0.16) * (1 + 0.25 * t);
        const d = V(Math.cos(tw), 0, Math.sin(tw)), ring = [];
        for (const [x, y] of [[-0.5, 0], [0, 0.012], [0.5, 0], [0, -0.012]]) ring.push(V(0, rr, 0).addScaledVector(d, x * c).add(V(0, 0, y * 0).addScaledVector(V(-Math.sin(tw), 0, Math.cos(tw)), y * r)));
        rings.push(ring);
      }
      const bg = ringLoft(rings, false, true); bg.rotateZ((i / nb) * Math.PI * 2); bg.translate(0, 0, len * 0.12); blades.push(norm(bg));
    }
    const bm = new THREE.Mesh(mergeGeometries(blades), fan ? PM.metal('titanium') : steel); fanG.add(bm);
    if (fan) { // white swirl on the spinner (so you can see it turning)
      const sw = []; for (let k = 0; k <= 12; k++) { const t = k / 12, a = t * Math.PI * 1.6, rr = r * 0.3 * (1 - t) * 1.03; sw.push(V(Math.sin(a) * rr, Math.cos(a) * rr, len * 0.05 + r * 0.3 - t * r * 0.6)); } // on the hub cone
      const swirl = new THREE.Mesh(tube(sw, r * 0.02, 5, 24), M.paint(0xffffff, 'matte'));
      swirl.userData.near = true; fanG.add(swirl);
    }
  }
  if (fan) {
    // exhaust plug and core nozzle sleeve
    const plug = new THREE.LatheGeometry([[0.0, r * 0.38], [0.25 * r, r * 0.36], [0.7 * r, r * 0.22], [1.15 * r, 0.02], [1.16 * r, 0]].map(([z, rr]) => new THREE.Vector2(rr, z)), 20);
    plug.rotateX(Math.PI / 2); plug.translate(0, 0, len + r * 0.2); b.add(plug, dark);
  } else if (ab) {
    // afterburner: ring of overlapping petals (heat-tinted), flame-holder rings and a dark turbine face inside
    for (const m of g.children.slice()) if (m.material === M.darkMetal() && m.geometry?.attributes?.position?.count < 200) g.remove(m); // old plain nozzle
    const nP = 16;
    for (let i = 0; i < nP; i++) {
      const a0 = (i / nP) * Math.PI * 2, da = (Math.PI * 2 / nP) * 0.62;
      const petal = new THREE.CylinderGeometry(r * 0.79, r * 0.6, r * 0.62, 3, 1, true, a0 - da, da * 2);
      petal.rotateX(-Math.PI / 2); petal.translate(0, 0, len + r * 0.3); b.add(petal, hot);
    }
    const inner = new THREE.CylinderGeometry(r * 0.76, r * 0.58, r * 0.6, 24, 1, true); inner.rotateX(-Math.PI / 2); inner.translate(0, 0, len + r * 0.3); inner.scale(-1, 1, 1); b.add(inner, dark);
    for (const [rr, z] of [[0.45, -0.05], [0.25, -0.12]]) { const t = new THREE.TorusGeometry(r * rr, 0.02, 6, 24); t.translate(0, 0, len + z); b.add(t, steel); }
  } else {
    for (const [rr, z] of [[0.4, 0.02]]) { const t = new THREE.TorusGeometry(r * rr, 0.015, 6, 20); t.translate(0, 0, len + z); b.add(t, steel); }
    const cone = new THREE.ConeGeometry(r * 0.25, r * 0.5, 16); cone.rotateX(Math.PI / 2); cone.translate(0, 0, len + 0.02); b.add(cone, dark);
  }
  b.to(g);
}

export function rocketDetail(g, { len, radius: r }) {
  const b = new Bag();
  for (const z of [0.15, 0.5, 0.85]) { const t = new THREE.TorusGeometry(r * 1.004, 0.012, 4, 28); t.translate(0, 0, len * z + r); b.add(t, M.darkMetal()); }
  b.to(g);
}

// ---------- landing gear ----------
// Wheel: tyre with sidewall bead, two-piece rim with hub boss, bolts and (braked wheels) a brake disc.
function wheelDetailed(r, w, brake) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag();
  const tire = new THREE.TorusGeometry(r * 0.72, r * 0.3, 14, 32); tire.rotateY(Math.PI / 2); tire.scale(w / (r * 0.6), 1, 1);
  b.add(tire, PM.tyre());
  for (const sx of [-1, 1]) {
    const bead = new THREE.TorusGeometry(r * 0.47, r * 0.035, 6, 28); bead.rotateY(Math.PI / 2); bead.translate(sx * w * 0.36, 0, 0); b.add(bead, M.aluminum());
    const rim = new THREE.CylinderGeometry(r * 0.46, r * 0.4, w * 0.12, 24); rim.rotateZ(sx * Math.PI / 2); rim.translate(sx * w * 0.33, 0, 0); b.add(rim, M.aluminum());
    const boss = new THREE.CylinderGeometry(r * 0.16, r * 0.2, w * 0.1, 14); boss.rotateZ(sx * Math.PI / 2); boss.translate(sx * w * 0.42, 0, 0); b.add(boss, M.aluminum());
    const cap = new THREE.CylinderGeometry(r * 0.07, r * 0.07, w * 0.06, 10); cap.rotateZ(Math.PI / 2); cap.translate(sx * w * 0.48, 0, 0); b.add(cap, M.steel());
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, bolt = new THREE.CylinderGeometry(r * 0.025, r * 0.025, w * 0.05, 6); bolt.rotateZ(Math.PI / 2); bolt.translate(sx * w * 0.42, Math.cos(a) * r * 0.27, Math.sin(a) * r * 0.27); nb.add(bolt, M.steel()); }
  }
  const core = new THREE.CylinderGeometry(r * 0.42, r * 0.42, w * 0.55, 20); core.rotateZ(Math.PI / 2); b.add(core, M.darkMetal());
  if (brake) { const disc = new THREE.CylinderGeometry(r * 0.36, r * 0.36, 0.02, 24); disc.rotateZ(Math.PI / 2); disc.translate(-w * 0.2, 0, 0); nb.add(disc, M.steel()); }
  b.to(g); nb.to(g, true);
  return g;
}

// Wheel spat (fixed gear): a teardrop shell round the upper two thirds of the wheel with a flat floor and a slot the
// tyre pokes through, a dark liner, a lip round the slot and a collar where each spring leg enters the shell.
// Frame: origin at the axle, forward -Z; the legs come down beside the tyre.
function wheelSpat(bag, { r, ww, paint, legs }) {
  const R0 = r * 1.02, y0 = r * 0.1, Hs = r * 1.05, W = ww / 2 + 0.045 + r * 0.09, cut = -r * 0.72;
  // side profile: blunt nose just ahead of the tyre, long tapering tail
  const fz = new THREE.SplineCurve([[-1.5, 0], [-1.35, 0.55], [-1.05, 0.88], [-0.6, 0.99], [0, 1], [0.7, 0.96], [1.3, 0.82], [1.9, 0.55], [2.4, 0.25], [2.75, 0]].map(([z, f]) => new THREE.Vector2(z * r, f))).getPoints(30);
  // section: ellipse on top, fuller (superellipse) below so the floor is wide enough for the tyre slot
  const sec = (f, ph) => { const c = Math.cos(ph), sn = Math.sin(ph), e = c < 0 ? 2 / 3 : 1; return V(W * f * Math.sign(sn) * Math.abs(sn) ** e, y0 + Hs * f * Math.sign(c) * Math.abs(c) ** e, 0); };
  const N = fz.length - 1, MS = 20, rings = [], outline = [];
  for (let k = 0; k <= N; k++) {
    const z = fz[k].x, f = Math.max(0.03, fz[k].y), q = f > 1e-4 ? (y0 - cut) / (Hs * f) : 2, al = q >= 1 ? Math.PI : Math.acos(-(q ** 1.5)), ring = [];
    for (let i = 0; i <= MS; i++) ring.push(sec(f, -al + (2 * al * i) / MS).setZ(z));
    rings.push(ring); outline.push([al >= Math.PI ? 0 : sec(f, al).x, z]);
  }
  const grid = (rs, flip) => { // rows = stations, cols = arc points (open strip)
    const pos = [], idx = [], C = rs[0].length;
    for (const r of rs) for (const p of r) pos.push(p.x, p.y, p.z);
    for (let k = 0; k < rs.length - 1; k++) for (let i = 0; i < C - 1; i++) { const a = k * C + i, b = a + 1, c = a + C + 1, d = a + C; flip ? idx.push(a, c, b, a, d, c) : idx.push(a, b, c, a, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  };
  // winding: the arc runs -x (left) over the top to +x with stations nose->tail: check one normal points up
  const shell = grid(rings, false), nY = shell.attributes.normal.getY(Math.floor(N / 2) * (MS + 1) + MS / 2);
  bag.add(nY > 0 ? shell : grid(rings, true), paint);
  const liner = rings.map((r) => r.map((p) => V(p.x * 0.975, y0 + (p.y - y0) * 0.975, p.z * 0.99)));
  bag.add(grid(liner, false), M.intake());
  // floor with the tyre slot (a shape in the x/z plane at y = cut)
  const sh = new THREE.Shape();
  outline.forEach(([x, z], i) => (i ? sh.lineTo(x, z) : sh.moveTo(x, z)));
  for (let k = N; k >= 0; k--) sh.lineTo(-outline[k][0], outline[k][1]);
  const ws = ww / 2 + 0.015, ls = Math.sqrt(Math.max(0.01, R0 * R0 - cut * cut)) + 0.03, rr = Math.min(ws, ls) * 0.9, hole = new THREE.Path(), slot = [];
  for (let i = 0; i <= 24; i++) { // rounded rectangle, counter-clockwise
    const q = Math.floor(i / 6.0001), t = (i - q * 6) / 6 * Math.PI / 2 + q * Math.PI / 2, cx = (q === 0 || q === 3 ? 1 : -1) * (ws - rr), cz = (q < 2 ? 1 : -1) * (ls - rr);
    slot.push([cx + Math.cos(t) * rr, cz + Math.sin(t) * rr]);
  }
  slot.forEach(([x, z], i) => (i ? hole.lineTo(x, z) : hole.moveTo(x, z))); sh.holes.push(hole);
  const floor = new THREE.ShapeGeometry(sh, 4); floor.rotateX(Math.PI / 2); floor.translate(0, cut, 0); // shape y -> world z, normal now faces -y
  bag.add(floor, paint);
  const fl = floor.clone(); fl.translate(0, 0.004, 0); bag.add(fl, M.intake());
  bag.add(tube(slot.map(([x, z]) => V(x, cut - 0.002, z)).concat([V(slot[0][0], cut - 0.002, slot[0][1])]), 0.009, 5, 48), M.rubber());
  // collars where the spring legs pass into the top of the shell (legs: [{ a, dir }] in this frame)
  for (const { a, dir } of legs) {
    const sAt = Math.abs(a.x) < W ? y0 + Hs * Math.sqrt(1 - (a.x / W) ** 2) * 0.97 : y0, t = (sAt - a.y) / (dir.y || 1);
    const hit = a.clone().addScaledVector(dir, t);
    bag.add(fairedBar(hit.clone().addScaledVector(dir, -0.03), hit.clone().addScaledVector(dir, 0.07), 0.07, 0.17), paint);
  }
}

// Streamlined strut from a to b: a teardrop section (round nose, tapering tail) w thick and c long, its long axis
// along fwd (projected square to the strut), so the thin side faces the airflow. Capped both ends.
const _sec = (() => { const n = 14, out = []; for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2, c = Math.cos(t); out.push([0.5 * Math.sin(t) * (c < 0 ? 1 + c * 0.45 : 1), c > 0 ? 0.42 * c : 0.58 * c]); } return out; })();
export function fairedBar(a, b, w, c, fwd = V(0, 0, -1), stations = [[0, 1], [1, 1]]) {
  const d = b.clone().sub(a), y = d.clone(); if (y.lengthSq() < 1e-10) y.set(0, 1e-5, 0); y.normalize();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y)); if (z.lengthSq() < 1e-6) z.set(0, 0, -1).addScaledVector(y, y.z); if (z.lengthSq() < 1e-6) z.set(1, 0, 0); z.normalize();
  const x = y.clone().cross(z).normalize();
  const ring = (p, k) => _sec.map(([sx, sz]) => p.clone().addScaledVector(x, sx * w * k).addScaledVector(z, sz * c * k));
  return ringLoft(stations.map(([t, k]) => ring(a.clone().addScaledVector(d, t), k)), true, true);
}
// Where a strut meets the skin: the strut flares out into a fairing that runs on into the skin (top: the skin point,
// dir: up the strut, n: the skin's outward normal), so the joint reads as one piece wherever the skin curves away.
export function strutFlare(top, dir, n, w, c, fwd) {
  const L = w * 2.5 + 0.05, e = 0.03 + c * 0.7 * (1 - Math.abs(n.dot(dir)));
  return fairedBar(top.clone().addScaledVector(dir, -L), top.clone().addScaledVector(dir, e), w, c, fwd, [[0, 1], [0.45, 1.08], [0.75, 1.35], [L / (L + e), 1.75], [1, 2]]);
}

// ---------- landing gear ----------
// A gear leg is built round its wheel frame: origin at the axle, +y up, -z forward, x along the axle. In the part
// (strut) frame that frame sits at y = -len, turned by route.q: the assembly pass (gearRoute.js) turns it so the wheel
// stands upright and rolls straight ahead whatever angle the part was placed at, and routes the legs from the wheel up
// to the skin they really meet (route.legs), plus braces to structure (route.braces). Without a route (part pictures)
// the legs run to the part origin as before.
const oleoK = 1.7; // chord / thickness of a faired oleo cylinder
function gearDims({ len, r, w, bogie }) {
  const ww = w || r * 0.6, ro = 0.04 + r * 0.085, cl = len - r * 1.25 - 0.08;
  const kind = bogie ? 'bogie' : r * 1.1 + 0.04 > len * 0.8 ? 'car' : 'oleo';
  return { ww, ro, cl, kind, gland: kind === 'bogie' ? len * 0.4 : kind === 'car' ? len * 0.5 : len - cl * 0.62 };
}
// Where the legs start, in the wheel frame. side: the side of the wheel a spring leg runs down (+1 / -1), or 0 for a
// yoke either side of the wheel (a gear on the centreline). Oleo legs start at the gland nut on the wheel's axis.
export function gearAnchors(o, side = -1) {
  if (o.fairing) { const x = gearDims(o).ww * 0.5 + 0.05, y = o.r * 0.05; return side ? [V(side * x, y, 0)] : [V(-x, y, 0), V(x, y, 0)]; }
  return [V(0, gearDims(o).gland, 0)];
}
function defaultRoute(o) {
  const { ro, cl, kind } = gearDims(o), T = V(0, -o.len, 0);
  const legs = gearAnchors(o, -1).map((a) => ({ a: a.clone().add(T), top: V(0, 0, 0) })), braces = [];
  if (kind === 'oleo' && !o.steer && !o.fairing && o.len > 1.2) braces.push({ a: V(0, -cl * 0.45, 0), b: V(0, 0, o.len * 0.38) });
  if (kind === 'bogie') braces.push({ a: V(0, -o.len * 0.32, 0), b: V(0, 0, o.len * 0.42) }, { a: V(0, -o.len * 0.25, 0), b: V(ro * 6, 0, 0) });
  return { q: new THREE.Quaternion(), side: -1, legs, braces, fwd: V(0, 0, -1) };
}

// Full gear leg. Same contract as parts.js gearLeg (origin = strut top, userData.strut / .wheels / .steer, wheels at
// y = -len), plus userData.wheelsFixed: fork, axle, piston and spat that follow the wheel up and down without spinning
// (planeDetail.updateDetail keeps them on the wheel; aircraft.js only spins the children of .wheels), and
// userData.reroute(route) for the assembly pass.
export function gearLegDetailed(o) {
  const g = new THREE.Group(), strut = new THREE.Group(), wheels = new THREE.Group(), fixed = new THREE.Group(), leg = new THREE.Group();
  wheels.position.y = -o.len; fixed.position.y = -o.len;
  strut.add(leg); if (!o.bogie) strut.add(fixed); strut.add(wheels); g.add(strut);
  g.userData.strut = strut; g.userData.wheels = wheels; g.userData.steer = !!o.steer; if (!o.bogie) g.userData.wheelsFixed = fixed;
  g.userData.gearLeg = { opts: o, anchors: (side) => gearAnchors(o, side), dims: gearDims(o) };
  g.userData.reroute = (route) => buildGearLeg(o, route, leg, fixed, wheels);
  buildGearLeg(o, null, leg, fixed, wheels);
  return g;
}
function clearGroup(grp) { for (const c of grp.children.slice()) { grp.remove(c); c.traverse((m) => m.geometry?.dispose()); } }
function buildGearLeg(o, route, leg, fixed, wheels) {
  for (const grp of [leg, fixed, wheels]) clearGroup(grp);
  const R = route || defaultRoute(o), { len, r, steer, color = 0xdddddd } = o, { ww, ro, cl, kind, gland } = gearDims(o);
  const paint = PM.skin(color), steel = M.steel(), chrome = M.chrome(), dark = M.darkMetal(), rub = M.rubber();
  // wheel frame <-> part frame
  const T = new THREE.Matrix4().compose(V(0, -len, 0), R.q, V(1, 1, 1)), Rq = new THREE.Matrix4().makeRotationFromQuaternion(R.q), Ti = T.clone().invert();
  const toL = (p) => p.clone().applyMatrix4(Ti), fwd = R.fwd;
  const lB = new Bag(), lN = new Bag(); // leg pieces in the wheel frame (strut)
  const sB = new Bag(), sN = new Bag(); // routed pieces, already in the part frame (strut)
  const fB = new Bag(), fN = new Bag(); // fork / spat / axle: wheel frame, ride with the wheel
  const fU = new Bag(), fUN = new Bag(); // piston and lower torque link: also raked with the leg about the fork crown
  const legs = R.legs.map((l) => ({ ...l, aL: toL(l.a), topL: toL(l.top), kneeL: l.knee ? toL(l.knee) : null }));
  // the legs: from the anchor (via a knee where the straight path was blocked) to the top, streamlined, plus boots
  const legW = o.fairing ? 0.036 : kind === 'bogie' ? ro * 3 : ro * 2, legC = o.fairing ? 0.12 : legW * oleoK;
  for (const l of legs) {
    const pts = [l.a, ...(l.knee ? [l.knee] : []), l.top];
    for (let i = 0; i < pts.length - 1; i++) sB.add(fairedBar(pts[i], pts[i + 1].clone().addScaledVector(pts[i + 1].clone().sub(pts[i]).normalize(), i < pts.length - 2 ? legW * 0.3 : 0), legW, legC, fwd), paint);
    if (l.knee) sB.add(new THREE.SphereGeometry(legW * 0.62, 12, 8).translate(l.knee.x, l.knee.y, l.knee.z), paint);
    if (l.n && R.boot) sB.add(strutFlare(l.top, l.top.clone().sub(pts.at(-2)).normalize(), l.n, legW, legC, fwd), paint);
    else { const up = l.top.clone().sub(pts.at(-2)).normalize(); sB.add(fairedBar(l.top.clone().addScaledVector(up, -0.05), l.top.clone().addScaledVector(up, 0.02), legW * 1.25, legC * 1.15, fwd), PM.metal('anodised')); } // collar
  }
  const lg0 = legs[0], segBot = lg0.a, segTop = lg0.knee || lg0.top; // first leg segment
  const aft = (a, b) => { const d = b.clone().sub(a).normalize(); return fwd.clone().negate().addScaledVector(d, fwd.dot(d)).normalize(); };
  // braces: streamlined, from the leg to structure
  for (const br of R.braces || []) sB.add(fairedBar(br.a, br.b, ro * (kind === 'bogie' ? 1.1 : 0.9), ro * (kind === 'bogie' ? 1.1 : 0.9) * oleoK, fwd), paint);
  if (o.fairing) {
    // spring-steel legs into a streamlined spat; a step on a single leg, brake line down its back
    if (legs.length === 1) {
      const p = segBot.clone().lerp(segTop, 0.5), upP = V(0, 1, 0).applyQuaternion(R.q), out = V(R.side > 0 ? 1 : -1, 0, 0).applyQuaternion(R.q);
      const step = new THREE.BoxGeometry(0.16, 0.012, 0.12); step.translate(0.08, 0, 0); step.applyMatrix4(new THREE.Matrix4().makeBasis(out, upP, out.clone().cross(upP).normalize()).setPosition(p));
      sN.add(step, M.aluminum()); sN.add(bar(p, p.clone().addScaledVector(out, 0.08), 0.02, 0.02, true, 5), steel);
      const af = aft(segBot, segTop); sN.add(tube([0.95, 0.5, 0.08].map((t) => segBot.clone().lerp(lg0.top, t).addScaledVector(af, 0.03)), 0.007, 4), rub);
    }
    wheelSpat(fB, { r, ww, paint, legs: legs.map((l) => ({ a: l.aL, dir: (l.kneeL || l.topL).clone().sub(l.aL).normalize() })) });
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.12, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
  } else if (kind === 'bogie') {
    // heavy bogie: faired oleo, gland, torque links; the beam and four wheels hang below and ride with the oleo
    lB.add(fairedBar(V(0, gland - 0.04, 0), V(0, gland + 0.04, 0), legW * 1.1, legC * 1.1), steel); // gland
    lN.add(bar(V(0, len * 0.42, -ro * 2.5), V(0, len * 0.3, -ro * 4), 0.07, 0.04), steel);
    const af = aft(segBot, segTop); sN.add(tube([0.9, 0.5, 0.1].map((t) => segBot.clone().lerp(segTop, t).addScaledVector(af, ro * 3.05)), 0.018, 5), rub);
    const piston = new THREE.CylinderGeometry(ro * 1.05, ro * 1.05, len * 0.5, 14); piston.translate(0, len * 0.25 + 0.05, 0); fU.add(piston, chrome);
    fUN.add(bar(V(0, len * 0.3, -ro * 4), V(0, len * 0.12, -ro * 1.2), 0.07, 0.04), steel);
    const beam = new THREE.CylinderGeometry(0.06 + r * 0.06, 0.06 + r * 0.06, r * 3.4, 12); beam.rotateX(Math.PI / 2); fB.add(beam, steel);
    for (const dz of [-1, 1]) { const ax = new THREE.CylinderGeometry(0.05 + r * 0.04, 0.05 + r * 0.04, ww * 2.1, 10); ax.rotateZ(Math.PI / 2); ax.translate(0, 0, dz * r * 1.2); fB.add(ax, steel); }
    for (const dz of [-1, 1]) for (const dx of [-1, 1]) { const wh = wheelDetailed(r, ww, true); wh.position.set(dx * ww * 0.75, 0, dz * r * 1.2).applyQuaternion(R.q); wh.quaternion.copy(R.q); wheels.add(wh); }
  } else if (kind === 'car') {
    // car / monster wheel: short upright, an arm out to the hub, a coil-over shock
    const cyl = new THREE.CylinderGeometry(ro, ro, len * 0.5, 12); cyl.translate(0, len * 0.75, 0); lB.add(cyl, paint);
    const coil = []; for (let k = 0; k <= 40; k++) { const a = k * 0.9; coil.push(V(Math.cos(a) * ro * 1.6, len - k / 40 * len * 0.45 - 0.02, Math.sin(a) * ro * 1.6)); }
    lN.add(tube(coil, 0.012, 4, 80), M.propTip());
    const piston = new THREE.CylinderGeometry(ro * 0.7, ro * 0.7, len * 0.6, 10); piston.translate(0, len * 0.3, 0); fB.add(piston, chrome);
    fB.add(bar(V(0, 0, 0), V(-(ww * 0.5 + 0.02), 0, 0), 0.07, 0.07, true, 8), steel);
  } else {
    // oleo: faired cylinder (the routed leg) + gland nut; chrome piston, fork crown, fork legs and axle ride with the wheel
    lB.add(fairedBar(V(0, gland - 0.018, 0), V(0, gland + 0.018, 0), legW * 1.12, legC * 1.12), steel); // gland nut
    const crown = r * 1.1 + 0.04; // fork crown height above the axle
    const pl = len - crown - cl * 0.35; // piston length (its top hides inside the cylinder)
    const piston = new THREE.CylinderGeometry(ro * 0.72, ro * 0.72, pl, 12); piston.translate(0, crown + pl / 2, 0); fU.add(piston, chrome);
    const cr = new THREE.BoxGeometry(ww + 0.12, 0.07, 0.1); cr.translate(0, crown, 0); fB.add(cr, steel);
    for (const sx of [-1, 1]) fB.add(bar(V(sx * (ww * 0.5 + 0.04), crown, 0), V(sx * (ww * 0.5 + 0.04), 0, 0), 0.03, 0.08), steel);
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.14, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
    // torque links (scissor) on the front of the oleo, with lugs on the cylinder and the fork crown and an apex pin
    const yL = len - cl * 0.52, zT = -ro * 1.5 - 0.02, apex = V(0, gland - 0.04 - (gland - crown) * 0.35, zT - Math.max(0.06, len * 0.08));
    lN.add(bar(V(0, yL, zT), apex, 0.03, 0.022), steel);
    fUN.add(bar(apex, V(0, crown + 0.02, zT), 0.03, 0.022), steel);
    lN.add(bar(V(0, yL, -ro * 0.5), V(0, yL, zT - 0.012), 0.05, 0.035), steel);
    fUN.add(bar(V(0, crown + 0.02, -0.03), V(0, crown + 0.02, zT - 0.012), 0.05, 0.035), steel);
    lN.add(bar(V(-0.02, apex.y, apex.z), V(0.02, apex.y, apex.z), 0.03, 0.03, true, 6), steel); // apex pin
    if (!steer) { // brake line down the back of the leg
      const af = aft(segBot, segTop); sN.add(tube([0.95, 0.5, 0.05].map((t) => segBot.clone().lerp(segTop, t).addScaledVector(af, ro * 2 + 0.01)), 0.009, 5), rub);
      fN.add(tube([V(0, crown + 0.2, ro * 1.2), V(-ww * 0.3, crown * 0.6, ro * 1.4), V(-(ww * 0.5 + 0.04), r * 0.2, 0.06)], 0.009, 5), rub);
    } else {
      const c = segBot.clone().lerp(segTop, 0.75), du = segTop.clone().sub(segBot).normalize(); // steering collar and actuator on the cylinder
      sB.add(fairedBar(c.clone().addScaledVector(du, -0.04), c.clone().addScaledVector(du, 0.04), legW * 1.3, legC * 1.25, fwd), steel);
      sN.add(bar(c, c.clone().add(V(ro * 2.6, 0.1, ro * 0.6).applyQuaternion(R.q)), 0.035, 0.035, true, 6), chrome);
    }
    if (steer && r < 0.3 && len > 0.6) { const mg = new THREE.TorusGeometry(r * 1.05, 0.02, 4, 16, Math.PI * 0.6); mg.rotateY(Math.PI / 2); mg.rotateX(-Math.PI * 0.2); fN.add(mg, dark); } // mudguard
  }
  if (kind !== 'bogie') { // one wheel: stood upright by its own rotation (aircraft.js spins it about x), ZYX so the spin comes first
    const wh = wheelDetailed(r, ww, !steer), e = new THREE.Euler().setFromQuaternion(R.q, 'ZYX');
    wh.rotation.set(0, e.y, e.z, 'ZYX'); wheels.add(wh);
  }
  // an oleo whose leg was raked (to clear a control surface) leans its gland, links and piston with it, about the crown
  const Cl = V(0, kind === 'bogie' ? 0 : r * 1.1 + 0.04, 0), u = kind === 'oleo' || kind === 'bogie' ? lg0.aL.clone().sub(Cl).normalize() : V(0, 1, 0);
  const Mu = new THREE.Matrix4().makeTranslation(Cl.x, Cl.y, Cl.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), u))).multiply(new THREE.Matrix4().makeTranslation(-Cl.x, -Cl.y, -Cl.z));
  const put = (bag, grp, near, m) => { const n0 = grp.children.length; bag.to(grp, near); for (const c of grp.children.slice(n0)) c.geometry.applyMatrix4(m); };
  const TU = T.clone().multiply(Mu), RU = Rq.clone().multiply(Mu);
  put(lB, leg, false, TU); put(lN, leg, true, TU); sB.to(leg); sN.to(leg, true);
  const fg = kind === 'bogie' ? wheels : fixed; put(fB, fg, false, Rq); put(fN, fg, true, Rq); put(fU, fg, false, RU); put(fUN, fg, true, RU);
}

// Float / skid struts. stations: z of the struts along the float (part frame), y: the float's top. Without the
// assembly pass they are posts up to the part origin; gearRoute.js calls userData.restrut(segs, boots, fwd) with
// struts routed up to the skin (N-struts, spreader bars), all in the part frame.
export function strutLegs(g, spec) {
  const grp = new THREE.Group(); g.add(grp);
  const build = (segs, boots = [], fwd = V(0, 0, -1)) => {
    clearGroup(grp);
    const b = new Bag(), fit = spec.kind === 'float' ? M.steel() : spec.paint;
    for (const s of segs) {
      const w = spec.w * (s.k || 1), c = spec.c * (s.k || 1);
      b.add(fairedBar(s.a, s.b, w, c, fwd), spec.kind === 'float' ? M.steel() : spec.paint);
      if (s.foot) { const d = s.b.clone().sub(s.a).normalize(); b.add(fairedBar(s.a.clone().addScaledVector(d, -0.02), s.a.clone().addScaledVector(d, 0.06), w * 1.5, c * 1.3, fwd), fit); } // clamp on the float / skid
    }
    for (const t of boots) b.add(strutFlare(t.p, t.dir, t.n, spec.w, spec.c, fwd), spec.kind === 'float' ? M.steel() : spec.paint);
    b.to(grp);
  };
  g.userData.strutLegs = spec;
  g.userData.restrut = build;
  build(spec.stations.map((z) => ({ a: V(0, spec.y, z), b: V(0, 0, z), foot: true })));
  return g;
}

// ---------- cockpits ----------
// Glass shapes shared with the assembly pass (skinBlend.js), which seats the canopy into the body skin.
export const FIGHTER_GLASS = [[-1.6, 0.02], [-0.8, 0.42], [0.3, 0.5], [1.4, 0.3], [2.0, 0.04]];
const _fgc = new THREE.SplineCurve(FIGHTER_GLASS.map(([z, r]) => new THREE.Vector2(z, r))).getPoints(48);
export const fighterGlassR = (z) => { if (z <= _fgc[0].x || z >= _fgc.at(-1).x) return 0; for (let i = 1; i < _fgc.length; i++) if (_fgc[i].x >= z) { const a = _fgc[i - 1], b = _fgc[i]; return Math.max(0, a.y + (b.y - a.y) * ((z - a.x) / (b.x - a.x || 1))); } return 0; };
// a frame bow following a glass cross-section: half-width w and height h of the section at z, from just below the base
function bowGeo(w, h, z, rad, y0 = -0.06) {
  const pts = [V(-w, y0, z)];
  for (let i = 0; i <= 16; i++) { const a = Math.PI * (i / 16); pts.push(V(-Math.cos(a) * w, Math.sin(a) * h, z)); }
  pts.push(V(w, y0, z));
  return tube(pts, rad, 6, 60);
}
// seat: a reclined, padded shell (back + pan) as a lofted section; headrest as a pillow
export function seatGeo(width, backH, panL, tilt) {
  // back: section is a shallow U (wings at the sides), swept up the back line
  const back = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6, y = backH * t, zb = Math.sin(tilt) * y, ring = [];
    for (const [x, dz] of [[-0.5, -0.07], [-0.42, 0.0], [0, 0.02], [0.42, 0.0], [0.5, -0.07], [0.46, 0.035], [0, 0.06], [-0.46, 0.035]]) ring.push(V(x * width * (1 - 0.12 * t), y * Math.cos(tilt), zb + dz));
    back.push(ring);
  }
  const g = ringLoft(back, true, true);
  const pan = new THREE.CapsuleGeometry(width * 0.42, width * 0.2, 4, 10); pan.rotateZ(Math.PI / 2); pan.scale(1, 0.3, 1.5 * panL / width); pan.translate(0, 0.02, -panL * 0.45);
  return mergeGeometries([norm(g), norm(pan)]);
}
// Detail build of the glazed cockpits. Replaces the plain part's boxes: everything inside fits under the glass.
// The glass carries a skirt below its base (hidden): skinBlend clips it to the body skin and shows it when seated.
export function cockpitBuild(id, color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = PM.skin(color), black = M.black(), seatM = PM.seat();
  if (id === 'ck_bubble') {
    const a = 0.45, bb = 1.0, c = 0.425;
    const dome = new THREE.SphereGeometry(1, 56, 22, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(a, c, bb);
    g.add(new THREE.Mesh(dome, PM.canopy()));
    const skirt = new THREE.Mesh((() => { const s = new THREE.CylinderGeometry(1, 1, 0.5, 56, 1, true); s.scale(a, 1, bb); s.translate(0, -0.25, 0); return s; })(), PM.canopy());
    skirt.visible = false; skirt.userData.glassSkirt = true; g.add(skirt);
    // windscreen bow and the rear hoop of the sliding hood (they follow the glass)
    for (const [z, rad] of [[-0.6, 0.018], [0.42, 0.014]]) { const k = Math.sqrt(1 - (z / bb) ** 2); b.add(bowGeo(a * k + 0.006, c * k + 0.006, z, rad), paint); }
    // tub fittings: seat, pilot, glare shield with the instrument panel under it, stick
    const st = seatGeo(0.36, 0.52, 0.34, 0.32); st.translate(0, -0.3, 0.42); b.add(st, seatM);
    const hrest = new THREE.CapsuleGeometry(0.06, 0.12, 4, 10); hrest.rotateZ(Math.PI / 2); hrest.scale(1, 1, 0.6); hrest.translate(0, 0.23, 0.6); b.add(hrest, seatM);
    g.userData.seats = [{ p: [0, -0.37, 0.3], s: 0.8 }]; // planeDetail seats a pilot here (crew.js)
    const gl = new THREE.CylinderGeometry(0.26, 0.26, 0.16, 18, 1, true, -1.25, 2.5); gl.scale(1, 1, 0.55); gl.rotateY(Math.PI); gl.translate(0, 0.08, -0.55); b.add(gl, black);
    const glTop = new THREE.CylinderGeometry(0.26, 0.26, 0.012, 18, 1, false, -1.25, 2.5); glTop.scale(1, 1, 0.55); glTop.rotateY(Math.PI); glTop.translate(0, 0.16, -0.55); b.add(glTop, black);
    const pnl = new THREE.PlaneGeometry(0.46, 0.2); pnl.rotateX(-0.25); pnl.translate(0, 0.02, -0.47); b.add(pnl, black);
    for (let i = 0; i < 5; i++) { const d = new THREE.CircleGeometry(0.032, 12); d.applyMatrix4(mx([-0.18 + i * 0.09, 0.04 - (i % 2) * 0.06, -0.462], [-0.25, 0, 0])); nb.add(d, PM.dial()); }
  } else if (id === 'ck_fighter') {
    const glass = revolveZ(smoothPts(FIGHTER_GLASS, 40), 48, 1.15);
    g.add(new THREE.Mesh(glass, PM.canopy(0x6b5524)));
    // windscreen bow (thick) and the canopy arch, following the glass section
    for (const [z, rad] of [[-0.62, 0.026], [0.78, 0.02]]) { const r = fighterGlassR(z); b.add(bowGeo(r + 0.006, r * 1.15 + 0.006, z, rad, -r * 0.35), paint); }
    // ejection seat: padded back, head box (inside the glass) with the yellow/black firing handle
    const st = seatGeo(0.42, 0.62, 0.4, 0.28); st.translate(0, -0.32, 0.52); b.add(st, seatM);
    const hb = new THREE.CapsuleGeometry(0.1, 0.16, 4, 10); hb.rotateZ(Math.PI / 2); hb.scale(1, 1.05, 0.8); hb.translate(0, 0.36, 0.72); b.add(hb, seatM);
    const handle = new THREE.TorusGeometry(0.06, 0.011, 4, 10, Math.PI); handle.translate(0, 0.42, 0.66); nb.add(handle, M.propTip());
    g.userData.seats = [{ p: [0, -0.42, 0.38], s: 0.88 }];
    const gl = new THREE.CylinderGeometry(0.3, 0.3, 0.18, 18, 1, true, -1.3, 2.6); gl.scale(1, 1, 0.6); gl.rotateY(Math.PI); gl.translate(0, 0.14, -0.6); b.add(gl, black);
    const glTop = new THREE.CylinderGeometry(0.3, 0.3, 0.012, 18, 1, false, -1.3, 2.6); glTop.scale(1, 1, 0.6); glTop.rotateY(Math.PI); glTop.translate(0, 0.23, -0.6); b.add(glTop, black);
    const pnl = new THREE.PlaneGeometry(0.52, 0.24); pnl.rotateX(-0.2); pnl.translate(0, 0.06, -0.5); b.add(pnl, black);
    for (let i = 0; i < 2; i++) { const d = new THREE.PlaneGeometry(0.13, 0.11); d.applyMatrix4(mx([-0.1 + i * 0.2, 0.06, -0.49], [-0.2, 0, 0])); nb.add(d, PM.dial()); }
    const hud = new THREE.PlaneGeometry(0.15, 0.13); hud.applyMatrix4(mx([0, 0.33, -0.62], [-0.35, 0, 0])); nb.add(hud, PM.canopy(0x3c6b52));
  }
  b.to(g); nb.to(g, true);
  return g;
}
// Detail build of the open cockpit: windscreen, coaming rim, a padded seat; the pilot (or driver) comes from crew.js.
export function openCockpitBuild(color) {
  const g = new THREE.Group(), b = new Bag();
  const ws = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 16, 1, true, -0.9, 1.8), PM.canopy()); ws.position.set(0, 0.12, -0.2); ws.rotation.y = Math.PI; g.add(ws);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 8, 24), PM.skin(color)); rim.rotation.x = Math.PI / 2; rim.scale.set(1, 1.4, 1); g.add(rim); g.userData.rim = rim;
  const st = seatGeo(0.4, 0.5, 0.36, 0.3); st.translate(0, -0.36, 0.32); b.add(st, PM.seat());
  const hrest = new THREE.CapsuleGeometry(0.06, 0.12, 4, 10); hrest.rotateZ(Math.PI / 2); hrest.scale(1, 1, 0.6); hrest.translate(0, 0.17, 0.48); b.add(hrest, PM.seat());
  b.to(g);
  g.userData.seats = [{ p: [0, -0.36, 0.16], s: 0.84 }];
  return g;
}
// small local copies of parts.js revolve helpers (parts.js imports this file)
function smoothPts(pts, n) { return new THREE.SplineCurve(pts.map(([z, r]) => new THREE.Vector2(z, r))).getPoints(n).map((p) => [p.x, Math.max(0, p.y)]); }
function revolveZ(prof, segs, sy) {
  const rings = prof.map(([z, r]) => { const ring = []; for (let i = 0; i < segs; i++) { const t = (i / segs) * Math.PI * 2; ring.push(V(Math.sin(t) * r, Math.cos(t) * r * sy, z)); } return ring; });
  return ringLoft(rings);
}

// Detail build of the car engine: a supercharged V8 (the plain part is three boxes). Front towards -Z. Block and heads in
// the part colour, chrome rocker covers, polished blower with its drive belt and pulleys, an injector hat with an open
// mouth, four-into-one headers on each bank sweeping down into the side pipes, timing cover, alternator, oil pan.
export function carEngineDetail(color) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), paint = M.paint(color), chrome = M.chrome(), alu = PM.metal('polished'), dark = M.darkMetal(), hot = PM.metal('hot'), black = M.black();
  // bottom end: block, oil pan, bell housing
  const block = new THREE.BoxGeometry(0.36, 0.26, 0.66); block.translate(0, 0.17, 0); b.add(block, paint);
  const pan = new THREE.BoxGeometry(0.28, 0.1, 0.56); pan.translate(0, 0.0, 0.02); b.add(pan, dark);
  const bell = new THREE.CylinderGeometry(0.17, 0.2, 0.12, 20); bell.rotateX(Math.PI / 2); bell.translate(0, 0.16, 0.38); b.add(bell, alu);
  // the V: two banks at 45 degrees, heads in the part colour, chrome rocker covers with breathers
  for (const sx of [-1, 1]) {
    const head = new THREE.BoxGeometry(0.17, 0.16, 0.64); head.applyMatrix4(mx([0, 0.06, 0])); head.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); b.add(head, paint);
    const cov = new THREE.CapsuleGeometry(0.06, 0.5, 4, 10); cov.rotateX(Math.PI / 2); cov.scale(1.25, 0.8, 1); cov.applyMatrix4(mx([0, 0.16, 0])); cov.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); b.add(cov, chrome);
    const br = new THREE.CylinderGeometry(0.025, 0.025, 0.06, 10); br.applyMatrix4(mx([0, 0.22, 0.15])); br.applyMatrix4(mx([sx * 0.15, 0.3, 0], [0, 0, -sx * Math.PI / 4])); nb.add(br, chrome);
    // headers: four primaries out of the outer face of the head, down and back into a collector, then the side pipe
    const outF = V(sx * 0.29, 0.31, 0);
    for (let k = 0; k < 4; k++) {
      const z = -0.24 + k * 0.16, p0 = V(outF.x, outF.y, z), p1 = V(sx * 0.36, 0.26, z), p2 = V(sx * 0.4, 0.12, z * 0.6 + 0.08), p3 = V(sx * 0.42, 0.08, 0.3);
      b.add(tube([p0, p1, p2, p3], 0.024, 8, 24), hot);
    }
    b.add(tube([V(sx * 0.42, 0.08, 0.28), V(sx * 0.42, 0.09, 0.45), V(sx * 0.42, 0.12, 0.75)], 0.05, 12, 16), chrome); // collector into the side pipe
    const tip = new THREE.CylinderGeometry(0.056, 0.05, 0.06, 14, 1, true); tip.rotateX(Math.PI / 2); tip.translate(sx * 0.42, 0.12, 0.77); b.add(tip, chrome);
    const soot = new THREE.CircleGeometry(0.048, 14); soot.translate(sx * 0.42, 0.12, 0.79); b.add(soot, PM.exhaust());
  }
  // intake manifold, the blower (ribbed case), injector hat with an open mouth and throttle butterflies
  const man = new THREE.BoxGeometry(0.22, 0.1, 0.56); man.translate(0, 0.43, 0); b.add(man, alu);
  const blower = new THREE.CapsuleGeometry(0.11, 0.42, 4, 14); blower.rotateX(Math.PI / 2); blower.scale(1.25, 0.85, 1); blower.translate(0, 0.56, 0.0); b.add(blower, alu);
  for (let k = 0; k < 7; k++) { const rib = new THREE.BoxGeometry(0.3, 0.012, 0.012); rib.translate(0, 0.65, -0.21 + k * 0.07); nb.add(rib, alu); }
  const hat = new THREE.BoxGeometry(0.26, 0.14, 0.3); hat.translate(0, 0.73, -0.02); b.add(hat, dark);
  const lip = new THREE.BoxGeometry(0.28, 0.02, 0.05); lip.translate(0, 0.81, -0.16); b.add(lip, chrome);
  const mouth = new THREE.PlaneGeometry(0.22, 0.1); mouth.rotateY(Math.PI); mouth.translate(0, 0.74, -0.171); b.add(mouth, black);
  for (const sx of [-0.06, 0.06]) { const fly = new THREE.CircleGeometry(0.035, 12); fly.rotateY(Math.PI); fly.rotateX(0.5); fly.translate(sx, 0.74, -0.15); nb.add(fly, alu); }
  // front: blower drive pulley and belt down to the crank pulley, timing cover, alternator
  const pul = (r, y, z, w = 0.05) => { const c = new THREE.CylinderGeometry(r, r, w, 18); c.rotateX(Math.PI / 2); c.translate(0, y, z); return c; };
  b.add(pul(0.075, 0.56, -0.3), alu); b.add(pul(0.1, 0.14, -0.37), alu); b.add(pul(0.035, 0.14, -0.4, 0.06), chrome);
  for (const sx of [-1, 1]) b.add(bar(V(sx * 0.08, 0.56, -0.31), V(sx * 0.1, 0.14, -0.37), 0.012, 0.05), black); // the belt
  const tc = new THREE.BoxGeometry(0.26, 0.24, 0.04); tc.translate(0, 0.2, -0.345); b.add(tc, paint);
  const alt = pul(0.06, 0.3, -0.3, 0.1); alt.translate(-0.17, 0, 0); b.add(alt, alu);
  // plug wires: a row of coloured leads from each head down the side of the block
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) nb.add(tube([V(sx * 0.22, 0.42, -0.24 + k * 0.16), V(sx * 0.27, 0.43, -0.2 + k * 0.16), V(sx * 0.3, 0.38, -0.2 + k * 0.16)], 0.008, 4, 6), M.paint(0xd21f1f, 'gloss'));
  b.to(g); nb.to(g, true);
  return g;
}
// Detail build of the airliner nose: the same skin of revolution, with the flight-deck windows cut into it facing
// forward (the plain part's windscreen patch faced sideways), framed panes, a dark flight deck behind them with the
// glare shield and panel, and two crew seats (crew.js seats the captain and first officer with their yokes).
// flight-deck windows: the canopy glass, darker and less mirror-like (at the low angles you see them from, the bubble
// canopy glass turned the windscreen milky white)
let _fdg = null;
export function flightDeckGlass() {
  if (_fdg) return _fdg;
  const base = PM.canopy(0x1c2a36); _fdg = base.clone();
  Object.assign(_fdg, { opacity: 0.45, envMapIntensity: 0.55, color: new THREE.Color(0x0f171e) });
  _fdg.onBeforeCompile = base.onBeforeCompile; _fdg.customProgramCacheKey = base.customProgramCacheKey;
  return _fdg;
}
export const AIRLINER_NOSE =[[-4.6, 0], [-4.4, 0.7], [-3.4, 1.4], [-1.8, 1.82], [0, 1.9]];
export function airlinerNoseBuild(color, skinMat) {
  const g = new THREE.Group(), b = new Bag(), nb = new Bag(), black = M.black();
  const prof = smoothPts(AIRLINER_NOSE, 46), yOff = (z) => z * -0.04;
  const rAt = (z) => { if (z <= prof[0][0]) return 0; for (let i = 1; i < prof.length; i++) if (prof[i][0] >= z) { const a = prof[i - 1], c = prof[i]; return a[1] + (c[1] - a[1]) * ((z - a[0]) / (c[0] - a[0] || 1)); } return prof.at(-1)[1]; };
  const at = (z, ph, dr = 0) => { const r = rAt(z) + dr; return V(Math.sin(ph) * r, Math.cos(ph) * r + yOff(z), z); };
  // window outline: azimuth from the top (phi, right = +), front and back edges sweep aft towards the sides
  const PH = 1.25, zf = (ph) => -3.82 + 0.6 * (ph / PH) ** 2, zb = (ph) => -3.22 + 0.68 * (ph / PH) ** 2;
  const inWin = (z, ph) => Math.abs(ph) <= PH && z >= zf(ph) && z <= zb(ph);
  // skin: the plain nose's surface (finer), minus the window triangles
  const SEG = 88, pos = [], uv = [], uv1 = [], idx = [], row = SEG + 1, circ = 2 * Math.PI * 1.9;
  for (const [z, r] of prof) for (let i = 0; i <= SEG; i++) { const th = (i / SEG) * Math.PI * 2; pos.push(Math.sin(th) * r, Math.cos(th) * r + yOff(z), z); uv.push((z + 4.6) / 4.6, i / SEG); uv1.push(z, (i / SEG) * circ); }
  const phOf = (i) => { const th = (i / SEG) * Math.PI * 2; return th > Math.PI ? th - Math.PI * 2 : th; };
  for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < SEG; i++) {
    const a = j * row + i, bb = (j + 1) * row + i, c = (j + 1) * row + i + 1, d = j * row + i + 1;
    const zc = (prof[j][0] + prof[j + 1][0]) / 2, pc = (phOf(i) + phOf(i + 1)) / 2;
    if (inWin(zc, pc)) continue;
    idx.push(a, bb, c, a, c, d);
  }
  { const ci = pos.length / 3, z = prof.at(-1)[0]; pos.push(0, yOff(z), z); uv.push(1, 0.5); uv1.push(z, 0); for (let i = 0; i < SEG; i++) idx.push(ci, (prof.length - 1) * row + i + 1, (prof.length - 1) * row + i); }
  const sk = new THREE.BufferGeometry(); sk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); sk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); sk.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2)); sk.setIndex(idx); sk.computeVertexNormals();
  g.add(new THREE.Mesh(sk, skinMat));
  // glass: the window patch just under the skin (the cut's stepped edge overlaps it), tinted
  const NA = 40, NZ = 10, gp = [], gi = [];
  for (let k = 0; k <= NZ; k++) for (let i = 0; i <= NA; i++) { const ph = -PH - 0.03 + (2 * PH + 0.06) * (i / NA), z = zf(ph) - 0.04 + (zb(ph) - zf(ph) + 0.08) * (k / NZ); gp.push(...at(z, ph, -0.012).toArray()); }
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NA; i++) { const a = k * (NA + 1) + i; gi.push(a, a + 1, a + NA + 1, a + 1, a + NA + 2, a + NA + 1); }
  const glass = new THREE.BufferGeometry(); glass.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)); glass.setIndex(gi); glass.computeVertexNormals();
  g.add(new THREE.Mesh(glass, flightDeckGlass()));
  // frames: the outline and the posts between the panes (black, like an airline's window mask)
  const loop = [];
  for (let i = 0; i <= 24; i++) { const ph = -PH + 2 * PH * (i / 24); loop.push(at(zf(ph), ph, 0.004)); }
  for (let i = 0; i <= 24; i++) { const ph = PH - 2 * PH * (i / 24); loop.push(at(zb(ph), ph, 0.004)); }
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, true), 160, 0.035, 5, true), black);
  for (const ph of [0, -0.45, 0.45, -0.86, 0.86]) { const pts = []; for (let k = 0; k <= 6; k++) pts.push(at(zf(ph) + (zb(ph) - zf(ph)) * (k / 6), ph, 0.004)); b.add(tube(pts, ph ? 0.026 : 0.034, 5, 20), black); }
  // wipers resting along the bottom of the two front panes
  for (const sx of [-1, 1]) nb.add(tube([at(zf(sx * 0.12) + 0.03, sx * 0.12, 0.02), at(zf(sx * 0.38) + 0.05, sx * 0.38, 0.02)], 0.012, 4, 6), black);
  // radome seam (the plain part's dark radome sphere poked through the skin as a black blotch), pitot probes, static ports
  const seam = new THREE.TorusGeometry(0.72, 0.012, 4, 32); seam.translate(0, yOff(-4.22), -4.22); b.add(seam, black);
  const alu = M.aluminum();
  for (const sx of [-1, 1]) {
    const pb = V(sx * 1.38, -0.15, -3.25);
    nb.add(bar(pb, pb.clone().add(V(sx * 0.13, -0.03, 0)), 0.03, 0.03, true, 6), alu);
    nb.add(bar(pb.clone().add(V(sx * 0.13, -0.03, 0.02)), pb.clone().add(V(sx * 0.13, -0.03, -0.22)), 0.022, 0.022, true, 6), alu);
    const sp = new THREE.CircleGeometry(0.05, 12); sp.applyMatrix4(mx([sx * 1.715, 0.05, -2.4], [0, sx * Math.PI / 2 * 0.92, 0])); nb.add(sp, alu);
  }
  // flight deck: dark lining (the inside of the skin), back bulkhead, floor, glare shield and panel, centre pedestal, seats
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.9, side: THREE.BackSide });
  const lin = []; for (const [z, r] of prof) if (z > -4.0 && z < -1.4) lin.push([z, r * 0.97]);
  const liner = revolveZ(lin, 32, 1); liner.translate(0, 0, 0); { const p2 = liner.attributes.position; for (let i = 0; i < p2.count; i++) p2.setY(i, p2.getY(i) + yOff(p2.getZ(i))); }
  g.add(new THREE.Mesh(liner, dark));
  const bulk = new THREE.CircleGeometry(rAt(-1.5) * 0.97, 32); bulk.rotateY(Math.PI); bulk.translate(0, yOff(-1.5), -1.5); b.add(bulk, M.paint(0x3a3d42, 'matte'));
  const floor = new THREE.BoxGeometry(2.2, 0.05, 2.4); floor.translate(0, -0.12, -2.7); b.add(floor, M.paint(0x34373c, 'matte'));
  const glare = new THREE.CylinderGeometry(1.05, 1.05, 0.08, 24, 1, false, -1.0, 2.0); glare.scale(1, 1, 0.45); glare.rotateY(Math.PI); glare.translate(0, 0.72, -3.25); b.add(glare, black);
  const pnl = new THREE.BoxGeometry(1.9, 0.5, 0.06); pnl.rotateX(-0.25); pnl.translate(0, 0.45, -3.5); b.add(pnl, M.paint(0x2b2d31, 'matte'));
  for (let i = 0; i < 6; i++) { const d = new THREE.PlaneGeometry(0.22, 0.18); d.applyMatrix4(mx([-0.75 + i * 0.3, 0.5, -3.465], [-0.25, 0, 0])); nb.add(d, PM.dial()); }
  const ped = new THREE.BoxGeometry(0.34, 0.42, 0.8); ped.translate(0, 0.1, -2.95); b.add(ped, M.paint(0x2b2d31, 'matte'));
  for (const sx of [-1, 1]) { const st = seatGeo(0.5, 0.75, 0.48, 0.2); st.translate(sx * 0.55, 0.18, -2.36); b.add(st, PM.seat()); }
  b.to(g); nb.to(g, true);
  g.userData.seats = [{ p: [0.55, 0.22, -2.6], s: 1 }, { p: [-0.55, 0.22, -2.6], s: 1 }];
  return g;
}
// Helicopter rotor head: grips, pitch links, swashplate.
export function rotorDetail(g, { R, blades, chord, mast }) {
  if (!mast) return;
  const b = new Bag(), nb = new Bag();
  const sw = new THREE.CylinderGeometry(chord * 0.75, chord * 0.75, 0.05, 18); sw.translate(0, mast * 0.72, 0); b.add(sw, M.steel());
  const sw2 = new THREE.CylinderGeometry(chord * 0.6, chord * 0.6, 0.04, 18); sw2.translate(0, mast * 0.78, 0); b.add(sw2, M.aluminum());
  for (let i = 0; i < blades; i++) { const a = (i / blades) * Math.PI * 2 + 0.4; nb.add(bar(V(Math.cos(a) * chord * 0.55, mast * 0.8, Math.sin(a) * chord * 0.55), V(Math.cos(a) * chord * 0.5, mast * 0.98, Math.sin(a) * chord * 0.5), 0.02, 0.02, true, 5), M.steel()); }
  b.to(g); nb.to(g, true); void R;
}

// Streamlined strut with clevis fittings at both ends.
export function strutDetail(g, color) {
  for (const c of g.children.slice()) g.remove(c);
  const b = new Bag(), nb = new Bag();
  const s = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12); s.scale(0.65, 1, 1.5); b.add(s, PM.skin(color));
  for (const sy of [-1, 1]) {
    const f = new THREE.BoxGeometry(0.035, 0.12, 0.08); f.translate(0, sy * 0.78, 0); b.add(f, PM.metal('anodised'));
    const bolt = new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6); bolt.rotateZ(Math.PI / 2); bolt.translate(0, sy * 0.8, 0); nb.add(bolt, M.steel());
  }
  b.to(g); nb.to(g, true);
}
