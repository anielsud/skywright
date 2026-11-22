// Road / rail network, town sites and farm fields. Planned before the terrain mesh is built,
// so roads and towns can be flattened into the heightfield and painted into the baked albedo.
import * as THREE from 'three';
import { mulberry32, smoothstep, lerp, clamp } from './noise.js';
import { glowTexture as glow } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { GRADE, VERGE, gridSampler, planGrid, regrid, markRoad, trimShared, unloop, crossings, route, highestReachable, smoothPath, simplifyPath, relaxCurves, profileRoad, carveGrid, RoadSurface } from './roadgrade.js';

const RWY_HALF = 900;

export function planNetwork(w) {
  const tStart = performance.now();
  const r = mulberry32(w.loc.seed * 13 + 1);
  const H = (x, z) => w.sampleGrid(x, z);
  const isl = w.loc.id === 'islands', desert = !!w.loc.desert, wl = w.waterLevel;
  // routing and profiles read the raw fine heights (w.Hh0), with the towns flattened in once they are placed
  const raw = gridSampler(w, w.Hh0, w.hR0), towns = [];
  const terr = (x, z) => {
    let h = raw(x, z);
    for (const t of towns) { const k = 1 - smoothstep(420 * t.size * 0.6, 420 * t.size * 1.4, Math.hypot(x - t.c.x, z - t.c.z)); if (k > 0) h = lerp(h, t.h, k); }
    return h;
  };
  const LA = [0, 0, 0, 0], wetLand = !!(w.bake && !w.bake.dry);
  const wetAt = (x, z, h) => h < wl + 0.6 || (wetLand && w.landAt(x, z, LA)[0] > 0.55);
  const apt = (x, z) => Math.abs(x - 100) < 470 && Math.abs(z) < RWY_HALF + 350;
  const G = planGrid(w, terr, wetAt, (x, z) => apt(x, z) || Math.abs(x) > w.half - 400 || Math.abs(z) > w.half - 400);
  const go = (a, b, o) => route(G, a.x, a.z, b.x, b.z, o);
  const roads = [];
  // 1) ring road around the airport: eight waypoints on an ellipse (pulled in or out off high or wet ground),
  // joined by grade-limited routes
  {
    const rx = isl ? 650 : 900, rz = isl ? 1250 : 2300, wps = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2; let best = null, bs = 1e9;
      for (let f = 1.15; f >= 0.6; f -= 0.05) {
        const x = Math.cos(a) * rx * f + 140, z = Math.sin(a) * rz * f; if (apt(x, z)) break;
        const h = terr(x, z), sc = Math.max(0, h - w.loc.rwyH - 15) + (wetAt(x, z, h) ? 500 : 0) + Math.abs(f - 1) * 40;
        if (sc < bs) { bs = sc; best = new THREE.Vector3(x, 0, z); }
      }
      wps.push(best);
    }
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const leg = go(wps[k], wps[(k + 1) % 8], { gmax: GRADE.main, water: 10, margin: 1200 });
      pts.push(...(leg ? simplifyPath(leg, 14) : [wps[k], wps[(k + 1) % 8]]).slice(0, -1));
    }
    const R20 = resample(pts, 20, true); // legs that run out and back up a side valley to a waypoint: cut the spur
    roads.push({ pts: resample(relaxCurves(resample(smoothPath(simplifyPath(unloop(R20, 70, Math.floor(R20.length * 0.35)), 10), { closed: true }), 8, true), 30, true), 8, true), closed: true, kind: 'main', width: 9 });
  }
  const ring = roads[0].pts;
  markRoad(G, ring);
  // roads join the network where they meet it: the stretch routed along an existing road is dropped, the end snaps
  // to the road point it meets (and its profile is pinned to that point's height)
  const snap = (p) => { let best = null, bd = 1e18; for (const q of roads) if (q.kind !== 'street') for (const s of q.pts) { const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2; if (d < bd) { bd = d; best = s; } } return best; };
  // (and it starts where it is clear of the road it leaves: no stretch of two roads side by side, overlapping)
  const near = (p, d) => roads.some((q) => q.kind !== 'street' && q.pts.some((s) => (s.x - p.x) ** 2 + (s.z - p.z) ** 2 < d * d));
  const branch = (leg, o) => {
    const T = trimShared(G, leg, false); let P = resample(relaxCurves(unloop(resample(smoothPath(T, o), 8), 14, 25), o.rmin ?? 18, false, 200), 8), k = 0;
    while (k < P.length - 4 && near(P[k], 17)) k++;
    const from = snap(P[k]);
    return { pts: resample([from.clone(), ...P.slice(k)], 8), from };
  };
  // 2) town sites: flat, dry, away from the runway
  const nTowns = isl ? 2 : 3;
  for (let tries = 0; tries < 900 && towns.length < nTowns; tries++) {
    const a = r() * Math.PI * 2, d = (isl ? 700 : 1200) + r() * (isl ? 1000 : 2200);
    const x = 140 + Math.cos(a) * d * (isl ? 0.9 : 0.7), z = Math.sin(a) * d * (isl ? 1.6 : 1.2);
    if (Math.abs(x - 140) < 520 && Math.abs(z) < RWY_HALF + 500) continue;
    const h = H(x, z);
    if (h < w.waterLevel + 3 || h > w.loc.rwyH + (desert ? 140 : 160)) continue;
    let mn = 1e9, mx = -1e9; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const hh = H(x + i * 90, z + j * 90); mn = Math.min(mn, hh); mx = Math.max(mx, hh); }
    if (mx - mn > (isl ? 26 : 32) || mn < w.waterLevel + 1.5) continue;
    if (towns.some((t) => Math.hypot(t.c.x - x, t.c.z - z) < 1500)) continue;
    // nearest ring point -> street axis points from the town to the ring road
    let best = 0, bd = 1e12; ring.forEach((p, i) => { const dd = (p.x - x) ** 2 + (p.z - z) ** 2; if (dd < bd) { bd = dd; best = i; } });
    const tgt = ring[best];
    const dir = new THREE.Vector3(tgt.x - x, 0, tgt.z - z).normalize();
    towns.push({ c: new THREE.Vector3(x, (mn + mx) / 2, z), dir, size: towns.length === 0 ? 1 : 0.7, ringIdx: best, h: (mn + mx) / 2 });
  }
  // the towns are flattened, so is the cost grid there; and (as World.dryLand does) no rivers in them
  for (const t of towns) { const R = 420 * t.size * 1.4; regrid(G, terr, t.c.x - R, t.c.z - R, t.c.x + R, t.c.z + R); }
  if (wetLand && towns.length) {
    w.net = { towns, roads: [] }; w.dryLand();
    for (let k = 0; k < G.h.length; k++) if (G.wet[k]) G.wet[k] = wetAt(G.x0 + (k % G.n) * G.cell, G.x0 + Math.floor(k / G.n) * G.cell, G.h[k]) ? 1 : 0;
  }
  // 3) connectors (from the end of the main street to the ring, routed) + streets
  const connectors = [];
  for (const t of towns) {
    const tgt = ring[t.ringIdx], L = 520 * t.size, e = t.c.clone().addScaledVector(t.dir, L * 0.4);
    const leg = go(e, tgt, { gmax: GRADE.main, water: 10, margin: 1500 });
    const P = leg ? trimShared(G, leg, true) : [e, tgt.clone()], to = snap(P.at(-1));
    let Q = relaxCurves(resample([t.c.clone(), ...(leg ? smoothPath(P) : P)], 8), 20, false, 200);
    while (Q.length > 4 && Q.at(-2).distanceTo(to) < 16) Q.pop(); // meet the road square on, no hook at the end
    Q[Q.length - 1] = to.clone();
    const rd = { pts: resample(Q, 8), kind: 'main', width: 8, town: t, to };
    roads.push(rd); connectors.push(rd); markRoad(G, rd.pts);
    const side = new THREE.Vector3(-t.dir.z, 0, t.dir.x);
    roads.push({ pts: resample([t.c.clone().addScaledVector(t.dir, -L * 0.6), t.c.clone().addScaledVector(t.dir, L * 0.4)], 8), kind: 'street', width: 7, mainOf: t });
    const nCross = t.size > 0.9 ? 4 : 3;
    t.streets = [];
    for (let k = 0; k < nCross; k++) {
      const o = t.c.clone().addScaledVector(t.dir, -L * 0.5 + (k + 0.5) * (L * 0.9 / nCross));
      const cl = 200 * t.size + r() * 80;
      roads.push({ pts: resample([o.clone().addScaledVector(side, -cl), o.clone().addScaledVector(side, cl)], 8), kind: 'street', width: 6.5 });
    }
  }
  // 3b) old-town lanes: a few narrow winding streets out from the centre between the grid streets (own RNG, so the
  // rest of the plan is unchanged)
  {
    const rl = mulberry32(w.loc.seed * 17 + 5);
    for (const t of towns) {
      const nL = t.size > 0.9 ? 3 : 2, base = Math.atan2(t.dir.z, t.dir.x);
      for (let k = 0; k < nL; k++) {
        let a = base + Math.PI / 4 + (k / nL) * Math.PI * 2 + (rl() - 0.5) * 0.5, p = t.c.clone().addScaledVector(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 30);
        const pts = [p.clone()], L = (150 + rl() * 110) * t.size;
        for (let d = 0; d < L; d += 8) {
          a += (rl() - 0.5) * 0.22 + Math.sin(d / 37 + k) * 0.05;
          p = p.clone().add(new THREE.Vector3(Math.cos(a) * 8, 0, Math.sin(a) * 8));
          if (H(p.x, p.z) < w.waterLevel + 2) break;
          pts.push(p);
        }
        if (pts.length > 8) roads.push({ pts: resample(pts, 8), kind: 'street', width: 5.5, lane: true });
      }
    }
  }
  // 4) highways: out along the valleys under the ruling grade (bridges over water; a causeway on the islands)
  const fromRing = (tgt) => ring.reduce((b, p) => ((p.x - tgt.x) ** 2 + (p.z - tgt.z) ** 2 < (b.x - tgt.x) ** 2 + (b.z - tgt.z) ** 2 ? p : b), ring[0]);
  const targets = [];
  if (isl) targets.push(new THREE.Vector3(5200 - 900, 0, -3800 + 700));
  else {
    // the lowest dry ground ~9 km out (the valley floors), spread round the compass
    const cand = [];
    for (let k = 0; k < 90; k++) {
      const a = (k / 90) * Math.PI * 2, x = 140 + Math.cos(a) * 9000, z = Math.sin(a) * 9000;
      if (Math.abs(x) > w.half - 700 || Math.abs(z) > w.half - 700) continue;
      const h = terr(x, z); cand.push({ a, p: new THREE.Vector3(x, 0, z), s: h + (wetAt(x, z, h) ? 80 : 0) });
    }
    cand.sort((p, q) => p.s - q.s);
    for (const c of cand) {
      if (targets.length >= (desert ? 3 : 2)) break;
      if (targets.some((t) => Math.abs(Math.atan2(Math.sin(t.a - c.a), Math.cos(t.a - c.a))) < 1.75)) continue;
      targets.push(Object.assign(c.p, { a: c.a }));
    }
  }
  const highways = [];
  for (const tgt of targets) {
    const leg = go(fromRing(tgt), tgt, { gmax: GRADE.highway, water: isl ? 4 : 7, margin: 2500, alt: 0.4, h0: w.loc.rwyH, turn: 0.6 });
    if (!leg) continue;
    const rd = Object.assign(branch(leg, { tol: 18, maxL: 60, rmin: 40 }), { kind: 'highway', width: 10 });
    highways.push(rd); roads.push(rd); markRoad(G, rd.pts);
  }
  // 4b) mountain roads: from the ring (or the end of the causeway) up to the highest ground a minor road can reach
  // within its grade (a hamlet, a viewpoint, the volcano's flank). Nothing forces a shape: the switchbacks are what
  // the grade leaves. (The alpine walls are mostly steeper than 1:1, so these stay a few hundred metres up.)
  const climbs = [], cg = GRADE.lane;
  const starts = isl ? (highways[0] ? [highways[0].pts.at(-1)] : []) : [ring.reduce((b, p) => (p.x > b.x ? p : b)), ring.reduce((b, p) => (p.x < b.x ? p : b))];
  for (const a of starts) {
    const tgt = highestReachable(G, a.x, a.z, cg * 0.9, isl ? 3000 : 3500, 500);
    if (tgt && tgt.y - terr(a.x, a.z) > 60 && !climbs.some((c) => c.tgt.distanceTo(tgt) < 1200)) climbs.push({ tgt, from: a });
  }
  for (const m of climbs) {
    const leg = go(m.from, m.tgt, { gmax: cg, water: 10, margin: 1500, turn: 0.4 });
    if (!leg) continue;
    const rd = Object.assign(branch(leg, { tol: 10, maxL: 45, rmin: 15 }), { kind: 'main', width: 6.5, g: cg, mountain: true });
    roads.push(rd); markRoad(G, rd.pts);
  }
  // vertical profiles: the ring first, then the streets, then the roads that join them (pinned to them), each also
  // pinned to meet the roads it crosses at grade
  const done = [];
  const cross = (rd) => done.flatMap((q) => crossings(rd.pts, q.pts, q.closed)).filter((c) => c.i > 2 && c.i < rd.pts.length - 3);
  const prof = (rd, pins = []) => { profileRoad(rd, { g: rd.g ?? (rd.lane ? GRADE.lane : GRADE[rd.kind]), terr, wetAt, wl, clear: rd.kind === 'highway' ? 9 : rd.kind === 'main' ? 7 : 5, pins: [...pins, ...cross(rd)], smooth: rd.kind === 'street' ? 2 : 3 }); if (rd.kind !== 'street') done.push(rd); };
  const nearest = (P, p) => { let bi = 0, bd = 1e18; P.forEach((q, i) => { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; bi = i; } }); return P[bi]; };
  prof(roads[0]);
  for (const rd of roads) if (rd.kind === 'street') prof(rd);
  for (const rd of connectors) {
    const main = roads.find((q) => q.mainOf === rd.town), pins = [{ i: rd.pts.length - 1, y: rd.to.y }];
    if (main) pins.push({ i: 0, y: nearest(main.pts, rd.pts[0]).y });
    prof(rd, pins);
  }
  for (const rd of roads) if (rd.from) prof(rd, [{ i: 0, y: rd.from.y }]); // in the order they were built
  // 5) railway alongside the first highway (mountains + desert): a broad offset of its line, at a railway's grade
  let rail = null;
  if (!isl && highways[0]) {
    const hw = smoothPath(simplifyPath(highways[0].pts, 60), { maxL: 120, iters: 4 });
    const side = (o) => hw.map((p, i) => { const a = hw[Math.max(0, i - 1)], b = hw[Math.min(hw.length - 1, i + 1)]; const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); return new THREE.Vector3(p.x - d.z * o, 0, p.z + d.x * o); });
    const rough = (P) => P.reduce((s, p, i) => s + (i ? Math.abs(terr(p.x, p.z) - terr(P[i - 1].x, P[i - 1].z)) : 0), 0);
    const [L, R] = [side(40), side(-40)]; // the side with the gentler ground
    rail = { pts: resample(rough(L) <= rough(R) ? L : R, 6), width: 5, kind: 'rail' };
    // level crossings, and level wherever it runs close beside a road (no track a few metres above a carriageway)
    const beside = [];
    for (const q of done) rail.pts.forEach((p, i) => { const s = nearest(q.pts, p); if ((s.x - p.x) ** 2 + (s.z - p.z) ** 2 < ((q.width + 5) / 2 + 4) ** 2) beside.push({ i, y: s.y }); });
    profileRoad(rail, { g: GRADE.rail, terr, wetAt, wl, clear: 8, smooth: 6, pins: [...cross(rail), ...beside] });
  }
  w.planMs = Math.round(performance.now() - tStart);
  // 6) farm fields (or pivot-irrigation circles in the desert)
  const fields = [];
  const roadNear = (x, z, d) => roads.some((rd) => rd.pts.some((p, i) => i % 3 === 0 && (p.x - x) ** 2 + (p.z - z) ** 2 < d * d));
  const palettes = desert ? [[0x6f8f3a, 0x5c7a2e], [0x8a9a48, 0x768a3c], [0xa48a52, 0x93794a]] : isl ? [[0x3d6e2a, 0x2e5c22], [0x6a8d3a, 0x587a30], [0x4b7a34, 0x3c6a2a]]
    : [[0xb8a24e, 0xa48f42], [0x6e9a3c, 0x5c8832], [0x7a5c3e, 0x6a4e34], [0x8fae4a, 0x7c9a40], [0xc9b860, 0xb2a252]];
  const anchors = towns.length ? towns.map((t) => t.c) : [new THREE.Vector3(140, 0, 0)];
  for (let tries = 0; tries < 2500 && fields.length < (isl ? 25 : 70); tries++) {
    const an = anchors[Math.floor(r() * anchors.length)];
    const x = an.x + (r() - 0.5) * 3600, z = an.z + (r() - 0.5) * 3600;
    if (Math.abs(x - 140) < 600 && Math.abs(z) < RWY_HALF + 400) continue;
    const pivot = desert && r() < 0.8;
    const sx = pivot ? 120 + r() * 160 : 70 + r() * 120, sz = pivot ? sx : 90 + r() * 160;
    const h = H(x, z); if (h < w.waterLevel + 2 || h > w.loc.snowline - 300) continue;
    let flat = true; for (const [ox, oz] of [[sx, sz], [-sx, sz], [sx, -sz], [-sx, -sz]]) if (Math.abs(H(x + ox, z + oz) - h) > (pivot ? 8 : 14)) flat = false;
    if (!flat) continue;
    if (fields.some((f) => Math.hypot(f.x - x, f.z - z) < Math.max(f.sx, f.sz) + Math.max(sx, sz) + 10)) continue;
    if (towns.some((t) => Math.hypot(t.c.x - x, t.c.z - z) < 450)) continue;
    if (roadNear(x, z, Math.max(sx, sz) * 0.7)) continue;
    const pal = palettes[Math.floor(r() * palettes.length)];
    fields.push({ x, z, sx, sz, ang: r() * Math.PI, pivot, c1: new THREE.Color(pal[0]), c2: new THREE.Color(pal[1]), stripe: 4 + r() * 6 });
  }
  return { roads, towns, fields, rail };
}

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
  carveGrid(w, allRoads(net), H, N, step, 0.6);
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
  carveGrid(w, allRoads(net), Hh, R, st, 0.75);
}
const allRoads = (net) => [...net.roads, ...(net.rail ? [net.rail] : [])];
// embankment/cutting width beside a road on a heightfield of spacing st (physics and the skirt meshes)
export const skirtWidth = (st) => Math.min(60, st * 0.75 + 10);
// The road surface index World.sampleGrid / groundAt read (built once the fine heights are carved)
export function roadSurface(w, net) { return new RoadSurface(w, allRoads(net), skirtWidth(w.hStep)); }

