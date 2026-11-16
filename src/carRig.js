// Moving suspension for car parts (visual only). A car corner's wheel rides up and down (aircraft.js sets the wheel
// group's height from the spring compression, the steering turns it), and everything that joins a moving wheel to
// the chassis has to follow: A-arms pivot, coil springs squeeze, shocks telescope, half shafts and driveshafts swing,
// a solid axle tilts between its two wheels. A Rig keeps those pieces as links between anchors:
//   - an anchor is a point on an object (a part, a corner's static strut frame, its moving hub frame, an axle beam),
//     optionally ignoring the hub's steering (noRot), or a blend of two anchors ({ lerp: [a, b, t] }: a point on an arm);
//   - a link is a unit piece (rod, square tube, coil spring) stretched from one anchor to the other, or a fixed length
//     from the first anchor towards the second (a shock body);
//   - an axle is an object placed between two hub anchors every frame (housing, diff, brackets ride on it).
// Links are drawn as one InstancedMesh per piece kind and material for the whole vehicle (a handful of draw calls for
// every arm, spring and shaft), or baked into static geometry where nothing moves (part pictures, parked models).
// Nothing here is read by physics.
import * as THREE from 'three';
import { V, Bag, norm } from './partDetail.js';

const UNIT = new Map();
// unit pieces along +Y from 0 to 1, radius (half-width) 1
export function unitGeo(kind) {
  if (UNIT.has(kind)) return UNIT.get(kind);
  let g;
  if (kind === 'rod') { g = new THREE.CylinderGeometry(1, 1, 1, 10, 1); g.translate(0, 0.5, 0); }
  else if (kind === 'sq') { g = new THREE.BoxGeometry(2, 1, 2); g.translate(0, 0.5, 0); }
  else throw new Error('rig piece ' + kind);
  norm(g); UNIT.set(kind, g); return g;
}
// A coil spring of radius R and free length L0 (real size: stretching a unit coil would squash the wire with it), with
// closed (flat) end turns, wire 17 % of the coil radius, a turn every ~1.2 coil radii. Rigs scale it only along its axis.
function coilGeo(R, L0) {
  const key = 'coil:' + R.toFixed(4) + ':' + L0.toFixed(3); if (UNIT.has(key)) return UNIT.get(key);
  const turns = Math.max(4, Math.round(L0 / (R * 1.2))) + 1.5, N = Math.round(turns * 16), wire = R * 0.17, e = 0.75 / turns, pts = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N, a = t * turns * Math.PI * 2, end = wire * 2.1; // the first and last three-quarter turns lie flat
    const y = t < e ? (t / e) * end : t > 1 - e ? L0 - ((1 - t) / e) * end : end + ((t - e) / (1 - 2 * e)) * (L0 - 2 * end);
    pts.push(V(Math.cos(a) * R, y + wire, Math.sin(a) * R));
  }
  const g = norm(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, wire, 5, false)); g.userData.L0 = L0 + wire * 2;
  UNIT.set(key, g); return g;
}

const _y = V(0, 1, 0), _q = new THREE.Quaternion(), _s = V(), _d = V(), _m = new THREE.Matrix4(), _a = V(), _b = V();
export class Rig {
  constructor(root) { this.root = root; this.links = []; this.axles = []; this.meshes = []; }
  // anchor -> point in root space (null when its object has come off the vehicle: a part that broke away)
  pt(a, out = V()) {
    if (a.lerp) { const A = this.pt(a.lerp[0], V()), B = this.pt(a.lerp[1], V()); return A && B ? out.copy(A).lerp(B, a.lerp[2]) : null; }
    out.copy(a.p); let o = a.o;
    if (a.noRot) { out.add(o.position); o = o.parent; }
    for (; o && o !== this.root; o = o.parent) { o.updateMatrix(); out.applyMatrix4(o.matrix); }
    return o === this.root ? out : null;
  }
  // link: { a, b, kind, mat, r (radius / half-width), len (fixed length from a towards b), r2 (other radius for coils) }
  link(l) { this.links.push(l); return l; }
  // axle: { obj (a child of root), a, b (hub anchors), up (root-space up for the beam's roll reference) }
  axle(x) { this.axles.push(x); this.placeAxle(x); return x; }
  placeAxle(x) {
    const A = this.pt(x.a, _a), B = A && this.pt(x.b, _b); if (!A || !B) return false;
    const ax = _d.copy(B).sub(A); const L = ax.length(); if (L < 1e-4) return false; ax.divideScalar(L);
    const up = x.up.clone().addScaledVector(ax, -x.up.dot(ax)).normalize(), z = V().crossVectors(ax, up);
    x.obj.position.copy(A).add(B).multiplyScalar(0.5); x.obj.quaternion.setFromRotationMatrix(_m.makeBasis(ax, up, z));
    x.obj.updateMatrix(); return true;
  }
  matrixOf(l, out) {
    const A = this.pt(l.a, _a), B = A && this.pt(l.b, _b);
    if (!A || !B) return out.makeScale(0, 0, 0);
    const d = _d.copy(B).sub(A), L = d.length(); if (L < 1e-5) return out.makeScale(0, 0, 0);
    d.divideScalar(L); _q.setFromUnitVectors(_y, d);
    if (l.kind === 'coil') return out.compose(A, _q, _s.set(1, L / this.geoOf(l).userData.L0, 1));
    const len = l.len ? Math.min(l.len, L * 1.02) : L;
    return out.compose(A, _q, _s.set(l.r, len, l.r));
  }
  // the piece's geometry; a coil is made to measure at its rest length (the first time it is asked for: at rest)
  geoOf(l) {
    if (l.kind !== 'coil') return unitGeo(l.kind);
    if (!l.geo) { const A = this.pt(l.a, V()), B = A && this.pt(l.b, V()), L = A && B ? A.distanceTo(B) : l.r * 6; l.geo = coilGeo(l.r, Math.round(Math.max(l.r, L) * 200) / 200); }
    return l.geo;
  }
  // The links' instanced meshes (near: flight/hangar) or static geometry under root (parked models: nothing moves).
  build(near = true) {
    const kinds = new Map();
    for (const l of this.links) { const geo = this.geoOf(l), k = geo.uuid + ':' + l.mat.uuid; if (!kinds.has(k)) kinds.set(k, { geo, mat: l.mat, list: [] }); kinds.get(k).list.push(l); }
    if (!near) { const b = new Bag(); this.bake(b); for (const [mat, g] of b.merged()) this.root.add(tag(new THREE.Mesh(g, mat))); this.links = []; return; }
    for (const { geo, mat, list } of kinds.values()) {
      const m = new THREE.InstancedMesh(geo, mat, list.length); m.frustumCulled = false; tag(m);
      m.userData.rigLinks = list; this.root.add(m); this.meshes.push(m);
    }
    this.update();
  }
  update() {
    for (const x of this.axles) this.placeAxle(x);
    for (const m of this.meshes) { const L = m.userData.rigLinks; for (let i = 0; i < L.length; i++) m.setMatrixAt(i, this.matrixOf(L[i], _m)); m.instanceMatrix.needsUpdate = true; m.boundingBox = null; m.boundingSphere = null; }
  }
  // static copy of the links into a Bag (a corner on its own: part pictures, no assembly)
  bake(bag) { for (const l of this.links) bag.add(this.geoOf(l).clone(), l.mat, this.matrixOf(l, new THREE.Matrix4())); }
}
function tag(m) { m.userData.cosmetic = true; m.userData.joint = true; m.userData.rig = true; m.castShadow = true; m.receiveShadow = true; return m; }

