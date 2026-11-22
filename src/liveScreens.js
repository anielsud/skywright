// What the live glass cockpit screens draw (liveDisplays.LivePanel.screen: each draw(ctx, S, w, h) is called ~10 times
// a second while the cockpit is watched, into its region of the panel's shared canvas): the fighter's MFDs (a radar
// situation page with the aircraft about, a moving map with the engine), its master caution / AB and gear lights, the
// SR-71's triple display, the airliner's primary flight display, navigation display and engine display (with the gear
// and the flaps). S: liveDisplays.signals (S.env: main.js's world, traffic and net, for the map and the contacts).
const D2R = Math.PI / 180;
const T = (c, s, x, y, px, col, al = 'center', w = 'bold', font = 'monospace') => { c.font = `${w} ${px}px ${font}`; c.textAlign = al; c.textBaseline = 'middle'; c.fillStyle = col; c.fillText(s, x, y); };
const worldHdg = (S) => S.hdg - (S.north || 0) * D2R; // (the heading in the world's frame: S.hdg is the compass's)
const hdgDeg = (S) => Math.round(((S.hdg * 180 / Math.PI) % 360 + 360) % 360) % 360 || 360;
// other aircraft and balloons about: the traffic's circuit plane and helicopter, its balloons, other players
export function contacts(S) {
  const E = S.env, out = []; if (!E) return out;
  const tr = E.traffic; if (tr) {
    if (tr.pattern?.obj) out.push({ x: tr.pattern.obj.position.x, y: tr.pattern.obj.position.y, z: tr.pattern.obj.position.z, k: 'air' });
    if (tr.heli?.g) out.push({ x: tr.heli.g.position.x, y: tr.heli.g.position.y, z: tr.heli.g.position.z, k: 'heli' });
    for (const b of tr.balloons || []) out.push({ x: b.position.x, y: b.position.y, z: b.position.z, k: 'balloon' });
  }
  for (const p of E.net?.players?.values?.() || []) { const a = p.remote?.ac; if (a && a.root.visible && !a.dead) out.push({ x: a.x.x, y: a.x.y, z: a.x.z, k: 'player' }); }
  return out;
}
// a world point relative to the aircraft, heading up: [right, ahead] (metres)
const rel = (S, x, z) => { const h = worldHdg(S), dx = x - S.x, dz = z - S.z; return [dx * Math.cos(h) + dz * Math.sin(h), dx * Math.sin(h) - dz * Math.cos(h)]; };
// the map tiles under a circle round the aircraft, heading up (hud's minimap: maptiles.view, no extra building)
function mapUnder(c, S, cx, cy, Rpx, range, alpha = 0.8) {
  const V = S.env?.world?.mapTiles?.view?.(S.x, S.z); if (!V) return;
  const k = Rpx / range; c.save(); c.globalAlpha = alpha; c.translate(cx, cy); c.rotate(-worldHdg(S)); c.drawImage(V.c, (V.x0 - S.x) * k, (V.z0 - S.z) * k, V.span * k, V.span * k); c.restore();
}

