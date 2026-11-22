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
  return out;
}
// other players, every one of them, wherever they are and whatever they are in (plane, car, boat, bike): with their
// name, colour, and whether they are in the air
export function players(S) {
  const out = []; for (const p of S.env?.net?.players?.values?.() || []) { const a = p.remote?.ac; if (!a || a.dead) continue; out.push({ x: a.x.x, y: a.x.y, z: a.x.z, name: p.name || 'Player', color: p.color || '#ffd23a', ground: !!(a.isCar || a.isBoat || a.onGround) }); }
  return out;
}
const NM = 1852;
// a player on a scope centred (cx, cy), radius R px for `range` metres, showing bearings from -arc to +arc off the nose
// (arc = PI: all round): where they are when on it; otherwise on its edge at their bearing (clamped into the arc) as an
// arrow pointing their way, with the distance, so they can always be found. Their name beside either.
function drawPlayer(c, S, p, cx, cy, R, range, arc = Math.PI) {
  const [rx, fz] = rel(S, p.x, p.z), d = Math.hypot(rx, fz), b = Math.atan2(rx, fz), on = d <= range && Math.abs(b) <= arc;
  c.save(); c.fillStyle = c.strokeStyle = p.color; c.lineWidth = 2;
  let x, y;
  if (on) {
    x = cx + (rx / range) * R; y = cy - (fz / range) * R;
    if (p.ground) { c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 6, y + 4.5); c.lineTo(x - 6, y + 4.5); c.closePath(); c.stroke(); } else { c.beginPath(); c.arc(x, y, 5.5, 0, Math.PI * 2); c.fill(); }
    T(c, `${p.name} ${Math.max(0, Math.round(p.y * 3.28084 / 100))}`, x + 9, y - 8, 11, p.color, 'left', 'bold', 'Helvetica, Arial, sans-serif');
  } else {
    const bc = Math.max(-arc, Math.min(arc, b)); x = cx + Math.sin(bc) * R * 0.94; y = cy - Math.cos(bc) * R * 0.94;
    x = Math.max(12, Math.min(2 * cx - 12, x)); y = Math.max(14, y); // (and inside the screen, where a wide scope runs off its sides)
    c.translate(x, y); c.rotate(b); c.beginPath(); c.moveTo(0, -9); c.lineTo(6.5, 4); c.lineTo(0, 1); c.lineTo(-6.5, 4); c.closePath(); c.fill(); c.rotate(-b); // (an arrow along their bearing)
    const dist = d / NM, txt = `${p.name} ${dist < 10 ? dist.toFixed(1) : Math.round(dist)}NM`, k = Math.hypot(cx - x, cy - y) || 1; // (the label inside the scope, towards its centre)
    c.font = 'bold 11px Helvetica, Arial, sans-serif'; const tw = c.measureText(txt).width, lx = ((cx - x) / k) * 16, ly = ((cy - y) / k) * 16;
    T(c, txt, lx + Math.sign(cx - x) * tw * 0.5, ly, 11, p.color, 'center', 'bold', 'Helvetica, Arial, sans-serif');
  }
  c.restore();
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
  for (const p of players(S)) drawPlayer(c, S, p, cx, cy, R, range, Math.PI / 3); // (other players: always, at the scope's edge when out of it)
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
  c.save(); c.beginPath(); c.rect(4, 22, w - 8, h - 70); c.clip(); for (const p of players(S)) drawPlayer(c, S, p, cx, cy, R, range); c.restore();
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
  for (const p of players(S)) drawPlayer(c, S, p, cx, cy, R, range, Math.PI * 0.25);
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

