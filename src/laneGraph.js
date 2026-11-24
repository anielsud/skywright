// Traffic's road graph (#228): cars drive from one road onto the next at the junctions instead of turning round at the
// end of every road (OSM splits a road at almost every junction, so Manhattan's cars U-turned mid-avenue).
//
// Every road is cut at its junctions (rd.jn: the node ids roads.bin gives each junction point) into pieces; each piece
// has a lane each way it may be driven (one-way roads: one), on the driver's right. A lane is a path for vehicles.js
// ({ pts, len, total, speed, kind, bridge }) whose points are only made when a car first uses it (New York has ~300k
// lanes). At a lane's end the car picks a lane leaving that junction: never straight back the way it came unless the
// road ends there (a dead end, or where the map's core cuts the road), and more often straight on than round a corner.
import * as THREE from 'three';

// the point s metres along a made lane (x, z)
function at(L, s) {
  const P = L.pts, S = L.len; let i = 0; while (i + 2 < P.length && S[i + 1] < s) i++;
  const a = P[i], b = P[Math.min(i + 1, P.length - 1)], l = (S[i + 1] ?? S[i]) - S[i], t = l > 0 ? Math.min(1, Math.max(0, (s - S[i]) / l)) : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

const SPEED = { highway: 27, main: 20, street: 11 };

export class LaneGraph {
  constructor(net, rand = Math.random) {
    this.r = rand; this.lanes = []; this.out = new Map(); // node key -> lanes leaving it
    this.deg = new Map(); // node key -> road pieces meeting there (3+: a junction, where crossing traffic gives way: vehicles.js)
    net.roads.forEach((rd, ri) => {
      const P = rd.pts, n = P.length; if (n < 2 || rd.kind === 'rail') return;
      const S = new Float64Array(n); for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
      const jAt = new Map((rd.jn || []).map(([j, nd]) => [j, nd]));
      const cuts = [0, ...[...jAt.keys()].filter((j) => j > 0 && j < n - 1).sort((a, b) => a - b), n - 1];
      const key = (j) => (jAt.has(j) ? 'n' + jAt.get(j) : 'e' + ri + ':' + j);
      for (let c = 0; c + 1 < cuts.length; c++) {
        const a = cuts[c], b = cuts[c + 1]; if (b <= a || S[b] - S[a] < 0.5) continue;
        const piece = { rd, a, b, len: S[b] - S[a] }, made = [];
        for (const fwd of [true, false]) {
          if ((fwd && rd.oneway < 0) || (!fwd && rd.oneway > 0)) continue;
          const L = { piece, fwd, from: key(fwd ? a : b), to: key(fwd ? b : a), total: piece.len, speed: SPEED[rd.kind] ?? 14, kind: rd.kind, pts: null, list: [], rev: null };
          this.lanes.push(L); made.push(L);
          let o = this.out.get(L.from); if (!o) this.out.set(L.from, (o = [])); o.push(L);
        }
        if (made.length === 2) { made[0].rev = made[1]; made[1].rev = made[0]; }
        if (made.length) for (const k of [key(a), key(b)]) this.deg.set(k, (this.deg.get(k) || 0) + 1);
      }
    });
    // lanes by 400 m square of their start (pickNear)
    this.cells = new Map(); this.lanes.forEach((L) => { const { rd, a, b } = L.piece, p = rd.pts[L.fwd ? a : b], k = Math.floor(p.x / 400) + ',' + Math.floor(p.z / 400); let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(L); });
    this.cum = new Float64Array(this.lanes.length); let acc = 0; this.lanes.forEach((L, i) => { acc += L.total; this.cum[i] = acc; }); this.totalLen = acc;
  }
  // the lane's points (offset to the driver's right), lengths and bounding circle, made the first time they're needed
  ensure(L) {
    if (L.pts) return L;
    const { rd, a, b } = L.piece, P = rd.pts, idx = []; for (let i = a; i <= b; i++) idx.push(i); if (!L.fwd) idx.reverse();
    const off = rd.oneway ? 0 : rd.width * 0.25, pts = [], br = [];
    for (let k = 0; k < idx.length; k++) {
      const p = P[idx[k]], q0 = P[idx[Math.max(0, k - 1)]], q1 = P[idx[Math.min(idx.length - 1, k + 1)]];
      let dx = q1.x - q0.x, dz = q1.z - q0.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      pts.push(new THREE.Vector3(p.x - dz * off, p.y, p.z + dx * off)); br.push(!!rd.bridge?.[idx[k]]);
    }
    L.pts = pts; L.bridge = br; L.len = []; let s = 0; pts.forEach((q, i) => { if (i) s += Math.hypot(q.x - pts[i - 1].x, q.z - pts[i - 1].z); L.len.push(s); }); L.total = Math.max(s, 0.01);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    L.cx = (x0 + x1) / 2; L.cz = (z0 + z1) / 2; L.r = Math.hypot(x1 - x0, z1 - z0) / 2 + 10;
    return L;
  }
  // a random lane, by length (where to put a car)
  pick() {
    const t = this.r() * this.totalLen, C = this.cum; let lo = 0, hi = C.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (C[m] < t) lo = m + 1; else hi = m; }
    return this.lanes[lo];
  }
  // a random lane starting between r0 and r1 metres from (x, z) (null if none: a few tries)
  pickNear(x, z, r0, r1) {
    for (let t = 0; t < 12; t++) {
      const a = this.r() * Math.PI * 2, d = r0 + this.r() * (r1 - r0), cx = Math.floor((x + Math.cos(a) * d) / 400), cz = Math.floor((z + Math.sin(a) * d) / 400), c = this.cells.get(cx + ',' + cz);
      if (c?.length) { const L = c[Math.floor(this.r() * c.length)], { rd, a: i0, b: i1 } = L.piece, p = rd.pts[L.fwd ? i0 : i1], dd = Math.hypot(p.x - x, p.z - z); if (dd > r0 * 0.8 && dd < r1 * 1.2) return L; }
    }
    return null;
  }
  // the lane a car takes at the end of L: one leaving L's end junction, not L reversed unless there is no other
  // (a dead end); weighted to straight on. null: nowhere to go (a one-way road's dead end): the car is put elsewhere.
  next(L) {
    this.ensure(L);
    const out = this.out.get(L.to) || [], cand = out.filter((M) => M !== L.rev);
    if (!cand.length) return L.rev || null;
    if (cand.length === 1) return cand[0];
    const e = L.pts, ax = e.at(-1).x - e.at(-2).x, az = e.at(-1).z - e.at(-2).z, al = Math.hypot(ax, az) || 1;
    const w = cand.map((M) => { this.ensure(M); const bx = M.pts[1].x - M.pts[0].x, bz = M.pts[1].z - M.pts[0].z, c = (ax * bx + az * bz) / (al * (Math.hypot(bx, bz) || 1)); return Math.max(0.15, 0.5 + 1.5 * c) * (M.kind === L.kind ? 1.3 : 1) * ((this.out.get(M.to) || []).some((X) => X !== M.rev) ? 1 : 0.15); }); // (rarely into a road that only leads to a dead end)
    let t = this.r() * w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < cand.length; i++) { t -= w[i]; if (t <= 0) return cand[i]; }
    return cand[cand.length - 1];
  }
  // the way from lane A onto lane B through A's end junction, made once per pair and kept (cars taking it share it, so
  // they follow each other round the turn): its turn curve T (null where the lanes meet), and its line (poly: from A's
  // stop line through the junction to a few metres into B), which vehicles.js compares with the others' to see whose
  // ways cross in the junction
  move(A, B) {
    let M = (A.moves ??= new Map()).get(B); if (M) return M;
    this.ensure(A); this.ensure(B);
    const T = this.turn(A, B), a = at(A, A.total - Math.min(10, A.total * 0.5)), b = at(B, Math.min(6, B.total * 0.5));
    if (T) { T.from = A; T.node = A.to; }
    const e = A.pts.at(-1), f = B.pts[0], m = T ? T.pts[3] : null;
    M = { A, B, T, node: A.to, poly: [a.x, a.z, e.x, e.z, ...(m ? [m.x, m.z] : []), f.x, f.z, b.x, b.z] }; if (T) T.mv = M;
    A.moves.set(B, M); return M;
  }
  // a short curve from the end of lane A to the start of lane B through the junction (a transient path: the car rides
  // it, then joins B)
  turn(A, B) {
    const p0 = A.pts.at(-1), p2 = B.pts[0], c = A.piece.rd.pts[A.fwd ? A.piece.b : A.piece.a], pts = [];
    if (Math.hypot(p2.x - p0.x, p2.z - p0.z) < 0.6) return null;
    for (let k = 0; k <= 6; k++) { const t = k / 6, u = 1 - t; pts.push(new THREE.Vector3(u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, u * u * p0.y + 2 * u * t * c.y + t * t * p2.y, u * u * p0.z + 2 * u * t * c.z + t * t * p2.z)); }
    const T = { pts, bridge: pts.map(() => false), len: [], total: 0, speed: Math.min(A.speed, B.speed) * 0.6, kind: A.kind, list: [], then: B, transient: true };
    let s = 0; pts.forEach((q, i) => { if (i) s += Math.hypot(q.x - pts[i - 1].x, q.z - pts[i - 1].z); T.len.push(s); }); T.total = Math.max(s, 0.01);
    T.cx = c.x; T.cz = c.z; T.r = s / 2 + 10;
    return T;
  }
}
