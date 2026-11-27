// New York at 7 fixed views (a measuring tool, no verdicts): python3 tools/test/jobs.py meshtris --quality low
// The top 25 meshes drawn there by triangles: object path, material, geometry, bounding radius, frustumCulled, where it
// was added (stack, Object3D.add wrapped before the build); the far field's triangles split by what they can show.
import { toLocal } from '../../../src/realworld.js';

const POSES = [
  { name: 'street: 7th Ave at Times Square', from: [40.7560, -73.9866, 2], to: [40.7630, -73.9830, 2] },
  { name: 'helipad start: 55 Water St', from: [40.70307, -74.009319, 216], to: [40.689247, -74.044502, 50] },
  { name: 'rooftop: Empire State Bldg', from: [40.7484, -73.9857, 380], to: [40.7075, -74.0110, 100] },
  { name: 'low: 150 m over Chelsea', from: [40.7300, -73.9950, 150], to: [40.7600, -73.9750, 50] },
  { name: 'air: 500 m over Central Park S', from: [40.7680, -73.9810, 500], to: [40.7300, -73.9950, 0] },
  { name: 'air: 1500 m over Brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0] },
  { name: 'high: 3000 m over Queens', from: [40.7300, -73.9000, 3000], to: [40.7550, -73.9850, 0] },
];

export async function run(T) {
  const THREE = T.THREE, sites = new WeakMap(), add0 = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (...objs) {
    const st = new Error().stack.split('\n').slice(2).filter((l) => !/three|harness/.test(l)).slice(0, 3).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' < ');
    for (const o of objs) if (!sites.has(o)) sites.set(o, st);
    return add0.apply(this, objs);
  };
  await T.step('build nyc', async () => { await T.start('Kestrel', 'nyc'); });
  THREE.Object3D.prototype.add = add0;
  const S = T.S, F = S.F, W = F.world, cam = S.rig.cam, R = S.renderer, city = W.towns.city;
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, (W.groundAt(x, z, 1e4)?.h ?? W.heightAt(x, z)) + h, z); };
  const settle = async () => {
    for (let k = 0; k < 400; k++) { for (let i = 0; i < 10; i++) { W.update(1 / 60, cam, new THREE.Vector3(), []); W.towns.update(1 / 60, W.t, null, cam.position); W.flora?.update(cam.position); } W.roadGroup?.userData.update?.(cam.position, 1e5, 3000); if (k > 20 && city.ready && !W.tiles?.job && !W.tiles?.far?.job) break; await new Promise((r) => setTimeout(r, 0)); }
  };
  const trisOf = (o) => { const g = o.geometry; if (!g) return 0; const ic = g.index ? g.index.count : g.attributes.position?.count ?? 0; let n = Math.min(ic, g.drawRange?.count ?? Infinity) / 3; if (o.isInstancedMesh) n *= o.count; else if (g.isInstancedBufferGeometry) n *= g.instanceCount ?? 1; return n; };
  const path = (o) => { const p = []; for (let v = o; v && v !== F.scene; v = v.parent) p.unshift(v.name || v.type); return p.join('/'); };
  const k = (v) => (v / 1e3).toFixed(1) + 'k';
  const tiles = W.tiles ?? [...Object.values(W)].find((v) => v && v.far && v.inCore), far = tiles?.far;
  T.log(`far field: ${far ? far.info() : 'not found'}; tile size ${tiles?.T ?? tiles?.size}`);
  for (const [n, p] of POSES.entries()) {
    F.paused = true;
    const c = at(p.from), l = at(p.to); cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    F.ac.x.copy(c); F.ac.syncVisual?.(); if (F.ac.root) F.ac.root.visible = false;
    document.querySelectorAll('#modal-root').forEach((e) => (e.style.display = 'none'));
    await settle();
    cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
    // what three draws: every visible mesh with layers matching the camera, in the frustum when culled
    F.scene.updateMatrixWorld(true);
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)), sph = new THREE.Sphere();
    const drawn = [];
    const walk = (o) => { if (!o.visible) return; if ((o.isMesh || o.isLine || o.isPoints) && o.layers.test(cam.layers)) {
      const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      let ok = true; if (o.frustumCulled) { if (o.isInstancedMesh && o.boundingSphere === null) o.computeBoundingSphere?.(); sph.copy(o.isInstancedMesh && o.boundingSphere ? o.boundingSphere : g.boundingSphere).applyMatrix4(o.matrixWorld); ok = fr.intersectsSphere(sph); }
      const t = trisOf(o); if (ok && t) drawn.push([o, t]); }
      for (const ch of o.children) walk(ch); };
    walk(F.scene);
    R.info.autoReset = true; R.render(F.scene, cam); const fi = { ...R.info.render };
    drawn.sort((a, b) => b[1] - a[1]);
    T.log(`VIEW ${n + 1} ${p.name} (y ${Math.round(c.y)}): frame ${k(fi.triangles)} tris ${fi.calls} calls; listed ${drawn.length} meshes ${k(drawn.reduce((s, d) => s + d[1], 0))}`);
    for (const [o, t] of drawn.slice(0, 25)) {
      let site = sites.get(o); for (let v = o.parent; !site && v; v = v.parent) site = sites.get(v) && '(parent) ' + sites.get(v);
      T.log(`   ${k(t).padStart(7)} ${path(o)} | ${o.material?.type}${o.material?.name ? ' ' + o.material.name : ''} | geo '${o.geometry.name}' r ${Math.round(o.geometry.boundingSphere?.radius ?? 0)} | fc ${o.frustumCulled}${o.isInstancedMesh ? ' inst ' + o.count : ''} | ${site ?? '?'}`);
    }
    if (far?.mesh?.visible) {
      // the far field's triangles: per cell, masked (collapsed: core/tile ground), wholly outside the frustum, or shown
      const g = far.mesh.geometry, cell = g.attributes.cell, idx = g.index.array, pos = g.attributes.position, M = far.M, o = far.origin;
      const per = new Map(); for (let q = 0; q < idx.length; q += 3) { const v = idx[q]; const key = cell.getX(v) + ',' + cell.getY(v); let e = per.get(key); if (!e) per.set(key, (e = { t: 0, box: new THREE.Box3(), i: cell.getX(v), j: cell.getY(v) })); e.t++; for (let r = 0; r < 3; r++) e.box.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, idx[q + r])); }
      let masked = 0, out = 0, shown = 0, skirt = 0;
      for (const e of per.values()) { const a = e.i - o.i, b = e.j - o.j, m = a >= 0 && b >= 0 && a < M && b < M ? far.maskData[b * M + a] : 0; if (m > 153) masked += e.t; else if (!fr.intersectsBox(e.box)) out += e.t; else shown += e.t; }
      T.log(`   far field ${k(idx.length / 3)} tris in ${per.size} cells: masked ${k(masked)}, outside frustum ${k(out)}, in view ${k(shown)}; drawn this frame ${k((far.mesh.userData.drawn ?? idx.length / 3) + (far.mesh2?.userData.drawn ?? 0))}`);
    }
    await T.shot('v' + (n + 1));
  }
}
