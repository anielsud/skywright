// The people's body: one skinned human mesh (MakeHuman base mesh, CC0; assets/people/body.*, made by
// tools/people/mh_convert.py), posed onto the crew rig (crew.js) when a figure is built.
//
// The source is standing in MakeHuman's rest pose with its own 163-bone skeleton. Each source bone belongs to one rig
// segment (hips, spine, head, upper arm, forearm, hand, thigh, shin). A segment's frame in the source (origin at its
// root joint, +Y along it, -Z to the front / the inside of the bend, as the rig's bones) is moved onto the rig bone's
// rest transform, stretched along its length to the rig's limb length, so the rig's IK still puts the hands on the
// grips and the feet on the pedals. The hand goes to the rig's hand bone, which the rig places on its grip from this
// hand's measured parameters (handModel); the fingers wrap the grip's bar (its radius from the rig). Vertices blend
// the segment transforms with the source's own skin weights (linear blend skinning), then those weights are summed
// per rig bone for the runtime skeleton. Everything is computed once per figure kind and cached by crew.js.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
let BODY = null;
export const bodyReady = (async () => {
  try {
    const base = new URL('../assets/people/', import.meta.url);
    const [meta, bin] = await Promise.all([fetch(new URL('body.json', base)).then((r) => r.json()), fetch(new URL('body.bin', base)).then((r) => r.arrayBuffer())]);
    const n = meta.verts, t = meta.tris * 3; let o = 0;
    const pos = new Float32Array(bin, o, n * 3); o += n * 12;
    const idx = new Uint16Array(bin, o, t); o += t * 2;
    const bi = new Uint8Array(bin, o, n * 4); o += n * 4;
    const bw = new Uint8Array(bin, o, n * 4); o += n * 4;
    const eye = new Uint8Array(bin, o, n); o += n; o += (4 - (o % 4)) % 4;
    const jn = meta.jointVerts || 0, jpos = jn ? new Float32Array(bin, o, jn * 3) : null;
    const bones = meta.bones, byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    for (const b of bones) { b.h = V(...b.head); b.t = V(...b.tail); }
    let targets = null;
    if (meta.targets?.length) try {
      const tb = await fetch(new URL('targets.bin', base)).then((r) => r.arrayBuffer()), per = (n + jn) * 3;
      targets = Object.fromEntries(meta.targets.map((t, k) => [t.name, { d: new Int8Array(tb, k * per, per), s: t.scale }]));
    } catch (e) { console.warn('body targets unavailable: one body shape for everyone', e); }
    BODY = { id: 'base', n, pos, idx, bi, bw, eye, bones, byName, jn, jpos, joints: meta.joints, targets };
  } catch (e) { console.warn('body mesh unavailable, procedural crew instead', e); }
  return BODY;
})();
export const body = () => BODY;

