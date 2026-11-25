// Buildings (Node suite): the geometry the towns' building kit writes (src/buildings.js Builder) and the real places'
// buildings made with it (src/realBuildings.js), read back from the built meshes.
//  - kit: the atlas cells (unique, inside the 8 x 8 atlas, the cut-stone window cells have their window rects); every
//    face Builder.obox writes faces out of the box (its top up: the bungalow decks and pier decks), whatever the axis
//  - decks (Bora Bora): every overwater bungalow deck and pier deck (BOARDS, flat, at deck height) faces up, and every
//    triangle of the buildings is wound the way its normal points (front faces are the ones drawn)
//  - styles (Bora Bora, Lauterbrunnen): the same building gets the same walls, colours and roof at Low and at High (Low
//    leaves the small ones out: the others' styles must not depend on that); each building's vertices are one run of
//    its chunk (destruction.js), with High's gutters and downpipes inside it
//  - rules (each place's own buildings, read back from the built meshes): no flower boxes in the Grand Canyon or on Bora
//    Bora; no flat roofs on Swiss houses (industrial only); hipped roofs only on near-rectangles, and no roof reaching
//    out over a footprint's empty corners anywhere; every church a steeple; Swiss chalets on a masonry ground floor,
//    with balconies; Bora Bora's houses one storey with verandas, its bungalows light timber under thatch; the canyon's
//    cabins one or two storeys under metal or shingle, its lodges stone and logs, its motels walkways
//  - roofs (phase 4): Swiss chalets low-pitched with wide eaves, their gables to the valley on a slope, some roofs
//    weighted with stones; Bora Bora's thatch steep (or at the 5.5 m cap), its eaves thatch (no white fascia, no gutters); New York's flat
//    roofs varied (membrane, coated and black tar, gravel, pavers), water tanks on the walk-ups and pre-war roofs,
//    bulkheads and plant rooms, crowns on the towers; the furniture inside its footprint, its indices last (drawn near
//    only) and every tank's staves wound outwards
import * as THREE from 'three';
import { Builder, C, WINDOW_RECTS, TIER, tierCells, facade, facadeSpec, LY0, LYS } from '../../src/buildings.js';

export const nodeSuite = { files: ['src/buildings.js', 'src/realBuildings.js', 'src/realCity.js', 'src/setback.js', 'tools/test/bldcheck.js'] };

export function cases() {
  return [
    { id: 'kit', cost: 0.1 },
    { id: 'decks islands', loc: 'islands', world: 'islands', cost: 3 },
    { id: 'styles islands', loc: 'islands', cost: 8 },
    { id: 'styles lauterbrunnen', loc: 'lauterbrunnen', cost: 12 },
    { id: 'rules islands', loc: 'islands', world: 'islands', cost: 3 },
    { id: 'rules canyon', loc: 'canyon', world: 'canyon', cost: 3 },
    { id: 'rules lauterbrunnen', loc: 'lauterbrunnen', world: 'lauterbrunnen', cost: 10 },
    { id: 'facades nyc', loc: 'nyc', world: 'nyc', cost: 12 },
    { id: 'roofs nyc', loc: 'nyc', world: 'nyc', cost: 6 },
  ];
}

const DECK = 1.7; // (realBuildings.js)
// the gutter and downpipe tints (buildings.js _gutters) and the cut gables' soffits (realBuildings.js fitGable), High's
// alone, as Builder stores them (linear, 8 bit)
const GUTTER = new Set([0x8a8a84, 0x7a7a74, 0xe6e2da].map((h) => { const c = new THREE.Color(h); return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255); }));

// every triangle of a geometry: its vertices, its stored normal (the first vertex's) and the normal of its winding
function* tris(g) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, A = g.attributes.atl.array, I = g.index.array;
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx, l = Math.hypot(wx, wy, wz);
    if (l < 0.01) continue; // (slivers under 50 cm2: float32 world positions can flip them)
    yield { a, cell: A[a * 4], y: (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, n: [N[a * 3] / 127, N[a * 3 + 1] / 127, N[a * 3 + 2] / 127], w: [wx / l, wy / l, wz / l], flat: Math.abs(P[a * 3 + 1] - P[b * 3 + 1]) < 1e-3 && Math.abs(P[a * 3 + 1] - P[c * 3 + 1]) < 1e-3 };
  }
}
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

