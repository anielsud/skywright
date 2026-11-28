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
import { diveProfile, twinAnd, DIVE_K, TUBE_STEP, COVER as TUBE_COVER } from './tubes.js';
import { naturalGround, TUBE_H, TUBE_SIDE, DECK_SIDE, DECK_DEPTH } from './rules.js';

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
// the railways (OpenStreetMap's, bake.py rail_entry: by class): a main or branch line, a yard's or siding's track, a narrow-gauge
// line, a rack railway (the Wengernalpbahn: 25%), a funicular (it follows its hillside: 60% and more). The bed's half width:
// about 3 m of ballast per track plus its shoulders (each OSM way one track: a yard's tracks side by side join into one bed)
export const RAIL_GRADE = [0.04, 0.04, 0.07, 0.25, 1], RAIL_HW = [2.1, 2, 1.8, 1.6, 1.5], RAIL_CLASS = ['main', 'service', 'narrow', 'rack', 'funicular'];
// a level crossing (a railway crossing a road on the ground: they're tied there): a plane like a junction's over both, out past
// the corners where the road's strip and the bed cross, LX_ADD m more (LX_MIN..LX_MAX)
const LX_ADD = 0.75, LX_MIN = 4, LX_MAX = 35, VERTEX_AT = 0.3;
// the shore (a place on the sea, loc.shore): a road (none of them bridges here) is held at least FREEBOARD m above the
// world's water level: the height grid blurs a coastal road's narrow strip of land between the hillside and the lagoon,
// and a motu's paths, down into the water
const FREEBOARD = 0.5, WET = 0.5;
const PLANE_ACROSS = 0.5, CROSS_MAX = 0.3;
const RELAX_OFF = 2, RELAX_HOPS = 3, RELAX_MAX = 1, RELAX_STREET = 0.3, RELAX_MAIN = 0.2, RELAX_WG = 1, RELAX_ROUNDS = 4;
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
  const offRuns = [], pins = new Map(), pinNode = new Map(), endNode = new Map();
  for (const rd of [...w.net.roads, ...railWays(w, g)]) {
    if (rd.kind === 'rail' && rd.rail == null) continue; // (a made-up place's one rail line, roads.js: not the layout's)
    const n0 = rd.pts.length, P = rd.closed ? [...rd.pts, rd.pts[0]] : rd.pts, n = P.length; let a = -1, b = -1; // (a roundabout's ring: closed as a line)
    for (let i = 0; i < n; i++) if (inR(P[i])) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    a = Math.max(0, a - 1); b = Math.min(n - 1, b + 1);
    // (on the sea, loc.shore: a way off the street network out in the water isn't the layout's either: a resort's walkway out
    // to its overwater bungalows, on a pier the game draws as its deck)
    const wet = (i) => rd.minor && g(P[i % n0].x, P[i % n0].z) < wl - WET;
    const off = (i) => (rd.baked || (rd.bridge?.[i % n0] && rd.bridge?.[(i + 1) % n0]) ? 'deck' : rd.tube?.[i % n0] && rd.tube?.[(i + 1) % n0] ? (rd.railsOnly ? 'rails' : 'tube') : wet(i) || wet(i + 1) ? 'wet' : null), jn = new Map(rd.jn || []), cut = (t) => (t === 'wet' ? null : t);
    for (let s0 = a; s0 < b;) {
      const ty = off(s0); let e0 = s0 + 1; while (e0 < b && off(e0) === ty) e0++;
      if (ty === 'wet') { s0 = e0; continue; }
      if (ty) { const pts = [], ys = []; for (let i = s0; i <= e0; i++) { pts.push([P[i].x, P[i].z]); ys.push(P[i].y); const nd = jn.get(i % n0); if (nd != null && !pinNode.has(nd)) pinNode.set(nd, P[i].y); if (nd != null && (i === s0 || i === e0) && !endNode.has(nd)) endNode.set(nd, ty); }
        offRuns.push({ rail: rd.rail ?? -1, off: ty, rd, keepAll: !!rd.keepShape, osmPts: pts, pts, ys, kind: rd.kind, minor: !!rd.minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, pave: 0 }); s0 = e0; continue; }
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
        const minor = !!rd.minor, kind = rd.kind, rail = rd.rail ?? -1, cutA = s1 === s0 ? cA : null, cutB = e1 === e0 ? cB : null;
        if (cutA) pins.set(vars[0], P[s1].y); if (cutB) pins.set(vars[vars.length - 1], P[e1].y);
        if (rd.pinA != null && s1 === 0) pins.set(vars[0], rd.pinA); if (rd.pinB != null && e1 === n - 1) pins.set(vars[vars.length - 1], rd.pinB); // (a railway ending on a double tube's portal beside its track: bake.js mergeBores)
        runs.push({ rail, cutA, cutB, rd, osmPts: osm.map((k) => pts[k]), kind, minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, layer: rd.layer || 0, pts, vars, grade: rail >= 0 ? RAIL_GRADE[rail] : minor ? GRADE_MINOR[kind] ?? 0.3 : (city ? GRADE_CITY : GRADE)[kind] ?? 0.2, pave: city && !minor && !rd.baked && PAVE[kind] ? PAVE[kind] : village ? PAVE_VILLAGE : 0 });
      }
      s0 = e0;
    }
  }
  for (const [nd, y] of pinNode) { const v = node.get(nd); if (v != null && !pins.has(v)) pins.set(v, y); }
  // (a road ending where a deck or tube ends (a whole-bridge way, bake.py's decks over water) ends there as at a cut)
  // (a railway's: a deck's or a tube's, by which it ends at: a tube's portal is an opening)
  { const at = new Map(); for (const [nd, ty] of endNode) { const v = node.get(nd); if (v != null) at.set(v, ty); }
    for (const r of runs) { const c = (v) => (r.rail >= 0 ? at.get(v) : 'deck'); if (!r.cutA && at.has(r.vars[0])) r.cutA = c(r.vars[0]); if (!r.cutB && at.has(r.vars[r.vars.length - 1])) r.cutB = c(r.vars[r.vars.length - 1]); } }
  const pinAll = () => { for (const [k, y] of pins) h[k] = y; };
  // (roads crossing without a shared node, on the same layer: tied at the crossing)
  const lxAt = [], eqs = []; // (the level crossings; two points to be at one height)
  const lxOf = (A, B, x, z, ax, az, bx, bz, cx, cz, dx, dz) => { const [R, T] = A.rail >= 0 ? [B, A] : [A, B], la = Math.hypot(bx - ax, bz - az) || 1, lb = Math.hypot(dx - cx, dz - cz) || 1, c = Math.abs(((bx - ax) * (dx - cx) + (bz - az) * (dz - cz)) / la / lb), sn = Math.max(0.2, Math.sqrt(Math.max(0, 1 - c * c)));
    const a = R.hw + (R.pave || 0), b = T.hw; return { x, z, r: Math.min(LX_MAX, Math.max(LX_MIN, Math.sqrt(a * a + b * b + 2 * a * b * c) / sn + LX_ADD)) }; };
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
      if ((A.rail >= 0) !== (B.rail >= 0)) lxAt.push(lxOf(A, B, x, z, ax, az, bx, bz, cx, cz, dx, dz));
    }
    // (a railway crossing a road on the ground (a level crossing; or another railway, a diamond): where the crossing is one of
    // their own points (OpenStreetMap's crossing node: within VERTEX_AT m of it) the other is tied to that point; both: one
    // to the other, level (eqs). A road's crossings with a road are as above)
    const seenX = new Set();
    for (const list of segGrid.values()) for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const [ra, sa] = list[p], [rb, sb] = list[q], A = runs[ra], B = runs[rb]; if (ra === rb || A.layer !== B.layer || !(A.rail >= 0 || B.rail >= 0)) continue;
      const [ax, az] = A.pts[sa], [bx, bz] = A.pts[sa + 1], [cx, cz] = B.pts[sb], [dx, dz] = B.pts[sb + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx); if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den, lA = Math.hypot(bx - ax, bz - az), lB = Math.hypot(dx - cx, dz - cz);
      if (t < -VERTEX_AT / lA || t > 1 + VERTEX_AT / lA || u < -VERTEX_AT / lB || u > 1 + VERTEX_AT / lB) continue;
      const inA = t > 0.02 && t < 0.98, inB = u > 0.02 && u < 0.98; if (inA && inB) continue; // (both inside their segments: tied above)
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, id = Math.min(ra, rb) + ':' + Math.max(ra, rb) + ':' + Math.round(x * 2) + ',' + Math.round(z * 2); if (seenX.has(id)) continue; seenX.add(id);
      const vA = t * lA < VERTEX_AT ? A.vars[sa] : (1 - t) * lA < VERTEX_AT ? A.vars[sa + 1] : null, vB = u * lB < VERTEX_AT ? B.vars[sb] : (1 - u) * lB < VERTEX_AT ? B.vars[sb + 1] : null;
      if (vA != null && vA === vB) continue;
      if (vA == null && vB == null) continue; // (near a segment's end but past it: the next segment's crossing)
      if (vA != null && vB != null) eqs.push([vA, vB]); else if (vA != null) { if (!inB) continue; ins[rb].push([sb, u, x, z, vA]); V[vA].tie = true; } else { if (!inA) continue; ins[ra].push([sa, t, x, z, vB]); V[vB].tie = true; }
      if ((A.rail >= 0) !== (B.rail >= 0)) lxAt.push(lxOf(A, B, x, z, ax, az, bx, bz, cx, cz, dx, dz));
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
  const lo = crownFloor(V, runs, offRuns, pins, floor, T); // (each station's lowest: the floor, or over a tube near its portal its crown's)
  const up = deckCeil(V, runs, offRuns, pins, T); /* (each station's highest: under a rail deck over it, its underside less the clearance) */
  const lift = () => { let n = 0; for (let k = 0; k < nv; k++) { if (h[k] < lo[k]) { if (!pins.has(k)) { h[k] = lo[k]; n++; } } else if (h[k] > up[k] && !pins.has(k)) { h[k] = up[k]; n++; } } return n; }; /* (the bounds first: a pin's lookup only where one applies) */
  for (const r of runs) for (let i = 0; i + 1 < r.vars.length; i++) { const a = r.vars[i], b = r.vars[i + 1]; if (a === b) continue; const l = Math.max(0.5, r.s[i + 1] - r.s[i]); edges.push([a, b, l, r.grade, r.rail, r.grade]); nb[a].push([b, 1 / l]); nb[b].push([a, 1 / l]); }
  for (const [a, b] of eqs) { edges.push([a, b, 0.5, 0, -1, 0]); nb[a].push([b, 2]); nb[b].push([a, 2]); } // (a crossing at both ways' own points: level)
  const railVar = new Set(); for (const r of runs) if (r.rail >= 0) for (const v of r.vars) railVar.add(v);
  // (the solve's inner loops read typed copies, in the same order with the same values: the same arithmetic, faster. EG
  // is each edge's grade limit (edges[e][3] kept with it); nbAt/nbO/nbW each station's neighbours, as nb's; isPin: pins)
  const ne = edges.length, EA = Int32Array.from(edges, (e) => e[0]), EB = Int32Array.from(edges, (e) => e[1]), EL = Float64Array.from(edges, (e) => e[2]), EG = Float64Array.from(edges, (e) => e[3]);
  const nbAt = new Int32Array(nv + 1); for (let k = 0; k < nv; k++) nbAt[k + 1] = nbAt[k] + nb[k].length; const nbO = new Int32Array(nbAt[nv]), nbW = new Float64Array(nbAt[nv]);
  for (let k = 0; k < nv; k++) nb[k].forEach(([o, wt], q) => { nbO[nbAt[k] + q] = o; nbW[nbAt[k] + q] = wt; });
  const VX = Float64Array.from(V, (v) => v.x), VZ = Float64Array.from(V, (v) => v.z), isPin = new Uint8Array(nv); for (const k of pins.keys()) isPin[k] = 1;
  const vGrid = new Map(), VC = 10; V.forEach((v, k) => { const key = Math.floor(v.x / VC) * 100003 + Math.floor(v.z / VC); (vGrid.get(key) || vGrid.set(key, []).get(key)).push(k); });
  const varsNear = (x, z, r) => { const out = []; for (let i = Math.floor((x - r) / VC); i <= Math.floor((x + r) / VC); i++) for (let j = Math.floor((z - r) / VC); j <= Math.floor((z + r) / VC); j++) for (const k of vGrid.get(i * 100003 + j) || []) if (Math.hypot(V[k].x - x, V[k].z - z) <= r) out.push(k); return out; };
  const JN = [], hwAt = new Map(); for (const r of runs) if (!r.minor) for (const v of r.vars) hwAt.set(v, Math.max(hwAt.get(v) || 0, r.hw));
  for (const j of w.net.junctions) { if (!inR(j)) continue; let r = 0; for (let q = 0; q < j.box.length; q += 2) r = Math.max(r, Math.hypot(j.box[q] - j.x, j.box[q + 1] - j.z)); r = Math.min(35, Math.max(6, r)); if (!city) { const v = node.get(j.nd), hw = v != null ? hwAt.get(v) : null; if (hw) r = Math.min(r, Math.max(JR_MIN, JR_K * hw + JR_ADD)); } const m = varsNear(j.x, j.z, r); if (m.length >= 2) JN.push({ x: j.x, z: j.z, r, m, a: 0, b: 0, c: 0 }); }
  for (const X of lxAt) { if (!inR(X)) continue; const m = varsNear(X.x, X.z, X.r); if (m.length >= 2) JN.push({ x: X.x, z: X.z, r: X.r, m, lx: true, a: 0, b: 0, c: 0 }); } // (the level crossings: rules.js streetH)
  const plane = (J) => { const n = J.m.length; let mx = 0, mz = 0, my = 0, W = 0; for (const k of J.m) { const q = isPin[k] ? PIN_W : 1; mx += q * VX[k]; mz += q * VZ[k]; my += q * h[k]; W += q; } mx /= W; mz /= W; my /= W; let a = 0, b = 0, c = 0, d = 0, e = 0; // (a pinned point, a deck's or tube's end, weighs PIN_W: the plane passes through it)
    for (const k of J.m) { const q = isPin[k] ? PIN_W : 1, X = VX[k] - mx, Z = VZ[k] - mz, Y = h[k] - my; a += q * X * X; b += q * X * Z; c += q * Z * Z; d += q * X * Y; e += q * Z * Y; } const det = a * c - b * b; let gx = n >= 3 && Math.abs(det) > 1e-6 ? (d * c - e * b) / det : 0, gz = n >= 3 && Math.abs(det) > 1e-6 ? (e * a - d * b) / det : 0;
    // (members nearly in a line (less than PLANE_ACROSS m RMS across it: a small junction's few stations along a road that runs
    // through it): the slope across that line isn't known from them. Where it came out steeper than CROSS_MAX (up to 220%:
    // a village's pavement 12 m under its street) the plane takes the slope along the line only, level across it)
    { const m2 = (a + c) / 2, r2 = Math.hypot((a - c) / 2, b), lmin = m2 - r2, lmax = m2 + r2; const th = 0.5 * Math.atan2(2 * b, a - c), ux = Math.cos(th), uz = Math.sin(th); J.line = n >= 3 && lmax > 1e-6 && lmin < PLANE_ACROSS * PLANE_ACROSS * n && Math.abs(gz * ux - gx * uz) > CROSS_MAX; if (J.line) { J.wasLine = true; const sl = (d * ux + e * uz) / lmax; gx = sl * ux; gz = sl * uz; } }
    J.mx = mx; J.mz = mz; J.my = my; J.gx = gx; J.gz = gz; };
  const toPlane = () => { for (const J of JN) { plane(J); const { my, gx, gz, mx, mz } = J; for (const k of J.m) h[k] = my + gx * (VX[k] - mx) + gz * (VZ[k] - mz); } pinAll(); };
  const clampGrades = (passes) => { for (let p = 0; p < passes; p++) for (let e = 0; e < ne; e++) { const a = EA[e], b = EB[e], d = h[a] - h[b], lim = EG[e] * EL[e]; if (Math.abs(d) > lim) { const ex = (Math.abs(d) - lim) / 2 * Math.sign(d); h[a] -= ex; h[b] += ex; } } pinAll(); };
  const WG = opts.WG ?? 0.1; // (the natural ground's pull against the neighbours' 1/l, per station: a weaker pull smoothed hairpins metres off the ground, #297)
  let iters = 0; const wg = new Float64Array(nv).fill(WG); pinAll();
  const smooth = (n) => { for (let it = 0; it < n; it++, iters++) {
    for (let k = 0; k < nv; k++) { const q0 = nbAt[k], q1 = nbAt[k + 1]; if (q0 === q1) continue; let s = wg[k] * gt[k], ws = wg[k]; for (let q = q0; q < q1; q++) { const wt = nbW[q]; s += wt * h[nbO[q]]; ws += wt; } h[k] = s / ws; }
    toPlane(); clampGrades(2); lift();
  } };
  smooth(600);
  // (last: each junction on its plane, then every road within its grade limit, away from the junctions: a junction's own
  // slope is its ground's; the clamp leaves a junction's points where they are and moves the road's next to it)
  toPlane(); const memberOf = new Map(); JN.forEach((J, q) => { for (const k of J.m) memberOf.set(k, q); });
  const member = { has: (k) => memberOf.has(k) || pins.has(k) }, inOne = (a, b) => memberOf.has(a) && memberOf.get(a) === memberOf.get(b);
  const isMem = new Uint8Array(nv), one = new Uint8Array(ne); for (let k = 0; k < nv; k++) isMem[k] = member.has(k) ? 1 : 0; for (let e = 0; e < ne; e++) one[e] = inOne(EA[e], EB[e]) ? 1 : 0; // (enforce's: typed, as above)
  const enforce = () => { for (let p = 0; p < 400; p++) { let moved = 0; for (let e = 0; e < ne; e++) { if (one[e]) continue; const a = EA[e], b = EB[e], d = h[a] - h[b], lim = EG[e] * EL[e]; if (Math.abs(d) <= lim + 1e-4) continue; const ex = Math.abs(d) - lim, sg = Math.sign(d);
    if ((isPin[a] && isMem[b]) || (isPin[b] && isMem[a])) continue; if (isMem[a]) h[b] += ex * sg; else if (isMem[b]) h[a] -= ex * sg; else { h[a] -= ex / 2 * sg; h[b] += ex / 2 * sg; } moved++; } moved += lift(); if (!moved) break; } };
  enforce();
  // (where holding a road to its limit puts it more than RELAX_OFF m off the ground (a pitch steeper than its limit, or a
  // cliff the height grid blurs over it), the limit gives way there: each edge within RELAX_HOPS stations of such a point
  // takes the ground's own grade along it (up to RELAX_MAX) and those points pull to the ground harder; re-solved warm)
  const relaxed = new Set(); T.relax = [];
  for (let round = 0; round < (city && !railVar.size ? 0 : RELAX_ROUNDS); round++) { // (a country place's: a city's streets are flat enough; its railways aren't)
    let off = new Set(); for (let k = 0; k < nv; k++) if (Math.abs(h[k] - gt[k]) > RELAX_OFF && (!city || railVar.has(k))) off.add(k); T.relax.push(off.size); if (!off.size) break;
    for (let hop = 0; hop < RELAX_HOPS; hop++) { const more = new Set(off); for (const k of off) for (const [o] of nb[k]) more.add(o); off = more; }
    edges.forEach((e, q) => { const [a, b, l] = e; if ((!off.has(a) && !off.has(b)) || (city && !(e[4] >= 0))) return; const gg = Math.min(e[4] >= 0 || e[5] >= RELAX_STREET ? RELAX_MAX : e[5] <= GRADE.main ? RELAX_MAIN : RELAX_STREET, Math.abs(gt[a] - gt[b]) / l * 1.15 + 0.01); /* (a main road or a highway no steeper than RELAX_MAIN, a street than RELAX_STREET (a minor way, a railway: RELAX_MAX): past that the height grid's cliff or blur, not a road; it stands off the ground on its banks instead) */ if (gg > e[3]) { e[3] = EG[q] = gg; relaxed.add(e); } });
    for (const k of off) if (!city || railVar.has(k)) wg[k] = Math.max(wg[k], RELAX_WG);
    smooth(150); toPlane(); enforce();
  }
  T.relaxedEdges = relaxed.size;
  // (a way off the street network that its limit would hold off the ground (a footpath's or a track's zigzags finer than
  // its OSM line, up a hillside steeper than any track): kept within MINOR_OFF m of the ground, over its limit there)
  { const street = new Set(); for (const r of runs) if (!r.minor) for (const v of r.vars) street.add(v); let held = 0;
    for (const r of runs) if (r.minor && r.rail < 0) for (const v of r.vars) if (!street.has(v) && !railVar.has(v) && !member.has(v) && Math.abs(h[v] - gt[v]) > MINOR_OFF) { h[v] = gt[v] + Math.sign(h[v] - gt[v]) * MINOR_OFF; held++; }
    T.minorHeld = held; }
  lift();
  // (constraints the solve can't meet (pins over a grade limit) leave stations NaN, and the network about them with them: each
  // put back on its ground, counted and logged, so one infeasible tunnel never takes the network to 0)
  { let bad = 0; for (let k = 0; k < nv; k++) if (!Number.isFinite(h[k])) { h[k] = pins.has(k) ? pins.get(k) : V[k].g; bad++; } T.infeasible = bad; if (bad) log(`  [layout] height solve: ${bad} stations not finite, put back on their pin or ground`); }
  { let low = 0, lifted = 0; for (let k = 0; k < nv; k++) { if (h[k] < floor - 1e-6) low++; if (V[k].g < floor) lifted++; } T.shore = { below: low, overWater: lifted }; } // (stations below the floor after all (0); stations whose ground is under it)
  let dev = 0, over = 0; for (let k = 0; k < nv; k++) dev = Math.max(dev, Math.abs(h[k] - V[k].g)); for (const [a, b, l, G] of edges) if (!inOne(a, b) && G < 0.3) over = Math.max(over, Math.abs(h[a] - h[b]) / l - G);
  // the railways' grades against their class's limit (relaxed or not: how far over the limit, where the ground is steeper)
  { const R = {}; for (const e of edges) { const [a, b, l, , c, G0] = e; if (!(c >= 0) || inOne(a, b)) continue; const k = RAIL_CLASS[c], o = Math.abs(h[a] - h[b]) / l - G0, q = R[k] || (R[k] = { edges: 0, km: 0, over: 0, overRelaxed: 0, max: 0, limit: G0 }); q.edges++; q.km += l / 1000; if (o > 1e-3) { q.over++; if (e[3] > G0) q.overRelaxed++; q.max = Math.max(q.max, o); } }
    for (const q of Object.values(R)) { q.km = +q.km.toFixed(1); q.max = +q.max.toFixed(3); } T.rail = { grades: R, levelCrossings: JN.filter((J) => J.lx).length, eqs: eqs.length }; }
  T.solve = { infeasible: T.infeasible, linePlanes: JN.filter((J) => J.wasLine).length, shore: T.shore, crown: T.crown, deckCeil: T.deckCeil, relax: T.relax, relaxedEdges: T.relaxedEdges, minorHeld: T.minorHeld, vars: nv, junctions: JN.length, iters, maxFromGround: +dev.toFixed(2), worstOverGrade: +Math.max(0, over).toFixed(3) };
  { // (the worst edges over their limit: between which junctions, how long, how far the planes' ends are apart)
    const ov = edges.filter(([a, b]) => !inOne(a, b)).map(([a, b, l, G]) => [Math.abs(h[a] - h[b]) / l - G, a, b, l, G]).filter((e) => e[0] > 1e-3).sort((p, q) => q[0] - p[0]);
    T.overGrade = { edges: ov.length, bothJunctions: ov.filter(([, a, b]) => memberOf.has(a) && memberOf.has(b)).length, worst: ov.slice(0, 4).map(([o, a, b, l, G]) => ({ x: +V[a].x.toFixed(1), z: +V[a].z.toFixed(1), over: +o.toFixed(3), l: +l.toFixed(1), limit: G, rise: +Math.abs(h[a] - h[b]).toFixed(2), ends: [memberOf.has(a) ? 'junction' : V[a].tie ? 'tie' : 'road', memberOf.has(b) ? 'junction' : V[b].tie ? 'tie' : 'road'] })) }; }
  { const inJ = new Map(); JN.forEach((J, q) => J.m.forEach((k) => inJ.set(k, q)));
    const grade = (k) => { let gmax = 0; for (const [o] of nb[k]) { const l = Math.hypot(V[o].x - V[k].x, V[o].z - V[k].z); if (l > 0.5) gmax = Math.max(gmax, Math.abs(V[o].g - V[k].g) / l); } return gmax; };
    const cset = new Set(chunks.map(([ix, iz]) => ix * 100003 + iz)), inC = (k) => cset.has(Math.floor(V[k].x / CHUNK) * 100003 + Math.floor(V[k].z / CHUNK));
    // forced: the steepest the natural ground climbs along the road over 80 m about the point, against its limit
    const firstAt = new Map(); for (const r of runs) r.vars.forEach((v, i) => { if (!firstAt.has(v)) firstAt.set(v, [r, i]); }); // (each station's first road and place on it, as runs.find + indexOf)
    const forced = (k) => { const f = firstAt.get(k); if (!f) return null; const [r, i] = f; let a = i, b = i; while (a > 0 && r.s[i] - r.s[a] < 40) a--; while (b < r.vars.length - 1 && r.s[b] - r.s[i] < 40) b++; const l = r.s[b] - r.s[a]; return l > 20 ? +(Math.abs(V[r.vars[b]].g - V[r.vars[a]].g) / l).toFixed(2) : null; };
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
  allRuns.forEach((r, ri) => { const sh = r.ceil ? keepLine(r) : r.keepAll ? r.osmPts.map(([x, z]) => [cm(x), cm(z)]) : rdpLine(r.osmPts.map(([x, z]) => [cm(x), cm(z)]), SHAPE_TOL); r.shape = [sh[0]]; for (let i = 1; i < sh.length; i++) { const [px, pz] = sh[i - 1], [qx, qz] = sh[i], k = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / 30000); for (let s2 = 1; s2 <= k; s2++) r.shape.push([Math.round(px + (qx - px) * s2 / k), Math.round(pz + (qz - pz) * s2 / k)]); }
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
      Q.runs.push({ ends, k: KCODE[r.kind] ?? KCODE.other, flags: (r.minor ? 1 : 0) | (r.oneway ? 2 : 0) | (Math.min(3, r.surf) << 2) | (r.off === 'deck' ? 16 : r.off === 'tube' ? 32 : r.off === 'rails' ? 64 : 0), hw: Math.round(r.hw * 10), pave: Math.round(r.pave * 10), lanes: r.rail >= 0 ? r.rail : Math.min(255, r.lanes), x: xs, z: zs, h: hs }); } // (a railway's lanes: its class, RAIL_CLASS)
    // (each way stored as it is, not joined to one it meets end to end: whether it could be depended on which other roads the
    // chunk stores there, so the chunks either side of an edge could see one road or two, and blend their lots differently)
    // the roads and the junctions in order across the chunk, so each start is near the one before
    Q.runs.sort((a, b) => a.x[0] - b.x[0] || a.z[0] - b.z[0]);
    for (const J of cell.j.map((q) => JN[q])) { if (!near(J.x, J.z, NET_PAD + J.r)) continue; const y = J.my + J.gx * (J.x - J.mx) + J.gz * (J.z - J.mz); Q.jn.push({ x: cm(J.x) - X0, z: cm(J.z) - Z0, r: J.lx ? -cm(J.r) : cm(J.r), y: Math.round(y * 1000), gx: Math.round(J.gx * 1e4), gz: Math.round(J.gz * 1e4) }); }
    Q.jn.sort((a, b) => a.x - b.x || a.z - b.z);
    const bytes = encodeLayout(Q);
    T.chunkMs = (T.chunkMs || 0) + performance.now() - t0;
    out.push({ ix, iz, bytes, stats: { areas: Q.areas.length, runs: Q.runs.length, stations: Q.runs.reduce((s, r) => s + r.x.length, 0), junctions: Q.jn.length } });
  }
  return { chunks: out, stats: T };
}