// A person: the base body morphed by MakeHuman's macro targets, the way MakeHuman mixes them. p: { anc: [african,
// asian, caucasian] (weights, summing to 1), male (0..1), age (0 young .. 1 old), muscle, weight, height (-1..1) }.
// The skeleton's joints are re-derived from the morphed joint helpers, so the bones fit the new body. Cached by its
// parameters; without targets everyone is the base body.
const people = new Map();
export function person(p) {
  if (!BODY) return null; if (!BODY.targets || !p) return BODY;
  const key = JSON.stringify(p); if (people.has(key)) return people.get(key);
  const T = BODY.targets, n = BODY.n, jn = BODY.jn, w = [], add = (name, k) => { if (k > 1e-4 && T[name]) w.push([T[name], k]); };
  const m = p.male ?? 0.5, sexes = [['male', m], ['female', 1 - m]], age = p.age ?? 0;
  ['african', 'asian', 'caucasian'].forEach((r, k) => { for (const [sx, ws] of sexes) { add(`${r}-${sx}-young`, p.anc[k] * ws * (1 - age)); add(`${r}-${sx}-old`, p.anc[k] * ws * age); } });
  for (const [sx, ws] of sexes) {
    add(`universal-${sx}-young-averagemuscle-maxweight`, ws * Math.max(0, p.weight || 0));
    add(`universal-${sx}-young-minmuscle-minweight`, ws * Math.max(0, -(p.weight || 0)));
    add(`universal-${sx}-young-maxmuscle-averageweight`, ws * Math.max(0, p.muscle || 0));
    add(`height-${sx}-maxheight`, ws * Math.max(0, p.height || 0)); add(`height-${sx}-minheight`, ws * Math.max(0, -(p.height || 0)));
  }
  const pos = new Float32Array(BODY.pos), jp = new Float32Array(BODY.jpos);
  for (const [t, k] of w) { const f = t.s * k, d = t.d; for (let i = 0; i < n * 3; i++) pos[i] += d[i] * f; for (let i = 0; i < jn * 3; i++) jp[i] += d[n * 3 + i] * f; }
  const J = {}; for (const [name, ix] of Object.entries(BODY.joints)) { const c = V(); for (const i of ix) c.add(V(jp[i * 3], jp[i * 3 + 1], jp[i * 3 + 2])); J[name] = c.multiplyScalar(1 / ix.length); }
  const bones = BODY.bones.map((b) => ({ ...b, h: J[b.hj].clone(), t: J[b.tj].clone() }));
  const out = { ...BODY, id: key, pos, bones }; people.set(key, out); return out;
}

// source bone -> rig segment
function segmentOf(name) {
  const side = name.endsWith('.R') ? 'R' : name.endsWith('.L') ? 'L' : '';
  if (/^(root|pelvis)/.test(name) || name === 'spine05') return 'hips';
  if (/^(spine0[1-4]|clavicle|shoulder01|breast)/.test(name)) return 'spine';
  if (name === 'neck01') return 'spine';
  if (/^upperarm/.test(name)) return 'uArm' + side;
  if (/^lowerarm/.test(name)) return 'fArm' + side;
  if (/^(wrist|metacarpal|finger)/.test(name)) return 'hand' + side;
  if (/^upperleg/.test(name)) return 'thigh' + side;
  if (/^(lowerleg|foot|toe)/.test(name)) return 'shin' + side;
  return 'head'; // neck02/03, head, jaw, eyes, tongue, face muscles
}

// A frame: origin o, +Y along `dir`, +Z = -front (the rig's bones look down local -Z), as a matrix
function frame(o, dir, front) {
  const y = dir.clone().normalize(), z = front.clone().negate(); z.addScaledVector(y, -z.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize(); z.crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o);
}