// ---------- the fighter ----------
const G = '#5dff7a', GD = '#2c8a42';
const osb = (c, w, h, top, bot) => { top.forEach((s, i) => T(c, s, 58 - 36 + i * 35 * (w - 44) / 184 + 8, 10, 9, G)); bot.forEach((s, i) => T(c, s, 58 - 36 + i * 35 * (w - 44) / 184 + 8, h - 10, 9, G)); };
// the left MFD: a heading-up situation page (the fire-control radar's 120 degree sweep), range arcs, contacts with
// their altitudes in thousands of feet
export function fighterRadar(c, S, w, h) {
  c.fillStyle = '#020604'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h - 30, R = h - 58, range = 40000;
  c.strokeStyle = GD; c.lineWidth = 1.5;
  for (const k of [0.25, 0.5, 0.75, 1]) { c.beginPath(); c.arc(cx, cy, R * k, -Math.PI * 5 / 6, -Math.PI / 6); c.stroke(); }
  for (const a of [-60, -30, 0, 30, 60]) { const t = (a - 90) * D2R; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); c.stroke(); }
  // the sweep: a bar going back and forth
  { const sw = Math.sin((S.t || 0) * 1.3) * 60, t = (sw - 90) * D2R; c.strokeStyle = G; c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); c.stroke(); }
  for (const o of contacts(S)) {
    const [rx, fz] = rel(S, o.x, o.z), d = Math.hypot(rx, fz); if (d > range || d < 30) continue;
    const x = cx + (rx / range) * R, y = cy - (fz / range) * R; if (y > cy) continue;
    c.fillStyle = o.k === 'player' ? '#ffd23a' : G; c.fillRect(x - 4, y - 4, 8, 8); T(c, String(Math.max(0, Math.round(o.y * 3.28084 / 1000))), x + 7, y - 7, 10, c.fillStyle, 'left');
  }
  c.fillStyle = G; c.beginPath(); c.moveTo(cx, cy - 8); c.lineTo(cx - 6, cy + 6); c.lineTo(cx + 6, cy + 6); c.fill();
  T(c, '40', 30, 34, 11, G, 'left'); T(c, `${String(hdgDeg(S)).padStart(3, '0')}`, cx, 30, 12, G);
  osb(c, w, h, ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL'], ['DTE', 'TEST', 'FLIR', 'TFR', 'SWAP']);
}
// the right MFD: a heading-up moving map with the route and range ring, the engine (rpm %, FTIT, fuel flow) along the
// bottom
export function fighterMap(c, S, w, h) {
  c.fillStyle = '#020604'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.58, R = h * 0.42, range = 8000;
  c.save(); c.beginPath(); c.rect(4, 22, w - 8, h - 70); c.clip(); mapUnder(c, S, cx, cy, R, range, 0.85); c.restore();
  c.strokeStyle = G; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(cx, cy - 9); c.lineTo(cx - 7, cy + 7); c.lineTo(cx, cy + 3); c.lineTo(cx + 7, cy + 7); c.fill();
  c.fillStyle = '#020604'; c.fillRect(0, h - 48, w, 48);
  const n = Math.round((S.n1 || 0) * 100), ftit = Math.round(300 + 600 * (S.egtJ || 0));
  T(c, `RPM ${n}%`, 12, h - 36, 12, G, 'left'); T(c, `FTIT ${ftit}`, w - 12, h - 36, 12, G, 'right');
  c.strokeStyle = GD; c.strokeRect(12, h - 26, w - 24, 8); c.fillStyle = S.ab ? '#ffb020' : G; c.fillRect(12, h - 26, (w - 24) * Math.min(1, n / 100), 8);
  T(c, `${String(hdgDeg(S)).padStart(3, '0')}`, cx, 12, 12, G); T(c, '4 NM', 12, 32, 10, G, 'left');
  T(c, S.ab ? 'AB' : 'MIL', w - 12, 32, 10, S.ab ? '#ffb020' : G, 'right');
}
// a lamp legend, lit or dark (the dark one's lettering faint)
function legend(c, x, y, w, h, lines, on, col) {
  c.fillStyle = on ? col : '#1a1408'; c.fillRect(x, y, w, h);
  lines.forEach((s, i) => T(c, s, x + w / 2, y + h * (i + 1) / (lines.length + 1), Math.min(h / (lines.length + 0.6), w / (s.length * 0.62)), on ? '#1a1200' : '#4a3d22', 'center', 'bold', 'Helvetica, Arial, sans-serif'));
}
// the master caution (stall, over-g) over the afterburner light
export function cautionLamps(c, S, w, h) {
  c.fillStyle = '#101113'; c.fillRect(0, 0, w, h);
  const warn = S.stall || (S.g || 1) > 7.5 || (S.g || 1) < -2.5, blink = ((S.t || 0) * 3) % 1 < 0.6;
  legend(c, 3, 3, w - 6, h * 0.55 - 4, ['MASTER', 'CAUTION'], warn && blink, '#ffb020');
  legend(c, 3, h * 0.55 + 2, w - 6, h * 0.45 - 5, ['AB'], !!S.ab, '#ff7a1a');
}
// the gear's three greens (down and locked), a red light while it moves
export function gearLamps(c, S, w, h) {
  c.fillStyle = '#101113'; c.fillRect(0, 0, w, h);
  for (const [x, y] of [[w / 2, h * 0.3], [w * 0.22, h * 0.72], [w * 0.78, h * 0.72]]) { c.fillStyle = S.gearDown ? '#41ff5a' : '#0e2412'; c.beginPath(); c.arc(x, y, h * 0.2, 0, 7); c.fill(); }
  if (S.gearMove) { c.fillStyle = '#ff3a2a'; c.fillRect(w * 0.42, h * 0.62, w * 0.16, h * 0.2); }
}

