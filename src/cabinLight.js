// Cabin lighting: inside a cockpit, cab or wheelhouse light only gets in through the glass and the openings, so the
// deck sits in shade and what you see are the windows, the displays and the backlit legends. Every lit material
// otherwise takes the whole sky's ambient and reflections (the hemisphere light, the environment map) at full
// strength wherever it is, which is what made a closed flight deck read as evenly lit, like a sim.
//
// Once per build (bakeCabinLight, after the vehicle is assembled and merged; not while a builder slider is dragged), for
// each crewed part's interior (interior.js: its declared userData.interior, or the space its seats' obstacles keep the
// crew in, so a kid's own designs get it too):
//   - the vehicle's opaque geometry round the interior is voxelised finely (~3-5 cm), and further out coarsely (so a
//     ray that leaves down a fuselage is still stopped). Glass and other see-through materials are left out: light
//     passes them. Emissive surfaces (displays, backlit panels) keep their radiance in their voxels.
//   - the cabin's air is flooded out from the seats through the empty voxels, never through glass; the outside air is
//     flooded in from the region's faces. A surface facing the cabin's air is the cabin's (glare shield, posts,
//     overhead, lining), one facing the outside is not, whatever part it belongs to: exteriors never change.
//   - from each cabin surface point (deduplicated per few voxels and normal direction) a fixed set of rays over the
//     hemisphere round its normal is marched: the cosine-weighted share that gets out is its sky visibility (plus a
//     little bounce off the cabin's own surfaces), what they hit that glows is the light the displays throw on it, and
//     a linear fit of which directions are open stands in for sun shadows when there are no shadow maps
//   - the crew: a probe at each bone, all round; each vertex takes its bones' probes as seen along its normal
//   - it all goes on the mesh as vertex attributes (cabinLight: visibility and glow for the front face and the back,
//     cabinSun: the fit) and the mesh gets a variant of its material that multiplies the ambient and reflected sky
//     light (hemisphere light, environment map) by the visibility and adds the glow. Direct sun is left to the shadow
//     maps (glass casts none, so it falls through the windows onto the deck); with them off (Low, or shed under load)
//     the fit gates it. Emissive light is never touched: displays stay as bright as they were. Exposure stays the
//     world's (the renderer's is fixed): the view out is bright and the deck dark, like the photos.
// An open boat (no interior) gets the same for the space round its seats, at OPEN_K strength.
// Runtime cost: two attributes read in the vertex shader and a few multiplies per pixel on the cabin's meshes, no extra
// draw calls (one material variant per material, shared by every vehicle). Bake: ~70-150 ms per cockpit on a desktop.
import * as THREE from 'three';
import { interiorOf } from './interior.js';
import { LIGHT } from './version.js';

// ---------- the saved bakes ----------
// A bake depends only on the vehicle's built meshes (shapes, placement, materials, the crew's pose) and on this code,
// so each device keeps the finished per-vertex values of the vehicles it has built (IndexedDB, the newest MAX_SAVED),
// keyed by a fingerprint of those meshes (sigOf) and LIGHT (a hash of this file and interior.js, stamped by the
// deploy). Building the same vehicle again, in the hangar or for a flight, on this visit or a later one, applies
// them instead of baking. Locally (LIGHT 'dev') they're only kept for the visit.
const MAX_SAVED = 12, SAVED = new Map(), DB = 'skywright-cabin', STORE = 'bakes';
const db = LIGHT === 'dev' || typeof indexedDB === 'undefined' ? null : new Promise((res) => {
  try { const rq = indexedDB.open(DB, 1); rq.onupgradeneeded = () => rq.result.createObjectStore(STORE); rq.onsuccess = () => res(rq.result); rq.onerror = rq.onblocked = () => res(null); } catch { res(null); }
});
// resolves once the saved bakes are in memory (main.js waits for it before building; never longer than 2 s)
export const cabinBakesReady = !db ? Promise.resolve() : Promise.race([new Promise((r) => setTimeout(r, 2000)), db.then((d) => d && new Promise((res) => {
  try { const tx = d.transaction(STORE, 'readonly'), st = tx.objectStore(STORE), rk = st.getAllKeys(), rv = st.getAll();
    tx.oncomplete = () => { rk.result.forEach((k, i) => { if (k.startsWith(LIGHT + ':')) SAVED.set(k, rv.result[i]); }); res(); }; tx.onerror = tx.onabort = () => res();
  } catch { res(); } }))]);
function keepBake(key, rec) {
  SAVED.set(key, rec);
  if (SAVED.size > MAX_SAVED * 2) SAVED.delete(SAVED.keys().next().value); // (memory: the oldest)
  db?.then((d) => { if (!d) return; try {
    const tx = d.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE); st.put(rec, key);
    const rk = st.getAllKeys(); rk.onsuccess = () => { const old = rk.result.filter((k) => !k.startsWith(LIGHT + ':')); for (const k of old) st.delete(k); // (an older version's)
      const mine = [...SAVED].filter(([k]) => rk.result.includes(k) || k === key).sort((a, b) => b[1].t - a[1].t); for (const [k] of mine.slice(MAX_SAVED)) { st.delete(k); SAVED.delete(k); } };
  } catch { /* storage full or unavailable */ } });
}
// The fingerprint of everything a bake reads: each shown mesh's vertex and index counts, a sample of its positions,
// normals and indices, its placement under the root, its material's say in the bake (opaque, lit, side, glow), the
// crew's bones where they are, and the crewed parts' declared interiors, seats and lamps.
function sigOf(allMeshes, owners, crewOf, rootInv) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const add = (v) => { const x = Math.round(v * 1e4) | 0; h1 = Math.imul(h1 ^ x, 16777619); h2 = Math.imul(h2 ^ x, 2246822519) ^ (h2 >>> 13); };
  const str = (s) => { for (let i = 0; i < s.length; i++) add(s.charCodeAt(i)); };
  const arr = (a, step) => { if (!a) { add(-1); return; } add(a.length); for (let i = 0; i < a.length; i += step) add(a[i]); };
  for (const m of allMeshes) {
    const g = m.geometry, mat = m.material, em = emission(mat, false);
    arr(g.attributes.position.array, 5); arr(g.attributes.normal?.array, 11); arr(g.index?.array, 7);
    for (const e of _m.multiplyMatrices(rootInv, m.matrixWorld).elements) add(e);
    add(OPAQUE(mat, m) ? 1 : 0); add(LIT(mat) ? 1 : 0); add(mat.side ?? 0); add(m.userData.near ? 1 : 0); add(m.isSkinnedMesh ? 1 : 0); add(crewOf.has(m) ? 1 : 0);
    if (em) { add(em.k); const im = (mat.emissiveMap || mat.map)?.image; if (im) { add(im.width || 0); add(im.height || 0); } }
    if (m.isSkinnedMesh) for (const b of m.skeleton.bones) { b.getWorldPosition(_v).applyMatrix4(rootInv); add(_v.x); add(_v.y); add(_v.z); }
  }
  for (const o of owners) { try { str(JSON.stringify([o.userData.interior || null, o.userData.seats || null, o.userData.cabinLamps || null, !!o.userData.cabinDeep])); } catch { add(-2); } }
  return `${LIGHT}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${allMeshes.length}`;
}

