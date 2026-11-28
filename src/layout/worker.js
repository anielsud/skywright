// Meshes a chunk's baked layout off the main thread (mesh.js), and works out what it's drawn with (draw.js: the surface, the streets, the water, the railways). One of a
// pool (runtime.js POOL). In: { id, uid (echoed), buf (the decompressed file), grid, G, level, edgeH (mesh.js), wl (the water level, or
// null: no water drawn) }. Out: { id, level, m (the mesh, without its ribbons), d (draw.js drawBuffers), ms (meshing and drawing, ms) }.
import { decodeLayout } from './format.js';
import { meshChunk } from './mesh.js';
import { drawBuffers, railBuffers, drawTransfer } from './draw.js';

self.onmessage = (ev) => {
  const t0 = performance.now(), { id, uid, buf, grid, G, level, edgeH, wl } = ev.data, L = decodeLayout(buf), m = meshChunk(L, grid, G, level, edgeH), d = drawBuffers(m, wl);
  d.rails = level === 'fine' ? railBuffers(L, m) : null; // (the railways: on the fine level's surface)
  m.rib = null; // (the street ribbons: only drawn, and d has them by material)
  self.postMessage({ id, uid, level, m, d, ms: performance.now() - t0 }, [m.pos.buffer, m.phys.buffer, m.ang.buffer, m.nrm.buffer, m.idx.buffer, m.tk.buffer, ...(m.walls ? [m.walls.buffer] : []), ...drawTransfer(d)]);
};
