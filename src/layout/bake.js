// The bake of the road layout (#294): everything about the roads' shape is decided here, once, for an area of chunks,
// and stored per chunk (format.js); the game only joins the points (mesh.js). Run by tools/bake/layout.mjs on a real
// place's World (its road network, junctions and natural ground, rules.js naturalGround: today's terrain base without the roads' carving).
//
//  1. network: the street network and the ways off it near the area, resampled (<= SEG m), with the points where roads
//     cross without a shared node tied together (they meet at one height)
//  2. one height solve over all of it: near the natural ground, smooth along each road, within each kind's grade limit,
//     each junction a tilted plane (validated: a plane fits a junction's ground to ~0.1 m at p90; flat ones don't)
//  3. clean outlines (integer centimetres, Clipper): carriageways, kerbs, pavements, alleys, pavers, gravel, verges,
//     each a region of its own, none overlapping
//  4. per chunk: the outlines (clipped to it, split where they cross) and the network within NET_PAD of it, quantized.
//     Everything else (heights, the reshaped ground, the markings' coordinates) the game works out with rules.js.
import CL from '../../vendor/layout/clipper1.mjs';
import { CHUNK, KIND, RKINDS, encodeLayout, stations } from './format.js';
import { naturalGround } from './rules.js';

const PIN_W = 1e4, SEG = 8, MARGIN = 150, ARC = 8, SIMPLIFY = 25, SHAPE_TOL = 15, EDGE_STEP = 4, NET_PAD = 75; // (NET_PAD: the network stored with a chunk reaches this far past it: past every rule's reach, rules.js)
const PAVE = { main: 4.5, street: 3.5 }; // (as roadgrade.js: a city street's pavement, a country road's verge)
// a country place's pavements: only along a street's built-up stretches (OpenStreetMap's sidewalk tags aren't in the
// road data; the buildings are): BUILT_N or more buildings within BUILT_D m of the road per 100 m, averaged over
// BUILT_WIN m along it; stretches shorter than BUILT_MIN m joined to their neighbours
const PAVE_VILLAGE = 1.8, BUILT_D = 30, BUILT_N = 5, BUILT_WIN = 120, BUILT_MIN = 60;
// a country junction's plane: out to JR_K x its widest road's half width + JR_ADD m (at least JR_MIN), not its whole box (a
// lane's junction box reaches far along its arms: an apron of tilted plane over the road there)
const JR_K = 1.5, JR_ADD = 1.5, JR_MIN = 4;
// grade limits: the street network's as roadgrade.js; the ways off it steeper (a farm's service road, a gravel track;
// a footpath steps up the hillside: its OSM line is coarser than its zigzags), and kept within MINOR_OFF m of the ground
const GRADE = { highway: 0.18, main: 0.18, street: 0.22 }, GRADE_MINOR = { service: 0.3, track: 0.35, ped: 0.6 }, MINOR_OFF = 1.5; // (alpine: Swiss pass and valley roads reach 15-20%)
const GRADE_CITY = { highway: 0.07, main: 0.12, street: 0.2 }; // (a city's: as roadgrade.js)
// the shore (a place on the sea, loc.shore): a road (none of them bridges here) is held at least FREEBOARD m above the
// world's water level: the height grid blurs a coastal road's narrow strip of land between the hillside and the lagoon,
// and a motu's paths, down into the water
const FREEBOARD = 0.5, WET = 0.5;
const PLANE_ACROSS = 0.5, CROSS_MAX = 0.3;
const RELAX_OFF = 2, RELAX_HOPS = 3, RELAX_MAX = 1, RELAX_WG = 1, RELAX_ROUNDS = 4;
const cm = (v) => Math.round(v * 100);

