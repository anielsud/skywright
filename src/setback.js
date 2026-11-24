// Building setbacks (#228): no building stands on a road. The real places' buildings are OpenStreetMap footprints and
// their roads are OSM centre lines drawn at class widths (capped), with a gravel verge (roadgrade.js VERGE) or, in a
// city, kerbs and pavements out to the building line (roads.js roadMesh). The two don't always agree: the widths are
// generous, the alignment is a metre or two off here and there, so walls stood on the tarmac.
//
// The rule, per footprint, as it is built (a load-time pass: a grid of road segments, a few distance tests a building):
//  - a road's clear zone is its tarmac plus verge (plus pavement on a city street: kerb to building line), and a
//    building keeps SETBACK beyond it (in a city just the TOL slack: the pavement runs to the building line);
//  - a footprint that reaches into a clear zone is cut back: its walls inside the zone are pushed straight out to the
//    zone's edge, so the road-facing wall becomes a frontage along the road on the building line (round a dead end or
//    a bend's outside, it follows the curve) and the rest of the house stays where OpenStreetMap has it. (Shifting the
//    whole house back would push it into its neighbours or the hillside behind; a half-plane cut along the road's line
//    chopped whole wings off buildings at bends.)
//  - a road right through a footprint: the smaller side goes (cut along the road), the rest is pushed clear as above;
//  - if that leaves less than half of it, or a sliver, it is dropped; unless it's a big or tall one (MAJOR) the road
//    runs right through: that stays whole (a passage under it, a covered highway; New York has a few dozen).
// Tunnels' tubes and bridge decks up in the air are left out (what's under them is no obstacle to the road).
// The World's collision boxes (World.wallBoxes, destruction.js) are made from the footprint after this, so they match.
import { VERGE } from './roadgrade.js';

export const SETBACK = 1; // m beyond the verge, off a city's streets
const PAVE = { main: 4.5, street: 3.5 }; // a city street's pavement (roads.js roadMesh: the slabs out to the building line)
const hyp = (x, z) => Math.sqrt(x * x + z * z); // (Math.hypot is slow)
export const MAJOR = { area: 800, height: 25 }; // (m2, m) a building too big to drop for a road through it
const CELL = 32, KEEP = 0.5, MIN_A = 12, MIN_W = 2.2, TOL = 0.3; // (TOL: how far into the setback a wall may stand: it's slack, not road)

