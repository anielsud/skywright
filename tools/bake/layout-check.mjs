// A worker of tools/bake/layout.mjs: checks baked chunks the game's way (src/layout/mesh.js, fine and coarse) and
// measures them: fixed edges failed, cover, holes (physics sampled every HOLE_STEP m), tarmac drawn - physics, the
// steepest physics rise along a kerb, timings; and each level's points on each of the chunk's four edges (the caller
// compares neighbours': their shared edge must match).
import { parentPort } from 'node:worker_threads';
import { decodeLayout, KIND } from '../../src/layout/format.js';
import { KERB } from '../../src/layout/rules.js';
import { meshChunk, physIndex, physAt } from '../../src/layout/mesh.js';

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
      // the markings: along each street's centre line (every 2 m in the chunk, out of junctions), the across coordinate the
      // carriageway's triangle there interpolates (0 on the centre line): the markings' drift
      const R = m.rib, rt = new Map(), C = 8; for (let t = 0; t < R.kind.length; t += 3) { if (R.kind[t] !== KIND.tarmac || !R.road[t * 4 + 2]) continue; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let q = 0; q < 3; q++) { x0 = Math.min(x0, R.pos[(t + q) * 3]); x1 = Math.max(x1, R.pos[(t + q) * 3]); z0 = Math.min(z0, R.pos[(t + q) * 3 + 2]); z1 = Math.max(z1, R.pos[(t + q) * 3 + 2]); }
        for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) { const k = i * 1e6 + j; (rt.get(k) || rt.set(k, []).get(k)).push(t); } }
      let drift = 0, ds = 0; L.net.runs.forEach((rd, ri) => { if (rd.minor) return; for (let s = 0; s + 1 < rd.h.length; s++) { const ax = rd.pts[s * 2], az = rd.pts[s * 2 + 1], bx = rd.pts[s * 2 + 2], bz = rd.pts[s * 2 + 3], l = Math.hypot(bx - ax, bz - az);
        for (let d = 0; d < l; d += 2) { const x = ax + (bx - ax) * d / l, z = az + (bz - az) * d / l; if (x <= L.x0 || z <= L.z0 || x >= L.x0 + L.size || z >= L.z0 + L.size) continue;
          for (const t of rt.get(Math.floor(x / C) * 1e6 + Math.floor(z / C)) || []) { if (R.id[t] !== ri) continue; const P = (q) => [R.pos[(t + q) * 3], R.pos[(t + q) * 3 + 2]], [A, B, Cc] = [P(0), P(1), P(2)], den = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1]); if (!den) continue;
            const l1 = ((B[1] - Cc[1]) * (x - Cc[0]) + (Cc[0] - B[0]) * (z - Cc[1])) / den, l2 = ((Cc[1] - A[1]) * (x - Cc[0]) + (A[0] - Cc[0]) * (z - Cc[1])) / den, l3 = 1 - l1 - l2; if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            const v = l1 * R.road[t * 4 + 1] + l2 * R.road[(t + 1) * 4 + 1] + l3 * R.road[(t + 2) * 4 + 1], dj = l1 * R.road[t * 4 + 3] + l2 * R.road[(t + 1) * 4 + 3] + l3 * R.road[(t + 2) * 4 + 3]; if (dj > 0.5) { drift = Math.max(drift, Math.abs(v)); ds++; } break; } } } });
      Object.assign(r.fine, { tarmacOff: off, kerbSlope: kerb, holes, samples, drift, driftSamples: ds });
    }
    r.edges = edges; out.push(r);
  }
  parentPort.postMessage(out);
});
