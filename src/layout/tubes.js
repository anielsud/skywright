// Tunnels dive (#294, the layout's: the game behind its flag and the bake, world.js). Today's grading (roads.js gradeReal)
// gives a tunnel's road a profile from today's carved terrain; the layout's natural ground (rules.js naturalGround) is
// another, and where the two part (a river bed under the Hudson's tunnels) the layout held the ground over the tube up to its
// crown: ground raised by tens of metres. Instead each tunnel's road dives: its tube's roof at least COVER m under the natural
// ground (a street at grade over it the layout puts about there), as deep as that wherever the grade lets it get there from each portal
// (DIVE_K x its kind's limit: at the limit exactly, the layout's height solve can't meet it). Where the roof can't have that
// cover (by a portal, or a short underpass all along) it's no tube but an open cut, and a street over the cut is a deck (as
// rails.js decksOverRails: roads.js draws it and collides with it at its own height). Ground over a tube is then only ever the
// natural ground or a street (rules.js).
import { TUBE_H } from './rules.js';

export const COVER = 0.5, MARGIN = 0.25, DIVE_K = 0.85, RUN_MIN = 40, TWIN_D = 15, TUBE_STEP = 10, DECK_PAD = 2, OVER_MIN = 2;
// the grade limits by kind (as bake.js GRADE and GRADE_CITY), and a railway's by class (bake.js RAIL_GRADE)
const GRADE = { highway: 0.18, main: 0.18, street: 0.22 }, GRADE_CITY = { highway: 0.07, main: 0.12, street: 0.2 }, GRADE_OTHER = 0.2;
export const roadGrade = (kind, city) => ((city ? GRADE_CITY : GRADE)[kind] ?? GRADE_OTHER) * DIVE_K;

// one tunnel's profile: ys (its points' heights, portals first and last), S (distance along), cov(k) (the highest its roof may be
// at point k: COVER under the ground or a street over it; aimed MARGIN m deeper, so the layout's ground between the points and
// its quantized heights keep it), G (grade) -> { ys (the dived heights), covered: [bool] }
export function diveProfile(ys, S, cov, G) {
  const n = ys.length, L = S[n - 1], t = ys.map((y, k) => Math.min(y, cov(k) - TUBE_H - MARGIN)), out = ys.slice(), covered = new Array(n).fill(false);
  for (let k = 1; k < n - 1; k++) { let env = Infinity; for (let j = 0; j < n; j++) env = Math.min(env, t[j] + G * Math.abs(S[k] - S[j])); // (the highest line within the grade under every point's limit)
    out[k] = Math.max(env, ys[0] - G * S[k], ys[n - 1] - G * (L - S[k])); } // (and no deeper than it can get from either portal)
  for (let k = 0; k < n; k++) covered[k] = out[k] + TUBE_H <= cov(k) + 0.01;
  return { ys: out, covered: tidy(covered, S) };
}
// (the tube's covered points tidied: a dip between two tube stretches, shorter than RUN_MIN m, tube too; a covered stretch
// shorter than RUN_MIN m among uncovered ones, a cut too: no tube a few metres long with portals at both ends)
function tidy(c0, S) { const covered = c0.slice(), n = covered.length, runs = []; for (let k = 0; k < n;) { let e = k; while (e + 1 < n && covered[e + 1] === covered[k]) e++; runs.push([k, e, covered[k]]); k = e + 1; }
  for (const [a, e, c] of runs) { const l = S[e] - S[a]; if (!c && a > 0 && e < n - 1 && l < RUN_MIN && covered[a - 1] && covered[e + 1]) for (let k = a; k <= e; k++) covered[k] = true; }
  for (const [a, e, c] of runs) { const l = S[e] - S[a]; if (c && l < RUN_MIN && (a === 0 || !covered[a - 1]) && (e === n - 1 || !covered[e + 1])) for (let k = a; k <= e; k++) covered[k] = false; }
  return covered;
}

