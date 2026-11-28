// The baked road layout's chunks (#294; assets/real/<id>/layout/, tools/bake/layout.mjs), checked as committed: each
// meshes (src/layout/mesh.js, fine and coarse, against the place's hi grid) with every fixed edge taken and the chunk
// covered; its file is named by its bytes; on the tarmac physics is what's drawn; a kerb is never physics; and two
// chunks side by side share their edge exactly, at every pair of levels. No World is built: the files and the hi grid, shaped as the
// World's terrain base (rules.js groundNode: World.rawHeight's airport and shoreSnap, on a stand-in World; the stunt sites'
// pads and the far square's blend are left out: neither reaches a sample chunk).
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeLayout, KIND } from '../../src/layout/format.js';
import { meshChunk, latticeOf, physIndex } from '../../src/layout/mesh.js';
import { offChecks } from '../bake/layout-off.mjs';
import { KERB, latticeHeights, makeRules, latticeGround } from '../../src/layout/rules.js';
import { World, LOCATIONS } from '../../src/world.js';
import { airportGate } from '../../src/airportKit.js';

export const nodeSuite = { files: ['src/layout/format.js', 'src/layout/mesh.js', 'src/layout/rules.js', 'src/layout/outline.js', 'src/layout/bake.js', 'tools/bake/layout-off.mjs', 'tools/bake/groundcheck.mjs', 'tools/test/layoutcheck.js', 'assets/real/nyc/layout/index.json', 'assets/real/lauterbrunnen/layout/index.json', 'assets/real/canyon/layout/index.json', 'assets/real/islands/layout/index.json'] };
const PLACES = ['nyc', 'lauterbrunnen', 'canyon', 'islands'], SHORE = new Set(['islands']); // (SHORE: the places on the sea, realworld.js loc.shore: the layout's shore rules at meta.json's water level)
export function cases() { return PLACES.filter((p) => existsSync(`assets/real/${p}/layout/index.json`)).map((place) => ({ id: `${place} layout`, place, cost: 1 })); }

function hiGrid(id) { // the hi grid as realworld.js decodes it: uint16 (h + 200) * 8, each row delta-coded
  const m = JSON.parse(readFileSync(`assets/real/${id}/meta.json`)), { x0, z0, size, n } = m.hi, b = gunzipSync(readFileSync(`assets/real/${id}/hi.bin.gz`)), u = new Uint16Array(b.buffer, b.byteOffset, n * n), H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) { let v = 0; for (let i = 0; i < n; i++) { v = i ? (v + u[j * n + i]) & 65535 : u[j * n]; H[j * n + i] = v / 8 - 200; } }
  const sp = size / (n - 1), loc = LOCATIONS[id], height = (x, z) => { const fx = Math.max(0, Math.min(n - 1.0001, (x - x0) / sp)), fz = Math.max(0, Math.min(n - 1.0001, (z - z0) / sp)), i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * n + i; return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v; }; // (realworld.js sampleH)
  const w = { loc, gate: airportGate(loc), stuntPlan: null, waterLevel: loc.water, height, rawHeight: World.prototype.rawHeight, shoreSnap: World.prototype.shoreSnap }; // (a stand-in World: its terrain base)
  return { x0, z0, n, sp, H, water: m.water, w };
}

