// Fit-out (visual only): carries what sits inside or on a part down to the surface it really stands on, found by casting
// rays against the built meshes (the way gearRoute.js and carDetail.js find skins), so it holds whatever body, size,
// position or mirroring the part ends up with. Run by planeDetail.assemble after the skins, canopy tubs and fillets exist.
//   - cockpit fittings (userData.fit, declared by the cockpit builders): a seat gets a riser down to the tub floor or the
//     skin under it, an instrument panel a support down to the floor (or forward to the skin ahead of it);
//   - rotor masts carried down to the skin under them, tail-rotor shafts across to the fin or boom beside them;
//   - engines and pods that don't meet anything (set off a curved nose by the hangar's placing, or sunk inside a body
//     clear of its skin) get mounting struts to the nearest skin, unless a pylon (planeDetail) already carries them.
// Physics never sees any of it.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { M } from './materials.js';
import { V, bar } from './partDetail.js';
import { interiorOf } from './interior.js';

const opaque = (m) => m.isMesh && m.visible && !m.userData.isDisc && !m.material?.transparent && m.material?.blending !== THREE.AdditiveBlending;

// h: { cast, addTo, valid, structure, quick } (quick: a slider is being dragged; the mounts wait for the full rebuild)
export function fitOut(design, objs, root, h) {
  root.updateMatrixWorld(true);
  design.parts.forEach((p, i) => {
    if (!h.valid(i)) return; const o = objs[i];
    try {
      if (o.userData.fit) fitCockpit(o, h);
      if (PARTS[p.id].cat === 'rotor') fitRotor(o, h);
      if (MOUNTED(p.id) && !h.quick) fitMount(o, h, objs.filter((q, j) => j === p.parent || !(h.valid(j) && MOUNTED(design.parts[j].id)))); // (another pod it merely touches doesn't hold it up)
    } catch (e) { console.warn('fitOut', p.id, e); }
  });
}

// what a fitting may stand on: every solid part but this one, plus this part's own tub, skirt and sill (joints)
function targetsFor(obj, h) {
  const own = new Set(); obj.traverse((m) => own.add(m));
  const t = h.structure.filter((m) => !own.has(m));
  obj.traverse((m) => { if (m.userData.joint && opaque(m)) t.push(m); });
  return t;
}

// a box w x d (cockpit frame) from the fitting's underside at p down to the surface: in world space for addTo
function pedestal(obj, p, yBot, w, d) {
  const g = new THREE.BoxGeometry(w, p.y + 0.01 - yBot, d); g.translate(p.x, (p.y + 0.01 + yBot) / 2, p.z);
  return g.applyMatrix4(obj.matrixWorld);
}

function fitCockpit(obj, h) {
  const W = obj.matrixWorld, inv = W.clone().invert(), s = Math.cbrt(Math.abs(W.determinant())), targets = targetsFor(obj, h);
  const down = V(0, -1, 0).transformDirection(W).normalize(), fwd = V(0, 0, -1).transformDirection(W).normalize();
  // Another part's skin inside this cockpit's interior is no floor: interior.js keepOut cuts it away once everything is
  // built (a cockpit seated on a body that isn't its own, a shallow tub), and a seat stood on it would be left hanging.
  // The cast goes on through it to the first surface that stays (this part's own tub and joints always do).
  const own = new Set(); obj.traverse((m) => own.add(m));
  let I = null; if (!h.quick) try { I = interiorOf(obj); } catch (e) { console.warn('fitOut interior', e); }
  const stays = (hit) => !I || own.has(hit.m) || I.f(hit.p.clone().applyMatrix4(inv)) <= 0;
  const castKept = (from, dir, far) => {
    let o = from.clone(), left = far;
    for (let k = 0; k < 8; k++) {
      const hit = h.cast(targets, o, dir, left, true); if (!hit || stays(hit)) return hit && { ...hit, d: far - left + hit.d };
      o = hit.p.clone().addScaledVector(dir, 0.002); left -= hit.d + 0.002; if (left <= 0) return null;
    }
    return null;
  };
  for (const f of obj.userData.fit) {
    if (f.noTub && obj.userData.tubWell) continue; // (held by the tub's walls)
    const p = V(...f.p), from = p.clone().add(V(0, 0.05, 0)).applyMatrix4(W);
    const hit = castKept(from, down, 2.5 * s);
    const mat = f.kind === 'seat' ? M.darkMetal() : M.black();
    if (hit) {
      const yHit = hit.p.clone().applyMatrix4(inv).y; if (yHit >= p.y - 0.004) continue; // it already stands on (or in) it
      h.addTo(obj, pedestal(obj, p, yHit - 0.01, f.w, f.d), mat, { shadow: false });
      continue;
    }
    if (f.kind !== 'panel') continue;
    // nothing under the panel (a cockpit over a gap): a shelf forward from it to the skin ahead
    const fh = castKept(p.clone().applyMatrix4(W), fwd, 1.5 * s); if (!fh) continue;
    const q = fh.p.clone().applyMatrix4(inv);
    h.addTo(obj, bar(p, V(p.x, p.y, q.z - 0.01), f.w, 0.02).applyMatrix4(W), mat, { shadow: false });
  }
}

