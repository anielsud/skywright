// Bakes the road layout's chunks (#294; src/layout/bake.js) on this machine and writes them under
// assets/real/<id>/layout/ (committed: nothing is baked on a runner). Deterministic: the same code and data give the
// same bytes (no times or randomness; gzip without a timestamp), so a re-bake with nothing changed changes no file.
//
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs nyc:all
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs lauterbrunnen:-4,-3 nyc:-7,25:-6,25
//     (place:all: every CHUNK-metre square with roads; or place:ix,iz[:ix,iz...]. A place's chunks are baked together:
//     one height solve)
// A chunk with a bridge or a tunnel, the airport's roads, a stunt site, past the World's core, or that fails a check isn't baked: it keeps today's roads,
// listed in the index's fallback with why. Every baked chunk is checked the game's way (layout-check.mjs, on a worker
// per core): fixed edges, cover, holes, tarmac drawn - physics, kerbs not physics, the markings on their street's centre
// line (markcheck.mjs: within DRIFT_MAX), and each shared edge between two baked chunks, at every pair of levels. Writes each chunk as <ix>_<iz>.<hash>.bin.gz (hash: of its bytes) and the
// place's index.json; removes the files the new index no longer names.
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { worldAt } from '../test/node/world.mjs';
import { bakeLayout } from '../../src/layout/bake.js';
import { CHUNK, LAYOUT_V } from '../../src/layout/format.js';
import { latticeOf } from '../../src/layout/mesh.js';
import { RWY } from '../../src/world.js';
import { DRIFT_MAX } from './markcheck.mjs';

