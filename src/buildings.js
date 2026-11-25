// Procedural buildings: one facade/roof/ground texture atlas (CC0 ambientCG photo materials from tex/towns/ with
// painted windows, doors, shutters and signs on top), a geometry builder that writes many buildings into a single
// merged mesh (one draw call per chunk), and a kit of building shapes per location style.
// The one building material does the expensive-looking things in the fragment shader: recessed windows (a ray
// through the window reveal), interior-mapped rooms behind the glass (walls, floor, ceiling, furniture, curtains,
// blinds; lit at night with varied colour temperatures), sky reflections on the glass, normal + roughness maps,
// rain streaks, splash dirt at the base of walls and moss/soot on roofs.
import * as THREE from 'three';
import { FOG } from './shaders.js';

// ---------------- atlas layout ----------------
// 8 x 8 cells, each cell = one 3 m x 3 m facade bay (one window, one floor), 3 m x 3 m of roof or of ground.
export const C = {
  PLAIN: 0, WIN_GREEN: 1, WIN_BLUE: 2, WIN: 3, DOOR: 4, WOOD_WIN: 5, WOOD: 6, STONE_WIN: 7,
  ADOBE_WIN: 8, ADOBE: 9, ADOBE_DOOR: 10, APT: 11, WTANK: 12, GLASS: 13, BALCONY: 14, BOARDS: 15,
  METAL: 16, HANGAR_DOOR: 17, TILES: 18, SLATE: 19, SEAM: 20, GRAVEL: 21, SHINGLE: 22, BRICK: 23,
  DARKWOOD: 24, CONCRETE: 25, CHURCH_WIN: 26, GARAGE: 27, THATCH: 28, LOG: 29, STONE: 30, BRICK_WIN: 31,
  CLAP: 32, CLAP_WIN: 33, SHOPFRONT: 34, COBBLE: 35, PAVERS: 36, ASPHALT: 37, DARKTILE: 38, WIN_TALL: 39,
  FRAME: 40, LOUVRE: 41, ADOBE_WIN2: 42, SHOP_DOOR: 43, TIMBER_WIN: 44, MASONRY_WIN: 45, RAIL_WOOD: 46, RAIL_IRON: 47,
  LOG_WIN: 48, TRIM: 49, RUST: 50, MOTEL_DOOR: 51, RUST_DOOR: 52, CLAP_DOOR: 53, WOOD_DOOR: 54, MASONRY_DOOR: 55,
  ROOF_STONES: 56, ROOF_MEMBRANE: 57, SHOP3_N: 58, // (SHOP3_N: a glass tower's lobby)
  LIME: 59, LIME_WIN: 60, BROWN_WIN: 61, // smooth cut stone (ashlar), tinted: limestone / brownstone, tall windows with lintels
  ROOF_TAR: 62, ROOF_GRAVEL: 63, // flat roofs: the tint decides the colour (the ground cells keep most of the photo's)
  // (LOG / LOG_WIN: round logs, Grand Canyon cabins and lodges; TIMBER_WIN: light timber, no flower box (Bora Bora);
  // MASONRY_WIN: a chalet's whitewashed ground floor; MOTEL_DOOR: a motel room's door and window off its walkway)
  // ground floors (facade programs below): SHOPFRONT / SHOP_DOOR a New York storefront's display window / its door
  // (frame and fascia take the shop's colour); RUST / RUST_DOOR a rusticated stone base, a barred window / the entrance;
  // MASONRY_DOOR a chalet's door in its whitewashed ground floor
  // roofs and what stands on them: WTANK a New York water tank's staves and hoops (v 0..1: the whole tank); FRAME its
  // steel stand (cut out: legs, girts and cross bracing, one cell a side); LOUVRE plant rooms, cooling units and a
  // tower's mechanical screen; ROOF_STONES an alpine shingle roof weighted with stones on poles (Legschindeldach);
  // ROOF_MEMBRANE a flat roof's light sheet membrane (seams, patches, a drain)
};
const COLS = 8, ROWS = 8, NCELL = COLS * ROWS, PAD = 1 / 16; // PAD: gutter per side, fraction of a slot
// photo materials in tex/towns/mat_*.jpg (5 x 4 tiles of 512 px, each 3 m square; see tools/towns/bake_materials.py)
const MAT = { plaster: 0, stucco: 1, chalet: 2, clap: 3, barn: 4, timber: 5, brick: 6, stone: 7, clay: 8, slate: 9, darktile: 10, metal: 11, thatch: 12, cobble: 13, pavers: 14, gravel: 15, asphalt: 16, lawn: 17, concrete: 18, ashlar: 19 };
const MAT_AVG = ['#d8d6d2', '#c8c6bc', '#5a4632', '#e2d9a8', '#3a2a1e', '#4a3626', '#9a5040', '#6e6c60', '#a67058', '#3a3c3e', '#2a2a2e', '#8a8c90', '#b7b0a9', '#7a7058', '#bcb8b0', '#c8c4bc', '#7a7a78', '#5a8a2a', '#c4c4c0', '#bebab7'];
export const MAT_FILES = ['tex/towns/mat_color.jpg', 'tex/towns/mat_normal.jpg', 'tex/towns/mat_rough.jpg'];

// Window openings per cell in bay fractions (u0, v0, u1, v1; v up), the frame's outer edge. The shader traces the
// view ray through this opening (reveal of depth `rec`) to the glass plane and on into a room `room` bays deep.
// kind: 0 home, 1 shop, 2 stained glass (no room, glows), 3 neon sign (glows), 4 office.
const WIN = {};
const winCell = (cell, x, y, w, h, rec = 0.05, room = 1.3, kind = 0, sill = true) => { WIN[cell] = { r: [x / 128, 1 - (y + h) / 128, (x + w) / 128, 1 - y / 128], rec, room, kind, sill }; };
winCell(C.WIN_GREEN, 41, 27, 46, 62); winCell(C.WIN_BLUE, 41, 27, 46, 62); winCell(C.WIN, 41, 27, 46, 62);
winCell(C.WOOD_WIN, 39, 23, 50, 58, 0.06, 1.3, 0, false); winCell(C.TIMBER_WIN, 41, 27, 46, 54, 0.06, 1.3, 0, false); winCell(C.LOG_WIN, 41, 29, 46, 50, 0.1, 1.3, 0, false);
winCell(C.MASONRY_WIN, 47, 35, 34, 42, 0.14, 1.2); winCell(C.MOTEL_DOOR, 67, 37, 46, 42, 0.05, 1.3); winCell(C.STONE_WIN, 45, 37, 38, 46, 0.12);
winCell(C.ADOBE_WIN, 46, 40, 36, 44, 0.13); winCell(C.ADOBE_WIN2, 40, 30, 48, 56, 0.12, 1.2);
winCell(C.APT, 25, 21, 78, 76, 0.05, 1.4); winCell(C.BRICK_WIN, 33, 25, 62, 68, 0.07); winCell(C.CLAP_WIN, 43, 25, 42, 64, 0.04);
winCell(C.WIN_TALL, 44, 14, 40, 96, 0.05, 1.4); winCell(C.LIME_WIN, 43, 15, 42, 88, 0.09, 1.4); winCell(C.BROWN_WIN, 44, 19, 40, 84, 0.1, 1.3);
winCell(C.SHOP3_N, 6, 46, 116, 82, 0.03, 1.8, 1);
winCell(C.SHOPFRONT, 8, 44, 112, 58, 0.04, 1.8, 1); winCell(C.SHOP_DOOR, 49, 46, 30, 72, 0.16, 1.6, 1); winCell(C.RUST, 46, 38, 36, 52, 0.14, 1.2); winCell(C.RUST_DOOR, 49, 30, 30, 24, 0.14, 1.0);
winCell(C.GLASS, 0, 16, 128, 112, 0.0, 1.8, 4); winCell(C.BALCONY, 23, 11, 82, 96, 0.06, 1.5);
winCell(C.DOOR, 46, 34, 36, 24, 0.08, 1.0); winCell(C.CHURCH_WIN, 44, 20, 40, 100, 0.08, 1, 2);
winCell(C.HANGAR_DOOR, 8, 20, 112, 18, 0.02, 2.5, 4);
export const WINDOW_RECTS = WIN;

// ---------------- facade programs ----------------
// A wall quad written with a program id (past the 64 atlas cells) is drawn as a whole facade, picked in the shader from
// the fragment's height above the building's floor (atl.z) and its bay (u): no extra vertices for any of it.
//  - the ground floor, its first gH metres: its own cell stretched over that height (or metric: a plinth); a door
//    cell in bay 0 (the writer puts bay 0 where the door goes: -u0), another every `every` bays (shops)
//  - a string course / storefront cornice, band metres above it: a moulded band (the shader shades its profile)
//  - the upper floors: `upper`
//  - the top: past floor line atl.w (the eave, in the wall's v: floors), the parapet (the walls go on up past the
//    flat roof): a moulded cornice there, or plain coping
// Each program is 4 texels of FAC_TEX (row = id): [upper, ground, door, door2] [gH * 20, band * 80, every, flags]
// [band colour, band cell] [ground colour, parapet cell] (colours: linear bytes, as given). flags: 1 the ground cell is metric (a plinth: 3 m tiles),
// 2 the ground takes a shop colour (per shop: three bays), 4 the ground takes its own colour, 8 the band and cornice
// take their own colour (else the building's), 16 a moulded cornice at the top (else plain), 32 the door is the whole
// first floor's bay 0 (v 0..1), over any plinth (gH: a plinth, not a floor)
const NFAC = 256, FAC_DATA = new Uint8Array(4 * NFAC * 4), FAC = new Map(), FAC_SPEC = [];
export const FAC_TEX = new THREE.DataTexture(FAC_DATA, 4, NFAC, THREE.RGBAFormat, THREE.UnsignedByteType);
FAC_TEX.needsUpdate = true;
export function facade({ upper, ground = upper, gH = 0, door = -1, door2 = -1, every = 0, band = 0, bandCell = C.LIME, bandCol = null, groundCol = null, shop = false, metric = false, doorUp = false, top = -1, cornice = false }) {
  const key = [upper, ground, gH, door, door2, every, band, bandCell, bandCol, groundCol, shop, metric, doorUp, top, cornice].join();
  let id = FAC.get(key); if (id != null) return id;
  id = NCELL + FAC.size; if (id >= NFAC) throw new Error('facade programs: table full');
  FAC.set(key, id); FAC_SPEC[id] = { upper, ground, gH, door, door2, every, band, top, cornice };
  const o = id * 16, D = FAC_DATA, lin = (h, k) => { h = h ?? 0xffffff; D[k] = (h >> 16) & 255; D[k + 1] = (h >> 8) & 255; D[k + 2] = h & 255; }; // (colours as stored: linear, like MeshW's)
  D[o] = upper; D[o + 1] = gH > 0 ? ground : upper; D[o + 2] = door < 0 ? 255 : door; D[o + 3] = door2 < 0 ? 255 : door2;
  D[o + 4] = Math.round(gH * 20); D[o + 5] = Math.round(band * 80); D[o + 6] = every;
  D[o + 7] = (metric ? 1 : 0) | (shop ? 2 : 0) | (groundCol != null ? 4 : 0) | (bandCol != null ? 8 : 0) | (cornice ? 16 : 0) | (doorUp ? 32 : 0);
  lin(bandCol, o + 8); D[o + 11] = bandCell; lin(groundCol, o + 12); D[o + 15] = top < 0 ? upper : top;
  FAC_TEX.needsUpdate = true;
  return id;
}
export const facadeSpec = (id) => FAC_SPEC[id] ?? null;
export const linHex = (h) => { _lc.set(h); return (Math.round(_lc.r * 255) << 16) | (Math.round(_lc.g * 255) << 8) | Math.round(_lc.b * 255); }; // (an sRGB colour as the linear bytes a facade takes, like Builder's vertex colours)
const _lc = new THREE.Color();
// a wall id's [ground floor, upper floors] cells (an atlas cell: itself twice)
export const tierCells = (cell) => { const f = FAC_SPEC[cell]; return f ? [f.gH > 0 ? f.ground : f.upper, f.upper] : [cell, cell]; };
// Two-tier walls (the first programs): a chalet's masonry ground floor under its timber, a lodge's stone base under its logs
export const TIER = { CHALET: facade({ upper: C.WOOD_WIN, ground: C.MASONRY_WIN, gH: 2.8 }), LODGE: facade({ upper: C.LOG_WIN, ground: C.STONE_WIN, gH: 3 }) };
 // { cell: { r: [u0, v0, u1, v1], ... } } for geometry (sills) and other modules