// roads: World.net's (pts [{x, y, z}] (Vector3), tube[], bridge[], jn, terr, wet); g(x, z): the natural ground; city -> stats
// (the roads changed in place: their tubes' profiles, tube[] and bridge[]; points added along a tube every TUBE_STEP m and on a
// street either side of a cut it passes over; inserted: whether any were, so the caller works out the junctions again)
export function diveTubes(roads, g, city) {
  const st = { tunnels: 0, dived: 0, cuts: 0, partCut: 0, decks: 0, lowDecks: 0, inserted: false, maxDrop: 0 };
  const tubeOf = (rd) => rd.tube?.some(Boolean), hadTube = new Set(roads.filter(tubeOf));
  // each road's tube stretches (resampled every TUBE_STEP m), and where one way's tube goes on in another's (OSM splits a long
  // tunnel into ways at its nodes): one tunnel, chained across them (an end where exactly one other stretch ends), its portals only its two real ends
  const parts = [], atNode = new Map();
  for (const rd of hadTube) { if (rd.closed || !rd.pts.every((p) => Number.isFinite(p.y))) continue;
    densify(rd, (i) => rd.tube[i] && rd.tube[i + 1], TUBE_STEP) && (st.inserted = true); const P = rd.pts, J = { get: (i) => Math.round(P[i].x * 2) + ',' + Math.round(P[i].z * 2) }; // (a stretch's end by where it is, to half a metre: OSM's ways share the node)
    for (let a = 0; a + 1 < P.length; a++) { if (!(rd.tube[a] && rd.tube[a + 1])) continue; let e = a + 1; while (e + 1 < P.length && rd.tube[e + 1]) e++;
      const part = { rd, a, e, na: J.get(a), ne: J.get(e), G: roadGrade(rd.kind, city) }; parts.push(part);
      for (const nd of [part.na, part.ne]) if (nd != null) (atNode.get(nd) || atNode.set(nd, []).get(nd)).push(part); a = e; } }
  const used = new Set(), other = (part, nd) => { const L = atNode.get(nd); return nd != null && L && L.length === 2 ? L.find((q) => q !== part) : null; };
  const chains = []; for (const start of [...parts].sort((p, q) => (other(p, p.na) && other(p, p.ne) ? 1 : 0) - (other(q, q.na) && other(q, q.ne) ? 1 : 0))) { if (used.has(start)) continue;
    // (from an end that's a real portal, if it has one; a ring of tubes from wherever)
    let part = start, fwd = !(other(start, start.na) && !other(start, start.ne)); // (its a end a portal (or both ends go on): from a; else from e)
    const pts = []; let G = Infinity;
    while (part && !used.has(part)) { used.add(part); G = Math.min(G, part.G); const idx = []; for (let k = part.a; k <= part.e; k++) idx.push(k); if (!fwd) idx.reverse();
      for (const k of idx) { if (pts.length && k === idx[0]) { pts[pts.length - 1].also.push([part.rd, k]); continue; } pts.push({ rd: part.rd, k, also: [] }); }
      const endNd = fwd ? part.ne : part.na, nx = other(part, endNd); if (!nx || used.has(nx)) break; fwd = nx.na === endNd; part = nx; }
    chains.push({ pts, G }); }
  const chainS = new Map();
  for (const { pts, G } of chains) { st.tunnels++; const P = (q) => q.rd.pts[q.k], S = [0]; for (let k = 1; k < pts.length; k++) S.push(S[k - 1] + Math.hypot(P(pts[k]).x - P(pts[k - 1]).x, P(pts[k]).z - P(pts[k - 1]).z));
    const cov = (k) => { const p = P(pts[k]); return g(p.x, p.z) - COVER; }; // (under the natural ground: a street over it the layout puts about there, its graded height today's terrain's, roads.js)
    const r = diveProfile(pts.map((q) => P(q).y), S, cov, G);
    pts.forEach((q, k) => { const y = r.ys[k]; st.maxDrop = Math.max(st.maxDrop, P(q).y - y); for (const [rd, i] of [[q.rd, q.k], ...q.also]) rd.pts[i].y = y; q.cov = r.covered[k]; });
    chainS.set(pts, S); }
  // (tunnels side by side (a twin carriageway's two tubes): a point a tube only where every other tunnel's point within TWIN_D m
  // is too, so one's open cut never runs beside the other's mouth; then again no dip or island shorter than RUN_MIN m)
  { const cvs = twinAnd(chains.map(({ pts }) => ({ S: chainS.get(pts), at: (k) => pts[k].rd.pts[pts[k].k], cov: pts.map((q) => q.cov) })));
    chains.forEach(({ pts }, ci) => { const cv = cvs[ci]; pts.forEach((q, k) => { for (const [rd, i] of [[q.rd, q.k], ...q.also]) rd.tube[i] = cv[k]; });
      if (!cv.some(Boolean)) st.cuts++; else { st.dived++; if (cv.some((c) => !c)) st.partCut++; } }); }
  // (a street at grade over a stretch that's now an open cut, OVER_MIN m or more over it: a deck there, DECK_PAD m past the cut's edge)
  const segs = segIndex(roads.filter((s) => s.kind !== 'rail' && !s.minor && !hadTube.has(s))); // (a street: a way off the street network crosses as it is)
  for (const { rd, a, e } of parts) { const P = rd.pts, hw = rd.width / 2;
    for (let k = a; k < e; k++) { if (rd.tube[k] && rd.tube[k + 1]) continue; const p = P[k], q = P[k + 1];
      const done = new Set(); for (const [s, i] of segs(p, q)) { if (done.has(s)) continue; const Q = s.pts; { /* (one deck per street per cut segment: its indices change with it) */ if (s.bridge?.[i] && s.bridge?.[i + 1]) continue; if (s.tube?.[i] && s.tube?.[i + 1]) continue;
          const X = cross(p, q, Q[i], Q[i + 1]); if (!X) continue; const yc = Q[i].y + (Q[i + 1].y - Q[i].y) * X.u, yr = p.y + (q.y - p.y) * X.t; if (yc - yr < OVER_MIN) continue;
          // (the street's points either side of the cut, its half width and DECK_PAD m out: inserted if its segment is longer)
          const l = Math.hypot(Q[i + 1].x - Q[i].x, Q[i + 1].z - Q[i].z), sinA = Math.max(0.3, X.sin), half = (hw + DECK_PAD) / sinA, u0 = X.u - half / l, u1 = X.u + half / l;
          if (!s.bridge) s.bridge = new Array(s.pts.length).fill(false);
          let i0 = i, i1 = i + 1; if (u1 < 1 - 1e-3) { insertAt(s, i + 1, u1, i); st.inserted = true; } if (u0 > 1e-3) { insertAt(s, i + 1, u0 / (u1 < 1 - 1e-3 ? u1 : 1), i); st.inserted = true; i0 = i + 1; i1 = i + 2; }
          s.bridge[i0] = s.bridge[i1] = true; st.decks++; if (yc - yr < TUBE_H) st.lowDecks++; segs.dirty(s); done.add(s); } } } }
  return st;
}
// the segments of roads near segment pq: [[road, its segment's index], ...] (a road's points inserted: dirty(road) re-files it)
function segIndex(roads) { const C = 25, grid = new Map(), key = (i, j) => i * 100003 + j, put = (rd) => { const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { const a = P[i], b = P[i + 1];
    for (let x = Math.floor(Math.min(a.x, b.x) / C); x <= Math.floor(Math.max(a.x, b.x) / C); x++) for (let z = Math.floor(Math.min(a.z, b.z) / C); z <= Math.floor(Math.max(a.z, b.z) / C); z++) (grid.get(key(x, z)) || grid.set(key(x, z), []).get(key(x, z))).push([rd, i]); } };
  for (const rd of roads) put(rd);
  const q = (p, r) => { const out = [], seen = new Set(); for (let x = Math.floor(Math.min(p.x, r.x) / C); x <= Math.floor(Math.max(p.x, r.x) / C); x++) for (let z = Math.floor(Math.min(p.z, r.z) / C); z <= Math.floor(Math.max(p.z, r.z) / C); z++) for (const e of grid.get(key(x, z)) || []) if (!seen.has(e) && e[1] + 1 < e[0].pts.length) { seen.add(e); out.push(e); } return out; };
  q.dirty = (rd) => { for (const [k, L] of grid) grid.set(k, L.filter((e) => e[0] !== rd)); put(rd); }; return q; }
