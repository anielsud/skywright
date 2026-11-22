// Jet cockpit furniture: the fighter canopy's cockpit (partDetail.cockpitBuild 'ck_fighter', after the F-16 / Hawk /
// L-39) and the tandem canopy's two stations (supersonicParts.tandemCanopy, after the SR-71's pilot and RSO cockpits).
// Assembled from what the real ones have (museum photos on Wikimedia Commons):
//   - an ejection seat: padded back and pan, the head box (parachute) on top with its headrest pad, side plates, the
//     catapult rails behind, the survival-kit pan under the cushion (a fighter's), the yellow/black firing handles (a
//     face-curtain loop on the head box, the seat-pan handle between the knees);
//   - side consoles shaped to the tub, their tops covered in switch panels (knobs, toggles, legends, Dzus fasteners);
//     the side-stick on its raised mount and the forearm's armrest (fighter); the throttle quadrant is crew.js's;
//   - the instrument panel: MFDs in their bezels, the up-front control panel (keypad), standby gauges, caution lights,
//     side wings angled to the pilot with the landing-gear handle, the glare shield with its padded lip, the HUD's body
//     and combiner (fighter); the SR-71's black panel dense with round gauges, the triple display, its periscope; the
//     RSO's own panel with the big round viewsight;
//   - the mirrors on the canopy bow, a bulkhead and avionics deck behind the seat (fighter).
// The pictures (panels, screens, dials, legends) are one canvas atlas on one material, so all of it costs one draw call;
// the knobs and toggles that stand off them are small kit-material pieces in the near bag (hidden beyond a few dozen
// metres, and not built at all for traffic). Every seat, control and obstacle is declared for crew.js.
import * as THREE from 'three';
import { mergeVertices } from '../vendor/addons/BufferGeometryUtils.js';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';
import { V, mx, bar, pipe, ringLoft, seatGeo, Bag, shell, capHoles, boxObstacle, hoodObstacle, insideRows, fighterGlassR, FIGHTER_GLASS } from './partDetail.js';
import { LivePanel, Shape, color as liveColor } from './liveDisplays.js';
import { collimatedHud } from './liveHud.js';
import { fighterRadar, fighterMap, cautionLamps, gearLamps, sr71Triple } from './liveScreens.js';

const cache = new Map(), cached = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
// cockpit paint (matt, a little sheen)
// Cockpit paint (consoles, panel bodies, seat frames, cushions) is a solid swatch of the atlas: the furniture shares the
// panels' material, one draw call. jetPaint(c) names a swatch; a bag wrapped by paintBag puts geometry added with it on
// the atlas at that swatch.
// Each swatch has a surface (cls): 0 painted metal / plastic (powder-coat grain), 0.5 the anti-glare coaming (a coarse
// matt texture), 1 fabric (cushions, webbing: a weave, quilting seams and stitching). The atlas material's shader
// (panelMat) draws the grain, roughness and bump from the part-space position, so nothing needs UVs.
// (0x5f6367: the F-16's tub, consoles and panel, FS 36231 dark gull grey, checked against museum photos; 0x55585c the
// same in the sidewall linings; 0x85898e it worn bright)
const SWATCHES = [0x2c3035, 0x222428, 0x3a3e44, 0x596067, 0x141518, 0x2a2c30, 0x55594c, 0x24262a, 0x4f5440, 0x16171a, 0x5d6168, 0x2f6b34, 0xd8b21c, 0x5f6367, 0x55585c, 0x85898e];
export const jetPaint = (c, cls = 0) => { const i = SWATCHES.indexOf(c); if (i < 0) throw new Error('jetPaint: no swatch ' + c.toString(16)); return { swatch: i, cls }; };
// Baked ambient occlusion: while a cockpit builds, AO(x, y, z) says how shut in a point is (0 open .. 1), from where it
// is in the tub (deep down, under the glare shield); it goes on the atlas material's geometry as uv1.x (uv1.y: cls).
let AO = null;
function bake(geo, cls) {
  const P = geo.attributes.position, n = P.count, a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = AO ? AO(P.getX(i), P.getY(i), P.getZ(i)) : 0; a[i * 2 + 1] = cls; }
  geo.setAttribute('uv1', new THREE.Float32BufferAttribute(a, 2));
}
export function paintBag(bag) {
  return { add(geo, mat, m) {
    if (mat === panelMat()) { if (m) geo.applyMatrix4(m); bake(geo, 0); return bag.add(geo, mat); }
    if (!mat?.swatch && mat?.swatch !== 0) return bag.add(geo, mat, m);
    if (m) geo.applyMatrix4(m);
    const n = geo.attributes.position.count, u = (768 + 16 * mat.swatch + 8) / S, v = 1 - 248 / SH, a = new Float32Array(n * 2); for (let i = 0; i < n; i++) { a[i * 2] = u; a[i * 2 + 1] = v; }
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(a, 2)); bake(geo, mat.cls || 0); return bag.add(geo, panelMat());
  } };
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- the atlas ----------
const S = 1024, SH = 1152; // (wide x tall: the bottom 128 rows hold the F-16 panel's grey side wings)
const CELLS = {
  mfdA: [0, 0, 256, 256], mfdB: [256, 0, 256, 256], ufc: [768, 0, 256, 160], warn: [768, 160, 256, 80], // (swatches in 768..1024 x 240..256)
  sr71: [0, 256, 512, 448], rso: [512, 256, 512, 384], gauges: [512, 640, 256, 192], wingL: [768, 640, 256, 192],
  ped: [512, 0, 96, 256], pedT: [512, 0, 96, 158], aux: [608, 0, 160, 112], aux2: [608, 112, 160, 112], aoa: [608, 224, 64, 32], nws: [672, 224, 64, 32], // (the F-16's centre pedestal, its knee panels, the glare shield's indexers)
  sw0: [0, 704, 256, 160], sw1: [256, 704, 256, 160], sw2: [0, 864, 256, 160], sw3: [256, 864, 256, 160], sw4: [512, 832, 256, 192], sw5: [768, 832, 256, 192],
  wingFL: [0, 1024, 171, 128], wingFR: [171, 1024, 171, 128], // (the F-16 panel's side wings: grey faces, the threat scope; the engine gauges)
};
// The F-16's instrument panel faces are painted dark gull grey (FS 36231) with white lettering, as its consoles and tub
// are; the switch panels on the consoles and sidewalls are black lighting plates. GREY: the cells painted grey.
const GF = '#5f6367', GREY = new Set(['gauges', 'ped', 'aux', 'aux2', 'wingFL', 'wingFR']);
// round instruments on the big panels, cell-normalised (u, v; r a fraction of the cell's width): drawn into the atlas,
// and their bezels built where they are
const DIALS = {
  sr71: [{ u: 0.5, v: 0.3, r: 0.1, k: 'adi' }, { u: 0.5, v: 0.66, r: 0.095, k: 'hsi', live: 1 }, { u: 0.21, v: 0.38, r: 0.075, live: 1 }, { u: 0.21, v: 0.62, r: 0.075, live: 1 }, { u: 0.21, v: 0.85, r: 0.058 },
    { u: 0.07, v: 0.3, r: 0.045 }, { u: 0.07, v: 0.5, r: 0.045 }, { u: 0.07, v: 0.7, r: 0.045 }, { u: 0.07, v: 0.88, r: 0.04 }, { u: 0.34, v: 0.86, r: 0.045 },
    { u: 0.79, v: 0.2, r: 0.06 }, { u: 0.79, v: 0.42, r: 0.06 }, { u: 0.79, v: 0.64, r: 0.06 }, { u: 0.79, v: 0.86, r: 0.055 }, { u: 0.66, v: 0.86, r: 0.045 },
    { u: 0.93, v: 0.2, r: 0.045 }, { u: 0.93, v: 0.38, r: 0.045 }, { u: 0.93, v: 0.56, r: 0.045 }, { u: 0.93, v: 0.74, r: 0.045 }, { u: 0.66, v: 0.36, r: 0.042 }],
  rso: [{ u: 0.5, v: 0.56, r: 0.15, k: 'scope' }, { u: 0.12, v: 0.32, r: 0.055 }, { u: 0.12, v: 0.56, r: 0.055 }, { u: 0.12, v: 0.8, r: 0.055 }, { u: 0.26, v: 0.38, r: 0.05 },
    { u: 0.26, v: 0.66, r: 0.05 }, { u: 0.88, v: 0.32, r: 0.055 }, { u: 0.88, v: 0.56, r: 0.055 }, { u: 0.88, v: 0.8, r: 0.055 }, { u: 0.74, v: 0.38, r: 0.05 }, { u: 0.74, v: 0.66, r: 0.05 }],
  gauges: [{ u: 0.5, v: 0.42, r: 0.17, k: 'adi' }, { u: 0.16, v: 0.32, r: 0.12, live: 1 }, { u: 0.84, v: 0.32, r: 0.12, live: 1 }, { u: 0.16, v: 0.78, r: 0.09 }, { u: 0.84, v: 0.78, r: 0.09 }, { u: 0.5, v: 0.86, r: 0.08, k: 'hsi', live: 1 }],
  wingFL: [{ u: 0.3, v: 0.36, r: 0.19, k: 'scope' }], // (the threat warning's azimuth scope)
  wingFR: [{ u: 0.19, v: 0.3, r: 0.135 }, { u: 0.5, v: 0.3, r: 0.135 }, { u: 0.81, v: 0.3, r: 0.135 }, { u: 0.19, v: 0.73, r: 0.135 }, { u: 0.5, v: 0.73, r: 0.135 }, { u: 0.81, v: 0.73, r: 0.135 }], // (fuel flow, oil, nozzle, rpm, FTIT, hydraulics)
};
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const LEGENDS = ['NAV', 'TACAN', 'ILS', 'FUEL', 'ECM', 'IFF', 'UHF', 'VHF', 'OXY', 'ANTI ICE', 'PROBE', 'LIGHTS', 'MASTER', 'ARM', 'SAFE', 'GEN', 'BATT', 'INS', 'RADAR', 'HOOK', 'AUX', 'TRIM', 'PITOT', 'EPU', 'ENG', 'FLCS', 'AIR', 'TEMP', 'VOL', 'MODE', 'CHAFF', 'FLARE'];
// A switch panel's items (cell-normalised: u across, v down): two or three sub-panels, each a row of knobs, toggles and
// buttons with their legends. The same layout draws the picture and places the knobs and toggles on it.
function layout(name) {
  const [, , w, h] = CELLS[name], r = rnd(name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 99991 + 1), items = [], subs = [];
  const n = h / w > 0.7 ? 3 : 2; let v0 = 0;
  for (let i = 0; i < n; i++) {
    const v1 = i === n - 1 ? 1 : v0 + (0.8 + r() * 0.4) / n, k = 2 + Math.floor(r() * 3); subs.push([v0, v1]);
    for (let j = 0; j < k; j++) {
      const t = r(), kind = t < 0.42 ? 'knob' : t < 0.8 ? 'tog' : 'btn';
      items.push({ kind, u: (j + 0.5) / k + (r() - 0.5) * 0.06, v: v0 + (v1 - v0) * 0.6, r: kind === 'knob' ? 0.045 + r() * 0.03 : 0.03, label: LEGENDS[Math.floor(r() * LEGENDS.length)], guard: kind === 'tog' && r() < 0.18 });
    }
    v0 = v1;
  }
  return { items, subs };
}
const LAYOUTS = new Map(); const layoutOf = (name) => { if (!LAYOUTS.has(name)) LAYOUTS.set(name, layout(name)); return LAYOUTS.get(name); };

