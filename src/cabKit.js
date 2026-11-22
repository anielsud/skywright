// Cab kit: the small furniture of enclosed cabs (the monster truck's cab, the fireboat's wheelhouse, the helicopter's
// bubble), taken from what real ones carry: instrument faces, screens, radios and switch panels, all drawn on one
// texture atlas so a whole dashboard is one material (one draw call, a little self-lit like a real backlit panel);
// gauges with bezels, toggle switches and knobs as geometry where the eye goes; a racing containment seat, harness
// webbing and foam padding for roll-cage tubes.
//
// Faces are placed with a matrix whose local +Z points out of the panel towards the viewer (faceM), so a face built in
// local XY (a PlaneGeometry, a CircleGeometry) lies flat on the panel.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from '../vendor/addons/BufferGeometryUtils.js';
import { V, ringLoft, pipe, bar } from './partDetail.js';
import { LivePanel, Shape, shapeGeometry } from './liveDisplays.js';

const cache = new Map();
const cached = (k, make) => { if (!cache.has(k)) cache.set(k, make()); return cache.get(k); };

// ---------- the atlas ----------
const S = 1024;
// tile rects [x, y, w, h] in atlas pixels (canvas y down)
export const TILE = {
  gauge: [0, 0, 256, 256], tach: [256, 0, 256, 256], chart: [512, 0, 256, 256], radar: [768, 0, 256, 256],
  engine: [0, 256, 256, 256], switches: [256, 256, 512, 256], vhf: [768, 256, 256, 128], monitor: [768, 384, 256, 128],
  avionics: [0, 512, 256, 512], annun: [256, 512, 256, 64], heliSw: [256, 576, 256, 128], digi: [512, 512, 256, 128],
  ai: [768, 512, 256, 256], alt: [512, 640, 256, 256], compass: [256, 704, 256, 256], plate: [768, 768, 256, 256], placard: [512, 896, 256, 128],
};
// solid swatches (pixel offsets in the attitude tile's corners): the needles' colours, and white for vertex-tinted pieces
const SWATCH = { white: [4, 4], orange: [22, 4], hub: [4, 22] };
const swatchUV = (k) => { const [x, y] = TILE.ai, [u, v] = SWATCH[k]; return [(x + u + 7) / S, 1 - (y + v + 7) / S]; };
export const WHITE_UV = swatchUV('white');
function atlasCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const font = (px, w = 'bold') => (g.font = `${w} ${px}px Helvetica, Arial, sans-serif`);
  const text = (s, x, y, px, col = '#e8e8e2', align = 'center') => { font(px); g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };
  const dial = ([x0, y0, w], o = {}) => { // a round instrument: black face, ticks, numerals, a needle, a red arc
    const cx = x0 + w / 2, cy = y0 + w / 2, R = w * 0.46;
    g.fillStyle = '#060708'; g.fillRect(x0, y0, w, w); g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    const a0 = Math.PI * 0.75, span = Math.PI * 1.5, n = o.n || 8;
    if (o.red) { g.strokeStyle = '#d22'; g.lineWidth = w * 0.035; g.beginPath(); g.arc(cx, cy, R * 0.86, a0 + span * o.red, a0 + span); g.stroke(); }
    if (o.green) { g.strokeStyle = '#2b2'; g.lineWidth = w * 0.035; g.beginPath(); g.arc(cx, cy, R * 0.86, a0 + span * o.green[0], a0 + span * o.green[1]); g.stroke(); }
    g.strokeStyle = '#eee'; for (let i = 0; i <= n * 2; i++) { const a = a0 + span * (i / (n * 2)), L = i % 2 ? 0.08 : 0.15; g.lineWidth = i % 2 ? w * 0.008 : w * 0.016; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.92, cy + Math.sin(a) * R * 0.92); g.lineTo(cx + Math.cos(a) * R * (0.92 - L), cy + Math.sin(a) * R * (0.92 - L)); g.stroke(); }
    if (o.nums) for (let i = 0; i <= n; i++) { const a = a0 + span * (i / n); text(String(o.nums[0] + i * o.nums[1]), cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6, w * 0.085); }
    if (o.label) text(o.label, cx, cy + R * 0.42, w * 0.07, '#bbb');
    if (o.at != null) { const na = a0 + span * o.at; g.strokeStyle = o.needle || '#f4f4f0'; g.lineWidth = w * 0.025; g.beginPath(); g.moveTo(cx - Math.cos(na) * R * 0.15, cy - Math.sin(na) * R * 0.15); g.lineTo(cx + Math.cos(na) * R * 0.82, cy + Math.sin(na) * R * 0.82); g.stroke();
      g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, w * 0.04, 0, 7); g.fill(); }
  };
  const rr = (x, y, w, h, r, fill, stroke, lw = 2) => { g.beginPath(); g.roundRect(x, y, w, h, r); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
  g.fillStyle = '#1b1c1f'; g.fillRect(0, 0, S, S);
  // (the round dials' needles are geometry: gauge() below, moving ones liveDisplays.js)
  dial(TILE.gauge, { red: 0.82, nums: [0, 20], n: 6, label: 'PSI' });
  dial(TILE.tach, { red: 0.78, nums: [0, 1], n: 9, label: 'RPM x1000' });
  { // chart plotter: sea, land, depth contours, the boat's track and a menu bar
    const [x, y, w, h] = TILE.chart; g.fillStyle = '#1f5fa8'; g.fillRect(x, y, w, h);
    g.fillStyle = '#2e78c4'; g.beginPath(); g.ellipse(x + w * 0.35, y + h * 0.55, w * 0.42, h * 0.3, 0.4, 0, 7); g.fill();
    g.fillStyle = '#e9d27a'; g.beginPath(); g.moveTo(x + w * 0.6, y); g.bezierCurveTo(x + w * 0.55, y + h * 0.3, x + w * 0.85, y + h * 0.45, x + w * 0.7, y + h * 0.9); g.lineTo(x + w, y + h * 0.9); g.lineTo(x + w, y); g.fill();
    g.strokeStyle = '#9cc8ee'; g.lineWidth = 1.5; for (const k of [0.2, 0.32]) { g.beginPath(); g.ellipse(x + w * 0.62, y + h * 0.45, w * k, h * k * 1.2, 0.2, 0, 7); g.stroke(); }
    g.strokeStyle = '#ff3b3b'; g.lineWidth = 3; g.beginPath(); g.moveTo(x + w * 0.15, y + h * 0.85); g.lineTo(x + w * 0.3, y + h * 0.6); g.lineTo(x + w * 0.42, y + h * 0.45); g.stroke();
    g.fillStyle = '#111'; g.beginPath(); g.moveTo(x + w * 0.42, y + h * 0.38); g.lineTo(x + w * 0.46, y + h * 0.5); g.lineTo(x + w * 0.38, y + h * 0.5); g.fill();
    g.fillStyle = 'rgba(10,14,20,0.85)'; g.fillRect(x, y + h * 0.9, w, h * 0.1); text('SOG 6.2  COG 341  DPT 12m', x + w / 2, y + h * 0.95, 14, '#e8e8e2');
  }
  { // radar: dark, range rings, a heading line, echoes
    const [x, y, w] = TILE.radar, cx = x + w / 2, cy = y + w / 2; g.fillStyle = '#05080a'; g.fillRect(x, y, w, w);
    g.strokeStyle = '#1f6f3a'; g.lineWidth = 1.5; for (const r of [0.15, 0.28, 0.41]) { g.beginPath(); g.arc(cx, cy, w * r, 0, 7); g.stroke(); }
    g.strokeStyle = '#7dffa8'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - w * 0.45); g.stroke();
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.45); grd.addColorStop(0, 'rgba(60,255,120,0.35)'); grd.addColorStop(1, 'rgba(60,255,120,0)');
    g.fillStyle = grd; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, w * 0.45, -0.6, 0.15); g.fill();
    g.fillStyle = '#ffd23c'; for (const [a, r, s] of [[0.3, 0.3, 6], [2.2, 0.36, 9], [4.0, 0.2, 5], [5.2, 0.4, 12], [1.2, 0.42, 14]]) { g.beginPath(); g.ellipse(cx + Math.cos(a) * w * r, cy + Math.sin(a) * w * r, s, s * 0.6, a, 0, 7); g.fill(); }
    text('0.75 NM', x + 34, y + 14, 13, '#7dffa8');
  }
  { // engine monitor: two engines' bars and numbers
    const [x, y, w, h] = TILE.engine; g.fillStyle = '#0b0d10'; g.fillRect(x, y, w, h);
    for (const [k, nm] of [[0, 'PORT'], [1, 'STBD']]) { const x0 = x + 12 + k * w / 2; text(nm, x0 + w / 4 - 12, y + 18, 15, '#9fd0ff');
      for (let i = 0; i < 4; i++) { const yy = y + 42 + i * 52, f = [0.62, 0.48, 0.71, 0.35][(i + k) % 4]; rr(x0, yy, w / 2 - 24, 16, 3, '#20242a'); rr(x0, yy, (w / 2 - 24) * f, 16, 3, i === 1 ? '#f2b705' : '#3ccf6a'); text(['1850', '82°', '4.2', '13.8'][i], x0 + w / 4 - 12, yy + 32, 15); } }
  }
  { // switch panel (race truck): two rows of toggles with labels, a guarded red ignition and a starter button
    const [x, y, w, h] = TILE.switches; g.fillStyle = '#2a2c30'; g.fillRect(x, y, w, h);
    g.strokeStyle = '#55595f'; g.lineWidth = 3; g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    const L = ['FUEL', 'IGN', 'FAN', 'LIGHTS', 'PUMP', 'RADIO', 'BRAKE', 'NOS'];
    for (let i = 0; i < 8; i++) { const cx = x + 40 + i * 62; text(L[i], cx, y + 36, 15); rr(cx - 12, y + 52, 24, 34, 6, '#141518', '#666', 2); text(['', 'ON', '', '', '', '', '', ''][i] || 'ON', cx, y + 100, 11, '#aaa'); }
    for (let i = 0; i < 6; i++) { const cx = x + 40 + i * 62; rr(cx - 10, y + 140, 20, 20, 10, i < 3 ? '#3ccf6a' : '#e23b3b'); text(['OIL', 'H2O', 'GEN', 'FIRE', 'TEMP', 'LOW'][i], cx, y + 176, 13); }
    rr(x + w - 120, y + 128, 96, 96, 10, '#c8102e', '#ffd0d0', 3); text('START', x + w - 72, y + 176, 20, '#fff');
    text('KILL', x + w - 160, y + 230, 14, '#ffcc00');
  }
  { // VHF radio face: LCD with channel, buttons, a knob ring
    const [x, y, w, h] = TILE.vhf; g.fillStyle = '#121316'; g.fillRect(x, y, w, h);
    rr(x + 70, y + 16, 120, 62, 6, '#9ec08a'); text('16', x + 130, y + 50, 40, '#1a2a12'); text('USA  HI', x + 130, y + 24, 12, '#1a2a12');
    g.fillStyle = '#2a2c30'; g.beginPath(); g.arc(x + 34, y + 48, 24, 0, 7); g.fill(); g.strokeStyle = '#777'; g.lineWidth = 2; g.stroke();
    for (let i = 0; i < 5; i++) rr(x + 70 + i * 25, y + 90, 20, 22, 4, i === 0 ? '#c8102e' : '#33363b');
    g.fillStyle = '#2a2c30'; g.beginPath(); g.arc(x + 222, y + 64, 22, 0, 7); g.fill(); g.stroke();
  }
  { // fire monitor control panel: labelled buttons for the water cannons, pump pressure
    const [x, y, w, h] = TILE.monitor; g.fillStyle = '#b8bcc2'; g.fillRect(x, y, w, h);
    g.fillStyle = '#c8102e'; g.fillRect(x, y, w, 24); text('FIRE MONITOR', x + w / 2, y + 12, 15, '#fff');
    for (let i = 0; i < 3; i++) { const cx = x + 40 + i * 52; g.fillStyle = ['#c8102e', '#f2b705', '#2a7d3a'][i]; g.beginPath(); g.arc(cx, y + 62, 15, 0, 7); g.fill(); text(['FWD', 'ROOF', 'AFT'][i], cx, y + 94, 12, '#111'); }
    g.fillStyle = '#111'; g.beginPath(); g.arc(x + 214, y + 72, 30, 0, 7); g.fill(); text('PUMP', x + 214, y + 112, 12, '#111');
  }
  { // helicopter avionics stack: audio panel, two comm/nav radios, transponder, GPS
    const [x, y, w, h] = TILE.avionics; g.fillStyle = '#16171a'; g.fillRect(x, y, w, h);
    const unit = (yy, hh, lcd, label) => { rr(x + 6, yy, w - 12, hh - 6, 5, '#0d0e10', '#3a3d42', 2); if (lcd) { rr(x + 50, yy + 12, w - 100, hh - 36, 4, lcd); text(label, x + w / 2, yy + hh / 2 - 6, 22, '#071007'); }
      for (const sx of [26, w - 26]) { g.fillStyle = '#2b2d31'; g.beginPath(); g.arc(x + sx, yy + hh / 2 - 3, 14, 0, 7); g.fill(); g.strokeStyle = '#777'; g.lineWidth = 1.5; g.stroke(); } };
    unit(y + 4, 70, null); for (let i = 0; i < 8; i++) rr(x + 22 + i * 27, y + 24, 20, 20, 3, i % 3 ? '#33363b' : '#f2b705');
    unit(y + 80, 96, '#64e0ff', '121.50'); unit(y + 182, 96, '#64e0ff', '118.30'); unit(y + 284, 80, '#ffb347', '7000');
    unit(y + 370, 136, '#1f5fa8', ''); g.fillStyle = '#e9d27a'; g.fillRect(x + 60, y + 400, 60, 40); g.strokeStyle = '#ff3b3b'; g.lineWidth = 3; g.beginPath(); g.moveTo(x + 80, y + 470); g.lineTo(x + 170, y + 390); g.stroke();
  }
  { // annunciator strip
    const [x, y, w, h] = TILE.annun; g.fillStyle = '#0c0d0f'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 6; i++) rr(x + 6 + i * 41, y + 8, 36, h - 16, 3, ['#7a1010', '#7a6010', '#103a7a', '#7a1010', '#2a5a1a', '#7a6010'][i]);
  }
  { // helicopter switch row: master, avionics, lights, fuel
    const [x, y, w, h] = TILE.heliSw; g.fillStyle = '#1e1f22'; g.fillRect(x, y, w, h);
    const L = ['BATT', 'ALT', 'AVION', 'NAV', 'STRB', 'LDG', 'FUEL'];
    for (let i = 0; i < 7; i++) { const cx = x + 22 + i * 35; text(L[i], cx, y + 22, 11); rr(cx - 7, y + 40, 14, 26, 4, '#111', '#666', 1.5); }
    rr(x + 20, y + 84, 216, 30, 4, '#0b0b0c', '#444', 2); text('CLUTCH   GOV   CARB HT', x + 128, y + 99, 12, '#ffcc00');
  }
  { // truck digital dash: shift lights, a speed and a gear
    const [x, y, w, h] = TILE.digi; g.fillStyle = '#050607'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 10; i++) rr(x + 14 + i * 23, y + 10, 18, 12, 3, i < 5 ? '#3ccf6a' : i < 8 ? '#f2b705' : '#e23b3b');
    text('2', x + 54, y + 78, 64, '#fff'); text('48', x + 170, y + 70, 42, '#64e0ff'); text('MPH', x + 170, y + 104, 14, '#aaa');
  }
  { // attitude indicator
    const [x, y, w] = TILE.ai, cx = x + w / 2, cy = y + w / 2; g.fillStyle = '#060708'; g.fillRect(x, y, w, w);
    g.save(); g.beginPath(); g.arc(cx, cy, w * 0.44, 0, 7); g.clip(); g.fillStyle = '#2f7fd0'; g.fillRect(x, y, w, w / 2 + 10); g.fillStyle = '#7a4a22'; g.fillRect(x, y + w / 2 + 10, w, w / 2);
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, cy + 10); g.lineTo(x + w, cy + 10); g.stroke(); for (const d of [-30, 30]) { g.beginPath(); g.moveTo(cx - 24, cy + 10 + d); g.lineTo(cx + 24, cy + 10 + d); g.stroke(); } g.restore();
    g.strokeStyle = '#f2b705'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx - 60, cy); g.lineTo(cx - 18, cy); g.lineTo(cx, cy + 14); g.lineTo(cx + 18, cy); g.lineTo(cx + 60, cy); g.stroke();
  }
  { // altimeter: 0-9 all the way round (hundreds on the long hand, thousands on the short one), a Kollsman window
    const [x0, y0, w] = TILE.alt, cx = x0 + w / 2, cy = y0 + w / 2, R = w * 0.46; g.fillStyle = '#060708'; g.fillRect(x0, y0, w, w); g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    g.strokeStyle = '#eee'; for (let i = 0; i < 50; i++) { const a = -Math.PI / 2 + (i / 50) * Math.PI * 2, L = i % 5 ? 0.08 : 0.16; g.lineWidth = i % 5 ? w * 0.008 : w * 0.018; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.93, cy + Math.sin(a) * R * 0.93); g.lineTo(cx + Math.cos(a) * R * (0.93 - L), cy + Math.sin(a) * R * (0.93 - L)); g.stroke(); }
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i / 10) * Math.PI * 2; text(String(i), cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62, w * 0.1); }
    text('ALT', cx, cy - R * 0.3, w * 0.065, '#bbb'); text('100 FEET', cx, cy + R * 0.32, w * 0.05, '#bbb');
    g.fillStyle = '#1b1c1f'; g.fillRect(cx + R * 0.22, cy - R * 0.09, R * 0.42, R * 0.18); text('29.92', cx + R * 0.43, cy, w * 0.05, '#f2f2ee');
  }
  { // solid swatches in the attitude tile's corners (outside its round face): what needles and lamps are coloured from
    const [x, y] = TILE.ai; for (const [k, col] of [['white', '#ffffff'], ['orange', '#ff6a1a'], ['hub', '#222326']]) { const [u, v] = SWATCH[k]; g.fillStyle = col; g.fillRect(x + u, y + v, 14, 14); } }
  { // compass card (a magnetic compass's face)
    const [x, y, w] = TILE.compass; g.fillStyle = '#e8e4d6'; g.fillRect(x, y, w, w);
    for (let i = 0; i < 36; i++) { const xx = x + (i / 36) * w * 2 % w; g.fillStyle = '#111'; g.fillRect(xx, y + w * 0.3, 2, i % 3 ? 20 : 34); }
    for (const [k, s] of [[0, 'N'], [0.25, 'E'], [0.5, 'S'], [0.75, 'W']]) text(s, x + k * w + 12, y + w * 0.65, 34, '#111');
  }
  { // plain brushed plate with screws (blank panels)
    const [x, y, w, h] = TILE.plate; g.fillStyle = '#3a3d42'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; g.fillRect(x, y + Math.random() * h, w, 1); }
    for (const [sx, sy] of [[12, 12], [w - 12, 12], [12, h - 12], [w - 12, h - 12]]) { g.fillStyle = '#888'; g.beginPath(); g.arc(x + sx, y + sy, 5, 0, 7); g.fill(); }
  }
  { // placards: four 128 x 64 stickers (caution, fire extinguisher, data plate, kill switch)
    const [x, y] = TILE.placard, P = [['#f2c300', '#111', 'CAUTION', 'KEEP CLEAR'], ['#c8102e', '#fff', 'FIRE', 'EXTINGUISHER'], ['#d9dcdf', '#111', 'MAX 2 PERSONS', 'NO SMOKING'], ['#111', '#f2c300', 'KILL', 'SWITCH']];
    P.forEach(([bg, fg, a1, a2], k) => { const px = x + (k % 2) * 128, py = y + Math.floor(k / 2) * 64; g.fillStyle = bg; g.fillRect(px + 2, py + 2, 124, 60); g.strokeStyle = fg; g.lineWidth = 2; g.strokeRect(px + 6, py + 6, 116, 52); text(a1, px + 64, py + 24, 15, fg); text(a2, px + 64, py + 44, 11, fg); });
  }
  return c;
}
export const atlasMat = () => cached('atlas', () => {
  const t = new THREE.CanvasTexture(atlasCanvas()); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.55, metalness: 0, roughness: 0.35 });
});
// remap a geometry's 0..1 uvs into a tile
export function toTile(geo, tile) {
  const [x, y, w, h] = TILE[tile], uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * w) / S, 1 - (y + (1 - uv.getY(i)) * h) / S);
  return geo;
}