// ---------- a car corner's own suspension ----------
// u: the corner's userData.corner { r, w, len, arm, strut, fixed, mats } (all in the part's own units: anchors live in
// the part's frames, so any size and mirroring follow). Independent suspension: upper and lower wishbones from two
// inboard pivots each to ball joints on the knuckle (which steers), a coil-over from a top mount down to a cross bar
// between the lower arms. Returns { links, feet } (feet: chassis mounts the assembly carries to the real body).
export function cornerGeometry(c) {
  const { r, w, len, arm } = c, kx = -w * 0.36, xp = -w / 2 - arm, xi = -(w / 2 + r * 0.22), zp = r * 0.56;
  return { kx, xp, xi, zp, U: V(kx, r * 0.26, 0), L: V(kx, -r * 0.2, 0), yU: -len + r * 0.3, yL: -len - r * 0.14, top: V(xi, -0.03, 0) };
}
export function cornerLinks(c, { solid = null, scale = 1 } = {}) { // scale: the part's size in the rig's (root) frame
  const G = cornerGeometry(c), S = c.strut, F = c.fixed, m = c.mats, links = [], feet = [];
  const at = (o, p, noRot = false) => ({ o, p: p.clone(), noRot });
  const T = at(S, G.top);
  let low;
  if (!solid) {
    const U = at(F, G.U), L = at(F, G.L), ra = c.r * 0.034;
    for (const sz of [-1, 1]) {
      links.push({ a: at(S, V(G.xp, G.yU, sz * G.zp)), b: U, kind: 'rod', mat: m.arm, r: ra });
      links.push({ a: at(S, V(G.xp, G.yL, sz * G.zp)), b: L, kind: 'rod', mat: m.arm, r: ra * 1.15 });
      // the pivots hang from the chassis on a square tube (the assembly carries it up to the body)
      feet.push({ obj: c.part, p: V(G.xp, G.yL, sz * G.zp).applyMatrix4(S.matrix), d: V(0, 1, 0), r: c.r * 0.045, kind: 'sq', mat: m.dark, on: 'any' });
    }
    const t = (G.xi - G.xp) / (G.kx - G.xp), pm = at(S, V(G.xp, G.yL, 0));
    low = { lerp: [pm, L, t] };
    links.push({ a: { lerp: [at(S, V(G.xp, G.yL, G.zp)), L, t] }, b: { lerp: [at(S, V(G.xp, G.yL, -G.zp)), L, t] }, kind: 'rod', mat: m.arm, r: ra * 1.2 }); // shock cross bar
  } else low = solid; // a solid axle: the shock's lower eye is on the axle tube
  // coil-over: body (fixed length) on the top mount, chrome shaft up from the lower eye, coil between the spring perches
  const rest = c.len + c.r * 0.14;
  links.push({ a: T, b: low, kind: 'rod', mat: m.shock, r: c.r * 0.085, len: rest * 0.52 });
  links.push({ a: low, b: T, kind: 'rod', mat: m.chrome, r: c.r * 0.038, len: rest * 0.62 });
  links.push({ a: { lerp: [T, low, 0.08] }, b: { lerp: [T, low, 0.9] }, kind: 'coil', mat: m.spring, r: c.r * 0.13 });
  links.push({ a: { lerp: [T, low, 0.9] }, b: low, kind: 'rod', mat: m.dark, r: c.r * 0.05 }); // lower eye / perch
  feet.push({ obj: c.part, p: G.top.clone().applyMatrix4(S.matrix), d: V(0, 1, 0), r: c.r * 0.1, kind: 'rod', mat: m.dark, on: 'any' });
  for (const l of links) { l.r *= scale; if (l.len) l.len *= scale; }
  return { links, feet, G };
}
