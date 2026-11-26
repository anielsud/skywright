// Road networks at the real places (realworld.js maps them from OpenStreetMap): grading them (gradeReal), carving
// them and the towns into the heightfield, painting them into the baked albedo, and their meshes.
import * as THREE from 'three';
import { STEP } from './stepClock.js';
import { smoothstep, lerp, clamp } from './noise.js';
import { glowTexture as glow } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { REGION, roadStyle, tarmacMaterial, shoulderMaterial, sidewalkMaterial, pathMaterial } from './roadSurface.js';
import { airportGate } from './airportKit.js';
import { junctionPlan, insertMouths, junctionShapes, TARMAC_LIFT, along } from './junctions.js';
import { GRADE, VERGE, gridSampler, planGrid, unloop, route, smoothPath, relaxCurves, profileRoad, carveGrid, RoadSurface, PAVE, CITY_TOP, inside as inPoly } from './roadgrade.js';

const RWY_HALF = 900, JGRADE = 0.2, MINOR_PIN = 3; // (JGRADE: the steepest a street may be left between two junctions' level boxes; MINOR_PIN: how far off a street's height the ground under a way off the street network may be for the way to be pinned to the street where they overlap, gradeReal)


// evenly spaced points along a polyline
export function resample(pts, step, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0].clone()]; let acc = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i], L = a.distanceTo(b); if (L < 1e-6) continue;
    let t = step - acc;
    while (t <= L) { out.push(a.clone().lerp(b, t / L)); t += step; }
    acc = L - (t - step);
  }
  if (closed && out.length > 1 && out.at(-1).distanceTo(out[0]) < step * 0.5) out.pop();
  if (!closed && out.at(-1).distanceTo(src.at(-1)) > step * 0.3) out.push(src.at(-1).clone());
  return out;
}

// Flatten the coarse heightfield under towns, then cut and fill the roads / rail into it.
export function flattenGrid(w, net) {
  const { N, step, half, H } = w;
  const flat = (p, radius, target) => {
    const i0 = Math.floor((p.x + half) / step), j0 = Math.floor((p.z + half) / step), rr = Math.ceil(radius / step) + 1;
    for (let j = j0 - rr; j <= j0 + rr + 1; j++) for (let i = i0 - rr; i <= i0 + rr + 1; i++) {
      if (i < 0 || j < 0 || i > N || j > N) continue;
      const d = Math.hypot(-half + i * step - p.x, -half + j * step - p.z);
      const t = 1 - smoothstep(radius * 0.55, radius * 1.4, d);
      const k = j * (N + 1) + i; H[k] = lerp(H[k], target, t);
    }
  };
  for (const t of net.towns) flat(t.c, 420 * t.size, t.h);
  carveGrid(w, allRoads(net), H, N, step, 0.6, net.junctions);
}

// Same for the hi-res bake heights: what physics, placement and the near-camera ground use
export function flattenHi(w, net, Hh, R) {
  const st = w.size / R, W = R + 1, half = w.half;
  const flat = (p, radius, target) => {
    const i0 = Math.floor((p.x + half) / st), j0 = Math.floor((p.z + half) / st), rr = Math.ceil(radius * 1.4 / st) + 1;
    for (let j = j0 - rr; j <= j0 + rr; j++) for (let i = i0 - rr; i <= i0 + rr; i++) {
      if (i < 0 || j < 0 || i > R || j > R) continue;
      const d = Math.hypot(-half + i * st - p.x, -half + j * st - p.z);
      const t = 1 - smoothstep(radius * 0.6, radius * 1.4, d);
      if (t > 0) { const k = j * W + i; Hh[k] = lerp(Hh[k], target, t); }
    }
  };
  for (const t of net.towns) flat(t.c, 420 * t.size, t.h);
  carveGrid(w, allRoads(net), Hh, R, st, 0.75, net.junctions);
}
const allRoads = (net) => [...net.roads, ...(net.rail ? [net.rail] : [])];
// A city's open ground (the lots, plazas and pedestrian streets, the gaps between buildings and the strips between a
// building line and the pavement: whatever OpenStreetMap leaves paved, cover.png 0, that is no road) lies at the
// pavement's level, as a real city's does: not the raw heights, which the streets' grading left up to a metre or two
// below the kerbs (the "sunken lots": walls standing on a ledge above the ground, a car dropping off the pavement).
// Returns { L, t, R, st }: a grid (spacing st: every f-th vertex of the fine grid's, f making it 40 m or more; only the
// middle of a block reads it, RoadSurface.over has the ground beside a street) of the level such ground lies at, L, the
// streets' pavement top round it (inverse-distance weighted over the streets within CITY_REACH, so a block between
// two streets at different heights is a smooth slope from one to the other), and how much the ground there takes it,
// t: 1 on the paved ground, 0 on the parks, water, the levelled airport and stunt parks and anything more than a few
// metres off the streets (a cliff, a cutting). World.cityAt blends the fine grid's ground to it; sampleGrid stands on
// that (RoadSurface.over ramps the pavement up to it), so the near-camera ground mesh draws it and physics drives on
// it; the coarse patch further out keeps drawing the carved grid. Null away from a city.
export const CITY_REACH = 36; // m from a street's tarmac edge (the ground lies CITY_TOP over the tarmac, roadgrade.js)
export function cityGround(w, net, Hh, R, levelled = null) { // (levelled(x, z): ground something else has levelled, the stunt parks)
  const C = w.real?.cover; if (!w.loc.city || !C) return null;
  const f = Math.max(1, Math.round(40 / (w.size / R))), dR = Math.floor(R / f), st = (w.size / R) * f, W = dR + 1, HW = R + 1, half = w.half, wl = w.waterLevel, N = W * W;
  // which vertices are paved ground (looked at only where a street is near): bare in the land cover (no park, lawn or
  // wood), dry, off the airport's and the stunt parks' levelled ground. 0 not yet asked, 1 paved, 2 not
  const open = new Uint8Array(N), pb = w.loc.padBlend || 700, cn = C.n, ck = cn / C.size, cd = C.d;
  const sw = new Float32Array(N), sy = new Float32Array(N), dm = new Float32Array(N).fill(Infinity);
  // the streets' heights round each of them, inverse-distance weighted (not highways: an embankment or a cutting
  // beside them is real; not a bridge's deck or a tunnel), per straight run of a street
  const run = (A, B, hw) => {
    const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz || 1e-9, r = hw + CITY_REACH;
    const i0 = Math.max(0, Math.ceil((Math.min(A.x, B.x) - r + half) / st)), i1 = Math.min(dR, Math.floor((Math.max(A.x, B.x) + r + half) / st));
    const j0 = Math.max(0, Math.ceil((Math.min(A.z, B.z) - r + half) / st)), j1 = Math.min(dR, Math.floor((Math.max(A.z, B.z) + r + half) / st));
    for (let j = j0; j <= j1; j++) {
      const z = -half + j * st;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * st;
        let t = ((x - A.x) * dx + (z - A.z) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = A.x + dx * t - x, ez = A.z + dz * t - z, d = Math.sqrt(ex * ex + ez * ez) - hw; if (d > CITY_REACH) continue;
        const k = j * W + i;
        let o = open[k];
        if (!o) {
          const ci = Math.floor((x - C.x0) * ck), cj = Math.floor((z - C.z0) * ck), ax = Math.max(0, Math.abs(x - 100) - 350), az = Math.max(0, Math.abs(z) - RWY_HALF - 250);
          o = open[k] = Hh[j * f * HW + i * f] >= wl + 0.6 && ci >= 0 && cj >= 0 && ci < cn && cj < cn && cd[cj * cn + ci] === 0 && ax * ax + az * az >= pb * pb && !levelled?.(x, z) ? 1 : 2;
        }
        if (o !== 1) continue;
        const e = d > 1 ? d : 1, wt = 1 / (e * e);
        sw[k] += wt; sy[k] += wt * (A.y + (B.y - A.y) * t); if (d < dm[k]) dm[k] = d;
      }
    }
  };
  for (const rd of net.roads) {
    if (rd.kind === 'highway' || rd.baked || rd.tunnel) continue;
    const P = rd.pts, n = P.length, hw = rd.width / 2, br = rd.bridge, tb = rd.tube;
    for (let i = 0, a = -1; i < n - 1; i++) {
      if ((br?.[i] && br?.[i + 1]) || tb?.[i] || tb?.[i + 1]) { a = -1; continue; }
      if (a < 0) a = i;
      // carry the run on while the next point stays within 0.3 m of its line and 0.1 m of its straight grade (under 120 m)
      if (i + 2 < n && !(br?.[i + 1] && br?.[i + 2]) && !tb?.[i + 2]) {
        const A = P[a], Q = P[i + 2], p = P[i + 1], ex = Q.x - A.x, ez = Q.z - A.z, L2 = ex * ex + ez * ez, c = (p.x - A.x) * ez - (p.z - A.z) * ex;
        if (L2 < 14400 && c * c < 0.09 * L2 && Math.abs(A.y + (Q.y - A.y) * (((p.x - A.x) * ex + (p.z - A.z) * ez) / L2) - p.y) < 0.1) continue;
      }
      run(P[a], P[i + 1], hw); a = -1;
    }
  }
  // the level (L) and how much of it the ground takes (t, 0..1: the rest is the fine grid's own)
  const L = new Float32Array(N), t = new Float32Array(N);
  for (let j = 0; j <= dR; j++) for (let i = 0; i <= dR; i++) {
    const k = j * W + i, h = Hh[j * f * HW + i * f]; L[k] = h; if (!sw[k]) continue;
    const l = sy[k] / sw[k] + CITY_TOP; L[k] = l; t[k] = (1 - smoothstep(CITY_REACH * 0.7, CITY_REACH, dm[k])) * (1 - smoothstep(2.5, 4, Math.abs(l - h)));
  }
  return { L, t, R: dR, st };
}
// embankment/cutting width beside a road on a heightfield of spacing st (physics and the skirt meshes)
export const skirtWidth = (st) => Math.min(60, st * 0.75 + 10);
// The road surface index World.sampleGrid / groundAt read (built once the fine heights are carved)
export function roadSurface(w, net) { return new RoadSurface(w, allRoads(net), skirtWidth(w.hStep), w.detailGrid()[1] * 1.45, net.junctions); }

