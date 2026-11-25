// Road network checks (Node tier, #228): every map's roads as the physics sees them (World.sampleGrid: the terrain
// with the road profiles and embankments on it), built by node/world.mjs at Low.
//   steps:     along every road's centre line on the ground, the height may not change by more than STEP in 1 m.
//   steep:     inside every road's footprint (centre and both sides), the ground's slope in any direction may not
//              exceed STEEP: a wall or a ramp at a junction where two roads meet at different heights. Counted as
//              spots (40 m clusters).
//   joins:     every road through a junction node (roads.bin topology) is at the same height there (to 0.3 m;
//              not where a bridge deck meets the ground); a road without topology: an end on another's line meets it.
//   crossings: two roads crossing on the ground without a shared node are either level (0.3 m) or clearly apart (3 m).
// Only inside the core map (200 m in from its edge: the roads stop there).
// The roads are read from world.net, not through the code under test's own junction logic.
export const nodeSuite = { files: ['src/roads.js', 'src/roadgrade.js', 'src/realworld.js', 'src/world.js', 'src/vehicles.js', 'src/laneGraph.js', 'src/signals.js', 'src/trafficModels.js', 'tools/test/roadcheck.js'] }; // (and the ground detail: detailCheck)

const PLACES = ['islands', 'canyon', 'lauterbrunnen', 'nyc'];
const STEP = 0.35, STEEP = 0.45, JOIN = 0.3, SNAP = 3, STEP_CITY = 0.12;

export function cases() { return [...PLACES.map((loc) => ({ id: loc, loc, world: loc, cost: loc === 'nyc' ? 60 : 15 })), ...PLACES.map((loc) => ({ id: `${loc} ground detail`, loc, world: loc, detail: true, cost: 3 })), ...PLACES.map((loc) => ({ id: `${loc} traffic`, loc, world: loc, traffic: true, cost: 3 })), { id: 'nyc traffic safety', loc: 'nyc', world: 'nyc', safety: true, cost: 12 }, { id: 'nyc posts', loc: 'nyc', world: 'nyc', posts: true, cost: 6 }, { id: 'traffic models face forward', models: true, cost: 0.2 }, ...PLACES.map((loc) => ({ id: `${loc} road pack`, loc, world: loc, pack: true, cost: 2 })), ...['lauterbrunnen', 'nyc'].map((loc) => ({ id: `${loc} tunnel drive`, loc, world: loc, tunnel: true, cost: 6 })), ...PLACES.map((loc) => ({ id: `${loc} ground under the road`, loc, world: loc, bleed: true, cost: loc === 'nyc' ? 30 : 12 })), { id: 'nyc open ground', loc: 'nyc', world: 'nyc', cityGround: true, cost: 6 }]; }

// The near-camera ground detail (World.updateDetail) at a few road points: inside, its vertices are the physics ground
// (sampleGrid) exactly away from the roads, and never above it (under and beside a road it is let down: it is hidden
// there, and must not rise through the road's ribbon); its edge is the patch's own surface (no seam); rebuilding it
// stays cheap.
export function detailCheck(w) {
  const roads = w.net.roads.filter((r) => r.kind !== 'rail' && r.pts.length > 10), lim = w.half - 1500, out = { n: 0, inner: 0, above: 0, edge: 0, times: [], shown: 0 };
  const picks = []; for (let k = 0; picks.length < 4 && k < roads.length * 4; k++) { const r = roads[(k * 7) % roads.length], p = r.pts[(k * 13) % r.pts.length]; if (Math.abs(p.x) < lim && Math.abs(p.z) < lim) picks.push(p); }
  for (const p of picks) {
    const cp = { x: p.x, y: w.sampleGrid(p.x, p.z) + 3, z: p.z };
    w.detailAt = null; w.patchAt = null; w.updatePatch(cp);
    if (!out.warm) { w.updateDetail(cp); w.detailAt = null; out.warm = true; } // (the first build compiles the code: not what a frame pays)
    const t0 = performance.now(); w.updateDetail(cp); out.times.push(performance.now() - t0);
    if (!w.detail.visible) continue; out.shown++;
    const D = w.detailD, n = D + 1, P = w.detail.geometry.attributes.position.array, R = w.hR, st = w.hStep;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3, x = P[o], y = P[o + 1], z = P[o + 2], e = Math.min(i, j, D - i, D - j); out.n++;
      if (e >= 4) { const d = y - w.sampleGrid(x, z); out.above = Math.max(out.above, d); let road = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) road |= w.detailOn[(j + b) * n + i + a]; if (!road) out.inner = Math.max(out.inner, Math.abs(d)); }
      if (e === 0) out.edge = Math.max(out.edge, Math.abs(y - w.triAt(w.Hh, R + 1, (x + w.half) / st, (z + w.half) / st)));
    }
  }
  const T = out.times.sort((a, b) => a - b); out.ms = T.length ? T[T.length >> 1] : 0;
  return out;
}

