// The baked road layout (#294): a real place's roads, pavements and the ground they reshape, decided once by the bake
// (tools/bake/layout.mjs, src/layout/bake.js) and stored per CHUNK-metre square. Only what can't be worked out again is
// stored: the paved regions' outlines and the solved network. Every height, the chunk's edge points, a city's lots and
// the banks' insides, the markings' coordinates, which hi-grid points are used: the game works them out with the same
// rules as the bake (rules.js, mesh.js).
//
// A chunk file (assets/real/<id>/layout/<ix>_<iz>.<hash>.bin.gz; listed in layout/index.json), little-endian: the solved
// network within the bake's NET_PAD of the chunk, and its plazas; the outlines are worked out from them (outline.js)
//   uint32 header length, JSON header { v, ix, iz, x0, z0, size, city, runs, sp (shape points), st (stations), jn, na, ap }, padded
//   rk uint8 x 6     per road: kind (RKINDS), flags (minor 1, one-way 2, surf << 2, a bridge's deck 16, a tunnel's tube 32,
//                    a railway's other track in a tube shared with another's 64: its rails only, bake.js mergeBores),
//                    half width dm, pavement dm, lanes, ends (it stops where a deck begins: at its first point 1, its last 4;
//                    where a tube begins: 2, 8)
//   rn uint16        per road: its shape's points (OpenStreetMap's, simplified)
//   r0 int32 x 3     per road: its first point x, z, height (cm; x, z from the corner): as the change from the road before's
//   rd int16 x 2     per shape point after a road's first: the change in x, z (cm; the bake splits longer steps)
//   rh int16         per station after a road's first: the change in height (cm). The stations are the shape's points
//                    and, between two, ceil(length / SEG) - 1 more evenly spaced (stations())
//   jx int32 x 4     per junction: x, z (cm from the corner), radius (cm; negative: a level crossing's), its plane's height
//                    at x, z (mm): each as the change from the junction before's
//   jg int16 x 2     per junction: its plane's slope along x, z (x 1e-4)
//   ac uint16, ak uint8  per plaza: its ring's points, its surface (0 tarmac, 1 paving, 2 gravel)
//   a0 int32 x 2     per plaza: its first point (cm from the corner); ad int16 x 2 per point after: the change
//   eg uint16 x 2    (optional: the header's ne, points per side) the chunk's edge points, as its fine mesh has them (its
//                    outlines' points on its edge, outline.js, and every EDGE_STEP m): per side (south z0, north z0 +
//                    size, west x0, east x0 + size; a corner on the south or north), in order along it: the change in
//                    cm from the one before, and the regions it's in (a bit per KIND). Written by the bake from its
//                    check (layout-check.mjs, withEdge): the coarse level meets its neighbours' fine edge without
//                    working out the outlines (mesh.js)
//   op uint16 x 2, oe uint16 x 2, ok uint8  (optional: the header's no, [points, edges]; the densest chunks only, mesh.js
//                    OUT_MIN) its outlines as chunkOutlines gives them (outline.js): each point (cm from the corner) and each
//                    edge's two points and kind, each as the change from the one before (modulo 2^16): the game skips
//                    working them out
export const CHUNK = 500, LAYOUT_V = 2, SEG = 24;
export const KIND = { ground: 0, bank: 1, tarmac: 2, kerb: 3, pave: 4, verge: 5, pavers: 6, gravel: 7, alley: 8, lip: 9, ballast: 10, out: 255 }; // (lip: a tunnel portal's opening, behind its headwall: no surface; ballast: a railway's bed)
export const RKINDS = ['highway', 'main', 'street', 'service', 'ped', 'track', 'other', 'rail']; // (a railway: a way off the street network, its lanes its class, bake.js RAIL_CLASS)

const pad4 = (n) => (4 - (n % 4)) % 4;
const SPEC = (H) => [['rk', Uint8Array, H.runs * 6], ['rn', Uint16Array, H.runs], ['r0', Int32Array, H.runs * 3], ['rd', Int16Array, Math.max(0, H.sp - H.runs) * 2], ['rh', Int16Array, Math.max(0, H.st - H.runs)], ['jx', Int32Array, H.jn * 4], ['jg', Int16Array, H.jn * 2], ['ac', Uint16Array, H.na], ['ak', Uint8Array, H.na], ['a0', Int32Array, H.na * 2], ['ad', Int16Array, Math.max(0, H.ap - H.na) * 2], ['eg', Uint16Array, (H.ne ? H.ne[0] + H.ne[1] + H.ne[2] + H.ne[3] : 0) * 2], ['op', Uint16Array, (H.no ? H.no[0] : 0) * 2], ['oe', Uint16Array, (H.no ? H.no[1] : 0) * 2], ['ok', Uint8Array, H.no ? H.no[1] : 0]];
// a road's stations along its shape (x, z pairs, any units): its points and, between two, ceil(length / SEG) - 1 more
export function stations(xs, zs, unit = 1) { const out = [[xs[0], zs[0]]]; for (let i = 1; i < xs.length; i++) { const l = Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]) / unit, k = Math.max(1, Math.ceil(l / SEG)); for (let s = 1; s <= k; s++) out.push([xs[i - 1] + (xs[i] - xs[i - 1]) * s / k, zs[i - 1] + (zs[i] - zs[i - 1]) * s / k]); } return out; }

