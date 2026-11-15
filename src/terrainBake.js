// Baked terrain for the built-in locations: the result of an offline landscape-evolution simulation
// (tools/terrain/bake.mjs) over the 26 km around the airport. Shipped as assets/terrain/<id>.bin:
//   gzip( 'SKYT' | u32 header length | JSON header | byte planes )
// planes (n*n, 26 m): height difference to the analytic function (1/8 m, row-wise deltas, low/high byte), the land
// maps drain (log drainage area), depo (scree + alluvium), wet (wetness index); then (nw*nw, 13 m) water: river,
// stream and lake coverage.
// The game's one height function becomes analytic + difference (bilinear), and the difference is already faded
// to zero at the edge of the baked area, so the streamed land beyond stays seamless.
export const BAKE = { n: 2049, span: 26624, core: 22000 };
// locations with a bake in assets/terrain/ (others, e.g. real-world ones, are never fetched)
export const BAKED = ['alpine', 'canyon'];

const store = new Map(); // id -> Promise<data|null>

async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8; // already decoded on the way (Content-Encoding)
  const ds = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await ds.arrayBuffer());
}

export function parseBake(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'SKYT') throw new Error('not a terrain bake');
  const hl = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const n = head.n, nn = n * n, o = 8 + hl;
  const lo = u8.subarray(o, o + nn), hi = u8.subarray(o + nn, o + 2 * nn);
  const d = new Float32Array(nn);
  let q = 0, rowStart = 0;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * n + x, r = ((hi[i] << 24) >> 16) | lo[i];
    if (x === 0) { q = (z ? rowStart : 0) + r; rowStart = q; } else q += r;
    d[i] = q * head.scale;
  }
  // land maps as RGBA at the water map's resolution (also the GPU texture): water, drain, depo, wet
  const nw = head.nw, ln = nw * nw, land = new Uint8Array(ln * 4), wp = u8.subarray(o + 5 * nn, o + 5 * nn + ln);
  for (let i = 0; i < ln; i++) land[i * 4] = wp[i];
  const r = (nw - 1) / (n - 1);
  for (let c = 1; c < 4; c++) {
    const p = u8.subarray(o + (1 + c) * nn, o + (2 + c) * nn);
    for (let z = 0; z < nw; z++) {
      const fz = z / r, j = Math.min(n - 2, fz | 0), v = fz - j;
      for (let x = 0; x < nw; x++) {
        const fx = x / r, i = Math.min(n - 2, fx | 0), u = fx - i, k = j * n + i;
        land[(z * nw + x) * 4 + c] = (p[k] * (1 - u) + p[k + 1] * u) * (1 - v) + (p[k + n] * (1 - u) + p[k + n + 1] * u) * v + 0.5;
      }
    }
  }
  return { ...head, d, land, cell: head.span / (n - 1), lcell: head.span / (nw - 1), x0: -head.span / 2 };
}

// Fetch (once) the bake for a location id; resolves to null if there is none or it fails to load.
export function loadBake(id) {
  if (!store.has(id)) {
    store.set(id, (async () => {
      try {
        const r = await fetch(`assets/terrain/${id}.bin`);
        if (!r.ok) return null;
        return parseBake(await gunzip(await r.arrayBuffer()));
      } catch (e) { console.warn('terrain bake', id, e); return null; }
    })());
  }
  return store.get(id);
}
// The bake once preloadBake has resolved (World is built synchronously, after main.js awaited preloadBake).
const ready = new Map();
export async function preloadBake(id) { const v = await loadBake(id); ready.set(id, v); return v; }
export const bakeFor = (id) => ready.get(id) || null;

// height(x,z) wrapped with the baked difference. Returns the function unchanged if the bake doesn't match it
// (the analytic shape was edited since the bake: re-run tools/terrain/bake.mjs).
export function withBake(height, B) {
  if (!B) return height;
  for (const [x, z, h] of B.probes) if (Math.abs(height(x, z) - h) > 0.05) { console.warn(`terrain bake for ${B.id} is stale (re-run tools/terrain/bake.mjs): ignoring it`); return height; }
  const { n, d, cell, x0 } = B, lim = n - 1 - 1e-6;
  return function baked(x, z) {
    const h = height(x, z), fx = (x - x0) / cell, fz = (z - x0) / cell;
    if (!(fx > 0 && fz > 0 && fx < lim && fz < lim)) return h;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * n + i;
    return h + (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + n] * (1 - u) + d[k + n + 1] * u) * v;
  };
}
// Land maps at (x,z), bilinear, each 0..1: out = [water, drain, depo, wet]. Zeros outside the baked area.
export function landAt(B, x, z, out) {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (!B) return out;
  const { nw: n, land, lcell, x0 } = B, fx = (x - x0) / lcell, fz = (z - x0) / lcell;
  if (!(fx > 0 && fz > 0 && fx < n - 1 && fz < n - 1)) return out;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = (j * n + i) * 4, m = n * 4;
  const w00 = (1 - u) * (1 - v) / 255, w10 = u * (1 - v) / 255, w01 = (1 - u) * v / 255, w11 = u * v / 255;
  for (let c = 0; c < 4; c++) out[c] = land[k + c] * w00 + land[k + 4 + c] * w10 + land[k + m + c] * w01 + land[k + m + 4 + c] * w11;
  return out;
}
