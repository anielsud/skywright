// The markings' and the paving's alignment on a chunk's fine mesh (src/layout/mesh.js), measured the way the material
// draws them (the street ribbons' interpolated coordinates, runtime.js roadMat / sidewalkMaterial):
//   drift   along every street's centre line (every metre in the chunk and 1 m off its edge, MARK_OUT m or more past any
//           junction's circle, where lane lines and the centre line are painted): the across coordinate the carriageway's
//           triangle there interpolates. 0 on the centre line; the markings' centre is that far off it (m). A sample
//           whose triangle is another street's, or unpainted, counts as 'lost' (that stretch has no markings); one where
//           another street's carriageway overlaps isn't counted, nor one by a corner sharper than SHARP (atSharp).
//   zebras  at every mouth onto a junction (in the chunk) of a street with crossings (rules.js zebra): across the carriageway at three distances in the
//           crossing's band (ZEBRA_AT m past the circle), whether every sample is this street's, painted, and its
//           distance-from-the-junction coordinate is the one wanted (ZEBRA_TOL: the band square across). whole / mouths.
//   kerbs   the pavement's slabs: at every pavement and kerb ribbon corner, the across coordinate it's given against its
//           true distance from its street's centre line (joints run along the kerb when they agree): max error.
import { KIND } from '../../src/layout/format.js';
import { zebra } from '../../src/layout/rules.js';