function kit() {
  const out = [], vals = Object.values(C);
  out.push({ name: 'kit: atlas cells unique and inside the 8 x 8 atlas', ok: new Set(vals).size === vals.length && vals.every((v) => v >= 0 && v < 64), why: `${vals.length} cells, max ${Math.max(...vals)}` });
  const tiers = Object.values(TIER), tb = tiers.filter((t) => t < 64 || tierCells(t).some((k) => k >= 64 || !vals.includes(k)));
  out.push({ name: 'kit: two-tier wall ids past the atlas, each two atlas cells', ok: !tb.length, why: tb.join(', ') });
  // facade programs (ground floors): one id per program, past the atlas; each one's cells atlas cells
  const f1 = facade({ upper: C.BRICK_WIN, ground: C.RUST, gH: 3.6, door: C.RUST_DOOR }), f2 = facade({ upper: C.BRICK_WIN, ground: C.RUST, gH: 3.6, door: C.RUST_DOOR });
  const fb = []; for (let id = 64; id < 256; id++) { const f = facadeSpec(id); if (f && ![f.upper, f.ground, f.door, f.door2, f.top].every((k) => k < 64)) fb.push(id); }
  out.push({ name: 'kit: facade programs: one id each, past the atlas, made of atlas cells', ok: f1 === f2 && f1 >= 64 && TIER.CHALET === 64 && TIER.LODGE === 65 && !fb.length, why: `ids ${f1}, ${f2}, tiers ${TIER.CHALET}, ${TIER.LODGE}; bad ${fb.join(', ')}` });
  const miss = ['LIME_WIN', 'BROWN_WIN', 'SHOPFRONT', 'SHOP_DOOR', 'RUST', 'RUST_DOOR'].filter((k) => !WINDOW_RECTS[C[k]]);
  out.push({ name: 'kit: cut-stone and ground-floor window cells have window rects', ok: !miss.length, why: miss.join(', ') });
  // obox at a spread of axes: every face points away from the box centre, the top straight up, winding = normal
  const bad = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + 0.1, B = new Builder(), cx = 5, cz = -3;
    B.obox(cx, cz, Math.cos(a), Math.sin(a), 4, 2, 1, 1.5, C.BOARDS, 0x9a7a58);
    const g = B.toGeometry(), P = g.attributes.position.array;
    for (const t of tris(g)) {
      const o = [P[t.a * 3] - cx, P[t.a * 3 + 1] - 1.25, P[t.a * 3 + 2] - cz];
      if (dot(t.n, t.w) < 0.99 || dot(t.w, o) <= 0 || (t.flat && t.w[1] < 0.99)) { bad.push(`axis ${(a * 180 / Math.PI).toFixed(0)} deg: face ${t.w.map((v) => v.toFixed(2))}`); break; }
    }
  }
  out.push({ name: 'kit: Builder.obox faces all point out (top up) at any axis', ok: !bad.length, why: bad.slice(0, 3).join('; ') });
  return out;
}

async function decks(c) {
  const { worldAt } = await import('./node/world.mjs'), { world } = await worldAt(c.loc), T = world.towns, wl = world.waterLevel;
  let deckN = 0, deckDown = 0, n = 0, wrong = 0, ex = '';
  for (const ch of T.chunkList || []) for (const t of tris(ch.m.geometry)) {
    n++;
    if (dot(t.n, t.w) < 0.9) { wrong++; ex ||= `cell ${t.cell} at y ${t.y.toFixed(1)}: normal ${t.n.map((v) => v.toFixed(2))}, wound ${t.w.map((v) => v.toFixed(2))}`; }
    if (t.cell === C.BOARDS && t.flat && t.y > wl + DECK - 0.5) { deckN++; if (t.w[1] < 0.99) deckDown++; } // (deck heights: wl + DECK, piers above)
  }
  return [
    { name: `${c.id}: bungalow and pier decks found`, ok: deckN > 100, why: `${deckN} deck triangles` },
    { name: `${c.id}: every deck top faces up`, ok: deckN > 0 && !deckDown, why: `${deckDown}/${deckN} face down` },
    { name: `${c.id}: every building triangle wound the way its normal points`, ok: !wrong, why: `${wrong}/${n}, e.g. ${ex}` },
  ];
}