export function bakeLayout(w, chunks, log = () => {}, opts = {}) {
  const T = {}, tic = (k, t0) => { T[k] = (T[k] || 0) + performance.now() - t0; log(`  [layout] ${k} ${Math.round(T[k])} ms`); }, city = !!w.loc.city, g = naturalGround(w), wl = w.loc.shore ? w.waterLevel : -Infinity;
  const ix0 = Math.min(...chunks.map((c) => c[0])), ix1 = Math.max(...chunks.map((c) => c[0])), iz0 = Math.min(...chunks.map((c) => c[1])), iz1 = Math.max(...chunks.map((c) => c[1]));
  const R = { x0: ix0 * CHUNK - MARGIN, x1: (ix1 + 1) * CHUNK + MARGIN, z0: iz0 * CHUNK - MARGIN, z1: (iz1 + 1) * CHUNK + MARGIN }, inR = (p, m = 0) => p.x > R.x0 - m && p.x < R.x1 + m && p.z > R.z0 - m && p.z < R.z1 + m;
  // ---- 1. network
  let t0 = performance.now();
  const V = [], node = new Map(), runs = [], rdId = new Map(), built = city ? null : builtUp(w); // (built: a country place's built-up stretches)
  const newVar = (x, z) => (V.push({ x, z, g: g(x, z) }), V.length - 1);
  // (a road's stretches on bridge decks or in tunnels' tubes aren't the ground's: they're stored as decks and tubes
  // (offRuns), drawn by today's bridge and tube meshes at their own profile (roads.js); the stretches either side are
  // roads of their own, each ending where the deck or tube begins (cutA, cutB), held there at the deck's or tube's height
  // (pins) so the two meet without a step; a node a road shares with a deck or a tube is held at its height too)
  const offRuns = [], pins = new Map(), pinNode = new Map(), endNode = new Set();
  for (const rd of w.net.roads) {
    if (rd.kind === 'rail') continue;
    const n0 = rd.pts.length, P = rd.closed ? [...rd.pts, rd.pts[0]] : rd.pts, n = P.length; let a = -1, b = -1; // (a roundabout's ring: closed as a line)
    for (let i = 0; i < n; i++) if (inR(P[i])) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    a = Math.max(0, a - 1); b = Math.min(n - 1, b + 1);
    // (on the sea, loc.shore: a way off the street network out in the water isn't the layout's either: a resort's walkway out
    // to its overwater bungalows, on a pier the game draws as its deck)
    const wet = (i) => rd.minor && g(P[i % n0].x, P[i % n0].z) < wl - WET;
    const off = (i) => (rd.baked || (rd.bridge?.[i % n0] && rd.bridge?.[(i + 1) % n0]) ? 'deck' : rd.tube?.[i % n0] && rd.tube?.[(i + 1) % n0] ? 'tube' : wet(i) || wet(i + 1) ? 'wet' : null), jn = new Map(rd.jn || []), cut = (t) => (t === 'wet' ? null : t);
    for (let s0 = a; s0 < b;) {
      const ty = off(s0); let e0 = s0 + 1; while (e0 < b && off(e0) === ty) e0++;
      if (ty === 'wet') { s0 = e0; continue; }
      if (ty) { const pts = [], ys = []; for (let i = s0; i <= e0; i++) { pts.push([P[i].x, P[i].z]); ys.push(P[i].y); const nd = jn.get(i % n0); if (nd != null && !pinNode.has(nd)) pinNode.set(nd, P[i].y); if (nd != null && (i === s0 || i === e0)) endNode.add(nd); }
        offRuns.push({ off: ty, rd, osmPts: pts, pts, ys, kind: rd.kind, minor: !!rd.minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, pave: 0 }); s0 = e0; continue; }
      // (in a country place, a street's stretch split again where it enters or leaves a built-up stretch: PAVE_VILLAGE)
      const parts = []; if (built && !rd.minor && rd.kind !== 'highway') { const f = built(P, s0, e0); let s1 = s0; for (let q = s0 + 1; q <= e0; q++) if (q === e0 || f[q - s0] !== f[q - s0 - 1]) { parts.push([s1, q, f[s1 - s0]]); s1 = q; } } else parts.push([s0, e0, false]);
      const cA = cut(s0 > a ? off(s0 - 1) : a > 0 ? off(a - 1) : null), cB = cut(e0 < b ? off(e0) : b < n - 1 ? off(b) : null);
      for (const [s1, e1, village] of parts) {
        const pts = [], vars = [], osm = []; // (osm: which of pts are the road's own points)
        for (let i = s1; i <= e1; i++) {
          if (i > s1) { const p = P[i - 1], q = P[i], l = Math.hypot(q.x - p.x, q.z - p.z), k = Math.ceil(l / SEG); for (let s = 1; s < k; s++) { const x = p.x + (q.x - p.x) * s / k, z = p.z + (q.z - p.z) * s / k; pts.push([x, z]); vars.push(newVar(x, z)); } }
          const nd = jn.get(i % n0) ?? (!(rd.closed && i === n0) && (i === s1 || i === e1) && parts.length > 1 ? `${rdId.get(rd) ?? rdId.set(rd, rdId.size).get(rd)}:${i}` : null); // (where a stretch is split: one point for both)
          let v; if (nd != null && node.has(nd)) v = node.get(nd); else if (rd.closed && i === n0 && vars.length) v = vars[0]; else { v = newVar(P[i].x, P[i].z); if (nd != null) node.set(nd, v); }
          osm.push(pts.length); pts.push([P[i].x, P[i].z]); vars.push(v);
        }
        const minor = !!rd.minor, kind = rd.kind, cutA = s1 === s0 ? cA : null, cutB = e1 === e0 ? cB : null;
        if (cutA) pins.set(vars[0], P[s1].y); if (cutB) pins.set(vars[vars.length - 1], P[e1].y);
        runs.push({ cutA, cutB, rd, osmPts: osm.map((k) => pts[k]), kind, minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, layer: rd.layer || 0, pts, vars, grade: minor ? GRADE_MINOR[kind] ?? 0.3 : (city ? GRADE_CITY : GRADE)[kind] ?? 0.2, pave: city && !minor && !rd.baked && PAVE[kind] ? PAVE[kind] : village ? PAVE_VILLAGE : 0 });
      }
      s0 = e0;
    }
  }
  for (const [nd, y] of pinNode) { const v = node.get(nd); if (v != null && !pins.has(v)) pins.set(v, y); }
  // (a road ending where a deck or tube ends (a whole-bridge way, bake.py's decks over water) ends there as at a cut)
  { const at = new Map(); for (const nd of endNode) { const v = node.get(nd); if (v != null) at.set(v, pinNode.get(nd)); }
    for (const r of runs) { if (!r.cutA && at.has(r.vars[0])) r.cutA = 'deck'; if (!r.cutB && at.has(r.vars[r.vars.length - 1])) r.cutB = 'deck'; } }
  const pinAll = () => { for (const [k, y] of pins) h[k] = y; };
  // (roads crossing without a shared node, on the same layer: tied at the crossing)
  { const segGrid = new Map(), C = 20, key = (i, j) => i * 100003 + j, ins = runs.map(() => []);
    runs.forEach((r, ri) => { for (let s = 0; s + 1 < r.pts.length; s++) { const [ax, az] = r.pts[s], [bx, bz] = r.pts[s + 1]; for (let i = Math.floor(Math.min(ax, bx) / C); i <= Math.floor(Math.max(ax, bx) / C); i++) for (let j = Math.floor(Math.min(az, bz) / C); j <= Math.floor(Math.max(az, bz) / C); j++) { const k = key(i, j); (segGrid.get(k) || segGrid.set(k, []).get(k)).push([ri, s]); } } });
    const seen = new Set();
    for (const list of segGrid.values()) for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const [ra, sa] = list[p], [rb, sb] = list[q]; if (ra === rb || runs[ra].layer !== runs[rb].layer) continue;
      const id = ra < rb ? `${ra}:${sa}:${rb}:${sb}` : `${rb}:${sb}:${ra}:${sa}`; if (seen.has(id)) continue; seen.add(id);
      const A = runs[ra], B = runs[rb], [ax, az] = A.pts[sa], [bx, bz] = A.pts[sa + 1], [cx, cz] = B.pts[sb], [dx, dz] = B.pts[sb + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx); if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den; if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) continue;
      const va = [A.vars[sa], A.vars[sa + 1]], vb = [B.vars[sb], B.vars[sb + 1]]; if (va.some((v) => vb.includes(v))) continue; // (already a junction)
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, v = newVar(x, z); V[v].tie = true; ins[ra].push([sa, t, x, z, v]); ins[rb].push([sb, u, x, z, v]);
    }
    runs.forEach((r, ri) => { if (!ins[ri].length) return; ins[ri].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const pts = [], vars = []; let q = 0;
      for (let s = 0; s < r.pts.length; s++) { pts.push(r.pts[s]); vars.push(r.vars[s]); while (q < ins[ri].length && ins[ri][q][0] === s) { pts.push([ins[ri][q][2], ins[ri][q][3]]); vars.push(ins[ri][q][4]); q++; } }
      r.pts = pts; r.vars = vars; T.ties = (T.ties || 0) + ins[ri].length / 2; });
  }
  for (const r of runs) { r.s = [0]; for (let i = 1; i < r.pts.length; i++) r.s.push(r.s[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1])); }
  tic('networkMs', t0);
  // ---- 2. height solve
  t0 = performance.now();
  const nv = V.length, floor = wl + FREEBOARD, gt = Float64Array.from(V, (v) => Math.max(v.g, floor)), h = Float64Array.from(gt), edges = [], nb = V.map(() => []); // (gt: the ground each station is pulled to: the natural ground, above the water)
  const lift = () => { let n = 0; for (let k = 0; k < nv; k++) if (h[k] < floor && !pins.has(k)) { h[k] = floor; n++; } return n; };
  for (const r of runs) for (let i = 0; i + 1 < r.vars.length; i++) { const a = r.vars[i], b = r.vars[i + 1]; if (a === b) continue; const l = Math.max(0.5, r.s[i + 1] - r.s[i]); edges.push([a, b, l, r.grade]); nb[a].push([b, 1 / l]); nb[b].push([a, 1 / l]); }
  const vGrid = new Map(), VC = 10; V.forEach((v, k) => { const key = Math.floor(v.x / VC) * 100003 + Math.floor(v.z / VC); (vGrid.get(key) || vGrid.set(key, []).get(key)).push(k); });
  const varsNear = (x, z, r) => { const out = []; for (let i = Math.floor((x - r) / VC); i <= Math.floor((x + r) / VC); i++) for (let j = Math.floor((z - r) / VC); j <= Math.floor((z + r) / VC); j++) for (const k of vGrid.get(i * 100003 + j) || []) if (Math.hypot(V[k].x - x, V[k].z - z) <= r) out.push(k); return out; };
  const JN = [], hwAt = new Map(); for (const r of runs) if (!r.minor) for (const v of r.vars) hwAt.set(v, Math.max(hwAt.get(v) || 0, r.hw));
  for (const j of w.net.junctions) { if (!inR(j)) continue; let r = 0; for (let q = 0; q < j.box.length; q += 2) r = Math.max(r, Math.hypot(j.box[q] - j.x, j.box[q + 1] - j.z)); r = Math.min(35, Math.max(6, r)); if (!city) { const v = node.get(j.nd), hw = v != null ? hwAt.get(v) : null; if (hw) r = Math.min(r, Math.max(JR_MIN, JR_K * hw + JR_ADD)); } const m = varsNear(j.x, j.z, r); if (m.length >= 2) JN.push({ x: j.x, z: j.z, r, m, a: 0, b: 0, c: 0 }); }
  const plane = (J) => { const n = J.m.length; let mx = 0, mz = 0, my = 0, W = 0; for (const k of J.m) { const q = pins.has(k) ? PIN_W : 1; mx += q * V[k].x; mz += q * V[k].z; my += q * h[k]; W += q; } mx /= W; mz /= W; my /= W; let a = 0, b = 0, c = 0, d = 0, e = 0; // (a pinned point, a deck's or tube's end, weighs PIN_W: the plane passes through it)
    for (const k of J.m) { const q = pins.has(k) ? PIN_W : 1, X = V[k].x - mx, Z = V[k].z - mz, Y = h[k] - my; a += q * X * X; b += q * X * Z; c += q * Z * Z; d += q * X * Y; e += q * Z * Y; } const det = a * c - b * b; let gx = n >= 3 && Math.abs(det) > 1e-6 ? (d * c - e * b) / det : 0, gz = n >= 3 && Math.abs(det) > 1e-6 ? (e * a - d * b) / det : 0;
    // (members nearly in a line (less than PLANE_ACROSS m RMS across it: a small junction's few stations along a road that runs
    // through it): the slope across that line isn't known from them. Where it came out steeper than CROSS_MAX (up to 220%:
    // a village's pavement 12 m under its street) the plane takes the slope along the line only, level across it)
    { const m2 = (a + c) / 2, r2 = Math.hypot((a - c) / 2, b), lmin = m2 - r2, lmax = m2 + r2; const th = 0.5 * Math.atan2(2 * b, a - c), ux = Math.cos(th), uz = Math.sin(th); J.line = n >= 3 && lmax > 1e-6 && lmin < PLANE_ACROSS * PLANE_ACROSS * n && Math.abs(gz * ux - gx * uz) > CROSS_MAX; if (J.line) { J.wasLine = true; const sl = (d * ux + e * uz) / lmax; gx = sl * ux; gz = sl * uz; } }
    J.mx = mx; J.mz = mz; J.my = my; J.gx = gx; J.gz = gz; };
  const toPlane = () => { for (const J of JN) { plane(J); for (const k of J.m) h[k] = J.my + J.gx * (V[k].x - J.mx) + J.gz * (V[k].z - J.mz); } pinAll(); };
  const clampGrades = (passes) => { for (let p = 0; p < passes; p++) for (const [a, b, l, G] of edges) { const d = h[a] - h[b], lim = G * l; if (Math.abs(d) > lim) { const ex = (Math.abs(d) - lim) / 2 * Math.sign(d); h[a] -= ex; h[b] += ex; } } pinAll(); };
  const WG = opts.WG ?? 0.1; // (the natural ground's pull against the neighbours' 1/l, per station: a weaker pull smoothed hairpins metres off the ground, #297)
  let iters = 0; const wg = new Float64Array(nv).fill(WG); pinAll();
  const smooth = (n) => { for (let it = 0; it < n; it++, iters++) {
    for (let k = 0; k < nv; k++) { const N = nb[k]; if (!N.length) continue; let s = wg[k] * gt[k], ws = wg[k]; for (const [o, wt] of N) { s += wt * h[o]; ws += wt; } h[k] = s / ws; }
    toPlane(); clampGrades(2); lift();
  } };
  smooth(600);
  // (last: each junction on its plane, then every road within its grade limit, away from the junctions: a junction's own
  // slope is its ground's; the clamp leaves a junction's points where they are and moves the road's next to it)
  toPlane(); const memberOf = new Map(); JN.forEach((J, q) => { for (const k of J.m) memberOf.set(k, q); });
  const member = { has: (k) => memberOf.has(k) || pins.has(k) }, inOne = (a, b) => memberOf.has(a) && memberOf.get(a) === memberOf.get(b);
  const enforce = () => { for (let p = 0; p < 400; p++) { let moved = 0; for (const [a, b, l, G] of edges) { if (inOne(a, b)) continue; const d = h[a] - h[b], lim = G * l; if (Math.abs(d) <= lim + 1e-4) continue; const ex = Math.abs(d) - lim, sg = Math.sign(d);
    if ((pins.has(a) && member.has(b)) || (pins.has(b) && member.has(a))) continue; if (member.has(a)) h[b] += ex * sg; else if (member.has(b)) h[a] -= ex * sg; else { h[a] -= ex / 2 * sg; h[b] += ex / 2 * sg; } moved++; } moved += lift(); if (!moved) break; } };
  enforce();
  // (where holding a road to its limit puts it more than RELAX_OFF m off the ground (a pitch steeper than its limit, or a
  // cliff the height grid blurs over it), the limit gives way there: each edge within RELAX_HOPS stations of such a point
  // takes the ground's own grade along it (up to RELAX_MAX) and those points pull to the ground harder; re-solved warm)
  const relaxed = new Set(); T.relax = [];
  for (let round = 0; round < (city ? 0 : RELAX_ROUNDS); round++) { // (a country place's: a city's streets are flat enough)
    let off = new Set(); for (let k = 0; k < nv; k++) if (Math.abs(h[k] - gt[k]) > RELAX_OFF) off.add(k); T.relax.push(off.size); if (!off.size) break;
    for (let hop = 0; hop < RELAX_HOPS; hop++) { const more = new Set(off); for (const k of off) for (const [o] of nb[k]) more.add(o); off = more; }
    for (const e of edges) { const [a, b, l] = e; if (!off.has(a) && !off.has(b)) continue; const gg = Math.min(RELAX_MAX, Math.abs(gt[a] - gt[b]) / l * 1.15 + 0.01); if (gg > e[3]) { e[3] = gg; relaxed.add(e); } }
    for (const k of off) wg[k] = Math.max(wg[k], RELAX_WG);
    smooth(150); toPlane(); enforce();
  }
  T.relaxedEdges = relaxed.size;
  // (a way off the street network that its limit would hold off the ground (a footpath's or a track's zigzags finer than
  // its OSM line, up a hillside steeper than any track): kept within MINOR_OFF m of the ground, over its limit there)
  { const street = new Set(); for (const r of runs) if (!r.minor) for (const v of r.vars) street.add(v); let held = 0;
    for (const r of runs) if (r.minor) for (const v of r.vars) if (!street.has(v) && !member.has(v) && Math.abs(h[v] - gt[v]) > MINOR_OFF) { h[v] = gt[v] + Math.sign(h[v] - gt[v]) * MINOR_OFF; held++; }
    T.minorHeld = held; }
  lift();
  { let low = 0, lifted = 0; for (let k = 0; k < nv; k++) { if (h[k] < floor - 1e-6) low++; if (V[k].g < floor) lifted++; } T.shore = { below: low, overWater: lifted }; } // (stations below the floor after all (0); stations whose ground is under it)
  let dev = 0, over = 0; for (let k = 0; k < nv; k++) dev = Math.max(dev, Math.abs(h[k] - V[k].g)); for (const [a, b, l, G] of edges) if (!inOne(a, b) && G < 0.3) over = Math.max(over, Math.abs(h[a] - h[b]) / l - G);
  T.solve = { linePlanes: JN.filter((J) => J.wasLine).length, shore: T.shore, relax: T.relax, relaxedEdges: T.relaxedEdges, minorHeld: T.minorHeld, vars: nv, junctions: JN.length, iters, maxFromGround: +dev.toFixed(2), worstOverGrade: +Math.max(0, over).toFixed(3) };
  { // (the worst edges over their limit: between which junctions, how long, how far the planes' ends are apart)
    const ov = edges.filter(([a, b]) => !inOne(a, b)).map(([a, b, l, G]) => [Math.abs(h[a] - h[b]) / l - G, a, b, l, G]).filter((e) => e[0] > 1e-3).sort((p, q) => q[0] - p[0]);
    T.overGrade = { edges: ov.length, bothJunctions: ov.filter(([, a, b]) => memberOf.has(a) && memberOf.has(b)).length, worst: ov.slice(0, 4).map(([o, a, b, l, G]) => ({ x: +V[a].x.toFixed(1), z: +V[a].z.toFixed(1), over: +o.toFixed(3), l: +l.toFixed(1), limit: G, rise: +Math.abs(h[a] - h[b]).toFixed(2), ends: [memberOf.has(a) ? 'junction' : V[a].tie ? 'tie' : 'road', memberOf.has(b) ? 'junction' : V[b].tie ? 'tie' : 'road'] })) }; }
  { const inJ = new Map(); JN.forEach((J, q) => J.m.forEach((k) => inJ.set(k, q)));
    const grade = (k) => { let gmax = 0; for (const [o] of nb[k]) { const l = Math.hypot(V[o].x - V[k].x, V[o].z - V[k].z); if (l > 0.5) gmax = Math.max(gmax, Math.abs(V[o].g - V[k].g) / l); } return gmax; };
    const cset = new Set(chunks.map(([ix, iz]) => ix * 100003 + iz)), inC = (k) => cset.has(Math.floor(V[k].x / CHUNK) * 100003 + Math.floor(V[k].z / CHUNK));
    // forced: the steepest the natural ground climbs along the road over 80 m about the point, against its limit
    const forced = (k) => { for (const r of runs) { const i = r.vars.indexOf(k); if (i < 0) continue; let a = i, b = i; while (a > 0 && r.s[i] - r.s[a] < 40) a--; while (b < r.vars.length - 1 && r.s[b] - r.s[i] < 40) b++; const l = r.s[b] - r.s[a]; return l > 20 ? +(Math.abs(V[r.vars[b]].g - V[r.vars[a]].g) / l).toFixed(2) : null; } return null; };
    const ins = [...V.keys()].filter(inC); T.inChunk = { vars: ins.length, maxFromGround: +ins.reduce((m, k) => Math.max(m, Math.abs(h[k] - V[k].g)), 0).toFixed(2), over1m: ins.filter((k) => Math.abs(h[k] - V[k].g) > 1).length, over2m: ins.filter((k) => Math.abs(h[k] - V[k].g) > 2).length, over3m: ins.filter((k) => Math.abs(h[k] - V[k].g) > 3).length, over2mBy: {} };
    { const kindOf = []; for (const r of runs) for (const v of r.vars) if (!kindOf[v] || !r.minor) kindOf[v] = r.kind; for (const k of ins) if (Math.abs(h[k] - V[k].g) > 2) T.inChunk.over2mBy[kindOf[k]] = (T.inChunk.over2mBy[kindOf[k]] || 0) + 1; }
    // (why each is over 2 m: the ground along the road climbs faster than its limit over 80 m (forced); within 150 m of
    // where a road stops at a bridge or tunnel left out (cut); in a junction; else)
    { const cutEnds = []; for (const r of runs) { if (r.cutA) cutEnds.push(r.pts[0]); if (r.cutB) cutEnds.push(r.pts[r.pts.length - 1]); } const cg = new Map(); for (const [x, z] of cutEnds) { const k = Math.floor(x / 150) * 100003 + Math.floor(z / 150); (cg.get(k) || cg.set(k, []).get(k)).push([x, z]); }
      const nearCut = (k) => { const i0 = Math.floor(V[k].x / 150), j0 = Math.floor(V[k].z / 150); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const [x, z] of cg.get(i * 100003 + j) || []) if (Math.hypot(x - V[k].x, z - V[k].z) < 150) return true; return false; };
      const runOf = new Map(); runs.forEach((r) => r.vars.forEach((v) => { if (!runOf.has(v)) runOf.set(v, r); }));
      const why = {}; for (const k of ins) { if (Math.abs(h[k] - V[k].g) <= 2) continue; const f = forced(k), r = runOf.get(k), w = nearCut(k) ? 'cut' : f != null && r && f > r.grade ? 'forced' : inJ.has(k) ? 'junction' : 'other'; why[w] = (why[w] || 0) + 1; } T.inChunk.over2mWhy = why; }
    T.worstIn = ins.sort((a, b) => Math.abs(h[b] - V[b].g) - Math.abs(h[a] - V[a].g)).slice(0, 12).map((k) => ({ x: +V[k].x.toFixed(1), z: +V[k].z.toFixed(1), off: +(h[k] - V[k].g).toFixed(2), grade80m: forced(k), kinds: [...new Set(runs.filter((r) => r.vars.includes(k)).map((r) => r.kind + ':' + r.grade))] }));
    T.worst = [...V.keys()].sort((a, b) => Math.abs(h[b] - V[b].g) - Math.abs(h[a] - V[a].g)).slice(0, 8).map((k) => ({ x: +V[k].x.toFixed(1), z: +V[k].z.toFixed(1), off: +(h[k] - V[k].g).toFixed(2), junction: inJ.has(k) ? { r: +JN[inJ.get(k)].r.toFixed(1), members: JN[inJ.get(k)].m.length, spread: +(Math.max(...JN[inJ.get(k)].m.map((q) => V[q].g)) - Math.min(...JN[inJ.get(k)].m.map((q) => V[q].g))).toFixed(1) } : null, tie: !!V[k].tie, terrainGrade: +grade(k).toFixed(2), kinds: [...new Set(runs.filter((r) => r.vars.includes(k)).map((r) => r.kind + ':' + r.grade))] })); }
  tic('solveMs', t0);
  const street = (r) => !r.minor;
  // the solved height of road r at (x, z) on it (its nearest point along its own stations)
  // (the same, looking only near segment `from` on: stations come in order along the road) -> [height, segment]
  const hv = (r, i) => (r.ys ? r.ys[i] : h[r.vars[i]]); // (a deck's or tube's: its own profile, roads.js)
  const solvedNear = (r, x, z, from) => { let best = Infinity, y = 0, at = from; const a0 = Math.max(0, from - 4), a1 = Math.min(r.pts.length - 1, from + 80);
    for (let i = a0; i < a1; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; y = hv(r, i) + (hv(r, i + 1) - hv(r, i)) * t; at = i; } }
    return best < 0.5 ? [y, at] : [solvedAt(r, x, z), from]; };
  const solvedAt = (r, x, z) => { let best = Infinity, y = 0; for (let i = 0; i + 1 < r.pts.length; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; y = hv(r, i) + (hv(r, i + 1) - hv(r, i)) * t; } } return y; };
  const path = (pts) => pts.map(([x, z]) => [cm(x), cm(z)]);
  // ---- 4. per chunk: its outlines and the network near it, stored; then meshed the game's way, as the bake's check
  const out = [];
  const KCODE = Object.fromEntries(RKINDS.map((k, i) => [k, i]));
  // (each road's shape, simplified once; roads, junctions and plazas listed per chunk they can reach)
  const cellOf = (x, z) => Math.floor(x / CHUNK) * 100003 + Math.floor(z / CHUNK), byCell = new Map(), put = (k, kind, i) => { let c = byCell.get(k); if (!c) byCell.set(k, (c = { r: [], j: [], a: [] })); if (c[kind].at(-1) !== i) c[kind].push(i); };
  const boxCells = (x0, z0, x1, z1, kind, i) => { for (let a = Math.floor(x0 / CHUNK); a <= Math.floor(x1 / CHUNK); a++) for (let b = Math.floor(z0 / CHUNK); b <= Math.floor(z1 / CHUNK); b++) put(a * 100003 + b, kind, i); };
  const allRuns = [...runs, ...offRuns];
  allRuns.forEach((r, ri) => { const sh = rdpLine(r.osmPts.map(([x, z]) => [cm(x), cm(z)]), SHAPE_TOL); r.shape = [sh[0]]; for (let i = 1; i < sh.length; i++) { const [px, pz] = sh[i - 1], [qx, qz] = sh[i], k = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / 30000); for (let s2 = 1; s2 <= k; s2++) r.shape.push([Math.round(px + (qx - px) * s2 / k), Math.round(pz + (qz - pz) * s2 / k)]); }
    for (let i = 0; i + 1 < r.shape.length; i++) { const [ax, az] = r.shape[i], [bx, bz] = r.shape[i + 1]; boxCells(Math.min(ax, bx) / 100 - NET_PAD, Math.min(az, bz) / 100 - NET_PAD, Math.max(ax, bx) / 100 + NET_PAD, Math.max(az, bz) / 100 + NET_PAD, 'r', ri); } });
  JN.forEach((J, q) => boxCells(J.x - NET_PAD - J.r, J.z - NET_PAD - J.r, J.x + NET_PAD + J.r, J.z + NET_PAD + J.r, 'j', q));
  (w.net.areas || []).forEach((ar, q) => boxCells(ar.bb[0] - NET_PAD, ar.bb[1] - NET_PAD, ar.bb[2] + NET_PAD, ar.bb[3] + NET_PAD, 'a', q));
  for (const [ix, iz] of chunks) {
    t0 = performance.now(); const cell = byCell.get(ix * 100003 + iz) || { r: [], j: [], a: [] };
    const x0 = ix * CHUNK, z0 = iz * CHUNK, X0 = cm(x0), Z0 = cm(z0), S = cm(CHUNK);
    const Q = { ix, iz, x0, z0, size: CHUNK, city, runs: [], jn: [], areas: [] };
    // the plazas near it (their rings, int16 steps: longer ones split)
    for (const ar of cell.a.map((q) => w.net.areas[q])) { if (!(ar.bb[2] > x0 - NET_PAD && ar.bb[0] < x0 + CHUNK + NET_PAD && ar.bb[3] > z0 - NET_PAD && ar.bb[1] < z0 + CHUNK + NET_PAD)) continue;
      const rp = []; for (let q = 0; q < ar.ring.length; q += 2) rp.push([cm(ar.ring[q]) - X0, cm(ar.ring[q + 1]) - Z0]); const ring = rdpRing(rp, SHAPE_TOL + 5); if (ring.length < 3) continue;
      const xs = [], zs = []; for (const [X, Z] of ring) { if (xs.length) { const px = xs[xs.length - 1], pz = zs[zs.length - 1], k = Math.ceil(Math.max(Math.abs(X - px), Math.abs(Z - pz)) / 30000); for (let s2 = 1; s2 < k; s2++) { xs.push(Math.round(px + (X - px) * s2 / k)); zs.push(Math.round(pz + (Z - pz) * s2 / k)); } } xs.push(X); zs.push(Z); }
      Q.areas.push({ surf: Math.min(2, ar.surf || 0), x: xs, z: zs }); }
    // the network within NET_PAD of the chunk (every road and junction its rules can reach), quantized
    const near = (x, z, m) => x > x0 - m && x < x0 + CHUNK + m && z > z0 - m && z < z0 + CHUNK + m;
    const segNear = (p, q) => { const m = NET_PAD; return Math.max(p[0], q[0]) > x0 - m && Math.min(p[0], q[0]) < x0 + CHUNK + m && Math.max(p[1], q[1]) > z0 - m && Math.min(p[1], q[1]) < z0 + CHUNK + m; };
    for (const r of cell.r.map((q) => allRuns[q])) {
      // (its shape: simplified once for the whole road, above: every chunk that stores a stretch of it stores the same
      // points, so neighbours work out the same heights and outlines)
      if (!r.shape) { const sh = rdpLine(r.osmPts.map(([x, z]) => [cm(x), cm(z)]), SHAPE_TOL); r.shape = [sh[0]]; for (let i = 1; i < sh.length; i++) { const [px, pz] = sh[i - 1], [qx, qz] = sh[i], k = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / 30000); for (let s2 = 1; s2 <= k; s2++) r.shape.push([Math.round(px + (qx - px) * s2 / k), Math.round(pz + (qz - pz) * s2 / k)]); } }
      const O = r.shape.map(([X, Z]) => [X / 100, Z / 100]); let a = -1, b = -1; for (let i = 0; i + 1 < O.length; i++) if (segNear(O[i], O[i + 1])) { if (a < 0) a = i; b = i + 1; } // (every segment that comes within NET_PAD, long ones passing by too)
      if (a < 0) continue; a = Math.max(0, a - 1); b = Math.min(O.length - 1, b + 1);
      const xs = [], zs = []; for (let i = a; i <= b; i++) { xs.push(r.shape[i][0] - X0); zs.push(r.shape[i][1] - Z0); }
      let cur = 0; const hs = stations(xs, zs, 100).map(([x, z]) => { const o = solvedNear(r, (x + X0) / 100, (z + Z0) / 100, cur); cur = o[1]; return Math.round(o[0] * 100); }); // (walking along the road)
      // (ends: where it stops at a deck or a tube, if this stretch of it reaches that end; flags: a deck's or a tube's own)
      const ends = (a === 0 ? (r.cutA === 'deck' ? 1 : r.cutA === 'tube' ? 2 : 0) : 0) | (b === O.length - 1 ? (r.cutB === 'deck' ? 4 : r.cutB === 'tube' ? 8 : 0) : 0);
      Q.runs.push({ ends, k: KCODE[r.kind] ?? KCODE.other, flags: (r.minor ? 1 : 0) | (r.oneway ? 2 : 0) | (Math.min(3, r.surf) << 2) | (r.off === 'deck' ? 16 : r.off === 'tube' ? 32 : 0), hw: Math.round(r.hw * 10), pave: Math.round(r.pave * 10), lanes: Math.min(255, r.lanes), x: xs, z: zs, h: hs }); }
    // (each way stored as it is, not joined to one it meets end to end: whether it could be depended on which other roads the
    // chunk stores there, so the chunks either side of an edge could see one road or two, and blend their lots differently)
    // the roads and the junctions in order across the chunk, so each start is near the one before
    Q.runs.sort((a, b) => a.x[0] - b.x[0] || a.z[0] - b.z[0]);
    for (const J of cell.j.map((q) => JN[q])) { if (!near(J.x, J.z, NET_PAD + J.r)) continue; const y = J.my + J.gx * (J.x - J.mx) + J.gz * (J.z - J.mz); Q.jn.push({ x: cm(J.x) - X0, z: cm(J.z) - Z0, r: cm(J.r), y: Math.round(y * 1000), gx: Math.round(J.gx * 1e4), gz: Math.round(J.gz * 1e4) }); }
    Q.jn.sort((a, b) => a.x - b.x || a.z - b.z);
    const bytes = encodeLayout(Q);
    T.chunkMs = (T.chunkMs || 0) + performance.now() - t0;
    out.push({ ix, iz, bytes, stats: { areas: Q.areas.length, runs: Q.runs.length, stations: Q.runs.reduce((s, r) => s + r.x.length, 0), junctions: Q.jn.length } });
  }
  return { chunks: out, stats: T };
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
// even-odd point-in-region over a set of rings (centimetres), rows of edges for speed
function regionIndex(paths) {
  const RW = 200, rows = new Map();
  for (const p of paths) for (let k = 0; k < p.length; k++) { const [ax, az] = p[k], [bx, bz] = p[(k + 1) % p.length]; if (az === bz) continue; const e = [ax, az, bx, bz]; for (let r = Math.floor(Math.min(az, bz) / RW); r <= Math.floor(Math.max(az, bz) / RW); r++) (rows.get(r) || rows.set(r, []).get(r)).push(e); }
  return { inside(x, z) { let c = false; for (const [ax, az, bx, bz] of rows.get(Math.floor(z / RW)) || []) if ((az > z) !== (bz > z) && x < ax + (bx - ax) * (z - az) / (bz - az)) c = !c; return c; } };
}
// segments (point index pairs) near a point: clear(X, Z, d) = none within d (cm)
function segIndex(P, E) {
  const C = 400, g = new Map();
  for (const [a, b] of E) { const [ax, az] = P[a], [bx, bz] = P[b]; for (let i = Math.floor(Math.min(ax, bx) / C); i <= Math.floor(Math.max(ax, bx) / C); i++) for (let j = Math.floor(Math.min(az, bz) / C); j <= Math.floor(Math.max(az, bz) / C); j++) { const k = i * 1e6 + j; (g.get(k) || g.set(k, []).get(k)).push([ax, az, bx, bz]); } }
  return { clear(X, Z, d) { for (let i = Math.floor((X - d) / C); i <= Math.floor((X + d) / C); i++) for (let j = Math.floor((Z - d) / C); j <= Math.floor((Z + d) / C); j++) for (const [ax, az, bx, bz] of g.get(i * 1e6 + j) || []) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((X - ax) * dx + (Z - az) * dz) / L2)); if (Math.hypot(X - ax - dx * t, Z - az - dz * t) < d) return false; } return true; } };
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
function bool(type, a, b) { const c = new CL.Clipper(); c.AddPaths(toC(a), CL.PolyType.ptSubject, true); if (b?.length) c.AddPaths(toC(b), CL.PolyType.ptClip, true); const s = new CL.Paths(); c.Execute(type, s, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero); return fromC(s); }
function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; } return a / 2; }
// a closed ring simplified (Ramer-Douglas-Peucker, eps in its units), split at its two furthest-apart corners
function rdpRing(r, eps) {
  if (r.length < 5) return r;
  let far = 0, fd = -1; for (let i = 1; i < r.length; i++) { const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(r.length); keep[0] = keep[far] = 1;
  const go = (a, b) => { const n = b - a; if (n < 2) return; const [ax, az] = r[a % r.length], [bx, bz] = r[b % r.length], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1; let m = -1, md = eps;
    for (let i = a + 1; i < b; i++) { const [x, z] = r[i % r.length], d = Math.abs(dx * (z - az) - dz * (x - ax)) / L; if (d > md) { md = d; m = i; } } if (m >= 0) { keep[m % r.length] = 1; go(a, m); go(m, b); } };
  go(0, far); go(far, r.length);
  return r.filter((_, i) => keep[i]);
}
// distance (cm) from a point to the nearest edge of a set of rings, capped at max
function distIndex(rings) {
  const C = 400, g = new Map();
  for (const r of rings) for (let k = 0; k < r.length; k++) { const [ax, az] = r[k], [bx, bz] = r[(k + 1) % r.length]; for (let i = Math.floor(Math.min(ax, bx) / C); i <= Math.floor(Math.max(ax, bx) / C); i++) for (let j = Math.floor(Math.min(az, bz) / C); j <= Math.floor(Math.max(az, bz) / C); j++) { const q = i * 1e6 + j; (g.get(q) || g.set(q, []).get(q)).push([ax, az, bx, bz]); } }
  return { dist(X, Z, max) { let best = max; for (let i = Math.floor((X - max) / C); i <= Math.floor((X + max) / C); i++) for (let j = Math.floor((Z - max) / C); j <= Math.floor((Z + max) / C); j++) for (const [ax, az, bx, bz] of g.get(i * 1e6 + j) || []) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((X - ax) * dx + (Z - az) * dz) / L2)), d = Math.hypot(X - ax - dx * t, Z - az - dz * t); if (d < best) best = d; } return best; } };
}
// an open line simplified (Ramer-Douglas-Peucker, eps in its units), its ends kept
function rdpLine(p, eps) {
  if (p.length < 3) return p; const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const go = (a, b) => { const [ax, az] = p[a], [bx, bz] = p[b], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1; let m = -1, md = eps; for (let i = a + 1; i < b; i++) { const d = Math.abs(dx * (p[i][1] - az) - dz * (p[i][0] - ax)) / L; if (d > md) { md = d; m = i; } } if (m >= 0) { keep[m] = 1; go(a, m); go(m, b); } };
  go(0, p.length - 1); return p.filter((_, i) => keep[i]);
}
// a country place's built-up stretches (PAVE_VILLAGE): built(P, i, e) -> per segment of P[i..e], whether it's built up
function builtUp(w) {
  const C = 50, grid = new Map();
  for (const b of w.real.osm?.buildings || []) { const r = b[b.length - 1]; if (!r?.length) continue; let x = 0, z = 0; const n = r.length / 2; for (let q = 0; q < r.length; q += 2) { x += r[q]; z += r[q + 1]; } x /= n; z /= n; const k = Math.floor(x / C) * 100003 + Math.floor(z / C); (grid.get(k) || grid.set(k, []).get(k)).push(x, z); }
  const count = (a, b) => { let c = 0; const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    for (let i = Math.floor((Math.min(a.x, b.x) - BUILT_D) / C); i <= Math.floor((Math.max(a.x, b.x) + BUILT_D) / C); i++) for (let j = Math.floor((Math.min(a.z, b.z) - BUILT_D) / C); j <= Math.floor((Math.max(a.z, b.z) + BUILT_D) / C); j++) { const L = grid.get(i * 100003 + j); if (!L) continue;
      for (let q = 0; q < L.length; q += 2) { const t = Math.max(0, Math.min(1, ((L[q] - a.x) * dx + (L[q + 1] - a.z) * dz) / L2)); if (Math.hypot(L[q] - a.x - dx * t, L[q + 1] - a.z - dz * t) <= BUILT_D) c++; } } return c; };
  return (P, i, e) => {
    const n = e - i, cnt = [], len = [], mid = []; let s = 0;
    for (let k = 0; k < n; k++) { const a = P[i + k], b = P[i + k + 1], l = Math.hypot(b.x - a.x, b.z - a.z); cnt.push(count(a, b)); len.push(l); mid.push(s + l / 2); s += l; }
    const f = cnt.map((_, k) => { let c = 0, l = 0; for (let q = 0; q < n; q++) if (Math.abs(mid[q] - mid[k]) <= BUILT_WIN / 2 || q === k) { c += cnt[q]; l += len[q]; } return (c * 100) / Math.max(l, 1) >= BUILT_N; });
    for (const want of [true, false]) { for (let k = 0; k < n;) { let e2 = k, l = 0; while (e2 < n && f[e2] === f[k]) l += len[e2++]; if (f[k] === want && l < BUILT_MIN && (want || (k > 0 && e2 < n))) for (let q = k; q < e2; q++) f[q] = !want; k = e2; } }
    return f;
  };
}
