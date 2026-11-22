// The hangar building, its props, lighting and the view out of the door (the 3D environment of the build screen).
// Static geometry is generated here and merged into a handful of meshes (one per material, colours in vertex
// colours, world-space UVs); the CC0 Poly Haven props (assets/hangar/props_*.glb) are instanced; surface textures are
// CC0 Poly Haven scans baked by tools/hangar/bake.py. Lighting: the sun through the door, clerestories and skylights
// (follows the flight settings' time of day), an overhead key over the build bay, high-bay lamps whose light pools,
// plus the ambient occlusion under everything, are painted into the floor's light map; a cube map of the hangar
// itself lights and reflects off the plane. High / Ultra add a blurred planar reflection in the polished floor and
// sun shafts; Ultra adds drifting dust in them. Shadows are only redrawn when something changes (the plane, the time).
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { GLTFLoader } from '../vendor/addons/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/addons/meshopt_decoder.module.js';
import { RoomEnvironment } from '../vendor/addons/RoomEnvironment.js';

export const HW = 48, HD = 40, EAVE = 16, RIDGE = 21; // interior half width (x), half depth (z), eave and ridge heights
const DOOR = { x0: -20, x1: 28, h: 15 };
const FIRE_L = [-28.5, 2.0, 10.5, 22], FIRE_R = [-29, -11, 10.5, 20]; // fire points (extinguisher, sign, red hatching) along the side walls // the open part of the door wall (z = -HD)
const roofY = (x) => EAVE + (RIDGE - EAVE) * (1 - Math.abs(x) / HW);
const BASE = 'assets/hangar/';
// the camera stays inside the shell and out of the office block
const ROOM = new THREE.Box3(new THREE.Vector3(-HW + 0.8, -60, -HD + 0.8), new THREE.Vector3(HW - 0.8, EAVE + 2, HD - 0.8));
const OBSTACLES = [new THREE.Box3(new THREE.Vector3(17.2, -1, 26.0), new THREE.Vector3(HW, 7.6, HD))];

