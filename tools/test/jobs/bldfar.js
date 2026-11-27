// New York's far buildings (realCity.js farBuilding / farCell) at fixed views (not one of CI's jobs: a measuring tool,
// pictures and counts, no verdicts but one):
//   python3 tools/test/jobs.py bldfar --quality low --size 1280x720 --keep --out DIR    (~1 min, one Chrome)
// At each view the frame drawn offscreen at 1280 x 720 (no HUD, no post-processing: the renderer's linear bytes, shown
// sRGB-encoded in a canvas over the page for the screenshot <DIR>/bldfar-<view>.png): with the tall cells' far meshes
// (realCity.js FAR.d) and with every cell drawn near (FAR.d = Infinity), each frame's triangles and draw calls, and how
// many pixels differ between the two (more than 2 in a channel). On a checkout without far meshes it draws the near
// frames only (the same pictures, to compare with the branch's: tools/test/... any image diff).
// Then a tall building knocked down (destruction.js setCut, to 1 m: it and all within 30 m) in a far cell of the first view: the frames again, far
// and near, both with it down; checked: its far copy's vertices carry its damage slot, and the far frame with it down
// differs from the near one no more than the frames without it did (plus a margin), but from the far frame before by
// more (it's gone in the far mesh too).
import { toLocal } from '../../../src/realworld.js';
import * as RC from '../../../src/realCity.js';
import { DMG } from '../../../src/buildings.js';

