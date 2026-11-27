// The baked road layout (#294): a real place's roads, pavements and the ground they reshape, decided once by the bake
// (tools/bake/layout.mjs, src/layout/bake.js) and stored per CHUNK-metre square; the game only joins the stored points
// into one surface (src/layout/mesh.js) with the natural ground (the hi grid) around them.
//
// A chunk file (assets/real/<id>/layout/<ix>_<iz>.<hash>.bin.gz; listed in layout/index.json), little-endian:
//   uint32 header length, JSON header { v, ix, iz, x0, z0, size, n, e, lat: { i0, j0, ni, nj } }, padded to 4 bytes; then
//   px, pz uint16  centimetres from the chunk's (x0, z0) corner
//   py int32       the drawn height, millimetres (stored as the change from the point before: they're mostly near)
//   pdy int16      physics minus drawn, millimetres (a kerb's top: physics stays at the gutter, PAVE_RAMP)
//   ru float32     road coordinates for the markings: metres along the road
//   rv int16       ... centimetres across it (signed, from its centre line)
//   rhw uint8      ... its half width, decimetres (0: not on a carriageway)
//   rl uint8       ... lanes | one-way 16 | painted (markings) 32
//   rdj int16      ... decimetres along the road from the nearest junction's mouth (-1: none near)
//   ea, eb uint32  the fixed edges (outlines, the kerbs, the embankments' toes, the chunk's edge): ea as the change
//                  from the edge before, eb as eb - ea (wrapping; most edges join points made one after the other)
//   ek uint8 x 2   the kind left and right of a -> b (KIND; 255 outside the chunk)
//   mask uint8[]   bit per hi-grid point in the chunk (lat: i0, j0, ni x nj, row-major in z): 1 = not used (inside the
//                  layout's footprint, or too close to one of its points or edges)
export const CHUNK = 500, LAYOUT_V = 1;
export const KIND = { ground: 0, bank: 1, tarmac: 2, kerb: 3, pave: 4, verge: 5, pavers: 6, gravel: 7, alley: 8, out: 255 };
export const PAVED = (k) => k >= 2 && k <= 8;

const pad4 = (n) => (4 - (n % 4)) % 4;
const deltas = (L) => ({ py: L.py.map((v, i) => (i ? v - L.py[i - 1] : v)), ea: L.ea.map((v, e) => (e ? v - L.ea[e - 1] : v)), eb: L.eb.map((v, e) => v - L.ea[e]) });
const LAYOUT_ARRAYS = (n, e, m) => [['px', Uint16Array, n], ['pz', Uint16Array, n], ['py', Int32Array, n], ['pdy', Int16Array, n], ['ru', Float32Array, n], ['rv', Int16Array, n], ['rhw', Uint8Array, n], ['rl', Uint8Array, n], ['rdj', Int16Array, n], ['ea', Uint32Array, e], ['eb', Uint32Array, e], ['ek', Uint8Array, e * 2], ['mask', Uint8Array, m]];
const maskBytes = (lat) => Math.ceil((lat.ni * lat.nj) / 8);

// L: { ix, iz, x0, z0, size, lat, px..mask } (typed arrays as above) -> bytes (deterministic: same L, same bytes)
export function encodeLayout(L) {
  const n = L.px.length, e = L.ea.length, hdr = new TextEncoder().encode(JSON.stringify({ v: LAYOUT_V, ix: L.ix, iz: L.iz, x0: L.x0, z0: L.z0, size: L.size, n, e, lat: L.lat }));
  const hl = hdr.length + pad4(hdr.length + 4), specs = LAYOUT_ARRAYS(n, e, maskBytes(L.lat));
  let total = 4 + hl; for (const [, T, k] of specs) total += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT);
  const buf = new ArrayBuffer(total), u8 = new Uint8Array(buf);
  new DataView(buf).setUint32(0, hl, true); u8.set(hdr, 4); u8.fill(32, 4 + hdr.length, 4 + hl);
  const D = deltas(L);
  let o = 4 + hl; for (const [name, T, k] of specs) { new T(buf, o, k).set(D[name] || L[name]); o += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT); }
  return u8;
}
export function decodeLayout(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true), H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)).trim());
  if (H.v !== LAYOUT_V) throw new Error(`layout v${H.v}, want ${LAYOUT_V}`);
  const L = { ...H }; let o = 4 + hl;
  for (const [name, T, k] of LAYOUT_ARRAYS(H.n, H.e, maskBytes(H.lat))) { L[name] = new T(buf, o, k).slice(); o += k * T.BYTES_PER_ELEMENT + pad4(k * T.BYTES_PER_ELEMENT); }
  for (let i = 1; i < H.n; i++) L.py[i] += L.py[i - 1];
  for (let e = 0; e < H.e; e++) { if (e) L.ea[e] += L.ea[e - 1]; L.eb[e] = (L.ea[e] + (L.eb[e] | 0)) >>> 0; }
  return L;
}
// a point's world x, z, drawn y (metres)
export const pointX = (L, i) => L.x0 + L.px[i] / 100, pointZ = (L, i) => L.z0 + L.pz[i] / 100, pointY = (L, i) => L.py[i] / 1000;
// whether the layout is wanted (behind a flag while it's tried out: ?layout=1, or SKY_LAYOUT in tests/tools)
export const layoutWanted = () => globalThis.SKY_LAYOUT ?? ((typeof process !== 'undefined' && process.env?.SKY_LAYOUT === '1') || (typeof location !== 'undefined' && /[?&]layout=1\b/.test(location.search || '')));