// Main rotor: the mast (part origin up +y) runs down to the skin under it. Tail rotor (disc facing +-x, hub at the
// origin): a shaft along the axis to the nearest skin beside it, with a gearbox fairing where it meets it.
function fitRotor(obj, h) {
  const W = obj.matrixWorld, inv = W.clone().invert(), s = Math.cbrt(Math.abs(W.determinant())), targets = targetsFor(obj, h);
  const mast = obj.children.find((m) => m.isMesh && m.geometry?.type === 'CylinderGeometry' && m.material === M.steel());
  if (mast) {
    const from = V(0, 0.2, 0).applyMatrix4(W), hit = h.cast(targets, from, V(0, -1, 0).transformDirection(W).normalize(), 3 * s, true); if (!hit) return;
    const y = hit.p.clone().applyMatrix4(inv).y; if (y >= -0.004) return; // the mast foot is in the skin already
    const r = mast.geometry.parameters.radiusBottom * 1.35, g = new THREE.CylinderGeometry(r, r * 1.25, 0.06 - y, 14); g.translate(0, y / 2, 0); // (from 3 cm into the skin to 3 cm up the mast)
    h.addTo(obj, g.applyMatrix4(W), M.darkMetal());
    return;
  }
  // tail rotor: try both ways along the axis, take the nearer skin
  const ax = V(1, 0, 0).transformDirection(W).normalize(), o = V(0, 0, 0).applyMatrix4(W); let best = null;
  for (const sg of [1, -1]) { const d = ax.clone().multiplyScalar(sg), hit = h.cast(targets, o, d, 1.5 * s, true); if (hit && (!best || hit.d < best.hit.d)) best = { hit, sg }; }
  if (!best) return;
  const end = best.hit.p.clone().applyMatrix4(inv), x = end.x + best.sg * 0.02, r = 0.035;
  h.addTo(obj, bar(V(0, 0, 0), V(x, 0, 0), r * 2, r * 2, true, 10).applyMatrix4(W), M.steel());
  const box = new THREE.CylinderGeometry(0.07, 0.09, 0.12, 12); box.rotateZ(Math.PI / 2); box.translate(end.x - best.sg * 0.03, 0, 0); h.addTo(obj, box.applyMatrix4(W), M.darkMetal());
}

