// Meshes a chunk's baked layout off the main thread (mesh.js). In: { id, buf (the decompressed file), grid, G, level }.
import { decodeLayout } from './format.js';
import { meshChunk, latticeOf } from './mesh.js';
import { meshRibbon } from './ribbon.js';

self.onmessage = (ev) => {
  const { id, buf, grid, G, level, mesher } = ev.data, L = decodeLayout(buf), m = mesher === 'ribbon' && level === 'fine' ? meshRibbon(L, grid, G, latticeOf(L, grid)) : meshChunk(L, grid, G, level), r = m.rib; // (mesher 'ribbon': a test, ?mesher=ribbon)
  self.postMessage({ id, level, m }, [m.pos.buffer, m.phys.buffer, m.ang.buffer, m.nrm.buffer, m.idx.buffer, m.tk.buffer, r.pos.buffer, r.nrm.buffer, r.road.buffer, r.lane.buffer, r.kind.buffer, r.id.buffer]);
};
