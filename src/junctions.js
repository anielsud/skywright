// Junction boxes (#228, the 🐞 reports "ground bleedthrough" / "weird intersection"): every junction of a real place's
// road graph (roads.bin topology: a node where three or more road ends meet, rd.jn) is one continuous surface.
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
//  - in a city, the corner pavements: between two arms' pavements, round the kerb's corner, out to the building line
//    (not on the far side of a road passing a T: its own pavement carries on there).
// Roads merging at a shallow angle (under MIN_ANGLE: a fork, a slip road) share one mouth across them where they still
// overlap there, the outermost of their kerbs either side; the gore between them is paved out to the mouths. Junction
// nodes a few metres apart (a divided road's two carriageways, OSM's clusters) are one junction, a cluster: the short
// roads between them inside its box, its corners round them. Where the kerbs tangle whatever is done, the box is the
// hull of its arms out to their mouths.
// A box is level at its node's height where its arms can be levelled out to their mouths within a street's grade of
// their next junctions (gradeReal: insertMouths, the arms' profiles level to the mouths, a cluster's nodes at one
// height; roads crossing it at its height without a node there, insertThrough, level across it too). Elsewhere (a
// steep street with a junction every 15 m) it is warped: at every arm's own grade along it, a mesh round the node
// that meets each arm at its mouth and along its kerbs. RoadSurface holds the box's surface inside it (physics and the
// near-camera ground), carveGrid pins the baked ground under it, and buildRoadMeshes draws it. Left as before (no box):
// a bridge or tunnel at the node; roads merging on a slope (one climbing away from the other); a warped box no node
// sees all of, climbing more than WARP across.
import * as THREE from 'three';
import { PAVE, PAVE_ROW, VERGE, inside } from './roadgrade.js';

const CMAX = 22, SPAN = 30, WARP = 1.2, RINGS = 3, RK = { city: 3, country: 5 }, MIN_ANGLE = 30 * Math.PI / 180, STRAIGHT = 155 * Math.PI / 180;
export const TARMAC_LIFT = { highway: 0.08, main: 0.06, street: 0.04 }; // metres the tarmac lies over the ground it is on (roads.js)

// the nodes where three or more road ends meet (a road passing through counts twice): Map nd -> [{ k, j }]
function junctionNodes(roads) {
  const at = new Map();
  roads.forEach((rd, k) => { if (rd.minor) return; for (const [j, nd] of rd.jn || []) { let L = at.get(nd); if (!L) at.set(nd, (L = [])); L.push({ k, j }); } }); // (a way off the street network, roads.js rd.minor, joins a street as a driveway does: no junction)
  for (const [nd, L] of at) if (L.reduce((a, q) => a + (q.j === 0 || q.j === roads[q.k].pts.length - 1 ? 1 : 2), 0) < 3) at.delete(nd);
  return at;
}
// 2D distances along a road
export function along(P) { const S = new Float64Array(P.length); for (let i = 1; i < P.length; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return S; }
// the first point i in 1 .. n - 1 at least s along (S: along's), else n - 1: the segment i - 1 .. i holds s
function segAt(S, s) { let lo = 1, hi = S.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] < s) lo = m + 1; else hi = m; } return lo; }
// which of a road's points are junction nodes (rd.jn): point index -> its node (the first listed)
export function jnAt(rd) { const M = new Map(); for (const [j, nd] of rd.jn || []) if (!M.has(j)) M.set(j, nd); return M; }
// the right vector at point i (as roads.js frame: along the neighbours' chord)
function right2(a, b) { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; }
function right(P, i) { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; }

