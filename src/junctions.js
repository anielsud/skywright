// Junction boxes (#228, the 🐞 reports "ground bleedthrough" / "weird intersection"): every junction of a real place's
// road graph (roads.bin topology: a node where three or more road ends meet, rd.jn) is one continuous, level surface.
// Before, a junction was only its roads' ribbons overlapping: each ended square at the node, so where roads met at an
// angle the corners between them were bare ground; inside, RoadSurface blended the roads' own grades (a 15 m point
// spacing carried a street's slope right into the crossing), so the ribbons (two vertices across, 15 m long) cut
// under the blended ground and the near-camera ground showed through the tarmac.
//
// Each junction gets, from its arms (the roads leaving the node: their directions, half widths and pavements):
//  - a mouth on every arm at c metres from the node: far enough out that the arm's kerb and its pavement's outer edge
//    clear the neighbouring arms' (and the kerb's rounded corner fits), at least the old clearance (the widest other
//    road's half width + 1 m), at most CMAX and under half the way to the next junction;
//  - the box: the polygon through the mouths and, between neighbouring arms, the kerb's corner (a quarter round of
//    radius RK where the arms meet at an angle; the kerb lines' corner, or straight on, where they don't). It covers
//    the arms out to their mouths and the corner fill between them; the arms' own ribbons and pavements stop at the
//    mouths (roadSurface.js: rjunc's box flag), the crossings and stop lines start there;
//  - in a city, the corner pavements: between two arms' pavements, round the kerb's corner, out to the building line.
// The box is level at the node's height: gradeReal puts a point on every arm at its mouth and pins it there
// (insertMouths), RoadSurface holds the box's height inside it (physics and the near-camera ground), carveGrid pins the
// baked ground under it, and buildRoadMeshes draws it. Left as before (no box): roads merging at under 30 degrees, a
// bridge or tunnel at the node, and junctions on a street too steep to level them (gradeReal: the next junction along
// an arm out of reach at 20% from the mouths).
import * as THREE from 'three';
import { PAVE, PAVE_ROW, VERGE, inside } from './roadgrade.js';

const CMAX = 22, RK = { city: 3, country: 5 }, MIN_ANGLE = 30 * Math.PI / 180, STRAIGHT = 155 * Math.PI / 180;
export const TARMAC_LIFT = { highway: 0.08, main: 0.06, street: 0.04 }; // metres the tarmac lies over the ground it is on (roads.js)

