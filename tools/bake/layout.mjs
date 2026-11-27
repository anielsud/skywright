// Bakes the road layout's chunks (#294; src/layout/bake.js) on this machine and writes them under
// assets/real/<id>/layout/ (committed: nothing is baked on a runner). Deterministic: the same code and data give the
// same bytes (no times or randomness; gzip without a timestamp), so a re-bake with nothing changed changes no file.
//
//   node --import ./tools/test/node/setup.mjs tools/bake/layout.mjs lauterbrunnen:-4,-3 nyc:-7,25:-6,25
//     (place:ix,iz[:ix,iz...]: the CHUNK-metre squares to bake, all of a place's baked together: one height solve)
// Writes each chunk as <ix>_<iz>.<hash>.bin.gz (hash: of its bytes) and the place's index.json; removes the files
// the new index no longer names.
import { writeFileSync, readdirSync, unlinkSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { worldAt } from '../test/node/world.mjs';
import { bakeLayout } from '../../src/layout/bake.js';
import { CHUNK, LAYOUT_V } from '../../src/layout/format.js';

const args = process.argv.slice(2);
if (!args.length) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(1); }
for (const a of args) {
  const [id, ...cs] = a.split(':'), chunks = cs.map((c) => c.split(',').map(Number)), t0 = performance.now();
  const { world } = await worldAt(id), tb = performance.now();
  const r = bakeLayout(world, chunks, (...m) => console.log(...m));
  const dir = `assets/real/${id}/layout/`; mkdirSync(dir, { recursive: true });
  const prev = existsSync(dir + 'index.json') ? JSON.parse(readFileSync(dir + 'index.json', 'utf8')).chunks : [];
  const keep = new Map(prev.map((c) => [c.ix + ',' + c.iz, c]));
  // (road length, for the size per km and the place's total at that rate: every road but rail)
  const segLen = (P, inside) => { let l = 0; for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5)); for (let s = 0; s < n; s++) { const x = a.x + (b.x - a.x) * (s + 0.5) / n, z = a.z + (b.z - a.z) * (s + 0.5) / n; if (!inside || inside(x, z)) l += Math.hypot(b.x - a.x, b.z - a.z) / n; } } return l; };
  const roads = world.net.roads.filter((rd) => rd.kind !== 'rail'), total = roads.reduce((s, rd) => s + segLen(rd.pts), 0);
  let sumB = 0, sumL = 0;
  for (const { ix, iz, bytes: raw, stats } of r.chunks) {
    const m = stats.mesh, mc = stats.coarse;
    if (m.failed || mc.failed || Math.abs(m.covered - 1) > 1e-6 || Math.abs(mc.covered - 1) > 1e-6) throw new Error(`${id} ${ix},${iz}: fixed edges failed ${m.failed} (coarse ${mc.failed}), covered ${m.covered} (${mc.covered})`);
    const bytes = gzipSync(raw, { level: 9 }), hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10), file = `${ix}_${iz}.${hash}.bin.gz`;
    writeFileSync(dir + file, bytes); keep.set(ix + ',' + iz, { ix, iz, file });
    const len = roads.reduce((s, rd) => s + segLen(rd.pts, (x, z) => x >= ix * CHUNK && x < (ix + 1) * CHUNK && z >= iz * CHUNK && z < (iz + 1) * CHUNK), 0); sumB += bytes.length; sumL += len;
    console.log(`${id} ${ix},${iz}: ${file} ${bytes.length} bytes, ${(len / 1000).toFixed(2)} km of road (${(bytes.length / len).toFixed(2)} bytes/m) (${stats.runs} roads / ${stats.stations} shape points, ${stats.junctions} junctions, ${stats.areas} plazas); meshes to ${m.tris} triangles in ${m.totalMs.toFixed(0)} ms (outlines ${m.outlineMs.toFixed(0)}) (coarse ${mc.tris} in ${mc.totalMs.toFixed(0)} ms)`);
  }
  console.log(`${id}: ${(total / 1000).toFixed(0)} km of road in all; at these chunks' ${(sumB / sumL).toFixed(2)} bytes/m: ${(sumB / sumL * total / 1e6).toFixed(1)} MB`);
  const chunksOut = [...keep.values()].sort((a, b) => a.ix - b.ix || a.iz - b.iz);
  writeFileSync(dir + 'index.json', JSON.stringify({ v: LAYOUT_V, size: CHUNK, chunks: chunksOut }, null, 1) + '\n');
  for (const f of readdirSync(dir)) if (f.endsWith('.bin.gz') && !chunksOut.some((c) => c.file === f)) unlinkSync(dir + f);
  console.log(`${id}: World ${((tb - t0) / 1000).toFixed(1)} s, bake ${((performance.now() - tb) / 1000).toFixed(1)} s`, JSON.stringify(r.stats.solve), JSON.stringify(r.stats.inChunk), JSON.stringify(r.stats.worstIn));
}
process.exit(0);