// ---------- placing things on a panel ----------
// a matrix at p whose local +Z is n (out of the panel) and local +Y as near `up` as it can be
export function faceM(p, n, up = V(0, 1, 0)) {
  const z = n.clone().normalize(), x = up.clone().cross(z); if (x.lengthSq() < 1e-6) x.set(1, 0, 0); x.normalize(); const y = z.clone().cross(x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(p);
}
const at = (m, x, y, z = 0) => m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
export const local = at;
// a face from the atlas (w x h) at m, standing `off` proud of the panel
export function face(bag, m, w, h, tile, off = 0.001) { const g = toTile(new THREE.PlaneGeometry(w, h), tile); g.applyMatrix4(at(m, 0, 0, off)); bag.add(g, atlasMat()); return g; }
// a round instrument: a dial from the atlas inside a bezel ring, with a domed glass rim
// Its needle is geometry over the face: fixed at val (0..1 of the sweep; the altimeter: feet) or, given a live panel
// (livePanel() below), moving with src (a liveDisplays signal name or (S) => the same); an attitude indicator's ball
// and a live altimeter's hands likewise.
export function gauge(bag, m, r, tile = 'gauge', bezel = null, { live = null, src = null, val = null } = {}) {
  const d = toTile(new THREE.CircleGeometry(r, 24), tile); d.applyMatrix4(at(m, 0, 0, 0.002)); bag.add(d, atlasMat());
  const ring = new THREE.TorusGeometry(r * 1.04, r * 0.12, 6, 24); ring.applyMatrix4(at(m, 0, 0, 0.004)); bag.add(ring, bezel || blackM());
  const can = new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.012, 20, 1, true); can.rotateX(Math.PI / 2); can.applyMatrix4(at(m, 0, 0, -0.004)); bag.add(can, bezel || blackM());
  gaugeGlass(bag, m, r * 1.02);
  dialNeedles(bag, at(m, 0, 0, 0.002), r, tile, live && src != null ? { live, src } : null, val);
}
// the dials' sweeps (canvas angles, as atlasCanvas paints them): 270 degrees from 7:30 round to 4:30; the altimeter's
// hands all the way round from 12 (hundreds: one turn per 1000 ft, thousands: per 10 000)
const SW = { a0: Math.PI * 0.75, span: Math.PI * 1.5 }, NEEDLE = { gauge: ['white', 0.42], tach: ['orange', 0.12] };
const TOP = -Math.PI / 2, turn = (f) => TOP + 2 * Math.PI * f;
function dialNeedles(bag, m, r, tile, L, val) {
  const R = r * 0.92, z = 0.0011; // (the face's painted radius; just over the face, under the bezel and the glass)
  const fixed = (shape) => bag.add(shapeGeometry(shape).applyMatrix4(m), atlasMat());
  const blade = (len, w, col, ang, tail = 0.18) => { const sh = new Shape().needle({ len, w, tail, z, col: WHITE_C, uv: swatchUV(col), hub: 0 }); return rotShape(sh, ang); };
  const hub = (rr, zz = z + 0.0003) => new Shape().disc(0, 0, rr, zz, WHITE_C, swatchUV('hub'), 12);
  if (NEEDLE[tile]) {
    const [col, v0] = NEEDLE[tile], len = R * 0.82, w = r * 0.06, at = (f) => SW.a0 + SW.span * Math.max(-0.02, Math.min(1.03, f));
    if (L) { L.live.needle(m, { src: L.src, at, len, w, z, color: col === 'orange' ? '#ff6a1a' : '#f4f4f0', hubCol: '#222326', hub: 2.6 }); }
    else { fixed(blade(len, w, col, at(val ?? v0))); fixed(hub(w * 1.3)); }
  } else if (tile === 'alt') {
    const ft = val ?? 550;
    if (L) {
      L.live.needle(m, { src: L.src, at: (f) => turn(f / 10000), len: R * 0.5, w: r * 0.1, z, tail: 0.15, damp: 9, hub: 0 });
      L.live.needle(m, { src: L.src, at: (f) => turn(f / 1000), len: R * 0.84, w: r * 0.055, z: z + 0.0004, damp: 9, hubCol: '#222326', hub: 2.4 });
    } else { fixed(blade(R * 0.5, r * 0.1, 'white', turn(ft / 10000), 0.15)); fixed(blade(R * 0.84, r * 0.055, 'white', turn(ft / 1000))); fixed(hub(r * 0.07, z + 0.0006)); }
  } else if (tile === 'ai' && L) L.live.attitude(m, R * 0.96, { sky: '#2f7fd0', ground: '#7a4a22', symbol: '#f2b705' }); // (over the painted ball)
}
const WHITE_C = new THREE.Color(1, 1, 1);
function rotShape(sh, a) { const c = Math.cos(-a), s = Math.sin(-a), p = sh.p; for (let i = 0; i < p.length; i += 3) { const x = p[i], y = p[i + 1]; p[i] = c * x - s * y; p[i + 1] = s * x + c * y; } return sh; }
// a race truck's digital dash (AiM / MoTeC style), drawn live on a LivePanel screen: shift lights across the top, the
// gear big on the left, the speed, the revs, a brake light
export function raceDash(c, S, w, h) {
  const T = (s, x, y, px, col, al = 'center') => { c.font = `bold ${px}px Helvetica, Arial, sans-serif`; c.fillStyle = col; c.textAlign = al; c.textBaseline = 'middle'; c.fillText(s, x, y); };
  c.fillStyle = '#050607'; c.fillRect(0, 0, w, h);
  const lit = S.running ? Math.round(Math.max(0, Math.min(1, (S.rpmK - 0.45) / 0.5)) * 10) : 0, flash = S.rpmK > 0.97 && (S.t * 8) % 1 < 0.5;
  for (let i = 0; i < 10; i++) { const on = i < lit && !flash; c.fillStyle = i < 5 ? (on ? '#3ccf6a' : '#0f2a17') : i < 8 ? (on ? '#f2b705' : '#2e2408') : (on ? '#e23b3b' : '#2e0f0f'); c.beginPath(); c.roundRect(14 + i * 23, 7, 18, 11, 3); c.fill(); }
  T(S.gearNo < 0 ? 'R' : S.gearNo === 0 ? 'N' : String(S.gearNo), 52, 62, 58, S.gearNo === 0 ? '#3ccf6a' : '#ffffff');
  T(String(Math.round(S.mph)), 172, 52, 40, '#64e0ff'); T('MPH', 172, 80, 13, '#9a9a9a');
  T(`${Math.round(S.rpm / 50) * 50} RPM`, 104, 92, 11, '#9a9a9a', 'left');
  if (S.brake) T('BRAKE', 246, 92, 11, '#e23b3b', 'right');
}
// a cab's live panel (liveDisplays.js) on this atlas: one more draw call for all its moving needles and lamps
export const livePanel = () => new LivePanel(atlasMat(), { white: swatchUV('white'), lamp: swatchUV('white') });
// a toggle switch: a hex nut on the panel and a short bat lever tilted up
export function toggle(bag, m, x, y, metal) {
  const nut = new THREE.CylinderGeometry(0.006, 0.006, 0.004, 6); nut.rotateX(Math.PI / 2); nut.applyMatrix4(at(m, x, y, 0.002)); bag.add(nut, metal);
  const lever = bar(V(0, 0, 0), V(0, 0.008, 0.02), 0.0045, 0.0045, true, 6); lever.applyMatrix4(at(m, x, y, 0.003)); bag.add(lever, metal);
}
// a round knob (radio, dimmer)
export function knob(bag, m, x, y, r, mat) {
  const k = new THREE.CylinderGeometry(r, r * 1.08, r * 0.9, 14); k.rotateX(Math.PI / 2); k.applyMatrix4(at(m, x, y, r * 0.45)); bag.add(k, mat);
}
// a box, centre c (local to m), size s
export function box(bag, m, c, s, mat) { const g = new THREE.BoxGeometry(...s); g.translate(...c); if (m) g.applyMatrix4(m); bag.add(g, mat); return g; }