// the nodes where three or more road ends meet (a road passing through counts twice): Map nd -> [{ k, j }]
function junctionNodes(roads) {
  const at = new Map();
  roads.forEach((rd, k) => { for (const [j, nd] of rd.jn || []) { let L = at.get(nd); if (!L) at.set(nd, (L = [])); L.push({ k, j }); } });
  for (const [nd, L] of at) if (L.reduce((a, q) => a + (q.j === 0 || q.j === roads[q.k].pts.length - 1 ? 1 : 2), 0) < 3) at.delete(nd);
  return at;
}
// 2D distances along a road
export function along(P) { const S = new Float64Array(P.length); for (let i = 1; i < P.length; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return S; }
// the right vector at point i (as roads.js frame: along the neighbours' chord)
function right2(a, b) { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; }
function right(P, i) { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; }

// The arms and mouths of every junction, from the roads' plan (x, z) alone (so the same before grading, when
// insertMouths puts the mouth points in, and after, from a road pack). city: pavements. Returns [{ nd, x, z, arms:
// [{ k, j, dir (+1: the arm runs up the road's points), hw, W (pavement width, 0 none), lift, c (mouth: metres
// along from the node) }], ok (false: no box, the roads stay as they were: a bridge or tunnel there, roads merging at
// a shallow angle) }].
export function junctionPlan(roads, city) {
  const out = [], S = new Map(), sOf = (k) => { let s = S.get(k); if (!s) S.set(k, (s = along(roads[k].pts))); return s; };
  for (const [nd, L] of junctionNodes(roads)) {
    const p0 = roads[L[0].k].pts[L[0].j], arms = []; let ok = true;
    for (const { k, j } of L) {
      const rd = roads[k], P = rd.pts, n = P.length, Sk = sOf(k);
      if (rd.baked || rd.tunnel || rd.kind === 'rail' || rd.closed) ok = false;
      for (const dir of [1, -1]) {
        if ((dir > 0 && j === n - 1) || (dir < 0 && j === 0)) continue;
        if (rd.bridge?.[j] && rd.bridge?.[j + dir]) ok = false; // (a deck from the node: not on the ground)
        // direction: to the first point at least 0.5 m away; length: to the next junction node or the road's end
        let q = j + dir; while (q + dir >= 0 && q + dir < n && Math.abs(Sk[q] - Sk[j]) < 0.5) q += dir;
        const dx = P[q].x - P[j].x, dz = P[q].z - P[j].z, l = Math.hypot(dx, dz) || 1;
        let e = j + dir; while (e > 0 && e < n - 1 && !(rd.jn || []).some(([jj]) => jj === e)) e += dir;
        const W = city && rd.kind !== 'highway' && !rd.baked ? PAVE[rd.kind] ?? 3.5 : 0;
        arms.push({ k, j, dir, dx: dx / l, dz: dz / l, hw: rd.width / 2, W, lift: TARMAC_LIFT[rd.kind] ?? 0.04, len: Math.abs(Sk[e] - Sk[j]), a: Math.atan2(dz, dx), c: 0 });
      }
    }
    arms.sort((a, b) => a.a - b.a);
    const J = { nd, x: p0.x, z: p0.z, arms, ok: ok && arms.length >= 3 };
    if (J.ok) for (let i = 0; i < arms.length; i++) { const A = arms[i], B = arms[(i + 1) % arms.length]; if (turn(A, B) < MIN_ANGLE) J.ok = false; }
    if (J.ok) {
      const rk = city ? RK.city : RK.country;
      for (const A of arms) A.c = Math.max(...arms.filter((B) => B.k !== A.k).map((B) => B.hw)) + 1; // (the old clearance: at least)
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length], phi = turn(A, B); if (phi >= STRAIGHT) continue;
        // the corner between A's left side and B's right: where their kerbs and their pavements' (or verges') outer
        // edges cross, and the round of radius rk tangent to both kerbs
        const kc = cross(A, B, A.hw, B.hw), oc = cross(A, B, A.hw + (A.W || VERGE), B.hw + (B.W || VERGE)), T = rk / Math.tan(phi / 2);
        A.c = Math.max(A.c, kc[0] + T, oc[0]); B.c = Math.max(B.c, kc[1] + T, oc[1]);
      }
      for (const A of arms) A.c = Math.floor((Math.min(A.c, CMAX, A.len * 0.45) - 0.6) * 16) / 16 + 0.6; // (the markings' clearance, c - 0.6 m, in 1/16 m: rjunc's code holds it exactly)
    }
    out.push(J);
  }
  return out;
}
// the angle from arm A round to the next arm B (counter-clockwise in x, z: atan2(z, x) increasing), 0..2pi
function turn(A, B) { let t = B.a - A.a; while (t <= 1e-9) t += Math.PI * 2; return t; }
// where A's line offset oA to its left meets B's line offset oB to its right: [metres along A, metres along B] (null:
// parallel). Left of an arm (dx, dz): (-dz, dx).
function cross(A, B, oA, oB) {
  // node + s dA + oA lA = node + t dB - oB lB  ->  s dA - t dB = -oB lB - oA lA
  const ax = A.dx, az = A.dz, bx = B.dx, bz = B.dz, rx = -oB * -bz - oA * -az, rz = -oB * bx - oA * ax, det = ax * -bz - az * -bx;
  if (Math.abs(det) < 1e-9) return [Infinity, Infinity];
  return [(rx * -bz - rz * -bx) / det, (ax * rz - az * rx) / det];
}

// Before grading (gradeReal): a point on every arm at its mouth (unless one is there already), so the profile is level
// from the node to the mouth (pinned there), for the junctions of plan (junctionPlan's, those to level): rd.pts,
// rd.bridge and rd.jn updated.
export function insertMouths(roads, plan) {
  const add = new Map();
  for (const J of plan) if (J.ok) for (const A of J.arms) { let L = add.get(A.k); if (!L) add.set(A.k, (L = [])); L.push(A); }
  for (const [k, L] of add) {
    const rd = roads[k], P = rd.pts, S = along(P), ins = [];
    for (const A of L) {
      const s = S[A.j] + A.dir * A.c; if (s <= 0.3 || s >= S[P.length - 1] - 0.3) continue;
      let i = 1; while (i < P.length - 1 && S[i] < s) i++; // (s in the segment i - 1 .. i)
      if (Math.abs(S[i] - s) < 0.05 || Math.abs(S[i - 1] - s) < 0.05 || ins.some((q) => Math.abs(q.s - s) < 0.05)) continue;
      ins.push({ i, s, t: (s - S[i - 1]) / (S[i] - S[i - 1]), p: P[i - 1].clone().lerp(P[i], (s - S[i - 1]) / (S[i] - S[i - 1])) });
    }
    ins.sort((a, b) => b.i - a.i || b.t - a.t); // (from the end: earlier indices stay put; two in one segment, the further first)
    for (const { i, p } of ins) {
      P.splice(i, 0, p);
      if (rd.bridge) rd.bridge.splice(i, 0, !!(rd.bridge[i - 1] && rd.bridge[i]));
      if (rd.jn) rd.jn = rd.jn.map(([j, nd]) => [j >= i ? j + 1 : j, nd]);
    }
  }
}