// The ground never shows through the road (#228): over the road surfaces the game draws (roads.js buildRoadMeshes:
// tarmac, gravel shoulders, a city's pavements; not bridge decks or tunnels), sampled every ~2 m, the ground each of
// its meshes draws there may not be above them: the coarse core mesh (H, far away), the patch (the baked grid Hh,
// round the camera) and the detail mesh (World.updateDetail, close up: built at `spots` road points, compared over
// the road within it). Returns per layer { n samples, over: samples more than OVER above, worst, spots (40 m) }.
// stride: every stride-th road triangle (New York draws ~9M).
const OVER = 0.05, BLEED = 0.001; // (metres; the share of the road that may still be under: tunnel mouths, a bridge's abutment in a cutting)
export function bleedCheck(w, { spots = 6, stride = 1 } = {}) {
  const G = w.roadGroup, RS = w.roadSurf, lim = w.half - 200, half = w.half, out = {};
  G.userData.update({ x: 0, y: 0, z: 0 }, 1e9, 1e9);
  for (const t of G.userData.tiles) if (!t.built) G.userData.update({ x: t.x, y: 0, z: t.z }, 1e9, 1e9); // (a city builds those within ROAD_D of the camera)
  // the road triangles: [x, y, z] x 3 per triangle
  const tris = [];
  G.traverse((m) => {
    const U = m.isMesh && !m.isInstancedMesh && m.material?.userData?.U; if (!U || m.material.userData === w.patchMat.userData || !(U.rLW || U.gTint || U.sD)) return;
    const pos = m.geometry.attributes.position.array, idx = m.geometry.index?.array, nt = idx ? idx.length / 3 : pos.length / 9;
    for (let t = 0; t < nt; t += stride) { const v = []; for (let q = 0; q < 3; q++) { const k = idx ? idx[t * 3 + q] : t * 3 + q; v.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]); } if (v[0] !== v[3] || v[2] !== v[5]) tris.push(v); }
  });
  // (a tunnel's tube, a bridge deck: not on the ground)
  const tube = (x, z, y) => { const C = RS.cell, ci = Math.floor((x + RS.half) / C), cj = Math.floor((z + RS.half) / C); if (ci < 0 || cj < 0 || ci >= RS.nC || cj >= RS.nC) return false; const c = cj * RS.nC + ci, S = RS.seg;
    for (let k = RS.start[c]; k < RS.start[c + 1]; k++) { const o = RS.ids[k] * 9; if (!(S[o + 7] & 8)) continue; const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < S[o + 6] + 1 && Math.abs(S[o + 4] + (S[o + 5] - S[o + 4]) * t - y) < 8) return true; } return false; };
  const onGround = (x, z, y) => !(RS.q(x, z, true, y + 1) && Math.abs(RS.y - y) < 1.5) && !tube(x, z, y);
  const each = (v, fn) => { // sample points on a triangle, ~2 m apart: fn(x, z, y)
    const e = Math.max(Math.hypot(v[3] - v[0], v[5] - v[2]), Math.hypot(v[6] - v[0], v[8] - v[2]), Math.hypot(v[6] - v[3], v[8] - v[5])), k = Math.max(1, Math.ceil(e / 2));
    for (let a = 0; a <= k; a++) for (let b = 0; a + b <= k; b++) { const wa = (a + 0.33) / (k + 1), wb = (b + 0.33) / (k + 1), wc = 1 - wa - wb; if (wc >= 0) fn(v[0] * wc + v[3] * wa + v[6] * wb, v[2] * wc + v[5] * wa + v[8] * wb, v[1] * wc + v[4] * wa + v[7] * wb); }
  };
  const tally = (L, x, z, d) => { const o = (out[L] ??= { n: 0, over: 0, worst: 0, at: null, spots: [] }); o.n++; if (d <= OVER) return; o.over++; if (d > o.worst) { o.worst = d; o.at = [Math.round(x), Math.round(z)]; } if (!o.spots.some((s) => Math.hypot(s[0] - x, s[1] - z) < 40)) o.spots.push([x, z]); };
  for (const v of tris) {
    if (Math.abs(v[0]) > lim || Math.abs(v[2]) > lim) continue;
    each(v, (x, z, y) => { if (!onGround(x, z, y)) return; tally('patch', x, z, w.triAt(w.Hh, w.hR + 1, (x + half) / w.hStep, (z + half) / w.hStep) - y); tally('coarse', x, z, w.sampleCoarse(x, z) - y); });
  }
  // the detail mesh, built round a few road points (the most bent part of the busiest roads: junctions, switchbacks)
  const roads = w.net.roads.filter((r) => r.kind !== 'rail' && r.pts.length > 10 && !r.tunnel), D = w.detailD, DS = w.detailS, n = D + 1, B = 4;
  for (let s = 0; s < spots && roads.length; s++) {
    const r = roads[(s * 7919) % roads.length], p = r.pts[(s * 31) % r.pts.length]; if (Math.abs(p.x) > w.half - 1500 || Math.abs(p.z) > w.half - 1500) continue;
    const cp = { x: p.x, y: w.sampleGrid(p.x, p.z) + 3, z: p.z }; w.detailAt = null; w.patchAt = null; w.updatePatch(cp); w.updateDetail(cp); if (!w.detail.visible) continue;
    const P = w.detail.geometry.attributes.position.array, x0 = P[0], z0 = P[2];
    const det = (x, z) => { const fx = (x - x0) / DS, fz = (z - z0) / DS; if (fx < B || fz < B || fx >= D - B || fz >= D - B) return null; const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, vv = fz - j, h = (a, b) => P[((j + b) * n + i + a) * 3 + 1];
      return u + vv <= 1 ? h(0, 0) + (h(1, 0) - h(0, 0)) * u + (h(0, 1) - h(0, 0)) * vv : h(1, 1) + (h(0, 1) - h(1, 1)) * (1 - u) + (h(1, 0) - h(1, 1)) * (1 - vv); };
    for (const v of tris) { if (Math.abs(v[0] - p.x) > D * DS / 2 || Math.abs(v[2] - p.z) > D * DS / 2) continue; each(v, (x, z, y) => { const g = det(x, z); if (g != null && onGround(x, z, y)) tally('detail', x, z, g - y); }); }
  }
  out.tris = tris.length * stride;
  return out;
}

