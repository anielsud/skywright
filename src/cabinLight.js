// Cabin lighting: inside a cockpit, cab or wheelhouse light only gets in through the glass and the openings, so the
// deck sits in shade and what you see are the windows, the displays and the backlit legends. Every lit material
// otherwise takes the whole sky's ambient and reflections (the hemisphere light, the environment map) at full
// strength wherever it is, which is what made a closed flight deck read as evenly lit, like a sim.
//
// Once per build (bakeCabinLight, after the vehicle is assembled and merged), for each crewed part's interior
// (interior.js: its declared userData.interior, or the space its seats' obstacles keep the crew in, so a kid's own
// designs get it too):
//   - the vehicle's opaque geometry around the interior is voxelised (glass and other see-through materials are left
//     out: light passes them); emissive surfaces (displays, backlit panels) keep their radiance in their voxels
//   - from every interior surface point (the cockpit's own furniture and walls, anything else facing into it, the crew)
//     a fixed set of rays over the hemisphere round its normal is marched through the voxels: the cosine-weighted share
//     that gets out is its sky visibility, what they hit that glows is the light the displays throw on it, and a
//     linear fit of which directions are open is kept for the sun (see below)
//   - those go on the mesh as vertex attributes (cabinLight: visibility with a little bounce, glow; cabinSun: the fit)
//     and the mesh gets a variant of its material that multiplies the ambient and reflected sky light by the
//     visibility and adds the glow. Direct sun is left to the shadow maps (glass casts none, so it falls through the
//     windows onto the deck); with shadows off (Low, or shed under load) the fit stands in for them.
// Outside surfaces never take part (a vertex is interior only if it is in the interior or faces into it from close
// by), so exteriors look exactly as before. Emissive light is never touched: displays stay as bright as they were.
// Exposure stays the world's (the renderer's is fixed): the view out is bright and the deck dark, like the photos.
// Runtime cost: two attributes read in the vertex shader and a few multiplies per pixel on the interior meshes, no extra
// draw calls (one material variant per material, shared by every vehicle).
import * as THREE from 'three';
import { interiorOf } from './interior.js';

const MAX_VOX = 1.2e6; // voxels per interior (the voxel size grows to fit: ~4 cm for an airliner's deck, ~2.5 cm for a bubble)
const MIN_H = 0.02;
const REACH = 1.0; // metres round the interior the occluders are gathered from (rays that get further out are free)
const NEAR = 0.3; // a surface this close outside the interior, facing into it, is part of it (the panel in front of the crew)
const BOUNCE = 0.3; // light coming back off the interior's own surfaces, in proportion to how open the interior is
const GLOW_K = 1.0; // display light scale (radiance -> the factor the shader adds)

// ---------- the shader side ----------
export const CABIN = {
  uCabinSunDir: { value: new THREE.Vector3(0, 1, 0) }, // towards the sun (or the moon by night), world space
  uCabinSunBake: { value: 0 }, // 1: no shadow maps, the baked sun visibility gates direct light
  uCabinDebug: { value: 0 }, // (tools: 1 shows the sky visibility, 2 the display glow, 3 the baked sun)
};
// called by the flight each frame (and by the hangar): the light's direction and whether shadow maps are on
export function cabinSun(dir, shadows) { CABIN.uCabinSunDir.value.copy(dir); CABIN.uCabinSunBake.value = shadows ? 0 : 1; }

const VERT_PARS = /* glsl */`
attribute vec2 cabinLight; attribute vec4 cabinSun; varying vec3 vCabin; uniform vec3 uCabinSunDir;`;
const VERT = /* glsl */`
vCabin.xy = cabinLight;
{ vec3 sd = normalize((vec4(uCabinSunDir, 0.0) * modelMatrix).xyz); vCabin.z = clamp(cabinSun.x + 2.0 * dot(cabinSun.yzw, sd), 0.0, 1.0); }`;
const FRAG_PARS = /* glsl */`
varying vec3 vCabin; uniform float uCabinSunBake; uniform float uCabinDebug;`;
const FRAG = /* glsl */`
{ float ca = vCabin.x;
  reflectedLight.indirectDiffuse *= ca; reflectedLight.indirectSpecular *= ca;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ca;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ca;
  #endif
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vCabin.y * vec3(0.85, 0.95, 1.0);
  if (uCabinSunBake > 0.5) { float s = smoothstep(0.15, 0.6, vCabin.z); reflectedLight.directDiffuse *= s; reflectedLight.directSpecular *= s; }
  if (uCabinDebug > 0.5) { reflectedLight.directDiffuse = reflectedLight.directSpecular = reflectedLight.indirectSpecular = vec3(0.0); reflectedLight.indirectDiffuse = vec3(uCabinDebug < 1.5 ? vCabin.x : uCabinDebug < 2.5 ? vCabin.y * 4.0 : vCabin.z); } }`;

