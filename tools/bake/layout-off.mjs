// The baked layout's bridges and tunnels, checked on a chunk's fine mesh (tools/bake/layout-check.mjs, tools/test/layoutcheck.js):
//   ends: where a road stops at a deck or a tube, the step between the surface's physics just before its end and the deck's
//         (or the tube floor's) height there (roads.js draws them at it), per end, by kind
//   rim:  a portal's lip (its opening, rules.js) has every rim point within what covers it: the tube's mouth below its crown
//         at the front, the headwall's lintel behind, the headwall (its wings PORTAL_FOOT deep) beside the mouth, the floor and
//         its sill (SILL deep) across the mouth (no gap between the surface and the tube)
import { physAt } from '../../src/layout/mesh.js';
import { KIND } from '../../src/layout/format.js';
import { portalsOf, portalUV, TUBE_H, PORTAL_TOP, PORTAL_T, PORTAL_FOOT, SILL, FLUSH } from '../../src/layout/rules.js';

// L: a decoded chunk; m: its fine mesh; ix: physIndex(L, m); lipIdx: the lip triangles' corners (vertex indices)
export function offChecks(L, m, ix, lipIdx) {
  // where a road stops at a deck or a tube: the surface's physics 5 mm before its end against the deck's (or the tube
  // floor's) height there (roads.js draws them at it): the step
  const badAt = [], P = m.pos, inC = (x, z, e = 0.1) => x > L.x0 + e && z > L.z0 + e && x < L.x0 + L.size - e && z < L.z0 + L.size - e, offs = L.net.runs.filter((q) => q.off), ends = { deck: [], tube: [], railOver: [] };
  const allPortals = portalsOf(L.net.runs), inLip = (x, z) => allPortals.some((pt) => { const [u, w] = portalUV(pt, x, z); return u > -0.01 && u < PORTAL_T / 2 + 0.01 && Math.abs(w) < pt.W; }); // (a deck ending in a portal's lip: it meets the tube there, no surface between)
  for (const rd of L.net.runs) { if (rd.off) continue; const n = rd.h.length; for (const [c, i, j] of [[rd.cutA, 0, 1], [rd.cutB, n - 1, n - 2]]) { if (!c || n < 2) continue; const x = rd.pts[i * 2], z = rd.pts[i * 2 + 1]; if (!inC(x, z) || (c === 'deck' && inLip(x, z))) continue;
    let y = rd.h[i]; for (const o of offs) { const k = o.h.length - 1; if (Math.hypot(o.pts[0] - x, o.pts[1] - z) < 0.02) { y = o.h[0]; break; } if (Math.hypot(o.pts[k * 2] - x, o.pts[k * 2 + 1] - z) < 0.02) { y = o.h[k]; break; } }
    const dx = rd.pts[j * 2] - x, dz = rd.pts[j * 2 + 1] - z, l = Math.hypot(dx, dz) || 1, o4 = [0, 0, 0, 0], hp = physAt(L, m, ix, x + dx / l * 0.005, z + dz / l * 0.005, o4); const gap = hp === hp ? Math.abs(hp - y) : 99;
    if (rd.kind === 'rail' && hp === hp && m.tk[o4[0]] !== KIND.ballast) { ends.railOver.push(gap); continue; } // (a railway's deck ending over a road's carriageway (OpenStreetMap's bridge shorter than the real one): the road's surface there, not the rail's bed: counted on its own)
    ends[c].push(gap); if (gap >= 0.02) badAt.push([c, +x.toFixed(1), +z.toFixed(1), +gap.toFixed(3)]); } }
  // a portal's opening: every point of its lip's rim within what covers it (the tube's mouth below the crown at the
  // front, the headwall's lintel behind; beside the mouth, the headwall), so no gap between the surface and the tube
  let rimBad = 0, rimN = 0, noLip = 0; const portals = portalsOf(L.net.runs).filter((pt) => inC(pt.x, pt.z, pt.W + 1));
  for (const pt of portals) { let seen = 0; for (let q = 0; q < lipIdx.length; q++) { const v = lipIdx[q], [u, w] = portalUV(pt, P[v * 3], P[v * 3 + 2]); if (u < -0.05 || u > PORTAL_T / 2 + 0.05 || Math.abs(w) > pt.W + 0.05) continue; seen++; rimN++;
    const y = P[v * 3 + 1] - pt.y, mouth = Math.abs(w) <= pt.hwT + 0.01, [lo, hi] = !mouth ? [-PORTAL_FOOT, PORTAL_TOP] : u < PORTAL_T / 4 ? [-SILL, TUBE_H] : [TUBE_H, PORTAL_TOP], flush = mouth && y >= -SILL - 0.01 && y <= FLUSH + 0.01; if (!flush && (y < lo - 0.01 || y > hi + 0.01)) { rimBad++; if (rimBad <= 3) badAt.push(['rim', +pt.x.toFixed(1), +pt.z.toFixed(1), +u.toFixed(2), +w.toFixed(2), +y.toFixed(2)]); } }
    if (!seen) { // (no opening: the lip all under another carriageway, a twin's merging with it. Fine if the surface across the headwall's back is what covers it there, as a rim's would be)
      let ok = true; for (let f = -1; f <= 1.001; f += 0.125) { const w = pt.W * f, x = pt.x + pt.dx * PORTAL_T / 2 - pt.dz * w, z = pt.z + pt.dz * PORTAL_T / 2 + pt.dx * w, h = physAt(L, m, ix, x, z), y = h - pt.y;
        if (!(h === h)) { ok = false; break; } if (Math.abs(w) <= pt.hwT ? !(y >= -SILL - 0.01 && y <= FLUSH + 0.01) && !(y >= TUBE_H - 0.01 && y <= PORTAL_TOP + 0.01) : !(y >= -PORTAL_FOOT - 0.01 && y <= PORTAL_TOP + 0.01)) { ok = false; break; } }
      if (!ok) noLip++; } }
  return { ends, badAt, rimBad, rimN, noLip, portals: portals.length };
}
