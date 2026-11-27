// A worker of tools/bake/layout.mjs: checks baked chunks the game's way (src/layout/mesh.js, fine and coarse) and
// measures them: fixed edges failed, cover, holes (physics sampled every HOLE_STEP m), tarmac drawn - physics, the
// steepest physics rise along a kerb, the markings off their street's centre line, the crossings, timings; and each level's points on each of the chunk's four edges (the caller
// compares neighbours': their shared edge must match).
import { parentPort } from 'node:worker_threads';
import { decodeLayout, KIND } from '../../src/layout/format.js';
import { KERB, makeRules, latticeGround } from '../../src/layout/rules.js';
import { meshChunk, physIndex, physAt, latticeOf } from '../../src/layout/mesh.js';
import { markCheck } from './markcheck.mjs';

const HOLE_STEP = 2;
parentPort.on('message', ({ jobs, grid }) => {
  const out = [];
  for (const { ix, iz, buf, G } of jobs) {
    const L = decodeLayout(buf), r = { ix, iz }, edges = {};
    for (const level of ['fine', 'coarse']) {
      const m = meshChunk(L, grid, G, level), s = m.stats; r[level] = { failed: s.failed, why: s.why, softMissed: s.softMissed, covered: s.covered, tris: s.tris, ms: s.totalMs, outlineMs: s.outlineMs };
      const P = m.pos, n = P.length / 3, side = { w: [], e: [], s: [], n: [] }; // (each edge's points: "along@height")
      for (let k = 0; k < n; k++) { const x = P[k * 3], z = P[k * 3 + 2], y = P[k * 3 + 1].toFixed(3); if (x === L.x0) side.w.push(z.toFixed(2) + '@' + y); if (x === L.x0 + L.size) side.e.push(z.toFixed(2) + '@' + y); if (z === L.z0) side.s.push(x.toFixed(2) + '@' + y); if (z === L.z0 + L.size) side.n.push(x.toFixed(2) + '@' + y); }
      for (const k in side) side[k].sort(); edges[level] = side;
      if (level !== 'fine') continue;
      const I = m.idx, Y = m.phys; let off = 0, kerb = 0;
      for (let q = 0; q < m.tk.length; q++) { const v = [I[q * 3], I[q * 3 + 1], I[q * 3 + 2]];
        if (m.tk[q] === KIND.tarmac) for (const k of v) off = Math.max(off, Math.abs(Y[k] - P[k * 3 + 1]));
        if (m.tk[q] === KIND.kerb) for (let a = 0; a < 3; a++) { const u = v[a], w = v[(a + 1) % 3], l = Math.hypot(P[u * 3] - P[w * 3], P[u * 3 + 2] - P[w * 3 + 2]); const top = (q) => P[q * 3 + 1] - Y[q] > 0.1, gut = (q) => Math.abs(P[q * 3 + 1] - Y[q]) < 1e-4; if (l < 0.5 && ((top(u) && gut(w)) || (top(w) && gut(u)))) { const t = top(u) ? u : w, gg = t === u ? w : u; kerb = Math.max(kerb, Math.abs((Y[t] - Y[gg]) - (P[t * 3 + 1] - KERB - P[gg * 3 + 1]))); } } } // (across the kerb, a gutter's point to a top's: how far physics rises past the surface the kerb stands on (drawn less the kerb); the surface's own slope isn't the kerb: on a 20% street a gutter 0.4 m along rises 0.08 m)
      const ixx = physIndex(L, m); let holes = 0, samples = 0;
      for (let x = L.x0 + HOLE_STEP / 2; x < L.x0 + L.size; x += HOLE_STEP) for (let z = L.z0 + HOLE_STEP / 2; z < L.z0 + L.size; z += HOLE_STEP) { samples++; const h = physAt(L, m, ixx, x, z); if (!(h === h)) holes++; }
      // the markings, the crossings and the slabs, as the material draws them (markcheck.mjs)
      const mk = markCheck(L, m); Object.assign(r.fine, { tarmacOff: off, kerbSlope: kerb, holes, samples, drift: mk.drift, driftSamples: mk.samples, lost: mk.lost, mouths: mk.mouths, whole: mk.whole, tight: mk.tight, kerbErr: mk.kerbErr, bendMissed: s.bendMissed });
      // the shore: every point of the drawn ground against the natural ground and the water level: dry ground pushed below the
      // water (must be 0), ground raised where it's under water, paved points below the water; and how many bank points the
      // shore rule changed (against the same rules without it)
      const wl = grid.wl ?? -Infinity, ng = latticeGround(grid, latticeOf(L, grid), G), R0 = makeRules(L.net, ng, !!L.city), R1 = wl > -Infinity ? makeRules(L.net, ng, !!L.city, wl) : R0, shore = { under: 0, raised: 0, pavedWet: 0, limited: 0 }, seen = new Uint8Array(n);
      const paved = new Uint8Array(n); for (let q = 0; q < m.tk.length; q++) if (m.tk[q] !== KIND.ground && m.tk[q] !== KIND.bank) for (let a = 0; a < 3; a++) paved[I[q * 3 + a]] = m.tk[q]; // (a point on a paved region's edge is the region's)
      shore.ex = [];
      for (let q = 0; q < m.tk.length; q++) for (let a = 0; a < 3; a++) { const k = I[q * 3 + a]; if (seen[k]) continue; seen[k] = 1; const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2], gz = ng(x, z), bad = (w) => { shore[w]++; if (shore.ex.length < 4) shore.ex.push([w, +x.toFixed(1), +z.toFixed(1), +y.toFixed(2), +gz.toFixed(2), paved[k]]); };
        if (!paved[k]) { if (gz >= wl && y < wl - 1e-3) bad('under'); if (gz < wl && y > gz + 0.01) bad('raised'); if (R1 !== R0 && Math.abs(R0.ground(x, z) - R1.ground(x, z)) > 0.01) shore.limited++; } else if (y < wl) bad('pavedWet'); }
      r.fine.shore = shore;
    }
    r.edges = edges; out.push(r);
  }
  parentPort.postMessage(out);
});
