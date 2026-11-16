// Input: keyboard, gamepad, on-screen touch controls and tilt steering.
import { clamp } from './noise.js';

export class Controls {
  constructor(root, onAction) {
    this.root = root; this.onAction = onAction;
    this.out = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, gas: 0, rev: 0, hand: 0 };
    this.vehicle = 'plane'; this.pedal = { gas: 0, brake: 0 }; // vehicle: plane | car | rocket (see setVehicle)
    this.keys = new Set();
    this.touch = { pitch: 0, roll: 0, yaw: 0, active: false };
    this.invert = false; this.mode = 'stick'; // stick | tilt
    this.tilt = { x: 0, y: 0, cal: null, ok: false };
    this.throttle = 0; this.gpPrev = [];
    this.enabled = false;
    this.k = { pitch: 0, roll: 0, yaw: 0 };
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    this.buildTouch();
  }
  key(e, down) {
    if (!this.enabled) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (down) {
      if (!this.keys.has(k)) {
        const map = { g: 'gear', v: 'flaps', c: 'camera', ' ': 'smoke', p: 'pause', Escape: 'pause', h: 'hud', m: 'map', l: 'lights', '`': 'debug' };
        if (this.vehicle === 'car') delete map[' ']; // space is the handbrake
        if (map[k]) { this.onAction(map[k]); e.preventDefault(); }
        if (k >= '0' && k <= '9' && this.vehicle !== 'car') this.setThrottle(k === '0' ? 1 : (+k) / 10);
      }
      this.keys.add(k);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
    } else this.keys.delete(k);
  }
  setThrottle(t) { this.throttle = clamp(t, 0, 1); this.syncThrottleUI(); }

  buildTouch() {
    const el = document.createElement('div'); el.className = 'touch'; el.innerHTML = `
      <div class="t-left">
        <div class="t-pedals"><div class="t-pedal brake" data-p="brake"><b>BRAKE</b><small>hold to reverse</small></div><div class="t-pedal gas" data-p="gas"><b>GAS</b></div></div>
        <div class="t-throttle"><div class="t-thr-fill"></div><div class="t-thr-knob"><span>THR</span></div><div class="t-thr-label">0%</div></div>
        <div class="t-rudder"><div class="t-rud-knob"></div><span class="t-rud-label">RUDDER</span></div>
      </div>
      <div class="t-stick-zone"><div class="t-stick"><div class="t-stick-ring"></div><div class="t-stick-knob"></div></div></div>
      <div class="t-buttons">
        <button data-act="brake" class="t-btn hold">BRAKE</button>
        <button data-act="gear" class="t-btn">GEAR</button>
        <button data-act="flaps" class="t-btn">FLAPS</button>
        <button data-act="smoke" class="t-btn">SMOKE</button>
      </div>`;
    this.root.appendChild(el); this.el = el;
    const thr = el.querySelector('.t-throttle');
    const thrMove = (e) => { const r = thr.getBoundingClientRect(); this.setThrottle(1 - (e.clientY - r.top - 20) / (r.height - 40)); };
    this.drag(thr, thrMove, thrMove, () => {});
    const rud = el.querySelector('.t-rudder'), rk = el.querySelector('.t-rud-knob');
    const rudMove = (e) => { const r = rud.getBoundingClientRect(); this.touch.yaw = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1); rk.style.transform = `translateX(${this.touch.yaw * (r.width / 2 - 24)}px)`; };
    this.drag(rud, rudMove, rudMove, () => { this.touch.yaw = 0; rk.style.transform = ''; });
    // Floating stick: touch anywhere in the big right-hand zone and the stick centres under the thumb.
    const zone = el.querySelector('.t-stick-zone'), st = el.querySelector('.t-stick'), knob = el.querySelector('.t-stick-knob');
    let origin = null;
    const stMove = (e) => {
      const R = st.offsetWidth / 2;
      let dx = (e.clientX - origin.x) / (R * 0.8), dy = (e.clientY - origin.y) / (R * 0.8);
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      this.touch.roll = dx; this.touch.pitch = dy; this.touch.active = true;
      knob.style.transform = `translate(${dx * R * 0.8}px, ${dy * R * 0.8}px)`;
    };
    this.drag(zone, (e) => {
      const z = zone.getBoundingClientRect(), R = st.offsetWidth / 2;
      origin = { x: e.clientX, y: e.clientY };
      st.style.left = `${e.clientX - z.left - R}px`; st.style.top = `${e.clientY - z.top - R}px`; st.style.right = st.style.bottom = 'auto';
      st.classList.add('live'); stMove(e);
    }, stMove, () => { this.touch.roll = this.touch.pitch = 0; this.touch.active = false; knob.style.transform = ''; origin = null; st.style.left = st.style.top = st.style.right = st.style.bottom = ''; st.classList.remove('live'); });
    // car pedals: hold to press (each its own finger, so gas + steer + brake all work together)
    el.querySelectorAll('.t-pedal').forEach((b) => {
      const k = b.dataset.p;
      const set = (v) => (e) => { e.preventDefault(); this.pedal[k] = v; b.classList.toggle('on', !!v); };
      b.addEventListener('pointerdown', set(1));
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, set(0));
    });
    el.querySelectorAll('.t-btn').forEach((b) => {
      const act = b.dataset.act;
      if (act === 'brake') {
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.touchBrake = 1; b.classList.add('on'); });
        const up = () => { this.touchBrake = 0; b.classList.remove('on'); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
      } else b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onAction(act); });
    });
  }
  drag(el, start, move, end) {
    let id = null;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); id = e.pointerId; try { el.setPointerCapture(id); } catch { /* synthetic or stale pointer */ } start(e); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const fin = (e) => { if (e.pointerId === id) { id = null; end(e); } };
    el.addEventListener('pointerup', fin); el.addEventListener('pointercancel', fin);
  }
  syncThrottleUI() {
    if (!this.el) return;
    const t = this.throttle;
    this.el.querySelector('.t-thr-knob').style.bottom = `calc(${t * 100}% - ${t * 40}px)`;
    this.el.querySelector('.t-thr-fill').style.height = `${t * 100}%`;
    this.el.querySelector('.t-thr-label').textContent = t > 0.95 ? 'MAX' : `${Math.round(t * 100)}%`;
  }
  showTouch(on) { this.el.style.display = on ? '' : 'none'; }
  // Cars get pedals (GAS / BRAKE-then-reverse) instead of the throttle and rudder sliders, and a handbrake button;
  // rockets keep the plane layout but the rudder slider rolls.
  setVehicle(kind) {
    this.vehicle = kind; this.pedal.gas = this.pedal.brake = 0;
    this.el.classList.toggle('car', kind === 'car'); this.el.classList.toggle('rocket', kind === 'rocket');
    this.el.querySelector('.t-rud-label').textContent = kind === 'rocket' ? 'ROLL' : 'RUDDER';
    this.el.querySelector('[data-act="brake"]').textContent = kind === 'car' ? 'HANDBRAKE' : 'BRAKE';
  }
  setMode(mode) {
    this.mode = mode;
    this.el.classList.toggle('tilt', mode === 'tilt');
    if (mode === 'tilt') this.enableTilt();
  }
  async enableTilt() {
    try { if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission(); } catch (e) { /* ignore */ }
    if (this.tiltBound) return;
    this.tiltBound = true;
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity; if (!a || a.x === null) return;
      const ang = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180;
      const sx = a.x * Math.cos(ang) + a.y * Math.sin(ang);
      const sy = -a.x * Math.sin(ang) + a.y * Math.cos(ang);
      this.tilt.x = sx; this.tilt.y = sy; this.tilt.z = a.z; this.tilt.ok = true;
      if (!this.tilt.cal) this.calibrate();
    });
  }
  calibrate() { this.tilt.cal = { x: this.tilt.x, y: this.tilt.y }; }

  update(dt) {
    const K = this.keys, o = this.out;
    const kb = (a, b) => (K.has(a) || K.has(b) ? 1 : 0);
    // pitch: down/S = nose up (pull back) unless inverted
    let tp = kb('ArrowDown', 's') - kb('ArrowUp', 'w');
    let tr = kb('ArrowRight', 'd') - kb('ArrowLeft', 'a');
    let ty = kb('e', 'E') - kb('q', 'Q');
    const ramp = (cur, tgt) => { const r = tgt === 0 ? 5 : 3; return cur + clamp(tgt - cur, -r * dt, r * dt); };
    this.k.pitch = ramp(this.k.pitch, tp); this.k.roll = ramp(this.k.roll, tr); this.k.yaw = ramp(this.k.yaw, ty);
    if (K.has('Shift') || K.has('r') || K.has('=') || K.has('+')) this.setThrottle(this.throttle + dt * 0.6);
    if (K.has('Control') || K.has('f') || K.has('-')) this.setThrottle(this.throttle - dt * 0.6);
    let pitch = this.k.pitch, roll = this.k.roll, yaw = this.k.yaw;
    let brake = K.has('b') || (this.vehicle === 'car' && K.has(' ')) ? 1 : 0;
    const car = this.vehicle === 'car';
    // touch
    if (this.touch.active) { pitch += this.touch.pitch; roll += this.touch.roll; }
    yaw += this.touch.yaw;
    if (this.touchBrake) brake = 1;
    // tilt
    if (this.mode === 'tilt' && this.tilt.ok && this.tilt.cal) {
      const dz = (v, d) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d));
      roll += clamp(dz((this.tilt.x - this.tilt.cal.x) / 4.5, 0.05), -1, 1) * (navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad') ? -1 : 1);
      if (!car) pitch += clamp(dz(-(this.tilt.y - this.tilt.cal.y) / 4, 0.06), -1, 1); // (a car's pedals do go/stop)
    }
    // gamepad
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) {
      if (!gp) continue;
      const ax = (i) => (Math.abs(gp.axes[i] || 0) > 0.12 ? gp.axes[i] : 0);
      roll += ax(0); pitch += ax(1); yaw += ax(2);
      const bt = (i) => gp.buttons[i]?.value || 0;
      if (car) { this.gpGas = bt(7); this.gpRev = bt(6); } else this.setThrottle(this.throttle + (bt(7) - bt(6)) * dt * 0.8);
      if (bt(0) > 0.5) brake = 1;
      const pressed = (i) => gp.buttons[i]?.pressed && !this.gpPrev[i];
      if (pressed(1)) this.onAction('gear'); if (pressed(2)) this.onAction('flaps'); if (pressed(3)) this.onAction('camera');
      if (pressed(4)) this.onAction('smoke'); if (pressed(9)) this.onAction('pause'); if (pressed(5)) this.onAction('flaps');
      this.gpPrev = gp.buttons.map((b) => b.pressed);
      break;
    }
    if (car) { // W / up / stick forward / GAS = go; S / down / stick back / BRAKE = brake, then reverse once stopped
      const p = clamp(pitch, -1, 1);
      o.gas = clamp(Math.max(-p, this.pedal.gas, this.gpGas || 0, K.has('Shift') ? 1 : 0), 0, 1);
      o.rev = clamp(Math.max(p, this.pedal.brake, this.gpRev || 0), 0, 1);
      o.hand = brake; o.brake = 0; o.throttle = o.gas;
      o.pitch = 0; o.roll = clamp(roll + yaw, -1, 1); o.yaw = 0;
      return o;
    }
    o.gas = o.rev = o.hand = 0;
    if (this.invert) pitch = -pitch;
    o.pitch = clamp(pitch, -1, 1); o.roll = clamp(roll, -1, 1); o.yaw = clamp(yaw, -1, 1);
    o.throttle = this.throttle; o.brake = brake;
    return o;
  }
}