const MAX_VOX = 6e5; // voxels per interior (the voxel size grows to fit: ~4 cm for an airliner's deck, ~2.5 cm for a bubble)
const MIN_H = 0.02;
const REACH = 0.6; // metres round the interior voxelised finely
const CELL = 1 / 3; // surface points closer than 3 voxels, facing the same way, share one sample
const FAR = 6; // ... and coarsely, out to this far (rays that get further out are free)
const NEAR = 0.5; // the cabin air is flooded out to this far round the interior (the deck in front of and above the crew)
const BOUNCE_MIN = 0.06, BOUNCE = 1.0; // light coming back off the interior's own surfaces (more, the more open the interior is)
// ... except in a deep, enclosed deck (a part that says userData.cabinDeep: an airliner's flight deck, a narrow band of
// windows round a big room): little light gets in to bounce there, and the photos show it dark round bright windows.
// It keeps only DEEP of the floor (the share that comes with its own openness stays).
const DEEP = 0.25;
const OPEN_K = 0.6; // an open cockpit (no interior: a speedboat's, a pontoon's) is darkened this much of what the bake finds
const GLOW_K = 1.0; // display light scale (radiance -> the factor the shader adds)
// A deck's own lamps at night (a part's userData.cabinLamps, part space: the dome light, the panel and pedestal floods, the
// map lights): baked like the rest (irradiance at each cabin surface and crew vertex, shadowed through the voxels), and
// switched on with the night (uCabinNight) in a warm colour; plus LAMP_FILL of their mean, the light they bounce round the
// deck. With them the panels' integral lighting comes up: the dim legends in the emissive maps glow BACKLIT times more.
const LAMP_MAX = 4, LAMP_FILL = 0.7, BACKLIT = 4.0, LAMP_GAIN = 8.0; // (LAMP_GAIN: baked irradiance -> radiance on the deck, by eye against the night photo)

// ---------- the shader side ----------
export const CABIN = {
  uCabinSunDir: { value: new THREE.Vector3(0, 1, 0) }, // towards the sun (or the moon by night), world space
  uCabinSunBake: { value: 0 }, // 1: no shadow maps, the baked sun visibility gates direct light
  uCabinDebug: { value: 0 }, // (tools: 1 shows the sky visibility, 2 the display glow, 3 the baked sun)
  uCabinNight: { value: 0 }, // 0 by day, 1 at night: how far the decks' own lamps are up
  uCabinLampCol: { value: new THREE.Color(1.0, 0.68, 0.38) }, // their light: warm incandescent
};
// called by the flight each frame (and by the hangar): the light's direction, whether shadow maps are on, how dark it is
export function cabinSun(dir, shadows, night = 0) { CABIN.uCabinSunDir.value.copy(dir); CABIN.uCabinSunBake.value = shadows ? 0 : 1; CABIN.uCabinNight.value = night; }

const VERT_PARS = /* glsl */`
attribute vec4 cabinLight; attribute vec4 cabinSun; varying vec4 vCabin; varying float vCabinSun; uniform vec3 uCabinSunDir;
#ifdef CABIN_LAMP
attribute vec2 cabinLamp; varying vec2 vCabinLamp;
#endif`;
const VERT = /* glsl */`
vCabin = cabinLight;
#ifdef CABIN_LAMP
vCabinLamp = cabinLamp;
#endif
{ mat4 cabM = modelMatrix;
#ifdef USE_BATCHING
cabM = modelMatrix * batchingMatrix; // (a batched plane: the mesh's own frame, acBatch.js)
#endif
vec3 sd = normalize((vec4(uCabinSunDir, 0.0) * cabM).xyz); vCabinSun = clamp(cabinSun.x + 2.0 * dot(cabinSun.yzw, sd), 0.0, 1.0); }`;
const FRAG_PARS = /* glsl */`
varying vec4 vCabin; varying float vCabinSun; uniform float uCabinSunBake; uniform float uCabinDebug;
#ifdef CABIN_LAMP
varying vec2 vCabinLamp; uniform float uCabinNight; uniform vec3 uCabinLampCol;
#endif`;
// (a double-sided skin's two faces are lit apart: its outside by the sky, its inside by what gets in)
const FRAG = /* glsl */`
{ float ca = gl_FrontFacing ? vCabin.x : vCabin.z, cg = (gl_FrontFacing ? vCabin.y : vCabin.w) * 4.0;
  reflectedLight.indirectDiffuse *= ca; reflectedLight.indirectSpecular *= ca;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ca;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ca;
  #endif
  reflectedLight.indirectDiffuse += diffuseColor.rgb * cg * vec3(0.85, 0.95, 1.0);
  #ifdef CABIN_LAMP
  if (uCabinNight > 0.0) { // (the deck's lamps, and the panels' integral lighting)
    reflectedLight.indirectDiffuse += diffuseColor.rgb * uCabinLampCol * ((gl_FrontFacing ? vCabinLamp.x : vCabinLamp.y) * ${(LAMP_MAX * LAMP_GAIN).toFixed(1)} * uCabinNight);
    float em = max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
    totalEmissiveRadiance *= 1.0 + uCabinNight * ${BACKLIT.toFixed(1)} * (1.0 - smoothstep(0.1, 0.35, em)); }
  #endif
  if (uCabinSunBake > 0.5) { float s = smoothstep(0.15, 0.6, vCabinSun); reflectedLight.directDiffuse *= s; reflectedLight.directSpecular *= s; }
  if (uCabinDebug > 0.5) { reflectedLight.directDiffuse = reflectedLight.directSpecular = reflectedLight.indirectSpecular = vec3(0.0); reflectedLight.indirectDiffuse = vec3(uCabinDebug < 1.5 ? ca : uCabinDebug < 2.5 ? cg : vCabinSun); } }`;

const LIT = (m) => m && !Array.isArray(m) && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial) && !m.transparent && !(m.transmission > 0);
const VARIANTS = new WeakMap(), LAMP_VARIANTS = new WeakMap();
// the cabin-lit variant of a material (one per material, shared by every vehicle; its own hook and key kept); lamp: the
// one that also takes a deck's night lamps (cabinLamp)
export function cabinMaterial(base, lamp = false) {
  if (base.userData?.cabinLit) return base;
  const V = lamp ? LAMP_VARIANTS : VARIANTS;
  let v = V.get(base); if (v) return v;
  try { v = base.clone(); } catch { return null; }
  const bob = base.onBeforeCompile, bkey = base.customProgramCacheKey();
  v.onBeforeCompile = (sh, r) => {
    bob.call(base, sh, r);
    Object.assign(sh.uniforms, CABIN);
    const def = lamp ? '\n#define CABIN_LAMP\n' : ''; // (in the source, not material.defines: a material's copy() resets those)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + def + VERT_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + def + FRAG_PARS).replace('#include <aomap_fragment>', '#include <aomap_fragment>' + FRAG);
  };
  v.customProgramCacheKey = () => (lamp ? 'cabin2|' : 'cabin1|') + bkey;
  v.userData.cabinLit = true; // (a flag, not the base itself: userData is copied through JSON when a material is cloned)
  V.set(base, v);
  return v;
}

