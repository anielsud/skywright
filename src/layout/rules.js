// The road layout's height rules (#294): every height of a chunk's surface comes from these, given its solved network
// (the roads' stations with their heights; the junctions' planes) and the natural ground. The bake and the game run
// the same code on the same (stored, quantized) data, so nothing but the outlines and the network is stored.
//   base(x, z, k)  the road surface under a point of a paved region of kind k (format.js KIND), before the kerb
//   drawn(x, z, k) what's drawn there: base, plus the kerb's 15 cm on a pavement
//   ground(x, z)   the ground off the paved regions: a city's lots at their pavements' top (blended between the two
//                  nearest streets, out to CITY_REACH), else the banks: from each road's outer edge a set slope to the
//                  natural ground (FILL, CUT; steeper on a steep hillside)
//   road(x, z)     the nearest street's coordinates for the markings: { id, u, v, hw, lanes, oneway, dj }
import { KIND } from './format.js';

export const LOT_PAIR = 40, KERB = 0.15, KERB_W = 0.1, PAVE_RAMP = 2, BANK_MAX = 40, CITY_REACH = 36, JBLEND = 6, SBLEND = 3;
// the banks (country roads): from a road's outer edge a fill falls at FILL (1:1.5) and a cutting rises at CUT (1:1) to the
// natural ground; where the hillside itself is steeper (the valley walls' switchbacks), BANK_STEEP x its slope (a rock
// cut), at most BANK_TOP; a bank that hasn't met the ground within BANK_MAX m stops there (a retaining wall's place)
export const FILL = 0.67, CUT = 1, BANK_STEEP = 1.25, BANK_TOP = 3;
// the verge (a road with no pavement): a strip of gravel along its edge, no kerb; none along the ways off the street network
export const vergeW = (r) => (r.minor || r.pave ? 0 : r.kind === 'highway' ? 1.5 : r.kind === 'main' ? 1 : 0.6);
// whether a street's carriageway is painted (lane and centre lines): a city's, a main road, or one wide enough for two
// lanes (5.5 m); its junctions' zebras: a city's streets and a village's (with a pavement)
export const painted = (r, city) => !r.minor && (city || r.kind === 'highway' || r.kind === 'main' || r.hw >= 2.75);
export const zebra = (r, city) => !r.minor && (city || r.pave > 0);
const SC = 10, PAD = 54; // (grid cell, m; how far from a road its segments are found: the bake stores every road within more than this of a chunk, bake.js NET_PAD, so two chunks work out their shared edge alike)

