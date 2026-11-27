// The bake of the road layout (#294): everything about the roads' shape is decided here, once, for an area of chunks,
// and stored per chunk (format.js); the game only joins the points (mesh.js). Run by tools/bake/layout.mjs on a real
// place's World (its road network, junctions and natural ground, World.real.height).
//
//  1. network: the street network and the ways off it near the area, resampled (<= SEG m), with the points where roads
//     cross without a shared node tied together (they meet at one height)
//  2. one height solve over all of it: near the natural ground, smooth along each road, within each kind's grade limit,
//     each junction a tilted plane (validated: a plane fits a junction's ground to ~0.1 m at p90; flat ones don't)
//  3. clean outlines (integer centimetres, Clipper): carriageways, kerbs, pavements, alleys, pavers, gravel, verges,
//     each a region of its own, none overlapping
//  4. the ground the roads reshape: from the paved edge a 1:2 slope (embankment or cutting) out until it meets the
//     natural ground; its extent (the toe) found here on a BANK_STEP lattice
//  5. per chunk: the points (with drawn and physics heights and road coordinates for the markings), the fixed edges
//     (with the kind each side), and which hi-grid points the layout replaces
import CL from '../../vendor/layout/clipper1.mjs';
import { CHUNK, KIND } from './format.js';
import { meshChunk } from './mesh.js';

const SEG = 8, MARGIN = 150, ARC = 8, SIMPLIFY = 6, KERB = 0.15, KERB_W = 0.1, PAVE_RAMP = 2, SLOPE = 0.5, BANK_MAX = 30, BANK_STEP = 2, BANK_IN = 7, JBLEND = 6, SBLEND = 3, CITY_REACH = 36, CITY_IN = 10, BANK_MIN = 0.03, EDGE_STEP = 4;
const PAVE = { main: 4.5, street: 3.5 }, VERGE = 1.5; // (as roadgrade.js: a city street's pavement, a country road's verge)
const GRADE = { highway: 0.07, main: 0.12, street: 0.2 }, GRADE_MINOR = 0.25;
const cm = (v) => Math.round(v * 100);