// The arms and mouths of every junction, from the roads' plan (x, z) alone (so the same before grading, when
// insertMouths puts the mouth points in, and after, from a road pack). city: pavements.
// Junction nodes a few metres apart (a road a few metres long between them: a divided road's two carriageways, a
// slip road's fork beside the junction, OSM's clusters where several ways meet nearly at one point) are one junction,
// a cluster: the short roads between them (inner) lie inside its box, and its arms are those that leave it.
// Returns [{ nd (its first node), nds (all its nodes), x, z (their middle), arms: [{ k, j, nd (the node it leaves
// from), ox, oz (that node), dir (+1: the arm runs up the road's points), hw, W (pavement width, 0 none), lift, c
// (mouth: metres along from its node) }], inner: [{ k, j, dir, c (the length: to the other node) }], ok (false: no box,
// the roads stay as they were: a bridge or tunnel there) }].
export function junctionPlan(roads, city, S = new Map()) { // (S: road -> along(its points), kept by the caller to share)
  const out = [], sOf = (k) => { let s = S.get(k); if (!s) S.set(k, (s = along(roads[k].pts))); return s; }, JN = new Map(), jnOf = (k) => { let m = JN.get(k); if (!m) JN.set(k, (m = jnAt(roads[k]))); return m; };
  const nodes = junctionNodes(roads), info = new Map(); // nd -> { x, z, arms, ok, hw (the widest road through it) }
  for (const [nd, L] of nodes) {
    const p0 = roads[L[0].k].pts[L[0].j], arms = []; let ok = true, hw = 0;
    for (const { k, j } of L) {
      const rd = roads[k], P = rd.pts, n = P.length, Sk = sOf(k);
      if (rd.baked || rd.tunnel || rd.kind === 'rail' || rd.closed) ok = false;
      hw = Math.max(hw, rd.width / 2);
      for (const dir of [1, -1]) {
        if ((dir > 0 && j === n - 1) || (dir < 0 && j === 0)) continue;
        if (rd.bridge?.[j] && rd.bridge?.[j + dir]) ok = false; // (a deck from the node: not on the ground)
        // direction: to the first point at least 0.5 m away; length: to the next junction node or the road's end
        let q = j + dir; while (q + dir >= 0 && q + dir < n && Math.abs(Sk[q] - Sk[j]) < 0.5) q += dir;
        const dx = P[q].x - P[j].x, dz = P[q].z - P[j].z, l = Math.hypot(dx, dz) || 1;
        let e = j + dir, to = null; const jm = jnOf(k); while (e > 0 && e < n - 1 && !jm.has(e)) e += dir;
        for (const [jj, n2] of rd.jn || []) if (jj === e && nodes.has(n2) && n2 !== nd) to = n2;
        const W = city && rd.kind !== 'highway' && !rd.baked ? PAVE[rd.kind] ?? 3.5 : 0;
        arms.push({ k, j, nd, ox: p0.x, oz: p0.z, dir, dx: dx / l, dz: dz / l, hw: rd.width / 2, W, lift: TARMAC_LIFT[rd.kind] ?? 0.04, len: Math.abs(Sk[e] - Sk[j]), to, a: 0, c: 0 });
      }
    }
    info.set(nd, { x: p0.x, z: p0.z, arms, ok, hw });
  }
  // the clusters: nodes joined by a road shorter than the two junctions need (their widest roads' half widths, a
  // city's pavements), shortest first, while a cluster stays within SPAN across
  const up = new Map(), find = (a) => { while (up.has(a)) a = up.get(a); return a; }, members = new Map([...info.keys()].map((nd) => [nd, [nd]]));
  const links = [];
  for (const [nd, I] of info) for (const A of I.arms) if (A.to != null && A.to > nd && I.ok && info.get(A.to).ok && A.len < I.hw + info.get(A.to).hw + 2 + (city ? 4 : 0)) links.push([A.len, nd, A.to]);
  links.sort((a, b) => a[0] - b[0]);
  for (const [, a, b] of links) {
    const ra = find(a), rb = find(b); if (ra === rb) continue;
    const M = [...members.get(ra), ...members.get(rb)];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const nd of M) { const I = info.get(nd); x0 = Math.min(x0, I.x); x1 = Math.max(x1, I.x); z0 = Math.min(z0, I.z); z1 = Math.max(z1, I.z); }
    if (Math.hypot(x1 - x0, z1 - z0) > SPAN) continue;
    up.set(rb, ra); members.set(ra, M); members.delete(rb);
  }
  for (const [, nds] of members) {
    const set = new Set(nds), I0 = info.get(nds[0]), arms = [], inner = [];
    let ok = true, x = 0, z = 0;
    for (const nd of nds) { const I = info.get(nd); ok &&= I.ok; x += I.x / nds.length; z += I.z / nds.length; for (const A of I.arms) (A.to != null && set.has(A.to) ? inner : arms).push(A); }
    let span = 0; for (const nd of nds) span = Math.max(span, Math.hypot(info.get(nd).x - x, info.get(nd).z - z));
    // (arms in order round the junction: by where they head, seen from its middle)
    const R = Math.max(10, span * 4); for (const A of arms) A.a = Math.atan2(A.oz + A.dz * R - z, A.ox + A.dx * R - x);
    arms.sort((a, b) => a.a - b.a);
    const J = { nd: Math.min(...nds), nds, x: nds.length > 1 ? x : I0.x, z: nds.length > 1 ? z : I0.z, arms, inner, ok: ok && arms.length >= 3 };
    if (J.ok) {
      const rk = city ? RK.city : RK.country;
      // (at least the old clearance: the widest other road through its node, + 1 m)
      for (const A of arms) A.c = Math.max(0, ...[...arms, ...inner].filter((B) => B.k !== A.k && B.nd === A.nd).map((B) => B.hw)) + 1;
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length], phi = turn(A, B); if (phi >= STRAIGHT) continue;
        // the corner between A's left side and B's right: where their kerbs and their pavements' (or verges') outer
        // edges cross, and the round of radius rk tangent to both kerbs
        const kc = cross(A, B, A.hw, B.hw), oc = cross(A, B, A.hw + (A.W || VERGE), B.hw + (B.W || VERGE)), T = phi < MIN_ANGLE ? 0 : rk / Math.tan(phi / 2); // (a merge, under MIN_ANGLE: its corner square, the gore paved out to the mouths)
        if (Number.isFinite(kc[0]) && A.nd === B.nd) { A.c = Math.max(A.c, kc[0] + T, oc[0]); B.c = Math.max(B.c, kc[1] + T, oc[1]); } // (two arms from two of a cluster's nodes: their corner is round the inner road between them, corner3; side by side, their kerbs may only meet far ahead)
      }
      for (let it = 0; it < 2; it++) for (let i = 0; i < arms.length; i++) { const A = arms[i], B = arms[(i + 1) % arms.length]; if (A.nd === B.nd && turn(A, B) < MIN_ANGLE) A.c = B.c = Math.max(A.c, B.c); } // (roads merging: their mouths at one distance out, where a box across both ends)
      for (const A of arms) A.c = Math.floor((Math.min(A.c, CMAX, A.len * 0.45) - 0.6) * 16) / 16 + 0.6; // (the markings' clearance, c - 0.6 m, in 1/16 m: rjunc's code holds it exactly)
      for (const A of inner) A.c = A.len;
    }
    out.push(J);
  }
  return out;
}
// the angle from arm A round to the next arm B (counter-clockwise in x, z: atan2(z, x) increasing), 0..2pi
function turn(A, B) { let t = Math.atan2(B.dz, B.dx) - Math.atan2(A.dz, A.dx); while (t <= 1e-9) t += Math.PI * 2; return t; }
// where A's line offset oA to its left meets B's line offset oB to its right (each from its own node): [metres along
// A, metres along B] (Infinity: parallel). Left of an arm (dx, dz): (-dz, dx).
function cross(A, B, oA, oB) {
  // oa + s dA + oA lA = ob + t dB - oB lB  ->  s dA - t dB = (ob - oa) - oB lB - oA lA
  const ax = A.dx, az = A.dz, bx = B.dx, bz = B.dz, rx = B.ox - A.ox - oB * -bz - oA * -az, rz = B.oz - A.oz - oB * bx - oA * ax, det = ax * -bz - az * -bx;
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
      const i = segAt(S, s); // (s in the segment i - 1 .. i)
      if (Math.abs(S[i] - s) < 0.05 || Math.abs(S[i - 1] - s) < 0.05 || ins.some((q) => Math.abs(q.s - s) < 0.05)) continue;
      ins.push({ i, s, t: (s - S[i - 1]) / (S[i] - S[i - 1]), p: P[i - 1].clone().lerp(P[i], (s - S[i - 1]) / (S[i] - S[i - 1])) });
    }
    ins.sort((a, b) => b.i - a.i || b.t - a.t); // (from the end: earlier indices stay put; two in one segment, the further first)
    for (const { i, p, t } of ins) {
      P.splice(i, 0, p);
      if (rd.bridge) rd.bridge.splice(i, 0, !!(rd.bridge[i - 1] && rd.bridge[i]));
      if (rd.tube) rd.tube.splice(i, 0, !!(rd.tube[i - 1] && rd.tube[i]));
      for (const f of ['terr', 'wet']) if (rd[f]) { const a = rd[f], b = new a.constructor(a.length + 1); b.set(a.subarray(0, i)); b[i] = f === 'wet' ? a[i - 1] & a[i] : a[i - 1] + (a[i] - a[i - 1]) * t; b.set(a.subarray(i), i + 1); rd[f] = b; } // (after grading: its ground, between its neighbours')
      if (rd.jn) rd.jn = rd.jn.map(([j, nd]) => [j >= i ? j + 1 : j, nd]);
    }
  }
}