function drawAtlas() {
  const mk = () => { const c = document.createElement('canvas'); c.width = S; c.height = SH; return c; };
  const cA = mk(), cE = mk(), cR = mk(), g = cA.getContext('2d'), e = cE.getContext('2d'), ro = cR.getContext('2d');
  g.fillStyle = '#1a1c1f'; g.fillRect(0, 0, S, SH); e.fillStyle = '#000'; e.fillRect(0, 0, S, SH);
  ro.fillStyle = 'rgb(0,175,0)'; ro.fillRect(0, 0, S, SH); // (roughness in G: 0.69 painted panels; glass and screens glossy)
  const gloss = (x, y, w, h, v, round = false) => { ro.fillStyle = `rgb(0,${Math.round(v * 255)},0)`; if (round) { ro.beginPath(); ro.arc(x, y, w, 0, Math.PI * 2); ro.fill(); } else ro.fillRect(x, y, w, h); };
  const lit = (s, x, y, px, col = '#e4e6df') => { txt(g, s, x, y, px, col); txt(e, s, x, y, px, 'rgba(255,232,196,0.42)'); }; // backlit white lettering
  // a screen sunk in its bezel: shadowed inner edges (on the glow too), a lit lip round it
  const inset = (x, y, w, h) => { for (const [c, a] of [[g, 0.55], [e, 0.9]]) { c.strokeStyle = `rgba(0,0,0,${a})`; c.lineWidth = 7; c.strokeRect(x + 2, y + 2, w - 4, h - 4); c.lineWidth = 3; c.strokeStyle = `rgba(0,0,0,${a * 0.6})`; c.strokeRect(x + 6, y + 6, w - 12, h - 12); } g.strokeStyle = 'rgba(160,165,172,0.35)'; g.lineWidth = 1; g.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3); };
  const halo = (x, y, r) => { const gr = g.createRadialGradient(x + 1.5, y + 2.5, r * 0.6, x + 1.5, y + 2.5, r * 1.9); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x + 1.5, y + 2.5, r * 1.9, 0, Math.PI * 2); g.fill(); }; // (occlusion round a knob)
  let plates = 0;
  const both = (f) => { f(g); f(e); };
  const circ = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); };
  const rr = (c, x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
  const txt = (c, s, x, y, px, col = '#d9dcd6', al = 'center') => { c.font = `bold ${px}px Helvetica, Arial, sans-serif`; c.textAlign = al; c.textBaseline = 'middle'; c.fillStyle = col; c.fillText(s, x, y); };
  const dzus = (x, y) => { circ(g, x, y, 2.6); g.fillStyle = '#7d8187'; g.fill(); g.strokeStyle = '#2a2c2f'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 2, y); g.lineTo(x + 2, y); g.stroke(); };
  // a console module: its own shade (they vary panel to panel), a black seam round it, shadowed inner edges, the edge
  // nearest the pilot's hands worn lighter with a few scuffs, Dzus fasteners at the corners, a semi-gloss finish
  const plate = (x, y, w, h, col) => {
    const R2 = rnd(++plates * 131 + 7), k = col ? 0 : Math.round((R2() - 0.5) * 16), base = col === GF ? `rgb(${95 + k},${99 + k},${103 + k})` : col || `rgb(${42 + k},${45 + k},${50 + k})`;
    g.fillStyle = '#08090a'; g.fillRect(x, y, w, h); g.fillStyle = base; g.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
    for (let i = 0; i < 4; i++) { g.strokeStyle = `rgba(0,0,0,${0.32 - i * 0.07})`; g.lineWidth = 1; g.strokeRect(x + 2 + i, y + 2 + i, w - 4 - 2 * i, h - 4 - 2 * i); }
    g.fillStyle = 'rgba(190,196,204,0.22)'; g.fillRect(x + 2, y + h - 4, w - 4, 1.5); g.fillStyle = 'rgba(190,196,204,0.12)'; g.fillRect(x + 2, y + 2, 1.2, h - 4);
    for (let i = 0; i < 14; i++) { const sx = x + 4 + R2() * (w - 8), sy = y + h - 4 - R2() * R2() * h * 0.4; g.fillStyle = `rgba(200,205,210,${0.06 + R2() * 0.12})`; g.fillRect(sx, sy, 1 + R2() * 5, 0.8); }
    gloss(x + 1.5, y + 1.5, w - 3, h - 3, 0.58 + R2() * 0.12);
    for (const [a, b] of [[x + 6, y + 6], [x + w - 6, y + 6], [x + 6, y + h - 6], [x + w - 6, y + h - 6]]) dzus(a, b);
  };
  // a round instrument: a black face, white ticks and numbers, a needle (or an attitude ball, a compass card, a scope)
  const dial = (x, y, r, k = 'gauge', seed = 1, live = 0) => { dialFace(x, y, r, k, seed, live); gloss(x, y, r, 0, 0.1, true);
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = Math.max(1, r * 0.08); g.beginPath(); g.arc(x, y, r * 0.8, Math.PI * 1.1, Math.PI * 1.45); g.stroke(); }; // (the glass over it catches the light)
  const dialFace = (x, y, r, k, seed, live) => { // (live: its needle, or the heading card's lubber line, is geometry: liveDials)
    const R = rnd(seed * 97 + 13); halo(x, y, r + 2);
    circ(g, x, y, r + 2); g.fillStyle = '#3a3d41'; g.fill();
    if (k === 'adi') {
      g.save(); circ(g, x, y, r); g.clip(); const roll = (R() - 0.5) * 0.3; g.translate(x, y); g.rotate(roll);
      g.fillStyle = '#3d7fc4'; g.fillRect(-r, -r, 2 * r, r + r * 0.08); g.fillStyle = '#6b4a2b'; g.fillRect(-r, r * 0.08, 2 * r, r);
      g.strokeStyle = '#f2f2f2'; g.lineWidth = Math.max(1, r * 0.04); g.beginPath(); g.moveTo(-r, r * 0.08); g.lineTo(r, r * 0.08); g.stroke();
      for (let i = -3; i <= 3; i++) if (i) { const yy = r * 0.08 - i * r * 0.2, L = r * (i % 2 ? 0.18 : 0.32); g.beginPath(); g.moveTo(-L, yy); g.lineTo(L, yy); g.stroke(); }
      g.restore();
      g.strokeStyle = '#f6a01a'; g.lineWidth = Math.max(2, r * 0.07); g.beginPath(); g.moveTo(x - r * 0.55, y); g.lineTo(x - r * 0.18, y); g.lineTo(x - r * 0.1, y + r * 0.1); g.moveTo(x + r * 0.55, y); g.lineTo(x + r * 0.18, y); g.lineTo(x + r * 0.1, y + r * 0.1); g.stroke();
      return;
    }
    if (k === 'scope') {
      circ(g, x, y, r + r * 0.12); g.fillStyle = '#26282b'; g.fill();
      both((c) => { c.save(); circ(c, x, y, r); c.clip(); c.fillStyle = '#0c2a1a'; c.fillRect(x - r, y - r, 2 * r, 2 * r);
        const Q = rnd(5); for (let i = 0; i < 70; i++) { const a = Q() * 6.28, d = Q() * r, s = 3 + Q() * r * 0.25; c.fillStyle = `rgba(${60 + Q() * 40 | 0},${120 + Q() * 70 | 0},${70 + Q() * 30 | 0},0.35)`; circ(c, x + Math.cos(a) * d, y + Math.sin(a) * d, s); c.fill(); }
        c.strokeStyle = '#7dffa6'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
        for (const k2 of [0.33, 0.66]) { circ(c, x, y, r * k2); c.stroke(); } c.restore(); });
      return;
    }
    circ(g, x, y, r); g.fillStyle = '#0b0c0d'; g.fill();
    g.strokeStyle = '#e8e8e0'; g.lineWidth = Math.max(1, r * 0.035);
    const a0 = k === 'hsi' ? 0 : -Math.PI * 1.25, a1 = k === 'hsi' ? Math.PI * 2 : Math.PI * 0.25, N = k === 'hsi' ? 36 : 10 + Math.floor(R() * 8);
    for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * (i / N), L = i % (k === 'hsi' ? 3 : 2) ? 0.12 : 0.22; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.92, y + Math.sin(a) * r * 0.92); g.lineTo(x + Math.cos(a) * r * (0.92 - L), y + Math.sin(a) * r * (0.92 - L)); g.stroke(); }
    if (r > 14) for (let i = 0; i <= (k === 'hsi' ? 11 : 5); i++) { const a = k === 'hsi' ? (i / 12) * Math.PI * 2 - Math.PI / 2 : a0 + (a1 - a0) * (i / 5); txt(g, k === 'hsi' ? ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][i] : String(i * 2), x + Math.cos(a) * r * 0.58, y + Math.sin(a) * r * 0.58, Math.max(6, r * 0.2)); }
    if (k === 'hsi' && live) return;
    if (k === 'hsi') { g.strokeStyle = '#f2c300'; g.lineWidth = Math.max(2, r * 0.06); g.beginPath(); g.moveTo(x, y - r * 0.7); g.lineTo(x, y + r * 0.7); g.stroke(); g.fillStyle = '#f2f2f2'; g.fillRect(x - r * 0.25, y - 1, r * 0.5, 3); return; }
    if (live) return;
    const a = a0 + (a1 - a0) * (0.2 + R() * 0.6); g.strokeStyle = '#f4f4f0'; g.lineWidth = Math.max(1.5, r * 0.07); g.beginPath(); g.moveTo(x - Math.cos(a) * r * 0.15, y - Math.sin(a) * r * 0.15); g.lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8); g.stroke();
    circ(g, x, y, Math.max(1.5, r * 0.08)); g.fillStyle = '#555'; g.fill();
  };
  const at = (name, f) => { const [x, y, w, h] = CELLS[name]; for (const c of [g, e, ro]) { c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip(); } f(w, h); for (const c of [g, e, ro]) c.restore(); };
  const green = '#5dff7a';
  // MFDs: a bezel with five buttons a side, a radar page and a horizontal situation page
  for (const [name, page] of [['mfdA', 0], ['mfdB', 1]]) at(name, (w, h) => {
    rr(g, 2, 2, w - 4, h - 4, 14); g.fillStyle = '#25272a'; g.fill(); g.strokeStyle = '#0d0e0f'; g.lineWidth = 3; g.stroke();
    for (let i = 0; i < 5; i++) { const t = 58 + i * 35; for (const [bx, by] of [[t - 9, 8], [t - 9, h - 26], [8, t - 9], [w - 26, t - 9]]) { halo(bx + 9, by + 9, 9); rr(g, bx, by, 18, 18, 3); g.fillStyle = '#4a4d52'; g.fill(); g.fillStyle = '#e6e6e0'; g.fillRect(bx + 6, by + 8, 6, 2); } }
    both((c) => { c.fillStyle = '#020604'; c.fillRect(36, 36, w - 72, h - 72); }); gloss(36, 36, w - 72, h - 72, 0.08);
    both((c) => { c.save(); c.beginPath(); c.rect(36, 36, w - 72, h - 72); c.clip(); c.strokeStyle = green; c.fillStyle = green; c.lineWidth = 1.6;
      const cx = w / 2, cy = h - 50;
      if (page === 0) { for (const k of [0.25, 0.5, 0.75, 1]) { c.beginPath(); c.arc(cx, cy, 140 * k, -Math.PI * 0.8, -Math.PI * 0.2); c.stroke(); } for (const a of [-0.8, -0.65, -0.5, -0.35, -0.2]) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a * Math.PI) * 140, cy + Math.sin(a * Math.PI) * 140); c.stroke(); } for (const [x, y] of [[100, 92], [150, 120], [128, 76]]) c.fillRect(x, y, 7, 5); }
      else { const cy2 = h / 2 + 10; c.beginPath(); c.arc(cx, cy2, 62, 0, 7); c.stroke(); for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2, L = i % 3 ? 5 : 10; c.beginPath(); c.moveTo(cx + Math.cos(a) * 62, cy2 + Math.sin(a) * 62); c.lineTo(cx + Math.cos(a) * (62 - L), cy2 + Math.sin(a) * (62 - L)); c.stroke(); } c.beginPath(); c.moveTo(cx, cy2 - 12); c.lineTo(cx, cy2 + 12); c.moveTo(cx - 10, cy2 - 2); c.lineTo(cx + 10, cy2 - 2); c.stroke(); c.beginPath(); c.moveTo(cx, cy2); c.lineTo(cx + 40, cy2 - 46); c.stroke(); }
      const labs = page ? ['HSD', 'SMS', 'DCLT', 'FCR', 'SWAP'] : ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL']; labs.forEach((s, i) => { txt(c, s, 58 + i * 35, 46, 9, green); txt(c, ['DTE', 'TEST', 'FLIR', 'TFR', 'WPN'][i], 58 + i * 35, h - 46, 9, green); });
      c.restore(); }); inset(36, 36, w - 72, h - 72);
  });
  // up-front controls: the data entry display over a keypad
  at('ufc', (w, h) => { g.fillStyle = '#2c2f33'; g.fillRect(0, 0, w, h); both((c) => { c.fillStyle = '#071008'; c.fillRect(56, 8, 144, 40); }); gloss(56, 8, 144, 40, 0.08);
    both((c) => { ['UHF  242.00  STPT  8', '  VHF  10  *  15:42:07', ' M1 3  C   MAN  T 75X'].forEach((s, i) => { c.font = 'bold 10px monospace'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = '#9dff6e'; c.fillText(s, 60, 16 + i * 12); }); }); inset(56, 8, 144, 40);
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'RCL', '0', 'ENTR'];
    keys.forEach((k, i) => { const x = 66 + (i % 3) * 42, y = 58 + Math.floor(i / 3) * 25; halo(x + 18, y + 11, 13); rr(g, x, y, 36, 21, 4); g.fillStyle = '#4b4f55'; g.fill(); lit(k, x + 18, y + 11, k.length > 1 ? 8 : 12); });
    for (const x of [10, w - 46]) for (let i = 0; i < 4; i++) { rr(g, x, 58 + i * 25, 36, 21, 4); g.fillStyle = '#3d4045'; g.fill(); lit(['COM1', 'COM2', 'IFF', 'LIST', 'A-A', 'A-G', 'NAV', 'MRK'][i + (x > 50 ? 4 : 0)], x + 18, 69 + i * 25, 8); } });
  // caution lights: a grid of legends, two lit amber and one green
  at('warn', (w, h) => { g.fillStyle = '#202225'; g.fillRect(0, 0, w, h); const lit = { 4: '#ffb020', 9: '#ffb020', 14: '#41ff5a' };
    for (let i = 0; i < 18; i++) { const x = 8 + (i % 6) * 41, y = 6 + Math.floor(i / 6) * 24; g.fillStyle = '#3a2a12'; g.fillRect(x, y, 36, 20); const L = LEGENDS[(i * 7) % LEGENDS.length]; txt(g, L, x + 18, y + 10, 8, '#8a7550');
      gloss(x, y, 36, 20, 0.12); if (lit[i]) { e.shadowColor = lit[i]; e.shadowBlur = 8; both((c) => { c.fillStyle = lit[i]; c.fillRect(x, y, 36, 20); }); e.shadowBlur = 0; both((c) => txt(c, L, x + 18, y + 10, 8, '#1a1200')); } } });
  SWATCHES.forEach((c, i) => { g.fillStyle = '#' + c.toString(16).padStart(6, '0'); g.fillRect(768 + 16 * i, 240, 16, 16); gloss(768 + 16 * i, 240, 16, 16, [0.62, 0.66, 0.55, 0.6, 0.62, 0.6, 0.95, 0.85, 0.95, 0.97, 0.5, 0.45, 0.4, 0.6, 0.64, 0.48][i]); });
  g.fillStyle = '#ffffff'; g.fillRect(736, 224, 32, 32); // (white: what liveDials' needles and symbols are tinted from)
  // the F-16's standby instruments between the MFDs
  at('gauges', (w, h) => { plate(0, 0, w, h, GF); DIALS.gauges.forEach((d, i) => dial(d.u * w, d.v * h, d.r * w, d.k, i + 3, d.live)); });
  // the F-16's centre pedestal under the standby instruments: fuel quantity and flow over a caution block, the
  // oxygen and cabin-pressure gauges, a row of push buttons at the bottom
  at('ped', (w, h) => { plate(0, 0, w, 104, GF); dial(w * 0.5, 36, 27, 'gauge', 61); both((c) => { c.fillStyle = '#05070a'; c.fillRect(18, 74, w - 36, 16); }); inset(18, 74, w - 36, 16);
    both((c) => { c.font = 'bold 11px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ffd36a'; c.fillText('3200', w / 2, 82); }); lit('FUEL QTY', w / 2, 96, 8);
    plate(0, 104, w, 54, GF); const on = { 1: '#ffb020', 6: '#41ff5a' };
    for (let i = 0; i < 8; i++) { const x = 8 + (i % 2) * 42, y = 112 + Math.floor(i / 2) * 11; g.fillStyle = '#3a2a12'; g.fillRect(x, y, 38, 9); const L = LEGENDS[(i * 5 + 3) % LEGENDS.length]; txt(g, L, x + 19, y + 4.5, 6, '#8a7550'); gloss(x, y, 38, 9, 0.12);
      if (on[i]) { e.shadowColor = on[i]; e.shadowBlur = 6; both((c) => { c.fillStyle = on[i]; c.fillRect(x, y, 38, 9); }); e.shadowBlur = 0; both((c) => txt(c, L, x + 19, y + 4.5, 6, '#1a1200')); } }
    plate(0, 158, w, 98, GF); dial(w * 0.28, 188, 18, 'gauge', 62); dial(w * 0.72, 188, 18, 'gauge', 63); lit('OXY', w * 0.28, 214, 8); lit('CABIN', w * 0.72, 214, 8);
    for (let i = 0; i < 3; i++) { const x = 10 + i * 27, y = 226; halo(x + 11, y + 9, 10); rr(g, x, y, 22, 17, 3); g.fillStyle = '#3d4045'; g.fill(); lit(['FCR', 'RALT', 'ECM'][i], x + 11, y + 8.5, 7); } });
  // the glare shield's indexers: angle of attack (a green chevron, an amber doughnut, a red chevron; the doughnut lit)
  // and the air-refuelling / nose-wheel-steering lights (RDY, AR/NWS, DISC; the middle one lit)
  at('aoa', (w, h) => { g.fillStyle = '#101113'; g.fillRect(0, 0, w, h); const cx = [12, 32, 52];
    g.lineWidth = 3; g.strokeStyle = '#1f3a22'; g.beginPath(); g.moveTo(5, 10); g.lineTo(12, 20); g.lineTo(19, 10); g.stroke(); g.strokeStyle = '#3a1a16'; g.beginPath(); g.moveTo(45, 22); g.lineTo(52, 12); g.lineTo(59, 22); g.stroke();
    both((c) => { c.lineWidth = 3.5; c.strokeStyle = '#ffb020'; circ(c, cx[1], 16, 7); c.stroke(); }); gloss(0, 0, w, h, 0.1); });
  at('nws', (w, h) => { g.fillStyle = '#101113'; g.fillRect(0, 0, w, h);
    ['RDY', 'NWS', 'DISC'].forEach((L, i) => { const x = 3 + i * 20.5; g.fillStyle = '#1c2216'; g.fillRect(x, 8, 18, 16); txt(g, L, x + 9, 16, 6, '#5d6a4a'); if (i === 1) { e.shadowColor = '#41ff5a'; e.shadowBlur = 6; both((c) => { c.fillStyle = '#41ff5a'; c.fillRect(x, 8, 18, 16); }); e.shadowBlur = 0; both((c) => txt(c, L, x + 9, 16, 6, '#062a0c')); } }); gloss(0, 0, w, h, 0.1); });
  // the SR-71 pilot's panel: black, dense with round gauges; the triple display (speed, Mach, altitude) top left
  at('sr71', (w, h) => { g.fillStyle = '#111214'; g.fillRect(0, 0, w, h); for (let i = 1; i < 4; i++) { g.fillStyle = '#060607'; g.fillRect((w * i) / 4 + (i === 2 ? 0 : 0), 0, 2, h); }
    for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8], [w / 2, 8], [w / 2, h - 8]]) dzus(x, y);
    DIALS.sr71.forEach((d, i) => dial(d.u * w, d.v * h, d.r * w, d.k, i + 11, d.live));
    g.fillStyle = '#222428'; g.fillRect(w * 0.08, h * 0.06, w * 0.28, h * 0.13); both((c) => { ['KEAS 310', 'MACH 3.17', 'ALT 78500'].forEach((s, i) => { c.fillStyle = '#05070a'; c.fillRect(w * 0.1, h * 0.07 + i * 18, w * 0.24, 15); c.font = 'bold 12px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ffd36a'; c.fillText(s, w * 0.22, h * 0.07 + i * 18 + 8); }); }); gloss(w * 0.1, h * 0.07, w * 0.24, 52, 0.1); inset(w * 0.08, h * 0.06, w * 0.28, h * 0.13);
    for (let i = 0; i < 6; i++) { const x = w * 0.37 + i * 26, y = h * 0.06; g.fillStyle = '#2a1d0c'; g.fillRect(x, y, 22, 14); if (i === 2) both((c) => { c.fillStyle = '#ffb020'; c.fillRect(x, y, 22, 14); }); }
    for (let i = 0; i < 9; i++) lit(['FUEL', 'OIL', 'HYD A', 'HYD B', 'INLET', 'EGT', 'RPM', 'NOZ', 'CIT'][i], w * (0.6 + (i % 3) * 0.1), h * (0.96 - Math.floor(i / 3) * 0.02 - 0.02), 8); });
  // the RSO's panel: the viewsight's big round scope in the middle, the navigation display over it, gauges either side
  at('rso', (w, h) => { g.fillStyle = '#121315'; g.fillRect(0, 0, w, h); for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) dzus(x, y);
    DIALS.rso.forEach((d, i) => dial(d.u * w, d.v * h, d.r * w, d.k, i + 41));
    g.fillStyle = '#2a2d31'; g.fillRect(w * 0.33, h * 0.04, w * 0.34, h * 0.2); both((c) => { c.fillStyle = '#041007'; c.fillRect(w * 0.35, h * 0.06, w * 0.3, h * 0.16); ['ANS  STAR TRK  3', 'LAT N 34 12.4', 'LON W118 06.9', 'DEST 07  ETA 12'].forEach((s, i) => { c.font = 'bold 10px monospace'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = '#7dff8a'; c.fillText(s, w * 0.37, h * 0.085 + i * 13); }); }); gloss(w * 0.35, h * 0.06, w * 0.3, h * 0.16, 0.08); inset(w * 0.35, h * 0.06, w * 0.3, h * 0.16);
    for (let i = 0; i < 10; i++) { const x = w * 0.18 + i * 34, y = h * 0.92; halo(x + 13, y + 7, 12); g.fillStyle = '#3c3f44'; g.fillRect(x, y, 26, 14); lit(['CAM', 'SLR', 'TEOC', 'ELINT', 'DEF', 'REC', 'ON', 'OFF', 'TEST', 'IFF'][i], x + 13, y + 7, 7); } });
  // switch panels (consoles and the panel's side wings) from their layouts
  for (const name of ['sw0', 'sw1', 'sw2', 'sw3', 'sw4', 'sw5', 'wingL', 'aux', 'aux2']) at(name, (w, h) => {
    const L = layoutOf(name);
    for (const [v0, v1] of L.subs) plate(0, v0 * h, w, (v1 - v0) * h, GREY.has(name) ? GF : undefined);
    for (const it of L.items) {
      const x = it.u * w, y = it.v * h, r = it.r * w;
      lit(it.label, x, y - r - 9, 9);
      halo(x, y, it.kind === 'knob' ? r : r * 0.8);
      if (it.kind === 'knob') { for (let i = 0; i <= 6; i++) { const a = -Math.PI * 1.2 + (i / 6) * Math.PI * 1.4; g.strokeStyle = '#d9dcd6'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25); g.lineTo(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5); g.stroke(); } circ(g, x, y, r); g.fillStyle = '#0c0c0d'; g.fill(); }
      else if (it.kind === 'tog') { if (it.guard) { g.fillStyle = '#b4161b'; g.fillRect(x - r * 1.4, y - r * 1.8, r * 2.8, r * 3.6); } circ(g, x, y, r * 0.7); g.fillStyle = '#9a9ea4'; g.fill(); lit('ON', x + r * 2.1, y - r * 0.9, 7); lit('OFF', x + r * 2.3, y + r * 0.9, 7); }
      else { rr(g, x - r * 1.6, y - r * 1.1, r * 3.2, r * 2.2, 2); g.fillStyle = '#3f4247'; g.fill(); e.shadowColor = it.u > 0.5 ? '#3cff64' : '#ffb020'; e.shadowBlur = 6; both((c) => { c.fillStyle = it.u > 0.5 ? '#3cff64' : '#ffb020'; c.fillRect(x - r * 1.2, y - r * 0.3, r * 2.4, r * 0.6); }); e.shadowBlur = 0; gloss(x - r * 1.6, y - r * 1.1, r * 3.2, r * 2.2, 0.15); }
    }
  });
  // the F-16 panel's side wings (grey, after the F-16A's in the NMUSAF): the left one the threat warning's azimuth scope
  // over its prime buttons, a column of buttons and the arm switches; the right one six engine and fuel gauges
  at('wingFL', (w, h) => { plate(0, 0, w, h, GF); DIALS.wingFL.forEach((d, i) => dial(d.u * w, d.v * h, d.r * w, d.k, i + 71)); lit('THREAT WARNING', w * 0.3, h * 0.72, 7);
    for (let i = 0; i < 4; i++) { const x = w * 0.62, y = 10 + i * 17; halo(x + 9, y + 6, 8); rr(g, x, y, 18, 12, 2); g.fillStyle = '#3d4045'; g.fill(); lit(['HAND', 'LNCH', 'MODE', 'SYS'][i], x + 9, y + 6, 6); }
    lit('GEAR', w * 0.83, h * 0.12, 7); for (const [i, s] of ['MASTER ARM', 'LASER ARM'].entries()) { const x = w * (0.2 + i * 0.45), y = h * 0.88; lit(s, x + 18, y - 6, 7); circ(g, x, y + 3, 3.5); g.fillStyle = '#9a9ea4'; g.fill(); } });
  at('wingFR', (w, h) => { plate(0, 0, w, h, GF); DIALS.wingFR.forEach((d, i) => { dial(d.u * w, d.v * h, d.r * w, 'gauge', i + 81); lit(['FUEL FLOW', 'OIL', 'NOZ POS', 'RPM', 'FTIT', 'HYD'][i], d.u * w, d.v * h + d.r * w + 8, 6); }); });
  // a fine plastic / powder-coat grain over all of it (colour and roughness)
  { const id = g.getImageData(0, 0, S, SH), d = id.data, ir = ro.getImageData(0, 0, S, SH), dr = ir.data, R3 = rnd(77);
    for (let i = 0; i < d.length; i += 4) { const n = (R3() - 0.5) * 9; d[i] += n; d[i + 1] += n; d[i + 2] += n; dr[i + 1] += (R3() - 0.5) * 14; }
    g.putImageData(id, 0, 0); ro.putImageData(ir, 0, 0); }
  const tex = (c, srgb = true) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  return { map: tex(cA), emissiveMap: tex(cE), roughnessMap: tex(cR, false) };
}
// The surface shader: the atlas picture times a grain from the part-space position (colour and roughness), the baked
// occlusion (uv1.x: darker diffuse and reflections), and a bump: fine grain on paint, a weave with quilting seams and
// stitches on fabric (uv1.y = 1), a coarse matt texture on the coaming (0.5); faded out where it would alias.
const SURF = /* glsl */`
  varying vec3 vJP; varying vec2 vJA;
  float jH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float jN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(jH(i), jH(i + vec3(1,0,0)), f.x), mix(jH(i + vec3(0,1,0)), jH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(jH(i + vec3(0,0,1)), jH(i + vec3(1,0,1)), f.x), mix(jH(i + vec3(0,1,1)), jH(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 jBump(vec3 n, vec3 vp, float h, float k) { vec3 dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); return normalize(abs(det) * n - k * sign(det) * (dhx * r1 + dhy * r2)); }`;
