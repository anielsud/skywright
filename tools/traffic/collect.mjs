// Read the source packs into plain triangle soups per vehicle: { id, parts: [{ mat, P, N, UV, I, wheel? }] } in metres,
// node transforms baked. Shared by build.mjs (and handy alone: `node collect.mjs SRC_DIR` prints what it found).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const mul = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const mulN = (m, v) => { const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// every primitive under node n (world transforms baked): { node, mat, P, N, UV, I }
export function prims(n) {
  const out = [];
  n.traverse((c) => {
    const me = c.getMesh(); if (!me) return; const W = c.getWorldMatrix();
    for (const p of me.listPrimitives()) {
      const a = p.getAttribute('POSITION'), na = p.getAttribute('NORMAL'), ua = p.getAttribute('TEXCOORD_0'), idx = p.getIndices();
      const P = [], N = [], UV = [], v = [0, 0, 0], u = [0, 0];
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, v); P.push(...mul(W, v));
        if (na) { na.getElement(i, v); N.push(...mulN(W, v)); } else N.push(0, 1, 0);
        if (ua) { ua.getElement(i, u); UV.push(u[0], u[1]); } else UV.push(0, 0);
      }
      const I = []; if (idx) for (let i = 0; i < idx.getCount(); i++) I.push(idx.getScalar(i)); else for (let i = 0; i < a.getCount(); i++) I.push(i);
      if (W[0] * (W[5] * W[10] - W[6] * W[9]) - W[4] * (W[1] * W[10] - W[2] * W[9]) + W[8] * (W[1] * W[6] - W[2] * W[5]) < 0) for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
      out.push({ node: c.getName(), mat: p.getMaterial(), P, N, UV, I });
    }
  });
  return out;
}
export function bbox(P) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  return { lo, hi, size: hi.map((h, k) => h - lo[k]), c: hi.map((h, k) => (h + lo[k]) / 2) };
}
export async function read(file) { return io.read(file); }
export function findNode(doc, name) { return doc.getRoot().listNodes().find((n) => n.getName() === name); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const doc = await read(process.argv[2]);
  const root = findNode(doc, process.argv[3] || 'RootNode') || doc.getRoot().listScenes()[0].listChildren()[0];
  for (const c of root.listChildren()) {
    const ps = prims(c); if (!ps.length) continue;
    const b = bbox(ps.flatMap((p) => p.P));
    console.log(c.getName().padEnd(24), 'size', b.size.map((x) => x.toFixed(2)).join(' x '), 'centre', b.c.map((x) => x.toFixed(2)).join(','), ps.map((p) => p.mat?.getName()).join(' '));
  }
}
