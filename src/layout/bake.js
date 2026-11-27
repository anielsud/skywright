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
//  4. per chunk: the outlines (clipped to it, split where they cross) and the network within NET_PAD of it, quantized.
//     Everything else (heights, the reshaped ground, the markings' coordinates) the game works out with rules.js.
import CL from '../../vendor/layout/clipper1.mjs';
import { CHUNK, KIND, RKINDS, encodeLayout, stations } from './format.js';
import { VERGE } from './rules.js';

const SEG = 8, MARGIN = 150, ARC = 8, SIMPLIFY = 25, SHAPE_TOL = 15, EDGE_STEP = 4, NET_PAD = 75; // (NET_PAD: the network stored with a chunk reaches this far past it: past every rule's reach, rules.js)
const PAVE = { main: 4.5, street: 3.5 }; // (as roadgrade.js: a city street's pavement, a country road's verge)
const GRADE = { highway: 0.07, main: 0.12, street: 0.2 }, GRADE_MINOR = 0.25;
const cm = (v) => Math.round(v * 100);

export function bakeLayout(w, chunks, log = () => {}, opts = {}) {
  const T = {}, tic = (k, t0) => { T[k] = (T[k] || 0) + performance.now() - t0; log(`  [layout] ${k} ${Math.round(T[k])} ms`); }, city = !!w.loc.city, g = (x, z) => w.real.height(x, z);
  const ix0 = Math.min(...chunks.map((c) => c[0])), ix1 = Math.max(...chunks.map((c) => c[0])), iz0 = Math.min(...chunks.map((c) => c[1])), iz1 = Math.max(...chunks.map((c) => c[1]));
  const R = { x0: ix0 * CHUNK - MARGIN, x1: (ix1 + 1) * CHUNK + MARGIN, z0: iz0 * CHUNK - MARGIN, z1: (iz1 + 1) * CHUNK + MARGIN }, inR = (p, m = 0) => p.x > R.x0 - m && p.x < R.x1 + m && p.z > R.z0 - m && p.z < R.z1 + m;
  // ---- 1. network
  let t0 = performance.now();
  const V = [], node = new Map(), runs = [];
  const newVar = (x, z) => (V.push({ x, z, g: g(x, z) }), V.length - 1);
  for (const rd of w.net.roads) {
    if (rd.kind === 'rail' || rd.baked) continue; // (rail; the airport's own roads)
    const n0 = rd.pts.length, P = rd.closed ? [...rd.pts, rd.pts[0]] : rd.pts, n = P.length; let a = -1, b = -1; // (a roundabout's ring: closed as a line)
    for (let i = 0; i < n; i++) if (inR(P[i])) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    a = Math.max(0, a - 1); b = Math.min(n - 1, b + 1);
    // (a road's stretches on bridges or in tunnels aren't the layout's: the chunks they're in keep today's roads (bakeChunks'
    // fallback); the stretches either side of one are roads of their own here)
    const bad = (i) => !!(rd.bridge?.[i % n0] || rd.tube?.[i % n0] || rd.span?.[i % n0]), jn = new Map(rd.jn || []);
    for (let s0 = a; s0 <= b;) {
      if (bad(s0)) { s0++; continue; } let e0 = s0; while (e0 + 1 <= b && !bad(e0 + 1)) e0++;
      if (e0 > s0) {
        const pts = [], vars = [], osm = []; // (osm: which of pts are the road's own points)
        for (let i = s0; i <= e0; i++) {
          if (i > s0) { const p = P[i - 1], q = P[i], l = Math.hypot(q.x - p.x, q.z - p.z), k = Math.ceil(l / SEG); for (let s = 1; s < k; s++) { const x = p.x + (q.x - p.x) * s / k, z = p.z + (q.z - p.z) * s / k; pts.push([x, z]); vars.push(newVar(x, z)); } }
          const nd = jn.get(i % n0); let v; if (nd != null && node.has(nd)) v = node.get(nd); else if (rd.closed && i === n0 && vars.length) v = vars[0]; else { v = newVar(P[i].x, P[i].z); if (nd != null) node.set(nd, v); }
          osm.push(pts.length); pts.push([P[i].x, P[i].z]); vars.push(v);
        }
        const minor = !!rd.minor, kind = rd.kind;
        runs.push({ cutA: s0 > a || (a > 0 && bad(a - 1)), cutB: e0 < b || (b < n - 1 && bad(b + 1)), rd, osmPts: osm.map((k) => pts[k]), kind, minor, surf: rd.surf || 0, hw: rd.width / 2, lanes: rd.lanes || (rd.oneway ? 1 : 2), oneway: !!rd.oneway, layer: rd.layer || 0, pts, vars, grade: minor ? GRADE_MINOR : GRADE[kind] ?? 0.2, pave: city && !minor && !rd.baked && PAVE[kind] ? PAVE[kind] : 0 });
      }
      s0 = e0 + 1;
    }
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
  const WG = opts.WG ?? 0.1; // (the natural ground's pull against the neighbours' 1/l, per station: a weaker pull smoothed hairpins metres off the ground, #297)
  let iters = 0;
  for (; iters < 600; iters++) {
    for (let k = 0; k < nv; k++) { const N = nb[k]; if (!N.length) continue; let s = WG * V[k].g, ws = WG; for (const [o, wt] of N) { s += wt * h[o]; ws += wt; } h[k] = s / ws; }
    toPlane(); clampGrades(2);
  }
  // (last: each junction on its plane, then every road within its grade limit, away from the junctions: a junction's own
  // slope is its ground's; the clamp leaves a junction's points where they are and moves the road's next to it)
  toPlane(); const memberOf = new Map(); JN.forEach((J, q) => { for (const k of J.m) memberOf.set(k, q); });
  const member = { has: (k) => memberOf.has(k) }, inOne = (a, b) => memberOf.has(a) && memberOf.get(a) === memberOf.get(b);
  for (let p = 0; p < 400; p++) { let moved = 0; for (const [a, b, l, G] of edges) { if (inOne(a, b)) continue; const d = h[a] - h[b], lim = G * l; if (Math.abs(d) <= lim + 1e-4) continue; const ex = Math.abs(d) - lim, sg = Math.sign(d);
    if (member.has(a)) h[b] += ex * sg; else if (member.has(b)) h[a] -= ex * sg; else { h[a] -= ex / 2 * sg; h[b] += ex / 2 * sg; } moved++; } if (!moved) break; }
  let dev = 0, over = 0; for (let k = 0; k < nv; k++) dev = Math.max(dev, Math.abs(h[k] - V[k].g)); for (const [a, b, l, G] of edges) if (!inOne(a, b)) over = Math.max(over, Math.abs(h[a] - h[b]) / l - G);
  T.solve = { vars: nv, junctions: JN.length, iters, maxFromGround: +dev.toFixed(2), worstOverGrade: +Math.max(0, over).toFixed(3) };
  { // (the worst edges over their limit: between which junctions, how long, how far the planes' ends are apart)
    const ov = edges.filter(([a, b]) => !inOne(a, b)).map(([a, b, l, G]) => [Math.abs(h[a] - h[b]) / l - G, a, b, l, G]).filter((e) => e[0] > 1e-3).sort((p, q) => q[0] - p[0]);
    T.overGrade = { edges: ov.length, bothJunctions: ov.filter(([, a, b]) => memberOf.has(a) && memberOf.has(b)).length, worst: ov.slice(0, 4).map(([o, a, b, l, G]) => ({ x: +V[a].x.toFixed(1), z: +V[a].z.toFixed(1), over: +o.toFixed(3), l: +l.toFixed(1), limit: G, rise: +Math.abs(h[a] - h[b]).toFixed(2), ends: [memberOf.has(a) ? 'junction' : V[a].tie ? 'tie' : 'road', memberOf.has(b) ? 'junction' : V[b].tie ? 'tie' : 'road'] })) }; }
  { const inJ = new Map(); JN.forEach((J, q) => J.m.forEach((k) => inJ.set(k, q)));
    const grade = (k) => { let gmax = 0; for (const [o] of nb[k]) { const l = Math.hypot(V[o].x - V[k].x, V[o].z - V[k].z); if (l > 0.5) gmax = Math.max(gmax, Math.abs(V[o].g - V[k].g) / l); } return gmax; };
    const cset = new Set(chunks.map(([ix, iz]) => ix * 100003 + iz)), inC = (k) => cset.has(Math.floor(V[k].x / CHUNK) * 100003 + Math.floor(V[k].z / CHUNK));
    // forced: the steepest the natural ground climbs along the road over 80 m about the point, against its limit
    const forced = (k) => { for (const r of runs) { const i = r.vars.indexOf(k); if (i < 0) continue; let a = i, b = i; while (a > 0 && r.s[i] - r.s[a] < 40) a--; while (b < r.vars.length - 1 && r.s[b] - r.s[i] < 40) b++; const l = r.s[b] - r.s[a]; return l > 20 ? +(Math.abs(V[r.vars[b]].g - V[r.vars[a]].g) / l).toFixed(2) : null; } return null; };
    const ins = [...V.keys()].filter(inC); T.inChunk = { vars: ins.length, maxFromGround: +ins.reduce((m, k) => Math.max(m, Math.abs(h[k] - V[k].g)), 0).toFixed(2), over2m: ins.filter((k) => Math.abs(h[k] - V[k].g) > 2).length };
    // (why each is over 2 m: the ground along the road climbs faster than its limit over 80 m (forced); within 150 m of
    // where a road stops at a bridge or tunnel left out (cut); in a junction; else)
    { const cutEnds = []; for (const r of runs) { if (r.cutA) cutEnds.push(r.pts[0]); if (r.cutB) cutEnds.push(r.pts[r.pts.length - 1]); } const cg = new Map(); for (const [x, z] of cutEnds) { const k = Math.floor(x / 150) * 100003 + Math.floor(z / 150); (cg.get(k) || cg.set(k, []).get(k)).push([x, z]); }
      const nearCut = (k) => { const i0 = Math.floor(V[k].x / 150), j0 = Math.floor(V[k].z / 150); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const [x, z] of cg.get(i * 100003 + j) || []) if (Math.hypot(x - V[k].x, z - V[k].z) < 150) return true; return false; };
      const runOf = new Map(); runs.forEach((r) => r.vars.forEach((v) => { if (!runOf.has(v)) runOf.set(v, r); }));
      const why = {}; for (const k of ins) { if (Math.abs(h[k] - V[k].g) <= 2) continue; const f = forced(k), r = runOf.get(k), w = nearCut(k) ? 'cut' : f != null && r && f > r.grade ? 'forced' : inJ.has(k) ? 'junction' : 'other'; why[w] = (why[w] || 0) + 1; } T.inChunk.over2mWhy = why; }
    T.worstIn = ins.sort((a, b) => Math.abs(h[b] - V[b].g) - Math.abs(h[a] - V[a].g)).slice(0, 6).map((k) => ({ x: +V[k].x.toFixed(1), z: +V[k].z.toFixed(1), off: +(h[k] - V[k].g).toFixed(2), grade80m: forced(k), kinds: [...new Set(runs.filter((r) => r.vars.includes(k)).map((r) => r.kind + ':' + r.grade))] }));
    T.worst = [...V.keys()].sort((a, b) => Math.abs(h[b] - V[b].g) - Math.abs(h[a] - V[a].g)).slice(0, 8).map((k) => ({ x: +V[k].x.toFixed(1), z: +V[k].z.toFixed(1), off: +(h[k] - V[k].g).toFixed(2), junction: inJ.has(k) ? { r: +JN[inJ.get(k)].r.toFixed(1), members: JN[inJ.get(k)].m.length, spread: +(Math.max(...JN[inJ.get(k)].m.map((q) => V[q].g)) - Math.min(...JN[inJ.get(k)].m.map((q) => V[q].g))).toFixed(1) } : null, tie: !!V[k].tie, terrainGrade: +grade(k).toFixed(2), kinds: [...new Set(runs.filter((r) => r.vars.includes(k)).map((r) => r.kind + ':' + r.grade))] })); }
  tic('solveMs', t0);
  const street = (r) => !r.minor;
  // the solved height of road r at (x, z) on it (its nearest point along its own stations)
  // (the same, looking only near segment `from` on: stations come in order along the road) -> [height, segment]
  const solvedNear = (r, x, z, from) => { let best = Infinity, y = 0, at = from; const a0 = Math.max(0, from - 4), a1 = Math.min(r.pts.length - 1, from + 80);
    for (let i = a0; i < a1; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; y = h[r.vars[i]] + (h[r.vars[i + 1]] - h[r.vars[i]]) * t; at = i; } }
    return best < 0.5 ? [y, at] : [solvedAt(r, x, z), from]; };
  const solvedAt = (r, x, z) => { let best = Infinity, y = 0; for (let i = 0; i + 1 < r.pts.length; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; y = h[r.vars[i]] + (h[r.vars[i + 1]] - h[r.vars[i]]) * t; } } return y; };
  const path = (pts) => pts.map(([x, z]) => [cm(x), cm(z)]);
  // ---- 4. per chunk: its outlines and the network near it, stored; then meshed the game's way, as the bake's check
  const out = [];
  const KCODE = Object.fromEntries(RKINDS.map((k, i) => [k, i]));
  // (each road's shape, simplified once; roads, junctions and plazas listed per chunk they can reach)
  const cellOf = (x, z) => Math.floor(x / CHUNK) * 100003 + Math.floor(z / CHUNK), byCell = new Map(), put = (k, kind, i) => { let c = byCell.get(k); if (!c) byCell.set(k, (c = { r: [], j: [], a: [] })); if (c[kind].at(-1) !== i) c[kind].push(i); };
  const boxCells = (x0, z0, x1, z1, kind, i) => { for (let a = Math.floor(x0 / CHUNK); a <= Math.floor(x1 / CHUNK); a++) for (let b = Math.floor(z0 / CHUNK); b <= Math.floor(z1 / CHUNK); b++) put(a * 100003 + b, kind, i); };
  runs.forEach((r, ri) => { const sh = rdpLine(r.osmPts.map(([x, z]) => [cm(x), cm(z)]), SHAPE_TOL); r.shape = [sh[0]]; for (let i = 1; i < sh.length; i++) { const [px, pz] = sh[i - 1], [qx, qz] = sh[i], k = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / 30000); for (let s2 = 1; s2 <= k; s2++) r.shape.push([Math.round(px + (qx - px) * s2 / k), Math.round(pz + (qz - pz) * s2 / k)]); }
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
    for (const r of cell.r.map((q) => runs[q])) {
      // (its shape: simplified once for the whole road, above: every chunk that stores a stretch of it stores the same
      // points, so neighbours work out the same heights and outlines)
      if (!r.shape) { const sh = rdpLine(r.osmPts.map(([x, z]) => [cm(x), cm(z)]), SHAPE_TOL); r.shape = [sh[0]]; for (let i = 1; i < sh.length; i++) { const [px, pz] = sh[i - 1], [qx, qz] = sh[i], k = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qz - pz)) / 30000); for (let s2 = 1; s2 <= k; s2++) r.shape.push([Math.round(px + (qx - px) * s2 / k), Math.round(pz + (qz - pz) * s2 / k)]); } }
      const O = r.shape.map(([X, Z]) => [X / 100, Z / 100]); let a = -1, b = -1; for (let i = 0; i + 1 < O.length; i++) if (segNear(O[i], O[i + 1])) { if (a < 0) a = i; b = i + 1; } // (every segment that comes within NET_PAD, long ones passing by too)
      if (a < 0) continue; a = Math.max(0, a - 1); b = Math.min(O.length - 1, b + 1);
      const xs = [], zs = []; for (let i = a; i <= b; i++) { xs.push(r.shape[i][0] - X0); zs.push(r.shape[i][1] - Z0); }
      let cur = 0; const hs = stations(xs, zs, 100).map(([x, z]) => { const o = solvedNear(r, (x + X0) / 100, (z + Z0) / 100, cur); cur = o[1]; return Math.round(o[0] * 100); }); // (walking along the road)
      Q.runs.push({ k: KCODE[r.kind] ?? KCODE.other, flags: (r.minor ? 1 : 0) | (r.oneway ? 2 : 0) | (Math.min(3, r.surf) << 2), hw: Math.round(r.hw * 10), pave: Math.round(r.pave * 10), lanes: Math.min(255, r.lanes), x: xs, z: zs, h: hs }); }
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
