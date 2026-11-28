// The baked layout's bridges and tunnels, checked on a chunk's fine mesh (tools/bake/layout-check.mjs, tools/test/layoutcheck.js):
//   ends: where a road stops at a deck or a tube, the step between the surface's physics just before its end and the deck's
//         (or the tube floor's) height there (roads.js draws them at it), per end, by kind
//   rim:  a portal's lip (its opening, rules.js) has every rim point within what covers it: the tube's mouth (below its crown, the lintel over it)
//         at the front, the headwall's lintel behind, the headwall (its wings PORTAL_FOOT deep, up to its top: rules.js portalsOf) beside the mouth, the floor and
//         its sill (SILL deep) across the mouth (no gap between the surface and the tube)
//   trench: a portal's approach in a walled trench (rules.js trenchOf): (wall) every point of its walls' strips (openings) within
//         its wall's height and thickness (rules.js trenchWalls, from the physics either side); (open) the surfaces either side
//         reach the wall, no hole between from above (physics just inside and just outside the strip, and the wall thicker than
//         the strip); (top) the wall's top no more than WALL_LIP (and 10 cm) over the higher surface beside it, every 0.1 m; (step) along the approach's carriageway through the trench, no step for a vehicle: no kink in its physics less the approach's own height, every STEP_D m
import { physAt } from '../../src/layout/mesh.js';
import { KIND } from '../../src/layout/format.js';
import { TUBE_SIDE, SLAB_MAX, KERB, portalsOf, portalUV, trenchWalls, wallTop, edges, WALL_STEP, WALL_WIN, inWall, inWallAt, otherBox, onRun, WALL_LIP, TUBE_H, PORTAL_T, PORTAL_FOOT, SILL, FLUSH, TRENCH_W } from '../../src/layout/rules.js';

