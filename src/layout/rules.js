// The road layout's height rules (#294): every height of a chunk's surface comes from these, given its solved network
// (the roads' stations with their heights; the junctions' planes) and the natural ground. The bake and the game run
// the same code on the same (stored, quantized) data, so nothing but the outlines and the network is stored.
//   base(x, z, k)  the road surface under a point of a paved region of kind k (format.js KIND), before the kerb
//   drawn(x, z, k) what's drawn there: base, plus the kerb's 15 cm on a pavement
//   ground(x, z)   the ground off the paved regions: a city's lots at their pavements' top (blended between the two
//                  nearest streets, out to CITY_REACH), else the banks: from each road's outer edge a set slope to the
//                  natural ground (FILL, CUT; steeper on a steep hillside)
//   road(x, z)     the nearest street's coordinates for the markings: { id, u, v, hw, lanes, oneway, dj }
// A railway (kind 'rail', a way off the street network) is a bed of ballast (KIND.ballast) level across at its own height,
// with banks as a road's; where it crosses a road on the ground (a level crossing, junctions[].lx) both lie on the
// crossing's plane, so neither steps where the other's surface begins.
import { KIND } from './format.js';

export const LOT_PAIR = 40, KERB = 0.15, KERB_W = 0.1, PAVE_RAMP = 2, BANK_MAX = 40, CITY_REACH = 36, JBLEND = 6, SBLEND = 3;
// the banks (country roads): from a road's outer edge a fill falls at FILL (1:1.5) and a cutting rises at CUT (1:1) to the
// natural ground; where the hillside itself is steeper (the valley walls' switchbacks), BANK_STEEP x its slope (a rock
// cut), at most BANK_TOP; a bank that hasn't met the ground within BANK_MAX m stops there (a retaining wall's place)
export const FILL = 0.67, CUT = 1, BANK_STEEP = 1.25, BANK_TOP = 3;
// the shore (a coastal road, the world's water level wl): a bank never fills into the water (the sea bed under it stays as
// it is) nor cuts dry ground below it; on dry ground a fill rises at most SHORE_K x the ground's height above the water,
// so it meets the shore at the waterline instead of stepping down into the lagoon
export const SHORE_K = 4;
// the verge (a road with no pavement): a strip of gravel along its edge, no kerb; none along the ways off the street network
export const vergeW = (r) => (r.minor || r.pave ? 0 : r.kind === 'highway' ? 1.5 : r.kind === 'main' ? 1 : 0.6);
// whether a street's carriageway is painted (lane and centre lines): a city's, a main road, or one wide enough for two
// lanes (5.5 m); its junctions' zebras: a city's streets and a village's (with a pavement)
export const painted = (r, city) => !r.minor && (city || r.kind === 'highway' || r.kind === 'main' || r.hw >= 2.75);
export const zebra = (r, city) => !r.minor && (city || r.pave > 0);
export const isRail = (r) => r.kind === 'rail';
const SC = 10, PAD = 54; // (grid cell, m; how far from a road its segments are found: the bake stores every road within more than this of a chunk, bake.js NET_PAD, so two chunks work out their shared edge alike)