// The clear zones of a World's road network: segments [ax, az, bx, bz, r, ends, x0, x1, z0, z1] (r: the clear half
// width; ends: 1 the segment's a is a road's dead end, 2 its b is; then its box, out to r + the setback), filed in a
// dense 32 m grid (start: each cell's offset into list; one pass to count, one to fill).
export function roadIndex(w) {
  const city = !!w.loc.city, segs = [], S = city ? TOL : SETBACK; // (a city: nothing past the pavement but the slack, TOL, that setBack leaves alone)
  let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
  for (const rd of w.net?.roads || []) {
    if (rd.kind === 'rail') continue;
    const P = rd.pts, n = P.length, last = rd.closed ? n : n - 1;
    const r = rd.width / 2 + (city && rd.kind !== 'highway' && !rd.baked ? PAVE[rd.kind] ?? PAVE.street : VERGE), R = r + S;
    const jn = rd.jn || [], end0 = !rd.closed && !jn.some(([i]) => i === 0), end1 = !rd.closed && !jn.some(([i]) => i === n - 1); // (dead ends)
    // (tubes and decks up in the air left out; straight runs merged: the roads are resampled every few metres, and New
    // York has 600k of those pieces)
    const off = new Uint8Array(last);
    if (rd.tube?.includes(true) || rd.bridge?.includes(true)) for (let i = 0; i < last; i++) { const j = (i + 1) % n, a = P[i], b = P[j]; off[i] = (rd.tube?.[i] && rd.tube?.[j]) || (rd.bridge?.[i] && rd.bridge?.[j] && (a.y + b.y) / 2 - w.rawHeight((a.x + b.x) / 2, (a.z + b.z) / 2) > 5) ? 1 : 0; }
    const straight = (i0, i1) => { // does the run from i0 carry on straight to i1 (the next point off the line through i0 and i1 - 1 by 3 cm at most)?
      const a = P[i0], m = P[(i1 - 1) % n], b = P[i1 % n], ex = m.x - a.x, ez = m.z - a.z, L = hyp(ex, ez);
      return hyp(b.x - a.x, b.z - a.z) < 80 && (b.x - m.x) * ex + (b.z - m.z) * ez > 0 && Math.abs((b.x - a.x) * ez - (b.z - a.z) * ex) < 0.03 * L; };
    for (let i = 0, a = -1; i < last; i++) {
      if (off[i]) continue;
      if (a < 0) a = i;
      if (i + 1 < last && !off[i + 1] && straight(a, i + 2)) continue;
      const j = (i + 1) % n, A = P[a], B = P[j];
      const e = (a === 0 && end0 ? 1 : 0) | (j === n - 1 && end1 ? 2 : 0);
      const sg = [A.x, A.z, B.x, B.z, r, e, Math.min(A.x, B.x) - R, Math.max(A.x, B.x) + R, Math.min(A.z, B.z) - R, Math.max(A.z, B.z) + R];
      segs.push(sg); gx0 = Math.min(gx0, sg[6]); gx1 = Math.max(gx1, sg[7]); gz0 = Math.min(gz0, sg[8]); gz1 = Math.max(gz1, sg[9]);
      a = -1;
    }
  }
  if (!segs.length) return { segs, set: S };
  const ox = Math.floor(gx0 / CELL), oz = Math.floor(gz0 / CELL), nx = Math.floor(gx1 / CELL) - ox + 1, nz = Math.floor(gz1 / CELL) - oz + 1;
  const start = new Uint32Array(nx * nz + 1); let list = null, fill = null;
  for (let pass = 0; pass < 2; pass++) { // (count, then fill)
    if (pass) { for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c]; fill = start.slice(0, -1); list = new Uint32Array(start[nx * nz]); }
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k], i0 = Math.floor(s[6] / CELL) - ox, i1 = Math.floor(s[7] / CELL) - ox, j1 = Math.floor(s[9] / CELL) - oz;
      for (let cj = Math.floor(s[8] / CELL) - oz; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) { const c = cj * nx + ci; if (pass) list[fill[c]++] = k; else start[c + 1]++; }
    }
  }
  return { segs, start, list, ox, oz, nx, nz, stamp: new Uint32Array(segs.length), gen: 0, set: S };
}

// the segments whose clear zones may reach a footprint
function near(I, P) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  const out = [], g = ++I.gen, { start, list, segs, stamp } = I;
  const i0 = Math.max(0, Math.floor(x0 / CELL) - I.ox), i1 = Math.min(I.nx - 1, Math.floor(x1 / CELL) - I.ox), j0 = Math.max(0, Math.floor(z0 / CELL) - I.oz), j1 = Math.min(I.nz - 1, Math.floor(z1 / CELL) - I.oz);
  for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
    const c = cj * I.nx + ci;
    for (let m = start[c], e = start[c + 1]; m < e; m++) { const k = list[m]; if (stamp[k] === g) continue; stamp[k] = g; const s = segs[k];
      if (s[6] <= x1 && s[7] >= x0 && s[8] <= z1 && s[9] >= z0) out.push(s); }
  }
  return out;
}
const inside = (P, x, z) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
export const area = (P) => { let a = 0; for (let k = 0; k < P.length; k++) { const p = P[k], c = P[(k + 1) % P.length]; a += p[0] * c[1] - c[0] * p[1]; } return a / 2; };

