// Railway lines drawn in play (a measuring tool, not one of CI's jobs: counts and pictures, no verdicts):
//   python3 tools/test/jobs.py railvis --quality low --out DIR      (one Chrome; New York, then Lauterbrunnen)
// At each spot (a rail on a slope, a banked curve, a bridge, a level crossing) the Kestrel is parked on the line and
// the game runs its real loop (traffic.update -> towns.update shows the rail chunks near the camera). Then, with the
// chase camera and with a close camera looking down on the line: the rail chunk meshes near it (in the scene, visible,
// in the frustum, on the camera's layers), the steel rails' and bed's heights above the ground there (World.groundAt
// and sampleGrid), the rails' pixels drawn alone (only the rail chunks visible) and in the whole frame (pixels that
// change when the rails are hidden), and a screenshot of each close view.
import { toLocal } from '../../../src/realworld.js';

// spots: [x, z] world (railprobe: worst slope, sharpest curve on a grade, a bridge, a crossing with a road)
const PLACES = {
  nyc: { slope: [-9500.3, 7319.8], curve: [-9980.5, 8821.5], bridge: [-4095.3, 386], crossing: [-9771.6, 16394.8] },
  lauterbrunnen: { slope: [-1208.7, -10312.8], curve: [1881.1, 1448.4], bridge: [-2370, 20392.6], crossing: [10537.9, 7507.1] },
};

export async function run(T) {
  for (const [loc, spots] of Object.entries(PLACES)) {
    await T.step(`${loc}: build`, async () => { await T.start('Kestrel', loc); });
    for (const [what, at] of Object.entries(spots)) await T.step(`${loc} ${what}`, () => spot(T, loc, what, at), { allowStalls: true });
  }
}

async function spot(T, loc, what, at) {
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, R = S.renderer, rs = W.towns, chunks = rs.railChunks || [];
  // the nearest steel-rail vertex to the spot (any chunk): the line itself, and its direction there
  let best = null;
  for (const c of chunks) {
    if (!c.steel || Math.hypot(c.x - at[0], c.z - at[1]) - c.r > 60) continue;
    const p = c.m.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) { const d = Math.hypot(p[i] - at[0], p[i + 2] - at[1]); if (!best || d < best.d) best = { d, x: p[i], y: p[i + 1], z: p[i + 2], c, i }; }
  }
  if (!best) return `no steel rail within 60 m of ${at}`;
  const p = best.c.m.geometry.attributes.position.array, j = best.i + 6 < p.length ? best.i + 6 : best.i - 6;
  const hdg = Math.atan2(p[j] - best.x, -(p[j + 2] - best.z)) * (j > best.i ? 1 : -1);
  // park the Kestrel beside the line, facing along it, and run the real loop (settle: stepped + drawn frames)
  const g = W.groundAt(best.x + 8 * Math.cos(hdg), best.z + 8 * Math.sin(hdg), 1e4)?.h ?? W.heightAt(best.x, best.z);
  T.teleport({ pos: [best.x + 8 * Math.cos(hdg), g + 3, best.z + 8 * Math.sin(hdg)], heading: -hdg });
  await T.settle({ quiet: 2, max: 30 });
  await T.frames(3);
  const cam = S.rig.cam;
  const out = [`rail at (${best.x.toFixed(1)}, ${best.z.toFixed(1)}) ${best.d.toFixed(1)} m from the spot`];
  out.push('chase: ' + measure(T, cam, best));
  // a close camera looking down on the line (the frame loop paused: nothing moves it; rails' visibility as the loop left it)
  F.paused = true;
  const c2 = cam.clone(); const e = 35 * Math.PI / 180, d = 10, l = new THREE.Vector3(Math.sin(hdg + 0.6) * Math.cos(e), -Math.sin(e), -Math.cos(hdg + 0.6) * Math.cos(e));
  c2.position.set(best.x - l.x * d, best.y - l.y * d, best.z - l.z * d); c2.lookAt(best.x, best.y, best.z); c2.updateMatrixWorld(); c2.updateProjectionMatrix();
  out.push('close: ' + measure(T, c2, best));
  cam.position.copy(c2.position); cam.quaternion.copy(c2.quaternion); cam.updateMatrixWorld();
  R.setRenderTarget(null); R.render(F.scene, cam);
  await T.shot(`${loc}-${what}-close`);
  F.paused = false;
  for (const s of out) T.log(s);
  return out.join(' | ');
}