// Q (integers): { ix, iz, x0, z0, size, city, areas: [{ surf, x[], z[] (cm from the corner) }], runs: [{ k, flags, hw, pave, lanes, x[], z[], h[] (cm) }], jn: [{ x, z, r (cm), y (mm), gx, gz (1e-4) }] }
export function encodeLayout(Q) {
  const sp = Q.runs.reduce((s, r) => s + r.x.length, 0), st = Q.runs.reduce((s, r) => s + r.h.length, 0), H = { v: LAYOUT_V, ix: Q.ix, iz: Q.iz, x0: Q.x0, z0: Q.z0, size: Q.size, city: Q.city ? 1 : 0, runs: Q.runs.length, sp, st, jn: Q.jn.length, na: Q.areas.length, ap: Q.areas.reduce((n, a) => n + a.x.length, 0) };
  const A = { ac: Uint16Array.from(Q.areas, (a) => a.x.length), ak: Uint8Array.from(Q.areas, (a) => a.surf), a0: new Int32Array(H.na * 2), ad: new Int16Array(Math.max(0, H.ap - H.na) * 2),
    rk: new Uint8Array(H.runs * 6), rn: new Uint16Array(H.runs), r0: new Int32Array(H.runs * 3), rd: new Int16Array(Math.max(0, sp - H.runs) * 2), rh: new Int16Array(Math.max(0, st - H.runs)), jx: new Int32Array(H.jn * 4), jg: new Int16Array(H.jn * 2), eg: new Uint16Array(0), op: new Uint16Array(0), oe: new Uint16Array(0), ok: new Uint8Array(0) };
  let d = 0, e = 0; Q.runs.forEach((r, i) => { A.rk.set([r.k, r.flags, r.hw, r.pave, r.lanes, r.ends || 0], i * 6); A.rn[i] = r.x.length; A.r0.set([r.x[0], r.z[0], r.h[0]], i * 3); for (let s = 1; s < r.x.length; s++, d++) A.rd.set([r.x[s] - r.x[s - 1], r.z[s] - r.z[s - 1]], d * 2); for (let s = 1; s < r.h.length; s++, e++) A.rh[e] = r.h[s] - r.h[s - 1]; });
  Q.jn.forEach((j, i) => { A.jx.set([j.x, j.z, j.r, j.y], i * 4); A.jg.set([j.gx, j.gz], i * 2); });
  let ad = 0; Q.areas.forEach((a, i) => { A.a0.set([a.x[0], a.z[0]], i * 2); for (let s = 1; s < a.x.length; s++, ad++) A.ad.set([a.x[s] - a.x[s - 1], a.z[s] - a.z[s - 1]], ad * 2); });
  for (let i = A.r0.length - 1; i >= 3; i--) A.r0[i] -= A.r0[i - 3]; for (let i = A.jx.length - 1; i >= 4; i--) A.jx[i] -= A.jx[i - 4]; // (each as the change from the one before)
  const hdr = new TextEncoder().encode(JSON.stringify(H)), hl = hdr.length + pad4(hdr.length + 4), specs = SPEC(H);
  let total = 4 + hl; for (const [, T, k] of specs) total += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT);
  const buf = new ArrayBuffer(total), u8 = new Uint8Array(buf); new DataView(buf).setUint32(0, hl, true); u8.set(hdr, 4); u8.fill(32, 4 + hdr.length, 4 + hl);
  let o = 4 + hl; for (const [name, T, k] of specs) { new T(buf, o, k).set(A[name]); o += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT); }
  return u8;
}
// -> { ix, iz, x0, z0, size, city, net: { runs, junctions } (metres, as rules.js takes), areas: [{ surf, ring: [[X, Z] cm] }] }
export function decodeLayout(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true), H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)).trim());
  if (H.v !== LAYOUT_V) throw new Error(`layout v${H.v}, want ${LAYOUT_V}`);
  const A = {}; let o = 4 + hl; for (const [name, T, k] of SPEC(H)) { A[name] = new T(buf, o, k).slice(); o += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT); }
  for (let i = 3; i < A.r0.length; i++) A.r0[i] += A.r0[i - 3]; for (let i = 4; i < A.jx.length; i++) A.jx[i] += A.jx[i - 4];
  const runs = []; let d = 0, e = 0;
  for (let i = 0; i < H.runs; i++) { const n = A.rn[i], xs = [A.r0[i * 3]], zs = [A.r0[i * 3 + 1]];
    for (let s = 1; s < n; s++, d++) { xs.push(xs[s - 1] + A.rd[d * 2]); zs.push(zs[s - 1] + A.rd[d * 2 + 1]); }
    const St = stations(xs, zs, 100), pts = new Float64Array(St.length * 2), h = new Float64Array(St.length); let y = A.r0[i * 3 + 2];
    St.forEach(([x, z], s) => { if (s) y += A.rh[e++]; pts[s * 2] = H.x0 + x / 100; pts[s * 2 + 1] = H.z0 + z / 100; h[s] = y / 100; });
    const shape = new Float64Array(n * 2); for (let q = 0; q < n; q++) { shape[q * 2] = H.x0 + xs[q] / 100; shape[q * 2 + 1] = H.z0 + zs[q] / 100; }
    const k = A.rk.subarray(i * 6, i * 6 + 6); runs.push({ kind: RKINDS[k[0]], minor: !!(k[1] & 1), oneway: !!(k[1] & 2), surf: (k[1] >> 2) & 3, off: k[1] & 16 ? 'deck' : k[1] & 32 ? 'tube' : k[1] & 64 ? 'rails' : null, cutA: k[5] & 1 ? 'deck' : k[5] & 2 ? 'tube' : null, cutB: k[5] & 4 ? 'deck' : k[5] & 8 ? 'tube' : null, hw: k[2] / 10, pave: k[3] / 10, lanes: k[4], pts, h, shape }); }
  const junctions = []; for (let i = 0; i < H.jn; i++) junctions.push({ x: H.x0 + A.jx[i * 4] / 100, z: H.z0 + A.jx[i * 4 + 1] / 100, r: Math.abs(A.jx[i * 4 + 2]) / 100, lx: A.jx[i * 4 + 2] < 0, y0: A.jx[i * 4 + 3] / 1000, gx: A.jg[i * 2] / 1e4, gz: A.jg[i * 2 + 1] / 1e4 });
  const areas = []; let ad = 0, X0 = Math.round(H.x0 * 100), Z0 = Math.round(H.z0 * 100);
  for (let i = 0; i < H.na; i++) { let x = A.a0[i * 2], z = A.a0[i * 2 + 1]; const ring = [[X0 + x, Z0 + z]]; for (let s = 1; s < A.ac[i]; s++, ad++) { x += A.ad[ad * 2]; z += A.ad[ad * 2 + 1]; ring.push([X0 + x, Z0 + z]); } areas.push({ surf: A.ak[i], ring }); }
  let edge = null; if (H.ne) { edge = new Int32Array(A.eg.length / 2 * 3); const S = Math.round(H.size * 100); let q = 0, o = 0;
    for (let side = 0; side < 4; side++) { let pos = 0; for (let i = 0; i < H.ne[side]; i++, q++, o += 3) { pos += A.eg[q * 2]; edge[o] = side < 2 ? X0 + pos : side === 2 ? X0 : X0 + S; edge[o + 1] = side < 2 ? (side ? Z0 + S : Z0) : Z0 + pos; edge[o + 2] = A.eg[q * 2 + 1]; } } }
  let outline = null; if (H.no) { const S = Math.round(H.size * 100), bits = new Map(); if (edge) for (let o = 0; o < edge.length; o += 3) bits.set(edge[o] * 1e7 + edge[o + 1], edge[o + 2]);
    const P = [], E = [], edgeBits = new Map(); let x = 0, z = 0; for (let i = 0; i < H.no[0]; i++) { x = (x + A.op[i * 2]) & 0xffff; z = (z + A.op[i * 2 + 1]) & 0xffff; const X = X0 + x, Z = Z0 + z; if (x === 0 || z === 0 || x === S || z === S) edgeBits.set(i, bits.get(X * 1e7 + Z) || 0); P.push([X, Z]); }
    let a = 0; for (let i = 0; i < H.no[1]; i++) { a = (a + A.oe[i * 2]) & 0xffff; E.push([a, (a + A.oe[i * 2 + 1]) & 0xffff, A.ok[i]]); }
    outline = { P, E, edgeBits, area: null }; }
  return { ...H, net: { runs, junctions }, areas, edge, outline }; // (edge: Int32Array x, z (cm), regions per edge point, or null; outline: the stored outlines (outline.js chunkOutlines's), or null)
}
// a chunk's bytes (encodeLayout's, without edge points) with its edge points added: edge Int32Array x, z (cm), regions
// (mesh.js stats.edge); and, for the densest chunks, its outlines (outline: { P, E } as chunkOutlines gives them, mesh.js stats.outline)
export function withEdge(u8, edge, outline = null) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), hl = dv.getUint32(0, true), H = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)).trim());
  if (H.ne) throw new Error('withEdge: has edge points already');
  const X0 = Math.round(H.x0 * 100), Z0 = Math.round(H.z0 * 100), S = Math.round(H.size * 100), sides = [[], [], [], []];
  for (let o = 0; o < edge.length; o += 3) { const X = edge[o] - X0, Z = edge[o + 1] - Z0, m = edge[o + 2]; if (Z === 0) sides[0].push([X, m]); else if (Z === S) sides[1].push([X, m]); else if (X === 0) sides[2].push([Z, m]); else if (X === S) sides[3].push([Z, m]); else throw new Error('withEdge: a point off the edge'); }
  const eg = new Uint16Array(edge.length / 3 * 2); let q = 0; for (const sd of sides) { sd.sort((a, b) => a[0] - b[0]); let pos = 0; for (const [p, m] of sd) { eg[q * 2] = p - pos; eg[q * 2 + 1] = m; pos = p; q++; } }
  H.ne = sides.map((sd) => sd.length); const parts = [eg];
  if (outline) { const { P, E } = outline, op = new Uint16Array(P.length * 2), oe = new Uint16Array(E.length * 2), ok = Uint8Array.from(E, (e) => e[2]); let x = 0, z = 0, a = 0; // (each as the change from the one before, modulo 2^16)
    P.forEach(([X, Z], i) => { op[i * 2] = (X - X0 - x) & 0xffff; op[i * 2 + 1] = (Z - Z0 - z) & 0xffff; x = X - X0; z = Z - Z0; }); E.forEach(([p, q], i) => { oe[i * 2] = (p - a) & 0xffff; oe[i * 2 + 1] = (q - p) & 0xffff; a = p; });
    H.no = [P.length, E.length]; parts.push(op, oe, ok); }
  const hdr = new TextEncoder().encode(JSON.stringify(H)), nhl = hdr.length + pad4(hdr.length + 4), body = u8.subarray(4 + hl); let n = 4 + nhl + body.length; for (const p of parts) n += p.byteLength + pad4(p.byteLength);
  const out = new Uint8Array(n); new DataView(out.buffer).setUint32(0, nhl, true); out.set(hdr, 4); out.fill(32, 4 + hdr.length, 4 + nhl); out.set(body, 4 + nhl);
  let o = 4 + nhl + body.length; for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += p.byteLength + pad4(p.byteLength); }
  return out;
}
// A chunk inside the layout's extent with nothing of the network or a plaza within its reach (NET_PAD) is only ground:
// no file, listed in the index's `ground` as spans [iz, ix0, ix1] (both ends in), its bytes worked out here the same at the
// bake and in the game (the natural ground, water and shore by the rules: mesh.js on an empty network)
export const groundBytes = (ix, iz, city) => encodeLayout({ ix, iz, x0: ix * CHUNK, z0: iz * CHUNK, size: CHUNK, city, runs: [], jn: [], areas: [] });
// every chunk an index lists: those with a file ({ ix, iz, file }), then the ground ones ({ ix, iz, file: null })
export function indexChunks(index) { const out = [...index.chunks]; for (const [iz, a, b] of index.ground || []) for (let ix = a; ix <= b; ix++) out.push({ ix, iz, file: null }); return out; }
// whether the layout is wanted: on unless turned off (today's roads for one release while it's switched on: ?layout=0 in
// the page, SKY_LAYOUT=0 in Node, globalThis.SKY_LAYOUT = false in a tool)
export const layoutWanted = () => globalThis.SKY_LAYOUT ?? !((typeof process !== 'undefined' && process.env?.SKY_LAYOUT === '0') || (typeof location !== 'undefined' && /[?&]layout=0\b/.test(location.search || '')));