// Real places: OSM roads get a profile too (smoothed, grade-limited, mapped bridges kept as straight decks), so they
// can be carved in and driven like the planned ones. Reads the raw fine heights (w.Hh0).
export function gradeReal(w, net) {
  const city = !!w.loc.city;
  if (net.graded) { net.junctions = junctionShapes(net.roads, city); return; } // (the deploy's road pack: graded already, realworld.js packedNetwork)
  const roadK = new Map(net.roads.map((r, k) => [r, k]));
  const terr = gridSampler(w, w.Hh0, w.hR0), wl = w.waterLevel;
  // Ways are graded longest first; each is pinned to the ways already done wherever it meets them (#228):
  //  - its own ends, on another way's line (OSM ways meet at shared nodes, but the resampled points are 8-16 m apart,
  //    so a T-junction's node rarely falls on a point);
  //  - another way's end on its line (a longer way that ends on this one: graded first, so this one meets it);
  //  - where it crosses another way's line at grade (an X junction whose node is neither way's end).
  // Bridge decks are left out of the crossings (an overpass), but their ends join like any road's.
  const C = 20, segs = new Map(), ends = new Map(), key = (x, z) => Math.floor(x / C) + ',' + Math.floor(z / C);
  const put = (M, k, v) => { let a = M.get(k); if (!a) M.set(k, (a = [])); a.push(v); };
  const near = (M, x, z, fn) => { const ci = Math.floor(x / C), cj = Math.floor(z / C); for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const v of M.get(i + ',' + j) || []) fn(v); };
  const SNAP = 3;
  const add = (rd) => {
    const P = rd.pts;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1], deck = !!(rd.bridge?.[i] && rd.bridge?.[i + 1]) || !!(rd.tube?.[i] || rd.tube?.[i + 1]), sg = { a, b, deck, rd }; // (a tunnel's tube: not on the ground either)
      const seen = new Set();
      for (let f = 0; f <= 1.0001; f += Math.min(1, C / 2 / Math.max(1, a.distanceTo(b)))) { const k = key(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f); if (!seen.has(k)) { seen.add(k); put(segs, k, sg); } }
    }
    for (const p of [P[0], P.at(-1)]) put(ends, key(p.x, p.z), p);
  };
  // the nearest point on a done way's line to p (within SNAP): its height there
  const onLine = (p) => {
    let bd = SNAP, y = null;
    near(segs, p.x, p.z, ({ a, b }) => {
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
      const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z); if (d < bd) { bd = d; y = a.y + (b.y - a.y) * t; }
    });
    return y;
  };
  // the airport's landside road, out to the nearest real road (its own chain: graded with its gate pins)
  const gateRd = gateRoad(w, net.roads.filter((r) => !r.baked), { terr, wetAt: (x, z, h) => h < wl + 0.6 });
  if (gateRd) { Object.assign(gateRd, { real: true, bridge: gateRd.pts.map(() => false) }); net.roads.push(gateRd); }
  // junctions (roads.bin topology, realworld.js rd.jn): the first road graded through a node sets its height, every
  // other road through it is pinned there, at that exact point
  const nodeY = new Map(), setNodes = (q) => { for (const [j, nd] of q.jn || []) if (!nodeY.has(nd)) nodeY.set(nd, q.pts[j].y); };
  // (the spatial index of graded roads is only for roads without topology, other than the airport road, whose gate
  // and far end gatePins pins exactly: none at the real places today; building it was 0.4 s of New York's load)
  const index = net.roads.some((r) => (!r.jn && !r.gate && !r.baked) || r.minor), addI = (rd) => { if (index && !rd.minor) add(rd); }; // (and for the ways off the street network: the streets they overlap, below)
  for (const rd of net.roads) if (rd.baked) { rd.terr = Float32Array.from(rd.pts, (p) => terr(p.x, p.z)); rd.wet = new Uint8Array(rd.pts.length); addI(rd); setNodes(rd); } // bridges with a baked deck profile (realworld.js)
  // every other junction on the ground starts at the ground's height (the ground round it: a 9 m cross), so a road
  // graded off the ground (a street steeper than its grade, a cliff in the heights) can't carry that error through
  // its junctions to the rest of the network (#228: Palisades streets 27 m up). Junctions out on a bridge span are
  // left to the grading.
  // (and how wide the widest road through each junction is: every road crossing it is level for that half width
  // plus its verge either side, as a real junction is: no step where one road's grade meets the other's level
  // crossing, which was ~all the steps the road check found in New York)
  const nodeHW = new Map(); for (const rd of net.roads) if (!rd.minor) for (const [, nd] of rd.jn || []) nodeHW.set(nd, Math.max(nodeHW.get(nd) || 0, rd.width / 2));
  // (a node a street only passes through, there because a way off the street network joins it (rd.minor: an alley, a
  // pedestrian street): not a junction of the street's; the street is graded as if it weren't there and the minor way,
  // graded after every street, meets the street's height there)
  const carUse = new Map(); for (const rd of net.roads) if (!rd.minor) for (const [j, nd] of rd.jn || []) carUse.set(nd, (carUse.get(nd) || 0) + (j === 0 || j === rd.pts.length - 1 ? 2 : 1));
  const grounded = new Set();
  for (const rd of net.roads) if (!rd.baked) for (const [j, nd] of rd.jn || []) if ((!rd.bridge?.[j] && !rd.tunnel) || j === 0 || j === rd.pts.length - 1) grounded.add(nd); // (not out on a bridge, nor inside a tunnel; its ends, the portals, are on the ground)
  for (const rd of net.roads) if (!rd.baked) for (const [j, nd] of rd.jn || []) if (grounded.has(nd) && !nodeY.has(nd) && carUse.get(nd) !== 1) { const p = rd.pts[j]; nodeY.set(nd, Math.max(wl + 0.6, (terr(p.x, p.z) * 2 + terr(p.x + 9, p.z) + terr(p.x - 9, p.z) + terr(p.x, p.z + 9) + terr(p.x, p.z - 9)) / 6)); }
  // a junction is only made level (a box) where its neighbours along each arm can still be reached at a street's
  // grade from its mouth: on a steep street with a junction every 15-20 m, level boxes would leave a wall between
  // them (Bora Bora's hillside lanes); those junctions keep their roads' own grades (junctionShapes: no box)
  const keep = new Map(junctionPlan(net.roads, city).filter((J) => J.ok).map((J) => [J.nd, J]));
  for (const J of [...keep.values()]) for (const A of J.arms) {
    const rd = net.roads[A.k];
    let e = A.j + A.dir; while (e > 0 && e < rd.pts.length - 1 && !(rd.jn || []).some(([jj]) => jj === e)) e += A.dir;
    const fn = (rd.jn || []).find(([jj]) => jj === e)?.[1], y0 = nodeY.get(J.nd), y1 = fn != null ? nodeY.get(fn) : undefined; if (y0 == null || y1 == null) continue;
    const F = keep.get(fn), c2 = F?.arms.find((B) => B.k === A.k && B.j === e)?.c ?? 0, free = A.len - A.c - c2;
    if (Math.abs(y1 - y0) > JGRADE * Math.max(0, free) + 0.05) { keep.delete(J.nd); if (F) keep.delete(fn); }
  }
  // every other junction's box (junctions.js): a point on each arm at its mouth, the profile level from the node out to it
  insertMouths(net.roads, keep.values());
  const plan = new Map(junctionPlan(net.roads, city).filter((J) => J.ok && keep.has(J.nd)).map((J) => [J.nd, J]));
  for (const rd of chains(net.roads.filter((r) => !r.baked))) { // (longest first)
    const fixed = rd.bridge && rd.bridge.some(Boolean) ? rd.bridge.slice() : null, pins = [], level = [], P = rd.pts, n = P.length;
    const S = new Float64Array(n); for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    if (rd.members.length === 1 && rd.members[0].rd.gate) pins.push(...gatePins(rd.members[0].rd)); // (gateRoad: its own chain, never reversed)
    const own = rd.minor ? rd.members.flatMap((m) => (m.rd.jn || []).map(([j]) => S[m.start + (m.rev ? m.rd.pts.length - 1 - j : j)])) : null; // (a way off the street network: where its own junctions are along it)
    for (const m of rd.members) { const k = m.rd.pts.length, mk = roadK.get(m.rd); for (const [j, nd] of m.rd.jn || []) if (nodeY.has(nd)) {
      const i = m.start + (m.rev ? k - 1 - j : j), y = nodeY.get(nd), c = (nodeHW.get(nd) || 0) + VERGE + 1, J = plan.get(nd);
      pins.push({ i, y });
      // (the level junction: out to each arm's mouth, where insertMouths put a point; without a box, the widest road's
      // half width and verge either side)
      if (fixed?.[i]) continue;
      if (J) { for (const A of J.arms) if (A.k === mk && A.j === j) { const sp = S[i] + (m.rev ? -A.dir : A.dir) * A.c; if (sp > 0 && sp < S[n - 1]) pins.push({ s: sp, y }); level.push([Math.min(S[i], sp), Math.max(S[i], sp), y]); } }
      else for (const sg of [-1, 1]) { const sp = S[i] + sg * c; if (sp > 0 && sp < S[n - 1] && !own?.some((o) => o !== S[i] && Math.abs(o - sp) < 2.1)) pins.push({ s: sp, y }); } // (not next to another of a way off the street network's close-set junctions (a car park's aisles): profileRoad would merge the two pins and lose the junction's)
    } }
    const topo = rd.members.every((m) => m.rd.jn) || (rd.members.length === 1 && rd.members[0].rd.gate); // (the airport road: gatePins) // (roads.bin roads: their junctions are known, nodeY pins them; ways that cross without sharing a node are an over- or underpass, not a junction)
    if (!topo) for (const i of [0, n - 1]) { const y = onLine(P[i]); if (y != null) pins.push({ i, y }); }
    // where its footprint overlaps a done way's on the ground (side by side: a divided road's two carriageways, a
    // slip road; the mouth of a junction), its centre line takes that way's height: the two are one surface there.
    // (A ramp climbing to an overpass right beside the carriageway it left gets pulled down too: the steep stretch
    // that leaves is a retaining wall the road meshes don't draw yet, #228.)
    // (a way off the street network does too where it overlaps a street without a junction there, if the ground isn't
    // metres off the street (a track on the hillside just above a road, a car park beside it): else the two footprints,
    // apart in height, meet in a step. Not near its own junctions: they hold it at their height)
    if (!topo || rd.minor) for (let i = 0; i < n; i++) {
      if (fixed?.[i] || (own && own.some((s) => Math.abs(s - S[i]) < 4))) continue;
      const p = P[i], hw = rd.width / 2 + VERGE; let bd = Infinity, y = null;
      near(segs, p.x, p.z, ({ a, b, deck, rd: q }) => {
        if (deck) return;
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
        const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z); if (d < hw + q.width / 2 + VERGE && d < bd) { bd = d; y = a.y + (b.y - a.y) * t; }
      });
      if (y != null && !(rd.minor && Math.abs(terr(p.x, p.z) - y) > MINOR_PIN)) pins.push({ i, y });
    }
    if (!topo) for (let i = 0; i + 1 < n; i++) {
      const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz, L = Math.sqrt(L2); if (L < 1e-6) continue;
      const myDeck = !!(fixed?.[i] && fixed?.[i + 1]), mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, done = new Set();
      // done ways' ends on this segment
      near(ends, mid.x, mid.z, (q) => {
        if (done.has(q)) return; done.add(q);
        const t = ((q.x - a.x) * dx + (q.z - a.z) * dz) / L2; if (t < 0 || t > 1) return;
        if (Math.hypot(a.x + dx * t - q.x, a.z + dz * t - q.z) < SNAP) pins.push({ s: S[i] + t * L, y: q.y });
      });
      // crossings at grade
      if (myDeck) continue;
      near(segs, mid.x, mid.z, (sg) => {
        if (sg.deck || done.has(sg)) return; done.add(sg);
        const r = sg.a, q = sg.b, ex = q.x - r.x, ez = q.z - r.z, den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) return;
        const t = ((r.x - a.x) * ez - (r.z - a.z) * ex) / den, u = ((r.x - a.x) * dz - (r.z - a.z) * dx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) pins.push({ s: S[i] + t * L, y: r.y + (q.y - r.y) * u });
      });
    }
    const under = rd.members.some((m) => m.rd.tunnel) ? Uint8Array.from(P, (p, i) => (rd.members.some((m) => m.rd.tunnel && i >= m.start && i < m.start + m.rd.pts.length) ? 1 : 0)) : null; // (a tunnel's points: under the ground)
    profileRoad(rd, { g: GRADE.real, terr, wetAt: () => false, wl, clear: 0, smooth: 2, bridges: false, fixed, pins, under });
    for (const [a, b, y] of level) for (let k = 0; k < n; k++) if (S[k] >= a - 0.01 && S[k] <= b + 0.01 && !fixed?.[k]) P[k].y = y; // (a junction's box: level from the node out to each mouth, the points between too)
    for (const m of rd.members) {
      const q = m.rd, k = q.pts.length, at = (j) => m.start + (m.rev ? k - 1 - j : j);
      for (let j = 0; j < k; j++) q.pts[j].y = P[at(j)].y;
      q.terr = Float32Array.from(q.pts, (p, j) => rd.terr[at(j)]); q.wet = Uint8Array.from(q.pts, (p, j) => rd.wet[at(j)]); q.bridge = q.pts.map((p, j) => rd.bridge[at(j)]);
      if (q.tunnel) { // where the tunnel is a tube: 8 m of ground over it (less: an open cutting, carved), or below the water; one tube from the first such point to the last (no portals inside it)
        const o = q.width / 2 + 3, tb = q.pts.map((p, i) => { const a = q.pts[Math.max(0, i - 1)], b = q.pts[Math.min(q.pts.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, rx = -(b.z - a.z) / l * o, rz = (b.x - a.x) / l * o;
          return Math.min(terr(p.x, p.z), terr(p.x + rx, p.z + rz), terr(p.x - rx, p.z - rz)) - p.y > 8 || p.y < wl - 0.3; }), a = tb.indexOf(true), b = tb.lastIndexOf(true); // (the ground clears the tube either side too: no hillside inside the opening)
        q.tube = tb.map((_, i) => a >= 0 && i >= a && i <= b);
      }
      addI(q); setNodes(q);
    }
  }
  net.junctions = junctionShapes(net.roads, city);
}
// OSM splits a road into ways at every tag change (a bridge, a speed limit, a name): where exactly two ways meet end
// to end they are one road, graded as one chain (#228: two long ways graded apart, then a 15 m way between them
// left 17 m to climb). Returns the chains, longest first: { pts (the ways' own points, the shared node once), bridge,
// width, members: [{ rd, start (its first point's index in the chain), rev (it runs backwards along the chain) }] }.
function chains(ways) {
  const ek = (p, r) => Math.round(p.x * 2) + ',' + Math.round(p.z * 2) + (r.minor ? 'm' : ''), at = new Map(); // (the ways off the street network chain among themselves: a street and an alley are not one road)
  for (const r of ways) for (const e of [0, 1]) { if (r.gate) continue; const k = ek(e ? r.pts.at(-1) : r.pts[0], r); if (!at.has(k)) at.set(k, []); at.get(k).push({ r, e }); }
  const next = (r, e) => { const L = at.get(ek(e ? r.pts.at(-1) : r.pts[0], r)); return L?.length === 2 ? L.find((o) => o.r !== r) ?? null : null; }; // (a way's own two ends meeting: a loop, left alone)
  const used = new Set(), out = [];
  for (const r0 of ways) {
    if (used.has(r0)) continue;
    // back to the chain's first way: e is the end it starts from
    let r = r0, e = 0; const seen = new Set([r0]);
    for (;;) { const o = next(r, e); if (!o || seen.has(o.r) || used.has(o.r)) break; seen.add(o.r); r = o.r; e = 1 - o.e; }
    const mem = []; let from = e;
    for (;;) {
      used.add(r); mem.push({ rd: r, rev: from === 1 });
      const o = next(r, 1 - from); if (!o || used.has(o.r)) break;
      r = o.r; from = o.e;
    }
    const pts = [], bridge = []; let width = Infinity;
    for (const m of mem) {
      const P = m.rev ? m.rd.pts.slice().reverse() : m.rd.pts, B = m.rd.bridge ? (m.rev ? m.rd.bridge.slice().reverse() : m.rd.bridge) : P.map(() => false);
      m.start = pts.length ? pts.length - 1 : 0; width = Math.min(width, m.rd.width);
      if (pts.length) { bridge[bridge.length - 1] = bridge.at(-1) && B[0]; P.slice(1).forEach((p) => pts.push(p)); B.slice(1).forEach((b) => bridge.push(!!b)); }
      else { P.forEach((p) => pts.push(p)); B.forEach((b) => bridge.push(!!b)); }
    }
    out.push({ pts, bridge, width, members: mem, minor: !!r0.minor });
  }
  return out.sort((a, b) => (a.minor ? 1 : 0) - (b.minor ? 1 : 0) || b.pts.length - a.pts.length); // (the ways off the street network last: they meet the streets' heights)
}
// Paint fields / road verges into the baked albedo at texel (x,z). Returns a colour or null.
export function makePainter(w, net) {
  const cell = 300, grid = new Map();
  const add = (key, item) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(item); };
  for (const f of net.fields) {
    const R = Math.max(f.sx, f.sz) * 1.5;
    for (let gx = Math.floor((f.x - R) / cell); gx <= Math.floor((f.x + R) / cell); gx++) for (let gz = Math.floor((f.z - R) / cell); gz <= Math.floor((f.z + R) / cell); gz++) add(gx + ',' + gz, { f });
  }
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) rd.pts.forEach((p, i) => { if (i % 2 === 0 && !rd.bridge?.[i] && !rd.tube?.[i]) add(Math.floor(p.x / cell) + ',' + Math.floor(p.z / cell), { p, w: rd.width, rail: rd === net.rail }); });
  const tmp = new THREE.Color();
  return (x, z, c) => {
    const items = grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell)); if (!items) return;
    for (const it of items) {
      if (it.f) {
        const f = it.f, dx = x - f.x, dz = z - f.z;
        if (f.pivot) {
          const d = Math.hypot(dx, dz); if (d > f.sx) continue;
          const ring = Math.sin(d / f.stripe * 2) * 0.5 + 0.5;
          tmp.copy(f.c1).lerp(f.c2, ring * 0.6); c.lerp(tmp, 0.9 * smoothstep(f.sx, f.sx - 6, d));
        } else {
          const ca = Math.cos(f.ang), sa = Math.sin(f.ang), u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
          if (Math.abs(u) > f.sx || Math.abs(v) > f.sz) continue;
          const rows = Math.sin(u / f.stripe * Math.PI) * 0.5 + 0.5;
          tmp.copy(f.c1).lerp(f.c2, rows); c.lerp(tmp, 0.88);
          if (Math.abs(u) > f.sx - 3 || Math.abs(v) > f.sz - 3) c.multiplyScalar(0.8); // hedgerow edge
        }
      } else {
        const d = Math.hypot(x - it.p.x, z - it.p.z), half = it.w * 0.5;
        if (d < half + 4) c.lerp(tmp.set(it.rail ? 0x5a5048 : 0x6e6a60), (1 - smoothstep(half, half + 4, d)) * 0.8);
      }
    }
  };
}

