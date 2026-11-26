// Building setbacks (Node tier, #228): no building footprint stands on a road. Every real place's buildings as the
// World built them (RealScenery: each building's footprint, e.fp; New York: every city.bin record through
// CityScenery.footprint, tall and low, the low ones whether or not a tile near the camera has built them yet) against
// every road's clear zone: tarmac + gravel verge (roadgrade.js VERGE), or on a city street tarmac + pavement (roads.js
// roadMesh). Left out: tunnels' tubes and bridge decks up in the air. Measured here with its own geometry (sampled,
// not setback.js's), so it checks the rule, not the code against itself.
//   on a road:  how many footprints reach more than TOL into a clear zone (none), and the deepest
//   boxes:      the collision boxes cars meet (World.wallBoxes) are off the roads too
//   kept:       how many buildings the setbacks left out (a few per cent at most: most are cut back, not dropped)
//   cheap:      the setbacks' own work at load (index + cuts: setback.js WORK, counted, not timed), per building
//   few over:   big buildings a road runs right through are left standing only with a passage under them (setback.js
//               MAJOR, PASSAGE; realCity.js builds it, its boxes below the underside are checked with the others); few
//   past walls: no collision box reaches more than 1 m past every footprint near a street (an invisible wall on the
//               open ground: an L's yard, a U's courtyard, a trapezoid's sliver; setback.js footBoxes gives an
//               irregular building a few boxes that hug its walls), every edge of every box sampled each metre
//   cover:      the boxes cover the footprints (95% of their area; at most 1% of buildings under 90%): no gap a car
//               could drive into a building through
//   cheap:      the boxes at load (an irregular building's are worked out when first wanted: how many were, and their
//               work per building), and the most work any one building's took after load (counted, not timed)
//   one bldg:   an irregular building's boxes are one building to destruction.js (towns.hit, heights, damage state)
// Standalone (counts before and after, worst spots): node --import ./tools/test/node/setup.mjs tools/test/setbacks.js [place ...]
import { VERGE } from '../../src/roadgrade.js';
import { FOOT } from '../../src/setback.js';
const FS_MAX = FOOT.max;

export const nodeSuite = { files: ['src/setback.js', 'src/realBuildings.js', 'src/realCity.js', 'src/destruction.js', 'src/world.js', 'tools/test/setbacks.js'] };
const PLACES = ['lauterbrunnen', 'canyon', 'islands', 'nyc'];
const TOL = 0.1, PAVE = { main: 4.5, street: 3.5 }, C = 25, OUT_TOL = 2, OUT_1 = 1, NEAR = 12, OUT_MAX = 0.002, COVER = 0.95; // (OUT_TOL, OUT_1: m a collision box may reach past its walls, out on the open ground within NEAR of a street's pavement; setback.js footBoxes keeps an irregular building's boxes within FOOT.out = 1 m of them. COVER: how much of the footprints the boxes cover)

export function cases() { return PLACES.map((loc) => ({ id: loc, loc, world: loc, cost: loc === 'nyc' ? 40 : 8 })); }