// a material cloned from a cabin-lit one (scorched in a crash) keeps the cabin light, and its compiled shader
export function keepCabinPatch(from, to) { if (from.userData?.cabinLit) { to.onBeforeCompile = from.onBeforeCompile; to.customProgramCacheKey = from.customProgramCacheKey; } }

// ---------- directions ----------
export const K = 48, DIRS = new Float32Array(K * 3);
for (let i = 0; i < K; i++) { // a Fibonacci sphere: even, the same for every point (no noise between neighbours)
  const y = 1 - (2 * (i + 0.5)) / K, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
  DIRS[i * 3] = Math.cos(a) * r; DIRS[i * 3 + 1] = y; DIRS[i * 3 + 2] = Math.sin(a) * r;
}

// ---------- emissive radiance of a material (and its emissive map, sampled where it is hit) ----------
const texData = new WeakMap();
function texSampler(t) {
  if (!t?.image) return null;
  if (texData.has(t)) return texData.get(t);
  let s = null;
  try {
    const img = t.image, w = Math.min(256, img.width || 0), h = Math.min(256, img.height || 0);
    if (w && h) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data, L = new Float32Array(w * h), lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      for (let i = 0; i < w * h; i++) L[i] = 0.2126 * lin(d[i * 4]) + 0.7152 * lin(d[i * 4 + 1]) + 0.0722 * lin(d[i * 4 + 2]);
      t.updateMatrix(); const m = t.matrix.elements, wrapS = t.wrapS, wrapT = t.wrapT, flip = t.flipY;
      const wrap = (x, mode) => (mode === THREE.RepeatWrapping ? x - Math.floor(x) : mode === THREE.MirroredRepeatWrapping ? 1 - Math.abs(1 - ((x % 2) + 2) % 2) : Math.min(1, Math.max(0, x)));
      s = (u, v) => { let x = m[0] * u + m[3] * v + m[6], y = m[1] * u + m[4] * v + m[7]; x = wrap(x, wrapS); y = wrap(y, wrapT); if (flip) y = 1 - y; return L[Math.min(h - 1, Math.floor(y * h)) * w + Math.min(w - 1, Math.floor(x * w))]; };
    }
  } catch { s = null; }
  texData.set(t, s); return s;
}
// sample = false: only how bright (sigOf's fingerprint needs no more; reading a texture back is the costly part, seconds
// on a software GPU, and a fresh build's display textures are new every time, so the fingerprint of a bake that is
// already saved never reads one)
function emission(m, sample = true) {
  if (!m || Array.isArray(m)) return null;
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (m.isMeshBasicMaterial) { const k = lum(m.color); return k > 0.05 ? { k, map: m.map && sample ? texSampler(m.map) : null } : null; } // (unlit: it is its own light)
  if (!m.emissive) return null;
  const k = lum(m.emissive) * (m.emissiveIntensity ?? 1); if (k < 0.01) return null;
  return { k, map: m.emissiveMap && sample ? texSampler(m.emissiveMap) : null };
}


// ---------- the bake ----------
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4(), _nm = new THREE.Matrix3();
const shown = (o, root) => { for (let x = o; x && x !== root; x = x.parent) if (!x.visible && !x.userData.near && !x.userData.crewRig) return false; return true; };
const OPAQUE = (m, mesh) => !Array.isArray(m) && !m.transparent && !(m.transmission > 0) && m.visible !== false && m.colorWrite !== false && !mesh.userData.isDisc && m.blending !== THREE.AdditiveBlending;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const isUnder = (o, owner) => { for (let x = o; x; x = x.parent) if (x === owner) return true; return false; };

// positions and normals of a mesh in root space (skinned meshes as posed)
function meshVerts(mesh, toRoot) {
  const g = mesh.geometry, P = g.attributes.position, N = g.attributes.normal, n = P.count, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  _m.multiplyMatrices(toRoot, mesh.matrixWorld); _nm.getNormalMatrix(_m);
  const skin = mesh.isSkinnedMesh, e = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (skin) mesh.getVertexPosition(i, _v); else _v.fromBufferAttribute(P, i);
    if (N) {
      _n.fromBufferAttribute(N, i);
      if (skin) { e.fromBufferAttribute(P, i).addScaledVector(_n, 0.01); mesh.applyBoneTransform(i, e); _n.copy(e).sub(_v); }
      _n.applyMatrix3(_nm).normalize();
    } else _n.set(0, 1, 0);
    _v.applyMatrix4(_m);
    pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z; nrm[i * 3] = _n.x; nrm[i * 3 + 1] = _n.y; nrm[i * 3 + 2] = _n.z;
  }
  return { pos, nrm, n };
}

