// Bakes the road layout's chunks (#294; src/layout/bake.js) on this machine and writes them under
// assets/real/<id>/layout/ (committed: nothing is baked on a runner). Deterministic: the same code and data give the
// same bytes (no times or randomness; gzip without a timestamp), so a re-bake with nothing changed changes no file.
//
// Every place, its checks and the setbacks overlay in one go, with a summary (and --verify: "no diff"): tools/bake/all.mjs.
//
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs nyc:all
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs lauterbrunnen:-4,-3 nyc:-7,25:-6,25
//     (place:all: every CHUNK-metre square of the layout's extent: the World's core and every one with roads, closed and
//     with no holes (extentOf); a chunk with nothing of the network in reach is only ground: no file, listed in the index's
//     `ground` (format.js groundBytes); or place:ix,iz[:ix,iz...]. A place's chunks are baked together:
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
import { CHUNK, LAYOUT_V, decodeLayout, indexChunks, withEdge } from '../../src/layout/format.js';
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
// one place's bake (a: 'place:all' or 'place:ix,iz[:...]'); world: its World if it's built already; asksOf(world) ->
// Map('ix,iz' -> Float64Array x, z, ...): points whose height on the chunk's fine mesh the checks give back (setbacks.mjs
// tallCorners); cache: cache.mjs openCache's, for a whole place (place:all): the solve and each chunk's checks given back
// when their inputs haven't changed (the World is then built only if a later step needs it: the summary's world()).
// -> a summary for all.mjs (heights: the asks' answers in the chunks that passed)
export async function bakePlace(a, world, asksOf, cache) {
  const [id, ...cs] = a.split(':'), t0 = performance.now(), C = cs[0] === 'all' ? cache : null;
  const W = async () => (world ||= (await worldAt(id)).world);
  // ---- the solve: the World, which chunks, the height solve, each chunk's ground lattice (or all that from the cache)
  const hit = C?.get(`${id}/solve`, a); let P = hit?.value, solveKey = hit?.key;
  if (!P) { await W(); P = await solvePlace(id, cs, world, asksOf, performance.now()); if (C) solveKey = C.put(`${id}/solve`, C.traced(), a, P); }
  const { seen, bt, extent, extra, fallback, r, grid, G: Gs, asks } = P, tb = hit ? t0 : P.tb;
  const tc = performance.now();
  // ---- the checks, the game's way, a worker per core (a chunk whose inputs haven't changed: its last result)
  const jobs = r.chunks.map(({ ix, iz, bytes }, q) => ({ ix, iz, buf: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), G: Gs[q], Q: asks?.get(key(ix, iz)) })); // (Q: points to give the fine mesh's height at, for setbacks.mjs)
  const code = C && C.stamp(C.importsOf(new URL('./layout-check.mjs', import.meta.url))), gridKey = C && C.hash(JSON.stringify(grid)), ckey = C ? jobs.map((j) => C.hash(key(j.ix, j.iz), new Uint8Array(j.buf), j.G, j.Q || '', gridKey, code)) : [];
  const old = C ? jobs.map((j, q) => C.getK(id + '/chunks', ckey[q])) : [], todo = jobs.filter((j, q) => !old[q]);
  const N = workers(todo.length), checking = todo.length ? onWorkers(new URL('./layout-check.mjs', import.meta.url), todo, { grid }, N) : Promise.resolve([]);
  // (meanwhile, here, if the World is built: each chunk's ground against today's terrain base, groundcheck.mjs; reported
  // for those that pass)
  const groundAt = (w, q) => { const b = r.chunks[q].bytes; return groundOf(w, decodeLayout(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), grid, Gs[q]); };
  const gbOf = world ? r.chunks.map((c, q) => groundAt(world, q)) : null, tg = performance.now(), fresh = await checking, byJob = new Map(todo.map((j, q) => [j, fresh[q]]));
  const results = jobs.map((j, q) => old[q] || byJob.get(j));
  if (C) { jobs.forEach((j, q) => { if (!old[q]) C.putK(id + '/chunks', ckey[q], results[q]); }); C.prune(id + '/chunks'); }
  const td = performance.now(), byKey = new Map(results.map((c) => [key(c.ix, c.iz), c])), sum = (f) => results.reduce((n, c) => n + (f(c) || 0), 0);
  // a chunk failing a check keeps today's roads
  const failed = new Map();
  for (const c of results) { const f = c.fine, co = c.coarse, bad = [];
    if (f.failed || co.failed) bad.push('fixed edges'); if (Math.abs(f.covered - 1) > 1e-6 || Math.abs(co.covered - 1) > 1e-6) bad.push('cover'); if (f.holes) bad.push('holes'); if (f.tarmacOff > 1e-4) bad.push('tarmac off physics'); if (f.kerbSlope > 0.05 || (f.kerbTris && f.kerbMeasured < f.kerbTris / 2)) bad.push('kerb in physics'); /* (kerbMeasured: kerb edges whose top stands over physics; if kerbs were physics none would, and the rise alone would pass) */ if (f.drift > DRIFT_MAX) bad.push('markings off the centre line'); if (f.deckBad) bad.push('deck step'); if (f.portalBad) bad.push('portal step'); if (f.rimBad || f.noLip) bad.push('portal gap');
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
  const prev = (() => { try { return JSON.parse(readFileSync(dir + 'index.json', 'utf8')); } catch { return { chunks: [] }; } })(), keep = new Map(cs[0] === 'all' ? [] : indexChunks(prev).map((c) => [key(c.ix, c.iz), c]));
  let bytesAll = 0, lenAll = 0, bytesExtra = 0, filesExtra = 0, groundN = 0;
  for (const { ix, iz, bytes: raw0, stats: cst } of r.chunks) { const k = key(ix, iz), raw = withEdge(raw0, byKey.get(k).edge, byKey.get(k).outline); if (failed.has(k)) { keep.delete(k); if (process.env.LAYOUT_DUMP) writeFileSync(`${process.env.LAYOUT_DUMP}/${ix}_${iz}.bin`, raw); continue; } // (LAYOUT_DUMP=dir: the failing chunks' bytes, to look at)
    // (raw: with its edge points, from its check: the coarse level's, format.js eg; the densest chunks' outlines too, op)
    if (!cst.runs && !cst.junctions && !cst.areas) { keep.set(k, { ix, iz, file: null }); groundN++; continue; } // (only ground: no file, format.js groundBytes)
    const bytes = gzipSync(raw, { level: 9 }), file = `${ix}_${iz}.${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}.bin.gz`; writeFileSync(dir + file, bytes); keep.set(k, { ix, iz, file }); bytesAll += bytes.length; lenAll += seen.get(k) || 0; if (!seen.has(k)) { bytesExtra += bytes.length; filesExtra++; } }
  const all = [...keep.values()].sort((p, q) => p.iz - q.iz || p.ix - q.ix), ground = []; for (const c of all) { if (c.file) continue; const g = ground.at(-1); if (g && g[0] === c.iz && g[2] === c.ix - 1) g[2] = c.ix; else ground.push([c.iz, c.ix, c.ix]); }
  const chunksOut = all.filter((c) => c.file).sort((p, q) => p.ix - q.ix || p.iz - q.iz), fb = [...fallback].map(([k, w]) => { const [ix, iz] = k.split(',').map(Number); return { ix, iz, why: w }; }).sort((p, q) => p.ix - q.ix || p.iz - q.iz);
  writeFileSync(dir + 'index.json', JSON.stringify({ v: LAYOUT_V, size: CHUNK, chunks: chunksOut, ...(ground.length ? { ground } : {}), fallback: fb }) + '\n');
  // the extent: its chunk pairs where one side is the layout's and the other today's (a chunk that failed a check), and
  // its outer edge against today's terrain there (World.sampleGrid: the skirt's other end), each fine edge point
  let visible = 0, outerN = 0; const outer = [];
  if (extent) { const isOut = (k) => keep.has(k);
    for (const k of extent) { const [i, j] = k.split(',').map(Number); for (const n of [key(i + 1, j), key(i, j + 1)]) if (extent.has(n) && isOut(k) !== isOut(n)) visible++; }
    const SIDE = { w: [-1, 0], e: [1, 0], s: [0, -1], n: [0, 1] };
    for (const c of results) { if (!keep.has(key(c.ix, c.iz))) continue;
      for (const [sd, [dx, dz]] of Object.entries(SIDE)) { if (extent.has(key(c.ix + dx, c.iz + dz))) continue; outerN++;
        for (const p of c.edges.fine[sd]) { const [a, y] = p.split('@').map(Number), x = dx ? (dx < 0 ? c.ix : c.ix + 1) * CHUNK : a, z = dx ? a : (dz < 0 ? c.iz : c.iz + 1) * CHUNK; outer.push([y, x, z]); } } }
    /* (today's terrain there, World.sampleGrid: from the cache if the solve and these points are the last bake's) */
    const ok = C && C.hash(solveKey, Float64Array.from(outer.flat())); let T = C && C.getK(id + '/outer', ok);
    if (!T) { const w = await W(); T = Float64Array.from(outer, ([, x, z]) => w.sampleGrid(x, z)); if (C) C.putK(id + '/outer', ok, T); }
    if (C) C.prune(id + '/outer'); outer.forEach((o, q) => { o[0] = Math.abs(o[0] - T[q]); }); outer.sort((p, q) => p[0] - q[0]); }
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
  { const R = results.map((c) => c.fine.rail), mx = (f) => Math.max(0, ...R.map(f)), sm = (f) => R.reduce((n, q) => n + (f(q) || 0), 0), U = {}; for (const q of R) for (const [k, n] of Object.entries(q.railUnder)) U[k] = (U[k] || 0) + n;
    const w = results.reduce((b, c) => (c.fine.rail.railOff > (b?.fine.rail.railOff ?? -1) ? c : b), null), ws = results.reduce((b, c) => (c.fine.rail.lxStep > (b?.fine.rail.lxStep ?? -1) ? c : b), null);
    console.log(`  railways: ${sm((q) => q.pieces)} stretches in ${R.filter((q) => q.pieces).length} chunks; rail foot off the bed max ${mx((q) => q.railOff).toFixed(4)} m over ${sm((q) => q.railN)} samples, ${sm((q) => q.railOver)} >= 2 cm (${JSON.stringify(w?.fine.rail.railWorst)}), under the rails ${JSON.stringify(U)}; rail ends at a deck over a road's carriageway ${results.reduce((n, c) => n + (c.fine.railOver || 0), 0)} (not a deck step); ballast drawn - physics max ${mx((q) => q.bedOff).toFixed(4)} m; level crossings ${sm((q) => q.lx)}, step max ${mx((q) => q.lxStep).toFixed(4)} m (${JSON.stringify(ws?.fine.rail.lxStepAt)}), ${R.filter((q) => q.lxStep >= 0.02).length} chunks >= 2 cm; grades ${JSON.stringify(r.stats.rail)}`);
    const by = (f, d) => results.filter((c) => f(c.fine.rail) > 0).sort((p, q) => f(q.fine.rail) - f(p.fine.rail)).map((c) => `${key(c.ix, c.iz)}:${d(c.fine.rail)}`).join(' ');
    { const C = results.filter((c) => c.fine.rail.clearN); console.log(`  rail decks' clearance over the paved surface under them: ${sm((q) => q.clearN)} samples in ${C.length} chunks, min ${C.length ? Math.min(...C.map((c) => c.fine.rail.clear)).toFixed(2) : '-'} m, ${sm((q) => q.clearBad)} under 0 (through the deck) in chunks [${C.filter((c) => c.fine.rail.clearBad).map((c) => `${key(c.ix, c.iz)}:${c.fine.rail.clearBad}/${c.fine.rail.clear.toFixed(2)}`).join(' ')}] (worst ${JSON.stringify(C.reduce((b, c) => (!b || c.fine.rail.clear < b.fine.rail.clear ? c : b), null)?.fine.rail.clearAt)})`); }
    console.log(`    rail chunks: level crossing >= 2 cm [${by((q) => (q.lxStep >= 0.02 ? q.lxStep : 0), (q) => q.lxStep.toFixed(3))}]; rail off its bed >= 2 cm [${by((q) => q.railOver, (q) => q.railOver + '/' + q.railOff.toFixed(2))}]`); }
  console.log(`  kerb top lines left soft (would cross another line): ${results.reduce((n, c) => n + (c.fine.softMissed || 0), 0)} segments in ${results.filter((c) => c.fine.softMissed).length} chunks`);
  console.log(`  mesh ms fine ${st((c) => c.fine.ms)} (outlines ${st((c) => c.fine.outlineMs)}); coarse ${st((c) => c.coarse.ms)}; triangles fine ${st((c) => c.fine.tris)}`);
  if (extent) { const q = (f) => outer.length ? outer[Math.min(outer.length - 1, Math.floor(outer.length * f))][0].toFixed(2) : '-';
    console.log(`  extent: ${extent.size} chunks (${seen.size} with roads, ${extra.length} added: ${groundN} only ground with no file, ${filesExtra} with a road or plaza in reach, ${(bytesExtra / 1e6).toFixed(3)} MB); visible edges inside it (layout | today's) ${visible}; outer edge ${outerN} sides, step against today's terrain p50 ${q(0.5)} m, p99 ${q(0.99)} m, max ${q(1)} m (at ${JSON.stringify(outer.at(-1)?.slice(1).map((v) => +v.toFixed(0)))})`); }
  const tf = performance.now(); console.log(`  wall: World ${((tb - t0) / 1000).toFixed(1)} s, bake ${((tc - tb) / 1000).toFixed(1)} s, checks ${((td - tc) / 1000).toFixed(1)} s on ${N} workers, files ${((tf - td) / 1000).toFixed(1)} s`, JSON.stringify(r.stats.solve), JSON.stringify(r.stats.inChunk), JSON.stringify(r.stats.overGrade));
  console.log('  furthest from the ground, in the chunks:', JSON.stringify(r.stats.worstIn));
  { const gk = C && C.hash(solveKey, [...failed.keys()].sort().join(' ')); let gb = C && C.getK(id + '/ground', gk); /* (from the cache: the same solve, the same chunks passed) */
    if (!gb) { const w = gbOf ? null : await W(), pass = r.chunks.map((c, q) => q).filter((q) => !failed.has(key(r.chunks[q].ix, r.chunks[q].iz))); gb = mergeGround(pass.map((q) => (gbOf ? gbOf[q] : groundAt(w, q)))); if (C) C.putK(id + '/ground', gk, gb); }
    if (C) C.prune(id + '/ground');
    const f = (s) => `max ${s.max} m, p99 ${s.p99} m over ${s.n} (worst ${JSON.stringify(s.worst)})`; console.log(`  ground vs today's terrain base outside the banks: at the hi grid's points ${f(gb.nodes)}; every 10 m ${f(gb.pts)}`); }
  const te = performance.now(); console.log(`  ground vs base ${((tg - tc) / 1000 + (te - tf) / 1000).toFixed(1)} s (beside the checks); ${id} in all ${((te - t0) / 1000).toFixed(1)} s`);
  return { id, world: W, city: P.city, cache: C && { solve: !!hit, checked: todo.length, of: jobs.length, world: !!world }, chunks: chunksOut.length, ground: groundN, extent: extent?.size, added: extra.length, mbAdded: bytesExtra / 1e6, visible, outerMax: outer.at(-1)?.[0], outerP99: outer.length ? outer[Math.floor(outer.length * 0.99)][0] : undefined, fallback: fallback.size, failed: failed.size, failedOnChecks, seams: `${pairs - seamBad}/${pairs}`, holes: results.reduce((s, c) => s + c.fine.holes, 0), mb: bytesAll / 1e6,
    heights: new Map(results.filter((c) => c.H && !failed.has(key(c.ix, c.iz))).map((c) => [key(c.ix, c.iz), c.H])),
    s: { world: (tb - t0) / 1000, bake: (tc - tb) / 1000, checks: (td - tc) / 1000, files: (tf - td) / 1000, ground: (tg - tc) / 1000 + (te - tf) / 1000, all: (te - t0) / 1000 } };
}
// the solve (bakePlace's, all of it from the World): which chunks, their bake (one height solve for them all), each
// one's natural ground at its lattice, the asks -> what the checks and the files need (cache.mjs keeps it as it is)
async function solvePlace(id, cs, world, asksOf, tb) {
  // ---- which chunks: every one with roads (or those asked for); the airport's roads keep it today's
  // (and the railways: World.real.osm.rails, bake.py rail_entry; one on a bridge all deck, one in a tunnel all tube)
  const rails = (world.real?.osm?.rails || []).map(([, br, f, , tun]) => { const pts = []; for (let k = 0; k < f.length; k += 2) pts.push({ x: f[k], z: f[k + 1] }); const all = new Array(pts.length).fill(true); return { kind: 'rail', pts, bridge: br ? all : null, tube: tun ? all : null }; });
  const roads = [...world.net.roads.filter((rd) => rd.kind !== 'rail'), ...rails], seen = new Map(), why = new Map(), bt = new Map();
  for (const rd of roads) { const P = rd.pts; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[Math.min(i + 1, P.length - 1)], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 10));
    for (let s = 0; s < n; s++) { const x = p.x + (q.x - p.x) * s / n, z = p.z + (q.z - p.z) * s / n, k = key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)); seen.set(k, (seen.get(k) || 0) + Math.hypot(q.x - p.x, q.z - p.z) / n);
      const b = rd.baked ? 'bridge' : rd.bridge?.[i] || rd.bridge?.[i + 1] || rd.span?.[i] || rd.span?.[i + 1] ? 'bridge' : rd.tube?.[i] || rd.tube?.[i + 1] ? 'tunnel' : null; if (b) (bt.get(k) || bt.set(k, new Set()).get(k)).add(b); } } } // (bt: the chunks with a bridge or a tunnel: baked, their decks and tubes today's (roads.js) at the layout's heights)
  const railK = () => { const S = new Set(); for (const rd of rails) for (let i = 0; i + 1 < rd.pts.length; i++) { const p = rd.pts[i], q = rd.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 10)); for (let s = 0; s <= n; s++) S.add(key(Math.floor((p.x + (q.x - p.x) * s / n) / CHUNK), Math.floor((p.z + (q.z - p.z) * s / n) / CHUNK))); } return [...S].filter((k) => seen.has(k)); }; /* (place:rails: every chunk a railway passes through, for a probe of the rail checks) */
  const wanted = cs[0] === 'all' ? [...seen.keys()] : cs[0] === 'rails' ? railK() : cs.map((c) => c.split(',').map(Number).join(','));
  // (place:all: every chunk of the layout's extent (extentOf), those with no roads too: the layout covers it all, the only
  // edge left its outer one against today's far terrain)
  const extent = cs[0] === 'all' ? extentOf(world, seen) : null, extra = extent ? [...extent].filter((k) => !seen.has(k)) : [];
  // (every chunk with roads is baked: the airport's ground, the stunt sites' pads and the land past the World's core are
  // all in the natural ground (rules.js groundNode: World.rawHeight); the marina's and water park's docks are their own
  // solid meshes (World.surfs) over it)
  const fallback = new Map(), chunks = [];
  for (const k of wanted) { if (why.has(k)) fallback.set(k, [...why.get(k)].sort().join('+')); else if (seen.has(k)) chunks.push(k.split(',').map(Number)); }
  for (const k of extra) chunks.push(k.split(',').map(Number));
  console.log(`${id}: ${wanted.length} chunks with roads${extent ? ` and ${extra.length} more without, in the extent` : ''}; ${chunks.length} to bake, ${fallback.size} keep today's roads (${count([...fallback.values()])})`);
  // ---- the bake (one height solve for them all)
  const r = bakeLayout(world, chunks, (...m) => { if (!/^\s+\[layout\]\s{3}/.test(m[0])) console.log(...m); });
  // ---- each chunk's natural ground as the runtime's (Layout.lattice), and the asks
  const grid = groundGrid(world), G = r.chunks.map(({ ix, iz }) => latticeHeights(world, grid, latticeOf({ x0: ix * CHUNK, z0: iz * CHUNK, size: CHUNK }, grid)));
  return { seen, bt, wanted, extent, extra, fallback, chunks, r, grid, G, asks: asksOf ? await asksOf(world) : null, city: !!world.real?.city, tb };
}
// the layout's extent: the World's core and every chunk with roads (seen), closed (a notch or a gap one or two chunks wide
// between road chunks filled: 8-neighbour dilate, then erode) and with no holes -> Set('ix,iz')
export function extentOf(world, seen) {
  const half = world.size / 2, c0 = Math.floor(-half / CHUNK), c1 = Math.ceil(half / CHUNK) - 1, S = new Set(seen.keys());
  for (let i = c0; i <= c1; i++) for (let j = c0; j <= c1; j++) S.add(key(i, j));
  const ps = [...S].map((k) => k.split(',').map(Number)), i0 = Math.min(...ps.map((p) => p[0])) - 2, i1 = Math.max(...ps.map((p) => p[0])) + 2, j0 = Math.min(...ps.map((p) => p[1])) - 2, j1 = Math.max(...ps.map((p) => p[1])) + 2;
  const around = (set, i, j, all) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (set.has(key(i + a, j + b)) !== all) return !all; return all; };
  const D = new Set(); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (around(S, i, j, false)) D.add(key(i, j));
  const E = new Set(S); for (const k of D) { const [i, j] = k.split(',').map(Number); if (around(D, i, j, true)) E.add(k); }
  const outside = new Set([key(i0, j0)]), st = [[i0, j0]]; // (holes: what the outside can't reach)
  while (st.length) { const [i, j] = st.pop(); for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const p = i + a, q = j + b, k = key(p, q); if (p < i0 || p > i1 || q < j0 || q > j1 || outside.has(k) || E.has(k)) continue; outside.add(k); st.push([p, q]); } }
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (!outside.has(key(i, j))) E.add(key(i, j));
  return E;
}
function count(list) { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return [...m].map(([k, n]) => `${n} ${k}`).join(', '); }
