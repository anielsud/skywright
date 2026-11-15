// Heads-up display (DOM + small canvases).
import * as THREE from 'three';
import { clamp } from './noise.js';

const UNITS = {
  metric: { spd: 3.6, spdU: 'km/h', alt: 1, altU: 'm', vs: 1, vsU: 'm/s', temp: (c) => c, tempU: '°C' },
  imperial: { spd: 1.94384, spdU: 'kt', alt: 3.28084, altU: 'ft', vs: 196.85, vsU: 'fpm', temp: (c) => c * 1.8 + 32, tempU: '°F' },
};

export class HUD {
  constructor(root) {
    this.root = root; this.units = UNITS.imperial; this.visible = true;
    root.innerHTML = `
      <div class="hud-tl">
        <div class="hud-big"><span id="h-spd">0</span><small id="h-spdu">kt</small></div>
        <div class="hud-row"><label>ALT</label><span id="h-alt">0</span><small id="h-altu">ft</small></div>
        <div class="hud-row"><label>V/S</label><span id="h-vs">0</span><small id="h-vsu">fpm</small></div>
        <div class="hud-row"><label>HDG</label><span id="h-hdg">000</span>°</div>
        <div class="hud-row" id="h-machrow" style="display:none"><label>MACH</label><span id="h-mach">0.00</span></div>
        <div class="hud-row" id="h-skinrow" style="display:none"><label>SKIN</label><span id="h-skin">0</span><small id="h-skinu">°C</small></div>
        <canvas id="h-adi" width="120" height="120"></canvas>
      </div>
      <div class="hud-tc"><div id="h-mission"></div><div id="h-toasts"></div></div>
      <div class="hud-tr">
        <div class="hud-btns"><button id="h-cam" title="Camera (C)">🎥</button><button id="h-pause" title="Pause (Esc)">❚❚</button></div>
        <canvas id="h-map" width="180" height="180"></canvas>
      </div>
      <div class="hud-bc">
        <span class="lamp" id="l-gear">GEAR</span><span class="lamp" id="l-flaps">FLAPS 0</span><span class="lamp" id="l-brake">BRAKE</span>
        <span class="lamp" id="l-smoke">SMOKE</span><span class="lamp warn" id="l-stall">STALL</span><span class="lamp" id="l-ab">AFTERBURNER</span><span class="lamp" id="l-mach" style="display:none">SUPERSONIC</span><span class="lamp" id="l-g">1.0 G</span>
      </div>
      <div class="hud-ctl" id="h-ctl">
        <div class="ctl-thr"><b id="c-thr-v">0%</b><div class="ctl-thr-bar"><div id="c-thr"></div></div><small id="c-thr-l">THR</small><kbd>⇧ / Ctrl</kbd></div>
        <div class="ctl-stick-col"><div class="ctl-stick"><i></i><div id="c-stick"></div></div><div class="ctl-rud"><i></i><div id="c-rud"></div></div><kbd>W A S D · Q E</kbd></div>
      </div>
      <div id="h-arrow"><div></div></div>
      <div id="h-center"></div>
      <div id="fps-meter" style="display:none"></div>`;
    this.$ = (id) => root.querySelector('#' + id);
    this.adi = this.$('h-adi').getContext('2d'); this.map = this.$('h-map').getContext('2d');
    this.toasts = this.$('h-toasts');
    this.mapRange = 5000;
    this.$('h-map').addEventListener('click', () => { this.mapRange = this.mapRange === 5000 ? 12000 : this.mapRange === 12000 ? 2000 : 5000; });
  }
  setUnits(u) { this.units = UNITS[u] || UNITS.imperial; this.$('h-spdu').textContent = this.units.spdU; this.$('h-altu').textContent = this.units.altU; this.$('h-vsu').textContent = this.units.vsU; this.$('h-skinu').textContent = this.units.tempU; }
  toast(text, kind = '') {
    const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = text;
    this.toasts.prepend(d);
    while (this.toasts.children.length > 4) this.toasts.lastChild.remove();
    setTimeout(() => d.classList.add('fade'), 2600); setTimeout(() => d.remove(), 3400);
  }
  center(text, ms = 1800) { const c = this.$('h-center'); c.textContent = text; c.classList.add('show'); clearTimeout(this.ct); this.ct = setTimeout(() => c.classList.remove('show'), ms); }
  show(on) { this.visible = on; this.root.style.display = on ? '' : 'none'; }