// A city's open ground (the lots, plazas, pedestrian streets and strips between the pavements and the buildings: what the
// land cover leaves paved and no road covers) as physics stands on it (sampleGrid), sampled out from both sides of the
// streets round Manhattan, square to them: from the kerb out past the pavement (roadgrade.js PAVE) to 20 m.
//   level:  just past the pavement the ground is the slabs' top (the street's height + the kerb, CITY_TOP), not
//           sunken under it (it was 0.2-1.5 m below: walls stood on a ledge, the slabs floated over it);
//   smooth: from the tarmac's edge outward no step (no kerb or ledge in physics: a car rolls up onto the pavement);
//   paved:  groundAt says it's paved (the tyres, the dust).
// (Only where nothing else is: not inside another road's footprint, a building's box or a park; the street's
// grade away from a junction, so the street beside it is this one.)
export function cityGroundCheck(w, { x0 = -9000, x1 = -3000, z0 = 4000, z1 = 12000 } = {}) {
  const S = w.roadSurf, out = { n: 0, low: 0, high: 0, steps: 0, lines: 0, paved: 0, worst: 0, at: '', wstep: 0, sat: '' }, top = 0.18, boxes = []; // (top: roadgrade.js CITY_TOP)
  const PAVE = { main: 4.5, street: 3.5 }, free = (x, z) => w.real.bare(x, z) && !(S.q(x, z) && S.e <= 0) && !w.wallBoxes(x, z, 0.5, boxes).some((b) => { const dx = x - b.x, dz = z - b.z; return Math.abs(dx * b.ux + dz * b.uz) < b.hl + 0.5 && Math.abs(-dx * b.uz + dz * b.ux) < b.hw + 0.5; });
  for (const rd of w.net.roads) {
    if (rd.kind === 'highway' || rd.baked || rd.tunnel || rd.kind === 'rail') continue;
    const P = rd.pts, hw = rd.width / 2, pv = PAVE[rd.kind] ?? 3.5, J = new Set((rd.jn || []).map(([j]) => j));
    for (let i = 2; i + 2 < P.length; i += 3) {
      const p = P[i]; if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1 || rd.bridge?.[i] || rd.tube?.[i]) continue;
      if ([...J].some((j) => Math.abs(j - i) <= 3)) continue; // (away from its junctions)
      const a = P[i - 1], b = P[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1, rx = -(b.z - a.z) / L, rz = (b.x - a.x) / L;
      if (Math.abs(b.y - a.y) / L > 0.06) continue; // (a steep street: its pavement's own grade)
      for (const sd of [-1, 1]) {
        // smooth: kerb to 20 m out, every 0.5 m, until something else (a building, another road, a park) is there. Not
        // where the street is on an embankment or in a cutting (the mapped heights 10 m out more than 1.5 m off it: a
        // slope there is real)
        if (Math.abs(w.rawHeight(p.x + rx * (hw + 10) * sd, p.z + rz * (hw + 10) * sd) - p.y) > 1.5) continue;
        let prev = null, o = hw;
        for (; o <= hw + pv + 20; o += 0.5) {
          const x = p.x + rx * o * sd, z = p.z + rz * o * sd;
          if (o > hw + 1.5 && !free(x, z)) break;
          const g = w.sampleGrid(x, z);
          if (prev != null && Math.abs(g - prev) > STEP_CITY) { out.steps++; if (Math.abs(g - prev) > out.wstep) { out.wstep = Math.abs(g - prev); out.sat = `${x.toFixed(0)}, ${z.toFixed(0)}`; } break; }
          prev = g;
        }
        out.lines++;
        // level just past the pavement
        const oo = hw + pv + 1, x = p.x + rx * oo * sd, z = p.z + rz * oo * sd;
        if (o <= oo || !free(x, z)) continue;
        const d = w.sampleGrid(x, z) - (p.y + top); out.n++;
        if (d < -0.15) out.low++; else if (d > 0.3) out.high++;
        if (Math.abs(d) > Math.abs(out.worst)) { out.worst = d; out.at = `${x.toFixed(0)}, ${z.toFixed(0)}`; }
        if (w.groundAt(x, z).type === 'runway') out.paved++;
      }
    }
  }
  return out;
}

