// Aircraft draw-call batching. A plane is many meshes: even after mergeStatic (one mesh per material per rigid piece) a
// small Kestrel was ~105 draw calls, nearly half a Low frame, and on a tablet the per-draw cost is what hurts. Here
// every plain mesh of the plane goes into a THREE.BatchedMesh per material (one draw call each), its own pose kept
// as a per-instance matrix, so moving pieces (control surfaces, wheels, struts, the prop's blades) batch too.
//
// The original meshes stay exactly where they were and every bit of code that animates, hides, swaps or dents them
// keeps working unchanged: they're only taken off all render layers, and each frame sync() copies their pose and
// visibility into the batch. A mesh that's changed underneath (its material swapped: scorched, gear-clip copies; its
// geometry replaced or its vertices dented; carried off as debris) is evicted: its layers come back and it draws
// itself again, so correctness never depends on knowing every runtime change.
//
// Shaders that use modelMatrix for a mesh's own frame (cabin sun, grime, heat glow) take the batching matrix into
// account (USE_BATCHING): see cabinLight.js, planeMaterials.js, sonic.js.
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), FLIP = new THREE.Matrix4().makeScale(-1, 1, 1);
// A mirrored mesh (a symmetric part's left-hand copy: its matrix has a negative determinant) is drawn by three with its
// front faces flipped per object; a batch can't do that per instance, so it gets a mirrored copy of its geometry (x
// negated, winding reversed) and its instance matrix is undone by the same mirror, which makes it positive again.
// cabinSun (cabinLight.js) holds a direction in the mesh's own frame: its x flips with the frame.
function mirrored(g, cache) {
  let c = cache.get(g); if (c) return c;
  c = g.clone(); c.applyMatrix4(FLIP);
  const swap = (a, i, j) => { for (let q = 0; q < a.itemSize; q++) { const t = a.array[i * a.itemSize + q]; a.array[i * a.itemSize + q] = a.array[j * a.itemSize + q]; a.array[j * a.itemSize + q] = t; } };
  if (c.index) { const ix = c.index; for (let i = 0; i + 2 < ix.count; i += 3) swap(ix, i + 1, i + 2); }
  else for (const a of Object.values(c.attributes)) for (let i = 0; i + 2 < a.count; i += 3) swap(a, i + 1, i + 2);
  const cs = c.attributes.cabinSun; if (cs) for (let i = 0; i < cs.count; i++) cs.array[i * 4 + 1] = -cs.array[i * 4 + 1];
  cache.set(g, c); return c;
}
const attrSig = (g) => Object.keys(g.attributes).sort().map((k) => { const a = g.attributes[k]; return k + a.itemSize + a.array.constructor.name + (a.normalized ? 'n' : ''); }).join(',') + (g.index ? '|i' : '|-');

// Built lazily (first visual frame), after anything that swaps the plane's materials at setup (SonicFX's heat copies).
export function batchAircraft(ac) {
  const root = ac.root, skip = new Set();
  for (const p of ac.parts) {
    const u = p.obj.userData;
    for (const k of ['flame', 'flameCore', 'bulb']) if (u[k]) u[k].traverse((o) => skip.add(o)); // (animated per material)
    if (u.prop?.userData?.disc) skip.add(u.prop.userData.disc);
  }
  root.updateMatrixWorld(true); _inv.copy(root.matrixWorld).invert();
  const buckets = new Map(), mir = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || skip.has(o)) return;
    const mat = o.material, g = o.geometry;
    if (!mat || Array.isArray(mat) || o.userData.isDisc || o.userData.planeLight || o.renderOrder !== 0 || mat.clippingPlanes?.length) return;
    if (!g?.attributes?.position || g.morphAttributes?.position || g.groups.length > 1 || Object.values(g.attributes).some((a) => a.isInterleavedBufferAttribute)) return;
    if (o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return; // (per-object uniform hooks)
    const flip = _m.multiplyMatrices(_inv, o.matrixWorld).determinant() < 0;
    if (flip && g.attributes.tangent) return; // (its handedness would need flipping too: leave it be)
    const key = mat.uuid + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.layers.mask + '|' + attrSig(g);
    let b = buckets.get(key); if (!b) buckets.set(key, (b = { mat, list: [], cast: o.castShadow, recv: o.receiveShadow, mask: o.layers.mask }));
    b.list.push({ o, g: flip ? mirrored(g, mir) : g, flip });
  });
  const B = { root, batches: [], entries: [], draws: 0, meshes: 0 };
  for (const b of buckets.values()) {
    if (b.list.length < 2) continue; // one mesh: nothing to gain
    const geos = new Map(); let nv = 0, ni = 0;
    for (const { g } of b.list) if (!geos.has(g)) { geos.set(g, -1); nv += g.attributes.position.count; ni += g.index ? g.index.count : 0; }
    const batch = new THREE.BatchedMesh(b.list.length, nv, ni || undefined, b.mat);
    batch.castShadow = b.cast; batch.receiveShadow = b.recv; batch.layers.mask = b.mask; batch.frustumCulled = false; // (per instance instead)
    batch.sortObjects = !!b.mat.transparent; batch.userData.cosmetic = true; batch.name = 'acBatch';
    for (const g of geos.keys()) geos.set(g, batch.addGeometry(g));
    for (const { o, g, flip } of b.list) {
      const id = batch.addInstance(geos.get(g));
      B.entries.push({ o, batch, id, flip, mat: o.material, geo: o.geometry, ver: o.geometry.attributes.position.version, mask: o.layers.mask });
      o.layers.mask = 0; // (no camera or shadow map draws it: the batch does)
    }
    root.add(batch); B.batches.push(batch); B.draws++; B.meshes += b.list.length;
  }
  syncBatch(B);
  return B;
}

// Each visual frame, after the plane's own animation: poses and visibility into the batch, evictions.
export function syncBatch(B) {
  if (!B) return;
  const root = B.root; root.updateMatrixWorld(true); _inv.copy(root.matrixWorld).invert();
  const E = B.entries;
  for (let k = E.length - 1; k >= 0; k--) {
    const e = E[k], o = e.o;
    let vis = true, under = false;
    for (let q = o; q; q = q.parent) { if (q === root) { under = true; break; } if (!q.visible) vis = false; }
    if (!under || o.material !== e.mat || o.geometry !== e.geo || o.geometry.attributes.position.version !== e.ver) { // changed underneath: it draws itself again
      e.batch.setVisibleAt(e.id, false); o.layers.mask = e.mask; E[k] = E[E.length - 1]; E.pop(); continue;
    }
    e.batch.setVisibleAt(e.id, vis);
    if (vis) { _m.multiplyMatrices(_inv, o.matrixWorld); if (e.flip) _m.multiply(FLIP); e.batch.setMatrixAt(e.id, _m); }
  }
}

export function unbatchAircraft(B) {
  if (!B) return;
  for (const e of B.entries) e.o.layers.mask = e.mask;
  for (const b of B.batches) { b.removeFromParent(); b.dispose(); }
  B.entries.length = 0; B.batches.length = 0;
}