// bridges and tunnels (roads.js draws their decks and tubes at their own profile, as today): a deck is DECK_SIDE m wider than
// its road each side and DECK_DEPTH deep; a tube's walls TUBE_SIDE m out, its crown TUBE_H up; a portal's headwall
// PORTAL_W m wider than the tube each side, PORTAL_TOP up, PORTAL_T thick (centred on the portal)
export const PORTAL_BEHIND = 8; // (m into the hill behind a portal no railway's bed reaches: a tunnel's other tracks stop at its mouth)
export const DECK_SIDE = 1, DECK_DEPTH = 1.4, TUBE_SIDE = 1.2, TUBE_H = 5.6, PORTAL_W = 5, PORTAL_TOP = 11.6, PORTAL_T = 0.7;
// with the layout on, a portal's headwall's wings reach PORTAL_FOOT m under the road (a retaining wall where the ground beside
// the portal lies far under it) and a sill SILL m deep closes the floor's edge across the mouth (roads.js); a surface
// within FLUSH m of the floor behind the mouth meets the tube's floor (no gap: a twin carriageway at grade beside it)
export const PORTAL_FOOT = 12, SILL = 2, FLUSH = 0.3, TOP_OVER = 0.5;
const UNDER = 0.1, OVER = 0.3, HOLD = 10; // (the ground kept this far under a deck's underside, over a tube's crown)
// a tunnel's portals, from the roads stopping at a tube (ends 2, 8): where (the road's end), which way into the hill (dx,
// dz: the road's last segment's, and the tube's first's if it's stored: roads.js frames the headwall by both), the road's
// height there (the tube's floor), the tube's half width (hwT) and the headwall's (W)
export function portalsOf(runs) {
  const out = [], tubes = runs.filter((r) => r.off === 'tube'), P = (r, i) => [r.shape[i * 2], r.shape[i * 2 + 1]], ns = (r) => r.shape.length / 2;
  for (const r of runs) for (const end of ['A', 'B']) { if (r['cut' + end] !== 'tube' || ns(r) < 2) continue;
    const [x, z] = end === 'A' ? P(r, 0) : P(r, ns(r) - 1), [px, pz] = end === 'A' ? P(r, 1) : P(r, ns(r) - 2); let nx = px, nz = pz, thw = r.hw;
    for (const t of tubes) { if (ns(t) < 2) continue; const [ax, az] = P(t, 0), [bx, bz] = P(t, ns(t) - 1); if (Math.hypot(ax - x, az - z) < 0.02) { [nx, nz] = P(t, 1); nx = 2 * x - nx; nz = 2 * z - nz; thw = Math.max(thw, t.hw); break; } if (Math.hypot(bx - x, bz - z) < 0.02) { [nx, nz] = P(t, ns(t) - 2); nx = 2 * x - nx; nz = 2 * z - nz; thw = Math.max(thw, t.hw); break; } } // (thw: the tube's half width: a double-track tunnel's, wider than its track's bed, bake.js mergeBores)
    let dx = (x - px) + (x - nx), dz = (z - pz) + (z - nz); if (Math.hypot(dx, dz) < 1e-6) { dx = x - px; dz = z - pz; } const l = Math.hypot(dx, dz) || 1, hwT = thw + TUBE_SIDE;
    out.push({ x, z, dx: dx / l, dz: dz / l, y: end === 'A' ? r.h[0] : r.h[r.h.length - 1], hw: r.hw, hwT, W: hwT + PORTAL_W, rail: r.kind === 'rail' }); }
  // (a railway's portal in another's mouth (several tracks into one tube: a switch at the portal, a yard's tracks, bake.js
  // mergeBores's other track): one portal, the widest (then by where it is, so every chunk keeps the same one); the other
  // track ends inside its mouth)
  const rails = out.filter((p) => p.rail).sort((a, b) => b.hwT - a.hwT || a.x - b.x || a.z - b.z), kept = [];
  for (const p of rails) { if (kept.some((k) => { const [u, v] = portalUV(k, p.x, p.z); return u > -1 && u < PORTAL_T + 1 && Math.abs(v) <= k.W; })) p.drop = true; else kept.push(p); }
  // (each one's headwall's top: PORTAL_TOP over the floor, or higher where another way runs over or beside it above that (a
  // switchback over a mountain tunnel's portal): up to that way's surface (its strip, kerb and verge: stations every 0.5 m
  // along it), and TOP_OVER more)
  const res = out.filter((p) => !p.drop);
  for (const p of res) { let top = PORTAL_TOP; for (const r of runs) { if (r.off || r.kind === 'rail') continue; const reach = r.hw + (r.pave || 0) + vergeW(r) + 0.5, n = r.h.length;
      for (let i = 0; i + 1 < n; i++) { const ax = r.pts[i * 2], az = r.pts[i * 2 + 1], bx = r.pts[i * 2 + 2], bz = r.pts[i * 2 + 3], [ua, va] = portalUV(p, ax, az), [ub, vb] = portalUV(p, bx, bz);
        if (Math.max(ua, ub) < -1 - reach || Math.min(ua, ub) > PORTAL_T + 1 + reach || Math.min(Math.abs(va), Math.abs(vb)) > p.W + reach + Math.hypot(bx - ax, bz - az)) continue;
        const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5)); for (let q = 0; q <= k; q++) { const t = q / k, u = ua + (ub - ua) * t, v = va + (vb - va) * t; if (u < -1 - reach || u > PORTAL_T + 1 + reach || Math.abs(v) > p.W + reach) continue;
          top = Math.max(top, r.h[i] + (r.h[i + 1] - r.h[i]) * t + (r.pave ? KERB : 0) - p.y + TOP_OVER); } } }
    p.top = top; }
  return res;
}
// (x, z) in a portal's frame: along (into the hill, from the portal) and across
export const portalUV = (p, x, z) => [(x - p.x) * p.dx + (z - p.z) * p.dz, (z - p.z) * p.dx - (x - p.x) * p.dz];