// How far a road's centre line is from a footprint: { d (0: it crosses or runs inside), t (where on the segment, 0..1) }
export function segDist(s, P) {
  const ax = s[0], az = s[1], dx = s[2] - ax, dz = s[3] - az, L2 = dx * dx + dz * dz || 1e-9;
  let d2 = Infinity, t = 0;
  const pt = (px, pz) => { let u = ((px - ax) * dx + (pz - az) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u; const ex = ax + dx * u - px, ez = az + dz * u - pz, q = ex * ex + ez * ez; if (q < d2) { d2 = q; t = u; } };
  const n = P.length;
  for (let k = 0; k < n; k++) {
    const p = P[k], c = P[(k + 1) % n], ex = c[0] - p[0], ez = c[1] - p[1];
    // the centre line crossing this wall
    const den = dx * ez - dz * ex;
    if (Math.abs(den) > 1e-12) {
      const u = ((p[0] - ax) * ez - (p[1] - az) * ex) / den, v = ((p[0] - ax) * dz - (p[1] - az) * dx) / den;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return { d: 0, t: u, cross: true };
    }
    pt(p[0], p[1]);
    // the segment's ends against this wall
    const E2 = ex * ex + ez * ez || 1e-9;
    for (const [qx, qz, uq] of [[ax, az, 0], [ax + dx, az + dz, 1]]) {
      let v = ((qx - p[0]) * ex + (qz - p[1]) * ez) / E2; v = v < 0 ? 0 : v > 1 ? 1 : v;
      const fx = p[0] + ex * v - qx, fz = p[1] + ez * v - qz, q = fx * fx + fz * fz; if (q < d2) { d2 = q; t = uq; }
    }
  }
  if (inside(P, ax, az)) return { d: 0, t: 0, cross: true };
  return { d: Math.sqrt(d2), t, cross: false };
}

// How deep a footprint reaches into the clear zones (tarmac + verge / pavement; no setback): the worst, in metres (0: clear)
export function intrusion(I, P) {
  let worst = 0; if (!I.segs.length) return 0;
  for (const s of near(I, P)) { const { d } = segDist(s, P); if (s[4] - d > worst) worst = s[4] - d; }
  return worst;
}

// keep the part of P with n . (x - o) >= c (Sutherland-Hodgman against one half-plane; keeps the ring's winding)
function clip(P, nx, nz, ox, oz, c) {
  const out = [], f = (p) => (p[0] - ox) * nx + (p[1] - oz) * nz - c;
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[(k + 1) % P.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
const width = (P) => { // the footprint's smallest extent across (its narrowest direction among its walls)
  let best = Infinity;
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[(k + 1) % P.length], L = hyp(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
    const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L; let v0 = Infinity, v1 = -Infinity;
    for (const p of P) { const v = p[0] * nx + p[1] * nz; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    best = Math.min(best, v1 - v0);
  }
  return best;
};

// the half-plane cut against one segment (a road through the footprint, or the fallback): beside the road, past its
// clear zone c; at a dead end, beyond the end
function cutAcross(Q, s, d, c) {
  const [ax, az, bx, bz, , e] = s, L = hyp(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
  let cx = 0, cz = 0; for (const p of Q) { cx += p[0]; cz += p[1]; } cx /= Q.length; cz /= Q.length;
  const endA = e & 1 && (d.t <= 0 || (d.cross && (cx - ax) * ux + (cz - az) * uz < 0)), endB = e & 2 && (d.t >= 1 || (d.cross && (cx - bx) * ux + (cz - bz) * uz > 0));
  if (endA) return clip(Q, -ux, -uz, ax, az, c);
  if (endB) return clip(Q, ux, uz, bx, bz, c);
  if (d.cross) { const L = clip(Q, -uz, ux, ax, az, c), R = clip(Q, uz, -ux, ax, az, c); return Math.abs(area(L)) >= Math.abs(area(R)) ? L : R; } // (through it: the bigger side stays)
  if (d.t > 0 && d.t < 1) { const sd = (cx - ax) * -uz + (cz - az) * ux >= 0 ? 1 : -1; return clip(Q, -uz * sd, ux * sd, ax, az, c); }
  // past a bend's corner: away from that point
  const px = d.t <= 0 ? ax : bx, pz = d.t <= 0 ? az : bz; let qx = 0, qz = 0, qd = Infinity;
  for (const p of Q) { const dd = (p[0] - px) ** 2 + (p[1] - pz) ** 2; if (dd < qd) { qd = dd; qx = p[0]; qz = p[1]; } }
  let vx = qx - px, vz = qz - pz, vl = hyp(vx, vz); if (vl < 1e-6) { vx = cx - px; vz = cz - pz; vl = hyp(vx, vz) || 1; }
  return clip(Q, vx / vl, vz / vl, px, pz, c);
}
// the walls inside the clear zones pushed out to their edge: sampled every STEP where they run into one, each point
// moved straight away from the centre line it is deepest into (again, if that put it into the next one: an inside
// bend's corner). A wall the road runs along becomes a frontage on the building line; the rest stays as mapped.
const STEP = 0.75;
function pushOut(Q, all, S) {
  const out = [];
  let segs = all;
  const put = (x, z) => {
    for (let it = 0; it < 8; it++) {
      let best = null, bd = 0.01;
      for (const s of segs) {
        const dx = s[2] - s[0], dz = s[3] - s[1], L2 = dx * dx + dz * dz || 1e-9; let t = ((x - s[0]) * dx + (z - s[1]) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s[0] + dx * t, qz = s[1] + dz * t, d = hyp(x - qx, z - qz), need = s[4] + S - d;
        if (need > bd) { bd = need; best = [qx, qz, d, s[4] + S, dx, dz]; }
      }
      if (!best) break;
      const [qx, qz, d, c, dx, dz] = best;
      if (d > 1e-6) { x = qx + (x - qx) / d * c; z = qz + (z - qz) / d * c; }
      else { const L = hyp(dx, dz) || 1; x = qx - dz / L * c; z = qz + dx / L * c; } // (on the centre line: either side)
    }
    out.push([x, z]);
  };
  for (let k = 0; k < Q.length; k++) {
    const a = Q[k], b = Q[(k + 1) % Q.length], m = Math.ceil(hyp(b[0] - a[0], b[1] - a[1]) / STEP);
    segs = all; put(a[0], a[1]);
    if (m < 2) continue;
    segs = all.filter((s) => segDist(s, [a, b]).d < s[4] + S + 1); // (the zones this wall runs into, or nearly: a push can land in the next)
    if (segs.length) for (let i = 1; i < m; i++) put(a[0] + (b[0] - a[0]) * i / m, a[1] + (b[1] - a[1]) * i / m);
  }
  return out;
}
// drop repeated and collinear points (what pushOut's sampling left along straight walls): Douglas-Peucker round the
// ring, so no point dropped lies more than tol off the walls kept
function tidy(P, tol = 0.05) {
  const Q = P.filter((p, i) => { const a = P[(i + P.length - 1) % P.length]; return hyp(p[0] - a[0], p[1] - a[1]) > 0.05; });
  const n = Q.length; if (n <= 3) return Q;
  let far = 0, fd = -1; for (let i = 1; i < n; i++) { const d = (Q[i][0] - Q[0][0]) ** 2 + (Q[i][1] - Q[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
  const dp = (i0, i1) => { // points strictly between i0 and i1 (round the ring)
    const a = Q[i0 % n], b = Q[i1 % n], ex = b[0] - a[0], ez = b[1] - a[1], L = hyp(ex, ez) || 1e-9;
    let m = -1, md = tol;
    for (let i = i0 + 1; i < i1; i++) { const p = Q[i % n], d = Math.abs((p[0] - a[0]) * ez - (p[1] - a[1]) * ex) / L; if (d > md) { md = d; m = i; } }
    if (m < 0) return; keep[m % n] = 1; dp(i0, m); dp(m, i1);
  };
  dp(0, far); dp(far, n);
  return Q.filter((_, i) => keep[i]);
}
// the first two walls of a ring that cross: [i, j, x, z] (walls i and j, where), or null
function crossing(P) {
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const p = P[j], q = P[(j + 1) % n], ex = q[0] - p[0], ez = q[1] - p[1], den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) continue;
      const u = ((p[0] - a[0]) * ez - (p[1] - a[1]) * ex) / den, v = ((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / den;
      if (u > 1e-6 && u < 1 - 1e-6 && v > 1e-6 && v < 1 - 1e-6) return [i, j, a[0] + dx * u, a[1] + dz * u];
    }
  }
  return null;
}
// a ring that folded over itself where it was pushed out of two roads at once (an inside corner): each knot cut off
// at the crossing, the bigger loop kept. null if it won't come untangled.
function untangle(P) {
  for (let it = 0; it < 8; it++) {
    const c = crossing(P); if (!c) return P;
    const [i, j, x, z] = c, X = [x, z];
    const inner = [X, ...P.slice(i + 1, j + 1)], outer = [X, ...P.slice(j + 1), ...P.slice(0, i + 1)];
    P = Math.abs(area(inner)) > Math.abs(area(outer)) ? inner : outer;
    if (P.length < 3) return null;
  }
  return crossing(P) ? null : P;
}
const clear = (segs, Q, S) => segs.every((s) => segDist(s, Q).d >= s[4] + S - TOL);

// A footprint ([[x, z], ...]) set back from the roads: { P (the same array if nothing reached a road), cut (it was
// cut back), drop (nothing worth keeping: leave the building out), depth (how far it reached into a clear zone, before) }.
// major: a big or tall building. One a road runs right through is left whole (through: true): that is a passage under
// it (a building_passage, a covered highway: New York has a few under towers) or a mapping clash too big to settle by
// knocking down a landmark.
export function setBack(I, P, major = false) {
  const none = { P, cut: false, drop: false, depth: 0 };
  if (!I || !I.segs.length) return none;
  const segs = near(I, P); if (!segs.length) return none;
  const S = I.set; let depth = 0, hit = false;
  const D = segs.map((s) => { const d = segDist(s, P); if (s[4] - d.d > depth) depth = s[4] - d.d; if (s[4] + S - d.d > TOL) hit = true; return d; });
  if (!hit) return none;
  if (major && D.some((d) => d.cross)) return { P, cut: false, drop: false, depth, through: true };
  // a road through it: cut it across first (the part on the far side goes); then push the walls out of every clear zone
  let Q = P;
  segs.forEach((s, k) => { if (D[k].cross && Q.length >= 3) { const d = segDist(s, Q); if (d.cross) Q = cutAcross(Q, s, d, s[4] + S); } });
  if (Q.length >= 3) Q = untangle(tidy(pushOut(Q, segs, S)));
  // (a footprint that won't come untangled, or didn't settle clear: cut along each road instead)
  if (!Q || Q.length < 3 || !clear(segs, Q, S)) {
    Q = P;
    for (let it = 0; it <= segs.length && Q.length >= 3; it++) {
      let worst = null, wn = TOL, wd = null;
      for (const s of segs) { const d = segDist(s, Q), need = s[4] + S - d.d; if (need > wn) { wn = need; worst = s; wd = d; } }
      if (!worst) break;
      Q = cutAcross(Q, worst, wd, worst[4] + S);
    }
  }
  if (Q.length < 3) return { P: Q, cut: true, drop: true, depth };
  const A0 = Math.abs(area(P)), A = Math.abs(area(Q));
  return { P: Q, cut: true, drop: A < KEEP * A0 || A < MIN_A || width(Q) < MIN_W, depth };
}
// does a courtyard still lie inside a cut footprint (all its corners)?
export const holeInside = (P, h) => h.every((p) => inside(P, p[0], p[1]));
