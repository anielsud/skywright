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
import * as THREE from 'three';
import { Builder, C, WINDOW_RECTS, TIER, tierCells } from '../../src/buildings.js';

export const nodeSuite = { files: ['src/buildings.js', 'src/realBuildings.js', 'tools/test/bldcheck.js'] };

export function cases() {
  return [
    { id: 'kit', cost: 0.1 },
    { id: 'decks islands', loc: 'islands', world: 'islands', cost: 3 },
    { id: 'styles islands', loc: 'islands', cost: 8 },
    { id: 'styles lauterbrunnen', loc: 'lauterbrunnen', cost: 12 },
    { id: 'rules islands', loc: 'islands', world: 'islands', cost: 3 },
    { id: 'rules canyon', loc: 'canyon', world: 'canyon', cost: 3 },
    { id: 'rules lauterbrunnen', loc: 'lauterbrunnen', world: 'lauterbrunnen', cost: 10 },
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
  const miss = ['LIME_WIN', 'BROWN_WIN'].filter((k) => !WINDOW_RECTS[C[k]]);
  out.push({ name: 'kit: cut-stone window cells have window rects', ok: !miss.length, why: miss.join(', ') });
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
    const key = `${e.ob.x.toFixed(1)},${e.ob.z.toFixed(1)},${e.ob.hl.toFixed(1)},${e.ob.hw.toFixed(1)}`;
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
const ROOF_CELLS = new Set([C.TILES, C.DARKTILE, C.SLATE, C.SHINGLE, C.SEAM, C.THATCH, C.ROOF_GRAVEL]);
const FLOWERS = new Set([C.WOOD_WIN, C.WOOD_WIN2, TIER.CHALET]); // (the chalet timber cells, with their geranium boxes)

// each place's own rules, from the buildings as built (Low)
async function rules(c) {
  const { worldAt } = await import('./node/world.mjs'), { world } = await worldAt(c.loc), T = world.towns, out = [];
  const ents = []; for (const a of T.grid.values()) for (const e of a) if (e.rng && e.ob) ents.push(e);
  const cellsOf = (e) => { const [B, s, n] = e.rng[0], A = B.geo.attributes.atl.array, m = new Map(); for (let i = s; i < s + n; i++) m.set(A[i * 4], (m.get(A[i * 4]) || 0) + 1); return m; };
  const has = (e, set) => [...cellsOf(e).keys()].some((k) => set.has(k));
  const count = (pred) => ents.filter(pred).length;
  // no roof over an empty corner: every roof vertex within the eave of the footprint (a chalet's 1.1 m, 1.6 m at a
  // corner, and 0.6 m of slack), porches and
  // walkways, the bungalows' decks and a church's spire left out)
  let over = 0, worst = 0, ex = '';
  for (const e of ents) {
    if (e.roof === 0 || e.porch || e.wet || !e.fp) continue;
    const [B, s, n] = e.rng[0], g = B.geo, P = g.attributes.position.array, A = g.attributes.atl.array, N = g.attributes.normal.array;
    let m = 0; for (let i = s; i < s + n; i++) if (ROOF_CELLS.has(A[i * 4]) && N[i * 3 + 1] > 30) m = Math.max(m, outside(e.fp, P[i * 3], P[i * 3 + 2]));
    if (m > 2.2) { over++; if (m > worst) { worst = m; ex = `a kind ${e.kind} building at ${e[0].toFixed(0)}, ${e[2].toFixed(0)} (roof ${e.roof}, rect ${e.rect.toFixed(2)})`; } }
  }
  out.push({ name: `${c.id}: no roof reaches over a footprint's empty corners`, ok: !over, why: `${over} roofs reach over 2.2 m past their walls${over ? `, worst ${worst.toFixed(1)} m: ${ex}` : ''}` });
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
  }
  if (c.loc === 'islands') {
    const houses = ents.filter((e) => (e.kind === 0 || e.kind === 7) && !e.wet && !e.tagged), tall = houses.filter((e) => e.walls > 3.7).length, ver = houses.filter((e) => e.porch).length;
    out.push({ name: `${c.id}: houses one storey, most with a veranda`, ok: houses.length > 1000 && !tall && ver > houses.length * 0.5, why: `${tall} of ${houses.length} untagged houses taller than a storey, ${ver} verandas` });
    const bung = ents.filter((e) => e.wet && e.rect * e.ob.hl * e.ob.hw * 4 < 600), // (the bigger ones over the water: restaurants, under metal)
      good = bung.filter((e) => { const m = cellsOf(e); return m.has(C.TIMBER_WIN) && m.has(C.THATCH) && m.has(C.DARKWOOD); }).length;
    out.push({ name: `${c.id}: overwater bungalows light timber under thatch, on stilts`, ok: bung.length > 100 && good === bung.length, why: `${good} of ${bung.length}` });
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

export async function runCase(c) {
  if (c.id === 'kit') return kit();
  if (c.id.startsWith('rules')) return rules(c);
  if (c.id.startsWith('decks')) return decks(c);
  return stylesCase(c);
}