// ---- the hand as parameters measured from the mesh, per side, in the hand's frame (origin at the wrist, +Y to the
// middle knuckle, +Z the back of the hand, X along the knuckle line; the rig's hand bones use the same frame) ----
//   gx, gy: where a gripped bar's axis crosses the palm (mid-knuckle line, across the distal palm crease 1.2 cm short
//           of the knuckles); palm: skin depth of the palm below the bone line there; finger: the finger's palm-side
//           flesh depth below its bone line;
//   thumb: which way along X the thumb lies (+1 / -1); G(r): the bar's centre for a bar of radius r (palm on it).
const handCache = new Map();
export function handModel(S = BODY, scale = 1.07) {
  if (!S) return null; const key = S.id + '|' + scale; if (handCache.has(key)) return handCache.get(key);
  const { bones: SB, byName: N } = S, J = (n, end = 'h') => SB[N[n]][end].clone().multiplyScalar(scale), out = {};
  for (const s of ['R', 'L']) {
    const wr = J('wrist.' + s), k2 = J('finger2-1.' + s), k5 = J('finger5-1.' + s), fy = J('finger3-1.' + s).sub(wr).normalize();
    const back = new THREE.Vector3().crossVectors(k5.clone().sub(k2), fy).normalize(); if (back.y < 0) back.negate(); // (the back of the hand is up in the rest pose)
    const src = frame(wr, fy, back.clone().negate()), inv = src.clone().invert(), L = (p) => p.clone().applyMatrix4(inv);
    const kn = [2, 3, 4, 5].map((f) => L(J(`finger${f}-1.${s}`)));
    const gx = (kn[0].x + kn[3].x) / 2, gy = kn.reduce((a, p) => a + p.y, 0) / 4 - 0.012;
    const thumb = Math.sign(L(J('finger1-2.' + s)).x - gx) || 1;
    const isPalm = SB.map((b) => segmentOf(b.name) === 'hand' + s && !/^finger/.test(b.name)), f32 = N['finger3-2.' + s];
    const a = J('finger3-2.' + s), ab = J('finger3-2.' + s, 't').sub(a), abl = ab.length(); ab.normalize();
    let palm = 0, fr = 0, fn = 0; const v = V();
    for (let i = 0; i < S.n; i++) {
      let wh = 0, wf = 0;
      for (let k = 0; k < 4; k++) { const w = S.bw[i * 4 + k] / 255, bi = S.bi[i * 4 + k]; if (isPalm[bi]) wh += w; if (bi === f32) wf += w; }
      if (wh < 0.5 && wf < 0.6) continue;
      v.set(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(scale);
      if (wh >= 0.5) { const l = L(v); if (Math.abs(l.y - gy) < 0.012 && Math.abs(l.x - gx) < 0.03) palm = Math.max(palm, -l.z); }
      if (wf >= 0.6) { const d = v.clone().sub(a), t = d.dot(ab); if (t > 0.2 * abl && t < 0.8 * abl) { const off = d.addScaledVector(ab, -t); if (off.dot(back) < 0) { fr = Math.max(fr, -off.dot(back)); fn = 1; } } } // (the palm-side flesh: what touches the bar)
    }
    out[s] = { src, inv, gx, gy, palm, finger: fn ? fr : 0.009, thumb, G: (r) => V(gx, gy, -(palm + r)) };
  }
  handCache.set(key, out); return out;
}

// The body's own proportions, measured from its joints (the rig takes them, so nothing is stretched): limb lengths,
// the shoulder and hip joints in the spine / hips frames, the thigh's top surface (above its bone, two thirds down)
// and the ankle's height above the sole.
const dimCache = new Map();
export function bodyDims(S = BODY, scale = 1.07) {
  if (!S) return null; const key = S.id + '|' + scale; if (dimCache.has(key)) return dimCache.get(key);
  const { bones: SB, byName: N } = S, J = (n) => SB[N[n]].h.clone().multiplyScalar(scale), FRONT = V(0, 0, -1);
  const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), neckB = J('neck01'), up = neckB.clone().sub(hipC);
  const sh = J('upperarm01.R'), el = J('lowerarm01.R'), wr = J('wrist.R'), hp = J('upperleg01.R'), kn = J('lowerleg01.R'), an = J('foot.R');
  const spine = up.length() - 0.03, shL = sh.clone().applyMatrix4(frame(hipC.clone().add(V(0, 0.03, 0)), up, FRONT).invert());
  const thF = frame(hp, kn.clone().sub(hp), FRONT).invert(), thigh = kn.distanceTo(hp), segOf = SB.map((b) => segmentOf(b.name));
  let thighTop = 0, sole = Infinity;
  for (let i = 0; i < S.n; i++) {
    const b = S.bi[i * 4], g = segOf[b]; if (g !== 'thighR' && g !== 'shinR') continue;
    const v = V(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(scale);
    if (g === 'thighR') { const l = v.clone().applyMatrix4(thF); if (l.y > 0.55 * thigh && l.y < 0.72 * thigh) thighTop = Math.max(thighTop, -l.z); }
    else sole = Math.min(sole, v.y);
  }
  const d = { upper: el.distanceTo(sh), fore: wr.distanceTo(el), thigh, shin: an.distanceTo(kn), spine, shoulderW: Math.abs(shL.x), shoulderUp: shL.y, shoulderZ: shL.z,
    hipW: Math.abs(hp.x - hipC.x), thighTop, ankleH: an.y - sole };
  dimCache.set(key, d); return d;
}

// A seated spine: the bend spread evenly over the four vertebra joints (spine04..spine01) about the body's side axis
// (flex, radians in all, forward), and the collarbones swung forward about the vertical (protract) as the shoulder
// blades come round when reaching. Returns per-bone source-space transforms (for the spine segment's bones) and where
// that leaves the shoulder joints and the neck, in the spine segment's frame (the rig puts its joints there).
const spineCache = new Map();
export function spinePose(DIM, flex = 0, protract = 0, S = BODY, scale = 1.07) {
  if (!S) return null; const key = [S.id, DIM.spine, flex, protract, scale].join('|'); if (spineCache.has(key)) return spineCache.get(key);
  const { bones: SB, byName: N } = S, J = (n) => SB[N[n]].h.clone().multiplyScalar(scale), FRONT = V(0, 0, -1);
  const rotAt = (P, axis, a) => new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, a)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
  const local = SB.map((b) => { // the rotation each bone itself contributes at its head
    if (/^spine0[1-4]$/.test(b.name)) return rotAt(b.h.clone().multiplyScalar(scale), V(1, 0, 0), -flex / 4);
    if (/^clavicle\./.test(b.name)) return rotAt(b.h.clone().multiplyScalar(scale), V(0, 1, 0), protract * Math.sign(b.t.x));
    return null; });
  const M = SB.map(() => null), world = (i) => { // the product down the chain (rest-pose pivots: root-most applied last)
    if (M[i]) return M[i]; const b = SB[i], par = b.parent != null && N[b.parent] != null ? world(N[b.parent]) : new THREE.Matrix4();
    return (M[i] = local[i] ? par.clone().multiply(local[i]) : par.clone()); };
  const boneM = SB.map((b, i) => (segmentOf(b.name) === 'spine' ? world(i) : null));
  const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), up = J('neck01').sub(hipC);
  const Ls = new THREE.Matrix4().makeScale(1, DIM.spine / (up.length() - 0.03), 1).multiply(frame(hipC.clone().add(V(0, 0.03, 0)), up, FRONT).invert());
  const at = (joint, via) => J(joint).applyMatrix4(world(N[via])).applyMatrix4(Ls);
  const out = { boneM, sh: { R: at('upperarm01.R', 'shoulder01.R'), L: at('upperarm01.L', 'shoulder01.L') }, neck: at('neck01', 'neck01'), key };
  spineCache.set(key, out); return out;
}

