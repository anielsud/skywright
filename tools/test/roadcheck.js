// Road network checks (Node tier, #228): every map's roads as the physics sees them (World.sampleGrid: the terrain
// with the road profiles and embankments on it), built by node/world.mjs at Low.
//   steps:     along every road's centre line on the ground, the height may not change by more than STEP in 1 m.
//   steep:     inside every road's footprint (centre and both sides), the ground's slope in any direction may not
//              exceed STEEP: a wall or a ramp at a junction where two roads meet at different heights. Counted as
//              spots (40 m clusters).
//   joins:     a road end on another road's line (within 3 m) meets it at its height (to 0.3 m), unless that is a
//              bridge deck (an end under an overpass).
//   crossings: two roads crossing on the ground cross at the same height (to 0.3 m).
// Only inside the core map (200 m in from its edge: the roads stop there).
// The roads are read from world.net, not through the code under test's own junction logic.
export const nodeSuite = { files: ['src/roads.js', 'src/roadgrade.js', 'src/realworld.js', 'src/world.js', 'tools/test/roadcheck.js'] };

const PLACES = ['alpine', 'islands', 'canyon', 'lauterbrunnen', 'nyc'];
const STEP = 0.35, STEEP = 0.45, JOIN = 0.3, SNAP = 3;

export function cases() { return PLACES.map((loc) => ({ id: loc, loc, world: loc, cost: loc === 'nyc' ? 60 : 15 })); }

export function measure(w) {
  const roads = w.net.roads.filter((r) => r.kind !== 'rail'), lim = w.half - 200, inCore = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim;
  const isDeck = (rd, i) => !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % rd.pts.length]);
  const out = { km: 0, steps: [], steep: [], joins: [], crossings: [] };
  // segment hash (20 m cells)
  const C = 20, segs = new Map(), key = (i, j) => i + ',' + j;
  roads.forEach((rd, ri) => {
    const P = rd.pts, last = rd.closed ? P.length : P.length - 1;
    for (let i = 0; i < last; i++) {
      const a = P[i], b = P[(i + 1) % P.length], sg = { a, b, ri, deck: isDeck(rd, i) };
      const i0 = Math.floor(Math.min(a.x, b.x) / C), i1 = Math.floor(Math.max(a.x, b.x) / C), j0 = Math.floor(Math.min(a.z, b.z) / C), j1 = Math.floor(Math.max(a.z, b.z) / C);
      for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) { const k = key(ii, jj); let A = segs.get(k); if (!A) segs.set(k, (A = [])); A.push(sg); }
    }
  });
  const near = (x, z, fn) => { const ci = Math.floor(x / C), cj = Math.floor(z / C); for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const v of segs.get(key(i, j)) || []) fn(v); };
  const spot = (list, x, z, v, what) => { const c = list.find((c) => Math.hypot(c.x - x, c.z - z) < 40); if (c) { c.n++; if (v > c.v) c.v = v; } else list.push({ x: Math.round(x), z: Math.round(z), v, n: 1, what }); };
  roads.forEach((rd, ri) => {
    const P = rd.pts, n = P.length, hw = rd.width / 2, last = rd.closed ? n : n - 1;
    let prev = null;
    for (let i = 0; i < last; i++) {
      const a = P[i], b = P[(i + 1) % n], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (isDeck(rd, i) || L < 1e-3) { prev = null; continue; }
      const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
      for (let s = 0; s < L; s += 1) {
        const x = a.x + dx * s, z = a.z + dz * s;
        if (!inCore(x, z)) { prev = null; continue; }
        out.km += 0.001;
        const h = w.sampleGrid(x, z);
        if (prev != null && Math.abs(h - prev) > STEP) spot(out.steps, x, z, Math.abs(h - prev), rd.kind);
        prev = h;
        if (s % 2) continue;
        for (const f of [-0.7, 0, 0.7]) {
          const px = x - dz * hw * f, pz = z + dx * hw * f;
          const g = Math.hypot(w.sampleGrid(px + 0.5, pz) - w.sampleGrid(px - 0.5, pz), w.sampleGrid(px, pz + 0.5) - w.sampleGrid(px, pz - 0.5));
          if (g > STEEP) spot(out.steep, px, pz, g, rd.kind);
        }
      }
    }
    // ends on another road's line
    if (!rd.closed) for (const [e, ie] of [[P[0], 0], [P[n - 1], n - 2]]) {
      if (!inCore(e.x, e.z) || isDeck(rd, ie)) continue;
      let bd = SNAP, y = null, deck = false;
      near(e.x, e.z, (sg) => {
        if (sg.ri === ri) return;
        const { a, b } = sg, ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((e.x - a.x) * ex + (e.z - a.z) * ez) / L2));
        const d = Math.hypot(a.x + ex * t - e.x, a.z + ez * t - e.z); if (d < bd) { bd = d; y = a.y + (b.y - a.y) * t; deck = sg.deck; }
      });
      if (y != null && !deck && Math.abs(y - e.y) > JOIN) spot(out.joins, e.x, e.z, Math.abs(y - e.y), rd.kind);
    }
    // crossings with the roads after it (each pair once)
    for (let i = 0; i < last; i++) {
      if (isDeck(rd, i)) continue;
      const a = P[i], b = P[(i + 1) % n]; if (!inCore(a.x, a.z)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, seen = new Set();
      near((a.x + b.x) / 2, (a.z + b.z) / 2, (sg) => {
        if (sg.ri <= ri || sg.deck || seen.has(sg)) return; seen.add(sg);
        const r = sg.a, q = sg.b, ex = q.x - r.x, ez = q.z - r.z, den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) return;
        const t = ((r.x - a.x) * ez - (r.z - a.z) * ex) / den, u = ((r.x - a.x) * dz - (r.z - a.z) * dx) / den;
        if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) return; // (ends meeting: the joins check)
        const d = Math.abs(a.y + (b.y - a.y) * t - (r.y + (q.y - r.y) * u));
        if (d > JOIN) spot(out.crossings, a.x + dx * t, a.z + dz * t, d, rd.kind);
      });
    }
  });
  return out;
}

export async function runCase(c) {
  const { worldAt } = await import('./node/world.mjs');
  const w = (await worldAt(c.loc)).world, m = measure(w);
  const worst = (L, unit) => { const s = [...L].sort((p, q) => q.v - p.v).slice(0, 3); return s.map((p) => `(${p.x}, ${p.z}) ${unit(p.v)}`).join('; '); };
  const m1 = (v) => `${v.toFixed(2)} m`, pc = (v) => `${Math.round(v * 100)}%`;
  return [
    { name: `${c.loc}: no steps along the roads`, ok: !m.steps.length, why: m.steps.length ? `${m.steps.length} spots, worst ${worst(m.steps, m1)}` : `${m.km.toFixed(0)} km` },
    { name: `${c.loc}: no walls or ramps on the roads`, ok: !m.steep.length, why: m.steep.length ? `${m.steep.length} spots steeper than ${pc(STEEP)}, worst ${worst(m.steep, pc)}` : '' },
    { name: `${c.loc}: road ends meet the road they join`, ok: !m.joins.length, why: m.joins.length ? `${m.joins.length} ends off by more than ${JOIN} m, worst ${worst(m.joins, m1)}` : '' },
    { name: `${c.loc}: roads cross at the same height`, ok: !m.crossings.length, why: m.crossings.length ? `${m.crossings.length} crossings off by more than ${JOIN} m, worst ${worst(m.crossings, m1)}` : '' },
  ];
}
