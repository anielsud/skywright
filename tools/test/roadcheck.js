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
export const nodeSuite = { files: ['src/roads.js', 'src/roadgrade.js', 'src/realworld.js', 'src/world.js', 'src/roadnet.js', 'src/roadPack.js', 'src/junctions.js', 'src/roadSurface.js', 'src/vehicles.js', 'src/laneGraph.js', 'src/signals.js', 'src/trafficModels.js', 'tools/test/roadcheck.js'] }; // (and the ground detail: detailCheck)

import { layoutWanted } from '../../src/layout/format.js';

const PLACES = ['islands', 'canyon', 'lauterbrunnen', 'nyc'];
const STEP = 0.35, STEEP = 0.45, JOIN = 0.3, SNAP = 3, STEP_CITY = 0.12, STEP_W = 5;
// the ground detail's rebuild work caps (detailCheck): vertices (97 x 97 = 9409 now), road lookups per vertex (1 now),
// segments + junction boxes tested per vertex (worst rebuild now: islands 5.3, canyon 2.9, lauterbrunnen 6.0, nyc 7.8)
const DETAIL_VERTS = 12000, DETAIL_Q = 1.5, DETAIL_TESTS = 24;

// today's path, removed with it: the cases that measure today's load-time road internals (the detail, patch and coarse
// ground layers under the roads, junction boxes, pavement slabs and the open ground just past them), which the baked
// layout (#294) replaces where its chunks are: only with the layout off (SKY_LAYOUT=0)
const TODAY_ONLY = ['bleed', 'detail', 'junctions', 'pavements', 'cityGround'];
export function cases() { return [...PLACES.map((loc) => ({ id: loc, loc, world: loc, cost: loc === 'nyc' ? 600 : 60 }) /* (the whole map's roads on the layout: every chunk meshed, node/world.mjs lazyLayout) */), ...PLACES.map((loc) => ({ id: `${loc} ground detail`, loc, world: loc, detail: true, cost: 3 })), ...PLACES.map((loc) => ({ id: `${loc} traffic`, loc, world: loc, traffic: true, cost: 3 })), { id: 'nyc traffic safety', loc: 'nyc', world: 'nyc', safety: true, cost: 12 }, { id: 'nyc posts', loc: 'nyc', world: 'nyc', posts: true, cost: 6 }, { id: 'traffic models face forward', models: true, cost: 0.2 }, ...PLACES.map((loc) => ({ id: `${loc} road pack`, loc, world: loc, pack: true, cost: 2 })), ...['lauterbrunnen', 'nyc'].map((loc) => ({ id: `${loc} tunnel drive`, loc, world: loc, tunnel: true, cost: 6 })), ...PLACES.map((loc) => ({ id: `${loc} ground under the road`, loc, world: loc, bleed: true, cost: loc === 'nyc' ? 30 : 12 })), { id: 'nyc open ground', loc: 'nyc', world: 'nyc', cityGround: true, cost: 6 }, ...['lauterbrunnen', 'nyc'].map((loc) => ({ id: `${loc} junctions`, loc, world: loc, junctions: true, cost: loc === 'nyc' ? 40 : 10 })), ...PLACES.map((loc) => ({ id: `${loc} off the street network`, loc, world: loc, minor: true, cost: loc === 'nyc' ? 400 : 60 })), { id: 'nyc pavements', loc: 'nyc', world: 'nyc', pavements: true, cost: 20 }].filter((c) => !layoutWanted() || !TODAY_ONLY.some((k) => c[k])); }

