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
const ctx2d = (cv) => new Proxy({ canvas: cv }, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'getImageData') return (x, y, w, h) => new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
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
globalThis.createImageBitmap = async (src) => ({ width: src?.width ?? 1, height: src?.height ?? 1, close() {} });
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