// the clear zones: segments { ax, az, bx, bz, r } in a 25 m hash
function zones(w) {
  const city = !!w.loc.city, cells = new Map(), list = [];
  for (const rd of w.net.roads) {
    if (rd.kind === 'rail' || rd.minor) continue; // (buildings don't move for the ways off the street network: setback.js)
    const P = rd.pts, n = P.length, r = rd.width / 2 + (city && rd.kind !== 'highway' && !rd.baked ? PAVE[rd.kind] ?? PAVE.street : VERGE);
    for (let i = 0; i < (rd.closed ? n : n - 1); i++) {
      const j = (i + 1) % n, a = P[i], b = P[j];
      if (rd.tube?.[i] && rd.tube?.[j]) continue;
      if (rd.bridge?.[i] && rd.bridge?.[j] && (a.y + b.y) / 2 - w.rawHeight((a.x + b.x) / 2, (a.z + b.z) / 2) > 5) continue;
      const s = { ax: a.x, az: a.z, bx: b.x, bz: b.z, r, kind: rd.kind }; list.push(s);
      for (let ci = Math.floor((Math.min(a.x, b.x) - r) / C); ci <= Math.floor((Math.max(a.x, b.x) + r) / C); ci++)
        for (let cj = Math.floor((Math.min(a.z, b.z) - r) / C); cj <= Math.floor((Math.max(a.z, b.z) + r) / C); cj++) { const k = ci + ',' + cj; let c = cells.get(k); if (!c) cells.set(k, (c = [])); c.push(s); }
    }
  }
  return { cells, n: list.length };
}
const inPoly = (P, x, z) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const ptSeg = (px, pz, s) => { const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1e-9; let t = ((px - s.ax) * dx + (pz - s.az) * dz) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(s.ax + dx * t - px, s.az + dz * t - pz); };
// how deep a footprint reaches into the clear zones (m; 0: clear): its walls sampled every 0.4 m, the centre lines every
// 0.5 m (a road through it: as deep as its clear half width and more)
function depth(Z, P) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  const segs = new Set();
  for (let ci = Math.floor(x0 / C); ci <= Math.floor(x1 / C); ci++) for (let cj = Math.floor(z0 / C); cj <= Math.floor(z1 / C); cj++) for (const s of Z.cells.get(ci + ',' + cj) || []) segs.add(s);
  let worst = 0, at = null;
  for (const s of segs) {
    if (Math.min(s.ax, s.bx) - s.r > x1 || Math.max(s.ax, s.bx) + s.r < x0 || Math.min(s.az, s.bz) - s.r > z1 || Math.max(s.az, s.bz) + s.r < z0) continue;
    let d = Infinity;
    for (let k = 0; k < P.length && d > 0; k++) {
      const a = P[k], b = P[(k + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(L / 0.4));
      for (let i = 0; i <= m; i++) d = Math.min(d, ptSeg(a[0] + (b[0] - a[0]) * i / m, a[1] + (b[1] - a[1]) * i / m, s));
    }
    const L = Math.hypot(s.bx - s.ax, s.bz - s.az), m = Math.max(1, Math.ceil(L / 0.5));
    for (let i = 0; i <= m && d > 0; i++) if (inPoly(P, s.ax + (s.bx - s.ax) * i / m, s.az + (s.bz - s.az) * i / m)) d = 0;
    if (s.r - d > worst) { worst = s.r - d; at = s; }
  }
  return { worst, at };
}

// the place's footprints: [{ P, x, z }] as built ('after'), or as mapped ('before', what the World starts from)
async function footprints(w, which) {
  const out = [], T = w.towns;
  if (T.city) {
    const { readRec } = await import('../../src/realCity.js'), city = T.city, H = city.city.hdr, U = city.city.U, S = city.city.S, R = {}, minA = w.qName === 'low' ? 60 : w.qName === 'medium' ? 25 : 0;
    const a2 = (P) => { let a = 0; for (let k = 0; k < P.length; k++) { const p = P[k], c = P[(k + 1) % P.length]; a += p[0] * c[1] - c[0] * p[1]; } return Math.abs(a / 2); };
    for (const t of city.tiles.values()) {
      const [cx, cz] = city.tileCentre(t.i, t.j); let o = t.off;
      for (let r = 0; r < t.nTall + t.nLow; r++) {
        readRec(U, S, o, city.q, cx, cz, R); o = R.next;
        const tall = r < t.nTall; if (city.skipped(R)) continue;
        if (!tall && minA && a2(R.P) < minA) break; // (what the tiles build at this quality: sorted by area)
        if (which === 'before') { if (R.P.length >= 3 && a2(R.P) >= 6) out.push({ P: R.P }); continue; }
        const F = city.footprint(R, tall); if (F && a2(F.P) >= 6) out.push({ P: F.P, holes: F.holes, through: F.through, dk: 'c' + R.o, tall });
      }
    }
    return out;
  }
  if (which === 'before') { // RealScenery.buildBuildings's own skips (the airport, the smallest at this quality), without the setbacks
    const minA = w.qName === 'low' ? 60 : w.qName === 'medium' ? 25 : 0;
    for (const b of w.real.osm.buildings) {
      const f = b[6], P = []; for (let k = 0; k < f.length; k += 2) P.push([f[k], f[k + 1]]); if (P.length < 3) continue;
      let a = 0, cx = 0, cz = 0; for (let k = 0; k < P.length; k++) { const p = P[k], c = P[(k + 1) % P.length]; a += p[0] * c[1] - c[0] * p[1]; cx += p[0] / P.length; cz += p[1] / P.length; }
      if (Math.abs(a / 2) < minA || (Math.abs(cx - 100) < 480 && Math.abs(cz) < 1250)) continue;
      out.push({ P });
    }
    return out;
  }
  for (const arr of T.grid.values()) for (const e of arr) if (e.fp) out.push({ P: e.fp, holes: [], through: e.through, dk: e.dk });
  return out;
}

