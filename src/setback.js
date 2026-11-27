// Building setbacks (#228): no building stands on a road. The real places' buildings are OpenStreetMap footprints and
// their roads are OSM centre lines drawn at class widths (capped), with a gravel verge (roadgrade.js VERGE) or, in a
// city, kerbs and pavements out to the building line (roads.js roadMesh). The two don't always agree: the widths are
// generous, the alignment is a metre or two off here and there, so walls stood on the tarmac.
//
// The rule, per footprint, as it is built (a load-time pass: a grid of road segments, a few distance tests a building):
//  - a road's clear zone is its tarmac plus verge (plus pavement on a city street: kerb to building line), and a
//    building keeps SETBACK beyond it (in a city just the TOL slack: the pavement runs to the building line);
//  - a footprint that reaches into a clear zone is cut back. A house (near-rectangular, or under a pitched roof, which
//    covers its whole rectangle anyway) is trimmed as that rectangle: the face toward the road moves in, just far
//    enough, and the same roof sits on the smaller house. Any other shape has the walls inside the zone pushed
//    straight out to its edge: a frontage along the road on the building line, the rest as OpenStreetMap has it.
//    (Shifting the whole house back would push it into its neighbours or the hillside behind; a half-plane cut along
//    the road's line chopped whole wings off buildings at bends.)
//  - a road right through a footprint: the smaller side goes;
//  - if that leaves less than half of it, or a sliver, it is dropped; unless it's a big or tall one (MAJOR) the road
//    runs right through that can take a passage (PASSAGE: its height mapped, storeys to spare over the road, the road's
//    run under it a passage and not a street grid): that stays whole, with a passage cut under it (realCity.js: the
//    road clear under a raised underside, walls either side, the collision box split). New York has a few dozen: the
//    Bridge Apartments and the bus station over the Trans-Manhattan Expressway. A footprint that swallows whole blocks
//    of streets (Grand Central's train shed under Park Avenue, mapped as a building) or whose height is a guess is a
//    mapping clash: it is cut back like any other.
//  - the collision box (World.wallBoxes, destruction.js) is made from what's left, and fitBox keeps it off the tarmac
//    (an irregular footprint: a few boxes that hug its walls, footBoxes)
//    too (a box reaches past an irregular footprint's walls: over a cut-off corner, an L's yard).
// Tunnels' tubes and bridge decks up in the air are left out (what's under them is no obstacle to the road).
import { VERGE } from './roadgrade.js';

export const SETBACK = 1; // m beyond the verge, off a city's streets
const PAVE = { main: 4.5, street: 3.5 }; // a city street's pavement (roads.js roadMesh: the slabs out to the building line)
const hyp = (x, z) => Math.sqrt(x * x + z * z); // (Math.hypot is slow)
export const MAJOR = { area: 800, height: 25 }; // (m2, m) a building too big to drop for a road through it
// a passage under a building (m): the headroom over the road, the least of the building over that, and the most road
// (all its centre lines' runs under the footprint added up) that is still a passage
export const PASSAGE = { clear: 5.5, over: 4, run: 400 };
const CELL = 32, KEEP = 0.5, MIN_A = 12, MIN_W = 2.2, TOL = 0.3; // (TOL: how far into the setback a wall may stand: it's slack, not road)
// Work done here, counted (tools/test/setbacks.js judges how much work the setbacks and boxes take, not how long: a
// time depends on the machine). The setbacks' work: index (road points indexed, index entries visited: roadIndex,
// near) and tests (footprint walls tested against a road: segDist). The collision boxes': cells (footBoxes' grid cells
// worked: frameGrid, each greedy pass over a frame) and verts (footprint walls visited: inF, outD, ray, irregular).
export const WORK = { index: 0, tests: 0, cells: 0, verts: 0 };
export const workSince = (w0) => ({ index: WORK.index - w0.index, tests: WORK.tests - w0.tests, cells: WORK.cells - w0.cells, verts: WORK.verts - w0.verts });

// The clear zones of a World's road network: segments [ax, az, bx, bz, r, ends, x0, x1, z0, z1] (r: the clear half
// width; ends: 1 the segment's a is a road's dead end, 2 its b is; then its box, out to r + the setback), filed in a
// dense 32 m grid (start: each cell's offset into list; one pass to count, one to fill).
export function roadIndex(w) {
  const city = !!w.loc.city, segs = [], S = city ? TOL : SETBACK; // (a city: nothing past the pavement but the slack, TOL, that setBack leaves alone)
  let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
  for (const rd of w.net?.roads || []) {
    if (rd.kind === 'rail' || rd.minor) continue; // (a way off the street network, roads.js rd.minor: buildings front onto a pedestrian street or a plaza, an alley runs between and under them; they don't move for it)
    const P = rd.pts, n = P.length, last = rd.closed ? n : n - 1; WORK.index += n;
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

// the segments whose clear zones may reach a footprint (or come within pad of its box)
function near(I, P, pad = 0) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
  const out = [], g = ++I.gen, { start, list, segs, stamp } = I;
  const i0 = Math.max(0, Math.floor(x0 / CELL) - I.ox), i1 = Math.min(I.nx - 1, Math.floor(x1 / CELL) - I.ox), j0 = Math.max(0, Math.floor(z0 / CELL) - I.oz), j1 = Math.min(I.nz - 1, Math.floor(z1 / CELL) - I.oz);
  for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
    const c = cj * I.nx + ci;
    WORK.index += start[c + 1] - start[c];
    for (let m = start[c], e = start[c + 1]; m < e; m++) { const k = list[m]; if (stamp[k] === g) continue; stamp[k] = g; const s = segs[k];
      if (s[6] <= x1 && s[7] >= x0 && s[8] <= z1 && s[9] >= z0) out.push(s); }
  }
  return out;
}
const inside = (P, x, z) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
export const area = (P) => { let a = 0; for (let k = 0; k < P.length; k++) { const p = P[k], c = P[(k + 1) % P.length]; a += p[0] * c[1] - c[0] * p[1]; } return a / 2; };