// Before grading: the roads passing through a junction without being one of its roads (no shared node: a carriageway
// alongside, a street whose own junction is just beyond, a slip road across the mouth). Where one crosses a level
// junction's area (its node and its arms out to their mouths, a road's half width round it) at about the junction's
// height (the ground there within AT_GRADE of it), it is part of the junction: level at its height across it, with a
// point where it enters and where it leaves (rd.pts, rd.bridge, rd.jn and plan's arms' j updated). Further off in
// height it's a road over or under the junction, left alone. plan: the level junctions (junctionPlan's), y(J) their
// heights, terr(x, z) the ground. Returns Map k -> [{ s0, s1, y }] (metres along road k, after the inserted points).
const AT_GRADE = 1.5;
export function insertThrough(roads, plan, yOf, terr) {
  const C = 64, cells = new Map(), key = (i, j) => i * 65536 + j, areas = [];
  for (const J of plan) {
    const P = [[J.x, J.z]]; let hw = 0;
    for (const A of [...J.arms, ...J.inner]) { const rx = -A.dz, rz = A.dx; hw = Math.max(hw, A.hw); for (const s of [0, A.c]) for (const o of [-A.hw, A.hw]) P.push([A.ox + A.dx * s + rx * o, A.oz + A.dz * s + rz * o]); }
    const H = hull2(P), ks = new Set([...J.arms, ...J.inner].map((A) => A.k)), y = yOf(J); if (y == null) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of H) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const a = { H, ks, y, bb: [x0, z0, x1, z1] }; areas.push(a);
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) { let L = cells.get(key(i, j)); if (!L) cells.set(key(i, j), (L = [])); L.push(a); }
  }
  const out = new Map(), armsOf = new Map();
  for (const J of plan) for (const A of [...J.arms, ...J.inner]) { let L = armsOf.get(A.k); if (!L) armsOf.set(A.k, (L = [])); L.push(A); }
  roads.forEach((rd, k) => {
    if (rd.baked || rd.tunnel || rd.kind === 'rail' || rd.closed || rd.minor) return; // (a way off the street network: it runs under a street's tarmac where they meet, not levelled with a junction)
    const P = rd.pts, n = P.length, S = along(P), hw = rd.width / 2, found = [];
    for (let i = 0; i + 1 < n; i++) {
      if (rd.bridge?.[i] && rd.bridge?.[i + 1]) continue;
      const a = P[i], b = P[i + 1], x0 = Math.min(a.x, b.x) - hw, x1 = Math.max(a.x, b.x) + hw, z0 = Math.min(a.z, b.z) - hw, z1 = Math.max(a.z, b.z) + hw;
      const seen = new Set();
      for (let ci = Math.floor(x0 / C); ci <= Math.floor(x1 / C); ci++) for (let cj = Math.floor(z0 / C); cj <= Math.floor(z1 / C); cj++) for (const A of cells.get(key(ci, cj)) || []) {
        if (seen.has(A) || A.ks.has(k) || A.bb[0] > x1 || A.bb[2] < x0 || A.bb[1] > z1 || A.bb[3] < z0) continue; seen.add(A);
        // where the centre line is within hw of the area, every half metre along the segment
        const L = S[i + 1] - S[i]; let s0 = null, s1 = null;
        for (let u = 0; u <= L + 1e-6; u += Math.max(0.5, L / 64)) { const x = a.x + (b.x - a.x) * u / (L || 1), z = a.z + (b.z - a.z) * u / (L || 1); if (polyDist(A.H, x, z) <= hw) { s0 ??= S[i] + u; s1 = S[i] + u; } }
        if (s0 != null) { const f = found.find((q) => q.A === A); if (f) { f.s0 = Math.min(f.s0, s0); f.s1 = Math.max(f.s1, s1); } else found.push({ A, s0, s1 }); }
      }
    }
    const keepF = [];
    for (const f of found) {
      const sm = (f.s0 + f.s1) / 2; let i = 1; while (i < n - 1 && S[i] < sm) i++; const t = (sm - S[i - 1]) / ((S[i] - S[i - 1]) || 1), x = P[i - 1].x + (P[i].x - P[i - 1].x) * t, z = P[i - 1].z + (P[i].z - P[i - 1].z) * t;
      if (Math.abs(terr(x, z) - f.A.y) > AT_GRADE) continue; // (over or under it: not part of it)
      keepF.push({ s0: Math.max(0, f.s0 - 0.5), s1: Math.min(S[n - 1], f.s1 + 0.5), y: f.A.y });
    }
    if (!keepF.length) return;
    // a point where it enters and leaves
    const ins = [];
    for (const f of keepF) for (const s of [f.s0, f.s1]) {
      if (s <= 0.05 || s >= S[n - 1] - 0.05) continue;
      let i = 1; while (i < n - 1 && S[i] < s) i++;
      if (Math.abs(S[i] - s) < 0.05 || Math.abs(S[i - 1] - s) < 0.05 || ins.some((q) => Math.abs(q.s - s) < 0.05)) continue;
      ins.push({ i, s, t: (s - S[i - 1]) / (S[i] - S[i - 1]) });
    }
    ins.sort((p, q) => q.i - p.i || q.t - p.t);
    for (const { i, t } of ins) {
      P.splice(i, 0, P[i - 1].clone().lerp(P[i], t));
      if (rd.bridge) rd.bridge.splice(i, 0, !!(rd.bridge[i - 1] && rd.bridge[i]));
      if (rd.jn) rd.jn = rd.jn.map(([j, nd]) => [j >= i ? j + 1 : j, nd]);
      for (const A of armsOf.get(k) || []) if (A.j >= i) A.j++;
    }
    out.set(k, keepF);
  });
  return out;
}
function hull2(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// how far (x, z) is outside the convex polygon H ([[x, z], ...], counter-clockwise): 0 inside
function polyDist(H, x, z) {
  let inside = true, d = Infinity;
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length], ex = b[0] - a[0], ez = b[1] - a[1], E2 = ex * ex + ez * ez || 1;
    if (ex * (z - a[1]) - ez * (x - a[0]) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / E2)); d = Math.min(d, Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z));
  }
  return inside ? 0 : d;
}