export function measure(w) {
  const roads = w.net.roads.filter((r) => r.kind !== 'rail'), lim = w.half - 200, inCore = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim;
  const isDeck = (rd, i) => !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % rd.pts.length]);
  const out = { km: 0, steps: [], steep: [], joins: [], crossings: [] }, nodes = new Map();
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
    // junctions (roads.bin topology, rd.jn): every road through a node meets the others there (checked below, once
    // per node); roads without topology (the airport road): an end on another road's line meets it
    if (!rd.jn && !rd.closed) for (const [e, ie] of [[P[0], 0], [P[n - 1], n - 2]]) {
      if (!inCore(e.x, e.z) || isDeck(rd, ie)) continue;
      let bd = SNAP, y = null, deck = false;
      near(e.x, e.z, (sg) => {
        if (sg.ri === ri) return;
        const { a, b } = sg, ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((e.x - a.x) * ex + (e.z - a.z) * ez) / L2));
        const d = Math.hypot(a.x + ex * t - e.x, a.z + ez * t - e.z); if (d < bd) { bd = d; y = a.y + (b.y - a.y) * t; deck = sg.deck; }
      });
      if (y != null && !deck && Math.abs(y - e.y) > JOIN) spot(out.joins, e.x, e.z, Math.abs(y - e.y), rd.kind);
    }
    for (const [j, nd] of rd.jn || []) { const p = P[j]; if (!inCore(p.x, p.z)) continue; const q = nodes.get(nd); if (!q) nodes.set(nd, { y: p.y, x: p.x, z: p.z, br: !!rd.bridge?.[j] }); else if (!q.br && !rd.bridge?.[j] && Math.abs(q.y - p.y) > JOIN) spot(out.joins, p.x, p.z, Math.abs(q.y - p.y), rd.kind); }
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
        if (d > JOIN && (d < 3 || !(rd.jn && roads[sg.ri].jn))) spot(out.crossings, a.x + dx * t, a.z + dz * t, d, rd.kind); // (with topology: crossing without a shared node is an over- or underpass; only a near-level clash counts)
      });
    }
  });
  return out;
}

// #228: the traffic models face the way they drive. The shipped vehicles.glb, as src/trafficModels.js orient() turns it:
// the taxi is the police car's body (same pack), so the two must agree (wheels and lamps where the other has them),
// and every model's head lamps are at its front (-Z).
export async function modelsCheck() {
  const { readFileSync } = await import('node:fs'), { orient, BACKWARDS } = await import('../../src/trafficModels.js');
  const b = readFileSync(new URL('../../assets/traffic/vehicles.glb', import.meta.url)), n = b.readUInt32LE(12), ex = JSON.parse(b.subarray(20, 20 + n).toString()).scenes[0].extras;
  const m = orient(ex), P = m.police, T = m.taxi, zs = (q) => q.wheels.map((w) => w[2]).sort((a, b) => a - b);
  const wz = Math.max(...zs(P).map((z, i) => Math.abs(z - zs(T)[i]))), lamp = Math.max(Math.abs(P.head[0][1] - T.head[0][1]), Math.abs(P.tail[0][1] - T.tail[0][1]));
  const front = Object.entries(m).filter(([, q]) => !(q.head[0][2] < 0 && q.tail[0][2] > 0)).map(([id]) => id);
  return [
    { name: 'traffic: the taxi faces the way the police car (its body) does', ok: wz < 0.1 && lamp < 0.1, why: `wheels ${wz.toFixed(2)} m apart along the car, lamps ${lamp.toFixed(2)} m apart in height (file revision ${ex.rev ?? 1}: turned round ${(BACKWARDS[ex.rev ?? 1] || []).join(', ') || 'none'})` },
    { name: 'traffic: every model has its head lamps at the front (-Z)', ok: !front.length, why: front.join(', ') },
  ];
}