// ---------- what each airliner screen shows, as a key: an unchanged key skips the redraw and the upload ----------
const rk = (v, k) => Math.round(v / k);
export const pfdKey = (S) => `${rk(S.pitch, 0.003)} ${rk(S.roll, 0.004)} ${rk(S.kt, 1)} ${rk(S.alt, 20)} ${rk(S.vs, 50)} ${rk(S.hdg, 0.009)} ${S.stall}`;
export const ndKey = (S) => `${rk(S.hdg, 0.009)} ${rk(S.x, 40)} ${rk(S.z, 40)} ${rk(S.kt, 1)} ${rk(S.t || 0, 1)}`; // (the contacts and players move on: redrawn at least every second)
export const engKey = (S) => `${rk(S.n1 || 0, 0.002)} ${rk(S.egtJ || 0, 0.002)} ${S.gearDown}${S.gearMove} ${S.flaps} ${S.thr > 0.9}`;
export const gearKey = (S) => `${S.gearDown}${S.gearMove}`;
export const attKey = (S) => `${rk(S.pitch, 0.006)} ${rk(S.roll, 0.008)} ${rk(S.kt, 1)} ${rk(S.alt, 10)}`;
// the standby attitude (ISFD): a small ball with the speed and altitude either side
export function airlinerISFD(c, S, w, h) {
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, ppd = 1.6;
  c.save(); c.beginPath(); c.rect(12, 8, w - 24, h - 16); c.clip(); c.translate(cx, cy); c.rotate(-S.roll); c.translate(0, S.pitch * 180 / Math.PI * ppd);
  c.fillStyle = '#2470d6'; c.fillRect(-80, -160, 160, 160); c.fillStyle = '#8b5428'; c.fillRect(-80, 0, 160, 160); c.strokeStyle = WH; c.lineWidth = 1; c.beginPath(); c.moveTo(-80, 0); c.lineTo(80, 0); c.stroke(); c.restore();
  c.fillStyle = '#ffd21a'; c.fillRect(cx - 14, cy - 1, 10, 3); c.fillRect(cx + 4, cy - 1, 10, 3); c.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  T(c, String(Math.round(S.kt)), 2, h - 5, 8, WH, 'left'); T(c, String(Math.round(S.alt / 10) * 10), w - 2, h - 5, 8, WH, 'right');
}