export async function runCase(c) {
  const dir = `assets/real/${c.place}/layout/`, idx = JSON.parse(readFileSync(dir + 'index.json', 'utf8')), G = hiGrid(c.place), out = [], meshes = new Map();
  // (a sample: the first test chunks, side by side, and Lauterbrunnen's; every chunk is checked by the bake, tools/bake/layout.mjs)
  const SAMPLE = new Set(['-7,25', '-6,25', '-4,-3', '16,8', '16,9', '4,-13', '4,-12', '-19,-16', '-18,-16', '-15,-1', '-14,-1', '11,-12', '12,-12', '11,-9', '-1,-14', '-20,-8', '-3,4']); // (Lauterbrunnen: a town; the village beside a bridge's chunk; switchbacks on a valley wall. The canyon: Grand Canyon Village on the rim; a street's hairpin on a slope. Bridges and tunnels: New York's decks over ground and over the water; Lauterbrunnen's mountain tunnel and bridge. Bora Bora: the ring road at the shore; Vaitape beside the marina's chunk)
  for (const e of idx.chunks.filter((e) => SAMPLE.has(e.ix + ',' + e.iz))) {
    const gz = readFileSync(dir + e.file), name = `${c.place} ${e.ix},${e.iz}`, buf = gunzipSync(gz), L = decodeLayout(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    out.push({ name: `${name}: its file is named by its bytes`, ok: e.file === `${e.ix}_${e.iz}.${createHash('sha256').update(gz).digest('hex').slice(0, 10)}.bin.gz`, why: e.file });
    const grid = { x0: G.x0, z0: G.z0, sp: G.sp, wl: SHORE.has(c.place) ? G.water : -Infinity }, lat = latticeHeights(G.w, grid, latticeOf(L, grid));
    const ms = {}; for (const level of ['fine', 'coarse']) ms[level] = meshChunk(L, grid, lat, level);
    meshes.set(e.ix + ',' + e.iz, ms);
    for (const level of ['fine', 'coarse']) { const s = ms[level].stats; out.push({ name: `${name}: meshes (${level}) with every fixed edge and the chunk covered`, ok: s.failed === 0 && Math.abs(s.covered - 1) < 1e-6, why: `${s.failed} of ${s.fixed + s.failed} fixed edges failed, ${(s.covered * 100).toFixed(4)}% covered, ${s.tris} triangles in ${s.totalMs.toFixed(0)} ms` }); }
    // on the tarmac physics is what's drawn; across a kerb physics has no step (it ramps under the slabs)
    const m = ms.fine, I = m.idx, P = m.pos, Y = m.phys; let off = 0, step = 0, kerbTris = 0, kerbMeasured = 0; // step: the steepest physics slope on a kerb
    for (let q = 0; q < m.tk.length; q++) { const v = [I[q * 3], I[q * 3 + 1], I[q * 3 + 2]];
      if (m.tk[q] === KIND.tarmac) for (const k of v) if (Math.abs(Y[k] - P[k * 3 + 1]) > 1e-4) off++;
      if (m.tk[q] === KIND.kerb) kerbTris++;
      if (m.tk[q] === KIND.kerb) for (let r = 0; r < 3; r++) { // (the steepest physics rise along an edge of the kerb's strip: a 15 cm step over its 10 cm would be ~1.5; a plane through a sliver's three corners says nothing)
        const u = v[r], w = v[(r + 1) % 3], l = Math.hypot(P[u * 3] - P[w * 3], P[u * 3 + 2] - P[w * 3 + 2]); const top = (q) => P[q * 3 + 1] - Y[q] > 0.1, gut = (q) => Math.abs(P[q * 3 + 1] - Y[q]) < 1e-4; if (l < 0.5 && ((top(u) && gut(w)) || (top(w) && gut(u)))) { kerbMeasured++; const t = top(u) ? u : w, g = t === u ? w : u; step = Math.max(step, Math.abs((Y[t] - Y[g]) - (P[t * 3 + 1] - KERB - P[g * 3 + 1]))); } } } // (across the kerb, a gutter's point to a top's: how far physics rises past the surface the kerb stands on (drawn less the kerb), as tools/bake/layout-check.mjs: the surface's own slope isn't the kerb)
    out.push({ name: `${name}: on the tarmac physics is what's drawn`, ok: off === 0, why: `${off} tarmac corners off` });
    out.push({ name: `${name}: a kerb is never physics`, ok: step <= 0.05 && (!kerbTris || kerbMeasured >= kerbTris / 2), why: `largest physics rise across a kerb ${step.toFixed(3)} m (drawn 0.15); ${kerbMeasured} kerb edges stand over physics, of ${kerbTris} kerb triangles (kerbs in physics: none would)` });
    // bridges and tunnels: no step where a road meets a deck or a portal; a portal's opening rimmed by its tube and headwall
    const lip = []; for (let q = 0; q < m.tk.length; q++) if (m.tk[q] === KIND.lip) lip.push(I[q * 3], I[q * 3 + 1], I[q * 3 + 2]);
    const oc = offChecks(L, m, physIndex(L, m), lip, { rules: makeRules(L.net, latticeGround(grid, latticeOf(L, grid), lat), !!L.city, grid.wl) }), all = [...oc.ends.deck, ...oc.ends.tube];
    if (all.length || oc.portals) out.push({ name: `${name}: roads meet their decks and portals without a step, each portal opens onto its tube`, ok: all.every((d) => d < 0.02) && !oc.rimBad && !oc.noLip && !oc.slabBad && !oc.coverBad, why: `${oc.ends.deck.length} deck ends, ${oc.ends.tube.length} portal ends, largest step ${Math.max(0, ...all).toFixed(4)} m; ${oc.portals} portals, ${oc.rimBad} of ${oc.rimN} rim points uncovered, ${oc.noLip} with no opening; over tubes ${oc.slabBad} of ${oc.slabN} points raised, ${oc.coverBad} of ${oc.coverN} stations without cover` });
  }
  // chunks side by side: the shared edge's segments, positions and heights, the same from both sides at every pair of levels
  for (const e of idx.chunks.filter((e) => meshes.has(e.ix + ',' + e.iz))) { const b = meshes.get(e.ix + 1 + ',' + e.iz), a = meshes.get(e.ix + ',' + e.iz); if (!b) continue;
    const X = (e.ix + 1) * idx.size, segs = (m) => { const s = new Set(), P = m.pos, I = m.idx; for (let q = 0; q < I.length; q += 3) for (let r = 0; r < 3; r++) { const u = I[q + r], v = I[q + (r + 1) % 3]; if (P[u * 3] === X && P[v * 3] === X) s.add([[P[u * 3 + 2], P[u * 3 + 1]], [P[v * 3 + 2], P[v * 3 + 1]]].sort((p, q) => p[0] - q[0]).join('|')); } return s; };
    for (const [la, lb] of [['fine', 'fine'], ['fine', 'coarse'], ['coarse', 'fine']]) { const A = segs(a[la]), B = segs(b[lb]), miss = [...A].filter((k) => !B.has(k)).length + [...B].filter((k) => !A.has(k)).length;
      out.push({ name: `${c.place} ${e.ix},${e.iz} | ${e.ix + 1},${e.iz}: their edge meets (${la} | ${lb})`, ok: A.size > 0 && miss === 0, why: `${A.size} and ${B.size} segments, ${miss} unmatched` }); }
  }
  return out;
}