const VIEWS = [
  { name: 'air-500m-central-park-s', from: [40.7680, -73.9810, 500], to: [40.7300, -73.9950, 0] },
  { name: 'air-1500m-brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0] },
  { name: 'high-3000m-queens', from: [40.7300, -73.9000, 3000], to: [40.7550, -73.9850, 0] },
  { name: 'low-150m-up-manhattan', from: [40.7075, -74.0130, 150], to: [40.7800, -73.9700, 150] },
  { name: 'night-1500m-brooklyn', from: [40.6900, -73.9700, 1500], to: [40.7400, -73.9900, 0], time: 22 },
];
const IW = 1280, IH = 720;

export async function run(T) {
  await T.step('build nyc', async () => { await T.start('Kestrel', 'nyc'); });
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, cam = S.rig.cam, R = S.renderer, city = W.towns.city, FAR = RC.FAR;
  const at = ([lat, lon, h]) => { const [x, z] = toLocal(W.real.meta, lat, lon); return new THREE.Vector3(x, (W.groundAt(x, z, 1e4)?.h ?? W.heightAt(x, z)) + h, z); };
  const settle = async () => { // (as tools/test/jobs/bldcull.js)
    for (let k = 0; k < 400; k++) { for (let i = 0; i < 10; i++) { W.update(1 / 60, cam, new THREE.Vector3(), []); W.towns.update(1 / 60, W.t, null, cam.position); W.flora?.update(cam.position); } W.roadGroup?.userData.update?.(cam.position, 1e5, 3000); if (k > 20 && city.ready) break; await new Promise((r) => setTimeout(r, 0)); }
  };
  const rt = new THREE.WebGLRenderTarget(IW, IH), A = new Uint8Array(IW * IH * 4), B = new Uint8Array(IW * IH * 4);
  const cv = document.createElement('canvas'); cv.width = IW; cv.height = IH; Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: IW + 'px', height: IH + 'px', zIndex: 2147483647, display: 'none' }); document.body.appendChild(cv);
  const enc = new Uint8Array(256); for (let i = 0; i < 256; i++) { const v = i / 255; enc[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
  const show = async (px, name) => { // (the frame, sRGB, flipped upright, over the page; the screenshot)
    const im = new ImageData(IW, IH);
    for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) { const s = ((IH - 1 - y) * IW + x) * 4, d = (y * IW + x) * 4; im.data[d] = enc[px[s]]; im.data[d + 1] = enc[px[s + 1]]; im.data[d + 2] = enc[px[s + 2]]; im.data[d + 3] = 255; }
    cv.getContext('2d').putImageData(im, 0, 0); cv.style.display = 'block'; await T.shot(name); cv.style.display = 'none';
  };
  const frame = (d, out, only = false) => { // (the cells far past d m, or all near: Infinity; only: nothing drawn but the buildings)
    if (FAR) FAR.d = d;
    const hid = []; if (only) { const keep = new Set([city.group]); F.scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !keep.has(o.parent)) { o.visible = false; hid.push(o); } }); }
    city.update(0, cam.position); city.occlude(cam, R);
    let bt = 0, bm = 0; const seen = []; // (the buildings' meshes drawn: their triangles, counted as three draws them)
    const hook = (m) => { if (m.onAfterRender.__bf) return; const f = () => { const g = m.geometry, ic = g.index ? g.index.count : g.attributes.position.count; bt += (Math.min(ic - g.drawRange.start, g.drawRange.count) / 3) * (m.isInstancedMesh ? m.count : 1); bm++; }; f.__bf = 1; seen.push([m, m.onAfterRender]); m.onAfterRender = f; };
    for (const g of city.tallGroups) { hook(g.fm || g.m); for (const f of g.furn) hook(f); } for (const c of city.tallMeshes) { hook(c.m); if (c.fm) hook(c.fm); }
    for (const t of city.tiles.values()) { for (const m of t.meshes || []) hook(m); for (const f of t.furn || []) hook(f); }
    R.info.autoReset = true; R.setRenderTarget(rt); R.render(F.scene, cam); const r = { calls: R.info.render.calls, tris: R.info.render.triangles, bt, bm };
    for (const [m, f] of seen) m.onAfterRender = f;
    for (const o of hid) o.visible = true;
    R.readRenderTargetPixels(rt, 0, 0, IW, IH, out); R.setRenderTarget(null);
    return r;
  };
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) n++; return n; };
  const k = (v) => (v / 1e3).toFixed(0) + 'k';
  const put = async (p) => {
    F.paused = true; if (p.time != null) W.setTime(p.time);
    const c = at(p.from), l = at(p.to); cam.aspect = IW / IH; cam.fov = 60; cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    F.ac.x.copy(c); F.ac.syncVisual?.(); if (F.ac.root) F.ac.root.visible = false;
    await settle(); cam.position.copy(c); cam.lookAt(l); cam.updateMatrixWorld();
  };
  const ci = city.info(); T.log(`far copies: ${FAR ? `${k(city.farStats.tris)} triangles (near ${k(ci.tallTris)}), ${k(city.farStats.verts)} vertices of their own (near ${k(city.farStats.nearVerts)}), meshes made in ${city.farStats.ms.toFixed(0)} ms; tall built in ${(ci.msTall / 1e3).toFixed(2)} s` : 'none (this checkout has no far meshes)'}`);
  for (const p of VIEWS) {
    await T.step(`view ${p.name}`, async () => {
      await put(p);
      const near = frame(Infinity, A);
      if (!FAR) { T.log(`VIEW ${p.name}: buildings ${k(near.bt)} tris in ${near.bm} meshes | frame ${k(near.tris)} tris, ${near.calls} calls`); await show(A, p.name); frame(Infinity, A, true); await show(A, p.name + '-bld'); return; }
      const far = frame(1000, B), px = diff(A, B);
      T.log(`VIEW ${p.name}: buildings far ${k(far.bt)} tris in ${far.bm} meshes, all near ${k(near.bt)} in ${near.bm} | frame far ${k(far.tris)} tris, ${far.calls} calls, all near ${k(near.tris)}, ${near.calls} | ${px} pixels differ`);
      await show(B, p.name); await show(A, p.name + '-near');
      frame(1000, B, true); frame(Infinity, A, true); T.log(`     buildings alone: ${diff(A, B)} pixels differ`); await show(B, p.name + '-bld'); await show(A, p.name + '-bld-near');
    });
    if (p.time != null) W.setTime(10);
  }
  if (!FAR) return;
  await T.step('a building knocked down in a far cell', async () => {
    await put(VIEWS[0]);
    // the tallest destructible tall building in a cell drawn far in this view, nearest its group's edge among those
    const D = W.destruct, H = city.city.hdr, G = H.tile * 2;
    frame(1000, B);
    const cells = city.tallMeshes.filter((c) => c.fm?.visible); let best = null;
    for (const a of city.grid.values()) for (const e of a) {
      if (!e.dk || !e.rng || e.rng.length < 2 || e[3] < 80 || (best && e[3] <= best.e[3])) continue;
      const cx = e[0], cz = e[2]; if (!cells.some((c) => cx >= c.box[0] && cx <= c.box[3] && cz >= c.box[2] && cz <= c.box[5])) continue;
      const q = new THREE.Vector3(cx, e[1] + e[3], cz).project(cam); if (Math.abs(q.x) > 0.8 || Math.abs(q.y) > 0.8 || q.z > 1) continue; // (its top on screen)
      const gx = (cx - H.x0) / G, gz = (cz - H.z0) / G, edge = Math.min(gx - Math.floor(gx), Math.ceil(gx) - gx, gz - Math.floor(gz), Math.ceil(gz) - gz) * G;
      if (edge < 200) best = { e, edge };
    }
    T.check('found a tall building in a far cell near a group edge', !!best);
    if (!best) return;
    const pr = new THREE.Vector3(best.e[0], best.e[1] + best.e[3], best.e[2]).project(cam); T.log(`candidate top at screen ${pr.x.toFixed(2)}, ${pr.y.toFixed(2)}, height ${best.e[3].toFixed(0)}, base ${best.e[1].toFixed(0)}, dist ${Math.round(cam.position.distanceTo(new THREE.Vector3(best.e[0], best.e[1], best.e[2])))} m`);
    const e = best.e, A0 = new Uint8Array(IW * IH * 4), N0 = new Uint8Array(IW * IH * 4);
    frame(1000, A0); frame(Infinity, N0); const before = diff(A0, N0);
    // (it and everything standing within 30 m of it: a tower is often its outline and its building:parts, one in front of the other)
    const all = new Set(); for (const a of city.grid.values()) for (const x of a) if (x.dk && x.rng && Math.hypot(x[0] - e[0], x[2] - e[2]) < 30) all.add(x);
    for (const x of all) D.setCut(D.get(x), x[1] + 1, 0);
    const Bs = D.get(e); DMG.tex.needsUpdate = true; T.log(`${all.size} buildings knocked down`);
    const runs = e.rng.map(([h, s, n]) => { const a = h.geo?.attributes.dmg?.array; return a && a.length > s ? a[s] : -1; });
    T.check('its far copy carries its damage (every vertex run, the far one too, the same slot)', runs.length >= 2 && runs.every((v) => v === Bs.slot && v > 0), `slot ${Bs.slot}, runs ${JSON.stringify(runs)}`);
    const far = frame(1000, B), near = frame(Infinity, A), after = diff(A, B), gone = diff(A0, B), goneN = diff(N0, A);
    T.log(`KNOCKED DOWN ${e.dk} (${Math.round(e[3])} m, ${Math.round(best.edge)} m from its group's edge, at ${Math.round(e[0])}, ${Math.round(e[2])}): far vs near ${after} pixels differ (${before} before it came down); far before vs after ${gone}, near before vs after ${goneN} | far ${k(far.tris)} near ${k(near.tris)}`);
    T.check('down in the far mesh as in the near one', after <= before + 200 && gone > 200, `far vs near ${after} (before ${before}), far before vs after ${gone}`);
    await show(B, 'knocked-down-far'); await show(A, 'knocked-down-near');
  });
  rt.dispose(); cv.remove();
}
