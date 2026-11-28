// Retaining walls (#294): where the ground beside a road steps instead of sloping, a near-vertical wall stands on the
// step. Two places it happens:
//   the bank cap (outside a city): a bank that hasn't met the natural ground within rules.js BANK_MAX stops there (the
//                 ground steps from the bank's end to the natural ground: a valley wall's switchbacks, a road on a cliff);
//   a road's edge in a city: an expressway in a trench, its lots at the streets' height above it (cut walls along it),
//                 or up on a fill above them.
// Worked out from the chunk's network and the rules alone (nothing stored: the same code at the bake and in the game),
// on the fine level: mesh.js puts a point just either side of each wall station, so the surface's step is a sliver
// inside the wall; runtime.js draws the walls (concrete or stone by region) and gives them to the cars as boxes, as a
// building's (World.wallBoxes). The road and ground surfaces' heights are the rules' as before.
//
// wallsOf(L, R, g, all: every segment, those whose middle is in the chunk beside too) -> { st: [stations], seg: Float32Array (SEG_N per segment), n, len (m) }
//   a station: { x, z (on the step), nx, nz (away from the road), yIn, yOut (the surface where it meets the wall's inner and outer face), hi, lo (and the highest
//                and lowest of those and the surfaces just either side of the step),
//                o0, o1 (the wall's faces along n from x, z), kind (0 the bank cap, 1 a road's edge) }
//   tall: the bank caps stepping more than WALL_TALL, left without a wall ({ x, z, h }, in the chunk, one per WALL_STEP square)
//   a segment: ax, az, bx, bz, nx, nz, aTop, aBot, bTop, bBot, o0, o1, kind
import { KIND } from './format.js';
import { BANK_MAX, vergeW } from './rules.js';

export const WALL_STEP = 2, WALL_MIN = 0.3, WALL_MIN_CITY = 1, WALL_TALL = 8, WALL_T = 0.5, PARAPET = 1, PARAPET_DROP = 2, WALL_EPS = 0.05, WALL_FOOT = 0.5, SEG_N = 13;
const CAP_WIN = 3, EDGE_WIN = 0, END_TOL = 0.15, CITY_STEP = 4, PEEK = 0.3, JOIN = 2.5 * WALL_STEP, PAVED = new Set([KIND.tarmac, KIND.kerb, KIND.pave, KIND.verge, KIND.ballast, KIND.alley, KIND.pavers, KIND.gravel, KIND.lip]);
// the surface the rules give at (x, z): a paved region's drawn height, else the ground
const surf = (R, x, z) => { const k = R.region(x, z); return k === KIND.ground || k === KIND.bank ? R.ground(x, z) : R.drawn(x, z, k); };
// whether a wall may stand at (x, z): not on any way's surface (another carriageway, a pavement, a verge, a railway's bed)
export const wallFree = (R, x, z) => !PAVED.has(R.region(x, z));