const args = process.argv.slice(2);
if (!args.length) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(1); }
const key = (ix, iz) => ix + ',' + iz;
for (const a of args) {
  const [id, ...cs] = a.split(':'), t0 = performance.now();
  const { world } = await worldAt(id), tb = performance.now();
  // ---- which chunks: every one with roads (or those asked for); a bridge, a tunnel or the airport's roads keep it today's
  const roads = world.net.roads.filter((rd) => rd.kind !== 'rail'), seen = new Map(), why = new Map();
  for (const rd of roads) { const P = rd.pts; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[Math.min(i + 1, P.length - 1)], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 10));
    for (let s = 0; s < n; s++) { const x = p.x + (q.x - p.x) * s / n, z = p.z + (q.z - p.z) * s / n, k = key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)); seen.set(k, (seen.get(k) || 0) + Math.hypot(q.x - p.x, q.z - p.z) / n);
      const b = rd.baked ? 'bridge' : rd.bridge?.[i] || rd.bridge?.[i + 1] || rd.span?.[i] || rd.span?.[i + 1] ? 'bridge' : rd.tube?.[i] || rd.tube?.[i + 1] ? 'tunnel' : null; if (b) (why.get(k) || why.set(k, new Set()).get(k)).add(b); } } }
  const wanted = cs[0] === 'all' ? [...seen.keys()] : cs.map((c) => c.split(',').map(Number).join(','));
  // (the airport: its runways, apron and roads are World's own ground, World.groundAt: the chunks about it keep today's)
  for (const k of seen.keys()) { const [ix, iz] = k.split(',').map(Number), x0 = ix * CHUNK, z0 = iz * CHUNK; if (x0 < 700 && x0 + CHUNK > -500 && z0 < RWY.len / 2 + 400 && z0 + CHUNK > -RWY.len / 2 - 400) (why.get(k) || why.set(k, new Set()).get(k)).add('airport'); }
  // (a stunt site's cut and what's past the World's core: ground the layout's natural ground doesn't know (the stunt
  // site levelled; past the core, the streamed tiles' ground and no roads))
  const cut = (x, z) => (world.stuntPlan?.cut || []).some((R) => { const ex = x - R.x, ez = z - R.z; return Math.abs(ex * R.c - ez * R.s) < R.hx && Math.abs(ex * R.s + ez * R.c) < R.hz; });
  // (the marina's docks and the water park's ramps: their own solid ground at the shore, within 50 m of the chunk)
  const sites = [...(world.marina ? [['marina', world.marina.cm]] : []), ...(world.waterParks?.sites || []).map((s) => ['water park', s.cm])];
  for (const k of seen.keys()) { const [ix, iz] = k.split(',').map(Number), x0 = ix * CHUNK, z0 = iz * CHUNK, add = (w) => (why.get(k) || why.set(k, new Set()).get(k)).add(w);
    if (world.half && (x0 < -world.half || z0 < -world.half || x0 + CHUNK > world.half || z0 + CHUNK > world.half)) add('outside the core');
    let c = false; for (let x = x0 - 50; x <= x0 + CHUNK + 50 && !c; x += 10) for (let z = z0 - 50; z <= z0 + CHUNK + 50 && !c; z += 10) c = cut(x, z); if (c) add('stunt site');
    for (const [name, cm] of sites) if (cm.hi[0] >= cm.lo[0] && x0 - 50 < cm.hi[0] && x0 + CHUNK + 50 > cm.lo[0] && z0 - 50 < cm.hi[2] && z0 + CHUNK + 50 > cm.lo[2]) add(name); }
  const fallback = new Map(), chunks = [];
  for (const k of wanted) { if (why.has(k)) fallback.set(k, [...why.get(k)].sort().join('+')); else if (seen.has(k)) chunks.push(k.split(',').map(Number)); }
  console.log(`${id}: ${wanted.length} chunks with roads; ${chunks.length} to bake, ${fallback.size} keep today's roads (${count([...fallback.values()])})`);
  // ---- the bake (one height solve for them all)
  const r = bakeLayout(world, chunks, (...m) => { if (!/^\s+\[layout\]\s{3}/.test(m[0])) console.log(...m); }), tc = performance.now();
  // ---- the checks, the game's way, a worker per core
  const H = world.real.hi, grid = { x0: H.x0, z0: H.z0, sp: H.sp, wl: world.loc.shore ? world.waterLevel : -Infinity }, jobs = r.chunks.map(({ ix, iz, bytes }) => { const L = { x0: ix * CHUNK, z0: iz * CHUNK, size: CHUNK }, lat = latticeOf(L, grid), G = new Float32Array(lat.ni * lat.nj);
    for (let j = 0; j < lat.nj; j++) for (let i = 0; i < lat.ni; i++) G[j * lat.ni + i] = H.H[Math.max(0, Math.min(H.n - 1, lat.j0 + j)) * H.n + Math.max(0, Math.min(H.n - 1, lat.i0 + i))];
    return { ix, iz, buf: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), G }; });
  const N = Math.max(1, Math.min(cpus().length - 1, Math.ceil(jobs.length / 4))), parts = Array.from({ length: N }, () => []); jobs.forEach((j, q) => parts[q % N].push(j));
  const results = (await Promise.all(parts.map((p) => new Promise((res, rej) => { const wk = new Worker(new URL('./layout-check.mjs', import.meta.url)); wk.once('message', (m) => { res(m); wk.terminate(); }); wk.once('error', rej); wk.postMessage({ jobs: p, grid }); })))).flat();
  const td = performance.now(), byKey = new Map(results.map((c) => [key(c.ix, c.iz), c])), sum = (f) => results.reduce((n, c) => n + (f(c) || 0), 0);
  // a chunk failing a check keeps today's roads
  const failed = new Map();
  for (const c of results) { const f = c.fine, co = c.coarse, bad = [];
    if (f.failed || co.failed) bad.push('fixed edges'); if (Math.abs(f.covered - 1) > 1e-6 || Math.abs(co.covered - 1) > 1e-6) bad.push('cover'); if (f.holes) bad.push('holes'); if (f.tarmacOff > 1e-4) bad.push('tarmac off physics'); if (f.kerbSlope > 0.05) bad.push('kerb in physics'); if (f.drift > DRIFT_MAX) bad.push('markings off the centre line');
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
  console.log(`  kerb top lines left soft (would cross another line): ${results.reduce((n, c) => n + (c.fine.softMissed || 0), 0)} segments in ${results.filter((c) => c.fine.softMissed).length} chunks`);
  console.log(`  mesh ms fine ${st((c) => c.fine.ms)} (outlines ${st((c) => c.fine.outlineMs)}); coarse ${st((c) => c.coarse.ms)}; triangles fine ${st((c) => c.fine.tris)}`);
  console.log(`  wall: World ${((tb - t0) / 1000).toFixed(1)} s, bake ${((tc - tb) / 1000).toFixed(1)} s, checks ${((td - tc) / 1000).toFixed(1)} s on ${N} workers, files ${((performance.now() - td) / 1000).toFixed(1)} s`, JSON.stringify(r.stats.solve), JSON.stringify(r.stats.inChunk), JSON.stringify(r.stats.overGrade));
  console.log('  furthest from the ground, in the chunks:', JSON.stringify(r.stats.worstIn));
}
process.exit(process.exitCode || 0);
function count(list) { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return [...m].map(([k, n]) => `${n} ${k}`).join(', '); }