// How far a road's centre line is from a footprint: { d (0: it crosses or runs inside), t (where on the segment, 0..1) }
// (the hot path: no allocations but the answer)
export function segDist(s, P) {
  const ax = s[0], az = s[1], bx = s[2], bz = s[3], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, n = P.length; WORK.tests += n;
  let d2 = Infinity, t = 0, odd = false;
  for (let k = 0; k < n; k++) {
    const p = P[k], c = P[k + 1 === n ? 0 : k + 1], px = p[0], pz = p[1], ex = c[0] - px, ez = c[1] - pz;
    // the centre line crossing this wall
    const den = dx * ez - dz * ex;
    if (den > 1e-12 || den < -1e-12) {
      const u = ((px - ax) * ez - (pz - az) * ex) / den, v = ((px - ax) * dz - (pz - az) * dx) / den;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return { d: 0, t: u, cross: true };
    }
    if ((pz > az) !== (c[1] > az) && ax < ex * (az - pz) / ez + px) odd = !odd; // (is a inside: the ray test)
    // the wall's corner against the segment
    let u = ((px - ax) * dx + (pz - az) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
    let fx = ax + dx * u - px, fz = az + dz * u - pz, q = fx * fx + fz * fz; if (q < d2) { d2 = q; t = u; }
    // the segment's ends against this wall
    const E2 = ex * ex + ez * ez || 1e-9;
    let v = ((ax - px) * ex + (az - pz) * ez) / E2; v = v < 0 ? 0 : v > 1 ? 1 : v;
    fx = px + ex * v - ax; fz = pz + ez * v - az; q = fx * fx + fz * fz; if (q < d2) { d2 = q; t = 0; }
    v = ((bx - px) * ex + (bz - pz) * ez) / E2; v = v < 0 ? 0 : v > 1 ? 1 : v;
    fx = px + ex * v - bx; fz = pz + ez * v - bz; q = fx * fx + fz * fz; if (q < d2) { d2 = q; t = 1; }
  }
  if (odd) return { d: 0, t: 0, cross: true };
  return { d: Math.sqrt(d2), t, cross: false };
}

// Which of a footprint's walls face a street (for their doors and shop fronts): wall k (P[k] -> P[k + 1]) does when a
// road's clear zone (tarmac and pavement: measured from its edge, not the centre line) comes within reach metres of its
// middle, out in front of it. (Either winding.) fallback (m): if no wall is that close, the walls facing the nearest
// road within fallback metres of the clear zone's edge still do (a building set back behind a forecourt or a plaza, a
// street drawn narrower than the real one: its front is still its front). cone: how squarely a wall must face the road
// (the cosine of the angle off its normal to the road's nearest point); 0: any wall with a road out in front of it
// (the road's nearest point among those 2 m or more in front), seen from the street at a slant too: a corner
// building's end wall over a forecourt or a vacant lot.
export function streetWalls(I, P, reach = 4, fallback = 0, cone = 0.6) {
  const n = P.length, out = new Array(n).fill(false);
  if (!I.segs.length || n < 3) return out;
  const sg = area(P) > 0 ? 1 : -1;
  for (let pass = 0; pass < (fallback > reach ? 2 : 1); pass++) { // (the near roads, then (none) the nearest within fallback)
    const lim = pass ? fallback : reach, S = near(I, P, lim); if (!S.length) continue;
    let any = false, best = Infinity, bk = [];
    for (let k = 0; k < n; k++) {
      const p = P[k], q = P[(k + 1) % n], ex = q[0] - p[0], ez = q[1] - p[1], L = hyp(ex, ez); if (L < (pass ? 4 : 2)) continue;
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, ox = sg * ez / L, oz = -sg * ex / L; // (outward)
      for (const s of S) {
        let ax = s[0], az = s[1], bx = s[2], bz = s[3];
        if (!pass && cone <= 0) { // (the part of the centre line out in front of the wall, 2 m on)
          const fa = (ax - mx) * ox + (az - mz) * oz - 2, fb = (bx - mx) * ox + (bz - mz) * oz - 2;
          if (fa < 0 && fb < 0) continue;
          if (fa < 0) { const u = fa / (fa - fb); ax += (bx - ax) * u; az += (bz - az) * u; } else if (fb < 0) { const u = fa / (fa - fb); bx = ax + (bx - ax) * u; bz = az + (bz - az) * u; }
        }
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
        let t = ((mx - ax) * dx + (mz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t - mx, cz = az + dz * t - mz, d = hyp(cx, cz), g = d - s[4];
        if (g >= lim || (cone > 0 || pass ? cx * ox + cz * oz <= (pass ? 0.6 : cone) * d : false)) continue;
        if (!pass) { out[k] = any = true; break; }
        if (g < best - 2) { best = g; bk = [k]; } else if (g < best + 2) bk.push(k); // (the nearest road's walls: within 2 m of the nearest)
      }
    }
    if (any) return out;
    for (const k of bk) out[k] = true;
  }
  return out;
}

// The roads a footprint stands over: the clear zones whose centre lines cross it, and how much of them runs under it
// (m, all of them added up): { segs, len }
export function roadRun(I, P) {
  const segs = [], n = P.length; let len = 0;
  if (!I || !I.segs.length) return { segs, len };
  for (const s of near(I, P)) {
    if (!segDist(s, P).cross) continue;
    const ax = s[0], az = s[1], dx = s[2] - ax, dz = s[3] - az, L = hyp(dx, dz), ts = [0, 1];
    for (let k = 0; k < n; k++) { // (where the centre line crosses the walls)
      const p = P[k], c = P[(k + 1) % n], ex = c[0] - p[0], ez = c[1] - p[1], den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) continue;
      const u = ((p[0] - ax) * ez - (p[1] - az) * ex) / den, v = ((p[0] - ax) * dz - (p[1] - az) * dx) / den;
      if (u > 0 && u < 1 && v >= 0 && v <= 1) ts.push(u);
    }
    ts.sort((a, b) => a - b); let run = 0;
    for (let i = 0; i + 1 < ts.length; i++) { const m = (ts[i] + ts[i + 1]) / 2; if (inside(P, ax + dx * m, az + dz * m)) run += (ts[i + 1] - ts[i]) * L; }
    if (run > 0.05) { segs.push(s); len += run; }
  }
  return { segs, len };
}

// How deep a footprint reaches into the clear zones (tarmac + verge / pavement; no setback): the worst, in metres (0: clear)
export function intrusion(I, P) {
  let worst = 0; if (!I.segs.length) return 0;
  for (const s of near(I, P)) { const { d } = segDist(s, P); if (s[4] - d > worst) worst = s[4] - d; }
  return worst;
}

// keep the part of P with n . (x - o) >= c (Sutherland-Hodgman against one half-plane; keeps the ring's winding)
export function clip(P, nx, nz, ox, oz, c) {
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

// The footprint's oriented bounding box (the wall direction giving the smallest rectangle): { ux, uz, u0, u1, v0, v1, ar }
// in its frame (u along (ux, uz), v along (-uz, ux))
function frame(P) {
  let best = null;
  for (let k = 0; k < P.length; k++) {
    const a = P[k], c = P[(k + 1) % P.length], ex = c[0] - a[0], ez = c[1] - a[1], L = hyp(ex, ez); if (L < 0.5) continue;
    const ux = ex / L, uz = ez / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of P) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const ar = (u1 - u0) * (v1 - v0); if (!best || ar < best.ar) best = { ux, uz, u0, u1, v0, v1, ar };
  }
  return best;
}
const corners = (b) => [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [u * b.ux - v * b.uz, u * b.uz + v * b.ux]); // (counter-clockwise)
// A rectangle (frame) with its faces moved in until it is clear of every clear zone (c = r + S), one road at a time,
// the deepest first: of its four faces, the one that clears that road keeping the most of the rectangle moves (just far
// enough: bisection). A house trimmed at its road end or side stays a house; a road through it takes the smaller side.
// null if nothing 1.5 m across is left.
const FACES = ['u0', 'u1', 'v0', 'v1'];
function shrinkRect(b, segs, S) {
  b = { ...b };
  const need = (s, q) => s[4] + S - segDist(s, corners(q)).d;
  for (let it = 0; it < 12; it++) {
    let worst = null, wn = TOL;
    for (const s of segs) { const n = need(s, b); if (n > wn) { wn = n; worst = s; } }
    if (!worst) return b;
    let best = null, part = null;
    for (const f of FACES) {
      const sg = f.endsWith('0') ? 1 : -1, other = f[0] + (f[1] === '0' ? '1' : '0'), room = Math.abs(b[other] - b[f]) - 1.5; if (room <= 0) continue;
      const at = (m) => ({ ...b, [f]: b[f] + sg * m }), left = need(worst, at(room));
      if (left > TOL) { if (!part || left < part.left) part = { left, q: at(room / 2) }; continue; } // (this face alone can't clear it: a road across a corner)
      let lo = 0, hi = room; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (need(worst, at(m)) > TOL - 0.05) lo = m; else hi = m; }
      const q = at(hi), a = (q.u1 - q.u0) * (q.v1 - q.v0); if (!best || a > best.a) best = { q, a };
    }
    if (!best && !part) return null;
    b = best ? best.q : part.q; // (no one face clears it: the one that gets furthest goes halfway, and round again)
  }
  return null;
}
// A building's collision box ({ x, z, ux, uz, hl, hw }, as World.wallBoxes reads it) kept off the roads: a footprint cut
// back by setBack can still have a box over the road (an L cut at a corner keeps its full rectangle as its box), and a
// car would hit thin air on the tarmac. Its faces are moved in as shrinkRect does, to the edge of the tarmac + verge /
// pavement (no setback); the same box if it's clear, or if it can't be cleared (a road under a big building, kept whole).
export function fitBox(I, ob) {
  if (!I || !I.segs.length) return ob;
  const b = { ux: ob.ux, uz: ob.uz, u0: 0, u1: 0, v0: 0, v1: 0 }, cu = ob.x * ob.ux + ob.z * ob.uz, cv = -ob.x * ob.uz + ob.z * ob.ux;
  b.u0 = cu - ob.hl; b.u1 = cu + ob.hl; b.v0 = cv - ob.hw; b.v1 = cv + ob.hw;
  const segs = near(I, corners(b)); if (!segs.length) return ob;
  const f = shrinkRect(b, segs, TOL - 0.05); // (to the zones' edge: TOL - 0.05 past it, so it clears with 5 cm to spare)
  if (!f || (f.u0 === b.u0 && f.u1 === b.u1 && f.v0 === b.v0 && f.v1 === b.v1)) return ob;
  const um = (f.u0 + f.u1) / 2, vm = (f.v0 + f.v1) / 2;
  return { x: um * ob.ux - vm * ob.uz, z: um * ob.uz + vm * ob.ux, ux: ob.ux, uz: ob.uz, hl: (f.u1 - f.u0) / 2, hw: (f.v1 - f.v0) / 2, fit: true };
}

// A footprint ([[x, z], ...]) set back from the roads: { P (the same array if nothing reached a road), cut (it was
// cut back), drop (nothing worth keeping: leave the building out), depth (how far it reached into a clear zone, before) }.
// major: a big or tall building. One a road runs right through is left whole (through: true, pass: the clear zones
// under it, for the passage) where it can take a passage: pass = { h: its height above its floor (m), tagged: that
// height is mapped, not guessed } (PASSAGE; without pass: always). Else (a mapping clash) it is cut back like any other.
// asRect: trim it as its bounding rectangle whatever its shape (a building under a pitched roof, which covers that
// rectangle anyway).
export function setBack(I, P, major = false, asRect = false, pass = null) {
  const none = { P, cut: false, drop: false, depth: 0 };
  if (!I || !I.segs.length) return none;
  const fr = frame(P), A0 = Math.abs(area(P)), box = asRect && fr ? corners(fr) : P; // (what has to keep off the road)
  let segs = near(I, box); if (!segs.length) return none;
  const S = I.set; let depth = 0, hit = false, cross = false;
  for (const s of segs) { const d = segDist(s, P); if (s[4] - d.d > depth) depth = s[4] - d.d; if (d.cross) cross = true; if (s[4] + S - (box === P ? d.d : segDist(s, box).d) > TOL) hit = true; }
  if (!hit) return none;
  if (major && cross) {
    const run = roadRun(I, P);
    if (!pass || (pass.tagged && pass.h >= PASSAGE.clear + PASSAGE.over && run.len <= PASSAGE.run)) return { P, cut: false, drop: false, depth, through: true, pass: run.segs };
  }
  // a near-rectangular one (most houses): the rectangle trimmed, faces moved in off the road (through it: the smaller side goes)
  segs = near(I, fr ? corners(fr) : P, 3); // (from here on: the roads near what it may become, too)
  if (fr && (asRect || A0 / fr.ar > 0.92)) {
    const b = shrinkRect(fr, segs, S);
    if (!b && asRect) return { P, cut: true, drop: true, depth };
    if (b) { const R = corners(b), A = Math.abs(area(R)); return { P: area(P) < 0 ? R.reverse() : R, cut: true, drop: A < KEEP * A0 || A < MIN_A || Math.min(b.u1 - b.u0, b.v1 - b.v0) < MIN_W, depth, rect: true }; }
  }
  // else: a road through it: cut it across first (the part on the far side goes); then push the walls out of every clear zone
  let Q = P;
  for (const s of segs) { if (Q.length < 3) break; const d = segDist(s, Q); if (d.cross) Q = cutAcross(Q, s, d, s[4] + S); }
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
  const A = Math.abs(area(Q));
  return { P: Q, cut: true, drop: A < KEEP * A0 || A < MIN_A || width(Q) < MIN_W, depth };
}
// does a courtyard still lie inside a cut footprint (all its corners)?
export const holeInside = (P, h) => h.every((p) => inside(P, p[0], p[1]));

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// Collision boxes that hug a footprint's walls. One oriented box can't fit a cross, a U, an L's yard, a courtyard or a
// trapezoid's sliver on a diagonal street: it reaches past the walls and a car hits an invisible wall out on the open
// ground. So an irregular footprint gets a few boxes:
//  - frames: the building's own (ux, uz), and up to FOOT.frames - 1 more along its longest walls that run some other
//    way (a wing turned off the rest, a front on a diagonal street);
//  - in each frame a grid of cells on the footprint's own lines (frameGrid: through every corner, and every FOOT.step
//    along a slanted wall); a cell is the footprint's if its middle is inside it (holes left out);
//  - a long wall that runs off every frame gets a strip of box along it, its outer face on the wall, as deep as fits;
//  - then boxes are taken greedily: each time, in whichever frame, the rectangle of the footprint's cells that covers
//    most of it still uncovered (bigger on a tie), until FOOT.cover of it is covered, FOOT.max boxes, or what's left
//    is crumbs;
//  - each box's faces are set on the walls before the next is taken (what's left uncovered then is what counts):
//    rays from inside the box out across a face find the walls beyond it; the face goes onto them (a straight wall: on
//    it; along a slanted wall out to FOOT.grow past its nearest point; over a small notch in a long wall). No point of
//    a face may stand more than FOOT.out past the walls (the face moves in if one does);
//  - a box inside another goes. Where two meet, a car is never pushed out of one into the other (aircraft.js).
// -> [{ x, z, ux, uz, hl, hw }] (the building's own frame's first), or null.
export const FOOT = { step: 1, slant: 0.3, cells: 2000, max: 12, frames: 4, strips: 6, cover: 0.97, grow: 0.5, out: 1, eager: 10000, retry: 0.95, fine: { step: 0.5, max: 32, edge: 1, crumbs: 0.5, cover: 0.99, grow: 0.5, frames: 6, turn: 3 }, tile: 60, tiled: 1500 }; // (eager: m2, a footprint so big its boxes take the quick road: a first pass, then the Refiner's squares (they were worked out at load; now when first asked too, lazyParts, its footprint kept exact); tile: m, the squares a big one the fine pass leaves under 90% is cut into, tiled: from how big, m2, tiledBoxes)
const D8 = (8 * Math.PI) / 180, D3 = (3 * Math.PI) / 180, Q90 = Math.PI / 2;
const turn = (a, b) => { const d = Math.abs(a - b) % Q90; return Math.min(d, Q90 - d); }; // (between two wall directions, mod 90 degrees)
// a footprint in a frame (fx, fz): its rings in (u, v), and a grid of cells on its own lines: through every corner
// (a footprint square to the frame: its cells exactly), and every FOOT.step along a wall that runs off every frame
// (one along another frame, that frame fits: every 3 FOOT.step)
function frameGrid(P, holes, fx, fz, framed, step = FOOT.step, fk = 3) {
  const rings = [P, ...holes].map((R) => { const a = new Float64Array(R.length * 2); for (let k = 0; k < R.length; k++) { const x = R[k][0], z = R[k][1]; a[k * 2] = x * fx + z * fz; a[k * 2 + 1] = -x * fz + z * fx; } return a; });
  const us = [], vs = []; let exact = true; // (then sorted as Float64Arrays: by number)
  for (const a of rings) for (let n = a.length / 2, k = 0, m = n - 1; k < n; m = k++) {
    const pu = a[m * 2], pv = a[m * 2 + 1], du = a[k * 2] - pu, dv = a[k * 2 + 1] - pv; us.push(pu); vs.push(pv);
    if (Math.abs(du) > FOOT.slant && Math.abs(dv) > FOOT.slant) { exact = false; const n2 = Math.min(40, Math.ceil(Math.max(Math.abs(du), Math.abs(dv)) / (step * (framed(du * fx - dv * fz, du * fz + dv * fx) ? fk : 1)))); for (let i = 1; i < n2; i++) { us.push(pu + du * i / n2); vs.push(pv + dv * i / n2); } }
  }
  const lines = (x, g) => { x.sort(); const o = [x[0]]; for (const t of x) if (t - o[o.length - 1] > g) o.push(t); if (x[x.length - 1] - o[o.length - 1] > 1e-6) o[o.length - 1] = x[x.length - 1]; return o; };
  const us2 = Float64Array.from(us), vs2 = Float64Array.from(vs);
  let U, V, g = 0.05;
  for (;;) { U = lines(us2, g); V = lines(vs2, g); if ((U.length - 1) * (V.length - 1) <= FOOT.cells || g > 4) break; g *= 1.5; } // (a big, round one: fewer, coarser cells)
  const nu = U.length - 1, nv = V.length - 1; if (nu < 1 || nv < 1 || U[nu] - U[0] < 1 || V[nv] - V[0] < 1) return null;
  const N = nu * nv, IN = new Uint8Array(N), wa = new Float64Array(N), uc = new Float64Array(nu), xs = []; WORK.cells += N;
  for (let i = 0; i < nu; i++) uc[i] = (U[i] + U[i + 1]) / 2;
  let aIn = 0;
  // which cells are the footprint's: a scanline through each row's middle (even-odd over every ring: the holes drop out)
  for (let j = 0; j < nv; j++) {
    const v = (V[j] + V[j + 1]) / 2, h = V[j + 1] - V[j]; xs.length = 0;
    for (const a of rings) for (let n = a.length / 2, k = 0, m = n - 1; k < n; m = k++) { const av = a[m * 2 + 1], bv = a[k * 2 + 1]; if ((av > v) !== (bv > v)) xs.push(a[m * 2] + (v - av) * (a[k * 2] - a[m * 2]) / (bv - av)); }
    xs.sort((p, q) => p - q);
    for (let i = 0; i < nu; i++) wa[j * nu + i] = (U[i + 1] - U[i]) * h;
    for (let k = 0, i = 0; k + 1 < xs.length; k += 2) { while (i < nu && uc[i] < xs[k]) i++; for (; i < nu && uc[i] < xs[k + 1]; i++) { IN[j * nu + i] = 1; aIn += wa[j * nu + i]; } }
  }
  return { ub: Infinity, exact, fx, fz, rings, nr: rings.reduce((t, a) => t + a.length / 2, 0), U, V, nu, nv, N, IN, wa, aIn, cov: new Uint8Array(N), dead: new Uint8Array(N), S: new Float64Array((nu + 1) * (nv + 1)), h: new Int32Array(nu), st: new Int32Array(nu + 1) };
}
// exact geometry in a frame: inside the footprint? how far outside? how far along an axis (0 u, 1 v), direction sg, to the first wall
const inF = (G, u, v) => { let c = false; WORK.verts += G.nr; for (const a of G.rings) for (let n = a.length / 2, k = 0, m = n - 1; k < n; m = k++) { const av = a[m * 2 + 1], bv = a[k * 2 + 1]; if ((av > v) !== (bv > v) && u < a[m * 2] + (v - av) * (a[k * 2] - a[m * 2]) / (bv - av)) c = !c; } return c; };
function outD(G, u, v) {
  if (inF(G, u, v)) return 0;
  WORK.verts += G.nr;
  let d2 = Infinity;
  for (const a of G.rings) for (let n = a.length / 2, k = 0, m = n - 1; k < n; m = k++) { const pu = a[m * 2], pv = a[m * 2 + 1], eu = a[k * 2] - pu, ev = a[k * 2 + 1] - pv, L2 = eu * eu + ev * ev || 1e-9, t = clamp01(((u - pu) * eu + (v - pv) * ev) / L2), du = pu + eu * t - u, dv = pv + ev * t - v, q = du * du + dv * dv; if (q < d2) d2 = q; }
  return Math.sqrt(d2);
}
function ray(G, u, v, ax, sg) { // (-1: (u, v) isn't inside the footprint: an odd number of walls ahead if it is)
  let best = Infinity, odd = false; WORK.verts += G.nr;
  for (const a of G.rings) for (let n = a.length / 2, k = 0, m = n - 1; k < n; m = k++) {
    const p0 = a[m * 2 + ax], q0 = a[m * 2 + 1 - ax], p1 = a[k * 2 + ax], q1 = a[k * 2 + 1 - ax], c = ax ? u : v;
    if ((q0 > c) !== (q1 > c)) { const d = (p0 + (c - q0) * (p1 - p0) / (q1 - q0) - (ax ? v : u)) * sg; if (d > 0) { odd = !odd; if (d < best) best = d; } }
  }
  return odd ? best : -1;
}
// a box (world: x, z, ux, uz, hl, hw) marks the cells of a frame's grid whose middles it covers
function mark(G, b) {
  const cu = b.x * G.fx + b.z * G.fz, cv = -b.x * G.fz + b.z * G.fx, au = b.ux * G.fx + b.uz * G.fz, av = -b.ux * G.fz + b.uz * G.fx, r = b.hl + b.hw, { U, V, nu, nv } = G;
  for (let j = 0; j < nv; j++) {
    const y = (V[j] + V[j + 1]) / 2 - cv; if (y < -r || y > r) continue;
    for (let i = 0; i < nu; i++) { const x = (U[i] + U[i + 1]) / 2 - cu; if (x >= -r && x <= r && Math.abs(x * au + y * av) < b.hl && Math.abs(-x * av + y * au) < b.hw) G.cov[j * nu + i] = 1; }
  }
}
const toWorld = (G, cu, cv, au, av, hl, hw) => ({ x: cu * G.fx - cv * G.fz, z: cu * G.fz + cv * G.fx, ux: au * G.fx - av * G.fz, uz: au * G.fz + av * G.fx, hl, hw });
// A footprint the first pass leaves under FOOT.retry covered (sampled, not by cells: a spiky tower, a curved front, a
// sliver of a trapezoid; its walls run off the 1 m grid, or it needs more than FOOT.max boxes) gets a second, finer pass
// (FOOT.fine: every slanted wall cut every half metre in every frame, up to 6 frames and 32 boxes, smaller crumbs taken,
// a wing turned 3 degrees off the rest, or one with walls from 2 m long, a frame of its own, faces checked against FOOT.out every metre instead of at their
// quarters, and a box past it dropped), kept if it covers more. Only those few hundred buildings pay for it, in time and
// in boxes. A big one (over FOOT.tiled) still under 90% then (a campus of wings, a block of courtyards: more than 32
// boxes' worth) is cut into FOOT.tile squares, each boxed on its own (tiledBoxes): B.refine says so, and its owner has
// a Refiner do it a piece at a time in a frame's spare time, these boxes standing till then. A huge one (over
// FOOT.eager) goes straight there after its first pass.
export function footBoxes(P, holes, ux, uz, tiles = true, pre = null, quick = false) {
  if (pre) return footPass(P, holes, ux, uz, FOOT.fine, pre); // (more boxes, for what pre leaves bare: fillBare)
  const B = footPass(P, holes, ux, uz, null, null, quick);
  if (!B || !(B.cov < (quick ? 0.93 : FOOT.retry) || B.dropped) || !FOOT.fine) return B; // (quick: as before, at load)
  if (B.area > FOOT.eager && tiles) { B.refine = true; return B; } // (the fine pass on one is 3-60 ms, ~0.2 s more on New York's load)
  let F = footPass(P, holes, ux, uz, FOOT.fine); F = F && F.cov > B.cov + 0.01 ? F : B;
  if (F.cov < 0.9 && !quick && !(tiles && F.area > FOOT.tiled)) { // (a small one still bare (a big one is cut into squares, below): the fine pass again starting in the frames of its longest walls that run some other way, up to 3; the frame it starts in decides what it takes first)
    const E = []; for (let k = 0, m = P.length - 1; k < P.length; m = k++) { const dx = P[k][0] - P[m][0], dz = P[k][1] - P[m][1], l = Math.hypot(dx, dz); if (l > 1) E.push([l, dx / l, dz / l]); }
    E.sort((a, b) => b[0] - a[0]); const tried = [Math.atan2(uz, ux)];
    for (const [, ex, ez] of E) {
      const a = Math.atan2(ez, ex); if (tried.length > 3 || tried.some((b) => turn(a, b) <= D3)) continue; tried.push(a);
      const G = footPass(P, holes, ex, ez, FOOT.fine); if (G && G.cov > F.cov + 0.01) F = G;
    }
  }
  if (tiles && F.cov < 0.9 && F.area > FOOT.tiled) F.refine = true; // (cut into squares: a Refiner's job, after these, 10-25 ms is a hitch when a car first comes near)
  return F;
}
// A building's boxes kept off the street (fit: setback.js fitBox each; one moved in off it can leave a slice of the
// building bare, a slanted front's wedge): more boxes for what's bare, kept off it too. -> the boxes
export function fillBare(P, holes, ux, uz, B, fit) {
  const F = B.map(fit); if (!F.some((f) => f.fit) || B.area > FOOT.eager) return F; // (not a huge one (FOOT.eager): the fine pass there is too slow)
  const more = footPass(P, holes, ux, uz, FOOT.fine, F); return more ? F.concat(more.map(fit)) : F;
}
// A big footprint cut into squares FOOT.tile across (in the building's frame), each piece's boxes (footBoxes) inside
// it: a piece is a few wings, boxed on a fine grid of its own (the whole one's grid is FOOT.cells cells, metres across
// on a campus). Then boxes in one frame that share a whole face (a wing across a cut) are one box again.
// -> boxes, cov: the pieces' covers weighted by area. tiledSteps: the same a piece at a time (a Refiner's job).
export function tiledBoxes(P, holes, ux, uz) { const it = tiledSteps(P, holes, ux, uz); let r; do r = it.next(); while (!r.done); return r.value; }
export function* tiledSteps(P, holes, ux, uz) {
  holes = holes || [];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of P) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  const T = FOOT.tile, nu = Math.max(1, Math.round((u1 - u0) / T)), nv = Math.max(1, Math.round((v1 - v0) / T)), su = (u1 - u0) / nu, sv = (v1 - v0) / nv, out = [];
  const cut = (R, ua, ub, va, vb) => { let Q = clip(R, ux, uz, 0, 0, ua); if (Q.length >= 3) Q = clip(Q, -ux, -uz, 0, 0, -ub); if (Q.length >= 3) Q = clip(Q, -uz, ux, 0, 0, va); if (Q.length >= 3) Q = clip(Q, uz, -ux, 0, 0, -vb); WORK.verts += R.length * 4; return Q.length >= 3 && Math.abs(area(Q)) > 0.05 ? Q : null; };
  let cA = 0, tA = 0;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const ua = u0 + su * i, ub = ua + su, va = v0 + sv * j, vb = va + sv, Q = cut(P, ua, ub, va, vb); if (!Q) continue;
    const H = holes.map((h) => cut(h, ua, ub, va, vb)).filter(Boolean), B = footBoxes(Q, H, ux, uz, false), a = Math.abs(area(Q)) - H.reduce((t, h) => t + Math.abs(area(h)), 0);
    if (a > 0) { tA += a; if (B) { cA += a * B.cov; out.push(...B); } }
    yield;
  }
  if (!out.length) return null;
  const M = mergeBoxes(out); M.cov = cA / Math.max(1e-9, tA); M.area = tA;
  return M;
}
// boxes in one frame that share a whole face (to 5 cm): one box (in place, a pass at a time till none do)
function mergeBoxes(L) {
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < L.length; i++) for (let j = L.length - 1; j > i; j--) {
      const a = L[i], b = L[j], d = a.ux * b.ux + a.uz * b.uz; if (Math.abs(d) < 0.99999 && Math.abs(a.ux * b.uz - a.uz * b.ux) < 0.99999) continue;
      const r = a.hl + a.hw + b.hl + b.hw; if (Math.abs(a.x - b.x) > r || Math.abs(a.z - b.z) > r) continue;
      const fx = a.ux, fz = a.uz, cu = b.x * fx + b.z * fz, cv = -b.x * fz + b.z * fx, au = a.x * fx + a.z * fz, av = -a.x * fz + a.z * fx;
      const [pl, pw] = Math.abs(d) > 0.5 ? [b.hl, b.hw] : [b.hw, b.hl], A = [[au - a.hl, au + a.hl], [av - a.hw, av + a.hw]], B = [[cu - pl, cu + pl], [cv - pw, cv + pw]];
      for (let ax = 0; ax < 2; ax++) {
        const o = 1 - ax;
        if (Math.abs(A[o][0] - B[o][0]) > 0.05 || Math.abs(A[o][1] - B[o][1]) > 0.05 || (Math.abs(A[ax][1] - B[ax][0]) > 0.05 && Math.abs(B[ax][1] - A[ax][0]) > 0.05)) continue;
        const R = [[], []]; R[ax] = [Math.min(A[ax][0], B[ax][0]), Math.max(A[ax][1], B[ax][1])]; R[o] = [Math.max(A[o][0], B[o][0]), Math.min(A[o][1], B[o][1])];
        const mu = (R[0][0] + R[0][1]) / 2, mv = (R[1][0] + R[1][1]) / 2;
        L[i] = { x: mu * fx - mv * fz, z: mu * fz + mv * fx, ux: fx, uz: fz, hl: (R[0][1] - R[0][0]) / 2, hw: (R[1][1] - R[1][0]) / 2 }; L.splice(j, 1); changed = true;
        break;
      }
    }
  }
  return L;
}
// A huge footprint's tiledBoxes worked out after load, a piece at a time (a scenery's update, in what's left of a
// frame's budget): its first pass's boxes stand till then. done(boxes) swaps them in.
export class Refiner {
  constructor() { this.jobs = []; this.ms = 0; this.pieces = 0; this.done = 0; this.slowest = 0; }
  add(P, holes, ux, uz, done) { this.jobs.push({ it: tiledSteps(P, holes, ux, uz), done }); }
  step(ms = 1, max = Infinity) { // (max: pieces at most, whatever the time: the test stepper)
    const t0 = performance.now();
    for (let n = 0; this.jobs.length && n < max && performance.now() - t0 < ms; n++) {
      const j = this.jobs[0], t1 = performance.now(), r = j.it.next(), dt = performance.now() - t1; this.pieces++; if (dt > this.slowest) this.slowest = dt;
      if (r.done) { this.jobs.shift(); this.done++; if (r.value) j.done(r.value); }
    }
    this.ms += performance.now() - t0;
  }
  flush() { this.step(Infinity); }
}
function footPass(P, holes, ux, uz, fine, pre = null, quick = false) {
  holes = holes || [];
  const STEP = fine?.step ?? FOOT.step, MAX = fine?.max ?? FOOT.max;
  const A = Math.abs(area(P)) - holes.reduce((t, h) => t + Math.abs(area(h)), 0); if (!(A > 2)) return null;
  // the frames: the building's own, and its longest walls' that run some other way
  const dirs = [[ux, uz]], ang = (x, z) => ((Math.atan2(z, x) % Q90) + Q90) % Q90, ed = [];
  for (let k = 0, m = P.length - 1; k < P.length; m = k++) { const ex = P[k][0] - P[m][0], ez = P[k][1] - P[m][1], L = Math.hypot(ex, ez); if (L >= 2.5) ed.push([L, P[m], ex / L, ez / L]); }
  ed.sort((p, q) => q[0] - p[0]);
  for (const [L, , ex, ez] of ed) { if (dirs.length >= (fine?.frames ?? FOOT.frames) || L < (fine ? Math.max(2, 0.06 * Math.sqrt(A)) : Math.max(4, 0.12 * Math.sqrt(A)))) break; if (dirs.every(([x, z]) => turn(ang(x, z), ang(ex, ez)) > (fine ? fine.turn * Q90 / 90 : D8))) dirs.push([ex, ez]); } // (the fine pass: a wing turned 3 degrees off the rest gets its own frame too)
  const framed = (x, z) => dirs.some(([fx, fz]) => turn(ang(fx, fz), ang(x, z)) < D3), grids = dirs.map(([fx, fz]) => frameGrid(P, holes, fx, fz, framed, STEP, fine ? 1 : 3)), G0 = grids[0], F = grids.filter(Boolean);
  if (!G0 || !(G0.aIn > 1)) return null;
  const out = []; // [G, cu, cv, au, av, hl, hw] in G's frame
  if (pre) for (const b of pre) for (const G of F) mark(G, b); // (boxes it has already: what's left uncovered counts)
  // strips along the long walls no frame runs with (within 3 degrees), in the building's frame
  for (const [L, p, ex, ez] of ed) {
    if (out.length >= FOOT.strips) break;
    if (F.some((G) => turn(ang(G.fx, G.fz), ang(ex, ez)) < D3)) continue;
    const du = ex * ux + ez * uz, dv = -ex * uz + ez * ux, pu = p[0] * ux + p[1] * uz, pv = -p[0] * uz + p[1] * ux, sgA = area(P) > 0 ? 1 : -1, nu2 = -dv * sgA, nv2 = du * sgA, at = (t, d) => [pu + du * t + nu2 * d, pv + dv * t + nv2 * d];
    for (const T of [2.5, 1.6, 1, 0.6]) {
      const M = Math.floor(L / 0.5), good = []; for (let i = 0; i <= M; i++) { const [u, v] = at(i * 0.5, T); good.push(outD(G0, u, v) < 0.15); }
      let b0 = -1, b1 = -1; for (let i = 0, r = -1; i <= M; i++) { if (!good[i]) { r = -1; continue; } if (r < 0) r = i; if (i - r > b1 - b0) { b0 = r; b1 = i; } }
      if (b0 < 0) continue;
      let t0 = b0 * 0.5, t1 = b1 * 0.5; const endOk = (t) => [0.25, 0.5, 0.75].every((f) => { const [u, v] = at(t, T * f); return outD(G0, u, v) < 0.15; });
      for (let it = 0; it < 24 && t1 - t0 >= 2 && !endOk(t0); it++) t0 += 0.5;
      for (let it = 0; it < 24 && t1 - t0 >= 2 && !endOk(t1); it++) t1 -= 0.5;
      if (t1 - t0 < 2) continue;
      const [cu, cv] = at((t0 + t1) / 2, T / 2), b = [G0, cu, cv, du, dv, (t1 - t0) / 2, T / 2]; out.push(b);
      const w = toWorld(...b); for (const G of F) mark(G, w);
      break;
    }
  }
  const nStrips = out.length;
  // a rectangle's faces onto the walls (in place)
  const grow = fine ? fine.grow : nStrips ? 0.1 : FOOT.grow; // (not past a wall a strip lines)
  const snap = (G, f) => {
    const s = STEP;
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < 4; k++) { // faces: 0 u0, 1 u1, 2 v0, 3 v1 (first with the ends left out by the raster's slack: the next faces are not on their walls yet)
      const ax = k >> 1, sg = k & 1 ? 1 : -1, lo = f[ax ? 0 : 2], hi = f[ax ? 1 : 3], len = hi - lo, depth = (f[ax * 2 + 1] - f[ax * 2]) / 2;
      const n = Math.min(8, Math.max(2, Math.ceil(len / 2))), e = Math.min(pass ? 0.25 : 0.75 * s + 0.1, len / 4), ex = [], ends = [];
      for (let q = 0; q < n; q++) {
        const t = lo + e + (len - 2 * e) * q / (n - 1), p = f[k] - sg * depth, u = ax ? t : p, v = ax ? p : t;
        const d = ray(G, u, v, ax, sg); if (d >= 0) { ex.push(p + sg * d); if (q === 0 || q === n - 1) ends.push(p + sg * d); }
      }
      // the walls up to just past the face (further out: more of the building, the face is inside it there); the face
      // goes to the furthest of them that leaves the nearer ones at most grow behind it (a slanted wall), or at most
      // FOOT.out behind it at a few points, with most of them on it (a notch in a long straight wall); else onto the nearest
      const wl = ex.filter((x) => (x - f[k]) * sg <= 1.5 * s).sort((a, b) => (b - a) * sg);
      if (!wl.length) continue;
      let to = wl[wl.length - 1];
      for (const c of wl) {
        let mx = 0, cnt = 0, on = 0, far = 0;
        for (const x of wl) { const o = (c - x) * sg; if (Math.abs(o) < 0.05) on++; if (o > 1e-6) { cnt++; if (o > mx) mx = o; if (o > grow && !ends.includes(x)) far++; } }
        // (a slanted wall; a notch; or most of it on a wall and only its ends past one: a corner the next face, or the
        // check below, takes care of)
        if (mx <= grow || (on >= 0.5 * ex.length && ((mx <= FOOT.out && cnt <= 0.25 * ex.length) || !far))) { to = c; break; }
      }
      to = sg > 0 ? Math.max(to, f[k] - 1.5 * s) : Math.min(to, f[k] + 1.5 * s); // (no wild moves)
      if ((sg > 0 ? to - f[k - 1] : f[k + 1] - to) > 0.3) f[k] = to;
    }
    // nothing more than FOOT.out past the walls (corners, edge middles and quarters): the worst face moves in
    for (let it = 0; it < 16; it++) {
      let w = FOOT.out, wf = -1, wa = 0;
      for (let k = 0; k < 4; k++) { const ax = k >> 1, lo = ax ? f[0] : f[2], len = ax ? f[1] - f[0] : f[3] - f[2], na = fine ? Math.min(16, Math.max(4, Math.ceil(len / fine.edge))) : quick || A > FOOT.eager ? 4 : Math.min(8, Math.max(4, Math.ceil(len / 2))); for (let a = 0; a <= na; a++) { const t = lo + len * a / na, d = ax ? outD(G, t, f[k]) : outD(G, f[k], t); if (d > w) { w = d; wf = k; wa = a === 0 ? 0 : a === na ? 4 : 2; } } }
      if (wf < 0) break;
      if (wa === 0 || wa === 4) { const o = (wf >> 1 ? 0 : 2) + (wa ? 1 : 0); if ((o >> 1 ? f[1] - f[0] : f[3] - f[2]) < (wf >> 1 ? f[1] - f[0] : f[3] - f[2])) wf = o; } // (a corner: whichever of its faces is shorter moves in)
      const ax = wf >> 1; if (f[ax * 2 + 1] - f[ax * 2] < 1) break;
      f[wf] += wf & 1 ? -0.25 : 0.25;
    }
  };
  // greedy: in each frame the maximal rectangles of the footprint's cells (a histogram stack per row), scored by the
  // footprint they cover that's still uncovered (m2); the best of all the frames
  const crumbs = fine ? Math.max(Math.min(fine.crumbs, 0.01 * A), 0.002 * A) : Math.max(Math.min(1.5, 0.02 * A), 0.004 * A), cov0 = () => { let t = 0; for (let c = 0; c < G0.N; c++) if (G0.IN[c] && G0.cov[c]) t += G0.wa[c]; return t; };
  let got = cov0();
  for (let tries = 0; out.length < MAX && tries < 2 * MAX && got < (fine?.cover ?? FOOT.cover) * G0.aIn; tries++) {
    let best = null, ba = crumbs, bar = 0;
    F.sort((p, q) => q.ub - p.ub);
    for (const G of F) {
      if (G.ub < ba) continue; // (its best last time is as much as it can give now: the uncovered footprint only shrinks)
      const { nu, nv, IN, wa, cov, dead, S, h, st } = G, W1 = nu + 1; let gb = 0; WORK.cells += nu * nv;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const c = j * nu + i; S[(j + 1) * W1 + i + 1] = (IN[c] && !cov[c] && !dead[c] ? wa[c] : 0) + S[j * W1 + i + 1] + S[(j + 1) * W1 + i] - S[j * W1 + i]; }
      h.fill(0);
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) h[i] = IN[j * nu + i] ? h[i] + 1 : 0;
        let top = 0;
        for (let i = 0; i <= nu; i++) {
          const hi = i < nu ? h[i] : 0;
          while (top && h[st[top - 1]] >= hi) {
            const H = h[st[--top]], l = top ? st[top - 1] + 1 : 0; if (!H) continue;
            const r0 = j + 1 - H, sc = S[(j + 1) * W1 + i] - S[r0 * W1 + i] - S[(j + 1) * W1 + l] + S[r0 * W1 + l]; if (sc > gb) gb = sc;
            if (sc > ba + 1e-9 || (Math.abs(sc - ba) <= 1e-9 && best)) { const ar = (G.U[i] - G.U[l]) * (G.V[j + 1] - G.V[r0]); if (sc > ba + 1e-9 || ar > bar) { ba = sc; bar = ar; best = [G, l, r0, i, j + 1]; } }
          }
          st[top++] = i;
        }
      }
      G.ub = gb;
    }
    if (!best) break;
    const [G, c0, r0, c1, r1] = best, f = [G.U[c0], G.U[c1], G.V[r0], G.V[r1]];
    if (!G.exact) snap(G, f); // (every wall square to the frame: its cells' edges are on them already)
    if (f[1] - f[0] > 0.3 && f[3] - f[2] > 0.3) { const b = [G, (f[0] + f[1]) / 2, (f[2] + f[3]) / 2, 1, 0, (f[1] - f[0]) / 2, (f[3] - f[2]) / 2], w = toWorld(...b); out.push(b); for (const H of F) mark(H, w); }
    const now = cov0(); if (now - got < crumbs) for (let j = r0; j < r1; j++) for (let i = c0; i < c1; i++) G.dead[j * G.nu + i] = 1; // (on the walls it gains nothing: not that one again)
    got = now;
  }
  if (!out.length) return null;
  // in the world, the building's own frame's first (boundBox); a box inside another one goes
  const all = out.map((b) => toWorld(...b)).sort((a, b) => (Math.abs(b.ux * ux + b.uz * uz) > 0.9999) - (Math.abs(a.ux * ux + a.uz * uz) > 0.9999));
  const pt = (b, l, w) => [b.x + b.ux * l - b.uz * w, b.z + b.uz * l + b.ux * w], inB = (b, p, e = 0) => { const x = p[0] - b.x, y = p[1] - b.z; return Math.abs(x * b.ux + y * b.uz) < b.hl + e && Math.abs(-x * b.uz + y * b.ux) < b.hw + e; };
  const keep = all.filter((b, i) => !all.some((c, j) => j !== i && (c.hl * c.hw > b.hl * b.hw || (c.hl * c.hw === b.hl * b.hw && j < i)) && [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([p, q]) => inB(c, pt(b, b.hl * p, b.hw * q), 0.05))));
  // every edge of every box checked every half metre (the first pass: every metre), and one more than FOOT.out past the
  // walls goes (its faces' own
  // check can give up on a box squeezed between spikes; the first pass's sees its faces' quarters only). Not on a huge
  // one (FOOT.eager): its first pass is quick, a Refiner's pieces (small) are checked
  const fit = fine || (A <= FOOT.eager && !quick) ? keep.filter((b) => { for (const [a0, c0, a1, c1] of [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]]) { const n = Math.min(fine ? 24 : 12, Math.max(1, Math.ceil(Math.hypot((a1 - a0) * b.hl, (c1 - c0) * b.hw) / (fine ? 0.5 : 1)))); for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n, c = c0 + (c1 - c0) * i / n, [x, z] = pt(b, b.hl * a, b.hw * c); if (outD(G0, x * ux + z * uz, -x * uz + z * ux) > FOOT.out + 0.15) return false; } } return true; }) : keep;
  if (!fit.length) return null;
  fit.dropped = keep.length - fit.length; // (footBoxes: a box dropped, its part of the building bare: the fine pass then)
  fit.cov = sampled(G0, pre ? fit.concat(pre) : fit, A); fit.area = A; // (how much of the footprint it covers: footBoxes, a second pass under FOOT.retry)
  return fit;
}
// how much of a footprint (its grid in the building's frame, G0) boxes cover: about 4000 points on rows (1500 on a huge one; at least 0.3 m
// apart: on a small house a 0.7 m grid was off by 4%, 93% for what's 89%), inside the footprint by the row's crossings,
// then in a box or not. (Not the grid's cells: a cell along a slanted wall is counted whole when its middle is in a box.)
function sampled(G, B, A) {
  const s = Math.max(0.3, Math.sqrt(A / (A > FOOT.eager ? 1500 : 4000))), { U, V, rings, fx, fz } = G, xs = [], L = B.map((b) => ({ u: b.x * fx + b.z * fz, v: -b.x * fz + b.z * fx, au: b.ux * fx + b.uz * fz, av: -b.ux * fz + b.uz * fx, hl: b.hl, hw: b.hw }));
  let n = 0, k = 0; WORK.verts += G.nr * Math.ceil((V[V.length - 1] - V[0]) / s);
  for (let v = V[0] + s / 2; v < V[V.length - 1]; v += s) {
    xs.length = 0;
    for (const a of rings) for (let m = a.length / 2, i = 0, j = m - 1; i < m; j = i++) { const av = a[j * 2 + 1], bv = a[i * 2 + 1]; if ((av > v) !== (bv > v)) xs.push(a[j * 2] + (v - av) * (a[i * 2] - a[j * 2]) / (bv - av)); }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let u = U[0] + s / 2 + Math.ceil((xs[i] - U[0] - s / 2) / s) * s; u < xs[i + 1]; u += s) {
      n++; for (const b of L) { const du = u - b.u, dv = v - b.v; if (Math.abs(du * b.au + dv * b.av) < b.hl && Math.abs(-du * b.av + dv * b.au) < b.hw) { k++; break; } }
    }
  }
  return n ? k / n : 1;
}
// the box round boxes in one frame (footBoxes'): the building's whole extent, for what treats it as one
export function boundBox(B) {
  const { ux, uz } = B[0]; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const b of B) for (const [p, q] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const x = b.x + b.ux * b.hl * p - b.uz * b.hw * q, z = b.z + b.uz * b.hl * p + b.ux * b.hw * q, u = x * ux + z * uz, v = -x * uz + z * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  return { x: um * ux - vm * uz, z: um * uz + vm * ux, ux, uz, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2 };
}
// is (x, z) inside one of a building's boxes?
export const inParts = (B, x, z) => { for (const b of B) { const dx = x - b.x, dz = z - b.z; if (Math.abs(dx * b.ux + dz * b.uz) < b.hl && Math.abs(-dx * b.uz + dz * b.ux) < b.hw) return true; } return false; };
// does one box (x, z, ux, uz, hl, hw) fit footprint P, or does a building need footBoxes? Not when every corner and
// every quarter of its edges is within half a metre of its walls and it fills at least 90% of the box (a near-
// rectangle, mapped a little crooked); else it does (an L, a U, a corner cut off a big building: metres of its box
// out over the pavement)
export function irregular(P, A, x, z, ux, uz, hl, hw) {
  if (A < 0.9 * 4 * hl * hw) return true;
  const off = (a, c) => { // (how far the box's point (a, c) (-1..1 along each axis) stands past the walls, squared)
    WORK.verts += P.length;
    const px = x + ux * hl * a - uz * hw * c, pz = z + uz * hl * a + ux * hw * c; if (inside(P, px, pz)) return 0;
    let d2 = Infinity; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const p = P[j], q = P[i], ex = q[0] - p[0], ez = q[1] - p[1], tt = clamp01(((px - p[0]) * ex + (pz - p[1]) * ez) / (ex * ex + ez * ez || 1e-9)), dx = p[0] + ex * tt - px, dz = p[1] + ez * tt - pz; d2 = Math.min(d2, dx * dx + dz * dz); }
    return d2;
  };
  for (let k = 0; k < 16; k++) { // (round the edges, a quarter at a time, every corner: each side from its corner on)
    const t = (k & 3) / 2 - 1, side = k >> 2, a = side === 0 ? -1 : side === 1 ? 1 : side === 2 ? -t : t, c = side === 0 ? -t : side === 1 ? t : side === 2 ? 1 : -1;
    if (off(a, c) > 0.25) return true;
  }
  // a notch between those points (a recess in a long front, a bite out of a corner): a wall corner standing in from
  // every face of the box. Then the face nearest it, every metre for 3 m either side of it
  for (const p of P) {
    const dx = p[0] - x, dz = p[1] - z, u = dx * ux + dz * uz, v = -dx * uz + dz * ux, du = hl - Math.abs(u), dv = hw - Math.abs(v); if (du <= 0.5 || dv <= 0.5) continue;
    for (let k = -3; k <= 3; k++) { // (on the face toward it: the long axis's ends, or its sides)
      const a = du < dv ? Math.sign(u) || 1 : Math.max(-1, Math.min(1, (u + k) / hl)), c = du < dv ? Math.max(-1, Math.min(1, (v + k) / hw)) : Math.sign(v) || 1;
      if (off(a, c) > 0.25) return true;
    }
  }
  return false;
}
// An irregular building's boxes, worked out the first time anything asks for them (a car near it, a blow, a test):
// footBoxes for a whole city at load is seconds; a car or a plane only ever meets a few hundred buildings.
// make() -> the boxes; e.parts is then a plain property.
export function lazyParts(e, make) {
  Object.defineProperty(e, 'parts', { configurable: true, enumerable: true, get() { const B = make(); Object.defineProperty(e, 'parts', { value: B, writable: true, configurable: true, enumerable: true }); return B; } });
}
// a footprint ([[x, z], ...]) kept compact until it's wanted again (lazyParts)
export const packRing = (P) => { const a = new Float32Array(P.length * 2); for (let k = 0; k < P.length; k++) { a[k * 2] = P[k][0]; a[k * 2 + 1] = P[k][1]; } return a; };
export const unpackRing = (a) => { const P = []; for (let k = 0; k < a.length; k += 2) P.push([a[k], a[k + 1]]); return P; };