// ---------- small helpers ----------
// A texture straight from the file's bytes as an ImageBitmap: the browser decodes it off the main thread (decoding an
// <img> into one, as decoded() does, runs on the main thread: ~1.5 s for the hangar's set on a tablet, a freeze just
// as the hangar opens). Falls back to the plain loader (then decoded()) where that isn't supported.
function loadBitmapTexture(loader, url, onLoad, onError) {
  if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') return loader.load(url, onLoad, undefined, onError);
  fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${url}`))))
    .then((b) => createImageBitmap(b, { imageOrientation: 'flipY', premultiplyAlpha: 'none' }))
    .then((bm) => { const t = new THREE.Texture(bm); t.flipY = false; t.needsUpdate = true; onLoad(t); }, (e) => onError?.(e));
}
// swap a loaded <img> for a decoded, already flipped ImageBitmap (falls back to the <img> where that isn't supported)
const decoded = (t) => (typeof createImageBitmap !== 'function' || (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) ? Promise.resolve() : createImageBitmap(t.image, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
  .then((bm) => { t.image = bm; t.flipY = false; t.needsUpdate = true; }).catch(() => {}));
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const col = (c) => (c instanceof THREE.Color ? c : new THREE.Color(c));
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function place(geo, x, y, z, rx = 0, ry = 0, rz = 0) { _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')); return geo.applyMatrix4(_m.compose(_v.set(x, y, z), _q, _s)); }

// Collects world-space geometry for one material; colours go into vertex colours, UVs are world-space (metres / tile)
// unless the geometry brings its own (signs).
class Batch {
  constructor(tile = 1) { this.tile = tile; this.geos = []; }
  add(geo, color = 0xffffff, keepUV = false) {
    if (geo.index) geo = geo.toNonIndexed();
    const n = geo.attributes.position.count, c = col(color), ca = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { ca[i * 3] = c.r; ca[i * 3 + 1] = c.g; ca[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!keepUV || !geo.attributes.uv) {
      const p = geo.attributes.position, nr = geo.attributes.normal, uv = new Float32Array(n * 2), t = 1 / this.tile;
      for (let i = 0; i < n; i++) {
        const ax = Math.abs(nr.getX(i)), ay = Math.abs(nr.getY(i)), az = Math.abs(nr.getZ(i));
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        if (ay >= ax && ay >= az) { uv[i * 2] = x * t; uv[i * 2 + 1] = z * t; } else if (ax >= az) { uv[i * 2] = z * t; uv[i * 2 + 1] = y * t; } else { uv[i * 2] = x * t; uv[i * 2 + 1] = y * t; }
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
    this.geos.push(geo); return geo;
  }
  box(w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) { return this.add(place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), color); }
  // a box from a to b (its long axis), w x h in cross-section
  beam(a, b, w, h, color) {
    const len = a.distanceTo(b), g = new THREE.BoxGeometry(w, h, len);
    const up = Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    _m.lookAt(b, a, up); g.applyMatrix4(_m); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return this.add(g, color);
  }
  cyl(rt, rb, h, x, y, z, color, seg = 12, rx = 0, ry = 0, rz = 0, open = false) { return this.add(place(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), x, y, z, rx, ry, rz), color); }
  rod(a, b, r, color, seg = 6) {
    const len = a.distanceTo(b), g = new THREE.CylinderGeometry(r, r, len, seg, 1, true); g.rotateX(Math.PI / 2);
    const up = Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    _m.lookAt(b, a, up); g.applyMatrix4(_m); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return this.add(g, color);
  }
  // an I-section from a to b (web vertical in the plane of 'up')
  ibeam(a, b, depth, width, color) {
    const d = b.clone().sub(a).normalize(), side = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const n = side.clone().cross(d).normalize(), up = d.clone().cross(n).normalize(), off = up.clone().multiplyScalar(depth / 2 - 0.02);
    this.beam(a.clone().add(off), b.clone().add(off), width, 0.04, color, up);
    this.beam(a.clone().sub(off), b.clone().sub(off), width, 0.04, color, up);
    this.beam(a, b, 0.025, depth, color);
  }
  mesh(mat, shadows = true) {
    if (!this.geos.length) return null;
    const m = new THREE.Mesh(mergeGeometries(this.geos), mat); this.geos = [];
    m.castShadow = m.receiveShadow = shadows; m.matrixAutoUpdate = false; return m;
  }
}

// ---------- the sign / poster atlas (one canvas, one texture) ----------
function makeAtlas() {
  const S = 2048, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  g.fillStyle = '#777'; g.fillRect(0, 0, S, S);
  const R = {}; let x = 0, y = 0, rowH = 0;
  const region = (name, w, h, draw) => {
    if (x + w > S) { x = 0; y += rowH + 4; rowH = 0; }
    g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(g, w, h); g.restore();
    R[name] = [x / S, 1 - (y + h) / S, w / S, h / S]; x += w + 4; rowH = Math.max(rowH, h);
  };
  const text = (t, px, cx, cy, color, font = 'bold', align = 'center') => { g.fillStyle = color; g.font = `${font} ${px}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(t, cx, cy); };
  region('logo', 1536, 256, (g, w, h) => {
    g.fillStyle = '#e9edf1'; g.fillRect(0, 0, w, h); g.fillStyle = '#16324f'; g.fillRect(0, 0, w, 26); g.fillRect(0, h - 26, w, 26);
    g.save(); g.translate(150, h / 2); g.scale(2.6, 2.6); g.fillStyle = '#f6a400';
    g.beginPath(); g.moveTo(0, -26); g.lineTo(5, -4); g.lineTo(28, 4); g.lineTo(28, 9); g.lineTo(5, 5); g.lineTo(3, 20); g.lineTo(11, 25); g.lineTo(11, 28); g.lineTo(0, 25); g.lineTo(-11, 28); g.lineTo(-11, 25); g.lineTo(-3, 20); g.lineTo(-5, 5); g.lineTo(-28, 9); g.lineTo(-28, 4); g.lineTo(-5, -4); g.closePath(); g.fill(); g.restore();
    text('SKYWRIGHT', 120, 860, h / 2 - 18, '#16324f', '900'); text('AIRCRAFT WORKS  ·  HANGAR 1', 44, 860, h / 2 + 62, '#3c5a78', '700');
  });
  const blueprint = (seed) => (g, w, h) => {
    const r = rng(seed); g.fillStyle = '#1d4f8f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = 1; for (let i = 0; i < w; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); } for (let i = 0; i < h; i += 16) { g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    g.strokeStyle = 'rgba(235,245,255,0.9)'; g.lineWidth = 2.5; g.strokeRect(8, 8, w - 16, h - 16);
    const cx = w * 0.42, cy = h * 0.48, L = w * 0.62, span = w * (0.55 + r() * 0.2);
    g.beginPath(); g.ellipse(cx, cy, L / 2, h * 0.045, 0, 0, Math.PI * 2); g.stroke(); // fuselage, top view
    g.beginPath(); g.moveTo(cx - L * 0.06, cy - span / 2 * 0.0); g.lineTo(cx - L * 0.02, cy - span / 2); g.lineTo(cx + L * 0.1, cy - span / 2); g.lineTo(cx + L * 0.12, cy); g.lineTo(cx + L * 0.1, cy + span / 2); g.lineTo(cx - L * 0.02, cy + span / 2); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(cx + L * 0.38, cy); g.lineTo(cx + L * 0.4, cy - h * 0.16); g.lineTo(cx + L * 0.47, cy - h * 0.16); g.lineTo(cx + L * 0.5, cy); g.lineTo(cx + L * 0.47, cy + h * 0.16); g.lineTo(cx + L * 0.4, cy + h * 0.16); g.closePath(); g.stroke();
    g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(cx - L * 0.55, cy); g.lineTo(cx + L * 0.55, cy); g.stroke(); g.setLineDash([]);
    for (let i = 0; i < 6; i++) { const yy = cy - span / 2 + (i + 0.5) * span / 6; g.beginPath(); g.moveTo(cx - L * 0.03, yy); g.lineTo(cx + L * 0.11, yy); g.stroke(); }
    g.fillStyle = 'rgba(235,245,255,0.9)'; g.fillRect(w - 150, h - 64, 136, 50); g.fillStyle = '#1d4f8f'; g.font = 'bold 14px monospace'; g.textAlign = 'left'; g.fillText('SW-' + (100 + seed), w - 142, h - 46); g.fillText('SCALE 1:20', w - 142, h - 26);
    g.fillStyle = 'rgba(235,245,255,0.85)'; g.font = '13px monospace'; g.fillText(`SPAN ${(8 + r() * 10).toFixed(1)} m`, 22, h - 26);
  };
  region('bp1', 512, 352, blueprint(1)); region('bp2', 512, 352, blueprint(7)); region('bp3', 512, 352, blueprint(4));
  const poster = (bg, fg, title, sub, icon) => (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = fg; g.fillRect(0, 0, w, 70); text(title, 34, w / 2, 36, bg, '900');
    g.save(); g.translate(w / 2, h * 0.5); icon(g); g.restore(); text(sub, 22, w / 2, h - 40, fg, '700');
  };
  region('p_safety', 256, 352, poster('#fff6d6', '#1c7a32', 'SAFETY FIRST', 'WEAR YOUR GOGGLES', (g) => { g.fillStyle = '#1c7a32'; g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff6d6'; g.fillRect(-14, -48, 28, 96); g.fillRect(-48, -14, 96, 28); }));
  region('p_fod', 256, 352, poster('#ffffff', '#c62828', 'F.O.D.', 'PICK IT UP!', (g) => { g.strokeStyle = '#c62828'; g.lineWidth = 14; g.beginPath(); g.arc(0, 0, 66, 0, Math.PI * 2); g.stroke(); g.fillStyle = '#333'; for (let i = 0; i < 5; i++) { g.save(); g.rotate(i * 1.3); g.fillRect(-6 + i * 4, -20 + i * 6, 34, 10); g.restore(); } g.beginPath(); g.moveTo(-47, 47); g.lineTo(47, -47); g.stroke(); }));
  region('p_props', 256, 352, poster('#ffe9a8', '#16324f', 'STAND CLEAR', 'OF PROPELLERS', (g) => { g.fillStyle = '#16324f'; for (let i = 0; i < 3; i++) { g.save(); g.rotate(i * 2.094); g.beginPath(); g.ellipse(0, -42, 14, 44, 0, 0, Math.PI * 2); g.fill(); g.restore(); } g.beginPath(); g.arc(0, 0, 16, 0, Math.PI * 2); g.fillStyle = '#f6a400'; g.fill(); }));
  region('fire', 160, 160, (g, w, h) => { g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(80, 22); g.bezierCurveTo(120, 60, 120, 110, 80, 132); g.bezierCurveTo(40, 110, 38, 70, 64, 52); g.bezierCurveTo(66, 74, 76, 80, 80, 22); g.fill(); text('FIRE', 26, 80, 146, '#fff', '900'); });
  region('nosmoke', 160, 160, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#333'; g.fillRect(38, 74, 84, 14); g.strokeStyle = '#c8102e'; g.lineWidth = 14; g.beginPath(); g.arc(80, 80, 60, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(38, 38); g.lineTo(122, 122); g.stroke(); });
  region('exit', 256, 96, (g, w, h) => { g.fillStyle = '#0a8a3a'; g.fillRect(0, 0, w, h); text('EXIT', 56, 150, 50, '#fff', '900'); g.fillStyle = '#fff'; g.fillRect(24, 22, 40, 54); g.fillStyle = '#0a8a3a'; g.fillRect(32, 30, 24, 46); });
  region('pegboard', 768, 320, (g, w, h) => {
    const r = rng(11); g.fillStyle = '#c9a57a'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(60,40,20,0.55)';
    for (let yy = 10; yy < h; yy += 20) for (let xx = 10; xx < w; xx += 20) { g.beginPath(); g.arc(xx, yy, 2.4, 0, Math.PI * 2); g.fill(); }
    const tool = (tx, ty, kind, s) => {
      g.save(); g.translate(tx, ty); g.fillStyle = 'rgba(30,30,30,0.35)'; g.fillRect(-3, -s * 0.55, 6, 6); // hook
      const metal = ['#9aa3ab', '#b9c0c6', '#7d868e'][Math.floor(r() * 3)], grip = ['#d1342f', '#1f5fbf', '#f2b01e', '#222'][Math.floor(r() * 4)];
      if (kind === 0) { g.fillStyle = metal; g.fillRect(-4, -s * 0.5, 8, s); g.fillRect(-12, -s * 0.5, 24, 12); } // wrench
      else if (kind === 1) { g.fillStyle = grip; g.fillRect(-7, -s * 0.5, 14, s * 0.45); g.fillStyle = metal; g.fillRect(-2, -s * 0.05, 4, s * 0.55); } // screwdriver
      else if (kind === 2) { g.fillStyle = '#6b4a2b'; g.fillRect(-4, -s * 0.2, 8, s * 0.7); g.fillStyle = '#555'; g.fillRect(-16, -s * 0.5, 32, 14); } // hammer
      else { g.fillStyle = grip; g.save(); g.rotate(0.15); g.fillRect(-9, -s * 0.05, 7, s * 0.55); g.restore(); g.save(); g.rotate(-0.15); g.fillRect(2, -s * 0.05, 7, s * 0.55); g.restore(); g.fillStyle = metal; g.fillRect(-6, -s * 0.5, 12, s * 0.45); } // pliers
      g.restore();
    };
    for (let i = 0; i < 26; i++) tool(30 + (i % 13) * 56 + r() * 8, 90 + Math.floor(i / 13) * 150 + r() * 10, Math.floor(r() * 4), 80 + r() * 50);
  });
  region('office', 512, 192, (g, w, h) => { // a lit office seen through the glass: blinds, a desk lamp glow, a plant
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#fff3d8'); gr.addColorStop(1, '#c9b38f'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(90,80,60,0.35)'; g.fillRect(0, h * 0.62, w, h * 0.38);
    g.fillStyle = '#6d5a43'; g.fillRect(40, h * 0.6, 180, 14); g.fillStyle = '#2c3e50'; g.fillRect(90, h * 0.38, 70, 46);
    g.fillStyle = '#3a7d3a'; g.beginPath(); g.arc(400, h * 0.5, 30, 0, Math.PI * 2); g.fill(); g.fillStyle = '#8a5a3a'; g.fillRect(388, h * 0.58, 24, 30);
    g.fillStyle = 'rgba(240,235,225,0.8)'; for (let yy = 0; yy < h * 0.32; yy += 9) g.fillRect(0, yy, w, 5);
    g.strokeStyle = '#3d4a55'; g.lineWidth = 8; g.strokeRect(0, 0, w, h); g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  });
  region('hangar1', 512, 512, (g, w, h) => { g.fillStyle = '#9aaab8'; g.fillRect(0, 0, w, h); g.fillStyle = '#f2f4f6'; g.beginPath(); g.arc(w / 2, h / 2, 230, 0, Math.PI * 2); g.fill(); text('1', 380, w / 2, h / 2 + 20, '#16324f', '900'); });
  region('crane', 512, 96, (g, w, h) => { g.fillStyle = '#f2b01e'; g.fillRect(0, 0, w, h); text('SWL 5 t', 64, w / 2, h / 2 + 2, '#111', '900'); });
  region('jeta1', 512, 128, (g, w, h) => { g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8102e'; g.fillRect(0, h - 28, w, 28); text('JET A-1', 76, w / 2, h / 2 - 12, '#111', '900'); });
  region('bins', 256, 64, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#111'; g.font = 'bold 30px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('AN960-10', w / 2, h / 2); });
  region('clock_panel', 128, 128, (g, w, h) => { g.fillStyle = '#2b3a48'; g.fillRect(0, 0, w, h); });
  region('chart', 512, 352, (g, w, h) => { // a progress board for the build in the background
    g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, w, h); g.fillStyle = '#16324f'; g.fillRect(0, 0, w, 56); text('BUILD PROGRESS', 30, w / 2, 29, '#fff', '900');
    const items = ['Fuselage frames', 'Stringers', 'Wing ribs', 'Engine', 'Paint']; items.forEach((s, i) => { text(s, 22, 26, 90 + i * 52, '#222', '600', 'left'); g.fillStyle = '#ddd'; g.fillRect(240, 76 + i * 52, 240, 26); g.fillStyle = ['#2e7d32', '#2e7d32', '#f6a400', '#f6a400', '#c62828'][i]; g.fillRect(240, 76 + i * 52, 240 * [1, 0.9, 0.6, 0.35, 0.05][i], 26); });
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return { tex, R };
}
// a quad with its UVs on an atlas region, facing +z before rotation
function signQuad(R, name, w, h) {
  const g = new THREE.PlaneGeometry(w, h), [u, v, du, dv] = R[name], uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u + uv.getX(i) * du, v + uv.getY(i) * dv);
  return g;
}

// ---------- sky ----------
const SKY_FRAG = /* glsl */`
  uniform vec3 sunDir; uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunCol; uniform float night;
  varying vec3 vDir;
  float h21(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir); float e = max(d.y, 0.0);
    vec3 c = mix(horizon, zenith, pow(e, 0.45));
    float s = max(dot(d, sunDir), 0.0);
    c += sunCol * (pow(s, 900.0) * 40.0 + pow(s, 12.0) * 0.25 + pow(s, 3.0) * 0.05 * (1.0 - e));
    if (night > 0.0) { vec3 q = floor(d * 420.0); float st = step(0.9975, h21(q)) * night * smoothstep(0.02, 0.2, d.y); c += vec3(st * 1.5); }
    if (d.y < 0.0) c = horizon * 0.8;
    gl_FragColor = vec4(c, 1.0);
  }`;

// ---------- the floor: tiled concrete + painted lines / stains (decal) + baked light pools and AO, and the planar reflection ----------
function patchFloor(mat, U) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 reflMatrix; varying vec4 vReflUv;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvReflUv = reflMatrix * modelMatrix * vec4(transformed, 1.0);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tDecal; uniform sampler2D tRefl; uniform float reflOn; uniform float reflK; varying vec4 vReflUv; vec4 decal;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndecal = texture2D(tDecal, vAoMapUv); diffuseColor.rgb = mix(diffuseColor.rgb, decal.rgb, decal.a);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * mix(1.0, 0.8, decal.a), 0.04, 1.0);')
      .replace('#include <opaque_fragment>', `
        if (reflOn > 0.5) {
          vec2 ruv = vReflUv.xy / vReflUv.w + normal.xy * 0.006;
          float lod = roughnessFactor * 2.5;
          vec3 rc = vec3(0.0); // a short vertical streak: highlights smear towards the viewer like on real polished concrete
          for (int i = -2; i <= 2; i++) rc += min(textureLod(tRefl, ruv + vec2(0.0, float(i) * 0.012 * roughnessFactor), lod).rgb, vec3(1.3));
          rc *= 0.2;
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float fr = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
          outgoingLight += rc * fr * reflK * (1.0 - roughnessFactor) * (1.0 - roughnessFactor) * (1.0 - 0.7 * decal.a);
        }
        #include <opaque_fragment>`);
  };
}

export class HangarEnv {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.tier = null; this.hour = -1; this.texSet = null; this.propSet = null; this.loading = 0;
    this.onChange = () => {}; // something visible changed (assets arrived): redraw, re-bake the reflections
    this.root = new THREE.Group(); scene.add(this.root);
    this.footprints = []; // [x, z, w, d, rot, strength] for the floor's ambient occlusion
    this.lamps = [];
    this.atlas = makeAtlas();
    this.buildMaterials();
    this.buildShell();
    this.buildInterior();
    this.buildOutside();
    this.buildFloor();
    this.buildLights();
    this.buildShafts();
    this.flush();
  }

  // ---------- materials ----------
  buildMaterials() {
    const std = (o) => new THREE.MeshStandardMaterial(o);
    this.M = {
      paint: std({ vertexColors: true, roughness: 0.55, metalness: 0.25 }),
      metal: std({ vertexColors: true, roughness: 0.3, metalness: 0.95 }),
      clad: std({ vertexColors: true, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }),
      block: std({ vertexColors: true, roughness: 0.9 }),
      door: std({ vertexColors: true, roughness: 0.55, metalness: 0.2 }),
      plate: std({ vertexColors: true, roughness: 0.45, metalness: 0.85 }),
      wood: std({ vertexColors: true, roughness: 0.75 }),
      rubber: std({ vertexColors: true, roughness: 0.92 }),
      tarp: std({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
      sign: std({ map: this.atlas.tex, roughness: 0.55 }),
      lit: new THREE.MeshBasicMaterial({ map: this.atlas.tex }), // self-lit signs and office windows
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }), // lamp lenses (HDR colours, they bloom)
      sky: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), // clerestory / skylight glazing, tinted by daylight
      ground: std({ vertexColors: true, roughness: 0.95 }),
      apron: std({ vertexColors: true, roughness: 0.85 }),
      marks: std({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    };
    this.B = {}; const tiles = { clad: 1.6, block: 2.4, door: 1.2, plate: 1.0, wood: 1.2, rubber: 1.0, apron: 6, paint: 1, metal: 1 };
    for (const k in this.M) this.B[k] = new Batch(tiles[k] || 1);
  }
  flush() { // merge every batch into one mesh
    for (const k in this.B) {
      const m = this.B[k].mesh(this.M[k], !['glow', 'sky', 'lit', 'ground', 'apron', 'marks'].includes(k));
      if (!m) continue;
      if (k === 'sky' || k === 'glow' || k === 'lit') m.castShadow = false;
      if (k === 'ground' || k === 'apron' || k === 'marks') m.receiveShadow = true;
      m.name = 'env_' + k; this.root.add(m);
    }
  }
  foot(x, z, w, d, rot = 0, k = 1) { this.footprints.push([x, z, w, d, rot, k]); }

  // ---------- the building ----------
  buildShell() {
    const { paint, clad, block, door, sky, metal, sign, lit, glow } = this.B;
    const STEEL = 0x56636f, GIRT = 0x6b7884, V = (x, y, z) => new THREE.Vector3(x, y, z);
    const frames = []; for (let z = -HD; z <= HD + 0.01; z += 10) frames.push(z);
    // portal frames: I-section columns, a pitched Pratt truss across the span
    for (const z of frames) {
      for (const sx of [-1, 1]) paint.ibeam(V(sx * (HW - 0.25), 0, z), V(sx * (HW - 0.25), EAVE, z), 0.5, 0.3, STEEL);
      const bottom = EAVE - 0.4, n = 24;
      for (const sx of [-1, 1]) {
        paint.beam(V(sx * (HW - 0.25), roofY(HW) - 0.3, z), V(0, roofY(0) - 0.3, z), 0.25, 0.3, STEEL); // top chord
      }
      paint.beam(V(-HW + 0.25, bottom, z), V(HW - 0.25, bottom, z), 0.22, 0.25, STEEL); // bottom chord
      for (let i = 1; i < n; i++) {
        const x = -HW + (i * 2 * HW) / n, top = roofY(x) - 0.35;
        paint.beam(V(x, bottom, z), V(x, top, z), 0.1, 0.1, STEEL);
        const x2 = -HW + ((i + (x < 0 ? -1 : 1)) * 2 * HW) / n;
        if (i !== n / 2) paint.beam(V(x, bottom, z), V(x2, roofY(x2) - 0.35, z), 0.08, 0.08, STEEL);
      }
    }
    // purlins on the roof slope, sprinkler mains, heating ducts
    for (let x = -HW + 2; x < HW - 1; x += 3.2) paint.beam(V(x, roofY(x) - 0.12, -HD), V(x, roofY(x) - 0.12, HD), 0.08, 0.2, GIRT);
    for (const x of [-26, -6, 6, 26]) { metal.rod(V(x, roofY(x) - 0.9, -HD), V(x, roofY(x) - 0.9, HD), 0.07, 0xb3261e, 8); }
    for (const x of [-18, 18]) {
      metal.rod(V(x, roofY(x) - 2.2, -HD + 6), V(x, roofY(x) - 2.2, HD - 2), 0.45, 0xa9b0b6, 16);
      for (let z = -HD + 8; z < HD - 2; z += 6) { metal.rod(V(x, roofY(x) - 2.2, z), V(x, roofY(x) - 0.2, z), 0.015, 0x777777, 4); metal.cyl(0.47, 0.47, 0.06, x, roofY(x) - 2.2, z, 0x8d949a, 16, Math.PI / 2); }
    }
    // roof cladding (underside) with four skylight strips
    const sky1 = [[-34, -30], [-14, -10], [10, 14], [30, 34]], segs = [];
    let x0 = -HW; for (const [a, b] of sky1) { segs.push([x0, a, false]); segs.push([a, b, true]); x0 = b; } segs.push([x0, HW, false]);
    const roofPanel = (xa, xb, batch, color, y0 = 0) => {
      const g = new THREE.BufferGeometry(), ya = roofY(xa) + y0, yb = roofY(xb) + y0;
      // split at the ridge
      if (xa < 0 && xb > 0) { roofPanel(xa, 0, batch, color, y0); roofPanel(0, xb, batch, color, y0); return; }
      const p = [xa, ya, -HD, xb, yb, -HD, xb, yb, HD, xa, ya, -HD, xb, yb, HD, xa, ya, HD];
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.computeVertexNormals(); batch.add(g, color);
    };
    for (const [a, b, isSky] of segs) roofPanel(a, b, isSky ? sky : clad, isSky ? 0xffffff : 0xd8dde2);
    for (const [a, b] of sky1) for (const z of [-HD, HD]) { /* nothing: the frames cover the ends */ }
    // walls: concrete plinth, cladding, clerestory windows (side walls) and girts
    const CL = 12.5, CH = 15.2; // clerestory band
    for (const sx of [-1, 1]) {
      const x = sx * HW;
      block.box(0.3, 1.2, 2 * HD, x + sx * 0.15, 0.6, 0, 0xc9c6bf);
      clad.box(0.05, CL - 1.2, 2 * HD, x + sx * 0.05, 1.2 + (CL - 1.2) / 2, 0, 0xf3f5f7);
      clad.box(0.05, EAVE + 0.4 - CH, 2 * HD, x + sx * 0.05, CH + (EAVE + 0.4 - CH) / 2, 0, 0xf3f5f7);
      sky.box(0.04, CH - CL, 2 * HD, x + sx * 0.1, (CL + CH) / 2, 0, 0xffffff);
      paint.box(0.12, 0.12, 2 * HD, x - sx * 0.06, CL, 0, GIRT); paint.box(0.12, 0.12, 2 * HD, x - sx * 0.06, CH, 0, GIRT);
      for (let z = -HD + 2.5; z < HD; z += 2.5) paint.box(0.08, CH - CL, 0.08, x - sx * 0.05, (CL + CH) / 2, z, GIRT);
      for (const y of [4, 8]) paint.box(0.15, 0.22, 2 * HD, x - sx * 0.12, y, 0, GIRT);
    }
    // back wall (z = +HD) with its gable
    block.box(2 * HW, 1.2, 0.3, 0, 0.6, HD + 0.15, 0xc9c6bf);
    clad.box(2 * HW, EAVE - 1.2, 0.05, 0, 1.2 + (EAVE - 1.2) / 2, HD + 0.05, 0xf3f5f7);
    const gable = (z, color, batch) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-HW, EAVE, z, HW, EAVE, z, 0, RIDGE, z], 3)); g.computeVertexNormals(); batch.add(g, color); };
    gable(HD + 0.05, 0xf3f5f7, clad); gable(-HD - 0.05, 0xf3f5f7, clad);
    for (const y of [4, 8, 12]) paint.box(2 * HW, 0.22, 0.15, 0, y, HD - 0.1, GIRT);
    // personnel door + EXIT sign in the back wall
    door.box(1.1, 2.2, 0.08, -20, 1.1, HD - 0.04, 0x3d6e9e); paint.box(1.3, 0.08, 0.12, -20, 2.24, HD - 0.06, 0x2b3a48); metal.box(0.18, 0.04, 0.06, -19.7, 1.05, HD - 0.12, 0xcccccc);
    lit.add(place(signQuad(this.atlas.R, 'exit', 0.6, 0.22), -20, 2.6, HD - 0.15, 0, Math.PI), 0xffffff, true);
    // the big logo on the back wall gable
    sign.add(place(signQuad(this.atlas.R, 'logo', 18, 3), 0, 13.4, HD - 0.22, 0, Math.PI), 0xffffff, true);
    // door wall (z = -HD): header girder over the opening, gable above, door leaves on three tracks
    const zD = -HD;
    paint.box(2 * HW, 1.6, 0.6, 0, DOOR.h + 0.8, zD, 0x4b5763);
    clad.box(2 * HW, EAVE + 0.4 - DOOR.h - 1.6, 0.05, 0, DOOR.h + 1.6 + (EAVE + 0.4 - DOOR.h - 1.6) / 2, zD - 0.3, 0xf3f5f7);
    metal.box(2 * HW, 0.12, 0.9, 0, 0.03, zD - 0.3, 0x6d757c); // bottom track
    const leafW = 9.5, leaves = [[-HW + leafW / 2, 0], [-HW + leafW * 1.5 - 0.3, 1], [DOOR.x0 - leafW / 2 + 0.2, 2], [HW - leafW / 2, 0], [DOOR.x1 + leafW / 2 - 0.2, 1]];
    for (const [cx, track] of leaves) {
      const z = zD - 0.25 - track * 0.42;
      door.box(leafW, DOOR.h, 0.12, cx, DOOR.h / 2, z, 0xc4d0dc);
      paint.box(leafW, 0.25, 0.2, cx, DOOR.h - 0.2, z + 0.05, 0x7d8d9c); paint.box(leafW, 0.3, 0.2, cx, 0.3, z + 0.05, 0x5b6a78);
      for (let i = 0; i < 4; i++) sky.box(leafW / 4 - 0.4, 0.9, 0.05, cx - leafW / 2 + leafW / 8 + i * leafW / 4, 6.2, z + 0.07, 0xffffff);
      paint.box(leafW, 0.12, 0.16, cx, 5.7, z + 0.08, 0x7d8d9c); paint.box(leafW, 0.12, 0.16, cx, 6.7, z + 0.08, 0x7d8d9c);
      for (const ex of [-leafW / 2 + 0.1, leafW / 2 - 0.1]) paint.box(0.18, DOOR.h, 0.18, cx + ex, DOOR.h / 2, z + 0.06, 0x7d8d9c);
    }
    sign.add(place(signQuad(this.atlas.R, 'hangar1', 4.2, 4.2), -HW + leafW / 2, 10, zD - 0.17), 0xffffff, true);
    sign.add(place(signQuad(this.atlas.R, 'hangar1', 4.2, 4.2), HW - leafW / 2, 10, zD - 0.17), 0xffffff, true);
    // high-bay lamps (housings in paint, lenses glow) and wall-mounted floodlights
    for (const z of [-30, -20, -10, 0, 10, 20, 30]) for (const x of [-32, -16, 0, 16, 32]) {
      const y = EAVE - 1.2;
      metal.rod(V(x, y + 0.5, z), V(x, EAVE - 0.4, z), 0.012, 0x555555, 4);
      paint.cyl(0.18, 0.62, 0.55, x, y + 0.2, z, 0xc5ccd2, 16, 0, 0, 0, true);
      paint.cyl(0.2, 0.2, 0.25, x, y + 0.55, z, 0x4b5763, 10);
      glow.cyl(0.58, 0.58, 0.02, x, y - 0.08, z, new THREE.Color(1, 0.96, 0.88).multiplyScalar(10), 16);
      this.lamps.push([x, z]);
    }
    // overhead crane: runway beams on brackets, a bridge girder, a hoist with its hook
    const CR = 12.6;
    for (const sx of [-1, 1]) {
      paint.ibeam(V(sx * (HW - 1.0), CR, -HD), V(sx * (HW - 1.0), CR, HD), 0.7, 0.35, 0xe3a51c);
      for (const z of frames) paint.box(0.8, 0.5, 0.35, sx * (HW - 0.75), CR - 0.6, z, STEEL);
    }
    const cz = 24;
    paint.box(2 * HW - 2, 1.1, 0.5, 0, CR + 0.95, cz - 0.5, 0xf2b01e); paint.box(2 * HW - 2, 1.1, 0.5, 0, CR + 0.95, cz + 0.5, 0xf2b01e);
    for (const sx of [-1, 1]) paint.box(0.8, 0.7, 3, sx * (HW - 1.0), CR + 0.6, cz, 0xd99a12);
    sign.add(place(signQuad(this.atlas.R, 'crane', 3.2, 0.6), -6, CR + 0.95, cz - 0.76, 0, Math.PI), 0xffffff, true);
    sign.add(place(signQuad(this.atlas.R, 'crane', 3.2, 0.6), 6, CR + 0.95, cz + 0.76), 0xffffff, true);
    const hx = 30; paint.box(1.6, 0.9, 1.8, hx, CR + 0.2, cz, 0x3c4650);
    metal.rod(V(hx - 0.1, CR - 0.3, cz), V(hx - 0.1, 7.5, cz), 0.02, 0x333333); metal.rod(V(hx + 0.1, CR - 0.3, cz), V(hx + 0.1, 7.5, cz), 0.02, 0x333333);
    paint.box(0.5, 0.6, 0.3, hx, 7.3, cz, 0xf2b01e); metal.add(place(new THREE.TorusGeometry(0.22, 0.06, 6, 12, Math.PI * 1.4), hx, 6.8, cz, 0, 0, 2.1), 0x444444);
    // cable trays along the side walls, with cables
    for (const sx of [-1, 1]) {
      const x = sx * (HW - 0.9), y = 10;
      metal.box(0.05, 0.1, 2 * HD - 1, x - 0.25, y, 0, 0x8d949a); metal.box(0.05, 0.1, 2 * HD - 1, x + 0.25, y, 0, 0x8d949a);
      for (let z = -HD + 0.6; z < HD - 0.5; z += 0.4) metal.box(0.5, 0.02, 0.03, x, y - 0.04, z, 0x8d949a);
      for (const [dx, c] of [[-0.12, 0x222222], [0, 0x1d3f7a], [0.12, 0x333333]]) metal.rod(V(x + dx, y, -HD + 0.6), V(x + dx, y, HD - 0.6), 0.03, c, 5);
      for (const z of frames) metal.rod(V(x, y, z), V(sx * (HW - 0.2), y, z), 0.03, 0x666666, 4);
    }
    // electrical panel and conduits on the left wall
    for (const [z, h] of [[-24, 1.8], [-22.6, 1.2]]) { paint.box(0.3, h, 0.9, -HW + 0.2, 1.4 + h / 2, z, 0x9aa4ad); }
    metal.rod(V(-HW + 0.15, 3.2, -24), V(-HW + 0.15, 10, -24), 0.05, 0x777777); metal.rod(V(-HW + 0.15, 2.6, -22.6), V(-HW + 0.15, 10, -22.6), 0.04, 0x777777);
  }

  buildInterior() {
    const { paint, metal, wood, rubber, plate, sign, tarp, block, clad, lit, door } = this.B;
    const V = (x, y, z) => new THREE.Vector3(x, y, z), R = this.atlas.R, r = rng(7);
    // --- workbenches with pegboards, posters and blueprints above (left wall)
    const benchX = -HW + 0.55;
    for (const z of [-18.3, -15.1, -11.9, -8.3, -5.1]) {
      wood.box(0.85, 0.05, 3.1, benchX, 0.9, z, 0xc8a46e);
      for (const dz of [-1.45, 1.45]) for (const dx of [-0.36, 0.36]) paint.box(0.06, 0.88, 0.06, benchX + dx, 0.44, z + dz, 0x2f5d8a);
      paint.box(0.8, 0.04, 3.0, benchX, 0.2, z, 0x2f5d8a); paint.box(0.05, 0.1, 3.0, benchX + 0.4, 0.82, z, 0x2f5d8a);
      paint.box(0.5, 0.25, 0.9, benchX + 0.1, 0.72, z + 0.9, 0x234a70); // drawer unit
      sign.add(place(signQuad(R, 'pegboard', 3.0, 1.3), -HW + 0.13, 1.8, z, 0, Math.PI / 2), 0xffffff, true);
      paint.box(0.06, 0.06, 3.0, -HW + 0.14, 2.5, z, 0x9aa4ad); // lamp bar
      this.foot(benchX, z, 0.95, 3.2, 0, 0.8);
    }
    rubber.box(1.1, 0.012, 16.4, -HW + 1.6, 0.006, -11.7, 0x202326);
    const wall = (name, w, h, y, z, x = -HW + 0.1, ry = Math.PI / 2) => sign.add(place(signQuad(R, name, w, h), x, y, z, 0, ry), 0xffffff, true);
    wall('bp1', 2.2, 1.5, 3.6, -17.6); wall('bp2', 2.2, 1.5, 3.6, -15.0); wall('p_safety', 1.0, 1.4, 3.6, -12.9); wall('bp3', 2.2, 1.5, 3.6, -11.0); wall('p_fod', 1.0, 1.4, 3.6, -8.4); wall('p_props', 1.0, 1.4, 3.6, -6.9); wall('bp2', 2.2, 1.5, 3.6, -4.7);
    wall('chart', 2.4, 1.65, 3.3, 9, HW - 0.1, -Math.PI / 2);
    for (const z of FIRE_L) wall('fire', 0.5, 0.5, 2.0, z); for (const z of FIRE_R) wall('fire', 0.5, 0.5, 2.0, z, HW - 0.1, -Math.PI / 2);
    wall('nosmoke', 0.6, 0.6, 3.0, -26, -HW + 0.1); wall('nosmoke', 0.6, 0.6, 3.0, -26, HW - 0.1, -Math.PI / 2);
    // --- parts shelving with labelled bins (back-left corner)
    for (let i = 0; i < 2; i++) {
      const z0 = 30 + i * 4;
      for (let x = -46.5; x < -33; x += 2.4) {
        for (const dx of [-1.15, 1.15]) for (const dz of [-0.28, 0.28]) paint.box(0.06, 2.6, 0.06, x + dx, 1.3, z0 + dz, 0x2f5d8a);
        for (const y of [0.15, 0.75, 1.35, 1.95, 2.55]) {
          paint.box(2.36, 0.04, 0.62, x, y, z0, 0xf28c28);
          if (y > 2.4) continue;
          for (let k = 0; k < 6; k++) {
            if (r() < 0.12) continue;
            const bc = [0x1f5fbf, 0x1f5fbf, 0xd1342f, 0xf2b01e, 0x2e7d32][Math.floor(r() * 5)];
            paint.box(0.34, 0.22 + (k % 2) * 0.06, 0.5, x - 0.95 + k * 0.38, y + 0.14, z0, bc);
            for (const s of [-1, 1]) sign.add(place(signQuad(R, 'bins', 0.2, 0.05), x - 0.95 + k * 0.38, y + 0.18, z0 + s * 0.255, 0, s > 0 ? 0 : Math.PI), 0xffffff, true);
          }
        }
        this.foot(x, z0, 2.4, 0.7, 0, 0.7);
      }
    }
    // --- pallets with stock
    const pallet = (x, z, ry = 0) => {
      const c = Math.cos(ry), s = Math.sin(ry), P = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
      for (const dz of [-0.45, 0, 0.45]) { const [px, pz] = P(0, dz); wood.box(1.2, 0.1, 0.1, px, 0.05, pz, 0xb08a5a, ry); }
      for (let i = 0; i < 5; i++) { const [px, pz] = P(-0.5 + i * 0.25, 0); wood.box(0.14, 0.03, 1.0, px, 0.115, pz, 0xc49a66, ry); }
      this.foot(x, z, 1.3, 1.1, ry, 0.6);
    };
    for (const [x, z, ry] of [[-30, 36.5, 0], [-28.6, 36.5, 0], [-38, 25, 0.3], [-44.5, 36, 0], [40.5, -33, 0.2], [-44, -33, 0], [-42.6, -34.2, 1.5]]) pallet(x, z, ry);
    // --- engine stand with a radial engine
    this.radialEngine(-34, 1.35, 1.5, Math.PI / 2 + 0.4);
    // --- wing jig with a primed wing panel
    {
      const x = -34, z = 17;
      for (const dz of [-3.4, 3.4]) {
        paint.box(1.6, 0.12, 0.2, x, 0.06, z + dz, 0xf2b01e); paint.box(0.16, 2.6, 0.16, x - 0.5, 1.3, z + dz, 0xf2b01e); paint.box(0.16, 2.6, 0.16, x + 0.5, 1.3, z + dz, 0xf2b01e);
        paint.box(1.16, 0.14, 0.18, x, 2.6, z + dz, 0xf2b01e); paint.box(1.16, 0.14, 0.18, x, 0.65, z + dz, 0xf2b01e);
      }
      paint.box(0.14, 0.14, 7.0, x - 0.5, 2.6, z, 0xf2b01e);
      const sh = new THREE.Shape(); const c = 1.7, t = 0.2; sh.moveTo(0, 0);
      for (let i = 0; i <= 20; i++) { const u = i / 20; sh.lineTo(u * c, 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1015 * u ** 4) * c); }
      for (let i = 20; i >= 0; i--) { const u = i / 20; sh.lineTo(u * c, -5 * t * 0.6 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1015 * u ** 4) * c); }
      const wg = new THREE.ExtrudeGeometry(sh, { depth: 6.4, bevelEnabled: false, curveSegments: 4 });
      wg.translate(0, 0, -3.2); wg.rotateZ(Math.PI / 2); paint.add(place(wg, x, 0.75, z), 0xa9b54d);
      for (let i = -3; i <= 3; i++) paint.box(0.03, 1.7, 0.02, x, 1.6, z + i * 0.9 + 0.45, 0x8a9640);
      this.foot(x, z, 1.8, 7.5, 0, 0.7);
    }
    // --- the plane being built: fuselage frames and stringers on trestles, a tarp-covered wing on stands
    {
      const x0 = 33, z0 = 12, L = 9, prof = (t) => 0.95 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) ** 0.7 * (1 - 0.55 * t) + 0.08;
      const yc = (t) => 2.0 + t * 0.55, n = 13;
      for (let i = 0; i <= n; i++) {
        const t = i / n, rr = prof(t), z = z0 - L / 2 + t * L;
        metal.add(place(new THREE.TorusGeometry(rr, 0.035, 5, 24), x0, yc(t), z), 0xc0c6cc);
      }
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n;
          metal.beam(V(x0 + Math.cos(a) * prof(t0), yc(t0) + Math.sin(a) * prof(t0), z0 - L / 2 + t0 * L), V(x0 + Math.cos(a) * prof(t1), yc(t1) + Math.sin(a) * prof(t1), z0 - L / 2 + t1 * L), 0.03, 0.03, 0xaeb6bd);
        }
      }
      // skin panels on the front third (riveted, primed)
      const skin = new THREE.CylinderGeometry(1, 1, 1, 24, 6, true, 0, Math.PI * 1.3);
      { const p = skin.attributes.position; for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + 0.5) * 0.32, rr = prof(t) + 0.02; p.setXYZ(i, p.getX(i) * rr, yc(t) - 2.0 + p.getZ(i) * rr, z0 - L / 2 + t * L); } skin.computeVertexNormals(); }
      paint.add(place(skin, x0, 2.0, 0, 0, 0, 0), 0xb7c25a);
      // fin skeleton
      const zt = z0 + L / 2 - 0.2;
      metal.beam(V(x0, yc(1) + 0.1, zt - 1.6), V(x0, yc(1) + 2.0, zt - 0.2), 0.05, 0.05, 0xaeb6bd); metal.beam(V(x0, yc(1) + 2.0, zt - 0.2), V(x0, yc(1) + 2.0, zt + 0.5), 0.05, 0.05, 0xaeb6bd); metal.beam(V(x0, yc(1) + 2.0, zt + 0.5), V(x0, yc(1) + 0.1, zt + 0.6), 0.05, 0.05, 0xaeb6bd);
      // trestles
      for (const z of [z0 - 2.5, z0 + 2.6]) {
        const t = (z - (z0 - L / 2)) / L, top = yc(t) - prof(t) - 0.05;
        paint.box(1.6, 0.12, 0.3, x0, top, z, 0x2f5d8a);
        for (const dx of [-0.7, 0.7]) paint.beam(V(x0 + dx * 0.6, top, z), V(x0 + dx * 1.2, 0, z), 0.08, 0.08, 0x2f5d8a);
        this.foot(x0, z, 2.6, 0.6, 0, 0.6);
      }
      this.foot(x0, z0, 2.2, L, 0, 0.35);
      // tarp-covered wing on two stands
      const wx = 42.6, wz = 14, wl = 7.5, ww = 2.0;
      for (const dz of [-2.5, 2.5]) { paint.box(1.8, 0.9, 0.16, wx, 0.45, wz + dz, 0x5b6a78); this.foot(wx, wz + dz, 2, 0.4, 0, 0.5); }
      const tg = new THREE.PlaneGeometry(ww + 1.2, wl + 0.8, 16, 30); tg.rotateX(-Math.PI / 2);
      { const p = tg.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), ex = Math.max(0, Math.abs(x) - ww / 2), ez = Math.max(0, Math.abs(z) - wl / 2); let y = 0.92 + 0.12 * Math.cos((x / ww) * Math.PI) - ex * 1.4 - ez * 1.2 + Math.sin(z * 2.3 + x * 3) * 0.02; p.setY(i, Math.max(0.25, y)); } tg.computeVertexNormals(); }
      tarp.add(place(tg, wx, 0, wz), 0x2a5fa8);
      this.foot(wx, wz, ww + 1, wl + 0.5, 0, 0.8);
    }
    // --- maintenance work platforms (yellow steps + deck + handrails)
    const platform = (x, z, ry) => {
      const c = Math.cos(ry), s = Math.sin(ry), P = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
      for (let i = 0; i < 6; i++) { const [px, pz] = P(0, -1.2 + i * 0.3); plate.box(1.0, 0.04, 0.28, px, 0.3 + i * 0.3, pz, 0xc8ccd0, ry); }
      { const [px, pz] = P(0, 0.9); plate.box(1.0, 0.06, 1.0, px, 1.85, pz, 0xc8ccd0, ry); }
      for (const dx of [-0.52, 0.52]) {
        paint.beam(V(...xz3(P(dx, -1.45), 0)), V(...xz3(P(dx, 0.5), 1.85)), 0.06, 0.12, 0xf2b01e);
        for (const dz of [0.45, 1.35]) { const [px, pz] = P(dx, dz); paint.box(0.07, 1.85, 0.07, px, 0.925, pz, 0xf2b01e, ry); }
        paint.beam(V(...xz3(P(dx, -1.3), 1.1)), V(...xz3(P(dx, 0.4), 2.9)), 0.04, 0.04, 0xf2b01e);
        { const [ax, az] = P(dx, 0.4), [bx, bz] = P(dx, 1.4); paint.beam(V(ax, 2.9, az), V(bx, 2.9, bz), 0.04, 0.04, 0xf2b01e); }
        { const [px, pz] = P(dx, 1.4); paint.box(0.05, 1.1, 0.05, px, 2.4, pz, 0xf2b01e, ry); }
      }
      for (const dz of [-1.45, 1.35]) for (const dx of [-0.45, 0.45]) { const [px, pz] = P(dx, dz); rubber.cyl(0.07, 0.07, 0.05, px, 0.07, pz, 0x111111, 10, Math.PI / 2, ry); }
      this.foot(x, z, 1.3, 3.0, ry, 0.6);
    };
    const xz3 = ([a, b], y) => [a, y, b];
    platform(-27, -17, 0.4); platform(27.5, 3, -1.2);
    // --- tow tractor (tug) by the door, with its tow bar
    this.tug(35, -32, -0.5);
    // --- traffic cones and a chock pair by the door
    for (const [x, z] of [[-17.5, -36.5], [-17.5, -33.5], [26, -36.5], [26, -33.5]]) { paint.cyl(0.03, 0.17, 0.7, x, 0.37, z, 0xff5a14, 12); paint.cyl(0.115, 0.135, 0.12, x, 0.42, z, 0xf2f2f2, 12); paint.box(0.4, 0.03, 0.4, x, 0.015, z, 0x222222); }
    for (const z of [-37, -36.6]) rubber.box(0.5, 0.15, 0.18, -12, 0.075, z, 0xd9a31a);
    // --- office block with a mezzanine walkway, stairs and railings (back-right corner)
    {
      const X0 = 18, X1 = HW, Z0 = 31, MEZ = 4, YEL = 0xf2b01e;
      block.box(X1 - X0, MEZ, 0.25, (X0 + X1) / 2, MEZ / 2, Z0, 0xd8d4cc); block.box(0.25, MEZ, HD - Z0, X0, MEZ / 2, (Z0 + HD) / 2, 0xd8d4cc);
      for (let i = 0; i < 5; i++) { const x = 21 + i * 5.2; lit.add(place(signQuad(R, 'office', 3.0, 1.2), x, 1.75, Z0 - 0.14, 0, Math.PI), 0xffffff, true); paint.box(3.2, 0.1, 0.2, x, 1.1, Z0 - 0.15, 0x3d4a55); paint.box(3.2, 0.1, 0.12, x, 2.4, Z0 - 0.15, 0x3d4a55); }
      door.box(1.0, 2.1, 0.06, 45.2, 1.05, Z0 - 0.15, 0x3d6e9e);
      // mezzanine slab and its posts
      plate.box(X1 - X0 + 0.3, 0.25, HD - 26.5, (X0 + X1) / 2, MEZ, (26.5 + HD) / 2, 0xaab0b6);
      paint.box(X1 - X0, 0.35, 0.2, (X0 + X1) / 2, MEZ - 0.3, 26.6, 0x4b5763);
      for (let x = X0 + 0.2; x < X1; x += 5.9) { paint.box(0.2, MEZ, 0.2, x, MEZ / 2, 26.7, 0x4b5763); this.foot(x, 26.7, 0.4, 0.4, 0, 0.5); }
      // upper office
      clad.box(X1 - X0, 3.2, 0.1, (X0 + X1) / 2, MEZ + 1.73, Z0 + 0.2, 0xf3f5f7);
      for (let i = 0; i < 4; i++) { const x = 22 + i * 6.5; lit.add(place(signQuad(R, 'office', 4.2, 1.6), x, MEZ + 1.95, Z0 + 0.12, 0, Math.PI), 0xffffff, true); paint.box(4.4, 0.12, 0.25, x, MEZ + 1.1, Z0 + 0.1, 0x3d4a55); }
      paint.box(X1 - X0, 0.25, HD - Z0, (X0 + X1) / 2, MEZ + 3.35, (Z0 + HD) / 2, 0xbfc5ca);
      // railings: along the walkway edge and the open end
      const rail = (a, b) => {
        paint.beam(V(a.x, MEZ + 1.1, a.z), V(b.x, MEZ + 1.1, b.z), 0.05, 0.05, YEL); paint.beam(V(a.x, MEZ + 0.55, a.z), V(b.x, MEZ + 0.55, b.z), 0.04, 0.04, YEL); paint.beam(V(a.x, MEZ + 0.2, a.z), V(b.x, MEZ + 0.2, b.z), 0.02, 0.15, YEL);
        const n = Math.ceil(a.distanceTo(b) / 1.5); for (let i = 0; i <= n; i++) { const p = a.clone().lerp(b, i / n); paint.box(0.05, 1.1, 0.05, p.x, MEZ + 0.68, p.z, YEL); }
      };
      rail(V(X0, 0, 26.5), V(X1 - 0.1, 0, 26.5)); rail(V(X0 - 0.15, 0, 28.5), V(X0 - 0.15, 0, Z0));
      // stairs up to the walkway (rising along +x)
      const S0 = 9.6, N = 22, run = (X0 - S0) / N, rise = MEZ / N, zA = 26.6, zB = 28.4;
      for (let i = 0; i < N; i++) plate.box(run + 0.02, 0.04, zB - zA, S0 + (i + 0.5) * run, (i + 1) * rise, (zA + zB) / 2, 0xb8bec4);
      for (const z of [zA - 0.05, zB + 0.05]) {
        paint.beam(V(S0, 0.1, z), V(X0, MEZ, z), 0.08, 0.3, 0x4b5763);
        paint.beam(V(S0 + 0.2, 1.05, z), V(X0, MEZ + 1.05, z), 0.05, 0.05, YEL);
        for (let i = 1; i < N; i += 4) paint.box(0.045, 1.0, 0.045, S0 + i * run, i * rise + 0.55, z, YEL);
      }
      this.foot(S0 + 4, 27.5, 9, 2.4, 0, 0.35);
      this.foot((X0 + X1) / 2, 28.8, X1 - X0, 5, 0, 0.55);
    }
    // --- wall clock panel above the office
    paint.box(0.9, 0.9, 0.06, 32, 10.2, HD - 0.05, 0x2b3a48);
  }

  radialEngine(x, y, z, ry) {
    const { paint, metal, rubber } = this.B, V = (a, b, c) => new THREE.Vector3(a, b, c);
    const g = new THREE.Group(); // build in local space, then bake through a matrix
    const parts = [];
    const add = (batch, geo, color) => parts.push([batch, geo, color]);
    add(metal, new THREE.CylinderGeometry(0.34, 0.34, 0.42, 20).rotateX(Math.PI / 2), 0x6f7880); // crankcase
    add(metal, new THREE.CylinderGeometry(0.22, 0.34, 0.3, 20).rotateX(Math.PI / 2).translate(0, 0, -0.36), 0x8d969e); // nose case
    add(metal, new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0, -0.6), 0xb0b6bb); // shaft
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const cyl = new THREE.CylinderGeometry(0.1, 0.1, 0.36, 12); cyl.translate(0, 0.5, 0); cyl.rotateZ(a); add(metal, cyl, 0x3a3f44);
      for (let f = 0; f < 6; f++) { const fin = new THREE.CylinderGeometry(0.14, 0.14, 0.012, 12); fin.translate(0, 0.37 + f * 0.05, 0); fin.rotateZ(a); add(metal, fin, 0x4a5056); }
      const head = new THREE.BoxGeometry(0.2, 0.14, 0.24); head.translate(0, 0.72, 0); head.rotateZ(a); add(metal, head, 0x8d969e);
      const push = new THREE.CylinderGeometry(0.015, 0.015, 0.42, 5); push.translate(0.07, 0.45, -0.12); push.rotateZ(a); add(metal, push, 0xb0b6bb);
      const ex = new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6); ex.rotateX(Math.PI / 2); ex.translate(0, 0.62, 0.22); ex.rotateZ(a); add(metal, ex, 0x6b4a32);
      void c; void s;
    }
    add(metal, new THREE.TorusGeometry(0.58, 0.05, 6, 30).translate(0, 0, 0.36), 0x6b4a32); // collector ring
    const M = new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), V(1, 1, 1));
    for (const [b, geo, c] of parts) b.add(geo.applyMatrix4(M), c);
    // the stand: yellow base frame on casters, a post and a mounting ring
    const c = Math.cos(ry), s = Math.sin(ry), P = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
    for (const dz of [-0.7, 0.7]) { const [px, pz] = P(0, dz); paint.box(1.6, 0.1, 0.1, px, 0.2, pz, 0xf2b01e, ry); }
    for (const dx of [-0.75, 0.75]) { const [px, pz] = P(dx, 0); paint.box(0.1, 0.1, 1.5, px, 0.2, pz, 0xf2b01e, ry); }
    for (const dx of [-0.75, 0.75]) for (const dz of [-0.7, 0.7]) { const [px, pz] = P(dx, dz); rubber.cyl(0.08, 0.08, 0.06, px, 0.08, pz, 0x1a1a1a, 10, Math.PI / 2, ry); }
    { const [px, pz] = P(0, 0.55); paint.box(0.16, y - 0.2, 0.16, px, (y + 0.2) / 2, pz, 0xf2b01e, ry); }
    { const [px, pz] = P(0, 0.45); paint.add(place(new THREE.TorusGeometry(0.4, 0.04, 6, 24), px, y, pz, 0, ry), 0xf2b01e); }
    // a two-blade prop leaning against the stand
    const [bx, bz] = P(0.95, -0.3);
    paint.add(place(new THREE.BoxGeometry(0.14, 2.2, 0.03), bx, 1.1, bz, 0, ry, 0.12), 0x6b4a32); paint.box(0.14, 0.18, 0.031, bx + 0.13, 2.1, bz, 0xf2b01e, ry, 0, 0.12);
    this.foot(x, z, 1.8, 1.8, ry, 0.9);
  }

  tug(x, z, ry) {
    const { paint, metal, rubber, plate, glow } = this.B;
    const c = Math.cos(ry), s = Math.sin(ry), P = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
    const bx = (w, h, d, dx, y, dz, color, b = paint) => { const [px, pz] = P(dx, dz); b.box(w, h, d, px, y, pz, color, ry); };
    bx(1.7, 0.55, 3.0, 0, 0.62, 0, 0xf2f2f0); bx(1.72, 0.12, 3.02, 0, 0.36, 0, 0x2b2f33);
    bx(1.6, 0.5, 1.2, 0, 1.12, -0.8, 0xf2f2f0); bx(1.62, 0.08, 1.22, 0, 1.0, -0.8, 0xe8590c);
    bx(1.5, 0.05, 1.3, 0, 0.92, 0.6, 0x555b61, plate); // deck
    bx(0.5, 0.12, 0.5, 0, 1.15, 0.5, 0x222222); bx(0.5, 0.55, 0.1, 0, 1.45, 0.78, 0x222222); // seat
    { const [px, pz] = P(0, -0.1); metal.rod(new THREE.Vector3(px, 0.95, pz), new THREE.Vector3(px, 1.45, pz + 0.15 * Math.cos(ry)), 0.025, 0x333333); metal.add(place(new THREE.TorusGeometry(0.17, 0.02, 5, 16), px, 1.48, pz, Math.PI / 2 - 0.5, ry), 0x222222); }
    for (const dx of [-0.85, 0.85]) for (const dz of [-1.0, 1.0]) { const [px, pz] = P(dx, dz); rubber.cyl(0.36, 0.36, 0.3, px, 0.36, pz, 0x1a1a1a, 18, 0, ry, Math.PI / 2); metal.cyl(0.2, 0.2, 0.31, px, 0.36, pz, 0xbfc5ca, 12, 0, ry, Math.PI / 2); }
    { const [px, pz] = P(0, -1.3); glow.cyl(0.08, 0.1, 0.14, px, 1.45, pz, new THREE.Color(1, 0.45, 0.05).multiplyScalar(4), 10); }
    bx(0.3, 0.2, 0.25, 0, 0.5, 1.6, 0x2b2f33); // hitch
    // tow bar lying on the floor beside it
    const [tx, tz] = P(1.7, 0.6); paint.box(0.08, 0.08, 3.4, tx, 0.18, tz, 0xe8590c, ry); rubber.cyl(0.12, 0.12, 0.08, tx - 0.15, 0.12, tz + 1.4, 0x1a1a1a, 10, 0, ry, Math.PI / 2);
    this.foot(x, z, 2.0, 3.4, ry, 1.0);
  }

  // ---------- outside: apron, runway, grass, buildings, hills, sky ----------
  buildOutside() {
    const { ground, apron, marks, paint, clad, glow, metal, sign } = this.B, r = rng(3);
    const quad = (batch, x0, z0, x1, z1, y, color, seg = 1) => { const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, seg, seg); g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, y, (z0 + z1) / 2); return batch.add(g, color); };
    quad(apron, -260, -170, 260, -HD - 0.35, -0.01, 0xd8d6d0);
    quad(apron, -1800, -345, 1800, -295, -0.02, 0x76797d); // runway (along x)
    quad(apron, -12, -295, 12, -170, -0.015, 0xa9aaac); // taxiway to the runway
    // grass with a little colour variation
    const gg = new THREE.PlaneGeometry(3800, 3800, 48, 48); gg.rotateX(-Math.PI / 2); gg.translate(0, -0.05, -1850);
    { const geo = ground.add(gg, 0xffffff), c = geo.attributes.color, a = new THREE.Color(0x5b7a3a), b = new THREE.Color(0x7d8f48), t = new THREE.Color(); for (let i = 0; i < c.count; i += 3) { t.copy(a).lerp(b, r()); for (let k = 0; k < 3; k++) c.setXYZ(i + k, t.r, t.g, t.b); } }
    // markings: taxi line out of the door, apron edge, runway centreline and edges, threshold bars
    quad(marks, -0.15, -170, 0.15, -HD - 0.4, 0.0, 0xe8a20c); quad(marks, -0.15, -300, 0.15, -170, 0.0, 0xe8a20c);
    for (const z of [-169.5, -HD - 0.6]) quad(marks, -258, z - 0.15, 258, z + 0.15, 0.0, 0xe8a20c);
    for (let x = -1780; x < 1780; x += 50) quad(marks, x, -320.45, x + 30, -319.55, 0.0, 0xf2f2f2);
    for (const z of [-344, -296]) quad(marks, -1800, z - 0.45, 1800, z + 0.45, 0.0, 0xf2f2f2);
    for (const x0 of [-1200, 1170]) for (let i = 0; i < 12; i++) { const z = -342 + i * 3.8 + (i >= 6 ? 6 : 0); quad(marks, x0, z, x0 + 30, z + 1.8, 0.0, 0xf2f2f2); }
    // runway / taxiway edge lights
    for (let x = -1400; x < 1400; x += 60) for (const z of [-347, -293]) glow.box(0.3, 0.3, 0.3, x, 0.15, z, new THREE.Color(1, 0.9, 0.6).multiplyScalar(2));
    for (let z = -290; z < -175; z += 15) for (const x of [-13, 13]) glow.box(0.25, 0.25, 0.25, x, 0.12, z, new THREE.Color(0.2, 0.4, 1).multiplyScalar(2));
    // buildings across the apron and around the field
    const shed = (x, z, w, d, h, color, ry = 0) => {
      clad.box(w, h, d, x, h / 2, z, color, ry);
      const roof = new THREE.CylinderGeometry(w * 0.6, w * 0.6, d, 18, 1, false, -0.85, 1.7); roof.rotateX(Math.PI / 2); roof.rotateZ(0); roof.translate(0, h - w * 0.6 * Math.cos(0.85), 0);
      clad.add(place(roof, x, 0, z, 0, ry), 0x8f99a3);
      // the facade towards us: door leaves, a window band, a number
      const fz = z + d / 2 + 0.15, n = Math.max(3, Math.round(w / 12));
      for (let i = 0; i < n; i++) this.B.door.box(w * 0.85 / n - 0.3, h * 0.72, 0.25, x - w * 0.425 + (i + 0.5) * w * 0.85 / n, h * 0.36, fz, 0xb9c6d2);
      this.B.sky.box(w * 0.85, 0.8, 0.1, x, h * 0.72 + 0.8, fz + 0.1, 0xffffff);
      paint.box(w, 0.6, 0.4, x, h * 0.72 + 0.1, fz, 0x50606e);
    };
    shed(-150, -215, 60, 40, 14, 0xe6ecf0); shed(-75, -215, 50, 36, 12, 0xf0ebe0); shed(120, -220, 70, 44, 16, 0xdde6ee);
    shed(-420, -700, 80, 50, 18, 0xb8c2cc); shed(380, -800, 60, 40, 14, 0xd0ccc0);
    // control tower
    paint.box(8, 22, 8, 210, 11, -190, 0xe8e4dc); paint.cyl(7, 6, 4.5, 210, 24.2, -190, 0x37474f, 8); glow.cyl(6.6, 6.6, 2.8, 210, 24.4, -190, new THREE.Color(0.55, 0.7, 0.8).multiplyScalar(0.8), 8); paint.cyl(7.6, 7.6, 0.6, 210, 26.8, -190, 0xe8e4dc, 8);
    metal.rod(new THREE.Vector3(210, 27, -190), new THREE.Vector3(210, 33, -190), 0.12, 0x999999);
    // windsock
    metal.rod(new THREE.Vector3(-60, 0, -180), new THREE.Vector3(-60, 7, -180), 0.08, 0xdddddd);
    for (let i = 0; i < 5; i++) paint.cyl(0.42 - i * 0.05, 0.47 - i * 0.05, 0.8, -60 + 0.4 + i * 0.8, 6.6 - i * 0.1, -180, i % 2 ? 0xffffff : 0xff5a14, 10, 0, 0, Math.PI / 2 + 0.12, true);
    // apron flood light masts
    for (const x of [-120, 0, 120]) { metal.rod(new THREE.Vector3(x, 0, -168), new THREE.Vector3(x, 22, -168), 0.25, 0xa0a5aa); paint.box(4, 1.2, 0.6, x, 22, -168, 0x50565c); glow.box(3.6, 0.9, 0.05, x, 22, -167.65, new THREE.Color(1, 0.95, 0.85).multiplyScalar(3)); }
    // the fuel bowser parked on the apron
    {
      const x = -32, z = -66, ry = 0.35, c = Math.cos(ry), s = Math.sin(ry), P = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
      const bx = (w, h, d, dx, y, dz, color, b = paint) => { const [px, pz] = P(dx, dz); b.box(w, h, d, px, y, pz, color, ry); };
      bx(2.5, 2.2, 2.2, 0, 1.6, -3.4, 0xf2f2f0); bx(2.3, 0.9, 0.05, 0, 2.1, -4.52, 0x30404c); bx(2.5, 0.4, 8.6, 0, 0.75, 0, 0x2b2f33);
      { const [px, pz] = P(0, 1.2); paint.add(place(new THREE.CylinderGeometry(1.25, 1.25, 6, 24).rotateX(Math.PI / 2), px, 2.25, pz, 0, ry), 0xf4f4f4); paint.add(place(new THREE.CylinderGeometry(1.27, 1.27, 0.5, 24).rotateX(Math.PI / 2), px, 2.25, pz, 0, ry), 0xc8102e); }
      for (const side of [-1, 1]) { const [px, pz] = P(side * 1.27, 1.6); sign.add(place(signQuad(this.atlas.R, 'jeta1', 2.4, 0.6), px, 2.35, pz, 0, ry + side * Math.PI / 2), 0xffffff, true); }
      for (const dz of [-3.3, 1.2, 2.8]) for (const dx of [-1.1, 1.1]) { const [px, pz] = P(dx, dz); this.B.rubber.cyl(0.5, 0.5, 0.4, px, 0.5, pz, 0x1a1a1a, 16, 0, ry, Math.PI / 2); }
    }
    // a parked light aircraft (simple shapes) on the apron
    {
      const x = 46, z = -82, ry = -2.3;
      const M = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));
      const add = (geo, color) => paint.add(geo.applyMatrix4(M), color);
      add(new THREE.CylinderGeometry(0.55, 0.25, 7, 14).rotateX(Math.PI / 2).translate(0, 1.6, 0.6), 0xf4f4f4);
      add(new THREE.BoxGeometry(10.5, 0.12, 1.5).translate(0, 2.3, -0.9), 0xf4f4f4);
      add(new THREE.BoxGeometry(3.4, 0.08, 1.0).translate(0, 1.7, 3.7), 0xf4f4f4); add(new THREE.BoxGeometry(0.08, 1.3, 1.0).translate(0, 2.3, 3.8), 0xc8102e);
      add(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6).translate(0, 0.7, -2.4), 0x333333);
      for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6).rotateZ(sx * 0.6).translate(sx * 0.6, 0.7, -0.4), 0x333333);
      add(new THREE.BoxGeometry(0.1, 1.8, 0.12).translate(0, 1.6, -2.95), 0x222222);
    }
    // distant hills: a painted band all around
    {
      const W = 2048, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
      const ridge = (base, amp, f, color, seed) => { const rr = rng(seed); const ph = [rr() * 6, rr() * 6, rr() * 6]; g.fillStyle = color; g.beginPath(); g.moveTo(0, H); for (let i = 0; i <= W; i += 4) { const t = (i / W) * Math.PI * 2; const y = base - amp * (0.55 * Math.sin(t * f + ph[0]) + 0.3 * Math.sin(t * f * 2.7 + ph[1]) + 0.15 * Math.sin(t * f * 6.1 + ph[2])); g.lineTo(i, y); } g.lineTo(W, H); g.fill(); };
      ridge(150, 70, 3, '#9fb3c4', 1); ridge(185, 45, 5, '#7f9a84', 2);
      const rr = rng(9); g.fillStyle = '#4e6b45'; for (let i = 0; i < 900; i++) { const xx = rr() * W, yy = 200 + rr() * 30, s = 3 + rr() * 6; g.beginPath(); g.arc(xx, yy, s, 0, Math.PI * 2); g.fill(); }
      g.fillRect(0, 222, W, H);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
      this.hillsMat = new THREE.MeshBasicMaterial({ map: t, transparent: true, fog: false, depthWrite: false });
      const h = new THREE.Mesh(new THREE.CylinderGeometry(1500, 1500, 200, 64, 1, true), this.hillsMat); h.material.side = THREE.BackSide; h.position.y = 66; h.renderOrder = -1; this.root.add(h);
    }
    // sky dome
    this.skyU = { sunDir: { value: new THREE.Vector3(0, 1, 0) }, zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunCol: { value: new THREE.Color() }, night: { value: 0 } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1900, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: SKY_FRAG }));
    sky.renderOrder = -2; sky.frustumCulled = false; this.root.add(sky); this.sky = sky;
  }

  // ---------- floor ----------
  buildFloor() {
    const W = 2 * HW, D = 2 * HD, g = new THREE.PlaneGeometry(W, D, 1, 1); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = new Float32Array(p.count * 2), uv1 = new Float32Array(p.count * 2), TILE = 4;
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / TILE; uv[i * 2 + 1] = p.getZ(i) / TILE; uv1[i * 2] = (p.getX(i) + HW) / W; uv1[i * 2 + 1] = (p.getZ(i) + HD) / D; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    this.floorU = { tDecal: { value: null }, tRefl: { value: null }, reflOn: { value: 0 }, reflK: { value: 0.9 }, reflMatrix: { value: new THREE.Matrix4() } };
    const mat = new THREE.MeshStandardMaterial({ color: 0xc4c4c4, roughness: 0.5, metalness: 0.0 });
    patchFloor(mat, this.floorU);
    this.floor = new THREE.Mesh(g, mat); this.floor.receiveShadow = true; this.floor.name = 'env_floor'; this.root.add(this.floor);
    this.floorMat = mat;
    this.paintBake();
  }
  // AO (under props, along walls) and light (lamp pools, door spill) maps for the floor
  paintBake() {
    const S = 1024, H = Math.round((S * HD) / HW), mk = () => { const c = document.createElement('canvas'); c.width = S; c.height = H; return c; };
    const toC = (g) => g.setTransform(S / (2 * HW), 0, 0, H / (2 * HD), S / 2, H / 2);
    const ao = mk(), ag = ao.getContext('2d'); ag.fillStyle = '#fff'; ag.fillRect(0, 0, S, H); toC(ag);
    // soft edges along the walls
    const edge = (x0, z0, x1, z1, gx0, gz0, gx1, gz1) => { const gr = ag.createLinearGradient(gx0, gz0, gx1, gz1); gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); ag.fillStyle = gr; ag.fillRect(x0, z0, x1 - x0, z1 - z0); };
    edge(-HW, -HD, -HW + 2.5, HD, -HW, 0, -HW + 2.5, 0); edge(HW - 2.5, -HD, HW, HD, HW, 0, HW - 2.5, 0); edge(-HW, HD - 2.5, HW, HD, 0, HD, 0, HD - 2.5);
    for (const [x, z, w, d, rot, k] of this.footprints) {
      ag.save(); ag.translate(x, z); ag.rotate(-rot);
      for (let i = 0; i < 6; i++) { const e = 0.15 + i * 0.25; ag.fillStyle = `rgba(0,0,0,${0.11 * k})`; ag.beginPath(); ag.roundRect(-w / 2 - e, -d / 2 - e, w + 2 * e, d + 2 * e, e); ag.fill(); }
      ag.restore();
    }
    const lm = mk(), lg = lm.getContext('2d'); lg.fillStyle = '#000'; lg.fillRect(0, 0, S, H); toC(lg);
    lg.globalCompositeOperation = 'lighter';
    for (const [x, z] of this.lamps) { const gr = lg.createRadialGradient(x, z, 0, x, z, 9); gr.addColorStop(0, 'rgba(255,236,205,0.55)'); gr.addColorStop(0.5, 'rgba(255,230,195,0.22)'); gr.addColorStop(1, 'rgba(255,230,190,0)'); lg.fillStyle = gr; lg.fillRect(x - 9, z - 9, 18, 18); }
    { const gr = lg.createRadialGradient(4, 26, 0, 4, 26, 12); gr.addColorStop(0, 'rgba(255,220,170,0.25)'); gr.addColorStop(1, 'rgba(255,220,170,0)'); lg.fillStyle = gr; lg.fillRect(-10, 14, 30, 20); }
    this.doorSpill = (() => { const c = mk(), g2 = c.getContext('2d'); toC(g2); const gr = g2.createLinearGradient(0, -HD, 0, -HD + 22); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g2.fillStyle = gr; g2.beginPath(); g2.moveTo(DOOR.x0, -HD); g2.lineTo(DOOR.x1, -HD); g2.lineTo(DOOR.x1 + 8, -HD + 22); g2.lineTo(DOOR.x0 - 8, -HD + 22); g2.fill(); return c; })();
    this.lampLight = lm;
    const at = new THREE.CanvasTexture(ao); at.channel = 1; at.flipY = false;
    const ltc = mk(); this.lightCanvas = ltc;
    const lt = new THREE.CanvasTexture(ltc); lt.channel = 1; lt.flipY = false; lt.colorSpace = THREE.SRGBColorSpace;
    this.floorMat.aoMap = at; this.floorMat.aoMapIntensity = 1; this.floorMat.lightMap = lt;
    this.aoTex = at; this.lightTex = lt;
  }
  // light map = lamp pools (scaled for day / night) + sky light spilling in through the door
  composeLight(lampK, spill) {
    const c = this.lightCanvas, g = c.getContext('2d');
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = Math.min(1, lampK); g.drawImage(this.lampLight, 0, 0);
    g.globalAlpha = 1; g.fillStyle = `rgb(${spill.r * 255 | 0},${spill.g * 255 | 0},${spill.b * 255 | 0})`;
    const tmp = document.createElement('canvas'); tmp.width = c.width; tmp.height = c.height; const t = tmp.getContext('2d');
    t.drawImage(this.doorSpill, 0, 0); t.globalCompositeOperation = 'source-in'; t.fillStyle = g.fillStyle; t.fillRect(0, 0, c.width, c.height);
    g.drawImage(tmp, 0, 0); g.globalCompositeOperation = 'source-over';
    this.lightTex.needsUpdate = true;
  }
  // painted lines, hatching, stains, tyre marks, joints and drains (alpha = coverage)
  paintDecal(px) {
    const W = px, H = Math.round((px * HD) / HW), c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), r = rng(21), k = W / (2 * HW);
    g.setTransform(k, 0, 0, H / (2 * HD), W / 2, H / 2);
    const lw = (m) => { g.lineWidth = m; };
    // large-scale tonal variation, so the tiled concrete doesn't repeat visibly
    for (let i = 0; i < 260; i++) {
      const x = (r() - 0.5) * 2 * HW, z = (r() - 0.5) * 2 * HD, rad = 2 + r() * 7, dark = r() < 0.6;
      const gr = g.createRadialGradient(x, z, 0, x, z, rad); const v = dark ? '70,68,64' : '205,205,200';
      gr.addColorStop(0, `rgba(${v},${0.05 + r() * 0.07})`); gr.addColorStop(1, `rgba(${v},0)`); g.fillStyle = gr; g.fillRect(x - rad, z - rad, 2 * rad, 2 * rad);
    }
    // saw-cut expansion joints every 6 m
    g.strokeStyle = 'rgba(28,27,26,0.75)'; lw(0.035);
    for (let x = -HW + 6; x < HW; x += 6) { g.beginPath(); g.moveTo(x, -HD); g.lineTo(x, HD); g.stroke(); }
    for (let z = -HD + 6; z < HD; z += 6) { g.beginPath(); g.moveTo(-HW, z); g.lineTo(HW, z); g.stroke(); }
    // tyre marks curving in from the door
    g.strokeStyle = 'rgba(25,24,24,0.10)'; lw(0.22);
    for (let i = 0; i < 9; i++) {
      const sx = -14 + r() * 34, ex = -6 + r() * 12, ez = -8 + r() * 14, tw = 1.6 + r() * 2.2;
      for (const o of [-tw / 2, tw / 2]) { g.beginPath(); g.moveTo(sx + o, -HD); g.bezierCurveTo(sx + o, -HD + 14, ex + o + (r() - 0.5) * 8, ez - 12, ex + o, ez); g.stroke(); }
    }
    // oil stains (several overlapping blots, darker in the middle)
    const stain = (x, z, s, a = 0.45) => { for (let i = 0; i < 7; i++) { const ox = x + (r() - 0.5) * s, oz = z + (r() - 0.5) * s, rr = s * (0.25 + r() * 0.5); const gr = g.createRadialGradient(ox, oz, 0, ox, oz, rr); gr.addColorStop(0, `rgba(22,18,14,${a})`); gr.addColorStop(0.7, `rgba(30,26,20,${a * 0.5})`); gr.addColorStop(1, 'rgba(30,26,20,0)'); g.fillStyle = gr; g.fillRect(ox - rr, oz - rr, 2 * rr, 2 * rr); } };
    stain(-34, 1.5, 1.6, 0.6); stain(35, -31, 2.2, 0.5); stain(44, -8, 1.4, 0.5); stain(-3, 2.5, 1.2, 0.18); stain(6, -6, 0.9, 0.15); stain(-46, -11, 1.2, 0.4); stain(-14, -30, 1, 0.3); stain(33, 12, 1.4, 0.3);
    for (let i = 0; i < 30; i++) stain((r() - 0.5) * 2 * HW * 0.9, (r() - 0.5) * 2 * HD * 0.9, 0.3 + r() * 0.6, 0.12 + r() * 0.15);
    // hatched zones: yellow / black, or red / white for fire points
    const hatch = (x0, z0, x1, z1, a = '#f2b01e', b = '#1b1b1b', w = 0.3) => {
      g.save(); g.beginPath(); g.rect(x0, z0, x1 - x0, z1 - z0); g.clip(); g.fillStyle = b; g.globalAlpha = 0.92; g.fillRect(x0, z0, x1 - x0, z1 - z0);
      g.fillStyle = a; for (let t = x0 - (z1 - z0); t < x1; t += w * 2) { g.beginPath(); g.moveTo(t, z0); g.lineTo(t + w, z0); g.lineTo(t + w + (z1 - z0), z1); g.lineTo(t + (z1 - z0), z1); g.fill(); }
      g.restore(); g.globalAlpha = 1;
    };
    hatch(-HW, -HD, HW, -HD + 1.2); // under the door tracks
    hatch(9.4, 24.8, 17.5, 26.3); hatch(-HW + 0.2, -25, -HW + 1.4, -22); // stair foot, electrical panel
    for (const z of FIRE_L) hatch(-HW, z - 0.6, -HW + 1, z + 0.6, '#e8e8e8', '#c8102e', 0.15); for (const z of FIRE_R) hatch(HW - 1, z - 0.6, HW, z + 0.6, '#e8e8e8', '#c8102e', 0.15);
    // yellow lines: walkways along the walls, the build bay, a lead-in line from the door
    g.strokeStyle = 'rgba(242,176,30,0.95)'; lw(0.12);
    const line = (pts, w = 0.12) => { lw(w); g.beginPath(); g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.stroke(); };
    line([[-42.6, -38.5], [-42.6, 24]]); line([[39.5, -38.5], [39.5, 24.5]]); line([[-42.6, 24], [8.5, 24]]);
    line([[-24, -22], [24, -22], [24, 22], [-24, 22], [-24, -22]], 0.15);
    g.setLineDash([1.2, 0.8]); line([[-23.4, -21.4], [23.4, -21.4], [23.4, 21.4], [-23.4, 21.4], [-23.4, -21.4]], 0.06); g.setLineDash([]);
    line([[0, -38.6], [0, -22]], 0.15);
    g.fillStyle = 'rgba(242,176,30,0.95)'; g.beginPath(); g.moveTo(0, -24); g.lineTo(-0.7, -26); g.lineTo(0.7, -26); g.fill();
    for (const [x, z] of [[-24, -22], [24, -22], [24, 22], [-24, 22]]) { g.fillRect(x - 0.6, z - 0.6, 1.2, 1.2); }
    // stencilled text
    const words = (t, x, z, size, rot = 0, color = 'rgba(242,176,30,0.92)') => { g.save(); g.translate(x, z); g.rotate(rot); g.scale(1, 1); g.fillStyle = color; g.font = `900 ${size}px system-ui, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 0, 0); g.restore(); };
    words('BUILD BAY 1', 0, 23.4, 1.6, Math.PI); words('KEEP CLEAR', -32, -37.6, 0.9, Math.PI); words('KEEP CLEAR', 34, -37.6, 0.9, Math.PI); words('MAX SPAN 46 m', 0, -20.2, 0.8, Math.PI);
    words('NO SMOKING', -30, 27, 0.7, Math.PI);
    // trench drain along the door, round floor drains
    g.fillStyle = 'rgba(20,20,22,0.95)'; g.fillRect(-HW + 1, -HD + 1.6, 2 * HW - 2, 0.3);
    g.fillStyle = 'rgba(150,150,150,0.9)'; for (let x = -HW + 1; x < HW - 1; x += 0.08) g.fillRect(x, -HD + 1.62, 0.03, 0.26);
    for (const [x, z] of [[-30, -10], [30, -10], [-30, 14], [12, 14], [-12, -14]]) {
      g.fillStyle = 'rgba(70,70,72,0.95)'; g.beginPath(); g.arc(x, z, 0.28, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(15,15,15,0.95)'; for (let i = -2; i <= 2; i++) g.fillRect(x - 0.2, z + i * 0.08 - 0.02, 0.4, 0.035);
    }
    const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.floorU.tDecal.value?.dispose(); this.floorU.tDecal.value = t;
  }

  // ---------- lights ----------
  buildLights() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight(0xdfe8f2, 0x6b655d, 0.5); s.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 3); sun.castShadow = true; sun.shadow.autoUpdate = false;
    const sc = sun.shadow.camera; sc.left = sc.bottom = -72; sc.right = sc.top = 72; sc.near = 10; sc.far = 320; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    s.add(sun); s.add(sun.target); this.sun = sun;
    // the key over the build bay (a cluster of high-bay lamps): soft, wide, shadows straight down for contact
    const key = new THREE.SpotLight(0xfff4e6, 650, 0, 0.95, 1, 2); key.position.set(3, EAVE - 1.5, 5); key.target.position.set(0, 0, 0);
    key.castShadow = true; key.shadow.autoUpdate = false; key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02; key.shadow.camera.near = 2; key.shadow.camera.far = 40; key.shadow.radius = 4;
    s.add(key); s.add(key.target); this.key = key;
  }
  // volumetric-looking shafts: the door opening and the skylights extruded along the sun direction
  buildShafts() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      vertexShader: 'attribute float fade; varying float vF; varying vec3 vW; void main(){ vF = fade; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform vec3 tint; varying float vF; varying vec3 vW; void main(){ float n = 0.75 + 0.25 * sin(vW.x * 0.9 + vW.z * 0.6) * sin(vW.y * 1.3 - vW.x * 0.4); gl_FragColor = vec4(tint * vF * n, 1.0); }',
    });
    this.shaftMat = mat; this.shafts = new THREE.Mesh(new THREE.BufferGeometry(), mat); this.shafts.frustumCulled = false; this.shafts.renderOrder = 5; this.root.add(this.shafts);
    // dust motes (Ultra): positions inside the shafts, drifting in the vertex shader
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, tint: { value: new THREE.Color() }, scale: { value: 600 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: `uniform float time; uniform float scale; attribute float seed; varying float vA;
        void main(){ vec3 p = position + vec3(sin(time * 0.13 + seed * 17.0), sin(time * 0.07 + seed * 5.0) * 0.6 - 0.15 * fract(time * 0.01 + seed), cos(time * 0.11 + seed * 11.0)) * 0.35;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(scale * (0.008 + 0.008 * fract(seed * 7.3)) / -mv.z, 1.0, 3.5);
          vA = 0.5 + 0.5 * sin(time * 0.5 + seed * 40.0); }`,
      fragmentShader: 'uniform vec3 tint; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(tint * a * vA, 1.0); }',
    });
    this.dust = new THREE.Points(new THREE.BufferGeometry(), this.dustMat); this.dust.frustumCulled = false; this.dust.renderOrder = 6; this.root.add(this.dust);
  }
  shaftGeometry(dir) { // dir: unit vector pointing from the scene towards the sun
    const pos = [], fade = [], dust = [], seeds = [], r = rng(5);
    const inward = dir.clone().negate(); // the way the light travels
    const prism = (corners, len, f0) => { // corners of the aperture (4, in order), extruded along 'inward' to the floor
      const far = corners.map((c) => { const t = Math.min(len, c.y / Math.max(0.05, -inward.y)); return c.clone().addScaledVector(inward, t); });
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4], c = far[(i + 1) % 4], d = far[i];
        pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
        fade.push(f0, f0, 0, f0, 0, 0);
      }
      return far;
    };
    if (inward.z > 0.05 && inward.y < -0.05) { // the door faces -z: sun from the door side
      const C = [new THREE.Vector3(DOOR.x0, 0.01, -HD), new THREE.Vector3(DOOR.x1, 0.01, -HD), new THREE.Vector3(DOOR.x1, DOOR.h, -HD), new THREE.Vector3(DOOR.x0, DOOR.h, -HD)];
      prism(C, 200, 0.5);
      for (let i = 0; i < 900; i++) { const p0 = new THREE.Vector3(DOOR.x0 + r() * (DOOR.x1 - DOOR.x0), r() * DOOR.h, -HD); const t = r() * p0.y / Math.max(0.05, -inward.y); dust.push(...p0.addScaledVector(inward, t).toArray()); seeds.push(r()); }
    }
    if (inward.y < -0.2) for (const [a, b] of [[-34, -30], [-14, -10], [10, 14], [30, 34]]) {
      for (let z = -HD + 0.5; z < HD - 1; z += 10) {
        const C = [new THREE.Vector3(a, roofY(a), z), new THREE.Vector3(b, roofY(b), z), new THREE.Vector3(b, roofY(b), z + 9), new THREE.Vector3(a, roofY(a), z + 9)];
        prism(C, 200, 0.22);
        for (let i = 0; i < 25; i++) { const p0 = new THREE.Vector3(a + r() * (b - a), 0, z + r() * 9); p0.y = roofY(p0.x); const t = r() * p0.y / -inward.y; const q = p0.addScaledVector(inward, t); if (Math.abs(q.x) < HW && Math.abs(q.z) < HD) { dust.push(...q.toArray()); seeds.push(r()); } }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('fade', new THREE.Float32BufferAttribute(fade, 1));
    this.shafts.geometry.dispose(); this.shafts.geometry = g;
    const d = new THREE.BufferGeometry(); d.setAttribute('position', new THREE.Float32BufferAttribute(dust, 3)); d.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    this.dust.geometry.dispose(); this.dust.geometry = d;
  }

  // ---------- time of day ----------
  setHour(h) {
    h = ((+h % 24) + 24) % 24; if (Math.abs(h - this.hour) < 0.01) return false; this.hour = h;
    const a = ((h - 6) / 12) * Math.PI, elev = Math.sin(a) * 0.95, day = THREE.MathUtils.smoothstep(elev, -0.08, 0.15);
    // 6 h east (+x), noon on the door side (-z), 18 h west; the door faces a little towards the sun's path all day
    const az = THREE.MathUtils.clamp(a, 0, Math.PI), e = Math.max(Math.asin(THREE.MathUtils.clamp(elev, -1, 1)), 0.03);
    const hz = new THREE.Vector2(Math.cos(az), -Math.sin(az) - 0.6).normalize();
    const dir = new THREE.Vector3(hz.x * Math.cos(e), Math.sin(e), hz.y * Math.cos(e)).normalize();
    const low = 1 - THREE.MathUtils.smoothstep(elev, 0.02, 0.35); // golden hour
    const sunCol = new THREE.Color(1, 0.97, 0.92).lerp(new THREE.Color(1, 0.62, 0.32), low);
    this.sunDir = dir;
    this.sun.position.copy(dir).multiplyScalar(160); this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(sunCol); this.sun.intensity = 3.6 * day; this.sun.visible = day > 0.01;
    if (!this.sun.visible) { this.sun.intensity = 0; }
    this.sun.shadow.needsUpdate = true; this.key.shadow.needsUpdate = true;
    // sky
    const zen = new THREE.Color(0.09, 0.26, 0.72).lerp(new THREE.Color(0.012, 0.02, 0.045), 1 - day), hor = new THREE.Color(0.42, 0.6, 0.9).lerp(new THREE.Color(0.95, 0.6, 0.38), low * day).lerp(new THREE.Color(0.03, 0.04, 0.07), 1 - day);
    this.skyU.sunDir.value.copy(dir); this.skyU.zenith.value.copy(zen).multiplyScalar(1.2); this.skyU.horizon.value.copy(hor).multiplyScalar(1.15); this.skyU.sunCol.value.copy(sunCol).multiplyScalar(day * 1.5); this.skyU.night.value = 1 - day;
    this.hillsMat.color.setScalar(0.25 + 0.75 * day).multiply(new THREE.Color(1, 1, 1).lerp(new THREE.Color(1, 0.85, 0.75), low * day));
    this.scene.fog = new THREE.Fog(hor.clone().multiplyScalar(1.15), 300, 1700);
    // interior: daylight glazing, lamps, the fill, the light map
    const glaze = new THREE.Color(0.9, 0.95, 1.05).multiplyScalar(0.4 + 2.6 * day).lerp(new THREE.Color(0.03, 0.04, 0.07), 1 - day);
    this.M.sky.color.copy(glaze);
    this.hemi.color.set(0xdfe8f2).multiplyScalar(0.6 + 0.4 * day); this.hemi.groundColor.set(0xa49d92); this.hemi.intensity = 0.55 + 0.45 * day;
    this.key.intensity = 650 + 300 * (1 - day);
    this.M.lit.color.setScalar(1.4 + 0.6 * (1 - day));
    this.composeLight(0.75 + 0.5 * (1 - day), new THREE.Color(0.55, 0.62, 0.72).multiplyScalar(day * 0.9).lerp(new THREE.Color(1, 0.75, 0.5), low * day * 0.6));
    this.floorMat.lightMapIntensity = 0.8;
    this.shaftMat.uniforms.tint.value.copy(sunCol).multiplyScalar(0.022 * day);
    this.dustMat.uniforms.tint.value.copy(sunCol).multiplyScalar(0.22 * day);
    this.shaftGeometry(dir); this.shafts.visible = this.dust.visible = false; this.applyTier();
    return true;
  }

  // ---------- quality ----------
  setTier(tier) {
    if (this.tier === tier) return; this.tier = tier;
    const hi = tier === 'high' || tier === 'ultra';
    this.paintDecal(hi ? 3072 : tier === 'medium' ? 2048 : 1536);
    const n = tier === 'ultra' ? 4096 : hi ? 2048 : 1024;
    for (const l of [this.sun, this.key]) { const m = l === this.key ? n / 2 : n; if (l.shadow.mapSize.x !== m) { l.shadow.mapSize.set(m, m); l.shadow.map?.dispose(); l.shadow.map = null; } l.shadow.needsUpdate = true; }
    this.key.castShadow = tier !== 'low';
    this.loadTextures(hi ? 'hi' : 'lo'); this.loadProps(hi ? 512 : 256);
    this.applyTier();
  }
  applyTier() {
    const hi = this.tier === 'high' || this.tier === 'ultra', sunUp = this.sun.visible && this.sunDir?.y > 0.05;
    this.reflect = hi; this.floorU.reflOn.value = hi ? 1 : 0; this.floorMat.envMapIntensity = hi ? 0.35 : 1;
    this.shafts.visible = hi && sunUp; this.dust.visible = this.tier === 'ultra' && sunUp;
  }
  get animating() { return this.dust.visible; }
  update(dt) { this.dustMat.uniforms.time.value += dt; }

  loadTextures(set) {
    if (this.texSet === set || (this.texSet === 'hi' && set === 'lo')) return; // never downgrade (already in memory)
    this.texSet = set;
    const L = new THREE.TextureLoader(), aniso = this.renderer.capabilities.getMaxAnisotropy();
    const px = (name) => ({ floor: [2048, 1024], plate: [512, 256], plywood: [512, 256], rubber: [512, 256] }[name] || [1024, 512])[set === 'hi' ? 0 : 1];
    const load = (name, mats, rep = 1) => {
      const sz = px(name), out = {};
      let left = 3; this.loading++;
      for (const [suf, key] of [['c', 'map'], ['n', 'normalMap'], ['r', 'roughnessMap']]) {
        loadBitmapTexture(L, `${BASE}${name}_${sz}_${suf}.webp`, (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = name === 'floor' || name === 'apron' ? aniso : Math.min(aniso, 4); t.repeat.setScalar(rep);
          if (suf === 'c') t.colorSpace = THREE.SRGBColorSpace;
          out[key] = t;
          // keep a decoded ImageBitmap (not the <img>, whose pixels the browser may drop and decode again): the
          // hangar re-uploads its textures every time a flight ends
          decoded(t).then(() => { if (--left === 0) {
            for (const m of mats) { for (const k in out) { m[k]?.dispose?.(); m[k] = out[k]; } if (m.normalMap) m.normalScale.setScalar(name === 'floor' ? 0.6 : 1); if (name !== 'floor') m.roughness = 1; m.needsUpdate = true; } // the maps carry the roughness
            this.loading--; this.onChange('tex');
          } });
        }, () => { if (--left === 0) this.loading--; });
      }
    };
    load('floor', [this.floorMat]); load('cladding', [this.M.clad]); load('door', [this.M.door]); load('plate', [this.M.plate]);
    load('plywood', [this.M.wood]); load('block', [this.M.block]); load('apron', [this.M.apron]); load('rubber', [this.M.rubber]);
  }

  // ---------- CC0 props (instanced) ----------
  loadProps(size) {
    if (this.propSet && this.propSet >= size) return;
    this.propSet = size; this.loading++;
    const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(`${BASE}props_${size}.glb`, (gltf) => {
      this.loading--;
      if (this.props) { this.root.remove(this.props); this.props.traverse((o) => { o.geometry?.dispose(); o.dispose?.(); }); }
      this.props = this.instanceProps(gltf.scene); this.root.add(this.props);
      this.onChange('props');
    }, undefined, (e) => { this.loading--; console.warn('hangar props failed to load', e); });
  }
  instanceProps(src) {
    const out = new THREE.Group(); out.name = 'env_props';
    src.updateMatrixWorld(true);
    const byId = {}; for (const c of src.children) byId[c.name] = c;
    const P = PROP_LAYOUT();
    const groups = {}; for (const p of P) (groups[p[0]] ||= []).push(p);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(), T = new THREE.Vector3(), box = new THREE.Box3();
    let foot = false;
    for (const id in groups) {
      const node = byId[id]; if (!node) continue;
      const meshes = []; node.traverse((o) => { if (o.isMesh) meshes.push(o); });
      box.makeEmpty(); for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
      const sz = box.getSize(new THREE.Vector3());
      for (const m of meshes) {
        const im = new THREE.InstancedMesh(m.geometry, m.material, groups[id].length);
        groups[id].forEach(([, x, y, z, ry, s = 1, rx = 0, rz = 0], i) => {
          M.compose(T.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz, 'YXZ')), S.setScalar(s)).multiply(m.matrixWorld); im.setMatrixAt(i, M);
        });
        im.castShadow = im.receiveShadow = true; im.computeBoundingSphere();
        m.material.envMapIntensity = 1; m.material.side = THREE.FrontSide; out.add(im); // (Poly Haven flags them double-sided: twice the raster work for nothing)
      }
      for (const [, x, y, z, ry, s = 1] of groups[id]) if (y < 0.05) { this.foot(x, z, sz.x * s, sz.z * s, ry, 0.9); foot = true; }
    }
    if (foot) { this.repaintAO(); }
    return out;
  }
  // a soft darkening on the floor under the plane (its bounding box, shrunk: wings are high, the gear is narrow)
  setPlaneFootprint(box) {
    const f = box.isEmpty() ? null : [(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, (box.max.x - box.min.x) * 0.45, (box.max.z - box.min.z) * 0.6, 0, 0.45];
    const old = this.planeFoot; if (!f && !old) return;
    if (f && old && f.every((v, i) => Math.abs(v - old[i]) < 0.25)) return;
    this.planeFoot = f; this.repaintAO();
  }
  repaintAO() { // footprints changed: redraw the AO canvas (keeps the light map)
    const img = this.floorMat.aoMap.image, ag = img.getContext('2d'), S = img.width, H = img.height;
    ag.setTransform(1, 0, 0, 1, 0, 0); ag.fillStyle = '#fff'; ag.fillRect(0, 0, S, H); ag.setTransform(S / (2 * HW), 0, 0, H / (2 * HD), S / 2, H / 2);
    const edge = (x0, z0, x1, z1, gx0, gz0, gx1, gz1) => { const gr = ag.createLinearGradient(gx0, gz0, gx1, gz1); gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); ag.fillStyle = gr; ag.fillRect(x0, z0, x1 - x0, z1 - z0); };
    edge(-HW, -HD, -HW + 2.5, HD, -HW, 0, -HW + 2.5, 0); edge(HW - 2.5, -HD, HW, HD, HW, 0, HW - 2.5, 0); edge(-HW, HD - 2.5, HW, HD, 0, HD, 0, HD - 2.5);
    for (const [x, z, w, d, rot, k] of this.planeFoot ? [...this.footprints, this.planeFoot] : this.footprints) {
      ag.save(); ag.translate(x, z); ag.rotate(-rot);
      for (let i = 0; i < 6; i++) { const e = 0.08 + i * 0.16; ag.fillStyle = `rgba(0,0,0,${0.1 * k})`; ag.beginPath(); ag.roundRect(-w / 2 - e + 0.1, -d / 2 - e + 0.1, Math.max(0.05, w + 2 * e - 0.2), Math.max(0.05, d + 2 * e - 0.2), e); ag.fill(); }
      ag.restore();
    }
    this.aoTex.needsUpdate = true;
  }

  // ---------- environment map: the hangar itself, seen from the build bay ----------
  bakeEnvironment(hidden = []) {
    const r = this.renderer;
    if (!this.cubeRT) { this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType }); this.cubeCam = new THREE.CubeCamera(0.5, 6000, this.cubeRT); this.cubeCam.position.set(0, 5, 2); this.pmrem = new THREE.PMREMGenerator(r); }
    if (!this.scene.environment) { this.room = this.pmrem.fromScene(new RoomEnvironment(), 0.04); this.scene.environment = this.room.texture; this.scene.environmentIntensity = 0.5; }
    const vis = hidden.map((o) => o.visible); hidden.forEach((o) => (o.visible = false));
    const sh = [this.shafts.visible, this.dust.visible, this.floorU.reflOn.value]; this.shafts.visible = this.dust.visible = false; this.floorU.reflOn.value = 0;
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = true; // first frame: draw the shadow maps for the bake too
    for (let i = 0; i < 2; i++) { // two bounces
      this.cubeCam.update(r, this.scene);
      const env = this.pmrem.fromCubemap(this.cubeRT.texture);
      if (this.envRT) this.envRT.dispose(); this.envRT = env;
      this.scene.environment = env.texture; this.scene.environmentIntensity = 1.0;
    }
    r.shadowMap.autoUpdate = auto;
    hidden.forEach((o, i) => (o.visible = vis[i])); [this.shafts.visible, this.dust.visible, this.floorU.reflOn.value] = sh;
  }

  // ---------- planar floor reflection (High / Ultra) ----------
  setupReflection(getHidden) {
    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.reflRT = rt; this.floorU.tRefl.value = rt.texture;
    const vc = new THREE.PerspectiveCamera(), clip = new THREE.Vector4(), q = new THREE.Vector4(), plane = new THREE.Plane(), N = new THREE.Vector3(0, 1, 0), P0 = new THREE.Vector3();
    const camPos = new THREE.Vector3(), look = new THREE.Vector3(), target = new THREE.Vector3(), rot = new THREE.Matrix4(), size = new THREE.Vector2();
    this.floor.onBeforeRender = (renderer, scene, camera) => {
      if (!this.reflect || camera !== this.viewCamera || this.floorU.reflOn.value < 0.5) return; // not for shadow / cube / its own passes
      camPos.setFromMatrixPosition(camera.matrixWorld);
      if (camPos.y <= 0.01) return;
      renderer.getDrawingBufferSize(size); const k = this.tier === 'ultra' ? 0.36 : 0.28, w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
      // mirror the camera in the floor plane (y = 0)
      rot.extractRotation(camera.matrixWorld);
      look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
      vc.position.set(camPos.x, -camPos.y, camPos.z);
      target.set(look.x, -look.y, look.z);
      vc.up.set(0, 1, 0).applyMatrix4(rot); vc.up.y *= -1; vc.lookAt(target);
      vc.far = camera.far; vc.near = camera.near; vc.updateMatrixWorld(); vc.projectionMatrix.copy(camera.projectionMatrix);
      this.floorU.reflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
      // oblique near plane = the floor, so nothing below it is drawn
      plane.setFromNormalAndCoplanarPoint(N, P0.set(0, 0, 0)).applyMatrix4(vc.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const pm = vc.projectionMatrix.elements;
      q.set((Math.sign(clip.x) + pm[8]) / pm[0], (Math.sign(clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
      clip.multiplyScalar(2 / clip.dot(q)); pm[2] = clip.x; pm[6] = clip.y; pm[10] = clip.z + 1; pm[14] = clip.w;
      // draw everything but the floor, the overlays and the small props (too small to read in a blurred reflection)
      const hidden = [this.floor, this.shafts, this.dust, this.props, ...getHidden()].filter(Boolean), vis = hidden.map((o) => o.visible);
      hidden.forEach((o) => (o.visible = false));
      const prevRT = renderer.getRenderTarget(), prevAuto = renderer.shadowMap.autoUpdate, prevXr = renderer.xr.enabled;
      renderer.shadowMap.autoUpdate = false; renderer.xr.enabled = false;
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, vc);
      renderer.setRenderTarget(prevRT); renderer.shadowMap.autoUpdate = prevAuto; renderer.xr.enabled = prevXr;
      hidden.forEach((o, i) => (o.visible = vis[i]));
    };
  }

  // ---------- GPU residency: nothing heavy stays on the GPU during a flight ----------
  // release() frees the textures, geometry buffers, shadow maps and render targets (their CPU-side images, canvases
  // and arrays stay, so nothing is downloaded or decoded again); restoreStep() re-uploads the textures a few per frame
  // on the way back. Compiled shader programs are kept (tiny, and recompiling them would hitch).
  heavyTextures() {
    const set = new Set(), keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'lightMap', 'emissiveMap'];
    const mat = (m) => { for (const k of keys) if (m?.[k]?.isTexture) set.add(m[k]); };
    for (const m of Object.values(this.M)) mat(m); mat(this.floorMat); mat(this.hillsMat);
    if (this.floorU.tDecal.value) set.add(this.floorU.tDecal.value);
    this.props?.traverse((o) => { if (o.material) [].concat(o.material).forEach(mat); });
    return [...set];
  }
  release() {
    if (this.released) return; this.released = true; this.restoreQ = null;
    for (const t of this.heavyTextures()) t.dispose();
    this.root.traverse((o) => { if (o.geometry && o !== this.sky) o.geometry.dispose(); });
    for (const l of [this.sun, this.key]) { l.shadow.map?.dispose(); l.shadow.map = null; l.shadow.needsUpdate = true; }
    this.reflRT?.dispose(); this.cubeRT?.dispose();
  }
  get restoring() { return !!this.restoreQ; }
  beginRestore() {
    if (!this.released) return false;
    this.released = false;
    this.restoreQ = this.heavyTextures().filter((t) => t.image).sort((a, b) => (b.image.width * b.image.height) - (a.image.width * a.image.height));
    this.restoreFrames = 0;
    for (const l of [this.sun, this.key]) l.shadow.needsUpdate = true;
    return true;
  }
  // re-upload some textures this frame; true when everything is back
  restoreStep() {
    const q = this.restoreQ; if (!q) return true;
    const t0 = performance.now(); // ~30 ms of uploads per frame behind the hidden canvas (~0.3 s in all), everything after 20 frames
    do this.renderer.initTexture(q.shift()); while (q.length && (performance.now() - t0 < 30 || this.restoreFrames > 20));
    this.restoreFrames++;
    if (q.length) return false;
    this.restoreQ = null; return true;
  }

  // keep the orbit camera inside the shell and out of the office block (pull it in along the line to the target)
  clampCamera(camera, target) {
    const d = camera.position.clone().sub(target), len = d.length(); if (len < 1e-4) return false;
    const dir = d.clone().divideScalar(len), ray = new THREE.Ray(target.clone(), dir);
    let t = len;
    // leaving the room: the exit distance along the ray (target is assumed inside)
    if (ROOM.containsPoint(target)) {
      for (let a = 0; a < 3; a++) { const o = target.getComponent(a), v = dir.getComponent(a); if (Math.abs(v) < 1e-6) continue; const lim = v > 0 ? ROOM.max.getComponent(a) : ROOM.min.getComponent(a); t = Math.min(t, (lim - o) / v); }
    }
    for (const b of OBSTACLES) { if (b.containsPoint(target)) continue; const hit = ray.intersectBox(b, new THREE.Vector3()); if (hit) t = Math.min(t, hit.distanceTo(target) - 0.4); }
    if (t < len - 1e-3) { camera.position.copy(target).addScaledVector(dir, Math.max(0.5, t)); return true; }
    return false;
  }
}

// [model id, x, y, z, rotY, scale?, rotX?, rotZ?]: the Poly Haven props around the hangar
function PROP_LAYOUT() {
  const P = [], D = Math.PI / 180, add = (...a) => P.push(a), bench = 0.925;
  // workbench tops (left wall, bench centres x = -47.45)
  add('bench_vice_01', -47.15, bench, -18.9, 90 * D); add('bench_vice_01', -47.15, bench, -8.4, 90 * D);
  add('metal_toolbox', -47.55, bench, -17.3, 80 * D); add('metal_toolbox', -47.5, bench, -4.9, 95 * D);
  add('spray_paint_bottles', -47.6, bench, -14.0, 90 * D); add('spray_paint_bottles', -47.6, bench, -13.85, 70 * D);
  add('drill_press_01', -47.5, bench, -11.6, 90 * D);
  add('tire_pump', -46.6, 0, -16.2, 30 * D); add('metal_jerrycan', -47.3, 0, -15.5, 90 * D);
  add('tool_cart', -44.8, 0, -12.6, 105 * D); add('tool_cart', 27.2, 0, -8, -70 * D);
  add('metal_tool_chest', -47.4, 0, -2.0, 90 * D); add('metal_tool_chest', -47.4, 0.645, -2.0, 90 * D); add('metal_toolbox', -47.35, 1.29, -2.1, 100 * D);
  add('metal_tool_chest', -30.5, 0, 0.0, -60 * D);
  add('ladder_sectioned_01', -47.75, 0, 14.0, 90 * D, 1.4, -12 * D); add('ladder_sectioned_01', 47.75, 0, -19.5, -90 * D, 1.4, -12 * D);
  // stores corner: shelving, crates, boxes, bags
  for (let i = 0; i < 8; i++) add('steel_frame_shelves_02', -26.5 + i * 0.62, 0, 39.4, 180 * D);
  add('wooden_crate_02', -30, 0.145, 36.5, 90 * D); add('wooden_crate_02', -28.6, 0.145, 36.5, 90 * D); add('wooden_crate_01', -29.3, 0.6, 36.4, 0, 1.2);
  add('wooden_crate_01', -44.5, 0.145, 36.0, 5 * D, 1.3); add('wooden_crate_01', -44.4, 0.6, 36.1, -8 * D, 1.3); add('cardboard_box_01', -44.2, 1.05, 36.2, 20 * D, 1.4);
  add('cardboard_box_01', -38.3, 0.145, 24.8, 10 * D, 1.5); add('cardboard_box_01', -37.6, 0.145, 25.2, 60 * D, 1.5); add('cardboard_box_01', -38.0, 0.66, 25.0, 40 * D, 1.5);
  add('cement_bag', -44.2, 0.145, -33.3, 0); add('cement_bag', -44.0, 0.33, -33.2, 10 * D); add('cement_bag', -42.7, 0.145, -34.2, 90 * D);
  add('wooden_crate_02', -31.5, 0, 33.0, 0.1); add('wooden_crate_01', -31.4, 0.46, 33.0, 0.3); add('metal_toolbox', -31.3, 0.88, 33.1, 0.5);
  add('industrial_storage_cart', 12.8, 0, 30.5, 180 * D); add('hand_truck', -40.2, 0, -31.5, 140 * D);
  // compressor / welding corner (right wall)
  add('old_military_compressor', 45.8, 0, -8.5, 0); add('portable_welding_cart', 44.6, 0, -2.6, -110 * D); add('portable_generator', 45.2, 0, -14.6, -90 * D);
  add('propane_tank', 47.4, 0, -16.6, 0); add('propane_tank', 47.4, 0, -17.1, 0.4); add('propane_tank', 46.95, 0, -16.85, 1);
  // drums on a spill pallet + cans (right front)
  for (const [x, z, k] of [[46.6, -25.6, 1], [46.0, -25.6, 2], [46.6, -25.0, 2], [46.0, -25.0, 1], [46.6, -24.4, 1], [45.4, -25.4, 1]]) add(k === 1 ? 'Barrel_01' : 'Barrel_02', x, 0.15, z, x * 7);
  add('plastic_jerrycan', 45.0, 0, -23.6, 0.3); add('plastic_jerrycan', 45.25, 0, -23.3, -0.2); add('metal_jerrycan', 44.8, 0, -24.3, 1.4);
  add('Barrel_02', -33, 0, -26, 0); add('Barrel_01', -33.6, 0, -25.6, 1); add('Barrel_01', -45.8, 0, 30, 2); // a couple used as bins
  // fire extinguishers at every fire point
  for (const z of FIRE_L) add('korean_fire_extinguisher_01', -47.55, 0, z, 90 * D); for (const z of FIRE_R) add('korean_fire_extinguisher_01', 47.55, 0, z, -90 * D);
  // tyres in a rack, a wet-floor sign by the oil, the clock, a mezzanine desk, power boxes
  for (let i = 0; i < 4; i++) add('old_tyre', 44 + i * 0.2, 0, 23 - i * 0.05, 90 * D);
  add('WetFloorSign_01', 32.8, 0, -28.6, 30 * D);
  add('wall_clock', 32, 9.85, HD - 0.1, 180 * D, 2.2);
  add('metal_office_desk', 40, 4.13, 29.6, 180 * D); add('metal_office_desk', 26, 4.13, 29.6, 180 * D);
  add('power_box_01', -HW + 0.05, 1.6, -26.8, 90 * D, 1.3); add('power_box_01', HW - 0.05, 1.6, 5.5, -90 * D, 1.3);
  return P;
}