// net: { runs: [{ pts: Float64Array x,z,..., h: Float64Array, hw, pave, kind, minor, surf, lanes, oneway }], junctions: [{ x, z, r, y0, gx, gz }] }
// g(x, z): the natural ground; city: a city's lots
export function makeRules(net, g, city) {
  const runs = net.runs, JN = net.junctions;
  for (const r of runs) { const n = r.h.length; r.s = new Float64Array(n); for (let i = 1; i < n; i++) r.s[i] = r.s[i - 1] + Math.hypot(r.pts[i * 2] - r.pts[i * 2 - 2], r.pts[i * 2 + 1] - r.pts[i * 2 - 1]); }
  const segIdx = new Map(), key = (i, j) => i * 100003 + j;
  runs.forEach((r, ri) => { for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3];
    for (let i = Math.floor((Math.min(ax, bx) - PAD) / SC); i <= Math.floor((Math.max(ax, bx) + PAD) / SC); i++) for (let j = Math.floor((Math.min(az, bz) - PAD) / SC); j <= Math.floor((Math.max(az, bz) + PAD) / SC); j++) { const k = key(i, j); (segIdx.get(k) || segIdx.set(k, []).get(k)).push(ri, s); } } });
  const street = (r) => !r.minor, any = () => true;
  // the nearest road (filter ok) to (x, z): its distance past its tarmac's edge d, height h there, u along, v across
  const nearest = (x, z, ok) => { let best = null; const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return null;
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri]; if (!ok(r)) continue; const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz) - r.hw;
      if (!best || d < best.d) best = { ri, r, d, h: r.h[s] + (r.h[s + 1] - r.h[s]) * t, u: r.s[s] + (r.s[s + 1] - r.s[s]) * t, v: (dx * (z - az) - dz * (x - ax)) / Math.sqrt(L2), px, pz, dx: dx / Math.sqrt(L2), dz: dz / Math.sqrt(L2) }; }
    return best; };
  // the two nearest (different) roads (filter ok), by distance past their pavements' edge
  const nearest2 = (x, z, ok) => { const best = []; const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return best;
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri]; if (!ok(r)) continue; const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t) - r.hw - (r.pave || 0), n = { ri, d, h: r.h[s] + (r.h[s + 1] - r.h[s]) * t };
      const k = best.findIndex((b) => b.ri === ri); if (k >= 0) { if (d < best[k].d) best[k] = n; } else best.push(n); }
    return best.sort((a, b) => a.d - b.d).slice(0, 2); };
  const jGrid = new Map(); JN.forEach((J, q) => { for (let i = Math.floor((J.x - J.r - JBLEND) / SC); i <= Math.floor((J.x + J.r + JBLEND) / SC); i++) for (let j = Math.floor((J.z - J.r - JBLEND) / SC); j <= Math.floor((J.z + J.r + JBLEND) / SC); j++) { const k = key(i, j); (jGrid.get(k) || jGrid.set(k, []).get(k)).push(q); } });
  // the nearest junction within JBLEND of its circle: [junction, distance past its circle]
  const junction = (x, z) => { let best = null, bd = Infinity; for (const q of jGrid.get(key(Math.floor(x / SC), Math.floor(z / SC))) || []) { const J = JN[q], d = Math.hypot(x - J.x, z - J.z) - J.r; if (d < JBLEND && d < bd) { bd = d; best = J; } } return best ? [best, bd] : null; };
  // the street surface at (x, z) given its street's height h there: a junction's plane inside it, blending into the street's
  // (where junctions' circles overlap or nearly: their planes blended by how far inside each the point is, so the surface
  // doesn't step where one stops being the nearest)
  const streetH = (x, z, h) => { let sw = 0, sp = 0, dmin = Infinity; for (const q of jGrid.get(key(Math.floor(x / SC), Math.floor(z / SC))) || []) { const J = JN[q], d = Math.hypot(x - J.x, z - J.z) - J.r; if (d >= JBLEND) continue; const u = (JBLEND - d) / JBLEND, wt = u * u; sw += wt; sp += wt * (J.y0 + J.gx * (x - J.x) + J.gz * (z - J.z)); if (d < dmin) dmin = d; }
    if (!sw) return h; const ph = sp / sw; if (dmin <= 0) return ph; const t = dmin / JBLEND, w = t * t * (3 - 2 * t); return ph + (h - ph) * w; };
  // the streets' height at (x, z) away from a junction: every street segment within SBLEND of the nearest (by distance past
  // its tarmac's edge) blended, each weighted down to nothing as it falls SBLEND behind. Per segment, not per road: a
  // segment's distance and height change smoothly, so the blend does too, wherever streets (or a road's own two sides of a
  // sharp bend) meet, and whichever way the roads are split into ways
  const blended = (x, z) => { const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return null; const c = []; let dmin = Infinity;
    for (let q = 0; q < L.length; q += 2) { const r = runs[L[q]], s = L[q + 1]; if (r.minor) continue; const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t) - r.hw; c.push(d, r.h[s] + (r.h[s + 1] - r.h[s]) * t); if (d < dmin) dmin = d; }
    let sw = 0, sh = 0; for (let q = 0; q < c.length; q += 2) { const u = 1 - (c[q] - dmin) / SBLEND; if (u <= 0) continue; const wt = u * u * (3 - 2 * u); sw += wt; sh += wt * c[q + 1]; } return sw ? sh / sw : null; };
  const minorKind = (k) => k === KIND.alley || k === KIND.pavers || k === KIND.gravel;
  const base = (x, z, k) => {
    const n = nearest(x, z, minorKind(k) ? any : street) || nearest(x, z, any); if (!n) return g(x, z);
    if (minorKind(k) && n.d > 0) { const f = Math.min(1, n.d / 20); return n.h + (g(x, z) - n.h) * f; } // (a plaza's middle, away from its ways: towards the ground)
    if (n.r.minor) return n.h;
    return streetH(x, z, blended(x, z));
  };
  const drawn = (x, z, k) => base(x, z, k) + (k === KIND.pave || k === KIND.kerb ? KERB : 0);
  const lot = (x, z) => { const two = nearest2(x, z, (r) => !r.minor && r.pave).filter((n, i) => i === 0 || n.d <= LOT_PAIR); if (!two.length) return null; /* (the second only if it's near: past that, which it is depends on how far the stored network reaches) */ let s = 0, ws = 0; for (const n of two) { const wt = 1 / Math.max(0.5, n.d); s += (streetH(x, z, n.h) + KERB) * wt; ws += wt; } return { y: s / ws, d: two[0].d }; };
  // the banks: every road within reach bounds the ground, a fill from below (lo) and a cutting from above (hi), each from its
  // outer edge (pavement or verge) at its slope; the ground is the natural ground held between them (so two roads' banks,
  // a switchback's legs, meet without a step). Where two roads' banks disagree (a wall's place): the nearer road's.
  const slopeAt = (x, z) => Math.hypot(g(x + 2, z) - g(x - 2, z), g(x, z + 2) - g(x, z - 2)) / 4;
  const banks = (x, z, gz) => { const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return gz; const per = new Map();
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri], ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz) - r.hw - (r.pave || vergeW(r)), b = per.get(ri);
      if (d <= BANK_MAX && (!b || d < b.d)) per.set(ri, { r, d: Math.max(0, d), h: r.h[s] + (r.h[s + 1] - r.h[s]) * t, px, pz }); }
    if (!per.size) return gz; let lo = -Infinity, hi = Infinity, nb = null;
    for (const b of per.values()) { const y = (b.r.minor ? b.h : streetH(b.px, b.pz, b.h)) + (b.r.pave ? KERB : 0), sl = BANK_STEEP * slopeAt(b.px, b.pz), kf = Math.min(BANK_TOP, Math.max(FILL, sl)), kc = Math.min(BANK_TOP, Math.max(CUT, sl));
      b.lo = y - kf * b.d; b.hi = y + kc * b.d; lo = Math.max(lo, b.lo); hi = Math.min(hi, b.hi); if (!nb || b.d < nb.d) nb = b; }
    if (lo > hi) { lo = nb.lo; hi = nb.hi; } return Math.min(hi, Math.max(lo, gz)); };
  const ground = (x, z) => { const gz = g(x, z); if (city) { const l = lot(x, z); if (l && l.d <= CITY_REACH) return l.y; } return banks(x, z, gz); };
  // the markings' coordinates: the nearest street, and how far its point is from the nearest junction's circle
  const road = (x, z) => { const n = nearest(x, z, street); if (!n) return null; const j = junction(n.px, n.pz); return { id: n.ri, u: n.u, v: n.v, hw: n.r.hw, lanes: n.r.lanes, oneway: n.r.oneway, dj: j ? j[1] : 99 }; };
  // a point's coordinates on a given road (the one its triangle was given): along, across, and from the nearest junction's circle
  const roadOn = (ri, x, z) => { const r = runs[ri]; let best = null; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz); if (!best || d < best.d) best = { d, u: r.s[s] + (r.s[s + 1] - r.s[s]) * t, v: (dx * (z - az) - dz * (x - ax)) / Math.sqrt(L2), px, pz }; }
    const j = junction(best.px, best.pz); return { id: ri, u: best.u, v: best.v, hw: r.hw, lanes: r.lanes, oneway: r.oneway, dj: j ? j[1] : 99 }; };
  // road ri's segment nearest (x, z), as a line: a point on it (ax, az) where it's u0 along the road, its direction (dx, dz).
  // Along and across it are linear in position, so a triangle's corners given them from one line interpolate exactly
  // A segment's own stretch ends at the bisectors of its bends (bends(r): each segment's start and end planes), so the
  // triangles either side of a bend's bisector (mesh.js puts points on it) take the two segments' lines, and the across
  // coordinate agrees on it; a point off every stretch (past a road's end) takes the nearest segment.
  const lineOn = (ri, x, z) => { const r = runs[ri], B = bends(r); let best = null, near = null; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz; if (L2 < 1e-6) continue;
      const l = Math.sqrt(L2), q = ((x - ax) * dx + (z - az) * dz) / L2, t = Math.max(0, Math.min(1, q)), d = Math.hypot(x - ax - dx * t, z - az - dz * t), c = { d, ax, az, dx: dx / l, dz: dz / l, u0: r.s[s] };
      if (!near || d < near.d) near = c;
      const [sx, sz, ex, ez] = B[s]; if ((x - ax) * sx + (z - az) * sz >= 0 && (x - ax - dx) * ex + (z - az - dz) * ez < 0) { c.d = Math.abs((dx * (z - az) - dz * (x - ax)) / l); if (!best || c.d < best.d) best = c; } }
    if (!best || best.d > near.d + 0.01) best = near; return best && // (a stretch's planes are half-spaces: one far along a road that doubles back can hold the point too)
      { ...best, hw: r.hw, lanes: r.lanes, oneway: r.oneway }; };
  // per segment of a road: its stretch's start and end planes' normals (sx, sz, ex, ez): along it at its ends, the
  // bisector's at a bend (the two directions' sum)
  const bendCache = new Map(), bends = (r) => { let B = bendCache.get(r); if (B) return B; const n = r.h.length, D = [];
    for (let s = 0; s + 1 < n; s++) { const dx = r.pts[s * 2 + 2] - r.pts[s * 2], dz = r.pts[s * 2 + 3] - r.pts[s * 2 + 1], l = Math.hypot(dx, dz); D.push(l < 1e-3 ? null : [dx / l, dz / l]); }
    const prev = (s) => { for (let k = s - 1; k >= 0; k--) if (D[k]) return D[k]; return null; }, next = (s) => { for (let k = s + 1; k < D.length; k++) if (D[k]) return D[k]; return null; };
    const mid = (a, b) => { const x = a[0] + b[0], z = a[1] + b[1], l = Math.hypot(x, z); return l < 1e-3 ? b : [x / l, z / l]; };
    B = D.map((d, s) => { if (!d) return [0, 0, 0, 0]; const pv = prev(s), nx = next(s), a = pv ? mid(pv, d) : d, b = nx ? mid(d, nx) : d; return [a[0], a[1], b[0], b[1]]; }); bendCache.set(r, B); return B; };
  // the paved region a point is in, by the outlines' own order (outline.js): a street's carriageway, its pavement, an
  // alley, pavers, gravel, a verge; else the ground (a carriageway's edge, to 3 cm: its outline's points round to the
  // centimetre). For the chunk's edge points: both chunks beside it agree.
  const mk = (r) => (r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const region = (x, z) => { const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return KIND.ground; let best = KIND.ground, rank = 99;
    const RANK = { [KIND.tarmac]: 0, [KIND.pave]: 1, [KIND.alley]: 2, [KIND.pavers]: 3, [KIND.gravel]: 4, [KIND.verge]: 5 };
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri], ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t) - r.hw;
      const k = d <= (r.minor ? 0 : 0.03) ? (r.minor ? mk(r) : KIND.tarmac) : !r.minor && r.pave && d <= r.pave ? KIND.pave : d <= vergeW(r) ? KIND.verge : null;
      if (k != null && RANK[k] < rank) { rank = RANK[k]; best = k; } }
    return best; };
  return { base, drawn, ground, road, roadOn, lineOn, bends, nearest, nearest2, lot, junction, region };
}

// the natural ground from the hi grid's points around a chunk (lat: i0, j0, ni, nj; G their heights): bilinear, as the
// World's (realworld.js sampleH)
export function latticeGround(grid, lat, G) {
  return (x, z) => { const fx = (x - grid.x0) / grid.sp - lat.i0, fz = (z - grid.z0) / grid.sp - lat.j0, i = Math.max(0, Math.min(lat.ni - 2, Math.floor(fx))), j = Math.max(0, Math.min(lat.nj - 2, Math.floor(fz))), u = fx - i, v = fz - j, k = j * lat.ni + i;
    return (G[k] * (1 - u) + G[k + 1] * u) * (1 - v) + (G[k + lat.ni] * (1 - u) + G[k + lat.ni + 1] * u) * v; };
}