export const panelMat = () => cached('panelMat', () => {
  const t = drawAtlas(), m = new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 1, roughnessMap: t.roughnessMap, metalness: 0.1 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vJP; varying vec2 vJA;\n#ifndef USE_UV1\nattribute vec2 uv1;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvJP = position; vJA = uv1;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + SURF)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float jFab = step(0.75, vJA.y), jCoam = step(0.25, vJA.y) * (1.0 - jFab), jG = jN(vJP * 260.0), jF = jN(vJP * 1500.0);
        float jFw = clamp(length(fwidth(vJP)) * 500.0, 0.0, 1.0);
        float jSeam = abs(fract(vJP.y / 0.065) - 0.5) * 0.065;
        diffuseColor.rgb *= (0.92 + 0.12 * jG + 0.06 * (jF - 0.5) * (1.0 - jFw)) * (1.0 - min(vJA.x, 0.9) * 0.62) * (1.0 - jFab * 0.3 * smoothstep(0.004, 0.0, jSeam));`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (jG - 0.5) * 0.14 + (jF - 0.5) * 0.08, 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 q = vJP * 1100.0; float h = (jF - 0.5) * 0.35 * roughnessFactor;
          h += jFab * (sin(q.x + q.z) * sin(q.y) * 0.45 - smoothstep(0.005, 0.0, jSeam) * 2.0 + step(0.5, fract((vJP.x + vJP.z) * 140.0)) * smoothstep(0.009, 0.006, jSeam) * smoothstep(0.004, 0.006, jSeam) * 0.8);
          h += jCoam * (jN(vJP * 700.0) - 0.5) * 1.4;
          normal = jBump(normal, -vViewPosition, h * (1.0 - jFw), 0.0005); }`)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= 1.0 - min(vJA.x, 0.9) * 0.5; reflectedLight.indirectSpecular *= 1.0 - min(vJA.x, 0.9) * 0.6;');
  };
  m.customProgramCacheKey = () => 'jetSurf1';
  return m;
});
// (the HUD's symbology: liveHud.js)