// After grading (or from a road pack): each junction's shapes and heights. net.junctions = [{ nd, x, z, y, flat, arms,
// box: [x, z, ...] (the outline, counter-clockwise), vtx: [x, z, ...] (the box's vertices: the outline's, then the
// node where the box is a fan round it), hy (each vertex's height), tris (indices into vtx), lift (per vertex), pave:
// per corner a Float64Array of rows round the kerb (roadgrade.js PAVE_ROW: kerb x, z, building line x, z, y, v (metres
// along), hw, lift), r: Map 'k:j:dir' ->
// clearance for the markings (mouth - 0.6 m) }].
// A junction graded level (gradeReal: its arms level out to their mouths) gets a level box (flat); one left on its
// roads' grades (a steep street, a neighbour too close to level apart from) a warped one: each vertex at its arm's
// height there, so it meets every arm at its mouth and along its kerbs all the same.
export function junctionShapes(roads, city) {
  const out = [], rk = city ? RK.city : RK.country, F = (junctionShapes.fail = { warped: 0, cross: 0, node: 0, tri: 0 }); // (fail: why junctions were left without a box; warped: boxes not level)
  const SS = new Map(), sOf = (k) => { let s = SS.get(k); if (!s) SS.set(k, (s = along(roads[k].pts))); return s; };
  for (const J of junctionPlan(roads, city, SS)) {
    if (!J.ok) continue;
    const n = J.arms.length, y = J.arms.reduce((a, A) => a + roads[A.k].pts[A.j].y, 0) / n; // (a cluster's nodes: one height, where it is level)
    // each arm's edges, from beside the node out to its mouth, where the ribbon's are (roads.js strip: each row's edge
    // at p + off * right, straight between rows), with the arm's height there: A.edge(o) -> [[x, z, y], ...] (o:
    // metres to the arm's left)
    let flat = true;
    for (const A of [...J.arms, ...J.inner]) { // (a cluster's inner roads too: their edges, node to node, bound its corners)
      const P = roads[A.k].pts, S = sOf(A.k), s = S[A.j] + A.dir * A.c;
      const i = segAt(S, s); // (the mouth: in the segment i - 1 .. i)
      const t = Math.min(1, Math.max(0, (s - S[i - 1]) / ((S[i] - S[i - 1]) || 1))), rows = [];
      for (let q = A.j; A.dir > 0 ? q <= i - 1 : q >= i; q += A.dir) rows.push(q); // (the rows from the node up to the mouth's segment)
      // (at the node of a road passing through, the ribbon has a point just to this arm's side of it, roads.js
      // junctionPoints: its frame is along this arm's first segment)
      const split = A.j > 0 && A.j < P.length - 1, rt = (q) => (split && q === A.j ? right2(P[Math.min(q, q + A.dir)], P[Math.max(q, q + A.dir)]) : right(P, q));
      const pt = (q, o) => { const r = rt(q), oo = o * A.dir; return [P[q].x + r[0] * oo, P[q].z + r[1] * oo, P[q].y]; };
      // (an edge's rows past the mouth's line left out: on the inside of a sharp bend just before the mouth, the bend's
      // row lies beyond it, and the edge would fold back across the mouth)
      const fx = (P[i].x - P[i - 1].x) * A.dir, fz = (P[i].z - P[i - 1].z) * A.dir;
      A.edge = (o) => { const a = pt(i - 1, o), b = pt(i, o), m = lerp2(a, b, t); return [...rows.map((q) => pt(q, o)).filter((e, q) => !q || q < rows.length - 1 || (e[0] - m[0]) * fx + (e[1] - m[1]) * fz < -0.01), m]; };
      A.L = A.edge(A.hw).at(-1); A.R = A.edge(-A.hw).at(-1);
      if (!(rows.every((q) => Math.abs(P[q].y - y) < 0.03) && Math.abs(A.L[2] - y) < 0.03)) flat = false;
    }
    // the box: round the node, each arm's mouth and the kerb from it round the corner to the next arm's (rounded with
    // radius rr; where that makes a tangle, square)
    // (two arms merging, still overlapping at their mouths: one mouth across the pair, from the first's right edge to
    // the second's left, no kerb or pavement between them)
    const merged = J.arms.map((A, i) => { const B = J.arms[(i + 1) % n]; if (A.nd !== B.nd || turn(A, B) >= MIN_ANGLE) return false;
      return (B.R[0] - A.L[0]) * -A.dz + (B.R[1] - A.L[1]) * A.dx < 0.5 || (A.L[0] - B.R[0]) * B.dz + (A.L[1] - B.R[1]) * -B.dx < 0.5; });
    if (merged.every(Boolean)) merged.fill(false);
    if (!flat && merged.some(Boolean)) { F.merge = (F.merge || 0) + 1; continue; } // (roads merging on a slope, one climbing away from the other: their own surfaces, blended, RoadSurface; one level box across both would be a step onto the one at its mouth)
    // (the units round the box: an arm, or a merging run of them, whose outermost right and left edges bound it: where
    // a wider road merges with a narrower one, its edge, not the narrower one's, is the kerb)
    const units = [];
    { let s = merged.findIndex((m, i) => !merged[(i + n - 1) % n]); if (s < 0) s = 0;
      for (let q = 0; q < n;) {
        const run = [J.arms[(s + q) % n]]; while (merged[(s + q) % n] && q + 1 < n) { q++; run.push(J.arms[(s + q) % n]); } q++;
        const R = run[0], L = run.at(-1);
        if (run.length === 1) { units.push({ R, L, eR: (w) => R.edge(-(R.hw + w)), eL: (w) => L.edge(L.hw + w) }); continue; }
        // (a merging run: each side's kerb the outermost of its arms' edges, from the node out)
        let dx = 0, dz = 0; for (const A of run) { dx += A.dx; dz += A.dz; }
        const lat = (p) => (p[0] - J.x) * -dz + (p[1] - J.z) * dx;
        units.push({ R, L, run, eR: (w) => envelope(run.map((A) => A.edge(-(A.hw + w))), (p) => -lat(p)), eL: (w) => envelope(run.map((A) => A.edge(A.hw + w)), lat) });
      } }
    const ring = (rr) => {
      const V = [], corners = [], m = units.length;
      for (let u = 0; u < m; u++) {
        const U0 = units[u], U1 = units[(u + 1) % m], A = U0.L, B = U1.R, phi = turn(A, B), ea = U0.eL(0), eb = U1.eR(0);
        V.push({ p: U0.eR(0).at(-1), lift: U0.R.lift, mouth: true, open: true }); for (const M of U0.run || []) V.push({ p: lerp2(M.R, M.L, 0.5), lift: M.lift, mouth: true, open: true }); V.push({ p: ea.at(-1), lift: A.lift, mouth: true }); // (a merging run's mouth: through each of its arms' middles, at its own height) // (open: the edge from it, R to L, is the mouth)
        // the kerb from A's mouth (its left edge) round to B's (its right edge): along A's edge in to where it meets
        // B's, rounded there, out along B's; where they don't meet (straight on, the outside of a bend), in to beside
        // the node (or where the kerbs' lines meet just behind it) and out again
        // (a cluster's arms from two of its nodes: round the corners onto and off the inner road between them, along its kerb)
        const I = A.nd !== B.nd && J.inner.find((I) => I.nd === A.nd && I.to === B.nd), WI = I ? I.W || A.W || B.W : 0;
        const kerb = (I && corner3(ea, I.edge(-I.hw), eb, A, B)) || corner(ea, eb, phi, rr, A, B);
        // (the building line: square. Where only one of the two has pavements, beside a highway's slip road, its
        // pavement carries on round the corner as wide)
        const WA = A.W || B.W, WB = B.W || A.W, oa = WA && U0.eL(WA), ob = WA && U1.eR(WB), outer = WA ? (I && corner3(oa, I.edge(-(I.hw + WI)), ob, A, B)) || corner(oa, ob, phi, 0, A, B) : null;
        corners.push({ A, B, kerb, outer });
        for (let q = 1; q < kerb.length - 1; q++) V.push({ p: kerb[q], lift: A.lift + (B.lift - A.lift) * q / (kerb.length - 1) });
      }
      const W = []; for (const v of V) { const l = W.at(-1); if (l && !v.mouth && Math.hypot(v.p[0] - l.p[0], v.p[1] - l.p[1]) < 0.1) continue; W.push(v); }
      while (W.length > 3 && !W.at(-1).mouth && Math.hypot(W.at(-1).p[0] - W[0].p[0], W.at(-1).p[1] - W[0].p[1]) < 0.1) W.pop();
      const U = selfCrosses(W.flatMap((v) => [v.p[0], v.p[1]])) ? untangle(W) : W; if (!U) { ring.corners = corners; return null; }
      return { box: U.flatMap((v) => [v.p[0], v.p[1]]), W: U, open: Uint8Array.from(U, (v) => (v.open ? 1 : 0)), corners };
    };
    // (last: where the kerbs tangle whatever is done (arms crossing each other's mouths, a cluster's roads every which
    // way), the hull of every arm and inner road out to its mouth: no kerb corners, but no ground in it either)
    const hullRing = () => {
      const pts = [];
      for (const A of [...J.arms, ...J.inner]) for (const o of [A.hw, -A.hw]) { const E = A.edge(o); for (const p of E) pts.push({ p, A, end: p === E.at(-1) && !J.inner.includes(A) ? (o > 0 ? 'L' : 'R') : null }); }
      const H = hull2(pts.map((v) => [v.p[0], v.p[1], v]));
      const W = H.map((h) => { const v = h[2]; return { p: v.p, lift: v.A.lift, mouth: !!v.end, end: v.end, A: v.A }; });
      W.forEach((v, q) => { const u = W[(q + 1) % W.length]; v.open = v.end === 'R' && u.end === 'L' && u.A === v.A; });
      return { box: W.flatMap((v) => [v.p[0], v.p[1]]), W, open: Uint8Array.from(W, (v) => (v.open ? 1 : 0)), corners: ring.corners || [] }; // (the corner pavements as the square ring had them)
    };
    const R = ring(rk) || ring(0) || hullRing();
    if (!R) { F.cross++; continue; }
    // (the outline's points in line with their neighbours left out, at their heights too: a straight kerb's rows, each
    // a triangle more to draw and an edge more for every physics query near it)
    const W = simplify(R.W);
    const box = W.flatMap((v) => [v.p[0], v.p[1]]), open = Uint8Array.from(W, (v) => (v.open ? 1 : 0)), corners = R.corners, nb = box.length / 2;
    if (!inside(box, J.x, J.z)) { F.node++; continue; }
    // its triangles. A level box: the outline's own triangulation. A warped one: a fan round a node (the junction's, or
    // one of a cluster's) that sees the whole outline, in RINGS rings out to it; each vertex inside at its arms' height
    // there (a weighted mean of their profiles, each arm's own inside its footprint: so the box follows every road's
    // grade across it, and passes through the node's height where they cross). Where no node sees it all, or the
    // box would climb more than WARP across without one, it isn't made (its roads stay as they were, blended, RoadSurface).
    const cr = (cx, cz, q) => { const a = q * 2, b = ((q + 1) % nb) * 2; return (box[a] - cx) * (box[b + 1] - cz) - (box[a + 1] - cz) * (box[b] - cx); };
    const C = flat ? null : [[J.x, J.z, y], ...J.arms.map((A) => [A.ox, A.oz, roads[A.k].pts[A.j].y])].find(([cx, cz]) => { for (let q = 0; q < nb; q++) if (cr(cx, cz, q) < -1e-3) return false; return true; }); // (an edge in line with it: no triangle there)
    let tris, vtx, hy, lift;
    if (flat) {
      tris = THREE.ShapeUtils.triangulateShape(Array.from({ length: nb }, (_, q) => new THREE.Vector2(box[q * 2], box[q * 2 + 1])), []).flat();
      if (tris.length < 3 * (nb - 2)) { F.tri++; continue; }
      vtx = Float64Array.from(box); hy = new Float64Array(nb).fill(y); lift = Float32Array.from(W, (v) => v.lift);
    } else {
      let lo = Infinity, hi = -Infinity; for (const v of W) { lo = Math.min(lo, v.p[2]); hi = Math.max(hi, v.p[2]); }
      if (!C) { if (hi - lo > WARP) { F.steep = (F.steep || 0) + 1; continue; } F.nofan = (F.nofan || 0) + 1; }
      // (the arms' centre lines, node to mouth, with their heights; the height at (x, z): each arm's profile where
      // (x, z) is level with it, weighted by how far outside its footprint (x, z) is)
      const CL = [...J.arms, ...J.inner].map((A) => ({ E: A.edge(0), hw: A.hw }));
      const hAt = (x, z) => {
        let sw = 0, sy = 0;
        for (const { E, hw } of CL) {
          let bd = Infinity, by = 0;
          for (let q = 0; q + 1 < E.length; q++) { const a = E[q], b = E[q + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)), d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z); if (d < bd) { bd = d; by = a[2] + (b[2] - a[2]) * t; } }
          const g = Math.max(0, bd - hw) + 0.05, w = 1 / (g * g); sw += w; sy += w * by;
        }
        return sy / sw;
      };
      const ln = J.arms.reduce((a, A) => a + A.lift, 0) / n;
      if (C) { // rings round the node: vertex (q, r) at r / RINGS of the way out to outline vertex q; the node last
        const V = [], Y = [], L = [];
        for (let q = 0; q < nb; q++) for (let r = 1; r <= RINGS; r++) { const t = r / RINGS, x = C[0] + (box[q * 2] - C[0]) * t, z = C[1] + (box[q * 2 + 1] - C[1]) * t; V.push(x, z); Y.push(r === RINGS ? W[q].p[2] : hAt(x, z)); L.push(ln + (W[q].lift - ln) * t); }
        const c0 = nb * RINGS, at = (q, r) => (r === 0 ? c0 : (q % nb) * RINGS + r - 1); V.push(C[0], C[1]); Y.push(C[2]); L.push(ln);
        tris = [];
        for (let q = 0; q < nb; q++) { if (cr(C[0], C[1], q) <= 1e-3) continue; for (let r = 0; r < RINGS; r++) { if (r === 0) tris.push(at(q, 0), at(q, 1), at(q + 1, 1)); else tris.push(at(q, r), at(q, r + 1), at(q + 1, r + 1), at(q, r), at(q + 1, r + 1), at(q + 1, r)); } }
        vtx = Float64Array.from(V); hy = Float64Array.from(Y); lift = Float32Array.from(L);
      } else {
        tris = THREE.ShapeUtils.triangulateShape(Array.from({ length: nb }, (_, q) => new THREE.Vector2(box[q * 2], box[q * 2 + 1])), []).flat();
        if (tris.length < 3 * (nb - 2)) { F.tri++; continue; }
        vtx = Float64Array.from(box); hy = Float64Array.from(W, (v) => v.p[2]); lift = Float32Array.from(W, (v) => v.lift);
      }
      F.warped++;
    }
    for (let q = 0; q < tris.length; q += 3) { const [a, b, c] = [tris[q], tris[q + 1], tris[q + 2]]; if ((vtx[b * 2] - vtx[a * 2]) * (vtx[c * 2 + 1] - vtx[a * 2 + 1]) - (vtx[b * 2 + 1] - vtx[a * 2 + 1]) * (vtx[c * 2] - vtx[a * 2]) > 0) { tris[q + 1] = c; tris[q + 2] = b; } } // (facing up: clockwise in x, z)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let q = 0; q < nb; q++) { x0 = Math.min(x0, box[q * 2]); x1 = Math.max(x1, box[q * 2]); z0 = Math.min(z0, box[q * 2 + 1]); z1 = Math.max(z1, box[q * 2 + 1]); }
    // the corner pavements (a city's): rows across the kerb's corner, out to the building line, each level across at
    // the kerb's height
    const pave = [];
    for (const { A, B, kerb: K, outer } of corners) {
      if (!outer) continue;
      if (A.k === B.k && A.nd === B.nd) { // the far side of a road passing a T: its own pavement carries on (roadSurface.js); on the outside of a bend there, the wedge between its two rows at the node
        const W0 = A.W || B.W, ka = A.edge(A.hw)[0], kb = B.edge(-B.hw)[0], oa = A.edge(A.hw + W0)[0], ob = B.edge(-(B.hw + W0))[0];
        const hk = lineX(ka, -A.dx, -A.dz, kb, -B.dx, -B.dz), ho = lineX(oa, -A.dx, -A.dz, ob, -B.dx, -B.dz);
        if (!hk || !ho || !(hk[0] > 0.01) || !(ho[0] > 0.01) || ho[0] > (A.hw + W0) * 3) continue;
        const R = new Float64Array(3 * PAVE_ROW), row = (q, k, o) => R.set([k[0], k[1], o[0], o[1], flat ? y : k[2], 0, A.hw, A.lift], q * PAVE_ROW);
        row(0, ka, oa); row(1, [ka[0] - A.dx * hk[0], ka[1] - A.dz * hk[0], ka[2]], [oa[0] - A.dx * ho[0], oa[1] - A.dz * ho[0]]); row(2, kb, ob); pave.push(R);
        continue;
      }
      const m = K.length, rows = new Float64Array(m * PAVE_ROW);
      // (each kerb point's partner on the building line at the same share of the way round: rows that never cross,
      // where the building line is much shorter than the kerb's round, or just its corner)
      const len = (L) => { let t = 0; for (let q = 1; q < L.length; q++) t += Math.hypot(L[q][0] - L[q - 1][0], L[q][1] - L[q - 1][1]); return t; }, Lk = len(K) || 1, Lo = len(outer);
      let v = 0;
      for (let q = 0; q < m; q++) {
        if (q) v += Math.hypot(K[q][0] - K[q - 1][0], K[q][1] - K[q - 1][1]);
        const f = m > 1 ? q / (m - 1) : 0;
        const o = q === m - 1 ? outer.at(-1) : walk(outer, Lo * v / Lk);
        rows.set([K[q][0], K[q][1], o[0], o[1], flat ? y : K[q][2], v, A.hw + (B.hw - A.hw) * f, A.lift + (B.lift - A.lift) * f], q * PAVE_ROW);
      }
      pave.push(rows);
    }
    const r = new Map(); for (const A of [...J.arms, ...J.inner]) r.set(A.k + ':' + A.j + ':' + A.dir, A.c - 0.6);
    out.push({ nd: J.nd, nds: J.nds, ks: new Set([...J.arms, ...J.inner].map((A) => A.k)), x: J.x, z: J.z, y, flat, arms: J.arms.map(({ k, j, dir, hw, W, lift, c }) => ({ k, j, dir, hw, W, lift, c })), box: Float64Array.from(box), ey: Float64Array.from(W, (v) => (flat ? y : v.p[2])), vtx, hy, open, tris, lift, pave, r, bb: [x0, z0, x1, z1] });
  }
  return out;
}
// The path round a junction's corner from arm A's mouth to the next arm B's (counter-clockwise), given their edges on
// that side (ea: A's left, eb: B's right; each from beside the node out to the mouth), the turn phi from A to B and
// a radius r to round it with (0: square). [[x, z, y], ...] from A's mouth to B's.
function corner(ea, eb, phi, r, A, B) {
  // (arms from two nodes of a cluster: their edges carried on straight back past their nodes, into the cluster, where
  // the two kerbs meet)
  const ea0 = ea, eb0 = eb;
  { const L = A.nd !== B.nd ? SPAN : Math.max(A.hw, B.hw) * 2, p = ea[0], q = eb[0]; ea = [[p[0] - A.dx * L, p[1] - A.dz * L, p[2]], ...ea]; eb = [[q[0] - B.dx * L, q[1] - B.dz * L, q[2]], ...eb]; } // (and two arms of one node: their kerbs may meet just behind the node's row, the rows either side of it turned apart)
  // where the edges cross (the furthest out along A): the corner (on a bend's outside too, where a curving arm's edge
  // crosses the other's near the node: there it's square)
  let X = null;
  for (let a = 0; a + 1 < ea.length; a++) for (let b = 0; b + 1 < eb.length; b++) {
    const h = segX(ea[a], ea[a + 1], eb[b], eb[b + 1]); if (h && (!X || a + h[0] > X.a + X.ta)) X = { a, ta: h[0], b, tb: h[1] };
  }
  if (phi >= STRAIGHT || phi < MIN_ANGLE) r = 0;
  {
    if (X) {
      const ca = lerp2(ea[X.a], ea[X.a + 1], X.ta), cb = lerp2(eb[X.b], eb[X.b + 1], X.tb), pa = [ca[0], ca[1], (ca[2] + cb[2]) / 2], path = []; // (where they cross: between the two arms' heights there)
      for (let q = ea.length - 1; q > X.a; q--) path.push(ea[q]);
      const T = r > 0 ? r / Math.tan(phi / 2) : 0;
      if (T > 0.05) { // the round: a quadratic curve from T before the corner to T after it, through near it
        const back = walk(path.concat([pa]).reverse(), T), on = [pa, ...eb.slice(X.b + 1)], fwd = walk(on, T);
        const keepA = path.filter((p) => Math.hypot(p[0] - pa[0], p[1] - pa[1]) > T + 0.01), keepB = eb.slice(X.b + 1).filter((p) => Math.hypot(p[0] - pa[0], p[1] - pa[1]) > T + 0.01);
        const m = Math.max(2, Math.ceil((Math.PI - phi) / (Math.PI / 4) - 0.05)); // (45 degree steps: a quarter round in two, which at a 3 m radius is within 12 cm of the circle)
        const arc = []; for (let q = 0; q <= m; q++) { const t = q / m, u = 1 - t; arc.push([u * u * back[0] + 2 * u * t * pa[0] + t * t * fwd[0], u * u * back[1] + 2 * u * t * pa[1] + t * t * fwd[1], u * u * back[2] + 2 * u * t * pa[2] + t * t * fwd[2]]); }
        return dedupe([...keepA, ...arc, ...keepB]);
      }
      return dedupe([...path, pa, ...eb.slice(X.b + 1)]);
    }
    if (phi < STRAIGHT && A.nd === B.nd) return dedupe([ea0.at(-1), eb0.at(-1)]); // (they don't meet before the mouths: straight across)
    if (A.nd !== B.nd) return dedupe([...ea0.slice().reverse(), ...eb0]); // (a cluster's arms from two of its nodes: in along A to its node, across to B's, out along B)
  }
  // straight on, or the outside of a bend: in along A to beside the node, out along B; on the outside of a sharp bend
  // via where the two kerbs' lines meet behind the node
  const a0 = ea0[0], b0 = eb0[0], back = Math.max(A.hw, B.hw) * 3, path = ea0.slice().reverse();
  { // (also on a gentle bend: else the chord between the two leaves a sliver of the bend's outside bare)
    const h = lineX(a0, -A.dx, -A.dz, b0, -B.dx, -B.dz); // (both lines run back from beside the node)
    if (h && h[0] > 0 && h[0] < back && h[1] > 0 && h[1] < back) path.push([a0[0] - A.dx * h[0], a0[1] - A.dz * h[0], (a0[2] + b0[2]) / 2]);
  }
  return dedupe([...path, ...eb0]);
}
// A cluster's corner from arm A (from one of its nodes) to arm B (from another), via the inner road from A's node to
// B's: its edge on that side em (node to node). Each edge carried on straight past its ends, the path from A's mouth
// in along A's edge to where it meets em, along em to where B's edge leaves it, and out along B's to its mouth; or
// null where they don't meet in that order.
function corner3(ea, em, eb, A, B) {
  const back = (e, dx, dz) => [[e[0][0] - dx * SPAN, e[0][1] - dz * SPAN, e[0][2]], ...e];
  ea = back(ea, A.dx, A.dz); eb = back(eb, B.dx, B.dz);
  const m0 = em[0], m1 = em.at(-1), ml = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) || 1, ux = (m1[0] - m0[0]) / ml, uz = (m1[1] - m0[1]) / ml;
  em = [[m0[0] - ux * SPAN, m0[1] - uz * SPAN, m0[2]], ...em, [m1[0] + ux * SPAN, m1[1] + uz * SPAN, m1[2]]];
  let X1 = null, X2 = null;
  for (let a = 0; a + 1 < ea.length; a++) for (let b = 0; b + 1 < em.length; b++) { const h = segX(ea[a], ea[a + 1], em[b], em[b + 1]); if (h && (!X1 || a + h[0] > X1.a + X1.ta)) X1 = { a, ta: h[0], b, tb: h[1] }; }
  for (let b = 0; b + 1 < em.length; b++) for (let c = 0; c + 1 < eb.length; c++) { const h = segX(em[b], em[b + 1], eb[c], eb[c + 1]); if (h && (!X2 || c + h[1] > X2.c + X2.tc)) X2 = { b, tb: h[0], c, tc: h[1] }; }
  if (!X1 || !X2 || X2.b + X2.tb < X1.b + X1.tb) return null;
  const path = [];
  for (let q = ea.length - 1; q > X1.a; q--) path.push(ea[q]);
  path.push(lerp2(ea[X1.a], ea[X1.a + 1], X1.ta));
  for (let q = X1.b + 1; q <= X2.b; q++) path.push(em[q]);
  path.push(lerp2(eb[X2.c], eb[X2.c + 1], X2.tc));
  for (let q = X2.c + 1; q < eb.length; q++) path.push(eb[q]);
  return dedupe(path);
}
// A ring's points that lie on the straight line between the points kept either side of them (within 5 mm, and 3 mm in
// height) left out; a mouth's and an open edge's points always kept. W: [{ p: [x, z, y], mouth, open }].
function simplify(W) {
  const out = [], n = W.length, keep = (v) => v.mouth || v.open;
  let s = W.findIndex(keep); if (s < 0) return W;
  const off = (a, b, p) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz; if (l2 < 1e-9) return Infinity; const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2; if (t <= 0 || t >= 1) return Infinity; return Math.max(Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / Math.sqrt(l2), Math.abs(a[2] + (b[2] - a[2]) * t - p[2]) * 1.5); };
  let k = s; out.push(W[s]);
  for (let i = 1; i <= n; i++) {
    const q = (s + i) % n; if (i === n) break;
    const nx = W[(q + 1) % n];
    // drop W[q] if every point from the last kept one up to it lies on the line from the last kept one to the next
    let ok = !keep(W[q]);
    for (let r = (k + 1) % n; ok; r = (r + 1) % n) { if (off(W[k].p, nx.p, W[r].p) > 0.005) ok = false; if (r === q) break; }
    if (!ok) { out.push(W[q]); k = q; }
  }
  return out;
}
// The outermost of several edges from a node out (merging arms' kerbs on one side), by out(p) (how far out p is):
// the outer one from the node until another crosses it, then that one.
function envelope(E, out) {
  let env = E[0];
  for (const e of E.slice(1)) {
    const [P, Q] = out(e[0]) > out(env[0]) + 1e-3 ? [e, env] : [env, e]; // (P: the outer one at the node)
    let X = null;
    for (let a = 0; a + 1 < P.length; a++) for (let b = 0; b + 1 < Q.length; b++) { const h = segX(P[a], P[a + 1], Q[b], Q[b + 1]); if (h && h[0] + a > 1e-6 && (!X || a + h[0] < X.a + X.ta)) X = { a, ta: h[0], b, tb: h[1] }; }
    env = X ? dedupe([...P.slice(0, X.a + 1), lerp2(P[X.a], P[X.a + 1], X.ta), ...Q.slice(X.b + 1)]) : out(Q.at(-1)) > out(P.at(-1)) ? Q : P; // (no crossing: the outer one at the far end, the two crossed just behind the node)
  }
  return env;
}
// where segments p0-p1 and q0-q1 cross: [t along p, t along q] or null
function segX(p0, p1, q0, q1) {
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1], ex = q1[0] - q0[0], ez = q1[1] - q0[1], den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) return null;
  const t = ((q0[0] - p0[0]) * ez - (q0[1] - p0[1]) * ex) / den, u = ((q0[0] - p0[0]) * dz - (q0[1] - p0[1]) * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}