// the railways (World.real.osm.rails: bake.py rail_entry) as the network's ways: a way off the street network (minor) of kind
// 'rail' and its class (rail); one on a bridge all deck, one in a tunnel all tube (side-by-side bores as one: mergeBores), at the straight line between the natural
// ground at its ends (a viaduct's ways end to end: one line each, meeting at their shared ends). Their points shared with
// another railway's (a switch; ways end to end: OpenStreetMap's shared node, the same point to the decimetre) are one node.
// a line (flat x, z, ...) with points every step m along it
function densifyLine(f, step) { const out = [f[0], f[1]]; for (let k = 2; k < f.length; k += 2) { const ax = f[k - 2], az = f[k - 1], bx = f[k], bz = f[k + 1], m = Math.ceil(Math.hypot(bx - ax, bz - az) / step); for (let j = 1; j < m; j++) out.push(ax + (bx - ax) * j / m, az + (bz - az) * j / m); out.push(bx, bz); } return out; }
function railWays(w, g) {
  const list = deckProfiles(mergeBores(w.real?.osm?.rails || [], g), w, g), key = (x, z) => 'R' + Math.round(x * 10) + ',' + Math.round(z * 10), uses = new Map();
  for (const [, , f] of list) { const seen = new Set(); for (let k = 0; k < f.length; k += 2) { const q = key(f[k], f[k + 1]); if (!seen.has(q)) { seen.add(q); uses.set(q, (uses.get(q) || 0) + 1); } } }
  const out = [];
  const dived = []; // (the tunnels dived: tubes.js twinAnd over them all)
  for (const [, br, f0, cls = 0, tun = 0, extra = {}] of list) { const f = tun && !br && !extra.ys ? densifyLine(f0, TUBE_STEP) : f0, n = f.length / 2; if (n < 2) continue;
    const pts = [], jn = []; for (let i = 0; i < n; i++) { const x = f[i * 2], z = f[i * 2 + 1], q = key(x, z); pts.push({ x, z, y: 0 }); if (i === 0 || i === n - 1 || uses.get(q) > 1) jn.push([i, q]); }
    if (extra.ys) pts.forEach((p, i) => { p.y = extra.ys[i]; }); else if (br || tun) { const ya = extra.ya ?? g(pts[0].x, pts[0].z), yb = extra.yb ?? g(pts[n - 1].x, pts[n - 1].z); let s = 0; const S = [0]; for (let i = 1; i < n; i++) S.push((s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))); pts.forEach((p, i) => { p.y = ya + (yb - ya) * (S[i] / (s || 1)); }); }
    const flag = br || tun ? new Array(n).fill(true) : null;
    // (a tunnel dives as a road's does, tubes.js: at DIVE_K x its class's grade; its tube only where its roof has cover, an open cut
    // before that)
    let tube = flag; if (tun && !br && !extra.ys) { const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const cov = (k) => { const gz = g(pts[k].x, pts[k].z); return (gz === gz ? gz : Infinity) - TUBE_COVER; }, r = diveProfile(pts.map((p) => p.y), S, cov, (RAIL_GRADE[cls] ?? 0.04) * DIVE_K);
      r.ys.forEach((y, i) => { pts[i].y = y; }); tube = r.covered.slice(); dived.push({ S, at: (k) => pts[k], cov: r.covered, set: (cv) => cv.forEach((c, i) => { tube[i] = c; }) }); }
    const way = { kind: 'rail', rail: cls, minor: true, railsOnly: !!extra.railsOnly, keepShape: !!extra.ys, width: (RAIL_HW[cls] + (extra.wide || 0)) * 2, pts, jn: extra.railsOnly ? [] : jn, bridge: br ? flag : null, tube: tun ? tube : null, layer: 0, surf: 0, lanes: cls, pinA: extra.pinA, pinB: extra.pinB }; out.push(way); }
  // (tunnels side by side, a railway's tracks: their tubes where every one beside is a tube too, tubes.js twinAnd)
  const cvs = twinAnd(dived); dived.forEach((d, i) => d.set(cvs[i]));
  return out;
}
// a railway bridge's deck profile (#294): not the straight line between the natural ground at its ends, but over everything
// under it. Each deck's line in DECK_STEP m stations; at each, its lowest: a road or another railway under it (crossing it, not along it: at its
// natural ground, or a road's own deck's height if it's lower than this one's) DECK_DEPTH + its clearance + CLEAR_PAD; the
// straight line where it's higher (a viaduct over a valley). Then lifted to stay within the class's grade (a cone from every
// station's lowest, along the deck and through the decks it shares an end with: a viaduct's ways end to end), so its ends
// rise too and the railway's approaches climb to them in the solve (each held at the deck's end: pins). A deck end that
// mergeBores holds at a portal's floor (ya, yb) stays there. -> the list, a deck's entry with its stations and their heights
// (extra.ys)
const DECK_STEP = 8, CLEAR_PAD = 0.3, ALONG = 0.9;
function deckProfiles(list, w, g) {
  const decks = list.map((e, q) => (e[1] && !e[4] && e[2].length >= 4 ? q : -1)).filter((q) => q >= 0); if (!decks.length) return list;
  const ek = (x, z) => Math.round(x * 10) + ',' + Math.round(z * 10);
  // (the ways that can be under a deck: the roads (a tube's stretches left out) and the railways on the ground, in a grid of segments)
  const C = 40, grid = new Map(), put = (sg) => { for (let i = Math.floor(Math.min(sg[0], sg[2]) / C); i <= Math.floor(Math.max(sg[0], sg[2]) / C); i++) for (let j = Math.floor(Math.min(sg[1], sg[3]) / C); j <= Math.floor(Math.max(sg[1], sg[3]) / C); j++) (grid.get(i * 100003 + j) || grid.set(i * 100003 + j, []).get(i * 100003 + j)).push(sg); };
  for (const rd of w.net.roads) { if (rd.kind === 'rail') continue; const P = rd.pts, cl = rd.minor ? CLEAR.minor : CLEAR.street; for (let i = 0; i + 1 < P.length; i++) { if (rd.tube?.[i] && rd.tube?.[i + 1]) continue; const dk = (rd.baked || (rd.bridge?.[i] && rd.bridge?.[i + 1])) ? [P[i].y, P[i + 1].y] : null; put([P[i].x, P[i].z, P[i + 1].x, P[i + 1].z, rd.width / 2, cl, dk]); } }
  for (const e of list) { if (e[1] || e[4]) continue; const f = e[2]; for (let k = 0; k + 3 < f.length; k += 2) put([f[k], f[k + 1], f[k + 2], f[k + 3], RAIL_HW[e[3] || 0], CLEAR.rail, null]); }
  const P = decks.map((q) => { const [, , f, cls = 0, , ex = {}] = list[q], pts = []; for (let k = 0; k < f.length; k += 2) { if (k) { const ax = f[k - 2], az = f[k - 1], l = Math.hypot(f[k] - ax, f[k + 1] - az), n = Math.ceil(l / DECK_STEP); for (let s = 1; s < n; s++) pts.push([ax + (f[k] - ax) * s / n, az + (f[k + 1] - az) * s / n]); } pts.push([f[k], f[k + 1]]); }
    const S = [0]; for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); const L = S[S.length - 1] || 1, ya = ex.ya ?? g(f[0], f[1]), yb = ex.yb ?? g(f[f.length - 2], f[f.length - 1]);
    const W = RAIL_HW[cls] + (ex.wide || 0) + DECK_SIDE;
    const base = pts.map(([x, z], i) => { const st = ya + (yb - ya) * S[i] / L; let lo = -Infinity; /* (the ground under it: rules.js offClamp keeps it under the underside) */
      const j = Math.max(0, Math.min(pts.length - 2, i)), ux0 = pts[j + 1][0] - pts[j][0], uz0 = pts[j + 1][1] - pts[j][1], ul = Math.hypot(ux0, uz0) || 1, ux = ux0 / ul, uz = uz0 / ul;
      for (const [ax, az, bx, bz, hw, cl, dk] of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) || []) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; if (L2 < 1e-6) continue; const sl = Math.sqrt(L2); if (!dk && cl === CLEAR.rail && Math.abs((dx * ux + dz * uz) / sl) > ALONG) continue; /* (a railway along it: its approach, a track beside it; a road along it is under it: an elevated line over an avenue) */
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t; if (Math.hypot(x - px, z - pz) > W + hw) continue;
        const wy = dk ? dk[0] + (dk[1] - dk[0]) * t : g(px, pz); if (dk && wy > st - DECK_DEPTH) continue; /* (a road's deck over this one, or level with it: not under it) */
        lo = Math.max(lo, wy + DECK_DEPTH + cl + CLEAR_PAD); }
      return Math.max(st, lo); });
    return { q, pts, S, base, y: base.slice(), G: RAIL_GRADE[cls] || 0.04, fixA: ex.ya != null, fixB: ex.yb != null, ka: ek(f[0], f[1]), kb: ek(f[f.length - 2], f[f.length - 1]) }; });
  // (the cone: along each deck both ways, and its ends' heights shared with the decks meeting there, until nothing rises)
  for (let pass = 0; pass < 50; pass++) { let moved = false; const node = new Map(), up = (k, v) => { if (!(node.get(k) >= v)) node.set(k, v); };
    for (const d of P) { const y = d.y, n = y.length; for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1] - d.G * (d.S[i] - d.S[i - 1])); for (let i = n - 2; i >= 0; i--) y[i] = Math.max(y[i], y[i + 1] - d.G * (d.S[i + 1] - d.S[i])); up(d.ka, y[0]); up(d.kb, y[n - 1]); }
    for (const d of P) { const n = d.y.length; for (const [i, k] of [[0, d.ka], [n - 1, d.kb]]) if (node.get(k) > d.y[i] + 1e-6) { d.y[i] = node.get(k); moved = true; } }
    if (!moved) break; }
  const out = list.slice();
  for (const d of P) { if (d.fixA) d.y[0] = d.base[0]; if (d.fixB) d.y[d.y.length - 1] = d.base[d.base.length - 1]; const e = list[d.q]; out[d.q] = [e[0], e[1], d.pts.flat(), e[3], e[4], { ...(e[5] || {}), ys: d.y }]; }
  return out;
}
// a double-track tunnel mapped as two ways side by side (one per track: their tubes overlap, each portal inside the other's
// lip): one tube for both, the first way's, widened to take the other (extra.wide m more each side). Where the two lie within
// BORE_D m of each other all along, the other's tunnel is left out; where they part inside the hill (two bores), the other's
// is cut back to where they're BORE_D apart (its profile kept: extra.ya, yb), its stretch nearer the portal left out. Either
// way the other's approach ends on the kept tube's portal plane (cut back or carried on to it), held at its floor's height
// there (extra.pinA, pinB).
const BORE_D = 8;
function mergeBores(list, g) {
  const lineD = (f, x, z) => { let b = Infinity; for (let k = 0; k + 3 < f.length; k += 2) { const ax = f[k], az = f[k + 1], dx = f[k + 2] - ax, dz = f[k + 3] - az, L = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)); b = Math.min(b, Math.hypot(x - ax - dx * t, z - az - dz * t)); } return b; };
  const far = (f, o) => { let m = 0; for (let k = 0; k < f.length; k += 2) m = Math.max(m, lineD(o, f[k], f[k + 1])); return m; };
  const lenOf = (f) => { let s = 0; for (let k = 2; k < f.length; k += 2) s += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]); return s; };
  const tun = []; list.forEach((e, i) => { if (e[4] && e[2].length >= 4) tun.push(i); });
  const into = new Map(), wide = new Map(), trim = new Map(), ends = []; // (a bore left out -> the kept one; the kept one's extra half width; a bore cut back: [from its start, from its end] m; the left-out ends)
  for (let a = 0; a < tun.length; a++) { const i = tun[a]; if (into.has(i)) continue; const A = list[i][2];
    for (let b = a + 1; b < tun.length; b++) { const j = tun[b]; if (into.has(j)) continue; const B = list[j][2], nB = B.length / 2;
      const near = (x, z) => Math.min(Math.hypot(A[0] - x, A[1] - z), Math.hypot(A[A.length - 2] - x, A[A.length - 1] - z)) <= 2 * BORE_D && lineD(A, x, z) <= BORE_D; // (an end of B beside an end of A)
      const nA = near(B[0], B[1]), nZ = near(B[nB * 2 - 2], B[nB * 2 - 1]); if (!nA && !nZ) continue;
      const endSep = (x, z) => Math.abs(endFrame(A, x, z)[1]);
      if (Math.max(far(B, A), far(A, B)) <= BORE_D) { let sep = Math.max(endSep(B[0], B[1]), endSep(B[nB * 2 - 2], B[nB * 2 - 1])); for (let k = 2; k < B.length - 2; k += 2) sep = Math.max(sep, lineD(A, B[k], B[k + 1]));
        into.set(j, i); wide.set(i, Math.max(wide.get(i) || 0, sep)); ends.push({ x: B[0], z: B[1], A }, { x: B[nB * 2 - 2], z: B[nB * 2 - 1], A }); continue; }
      // (two bores parting inside the hill: from each end of B beside A, along B to where it's BORE_D from A)
      const L = lenOf(B), at = (s) => { let acc = 0; for (let k = 2; k < B.length; k += 2) { const l = Math.hypot(B[k] - B[k - 2], B[k + 1] - B[k - 1]); if (acc + l >= s || k === B.length - 2) { const t = l ? Math.min(1, (s - acc) / l) : 0; return [B[k - 2] + (B[k] - B[k - 2]) * t, B[k - 1] + (B[k + 1] - B[k - 1]) * t]; } acc += l; } };
      const T = trim.get(j) || [0, 0];
      for (const [isA, x, z] of [[true, B[0], B[1]], [false, B[nB * 2 - 2], B[nB * 2 - 1]]]) { if (!(isA ? nA : nZ)) continue; let s = 0; while (s < L / 2) { s += 1; const [px, pz] = at(isA ? s : L - s); if (lineD(A, px, pz) > BORE_D) break; }
        T[isA ? 0 : 1] = s; ends.push({ x, z, A }); wide.set(i, Math.max(wide.get(i) || 0, endSep(x, z))); }
      trim.set(j, T); } }
  if (!into.size && !trim.size) return list;
  // (a bore cut back: its points from s0 to L - s1, its ends' heights on its straight profile, railWays's)
  const cut = (f, s0, s1) => { const L = lenOf(f), ya = g(f[0], f[1]), yb = g(f[f.length - 2], f[f.length - 1]), o = []; let acc = 0;
    const pt = (s) => { let c = 0; for (let k = 2; k < f.length; k += 2) { const l = Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]); if (c + l >= s || k === f.length - 2) { const t = l ? Math.min(1, (s - c) / l) : 0; return [f[k - 2] + (f[k] - f[k - 2]) * t, f[k - 1] + (f[k + 1] - f[k - 1]) * t]; } c += l; } };
    o.push(...pt(s0)); for (let k = 2; k < f.length - 2; k += 2) { acc += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]); if (acc > s0 + 0.5 && acc < L - s1 - 0.5) o.push(f[k], f[k + 1]); } o.push(...pt(L - s1));
    return { f: o, ya: ya + (yb - ya) * s0 / (L || 1), yb: ya + (yb - ya) * (L - s1) / (L || 1) }; };
  const out = list.map((e, i) => { if (into.has(i)) return null; const ex = {}; if (wide.has(i)) ex.wide = wide.get(i); let f = e[2];
    if (trim.has(i)) { const [s0, s1] = trim.get(i), c = cut(f, s0, s1); f = c.f; ex.ya = c.ya; ex.yb = c.yb; if (lenOf(f) < 2) return null; }
    return Object.keys(ex).length ? [e[0], e[1], f, e[3], e[4], ex] : e; });
  // (the other track's rails in the kept tube: its own line from the kept tube's portal plane (where its approach ends) on
  // into the hill, to the other portal's plane or to where its own bore begins, level with the tube's floor at each end;
  // a tube of its own drawn for nothing, no portal: off 'rails', rails.js lays its rails, runtime.js draws no tube)
  const clipIn = (pts, A) => { const [ax, az, ux, uz] = portalOfLine(A, pts[0][0], pts[0][1]), u = (p) => (p[0] - ax) * ux + (p[1] - az) * uz; let k = 0; while (k < pts.length && u(pts[k]) < 0) k++; if (k === pts.length) return null;
    const p0 = k > 0 ? (() => { const a = pts[k - 1], b = pts[k], t = u(a) / (u(a) - u(b)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; })() : [pts[0][0] - ux * u(pts[0]), pts[0][1] - uz * u(pts[0])];
    const o = [p0]; for (let i = k; i < pts.length; i++) if (Math.hypot(pts[i][0] - o[o.length - 1][0], pts[i][1] - o[o.length - 1][1]) > 0.05) o.push(pts[i]); return { pts: o, y: g(ax, az) }; };
  const sub = (f, a, b) => { const L = lenOf(f), o = []; let acc = 0; const at = (s) => { let c = 0; for (let k = 2; k < f.length; k += 2) { const l = Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]); if (c + l >= s || k === f.length - 2) { const t = l ? Math.min(1, (s - c) / l) : 0; return [f[k - 2] + (f[k] - f[k - 2]) * t, f[k - 1] + (f[k + 1] - f[k - 1]) * t]; } c += l; } };
    o.push(at(a)); for (let k = 2; k < f.length - 2; k += 2) { acc += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]); if (acc > a + 0.5 && acc < b - 0.5) o.push([f[k], f[k + 1]]); } o.push(at(b)); return { o, L }; };
  const railsIn = [];
  for (const [j, T] of [...[...into.keys()].map((j) => [j, null]), ...trim]) { const B = list[j][2], L = lenOf(B), yB = (s) => g(B[0], B[1]) + (g(B[B.length - 2], B[B.length - 1]) - g(B[0], B[1])) * s / (L || 1);
    const pieces = T ? [T[0] > 0 ? [0, T[0]] : null, T[1] > 0 ? [L - T[1], L] : null].filter(Boolean) : [[0, L]];
    for (const [a, b] of pieces) { let pts = sub(B, a, b).o, ya = yB(a), yb = yB(b);
      const Ea = a === 0 ? ends.find((c) => Math.hypot(c.x - B[0], c.z - B[1]) < 0.05) : null, Eb = b === L ? ends.find((c) => Math.hypot(c.x - B[B.length - 2], c.z - B[B.length - 1]) < 0.05) : null;
      if (Ea) { const c = clipIn(pts, Ea.A); if (!c) continue; pts = c.pts; ya = c.y; }
      if (Eb) { const c = clipIn(pts.slice().reverse(), Eb.A); if (!c) continue; pts = c.pts.reverse(); yb = c.y; }
      if (pts.length >= 2 && lenOf(pts.flat()) >= 2) railsIn.push([list[j][0], 0, pts.flat(), list[j][3], 1, { ya, yb, railsOnly: 1 }]); } }
  out.forEach((e, q) => { if (!e || e[4]) return; let f = e[2], ex = null;
    for (const end of ['A', 'B']) { const n = f.length / 2, i0 = end === 'A' ? 0 : n - 1, x = f[i0 * 2], z = f[i0 * 2 + 1], E = ends.find((c) => Math.hypot(c.x - x, c.z - z) < 0.05); if (!E) continue;
      const A = E.A, [ax, az, ux, uz] = portalOfLine(A, x, z), pts = []; for (let k = 0; k < f.length; k += 2) pts.push([f[k], f[k + 1]]); if (end === 'A') pts.reverse();
      // (from its far end towards the portal: points up to the plane kept, then the point on it)
      const u = (p) => (p[0] - ax) * ux + (p[1] - az) * uz, keep = [pts[0]]; let k = 1; for (; k < pts.length; k++) { if (u(pts[k]) >= -0.05) break; keep.push(pts[k]); }
      const prev = keep[keep.length - 1], up = u(prev); let px, pz;
      if (k < pts.length) { const nx = pts[k], t = up / (up - u(nx)); px = prev[0] + (nx[0] - prev[0]) * t; pz = prev[1] + (nx[1] - prev[1]) * t; } else { px = prev[0] - ux * up; pz = prev[1] - uz * up; } // (cut where it crosses the plane; or carried on along the tube's axis to it)
      if (Math.hypot(px - prev[0], pz - prev[1]) > 0.05) keep.push([px, pz]); else keep[keep.length - 1] = [px, pz];
      if (end === 'A') keep.reverse(); f = keep.flat(); (ex ||= {})['pin' + end] = g(ax, az); if (e[1]) ex[end === 'A' ? 'ya' : 'yb'] = g(ax, az); } // (a bridge's: its deck's profile ends there)
    if (ex) out[q] = [e[0], e[1], f, e[3], e[4], ex]; });
  return [...out.filter(Boolean), ...railsIn];
}
// the crown floor (#294): a way over a tube within CROWN_REACH m of its portal (its centre line over the tube's walls) is
// held CROWN_OVER m over the tube's crown there, so a street over a portal's mouth runs over its lintel, not through the
// tube (the height grid has the two a metre or two apart). Each station's lowest height (the shore's floor elsewhere)
const CROWN_REACH = 15, CROWN_OVER = 0.8, CROWN_MAX = 8, CROWN_LAP = 1.5;
function crownFloor(V, runs, offRuns, pins, floor, T) {
  const lo = new Float64Array(V.length).fill(floor), C = 20, grid = new Map(), key = (i, j) => i * 100003 + j;
  for (const t of offRuns) { if (t.off !== 'tube' || t.pts.length < 2) continue; const n = t.pts.length, s = [0]; for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1])); const hwT = t.hw + TUBE_SIDE;
    for (let i = 0; i + 1 < n; i++) { if (s[i] > CROWN_REACH && s[n - 1] - s[i + 1] > CROWN_REACH) continue; const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1], sg = { t, i, s, hwT };
      for (let a = Math.floor((Math.min(ax, bx) - hwT) / C); a <= Math.floor((Math.max(ax, bx) + hwT) / C); a++) for (let b = Math.floor((Math.min(az, bz) - hwT) / C); b <= Math.floor((Math.max(az, bz) + hwT) / C); b++) (grid.get(key(a, b)) || grid.set(key(a, b), []).get(key(a, b))).push(sg); } }
  if (!grid.size) return lo;
  const own = new Set(); for (const r of runs) { if (r.rd?.tube?.some(Boolean)) for (const v of r.vars) own.add(v); } // (a way's own approach to its tube: not over it)
  let held = 0, skipped = 0;
  for (const r of runs) r.vars.forEach((k, q) => { if (r.minor && r.rail < 0) return; if (pins.has(k) || own.has(k)) return; const x = V[k].x, z = V[k].z, reach = r.hw + (r.pave || 0); let need = -Infinity;
    for (const { t, i, s, hwT } of grid.get(key(Math.floor(x / C), Math.floor(z / C))) || []) { const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, lap = Math.max(0, reach - CROWN_LAP); let f = ((x - ax) * dx + (z - az) * dz) / L2; // (a way whose strip lies over the tube by CROWN_LAP m or more: a street over it; one only touching its walls (a twin carriageway at grade beside it) isn't held)
      const sl = Math.sqrt(L2), over = lap / sl; if (f < (i === 0 ? -over : 0) || f > (i + 2 === s.length ? 1 + over : 1)) continue; f = Math.max(0, Math.min(1, f)); /* (past the portal by up to its strip: a street over the mouth) */ const d = Math.abs((x - ax) * dz - (z - az) * dx) / Math.sqrt(L2), along = s[i] + (s[i + 1] - s[i]) * f;
      if (d > hwT + lap || Math.min(along, s[s.length - 1] - along) > CROWN_REACH) continue;
      need = Math.max(need, t.ys[i] + (t.ys[i + 1] - t.ys[i]) * f + TUBE_H + CROWN_OVER); }
    if (need > lo[k]) { if (need - V[k].g > CROWN_MAX) { skipped++; return; } lo[k] = need; held++; } });
  T.crown = { held, skipped }; return lo;
}
// the deck clearance (#294): a way under a railway's bridge (its strip over the deck's footprint, between the deck's ends) is
// held CLEAR m (by kind: a street, a way off the street network, a railway) under the deck's underside (its profile less
// DECK_DEPTH), so a road under a low rail bridge passes under it, not through it (the deck's profile is straight between the
// natural ground at its ends, bake.js railWays). Where that would take it more than CEIL_MAX m under the natural ground (a low
// deck, near its ends where it meets the ground), only CEIL_MAX m under it, but always CLEAR_LOW m under the underside at
// least; a station that would go more than CEIL_SKIP m under the ground isn't held. Each station's highest height (Infinity elsewhere)
const CLEAR = { street: 4, minor: 2.5, rail: 4.8 }, CEIL_MAX = 3, CLEAR_LOW = 0.3, CEIL_SKIP = 8;
function deckCeil(V, runs, offRuns, pins, T) {
  const up = new Float64Array(V.length).fill(Infinity), C = 20, grid = new Map(), key = (i, j) => i * 100003 + j;
  for (const t of offRuns) { if (t.off !== 'deck' || !(t.rail >= 0) || t.pts.length < 2) continue; const W = t.hw + DECK_SIDE;
    for (let i = 0; i + 1 < t.pts.length; i++) { const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1], sg = { t, i, W };
      for (let a = Math.floor((Math.min(ax, bx) - W - 30) / C); a <= Math.floor((Math.max(ax, bx) + W + 30) / C); a++) for (let b = Math.floor((Math.min(az, bz) - W - 30) / C); b <= Math.floor((Math.max(az, bz) + W + 30) / C); b++) (grid.get(key(a, b)) || grid.set(key(a, b), []).get(key(a, b))).push(sg); } }
  if (!grid.size) return up;
  const own = new Set(); for (const r of runs) { if (r.rd?.bridge?.some(Boolean)) for (const v of r.vars) own.add(v); } /* (a deck's own approach: not under it) */
  let held = 0, skipped = 0;
  for (const r of runs) r.vars.forEach((k, q) => { if (pins.has(k) || own.has(k)) return; const x = V[k].x, z = V[k].z, reach = r.hw + (r.pave || 0), cl = r.rail >= 0 ? CLEAR.rail : r.minor ? CLEAR.minor : CLEAR.street; let need = Infinity;
    const qa = r.pts[Math.max(0, q - 1)], qb = r.pts[Math.min(r.pts.length - 1, q + 1)], rl = Math.hypot(qb[0] - qa[0], qb[1] - qa[1]) || 1, rx = (qb[0] - qa[0]) / rl, rz = (qb[1] - qa[1]) / rl; /* (the way's direction there: one along the deck (its approach, a track beside it) isn't under it) */
    for (const { t, i, W } of grid.get(key(Math.floor(x / C), Math.floor(z / C))) || []) { const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, f = ((x - ax) * dx + (z - az) * dz) / L2;
      if (f < (i === 0 ? 0 : -1e-9) || f > (i + 2 === t.pts.length ? 1 : 1 + 1e-9)) continue; if (r.rail >= 0 && Math.abs((rx * dx + rz * dz) / Math.sqrt(L2)) > ALONG) continue; const d = Math.abs((x - ax) * dz - (z - az) * dx) / Math.sqrt(L2); if (d > W + reach) continue;
      const under = t.ys[i] + (t.ys[i + 1] - t.ys[i]) * f - DECK_DEPTH; need = Math.min(need, Math.max(under - cl, Math.min(under - CLEAR_LOW, V[k].g - CEIL_MAX))); }
    if (need < Infinity) { if (V[k].g - need > CEIL_SKIP) { skipped++; return; } (r.ceil ||= new Set()).add(q); } /* (its stored shape keeps it and the stations either side: keepLine) */
    if (need < up[k]) { up[k] = need; held++; } });
  T.deckCeil = { held, skipped }; return up;
}
// a road's stored shape (as rdpLine of its own points) keeping its stations held under a deck and those either side (r.ceil):
// its points split at them, each piece simplified
function keepLine(r) {
  const osm = new Set(r.osmPts), keep = new Set(); for (const q of r.ceil) for (const d of [-1, 0, 1]) if (r.pts[q + d]) keep.add(q + d);
  const out = []; let piece = [];
  r.pts.forEach((p, q) => { if (!osm.has(p) && !keep.has(q)) return; piece.push([cm(p[0]), cm(p[1])]); if (keep.has(q) || q === r.pts.length - 1) { const sh = rdpLine(piece, SHAPE_TOL); out.push(...(out.length ? sh.slice(1) : sh)); piece = [piece[piece.length - 1]]; } });
  if (piece.length > 1) { const sh = rdpLine(piece, SHAPE_TOL); out.push(...sh.slice(1)); }
  return out;
}
// a tube's line f: at its end nearer (x, z), the portal (that end) and the way into the tube (ux, uz)
function portalOfLine(f, x, z) { const n = f.length / 2, a = Math.hypot(f[0] - x, f[1] - z) <= Math.hypot(f[n * 2 - 2] - x, f[n * 2 - 1] - z), [i, j] = a ? [0, 1] : [n - 1, n - 2];
  const ax = f[i * 2], az = f[i * 2 + 1], dx = f[j * 2] - ax, dz = f[j * 2 + 1] - az, l = Math.hypot(dx, dz) || 1; return [ax, az, dx / l, dz / l]; }
// (x, z) in the frame of a tube's nearer end: along into it, across
function endFrame(f, x, z) { const [ax, az, ux, uz] = portalOfLine(f, x, z); return [(x - ax) * ux + (z - az) * uz, (z - az) * ux - (x - ax) * uz]; }

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
