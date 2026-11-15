// Procedural buildings: one facade/roof texture atlas, a geometry builder that writes
// many buildings into a single merged mesh (one draw call per chunk), and a kit of
// building shapes per location style (alpine chalets, island cottages, desert adobe...).
import * as THREE from 'three';
import { FOG } from './shaders.js';

// ---------------- texture atlas ----------------
// 8 x 4 cells, each cell = one 3 m x 3 m facade bay (one window, one floor) or 3 m x 3 m of roof.
// Colour atlas (sRGB) + data atlas: R = window glass (lit at night, glossy), G = how much the
// per-building tint colour applies (walls/roofs are drawn light so the tint shows).
export const C = {
  PLAIN: 0, WIN_GREEN: 1, WIN_BLUE: 2, WIN: 3, DOOR: 4, WOOD_WIN: 5, WOOD: 6, STONE_WIN: 7,
  ADOBE_WIN: 8, ADOBE: 9, ADOBE_DOOR: 10, APT: 11, SHOP: 12, GLASS: 13, BALCONY: 14, BOARDS: 15,
  METAL: 16, HANGAR_DOOR: 17, TILES: 18, SLATE: 19, SEAM: 20, GRAVEL: 21, SHINGLE: 22, BRICK: 23,
  DARKWOOD: 24, CONCRETE: 25, CHURCH_WIN: 26, GARAGE: 27, THATCH: 28, HEDGE: 29, STONE: 30, BRICK_WIN: 31,
};
const CELL = 128, COLS = 8, ROWS = 4;
let _atlas = null;
export function buildingAtlas() {
  if (_atlas) return _atlas;
  const cv = document.createElement('canvas'); cv.width = CELL * COLS; cv.height = CELL * ROWS;
  const dv = document.createElement('canvas'); dv.width = cv.width; dv.height = cv.height;
  const g = cv.getContext('2d'), d = dv.getContext('2d');
  d.fillStyle = '#000'; d.fillRect(0, 0, dv.width, dv.height);
  let rnd = 12345; const R = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  let ox = 0, oy = 0; const at = (cell) => { ox = (cell % COLS) * CELL; oy = Math.floor(cell / COLS) * CELL; };
  // fill a rect in cell coordinates with colour + data (win 0..1, tint 0..1)
  const P = (x, y, w, h, col, tint = 0, win = 0) => {
    g.fillStyle = col; g.fillRect(ox + x, oy + y, w, h);
    d.fillStyle = `rgb(${Math.round(win * 255)},${Math.round(tint * 255)},0)`; d.fillRect(ox + x, oy + y, w, h);
  };
  const grad = (x, y, w, h, c0, c1, tint = 0, win = 0) => {
    const gr = g.createLinearGradient(0, oy + y, 0, oy + y + h); gr.addColorStop(0, c0); gr.addColorStop(1, c1);
    g.fillStyle = gr; g.fillRect(ox + x, oy + y, w, h);
    d.fillStyle = `rgb(${Math.round(win * 255)},${Math.round(tint * 255)},0)`; d.fillRect(ox + x, oy + y, w, h);
  };
  const glass = (x, y, w, h) => grad(x, y, w, h, '#6d8296', '#24313d', 0, 1);
  // a window with frame, mullion and sill
  const window_ = (x, y, w, h, frame = '#f4f2ec', cross = true) => {
    P(x - 3, y - 3, w + 6, h + 6, frame); glass(x, y, w, h);
    if (cross) { P(x + w / 2 - 1.5, y, 3, h, frame); P(x, y + h * 0.38, w, 3, frame); }
    P(x - 6, y + h + 3, w + 12, 5, '#b8b4ac');
  };
  const shutters = (x, y, w, h, col) => { for (const sx of [x - 3 - w * 0.45, x + w + 3]) { P(sx, y - 3, w * 0.45, h + 6, col); for (let k = y; k < y + h; k += 6) P(sx + 1, k, w * 0.45 - 2, 1.5, 'rgba(0,0,0,0.25)'); } };
  const plaster = (tint = 1, base = '#efefec') => P(0, 0, CELL, CELL, base, tint);
  const planks = (c0, c1, tint, vertical = false, size = 11) => {
    for (let k = 0; k < CELL; k += size) { const c = R() < 0.5 ? c0 : c1; if (vertical) P(k, 0, size, CELL, c, tint); else P(0, k, CELL, size, c, tint); if (vertical) P(k, 0, 1.5, CELL, 'rgba(0,0,0,0.45)', tint); else P(0, k + size - 1.5, CELL, 1.5, 'rgba(0,0,0,0.45)', tint); }
  };
  const stones = (tint, base = '#8f8a82', dark = '#5e5a55') => {
    P(0, 0, CELL, CELL, dark, tint);
    for (let y = 0; y < CELL; y += 14) for (let x = -(y % 28 ? 10 : 0); x < CELL; x += 22 + R() * 10) { const v = 120 + R() * 50 | 0; g.fillStyle = `rgb(${v},${v - 4},${v - 10})`; g.beginPath(); g.ellipse(ox + x + 11, oy + y + 7, 10 + R() * 3, 6, 0, 0, 7); g.fill(); }
  };
  const bricks = (tint, c0 = '#a5503a', c1 = '#8e4330') => {
    P(0, 0, CELL, CELL, '#c8c0b4', tint);
    for (let y = 0, row = 0; y < CELL; y += 8, row++) for (let x = (row % 2) * -8; x < CELL; x += 16) P(x + 1, y + 1, 14, 6, R() < 0.5 ? c0 : c1, tint);
  };
  // 0 plain plaster
  at(C.PLAIN); plaster();
  // 1-3 house windows (shutters green / blue / none)
  for (const [cell, sh] of [[C.WIN_GREEN, '#3f6a3c'], [C.WIN_BLUE, '#2f6fa8'], [C.WIN, null]]) { at(cell); plaster(); window_(44, 30, 40, 56); if (sh) shutters(44, 30, 40, 56, sh); }
  // 4 door
  at(C.DOOR); plaster(); P(38, 22, 52, 106, '#d8d4cc'); P(42, 26, 44, 102, '#6b4529'); P(47, 32, 34, 30, '#5a391f'); P(47, 70, 34, 50, '#5a391f'); glass(50, 34, 28, 22); P(36, 16, 56, 6, '#b8b4ac');
  // 5-6 chalet wood (horizontal logs), window with red flower box
  at(C.WOOD); planks('#9a6a3e', '#8c5e34', 0.35);
  at(C.WOOD_WIN); planks('#9a6a3e', '#8c5e34', 0.35); window_(42, 26, 44, 52, '#efe8da'); P(36, 86, 56, 10, '#5a3a1e'); for (let k = 0; k < 9; k++) { g.fillStyle = ['#d0283c', '#e85a8a', '#f0f0f0', '#d0283c'][k % 4]; g.beginPath(); g.arc(ox + 40 + k * 6, oy + 84 - R() * 4, 3.5, 0, 7); g.fill(); }
  // 7 stone ground floor with small window, 30 plain stone
  at(C.STONE); stones(0.25);
  at(C.STONE_WIN); stones(0.25); window_(48, 40, 32, 40, '#e8e2d6');
  // 8-10 adobe
  const adobe = () => { plaster(1, '#e2d4c2'); for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(${R() < 0.5 ? '120,90,60' : '255,250,240'},0.08)`; g.beginPath(); g.ellipse(ox + R() * CELL, oy + R() * CELL, 6 + R() * 14, 3 + R() * 8, 0, 0, 7); g.fill(); } };
  at(C.ADOBE); adobe();
  at(C.ADOBE_WIN); adobe(); P(46, 40, 36, 44, '#5a4636', 0.2); glass(50, 44, 28, 38); P(40, 32, 48, 7, '#6a4428'); P(46, 84, 36, 4, '#c8b8a0', 0.4);
  at(C.ADOBE_DOOR); adobe(); P(42, 34, 44, 94, '#5a4636'); P(46, 38, 36, 90, '#2f7f86'); P(48, 40, 32, 40, '#2a7078'); P(36, 26, 56, 8, '#6a4428');
  // 11 apartment window, 31 brick with window
  at(C.APT); plaster(); P(0, 122, CELL, 6, '#c9c6c0', 0.5); window_(28, 24, 72, 70, '#e2e0da', false); P(28 + 34, 24, 4, 70, '#e2e0da');
  at(C.BRICK); bricks(0.25);
  at(C.BRICK_WIN); bricks(0.25); window_(36, 28, 56, 62, '#efece4'); P(32, 20, 64, 6, '#d0c8bc');
  // 12 shop front: sign band, striped awning, big window
  at(C.SHOP); plaster(); P(0, 0, CELL, 22, '#f2f2f2', 1); for (let k = 0; k < CELL; k += 16) P(k, 22, 8, 16, '#c8283a'), P(k + 8, 22, 8, 16, '#f6f0e6'); P(0, 38, CELL, 4, '#7a1820');
  P(6, 46, 116, 82, '#3a3a3c'); glass(10, 50, 70, 74); P(84, 50, 34, 78, '#4a3424'); glass(88, 54, 26, 36);
  // 13 glass curtain wall
  at(C.GLASS); P(0, 0, CELL, CELL, '#5a6068'); grad(0, 16, CELL, 112, '#7f9cb3', '#2c4458', 0, 1); P(0, 0, CELL, 16, '#8a9096', 0.3); for (let k = 0; k < CELL; k += 32) P(k, 0, 3, CELL, '#9aa0a6'); P(0, 70, CELL, 3, '#9aa0a6');
  // 14 hotel: big window with balcony railing
  at(C.BALCONY); plaster(); P(0, 110, CELL, 8, '#d8d6d0'); window_(26, 14, 76, 90, '#ececea', false); P(62, 14, 4, 90, '#ececea'); P(10, 70, 108, 4, '#f8f8f6'); for (let k = 12; k < 118; k += 8) P(k, 74, 2.5, 36, '#f0f0ee'); P(10, 106, 108, 4, '#f8f8f6');
  // 15 barn boards (vertical), 16 corrugated metal, 17 hangar door panels
  at(C.BOARDS); planks('#e6dcd2', '#d4c8bc', 1, true, 16); P(0, 0, CELL, 6, 'rgba(0,0,0,0.25)', 1);
  at(C.METAL); for (let k = 0; k < CELL; k++) { const v = 200 + Math.sin((k / CELL) * Math.PI * 2 * 12) * 30 | 0; P(k, 0, 1, CELL, `rgb(${v},${v},${v})`, 1); }
  at(C.HANGAR_DOOR); for (let k = 0; k < CELL; k++) { const v = 196 + Math.sin((k / CELL) * Math.PI * 2 * 16) * 14 | 0; P(k, 0, 1, CELL, `rgb(${v},${v + 2},${v + 4})`, 0.6); } P(0, 0, 3, CELL, '#55595e'); P(0, 60, CELL, 3, '#8a8e94', 0.6); glass(8, 20, 112, 18);
  // 18-22 roofs
  at(C.TILES); P(0, 0, CELL, CELL, '#9a9a9a', 1); for (let y = 0; y < CELL; y += 16) for (let x = (y / 16 % 2) * 10; x < CELL + 20; x += 20) { const gr = g.createLinearGradient(0, oy + y, 0, oy + y + 16); gr.addColorStop(0, '#e8e8e8'); gr.addColorStop(1, '#a8a8a8'); g.fillStyle = gr; g.beginPath(); g.ellipse(ox + x, oy + y + 6, 9, 10, 0, 0, Math.PI); g.lineTo(ox + x - 9, oy + y); g.fill(); }
  at(C.SLATE); P(0, 0, CELL, CELL, '#707070', 1); for (let y = 0; y < CELL; y += 12) for (let x = (y / 12 % 2) * 8; x < CELL + 16; x += 16) { const v = 170 + R() * 50 | 0; P(x - 7, y, 14.5, 10.5, `rgb(${v},${v},${v + 4})`, 1); }
  at(C.SEAM); P(0, 0, CELL, CELL, '#d4d4d4', 1); for (let k = 0; k < CELL; k += 21) { P(k, 0, 3, CELL, '#f4f4f4', 1); P(k + 3, 0, 2, CELL, '#9a9a9a', 1); }
  at(C.GRAVEL); P(0, 0, CELL, CELL, '#8a8884', 0.7); for (let k = 0; k < 900; k++) { const v = 100 + R() * 80 | 0; P(R() * CELL, R() * CELL, 2, 2, `rgb(${v},${v},${v - 4})`, 0.7); }
  at(C.SHINGLE); P(0, 0, CELL, CELL, '#5a4030', 0.5); for (let y = 0; y < CELL; y += 10) for (let x = R() * 8 - 8; x < CELL; x += 7 + R() * 6) { const v = R(); P(x, y, 6 + R() * 4, 9, `rgb(${96 + v * 50 | 0},${68 + v * 38 | 0},${48 + v * 28 | 0})`, 0.5); }
  // 24 dark wood trim, 25 concrete
  at(C.DARKWOOD); planks('#6a4a30', '#5e4128', 0.15, true, 9);
  at(C.CONCRETE); P(0, 0, CELL, CELL, '#b4b2ac', 0.4); P(0, 0, CELL, 2, '#8a8884', 0.4); P(0, 0, 2, CELL, '#8a8884', 0.4);
  // 26 church: tall arched stained window
  at(C.CHURCH_WIN); plaster(); g.fillStyle = '#e8e4dc'; g.beginPath(); g.moveTo(ox + 44, oy + 120); g.lineTo(ox + 44, oy + 40); g.arc(ox + 64, oy + 40, 20, Math.PI, 0); g.lineTo(ox + 84, oy + 120); g.fill();
  for (let k = 0; k < 12; k++) { const y = 26 + k * 8; P(48, Math.max(y, 30), 32, 8, ['#4a6ab0', '#b03a3a', '#d8b040', '#3a8a5a'][k % 4], 0, 1); } g.fillStyle = '#e8e4dc'; g.fillRect(ox + 63, oy + 26, 2, 94);
  // 27 garage door
  at(C.GARAGE); plaster(); P(12, 30, 104, 98, '#9a9890'); for (let y = 34; y < 128; y += 12) P(14, y, 100, 10, '#d8d6d0', 0.3);
  // 28 thatch
  at(C.THATCH); P(0, 0, CELL, CELL, '#a88a52', 0.2); for (let k = 0; k < 500; k++) { const x = R() * CELL, y = R() * CELL, v = R(); g.strokeStyle = `rgb(${180 + v * 50 | 0},${150 + v * 40 | 0},${90 + v * 30 | 0})`; g.lineWidth = 1.2; g.beginPath(); g.moveTo(ox + x, oy + y); g.lineTo(ox + x + (R() - 0.5) * 3, oy + y + 10); g.stroke(); }
  // 29 hedge leaves
  at(C.HEDGE); P(0, 0, CELL, CELL, '#9fb890', 1); for (let k = 0; k < 700; k++) { const v = R(); g.fillStyle = `rgb(${110 + v * 120 | 0},${140 + v * 110 | 0},${100 + v * 90 | 0})`; g.beginPath(); g.ellipse(ox + R() * CELL, oy + R() * CELL, 3, 2, R() * 3, 0, 7); g.fill(); }
  // fine grain over everything
  const img = g.getImageData(0, 0, cv.width, cv.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) { const k = (R() - 0.5) * 14; px[i] += k; px[i + 1] += k; px[i + 2] += k; }
  g.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const data = new THREE.CanvasTexture(dv); data.anisotropy = 4;
  _atlas = { map, data };
  return _atlas;
}

// One material for every building: atlas cell per vertex, fract() tiling inside the cell,
// window glass glossy by day and (randomly per window) lit at night via emissiveIntensity.
export function buildingMaterial() {
  const A = buildingAtlas();
  const mat = new THREE.MeshStandardMaterial({ map: A.map, vertexColors: true, roughness: 0.88, metalness: 0, emissive: 0xffbe78, emissiveIntensity: 0 });
  const U = { tData: { value: A.data } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 atl; varying vec2 vAtl;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvAtl = atl;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tData; varying vec2 vAtl;')
      .replace('#include <map_fragment>', `
        vec2 cxy = vec2(mod(vAtl.x, ${COLS}.0), floor(vAtl.x / ${COLS}.0 + 0.01));
        vec2 fu = clamp(fract(vMapUv), 0.008, 0.992);
        vec2 auv = vec2((cxy.x + fu.x) / ${COLS}.0, 1.0 - (cxy.y + 1.0 - fu.y) / ${ROWS}.0);
        vec2 gdx = dFdx(vMapUv) * vec2(${1 / COLS}, ${1 / ROWS}), gdy = dFdy(vMapUv) * vec2(${1 / COLS}, ${1 / ROWS});
        vec4 bTex = textureGrad(map, auv, gdx, gdy);
        vec4 bDat = textureGrad(tData, auv, gdx, gdy);
        float winM = bDat.r;
        diffuseColor.rgb *= bTex.rgb;`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), vColor, bDat.g);')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.18, winM);')
      .replace('#include <emissivemap_fragment>', `
        float wh = fract(sin(dot(floor(vMapUv) + vAtl.y * 0.6180339, vec2(12.9898, 78.233))) * 43758.5453);
        totalEmissiveRadiance *= winM * step(0.45, wh) * (0.45 + 0.55 * fract(wh * 13.0));`);
  };
  mat.customProgramCacheKey = () => 'bldg1';
  return mat;
}

// ---------------- geometry builder ----------------
const _c = new THREE.Color();
export class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.atl = []; this.idx = []; this.n = 0; this.setFrame(0, 0, 0, 0); this.seed = 0; }
  setFrame(x, y, z, yaw) { this.fx = x; this.fy = y; this.fz = z; this.cs = Math.cos(yaw); this.sn = Math.sin(yaw); return this; }
  _v(p, nx, ny, nz, u, v, cell, cr, cg, cb) {
    const { cs, sn } = this;
    this.pos.push(this.fx + p[0] * cs + p[2] * sn, this.fy + p[1], this.fz - p[0] * sn + p[2] * cs);
    this.nor.push(nx * cs + nz * sn, ny, -nx * sn + nz * cs);
    this.uv.push(u, v); this.col.push(cr, cg, cb); this.atl.push(cell, this.seed);
  }
  // quad p0..p3 counter-clockwise seen from the front (p0 bottom-left), uv given per corner
  quad(p0, p1, p2, p3, uvs, cell, col) { this._poly(p2 === p3 ? [p0, p1, p2] : [p0, p1, p2, p3], uvs, cell, col); }
  tri(p0, p1, p2, uvs, cell, col) { this._poly([p0, p1, p2], uvs, cell, col); }
  _poly(P, uvs, cell, col) {
    const p0 = P[0], p1 = P[1], p3 = P[P.length - 1];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    _c.set(col); const cr = Math.round(Math.min(1, _c.r) * 255), cg = Math.round(Math.min(1, _c.g) * 255), cb = Math.round(Math.min(1, _c.b) * 255);
    const o = this.n;
    P.forEach((p, i) => this._v(p, nx, ny, nz, uvs[i * 2], uvs[i * 2 + 1], cell, cr, cg, cb));
    if (P.length === 3) { this.idx.push(o, o + 1, o + 2); this.n += 3; } else { this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3); this.n += 4; }
  }
  // vertical wall from (ax,az) to (bx,bz) seen from outside; u = whole bays, v = floors
  wall(ax, az, bx, bz, y0, y1, cell, col, bay = 3, fl = 3, u0 = 0) {
    const L = Math.hypot(bx - ax, bz - az), nb = Math.max(1, Math.round(L / bay)), v0 = y0 / fl, v1 = y1 / fl;
    this.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [u0, v0, u0 + nb, v0, u0 + nb, v1, u0, v1], cell, col);
  }
  // plain surface with metre-scaled uv (no windows), any orientation
  plainQuad(p0, p1, p2, p3, cell, col, s = 3) {
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / s, H = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]) / s;
    this.quad(p0, p1, p2, p3, [0, 0, L, 0, L, H, 0, H], cell, col);
  }
  // axis-aligned box (local), sides + top (+bottom)
  box(cx, y0, cz, w, h, d, cell, col, { top = true, bottom = false, topCell = cell, topCol = col, s = 3 } = {}) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
    this.plainQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], cell, col, s);
    this.plainQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], cell, col, s);
    this.plainQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], cell, col, s);
    this.plainQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], cell, col, s);
    if (top) this.plainQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], topCell, topCol, s);
    if (bottom) this.plainQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], cell, col, s);
  }
  // upright cylinder / cone frustum (local), optional flat cap
  cyl(cx, cz, y0, y1, r0, r1, seg, cell, col, { cap = false, capCol = col, capCell = cell, s = 3 } = {}) {
    const circ = 2 * Math.PI * Math.max(r0, r1), us = Math.max(1, Math.round(circ / s));
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p = (a, r, y) => [cx + Math.sin(a) * r, y, cz + Math.cos(a) * r];
      const u0 = (k / seg) * us, u1 = ((k + 1) / seg) * us, v1 = (y1 - y0) / s;
      this.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), [u0, 0, u1, 0, u1, v1, u0, v1], cell, col);
      if (cap && r1 > 0.01) this.tri(p(a0, r1, y1), p(a1, r1, y1), [cx, y1, cz], [0, 0, 1, 0, 0.5, 0.5], capCell, capCol);
    }
  }
  dome(cx, cz, y0, r, seg, rings, cell, col) {
    for (let j = 0; j < rings; j++) {
      const b0 = (j / rings) * Math.PI / 2, b1 = ((j + 1) / rings) * Math.PI / 2;
      this.cyl(cx, cz, y0 + Math.sin(b0) * r, y0 + Math.sin(b1) * r, Math.cos(b0) * r, Math.cos(b1) * r, seg, cell, col);
    }
  }
  // gable roof over a w x d footprint, ridge along z. Gable ends filled with wallCell.
  gable(w, d, y, rise, over, cell, col, wallCell, wallCol, { under = null, ends = true } = {}) {
    const hw = w / 2, ex = hw + over, ez = d / 2 + over, ye = y - over * rise / hw, yr = y + rise, sl = Math.hypot(ex, yr - ye) / 3, L = (2 * ez) / 3;
    this.quad([ex, ye, ez], [ex, ye, -ez], [0, yr, -ez], [0, yr, ez], [0, 0, L, 0, L, sl, 0, sl], cell, col);
    this.quad([-ex, ye, -ez], [-ex, ye, ez], [0, yr, ez], [0, yr, -ez], [0, 0, L, 0, L, sl, 0, sl], cell, col);
    if (ends) {
      const z = d / 2, v = rise / 3, u = w / 3;
      this.tri([-hw, y, z], [hw, y, z], [0, yr, z], [0, 0, u, 0, u / 2, v], wallCell, wallCol);
      this.tri([hw, y, -z], [-hw, y, -z], [0, yr, -z], [0, 0, u, 0, u / 2, v], wallCell, wallCol);
    }
    if (under && over > 0.3) { // undersides so deep chalet eaves are not see-through from below
      this.quad([0, yr, ez], [0, yr, -ez], [ex, ye, -ez], [ex, ye, ez], [0, 0, L, 0, L, sl, 0, sl], C.DARKWOOD, 0xffffff);
      this.quad([0, yr, -ez], [0, yr, ez], [-ex, ye, ez], [-ex, ye, -ez], [0, 0, L, 0, L, sl, 0, sl], C.DARKWOOD, 0xffffff);
    }
  }
  // hip roof (or pyramid when square)
  hip(w, d, y, rise, over, cell, col) {
    const ex = w / 2 + over, ez = d / 2 + over, ye = y - over * rise / (w / 2), yr = y + rise, rz = Math.max(0, ez - ex), slx = Math.hypot(ex, yr - ye) / 3, slz = Math.hypot(ez - rz, yr - ye) / 3;
    this.quad([ex, ye, ez], [ex, ye, -ez], [0, yr, -rz], [0, yr, rz], [0, 0, 2 * ez / 3, 0, (ez + rz) / 3, slx, (ez - rz) / 3, slx], cell, col);
    this.quad([-ex, ye, -ez], [-ex, ye, ez], [0, yr, rz], [0, yr, -rz], [0, 0, 2 * ez / 3, 0, (ez + rz) / 3, slx, (ez - rz) / 3, slx], cell, col);
    this.tri([-ex, ye, ez], [ex, ye, ez], [0, yr, rz], [0, 0, 2 * ex / 3, 0, ex / 3, slz], cell, col);
    this.tri([ex, ye, -ez], [-ex, ye, -ez], [0, yr, -rz], [0, 0, 2 * ex / 3, 0, ex / 3, slz], cell, col);
  }
  // flat roof with a parapet (walls must already reach y + ph)
  flat(w, d, y, ph, cell, col, wallCell, wallCol) {
    const hw = w / 2, hd = d / 2, i = 0.3;
    this.plainQuad([-hw + i, y, hd - i], [hw - i, y, hd - i], [hw - i, y, -hd + i], [-hw + i, y, -hd + i], cell, col);
    if (ph > 0.05) {
      // inner faces + cap
      const a = [[-hw + i, hd - i], [hw - i, hd - i], [hw - i, -hd + i], [-hw + i, -hd + i]];
      for (let k = 0; k < 4; k++) { const p = a[k], q = a[(k + 1) % 4]; this.plainQuad([q[0], y, q[1]], [p[0], y, p[1]], [p[0], y + ph, p[1]], [q[0], y + ph, q[1]], wallCell, wallCol); }
      const o = [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]];
      for (let k = 0; k < 4; k++) { const p = o[k], q = o[(k + 1) % 4], pi = a[k], qi = a[(k + 1) % 4]; this.plainQuad([p[0], y + ph, p[1]], [q[0], y + ph, q[1]], [qi[0], y + ph, qi[1]], [pi[0], y + ph, pi[1]], wallCell, wallCol); }
    }
  }
  // walls around a w x d footprint from y0 to y1; front (+z) can have its own cell and a door in the middle bay
  walls(w, d, y0, y1, cell, col, { front = cell, side = cell, back = side, door = null, fl = 3 } = {}) {
    const hw = w / 2, hd = d / 2;
    if (door != null) {
      const nb = Math.max(1, Math.round(w / 3)), bw = w / nb, k = Math.floor(nb / 2), xa = -hw + k * bw, xb = xa + bw, y2 = Math.min(y1, y0 + fl);
      if (k > 0) this.wall(-hw, hd, xa, hd, y0, y2, front, col, bw, fl);
      this.wall(xa, hd, xb, hd, y0, y2, door, col, bw, fl);
      if (k < nb - 1) this.wall(xb, hd, hw, hd, y0, y2, front, col, bw, fl);
      if (y1 > y2 + 0.01) this.wall(-hw, hd, hw, hd, y2, y1, front, col, 3, fl);
    } else this.wall(-hw, hd, hw, hd, y0, y1, front, col, 3, fl);
    this.wall(hw, hd, hw, -hd, y0, y1, side, col, 3, fl);
    this.wall(hw, -hd, -hw, -hd, y0, y1, back, col, 3, fl);
    this.wall(-hw, -hd, -hw, hd, y0, y1, side, col, 3, fl);
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setAttribute('atl', new THREE.BufferAttribute(new Uint8Array(this.atl), 2, false));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  get empty() { return this.n === 0; }
}

// ---------------- building kit ----------------
// Each maker returns { w, d, h, draw(S, D) } where S is the shell builder and D the detail
// builder (both already framed at the building's origin, front facing +z).
const pick = (r, a) => a[Math.floor(r() * a.length)];
export const PALETTE = {
  alpine: { walls: [0xf6f1e6, 0xefe2c8, 0xe6d6b8, 0xf2ece0, 0xdcc8a4], roofs: [0x6a5a50, 0x585a60, 0x7a4a36, 0x4a4c52], wood: [0xffffff, 0xe8d8c8, 0xc8b098] },
  islands: { walls: [0xfaf2dc, 0xa8dde2, 0xf6cfae, 0xf8d8e4, 0xd2ecc8, 0xfff0a8], roofs: [0xd0603e, 0xc24a32, 0x3f7fb0, 0x2f8f8a, 0xe08a50] },
  canyon: { walls: [0xd89a6a, 0xc8875a, 0xe0b080, 0xcf9f78, 0xe8c49c, 0xb87a52], roofs: [0x8a6a50, 0x6e6a64, 0xa07a5a, 0x7a5040] },
};

export function makeBuilding(type, style, r) {
  const P = PALETTE[style];
  const K = KITS[style][type] || KITS.common[type];
  return K(r, P, style);
}

const chimney = (D, x, y, z, col = 0x8a7a6e) => { D.box(x, y - 1.5, z, 0.8, 3.2, 0.8, C.BRICK, col, { topCell: C.CONCRETE, topCol: 0x333333 }); };

const KITS = {
  common: {
    church: (r, P, st) => {
      const w = 11, d = 24, h = 10, wallC = 0xf8f6f0, roofC = st === 'canyon' ? 0xb07a52 : st === 'islands' ? 0x3c78b8 : 0x55585e;
      return { w, d: d + 6, h: 34, draw(S, D) {
        const cell = st === 'canyon' ? C.ADOBE : C.PLAIN;
        S.walls(w, d, 0, h, C.CHURCH_WIN, wallC, { front: cell, door: st === 'canyon' ? C.ADOBE_DOOR : C.DOOR, fl: 5 });
        S.gable(w, d, h, st === 'islands' ? 3 : 6, 0.4, st === 'islands' ? C.TILES : C.SLATE, roofC, cell, wallC);
        // bell tower at the front
        const tz = d / 2 + 2.6, tw = 5.2, th = st === 'canyon' ? 17 : 24;
        S.box(0, 0, tz, tw, th, tw, cell, wallC, { top: false });
        D.box(0, th - 5, tz, tw + 0.1, 3, tw + 0.1, C.CHURCH_WIN, wallC, { top: false, s: 3 });
        if (st === 'islands') { S.box(0, th, tz, tw, 0.01, tw, C.PLAIN, wallC); S.dome(0, tz, th, 2.8, 12, 4, C.SEAM, roofC); D.cyl(0, tz, th + 2.7, th + 4.6, 0.12, 0.12, 4, C.PLAIN, 0xd4af37); }
        else if (st === 'canyon') { S.box(0, th, tz, tw + 0.6, 0.6, tw + 0.6, C.ADOBE, wallC); D.box(0, th + 0.6, tz, 0.3, 3, 0.3, C.DARKWOOD, 0x553322); D.box(0, th + 2.3, tz, 1.8, 0.3, 0.3, C.DARKWOOD, 0x553322); }
        else { S.hip(tw, tw, th, 11, 0.3, C.SLATE, roofC); D.cyl(0, tz, th + 10.5, th + 14, 0.12, 0.12, 4, C.PLAIN, 0xd4af37); D.box(0, th + 12.6, tz, 1.4, 0.18, 0.18, C.PLAIN, 0xd4af37); }
      } };
    },
    silo: (r) => { const rad = 2.6 + r() * 1.2, h = 12 + r() * 8, col = pick(r, [0xc8ccd0, 0xd8d8d0, 0x5a7a9a, 0xb8bcc0]); return { w: rad * 2, d: rad * 2, h: h + rad, draw(S, D) { S.cyl(0, 0, -0.5, h, rad, rad, 14, C.METAL, col); S.dome(0, 0, h, rad, 14, 3, C.SEAM, 0xd0d4d8); D.box(rad + 0.3, 0, 0, 0.5, h, 0.5, C.METAL, 0x666666, { top: false }); } }; },
    shed: (r, P, st) => { const w = 5 + r() * 4, d = 6 + r() * 5, h = 3 + r() * 1, col = st === 'canyon' ? 0xb8bcc0 : pick(r, [0x9a6a48, 0x7a5638, 0xa8a8a0]); return { w, d, h: h + 2, draw(S) { S.walls(w, d, -0.5, h, st === 'canyon' ? C.METAL : C.BOARDS, col, { door: C.GARAGE }); S.gable(w, d, h, 1.4, 0.3, C.SEAM, 0x8a8e94, st === 'canyon' ? C.METAL : C.BOARDS, col); } }; },
    hut: (r) => { const w = 4 + r(), d = 4 + r(); return { w, d, h: 5, draw(S) { S.walls(w, d, -0.3, 2.6, C.WOOD, 0xffffff, { door: C.DOOR }); S.hip(w, d, 2.6, 2.4, 0.7, C.THATCH, 0xffffff); } }; },
  },
  alpine: {
    house: (r, P) => {
      if (r() < 0.62) { // chalet: stone base, timber upper floors, deep eaves, balcony
        const w = 9 + r() * 4, d = 10 + r() * 5, fl = 2 + (r() < 0.35 ? 1 : 0), h = fl * 3, rise = w * (0.26 + r() * 0.08), wood = pick(r, P.wood), roof = pick(r, P.roofs), roofCell = r() < 0.5 ? C.SHINGLE : C.SLATE;
        return { w, d, h: h + rise, chimney: [w * 0.22, h + rise * 0.6 + 1.5, -d * 0.2], draw(S, D) {
          S.walls(w, d, -1, 3, C.STONE_WIN, 0xffffff, { door: C.DOOR });
          S.walls(w, d, 3, h, C.WOOD_WIN, wood, { side: C.WOOD_WIN });
          S.gable(w, d, h, rise, 1.3, roofCell, roof, C.WOOD, wood, { under: true });
          // balcony across the gable front on each upper floor
          for (let f = 1; f < fl; f++) { D.box(0, f * 3 - 0.2, d / 2 + 0.75, w + 0.4, 0.22, 1.5, C.DARKWOOD, 0xffffff); D.box(0, f * 3, d / 2 + 1.45, w + 0.4, 1.0, 0.1, C.DARKWOOD, 0xffffff, { top: false }); for (const s of [-1, 1]) D.box(s * (w / 2 + 0.15), f * 3, d / 2 + 0.75, 0.1, 1.0, 1.5, C.DARKWOOD, 0xffffff, { top: false }); }
          chimney(D, w * 0.22, h + rise * 0.6 + 0.5, -d * 0.2);
        } };
      }
      // plaster village house, steep roof
      const w = 8 + r() * 4, d = 9 + r() * 4, fl = 2 + (r() < 0.3 ? 1 : 0), h = fl * 3, rise = w * (0.45 + r() * 0.2), wall = pick(r, P.walls), roof = pick(r, P.roofs), hipR = r() < 0.4;
      return { w, d, h: h + rise, chimney: [-w * 0.2, h + rise * 0.5 + 1.5, d * 0.1], draw(S, D) {
        S.walls(w, d, -1, h, C.WIN_GREEN, wall, { door: C.DOOR });
        if (hipR) S.hip(w, d, h, rise * 0.8, 0.6, C.SLATE, roof); else S.gable(w, d, h, rise, 0.6, C.SLATE, roof, C.PLAIN, wall);
        chimney(D, -w * 0.2, h + rise * 0.5, d * 0.1);
      } };
    },
    center: (r, P) => {
      const roll = r();
      if (roll < 0.35) { // shop with flat roof
        const w = 10 + r() * 6, d = 10 + r() * 4, h = 4, wall = pick(r, P.walls);
        return { w, d, h, draw(S) { S.walls(w, d, -1, h + 0.6, C.PLAIN, wall, { front: C.SHOP }); S.flat(w, d, h, 0.6, C.GRAVEL, 0x9a9890, C.PLAIN, wall); } };
      }
      if (roll < 0.6) { // big chalet hotel
        const w = 18 + r() * 8, d = 14 + r() * 4, fl = 4, h = fl * 3, rise = w * 0.24, wood = pick(r, P.wood), roof = pick(r, P.roofs);
        return { w, d, h: h + rise, draw(S, D) {
          S.walls(w, d, -1, 3, C.SHOP, 0xf4efe6, { side: C.STONE_WIN });
          S.walls(w, d, 3, h, C.BALCONY, 0xf6f0e4, { side: C.WOOD_WIN });
          rot(S, Math.PI / 2); S.gable(d, w, h, rise, 1.4, C.SHINGLE, roof, C.WOOD, wood, { under: true }); rot(S, -Math.PI / 2);
          for (let f = 1; f < fl; f++) D.box(0, f * 3 - 0.2, d / 2 + 0.6, w, 0.2, 1.2, C.DARKWOOD, 0xffffff);
        } };
      }
      // townhouse row with ground floor shops
      const w = 12 + r() * 8, d = 11 + r() * 3, fl = 3 + (r() < 0.4 ? 1 : 0), h = fl * 3, rise = d * 0.4, wall = pick(r, P.walls), roof = pick(r, P.roofs);
      return { w, d, h: h + rise, draw(S) {
        S.walls(w, d, -1, 3, C.WIN, wall, { front: C.SHOP }); S.walls(w, d, 3, h, C.WIN_GREEN, wall);
        rot(S, Math.PI / 2); S.gable(d, w, h, rise, 0.5, C.SLATE, roof, C.PLAIN, wall); rot(S, -Math.PI / 2);
      } };
    },
    barn: (r, P) => {
      const w = 12 + r() * 5, d = 18 + r() * 8, h = 6, rise = w * 0.42, col = pick(r, [0xffffff, 0xe0d0c0, 0xd0b8a0]);
      return { w, d, h: h + rise, draw(S, D) {
        S.walls(w, d, -1, 2.5, C.STONE, 0xffffff); S.walls(w, d, 2.5, h, C.BOARDS, 0x9a6a44 , { front: C.BOARDS });
        S.gable(w, d, h, rise, 0.9, C.SHINGLE, 0x6a5a4a, C.BOARDS, 0x9a6a44, { under: true });
        D.box(0, 0, d / 2 + 0.05, 4, 4, 0.1, C.DARKWOOD, col, { top: false });
      } };
    },
  },
  islands: {
    house: (r, P) => {
      const wall = pick(r, P.walls), roof = pick(r, P.roofs);
      if (r() < 0.38) { // whitewashed cube with flat roof (Greek style)
        const w = 7 + r() * 4, d = 7 + r() * 4, fl = r() < 0.5 ? 1 : 2, h = fl * 3, col = r() < 0.25 ? 0xffffff : wall;
        return { w, d, h, draw(S, D) {
          S.walls(w, d, -1, h + 0.5, C.WIN_BLUE, col, { door: C.DOOR });
          S.flat(w, d, h, 0.5, C.CONCRETE, 0xf0f0f0, C.PLAIN, col);
          if (fl === 1 && r() < 0.5) D.box(-w * 0.2, h, -d * 0.15, w * 0.45, 2.6, d * 0.5, C.WIN_BLUE, col);
          if (r() < 0.3) D.dome(w * 0.25, -d * 0.2, h, 1.6, 10, 3, C.SEAM, 0x3c78b8);
        } };
      }
      const w = 8 + r() * 4, d = 8 + r() * 5, fl = r() < 0.6 ? 1 : 2, h = fl * 3 + 0.4, rise = w * (0.28 + r() * 0.12);
      return { w, d, h: h + rise, draw(S, D) {
        S.walls(w, d, -1, h, C.WIN_BLUE, wall, { door: C.DOOR });
        S.hip(w, d, h, rise, 0.8, C.TILES, roof);
        if (r() < 0.6) { D.box(0, 2.7, d / 2 + 1.4, w * 0.7, 0.18, 2.8, C.TILES, roof); for (const s of [-1, 1]) D.box(s * w * 0.33, -0.5, d / 2 + 2.6, 0.22, 3.2, 0.22, C.PLAIN, 0xffffff, { top: false }); }
      } };
    },
    center: (r, P) => {
      const roll = r(), wall = pick(r, P.walls);
      if (roll < 0.3) { // resort hotel with balconies and a pool
        const w = 26 + r() * 16, d = 13, fl = 3 + Math.floor(r() * 4), h = fl * 3;
        return { w, d: d + 14, h: h + 1, draw(S, D) {
          S.walls(w, d, -1, 3, C.GLASS, 0xffffff, { side: C.PLAIN });
          S.walls(w, d, 3, h + 0.8, C.BALCONY, wall, { side: C.PLAIN, back: C.APT });
          S.flat(w, d, h, 0.8, C.GRAVEL, 0xb4b2aa, C.PLAIN, 0xffffff);
          D.box(w * 0.2, h + 0.8, 0, 3, 2.2, 3, C.CONCRETE, 0xdddddd);
          // pool + deck behind the hotel front (toward +z)
          S.box(0, -0.5, d / 2 + 7, w * 0.6, 0.62, 9, C.CONCRETE, 0xeee8dc, { topCell: C.PLAIN, topCol: 0xeee8dc });
          S.plainQuad([-w * 0.25, 0.14, d / 2 + 10], [w * 0.25, 0.14, d / 2 + 10], [w * 0.25, 0.14, d / 2 + 4], [-w * 0.25, 0.14, d / 2 + 4], C.PLAIN, 0x38c8e8);
        } };
      }
      if (roll < 0.75) { // shop / cafe with flat roof
        const w = 10 + r() * 6, d = 10 + r() * 4, h = 4;
        return { w, d, h, draw(S) { S.walls(w, d, -1, h + 0.6, C.PLAIN, wall, { front: C.SHOP }); S.flat(w, d, h, 0.6, C.CONCRETE, 0xeeeeee, C.PLAIN, wall); } };
      }
      const w = 14 + r() * 8, d = 12, fl = 3, h = fl * 3; // pastel apartment block
      return { w, d, h: h + 3, draw(S) { S.walls(w, d, -1, 3, C.WIN, wall, { front: C.SHOP }); S.walls(w, d, 3, h, C.WIN_BLUE, wall); S.hip(w, d, h, 3, 0.7, C.TILES, pick(r, P.roofs)); } };
    },
    barn: (r) => {
      const w = 10 + r() * 4, d = 14 + r() * 6, h = 5, col = pick(r, [0xc89060, 0xb8875a, 0xd8b080]);
      return { w, d, h: h + 4, draw(S) { S.walls(w, d, -1, h, C.BOARDS, col, { door: C.GARAGE }); S.gable(w, d, h, 3.6, 0.6, C.SEAM, 0x8a3a30, C.BOARDS, col); } };
    },
  },
  canyon: {
    house: (r, P) => {
      const wall = pick(r, P.walls);
      if (r() < 0.55) { // adobe: flat roof, parapet, protruding vigas, sometimes a stepped upper storey
        const w = 8 + r() * 5, d = 8 + r() * 5, h = 3.4, up = r() < 0.4;
        return { w, d, h: h + (up ? 3 : 0), draw(S, D) {
          S.walls(w, d, -1, h + 0.6, C.ADOBE_WIN, wall, { door: C.ADOBE_DOOR });
          S.flat(w, d, h, 0.6, C.GRAVEL, 0xc8a882, C.ADOBE, wall);
          if (up) { const w2 = w * 0.55, d2 = d * 0.6, x2 = -w * 0.2, z2 = -d * 0.18; S.setFrame(...offset(S, x2, h, z2)); S.walls(w2, d2, 0, 3.4, C.ADOBE_WIN, wall); S.flat(w2, d2, 2.8, 0.6, C.GRAVEL, 0xc8a882, C.ADOBE, wall); S.setFrame(...offset(S, -x2, -h, -z2)); }
          for (let k = 0; k < Math.floor(w / 1.6); k++) D.box(-w / 2 + 0.8 + k * 1.6, h - 0.5, d / 2 + 0.3, 0.26, 0.26, 0.8, C.DARKWOOD, 0x7a5030);
        } };
      }
      // ranch house: long single storey, low hip roof, porch
      const w = 14 + r() * 6, d = 8 + r() * 3, h = 3.2, roof = pick(r, P.roofs);
      return { w, d, h: h + 2.5, draw(S, D) {
        S.walls(w, d, -1, h, C.WIN, pick(r, [0xf2ece0, 0xe8dcc8, 0xd8c8b0, 0xc8d4dc]), { door: C.DOOR });
        S.hip(w, d, h, 2.2, 0.6, C.SHINGLE, roof);
        D.box(0, 2.6, d / 2 + 1.3, w * 0.8, 0.15, 2.6, C.SHINGLE, roof); for (const s of [-1, 0, 1]) D.box(s * w * 0.38, -0.5, d / 2 + 2.4, 0.2, 3.1, 0.2, C.DARKWOOD, 0xffffff, { top: false });
      } };
    },
    center: (r, P) => {
      const roll = r(), wall = pick(r, P.walls);
      if (roll < 0.4) { // western storefront with false front + boardwalk awning
        const w = 9 + r() * 5, d = 12 + r() * 4, h = 4.2;
        return { w, d, h: h + 2, draw(S, D) {
          S.walls(w, d, -1, h, C.BOARDS, wall, { front: C.SHOP });
          S.gable(w, d, h, 1.5, 0.2, C.SEAM, 0x8a8e94, C.BOARDS, wall);
          S.box(0, h, d / 2 - 0.15, w, 2.4, 0.3, C.BOARDS, wall);
          D.box(0, 3.0, d / 2 + 1.2, w, 0.15, 2.4, C.SEAM, 0x8a7a6a); for (const s of [-1, 1]) D.box(s * (w / 2 - 0.2), -0.5, d / 2 + 2.3, 0.2, 3.5, 0.2, C.DARKWOOD, 0xffffff, { top: false });
        } };
      }
      if (roll < 0.7) { // two-storey adobe block
        const w = 14 + r() * 8, d = 12 + r() * 3, h = 6.4;
        return { w, d, h, draw(S, D) { S.walls(w, d, -1, 3.2, C.ADOBE_WIN, wall, { front: C.SHOP }); S.walls(w, d, 3.2, h + 0.7, C.ADOBE_WIN, wall); S.flat(w, d, h, 0.7, C.GRAVEL, 0xc8a882, C.ADOBE, wall); for (let k = 0; k < Math.floor(w / 1.6); k++) D.box(-w / 2 + 0.8 + k * 1.6, h - 0.5, d / 2 + 0.3, 0.26, 0.26, 0.8, C.DARKWOOD, 0x7a5030); } };
      }
      // motel: long, one storey, doors in a row, with a sign pole
      const w = 30 + r() * 12, d = 9, h = 3.2;
      return { w, d, h: h + 6, draw(S, D) {
        S.walls(w, d, -1, h + 0.5, C.PLAIN, wall, { front: C.DOOR, back: C.WIN }); S.flat(w, d, h, 0.5, C.GRAVEL, 0xa89a88, C.PLAIN, wall);
        D.box(0, 2.7, d / 2 + 1, w, 0.15, 2, C.SEAM, 0x2f8a8a);
        D.box(w / 2 + 2, -0.5, d / 2 + 2, 0.4, 8, 0.4, C.METAL, 0x888888, { top: false }); D.box(w / 2 + 2, 6.5, d / 2 + 2, 0.5, 2.4, 4.5, C.SHOP, 0xffe0a0);
      } };
    },
    barn: (r) => {
      const w = 12 + r() * 5, d = 18 + r() * 8, h = 6, col = pick(r, [0xb04a32, 0xa0402c, 0x8a3a24]);
      return { w, d, h: h + 5, draw(S, D) {
        S.walls(w, d, -1, h, C.BOARDS, col, { front: C.BOARDS });
        // gambrel roof made of two stacked gables
        S.gable(w, d, h, 3.2, 0.4, C.SEAM, 0x6a6e74, C.BOARDS, col);
        D.box(0, 0, d / 2 + 0.05, 4.4, 4.4, 0.1, C.BOARDS, 0xf0ece4, { top: false });
      } };
    },
    waterTower: () => ({ w: 10, d: 10, h: 30, draw(S, D) {
      for (const [x, z] of [[-3, -3], [3, -3], [3, 3], [-3, 3]]) S.box(x, -0.5, z, 0.5, 21, 0.5, C.METAL, 0x9a9a9a, { top: false });
      D.box(0, 10, 0, 6.5, 0.2, 0.2, C.METAL, 0x9a9a9a); D.box(0, 10, 0, 0.2, 0.2, 6.5, C.METAL, 0x9a9a9a);
      S.cyl(0, 0, 20, 27, 4.6, 4.6, 16, C.SEAM, 0xeeeeee, {}); S.cyl(0, 0, 19, 20, 1.5, 4.6, 16, C.SEAM, 0xd8d8d8); S.cyl(0, 0, 27, 29.6, 4.9, 0.3, 16, C.SEAM, 0xc84030);
      S.cyl(0, 0, 23.2, 24.6, 4.62, 4.62, 16, C.PLAIN, 0x2f6fa8);
    } }),
    gasStation: () => ({ w: 26, d: 22, h: 6, draw(S, D) {
      // shop building at the back, canopy over two pump islands at the front
      S.setFrame(...offset(S, 0, 0, -6)); S.walls(14, 9, -1, 4.2, C.PLAIN, 0xf4f4f0, { front: C.SHOP }); S.flat(14, 9, 3.8, 0.4, C.GRAVEL, 0xffffff, C.PLAIN, 0xf4f4f0); S.setFrame(...offset(S, 0, 0, 6));
      S.box(0, 5, 5, 20, 1.0, 10, C.PLAIN, 0xc8282e, { topCell: C.PLAIN, topCol: 0xf0f0f0, bottom: true });
      for (const x of [-6, 6]) { S.box(x, -0.4, 5, 0.6, 5.4, 0.6, C.PLAIN, 0xf0f0f0, { top: false }); D.box(x, 0, 5, 1.0, 1.7, 2.8, C.PLAIN, 0xf8f8f8); D.box(x, 1.5, 5, 1.04, 0.3, 2.84, C.PLAIN, 0xc8282e); }
      D.box(13, -0.4, 10, 0.4, 9, 0.4, C.METAL, 0x888888, { top: false }); D.box(13, 7.5, 10, 0.5, 2.6, 2.6, C.PLAIN, 0xc8282e);
    } }),
  },
};
const rot = (B, a) => B.setFrame(B.fx, B.fy, B.fz, Math.atan2(B.sn, B.cs) + a);
// shift a builder frame by a local offset, returning setFrame args
function offset(B, x, y, z) { return [B.fx + x * B.cs + z * B.sn, B.fy + y, B.fz - x * B.sn + z * B.cs, Math.atan2(B.sn, B.cs)]; }