export async function measure(w, which = 'after') {
  const Z = zones(w), F = await footprints(w, which), on = [], under = [];
  for (const f of F) {
    const d = depth(Z, f.P); if (d.worst <= TOL) continue;
    let x = 0, z = 0; for (const p of f.P) { x += p[0] / f.P.length; z += p[1] / f.P.length; }
    const o = { x: Math.round(x), z: Math.round(z), d: d.worst, kind: d.at.kind, r: d.at.r };
    // a big building the World left standing over a road through it (setback.js: a passage under it): only if the
    // road's centre line really runs inside it
    if (f.through && d.worst >= d.at.r - 1e-6) under.push(o); else on.push(o);
  }
  on.sort((a, b) => b.d - a.d);
  // the collision boxes the cars meet (World.wallBoxes reads these: destruction.js box), as built: none on a road either
  const boxes = [], T = w.towns, grids = which === 'after' ? [T.city ? T.city.grid : T.grid] : [];
  const seen = new Set();
  for (const g of grids) for (const arr of g.values()) for (const e of arr) {
    if (seen.has(e) || !e.solid) continue; seen.add(e);
    if (e.through) continue; // (a big building over a road through it: counted above; its passage's boxes either side are not through)
    for (const b of e.parts || [w.destruct.box(e)]) { // (an irregular building: each of its own boxes, setback.js footBoxes)
      const C4 = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, c]) => [b.x + b.ux * b.hl * a - b.uz * b.hw * c, b.z + b.uz * b.hl * a + b.ux * b.hw * c]);
      const d = depth(Z, C4); if (d.worst > TOL) boxes.push({ x: Math.round(b.x), z: Math.round(b.z), d: d.worst, kind: d.at.kind });
    }
  }
  const nBoxes = [...seen].reduce((n, e) => n + (e.parts?.length || 1), 0);
  boxes.sort((a, b) => b.d - a.d);
  // ... and none reaching out past its building's walls onto the open ground (an invisible wall: a box over a
  // trapezoid's sliver or an L's yard; setback.js footBoxes gives an irregular building a few boxes that hug its
  // walls): every edge of every box sampled every metre, how far from every footprint (the footprints as built, in a
  // 25 m hash); counted near a street (within NEAR of its pavement: the open ground where cars go) and anywhere
  const FH = new Map(), out = [], out1 = [], outAny = [], cover = { inside: 0, covered: 0, low: [], bld: 0, multi: 0, boxes: 0, max: 0 };
  if (which === 'after') {
    for (const f of F) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of f.P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      for (let ci = Math.floor(x0 / C); ci <= Math.floor(x1 / C); ci++) for (let cj = Math.floor(z0 / C); cj <= Math.floor(z1 / C); cj++) { const k = ci + ',' + cj; let c = FH.get(k); if (!c) FH.set(k, (c = [])); c.push(f.P); } }
    const off = (x, z) => { // metres from the nearest footprint (0 inside one), up to 2 cells away
      let m = Infinity; const ci = Math.floor(x / C), cj = Math.floor(z / C), done = new Set();
      for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const P of FH.get(a + ',' + b) || []) {
        if (done.has(P)) continue; done.add(P); if (inPoly(P, x, z)) return 0;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) m = Math.min(m, ptSeg(x, z, { ax: P[j][0], az: P[j][1], bx: P[i][0], bz: P[i][1] }));
      }
      return m;
    };
    const street = (x, z) => { const ci = Math.floor(x / C), cj = Math.floor(z / C); for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const sg of Z.cells.get(a + ',' + b) || []) if (ptSeg(x, z, sg) - sg.r < NEAR) return true; return false; }; // (near a street: the open ground beside it, where cars go; not a courtyard or a notch deep in a block)
    for (const e of seen) {
      if (e.through || !e.dk) continue; // (buildings only: not masts, not a passage's boxes beside its road)
      const B = e.parts || [w.destruct.box(e)];
      for (const b of B) {
        let worst = 0, wAny = 0;
        for (const [a0, c0, a1, c1] of [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]]) {
          const L = Math.hypot((a1 - a0) * b.hl, (c1 - c0) * b.hw), n = Math.max(1, Math.ceil(L));
          for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n, c = c0 + (c1 - c0) * i / n, x = b.x + b.ux * b.hl * a - b.uz * b.hw * c, z = b.z + b.uz * b.hl * a + b.ux * b.hw * c, d = off(x, z); if (d === Infinity) continue; if (d > wAny) wAny = d; if (d > worst && street(x, z)) worst = d; }
        }
        const o = { x: Math.round(b.x), z: Math.round(b.z), d: worst };
        if (worst > OUT_TOL) out.push(o); if (worst > OUT_1) out1.push(o); if (wAny > OUT_1) outAny.push({ ...o, d: wAny });
      }
    }
    out.sort((a, b) => b.d - a.d); out1.sort((a, b) => b.d - a.d); outAny.sort((a, b) => b.d - a.d);
    // how much of each footprint its boxes cover (a point every 0.7 m inside its walls): no gap a car could get into
    const byKey = new Map(); for (const e of seen) if (e.dk && !e.through) byKey.set(e.dk, e);
    for (const f of F) {
      const e = byKey.get(f.dk); if (!e || f.through) continue;
      const B = e.parts || [w.destruct.box(e)], inB = (x, z) => B.some((b) => { const dx = x - b.x, dz = z - b.z; return Math.abs(dx * b.ux + dz * b.uz) < b.hl && Math.abs(-dx * b.uz + dz * b.ux) < b.hw; });
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of f.P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      let n = 0, k = 0;
      for (let x = x0 + 0.35; x < x1; x += 0.7) for (let z = z0 + 0.35; z < z1; z += 0.7) if (inPoly(f.P, x, z) && !(f.holes || []).some((h) => inPoly(h, x, z))) { n++; if (inB(x, z)) k++; }
      if (!n) continue;
      cover.inside += n; cover.covered += k; cover.bld++; cover.boxes += B.length; cover.max = Math.max(cover.max, B.length); if (B.length > 1) cover.multi++;
      if (k < 0.9 * n && n * 0.49 >= 40) { let cx = 0, cz = 0; for (const p of f.P) { cx += p[0] / f.P.length; cz += p[1] / f.P.length; } cover.low.push({ x: Math.round(cx), z: Math.round(cz), c: k / n, dk: f.dk }); }
    }
    cover.low.sort((a, b) => a.c - b.c);
  }
  const hist = [0.5, 1, 2, 4, Infinity].map((lim, i, L) => [i ? L[i - 1] : TOL, lim, on.filter((o) => o.d > (i ? L[i - 1] : TOL) && o.d <= lim).length]);
  return { n: F.length, on, under, hist, segs: Z.n, boxes, nBoxes, out, out1, outAny, cover };
}

