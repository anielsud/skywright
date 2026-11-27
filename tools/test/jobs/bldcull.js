// New York's buildings drawn at fixed views (not one of CI's jobs: a measuring tool, counts, no verdicts):
//   python3 tools/test/jobs.py bldcull --quality low [--keep]     (~40 s, one Chrome; --keep: a screenshot per view)
// At each view: the frame's triangles and draw calls, the buildings' triangles by distance band (realCity.js: tall
// buildings' near cell meshes and far group meshes, low tiles' cell meshes), and how many of the buildings' triangles
// are in meshes hidden behind other buildings: each building mesh drawn in an id colour (nothing else drawn: only
// buildings hide buildings), the ids read back; a mesh in the frustum with no pixel is hidden (what occlusion culling
// by mesh could save there, at this resolution). With occlusion culling (realCity.js occlude) off and on: the frame's
// triangles and calls, its work (occluders drawn, pixel corners cast, pixels written, meshes tested) and time (on this
// machine: information, no verdict; warm: 20 more calls), the hidden share left over; checks that nothing it hid has a
// pixel showing (and the frame drawn with it off and on, at 1024 x 624: how many pixels differ, information), and,
// where shadows are on (--quality high / ultra), that each mesh it hid still draws into the shadow maps that see it.
// Then a walk up 5th Avenue and across 42nd Street turning round (WALK steps), the same check at every step.
import { toLocal } from '../../../src/realworld.js';
import { OCC } from '../../../src/realCity.js';
import { OCC_LAYER, BW, BH } from '../../../src/occlusion.js';
import { furnShaped } from '../../../src/buildings.js';