// ---------- the SR-71: its triple display (KEAS, Mach, altitude) ----------
export function sr71Triple(c, S, w, h) {
  c.fillStyle = '#222428'; c.fillRect(0, 0, w, h);
  [['KEAS', Math.round(S.kt)], ['MACH', (S.mach || 0).toFixed(2)], ['ALT', Math.round(S.alt / 10) * 10]].forEach(([k, v], i) => {
    const y = 4 + i * (h - 8) / 3; c.fillStyle = '#05070a'; c.fillRect(8, y + 2, w - 16, (h - 8) / 3 - 4);
    T(c, `${k} ${v}`, w / 2, y + (h - 8) / 6, (h - 8) / 3 - 10, '#ffb347');
  });
}

// ---------- the airliner (a 737's displays) ----------
const MAG = '#ff40ff', CY = '#4fd8e8', GR = '#3fe03f', WH = '#ffffff';
// primary flight display: the attitude (sky and ground turning with the bank, the pitch scale moving with the pitch),
// the speed and altitude tapes scrolling, the vertical speed, the heading arc, the mode annunciations
export function airlinerPFD(c, S, w, h) {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const cx = 160, cy = 106, ppd = 4.2; // (pixels per degree of pitch)
  c.save(); c.beginPath(); c.roundRect(80, 36, 160, 136, 16); c.clip();
  c.translate(cx, cy); c.rotate(-S.roll); c.translate(0, S.pitch * 180 / Math.PI * ppd);
  c.fillStyle = '#2470d6'; c.fillRect(-300, -600, 600, 600); c.fillStyle = '#8b5428'; c.fillRect(-300, 0, 600, 600);
  c.strokeStyle = WH; c.lineWidth = 2; c.beginPath(); c.moveTo(-300, 0); c.lineTo(300, 0); c.stroke(); c.lineWidth = 1.5;
  for (let p = -30; p <= 30; p += 2.5) { if (!p) continue; const y = -p * ppd, L = p % 10 === 0 ? 28 : p % 5 === 0 ? 16 : 7; c.beginPath(); c.moveTo(-L, y); c.lineTo(L, y); c.stroke(); if (p % 10 === 0) { T(c, String(Math.abs(p)), -L - 11, y, 10, WH); T(c, String(Math.abs(p)), L + 11, y, 10, WH); } }
  c.restore();
  // the bank scale and its pointer (turning with the bank)
  c.strokeStyle = WH; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, 62, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
  for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { const t = (d - 90) * D2R, l = d % 30 ? 5 : 9; c.beginPath(); c.moveTo(cx + Math.cos(t) * 62, cy + Math.sin(t) * 62); c.lineTo(cx + Math.cos(t) * (62 + l), cy + Math.sin(t) * (62 + l)); c.stroke(); }
  { const t = -S.roll - Math.PI / 2; c.fillStyle = WH; c.beginPath(); c.moveTo(cx + Math.cos(t) * 60, cy + Math.sin(t) * 60); c.lineTo(cx + Math.cos(t + 0.09) * 50, cy + Math.sin(t + 0.09) * 50); c.lineTo(cx + Math.cos(t - 0.09) * 50, cy + Math.sin(t - 0.09) * 50); c.fill(); }
  c.fillStyle = '#111'; c.strokeStyle = '#ffd21a'; c.lineWidth = 2.5; for (const [x, ww] of [[112, 30], [178, 30]]) { c.fillRect(x, 103, ww, 6); c.strokeRect(x, 103, ww, 6); } c.fillRect(157, 103, 6, 6); c.strokeRect(157, 103, 6, 6);
  // tapes: speed (knots, a tick every 10) and altitude (feet, every 100), scrolling past the boxed readouts
  const tape = (x, val, step, ppu, left) => {
    c.save(); c.fillStyle = '#4a4f58'; c.fillRect(x, 36, 50, 136); c.beginPath(); c.rect(x, 36, 50, 136); c.clip(); c.strokeStyle = WH; c.lineWidth = 1.5;
    const v0 = Math.floor((val - 70 / ppu) / step) * step;
    for (let v = v0; v <= val + 70 / ppu; v += step) { if (v < 0) continue; const y = cy - (v - val) * ppu; c.beginPath(); c.moveTo(left ? x + 50 : x, y); c.lineTo(left ? x + 42 : x + 8, y); c.stroke(); if (Math.round(v / step) % 2 === 0) T(c, String(Math.round(v)), x + 25, y, 10, WH); }
    c.restore(); c.fillStyle = '#000'; c.fillRect(x - 2, cy - 11, 54, 22); c.strokeStyle = WH; c.strokeRect(x - 2, cy - 11, 54, 22);
  };
  tape(14, S.kt, 10, 2.0, true); T(c, String(Math.round(S.kt)), 39, cy, 13, WH);
  tape(256, S.alt, 100, 0.2, false); T(c, String(Math.round(S.alt / 20) * 20), 281, cy, 12, WH);
  // vertical speed: a needle in a strip to the right of the altitude tape
  { const x = 309, f = Math.max(-1, Math.min(1, S.vs / 6000)), y = cy - Math.sign(f) * Math.sqrt(Math.abs(f)) * 62; c.fillStyle = '#4a4f58'; c.fillRect(x, 44, 10, 124); c.strokeStyle = WH; c.lineWidth = 2; c.beginPath(); c.moveTo(x + 10, cy); c.lineTo(x, y); c.stroke();
    if (Math.abs(S.vs) > 400) T(c, String(Math.round(S.vs / 50) * 50), 296, S.vs > 0 ? 30 : 182, 9, WH); }
  c.strokeStyle = '#777'; c.lineWidth = 1; for (const [i, s] of ['MCP SPD', 'LNAV', 'VNAV PTH'].entries()) { c.strokeRect(78 + i * 56, 4, 54, 18); T(c, s, 105 + i * 56, 13, 9, GR); }
  // heading arc
  c.save(); c.beginPath(); c.rect(70, 182, 180, 74); c.clip(); c.fillStyle = '#4a4f58'; c.beginPath(); c.arc(160, 296, 100, 0, Math.PI * 2); c.fill();
  const hd = S.hdg * 180 / Math.PI; c.strokeStyle = WH; c.lineWidth = 1.5;
  for (let d = Math.ceil((hd - 45) / 5) * 5; d <= hd + 45; d += 5) { const t = (d - hd - 90) * D2R, l = d % 10 ? 5 : 10; c.beginPath(); c.moveTo(160 + Math.cos(t) * 100, 296 + Math.sin(t) * 100); c.lineTo(160 + Math.cos(t) * (100 - l), 296 + Math.sin(t) * (100 - l)); c.stroke(); if (!(d % 30)) T(c, String((((d / 10) % 36) + 36) % 36), 160 + Math.cos(t) * 82, 296 + Math.sin(t) * 82, 10, WH); }
  c.restore(); c.fillStyle = '#000'; c.fillRect(146, 184, 28, 14); c.strokeStyle = WH; c.strokeRect(146, 184, 28, 14); T(c, String(hdgDeg(S)).padStart(3, '0'), 160, 191, 10, WH);
  if (S.stall) T(c, 'STALL', 160, 150, 14, '#ff3a2a');
}
// navigation display: the map under a heading-up compass arc, range ring, the aircraft, ground speed and heading
export function airlinerND(c, S, w, h) {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const cx = 160, cy = 236, R = 196, range = 20000;
  c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip(); mapUnder(c, S, cx, cy, R, range, 0.55); c.restore();
  const hd = S.hdg * 180 / Math.PI; c.strokeStyle = WH; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R, Math.PI * 1.25, Math.PI * 1.75); c.stroke();
  for (let d = Math.ceil((hd - 46) / 5) * 5; d <= hd + 46; d += 5) { const t = (d - hd - 90) * D2R, l = d % 10 ? 7 : 13; c.beginPath(); c.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); c.lineTo(cx + Math.cos(t) * (R - l), cy + Math.sin(t) * (R - l)); c.stroke(); if (!(d % 30)) T(c, String((((d / 10) % 36) + 36) % 36), cx + Math.cos(t) * (R - 24), cy + Math.sin(t) * (R - 24), 12, WH); }
  c.setLineDash([5, 6]); c.lineWidth = 1.2; c.beginPath(); c.arc(cx, cy, R / 2, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); c.setLineDash([]);
  for (const o of contacts(S)) { const [rx, fz] = rel(S, o.x, o.z), x = cx + (rx / range) * R, y = cy - (fz / range) * R; if (Math.hypot(x - cx, y - cy) > R || y > cy) continue; c.fillStyle = CY; c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.fill(); }
  c.fillStyle = WH; c.beginPath(); c.moveTo(cx, cy - 16); c.lineTo(cx - 9, cy + 6); c.lineTo(cx + 9, cy + 6); c.closePath(); c.strokeStyle = WH; c.lineWidth = 2; c.stroke();
  T(c, `GS ${Math.round((S.spd || 0) * 1.944)}  TAS ${Math.round(S.kt)}`, 6, 12, 12, WH, 'left');
  c.strokeStyle = WH; c.lineWidth = 1.5; c.strokeRect(130, 4, 60, 18); T(c, `HDG ${String(hdgDeg(S)).padStart(3, '0')}`, 160, 13, 11, WH); T(c, 'MAG', 210, 13, 11, GR);
  T(c, '10', cx + 6, cy - R / 2 - 6, 11, WH, 'left');
}
// engine display: N1 and EGT dials for two engines following the thrust levers, fuel flow; the gear's indications and
// the flaps (a 737's upper display shows them beside the engines)
export function airlinerENG(c, S, w, h) {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const dial = (x, y, rad, frac, val) => {
    c.fillStyle = '#5a5a5a'; c.beginPath(); c.moveTo(x, y); c.arc(x, y, rad, Math.PI, Math.PI + Math.max(0.001, frac) * Math.PI * 1.15); c.closePath(); c.fill();
    c.strokeStyle = WH; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y, rad, Math.PI, Math.PI * 2.15); c.stroke(); c.strokeStyle = '#f2453b'; c.beginPath(); c.arc(x, y, rad, Math.PI * 2.1, Math.PI * 2.15); c.stroke();
    const t = Math.PI + frac * Math.PI * 1.15; c.strokeStyle = WH; c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(t) * rad, y + Math.sin(t) * rad); c.stroke();
    c.fillStyle = '#000'; c.fillRect(x - 4, y - 18, 42, 16); c.strokeStyle = WH; c.lineWidth = 1; c.strokeRect(x - 4, y - 18, 42, 16); T(c, val, x + 17, y - 10, 11, WH);
  };
  const n1 = Math.max(0, Math.min(1.05, S.n1 || 0)), egt = 350 + 550 * (S.egtJ || 0);
  T(c, 'TAT +12c', 8, 10, 10, WH, 'left'); T(c, S.thr > 0.9 ? 'TO' : 'CRZ', 150, 10, 10, GR, 'right');
  dial(40, 72, 30, n1, (n1 * 100).toFixed(1)); dial(118, 72, 30, n1 * 0.998, (n1 * 99.8).toFixed(1)); T(c, 'N1', 79, 92, 11, CY);
  dial(40, 150, 26, egt / 1000, String(Math.round(egt))); dial(118, 150, 26, egt / 1004, String(Math.round(egt * 1.006))); T(c, 'EGT', 79, 168, 11, CY);
  const ff = (0.4 + 2.6 * n1 * n1).toFixed(2); [`FF/FU  ${ff}  ${ff}`, 'OIL P   44    45', 'OIL T   88    86', 'FUEL  4.1  4.6  4.1'].forEach((s, i) => T(c, s, 8, 190 + i * 15, 10, i === 3 ? WH : '#cfcfcf', 'left'));
  c.fillStyle = '#000'; c.fillRect(158, 0, 2, h);
  // gear: three boxes (green DOWN, amber in transit, blank up)
  T(c, 'GEAR', 240, 30, 11, CY);
  for (const [x, y] of [[218, 46], [180, 66], [256, 66]]) { const col = S.gearDown ? GR : S.gearMove ? '#ffb020' : null; c.strokeStyle = col || '#444'; c.lineWidth = 1.5; c.strokeRect(x - 18, y - 7, 36, 15); if (col) T(c, S.gearDown ? 'DOWN' : 'TRAN', x, y + 1, 9, col); }
  // flaps: the needle down a scale (UP 1 5 15 30), the setting in green
  { const set = [0, 5, 15, 30][S.flaps || 0] ?? 0, x = 300, y0 = 110, H = 110, f = set / 30; T(c, 'FLAPS', 240, 104, 11, CY); c.strokeStyle = WH; c.lineWidth = 1.5; c.strokeRect(x - 6, y0, 12, H);
    for (const [k, s] of [[0, 'UP'], [5 / 30, '5'], [15 / 30, '15'], [1, '30']]) { c.beginPath(); c.moveTo(x - 10, y0 + k * H); c.lineTo(x - 6, y0 + k * H); c.stroke(); T(c, s, x - 14, y0 + k * H, 9, WH, 'right'); }
    c.fillStyle = WH; c.fillRect(x - 5, y0, 10, f * H); T(c, set ? String(set) : 'UP', 240, 124, 14, GR); }
}
// the gear lever panel's three greens (down and locked), red while the gear moves
export function airlinerGear(c, S, w, h) {
  c.fillStyle = '#4b555f'; c.fillRect(0, 0, w, h);
  for (const [x, y] of [[w / 2, h * 0.28], [w * 0.135, h * 0.77], [w * 0.865, h * 0.77]]) { c.fillStyle = '#0c0d0e'; c.fillRect(x - 8, y - 6, 16, 12); c.fillStyle = S.gearMove ? '#ff3a2a' : S.gearDown ? '#41ff5a' : '#13271a'; c.fillRect(x - 6, y - 4, 12, 8); }
}