// The arm's rest relationships (the body's own rest pose, where nothing is twisted), per side: the upper arm's
// orientation in the spine's frame (uInSpine), and the hand's turn about the forearm's axis (twist0: the angle from
// the forearm frame's X to the hand frame's X, about the forearm's Y). A posed arm's real twists are measured against
// these: the humerus turning about its own axis, and the forearm (radius over ulna) between elbow and hand.
const restCache = new Map();
export function armRest(S = BODY, scale = 1.07) {
  if (!S) return null; const key = S.id + '|' + scale; if (restCache.has(key)) return restCache.get(key);
  const { bones: SB, byName: N } = S, J = (n, end = 'h') => SB[N[n]][end].clone().multiplyScalar(scale), FRONT = V(0, 0, -1), HM = handModel(S, scale);
  const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), up = J('neck01').sub(hipC);
  const qOf = (M) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
  const spineQ = qOf(frame(hipC.clone().add(V(0, 0.03, 0)), up, FRONT)), out = {};
  for (const s of ['R', 'L']) {
    const sh = J('upperarm01.' + s), el = J('lowerarm01.' + s), wr = J('wrist.' + s);
    const uQ = qOf(frame(sh, el.clone().sub(sh), FRONT)), fQ = qOf(frame(el, wr.clone().sub(el), FRONT)), hQ = qOf(HM[s].src);
    const hx = V(1, 0, 0).applyQuaternion(fQ.clone().invert().multiply(hQ));
    out[s] = { uInSpine: spineQ.clone().invert().multiply(uQ), twist0: Math.atan2(-hx.z, hx.x) };
  }
  restCache.set(key, out); return out;
}