// #228: traffic near the camera in New York at night, drawn into a BatchedMesh with stand-in models (a box for a few
// types; the rest have none, and the body pool is small enough to fill): every pair of head and tail lamps belongs to
// a car body drawn there, faces the way its car drives, and cars don't drive through each other (two cars' footprints
// overlapping for over 2 s: a car that didn't see the other).
export async function safetyCheck(w) {
  const THREE = await import('three'), { Vehicles } = await import('../../src/vehicles.js'), { toLocal } = await import('../../src/realworld.js');
  const V = new Vehicles(new THREE.Scene(), w); V.disposed = true; // (the stand-ins stay: the real models never arrive in Node, and mustn't replace them if they did)
  const types = ['sedan', 'taxi', 'suv', 'hatch', 'compact'], meta = {}, geo = {}, box = () => new THREE.BoxGeometry(1.9, 1.4, 4.6).translate(0, 0.7, 0);
  for (const t of types) { meta[t] = { L: 4.6, W: 1.9, H: 1.4, wheels: [], head: [[-0.6, 0.7, -2.3], [0.6, 0.7, -2.3]], tail: [[-0.6, 0.8, 2.3], [0.6, 0.8, 2.3]] }; geo[t] = { lod: [box(), box(), box()], wheels: [] }; }
  V.buildBatch({ meta, geo, material: new THREE.MeshBasicMaterial() });
  const [x, z] = toLocal(w.real.meta, 40.7531, -73.9810), cam = new THREE.Vector3(x, w.sampleGrid(x, z) + 3, z), wasNight = w.night; w.night = true;
  const B = V.batch, S = V.slots, m4 = new THREE.Matrix4(), bp = new THREE.Vector3(), p = new THREE.Vector3(), d = new THREE.Vector3();
  const out = { groups: 0, ghost: 0, faced: 0, back: 0, samples: 0, pairs: 0, long: 0, worst: 0, cars: 0, still: 0, moving: 0, ex: [] }, run = new Map(), first = new Map();
  const desc = (pr) => pr.map(({ c, x, z }) => `${c.path.transient ? 'turn at ' + c.path.node : c.path.from + '>' + c.path.to} s ${c.s.toFixed(1)}/${c.path.total.toFixed(0)} v ${c.v.toFixed(1)} at ${x.toFixed(0)},${z.toFixed(0)}`).join(' and ');
  const DT = 1 / 30, EVERY = 6, LONG = 2 / (DT * EVERY);
  try {
    for (let k = 0; k < 30 * 45; k++) {
      V.update(DT, cam);
      if (k < 30 * 8 || k % EVERY) continue;
      out.samples++;
      // bodies drawn (positions), and the moving cars' places and headings
      const bodies = []; for (let i = 0; i < V.nbLast; i++) { B.getMatrixAt(S[i], m4); bodies.push(bp.setFromMatrixPosition(m4).clone()); }
      const cars = V.cars.filter((c) => !c.path.loop && c.path.pts).map((c) => { V.pathPoint(c.path, c.s, p, d); return { c, x: p.x, z: p.z, dx: d.x, dz: d.z, L: V.model(c.type).L, W: V.model(c.type).W }; });
      const near = cars.filter((q) => Math.hypot(q.x - cam.x, q.z - cam.z) < 400); out.cars += near.length; for (const q of near) { if (q.c.v < 0.3) out.still++; else out.moving++; }
      // lamps: four a car (head, head, tail, tail), packed
      const LP = V.lp;
      for (let g = 0; g + 3 < V.lightsOn; g += 4) {
        const o = g * 3, hx = (LP[o] + LP[o + 3]) / 2, hz = (LP[o + 2] + LP[o + 5]) / 2, tx = (LP[o + 6] + LP[o + 9]) / 2, tz = (LP[o + 8] + LP[o + 11]) / 2, cx = (hx + tx) / 2, cz = (hz + tz) / 2;
        out.groups++;
        if (!bodies.some((b) => Math.hypot(b.x - cx, b.z - cz) < 1)) { out.ghost++; continue; }
        const car = near.find((q) => Math.hypot(q.x - cx, q.z - cz) < 0.3); if (!car) continue;
        if ((hx - tx) * car.dx + (hz - tz) * car.dz > 0) out.faced++; else out.back++;
      }
      // footprints (oriented rectangles, 90% of the car: bumpers may touch) overlapping
      const C = 12, cell = new Map(), seen = new Set();
      near.forEach((q, i) => { const key = Math.floor(q.x / C) + ',' + Math.floor(q.z / C); let a = cell.get(key); if (!a) cell.set(key, (a = [])); a.push(i); });
      const hit = (a, b) => { const ax = [[a.dx, a.dz, a.L * 0.45], [-a.dz, a.dx, a.W * 0.45]], bx = [[b.dx, b.dz, b.L * 0.45], [-b.dz, b.dx, b.W * 0.45]], tx = b.x - a.x, tz = b.z - a.z;
        for (const [ux, uz] of [...ax, ...bx]) { const pa = Math.abs(ax[0][0] * ux + ax[0][1] * uz) * ax[0][2] + Math.abs(ax[1][0] * ux + ax[1][1] * uz) * ax[1][2], pb = Math.abs(bx[0][0] * ux + bx[0][1] * uz) * bx[0][2] + Math.abs(bx[1][0] * ux + bx[1][1] * uz) * bx[1][2]; if (Math.abs(tx * ux + tz * uz) > pa + pb) return false; }
        return true; };
      const now = new Set(), what = new Map();
      near.forEach((a, i) => { const ci = Math.floor(a.x / C), cj = Math.floor(a.z / C); for (let u = ci - 1; u <= ci + 1; u++) for (let v = cj - 1; v <= cj + 1; v++) for (const j of cell.get(u + ',' + v) || []) {
        if (j <= i) continue; const b = near[j]; if (Math.hypot(a.x - b.x, a.z - b.z) > 8 || !hit(a, b)) continue;
        const key = a.c === b.c ? null : (V.cars.indexOf(a.c) + ':' + V.cars.indexOf(b.c)); if (!key || seen.has(key)) continue; seen.add(key); now.add(key); what.set(key, [a, b]);
      } });
      for (const key of now) { const n = (run.get(key) || 0) + 1; run.set(key, n); if (n === 1) { out.pairs++; first.set(key, desc(what.get(key))); } if (n === Math.ceil(LONG)) { out.long++; if (out.ex.length < 6) out.ex.push(`${first.get(key)}, 2 s later ${desc(what.get(key))}`); } out.worst = Math.max(out.worst, n * DT * EVERY); }
      for (const key of [...run.keys()]) if (!now.has(key)) run.delete(key);
    }
  } finally { w.night = wasNight; }
  return out;
}

