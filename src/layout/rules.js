// The road layout's height rules (#294): every height of a chunk's surface comes from these, given its solved network
// (the roads' stations with their heights; the junctions' planes) and the natural ground. The bake and the game run
// the same code on the same (stored, quantized) data, so nothing but the outlines and the network is stored.
//   base(x, z, k)  the road surface under a point of a paved region of kind k (format.js KIND), before the kerb
//   drawn(x, z, k) what's drawn there: base, plus the kerb's 15 cm on a pavement
//   ground(x, z)   the ground off the paved regions: a city's lots at their pavements' top (blended between the two
//                  nearest streets, out to CITY_REACH), else from the paved edge a 1:2 slope to the natural ground
//   road(x, z)     the nearest street's coordinates for the markings: { id, u, v, hw, lanes, oneway, dj }
import { KIND } from './format.js';

export const KERB = 0.15, KERB_W = 0.1, PAVE_RAMP = 2, SLOPE = 0.5, BANK_MAX = 30, CITY_REACH = 36, JBLEND = 6, SBLEND = 3, VERGE = 1.5;
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
      if (!best || d < best.d) best = { ri, r, d, h: r.h[s] + (r.h[s + 1] - r.h[s]) * t, u: r.s[s] + (r.s[s + 1] - r.s[s]) * t, v: (dx * (z - az) - dz * (x - ax)) / Math.sqrt(L2), px, pz }; }
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
  const streetH = (x, z, h) => { const j = junction(x, z); if (!j) return h; const [J, d] = j, ph = J.y0 + J.gx * (x - J.x) + J.gz * (z - J.z); if (d <= 0) return ph; const t = d / JBLEND, w = t * t * (3 - 2 * t); return ph + (h - ph) * w; };
  const minorKind = (k) => k === KIND.alley || k === KIND.pavers || k === KIND.gravel;
  const base = (x, z, k) => {
    const n = nearest(x, z, minorKind(k) ? any : street) || nearest(x, z, any); if (!n) return g(x, z);
    if (minorKind(k) && n.d > 0) { const f = Math.min(1, n.d / 20); return n.h + (g(x, z) - n.h) * f; } // (a plaza's middle, away from its ways: towards the ground)
    if (n.r.minor) return n.h;
    const two = nearest2(x, z, street); let hh = n.h; // (where two streets meet away from a junction: blended across the line between them)
    if (two.length === 2 && two[1].d - two[0].d < SBLEND) { const t = (two[1].d - two[0].d) / SBLEND, w = 0.5 + 0.5 * t * t * (3 - 2 * t); hh = two[0].h * w + two[1].h * (1 - w); }
    return streetH(x, z, hh);
  };
  const drawn = (x, z, k) => base(x, z, k) + (k === KIND.pave || k === KIND.kerb ? KERB : 0);
  const lot = (x, z) => { const two = nearest2(x, z, (r) => !r.minor && r.pave); if (!two.length) return null; let s = 0, ws = 0; for (const n of two) { const wt = 1 / Math.max(0.5, n.d); s += (streetH(x, z, n.h) + KERB) * wt; ws += wt; } return { y: s / ws, d: two[0].d }; };
  const edge = (x, z) => { const n = nearest(x, z, any); if (!n) return null; return { y: (n.r.minor ? n.h : streetH(x, z, n.h)) + (n.r.pave ? KERB : 0), d: Math.max(0, n.d - (n.r.pave || (n.r.minor ? 0 : VERGE))) }; };
  const ground = (x, z) => { const gz = g(x, z); if (city) { const l = lot(x, z); if (l && l.d <= CITY_REACH) return l.y; } const e = edge(x, z); if (!e || e.d > BANK_MAX) return gz; return e.y > gz ? Math.max(gz, e.y - SLOPE * e.d) : Math.min(gz, e.y + SLOPE * e.d); };
  // the markings' coordinates: the nearest street, and how far its point is from the nearest junction's circle
  const road = (x, z) => { const n = nearest(x, z, street); if (!n) return null; const j = junction(n.px, n.pz); return { id: n.ri, u: n.u, v: n.v, hw: n.r.hw, lanes: n.r.lanes, oneway: n.r.oneway, dj: j ? j[1] : 99 }; };
  // a point's coordinates on a given road (the one its triangle was given): along, across, and from the nearest junction's circle
  const roadOn = (ri, x, z) => { const r = runs[ri]; let best = null; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz); if (!best || d < best.d) best = { d, u: r.s[s] + (r.s[s + 1] - r.s[s]) * t, v: (dx * (z - az) - dz * (x - ax)) / Math.sqrt(L2), px, pz }; }
    const j = junction(best.px, best.pz); return { id: ri, u: best.u, v: best.v, hw: r.hw, lanes: r.lanes, oneway: r.oneway, dj: j ? j[1] : 99 }; };
  return { base, drawn, ground, road, roadOn, nearest };
}

// the natural ground from the hi grid's points around a chunk (lat: i0, j0, ni, nj; G their heights): bilinear, as the
// World's (realworld.js sampleH)
export function latticeGround(grid, lat, G) {
  return (x, z) => { const fx = (x - grid.x0) / grid.sp - lat.i0, fz = (z - grid.z0) / grid.sp - lat.j0, i = Math.max(0, Math.min(lat.ni - 2, Math.floor(fx))), j = Math.max(0, Math.min(lat.nj - 2, Math.floor(fz))), u = fx - i, v = fz - j, k = j * lat.ni + i;
    return (G[k] * (1 - u) + G[k + 1] * u) * (1 - v) + (G[k + lat.ni] * (1 - u) + G[k + lat.ni + 1] * u) * v; };
}