// ---------- materials ----------
export const blackM = () => cached('ckBlack', () => kind('powder', new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.2, roughness: 0.55 })));
export const satinBlack = () => cached('ckSatin', () => kind('powder', new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.1, roughness: 0.62 })));
// powder-coated / anodised sheet aluminium (dash panels, door cards, floor plates)
export const sheetAlu = (c = 0x9aa0a8) => cached('ckAlu' + c, () => kind('brushed', new THREE.MeshStandardMaterial({ color: c, metalness: 0.85, roughness: 0.42, roughnessMap: brushed() })));
export const carbon = () => cached('ckCarbon', () => { const t = carbonTex(); return kind('carbon', new THREE.MeshPhysicalMaterial({ color: 0x2a2c30, map: t, metalness: 0.2, roughness: 0.38, clearcoat: 0.9, clearcoatRoughness: 0.12 })); });
// suede / race fabric (seat inserts, harness pads)
export const suede = (c = 0x202124) => cached('ckSuede' + c, () => kind('fabric', new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.95, sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.25, 0.25, 0.25) })));
export const webbing = (c) => cached('ckWeb' + c, () => kind('fabric', new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.8 })));
export const foam = (c = 0x1a1b1d) => cached('ckFoam' + c, () => kind('foam', new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.98 })));
// diamond tread plate (a race truck's floor): a bump map of raised diamonds on brushed aluminium, box uvs (repeat set per use)
export const treadPlate = () => cached('ckTread', () => {
  const W = 128, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W); g.fillStyle = '#fff';
  for (const [x, y, a] of [[32, 32, 0.6], [96, 96, 0.6], [96, 32, -0.6], [32, 96, -0.6]]) { g.save(); g.translate(x, y); g.rotate(a); g.beginPath(); g.ellipse(0, 0, 22, 5, 0, 0, 7); g.fill(); g.restore(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(30, 30);
  return kind('floor', new THREE.MeshStandardMaterial({ color: 0xb4b9c0, metalness: 0.9, roughness: 0.35, bumpMap: t, bumpScale: 3, roughnessMap: brushed() }));
});
function brushed() {
  return cached('ckBrushed', () => {
    const W = 128, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d'); g.fillStyle = '#999'; g.fillRect(0, 0, W, W);
    for (let i = 0; i < 220; i++) { const v = 120 + Math.random() * 90 | 0; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, Math.random() * W, W, 1); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}
function carbonTex() {
  const W = 64, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const v = (x + y) % 2 ? 70 : 40; g.fillStyle = `rgb(${v},${v},${v + 4})`; g.fillRect(x * 8, y * 8, 8, 8); g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x * 8, y * 8 + ((x + y) % 2 ? 0 : 3), 8, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- seats, belts, padding ----------
// A moulded seat shell lofted along a spine (frames: { o, N, hw, f }: o a point on the occupant's surface on the
// seat's centre line, N the unit normal towards the occupant there, hw the shell's half-width, f how far its side
// walls rise above that surface). Its section, across x and along N (n), is one closed U, every corner rounded (so
// smoothed normals never fold over a sharp edge): a rolled rim on each side wall (radius t / 2), the outer face
// down the side and round under the back (n = -c - t, bowed out by `bulge` in the middle), the inner face down the
// wall to the padding's bed at n = -c. Faces wind outwards; the outer half (rim tops, sides, back) takes `outer`, the
// inner half (rims' insides, walls, bed) `inner`; flat caps close the ends (each triangle turned to face away).
export function shellLoft(bag, frames, { c, t, R = 0.05, Ri = 0.03, bulge = 0.006 }, outer, inner) {
  const rr = t / 2, c45 = Math.SQRT1_2, nb = -c - t;
  const sec = (hw, f) => {
    const L = -hw + rr, Rx = hw - rr, Rc = Math.min(R, hw * 0.45), Ic = Math.min(Ri, (hw - t) * 0.45);
    return [[L, f + rr], [L - rr * c45, f + rr * c45], [-hw, f], [-hw, nb + Rc], [-hw + Rc * (1 - c45), nb + Rc * (1 - c45)], [-hw + Rc, nb], [0, nb - bulge],
      [hw - Rc, nb], [hw - Rc * (1 - c45), nb + Rc * (1 - c45)], [hw, nb + Rc], [hw, f], [Rx + rr * c45, f + rr * c45], [Rx, f + rr], // (12: outer ends)
      [Rx - rr * c45, f + rr * c45], [hw - t, f], [hw - t, -c + Ic], [hw - t - Ic * (1 - c45), -c + Ic * (1 - c45)], [hw - t - Ic, -c], [0, -c],
      [-(hw - t - Ic), -c], [-(hw - t - Ic * (1 - c45)), -c + Ic * (1 - c45)], [-(hw - t), -c + Ic], [-hw + t, f], [L + rr * c45, f + rr * c45]];
  };
  const X = V(1, 0, 0), secs = frames.map((fr) => sec(fr.hw, fr.f)), K = secs[0].length;
  const pt = (k, i) => frames[k].o.clone().addScaledVector(X, secs[k][i][0]).addScaledVector(frames[k].N, secs[k][i][1]);
  const strip = (ids, mat) => {
    const pos = [], uv = [], idx = [], n = ids.length; let v = 0; // (uvs in metres / 0.6 along the section and the spine: the carbon weave's scale)
    for (let k = 0; k < frames.length; k++) { if (k) v += frames[k].o.distanceTo(frames[k - 1].o); let u = 0, q = null; for (const i of ids) { const p = pt(k, i); if (q) u += p.distanceTo(q); q = p; pos.push(p.x, p.y, p.z); uv.push(u / 0.6, v / 0.6); } }
    for (let k = 0; k < frames.length - 1; k++) for (let j = 0; j < n - 1; j++) { const a = k * n + j, b = a + 1, cc = b + n, d = a + n; idx.push(a, b, cc, a, cc, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); bag.add(g, mat);
  };
  strip([...Array(13).keys()], outer); strip([...Array(K - 12).keys()].map((i) => (i + 12) % K), inner);
  for (const [k, k2] of [[0, 1], [frames.length - 1, frames.length - 2]]) {
    const q = secs[k], away = frames[k].o.clone().sub(frames[k2].o), tris = THREE.ShapeUtils.triangulateShape(q.map(([x, n]) => new THREE.Vector2(x, n)), []), pos = [];
    for (const tr of tris) { const [A, B, C] = tr.map((i) => pt(k, i)), flip = B.clone().sub(A).cross(C.clone().sub(A)).dot(away) < 0; for (const p of flip ? [A, C, B] : [A, B, C]) pos.push(p.x, p.y, p.z); }
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.computeVertexNormals(); bag.add(cg, outer);
  }
}
// the seat's own frame: x across, s up the back's line, d behind its face (as seatGeo's surfaces), at `at` raked by tilt
export const seatM = ([ax, ay, az], tilt) => new THREE.Matrix4().makeBasis(V(1, 0, 0), V(0, Math.cos(tilt), Math.sin(tilt)), V(0, -Math.sin(tilt), Math.cos(tilt))).setPosition(ax, ay, az + 0.02);
// a rounded slot through a shell (a dark capsule in the seat's frame m, centred at [x, s, d]): along 'x' an oval
// across the back (half-lengths long x short) through the shell's depth (d, half depthH); along 's' an oval up a side
// wall through its thickness (x, half depthH)
function slot(bag, m, [x, s, d], long, short, depthH, along = 'x') {
  const g = new THREE.CapsuleGeometry(1, 2 * (long / short - 1), 2, 8);
  if (along === 'x') { g.rotateZ(Math.PI / 2); g.scale(short, short, depthH); } else g.scale(depthH, short, short);
  g.translate(x, s, d); g.applyMatrix4(m); bag.add(g, blackM());
}
// A racing bucket seat (Sparco / OMP / BRIDE style, as photographed) on the same surfaces a seatGeo(w, backH, panL,
// tilt) placed at `at` declares (crew.js seatSurfaces: the cushion's top at at.y + 0.02 + 0.126 w, the back's front
// face through (at.y, at.z + 0.02) raked back by tilt), so the crew sit on it exactly as before. One moulded composite
// shell (shellLoft) runs from the pan's front edge, round a filleted crease and up the back to the head: thigh
// bolsters on the pan, tall rib bolsters at the hips, shoulder wings outside the arms, head wings either side of the
// helmet, the top's corners rounded; padded (suede) inside, bare composite outside, a solid back seen from behind. In
// it: a pleated lumbar insert and a cushion on the declared surfaces, a head pad, the harness's shoulder slots
// through the back, lap-belt slots through the hip bolsters, contrast stitching. prof(s) gives the shell's
// [half-width, side-wall rise] at s metres up the back's line; panF the pan's thigh-bolster rise [front, back];
// top: how far up it goes; insert: the cushions' cover (a contrast panel). Returns the head wings as obstacles (part space) and the pan's half-width (for mounts).
export function raceSeat(bag, at, [w, , panL, tilt], { prof, top, shell = carbon(), pad = suede(), insert = pad, slots = 0.72, headPad = null, panF = [0.05, 0.07], c = 0.03, t = 0.042, rc = 0.12, bulge = 0.006 } = {}) {
  const [ax, ay, az] = at, sn = Math.sin(tilt), cs = Math.cos(tilt), pt = ay + 0.02 + 0.126 * w, m = seatM(at, tilt);
  const P = (x, s, d) => V(ax + x, ay + s * cs - d * sn, az + 0.02 + s * sn + d * cs); // x across, s up the back's line, d behind its face
  // the spine in (y, z): the pan's top from its front edge to the crease, a fillet of radius rc, the back's face up to the top
  const sC = (pt - ay) / cs, Cz = az + 0.02 + sC * sn, th = Math.PI / 2 - tilt, L = rc * Math.tan(th / 2), zF = az + 0.03 - panL, sB = sC + L;
  const hwP = (p) => prof(0)[0] - 0.015 * (p / panL), fP = (p) => panF[1] + (panF[0] - panF[1]) * Math.min(1, p / panL); // (p: distance forward of the crease)
  const fr = [];
  for (let k = 0; k <= 3; k++) { const z = zF + (Cz - L - zF) * (k / 3), p = Cz - z; fr.push({ o: V(ax, pt, z), N: V(0, 1, 0), hw: hwP(p), f: fP(p) }); }
  const [h0, f0] = [hwP(L), fP(L)], [h1, f1] = prof(sB);
  for (let k = 1; k <= 5; k++) { const ph = th * (k / 5), u = k / 5; fr.push({ o: V(ax, pt + rc - rc * Math.cos(ph), Cz - L + rc * Math.sin(ph)), N: V(0, Math.cos(ph), -Math.sin(ph)), hw: h0 + (h1 - h0) * u, f: f0 + (f1 - f0) * u }); }
  const ss = []; for (let s = sB + 0.05; s < top - 0.07; s += s > 0.76 && s < 0.95 ? 0.03 : 0.06) ss.push(s);
  const back = (s, hw, f) => fr.push({ o: P(0, s, 0), N: V(0, sn, -cs), hw, f });
  for (const s of ss) back(s, ...prof(s));
  for (const a of [0, 0.5, 0.9, 1.25, Math.PI / 2]) { const s = top - 0.07 + 0.07 * Math.sin(a), [hw, f] = prof(s); back(s, hw - 0.07 + 0.07 * Math.cos(a), f); } // the top's corners rounded
  shellLoft(bag, fr, { c, t, bulge }, shell, pad);
  // the cushion on the pan (its top the declared pan), the lumbar insert (its face the declared back), the head pad
  { const wc = 2 * (hwP(panL) - t) - 0.01, z0 = zF + 0.01, z1 = Cz - L - 0.004, cu = cushion(wc, c, z1 - z0, 0.012, 0, 0, [4, 1, 4]); cu.translate(ax, pt - c / 2, (z0 + z1) / 2); bag.add(cu, insert);
    for (const x of [-(wc / 2 - 0.05), wc / 2 - 0.05]) bag.add(pipe([V(ax + x, pt + 0.0012, z0 + 0.02), V(ax + x, pt + 0.0012, z1 - 0.02)], 0.0016, 4, 2), stitchM());
    bag.add(pipe([V(ax - wc / 2 + 0.05, pt + 0.0012, (z0 + z1) / 2), V(ax + wc / 2 - 0.05, pt + 0.0012, (z0 + z1) / 2)], 0.0016, 4, 2), stitchM()); }
  const s0 = sB + 0.004, s1 = slots - 0.05, wi = 2 * (Math.min(prof(s0)[0], prof(s1)[0]) - t) - 0.01;
  { const g = cushion(wi, s1 - s0, c, 0.012, 0, 4, [4, 16, 1]); g.translate(0, (s0 + s1) / 2, c / 2); g.applyMatrix4(m); bag.add(g, insert);
    for (const x of [-(wi / 2 - 0.06), wi / 2 - 0.06]) bag.add(pipe([P(x, s0 + 0.02, -0.0012), P(x, s1 - 0.02, -0.0012)], 0.0016, 4, 2), stitchM()); }
  if (headPad) { const g = cushion(0.2, 0.15, c, 0.012, 0, 0, [4, 4, 2]); g.translate(0, headPad, c / 2 - 0.004); g.applyMatrix4(m); bag.add(g, insert); }
  // the harness: shoulder slots through the back, lap-belt slots through the hip bolsters
  { const d0 = c - 0.002, d1 = c + t + bulge + 0.003; for (const sx of [-1, 1]) slot(bag, m, [sx * 0.075, slots, (d0 + d1) / 2], 0.034, 0.011, (d1 - d0) / 2); }
  { const s = sB + 0.07, [hw] = prof(s); for (const sx of [-1, 1]) slot(bag, m, [sx * (hw - t / 2), s, -0.045], 0.024, 0.01, t / 2 + 0.003, 's'); }
  // obstacles: the head wings (where the shell's sides reach forward round the head)
  const obs = []; let sw = null;
  for (let s = sB; s <= top; s += 0.02) if (prof(s)[1] > 0.1 && s > 0.6) sw ??= s;
  if (sw != null) { const [hw, f] = prof(top - 0.01), sm = (sw + top) / 2; for (const sx of [-1, 1]) { const cc = P(sx * (hw - t / 2), sm, -f / 2); obs.push({ name: 'head wing', box: cc.toArray(), size: [t + 0.01, top - sw, f], rot: [tilt, 0, 0], parts: ['head'] }); } }
  return { panTop: pt, P, obs, panHW: prof(0)[0], bottom: pt - c - t - bulge };
}
export const stitchM = () => cached('ckStitch', () => new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0, roughness: 0.8 }));
// a flat belt (webbing) along points, width wd, thickness th, its flat face turned towards `n` (or flat on the way)
export function strap(bag, pts, wd, th, mat, n = V(0, 0, 1)) {
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const t = (i < pts.length - 1 ? pts[i + 1].clone().sub(pts[i]) : pts[i].clone().sub(pts[i - 1])).normalize();
    const side = t.clone().cross(n).normalize(), nn = side.clone().cross(t).normalize(), p = pts[i];
    rings.push([p.clone().addScaledVector(side, wd / 2).addScaledVector(nn, th / 2), p.clone().addScaledVector(side, -wd / 2).addScaledVector(nn, th / 2), p.clone().addScaledVector(side, -wd / 2).addScaledVector(nn, -th / 2), p.clone().addScaledVector(side, wd / 2).addScaledVector(nn, -th / 2)]);
  }
  bag.add(ringLoft(rings, true, true), mat);
}
// a foam pad round a tube from a to b (tube radius r): a thicker sleeve, its ends rounded
export function pad(bag, a, b, r, mat = foam()) {
  const d = b.clone().sub(a), L = d.length(), g = new THREE.CapsuleGeometry(r + 0.022, Math.max(0.01, L - 2 * (r + 0.022)), 3, 10);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1))); bag.add(g, mat);
}
export { mergeGeometries, pipe };
// leather upholstery (light aircraft and helicopter seats): a soft sheen, a fine grain from the roughness
export const leather = (c = 0x8d9096) => cached('ckLeather' + c, () => kind('leather', new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.35, 0.35, 0.35), clearcoat: 0.15, clearcoatRoughness: 0.4 })));
// An upholstered cushion: a rounded box (corner radius r) whose faces bulge out by `bulge`, with `pleats` channels sewn
// across its front (-z) face. Centred on the origin, w x h x d. (As the boats' cushions.) seg: the box's segments
// (fewer for small pads: tablet triangles).
export function cushion(w, h, d, r = 0.04, bulge = 0.015, pleats = 0, seg = [12, 10, 8]) {
  const g = new THREE.BoxGeometry(w, h, d, ...seg), p = g.attributes.position, hw = w / 2, hh = h / 2, hd = d / 2, q = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i); c.set(THREE.MathUtils.clamp(q.x, -hw + r, hw - r), THREE.MathUtils.clamp(q.y, -hh + r, hh - r), THREE.MathUtils.clamp(q.z, -hd + r, hd - r));
    const n = q.clone().sub(c); const L = n.length() || 1; n.divideScalar(L); q.copy(c).addScaledVector(n, r);
    const ux = q.x / hw, uy = q.y / hh, uz = q.z / hd;
    q.addScaledVector(n, bulge * Math.max(0, 1 - ux * ux) * Math.max(0, 1 - uy * uy) * Math.max(0, 1 - uz * uz) * 4);
    if (pleats && n.z < -0.5) { const t = (q.y / h + 0.5) * (pleats + 1); q.z += 0.01 * Math.exp(-(((t - Math.round(t)) / 0.08) ** 2)) * (Math.round(t) > 0 && Math.round(t) <= pleats ? 1 : 0); }
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.deleteAttribute('normal'); g.deleteAttribute('uv'); const m = mergeVertices(g, 1e-4); m.computeVertexNormals(); return m;
}