const LIT = (m) => m && !Array.isArray(m) && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial) && !m.transparent && !(m.transmission > 0);
const VARIANTS = new WeakMap();
// the cabin-lit variant of a material (one per material, shared by every vehicle; its own hook and key kept)
export function cabinMaterial(base) {
  if (base.userData?.cabinBase) return base;
  let v = VARIANTS.get(base); if (v) return v;
  try { v = base.clone(); } catch { return null; }
  const bob = base.onBeforeCompile, bkey = base.customProgramCacheKey();
  v.onBeforeCompile = (sh, r) => {
    bob.call(base, sh, r);
    Object.assign(sh.uniforms, CABIN);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VERT_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_PARS).replace('#include <aomap_fragment>', '#include <aomap_fragment>' + FRAG);
  };
  v.customProgramCacheKey = () => 'cabin1|' + bkey;
  v.userData.cabinBase = base;
  VARIANTS.set(base, v);
  return v;
}

// ---------- directions ----------
const K = 96, DIRS = new Float32Array(K * 3);
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
function emission(m) {
  if (!m || Array.isArray(m)) return null;
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (m.isMeshBasicMaterial) { const k = lum(m.color); return k > 0.05 ? { k, map: m.map ? texSampler(m.map) : null } : null; } // (unlit: it is its own light)
  if (!m.emissive) return null;
  const k = lum(m.emissive) * (m.emissiveIntensity ?? 1); if (k < 0.01) return null;
  return { k, map: m.emissiveMap ? texSampler(m.emissiveMap) : null };
}

// ---------- the bake ----------
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4(), _nm = new THREE.Matrix3();
const shown = (o, root) => { for (let x = o; x && x !== root; x = x.parent) if (!x.visible && !x.userData.near && !x.userData.crewRig) return false; return true; };

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