// ---------------- meshes ----------------
function roadTexture(kind) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = kind === 'rail' ? '#5b5249' : '#3b3c3f'; g.fillRect(0, 0, 128, 256);
  const img = g.getImageData(0, 0, 128, 256); for (let i = 0; i < img.data.length; i += 4) { const k = (Math.random() - 0.5) * (kind === 'rail' ? 50 : 22); img.data[i] += k; img.data[i + 1] += k; img.data[i + 2] += k; } g.putImageData(img, 0, 0);
  if (kind === 'rail') {
    g.fillStyle = '#4a3a2c'; for (let y = 4; y < 256; y += 21) g.fillRect(16, y, 96, 9); // sleepers
  } else {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(34, 0, 10, 256); g.fillRect(84, 0, 10, 256); // tyre wear
    g.fillStyle = '#d9d9d2';
    if (kind !== 'street') { g.fillRect(5, 0, 4, 256); g.fillRect(119, 0, 4, 256); }
    g.fillStyle = kind === 'highway' ? '#e8c547' : '#d9d9d2';
    if (kind === 'highway') { g.fillRect(60, 0, 3, 256); g.fillRect(65, 0, 3, 256); }
    else if (kind === 'main') g.fillRect(62, 0, 4, 140);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildRoadMeshes(w, net) {
  const group = new THREE.Group();
  const mats = {};
  const mat = (kind) => mats[kind] || (mats[kind] = new THREE.MeshStandardMaterial({ map: roadTexture(kind), roughness: kind === 'rail' ? 1 : 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
  const verge = new THREE.MeshStandardMaterial({ color: 0x4a4538, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.8, side: THREE.DoubleSide });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 0.9, roughness: 0.35 });
  // Lazy tiles (#228: every road of a real place, ~54k in New York, took ~22 s to mesh up front): each road and bridge
  // belongs to the TILE-metre square its first point is in, and a square's meshes (merged per material: few draw
  // calls) are only built when the camera comes near (group.userData.update: nearest first, a few ms a frame; while
  // the flight loads, all of those near the start at once). Elsewhere than a city every square is built in the end
  // (the roads show from the air); a city's are drawn out to ROAD_D (the ground photo shows the roads beyond).
  const chunk = w.loc.roads?.chunk, TILE = chunk || 2000;
  let pending = null;
  const add = (material, g) => { let e = pending.get(material); if (!e) pending.set(material, (e = [])); e.push(g); };
  const frame = (P, i, closed) => { // unit direction and right vector at point i
    const n = P.length, a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); return [d, new THREE.Vector3(-d.z, 0, d.x)];
  };
  // a strip across the road at every point: rows of lateral offsets (heights from hf(i, x, z, off)), quads only on
  // the segments seg(i) allows
  // (offs: the same for every row, or per row: offs(i) -> offsets. Rows of different lengths are zipped together
  // by their offsets: no cracks where a road's ribbon goes from two vertices across to more)
  const strip = (rd, offs, hf, seg, material, uvf, gap = -1, info = null, pt4 = null) => { // gap: a column left open (the verges either side of the tarmac); info: rinfo for every vertex, pt4: rjunc per point (roadSurface.js)
    const P = rd.pts, n = P.length, closed = !!rd.closed, pos = [], uv = [], idx = [], ri = [], rj = [], rowOf = typeof offs === 'function' ? offs : () => offs;
    let dist = 0, o0 = 0, prev = null;
    for (let k = 0; k <= (closed ? n : n - 1); k++) {
      const i = k % n, p = P[i], [, rt] = frame(P, i, closed), row = rowOf(i), m = row.length, o = pos.length / 3;
      if (k > 0) dist += P[i].distanceTo(P[(i - 1 + n) % n]);
      for (let c = 0; c < m; c++) { const x = p.x + rt.x * row[c], z = p.z + rt.z * row[c]; pos.push(x, hf(i, x, z, row[c], c), z); uv.push(...uvf(c, dist, row[c])); if (info) ri.push(...info); if (pt4) rj.push(pt4[i * 4], pt4[i * 4 + 1], pt4[i * 4 + 2], pt4[i * 4 + 3]); }
      if (k > 0 && seg((k - 1) % n)) {
        if (prev.length === m) { for (let c = 0; c < m - 1; c++) if (c !== gap) idx.push(o0 + c, o0 + c + 1, o + c, o0 + c + 1, o + c + 1, o + c); }
        else for (let a = 0, b = 0; a < prev.length - 1 || b < m - 1;) { // zip: advance along whichever row's next vertex is nearer the start
          if (b >= m - 1 || (a < prev.length - 1 && prev[a + 1] <= row[b + 1])) { idx.push(o0 + a, o0 + a + 1, o + b); a++; } else { idx.push(o0 + a, o + b + 1, o + b); b++; }
        }
      }
      o0 = o; prev = row;
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); if (info) g.setAttribute('rinfo', new THREE.Float32BufferAttribute(ri, 3)); if (pt4) g.setAttribute('rjunc', new THREE.Float32BufferAttribute(rj, 4)); g.setIndex(idx); g.computeVertexNormals();
    add(material, g);
  };
  const isBr = (rd, i) => !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % rd.pts.length]);
  // embankment skirts: the ground the physics sees just off the road (World.sampleGrid), drawn with the terrain's own
  // material where the baked grid is too coarse to show it (only there)
  const skirtMat = new THREE.MeshStandardMaterial({ roughness: w.patchMat.roughness, metalness: 0 }); // (not clone(): that JSON-copies userData, the terrain textures)
  Object.assign(skirtMat, { onBeforeCompile: w.patchMat.onBeforeCompile, defines: w.patchMat.defines, userData: w.patchMat.userData, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const SW = skirtWidth(w.hStep), meshH = (x, z) => { const fx = (x + w.half) / w.hStep, fz = (z + w.half) / w.hStep; return fx >= 0 && fz >= 0 && fx < w.hR && fz < w.hR ? w.triAt(w.Hh, w.hR + 1, fx, fz) : w.sampleCoarse(x, z); };
  // (only off a city, only the main roads, only where the grid is half a metre or more off: near the camera the ground
  // detail mesh, World.updateDetail, draws the embankments exactly. #251 drew them for every street: 4.9M triangles
  // in New York, two thirds of its road meshes)
  const skirtsOn = !w.loc.city, SKIRT_MIN = 0.4;
  const skirts = (rd) => {
    if (!skirtsOn || rd.minor || (rd.kind === 'street' && rd.real)) return;
    const P = rd.pts, n = P.length, hw = rd.width / 2 + VERGE, rows = [0, 1.5, 4, 8, 13, 20, 30, 42, 60].filter((o) => o < SW).concat([SW]);
    const need = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (rd.bridge?.[i] || rd.tube?.[i]) continue;
      const p = P[i], [, rt] = frame(P, i, rd.closed);
      for (const s of [-1, 1]) for (const o of rows) { const x = p.x + rt.x * (hw + o) * s, z = p.z + rt.z * (hw + o) * s; if (Math.abs(w.sampleGrid(x, z) - meshH(x, z)) > SKIRT_MIN) { need[i] = 1; break; } }
    }
    const ok = (i) => !isBr(rd, i) && (need[i] || need[(i + 1) % n] || need[(i - 1 + n) % n] || need[(i + 2) % n]);
    for (const s of [-1, 1]) {
      const offs = (s < 0 ? rows.slice().reverse() : rows).map((o) => s * (hw + o));
      strip(rd, offs, (i, x, z) => w.sampleGrid(x, z), ok, skirtMat, (c, d) => [c, d]); // (from the road's edge, where its shoulder meets it: surf)
    }
  };
  // the tarmac and its gravel shoulders (roadSurface.js): uv in metres (across, along), rinfo = half width, what is
  // painted on it, a seed
  const region = REGION[w.loc.id] || 'ch', city = !!w.loc.roads?.chunk, tarmac = tarmacMaterial(region, { city: !!w.loc.city }), shoulder = shoulderMaterial(region);
  const sidewalk = w.loc.city ? sidewalkMaterial() : null; // (a city's streets: kerbs and pavements)
  // the ways off the street network (rd.minor) and the plazas (net.areas): paving, gravel, or the tarmac with nothing
  // painted on it (an alley); made only for the surfaces this place has
  const used = new Set([...net.roads.filter((r) => r.minor).map((r) => r.surf || 0), ...(net.areas || []).map((a) => a.surf || 0)]);
  const paths = used.has(1) || used.has(2) ? pathMaterial(region) : null, pathMat = (sf) => (sf === 1 || sf === 2 ? paths : tarmac);
  const J = net.roads.some((r) => r.jn) ? junctionsFromNodes(net.roads, region, city, net.junctions) : findJunctions(net.roads, region, city);
  // where a road lies on the ground its surface is the ground physics drives on (World.sampleGrid), not its own profile:
  // where two roads' footprints overlap (side by side at different heights, a slip road, the mouth of a junction)
  // that is one surface, blended between them (RoadSurface.blend), and a ribbon at its own profile sank under it: the
  // ground showed through the road (#228). On a bridge deck or in a tunnel's tube: its own profile.
  const surf = (jp, i, x, z) => (jp.bridge[i] || jp.tube[i] ? jp.pts[i].y : w.sampleGrid(x, z));
  // That blend is a ramp a few metres across, and a ribbon two vertices wide and 8 m between rows cut under it (the
  // ground through the road again): where another road's footprint overlaps this one and the ground is more than MISS
  // metres above what the ribbon would draw, those segments get a row every REFINE metres and a column every REFINE
  // metres across the tarmac (the rows either side zipped to them). Elsewhere (most of every road) as before. What is
  // left under MISS, the detail mesh lies under (World.updateDetail).
  const RS = w.roadSurf, REFINE = 4, MISS = 0.1;
  // mark[i]: the segment from point i to the next is refined. Where another road's footprint reaches into this one's
  // (cheap: RoadSurface's own overlap record), the ground is sampled across the segment and compared with what the
  // two-vertex ribbon would draw.
  const overlaps = (jp, hw) => {
    const P = jp.pts, n = P.length, last = jp.closed ? n : n - 1, ov = new Uint8Array(n), mark = new Uint8Array(n), E = new Float64Array(n * 4); let any = false;
    if (!RS) return null;
    for (let i = 0; i < n; i++) {
      if (jp.bridge[i] || jp.tube[i]) continue;
      const [, rt] = frame(P, i, jp.closed);
      for (const s of [-1, 1]) { const o = (hw + VERGE - 0.3) * s; if (RS.q(P[i].x + rt.x * o, P[i].z + rt.z * o) && RS.nIn > 1) ov[i] = 1; } // (two roads' footprints: this one's and another's)
      E[i * 4] = rt.x; E[i * 4 + 1] = rt.z;
    }
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n; if (!(ov[i] || ov[j]) || jp.bridge[i] || jp.bridge[j] || jp.tube[i] || jp.tube[j]) continue;
      const A = P[i], B = P[j], ax = E[i * 4], az = E[i * 4 + 1], bx = E[j * 4], bz = E[j * 4 + 1];
      const at = (t, o) => { const xa = A.x + ax * o, za = A.z + az * o; return [xa + (B.x + bx * o - xa) * t, za + (B.z + bz * o - za) * t]; };
      const g = (t, o) => { const [x, z] = at(t, o); return w.sampleGrid(x, z); };
      const v0 = g(0, -hw), v1 = g(0, hw), v2 = g(1, -hw), v3 = g(1, hw);
      seg: for (const t of [0, 0.25, 0.5, 0.75]) for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const r = t + f <= 1 ? v0 + (v2 - v0) * t + (v1 - v0) * f : v3 + (v1 - v3) * (1 - t) + (v2 - v3) * (1 - f);
        if (g(t, -hw + 2 * hw * f) - r > MISS) { mark[i] = 1; any = true; break seg; }
      }
    }
    return any ? mark : null;
  };
  // jp with rows every REFINE metres along the marked segments
  const refine = (jp, mark) => {
    const P = jp.pts, n = P.length, last = jp.closed ? n : n - 1, rj = jp.rjunc, out = { pts: [], bridge: [], tube: [], rjunc: [], fine: [], closed: jp.closed };
    for (let i = 0; i < n; i++) {
      out.pts.push(P[i]); out.bridge.push(jp.bridge[i]); out.tube.push(jp.tube[i]); out.rjunc.push(rj[i * 4], rj[i * 4 + 1], rj[i * 4 + 2], rj[i * 4 + 3]);
      out.fine.push(!!(mark[i] || (i > 0 || jp.closed) && mark[(i - 1 + n) % n])); // (a row of a refined segment: as many columns as its rows)
      if (i >= last) continue;
      const j = (i + 1) % n, L = Math.hypot(P[j].x - P[i].x, P[j].z - P[i].z), m = Math.ceil(L / REFINE);
      if (!mark[i] || m < 2) continue;
      for (let s = 1; s < m; s++) { const t = s / m; out.pts.push(P[i].clone().lerp(P[j], t)); out.bridge.push(false); out.tube.push(false); out.fine.push(true); out.rjunc.push(rj[i * 4] + (rj[j * 4] - rj[i * 4]) * t, rj[i * 4 + 1] + (rj[j * 4 + 1] - rj[i * 4 + 1]) * t, rj[i * 4 + 2], rj[i * 4 + 3]); }
    }
    return out;
  };
  // a way off the street network: one ribbon on the ground, flush, no kerbs, shoulders or
  // markings, under a street's tarmac where it meets one (the street's pavement runs on across its mouth, as at a
  // driveway: junctions.js leaves these out of the junctions)
  const minorMesh = (rd, k) => {
    const hw = rd.width / 2, jp = junctionPoints(rd, J[k]), m = pathMat(rd.surf || 0), info = [hw, m === tarmac ? 32 : rd.surf, (k * 7.31) % 97]; // (the tarmac's style 32: nothing painted, one lane; pathMaterial's look)
    strip(jp, [-hw, hw], (i, x, z) => surf(jp, i, x, z) + MINOR_LIFT, () => true, m, (c, d, o) => [o, d], -1, info, jp.rjunc);
  };
  const roadMesh = (rd, k) => {
    if (rd.minor) return minorMesh(rd, k);
    const hw = rd.width / 2, info = [hw, roadStyle(region, rd, city), (k * 7.31) % 97], jp0 = junctionPoints(rd, J[k]), mark = w.loc.city ? null : overlaps(jp0, hw), // (not a city's: New York's every junction mouth, +1.4M triangles; its gentle streets are covered by the detail mesh lying under them, World.updateDetail)
      jp = mark ? refine(jp0, mark) : jp0;
    const nc = Math.ceil(2 * hw / REFINE), fine = Array.from({ length: nc + 1 }, (_, c) => -hw + 2 * hw * c / nc), two = [-hw, hw], cols = mark ? (i) => (jp.fine[i] ? fine : two) : two;
    const lift = TARMAC_LIFT[rd.kind] ?? 0.04; // (the tarmac's: below)
    if (!w.loc.city || rd.kind === 'highway') strip(jp, [-hw - VERGE, -hw, hw, hw + VERGE], (i, x, z) => surf(jp, i, x, z), (i) => !isBr(jp, i) && !(jp.tube[i] && jp.tube[(i + 1) % jp.pts.length]), shoulder, (c, d, o) => [o, d], 1, info, jp.rjunc);
    // a city street's pavements: the kerb's face (15 cm up from the gutter) and the slabs out to the building line
    if (sidewalk && rd.kind !== 'highway' && !rd.baked) {
      // (a slab level across, at the road's height at the kerb: out over the ground's slopes beyond the footprint, which
      // the ground's meshes don't hold under it)
      const W = PAVE[rd.kind] ?? 3.5, kc = new Float64Array(jp.pts.length * 2).fill(NaN), kerb = (i, x, z, o) => { const s = i * 2 + (o > 0 ? 1 : 0); if (Number.isNaN(kc[s])) { const p = jp.pts[i], f = hw / Math.abs(o); kc[s] = surf(jp, i, p.x + (x - p.x) * f, p.z + (z - p.z) * f); } return kc[s]; };
      const up = (i, x, z, o, c) => kerb(i, x, z, o) + lift + (c === 0 ? 0 : 0.15), up2 = (i, x, z, o, c) => kerb(i, x, z, o) + lift + (c === 3 ? 0 : 0.15);
      strip(jp, [hw, hw, hw + 0.35, hw + W], up, (i) => !isBr(jp, i) && !(jp.tube[i] && jp.tube[(i + 1) % jp.pts.length]), sidewalk, (c, d, o) => [o, d], -1, info, jp.rjunc);
      strip(jp, [-hw - W, -hw - 0.35, -hw, -hw], up2, (i) => !isBr(jp, i) && !(jp.tube[i] && jp.tube[(i + 1) % jp.pts.length]), sidewalk, (c, d, o) => [o, d], -1, info, jp.rjunc);
    }
    // (lifted over every shoulder, and the bigger road over the smaller: where two lie on one surface, side by side or
    // at a junction's mouth, the major one's tarmac and markings show, not the other's gravel or edge line)
    strip(jp, cols, (i, x, z) => surf(jp, i, x, z) + lift, () => true, tarmac, (c, d, o) => [o, d], -1, info, jp.rjunc);
    skirts(rd);
  };
  const tileOf = (p) => Math.floor(p.x / TILE) + ',' + Math.floor(p.z / TILE), tiles = new Map();
  const tile = (key) => { let t = tiles.get(key); if (!t) { const [i, j] = key.split(',').map(Number); tiles.set(key, (t = { key, x: (i + 0.5) * TILE, z: (j + 0.5) * TILE, roads: [], built: false, meshes: [] })); } return t; };
  net.roads.forEach((rd, k) => tile(tileOf(rd.pts[0])).roads.push(k));
  for (const A of net.areas || []) (tile(tileOf({ x: (A.bb[0] + A.bb[2]) / 2, z: (A.bb[1] + A.bb[3]) / 2 })).plazas ??= []).push(A);
  for (const B of net.junctions || []) (tile(tileOf(B)).juncs ??= []).push(B);
  // a junction's box (junctions.js): one level slab of tarmac over the junction, out to its arms' mouths and round the
  // kerbs' corners (the arms' ribbons stop at the mouths: rjunc's box flag); in a city the corner pavements, with their
  // kerb, between the arms' pavements. Plain tarmac: no markings in the box (rinfo: a half width it never reaches,
  // no style; rjunc: no junction).
  const NOJ = [1e4, 1e4, 0, 0];
  const junctionMesh = (B, seed) => {
    const nb = B.box.length / 2, pos = [], uv = [], ri = [], rj = [], nor = [];
    for (let q = 0; q < nb; q++) { const x = B.box[q * 2], z = B.box[q * 2 + 1]; pos.push(x, B.y + B.lift[q], z); uv.push(x - B.x, z - B.z); ri.push(1e4, 0, seed); rj.push(...NOJ); nor.push(0, 1, 0); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('rinfo', new THREE.Float32BufferAttribute(ri, 3)); g.setAttribute('rjunc', new THREE.Float32BufferAttribute(rj, 4));
    g.setIndex(B.tris.slice()); add(tarmac, g);
    if (!sidewalk) return;
    for (const rows of B.pave) { // rows round the kerb: the kerb's face (from the gutter up 15 cm), then the slabs out to the building line (the granite band: the shader's, uv)
      const p2 = [], u2 = [], r2 = [], j2 = [], idx = [];
      rows.forEach((r, q) => {
        const dx = r.o[0] - r.k[0], dz = r.o[1] - r.k[1], W = Math.hypot(dx, dz) || 1, y = B.y + r.lift;
        for (const [o, h] of [[0, 0], [0, 0.15], [W, 0.15]]) { p2.push(r.k[0] + dx * o / W, y + h, r.k[1] + dz * o / W); u2.push(r.hw + o, r.v); r2.push(r.hw, 0, seed); j2.push(...NOJ); }
        if (q) { const a = (q - 1) * 3, b = q * 3; for (let c = 0; c < 2; c++) idx.push(a + c, b + c, a + c + 1, a + c + 1, b + c, b + c + 1); } // (facing up, the kerb's face towards the road)
      });
      if (!idx.length) continue;
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(p2, 3)); g2.setAttribute('uv', new THREE.Float32BufferAttribute(u2, 2)); g2.setAttribute('rinfo', new THREE.Float32BufferAttribute(r2, 3)); g2.setAttribute('rjunc', new THREE.Float32BufferAttribute(j2, 4));
      g2.setIndex(idx); g2.computeVertexNormals(); add(sidewalk, g2);
    }
  };
  // a plaza (a pedestrian area, a square): its outline filled, cut into PLAZA_CELL squares (each square's piece of the
  // outline, triangulated) so it lies on the ground's slopes; neighbouring pieces share their edges' points exactly
  const plazaMesh = (A) => {
    const r = A.ring, n = r.length / 2, C = PLAZA_CELL, [x0, z0, x1, z1] = A.bb, pos = [], uv = [], ri = [], idx = [], seed = (Math.abs(r[0] * 0.37 + r[1] * 0.11) % 97);
    const ring = []; for (let i = 0; i < n; i++) ring.push([r[i * 2], r[i * 2 + 1]]);
    const clip = (P, ax, az, nx, nz) => { const out = []; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], dp = (p[0] - ax) * nx + (p[1] - az) * nz, dq = (q[0] - ax) * nx + (q[1] - az) * nz; if (dp >= 0) out.push(p); if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); } } return out; };
    for (let cz = Math.floor(z0 / C) * C; cz < z1; cz += C) for (let cx = Math.floor(x0 / C) * C; cx < x1; cx += C) {
      let P = clip(ring, cx, 0, 1, 0); P = clip(P, cx + C, 0, -1, 0); P = clip(P, 0, cz, 0, 1); P = clip(P, 0, cz + C, 0, -1);
      if (P.length < 3) continue;
      // (a concave outline can leave a piece that runs along the cell's edge and back: triangulated as a shape, which
      // drops the zero-area slivers)
      const tris = THREE.ShapeUtils.triangulateShape(P.map(([x, z]) => new THREE.Vector2(x, z)), []), o = pos.length / 3;
      for (const [x, z] of P) { pos.push(x, w.sampleGrid(x, z) + MINOR_LIFT, z); uv.push(x, z); ri.push(1e4, A.surf || 32, seed); }
      for (const [a, b, c] of tris) { const up = (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]) < 0; idx.push(o + a, o + (up ? b : c), o + (up ? c : b)); } // (facing up: clockwise in x, z)
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('rinfo', new THREE.Float32BufferAttribute(ri, 3)); g.setIndex(idx); g.computeVertexNormals();
    const nv = pos.length / 3, rj = new Float32Array(nv * 4); for (let v = 0; v < nv; v++) rj[v * 4] = rj[v * 4 + 1] = 1e4; g.setAttribute('rjunc', new THREE.BufferAttribute(rj, 4)); // (no junction)
    add(pathMat(A.surf ?? 1), g);
  };
  let bridgeGeos = [];
  const railGeos = [];
  // bridges: a deck slab with parapets, piers down to the ground or river bed, and abutments at both ends
  const bridgeMesh = (rd) => {
    const P = rd.pts, n = P.length, closed = !!rd.closed; if (!rd.bridge?.some(Boolean)) return;
    const hw = rd.width / 2 + 1, decks = new Map(); let pos = null; // (deck triangles per chunk square: see bridgeAdd)
    const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    let runLen = 0;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      if (!isBr(rd, i)) { runLen = 0; continue; }
      const j = (i + 1) % n, A = P[i], B = P[j], [, ra] = frame(P, i, closed), [, rb] = frame(P, j, closed);
      const dk = chunk ? Math.floor(A.x / chunk) + ',' + Math.floor(A.z / chunk) : ''; pos = decks.get(dk); if (!pos) decks.set(dk, (pos = []));
      const at = (p, r, o, dy) => [p.x + r.x * o, p.y + dy, p.z + r.z * o];
      // deck: top, both sides, underside (the tarmac ribbon lies on top)
      quad(at(A, ra, -hw, -0.01), at(A, ra, hw, -0.01), at(B, rb, hw, -0.01), at(B, rb, -hw, -0.01));
      for (const s of [-1, 1]) {
        const o = hw * s;
        quad(at(A, ra, o, -1.4), at(B, rb, o, -1.4), at(B, rb, o, 1.0), at(A, ra, o, 1.0)); // outer face + parapet
        quad(at(A, ra, o - 0.3 * s, 1.0), at(B, rb, o - 0.3 * s, 1.0), at(B, rb, o - 0.3 * s, -0.01), at(A, ra, o - 0.3 * s, -0.01)); // parapet inner face
        quad(at(A, ra, o, 1.0), at(B, rb, o, 1.0), at(B, rb, o - 0.3 * s, 1.0), at(A, ra, o - 0.3 * s, 1.0)); // parapet top
      }
      quad(at(A, ra, hw, -1.4), at(A, ra, -hw, -1.4), at(B, rb, -hw, -1.4), at(B, rb, hw, -1.4));
      // piers every ~32 m where the deck is clear of the ground; abutments where a span starts or ends
      runLen += A.distanceTo(B);
      const start = !isBr(rd, (i - 1 + n) % n) || (!closed && i === 0), end = !isBr(rd, j) || (!closed && j === n - 1);
      for (const [p, r, isEnd] of [[A, ra, start], [B, rb, end]]) {
        const bed = Math.min(w.sampleGrid(p.x, p.z), meshH(p.x, p.z)) - 1.5, ht = p.y - 1.4 - bed;
        if (isEnd) { if (ht > 0.2) bridgeGeos.push(new THREE.BoxGeometry(hw * 2 + 0.4, ht + 1.4, 2.5).rotateY(Math.atan2(-r.z, r.x)).translate(p.x, bed + (ht + 1.4) / 2, p.z)); continue; }
        if (p !== B || runLen < 32 || ht < 2.5 || end || rd.span?.[j]) continue; // (no piers under a suspended span)
        runLen = 0;
        const yaw = Math.atan2(-r.z, r.x);
        bridgeGeos.push(new THREE.BoxGeometry(hw * 2 - 0.5, 1.2, 2.2).rotateY(yaw).translate(p.x, p.y - 2.0, p.z)); // pier cap
        for (const s of [-1, 1]) { const cx = p.x + r.x * hw * 0.5 * s, cz = p.z + r.z * hw * 0.5 * s, cb = Math.min(w.sampleGrid(cx, cz), meshH(cx, cz)) - 1.5, ch = p.y - 2.6 - cb; if (ch > 0.5) bridgeGeos.push(new THREE.CylinderGeometry(0.75, 0.95, ch, 10).translate(cx, cb + ch / 2, cz)); }
      }
    }
    for (const dp of decks.values()) if (dp.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3)); bridgeGeos.push(g); }
  };
  if (net.rail) bridgeMesh(net.rail);
  // street lamps (glow at night): per tile, built and culled with it (#251: on Low every street of New York got
  // posts, ~7M triangles in one instanced mesh). Not on a real place's minor streets (its scenery has its own), not on
  // highways or mountain roads.
  const lampMat = new THREE.PointsMaterial({ size: 3, color: new THREE.Color(3.2, 2.2, 1.1), map: glow(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  group.userData.lampMat = lampMat;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8e94, metalness: 0.6, roughness: 0.45 });
  const poleGeo = mergeGeometries([new THREE.CylinderGeometry(0.07, 0.12, 7.4, 6).translate(0, 3.5, 0), new THREE.BoxGeometry(0.08, 0.08, 1.5).translate(0, 7.15, 0.65), new THREE.BoxGeometry(0.28, 0.12, 0.6).translate(0, 7.05, 1.25)].map((g) => g.toNonIndexed()));
  const lampsFor = (rd, lamps, poles, jn = []) => { // (jn: the road's junctions, J[k]: no post within a junction's clearance, out in the crossing road)
    if (rd.kind === 'highway' || rd.mountain || rd.minor || (rd.kind === 'street' && (rd.real || w.qName !== 'low'))) return;
    const every = rd.kind === 'street' ? 4 : 6;
    let at = 0; // (metres along the road)
    rd.pts.forEach((p, i) => { if (i) at += Math.hypot(p.x - rd.pts[i - 1].x, p.z - rd.pts[i - 1].z); if (i % every || jn.some((j) => Math.abs(j.s - at) < j.r + 1.5)) return; const a = rd.pts[Math.max(0, i - 1)], b = rd.pts[Math.min(rd.pts.length - 1, i + 1)], d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); const s = (i / every) % 2 ? 1 : -1; const off = rd.bridge?.[i] ? rd.width / 2 + 0.6 : rd.width / 2 + 1.5, x = p.x - d.z * off * s, z = p.z + d.x * off * s, gy = rd.bridge?.[i] ? p.y + 1 : w.sampleGrid(x, z); lamps.push(x + d.z * 1.2 * s, gy + 7, z - d.x * 1.2 * s); poles.push(x, gy, z, Math.atan2(d.z * s, -d.x * s)); });
  };
  const lampMeshes = (lamps, poles, t) => {
    if (!poles.length) return;
    const pm = new THREE.InstancedMesh(poleGeo, poleMat, poles.length / 4), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < poles.length / 4; k++) pm.setMatrixAt(k, m4.compose(new THREE.Vector3(poles[k * 4], poles[k * 4 + 1] - 0.2, poles[k * 4 + 2]), q.setFromAxisAngle(up, poles[k * 4 + 3]), one));
    pm.castShadow = w.qName === 'high' || w.qName === 'ultra'; pm.computeBoundingSphere(); group.add(pm); t.meshes.push(pm);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3)); const pt = new THREE.Points(lg, lampMat); group.add(pt); t.meshes.push(pt);
  };
  // tunnels: the tube (walls and a vault over the road, lined; a strip of lights along its crown) where there's
  // ground or water over it, and a concrete portal (a headwall round the opening) where it goes in
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0x6e6c66, emissive: 0x2a2924, roughness: 0.9, side: THREE.DoubleSide }); // (lined; lit from within: the light strip)
  const tubeLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.9, 1.3), toneMapped: false });
  let tubeGeos = [], lightGeos = [];
  const tubeMesh = (rd) => {
    if (!rd.tube?.some(Boolean)) return;
    const P = rd.pts, n = P.length, hw = rd.width / 2 + 1.2, H = 5.6, pos = [], lit = [];
    const quad = (A, a, b, c, d) => A.push(...a, ...b, ...c, ...a, ...c, ...d);
    const at = (p, r, o, dy) => [p.x + r.x * o, p.y + dy, p.z + r.z * o];
    for (let i = 0; i + 1 < n; i++) {
      if (!(rd.tube[i] && rd.tube[i + 1])) continue;
      const A = P[i], B = P[i + 1], [, ra] = frame(P, i, false), [, rb] = frame(P, i + 1, false);
      for (const sd of [-1, 1]) { quad(pos, at(A, ra, hw * sd, -0.3), at(B, rb, hw * sd, -0.3), at(B, rb, hw * sd, H * 0.8), at(A, ra, hw * sd, H * 0.8)); quad(pos, at(A, ra, hw * sd, H * 0.8), at(B, rb, hw * sd, H * 0.8), at(B, rb, hw * 0.55 * sd, H), at(A, ra, hw * 0.55 * sd, H)); }
      quad(pos, at(A, ra, -hw * 0.55, H), at(B, rb, -hw * 0.55, H), at(B, rb, hw * 0.55, H), at(A, ra, hw * 0.55, H));
      quad(lit, at(A, ra, -0.25, H - 0.05), at(A, ra, 0.25, H - 0.05), at(B, rb, 0.25, H - 0.05), at(B, rb, -0.25, H - 0.05));
      // the portals: where the tube begins or ends, a headwall facing out with the opening in it
      for (const [p, r, out] of [[A, ra, i === 0 || !rd.tube[i - 1]], [B, rb, i + 2 >= n || !rd.tube[i + 2]]]) {
        if (!out) continue;
        const W = hw + 5, top = H + 6, t = 0.7, d = new THREE.Vector3(-r.z, 0, r.x), wall = (o0, o1, y0, y1) => { const g = new THREE.BoxGeometry(o1 - o0, y1 - y0, t); g.rotateY(Math.atan2(r.x, r.z) + Math.PI / 2); g.translate(p.x + r.x * (o0 + o1) / 2, p.y + (y0 + y1) / 2, p.z + r.z * (o0 + o1) / 2); tubeGeos.push(g); };
        wall(-W, -hw, -1, top); wall(hw, W, -1, top); wall(-hw, hw, H, top); void d;
      }
    }
    if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); tubeGeos.push(g); }
    if (lit.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(lit, 3)); lightGeos.push(g); }
  };
  // building a tile: its roads' ribbons, shoulders, skirts and bridges, merged per material
  const D = ROAD_D[w.qName] ?? 10000, warm = new Set([tarmac, shoulder, skirtMat, concrete, poleMat, tubeMat, tubeLight, ...[sidewalk, paths].filter(Boolean)]);
  const buildTile = (t) => {
    pending = new Map(); bridgeGeos = [];
    const lamps = [], poles = [];
    tubeGeos = []; lightGeos = [];
    for (const k of t.roads) { roadMesh(net.roads[k], k); bridgeMesh(net.roads[k]); tubeMesh(net.roads[k]); if (!net.roads[k].tunnel) lampsFor(net.roads[k], lamps, poles, J[k]); }
    for (const B of t.juncs || []) junctionMesh(B, (B.nd * 7.31) % 97);
    for (const A of t.plazas || []) plazaMesh(A);
    if (tubeGeos.length) { const m = new THREE.Mesh(mergeAll(tubeGeos), tubeMat); m.receiveShadow = true; group.add(m); t.meshes.push(m); }
    if (lightGeos.length) { const m = new THREE.Mesh(mergeAll(lightGeos), tubeLight); group.add(m); t.meshes.push(m); }
    lampMeshes(lamps, poles, t);
    for (const [material, geos] of pending) { const m = new THREE.Mesh(mergeGeometries(geos), material); m.receiveShadow = true; group.add(m); t.meshes.push(m); }
    if (bridgeGeos.length) { const m = new THREE.Mesh(mergeAll(bridgeGeos), concrete); m.castShadow = m.receiveShadow = true; group.add(m); t.meshes.push(m); }
    t.built = true; pending = null;
  };
  // (the rail line, if any, now: it is one long object)
  if (net.rail && (pending = new Map())) { const rl = net.rail; strip(rl, [-2.3, 2.3], (i) => rl.pts[i].y + 0.05, () => true, mat('rail'), (c, d) => [c, d / 8]); for (const [material, geos] of pending) group.add(new THREE.Mesh(mergeGeometries(geos), material)); pending = null; }
  // every material keeps an empty stand-in, so its shader compiles at load even before any tile near it is built
  for (const mt of warm) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(9, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(6, 2)); const m = new THREE.Mesh(g, mt); m.frustumCulled = false; group.add(m); }
  const all = [...tiles.values()], near = (t, cam) => Math.hypot(t.x - cam.x, t.z - cam.z) - TILE * 0.71;
  // update(cam, ms): build missing tiles nearest first (those in reach: all of them away from a city) for up to ms
  // milliseconds; show / hide a city's built tiles by distance. Returns true when every tile within `within` m is built.
  // (stepClock.js: under the test stepper, ms tiles instead of ms milliseconds)
  group.userData.update = (cam, ms = 4, within = 0) => {
    const t0 = performance.now(); let n = 0;
    let todo = all.filter((t) => !t.built && (!D || near(t, cam) < D));
    if (todo.length) { todo.sort((a, b) => near(a, cam) - near(b, cam)); for (const t of todo) { if ((STEP.on ? n >= Math.max(1, ms) : performance.now() - t0 > ms) && near(t, cam) > within) break; buildTile(t); n++; } }
    if (D) for (const t of all) if (t.built) { const v = near(t, cam) < D; for (const m of t.meshes) m.visible = v; }
    return !all.some((t) => !t.built && near(t, cam) < within);
  };
  group.userData.tiles = all;
  if (railGeos.length) group.add(new THREE.Mesh(mergeAll(railGeos), steel));
  return group;
}

