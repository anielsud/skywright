// New York's buildings drawn at fixed views (not one of CI's jobs: a measuring tool, counts, no verdicts):
//   python3 tools/test/jobs.py bldcull --quality low [--keep]     (~40 s, one Chrome; --keep: a screenshot per view)
// At each view: the frame's triangles and draw calls, the buildings' triangles by distance band (realCity.js: tall
// buildings' near cell meshes and far group meshes, low tiles' cell meshes), and how many of the buildings' triangles
// are in meshes hidden behind other buildings: each building mesh drawn in an id colour (nothing else drawn: only
// buildings hide buildings), the ids read back; a mesh in the frustum with no pixel is hidden (what occlusion culling
// by mesh could save there, at this resolution).
import { toLocal } from '../../../src/realworld.js';

const POSES = [
  { name: 'street: 7th Ave at Times Square', from: [40.7560, -73.9866, 2], to: [40.7630, -73.9830, 2] },
  { name: 'street: 5th Ave north from 40th St', from: [40.75217, -73.98159, 2], to: [40.76430, -73.97290, 2] },
  { name: 'street: W 34th St east from 8th Ave', from: [40.75190, -73.99470, 2], to: [40.74750, -73.98400, 2] },
  { name: 'helipad start: 55 Water St', from: [40.70307, -74.009319, 216], to: [40.689247, -74.044502, 50] },
  { name: 'rooftop: Empire State Bldg', from: [40.7484, -73.9857, 380], to: [40.7075, -74.0110, 100] },
  { name: 'low: 150 m over Chelsea', from: [40.7300, -73.9950, 150], to: [40.7600, -73.9750, 50] },
  { name: 'air: 500 m over Central Park S', from: [40.7680, -73.9810, 500], to: [40.7300, -73.9950, 0] },
  { name: 'air: 1500 m over Brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0] },
  { name: 'high: 3000 m over Queens', from: [40.7300, -73.9000, 3000], to: [40.7550, -73.9850, 0] },
];
const BANDS = [250, 500, 1000, 2000, 5000, Infinity];

export async function run(T) {
  await T.step('build nyc', async () => { await T.start('Kestrel', 'nyc'); });
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, cam = S.rig.cam, R = S.renderer, city = W.towns.city;
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, (W.groundAt(x, z, 1e4)?.h ?? W.heightAt(x, z)) + h, z); };
  const settle = async () => { // stream around the camera (paused flight: step the world from here, as goto.py does; the city's update is the towns')
    for (let k = 0; k < 400; k++) { for (let i = 0; i < 10; i++) { W.update(1 / 60, cam, new THREE.Vector3(), []); W.towns.update(1 / 60, W.t, null, cam.position); W.flora?.update(cam.position); } W.roadGroup?.userData.update?.(cam.position, 1e5, 3000); if (k > 20 && city.ready) break; await new Promise((r) => setTimeout(r, 0)); }
  };
  const trisOf = (o) => { const g = o.geometry, ic = g.index ? g.index.count : g.attributes.position?.count ?? 0; return Math.min(ic, g.drawRange?.count ?? Infinity) / 3; };
  // every building mesh: [mesh, x, z, kind]
  const meshes = () => [
    ...(city.tallGroups || []).map((g) => [g.m, g.x, g.z, 'tall']), ...city.tallMeshes.map((g) => [g.m, g.x, g.z, 'tall']),
    ...[...city.tiles.values()].flatMap((t) => (t.meshes || []).map((m) => [m, m.position.x, m.position.z, 'low'])),
  ];
  const rt = new THREE.WebGLRenderTarget(512, 312), px = new Uint8Array(512 * 312 * 4);
  for (const [n, p] of POSES.entries()) {
    F.paused = true;
    const c = at(p.from), l = at(p.to); cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    F.ac.x.copy(c); F.ac.syncVisual?.(); if (F.ac.root) F.ac.root.visible = false; // (the camera is where the aircraft is: hide it)
    document.querySelectorAll('#modal-root').forEach((e) => (e.style.display = 'none'));
    await settle();
    cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)), sph = new THREE.Sphere();
    const vis = (o) => { for (let v = o; v; v = v.parent) if (!v.visible) return false; if (!o.frustumCulled) return true; const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); sph.copy(g.boundingSphere).applyMatrix4(o.matrixWorld); return fr.intersectsSphere(sph); };
    const band = (d) => BANDS.findIndex((b) => d < b), B = { tall: BANDS.map(() => 0), low: BANDS.map(() => 0) }, drawn = [];
    for (const e of meshes()) { const [m, x, z, k] = e; if (!vis(m) || !trisOf(m)) continue; B[k][band(Math.hypot(x - c.x, z - c.z))] += trisOf(m); drawn.push(e); }
    R.info.autoReset = true; R.render(F.scene, cam); const calls = R.info.render.calls, tris = R.info.render.triangles;
    // hidden behind buildings: the drawn building meshes alone, each an id colour
    const keep = new Map(), mats = [];
    F.scene.traverse((o) => { if (o.visible) keep.set(o, o.material); });
    for (const o of keep.keys()) if (o.isMesh || o.isPoints || o.isLine || o.isSprite) o.visible = false;
    drawn.forEach(([m], i) => { const k = i + 1, mt = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }); mt.color.setRGB((k & 255) / 255, ((k >> 8) & 255) / 255, ((k >> 16) & 255) / 255, THREE.LinearSRGBColorSpace); mats.push(mt); m.material = mt; m.visible = true; });
    const bg = F.scene.background, fog = F.scene.fog; F.scene.background = null; F.scene.fog = null;
    R.setRenderTarget(rt); R.setClearColor(0, 0); R.clear(); R.render(F.scene, cam); R.readRenderTargetPixels(rt, 0, 0, 512, 312, px); R.setRenderTarget(null);
    F.scene.background = bg; F.scene.fog = fog;
    for (const [o, mt] of keep) { o.visible = true; if (mt) o.material = mt; } for (const mt of mats) mt.dispose();
    const seen = new Set(); for (let i = 0; i < px.length; i += 4) seen.add(px[i] | (px[i + 1] << 8) | (px[i + 2] << 16));
    let hid = 0, hidM = 0, all = 0; drawn.forEach(([m], i) => { const t = trisOf(m); all += t; if (!seen.has(i + 1)) { hid += t; hidM++; } });
    const k = (v) => (v / 1e3).toFixed(0) + 'k';
    T.log(`VIEW ${p.name} (camera y ${Math.round(c.y)} m): frame ${k(tris)} tris, ${calls} calls | buildings ${k(all)} tris in ${drawn.length} meshes; behind other buildings ${k(hid)} (${(100 * hid / Math.max(1, all)).toFixed(0)}%) in ${hidM} meshes`);
    T.log(`     by distance <250 / <500 / <1k / <2k / <5k / 5k+ m:  tall ${B.tall.map(k).join(' / ')}   low ${B.low.map(k).join(' / ')}`);
    R.render(F.scene, cam); await T.shot('view' + (n + 1));
  }
  rt.dispose();
}
