// The bubble canopy's cockpit (ck_bubble detail, called from partDetail.cockpitBuild): a single-seat sport plane's
// office under the glass, assembled from photos of real ones (Extra 300 / 330LX, Van's RV-6 / RV-8, Pitts S-2, CAP 10):
//   - a black anti-glare glareshield following the canopy's base forward to the windscreen, with a padded roll along
//     its edge and a whiskey compass on top;
//   - under it a full-width instrument panel with an arched top: the six-pack (airspeed, attitude, altimeter / turn
//     coordinator, heading, vertical speed) on the left, a moving-map screen and a com radio in the middle, tach,
//     manifold pressure, a g-meter and the small engine gauges on the right; a key switch and a row of toggles, the
//     push-pull prop / mixture / carb heat knobs and the circuit breakers along the bottom (all drawn in one texture
//     atlas, with real bezels, toggles, knobs and key standing off it);
//   - side consoles along both walls at hip height: the throttle quadrant (the crew's throttle stands in it), the fuel
//     selector and the trim wheel on the left, a padded armrest on the right;
//   - tuck-and-roll leather side panels under an aluminium canopy rail, a ribbed rubber floor mat (these follow the
//     tub the canopy gets on whatever body it is seated on: skinBlend calls userData.tubFit);
//   - the composite seat with leather cushions, a pleated back, a headrest and the harness (shoulder straps through
//     slots in the back, lap belt anchors), on its rails.
// Proportions: the cockpit is built round the crew's seat point (the pilot is a 0.8 scale figure); the panel's
// gauges are sized like real 3 1/8" and 2 1/4" instruments on that scale.
// Cost: about 7.5k triangles at full detail (lv 2) in 4 materials (the atlas, leather, matte black and the kit
// fittings, which planeDetail merges into the one kit material); traffic (lv 1) skips the small fittings.
import * as THREE from 'three';
import { mergeVertices } from '../vendor/addons/BufferGeometryUtils.js';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';
import { V, mx, bar, pipe, shell, Bag, seatGeo, boxObstacle } from './partDetail.js';
import { LivePanel, Shape, sweep, color } from './liveDisplays.js';

// the glass (partDetail's dome: half-axes across, up, along)
const A = 0.45, C = 0.425, BB = 1.0;
const dk = (z) => Math.sqrt(Math.max(0, 1 - (z / BB) ** 2));

// ---------- materials ----------
const _m = new Map(), mat = (k, f) => { if (!_m.has(k)) _m.set(k, f()); return _m.get(k); };
// procedural relief from the object-space position (no uvs): leather grain, sewn channels
const RELIEF = /* glsl */`
  varying vec3 vRelP;
  float rH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float rN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(rH(i), rH(i + vec3(1,0,0)), f.x), mix(rH(i + vec3(0,1,0)), rH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(rH(i + vec3(0,0,1)), rH(i + vec3(1,0,1)), f.x), mix(rH(i + vec3(0,1,1)), rH(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 rBump(vec3 n, vec3 vp, float h, float k) { vec3 dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); return normalize(abs(det) * n - k * sign(det) * (dhx * r1 + dhy * r2)); }`;