// ---------------- texture atlas ----------------
let matImgs = null, matReady = null;
function loadMats() {
  if (matReady || typeof Image === 'undefined') return matReady;
  matImgs = MAT_FILES.map((f) => { const im = new Image(); im.decoding = 'async'; im.src = f; return im; });
  matReady = Promise.all(matImgs.map((im) => (im.decode ? im.decode() : new Promise((res, rej) => { im.onload = res; im.onerror = rej; })))).then(() => true, () => false);
  return matReady;
}
// started by main.js while the hangar is being built (long before the first flight), not at import: at import the
// 4.5 MB would share the connection with the game's own code and hold up the start
export const preloadTownTextures = () => { loadMats(); };
const matsLoaded = () => !!matImgs && matImgs.every((im) => im.complete && im.naturalWidth > 0);

// Hangar idle time (main.js): paint the atlas the first flight will use (~220 ms) once the photos are in, so the Fly
// button doesn't wait for it. (Without the photos it would be painted twice.) Kept for the session like every atlas.
export const prewarmAtlas = (cellPx) => loadMats()?.then((ok) => { if (ok) buildingAtlas(cellPx); });

const _atlases = new Map();
// cellPx: 128 low, 256 medium/high, 384 ultra
export function buildingAtlas(cellPx = 256) {
  if (_atlases.has(cellPx)) return _atlases.get(cellPx);
  const A = { cellPx, map: null, data: null, nrm: null };
  loadMats(); // (normally already started by main.js)
  const make = () => {
    const cv = paintAtlas(cellPx, matsLoaded());
    if (!A.map) {
      A.map = new THREE.CanvasTexture(cv.col); A.map.colorSpace = THREE.SRGBColorSpace;
      A.data = new THREE.CanvasTexture(cv.dat); A.nrm = new THREE.CanvasTexture(cv.nrm);
      for (const t of [A.map, A.data, A.nrm]) { t.anisotropy = 8; t.premultiplyAlpha = false; }
    } else {
      A.map.image = cv.col; A.data.image = cv.dat; A.nrm.image = cv.nrm;
      A.map.needsUpdate = A.data.needsUpdate = A.nrm.needsUpdate = true;
    }
    A.photo = matsLoaded();
  };
  make();
  if (!A.photo && matReady) matReady.then((ok) => { if (ok) make(); }); // repaint in place once the photos arrive
  _atlases.set(cellPx, A);
  return A;
}

