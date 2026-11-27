// Bakes the road layout's chunks (#294; src/layout/bake.js) on this machine and writes them under
// assets/real/<id>/layout/ (committed: nothing is baked on a runner). Deterministic: the same code and data give the
// same bytes (no times or randomness; gzip without a timestamp), so a re-bake with nothing changed changes no file.
//
// Every place, its checks and the setbacks overlay in one go, with a summary (and --verify: "no diff"): tools/bake/all.mjs.
//
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs nyc:all
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs lauterbrunnen:-4,-3 nyc:-7,25:-6,25
//     (place:all: every CHUNK-metre square with roads; or place:ix,iz[:ix,iz...]. A place's chunks are baked together:
//     one height solve)
// A chunk that fails a check isn't baked: it keeps today's roads,
// listed in the index's fallback with why. Every baked chunk is checked the game's way (layout-check.mjs, on a worker
// per core): fixed edges, cover, holes, tarmac drawn - physics, kerbs not physics, the markings on their street's centre
// line (markcheck.mjs: within DRIFT_MAX), and each shared edge between two baked chunks, at every pair of levels. Writes each chunk as <ix>_<iz>.<hash>.bin.gz (hash: of its bytes) and the
// place's index.json; removes the files the new index no longer names.
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { worldAt } from '../test/node/world.mjs';
import { bakeLayout } from '../../src/layout/bake.js';
import { CHUNK, LAYOUT_V, decodeLayout } from '../../src/layout/format.js';
import { latticeOf } from '../../src/layout/mesh.js';
import { groundGrid, latticeHeights } from '../../src/layout/rules.js';
import { DRIFT_MAX } from './markcheck.mjs';
import { groundOf, mergeGround } from './groundcheck.mjs';
import { onWorkers, workers } from './pool.mjs';