// Scratch buffers kept between bakes (zeroed on loan): a rebuild doesn't churn megabytes through the collector
const POOL = new Map();
function buf(name, Type, n) { let b = POOL.get(name); if (!b || b.length < n) { b = new Type(Math.ceil(n * 1.25)); POOL.set(name, b); } const v = b.subarray(0, n); v.fill(0); return v; }
// An occupancy grid over box (root space), voxel size h; emit: also keep the emitted radiance per voxel
function grid(box, h, emit, name = 'g') {
  const s = box.getSize(new THREE.Vector3()), nx = Math.ceil(s.x / h) + 1, ny = Math.ceil(s.y / h) + 1, nz = Math.ceil(s.z / h) + 1;
  return { o: box.min.clone(), h, nx, ny, nz, occ: buf(name + 'o', Uint8Array, nx * ny * nz), e: emit ? buf(name + 'e', Float32Array, nx * ny * nz) : null };
}
// Mark a mesh's triangles in the grid: points at most half a voxel apart over each triangle, a third of a voxel either
// side of it (so a ray can't slip between the voxels of a thin skin)
function voxelise(G, pos, ix, em, uv) {
  const { o, h, nx, ny, nz, occ, e: eSum } = G, nt = (ix ? ix.length : pos.length / 3) / 3, ih = 1 / h;
  for (let t = 0; t < nt; t++) {
    const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
    const ax = (pos[a * 3] - o.x) * ih, ay = (pos[a * 3 + 1] - o.y) * ih, az = (pos[a * 3 + 2] - o.z) * ih;
    const bx = (pos[b * 3] - o.x) * ih, by = (pos[b * 3 + 1] - o.y) * ih, bz = (pos[b * 3 + 2] - o.z) * ih;
    const cx = (pos[c * 3] - o.x) * ih, cy = (pos[c * 3 + 1] - o.y) * ih, cz = (pos[c * 3 + 2] - o.z) * ih;
    if (Math.max(ax, bx, cx) < -1 || Math.max(ay, by, cy) < -1 || Math.max(az, bz, cz) < -1 || Math.min(ax, bx, cx) > nx || Math.min(ay, by, cy) > ny || Math.min(az, bz, cz) > nz) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; const fl = Math.hypot(fx, fy, fz) || 1; fx *= 0.33 / fl; fy *= 0.33 / fl; fz *= 0.33 / fl;
    const L = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(cx - bx, cy - by, cz - bz)), S = Math.max(1, Math.ceil(L * 2));
    for (let i = 0; i <= S; i++) for (let j = 0; i + j <= S; j++) {
      const s = i / S, r = j / S, px = ax + ux * s + vx * r, py = ay + uy * s + vy * r, pz = az + uz * s + vz * r;
      let ee = 0;
      if (em) { ee = em.k; if (em.map && uv) { const q = 1 - s - r; ee *= em.map(uv.getX(a) * q + uv.getX(b) * s + uv.getX(c) * r, uv.getY(a) * q + uv.getY(b) * s + uv.getY(c) * r); } }
      for (let k = -1; k <= 1; k += 2) {
        const X = Math.floor(px + fx * k), Y = Math.floor(py + fy * k), Z = Math.floor(pz + fz * k);
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const id = X + nx * (Y + ny * Z); if (occ[id] < 255) occ[id]++; if (eSum && ee) eSum[id] += ee;
      }
    }
  }
}
// March a ray through grid G from (x, y, z) (voxel units) along d: the voxel hit, or -1 - (distance travelled, voxels).
// skip: what it meets in its first `skip` voxels doesn't count (the surface's own, when it leaves from just off it)
export function march(G, x, y, z, dx, dy, dz, skip = 0) {
  const { nx, ny, nz, occ } = G;
  let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = Math.abs(1 / (dx || 1e-9)), tdy = Math.abs(1 / (dy || 1e-9)), tdz = Math.abs(1 / (dz || 1e-9));
  let tx = (dx > 0 ? X + 1 - x : x - X) * tdx, ty = (dy > 0 ? Y + 1 - y : y - Y) * tdy, tz = (dz > 0 ? Z + 1 - z : z - Z) * tdz, t = 0;
  for (;;) {
    if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) return -1 - t;
    const id = X + nx * (Y + ny * Z); if (occ[id] && t >= skip) return id;
    if (tx < ty) { if (tx < tz) { X += sx; t = tx; tx += tdx; } else { Z += sz; t = tz; tz += tdz; } } else if (ty < tz) { Y += sy; t = ty; ty += tdy; } else { Z += sz; t = tz; tz += tdz; }
  }
}

