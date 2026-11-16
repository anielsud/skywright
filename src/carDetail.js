// Car assembly (visual only): what a fabricator adds once the parts are bolted together. Run by planeDetail.assemble
// after the skins, fillets and gear exist, on any build with car wheels or car fittings, so a kid's own car gets the
// same as the stock ones:
//   - every car corner's suspension, rigged to move (carRig.js): independent wishbones, or a solid axle between a
//     mirrored pair (monster tyres, truck bodies): axle tubes from knuckle to knuckle through a diff housing with its
//     cover and pinion, a four-link to the chassis, the coil-overs landing on the tube, a tie rod between steered knuckles;
//   - the drivetrain: diff housings (on the axle, or hung under the body for independent corners) with half shafts
//     out to the hubs, a transfer case under the body and driveshafts to every diff;
//   - mud flaps behind every wheel of a body that carries them, hung on a bracket found on the real body;
//   - feet: the ends of cage tubes, light-bar legs, wing struts, guard tubes and chassis mounts carried to the surface
//     they stand on (ray cast against the built meshes) and welded there with a foot plate.
// Chassis mounts and brackets search the actual body with rays, sized from the body and the fitted wheels, so any
// size, position and mirroring works. Physics never sees any of it.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { M } from './materials.js';
import { V, bar, Bag, shell } from './partDetail.js';
import { Rig, cornerLinks, cornerGeometry } from './carRig.js';

const _mats = new Map();
const mat = (k, make) => { if (!_mats.has(k)) _mats.set(k, make()); return _mats.get(k); };
const linkPaint = () => mat('link', () => new THREE.MeshPhysicalMaterial({ color: 0x26272b, metalness: 0.35, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.12 }));
const housing = () => mat('housing', () => new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.6, roughness: 0.42 }));

