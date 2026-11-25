// Building setbacks (Node tier, #228): no building footprint stands on a road. Every real place's buildings as the
// World built them (RealScenery: each building's footprint, e.fp; New York: every city.bin record through
// CityScenery.footprint, tall and low, the low ones whether or not a tile near the camera has built them yet) against
// every road's clear zone: tarmac + gravel verge (roadgrade.js VERGE), or on a city street tarmac + pavement (roads.js
// roadMesh). Left out: tunnels' tubes and bridge decks up in the air. Measured here with its own geometry (sampled,
// not setback.js's), so it checks the rule, not the code against itself.
//   on a road:  how many footprints reach more than TOL into a clear zone (none), and the deepest
//   boxes:      the collision boxes cars meet (World.wallBoxes) are off the roads too
//   kept:       how many buildings the setbacks left out (a few per cent at most: most are cut back, not dropped)
//   cheap:      the setbacks' own time at load (index + cuts), as a share of the World's build
//   few over:   big buildings a road runs right through are left standing only with a passage under them (setback.js
//               MAJOR, PASSAGE; realCity.js builds it, its boxes below the underside are checked with the others); few
// Standalone (counts before and after, worst spots): node --import ./tools/test/node/setup.mjs tools/test/setbacks.js [place ...]
import { VERGE } from '../../src/roadgrade.js';

export const nodeSuite = { files: ['src/setback.js', 'src/realBuildings.js', 'src/realCity.js', 'tools/test/setbacks.js'] };
const PLACES = ['lauterbrunnen', 'canyon', 'islands', 'nyc'];
const TOL = 0.1, PAVE = { main: 4.5, street: 3.5 }, C = 25, OUT_TOL = 2, NEAR = 12, OUT_MAX = 0.05; // (OUT_TOL: m a collision box may reach past its walls, out on the open ground within NEAR of a street's pavement: setback.js boxInside keeps them within 1 m of them, sampled at its corners and edge middles)

export function cases() { return PLACES.map((loc) => ({ id: loc, loc, world: loc, cost: loc === 'nyc' ? 40 : 8 })); }

// the clear zones: segments { ax, az, bx, bz, r } in a 25 m hash
function zones(w) {
  const city = !!w.loc.city, cells = new Map(), list = [];
  for (const rd of w.net.roads) {
    if (rd.kind === 'rail') continue;
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
        const F = city.footprint(R, tall); if (F && a2(F.P) >= 6) out.push({ P: F.P, through: F.through });
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
  for (const arr of T.grid.values()) for (const e of arr) if (e.fp) out.push({ P: e.fp, through: e.through });
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
    const b = w.destruct.box(e), C4 = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, c]) => [b.x + b.ux * b.hl * a - b.uz * b.hw * c, b.z + b.uz * b.hl * a + b.ux * b.hw * c]);
    const d = depth(Z, C4); if (d.worst > TOL) boxes.push({ x: Math.round(b.x), z: Math.round(b.z), d: d.worst, kind: d.at.kind });
  }
  boxes.sort((a, b) => b.d - a.d);
  // ... and none reaching out past its building's walls onto the open ground (an invisible wall: a box over a
  // trapezoid's sliver or an L's yard, setback.js boxInside): a corner or edge middle more than OUT_TOL from every
  // footprint (the footprints as built, in a 25 m hash)
  const FH = new Map(), out = [];
  if (which === 'after' && T.city) { // (New York's: the other places' boxes are their footprints' own rectangles, or a town's houses)
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
      if (e.through || !e.dk) continue; // (buildings only: not masts)
      const b = w.destruct.box(e); if (off(b.x, b.z) > 0) continue; // (its footprint: the one round its middle; none, a building this quality leaves out)
      let worst = 0;
      for (const [a, c] of [[1, 1], [-1, 1], [-1, -1], [1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = b.x + b.ux * b.hl * a - b.uz * b.hw * c, z = b.z + b.uz * b.hl * a + b.ux * b.hw * c, d = off(x, z);
        if (d > worst && street(x, z)) worst = d;
      }
      if (worst > OUT_TOL) out.push({ x: Math.round(b.x), z: Math.round(b.z), d: worst });
    }
    out.sort((a, b) => b.d - a.d);
  }
  const hist = [0.5, 1, 2, 4, Infinity].map((lim, i, L) => [i ? L[i - 1] : TOL, lim, on.filter((o) => o.d > (i ? L[i - 1] : TOL) && o.d <= lim).length]);
  return { n: F.length, on, under, hist, segs: Z.n, boxes, nBoxes: seen.size, out };
}

export async function runCase(c) {
  const { worldAt } = await import('./node/world.mjs');
  const W = await worldAt(c.loc), w = W.world, sb = (w.towns.city || w.towns).setbacks, ms = sb.ms; // (at load: before measure builds New York's low footprints too)
  const m = await measure(w, 'after'), T0 = w.towns;
  const worst = m.on.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(2)} m into a ${o.kind}`).join('; ');
  const kept = m.n / Math.max(1, m.n + sb.dropped);
  return [
    { name: `${c.loc}: no building footprint on a road`, ok: !m.on.length, why: m.on.length ? `${m.on.length} of ${m.n} footprints reach in, worst ${worst}` : `${m.n} footprints clear of ${m.segs} road segments (${sb.cut} cut back, ${sb.dropped} left out; ${m.under.length} big ones over a road through them)` },
    { name: `${c.loc}: no collision box on a road`, ok: !m.boxes.length, why: m.boxes.length ? `${m.boxes.length} of ${m.nBoxes} boxes reach in, worst ${m.boxes.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(2)} m into a ${o.kind}`).join('; ')}` : `${m.nBoxes} boxes (World.wallBoxes${c.loc === 'nyc' ? ': the tall buildings built at load' : ''})` },
    { name: `${c.loc}: few collision boxes out past their walls`, ok: !T0.city || m.out.length <= m.nBoxes * OUT_MAX, why: `${m.out.length} of ${m.nBoxes} boxes reach more than ${OUT_TOL} m past every footprint within ${NEAR} m of a street (at most ${OUT_MAX * 100}%: an invisible wall on the open ground beside it; 15% did before setback.js boxInside. What's left: a cross or a U, which one box can't fit, setback.js)${m.out.length ? `, worst ${m.out.slice(0, 3).map((o) => `(${o.x}, ${o.z}) ${o.d.toFixed(1)} m`).join('; ')}` : ''}` },
    { name: `${c.loc}: few big buildings left over a road`, ok: m.under.length <= Math.max(3, m.n * 0.0005), why: `${m.under.length} (a passage under them, or a mapping clash: ${m.under.slice(0, 4).map((o) => `(${o.x}, ${o.z})`).join(' ')})` },
    { name: `${c.loc}: setbacks keep most buildings`, ok: kept > 0.97, why: `${sb.dropped} left out, ${m.n} kept (${(100 * kept).toFixed(1)}%)` },
    { name: `${c.loc}: setbacks are cheap at load`, ok: ms < 0.15 * W.ms, why: `${ms.toFixed(0)} ms, ${(100 * ms / W.ms).toFixed(1)}% of the World's ${W.ms} ms build (Node, Low: the road index, the footprints and boxes built at load; New York's low ones are set back a tile at a time as they stream in. A share, not a time: a busy machine slows both)` },
  ];
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