export async function runCase(c) {
  const { worldAt } = await import('./node/world.mjs');
  const W = await worldAt(c.loc), w = W.world, sb = (w.towns.city || w.towns).setbacks, ms = sb.ms; // (at load: before measure builds New York's low footprints too)
  const fs = (w.towns.city || w.towns).footStats, load = fs.load, LW = (w.towns.city || w.towns).loadWork; // (before measure asks every building for its boxes; LW: setback.js WORK counted at load)
  const m = await measure(w, 'after'), T0 = w.towns, d = perBuilding(w);
  const worst = m.on.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(2)} m into a ${o.kind}`).join('; ');
  const kept = m.n / Math.max(1, m.n + sb.dropped);
  return [
    { name: `${c.loc}: no building footprint on a road`, ok: !m.on.length, why: m.on.length ? `${m.on.length} of ${m.n} footprints reach in, worst ${worst}` : `${m.n} footprints clear of ${m.segs} road segments (${sb.cut} cut back, ${sb.dropped} left out; ${m.under.length} big ones over a road through them)` },
    { name: `${c.loc}: no collision box on a road`, ok: !m.boxes.length, why: m.boxes.length ? `${m.boxes.length} of ${m.nBoxes} boxes reach in, worst ${m.boxes.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(2)} m into a ${o.kind}`).join('; ')}` : `${m.nBoxes} boxes (World.wallBoxes${c.loc === 'nyc' ? ': the tall buildings built at load' : ''})` },
    { name: `${c.loc}: no collision box reaches more than ${OUT_1} m past its walls`, ok: m.out1.length <= m.nBoxes * OUT_MAX, why: `${m.out1.length} of ${m.nBoxes} boxes reach more than ${OUT_1} m past every footprint within ${NEAR} m of a street (${m.out.length} more than ${OUT_TOL} m; ${m.outAny.length} more than ${OUT_1} m anywhere, courtyards and notches too). At most ${OUT_MAX * 100}%: an invisible wall on the open ground beside it. 1,344 of 37,585 reached more than 2 m in New York before irregular buildings got boxes of their own (setback.js footBoxes)${m.out1.length ? `; worst ${m.out1.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(1)} m`).join('; ')}` : ''}` },
    { name: `${c.loc}: the boxes cover the buildings`, ok: m.cover.covered >= COVER * m.cover.inside && m.cover.low.length <= m.cover.bld * 0.01, why: `${(100 * m.cover.covered / Math.max(1, m.cover.inside)).toFixed(1)}% of ${m.cover.bld} footprints' area inside a box (at least ${COVER * 100}%), ${m.cover.low.length} buildings of 40 m2 and more under 90% (at most 1%)${m.cover.low.length ? `, worst ${m.cover.low.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${(100 * o.c).toFixed(0)}%`).join('; ')}` : ''}; ${m.cover.multi} irregular ones with boxes of their own, ${(m.cover.boxes / Math.max(1, m.cover.bld)).toFixed(2)} boxes a building, at most ${m.cover.max}` },
    { name: `${c.loc}: few big buildings left over a road`, ok: m.under.length <= Math.max(3, m.n * 0.0005), why: `${m.under.length} (a passage under them, or a mapping clash: ${m.under.slice(0, 4).map((o) => `(${o.x}, ${o.z})`).join(' ')})` },
    { name: `${c.loc}: setbacks keep most buildings`, ok: kept > 0.97, why: `${sb.dropped} left out, ${m.n} kept (${(100 * kept).toFixed(1)}%)` },
    { name: `${c.loc}: setbacks are cheap at load`, ok: !!LW && sbWork(LW) <= CAP[c.loc].sb * LW.n, why: `${LW ? `${sbWork(LW)} units of work for ${LW.n} buildings, ${(sbWork(LW) / Math.max(1, LW.n)).toFixed(0)} a building (at most ${CAP[c.loc].sb}): ${LW.index} road points indexed and index entries visited, ${LW.tests} footprint walls tested against a road` : 'no load work counted'} (Node, Low: the road index, the footprints and boxes built at load; New York's low ones are set back a tile at a time as they stream in). ${ms.toFixed(0)} ms, ${(100 * ms / W.ms).toFixed(1)}% of the World's ${W.ms} ms build: info only` },
    { name: `${c.loc}: collision boxes cheap`, ok: !!LW && LW.irr <= CAP[c.loc].eager && bxWork(LW) <= CAP[c.loc].load * LW.n && bxWork(fs.lazyWork) <= LAZY_MAX, why: `${LW ? `at load ${LW.irr} irregular buildings boxed (at most ${CAP[c.loc].eager}: the big ones, FOOT.eager; the rest are worked out when first wanted, setback.js lazyParts), ${bxWork(LW)} units of box work for ${LW.n} buildings (${(bxWork(LW) / Math.max(1, LW.n)).toFixed(1)} a building, at most ${CAP[c.loc].load}: ${LW.cells} grid cells, ${LW.verts} walls visited)` : 'no load work counted'}; then the most any one took: ${bxWork(fs.lazyWork)} (at most ${LAZY_MAX}: ${fs.lazyWork?.cells ?? 0} cells, ${fs.lazyWork?.verts ?? 0} walls visited, a footprint of ${fs.lazyWork?.walls ?? 0} walls into ${fs.lazyWork?.boxes ?? 0} boxes, of at most FOOT.max ${FS_MAX}; ${fs.max} the most any had). Info: at load ${load.toFixed(0)} ms (${(100 * load / W.ms).toFixed(1)}% of the build), then ${(fs.ms / Math.max(1, fs.irr)).toFixed(2)} ms a building, the slowest ${slowest(fs).toFixed(1)} ms` },
    { name: `${c.loc}: an irregular building is still one building`, ok: d.n > 0 && !d.bad.length, why: `${d.n} buildings of ${d.boxes} boxes: each box hit is that building, knocked down to 2 m every one of its boxes is 2 m tall, one damage state each${d.bad.length ? '; ' + d.bad.slice(0, 3).join('; ') : ''}` },
  ];
}

