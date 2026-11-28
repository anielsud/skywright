// The baked layout's bridges and tunnels, checked on a chunk's fine mesh (tools/bake/layout-check.mjs, tools/test/layoutcheck.js):
//   ends: where a road stops at a deck or a tube, the step between the surface's physics just before its end and the deck's
//         (or the tube floor's) height there (roads.js draws them at it), per end, by kind
//   rim:  a portal's lip (its opening, rules.js) has every rim point within what covers it: the tube's mouth (below its crown, the lintel over it)
//         at the front, the headwall's lintel behind, the headwall (its wings PORTAL_FOOT deep, up to its top: rules.js portalsOf) beside the mouth, the floor and
//         its sill (SILL deep) across the mouth (no gap between the surface and the tube)
import { physAt } from '../../src/layout/mesh.js';
import { KIND } from '../../src/layout/format.js';
import { portalsOf, portalUV, TUBE_H, TUBE_SIDE, KERB, SLAB_MAX, PORTAL_T, PORTAL_FOOT, SILL, FLUSH } from '../../src/layout/rules.js';

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
  const tc = opts.rules ? tubeChecks(L, m, opts.rules, badAt) : { slabN: 0, slabBad: 0, slabMax: 0, coverN: 0, coverBad: 0, coverMin: Infinity };
  return { ends, badAt, rimBad, rimN, noLip, portals: portals.length, ...tc };
}
// over a tunnel's tube (tubes.js: its road dives, rules.js: nothing holds the ground over it):
//   slab:  every surface point over a tube (its walls' width and SLAB_PAD more, between its ends) no more than SLAB_MAX over the
//          highest of the natural ground, the nearest street's pavement within SLAB_NEAR m, and the ground as it'd be without
//          the tube (a lot, a road's bank: R.unlifted)
//   cover: every station of a tube in the chunk has its roof COVER_MIN m or more under the natural ground or the street over it
export const SLAB_PAD = 2, SLAB_NEAR = 40, COVER_MIN = 0.4;
function tubeChecks(L, m, R, badAt) {
  const P = m.pos, I = m.idx, tubes = L.net.runs.filter((r) => r.off === 'tube'), inC = (x, z) => x > L.x0 && z > L.z0 && x < L.x0 + L.size && z < L.z0 + L.size, out = { slabN: 0, slabBad: 0, slabMax: 0, coverN: 0, coverBad: 0, coverMin: Infinity };
  if (!tubes.length) return out;
  const over = (x, z) => tubes.some((t) => { for (let s = 0; s + 1 < t.h.length; s++) { const ax = t.pts[s * 2], az = t.pts[s * 2 + 1], dx = t.pts[s * 2 + 2] - ax, dz = t.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9, f = ((x - ax) * dx + (z - az) * dz) / L2; if (f < 0 || f > 1) continue; if (Math.hypot(x - ax - dx * f, z - az - dz * f) <= t.hw + TUBE_SIDE + SLAB_PAD) return true; } return false; });
  const seen = new Uint8Array(P.length / 3);
  for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] === KIND.lip) continue; for (let a = 0; a < 3; a++) { const v = I[q * 3 + a]; if (seen[v]) continue; seen[v] = 1; const x = P[v * 3], z = P[v * 3 + 2]; if (!inC(x, z) || !over(x, z)) continue; out.slabN++;
    const n = R.nearest(x, z, (r) => !r.minor && !r.off), ref = Math.max(R.natural(x, z), R.unlifted(x, z), n && n.d <= SLAB_NEAR ? R.base(n.px, n.pz, KIND.tarmac) + KERB : -Infinity), d = P[v * 3 + 1] - ref; out.slabMax = Math.max(out.slabMax, d);
    if (d > SLAB_MAX + 0.01) { out.slabBad++; if (out.slabBad <= 3) badAt.push(['slab', +x.toFixed(1), +z.toFixed(1), +d.toFixed(2)]); } } }
  // (cover: against the natural ground, or a street at grade whose carriageway covers the point: its surface there)
  for (const t of tubes) for (let k = 0; k < t.h.length; k++) { const x = t.pts[k * 2], z = t.pts[k * 2 + 1]; if (!inC(x, z)) continue; out.coverN++;
    const n = R.nearest(x, z, (r) => !r.off), st = n && n.d <= 0 ? R.base(x, z, KIND.tarmac) : -Infinity, c = Math.max(R.natural(x, z), st) - (t.h[k] + TUBE_H); out.coverMin = Math.min(out.coverMin, c);
    if (c < COVER_MIN) { out.coverBad++; if (out.coverBad <= 3) badAt.push(['cover', +x.toFixed(1), +z.toFixed(1), +c.toFixed(2)]); } }
  return out;
}