// h: { valid, isBody, cast, solidMeshes, addTo, structure, near }
export function assembleCar(design, objs, root, h) {
  const parts = design.parts, corners = [], feet = [];
  root.updateMatrixWorld(true);
  const rig = new Rig(root), bags = new Map(), bag = (obj) => { if (!bags.has(obj)) bags.set(obj, new Bag()); return bags.get(obj); };
  const sOf = (o) => Math.cbrt(Math.abs(o.matrixWorld.determinant()));
  parts.forEach((p, i) => {
    if (!h.valid(i)) return; const o = objs[i], u = o.userData;
    if (u.feet) for (const f of u.feet) feet.push({ ...f, obj: o, p: V(...f.p), d: V(...f.d), parent: h.valid(p.parent) ? objs[p.parent] : null });
    if (!u.corner) return;
    u.corner.parentObj = h.valid(p.parent) ? objs[p.parent] : null;
    for (const c of o.children.slice()) if (c.userData.rigFallback) { o.remove(c); c.traverse((m) => m.geometry?.dispose()); }
    const bi = h.valid(p.parent) && h.isBody(parts[p.parent].id) ? p.parent : -1, s = sOf(o);
    corners.push({ i, p, o, c: u.corner, bi, s, r: u.corner.r * s, w: u.corner.w * s, hub: V().setFromMatrixPosition(u.wheelsFixed.matrixWorld) });
  });
  if (!corners.length && !feet.length) return null;
  // ---- corners, grouped by the body they hang from: mirrored pairs share an axle line
  const byBody = new Map();
  for (const k of corners) { if (k.bi < 0) { addCorner(k, null); continue; } if (!byBody.has(k.bi)) byBody.set(k.bi, []); byBody.get(k.bi).push(k); }
  const rs = sOf(root);
  function addCorner(k, solid) { const { links, feet: f } = cornerLinks(k.c, { solid, scale: k.s / rs }); for (const l of links) rig.link(l); for (const x of f) feet.push(x); }
  for (const [bi, list] of byBody) {
    // the body's metric frame (its axes, unscaled): sizes are metres whatever the body's size sliders say
    const body = objs[bi], B = body.matrixWorld, inv = B.clone().invert(), q = new THREE.Quaternion(), pw = V();
    B.decompose(pw, q, V()); const Bm = new THREE.Matrix4().compose(pw, q, V(1, 1, 1)), invM = Bm.clone().invert();
    const W = (x, y, z) => V(x, y, z).applyMatrix4(Bm), Mt = (w) => w.clone().applyMatrix4(invM), toBody = (m) => m.clone().applyMatrix4(Bm).applyMatrix4(inv);
    const bodyAt = (x, y, z) => ({ o: body, p: toBody(V(x, y, z)) });
    const up = V(0, 1, 0).transformDirection(Bm), back = V(0, 0, 1).transformDirection(Bm), side = V(1, 0, 0).transformDirection(Bm); // (unmirrored, like the metric frame)
    const bodyMeshes = h.solidMeshes(body);
    for (const k of list) k.hm = Mt(k.hub);
    // pairs: opposite sides, same height and station
    const used = new Set(), lines = [];
    for (const a of list) {
      if (used.has(a)) continue; used.add(a);
      const b = list.find((o) => !used.has(o) && Math.sign(o.hm.x) !== Math.sign(a.hm.x) && Math.abs(o.hm.x + a.hm.x) < 0.25 && Math.abs(o.hm.y - a.hm.y) < 0.15 && Math.abs(o.hm.z - a.hm.z) < 0.15 && Math.abs(a.hm.x) > 0.15);
      if (b) used.add(b);
      const ks = b ? [a, b] : [a], z = ks.reduce((t, o) => t + o.hm.z, 0) / ks.length;
      let line = lines.find((L) => Math.abs(L.z - z) < 0.3); if (!line) lines.push(line = { z, groups: [] }); line.groups.push(ks);
    }
    const rAvg = list.reduce((t, k) => t + k.r, 0) / list.length, sc = Math.min(1.7, Math.max(0.6, rAvg / 0.5));
    const castUp = (w, far = 4) => h.cast(bodyMeshes, w, up, far, true);
    // transfer case under the body, between the axle lines
    lines.sort((a, b) => a.z - b.z);
    const zc = lines.length > 1 ? (lines[0].z + lines.at(-1).z) / 2 : lines[0].z - Math.sign(lines[0].z || 1) * rAvg * 1.3;
    const yMin = Math.min(...list.map((k) => k.hm.y));
    let tc = null;
    { const hit = castUp(W(0, yMin, zc), 8);
      if (hit) {
        const cw = 0.26 * sc, ch = 0.22 * sc, cl = 0.34 * sc, top = Mt(hit.p), cy = top.y - ch / 2 - 0.012 * sc, g = new Bag();
        const box = new THREE.BoxGeometry(cw, ch, cl); box.applyMatrix4(frame(Bm, V(0, cy, zc))); g.add(box, housing());
        for (let k = -1; k <= 1; k++) { const rib = new THREE.BoxGeometry(cw * 1.06, ch * 0.08, ch * 0.08); rib.applyMatrix4(frame(Bm, V(0, cy + k * ch * 0.25, zc))); g.add(rib, housing()); }
        const plate = new THREE.BoxGeometry(cw * 1.5, 0.024 * sc, cl * 0.6); plate.applyMatrix4(frame(Bm, V(0, top.y - 0.01 * sc, zc))); g.add(plate, M.darkMetal());
        for (const dz of [-1, 1]) g.add(bar(W(0, cy, zc + dz * (cl / 2 - 0.01)), W(0, cy, zc + dz * (cl / 2 + 0.05 * sc)), 0.09 * sc, 0.09 * sc, true, 12), M.steel());
        tc = { y: cy, z: zc, cl: cl / 2 + 0.05 * sc };
        for (const [mm, geo] of g.merged()) bag(body).add(geo, mm);
      } }
    const caseOut = (z) => tc && bodyAt(0, tc.y, tc.z + (Math.sign(z - tc.z) || 1) * tc.cl);
    const shaft = (a, b, r) => { rig.link({ a, b, kind: 'rod', mat: M.steel(), r }); for (const [x, y] of [[a, b], [b, a]]) rig.link({ a: x, b: y, kind: 'rod', mat: M.darkMetal(), r: r * 1.7, len: r * 3.2 }); };
    for (const line of lines) for (const ks of line.groups) {
      const solid = ks.length === 2 && (PARTS[parts[bi].id].axles === 'solid' || ks.every((k) => PARTS[k.p.id].axle === 'solid'));
      const rt = 0.085 * (ks.reduce((t, k) => t + k.r, 0) / ks.length);
      if (solid) solidAxle(ks, rt, line); else indDiff(ks, rt, line);
    }
    // ---- a solid axle between a mirrored pair
    function solidAxle(ks, rt, line) {
      ks.sort((a, b) => a.hm.x - b.hm.x);
      const [A, Bk] = ks, obj = new THREE.Object3D(); root.add(obj);
      const hubA = { o: A.o.userData.wheelsFixed, p: V(), noRot: true }, hubB = { o: Bk.o.userData.wheelsFixed, p: V(), noRot: true };
      rig.axle({ obj, a: hubA, b: hubB, up: V(0, 1, 0).applyQuaternion(body.quaternion) }); obj.updateMatrixWorld(true);
      const AXi = obj.matrixWorld.clone().invert(), loc = (w) => w.clone().applyMatrix4(AXi);
      const kn = ks.map((k) => loc(V(cornerGeometry(k.c).kx, 0, 0).applyMatrix4(k.o.userData.wheelsFixed.matrixWorld)).x);
      const half = loc(Bk.hub).x, Rd = rt * 2.7, toCase = Math.sign(loc(W(0, A.hm.y, tc ? tc.z : 0)).z) || 1;
      const g = new Bag(), dark = housing(), chrome = M.chrome(), xl = Math.max(Rd * 1.3, half * 0.62);
      const tubeG = new THREE.CylinderGeometry(rt, rt, kn[1] - kn[0], 16); tubeG.rotateZ(Math.PI / 2); tubeG.translate((kn[0] + kn[1]) / 2, 0, 0); g.add(tubeG, dark);
      for (const x of kn) { const fl = new THREE.CylinderGeometry(rt * 1.7, rt * 1.7, rt * 0.7, 16); fl.rotateZ(Math.PI / 2); fl.translate(x - Math.sign(x) * rt * 0.3, 0, 0); g.add(fl, dark); }
      diffHousing(g, Rd, rt, toCase, dark, chrome);
      // truss on top of the tubes, link brackets underneath, shock tabs
      for (const sx of [-1, 1]) {
        g.add(bar(V(sx * Rd * 0.5, Rd * 0.55, 0), V(sx * xl, rt * 0.8, 0), rt * 0.35, rt * 0.9), dark);
        const br = new THREE.BoxGeometry(rt * 0.7, rt * 2.4, rt * 1.8); br.translate(sx * xl, -rt * 1.1, toCase * rt * 0.4); g.add(br, dark);
        const ut = new THREE.BoxGeometry(rt * 0.5, rt * 1.4, rt * 1.2); ut.translate(sx * Rd * 0.45, Rd * 0.75, toCase * rt * 0.3); g.add(ut, dark);
      }
      // corners: their coil-overs land on a tab on the tube right under the top mount
      for (const k of ks) {
        const G = cornerGeometry(k.c), T = loc(G.top.clone().applyMatrix4(k.o.matrixWorld)), x = Math.max(kn[0] + rt, Math.min(kn[1] - rt, T.x));
        const tab = new THREE.BoxGeometry(rt * 0.9, rt * 1.0, rt * 1.4); tab.translate(x, rt * 0.75, 0); g.add(tab, dark);
        addCorner(k, { o: obj, p: V(x, rt * 1.2, 0) });
      }
      // tie rod between steered knuckles (steering arms point aft in the hub frame)
      if (ks.every((k) => k.c.steer)) {
        const arm = (k) => ({ o: k.o.userData.wheelsFixed, p: V(cornerGeometry(k.c).kx - k.c.r * 0.06, -k.c.r * 0.1, k.c.r * 0.36) });
        rig.link({ a: arm(A), b: arm(Bk), kind: 'rod', mat: M.steel(), r: rt * 0.38 });
      }
      for (const [mm, geo] of g.merged()) { const m = new THREE.Mesh(geo, mm); m.castShadow = m.receiveShadow = true; m.userData.cosmetic = m.userData.joint = true; obj.add(m); }
      // four-link: lower links from the brackets, upper links from the diff, fore/aft to brackets under the body
      const ax = (p) => ({ o: obj, p }), Ll = Math.max(Rd * 3, half * 0.75);
      for (const [px, py, spread, kz] of [[xl, -rt * 1.9, 1, 1], [Rd * 0.45, Rd * 0.85, 2.4, 0.8]]) for (const sx of [-1, 1]) {
        const pm = Mt(V(sx * px, py, 0).applyMatrix4(obj.matrixWorld)), dz = Math.sign((tc ? tc.z : 0) - pm.z) || -Math.sign(pm.z) || 1;
        const hit = castUp(W(pm.x * spread, pm.y, pm.z + dz * Ll * kz)); if (!hit) continue; // lower links run straight fore/aft, upper links spread to the frame
        const end = hit.p.clone().addScaledVector(up, -rt * 1.4);
        bracket(bag(body), hit, end, rt * 0.7);
        rig.link({ a: ax(V(sx * px, py, 0)), b: { o: body, p: end.clone().applyMatrix4(inv) }, kind: 'rod', mat: linkPaint(), r: rt * 0.42 });
      }
      if (tc) shaft(caseOut(line.z), ax(V(0, 0, toCase * (Rd * 1.62 + rt * 0.3))), rt * 0.42);
    }
    // ---- independent corners: a diff hung under the body on the axle line, half shafts to each hub
    function indDiff(ks, rt, line) {
      const yH = Math.min(...ks.map((k) => k.hm.y)), hit = castUp(W(0, yH, line.z)); if (!hit) { for (const k of ks) addCorner(k, null); return; }
      const Rd = rt * 2.2, top = Mt(hit.p), cy = Math.max(top.y - Rd * 0.8, yH - Rd * 0.2), C = V(0, cy, line.z), toCase = tc ? Math.sign(tc.z - line.z) || 1 : -Math.sign(line.z) || 1;
      const g = new Bag(); diffHousing(g, Rd, rt, toCase, housing(), M.chrome(), true);
      for (const sx of [-1, 1]) { const f = new THREE.CylinderGeometry(rt * 1.1, rt * 1.1, Rd * 0.5, 14); f.rotateZ(Math.PI / 2); f.translate(sx * Rd * 0.95, 0, 0); g.add(f, housing()); }
      const M4 = frame(Bm, C); for (const [mm, geo] of g.merged()) bag(body).add(geo.applyMatrix4(M4), mm);
      bracket(bag(body), hit, W(0, cy, line.z), Rd * 0.7, true);
      for (const k of ks) {
        addCorner(k, null);
        const sx = Math.sign(k.hm.x) || 1, hub = { o: k.o.userData.wheelsFixed, p: V(cornerGeometry(k.c).kx, 0, 0) };
        shaft(bodyAt(sx * Rd * 1.2, cy, line.z), hub, rt * 0.5);
      }
      if (tc) shaft(caseOut(line.z), bodyAt(0, cy, line.z + toCase * (Rd * 1.62 + rt * 0.3)), rt * 0.42);
    }
    // ---- mud flaps
    if (PARTS[parts[bi].id].mudFlaps) for (const k of list) mudFlap(k, bodyMeshes, { up, back, side, color: parts[bi].color }, bag(body), h);
  }
  // ---- feet: carried down to whatever they stand on, welded with a plate
  const tcache = new Map(); for (const f of feet) foot(f, objs, h, bag(f.obj), tcache);
  for (const [obj, b] of bags) for (const [mm, geo] of b.merged()) h.addTo(obj, geo, mm);
  rig.build(h.near);
  return rig;
}

