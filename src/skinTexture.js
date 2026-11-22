// The aircraft skin's detail texture (see planeMaterials.js), painted on canvases. Its own module, needing nothing but
// noise.js, so a worker can paint it (skinWorker.js) while the main thread builds the vehicle; the page paints it
// itself only where workers can't draw (no OffscreenCanvas).
import { makeNoise, mulberry32 } from './noise.js';

export const SKIN_TEX_SIZE = 1024;
export const SKIN_TILE = 2.4; // metres covered by one tile of the panel texture

// One RGBA texture drives three maps: R = height (bump) and seam/rivet occlusion (aoMap), G = roughness factor.
// Layout (1 tile = 2.4 m): two rows of skin panels 1.2 m tall, 0.6 m frame spacing, staggered like real skins,
// rivet rows along every seam and along the middle stringer, plus a few screwed access panels and a filler cap.
// mk(): a new SKIN_TEX_SIZE square canvas (a document one or an OffscreenCanvas). Returns the ImageData.
export function paintSkinDetail(mk) {
  const S = SKIN_TEX_SIZE;
  const px = S / SKIN_TILE; // pixels per metre
  const hC = mk(), rC = mk();
  const h = hC.getContext('2d'), r = rC.getContext('2d');
  h.fillStyle = '#fff'; h.fillRect(0, 0, S, S);
  // roughness: per-panel variation + soft grime
  const rnd = mulberry32(11);
  r.fillStyle = 'rgb(200,200,200)'; r.fillRect(0, 0, S, S);
  const row = 1.2 * px, frame = 0.6 * px;
  for (let ry = 0; ry < 2; ry++) for (let k = 0; k < 4; k++) {
    const x0 = k * frame + (ry ? frame / 2 : 0), y0 = ry * row, v = 180 + rnd() * 50;
    r.fillStyle = `rgb(${v},${v},${v})`;
    for (const dx of [0, -S]) r.fillRect(x0 + dx, y0, frame, row);
  }
  // seams: a groove a few mm wide with a soft shoulder (wrapping at the tile edges)
  const line = (ctx, x0, y0, x1, y1, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { ctx.beginPath(); ctx.moveTo(x0 + ox, y0 + oy); ctx.lineTo(x1 + ox, y1 + oy); ctx.stroke(); } };
  const seam = (x0, y0, x1, y1) => { line(h, x0, y0, x1, y1, 5, 'rgb(215,215,215)'); line(h, x0, y0, x1, y1, 2.2, 'rgb(135,135,135)'); line(r, x0, y0, x1, y1, 4, 'rgb(255,255,255)'); };
  const dot = (ctx, x, y, rad, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(((x % S) + S) % S, ((y % S) + S) % S, rad, 0, 7); ctx.fill(); };
  const rivets = (x0, y0, x1, y1, step = 0.045 * px) => {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / step));
    for (let i = 0; i <= n; i++) { const t = i / n; dot(h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.3, 'rgb(170,170,170)'); }
  };
  const off = 0.022 * px;
  for (const y of [0, row]) { seam(0, y, S, y); rivets(0, y + off, S, y + off); rivets(0, y - off, S, y - off); }
  for (let ry = 0; ry < 2; ry++) for (let k = 0; k < 4; k++) {
    const x = k * frame + (ry ? frame / 2 : 0), y0 = ry * row, y1 = y0 + row;
    seam(x, y0, x, y1); rivets(x + off, y0 + off, x + off, y1 - off); rivets(x - off, y0 + off, x - off, y1 - off);
  }
  for (const y of [row / 2, row * 1.5]) rivets(0, y, S, y, 0.06 * px); // stringer rows
  // access panels (rounded rectangles with screws) and a filler cap
  const hatch = (cx, cy, w, hh) => {
    h.strokeStyle = 'rgb(110,110,110)'; h.lineWidth = 2; h.beginPath(); h.roundRect(cx - w / 2, cy - hh / 2, w, hh, 6); h.stroke();
    r.strokeStyle = '#fff'; r.lineWidth = 3; r.beginPath(); r.roundRect(cx - w / 2, cy - hh / 2, w, hh, 6); r.stroke();
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 1]) dot(h, cx + sx * (w / 2 - 6), cy + sy * (hh / 2 - 6), 1.8, 'rgb(120,120,120)');
  };
  hatch(0.3 * px, 0.32 * px, 0.26 * px, 0.16 * px);
  hatch(1.62 * px, 1.75 * px, 0.36 * px, 0.2 * px);
  hatch(2.05 * px, 0.85 * px, 0.14 * px, 0.14 * px);
  h.strokeStyle = 'rgb(100,100,100)'; h.lineWidth = 2; h.beginPath(); h.arc(0.95 * px, 2.0 * px, 0.05 * px, 0, 7); h.stroke();
  // wear (B): paint chipped to bare metal where hands and tools go: round the access panels, the filler cap and
  // along a few seams (kept sparse: the tile repeats over the whole aircraft)
  const wC = mk(); const w = wC.getContext('2d');
  w.fillStyle = '#000'; w.fillRect(0, 0, S, S);
  const chips = (x0, y0, x1, y1, n, size) => { for (let i = 0; i < n; i++) { const t = rnd(), x = x0 + (x1 - x0) * t + (rnd() - 0.5) * 8, y = y0 + (y1 - y0) * t + (rnd() - 0.5) * 8, rr = size * (0.3 + rnd()); w.fillStyle = `rgb(0,0,${150 + rnd() * 105 | 0})`; w.beginPath(); w.ellipse(((x % S) + S) % S, ((y % S) + S) % S, rr, rr * (0.4 + rnd() * 0.6), rnd() * 3, 0, 7); w.fill(); } };
  const ring = (cx, cy, ww, hh, n) => { chips(cx - ww / 2, cy - hh / 2, cx + ww / 2, cy - hh / 2, n, 2.2); chips(cx - ww / 2, cy + hh / 2, cx + ww / 2, cy + hh / 2, n, 2.2); chips(cx - ww / 2, cy - hh / 2, cx - ww / 2, cy + hh / 2, n / 2, 2.2); chips(cx + ww / 2, cy - hh / 2, cx + ww / 2, cy + hh / 2, n / 2, 2.2); };
  ring(0.3 * px, 0.32 * px, 0.26 * px, 0.16 * px, 14); ring(1.62 * px, 1.75 * px, 0.36 * px, 0.2 * px, 16); ring(2.05 * px, 0.85 * px, 0.14 * px, 0.14 * px, 8);
  for (let i = 0; i < 26; i++) { const a = rnd() * 7; chips(0.95 * px + Math.cos(a) * 0.06 * px, 2.0 * px + Math.sin(a) * 0.06 * px, 0.95 * px + Math.cos(a) * 0.075 * px, 2.0 * px + Math.sin(a) * 0.075 * px, 1, 2.5); }
  chips(0.6 * px, 0, 0.6 * px, row, 30, 1.8); chips(0, row, S * 0.4, row, 26, 1.6);
  // combine (R = height/AO, G = roughness with low-frequency grime)
  const H = h.getImageData(0, 0, S, S).data, R = r.getImageData(0, 0, S, S).data, W = w.getImageData(0, 0, S, S).data;
  const img = h.createImageData(S, S), o = img.data, n = makeNoise(5);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
    const g = n.fbm(Math.cos(a) * 1.3 + 7, Math.sin(a) * 1.3 + Math.cos(b) * 1.1, 4) * 0.5 + n.fbm(Math.sin(b) * 2.2 + 3, Math.cos(b) * 2.2 + Math.sin(a) * 0.8, 3) * 0.5;
    o[i] = H[i]; o[i + 1] = Math.min(255, Math.max(0, R[i] * (0.92 + g * 0.25))); o[i + 2] = W[i + 2]; o[i + 3] = 255;
  }
  return img;
}
