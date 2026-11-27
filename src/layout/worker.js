// Meshes a chunk's baked layout off the main thread (mesh.js). In: { id, buf (the decompressed file), grid, G, level }.
import { decodeLayout } from './format.js';
import { meshChunk } from './mesh.js';

self.onmessage = (ev) => {
  const { id, buf, grid, G, level } = ev.data, m = meshChunk(decodeLayout(buf), grid, G, level), r = m.rib;
  self.postMessage({ id, level, m }, [m.pos.buffer, m.phys.buffer, m.nrm.buffer, m.idx.buffer, m.tk.buffer, r.pos.buffer, r.nrm.buffer, r.road.buffer, r.lane.buffer, r.kind.buffer]);
};