// a city's road chunks (ribbons and bridges) are drawn this far on the lighter settings; High and Ultra draw them all
const ROAD_D = { low: 4000, medium: 6000, high: 9000, ultra: 12000 }; // (road tiles drawn out to: past it the ground photo shows the roads)
// the ways off the street network (rd.minor) and the plazas: metres they lie over the ground (under a street's tarmac,
// junctions.js TARMAC_LIFT, where the two meet); a plaza's mesh cells (metres)
const MINOR_LIFT = 0.02, PLAZA_CELL = 4;
// The plazas (net.areas) by PCELL-metre square: at(x, z) -> the plaza (x, z) is in, or null (World.groundAt: paved,
// drivable ground)
const PCELL = 64;
export function plazaIndex(areas) {
  const cells = new Map();
  for (const A of areas) { const [x0, z0, x1, z1] = A.bb; for (let j = Math.floor(z0 / PCELL); j <= Math.floor(z1 / PCELL); j++) for (let i = Math.floor(x0 / PCELL); i <= Math.floor(x1 / PCELL); i++) { const k = i + ',' + j; let L = cells.get(k); if (!L) cells.set(k, (L = [])); L.push(A); } }
  return (x, z) => { const L = cells.get(Math.floor(x / PCELL) + ',' + Math.floor(z / PCELL)); if (L) for (const A of L) { const b = A.bb; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inPoly(A.ring, x, z)) return A; } return null; };
}
function mergeAll(geos) {
  const ni = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of ni) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const g of ni) { g.computeVertexNormals(); pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// Lane paths for traffic: closed roads -> two loops; open roads -> out on one lane, back on the other.
export function lanePaths(net) {
  const paths = [];
  const offset = (pts, off, closed) => pts.map((p, i) => {
    const n = pts.length, a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
    return new THREE.Vector3(p.x - d.z * off, p.y, p.z + d.x * off);
  });
  for (const rd of net.roads) {
    if (rd.minor) continue; // (no traffic off the street network)
    const lane = rd.width * 0.25, speed = rd.kind === 'highway' ? 27 : rd.kind === 'main' ? 20 : 11;
    if (rd.closed) {
      paths.push({ pts: offset(rd.pts, lane, true), speed, kind: rd.kind, bridge: rd.bridge });
      const rev = rd.pts.slice().reverse(); paths.push({ pts: offset(rev, lane, true), speed, kind: rd.kind, bridge: rd.bridge.slice().reverse() });
    } else {
      const fwd = offset(rd.pts, lane, false), back = offset(rd.pts.slice().reverse(), lane, false);
      paths.push({ pts: [...fwd, ...back], speed, kind: rd.kind, bridge: [...rd.bridge, ...rd.bridge.slice().reverse()] });
    }
  }
  for (const p of paths) {
    p.len = []; let L = 0; p.pts.forEach((q, i) => { if (i) L += q.distanceTo(p.pts[i - 1]); p.len.push(L); }); p.total = L + p.pts.at(-1).distanceTo(p.pts[0]);
  }
  return paths;
}

// Divided roads (#228): OSM maps each carriageway of a dual carriageway as its own (one-way) way, but the bake
// doesn't keep 'oneway'. A road whose points mostly have another road running alongside it, parallel, 6-22 m from
// centre line to centre line, is one carriageway of a pair: rd.median = +1 / -1, the side (+x: its right vector,
// roads.js frame) the other carriageway is on. roadSurface.js paints it as one-way (no centre line; US: yellow on
// the median side).
export function findMedians(roads) {
  const C = 25, cells = new Map(), key = (x, z) => Math.floor(x / C) + ',' + Math.floor(z / C);
  roads.forEach((rd, ri) => { const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { const k = key((P[i].x + P[i + 1].x) / 2, (P[i].z + P[i + 1].z) / 2); let a = cells.get(k); if (!a) cells.set(k, (a = [])); a.push([ri, i]); } });
  const cand = new Map(), pair = [];
  roads.forEach((rd, ri) => {
    const P = rd.pts, n = P.length; if (rd.kind === 'street' && !rd.real || rd.minor || n < 6 || rd.width > 13) return;
    let hits = 0, side = 0, tried = 0;
    for (let i = 1; i + 1 < n; i += 2) {
      const p = P[i], dx = P[i + 1].x - P[i - 1].x, dz = P[i + 1].z - P[i - 1].z, L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
      tried++; let best = null;
      const ci = Math.floor(p.x / C), cj = Math.floor(p.z / C);
      for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const [qj, j] of cells.get(a + ',' + b) || []) {
        if (qj === ri) continue;
        const A = roads[qj].pts[j], B = roads[qj].pts[j + 1], ex = B.x - A.x, ez = B.z - A.z, EL = Math.hypot(ex, ez) || 1;
        if (Math.abs((ux * ex + uz * ez) / EL) < 0.94) continue; // parallel (either way round)
        const t = Math.max(0, Math.min(1, ((p.x - A.x) * ex + (p.z - A.z) * ez) / (EL * EL))), qx = A.x + ex * t - p.x, qz = A.z + ez * t - p.z, d = Math.hypot(qx, qz);
        const q = roads[qj], gap = d - (rd.width + q.width) / 2; // the median between the two carriageways' edges
        if (gap < 0.5 || gap > 14 || q.kind !== rd.kind || Math.abs(q.width - rd.width) > 2 || Math.abs(A.y - p.y) > 3) continue;
        if (!best || d < best.d) best = { d, s: Math.sign(-uz * qx + ux * qz), qj };
      }
      if (best) { hits++; side += best.s; (pair[ri] ??= new Map()).set(best.qj, (pair[ri].get(best.qj) || 0) + 1); }
    }
    if (tried >= 4 && hits / tried > 0.6) cand.set(ri, side >= 0 ? 1 : -1);
  });
  // mutual: the road it runs beside most is a candidate too, and runs beside it
  for (const [ri, sd] of cand) {
    const m = [...pair[ri].entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (m != null && cand.has(m) && pair[m]?.has(ri)) roads[ri].median = sd;
  }
}

// The airport's landside road out to the network (#227 / #228): the airport owns its road from the terminal to the
// gate (airportKit.js airportGate: the box edge, at the runway's height, heading +x, the ground levelled to rwyH for
// 70 m past it). From the gate this road runs straight out for 60 m, then (grade-limited, routed round high and wet
// ground: route()) to the nearest point of the given roads. Returns the road ({ pts, kind, width, gate: { h, x }, to })
// or null (no gate: Bora Bora's airport is on its own motu). Its profile: level at the gate's height across the
// levelled strip, meeting `to` at the far end (callers pin both).
export function gateRoad(w, roads, { G = null, terr, wetAt, blocked } = {}) {
  const gate = airportGate(w.loc); if (!gate) return null;
  const a = new THREE.Vector3(gate.x, 0, gate.z), b = new THREE.Vector3(gate.x + 60, 0, gate.z);
  let to = null, bd = Infinity;
  for (const rd of roads) { if (rd.kind === 'rail' || rd.minor || rd.kind === 'street' && !rd.real) continue; rd.pts.forEach((p, i) => { if (rd.bridge?.[i] || p.x < gate.x + 30) return; const d = Math.hypot(p.x - b.x, p.z - b.z); if (d < bd) { bd = d; to = p; } }); }
  if (!to) return null;
  let mid = [];
  if (bd > 300) {
    const grid = G || planGrid(w, terr, wetAt, blocked || ((x, z) => Math.abs(x - 100) < 470 && Math.abs(z) < RWY_HALF + 350 || Math.abs(x) > w.half - 400 || Math.abs(z) > w.half - 400));
    const leg = route(grid, b.x, b.z, to.x, to.z, { gmax: GRADE.main, water: 10, margin: 1500 });
    if (leg) mid = smoothPath(leg).slice(1, -1);
  }
  const end = to.clone().setY(0); // (resample measures in 3D: the routed points are at y 0, the road's point at its height)
  let Q = relaxCurves(resample(unloop(resample([a, b, ...mid, end], 8), 14, 40), 8), 20, false, 200); // (unloop: a route that doubles back near its end)
  while (Q.length > 4 && Q.at(-2).distanceTo(end) < 16) Q.pop(); // meet the road square on, no hook at the end
  Q[Q.length - 1] = end.clone(); Q[0] = a.clone();
  return { pts: resample(Q, 8), kind: 'main', width: 8, gate: { h: gate.h, x: gate.x + 65, z: gate.z }, to };
}
// the gate road's pins: level at the gate's height across the levelled strip, the far end on the road it joins
export const gatePins = (rd) => { const out = []; for (let i = 0; i < rd.pts.length && rd.pts[i].x < rd.gate.x && Math.abs(rd.pts[i].z - rd.gate.z) < 26; i++) out.push({ i, y: rd.gate.h }); return [...out, { i: rd.pts.length - 1, y: rd.to.y }]; }; // (the strip: from the gate while it stays in it)

// Junctions along every road (#228), for the markings (roadSurface.js): where another road ends on its line (a T: this
// is the through road, the mouth on one side), where its own end lies on another road's line (a T: this road gives
// way there), and where two cross (an X: the minor one, later in rank, gives way). Returns per road a sorted list
// { s (metres along), r (clearance: the other road's half width + 1 m), stop (gives way here), walk (a crossing),
// side (+1 / -1: the mouth is on its +x / -x side; 0: both) }. Bridge decks don't make junctions (an overpass);
// two ways meeting end to end are one road carrying on, not a junction. city: every approach stops (traffic
// lights) and has a crossing.
export function findJunctions(roads, region, city) {
  const C = 25, cells = new Map(), rank = (k) => roads[k].rank ?? k;
  const isDeck = (rd, i) => !!(rd.bridge?.[i] && rd.bridge?.[i + 1]);
  roads.forEach((rd, ri) => { const P = rd.pts; for (let i = 0; i + 1 < P.length; i++) { if (isDeck(rd, i)) continue; const i0 = Math.floor(Math.min(P[i].x, P[i + 1].x) / C), i1 = Math.floor(Math.max(P[i].x, P[i + 1].x) / C), j0 = Math.floor(Math.min(P[i].z, P[i + 1].z) / C), j1 = Math.floor(Math.max(P[i].z, P[i + 1].z) / C); for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const k = a + ',' + b; let A = cells.get(k); if (!A) cells.set(k, (A = [])); A.push([ri, i]); } } });
  const S = roads.map((rd) => { const P = rd.pts, o = new Float64Array(P.length); for (let i = 1; i < P.length; i++) o[i] = o[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return o; });
  const out = roads.map(() => []);
  const town = (rd) => rd.kind === 'street' && !rd.lane;
  const walkAt = (a, b, s) => city ? a.width >= 6 : region !== 'us' && town(a) && town(b) && ((s * 0.37 + a.width * 13.1) % 1) < 0.6;
  const add = (ri, j) => { const L = out[ri], m = L.find((q) => Math.abs(q.s - j.s) < 3); if (m) { m.r = Math.max(m.r, j.r); m.stop ||= j.stop; m.walk ||= j.walk; if (m.side !== j.side) m.side = 0; } else L.push(j); };
  // the nearest point on road qi's line to p, within d: { s (along qi), i, side (which side of qi p is on) }
  const onLine = (qi, p, d) => { let best = null; const ci = Math.floor(p.x / C), cj = Math.floor(p.z / C);
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const [rj, i] of cells.get(a + ',' + b) || []) {
      if (rj !== qi) continue; const P = roads[qi].pts, A = P[i], B = P[i + 1], ex = B.x - A.x, ez = B.z - A.z, L2 = ex * ex + ez * ez || 1, t = clamp(((p.x - A.x) * ex + (p.z - A.z) * ez) / L2, 0, 1);
      const qx = p.x - (A.x + ex * t), qz = p.z - (A.z + ez * t), dd = Math.hypot(qx, qz); if (dd < d && (!best || dd < best.d)) best = { d: dd, s: S[qi][i] + t * Math.sqrt(L2), side: Math.sign(-ez * qx + ex * qz) || 1 };
    } return best; };
  roads.forEach((rd, ri) => {
    const P = rd.pts, n = P.length; if (rd.kind === 'rail' || n < 2) return;
    // its ends on other roads' lines
    if (!rd.closed) for (const [e, nb, se] of [[P[0], P[1], 0], [P[n - 1], P[n - 2], S[ri][n - 1]]]) {
      if (isDeck(rd, se ? n - 2 : 0)) continue;
      const seen = new Set(), ci = Math.floor(e.x / C), cj = Math.floor(e.z / C);
      for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const [qi] of cells.get(a + ',' + b) || []) {
        if (qi === ri || seen.has(qi)) continue; seen.add(qi);
        const q = roads[qi], hit = onLine(qi, e, q.width / 2 + 1.5); if (!hit) continue;
        const atEnd = hit.s < 2 || hit.s > S[qi].at(-1) - 2;
        if (atEnd) { // end to end: a junction only where three or more meet (else one road carrying on)
          let k = 0; for (const [qq] of cells.get(ci + ',' + cj) || []) if (qq !== ri && qq !== qi && onLine(qq, e, roads[qq].width / 2 + 1.5)) { k++; break; }
          if (!k) continue;
        }
        const side = onLine(qi, nb, 1e9)?.side ?? 0; // which side of q this road leaves on
        const walk = walkAt(rd, q, hit.s);
        if (!atEnd) add(qi, { s: hit.s, r: rd.width / 2 + 1, stop: city, walk, side });
        add(ri, { s: se, r: q.width / 2 + 1, stop: true, walk, side: 0 });
      }
    }
    // crossings with the roads after it
    for (let i = 0; i + 1 < n; i++) {
      if (isDeck(rd, i)) continue;
      const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, seen = new Set(), ci = Math.floor((a.x + b.x) / 2 / C), cj = Math.floor((a.z + b.z) / 2 / C);
      for (let u = ci - 1; u <= ci + 1; u++) for (let v = cj - 1; v <= cj + 1; v++) for (const [qi, j] of cells.get(u + ',' + v) || []) {
        if (qi <= ri || seen.has(qi + ':' + j)) continue; seen.add(qi + ':' + j);
        const q = roads[qi], r = q.pts[j], t2 = q.pts[j + 1], ex = t2.x - r.x, ez = t2.z - r.z, den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) continue;
        const t = ((r.x - a.x) * ez - (r.z - a.z) * ex) / den, w = ((r.x - a.x) * dz - (r.z - a.z) * dx) / den;
        if (t < 0 || t > 1 || w < 0 || w > 1) continue;
        const sA = S[ri][i] + t * Math.hypot(dx, dz), sB = S[qi][j] + w * Math.hypot(ex, ez);
        if (sA < 2 || sA > S[ri].at(-1) - 2 || sB < 2 || sB > S[qi].at(-1) - 2) continue; // (ends: done above)
        const minorA = rank(ri) > rank(qi), walk = walkAt(rd, q, sA);
        add(ri, { s: sA, r: q.width / 2 + 1, stop: city || minorA, walk, side: 0 });
        add(qi, { s: sB, r: rd.width / 2 + 1, stop: city || !minorA, walk, side: 0 });
      }
    }
  });
  for (const L of out) L.sort((p, q) => p.s - q.s);
  return out;
}
// A road's points for its meshes with a vertex either side of every junction (so the distances to the junctions,
// rjunc, interpolate exactly), and per point rjunc = (metres since the previous junction, metres to the next, the
// previous one's code, the next one's): code = round(r * 16) * 32 + stop + 2 walk + 4 (mouth on +x) + 8 (mouth on -x)
// + 16 (a junction box, junctions.js: the ribbon stops at r + 0.6, the box's mouth). r is the arm's own on either side
// (j.rA: the arm after the junction, along the road; j.rB: before). Distances in plan (x, z), as J's s.
export const RJ_Q = 16; // (the clearance's steps a metre in rjunc's code; roadSurface.js decodes it)
export function junctionPoints(rd, J) {
  const P = rd.pts, n = P.length, S = along(P);
  const code = (j, r) => Math.round((r ?? j.r) * RJ_Q) * 32 + (j.stop ? 1 : 0) + (j.walk ? 2 : 0) + (j.side >= 0 ? 4 : 0) + (j.side <= 0 ? 8 : 0) + (j.box ? 16 : 0);
  const pts = [], ss = [], br = [], tb = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) while (k < J.length && J[k].s < S[i] - 0.02) { const j = J[k++]; if (j.s <= S[i - 1] + 0.02) continue; const t = (j.s - S[i - 1]) / (S[i] - S[i - 1]); for (const e of [-0.01, 0.01]) { const tt = t + e / (S[i - 1] - S[i - 1] + (S[i] - S[i - 1])); pts.push(P[i - 1].clone().lerp(P[i], tt)); ss.push(j.s + e); br.push(!!(rd.bridge?.[i - 1] && rd.bridge?.[i])); tb.push(!!(rd.tube?.[i - 1] && rd.tube?.[i])); } }
    // a junction right at a point (the topology's: every one): the point split in two either side of it, so the
    // segment before it closes on it and the one after leaves it (one point there was the previous junction's distance
    // on one side and 1e4 on the other: interpolated, the crossing and cut-outs landed metres off)
    if (i > 0 && i < n - 1 && !rd.closed && J.some((j) => Math.abs(j.s - S[i]) < 0.02)) {
      for (const [e, a, b] of [[-0.01, i - 1, i], [0.01, i, i + 1]]) { const L = S[b] - S[a]; pts.push(P[a].clone().lerp(P[b], L > 0.02 ? (S[i] + e - S[a]) / L : 0.5)); ss.push(S[i] + e); br.push(!!rd.bridge?.[i]); tb.push(!!rd.tube?.[i]); }
      continue;
    }
    pts.push(P[i]); ss.push(S[i]); br.push(!!rd.bridge?.[i]); tb.push(!!rd.tube?.[i]);
  }
  const rj = [], last = ss.length - 1;
  for (let q = 0; q <= last; q++) {
    const s = ss[q] - (q === last && !rd.closed ? 1e-6 : 0); // (the last point: a junction there is the one ahead)
    let a = -1; while (a + 1 < J.length && J[a + 1].s <= s) a++;
    const prev = J[a], next = J[a + 1];
    rj.push(prev ? Math.max(0, s - prev.s) : 1e4, next ? Math.max(0, next.s - s) : 1e4, prev ? code(prev, prev.rA) : 0, next ? code(next, next.rB) : 0);
  }
  return { pts, bridge: br, tube: tb, rjunc: rj, closed: rd.closed };
}