// tunnels side by side (a twin carriageway's two tubes, a railway's tracks): a point a tube only where every other tunnel's point
// within TWIN_D m is too, so one's open cut never runs beside another's mouth; then no dip or island shorter than RUN_MIN m.
// tunnels: [{ S (along), at(k) -> {x, z}, cov: [bool] }] -> each one's tube points [bool]
export function twinAnd(tunnels) {
  const C = 25, grid = new Map(), key = (i, j) => i * 100003 + j, cov = tunnels.map((t) => t.cov.slice());
  tunnels.forEach((t, ci) => t.cov.forEach((_, k) => { const p = t.at(k), kk = key(Math.floor(p.x / C), Math.floor(p.z / C)); (grid.get(kk) || grid.set(kk, []).get(kk)).push(ci, k); }));
  for (let pass = 0; pass < 4; pass++) { let changed = 0;
    tunnels.forEach((t, ci) => t.cov.forEach((_, k) => { if (!cov[ci][k]) return; const p = t.at(k);
      for (let i = Math.floor((p.x - TWIN_D) / C); i <= Math.floor((p.x + TWIN_D) / C) && cov[ci][k]; i++) for (let j = Math.floor((p.z - TWIN_D) / C); j <= Math.floor((p.z + TWIN_D) / C) && cov[ci][k]; j++) { const L = grid.get(key(i, j)) || [];
        for (let q = 0; q < L.length; q += 2) { const oc = L[q], ok = L[q + 1]; if (oc === ci || cov[oc][ok]) continue; const op = tunnels[oc].at(ok); if (Math.hypot(op.x - p.x, op.z - p.z) <= TWIN_D) { cov[ci][k] = false; changed++; break; } } } }));
    if (!changed) break; }
  return cov.map((c, ci) => tidy(c, tunnels[ci].S));
}
// where segments pq and rs cross: { t (along pq), u (along rs), sin (of the angle between) }, or null
function cross(p, q, r, s) { const ax = q.x - p.x, az = q.z - p.z, bx = s.x - r.x, bz = s.z - r.z, den = ax * bz - az * bx; if (Math.abs(den) < 1e-9) return null;
  const t = ((r.x - p.x) * bz - (r.z - p.z) * bx) / den, u = ((r.x - p.x) * az - (r.z - p.z) * ax) / den; if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, sin: Math.abs(den) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1) }; }
