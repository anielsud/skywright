// The people's body: one skinned human mesh (MakeHuman base mesh, CC0; assets/people/body.*, made by
// tools/people/mh_convert.py), posed onto the crew rig (crew.js) when a figure is built.
//
// The source is standing in MakeHuman's rest pose with its own 163-bone skeleton. Each source bone belongs to one rig
// segment (hips, spine, head, upper arm, forearm, hand, thigh, shin). A segment's frame in the source (origin at its
// root joint, +Y along it, -Z to the front / the inside of the bend, as the rig's bones) is moved onto the rig bone's
// rest transform, stretched along its length to the rig's limb length, so the rig's IK still puts the hands on the
// grips and the feet on the pedals. The fingers are curled round a grip first (joint by joint about the knuckle line),
// and the hand is turned so the palm faces the grip (the rig's hand: grip along local X, palm to -Z). Vertices blend
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
    const eye = new Uint8Array(bin, o, n);
    const bones = meta.bones, byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    for (const b of bones) { b.h = V(...b.head); b.t = V(...b.tail); }
    BODY = { n, pos, idx, bi, bw, eye, bones, byName };
  } catch (e) { console.warn('body mesh unavailable, procedural crew instead', e); }
  return BODY;
})();
export const body = () => BODY;

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

// rig: { p: [Vector3], q: [Quaternion], B: bone ids, DIM }. Returns { pos, nrm, skinIndex, skinWeight, seg (per vertex
// rig segment name), along (0..1 along its segment), eye, index, head: { centre, radii } (head-bone local) }.
export function poseBody(rig, { grip = true, scale = 1.07 } = {}) {
  const S = BODY; if (!S) return null;
  const { bones: SB, byName: N } = S, { B, DIM } = rig, J = (n, end = 'h') => SB[N[n]][end].clone().multiplyScalar(scale);
  const FRONT = V(0, 0, -1), UP = V(0, 1, 0);
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
    // the hand: +Y from the wrist to the middle knuckle, the back of the hand to +Z (palm to -Z, onto the grip)
    const k2 = J('finger2-1.' + s), k5 = J('finger5-1.' + s), mid = J('finger3-1.' + s), fy = mid.clone().sub(wr).normalize();
    let back = new THREE.Vector3().crossVectors(k5.clone().sub(k2), fy).normalize(); if (back.y < 0) back.negate(); // (the back of the hand faces up in the rest pose)
    segs['hand' + s] = { src: frame(wr, fy, back), bone: B['fArm' + s], at: 'wrist', len: null, knuckle: k5.clone().sub(k2).normalize(), back };
    segs['thigh' + s] = { src: frame(hp, kn.clone().sub(hp), FRONT), bone: B['thigh' + s], len: [kn.distanceTo(hp), DIM.thigh] };
    segs['shin' + s] = { src: frame(kn, an.clone().sub(kn), FRONT), bone: B['shin' + s], len: [an.distanceTo(kn), DIM.shin] };
    void kk;
  }
  // segment transform: rig bone rest transform * stretch along Y * inverse(source frame)
  for (const [k, g] of Object.entries(segs)) {
    let tgt;
    if (g.at === 'wrist') { const q = rig.q[g.bone], w = V(0, DIM.fore, 0).applyQuaternion(q).add(rig.p[g.bone]); tgt = rigM(g.bone, w); }
    else tgt = rigM(g.bone);
    const st = g.len ? g.len[1] / g.len[0] : 1;
    g.M = tgt.clone().multiply(new THREE.Matrix4().makeScale(1, st, 1)).multiply(g.src.clone().invert());
    g.key = k;
  }
  // finger curl (source space): each finger bone's transform = rotations about its joints, knuckle to tip
  const boneM = SB.map(() => null);
  if (grip) for (const s of ['R', 'L']) {
    const h = segs['hand' + s], ax = h.knuckle.clone(), palm = h.back.clone().negate();
    for (let f = 1; f <= 5; f++) {
      const ang = f === 1 ? [0.35, 0.45, 0.4] : [1.25, 1.55, 1.05]; let M = new THREE.Matrix4();
      const axis = f === 1 ? new THREE.Vector3().crossVectors(J('finger1-2.' + s).sub(J('finger1-1.' + s)).normalize(), palm).normalize() : ax.clone();
      for (let k = 1; k <= 3; k++) {
        const nm = `finger${f}-${k}.${s}`, jt = J(nm), dir = J(nm, 't').sub(jt);
        // the rotation's sign: the fingertip must move towards the palm
        const test = dir.clone().applyAxisAngle(axis, ang[k - 1]), sgn = test.dot(palm) > dir.dot(palm) ? 1 : -1;
        const R = new THREE.Matrix4().makeTranslation(jt.x, jt.y, jt.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, ang[k - 1] * sgn)).multiply(new THREE.Matrix4().makeTranslation(-jt.x, -jt.y, -jt.z));
        M = M.clone().multiply(R); // (applied knuckle first: later joints ride on the earlier rotations)
        boneM[N[nm]] = M.clone();
      }
    }
    // the metacarpals cup a little with the fingers
  }
  // blend
  const n = S.n, pos = new Float32Array(n * 3), seg = new Array(n), along = new Float32Array(n), skI = new Uint16Array(n * 4), skW = new Float32Array(n * 4);
  const segOfBone = SB.map((b) => segs[segmentOf(b.name)] || segs.spine), v = V(), acc = V(), tmp = V();
  for (let i = 0; i < n; i++) {
    v.set(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).multiplyScalar(scale); acc.set(0, 0, 0);
    const wsum = {}; let best = null, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = S.bw[i * 4 + k] / 255; if (w <= 0) continue;
      const b = S.bi[i * 4 + k], g = segOfBone[b];
      tmp.copy(v); if (boneM[b]) tmp.applyMatrix4(boneM[b]); tmp.applyMatrix4(g.M); acc.addScaledVector(tmp, w);
      wsum[g.bone] = (wsum[g.bone] || 0) + w; const gw = (wsum[g.bone]); if (gw > bw) { bw = gw; best = g; }
    }
    pos[i * 3] = acc.x; pos[i * 3 + 1] = acc.y; pos[i * 3 + 2] = acc.z;
    seg[i] = best ? best.key : 'spine';
    if (best && best.len) { const local = v.clone().applyMatrix4(best.src.clone().invert()); along[i] = local.y / best.len[0]; }
    const ent = Object.entries(wsum).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = ent.reduce((s, e) => s + e[1], 0) || 1;
    ent.forEach(([bn, w], k) => { skI[i * 4 + k] = +bn; skW[i * 4 + k] = w / tot; });
  }
  // the head, in head-bone space (for hair, helmets and caps)
  const hinv = rigM(B.head).invert(), hb = new THREE.Box3();
  for (let i = 0; i < n; i++) if (seg[i] === 'head') { tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(hinv); if (tmp.y > 0.06) hb.expandByPoint(tmp); }
  const centre = hb.getCenter(V()), radii = hb.getSize(V()).multiplyScalar(0.5);
  return { pos, skinIndex: skI, skinWeight: skW, seg, along, eye: S.eye, index: S.idx, head: { centre, radii } };
}