// net: { runs: [{ pts: Float64Array x,z,..., h: Float64Array, hw, pave, kind, minor, surf, lanes, oneway, off ('deck', 'tube': not the ground's), cutA, cutB ('deck', 'tube': it stops there) }], junctions: [{ x, z, r, y0, gx, gz }] }
// g(x, z): the natural ground; city: a city's lots; wl: the world's water level (the shore rule; none: -Infinity)
export function makeRules(net, g, city, wl = -Infinity) {
  const runs = net.runs, JN = net.junctions;
  for (const r of runs) { const n = r.h.length; r.s = new Float64Array(n); for (let i = 1; i < n; i++) r.s[i] = r.s[i - 1] + Math.hypot(r.pts[i * 2] - r.pts[i * 2 - 2], r.pts[i * 2 + 1] - r.pts[i * 2 - 1]); }
  const segIdx = new Map(), key = (i, j) => i * 100003 + j, offIdx = new Map(), portals = portalsOf(runs);
  runs.forEach((r, ri) => { if (r.off) return; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3];
    for (let i = Math.floor((Math.min(ax, bx) - PAD) / SC); i <= Math.floor((Math.max(ax, bx) + PAD) / SC); i++) for (let j = Math.floor((Math.min(az, bz) - PAD) / SC); j <= Math.floor((Math.max(az, bz) + PAD) / SC); j++) { const k = key(i, j); (segIdx.get(k) || segIdx.set(k, []).get(k)).push(ri, s); } } });
  runs.forEach((r, ri) => { if (!r.off) return; const wd = r.hw + (r.off === 'deck' ? DECK_SIDE : TUBE_SIDE); for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3];
    for (let i = Math.floor((Math.min(ax, bx) - wd) / SC); i <= Math.floor((Math.max(ax, bx) + wd) / SC); i++) for (let j = Math.floor((Math.min(az, bz) - wd) / SC); j <= Math.floor((Math.max(az, bz) + wd) / SC); j++) { const k = key(i, j); (offIdx.get(k) || offIdx.set(k, []).get(k)).push(ri, s); } } });
  // (a road's raw projection t on its segment s past an end where it stops at a deck or tube: past it, it isn't there)
  const pastCut = (r, s, t, kind) => (t < 0 && s === 0 && r.cutA && (!kind || r.cutA === kind)) || (t > 1 && s === r.h.length - 2 && r.cutB && (!kind || r.cutB === kind));
  // the ground under a deck kept under its underside, over a tube kept over its crown (within their widths, between their ends)
  const offClamp = (x, z, y) => { const L = offIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return y;
    for (let q = 0; q < L.length; q += 2) { const r = runs[L[q]], s = L[q + 1], ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9, t0 = ((x - ax) * dx + (z - az) * dz) / L2;
      if ((t0 < 0 && s === 0) || (t0 > 1 && s === r.h.length - 2)) continue; const t = Math.max(0, Math.min(1, t0)), d = Math.hypot(x - ax - dx * t, z - az - dz * t), hy = r.h[s] + (r.h[s + 1] - r.h[s]) * t;
      if (r.off === 'deck') { if (d <= r.hw + DECK_SIDE + 0.05) y = Math.min(y, hy - DECK_DEPTH - UNDER); } else if (d <= r.hw + TUBE_SIDE + 0.5) y = Math.max(y, hy + TUBE_H + OVER); } // (a tube: half a metre wider, the portal's frame turned a little from the tube's)
    return y; };
  // a portal's opening: its lip (behind the portal, the headwall's back half, across the headwall: no surface); and the ground
  // there kept within the headwall (its rim hidden in it)
  const inLip = (x, z) => portals.some((p) => { const [u, v] = portalUV(p, x, z); return u >= -0.005 && u <= PORTAL_T / 2 + 0.005 && Math.abs(v) <= p.W + 0.005; });
  const portalClamp = (x, z, y) => { for (const p of portals) { const [u, v] = portalUV(p, x, z); if (u >= -0.05 && u <= PORTAL_T / 2 + 0.05 && Math.abs(v) <= p.W + 0.05) { y = Math.min(y, p.y + (u < PORTAL_T / 4 && Math.abs(v) <= p.hwT + 0.05 ? TUBE_H - 0.1 : PORTAL_TOP - 0.3));
    if (p.rail) y = Math.max(y, p.y - (Math.abs(v) <= p.hwT + 0.05 ? SILL : PORTAL_FOOT) + 0.1); } } return y; }; // (a railway's portal: the ground there held up to its sill across the mouth, its wings' foot beside it: a bed narrower than the mouth, a hillside falling away beside it) // (the mouth's front: under the crown, a steep hillside's cutting held there)
  const street = (r) => !r.minor, any = () => true, notRail = (r) => !isRail(r), hasRail = runs.some(isRail);
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
  const junction = (x, z) => { let best = null, bd = Infinity; for (const q of jGrid.get(key(Math.floor(x / SC), Math.floor(z / SC))) || []) { const J = JN[q]; if (J.lx) continue; const d = Math.hypot(x - J.x, z - J.z) - J.r; if (d < JBLEND && d < bd) { bd = d; best = J; } } return best ? [best, bd] : null; };
  // the street surface at (x, z) given its street's height h there: a junction's plane inside it, blending into the street's
  // (where junctions' circles overlap or nearly: their planes blended by how far inside each the point is, so the surface
  // doesn't step where one stops being the nearest)
  // (lx: a level crossing's plane only: a railway's bed, a way off the street network)
  const streetH = (x, z, h, lx = false) => { let sw = 0, sp = 0, dmin = Infinity; for (const q of jGrid.get(key(Math.floor(x / SC), Math.floor(z / SC))) || []) { const J = JN[q]; if (lx && !J.lx) continue; const d = Math.hypot(x - J.x, z - J.z) - J.r; if (d >= JBLEND) continue; const u = (JBLEND - d) / JBLEND, wt = u * u; sw += wt; sp += wt * (J.y0 + J.gx * (x - J.x) + J.gz * (z - J.z)); if (d < dmin) dmin = d; }
    if (!sw) return h; const ph = sp / sw; if (dmin <= 0) return ph; const t = dmin / JBLEND, w = t * t * (3 - 2 * t); return ph + (h - ph) * w; };
  // the streets' height at (x, z) away from a junction: every street segment within SBLEND of the nearest (by distance past
  // its tarmac's edge) blended, each weighted down to nothing as it falls SBLEND behind. Per segment, not per road: a
  // segment's distance and height change smoothly, so the blend does too, wherever streets (or a road's own two sides of a
  // sharp bend) meet, and whichever way the roads are split into ways
  // (rail: the railways' instead: a yard's tracks side by side, each at its own height, make one bed without a step between)
  const blended = (x, z, rail = false) => { const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return null; const c = []; let dmin = Infinity;
    for (let q = 0; q < L.length; q += 2) { const r = runs[L[q]], s = L[q + 1]; if (rail ? !isRail(r) || r.off : r.minor) continue; const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t) - r.hw; c.push(d, r.h[s] + (r.h[s + 1] - r.h[s]) * t); if (d < dmin) dmin = d; }
    let sw = 0, sh = 0; for (let q = 0; q < c.length; q += 2) { const u = 1 - (c[q] - dmin) / SBLEND; if (u <= 0) continue; const wt = u * u * (3 - 2 * u); sw += wt; sh += wt * c[q + 1]; } return sw ? sh / sw : null; };
  const minorKind = (k) => k === KIND.alley || k === KIND.pavers || k === KIND.gravel, lxs = JN.some((J) => J.lx);
  // where a road stops at a deck or a tube: its own height across its end, as the deck's or the tube's floor (level across), not
  // blended with a road beside it (a dual carriageway's other side, a ramp): fading to the blend over HOLD m back from the end
  // and over its pavement or verge sideways (no step)
  const cuts = []; runs.forEach((r) => { if (r.off || r.minor) return; const n = r.h.length; if (n < 2) return; for (const [c, i, j] of [[r.cutA, 0, 1], [r.cutB, n - 1, n - 2]]) if (c) { const dx = r.pts[i * 2] - r.pts[j * 2], dz = r.pts[i * 2 + 1] - r.pts[j * 2 + 1], l = Math.hypot(dx, dz) || 1; cuts.push({ r, x: r.pts[i * 2], z: r.pts[i * 2 + 1], dx: dx / l, dz: dz / l, y: r.h[i], side: r.pave || vergeW(r) || 1 }); } });
  // (where a railway stops at a deck or a tube: its end, facing out (dx, dz))
  const railCuts = []; runs.forEach((r) => { if (r.off || !isRail(r)) return; const n = r.h.length; if (n < 2) return; for (const [c, i, j] of [[r.cutA, 0, 1], [r.cutB, n - 1, n - 2]]) if (c) { const dx = r.pts[i * 2] - r.pts[j * 2], dz = r.pts[i * 2 + 1] - r.pts[j * 2 + 1], l = Math.hypot(dx, dz) || 1; railCuts.push({ r, x: r.pts[i * 2], z: r.pts[i * 2 + 1], dx: dx / l, dz: dz / l }); } });
  const railEnd = (x, z) => { let best = null, bv = Infinity; for (const c of railCuts) { const u = (c.x - x) * c.dx + (c.z - z) * c.dz; if (u < -0.05 || u > HOLD) continue; const v = Math.abs((z - c.z) * c.dx - (x - c.x) * c.dz); if (v <= c.r.hw + 0.05 && v < bv) { bv = v; best = c.r; } } return best; }; // (the nearest: a double-track bridge's two decks)
  const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  // (two such ends side by side, a twin tube's: each one's own height by how near its centre line the point is, sharply, so
  // each end is its own exactly and the two blend between, without a step)
  // (by how much nearer each end's centre line is than the nearest's, over HOLD_V m: on one end's centre line that end alone, so
  // two decks ending a metre apart at one short stretch each meet their own; between two ends side by side, a blend)
  const HOLD_V = 0.35, hc = [];
  const hold = (x, z, y) => { let W = 0, vmin = Infinity; hc.length = 0; for (const c of cuts) { const u = (c.x - x) * c.dx + (c.z - z) * c.dz; if (u < -0.01 || u > HOLD) continue; const v = Math.abs((z - c.z) * c.dx - (x - c.x) * c.dz); if (v > c.r.hw + c.side) continue;
      const w = (1 - sstep(u / HOLD)) * (1 - sstep((v - c.r.hw) / c.side)); if (w <= 0) continue; W = Math.max(W, w); hc.push(c, v); if (v < vmin) vmin = v; }
    if (!(W > 0)) return y; let sk = 0, sy = 0; for (let q = 0; q < hc.length; q += 2) { const k = Math.exp(-(((hc[q + 1] - vmin) / HOLD_V) ** 2)); if (k < 1e-9) continue; sk += k; sy += k * nearestOn(hc[q].r, x, z); }
    return y + (sy / sk - y) * W; };
  const nearestOn = (r, x, z) => { let best = Infinity, y = 0; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; y = r.h[s] + (r.h[s + 1] - r.h[s]) * t; } } return y; };
  const base = (x, z, k) => {
    if (k === KIND.ballast) { const re = railCuts.length ? railEnd(x, z) : null; if (re) return nearestOn(re, x, z); const y = blended(x, z, true); if (y != null) return lxs ? streetH(x, z, y, true) : y; } // (a railway's bed; HOLD m back from where it stops at a deck or a tube: its own height, the deck's or the tube floor's at its end)
    const n = nearest(x, z, minorKind(k) ? (hasRail ? notRail : any) : street) || nearest(x, z, any); if (!n) return g(x, z);
    if (minorKind(k) && n.d > 0) { const f = Math.min(1, n.d / 20); return n.h + (g(x, z) - n.h) * f; } // (a plaza's middle, away from its ways: towards the ground)
    if (n.r.minor) return lxs ? streetH(x, z, n.h, true) : n.h; // (a railway's bed, a way off the street network: on a level crossing's plane there)
    const y = streetH(x, z, blended(x, z)); return cuts.length ? hold(x, z, y) : y;
  };
  const drawn = (x, z, k) => base(x, z, k) + (k === KIND.pave || k === KIND.kerb ? KERB : 0);
  const lot = (x, z) => { const two = nearest2(x, z, (r) => !r.minor && r.pave).filter((n, i) => i === 0 || n.d <= LOT_PAIR); if (!two.length) return null; /* (the second only if it's near: past that, which it is depends on how far the stored network reaches) */ let s = 0, ws = 0; for (const n of two) { const wt = 1 / Math.max(0.5, n.d); s += (streetH(x, z, n.h) + KERB) * wt; ws += wt; } return { y: s / ws, d: two[0].d }; };
  // the banks: every road within reach bounds the ground, a fill from below (lo) and a cutting from above (hi), each from its
  // outer edge (pavement or verge) at its slope; the ground is the natural ground held between them (so two roads' banks,
  // a switchback's legs, meet without a step). Where two roads' banks disagree (a wall's place): the nearer road's.
  const slopeAt = (x, z) => Math.hypot(g(x + 2, z) - g(x - 2, z), g(x, z + 2) - g(x, z - 2)) / 4;
  // (ok: which roads; y0: the ground to hold between them, gz's by default)
  const banks = (x, z, gz, ok = any, y0 = gz) => { const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return y0; const per = new Map();
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri]; if (!ok(r)) continue; const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t0 = ((x - ax) * dx + (z - az) * dz) / L2; if (pastCut(r, s, t0, 'tube')) continue; // (past a portal, the hill: not the approach's cutting)
      const t = Math.max(0, Math.min(1, t0)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz) - r.hw - (r.pave || vergeW(r)), b = per.get(ri);
      if (d <= BANK_MAX && (!b || d < b.d)) per.set(ri, { r, d: Math.max(0, d), h: r.h[s] + (r.h[s + 1] - r.h[s]) * t, px, pz }); }
    if (!per.size || gz < wl) return y0; let lo = -Infinity, hi = Infinity, nb = null;
    for (const b of per.values()) { const y = (b.r.minor ? (lxs ? streetH(b.px, b.pz, b.h, true) : b.h) : streetH(b.px, b.pz, b.h)) + (b.r.pave ? KERB : 0), sl = BANK_STEEP * slopeAt(b.px, b.pz), kf = Math.min(BANK_TOP, Math.max(FILL, sl)), kc = Math.min(BANK_TOP, Math.max(CUT, sl));
      b.lo = y - kf * b.d; b.hi = y + kc * b.d; lo = Math.max(lo, b.lo); hi = Math.min(hi, b.hi); if (!nb || b.d < nb.d) nb = b; }
    if (lo > hi) { lo = nb.lo; hi = nb.hi; } return shore(Math.min(hi, Math.max(lo, y0)), gz); };
  // (the shore: under the water the natural ground; on dry ground a fill tapers to nothing at the waterline, never below it)
  const shore = (y, gz) => (gz < wl ? gz : Math.max(wl, y > gz ? Math.min(y, gz + SHORE_K * (gz - wl)) : y));
  const ground0 = (x, z) => { const gz = g(x, z); if (city) { const l = lot(x, z); if (l && l.d <= CITY_REACH) return hasRail ? banks(x, z, gz, isRail, l.y) : l.y; } return banks(x, z, gz); }; // (a city's lots: a railway's banks through them)
  const ground = (x, z) => portalClamp(x, z, offClamp(x, z, ground0(x, z)));
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
  const mk = (r) => (isRail(r) ? KIND.ballast : r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const region = (x, z) => { if (portals.length && inLip(x, z)) return KIND.lip; const L = segIdx.get(key(Math.floor(x / SC), Math.floor(z / SC))); if (!L) return KIND.ground; let best = KIND.ground, rank = 99;
    const RANK = { [KIND.tarmac]: 0, [KIND.ballast]: 1, [KIND.pave]: 2, [KIND.alley]: 3, [KIND.pavers]: 4, [KIND.gravel]: 5, [KIND.verge]: 6 }; // (outline.js's order)
    for (let q = 0; q < L.length; q += 2) { const ri = L[q], s = L[q + 1], r = runs[ri], ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
      const t0 = ((x - ax) * dx + (z - az) * dz) / L2; if (pastCut(r, s, t0)) continue; // (a road stopping at a deck or tube stops square)
      if (isRail(r) && portals.some((p) => { const [u, v] = portalUV(p, x, z); return p.rail && u >= 0 && u <= PORTAL_BEHIND && Math.abs(v) <= p.W; })) continue; // (no railway's bed behind a portal, outline.js)
      const t = Math.max(0, Math.min(1, t0)), d = Math.hypot(x - ax - dx * t, z - az - dz * t) - r.hw;
      const k = d <= (r.minor ? 0 : 0.03) ? (r.minor ? mk(r) : KIND.tarmac) : !r.minor && r.pave && d <= r.pave ? KIND.pave : d <= vergeW(r) ? KIND.verge : null;
      if (k != null && RANK[k] < rank) { rank = RANK[k]; best = k; } }
    return best; };
  return { base, drawn, ground, road, roadOn, lineOn, bends, nearest, nearest2, lot, junction, region, portals };
}

