// What New York's traffic (vehicles.js: one BatchedMesh, every level of detail of every car type) really draws at
// fixed views (not one of CI's jobs: a measuring tool, counts, no verdicts):
//   python3 tools/test/jobs.py trafficdraw --quality low     (~45 s, one Chrome)
// The batch's index buffer holds every model at every LOD (~213k triangles): counting it, or the instances dealt
// before culling, is not what a frame draws. At each view: the instances dealt (by LOD), their triangles before
// three's per-instance frustum culling, the multi-draw left after it (BatchedMesh _multiDrawCount/_multiDrawCounts),
// and the frame's triangles (renderer.info) with the batch shown and hidden. The first view is also measured after
// 60 s of traffic there (cars are dealt onto lanes 270-600 m out, LOD by horizontal distance: vehicles.js LOD).
import { toLocal } from '../../../src/realworld.js';
const POSES = [
  { long: 1, name: 'street 7th Ave/Times Sq', from: [40.7560, -73.9866, 2], to: [40.7630, -73.9830, 2] },
  { name: 'street 7th Ave/Times Sq', from: [40.7560, -73.9866, 2], to: [40.7630, -73.9830, 2] },
  { name: 'helipad 55 Water St', from: [40.70307, -74.009319, 216], to: [40.689247, -74.044502, 50] },
  { name: 'Empire State roof', from: [40.7484, -73.9857, 380], to: [40.7075, -74.0110, 100] },
  { name: '150 m over Chelsea', from: [40.7300, -73.9950, 150], to: [40.7600, -73.9750, 50] },
  { name: '500 m over Central Park S', from: [40.7680, -73.9810, 500], to: [40.7300, -73.9950, 0] },
  { name: '1500 m over Brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0] },
  { name: '3000 m over Queens', from: [40.7300, -73.9000, 3000], to: [40.7550, -73.9850, 0] },
];
export async function run(T) {
  await T.step('build nyc', async () => { await T.start('Kestrel', 'nyc'); });
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, cam = S.rig.cam, R = S.renderer, V = F.traffic.vehicles, B = V.batch;
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, (W.groundAt(x, z, 1e4)?.h ?? W.heightAt(x, z)) + h, z); };
  const gi = B._geometryInfo, ii = B._instanceInfo;
  let allIdx = 0; for (const g of gi) allIdx += g.indexCount ?? g.count ?? 0;
  const lodTris = {}; for (const [t, G] of Object.entries(V.gid)) lodTris[t] = G.lod.map((id) => (gi[id].indexCount ?? gi[id].count) / 3).join('/') + ' wheels ' + G.wheels.map((id) => (gi[id].indexCount ?? gi[id].count) / 3).join('/');
  T.log(`batch: ${gi.length} geometries, ${ii.length} instances; whole index ${B.geometry.index.count / 3} tris (reserved), geometries' own ${allIdx / 3}; perObjectFrustumCulled ${B.perObjectFrustumCulled}, sortObjects ${B.sortObjects}; LODs ${JSON.stringify(V.lod)}, drawDist ${V.drawDist}`);
  T.log('tris per type lod0/lod1/lod2: ' + JSON.stringify(lodTris));
  const rt = new THREE.WebGLRenderTarget(1280, 720);
  for (const p of POSES) {
    F.paused = true;
    const c = at(p.from), l = at(p.to);
    const put = () => { cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld(); cam.updateProjectionMatrix(); };
    put(); F.ac.x.copy(c); F.ac.syncVisual?.(); if (F.ac.root) F.ac.root.visible = false;
    const NF = p.long ? 3600 : 120; for (let k = 0; k < NF; k++) { W.update(1 / 60, cam, new THREE.Vector3(), []); F.traffic.update(1 / 60, null, cam.position); if (k % 30 === 0) await new Promise((r) => setTimeout(r, 0)); }
    put();
    // per instance: visible slots, their LOD and geometry tris (before culling)
    let vis = 0, visTris = 0; const byLod = [0, 0, 0, 0], trisLod = [0, 0, 0, 0];
    const lodOf = {}; for (const G of Object.values(V.gid)) { G.lod.forEach((id, k) => (lodOf[id] = k)); G.wheels.forEach((id) => (lodOf[id] = 3)); }
    for (const inst of ii) { if (!inst || !inst.active || !inst.visible) continue; vis++; const t = (gi[inst.geometryIndex].indexCount ?? gi[inst.geometryIndex].count) / 3; visTris += t; byLod[lodOf[inst.geometryIndex]]++; trisLod[lodOf[inst.geometryIndex]] += t; }
    R.info.autoReset = true; R.setRenderTarget(rt); R.render(F.scene, cam); const on = R.info.render.triangles, callsOn = R.info.render.calls;
    let md = 0; for (let k = 0; k < B._multiDrawCount; k++) md += B._multiDrawCounts[k];
    const mdN = B._multiDrawCount;
    B.visible = false; R.render(F.scene, cam); const off = R.info.render.triangles; B.visible = true; R.setRenderTarget(null);
    T.log(`VIEW ${p.name}${p.long ? ' (60 s of traffic)' : ''}: visible instances ${vis} (bodies lod0 ${byLod[0]}, lod1 ${byLod[1]}, lod2 ${byLod[2]}, wheels ${byLod[3]}) = ${visTris} tris before culling (lod0 ${trisLod[0]}, lod1 ${trisLod[1]}, lod2 ${trisLod[2]}, wheels ${trisLod[3]}); drawn after culling: ${mdN} draws, ${md / 3} tris; frame ${on} tris with traffic, ${off} without -> traffic ${on - off}`);
  }
  rt.dispose();
}