// each building of a built world: its style (what its vertices are made of, gutters left out) by where it stands
function styles(world) {
  const out = new Map(), runs = new Map(), dup = new Set();
  for (const a of world.towns.grid.values()) for (const e of a) {
    if (!e.rng || !e.ob) continue;
    const [B, s, cnt] = e.rng[0], g = B.geo, A = g.attributes.atl.array, Cl = g.attributes.color.array, set = new Set();
    for (let i = s; i < s + cnt; i++) { const col = (Cl[i * 3] << 16) | (Cl[i * 3 + 1] << 8) | Cl[i * 3 + 2]; if ((A[i * 4] === C.METAL || A[i * 4] === C.TRIM) && GUTTER.has(col)) continue; set.add(A[i * 4] * 16777216 + col); }
    const key = `${e.ob.x.toFixed(1)},${e.ob.z.toFixed(1)},${Math.max(e.ob.hl, e.ob.hw).toFixed(1)},${Math.min(e.ob.hl, e.ob.hw).toFixed(1)}`; // (either way round: a chalet's ridge turns to its gable's side)
    if (out.has(key)) dup.add(key); // (two buildings on one footprint: which is which is left open)
    out.set(key, `seed ${A[s * 4 + 1]} | ` + [...set].sort((x, y) => x - y).map((v) => `${Math.floor(v / 16777216)}:${(v % 16777216).toString(16)}`).join(' '));
    if (!runs.has(B)) runs.set(B, []); runs.get(B).push([s, cnt]);
  }
  // runs of one chunk: disjoint, inside the chunk
  let overlap = 0;
  for (const [B, rs] of runs) { rs.sort((p, q) => p[0] - q[0]); for (let k = 0; k < rs.length; k++) if ((k && rs[k][0] < rs[k - 1][0] + rs[k - 1][1]) || rs[k][0] + rs[k][1] > B.geo.attributes.position.count) overlap++; }
  for (const k of dup) out.delete(k);
  return { out, overlap };
}

async function stylesCase(c) {
  const { nodeWorld } = await import('./node/world.mjs'), got = {};
  for (const q of ['low', 'high']) {
    const { world } = await nodeWorld(c.loc, q);
    try { got[q] = styles(world); } finally { world.dispose(); }
  }
  let same = 0, diff = 0, shore = 0, ex = '';
  const stilts = (s) => s.includes(` ${C.DARKWOOD}:`); // (a house on stilts: its piles)
  for (const [k, s] of got.low.out) {
    const h = got.high.out.get(k); if (h == null) continue;
    if (h === s) same++; else if (stilts(h) !== stilts(s)) shore++; else { diff++; ex ||= `building at ${k}: Low ${s.slice(0, 90)} / High ${h.slice(0, 90)}`; }
  }
  return [
    // (a few are not, or not where they were: the ground under them is from a coarser grid at Low, which can put a
    // shore building in the water or a whole one out of it)
    { name: `${c.id}: Low's buildings are on High`, ok: same + diff + shore >= got.low.out.size * 0.99 && same > 100, why: `${same + diff + shore}/${got.low.out.size}` },
    // (the shared random sequence gave ~99% of them other styles. What's left is the ground again: at a threshold the
    // height decides, a chalet up the valley or not, a house on stilts on the shore or not: those last are left out)
    { name: `${c.id}: the same building has the same style at Low and High`, ok: diff <= (same + diff) * 0.005, why: `${diff}/${same + diff} differ (and ${shore} on the shore are on stilts at one quality only)${diff ? `, e.g. ${ex}` : ''}` },
    { name: `${c.id}: each building one run of its chunk (High, with gutters)`, ok: !got.high.overlap, why: `${got.high.overlap} overlapping runs` },
  ];
}

// how far a point is outside a footprint ring ([[x, z], ...], as built: after any setback): 0 inside
function outside(fp, x, z) {
  const n = fp.length; let inside = false, d = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, az] = fp[j], [bx, bz] = fp[i];
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return inside ? 0 : d;
}
const ROOF_CELLS = new Set([C.TILES, C.DARKTILE, C.SLATE, C.SHINGLE, C.SEAM, C.THATCH, C.ROOF_GRAVEL, C.ROOF_STONES]);
const FLOWERS = new Set([C.WOOD_WIN, TIER.CHALET]); // (the chalet timber cells, with their geranium boxes)