export function wallsOf(L, R, g, all = false) {
  const st = [], tall = [], x0 = L.x0, z0 = L.z0, x1 = L.x0 + L.size, z1 = L.z0 + L.size;
  for (const r of L.net.runs) {
    if (r.off || r.kind === 'rail' || (L.city && r.kind !== 'highway')) continue; const n = r.h.length; if (n < 2) continue; /* (in a city only an expressway's edge is walled) */
    const side = r.hw + (r.pave || vergeW(r)), edge = L.city && r.kind === 'highway' && !r.pave, ik = vergeW(r) ? KIND.verge : KIND.tarmac; /* (a city's expressway: its lots are at the streets' height beside it, in a trench or up on a fill; a street with a pavement meets its lots at the pavement's top) */
    /* (a station from a sample: the step at the bank's cap, or a city street's edge) */
    let lastTall = false; const at = ([cx, cz, h, nx, nz]) => { let hit = null; const ox = cx + nx * (side + BANK_MAX), oz = cz + nz * (side + BANK_MAX);
      /* (the bank cap, outside a city (a city's ground is its lots; where they meet a bank's cap it steps a few decimetres:
         a seam in the city's rules, not a wall's place): only where the ground steps within PEEK of it (each side carried on to it by its slope, as stepAt)) */
      if (!L.city && ox > x0 - 4 && oz > z0 - 4 && ox < x1 + 4 && oz < z1 + 4 && (stepAt((d) => R.ground(ox + nx * d, oz + nz * d), 0, PEEK)) > WALL_MIN - 0.1) hit = find(R, cx, cz, nx, nz, side + BANK_MAX, CAP_WIN, 0);
      if (!hit && edge) { const ex = cx + nx * side, ez = cz + nz * side; /* (a city expressway's edge: only where the ground beside it is off the road's height) */ if (ex > x0 - 2 && ez > z0 - 2 && ex < x1 + 2 && ez < z1 + 2 && Math.abs(R.ground(ex + nx * PEEK, ez + nz * PEEK) - h) > WALL_MIN_CITY) hit = find(R, cx, cz, nx, nz, side, EDGE_WIN, 1, ik); }
      if (hit?.tall) { tall.push(hit); lastTall = true; return null; } lastTall = false; return hit; };
    /* (where a wall starts or stops between two samples: bisected along the road to END_TOL, the station on the wall's side) */
    const end = (p, q, hp) => { let a = p, b = q, best = null; const mix = (u, v) => { const m = u.map((x, i) => (x + v[i]) / 2), l = Math.hypot(m[3], m[4]) || 1; m[3] /= l; m[4] /= l; return m; };
      while (Math.hypot(a[0] - b[0], a[1] - b[1]) > END_TOL) { const m = mix(a, b), h = at(m); if (!!h === !!hp) { a = m; if (h) best = h; } else { b = m; if (h) best = h; } }
      return best; };
    for (const sg of [1, -1]) { let chain = null, prev = null, prevHit = null;
      const push = (hit) => { if (chain && Math.hypot(hit.x - chain.x, hit.z - chain.z) <= JOIN && chain.kind === hit.kind) hit.prev = chain; chain = hit; st.push(hit); };
      let prevTall = false;
      for (const p of samples(r, sg, L.city ? side : side + BANK_MAX, L.city ? CITY_STEP : WALL_STEP)) { const hit = at(p), isTall = lastTall;
        if (prev && (isTall || prevTall) && (hit ? 2 : isTall ? 1 : 0) !== (prevHit ? 2 : prevTall ? 1 : 0)) { /* (next to a step too tall for a wall: the stretch between looked along every 0.5 m, every END_TOL beside a wall) */
          const L2 = Math.hypot(p[0] - prev[0], p[1] - prev[1]), k = Math.max(1, Math.ceil(L2 / (hit || prevHit ? END_TOL : 0.5))); for (let i = 1; i < k; i++) { const t = i / k, m = prev.map((v, j) => v + (p[j] - v) * t), l = Math.hypot(m[3], m[4]) || 1; m[3] /= l; m[4] /= l; const e = at(m); if (e) push(e); } }
        else if (prev && !!hit !== !!prevHit) { const e = end(prev, p, prevHit); if (e && e.kind === (hit || prevHit).kind) push(e); }
        if (hit) push(hit); /* (a wall picked up again within JOIN of where it stopped (the inside of a hairpin, where its two legs' caps cross) is joined across) */
        prev = p; prevHit = hit; prevTall = isTall; } }
  }
  // (a wall's end joined to another's start within JOIN, facing much the same way (not back to back): a road's way split there (OSM's ways), or
  // two roads' caps meeting at a corner)
  const has = new Set(st.map((s) => s.prev).filter(Boolean)), tails = new Map(), K = (x, z) => Math.floor(x / 10) + ',' + Math.floor(z / 10);
  for (const s of st) if (!has.has(s)) { const k = K(s.x, s.z); (tails.get(k) || tails.set(k, []).get(k)).push(s); }
  for (const h of st) { if (h.prev) continue; let best = null, bd = JOIN; const i0 = Math.floor(h.x / 10), j0 = Math.floor(h.z / 10);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const t of tails.get(i + ',' + j) || []) { if (t === h || t.kind !== h.kind || t.nx * h.nx + t.nz * h.nz < -0.2) continue; let c = t; while (c && c !== h) c = c.prev; if (c === h) continue; const d = Math.hypot(t.x - h.x, t.z - h.z); if (d < bd) { bd = d; best = t; } }
    if (best) { h.prev = best; const L2 = tails.get(K(best.x, best.z)); L2.splice(L2.indexOf(best), 1); } }
  // segments: each joined pair of stations, kept by the chunk its middle is in, cut where it would stand on a paved surface
  const seg = []; let len = 0;
  for (const b of st) { const a = b.prev; if (!a) continue; const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2; if (!all && (mx < x0 || mz < z0 || mx >= x1 || mz >= z1)) continue;
    const l = Math.hypot(b.x - a.x, b.z - a.z), m = Math.max(2, Math.ceil(l / 0.5)); let ok = true;
    const nx0 = a.nx + b.nx, nz0 = a.nz + b.nz, nl = Math.hypot(nx0, nz0) || 1, nx = nx0 / nl, nz = nz0 / nl, o0 = Math.min(a.o0, b.o0), o1 = Math.max(a.o1, b.o1);
    for (let i = 0; i <= m && ok; i++) { const px = a.x + (b.x - a.x) * i / m, pz = a.z + (b.z - a.z) * i / m; for (const o of b.kind ? [(o0 + o1) / 2, o1 - 0.02] : [o0 + 0.02, (o0 + o1) / 2, o1 - 0.02]) if (!wallFree(R, px + nx * o, pz + nz * o)) { ok = false; break; } }
    if (!ok) continue;
    /* (its top and foot straight between its ends, raised or lowered so the surfaces at its faces never stand over its top
       (and parapet) nor under its foot between them: a steep bank's end is rough along the road) */
    let tA = top(a), tB = top(b), fA = a.lo - WALL_FOOT, fB = b.lo - WALL_FOOT, up = 0, dn = 0; const fi = b.kind ? -WALL_EPS : o0, Si = b.kind ? (x, z) => R.drawn(x, z, b.ik) : R.ground, T = [];
    for (let i = 0; i <= m; i++) { const t = i / m, px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t, s = { yIn: Si(px + nx * fi, pz + nz * fi), yOut: R.ground(px + nx * o1, pz + nz * o1) }, ts = top(s); T.push(ts);
      up = Math.max(up, ts - (tA + (tB - tA) * t)); dn = Math.max(dn, fA + (fB - fA) * t - (Math.min(s.yIn, s.yOut) - WALL_FOOT)); }
    /* (where the surfaces along it vary more than its parapet, a straight top would stand over them: a piece per sample instead) */
    if (T.some((ts, i) => tA + up + (tB - tA) * i / m - ts > PARAPET + 0.1)) { for (let i = 0; i < m; i++) { const t0 = i / m, t1 = (i + 1) / m, y = Math.max(T[i], T[i + 1]);
        seg.push(a.x + (b.x - a.x) * t0, a.z + (b.z - a.z) * t0, a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1, nx, nz, y, fA - dn + (fB - fA) * t0, y, fA - dn + (fB - fA) * t1, o0, o1, b.kind); }
      len += l; continue; }
    seg.push(a.x, a.z, b.x, b.z, nx, nz, tA + up, fA - dn, tB + up, fB - dn, o0, o1, b.kind); len += l; }
  return { st, seg: Float32Array.from(seg), n: seg.length / SEG_N, len, tall: [...new Map(tall.filter((t) => t.x >= x0 && t.z >= z0 && t.x < x1 && t.z < z1).map((t) => [Math.round(t.x / WALL_STEP) + ',' + Math.round(t.z / WALL_STEP), t])).values()] };
}
// the points along road r's side sg (1 left, -1 right) a wall is looked for from: every step m along each segment (a city's
// expressways: CITY_STEP, the ends bisected as everywhere),
// its normal; round a bend's outside (the normal turning forward), a fan of normals at the bend's point, WALL_STEP m apart at reach m out
// -> [[cx, cz, h, nx, nz], ...]
export function samples(r, sg, reach, step = WALL_STEP) {
  const out = [], n = r.h.length; let pn = null, pd = null; /* (pn, pd: the segment before's normal and direction) */
  for (let s = 0; s + 1 < n; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-3) continue;
    const nx = (-dz / l) * sg, nz = (dx / l) * sg, k = Math.max(1, Math.round(l / step));
    if (pn && (nx - pn[0]) * pd[0] + (nz - pn[1]) * pd[1] > 0) { const an = Math.atan2(pn[0] * nz - pn[1] * nx, pn[0] * nx + pn[1] * nz), f = Math.ceil(Math.abs(an) * reach / step);
      for (let i = 1; i < f; i++) { const c = Math.cos(an * i / f), sn = Math.sin(an * i / f); out.push([ax, az, r.h[s], pn[0] * c - pn[1] * sn, pn[0] * sn + pn[1] * c]); } }
    for (let q = 0; q <= k; q++) { const t = q / k; out.push([ax + dx * t, az + dz * t, r.h[s] + (r.h[s + 1] - r.h[s]) * t, nx, nz]); }
    pn = [nx, nz]; pd = [dx / l, dz / l]; }
  return out;
}
// the step in a surface S(d) along a line at d (within e of it): each side's surface carried on to d (by its slope over e), apart
export const stepAt = (S, d, e = WALL_EPS) => { const a1 = S(d - e), b1 = S(d + e); return Math.abs(2 * a1 - S(d - 2 * e) - (2 * b1 - S(d + 2 * e))); };
// a wall's top: the higher surface, and a parapet over a fill (the road's side higher) where the drop is PARAPET_DROP or more
export const top = (s) => (s.hi ?? Math.max(s.yIn, s.yOut)) + (s.yIn > s.yOut && s.yIn - s.yOut >= PARAPET_DROP ? PARAPET : 0);
// the step along (nx, nz) from the road's centre (cx, cz), within win of d0 m out: where the surface jumps by more than
// WALL_MIN (bisected to 5 cm), or null. kind 1 (a road's edge): the wall stands outside the edge, off the road
export function find(R, cx, cz, nx, nz, d0, win, kind, ik = KIND.verge) {
  /* (the surface: at a bank's cap the ground both sides (a paved surface there is checked once, below); at a road's edge
     its own paved region's inside it (ik), the ground outside) */
  const S = kind ? (d) => (d < d0 ? R.drawn(cx + nx * d, cz + nz * d, ik) : R.ground(cx + nx * d, cz + nz * d)) : (d) => R.ground(cx + nx * d, cz + nz * d); let d = d0;
  if (kind) { const yIn = S(d0 - WALL_EPS), yOut = S(d0 + WALL_EPS); if (Math.abs(yIn - yOut) < WALL_MIN) return null; }
  else if (stepAt(S, d0) < WALL_MIN) { /* (the step where it should be, square to the road: else looked for about it, bisected to 5 cm) */
    d = null; for (const w of [0.5, win]) { let a = d0 - w, b = d0 + w, ya = S(a), yb = S(b); if (Math.abs(ya - yb) < WALL_MIN) continue;
      while (b - a > 2 * WALL_EPS) { const m = (a + b) / 2, ym = S(m); if (Math.abs(ym - ya) >= Math.abs(yb - ym)) { b = m; yb = ym; } else { a = m; ya = ym; } }
      if (stepAt(S, (a + b) / 2) >= WALL_MIN) { d = (a + b) / 2; break; } }
    if (d == null) return null; }
  const o0 = kind ? -0.02 : -WALL_T / 2, o1 = kind ? WALL_T : WALL_T / 2; if (!kind && stepAt(S, d) < WALL_MIN) return null; /* (a steep slope, no step) */
  const yIn = kind ? surf(R, cx + nx * (d - WALL_EPS), cz + nz * (d - WALL_EPS)) : S(d + o0), yOut = S(d + o1); /* (the surfaces where they meet the wall's faces; inside a road's edge, whichever paved surface is there) */
  if (kind && Math.abs(yIn - yOut) < WALL_MIN_CITY) return null; /* (in a city only a step of a metre or more: a lower one is a kerb's or a lot's) */
  const x = cx + nx * d, z = cz + nz * d;
  if (kind === 0 && !(wallFree(R, x - nx * WALL_EPS, z - nz * WALL_EPS) && wallFree(R, x + nx * WALL_EPS, z + nz * WALL_EPS))) return null;
  if (kind === 1 && !(wallFree(R, x + nx * WALL_EPS, z + nz * WALL_EPS) && wallFree(R, x + nx * (WALL_T + 0.5), z + nz * (WALL_T + 0.5)))) return null; /* (another way's surface beside the edge, or a median's strip too narrow for a wall: no wall) */
  const yi = kind ? yIn : S(d - WALL_EPS), yo = S(d + WALL_EPS); /* (and just either side of the step: where a lot's edge meets the wall's end, the two differ) */
  const hi = Math.max(yIn, yOut, yi, yo), lo = Math.min(yIn, yOut, yi, yo);
  if (!kind && stepAt(S, d) > WALL_TALL) return { tall: true, x, z, h: stepAt(S, d) }; /* (a bank's cap stepping more than WALL_TALL: no wall (a gallery's, a tunnel's or the height data's), counted) */
  return { x, z, nx, nz, yIn, yOut, hi, lo, o0, o1, kind, ik, prev: null };
}
