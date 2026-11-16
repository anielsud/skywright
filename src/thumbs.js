// Vehicle pictures for the Vehicles menu: a 3/4 front view of a design in a small photo studio (soft gradient
// backdrop, a key light with a contact shadow, room reflections), drawn offscreen with the game's renderer.
// - Stock vehicles: pre-rendered into assets/thumbs/ by tools/thumbs/build.py; assets/thumbs/index.json maps each
//   picture to the design it shows (designKey), so a stock vehicle that changed since is drawn live instead.
// - Saved vehicles: drawn when saved (or the first time the menu needs one) and kept in localStorage
//   ('skywright.thumbs', keyed by designKey, so changing a save gives it a new picture and the old one is pruned).
// Pictures are drawn one per frame from a queue; the studio (render targets, shadow map, environment) only exists
// while there is something to draw and is disposed as soon as the queue runs dry.
import * as THREE from 'three';
import { RoomEnvironment } from '../vendor/addons/RoomEnvironment.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { buildDesign, uprightStage } from './hangar.js';

const STYLE = 3; // bump when the look of the pictures changes: every picture is redrawn (3: land vehicles)
export const SAVED_SIZE = [320, 240], STOCK_SIZE = [400, 300];
const SS = 2; // drawn at twice the size and scaled down: smooth edges on thin wings and struts

// A short hash of everything that changes how a design looks (not its name or description).
export function designKey(d) {
  const s = STYLE + JSON.stringify([d.livery || null, !!d.vertical, d.parts]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const presetSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- the studio ----------
const V = () => new THREE.Vector3();
class Studio {
  constructor(renderer) {
    this.r = renderer;
    const scene = this.scene = new THREE.Scene();
    // backdrop: a soft sky-to-floor gradient, the floor itself is invisible apart from the shadow on it (a seamless sweep)
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#6f9cc4'); gr.addColorStop(0.58, '#d9e3eb'); gr.addColorStop(1, '#bcc6ce');
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    this.bg = new THREE.CanvasTexture(c); this.bg.colorSpace = THREE.SRGBColorSpace; scene.background = this.bg;
    const pm = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    this.env = pm.fromScene(room, 0.04); scene.environment = this.env.texture; scene.environmentIntensity = 0.75;
    pm.dispose(); room.dispose?.();
    scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8a8478, 0.7));
    const key = this.key = new THREE.DirectionalLight(0xfff4e6, 2.4);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
    scene.add(key, key.target);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ color: 0x1c2630, opacity: 0.32 }));
    this.ground.receiveShadow = true; scene.add(this.ground);
    this.cam = new THREE.PerspectiveCamera(28, 4 / 3, 0.1, 1000);
    this.out = new OutputPass(); // tone mapping + sRGB, as the screen gets them
    this.size = [0, 0];
  }
  targets(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    this.hdr?.dispose(); this.ldr?.dispose();
    this.hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.ldr = new THREE.WebGLRenderTarget(w, h);
    this.px = new Uint8Array(w * h * 4); this.size = [w, h];
  }
  // frame the box from a 3/4 front view (the nose points down -z), filling about 85% of the picture
  frame(root, box) {
    const cam = this.cam, c = box.getCenter(V()), dir = V().set(-0.8, 0.42, -0.95).normalize();
    // fit the real outline, not the box (whose corners stick out well past a plane seen at an angle): a few
    // thousand of the visible vertices
    const corners = [];
    root.traverseVisible((o) => {
      const pos = o.isMesh && o.geometry.attributes.position; if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count; i += step) corners.push(V().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    });
    if (!corners.length) for (let i = 0; i < 8; i++) corners.push(V().set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    let dist = Math.max(1, box.getSize(V()).length() * 1.8);
    const right = V(), up = V(), p = V(), tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    for (let k = 0; k < 4; k++) {
      cam.position.copy(c).addScaledVector(dir, dist); cam.lookAt(c);
      cam.near = dist / 50; cam.far = dist * 4; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const q of corners) { p.copy(q).project(cam); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      // re-centre on the projected box, then move in/out so it fills the frame
      right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1);
      c.addScaledVector(right, (x0 + x1) / 2 * dist * tanH * cam.aspect).addScaledVector(up, ((y0 + y1) / 2 + 0.04) * dist * tanH);
      dist *= Math.max((x1 - x0) / 2 / 0.86, (y1 - y0) / 2 / 0.8);
    }
    cam.position.copy(c).addScaledVector(dir, dist); cam.lookAt(c); cam.near = dist / 50; cam.far = dist * 4; cam.updateProjectionMatrix();
  }
  async draw(design, [w, h], quality) {
    const W = w * SS, H = h * SS, r = this.r, scene = this.scene;
    this.targets(W, H); this.cam.aspect = w / h;
    const root = new THREE.Group(); scene.add(root); let stand = null;
    try {
      buildDesign(design, root, { near: false });
      const up = uprightStage(design, root); // vertical launchers stand on a launch stand, as in the hangar
      if (up) { stand = up.stand; scene.add(stand); root.position.y = up.y; }
      root.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) box = new THREE.Box3(V().set(-1, 0, -1), V().set(1, 1, 1));
      if (!up) { root.position.y = -box.min.y; root.updateMatrixWorld(true); box.translate(V().set(0, -box.min.y, 0)); }
      const rad = Math.max(1, box.getSize(V()).length() / 2), c = box.getCenter(V());
      this.ground.scale.setScalar(rad * 8); this.ground.position.set(c.x, 0, c.z);
      const key = this.key, sc = key.shadow.camera;
      key.target.position.copy(c); key.position.copy(c).add(V().set(-0.45, 1, -0.3).normalize().multiplyScalar(rad * 3));
      sc.left = sc.bottom = -rad * 1.3; sc.right = sc.top = rad * 1.3; sc.near = rad * 0.5; sc.far = rad * 6; sc.updateProjectionMatrix();
      this.frame(root, box);
      await r.compileAsync?.(scene, this.cam); // new shaders compile off the main thread where the browser can
      const prevRT = r.getRenderTarget(), prevAuto = r.shadowMap.autoUpdate, prevXr = r.xr.enabled;
      r.shadowMap.autoUpdate = true; r.xr.enabled = false; key.shadow.needsUpdate = true;
      try {
        r.setRenderTarget(this.hdr); r.render(scene, this.cam);
        this.out.render(r, this.ldr, this.hdr);
        r.readRenderTargetPixels(this.ldr, 0, 0, W, H, this.px);
      } finally { r.setRenderTarget(prevRT); r.shadowMap.autoUpdate = prevAuto; r.xr.enabled = prevXr; }
    } finally {
      scene.remove(root); root.traverse((o) => o.geometry?.dispose()); // materials are the shared part/livery ones
      if (stand) { scene.remove(stand); stand.traverse((o) => o.geometry?.dispose()); }
    }
    // GL rows run bottom-up: flip into a canvas, then scale down into the picture
    const big = document.createElement('canvas'); big.width = W; big.height = H;
    const img = new ImageData(W, H), row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(this.px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    big.getContext('2d').putImageData(img, 0, 0);
    const off = typeof OffscreenCanvas !== 'undefined', out = off ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    if (!off) { out.width = w; out.height = h; }
    const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(big, 0, 0, w, h);
    if (off) { // encodes off the main thread
      let blob = await out.convertToBlob({ type: 'image/webp', quality });
      if (blob.type !== 'image/webp') blob = await out.convertToBlob({ type: 'image/jpeg', quality }); // no WebP encoder (Safari)
      return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(blob); });
    }
    const url = out.toDataURL('image/webp', quality);
    return url.startsWith('data:image/webp') ? url : out.toDataURL('image/jpeg', quality);
  }
  dispose() {
    this.hdr?.dispose(); this.ldr?.dispose(); this.out.dispose(); this.env.dispose(); this.bg.dispose();
    this.ground.geometry.dispose(); this.ground.material.dispose(); this.key.shadow.dispose?.(); this.key.dispose();
    this.px = null;
  }
}

