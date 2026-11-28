// The road layout's outlines (#294): a chunk's paved regions, worked out from its stored network (format.js) by rules
// (each road's strip: its half width; a city street's pavement; a country road's verge; the ways off the street
// network; the plazas), the same in the bake (its check) and in the game (mesh.js, in a worker). Integer centimetres,
// Clipper (vendor/layout/clipper1.mjs). Deterministic: the same network gives the same points and edges, and two
// chunks side by side, which store the same roads near their shared edge, the same points along it.
//   chunkOutlines(net, areas, L) -> { P: [[X, Z], ...] (cm), E: [[a, b, kind], ...] (an edge two regions share: once for each) }
import CL from '../../vendor/layout/clipper1.mjs';
import { KIND } from './format.js';
import { vergeW, portalsOf, streetOverBed, HOLD, PORTAL_T, PORTAL_BEHIND as BEHIND, TRENCH_W, BOX_L } from './rules.js';

const LX_N = 64, ARC = 15, EDGE_STEP = 4, CLIP = 25, SNAP = 50; // (CLIP: m about the chunk a road's stretches are kept: past a road's widest reach, its half width and pavement) // (ARC: cm a round join's arc may cut inside; EDGE_STEP: m between the chunk's edge points)
const cm = (v) => Math.round(v * 100);