// rail chunk state and pixels from camera c
function measure(T, c, best) {
  const S = T.S, F = S.F, W = F.world, THREE = T.THREE, R = S.renderer, chunks = W.towns.railChunks;
  c.updateMatrixWorld();
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse)), sph = new THREE.Sphere();
  const near = chunks.filter((k) => Math.hypot(k.x - best.x, k.z - best.z) - k.r < 30);
  const chainVis = (o) => { for (let v = o; v; v = v.parent) if (!v.visible) return false; return true; };
  let inScene = 0, vis = 0, chain = 0, inFr = 0, onLayer = 0;
  for (const k of near) {
    let root = k.m; while (root.parent) root = root.parent; if (root === F.scene) inScene++;
    if (k.m.visible) vis++; if (chainVis(k.m)) chain++;
    sph.copy(k.m.geometry.boundingSphere).applyMatrix4(k.m.matrixWorld); if (fr.intersectsSphere(sph)) inFr++;
    if (k.m.layers.test(c.layers)) onLayer++;
  }
  // heights near the spot: steel and bed above World.groundAt / sampleGrid
  const hs = { steel: [], bed: [] };
  for (const k of near) {
    const p = k.m.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.hypot(p[i] - best.x, p[i + 2] - best.z) > 15) continue;
      const ga = W.groundAt(p[i], p[i + 2], 1e4)?.h, sg = W.sampleGrid(p[i], p[i + 2]);
      hs[k.steel ? 'steel' : 'bed'].push([p[i + 1] - ga, p[i + 1] - sg]);
    }
  }
  const rng = (a, k) => a.length ? `${Math.min(...a.map((v) => v[k])).toFixed(2)}..${Math.max(...a.map((v) => v[k])).toFixed(2)}` : '-';
  // pixels: the rails alone (everything else hidden) and in the whole frame (differs with the rail chunks hidden)
  const w = 640, h = 400, rt = new THREE.WebGLRenderTarget(w, h), a = new Uint8Array(w * h * 4), b = new Uint8Array(w * h * 4);
  const asp = c.aspect; c.aspect = w / h; c.updateProjectionMatrix();
  const draw = (buf) => { R.setRenderTarget(rt); R.setClearColor(0, 0); R.clear(); R.info.autoReset = true; R.render(F.scene, c); const calls = R.info.render.calls; R.readRenderTargetPixels(rt, 0, 0, w, h, buf); R.setRenderTarget(null); return calls; };
  const railSet = new Set(chunks.map((k) => k.m));
  const keep = new Map(); F.scene.traverse((o) => keep.set(o, o.visible));
  const bg = F.scene.background; F.scene.background = null;
  // alone
  F.scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && !railSet.has(o)) o.visible = false; });
  const callsAlone = draw(a); let alone = 0; for (let i = 3; i < a.length; i += 4) if (a[i]) alone++;
  const aloneForced = (() => { for (const k of near) k.m.visible = true; draw(b); let n = 0; for (let i = 3; i < b.length; i += 4) if (b[i]) n++; return n; })();
  for (const [o, v] of keep) o.visible = v;
  F.scene.background = bg;
  // in the frame
  draw(a); for (const k of chunks) k.m.visible = false; draw(b); for (const [o, v] of keep) o.visible = v;
  let diff = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  c.aspect = asp; c.updateProjectionMatrix(); rt.dispose();
  return `${near.length} chunks near (${near.filter((k) => k.steel).length} steel): ${inScene} in scene, ${vis} visible (${chain} with parents), ${inFr} in frustum, ${onLayer} on cam layers; ` +
    `steel-groundAt ${rng(hs.steel, 0)} steel-grid ${rng(hs.steel, 1)} bed-groundAt ${rng(hs.bed, 0)} bed-grid ${rng(hs.bed, 1)}; ` +
    `px alone ${alone} (${callsAlone} calls; near chunks forced visible ${aloneForced}), px in frame ${diff}`;
}
