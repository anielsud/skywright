// The railways of a baked layout chunk (#294): where its rails and sleepers go. A railway's bed is a region of the
// chunk's surface (KIND.ballast, rules.js); its rails are laid on that surface: each rail's line sampled every RAIL_STEP m
// on the chunk's own mesh (at(x, z): its physics, which is what's drawn on the ballast), so they sit on it exactly. On a
// bridge's deck or in a tunnel's tube (not the surface's) they lie on its own profile. Pure (no three.js): the game
// (runtime.js) builds the meshes from it, the bake's check (tools/bake/railcheck.mjs) measures it.
export const RAIL_TOP = 0.2, SLEEPER_TOP = 0.06, RAIL_STEP = 2, SLEEPER_STEP = 0.65;
// the track's gauge by class (bake.js RAIL_CLASS: main, service, narrow, rack, funicular) and its sleepers' length
export const GAUGE = [1.435, 1.435, 1, 0.8, 1], SLEEPER_L = [2.6, 2.6, 1.9, 1.6, 1.8];

// L: a decoded chunk; at(x, z): the surface's height (NaN off it: a portal's opening). -> one piece per stretch of a railway
// inside the chunk: { cls, off ('deck', 'tube' or null), hw, P: [x, z, y, ux, uz, ...] (the centre line's points, the bed's
// height there, its direction) }. y: the surface under the centre line, or a deck's or tube's own height.
export function railPieces(L, at) {
  const out = [], x0 = L.x0, z0 = L.z0, x1 = L.x0 + L.size, z1 = L.z0 + L.size;
  for (const r of L.net.runs) { if (r.kind !== 'rail') continue; const n = r.h.length, cls = r.lanes; let cur = null;
    const flush = () => { if (cur && cur.P.length >= 10) out.push(cur); cur = null; };
    const put = (x, z, y, ux, uz) => { if (!(y === y)) { flush(); return; } if (!cur) cur = { cls, off: r.off, hw: r.hw, P: [] }; const P = cur.P; if (P.length && Math.abs(P[P.length - 5] - x) < 1e-6 && Math.abs(P[P.length - 4] - z) < 1e-6) return; P.push(x, z, y, ux, uz); };
    for (let s = 0; s + 1 < n; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-6) continue;
      // (the part of the segment inside the chunk: Liang-Barsky)
      let t0 = 0, t1 = 1; for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) { if (Math.abs(p) < 1e-12) { if (q < 0) { t0 = 1; t1 = 0; } continue; } const t = q / p; if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t); }
      if (t0 >= t1) { flush(); continue; } if (t0 > 0) flush(); // (it left the chunk and came back)
      const ux = dx / l, uz = dz / l, k = Math.max(1, Math.ceil((t1 - t0) * l / RAIL_STEP));
      for (let q = 0; q <= k; q++) { const t = t0 + (t1 - t0) * q / k, x = ax + dx * t, z = az + dz * t; put(x, z, r.off ? r.h[s] + (r.h[s + 1] - r.h[s]) * t : at(x, z), ux, uz); }
      if (t1 < 1) flush(); }
    flush(); }
  return out;
}
// a piece's rail or its sleepers' ends: its points [x, z, y, ux, uz] at offset o across, each on the surface there (a deck's or
// tube's: level across). refine: where the surface bends between two points (more than REFINE m off the straight line between
// them, at the middle), a point between, down to REFINE_MIN m apart: the rail follows the surface's own creases
export const REFINE = 0.005, REFINE_MIN = 0.05;
export function railSide(pc, o, at, refine = false) {
  const P = pc.P, out = [], y0 = (x, z, i) => { const y = pc.off ? P[i + 2] : at(x, z); return y === y ? y : P[i + 2]; };
  const split = (x0, z0, h0, x1, z1, h1, ux, uz, d) => { const l = Math.hypot(x1 - x0, z1 - z0); if (l < REFINE_MIN * 2 || d > 8) return; const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, hm = at(mx, mz); if (!(hm === hm)) return;
    const dev = (t) => { const h = at(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t); return h === h ? Math.abs(h - h0 - (h1 - h0) * t) : 0; }; if (Math.max(Math.abs(hm - (h0 + h1) / 2), dev(0.25), dev(0.75), dev(0.125), dev(0.875)) <= REFINE) return; // (a crease anywhere between)
    split(x0, z0, h0, mx, mz, hm, ux, uz, d + 1); out.push(mx, mz, hm, ux, uz); split(mx, mz, hm, x1, z1, h1, ux, uz, d + 1); };
  for (let i = 0; i < P.length; i += 5) { const ux = P[i + 3], uz = P[i + 4], x = P[i] - uz * o, z = P[i + 1] + ux * o, y = y0(x, z, i);
    if (refine && !pc.off && out.length) { const k = out.length - 5; split(out[k], out[k + 1], out[k + 2], x, z, y, ux, uz, 0); }
    out.push(x, z, y, ux, uz); }
  return out;
}