// a matrix placing body-local geometry at C (body axes, unscaled metres)
function frame(Bm, C) { return Bm.clone().multiply(new THREE.Matrix4().makeTranslation(C.x, C.y, C.z)); }

// Diff housing in its own frame (axle along x, up y, pinion towards z = toCase): the pumpkin, a domed cover with a bolt
// ring, ribs and a fill plug on the far side, the pinion snout with its yoke flange.
function diffHousing(g, Rd, rt, toCase, dark, chrome, small = false) {
  const p = new THREE.SphereGeometry(Rd, 22, 16); p.scale(1, 0.9, 0.82); g.add(p, dark);
  const zc = -toCase * Rd * 0.66, cov = new THREE.CylinderGeometry(Rd * 0.78, Rd * 0.84, Rd * 0.2, 24); cov.rotateX(Math.PI / 2); cov.translate(0, 0, zc); g.add(cov, chrome);
  const dome = new THREE.SphereGeometry(Rd * 0.74, 22, 8, 0, Math.PI * 2, 0, Math.PI * 0.42); dome.scale(1, 0.55, 1); dome.rotateX(-toCase * Math.PI / 2); dome.translate(0, 0, zc - toCase * Rd * 0.08); g.add(dome, chrome);
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, b = new THREE.CylinderGeometry(Rd * 0.04, Rd * 0.04, Rd * 0.08, 6); b.rotateX(Math.PI / 2); b.translate(Math.cos(a) * Rd * 0.72, Math.sin(a) * Rd * 0.72, zc - toCase * Rd * 0.12); g.add(b, M.steel()); }
  if (!small) for (const y of [-0.3, 0.3]) { const r = new THREE.BoxGeometry(Rd * 1.0, Rd * 0.06, Rd * 0.06); r.translate(0, y * Rd, zc - toCase * Rd * 0.3); g.add(r, chrome); }
  const plug = new THREE.CylinderGeometry(Rd * 0.08, Rd * 0.08, Rd * 0.1, 8); plug.rotateX(Math.PI / 2); plug.translate(Rd * 0.3, -Rd * 0.15, zc - toCase * Rd * (small ? 0.12 : 0.36)); g.add(plug, M.steel());
  const sn = new THREE.CylinderGeometry(rt * 1.05, rt * 1.5, Rd * 0.9, 16); sn.rotateX(toCase * Math.PI / 2); sn.translate(0, 0, toCase * Rd * 1.05); g.add(sn, dark);
  const yk = new THREE.CylinderGeometry(rt * 1.25, rt * 1.25, rt * 0.6, 16); yk.rotateX(Math.PI / 2); yk.translate(0, 0, toCase * (Rd * 1.5 + rt * 0.1)); g.add(yk, M.steel());
}

