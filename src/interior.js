// Interiors are inviolate: no other part's geometry shows inside a cockpit or cabin (the volume the crew sits in), whatever
// the vehicle and wherever a kid bolted things on. Wings, wing roots and fillets, struts, engines, tanks, gear, tails,
// the body's own frames and skin pieces: run planeDetail.assemble once everything is built, keepOut() cuts every other
// part's triangles away where they are inside a crewed part's interior, splitting the ones that cross its boundary along
// it, so what is left stops at the cockpit's walls, tub and glass (which hide the cut). The cockpit's own geometry, its
// crew and its glass are never touched. Visual only: physics and collision read partInfo() and never see any of it.
//
// A part's interior, in its own coordinates (the same frame as its seats), is the union of:
//   - obj.userData.interior, if it declares one: a list of regions, each either a single shape or { all: [shape, ...] }
//     (the intersection of those shapes). A shape is any of crew.js's cockpit-obstacle forms that bound a space
//     (see the cockpit-obstacles comment in crew.js), read as "inside it is interior":
//       { inside: [[z, w, h, yc, n?, wb?], ...], ex?, ey?, below?, wBelow?, top?, floor? }   a cab / canopy / bubble
//          section by section; closed before its first row and after its last, above `top` (if given) and below
//          `floor` (if given, else the part's own bottom) where it goes on down as walls
//       { well: [ring, ring, ...] }   a tub: closed below its bottom ring, open above its top ring (put a canopy shape in
//          the same `all` to close it)
//       { box: [cx, cy, cz], size: [sx, sy, sz], rot?: [rx, ry, rz] }   a box of interior space
//       { plane: [nx, ny, nz], at: [x, y, z] }   a half-space (the side the normal points to), for `all` lists
//     e.g. a wheelhouse: g.userData.interior = [{ box: [0, 1.1, 0], size: [1.6, 1.9, 1.4] }]
//   - otherwise, for each seat (seats[k].obstacles), the space its crew is kept inside: the intersection of its
//     containing obstacles ({ inside } canopies, cabs and linings, the { well } tub skinBlend.js adds, taken as built,
//     { plane } walls and bulkheads); a walls-down canopy with no tub under it is closed at the seat's fit.floor. A seat with no containing obstacle (a
//     bike, a jet ski, an open boat deck) has no interior: it is open air.
// Every interior is also kept within the part's own bounds (its meshes before the crew), less a few millimetres.
import * as THREE from 'three';
import { prepObstacle, obstacleClear } from './crew.js';

const MARGIN = 0.006; // (part metres: geometry lying on the interior's boundary, like the skin cut along the glass, is left alone)
const WELL_SLACK = 0.007; // a tub's own walls hide what is behind them: the cut reaches this far past them (part metres; the tub is kept 1 cm inside the skin)
const H_MIN = 0.04; // triangles crossing the boundary are split down to this size (part metres) before cutting
const H_STEP = 0.004; // ... and down to this where the depth steps (a coaming lip over a wider footwell), so the cut lands on the step
const SAFE = 1.6; // the shapes' depths are only roughly distances: the slope seen along a triangle's edges is trusted this far ...
const K0 = 1.2; // ... and never less than this (a triangle is only judged wholly in or out with this much slack)

const CONTAIN = (o) => o && (o.inside || o.well || o.plane);

// one shape as a signed depth function (> 0 inside), part coordinates
function shapeDepth(d, bottom) {
  const o = prepObstacle(d);
  if (o.k === 'plane') return (p) => obstacleClear(o, p, 0);
  if (o.k === 'box') return (p) => -obstacleClear(o, p, 0);
  // (a tub: open above, a canopy closes it)
  if (o.k === 'well') return wellDepth(d.well);
  if (o.k === 'tube') {
    const z0 = o.rows[0][0], z1 = o.rows.at(-1)[0], top = d.top ?? Infinity, floor = d.floor ?? (o.below === 'walls' ? bottom : -Infinity);
    return (p) => { const c = obstacleClear(o, p, 0, true); return Math.min(c === Infinity ? 1e3 : c, p.z - z0, z1 - p.z, top - p.y, p.y - floor); };
  }
  return null;
}

