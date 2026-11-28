// The setbacks stage of the layout bake (#294; behind ?layout=1 with the layout itself). A city's tall buildings were
// checked against the roads at every start (realCity.js footprint(), base(), fitBox, streetWalls, density: about a
// second and a half for New York's 37,758) and stood on the old bake's ground. The stage (tools/bake/setbacks.mjs) runs
// that same code once, on this machine, against the layout's own building lines (each street's pavement's outer edge,
// or its verge's: the clean outlines the layout draws; today's road lines where a chunk isn't baked) and with each
// building's ground from the layout's surface, and writes what every road-dependent step answered: an OVERLAY,
// assets/real/<id>/setbacks.bin.gz, keyed to the layout (layoutKey: its chunk files, which name their bytes' hashes),
// city.bin's bytes and the setback code (overlayKey). The game reads it (realCity.js tap) instead of working them out;
// a stale or missing one: today's path. With it, the low buildings and the lazy collision boxes are set back from the
// same building lines, each tile's from the layout chunks over it as they stream in (realCity.js TileLines: chunkLines,
// linesIndex), and today's lines where no chunk is baked kept in the overlay (keptLines): no road index is made.
//
// The overlay (v2): gzip of [uint32 header length, JSON header { v, key, n (tall records), cols (each column's bytes),
// S (the lines' setback), nk (kept lines) }, padded to 4] + the columns (COLS), each one run of bytes. kept: per line
// int32 cm x 4 (its a from the last one's b, then b from a), uint16 r cm, uint8 ends (setback.js roadIndex). Per tall building, in city.bin's order (its tiles, then
// their tall records): mask uint16 (BIT); then, as its bits say: g int16 x 2 (its ground's lowest and highest, the
// change from city.bin's, quarter metres); sb uint8 (1 dropped; 2 a road through it: uint8 segments x 5 float64; 3 cut
// back: uint16 points x 2 int32 cm, each the change from the one before); base int32 cm; walls uint8 calls, each
// uint16 walls + their bits; box int32 cm x 4 (its collision box kept off the street: x, z, hl, hw); bp uint8 pieces,
// each uint8 boxes x 6 float64 (the boxes beside a passage). Bits alone: dense, roof (its pitched roof would reach
// over the street; roofAsked: asked at all), seen (it reached building()). Lengths and points are whole centimetres
// in the bake's own run too (SNAP), so what it built is what the game builds.
import { RKINDS } from './format.js';
import { vergeW } from './rules.js';
import { indexSegs } from '../setback.js';

export const SETBACKS_V = 2; /* (2: the kept lines, and the key with city.bin's and the setback code's hashes) */
const COLS = ['mask', 'g', 'sb', 'base', 'walls', 'box', 'bp', 'kept']; // (each its own run of bytes: gzip packs them better apart)
const BIT = { seen: 1, g: 2, sb: 4, base: 8, dense: 16, roofAsked: 32, roof: 64, walls: 128, box: 256, bp: 512 };

