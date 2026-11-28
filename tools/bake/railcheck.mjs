// The baked layout's railways, checked on a chunk's fine mesh (tools/bake/layout-check.mjs):
//   rails:  each rail laid as the game lays it (src/layout/rails.js: sampled every RAIL_STEP m on the surface) against the
//           surface between its samples (every RAIL_STEP / 8 m): how far the rail's foot is off the bed (the rail's top
//           is RAIL_TOP over it), and what's under the rails (ballast; a road's carriageway at a level crossing; else)
//   bed:    the ballast drawn against its physics (the same: the bed is physics, as a carriageway is)
//   cross:  at each level crossing (junctions[].lx), along each railway's and road's centre line through it, the surface's
//           steepest rise over STEP_D m less what its own grade gives there: a step the rail or a car would feel
//   clear:  under each railway's deck (its footprint, between its ends, CLEAR_END m in from each), every CLEAR_STEP m: the
//           deck's underside less the paved surface under it (a road's, a railway's bed: bake.js deckCeil holds them under it);
//           under 0 a road pokes through the deck
import { physAt } from '../../src/layout/mesh.js';
import { railPieces, railSide, GAUGE, RAIL_STEP } from '../../src/layout/rails.js';
import { KIND } from '../../src/layout/format.js';
import { DECK_SIDE, DECK_DEPTH } from '../../src/layout/rules.js';

const STEP_D = 0.02, SUB = 8, CLEAR_STEP = 0.5, CLEAR_END = 0.5;
export function railChecks(L, m, ix) {
  const at = (x, z) => physAt(L, m, ix, x, z), o = [0, 0, 0, 0], under = {}, pcs = railPieces(L, at); let off = 0, n = 0, over = 0, worst = null;
  for (const pc of pcs) { if (pc.off) continue; const half = GAUGE[pc.cls] / 2;
    for (const sd of [-1, 1]) { const S = railSide(pc, sd * half, at, true);
      for (let i = 0; i + 5 < S.length; i += 5) for (let q = 1; q < SUB; q++) { const t = q / SUB, x = S[i] + (S[i + 5] - S[i]) * t, z = S[i + 1] + (S[i + 6] - S[i + 1]) * t, y = S[i + 2] + (S[i + 7] - S[i + 2]) * t, h = physAt(L, m, ix, x, z, o); if (!(h === h)) continue;
        n++; const d = Math.abs(y - h); if (d >= 0.02) over++; if (d > off) { off = d; worst = [+x.toFixed(1), +z.toFixed(1), +d.toFixed(3)]; } const k = m.tk[o[0]], w = k === KIND.ballast ? 'ballast' : k === KIND.tarmac ? 'tarmac' : k <= KIND.bank ? 'ground' : 'other'; under[w] = (under[w] || 0) + 1; } } }
  // the bed: drawn against physics
  let bed = 0; const P = m.pos, I = m.idx, Y = m.phys; for (let q = 0; q < m.tk.length; q++) if (m.tk[q] === KIND.ballast) for (let a = 0; a < 3; a++) { const v = I[q * 3 + a]; bed = Math.max(bed, Math.abs(P[v * 3 + 1] - Y[v])); }
  // the level crossings: each railway's and road's centre line through it (rules.js streetH puts both on its plane)
  let lx = 0, step = 0, stepAt = null; const inC = (x, z) => x > L.x0 + 0.05 && z > L.z0 + 0.05 && x < L.x0 + L.size - 0.05 && z < L.z0 + L.size - 0.05;
  for (const J of L.net.junctions) { if (!J.lx || !inC(J.x, J.z)) continue; lx++;
    for (const r of L.net.runs) { if (r.off) continue; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-3) continue;
      const t = Math.max(0, Math.min(1, ((J.x - ax) * dx + (J.z - az) * dz) / (l * l))); if (Math.hypot(ax + dx * t - J.x, az + dz * t - J.z) > 1) continue; // (a way through the crossing)
      const ux = dx / l, uz = dz / l, hs = [], ks = []; for (let u = -J.r; u <= J.r; u += STEP_D) { const x = ax + dx * t + ux * u, z = az + dz * t + uz * u; hs.push(inC(x, z) ? physAt(L, m, ix, x, z, o) : NaN); ks.push(m.tk[o[0]]); }
      for (let i = 1; i + 2 < hs.length; i++) { if (![hs[i - 1], hs[i], hs[i + 1], hs[i + 2]].every((h) => h === h)) continue; const d = Math.abs(hs[i + 1] - hs[i]) - Math.min(Math.abs(hs[i] - hs[i - 1]), Math.abs(hs[i + 2] - hs[i + 1])); // (a rise over STEP_D more than the next one's: a step, not a slope)
        if (d > step) { const u = -J.r + (i + 0.5) * STEP_D; step = d; stepAt = [+J.x.toFixed(1), +J.z.toFixed(1), r.kind, +(ax + dx * t + ux * u).toFixed(2), +(az + dz * t + uz * u).toFixed(2), ks[i], ks[i + 1]]; } } } } } /* (where: the crossing, the way, the step's point and the region kinds either side) */
  // the decks' clearance over the paved surface under them
  let clr = Infinity, clrN = 0, clrBad = 0, clrAt = null; const paved = (k) => k !== KIND.ground && k !== KIND.bank && k !== KIND.lip && k !== KIND.verge;
  for (const r of L.net.runs) { if (r.off !== 'deck' || r.kind !== 'rail') continue; const W = r.hw + DECK_SIDE, n = r.h.length; let s0 = 0; const len = []; for (let s = 0; s + 1 < n; s++) len.push(Math.hypot(r.pts[s * 2 + 2] - r.pts[s * 2], r.pts[s * 2 + 3] - r.pts[s * 2 + 1])); const total = len.reduce((a, b) => a + b, 0);
    for (let s = 0; s + 1 < n; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], l = len[s]; if (l < 1e-3) { continue; } const ux = (r.pts[s * 2 + 2] - ax) / l, uz = (r.pts[s * 2 + 3] - az) / l;
      for (let a = 0; a < l; a += CLEAR_STEP) { const along = s0 + a; if (along < CLEAR_END || along > total - CLEAR_END) continue; const y = r.h[s] + (r.h[s + 1] - r.h[s]) * a / l - DECK_DEPTH;
        for (let v = -W; v <= W + 1e-6; v += CLEAR_STEP) { const x = ax + ux * a - uz * v, z = az + uz * a + ux * v; if (!inC(x, z)) continue; const hh = physAt(L, m, ix, x, z, o); if (!(hh === hh) || !paved(m.tk[o[0]])) continue;
          clrN++; const c = y - hh; if (c < 0) clrBad++; if (c < clr) { clr = c; clrAt = [+x.toFixed(1), +z.toFixed(1), +c.toFixed(2), m.tk[o[0]]]; } } }
      s0 += l; } }
  return { clear: clrN ? clr : null, clearN: clrN, clearBad: clrBad, clearAt: clrAt, railOff: off, railN: n, railOver: over, railWorst: worst, railUnder: under, bedOff: bed, lx, lxStep: step, lxStepAt: stepAt, pieces: pcs.length };
}