// a bracket hanging from a body hit (hit.p, hit.n) down to `end` (world): a square tab with a foot plate on the skin
function bracket(b, hit, end, w, round = false) {
  const n = hit.n.clone(); const into = hit.p.clone().addScaledVector(n, n.dot(end.clone().sub(hit.p)) > 0 ? -0.01 : 0.01);
  b.add(bar(into, end, w, w * (round ? 1 : 1.6), round, 8), M.darkMetal());
  plate(b, hit, end.clone().sub(hit.p).normalize(), w * 1.1);
}

// a welded foot plate on a surface hit (plate in the surface, a bead round the tube)
function plate(b, hit, d, r) {
  const n = hit.n.clone(); if (n.dot(d) > 0) n.negate(); // facing the tube
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), n);
  const pl = new THREE.CylinderGeometry(r * 1.6, r * 1.8, Math.max(0.008, r * 0.25), 14); pl.applyMatrix4(new THREE.Matrix4().compose(hit.p.clone().addScaledVector(n, 0.002), q, V(1, 1, 1))); b.add(pl, M.darkMetal());
  const bead = new THREE.TorusGeometry(r * 1.05, r * 0.2, 5, 14); bead.rotateX(Math.PI / 2); bead.applyMatrix4(new THREE.Matrix4().compose(hit.p.clone().addScaledVector(n, Math.max(0.008, r * 0.25) * 0.6), q, V(1, 1, 1))); b.add(bead, M.darkMetal());
}

