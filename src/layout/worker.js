// Meshes a chunk's baked layout off the main thread (mesh.js). In: { id, buf (the decoded file's bytes), grid, G, level }.
import { decodeLayout } from './format.js';
import { meshChunk } from './mesh.js';

self.onmessage = (ev) => {
  const { id, buf, grid, G, level } = ev.data, m = meshChunk(decodeLayout(buf), grid, G, level);
  self.postMessage({ id, level, m }, [m.pos.buffer, m.phys.buffer, m.nrm.buffer, m.road.buffer, m.lane.buffer, m.idx.buffer, m.tk.buffer]);
};