// ---------- the queue ----------
let renderer = null, studio = null, queue = [], busy = false;
export function initThumbs(r) { renderer = r; }
// A picture of the design, as a data URL (null if it couldn't be drawn). Drawn after whatever was asked for before
// it, one per frame. alive(): false once nobody wants it any more (its menu was closed): then it is skipped (null).
export function renderThumb(design, { size = SAVED_SIZE, quality = 0.8, alive = null } = {}) {
  return new Promise((resolve) => { queue.push({ design, size, quality, alive, resolve }); pump(); });
}
function pump() {
  if (busy) return;
  while (queue.length && queue[0].alive && !queue[0].alive()) queue.shift().resolve(null);
  if (!queue.length) { studio?.dispose(); studio = null; return; } // nothing stays on the GPU between batches
  busy = true;
  requestAnimationFrame(async () => {
    const job = queue.shift();
    let url = null;
    if (job && (!job.alive || job.alive())) {
      try { studio ??= new Studio(renderer); url = await studio.draw(job.design, job.size, job.quality); } catch (e) { console.warn('thumbnail', e); }
    }
    job?.resolve(url);
    busy = false; pump();
  });
}

// ---------- saved pictures ----------
const KEY = 'skywright.thumbs';
export function savedThumbs() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
// Store a saved vehicle's picture; pictures of designs that are no longer saved (`keep`: their keys) are dropped.
export function storeThumb(key, url, keep) {
  const all = savedThumbs(), t = {};
  for (const k of keep) if (all[k]) t[k] = all[k];
  if (url) t[key] = url;
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* storage full: the picture is drawn again next time */ }
}

// ---------- stock pictures ----------
let stockIndex = null;
// assets/thumbs/index.json: { slug: designKey } of the pictures there (null if there is none)
export function stockThumbs() {
  stockIndex ??= fetch('assets/thumbs/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return stockIndex;
}
