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
import { encodeLayout, CHUNK, LAYOUT_V } from '../../src/layout/format.js';

const args = process.argv.slice(2);
if (!args.length) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(1); }
for (const a of args) {
  const [id, ...cs] = a.split(':'), chunks = cs.map((c) => c.split(',').map(Number)), t0 = performance.now();
  const { world } = await worldAt(id), tb = performance.now();
  const r = bakeLayout(world, chunks, (...m) => console.log(...m));
  const dir = `assets/real/${id}/layout/`; mkdirSync(dir, { recursive: true });
  const prev = existsSync(dir + 'index.json') ? JSON.parse(readFileSync(dir + 'index.json', 'utf8')).chunks : [];
  const keep = new Map(prev.map((c) => [c.ix + ',' + c.iz, c]));
  for (const { L, stats } of r.chunks) {
    if (stats.mesh.failed || stats.mesh.covered < 0.9999 || stats.mesh.wrongKind) throw new Error(`${id} ${L.ix},${L.iz}: ${stats.mesh.failed} fixed edges failed, covered ${stats.mesh.covered}, ${stats.mesh.wrongKind} triangles of the wrong kind`);
    const bytes = gzipSync(encodeLayout(L), { level: 9 }), hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10), file = `${L.ix}_${L.iz}.${hash}.bin.gz`;
    writeFileSync(dir + file, bytes); keep.set(L.ix + ',' + L.iz, { ix: L.ix, iz: L.iz, file });
    console.log(`${id} ${L.ix},${L.iz}: ${file} ${(bytes.length / 1024).toFixed(0)} KB, ${stats.points} points, ${stats.edges} edges; meshes to ${stats.mesh.tris} triangles in ${stats.mesh.totalMs.toFixed(0)} ms`);
  }
  const chunksOut = [...keep.values()].sort((a, b) => a.ix - b.ix || a.iz - b.iz);
  writeFileSync(dir + 'index.json', JSON.stringify({ v: LAYOUT_V, size: CHUNK, chunks: chunksOut }, null, 1) + '\n');
  for (const f of readdirSync(dir)) if (f.endsWith('.bin.gz') && !chunksOut.some((c) => c.file === f)) unlinkSync(dir + f);
  console.log(`${id}: World ${((tb - t0) / 1000).toFixed(1)} s, bake ${((performance.now() - tb) / 1000).toFixed(1)} s`, JSON.stringify(r.stats.solve));
}
process.exit(0);