// Real places: OSM roads get a profile too (smoothed, grade-limited, mapped bridges kept as straight decks), so they
// can be carved in and driven like the planned ones. Reads the raw fine heights (w.Hh0).
export function gradeReal(w, net) {
  const terr = gridSampler(w, w.Hh0, w.hR0), wl = w.waterLevel;
  // ways meet end to end (or end on another way): each one's ends are pinned to the ways already done, longest first
  const hash = new Map(), key = (x, z) => Math.floor(x / 10) + ',' + Math.floor(z / 10);
  const at = (p) => { let best = null, bd = 9; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of hash.get(key(p.x + i * 10, p.z + j * 10)) || []) { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; best = q; } } return best; };
  for (const rd of net.roads) { // (sorted longest first by RealData.network)
    if (rd.baked) { rd.terr = Float32Array.from(rd.pts, (p) => terr(p.x, p.z)); rd.wet = new Uint8Array(rd.pts.length); for (const p of rd.pts) { const k = key(p.x, p.z); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(p); } continue; } // a bridge with a baked deck profile (realworld.js)
    const fixed = rd.bridge && rd.bridge.some(Boolean) ? rd.bridge.slice() : null, pins = [];
    for (const i of [0, rd.pts.length - 1]) { const q = at(rd.pts[i]); if (q) pins.push({ i, y: q.y }); }
    profileRoad(rd, { g: GRADE.real, terr, wetAt: () => false, wl, clear: 0, smooth: 2, bridges: false, fixed, pins });
    for (const p of rd.pts) { const k = key(p.x, p.z); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(p); }
  }
}
// Paint fields / road verges into the baked albedo at texel (x,z). Returns a colour or null.
export function makePainter(w, net) {
  const cell = 300, grid = new Map();
  const add = (key, item) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(item); };
  for (const f of net.fields) {
    const R = Math.max(f.sx, f.sz) * 1.5;
    for (let gx = Math.floor((f.x - R) / cell); gx <= Math.floor((f.x + R) / cell); gx++) for (let gz = Math.floor((f.z - R) / cell); gz <= Math.floor((f.z + R) / cell); gz++) add(gx + ',' + gz, { f });
  }
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) rd.pts.forEach((p, i) => { if (i % 2 === 0 && !rd.bridge?.[i]) add(Math.floor(p.x / cell) + ',' + Math.floor(p.z / cell), { p, w: rd.width, rail: rd === net.rail }); });
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
  const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
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
  // ribbons are merged per material at the end (fewer draw calls); a big road network (loc.roads.chunk, m: a city)
  // also per square of that size, so what's off screen is culled
  const pending = new Map(), chunk = w.loc.roads?.chunk;
  const add = (material, g) => {
    const p = g.attributes.position.array, key = chunk ? material.uuid + Math.floor(p[0] / chunk) + ',' + Math.floor(p[2] / chunk) : material;
    if (!pending.has(key)) pending.set(key, { material, geos: [] });
    pending.get(key).geos.push(g);
  };
  const frame = (P, i, closed) => { // unit direction and right vector at point i
    const n = P.length, a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); return [d, new THREE.Vector3(-d.z, 0, d.x)];
  };
  // a strip across the road at every point: rows of lateral offsets (heights from hf(i, x, z, off)), quads only on
  // the segments seg(i) allows
  const strip = (rd, offs, hf, seg, material, uvf, gap = -1) => { // gap: a column left open (the verges either side of the tarmac)
    const P = rd.pts, n = P.length, closed = !!rd.closed, m = offs.length, pos = [], uv = [], idx = [];
    let dist = 0;
    for (let k = 0; k <= (closed ? n : n - 1); k++) {
      const i = k % n, p = P[i], [, rt] = frame(P, i, closed);
      if (k > 0) dist += P[i].distanceTo(P[(i - 1 + n) % n]);
      for (let c = 0; c < m; c++) { const x = p.x + rt.x * offs[c], z = p.z + rt.z * offs[c]; pos.push(x, hf(i, x, z, offs[c]), z); uv.push(...uvf(c, dist)); }
      if (k > 0 && seg((k - 1) % n)) { const o = (k - 1) * m; for (let c = 0; c < m - 1; c++) if (c !== gap) idx.push(o + c, o + c + 1, o + m + c, o + c + 1, o + m + c + 1, o + m + c); }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    add(material, g);
  };
  const isBr = (rd, i) => !!(rd.bridge?.[i] && rd.bridge?.[(i + 1) % rd.pts.length]);
  // embankment skirts: the ground the physics sees just off the road (World.sampleGrid), drawn with the terrain's own
  // material where the baked grid is too coarse to show it (only there)
  const skirtMat = new THREE.MeshStandardMaterial({ roughness: w.patchMat.roughness, metalness: 0 }); // (not clone(): that JSON-copies userData, the terrain textures)
  Object.assign(skirtMat, { onBeforeCompile: w.patchMat.onBeforeCompile, defines: w.patchMat.defines, userData: w.patchMat.userData, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const SW = skirtWidth(w.hStep), meshH = (x, z) => { const fx = (x + w.half) / w.hStep, fz = (z + w.half) / w.hStep; return fx >= 0 && fz >= 0 && fx < w.hR && fz < w.hR ? w.triAt(w.Hh, w.hR + 1, fx, fz) : w.sampleCoarse(x, z); };
  const skirts = (rd) => {
    const P = rd.pts, n = P.length, hw = rd.width / 2 + VERGE, rows = [0, 1.5, 4, 8, 13, 20, 30, 42, 60].filter((o) => o < SW).concat([SW]);
    const need = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (rd.bridge?.[i]) continue;
      const p = P[i], [, rt] = frame(P, i, rd.closed);
      for (const s of [-1, 1]) for (const o of rows) { const x = p.x + rt.x * (hw + o) * s, z = p.z + rt.z * (hw + o) * s; if (Math.abs(w.sampleGrid(x, z) - meshH(x, z)) > 0.12) { need[i] = 1; break; } }
    }
    const ok = (i) => !isBr(rd, i) && (need[i] || need[(i + 1) % n] || need[(i - 1 + n) % n] || need[(i + 2) % n]);
    for (const s of [-1, 1]) {
      const offs = (s < 0 ? rows.slice().reverse() : rows).map((o) => s * (hw + o));
      strip(rd, offs, (i, x, z, off) => (Math.abs(off) <= hw + 0.01 ? P[i].y : w.sampleGrid(x, z)), ok, skirtMat, (c, d) => [c, d]);
    }
  };
  for (const rd of net.roads) {
    const hw = rd.width / 2;
    strip(rd, [-hw - VERGE, -hw, hw, hw + VERGE], (i) => rd.pts[i].y, (i) => !isBr(rd, i), verge, (c, d) => [c, d / 10], 1);
    strip(rd, [-hw, hw], (i) => rd.pts[i].y + 0.02, () => true, mat(rd.kind), (c, d) => [c, d / 14]);
    skirts(rd);
  }
  const bridgeGeos = [], railGeos = [];
  if (net.rail) {
    const rl = net.rail;
    strip(rl, [-2.3, 2.3], (i) => rl.pts[i].y + 0.05, () => true, mat('rail'), (c, d) => [c, d / 8]);
    strip(rl, [-2.5 - VERGE, -2.3, 2.3, 2.5 + VERGE], (i) => rl.pts[i].y, (i) => !isBr(rl, i), verge, (c, d) => [c, d / 10], 1);
    skirts(rl);
    // the two rails
    for (const s of [-0.72, 0.72]) strip(rl, [s - 0.05, s + 0.05], (i) => rl.pts[i].y + 0.25, () => true, steel, () => [0, 0]);
  }
  // bridges: a deck slab with parapets, piers down to the ground or river bed, and abutments at both ends
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) {
    const P = rd.pts, n = P.length, closed = !!rd.closed; if (!rd.bridge?.some(Boolean)) continue;
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
  }
  // street lamps (glow at night)
  const lamps = [];
  // (town streets get their own lamp posts from towns.js, except on low quality)
  const poles = [];
  for (const rd of net.roads) { if (rd.kind === 'highway' || rd.mountain || (rd.kind === 'street' && w.qName !== 'low')) continue; const every = rd.kind === 'street' ? 4 : 6; rd.pts.forEach((p, i) => { if (i % every) return; const a = rd.pts[Math.max(0, i - 1)], b = rd.pts[Math.min(rd.pts.length - 1, i + 1)], d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); const s = (i / every) % 2 ? 1 : -1; const off = rd.bridge?.[i] ? rd.width / 2 + 0.6 : rd.width / 2 + 1.5, x = p.x - d.z * off * s, z = p.z + d.x * off * s, gy = rd.bridge?.[i] ? p.y + 1 : w.sampleGrid(x, z); lamps.push(x + d.z * 1.2 * s, gy + 7, z - d.x * 1.2 * s); poles.push(x, gy, z, Math.atan2(d.z * s, -d.x * s)); }); }
  // poles: tapered mast + outreach arm + luminaire, one instanced mesh
  if (poles.length) {
    const pg = mergeGeometries([new THREE.CylinderGeometry(0.07, 0.12, 7.4, 6).translate(0, 3.5, 0), new THREE.BoxGeometry(0.08, 0.08, 1.5).translate(0, 7.15, 0.65), new THREE.BoxGeometry(0.28, 0.12, 0.6).translate(0, 7.05, 1.25)].map((g) => g.toNonIndexed()));
    const pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x8a8e94, metalness: 0.6, roughness: 0.45 }), poles.length / 4), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < poles.length / 4; k++) pm.setMatrixAt(k, m4.compose(new THREE.Vector3(poles[k * 4], poles[k * 4 + 1] - 0.2, poles[k * 4 + 2]), q.setFromAxisAngle(up, poles[k * 4 + 3]), one));
    pm.count = poles.length / 4; pm.castShadow = w.qName === 'high' || w.qName === 'ultra'; group.add(pm);
  }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));
  const lampMat = new THREE.PointsMaterial({ size: 3, color: new THREE.Color(3.2, 2.2, 1.1), map: glow(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  group.add(new THREE.Points(lg, lampMat)); group.userData.lampMat = lampMat;
  // a chunked (city) network: chunks are drawn out to ROAD_D (the ground photo shows the roads beyond); world.update
  // calls group.userData.cull. Each material keeps an empty stand-in, so its shader compiles at load even when all its
  // chunks start out of range.
  const chunks = [], warm = new Set(), keep = (m) => { if (!chunk) return; m.geometry.computeBoundingSphere(); const b = m.geometry.boundingSphere; chunks.push({ m, x: b.center.x, z: b.center.z, r: b.radius }); warm.add(m.material); };
  for (const { material, geos } of pending.values()) { const m = new THREE.Mesh(mergeGeometries(geos), material); m.receiveShadow = true; group.add(m); keep(m); }
  // bridges: per chunk square too in a city (NYC's viaducts and bridges are ~500k triangles across the whole map)
  const bridgeCells = new Map();
  for (const g of bridgeGeos) { const p = g.attributes.position.array, k = chunk ? Math.floor(p[0] / chunk) + ',' + Math.floor(p[2] / chunk) : ''; if (!bridgeCells.has(k)) bridgeCells.set(k, []); bridgeCells.get(k).push(g); }
  for (const geos of bridgeCells.values()) { const m = new THREE.Mesh(mergeAll(geos), concrete); m.castShadow = m.receiveShadow = true; group.add(m); keep(m); }
  const D = ROAD_D[w.qName];
  if (chunks.length && D) {
    for (const mt of warm) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(9, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(6, 2)); const m = new THREE.Mesh(g, mt); m.frustumCulled = false; m.receiveShadow = true; group.add(m); }
    group.userData.cull = (cam) => { for (const c of chunks) c.m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) - c.r < D; };
  }
  if (railGeos.length) group.add(new THREE.Mesh(mergeAll(railGeos), steel));
  return group;
}

// a city's road chunks (ribbons and bridges) are drawn this far on the lighter settings; High and Ultra draw them all
const ROAD_D = { low: 5000, medium: 8000 };
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