// ---------- surfaces: grain, wear and occlusion from the cab's shape ----------
// Real cab surfaces are never flat colour: powder coat and moulded plastic have a fine orange-peel and a mottle,
// brushed aluminium streaks, fabric a weave, foam pores, leather a grain, floors scuffs where feet go. Each kit
// material carries its kind (userData.cabKind); cabFinish() gives every interior mesh of a cab a variant of its
// material that adds, from the object-space position (no uvs needed, nothing to load): colour and roughness noise, a
// bump from the same field, and occlusion from the cab's inner box (corners and the floor's edges darker, the way
// light dies into a recess; a surface lying on a face of the box isn't darkened by that face). Cost: a few noise
// lookups per pixel, no textures, no extra draw calls (one variant per material per cab).
function kind(k, m) { m.userData.cabKind = k; return m; }
export const surfaceKind = kind;
const NOISE = /* glsl */`
  uniform vec3 uCab0; uniform vec3 uCab1; uniform float uCabAO;
  float cH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float cN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(cH(i), cH(i + vec3(1,0,0)), f.x), mix(cH(i + vec3(0,1,0)), cH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(cH(i + vec3(0,0,1)), cH(i + vec3(1,0,1)), f.x), mix(cH(i + vec3(0,1,1)), cH(i + vec3(1,1,1)), f.x), f.y), f.z); }
  vec3 cBump(vec3 n, vec3 vp, float h, float k) { vec3 dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); return normalize(abs(det) * n - k * sign(det) * (dhx * r1 + dhy * r2)); }
  float cFace(float d, float r, float w) { return d < 0.012 ? 1.0 : mix(1.0 - w, 1.0, smoothstep(0.0, r, d)); }
  float cabOcc(vec3 p) { if (uCabAO <= 0.0) return 1.0; vec3 a = p - uCab0, b = uCab1 - p; if (min(min(a.x, a.y), a.z) < -0.03 || min(min(b.x, b.y), b.z) < -0.03) return 1.0; a = max(a, 0.0); b = max(b, 0.0);
    return cFace(a.y, 0.22, 0.5 * uCabAO) * cFace(b.y, 0.25, 0.3 * uCabAO) * cFace(a.x, 0.18, 0.35 * uCabAO) * cFace(b.x, 0.18, 0.35 * uCabAO) * cFace(a.z, 0.18, 0.35 * uCabAO) * cFace(b.z, 0.18, 0.35 * uCabAO); }`;
