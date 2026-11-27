// The crew's distance detail (planeDetail's DetailLOD picks the level by size on screen). Kept apart from crew.js:
// that file's hash (with body.js) versions the solved postures (deploy.yml SOLVER), and none of this changes a pose.
import * as THREE from 'three';
import { MeshoptSimplifier } from '../vendor/addons/meshopt_simplifier.module.js';

// A full figure is 50k-200k triangles in 7 slots, most of it in curves and faces far finer than a pixel a few tens of
// metres away. A far level of each slot's geometry is the same mesh simplified (meshoptimizer's edge collapse) until
// its surface would move by up to `err` metres, colour and normals weighed in so the suit's seams, the eyes and the
// visor's edge keep their shape. It's only a new index buffer over the same vertices (each kept vertex keeps its own
// skin weights, and separate pieces never weld: a hand never joins the stick it holds), with the same materials and
// the same skeleton, so swapping it in compiles nothing and uploads one small buffer.
await MeshoptSimplifier.ready;
const lodCache = new WeakMap();
function simplified(g, err) {
  const P = g.attributes.position, Nn = g.attributes.normal, C = g.attributes.color, n = P.count, attr = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) { attr[i * 6] = Nn.getX(i); attr[i * 6 + 1] = Nn.getY(i); attr[i * 6 + 2] = Nn.getZ(i); attr[i * 6 + 3] = C.getX(i); attr[i * 6 + 4] = C.getY(i); attr[i * 6 + 5] = C.getZ(i); }
  const pos = P.array instanceof Float32Array && P.itemSize === 3 && !P.isInterleavedBufferAttribute ? P.array : Float32Array.from({ length: n * 3 }, (_, k) => P.getComponent(Math.floor(k / 3), k % 3));
  const [ix] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(g.index.array), pos, 3, attr, 6, [0.02, 0.02, 0.02, 0.1, 0.1, 0.1], null, 0, err, ['ErrorAbsolute']);
  const r = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) r.setAttribute(k, g.attributes[k]); // (shared: one copy of the vertices on the GPU)
  r.setIndex(new THREE.BufferAttribute(n > 65535 ? ix : Uint16Array.from(ix), 1));
  return r;
}
// Each level's error (metres, from the full figure: level 0): 2 mm, 6 mm, 15 mm, 35 mm. A Kestrel's pilot (58k
// triangles) is then 17k / 9k / 3.8k / 1.7k; an airliner's two 96k / 25k / 13k / 5.4k / 2.2k. (Measured, #188 follow-up:
// a level whose error is under about a pixel on screen can't be told from the full figure, layered straps included;
// at 4 px the faces soften and the 35 mm level's arms and harness go lumpy, so it's only for figures a few tens of
// pixels tall.)
export const CREW_LOD_ERR = [0.002, 0.006, 0.015, 0.035];
// Every level geometry made for a crew mesh so far (none: []): main.js collectGpu frees them all with the flight, not
// just the level the mesh draws now (the others, and the full figure while a lighter level shows, aren't in the scene).
export const crewLodAll = (mesh) => (mesh.userData.crewGeo0 && lodCache.get(mesh.userData.crewGeo0)) || [];
// Each crew mesh's geometry per level ([full, lighter...]), cached per source geometry (figures of one build share it).
export function crewLodGeos(mesh) {
  const g = mesh.userData.crewGeo0 ||= mesh.geometry;
  let L = lodCache.get(g);
  if (!L) { // (each from the one before, by the difference: much quicker than from the full mesh every time)
    L = [g]; const ok = g.index && g.attributes.normal && g.attributes.color && g.attributes.position.itemSize === 3;
    CREW_LOD_ERR.forEach((e, k) => L.push(ok ? simplified(L[k], e - (CREW_LOD_ERR[k - 1] || 0)) : g));
    lodCache.set(g, L);
  }
  return L;
}