// a point at f along segment j-1..j... of road rd inserted before index i (its per-point arrays kept in step, as junctions.js insertMouths)
function insertAt(rd, i, f, j = i - 1) { const P = rd.pts, a = P[j], b = P[j + 1], p = a.clone().lerp(b, f); P.splice(i, 0, p);
  for (const k of ['bridge', 'tube']) if (rd[k]) rd[k].splice(i, 0, !!(rd[k][i - 1] && rd[k][i]));
  for (const k of ['terr', 'wet']) if (rd[k]) { const A = rd[k], B = new A.constructor(A.length + 1); B.set(A.subarray(0, i)); B[i] = k === 'wet' ? A[i - 1] & A[i] : A[i - 1] + (A[i] - A[i - 1]) * f; B.set(A.subarray(i), i + 1); rd[k] = B; }
  if (rd.jn) rd.jn = rd.jn.map(([q, nd]) => [q >= i ? q + 1 : q, nd]); }
// points every step m along road rd's segments where ok(i) (from the end: indices before stay put) -> whether any
function densify(rd, ok, step) { let any = false; for (let i = rd.pts.length - 2; i >= 0; i--) { if (!ok(i)) continue; const a = rd.pts[i], b = rd.pts[i + 1], m = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step);
    for (let s = m - 1; s >= 1; s--) { insertAt(rd, i + 1, s / (s + 1), i); any = true; } } return any; } // (the next point already s + 1 of m along: this one s of them)