// per kind: h (bump height field), k (its strength), c (colour factor), r (roughness offset)
const KIND = {
  powder: 'float h = (cN(p * 900.0) - 0.5) * 0.25 + (cN(p * 150.0) - 0.5) * 0.2; float k = 0.00035; float c = 1.0 + (cN(p * 55.0) - 0.5) * 0.1 + (cN(p * 7.0) - 0.5) * 0.12; float r = (cN(p * 35.0) - 0.5) * 0.22;',
  brushed: 'float s = cN(p * vec3(3.0, 420.0, 420.0)); float h = (s - 0.5) * 0.3 + (cN(p * 60.0) - 0.5) * 0.1; float k = 0.00022; float c = 1.0 + (s - 0.5) * 0.16 + (cN(p * 6.0) - 0.5) * 0.12; float r = (s - 0.5) * 0.3 + (cN(p * 9.0) - 0.5) * 0.15;',
  fabric: 'float fw = clamp(length(fwidth(p)) * 900.0, 0.0, 1.0); float h = mix(sin(p.x * 2600.0 + p.z * 900.0) * sin(p.y * 2600.0 - p.z * 1700.0) * 0.25, 0.0, fw) + (cN(p * 45.0) - 0.5) * 0.5; float k = 0.0006; float c = 1.0 + (cN(p * 30.0) - 0.5) * 0.14 + (cN(p * 5.0) - 0.5) * 0.1; float r = (cN(p * 25.0) - 0.5) * 0.1;',
  foam: 'float h = (cN(p * 380.0) - 0.5) * 0.8 + (cN(p * 45.0) - 0.5) * 0.5; float k = 0.0007; float c = 1.0 + (cN(p * 22.0) - 0.5) * 0.16; float r = (cN(p * 40.0) - 0.5) * 0.08;',
  leather: 'float h = (cN(p * 650.0) - 0.5) * 0.55 + (cN(p * 110.0) - 0.5) * 0.3; float k = 0.0004; float c = 1.0 + (cN(p * 14.0) - 0.5) * 0.12 + (cN(p * 70.0) - 0.5) * 0.05; float r = (cN(p * 30.0) - 0.5) * 0.18;',
  rubber: 'float h = (cN(p * 320.0) - 0.5) * 0.7 + (cN(p * 25.0) - 0.5) * 0.4; float k = 0.0006; float c = 1.0 + (cN(p * 18.0) - 0.5) * 0.14; float r = (cN(p * 20.0) - 0.5) * 0.1;',
  gel: 'float h = (cN(p * 800.0) - 0.5) * 0.2 + (cN(p * 120.0) - 0.5) * 0.12; float k = 0.0003; float c = 1.0 + (cN(p * 50.0) - 0.5) * 0.035 + (cN(p * 5.0) - 0.5) * 0.05; float r = (cN(p * 30.0) - 0.5) * 0.12;', // gelcoat: orange peel, a faint mottle
  carbon: 'float h = (cN(p * 400.0) - 0.5) * 0.05; float k = 0.0002; float c = 1.0 + (cN(p * 9.0) - 0.5) * 0.12; float r = (cN(p * 14.0) - 0.5) * 0.12;',
  // floors: grain plus lighter scuffs where feet go (worn towards the bare material), darker grime patches
  floor: 'float h = (cN(p * 700.0) - 0.5) * 0.25; float k = 0.0003; float sc = smoothstep(0.55, 0.8, cN(p * vec3(2.2, 1.0, 3.5)) * 0.7 + cN(p * 18.0) * 0.3); float c = 1.0 + sc * 0.28 - smoothstep(0.6, 0.85, cN(p * 4.0 + 7.0)) * 0.18 + (cN(p * 60.0) - 0.5) * 0.1; float r = sc * 0.2 + (cN(p * 30.0) - 0.5) * 0.15;',
};
const _variants = new Map(), _noOBC = THREE.Material.prototype.onBeforeCompile, _noKey = THREE.Material.prototype.customProgramCacheKey;
// a cab's interior meshes onto their surface variants. box: the cab's inner bounds [[x0, y0, z0], [x1, y1, z1]] (part
// space, as the meshes are); fallback: the kind for materials that carry none (painted moulding, gelcoat)
export function cabFinish(meshes, box, { ao = 1, fallback = 'powder', key = '', kinds = null } = {}) {
  for (const m of meshes) {
    const base = m.material; if (!m.isMesh || !base || Array.isArray(base) || !base.isMeshStandardMaterial || base.transparent || base === atlasMat()) continue;
    const kd = kinds?.get(base) || base.userData.cabKind || (base.metalness > 0.8 && base.roughness < 0.2 ? null : fallback); if (!kd) continue;
    const vk = base.uuid + '|' + kd + '|' + key; let v = _variants.get(vk);
    if (!v) {
      v = base.clone(); const bob = base.onBeforeCompile, bkey = base.customProgramCacheKey !== _noKey ? base.customProgramCacheKey() : '';
      const uni = { uCab0: { value: new THREE.Vector3(...box[0]) }, uCab1: { value: new THREE.Vector3(...box[1]) }, uCabAO: { value: ao } };
      v.onBeforeCompile = (sh, r) => {
        if (bob && bob !== _noOBC) bob.call(base, sh, r);
        Object.assign(sh.uniforms, uni);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCabP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCabP = position;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCabP;\n' + NOISE)
          .replace('#include <color_fragment>', `#include <color_fragment>\n{ vec3 p = vCabP; ${KIND[kd]} diffuseColor.rgb *= c * mix(1.0, cabOcc(p), 0.45); }`)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{ vec3 p = vCabP; ${KIND[kd]} roughnessFactor = clamp(roughnessFactor + r, 0.04, 1.0); }`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{ vec3 p = vCabP; ${KIND[kd]} normal = cBump(normal, -vViewPosition, h, k); }`)
          .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n{ float o = cabOcc(vCabP); reflectedLight.indirectDiffuse *= o; reflectedLight.indirectSpecular *= o; }');
      };
      v.customProgramCacheKey = () => 'cab-' + kd + '-' + bkey;
      _variants.set(vk, v);
    }
    m.material = v;
  }
}
// the meshes added to `parent` while fn runs (to finish a cab's interior and leave its outside alone)
export function collect(parent, fn) { const n0 = parent.children.length; fn(); return parent.children.slice(n0); }