// #228: posts stand off the roads. Every traffic light's pole (signals.js, at every signalled junction) and the street
// lamps' posts round Midtown (roads.js, the tiles within 700 m built): how many stand on a road's carriageway (closer to
// a road's centre line than its half width; bridge decks and tunnels aside: they're above or below).
export async function postsCheck(w) {
  const THREE = await import('three'), { LaneGraph } = await import('../../src/laneGraph.js'), { Signals } = await import('../../src/signals.js'), { toLocal } = await import('../../src/realworld.js');
  const C = 20, cells = new Map();
  for (const rd of w.net.roads) { if (rd.kind === 'rail') continue; const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { if ((rd.bridge?.[i] && rd.bridge?.[i + 1]) || (rd.tube?.[i] && rd.tube?.[i + 1])) continue; const a = P[i], b = P[i + 1]; const i0 = Math.floor(Math.min(a.x, b.x) / C), i1 = Math.floor(Math.max(a.x, b.x) / C), j0 = Math.floor(Math.min(a.z, b.z) / C), j1 = Math.floor(Math.max(a.z, b.z) / C); for (let u = i0; u <= i1; u++) for (let v = j0; v <= j1; v++) { const k = u + ',' + v; let L = cells.get(k); if (!L) cells.set(k, (L = [])); L.push([a, b, rd.width / 2]); } } }
  const onRoad = (x, z) => { for (const [a, b, hw] of cells.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || []) { const ex = b.x - a.x, ez = b.z - a.z, l = ex * ex + ez * ez, t = l ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l)) : 0; if (Math.hypot(a.x + ex * t - x, a.z + ez * t - z) < hw) return true; } return false; };
  const S = new Signals(new LaneGraph(w.net), { city: !!w.loc.city }); let sig = 0, sigOn = 0; const ex = [];
  for (const n of S.nodes.values()) { S.pole(n); sig++; if (onRoad(n.px, n.pz)) { sigOn++; if (ex.length < 3) ex.push(`(${Math.round(n.x)}, ${Math.round(n.z)})`); } }
  const [x, z] = toLocal(w.real.meta, 40.7531, -73.9810), G = w.roadGroup.userData, m4 = new THREE.Matrix4(), p = new THREE.Vector3();
  G.update({ x, y: 0, z }, 0, 700);
  let lamps = 0, lampsOn = 0; const lex = [];
  for (const t of G.tiles) if (t.built && Math.hypot(t.x - x, t.z - z) < 1000) for (const m of t.meshes) if (m.isInstancedMesh) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); p.setFromMatrixPosition(m4); lamps++; if (onRoad(p.x, p.z)) { lampsOn++; if (lex.length < 3) lex.push(`(${Math.round(p.x)}, ${Math.round(p.z)})`); } }
  return { sig, sigOn, lamps, lampsOn, ex, lex };
}