// The ways off the street network (roads.js rd.minor: pedestrian streets, paved footpaths, alleys and service roads,
// tracks) and the plazas (net.areas), every place: they are there (at least MINOR_MIN of each), drawn (the road
// meshes: a ribbon or a plaza's fill over the sampled spot, at the ground physics stands on), drivable (World.groundAt
// on them: paved, a track's gravel loose; a car driven along one stays on it, in one piece), and carry no traffic
// (no lane of laneGraph.js on them, no junction box with one as an arm, no car of a running Vehicles on one away from
// the streets).
const MINOR_ROUGH = { joins: 0.03, steps: 0.4, steep: 1.5 }; // (a km, on adding them: Lauterbrunnen 1.24 steep spots, Bora Bora's hillside drives 0.66; New York 0.021 joins or crossings off, all under half a metre. Steps off the way's grade (measure), today's roads: Bora Bora 0.24, Lauterbrunnen 0.21, New York 0.18, the canyon 0.03; counted as any 1 m rise over STEP, before #294, they were 1.21, 0.77 and 0.67 under a 1.5 limit)
const MINOR_MIN = { nyc: { ped: 1000, service: 2000, plazas: 50 }, lauterbrunnen: { ped: 100, service: 1000, track: 1000, plazas: 20 }, islands: { service: 50, track: 20 }, canyon: { service: 100, track: 100 } };
async function minorCheck(w, c, ctx) {
  const THREE = await import('three'), { LaneGraph } = await import('../../src/laneGraph.js'), { junctionPlan } = await import('../../src/junctions.js'), { Vehicles } = await import('../../src/vehicles.js'), { envOf } = await import('./node/world.mjs');
  const M = w.net.roads.filter((r) => r.minor), A = w.net.areas || [], count = { plazas: A.length };
  for (const r of M) count[r.kind] = (count[r.kind] || 0) + 1;
  const want = MINOR_MIN[c.loc] || {}, short = Object.entries(want).filter(([k, n]) => (count[k] || 0) < n).map(([k, n]) => `${k} ${count[k] || 0} < ${n}`);
  // the spots: a point on the ground along a few hundred minor ways (not a bridge's), and inside each plaza
  const lim = w.half - 300, spots = [];
  for (let k = 0; k < M.length && spots.length < 300; k += Math.max(1, Math.floor(M.length / 300))) {
    const r = M[k], i = r.pts.length >> 1, j = Math.min(r.pts.length - 1, i + 1), p = r.pts[i].clone().lerp(r.pts[j], 0.5); if (r.bridge?.[i] || r.bridge?.[j] || Math.abs(p.x) > lim || Math.abs(p.z) > lim) continue;
    // (only where it is the one road there, the segment's four corners too: not where it overlaps a street or another
    // way, where the surface is their blend, RoadSurface.blend, and the ribbon's corners follow it)
    const a = r.pts[i], b = r.pts[j], dl = Math.hypot(b.x - a.x, b.z - a.z) || 1, rx = -(b.z - a.z) / dl * r.width / 2, rz = (b.x - a.x) / dl * r.width / 2;
    if ([[p.x, p.z], [a.x + rx, a.z + rz], [a.x - rx, a.z - rz], [b.x + rx, b.z + rz], [b.x - rx, b.z - rz]].some(([x, z]) => w.roadSurf.q(x, z) && w.roadSurf.nIn > 1)) continue;
    spots.push({ x: p.x, z: p.z, surf: r.surf || 0, what: r.kind, first: r.pts[0] });
  }
  const inPoly = (R, x, z) => { let c = false; for (let i = 0, n = R.length / 2, j = n - 1; i < n; j = i++) { const xi = R[i * 2], zi = R[i * 2 + 1], xj = R[j * 2], zj = R[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  for (const a of A.slice(0, 200)) { // (a point well inside: a grid point of its box that is inside)
    let at = null; for (let t = 0; t < 25 && !at; t++) { const x = a.bb[0] + (a.bb[2] - a.bb[0]) * (0.1 + 0.8 * ((t % 5) / 4)), z = a.bb[1] + (a.bb[3] - a.bb[1]) * (0.1 + 0.8 * (Math.floor(t / 5) / 4)); if (inPoly(a.ring, x, z)) at = { x, z }; }
    if (at) spots.push({ ...at, surf: a.surf || 0, what: 'plaza' });
  }
  // drawn: a ray down onto the built road meshes (ribbons and plazas), at the surface physics stands on
  const G = w.roadGroup.userData, rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
  let drawn = 0, apart = 0, paved = 0, soft = 0; const ex = { drawn: [], apart: [], paved: [] };
  { // (a road's meshes are in the tile of its first point: the tiles nearest each spot and its road's first point)
    for (const sp of spots) { const by = (q) => G.tiles.map((t) => [Math.hypot(t.x - q.x, t.z - q.z), t]).sort((a, b) => a[0] - b[0]).map((e) => e[1]), near = [...new Set([...by(sp).slice(0, 4), ...(sp.first ? by(sp.first).slice(0, 4) : [])])];
      for (const t of near) if (!t.built) G.update({ x: t.x, y: 0, z: t.z }, 1e9, 10);
      sp.meshes = near.flatMap((t) => t.meshes.filter((m) => m.isMesh && !m.isInstancedMesh && /^(path3|tarmac)/.test(m.material.customProgramCacheKey?.() || ''))); }
    for (const sp of spots) {
      const meshes = sp.meshes;
      const g = w.groundAt(sp.x, sp.z), at = `(${Math.round(sp.x)}, ${Math.round(sp.z)}) ${sp.what}`;
      rc.set(new THREE.Vector3(sp.x, g.h + 20, sp.z), down); rc.far = 40;
      const hit = rc.intersectObjects(meshes, false).filter((h) => /^path3/.test(h.object.material.customProgramCacheKey()) === (sp.surf !== 0)).sort((a, b) => Math.abs(a.point.y - g.h) - Math.abs(b.point.y - g.h))[0]; // (the one nearest the ground: not a bridge over it)
      if (hit) { drawn++; if (Math.abs(hit.point.y - g.h) > 0.2) { apart++; if (ex.apart.length < 3) ex.apart.push(`${at} ${(hit.point.y - g.h).toFixed(2)} m`); } } else if (ex.drawn.length < 3) ex.drawn.push(at);
      const okType = sp.surf === 2 ? g.type === 'sand' : g.type === 'runway'; if (okType) paved++; else if (ex.paved.length < 3) ex.paved.push(`${at} ${g.type}`);
      if (sp.surf === 2) soft++;
    }
  }
  // driven: a buggy along a minor way on the ground (a pedestrian street if any, else the longest), 8 s, steering along it
  let drive = { ok: false, why: 'no way to drive' };
  { const env = envOf(w); let best = null;
    // (one no building stands on: they don't move for these ways, setback.js; and no sharp bend)
    const wb = [], walled = (P) => P.some((p, i) => { if (i && Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z) > 0) { const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)], t1 = Math.atan2(p.z - a.z, p.x - a.x), t2 = Math.atan2(c.z - p.z, c.x - p.x); if (Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1))) > 0.8) return true; }
      return w.wallBoxes(p.x, p.z, 6, wb).some((b) => Math.abs((p.x - b.x) * b.ux + (p.z - b.z) * b.uz) < b.hl + 3 && Math.abs(-(p.x - b.x) * b.uz + (p.z - b.z) * b.ux) < b.hw + 3); });
    const cand = [];
    for (const r of M) { if (r.bridge?.some(Boolean) || r.pts.length < 6) continue; const P = r.pts, L = P.reduce((s, p, i) => s + (i ? Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z) : 0), 0); if (Math.abs(P[0].x) < lim && Math.abs(P[0].z) < lim && L > 80 && L < 2000) cand.push({ r, L }); }
    cand.sort((a, b) => (b.r.kind === 'ped') - (a.r.kind === 'ped') || b.L - a.L); // (a pedestrian street if any)
    for (const q of cand.slice(0, 200)) if (!walled(q.r.pts.slice(0, 20))) { best = q; break; }
    if (best) {
      const { Aircraft, REALISM } = await import('../../src/aircraft.js'), P = best.r.pts, d = new THREE.Vector3().subVectors(P[1], P[0]).setY(0).normalize();
      const ac = new Aircraft(ctx.presets.find((x) => x.name === 'Dune Buggy'), REALISM.pilot); ac.spawn(env, new THREE.Vector3(P[0].x, P[0].y + 1, P[0].z), Math.atan2(-d.x, -d.z));
      let off = 0, above = 0, far = 0;
      for (let k = 0; k < 60 * 8; k++) {
        let bi = 0, bd = 1e9; for (let i = 0; i < P.length; i++) { const dd = (P[i].x - ac.x.x) ** 2 + (P[i].z - ac.x.z) ** 2; if (dd < bd) { bd = dd; bi = i; } }
        if (bi >= P.length - 2) break;
        const t = P[Math.min(P.length - 1, bi + 2)], f = ac.forward, h1 = Math.atan2(-(t.x - ac.x.x), -(t.z - ac.x.z)), h0 = Math.atan2(-f.x, -f.z), e = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
        ac.setControls({ throttle: 0.4, roll: Math.max(-1, Math.min(1, -e * 2)), pitch: 0, yaw: 0, rev: 0, hand: 0 }); ac.step(1 / 60, env);
        off = Math.max(off, Math.sqrt(bd)); above = Math.max(above, Math.abs(ac.x.y - w.sampleGrid(ac.x.x, ac.x.z))); far = Math.hypot(ac.x.x - P[0].x, ac.x.z - P[0].z);
      }
      const alive = ac.parts.filter((q) => q.alive).length;
      drive = { ok: alive === ac.parts.length && far > 25 && off < best.r.width / 2 + 6 && above < 2.5, why: `a ${best.r.kind} of ${best.L.toFixed(0)} m at (${Math.round(P[0].x)}, ${Math.round(P[0].z)}): ${far.toFixed(0)} m driven, ${off.toFixed(1)} m off its line at most, ${above.toFixed(2)} m off the ground, ${alive}/${ac.parts.length} parts` };
    }
  }
  // no traffic: no lane on a minor way, no junction box with one as an arm; a running Vehicles' cars stay on the streets
  const LG = new LaneGraph(w.net), lanes = LG.lanes.filter((L) => L.piece.rd.minor).length, arms = junctionPlan(w.net.roads, !!w.loc.city).filter((J) => J.arms.some((a) => w.net.roads[a.k].minor)).length;
  const C = 20, cells = new Map(), put = (rd, tag) => { const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { const a = P[i], b = P[i + 1]; for (let u = Math.floor(Math.min(a.x, b.x) / C); u <= Math.floor(Math.max(a.x, b.x) / C); u++) for (let v = Math.floor(Math.min(a.z, b.z) / C); v <= Math.floor(Math.max(a.z, b.z) / C); v++) { const k = u + ',' + v; let L = cells.get(k); if (!L) cells.set(k, (L = [])); L.push([a, b, rd.width / 2 + (tag ? 0 : 3), tag]); } } };
  for (const rd of w.net.roads) if (rd.kind !== 'rail') put(rd, rd.minor ? 1 : 0);
  const where = (x, z) => { let m = false; for (const [a, b, hw, tag] of cells.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || []) { const ex2 = b.x - a.x, ez = b.z - a.z, l = ex2 * ex2 + ez * ez, t = l ? Math.max(0, Math.min(1, ((x - a.x) * ex2 + (z - a.z) * ez) / l)) : 0; if (Math.hypot(a.x + ex2 * t - x, a.z + ez * t - z) < hw) { if (!tag) return 0; m = true; } } return m ? 1 : 0; };
  const V = new Vehicles(new THREE.Scene(), w); let seen = 0, onMinor = 0; const oex = [];
  for (let k = 0; k < 20 * 30; k++) { V.update(1 / 20, null); if (k % 20 === 0) for (const q of V.cars) { if (!q.path?.pts || q.path.kind === 'apron') continue; const p = new THREE.Vector3(); V.pathPoint(q.path, q.s, p, new THREE.Vector3()); seen++; if (where(p.x, p.z)) { onMinor++; if (oex.length < 3) oex.push(`(${Math.round(p.x)}, ${Math.round(p.z)})`); } } }
  // their own grades (the streets' checks above leave them out): along them, where they join the streets and each
  // other, where they cross. Farm tracks up the Alps' hillsides and steep driveways meeting a street are rougher than
  // the streets: a budget per km (MINOR_ROUGH) rather than none.
  const R = measure(w, { minor: true }), per = (L) => L.length / Math.max(1, R.km), top = (L) => [...L].sort((a, b) => b.v - a.v).slice(0, 2).map((q) => `(${q.x}, ${q.z}) ${q.v.toFixed(2)}`).join('; ');
  const n = spots.length;
  return [
    { name: `${c.loc}: they are graded with the network: joined, few steps`, ok: per(R.joins) + per(R.crossings) <= MINOR_ROUGH.joins && per(R.steps) <= MINOR_ROUGH.steps && per(R.steep) <= MINOR_ROUGH.steep,
      why: `${R.km.toFixed(0)} km: ${R.joins.length} junctions and ${R.crossings.length} crossings off by more than ${JOIN} m (${(per(R.joins) + per(R.crossings)).toFixed(3)}/km, at most ${MINOR_ROUGH.joins})${R.joins.length ? ' (' + top(R.joins) + ' m)' : ''}; ${R.steps.length} step spots (${per(R.steps).toFixed(2)}/km, at most ${MINOR_ROUGH.steps}), ${R.steep.length} steeper than ${STEEP * 100}% (${per(R.steep).toFixed(2)}/km, at most ${MINOR_ROUGH.steep})` },
    { name: `${c.loc}: pedestrian streets, alleys, tracks and plazas are in the road network`, ok: !short.length && M.length > 0, why: `${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ')}${short.length ? ': too few ' + short.join(', ') : ''}` },
    { name: `${c.loc}: they are drawn, where physics drives`, ok: n > 20 && drawn >= 0.97 * n && apart <= 0.03 * n, why: `${drawn} of ${n} spots drawn${ex.drawn.length ? ' (missing e.g. ' + ex.drawn.join('; ') + ')' : ''}, ${apart} drawn more than 0.2 m off the ground physics stands on${ex.apart.length ? ' (e.g. ' + ex.apart.join('; ') + ')' : ''}` },
    { name: `${c.loc}: they are drivable: paved, a track's gravel loose`, ok: n > 20 && paved >= 0.97 * n, why: `${paved} of ${n} spots (${soft} gravel)${ex.paved.length ? '; not, e.g. ' + ex.paved.join('; ') : ''}` },
    { name: `${c.loc}: a car drives along one`, ok: drive.ok, why: drive.why },
    { name: `${c.loc}: no traffic on them`, ok: !lanes && !arms && seen > 50 && onMinor === 0, why: `${lanes} lanes on them, ${arms} junction boxes with one as an arm, ${onMinor} of ${seen} car sightings on one away from the streets${oex.length ? ', e.g. ' + oex.join(' ') : ''}` },
  ];
}