  update(ac, world, mission, camera, others) {
    if (!this.visible) return;
    const U = this.units;
    const spd = ac.airspeed || 0;
    this.$('h-spd').textContent = Math.round(spd * U.spd);
    const agl = ac.x.y - Math.max(world.heightAt(ac.x.x, ac.x.z), world.waterLevel);
    this.$('h-alt').textContent = Math.round((ac.x.y) * U.alt) + (agl < 300 ? `  (${Math.round(Math.max(0, agl - 2) * U.alt)} AGL)` : '');
    this.$('h-vs').textContent = Math.round(ac.v.y * U.vs);
    const f = ac.forward; let hdg = Math.round(THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z)) + 360) % 360;
    this.$('h-hdg').textContent = String(hdg).padStart(3, '0');
    // Mach number and skin temperature (shown once they get interesting)
    const M = ac.mach || 0, skin = ac.skinC ?? 15;
    this.$('h-machrow').style.display = M > 0.5 ? '' : 'none';
    if (M > 0.5) { const m = this.$('h-mach'); m.textContent = M.toFixed(2); m.style.color = M >= 1 ? '#ffd400' : M > 0.85 ? '#cfe8ff' : ''; }
    this.$('h-skinrow').style.display = skin > 45 ? '' : 'none';
    if (skin > 45) { const t = this.$('h-skin'); t.textContent = Math.round(U.temp(skin)); t.style.color = skin > 900 ? '#fff4d6' : skin > 500 ? '#ff9a3d' : skin > 220 ? '#ff5a3d' : ''; }
    const L = (id, on, txt) => { const e = this.$(id); e.classList.toggle('on', !!on); if (txt) e.textContent = txt; };
    L('l-gear', ac.hasRetract ? ac.gearDown : false, ac.hasRetract ? (ac.gearT > 0.95 ? 'GEAR DOWN' : ac.gearT < 0.05 ? 'GEAR UP' : 'GEAR ···') : 'FIXED GEAR');
    this.$('l-gear').style.display = ac.parts.some((p) => p.gear && p.alive) ? '' : 'none';
    L('l-flaps', ac.flaps > 0, `FLAPS ${[0, 10, 20, 35][ac.flaps]}°`);
    L('l-brake', ac.brake > 0.5);
    this.$('l-smoke').style.display = ac.hasSmoke ? '' : 'none'; L('l-smoke', ac.smokeOn);
    this.$('l-stall').style.display = ac.stalled ? '' : 'none';
    const ab = ac.parts.some((p) => p.alive && p.engine && (p.engine.abOn || p.engine.burning));
    this.$('l-ab').style.display = ab ? '' : 'none'; L('l-ab', ab, ac.parts.some((p) => p.alive && p.engine?.burning) ? `ROCKET ${Math.max(0, Math.min(...ac.parts.filter((p) => p.alive && p.engine?.burning).map((p) => p.engine.burn))).toFixed(0)}s` : 'AFTERBURNER');
    this.$('l-mach').style.display = M >= 1 && !ac.dead ? '' : 'none'; L('l-mach', M >= 1);
    const ge = this.$('l-g'); ge.textContent = `${ac.g.toFixed(1)} G`; ge.classList.toggle('warn', Math.abs(ac.g) > 6);
    this.$('h-mission').textContent = mission?.hud ? mission.hud() : '';
    this.drawADI(ac); this.drawMap(ac, world, mission, others);
    this.updateControls(ac);
    // arrow to target
    const arrow = this.$('h-arrow');
    const tgt = mission?.target?.();
    if (tgt) {
      const v = tgt.clone().project(camera);
      const behind = v.z > 1;
      const onScreen = !behind && Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9;
      arrow.style.display = onScreen ? 'none' : '';
      if (!onScreen) { let x = v.x, y = v.y; if (behind) { x = -x; y = -y; } const a = Math.atan2(-y, x); arrow.style.transform = `translate(-50%,-50%) rotate(${a}rad)`; }
    } else arrow.style.display = 'none';
  }
  // What the pilot is commanding right now (keyboard / gamepad players have no on-screen stick or throttle).
  // Hidden by CSS while the touch controls are showing, since those already show it.
  updateControls(ac) {
    const c = ac.ctl, t = clamp(c.throttle, 0, 1), P = 26; // stick travel in px
    const v = t > 0.995 ? 'MAX' : `${Math.round(t * 100)}%`;
    if (v !== this.ctlV) { this.ctlV = v; this.$('c-thr-v').textContent = v; this.$('c-thr').style.height = `${t * 100}%`; }
    const lbl = ac.isHeli ? 'LIFT' : ac.isCar ? 'GAS' : 'THR';
    if (lbl !== this.ctlL) { this.ctlL = lbl; this.$('c-thr-l').textContent = lbl; }
    this.$('c-stick').style.transform = `translate(${clamp(c.roll, -1, 1) * P}px, ${clamp(c.pitch, -1, 1) * P}px)`;
    this.$('c-rud').style.transform = `translateX(${clamp(c.yaw, -1, 1) * 34}px)`;
  }
  drawADI(ac) {
    const g = this.adi, S = 120, c = S / 2;
    const f = ac.forward, up = ac.up;
    const pitch = Math.asin(clamp(f.y, -1, 1));
    const right = new THREE.Vector3().crossVectors(f, up);
    const bank = Math.atan2(-right.y, up.y);
    g.clearRect(0, 0, S, S);
    g.save(); g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.clip();
    g.translate(c, c); g.rotate(-bank);
    const off = pitch * 120;
    g.fillStyle = '#3c7dd9'; g.fillRect(-S, -S * 2 + off, S * 2, S * 2);
    g.fillStyle = '#8a5a2b'; g.fillRect(-S, off, S * 2, S * 2);
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(-S, off); g.lineTo(S, off); g.stroke();
    g.lineWidth = 1; g.font = '9px sans-serif'; g.fillStyle = '#fff';
    for (let d = -40; d <= 40; d += 10) { if (!d) continue; const y = off - THREE.MathUtils.degToRad(d) * 120; const w = d % 20 ? 10 : 20; g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke(); }
    g.restore();
    g.strokeStyle = '#ffcc00'; g.lineWidth = 3; g.beginPath(); g.moveTo(c - 30, c); g.lineTo(c - 10, c); g.lineTo(c, c + 6); g.lineTo(c + 10, c); g.lineTo(c + 30, c); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2; g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.stroke();
  }
  drawMap(ac, world, mission, others) {
    const g = this.map, S = 180, R = this.mapRange;
    const img = world.minimap, IS = img.width;
    const px = ((ac.x.x + world.half) / world.size) * IS, pz = ((ac.x.z + world.half) / world.size) * IS;
    const span = (R * 2 / world.size) * IS;
    g.save(); g.clearRect(0, 0, S, S);
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#1d3b4a'; g.fillRect(0, 0, S, S);
    g.imageSmoothingEnabled = true;
    g.drawImage(img, px - span / 2, pz - span / 2, span, span, 0, 0, S, S);
    const toMap = (x, z) => [S / 2 + ((x - ac.x.x) / (R * 2)) * S, S / 2 + ((z - ac.x.z) / (R * 2)) * S];
    if (mission?.rings) {
      mission.rings.forEach((r, i) => { const [x, y] = toMap(r.p.x, r.p.z); g.fillStyle = r.passed ? 'rgba(80,255,120,0.6)' : i === mission.idx ? '#ffb020' : 'rgba(255,176,32,0.5)'; g.beginPath(); g.arc(x, y, i === mission.idx ? 5 : 3, 0, 7); g.fill(); });
    }
    if (others) for (const o of others) { // multiplayer: other pilots, clamped to the rim when out of range
      let [x, y] = toMap(o.x, o.z); const dx = x - S / 2, dy = y - S / 2, d = Math.hypot(dx, dy), rim = S / 2 - 10;
      if (d > rim) { x = S / 2 + (dx / d) * rim; y = S / 2 + (dy / d) * rim; }
      g.save(); g.translate(x, y); g.rotate(o.hdg); g.fillStyle = o.color; g.strokeStyle = '#000'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke(); g.restore();
    }
    g.translate(S / 2, S / 2);
    const f = ac.forward; g.rotate(Math.atan2(f.x, -f.z));
    g.fillStyle = '#ffd400'; g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 12px sans-serif'; g.textAlign = 'center'; g.fillText('N', S / 2, 16);
  }
}