// Junctions from the real topology (roads.bin: rd.jn, the node at each junction point): a node where three or more
// road ends meet (a way passing through counts twice) is a junction on every road through it. Same output as
// findJunctions: per road a sorted list { s, r (clearance: the widest other road's half width + 1 m), stop (gives
// way: not the major road there, by class then width; a city: every approach), walk (a crossing), side (the mouth's
// side on a road passing through: +1 / -1, 0 both / none) }. Where the junction has a box (junctions.js, shapes:
// net.junctions) also rA / rB (each arm's clearance: its mouth - 0.6 m, where the crossing starts) and box.
export function junctionsFromNodes(roads, region, city, shapes = []) {
  const boxes = new Map(shapes.map((B) => [B.nd, B]));
  const at = new Map(), S = roads.map((rd) => { const P = rd.pts, o = new Float64Array(P.length); for (let i = 1; i < P.length; i++) o[i] = o[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return o; });
  roads.forEach((rd, k) => { if (rd.minor) return; for (const [j, nd] of rd.jn || []) { let L = at.get(nd); if (!L) at.set(nd, (L = [])); L.push({ k, j, end: j === 0 || j === rd.pts.length - 1 }); } }); // (rd.minor: joins a street as a driveway does, no junction: junctions.js)
  const out = roads.map(() => []), town = (rd) => rd.kind === 'street' && !rd.lane;
  const score = (rd) => (rd.cls ?? 2) * 100 - rd.width;
  for (const [nd, L] of at) {
    const legs = L.reduce((a, q) => a + (q.end ? 1 : 2), 0); if (legs < 3) continue;
    const best = Math.min(...L.map((q) => score(roads[q.k])));
    for (const q of L) {
      const rd = roads[q.k], others = L.filter((o) => o.k !== q.k); if (!others.length) continue;
      const r = Math.max(...others.map((o) => roads[o.k].width / 2)) + 1;
      let side = 0;
      if (!q.end) { // a road passing through: which side the others leave on
        const P = rd.pts, a = P[Math.max(0, q.j - 1)], b = P[Math.min(P.length - 1, q.j + 1)], dx = b.x - a.x, dz = b.z - a.z; let sp = 0, sn = 0;
        for (const o of others) { const Q = roads[o.k].pts, nb = Q[o.j === 0 ? 1 : o.j === Q.length - 1 ? Q.length - 2 : o.j], c = -dz * (nb.x - P[q.j].x) + dx * (nb.z - P[q.j].z); if (!o.end) { sp = sn = 1; break; } if (c > 0) sp = 1; else sn = 1; }
        side = sp && sn ? 0 : sp ? 1 : sn ? -1 : 0;
      }
      const walk = city ? rd.width >= 6 : region !== 'us' && town(rd) && others.some((o) => town(roads[o.k])) && ((S[q.k][q.j] * 0.37 + rd.width * 13.1) % 1) < 0.6;
      const B = boxes.get(nd), rA = B?.r.get(q.k + ':' + q.j + ':1'), rB = B?.r.get(q.k + ':' + q.j + ':-1');
      out[q.k].push({ s: S[q.k][q.j], r: B ? Math.max(rA ?? 0, rB ?? 0) : r, stop: city || score(rd) > best + 0.01, walk, side, ...(B ? { rA, rB, box: true } : {}) });
    }
  }
  // a way off the street network where it meets a street (rd.minor: no junction, junctions.js): its ribbon stops at the
  // street's edge (a box's flag: the street's tarmac, its junction box, its pavement are drawn over the mouth, not it too)
  const carHW = new Map(); for (const [nd, L] of at) carHW.set(nd, Math.max(...L.map((q) => roads[q.k].width / 2)));
  roads.forEach((rd, k) => { if (!rd.minor) return; for (const [j, nd] of rd.jn || []) { const hw = carHW.get(nd); if (hw == null) continue; const r = hw + (boxes.has(nd) ? 3 : 1); out[k].push({ s: S[k][j], r, stop: false, walk: false, side: 0, rA: r, rB: r, box: true }); } });
  for (const L of out) { L.sort((p, q) => p.s - q.s); for (let i = L.length - 1; i > 0; i--) if (L[i].s - L[i - 1].s < 3) { const a = L[i - 1], b = L[i]; a.r = Math.max(a.r, b.r); a.stop ||= b.stop; a.walk ||= b.walk; if (a.side !== b.side) a.side = 0; L.splice(i, 1); } }
  return out;
}