// The near-camera ground detail (World.updateDetail) at a few road points: inside, its vertices are the physics ground
// (sampleGrid) exactly away from the roads, and never above it (under and beside a road it is let down: it is hidden
// there, and must not rise through the road's ribbon); its edge is the patch's own surface (no seam); rebuilding it
// stays cheap, counted as work, not timed (a timing verdict depends on the machine): per rebuild, its vertices and the
// road index's work for them (RoadSurface.q calls, and the segments and junction boxes each one tests).
export function detailCheck(w) {
  const roads = w.net.roads.filter((r) => r.kind !== 'rail' && r.pts.length > 10), lim = w.half - 1500, out = { n: 0, inner: 0, above: 0, edge: 0, times: [], shown: 0, work: [] };
  const RS = w.roadSurf, q0 = RS?.q, tally = { q: 0, tests: 0 };
  if (RS) RS.q = function (x, z, deck = false, y) { // (what q looks at, as q finds it: the segments in its cell, the junction boxes there)
    tally.q++; const C = this.cell, ci = Math.floor((x + this.half) / C), cj = Math.floor((z + this.half) / C), nC = this.nC;
    if (ci >= 0 && cj >= 0 && ci < nC && cj < nC) { const c = cj * nC + ci; tally.tests += this.start[c + 1] - this.start[c] + (deck ? 0 : this.jcell.get(c)?.length ?? 0); }
    return q0.call(this, x, z, deck, y);
  };
  try { detailSpots(w, roads, lim, out, tally); } finally { if (RS) RS.q = q0; }
  const T = out.times.sort((a, b) => a - b); out.ms = T.length ? T[T.length >> 1] : 0;
  out.worst = out.work.reduce((m, k) => (k.tests > (m?.tests ?? -1) ? k : m), null) ?? { verts: 0, q: 0, tests: 0 };
  return out;
}
function detailSpots(w, roads, lim, out, tally) {
  const picks = []; for (let k = 0; picks.length < 4 && k < roads.length * 4; k++) { const r = roads[(k * 7) % roads.length], p = r.pts[(k * 13) % r.pts.length]; if (Math.abs(p.x) < lim && Math.abs(p.z) < lim) picks.push(p); }
  for (const p of picks) {
    const cp = { x: p.x, y: w.sampleGrid(p.x, p.z) + 3, z: p.z };
    w.detailAt = null; w.patchAt = null; w.updatePatch(cp);
    if (!out.warm) { w.updateDetail(cp); w.detailAt = null; out.warm = true; } // (the first build compiles the code: not what a frame pays)
    tally.q = tally.tests = 0;
    const t0 = performance.now(); w.updateDetail(cp); out.times.push(performance.now() - t0);
    if (!w.detail.visible) continue; out.shown++;
    const D = w.detailD, n = D + 1, P = w.detail.geometry.attributes.position.array, R = w.hR, st = w.hStep;
    out.work.push({ verts: n * n, q: tally.q, tests: tally.tests });
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3, x = P[o], y = P[o + 1], z = P[o + 2], e = Math.min(i, j, D - i, D - j); out.n++;
      if (e >= 4) { const d = y - w.sampleGrid(x, z); out.above = Math.max(out.above, d); let road = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) road |= w.detailOn[(j + b) * n + i + a]; if (!road) out.inner = Math.max(out.inner, Math.abs(d)); }
      if (e === 0) out.edge = Math.max(out.edge, Math.abs(y - w.triAt(w.Hh, R + 1, (x + w.half) / st, (z + w.half) / st)));
    }
  }
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
  const roads = w.net.roads.filter((r) => r.kind !== 'rail' && r.pts.length > 10 && !r.tunnel && !r.minor), D = w.detailD, DS = w.detailS, n = D + 1, B = 4; // (the streets: the ways off the street network are sampled in their own check)
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
    if (rd.kind === 'highway' || rd.baked || rd.tunnel || rd.kind === 'rail' || rd.minor) continue; // (the streets, with their kerbs: not the ways off the street network)
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
// Junctions (#228, the 🐞 reports "ground bleedthrough" / "weird intersection"): every junction of the road graph (a
// node where three or more road ends meet, on the ground) is one road surface with no ground in or through it. Its
// area here doesn't come from the code under test: its arms' tarmac (a city's: and pavements) out to the old clearance
// (the widest other road's half width + 1 m from the node) and the space between their ends beside the node, which a
// real junction's roadway and corners cover whatever its kerbs do. Sampled every 0.5 m, against what the road meshes draw there (tarmac, a city's pavements, the solid inner part
// of a gravel shoulder; the shaders' cut-outs at the junctions emulated, rjunc): per junction
//   hole:   a sample with no road surface drawn (the bare ground between two arms);
//   bleed:  the ground drawn over the road surface (more than OVER): the near-camera detail mesh (World.updateDetail,
//           at the place's Low spacing and at Ultra's 2 m) or the patch (the baked grid);
//   apart:  the tarmac drawn and the surface physics stands on (World.sampleGrid) more than 0.12 m apart (beyond the
//           tarmac's lift over it).
// Returns { n junctions, hole, bleed, apart (junctions with any), samples, worst, at (examples) }.
export async function junctionCheck(w, { detail = true, keep = false, within = null } = {}) { // (within: [x0, z0, x1, z1], only the junctions there)
  const { RJ_Q = 4 } = await import('../../src/roads.js'), roads = w.net.roads, lim = w.half - 600, city = !!w.loc.city;
  const at = new Map();
  roads.forEach((rd, k) => { if (rd.minor) return; for (const [j, nd] of rd.jn || []) { let L = at.get(nd); if (!L) at.set(nd, (L = [])); L.push({ k, j }); } }); // (the streets' junctions: a way off the street network joins one as a driveway does, no box)
  const J = [];
  for (const [nd, L] of at) {
    const legs = L.reduce((a, q) => a + (q.j === 0 || q.j === roads[q.k].pts.length - 1 ? 1 : 2), 0); if (legs < 3) continue;
    const p = roads[L[0].k].pts[L[0].j]; if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) continue;
    if (within && (p.x < within[0] || p.z < within[1] || p.x > within[2] || p.z > within[3])) continue;
    if (L.some(({ k, j }) => roads[k].tunnel || roads[k].baked || roads[k].kind === 'rail' || roads[k].bridge?.[j] || roads[k].tube?.[j])) continue;
    // its area: each arm's tarmac (as its ribbon has it: each row's edge at its point +- the half width along the
    // neighbours' chord, straight between rows) from beside the node out to the old clearance, and what lies between
    // the arms' ends beside the node (where roads meeting at an angle left a wedge of ground)
    const node = [], parts = [];
    for (const { k, j } of L) {
      const rd = roads[k], P = rd.pts, hw = rd.width / 2 + (city && rd.kind !== 'highway' ? (rd.kind === 'main' ? 4.5 : 3.5) : 0), r = Math.max(...L.filter((o) => o.k !== k).map((o) => roads[o.k].width / 2), 0) + 1; // (a city's: out to its pavements' edge, roadgrade.js PAVE)
      const rt = (i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1; return [-(b.z - a.z) / l, (b.x - a.x) / l]; };
      const edge = (i, t, o) => { const a = P[i], b = P[i + 1], ra = rt(i), rb = rt(i + 1); return [a.x + ra[0] * o + (b.x + rb[0] * o - a.x - ra[0] * o) * t, a.z + ra[1] * o + (b.z + rb[1] * o - a.z - ra[1] * o) * t]; };
      const n0 = [-hw, hw].map((o) => { const r0 = rt(j); return [p.x + r0[0] * o, p.z + r0[1] * o]; }); node.push(...n0);
      for (const dir of [1, -1]) {
        let i = j, s = 0; if (j + dir < 0 || j + dir >= P.length) continue;
        const arm = [...n0];
        while (i + dir >= 0 && i + dir < P.length) { const l = Math.hypot(P[i + dir].x - P[i].x, P[i + dir].z - P[i].z); if (s + l >= r) break; s += l; i += dir; for (const o of [-hw, hw]) { const q = rt(i); arm.push([P[i].x + q[0] * o, P[i].z + q[1] * o]); } }
        if (i + dir >= 0 && i + dir < P.length) { const l = Math.hypot(P[i + dir].x - P[i].x, P[i + dir].z - P[i].z) || 1, t = (r - s) / l, a = dir > 0 ? i : i - 1, tt = dir > 0 ? t : 1 - t; for (const o of [-hw, hw]) arm.push(edge(a, tt, o)); }
        for (let q = 0; q + 3 < arm.length; q += 2) parts.push(hull(arm.slice(q, q + 4))); // (row to row: a curving arm's own strip, not the hull of the whole, which reaches into the inside of the curve)
      }
    }
    parts.push(hull(node));
    J.push({ nd, x: p.x, z: p.z, parts, hull: hull(parts.flat()) });
  }
  // the road surfaces drawn near the junctions (a square kilometre of them at a time): triangles with what their
  // shaders cut out
  const G = w.roadGroup, C = 4, K = 1000, key = (a, b) => (a + 4e4) * 1e5 + (b + 4e4);
  for (const t of G.userData.tiles) if (!t.built && J.some((j) => Math.abs(j.x - t.x) < 2100 && Math.abs(j.z - t.z) < 2100)) G.userData.update({ x: t.x, y: 0, z: t.z }, 1e9, 1);
  const meshes = [];
  G.traverse((m) => {
    const U = m.isMesh && !m.isInstancedMesh && m.material?.userData?.U; if (!U || m.material.userData === w.patchMat.userData) return;
    const kind = U.rLW ? 't' : U.sD ? 'p' : U.gTint ? 's' : null; if (!kind || !m.geometry.attributes.position) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const A = m.geometry.attributes; meshes.push({ kind, bb: m.geometry.boundingBox, pos: A.position.array, uv: A.uv?.array, ri: A.rinfo?.array, rj: A.rjunc?.array, idx: m.geometry.index?.array });
  });
  const res = J.map((j) => ({ j, hole: 0, bleed: 0, apart: 0, n: 0, worst: 0, top: null }));
  const each = (r, fn) => { const H = r.j.hull; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [a, b] of H) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); z0 = Math.min(z0, b); z1 = Math.max(z1, b); }
    let q = 0; for (let sx = Math.ceil(x0 * 2) / 2 + 0.25; sx < x1; sx += 0.5) for (let sz = Math.ceil(z0 * 2) / 2 + 0.25; sz < z1; sz += 0.5) if (r.j.parts.some((A) => inHull(A, sx, sz))) fn(sx, sz, q++); return q; };
  const groups = new Map(); for (const r of res) { const k = key(Math.floor(r.j.x / K), Math.floor(r.j.z / K)); let L = groups.get(k); if (!L) groups.set(k, (L = [])); L.push(r); }
  for (const L of groups.values()) {
    const want = new Set(); let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
    for (const { j } of L) { gx0 = Math.min(gx0, j.x - 25); gx1 = Math.max(gx1, j.x + 25); gz0 = Math.min(gz0, j.z - 25); gz1 = Math.max(gz1, j.z + 25); for (let a = Math.floor((j.x - 22) / C); a <= Math.floor((j.x + 22) / C); a++) for (let b = Math.floor((j.z - 22) / C); b <= Math.floor((j.z + 22) / C); b++) want.add(key(a, b)); }
    const cells = new Map(); // key -> [mesh index, triangle, ...]
    meshes.forEach((M, mi) => {
      if (M.bb.max.x < gx0 || M.bb.min.x > gx1 || M.bb.max.z < gz0 || M.bb.min.z > gz1) return;
      const { pos, idx } = M, nt = idx ? idx.length / 3 : pos.length / 9;
      for (let t = 0; t < nt; t++) {
        const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        const x0 = Math.min(pos[a * 3], pos[b * 3], pos[c * 3]), x1 = Math.max(pos[a * 3], pos[b * 3], pos[c * 3]), z0 = Math.min(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]), z1 = Math.max(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]);
        if (x1 < gx0 || x0 > gx1 || z1 < gz0 || z0 > gz1 || (x1 - x0 < 1e-4 && z1 - z0 < 1e-4)) continue; // (and a kerb's face: upright)
        for (let u = Math.floor(x0 / C); u <= Math.floor(x1 / C); u++) for (let v = Math.floor(z0 / C); v <= Math.floor(z1 / C); v++) { const k = key(u, v); if (!want.has(k)) continue; let A = cells.get(k); if (!A) cells.set(k, (A = [])); A.push(mi, t); }
      }
    });
    // the top of what is drawn at (x, z): its height (NaN: nothing) and kind
    let kind = null;
    const drawn = (x, z, cap = Infinity) => { // (cap: what is higher is a deck passing over, not this surface)
      let top = NaN; kind = null; const A = cells.get(key(Math.floor(x / C), Math.floor(z / C))) || [];
      for (let e = 0; e < A.length; e += 2) {
        const T = meshes[A[e]], t = A[e + 1], P = T.pos, a = T.idx ? T.idx[t * 3] : t * 3, b = T.idx ? T.idx[t * 3 + 1] : t * 3 + 1, c = T.idx ? T.idx[t * 3 + 2] : t * 3 + 2;
        const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(den) < 1e-12) continue;
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den, wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const I = (arr, n, o) => arr[a * n + o] * wa + arr[b * n + o] * wb + arr[c * n + o] * wc, y = I(P, 3, 1);
        if (T.kind === 's') { if (Math.abs(I(T.uv, 2, 0)) - I(T.ri, 3, 0) > 0.52) continue; }
        else if (T.rj) {
          const jx = I(T.rj, 4, 0), jy = I(T.rj, 4, 1), dj = Math.min(jx, jy), jc = jy < jx ? I(T.rj, 4, 3) : I(T.rj, 4, 2), jr = Math.floor(jc / 32) / RJ_Q, box = RJ_Q > 4 && Math.floor(jc / 16) % 2 === 1;
          if (T.kind === 't' && jc > 0.5 && box && dj < jr + 0.6) continue;
          if (T.kind === 'p' && jc > 0.5 && (Math.round(jc) % 32 & (I(T.uv, 2, 0) > 0 ? 4 : 8)) && dj < jr + 0.3 + (box ? 0.3 : 0)) continue; // (on the mouth's side: a road passing a T keeps its far side's pavement)
        }
        if (!(y <= top) && y < cap) { top = y; kind = T.kind; }
      }
      return top;
    };
    // the drawn surface, the physics, the patch
    for (const r of L) {
      const tops = []; r.n = each(r, (x, z) => {
        const g = w.sampleGrid(x, z), y = drawn(x, z, g + 2.5); tops.push(y); // (an overpass over the junction: not its surface)
        if (Number.isNaN(y)) { r.hole++; if (keep) (r.holes ??= []).push([x, z]); return; }
        const patch = w.triAt(w.Hh, w.hR + 1, (x + w.half) / w.hStep, (z + w.half) / w.hStep) - y; if (patch > OVER) { r.bleed++; r.worst = Math.max(r.worst, patch); if (keep) (r.bleeds ??= []).push([x, z, 'patch', patch, y]); }
        if (kind === 't') { const off = y - g; if (off < -0.02 || off > 0.12) { r.apart++; if (keep) (r.aparts ??= []).push([x, z, off, y]); } }
      });
      r.top = Float32Array.from(tops);
    }
  }
  // the detail mesh, at Low's spacing and at Ultra's (2 m), as built round the middle of each square of junctions. Its
  // inner vertices (more than 4 cells from its edge) lie on a world-wide lattice (multiples of DS) and their heights
  // depend only on where they are (World.detailVert, then detailLow over their neighbours), so they are read off that
  // lattice, each worked out once, instead of building the mesh per square (10,144 builds in New York). A few real
  // builds check that it is the same ground (match).
  const { detailLow } = await import('../../src/world.js');
  const lattice = (DS) => { // (I, J) -> the height updateDetail draws at (I * DS, J * DS) away from its edge
    const BS = 64, raw = new Map(), low = new Map(), cover = w.detailCover(), lift = w.detailLift(DS), h9 = new Float32Array(9), o9 = new Uint8Array(9);
    const blk = (M, I, J, mk) => { const k = key(Math.floor(I / BS), Math.floor(J / BS)); let b = M.get(k); if (!b) M.set(k, (b = mk())); return b; };
    const fill = (I, J, s) => { const b = blk(raw, I, J, () => ({ h: new Float32Array(BS * BS), on: new Uint8Array(BS * BS).fill(2) })), k = (J - Math.floor(J / BS) * BS) * BS + I - Math.floor(I / BS) * BS;
      if (b.on[k] === 2) { b.h[k] = w.detailVert(I * DS, J * DS, cover); b.on[k] = w.dvOn; } h9[s] = b.h[k]; o9[s] = b.on[k]; };
    return (I, J) => { const b = blk(low, I, J, () => new Float32Array(BS * BS).fill(NaN)), k = (J - Math.floor(J / BS) * BS) * BS + I - Math.floor(I / BS) * BS;
      if (Number.isNaN(b[k])) { for (let jb = -1; jb <= 1; jb++) for (let ia = -1; ia <= 1; ia++) fill(I + ia, J + jb, (jb + 1) * 3 + ia + 1); b[k] = detailLow(h9, o9, 4, 3, lift); }
      return b[k]; };
  };
  const D0 = [w.detailD, w.detailS], grids = detail ? [D0, [256, 2]] : [], match = { squares: 0, verts: 0, bad: 0, worst: 0, at: null };
  for (const [D, DS] of grids) {
    const lat = lattice(DS), B = 6, Q = D * DS - 16 * DS - 60, sq = new Map(), shown = []; // (squares well inside the mesh's inner part)
    for (const r of res) { const k = key(Math.floor(r.j.x / Q), Math.floor(r.j.z / Q)); let L = sq.get(k); if (!L) sq.set(k, (L = [])); L.push(r); }
    for (const L of sq.values()) {
      const cx = (Math.floor(L[0].j.x / Q) + 0.5) * Q, cz = (Math.floor(L[0].j.z / Q) + 0.5) * Q, cp = { x: cx, y: w.sampleGrid(cx, cz) + 3, z: cz };
      // where updateDetail would put the mesh, and whether it would show it (in the core, inside the patch)
      const i0 = Math.round(cx / DS) - D / 2, j0 = Math.round(cz / DS) - D / 2, x0 = i0 * DS, z0 = j0 * DS, ext = D * DS, lim = w.half - ext / 2 - 10;
      w.patchAt = null; w.updatePatch(cp); const pr = w.terrainMat.userData.U.patchRect.value;
      if (!(Math.abs(cx) < lim && Math.abs(cz) < lim) || !w.patch?.visible || x0 < pr.x || z0 < pr.y || x0 + ext > pr.z || z0 + ext > pr.w) continue;
      shown.push(cp);
      const det = (x, z) => { const fx = (x - x0) / DS, fz = (z - z0) / DS; if (fx < B || fz < B || fx >= D - B || fz >= D - B) return null; const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, vv = fz - j, h = (a, b) => lat(i0 + i + a, j0 + j + b);
        return u + vv <= 1 ? h(0, 0) + (h(1, 0) - h(0, 0)) * u + (h(0, 1) - h(0, 0)) * vv : h(1, 1) + (h(0, 1) - h(1, 1)) * (1 - u) + (h(1, 0) - h(1, 1)) * (1 - vv); };
      for (const r of L) each(r, (x, z, q) => { const y = r.top[q]; if (Number.isNaN(y)) return; const g = det(x, z); if (g != null && g - y > OVER) { r.bleed++; r.worst = Math.max(r.worst, g - y); if (keep) (r.bleeds ??= []).push([x, z, 'detail' + DS, g - y, y]); } });
    }
    // the check on that: the real mesh at 4 of those squares spread over the place, vertex by vertex where the lattice was read
    if (!shown.length) continue;
    if (w.detailD !== D || w.detailS !== DS) { w.detailGrid = () => [D, DS]; w.group.remove(w.detail); w.buildDetail(); w.detailOn = null; } // (detailOn: sized for the grid)
    for (let t = 0; t < Math.min(4, shown.length); t++) {
      const cp = shown[Math.floor(((t + 0.5) * shown.length) / Math.min(4, shown.length))], n = D + 1;
      w.detailAt = null; w.patchAt = null; w.updatePatch(cp); w.updateDetail(cp); match.squares++;
      if (!w.detail.visible) { match.bad++; match.at ??= `(${Math.round(cp.x)}, ${Math.round(cp.z)}) not shown`; continue; }
      const P = w.detail.geometry.attributes.position.array, i0 = Math.round(P[0] / DS), j0 = Math.round(P[2] / DS);
      for (let j = B - 1; j <= D - B + 1; j++) for (let i = B - 1; i <= D - B + 1; i++) {
        const d = Math.abs(P[(j * n + i) * 3 + 1] - lat(i0 + i, j0 + j)); match.verts++;
        if (d > 0) { match.bad++; if (d > match.worst) { match.worst = d; match.at = `(${(i0 + i) * DS}, ${(j0 + j) * DS}) ${DS} m grid`; } }
      }
    }
  }
  if (w.detailD !== D0[0]) { delete w.detailGrid; w.group.remove(w.detail); w.buildDetail(); w.detailOn = null; }
  const out = { n: res.length, samples: 0, hole: 0, bleed: 0, apart: 0, worst: 0, ex: { hole: [], bleed: [], apart: [] }, per: res, match };
  for (const r of res) { r.top = null; out.samples += r.n; for (const k of ['hole', 'bleed', 'apart']) if (r[k] > 0) { out[k]++; if (out.ex[k].length < 4) out.ex[k].push(`(${Math.round(r.j.x)}, ${Math.round(r.j.z)}) ${r[k]}`); } out.worst = Math.max(out.worst, r.worst); }
  return out;
}
// Pavements (#228, the 🐞 report 042034 "why is the street so floaty here?"): in a city every pavement slab lies on
// the ground, along every street and round every junction's corners. At the slab's outer edge (0.1 m in from the
// building line), what the pavement meshes draw there (roads.js: a street's own slabs, a junction's corner slabs; the
// shader's cut-out at the junctions emulated, rjunc) against the ground physics stands on (World.sampleGrid: the
// slabs' top less a centimetre, roadgrade.js CITY_TOP, which the near-camera ground draws beyond them):
//   float:  the slab more than GAP over it (a slab hanging in the air where two streets meet at different heights);
//   buried: the slab more than GAP under it (the ground through the slab).
// Every PSTEP metres along each city street, both sides, and at every corner slab's rows. Not where the sample is on
// another road's footprint (a slab across another street's tarmac is not the ground's business), nor on a bridge.
// Returns { n samples, float, buried, worst, at, ex }.
const GAP = 0.1, PSTEP = 4;
export async function pavementCheck(w, { within = null, keep = false } = {}) { // (keep: every failing spot in out.spots, [x, z, d])
  const { RJ_Q = 16 } = await import('../../src/roads.js'), G = w.roadGroup, lim = w.half - 600, TILE = w.loc.roads?.chunk || 2000, C = 4;
  const PAVE = { main: 4.5, street: 3.5 }, S = w.roadSurf, tk = (x, z) => Math.floor(x / TILE) + ',' + Math.floor(z / TILE), per = new Map();
  const ok = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim && (!within || (x >= within[0] && z >= within[1] && x <= within[2] && z <= within[3]));
  const put = (t, x, z, tag = 0) => { if (!ok(x, z)) return; let L = per.get(t); if (!L) per.set(t, (L = [])); L.push(x, z, tag); }; // (tag: 0 a street's slab, 1 a corner slab)
  for (const rd of w.net.roads) {
    if (!(rd.kind === 'main' || rd.kind === 'street') || rd.baked || rd.tunnel) continue;
    const P = rd.pts, hw = rd.width / 2, o = hw + PAVE[rd.kind] - 0.1, t = tk(P[0].x, P[0].z);
    for (let i = 0; i + 1 < P.length; i++) {
      if ((rd.bridge?.[i] && rd.bridge?.[i + 1]) || rd.tube?.[i] || rd.tube?.[i + 1]) continue;
      const a = P[i], b = P[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z); if (L < 0.5) continue;
      const rx = -(b.z - a.z) / L, rz = (b.x - a.x) / L;
      for (let s = PSTEP / 2; s < L; s += PSTEP) for (const sd of [-1, 1]) { const x = a.x + (b.x - a.x) * s / L + rx * o * sd, z = a.z + (b.z - a.z) * s / L + rz * o * sd; put(t, x, z); }
    }
  }
  for (const B of w.net.junctions || []) for (const R of B.pave || []) for (let e = 0; e < R.length; e += 8) { // (roadgrade.js PAVE_ROW: kerb x, z, building line x, z, ...)
    const kx = R[e], kz = R[e + 1], ox = R[e + 2], oz = R[e + 3], dx = kx - ox, dz = kz - oz, l = Math.hypot(dx, dz); if (l < 0.5) continue;
    put(tk(B.x, B.z), ox + dx / l * 0.1, oz + dz / l * 0.1, 1);
  }
  const out = { n: 0, float: 0, buried: 0, worst: 0, at: '', ex: [] }, key = (a, b) => (a + 4e4) * 1e5 + (b + 4e4);
  for (const t of G.userData.tiles) {
    const L = per.get(Math.floor(t.x / TILE) + ',' + Math.floor(t.z / TILE)); if (!L) continue;
    if (!t.built) G.userData.update({ x: t.x, y: 0, z: t.z }, 1e9, 1);
    // its pavement triangles, per 4 m cell
    const tris = [], cells = new Map();
    for (const m of t.meshes) {
      const U = m.isMesh && !m.isInstancedMesh && m.material?.userData?.U; if (!U || !U.sD) continue;
      const A = m.geometry.attributes, pos = A.position.array, rj = A.rjunc?.array, uv = A.uv?.array, idx = m.geometry.index?.array, nt = idx ? idx.length / 3 : pos.length / 9;
      for (let q = 0; q < nt; q++) {
        const a = idx ? idx[q * 3] : q * 3, b = idx ? idx[q * 3 + 1] : q * 3 + 1, c = idx ? idx[q * 3 + 2] : q * 3 + 2;
        const x0 = Math.min(pos[a * 3], pos[b * 3], pos[c * 3]), x1 = Math.max(pos[a * 3], pos[b * 3], pos[c * 3]), z0 = Math.min(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]), z1 = Math.max(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]);
        if (x1 - x0 < 1e-4 && z1 - z0 < 1e-4) continue; // (a kerb's face: upright)
        const id = tris.length; tris.push([pos, rj, a, b, c, uv]);
        for (let u = Math.floor(x0 / C); u <= Math.floor(x1 / C); u++) for (let v = Math.floor(z0 / C); v <= Math.floor(z1 / C); v++) { const k = key(u, v); let E = cells.get(k); if (!E) cells.set(k, (E = [])); E.push(id); }
      }
    }
    for (let s = 0; s < L.length; s += 3) {
      const x = L[s], z = L[s + 1]; let top = NaN;
      for (const id of cells.get(key(Math.floor(x / C), Math.floor(z / C))) || []) {
        const [P, rj, a, b, c, uv] = tris[id], ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(den) < 1e-12) continue;
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den, wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        if (rj) { const I = (o) => rj[a * 4 + o] * wa + rj[b * 4 + o] * wb + rj[c * 4 + o] * wc, jx = I(0), jy = I(1), dj = Math.min(jx, jy), jc = jy < jx ? I(3) : I(2), jr = Math.floor(jc / 32) / RJ_Q, box = Math.floor(jc / 16) % 2 === 1; if (jc > 0.5 && (Math.round(jc) % 32 & (uv[a * 2] * wa + uv[b * 2] * wb + uv[c * 2] * wc > 0 ? 4 : 8)) && dj < jr + 0.3 + (box ? 0.3 : 0)) continue; }
        const y = P[a * 3 + 1] * wa + P[b * 3 + 1] * wb + P[c * 3 + 1] * wc; if (!(y <= top)) top = y;
      }
      if (Number.isNaN(top) || (S.q(x, z) && S.e <= 0)) continue; // (no slab drawn here: cut at a junction; on another road)
      const d = top - w.sampleGrid(x, z) - 0.01; out.n++;
      if (d > GAP) out.float++; else if (d < -GAP) out.buried++; else continue;
      if (keep) (out.spots ??= []).push([x, z, d, L[s + 2]]);
      if (Math.abs(d) > Math.abs(out.worst)) { out.worst = d; out.at = `${x.toFixed(0)}, ${z.toFixed(0)}`; }
      if (out.ex.length < 4 && Math.abs(d) > 0.3) out.ex.push(`(${x.toFixed(0)}, ${z.toFixed(0)}) ${d.toFixed(2)} m`);
    }
  }
  return out;
}
function hull(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function inHull(H, x, z) { for (let i = 0; i < H.length; i++) { const a = H[i], b = H[(i + 1) % H.length]; if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false; } return true; }

export function measure(w, { minor = false } = {}) { // (minor: the ways off the street network, and where they join or cross a street, instead of the streets: minorCheck)
  const roads = w.net.roads.filter((r) => r.kind !== 'rail' && (minor || !r.minor)), mine = (rd) => !rd.minor === !minor, lim = w.half - 200, inCore = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim;
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
  // (a way off the street network's steps: a 1 m rise more than STEP off its grade there, the median rise of the STEP_W
  // metres either side; a track may climb steeper than STEP in 1 m where the hillside does (its grade then is the steep
  // check's), and that is a slope, not a step)
  let run = [];
  const flush = () => { for (let k = 1; k < run.length; k++) { const d = run[k].h - run[k - 1].h; if (Math.abs(d) <= STEP) continue; const win = []; for (let j = Math.max(1, k - STEP_W); j <= Math.min(run.length - 1, k + STEP_W); j++) if (j !== k) win.push(run[j].h - run[j - 1].h); win.sort((p, q) => p - q); const off = Math.abs(d - (win.length ? win[win.length >> 1] : 0)); if (off > STEP) spot(out.steps, run[k].x, run[k].z, off, run[k].kind); } run = []; };
  roads.forEach((rd, ri) => {
    const P = rd.pts, n = P.length, hw = rd.width / 2, last = rd.closed ? n : n - 1;
    let prev = null;
    for (let i = 0; i < last; i++) {
      const a = P[i], b = P[(i + 1) % n], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (isDeck(rd, i) || L < 1e-3 || !mine(rd)) { prev = null; flush(); continue; }
      const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
      for (let s = 0; s < L; s += 1) {
        const x = a.x + dx * s, z = a.z + dz * s;
        if (!inCore(x, z)) { prev = null; flush(); continue; }
        out.km += 0.001;
        const h = w.sampleGrid(x, z);
        if (minor) run.push({ x, z, h, kind: rd.kind });
        else if (prev != null && Math.abs(h - prev) > STEP) spot(out.steps, x, z, Math.abs(h - prev), rd.kind);
        prev = h;
        if (s % 2) continue;
        for (const f of [-0.7, 0, 0.7]) {
          const px = x - dz * hw * f, pz = z + dx * hw * f;
          const g = Math.hypot(w.sampleGrid(px + 0.5, pz) - w.sampleGrid(px - 0.5, pz), w.sampleGrid(px, pz + 0.5) - w.sampleGrid(px, pz - 0.5));
          if (g > STEEP) spot(out.steep, px, pz, g, rd.kind);
        }
      }
    }
    flush();
    // junctions (roads.bin topology, rd.jn): every road through a node meets the others there (checked below, once
    // per node); roads without topology (the airport road): an end on another road's line meets it
    if (!rd.jn && !rd.closed && mine(rd)) for (const [e, ie] of [[P[0], 0], [P[n - 1], n - 2]]) {
      if (!inCore(e.x, e.z) || isDeck(rd, ie)) continue;
      let bd = SNAP, y = null, deck = false;
      near(e.x, e.z, (sg) => {
        if (sg.ri === ri) return;
        const { a, b } = sg, ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((e.x - a.x) * ex + (e.z - a.z) * ez) / L2));
        const d = Math.hypot(a.x + ex * t - e.x, a.z + ez * t - e.z); if (d < bd) { bd = d; y = a.y + (b.y - a.y) * t; deck = sg.deck; }
      });
      if (y != null && !deck && Math.abs(y - e.y) > JOIN) spot(out.joins, e.x, e.z, Math.abs(y - e.y), rd.kind);
    }
    for (const [j, nd] of rd.jn || []) { const p = P[j]; if (!inCore(p.x, p.z)) continue; const q = nodes.get(nd); if (!q) nodes.set(nd, { y: p.y, x: p.x, z: p.z, br: !!rd.bridge?.[j], mine: mine(rd) }); else if (!q.br && !rd.bridge?.[j] && (q.mine || mine(rd)) && Math.abs(q.y - p.y) > JOIN) spot(out.joins, p.x, p.z, Math.abs(q.y - p.y), rd.kind); }
    // crossings with the roads after it (each pair once)
    for (let i = 0; i < last; i++) {
      if (isDeck(rd, i)) continue;
      const a = P[i], b = P[(i + 1) % n]; if (!inCore(a.x, a.z)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, seen = new Set();
      near((a.x + b.x) / 2, (a.z + b.z) / 2, (sg) => {
        if (sg.ri <= ri || sg.deck || seen.has(sg) || !(mine(rd) || mine(roads[sg.ri]))) return; seen.add(sg);
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
  for (const rd of w.net.roads) { if (rd.kind === 'rail' || rd.minor) continue; const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { if ((rd.bridge?.[i] && rd.bridge?.[i + 1]) || (rd.tube?.[i] && rd.tube?.[i + 1])) continue; const a = P[i], b = P[i + 1]; const i0 = Math.floor(Math.min(a.x, b.x) / C), i1 = Math.floor(Math.max(a.x, b.x) / C), j0 = Math.floor(Math.min(a.z, b.z) / C), j1 = Math.floor(Math.max(a.z, b.z) / C); for (let u = i0; u <= i1; u++) for (let v = j0; v <= j1; v++) { const k = u + ',' + v; let L = cells.get(k); if (!L) cells.set(k, (L = [])); L.push([a, b, rd.width / 2]); } } }
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
  if (c.minor) return minorCheck(w, c, ctx);
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
      if (!q || q.pts.length !== rd.pts.length || q.kind !== rd.kind || !!q.minor !== !!rd.minor || (q.surf || 0) !== (rd.surf || 0) || q.oneway !== (rd.oneway || 0) || JSON.stringify(q.jn) !== JSON.stringify(rd.jn || []) || q.bridge.some((b, i) => b !== !!rd.bridge?.[i])) { bad++; return; }
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
  if (c.junctions) {
    const o = await junctionCheck(w), ex = (k) => (o.ex[k].length ? `, e.g. ${o.ex[k].join('; ')}` : '');
    return [
      { name: `${c.loc}: junctions have no bare ground between their arms`, ok: o.n > 20 && o.hole <= 0.005 * o.n, why: `${o.hole} of ${o.n} junctions with ground showing in the junction (${o.samples} samples)${ex('hole')}` },
      { name: `${c.loc}: no ground through the road in junctions`, ok: o.n > 20 && o.bleed <= 0.005 * o.n, why: `${o.bleed} of ${o.n} junctions with the ground drawn over the road (detail mesh at Low and at 2 m, patch; worst ${o.worst.toFixed(2)} m)${ex('bleed')}` },
      { name: `${c.loc}: junctions are drawn where physics drives`, ok: o.n > 20 && o.apart <= 0.005 * o.n, why: `${o.apart} of ${o.n} junctions with the tarmac drawn off the physics surface${ex('apart')}` },
      { name: `${c.loc}: junction check's ground heights match the close-up mesh`, ok: o.match.squares >= 2 && o.match.verts > 0 && !o.match.bad, why: `${o.match.bad} of ${o.match.verts} inner vertices of ${o.match.squares} real World.updateDetail builds (Low's grid and 2 m) off the lattice heights the check reads (World.detailVert, detailLow)${o.match.bad ? `, worst ${o.match.worst} m at ${o.match.at}` : ''}` },
    ];
  }
  if (c.pavements) {
    const o = await pavementCheck(w), pc = (v) => `${(100 * v / Math.max(1, o.n)).toFixed(2)}%`;
    return [{ name: `${c.loc}: pavement slabs lie on the ground`, ok: o.n > 20000 && o.float + o.buried <= 0.005 * o.n, why: `${o.n} spots at the slabs' outer edge: ${pc(o.float)} more than ${GAP} m over the ground, ${pc(o.buried)} under it (at most 0.5% in all)${o.worst ? `; worst ${o.worst.toFixed(2)} m at (${o.at})` : ''}${o.ex.length ? ', e.g. ' + o.ex.join('; ') : ''}` }];
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
      { name: `${c.loc}: ground detail rebuild work stays small`, ok: d.shown > 0 && d.worst.verts <= DETAIL_VERTS && d.worst.q <= DETAIL_Q * d.worst.verts && d.worst.tests <= DETAIL_TESTS * d.worst.verts, why: `worst rebuild: ${d.worst.verts} vertices (at most ${DETAIL_VERTS}), ${d.worst.q} road lookups (at most ${DETAIL_Q} a vertex), ${d.worst.tests} segments and junctions tested (${(d.worst.tests / Math.max(1, d.worst.verts)).toFixed(1)} a vertex, at most ${DETAIL_TESTS}); median ${d.ms.toFixed(1)} ms (info only)` },
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