// each place's own rules, from the buildings as built (Low)
async function rules(c) {
  const { worldAt } = await import('./node/world.mjs'), { world } = await worldAt(c.loc), T = world.towns, out = [];
  const ents = []; for (const a of T.grid.values()) for (const e of a) if (e.rng && e.ob) ents.push(e);
  const cellsOf = (e) => { const [B, s, n] = e.rng[0], A = B.geo.attributes.atl.array, m = new Map(); for (let i = s; i < s + n; i++) m.set(A[i * 4], (m.get(A[i * 4]) || 0) + 1); return m; };
  const has = (e, set) => [...cellsOf(e).keys()].some((k) => set.has(k));
  const count = (pred) => ents.filter(pred).length;
  // no roof over an empty corner: every roof vertex within the eave of the footprint (its eaves at a corner, e.overMax: a
  // chalet's 1.2 m and its gable's up to 2.1 m, and 0.6 m of slack), porches and
  // walkways, the bungalows' decks and a church's spire left out)
  let over = 0, worst = 0, ex = '';
  for (const e of ents) {
    if (e.roof === 0 || e.porch || e.wet || !e.fp) continue;
    const [B, s, n] = e.rng[0], g = B.geo, P = g.attributes.position.array, A = g.attributes.atl.array, N = g.attributes.normal.array;
    let m = 0; for (let i = s; i < s + n; i++) if (ROOF_CELLS.has(A[i * 4]) && N[i * 3 + 1] > 30) m = Math.max(m, outside(e.fp, P[i * 3], P[i * 3 + 2]));
    const lim = Math.max(2.2, (e.overMax ?? 1.6) + 0.6);
    if (m > lim) { over++; if (m - lim > worst) { worst = m - lim; ex = `a kind ${e.kind} building at ${e[0].toFixed(0)}, ${e[2].toFixed(0)} (roof ${e.roof}, rect ${e.rect.toFixed(2)})`; } }
  }
  out.push({ name: `${c.id}: no roof reaches over a footprint's empty corners`, ok: !over, why: `${over} roofs reach past their eaves (+0.6 m)${over ? `, worst by ${worst.toFixed(1)} m: ${ex}` : ''}` });
  const hipBad = count((e) => e.roof === 2 && e.rect < 0.9);
  out.push({ name: `${c.id}: hipped roofs only on near-rectangular footprints`, ok: !hipBad, why: `${hipBad} of ${count((e) => e.roof === 2)} hipped roofs on footprints under 0.9 of their rectangle` });
  const ch = ents.filter((e) => e.kind === 3 && e.ob.hl * e.ob.hw * 4 > 60), noSteeple = ch.filter((e) => {
    const [B, s, n] = e.rng[0], P = B.geo.attributes.position.array; let top = -Infinity; for (let i = s; i < s + n; i++) top = Math.max(top, P[i * 3 + 1]);
    return top < e[1] + e[3] + 4; // (the spire's tip well above the nave's ridge)
  });
  out.push({ name: `${c.id}: every church has a steeple`, ok: ch.length > 0 && !noSteeple.length, why: `${noSteeple.length} of ${ch.length} churches without a spire above the roof` });
  if (c.loc !== 'lauterbrunnen') {
    const fl = count((e) => has(e, FLOWERS));
    out.push({ name: `${c.id}: no flower boxes`, ok: !fl, why: `${fl} buildings with chalet flower-box walls` });
  }
  if (c.loc === 'lauterbrunnen') {
    const flat = ents.filter((e) => e.roof === 0 && e.kind !== 4).length;
    out.push({ name: `${c.id}: flat roofs on industrial buildings only`, ok: !flat, why: `${flat} non-industrial buildings with flat roofs (of ${count((e) => e.roof === 0)} flat)` });
    const tiered = count((e) => has(e, new Set([TIER.CHALET]))), wood = count((e) => has(e, FLOWERS)), bal = count((e) => has(e, new Set([C.RAIL_WOOD])));
    out.push({ name: `${c.id}: chalets on a masonry ground floor, with balconies`, ok: tiered > 2000 && tiered > wood * 0.5 && bal > 500, why: `${tiered} of ${wood} chalets on masonry, ${bal} balconies` });
    // ground floors (facade programs): doors on the walls facing a street, the plinths, the towns' shop fronts
    const prog = (pred) => count((e) => [...cellsOf(e).keys()].some((k) => { const f = facadeSpec(k); return f && pred(f); }));
    const doors = prog((f) => f.door >= 0), plinths = prog((f) => f.ground === C.STONE || f.ground === C.CONCRETE), shops = prog((f) => f.ground === C.SHOPFRONT), chDoor = prog((f) => f.door === C.MASONRY_DOOR);
    // chalet roofs: low (about 23 degrees, rise / half span 0.4-0.47), the gable's overhang wide; on a slope the ridge
    // runs down it (the gable to the valley); some roofs weighted with stones
    const chal = ents.filter((e) => e.chalet && (e.roof === 1 || e.roof === 5)), steepC = chal.filter((e) => e.pitch > 0.48 && !e.tagged).length;
    let slope = 0, down = 0;
    for (const e of chal) {
      if (e.ob.hl > e.ob.hw * 1.7 && e.ob.hw > e.ob.hl * 0) { /* (long barns keep the ridge on the long axis) */ }
      const [ux, uz] = e.ridge, d = 8, gs = (x, z) => world.sampleGrid(x, z), x = e.ob.x, z = e.ob.z;
      const gu = (gs(x + ux * d, z + uz * d) - gs(x - ux * d, z - uz * d)) / (2 * d), gn = (gs(x - uz * d, z + ux * d) - gs(x + uz * d, z - ux * d)) / (2 * d);
      if (Math.hypot(gu, gn) < 0.12 || Math.max(e.ob.hl, e.ob.hw) > Math.min(e.ob.hl, e.ob.hw) * 1.6) continue;
      slope++; if (Math.abs(gu) >= Math.abs(gn)) down++;
    }
    out.push({ name: `${c.id}: chalet roofs low, gables to the valley on slopes`, ok: chal.length > 2000 && steepC <= chal.length * 0.01 && slope > 300 && down >= slope * 0.85, why: `${chal.length} chalet gables, ${steepC} steeper than 0.48; on slopes ${down} of ${slope} with the ridge down the slope` });
    const wide = chal.filter((e) => e.roof === 1 && e.overMax > 1.9).length, stones = count((e) => e.stones && has(e, new Set([C.ROOF_STONES])));
    out.push({ name: `${c.id}: chalets' wide gable eaves, roofs weighted with stones`, ok: wide > 1000 && stones > 200, why: `${wide} chalets with eaves over 1.9 m at the corner, ${stones} stone roofs` });
    out.push({ name: `${c.id}: doors on the street, plinths, shop fronts in the towns`, ok: doors > 3000 && chDoor > 500 && plinths > 10000 && shops > 50, why: `${doors} buildings with a door on a street (${chDoor} chalets), ${plinths} on a plinth, ${shops} with shop fronts` });
  }
  if (c.loc === 'islands') {
    const houses = ents.filter((e) => (e.kind === 0 || e.kind === 7) && !e.wet && !e.tagged), tall = houses.filter((e) => e.walls > 3.7).length, ver = houses.filter((e) => e.porch).length;
    out.push({ name: `${c.id}: houses one storey, most with a veranda`, ok: houses.length > 1000 && !tall && ver > houses.length * 0.5, why: `${tall} of ${houses.length} untagged houses taller than a storey, ${ver} verandas` });
    const bung = ents.filter((e) => e.wet && e.rect * e.ob.hl * e.ob.hw * 4 < 600), // (the bigger ones over the water: restaurants, under metal)
      good = bung.filter((e) => { const m = cellsOf(e); return m.has(C.TIMBER_WIN) && m.has(C.THATCH) && m.has(C.DARKWOOD); }).length;
    out.push({ name: `${c.id}: overwater bungalows light timber under thatch, on stilts`, ok: bung.length > 100 && good === bung.length, why: `${good} of ${bung.length}` });
    // thatch: steep (rise / half span over 0.8), its eaves thatch: no white trim, no gutters (the metal cells)
    const th = ents.filter((e) => has(e, new Set([C.THATCH]))), shallow = th.filter((e) => e.roof !== 5 && e.pitch < 0.8 && e.rise < 5.4 && !e.tagged).length, trim = th.filter((e) => { const m = cellsOf(e); return !e.porch && (m.has(C.TRIM) || m.has(C.METAL)); }).length; // (a veranda's posts are white trim)
    out.push({ name: `${c.id}: thatch steep (or at the 5.5 m cap), its eaves thatch (no white fascia, no gutters)`, ok: th.length > 150 && !shallow && !trim, why: `${th.length} thatched, ${shallow} shallow, ${trim} with trim or gutters` });
    const metal = ents.filter((e) => !e.wet && (e.kind === 0 || e.kind === 7) && e.roof !== 0 && !has(e, new Set([C.THATCH]))), seam = metal.filter((e) => has(e, new Set([C.SEAM]))).length;
    out.push({ name: `${c.id}: the village's houses under corrugated metal`, ok: metal.length > 500 && seam === metal.length, why: `${seam} of ${metal.length}` });
  }
  if (c.loc === 'canyon') {
    const cab = ents.filter((e) => e.kind === 0 && !e.tagged), tall = cab.filter((e) => e.walls > 6.3).length;
    out.push({ name: `${c.id}: cabins and houses one or two storeys`, ok: cab.length > 300 && !tall, why: `${tall} of ${cab.length} untagged houses over two storeys` });
    const roofs = new Map(); for (const e of ents) for (const k of cellsOf(e).keys()) if (ROOF_CELLS.has(k)) roofs.set(k, (roofs.get(k) || 0) + 1);
    const other = [...roofs].filter(([k]) => k !== C.SEAM && k !== C.SHINGLE && k !== C.ROOF_GRAVEL);
    out.push({ name: `${c.id}: metal or shingle roofs`, ok: !other.length, why: other.map(([k, n]) => `cell ${k}: ${n}`).join(', ') });
    const lodge = count((e) => has(e, new Set([TIER.LODGE]))), log = count((e) => has(e, new Set([C.LOG_WIN, C.LOG]))), walk = count((e) => has(e, new Set([C.MOTEL_DOOR])) && has(e, new Set([C.RAIL_IRON])));
    out.push({ name: `${c.id}: stone-and-log lodges, log cabins, motels with walkways`, ok: lodge >= 3 && log > 100 && walk >= 3, why: `${lodge} lodges, ${log} log buildings, ${walk} motels with walkways` });
  }
  return out;
}

