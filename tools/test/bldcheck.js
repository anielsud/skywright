// Buildings (Node suite): the geometry the towns' building kit writes (src/buildings.js Builder) and the real places'
// buildings made with it (src/realBuildings.js), read back from the built meshes.
//  - kit: the atlas cells (unique, inside the 8 x 8 atlas, the cut-stone window cells have their window rects); every
//    face Builder.obox writes faces out of the box (its top up: the bungalow decks and pier decks), whatever the axis
//  - decks (Bora Bora): every overwater bungalow deck and pier deck (BOARDS, flat, at deck height) faces up, and every
//    triangle of the buildings is wound the way its normal points (front faces are the ones drawn)
//  - styles (Bora Bora, Lauterbrunnen): the same building gets the same walls, colours and roof at Low and at High (Low
//    leaves the small ones out: the others' styles must not depend on that); each building's vertices are one run of
//    its chunk (destruction.js), with High's gutters and downpipes inside it
import * as THREE from 'three';
import { Builder, C, WINDOW_RECTS } from '../../src/buildings.js';

export const nodeSuite = { files: ['src/buildings.js', 'src/realBuildings.js', 'tools/test/bldcheck.js'] };

export function cases() {
  return [
    { id: 'kit', cost: 0.1 },
    { id: 'decks islands', loc: 'islands', world: 'islands', cost: 3 },
    { id: 'styles islands', loc: 'islands', cost: 8 },
    { id: 'styles lauterbrunnen', loc: 'lauterbrunnen', cost: 12 },
  ];
}

const DECK = 1.7; // (realBuildings.js)
// the gutter and downpipe tints (buildings.js _gutters) as Builder stores them (linear, 8 bit)
const GUTTER = new Set([0x8a8a84, 0x7a7a74].map((h) => { const c = new THREE.Color(h); return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255); }));

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
    for (let i = s; i < s + cnt; i++) { const col = (Cl[i * 3] << 16) | (Cl[i * 3 + 1] << 8) | Cl[i * 3 + 2]; if (A[i * 4] === C.METAL && GUTTER.has(col)) continue; set.add(A[i * 4] * 16777216 + col); }
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

export async function runCase(c) {
  if (c.id === 'kit') return kit();
  if (c.id.startsWith('decks')) return decks(c);
  return stylesCase(c);
}