// The work caps (setback.js WORK, counted: a time would depend on the machine). Per place: sb, the setbacks' work at
// load per building (index + tests); eager, irregular buildings boxed at load; load, the boxes' work at load per
// building (cells + verts). LAZY_MAX: the most box work any one building worked out after load may take (cells + verts).
// Counted when these caps were set (2026-11): sb islands 25, canyon 76, lauterbrunnen 30, nyc 113 (caps ~2.5x: the old
// time share had 3-9x room); eager 0, 0, 2, 249 (New York's: ~1.5x, as the old 8% share had over its 5.5%); load 56,
// 45, 38, 255 (~1.6-2x); the most one building took after load: nyc 258k (268 walls into 12 boxes), islands 95k,
// lauterbrunnen 167k, canyon 68k (~2.3x over the worst).
const CAP = { islands: { sb: 65, eager: 5, load: 120 }, canyon: { sb: 190, eager: 5, load: 100 }, lauterbrunnen: { sb: 75, eager: 10, load: 80 }, nyc: { sb: 280, eager: 375, load: 400 } }, LAZY_MAX = 600000;
const sbWork = (w) => (w ? w.index + w.tests : 0), bxWork = (w) => (w ? w.cells + w.verts : 0);
// (info only) the slowest building's boxes worked out after load, timed again 3 times, the best taken
function slowest(fs) {
  if (fs._slow != null) return fs._slow;
  if (!fs.lazyRedo) return (fs._slow = fs.lazy);
  let best = Infinity; for (let k = 0; k < 3; k++) { const t0 = performance.now(); fs.lazyRedo(); best = Math.min(best, performance.now() - t0); }
  return (fs._slow = best);
}