// Engines and pods: does any skin reach the pod (within 1 cm, or through it)? If not, struts along the shortest way to it:
// two radial ones (a pod beside or inside a body), or four along the axis (an engine set off ahead of, or behind, a nose).
const MOUNTED = (id) => PARTS[id].cat === 'engine' || id === 'x_tank' || id === 'x_rcs' || id === 'x_smoke';
function fitMount(obj, h, objs) { // objs: what may carry it
  const W = obj.matrixWorld, s = Math.cbrt(Math.abs(W.determinant())), own = [], skip = new Set();
  for (const k of ['prop', 'fan', 'flame', 'flameCore']) obj.userData[k]?.traverse((m) => skip.add(m));
  obj.traverse((m) => { if (opaque(m) && !skip.has(m)) own.push(m); });
  if (!own.length) return;
  const ownSet = new Set(own), targets = []; obj.updateMatrixWorld(true);
  // (glass too: a pod the hangar set off a glazed nose is bolted to the frame through it)
  for (const o of objs) if (o && o !== obj) o.traverse((m) => { if (m.isMesh && m.visible && !m.userData.isDisc && m.material?.blending !== THREE.AdditiveBlending && !ownSet.has(m) && !m.userData.near) targets.push(m); });
  // the pod in its own frame: axis along local z through its box centre
  const inv = W.clone().invert(), lb = new THREE.Box3(); for (const m of own) { m.geometry.computeBoundingBox(); lb.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld.clone().premultiply(inv))); }
  const c = lb.getCenter(V()), sz = lb.getSize(V()), R = Math.max(sz.x, sz.y) * 0.5 * s + 0.5, Lz = sz.z * s;
  const pt = (x, y, z) => V(x, y, z).applyMatrix4(W), dirL = (x, y, z) => V(x, y, z).transformDirection(W).normalize();
  // one probe: from a (inside the pod) along d: the pod's outer surface S on that line, the first other skin from a
  const probe = (a, d) => {
    const S = h.cast(own, a.clone().addScaledVector(d, R + Lz), d.clone().negate(), R + Lz, true); if (!S) return null;
    const rho = S.p.distanceTo(a), t = h.cast(targets, a, d, rho + 4 * s, true); if (!t) return { a, d, S: S.p, rho, gap: Infinity }; // (4 m: the hangar can set a jet, whose box includes its flame, metres off a nose)
    return { a, d, S: S.p, rho, P: t.p, gap: t.d - rho };
  };
  // rays round the axis at three stations and along it from both ends, the ones facing what carries it first; the first
  // that meets a skin within 1 cm settles it (a pod on its pylon costs a ray or two)
  const radial = [], axial = [], jobs = [], toward = V(); for (const o of objs) if (o) toward.add(new THREE.Box3().setFromObject(o).getCenter(V()).applyMatrix4(inv).sub(c));
  for (const f of [0.5, 0.25, 0.75]) for (let k = 0; k < 12; k++) { const t = (k / 12) * Math.PI * 2, x = Math.cos(t), y = Math.sin(t); jobs.push({ w: -(x * toward.x + y * toward.y) / (toward.length() || 1) + f * 0.01, run: () => { const r = probe(pt(c.x, c.y, lb.min.z + sz.z * f), dirL(x, y, 0)); if (r) radial.push(r); return r; } }); }
  for (const e of [-1, 1]) for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) jobs.push({ w: -(e * toward.z) / (toward.length() || 1) + 0.005, run: () => { const r = probe(pt(c.x + ox * sz.x * 0.25, c.y + oy * sz.y * 0.25, c.z), dirL(0, 0, e)); if (r) axial.push(Object.assign(r, { e, ox, oy })); return r; } });
  jobs.sort((a, b) => a.w - b.w);
  for (const j of jobs) { const r = j.run(); if (r && r.gap <= 0.01) return; } // something reaches it
  const all = [...radial, ...axial]; if (!all.length) return;
  const best = all.reduce((a, b) => (b.gap < a.gap ? b : a)); if (!Number.isFinite(best.gap)) return;
  const struts = [];
  if (best.e === undefined) { // radial: two struts either side of the best station, same direction
    for (const df of [-0.2, 0.2]) { const a = best.a.clone().addScaledVector(dirL(0, 0, 1), df * Lz), r = probe(a, best.d); if (r?.P) struts.push(r); }
    if (!struts.length) struts.push(best);
  } else struts.push(...axial.filter((r) => r.e === best.e && r.P && (r.ox || r.oy)));
  if (!struts.length) struts.push(best);
  const w = Math.min(0.12, Math.max(0.03, R * 0.12));
  for (const r of struts) h.addTo(obj, bar(r.S.clone().addScaledVector(r.d, -0.015), r.P.clone().addScaledVector(r.d, 0.015), w, w, true, 8), M.darkMetal());
}