const key = (ix, iz) => ix + ',' + iz;
if (import.meta.url === pathToFileURL(process.argv[1]).href) { // (run as a script; all.mjs calls bakePlace)
  const args = process.argv.slice(2);
  if (!args.length) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(1); }
  for (const a of args) await bakePlace(a);
  process.exit(process.exitCode || 0);
}
// one place's bake (a: 'place:all' or 'place:ix,iz[:...]'); world: its World if it's built already; asks: Map('ix,iz' ->
// Float64Array x, z, ...): points whose height on the chunk's fine mesh the checks give back (setbacks.mjs tallCorners).
// -> a summary for all.mjs (heights: the asks' answers in the chunks that passed)
export async function bakePlace(a, world, asks) {
  const [id, ...cs] = a.split(':'), t0 = performance.now();
  world ||= (await worldAt(id)).world; const tb = performance.now();
  // ---- which chunks: every one with roads (or those asked for); the airport's roads keep it today's
  const roads = world.net.roads.filter((rd) => rd.kind !== 'rail'), seen = new Map(), why = new Map(), bt = new Map();
  for (const rd of roads) { const P = rd.pts; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[Math.min(i + 1, P.length - 1)], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 10));
    for (let s = 0; s < n; s++) { const x = p.x + (q.x - p.x) * s / n, z = p.z + (q.z - p.z) * s / n, k = key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)); seen.set(k, (seen.get(k) || 0) + Math.hypot(q.x - p.x, q.z - p.z) / n);
      const b = rd.baked ? 'bridge' : rd.bridge?.[i] || rd.bridge?.[i + 1] || rd.span?.[i] || rd.span?.[i + 1] ? 'bridge' : rd.tube?.[i] || rd.tube?.[i + 1] ? 'tunnel' : null; if (b) (bt.get(k) || bt.set(k, new Set()).get(k)).add(b); } } } // (bt: the chunks with a bridge or a tunnel: baked, their decks and tubes today's (roads.js) at the layout's heights)
  const wanted = cs[0] === 'all' ? [...seen.keys()] : cs.map((c) => c.split(',').map(Number).join(','));
  // (every chunk with roads is baked: the airport's ground, the stunt sites' pads and the land past the World's core are
  // all in the natural ground (rules.js groundNode: World.rawHeight); the marina's and water park's docks are their own
  // solid meshes (World.surfs) over it)
  const fallback = new Map(), chunks = [];
  for (const k of wanted) { if (why.has(k)) fallback.set(k, [...why.get(k)].sort().join('+')); else if (seen.has(k)) chunks.push(k.split(',').map(Number)); }
  console.log(`${id}: ${wanted.length} chunks with roads; ${chunks.length} to bake, ${fallback.size} keep today's roads (${count([...fallback.values()])})`);
  // ---- the bake (one height solve for them all)
  const r = bakeLayout(world, chunks, (...m) => { if (!/^\s+\[layout\]\s{3}/.test(m[0])) console.log(...m); }), tc = performance.now();
  // ---- the checks, the game's way, a worker per core
  const grid = groundGrid(world), jobs = r.chunks.map(({ ix, iz, bytes }) => { const G = latticeHeights(world, grid, latticeOf({ x0: ix * CHUNK, z0: iz * CHUNK, size: CHUNK }, grid)); // (the natural ground as the runtime's: Layout.lattice)
    return { ix, iz, buf: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), G, Q: asks?.get(key(ix, iz)) }; }); // (Q: points to give the fine mesh's height at, for setbacks.mjs)
  const N = workers(jobs.length), checking = onWorkers(new URL('./layout-check.mjs', import.meta.url), jobs, { grid }, N);
  // (meanwhile, here: each chunk's ground against today's terrain base, groundcheck.mjs; reported for those that pass)
  const gbOf = new Map(r.chunks.map(({ ix, iz, bytes }, q) => [key(ix, iz), groundOf(world, decodeLayout(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), grid, jobs[q].G)]));
  const tg = performance.now(), results = await checking;
  const td = performance.now(), byKey = new Map(results.map((c) => [key(c.ix, c.iz), c])), sum = (f) => results.reduce((n, c) => n + (f(c) || 0), 0);
  // a chunk failing a check keeps today's roads
  const failed = new Map();
  for (const c of results) { const f = c.fine, co = c.coarse, bad = [];
    if (f.failed || co.failed) bad.push('fixed edges'); if (Math.abs(f.covered - 1) > 1e-6 || Math.abs(co.covered - 1) > 1e-6) bad.push('cover'); if (f.holes) bad.push('holes'); if (f.tarmacOff > 1e-4) bad.push('tarmac off physics'); if (f.kerbSlope > 0.05) bad.push('kerb in physics'); if (f.drift > DRIFT_MAX) bad.push('markings off the centre line'); if (f.deckBad) bad.push('deck step'); if (f.portalBad) bad.push('portal step'); if (f.rimBad || f.noLip) bad.push('portal gap');
    if (bad.length) failed.set(key(c.ix, c.iz), bad.join('+')); }
  // shared edges between two baked chunks: the same points and heights from both sides, at every pair of levels
  let pairs = 0, seamBad = 0; const seamList = [];
  for (const c of results) for (const [dx, dz, mine, theirs] of [[1, 0, 'e', 'w'], [0, 1, 'n', 's']]) { const o = byKey.get(key(c.ix + dx, c.iz + dz)); if (!o || failed.has(key(c.ix, c.iz)) || failed.has(key(o.ix, o.iz))) continue; pairs++; // (between two that pass: one that fails keeps today's roads, a skirt between)
    const bad = [['fine', 'fine'], ['fine', 'coarse'], ['coarse', 'fine']].filter(([la, lb]) => c.edges[la][mine].join() !== o.edges[lb][theirs].join()); if (bad.length) { seamBad++; seamList.push(`${key(c.ix, c.iz)}|${key(o.ix, o.iz)}`); } }
  const failedOnChecks = failed.size;
  for (const pr of seamList) for (const k of pr.split('|')) if (!failed.has(k)) failed.set(k, 'seam'); // (a shared edge that doesn't match: both keep today's roads, skirts between)
  for (const [k, w] of failed) fallback.set(k, 'failed: ' + w);
  // ---- files
  const dir = `assets/real/${id}/layout/`; mkdirSync(dir, { recursive: true });
  const prev = (() => { try { return JSON.parse(readFileSync(dir + 'index.json', 'utf8')); } catch { return { chunks: [] }; } })(), keep = new Map(cs[0] === 'all' ? [] : prev.chunks.map((c) => [key(c.ix, c.iz), c]));
  let bytesAll = 0, lenAll = 0;
  for (const { ix, iz, bytes: raw } of r.chunks) { const k = key(ix, iz); if (failed.has(k)) { keep.delete(k); if (process.env.LAYOUT_DUMP) writeFileSync(`${process.env.LAYOUT_DUMP}/${ix}_${iz}.bin`, raw); continue; } // (LAYOUT_DUMP=dir: the failing chunks' bytes, to look at)
    const bytes = gzipSync(raw, { level: 9 }), file = `${ix}_${iz}.${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}.bin.gz`; writeFileSync(dir + file, bytes); keep.set(k, { ix, iz, file }); bytesAll += bytes.length; lenAll += seen.get(k) || 0; }
  const chunksOut = [...keep.values()].sort((p, q) => p.ix - q.ix || p.iz - q.iz), fb = [...fallback].map(([k, w]) => { const [ix, iz] = k.split(',').map(Number); return { ix, iz, why: w }; }).sort((p, q) => p.ix - q.ix || p.iz - q.iz);
  writeFileSync(dir + 'index.json', JSON.stringify({ v: LAYOUT_V, size: CHUNK, chunks: chunksOut, fallback: fb }) + '\n');
  for (const f of readdirSync(dir)) if (f.endsWith('.bin.gz') && !chunksOut.some((c) => c.file === f)) unlinkSync(dir + f);
  // ---- the report
  const st = (f) => { const v = results.map(f).sort((p, q) => p - q); return `p50 ${v[v.length >> 1].toFixed(0)}, p90 ${v[Math.floor(v.length * 0.9)].toFixed(0)}, max ${v[v.length - 1].toFixed(0)}`; };
  console.log(`${id}: ${chunksOut.length} chunk files, ${(bytesAll / 1e6).toFixed(2)} MB (${(bytesAll / lenAll).toFixed(2)} bytes/m of road over ${(lenAll / 1000).toFixed(0)} km); fallback ${fallback.size}: ${count([...fallback.values()])}`);
  console.log(`  checks: ${results.length} chunks; failed ${failed.size} (${count([...failed.values()])}); holes ${results.reduce((s, c) => s + c.fine.holes, 0)} of ${results.reduce((s, c) => s + c.fine.samples, 0)} samples; tarmac drawn - physics max ${Math.max(...results.map((c) => c.fine.tarmacOff)).toFixed(4)} m; kerb physics rise max ${Math.max(...results.map((c) => c.fine.kerbSlope)).toFixed(3)} m (drawn 0.15); markings off the centre line max ${Math.max(...results.map((c) => c.fine.drift)).toFixed(4)} m (fails over ${DRIFT_MAX}) over ${sum((c) => c.fine.driftSamples)} samples, ${sum((c) => c.fine.lost)} lost to another street's triangle; crossings whole ${sum((c) => c.fine.whole)}/${sum((c) => c.fine.mouths)} mouths (${sum((c) => c.fine.tight)} too close to another junction); slabs' across off the kerb max ${Math.max(...results.map((c) => c.fine.kerbErr)).toFixed(3)} m; bends' bisectors left soft ${sum((c) => c.fine.bendMissed)}; seams ${pairs - seamBad}/${pairs} match${seamBad ? ' (' + seamList.slice(0, 10).join(' ') + ')' : ''}`);
  { const S = (k) => results.reduce((n, c) => n + c.fine.shore[k], 0); if (grid.wl > -Infinity) console.log(`  shore (water level ${grid.wl}): ground pushed below the water by banks ${S('under')}; ground raised in the water ${S('raised')}; paved points below the water ${S('pavedWet')}; bank points the shore rule changed ${S('limited')} in ${results.filter((c) => c.fine.shore.limited).length} chunks`);  const ex = results.flatMap((c) => c.fine.shore.ex); if (ex.length) console.log('    e.g.', JSON.stringify(ex.slice(0, 16))); }
  { const W = {}; for (const c of results) for (const [k, n] of Object.entries(c.fine.why || {})) W[k] = (W[k] || 0) + n; if (Object.keys(W).length) console.log('  fixed edges failed, by what and why:', JSON.stringify(W)); }
  { const btc = new Map(); for (const [k, v] of bt) btc.set([...v].sort().join('+'), (btc.get([...v].sort().join('+')) || 0) + 1); const sum = (f) => results.reduce((n, c) => n + (c.fine[f] || 0), 0), mx = (f) => Math.max(0, ...results.map((c) => c.fine[f] || 0));
    console.log(`  bridges and tunnels: chunks with one ${JSON.stringify(Object.fromEntries(btc))}, baked ${[...bt.keys()].filter((k) => keep.has(k) && !fallback.has(k)).length}; deck ends ${sum('deckEnds')} (step max ${mx('deckGap').toFixed(4)} m, ${sum('deckBad')} >= 2 cm); portals ${sum('portals')} (approach step max ${mx('portalGap').toFixed(4)} m over ${sum('portalEnds')}, ${sum('portalBad')} >= 2 cm; lip rim points ${sum('rimN')}, outside the tube or headwall ${sum('rimBad')}; portals with no opening ${sum('noLip')})`); }
  { const B = results.filter((c) => c.badAt).flatMap((c) => c.badAt); if (B.length) console.log('  steps at decks and portals (>= 2 cm):', JSON.stringify(B.slice(0, 12))); }
  console.log(`  kerb top lines left soft (would cross another line): ${results.reduce((n, c) => n + (c.fine.softMissed || 0), 0)} segments in ${results.filter((c) => c.fine.softMissed).length} chunks`);
  console.log(`  mesh ms fine ${st((c) => c.fine.ms)} (outlines ${st((c) => c.fine.outlineMs)}); coarse ${st((c) => c.coarse.ms)}; triangles fine ${st((c) => c.fine.tris)}`);
  const tf = performance.now(); console.log(`  wall: World ${((tb - t0) / 1000).toFixed(1)} s, bake ${((tc - tb) / 1000).toFixed(1)} s, checks ${((td - tc) / 1000).toFixed(1)} s on ${N} workers, files ${((tf - td) / 1000).toFixed(1)} s`, JSON.stringify(r.stats.solve), JSON.stringify(r.stats.inChunk), JSON.stringify(r.stats.overGrade));
  console.log('  furthest from the ground, in the chunks:', JSON.stringify(r.stats.worstIn));
  { const gb = mergeGround(r.chunks.filter(({ ix, iz }) => !failed.has(key(ix, iz))).map(({ ix, iz }) => gbOf.get(key(ix, iz))));
    const f = (s) => `max ${s.max} m, p99 ${s.p99} m over ${s.n} (worst ${JSON.stringify(s.worst)})`; console.log(`  ground vs today's terrain base outside the banks: at the hi grid's points ${f(gb.nodes)}; every 10 m ${f(gb.pts)}`); }
  const te = performance.now(); console.log(`  ground vs base ${((tg - tc) / 1000 + (te - tf) / 1000).toFixed(1)} s (beside the checks); ${id} in all ${((te - t0) / 1000).toFixed(1)} s`);
  return { id, world, chunks: chunksOut.length, fallback: fallback.size, failed: failed.size, failedOnChecks, seams: `${pairs - seamBad}/${pairs}`, holes: results.reduce((s, c) => s + c.fine.holes, 0), mb: bytesAll / 1e6,
    heights: new Map(results.filter((c) => c.H && !failed.has(key(c.ix, c.iz))).map((c) => [key(c.ix, c.iz), c.H])),
    s: { world: (tb - t0) / 1000, bake: (tc - tb) / 1000, checks: (td - tc) / 1000, files: (tf - td) / 1000, ground: (tg - tc) / 1000 + (te - tf) / 1000, all: (te - t0) / 1000 } };
}
function count(list) { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return [...m].map(([k, n]) => `${n} ${k}`).join(', '); }