// An irregular building's boxes are one building to destruction.js: a point in any of them hits its entry
// (towns.hit), cutting the building down cuts every box (World.wallBoxes heights), and it gets one damage state
function perBuilding(w) {
  const D = w.destruct, T = w.towns, seen = new Set(), list = [], bad = []; let boxes = 0;
  for (const a of (T.city ? T.city.grid : T.grid).values()) for (const e of a) if (e.dk && !seen.has(e) && list.length < 25) { seen.add(e); if (!e.through && e.parts?.length >= 2 && e[3] > 6) list.push(e); }
  for (const e of list) {
    const n0 = D.states.size, mid = e[1] + e[3] / 2, at = (q) => `(${Math.round(q.x)}, ${Math.round(q.z)})`;
    for (const q of e.parts) { const h = T.hit({ x: q.x, y: mid, z: q.z }); if (!h) bad.push(`${at(q)}: no hit`); else if (h !== e && h.dk === e.dk) bad.push(`${at(q)}: another entry of the same building`); }
    const B = D.get(e); D.setCut(B, B.y0 + 2, 0);
    for (const q of e.parts) { boxes++; const got = w.wallBoxes(q.x, q.z, 0.5).filter((b) => b.e === e); if (!got.length && e[3] > 0.3) bad.push(`${at(q)}: not a wall box`); for (const b of got) if (Math.abs(b.y1 - (B.y0 + 2)) > 0.05) bad.push(`${at(q)}: ${b.y1.toFixed(1)} m tall, not ${(B.y0 + 2).toFixed(1)}`); }
    if (D.states.size !== n0 + 1) bad.push(`${at(e.parts[0])}: ${D.states.size - n0} damage states`);
  }
  D.reset();
  return { n: list.length, boxes, bad };
}

// standalone: the counts before and after
if (import.meta.url === `file://${process.argv[1]}`) {
  const { worldAt } = await import('./node/world.mjs');
  for (const loc of process.argv.slice(2).length ? process.argv.slice(2) : PLACES) {
    const { world: w, ms } = await worldAt(loc), T = w.towns.city || w.towns, sb = { ...T.setbacks };
    const b = await measure(w, 'before'), a = await measure(w, 'after');
    const fmt = (m) => `${m.on.length} of ${m.n} on a road (+${m.under.length} big ones over a road through them) [${m.hist.map(([lo, hi, k]) => `${lo}-${hi === Infinity ? '' : hi} m: ${k}`).join(', ')}]; worst ${m.on.slice(0, 5).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(1)} m ${o.kind}`).join('; ')}`;
    const boxes = `boxes on a road: ${a.boxes.length} of ${a.nBoxes}${a.boxes.length ? ', worst ' + a.boxes.slice(0, 5).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(1)} m ${o.kind}`).join('; ') : ''}`;
    console.log(`${loc}: World built in ${ms} ms; setbacks ${sb.ms.toFixed(0)} ms, ${sb.cut} cut back, ${sb.dropped} left out, ${sb.through} left whole over a road (at load: New York's tall ones)\n  before: ${fmt(b)}\n  after:  ${fmt(a)}\n  ${boxes}`);
  }
  process.exit(0);
}