// One foot: f = { obj, p, d (part-local), r, kind, mat, on: 'any' | 'body' | 'self', back }. The tube ends at p pointing
// along d; a ray from back up the tube finds the first surface it meets. A gap is closed with the same tube, a buried end
// gets its plate where the tube enters the skin.
function foot(f, objs, h, b, cache = new Map()) {
  const W = f.obj.matrixWorld, P = f.p.clone().applyMatrix4(W), D = f.d.clone().transformDirection(W).normalize(), s = Math.cbrt(Math.abs(W.determinant())), r = f.r * s;
  const key = f.obj.uuid + f.on; let targets = cache.get(key);
  if (!targets) {
    const own = new Set(); f.obj.traverse((m) => own.add(m));
    targets = f.on === 'self' ? [] : f.on === 'body' ? objs.filter((o, i) => o && o !== f.obj && h.valid(i) && h.isBody(h.ids[i])).flatMap((o) => h.solidMeshes(o)) : h.structure.filter((m) => !own.has(m));
    if (f.on === 'self') f.obj.traverse((m) => { if (m.isMesh && m.userData.footTarget) targets.push(m); });
    cache.set(key, targets);
  }
  const back = (f.back ?? 0.3) * s, reach = (f.reach ?? 1.2) * s, down = V(0, -1, 0).transformDirection(h.rootW).normalize();
  // along the tube first; else bent down, or in towards what it hangs from (a cage on a narrow body, a strut on a tail)
  // tiers, cheapest first; the first tier with a hit wins (nearest hit in it)
  const tiers = [() => [D], () => [D.clone().add(down).normalize(), D.clone().addScaledVector(down, 3).normalize()], () => {
    const par = f.parent, o = []; if (!par) return o;
    const c = new THREE.Box3().setFromObject(par).getCenter(V()), inw = c.sub(P); inw.addScaledVector(D, -inw.dot(D)); inw.addScaledVector(down, -inw.dot(down));
    if (inw.lengthSq() > 1e-6) { inw.normalize(); for (const k of [0.4, 1, 2.5]) o.push(D.clone().addScaledVector(inw, k).normalize(), down.clone().addScaledVector(inw, k).normalize()); }
    return o;
  }, () => { // a fan round the tube's own line (legs that straddle a cage rail)
    const a = Math.abs(D.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0), u = V().crossVectors(D, a).normalize(), v = V().crossVectors(D, u), o = [];
    for (const t of [0.35, 0.7]) for (let i = 0; i < 8; i++) { const ph = (i / 8) * Math.PI * 2; o.push(D.clone().multiplyScalar(Math.cos(t)).addScaledVector(u, Math.sin(t) * Math.cos(ph)).addScaledVector(v, Math.sin(t) * Math.sin(ph)).normalize()); }
    return o;
  }];
  let best = null;
  for (const tier of tiers) {
    for (const dir of tier()) {
      const from = P.clone().addScaledVector(dir, -back), hit = h.cast(targets, from, dir, back + reach, true);
      if (hit && (!best || hit.d < best.hit.d - 0.05 * s)) best = { hit, dir, from };
    }
    if (best) break;
  }
  if (!best) return;
  const { hit, dir } = best, gap = hit.d - back;
  if (gap > 0.003 * s) {
    const end = hit.p.clone().addScaledVector(dir, Math.min(0.012 * s, r)); // a little into the skin
    const g = f.kind === 'sq' ? bar(P.clone().addScaledVector(dir, -r * 0.5), end, r * 2, r * 2) : bar(P.clone().addScaledVector(dir, -r * 0.5), end, r * 2, r * 2, true, 10);
    b.add(g, f.mat);
  }
  plate(b, hit, dir, r);
}