// After grading (or from a road pack): each junction's height and shapes. net.junctions = [{ nd, x, z, y, arms,
// box: [x, z, ...] (counter-clockwise), tris (indices into box), lift (per box vertex), pave: a city's corner
// pavements, per corner a Float64Array of rows round the kerb (PAVE_ROW: kerb x, z, building line x, z, v, hw, lift),
// r: Map 'k:j:dir' -> clearance for the markings (mouth - 0.6 m) }]. Only the junctions with a box (J.ok).
export function junctionShapes(roads, city) {
  const out = [], rk = city ? RK.city : RK.country, F = (junctionShapes.fail = { steep: 0, cross: 0, node: 0, tri: 0 }); // (fail: why junctions were left without a box)
  const SS = new Map(), sOf = (k) => { let s = SS.get(k); if (!s) SS.set(k, (s = along(roads[k].pts))); return s; };
  for (const J of junctionPlan(roads, city)) {
    if (!J.ok) continue;
    const A0 = J.arms[0], y = roads[A0.k].pts[A0.j].y, n = J.arms.length;
    // each arm's edges, from beside the node out to its mouth, where the ribbon's are (roads.js strip: each row's edge
    // at p + off * right, straight between rows): A.edge(o) -> [[x, z], ...] (o: metres to the arm's left)
    for (const A of J.arms) {
      const P = roads[A.k].pts, S = sOf(A.k), s = S[A.j] + A.dir * A.c;
      let i = 1; while (i < P.length - 1 && S[i] < s) i++; // (the mouth: in the segment i - 1 .. i)
      const t = Math.min(1, Math.max(0, (s - S[i - 1]) / ((S[i] - S[i - 1]) || 1))), rows = [];
      for (let q = A.j; A.dir > 0 ? q <= i - 1 : q >= i; q += A.dir) rows.push(q); // (the rows from the node up to the mouth's segment)
      // (at the node of a road passing through, the ribbon has a point just to this arm's side of it, roads.js
      // junctionPoints: its frame is along this arm's first segment)
      const split = A.j > 0 && A.j < P.length - 1, rt = (q) => (split && q === A.j ? right2(P[Math.min(q, q + A.dir)], P[Math.max(q, q + A.dir)]) : right(P, q));
      const pt = (q, o) => { const r = rt(q), oo = o * A.dir; return [P[q].x + r[0] * oo, P[q].z + r[1] * oo]; };
      A.edge = (o) => { const a = pt(i - 1, o), b = pt(i, o), m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; return [...rows.map((q) => pt(q, o)), m]; };
      A.L = A.edge(A.hw).at(-1); A.R = A.edge(-A.hw).at(-1);
      A.flat = rows.every((q) => Math.abs(P[q].y - y) < 0.03) && Math.abs(P[i - 1].y + (P[i].y - P[i - 1].y) * t - y) < 0.03;
    }
    if (!J.arms.every((A) => A.flat)) { F.steep++; continue; } // (gradeReal left it on its roads' grades: no room to level it)
    // the box: round the node, each arm's mouth and the kerb from it round the corner to the next arm's (rounded with
    // radius rr; where that makes a tangle, square)
    const ring = (rr) => {
      const V = [], corners = [];
      for (let i = 0; i < n; i++) {
        const A = J.arms[i], B = J.arms[(i + 1) % n], phi = turn(A, B);
        V.push({ p: A.R, lift: A.lift, mouth: true, open: true }, { p: A.L, lift: A.lift, mouth: true }); // (open: the edge from it, R to L, is the mouth)
        // the kerb from A's mouth (its left edge) round to B's (its right edge): along A's edge in to where it meets
        // B's, rounded there, out along B's; where they don't meet (straight on, the outside of a bend), in to beside
        // the node (or where the kerbs' lines meet just behind it) and out again
        const kerb = corner(A.edge(A.hw), B.edge(-B.hw), phi, rr, A, B);
        const outer = A.W && B.W ? corner(A.edge(A.hw + A.W), B.edge(-(B.hw + B.W)), phi, 0, A, B) : null; // (the building line: square)
        corners.push({ i, kerb, outer });
        for (let q = 1; q < kerb.length - 1; q++) V.push({ p: kerb[q], lift: A.lift + (B.lift - A.lift) * q / (kerb.length - 1) });
      }
      const W = []; for (const v of V) { const l = W.at(-1); if (l && !v.mouth && Math.hypot(v.p[0] - l.p[0], v.p[1] - l.p[1]) < 0.1) continue; W.push(v); }
      while (W.length > 3 && !W.at(-1).mouth && Math.hypot(W.at(-1).p[0] - W[0].p[0], W.at(-1).p[1] - W[0].p[1]) < 0.1) W.pop();
      const box = W.flatMap((v) => v.p);
      return selfCrosses(box) ? null : { box, lift: W.map((v) => v.lift), open: Uint8Array.from(W, (v) => (v.open ? 1 : 0)), corners };
    };
    const R = ring(rk) || ring(0);
    if (!R) { F.cross++; continue; }
    const { box, lift, open, corners } = R, nb = box.length / 2;
    if (!inside(box, J.x, J.z)) { F.node++; continue; }
    const tris = THREE.ShapeUtils.triangulateShape(Array.from({ length: nb }, (_, q) => new THREE.Vector2(box[q * 2], box[q * 2 + 1])), []).flat();
    if (tris.length < 3 * (nb - 2)) { F.tri++; continue; }
    for (let q = 0; q < tris.length; q += 3) { const [a, b, c] = [tris[q], tris[q + 1], tris[q + 2]]; if ((box[b * 2] - box[a * 2]) * (box[c * 2 + 1] - box[a * 2 + 1]) - (box[b * 2 + 1] - box[a * 2 + 1]) * (box[c * 2] - box[a * 2]) > 0) { tris[q + 1] = c; tris[q + 2] = b; } } // (facing up: clockwise in x, z)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let q = 0; q < nb; q++) { x0 = Math.min(x0, box[q * 2]); x1 = Math.max(x1, box[q * 2]); z0 = Math.min(z0, box[q * 2 + 1]); z1 = Math.max(z1, box[q * 2 + 1]); }
    // the corner pavements (a city's): rows across the kerb's corner, out to the building line
    const pave = [];
    for (const { i, kerb: K, outer } of corners) {
      if (!outer) continue;
      const A = J.arms[i], B = J.arms[(i + 1) % n], m = K.length, rows = new Float64Array(m * PAVE_ROW);
      // (each kerb point's partner on the building line at the same share of the way round: rows that never cross,
      // where the building line is much shorter than the kerb's round, or just its corner)
      const len = (L) => { let t = 0; for (let q = 1; q < L.length; q++) t += Math.hypot(L[q][0] - L[q - 1][0], L[q][1] - L[q - 1][1]); return t; }, Lk = len(K) || 1, Lo = len(outer);
      let v = 0;
      for (let q = 0; q < m; q++) {
        if (q) v += Math.hypot(K[q][0] - K[q - 1][0], K[q][1] - K[q - 1][1]);
        const f = m > 1 ? q / (m - 1) : 0;
        const o = q === m - 1 ? outer.at(-1) : walk(outer, Lo * v / Lk);
        rows.set([K[q][0], K[q][1], o[0], o[1], v, A.hw + (B.hw - A.hw) * f, A.lift + (B.lift - A.lift) * f], q * PAVE_ROW);
      }
      pave.push(rows);
    }
    const r = new Map(); for (const A of J.arms) r.set(A.k + ':' + A.j + ':' + A.dir, A.c - 0.6);
    out.push({ nd: J.nd, x: J.x, z: J.z, y, arms: J.arms.map(({ k, j, dir, hw, W, lift, c }) => ({ k, j, dir, hw, W, lift, c })), box: Float64Array.from(box), open, tris, lift, pave, r, bb: [x0, z0, x1, z1] });
  }
  return out;
}
// The path round a junction's corner from arm A's mouth to the next arm B's (counter-clockwise), given their edges on
// that side (ea: A's left, eb: B's right; each from beside the node out to the mouth), the turn phi from A to B and
// a radius r to round it with (0: square). [[x, z], ...] from A's mouth to B's.
function corner(ea, eb, phi, r, A, B) {
  // where the edges cross (the furthest out along A): the corner (on a bend's outside too, where a curving arm's edge
  // crosses the other's near the node: there it's square)
  let X = null;
  for (let a = 0; a + 1 < ea.length; a++) for (let b = 0; b + 1 < eb.length; b++) {
    const h = segX(ea[a], ea[a + 1], eb[b], eb[b + 1]); if (h && (!X || a + h[0] > X.a + X.ta)) X = { a, ta: h[0], b, tb: h[1] };
  }
  if (phi >= STRAIGHT) r = 0;
  {
    if (X) {
      const pa = lerp2(ea[X.a], ea[X.a + 1], X.ta), path = [];
      for (let q = ea.length - 1; q > X.a; q--) path.push(ea[q]);
      const T = r > 0 ? r / Math.tan(phi / 2) : 0;
      if (T > 0.05) { // the round: a quadratic curve from T before the corner to T after it, through near it
        const back = walk(path.concat([pa]).reverse(), T), on = [pa, ...eb.slice(X.b + 1)], fwd = walk(on, T);
        const keepA = path.filter((p) => Math.hypot(p[0] - pa[0], p[1] - pa[1]) > T + 0.01), keepB = eb.slice(X.b + 1).filter((p) => Math.hypot(p[0] - pa[0], p[1] - pa[1]) > T + 0.01);
        const m = Math.max(2, Math.ceil((Math.PI - phi) / (Math.PI / 6)));
        const arc = []; for (let q = 0; q <= m; q++) { const t = q / m, u = 1 - t; arc.push([u * u * back[0] + 2 * u * t * pa[0] + t * t * fwd[0], u * u * back[1] + 2 * u * t * pa[1] + t * t * fwd[1]]); }
        return dedupe([...keepA, ...arc, ...keepB]);
      }
      return dedupe([...path, pa, ...eb.slice(X.b + 1)]);
    }
    if (phi < STRAIGHT) return dedupe([ea.at(-1), eb.at(-1)]); // (they don't meet before the mouths: straight across)
  }
  // straight on, or the outside of a bend: in along A to beside the node, out along B; on the outside of a sharp bend
  // via where the two kerbs' lines meet behind the node
  const a0 = ea[0], b0 = eb[0], back = Math.max(A.hw, B.hw) * 3, path = ea.slice().reverse();
  if (phi > Math.PI * 2 - STRAIGHT) {
    const h = lineX(a0, -A.dx, -A.dz, b0, -B.dx, -B.dz); // (both lines run back from beside the node)
    if (h && h[0] > 0 && h[0] < back && h[1] > 0 && h[1] < back) path.push([a0[0] - A.dx * h[0], a0[1] - A.dz * h[0]]);
  }
  return dedupe([...path, ...eb]);
}
// where segments p0-p1 and q0-q1 cross: [t along p, t along q] or null
function segX(p0, p1, q0, q1) {
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1], ex = q1[0] - q0[0], ez = q1[1] - q0[1], den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) return null;
  const t = ((q0[0] - p0[0]) * ez - (q0[1] - p0[1]) * ex) / den, u = ((q0[0] - p0[0]) * dz - (q0[1] - p0[1]) * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}