export function bakeLayout(w, chunks, log = () => {}) {
  const T = {}, tic = (k, t0) => { T[k] = (T[k] || 0) + performance.now() - t0; log(`  [layout] ${k} ${Math.round(T[k])} ms`); }, city = !!w.loc.city, g = (x, z) => w.real.height(x, z);
  const ix0 = Math.min(...chunks.map((c) => c[0])), ix1 = Math.max(...chunks.map((c) => c[0])), iz0 = Math.min(...chunks.map((c) => c[1])), iz1 = Math.max(...chunks.map((c) => c[1]));
  const R = { x0: ix0 * CHUNK - MARGIN, x1: (ix1 + 1) * CHUNK + MARGIN, z0: iz0 * CHUNK - MARGIN, z1: (iz1 + 1) * CHUNK + MARGIN }, inR = (p, m = 0) => p.x > R.x0 - m && p.x < R.x1 + m && p.z > R.z0 - m && p.z < R.z1 + m;
  // ---- 1. network
  let t0 = performance.now();
  const V = [], node = new Map(), runs = [];
  const newVar = (x, z) => (V.push({ x, z, g: g(x, z) }), V.length - 1);
  for (const rd of w.net.roads) {
    if (rd.kind === 'rail' || rd.closed) continue;
    const P = rd.pts, n = P.length; let a = -1, b = -1;
    for (let i = 0; i < n; i++) if (inR(P[i])) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    a = Math.max(0, a - 1); b = Math.min(n - 1, b + 1);
    let bad = false; for (let i = a; i <= b; i++) if (rd.bridge?.[i] || rd.tube?.[i] || rd.span?.[i]) bad = true;
    if (bad) { log(`  (skipped a ${rd.kind} on a bridge or in a tunnel)`); continue; }
    const jn = new Map(rd.jn || []), pts = [], vars = [];
    for (let i = a; i <= b; i++) {
      if (i > a) { const p = P[i - 1], q = P[i], l = Math.hypot(q.x - p.x, q.z - p.z), k = Math.ceil(l / SEG); for (let s = 1; s < k; s++) { const x = p.x + (q.x - p.x) * s / k, z = p.z + (q.z - p.z) * s / k; pts.push([x, z]); vars.push(newVar(x, z)); } }
      const nd = jn.get(i); let v; if (nd != null && node.has(nd)) v = node.get(nd); else { v = newVar(P[i].x, P[i].z); if (nd != null) node.set(nd, v); }
      pts.push([P[i].x, P[i].z]); vars.push(v);
    }
    const minor = !!rd.minor, kind = rd.kind;
    runs.push({ rd, kind, minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, layer: rd.layer || 0, pts, vars, grade: minor ? GRADE_MINOR : GRADE[kind] ?? 0.2, pave: city && !minor && !rd.baked && PAVE[kind] ? PAVE[kind] : 0 });
  }
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
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, v = newVar(x, z); ins[ra].push([sa, t, x, z, v]); ins[rb].push([sb, u, x, z, v]);
    }
    runs.forEach((r, ri) => { if (!ins[ri].length) return; ins[ri].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const pts = [], vars = []; let q = 0;
      for (let s = 0; s < r.pts.length; s++) { pts.push(r.pts[s]); vars.push(r.vars[s]); while (q < ins[ri].length && ins[ri][q][0] === s) { pts.push([ins[ri][q][2], ins[ri][q][3]]); vars.push(ins[ri][q][4]); q++; } }
      r.pts = pts; r.vars = vars; T.ties = (T.ties || 0) + ins[ri].length / 2; });
  }
  for (const r of runs) { r.s = [0]; for (let i = 1; i < r.pts.length; i++) r.s.push(r.s[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1])); }
  tic('networkMs', t0);
  // ---- 2. height solve
  t0 = performance.now();
  const nv = V.length, h = Float64Array.from(V, (v) => v.g), edges = [], nb = V.map(() => []);
  for (const r of runs) for (let i = 0; i + 1 < r.vars.length; i++) { const a = r.vars[i], b = r.vars[i + 1]; if (a === b) continue; const l = Math.max(0.5, r.s[i + 1] - r.s[i]); edges.push([a, b, l, r.grade]); nb[a].push([b, 1 / l]); nb[b].push([a, 1 / l]); }
  const vGrid = new Map(), VC = 10; V.forEach((v, k) => { const key = Math.floor(v.x / VC) * 100003 + Math.floor(v.z / VC); (vGrid.get(key) || vGrid.set(key, []).get(key)).push(k); });
  const varsNear = (x, z, r) => { const out = []; for (let i = Math.floor((x - r) / VC); i <= Math.floor((x + r) / VC); i++) for (let j = Math.floor((z - r) / VC); j <= Math.floor((z + r) / VC); j++) for (const k of vGrid.get(i * 100003 + j) || []) if (Math.hypot(V[k].x - x, V[k].z - z) <= r) out.push(k); return out; };
  const JN = [];
  for (const j of w.net.junctions) { if (!inR(j)) continue; let r = 0; for (let q = 0; q < j.box.length; q += 2) r = Math.max(r, Math.hypot(j.box[q] - j.x, j.box[q + 1] - j.z)); r = Math.min(35, Math.max(6, r)); const m = varsNear(j.x, j.z, r); if (m.length >= 2) JN.push({ x: j.x, z: j.z, r, m, a: 0, b: 0, c: 0 }); }
  const plane = (J) => { const n = J.m.length; let mx = 0, mz = 0, my = 0; for (const k of J.m) { mx += V[k].x; mz += V[k].z; my += h[k]; } mx /= n; mz /= n; my /= n; let a = 0, b = 0, c = 0, d = 0, e = 0;
    for (const k of J.m) { const X = V[k].x - mx, Z = V[k].z - mz, Y = h[k] - my; a += X * X; b += X * Z; c += Z * Z; d += X * Y; e += Z * Y; } const det = a * c - b * b; const gx = n >= 3 && Math.abs(det) > 1e-6 ? (d * c - e * b) / det : 0, gz = n >= 3 && Math.abs(det) > 1e-6 ? (e * a - d * b) / det : 0;
    J.mx = mx; J.mz = mz; J.my = my; J.gx = gx; J.gz = gz; };
  const toPlane = () => { for (const J of JN) { plane(J); for (const k of J.m) h[k] = J.my + J.gx * (V[k].x - J.mx) + J.gz * (V[k].z - J.mz); } };
  const clampGrades = (passes) => { for (let p = 0; p < passes; p++) for (const [a, b, l, G] of edges) { const d = h[a] - h[b], lim = G * l; if (Math.abs(d) > lim) { const ex = (Math.abs(d) - lim) / 2 * Math.sign(d); h[a] -= ex; h[b] += ex; } } };
  const WG = 0.004; // (the natural ground's pull against the neighbours' 1/l: smooth over tens of metres, near the ground)
  let iters = 0;
  for (; iters < 600; iters++) {
    for (let k = 0; k < nv; k++) { const N = nb[k]; if (!N.length) continue; let s = WG * V[k].g, ws = WG; for (const [o, wt] of N) { s += wt * h[o]; ws += wt; } h[k] = s / ws; }
    toPlane(); clampGrades(2);
  }
  clampGrades(20); toPlane();
  let dev = 0, over = 0; for (let k = 0; k < nv; k++) dev = Math.max(dev, Math.abs(h[k] - V[k].g)); for (const [a, b, l, G] of edges) over = Math.max(over, Math.abs(h[a] - h[b]) / l - G);
  T.solve = { vars: nv, junctions: JN.length, iters, maxFromGround: +dev.toFixed(2), worstOverGrade: +Math.max(0, over).toFixed(3) };
  tic('solveMs', t0);
  // ---- heights anywhere: a junction's plane inside it, else the nearest road's (the street network's first)
  const segIdx = new Map(), SC = 10; runs.forEach((r, ri) => { for (let s = 0; s + 1 < r.pts.length; s++) { const [ax, az] = r.pts[s], [bx, bz] = r.pts[s + 1]; for (let i = Math.floor((Math.min(ax, bx) - 45) / SC); i <= Math.floor((Math.max(ax, bx) + 45) / SC); i++) for (let j = Math.floor((Math.min(az, bz) - 45) / SC); j <= Math.floor((Math.max(az, bz) + 45) / SC); j++) { const k = i * 100003 + j; (segIdx.get(k) || segIdx.set(k, []).get(k)).push([ri, s]); } } });
  const nearest = (x, z, ok) => { let best = null; for (const [ri, s] of segIdx.get(Math.floor(x / SC) * 100003 + Math.floor(z / SC)) || []) { const r = runs[ri]; if (!ok(r)) continue; const [ax, az] = r.pts[s], [bx, bz] = r.pts[s + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz) - r.hw;
    if (!best || d < best.d) best = { r, s, t, d, h: h[r.vars[s]] + (h[r.vars[s + 1]] - h[r.vars[s]]) * t, u: r.s[s] + (r.s[s + 1] - r.s[s]) * t, v: (dx * (z - az) - dz * (x - ax)) / Math.sqrt(L2), px, pz }; } return best; };
  const nearest2 = (x, z, ok = (r) => !r.minor && r.pave) => { const best = []; for (const [ri, s] of segIdx.get(Math.floor(x / SC) * 100003 + Math.floor(z / SC)) || []) { const r = runs[ri]; if (!ok(r)) continue; const [ax, az] = r.pts[s], [bx, bz] = r.pts[s + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz) - r.hw - (r.pave || 0);
    const n = { ri, d, h: h[r.vars[s]] + (h[r.vars[s + 1]] - h[r.vars[s]]) * t, px, pz }, k = best.findIndex((b) => b.ri === ri); if (k >= 0) { if (d < best[k].d) best[k] = n; } else best.push(n); } return best.sort((a, b) => a.d - b.d).slice(0, 2); };
  const jGrid = new Map(); JN.forEach((J, q) => { for (let i = Math.floor((J.x - J.r - JBLEND) / SC); i <= Math.floor((J.x + J.r + JBLEND) / SC); i++) for (let j = Math.floor((J.z - J.r - JBLEND) / SC); j <= Math.floor((J.z + J.r + JBLEND) / SC); j++) { const k = i * 100003 + j; (jGrid.get(k) || jGrid.set(k, []).get(k)).push(q); } });
  // the street surface's height at (x, z) given its nearest street's (h): a junction's plane inside it, blending into the
  // street's own over JBLEND m beyond it (the plane tilts across the road; the street is level across: no seam between them)
  const streetH = (x, z, h) => { let best = null, bd = Infinity; for (const q of jGrid.get(Math.floor(x / SC) * 100003 + Math.floor(z / SC)) || []) { const J = JN[q], d = Math.hypot(x - J.x, z - J.z) - J.r; if (d < JBLEND && d < bd) { bd = d; best = J; } }
    if (!best) return h; const ph = best.my + best.gx * (x - best.mx) + best.gz * (z - best.mz); if (bd <= 0) return ph; const t = bd / JBLEND, w = t * t * (3 - 2 * t); return ph + (h - ph) * w; };
  const street = (r) => !r.minor, any = () => true;
  // the base height (the road surface's at that point, before the kerb) for a point of a region of kind k
  const baseAt = (x, z, k) => { const minorK = k === KIND.alley || k === KIND.pavers || k === KIND.gravel, n = nearest(x, z, minorK ? any : street) || nearest(x, z, any); if (!n) return g(x, z);
    if (minorK && n.d > 0) { const f = Math.min(1, n.d / 20); return n.h + (g(x, z) - n.h) * f; } // (a plaza's middle, away from its ways: towards the ground)
    if (n.r.minor) return n.h;
    // (where two streets meet away from a junction, blended across the line between them: no step where the nearest changes)
    const two = nearest2(x, z, street); let hh = n.h; if (two.length === 2 && two[1].d - two[0].d < SBLEND) { const t = (two[1].d - two[0].d) / SBLEND, w = 0.5 + 0.5 * t * t * (3 - 2 * t); hh = two[0].h * w + two[1].h * (1 - w); }
    return streetH(x, z, hh); };
  // ---- 3. outlines (centimetres)
  t0 = performance.now();
  const off = (rings, d, open = true) => { const co = new CL.ClipperOffset(2, ARC); co.AddPaths(toC(rings), CL.JoinType.jtRound, open ? CL.EndType.etOpenRound : CL.EndType.etClosedPolygon); const s = new CL.Paths(); co.Execute(s, d); return fromC(s); };
  const union = (...ps) => bool(CL.ClipType.ctUnion, ps.flat(), null), minus = (a, ...bs) => (bs.length ? bool(CL.ClipType.ctDifference, a, union(...bs)) : a), inter = (a, b) => bool(CL.ClipType.ctIntersection, a, b);
  const path = (pts) => pts.map(([x, z]) => [cm(x), cm(z)]);
  const strips = (filter, width) => { const out = []; for (const r of runs) if (filter(r)) { const d = width(r); if (d > 0) out.push(...off([path(r.pts)], cm(d))); } return out; };
  const minorKind = (r) => (!r.minor ? -1 : r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const area = (surfs) => (w.net.areas || []).filter((a) => surfs.includes(a.surf || 0) && a.bb[2] > R.x0 && a.bb[0] < R.x1 && a.bb[3] > R.z0 && a.bb[1] < R.z1).map((a) => { const pts = []; for (let q = 0; q < a.ring.length; q += 2) pts.push([a.ring[q], a.ring[q + 1]]); return path(pts); });
  const lap = (m) => log(`  [layout]   ${m} +${Math.round(performance.now() - t0)} ms`);
  const simp = (P) => union(P.map((r) => rdpRing(r, SIMPLIFY)).filter((r) => r.length >= 3)); // (before the regions are cut from each other: they share these corners)
  const Tc = simp(union(strips(street, (r) => r.hw))), Pv = simp(union(strips((r) => r.pave > 0, (r) => r.hw + r.pave))), Vg = simp(union(strips((r) => !r.minor && !r.pave, (r) => r.hw + VERGE)));
  const Ta = simp(union(strips((r) => minorKind(r) === KIND.alley, (r) => r.hw), area([0]))), Tp = simp(union(strips((r) => minorKind(r) === KIND.pavers, (r) => r.hw), area([1]))), Tg = simp(union(strips((r) => minorKind(r) === KIND.gravel, (r) => r.hw), area([2])));
  lap('strips'); const Pall = minus(Pv, Tc), K = inter(off(Tc, cm(KERB_W), false), Pall);
  const REG = [[KIND.tarmac, Tc], [KIND.kerb, K], [KIND.pave, minus(Pall, K)]];
  REG.push([KIND.alley, minus(Ta, Tc, Pall)]); REG.push([KIND.pavers, minus(Tp, Tc, Pall, Ta)]); REG.push([KIND.gravel, minus(Tg, Tc, Pall, Ta, Tp)]); REG.push([KIND.verge, minus(Vg, Tc, Pall, Ta, Tp, Tg).filter((p) => Math.abs(ringArea(p)) > 5000)]); // (no slivers under 0.5 m²: the ground there)
  const TD = distIndex(Tc); // (distance to the carriageway's edge: the pavements' physics ramp)
  lap('regions'); const F = union(...REG.map((r) => r[1]));
  log(`  [layout] runs ${runs.length}, outline rings ${REG.map(([k, P]) => k + ':' + P.length).join(' ')}`);
  tic('outlineMs', t0);
  // drawn and physics heights of a point in region k
  const drawnY = (x, z, k) => baseAt(x, z, k) + (k === KIND.pave ? KERB : 0);
  // ---- 4. the reshaped ground: from the paved edge a 1:2 slope until it meets the natural ground
  t0 = performance.now();
  const Fx = regionIndex(F), edgeY = (x, z) => { const n = nearest(x, z, any); if (!n) return null; const b = n.r.minor ? n.h : streetH(x, z, n.h); return { y: b + (n.r.pave ? KERB : 0), d: Math.max(0, n.d - (n.r.pave || (n.r.minor ? 0 : VERGE))) }; };
  // a city's lots (the open ground between its streets and buildings) at its pavements' top, blended between the two
  // nearest streets, as far as CITY_REACH from them; elsewhere from the paved edge a 1:2 slope to the natural ground
  const lotY = (x, z) => { const two = nearest2(x, z); if (!two.length) return null; let s = 0, ws = 0; for (const n of two) { const b = streetH(x, z, n.h), wt = 1 / Math.max(0.5, n.d); s += (b + KERB) * wt; ws += wt; } return { y: s / ws, d: two[0].d }; };
  const bankH = (x, z) => { const gz = g(x, z); if (city) { const l = lotY(x, z); if (l && l.d <= CITY_REACH) return l.y; } const e = edgeY(x, z); if (!e || e.d > BANK_MAX) return gz; return e.y > gz ? Math.max(gz, e.y - SLOPE * e.d) : Math.min(gz, e.y + SLOPE * e.d); };
  // (the modified lattice cells, merged into one rectangle per run along each row, then outlined)
  const sq = [], bx0 = R.x0 + MARGIN - BANK_MAX, bx1 = R.x1 - MARGIN + BANK_MAX;
  for (let z = R.z0 + MARGIN - BANK_MAX; z <= R.z1 - MARGIN + BANK_MAX; z += BANK_STEP) {
    let run = null; const flush = (xe) => { if (run != null) sq.push(path([[run - BANK_STEP / 2, z - BANK_STEP / 2], [xe + BANK_STEP / 2, z - BANK_STEP / 2], [xe + BANK_STEP / 2, z + BANK_STEP / 2], [run - BANK_STEP / 2, z + BANK_STEP / 2]])); run = null; };
    let last = 0; for (let x = bx0; x <= bx1; x += BANK_STEP) { const on = !Fx.inside(cm(x), cm(z)) && Math.abs(bankH(x, z) - g(x, z)) > BANK_MIN; if (on && run == null) run = x; if (!on) flush(last); last = x; } flush(last);
  }
  log(`  [layout] bank rectangles ${sq.length} +${Math.round(performance.now() - t0)} ms`);
  const M = minus(union(union(sq).map((r) => rdpRing(r, 150)).filter((r) => r.length >= 3)), F).filter((p) => Math.abs(ringArea(p)) > 4e4);
  REG.push([KIND.bank, M]);
  tic('bankMs', t0);
  // ---- 5. per chunk
  const out = [];
  for (const [ix, iz] of chunks) {
    t0 = performance.now();
    const x0 = ix * CHUNK, z0 = iz * CHUNK, X0 = cm(x0), Z0 = cm(z0), S = cm(CHUNK);
    const box = [path([[x0, z0], [x0 + CHUNK, z0], [x0 + CHUNK, z0 + CHUNK], [x0, z0 + CHUNK]])];
    const regs = REG.map(([k, P]) => [k, inter(splitAtGrid(P, S), box).filter((p) => p.length >= 3)]);
    log(`  [layout]   clipped +${Math.round(performance.now() - t0)} ms`); const idx = regs.map(([k, P]) => [k, regionIndex(P)]), kindAt = (X, Z) => { if (X <= X0 || Z <= Z0 || X >= X0 + S || Z >= Z0 + S) return KIND.out; for (const [k, I] of idx) if (I.inside(X, Z)) return k; return KIND.ground; };
    // the points: the chunk's edge every EDGE_STEP m and where outlines cross it, every outline's corners, the bank's lattice inside it
    const key = new Map(), P = []; const add = (X, Z) => { X = Math.max(X0, Math.min(X0 + S, X)); Z = Math.max(Z0, Math.min(Z0 + S, Z)); const k = X * 1e7 + Z; let i = key.get(k); if (i == null) { i = P.length; key.set(k, i); P.push([X, Z]); } return i; };
    for (let s = 0; s <= S; s += EDGE_STEP * 100) { add(X0 + s, Z0); add(X0 + s, Z0 + S); add(X0, Z0 + s); add(X0 + S, Z0 + s); }
    const E = new Map(), addE = (a, b) => { if (a === b) return; const k = a < b ? a * 1e7 + b : b * 1e7 + a; if (!E.has(k)) E.set(k, [a, b]); };
    for (const [, Ps] of regs) for (const p of Ps) for (let q = 0; q < p.length; q++) addE(add(p[q][0], p[q][1]), add(p[(q + 1) % p.length][0], p[(q + 1) % p.length][1]));
    const onB = (i) => P[i][0] === X0 || P[i][1] === Z0 || P[i][0] === X0 + S || P[i][1] === Z0 + S;
    for (const [k, [a, b]] of [...E]) if (onB(a) && onB(b) && (P[a][0] === P[b][0] || P[a][1] === P[b][1]) && (P[a][0] === X0 || P[a][0] === X0 + S || P[a][1] === Z0 || P[a][1] === Z0 + S)) E.delete(k); // (along the edge: the edge's own segments below)
    const side = (f) => P.map((p, i) => i).filter((i) => f(P[i]));
    for (const [f, ax] of [[(p) => p[1] === Z0, 0], [(p) => p[1] === Z0 + S, 0], [(p) => p[0] === X0, 1], [(p) => p[0] === X0 + S, 1]]) { const s = side(f).sort((a, b) => P[a][ax] - P[b][ax]); for (let q = 0; q + 1 < s.length; q++) addE(s[q], s[q + 1]); }
    const nOutline = P.length; log(`  [layout]   ${P.length} outline points, ${E.size} edges +${Math.round(performance.now() - t0)} ms`);
    // the bank's inside: lattice points with their heights (away from its edges)
    const Mi = idx.find(([k]) => k === KIND.bank)[1], EI = segIndex(P, [...E.values()]);
    const step = city ? CITY_IN : BANK_IN; for (let x = x0 + step / 2; x < x0 + CHUNK; x += step) for (let z = z0 + step / 2; z < z0 + CHUNK; z += step) { const X = cm(x), Z = cm(z); if (Mi.inside(X, Z) && EI.clear(X, Z, 150)) add(X, Z); }
    // edges split where a point lies on them (within 1 cm: Clipper's rounded crossings)
    const edges = []; const PI = pointIndex(P);
    for (const [a, b] of E.values()) { const on = PI.onSegment(a, b, 1.01); if (!on.length) { edges.push([a, b]); continue; } const chain = [a, ...on, b]; for (let q = 0; q + 1 < chain.length; q++) if (chain[q] !== chain[q + 1]) edges.push([chain[q], chain[q + 1]]); }
    log(`  [layout]   split on points +${Math.round(performance.now() - t0)} ms`);
    // crossing edges (two regions' rounded outlines): split at the crossing, until none cross
    for (let pass = 0; pass < 4; pass++) { const n0 = edges.length, sp = crossings(P, edges, add); if (!sp) break; const PI2 = pointIndex(P), out = [];
      for (const [a, b] of edges) { const on = PI2.onSegment(a, b, 1.01); if (!on.length) { out.push([a, b]); continue; } const chain = [a, ...on, b]; for (let q = 0; q + 1 < chain.length; q++) if (chain[q] !== chain[q + 1]) out.push([chain[q], chain[q + 1]]); }
      const seen = new Set(); edges.length = 0; for (const [a, b] of out) { const k = a < b ? a * 1e7 + b : b * 1e7 + a; if (!seen.has(k)) { seen.add(k); edges.push([a, b]); } } log(`  [layout] pass ${pass}: ${sp} crossings, edges ${n0} -> ${edges.length}`); }
    // each edge's kinds either side, and each point's heights and road coordinates
    { const seen = new Set(), uniq = []; for (const [a, b] of edges) { if (a === b) continue; const k = a < b ? a * 1e7 + b : b * 1e7 + a; if (!seen.has(k)) { seen.add(k); uniq.push([a, b]); } } edges.length = 0; edges.push(...uniq); } // (each edge once)
    log(`  [layout]   planar +${Math.round(performance.now() - t0)} ms`); const ek = new Uint8Array(edges.length * 2);
    edges.forEach(([a, b], e) => { const [ax, az] = P[a], [bx, bz] = P[b], l = Math.hypot(bx - ax, bz - az) || 1, mx = (ax + bx) / 2, mz = (az + bz) / 2, nx = -(bz - az) / l * 2, nz = (bx - ax) / l * 2; ek[e * 2] = kindAt(Math.round(mx + nx), Math.round(mz + nz)); ek[e * 2 + 1] = kindAt(Math.round(mx - nx), Math.round(mz - nz)); });
    const kindsOf = P.map(() => new Set()); edges.forEach(([a, b], e) => { for (const v of [a, b]) { kindsOf[v].add(ek[e * 2]); kindsOf[v].add(ek[e * 2 + 1]); } });
    const n = P.length, L = { ix, iz, x0, z0, size: CHUNK, px: new Uint16Array(n), pz: new Uint16Array(n), py: new Int32Array(n), pdy: new Int16Array(n), ru: new Float32Array(n), rv: new Int16Array(n), rhw: new Uint8Array(n), rl: new Uint8Array(n), rdj: new Int16Array(n).fill(-1) };
    for (let i = 0; i < n; i++) {
      const X = P[i][0], Z = P[i][1], x = X / 100, z = Z / 100; L.px[i] = X - X0; L.pz[i] = Z - Z0;
      const ks = i < nOutline ? kindsOf[i] : new Set([KIND.bank]); let y, py;
      if (!ks.size || i >= nOutline) { const k = kindAt(X, Z); y = k === KIND.bank || k === KIND.ground || k === KIND.out ? bankH(x, z) : drawnY(x, z, k); py = y; } // (the chunk's edge and the bank's inside)
      else if (ks.has(KIND.tarmac)) { y = baseAt(x, z, KIND.tarmac); py = y; } // (the gutter: the carriageway's height)
      else if (ks.has(KIND.kerb) || ks.has(KIND.pave)) { y = baseAt(x, z, KIND.pave) + KERB; py = y - KERB * (1 - Math.min(1, TD.dist(X, Z, cm(PAVE_RAMP)) / cm(PAVE_RAMP))); } // (the kerb's top and the slabs: physics ramps up to them from the carriageway's edge, no kerb)
      else { const k = [...ks].find((q) => q >= KIND.tarmac && q !== KIND.out); y = k != null ? drawnY(x, z, k) : bankH(x, z); py = y; }
      L.py[i] = Math.round(y * 1000); L.pdy[i] = Math.max(-32768, Math.min(32767, Math.round((py - y) * 1000)));
      if (ks.has(KIND.tarmac) || kindAt(X, Z) === KIND.tarmac) { const r = nearest(x, z, street); if (r) { L.ru[i] = r.u; L.rv[i] = Math.round(Math.max(-327, Math.min(327, r.v)) * 100); L.rhw[i] = Math.min(255, Math.round(r.r.hw * 10)); L.rl[i] = Math.min(15, r.r.lanes) | (r.r.oneway ? 16 : 0) | 32;
        const J = JN.reduce((b, J) => { const d = Math.hypot(r.px - J.x, r.pz - J.z) - J.r; return d < b ? d : b; }, Infinity); L.rdj[i] = J < 60 ? Math.round(Math.max(-3000, J * 10)) : -1; } }
    }
    log(`  [layout]   heights +${Math.round(performance.now() - t0)} ms`); L.ea = Uint32Array.from(edges, (e) => e[0]); L.eb = Uint32Array.from(edges, (e) => e[1]); L.ek = ek;
    // the hi grid's points the layout replaces: inside its footprint (paved or bank), or within 0.75 m of its points or edges
    const G = w.real.hi, i0 = Math.ceil((x0 + 0.5 - G.x0) / G.sp), i1 = Math.floor((x0 + CHUNK - 0.5 - G.x0) / G.sp), j0 = Math.ceil((z0 + 0.5 - G.z0) / G.sp), j1 = Math.floor((z0 + CHUNK - 0.5 - G.z0) / G.sp);
    L.lat = { i0, j0, ni: i1 - i0 + 1, nj: j1 - j0 + 1 }; L.mask = new Uint8Array(Math.ceil(L.lat.ni * L.lat.nj / 8));
    const EI2 = segIndex(P, edges);
    for (let j = 0; j < L.lat.nj; j++) for (let i = 0; i < L.lat.ni; i++) { const X = cm(G.x0 + (i0 + i) * G.sp), Z = cm(G.z0 + (j0 + j) * G.sp), k = kindAt(X, Z); if (k !== KIND.ground || !EI2.clear(X, Z, 75) || !PI.clear(X, Z, 75)) { const b = j * L.lat.ni + i; L.mask[b >> 3] |= 1 << (b & 7); } }
    tic('chunkMs', t0);
    // the bake checks itself: every fixed edge taken, the chunk covered
    const lat = new Float32Array(L.lat.ni * L.lat.nj); for (let j = 0; j < L.lat.nj; j++) for (let i = 0; i < L.lat.ni; i++) lat[j * L.lat.ni + i] = G.H[(j0 + j) * G.n + i0 + i];
    // each fixed edge's kinds either side, as the triangles there are (their middles' regions); then the game's way of
    // labelling (from the edges, flooding across the rest) must give every triangle the same kind
    const grid = { x0: G.x0, z0: G.z0, sp: G.sp }, kindOf = (x, z) => kindAt(x * 100, z * 100);
    for (let pass = 0; pass < 4; pass++) { // (a boundary between two kinds that isn't a fixed edge: made one, or the grid point on it left out)
      const o = { classify: kindOf }; L.ek = meshChunk(L, grid, lat, 'fine', o).ek; if (!o.cuts.length) break;
      const have = new Set(); for (let e = 0; e < L.ea.length; e++) have.add(Math.min(L.ea[e], L.eb[e]) * 1e7 + Math.max(L.ea[e], L.eb[e])); const add2 = [];
      for (const [a, b] of o.cuts) { if (a >= 0 && b >= 0) { const k = Math.min(a, b) * 1e7 + Math.max(a, b); if (!have.has(k)) { have.add(k); add2.push([a, b]); } } else for (const s of [a, b]) if (s < 0) { const k = -1 - s; L.mask[k >> 3] |= 1 << (k & 7); } }
      log(`  [layout]   pass ${pass}: ${o.cuts.length} unfixed boundaries, ${add2.length} edges added`);
      if (add2.length) { L.ea = Uint32Array.from([...L.ea, ...add2.map((e) => e[0])]); L.eb = Uint32Array.from([...L.eb, ...add2.map((e) => e[1])]); }
    }
    const mf = meshChunk(L, grid, lat, 'fine'); let wrong = 0;
    for (let q = 0; q < mf.tk.length; q++) { const a = mf.idx[q * 3], b = mf.idx[q * 3 + 1], c = mf.idx[q * 3 + 2], P3 = mf.pos; const want = kindOf((P3[a * 3] + P3[b * 3] + P3[c * 3]) / 3, (P3[a * 3 + 2] + P3[b * 3 + 2] + P3[c * 3 + 2]) / 3); if (mf.tk[q] !== want) { wrong++; log(`  [layout] a ${want} triangle labelled ${mf.tk[q]} at ${[a, b, c].map((v) => P3[v * 3].toFixed(2) + ',' + P3[v * 3 + 2].toFixed(2)).join(' ')}`); } }
    mf.stats.wrongKind = wrong;
    out.push({ L, stats: { points: n, edges: edges.length, mesh: mf.stats } });
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