function paintAtlas(CELL, photo) {
  // each slot = a content square plus a wrapped gutter (PAD of the slot on every side), so mip-mapping never
  // bleeds a neighbouring cell's colours into this one
  const W = CELL * COLS, H = CELL * ROWS, pad = Math.round(CELL * PAD), cc = CELL - 2 * pad, s = cc / 128;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const cv = mk(), dv = mk(), nv = mk(), hv = mk();
  const g = cv.getContext('2d'), d = dv.getContext('2d'), n = nv.getContext('2d', { willReadFrequently: true }), h = hv.getContext('2d', { willReadFrequently: true });
  d.fillStyle = 'rgb(0,0,217)'; d.fillRect(0, 0, W, H);
  n.fillStyle = 'rgb(128,128,255)'; n.fillRect(0, 0, W, H);
  // roughness sheet tinted into the blue channel once
  let roughBlue = null;
  if (photo) {
    const [, , rIm] = matImgs; roughBlue = document.createElement('canvas'); roughBlue.width = rIm.naturalWidth; roughBlue.height = rIm.naturalHeight;
    const rb = roughBlue.getContext('2d'); rb.drawImage(rIm, 0, 0); rb.globalCompositeOperation = 'multiply'; rb.fillStyle = '#0000ff'; rb.fillRect(0, 0, roughBlue.width, roughBlue.height);
  }
  let rnd = 12345; const R = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  let cellNo = 0;
  const at = (cell) => {
    cellNo = cell; const ox = (cell % COLS) * CELL + pad, oy = Math.floor(cell / COLS) * CELL + pad;
    for (const c of [g, d, h]) { c.setTransform(s, 0, 0, s, ox, oy); }
    n.setTransform(s, 0, 0, s, ox, oy);
    for (const c of [g, d, h, n]) { c.save(); c.beginPath(); c.rect(0, 0, 128, 128); c.clip(); }
  };
  const done = () => { for (const c of [g, d, h, n]) c.restore(); };
  const dat = (win, tint, rough) => `rgb(${Math.round(win * 255)},${Math.round(tint * 255)},${Math.round(rough * 255)})`;
  const hz = (z) => `rgb(${z},${z},${z})`;
  // photo material base for the current cell (or a flat stand-in until the photos have loaded)
  const base = (mat, tint, { rough = null, flip = false } = {}) => {
    if (photo) {
      const sx = (mat % 5) * 512, sy = Math.floor(mat / 5) * 512;
      if (flip) { for (const c of [g, n]) { c.save(); c.translate(128, 0); c.scale(-1, 1); } }
      g.drawImage(matImgs[0], sx + 2, sy + 2, 508, 508, 0, 0, 128, 128); // inset: smoothing must not pull in the next tile
      n.drawImage(matImgs[1], sx + 2, sy + 2, 508, 508, 0, 0, 128, 128);
      if (flip) { g.restore(); n.restore(); }
      d.fillStyle = dat(0, tint, 0); d.fillRect(0, 0, 128, 128);
      if (rough == null) { d.globalCompositeOperation = 'lighter'; d.drawImage(roughBlue, sx + 2, sy + 2, 508, 508, 0, 0, 128, 128); d.globalCompositeOperation = 'source-over'; }
      else { d.fillStyle = dat(0, tint, rough); d.fillRect(0, 0, 128, 128); }
    } else {
      g.fillStyle = MAT_AVG[mat]; g.fillRect(0, 0, 128, 128); d.fillStyle = dat(0, tint, rough ?? 0.85); d.fillRect(0, 0, 128, 128);
    }
  };
  // a painted rect: colour, data (window / tint / roughness) and optionally a relief height (128 = wall plane)
  const P = (x, y, w, hh, col, { tint = 0, win = 0, rough = 0.7, z = null } = {}) => {
    g.fillStyle = col; g.fillRect(x, y, w, hh);
    d.fillStyle = dat(win, tint, rough); d.fillRect(x, y, w, hh);
    if (z != null) { h.fillStyle = hz(z); h.fillRect(x, y, w, hh); }
  };
  const Z = (x, y, w, hh, z) => { h.fillStyle = hz(z); h.fillRect(x, y, w, hh); };
  const grad = (x, y, w, hh, c0, c1, o = {}) => { const gr = g.createLinearGradient(0, y, 0, y + hh); gr.addColorStop(0, c0); gr.addColorStop(1, c1); P(x, y, w, hh, gr, o); };
  const glass = (x, y, w, hh) => grad(x, y, w, hh, '#3d4c58', '#1a232b', { win: 1, rough: 0.05, z: 104 });
  // window: frame (at the glass plane, the reveal is traced by the shader), mullions, a sill below
  const window_ = (x, y, w, hh, { frame = '#f2f0ea', cross = true, sill = '#bdb8ae', transom = 0.36 } = {}) => {
    P(x - 3, y - 3, w + 6, hh + 6, frame, { z: 112, rough: 0.5 }); glass(x, y, w, hh);
    if (cross) { P(x + w / 2 - 1.5, y, 3, hh, frame, { z: 114, rough: 0.5 }); P(x, y + hh * transom, w, 3, frame, { z: 114, rough: 0.5 }); }
    if (sill) { P(x - 6, y + hh + 3, w + 12, 5, sill, { z: 168, rough: 0.6 }); Z(x - 6, y + hh + 7, w + 12, 1, 140); }
    // rain streaks from the sill corners
    g.save(); g.globalAlpha = 0.07; g.fillStyle = '#2a2018'; for (const sx of [x - 4, x + w + 2]) for (let k = 0; k < 3; k++) g.fillRect(sx + R() * 3, y + hh + 8, 1.2 + R(), 14 + R() * 26); g.restore();
  };
  const louvres = (x, y, w, hh, col, z = 150) => { P(x, y, w, hh, col, { z, rough: 0.6 }); for (let k = y + 3; k < y + hh - 2; k += 4) { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x + 1.5, k, w - 3, 1.4); Z(x + 1.5, k, w - 3, 1.4, z - 14); } P(x, y, w, 2, col, { z: z + 4 }); P(x, y + hh - 2, w, 2, col, { z: z + 4 }); };
  const shutters = (x, y, w, hh, col) => { const sw = w * 0.46; for (const sx of [x - 4 - sw, x + w + 4]) louvres(sx, y - 3, sw, hh + 6, col); };
  const flowerBox = (x, y, w) => {
    P(x, y, w, 9, '#5a3a1e', { z: 190, rough: 0.8 });
    for (let k = 0; k < w / 3.2; k++) { const c = ['#d0283c', '#e8405a', '#c81e30', '#f05a78', '#e8e0e0'][Math.floor(R() * 5)]; g.fillStyle = c; h.fillStyle = hz(200); for (const cc of [g, h]) { cc.beginPath(); cc.arc(x + 2 + k * 3.2 + R() * 2, y - 1 - R() * 6, 2.4 + R() * 1.4, 0, 7); cc.fill(); } }
    for (let k = 0; k < w / 2.5; k++) { g.fillStyle = ['#3e6a2a', '#2e5a22', '#4e7a32'][k % 3]; g.beginPath(); g.ellipse(x + 1 + k * 2.5, y - 1, 2, 3.2, R(), 0, 7); g.fill(); }
    // trailing geraniums
    for (let k = 0; k < w / 6; k++) { const xx = x + 2 + k * 6 + R() * 3; for (let j = 0; j < 4; j++) { g.fillStyle = j % 2 ? '#3e6a2a' : '#d0283c'; g.beginPath(); g.arc(xx + R() * 2, y + 9 + j * 3, 1.8, 0, 7); g.fill(); } }
  };
  const door = (x, y, w, hh, col, { frame = '#d8d4cc', glassTop = true, panels = true } = {}) => {
    P(x - 4, y - 4, w + 8, hh + 4, frame, { z: 150 }); P(x, y, w, hh, col, { z: 110, rough: 0.55 });
    if (panels) for (const [py, ph] of [[y + 8, hh * 0.3], [y + hh * 0.48, hh * 0.42]]) { P(x + 5, py, w / 2 - 7, ph, col, { z: 100 }); P(x + w / 2 + 2, py, w / 2 - 7, ph, col, { z: 100 }); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + 5, py, w / 2 - 7, 1.5); g.fillRect(x + w / 2 + 2, py, w / 2 - 7, 1.5); }
    if (glassTop) glass(x + 6, y + 6, w - 12, hh * 0.22);
    P(x + w - 9, y + hh * 0.55, 3, 3, '#c8b070', { z: 140, rough: 0.3 });
    P(x - 8, y + hh, w + 16, 128 - y - hh, '#a8a49c', { z: 150, rough: 0.8 }); // step
  };

  // ---- walls ----
  at(C.PLAIN); base(MAT.plaster, 1); done();
  for (const [cell, sh] of [[C.WIN_GREEN, '#3f6a3c'], [C.WIN_BLUE, '#2f6fa8'], [C.WIN, null]]) { at(cell); base(MAT.plaster, 1); window_(44, 30, 40, 56); if (sh) shutters(44, 30, 40, 56, sh); done(); }
  at(C.WIN_TALL); base(MAT.plaster, 1); window_(47, 17, 34, 90, { transom: 0.22 }); shutters(47, 17, 34, 90, '#4f7f9a'); P(40, 104, 48, 3, '#2a2a2a', { z: 190, rough: 0.4 }); for (let k = 42; k < 88; k += 5) P(k, 90, 1.5, 15, '#2a2a2a', { z: 190, rough: 0.4 }); done();
  at(C.DOOR); base(MAT.plaster, 1); door(42, 26, 44, 102, '#6b4529'); P(36, 16, 56, 6, '#b8b4ac', { z: 170 }); done();
  // chalet timber: horizontal boards, window with flower box; a pair of small windows with red/white shutters
  at(C.WOOD); base(MAT.chalet, 0.35); done();
  at(C.WOOD_WIN); base(MAT.chalet, 0.35); window_(42, 26, 44, 52, { frame: '#efe8da', sill: null }); flowerBox(36, 87, 56); done();
  at(C.WOOD_DOOR); base(MAT.chalet, 0.35); door(40, 22, 48, 106, '#5a3a20', { frame: '#7a5a3a' }); P(34, 12, 60, 8, '#4a3020', { z: 170 }); done();
  // natural wood from the pale painted-board photo: its hue and saturation replaced by a wood colour (the luminance kept),
  // so the building's tint can make it any timber from pale to brown
  const woodWash = (mat, col, a) => { base(mat, 1); g.save(); g.globalCompositeOperation = 'color'; g.globalAlpha = a; g.fillStyle = col; g.fillRect(0, 0, 128, 128); g.restore(); };
  // light timber (Bora Bora's bungalows and island houses): pale boards, a plain window in a dark wood frame, no flower box
  at(C.TIMBER_WIN); woodWash(MAT.clap, '#b08a5a', 1); g.save(); g.globalAlpha = 0.1; for (let k = 0; k < 40; k++) { g.fillStyle = R() < 0.5 ? '#5a3a1a' : '#fff4dc'; g.fillRect(0, R() * 128, 128, 0.8 + R()); } g.restore();
  P(37, 23, 54, 62, '#7a5a3a', { z: 150, rough: 0.7 }); window_(41, 27, 46, 54, { frame: '#6a4a2e', sill: null }); done();
  // round logs (Grand Canyon cabins and lodges): rounded courses with dark chinking between, tinted per building
  const logs = () => { woodWash(MAT.plaster, '#a07a50', 0.9); g.save(); g.globalAlpha = 0.12; for (let k = 0; k < 90; k++) { g.fillStyle = R() < 0.5 ? '#3a2410' : '#fff0d8'; g.fillRect(R() * 128 - 20, R() * 128, 10 + R() * 40, 0.8); } g.restore(); for (let y = 0; y < 128; y += 16) { for (const [dy, hh, a, z] of [[0, 3, 0.2, 140], [3, 4, 0, 158], [7, 5, -0.08, 150], [12, 2.5, -0.2, 132], [14.5, 1.5, -0.45, 104]]) { g.save(); g.globalAlpha = Math.abs(a); g.fillStyle = a > 0 ? '#fff0d8' : '#1a1008'; g.fillRect(0, y + dy, 128, hh); g.restore(); Z(0, y + dy, 128, hh, z); } } };
  at(C.LOG); logs(); done();
  at(C.LOG_WIN); logs(); P(35, 23, 58, 62, '#4a3220', { z: 165, rough: 0.8 }); window_(41, 29, 46, 50, { frame: '#e6dcc4', sill: null }); done();
  // a chalet's ground floor: whitewashed masonry (barely tinted: the timber colour above is the building's), a small deep window in a stone surround
  at(C.MASONRY_WIN); base(MAT.plaster, 0.12); P(42, 30, 44, 52, '#d6d0c2', { tint: 0.12, z: 146, rough: 0.8 }); window_(47, 35, 34, 42, { frame: '#f4f0e6', sill: '#c8c2b4' }); done();
  // motel room off an outdoor walkway: stucco, a panelled door and a picture window
  at(C.MOTEL_DOOR); base(MAT.stucco, 1); door(14, 30, 36, 98, '#6a4a30', { frame: '#e8e0d0', glassTop: false }); P(60, 32, 60, 56, '#e8e0d0', { z: 150 }); window_(67, 37, 46, 42, { frame: '#ece6da', cross: false, sill: null }); P(54, 40, 3, 6, '#f0d890', { z: 170, rough: 0.3 }); done();
  at(C.STONE); base(MAT.stone, 0.25); done();
  at(C.STONE_WIN); base(MAT.stone, 0.25); P(44, 34, 40, 4, '#9a968c', { z: 160 }); window_(48, 40, 32, 40, { frame: '#e8e2d6' }); done();
  // cut stone (pre-war limestone, brownstone; all tinted per building): a string course at the floor line, tall
  // one-over-one sash windows; flat lintels with a keystone on limestone, a hood on corbels on brownstone
  const sash = (x, y, w, hh, frame, sill) => { window_(x, y, w, hh, { frame, cross: false, sill }); P(x, y + hh * 0.5 - 1.5, w, 3, frame, { z: 114, rough: 0.5 }); };
  const st = { tint: 1, rough: 0.75 };
  at(C.LIME); base(MAT.ashlar, 1); P(0, 123, 128, 5, '#f4f2ee', { ...st, z: 150 }); done();
  at(C.LIME_WIN); base(MAT.ashlar, 1); P(0, 123, 128, 5, '#f4f2ee', { ...st, z: 150 }); sash(46, 18, 36, 82, '#ece8e0', '#f2f0ea');
  P(39, 6, 50, 8, '#f6f4f0', { ...st, z: 162 }); P(59, 3, 10, 12, '#fbfaf8', { ...st, z: 172 }); Z(39, 13, 50, 1, 140); done();
  at(C.BROWN_WIN); base(MAT.ashlar, 1); P(0, 123, 128, 5, '#e8e4de', { ...st, z: 150 }); sash(47, 22, 34, 78, '#2e2a26', '#ece8e2');
  P(36, 6, 56, 6, '#f8f6f2', { ...st, z: 180 }); P(38, 12, 52, 5, '#ece8e2', { ...st, z: 168 }); for (const x of [38, 84]) P(x, 17, 6, 7, '#e4e0da', { ...st, z: 160 }); done();
  // adobe / pueblo revival: deep-set windows with timber lintels, turquoise doors
  const adobe = () => { base(MAT.stucco, 1); g.save(); g.globalAlpha = 0.18; g.fillStyle = '#a07850'; g.fillRect(0, 0, 128, 128); g.restore(); };
  at(C.ADOBE); adobe(); done();
  at(C.ADOBE_WIN); adobe(); window_(50, 44, 28, 36, { frame: '#5a4636', sill: '#c8b8a0', cross: false }); P(40, 32, 48, 7, '#6a4428', { z: 175, rough: 0.9 }); done();
  at(C.ADOBE_WIN2); adobe(); window_(44, 34, 40, 48, { frame: '#2f7f86' }); P(36, 24, 56, 7, '#6a4428', { z: 175, rough: 0.9 }); done();
  at(C.ADOBE_DOOR); adobe(); door(44, 36, 40, 92, '#2f7f86', { frame: '#5a4636', glassTop: false }); P(36, 26, 56, 8, '#6a4428', { z: 175 }); done();
  // apartment / hotel / office
  at(C.APT); base(MAT.plaster, 1); P(0, 122, 128, 6, '#c9c6c0', { tint: 0.5, z: 150 }); window_(28, 24, 72, 70, { frame: '#e2e0da', cross: false }); P(62, 24, 4, 70, '#e2e0da', { z: 114 }); done();
  at(C.BALCONY); base(MAT.plaster, 1); window_(26, 14, 76, 90, { frame: '#ececea', cross: false, sill: null }); P(62, 14, 4, 90, '#ececea', { z: 114 }); P(0, 110, 128, 18, '#d8d6d0', { tint: 0.4, z: 150 }); done();
  at(C.GLASS); P(0, 0, 128, 128, '#5a6068', { rough: 0.3, z: 140 }); grad(0, 16, 128, 112, '#3e5466', '#1c2a36', { win: 1, rough: 0.04, z: 120 }); P(0, 0, 128, 16, '#8a9096', { tint: 0.3, z: 140 }); for (let k = 0; k < 128; k += 32) P(k, 0, 3, 128, '#9aa0a6', { z: 136, rough: 0.3 }); P(0, 70, 128, 3, '#9aa0a6', { z: 136, rough: 0.3 }); done();
  at(C.BRICK); base(MAT.brick, 0.25); done();
  at(C.BRICK_WIN); base(MAT.brick, 0.25); window_(36, 28, 56, 62, { frame: '#efece4' }); P(32, 20, 64, 6, '#d0c8bc', { z: 165 }); done();
  // clapboard (islands, ranch houses): painted boards, white trim, louvred shutters
  at(C.CLAP); base(MAT.clap, 1); done();
  at(C.CLAP_WIN); base(MAT.clap, 1); P(40, 22, 48, 70, '#f6f6f2', { z: 150 }); window_(46, 28, 36, 58, { frame: '#ffffff', sill: '#f0f0ea' }); shutters(46, 28, 36, 58, '#2f7f86'); done();
  at(C.CLAP_DOOR); base(MAT.clap, 1); door(42, 24, 44, 104, '#2f6f9f', { frame: '#ffffff' }); done();
  { at(C.SHOP3_N); base(MAT.plaster, 1); P(0, 0, 128, 40, '#2a2a2c', { z: 150, rough: 0.4 }); P(4, 44, 120, 84, '#55585c', { z: 150, rough: 0.4 }); glass(9, 49, 110, 79); for (let k = 9; k < 119; k += 27) P(k, 49, 2, 79, '#55585c', { z: 140 }); done(); }
  // ---- ground floors (facade programs: the floor's cell is stretched over its own height, gH) ----
  // a New York storefront (traced from tenement shops in the Village and on Eighth Avenue): a sign fascia, a transom of
  // small panes, the display window over a panelled bulkhead on a granite step, cast-iron piers either side. The frame,
  // fascia and bulkhead take the shop's colour (tint); the piers are the building's stone.
  const shopTop = () => {
    P(0, 0, 128, 24, '#f0eeea', { tint: 1, z: 166, rough: 0.5 }); P(0, 0, 128, 3, '#fafaf8', { tint: 1, z: 174 }); P(0, 21, 128, 3, '#c4c2be', { tint: 1, z: 158 });
    P(4, 24, 120, 20, '#e8e8e6', { tint: 1, z: 140, rough: 0.5 }); for (let x = 8; x < 120; x += 16) glass(x, 27, 13, 13); // transom
  };
  const pier = (x, w) => { P(x, 0, w, 128, '#d6d0c2', { z: 178, rough: 0.85 }); g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(x + w - 1, 24, 1, 104); };
  const bulk = (x, w) => { P(x, 102, w, 18, '#e2e2e0', { tint: 1, z: 150, rough: 0.6 }); P(x + 3, 105, w - 6, 12, '#c8c8c6', { tint: 1, z: 140, rough: 0.6 }); P(x, 120, w, 8, '#4c4a48', { z: 150, rough: 0.7 }); };
  at(C.SHOPFRONT); base(MAT.ashlar, 0.5); shopTop(); P(4, 42, 120, 60, '#e8e8e6', { tint: 1, z: 136, rough: 0.5 }); glass(8, 44, 112, 58); P(62, 44, 4, 58, '#e8e8e6', { tint: 1, z: 138, rough: 0.5 });
  bulk(4, 120); pier(0, 4); pier(124, 4); done();
  // its door: recessed between two narrow display windows, a glazed door with a kick plate
  at(C.SHOP_DOOR); base(MAT.ashlar, 0.5); shopTop(); g.fillStyle = '#f6eed6'; g.font = 'bold 12px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('DELI & GROCERY', 64, 12.5, 112); // (the shop's name over its door) P(4, 42, 120, 86, '#e8e8e6', { tint: 1, z: 136, rough: 0.5 }); for (const x of [8, 88]) { glass(x, 44, 32, 58); bulk(x - 4, 40); }
  P(44, 42, 40, 86, '#24221f', { z: 96, rough: 0.8 }); P(46, 44, 36, 84, '#e0e0de', { tint: 1, z: 104, rough: 0.45 }); glass(49, 46, 30, 72); P(49, 118, 30, 8, '#a8a8a4', { z: 106, rough: 0.3 });
  P(76, 80, 2, 10, '#d8d4c8', { z: 112, rough: 0.3 }); pier(0, 4); pier(124, 4); done();
  // a rusticated stone base (Striver's Row, the pre-war apartment houses, a brownstone's raised basement): deep
  // horizontal channels, a flat lintel with a keystone over a barred window, a granite water table
  const rust = () => {
    base(MAT.ashlar, 1);
    for (let y = 0, k = 0; y < 114; y += 19, k++) { P(0, y + 16, 128, 3, '#8a8680', { tint: 1, z: 112 }); Z(0, y + 15, 128, 1, 124); for (let x = (k & 1) * 21; x < 128; x += 42) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y, 1, 16); } }
    P(0, 114, 128, 14, '#9a9690', { tint: 0.5, z: 150, rough: 0.8 }); P(0, 114, 128, 2, '#c8c4bc', { tint: 0.5, z: 158 });
  };
  at(C.RUST); rust(); window_(46, 38, 36, 52, { frame: '#3a3632', cross: false, sill: '#e8e4dc' }); for (let x = 50; x < 82; x += 6) P(x, 38, 1.6, 52, '#1c1a18', { z: 122, rough: 0.5 });
  P(40, 27, 48, 9, '#f4f2ee', { tint: 1, z: 172 }); P(59, 24, 10, 13, '#fbfaf8', { tint: 1, z: 180 }); done();
  // the entrance: a panelled door with a glazed top between pilasters, under an entablature
  at(C.RUST_DOOR); rust(); P(34, 12, 60, 9, '#f6f4f0', { tint: 1, z: 190 }); P(36, 21, 56, 3, '#d8d4cc', { tint: 1, z: 170 }); for (const x of [36, 86]) P(x, 24, 6, 90, '#efece6', { tint: 1, z: 168 });
  door(46, 24, 36, 92, '#3a2a1e', { frame: '#2a2018' }); done();
  // a chalet's door in its whitewashed ground floor: dark vertical planks, a stone surround, a lamp
  at(C.MASONRY_DOOR); base(MAT.plaster, 0.12); P(38, 20, 52, 108, '#d2ccbe', { tint: 0.12, z: 150, rough: 0.8 }); P(44, 26, 40, 102, '#5a3c22', { z: 110, rough: 0.8 });
  for (let x = 51; x < 84; x += 7) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, 26, 1, 102); } for (const y of [40, 104]) P(46, y, 30, 3, '#2a2a2a', { z: 116, rough: 0.5 });
  P(78, 76, 3, 4, '#c8b070', { z: 140, rough: 0.3 }); P(94, 30, 6, 9, '#f0d890', { z: 170, rough: 0.3 }); done();
  // ---- industrial ----
  at(C.BOARDS); base(MAT.barn, 0.55); done();
  at(C.METAL); base(MAT.metal, 0.9); done();
  at(C.HANGAR_DOOR); base(MAT.metal, 0.6); P(0, 0, 3, 128, '#55595e', { z: 100 }); P(0, 60, 128, 3, '#8a8e94', { tint: 0.6, z: 150 }); glass(8, 20, 112, 18); done();
  at(C.GARAGE); base(MAT.plaster, 1); P(8, 26, 112, 102, '#d0ccc4', { z: 150 }); P(12, 30, 104, 98, '#9a9890', { z: 112 }); for (let y = 34; y < 128; y += 12) { P(14, y, 100, 10, '#e2e0da', { tint: 0.3, z: 118, rough: 0.4 }); Z(14, y + 9, 100, 1, 104); } done();
  at(C.CONCRETE); base(MAT.concrete, 0.4); done();
  at(C.TRIM); P(0, 0, 128, 128, '#f2f0ea', { tint: 1, rough: 0.55 }); for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(0,0,0,${0.02 + R() * 0.03})`; g.fillRect(0, R() * 128, 128, 1); } done();
  // ---- roofs ----
  at(C.TILES); base(MAT.clay, 0.55); done();
  at(C.SLATE); base(MAT.slate, 1); done();
  at(C.DARKTILE); base(MAT.darktile, 1); done();
  at(C.THATCH); base(MAT.thatch, 1); done(); // (the photo is baked pale grey: the straw tint decides)
  at(C.ROOF_TAR); base(MAT.asphalt, 1); done(); at(C.ROOF_GRAVEL); base(MAT.gravel, 1); done();
  at(C.SEAM); P(0, 0, 128, 128, '#d4d4d4', { tint: 1, rough: 0.35 }); for (let k = 0; k < 128; k += 21) { P(k, 0, 3, 128, '#f4f4f4', { tint: 1, rough: 0.3, z: 170 }); P(k + 3, 0, 2, 128, '#9a9a9a', { tint: 1, z: 150 }); } done();
  // weathered larch shingles (traced from laid-shingle roofs in the Alps: silver-grey to grey-brown, each shingle its
  // own shade, dark gaps between, a shadow under each course); half tinted: the roof's colour leans them brown or grey
  const shingles = (dy = 10.67) => {
    P(0, 0, 128, 128, '#4a443c', { tint: 0.5, rough: 0.95 });
    for (let y = 0; y < 128; y += dy) for (let x = R() * 8 - 8; x < 128; x += 5 + R() * 4) {
      const v = R(), w = 4 + R() * 4, c = Math.round(96 + v * 70);
      P(x, y, w, dy, `rgb(${c},${Math.round(c * 0.96)},${Math.round(c * 0.9)})`, { tint: 0.5, rough: 0.95, z: 128 + Math.round((y % (dy * 2)) / dy) * 6 });
      g.fillStyle = 'rgba(20,16,12,0.55)'; g.fillRect(x + w - 0.8, y, 0.8, dy); // (the gap)
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, y + dy - 1.6, w, 1.6); Z(x, y + dy - 1.6, w, 1.6, 116); // (the course's shadow)
      if (R() < 0.15) { g.fillStyle = 'rgba(90,96,60,0.25)'; g.fillRect(x, y + dy * 0.5, w, dy * 0.5); } // (lichen)
    }
  };
  at(C.SHINGLE); shingles(); done();
  // the same, weighted with stones (Legschindeldach): a pole across the roof every metre, fieldstones resting on it
  at(C.ROOF_STONES); shingles();
  for (let k = 0; k < 3; k++) {
    const yp = 34 + k * 42.67;
    P(0, yp, 128, 3.2, '#5a4c3e', { tint: 0.3, rough: 0.9, z: 168 }); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, yp + 3.2, 128, 2);
    for (let x = R() * 12; x < 128; x += 13 + R() * 13) {
      const r = 4.5 + R() * 3.5, cy = yp - r * 0.45, v = Math.round(120 + R() * 60);
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.beginPath(); g.ellipse(x + 1.5, cy + r * 0.55, r * 1.05, r * 0.6, 0, 0, 7); g.fill(); // (its shadow down the roof)
      for (const c of [g, h]) { c.fillStyle = c === g ? `rgb(${v},${v - 4},${v - 10})` : hz(215); c.beginPath(); c.ellipse(x, cy, r, r * 0.72, R() - 0.5, 0, 7); c.fill(); }
      d.fillStyle = dat(0, 0, 0.9); d.beginPath(); d.ellipse(x, cy, r, r * 0.72, 0, 0, 7); d.fill(); // (stone: not tinted)
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.ellipse(x - r * 0.3, cy - r * 0.25, r * 0.45, r * 0.3, 0, 0, 7); g.fill();
    }
  }
  done();
  // a flat roof's light membrane (white / grey sheet roofing on the city's flat roofs, traced from aerial photos of
  // Manhattan: sheets with lapped seams a metre or so apart, darker patches, a drain with its stain)
  at(C.ROOF_MEMBRANE); base(MAT.concrete, 1); g.save(); g.globalAlpha = 0.55; g.fillStyle = '#dcdcd8'; g.fillRect(0, 0, 128, 128); g.restore();
  for (let y = 18; y < 128; y += 40 + R() * 6) { P(0, y, 128, 2.2, '#f4f4f2', { tint: 1, rough: 0.6, z: 140 }); g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y + 2.2, 128, 1.2); }
  for (let k = 0; k < 3; k++) { const x = R() * 100, y = R() * 100, w = 10 + R() * 24, hh = 8 + R() * 16; g.fillStyle = `rgba(${R() < 0.5 ? '90,88,84' : '255,255,250'},0.16)`; g.fillRect(x, y, w, hh); }
  { const gr = g.createRadialGradient(96, 84, 1, 96, 84, 18); gr.addColorStop(0, 'rgba(40,38,34,0.5)'); gr.addColorStop(1, 'rgba(40,38,34,0)'); g.fillStyle = gr; g.fillRect(70, 60, 50, 50); P(93, 81, 6, 6, '#3a3a3a', { rough: 0.5, z: 110 }); }
  done();
  // a water tank's staves (traced from SoHo's and Midtown's: weathered cedar gone silver-grey, every stave its own shade
  // with a dark joint, the steel hoops closer together low down where the pressure is, rust bleeding from them, a dark
  // chime at the foot, water stains darkening the lower staves). v 0..1 is the whole tank, foot to rim
  at(C.WTANK); P(0, 0, 128, 128, '#d4d0c8', { tint: 1, rough: 0.9 });
  for (let x = 0; x < 128; x += 128 / 30) { const v = R(); g.fillStyle = v < 0.5 ? `rgba(40,34,28,${0.05 + R() * 0.14})` : `rgba(255,250,240,${0.04 + R() * 0.1})`; g.fillRect(x, 0, 128 / 30, 128); g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, 0, 0.7, 128); Z(x, 0, 0.7, 128, 112); }
  { const gr = g.createLinearGradient(0, 128, 0, 40); gr.addColorStop(0, 'rgba(30,26,22,0.35)'); gr.addColorStop(1, 'rgba(30,26,22,0)'); g.fillStyle = gr; g.fillRect(0, 40, 128, 88); }
  for (let k = 0, y = 119; k < 13 && y > 4; k++, y -= 4.4 + k * 0.72) {
    P(0, y, 128, 1.5, '#3a3430', { tint: 0, rough: 0.5, z: 152 });
    g.save(); g.globalAlpha = 0.12; g.fillStyle = '#6a3a1c'; for (let j = 0; j < 6; j++) g.fillRect(R() * 128, y + 1.5, 1 + R(), 3 + R() * 8); g.restore();
  }
  P(0, 123, 128, 5, '#2e2a26', { tint: 0, rough: 0.8, z: 150 }); P(0, 0, 128, 3, '#2e2a26', { tint: 0, rough: 0.8, z: 140 });
  done();
  // the tank's steel stand, one side of it (cut out: alpha): two legs, girts top, middle and foot, cross bracing in each
  // panel (dark painted steel: the vertex colour)
  at(C.FRAME); g.clearRect(0, 0, 128, 128); d.fillStyle = dat(0, 1, 0.55); d.fillRect(0, 0, 128, 128);
  { const st = { tint: 1, rough: 0.55, z: 165 }, cl = '#d8d8d6'; P(0, 0, 10, 128, cl, st); P(118, 0, 10, 128, cl, st); for (const y of [0, 60, 121]) P(0, y, 128, 7, cl, st);
    for (const c of [g, h]) { c.strokeStyle = c === g ? cl : hz(160); c.lineWidth = 4; c.beginPath(); for (const [y0, y1] of [[7, 60], [67, 121]]) { c.moveTo(10, y0); c.lineTo(118, y1); c.moveTo(118, y0); c.lineTo(10, y1); } c.stroke(); } }
  done();
  // louvres: plant rooms, rooftop units, a tower's mechanical screen (horizontal blades, each throwing a shadow, mullions)
  at(C.LOUVRE); P(0, 0, 128, 128, '#5a5c5e', { tint: 1, rough: 0.5, z: 110 });
  for (let y = 3; y < 125; y += 6) { P(1, y, 126, 3.2, '#e4e4e2', { tint: 1, rough: 0.45, z: 152 }); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(1, y + 3.2, 126, 1.4); }
  for (const x of [0, 42, 85, 125]) P(x, 0, 3, 128, '#d6d6d4', { tint: 1, rough: 0.45, z: 168 }); P(0, 0, 128, 3, '#d6d6d4', { tint: 1, z: 168 }); P(0, 125, 128, 3, '#d6d6d4', { tint: 1, z: 168 });
  done();
  // ---- ground ----
  at(C.GRAVEL); base(MAT.gravel, 0.7); done();
  at(C.COBBLE); base(MAT.cobble, 0.3); done();
  at(C.PAVERS); base(MAT.pavers, 0.5); done();
  at(C.ASPHALT); base(MAT.asphalt, 0.3); done();
  // ---- special ----
  at(C.CHURCH_WIN); base(MAT.plaster, 1);
  g.fillStyle = '#e8e4dc'; h.fillStyle = hz(150); for (const c of [g, h]) { c.beginPath(); c.moveTo(40, 124); c.lineTo(40, 40); c.arc(64, 40, 24, Math.PI, 0); c.lineTo(88, 124); c.fill(); }
  // plain leaded glass (village churches): pale panes, a lead grid, no colours
  for (let k = 0; k < 13; k++) { const y = 22 + k * 8; P(48, Math.max(y, 26), 32, 8, k % 2 ? '#8c9a98' : '#7e8c8c', { win: 1, rough: 0.1, z: 110 }); }
  g.fillStyle = 'rgba(40,44,44,0.7)'; for (let y = 30; y < 120; y += 8) g.fillRect(48, y, 32, 1); for (const x of [55, 72]) g.fillRect(x, 26, 1, 94);
  g.fillStyle = '#e8e4dc'; g.fillRect(63, 22, 2, 98); done();
  // balcony railings with cut-outs (alpha): carved chalet boards, wrought iron
  at(C.RAIL_WOOD); base(MAT.timber, 0.4); P(0, 0, 128, 10, '#4a3020', { z: 160 }); P(0, 118, 128, 10, '#4a3020', { z: 160 });
  for (let k = 0; k < 8; k++) { const cx = 8 + k * 16; for (const c of [g, h]) { c.save(); c.globalCompositeOperation = c === g ? 'destination-out' : 'source-over'; if (c === h) c.fillStyle = hz(90); c.beginPath(); c.ellipse(cx, 52, 3.2, 10, 0, 0, 7); c.moveTo(cx + 4, 80); c.arc(cx, 80, 4, 0, 7); c.moveTo(cx + 2, 98); c.ellipse(cx, 98, 2, 6, 0, 0, 7); c.fill(); c.restore(); } }
  done();
  at(C.RAIL_IRON); g.clearRect(0, 0, 128, 128); d.fillStyle = dat(0, 1, 0.4); d.fillRect(0, 0, 128, 128);
  const ir = { tint: 1, rough: 0.4, z: 160 }; P(0, 0, 128, 7, '#e8e8e6', ir); P(0, 120, 128, 5, '#e8e8e6', ir); for (let k = 2; k < 128; k += 9) P(k, 6, 2.6, 114, '#e8e8e6', ir);
  g.strokeStyle = '#e8e8e6'; g.lineWidth = 1.8; for (let k = 6; k < 128; k += 18) { g.beginPath(); g.arc(k + 4.5, 30, 6, 0, 7); g.stroke(); }
  done();

  // relief -> normals: wherever something was painted with a height, Sobel it into the normal atlas
  for (const c of [g, d, n, h]) c.setTransform(1, 0, 0, 1, 0, 0);
  const hp = h.getImageData(0, 0, W, H).data, ni = n.getImageData(0, 0, W, H), np = ni.data, k = 2.2 / s;
  const hv_ = (i) => (hp[i * 4 + 3] > 0 ? hp[i * 4] : 128);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!(hp[i * 4 + 3] || hp[(i - 1) * 4 + 3] || hp[(i + 1) * 4 + 3] || hp[(i - W) * 4 + 3] || hp[(i + W) * 4 + 3])) continue;
    const dx = (hv_(i + 1) - hv_(i - 1)) * k / 255 * 40, dy = (hv_(i - W) - hv_(i + W)) * k / 255 * 40, l = Math.hypot(dx, dy, 1);
    np[i * 4] = Math.round((-dx / l * 0.5 + 0.5) * 255); np[i * 4 + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); np[i * 4 + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
  }
  n.putImageData(ni, 0, 0);
  // fill the gutters by wrapping each cell's content around
  for (const c of [g, d, n]) {
    const cvs = c.canvas;
    for (let cell = 0; cell < NCELL; cell++) {
      const x0 = (cell % COLS) * CELL + pad, y0 = Math.floor(cell / COLS) * CELL + pad;
      const cp = (sx, sy, w, hh, dx, dy) => { c.clearRect(dx, dy, w, hh); c.drawImage(cvs, sx, sy, w, hh, dx, dy, w, hh); };
      cp(x0 + cc - pad, y0, pad, cc, x0 - pad, y0); cp(x0, y0, pad, cc, x0 + cc, y0);
      cp(x0 - pad, y0 + cc - pad, cc + 2 * pad, pad, x0 - pad, y0 - pad); cp(x0 - pad, y0, cc + 2 * pad, pad, x0 - pad, y0 + cc);
    }
  }
  // the railing / iron cells carry alpha in the colour atlas; everything else is opaque
  return { col: cv, dat: dv, nrm: nv };
}

// Shared uniforms (updated by Towns.update): daylight 0..1 for the brightness of rooms behind the glass by day.
export const BLD_U = { uDay: { value: 1 } };

// ---------------- destruction (destruction.js) ----------------
// Every building vertex has a `dmg` byte saying what's left of its building: 0 intact, 255 gone (the vertex shader
// drops it), 1..254 a damage slot: a row of DMG.tex with the height above which the building has fallen (jagged
// edge: cutY, jag amplitude, power cut, -) and up to DMG_HOLES holes (x, y, z, r) punched through it. Only the
// damaged buildings' fragments do any of this work (a flat varying). A building's vertices are one contiguous run,
// so knocking it down is a few bytes uploaded (destruction.js).
// Geometries are given the attribute by the writers (Builder here, MeshW in realCity.js): dmgW, runs [start, count,
// value] written before the geometry exists.
export const DMG_SLOTS = 256, DMG_HOLES = 3;
const dmgData = new Float32Array(DMG_SLOTS * (1 + DMG_HOLES) * 4);
for (let s = 0; s < DMG_SLOTS; s++) dmgData[s * (1 + DMG_HOLES) * 4] = 1e9; // (no cut)
const dmgTex = new THREE.DataTexture(dmgData, 1 + DMG_HOLES, DMG_SLOTS, THREE.RGBAFormat, THREE.FloatType);
dmgTex.needsUpdate = true;
export const DMG = { tex: dmgTex, data: dmgData, U: { tDmg: { value: dmgTex } } };
// (the building material already has its world position varying, vWP: the shadow material brings its own)
const DMG_VERT_HEAD = 'attribute float dmg; flat varying float vDmgS;', DMG_VERT = 'vDmgS = dmg;';
const DMG_DEPTH_VERT_HEAD = DMG_VERT_HEAD + ' varying vec3 vDmgP;', DMG_DEPTH_VERT = DMG_VERT + ' vDmgP = (modelMatrix * vec4(position, 1.0)).xyz;';
const DMG_VERT_KILL = 'if (dmg > 254.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);'; // a removed building: off screen (whole triangles)
const DMG_FRAG_HEAD = `uniform highp sampler2D tDmg; flat varying float vDmgS; float dmgChar = 0.0, dmgDark = 0.0;
  float dmgH(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float dmgN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dmgH(i), dmgH(i + vec3(1, 0, 0)), f.x), mix(dmgH(i + vec3(0, 1, 0)), dmgH(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(dmgH(i + vec3(0, 0, 1)), dmgH(i + vec3(1, 0, 1)), f.x), mix(dmgH(i + vec3(0, 1, 1)), dmgH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }`;
const DMG_FRAG = `if (vDmgS > 0.5) {
    int dS = int(vDmgS + 0.5); vec4 d0 = texelFetch(tDmg, ivec2(0, dS), 0);
    float above = vDmgP.y - d0.x - (dmgN(vec3(vDmgP.xz * 0.35, 0.5)) * 0.7 + dmgN(vec3(vDmgP.xz * 1.3, 2.5)) * 0.3 - 0.5) * d0.y;
    if (above > 0.0) discard;
    dmgChar = 1.0 - smoothstep(0.0, 2.5 + d0.y, -above); dmgDark = d0.z;
    for (int k = 1; k <= ${DMG_HOLES}; k++) {
      vec4 h = texelFetch(tDmg, ivec2(k, dS), 0);
      if (h.w > 0.0) { float dd = length(vDmgP - h.xyz) + (dmgN(vDmgP * (2.2 / h.w)) - 0.5) * h.w * 0.6; if (dd < h.w) discard; dmgChar = max(dmgChar, 1.0 - smoothstep(h.w, h.w * 1.7, dd)); }
    }
  }`;
export function dmgAttr(n, runs) { const d = new Uint8Array(n); for (const [s, c, v] of runs || []) d.fill(v, s, s + c); return new THREE.BufferAttribute(d, 1); }
// shadow casting for the merged building meshes: the same holes and missing buildings in the shadow maps
let _bldDepth = null;
export function buildingDepthMaterial() {
  if (_bldDepth) return _bldDepth;
  const m = (_bldDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, DMG.U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + DMG_DEPTH_VERT_HEAD)
      .replace('#include <clipping_planes_vertex>', '#include <clipping_planes_vertex>\n' + DMG_DEPTH_VERT + DMG_VERT_KILL);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vDmgP;\n' + DMG_FRAG_HEAD)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DMG_FRAG);
  };
  m.customProgramCacheKey = () => 'bldgDepth1';
  return m;
}
const rectArr = () => { const a = []; for (let i = 0; i < NCELL; i++) { const w = WIN[i]; a.push(w ? new THREE.Vector4(...w.r) : new THREE.Vector4(2, 2, -1, -1)); } return a; };
const parArr = () => { const a = []; for (let i = 0; i < NCELL; i++) { const w = WIN[i]; a.push(new THREE.Vector4(w ? w.rec : 0, w ? w.room : 0, w ? w.kind : -1, i === C.METAL || i === C.SEAM || i === C.HANGAR_DOOR || i === C.LOUVRE ? 0.6 : i === C.FRAME ? 0.4 : 0)); } return a; };

// One material for every building. opts.interiors (default true): reveal + interior mapping; opts.ground: polygon
// offset for lots / paving laid on the terrain; opts.cellPx: atlas resolution; opts.glass: office glass (GLASS cells)
// is reflective coated glass tinted by the vertex colour (city towers, realCity.js).
export function buildingMaterial({ cellPx = 256, interiors = true, ground = false, glass = false } = {}) {
  const A = buildingAtlas(cellPx);
  const mat = new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.nrm, vertexColors: true, roughness: 1, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0, alphaTest: ground ? 0 : 0.5 });
  if (ground) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -6; }
  mat.normalScale.set(1, 1);
  const U = { tData: { value: A.data }, tFac: { value: FAC_TEX }, uRect: { value: rectArr() }, uCP: { value: parArr() } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U, BLD_U, DMG.U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 atl; varying vec4 vAtl; varying vec3 vWP; ' + DMG_VERT_HEAD)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvAtl = atl; vWP = (modelMatrix * vec4(position, 1.0)).xyz; ' + DMG_VERT)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + DMG_VERT_KILL);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D tData; uniform highp sampler2D tFac; uniform vec4 uRect[${NCELL}]; uniform vec4 uCP[${NCELL}]; uniform float uDay;
      varying vec4 vAtl; varying vec3 vWP; ${DMG_FRAG_HEAD}
      #define vDmgP vWP
      float bh1(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float vn3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); vec2 o = vec2(1.0, 0.0);
        float a = mix(mix(bh1(i.xy + i.z * 7.1), bh1(i.xy + o.xy + i.z * 7.1), f.x), mix(bh1(i.xy + o.yx + i.z * 7.1), bh1(i.xy + o.xx + i.z * 7.1), f.x), f.y);
        float b = mix(mix(bh1(i.xy + (i.z + 1.0) * 7.1), bh1(i.xy + o.xy + (i.z + 1.0) * 7.1), f.x), mix(bh1(i.xy + o.yx + (i.z + 1.0) * 7.1), bh1(i.xy + o.xx + (i.z + 1.0) * 7.1), f.x), f.y);
        return mix(a, b, f.z); }
      vec3 roomPal(float h) { return h < 0.25 ? vec3(0.86, 0.82, 0.74) : h < 0.45 ? vec3(0.92, 0.9, 0.86) : h < 0.6 ? vec3(0.72, 0.78, 0.8) : h < 0.75 ? vec3(0.8, 0.84, 0.72) : h < 0.88 ? vec3(0.88, 0.76, 0.7) : vec3(0.6, 0.64, 0.7); }
      vec3 fabric(float h) { return h < 0.3 ? vec3(0.9, 0.88, 0.8) : h < 0.5 ? vec3(0.62, 0.18, 0.16) : h < 0.65 ? vec3(0.2, 0.3, 0.5) : h < 0.8 ? vec3(0.85, 0.75, 0.5) : vec3(0.35, 0.45, 0.3); }
      vec3 bWinRad = vec3(0.0); float bGlass = 0.0; vec3 bJambN = vec3(0.0); float bJamb = 0.0;
      // shopfront paint (linear): black, bottle green, oxblood, navy, cream, slate, teal, red
      vec3 shopPal(float h) { return h < 0.2 ? vec3(0.03) : h < 0.34 ? vec3(0.03, 0.09, 0.05) : h < 0.46 ? vec3(0.2, 0.02, 0.025) : h < 0.58 ? vec3(0.02, 0.04, 0.12)
        : h < 0.7 ? vec3(0.75, 0.68, 0.52) : h < 0.82 ? vec3(0.12, 0.13, 0.14) : h < 0.91 ? vec3(0.02, 0.14, 0.13) : vec3(0.45, 0.04, 0.03); }
      `)
      .replace('#include <map_fragment>', `
        ${DMG_FRAG}
        float ci = floor(vAtl.x + 0.5), ly = vAtl.z / ${LYS}.0 - ${LY0}.0;
        // ---- facade programs (FAC_TEX): which cell this fragment of the wall shows, and where in it
        vec2 muv = vMapUv; vec3 bTint = vColor;
        vec2 dUx = dFdx(vMapUv), dUy = dFdy(vMapUv), dLx = vec2(dUx.x, dFdx(ly)), dLy = vec2(dUy.x, dFdy(ly)); // (derivatives out here: the branches below only pick)
        float fBand = -1.0, fTop = -1.0, fShade = 1.0, fCorn = 0.0, fAwn = 0.0; vec3 awnC = vec3(0.0);
        if (ci > ${NCELL - 0.5}) {
          int pid = int(ci);
          vec4 f0 = floor(texelFetch(tFac, ivec2(0, pid), 0) * 255.0 + 0.5), f1 = floor(texelFetch(tFac, ivec2(1, pid), 0) * 255.0 + 0.5), f2 = texelFetch(tFac, ivec2(2, pid), 0), f3 = texelFetch(tFac, ivec2(3, pid), 0);
          float gH = f1.x / 20.0, bH = f1.y / 80.0, b0 = floor(vMapUv.x); int fl = int(f1.w + 0.5);
          vec3 shopC = shopPal(bh1(vec2(vAtl.y * 0.37 + ci, floor((b0 + 1.0) / 3.0))));
          ci = f0.x;
          bool door0 = b0 == 0.0 && f0.z < 254.5, door2 = f1.z > 0.5 && f0.w < 254.5 && mod(b0, f1.z) < 0.5;
          if ((fl & 32) != 0 && door0 && vMapUv.y < 1.0) ci = f0.z; // (a door from the ground up through the first floor, over any plinth)
          else if (ly < gH && gH > 0.0) { // the ground floor (gH 0: none; the wall below the floor too then)
            float gs = (fl & 1) != 0 ? 1.0 / 3.0 : 1.0 / gH;
            muv = vec2(vMapUv.x, max(ly, 0.0) * gs); dUx = dLx * vec2(1.0, gs); dUy = dLy * vec2(1.0, gs);
            ci = f0.y;
            if (door0) ci = f0.z; else if (door2) ci = f0.w;
            if ((fl & 2) != 0) { // a shop: its colour; some have a striped awning over the window (over the transom)
              bTint = shopC; float sk = floor((b0 + 1.0) / 3.0);
              if (bh1(vec2(sk + 0.5, vAtl.y * 1.37 + 11.0)) < 0.45) { fAwn = 1.0; awnC = shopPal(bh1(vec2(sk, vAtl.y + 3.1))); }
            } else if ((fl & 4) != 0) bTint = f3.rgb;
            if (bH > 0.0) fShade = 1.0 - 0.4 * smoothstep(gH - 0.35, gH, ly); // in the band's shadow
          }
          if (bH > 0.0 && ly >= gH && ly < gH + bH) { fBand = (ly - gH) / bH; ci = floor(f2.w * 255.0 + 0.5); bTint = (fl & 8) != 0 ? f2.rgb : vColor; }
          float tv = vMapUv.y - vAtl.w; // the top: floors past the eave
          if (vAtl.w > 0.5 && tv > -0.12) {
            if (tv < 0.0) { if ((fl & 16) != 0) fShade *= 1.0 - 0.45 * smoothstep(-0.12, 0.0, tv); }
            else { ci = floor(f3.w * 255.0 + 0.5); fTop = tv; fCorn = float((fl & 16) != 0); if ((fl & 8) != 0) bTint = f2.rgb; }
          }
        }
        int ii = int(ci);
        vec2 cxy = vec2(mod(ci, ${COLS}.0), floor(ci / ${COLS}.0 + 0.01));
        vec2 fu = fract(muv), bay = floor(muv);
        const float CCF = ${(1 - 2 * PAD).toFixed(5)}, PADF = ${PAD.toFixed(5)};
        vec2 gdx = dUx * vec2(CCF / ${COLS}.0, CCF / ${ROWS}.0), gdy = dUy * vec2(CCF / ${COLS}.0, CCF / ${ROWS}.0);
        { // never sample coarser than the gutter can protect (the cell's own content stays >= 16 texels across)
          vec2 ts = vec2(textureSize(map, 0)); float gm = max(length(gdx * ts), length(gdy * ts)), lim = ts.x / ${COLS}.0 / 16.0;
          if (gm > lim) { gdx *= lim / gm; gdy *= lim / gm; } }
        vec4 rc = uRect[ii], cp = uCP[ii];
        vec2 suv = fu; float inWin = 0.0; vec3 rdT = vec3(0.0, 0.0, -1.0);
        vec3 Ng = normalize(vNormal);
        mat3 tfr = getTangentFrame(-vViewPosition, Ng, vMapUv);
        vec3 Tt = normalize(tfr[0]), Bt = normalize(tfr[1]);
        #ifdef BLD_INTERIOR
        if (cp.z >= 0.0 && fu.x > rc.x && fu.x < rc.z && fu.y > rc.y && fu.y < rc.w) {
          vec3 rd = -normalize(vViewPosition);
          rdT = vec3(dot(rd, Tt), dot(rd, Bt), min(dot(rd, Ng), -0.02));
          float tg = cp.x / -rdT.z; vec2 q = fu + rdT.xy * tg;
          float tsx = 1e9, tsy = 1e9;
          if (q.x < rc.x) tsx = (rc.x - fu.x) / rdT.x; else if (q.x > rc.z) tsx = (rc.z - fu.x) / rdT.x;
          if (q.y < rc.y) tsy = (rc.y - fu.y) / rdT.y; else if (q.y > rc.w) tsy = (rc.w - fu.y) / rdT.y;
          float ts = min(tsx, tsy);
          if (ts < tg) { bJamb = 1.0; bJambN = tsx < tsy ? (q.x < rc.x ? Tt : -Tt) : (q.y < rc.y ? Bt : -Bt); suv = vec2(0.03, clamp(fu.y, 0.05, 0.95)); bJamb = 1.0 - 0.3 * (ts / tg); }
          else { suv = q; inWin = 1.0; }
        }
        #endif
        vec2 fuc = clamp(suv, 0.0, 1.0) * CCF + PADF;
        vec2 auv = vec2((cxy.x + fuc.x) / ${COLS}.0, 1.0 - (cxy.y + 1.0 - fuc.y) / ${ROWS}.0);
        vec4 bTex = textureGrad(map, auv, gdx, gdy);
        vec4 bDat = textureGrad(tData, auv, gdx, gdy);
        float winM = bDat.r * (1.0 - step(0.5, bJamb));
        float seed = vAtl.y;
        diffuseColor.rgb *= bTex.rgb; diffuseColor.a *= bTex.a;
        // per building variation and weathering
        float wn = vn3(vWP * 0.35) * 0.6 + vn3(vWP * 1.7) * 0.4;
        `)
      .replace('#include <color_fragment>', `
        diffuseColor.rgb *= mix(vec3(1.0), bTint, bDat.g);
        // mouldings: a string course over the ground floor, a cornice along the top (its brackets and dentils), the
        // shadows they cast on the wall below (their profile shades through the normal, below)
        diffuseColor.rgb *= fShade;
        float awnB = 0.0; // the awning: canvas stripes over the transom (rows 24..44 of a shop cell), its shadow on the window
        if (fAwn > 0.5) { if (fu.y > 0.656 && fu.y < 0.82) { awnB = 1.0; winM = 0.0; diffuseColor.rgb = mix(awnC, vec3(0.8, 0.78, 0.72), step(0.5, fract(muv.x * 7.0))) * (0.85 + 0.15 * smoothstep(0.656, 0.7, fu.y)); } else if (fu.y > 0.5 && fu.y <= 0.656) diffuseColor.rgb *= 0.55 + 0.45 * smoothstep(0.5, 0.656, 0.5 + 0.656 - fu.y); }
        if (fTop >= 0.0 && fCorn > 0.5) {
          if (fTop < 0.06) diffuseColor.rgb *= 0.72 + 0.28 * step(0.5, fract(vMapUv.x * 12.0)); // dentils
          else if (fTop < 0.2) diffuseColor.rgb *= 1.0 - 0.35 * step(fract(vMapUv.x * 4.0), 0.14); // brackets' shadowed sides
          else if (fTop < 0.23) diffuseColor.rgb *= 0.55; // under the corona
        }
        vec3 wN = normalize((vec4(Ng, 0.0) * viewMatrix).xyz);
        float wall = 1.0 - smoothstep(0.35, 0.7, abs(wN.y));
        float ground = smoothstep(0.85, 0.95, wN.y) * step(ly, 0.6);
        diffuseColor.rgb *= 0.92 + 0.16 * bh1(vec2(seed, 3.7)) - 0.08 * wn * (1.0 - winM);
        // splash dirt at the foot of walls, rain streaks below roof lines, moss + soot on roofs
        diffuseColor.rgb *= 1.0 - wall * (1.0 - smoothstep(0.0, 0.8, ly)) * 0.35 * (1.0 - winM);
        diffuseColor.rgb *= 1.0 - wall * 0.12 * smoothstep(0.55, 0.9, vn3(vec3(vWP.x * 3.0 + vWP.z * 3.0, vWP.y * 0.25, seed))) * (1.0 - winM);
        float roof = smoothstep(0.3, 0.6, wN.y) * (1.0 - ground) * step(0.6, ly);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.78, 0.6), roof * smoothstep(0.45, 0.8, vn3(vWP * 0.6 + seed)) * 0.7);
        if (bJamb > 0.0) diffuseColor.rgb *= bJamb;
        diffuseColor.rgb *= 1.0 - 0.82 * dmgChar; // soot round holes and broken edges
      `)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(bDat.b, 0.04, winM);
        roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor + 0.15), roof * wn);`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cp.w * (1.0 - winM);')
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = textureGrad(normalMap, auv, gdx, gdy).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize(mat3(Tt, Bt, normal) * mapN);
        if (bJamb > 0.0) normal = normalize(bJambN + Ng * 0.8);
        if (winM > 0.5) normal = Ng;
        if (awnB > 0.5) normal = normalize(Ng - Bt * 0.5); // (sloping out and down)
        if (fBand >= 0.0) normal = normalize(normal + Bt * (fBand < 0.22 ? -1.3 : fBand > 0.78 ? 1.1 : 0.0)); // bed mould faces down, the wash up
        if (fTop >= 0.0 && fCorn > 0.5) normal = normalize(normal + Bt * (fTop < 0.06 ? -0.8 : fTop < 0.2 ? 0.0 : fTop < 0.23 ? -1.4 : 0.9));`)
      .replace('#include <emissivemap_fragment>', `
        // ---- behind the glass ----
        float nightK = emissive.r * (1.0 - dmgDark); // a damaged building's power is out
        vec2 wid = bay + vec2(seed * 0.618, ci * 0.37);
        float wh = bh1(wid), wh2 = bh1(wid + 17.3), wh3 = bh1(wid + 41.9);
        vec3 rad = vec3(0.0);
        if (winM > 0.01) {
          if (cp.z > 1.5) { // stained glass / neon: glow with the painted colour
            rad = bTex.rgb * (cp.z > 2.5 ? 3.0 : 1.2) * nightK + (cp.z > 2.5 ? bTex.rgb * 0.4 * uDay : vec3(0.0));
          } else {
            float shop = step(0.5, cp.z) * step(cp.z, 1.5), office = step(3.5, cp.z);
            vec3 ro = vec3(suv, -cp.x);
            float x0 = -0.15 - wh2 * 0.5, x1 = 1.15 + wh3 * 0.5, back = -cp.x - cp.y * (0.8 + 0.4 * wh);
            vec3 rd3 = rdT;
            #ifndef BLD_INTERIOR
            rd3 = vec3(0.0, 0.0, -1.0);
            #endif
            float tx = ((rd3.x > 0.0 ? x1 : x0) - ro.x) / (abs(rd3.x) > 1e-4 ? rd3.x : 1e-4);
            float ty = ((rd3.y > 0.0 ? 1.0 : 0.0) - ro.y) / (abs(rd3.y) > 1e-4 ? rd3.y : 1e-4);
            float tz = (back - ro.z) / rd3.z;
            float t = min(min(tx, ty), tz);
            vec3 hp = ro + rd3 * t;
            vec3 wallC = roomPal(wh2);
            vec3 alb; float ao;
            if (t == tz) { // back wall: furniture band, a picture
              alb = wallC; float fx = (hp.x - x0) / (x1 - x0);
              if (hp.y < 0.32 + 0.12 * wh3 && abs(fx - 0.3 - 0.4 * wh) < 0.25) alb = fabric(wh3) * 0.7;
              if (hp.y > 0.45 && hp.y < 0.68 && abs(fx - 0.6 + 0.2 * wh2) < 0.08) alb = vec3(0.3, 0.35, 0.4) + 0.4 * fabric(wh);
              ao = smoothstep(0.0, 0.12, min(min(hp.y, 1.0 - hp.y), min(fx, 1.0 - fx)));
            } else if (t == ty) {
              alb = rd3.y > 0.0 ? vec3(0.93) : (wh < 0.5 ? vec3(0.42, 0.3, 0.2) : vec3(0.5, 0.48, 0.45));
              ao = smoothstep(0.0, 0.25, (hp.z - back));
            } else { alb = wallC * 0.85; ao = smoothstep(0.0, 0.2, min(hp.y, 1.0 - hp.y)); }
            if (office > 0.5) { alb = mix(alb, vec3(0.75, 0.78, 0.8), 0.6); }
            ao = 0.55 + 0.45 * ao;
            float depth = clamp((-hp.z - cp.x) / max(cp.y, 0.1), 0.0, 1.5);
            // daylight falls off into the room; at night a ceiling lamp lights it (if anyone is home)
            float lit = step(shop > 0.5 ? 0.15 : office > 0.5 ? 0.6 : 0.45, wh3);
            vec3 lampC = wh < 0.7 ? vec3(1.0, 0.72, 0.42) : wh < 0.9 ? vec3(1.0, 0.88, 0.74) : vec3(0.62, 0.74, 1.0);
            if (shop > 0.5 || office > 0.5) lampC = vec3(1.0, 0.92, 0.8);
            vec3 lp = vec3(0.5, 0.95, -cp.x - cp.y * 0.5); float ld = length(hp - lp);
            float lamp = 0.25 + 0.9 / (1.0 + 7.0 * ld * ld);
            vec3 day = alb * ao * uDay * (0.4 - 0.1 * shop) * exp(-depth * 1.2);
            vec3 night = alb * ao * lampC * lamp * lit * nightK * (0.6 + 0.4 * shop);
            rad = day + night;
            // curtains / blinds on the glass plane
            float cw = rc.z - rc.x, chh = rc.w - rc.y, cu = (suv.x - rc.x) / max(cw, 1e-3), cv = (suv.y - rc.y) / max(chh, 1e-3);
            float sel = bh1(wid + 5.1), cov = 0.0; vec3 fc = fabric(bh1(wid + 9.3));
            if (shop < 0.5 && office < 0.5) {
              if (sel < 0.45) { float k1 = 0.12 + 0.3 * wh, k2 = 0.12 + 0.3 * wh2; cov = step(cu, k1) + step(1.0 - k2, cu); fc *= 0.8 + 0.2 * sin(suv.x * 260.0); }
              else if (sel < 0.65) { cov = step(1.0 - (0.2 + 0.7 * wh3), cv); fc = vec3(0.86, 0.84, 0.8) * (0.85 + 0.15 * step(0.5, fract(suv.y * 70.0))); }
            } else if (office > 0.5) { cov = step(1.0 - 0.6 * wh3 * step(0.5, sel), cv); fc = vec3(0.8, 0.82, 0.84) * (0.85 + 0.15 * step(0.5, fract(suv.y * 50.0))); }
            cov = clamp(cov, 0.0, 1.0);
            rad = mix(rad, fc * (uDay * 0.18 + lampC * lit * nightK * 0.45), cov);
            diffuseColor.rgb = mix(vec3(0.015), fc * 0.25, cov);
          }
        }
        #ifdef BLD_GLASS
        if (winM > 0.5 && cp.z > 3.5) { // curtain walls (city towers): coated glass mirrors the sky, tinted by the vertex colour
          // (at night: the lit rooms show, not the sky, and no moon glare across every pane)
          diffuseColor.rgb = vColor * 0.4; metalnessFactor = mix(0.1, 0.6, uDay); roughnessFactor = mix(0.45, 0.08, uDay);
          rad *= vec3(1.0, 0.85, 0.62) * 0.3 * step(0.55, bh1(wid + 3.3)); // big panes: dimmer, warm, and fewer of them lit (dark floors and bays)
        } else if (cp.z > 3.5) roughnessFactor = max(roughnessFactor, 0.55); // the mullions and spandrels: satin, not mirrors
        #endif
        totalEmissiveRadiance = rad * winM;`);
  };
  mat.defines = { ...(mat.defines || {}), ...(interiors ? { BLD_INTERIOR: '' } : {}), ...(glass ? { BLD_GLASS: '' } : {}) };
  mat.customProgramCacheKey = () => 'bldg5' + (interiors ? 'i' : '') + (ground ? 'g' : '') + (glass ? 'q' : '');
  return mat;
}

