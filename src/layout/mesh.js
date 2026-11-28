// Joining a chunk's baked layout (format.js) into one surface with the natural ground around it: its outlines' points
// (worked out from its network, outline.js), the chunk's edge points (every EDGE_STEP m), the hi grid's points off the paved regions and, where the roads
// reshape the ground (a city's lots, banks), more points on a lattice; every height from rules.js; a constrained
// Delaunay triangulation with the outlines fixed; each triangle's kind from the region its middle is in. Pure (no
// three.js, no World): the game runs it in a worker (worker.js), the bake and the tests call it directly.
//
// level 'fine': all of it. level 'coarse': the chunk's edge points (the same: neighbours always meet; stored by the bake,
// format.js eg, so no outlines are worked out), inside one point per COARSE_CELL (the roads' stations), every other grid
// point; only the chunk's edge fixed; every triangle ground (far away, the imagery's roads).
import Delaunator from '../../vendor/layout/delaunator.js';
import Constrainautor from '../../vendor/layout/constrainautor.mjs';
import { KIND } from './format.js';
import { makeRules, latticeGround, KERB, KERB_W, PAVE_RAMP, painted, zebra } from './rules.js';
import { chunkOutlines } from './outline.js';

const RAIL_STEP = 6, NONE = new Set(), KERB_GRADE = 0.3, EDGE_STEP = 4, COARSE_CELL = 8, CITY_IN = 10, BANK_STEP = 4, BANK_MIN = 0.03, CLEAR = 0.75, LANE_STEP = 6, ZEBRA = [0.5, 3.5], MOUTH_D = 6; // (ZEBRA: a crossing's band, m out from a junction's circle, as roadMat paints it)
const PAVED = [KIND.lip, KIND.tarmac, KIND.kerb, KIND.ballast, KIND.pave, KIND.alley, KIND.pavers, KIND.gravel, KIND.verge]; // (the order a point is classed in)
const RIBBON = new Set([KIND.tarmac, KIND.kerb, KIND.pave]); // (drawn with a street's coordinates: markings, the pavement's slabs)

// the hi grid's points a chunk's ground uses (and one more round it, for the bilinear ground): lat
export const latticeOf = (L, grid) => { const m = Math.ceil(LAT_PAD / grid.sp) + 1, i0 = Math.floor((L.x0 - grid.x0) / grid.sp) - m, j0 = Math.floor((L.z0 - grid.z0) / grid.sp) - m, n = Math.ceil(L.size / grid.sp) + 2 * m + 1; return { i0, j0, ni: n, nj: n }; };
export { EDGE_STEP };
const LAT_PAD = 56; // (m past the chunk: the rules read the ground at a road's nearest point (the banks' slope), up to rules.js PAD away; both chunks beside an edge must read the same)