export async function runCase(c, ctx) {
  if (c.models) return modelsCheck();
  const { worldAt } = await import('./node/world.mjs');
  const w = (await worldAt(c.loc)).world;
  if (c.tunnel) { // a car driven into the place's longest tunnel stays on its floor, under the hill or the river, in one piece
    const THREE = await import('three'), { Aircraft, REALISM } = await import('../../src/aircraft.js'), { envOf } = await import('./node/world.mjs');
    const env = envOf(w); let best = null;
    w.net.roads.forEach((r) => { if (!r.tube) return; const a = r.tube.indexOf(true), b = r.tube.lastIndexOf(true); if (a > 3 && (!best || b - a > best.b - best.a)) best = { r, a, b }; });
    if (!best) return [{ name: `${c.loc}: a car drives through a tunnel`, ok: false, why: 'no tunnel' }];
    const { r, a } = best, P = r.pts, i0 = a - 5, d = new THREE.Vector3().subVectors(P[i0 + 1], P[i0]).setY(0).normalize();
    const ac = new Aircraft(ctx.presets.find((x) => x.name === 'Dune Buggy'), REALISM.pilot); ac.spawn(env, new THREE.Vector3(P[i0].x, P[i0].y + 1, P[i0].z), Math.atan2(-d.x, -d.z));
    let inTube = 0, above = 0, off = 0;
    for (let k = 0; k < 60 * 20; k++) {
      let bi = 0, bd = 1e9; for (let i = 0; i < P.length; i++) { const dd = (P[i].x - ac.x.x) ** 2 + (P[i].z - ac.x.z) ** 2; if (dd < bd) { bd = dd; bi = i; } }
      const t = P[Math.min(P.length - 1, bi + 3)], f = ac.forward, e = Math.atan2(Math.sin(Math.atan2(-(t.x - ac.x.x), -(t.z - ac.x.z)) - Math.atan2(-f.x, -f.z)), Math.cos(Math.atan2(-(t.x - ac.x.x), -(t.z - ac.x.z)) - Math.atan2(-f.x, -f.z)));
      ac.setControls({ throttle: 0.5, roll: Math.max(-1, Math.min(1, -e * 2)), pitch: 0, yaw: 0, rev: 0, hand: 0 }); ac.step(1 / 60, env);
      off = Math.max(off, Math.sqrt(bd)); if (r.tube[bi]) { inTube++; above = Math.max(above, ac.x.y - P[bi].y); }
    }
    const alive = ac.parts.filter((q) => q.alive).length;
    return [{ name: `${c.loc}: a car drives through a tunnel on its floor`, ok: inTube > 300 && above < 2.5 && alive === ac.parts.length, why: `${inTube} steps in the tube, at most ${above.toFixed(2)} m over its floor, ${alive}/${ac.parts.length} parts, ${off.toFixed(1)} m off the line` }];
  }
  if (c.posts) {
    const o = await postsCheck(w);
    return [
      { name: `${c.loc}: traffic light poles stand off the roads`, ok: o.sig > 100 && o.sigOn <= 0.01 * o.sig, why: `${o.sigOn} of ${o.sig} on a carriageway (at most 1%: a road not joined to the junction there)${o.ex.length ? ', e.g. ' + o.ex.join(' ') : ''}` },
      { name: `${c.loc}: street lamps stand off the roads`, ok: o.lamps > 50 && o.lampsOn <= 0.03 * o.lamps, why: `${o.lampsOn} of ${o.lamps} posts round Midtown on a carriageway (at most 3%: beside a stack of parallel ramps a post can't miss them all; #228: half of them were in the junctions)${o.lex.length ? ', e.g. ' + o.lex.join(' ') : ''}` },
    ];
  }
  if (c.safety) {
    const o = await safetyCheck(w), lamps = o.groups / Math.max(1, o.samples);
    return [
      { name: `${c.loc}: car lamps only on cars that are drawn`, ok: o.groups > 0 && !o.ghost, why: `${o.ghost} of ${o.groups} lamp sets with no body (${lamps.toFixed(0)} cars lit a frame)` },
      { name: `${c.loc}: traffic faces the way it drives`, ok: o.faced > 100 && !o.back, why: `${o.back} of ${o.faced + o.back} cars backwards` },
      { name: `${c.loc}: cars don't drive through each other`, ok: o.long <= 0.02 * o.cars / o.samples, why: `${o.long} pairs of cars overlapping for over 2 s (worst ${o.worst.toFixed(1)} s), ${o.pairs} overlaps in all, ~${(o.cars / o.samples).toFixed(0)} cars within 400 m, ${(100 * o.still / Math.max(1, o.still + o.moving)).toFixed(0)}% standing${o.ex.length ? '; e.g. ' + o.ex.slice(0, 2).join('; ') : ''}` },
    ];
  }
  if (c.pack) { // the deploy's road pack (roadPack.js) gives back exactly the roads it was made from
    const { encodeRoads, decodeRoads } = await import('../../src/roadPack.js'), roads = w.net.roads, P = decodeRoads(encodeRoads(roads, 'test'));
    let worst = 0, bad = 0;
    roads.forEach((rd, k) => { const q = P.roads[k];
      if (!q || q.pts.length !== rd.pts.length || q.kind !== rd.kind || q.oneway !== (rd.oneway || 0) || JSON.stringify(q.jn) !== JSON.stringify(rd.jn || []) || q.bridge.some((b, i) => b !== !!rd.bridge?.[i])) { bad++; return; }
      rd.pts.forEach((p, i) => { worst = Math.max(worst, Math.abs(p.x - q.pts[i].x), Math.abs(p.y - q.pts[i].y), Math.abs(p.z - q.pts[i].z)); }); });
    return [{ name: `${c.loc}: the road pack gives back its roads`, ok: !bad && worst < 0.011 && P.key === 'test', why: `${bad} roads differ, points within ${(worst * 100).toFixed(1)} cm` }];
  }
  if (c.traffic) { // the cars drive the road graph (laneGraph.js): onto the next road at a junction, turning round only at a dead end
    const THREE = await import('three'), { Vehicles } = await import('../../src/vehicles.js');
    const V = new Vehicles(new THREE.Scene(), w), G = V.graph, orig = G.next.bind(G); let on = 0, back = 0, none = 0;
    G.next = (L) => { const N = orig(L); if (!N) none++; else if (N === L.rev) back++; else on++; return N; };
    let still = 0, seen = 0;
    for (let k = 0; k < 60 * 20; k++) { V.update(1 / 20, null); if (k > 400 && k % 20 === 0) for (const q of V.cars) if (!q.path.loop && !q.path.transient) { seen++; if (q.v < 0.5) still++; } }
    const moves = on + back + none, lights = V.signals.nodes.size, city = !!w.loc.city;
    return [
      { name: `${c.loc}: traffic turns onto the next road at junctions`, ok: moves > 20 && back / moves < 0.15, /* (Bora Bora has many real dead ends; before #252 every road's end was a U-turn) */ why: `${on} onto another road, ${back} turned round at a dead end, ${none} with nowhere to go (${G.lanes.length} lanes, 60 s)` },
      { name: `${c.loc}: traffic rarely has nowhere to go`, ok: none / Math.max(1, moves) < 0.02, why: `${none} of ${moves}` },
      { name: `${c.loc}: ${city ? 'traffic lights hold the cars at red, not for ever' : 'no traffic lights out of town'}`, ok: city ? lights > 100 && still / seen > 0.05 && still / seen < 0.6 : !lights, why: `${lights} signalled junctions; cars standing ${(100 * still / Math.max(1, seen)).toFixed(0)}% of the time` },
    ];
  }
  if (c.bleed) {
    const b = bleedCheck(w, { stride: c.loc === 'nyc' ? 8 : 1 }), pc = (o) => `${(100 * o.over / Math.max(1, o.n)).toFixed(3)}%`;
    return ['detail', 'patch', 'coarse'].map((L) => { const o = b[L] || { n: 0, over: 0, worst: 0, spots: [] };
      return { name: `${c.loc}: the ${L === 'detail' ? 'near-camera detail' : L === 'patch' ? 'patch' : 'coarse'} ground stays under the road`, ok: o.n > 1000 && o.over / o.n < BLEED, why: `${pc(o)} of ${o.n} road samples under ground by more than ${OVER} m (${o.spots.length} spots${L === 'detail' ? `; ${b.tris} road triangles` : ''})${o.over ? `, worst ${o.worst.toFixed(2)} m at (${o.at})` : ''}` }; });
  }
  if (c.cityGround) {
    const o = cityGroundCheck(w), pc = (v) => `${(100 * v / Math.max(1, o.n)).toFixed(1)}%`;
    return [
      { name: `${c.loc}: open ground beside the streets at the pavements' level`, ok: o.n > 2000 && o.low <= 0.03 * o.n && o.high <= 0.03 * o.n, why: `${o.n} spots just past a pavement: ${pc(o.low)} more than 0.15 m under the slabs' top, ${pc(o.high)} more than 0.3 m over it (at most 3% each); worst ${o.worst.toFixed(2)} m at (${o.at})` },
      { name: `${c.loc}: no step from the street onto the open ground`, ok: o.lines > 4000 && o.steps <= 0.03 * o.lines, why: `${o.steps} of ${o.lines} lines out from the kerb step more than ${STEP_CITY} m in 0.5 m (at most 3%, was 65%: a kerb is 0.15 m; what is left, a street beside a highway in a cutting, a hillside)${o.steps ? `, worst ${o.wstep.toFixed(2)} m at (${o.sat})` : ''}` },
      { name: `${c.loc}: the open ground is paved`, ok: o.paved >= 0.97 * o.n, why: `${o.paved} of ${o.n} (World.groundAt: 'runway', not grass)` },
    ];
  }
  if (c.detail) {
    const d = detailCheck(w);
    return [
      { name: `${c.loc}: ground detail shown at road level`, ok: d.shown > 0, why: `${d.shown} of 4 spots` },
      { name: `${c.loc}: ground detail is the ground driven on`, ok: d.inner < 0.01 && d.above < 0.001, why: `away from the roads worst ${d.inner.toFixed(3)} m off sampleGrid; at most ${d.above.toFixed(3)} m above it` },
      { name: `${c.loc}: ground detail meets the patch at its edge`, ok: d.edge < 0.01, why: `worst ${d.edge.toFixed(3)} m` },
      { name: `${c.loc}: ground detail rebuilds in under 50 ms`, ok: d.ms < 50, why: `median ${d.ms.toFixed(1)} ms (Node, Low; a few ms on a laptop: this catches a rebuild gone 10x slower, not a slow machine)` },
    ];
  }
  const m = measure(w);
  const worst = (L, unit) => { const s = [...L].sort((p, q) => q.v - p.v).slice(0, 3); return s.map((p) => `(${p.x}, ${p.z}) ${unit(p.v)}`).join('; '); };
  const m1 = (v) => `${v.toFixed(2)} m`, pc = (v) => `${Math.round(v * 100)}%`;
  return [
    { name: `${c.loc}: no steps along the roads`, ok: !m.steps.length, why: m.steps.length ? `${m.steps.length} spots, worst ${worst(m.steps, m1)}` : `${m.km.toFixed(0)} km` },
    { name: `${c.loc}: no walls or ramps on the roads`, ok: !m.steep.length, why: m.steep.length ? `${m.steep.length} spots steeper than ${pc(STEEP)}, worst ${worst(m.steep, pc)}` : '' },
    { name: `${c.loc}: road ends meet the road they join`, ok: !m.joins.length, why: m.joins.length ? `${m.joins.length} ends off by more than ${JOIN} m, worst ${worst(m.joins, m1)}` : '' },
    { name: `${c.loc}: roads cross at the same height`, ok: !m.crossings.length, why: m.crossings.length ? `${m.crossings.length} crossings off by more than ${JOIN} m, worst ${worst(m.crossings, m1)}` : '' },
  ];
}