// Bake every crewed part of a vehicle. objs: its part objects (as assemble() takes them), root: their common parent.
// Returns { ms, interiors, verts, samples } (or null when nothing is enclosed).
export function bakeCabinLight(objs, root) {
  if (globalThis.__noCabinLight) return null;
  const t0 = performance.now();
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert(), stats = { interiors: 0, verts: 0, samples: 0, voxels: 0 };
  const allMeshes = []; root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes.position && shown(o, root)) allMeshes.push(o); });
  const boxOf = new Map(); const rootBox = (m) => { let b = boxOf.get(m); if (!b) { m.geometry.computeBoundingBox(); b = m.geometry.boundingBox.clone().applyMatrix4(_m.multiplyMatrices(rootInv, m.matrixWorld)); boxOf.set(m, b); } return b; };
  const verts = new Map(); const vertsOf = (m) => { let v = verts.get(m); if (!v) { v = meshVerts(m, rootInv); verts.set(m, v); } return v; };
  const results = new Map(); // mesh -> { amb, glow, sun } per vertex (Float32Arrays), merged over interiors
  for (const owner of objs) {
    if (!owner || !(owner.userData.interior?.length || owner.userData.seats?.length)) continue;
    let I; try { I = interiorOf(owner); } catch (e) { console.warn('cabinLight interior', e); continue; } if (!I) continue;
    const ib = interiorBox(I); if (!ib) continue;
    const partToRoot = new THREE.Matrix4().multiplyMatrices(rootInv, owner.matrixWorld), rootToPart = partToRoot.clone().invert();
    const ibRoot = ib.clone().applyMatrix4(partToRoot), sc = owner.getWorldScale(new THREE.Vector3()), near = NEAR * Math.max(0.5, (sc.x + sc.y + sc.z) / 3);
    const region = ibRoot.clone().expandByScalar(REACH);
    { const vb = new THREE.Box3(); for (const m of allMeshes) vb.union(rootBox(m)); region.intersect(vb.expandByScalar(0.05)); }
    const rs = region.getSize(new THREE.Vector3()), h = Math.max(MIN_H, Math.cbrt((rs.x * rs.y * rs.z) / MAX_VOX));
    const nx = Math.ceil(rs.x / h) + 1, ny = Math.ceil(rs.y / h) + 1, nz = Math.ceil(rs.z / h) + 1, NV = nx * ny * nz, o0 = region.min;
    const occ = new Uint8Array(NV), eSum = new Float32Array(NV); // (eSum: emitted radiance summed over a voxel's samples; occ counts them, to 255)
    const t1 = performance.now();
    // 1. voxelise the opaque geometry in the region
    for (const m of allMeshes) {
      if (!rootBox(m).intersectsBox(region)) continue;
      const mat = m.material; if (Array.isArray(mat) || mat.transparent || mat.transmission > 0 || mat.visible === false || mat.colorWrite === false || m.userData.isDisc) continue;
      const em = emission(mat), { pos, nrm } = vertsOf(m), ix = m.geometry.index?.array, nt = (ix ? ix.length : pos.length / 3) / 3, uv = em?.map ? m.geometry.attributes.uv : null;
      for (let t = 0; t < nt; t++) {
        const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
        const ax = (pos[a * 3] - o0.x) / h, ay = (pos[a * 3 + 1] - o0.y) / h, az = (pos[a * 3 + 2] - o0.z) / h;
        const bx = (pos[b * 3] - o0.x) / h, by = (pos[b * 3 + 1] - o0.y) / h, bz = (pos[b * 3 + 2] - o0.z) / h;
        const cx = (pos[c * 3] - o0.x) / h, cy = (pos[c * 3 + 1] - o0.y) / h, cz = (pos[c * 3 + 2] - o0.z) / h;
        if (Math.max(ax, bx, cx) < 0 || Math.max(ay, by, cy) < 0 || Math.max(az, bz, cz) < 0 || Math.min(ax, bx, cx) >= nx || Math.min(ay, by, cy) >= ny || Math.min(az, bz, cz) >= nz) continue;
        // the face normal, for a thin thickening across the surface (so rays can't slip between voxels)
        let ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; const fl = Math.hypot(fx, fy, fz) || 1; fx = (fx / fl) * 0.35; fy = (fy / fl) * 0.35; fz = (fz / fl) * 0.35;
        const L = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(cx - bx, cy - by, cz - bz)), S = Math.max(1, Math.ceil(L * 2));
        for (let i = 0; i <= S; i++) for (let j = 0; i + j <= S; j++) {
          const s = i / S, r = j / S, px = ax + ux * s + vx * r, py = ay + uy * s + vy * r, pz = az + uz * s + vz * r;
          let e = 0;
          if (em) { e = em.k; if (em.map && uv) { const q = 1 - s - r; e *= em.map(uv.getX(a) * q + uv.getX(b) * s + uv.getX(c) * r, uv.getY(a) * q + uv.getY(b) * s + uv.getY(c) * r); } }
          for (let k = -1; k <= 1; k++) {
            const X = Math.floor(px + fx * k), Y = Math.floor(py + fy * k), Z = Math.floor(pz + fz * k);
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
            const id = X + nx * (Y + ny * Z); if (occ[id] < 255) occ[id]++; if (e) eSum[id] += e;
          }
        }
      }
    }
    stats.tVox = (stats.tVox || 0) + performance.now() - t1; const t2 = performance.now();
    // 2. the interior's surface points (deduplicated per voxel and normal direction)
    const recv = [], keys = new Map(), sp = []; // sp: sample origin (voxel units) and normal, flat
    const pp = new THREE.Vector3(), pn = new THREE.Vector3(), pq = new THREE.Vector3(), nmP = new THREE.Matrix3().getNormalMatrix(rootToPart);
    const ibNear = ibRoot.clone().expandByScalar(near + 0.05);
    for (const m of allMeshes) {
      if (!LIT(m.material) || !rootBox(m).intersectsBox(ibNear)) continue;
      const crew = (() => { for (let x = m; x && x !== root; x = x.parent) if (x.userData.crewRig) return isUnder(x, owner); return false; })();
      const { pos, nrm, n } = vertsOf(m), w = new Float32Array(n), sid = new Int32Array(n).fill(-1); let any = false;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < ibNear.min.x || y < ibNear.min.y || z < ibNear.min.z || x > ibNear.max.x || y > ibNear.max.y || z > ibNear.max.z) continue;
        let wi;
        if (crew) wi = 1;
        else {
          pp.set(x, y, z).applyMatrix4(rootToPart); pn.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]).applyMatrix3(nmP).normalize();
          const d1 = I.f(pq.copy(pp).addScaledVector(pn, 0.04));
          if (d1 > 0) wi = 1;
          else if (d1 > -near) { const d0 = I.f(pq.copy(pp).addScaledVector(pn, -0.04)); wi = d1 > d0 + 0.02 ? 1 - smoothstep(near * 0.5, near, -d1) : 0; } // (facing into the interior from just outside it)
          else wi = 0;
        }
        if (wi <= 0) continue;
        w[i] = wi; any = true;
        const nx_ = nrm[i * 3], ny_ = nrm[i * 3 + 1], nz_ = nrm[i * 3 + 2];
        const X = Math.floor((x - o0.x) / h), Y = Math.floor((y - o0.y) / h), Z = Math.floor((z - o0.z) / h);
        const key = ((X * 4096 + Y) * 4096 + Z) * 128 + (Math.round(nx_ * 2) + 2) * 25 + (Math.round(ny_ * 2) + 2) * 5 + (Math.round(nz_ * 2) + 2);
        let s = keys.get(key);
        if (s == null) { s = sp.length / 6; keys.set(key, s); sp.push((x - o0.x) / h, (y - o0.y) / h, (z - o0.z) / h, nx_, ny_, nz_); }
        sid[i] = s;
      }
      if (any) recv.push({ m, w, sid });
    }
    const NS = sp.length / 6; if (!NS) continue;
    stats.tRecv = (stats.tRecv || 0) + performance.now() - t2; const t3 = performance.now();
    // 3. march the rays
    const vis = new Float32Array(NS), glow = new Float32Array(NS), fit = new Float32Array(NS * 4), maxSteps = nx + ny + nz;
    for (let s = 0; s < NS; s++) {
      const qx = sp[s * 6], qy = sp[s * 6 + 1], qz = sp[s * 6 + 2], mx = sp[s * 6 + 3], my = sp[s * 6 + 4], mz = sp[s * 6 + 5];
      let wsum = 0, wv = 0, wg = 0, front = 0, va = 0, vbx = 0, vby = 0, vbz = 0;
      for (let k = 0; k < K; k++) {
        const dx = DIRS[k * 3], dy = DIRS[k * 3 + 1], dz = DIRS[k * 3 + 2], c = dx * mx + dy * my + dz * mz;
        if (c <= 0.02) continue;
        // from 2 voxels off the surface (its own voxels and their thickening behind)
        let x = qx + mx * 2 + dx * 0.5, y = qy + my * 2 + dy * 0.5, z = qz + mz * 2 + dz * 0.5;
        let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const tdx = Math.abs(1 / (dx || 1e-9)), tdy = Math.abs(1 / (dy || 1e-9)), tdz = Math.abs(1 / (dz || 1e-9));
        let tx = (dx > 0 ? X + 1 - x : x - X) * tdx, ty = (dy > 0 ? Y + 1 - y : y - Y) * tdy, tz = (dz > 0 ? Z + 1 - z : z - Z) * tdz;
        let hit = -1;
        for (let st = 0; st < maxSteps; st++) {
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) break;
          const id = X + nx * (Y + ny * Z); if (occ[id]) { hit = id; break; }
          if (tx < ty) { if (tx < tz) { X += sx; tx += tdx; } else { Z += sz; tz += tdz; } } else if (ty < tz) { Y += sy; ty += tdy; } else { Z += sz; tz += tdz; }
        }
        wsum += c; front++;
        const open = hit < 0 ? 1 : 0;
        if (open) { wv += c; va += 1; vbx += dx; vby += dy; vbz += dz; } else if (eSum[hit]) wg += c * eSum[hit] / occ[hit];
      }
      vis[s] = wsum ? wv / wsum : 1; glow[s] = wsum ? (wg / wsum) * GLOW_K : 0;
      // which directions are open, as a + b.d over the whole sphere (the back half taken as the front's mean)
      const mean = front ? va / front : 1; let bsx = 0, bsy = 0, bsz = 0;
      for (let k = 0; k < K; k++) { const dx = DIRS[k * 3], dy = DIRS[k * 3 + 1], dz = DIRS[k * 3 + 2]; if (dx * mx + dy * my + dz * mz <= 0.02) { bsx += dx; bsy += dy; bsz += dz; } }
      fit[s * 4] = mean; fit[s * 4 + 1] = (3 / K) * (vbx + mean * bsx); fit[s * 4 + 2] = (3 / K) * (vby + mean * bsy); fit[s * 4 + 3] = (3 / K) * (vbz + mean * bsz);
    }
    stats.tMarch = (stats.tMarch || 0) + performance.now() - t3;
    let avg = 0; for (let s = 0; s < NS; s++) avg += vis[s]; avg /= NS;
    { const hst = new Array(10).fill(0); for (let s = 0; s < NS; s++) hst[Math.min(9, Math.floor(vis[s] * 10))]++; stats.hist = hst; stats.avg = avg; }
    for (let s = 0; s < NS; s++) vis[s] += (1 - vis[s]) * BOUNCE * avg;
    // 4. per vertex
    for (const { m, w, sid } of recv) {
      const n = w.length; let r = results.get(m);
      if (!r) { r = { amb: new Float32Array(n).fill(1), glow: new Float32Array(n), sun: new Float32Array(n * 4) }; for (let i = 0; i < n; i++) r.sun[i * 4] = 1; results.set(m, r); }
      for (let i = 0; i < n; i++) {
        const s = sid[i]; if (s < 0) continue; const wi = w[i];
        const a = 1 + (vis[s] - 1) * wi; if (a < r.amb[i]) r.amb[i] = a;
        r.glow[i] = Math.max(r.glow[i], glow[s] * wi);
        // (sun fit: bring it to the full weight's value, blended towards "open" by the weight; root space for now)
        r.sun[i * 4] = 1 + (fit[s * 4] - 1) * wi; r.sun[i * 4 + 1] = fit[s * 4 + 1] * wi; r.sun[i * 4 + 2] = fit[s * 4 + 2] * wi; r.sun[i * 4 + 3] = fit[s * 4 + 3] * wi;
      }
    }
    stats.interiors++; stats.samples += NS; stats.voxels += NV; stats.h = h;
  }
  // 5. attributes and material variants
  const dirM = new THREE.Matrix4(), d = new THREE.Vector3();
  for (const [m, r] of results) {
    const mat = cabinMaterial(m.material); if (!mat) continue;
    const n = r.amb.length, L = new Float32Array(n * 2), S = new Int8Array(n * 4);
    dirM.multiplyMatrices(rootInv, m.matrixWorld).invert(); // root -> the mesh's own frame (the shader turns the sun into it with modelMatrix)
    for (let i = 0; i < n; i++) {
      L[i * 2] = r.amb[i]; L[i * 2 + 1] = r.glow[i];
      d.set(r.sun[i * 4 + 1], r.sun[i * 4 + 2], r.sun[i * 4 + 3]); const dl = d.length(); if (dl > 1e-6) d.transformDirection(dirM).multiplyScalar(dl);
      const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));
      S[i * 4] = q(r.sun[i * 4]); S[i * 4 + 1] = q(d.x / 2); S[i * 4 + 2] = q(d.y / 2); S[i * 4 + 3] = q(d.z / 2);
    }
    const g = m.geometry.clone(); // (crew geometry is shared between figures; part geometry may be too)
    g.setAttribute('cabinLight', new THREE.BufferAttribute(L, 2));
    g.setAttribute('cabinSun', new THREE.BufferAttribute(S, 4, true));
    m.geometry = g; m.material = mat; m.userData.cabinLit = true;
    stats.verts += n;
  }
  stats.ms = performance.now() - t0;
  return stats;
}
function isUnder(o, owner) { for (let x = o; x; x = x.parent) if (x === owner) return true; return false; }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