// L: a decoded chunk; grid: { x0, z0, sp } the hi grid; G: its heights at latticeOf(L, grid)'s points (ni * nj)
// edgeH: { w, e, s, n } (any of them): on that side of the chunk the layout's outer edge meets today's terrain (#294's
// edge rule: the finer side adapts to the coarser side's edge points): that terrain's heights at the side's EDGE_STEP points,
// from its low corner (x0 or z0) on, which the side's ground points take (drawn and physics), so the two meet; c: the
// four corners' (null: a corner every chunk about is the layout's)
export function meshChunk(L, grid, G, level = 'fine', edgeH = null) {
  const t0 = performance.now(), fine = level === 'fine', lat = latticeOf(L, grid), g = latticeGround(grid, lat, G), R = makeRules(L.net, g, !!L.city, grid.wl ?? -Infinity);
  const X0 = Math.round(L.x0 * 100), Z0 = Math.round(L.z0 * 100), S = Math.round(L.size * 100);
  // ---- the points (centimetres while they're gathered)
  const PX = [], PZ = [], key = new Map(), kinds = [];
  const add = (X, Z) => { const k = X * 1e7 + Z; let i = key.get(k); if (i == null) { i = PX.length; key.set(k, i); PX.push(X); PZ.push(Z); kinds.push(0); } return i; };
  const pre = !fine && L.edge; // (coarse, with the bake's edge points (format.js eg): no outlines)
  const O = pre ? edgeOnly(L.edge) : chunkOutlines(L.net, L.areas, L), ol = O.P.map(([x, z]) => add(x, z)), tOut = performance.now() - t0; // (the outlines: from the network, outline.js)
  const E = []; for (const [a0, b0, k] of O.E) { const a = ol[a0], b = ol[b0]; E.push([a, b, k]); kinds[a] |= 1 << k; kinds[b] |= 1 << k; }
  for (const [i, m] of O.edgeBits) kinds[ol[i]] = m; // (a point on the chunk's edge: its regions as the chunk beside sees them too (outline.js))
  for (let s = 0; s <= S; s += EDGE_STEP * 100) { add(X0 + s, Z0); add(X0 + s, Z0 + S); add(X0, Z0 + s); add(X0 + S, Z0 + s); }
  // which paved region a point is in (cm), first in PAVED's order; ground otherwise
  const RW = 200, rows = new Map(); for (const [a, b, k] of E) { const az = PZ[a], bz = PZ[b]; if (az === bz) continue; for (let r = Math.floor(Math.min(az, bz) / RW); r <= Math.floor(Math.max(az, bz) / RW); r++) (rows.get(r) || rows.set(r, []).get(r)).push(a, b, k); }
  const classify = (x, z) => { const L2 = rows.get(Math.floor(z / RW)); if (!L2) return KIND.ground; let inside = 0; for (let q = 0; q < L2.length; q += 3) { const a = L2[q], b = L2[q + 1], az = PZ[a], bz = PZ[b]; if ((az > z) !== (bz > z) && x < PX[a] + (PX[b] - PX[a]) * (z - az) / (bz - az)) inside ^= 1 << L2[q + 2]; } for (const k of PAVED) if (inside & (1 << k)) return k; return KIND.ground; };
  const inside = (X, Z, m) => X > X0 + m && Z > Z0 + m && X < X0 + S - m && Z < Z0 + S - m;
  // the kerb (fine): a KERB_W strip on the pavement's side of every tarmac edge a pavement shares (listed for both), its
  // top a line of points offset from the tarmac's (mitred at corners), fixed; its triangles the kerb's (kerbSet)
  const kerbSet = new Set(), kerbFrom = new Map(); // (kerbFrom: a kerb's top point -> its gutter's)
  if (fine) {
    const kinds2 = new Map(); for (const [a, b, k] of E) { const kk = Math.min(a, b) * 1e7 + Math.max(a, b); (kinds2.get(kk) || kinds2.set(kk, [a, b, 0]).get(kk))[2] |= 1 << k; }
    const KE = [...kinds2.values()].filter(([, , m]) => (m & (1 << KIND.tarmac)) && (m & (1 << KIND.pave))), nrmOf = new Map(), deg = new Map();
    for (const e of KE) { const [a, b] = e, dx = PX[b] - PX[a], dz = PZ[b] - PZ[a], l = Math.hypot(dx, dz) || 1; let nx = -dz / l, nz = dx / l; const mx = (PX[a] + PX[b]) / 2, mz = (PZ[a] + PZ[b]) / 2;
      if (classify(mx + nx * 3, mz + nz * 3) !== KIND.pave) { nx = -nx; nz = -nz; } e.push(nx, nz); // (towards the pavement)
      for (const v of [a, b]) { const q = nrmOf.get(v) || [0, 0, []]; q[0] += nx; q[1] += nz; q[2].push([nx, nz]); nrmOf.set(v, q); deg.set(v, (deg.get(v) || 0) + 1); } }
    const top = new Map(), W = KERB_W * 100, near = new Map(), nk = (x, z) => Math.floor(x / 400) * 1e6 + Math.floor(z / 400);
    for (let i = 0; i < PX.length; i++) { const k = nk(PX[i], PZ[i]); (near.get(k) || near.set(k, []).get(k)).push(i); }
    const egs = new Map(); for (const [a, b] of E) for (let i = Math.floor(Math.min(PX[a], PX[b]) / 400); i <= Math.floor(Math.max(PX[a], PX[b]) / 400); i++) for (let j = Math.floor(Math.min(PZ[a], PZ[b]) / 400); j <= Math.floor(Math.max(PZ[a], PZ[b]) / 400); j++) { const k = i * 1e6 + j; (egs.get(k) || egs.set(k, []).get(k)).push(a, b); }
    const o3 = (ax, az, bx, bz, cx, cz) => Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
    const crosses = (ax, az, bx, bz, skip) => { for (let i = Math.floor(Math.min(ax, bx) / 400); i <= Math.floor(Math.max(ax, bx) / 400); i++) for (let j = Math.floor(Math.min(az, bz) / 400); j <= Math.floor(Math.max(az, bz) / 400); j++) { const el = egs.get(i * 1e6 + j); if (!el) continue;
      for (let q = 0; q < el.length; q += 2) { const c = el[q], d = el[q + 1]; if (skip.has(c) || skip.has(d)) continue; if (o3(ax, az, bx, bz, PX[c], PZ[c]) * o3(ax, az, bx, bz, PX[d], PZ[d]) <= 0 && o3(PX[c], PZ[c], PX[d], PZ[d], ax, az) * o3(PX[c], PZ[c], PX[d], PZ[d], bx, bz) <= 0) return true; } } return false; };
    const cand = new Map(); // (each vertex's kerb-top point, if it lies clear inside the pavement, and a kerb's width or more in from the chunk's edge: nearer, its strip makes slivers against the edge)
    for (const [v, [sx, sz, ns]] of nrmOf) { const l = Math.hypot(sx, sz) || 1, dx = sx / l, dz = sz / l, c = Math.min(...ns.map(([nx, nz]) => nx * dx + nz * dz)); if (c < 0.35) continue; const d = W / c, x = Math.round(PX[v] + dx * d), z = Math.round(PZ[v] + dz * d);
      if (!inside(x, z, W) || classify(x, z) !== KIND.pave) continue; let ok = true; for (let i = Math.floor(x / 400) - 1; i <= Math.floor(x / 400) + 1 && ok; i++) for (let j = Math.floor(z / 400) - 1; j <= Math.floor(z / 400) + 1 && ok; j++) for (const p of near.get(i * 1e6 + j) || []) if (p !== v && Math.hypot(PX[p] - x, PZ[p] - z) < 3) { ok = false; break; }
      if (ok && !crosses(PX[v], PZ[v], x, z, new Set([v]))) cand.set(v, [x, z]); }
    const gut = (v) => R.base(PX[v] / 100, PZ[v] / 100, KIND.tarmac), steep = (a, b) => Math.abs(gut(a) - gut(b)) > KERB_GRADE * Math.hypot(PX[a] - PX[b], PZ[a] - PZ[b]) / 100; // (no kerb along a gutter steeper than any street: where two carriageways at different heights nearly meet, a wall's place)
    const kept = [], keptSegs = [], keptCross = (ax, az, bx, bz) => keptSegs.some(([cx, cz, dx, dz]) => o3(ax, az, bx, bz, cx, cz) * o3(ax, az, bx, bz, dx, dz) < 0 && o3(cx, cz, dx, dz, ax, az) * o3(cx, cz, dx, dz, bx, bz) < 0);
    for (const e of KE) { const [a, b] = e; if (!cand.has(a) || !cand.has(b)) continue; const [ax, az] = cand.get(a), [bx, bz] = cand.get(b); if (steep(a, b) || crosses(ax, az, bx, bz, NONE) || keptCross(ax, az, bx, bz)) continue; kept.push(e); keptSegs.push([ax, az, bx, bz]); }
    const deg2 = new Map(); for (const [a, b] of kept) for (const v of [a, b]) deg2.set(v, (deg2.get(v) || 0) + 1);
    for (const [v] of deg2) { const [x, z] = cand.get(v), o = add(x, z); kinds[o] |= 1 << KIND.pave; top.set(v, o); kerbFrom.set(o, v); kerbSet.add(v); kerbSet.add(o); }
    for (const [a, b] of kept) E.push([top.get(a), top.get(b), KIND.kerb]);
    for (const [v, n] of deg2) if (n === 1) E.push([v, top.get(v), KIND.kerb]); // (the strip's ends closed)
  }
  // near an outline (cm): its edges and points
  const C = 400, eg = new Map(), pg = new Map(), cell = (x, z) => Math.floor(x / C) * 1e6 + Math.floor(z / C);
  for (const [a, b] of E) for (let i = Math.floor(Math.min(PX[a], PX[b]) / C); i <= Math.floor(Math.max(PX[a], PX[b]) / C); i++) for (let j = Math.floor(Math.min(PZ[a], PZ[b]) / C); j <= Math.floor(Math.max(PZ[a], PZ[b]) / C); j++) { const k = i * 1e6 + j; (eg.get(k) || eg.set(k, []).get(k)).push(a, b); }
  const putP = (i) => { const k = cell(PX[i], PZ[i]); (pg.get(k) || pg.set(k, []).get(k)).push(i); }; for (let i = 0; i < PX.length; i++) putP(i);
  const segD = (x, z, a, b) => { const dx = PX[b] - PX[a], dz = PZ[b] - PZ[a], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - PX[a]) * dx + (z - PZ[a]) * dz) / L2)); return Math.hypot(x - PX[a] - dx * t, z - PZ[a] - dz * t); };
  const clear = (x, z, d) => { for (let i = Math.floor((x - d) / C); i <= Math.floor((x + d) / C); i++) for (let j = Math.floor((z - d) / C); j <= Math.floor((z + d) / C); j++) { const k = i * 1e6 + j, el = eg.get(k), pl = pg.get(k);
    if (el) for (let q = 0; q < el.length; q += 2) if (segD(x, z, el[q], el[q + 1]) < d) return false; if (pl) for (const p of pl) if (Math.hypot(PX[p] - x, PZ[p] - z) < d) return false; } return true; };
  const tarmacD = (x, z, max) => { let best = max; for (let i = Math.floor((x - max) / C); i <= Math.floor((x + max) / C); i++) for (let j = Math.floor((z - max) / C); j <= Math.floor((z + max) / C); j++) { const el = eg.get(i * 1e6 + j); if (!el) continue; for (let q = 0; q < el.length; q += 2) if ((kinds[el[q]] & (1 << KIND.tarmac)) && (kinds[el[q + 1]] & (1 << KIND.tarmac))) best = Math.min(best, segD(x, z, el[q], el[q + 1])); } return best; };
    let keep = null; const bis = []; // (coarse: which points are used; fine: the bends' bisectors, fixed soft)
  if (fine) {
    // the hi grid's points off the paved regions, clear of the outlines
    for (let j = 1; j < lat.nj - 1; j++) for (let i = 1; i < lat.ni - 1; i++) { const X = Math.round((grid.x0 + (lat.i0 + i) * grid.sp) * 100), Z = Math.round((grid.z0 + (lat.j0 + j) * grid.sp) * 100);
      if (inside(X, Z, 50) && classify(X, Z) === KIND.ground && clear(X, Z, CLEAR * 100)) putP(add(X, Z)); }
    // where the roads reshape the ground: a city's lots on a CITY_IN lattice; elsewhere the banks, on a BANK_STEP one
    const step = L.city ? CITY_IN : BANK_STEP;
    for (let x = L.x0 + step / 2; x < L.x0 + L.size; x += step) for (let z = L.z0 + step / 2; z < L.z0 + L.size; z += step) { const X = Math.round(x * 100), Z = Math.round(z * 100);
      if (!inside(X, Z, 50) || classify(X, Z) !== KIND.ground) continue; const gy = g(x, z), y = R.ground(x, z); if (Math.abs(y - gy) <= BANK_MIN) continue;
      if (clear(X, Z, (L.city ? 2 : 1.5) * 100)) putP(add(X, Z)); }
    // along each street's centre line, points every LANE_STEP m (every metre near a junction's circle): its carriageway's
    // triangles short strips across that one street, so its markings stop at the junction's mouth and nowhere else
    L.net.runs.forEach((r, ri) => { if (r.minor || r.off) return; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3], l = Math.hypot(bx - ax, bz - az);
      let dj0 = null, tSide = -Infinity; const ux = (bx - ax) / (l || 1), uz = (bz - az) / (l || 1);
      for (let t = 0; t < l;) { const x = ax + (bx - ax) * t / l, z = az + (bz - az) * t / l, X = Math.round(x * 100), Z = Math.round(z * 100); let step = LANE_STEP;
        const onT = inside(X, Z, 50) && classify(X, Z) === KIND.tarmac;
        // (at a bend: points across the carriageway on its bisector, the line between them fixed (soft), so no triangle
        // crosses it: each side takes its own segment's line (rules.js lineOn), and the two agree on it. Whichever street
        // is nearest there: a street meeting this one at its bend (no junction) mustn't take the bend's away)
        if (onT && t === 0 && s > 0 && !((R.junction(x, z) || [0, 99])[1] <= 0.3)) { const [nx, nz] = R.bends(r)[s], ch = Math.abs(nx * ux + nz * uz); if (ch < 0.99995 && ch > 0.5) { const chain = [];
            for (const v of [-(r.hw - 0.35), -r.hw / 2, 0, r.hw / 2, r.hw - 0.35]) { const o = v / ch, QX = Math.round((x - nz * o) * 100), QZ = Math.round((z + nx * o) * 100); if (!v) { if (key.has(X * 1e7 + Z) || clear(X, Z, 25)) { const i = add(X, Z); putP(i); chain.push(i); } else chain.push(-1); continue; } // (o along the bisector: v from either segment's line)
              if (inside(QX, QZ, 50) && classify(QX, QZ) === KIND.tarmac && (key.has(QX * 1e7 + QZ) || clear(QX, QZ, 25))) { const i = add(QX, QZ); putP(i); chain.push(i); } else chain.push(-1); }
            for (let q = 0; q + 1 < chain.length; q++) if (chain[q] >= 0 && chain[q + 1] >= 0) bis.push([chain[q], chain[q + 1]]); } }
        if (onT) { const rd = R.road(x, z); if (rd && rd.id === ri) { if (rd.dj < 6) step = 1; if (rd.dj > 0.3 && clear(X, Z, 60)) putP(add(X, Z));
          // (where it passes a crossing's edges, ZEBRA m from the junction's circle, and every LANE_STEP m: points across the
          // carriageway just inside its kerbs, so the crossing's triangles are this street's alone and none is a long
          // sliver along a kerb from one junction to the next)
          const edge = t - tSide >= LANE_STEP - 1e-6; if (edge) tSide = t;
          if (edge || (dj0 != null && ZEBRA.some((d) => (dj0 - d) * (rd.dj - d) <= 0))) for (const o of [-1, 1]) { const off = o * (r.hw - 0.35), qx = x - uz * off, qz = z + ux * off, QX = Math.round(qx * 100), QZ = Math.round(qz * 100);
            if (inside(QX, QZ, 50) && classify(QX, QZ) === KIND.tarmac && clear(QX, QZ, 25)) putP(add(QX, QZ)); }
          dj0 = rd.dj; } else dj0 = null; } else dj0 = null;
        t += step; } } });
    // along each railway's centre line on the ground and just inside its bed's edges, points every RAIL_STEP m: the bed
    // follows its solved profile between the outline's corners (the rails are laid on it, rails.js)
    L.net.runs.forEach((r) => { if (r.kind !== 'rail' || r.off) return; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3], l = Math.hypot(bx - ax, bz - az); if (l < 1e-3) continue; const ux = (bx - ax) / l, uz = (bz - az) / l;
      for (let t = 0; t < l; t += RAIL_STEP) for (const o of [0, -(r.hw - 0.3), r.hw - 0.3]) { const QX = Math.round((ax + ux * t - uz * o) * 100), QZ = Math.round((az + uz * t + ux * o) * 100);
        if (inside(QX, QZ, 50) && classify(QX, QZ) === KIND.ballast && (key.has(QX * 1e7 + QZ) || clear(QX, QZ, 25))) putP(add(QX, QZ)); } } });
  } else {
    // (with the bake's edge points only: inside, each road's stations, thinned as the outlines' points are below; their
    // regions by the rules, as a chunk's edge points without stored regions)
    if (pre) for (const r of L.net.runs) { if (r.off) continue; for (let q = 0; q < r.h.length; q++) { const X = Math.round(r.pts[q * 2] * 100), Z = Math.round(r.pts[q * 2 + 1] * 100); if (inside(X, Z, 50)) add(X, Z); } }
    keep = new Set(); const cells = new Set(), onB = (i) => PX[i] === X0 || PZ[i] === Z0 || PX[i] === X0 + S || PZ[i] === Z0 + S;
    for (let i = 0; i < PX.length; i++) { if (onB(i)) { keep.add(i); continue; } const k = Math.floor((PX[i] - X0) / (COARSE_CELL * 100)) * 4096 + Math.floor((PZ[i] - Z0) / (COARSE_CELL * 100)); if (!cells.has(k)) { cells.add(k); keep.add(i); } }
    for (let j = 1; j < lat.nj - 1; j++) for (let i = 1; i < lat.ni - 1; i++) { if ((lat.i0 + i) % 2 || (lat.j0 + j) % 2) continue; const X = Math.round((grid.x0 + (lat.i0 + i) * grid.sp) * 100), Z = Math.round((grid.z0 + (lat.j0 + j) * grid.sp) * 100); if (inside(X, Z, 50) && clear(X, Z, 100)) keep.add(add(X, Z)); }
  }
  const idxs = keep ? [...keep].sort((a, b) => a - b) : PX.map((_, i) => i), N = idxs.length, at = new Map(idxs.map((p, k) => [p, k]));
  // ---- heights: every one from the rules
  const X = new Float64Array(N), Z = new Float64Array(N), Y = new Float64Array(N), PY = new Float64Array(N);
  const kOf = new Map(idxs.map((p, k) => [p, k]));
  idxs.forEach((p, k) => {
    const x = PX[p] / 100, z = PZ[p] / 100, K = kinds[p]; X[k] = x; Z[k] = z;
    if (kerbFrom.has(p) && kOf.has(kerbFrom.get(p)) && kOf.get(kerbFrom.get(p)) < k) { const g = kOf.get(kerbFrom.get(p)); Y[k] = Y[g] + KERB; PY[k] = PY[g] + KERB * Math.min(1, KERB_W / PAVE_RAMP); return; } // (a kerb's top: its gutter's height, plus the kerb drawn; in physics the start of the ramp)
    let kind = K & (1 << KIND.tarmac) ? KIND.tarmac : K & (1 << KIND.ballast) ? KIND.ballast : K & ((1 << KIND.kerb) | (1 << KIND.pave)) ? KIND.pave : PAVED.find((q) => q !== KIND.lip && K & (1 << q)) ?? (K & (1 << KIND.lip) ? KIND.lip : null);
    if (kind == null && !(PX[p] === X0 || PZ[p] === Z0 || PX[p] === X0 + S || PZ[p] === Z0 + S)) kind = pre ? R.region(x, z) : classify(PX[p], PZ[p]); // (inside: its region)
    if (kind == null) { // (a point of the chunk's edge: its region by the rules (the nearest road's widths), not this chunk's polygons, so the chunk beside works it out the same)
      kind = R.region(x, z); } // (the outlines' own order, every road's widths)
    if (kind === KIND.ground && edgeH) { const cn = (PX[p] === X0 || PX[p] === X0 + S) && (PZ[p] === Z0 || PZ[p] === Z0 + S) ? (PX[p] === X0 ? 0 : 1) + (PZ[p] === Z0 ? 0 : 2) : -1;
      if (cn >= 0) { const h = edgeH.c?.[cn]; if (h != null) { Y[k] = PY[k] = h; return; } } else { const sd = PX[p] === X0 ? 'w' : PX[p] === X0 + S ? 'e' : null, H = sd && edgeH[sd], sz = PZ[p] === Z0 ? 's' : PZ[p] === Z0 + S ? 'n' : null, H2 = sz && edgeH[sz], at = (A, u) => { const f = u / (EDGE_STEP * 100), i = Math.min(A.length - 2, Math.floor(f)); return A[i] + (A[i + 1] - A[i]) * (f - i); };
      if (H) { Y[k] = PY[k] = at(H, PZ[p] - Z0); return; } if (H2) { Y[k] = PY[k] = at(H2, PX[p] - X0); return; } } } // (the layout's outer edge: today's terrain's; a corner, c: [x0 z0, x1 z0, x0 z1, x1 z1], today's where any chunk about it isn't the layout's, so all of those about it agree)
    if (kind === KIND.ground || kind === KIND.lip) { Y[k] = PY[k] = R.ground(x, z); return; } // (a portal's lip's rim: the ground's, held within the headwall, rules.js)
    Y[k] = R.drawn(x, z, kind);
    PY[k] = kind === KIND.pave && !(K & (1 << KIND.tarmac)) ? Y[k] - KERB * (1 - Math.min(1, tarmacD(PX[p], PZ[p], PAVE_RAMP * 100) / (PAVE_RAMP * 100))) : Y[k]; // (the slabs: physics ramps up to them from the carriageway's edge: a kerb is never physics)
  });
  // ---- the triangulation, the outlines (or, coarse, the chunk's edge) fixed
  const coords = new Float64Array(N * 2); for (let k = 0; k < N; k++) { coords[k * 2] = X[k]; coords[k * 2 + 1] = Z[k]; }
  const del = new Delaunator(coords), t1 = performance.now(), con = new Constrainautor(del), seen = new Set(); let fixed = 0, failed = 0;
  const onLine = (a, b) => (PX[a] === PX[b] && (PX[a] === X0 || PX[a] === X0 + S)) || (PZ[a] === PZ[b] && (PZ[a] === Z0 || PZ[a] === Z0 + S));
  let softMissed = 0, bendMissed = 0; const why = {}, failedAt = [], fix = (a, b, kind = 'edge') => { const u = at.get(a), v = at.get(b); if (u == null || v == null || u === v) return; const k = Math.min(u, v) * N + Math.max(u, v); if (seen.has(k)) return; seen.add(k); try { con.constrainOne(u, v); fixed++; } catch (err) { if (kind === 'kerb') { softMissed++; return; } if (kind === 'bend') { bendMissed++; return; } failed++; if (failedAt.length < 4) failedAt.push([X[u], Z[u], X[v], Z[v]]); const w = kind + ': ' + String(err.message || err).slice(0, 30); why[w] = (why[w] || 0) + 1; } }; // (a kerb's top line is soft: where it can't be fixed (it would cross another), the strip there is the triangulation's)
  for (const side of [(i) => PZ[i] === Z0, (i) => PZ[i] === Z0 + S, (i) => PX[i] === X0, (i) => PX[i] === X0 + S]) { const s = idxs.filter(side).sort((a, b) => PX[a] - PX[b] || PZ[a] - PZ[b]); for (let q = 0; q + 1 < s.length; q++) fix(s[q], s[q + 1]); }
  if (fine) { for (const [a, b, k] of E) if (!onLine(a, b) && k !== KIND.kerb) fix(a, b, 'outline'); for (const [a, b, k] of E) if (k === KIND.kerb) fix(a, b, 'kerb'); for (const [a, b] of bis) fix(a, b, 'bend'); } // (the outlines first: a kerb never stands in one's way)
  const t2 = performance.now(), T = del.triangles, nt = T.length / 3;
  // ---- each triangle: its kind (its middle's region), wound to face up; sorted by kind (one draw group each)
  // (the region's the same across every edge that isn't fixed (the outlines are): one middle classified per patch, spread
  // to its neighbours; each triangle's own middle if any fixed edge failed)
  const tkind = new Uint8Array(nt), cls = (t) => { const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2]; return classify((X[a] + X[b] + X[c]) / 3 * 100, (Z[a] + Z[b] + Z[c]) / 3 * 100); };
  if (fine && !failed && !softMissed) { const done = new Uint8Array(nt), H = del.halfedges, st = []; for (let t0 = 0; t0 < nt; t0++) { if (done[t0]) continue; const k = cls(t0); done[t0] = 1; tkind[t0] = k; st.push(t0);
    while (st.length) { const t = st.pop(); for (let e = t * 3; e < t * 3 + 3; e++) { const o = H[e]; if (o < 0 || con.isConstrained(e)) continue; const u = (o / 3) | 0; if (!done[u]) { done[u] = 1; tkind[u] = k; st.push(u); } } } } }
  else if (fine) for (let t = 0; t < nt; t++) tkind[t] = cls(t);
  for (let t = 0; t < nt; t++) { if (!fine) continue; const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2]; if (tkind[t] === KIND.pave && kerbSet.has(idxs[a]) && kerbSet.has(idxs[b]) && kerbSet.has(idxs[c]) && tarmacD(Math.round((X[a] + X[b] + X[c]) / 3 * 100), Math.round((Z[a] + Z[b] + Z[c]) / 3 * 100), 50) <= (KERB_W + 0.02) * 100) tkind[t] = KIND.kerb; if (tkind[t] === KIND.tarmac && (Y[a] !== PY[a] || Y[b] !== PY[b] || Y[c] !== PY[c])) tkind[t] = KIND.pave; } // (the kerb's strip: by the carriageway's edge)
  const order = Array.from({ length: nt }, (_, t) => t).sort((a, b) => tkind[a] - tkind[b] || a - b), idx = new Uint32Array(nt * 3), tk = new Uint8Array(nt);
  order.forEach((t, q) => { const a = T[t * 3]; let b = T[t * 3 + 1], c = T[t * 3 + 2]; if ((Z[c] - Z[a]) * (X[b] - X[a]) - (X[c] - X[a]) * (Z[b] - Z[a]) > 0) { const s = b; b = c; c = s; } idx[q * 3] = a; idx[q * 3 + 1] = b; idx[q * 3 + 2] = c; tk[q] = tkind[t]; }); // (the normal's y is minus that)
  const pos = new Float32Array(N * 3), phys = new Float32Array(N), nrm = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) { pos[k * 3] = X[k]; pos[k * 3 + 1] = Y[k]; pos[k * 3 + 2] = Z[k]; phys[k] = PY[k]; }
  for (let q = 0; q < nt; q++) { const a = idx[q * 3], b = idx[q * 3 + 1], c = idx[q * 3 + 2], ux = X[b] - X[a], uy = Y[b] - Y[a], uz = Z[b] - Z[a], vx = X[c] - X[a], vy = Y[c] - Y[a], vz = Z[c] - Z[a]; const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; for (const v of [a, b, c]) { nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz; } }
  for (let k = 0; k < N; k++) { const l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]) || 1; nrm[k * 3] /= l; nrm[k * 3 + 1] /= l; nrm[k * 3 + 2] /= l; }
  // ---- the streets' triangles (carriageway, kerb, pavement) on their own, each given its middle's street as one line:
  // every corner's along and across from that line (so they interpolate exactly: markings on the centre line, slabs along
  // the kerb), and how far along the street from its nearest mouth onto a junction, linear too (a crossing's band square
  // across; below 0 inside the junction, where nothing is painted). rib = { pos, nrm, road (u, v, hw, dj), lane, kind, id }
  const rib = { pos: [], nrm: [], road: [], lane: [], kind: [], id: [] }, JN = L.net.junctions;
  // a street's mouths: where its centre line crosses a junction's circle, [how far along it, +1 if it leaves the circle going on, -1 if it enters]
  const mouths = new Map(), mouthsOf = (ri) => { let M = mouths.get(ri); if (M) return M; M = []; const r = L.net.runs[ri];
    for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-3) continue; const ux = dx / l, uz = dz / l;
      for (const J of JN) { if (J.lx) continue; const fx = ax - J.x, fz = az - J.z; if (Math.abs(fx) > l + J.r || Math.abs(fz) > l + J.r) continue; const b = fx * ux + fz * uz, disc = b * b - (fx * fx + fz * fz - J.r * J.r); if (disc <= 0) continue;
        for (const sg of [-1, 1]) { const t = -b + sg * Math.sqrt(disc); if (t >= 0 && t < l) M.push([r.s[s] + t, sg, ax + ux * t, az + uz * t, ux, uz]); } } }
    mouths.set(ri, M); return M; };
  if (fine) for (let q = 0; q < nt; q++) { const k = tk[q]; if (!RIBBON.has(k)) continue; const vs = [idx[q * 3], idx[q * 3 + 1], idx[q * 3 + 2]], cx = (X[vs[0]] + X[vs[1]] + X[vs[2]]) / 3, cz = (Z[vs[0]] + Z[vs[1]] + Z[vs[2]]) / 3;
    const rc = R.road(cx, cz); if (!rc) continue; const ln = R.lineOn(rc.id, cx, cz); if (!ln) continue;
    const along = (x, z) => ln.u0 + (x - ln.ax) * ln.dx + (z - ln.az) * ln.dz, across = (x, z) => ln.dx * (z - ln.az) - ln.dz * (x - ln.ax), uc = along(cx, cz);
    // (the junction: the street's mouth nearest along it to one of its corners (a long thin triangle reaching a mouth:
    // that one); the distance from it linear along the line, so a crossing's band is square across and the markings
    // stop at its edge. Inside the circle it's below 0: nothing painted)
    // (within MOUTH_D of the mouth, the distance is along the mouth's own segment, not the street's length: where the
    // street bends in its crossing's band (a village's streets), the band stays square across)
    const us = vs.map((v) => along(X[v], Z[v])); let um = 0, sg = 0, bd = Infinity, mo = null; for (const M of mouthsOf(rc.id)) for (const u of us) if (Math.abs(u - M[0]) < bd) { bd = Math.abs(u - M[0]); um = M[0]; sg = M[1]; mo = M; }
    const near = sg && Math.min(...us.map((u) => sg * (u - um))) < MOUTH_D;
    vs.forEach((v, q) => { const u = us[q]; rib.pos.push(X[v], Y[v], Z[v]); rib.nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]); rib.road.push(u, across(X[v], Z[v]), ln.hw, !sg ? 99 : near ? sg * ((X[v] - mo[2]) * mo[4] + (Z[v] - mo[3]) * mo[5]) : sg * (u - um)); rib.lane.push(Math.min(15, ln.lanes) + (ln.oneway ? 16 : 0) + (painted(L.net.runs[rc.id], L.city) ? 32 : 0) + (zebra(L.net.runs[rc.id], L.city) ? 64 : 0)); rib.kind.push(k); rib.id.push(rc.id); }); }
  // the gravel (fine): its triangles on their own too, each given the track nearest its middle as one line (its corners'
  // along and across from it: the material's two wheel ruts and grassy crown, as today's tracks, roadSurface.js
  // pathMaterial); a gravel plaza's (no track there) its world x, z, half width 1e4 (no edge). road = (along, across, half width, -)
  const track = (r) => r.minor && (r.surf === 2 || r.kind === 'track');
  if (fine) for (let q = 0; q < nt; q++) { if (tk[q] !== KIND.gravel) continue; const vs = [idx[q * 3], idx[q * 3 + 1], idx[q * 3 + 2]], cx = (X[vs[0]] + X[vs[1]] + X[vs[2]]) / 3, cz = (Z[vs[0]] + Z[vs[1]] + Z[vs[2]]) / 3;
    const n = R.nearest(cx, cz, track), on = n && n.d <= 0.5;
    for (const v of vs) { rib.pos.push(X[v], Y[v], Z[v]); rib.nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]); rib.road.push(on ? n.u + (X[v] - n.px) * n.dx + (Z[v] - n.pz) * n.dz : X[v], on ? n.dx * (Z[v] - n.pz) - n.dz * (X[v] - n.px) : Z[v], on ? n.r.hw : 1e4, 99); rib.lane.push(0); rib.kind.push(KIND.gravel); rib.id.push(on ? n.ri : 0xffffffff); } }
  // the ground's paving (a city's lots): its squares along the street nearest each triangle's middle (an angle a
  // triangle, within a right angle: one across a triangle, or the squares swirl; runtime.js gives its corners their own copies)
  const ang = new Float32Array(nt); if (fine && L.city) for (let q = 0; q < nt; q++) { if (tk[q] > KIND.bank) continue; const a = idx[q * 3], b = idx[q * 3 + 1], c = idx[q * 3 + 2], n = R.nearest((X[a] + X[b] + X[c]) / 3, (Z[a] + Z[b] + Z[c]) / 3, (r) => !r.minor); if (n) { const t = Math.atan2(n.dz, n.dx), h = Math.PI / 2; ang[q] = ((t % h) + h) % h; } }
  let area = 0; for (let q = 0; q < nt; q++) { const a = idx[q * 3], b = idx[q * 3 + 1], c = idx[q * 3 + 2]; area += Math.abs((X[b] - X[a]) * (Z[c] - Z[a]) - (X[c] - X[a]) * (Z[b] - Z[a])) / 2; }
  const F32 = (a) => Float32Array.from(a);
  return { level, pos, phys, nrm, idx, tk, ang, rib: { pos: F32(rib.pos), nrm: F32(rib.nrm), road: F32(rib.road), lane: F32(rib.lane), kind: Uint8Array.from(rib.kind), id: Uint32Array.from(rib.id) },
    stats: { edge: fine ? edgeOf(O, X0, Z0) : null, points: N, tris: nt, fixed, failed, failedAt, regionArea: O.area, why, softMissed, bendMissed, covered: area / (L.size * L.size), outlineMs: tOut, delaunayMs: t1 - t0, constrainMs: t2 - t1, totalMs: performance.now() - t0 } };
}