export const MARK_OUT = 4, ZEBRA_AT = [0.8, 2, 3.2], ZEBRA_BAND = 3.5, ZEBRA_TOL = 0.15, DRIFT_MAX = 0.05, SHARP = Math.PI / 3; // (ZEBRA_BAND: the crossing's far edge past the circle, runtime.js roadMat)
export function markCheck(L, m, detail = false) {
  const R = m.rib, C = 8, grid = new Map(), J = L.net.junctions, runs = L.net.runs;
  for (let t = 0; t < R.kind.length; t += 3) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let q = 0; q < 3; q++) { x0 = Math.min(x0, R.pos[(t + q) * 3]); x1 = Math.max(x1, R.pos[(t + q) * 3]); z0 = Math.min(z0, R.pos[(t + q) * 3 + 2]); z1 = Math.max(z1, R.pos[(t + q) * 3 + 2]); }
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) { const k = i * 1e6 + j; (grid.get(k) || grid.set(k, []).get(k)).push(t); } }
  // the ribbon triangle at (x, z): [t, l1, l2, l3] or null
  const at = (x, z) => { for (const t of grid.get(Math.floor(x / C) * 1e6 + Math.floor(z / C)) || []) { const P = (q) => [R.pos[(t + q) * 3], R.pos[(t + q) * 3 + 2]], [A, B, Cc] = [P(0), P(1), P(2)], den = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1]); if (!den) continue;
    const l1 = ((B[1] - Cc[1]) * (x - Cc[0]) + (Cc[0] - B[0]) * (z - Cc[1])) / den, l2 = ((Cc[1] - A[1]) * (x - Cc[0]) + (A[0] - Cc[0]) * (z - Cc[1])) / den, l3 = 1 - l1 - l2; if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return [t, l1, l2, l3]; } return null; };
  const lerp = (h, c) => h[1] * R.road[h[0] * 4 + c] + h[2] * R.road[(h[0] + 1) * 4 + c] + h[3] * R.road[(h[0] + 2) * 4 + c];
  const jd = (x, z) => { let d = Infinity; for (const j of J) d = Math.min(d, Math.hypot(x - j.x, z - j.z) - j.r); return d; };
  // (another street's carriageway over this point too (two that merge, or overlap at a junction): which one's markings show is a choice, not drift)
  const shared = (x, z, ri) => { for (let q = 0; q < runs.length; q++) { const rd = runs[q]; if (q === ri || rd.minor || rd.off) continue; for (let s = 0; s + 1 < rd.h.length; s++) { const ax = rd.pts[s * 2], az = rd.pts[s * 2 + 1], dx = rd.pts[s * 2 + 2] - ax, dz = rd.pts[s * 2 + 3] - az; if (Math.abs(x - ax) > 80 || Math.abs(z - az) > 80) continue; const L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); if (Math.hypot(x - ax - dx * t, z - az - dz * t) < rd.hw) return true; } } return false; };
  const inC = (x, z, e = 0.5) => x > L.x0 + e && z > L.z0 + e && x < L.x0 + L.size - e && z < L.z0 + L.size - e;
  let drift = 0, samples = 0, lost = 0, atSharp = 0, worst = null; const lostAt = [];
  let mouths = 0, whole = 0, tight = 0; const broken = [];
  runs.forEach((rd, ri) => { if (rd.minor || rd.off) return; const n = rd.h.length;
    const sharp = []; let pd = null; for (let s = 0; s + 1 < n; s++) { const dx = rd.pts[s * 2 + 2] - rd.pts[s * 2], dz = rd.pts[s * 2 + 3] - rd.pts[s * 2 + 1], l = Math.hypot(dx, dz); if (l < 1e-3) continue; if (pd && pd[0] * dx / l + pd[1] * dz / l < Math.cos(SHARP)) sharp.push([rd.pts[s * 2], rd.pts[s * 2 + 1]]); pd = [dx / l, dz / l]; }
    for (let s = 0; s + 1 < n; s++) { const ax = rd.pts[s * 2], az = rd.pts[s * 2 + 1], bx = rd.pts[s * 2 + 2], bz = rd.pts[s * 2 + 3], l = Math.hypot(bx - ax, bz - az); if (l < 1e-3) continue; const ux = (bx - ax) / l, uz = (bz - az) / l;
      for (let d = 0.5; d < l; d += 1) { const x = ax + ux * d, z = az + uz * d; if (!inC(x, z, 1) || jd(x, z) < MARK_OUT) continue; // (1 m: a bend's points (mesh.js) stay 0.5 m off the chunk's edge)
        if (sharp.some(([px, pz]) => Math.hypot(x - px, z - pz) < rd.hw * 2 + 1)) { atSharp++; continue; } // (a corner sharper than SHARP: no one centre line there)
        const h = at(x, z); if (!h || R.kind[h[0]] !== KIND.tarmac) continue; // (off the carriageway: a plaza's, say)
        if (R.id[h[0]] !== ri || !R.road[h[0] * 4 + 2]) { if (shared(x, z, ri)) continue; lost++; if (lostAt.length < 8) lostAt.push([+x.toFixed(1), +z.toFixed(1), ri, R.id[h[0]]]); continue; }
        const v = Math.abs(lerp(h, 1)); samples++; if (v > drift) { drift = v; worst = [+x.toFixed(2), +z.toFixed(2), ri, +v.toFixed(3)]; } } }
    // the mouths: where its centre line leaves a junction's circle; the crossing's band from there, along the street
    if (zebra(rd, L.city)) for (const j of J) { if (!inC(j.x, j.z, -j.r)) continue; // (a street with crossings: a city's, or one with a pavement)
      let onIt = false; for (let s = 0; s < n; s++) if (Math.hypot(rd.pts[s * 2] - j.x, rd.pts[s * 2 + 1] - j.z) < Math.max(1, j.r * 0.5)) onIt = true; if (!onIt) continue; // (one of the street's own junctions, not one it passes)
      for (let s = 0; s + 1 < n; s++) { const ax = rd.pts[s * 2], az = rd.pts[s * 2 + 1], bx = rd.pts[s * 2 + 2], bz = rd.pts[s * 2 + 3], l = Math.hypot(bx - ax, bz - az); if (l < 1e-3) continue;
        const ux = (bx - ax) / l, uz = (bz - az) / l, tJ = (j.x - ax) * ux + (j.z - az) * uz, e = ux * (j.z - az) - uz * (j.x - ax); if (Math.abs(e) >= j.r) continue; const half = Math.sqrt(j.r * j.r - e * e);
        for (const sg of [-1, 1]) { const tm = tJ + sg * half, tz = tm + sg * ZEBRA_AT[1]; if (tz < 0 || tz > l) continue; const x = ax + ux * tz, z = az + uz * tz;
          if (!inC(x, z, 1)) continue; let other = Infinity; for (const k of J) if (k !== j) other = Math.min(other, Math.hypot(x - k.x, z - k.z) - k.r); if (other + ZEBRA_AT[1] < 2 * ZEBRA_BAND + 0.5) { tight++; continue; } // (two junctions' circles closer than two crossings' bands: no room for both)
          let ok = true, why = null;
          for (const dz of ZEBRA_AT) { let lo = Infinity, hi = -Infinity; for (let v = -(rd.hw - 0.4); v <= rd.hw - 0.4 + 1e-6 && ok; v += 0.25) { const t = tm + sg * dz, px = ax + ux * t - uz * v, pz = az + uz * t + ux * v, h = at(px, pz);
              if (!inC(px, pz, 0.05) || shared(px, pz, ri)) { ok = null; break; } if (!h || R.kind[h[0]] !== KIND.tarmac) { ok = false; why = 'not carriageway'; break; } if (R.id[h[0]] !== ri) { ok = false; why = 'cross street'; break; } if (!R.road[h[0] * 4 + 2]) { ok = false; why = 'unpainted'; break; } // (off it: the chunk beside's, or another street's carriageway too)
              const g = lerp(h, 3); lo = Math.min(lo, g); hi = Math.max(hi, g); }
            if (ok && (Math.abs(lo - dz) > ZEBRA_TOL || Math.abs(hi - dz) > ZEBRA_TOL)) { ok = false; why = `dj ${lo.toFixed(2)}..${hi.toFixed(2)} want ${dz}`; } if (!ok) break; }
          if (ok === null) continue; mouths++; // (a crossing over another street's carriageway too: not counted)
          if (ok) whole++; else if (broken.length < 12) broken.push([+x.toFixed(1), +z.toFixed(1), ri, why]); } } }
  });
  // the slabs: each pavement / kerb corner's across against its distance from its street's centre line (where that's
  // a segment's middle, out of the junctions: a corner's pavement is the nearest street's)
  let kerbErr = 0, kerbN = 0; for (let t = 0; t < R.kind.length; t++) { if (R.kind[t] !== KIND.kerb && R.kind[t] !== KIND.pave) continue; const rd = runs[R.id[t]], x = R.pos[t * 3], z = R.pos[t * 3 + 2]; let best = Infinity, mid = false;
    for (let s = 0; s + 1 < rd.h.length; s++) { const ax = rd.pts[s * 2], az = rd.pts[s * 2 + 1], dx = rd.pts[s * 2 + 2] - ax, dz = rd.pts[s * 2 + 3] - az, L2 = dx * dx + dz * dz || 1e-9, q0 = ((x - ax) * dx + (z - az) * dz) / L2, q = Math.max(0, Math.min(1, q0)), d = Math.hypot(x - ax - dx * q, z - az - dz * q); if (d < best) { best = d; mid = q0 > 0 && q0 < 1; } }
    if (mid && best < rd.hw + rd.pave + 1 && jd(x, z) > 1) { kerbErr = Math.max(kerbErr, Math.abs(Math.abs(R.road[t * 4 + 1]) - best)); kerbN++; } }
  const r = { drift, samples, lost, atSharp, mouths, whole, tight, kerbErr, kerbN };
  if (detail) Object.assign(r, { worst, lostAt, broken });
  return r;
}