// L: a decoded chunk; m: its fine mesh; ix: physIndex(L, m); lipIdx: the lip triangles' corners (vertex indices)
export function offChecks(L, m, ix, lipIdx, opts = {}) {
  // where a road stops at a deck or a tube: the surface's physics 5 mm before its end against the deck's (or the tube
  // floor's) height there (roads.js draws them at it): the step
  const badAt = [], P = m.pos, inC = (x, z, e = 0.1) => x > L.x0 + e && z > L.z0 + e && x < L.x0 + L.size - e && z < L.z0 + L.size - e, offs = L.net.runs.filter((q) => q.off), ends = { deck: [], tube: [], railOver: [] };
  const allPortals = portalsOf(L.net.runs), inLip = (x, z) => allPortals.some((pt) => { const [u, w] = portalUV(pt, x, z); return u > -0.01 && u < PORTAL_T / 2 + 0.01 && Math.abs(w) < pt.W; }); // (a deck ending in a portal's lip: it meets the tube there, no surface between; a railway ending in another's mouth: rules.js portalsOf, one portal for both)
  for (const rd of L.net.runs) { if (rd.off) continue; const n = rd.h.length; for (const [c, i, j] of [[rd.cutA, 0, 1], [rd.cutB, n - 1, n - 2]]) { if (!c || n < 2) continue; const x = rd.pts[i * 2], z = rd.pts[i * 2 + 1]; if (!inC(x, z) || ((c === 'deck' || rd.kind === 'rail') && inLip(x, z))) continue;
    let y = rd.h[i]; for (const o of offs) { const k = o.h.length - 1; if (Math.hypot(o.pts[0] - x, o.pts[1] - z) < 0.02) { y = o.h[0]; break; } if (Math.hypot(o.pts[k * 2] - x, o.pts[k * 2 + 1] - z) < 0.02) { y = o.h[k]; break; } }
    const dx = rd.pts[j * 2] - x, dz = rd.pts[j * 2 + 1] - z, l = Math.hypot(dx, dz) || 1, o4 = [0, 0, 0, 0], hp = physAt(L, m, ix, x + dx / l * 0.005, z + dz / l * 0.005, o4); const gap = hp === hp ? Math.abs(hp - y) : 99;
    if (rd.kind === 'rail' && hp === hp && m.tk[o4[0]] !== KIND.ballast) { ends.railOver.push(gap); continue; } // (a railway's deck ending over a road's carriageway (OpenStreetMap's bridge shorter than the real one): the road's surface there, not the rail's bed: counted on its own)
    ends[c].push(gap); if (gap >= 0.02) badAt.push([c, +x.toFixed(1), +z.toFixed(1), +gap.toFixed(3)]); } }
  // a portal's opening: every point of its lip's rim within what covers it (the tube's mouth below the crown at the
  // front, the headwall's lintel behind; beside the mouth, the headwall), so no gap between the surface and the tube
  let rimBad = 0, rimN = 0, noLip = 0; const portals = portalsOf(L.net.runs).filter((pt) => inC(pt.x, pt.z, pt.W + 1));
  for (const pt of portals) { let seen = 0; for (let q = 0; q < lipIdx.length; q++) { const v = lipIdx[q], [u, w] = portalUV(pt, P[v * 3], P[v * 3 + 2]); if (u < -0.05 || u > PORTAL_T / 2 + 0.05 || Math.abs(w) > pt.W + 0.05) continue; seen++; rimN++;
    const y = P[v * 3 + 1] - pt.y, mouth = Math.abs(w) <= pt.hwT + 0.01, [lo, hi] = !mouth ? [-PORTAL_FOOT, pt.top] : u < PORTAL_T / 4 ? [-SILL, pt.top] : [TUBE_H, pt.top], flush = mouth && y >= -SILL - 0.01 && y <= FLUSH + 0.01; if (!flush && (y < lo - 0.01 || y > hi + 0.01)) { rimBad++; if (rimBad <= 3) badAt.push(['rim', +pt.x.toFixed(1), +pt.z.toFixed(1), +u.toFixed(2), +w.toFixed(2), +y.toFixed(2)]); } }
    if (!seen) { // (no opening: the lip all under another carriageway, a twin's merging with it. Fine if the surface across the headwall's back is what covers it there, as a rim's would be)
      let ok = true; for (let f = -1; f <= 1.001; f += 0.125) { const w = pt.W * f, x = pt.x + pt.dx * PORTAL_T / 2 - pt.dz * w, z = pt.z + pt.dz * PORTAL_T / 2 + pt.dx * w, h = physAt(L, m, ix, x, z), y = h - pt.y;
        if (!(h === h)) { ok = false; break; } if (Math.abs(w) <= pt.hwT ? !(y >= -SILL - 0.01 && y <= FLUSH + 0.01) && !(y >= TUBE_H - 0.01 && y <= pt.top + 0.01) : !(y >= -PORTAL_FOOT - 0.01 && y <= pt.top + 0.01)) { ok = false; break; } }
      if (!ok) noLip++; } }
  const tr = trenchChecks(L, m, ix, lipIdx, portals, badAt, allPortals, opts.walls || trenchWalls, opts.rules);
  const sl = opts.rules ? slabCheck(L, m, opts.rules, badAt) : { slabN: 0, slabBad: 0, slabMax: 0 };
  return { ends, badAt, rimBad, rimN, noLip, portals: portals.length, ...tr, ...sl };
}
// (slab) nothing drawn over a tube stands above what's there without it: every surface point over a tube's footprint (its
// walls' width and SLAB_PAD more, between its ends) no more than SLAB_MAX over the higher of the natural ground and the nearest
// street's pavement (its carriageway and a kerb) within SLAB_NEAR m, and the surface there as it'd be without the tube (a lot, a
// road's bank: R.unlifted; the streets' surface: R.untrenched): what the tube adds over them
export const SLAB_PAD = 2, SLAB_NEAR = 40; // (m: a city's lots are at their street's pavement, rules.js CITY_REACH)
function slabCheck(L, m, R, badAt) {
  const P = m.pos, I = m.idx, tubes = L.net.runs.filter((r) => r.off === 'tube'), seen = new Uint8Array(P.length / 3); let slabN = 0, slabBad = 0, slabMax = 0; if (!tubes.length) return { slabN, slabBad, slabMax };
  const over = (x, z) => tubes.some((t) => { for (let s = 0; s + 1 < t.h.length; s++) { const ax = t.pts[s * 2], az = t.pts[s * 2 + 1], dx = t.pts[s * 2 + 2] - ax, dz = t.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9, f = ((x - ax) * dx + (z - az) * dz) / L2; if (f < 0 || f > 1) continue; if (Math.hypot(x - ax - dx * f, z - az - dz * f) <= t.hw + TUBE_SIDE + SLAB_PAD) return true; } return false; });
  for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] === KIND.lip) continue; for (let a = 0; a < 3; a++) { const v = I[q * 3 + a]; if (seen[v]) continue; seen[v] = 1; const x = P[v * 3], z = P[v * 3 + 2];
    if (x <= L.x0 || z <= L.z0 || x >= L.x0 + L.size || z >= L.z0 + L.size || !over(x, z)) continue; slabN++;
    const n = R.nearest(x, z, (r) => !r.minor && !r.off), ref = Math.max(R.natural(x, z), R.unlifted(x, z), R.untrenched(x, z, KIND.tarmac), n && n.d <= SLAB_NEAR ? R.base(n.px, n.pz, KIND.tarmac) + KERB : -Infinity), d = P[v * 3 + 1] - ref; slabMax = Math.max(slabMax, d);
    if (d > SLAB_MAX + 0.01) { slabBad++; if (slabBad <= 3) badAt.push(['slab', +x.toFixed(1), +z.toFixed(1), +d.toFixed(2)]); } } }
  return { slabN, slabBad, slabMax };
}
export const STEP_MAX = 0.05, STEP_D = 0.05, TRENCH_STEP = 1; // (m: how far a sample along the trench's floor (its physics less the approach's own height) leaves the line through the two before it, STEP_D apart: a riser's edge, a slope changing by 100% within 5 cm; a grade, however steep, is the solve's or the streets' as they were)
function trenchChecks(L, m, ix, lipIdx, portals, badAt, allPortals, wallsOf, R) {
  const P = m.pos, at = (x, z) => physAt(L, m, ix, x, z), xz = (p, u, v) => [p.x + p.dx * u - p.dz * v, p.z + p.dz * u + p.dx * v], inC = (x, z) => x > L.x0 && z > L.z0 && x < L.x0 + L.size && z < L.z0 + L.size;
  let trenches = 0, wallN = 0, wallBad = 0, openN = 0, openBad = 0, stepN = 0, stepBad = 0, stepMax = 0, topN = 0, topBad = 0, topMax = 0; const seen = new Set();
  const AW = allPortals.filter((q) => q.tr).map((q) => [q, wallsOf(q, at, allPortals)]); /* (every trench's walls about: two trenches' strips can cross, either wall covers) */
  const covered = (x, z, y) => AW.some(([q, W]) => { const [u, w] = portalUV(q, x, z); return W.some((b) => Math.sign(b.v) === Math.sign(w) && u >= b.u0 - 0.01 && u <= b.u1 + 0.01 && Math.abs(Math.abs(w) - Math.abs(b.v)) <= b.t + 0.01 && y >= b.y0 - 0.01 && y <= wallTop(b, u) + 0.01); });
  const inHead = (x, z, y, m = 0.05) => allPortals.some((q) => { const [u, w] = portalUV(q, x, z); return Math.abs(u) <= PORTAL_T / 2 + m && Math.abs(w) <= q.W + 0.05 && (y == null || (y - q.y >= -PORTAL_FOOT - 0.01 && y - q.y <= q.top + 0.01)); });
  for (const p of portals) { if (!p.tr) continue; trenches++; const W = AW.find(([q]) => q.x === p.x && q.z === p.z)[1];
    // (wall) every strip point within a wall
    for (const v of lipIdx) { if (seen.has(v)) continue; const x = P[v * 3], z = P[v * 3 + 2], [u, w] = portalUV(p, x, z); if (!inWall(p, u, w) || !inWallAt(allPortals, x, z)) continue; seen.add(v); wallN++; const y = P[v * 3 + 1];
      const wing = inHead(x, z, y); /* (in a headwall (its wing, or another portal's beside): it covers it) */
      if (!wing && !covered(x, z, y)) { wallBad++; if (wallBad <= 3) badAt.push(['wall', +x.toFixed(2), +z.toFixed(2), +u.toFixed(2), +w.toFixed(2), +y.toFixed(2)]); } }
    // (open) the surfaces either side reach the wall; (top) and it stands no more than its lip over the higher of them
    for (const sd of [-1, 1]) for (let u = p.tr.u0 + 0.05; u < p.tr.u1 - 0.05; u += 0.1) { const b = W.find((q) => q.sd === sd && u >= q.u0 && u <= q.u1); const [cx, cz] = xz(p, u, sd * (p.hwT + TRENCH_W / 2)); if (!inC(cx, cz) || otherBox(allPortals, p, cx, cz)) continue;
      const H = [p.hwT - 0.05, p.hwT + TRENCH_W + 0.05].map((o) => { const [x, z] = xz(p, u, sd * o); return at(x, z); });
      const E = !inHead(cx, cz, null, WALL_STEP) ? edges(p, sd, u, at, WALL_WIN + WALL_STEP / 2) : null; /* (by the portal: in the headwall, which stands higher; the surfaces within reach of the wall's two samples about u) */ if (b && E) { topN++; const d = wallTop(b, u) - Math.max(E.inHi, E.outHi); /* (over the highest surface beside it within WALL_WIN: a fin stands metres over it) */ topMax = Math.max(topMax, d); if (d > WALL_LIP + 0.1) { topBad++; if (topBad <= 3) badAt.push(['top', +cx.toFixed(1), +cz.toFixed(1), +u.toFixed(2), +d.toFixed(2)]); } }
      if (u > -0.5 && u < PORTAL_T / 2 + 1.5 || (u - p.tr.u0) % 0.5 > 0.1 || inHead(cx, cz, null, WALL_STEP)) continue; /* (by a headwall: it covers it; open: every half metre) */
      for (const [k, o] of [[0, p.hwT - 0.05], [1, p.hwT + TRENCH_W + 0.05]]) { const [x, z] = xz(p, u, sd * o), h = H[k]; if (!(h === h) && allPortals.some((q) => { const [qu, qv] = portalUV(q, x, z); return (q.tr && (q.x !== p.x || q.z !== p.z) && inWall(q, qu, qv)) || (qu > -0.05 && qu < PORTAL_T / 2 + 0.05 && Math.abs(qv) <= q.W); })) continue; if (!b && ([-WALL_STEP, WALL_STEP].some((du) => otherBox(allPortals, p, ...xz(p, u + du, sd * (p.hwT + TRENCH_W / 2)))) || at(cx, cz) === at(cx, cz))) continue; /* (no strip there: another road's carriageway) */ /* (a wall's segment left out by another approach's box) */ openN++; /* (in another trench's wall or a portal's lip: what covers it there) */
        if (!(h === h) || !b || b.t < TRENCH_W / 2 || h < b.y0 || h > wallTop(b, u) + 0.01) { openBad++; if (openBad <= 3) badAt.push(['open', +x.toFixed(1), +z.toFixed(1), +u.toFixed(2), sd * o, h === h ? +h.toFixed(2) : null]); } } }
    // (step) along the approach's carriageway through the trench
    // (R: the chunk's rules: a kink no more than the streets' surface without the trench bends over one mesh step there (where the floor fades from it) isn't the trench's)
    const ua = p.tr.u0 + (R ? R.trenchFade(p) : p.tr.fade) / 2; /* (from halfway through its fade: before, the streets' surface as it was, mostly) */
    for (let f = -0.9; f < 0.95; f += 0.15) { let p1 = null, p2 = null; for (let u = ua; u <= -0.05; u += STEP_D) { const [x, z] = xz(p, u, f * p.hw); if (!inC(x, z) || otherBox(allPortals, p, x, z)) { p1 = p2 = null; continue; } const h0 = at(x, z); if (!(h0 === h0)) { p1 = p2 = null; continue; } const own = onRun(p.tr.r, x, z), h = h0 - own, hn = R ? R.untrenched(x, z, KIND.tarmac) - own : 0; /* (against the approach's own profile) */
      if (p2 != null) { stepN++; const d = Math.abs(h - 2 * p1 + p2), un = (du) => { const [a, b] = xz(p, u - STEP_D + du, f * p.hw); return R.untrenched(a, b, KIND.tarmac) - onRun(p.tr.r, a, b); }, dn = R && d > STEP_MAX ? Math.abs(un(TRENCH_STEP) - 2 * un(0) + un(-TRENCH_STEP)) * STEP_D / TRENCH_STEP : 0; /* (the streets' own bend over a mesh step (mesh.js TRENCH_STEP), as one edge would take it) */ stepMax = Math.max(stepMax, d); if (d > STEP_MAX && d > dn + STEP_MAX) { stepBad++; if (stepBad <= 3) badAt.push(['step', +x.toFixed(1), +z.toFixed(1), +u.toFixed(2), +d.toFixed(3)]); } } p2 = p1; p1 = h; } } }
  return { trenches, wallN, wallBad, openN, openBad, stepN, stepBad, stepMax, topN, topBad, topMax };
}