// ---------- round 3: the rest of the painted displays that have a live value ----------
const rk3 = (v, k) => Math.round(v / k);
const hd360 = (S) => ((S.hdg * 180 / Math.PI) % 360 + 360) % 360;
// a magnetic compass's card seen through its window: the card (cream, black marks) sliding past the lubber line as the
// heading turns; round (a dial's face) or a strip (the hood compass)
export function compassCard(c, S, w, h, round = true) {
  c.fillStyle = '#060708'; c.fillRect(0, 0, w, h);
  c.save(); if (round) { c.beginPath(); c.arc(w / 2, h / 2, w * 0.46, 0, Math.PI * 2); c.clip(); }
  const ppd = w / 60, hd = hd360(S), y0 = h * 0.22, y1 = h * 0.78; // (60 degrees across the window)
  c.fillStyle = '#e8e4d6'; c.fillRect(0, y0, w, y1 - y0);
  for (let d = Math.floor((hd - 35) / 5) * 5; d <= hd + 35; d += 5) {
    const x = w / 2 + (d - hd) * ppd, dd = ((d % 360) + 360) % 360; c.fillStyle = '#111'; c.fillRect(x - 1, y0, 2, dd % 10 ? (y1 - y0) * 0.22 : (y1 - y0) * 0.36);
    if (!(dd % 30)) T(c, ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[dd] ?? String(dd / 10), x, y0 + (y1 - y0) * 0.68, (y1 - y0) * 0.42, '#111', 'center', 'bold', 'Helvetica, Arial, sans-serif');
  }
  c.restore(); c.fillStyle = '#e0412b'; c.fillRect(w / 2 - 1.5, h * 0.12, 3, h * 0.76); // (the lubber line)
}
export const compassKey = (S) => String(rk3(S.hdg, 0.004));
export const compassRound = (c, S, w, h) => compassCard(c, S, w, h, true);
export const compassStrip = (c, S, w, h) => compassCard(c, S, w, h, false);
// a north-up chart plotter (the fireboat's, the race truck's GPS): the map, the vessel's arrow along its course, a
// range ring; speed over the ground, course, and (afloat) the depth along the bottom
export function chartPlotter(c, S, w, h, { range = 1500, water = true } = {}) {
  c.fillStyle = '#1f5fa8'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.46, R = h * 0.42, V = S.env?.world?.mapTiles?.view?.(S.x, S.z), k = R / range;
  if (V) c.drawImage(V.c, cx + (V.x0 - S.x) * k, cy + (V.z0 - S.z) * k, V.span * k, V.span * k);
  c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1.2; c.setLineDash([4, 4]); c.beginPath(); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  const wh = S.hdg - (S.north || 0) * D2R; c.save(); c.translate(cx, cy); c.rotate(wh); c.fillStyle = '#111'; c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(0, -11); c.lineTo(7, 8); c.lineTo(0, 4); c.lineTo(-7, 8); c.closePath(); c.fill(); c.stroke();
  c.strokeStyle = '#ff3b3b'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, -12); c.lineTo(0, -R * 0.9); c.stroke(); c.restore();
  const sp = S.metric ? `${Math.round(S.kmh)} KM/H` : water ? `${(S.spd * 1.944).toFixed(1)} KN` : `${Math.round(S.mph)} MPH`;
  let tail = ''; if (water) { const W = S.env?.world; if (W) { const d = W.waterLevel - W.heightAt(S.x, S.z); tail = `  DPT ${d > 0 ? d.toFixed(0) : '--'}m`; } }
  c.fillStyle = 'rgba(10,14,20,0.85)'; c.fillRect(0, h * 0.9, w, h * 0.1); T(c, `SOG ${sp}  COG ${String(Math.round(hd360(S))).padStart(3, '0')}${tail}`, w / 2, h * 0.95, Math.round(h * 0.055), '#e8e8e2', 'center', 'bold', 'Helvetica, Arial, sans-serif');
}
export const chartKey = (S) => `${rk3(S.x, 6)} ${rk3(S.z, 6)} ${rk3(S.hdg, 0.01)} ${rk3(S.spd, 0.3)} ${S.metric}`;
export const chartBoat = (c, S, w, h) => chartPlotter(c, S, w, h, { range: 1500, water: true });
export const chartRoad = (c, S, w, h) => chartPlotter(c, S, w, h, { range: 2500, water: false });
// a boat's radar: heading up, range rings, land as echoes (the map's land, tinted), other players (always), a sweep
export function boatRadar(c, S, w, h) {
  c.fillStyle = '#05080a'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.45, range = 1400;
  c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
  mapUnder(c, S, cx, cy, R, range, 0.55); c.globalCompositeOperation = 'multiply'; c.fillStyle = '#3cff78'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'source-over';
  const t = (S.t || 0) * 2.4, g = c.createRadialGradient(cx, cy, 0, cx, cy, R); g.addColorStop(0, 'rgba(60,255,120,0.35)'); g.addColorStop(1, 'rgba(60,255,120,0)');
  c.fillStyle = g; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, t - 0.7, t); c.fill(); c.restore();
  c.strokeStyle = '#1f6f3a'; c.lineWidth = 1.5; for (const k of [0.33, 0.66, 1]) { c.beginPath(); c.arc(cx, cy, R * k, 0, Math.PI * 2); c.stroke(); }
  c.strokeStyle = '#7dffa8'; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, cy - R); c.stroke(); T(c, '0.75 NM', 34, 14, 13, '#7dffa8');
  for (const p of players(S)) drawPlayer(c, S, p, cx, cy, R, range);
}
// the sport plane's moving map: heading up, the route (a magenta line ahead), range ring, the aircraft; ground speed,
// track and altitude on top, the soft keys' labels along the bottom
export function planeMap(c, S, w, h) {
  c.fillStyle = '#3d6b3a'; c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.74, R = h * 0.62, range = 6000;
  mapUnder(c, S, cx, cy, R, range, 1);
  c.strokeStyle = '#f0f0e8'; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, R * 0.5, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); T(c, '2', cx + R * 0.5 * Math.cos(-Math.PI * 0.3), cy + R * 0.5 * Math.sin(-Math.PI * 0.3) - 8, 12, '#f0f0e8');
  c.strokeStyle = '#e040e0'; c.lineWidth = 4; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, 30); c.stroke();
  c.fillStyle = '#f8f8f8'; c.beginPath(); c.moveTo(cx, cy - 10); c.lineTo(cx - 9, cy + 8); c.lineTo(cx + 9, cy + 8); c.fill();
  c.fillStyle = '#0a0b0c'; c.fillRect(0, 0, w, 26); c.fillRect(0, h - 22, w, 22);
  T(c, `GS ${Math.round(S.kt)}KT`, 8, 13, 16, '#f2f2ee', 'left', 'bold', 'Helvetica, Arial, sans-serif'); T(c, `TRK ${String(Math.round(hd360(S))).padStart(3, '0')}°`, w / 2, 13, 16, '#e040e0', 'center', 'bold', 'Helvetica, Arial, sans-serif'); T(c, `${Math.round(S.alt / 10) * 10}FT`, w - 8, 13, 16, '#7cf29a', 'right', 'bold', 'Helvetica, Arial, sans-serif');
  ['MAP', 'WPT', 'AUX', 'NRST'].forEach((s, i) => T(c, s, (i + 0.5) * (w / 4), h - 11, 13, '#e8e8e2', 'center', 'bold', 'Helvetica, Arial, sans-serif'));
}
export const planeMapKey = (S) => `${rk3(S.x, 15)} ${rk3(S.z, 15)} ${rk3(S.hdg, 0.008)} ${rk3(S.kt, 1)} ${rk3(S.alt, 10)}`;
// the F-16's caution panels: a grid of legends, each lit while what it warns of is so (amber; NWS green)
const CAUTIONS = [
  [['FLCS', 'FAULT', 0], ['ENGINE', '', (S) => !S.running || (S.engDmg || 0) > 0.5], ['ELEC', 'SYS', (S) => !S.running], ['HYD/OIL', 'PRESS', (S) => !S.running], ['FUEL', 'LOW', 0], ['OVER', 'G', (S) => (S.g || 1) > 7.5 || (S.g || 1) < -2.5],
   ['STALL', '', (S) => S.stall], ['GEAR', 'TRANSIT', (S) => S.gearMove], ['BRAKES', '', (S) => S.brake && S.onGround], ['AB', '', (S) => S.ab], ['ANTI', 'SKID', 0], ['CADC', '', 0],
   ['SEAT NOT', 'ARMED', (S) => S.onGround && !S.running], ['CANOPY', '', 0], ['HOOK', '', 0], ['ECM', '', 0], ['IFF', '', 0], ['NWS', '', (S) => S.onGround, '#41ff5a']],
  [['RADAR', 'ALT', (S) => (S.agl ?? 1e4) < 300 && !S.onGround], ['INLET', 'ICING', 0], ['EQUIP', 'HOT', 0], ['ENG', 'FIRE', (S) => (S.engDmg || 0) > 0.75], ['OXY', 'LOW', 0], ['AVIONICS', '', 0],
   ['FWD FUEL', 'LOW', 0], ['AFT FUEL', 'LOW', 0], ['BUC', '', 0], ['NUCLEAR', '', 0], ['PROBE', 'HEAT', 0], ['ATF NOT', 'ENGAGED', 0],
   ['SPEED', 'BRAKE', (S) => S.brake && !S.onGround], ['DUAL FC', '', 0], ['EEC', '', 0], ['TO/LDG', 'CONFIG', (S) => S.gearDown && !S.onGround && S.kt < 220], ['OBOGS', '', 0], ['MASTER', 'ARM', 0]],
];
export function cautionPanel(side) {
  const L = CAUTIONS[side];
  return (c, S, w, h) => {
    c.fillStyle = '#202225'; c.fillRect(0, 0, w, h);
    const cw = w / 6, chh = h / 3;
    L.forEach(([a, b, on, col = '#ffb020'], i) => {
      const x = (i % 6) * cw + 3, y = Math.floor(i / 6) * chh + 3, ww = cw - 6, hh = chh - 6, lit = typeof on === 'function' && on(S);
      c.fillStyle = lit ? col : '#3a2a12'; c.fillRect(x, y, ww, hh);
      const px = Math.min(hh * (b ? 0.36 : 0.44), ww / (Math.max(a.length, b.length) * 0.62));
      T(c, a, x + ww / 2, y + hh * (b ? 0.32 : 0.5), px, lit ? '#1a1200' : '#8a7550', 'center', 'bold', 'Helvetica, Arial, sans-serif');
      if (b) T(c, b, x + ww / 2, y + hh * 0.7, px, lit ? '#1a1200' : '#8a7550', 'center', 'bold', 'Helvetica, Arial, sans-serif');
    });
  };
}
export const cautionKey = (S) => `${S.running}${(S.engDmg || 0) > 0.5}${(S.engDmg || 0) > 0.75}${(S.g || 1) > 7.5 || (S.g || 1) < -2.5}${S.stall}${S.gearMove}${S.brake}${S.onGround}${S.ab}${S.gearDown}${S.kt < 220}${(S.agl ?? 1e4) < 300}`;
// a boat's binnacle compass card seen from above: the rose turning so north stays north
export function compassRose(c, S, w, h) {
  const cx = w / 2, cy = h / 2, R = w * 0.48; c.fillStyle = '#0a0b0c'; c.fillRect(0, 0, w, h);
  c.save(); c.translate(cx, cy); c.rotate(-hd360(S) * D2R);
  c.fillStyle = '#e8e4d6'; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#111'; c.lineWidth = 1.5;
  for (let d = 0; d < 360; d += 10) { const a = d * D2R, L = d % 30 ? 0.12 : 0.2; c.beginPath(); c.moveTo(Math.sin(a) * R * 0.97, -Math.cos(a) * R * 0.97); c.lineTo(Math.sin(a) * R * (0.97 - L), -Math.cos(a) * R * (0.97 - L)); c.stroke(); }
  for (const [d, s] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) { c.save(); c.rotate(d * D2R); T(c, s, 0, -R * 0.55, R * 0.3, d ? '#111' : '#c41e1e', 'center', 'bold', 'Helvetica, Arial, sans-serif'); c.restore(); }
  c.restore(); c.fillStyle = '#e0412b'; c.fillRect(cx - 1.5, cy - R, 3, R * 0.35); // (the lubber line, at the bow)
}
// the fighter's map page: redrawn when the map under it, the heading or the engine readouts change
export const fighterMapKey = (S) => `${rk3(S.x, 25)} ${rk3(S.z, 25)} ${rk3(S.hdg, 0.008)} ${Math.round((S.n1 || 0) * 100)} ${Math.round(300 + 600 * (S.egtJ || 0))} ${S.ab} ${rk3(S.t || 0, 1)}`;