// where the lines p + s d and q + t e meet: [s, t] or null
function lineX(p, dx, dz, q, ex, ez) { const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) return null; return [((q[0] - p[0]) * ez - (q[1] - p[1]) * ex) / den, ((q[0] - p[0]) * dz - (q[1] - p[1]) * dx) / den]; }
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// the point d metres along the polyline from its start (its end if shorter)
function walk(L, d) { for (let q = 0; q + 1 < L.length; q++) { const l = Math.hypot(L[q + 1][0] - L[q][0], L[q + 1][1] - L[q][1]); if (d <= l) return lerp2(L[q], L[q + 1], l ? d / l : 0); d -= l; } return L.at(-1); }
function dedupe(pts) { const o = []; for (const p of pts) { const l = o.at(-1); if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.02) o.push(p); } return o; }
function selfCrosses(poly) {
  const n = poly.length / 2, seg = (i) => [poly[i * 2], poly[i * 2 + 1], poly[((i + 1) % n) * 2], poly[((i + 1) % n) * 2 + 1]];
  const side = (ax, az, bx, bz, px, pz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const [a, b, c, d] = seg(i), [e, f, g, h] = seg(j);
    if (side(a, b, c, d, e, f) * side(a, b, c, d, g, h) < -1e-9 && side(e, f, g, h, a, b) * side(e, f, g, h, c, d) < -1e-9) return true;
  }
  return false;
}