const POSES = [
  { name: 'street: 7th Ave at Times Square', from: [40.7560, -73.9866, 2], to: [40.7630, -73.9830, 2] },
  { name: 'street: 5th Ave north from 40th St', from: [40.75217, -73.98159, 2], to: [40.76430, -73.97290, 2] },
  { name: 'street: W 34th St east from 8th Ave', from: [40.75190, -73.99470, 2], to: [40.74750, -73.98400, 2] },
  { name: 'low: 40 m over 5th Ave at 40th St', from: [40.75217, -73.98159, 40], to: [40.76430, -73.97290, 40] },
  { name: 'low: 80 m over 5th Ave at 40th St', from: [40.75217, -73.98159, 80], to: [40.76430, -73.97290, 60] },
  { name: 'helipad start: 55 Water St', from: [40.70307, -74.009319, 216], to: [40.689247, -74.044502, 50] },
  { name: 'rooftop: Empire State Bldg', from: [40.7484, -73.9857, 380], to: [40.7075, -74.0110, 100] },
  { name: 'low: 150 m over Chelsea', from: [40.7300, -73.9950, 150], to: [40.7600, -73.9750, 50] },
  { name: 'air: 500 m over Central Park S', from: [40.7680, -73.9810, 500], to: [40.7300, -73.9950, 0] },
  { name: 'air: 1500 m over Brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0] },
  { name: 'high: 3000 m over Queens', from: [40.7300, -73.9000, 3000], to: [40.7550, -73.9850, 0] },
];
const BANDS = [250, 500, 1000, 2000, 5000, Infinity];
const WALK = 300;

export async function run(T) {
  await T.step('build nyc', async () => { await T.start('Kestrel', 'nyc'); });
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, cam = S.rig.cam, R = S.renderer, city = W.towns.city;
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, (W.groundAt(x, z, 1e4)?.h ?? W.heightAt(x, z)) + h, z); };
  const settle = async () => { // stream around the camera (paused flight: step the world from here, as goto.py does; the city's update is the towns')
    for (let k = 0; k < 400; k++) { for (let i = 0; i < 10; i++) { W.update(1 / 60, cam, new THREE.Vector3(), []); W.towns.update(1 / 60, W.t, null, cam.position); W.flora?.update(cam.position); } W.roadGroup?.userData.update?.(cam.position, 1e5, 3000); if (k > 20 && city.ready) break; await new Promise((r) => setTimeout(r, 0)); }
  };
  const trisOf = (o) => { const g = o.geometry, ic = g.index ? g.index.count : g.attributes.position?.count ?? 0; return (Math.min(ic, g.drawRange?.count ?? Infinity) / 3) * (o.isInstancedMesh ? o.count : 1); };
  // every building mesh: [mesh, x, z, kind] (furn: the roof furniture's instances, realCity.js FurnK)
  const furn = (L) => (L || []).map((f) => [f, f.position.x + f.boundingSphere.center.x, f.position.z + f.boundingSphere.center.z, 'furn']);
  const meshes = () => [
    ...(city.tallGroups || []).map((g) => [g.fm || g.m, g.x, g.z, 'tall']), ...city.tallMeshes.map((g) => [g.m, g.x, g.z, 'tall']), ...city.tallMeshes.filter((g) => g.fm).map((g) => [g.fm, g.x, g.z, 'tall']),
    ...[...city.tiles.values()].flatMap((t) => (t.meshes || []).map((m) => [m, m.position.x, m.position.z, 'low'])),
    ...(city.tallGroups || []).flatMap((g) => furn(g.furn)), ...[...city.tiles.values()].flatMap((t) => furn(t.furn)),
  ];
  const ci = city.info(); T.log(`tall buildings ${ci.tall}, ${ci.occluders.tall} of them occluders; built in ${(ci.msTall / 1e3).toFixed(1)} s`);
  const rt = new THREE.WebGLRenderTarget(512, 312), px = new Uint8Array(512 * 312 * 4);
  // what's drawn and what shows (occlusion culling's layer on: everything), the camera where it is
  const truth = (c) => {
    cam.layers.enable(OCC_LAYER);
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)), sph = new THREE.Sphere();
    const vis = (o) => { for (let v = o; v; v = v.parent) if (!v.visible) return false; if (!o.frustumCulled) return true; const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); sph.copy(o.isInstancedMesh ? o.boundingSphere : g.boundingSphere).applyMatrix4(o.matrixWorld); return fr.intersectsSphere(sph); };
    const band = (d) => BANDS.findIndex((b) => d < b), B = { tall: BANDS.map(() => 0), low: BANDS.map(() => 0), furn: BANDS.map(() => 0) }, drawn = [];
    for (const e of meshes()) { const [m, x, z, k] = e; if (!vis(m) || !trisOf(m)) continue; B[k][band(Math.hypot(x - c.x, z - c.z))] += trisOf(m); drawn.push(e); }
    const keep = new Map(), mats = [];
    F.scene.traverse((o) => { if (o.visible) keep.set(o, o.material); });
    for (const o of keep.keys()) if (o.isMesh || o.isPoints || o.isLine || o.isSprite) o.visible = false;
    drawn.forEach(([m], i) => {
      const k = i + 1, mt = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }); mt.color.setRGB((k & 255) / 255, ((k >> 8) & 255) / 255, ((k >> 16) & 255) / 255, THREE.LinearSRGBColorSpace); mats.push(mt); m.material = m.isInstancedMesh ? furnShaped(mt) : mt; m.visible = true;
    });
    const bg = F.scene.background, fog = F.scene.fog; F.scene.background = null; F.scene.fog = null;
    R.setRenderTarget(rt); R.setClearColor(0, 0); R.clear(); R.render(F.scene, cam); R.readRenderTargetPixels(rt, 0, 0, 512, 312, px); R.setRenderTarget(null);
    F.scene.background = bg; F.scene.fog = fog;
    for (const [o, mt] of keep) { o.visible = true; if (mt) o.material = mt; } for (const mt of mats) mt.dispose();
    cam.layers.disable(OCC_LAYER);
    const seen = new Set(); for (let i = 0; i < px.length; i += 4) seen.add(px[i] | (px[i + 1] << 8) | (px[i + 2] << 16));
    let hid = 0, hidM = 0, all = 0; drawn.forEach(([m], i) => { const t = trisOf(m); all += t; if (!seen.has(i + 1)) { hid += t; hidM++; } });
    return { drawn, seen, hid, hidM, all, B };
  };
  // the frame as drawn, occlusion culling off or on (its picture too, at 1024 x 624: img)
  const IW = 1024, IH = 624, rt2 = new THREE.WebGLRenderTarget(IW, IH), imgs = [new Uint8Array(IW * IH * 4), new Uint8Array(IW * IH * 4)];
  const frame = (on) => {
    OCC.on = on; city.occlude(cam, R); OCC.on = true;
    R.info.autoReset = true; R.setRenderTarget(rt2); R.render(F.scene, cam); const out = { calls: R.info.render.calls, tris: R.info.render.triangles };
    R.readRenderTargetPixels(rt2, 0, 0, IW, IH, imgs[on ? 1 : 0]); R.setRenderTarget(null);
    return out;
  };
  const imgDiff = () => { const [a, b] = imgs; let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) n++; return n; };
  // the meshes occlusion hid (now) that show in g; and how near any it hid came to showing: the least, over its
  // screen rectangle's pixels, of how far behind the occluders there its nearest corner is (m)
  const hiddenSeen = (g) => {
    const out = { n: 0, list: '', margin: Infinity }, B = city.occBuf;
    g.drawn.forEach(([m, x, z, kind], i) => {
      if (m.layers.mask !== 1 << OCC_LAYER) return;
      if (g.seen.has(i + 1)) { out.n++; if (out.n <= 3) out.list += `${kind} mesh at ${Math.round(x)},${Math.round(z)} has pixels; `; }
    });
    for (const m of city.occHidden || []) out.margin = Math.min(out.margin, margin(B, m.userData.occB));
    return out;
  };
  const margin = (B, L) => { // (occlusion.js hidden(), measuring: the least over its boxes on screen)
    const V = B.V, v = B.v; let mm = Infinity;
    for (let o = 0; o < L.length; o += 6) {
      let dmin = Infinity, q = 0;
      for (const x of [L[o], L[o + 3]]) for (const y of [L[o + 1], L[o + 4]]) for (const z of [L[o + 2], L[o + 5]]) { const vz = V[2] * x + V[6] * y + V[10] * z + V[14]; v[q++] = V[0] * x + V[4] * y + V[8] * z + V[12]; v[q++] = V[1] * x + V[5] * y + V[9] * z + V[13]; v[q++] = vz; dmin = Math.min(dmin, -vz); }
      const r = B.rect(8, false), i0 = Math.max(0, Math.floor(r[0])), i1 = Math.min(BW, Math.ceil(r[1])), j0 = Math.max(0, Math.floor(r[2])), j1 = Math.min(BH, Math.ceil(r[3]));
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) mm = Math.min(mm, dmin - B.depth[j * BW + i]);
    }
    return mm;
  };
  for (const [n, p] of POSES.entries()) {
    F.paused = true;
    const c = at(p.from), l = at(p.to); cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    F.ac.x.copy(c); F.ac.syncVisual?.(); if (F.ac.root) F.ac.root.visible = false; // (the camera is where the aircraft is: hide it)
    document.querySelectorAll('#modal-root').forEach((e) => (e.style.display = 'none'));
    await settle();
    cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
    const k = (v) => (v / 1e3).toFixed(0) + 'k';
    const g = truth(c);
    const { tris, calls } = frame(false), on = frame(true), S = city.occStats;
    const bad = hiddenSeen(g), hid = g.hid, pxd = imgDiff();
    let warm = 0; if (S.on) { const t0 = performance.now(); for (let r = 0; r < 20; r++) city.occlude(cam, R); warm = (performance.now() - t0) / 20; } // (its time again, warm: information)
    let left = 0; g.drawn.forEach(([m], i) => { if (!g.seen.has(i + 1) && m.layers.mask !== 1 << OCC_LAYER) left += trisOf(m); });
    T.log(`VIEW ${p.name} (camera y ${Math.round(c.y)} m): frame ${k(tris)} tris, ${calls} calls | buildings ${k(g.all)} tris in ${g.drawn.length} meshes; behind other buildings ${k(hid)} (${(100 * hid / Math.max(1, g.all)).toFixed(0)}%) in ${g.hidM} meshes`);
    T.log(`     by distance <250 / <500 / <1k / <2k / <5k / 5k+ m:  tall ${g.B.tall.map(k).join(' / ')}   low ${g.B.low.map(k).join(' / ')}   roof furniture ${g.B.furn.map(k).join(' / ')}`);
    T.log(`     occlusion ${S.on ? 'on' : 'off (camera too high)'}: frame ${k(on.tris)} tris, ${on.calls} calls | hid ${k(S.tris)} tris in ${S.hidden} meshes; still drawn though behind buildings ${k(left)} (${(100 * left / Math.max(1, g.all)).toFixed(0)}% of buildings') | work: ${S.cands} candidates, ${S.occluders} occluders drawn, ${S.corners} corners cast, ${S.pixels} pixels written, ${S.tested} meshes tested, ${S.ms.toFixed(2)} ms (warm ${warm.toFixed(2)}) | hidden but seen: ${bad.n}, closest margin ${bad.margin.toFixed(1)} m | picture off vs on: ${pxd} pixels differ`);
    T.check(`${p.name}: nothing hidden that shows`, bad.n === 0, bad.list);
    // hidden meshes still cast shadows: each one that casts and is in a shadow camera's view drawn into its shadow map
    // (its onBeforeShadow called)
    const casters = (city.occHidden || []).filter((m) => m.castShadow);
    if (casters.length && R.shadowMap.enabled) {
      const drawnS = new Set(), lights = []; for (const m of casters) m.onBeforeShadow = () => drawnS.add(m);
      F.scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow.intensity > 0) { o.shadow.needsUpdate = true; lights.push(o); } }); R.shadowMap.needsUpdate = true;
      R.render(F.scene, cam); for (const m of casters) delete m.onBeforeShadow;
      const fr = lights.map((o) => new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(o.shadow.camera.projectionMatrix, o.shadow.camera.matrixWorldInverse)));
      const want = casters.filter((m) => fr.some((f) => f.intersectsObject(m))), miss = want.filter((m) => !drawnS.has(m)).length;
      T.log(`     shadows (${lights.length} shadow maps): ${want.length - miss} of the ${want.length} hidden meshes in a shadow map's view drawn into it (${casters.length} hidden meshes cast shadows)`);
      T.check(`${p.name}: hidden meshes still cast shadows`, miss === 0, `${miss} not drawn into the shadow maps`);
    }
    await T.shot('view' + (n + 1));
  }
  // the walk: up 5th Avenue from 40th St (looking about, 2 m up), then across 42nd St at 5th turning round
  let fails = 0, minM = Infinity, hidN = 0, steps = 0, ms = 0, maxMs = 0; const work = { occluders: 0, corners: 0, pixels: 0, tested: 0 }, list = [];
  const A = [40.75217, -73.98159], Bp = [40.75900, -73.97670], X0 = [40.75364, -73.98094], X1 = [40.75338, -73.98032];
  for (let s = 0; s < WALK; s++) {
    let from, yaw;
    if (s < WALK * 2 / 3) { const t = s / (WALK * 2 / 3); from = [A[0] + (Bp[0] - A[0]) * t, A[1] + (Bp[1] - A[1]) * t, 2]; yaw = 0.5 * Math.sin(t * 25); }
    else { const t = (s - WALK * 2 / 3) / (WALK / 3); from = [X0[0] + (X1[0] - X0[0]) * t, X0[1] + (X1[1] - X0[1]) * t, 2]; yaw = t * Math.PI * 2; }
    const c = at(from), ahead = at([from[0] + (Bp[0] - A[0]) * 0.1, from[1] + (Bp[1] - A[1]) * 0.1, 2]), d = ahead.sub(c);
    const l = c.clone().add(d.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
    F.ac.x.copy(c);
    for (let i = 0; i < 3; i++) { W.update(1 / 60, cam, new THREE.Vector3(), []); W.towns.update(1 / 60, W.t, null, cam.position); }
    for (let q = 0; q < 50 && !city.ready; q++) W.towns.update(1 / 60, W.t, null, cam.position);
    cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
    const g = truth(c); city.occlude(cam, R); const S = city.occStats, b = hiddenSeen(g);
    steps++; ms += S.ms; maxMs = Math.max(maxMs, S.ms); hidN += S.hidden; for (const q in work) work[q] = Math.max(work[q], S[q]);
    fails += b.n; minM = Math.min(minM, b.margin); if (b.n && list.length < 5) list.push(`step ${s}: ${b.list}`);
  }
  T.log(`WALK ${steps} steps: hidden but seen ${fails}; closest margin ${minM.toFixed(2)} m; ${(hidN / steps).toFixed(1)} meshes hidden a step; most a step: ${work.occluders} occluders, ${work.corners} corners, ${work.pixels} pixels, ${work.tested} meshes tested; ${(ms / steps).toFixed(2)} ms a step (most ${maxMs.toFixed(2)})`);
  T.check('walk: nothing hidden that shows', fails === 0, list.join(' | '));
  rt.dispose(); rt2.dispose();
}