// New York's facades (realCity.js, Low): its streets' ground floors, read back from the skyline's meshes. Every wall
// with a ground floor reads its height above the floor from atl.z, which must interpolate true up it (no vertex past
// atl.z's range, else the ground floor slides up the wall), and no wall's uv may overflow a half float (a v of
// Infinity: NaN in the shader, a black frame through the bloom)
async function facadesNyc(c) {
  const { worldAt } = await import('./node/world.mjs'), { world } = await worldAt(c.loc), out = [];
  const n = { shop: 0, rust: 0, cornice: 0, door: 0, walls: 0 }; let clamped = 0, inf = 0, ex = '';
  for (const m of world.towns.city.tallMeshes) {
    const g = m.m.geometry, A = g.attributes.atl.array, U = g.attributes.uv.array, I = g.index.array;
    for (let i = 0; i < U.length; i++) if ((U[i] & 0x7c00) === 0x7c00) inf++;
    for (let k = 0; k + 5 < I.length; k += 3) {
      const a = I[k]; if (I[k + 1] !== a + 1 || I[k + 2] !== a + 2 || I[k + 3] !== a || I[k + 5] !== a + 3) continue; // (a wall: MeshW.wall's quad)
      const f = facadeSpec(A[a * 4]); if (!f) continue;
      n.walls++; if (f.ground === C.SHOPFRONT) n.shop++; if (f.ground === C.RUST) n.rust++; if (f.cornice) n.cornice++; if (f.door >= 0 || f.door2 >= 0) n.door++;
      if (f.gH > 0 && Math.min(A[I[k] * 4 + 2], A[I[k + 1] * 4 + 2]) < (20 + LY0) * LYS) for (const v of [I[k + 2], I[k + 5]]) if (A[v * 4 + 2] >= 255) { clamped++; ex ||= `program ${A[a * 4]} (gH ${f.gH})`; break; } // (a quad from near the ground up past the range: a tall wall's upper quad may go past it)
    }
  }
  out.push({ name: `${c.id}: shop fronts, rusticated bases, doors and cornices on the streets`, ok: n.shop > 2000 && n.rust > 2000 && n.cornice > 2000 && n.door > 5000, why: JSON.stringify(n) });
  out.push({ name: `${c.id}: ground-floor heights true up every wall (atl.z in range, ${-LY0} to ${255 / LYS - LY0} m)`, ok: !clamped, why: `${clamped} walls past it${ex ? `, e.g. ${ex}` : ''}` });
  out.push({ name: `${c.id}: no wall's uv overflows a half float`, ok: !inf, why: `${inf} infinite uv values` });
  return out;
}