function mudFlap(k, meshes, { up, back, side, color }, b, h) {
  const r = k.r, w = k.w, steer = k.c.steer, hub = k.hub, len = k.c.len * k.s;
  const clr = 0.05 * k.s + r * 0.04 + (steer ? w * 0.5 * Math.sin(0.62) : 0), z0 = r + clr;
  const fw = w * 1.08, top = r * 0.32, bot = -r * 0.72, H = top - bot, th = Math.max(0.012, r * 0.025), NX = 6, NY = 8;
  const sideS = side.clone().multiplyScalar(Math.sign(k.hm.x) || 1); // outwards
  const at = (x, t) => hub.clone().addScaledVector(side, x).addScaledVector(up, top - t * H).addScaledVector(back, z0 + r * 0.06 * t * t + r * 0.03 * t * t * (2 * x / fw) ** 2);
  const pos = [], idx = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) pos.push(...at((i / NX - 0.5) * fw, j / NY).toArray());
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, c = a + NX + 1; idx.push(a, c, a + 1, a + 1, c, c + 1); }
  let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  if (V(...[0, 1, 2].map((q) => g.attributes.normal.array[q])).dot(back) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  g = shell(g, th); b.add(g, M.rubber()); // (normals face back: the shell grows towards the tyre)
  // ribs across the back face, and a chrome badge with a star in the body colour near the bottom
  const bk = (t) => back.clone().multiplyScalar(r * 0.012);
  for (const t of [0.3, 0.45, 0.6]) b.add(bar(at(-fw * 0.42, t).add(bk(t)), at(fw * 0.42, t).add(bk(t)), r * 0.035, r * 0.02), M.rubber());
  const bc = at(0, 0.8).addScaledVector(back, r * 0.01), q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), back), br = fw * 0.15;
  const disc = new THREE.CylinderGeometry(br, br, r * 0.02, 20); disc.applyMatrix4(new THREE.Matrix4().compose(bc, q, V(1, 1, 1))); b.add(disc, M.chrome());
  const star = new THREE.Shape(); for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, rr = i % 2 ? br * 0.38 : br * 0.85; i ? star.lineTo(Math.sin(a) * rr, Math.cos(a) * rr) : star.moveTo(0, rr); }
  const sg = new THREE.ExtrudeGeometry(star, { depth: r * 0.012, bevelEnabled: false }), mz = new THREE.Matrix4().makeBasis(side, up, back).setPosition(bc.clone().addScaledVector(back, r * 0.01));
  sg.applyMatrix4(mz); b.add(sg, M.paint(color, 'gloss'));
  // the hanger: a bar along the top edge, bolted through, and a bracket to the nearest body or frame surface that
  // keeps clear of the tyre (wherever the wheel can go: up through its travel, round with the steering)
  const L0 = at(-fw * 0.5, 0), L1 = at(fw * 0.5, 0), mid = at(0, 0);
  b.add(bar(L0.clone().addScaledVector(sideS, 0), L1, r * 0.05, r * 0.05, true, 8), M.steel());
  for (const x of [-0.35, 0, 0.35]) { const bolt = new THREE.CylinderGeometry(r * 0.015, r * 0.015, th * 3, 6); bolt.applyMatrix4(new THREE.Matrix4().compose(at(x * fw, 0.04), q, V(1, 1, 1))); b.add(bolt, M.steel()); }
  const clear = (a, c) => { // does a straight bracket a->c stay out of the tyre's swept space?
    for (let t = 0; t <= 1; t += 0.05) {
      const p = a.clone().lerp(c, t).sub(hub), x = p.dot(side), y = p.dot(up), z = p.dot(back);
      if (Math.abs(x) > w / 2 + 0.04 * k.s) continue;
      const yy = Math.max(0, Math.min(y, len * 0.9)); if (Math.hypot(y - yy, z) < r + clr * 0.6) return false;
    }
    return true;
  };
  const search = (from) => {
    let best = null;
    for (const a of [0, 0.5, 1]) for (const f of [0, 1]) for (const i of [0, 0.5, 1]) {
      if (!a && !f && !i) continue;
      const d = up.clone().multiplyScalar(a).addScaledVector(back, -f).addScaledVector(sideS, -i).normalize();
      const hit = h.cast(meshes, from, d, 2.5 * k.s, true); if (!hit) continue;
      if ((!best || hit.d < best.d) && clear(from, hit.p)) best = hit;
    }
    return best;
  };
  // straight from the middle of the hanger, or (behind a tyre that rises right up past the body) along the hanger to a
  // knee just inboard of the tyre and up from there
  let best = null; { const hh = search(mid); if (hh) best = { hit: hh, len: hh.d, knee: null }; }
  if (!best || best.len > r * 0.6) for (const extra of [0.06, 0.25]) { // (only when there is no short straight stay)
    const K = mid.clone().addScaledVector(sideS, -(w / 2 + extra * k.s)), hh = search(K);
    if (hh && (!best || w / 2 + extra * k.s + hh.d < best.len)) { best = { hit: hh, len: w / 2 + extra * k.s + hh.d, knee: K }; break; }
  }
  if (!best) return;
  const from = best.knee || mid, end = best.hit.p.clone().addScaledVector(best.hit.p.clone().sub(from).normalize(), 0.01);
  if (best.knee) b.add(bar(L0.distanceTo(best.knee) < L1.distanceTo(best.knee) ? L0 : L1, best.knee, r * 0.05, r * 0.05, true, 8), M.steel());
  b.add(bar(from, end, r * 0.06, r * 0.06), M.darkMetal());
  plate(b, best.hit, end.clone().sub(from).normalize(), r * 0.05);
}