// ---------------- geometry builder ----------------
const _c = new THREE.Color();
export const LY0 = 4, LYS = 4; // atl.z holds the height above a building's floor, (h + LY0) * LYS: from LY0 m below it (walls go on down into the ground) to 60 m up
const SILL_TOP = 10.5; // m: walls up to this high get window sills (detail)
export class Builder {
  constructor() { this.cap = 0; this.ni = 0; this.idx = new Uint32Array(1024); this.n = 0; this._grow(256); this.setFrame(0, 0, 0, 0); this.seed = 0; this.det = null; this.fine = 1; this.lyOff = 0; } // (lyOff: atl.z's datum above the frame's base)
  // typed, growable vertex storage (a big town is ~1M vertices: plain JS arrays would cost hundreds of MB)
  _grow(need) {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2), cp = (A, T, k) => { const b = new T(cap * k); if (A) b.set(A.subarray(0, this.n * k)); return b; };
    this.pos = cp(this.pos, Float32Array, 3); this.nor = cp(this.nor, Int8Array, 3); this.uv = cp(this.uv, Float32Array, 2); this.col = cp(this.col, Uint8Array, 3); this.atl = cp(this.atl, Uint8Array, 4); this.cap = cap;
  }
  setFrame(x, y, z, yaw) { this.fx = x; this.fy = y; this.fz = z; this.cs = Math.cos(yaw); this.sn = Math.sin(yaw); return this; }
  get yaw() { return Math.atan2(this.sn, this.cs); }
  _v(p, nx, ny, nz, u, v, cell, cr, cg, cb) {
    const { cs, sn } = this, i = this.vn++;
    this.pos[i * 3] = this.fx + p[0] * cs + p[2] * sn; this.pos[i * 3 + 1] = this.fy + p[1]; this.pos[i * 3 + 2] = this.fz - p[0] * sn + p[2] * cs;
    this.nor[i * 3] = Math.round((nx * cs + nz * sn) * 127); this.nor[i * 3 + 1] = Math.round(ny * 127); this.nor[i * 3 + 2] = Math.round((-nx * sn + nz * cs) * 127);
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v; this.col[i * 3] = cr; this.col[i * 3 + 1] = cg; this.col[i * 3 + 2] = cb;
    this.atl[i * 4] = cell; this.atl[i * 4 + 1] = this.seed; this.atl[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((p[1] - this.lyOff + LY0) * LYS))); // (height above the frame's base: LY0 below it to 60 m above, 1/4 m steps)
  }
  // quad p0..p3 counter-clockwise seen from the front (p0 bottom-left), uv given per corner
  quad(p0, p1, p2, p3, uvs, cell, col) { this._poly(p2 === p3 ? [p0, p1, p2] : [p0, p1, p2, p3], uvs, cell, col); }
  tri(p0, p1, p2, uvs, cell, col) { this._poly([p0, p1, p2], uvs, cell, col); }
  _poly(P, uvs, cell, col) {
    const p0 = P[0], p1 = P[1], p3 = P[P.length - 1];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    _c.set(col); const cr = Math.round(Math.min(1, _c.r) * 255), cg = Math.round(Math.min(1, _c.g) * 255), cb = Math.round(Math.min(1, _c.b) * 255);
    const o = this.n; this._grow(o + 4); this.vn = o;
    if (this.ni + 6 > this.idx.length) { const b = new Uint32Array(this.idx.length * 2); b.set(this.idx); this.idx = b; }
    for (let i = 0; i < P.length; i++) this._v(P[i], nx, ny, nz, uvs[i * 2], uvs[i * 2 + 1], cell, cr, cg, cb);
    const I = this.idx, k = this.ni;
    if (P.length === 3) { I[k] = o; I[k + 1] = o + 1; I[k + 2] = o + 2; this.ni += 3; this.n += 3; } else { I[k] = o; I[k + 1] = o + 1; I[k + 2] = o + 2; I[k + 3] = o; I[k + 4] = o + 2; I[k + 5] = o + 3; this.ni += 6; this.n += 4; }
  }
  // a flat polygon of many triangles sharing its vertices (one normal: the plane's; triangles
  // counter-clockwise seen from the front): pts [[x, y, z]], uv [[u, v]], tris [[a, b, c]] indices into pts
  fan(pts, uv, tris, cell, col) {
    if (!tris.length) return;
    let nx = 0, ny = 0, nz = 0; // (the triangles' area-weighted normal: a sliver's alone could be zero, NaN in the shader)
    for (const [i0, i1, i2] of tris) {
      const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2], ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      nx += ay * bz - az * by; ny += az * bx - ax * bz; nz += ax * by - ay * bx;
    }
    const l = Math.hypot(nx, ny, nz); if (l < 1e-9) return; nx /= l; ny /= l; nz /= l;
    _c.set(col); const cr = Math.round(Math.min(1, _c.r) * 255), cg = Math.round(Math.min(1, _c.g) * 255), cb = Math.round(Math.min(1, _c.b) * 255);
    const o = this.n; this._grow(o + pts.length); this.vn = o;
    while (this.ni + tris.length * 3 > this.idx.length) { const b = new Uint32Array(this.idx.length * 2); b.set(this.idx); this.idx = b; }
    for (let i = 0; i < pts.length; i++) this._v(pts[i], nx, ny, nz, uv[i][0], uv[i][1], cell, cr, cg, cb);
    for (const [a, b, c] of tris) { this.idx[this.ni++] = o + a; this.idx[this.ni++] = o + b; this.idx[this.ni++] = o + c; }
    this.n += pts.length;
  }
  // both faces of a thin panel (railings, fences, signs)
  panel(p0, p1, p2, p3, cell, col, s = 3, uvs = null) {
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / s, H = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]) / s, u = uvs || [0, 0, L, 0, L, H, 0, H];
    this.quad(p0, p1, p2, p3, u, cell, col); this.quad(p1, p0, p3, p2, [u[2], u[3], u[0], u[1], u[6], u[7], u[4], u[5]], cell, col);
  }
  // vertical wall from (ax,az) to (bx,bz) seen from outside; u = whole bays, v = floors. Window cells get sills (detail:
  // the det builder at fine > 2, on house-sized walls only, up to SILL_TOP. Not used yet: in a Swiss valley at High
  // they were +70% of the buildings' vertices, for a 14 cm ledge)
  // (yf: the floor datum, v = 0 there; u0: the first bay's number, a facade program's door goes in bay 0)
  wall(ax, az, bx, bz, y0, y1, cell, col, bay = 3, fl = 3, u0 = 0, yf = 0) {
    if (FAC_SPEC[cell]?.gH > 0 && y1 > 56 && y0 < 54) { this.wall(ax, az, bx, bz, y0, 55, cell, col, bay, fl, u0, yf); this.wall(ax, az, bx, bz, 55, y1, cell, col, bay, fl, u0, yf); return; } // (atl.z stops 60 m up: LY0)
    const L = Math.hypot(bx - ax, bz - az), nb = Math.max(1, Math.round(L / bay)), v0 = (y0 - yf) / fl, v1 = (y1 - yf) / fl;
    this.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [u0, v0, u0 + nb, v0, u0 + nb, v1, u0, v1], cell, col);
    const wr = WIN[cell], D = this.det;
    if (D && wr && wr.sill && wr.kind <= 1 && this.fine > 2 && L > 1 && y1 <= SILL_TOP) {
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux, bw = L / nb, sx = D.sillCol ?? 0xd8d4cc;
      D.setFrame(this.fx, this.fy, this.fz, this.yaw); D.seed = this.seed;
      for (let f = Math.ceil(v0 - wr.r[1] - 1e-3); (f + wr.r[3]) * fl + yf <= y1 + 0.05; f++) {
        const ys = (f + wr.r[1]) * fl + yf; if (ys < y0 - 0.05 || ys < 0.3) continue;
        for (let j = 0; j < nb; j++) {
          const s0 = (j + wr.r[0]) * bw - 0.1, s1 = (j + wr.r[2]) * bw + 0.1, cx = ax + ux * (s0 + s1) / 2, cz = az + uz * (s0 + s1) / 2;
          // one sloped quad from the wall out over the facade (seen from the street and from above alike)
          const h0 = (s1 - s0) / 2, ex = cx + nx * 0.14, ez = cz + nz * 0.14, y0s = ys - 0.07, y1s = ys + 0.03;
          D.plainQuad([ex - ux * h0, y0s, ez - uz * h0], [ex + ux * h0, y0s, ez + uz * h0], [cx + ux * h0, y1s, cz + uz * h0], [cx - ux * h0, y1s, cz - uz * h0], C.CONCRETE, sx);
        }
      }
    }
  }
  // oriented box: centre (cx,cz), along-axis (ux,uz) half length hu, half depth hn, from y0 to y1. sides: which of the
  // four sides to write (0 faces +n, 1 +u, 2 -n, 3 -u; n = (-uz, ux)), default all
  obox(cx, cz, ux, uz, hu, hn, y0, y1, cell, col, { top = true, s = 3, sides = null } = {}) {
    const nx = -uz, nz = ux, c = (a, b) => [cx + ux * a + nx * b, 0, cz + uz * a + nz * b];
    const P = [c(-hu, hn), c(hu, hn), c(hu, -hn), c(-hu, -hn)];
    for (let k = 0; k < 4; k++) { if (sides && !sides.includes(k)) continue; const p = P[k], q = P[(k + 1) % 4]; this.plainQuad([p[0], y0, p[2]], [q[0], y0, q[2]], [q[0], y1, q[2]], [p[0], y1, p[2]], cell, col, s); }
    if (top) this.plainQuad([P[0][0], y1, P[0][2]], [P[1][0], y1, P[1][2]], [P[2][0], y1, P[2][2]], [P[3][0], y1, P[3][2]], cell, col, s); // (counter-clockwise from above: faces up)
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
  // gable roof over a w x d footprint, ridge along z. Gable ends filled with wallCell. The roof has thickness (fascia
  // and barge boards), a soffit underneath, a ridge cap; gutters + downpipes go to the detail builder.
  gable(w, d, y, rise, over, cell, col, wallCell, wallCol, { under = null, ends = true, overZ = over, overN = over, trim = C.TRIM, trimCol = 0xf0eee8, gutter = true, th = 0.22 } = {}) {
    // (overN: the eave overhang on the -x side, when it differs: a veranda under the roof carried on down)
    const hw = w / 2, ex = hw + over, exN = hw + overN, ez = d / 2 + overZ, ye = y - over * rise / hw, yeN = y - overN * rise / hw, yr = y + rise, sl = Math.hypot(ex, yr - ye) / 3, slN = Math.hypot(exN, yr - yeN) / 3, L = (2 * ez) / 3;
    this.quad([ex, ye, ez], [ex, ye, -ez], [0, yr, -ez], [0, yr, ez], [0, 0, L, 0, L, sl, 0, sl], cell, col);
    this.quad([-exN, yeN, -ez], [-exN, yeN, ez], [0, yr, ez], [0, yr, -ez], [0, 0, L, 0, L, slN, 0, slN], cell, col);
    if (ends) {
      const z = d / 2, v = rise / 3, u = w / 3;
      this.tri([-hw, y, z], [hw, y, z], [0, yr, z], [0, y / 3, u, y / 3, u / 2, y / 3 + v], wallCell, wallCol);
      this.tri([hw, y, -z], [-hw, y, -z], [0, yr, -z], [0, y / 3, u, y / 3, u / 2, y / 3 + v], wallCell, wallCol);
    }
    if (over > 0.05 || overZ > 0.05) {
      const t = th, yb = ye - t, ybN = yeN - t, yrb = yr - t;
      // soffit (underside), slightly below the roof plane = visible thickness
      const sc = under ?? trim, scol = under != null ? 0xffffff : trimCol;
      this.quad([0, yrb, ez], [0, yrb, -ez], [ex, yb, -ez], [ex, yb, ez], [0, 0, L, 0, L, sl, 0, sl], sc, scol);
      this.quad([0, yrb, -ez], [0, yrb, ez], [-exN, ybN, ez], [-exN, ybN, -ez], [0, 0, L, 0, L, slN, 0, slN], sc, scol);
      // fascia along the eaves
      this.plainQuad([ex, yb, ez], [ex, yb, -ez], [ex, ye, -ez], [ex, ye, ez], trim, trimCol);
      this.plainQuad([-exN, ybN, -ez], [-exN, ybN, ez], [-exN, yeN, ez], [-exN, yeN, -ez], trim, trimCol);
      // barge boards along the rakes
      for (const z of [ez, -ez]) {
        const f = z > 0 ? 1 : -1;
        if (f > 0) { this.plainQuad([0, yrb, z], [ex, yb, z], [ex, ye, z], [0, yr, z], trim, trimCol); this.plainQuad([-exN, ybN, z], [0, yrb, z], [0, yr, z], [-exN, yeN, z], trim, trimCol); }
        else { this.plainQuad([ex, yb, z], [0, yrb, z], [0, yr, z], [ex, ye, z], trim, trimCol); this.plainQuad([0, yrb, z], [-exN, ybN, z], [-exN, yeN, z], [0, yr, z], trim, trimCol); }
      }
    }
    // ridge cap
    const rcw = 0.22, rcy = rcw * rise / ex;
    this.quad([rcw, yr - rcy + 0.02, ez], [rcw, yr - rcy + 0.02, -ez], [0, yr + 0.12, -ez], [0, yr + 0.12, ez], [0, 0, L, 0, L, 0.1, 0, 0.1], cell, _c.set(col).multiplyScalar(0.8).getHex());
    this.quad([-rcw, yr - rcy + 0.02, -ez], [-rcw, yr - rcy + 0.02, ez], [0, yr + 0.12, ez], [0, yr + 0.12, -ez], [0, 0, L, 0, L, 0.1, 0, 0.1], cell, _c.set(col).multiplyScalar(0.8).getHex());
    if (gutter && this.det && this.fine > 0 && over > 0.15) { if (overN === over) this._gutters([[ex, -ez, ex, ez], [-exN, ez, -exN, -ez]], ye - 0.12, y); else { this._gutters([[ex, -ez, ex, ez]], ye - 0.12, y); this._gutters([[-exN, ez, -exN, -ez]], yeN - 0.12, y); } }
  }
  // gutters along local edges [[x0,z0,x1,z1]...] at height gy, downpipes at the ends down to the ground
  _gutters(edges, gy, wallTop) {
    const D = this.det; D.setFrame(this.fx, this.fy, this.fz, this.yaw); D.seed = this.seed;
    for (const [x0, z0, x1, z1] of edges) {
      const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, nx = -uz, nz = ux;
      // (n points in under the roof: only the faces seen from outside are written: the gutter's outer face and the
      // downpipe's, 8 vertices an eave)
      D.obox((x0 + x1) / 2 + nx * 0.06, (z0 + z1) / 2 + nz * 0.06, ux, uz, L / 2, 0.08, gy - 0.07, gy + 0.07, C.METAL, 0x8a8a84, { top: false, sides: [2] });
      if (this.fine > 1) { const px = x1 - ux * 0.4 + nx * 0.02, pz = z1 - uz * 0.4 + nz * 0.02; D.obox(px - nx * 0.25, pz - nz * 0.25, ux, uz, 0.05, 0.05, -0.3, gy, C.METAL, 0x7a7a74, { top: false, sides: [2] }); }
    }
  }
  // hip roof (or pyramid when square), with fascia, soffit, hip caps and gutters on all four sides
  hip(w, d, y, rise, over, cell, col, { trim = C.TRIM, trimCol = 0xf0eee8, gutter = true, th = 0.2 } = {}) {
    const ex = w / 2 + over, ez = d / 2 + over, ye = y - over * rise / (w / 2), yr = y + rise, rz = Math.max(0, ez - ex), slx = Math.hypot(ex, yr - ye) / 3, slz = Math.hypot(ez - rz, yr - ye) / 3;
    this.quad([ex, ye, ez], [ex, ye, -ez], [0, yr, -rz], [0, yr, rz], [0, 0, 2 * ez / 3, 0, (ez + rz) / 3, slx, (ez - rz) / 3, slx], cell, col);
    this.quad([-ex, ye, -ez], [-ex, ye, ez], [0, yr, rz], [0, yr, -rz], [0, 0, 2 * ez / 3, 0, (ez + rz) / 3, slx, (ez - rz) / 3, slx], cell, col);
    this.tri([-ex, ye, ez], [ex, ye, ez], [0, yr, rz], [0, 0, 2 * ex / 3, 0, ex / 3, slz], cell, col);
    this.tri([ex, ye, -ez], [-ex, ye, -ez], [0, yr, -rz], [0, 0, 2 * ex / 3, 0, ex / 3, slz], cell, col);
    if (over > 0.05) {
      const yb = ye - th;
      const c = [[ex, ez], [ex, -ez], [-ex, -ez], [-ex, ez]];
      for (let k = 0; k < 4; k++) { const p = c[k], q = c[(k + 1) % 4]; this.plainQuad([p[0], yb, p[1]], [q[0], yb, q[1]], [q[0], ye, q[1]], [p[0], ye, p[1]], trim, trimCol); }
      const ix = w / 2, iz = d / 2; // soffit ring: from the fascia in to the wall line
      const ci = [[ix, iz], [ix, -iz], [-ix, -iz], [-ix, iz]];
      for (let k = 0; k < 4; k++) { const p = c[k], q = c[(k + 1) % 4], pi = ci[k], qi = ci[(k + 1) % 4]; this.plainQuad([q[0], yb, q[1]], [p[0], yb, p[1]], [pi[0], y - 0.05, pi[1]], [qi[0], y - 0.05, qi[1]], trim, trimCol); }
      if (gutter && this.det && this.fine > 0 && over > 0.2) this._gutters([[ex, -ez, ex, ez], [-ex, ez, -ex, -ez], [ex, ez, -ex, ez], [-ex, -ez, ex, -ez]], ye - 0.12, y);
    }
  }
  // lean-to (shed) roof: high edge at -z, low edge at +z
  shedRoof(w, d, y, rise, over, cell, col, wallCell, wallCol) {
    const ex = w / 2 + over, ez = d / 2 + over, yl = y - over * rise / d, yh = y + rise + over * rise / d, sl = Math.hypot(2 * ez, yh - yl) / 3;
    this.quad([-ex, yl, ez], [ex, yl, ez], [ex, yh, -ez], [-ex, yh, -ez], [0, 0, 2 * ex / 3, 0, 2 * ex / 3, sl, 0, sl], cell, col);
    this.quad([ex, yl - 0.18, ez], [-ex, yl - 0.18, ez], [-ex, yh - 0.18, -ez], [ex, yh - 0.18, -ez], [0, 0, 1, 0, 1, 1, 0, 1], C.TRIM, 0xe8e6e0);
    this.plainQuad([-ex, yl - 0.18, ez], [ex, yl - 0.18, ez], [ex, yl, ez], [-ex, yl, ez], C.TRIM, 0xe8e6e0);
    const hd = d / 2, hw = w / 2;
    this.tri([hw, y, hd], [hw, y, -hd], [hw, y + rise, -hd], [0, 0, d / 3, 0, d / 3, rise / 3], wallCell, wallCol);
    this.tri([-hw, y, -hd], [-hw, y, hd], [-hw, y + rise, -hd], [0, 0, d / 3, 0, 0, rise / 3], wallCell, wallCol);
    this.plainQuad([hw, y, -hd], [-hw, y, -hd], [-hw, y + rise, -hd], [hw, y + rise, -hd], wallCell, wallCol);
  }
  // flat roof with a parapet (walls must already reach y + ph) and a coping
  flat(w, d, y, ph, cell, col, wallCell, wallCol) {
    const hw = w / 2, hd = d / 2, i = 0.3;
    this.plainQuad([-hw + i, y, hd - i], [hw - i, y, hd - i], [hw - i, y, -hd + i], [-hw + i, y, -hd + i], cell, col);
    if (ph > 0.05) {
      const a = [[-hw + i, hd - i], [hw - i, hd - i], [hw - i, -hd + i], [-hw + i, -hd + i]];
      for (let k = 0; k < 4; k++) { const p = a[k], q = a[(k + 1) % 4]; this.plainQuad([q[0], y, q[1]], [p[0], y, p[1]], [p[0], y + ph, p[1]], [q[0], y + ph, q[1]], wallCell, wallCol); }
      const o = [[-hw - 0.06, hd + 0.06], [hw + 0.06, hd + 0.06], [hw + 0.06, -hd - 0.06], [-hw - 0.06, -hd - 0.06]], cc = 0xe0ddd6, yc = y + ph + 0.08;
      for (let k = 0; k < 4; k++) { const p = o[k], q = o[(k + 1) % 4], pi = a[k], qi = a[(k + 1) % 4]; this.plainQuad([p[0], yc, p[1]], [q[0], yc, q[1]], [qi[0], yc, qi[1]], [pi[0], yc, pi[1]], C.CONCRETE, cc); this.plainQuad([p[0], y + ph, p[1]], [q[0], y + ph, q[1]], [q[0], yc, q[1]], [p[0], yc, p[1]], C.CONCRETE, cc); }
    }
  }
  // walls around a w x d footprint from y0 to y1; front (+z) can have its own cell and a door in the middle bay
  walls(w, d, y0, y1, cell, col, { front = cell, side = cell, back = side, door = null, fl = 3, doorAt = 0.5 } = {}) {
    const hw = w / 2, hd = d / 2;
    if (door != null) {
      const nb = Math.max(1, Math.round(w / 3)), bw = w / nb, k = Math.min(nb - 1, Math.floor(nb * doorAt)), xa = -hw + k * bw, xb = xa + bw, y2 = Math.min(y1, Math.max(y0 + fl, fl));
      if (k > 0) this.wall(-hw, hd, xa, hd, y0, y2, front, col, bw, fl);
      this.wall(xa, hd, xb, hd, y0, y2, door, col, bw, fl);
      if (k < nb - 1) this.wall(xb, hd, hw, hd, y0, y2, front, col, bw, fl);
      if (y1 > y2 + 0.01) this.wall(-hw, hd, hw, hd, y2, y1, front, col, 3, fl);
    } else this.wall(-hw, hd, hw, hd, y0, y1, front, col, 3, fl);
    this.wall(hw, hd, hw, -hd, y0, y1, side, col, 3, fl);
    this.wall(hw, -hd, -hw, -hd, y0, y1, back, col, 3, fl);
    this.wall(-hw, -hd, -hw, hd, y0, y1, side, col, 3, fl);
  }
  // a visible plinth / foundation band around the footprint
  plinth(w, d, h, cell = C.CONCRETE, col = 0xb8b4ac) { this.box(0, -0.6, 0, w + 0.12, h + 0.6, d + 0.12, cell, col, { top: false }); }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('atl', new THREE.BufferAttribute(this.atl.slice(0, n * 4), 4, false));
    g.setAttribute('dmg', dmgAttr(n, this.dmgW));
    const I = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? I.slice() : Uint16Array.from(I), 1));
    this.pos = this.nor = this.uv = this.col = this.atl = null; this.idx = new Uint32Array(0); this.cap = 0; // free the staging buffers
    g.computeBoundingSphere(); g.computeBoundingBox();
    this.geo = g; // (destruction.js finds a building's vertices through the builder that wrote them)
    return g;
  }
  get empty() { return this.n === 0; }
}