// New York's roofs (realCity.js, Low): what the flat roofs got (CityScenery.roofStats), read back from the skyline
async function roofsNyc(c) {
  const { worldAt } = await import('./node/world.mjs'), { world } = await worldAt(c.loc), CS = world.towns.city, RS = CS.roofStats, out = [];
  const cells = RS.cells, total = Object.values(cells).reduce((a, b) => a + b, 0), share = (k) => (cells[k] || 0) / Math.max(1, total);
  out.push({ name: `${c.id}: flat roofs varied (membrane, tar, gravel, pavers; many colours)`, ok: total > 20000 && [C.ROOF_MEMBRANE, C.ROOF_TAR, C.ROOF_GRAVEL, C.PAVERS].every((k) => share(k) > 0.04) && RS.cols.size >= 12, why: `${total} roofs: ${Object.entries(cells).map(([k, n]) => `cell ${k} ${(n / total * 100).toFixed(0)}%`).join(', ')}; ${RS.cols.size} colours` });
  out.push({ name: `${c.id}: water tanks, bulkheads and plant rooms on the roofs, crowns on the towers`, ok: RS.tanks > 3000 && RS.bulkheads > 3000 && RS.plant > 2000 && RS.cake > 50 && RS.copper > 15 && RS.screen > 50, why: JSON.stringify({ tanks: RS.tanks, bulkheads: RS.bulkheads, plant: RS.plant, cake: RS.cake, copper: RS.copper, screen: RS.screen }) });
  // the furniture: indices after every building's (a draw range to main leaves it out), inside its building's footprint
  // box, and the tanks' staves wound outwards (their normals out from the tank's axis)
  let bad = 0, out0 = 0, wound = 0, staves = 0, ex = '';
  for (const g of CS.tallMeshes) {
    if (!(g.main <= g.all && g.lv.every((v) => v <= g.main))) { bad++; continue; }
    const G = g.m.geometry, P = G.attributes.position.array, A = G.attributes.atl.array, N = G.attributes.normal.array, I = G.index.array;
    const late = new Set(); for (let k = g.main; k < g.all; k++) late.add(I[k]);
    for (let k = 0; k < g.main; k++) if (A[I[k] * 4] === C.WTANK || A[I[k] * 4] === C.FRAME) { out0++; ex ||= `tank cell in the main range of a mesh`; break; }
    for (let k = g.main; k + 2 < g.all; k += 3) {
      const a = I[k]; if (A[a * 4] !== C.WTANK) continue;
      staves++;
      const ux = P[I[k + 1] * 3] - P[a * 3], uz = P[I[k + 1] * 3 + 2] - P[a * 3 + 2], vx = P[I[k + 2] * 3] - P[a * 3], vy = P[I[k + 2] * 3 + 1] - P[a * 3 + 1], vz = P[I[k + 2] * 3 + 2] - P[a * 3 + 2];
      const uy = P[I[k + 1] * 3 + 1] - P[a * 3 + 1], wx = uy * vz - uz * vy, wz = ux * vy - uy * vx; // (the winding's normal, horizontal part)
      if (wx * N[a * 3] + wz * N[a * 3 + 2] <= 0) wound++;
    }
  }
  out.push({ name: `${c.id}: roof furniture drawn last (indices after the buildings', a draw range leaves it out)`, ok: !bad && !out0, why: `${bad} meshes with ranges out of order, ${out0} with tank cells among the buildings' indices${ex ? ` (${ex})` : ''}` });
  out.push({ name: `${c.id}: every tank's staves wound the way their normals point (outwards)`, ok: staves > 1000 && !wound, why: `${wound} of ${staves} stave triangles wound inwards` });
  return out;
}

export async function runCase(c) {
  if (c.id.startsWith('roofs')) return roofsNyc(c);
  if (c.id === 'kit') return kit();
  if (c.id.startsWith('facades')) return facadesNyc(c);
  if (c.id.startsWith('rules')) return rules(c);
  if (c.id.startsWith('decks')) return decks(c);
  return stylesCase(c);
}