// The torso's surface in its rig bones' local frames (as poseBody places it): { hips: [Vector3], spine: [Vector3] }.
// The rig uses it to sit the body in a seat: the buttocks on the cushion, the back against the seat back.
const torsoCache = new Map();
export function torsoPoints(DIM, SP = null, S = BODY, scale = 1.07) {
  if (!S) return null; const key = S.id + '|' + scale + '|' + DIM.spine + '|' + (SP ? SP.key : ''); if (torsoCache.has(key)) return torsoCache.get(key);
  const { bones: SB, byName: N } = S, J = (n) => SB[N[n]].h.clone().multiplyScalar(scale), FRONT = V(0, 0, -1);
  const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), neckB = J('neck01'), up = neckB.clone().sub(hipC);
  const Lh = frame(hipC, up, FRONT).invert();
  const Ls = new THREE.Matrix4().makeScale(1, DIM.spine / (up.length() - 0.03), 1).multiply(frame(hipC.clone().add(V(0, 0.03, 0)), up, FRONT).invert());
  const segOf = SB.map((b) => segmentOf(b.name)), out = { hips: [], spine: [] };
  for (let i = 0; i < S.n; i++) {
    let wh = 0, ws = 0; for (let k = 0; k < 4; k++) { const w = S.bw[i * 4 + k], g = segOf[S.bi[i * 4 + k]]; if (g === 'hips') wh += w; else if (g === 'spine') ws += w; }
    if (wh + ws < 200) continue; // (mostly torso)
    const v = V(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(scale);
    if (wh >= ws) out.hips.push(v.applyMatrix4(Lh)); else { const bm = SP && SP.boneM[S.bi[i * 4]]; if (bm) v.applyMatrix4(bm); out.spine.push(v.applyMatrix4(Ls)); }
  }
  torsoCache.set(key, out); return out;
}