// Does a surface point (voxel units) with normal m face the cabin's air: just off it, or a little further out with
// some slack sideways (a corner of a box among other furniture)
function facesAir(G, air, px, py, pz, mx, my, mz, strict = false) {
  const { nx, ny, nz } = G;
  const at = (X, Y, Z) => X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && air[X + nx * (Y + ny * Z)];
  if (at(Math.floor(px + mx * 1.2), Math.floor(py + my * 1.2), Math.floor(pz + mz * 1.2))) return true;
  if (strict) return at(Math.floor(px + mx * 2), Math.floor(py + my * 2), Math.floor(pz + mz * 2));
  for (const k of [2, 3, 4.5]) {
    const X = Math.floor(px + mx * k), Y = Math.floor(py + my * k), Z = Math.floor(pz + mz * k);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (at(X + a, Y + b, Z + c)) return true;
  }
  return false;
}
// Any of the air within r voxels of a point
function nearAir(G, air, px, py, pz, r) {
  const { nx, ny, nz } = G, X0 = Math.floor(px), Y0 = Math.floor(py), Z0 = Math.floor(pz);
  for (let Z = Math.max(0, Z0 - r); Z <= Math.min(nz - 1, Z0 + r); Z++) for (let Y = Math.max(0, Y0 - r); Y <= Math.min(ny - 1, Y0 + r); Y++) for (let X = Math.max(0, X0 - r); X <= Math.min(nx - 1, X0 + r); X++) if (air[X + nx * (Y + ny * Z)]) return true;
  return false;
}
// No interior (an open boat): the space round its seats, part space (none for a rider's saddle: open air)
function seatBox(owner) {
  const seats = owner.userData.seats || []; if (!seats.length || seats.some((st) => st.pegs || st.ctl === 'bars')) return null;
  const b = new THREE.Box3();
  for (const st of seats) { const p = new THREE.Vector3(...st.p), k = st.s || 1; b.expandByPoint(p.clone().add(new THREE.Vector3(-0.7 * k, -0.6 * k, -0.9 * k))); b.expandByPoint(p.clone().add(new THREE.Vector3(0.7 * k, 1.1 * k, 0.9 * k))); }
  return b;
}
// Where the crew sit (the seats' points, a little up), in voxels of G, each moved to the nearest empty voxel
function seedsOf(owner, partToRoot, ibRoot, G) {
  const pts = (owner.userData.seats || []).map((st) => new THREE.Vector3(...st.p).add(new THREE.Vector3(0, 0.45 * (st.s || 1), 0)).applyMatrix4(partToRoot));
  if (!pts.length) pts.push(ibRoot.getCenter(new THREE.Vector3()));
  const out = [];
  for (const p of pts) {
    const X0 = Math.floor((p.x - G.o.x) / G.h), Y0 = Math.floor((p.y - G.o.y) / G.h), Z0 = Math.floor((p.z - G.o.z) / G.h);
    search: for (let r = 0; r < 6; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const X = X0 + dx, Y = Y0 + dy, Z = Z0 + dz; if (X < 0 || Y < 0 || Z < 0 || X >= G.nx || Y >= G.ny || Z >= G.nz) continue;
      const id = X + G.nx * (Y + G.ny * Z); if (!G.occ[id]) { out.push(id); break search; }
    }
  }
  return out;
}
// Flood the empty voxels from the seeds (6-connected), not through glass, within box (root space)
function flood(G, glass, box, seeds, name = 'air') {
  const { nx, ny, nz, occ, o, h } = G, air = buf(name, Uint8Array, occ.length), q = buf('q', Int32Array, occ.length), nxy = nx * ny; let qh = 0, qt = 0, leak = false;
  const x0 = Math.max(0, Math.floor((box.min.x - o.x) / h)), x1 = Math.min(nx - 1, Math.floor((box.max.x - o.x) / h)), y0 = Math.max(0, Math.floor((box.min.y - o.y) / h)), y1 = Math.min(ny - 1, Math.floor((box.max.y - o.y) / h)), z0 = Math.max(0, Math.floor((box.min.z - o.z) / h)), z1 = Math.min(nz - 1, Math.floor((box.max.z - o.z) / h));
  for (const s of seeds) if (!air[s]) { air[s] = 1; q[qt++] = s; }
  while (qh < qt) {
    const id = q[qh++], X = id % nx, Y = ((id - X) / nx) % ny, Z = (id - X - Y * nx) / nxy; let j;
    if (X === 0 || Y === 0 || Z === 0 || X === nx - 1 || Y === ny - 1 || Z === nz - 1) leak = true;
    if (X > x0 && !air[j = id - 1] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
    if (X < x1 && !air[j = id + 1] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
    if (Y > y0 && !air[j = id - nx] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
    if (Y < y1 && !air[j = id + nx] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
    if (Z > z0 && !air[j = id - nxy] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
    if (Z < z1 && !air[j = id + nxy] && !occ[j] && !glass[j]) { air[j] = 1; q[qt++] = j; }
  }
  air.leak = leak; return air;
}

// The interior's extent in part space: where its depth is positive, on a coarse grid over the part's bounds
function interiorBox(I) {
  const B = I.box, S = 18, d = B.getSize(new THREE.Vector3()), out = new THREE.Box3(), p = new THREE.Vector3();
  for (let i = 0; i <= S; i++) for (let j = 0; j <= S; j++) for (let k = 0; k <= S; k++) {
    p.set(B.min.x + (d.x * i) / S, B.min.y + (d.y * j) / S, B.min.z + (d.z * k) / S);
    if (I.f(p) > 0) out.expandByPoint(p);
  }
  if (out.isEmpty()) return null;
  return out.expandByVector(d.clone().divideScalar(S)).intersect(B);
}

// Put a bake's values on a mesh: a new geometry on the same attributes plus the bake's (crew geometry is shared between
// figures, part geometry may be too), and its material's cabin variant.
function applyCabin(m, L, S, Lm, mat = cabinMaterial(m.material, !!Lm)) {
  if (!mat) return;
  const o = m.geometry, g = new THREE.BufferGeometry();
  for (const k in o.attributes) g.setAttribute(k, o.attributes[k]);
  g.setIndex(o.index); for (const gr of o.groups) g.addGroup(gr.start, gr.count, gr.materialIndex); g.morphAttributes = o.morphAttributes; g.morphTargetsRelative = o.morphTargetsRelative; g.drawRange = { ...o.drawRange };
  g.boundingBox = o.boundingBox?.clone() ?? null; g.boundingSphere = o.boundingSphere?.clone() ?? null; g.userData = o.userData;
  g.setAttribute('cabinLight', new THREE.BufferAttribute(L, 4, true));
  g.setAttribute('cabinSun', new THREE.BufferAttribute(S, 4, true));
  if (Lm) g.setAttribute('cabinLamp', new THREE.BufferAttribute(Lm, 2, true));
  m.geometry = g; m.material = mat; m.userData.cabinLit = true;
}

// Bake every crewed part of a vehicle. objs: its part objects (as assemble() takes them), root: their common parent.
// Returns timing and counts (null when off).
export function bakeCabinLight(objs, root) {
  if (globalThis.__noCabinLight) return null;
  const t0 = performance.now();
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert(), stats = { interiors: 0, verts: 0, samples: 0, probes: 0, tVox: 0, tRecv: 0, tMarch: 0 };
  const owners = objs.filter((o) => o && (o.userData.interior?.length || o.userData.seats?.length)); if (!owners.length) return stats;
  const allMeshes = [], crewOf = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.isDisc || !o.geometry?.attributes.position || !shown(o, root)) return; // (a prop disc: no say in the bake, and only shown in flight, so the hangar's bake and the flight's match)
    allMeshes.push(o); for (let x = o; x && x !== root; x = x.parent) if (x.userData.crewRig) { crewOf.set(o, x); break; }
  });
  const key = globalThis.__cabinKeep ? null : sigOf(allMeshes, owners, crewOf, rootInv), hit = key && SAVED.get(key);
  if (hit) { // (built before: its saved values)
    for (const s of hit.meshes) { const m = allMeshes[s.i]; if (m && m.geometry.attributes.position.count * 4 === s.L.length) applyCabin(m, s.L, s.S, s.Lm); }
    hit.t = Date.now(); if (db) keepBake(key, hit);
    return { ...hit.stats, saved: true, ms: Math.round(performance.now() - t0) };
  }
  const saved = [];
  const boxOf = new Map(), rootBox = (m) => { let b = boxOf.get(m); if (!b) { m.geometry.computeBoundingBox(); b = m.geometry.boundingBox.clone().applyMatrix4(_m.multiplyMatrices(rootInv, m.matrixWorld)); boxOf.set(m, b); } return b; };
  const verts = new Map(), vertsOf = (m) => { let v = verts.get(m); if (!v) { v = meshVerts(m, rootInv); verts.set(m, v); } return v; };
  // occluders: the vehicle's opaque meshes, not its crew (they are lit as a whole, below); glass: what light passes
  const solid = allMeshes.filter((m) => !crewOf.has(m) && OPAQUE(m.material, m)), clear = allMeshes.filter((m) => !crewOf.has(m) && !OPAQUE(m.material, m) && m.material.visible !== false && !m.userData.isDisc && m.material.blending !== THREE.AdditiveBlending);
  const VB = new THREE.Box3(); for (const m of solid) VB.union(rootBox(m)); VB.expandByScalar(0.05);
  const results = new Map(); // mesh -> per-vertex values
  stats.tPre = Math.round(performance.now() - t0);
  for (const owner of owners) {
    const tI = performance.now();
    let I = null; try { I = interiorOf(owner); } catch (e) { console.warn('cabinLight interior', e); }
    let ib = I && interiorBox(I), open = false;
    if (!ib) { ib = seatBox(owner); if (!ib) continue; open = true; } // (an open boat's cockpit: lit as it is, only less so)
    stats.tI = (stats.tI || 0) + Math.round(performance.now() - tI);
    const partToRoot = new THREE.Matrix4().multiplyMatrices(rootInv, owner.matrixWorld);
    const sc = owner.getWorldScale(new THREE.Vector3()), near = NEAR * Math.max(0.5, (sc.x + sc.y + sc.z) / 3);
    const ibRoot = ib.clone().applyMatrix4(partToRoot), region = ibRoot.clone().expandByScalar(REACH).intersect(VB);
    if (region.isEmpty()) continue;
    const rs = region.getSize(new THREE.Vector3()), h = Math.max(MIN_H, Math.cbrt((rs.x * rs.y * rs.z) / MAX_VOX));
    let t1 = performance.now();
    // 1. voxels: the interior's surroundings finely; the vehicle further out coarsely, so rays that leave the
    // surroundings (aft down a fuselage) are still stopped
    const G = grid(region, h, true), glass = buf('glass', Uint8Array, G.occ.length), gG = { ...G, occ: glass, e: null };
    for (const m of solid) if (rootBox(m).intersectsBox(region)) { const em = emission(m.material); voxelise(G, vertsOf(m).pos, m.geometry.index?.array, em, em?.map ? m.geometry.attributes.uv : null); }
    stats.tFine = Math.round(performance.now() - t1);
    for (const m of clear) if (rootBox(m).intersectsBox(region)) voxelise(gG, vertsOf(m).pos, m.geometry.index?.array, null, null);
    const cbox = region.clone().expandByScalar(FAR).intersect(VB), cs = cbox.getSize(new THREE.Vector3()), C = grid(cbox, Math.max(0.15, Math.cbrt((cs.x * cs.y * cs.z) / 6e5)), false, 'c');
    const tc = performance.now();
    for (const m of solid) if (!m.userData.near && rootBox(m).intersectsBox(cbox)) voxelise(C, vertsOf(m).pos, m.geometry.index?.array, null, null);
    stats.tCoarse = Math.round(performance.now() - tc); const tf = performance.now();
    // 2. the cabin's air: the empty voxels joined to the crew's places, not through glass (flooded out from the seats).
    // It fills the region unless it leaks out of it (an open cockpit: its air is the sky), then only near the interior.
    // And the air outside, flooded in from the region's faces: a surface facing that is the outside, whatever is near.
    let air;
    if (open) { air = buf('air', Uint8Array, G.occ.length); const B = ibRoot.clone().expandByScalar(near); for (let Z = 0; Z < G.nz; Z++) for (let Y = 0; Y < G.ny; Y++) for (let X = 0; X < G.nx; X++) { const id = X + G.nx * (Y + G.ny * Z); if (!G.occ[id] && !glass[id] && B.containsPoint(_v.set(G.o.x + (X + 0.5) * h, G.o.y + (Y + 0.5) * h, G.o.z + (Z + 0.5) * h))) air[id] = 1; } air.leak = true; }
    else { const seeds = seedsOf(owner, partToRoot, ibRoot, G); air = flood(G, glass, region, seeds); if (air.leak) air = flood(G, glass, ibRoot.clone().expandByScalar(near), seeds); }
    let outside = null;
    if (!air.leak) { const sd = []; for (let Z = 0; Z < G.nz; Z++) for (let Y = 0; Y < G.ny; Y++) for (let X = 0; X < G.nx; X += (Y === 0 || Y === G.ny - 1 || Z === 0 || Z === G.nz - 1) ? 1 : G.nx - 1) { const id = X + G.nx * (Y + G.ny * Z); if (!G.occ[id] && !glass[id]) sd.push(id); } outside = flood(G, glass, region, sd, 'out'); }
    stats.tFlood = Math.round(performance.now() - tf);
    if (globalThis.__cabinKeep) globalThis.__cabinDbg = { G, C, glass, air }; // (tools: the grids, for slices)
    stats.tVox += performance.now() - t1; t1 = performance.now();
    // 3. the interior's surface points: per vertex and face side, deduplicated per 3-voxel cell and normal direction
    const ibNear = ibRoot.clone().expandByScalar(near + 0.05), cells = new Map(), sp = [], recv = [], crewMeshes = [], ic = 1 / (2 * h);
    for (const m of allMeshes) {
      if (!LIT(m.material) || !rootBox(m).intersectsBox(ibNear)) continue;
      if (crewOf.has(m)) { if (isUnder(crewOf.get(m), owner) && m.isSkinnedMesh) crewMeshes.push(m); continue; }
      const side = m.material.side, sides = side === THREE.DoubleSide ? [1, -1] : side === THREE.BackSide ? [-1] : [1];
      // (sid per vertex and side: a sample, or -1 not the cabin's, -2 faces the outside, -3 out of reach)
      const { pos, nrm, n } = vertsOf(m), sid = new Int32Array(n * 2).fill(-3); let any = false;
      const keyOf = (i, sg) => { const X = (pos[i * 3] - G.o.x) / h, Y = (pos[i * 3 + 1] - G.o.y) / h, Z = (pos[i * 3 + 2] - G.o.z) / h, mx = nrm[i * 3] * sg, my = nrm[i * 3 + 1] * sg, mz = nrm[i * 3 + 2] * sg;
        return [((Math.floor(X * CELL) * 2048 + Math.floor(Y * CELL)) * 2048 + Math.floor(Z * CELL)) * 128 + (Math.round(mx * 2) + 2) * 25 + (Math.round(my * 2) + 2) * 5 + (Math.round(mz * 2) + 2), X, Y, Z, mx, my, mz]; };
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < ibNear.min.x || y < ibNear.min.y || z < ibNear.min.z || x > ibNear.max.x || y > ibNear.max.y || z > ibNear.max.z) continue;
        for (const sg of sides) {
          const [key, X, Y, Z, mx, my, mz] = keyOf(i, sg);
          let s = cells.get(key);
          if (s === undefined) {
            s = outside && facesAir(G, outside, X, Y, Z, mx, my, mz, true) ? -2 : facesAir(G, air, X, Y, Z, mx, my, mz) || nearAir(G, air, X, Y, Z, 4) ? sp.length / 6 : -1;
            if (s >= 0) sp.push(X, Y, Z, mx, my, mz);
            cells.set(key, s);
          }
          sid[i * 2 + (sg < 0 ? 1 : 0)] = s; if (s >= 0) any = true;
        }
      }
      // a vertex in doubt that shares a triangle with the cabin's is the cabin's too (a big panel's corner tucked into
      // the skin would otherwise light the whole triangle as if it were outside)
      if (any) {
        const ix = m.geometry.index?.array, nt = (ix ? ix.length : n) / 3, s0 = sid.slice(); // (from the first pass only: no chains)
        for (let t = 0; t < nt; t++) for (let k = 0; k < 2; k++) {
          const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
          if (s0[a * 2 + k] < 0 && s0[b * 2 + k] < 0 && s0[c * 2 + k] < 0) continue;
          for (const v of [a, b, c]) if (sid[v * 2 + k] === -1) {
            const [key, X, Y, Z, mx, my, mz] = keyOf(v, k ? -1 : 1), fk = -1 - key; let s = cells.get(fk);
            if (s === undefined) { s = sp.length / 6; sp.push(X, Y, Z, mx, my, mz); cells.set(fk, s); }
            sid[v * 2 + k] = s;
          }
        }
        recv.push({ m, sid, sides });
      }
    }
    stats.tRecv += performance.now() - t1; t1 = performance.now();
    const NS = sp.length / 6;
    // 4. march: through the fine grid, then on through the coarse one
    const hk = h / C.h, cox = (G.o.x - C.o.x) / C.h, coy = (G.o.y - C.o.y) / C.h, coz = (G.o.z - C.o.z) / C.h;
    const ray = (ox, oy, oz, dx, dy, dz, skip) => { // 1 open, 0 closed, or -(1 + voxel) for a hit in the fine grid (its glow)
      const hit = march(G, ox, oy, oz, dx, dy, dz, skip); if (hit >= 0) return -1 - hit;
      const t = -1 - hit + 1 / hk;
      return march(C, (ox + dx * t) * hk + cox, (oy + dy * t) * hk + coy, (oz + dz * t) * hk + coz, dx, dy, dz) < 0 ? 1 : 0;
    };
    const glowOf = (r) => (r < -0.5 ? G.e[-1 - r] / G.occ[-1 - r] : 0);
    const vis = new Float32Array(NS), glow = new Float32Array(NS), fit = new Float32Array(NS * 4);
    for (let s = 0; s < NS; s++) {
      const mx = sp[s * 6 + 3], my = sp[s * 6 + 4], mz = sp[s * 6 + 5], ox = sp[s * 6] + mx * 0.8, oy = sp[s * 6 + 1] + my * 0.8, oz = sp[s * 6 + 2] + mz * 0.8; // (just off the surface, and its own voxels round there skipped)
      let wsum = 0, wv = 0, wg = 0, front = 0, va = 0, vbx = 0, vby = 0, vbz = 0, bsx = 0, bsy = 0, bsz = 0;
      for (let k = 0; k < K; k++) {
        const dx = DIRS[k * 3], dy = DIRS[k * 3 + 1], dz = DIRS[k * 3 + 2], c = dx * mx + dy * my + dz * mz;
        if (c <= 0.05) { bsx += dx; bsy += dy; bsz += dz; continue; }
        const r = ray(ox, oy, oz, dx, dy, dz, 1.2);
        wsum += c; front++;
        if (r > 0) { wv += c; va++; vbx += dx; vby += dy; vbz += dz; } else wg += c * glowOf(r);
      }
      vis[s] = wsum ? wv / wsum : 1; glow[s] = wsum ? (wg / wsum) * GLOW_K : 0;
      // which directions are open, as a + b.d over the whole sphere (the back half taken as the front's mean)
      const mean = front ? va / front : 1;
      fit[s * 4] = mean; fit[s * 4 + 1] = (3 / K) * (vbx + mean * bsx); fit[s * 4 + 2] = (3 / K) * (vby + mean * bsy); fit[s * 4 + 3] = (3 / K) * (vbz + mean * bsz);
    }
    // the deck's own lamps (lit at night): their irradiance at each sample, shadowed through the fine voxels, and a share of
    // their mean everywhere for the light they bounce round the deck
    const lamps = (owner.userData.cabinLamps || []).map((l) => { const p = new THREE.Vector3(...l.p).applyMatrix4(partToRoot), d = l.d ? new THREE.Vector3(...l.d).transformDirection(partToRoot) : null;
      return { x: (p.x - G.o.x) / h, y: (p.y - G.o.y) / h, z: (p.z - G.o.z) / h, d, c0: l.cone ? l.cone[0] : -2, c1: l.cone ? l.cone[1] : -1, k: l.k, r2: (l.r ?? 0.2) ** 2 }; }); // (r: the fitting's size, softening 1/d^2 close to it)
    const seen = (ax, ay, az, L) => { // a clear line from a point to a lamp (voxel units; the ends' own voxels skipped)
      const dx = L.x - ax, dy = L.y - ay, dz = L.z - az, st = Math.ceil(Math.hypot(dx, dy, dz) * 2);
      for (let i = 3; i < st - 3; i++) { const t = i / st, X = Math.floor(ax + dx * t), Y = Math.floor(ay + dy * t), Z = Math.floor(az + dz * t); if (X < 0 || Y < 0 || Z < 0 || X >= G.nx || Y >= G.ny || Z >= G.nz) continue; if (G.occ[X + G.nx * (Y + G.ny * Z)]) return false; }
      return true; };
    const lampDirs = (x, y, z) => { const out = []; for (const L of lamps) { // [direction to the lamp, irradiance face-on] per lamp that reaches (x, y, z)
      const dx = L.x - x, dy = L.y - y, dz = L.z - z, dv = Math.hypot(dx, dy, dz) || 1, lx = dx / dv, ly = dy / dv, lz = dz / dv;
      const f = L.d ? smoothstep(L.c0, L.c1, -(lx * L.d.x + ly * L.d.y + lz * L.d.z)) : 1; if (f <= 0 || !seen(x, y, z, L)) continue;
      const dm = dv * h; out.push(lx, ly, lz, (L.k * f) / (dm * dm + L.r2)); } return out; };
    const lampE = lamps.length ? new Float32Array(NS) : null; let lampFill = 0;
    if (lampE) {
      for (let s = 0; s < NS; s++) { const mx = sp[s * 6 + 3], my = sp[s * 6 + 4], mz = sp[s * 6 + 5], ld = lampDirs(sp[s * 6] + mx * 0.8, sp[s * 6 + 1] + my * 0.8, sp[s * 6 + 2] + mz * 0.8); let E = 0;
        for (let j = 0; j < ld.length; j += 4) E += Math.max(0, ld[j] * mx + ld[j + 1] * my + ld[j + 2] * mz) * ld[j + 3]; lampE[s] = E; lampFill += E; }
      lampFill = NS ? (LAMP_FILL * lampFill) / NS : 0; for (let s = 0; s < NS; s++) lampE[s] += lampFill;
    }
    // the crew: a probe at each bone (where it is now), all round; each vertex takes its bones' probes, seen along its normal
    const probes = new Map(), bp = new THREE.Vector3();
    const probe = (bone) => {
      let pr = probes.get(bone); if (pr) return pr;
      bone.getWorldPosition(bp).applyMatrix4(rootInv);
      let X = (bp.x - G.o.x) / h, Y = (bp.y - G.o.y) / h, Z = (bp.z - G.o.z) / h;
      { const id = Math.floor(X) + G.nx * (Math.floor(Y) + G.ny * Math.floor(Z)); if (G.occ[id]) for (let r = 1; r < 5; r++) if (!G.occ[id + r * G.nx]) { Y += r; break; } } // (a hip in the cushion: from just over it)
      let va = 0, bx = 0, by = 0, bz = 0, g = 0;
      for (let k = 0; k < K; k++) { const dx = DIRS[k * 3], dy = DIRS[k * 3 + 1], dz = DIRS[k * 3 + 2], r = ray(X, Y, Z, dx, dy, dz, 0); if (r > 0) { va++; bx += dx; by += dy; bz += dz; } else g += glowOf(r); }
      pr = [va / K, (3 / K) * bx, (3 / K) * by, (3 / K) * bz, (g / K) * GLOW_K]; probes.set(bone, pr); return pr;
    };
    for (const m of crewMeshes) {
      const g = m.geometry, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, N = g.attributes.normal, n = g.attributes.position.count, bones = m.skeleton.bones;
      if (!SI || !SW || !N || SI.isInterleavedBufferAttribute || SW.isInterleavedBufferAttribute) continue;
      const sia = SI.array, swa = SW.array, swk = SW.normalized ? 1 / 255 : 1; // (weights may be stored as bytes)
      const prs = bones.map((b) => probe(b)), nm = new THREE.Matrix3().getNormalMatrix(_m.multiplyMatrices(rootInv, m.matrixWorld));
      const r = { L: new Float32Array(n * 4), sun: new Float32Array(n * 4), sides: [1], lamp: lampE ? new Float32Array(n * 2) : null }, nv = new THREE.Vector3();
      const bl = lampE ? bones.map((b) => { b.getWorldPosition(bp).applyMatrix4(rootInv); return lampDirs((bp.x - G.o.x) / h, (bp.y - G.o.y) / h, (bp.z - G.o.z) / h); }) : null; // (each bone's lamps)
      for (let i = 0; i < n; i++) {
        let a = 0, x = 0, y = 0, z = 0, gl = 0;
        for (let j = 0; j < 4; j++) { const wgt = swa[i * 4 + j] * swk; if (!wgt) continue; const p = prs[sia[i * 4 + j]]; if (!p) continue; a += wgt * p[0]; x += wgt * p[1]; y += wgt * p[2]; z += wgt * p[3]; gl += wgt * p[4]; }
        nv.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); // (the rest pose's normal: near enough for light this soft)
        const v = Math.min(1, Math.max(0, a + (2 / 3) * (x * nv.x + y * nv.y + z * nv.z))); // (V(d) = a + b.d, averaged over the normal's hemisphere)
        r.L[i * 4] = r.L[i * 4 + 2] = v; r.L[i * 4 + 1] = r.L[i * 4 + 3] = gl;
        if (bl) { let E = lampFill; for (let j = 0; j < 4; j++) { const wgt = swa[i * 4 + j] * swk; if (!wgt) continue; const ld = bl[sia[i * 4 + j]]; if (!ld) continue; for (let q = 0; q < ld.length; q += 4) E += wgt * Math.max(0, ld[q] * nv.x + ld[q + 1] * nv.y + ld[q + 2] * nv.z) * ld[q + 3]; } r.lamp[i * 2] = r.lamp[i * 2 + 1] = E; }
        r.sun[i * 4] = a; r.sun[i * 4 + 1] = x; r.sun[i * 4 + 2] = y; r.sun[i * 4 + 3] = z;
      }
      results.set(m, r);
    }
    stats.tMarch += performance.now() - t1;
    if (globalThis.__cabinKeep) Object.assign(globalThis.__cabinDbg, { sp, vis: vis.slice() });
    // a little light back off the interior's own surfaces, in proportion to how open it is
    let avg = 0; for (let s = 0; s < NS; s++) avg += vis[s]; avg = NS ? avg / NS : 0;
    const bounce = Math.min(0.3, BOUNCE_MIN * (owner.userData.cabinDeep && !open ? DEEP : 1) + BOUNCE * avg), lift = open ? (v) => 1 - OPEN_K * (1 - v) * (1 - bounce) : (v) => v + (1 - v) * bounce;
    for (let s = 0; s < NS; s++) vis[s] = lift(vis[s]);
    for (const m of crewMeshes) { const r = results.get(m); if (r) for (let i = 0; i < r.L.length; i += 2) r.L[i] = lift(r.L[i]); }
    // per vertex, merged over interiors (the darker, the brighter glow)
    for (const { m, sid, sides } of recv) {
      const n = sid.length / 2; let r = results.get(m);
      if (!r) { r = { L: new Float32Array(n * 4), sun: new Float32Array(n * 4), sides }; for (let i = 0; i < n; i++) { r.L[i * 4] = 1; r.L[i * 4 + 2] = 1; r.sun[i * 4] = 1; } results.set(m, r); }
      if (lampE && !r.lamp) r.lamp = new Float32Array(n * 2);
      const main = sides[0] < 0 ? 1 : 0;
      for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) {
        const s = sid[i * 2 + k]; if (s < 0) continue;
        r.L[i * 4 + k * 2] = Math.min(r.L[i * 4 + k * 2], vis[s]); r.L[i * 4 + k * 2 + 1] = Math.max(r.L[i * 4 + k * 2 + 1], glow[s]);
        if (lampE) r.lamp[i * 2 + k] = Math.max(r.lamp[i * 2 + k], lampE[s]);
        if (k === main) for (let j = 0; j < 4; j++) r.sun[i * 4 + j] = fit[s * 4 + j];
      }
    }
    stats.interiors++; stats.samples += NS; stats.probes += probes.size; stats.h = +h.toFixed(3); stats.avg = +avg.toFixed(3); stats.open = (stats.open || 0) + (air.leak ? 1 : 0); stats.seatsOnly = (stats.seatsOnly || 0) + (open ? 1 : 0);
  }
  // 5. attributes and material variants
  const tA = performance.now();
  const dirM = new THREE.Matrix4(), q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));
  for (const [m, r] of results) {
    const mat = cabinMaterial(m.material, !!r.lamp); if (!mat) continue;
    const n = r.L.length / 4, L = new Uint16Array(n * 4), S = new Int8Array(n * 4), only = r.sides.length === 1 ? (r.sides[0] < 0 ? 1 : 0) : -1;
    dirM.multiplyMatrices(rootInv, m.matrixWorld).invert(); // root -> the mesh's own frame (the shader turns the sun into it with modelMatrix)
    const e = dirM.elements, RL = r.L, RS = r.sun;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 2; k++) { const kk = only >= 0 ? only : k, v = RL[i * 4 + kk * 2], gl = RL[i * 4 + kk * 2 + 1] * 0.25; L[i * 4 + k * 2] = (v >= 1 ? 1 : v) * 65535 + 0.5; L[i * 4 + k * 2 + 1] = (gl >= 1 ? 1 : gl) * 65535 + 0.5; }
      const bx = RS[i * 4 + 1], by = RS[i * 4 + 2], bz = RS[i * 4 + 3]; // (into the mesh's frame: rotation only, its length kept)
      let x = e[0] * bx + e[4] * by + e[8] * bz, y = e[1] * bx + e[5] * by + e[9] * bz, z = e[2] * bx + e[6] * by + e[10] * bz; const l0 = Math.hypot(bx, by, bz), l1 = Math.hypot(x, y, z) || 1; x *= l0 / l1; y *= l0 / l1; z *= l0 / l1;
      S[i * 4] = q(RS[i * 4]); S[i * 4 + 1] = q(x / 2); S[i * 4 + 2] = q(y / 2); S[i * 4 + 3] = q(z / 2);
    }
    let Lm = null; if (r.lamp) { Lm = new Uint16Array(n * 2); for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) { const v = r.lamp[i * 2 + (only >= 0 ? only : k)] / LAMP_MAX; Lm[i * 2 + k] = (v >= 1 ? 1 : v) * 65535 + 0.5; }  }
    applyCabin(m, L, S, Lm, mat); saved.push({ i: allMeshes.indexOf(m), L, S, Lm });
    stats.verts += n;
  }
  stats.tAttr = Math.round(performance.now() - tA);
  for (const k of ['tVox', 'tRecv', 'tMarch']) stats[k] = Math.round(stats[k]);
  stats.ms = Math.round(performance.now() - t0);
  if (key) keepBake(key, { t: Date.now(), meshes: saved, stats: { ...stats } });
  return stats;
}