// the layout's key: its chunk files (each named by its bytes' hash) and its version
export function layoutKey(index) {
  let h = 0x811c9dc5; const s = index.v + '|' + index.chunks.map((c) => c.file).join(',') + (index.ground ? '|' + JSON.stringify(index.ground) : ''); // (the chunks only ground, no file: format.js groundBytes)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
// a 32-bit hash of bytes (a word at a time: city.bin.gz is 17 MB)
export function hashBytes(u8, h = 0x811c9dc5) {
  const nw = u8.byteLength >> 2, w = (u8.byteOffset & 3) === 0 ? new Uint32Array(u8.buffer, u8.byteOffset, nw) : new Uint32Array(u8.slice(0, nw * 4).buffer);
  for (let i = 0; i < nw; i++) { h = Math.imul(h ^ w[i], 0x01000193); h ^= h >>> 15; }
  for (let i = nw * 4; i < u8.byteLength; i++) h = Math.imul(h ^ u8[i], 0x01000193);
  return ((h ^ u8.byteLength) >>> 0).toString(16).padStart(8, '0');
}
// The setback code: what works out the answers the overlay keeps and the building lines it is read with. Its text is in
// the key (fetched at load: the game's files are served as they are), as are city.bin's bytes: a change to either
// makes the overlay stale (today's path) until tools/bake/setbacks.mjs is run again. (realCity.js, which asks the
// questions, is left out: it changes for much else, and most of its changes leave the answers as they were.)
export const SETBACK_CODE = ['src/setback.js', 'src/layout/setbacks.js'];
// the overlay's key: the layout's, city.bin.gz's bytes' hash (hashBytes) and the setback code's (texts: SETBACK_CODE's, in order)
export const overlayKey = (index, cityHash, texts) => layoutKey(index) + '-' + cityHash + '-' + hashBytes(new TextEncoder().encode(texts.join('\u0000')));

// One baked chunk's building lines (as roadIndex's segments): each street out to its pavement's (or verge's) outer
// edge, each piece once (S: the setback past them; k: the piece's key, its ends in whole cm). ground(x, z): the natural
// ground (World.rawHeight): a deck's piece up to DECK_LOW above it is a street to the buildings beside it, as roadIndex
// has it (a bridge more than 5 m up passes over them); without ground every deck is left out.
export const DECK_LOW = 5;
export function chunkLines(L, S, ground = null) {
  const seen = new Set(), segs = [];
  for (const r of L.net.runs) {
    if (r.minor || r.kind === RKINDS[4] || (r.off && !(r.off === 'deck' && ground))) continue; // (as roadIndex: a way off the street network moves no building, nor a tube under the ground, nor a deck up in the air: below)
    const P = r.shape, w = r.hw + (r.pave || vergeW(r)), R = w + S, deck = r.off === 'deck';
    for (let i = 0, s = 0; i + 3 < P.length; i += 2) {
      const ax = P[i], az = P[i + 1], bx = P[i + 2], bz = P[i + 3];
      if (deck) { // (its stations from this shape point to the next (format.js stations: the shape's points among them, exactly), their mean height over the ground at the piece's middle)
        let s1 = s + 1; while (s1 < r.h.length - 1 && !(r.pts[s1 * 2] === bx && r.pts[s1 * 2 + 1] === bz)) s1++;
        let y = 0; for (let q = s; q <= s1; q++) y += r.h[q]; y /= s1 - s + 1; s = s1;
        if (y - ground((ax + bx) / 2, (az + bz) / 2) > DECK_LOW) continue; }
      const k = segKey(ax, az, bx, bz); if (seen.has(k)) continue; seen.add(k);
      const sg = [ax, az, bx, bz, w, 0, Math.min(ax, bx) - R, Math.max(ax, bx) + R, Math.min(az, bz) - R, Math.max(az, bz) + R]; sg.k = k; segs.push(sg);
    }
  }
  return segs;
}
const segKey = (a, b, c, d) => { const p = [a, b, c, d].map((v) => Math.round(v * 100)); return p[0] < p[2] || (p[0] === p[2] && p[1] <= p[3]) ? p.join(',') : [p[2], p[3], p[0], p[1]].join(','); };
// today's segments (old: roadIndex's) where the layout has no baked chunk (their middle in none of baked: 'ix,iz'), in
// whole centimetres as the overlay keeps them (the bake's run uses them so too)
export function keptLines(old, baked, size) {
  const S = old.set, cm = (v) => Math.round(v * 100) / 100, out = [];
  for (const s of old.segs) { if (baked.has(Math.floor((s[0] + s[2]) / 2 / size) + ',' + Math.floor((s[1] + s[3]) / 2 / size))) continue;
    out.push(lineSeg(cm(s[0]), cm(s[1]), cm(s[2]), cm(s[3]), cm(s[4]), s[5], S)); }
  return out;
}
const lineSeg = (ax, az, bx, bz, r, e, S) => [ax, az, bx, bz, r, e, Math.min(ax, bx) - r - S, Math.max(ax, bx) + r + S, Math.min(az, bz) - r - S, Math.max(az, bz) + r + S];
// The building lines as a road index (setback.js roadIndex's): lists, each chunk's (chunkLines), in the layout index's
// order, a piece in two chunks taken from the first; then kept (keptLines). box ({ x0, z0, x1, z1 }): only the pieces
// whose clear zones reach it (a region: what a footprint well inside it meets is what it would with them all)
export function linesIndex(lists, kept, S, box = null) {
  const seen = new Set(), segs = [], inBox = (s) => !box || (s[7] >= box.x0 && s[6] <= box.x1 && s[9] >= box.z0 && s[8] <= box.z1);
  for (const list of lists) for (const s of list) { if (!inBox(s) || seen.has(s.k)) continue; seen.add(s.k); segs.push(s); }
  let n = 0; for (const s of kept) if (inBox(s)) { segs.push(s); n++; }
  const I = indexSegs(segs, S); I.kept = n; return I;
}
// The building lines over a whole place (the bake's run): Ls the decoded chunks (format.js decodeLayout), in the
// index's order; old: today's index (roadIndex), for where no chunk is baked; ground: chunkLines'
export function buildingLines(Ls, old, size, ground = null) {
  const kept = keptLines(old, new Set(Ls.map((L) => L.ix + ',' + L.iz)), size), I = linesIndex(Ls.map((L) => chunkLines(L, old.set, ground)), kept, old.set);
  I.keptSegs = kept; return I;
}

// ---- the overlay's bytes
class Wr {
  constructor() { this.b = new ArrayBuffer(1 << 20); this.v = new DataView(this.b); this.o = 0; }
  need(n) { if (this.o + n <= this.b.byteLength) return; const b = new ArrayBuffer(Math.max(this.b.byteLength * 2, this.o + n)); new Uint8Array(b).set(new Uint8Array(this.b)); this.b = b; this.v = new DataView(b); }
  u8(x) { this.need(1); this.v.setUint8(this.o, x); this.o += 1; }
  u16(x) { this.need(2); this.v.setUint16(this.o, x, true); this.o += 2; }
  i16(x) { this.need(2); this.v.setInt16(this.o, x, true); this.o += 2; }
  i32(x) { this.need(4); this.v.setInt32(this.o, x, true); this.o += 4; }
  whole(x) { const c = Math.round(x * 100); if (c / 100 !== x) throw new Error(`setbacks: ${x} isn't whole centimetres (SNAP)`); return c; }
  cm(x) { this.i32(this.whole(x)); }
  f64(x) { this.need(8); this.v.setFloat64(this.o, x, true); this.o += 8; }
}
// An answer as the overlay keeps it (the bake's run uses it so, realCity.js tap): a cut footprint's points, a base, a
// box, in whole centimetres (g: quarter metres already)
const cm = (x) => Math.round(x * 100) / 100;
export const SNAP = { sb: (s) => (s.cut && !s.drop ? { ...s, P: s.P.map((p) => [cm(p[0]), cm(p[1])]) } : s), base: (b) => (b == null ? b : cm(b)), box: (b) => b && b.map(cm) };
// tapes: per tall record (city.bin order) what building() was told (realCity.js tap: { g, sb, base, dense, roof,
// walls, box, bp }, each a list of answers in the order asked), or null if it never got there
export function encodeSetbacks(tapes, key, lines = { keptSegs: [], set: 0 }) {
  const C = Object.fromEntries(COLS.map((c) => [c, new Wr()])), { mask, g, sb: X, base: Bs, walls: Ww, box: Bx, bp: Bp } = C;
  for (const T of tapes) {
    if (!T) { mask.u16(0); continue; }
    const one = (k) => { const q = T[k] || []; if (q.length > 1) throw new Error(`setbacks: ${k} asked ${q.length} times`); return q.length ? q[0] : undefined; };
    const gv = one('g'), sb = one('sb'), base = one('base'), dense = one('dense'), roof = one('roof'), walls = T.walls || [], box = one('box'), bp = one('bp');
    const sbT = !sb ? 0 : sb.drop ? 1 : sb.through ? 2 : sb.cut ? 3 : 0;
    mask.u16(BIT.seen | (gv ? BIT.g : 0) | (sbT ? BIT.sb : 0) | (base != null ? BIT.base : 0) | (dense ? BIT.dense : 0) | (roof !== undefined ? BIT.roofAsked : 0) | (roof ? BIT.roof : 0) | (walls.length ? BIT.walls : 0) | (box ? BIT.box : 0) | (bp ? BIT.bp : 0));
    if (gv) { g.i16(gv[0]); g.i16(gv[1]); }
    if (sbT) { X.u8(sbT); if (sbT === 2) { X.u8(sb.pass.length); for (const s of sb.pass) for (let k = 0; k < 5; k++) X.f64(s[k]); } else if (sbT === 3) { X.u16(sb.P.length); let x = 0, z = 0; for (const p of sb.P) { const PX = X.whole(p[0]), PZ = X.whole(p[1]); X.i32(PX - x); X.i32(PZ - z); x = PX; z = PZ; } } } // (each point the change from the one before)
    if (base != null) Bs.cm(base);
    if (walls.length) { Ww.u8(walls.length); for (const w of walls) { Ww.u16(w.length); for (let k = 0; k < w.length; k += 8) { let x = 0; for (let j = 0; j < 8 && k + j < w.length; j++) if (w[k + j]) x |= 1 << j; Ww.u8(x); } } }
    if (box) for (const v of box) Bx.cm(v);
    if (bp) { Bp.u8(bp.length); for (const L of bp) { Bp.u8(L.length); for (const f of L) for (const k of ['x', 'z', 'ux', 'uz', 'hl', 'hw']) Bp.f64(f[k]); } }
  }
  { const K = C.kept; let x = 0, z = 0; for (const s of lines.keptSegs) { const a = [0, 1, 2, 3].map((k) => K.whole(s[k])); K.i32(a[0] - x); K.i32(a[1] - z); K.i32(a[2] - a[0]); K.i32(a[3] - a[1]); K.u16(K.whole(s[4])); K.u8(s[5]); x = a[2]; z = a[3]; } } /* (each from the last one's end) */
  const cols = COLS.map((c) => C[c].o), hdr = new TextEncoder().encode(JSON.stringify({ v: SETBACKS_V, key, n: tapes.length, cols, S: lines.set, nk: lines.keptSegs.length })), hl = hdr.length + ((4 - ((hdr.length + 4) % 4)) % 4);
  const out = new Uint8Array(4 + hl + cols.reduce((a, b) => a + b, 0)); new DataView(out.buffer).setUint32(0, hl, true); out.set(hdr, 4); out.fill(32, 4 + hdr.length, 4 + hl);
  let o = 4 + hl; for (const c of COLS) { out.set(new Uint8Array(C[c].b, 0, C[c].o), o); o += C[c].o; }
  return out;
}
export function setbacksHeader(u8) { const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(0, true); return { ...JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)).trim()), at: 4 + hl }; }
// -> the tapes (as encodeSetbacks took them; each answer a list, read in order by realCity.js tap)
export function decodeSetbacks(u8) {
  const H = setbacksHeader(u8), out = new Array(H.n), R = {}; let at = u8.byteOffset + H.at;
  COLS.forEach((c, i) => { const v = new DataView(u8.buffer, at, H.cols[i]); at += H.cols[i]; let o = 0;
    R[c] = { u8: () => v.getUint8(o++), u16: () => { const x = v.getUint16(o, true); o += 2; return x; }, i16: () => { const x = v.getInt16(o, true); o += 2; return x; }, i32: () => { const x = v.getInt32(o, true); o += 4; return x; }, f64: () => { const x = v.getFloat64(o, true); o += 8; return x; } }; });
  const { mask, g, sb: X, base: Bs, walls: Ww, box: Bx, bp: Bp } = R, cm = (r) => r.i32() / 100;
  for (let i = 0; i < H.n; i++) {
    const m = mask.u16(); if (!m) { out[i] = null; continue; }
    const T = { g: [], sb: [], base: [], dense: [!!(m & BIT.dense)], roof: m & BIT.roofAsked ? [!!(m & BIT.roof)] : [], walls: [], box: [], bp: [] };
    if (m & BIT.g) T.g.push([g.i16(), g.i16()]);
    if (m & BIT.sb) { const t = X.u8(); if (t === 1) T.sb.push({ P: null, cut: true, drop: true }); else if (t === 2) { const n = X.u8(), pass = []; for (let s = 0; s < n; s++) pass.push([X.f64(), X.f64(), X.f64(), X.f64(), X.f64()]); T.sb.push({ cut: false, drop: false, through: true, pass }); } else { const n = X.u16(), P = []; let x = 0, z = 0; for (let k = 0; k < n; k++) { x += X.i32(); z += X.i32(); P.push([x / 100, z / 100]); } T.sb.push({ P, cut: true, drop: false }); } }
    else T.sb.push({ cut: false, drop: false });
    if (m & BIT.base) T.base.push(cm(Bs));
    if (m & BIT.walls) { const c = Ww.u8(); for (let q = 0; q < c; q++) { const n = Ww.u16(), a = new Array(n); for (let k = 0; k < n; k += 8) { const x = Ww.u8(); for (let j = 0; j < 8 && k + j < n; j++) a[k + j] = !!(x & (1 << j)); } T.walls.push(a); } }
    if (m & BIT.box) T.box.push([cm(Bx), cm(Bx), cm(Bx), cm(Bx)]);
    if (m & BIT.bp) { const c = Bp.u8(), L = []; for (let q = 0; q < c; q++) { const n = Bp.u8(), C = []; for (let k = 0; k < n; k++) C.push({ x: Bp.f64(), z: Bp.f64(), ux: Bp.f64(), uz: Bp.f64(), hl: Bp.f64(), hw: Bp.f64() }); L.push(C); } T.bp.push(L); }
    out[i] = T;
  }
  const kept = []; { const K = R.kept; let x = 0, z = 0; for (let i = 0; i < H.nk; i++) { const ax = x + K.i32(), az = z + K.i32(), bx = ax + K.i32(), bz = az + K.i32(), r = K.u16(), e = K.u8(); kept.push(lineSeg(ax / 100, az / 100, bx / 100, bz / 100, r / 100, e, H.S)); x = bx; z = bz; } }
  return { ...H, tapes: out, kept };
}