// A well's depth, exactly: its section at the point's height is the polygon through each wall line's point there (a
// line's top point above it: the wall goes on straight up), the depth the signed distance to that polygon's edges
function wellDepth(rings) {
  const n = rings[0].length, y0 = Math.min(...rings.at(-1).map((p) => p[1])), xs = new Float64Array(n), zs = new Float64Array(n), all = rings.flat();
  const x0 = Math.min(...all.map((q) => q[0])), x1 = Math.max(...all.map((q) => q[0])), z0 = Math.min(...all.map((q) => q[2])), z1 = Math.max(...all.map((q) => q[2]));
  return (p) => {
    const ox = Math.max(x0 - p.x, p.x - x1, 0), oz = Math.max(z0 - p.z, p.z - z1, 0);
    if (ox > 0.02 || oz > 0.02 || p.y < y0 - 0.02) return -Math.max(Math.hypot(ox, oz), y0 - p.y) + WELL_SLACK; // (well clear of it: the distance to its bounds, never more than the real one)
    for (let k = 0; k < n; k++) {
      let x = rings[0][k][0], z = rings[0][k][2];
      if (p.y < rings[0][k][1]) for (let j = 1; j < rings.length; j++) { const a = rings[j - 1][k], b = rings[j][k]; if (p.y >= b[1] || j === rings.length - 1) { const t = Math.min(1, Math.max(0, (a[1] - p.y) / (a[1] - b[1] || 1))); x = a[0] + (b[0] - a[0]) * t; z = a[2] + (b[2] - a[2]) * t; break; } }
      xs[k] = x; zs[k] = z;
    }
    let d2 = Infinity, inside = false;
    for (let k = 0, j = n - 1; k < n; j = k++) {
      const ax = xs[j], az = zs[j], ex = xs[k] - ax, ez = zs[k] - az;
      if ((zs[k] > p.z) !== (az > p.z) && p.x < ax + (ex * (p.z - az)) / (ez || 1e-12)) inside = !inside;
      const t = Math.min(1, Math.max(0, ((p.x - ax) * ex + (p.z - az) * ez) / (ex * ex + ez * ez || 1))), dx = p.x - ax - ex * t, dz = p.z - az - ez * t;
      d2 = Math.min(d2, dx * dx + dz * dz);
    }
    return Math.min((inside ? 1 : -1) * Math.sqrt(d2), p.y - y0) + WELL_SLACK;
  };
}

// the part's interior as { f(p) -> depth (> 0 inside, part coordinates), box (part-space bounds) }, or null
export function interiorOf(obj) {
  const box = new THREE.Box3(), inv = obj.matrixWorld.clone().invert(), m = new THREE.Matrix4();
  obj.traverse((c) => { if (c.isMesh && !c.isSkinnedMesh && c.geometry?.attributes.position) { c.geometry.computeBoundingBox(); box.union(c.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, c.matrixWorld))); } });
  if (box.isEmpty()) return null;
  const regions = [];
  const decl = obj.userData.interior;
  if (decl?.length) for (const r of decl) regions.push((r.all || [r]).map((d) => shapeDepth(d, box.min.y)).filter(Boolean));
  else for (const st of obj.userData.seats || []) {
    const list = (st.obstacles || []).filter(CONTAIN).map((o) => (o.name === 'tub' && o.well && obj.userData.tubWell ? { ...o, well: obj.userData.tubWell } : o)); // (the tub as built, every point)
    if (!list.some((o) => o.inside || o.well)) continue;
    const floor = list.some((o) => o.well) ? null : st.fit?.floor; // (a tub closes it below itself, however deep)
    regions.push(list.map((d) => shapeDepth(d.inside && d.below !== 'mirror' && d.floor == null && floor != null ? { ...d, floor } : d, box.min.y)).filter(Boolean));
  }
  const live = regions.filter((r) => r.length); if (!live.length) return null;
  const bx = box, f = (p) => {
    let best = -Infinity;
    for (const r of live) { let v = Infinity; for (const g of r) { v = Math.min(v, g(p)); if (v < best) break; } if (v > best) best = v; }
    return Math.min(best, p.x - bx.min.x, bx.max.x - p.x, p.y - bx.min.y, bx.max.y - p.y, p.z - bx.min.z, bx.max.z - p.z) - MARGIN;
  };
  return { f, box };
}

