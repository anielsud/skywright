// A worker of tools/bake/setbacks.mjs: the layout's surface heights at given points, a chunk at a time, the runtime's
// way (Layout.heightAt: the chunk's fine mesh, mesh.js meshChunk, read by physAt). Each job: { k, buf (the chunk's
// decompressed bytes), G (its natural ground at its lattice: rules.js latticeHeights), Q (x, z pairs, all in it) };
// answers [k, Float64Array heights (NaN where the mesh has none)] per job.
import { parentPort } from 'node:worker_threads';
import { decodeLayout } from '../../src/layout/format.js';
import { meshChunk, physIndex, physAt } from '../../src/layout/mesh.js';

parentPort.on('message', ({ jobs, grid }) => {
  const out = [];
  for (const { k, buf, G, Q } of jobs) {
    const L = decodeLayout(buf), m = meshChunk(L, grid, G, 'fine'), ix = physIndex(L, m), H = new Float64Array(Q.length / 2);
    for (let i = 0; i < H.length; i++) H[i] = physAt(L, m, ix, Q[i * 2], Q[i * 2 + 1]);
    out.push([k, H]);
  }
  parentPort.postMessage(out);
});
