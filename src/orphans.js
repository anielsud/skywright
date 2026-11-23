// Pieces left hanging (visual only). interior.js keepOut cuts every part's geometry out of each cockpit's interior,
// another cockpit's too: when a kid sets two cockpits into each other they read as one wide twin cockpit, each cut
// clean along the other's interior. A cut can leave a piece standing free of anything (a strip of a panel whose
// pedestal was inside the other cockpit, a gauge on it): dropOrphans removes, from one part, every piece that no longer
// touches the rest of the vehicle. "Touch" is meshcheck's: a vertex within 1 cm of a triangle, or an edge through one.
// Same pieces as meshcheck counts: crew (skinned), prop discs, decals, glows and anything under userData.floatOk are
// left alone, and so are instanced meshes (each instance is whole).
import * as THREE from 'three';

const TOL = 0.01;
const _t = new THREE.Triangle(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _h = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Vector3(), _qq = new THREE.Vector3();
const _A = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const vtx = (T, i, k, out) => out.set(T[i * 9 + k * 3], T[i * 9 + k * 3 + 1], T[i * 9 + k * 3 + 2]);
function segTri(p0, p1, a, b, c) {
  _e1.subVectors(b, a); _e2.subVectors(c, a); const d = _q.subVectors(p1, p0); _h.crossVectors(d, _e2); const det = _e1.dot(_h);
  if (Math.abs(det) < 1e-12) return false; const f = 1 / det; _s.subVectors(p0, a); const u = f * _s.dot(_h); if (u < 0 || u > 1) return false;
  _qq.crossVectors(_s, _e1); const v = f * d.dot(_qq); if (v < 0 || u + v > 1) return false; const t = f * _e2.dot(_qq); return t >= 0 && t <= 1;
}
function triTouch(T, i, j) {
  const A = [vtx(T, i, 0, _A[0]), vtx(T, i, 1, _A[1]), vtx(T, i, 2, _A[2])], B = [vtx(T, j, 0, _a), vtx(T, j, 1, _b), vtx(T, j, 2, _c)];
  _t.set(B[0], B[1], B[2]); for (const v of A) if (_t.closestPointToPoint(v, _p).distanceToSquared(v) <= TOL * TOL) return true;
  _t.set(A[0], A[1], A[2]); for (const v of B) if (_t.closestPointToPoint(v, _p).distanceToSquared(v) <= TOL * TOL) return true;
  for (let e = 0; e < 3; e++) if (segTri(A[e], A[(e + 1) % 3], B[0], B[1], B[2]) || segTri(B[e], B[(e + 1) % 3], A[0], A[1], A[2])) return true;
  return false;
}
// the meshes meshcheck's floating-parts check looks at
function counted(m) {
  if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || m.userData.decal || !m.geometry?.attributes.position) return false;
  for (let x = m; x; x = x.parent) if (!x.visible || x.userData.floatOk) return false;
  const mt = m.material; return !!mt && !Array.isArray(mt) && mt.blending !== THREE.AdditiveBlending && mt.colorWrite !== false;
}
const triCount = (g) => Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
const corner = (g, t, k) => (g.index ? g.index.getX(t * 3 + k) : t * 3 + k);