// where the lines p + s d and q + t e meet: [s, t] or null
function lineX(p, dx, dz, q, ex, ez) { const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) return null; return [((q[0] - p[0]) * ez - (q[1] - p[1]) * ex) / den, ((q[0] - p[0]) * dz - (q[1] - p[1]) * dx) / den]; }
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; // ([x, z, y]: a height too)
// the point d metres along the polyline from its start (its end if shorter)
function walk(L, d) { for (let q = 0; q + 1 < L.length; q++) { const l = Math.hypot(L[q + 1][0] - L[q][0], L[q + 1][1] - L[q][1]); if (d <= l) return lerp2(L[q], L[q + 1], l ? d / l : 0); d -= l; } return L.at(-1); }
function dedupe(pts) { const o = []; for (const p of pts) { const l = o.at(-1); if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.02) o.push(p); } return o; }
// A ring that crosses itself (two arms' kerbs overlapping where they merge, a corner's path back past the next
// one's): the loops cut off where it crosses, keeping the bigger part each time, so long as every mouth stays as it
// was. W: [{ p: [x, z, y], lift, mouth, open }]; -> the untangled ring, or null.
function untangle(W) {
  const area = (L) => { let s = 0; for (let q = 0; q < L.length; q++) { const a = L[q], b = L[(q + 1) % L.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  for (let it = 0; it < 16; it++) {
    const X = selfCrosses(W.flatMap((v) => [v.p[0], v.p[1]])); if (!X) return W;
    const [i, j] = X, n = W.length, h = segX(W[i].p, W[(i + 1) % n].p, W[j].p, W[(j + 1) % n].p); if (!h) return null;
    const P = lerp2(W[i].p, W[(i + 1) % n].p, h[0]), Q = lerp2(W[j].p, W[(j + 1) % n].p, h[1]), p = [P[0], P[1], (P[2] + Q[2]) / 2];
    const loop = W.slice(i + 1, j + 1), rest = [...W.slice(j + 1), ...W.slice(0, i + 1)], inLoop = Math.abs(area([p, ...loop.map((v) => v.p)])) > Math.abs(area([p, ...rest.map((v) => v.p)]));
    if ((inLoop ? rest : loop).some((v) => v.mouth)) return null;
    // (the crossing point: the edge on from it is the rest of edge i (keeping the loop) or of edge j, a mouth's still open)
    W = inLoop ? [{ p, lift: W[i].lift, open: W[i].open }, ...loop] : [...W.slice(0, i + 1), { p, lift: W[i].lift, open: W[j].open }, ...W.slice(j + 1)];
  }
  return null;
}
function selfCrosses(poly) {
  const n = poly.length / 2, seg = (i) => [poly[i * 2], poly[i * 2 + 1], poly[((i + 1) % n) * 2], poly[((i + 1) % n) * 2 + 1]];
  const side = (ax, az, bx, bz, px, pz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const [a, b, c, d] = seg(i), [e, f, g, h] = seg(j);
    if (side(a, b, c, d, e, f) * side(a, b, c, d, g, h) < -1e-9 && side(e, f, g, h, a, b) * side(e, f, g, h, c, d) < -1e-9) return [i, j];
  }
  return null;
}
