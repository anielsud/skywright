// Node harness setup (imported with `node --import ./tools/test/node/setup.mjs`, or by run.mjs's workers): lets the
// game's own ES modules load and run headless in Node, for the tests that are logic, physics or geometry (no
// rendering). What it provides:
//  - 'three' resolves to vendor/three.module.min.js (the browser's import map), via module.registerHooks;
//  - browser stand-ins for what modules touch: window, document, localStorage, canvases (every 2D call is a no-op;
//    get/createImageData give real zeroed buffers), OffscreenCanvas, ImageData, Image, matchMedia, rAF, location;
//  - fetch of the game's own files (repo-relative paths or file:// URLs) reads them from disk; http(s) passes through.
// A module that needs something more fails loudly (a TypeError at import), never silently: add a stand-in here.
// Anything drawn (textures painted on canvases, shaders, frames) is NOT exercised in Node: the browser tier covers it.
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const THREE = pathToFileURL(REPO + 'vendor/three.module.min.js').href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE, shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: pathToFileURL(REPO + 'vendor/addons/' + spec.slice(13)).href, shortCircuit: true };
    return next(spec, ctx);
  },
});

// a recursive no-op: any property, call or construction gives another; numbers read as 1 (sizes) or 0 (arithmetic)
const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : k === 'length' || k === 'width' || k === 'height' ? 1 : k === 'data' ? new Uint8ClampedArray(4) : any()),
  apply: () => any(), construct: () => any(), set: () => true,
});
class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c ?? a.length / 4 / b; }
  }
}
// PNGs decode for real (createImageBitmap below; 8-bit grey, grey+alpha, RGB, RGBA, no interlace): drawn unscaled at
// 0,0 and read back with getImageData, their pixels are exact (e.g. a real place's landcover map). JPEGs don't decode
// (their bitmaps read as zeros): nothing in Node may depend on imagery colours.
function decodePNG(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), idat = [];
  let w = 0, h = 0, ct = 0, o = 8;
  while (o < u8.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...u8.subarray(o + 4, o + 8)), d = u8.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); ct = u8[o + 17]; if (u8[o + 16] !== 8 || u8[o + 20]) return null; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    o += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]; if (!ch) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, px = new Uint8Array(stride * h), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f === 0) px.set(raw.subarray(src, src + stride), row);
    else if (f === 1) for (let i = 0; i < stride; i++) px[row + i] = raw[src + i] + (i >= ch ? px[row + i - ch] : 0);
    else if (f === 2) for (let i = 0; i < stride; i++) px[row + i] = raw[src + i] + (y ? px[up + i] : 0);
    else if (f === 3) for (let i = 0; i < stride; i++) px[row + i] = raw[src + i] + (((i >= ch ? px[row + i - ch] : 0) + (y ? px[up + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= ch ? px[row + i - ch] : 0, b = y ? px[up + i] : 0, c = y && i >= ch ? px[up + i - ch] : 0, q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      px[row + i] = raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
  for (let k = 0, s = 0; k < w * h; k++, s += ch) {
    const g = ch < 3; out[k * 4] = px[s]; out[k * 4 + 1] = g ? px[s] : px[s + 1]; out[k * 4 + 2] = g ? px[s] : px[s + 2]; out[k * 4 + 3] = ch === 2 ? px[s + 1] : ch === 4 ? px[s + 3] : 255;
  }
  return { width: w, height: h, px: out };
}
const ctx2d = (cv) => new Proxy({ canvas: cv }, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'drawImage') return (img, x = 0, y = 0, dw, dh) => { if (img?.px && !x && !y && (dw ?? img.width) === img.width && (dh ?? img.height) === img.height && cv.width === img.width && cv.height === img.height) t.px = img.px; };
    if (k === 'getImageData') return (x, y, w, h) => (t.px && !x && !y && w === cv.width && h === cv.height ? new ImageData(t.px, w, h) : new ImageData(Math.max(1, w | 0), Math.max(1, h | 0)));
    if (k === 'createImageData') return (w, h) => (typeof w === 'object' ? new ImageData(w.width, w.height) : new ImageData(Math.max(1, w | 0), Math.max(1, h | 0)));
    if (k === 'measureText') return (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createConicGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
    if (k === 'then') return undefined;
    return typeof k === 'string' ? () => {} : undefined;
  },
  set(t, k, v) { t[k] = v; return true; },
});
const canvas = (w = 1, h = 1) => { const cv = { width: w, height: h, style: {}, addEventListener() {}, removeEventListener() {}, toDataURL: () => 'data:,', getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }), getContext: (kind) => (kind === '2d' ? ctx2d(cv) : null) }; return cv; };
globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.ImageData = ImageData;
globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, canvas(w, h)); } };
globalThis.document = {
  createElement: (t) => (t === 'canvas' ? canvas() : any()), createElementNS: () => any(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, body: any(), head: any(), documentElement: any(), fonts: { ready: Promise.resolve(), load: async () => [] }, visibilityState: 'visible', hidden: false,
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Image = class { constructor() { this.width = 1; this.height = 1; } addEventListener() {} removeEventListener() {} set src(v) { this._src = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._src; } decode() { return Promise.resolve(); } };
// a JPEG's size from its frame header (its pixels stay zeros)
function jpegSize(u) { for (let o = 2; o + 9 < u.length;) { if (u[o] !== 0xff) return null; const m = u[o + 1], len = (u[o + 2] << 8) | u[o + 3]; if (m >= 0xc0 && m <= 0xc2) return { width: (u[o + 7] << 8) | u[o + 8], height: (u[o + 5] << 8) | u[o + 6] }; o += 2 + len; } return null; }
globalThis.createImageBitmap = async (src, opt = {}) => {
  let size = { width: src?.width ?? 1, height: src?.height ?? 1 };
  if (src?.arrayBuffer) {
    const b = await src.arrayBuffer(), u = new Uint8Array(b);
    if (u[0] === 0x89 && u[1] === 0x50) { const p = decodePNG(b); if (p) return { ...p, close() {} }; }
    if (u[0] === 0xff && u[1] === 0xd8) size = jpegSize(u) || size;
  }
  return { width: opt.resizeWidth ?? size.width, height: opt.resizeHeight ?? size.height, close() {} };
};
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.requestIdleCallback = () => 0; globalThis.cancelIdleCallback = () => {};
globalThis.devicePixelRatio = 1; globalThis.innerWidth = 1000; globalThis.innerHeight = 700;
try { globalThis.navigator ??= {}; } catch {}
globalThis.location = { href: pathToFileURL(REPO).href, origin: 'null', protocol: 'file:', host: '', search: '', hash: '', pathname: '/' };

const netFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = String(u?.url ?? u);
  if (/^https?:/.test(s)) return netFetch(u, o);
  const path = s.startsWith('file:') ? fileURLToPath(s) : REPO + s.replace(/^\.?\//, '');
  try { return new Response(await readFile(path.split('?')[0].split('#')[0]), { status: 200 }); } catch { return new Response('', { status: 404, statusText: 'not found' }); }
};
