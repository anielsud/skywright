// The road layout's outlines (#294): a chunk's paved regions, worked out from its stored network (format.js) by rules
// (each road's strip: its half width; a city street's pavement; a country road's verge; the ways off the street
// network; the plazas), the same in the bake (its check) and in the game (mesh.js, in a worker). Integer centimetres,
// Clipper (vendor/layout/clipper1.mjs). Deterministic: the same network gives the same points and edges, and two
// chunks side by side, which store the same roads near their shared edge, the same points along it.
//   chunkOutlines(net, areas, L) -> { P: [[X, Z], ...] (cm), E: [[a, b, kind], ...] (an edge two regions share: once for each) }
import CL from '../../vendor/layout/clipper1.mjs';
import { KIND } from './format.js';
import { VERGE } from './rules.js';

const ARC = 15, EDGE_STEP = 4, CLIP = 25; // (CLIP: m about the chunk a road's stretches are kept: past a road's widest reach, its half width and pavement) // (ARC: cm a round join's arc may cut inside; EDGE_STEP: m between the chunk's edge points)
const cm = (v) => Math.round(v * 100);

export function chunkOutlines(net, areas, L) {
  const runs = net.runs, X0 = cm(L.x0), Z0 = cm(L.z0), S = cm(L.size);
  const off = (rings, d, open = true) => { const co = new CL.ClipperOffset(2, ARC); co.AddPaths(toC(rings), CL.JoinType.jtRound, open ? CL.EndType.etOpenRound : CL.EndType.etClosedPolygon); const s = new CL.Paths(); co.Execute(s, d); return fromC(s); };
  const union = (...ps) => bool(CL.ClipType.ctUnion, ps.flat(), null), minus = (a, ...bs) => (bs.length ? bool(CL.ClipType.ctDifference, a, union(...bs)) : a), inter = (a, b) => bool(CL.ClipType.ctIntersection, a, b);
  // (each road as its shape's segments that come within CLIP of the chunk, each offset on its own: a segment's strip is a
  // capsule of its two stored points alone, so two chunks get the same edges, and the same points where they cross, about
  // their shared edge; what's past CLIP can't reach into the chunk)
  const cx0 = L.x0 - CLIP, cz0 = L.z0 - CLIP, cx1 = L.x0 + L.size + CLIP, cz1 = L.z0 + L.size + CLIP;
  const segs = (r) => { const out = [], P = r.shape; for (let i = 0; i + 1 < P.length / 2; i++) { const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
      if (Math.max(ax, bx) < cx0 || Math.min(ax, bx) > cx1 || Math.max(az, bz) < cz0 || Math.min(az, bz) > cz1) continue; out.push([[cm(ax), cm(az)], [cm(bx), cm(bz)]]); } return out; };
  // (and each capsule given a point where it crosses a chunk line, worked out from it alone, before anything is unioned: the
  // union keeps it (collinear points kept), so the chunks either side cut their outlines at the same points)
  const strips = (filter, width) => { const out = []; for (const r of runs) if (filter(r)) { const d = width(r); if (d > 0) { const ls = segs(r); for (const seg of ls) out.push(...splitAtGrid(off([seg], cm(d)), S)); } } return out; }; // (each capsule offset alone: an offset of several unions them, the rounding again depending on which)
  const minorKind = (r) => (!r.minor ? -1 : r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const area = (surf) => splitAtGrid(areas.filter((a) => a.surf === surf).map((a) => a.ring), S);
  const street = (r) => !r.minor;
  const Tc = union(strips(street, (r) => r.hw)), Pv = union(strips((r) => r.pave > 0, (r) => r.hw + r.pave)), Vg = union(strips((r) => !r.minor && !r.pave, (r) => r.hw + VERGE));
  const Ta = union(strips((r) => minorKind(r) === KIND.alley, (r) => r.hw), area(0)), Tp = union(strips((r) => minorKind(r) === KIND.pavers, (r) => r.hw), area(1)), Tg = union(strips((r) => minorKind(r) === KIND.gravel, (r) => r.hw), area(2));
  const Pall = minus(Pv, Tc); // (the kerb: mesh.js, along every tarmac edge a pavement shares)
  const REG = [[KIND.tarmac, Tc], [KIND.pave, Pall], [KIND.alley, minus(Ta, Tc, Pall)], [KIND.pavers, minus(Tp, Tc, Pall, Ta)], [KIND.gravel, minus(Tg, Tc, Pall, Ta, Tp)], [KIND.verge, minus(Vg, Tc, Pall, Ta, Tp, Tg).filter((p) => Math.abs(ringArea(p)) > 5000)]]; // (no verge slivers under 0.5 m²)
  // the chunk's: clipped to it (each region split where it crosses a chunk line first: neighbours clip the same points)
  const box = [[[X0, Z0], [X0 + S, Z0], [X0 + S, Z0 + S], [X0, Z0 + S]]];
  const key = new Map(), P = []; const add = (X, Z) => { X = Math.max(X0, Math.min(X0 + S, X)); Z = Math.max(Z0, Math.min(Z0 + S, Z)); const k = X * 1e7 + Z; let i = key.get(k); if (i == null) { i = P.length; key.set(k, i); P.push([X, Z]); } return i; };
  let E = []; for (const [k, Ps] of REG) for (const p of inter(splitAtGrid(Ps, S), box)) { if (p.length < 3) continue; for (let q = 0; q < p.length; q++) { const a = add(p[q][0], p[q][1]), b = add(p[(q + 1) % p.length][0], p[(q + 1) % p.length][1]); if (a !== b) E.push([a, b, k]); } }
  for (let s = 0; s <= S; s += EDGE_STEP * 100) for (const [X, Z] of [[X0 + s, Z0], [X0 + s, Z0 + S], [X0, Z0 + s], [X0 + S, Z0 + s]]) add(X, Z);
  // edges split at the points that lie on them (Clipper's rounded crossings; the chunk's edge points), and where two cross
  const split = () => { const PI = pointIndex(P), out = [], seen = new Set();
    for (const [a, b, k] of E) { const chain = [a, ...PI.onSegment(a, b, 1.01), b]; for (let q = 0; q + 1 < chain.length; q++) { const u = chain[q], v = chain[q + 1]; if (u === v) continue; const kk = (u < v ? u * 1e7 + v : v * 1e7 + u) * 16 + k; if (!seen.has(kk)) { seen.add(kk); out.push([u, v, k]); } } }
    E = out; };
  split(); for (let pass = 0; pass < 4; pass++) { if (!crossings(P, E, add)) break; split(); }
  return { P, E };
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
    add(Math.round(A[0] + (B[0] - A[0]) * t), Math.round(A[1] + (B[1] - A[1]) * t)); n++;
  }
  return n;
}

// Clipper (rings of [x, z] integer centimetres in, and out)
const toC = (rings) => rings.map((r) => r.map(([X, Z]) => ({ X, Y: Z }))), fromC = (P) => P.map((r) => r.map((p) => [p.X, p.Y]));
function bool(type, a, b) { const c = new CL.Clipper(); c.PreserveCollinear = true; c.AddPaths(toC(a), CL.PolyType.ptSubject, true); if (b?.length) c.AddPaths(toC(b), CL.PolyType.ptClip, true); const s = new CL.Paths(); c.Execute(type, s, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero); return fromC(s); }
function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; } return a / 2; }