// ---------- screens, glass, screws, placards ----------
const screenGlass = () => cached('ckScrGlass', () => new THREE.MeshPhysicalMaterial({ color: 0x0a0c0e, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.14, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4, depthWrite: false }));
// a display inset in its bezel: a housing (depth d) whose front is a frame standing proud of the recessed face, the
// face from the atlas, a glass with a sheen over it, two screws
export function screen(bag, nb, m, w, h, tile, { d = 0.03, border = 0.014, housing = blackM() } = {}) {
  const W = w + 2 * border, H = h + 2 * border;
  box(bag, m, [0, 0, (d - 0.008) / 2], [W, H, d - 0.008], housing);
  for (const [cx, cy, sw, sh] of [[0, (H - border) / 2, W, border], [0, -(H - border) / 2, W, border], [(W - border) / 2, 0, border, h], [-(W - border) / 2, 0, border, h]]) box(bag, m, [cx, cy, d - 0.004], [sw, sh, 0.008], housing);
  face(nb, m, w, h, tile, d - 0.0075);
  const gl = new THREE.PlaneGeometry(w, h); gl.applyMatrix4(at(m, 0, 0, d - 0.005)); nb.add(gl, screenGlass());
  screws(nb, m, W - border, H - border, d + 0.0005, 2);
}
export const screwM = () => cached('ckScrew', () => new THREE.MeshStandardMaterial({ color: 0x9a9fa6, metalness: 1, roughness: 0.35 }));
// screw heads at a plate's corners: w x h apart, at z off; n: 4 corners or 2 (diagonal)
export function screws(bag, m, w, h, off = 0.003, n = 4) {
  for (const [sx, sy] of [[-1, -1], [1, 1], [-1, 1], [1, -1]].slice(0, n)) { const g = new THREE.CylinderGeometry(0.0042, 0.0045, 0.0022, 8); g.rotateX(Math.PI / 2); g.applyMatrix4(at(m, sx * w / 2, sy * h / 2, off)); bag.add(g, screwM()); }
}
// a gauge glass: a faint sheen over a dial
export function gaugeGlass(bag, m, r) { const g = new THREE.CircleGeometry(r, 20); g.applyMatrix4(at(m, 0, 0, 0.0075)); bag.add(g, screenGlass()); }
// a placard / sticker from the atlas's placard strip (k: 0 caution, 1 fire extinguisher, 2 data plate, 3 kill switch)
export function placard(bag, m, w, h, k) { const g = new THREE.PlaneGeometry(w, h), [x, y] = TILE.placard, uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + (k % 2) * 128 + uv.getX(i) * 128) / S, 1 - (y + Math.floor(k / 2) * 64 + (1 - uv.getY(i)) * 64) / S);
  g.applyMatrix4(at(m, 0, 0, 0.0012)); bag.add(g, atlasMat()); }
// seam lines: thin dark grooves along points (panel joints, door gaps)
export function seam(bag, pts, w = 0.003) { for (let i = 0; i < pts.length - 1; i++) bag.add(bar(pts[i], pts[i + 1], w, w), seamM()); }
export const seamM = () => cached('ckSeam', () => new THREE.MeshStandardMaterial({ color: 0x08090a, metalness: 0, roughness: 0.9 }));