// The natural ground: today's terrain base without the roads' carving, at the hi grid's points (World.rawHeight: the real
// heights with the airport's apron, the road out to its gate and the stunt sites' levelled pads; World.shoreSnap: no
// ground within decimetres of the water). The game's terrain shapes the same base before roads.js carves it; the layout
// samples it at the hi grid's points (11.7 m in the islands; today's grid is the quality's, 14-57 m), bilinear between.
// The bake (its solve, and the meshes it checks) and the runtime both read it from the World through these.
export const groundGrid = (w) => { const H = w.real.hi; return { x0: H.x0, z0: H.z0, sp: H.sp, wl: w.loc.shore ? w.waterLevel : -Infinity }; };
export const groundNode = (w, grid, i, j) => w.shoreSnap(w.rawHeight(grid.x0 + i * grid.sp, grid.z0 + j * grid.sp));
// the natural ground's heights at a chunk's lattice (latticeOf)
export function latticeHeights(w, grid, lat) {
  const G = new Float32Array(lat.ni * lat.nj); for (let j = 0; j < lat.nj; j++) for (let i = 0; i < lat.ni; i++) G[j * lat.ni + i] = groundNode(w, grid, lat.i0 + i, lat.j0 + j);
  return G;
}
// the natural ground anywhere (the bake's solve): bilinear over the same points, each worked out once
export function naturalGround(w) {
  const grid = groundGrid(w), memo = new Map(), node = (i, j) => { const k = i * 1048576 + j; let v = memo.get(k); if (v === undefined) memo.set(k, (v = groundNode(w, grid, i, j))); return v; };
  return (x, z) => { const fx = (x - grid.x0) / grid.sp, fz = (z - grid.z0) / grid.sp, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    return (node(i, j) * (1 - u) + node(i + 1, j) * u) * (1 - v) + (node(i, j + 1) * (1 - u) + node(i + 1, j + 1) * u) * v; };
}

// the natural ground from the hi grid's points around a chunk (lat: i0, j0, ni, nj; G their heights): bilinear, as the
// World's (realworld.js sampleH)
export function latticeGround(grid, lat, G) {
  return (x, z) => { const fx = (x - grid.x0) / grid.sp - lat.i0, fz = (z - grid.z0) / grid.sp - lat.j0, i = Math.max(0, Math.min(lat.ni - 2, Math.floor(fx))), j = Math.max(0, Math.min(lat.nj - 2, Math.floor(fz))), u = fx - i, v = fz - j, k = j * lat.ni + i;
    return (G[k] * (1 - u) + G[k + 1] * u) * (1 - v) + (G[k + lat.ni] * (1 - u) + G[k + lat.ni + 1] * u) * v; };
}
