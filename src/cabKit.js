// Cab kit: the small furniture of enclosed cabs (the monster truck's cab, the fireboat's wheelhouse, the helicopter's
// bubble), taken from what real ones carry: instrument faces, screens, radios and switch panels, all drawn on one
// texture atlas so a whole dashboard is one material (one draw call, a little self-lit like a real backlit panel);
// gauges with bezels, toggle switches and knobs as geometry where the eye goes; a racing containment seat, harness
// webbing and foam padding for roll-cage tubes.
//
// Faces are placed with a matrix whose local +Z points out of the panel towards the viewer (faceM), so a face built in
// local XY (a PlaneGeometry, a CircleGeometry) lies flat on the panel.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { V, ringLoft, pipe, bar } from './partDetail.js';

const cache = new Map();
const cached = (k, make) => { if (!cache.has(k)) cache.set(k, make()); return cache.get(k); };

// ---------- the atlas ----------
const S = 1024;
// tile rects [x, y, w, h] in atlas pixels (canvas y down)
export const TILE = {
  gauge: [0, 0, 256, 256], tach: [256, 0, 256, 256], chart: [512, 0, 256, 256], radar: [768, 0, 256, 256],
  engine: [0, 256, 256, 256], switches: [256, 256, 512, 256], vhf: [768, 256, 256, 128], monitor: [768, 384, 256, 128],
  avionics: [0, 512, 256, 512], annun: [256, 512, 256, 64], heliSw: [256, 576, 256, 128], digi: [512, 512, 256, 128],
  ai: [768, 512, 256, 256], alt: [512, 640, 256, 256], compass: [256, 704, 256, 256], plate: [768, 768, 256, 256],
};
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
    const na = a0 + span * (o.at ?? 0.3); g.strokeStyle = o.needle || '#f4f4f0'; g.lineWidth = w * 0.025; g.beginPath(); g.moveTo(cx - Math.cos(na) * R * 0.15, cy - Math.sin(na) * R * 0.15); g.lineTo(cx + Math.cos(na) * R * 0.82, cy + Math.sin(na) * R * 0.82); g.stroke();
    g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, w * 0.04, 0, 7); g.fill();
  };
  const rr = (x, y, w, h, r, fill, stroke, lw = 2) => { g.beginPath(); g.roundRect(x, y, w, h, r); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
  g.fillStyle = '#1b1c1f'; g.fillRect(0, 0, S, S);
  dial(TILE.gauge, { red: 0.82, nums: [0, 20], n: 6, label: 'PSI', at: 0.42 });
  dial(TILE.tach, { red: 0.78, nums: [0, 1], n: 9, label: 'RPM x1000', at: 0.12, needle: '#ff6a1a' });
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
  dial(TILE.alt, { nums: [0, 1], n: 9, label: 'ALT', at: 0.55 });
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
export function gauge(bag, m, r, tile = 'gauge', bezel = null) {
  const d = toTile(new THREE.CircleGeometry(r, 24), tile); d.applyMatrix4(at(m, 0, 0, 0.002)); bag.add(d, atlasMat());
  const ring = new THREE.TorusGeometry(r * 1.04, r * 0.12, 6, 24); ring.applyMatrix4(at(m, 0, 0, 0.004)); bag.add(ring, bezel || blackM());
  const can = new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.012, 20, 1, true); can.rotateX(Math.PI / 2); can.applyMatrix4(at(m, 0, 0, -0.004)); bag.add(can, bezel || blackM());
}
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
export const blackM = () => cached('ckBlack', () => new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.2, roughness: 0.55 }));
export const satinBlack = () => cached('ckSatin', () => new THREE.MeshStandardMaterial({ color: 0x1d1e21, metalness: 0.1, roughness: 0.7 }));
// powder-coated / anodised sheet aluminium (dash panels, door cards, floor plates)
export const sheetAlu = (c = 0x9aa0a8) => cached('ckAlu' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0.85, roughness: 0.42, roughnessMap: brushed() }));
export const carbon = () => cached('ckCarbon', () => { const t = carbonTex(); return new THREE.MeshPhysicalMaterial({ color: 0x2a2c30, map: t, metalness: 0.2, roughness: 0.38, clearcoat: 0.9, clearcoatRoughness: 0.12 }); });
// suede / race fabric (seat inserts, harness pads)
export const suede = (c = 0x202124) => cached('ckSuede' + c, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.95, sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.25, 0.25, 0.25) }));
export const webbing = (c) => cached('ckWeb' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.8 }));
export const foam = (c = 0x1a1b1d) => cached('ckFoam' + c, () => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.98 }));
// diamond tread plate (a race truck's floor): a bump map of raised diamonds on brushed aluminium, box uvs (repeat set per use)
export const treadPlate = () => cached('ckTread', () => {
  const W = 128, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W); g.fillStyle = '#fff';
  for (const [x, y, a] of [[32, 32, 0.6], [96, 96, 0.6], [96, 32, -0.6], [32, 96, -0.6]]) { g.save(); g.translate(x, y); g.rotate(a); g.beginPath(); g.ellipse(0, 0, 22, 5, 0, 0, 7); g.fill(); g.restore(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(30, 30);
  return new THREE.MeshStandardMaterial({ color: 0xb4b9c0, metalness: 0.9, roughness: 0.35, bumpMap: t, bumpScale: 3, roughnessMap: brushed() });
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
// A racing containment seat on the same surfaces a seatGeo(w, backH, panL, tilt) placed at `at` declares (crew.js
// seatSurfaces: the cushion's top at at.y + 0.02 + 0.126 w, the back's front face through (at.y, at.z + 0.02) raked back
// by tilt), so the crew sit on it exactly as before: a moulded shell behind the back whose sides wrap forward (rib
// bolsters low down, wide shoulder wings outside the arms, head wings either side of the helmet), a padded insert on
// the back, a cushion pan with raised thigh bolsters, the harness slots. prof(s) gives the shell's [half-width, forward
// wrap] at s metres up the back's line; top: how far up it goes. Returns the head wings as obstacles (part space).
export function raceSeat(bag, at, [w, backH, panL, tilt], { prof, top, shell = carbon(), pad = suede(), slots = 0.72, headPad = null } = {}) {
  const [ax, ay, az] = at, sn = Math.sin(tilt), cs = Math.cos(tilt), pt = ay + 0.02 + 0.126 * w, th = 0.028, db = 0.055;
  const P = (x, s, d) => V(ax + x, ay + s * cs - d * sn, az + 0.02 + s * sn + d * cs); // x across, s up the back's line, d behind its face
  const rings = [], N = 16, sec = (s) => { const [hw, f] = prof(s); return [[-hw, -f], [-hw - 0.006, 0.02], [-hw * 0.7, db], [0, db + 0.004], [hw * 0.7, db], [hw + 0.006, 0.02], [hw, -f], [hw - th, -f], [hw - th, 0.016], [0, 0.02], [-(hw - th), 0.016], [-(hw - th), -f]]; };
  for (let i = 0; i <= N; i++) { const s = top * (i / N); rings.push(sec(s).map(([x, d]) => P(x, s, d))); }
  bag.add(ringLoft(rings), shell);
  // its ends: the U section triangulated (a fan from the middle folds over a U), both ways round
  for (const s of [0, top]) { const q = sec(s), tris = THREE.ShapeUtils.triangulateShape(q.map(([x, d]) => new THREE.Vector2(x, d)), []), pos = [];
    for (const t of tris) for (const k of [t[0], t[1], t[2], t[0], t[2], t[1]]) { const p = P(q[k][0], s, q[k][1]); pos.push(p.x, p.y, p.z); }
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.computeVertexNormals(); bag.add(cg, shell); }
  // the back's padded insert (its face on the declared surface)
  { const s0 = 0.05, s1 = Math.min(backH + 0.12, top - 0.28), g = new THREE.BoxGeometry(w * 0.62, s1 - s0, 0.02, 1, 1, 1); g.translate(0, (s0 + s1) / 2, 0.01); g.rotateX(tilt); g.translate(ax, ay, az + 0.02); bag.add(g, pad); }
  // the pan: a shell tub with thigh bolsters, the cushion's top on the declared height
  { const rs = [], hw = prof(0)[0] - 0.01;
    for (let k = 0; k <= 6; k++) { const t = k / 6, z = az + 0.03 - panL * t, bol = 0.05 - 0.03 * t, y0 = pt - 0.095;
      rs.push([V(ax - hw, pt + bol, z), V(ax - hw + 0.065, pt - 0.016, z), V(ax + hw - 0.065, pt - 0.016, z), V(ax + hw, pt + bol, z), V(ax + hw, y0, z), V(ax - hw, y0, z)]); }
    bag.add(ringLoft(rs, true, true), shell);
    const cu = new THREE.BoxGeometry(2 * hw - 0.14, 0.016, panL * 0.92); cu.translate(ax, pt - 0.008, az + 0.03 - panL * 0.48); bag.add(cu, pad); }
  // head pad on the shell behind the helmet, belt slots through the back at shoulder height
  if (headPad) { const g = new THREE.CapsuleGeometry(0.05, 0.1, 4, 10); g.rotateZ(Math.PI / 2); g.scale(1, 1, 0.4); const c = P(0, headPad, 0.0); g.rotateX(tilt); g.translate(c.x, c.y, c.z); bag.add(g, pad); }
  for (const sx of [-1, 1]) { const g = new THREE.BoxGeometry(0.065, 0.016, 0.03); g.rotateX(tilt); const c = P(sx * 0.075, slots, 0.03); g.translate(c.x, c.y, c.z); bag.add(g, blackM()); }
  // obstacles: the head wings (where the shell's sides reach forward round the head)
  const obs = []; let s0 = null;
  for (let i = 0; i <= N; i++) { const s = top * (i / N); if (prof(s)[1] > 0.1 && s > backH) { s0 ??= s; } }
  if (s0 != null) { const [hw, f] = prof(top - 0.01), sm = (s0 + top) / 2; for (const sx of [-1, 1]) { const c = P(sx * (hw - th / 2), sm, -f / 2); obs.push({ name: 'head wing', box: c.toArray(), size: [th + 0.01, top - s0, f], rot: [tilt, 0, 0], parts: ['head'] }); } }
  return { panTop: pt, P, obs };
}
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