// Cut `mesh` (not part of the interior's own part) away inside interior I of part object `owner`. Returns the
// number of triangles taken out (whole or in part), 0 if it was untouched.
function cutMesh(mesh, owner, I) {
  const geo = mesh.geometry, P = geo.attributes.position;
  if (!P || P.isInterleavedBufferAttribute || Array.isArray(mesh.material) || Object.keys(geo.morphAttributes).length) return 0; // (one material: its groups, if any, are not used)
  const toPart = new THREE.Matrix4().multiplyMatrices(owner.matrixWorld.clone().invert(), mesh.matrixWorld);
  const n = P.count, lp = new Float64Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(P, i).applyMatrix4(toPart); lp[i * 3] = v.x; lp[i * 3 + 1] = v.y; lp[i * 3 + 2] = v.z; }
  const idx = geo.index ? geo.index.array : null, nt = (idx ? idx.length : n) / 3, B = I.box;
  const vi = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
  // quick reject: no triangle near the interior's box
  const near = new Uint8Array(nt); let anyNear = false;
  for (let t = 0; t < nt; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) { const a = vi(t, k) * 3; x0 = Math.min(x0, lp[a]); x1 = Math.max(x1, lp[a]); y0 = Math.min(y0, lp[a + 1]); y1 = Math.max(y1, lp[a + 1]); z0 = Math.min(z0, lp[a + 2]); z1 = Math.max(z1, lp[a + 2]); }
    if (x1 >= B.min.x && x0 <= B.max.x && y1 >= B.min.y && y0 <= B.max.y && z1 >= B.min.z && z0 <= B.max.z) { near[t] = 1; anyNear = true; }
  }
  if (!anyNear) return 0;
  // most meshes near a cockpit only pass by it: settle that from the corners' depths before copying anything
  const d0 = new Float64Array(n).fill(NaN);
  { const dv = (i) => (Number.isNaN(d0[i]) ? (d0[i] = I.f(v.set(lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2]))) : d0[i]);
    const ln = (a, b) => Math.hypot(lp[a * 3] - lp[b * 3], lp[a * 3 + 1] - lp[b * 3 + 1], lp[a * 3 + 2] - lp[b * 3 + 2]);
    let touch = false;
    for (let t = 0; t < nt && !touch; t++) {
      if (!near[t]) continue; const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2), da = dv(a), db = dv(b), dc = dv(c), lab = ln(a, b), lbc = ln(b, c), lca = ln(c, a);
      const K = Math.max(K0, SAFE * Math.max(Math.abs(da - db) / (lab || 1), Math.abs(db - dc) / (lbc || 1), Math.abs(dc - da) / (lca || 1)));
      if (!(Math.min(da, db, dc) < -Math.max(lab, lbc, lca) * K)) touch = true;
    }
    if (!touch) return 0; }
  // vertices as growable arrays: every attribute, plus the part-space position and its depth
  const names = Object.keys(geo.attributes).filter((k) => !geo.attributes[k].isInterleavedBufferAttribute), src = names.map((k) => geo.attributes[k]);
  const arr = src.map((a) => Array.from(a.array)), sz = src.map((a) => a.itemSize), nrm = names.indexOf('normal');
  const pos = Array.from(lp), dep = Array.from(d0), w = new THREE.Vector3(), _e = [0, 0, 0];
  const depth = (i) => { if (Number.isNaN(dep[i])) dep[i] = I.f(w.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])); return dep[i]; };
  let count = n; const mids = new Map();
  const mix = (a, b, t) => { // a new vertex between a and b (cached per edge and t)
    const key = (a < b ? a + ',' + b : b + ',' + a) + ',' + (a < b ? t : 1 - t).toFixed(6); const hit = mids.get(key); if (hit != null) return hit;
    const c = count++;
    arr.forEach((d, k) => { const s = sz[k]; for (let j = 0; j < s; j++) d.push(d[a * s + j] + (d[b * s + j] - d[a * s + j]) * t); if (k === nrm) { const o = c * 3, l = Math.hypot(d[o], d[o + 1], d[o + 2]) || 1; d[o] /= l; d[o + 1] /= l; d[o + 2] /= l; } });
    for (let j = 0; j < 3; j++) pos.push(pos[a * 3 + j] + (pos[b * 3 + j] - pos[a * 3 + j]) * t);
    dep.push(NaN); mids.set(key, c); return c;
  };
  const len = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  // where the boundary crosses edge p -> q (depths dp, dq of opposite signs): found on the shapes themselves, not
  // interpolated (a depth that steps, at a coaming lip, would put the cut anywhere along the edge), then a little outward
  const crossing = (p, q, dp, dq) => {
    let lo = 0, hi = 1; const pin = dp > 0;
    for (let it = 0; it < 6; it++) { const t = (lo + hi) / 2; for (let j = 0; j < 3; j++) _e[j] = pos[p * 3 + j] + (pos[q * 3 + j] - pos[p * 3 + j]) * t; if ((I.f(w.set(_e[0], _e[1], _e[2])) > 0) === pin) lo = t; else hi = t; }
    return pin ? hi : lo;
  };
  const out = [], edge = []; let removed = 0; // (edge: the vertices along the cut)
  const tri = (a, b, c, lvl) => {
    const da = depth(a), db = depth(b), dc = depth(c), lab = len(a, b), lbc = len(b, c), lca = len(c, a);
    // (how far the depth can change across it: the shapes' depths are only roughly distances, steeper near the ends of
    // an elliptical section, so the slope seen along its own edges counts too)
    const K = Math.max(K0, SAFE * Math.max(Math.abs(da - db) / (lab || 1), Math.abs(db - dc) / (lbc || 1), Math.abs(dc - da) / (lca || 1))), L = Math.max(lab, lbc, lca) * K;
    if (Math.min(da, db, dc) < -L) { out.push(a, b, c); return 0; } // wholly outside (every point within L of each corner)
    if (Math.max(da, db, dc) > L) return 1; // wholly inside
    if (L / K > (K > 4 * SAFE ? H_STEP : H_MIN) && lvl < 24) { // split the longest edge and look again (and keep it whole if no piece of it was inside)
      const o0 = out.length; let r;
      if (lab >= lbc && lab >= lca) { const m = mix(a, b, 0.5); r = tri(a, m, c, lvl + 1) | tri(m, b, c, lvl + 1); }
      else if (lbc >= lca) { const m = mix(b, c, 0.5); r = tri(a, b, m, lvl + 1) | tri(a, m, c, lvl + 1); }
      else { const m = mix(c, a, 0.5); r = tri(a, b, m, lvl + 1) | tri(m, b, c, lvl + 1); }
      if (!r) { out.length = o0; out.push(a, b, c); }
      return r;
    }
    const t3 = [a, b, c], d3 = [da, db, dc], ins = d3.map((d) => d > 0), k = ins.filter(Boolean).length;
    if (!k) { out.push(a, b, c); return 0; }
    if (k === 3) return 1;
    const poly = [];
    for (let e = 0; e < 3; e++) { const p = t3[e], q = t3[(e + 1) % 3]; if (!ins[e]) poly.push(p); if (ins[e] !== ins[(e + 1) % 3]) { const m = mix(p, q, crossing(p, q, d3[e], d3[(e + 1) % 3])); poly.push(m); edge.push(m); } }
    for (let j = 1; j < poly.length - 1; j++) out.push(poly[0], poly[j], poly[j + 1]);
    return 1;
  };
  for (let t = 0; t < nt; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    if (!near[t]) { out.push(a, b, c); continue; }
    removed += tri(a, b, c, 0);
  }
  if (!removed) return 0;
  // Line what the cut opened. It leaves the mesh open along the interior's boundary, and where that boundary is glass
  // (or open air past a tub's rim) the opening shows: you would see through the part (a wing's root behind a bubble
  // canopy, a cowl through a windscreen). So every connected piece the cut opened gets its inside as well: its
  // triangles again, wound the other way with their normals turned in, and it reads solid from any side.
  if (edge.length) {
    const key = new Map(), root = new Int32Array(count), find = (a) => { while (root[a] !== a) a = root[a] = root[root[a]]; return a; };
    for (let i = 0; i < count; i++) { const k = Math.round(pos[i * 3] * 1e5) + ',' + Math.round(pos[i * 3 + 1] * 1e5) + ',' + Math.round(pos[i * 3 + 2] * 1e5), j = key.get(k); root[i] = i; if (j === undefined) key.set(k, i); else root[i] = j; } // (welded: uv seams)
    for (let k = 0; k < out.length; k += 3) { const a = find(out[k]); root[find(out[k + 1])] = a; root[find(out[k + 2])] = a; }
    const opened = new Set(edge.map(find)), inner = new Map(), flip = (v) => { // (the same vertex, its normal turned in)
      if (inner.has(v)) return inner.get(v); const c = count++;
      arr.forEach((d, k) => { const s = sz[k]; for (let j = 0; j < s; j++) d.push(k === nrm ? -d[v * s + j] : d[v * s + j]); });
      for (let j = 0; j < 3; j++) pos.push(pos[v * 3 + j]); dep.push(dep[v]); inner.set(v, c); return c;
    };
    for (let k = 0, n0 = out.length; k < n0; k += 3) if (opened.has(find(out[k]))) out.push(flip(out[k]), flip(out[k + 2]), flip(out[k + 1]));
  }
  // only the vertices still used (the splits of triangles kept whole are dropped)
  const map = new Int32Array(count).fill(-1); let m = 0;
  for (let k = 0; k < out.length; k++) { const a = out[k]; if (map[a] < 0) map[a] = m++; out[k] = map[a]; }
  const g = new THREE.BufferGeometry();
  names.forEach((k, j) => {
    const s = sz[j], d = arr[j], A = new src[j].array.constructor(m * s);
    for (let i = 0; i < count; i++) if (map[i] >= 0) for (let c = 0; c < s; c++) A[map[i] * s + c] = d[i * s + c];
    g.setAttribute(k, new THREE.BufferAttribute(A, s, src[j].normalized));
  });
  g.setIndex(m > 65535 ? new THREE.Uint32BufferAttribute(out, 1) : new THREE.Uint16BufferAttribute(out, 1)); g.userData = geo.userData; g.computeBoundingBox(); g.computeBoundingSphere();
  mesh.geometry = g; mesh.userData.keptOut = (mesh.userData.keptOut || 0) + removed; // (the old one is not disposed: it may be shared, and it was never drawn)
  return removed;
}