function relief(m, field, key, tint = '', rough = '') {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRelP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRelP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + RELIEF).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{ ${field} normal = rBump(normal, -vViewPosition, h, k); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{ ${tint} }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{ ${rough} }`);
  };
  m.customProgramCacheKey = () => 'relief-' + key; return m;
}
// saddle-tan leather: a fine grain, and horizontal channels sewn every 3.8 cm (tuck and roll: on the side panels and
// the seat back they read as pleats; on the flat cushion tops they don't show)
// stitched leather: grain, sewn channels with a row of light thread stitches either side of each seam, the hide's colour
// and sheen varying patch to patch, darker down in the seams
const leather = () => mat('leather', () => relief(new THREE.MeshStandardMaterial({ color: 0x7d5234, metalness: 0, roughness: 0.55 }),
  'float g = (rN(vRelP * 360.0) - 0.5) * 0.5 + (rN(vRelP * 1000.0) - 0.5) * 0.2; float s = fract(vRelP.y * 26.0); float fw = clamp(fwidth(vRelP.y) * 120.0, 0.0, 1.0); float h = g + mix(sqrt(sin(3.14159 * s)) * 1.4, 0.9, fw); float k = 0.0013;', 'bubLeather',
  `float s = fract(vRelP.y * 26.0), fw = clamp(fwidth(vRelP.y) * 120.0, 0.0, 1.0);
   float dash = step(0.45, fract((vRelP.x + vRelP.z) * 260.0)), row = (smoothstep(0.07, 0.085, s) - smoothstep(0.1, 0.115, s)) + (smoothstep(0.885, 0.9, s) - smoothstep(0.915, 0.93, s));
   diffuseColor.rgb *= (0.86 + 0.26 * rN(vRelP * 7.0)) * mix(0.66 + 0.34 * smoothstep(0.0, 0.1, s) * smoothstep(1.0, 0.9, s), 0.92, fw);
   diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.6, 0.44), row * dash * 0.55 * (1.0 - fw));`,
  'roughnessFactor = clamp(roughnessFactor * (0.7 + 0.6 * rN(vRelP * 18.0)), 0.25, 1.0);'));
// moulded / powder-coated interior parts (consoles, the firewall, the seat shell, the panel's back): a fine grain, the
// colour and sheen drifting across the part, darker the deeper it is in the tub (baked occlusion)
const interior = () => mat('interior', () => relief(new THREE.MeshStandardMaterial({ color: 0x34373c, metalness: 0.05, roughness: 0.62 }),
  'float h = (rN(vRelP * 900.0) - 0.5) * 0.6 + (rN(vRelP * 2600.0) - 0.5) * 0.3; float k = 0.0002;', 'bubInterior',
  'diffuseColor.rgb *= (0.84 + 0.3 * (rN(vRelP * 9.0) * 0.6 + rN(vRelP * 41.0) * 0.4)) * mix(0.45, 1.0, smoothstep(-0.72, -0.28, vRelP.y));',
  'roughnessFactor = clamp(roughnessFactor * (0.75 + 0.5 * rN(vRelP * 15.0)), 0.3, 1.0);'));
// the glareshield's anti-glare coaming fabric: a woven cloth, near black, dead matte
const coaming = () => mat('coaming', () => relief(new THREE.MeshStandardMaterial({ color: 0x18191b, metalness: 0, roughness: 0.95 }),
  'float fd = 1.0 - clamp(length(fwidth(vRelP)) * 700.0, 0.0, 1.0); float h = sin(vRelP.x * 2200.0) * sin(vRelP.z * 2200.0) * 0.5 * fd + (rN(vRelP * 700.0) - 0.5) * 0.5; float k = 0.00016;', 'bubCoaming',
  'diffuseColor.rgb *= 0.8 + 0.35 * rN(vRelP * 22.0);'));
// carpet (floor, kick panels, baggage floor): a dense pile, darker towards the walls and down in the footwell
const carpet = () => mat('carpet', () => relief(new THREE.MeshStandardMaterial({ color: 0x3a3c40, metalness: 0, roughness: 0.97 }),
  'float h = (rN(vRelP * 700.0) - 0.5) * 0.8 + (rN(vRelP * 90.0) - 0.5) * 0.3; float k = 0.0007;', 'bubCarpet',
  'diffuseColor.rgb *= (0.82 + 0.3 * rN(vRelP * 30.0)) * mix(1.0, 0.62, smoothstep(0.12, 0.3, abs(vRelP.x))) * mix(0.7, 1.0, smoothstep(-0.68, -0.45, vRelP.y));'));
const black = () => M.black(), matte = () => PM.exhaust(); // (kit fittings: one draw call once merged)

// ---------- the panel atlas ----------
// One 2048 x 1024 texture: the panel face in the top 923 rows (panel x -0.37..0.37, y -0.15..0.18 in its own frame),
// a strip of cells under it (solid colours for knobs and handles, the compass card, the fuel selector and trim
// placards, the throttle quadrant's plate). The screens and displays glow (the emissive map).
const TW = 2048, TH = 1024, PX0 = -0.37, PX1 = 0.37, PY0 = -0.15, PY1 = 0.18, PH = 923;
const pX = (x) => ((x - PX0) / (PX1 - PX0)) * TW, pY = (y) => ((PY1 - y) / (PY1 - PY0)) * PH, pS = TW / (PX1 - PX0);
const panelUV = (x, y) => [(x - PX0) / (PX1 - PX0), 1 - (pY(y) / TH)];
const CELLS = { red: 0, blue: 1, white: 2, yellow: 3, black: 4, green: 5, compass: 6, fuel: 7, trim: 8, quad: 9, chrome: 12, lamp: 13 }; // (quad is 3 cells wide; lamp: white, lit in the glow map too)
const cellRect = (i, w = 1) => [i * 100 + 6, PH + 8, (i + w) * 100 - 6, TH - 6];
const cellUV = (i, w = 1) => { const [x0, y0, x1, y1] = cellRect(i, w); return { u0: x0 / TW, u1: x1 / TW, v0: 1 - y1 / TH, v1: 1 - y0 / TH }; };
// the instruments (panel frame, metres): centre, face radius, kind
const GAUGES = [
  ...[['asi', -0.285, 0.085], ['ai', -0.205, 0.085], ['alt', -0.125, 0.085], ['tc', -0.285, 0.005], ['dg', -0.205, 0.005], ['vsi', -0.125, 0.005]].map(([k, x, y]) => ({ k, x, y, r: 0.031 })),
  { k: 'tach', x: 0.145, y: 0.08, r: 0.027 }, { k: 'map', x: 0.215, y: 0.08, r: 0.027 }, { k: 'g', x: 0.283, y: 0.072, r: 0.022 },
  ...[['oilT', 0.14, 0.012], ['oilP', 0.19, 0.012], ['cht', 0.24, 0.012], ['fuelL', 0.14, -0.042], ['fuelR', 0.19, -0.042], ['amp', 0.24, -0.042]].map(([k, x, y]) => ({ k, x, y, r: 0.018 })),
  { k: 'xpdr', x: 0.288, y: -0.038, r: 0.02 },
];
const SCREEN = { x0: -0.07, x1: 0.09, y0: -0.025, y1: 0.105 }, RADIO = { x0: -0.07, x1: 0.09, y0: -0.095, y1: -0.054 };
const TOGGLES = [['MASTER', -0.215], ['ALT', -0.185], ['PUMP', -0.155], ['NAV', -0.125], ['STROBE', -0.095], ['LAND', -0.065], ['AVION', 0.105]].map(([t, x]) => ({ t, x, y: -0.11 }));
const KNOBS = [['PROP', -0.025, 'blue'], ['MIX', 0.02, 'red'], ['CARB', 0.065, 'white']].map(([t, x, c]) => ({ t, x, y: -0.115, c }));
const BREAKERS = [5, 10, 5, 5, 10, 15].map((a, i) => ({ a, x: 0.135 + i * 0.029, y: -0.1 }));
const KEY = { x: -0.265, y: -0.11 }, ANN = [['VOLTS', -0.03, '#e0412b', 'off'], ['FUEL P', 0.01, '#f0a020', 'off'], ['STALL', 0.05, '#e0412b', 'stall']];
// the annunciators' lit faces, painted in the atlas's top left corner (outside the panel's arched top), and the gear's
// three greens under the vertical speed indicator (a retractable's down-and-locked lights: lit with fixed gear too)
const ANN_LIT = (i) => [4, 4 + i * 36], GEAR = { x: -0.128, y: -0.056, r: 0.0042, at: [[0, 0.007], [-0.009, -0.005], [0.009, -0.005]] };
// the dials (as painted, and as their needles read them): v from v0 to v1 over the canvas angles a0..a1
const T0 = -Math.PI / 2;
const DIAL = {
  asi: { v0: 40, v1: 200, a0: T0 + 0.35, a1: T0 + 2 * Math.PI - 0.35, major: 20, minor: 5, bands: [[50, 100, '#f2f2ee', 0.74, 0.06], [60, 145, '#2fa84f'], [145, 180, '#f2c300'], [179, 182, '#e0412b', 0.86, 0.2]], title: 'AIRSPEED', sub: 'KNOTS' },
  vsi: { v0: -20, v1: 20, a0: Math.PI * 0.03 + 0.001, a1: Math.PI * 1.97, major: 5, minor: 1, label: (v) => Math.abs(v), title: 'VERT SPEED', sub: '100 FT/MIN' }, // (0 at 9 o'clock, climb up over the top)
  tach: { v0: 0, v1: 35, a0: T0 - 2.2, a1: T0 + 2.2, major: 5, minor: 1, bands: [[20, 27, '#2fa84f'], [26.8, 27.4, '#e0412b', 0.86, 0.2]], title: 'RPM', sub: 'X 100' },
  map: { v0: 10, v1: 35, a0: T0 - 2.2, a1: T0 + 2.2, major: 5, minor: 1, bands: [[15, 29, '#2fa84f'], [29, 29.6, '#e0412b', 0.86, 0.2]], title: 'MAN PRESS', sub: 'IN HG' },
  g: { v0: -5, v1: 10, a0: T0 - 2.6, a1: T0 + 2.6, major: 5, minor: 1, bands: [[-3, 6, '#2fa84f'], [6, 10, '#e0412b'], [-5, -3, '#e0412b']], title: 'G UNITS' },
};
const SMALL = { a0: T0 - 1.0, a1: T0 + 1.0, src: { oilT: 'oilT', oilP: 'oilP', cht: 'cht', fuelL: 'fuelL', fuelR: 'fuelR', amp: 'amp' } };

function panelTextures() {
  const mk = () => { const c = document.createElement('canvas'); c.width = TW; c.height = TH; return c; };
  const cv = mk(), g = cv.getContext('2d'), gv = mk(), e = gv.getContext('2d'), rv = mk(), r = rv.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, TW, TH);
  // satin dark grey panel paint with a faint speckle
  // three sub-panels (the six-pack's, the avionics', the engine side's), each its own shade of satin grey
  const SUB = [[PX0, -0.085, '#3d4146'], [-0.085, 0.103, '#33363a'], [0.103, PX1, '#40444a']];
  for (const [x0, x1, col] of SUB) { g.fillStyle = col; g.fillRect(pX(x0), 0, pX(x1) - pX(x0), PH); }
  r.fillStyle = 'rgb(0,150,0)'; r.fillRect(0, 0, TW, TH); // roughness (G): satin paint, glossier glass and screens below
  { const img = g.getImageData(0, 0, TW, PH), d = img.data; let s = 12345; for (let i = 0; i < d.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = ((s >> 16) & 15) - 7; d[i] += n; d[i + 1] += n; d[i + 2] += n; } g.putImageData(img, 0, 0); }
  const F = (px, w = 'bold') => `${w} ${Math.round(px)}px Helvetica, Arial, sans-serif`;
  const txt = (ctx, s, x, y, px, col = '#e8e8e2', align = 'center', w = 'bold') => { ctx.fillStyle = col; ctx.font = F(px, w); ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y); };
  const screw = (x, y, r = 5) => { g.fillStyle = '#9a9ea4'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.strokeStyle = '#3a3c40'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x - r * 0.7, y - r * 0.3); g.lineTo(x + r * 0.7, y + r * 0.3); g.stroke(); };
  const arc = (cx, cy, r, a0, a1, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke(); };
  const ticks = (cx, cy, r0, r1, a0, a1, n, w, col = '#f2f2ee') => { g.strokeStyle = col; g.lineWidth = w; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke(); } };
  const needle = (cx, cy, a, L, w = 4, col = '#f4f4f0') => { g.save(); g.translate(cx, cy); g.rotate(a); g.fillStyle = col; g.beginPath(); g.moveTo(-L * 0.18, -w * 0.6); g.lineTo(L, 0); g.lineTo(-L * 0.18, w * 0.6); g.closePath(); g.fill(); g.restore(); g.fillStyle = '#202124'; g.beginPath(); g.arc(cx, cy, w * 1.4, 0, 7); g.fill(); };
  // a dial: v from v0 to v1 over the sweep from a0 (radians, 0 = 3 o'clock, clockwise)
  const scale = (cx, cy, R, { v0, v1, a0, a1, major, minor, label = (v) => v, num = 0.62, bands = [], val, title, sub }) => {
    const at = (v) => a0 + (a1 - a0) * ((v - v0) / (v1 - v0));
    for (const [b0, b1, col, rr = 0.86, w = 0.09] of bands) arc(cx, cy, R * rr, at(b0), at(b1), R * w, col);
    ticks(cx, cy, R * 0.8, R * 0.95, a0, a1, Math.round((v1 - v0) / minor), R * 0.025);
    ticks(cx, cy, R * 0.72, R * 0.95, a0, a1, Math.round((v1 - v0) / major), R * 0.045);
    for (let v = v0; v <= v1 + 1e-6; v += major) { const a = at(v); txt(g, String(label(v)), cx + Math.cos(a) * R * num, cy + Math.sin(a) * R * num, R * 0.2); }
    if (title) txt(g, title, cx, cy + R * 0.28, R * 0.13); if (sub) txt(g, sub, cx, cy + R * 0.45, R * 0.1, '#c8c8c0', 'center', 'normal');
    if (val != null) needle(cx, cy, at(val), R * 0.82, R * 0.07);
  };
  const T = -Math.PI / 2;
  for (const q of GAUGES) {
    const cx = pX(q.x), cy = pY(q.y), R = q.r * pS;
    // mounting screws round the bezel, the black face and its rim
    for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + (i * Math.PI) / 2, rr = R + 0.0085 * pS; screw(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R > 60 ? 6 : 4.5); }
    g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    switch (q.k) {
      case 'asi': case 'vsi': case 'tach': case 'map': case 'g': scale(cx, cy, R, DIAL[q.k]); break; // (their needles are live: bubbleInterior)
      case 'ai': {
        g.save(); g.beginPath(); g.arc(cx, cy, R * 0.97, 0, 7); g.clip(); g.translate(cx, cy); g.rotate(-0.08);
        g.fillStyle = '#2f7cc8'; g.fillRect(-R, -R, 2 * R, R + R * 0.06); g.fillStyle = '#7a4f2a'; g.fillRect(-R, R * 0.06, 2 * R, R);
        g.strokeStyle = '#f4f4f0'; g.lineWidth = R * 0.04; g.beginPath(); g.moveTo(-R, R * 0.06); g.lineTo(R, R * 0.06); g.stroke();
        g.lineWidth = R * 0.025; for (const [dy, w] of [[-0.18, 0.18], [-0.36, 0.32], [0.3, 0.18], [0.48, 0.32]]) { g.beginPath(); g.moveTo(-R * w, R * (0.06 + dy)); g.lineTo(R * w, R * (0.06 + dy)); g.stroke(); }
        g.restore();
        ticks(cx, cy, R * 0.8, R * 0.97, T - Math.PI / 3, T + Math.PI / 3, 6, R * 0.035); ticks(cx, cy, R * 0.86, R * 0.97, T - Math.PI / 9, T + Math.PI / 9, 4, R * 0.025);
        g.fillStyle = '#f29a1f'; g.beginPath(); g.moveTo(cx, cy - R * 0.78); g.lineTo(cx - R * 0.07, cy - R * 0.64); g.lineTo(cx + R * 0.07, cy - R * 0.64); g.fill();
        g.strokeStyle = '#f29a1f'; g.lineWidth = R * 0.07; g.beginPath(); g.moveTo(cx - R * 0.55, cy); g.lineTo(cx - R * 0.2, cy); g.lineTo(cx - R * 0.1, cy + R * 0.1); g.moveTo(cx + R * 0.55, cy); g.lineTo(cx + R * 0.2, cy); g.lineTo(cx + R * 0.1, cy + R * 0.1); g.stroke();
        g.fillStyle = '#f29a1f'; g.beginPath(); g.arc(cx, cy, R * 0.05, 0, 7); g.fill(); break;
      }
      case 'alt': {
        scale(cx, cy, R, { v0: 0, v1: 10, a0: T, a1: T + 2 * Math.PI - 1e-3, major: 1, minor: 0.2, label: (v) => (v < 10 ? v : ''), num: 0.64, title: 'ALT', sub: '1000 FT' });
        g.fillStyle = '#1b1c1f'; g.fillRect(cx + R * 0.32, cy - R * 0.1, R * 0.42, R * 0.2); txt(g, '29.92', cx + R * 0.53, cy, R * 0.13, '#f2f2ee'); break;
      }
      case 'tc': {
        ticks(cx, cy, R * 0.76, R * 0.95, Math.PI - 0.26, Math.PI, 1, R * 0.05); ticks(cx, cy, R * 0.76, R * 0.95, 0, 0.26, 1, R * 0.05);
        txt(g, 'L', cx - R * 0.62, cy + R * 0.32, R * 0.18); txt(g, 'R', cx + R * 0.62, cy + R * 0.32, R * 0.18);
        txt(g, 'TURN COORDINATOR', cx, cy - R * 0.55, R * 0.1); txt(g, '2 MIN', cx, cy - R * 0.4, R * 0.1);
        arc(cx, cy - R * 0.2, R * 0.82, Math.PI * 0.36, Math.PI * 0.64, R * 0.13, '#b9b5a6'); // (the inclinometer's tube, its fluid pale; the little aeroplane and the black ball are live)
        g.strokeStyle = '#f4f4f0'; g.lineWidth = R * 0.02; for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(cx + sx * R * 0.09, cy + R * 0.52); g.lineTo(cx + sx * R * 0.09, cy + R * 0.72); g.stroke(); }
        break;
      }
      case 'dg': {
        g.save(); g.translate(cx, cy); // (north up: the live card turns a copy of it; the aeroplane and lubber line are live too)
        const L = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
        ticks(0, 0, R * 0.84, R * 0.96, 0, 2 * Math.PI, 72, R * 0.02); ticks(0, 0, R * 0.76, R * 0.96, 0, 2 * Math.PI, 36, R * 0.03);
        for (let i = 0; i < 12; i++) { g.save(); g.rotate((i / 12) * 2 * Math.PI); txt(g, L[i], 0, -R * 0.62, R * (L[i].length > 1 ? 0.16 : 0.2)); g.restore(); }
        g.restore(); break;
      }
      case 'xpdr': {
        g.fillStyle = '#18191c'; g.beginPath(); g.arc(cx, cy, R * 0.98, 0, 7); g.fill();
        const r0 = [cx - R * 0.62, cy - R * 0.35, R * 1.24, R * 0.5]; g.fillStyle = '#16301e'; g.fillRect(...r0); e.fillStyle = '#16301e'; e.fillRect(...r0);
        for (const ctx of [g, e]) { txt(ctx, '1200', cx, cy - R * 0.1, R * 0.36, '#7cf29a'); txt(ctx, 'ALT', cx, cy + R * 0.3, R * 0.16, '#d8d8d0'); }
        for (const sx of [-1, 1]) { g.fillStyle = '#55595f'; g.beginPath(); g.arc(cx + sx * R * 0.42, cy + R * 0.62, R * 0.12, 0, 7); g.fill(); }
        break;
      }
      default: { // the small engine gauges: a 100 degree arc over the top
        const lab = { oilT: 'OIL °F', oilP: 'OIL PSI', cht: 'CHT', fuelL: 'FUEL L', fuelR: 'FUEL R', amp: 'AMPS' }[q.k];
        const a0 = SMALL.a0, a1 = SMALL.a1, at = (v) => a0 + (a1 - a0) * v;
        const bands = q.k.startsWith('fuel') ? [[0, 0.12, '#e0412b'], [0.12, 1, '#2fa84f']] : q.k === 'amp' ? [[0.3, 0.8, '#2fa84f']] : [[0, 0.15, '#f2c300'], [0.15, 0.8, '#2fa84f'], [0.8, 0.95, '#f2c300'], [0.95, 1, '#e0412b']];
        for (const [b0, b1, col] of bands) arc(cx, cy + R * 0.25, R * 0.78, at(b0), at(b1), R * 0.12, col);
        ticks(cx, cy + R * 0.25, R * 0.62, R * 0.9, a0, a1, 4, R * 0.05);
        txt(g, lab, cx, cy + R * 0.5, R * 0.24); // (needle: live)
        if (q.k.startsWith('fuel')) { txt(g, 'E', cx - R * 0.62, cy - R * 0.25, R * 0.2); txt(g, 'F', cx + R * 0.62, cy - R * 0.25, R * 0.2); }
      }
    }
  }
  // the moving map: terrain, a lake, roads, the magenta course, range ring, the aircraft, data bars (and its glow)
  { const x0 = pX(SCREEN.x0), y0 = pY(SCREEN.y1), w = pX(SCREEN.x1) - x0, h = pY(SCREEN.y0) - y0;
    g.fillStyle = '#26282c'; g.fillRect(x0 - 22, y0 - 22, w + 44, h + 70); // bezel, soft keys under it
    for (let i = 0; i < 5; i++) { g.fillStyle = '#4a4e54'; g.fillRect(x0 + 10 + i * (w - 20) / 5, y0 + h + 18, (w - 20) / 5 - 14, 22); }
    for (let i = 0; i < 4; i++) { g.fillStyle = '#4a4e54'; g.fillRect(x0 + w + 4, y0 + 16 + i * 52, 14, 36); }
    for (const ctx of [g, e]) {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      ctx.fillStyle = '#3d6b3a'; ctx.fillRect(x0, y0, w, h);
      let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 70; i++) { ctx.fillStyle = ['#4f7d43', '#6b8a4a', '#8a8a56', '#a0915e', '#5d7a45'][i % 5]; ctx.beginPath(); ctx.ellipse(x0 + rnd() * w, y0 + rnd() * h, 20 + rnd() * 60, 14 + rnd() * 40, rnd() * 3, 0, 7); ctx.fill(); }
      ctx.fillStyle = '#2f6fb0'; ctx.beginPath(); ctx.ellipse(x0 + w * 0.26, y0 + h * 0.3, w * 0.12, h * 0.09, 0.4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#d8d8d0'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x0, y0 + h * 0.75); ctx.bezierCurveTo(x0 + w * 0.3, y0 + h * 0.6, x0 + w * 0.5, y0 + h * 0.85, x0 + w, y0 + h * 0.55); ctx.stroke();
      ctx.strokeStyle = '#f0f0e8'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x0 + w / 2, y0 + h * 0.8, h * 0.45, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.strokeStyle = '#e040e0'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x0 + w / 2, y0 + h * 0.8); ctx.lineTo(x0 + w * 0.72, y0 + h * 0.12); ctx.stroke();
      ctx.fillStyle = '#f8f8f8'; ctx.beginPath(); ctx.moveTo(x0 + w / 2, y0 + h * 0.72); ctx.lineTo(x0 + w / 2 - 14, y0 + h * 0.86); ctx.lineTo(x0 + w / 2 + 14, y0 + h * 0.86); ctx.fill();
      ctx.fillStyle = '#0a0b0c'; ctx.fillRect(x0, y0, w, 44); ctx.fillRect(x0, y0 + h - 36, w, 36);
      txt(ctx, 'GS 112KT', x0 + 12, y0 + 22, 26, '#f2f2ee', 'left'); txt(ctx, 'DTK 040°', x0 + w / 2, y0 + 22, 26, '#e040e0'); txt(ctx, 'ETE 0:14', x0 + w - 12, y0 + 22, 26, '#7cf29a', 'right');
      for (const [i, t] of ['MAP', 'WPT', 'AUX', 'NRST'].entries()) txt(ctx, t, x0 + (i + 0.5) * (w / 4), y0 + h - 18, 22, '#e8e8e2');
      ctx.restore();
    }
  }
  // the com radio (green displays glow), two knobs (geometry) at its right end
  { const x0 = pX(RADIO.x0), y0 = pY(RADIO.y1), w = pX(RADIO.x1) - x0, h = pY(RADIO.y0) - y0;
    g.fillStyle = '#161719'; g.fillRect(x0, y0, w, h); g.strokeStyle = '#55595f'; g.lineWidth = 3; g.strokeRect(x0 + 2, y0 + 2, w - 4, h - 4);
    const d = [x0 + 18, y0 + 18, w * 0.66, h - 36]; g.fillStyle = '#10261a'; g.fillRect(...d); e.fillStyle = '#10261a'; e.fillRect(...d);
    for (const ctx of [g, e]) { txt(ctx, '118.300', d[0] + d[2] * 0.27, y0 + h / 2, h * 0.36, '#7cf29a'); txt(ctx, '121.500', d[0] + d[2] * 0.75, y0 + h / 2, h * 0.3, '#5fc07a'); }
    txt(g, 'COM', x0 + w * 0.78, y0 + h * 0.22, h * 0.16, '#c8c8c0'); }
  // annunciator lights over the screen
  const dim = (c, k = 0.3) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
  ANN.forEach(([t, x, col], i) => { const cx = pX(x), cy = pY(0.128); g.fillStyle = '#1a1b1e'; g.fillRect(cx - 44, cy - 16, 88, 32); g.fillStyle = dim(col); g.fillRect(cx - 40, cy - 12, 80, 24); txt(g, t, cx, cy, 15, dim(col, 0.12));
    const [lx, ly] = ANN_LIT(i); for (const ctx of [g, e]) { ctx.fillStyle = col; ctx.fillRect(lx, ly, 80, 24); txt(ctx, t, lx + 40, ly + 12, 15, '#1a1b1e'); } }); // (lit: liveDisplays lamps over the dim ones)
  { const cx = pX(GEAR.x), cy = pY(GEAR.y), R = GEAR.r * pS; txt(g, 'GEAR', pX(GEAR.x - 0.03), cy, 14);
    for (const [dx, dy] of GEAR.at) { g.fillStyle = '#18191c'; g.beginPath(); g.arc(cx + dx * pS, cy - dy * pS, R + 4, 0, 7); g.fill(); g.fillStyle = '#16351f'; g.beginPath(); g.arc(cx + dx * pS, cy - dy * pS, R, 0, 7); g.fill(); } }
  // the toggles' and knobs' labels, the circuit breakers, the key switch's positions
  for (const s of TOGGLES) { const cx = pX(s.x), cy = pY(s.y); g.fillStyle = '#5e6268'; g.beginPath(); g.arc(cx, cy, 16, 0, 7); g.fill(); txt(g, s.t, cx, pY(s.y - 0.021), 17); txt(g, 'ON', cx, pY(s.y + 0.017), 13, '#c8c8c0', 'center', 'normal'); }
  for (const k of KNOBS) { const cx = pX(k.x), cy = pY(k.y); g.fillStyle = '#5e6268'; g.beginPath(); g.arc(cx, cy, 20, 0, 7); g.fill(); txt(g, k.t, cx, pY(k.y - 0.022), 18); }
  for (const b of BREAKERS) { const cx = pX(b.x), cy = pY(b.y); g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, 17, 0, 7); g.fill(); g.strokeStyle = '#b8bcc2'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 19, 0, 7); g.stroke(); txt(g, String(b.a), cx, pY(b.y - 0.019), 17); }
  txt(g, 'CIRCUIT BREAKERS', pX(0.207), pY(-0.075), 16, '#c8c8c0');
  { const cx = pX(KEY.x), cy = pY(KEY.y); g.fillStyle = '#18191c'; g.beginPath(); g.arc(cx, cy, 44, 0, 7); g.fill();
    for (const [t, a] of [['OFF', -2.3], ['R', -1.75], ['L', -1.25], ['BOTH', -0.7], ['START', -0.1]]) txt(g, t, cx + Math.cos(a) * 62, cy + Math.sin(a) * 58, 14); }
  // roughness: glass over every instrument, the screen and displays; lettering is paint
  r.fillStyle = 'rgb(0,28,0)'; for (const q of GAUGES) { r.beginPath(); r.arc(pX(q.x), pY(q.y), q.r * pS, 0, 7); r.fill(); }
  r.fillRect(pX(SCREEN.x0), pY(SCREEN.y1), pX(SCREEN.x1) - pX(SCREEN.x0), pY(SCREEN.y0) - pY(SCREEN.y1)); r.fillStyle = 'rgb(0,60,0)'; r.fillRect(pX(RADIO.x0), pY(RADIO.y1), pX(RADIO.x1) - pX(RADIO.x0), pY(RADIO.y0) - pY(RADIO.y1));
  { const img = r.getImageData(0, 0, TW, PH), d = img.data; let sd = 99; for (let i = 0; i < d.length; i += 4) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + (((sd >> 16) & 31) - 15))); } r.putImageData(img, 0, 0); }
  // baked occlusion: the glareshield's shadow down the top of the panel, a soft dark ring round every bezel and inside
  // every instrument's rim (the faces sit back in the panel), shadows round the screen, radio, knobs and switches
  { const zt = -0.534, kk = dk(zt), w = A * kk - 0.018, h = 0.134 * kk, topL = (x) => (h * Math.sqrt(Math.max(0, 1 - (x / w) ** 2)) - 0.009 + 0.065) / Math.cos(0.2);
    for (let px = 0; px < TW; px += 4) { const x = PX0 + (px / TW) * (PX1 - PX0), y0 = Math.max(0, pY(Math.max(0.05, topL(x)))) - 4, gr = g.createLinearGradient(0, y0, 0, y0 + 150); gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.35, 'rgba(0,0,0,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(px, y0, 4, 150); } }
  const ring = (cx, cy, r0, r1, a) => { const gr = g.createRadialGradient(cx, cy, r0, cx, cy, r1); gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r1, 0, 7); g.arc(cx, cy, r0, 0, 7, true); g.fill(); };
  for (const q of GAUGES) { const cx = pX(q.x), cy = pY(q.y), R = q.r * pS; ring(cx, cy, R + 0.004 * pS, R + 0.013 * pS, 0.5);
    const gr = g.createRadialGradient(cx, cy - R * 0.1, R * 0.7, cx, cy, R); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.75)'); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    if (q.k !== 'dg') { g.fillStyle = 'rgba(255,255,255,0.07)'; g.beginPath(); g.ellipse(cx - R * 0.3, cy - R * 0.4, R * 0.45, R * 0.18, -0.5, 0, 7); g.fill(); } } // (a glint on the glass; not on the heading card, which turns)
  for (const R of [SCREEN, RADIO]) { const x0 = pX(R.x0) - 30, y0 = pY(R.y1) - 30, w = pX(R.x1) - pX(R.x0) + 60, hh = pY(R.y0) - pY(R.y1) + (R === SCREEN ? 110 : 60); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 16; g.strokeRect(x0 - 4, y0 - 4, w + 8, hh + 8); }
  for (const k of [...KNOBS, ...TOGGLES.map((t) => ({ ...t, small: 1 })), { ...KEY, big: 1 }]) { const cx = pX(k.x), cy = pY(k.y), R0 = k.big ? 46 : k.small ? 16 : 22;
    ring(cx, cy + 6, R0, R0 + 26, 0.45);
    let sd = Math.round(cx * 7 + cy); for (let i = 0; i < 40; i++) { sd = (sd * 16807) % 2147483647; const a = (sd % 628) / 100, rr = R0 + 4 + ((sd >> 8) % 30); g.fillStyle = 'rgba(200,204,210,0.10)'; g.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3, 2); } } // (fingers have worn the paint round them)
  // the sub-panels' seams (a dark gap, a lit edge) and their screws; the bottom edge rubbed lighter by knees and hands
  for (const x of [-0.085, 0.103]) { g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(pX(x) - 3, 0, 5, PH); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(pX(x) + 2, 0, 2, PH); }
  for (const x of [-0.355, -0.1, -0.07, 0.088, 0.118, 0.345]) for (const y of [-0.138, 0.06]) if (!(Math.abs(x) > 0.3 && y > 0.05)) screw(pX(x), pY(y), 6);
  { const gr = g.createLinearGradient(0, PH - 40, 0, PH); gr.addColorStop(0, 'rgba(210,214,220,0)'); gr.addColorStop(1, 'rgba(210,214,220,0.16)'); g.fillStyle = gr; g.fillRect(0, PH - 40, TW, 40); }
  // the placard every amateur-built aircraft carries in the cockpit
  { const cx = pX(0.009), cy = pY(0.151); g.fillStyle = '#d9d6cc'; g.fillRect(cx - 120, cy - 15, 240, 30); txt(g, 'EXPERIMENTAL', cx, cy + 1, 22, '#16171a'); r.fillStyle = 'rgb(0,90,0)'; r.fillRect(cx - 120, cy - 15, 240, 30); }
  // atlas cells: solid colours, the compass card (the band you see through its window), the fuel selector and
  // trim placards, the throttle quadrant's plate
  const fill = (i, col, w = 1) => { const [x0, y0, x1, y1] = cellRect(i, w); g.fillStyle = col; g.fillRect(x0 - 6, y0 - 8, x1 - x0 + 12, y1 - y0 + 14); };
  { const [x0, y0, x1, y1] = cellRect(CELLS.lamp); for (const ctx of [g, e]) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x0 - 6, y0 - 8, x1 - x0 + 12, y1 - y0 + 14); } }
  fill(CELLS.red, '#c41e1e'); fill(CELLS.blue, '#1f4fa8'); fill(CELLS.white, '#e8e8e4'); fill(CELLS.yellow, '#f2c300'); fill(CELLS.black, '#151618'); fill(CELLS.green, '#2e7d32'); fill(CELLS.chrome, '#c9ccd1');
  { const [x0, y0, x1, y1] = cellRect(CELLS.compass), w = x1 - x0, h = y1 - y0; g.fillStyle = '#0c0c0d'; g.fillRect(x0, y0, w, h);
    g.fillStyle = '#f2f2ee'; g.fillRect(x0 + 4, y0 + h * 0.3, w - 8, h * 0.42); for (const [t, f] of [['33', 0.15], ['N', 0.5], ['3', 0.85]]) txt(g, t, x0 + w * f, y0 + h * 0.52, 22, '#111');
    g.fillStyle = '#e0412b'; g.fillRect(x0 + w / 2 - 2, y0 + h * 0.18, 4, h * 0.64); }
  { const [x0, y0, x1, y1] = cellRect(CELLS.fuel), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = (x1 - x0) / 2; g.fillStyle = '#c41e1e'; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.fillStyle = '#151618'; g.beginPath(); g.arc(cx, cy, r * 0.88, 0, 7); g.fill();
    txt(g, 'L', cx - r * 0.58, cy, 22); txt(g, 'R', cx + r * 0.58, cy, 22); txt(g, 'OFF', cx, cy + r * 0.6, 16, '#e0412b'); txt(g, 'FUEL', cx, cy - r * 0.6, 14); }
  { const [x0, y0, x1, y1] = cellRect(CELLS.trim), w = x1 - x0, h = y1 - y0; g.fillStyle = '#151618'; g.fillRect(x0, y0, w, h); txt(g, 'NOSE DN', x0 + w / 2, y0 + 12, 13); txt(g, 'UP', x0 + w / 2, y1 - 12, 13);
    ticks(x0 + w * 0.3, y0 + h / 2, 0, w * 0.35, -0.0001, 0, 0, 1); g.fillStyle = '#e8e8e4'; for (let i = 0; i < 7; i++) g.fillRect(x0 + w * 0.3, y0 + 24 + i * (h - 48) / 6, w * 0.4, 2); g.fillStyle = '#f2c300'; g.fillRect(x0 + w * 0.22, y0 + h * 0.55, w * 0.56, 6); }
  { const [x0, y0, x1, y1] = cellRect(CELLS.quad, 3), w = x1 - x0, h = y1 - y0; g.fillStyle = '#2b2d31'; g.fillRect(x0, y0, w, h); g.fillStyle = '#060607'; g.fillRect(x0 + w * 0.08, y0 + h * 0.42, w * 0.84, h * 0.16);
    txt(g, 'THROTTLE', x0 + w * 0.42, y0 + h * 0.2, 18); txt(g, 'OPEN ►', x0 + w * 0.84, y0 + h * 0.2, 18); txt(g, '◄ IDLE', x0 + w * 0.16, y0 + h * 0.8, 15, '#c8c8c0'); txt(g, 'FRICTION', x0 + w * 0.7, y0 + h * 0.8, 13, '#c8c8c0', 'center', 'normal'); }
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const rt = new THREE.CanvasTexture(rv); rt.anisotropy = 4;
  return { map: tex(cv), glow: tex(gv), rough: rt };
}
const atlas = () => mat('atlas', () => { const { map, glow, rough } = panelTextures(); return new THREE.MeshStandardMaterial({ map, emissiveMap: glow, roughnessMap: rough, emissive: 0xffffff, emissiveIntensity: 0.75, metalness: 0.1, roughness: 1 }); });
// geometry coloured by one atlas cell (all its uvs at the cell's centre), or mapped onto it (its own 0..1 uvs)
const solid = (geo, cell) => { const { u0, u1, v0, v1 } = cellUV(cell), u = (u0 + u1) / 2, v = (v0 + v1) / 2, a = geo.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u, v); return geo; };
const onCell = (geo, cell, w = 1) => { const { u0, u1, v0, v1 } = cellUV(cell, w), a = geo.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u0 + a.getX(i) * (u1 - u0), v0 + a.getY(i) * (v1 - v0)); return geo; };

// ---------- small shapes ----------
// a rounded box whose faces bulge a little (an upholstered cushion), centred on the origin; few segments
function cushion(w, h, d, r, bulge, seg = [6, 3, 6]) {
  const g = new THREE.BoxGeometry(w, h, d, ...seg), p = g.attributes.position, hw = w / 2, hh = h / 2, hd = d / 2, q = V(), c = V();
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i); c.set(THREE.MathUtils.clamp(q.x, -hw + r, hw - r), THREE.MathUtils.clamp(q.y, -hh + r, hh - r), THREE.MathUtils.clamp(q.z, -hd + r, hd - r));
    const n = q.clone().sub(c), L = n.length() || 1; n.divideScalar(L); q.copy(c).addScaledVector(n, r);
    const ux = q.x / hw, uy = q.y / hh, uz = q.z / hd; q.addScaledVector(n, bulge * Math.max(0, 1 - ux * ux) * Math.max(0, 1 - uy * uy) * Math.max(0, 1 - uz * uz) * 4);
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.deleteAttribute('normal'); g.deleteAttribute('uv'); const m = mergeVertices(g, 1e-5); m.computeVertexNormals(); return m;
}
// a flat strap (webbing) along points, lying on a surface whose outward normal is n (one for the whole run)
function strap(pts, n, w = 0.036, t = 0.003) {
  const pos = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const d = pts[Math.min(pts.length - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize(), s = d.clone().cross(n).normalize().multiplyScalar(w / 2);
    for (const [a, b] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) { const p = pts[i].clone().addScaledVector(s, a).addScaledVector(n, b * t); pos.push(p.x, p.y, p.z); }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < 4; k++) { const a = i * 4 + k, b = i * 4 + ((k + 1) % 4), c = b + 4, d = a + 4; idx.push(a, c, b, a, d, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// a grid of points (rows x cols) as a surface; flipped if its normal at the middle points away from `toward`
function grid(P, toward) {
  const R = P.length, Cc = P[0].length, pos = [], idx = [];
  for (const r of P) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < Cc - 1; j++) { const a = i * Cc + j, b = a + 1, c = a + Cc + 1, d = a + Cc; idx.push(a, b, c, a, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const i0 = Math.floor((R - 1) / 2), j0 = Math.floor((Cc - 1) / 2), a = P[i0][j0], b = P[i0][j0 + 1], c = P[i0 + 1][j0 + 1];
  if (toward && b.clone().sub(a).cross(c.clone().sub(a)).dot(toward(a)) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.setIndex(idx); g.computeVertexNormals(); return g;
}

// ---------- the walls the canopy's tub ended up with ----------
// rings: skinBlend's tub rings (top first) in the cockpit's frame. x(s, y, z): the wall's distance from the centre line
// on side s at that height (the wall goes straight up above the top ring); top(s, z): the top ring's height there.
function tubWalls(rings) {
  const side = (s) => rings.map((r) => r.filter((p) => p.x * s > 0.02).map((p) => [p.z, Math.abs(p.x), p.y]).sort((a, b) => a[0] - b[0]));
  const S = { 1: side(1), [-1]: side(-1) };
  // the tub's floor: a fan from the bottom ring's centroid to its points (ringLoft's cap)
  const R2 = rings.at(-1), cF = R2.reduce((s, p) => s.add(p), V()).multiplyScalar(1 / R2.length);
  const atZ = (L, z) => {
    if (!L.length) return null; if (z <= L[0][0]) return L[0]; if (z >= L.at(-1)[0]) return L.at(-1);
    for (let i = 1; i < L.length; i++) if (L[i][0] >= z) { const a = L[i - 1], b = L[i], t = (z - a[0]) / (b[0] - a[0] || 1); return [z, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    return L.at(-1);
  };
  return {
    top: (s, z) => atZ(S[s][0], z)?.[2] ?? 0,
    floor(x, z) { // its height under (x, z), or -Infinity outside it
      for (let i = 0; i < R2.length; i++) {
        const a = R2[i], b = R2[(i + 1) % R2.length], d = (b.z - cF.z) * (a.x - cF.x) - (b.x - cF.x) * (a.z - cF.z); if (Math.abs(d) < 1e-9) continue;
        const u = ((b.z - cF.z) * (x - cF.x) - (b.x - cF.x) * (z - cF.z)) / d, v = ((cF.z - a.z) * (x - cF.x) + (a.x - cF.x) * (z - cF.z)) / d;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return cF.y + u * (a.y - cF.y) + v * (b.y - cF.y);
      }
      return -Infinity;
    },
    x(s, y, z) {
      const P = S[s].map((L) => atZ(L, z)).filter(Boolean); if (!P.length) return A * dk(z);
      if (y >= P[0][2]) return P[0][1];
      for (let k = 1; k < P.length; k++) if (y >= P[k][2]) { const t = (y - P[k][2]) / (P[k - 1][2] - P[k][2] || 1); return P[k][1] + (P[k - 1][1] - P[k][1]) * t; }
      return P.at(-1)[1];
    },
  };
}

// ---------- the cockpit ----------
// g: the cockpit group (the glass, its skirt and bows are partDetail's), b / nb: its bags (nb: small near-only
// fittings), lv: detail level (2 own aircraft and hangar, 1 traffic)
export function bubbleInterior(g, b, nb, lv = 2) {
  const hi = lv >= 2, AT = atlas(), LT = leather();
  // ---- glareshield: a low black hood following the canopy's base from the windscreen back to the panel (half-width
  // 1.8 cm inside the glass, 13.4 cm high at the middle, its sides going on down to below the sill), shelled, with a
  // padded roll along its edge over the panel
  const GZ0 = -0.975, GZ1 = -0.51, gw = (z) => A * dk(z) - 0.018, gh = (z) => 0.134 * dk(z);
  { const rows = [];
    for (let j = 0; j <= 10; j++) {
      const z = GZ0 + (GZ1 - GZ0) * (j / 10) ** 0.7, w = gw(z), h = gh(z), r = [V(w, -0.06, z)];
      for (let i = 0; i <= 16; i++) { const al = Math.PI * (i / 16); r.push(V(Math.cos(al) * w, Math.sin(al) * h, z)); }
      r.push(V(-w, -0.06, z)); rows.push(r);
    }
    b.add(shell(grid(rows, (p) => V(p.x * 0.2, 1, 0)), 0.006), coaming());
    const lip = [V(gw(GZ1) - 0.002, -0.06, GZ1 + 0.004)];
    for (let i = 0; i <= 20; i++) { const al = Math.PI * (i / 20); lip.push(V(Math.cos(al) * (gw(GZ1) - 0.002), Math.sin(al) * gh(GZ1) + 0.002, GZ1 + 0.004)); }
    lip.push(V(-(gw(GZ1) - 0.002), -0.06, GZ1 + 0.004));
    b.add(pipe(lip, 0.011, 6, hi ? 40 : 24), LT); // (leather padded roll)
  }
  // ---- the instrument panel, tilted back 0.2 rad, its arched top tucked under the glareshield's edge
  const pf = mx([0, -0.065, -0.5], [-0.2, 0, 0]), P = (m) => pf.clone().multiply(m);
  { const zt = -0.534, w = gw(zt), h = gh(zt), topY = (x) => (h * Math.sqrt(Math.max(0, 1 - (x / w) ** 2)) - 0.009 + 0.065) / Math.cos(0.2);
    const sh = new THREE.Shape(); sh.moveTo(-0.285, -0.15); sh.lineTo(0.285, -0.15); sh.lineTo(0.33, -0.02); sh.lineTo(0.355, 0.05);
    for (let i = 0; i <= 24; i++) { const x = 0.355 - 0.71 * (i / 24); sh.lineTo(x, Math.max(0.05, topY(x))); }
    sh.lineTo(-0.33, -0.02); sh.closePath();
    const face = new THREE.ShapeGeometry(sh, 4), uv = face.attributes.uv, pp = face.attributes.position;
    for (let i = 0; i < pp.count; i++) uv.setXY(i, ...panelUV(pp.getX(i), pp.getY(i)));
    face.translate(0, 0, 0.004); face.applyMatrix4(pf); b.add(face, AT);
    const back = new THREE.ExtrudeGeometry(sh, { depth: 0.014, bevelEnabled: false, curveSegments: 4 }); back.translate(0, 0, -0.0105); back.applyMatrix4(pf); b.add(back, interior());
  }
  // bezels standing off the panel round every instrument, the screen's and radio's frames
  if (hi) {
    for (const q of GAUGES) {
      const ring = new THREE.RingGeometry(q.r - 0.0005, q.r + 0.0045, 24, 1); ring.translate(q.x, q.y, 0.0085); nb.add(ring.applyMatrix4(pf), black());
      const wall = new THREE.CylinderGeometry(q.r + 0.0045, q.r + 0.0045, 0.0045, 24, 1, true); wall.rotateX(Math.PI / 2); wall.translate(q.x, q.y, 0.0063); nb.add(wall.applyMatrix4(pf), black());
    }
    for (const [R, dx, dy] of [[SCREEN, 0.008, 0.008], [RADIO, 0.002, 0.002]]) {
      const x0 = R.x0 - dx, x1 = R.x1 + dx, y0 = R.y0 - dy - (R === SCREEN ? 0.016 : 0), y1 = R.y1 + dy, t = 0.006;
      for (const [cx, cy, w, h] of [[(x0 + x1) / 2, y1, x1 - x0 + t, t], [(x0 + x1) / 2, y0, x1 - x0 + t, t], [x0, (y0 + y1) / 2, t, y1 - y0], [x1, (y0 + y1) / 2, t, y1 - y0]]) { const fr = new THREE.BoxGeometry(w, h, 0.008); fr.translate(cx, cy, 0.008); nb.add(fr.applyMatrix4(pf), black()); }
    }
    // toggles: a nut and a bat lever thrown up (ON); the push-pull knobs on their shafts; the radio's twin knobs; the key
    for (const s of TOGGLES) {
      const nut = new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 6); nut.rotateX(Math.PI / 2); nut.translate(s.x, s.y, 0.007); nb.add(nut.applyMatrix4(pf), M.chrome());
      nb.add(bar(V(s.x, s.y, 0.008), V(s.x, s.y + 0.007, 0.024), 0.0032, 0.0032, true, 5).applyMatrix4(pf), M.chrome());
    }
    for (const k of KNOBS) {
      nb.add(bar(V(k.x, k.y, 0.004), V(k.x, k.y, 0.022), 0.006, 0.006, true, 6).applyMatrix4(pf), M.steel());
      const kn = new THREE.CylinderGeometry(0.011, 0.0105, 0.014, 12); kn.rotateX(Math.PI / 2); kn.translate(k.x, k.y, 0.029); nb.add(solid(kn, CELLS[k.c]).applyMatrix4(pf), AT);
    }
    for (const [r, l] of [[0.0085, 0.01], [0.0055, 0.018]]) { const kn = new THREE.CylinderGeometry(r, r, l, 12); kn.rotateX(Math.PI / 2); kn.translate(RADIO.x1 - 0.016, (RADIO.y0 + RADIO.y1) / 2, 0.004 + l / 2); nb.add(kn.applyMatrix4(pf), black()); }
    { const ks = new THREE.CylinderGeometry(0.0085, 0.0085, 0.008, 12); ks.rotateX(Math.PI / 2); ks.translate(KEY.x, KEY.y, 0.008); nb.add(ks.applyMatrix4(pf), M.chrome());
      const bow = new THREE.BoxGeometry(0.013, 0.02, 0.003); bow.translate(KEY.x, KEY.y + 0.004, 0.02); nb.add(bow.applyMatrix4(pf), M.steel()); }
    // the compass on top of the glareshield: its housing, a mounting foot, the card seen through its window
    { const z = -0.645, y = gh(z) + 0.027, hs = new THREE.CylinderGeometry(0.022, 0.024, 0.04, 14); hs.rotateX(Math.PI / 2); hs.translate(0, y, z); nb.add(hs, black());
      const ft = new THREE.BoxGeometry(0.03, 0.012, 0.03); ft.translate(0, gh(z) + 0.004, z); nb.add(ft, black());
      const win = new THREE.PlaneGeometry(0.03, 0.02); onCell(win, CELLS.compass); win.translate(0, y, z + 0.0205); nb.add(win, AT); }
  }
  // ---- the live instruments (liveDisplays.js): needles, the attitude ball, the heading card, the turn coordinator's
  // aeroplane and ball, the annunciators and the gear lights, over their painted faces (own aircraft and the hangar)
  if (hi) {
    const mid = (c) => [(c.u0 + c.u1) / 2, (c.v0 + c.v1) / 2], lp = new LivePanel(AT, { white: mid(cellUV(CELLS.white)), lamp: mid(cellUV(CELLS.lamp)) });
    const F = (x, y) => P(mx([x, y, 0.004])), Q = Object.fromEntries(GAUGES.map((q) => [q.k, q])); // (a face's frame: on the panel's face)
    const dial = (k, src, o = {}) => { const q = Q[k], D = DIAL[k]; return lp.needle(F(q.x, q.y), { src, at: sweep(D.v0, D.v1, D.a0, D.a1), len: q.r * 0.82, w: q.r * 0.075, hub: 2.6, hubCol: '#202124', ...o }); };
    dial('asi', 'kt'); dial('vsi', (S) => S.vs / 100, { damp: 4 }); dial('tach', (S) => S.rpm / 100, { damp: 8 }); dial('map', 'map', { damp: 8 });
    for (const k of ['gMin', 'gMax']) dial('g', k, { color: '#f29a1f', w: Q.g.r * 0.05, len: Q.g.r * 0.78, hub: 0, z: 0.0007, damp: 20 }); // (the g meter's drag needles stay at the extremes)
    dial('g', 'g', { damp: 10 });
    { const q = Q.alt, f = F(q.x, q.y), R = q.r; // two hands: thousands, hundreds
      lp.needle(f, { src: 'alt', at: (ft) => T0 + 2 * Math.PI * (ft / 10000), len: R * 0.5, w: R * 0.12, tail: 0.15, hub: 0, damp: 9 });
      lp.needle(f, { src: 'alt', at: (ft) => T0 + 2 * Math.PI * (ft / 1000), len: R * 0.85, w: R * 0.07, z: 0.0016, hub: 2.4, hubCol: '#202124', damp: 9 }); }
    lp.attitude(F(Q.ai.x, Q.ai.y), Q.ai.r, { sky: '#2f7cc8', ground: '#7a4f2a', symbol: '#f29a1f' });
    { const q = Q.tc, f = F(q.x, q.y), R = q.r, wc = color('#f4f4f0'), uv = lp.white, z = 0.0012; // the aeroplane banks with the rate of turn (2 min: the index), the ball with the slip
      const ac = new Shape().bar(-R * 0.66, 0, R * 0.66, 0, R * 0.07, z, wc, uv).bar(0, R * 0.05, 0, R * 0.25, R * 0.04, z, wc, uv).disc(0, 0, R * 0.1, z + 0.0002, wc, uv, 12);
      lp.part(f, ac, { src: 'turn', xf: (t) => Math.max(-0.5, Math.min(0.5, (t / 3) * 0.26)), w: 6 });
      lp.part(f, new Shape().disc(0, -R * 0.82, R * 0.065, 0.0006, color('#050506'), uv, 12), { src: 'slip', xf: (sl) => Math.max(-0.42, Math.min(0.42, -sl * 1.2)), pivot: [0, R * 0.2], w: 5 }); }
    { const q = Q.dg, f = F(q.x, q.y), R = q.r, wc = color('#f4f4f0'), uv = lp.white, z = 0.0012; // the card turns under a fixed aeroplane and lubber line
      lp.part(f, new Shape().card(R * 0.975, 0.0004, (x, y) => panelUV(q.x + x, q.y + y)), { src: 'hdg', xf: (h) => -h, wrap: true, w: 6 });
      const plane = [[0, -0.32], [0.05, -0.05], [0.32, 0.04], [0.32, 0.1], [0.05, 0.08], [0.04, 0.24], [0.13, 0.3], [-0.13, 0.3], [-0.04, 0.24], [-0.05, 0.08], [-0.32, 0.1], [-0.32, 0.04], [-0.05, -0.05]].map(([x, y]) => [x * R, -y * R]);
      const sym = new Shape().outline(plane, z, wc, uv)
        .poly([[0, R * 0.97], [-R * 0.07, R * 0.83], [R * 0.07, R * 0.83]], z, color('#f29a1f'), uv);
      lp.part(f, sym); }
    for (const k of Object.keys(SMALL.src)) { const q = Q[k]; lp.needle(F(q.x, q.y), { src: SMALL.src[k], at: (v) => SMALL.a0 + (SMALL.a1 - SMALL.a0) * Math.max(-0.03, Math.min(1.03, v)), len: q.r * 0.78, w: q.r * 0.09, pivot: [0, -q.r * 0.25], hub: 2.8, hubCol: '#202124', damp: 6 }); }
    ANN.forEach(([, x, , src], i) => { const [lx, ly] = ANN_LIT(i); lp.lamp(F(x, 0.128), { src, w: 80 / pS, h: 24 / pS, uv: [lx / TW, 1 - (ly + 24) / TH, (lx + 80) / TW, 1 - ly / TH] }); });
    for (const [dx, dy] of GEAR.at) lp.lamp(F(GEAR.x + dx, GEAR.y + dy), { src: 'gearDown', r: GEAR.r, color: '#3cdc5a' });
    lp.to(g);
  }
  // ---- side consoles along the walls at hip height (their outer faces are pressed onto the tub's walls once the
  // canopy is seated: userData.tubFit), the throttle quadrant on the left (the crew's throttle box sits on it)
  const hug = new Bag(), CON = { x0: 0.28, top: -0.385, z0: -0.3, z1: 0.46 };
  for (const s of [-1, 1]) {
    const sh = new THREE.Shape(); sh.moveTo(CON.x0, CON.top - 0.006); sh.lineTo(CON.x0 + 0.006, CON.top); sh.lineTo(0.47, CON.top); sh.lineTo(0.47, -0.53); sh.lineTo(CON.x0, -0.45); sh.closePath();
    const con = new THREE.ExtrudeGeometry(sh, { depth: CON.z1 - CON.z0, bevelEnabled: false, curveSegments: 1 }); con.translate(0, 0, CON.z0); if (s < 0) { con.scale(-1, 1, 1); flipWinding(con); }
    hug.add(con, interior());
    b.add(pipe([V(s * (CON.x0 + 0.004), CON.top - 0.003, CON.z0 + 0.01), V(s * (CON.x0 + 0.004), CON.top - 0.003, CON.z1)], 0.0085, 6, 2), LT); // leather welt along its edge
    if (s > 0) { const arm = cushion(0.11, 0.03, 0.4, 0.012, 0.004); arm.translate(0.345, CON.top + 0.016, 0.26); hug.add(arm, LT); } // padded armrest
  }
  { const n0 = g.children.length; hug.to(g); g.userData.hug = g.children.slice(n0); }
  // the firewall closing the footwell under the panel (pressed onto the walls like the consoles), two heater outlets
  { const rows = []; for (let i = 0; i <= 5; i++) { const y = -0.73 + 0.64 * (i / 5), r = []; for (const x of [-0.47, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.47]) r.push(V(x, y, -0.565)); rows.push(r); }
    const fw = new Bag(); fw.add(grid(rows, () => V(0, 0, 1)), carpet()); /* (an insulation blanket) */ const n0 = g.children.length; fw.to(g); for (const m of g.children.slice(n0)) { m.userData.hugMin = 0; g.userData.hug.push(m); }
    if (hi) for (const sx of [-1, 1]) { const v = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 14, 1, true); v.rotateX(Math.PI / 2); v.translate(sx * 0.17, -0.3, -0.55); nb.add(v, black()); const c = new THREE.CircleGeometry(0.02, 14); c.translate(sx * 0.17, -0.3, -0.555); nb.add(c, matte()); }
    if (hi) { // hoses and a cable loom coming through it (to the panel's back and the heater outlets)
      for (const sx of [-1, 1]) nb.add(pipe([V(sx * 0.17, -0.3, -0.55), V(sx * 0.2, -0.42, -0.555), V(sx * 0.12, -0.6, -0.556), V(sx * 0.06, -0.66, -0.552)], 0.011, 6, 16), M.rubber());
      nb.add(pipe([V(-0.05, -0.2, -0.556), V(-0.02, -0.35, -0.558), V(0.03, -0.5, -0.558), V(0.0, -0.66, -0.556)], 0.008, 5, 16), M.black());
      for (const y of [-0.3, -0.45]) { const cl = new THREE.BoxGeometry(0.03, 0.008, 0.008); cl.translate(-0.02 + (y + 0.3) * -0.33, y, -0.554); nb.add(cl, M.aluminum()); } } }
  // the quadrant's slotted plate on the crew's throttle box (crew.js: 0.1 x 0.06 x 0.34 rig units round thrBase, the
  // figure at 0.8 scale), the fuel selector forward of it, the trim wheel and its indicator aft
  const THR = [-0.325, -0.38, 0.1];
  { const pl = new THREE.PlaneGeometry(0.27, 0.075); onCell(pl, CELLS.quad, 3); pl.rotateX(-Math.PI / 2); pl.rotateY(Math.PI / 2); pl.translate(THR[0], -0.3708, THR[2] - 0.016); b.add(pl, AT); }
  { const z = -0.2, x = -0.34, pc = new THREE.CircleGeometry(0.03, 20); onCell(pc, CELLS.fuel); pc.rotateX(-Math.PI / 2); pc.translate(x, CON.top + 0.0008, z); b.add(pc, AT);
    if (hi) { const hub = new THREE.CylinderGeometry(0.009, 0.01, 0.012, 10); hub.translate(x, CON.top + 0.006, z); nb.add(hub, black());
      const hd = new THREE.BoxGeometry(0.012, 0.012, 0.05); hd.translate(0, 0, -0.012); hd.rotateY(0.5); hd.translate(x, CON.top + 0.016, z); nb.add(solid(hd, CELLS.red), AT); } }
  { const z = 0.31, x = -0.345, wh = new THREE.CylinderGeometry(0.032, 0.032, 0.014, hi ? 24 : 12); wh.rotateZ(Math.PI / 2); wh.translate(x, CON.top - 0.012, z); b.add(wh, black());
    const tp = new THREE.PlaneGeometry(0.035, 0.05); onCell(tp, CELLS.trim); tp.rotateX(-Math.PI / 2); tp.translate(x, CON.top + 0.0008, z + 0.06); b.add(tp, AT);
    if (hi) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, rib = new THREE.BoxGeometry(0.016, 0.004, 0.004); rib.translate(0, Math.cos(a) * 0.032, Math.sin(a) * 0.032); rib.translate(x, CON.top - 0.012, z); nb.add(rib, black()); } }
  // ---- the seat: the composite shell on floor rails, leather cushions (their tops where the shell's surfaces are, so
  // the crew still sits where crew.js fits them), a pleated back, the headrest, the harness: shoulder straps out of
  // slots in the back and over to the anchors behind it, lap belt anchors on brackets beside the cushion
  const SA = [0, -0.54, 0.42], SD = [0.36, 0.72, 0.34, 0.32], tilt = SD[3];
  { const sb = new Bag(), st = seatGeo(...SD); st.translate(...SA); sb.add(st, interior());
    const sf = (yb, dz) => V(0, SA[1] + yb * Math.cos(tilt), SA[2] + yb * Math.sin(tilt) + dz); // a point on the back's centre line: yb up the rake, dz aft
    const pan = cushion(0.29, 0.034, 0.34, 0.014, 0.006); pan.translate(0, SA[1] + 0.02 + 0.126 * SD[0] - 0.015, SA[2] - 0.155); sb.add(pan, LT);
    const bk = cushion(0.27, 0.56, 0.032, 0.014, 0.005, [5, 8, 2]); bk.rotateX(tilt); const c0 = sf(0.335, 0.0215 + 0.016 / Math.cos(tilt)); bk.translate(c0.x, c0.y, c0.z); sb.add(bk, LT);
    const hr = new THREE.CapsuleGeometry(0.06, 0.12, 4, 10); hr.rotateZ(Math.PI / 2); hr.scale(1, 1, 0.6); hr.translate(0, 0.2, 0.64); sb.add(hr, LT);
    if (hi) {
      const n = V(0, -Math.sin(tilt), -Math.cos(tilt)) /* the back's front normal */, nb2 = n.clone().negate();
      for (const sx of [-1, 1]) {
        const x = sx * 0.062, f = (yb, dz) => sf(yb, dz).setX(x);
        sb.add(strap([f(0.5, 0.019), f(0.6, 0.0185), f(0.655, 0.0185)], n), M.rubber()); // down the cushion's face from the slot
        sb.add(strap([f(0.655, 0.064), f(0.6, 0.066), f(0.45, 0.068), f(0.3, 0.07)], nb2), M.rubber()); // out of the back to the anchor
        const slot = new THREE.BoxGeometry(0.046, 0.012, 0.004); slot.rotateX(tilt); const sp = f(0.655, 0.0185); slot.translate(sp.x, sp.y, sp.z); sb.add(slot, black());
        const anc = new THREE.BoxGeometry(0.03, 0.03, 0.008); anc.rotateX(tilt); const ap = f(0.3, 0.075); anc.translate(ap.x, ap.y, ap.z); sb.add(anc, M.steel());
        const br = new THREE.BoxGeometry(0.006, 0.05, 0.03); br.translate(sx * 0.152, SA[1] + 0.06, SA[2] - 0.06); sb.add(br, M.steel()); // lap belt anchor bracket
        sb.add(strap([V(sx * 0.149, SA[1] + 0.07, SA[2] - 0.05), V(sx * 0.149, SA[1] + 0.07, SA[2] - 0.15), V(sx * 0.14, SA[1] + 0.068, SA[2] - 0.24)], V(sx, 0, 0), 0.034), M.rubber());
        const adj = new THREE.BoxGeometry(0.006, 0.04, 0.03); adj.translate(sx * 0.152, SA[1] + 0.07, SA[2] - 0.2); sb.add(adj, M.chrome());
      }
    }
    const n0 = g.children.length; sb.to(g); for (const m of g.children.slice(n0)) m.userData.seatRail = 0;
  }
  // ---- the pilot (crew.js) on that seat; the controls where this cockpit has them (part coordinates): the stick on the
  // tub floor between the knees, the throttle on the left console beside the hip, the rudder pedals (with toe brakes)
  // on the floor; the pilot wears the seat's harness
  const Pp = [0, -0.392, 0.367], S = 0.8, at = (x, y, z) => [x - Pp[0], y - Pp[1], z - Pp[2]];
  const seat = { p: Pp, s: S, harness: true, fit: { at: SA, dims: SD, floor: -0.66, feet: 'pedals' },
    controls: { stickBase: at(0, -0.655, -0.12), stickLen: 0.42, thrBase: at(...THR), pedY: at(0, -0.66, 0)[1], pedZ: at(0, 0, -0.28)[2], toeBrakes: 1 },
    adjust: { pedZ: [-0.04, 0.08], seatZ: [-0.12, 0.04], seatY: [-0.04, 0.02] } }; // (the rudder pedals adjust 4 cm forward to 8 cm aft, the seat runs on rails 12 cm forward to 4 cm back and 4 cm down to 2 cm up: set once for whoever flies it)
  g.userData.seats = [seat];
  g.userData.fit = [{ kind: 'seat', p: [0, -0.573, 0.25], w: 0.2, d: 0.28 }]; // (the seat's rails: the riser runs under its whole travel; the panel is held by the walls)
  // what the pilot must keep clear of: inside the dome (and its skirt's walls down into the tub), the panel with what
  // stands off it, the glareshield, both consoles (the armrest on the right), and the floor mat
  const insideDome = []; for (let i = 0; i <= 40; i++) { const z = -BB + 2 * BB * (i / 40), k = dk(z); insideDome.push([+z.toFixed(4), +(A * k).toFixed(4), +(C * k).toFixed(4), 0]); }
  seat.obstacles = [{ name: 'canopy', inside: insideDome }, boxObstacle('panel', P(mx([0, 0.015, 0.014])), [0.72, 0.34, 0.052]),
    { name: 'glare shield', box: [0, 0.03, -0.75], size: [0.78, 0.2, 0.5] },
    { name: 'left console', box: [-0.375, -0.455, 0.08], size: [0.19, 0.14, 0.76] }, { name: 'right console', box: [0.375, -0.44, 0.08], size: [0.19, 0.17, 0.76] },
    { name: 'floor', plane: [0, 1, 0], at: [0, -0.668, 0], parts: ['feet', 'legs'] }];
  // ---- once the canopy is seated (skinBlend: the tub's rings, this frame): the consoles pressed onto the walls, the
  // leather side panels under an aluminium canopy rail, the ribbed floor mat. Returns [geometry, material] to add.
  g.userData.tubFit = (rings) => {
    const W = tubWalls(rings), out = [];
    for (const m of g.userData.hug || []) { // consoles: outer vertices onto the wall (2 mm off it), never past their inner face
      const p = m.geometry.attributes.position;
      const lo = m.userData.hugMin ?? CON.x0 + 0.012;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), s = x < 0 ? -1 : 1, ax = Math.abs(x); if (ax < lo) continue; const w = Math.max(lo, W.x(s, p.getY(i), p.getZ(i)) - 0.002); if (ax > w) p.setX(i, s * w); }
      p.needsUpdate = true; m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
    }
    const ZS = 26, z0 = -0.47, z1 = 0.76, yb = CON.top - 0.01, yF = -0.668, flo = (x, z) => Math.max(yF, W.floor(x, z) + 0.012);
    for (const s of [-1, 1]) {
      const rows = [], rail = [];
      for (let j = 0; j <= ZS; j++) {
        const z = z0 + (z1 - z0) * (j / ZS), yt = W.top(s, z) - 0.014, r = [];
        for (let i = 0; i <= 6; i++) { const y = yt + (yb - yt) * (i / 6); r.push(V(s * (W.x(s, y, z) - 0.005), y, z)); }
        rows.push(r); rail.push(V(s * (W.x(s, yt + 0.004, z) - 0.012), yt + 0.002, z));
      }
      out.push([grid(rows, (p) => V(-p.x, 0, 0)), LT]);
      const low = []; // carpeted kick panels below it, down to the floor (behind the consoles where they are)
      for (let j = 0; j <= ZS; j++) { const z = -0.56 + (z1 + 0.56) * (j / ZS), r = []; for (let i = 0; i <= 3; i++) { const y0 = flo(s * (W.x(s, yb, z) - 0.03), z), y = yb + 0.004 + (y0 - yb - 0.004) * (i / 3); r.push(V(s * (W.x(s, y, z) - 0.006), y, z)); } low.push(r); }
      out.push([grid(low, (p) => V(-p.x, 0, 0)), carpet()]);
      out.push([pipe(rail, 0.0075, 6, hi ? 60 : 30), M.aluminum()]);
    }
    { const z = 0.76, yt = Math.min(W.top(1, z), W.top(-1, z)) - 0.014, rows = []; // the rear bulkhead behind the seat, upholstered
      for (let i = 0; i <= 6; i++) { const y = yt + (-0.7 - yt) * (i / 6), w = Math.min(W.x(1, y, z), W.x(-1, y, z)) - 0.005, r = []; for (let k = 0; k <= 8; k++) r.push(V(w * (k / 4 - 1), y, z)); rows.push(r); }
      if (yt > -0.5) out.push([grid(rows, () => V(0, 0, -1)), LT]); }
    { const rows = []; // the carpeted floor, wall to wall, from the firewall back under the seat to the bulkhead
      for (let j = 0; j <= 14; j++) { const z = -0.56 + 1.32 * (j / 14), yc = flo(0, z), w = Math.min(W.x(1, yc, z), W.x(-1, yc, z)) - 0.007, r = []; for (let i = 0; i <= 8; i++) { const x = w * (i / 4 - 1); r.push(V(x, flo(x, z), z)); } rows.push(r); }
      out.push([grid(rows, () => V(0, 1, 0)), carpet()]);
    }
    return out;
  };
}
// mirrored geometry keeps its faces outward
function flipWinding(geo) {
  if (geo.index) { const a = geo.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
  else for (const k of Object.keys(geo.attributes)) { const at = geo.attributes[k], n = at.itemSize, arr = at.array; for (let i = 0; i < at.count; i += 3) for (let c = 0; c < n; c++) { const t = arr[(i + 1) * n + c]; arr[(i + 1) * n + c] = arr[(i + 2) * n + c]; arr[(i + 2) * n + c] = t; } }
  geo.computeVertexNormals(); return geo;
}
