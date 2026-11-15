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
export function norm(g) {
  for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
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

// Full gear leg. Same contract as parts.js gearLeg (origin = strut top, userData.strut / .wheels / .steer, wheels at
// y = -len), plus userData.wheelsFixed: fork, axle, piston and spat that follow the wheel up and down without spinning
// (planeDetail.updateDetail keeps them on the wheel; aircraft.js only spins the children of .wheels).
export function gearLegDetailed({ len, r, w = null, color = 0xdddddd, fairing = false, bogie = false, steer = false }) {
  const g = new THREE.Group(), strut = new THREE.Group(), wheels = new THREE.Group(), fixed = new THREE.Group();
  wheels.position.y = -len; fixed.position.y = -len;
  const ww = w || r * 0.6, ro = 0.04 + r * 0.085, paint = PM.skin(color), steel = M.steel(), chrome = M.chrome(), dark = M.darkMetal(), rub = M.rubber();
  const sB = new Bag(), sN = new Bag(), fB = new Bag(), fN = new Bag();
  if (fairing) {
    // spring-steel leg (flat, tapered), meeting the wheel on its inboard side under a streamlined spat
    const top = V(0, 0, 0), bot = V(-(ww * 0.5 + 0.05), -len + r * 0.05, 0);
    const leg = bar(top, bot, 0.11, 0.032); sB.add(leg, paint);
    const step = new THREE.BoxGeometry(0.16, 0.012, 0.12); step.translate(bot.x * 0.55 - 0.08, -len * 0.55, 0); sN.add(step, M.aluminum()); sN.add(bar(V(bot.x * 0.55, -len * 0.55, 0), V(bot.x * 0.55 - 0.08, -len * 0.55, 0), 0.02, 0.02, true, 5), steel);
    sN.add(tube([V(0, -0.05, 0.02), V(bot.x * 0.5, -len * 0.5, 0.03), V(bot.x, -len + r * 0.25, 0.03)], 0.007, 4), rub);
    const spat = new THREE.LatheGeometry([[-r * 1.3, 0], [-r * 1.15, r * 0.3], [-r, r * 0.45], [-r * 0.5, r * 0.58], [0, r * 0.62], [r * 0.7, r * 0.5], [r * 1.5, 0.02]].map(([z, rr]) => new THREE.Vector2(rr, z)), 20);
    spat.rotateX(Math.PI / 2); spat.scale(0.55, 1, 1); fB.add(spat, paint);
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.12, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
  } else if (bogie) {
    // heavy bogie: oleo, side brace, torque links; the beam and four wheels hang below and ride with the oleo
    const cyl = new THREE.CylinderGeometry(ro * 1.5, ro * 1.5, len * 0.6, 14); cyl.translate(0, -len * 0.3, 0); sB.add(cyl, paint);
    const gland = new THREE.CylinderGeometry(ro * 1.65, ro * 1.65, 0.08, 14); gland.translate(0, -len * 0.6, 0); sB.add(gland, steel);
    sB.add(bar(V(0, -len * 0.32, 0), V(0, 0, len * 0.42), ro * 0.8, ro * 0.8, true, 8), paint); // drag brace
    sB.add(bar(V(0, -len * 0.25, 0), V(ro * 6, 0, 0), ro * 0.6, ro * 0.6, true, 8), paint); // side brace
    sN.add(bar(V(0, -len * 0.58, -ro * 1.5), V(0, -len * 0.7, -ro * 3.2), 0.07, 0.04), steel);
    sN.add(tube([V(0, -0.1, ro * 1.6), V(0, -len * 0.5, ro * 1.65), V(0, -len * 0.62, ro * 1.4)], 0.018, 5), rub);
    const piston = new THREE.CylinderGeometry(ro * 1.05, ro * 1.05, len * 0.5, 14); piston.translate(0, len * 0.25 + 0.05, 0); fB.add(piston, chrome);
    fN.add(bar(V(0, len * 0.3, -ro * 3.2), V(0, len * 0.12, -ro * 1.2), 0.07, 0.04), steel);
    const beam = new THREE.CylinderGeometry(0.06 + r * 0.06, 0.06 + r * 0.06, r * 3.4, 12); beam.rotateX(Math.PI / 2); fB.add(beam, steel);
    for (const dz of [-1, 1]) { const ax = new THREE.CylinderGeometry(0.05 + r * 0.04, 0.05 + r * 0.04, ww * 2.1, 10); ax.rotateZ(Math.PI / 2); ax.translate(0, 0, dz * r * 1.2); fB.add(ax, steel); }
    for (const dz of [-1, 1]) for (const dx of [-1, 1]) { const wh = wheelDetailed(r, ww, true); wh.position.set(dx * ww * 0.75, 0, dz * r * 1.2); wheels.add(wh); }
    // the bogie doesn't spin its wheels (aircraft.js), so the beam can ride in the wheels group itself
    fB.to(wheels); fN.to(wheels, true);
  } else if (r * 1.1 + 0.04 > len * 0.8) {
    // car / monster wheel: short upright, an arm out to the hub, a coil-over shock
    const cyl = new THREE.CylinderGeometry(ro, ro, len * 0.5, 12); cyl.translate(0, -len * 0.25, 0); sB.add(cyl, paint);
    const coil = []; for (let k = 0; k <= 40; k++) { const a = k * 0.9; coil.push(V(Math.cos(a) * ro * 1.6, -k / 40 * len * 0.45 - 0.02, Math.sin(a) * ro * 1.6)); }
    sN.add(tube(coil, 0.012, 4, 80), M.propTip());
    const piston = new THREE.CylinderGeometry(ro * 0.7, ro * 0.7, len * 0.6, 10); piston.translate(0, len * 0.3, 0); fB.add(piston, chrome);
    fB.add(bar(V(0, 0, 0), V(-(ww * 0.5 + 0.02), 0, 0), 0.07, 0.07, true, 8), steel);
  } else {
    // oleo: painted cylinder + gland nut on the strut; chrome piston, fork crown, fork legs and axle ride with the wheel
    const cl = len - r * 1.25 - 0.08; // cylinder length
    const cyl = new THREE.CylinderGeometry(ro, ro, cl * 0.62, 14); cyl.translate(0, -cl * 0.31, 0); sB.add(cyl, paint);
    const gland = new THREE.CylinderGeometry(ro * 1.12, ro * 1.12, 0.035, 14); gland.translate(0, -cl * 0.62, 0); sB.add(gland, steel);
    const collar = new THREE.CylinderGeometry(ro * 1.25, ro * 1.25, 0.05, 14); collar.translate(0, -0.03, 0); sB.add(collar, PM.metal('anodised'));
    const crown = r * 1.1 + 0.04; // fork crown height above the axle
    const piston = new THREE.CylinderGeometry(ro * 0.72, ro * 0.72, len - crown - cl * 0.35, 12); piston.translate(0, crown + (len - crown - cl * 0.35) / 2, 0); fB.add(piston, chrome);
    const cr = new THREE.BoxGeometry(ww + 0.12, 0.07, 0.1); cr.translate(0, crown, 0); fB.add(cr, steel);
    for (const sx of [-1, 1]) fB.add(bar(V(sx * (ww * 0.5 + 0.04), crown, 0), V(sx * (ww * 0.5 + 0.04), 0, 0), 0.045, 0.07), steel);
    const axle = new THREE.CylinderGeometry(0.025, 0.025, ww + 0.14, 8); axle.rotateZ(Math.PI / 2); fB.add(axle, steel);
    // torque links (scissor) on the front of the oleo
    const zT = -ro * 1.05 - 0.02, apex = V(0, -cl * 0.62 - 0.04 - (len - cl * 0.62 - crown) * 0.35, zT - Math.max(0.06, len * 0.08));
    sN.add(bar(V(0, -cl * 0.52, zT), apex, 0.03, 0.022), steel);
    fN.add(bar(apex.clone().sub(V(0, -len, 0)), V(0, crown + 0.02, zT), 0.03, 0.022), steel);
    if (!steer) { // brake line down the back of the leg
      sN.add(tube([V(0, -0.02, ro * 1.1), V(0, -cl * 0.3, ro * 1.15), V(0, -cl * 0.6, ro * 1.25)], 0.009, 5), rub);
      fN.add(tube([V(0, crown + 0.2, ro * 1.2), V(-ww * 0.3, crown * 0.6, ro * 1.4), V(-(ww * 0.5 + 0.04), r * 0.2, 0.06)], 0.009, 5), rub);
      if (len > 1.2) sB.add(bar(V(0, -cl * 0.45, 0), V(0, 0, len * 0.38), ro * 0.75, ro * 0.75, true, 8), paint); // drag brace
    } else {
      const sc = new THREE.CylinderGeometry(ro * 1.35, ro * 1.35, 0.08, 14); sc.translate(0, -cl * 0.2, 0); sB.add(sc, steel); // steering collar
      sN.add(bar(V(0, -cl * 0.2, 0), V(ro * 2.6, -cl * 0.08, ro * 0.6), 0.035, 0.035, true, 6), chrome); // steering actuator
    }
    if (steer && r < 0.3 && len > 0.6) { const mg = new THREE.TorusGeometry(r * 1.05, 0.02, 4, 16, Math.PI * 0.6); mg.rotateY(Math.PI / 2); mg.rotateX(-Math.PI * 0.2); fN.add(mg, dark); } // mudguard
  }
  if (!bogie) wheels.add(wheelDetailed(r, ww, !steer));
  sB.to(strut); sN.to(strut, true);
  if (!bogie) { fB.to(fixed); fN.to(fixed, true); strut.add(fixed); }
  strut.add(wheels); g.add(strut);
  g.userData.strut = strut; g.userData.wheels = wheels; g.userData.steer = steer; if (!bogie) g.userData.wheelsFixed = fixed;
  return g;
}

// ---------- cockpits ----------
export function cockpitDetail(id, g, color) {
  const b = new Bag(), nb = new Bag(), paint = PM.skin(color), black = M.black(), alu = M.aluminum();
  if (id === 'ck_bubble') {
    const hr = new THREE.BoxGeometry(0.36, 0.22, 0.1); hr.translate(0, 0.42, 0.52); b.add(hr, PM.seat());
    const coam = new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16, 1, false, -1.2, 2.4); coam.scale(1, 1, 0.5); coam.translate(0, 0.17, -0.6); b.add(coam, black);
    for (let i = 0; i < 5; i++) { const d = new THREE.CircleGeometry(0.035, 12); d.applyMatrix4(mx([-0.2 + i * 0.1, 0.1, -0.435], [0.3, Math.PI, 0])); nb.add(d, PM.dial()); }
    nb.add(bar(V(0, 0, -0.15), V(0, 0.3, -0.2), 0.025, 0.025, true, 6), black);
    // rails the canopy slides on
    for (const sx of [-1, 1]) nb.add(bar(V(sx * 0.43, 0.01, -0.6), V(sx * 0.43, 0.01, 0.9), 0.025, 0.02), alu);
  } else if (id === 'ck_fighter') {
    // windscreen bow + canopy frame arch, HUD combiner, ejection-seat head box with its yellow/black handle
    const bow = new THREE.TorusGeometry(0.43, 0.03, 6, 20, Math.PI); bow.scale(1, 1.15, 1); bow.applyMatrix4(mx([0, 0, -0.62], [0.25, 0, 0])); b.add(bow, paint);
    const arch = new THREE.TorusGeometry(0.47, 0.025, 6, 20, Math.PI); arch.scale(1, 1.15, 1); arch.translate(0, 0, 0.75); b.add(arch, paint);
    for (const sx of [-1, 1]) b.add(bar(V(sx * 0.44, 0.02, -1.5), V(sx * 0.44, 0.02, 1.9), 0.06, 0.05), paint);
    const hud = new THREE.PlaneGeometry(0.16, 0.14); hud.applyMatrix4(mx([0, 0.3, -0.62], [-0.35, 0, 0])); nb.add(hud, PM.canopy(0x3c6b52));
    const hb = new THREE.BoxGeometry(0.36, 0.2, 0.18); hb.translate(0, 0.62, 0.55); b.add(hb, PM.seat());
    const handle = new THREE.TorusGeometry(0.07, 0.012, 4, 10, Math.PI); handle.applyMatrix4(mx([0, 0.73, 0.45], [0, 0, 0])); nb.add(handle, M.propTip());
  } else if (id === 'ck_airliner') {
    // radome seam, windscreen frame posts and wipers, pitot probes and static ports on both cheeks
    const seam = new THREE.TorusGeometry(0.72, 0.012, 4, 32); seam.scale(1, 1, 1); seam.translate(0, 0.17, -4.22); b.add(seam, black);
    for (const a of [-0.55, -0.18, 0.18, 0.55]) nb.add(bar(V(Math.sin(a) * 1.62, 0.62, -2.25 + Math.abs(a) * 0.55), V(Math.sin(a) * 1.5, 1.08, -1.75 + Math.abs(a) * 0.4), 0.05, 0.05), black);
    for (const sx of [-1, 1]) {
      nb.add(bar(V(sx * 0.32, 0.6, -2.35), V(sx * 0.62, 0.72, -2.2), 0.025, 0.012), black);
      const pb = V(sx * 1.38, -0.15, -3.25);
      nb.add(bar(pb, pb.clone().add(V(sx * 0.13, -0.03, 0)), 0.03, 0.03, true, 6), alu);
      nb.add(bar(pb.clone().add(V(sx * 0.13, -0.03, 0.02)), pb.clone().add(V(sx * 0.13, -0.03, -0.22)), 0.022, 0.022, true, 6), alu);
      const sp = new THREE.CircleGeometry(0.05, 12); sp.applyMatrix4(mx([sx * 1.715, 0.05, -2.4], [0, sx * Math.PI / 2 * 0.92, 0])); nb.add(sp, alu);
    }
  }
  b.to(g); nb.to(g, true);
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