// Every crewed part's interior kept clear of every other part. objs: the design's part objects (world matrices current).
// Returns { cut: triangles cut per cockpit part index, ms }.
export function keepOut(objs) {
  const t0 = performance.now(), cut = {};
  if (globalThis.__noKeepOut) return { cut, ms: 0 }; // (off: for before/after measurements)
  objs.forEach((owner, i) => {
    if (!owner || !(owner.userData.interior?.length || owner.userData.seats?.length)) return;
    owner.updateMatrixWorld(true);
    const I = interiorOf(owner); if (!I) return;
    const wbox = I.box.clone().applyMatrix4(owner.matrixWorld);
    let n = 0;
    objs.forEach((o, j) => {
      if (!o || j === i) return;
      o.traverse((m) => {
        if (!m.isMesh || m.isSkinnedMesh || m.isInstancedMesh || !m.geometry) return;
        m.geometry.computeBoundingBox(); if (!m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld).intersectsBox(wbox)) return;
        n += cutMesh(m, owner, I);
      });
    });
    if (n) cut[i] = n;
  });
  return { cut, ms: performance.now() - t0 };
}

// For measuring (tools, probes): how many of every other part's triangles have a corner or centroid more than `tol`
// inside each crewed part's interior. { [part index]: { [other part index]: count } }
export function intruders(objs, tol = 0.005) {
  const res = {}, v = new THREE.Vector3(), c = new THREE.Vector3();
  objs.forEach((owner, i) => {
    if (!owner || !(owner.userData.interior?.length || owner.userData.seats?.length)) return;
    owner.updateMatrixWorld(true); const I = interiorOf(owner); if (!I) return;
    const wbox = I.box.clone().applyMatrix4(owner.matrixWorld), inv = owner.matrixWorld.clone().invert(), per = {};
    objs.forEach((o, j) => {
      if (!o || j === i) return; let n = 0;
      o.traverse((m) => {
        if (!m.isMesh || m.isSkinnedMesh || !m.visible || !m.geometry?.attributes.position) return;
        m.geometry.computeBoundingBox(); if (!m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld).intersectsBox(wbox)) return;
        const P = m.geometry.attributes.position, ix = m.geometry.index?.array, M4 = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
        const nt = (ix ? ix.length : P.count) / 3;
        for (let t = 0; t < nt; t++) {
          let hit = false; c.set(0, 0, 0);
          for (let k = 0; k < 3; k++) { v.fromBufferAttribute(P, ix ? ix[t * 3 + k] : t * 3 + k).applyMatrix4(M4); c.add(v); if (!hit && I.f(v) > tol) hit = true; }
          if (!hit && I.f(c.multiplyScalar(1 / 3)) > tol) hit = true;
          if (hit) n++;
        }
      });
      if (n) per[j] = n;
    });
    res[i] = per;
  });
  return res;
}