// rig: { p: [Vector3], q: [Quaternion], B: bone ids, DIM }. Returns { pos, nrm, skinIndex, skinWeight, seg (per vertex
// rig segment name), along (0..1 along its segment), eye, index, head: { centre, radii } (head-bone local) }.
export function poseBody(rig, { grip = true, scale = 1.07, seat = { y: -0.09, back: 0.125 } } = {}) {
  const S = rig.body || BODY; if (!S) return null;
  const { bones: SB, byName: N } = S, { B, DIM } = rig, J = (n, end = 'h') => SB[N[n]][end].clone().multiplyScalar(scale);
  const FRONT = V(0, 0, -1), UP = V(0, 1, 0), HM = handModel(S, scale);
  const rigM = (i, at = null) => new THREE.Matrix4().compose(at || rig.p[i], rig.q[i], V(1, 1, 1));
  // segment frames in the source, the rig bone each goes to, and its length there
  const hipC = J('upperleg01.L').add(J('upperleg01.R')).multiplyScalar(0.5), neckB = J('neck01');
  const segs = {
    hips: { src: frame(hipC, neckB.clone().sub(hipC), FRONT), bone: B.hips, len: null },
    spine: { src: frame(hipC.clone().add(V(0, 0.03, 0)), neckB.clone().sub(hipC), FRONT), bone: B.spine, len: [neckB.distanceTo(hipC) - 0.03, DIM.spine] },
    head: { src: frame(neckB, J('head', 't').sub(neckB), FRONT), bone: B.head, len: null },
  };
  for (const s of ['R', 'L']) {
    const sh = J('upperarm01.' + s), el = J('lowerarm01.' + s), wr = J('wrist.' + s), hp = J('upperleg01.' + s), kn = J('lowerleg01.' + s), an = J('foot.' + s);
    const kk = s === 'R' ? '' : 'L';
    segs['uArm' + s] = { src: frame(sh, el.clone().sub(sh), FRONT), bone: B['uArm' + s], len: [el.distanceTo(sh), DIM.upper] };
    segs['fArm' + s] = { src: frame(el, wr.clone().sub(el), FRONT), bone: B['fArm' + s], len: [wr.distanceTo(el), DIM.fore] };
    segs['hand' + s] = { src: HM[s].src, bone: B['hand' + s], len: null }; // (the rig's hand bone: placed on its grip by the rig)
    segs['thigh' + s] = { src: frame(hp, kn.clone().sub(hp), FRONT), bone: B['thigh' + s], len: [kn.distanceTo(hp), DIM.thigh] };
    segs['shin' + s] = { src: frame(kn, an.clone().sub(kn), FRONT), bone: B['shin' + s], len: [an.distanceTo(kn), DIM.shin] };
    void kk;
  }
  // fingers round the grip (hand-local, then back to source space). The bar lies along the hand's X at (gy, -(palm+r)).
  // The fingers are made parallel (their spread closed about the palm normal), so each lies in a plane across the bar;
  // then each phalanx in turn rotates about the bar's direction, towards the bar, until its far joint touches the
  // bar's surface offset by the finger's radius (two circles intersecting), within the joint's range. The thumb is
  // first opposed under the palm (swung about the hand's axis till it lies across the bar), then wraps the same way
  // from the other side.
  const boneM = SB.map((b, i) => (rig.spine ? rig.spine.boneM[i] : null)); // (the seated spine's bend, if any)
  if (grip && rig.grips) for (const s of ['R', 'L']) {
    const gp = rig.grips[s]; if (!gp) continue;
    const H = HM[s], Hs = H.src, Hi = H.inv, Lp = (p) => p.clone().applyMatrix4(Hi), cy = H.gy, cz = -(H.palm + gp.r);
    const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1), wrapA = (x) => Math.atan2(Math.sin(x), Math.cos(x));
    const rotL = (P, axis, a) => new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, a)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
    // Each joint lands on the bar's offset circle further round it, in the direction the finger already travels round
    // the bar (so a phalanx is a chord of the wrap, never a cut across the bar); if the circle is out of reach, the
    // phalanx points at the bar.
    const wrap = (names, R, M0, lims) => {
      let M = M0.clone(), dir = 0;
      names.forEach((nm, k) => {
        const P = Lp(J(nm)).applyMatrix4(M), T = Lp(J(nm, 't')).applyMatrix4(M), uy = T.y - P.y, uz = T.z - P.z, l = Math.hypot(uy, uz);
        if (l > 1e-4) {
          const qy = P.y - cy, qz = P.z - cz, qd = Math.hypot(qy, qz), b0 = Math.atan2(uz, uy), th0 = Math.atan2(qz, qy);
          if (!dir) dir = Math.sign(qy * uz - qz * uy) || 1; // the way round the bar the finger goes
          const ratio = (R * R - qd * qd - l * l) / (2 * l * qd);
          let a;
          if (Math.abs(ratio) <= 1) {
            const dA = Math.acos(ratio); let best = null;
            for (const bb of [th0 + dA, th0 - dA]) { // the segment's direction for each intersection
              const ey = qy + l * Math.cos(bb), ez = qz + l * Math.sin(bb), adv = wrapA(Math.atan2(ez, ey) - th0) * dir;
              if (adv > 1e-4 && (best === null || adv < best.adv)) best = { adv, bb };
            }
            a = best ? wrapA(best.bb - b0) : wrapA(Math.atan2(-qz, -qy) - b0);
          } else a = qd > R ? wrapA(Math.atan2(-qz, -qy) - b0) : 0;
          M = rotL(P, X, THREE.MathUtils.clamp(a, -lims[k], lims[k])).multiply(M);
        }
        boneM[N[nm]] = Hs.clone().multiply(M).multiply(Hi);
      });
    };
    for (let f = 2; f <= 5; f++) {
      const n1 = `finger${f}-1.${s}`, P = Lp(J(n1)), u = Lp(J(n1, 't')).sub(P);
      wrap([n1, `finger${f}-2.${s}`, `finger${f}-3.${s}`], gp.r + H.finger, rotL(P, Z, Math.atan2(u.x, u.y)), [1.6, 1.9, 1.4]);
    }
    {
      const c = Lp(J('finger1-1.' + s)), P2 = Lp(J('finger1-2.' + s)), u = Lp(J('finger1-2.' + s, 't')).sub(P2);
      const pre = rotL(c, Y, wrapA(Math.PI - Math.atan2(u.x, u.z)));
      boneM[N['finger1-1.' + s]] = Hs.clone().multiply(pre).multiply(Hi);
      wrap(['finger1-2.' + s, 'finger1-3.' + s], gp.r + H.finger * 1.15, pre, [1.2, 1.4]);
    }
  }
  // segment transform: rig bone rest transform * stretch along Y * inverse(source frame)
  for (const [k, g] of Object.entries(segs)) {
    const st = g.len ? g.len[1] / g.len[0] : 1;
    g.M = rigM(g.bone).multiply(new THREE.Matrix4().makeScale(1, st, 1)).multiply(g.src.clone().invert());
    g.key = k;
  }
  // blend
  const n = S.n, pos = new Float32Array(n * 3), seg = new Array(n), along = new Float32Array(n), skI = new Uint16Array(n * 4), skW = new Float32Array(n * 4);
  const segOfBone = SB.map((b) => segs[segmentOf(b.name)] || segs.spine), v = V(), acc = V(), tmp = V();
  // The finger joints blend as dual quaternions (rigid transforms blended without the collapse linear blending gives
  // at a strongly bent knuckle); the rig segments then blend linearly as before.
  const toDQ = (M) => { const q = new THREE.Quaternion(), t = V(); M.decompose(t, q, V());
    return [q.x, q.y, q.z, q.w, 0.5 * (t.x * q.w + t.y * q.z - t.z * q.y), 0.5 * (-t.x * q.z + t.y * q.w + t.z * q.x), 0.5 * (t.x * q.y - t.y * q.x + t.z * q.w), -0.5 * (t.x * q.x + t.y * q.y + t.z * q.z)]; };
  const dq = boneM.map((M) => (M ? toDQ(M) : null));
  // with the rig in the body's own proportions every segment's transform is rigid, so the segments blend as dual
  // quaternions too (elbows and knees keep their volume instead of folding in); a stretched segment falls back to linear
  const rigid = Object.values(segs).every((g) => !g.len || Math.abs(g.len[1] / g.len[0] - 1) < 1e-3);
  for (const g of Object.values(segs)) g.dq = toDQ(g.M);
  const ID = [0, 0, 0, 1, 0, 0, 0, 0], bl = new Float64Array(8);
  const dqApply = (p) => { // p <- blended dual quaternion applied to p
    const n2 = Math.hypot(bl[0], bl[1], bl[2], bl[3]); for (let k = 0; k < 8; k++) bl[k] /= n2;
    const [x, y, z, w, dx, dy, dz, dw] = bl, q = new THREE.Quaternion(x, y, z, w);
    const tx = 2 * (-dw * x + dx * w - dy * z + dz * y), ty = 2 * (-dw * y + dx * z + dy * w - dz * x), tz = 2 * (-dw * z - dx * y + dy * x + dz * w);
    p.applyQuaternion(q).add(V(tx, ty, tz));
  };
  for (let i = 0; i < n; i++) {
    v.set(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(scale); acc.set(0, 0, 0);
    let anyF = false; for (let k = 0; k < 4; k++) if (S.bw[i * 4 + k] && dq[S.bi[i * 4 + k]]) anyF = true;
    if (anyF) {
      bl.fill(0); let ref = null;
      for (let k = 0; k < 4; k++) { const w = S.bw[i * 4 + k] / 255; if (w <= 0) continue; const d = dq[S.bi[i * 4 + k]] || ID;
        if (!ref) ref = d; const sg = (d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2] + d[3] * ref[3]) < 0 ? -w : w; for (let j = 0; j < 8; j++) bl[j] += d[j] * sg; }
      dqApply(v);
    }
    if (rigid) {
      bl.fill(0); let ref = null; const wsum2 = {}; let best2 = null, bw2 = -1;
      for (let k = 0; k < 4; k++) { const w = S.bw[i * 4 + k] / 255; if (w <= 0) continue; const g = segOfBone[S.bi[i * 4 + k]], d = g.dq;
        if (!ref) ref = d; const sg = (d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2] + d[3] * ref[3]) < 0 ? -w : w; for (let j = 0; j < 8; j++) bl[j] += d[j] * sg;
        wsum2[g.bone] = (wsum2[g.bone] || 0) + w; if (wsum2[g.bone] > bw2) { bw2 = wsum2[g.bone]; best2 = g; } }
      const pv = v.clone(); dqApply(pv); acc.copy(pv);
      pos[i * 3] = acc.x; pos[i * 3 + 1] = acc.y; pos[i * 3 + 2] = acc.z;
      seg[i] = best2 ? best2.key : 'spine'; if (best2 && best2.len) { const local = v.clone().applyMatrix4(best2.src.clone().invert()); along[i] = local.y / best2.len[0]; }
      const ent = Object.entries(wsum2).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = ent.reduce((s2, e) => s2 + e[1], 0) || 1;
      ent.forEach(([bn, w], k) => { skI[i * 4 + k] = +bn; skW[i * 4 + k] = w / tot; });
      continue;
    }
    const wsum = {}; let best = null, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = S.bw[i * 4 + k] / 255; if (w <= 0) continue;
      const b = S.bi[i * 4 + k], g = segOfBone[b];
      tmp.copy(v).applyMatrix4(g.M); acc.addScaledVector(tmp, w);
      wsum[g.bone] = (wsum[g.bone] || 0) + w; const gw = (wsum[g.bone]); if (gw > bw) { bw = gw; best = g; }
    }
    pos[i * 3] = acc.x; pos[i * 3 + 1] = acc.y; pos[i * 3 + 2] = acc.z;
    seg[i] = best ? best.key : 'spine';
    if (best && best.len) { const local = v.clone().applyMatrix4(best.src.clone().invert()); along[i] = local.y / best.len[0]; }
    const ent = Object.entries(wsum).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = ent.reduce((s, e) => s + e[1], 0) || 1;
    ent.forEach(([bn, w], k) => { skI[i * 4 + k] = +bn; skW[i * 4 + k] = w / tot; });
  }
  // contact with the seat: the rig's hip point sits on the cushion (procedural figures' pelvis reached 9 cm under it).
  // Flesh below the cushion flattens onto it, and (seated in a chair) the back flattens against the seat back, the
  // way a real body squashes into a seat instead of passing through it.
  if (seat) {
    const sp = rig.p[B.spine], sinv = new THREE.Matrix4().compose(sp, rig.q[B.spine], V(1, 1, 1)).invert(), sM = new THREE.Matrix4().compose(sp, rig.q[B.spine], V(1, 1, 1));
    for (let i = 0; i < n; i++) {
      const g = seg[i]; if (!(g === 'hips' || g === 'spine' || g.startsWith('thigh'))) continue;
      if (g !== 'spine' && pos[i * 3 + 1] < seat.y) { const d = seat.y - pos[i * 3 + 1]; pos[i * 3 + 1] = seat.y - d * 0.15; if (g.startsWith('thigh')) pos[i * 3 + 2] -= d * 0.1; }
      if (seat.back != null && (g === 'spine' || g === 'hips')) { tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(sinv); if (tmp.z > seat.back && tmp.y > -0.05) { tmp.z = seat.back + (tmp.z - seat.back) * 0.15; tmp.applyMatrix4(sM); pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z; } }
    }
  }
  // the head, in head-bone space (for hair, helmets and caps)
  const hinv = rigM(B.head).invert(), hb = new THREE.Box3();
  for (let i = 0; i < n; i++) if (seg[i] === 'head') { tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(hinv); if (tmp.y > 0.06) hb.expandByPoint(tmp); }
  const centre = hb.getCenter(V()), radii = hb.getSize(V()).multiplyScalar(0.5);
  return { pos, skinIndex: skI, skinWeight: skW, seg, along, eye: S.eye, index: S.idx, head: { centre, radii } };
}
