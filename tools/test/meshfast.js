// Fast geometry helpers for meshcheck: the same answers as the original pairwise checks, found through spatial grids.
//  - floatingParts: floating parts. One grid of every triangle on the vehicle; each vertex looks only at its own cell.
//    Touch = a vertex within tol of another piece's triangle (exact through the grid) or, for the few pieces still not
//    joined to the body after that, the full triangle test (edges through triangles too), as before.
//  - chunked: big meshes split into small spatially coherent proxy meshes (same material, matrix and userData), so
//    three's raycaster skips most triangles by bounding sphere. Ray results stay three's own (sides, normals, order).
import * as THREE from 'three';

// ---------- shared triangle maths (as in meshcheck.js) ----------
const _tri = new THREE.Triangle(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _h = new THREE.Vector3(), _s = new THREE.Vector3(), _qq = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _v = new THREE.Vector3();
function segTri(p0, p1, a, b, c) {
  _e1.subVectors(b, a); _e2.subVectors(c, a); const d = _q.subVectors(p1, p0); _h.crossVectors(d, _e2); const det = _e1.dot(_h);
  if (Math.abs(det) < 1e-12) return false; const f = 1 / det; _s.subVectors(p0, a); const u = f * _s.dot(_h); if (u < 0 || u > 1) return false;
  _qq.crossVectors(_s, _e1); const v = f * d.dot(_qq); if (v < 0 || u + v > 1) return false; const t = f * _e2.dot(_qq); return t >= 0 && t <= 1;
}
const vtx = (T, i, k, out) => out.set(T[i * 9 + k * 3], T[i * 9 + k * 3 + 1], T[i * 9 + k * 3 + 2]);
const _A = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function triTouch(TA, i, TB, j, tol) {
  const A = [vtx(TA, i, 0, _A[0]), vtx(TA, i, 1, _A[1]), vtx(TA, i, 2, _A[2])], B = [vtx(TB, j, 0, _a), vtx(TB, j, 1, _b), vtx(TB, j, 2, _c)];
  _tri.set(B[0], B[1], B[2]); for (const v of A) if (_tri.closestPointToPoint(v, _p).distanceToSquared(v) <= tol * tol) return true;
  _tri.set(A[0], A[1], A[2]); for (const v of B) if (_tri.closestPointToPoint(v, _p).distanceToSquared(v) <= tol * tol) return true;
  for (let e = 0; e < 3; e++) { if (segTri(A[e], A[(e + 1) % 3], B[0], B[1], B[2]) || segTri(B[e], B[(e + 1) % 3], A[0], A[1], A[2])) return true; }
  return false;
}
// connected pieces of one mesh (welded at 0.1 mm), world-space triangles
export function pieces(mesh, W, out) {
  const g = mesh.geometry, P = g.attributes.position, idx = g.index ? g.index.array : null, nt = (idx ? idx.length : P.count) / 3, v = new THREE.Vector3();
  const wp = new Float32Array(P.count * 3), key = new Map(), id = new Int32Array(P.count);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(W); wp[i * 3] = v.x; wp[i * 3 + 1] = v.y; wp[i * 3 + 2] = v.z; const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`; let j = key.get(k); if (j === undefined) key.set(k, j = key.size); id[i] = j; }
  const par = new Int32Array(key.size).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let t = 0; t < nt; t++) { const a = id[idx ? idx[t * 3] : t * 3], b = id[idx ? idx[t * 3 + 1] : t * 3 + 1], c = id[idx ? idx[t * 3 + 2] : t * 3 + 2]; par[find(a)] = find(b); par[find(b)] = find(c); }
  const groups = new Map();
  for (let t = 0; t < nt; t++) { const r = find(id[idx ? idx[t * 3] : t * 3]); let l = groups.get(r); if (!l) groups.set(r, l = []); l.push(t); }
  for (const ts of groups.values()) {
    const T = new Float32Array(ts.length * 9), box = new THREE.Box3();
    ts.forEach((t, n) => { for (let k = 0; k < 3; k++) { const vi = idx ? idx[t * 3 + k] : t * 3 + k; T[n * 9 + k * 3] = wp[vi * 3]; T[n * 9 + k * 3 + 1] = wp[vi * 3 + 1]; T[n * 9 + k * 3 + 2] = wp[vi * 3 + 2]; box.expandByPoint(v.set(wp[vi * 3], wp[vi * 3 + 1], wp[vi * 3 + 2])); } });
    out.push({ T, box, mesh });
  }
}

// ---------- a uniform grid of triangles (bounds grown by tol), integer cell keys, compact lists ----------
function triGrid(comps, tol) {
  let n = 0; for (const c of comps) n += c.T.length / 9;
  const T = new Float32Array(n * 9), owner = new Int32Array(n), lo = new Float32Array(n * 3), hi = new Float32Array(n * 3);
  let k = 0; const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
  let edge = 0;
  comps.forEach((c, ci) => {
    T.set(c.T, k * 9);
    for (let t = 0; t < c.T.length / 9; t++, k++) {
      owner[k] = ci;
      for (let a = 0; a < 3; a++) {
        const v0 = T[k * 9 + a], v1 = T[k * 9 + 3 + a], v2 = T[k * 9 + 6 + a], l = Math.min(v0, v1, v2) - tol, h = Math.max(v0, v1, v2) + tol;
        lo[k * 3 + a] = l; hi[k * 3 + a] = h; if (l < gmin[a]) gmin[a] = l; if (h > gmax[a]) gmax[a] = h; edge += h - l;
      }
    }
  });
  // cell about the size of a typical triangle (its grown bounds), within 2-20 cm
  const cell = Math.min(0.2, Math.max(0.02, n ? edge / (n * 3) : 0.05));
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((gmax[a] - gmin[a]) / cell) + 1));
  const ci = (x, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((x - gmin[a]) / cell)));
  const key = (x, y, z) => (x * dims[1] + y) * dims[2] + z;
  const count = new Map();
  const span = (t, f) => { const x0 = ci(lo[t * 3], 0), x1 = ci(hi[t * 3], 0), y0 = ci(lo[t * 3 + 1], 1), y1 = ci(hi[t * 3 + 1], 1), z0 = ci(lo[t * 3 + 2], 2), z1 = ci(hi[t * 3 + 2], 2); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) f(key(x, y, z)); };
  let total = 0;
  for (let t = 0; t < n; t++) span(t, (q) => { count.set(q, (count.get(q) || 0) + 1); total++; });
  const start = new Map(); let o = 0; for (const [q, c] of count) { start.set(q, o); o += c; }
  const fill = new Map(start), list = new Int32Array(total);
  for (let t = 0; t < n; t++) span(t, (q) => { const p = fill.get(q); list[p] = t; fill.set(q, p + 1); });
  const cellOf = (x, y, z) => { const q = key(ci(x, 0), ci(y, 1), ci(z, 2)), s = start.get(q); return s === undefined ? null : [s, s + count.get(q)]; };
  return { T, owner, lo, hi, list, cellOf, span, start, count, n };
}

// ---------- floating parts (same inputs, rules and report as meshcheck's floatingParts) ----------
export function floatingParts(root, det, design, { tol = 0.01, gaps = true } = {}) {
  root.updateMatrixWorld(true);
  const comps = [], shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; }, M4 = new THREE.Matrix4();
  root.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.isDisc || m.userData.decal || !shown(m)) return;
    for (let x = m; x; x = x.parent) if (x.userData.floatOk) return;
    const mt = m.material; if (!mt || Array.isArray(mt) || mt.blending === THREE.AdditiveBlending || mt.colorWrite === false) return;
    if (m.isInstancedMesh) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, M4); pieces(m, M4.clone().premultiply(m.matrixWorld), comps); }
    else pieces(m, m.matrixWorld, comps);
  });
  const par = new Int32Array(comps.length).map((_, i) => i), find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const G = triGrid(comps, tol), { T, owner, lo, hi, list } = G, tol2 = tol * tol;
  // 1. every vertex against the triangles of other pieces in its cell
  for (let t = 0; t < G.n; t++) {
    const pi = owner[t];
    for (let k = 0; k < 3; k++) {
      const x = T[t * 9 + k * 3], y = T[t * 9 + k * 3 + 1], z = T[t * 9 + k * 3 + 2], r = G.cellOf(x, y, z); if (!r) continue;
      for (let p = r[0]; p < r[1]; p++) {
        const u = list[p], pj = owner[u]; if (pj === pi) continue;
        if (x < lo[u * 3] || x > hi[u * 3] || y < lo[u * 3 + 1] || y > hi[u * 3 + 1] || z < lo[u * 3 + 2] || z > hi[u * 3 + 2]) continue;
        const ri = find(pi), rj = find(pj); if (ri === rj) continue;
        _v.set(x, y, z); _tri.set(vtx(T, u, 0, _a), vtx(T, u, 1, _b), vtx(T, u, 2, _c));
        if (_tri.closestPointToPoint(_v, _p).distanceToSquared(_v) <= tol2) par[ri] = rj;
      }
    }
  }
  // 2. pieces not on the main body yet: the full triangle test (edges through triangles) against every neighbour
  const mainOf = () => { const sets = new Map(); comps.forEach((c, i) => { const r = find(i); sets.set(r, (sets.get(r) || 0) + c.T.length); }); return [...sets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
  const base = new Int32Array(comps.length + 1); comps.forEach((c, i) => { base[i + 1] = base[i] + c.T.length / 9; });
  for (let changed = true; changed;) {
    changed = false; const main = mainOf();
    for (let i = 0; i < comps.length; i++) {
      if (find(i) === main) continue;
      let joined = false;
      for (let t = base[i]; t < base[i + 1] && !joined; t++) {
        const seen = new Set();
        G.span(t, (q) => {
          if (joined) return; const s = G.start.get(q); if (s === undefined) return;
          for (let p = s, e = s + G.count.get(q); p < e; p++) {
            const u = list[p], pj = owner[u]; if (pj === i || seen.has(u)) continue; seen.add(u);
            if (find(pj) === find(i)) continue;
            if (lo[t * 3] > hi[u * 3] || hi[t * 3] < lo[u * 3] || lo[t * 3 + 1] > hi[u * 3 + 1] || hi[t * 3 + 1] < lo[u * 3 + 1] || lo[t * 3 + 2] > hi[u * 3 + 2] || hi[t * 3 + 2] < lo[u * 3 + 2]) continue;
            if (triTouch(T, t, T, u, tol)) { par[find(i)] = find(pj); joined = true; changed = true; return; }
          }
        });
      }
    }
  }
  const main = mainOf();
  const partOf = (m) => { for (let o = m; o; o = o.parent) { const i = det.parts.indexOf(o); if (i >= 0) return `#${i} ${design.parts[i].id}`; } return 'assembly'; };
  const mainC = comps.filter((_, i) => find(i) === main), gapOf = (c) => {
    let best = Infinity; const reach = c.box.clone().expandByScalar(0.5), v = new THREE.Vector3(), n = c.T.length / 3, step = Math.max(1, Math.floor(n / 150));
    for (const m of mainC) {
      if (!m.box.intersectsBox(reach)) continue;
      for (let t = 0; t < m.T.length / 9; t++) {
        vtx(m.T, t, 0, _a); vtx(m.T, t, 1, _b); vtx(m.T, t, 2, _c); _tri.set(_a, _b, _c);
        const tb = new THREE.Box3().setFromPoints([_a, _b, _c]); if (!tb.intersectsBox(reach)) continue;
        for (let k = 0; k < n; k += step) { v.set(c.T[k * 3], c.T[k * 3 + 1], c.T[k * 3 + 2]); const d = _tri.closestPointToPoint(v, _p).distanceTo(v); if (d < best) best = d; }
      }
    }
    return best;
  };
  const out = new Map();
  comps.forEach((c, i) => {
    if (find(i) === main) return;
    const k = partOf(c.mesh) + ' ' + (c.mesh.material.name || c.mesh.material.type) + ' #' + (c.mesh.material.color?.getHexString?.() || '') + (c.mesh.isInstancedMesh ? ' (link)' : '');
    const sz = c.box.getSize(new THREE.Vector3()).length();
    if (!out.has(k)) out.set(k, { what: k, n: 0, size: 0, at: null });
    const o = out.get(k); o.n++; if (sz > o.size) { o.size = +sz.toFixed(3); o.at = c.box.getCenter(new THREE.Vector3()).toArray().map((x) => +x.toFixed(2)); }
    if (gaps && o.n <= 4) { const g = gapOf(c); o.gap = Math.min(o.gap ?? Infinity, g); }
  });
  for (const o of out.values()) if (o.gap !== undefined) o.gap = Number.isFinite(o.gap) ? +o.gap.toFixed(3) : '>0.5';
  return { pieces: comps.length, floating: [...out.values()] };
}

// ---------- chunked proxies for raycasting ----------
// Each non-instanced mesh with more than `size` triangles becomes proxies of about `size` triangles each, split by
// recursive median along the longest axis (non-indexed copies of position and normal, so each proxy's bounding sphere
// is tight). proxy.userData.src is the original mesh; material, userData flags and matrixWorld are the original's.
export function chunked(meshes, size = 256) {
  const out = [];
  for (const m of meshes) {
    const g = m.geometry, P = g.attributes.position, N = g.attributes.normal, idx = g.index ? g.index.array : null;
    const r0 = g.drawRange.start, r1 = Math.min(idx ? idx.length : P.count, g.drawRange.start + g.drawRange.count);
    const nt = Math.floor((r1 - r0) / 3);
    if (m.isInstancedMesh || nt <= size) { out.push(m); continue; }
    const vi = (t, k) => (idx ? idx[r0 + t * 3 + k] : r0 + t * 3 + k);
    const cen = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let a = 0; a < 3; a++) cen[t * 3 + a] = (P.array[vi(t, 0) * P.itemSize + a] + P.array[vi(t, 1) * P.itemSize + a] + P.array[vi(t, 2) * P.itemSize + a]) / 3;
    const ids = new Int32Array(nt).map((_, i) => i);
    const split = (s, e) => {
      if (e - s <= size) {
        const pos = new Float32Array((e - s) * 9), nor = N ? new Float32Array((e - s) * 9) : null;
        for (let j = s; j < e; j++) for (let k = 0; k < 3; k++) { const v = vi(ids[j], k), o = ((j - s) * 3 + k) * 3; pos[o] = P.getX(v); pos[o + 1] = P.getY(v); pos[o + 2] = P.getZ(v); if (nor) { nor[o] = N.getX(v); nor[o + 1] = N.getY(v); nor[o + 2] = N.getZ(v); } }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        const p = new THREE.Mesh(geo, m.material); p.matrixAutoUpdate = false; p.matrixWorld.copy(m.matrixWorld); p.userData = Object.assign(Object.create(m.userData), { src: m });
        out.push(p); return;
      }
      let ax = 0, best = -1; for (let a = 0; a < 3; a++) { let l = Infinity, h = -Infinity; for (let j = s; j < e; j++) { const c = cen[ids[j] * 3 + a]; if (c < l) l = c; if (c > h) h = c; } if (h - l > best) { best = h - l; ax = a; } }
      const sub = Array.from(ids.subarray(s, e)).sort((x, y) => cen[x * 3 + ax] - cen[y * 3 + ax]); ids.set(sub, s);
      const mid = (s + e) >> 1; split(s, mid); split(mid, e);
    };
    split(0, nt);
  }
  return out;
}
export const srcOf = (o) => o.userData.src || o;