export function chunkOutlines(net, areas, L) {
  const runs = net.runs.filter((r) => !r.off), X0 = cm(L.x0), Z0 = cm(L.z0), S = cm(L.size); // (a bridge's deck, a tunnel's tube: not the ground's, roads.js draws them)
  // where a road stops at a deck or a tube it stops square (each of its capsules near there cut by a box past the end); a
  // tunnel's portal: the lip, the headwall's back half across it, is an opening (no surface: the tube's mouth). The box's
  // near corners at a portal are the lip's own, so the carriageway's end and the lip's front are one line
  const portals = portalsOf(net.runs), corner = (x, z, ux, uz, a, v) => [cm(x + ux * a - uz * v), cm(z + uz * a + ux * v)]; // (a point a along, v across, from (x, z) facing (ux, uz))
  const cutsOf = (r) => { const P = r.shape, n = P.length / 2, out = []; for (const end of ['A', 'B']) { const c = r['cut' + end]; if (!c || n < 2) continue; const i = end === 'A' ? 0 : n - 1, j = end === 'A' ? 1 : n - 2, x = P[i * 2], z = P[i * 2 + 1];
      const pt = c === 'tube' ? portals.find((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6) : null, l = Math.hypot(x - P[j * 2], z - P[j * 2 + 1]) || 1;
      out.push({ x, z, ux: pt ? pt.dx : (x - P[j * 2]) / l, uz: pt ? pt.dz : (z - P[j * 2 + 1]) / l, wb: pt ? pt.W : 0 }); } return out; };
  const cutBox = (c, d) => { const wb = c.wb || d + 0.5; return [[corner(c.x, c.z, c.ux, c.uz, 0, -wb), corner(c.x, c.z, c.ux, c.uz, d + 1, -wb), corner(c.x, c.z, c.ux, c.uz, d + 1, wb), corner(c.x, c.z, c.ux, c.uz, 0, wb)]]; };
  const off = (rings, d, open = true) => { const co = new CL.ClipperOffset(2, ARC); co.AddPaths(toC(rings), CL.JoinType.jtRound, open ? CL.EndType.etOpenRound : CL.EndType.etClosedPolygon); const s = new CL.Paths(); co.Execute(s, d); return fromC(s); };
  const union = (...ps) => bool(CL.ClipType.ctUnion, ps.flat(), null), minus = (a, ...bs) => (a.length && bs.some((b) => b.length) ? bool(CL.ClipType.ctDifference, a, bs.flat()) : a), inter = (a, b) => bool(CL.ClipType.ctIntersection, a, b); // (minus: the cut's rings as they are, not unioned first: nonzero filling covers their overlaps)
  // (each road as its shape's segments that come within CLIP of the chunk, each offset on its own: a segment's strip is a
  // capsule of its two stored points alone, so two chunks get the same edges, and the same points where they cross, about
  // their shared edge; what's past CLIP can't reach into the chunk)
  const cx0 = L.x0 - CLIP, cz0 = L.z0 - CLIP, cx1 = L.x0 + L.size + CLIP, cz1 = L.z0 + L.size + CLIP;
  const segs = (r) => { const out = [], P = r.shape; for (let i = 0; i + 1 < P.length / 2; i++) { const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
      if (Math.max(ax, bx) < cx0 || Math.min(ax, bx) > cx1 || Math.max(az, bz) < cz0 || Math.min(az, bz) > cz1) continue; out.push([[cm(ax), cm(az)], [cm(bx), cm(bz)]]); } return out; };
  // (and each capsule given a point where it crosses a chunk line, worked out from it alone, before anything is unioned: the
  // union keeps it (collinear points kept), so the chunks either side cut their outlines at the same points)
  const capEdge = []; // (a railway's capsules' own points on a chunk line: where two tracks' beds just touch, the union keeps one there on one side only)
  const strips = (filter, width, keepEdge = false) => { const out = []; for (const r of runs) if (filter(r)) { const d = width(r); if (d > 0) { const ls = segs(r), cuts = r.cutA || r.cutB ? cutsOf(r) : [];
    for (const seg of ls) { let cap = off([seg], cm(d)); for (const c of cuts) if (segDist(seg, cm(c.x), cm(c.z)) < cm(d + 1)) cap = bool(CL.ClipType.ctDifference, cap, cutBox(c, d)); const sp = splitAtGrid(cap, S); if (keepEdge) for (const q of sp) for (const [X, Z] of q) if ((X === X0 || X === X0 + S) ? Z >= Z0 && Z <= Z0 + S : (Z === Z0 || Z === Z0 + S) && X >= X0 && X <= X0 + S) capEdge.push([X, Z]); out.push(...sp); } } } return out; }; // (each capsule offset alone: an offset of several unions them, the rounding again depending on which)
  const minorKind = (r) => (!r.minor ? -1 : r.kind === 'rail' ? KIND.ballast : r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const area = (surf) => splitAtGrid(areas.filter((a) => a.surf === surf).map((a) => a.ring), S);
  const street = (r) => !r.minor;
  // (a railway's bed over a street's carriageway where the two overlap, but at a level crossing (inside its circle,
  // junctions[].lx): there the carriageway over the bed. So a street beside a railway is cut back to its bed's edge, and
  // the rails lie on their own bed, not on the street at its height)
  const behind = portals.filter((p) => p.rail && p.x > cx0 && p.x < cx1 && p.z > cz0 && p.z < cz1).map((p) => [corner(p.x, p.z, p.dx, p.dz, 0, -p.W), corner(p.x, p.z, p.dx, p.dz, BEHIND, -p.W), corner(p.x, p.z, p.dx, p.dz, BEHIND, p.W), corner(p.x, p.z, p.dx, p.dz, 0, p.W)]);
  const B0 = minus(union(strips((r) => minorKind(r) === KIND.ballast, (r) => r.hw, true)), ...(behind.length ? [behind] : []));
  const sob = B0.length ? streetOverBed(net) : { lx: [], ends: [] }, lxs = [...sob.lx.filter((J) => J.x > cx0 - J.r && J.x < cx1 + J.r && J.z > cz0 - J.r && J.z < cz1 + J.r).map((J) => { const o = []; for (let q = 0; q < LX_N; q++) o.push([cm(J.x + J.r * Math.cos(q * 2 * Math.PI / LX_N)), cm(J.z + J.r * Math.sin(q * 2 * Math.PI / LX_N))]); return o; }),
    ...sob.ends.filter((c) => c.x > cx0 - HOLD && c.x < cx1 + HOLD && c.z > cz0 - HOLD && c.z < cz1 + HOLD).map((c) => [corner(c.x, c.z, c.dx, c.dz, 0, -c.w), corner(c.x, c.z, c.dx, c.dz, -HOLD, -c.w), corner(c.x, c.z, c.dx, c.dz, -HOLD, c.w), corner(c.x, c.z, c.dx, c.dz, 0, c.w)])];
  const Tc = minus(union(strips(street, (r) => r.hw)), minus(B0, lxs)), Pv = union(strips((r) => r.pave > 0, (r) => r.hw + r.pave)), Vg = union(strips((r) => vergeW(r) > 0, (r) => r.hw + vergeW(r)));
  const Ta = union(strips((r) => minorKind(r) === KIND.alley, (r) => r.hw), area(0)), Tp = union(strips((r) => minorKind(r) === KIND.pavers, (r) => r.hw), area(1)), Tg = union(strips((r) => minorKind(r) === KIND.gravel, (r) => r.hw), area(2));
  // (a railway's bed: under a road's carriageway at a level crossing, over everything else; never into the hill behind a
  // portal (a tunnel's other tracks, sharing its tube, stop at its mouth: their beds' round ends))
  const Tb = minus(B0, Tc);
  const Pall = minus(Pv, Tc, Tb); // (the kerb: mesh.js, along every tarmac edge a pavement shares)
  const lipOf = (pf) => union(portals.filter((p) => pf(p) && p.x > cx0 && p.x < cx1 && p.z > cz0 && p.z < cz1).map((p) => [corner(p.x, p.z, p.dx, p.dz, 0, -p.W), corner(p.x, p.z, p.dx, p.dz, PORTAL_T / 2, -p.W), corner(p.x, p.z, p.dx, p.dz, PORTAL_T / 2, p.W), corner(p.x, p.z, p.dx, p.dz, 0, p.W)])), Lp = lipOf((p) => !p.tr), Lt = lipOf((p) => p.tr); /* (a trench's portal: its lip through a carriageway beside too, under the headwall's wing) */
  const REG = [[KIND.tarmac, Tc], [KIND.ballast, Tb], [KIND.pave, Pall], [KIND.alley, minus(Ta, Tc, Tb, Pall)], [KIND.pavers, minus(Tp, Tc, Tb, Pall, Ta)], [KIND.gravel, minus(Tg, Tc, Tb, Pall, Ta, Tp)], [KIND.verge, minus(Vg, Tc, Tb, Pall, Ta, Tp, Tg).filter((p) => Math.abs(ringArea(p)) > 5000)]]; // (no verge slivers under 0.5 m²)
  // (a trench's walls' strips (rules.js trenchOf): openings like the lip, through everything, a carriageway beside too: the wall stands there)
  const near = (p, m) => p.x > cx0 - m && p.x < cx1 + m && p.z > cz0 - m && p.z < cz1 + m, boxOf = (q) => [corner(q.x, q.z, q.dx, q.dz, q.tr ? q.tr.u0 : -BOX_L, -q.hwT), corner(q.x, q.z, q.dx, q.dz, 0, -q.hwT), corner(q.x, q.z, q.dx, q.dz, 0, q.hwT), corner(q.x, q.z, q.dx, q.dz, q.tr ? q.tr.u0 : -BOX_L, q.hwT)];
  const ccw = (q) => (ringArea(q) < 0 ? q.reverse() : q);
  const Wl = union(...portals.filter((p) => p.tr && near(p, 60)).map((p) => { const W = [-1, 1].map((sd) => ccw([corner(p.x, p.z, p.dx, p.dz, p.tr.u0, sd * p.hwT), corner(p.x, p.z, p.dx, p.dz, p.tr.u1, sd * p.hwT), corner(p.x, p.z, p.dx, p.dz, p.tr.u1, sd * (p.hwT + TRENCH_W)), corner(p.x, p.z, p.dx, p.dz, p.tr.u0, sd * (p.hwT + TRENCH_W))]));
    const B = portals.filter((q) => q !== p && (q.x !== p.x || q.z !== p.z) && near(q, 120)).map((q) => ccw(boxOf(q))); return B.length ? minus(W, B) : W; })); /* (not where another portal's approach runs: rules.js otherBox) */
  if (Lp.length || Lt.length || Wl.length) { const Lq = union(minus(Lp, Tc), Lt, Wl); for (const e of REG) e[1] = minus(e[1], Lq); REG.unshift([KIND.lip, Lq]); } // (not over a carriageway: another road's beside the portal, a twin tube's) // (a portal's lip: an opening through everything)
  // the chunk's: clipped to it (each region split where it crosses a chunk line first: neighbours clip the same points)
  const box = [[[X0, Z0], [X0 + S, Z0], [X0 + S, Z0 + S], [X0, Z0 + S]]];
  const key = new Map(), P = []; const add = (X, Z) => { X = Math.max(X0, Math.min(X0 + S, X)); Z = Math.max(Z0, Math.min(Z0 + S, Z)); const k = X * 1e7 + Z; let i = key.get(k); if (i == null) { i = P.length; key.set(k, i); P.push([X, Z]); } return i; };
  // (Clipper's intersection with the box can move a vertex lying on the chunk's edge by a centimetre, differently on
  // either side: each vertex it gives on the edge is put back on the region's own point there, the same for both chunks)
  const onEdge = (X, Z) => X === X0 || X === X0 + S || Z === Z0 || Z === Z0 + S;
  const pre = [], regionArea = {}; let E = []; for (const [k, Ps] of REG) { const sp = splitAtGrid(Ps, S), own = new Map(); pre.push([k, sp]); for (const r of sp) for (const [X, Z] of r) { if (X === X0 || X === X0 + S) own.set('x' + X + ',' + Z, [X, Z]); if (Z === Z0 || Z === Z0 + S) own.set('z' + Z + ',' + X, [X, Z]); }
    const isOwn = ([X, Z]) => ((X === X0 || X === X0 + S) && Z >= Z0 && Z <= Z0 + S && own.has('x' + X + ',' + Z)) || ((Z === Z0 || Z === Z0 + S) && own.has('z' + Z + ',' + X)) || ((X === X0 || X === X0 + S) && (Z === Z0 || Z === Z0 + S));
    const snap = ([X, Z]) => { if (!onEdge(X, Z) || ((X === X0 || X === X0 + S) && (Z === Z0 || Z === Z0 + S))) return [X, Z]; for (let d = 0; d <= SNAP; d++) for (const s of d ? [d, -d] : [0]) { const o = X === X0 || X === X0 + S ? own.get('x' + X + ',' + (Z + s)) : own.get('z' + Z + ',' + (X + s)); if (o) return o; } return [X, Z]; };
    for (const p0 of inter(sp, box)) { if (p0.length < 3) continue; regionArea[k] = (regionArea[k] || 0) + ringArea(p0) / 1e4; const p = p0.map(snap).filter((q) => !onEdge(q[0], q[1]) || isOwn(q)); if (p.length < 3) continue; /* (a vertex Clipper puts on the chunk's edge that is no region's own point there, where an edge of a ring runs within a centimetre of the line without crossing it: not the chunk beside's, dropped; its ring's edge is the ring's own again) */ for (let q = 0; q < p.length; q++) { const a = add(p[q][0], p[q][1]), b = add(p[(q + 1) % p.length][0], p[(q + 1) % p.length][1]); if (a !== b) E.push([a, b, k]); } } }
  for (let s = 0; s <= S; s += EDGE_STEP * 100) for (const [X, Z] of [[X0 + s, Z0], [X0 + s, Z0 + S], [X0, Z0 + s], [X0 + S, Z0 + s]]) add(X, Z);
  // edges split at the points that lie on them (Clipper's rounded crossings; the chunk's edge points), and where two cross
  const onLine = (a, b) => (P[a][0] === P[b][0] && (P[a][0] === X0 || P[a][0] === X0 + S)) || (P[a][1] === P[b][1] && (P[a][1] === Z0 || P[a][1] === Z0 + S));
  // (a point on the chunk's edge splits only an edge along it: one reaching the line 1 cm from it would be split there on
  // one side only)
  // (an edge a region has twice, two of its rings touching along it, is no edge of it: kept once it would turn the inside
  // out for every point whose ray crosses it (classify, even-odd); so an edge is kept only if a region has it an odd number of times)
  const split = () => { const PI = pointIndex(P), out = [], n = new Map();
    for (const [a, b, k] of E) { const along = onLine(a, b), chain = [a, ...PI.onSegment(a, b, 1.01).filter((i) => along || !onEdge(P[i][0], P[i][1])), b]; for (let q = 0; q + 1 < chain.length; q++) { const u = chain[q], v = chain[q + 1]; if (u === v) continue; const kk = (u < v ? u * 1e7 + v : v * 1e7 + u) * 16 + k; if (!n.has(kk)) out.push([u, v, k, kk]); n.set(kk, (n.get(kk) || 0) + 1); } }
    E = out.filter((e) => n.get(e[3]) % 2).map(([u, v, k]) => [u, v, k]); };
  // (and every point the regions have on the chunk's edge, used by this side's polygons or not: the chunk beside has them too)
  for (const [, sp] of pre) for (const r of sp) for (const [X, Z] of r) if (onEdge(X, Z) && X >= X0 && X <= X0 + S && Z >= Z0 && Z <= Z0 + S) add(X, Z);
  for (const [X, Z] of capEdge) add(X, Z);
  for (const r of runs) for (const c of r.cutA || r.cutB ? cutsOf(r) : []) { const X = cm(c.x), Z = cm(c.z); if (X > X0 && Z > Z0 && X < X0 + S && Z < Z0 + S) add(X, Z); } // (where a road stops at a deck or tube: its end a point of its own, mesh.js)
  split(); for (let pass = 0; pass < 4; pass++) { if (!crossings(P, E, add)) break; split(); }
  // the regions a point on the chunk's edge is in (a bit per kind): from the regions before they're clipped to the chunk,
  // which both chunks have alike (on a region's edge or corner counts as in), not from this side's polygons
  const edgeBits = new Map(), ins = pre.map(([k, sp]) => [k, ringsIndex(sp)]);
  P.forEach(([X, Z], i) => { if (!onEdge(X, Z)) return; let m = 0; for (const [k, ix] of ins) if (ix.has(X, Z)) m |= 1 << k; edgeBits.set(i, m); });
  return { P, E, edgeBits, area: regionArea }; // (area: m², each region's in the chunk: a check on the meshing)
}

// rings with a vertex wherever they cross a chunk line (x or z a multiple of S cm), at a crossing worked out the
// same way whichever chunk asks: neighbours clip the same points
function splitAtGrid(paths, S) {
  const out = [];
  for (const p of paths) { const q = [];
    for (let k = 0; k < p.length; k++) { const [ax, az] = p[k], [bx, bz] = p[(k + 1) % p.length]; q.push([ax, az]);
      const [lx, lz, hx, hz] = ax < bx || (ax === bx && az < bz) ? [ax, az, bx, bz] : [bx, bz, ax, az], cuts = [];
      for (let X = Math.ceil(Math.min(ax, bx) / S) * S; X < Math.max(ax, bx); X += S) if (X > Math.min(ax, bx)) cuts.push([X, Math.round(lz + (hz - lz) * (X - lx) / (hx - lx))]);
      for (let Z = Math.ceil(Math.min(az, bz) / S) * S; Z < Math.max(az, bz); Z += S) if (Z > Math.min(az, bz)) cuts.push([Math.round(lx + (hx - lx) * (Z - lz) / (hz - lz)), Z]);
      cuts.sort((u, v) => Math.hypot(u[0] - ax, u[1] - az) - Math.hypot(v[0] - ax, v[1] - az)); for (const [x, z] of cuts) q.push([x, z]); }
    out.push(q); }
  return out;
}

// a set of rings (cm): has(X, Z): the point is on one of their edges or inside them (even-odd)
function ringsIndex(rings) {
  const RW = 200, rows = new Map();
  for (const p of rings) for (let k = 0; k < p.length; k++) { const [ax, az] = p[k], [bx, bz] = p[(k + 1) % p.length]; for (let r = Math.floor(Math.min(az, bz) / RW); r <= Math.floor(Math.max(az, bz) / RW); r++) (rows.get(r) || rows.set(r, []).get(r)).push([ax, az, bx, bz]); }
  return { has(X, Z) { let c = false; for (const [ax, az, bx, bz] of rows.get(Math.floor(Z / RW)) || []) {
    if ((bx - ax) * (Z - az) - (bz - az) * (X - ax) === 0 && X >= Math.min(ax, bx) && X <= Math.max(ax, bx) && Z >= Math.min(az, bz) && Z <= Math.max(az, bz)) return true;
    if ((az > Z) !== (bz > Z) && X < ax + (bx - ax) * (Z - az) / (bz - az)) c = !c; } return c; } };
}
// points near a point or lying on a segment (cm)
function pointIndex(P) {
  const C = 400, g = new Map(); P.forEach(([x, z], i) => { const k = Math.floor(x / C) * 1e6 + Math.floor(z / C); (g.get(k) || g.set(k, []).get(k)).push(i); });
  const near = (x0, z0, x1, z1) => { const out = []; for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) out.push(...(g.get(i * 1e6 + j) || [])); return out; };
  return {
    clear(X, Z, d) { for (const i of near(X - d, Z - d, X + d, Z + d)) if (Math.hypot(P[i][0] - X, P[i][1] - Z) < d) return false; return true; },
    onSegment(a, b, tol) { const [ax, az] = P[a], [bx, bz] = P[b], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; if (!L2) return []; const on = [];
      for (const i of near(Math.min(ax, bx) - tol, Math.min(az, bz) - tol, Math.max(ax, bx) + tol, Math.max(az, bz) + tol)) { if (i === a || i === b) continue; const t = ((P[i][0] - ax) * dx + (P[i][1] - az) * dz) / L2; if (t <= 0 || t >= 1) continue; if (Math.hypot(P[i][0] - ax - dx * t, P[i][1] - az - dz * t) <= tol) on.push([t, i]); }
      return on.sort((u, v) => u[0] - v[0]).map((u) => u[1]); },
  };
}

// edges that cross (properly, away from their ends): a point added at each crossing (rounded to the centimetre);
// returns how many (the caller splits the edges at the points now lying on them)
function crossings(P, E, add) {
  const C = 400, g = new Map(); E.forEach(([a, b], e) => { const [ax, az] = P[a], [bx, bz] = P[b]; for (let i = Math.floor(Math.min(ax, bx) / C); i <= Math.floor(Math.max(ax, bx) / C); i++) for (let j = Math.floor(Math.min(az, bz) / C); j <= Math.floor(Math.max(az, bz) / C); j++) { const k = i * 1e6 + j; (g.get(k) || g.set(k, []).get(k)).push(e); } });
  const seen = new Set(), o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); let n = 0;
  for (const list of g.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const e = list[i], f = list[j], k = e < f ? e * 1e7 + f : f * 1e7 + e; if (seen.has(k)) continue; seen.add(k);
    const [a, b] = E[e], [c, d] = E[f]; if (a === c || a === d || b === c || b === d) continue;
    const A = P[a], B = P[b], Cp = P[c], D = P[d]; if (o(A, B, Cp) * o(A, B, D) >= 0 || o(Cp, D, A) * o(Cp, D, B) >= 0) continue;
    const den = (B[0] - A[0]) * (D[1] - Cp[1]) - (B[1] - A[1]) * (D[0] - Cp[0]), t = ((Cp[0] - A[0]) * (D[1] - Cp[1]) - (Cp[1] - A[1]) * (D[0] - Cp[0])) / den;
    add(Math.round(A[0] + (B[0] - A[0]) * t), Math.round(A[1] + (B[1] - A[1]) * t), true); n++; // (exact: snapped to a corner near it, the two edges would still cross)
  }
  return n;
}

// Clipper (rings of [x, z] integer centimetres in, and out)
const toC = (rings) => rings.map((r) => r.map(([X, Z]) => ({ X, Y: Z }))), fromC = (P) => P.map((r) => r.map((p) => [p.X, p.Y]));
function bool(type, a, b) { const c = new CL.Clipper(); c.PreserveCollinear = true; c.AddPaths(toC(a), CL.PolyType.ptSubject, true); if (b?.length) c.AddPaths(toC(b), CL.PolyType.ptClip, true); const s = new CL.Paths(); c.Execute(type, s, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero); return fromC(s); }
function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; } return a / 2; }

// distance (cm) from a point to a segment [[ax, az], [bx, bz]] (cm)
function segDist([[ax, az], [bx, bz]], X, Z) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((X - ax) * dx + (Z - az) * dz) / L2)); return Math.hypot(X - ax - dx * t, Z - az - dz * t); }