// Remove from part `obj` every piece no longer touching the vehicle. objs: all the part objects (world matrices
// current). Returns the number of triangles removed.
export function dropOrphans(obj, objs) {
  const meshes = []; obj.traverse((m) => { if (counted(m)) meshes.push(m); });
  if (!meshes.length) return 0;
  const box = new THREE.Box3(); for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
  box.expandByScalar(TOL * 2);
  // this part's pieces (welded at 0.1 mm), every triangle in world space; owner = piece index. The rest of the vehicle
  // near it is one more owner, `anchor`.
  const T = [], owner = [], pieces = [], meta = []; // meta[piece] = { mesh, tris: [triangle indices in that mesh], inst }
  for (const m of meshes) {
    const g = m.geometry, P = g.attributes.position, nt = triCount(g), wp = new Float32Array(P.count * 3), key = new Map(), id = new Int32Array(P.count);
    const insts = m.isInstancedMesh ? m.count : 1, M4 = new THREE.Matrix4();
    for (let k = 0; k < insts; k++) {
      const W = m.isInstancedMesh ? (m.getMatrixAt(k, M4), M4.clone().premultiply(m.matrixWorld)) : m.matrixWorld;
      key.clear();
      for (let i = 0; i < P.count; i++) { _v.fromBufferAttribute(P, i).applyMatrix4(W); wp[i * 3] = _v.x; wp[i * 3 + 1] = _v.y; wp[i * 3 + 2] = _v.z; const s = `${Math.round(_v.x * 1e4)},${Math.round(_v.y * 1e4)},${Math.round(_v.z * 1e4)}`; let j = key.get(s); if (j === undefined) key.set(s, j = key.size); id[i] = j; }
      const par = new Int32Array(key.size).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
      for (let t = 0; t < nt; t++) { const a = id[corner(g, t, 0)], b = id[corner(g, t, 1)], c = id[corner(g, t, 2)]; par[find(a)] = find(b); par[find(b)] = find(c); }
      const groups = new Map(); for (let t = 0; t < nt; t++) { const r = find(id[corner(g, t, 0)]); let l = groups.get(r); if (!l) groups.set(r, l = []); l.push(t); }
      for (const tris of groups.values()) {
        const pi = pieces.length; pieces.push(pi); meta.push({ mesh: m, tris, inst: m.isInstancedMesh });
        for (const t of tris) { for (let c = 0; c < 3; c++) { const vi = corner(g, t, c); T.push(wp[vi * 3], wp[vi * 3 + 1], wp[vi * 3 + 2]); } owner.push(pi); }
      }
    }
  }
  const anchor = pieces.length;
  for (const o of objs) {
    if (!o || o === obj) continue;
    o.traverse((m) => {
      if (!counted(m)) return; m.geometry.computeBoundingBox(); if (!m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld).intersectsBox(box)) return;
      const g = m.geometry, P = g.attributes.position, nt = triCount(g), insts = m.isInstancedMesh ? m.count : 1, M4 = new THREE.Matrix4();
      for (let k = 0; k < insts; k++) {
        const W = m.isInstancedMesh ? (m.getMatrixAt(k, M4), M4.clone().premultiply(m.matrixWorld)) : m.matrixWorld;
        for (let t = 0; t < nt; t++) {
          _a.fromBufferAttribute(P, corner(g, t, 0)).applyMatrix4(W); _b.fromBufferAttribute(P, corner(g, t, 1)).applyMatrix4(W); _c.fromBufferAttribute(P, corner(g, t, 2)).applyMatrix4(W);
          if (Math.max(_a.x, _b.x, _c.x) < box.min.x || Math.min(_a.x, _b.x, _c.x) > box.max.x || Math.max(_a.y, _b.y, _c.y) < box.min.y || Math.min(_a.y, _b.y, _c.y) > box.max.y || Math.max(_a.z, _b.z, _c.z) < box.min.z || Math.min(_a.z, _b.z, _c.z) > box.max.z) continue;
          T.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z); owner.push(anchor);
        }
      }
    });
  }
  const n = owner.length, TT = new Float32Array(T), lo = new Float32Array(n * 3), hi = new Float32Array(n * 3);
  let edge = 0; for (let t = 0; t < n; t++) for (let a = 0; a < 3; a++) { const v0 = TT[t * 9 + a], v1 = TT[t * 9 + 3 + a], v2 = TT[t * 9 + 6 + a]; lo[t * 3 + a] = Math.min(v0, v1, v2) - TOL; hi[t * 3 + a] = Math.max(v0, v1, v2) + TOL; edge += hi[t * 3 + a] - lo[t * 3 + a]; }
  // a uniform grid of the triangles (bounds grown by TOL), cells about a triangle's size
  const cell = Math.min(0.2, Math.max(0.02, n ? edge / (n * 3) : 0.05)), mn = box.min, dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((box.max.getComponent(a) - mn.getComponent(a)) / cell) + 1));
  const ci = (x, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((x - mn.getComponent(a)) / cell))), key = (x, y, z) => (x * dims[1] + y) * dims[2] + z;
  const span = (t, f) => { const x0 = ci(lo[t * 3], 0), x1 = ci(hi[t * 3], 0), y0 = ci(lo[t * 3 + 1], 1), y1 = ci(hi[t * 3 + 1], 1), z0 = ci(lo[t * 3 + 2], 2), z1 = ci(hi[t * 3 + 2], 2); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) f(key(x, y, z)); };
  const cells = new Map(); for (let t = 0; t < n; t++) span(t, (q) => { let l = cells.get(q); if (!l) cells.set(q, l = []); l.push(t); });
  const par = new Int32Array(anchor + 1).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  // 1. every vertex against the other owners' triangles in its cell
  for (let t = 0; t < n; t++) {
    const pi = owner[t];
    for (let k = 0; k < 3; k++) {
      const x = TT[t * 9 + k * 3], y = TT[t * 9 + k * 3 + 1], z = TT[t * 9 + k * 3 + 2], l = cells.get(key(ci(x, 0), ci(y, 1), ci(z, 2))); if (!l) continue;
      for (const u of l) {
        const pj = owner[u]; if (pj === pi) continue;
        if (x < lo[u * 3] || x > hi[u * 3] || y < lo[u * 3 + 1] || y > hi[u * 3 + 1] || z < lo[u * 3 + 2] || z > hi[u * 3 + 2]) continue;
        const ri = find(pi), rj = find(pj); if (ri === rj) continue;
        _v.set(x, y, z); _t.set(vtx(TT, u, 0, _a), vtx(TT, u, 1, _b), vtx(TT, u, 2, _c));
        if (_t.closestPointToPoint(_v, _p).distanceToSquared(_v) <= TOL * TOL) par[ri] = rj;
      }
    }
  }
  // 2. pieces not joined to the rest of the vehicle yet: the full triangle test (edges through triangles) too
  const first = new Int32Array(anchor + 2).fill(-1); for (let t = n - 1; t >= 0; t--) first[owner[t]] = t; // (each piece's triangles are contiguous)
  const ends = (pi) => { let e = first[pi]; while (e < n && owner[e] === pi) e++; return e; };
  for (let changed = true; changed;) {
    changed = false;
    for (let pi = 0; pi < anchor; pi++) {
      if (find(pi) === find(anchor)) continue;
      let joined = false;
      for (let t = first[pi], e = ends(pi); t < e && !joined; t++) {
        const seen = new Set();
        span(t, (q) => {
          if (joined) return;
          for (const u of cells.get(q) || []) {
            const pj = owner[u]; if (pj === pi || seen.has(u)) continue; seen.add(u); if (find(pj) === find(pi)) continue;
            if (lo[t * 3] > hi[u * 3] || hi[t * 3] < lo[u * 3] || lo[t * 3 + 1] > hi[u * 3 + 1] || hi[t * 3 + 1] < lo[u * 3 + 1] || lo[t * 3 + 2] > hi[u * 3 + 2] || hi[t * 3 + 2] < lo[u * 3 + 2]) continue;
            if (triTouch(TT, t, u)) { par[find(pi)] = find(pj); joined = true; changed = true; return; }
          }
        });
      }
    }
  }
  // what stays: everything joined to the rest of the vehicle (or, if the part touches nothing at all, its biggest set)
  let keep = find(anchor);
  if (![...pieces].some((pi) => find(pi) === keep)) { const size = new Map(); for (const pi of pieces) size.set(find(pi), (size.get(find(pi)) || 0) + meta[pi].tris.length); keep = [...size.entries()].sort((a, b) => b[1] - a[1])[0][0]; }
  const drop = new Map(); // mesh -> Set of triangle indices
  for (const pi of pieces) { if (find(pi) === keep || meta[pi].inst) continue; const s = drop.get(meta[pi].mesh) || new Set(); for (const t of meta[pi].tris) s.add(t); drop.set(meta[pi].mesh, s); }
  let removed = 0;
  for (const [m, s] of drop) {
    const g = m.geometry, nt = triCount(g);
    if (g.index) {
      const src = g.index.array, out = []; for (let t = 0; t < nt; t++) if (!s.has(t)) out.push(src[t * 3], src[t * 3 + 1], src[t * 3 + 2]);
      g.setIndex(out); g.clearGroups();
    } else {
      for (const k of Object.keys(g.attributes)) { const at = g.attributes[k], sz = at.itemSize, arr = at.array, out = new arr.constructor((nt - s.size) * 3 * sz); let o = 0; for (let t = 0; t < nt; t++) { if (s.has(t)) continue; out.set(arr.subarray(t * 3 * sz, (t + 1) * 3 * sz), o); o += 3 * sz; } g.setAttribute(k, new THREE.BufferAttribute(out, sz, at.normalized)); }
    }
    g.computeBoundingBox(); g.computeBoundingSphere(); m.userData.orphansDropped = (m.userData.orphansDropped || 0) + s.size; removed += s.size;
  }
  return removed;
}