// the combiner: clear glass plates with the faintest green-gold cast (as the F-16's: you see the symbology, hardly the glass)
export const combinerMat = () => cached('combiner', () => new THREE.MeshBasicMaterial({ color: 0x3a4422, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide, fog: false })); // (barely there: the faintest green-gold dimming, as a real combiner's coating; a lit glass material mirrored the bright sky over the whole plate, and a light tint lifted a dark sea behind it)

// ---------- small geometry ----------
// a textured quad showing an atlas cell, w x h, facing +z, placed by m
export function quad(bag, cell, m, w, h) {
  const [x, y, cw, ch] = CELLS[cell], g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * cw) / S, 1 - (y + (1 - uv.getY(i)) * ch) / SH);
  g.applyMatrix4(m); bag.add(g, panelMat()); return g;
}
// a box with rounded edges (corner radius r <= a quarter of each side), smooth shaded
export function roundBox(w, h, d, r) {
  const g = new THREE.BoxGeometry(w, h, d, 4, 4, 4), p = g.attributes.position, hw = w / 2, hh = h / 2, hd = d / 2, q = V(), c = V();
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i); c.set(THREE.MathUtils.clamp(q.x, -hw + r, hw - r), THREE.MathUtils.clamp(q.y, -hh + r, hh - r), THREE.MathUtils.clamp(q.z, -hd + r, hd - r));
    const n = q.clone().sub(c), L = n.length(); if (L > 1e-9) q.copy(c).addScaledVector(n, r / L); p.setXYZ(i, q.x, q.y, q.z);
  }
  g.deleteAttribute('normal'); g.deleteAttribute('uv'); const m = mergeVertices(g, 1e-5); m.computeVertexNormals(); return m;
}
const shellOf = (g) => shell(g, 0.008), capOf = (g) => capHoles(g);
// a surface through a grid of points pts[j][i] (rows along j), its normals turned towards `towards` (a direction)
function gridSurf(pts, towards) {
  const nj = pts.length, ni = pts[0].length, pos = [], idx = [];
  for (const row of pts) for (const q of row) pos.push(q.x, q.y, q.z);
  for (let j = 0; j < nj - 1; j++) for (let i = 0; i < ni - 1; i++) { const a = j * ni + i, b2 = a + 1, c = a + ni, d = c + 1; idx.push(a, c, b2, b2, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const n = V().fromBufferAttribute(g.attributes.normal, 0); if (n.dot(towards) < 0) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}
const flat = (geo) => { const g = geo.index ? geo.toNonIndexed() : geo; g.deleteAttribute('normal'); g.computeVertexNormals(); return g; };
// A switch panel: its picture (on bag) and the knobs and toggles standing off it (on nb), w x h, facing +z under m
export function switchPanel(bag, nb, cell, m, w, h) {
  quad(bag, cell, m, w, h);
  for (const it of layoutOf(cell).items) {
    const x = (it.u - 0.5) * w, y = (0.5 - it.v) * h, r = it.r * w;
    if (it.kind === 'knob') { const k = new THREE.CylinderGeometry(r * 0.85, r, 0.011, 9); k.rotateX(Math.PI / 2); k.translate(x, y, 0.0055); k.applyMatrix4(m); nb.add(k, M.black()); }
    else if (it.kind === 'tog') { const l = bar(V(x, y, 0), V(x, y + 0.004, 0.014), 0.0035, 0.0035, true, 5); l.applyMatrix4(m); nb.add(l, M.steel()); }
  }
}
// bezel rims round the big round instruments of a panel picture (cell, w x h quad under m)
function bezels(nb, cell, m, w, h, minR = 0.05) {
  for (const d of DIALS[cell]) {
    if (d.r < minR) continue;
    const r = d.r * (CELLS[cell][2] / CELLS[cell][3]) * h, x = (d.u - 0.5) * w, y = (0.5 - d.v) * h; // (r: a fraction of the cell's width)
    const rim = new THREE.TorusGeometry(r * 1.07, 0.0045, 3, 18); rim.translate(x, y, 0.002); rim.applyMatrix4(m); nb.add(rim, M.darkMetal());
  }
}

// ---------- live instruments (liveDisplays.js) ----------
// a panel on the atlas (needles and symbols tinted from its white swatch), and its dials made live by index: a needle
// (spec: a signal, or (S) => 0..1 of the 270 degree sweep), the attitude ball ('adi'), the heading card ('hsi')
const livePanel = () => new LivePanel(panelMat(), { white: [752 / S, 1 - 240 / SH] });
function liveDials(lp, cell, m, w, h, spec) {
  const [cx, cy, cw, ch] = CELLS[cell];
  DIALS[cell].forEach((d, i) => {
    const sp = spec[i]; if (!sp) return;
    const r = d.r * w, f = m.clone().multiply(mx([(d.u - 0.5) * w, (0.5 - d.v) * h, 0]));
    if (sp === 'adi') lp.attitude(f, r, { sky: '#3d7fc4', ground: '#6b4a2b', symbol: '#f6a01a', z: 0.0006 });
    else if (sp === 'hsi') {
      const uvAt = (x, y) => [(cx + (d.u + x / w) * cw) / S, 1 - (cy + (d.v - y / h) * ch) / SH], wc = liveColor('#f2f2f2'), uv = lp.white;
      lp.part(f, new Shape().card(r * 0.97, 0.0005, uvAt), { src: 'hdg', xf: (hd) => -hd, wrap: true, w: 6 });
      lp.part(f, new Shape().bar(0, -r * 0.55, 0, r * 0.35, r * 0.08, 0.0012, wc, uv).bar(-r * 0.3, r * 0.05, r * 0.3, r * 0.05, r * 0.07, 0.0012, wc, uv).bar(-r * 0.14, -r * 0.48, r * 0.14, -r * 0.48, r * 0.06, 0.0012, wc, uv)
        .poly([[0, r * 0.95], [-r * 0.08, r * 1.08], [r * 0.08, r * 1.08]], 0.0012, liveColor('#f2c300'), uv));
    } else lp.needle(f, { src: sp, at: (v) => -Math.PI * 1.25 + Math.PI * 1.5 * Math.max(-0.02, Math.min(1.02, v)), len: r * 0.8, w: r * 0.08, z: 0.0012, hub: 2.4, hubCol: '#2a2b2e', damp: 8 });
  });
}

// ---------- the ejection seat ----------
// seatGeo's padded back and pan at `at` (dims: [width, backH, panL, tilt]) with the rest of a jet's seat: the head box
// with its headrest pad and the face-curtain handle on top, side plates up the back, the catapult rails behind, the
// survival-kit pan under the cushion (kit), the seat-pan firing handle at the front. On bag (structure) and nb (small).
export function ejectionSeat(bag0, nb, { at, dims, kit = false, frame, headUp = 0, cushion = jetPaint(0x24262a, 1) }) {
  const bag = paintBag(bag0);
  const [w, backH, panL, tilt] = dims, [ax, ay, az] = at, ct = Math.cos(tilt), st = Math.sin(tilt), seatM = cushion;
  const s = seatGeo(w, backH, panL, tilt); s.translate(ax, ay, az); bag.add(s, seatM);
  const up = (k, dz = 0) => V(ax, ay + k * ct, az + k * st + dz); // a point up the back's rake (k along it), dz behind its front
  // head box (the parachute) on the top of the back, its pad facing forward, the loop handle on top
  const hc = up(backH + 0.1 + headUp / 2, 0.04), hb = roundBox(0.3, 0.24 + headUp, 0.15, 0.03); hb.applyMatrix4(mx(hc.toArray(), [tilt, 0, 0])); bag.add(hb, frame);
  const pad = roundBox(0.2, 0.13, 0.03, 0.012); pad.applyMatrix4(mx(up(backH + 0.07 + headUp, -0.045).toArray(), [tilt, 0, 0])); bag.add(pad, seatM);
  { const top = up(backH + 0.22 + headUp, 0.04), hm = mx(top.toArray(), [tilt, 0, 0]);
    const hs = new THREE.BoxGeometry(0.1, 0.022, 0.05); hs.translate(0, 0.003, 0); hs.applyMatrix4(hm); bag.add(hs, frame); // (the handle's housing)
    const h = new THREE.TorusGeometry(0.04, 0.008, 5, 12, Math.PI); h.translate(0, 0.006, 0); h.applyMatrix4(hm); nb.add(h, M.propTip());
    for (const a of [0.5, 1.57, 2.64]) { const s2 = new THREE.CylinderGeometry(0.0095, 0.0095, 0.012, 6); s2.rotateZ(a); s2.translate(Math.cos(a) * 0.04, Math.sin(a) * 0.04 + 0.006, 0); s2.applyMatrix4(hm); nb.add(s2, M.black()); } }
  // side plates up the back, and the rails behind it
  for (const sx of [-1, 1]) {
    const pl = new THREE.BoxGeometry(0.012, backH * 0.92 + headUp, 0.12); pl.applyMatrix4(mx(up((backH * 0.92 + headUp) / 2 + 0.01, 0.03).add(V(sx * (w / 2 + 0.007), 0, 0)).toArray(), [tilt, 0, 0])); bag.add(pl, frame);
    bag.add(bar(up(-0.02, 0.074).add(V(sx * 0.1, 0, 0)), up(backH + 0.02 + headUp, 0.074).add(V(sx * 0.1, 0, 0)), 0.03, 0.03), M.darkMetal()); // (against the back's rear face)
  }
  // harness webbing: the lap belts' ends lying over the pan's sides with their buckles, the shoulder straps coming out of
  // the head box down the back's top (olive webbing, stitched)
  const web = jetPaint(0x4f5440, 1);
  for (const sx of [-1, 1]) {
    const a = V(ax + sx * (w * 0.43), ay + 0.075, az - panL * 0.3), b2 = V(ax + sx * (w * 0.5 + 0.004), ay - 0.01, az - panL * 0.3);
    bag.add(bar(a, b2, 0.045, 0.004), web); const bk = new THREE.BoxGeometry(0.008, 0.035, 0.05); bk.translate(b2.x + sx * 0.002, b2.y + 0.02, b2.z); nb.add(bk, M.steel());
    bag.add(bar(up(backH + 0.01, 0.019).add(V(sx * 0.075, 0, 0)), up(backH - 0.07, 0.019).add(V(sx * 0.075, 0, 0)), 0.045, 0.004), web);
  }
  // the emergency-oxygen ring (the "green apple") on its cable at the left of the pan's front
  { const ring = new THREE.TorusGeometry(0.016, 0.0045, 5, 12); ring.rotateY(Math.PI / 2); ring.translate(ax - w / 2 - 0.009, ay - 0.012, az - panL * 0.72); bag.add(ring, jetPaint(0x2f6b34));
    nb.add(bar(V(ax - w / 2 - 0.009, ay + 0.004, az - panL * 0.72), V(ax - w / 2 - 0.004, ay + 0.02, az - panL * 0.55), 0.004, 0.004, true, 4), M.steel()); }
  // the survival kit under the cushion (its pan's bottom is 3.3 cm under the seat point) and the firing handle ahead of it
  if (kit) { const k = roundBox(w * 0.86, 0.045, panL * 1.05, 0.01); k.translate(ax, ay - 0.033 - 0.0225 + 0.002, az - panL * 0.45); bag.add(k, frame); }
  { const h = new THREE.TorusGeometry(0.032, 0.007, 5, 12, Math.PI); h.rotateZ(Math.PI); h.translate(ax, ay + 0.0, az - panL * 0.45 - 0.228); nb.add(h, M.propTip());
    for (const a of [-0.6, -1.57, -2.5]) { const s2 = new THREE.CylinderGeometry(0.0085, 0.0085, 0.01, 6); s2.rotateZ(a); s2.translate(ax + Math.cos(a) * 0.032, ay + Math.sin(a) * 0.032, az - panL * 0.45 - 0.228); nb.add(s2, M.black()); } }
}
// where the seat-pan handle is (for the legs' obstacles)
const panHandle = (at, panL) => ({ name: 'seat handle', box: [at[0], at[1] - 0.02, at[2] - panL * 0.45 - 0.228], size: [0.08, 0.05, 0.02], parts: ['legs', 'feet'] });

// ---------- the fighter's cockpit ----------
// Inside the fighter canopy (partDetail.cockpitBuild): everything sits in the tub under the revolved glass (its section
// 1.15 x as tall as wide, the tub its continuation below the base). paint: the airframe's (frames and bows).
export function fighterInterior(g, b0, nb, paint) {
  const b = paintBag(b0);
  // Round 3: painted as the F-16's is, dark gull grey (FS 36231: the tub, consoles, sidewalls, panel and pedestal), black
  // where the real one is (the glare shield, the MFD bezels, the up-front controls, the switch panels' lighting plates)
  const R = fighterGlassR, con = jetPaint(0x5f6367), dark = jetPaint(0x5f6367), lining = jetPaint(0x55585c), frame = jetPaint(0x3a3e44), black = M.black(), seatM = jetPaint(0x24262a, 1), coam = jetPaint(0x16171a, 0.5), worn = jetPaint(0x85898e);
  // The instrument panel as close as the F-16's: its face about 0.7 m from the pilot's eye (0.72 here; it was 1.04),
  // filling the view between the knees and most of the width between the canopy rails, the HUD over it on the glare
  // shield. PZ: how far aft of round 2's place it all moved (panel, wings, glare shield, HUD, indexers, knee panels).
  const PZ = 0.33;
  // occlusion: deeper in the tub darker (the floor, the consoles' feet), and the panel's top under the glare shield
  AO = (x, y, z) => Math.min(0.85, sm(-0.2, -0.52, y) * 0.55 + (z < -0.47 + PZ ? sm(-0.1, 0.22, y) * sm(-0.47 + PZ, -0.55 + PZ, z) * 0.5 : 0) + sm(0.3, 0.46, Math.abs(x)) * 0.15);
  const wallX = (z, y, k = 1) => { const r = R(z) * k, s = Math.min(1, Math.abs(y) / (1.15 * r)); return r * Math.sqrt(1 - s * s); }; // the tub's wall at height y (k: drawn in)
  // ejection seat on rails (its own meshes, userData.seatRail: crew.js moves them to where the pilot set it), so whoever
  // flies it sits back against it within reach of the stick and throttle; set down in the tub so the helmet clears the glass
  const SEAT = { at: [0, -0.4, 0.52], dims: [0.42, 0.62, 0.4, 0.3] };
  { const sb = new Bag(), snb = new Bag(); ejectionSeat(sb, snb, { ...SEAT, kit: true, frame, cushion: jetPaint(0x55594c, 1) });
    const n0 = g.children.length; sb.to(g); snb.to(g, true); for (const m of g.children.slice(n0)) m.userData.seatRail = 0; }
  // side consoles along the tub walls beside the seat (top 18 cm under the glass base, inboard faces 46 cm apart: the
  // thighs pass between them), their outboard sides following the tub down to where it comes in under them
  const CZ0 = -0.4, CZ1 = 0.44, CT = -0.18, CI = 0.23;
  for (const sx of [-1, 1]) {
    const rings = [];
    for (let j = 0; j <= 8; j++) {
      const z = CZ0 + (CZ1 - CZ0) * (j / 8), r = R(z) * 0.985, yb = -1.15 * r * Math.sqrt(Math.max(0, 1 - (CI / r) ** 2)), ring = [V(sx * CI, CT, z)];
      for (let i = 0; i <= 7; i++) { const y = CT + (yb - CT) * (i / 7); ring.push(V(sx * Math.max(CI, wallX(z, y, 0.985)), y, z)); }
      rings.push(ring);
    }
    b.add(flat(ringLoft(rings, true, true)), con);
    // an edge strip along the top's inboard edge
    b.add(bar(V(sx * (CI + 0.004), CT + 0.002, CZ0 + 0.01), V(sx * (CI + 0.004), CT + 0.002, CZ1 - 0.01), 0.008, 0.008), worn); // (worn bright where hands and sleeves rub)
  }
  // the sidewalls over the consoles lined (painted panels following the tub up to the glass base) with the canopy-sill
  // rail along their top; a floor plate (coarse matt) along the tub's bottom under the pedals
  for (const sx of [-1, 1]) {
    const rows = []; for (let j = 0; j <= 10; j++) { const z = -0.5 + 1.25 * (j / 10), row = []; for (const y of [CT + 0.008, -0.1, -0.015]) row.push(V(sx * wallX(z, y, 0.968), y, z)); rows.push(row); }
    b.add(shell(gridSurf(rows, V(-sx, 0, 0)), 0.006), lining);
    const rail = []; for (let j = 0; j <= 10; j++) { const z = -0.5 + 1.25 * (j / 10); rail.push(V(sx * (wallX(z, -0.02, 0.968) - 0.006), -0.02, z)); } b.add(pipe(rail, 0.007, 6, 40), worn);
  }
  { const rows = []; for (let j = 0; j <= 8; j++) { const z = -0.45 + 0.6 * (j / 8), y = -1.07 * R(z), w2 = wallX(z, y, 0.97) - 0.01; rows.push([V(-w2, y, z), V(0, y, z), V(w2, y, z)]); }
    b.add(shell(gridSurf(rows, V(0, 1, 0)), 0.006), jetPaint(0x16171a, 0.5)); }
  // their tops: switch panels round the throttle quadrant (left; crew.js draws it, 9 x 30 cm on the console at the
  // throttle's base) and round the side-stick's mount and armrest (right)
  const top = (cell, sx, x0, x1, z0, z1) => switchPanel(b, nb, cell, mx([sx * (x0 + x1) / 2, CT + 0.0015, (z0 + z1) / 2], [-Math.PI / 2, 0, 0]), x1 - x0, z1 - z0);
  top('sw0', -1, 0.238, 0.43, -0.39, -0.215); top('sw1', -1, 0.238, 0.43, -0.205, -0.03); top('sw4', -1, 0.325, 0.44, -0.015, 0.28); top('sw2', -1, 0.238, 0.415, 0.3, 0.43);
  top('sw3', 1, 0.238, 0.43, -0.39, -0.215); top('sw5', 1, 0.238, 0.43, -0.205, -0.03); top('sw4', 1, 0.36, 0.44, -0.015, 0.3); top('sw1', 1, 0.238, 0.415, 0.33, 0.43);
  // the side-stick's raised mount (the stick from crew.js stands on it) and the forearm's armrest behind it
  { const mt = roundBox(0.1, 0.065, 0.14, 0.015); mt.translate(0.275, CT + 0.0295, 0.06); b.add(mt, con);
    const pad = roundBox(0.1, 0.045, 0.18, 0.016); pad.translate(0.29, -0.1555, 0.23); b.add(pad, seatM); }
  // instrument panel (on a narrow pedestal from fitOut): the MFDs either side, the up-front controls under the HUD, the
  // standby instruments between the MFDs, caution lights over them
  const pf = mx([0, 0.11, -0.6 + PZ], [-0.2, 0, 0]), on = (x, y, z) => pf.clone().multiply(mx([x, y, z]));
  { const body = new THREE.BoxGeometry(0.52, 0.24, 0.03); body.applyMatrix4(on(0, 0, -0.009)); b.add(body, dark); } // (its face where the old panel's was, top edge under the glare shield's lid)
  for (const [sx, cell] of [[-1, 'mfdA'], [1, 'mfdB']]) { const mb = roundBox(0.155, 0.155, 0.024, 0.006); mb.applyMatrix4(on(sx * 0.165, -0.035, 0.018)); b.add(mb, black); quad(b, cell, on(sx * 0.165, -0.035, 0.0305), 0.15, 0.15);
    for (const [x, y, w2, h2] of [[0, 0.057, 0.12, 0.006], [0, -0.057, 0.12, 0.006], [0.057, 0, 0.006, 0.12], [-0.057, 0, 0.006, 0.12]]) { const lip = new THREE.BoxGeometry(w2, h2, 0.005); lip.applyMatrix4(on(sx * 0.165 + x, -0.035 + y, 0.0328)); nb.add(lip, black); } } // (a lip round the screen: it sits in the bezel)
  { const u = new THREE.BoxGeometry(0.14, 0.0875, 0.06); u.applyMatrix4(on(0, 0.07, 0.036)); b.add(u, black); quad(b, 'ufc', on(0, 0.07, 0.0663), 0.14, 0.0875); }
  quad(b, 'gauges', on(0, -0.06, 0.0068), 0.15, 0.1125); bezels(nb, 'gauges', on(0, -0.06, 0.0068), 0.15, 0.1125, 0.08);
  // live (liveDisplays.js): the standby attitude, airspeed (hundreds of knots), altitude (ten thousands of feet) and
  // heading; the MFDs (radar on the left, a moving map and the engine on the right), the master caution and AB lights
  const lp = livePanel(); liveDials(lp, 'gauges', on(0, -0.06, 0.0068), 0.15, 0.1125, { 0: 'adi', 1: (S) => S.kt / 1000, 2: (S) => S.alt / 100000, 5: 'hsi' });
  for (const sx of [-1, 1]) lp.screen(on(sx * 0.165, -0.035, 0.0312), 0.1078, 0.1078, { px: [256, 256], hz: 10, z: 0, dark: true, draw: sx < 0 ? fighterRadar : fighterMap });
  lp.screen(on(-0.086, 0.083, 0.0072), 0.026, 0.04, { px: [64, 96], hz: 8, z: 0, dark: true, draw: cautionLamps });
  for (const sx of [-1, 1]) quad(b, 'warn', on(sx * 0.165, 0.08, 0.0068), 0.13, 0.049);
  // side wings angled in towards the pilot under the glare shield, the landing-gear handle on the left one
  const wings = [-1, 1].map((sx) => mx([sx * 0.325, -0.03, -0.545 + PZ], [0, -sx * 0.71, 0]));
  wings.forEach((wm, i) => { const sx = i ? 1 : -1, bx = new THREE.BoxGeometry(0.17, 0.14, 0.02); bx.applyMatrix4(wm.clone().multiply(mx([0, 0, -0.01]))); b.add(bx, dark);
    const fm = wm.clone().multiply(mx([0, 0, 0.0008])), cell = sx < 0 ? 'wingFL' : 'wingFR'; quad(b, cell, fm, 0.16, 0.12); bezels(nb, cell, fm, 0.16, 0.12, 0.1);
    if (sx < 0) { lp.screen(wm.clone().multiply(mx([0.05, -0.006, 0.0016])), 0.026, 0.02, { px: [64, 48], hz: 8, z: 0, dark: true, draw: gearLamps }); // (the gear's three greens, under its handle)
      const k0 = V(0.045, 0.035, 0).applyMatrix4(wm), k1 = V(0.045, 0.035, 0.04).applyMatrix4(wm); nb.add(bar(k0, k1, 0.008, 0.008, true, 6), M.steel());
      const kn = new THREE.CylinderGeometry(0.014, 0.014, 0.018, 10); kn.rotateX(Math.PI / 2); kn.applyMatrix4(wm.clone().multiply(mx([0.045, 0.035, 0.045]))); nb.add(kn, M.pilot()); } });
  // glare shield over the panel (a part-cylinder hood, open behind), its padded lip along the rear edge
  const gl = new THREE.CylinderGeometry(0.3, 0.3, 0.18, 18, 1, true, -1.3, 2.6); gl.scale(1, 1, 0.6); gl.rotateY(Math.PI); gl.translate(0, 0.14, -0.6 + PZ); b.add(shellOf(gl), coam);
  const glTop = new THREE.CylinderGeometry(0.3, 0.3, 0.012, 18, 1, false, -1.3, 2.6); glTop.scale(1, 1, 0.6); glTop.rotateY(Math.PI); glTop.translate(0, 0.23, -0.6 + PZ); b.add(capOf(glTop), coam);
  b.add(pipe([V(-0.288, 0.229, -0.646 + PZ), V(-0.14, 0.229, -0.62 + PZ), V(0, 0.229, -0.6 + PZ), V(0.14, 0.229, -0.62 + PZ), V(0.288, 0.229, -0.646 + PZ)], 0.011, 6, 30), coam);
  // the coaming deck (anti-glare black) from the glare shield forward to the windscreen and out to the tub's walls over
  // the panel's wings (its back edge stepping aft over their tops), so the panel sits under a deck as the F-16's does
  { const W = (z) => 0.92 * wallX(z, 0.045), zr = (x) => Math.abs(x) < 0.25 ? -0.31 : Math.min(-0.16, -0.31 + (Math.abs(x) - 0.25) * 1.1), rows = [];
    for (let j = 0; j <= 8; j++) { const u = j / 8, row = []; for (let i = 0; i <= 10; i++) { const sx = -1 + 2 * (i / 10); let x = sx * 0.44, z = 0; for (let k = 0; k < 3; k++) { z = -0.95 + u * (zr(x) + 0.95); x = sx * W(z); } row.push(V(x, 0.045, z)); } rows.push(row); }
    b.add(shell(gridSurf(rows, V(0, 1, 0)), 0.006), coam); }
  // the HUD: its body on the glare shield, the combiner glass in a frame on top, the symbology glowing on it
  const hf = mx([0, 0.345, -0.62 + PZ], [-0.35, 0, 0]), HUDG = [0.19, 0.16]; // (the combiner glass: about 15 x 13 degrees from the pilot's eye, at the eye line: the boresight in view, the foot on the HUD's body)
  { const hb = roundBox(0.13, 0.035, 0.1, 0.008); hb.translate(0, 0.2535, -0.635 + PZ); b.add(hb, black);
    const hud = new THREE.PlaneGeometry(HUDG[0], HUDG[1]); hud.applyMatrix4(hf); nb.add(hud, combinerMat());
    // the symbology (liveHud.js): collimated, drawn at infinity through the combiner
    const sym = new THREE.PlaneGeometry(HUDG[0] - 0.008, HUDG[1] - 0.008); sym.applyMatrix4(hf.clone().multiply(mx([0, 0, 0.002]))); collimatedHud(lp, g, sym, { occluders: [[0, 0.2535, -0.635 + PZ, 0.068, 0.021, 0.056], ...[-1, 1].map((sx) => [sx * 0.12, 0.252, -0.665 + PZ, 0.027, 0.017, 0.015])] }); // (its body, hb below, and the indexers)
    // a second, shorter plate just forward of it (the F-16's combiner is a pair of glass plates), held at the sides by slim
    // brackets rising from the HUD's body a third of the way up; the glass's top edge free, no frame over it
    { const p2 = new THREE.PlaneGeometry(HUDG[0] - 0.01, HUDG[1] * 0.72); p2.translate(0, -HUDG[1] * 0.14, -0.014); p2.applyMatrix4(hf); nb.add(p2, combinerMat()); }
    const c = (x, y, z = 0) => V(x, y, z).applyMatrix4(hf), hx = HUDG[0] / 2 + 0.0025, hy = HUDG[1] / 2;
    for (const sx of [-1, 1]) nb.add(bar(c(sx * hx, -hy - 0.05, -0.007), c(sx * hx, -hy + HUDG[1] * 0.36, -0.007), 0.005, 0.016, true, 6), black); // (down into the body)
    nb.add(bar(c(-hx, -hy - 0.002, -0.007), c(hx, -hy - 0.002, -0.007), 0.004, 0.018, true, 6), black); }
  lp.to(g);
  // Round 2, the F-16's density (photos: F-16C cockpit, F-16 right console and side-stick, F-16 cockpits on Commons):
  // the centre pedestal under the panel down to the floor (its own pictures: fuel quantity and flow, a caution block,
  // oxygen and cabin gauges, buttons), the knee panels (the auxiliary consoles: each console's forward end rising to
  // the panel's wing, its sloped top a switch panel), the indexers either side of the HUD on the glare shield, the
  // canopy handle and the jettison T-handle on the sills, wiring looms clipped along the sidewalls, the canopy's
  // actuator on the deck behind the seat.
  // Round 3: with the panel this close the pedestal is over the feet (on the rudder pedals, 13 cm either side of the
  // middle): it comes down between the knees to just over the toes, and from there a narrow foot (the pedal-adjust
  // crank on it) runs down to the floor between the feet, 2 cm clear of them.
  const PED = { x: 0.072, y0: -0.23, y1: -0.012, z0: -0.33, z1: -0.244 }, STEM = { x: 0.03, y1: -0.23, z0: -0.33, z1: -0.285, floor: -0.5 };
  { const pb = new THREE.BoxGeometry(PED.x * 2, PED.y1 - PED.y0, PED.z1 - PED.z0); pb.translate(0, (PED.y0 + PED.y1) / 2, (PED.z0 + PED.z1) / 2); b.add(pb, dark);
    quad(b, 'pedT', mx([0, (PED.y0 + PED.y1) / 2 + 0.0025, PED.z1 + 0.0007]), 0.13, 0.214);
    const st = new THREE.BoxGeometry(STEM.x * 2, STEM.y1 - STEM.floor, STEM.z1 - STEM.z0); st.translate(0, (STEM.y1 + STEM.floor) / 2, (STEM.z0 + STEM.z1) / 2); b.add(st, dark);
    const lab = new THREE.BoxGeometry(0.044, 0.012, 0.002); lab.translate(0, -0.268, STEM.z1 + 0.001); b.add(lab, jetPaint(0x16171a)); // (its PEDAL ADJ placard)
    const ck = new THREE.CylinderGeometry(0.016, 0.018, 0.02, 12); ck.rotateX(Math.PI / 2); ck.translate(0, -0.3, STEM.z1 + 0.01); nb.add(ck, M.darkMetal());
    const kn = new THREE.CylinderGeometry(0.007, 0.007, 0.02, 8); kn.rotateX(Math.PI / 2); kn.translate(0.008, -0.3, STEM.z1 + 0.028); nb.add(kn, black); }
  const auxTop = (z) => z < -0.54 + PZ ? -0.12 : -0.12 - 0.058 * (z + 0.54 - PZ) / 0.135, AUX0 = -0.56 + PZ, AUX1 = -0.402 + PZ; // (the top slopes down aft to the console's)
  for (const sx of [-1, 1]) {
    const rings = [];
    for (let j = 0; j <= 6; j++) {
      const z = AUX0 + (AUX1 - AUX0) * (j / 6), yt = auxTop(z), r = R(z) * 0.962, yb = -1.15 * r * Math.sqrt(Math.max(0, 1 - (CI / r) ** 2)), ring = [V(sx * CI, yt, z)];
      for (let i = 0; i <= 7; i++) { const y = yt + (yb - yt) * (i / 7); ring.push(V(sx * Math.max(CI, wallX(z, y, 0.962)), y, z)); }
      rings.push(ring);
    }
    b.add(flat(ringLoft(rings, true, true)), con);
    const a = Math.atan2(0.058, 0.135), zc = -0.4725 + PZ, m = mx([sx * 0.3375, auxTop(zc) + 0.0015, zc], [-(Math.PI / 2 - a), 0, 0]);
    switchPanel(b, nb, sx < 0 ? 'aux' : 'aux2', m, 0.185, 0.13);
    b.add(bar(V(sx * (CI + 0.004), auxTop(-0.54 + PZ) + 0.002, -0.55 + PZ), V(sx * (CI + 0.004), auxTop(-0.405 + PZ) + 0.002, -0.405 + PZ), 0.008, 0.008), worn);
  }
  for (const [sx, cell] of [[-1, 'aoa'], [1, 'nws']]) { const ib = roundBox(0.05, 0.03, 0.024, 0.004); ib.translate(sx * 0.12, 0.252, -0.666 + PZ); b.add(ib, black); quad(b, cell, mx([sx * 0.12, 0.252, -0.6535 + PZ]), 0.044, 0.022); }
  { // the canopy handle on the right sill (a bracket on the lining, the lever along it, its grip forward) and the canopy
    // jettison T-handle (yellow and black) on the left sill ahead of the throttle
    const x = wallX(-0.04, -0.08, 0.968) - 0.004, steel = M.steel();
    const br = new THREE.BoxGeometry(0.014, 0.05, 0.03); br.translate(x - 0.007, -0.08, 0.04); nb.add(br, steel);
    nb.add(bar(V(x - 0.016, -0.08, 0.04), V(x - 0.022, -0.075, -0.1), 0.012, 0.008), steel);
    const gr = roundBox(0.022, 0.03, 0.05, 0.008); gr.translate(x - 0.024, -0.074, -0.12); nb.add(gr, black);
    const xl = wallX(-0.3, -0.07, 0.968) - 0.004, yel = jetPaint(0xd8b21c);
    const hs = new THREE.BoxGeometry(0.012, 0.04, 0.05); hs.translate(-(xl - 0.006), -0.07, -0.3); b.add(hs, jetPaint(0x222428));
    nb.add(bar(V(-(xl - 0.012), -0.07, -0.3), V(-(xl - 0.03), -0.07, -0.3), 0.008, 0.008, true, 6), steel);
    const th = new THREE.CylinderGeometry(0.008, 0.008, 0.06, 8); th.rotateX(Math.PI / 2); th.translate(-(xl - 0.036), -0.07, -0.3); b.add(th, yel);
    for (const dz of [-0.02, 0, 0.02]) { const st = new THREE.CylinderGeometry(0.0085, 0.0085, 0.008, 8); st.rotateX(Math.PI / 2); st.translate(-(xl - 0.036), -0.07, -0.3 + dz); nb.add(st, black); } }
  // switch panels on the sidewall linings over the consoles (the F-16's sidewalls carry them forward of the canopy handle
  // and behind it), leaning with the tub's wall: the left ones behind the T-handle, the right ones either side of the
  // canopy handle
  const wallPanel = (cell, sx, zc) => {
    const yt = -0.064, yb = -0.156, T = V(sx * (wallX(zc, yt, 0.968) - 0.009), yt, zc), Bt = V(sx * (wallX(zc, yb, 0.968) - 0.009), yb, zc), up = T.clone().sub(Bt).normalize();
    const zx = V(-sx, 0, 0).addScaledVector(up, sx * up.x).normalize(); // (facing inboard, square to the wall's lean)
    const xa = up.clone().cross(zx).normalize(), m = new THREE.Matrix4().makeBasis(xa, up, zx).setPosition(T.clone().lerp(Bt, 0.5));
    switchPanel(b, nb, cell, m, 0.15, 0.092);
  };
  wallPanel('sw2', -1, -0.165); wallPanel('sw5', -1, -0.01); wallPanel('sw3', 1, -0.31); wallPanel('sw0', 1, 0.205);
  for (const sx of [-1, 1]) { // wiring looms along the sidewalls under the sill rail, clipped every 20 cm
    const pts = []; for (let j = 0; j <= 12; j++) { const z = -0.38 + 1.1 * (j / 12); pts.push(V(sx * (wallX(z, -0.045, 0.968) - 0.009), -0.045, z)); }
    nb.add(pipe(pts, 0.0055, 5, 36), black);
    for (let j = 0; j <= 5; j++) { const z = -0.36 + 0.2 * j, q = V(sx * (wallX(z, -0.045, 0.968) - 0.007), -0.045, z), c = new THREE.BoxGeometry(0.008, 0.016, 0.01); c.translate(q.x, q.y, q.z); nb.add(c, M.steel()); } }
  { // the canopy's actuator on the deck behind the seat (aft of the avionics boxes): its cylinder from a mount on the deck to the hinge
    const dy = (z) => 0.12 + (-0.012 - 0.12) * ((z - 0.93) / (1.95 - 0.93)), a0 = V(0, dy(1.3) + 0.03, 1.3), a1 = V(0, dy(1.62) + 0.06, 1.62), mid = a0.clone().lerp(a1, 0.55);
    const mt = new THREE.BoxGeometry(0.08, 0.04, 0.06); mt.translate(0, dy(1.3) + 0.016, 1.3); b.add(mt, frame);
    b.add(bar(a0, mid, 0.045, 0.045, true, 10), frame); nb.add(bar(mid, a1, 0.022, 0.022, true, 8), M.chrome());
    for (const sx of [-1, 1]) { const hb = new THREE.BoxGeometry(0.02, 0.09, 0.07); hb.translate(sx * 0.035, dy(1.62) + 0.04, 1.62); b.add(hb, frame); } }
  // three mirrors on the windscreen bow (z -0.62: the bow's section half-width w, height h), facing the pilot
  { const r = R(-0.62), w = r + 0.006, h = r * 1.15 + 0.006;
    for (const da of [-0.5, 0, 0.5]) { const a = Math.PI / 2 + da, p = V(-Math.cos(a) * w, Math.sin(a) * h, -0.6), n = V(-Math.cos(a) * w, Math.sin(a) * h, 0).normalize();
      const c = p.addScaledVector(n, -0.05), mm = mx(c.toArray(), [0.3, 0, -da * 0.9]);
      const mb = new THREE.BoxGeometry(0.075, 0.03, 0.008); mb.applyMatrix4(mm); nb.add(mb, black);
      const mf = new THREE.PlaneGeometry(0.068, 0.023); mf.applyMatrix4(mm.clone().multiply(mx([0, 0, 0.0041]))); nb.add(mf, M.chrome());
      nb.add(bar(c.clone().addScaledVector(n, 0.008), c.clone().addScaledVector(n, 0.04), 0.008, 0.008, true, 5), black); } }
  // a bulkhead behind the seat (to the tub's walls, up to 12 cm over the glass base) and the avionics deck sloping back
  // from it under the canopy's tail
  { const zb = 0.93, yt = 0.12, y0 = -0.46, sh = new THREE.Shape(), N = 10;
    sh.moveTo(wallX(zb, y0, 0.98), y0); for (let i = 1; i <= N; i++) { const y = y0 + (yt - y0) * (i / N); sh.lineTo(wallX(zb, y, 0.98), y); }
    for (let i = N; i >= 0; i--) { const y = y0 + (yt - y0) * (i / N); sh.lineTo(-wallX(zb, y, 0.98), y); }
    const bh = new THREE.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: false, curveSegments: 1 }); bh.translate(0, 0, zb); b.add(bh, con);
    const pos = [], idx = [], NZ = 10; for (let j = 0; j <= NZ; j++) { const z = zb + (1.95 - zb) * (j / NZ), y = yt + (-0.012 - yt) * (j / NZ), x = wallX(z, y, 0.975); pos.push(-x, y, z, x, y, z); if (j) { const a = (j - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
    const dk = new THREE.BufferGeometry(); dk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); dk.setIndex(idx); dk.computeVertexNormals(); b.add(dk, con);
    for (const [x, z, w2, h2, d2] of [[0.06, 1.12, 0.14, 0.05, 0.14], [-0.08, 1.2, 0.1, 0.04, 0.1]]) { const y = yt + (-0.012 - yt) * ((z - zb) / (1.95 - zb)); const bx = new THREE.BoxGeometry(w2, h2, d2); bx.translate(x, y + h2 / 2 - 0.004, z); nb.add(bx, M.darkMetal()); } }
  // the pilot (crew.js) on the seat: the side-stick on its mount on the right console (the forearm on the armrest), the
  // throttle on the left console, the feet on the rudder pedals just ahead of the seat (the tub floor is ~-0.52)
  g.userData.seats = [{ p: [0, -0.28, 0.4], s: 0.88, fit: { at: SEAT.at, dims: SEAT.dims, floor: -0.52, feet: 'pedals' },
    controls: { stickBase: [0.27, 0.17, -0.33], stickLen: 0.11, thrBase: [-0.27, 0.1, -0.25], thrLen: 0.11, pedZ: -0.55, pedY: -0.22, grips: 'f16' },
    adjust: { seatZ: [-0.08, 0.02], seatY: [-0.03, 0.03] } }]; // (the seat runs 8 cm forward to 2 cm back, 3 cm up or down)
  g.userData.fit = [{ kind: 'seat', p: [0, -0.475, 0.36], w: 0.24, d: 0.22 }, { kind: 'panel', p: [0, STEM.floor, (STEM.z0 + STEM.z1) / 2], w: STEM.x * 2, d: STEM.z1 - STEM.z0 }]; // (the seat's rails under the survival kit; the pedestal's foot carried on down if the floor is deeper)
  // what the pilot must keep clear of: inside the glass (revolved, 1.15 x as tall as wide; walls below its base), the
  // consoles with their knobs, the side-stick's mount and armrest (the legs and torso only: the forearm rests on it), the
  // panel and everything standing off it, the wings, the glare shield, the HUD, the seat-pan handle (the legs)
  g.userData.seats[0].obstacles = [{ name: 'canopy', inside: insideRows(FIGHTER_GLASS[0][0], FIGHTER_GLASS.at(-1)[0], 72, (z) => [fighterGlassR(z), fighterGlassR(z) * 1.15, 0]) },
    ...[-1, 1].map((sx) => ({ name: 'console', box: [sx * 0.335, -0.3725, 0.02], size: [0.21, 0.415, 0.84] })), { name: 'armrest', box: [0.29, -0.15, 0.15], size: [0.13, 0.06, 0.34], parts: ['legs', 'torso'] },
    boxObstacle('panel', on(0, 0, -0.009), [0.52, 0.24, 0.03]), boxObstacle('UFC', on(0, 0.07, 0.036), [0.14, 0.0875, 0.06]),
    ...[-1, 1].map((sx) => boxObstacle('MFD', on(sx * 0.165, -0.035, 0.018), [0.155, 0.155, 0.024])), ...wings.map((wm) => boxObstacle('panel wing', wm.clone().multiply(mx([0, 0, 0.005])), [0.17, 0.14, 0.05])),
    hoodObstacle('glare shield', 0.3, 0.6, 1.3, 0.14, -0.6 + PZ, 0.18), boxObstacle('HUD', hf, [0.21, 0.18, 0.02]), { name: 'HUD body', box: [0, 0.2535, -0.635 + PZ], size: [0.13, 0.035, 0.1] }, panHandle(SEAT.at, SEAT.dims[2]),
    { name: 'pedestal', box: [0, (PED.y0 + PED.y1) / 2, (PED.z0 + PED.z1) / 2 + 0.004], size: [PED.x * 2, PED.y1 - PED.y0, PED.z1 - PED.z0 + 0.008] },
    { name: 'pedestal foot', box: [0, (STEM.y1 + STEM.floor) / 2, (STEM.z0 + STEM.z1) / 2 + 0.01], size: [STEM.x * 2 + 0.01, STEM.y1 - STEM.floor, STEM.z1 - STEM.z0 + 0.04] },
    ...[-1, 1].map((sx) => ({ name: 'knee panel', box: [sx * 0.335, -0.31, -0.48 + PZ], size: [0.21, 0.4, 0.16] })), ...[-1, 1].map((sx) => ({ name: 'indexer', box: [sx * 0.12, 0.252, -0.665 + PZ], size: [0.05, 0.03, 0.026] })),
    { name: 'canopy handle', box: [0.45, -0.077, -0.04], size: [0.06, 0.06, 0.2] }, ...[[-1, -0.165], [-1, -0.01], [1, -0.31], [1, 0.205]].map(([sx, z]) => ({ name: 'wall panel', box: [sx * 0.455, -0.11, z], size: [0.05, 0.1, 0.15] })), { name: 'jettison handle', box: [-0.44, -0.07, -0.3], size: [0.06, 0.05, 0.07] }];
  AO = null;
}

// ---------- the SR-71's two stations ----------
// Inside the tandem canopy (supersonicParts.tandemCanopy, detail build): the pilot under the glass, the RSO under the
// hatch behind the bulkhead (at z split .. split + 0.06). T: { w, h } the canopy's half-width and height at z,
// tcPt(z, a, k) a point on its section, paint the airframe's.
export function tandemInterior(g, b0, nb, { T, tcPt, split, paint }) {
  const b = paintBag(b0);
  const grey = jetPaint(0x596067), panel = jetPaint(0x141518), black = M.black(), frame = jetPaint(0x2a2c30), coam = jetPaint(0x16171a, 0.5);
  // occlusion: deep in the tub, the pilot's panel under its glare shield, the RSO's station shut in under the hatch
  AO = (x, y, z) => Math.min(0.85, sm(-0.4, -0.72, y) * 0.55 + (z < -1.38 && z > -1.7 ? sm(-0.35, 0.1, y) * 0.45 : 0) + (z > split ? 0.12 + sm(0.05, 0.3, y) * 0.15 : 0));
  // ejection seats (the tub floor at -0.72, both seats on risers)
  const SEAT1 = { at: [0, -0.48, -0.62], dims: [0.42, 0.66, 0.4, 0.26] }, SEAT2 = { at: [0, -0.53, 1.18], dims: [0.42, 0.62, 0.4, 0.26] };
  ejectionSeat(b, nb, { ...SEAT1, frame }); ejectionSeat(b, nb, { ...SEAT2, frame, headUp: 0.05 }); // (the RSO sits taller against the back: the head box higher, clear of the shoulders)
  // the pilot's side consoles (grey, as in the museum aircraft), switch panels on their tops round the throttle quadrant
  const P1 = { x: 0.31, y: -0.51, z: -0.88, w: 0.15, h: 0.42, d: 0.78 };
  const cons = (c, sx) => { const k = roundBox(c.w, c.h, c.d, 0.012); k.translate(sx * c.x, c.y, c.z); b.add(k, grey); };
  const top = (c, cell, sx, x0, x1, z0, z1) => switchPanel(b, nb, cell, mx([sx * (x0 + x1) / 2, c.y + c.h / 2 + 0.0015, (z0 + z1) / 2], [-Math.PI / 2, 0, 0]), x1 - x0, z1 - z0);
  for (const sx of [-1, 1]) cons(P1, sx);
  top(P1, 'sw4', -1, 0.318, 0.378, -1.2, -0.92); top(P1, 'sw2', -1, 0.242, 0.378, -0.89, -0.7); top(P1, 'sw0', -1, 0.242, 0.378, -0.69, -0.5);
  top(P1, 'sw3', 1, 0.242, 0.378, -1.26, -1.075); top(P1, 'sw1', 1, 0.242, 0.378, -1.065, -0.885); top(P1, 'sw5', 1, 0.242, 0.378, -0.87, -0.69); top(P1, 'sw0', 1, 0.242, 0.378, -0.68, -0.5);
  // the centre pedestal under the panel, between the legs
  { const ped = new THREE.BoxGeometry(0.12, 0.28, 0.16); ped.translate(0, -0.59, -1.5); b.add(ped, panel); }
  // the panel: black, dense with round gauges (the picture, bezels on the big ones); the glare shield over it with its lip
  { const body = new THREE.BoxGeometry(0.5, 0.554, 0.15); body.translate(0, -0.183, -1.485); b.add(body, panel); // (its top up under the glare shield's lid, which it carries)
    const pm = mx([0, -0.19, -1.4095]); quad(b, 'sr71', pm, 0.48, 0.42); bezels(nb, 'sr71', pm, 0.48, 0.42, 0.055); quad(b, 'warn', mx([0, 0.058, -1.4095]), 0.2, 0.0625);
    // live (liveDisplays.js): the attitude ball, the heading card, airspeed (hundreds of knots) and altitude (ten
    // thousands of feet), the triple display's KEAS / Mach / altitude
    const lp = livePanel(); liveDials(lp, 'sr71', pm, 0.48, 0.42, { 0: 'adi', 1: 'hsi', 2: (S) => S.kt / 1000, 3: (S) => S.alt / 100000 });
    lp.screen(pm.clone().multiply(mx([-0.1344, 0.1575, 0.0006])), 0.1344, 0.0546, { px: [256, 104], hz: 8, z: 0, dark: true, draw: sr71Triple }); lp.to(g); }
  const gl = new THREE.CylinderGeometry(0.3, 0.3, 0.16, 18, 1, true, -1.3, 2.6); gl.scale(1, 1, 0.55); gl.rotateY(Math.PI); gl.translate(0, 0.02, -1.5); b.add(shellOf(gl), coam);
  const glTop = new THREE.CylinderGeometry(0.3, 0.3, 0.012, 18, 1, false, -1.3, 2.6); glTop.scale(1, 1, 0.55); glTop.rotateY(Math.PI); glTop.translate(0, 0.1, -1.5); b.add(capOf(glTop), coam);
  b.add(pipe([V(-0.288, 0.1, -1.544), V(-0.14, 0.1, -1.52), V(0, 0.1, -1.5), V(0.14, 0.1, -1.52), V(0.288, 0.1, -1.544)], 0.011, 6, 30), coam);
  // side wings of the panel angled in to the pilot (gear handle on the left), under the glare shield, ahead of the consoles
  const wings = [-1, 1].map((sx) => mx([sx * 0.3, -0.24, -1.37], [0, -sx * 0.75, 0])); // (their inner ends against the panel's sides)
  wings.forEach((wm, i) => { const sx = i ? 1 : -1, bx = new THREE.BoxGeometry(0.14, 0.3, 0.02); bx.applyMatrix4(wm.clone().multiply(mx([0, 0, -0.01]))); b.add(bx, panel);
    switchPanel(b, nb, sx < 0 ? 'wingL' : 'sw5', wm.clone().multiply(mx([0, 0.04, 0.0008])), 0.13, sx < 0 ? 0.1 : 0.11);
    if (sx < 0) { const kn = new THREE.CylinderGeometry(0.014, 0.014, 0.018, 10); kn.rotateX(Math.PI / 2); kn.applyMatrix4(wm.clone().multiply(mx([0.02, -0.08, 0.04]))); nb.add(kn, M.pilot()); nb.add(bar(V(0.02, -0.08, 0).applyMatrix4(wm), V(0.02, -0.08, 0.035).applyMatrix4(wm), 0.008, 0.008, true, 6), M.steel()); } });
  // the periscope on the canopy roof (its fairing outside, the eyepiece and mirror hanging inside under the glass)
  const zp = -1.3, yTop = tcPt(zp, 0).y;
  { const f = new THREE.CapsuleGeometry(0.03, 0.12, 4, 8); f.rotateX(Math.PI / 2); f.scale(1, 0.8, 1); f.translate(0, yTop + 0.018, zp); b.add(f, paint);
    const ep = roundBox(0.08, 0.05, 0.07, 0.012); ep.translate(0, yTop - 0.03, zp); b.add(ep, black); // (up against its fairing through the glass)
    const mf = new THREE.PlaneGeometry(0.06, 0.03); mf.translate(0, yTop - 0.032, zp + 0.0355); nb.add(mf, M.chrome()); }
  // the bulkhead between the stations (built by the canopy: its shape follows the arch), painted like the consoles
  if (g.userData.bulkhead) { b.add(g.userData.bulkhead, frame); delete g.userData.bulkhead; }
  // the RSO's station: the panel on the bulkhead's back with the viewsight's big round scope in the middle, grey consoles
  const zf = split + 0.06, RS = { y: -0.25, h: 0.5, d: 0.13 };
  { const body = new THREE.BoxGeometry(0.56, RS.h, RS.d); body.translate(0, RS.y, zf + RS.d / 2); b.add(body, panel);
    const pm = mx([0, -0.215, zf + RS.d + 0.0005]); quad(b, 'rso', pm, 0.54, 0.405); bezels(nb, 'rso', pm, 0.54, 0.405, 0.05);
    const sc = DIALS.rso[0], sy = -0.215 + (0.5 - sc.v) * 0.405, sr = sc.r * 0.54; // the scope's hood
    const hood = new THREE.LatheGeometry([new THREE.Vector2(sr * 1.1, 0), new THREE.Vector2(sr * 1.22, 0), new THREE.Vector2(sr * 1.2, 0.045), new THREE.Vector2(sr * 1.12, 0.045), new THREE.Vector2(sr * 1.1, 0)], 20); hood.rotateX(Math.PI / 2); hood.translate(0, sy, zf + RS.d); b.add(hood, black);
    // an upper panel over it (switches) up to 18 cm over the glass base
    const up2 = new THREE.BoxGeometry(0.5, 0.18, 0.06); up2.translate(0, 0.09, zf + 0.03); b.add(up2, panel); switchPanel(b, nb, 'sw4', mx([0, 0.09, zf + 0.0605]), 0.48, 0.16); }
  const P2 = { x: 0.31, y: -0.56, z: 1.04, w: 0.11, h: 0.32, d: 0.56 }; // (beside the seat only: the feet go out either side of the panel's footwell)
  for (const sx of [-1, 1]) cons(P2, sx);
  top(P2, 'sw1', -1, 0.262, 0.358, 0.78, 1.0); top(P2, 'sw3', -1, 0.262, 0.358, 1.02, 1.31); top(P2, 'sw2', 1, 0.262, 0.358, 0.78, 1.0); top(P2, 'sw5', 1, 0.262, 0.358, 1.02, 1.31);
  // the sidewalls over the consoles lined (painted panels up to just under the glass base, the sill rail on top)
  for (const [c, y0] of [[P1, P1.y + P1.h / 2], [P2, P2.y + P2.h / 2]]) for (const sx of [-1, 1]) {
    const x = c.x + c.w / 2 + 0.006, l = new THREE.BoxGeometry(0.012, -0.08 - y0, c.d); l.translate(sx * x, (y0 - 0.08) / 2, c.z); b.add(l, grey); // (grey like the consoles, as the museum aircraft's are; its panels stay black)
    b.add(bar(V(sx * (x - 0.008), -0.085, c.z - c.d / 2), V(sx * (x - 0.008), -0.085, c.z + c.d / 2), 0.012, 0.012, true, 6), jetPaint(0x5d6168));
  }
  // the pilot's sidewalls (as the fighter's): switch panels on the linings over the consoles, a wiring loom clipped
  // along under the sill rail
  for (const sx of [-1, 1]) {
    const x = P1.x + P1.w / 2;
    for (const [zc, cell] of [[-1.12, sx < 0 ? 'sw3' : 'sw0'], [-0.76, sx < 0 ? 'sw1' : 'sw2']]) switchPanel(b, nb, cell, mx([sx * (x - 0.0005), -0.19, zc], [0, -sx * Math.PI / 2, 0]), 0.15, 0.092);
    nb.add(bar(V(sx * (x - 0.006), -0.122, P1.z - P1.d / 2 + 0.01), V(sx * (x - 0.006), -0.122, P1.z + P1.d / 2 - 0.01), 0.011, 0.011, true, 5), black);
    for (let j = 0; j < 4; j++) { const c = new THREE.BoxGeometry(0.008, 0.018, 0.01); c.translate(sx * (x - 0.004), -0.122, P1.z - P1.d / 2 + 0.08 + j * 0.2); nb.add(c, M.steel()); }
  }
  // the pilot: centre stick from the floor between the knees, throttles on the left console, feet on the rudder pedals
  g.userData.seats = [{ p: [0, -0.35, -0.74], s: 0.86, fit: { at: SEAT1.at, dims: SEAT1.dims, floor: -0.72, feet: 'pedals' },
    controls: { stickBase: [0, -0.3, -0.34], stickLen: 0.61, thrBase: [-0.27, 0.04, -0.3], thrLen: 0.12, pedZ: -0.48, pedY: -0.3 } },
  { p: [0, -0.4, 1.06], s: 0.86, role: 'crew', fit: { at: SEAT2.at, dims: SEAT2.dims, floor: -0.72 } }];
  // what the crew must keep clear of: inside the glass and the hatch (tcPt's sections: |x / w|^2 + |(y + 0.06) / (h +
  // 0.06)|^(8/3) = 1; the tub's walls under them at 0.9 x), the bulkhead between the two; the pilot's consoles (with
  // their knobs), panel, wings, glare shield, the pedestal under it, the periscope; the RSO's panel, scope and consoles
  const glass = { name: 'canopy', ey: 8 / 3, wBelow: 0.9, inside: insideRows(T.z0, T.z1, 92, (z) => [T.w(z), T.h(z) + 0.06, -0.06]) };
  const conObs = (c) => [-1, 1].map((sx) => ({ name: 'console', box: [sx * c.x, c.y + 0.0075, c.z], size: [c.w, c.h + 0.015, c.d] }));
  g.userData.seats[0].obstacles = [glass, { name: 'bulkhead', plane: [0, 0, -1], at: [0, 0, split + 0.03] }, ...conObs(P1),
    { name: 'panel', box: [0, -0.183, -1.485], size: [0.5, 0.554, 0.17] }, ...wings.map((wm) => boxObstacle('panel wing', wm.clone().multiply(mx([0, 0, 0.005])), [0.14, 0.3, 0.05])),
    hoodObstacle('glare shield', 0.3, 0.55, 1.3, 0.02, -1.5, 0.16), { name: 'pedestal', box: [0, -0.59, -1.5], size: [0.12, 0.28, 0.16] },
    { name: 'periscope', box: [0, yTop - 0.03, zp], size: [0.08, 0.05, 0.07] }, panHandle(SEAT1.at, SEAT1.dims[2]),
    ...[-1, 1].map((sx) => ({ name: 'sidewall', box: [sx * (P1.x + P1.w / 2 - 0.01), -0.16, P1.z], size: [0.03, 0.12, P1.d] }))];
  g.userData.seats[1].obstacles = [glass, { name: 'bulkhead', plane: [0, 0, 1], at: [0, 0, split + 0.06] }, ...conObs(P2),
    { name: 'RSO panel', box: [0, RS.y, zf + RS.d / 2 + 0.03], size: [0.56, RS.h, RS.d + 0.06] }, { name: 'RSO upper panel', box: [0, 0.09, zf + 0.04], size: [0.5, 0.18, 0.08] }, panHandle(SEAT2.at, SEAT2.dims[2])];
  AO = null;
}