// a chunk's edge points from its outlines (fine): Int32Array x, z (cm), regions (format.js eg), but not those every
// EDGE_STEP m in no region (the coarse level adds them as the fine does, the rules giving their region alike); and back,
// as outlines with no edges
const edgeOf = (O, X0, Z0) => { const e = []; for (const [i, m] of O.edgeBits) { const [X, Z] = O.P[i]; if (!m && (X - X0) % (EDGE_STEP * 100) === 0 && (Z - Z0) % (EDGE_STEP * 100) === 0) continue; e.push(X, Z, m); } return Int32Array.from(e); };
const edgeOnly = (e) => { const P = [], edgeBits = new Map(); for (let o = 0; o < e.length; o += 3) { edgeBits.set(P.length, e[o + 2]); P.push([e[o], e[o + 1]]); } return { P, E: [], edgeBits, area: null }; };

// physics lookup over a fine mesh: a grid of CELL-metre cells listing the triangles touching each
const CELL = 4;
export function physIndex(L, m) {
  const nc = Math.ceil(L.size / CELL), cnt = new Uint32Array(nc * nc + 1), P = m.pos, I = m.idx, nt = I.length / 3, box = (q) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let r = 0; r < 3; r++) { const v = I[q * 3 + r]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
    const c = (v, o) => Math.max(0, Math.min(nc - 1, Math.floor((v - o) / CELL))); return [c(x0, L.x0), c(x1, L.x0), c(z0, L.z0), c(z1, L.z0)]; };
  for (let q = 0; q < nt; q++) { if (m.tk[q] === KIND.lip) continue; const [a, b, c, d] = box(q); for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) cnt[j * nc + i + 1]++; } // (a portal's lip: no surface)
  for (let k = 1; k < cnt.length; k++) cnt[k] += cnt[k - 1];
  const list = new Uint32Array(cnt[nc * nc]), fill = cnt.slice(0, nc * nc);
  for (let q = 0; q < nt; q++) { if (m.tk[q] === KIND.lip) continue; const [a, b, c, d] = box(q); for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) list[fill[j * nc + i]++] = q; }
  return { nc, start: cnt, list };
}
// the physics height at (x, z) on a chunk's fine mesh (NaN outside it); out (optional): [triangle, nx, ny, nz]
export function physAt(L, m, ix, x, z, out) {
  const fx = (x - L.x0) / CELL, fz = (z - L.z0) / CELL; if (!(fx >= 0 && fz >= 0 && fx < ix.nc && fz < ix.nc)) return NaN;
  const k = Math.floor(fz) * ix.nc + Math.floor(fx), P = m.pos, I = m.idx, Y = m.phys;
  for (let s = ix.start[k]; s < ix.start[k + 1]; s++) {
    const q = ix.list[s], a = I[q * 3], b = I[q * 3 + 1], c = I[q * 3 + 2], ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (d === 0) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2, E = -1e-7;
    if (l1 < E || l2 < E || l3 < E) continue;
    if (out) { const ux = bx - ax, uy = Y[b] - Y[a], uz = bz - az, vx = cx - ax, vy = Y[c] - Y[a], vz = cz - az; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; out[0] = q; out[1] = nx / l; out[2] = ny / l; out[3] = nz / l; }
    return l1 * Y[a] + l2 * Y[b] + l3 * Y[c];
  }
  return NaN;
}
