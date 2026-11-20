// Wind tunnel: test the current design on a sting in a glass test section, with smoke, force arrows, gauges, a lift
// chart and tips. Reached from the hangar (main.js openTunnel); main.js hands over the renderer while it is open.
//
// The forces are the flight model's own: an Aircraft built from the design, asked for its aero forces at the tunnel's
// state through Aircraft.aeroAt (the very function a flight substep calls), so whatever the tunnel says is what the
// plane will do. Free pivot integrates pitch and yaw about the CoM with those aero moments only (the sting holds it in
// place and keeps it from rolling). The smoke is tunnelFlow.js; the building tunnelScene.js.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/addons/OrbitControls.js';
import { RoomEnvironment } from '../vendor/addons/RoomEnvironment.js';
import { Aircraft, REALISM, airDensity, speedOfSound } from './aircraft.js';
import { analyze } from './design.js';
import { buildTunnelSet, Y0, SECTION } from './tunnelScene.js';
import { TunnelFlow, FLOW_TIERS } from './tunnelFlow.js';
import { clamp } from './noise.js';

const G = 9.81, D2R = Math.PI / 180;
const V_MIN = 3, V_MAX = 1020; // m/s: a breeze to Mach 3
const AOA = [-10, 35], BETA = [-25, 25];
const sliderToV = (t) => V_MIN * (V_MAX / V_MIN) ** (t / 1000);
const vToSlider = (v) => Math.round(1000 * Math.log(v / V_MIN) / Math.log(V_MAX / V_MIN));
const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
const kg = (n) => `${fmt(Math.abs(n) >= 100 ? Math.round(n / 10) * 10 : n)} kg`;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const SCALES = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const BUDGET = { low: 2.5, medium: 3.5, high: 5, ultra: 6 };

const CSS = `
#tunnel-ui { position: fixed; inset: 0; pointer-events: none; z-index: 5; font-size: 14px; }
#tunnel-ui > * { pointer-events: auto; }
#tunnel-ui .wt-top { position: absolute; top: 0; left: 0; right: 0; min-height: 56px; display: flex; align-items: center; gap: 10px; padding: 6px 12px; padding-top: max(6px, env(safe-area-inset-top));
  background: linear-gradient(180deg, rgba(10, 12, 16, .92), rgba(10, 12, 16, .6)); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
#tunnel-ui .wt-title { font-weight: 800; letter-spacing: .14em; color: var(--accent); display: flex; flex-direction: column; line-height: 1.1; }
#tunnel-ui .wt-title small { letter-spacing: .02em; font-weight: 500; }
#tunnel-ui .wt-chips { display: flex; gap: 4px; align-items: center; color: var(--dim); font-size: 12px; }
#tunnel-ui .wt-chips button { padding: 7px 10px; font-size: 13px; }
#tunnel-ui .wt-exit { margin-left: auto; padding: 10px 18px; }
#tunnel-ui aside { position: absolute; top: 66px; bottom: 10px; width: 290px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); overflow-y: auto; padding: 10px 12px; touch-action: pan-y; scrollbar-width: thin; }
#tunnel-ui .wt-left { left: 8px; } #tunnel-ui .wt-right { right: 8px; width: 300px; }
#tunnel-ui .wt-ctl { margin: 0 0 2px; }
#tunnel-ui .wt-ctl label { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; color: var(--dim); }
#tunnel-ui .wt-ctl label b { color: var(--text); font-size: 15px; }
#tunnel-ui .wt-row { display: flex; gap: 6px; align-items: center; }
#tunnel-ui .wt-row button { min-width: 44px; height: 40px; padding: 0 8px; }
#tunnel-ui input.wt-big { -webkit-appearance: none; appearance: none; width: 100%; height: 42px; background: transparent; margin: 0; touch-action: none; }
#tunnel-ui input.wt-big::-webkit-slider-runnable-track { height: 10px; border-radius: 5px; background: linear-gradient(90deg, rgba(58,176,255,.35), rgba(255,176,32,.45)); }
#tunnel-ui input.wt-big::-moz-range-track { height: 10px; border-radius: 5px; background: linear-gradient(90deg, rgba(58,176,255,.35), rgba(255,176,32,.45)); }
#tunnel-ui input.wt-big::-webkit-slider-thumb { -webkit-appearance: none; width: 34px; height: 34px; margin-top: -12px; border-radius: 50%; background: var(--accent); border: 3px solid #fff3; box-shadow: 0 2px 6px #0008; }
#tunnel-ui input.wt-big::-moz-range-thumb { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); border: 3px solid #fff3; }
#tunnel-ui input.wt-big.zero::-webkit-slider-runnable-track { background: linear-gradient(90deg, rgba(255,90,79,.4), rgba(255,255,255,.12) 50%, rgba(76,212,134,.4)); }
#tunnel-ui h4 { margin: 8px 0 2px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
#tunnel-ui .wt-flaps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
#tunnel-ui .wt-flaps button { height: 40px; padding: 0; }
#tunnel-ui .wt-pivot { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin: 0 0 8px; }
#tunnel-ui .wt-pivot button { height: 48px; font-size: 15px; }
#tunnel-ui .wt-gauges { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
#tunnel-ui .wt-g { background: rgba(0,0,0,.25); border: 1px solid var(--line); border-radius: 10px; padding: 6px 8px; min-height: 58px; }
#tunnel-ui .wt-g label { display: block; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
#tunnel-ui .wt-g b { font-size: 19px; display: block; }
#tunnel-ui .wt-g small { font-size: 11px; display: block; line-height: 1.2; }
#tunnel-ui .wt-g .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.1); margin-top: 4px; overflow: hidden; }
#tunnel-ui .wt-g .bar i { display: block; height: 100%; background: var(--good); width: 0; transition: width .15s; }
#tunnel-ui .wt-g.good b { color: var(--good); } #tunnel-ui .wt-g.warn b { color: var(--warn); } #tunnel-ui .wt-g.bad b { color: var(--bad); }
#tunnel-ui canvas.wt-chart { width: 100%; height: 170px; display: block; background: rgba(0,0,0,.3); border-radius: 10px; border: 1px solid var(--line); margin-top: 4px; }
#tunnel-ui ul.wt-tips { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
#tunnel-ui ul.wt-tips li { padding: 8px 10px; border-radius: 9px; background: rgba(58,176,255,.12); border-left: 4px solid var(--accent2); line-height: 1.3; font-size: 13.5px; }
#tunnel-ui ul.wt-tips li.bad { background: rgba(255,90,79,.13); border-color: var(--bad); }
#tunnel-ui ul.wt-tips li.warn { background: rgba(255,207,74,.12); border-color: var(--warn); }
#tunnel-ui ul.wt-tips li.good { background: rgba(76,212,134,.12); border-color: var(--good); }
#tunnel-ui .wt-stall { position: absolute; left: 50%; top: 84px; transform: translateX(-50%); font-size: 54px; font-weight: 900; letter-spacing: .08em; color: #fff; background: var(--bad);
  padding: 4px 26px; border-radius: 14px; box-shadow: 0 0 40px rgba(255,60,40,.7); pointer-events: none; display: none; animation: wtPulse .5s ease-in-out infinite alternate; }
#tunnel-ui .wt-boom { position: absolute; left: 50%; top: 84px; transform: translateX(-50%); font-size: 26px; font-weight: 900; color: #001a2b; background: var(--accent2); padding: 4px 18px; border-radius: 12px; pointer-events: none; display: none; }
@keyframes wtPulse { from { transform: translateX(-50%) scale(1); } to { transform: translateX(-50%) scale(1.08); } }
#tunnel-ui .wt-lab { position: absolute; pointer-events: none; padding: 3px 8px; border-radius: 8px; font-size: 13px; font-weight: 700; white-space: nowrap; background: rgba(10,12,16,.75); border: 1px solid; transform: translate(-50%, -50%); }
#tunnel-ui .wt-legend { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: none; align-items: center; gap: 8px; font-size: 12px; background: rgba(10,12,16,.7); padding: 6px 12px; border-radius: 10px; pointer-events: none; }
#tunnel-ui .wt-legend i { width: 160px; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #1f59ff, #33e6ff, #f2f7ff, #ffd933, #ff3820); }
#tunnel-ui .wt-load { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--bg); }
@media (max-width: 900px) { #tunnel-ui aside { width: 240px; } #tunnel-ui .wt-right { width: 250px; } #tunnel-ui .wt-stall { font-size: 38px; } }
`;

export class WindTunnel {
  // opts: { renderer, tier, render(scene, camera, dt), target() (the render target the frame is drawn into), audio,
  //   settings, analytics, collectGpu, keepGpu() (resources not to free), onExit(), track: { plane, kind, design } }
  constructor(opts) {
    this.o = opts; this.renderer = opts.renderer; this.tier = FLOW_TIERS[opts.tier] ? opts.tier : 'medium';
    this.ready = false; this.closed = false;
    this.st = { V: 50, aoa: 4, beta: 0, elev: 0, ail: 0, rud: 0, flaps: 0, pivot: false, mode: 0, air: 'sim' };
    this.piv = { th: 0, ps: 0, thd: 0, psd: 0, held: false };
    this.curve = new Map(); this.curveKey = ''; this.sweep = null;
    this.F = new THREE.Vector3(); this.T = new THREE.Vector3(); this.Fw = new THREE.Vector3(); this.q = new THREE.Quaternion();
    this.perf = { ema: 16, slowT: 0, fastT: 0, frac: 1, frames: 0, msSum: 0, worst: 0 };
    this.log = { t0: performance.now(), maxV: 0, maxMach: 0, aoaMin: 99, aoaMax: -99, pivot: false, stalled: false, sweeps: 0, modes: new Set([0]), air: new Set(['sim']), controls: false, flaps: false };
  }

  // ---------- open ----------
  open(design) {
    const r = this.renderer;
    this.design = design; this.stats = analyze(design);
    const ac = (this.ac = new Aircraft(design, REALISM[this.st.air]));
    ac.ce = ac.ctl; ac.trim = 0; ac.gearDown = true; ac.gearT = 1;
    if (ac.landingLight) { ac.landingLight.parent?.remove(ac.landingLight); ac.landingLight = null; } // (the tunnel's light set is fixed)
    for (const p of ac.parts) {
      const e = p.engine; if (!e) continue;
      if (e.prop?.userData.disc) e.prop.userData.disc.visible = false;
      if (e.flame) { e.flame.visible = false; e.flameCore.visible = false; }
    }
    // scale model: fits the test section with room to swing round on the pivot
    const fit = 4.2 / ac.radius, n = fit >= 1 ? 1 : SCALES.find((k) => 1 / k <= fit) || Math.ceil(1 / fit);
    this.scaleN = n; this.s = 1 / n;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x0b0d10);
    this.set = buildTunnelSet({ shadows: this.tier !== 'low' });
    this.scene.add(this.set.root);
    this.model = new THREE.Group(); this.model.position.set(0, Y0, 0); this.model.scale.setScalar(this.s);
    ac.root.position.copy(ac.com).negate(); ac.root.quaternion.identity(); this.model.add(ac.root);
    this.scene.add(this.model);
    { const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 12), new THREE.MeshStandardMaterial({ color: 0xcfd5db, metalness: 1, roughness: 0.2 })); ball.position.set(0, Y0 - 0.18, 0); this.scene.add(ball); }
    // reflections: a small studio environment (freed on close)
    this.pmrem = new THREE.PMREMGenerator(r); const room = new RoomEnvironment();
    this.envRT = this.pmrem.fromScene(room, 0.04); room.dispose();
    this.scene.environment = this.envRT.texture; this.scene.environmentIntensity = 0.55;
    // smoke
    this.flow = new TunnelFlow(this.tier, { x0: SECTION.x0, x1: SECTION.x1, y0: SECTION.y0, y1: SECTION.y1, zRake: -11, zEnd: SECTION.z1 + 3 });
    this.flow.setModel(ac, this.s, new THREE.Vector3(0, Y0, 0));
    this.scene.add(this.flow.group);
    this.buildRake();
    this.buildArrows();
    // camera
    const cam = (this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 400));
    cam.position.set(-6.4, 7.0, -6.2);
    this.controls = new OrbitControls(cam, r.domElement);
    this.controls.target.set(0, Y0, 0.8); this.controls.enableDamping = true; this.controls.minDistance = 3; this.controls.maxDistance = 34; this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.update();
    // a sensible starting point: a comfortable cruise for planes, a fast drive for cars
    const st = this.st, S = this.stats;
    st.V = S.car && S.wingArea < 0.5 ? 30 : Number.isFinite(S.stall) && S.stall > 0 ? clamp(S.stall * 1.6, 15, 260) : 60;
    st.aoa = S.wingArea > 0.5 ? 4 : 0;
    this.piv.th = st.aoa * D2R;
    this.buildUI();
    this.onResize = () => this.resize(innerWidth, innerHeight); addEventListener('resize', this.onResize);
    this.onKey = (e) => { if (e.key === 'Escape') this.exit(); }; addEventListener('keydown', this.onKey);
    // compile every shader before the first frame (behind the "opening" screen), drawn into the frame's real target
    this.physics(0); this.flow.update(0, st.V, 1e9);
    const target = this.o.target?.() ?? null;
    r.setRenderTarget(target);
    const done = r.compileAsync(this.scene, cam).catch(() => {});
    r.setRenderTarget(null);
    return Promise.race([done, new Promise((res) => setTimeout(res, 8000))]).then(() => {
      if (this.closed) return;
      this.ready = true; this.ui.querySelector('.wt-load')?.remove(); this.resize(innerWidth, innerHeight);
      this.audioOn = true;
    });
  }

  // the smoke rake: one nozzle per streamline seed, on vertical feed pipes from a manifold on the floor
  buildRake() {
    const g = new THREE.Group(), seeds = this.flow.rakeSeeds, m = new THREE.MeshStandardMaterial({ color: 0x9aa3ac, metalness: 0.9, roughness: 0.3 });
    const geos = [], nz = new THREE.CylinderGeometry(0.035, 0.05, 0.4, 8); nz.rotateX(Math.PI / 2);
    const cols = new Map(); for (const p of seeds) { const k = p.x.toFixed(2); cols.set(k, Math.max(cols.get(k) || 0, p.y)); }
    for (const p of seeds) geos.push(nz.clone().translate(p.x, p.y, p.z - 0.2));
    for (const [x, top] of cols) { const t = new THREE.CylinderGeometry(0.045, 0.045, top + 0.05, 8); t.translate(+x, (top + 0.05) / 2, seeds[0].z - 0.4); geos.push(t);
      for (const p of seeds) if (p.x.toFixed(2) === x) { const h = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6); h.rotateX(Math.PI / 2); h.translate(p.x, p.y, p.z - 0.5); geos.push(h); } }
    const xs = [...cols.keys()].map(Number), man = new THREE.BoxGeometry(Math.max(...xs) - Math.min(...xs) + 0.6, 0.18, 0.3); man.translate((Math.max(...xs) + Math.min(...xs)) / 2, 0.09, seeds[0].z - 0.4); geos.push(man);
    for (const k of geos) { for (const a of Object.keys(k.attributes)) if (a !== 'position' && a !== 'normal') k.deleteAttribute(a); }
    const merged = mergeAll(geos); nz.dispose(); geos.forEach((k) => k.dispose());
    const mesh = new THREE.Mesh(merged, m); mesh.castShadow = this.tier !== 'low'; g.add(mesh);
    this.scene.add(g);
  }

  buildArrows() {
    const shaft = new THREE.CylinderGeometry(0.055, 0.055, 1, 10); shaft.translate(0, 0.5, 0);
    const head = new THREE.ConeGeometry(0.16, 0.34, 14); head.translate(0, 0.17, 0);
    this.arrowGeo = { shaft, head };
    const mk = (color) => {
      const m = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92, toneMapped: false });
      const g = new THREE.Group(), s = new THREE.Mesh(shaft, m), h = new THREE.Mesh(head, m); s.renderOrder = h.renderOrder = 30;
      g.add(s, h); g.position.set(0, Y0, 0); this.scene.add(g); return { g, s, h };
    };
    this.arrows = { lift: mk(0x4cd486), drag: mk(0xff5a4f), side: mk(0xc58cff), weight: mk(0xffd400) };
  }
  setArrow(a, dir, len) {
    if (!(len > 0.05)) { a.g.visible = false; return; }
    a.g.visible = true; a.g.quaternion.setFromUnitVectors(_up, dir);
    const hl = Math.min(0.34, len * 0.4); a.s.scale.set(1, len - hl, 1); a.h.position.y = len - hl; a.h.scale.setScalar(hl / 0.34);
    a.tip = a.g.position.clone().addScaledVector(dir, len + 0.25);
  }

  // ---------- UI ----------
  buildUI() {
    if (!document.getElementById('tunnel-css')) { const s = document.createElement('style'); s.id = 'tunnel-css'; s.textContent = CSS; document.head.appendChild(s); }
    const st = this.st, ui = (this.ui = document.createElement('div')); ui.id = 'tunnel-ui';
    const ctl = (k, name, lo, hi, step, v, cls = '') => `<div class="wt-ctl"><label>${name} <b data-v="${k}"></b></label>
      <div class="wt-row"><input class="wt-big ${cls}" type="range" data-k="${k}" min="${lo}" max="${hi}" step="${step}" value="${v}">${cls ? `<button data-zero="${k}" aria-label="Centre">0</button>` : ''}</div></div>`;
    const flaps = this.ac.parts.some((p) => p.d.wing?.flaps);
    ui.innerHTML = `
      <header class="wt-top">
        <div class="wt-title">🌬️ WIND TUNNEL<small>${esc(this.design.name || 'My Vehicle')} · ${this.scaleN > 1 ? `1:${this.scaleN} scale model` : 'full size'}</small></div>
        <div class="wt-chips">Air <button data-air="sim" title="The real thing (Simulator)">Real</button><button data-air="pilot">Pilot</button><button data-air="arcade">Arcade</button></div>
        <div class="wt-chips">Smoke <button data-mode="0">White</button><button data-mode="1">Speed</button><button data-mode="2">Pressure</button></div>
        <button class="primary wt-exit" data-exit>✕ Back to hangar</button>
      </header>
      <aside class="wt-left">
        ${ctl('V', 'Wind speed', 0, 1000, 1, vToSlider(st.V))}
        ${ctl('aoa', 'Angle of attack', AOA[0], AOA[1], 0.5, st.aoa)}
        <div class="wt-row" style="margin:-4px 0 6px"><button data-sweep style="flex:1">▶ Sweep the angle</button><button data-clear title="Clear the chart">⟲</button></div>
        <div class="wt-pivot"><button data-pivot title="Let the model turn on its pivot: a stable plane swings back into the wind, an unstable one flips round">🔓 Free pivot</button><button data-nudge disabled>👉 Nudge</button></div>
        ${ctl('beta', 'Sideslip (yaw)', BETA[0], BETA[1], 0.5, 0, 'zero')}
        <h4>Controls</h4>
        ${ctl('elev', 'Elevator', -1, 1, 0.05, 0, 'zero')}
        ${ctl('ail', 'Ailerons', -1, 1, 0.05, 0, 'zero')}
        ${ctl('rud', 'Rudder', -1, 1, 0.05, 0, 'zero')}
        ${flaps ? `<h4>Flaps</h4><div class="wt-flaps">${['Up', '10°', '20°', 'Full'].map((t, i) => `<button data-flaps="${i}">${t}</button>`).join('')}</div>` : ''}
      </aside>
      <aside class="wt-right">
        <div class="wt-gauges">
          <div class="wt-g" data-g="lift"><label>Lift</label><b>—</b><small></small><div class="bar"><i></i></div></div>
          <div class="wt-g" data-g="drag"><label>Drag</label><b>—</b><small></small></div>
          <div class="wt-g" data-g="ld"><label>Lift ÷ drag</label><b>—</b><small></small></div>
          <div class="wt-g" data-g="stall"><label>Stalls at</label><b>—</b><small></small></div>
          <div class="wt-g" data-g="pitch"><label>Pitch</label><b>—</b><small></small></div>
          <div class="wt-g" data-g="yaw"><label>Yaw</label><b>—</b><small></small></div>
        </div>
        <h4>Lift vs angle</h4>
        <canvas class="wt-chart"></canvas>
        <h4>Tips</h4>
        <ul class="wt-tips"></ul>
      </aside>
      <div class="wt-stall">STALL!</div>
      <div class="wt-boom">SUPERSONIC! 💥</div>
      <div class="wt-lab" data-lab="lift" style="color:#4cd486;border-color:#4cd48688"></div>
      <div class="wt-lab" data-lab="drag" style="color:#ff7a70;border-color:#ff5a4f88"></div>
      <div class="wt-lab" data-lab="side" style="color:#d6a8ff;border-color:#c58cff88"></div>
      <div class="wt-lab" data-lab="weight" style="color:#ffd400;border-color:#ffd40088"></div>
      <div class="wt-legend"><span data-leg0>slow</span><i></i><span data-leg1>fast</span></div>
      <div class="wt-load">Opening the wind tunnel…</div>`;
    document.body.appendChild(ui);
    const $ = (s) => ui.querySelector(s), all = (s) => ui.querySelectorAll(s);
    this.el = { lab: {}, g: {} };
    for (const k of ['lift', 'drag', 'side', 'weight']) this.el.lab[k] = $(`[data-lab="${k}"]`);
    for (const k of ['lift', 'drag', 'ld', 'stall', 'pitch', 'yaw']) { const g = $(`[data-g="${k}"]`); this.el.g[k] = { box: g, b: g.querySelector('b'), small: g.querySelector('small'), bar: g.querySelector('.bar i') }; }
    this.el.stall = $('.wt-stall'); this.el.boom = $('.wt-boom'); this.el.tips = $('.wt-tips'); this.el.chart = $('.wt-chart'); this.el.legend = $('.wt-legend');
    this.el.pivot = $('[data-pivot]'); this.el.nudge = $('[data-nudge]'); this.el.sweep = $('[data-sweep]');
    // sliders
    all('input[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      const set = () => {
        const v = +inp.value;
        if (k === 'V') st.V = sliderToV(v); else st[k] = v;
        if (k === 'aoa' || k === 'beta') { this.sweep = null; if (st.pivot) { this.piv[k === 'aoa' ? 'th' : 'ps'] = v * D2R; this.piv.thd = this.piv.psd = 0; } }
        if (k === 'elev' || k === 'ail' || k === 'rud') this.log.controls = true;
        this.o.audio?.tick?.('slide', (v - inp.min) / (inp.max - inp.min));
        this.showValues();
      };
      inp.addEventListener('input', set);
      inp.addEventListener('pointerdown', () => { if (k === 'aoa' || k === 'beta') this.piv.held = true; });
      for (const t of ['pointerup', 'pointercancel', 'change']) inp.addEventListener(t, () => { this.piv.held = false; });
    });
    all('[data-zero]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.zero, inp = $(`input[data-k="${k}"]`); inp.value = 0; st[k] = 0; if (k === 'beta' && st.pivot) { this.piv.ps = 0; this.piv.psd = 0; } this.showValues(); }));
    all('[data-flaps]').forEach((b) => b.addEventListener('click', () => { st.flaps = +b.dataset.flaps; this.log.flaps = this.log.flaps || st.flaps > 0; this.o.audio?.play?.('select'); this.showValues(); }));
    all('[data-air]').forEach((b) => b.addEventListener('click', () => { st.air = b.dataset.air; this.ac.R = REALISM[st.air]; this.log.air.add(st.air); this.showValues(); }));
    all('[data-mode]').forEach((b) => b.addEventListener('click', () => { st.mode = +b.dataset.mode; this.flow.setMode(st.mode); this.log.modes.add(st.mode); this.showValues(); }));
    this.el.sweep.addEventListener('click', () => this.startSweep());
    $('[data-clear]').addEventListener('click', () => { this.curve.clear(); this.drawChart(); });
    this.el.pivot.addEventListener('click', () => this.setPivot(!st.pivot));
    this.el.nudge.addEventListener('click', () => { const p = this.piv; p.thd += (Math.random() < 0.5 ? -1 : 1) * 0.7; p.psd += (Math.random() < 0.5 ? -1 : 1) * 0.5; this.o.audio?.play?.('select'); });
    $('[data-exit]').addEventListener('click', () => this.exit());
    this.showValues();
  }
  startSweep() {
    const st = this.st; if (st.pivot) this.setPivot(false);
    this.curve.clear(); st.aoa = AOA[0]; this.sweep = { t: 0 }; this.log.sweeps++;
    this.ui.querySelector('input[data-k="aoa"]').value = st.aoa; this.showValues();
  }
  setPivot(on) {
    const st = this.st, p = this.piv; st.pivot = on; this.sweep = null;
    if (on) { p.th = st.aoa * D2R; p.ps = st.beta * D2R; p.thd = 0; p.psd = 0; this.log.pivot = true; }
    else { st.aoa = clamp(Math.round(wrapPi(p.th) / D2R * 2) / 2, AOA[0], AOA[1]); st.beta = clamp(Math.round(wrapPi(p.ps) / D2R * 2) / 2, BETA[0], BETA[1]); this.ui.querySelector('input[data-k="aoa"]').value = st.aoa; this.ui.querySelector('input[data-k="beta"]').value = st.beta; }
    this.el.pivot.textContent = on ? '🔒 Lock the sting' : '🔓 Free pivot'; this.el.pivot.classList.toggle('on', on); this.el.nudge.disabled = !on;
    this.showValues();
  }
  showValues() {
    const st = this.st, ui = this.ui, metric = this.o.settings?.units === 'metric';
    const sp = metric ? `${fmt(st.V * 3.6)} km/h` : `${fmt(st.V * 2.237)} mph`, M = st.V / speedOfSound(0);
    const what = M > 1.05 ? '🚀 supersonic!' : M > 0.95 ? '🔊 sound barrier' : st.V < 10 ? '🍃 breeze' : st.V < 35 ? '🚗 car' : st.V < 90 ? '🛩️ small plane' : st.V < 260 ? '✈️ airliner' : '⚡ fast jet';
    const v = (k, t) => { const e = ui.querySelector(`[data-v="${k}"]`); if (e) e.textContent = t; };
    v('V', `${sp} · Mach ${M.toFixed(2)} ${what}`);
    const ang = (x) => `${x > 0 ? '+' : ''}${fmt(x, 1)}°`, pc = (x, neg, pos) => (Math.abs(x) < 0.025 ? 'centre' : `${Math.round(Math.abs(x) * 100)}% ${x > 0 ? pos : neg}`);
    v('aoa', st.pivot ? `${ang(wrapPi(this.piv.th) / D2R)} (free)` : ang(st.aoa)); v('beta', st.pivot ? `${ang(wrapPi(this.piv.ps) / D2R)} (free)` : ang(st.beta));
    v('elev', pc(st.elev, 'nose down', 'nose up')); v('ail', pc(st.ail, 'roll left', 'roll right')); v('rud', pc(st.rud, 'nose left', 'nose right'));
    ui.querySelectorAll('[data-air]').forEach((b) => b.classList.toggle('on', b.dataset.air === st.air));
    ui.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', +b.dataset.mode === st.mode));
    ui.querySelectorAll('[data-flaps]').forEach((b) => b.classList.toggle('on', +b.dataset.flaps === st.flaps));
    this.el.sweep.classList.toggle('on', !!this.sweep);
    this.el.legend.style.display = st.mode ? 'flex' : 'none';
    ui.querySelector('[data-leg0]').textContent = st.mode === 2 ? 'low pressure (suction)' : 'slower air';
    ui.querySelector('[data-leg1]').textContent = st.mode === 2 ? 'high pressure' : 'faster air';
  }

  // ---------- physics: the flight model's forces at the tunnel's state ----------
  // Aero force (body frame) into this.F and moment into this.T at attitude q, wind speed V, body rates w (rad/s).
  aero(q, V, w, probe = null) {
    const ac = this.ac, st = this.st;
    ac.ctl.pitch = st.elev; ac.ctl.roll = st.ail; ac.ctl.yaw = st.rud; ac.ce = ac.ctl; ac.trim = 0;
    ac.w.copy(w);
    const vAirB = _vb.set(0, 0, -V).applyQuaternion(_qi.copy(q).invert());
    this.F.set(0, 0, 0); this.T.set(0, 0, 0);
    return ac.aeroAt(vAirB, 0, st.flaps, this.F, this.T, probe);
  }
  attitude(aoaRad, betaRad, out = this.q) { return out.setFromEuler(_e.set(aoaRad, betaRad, 0, 'YXZ')); }
  physics(dt) {
    const st = this.st, ac = this.ac, p = this.piv;
    if (this.sweep && !st.pivot) {
      st.aoa = Math.min(AOA[1], st.aoa + dt * 7);
      this.ui.querySelector('input[data-k="aoa"]').value = st.aoa;
      if (st.aoa >= AOA[1]) { this.sweep = null; this.showValues(); }
    }
    if (st.pivot && dt > 0) {
      if (p.held) { p.thd = 0; p.psd = 0; }
      else {
        // pitch about the sting's cross axis, yaw about the vertical: aero moments only (times the realism's aeroTorque,
        // as in flight), a little bearing friction, no roll
        const qd = 0.5 * airDensity(0) * st.V * st.V, n = Math.max(1, Math.ceil(dt * 240 * clamp(Math.sqrt(qd / 150000), 1, 4)));
        const h = Math.min(dt, 0.05) / n, I = ac.I.elements, Ix = I[0], Iy = I[4], Iz = I[8];
        for (let i = 0; i < n; i++) {
          const q = this.attitude(p.th, p.ps, _q2);
          const wb = _w.set(0, p.psd, 0).applyQuaternion(_qi.copy(q).invert()); wb.x += p.thd;
          this.aero(q, st.V, wb);
          const Tw = _t.copy(this.T).multiplyScalar(ac.R.aeroTorque).applyQuaternion(q);
          const ax = _ax.set(1, 0, 0).applyQuaternion(q), c = Math.cos(p.th), s = Math.sin(p.th);
          const thdd = Tw.dot(ax) / Ix - 0.35 * p.thd, psdd = Tw.y / (Iy * c * c + Iz * s * s) - 0.35 * p.psd;
          p.thd = clamp(p.thd + thdd * h, -9, 9); p.psd = clamp(p.psd + psdd * h, -9, 9);
          p.th += p.thd * h; p.ps += p.psd * h;
        }
      }
      if (Math.abs(p.ps) > 4 * Math.PI) p.ps = wrapPi(p.ps);
      if (Math.abs(p.th) > 4 * Math.PI) p.th = wrapPi(p.th);
    }
    // the state shown: forces at this attitude (rates included while it swings)
    const aoa = st.pivot ? p.th : st.aoa * D2R, beta = st.pivot ? p.ps : st.beta * D2R;
    const q = this.attitude(aoa, beta);
    this.probe = [];
    const wb = st.pivot ? _w.set(0, p.psd, 0).applyQuaternion(_qi.copy(q).invert()).add(_ax.set(p.thd, 0, 0)) : _w.set(0, 0, 0);
    const r = this.aero(q, st.V, wb, this.probe);
    this.maxAlpha = r.maxAlpha;
    this.Fw.copy(this.F).applyQuaternion(q);
    // stalled: a third or more of the main wing's area is past its stall angle (the flight model's per-strip verdict;
    // in Arcade air the lift never drops, so nothing stalls)
    let wa = 0, sa = 0;
    for (const e of this.probe) if (e.s.part.d.cat === 'wing' && Math.abs(e.s.n.y) > 0.6) { wa += e.s.area; if (e.stalled && Math.abs(e.a) < 1.5) sa += e.s.area; }
    this.stallFrac = wa > 0 ? sa / wa : 0;
    this.stalled = ac.R.stallSharp > 0 && st.V > 8 && this.stallFrac > 0.33;
    this.mach = st.V / speedOfSound(0);
    this.model.quaternion.copy(q);
    ac.w.set(0, 0, 0);
  }

  // stall angle (lift peak over the angle range) and static stability, at the current speed, controls and flaps
  analyse() {
    const st = this.st, key = `${Math.round(Math.log(st.V) * 40)}|${st.flaps}|${st.elev}|${st.ail}|${st.rud}|${st.beta}|${st.air}`;
    if (key === this.anaKey) return;
    const now = performance.now(); if (this.anaKey && now - this.anaT < 150) return; // (a slider being dragged: a few times a second is plenty)
    this.anaKey = key; this.anaT = now;
    const zero = _z.set(0, 0, 0), q = new THREE.Quaternion(), lift = (a, b) => { this.aero(this.attitude(a * D2R, b * D2R, q), st.V, zero); return this.F.clone().applyQuaternion(q); };
    // the stall: the first peak in lift with the lift falling away after it (on a jet the body's own push at very high
    // angles can climb again later; that isn't the wing)
    let best = -Infinity, at = null; this.stallAt = null;
    for (let a = AOA[0]; a <= AOA[1] + 10; a += 0.5) {
      const L = lift(a, st.beta).y;
      if (L > best) { best = L; at = a; } else if (best > 0.1 * this.ac.mass * G && L < best * 0.97) { this.stallAt = this.stats.wingArea > 0.5 ? at : null; break; }
    }
    this.liftMax = best;
    // stability: how the moments change with angle (finite differences of the same forces)
    const Vref = Math.max(st.V, 25), a0 = clamp(st.pivot ? 2 : st.aoa, -4, 10), d = 1;
    const mom = (a, b) => { this.aero(this.attitude(a * D2R, b * D2R, q), Vref, zero); return { T: this.T.clone().multiplyScalar(this.ac.R.aeroTorque), L: this.F.clone().applyQuaternion(q).y }; };
    const pA = mom(a0 + d, 0), pB = mom(a0 - d, 0), yA = mom(a0, d), yB = mom(a0, -d);
    const dM = (pA.T.x - pB.T.x) / (2 * d * D2R), dL = (pA.L - pB.L) / (2 * d * D2R), dN = (yA.T.y - yB.T.y) / (2 * d * D2R);
    const S = this.stats, qd = 0.5 * airDensity(0) * Vref * Vref, mac = S.wingArea > 0 ? Math.sqrt(S.wingArea / 7) : 1, span = Math.max(1, this.flow.span || 1);
    this.pitchMargin = dL > qd * 0.05 ? -dM / (dL * mac) : null; // static margin (fractions of a chord): + = stable
    this.pitchStiff = -dM / (qd * Math.max(1, S.wingArea) * mac);
    this.yawStiff = -dN / (qd * Math.max(1, S.wingArea) * span); // weathervane stiffness: + = stable
  }

  // ---------- readouts ----------
  verdicts() {
    const pm = this.pitchMargin, ps = this.pitchStiff, ys = this.yawStiff, aero = this.ac.R.aeroTorque > 0;
    const pitch = !aero ? ['warn', 'Magic', 'Arcade air keeps it steady'] : pm !== null ? (pm > 0.04 ? (pm > 0.6 ? ['warn', 'Very stable', 'nose-heavy: hard to pull up'] : ['good', 'Stable ✓', 'swings back to the wind']) : pm > -0.01 ? ['warn', 'Wobbly', 'only just stable'] : ['bad', 'Will flip! ✗', 'unstable'])
      : ps > 0.004 ? ['good', 'Stable ✓', 'swings back to the wind'] : ps > -0.002 ? ['warn', 'Wobbly', 'hardly any pull back'] : ['bad', 'Will flip! ✗', 'unstable'];
    const yaw = !aero ? ['warn', 'Magic', 'Arcade air keeps it steady'] : ys > 0.004 ? ['good', 'Stable ✓', 'points into the wind'] : ys > -0.0005 ? ['warn', 'Wobbly', 'hardly any pull back'] : ['bad', 'Will spin! ✗', 'unstable'];
    return { pitch, yaw };
  }
  readouts() {
    const st = this.st, W = this.ac.mass, Fw = this.Fw;
    const L = Fw.y / G, D = Fw.z / G, Y = Fw.x / G, g = this.el.g;
    const enough = L >= W * 0.98;
    g.lift.b.textContent = kg(L);
    g.lift.small.textContent = L < -W * 0.02 ? 'pushing DOWN!' : enough ? 'enough to fly! ✓' : `needs ${kg(W - L)} more`;
    g.lift.box.className = `wt-g ${L < 0 ? 'bad' : enough ? 'good' : 'warn'}`;
    g.lift.bar.style.width = `${clamp(L / W, 0, 1) * 100}%`;
    g.drag.b.textContent = kg(D); g.drag.small.textContent = D > W ? 'more than it weighs!' : 'pushing back';
    const ld = D > 0.05 ? L / D : null;
    g.ld.b.textContent = ld === null ? '—' : fmt(ld, 1);
    g.ld.small.textContent = ld === null ? '' : ld > 15 ? 'glider-slick!' : ld > 8 ? 'nice and slippery' : ld > 3 ? 'OK' : ld > 0 ? 'draggy' : 'no lift';
    g.ld.box.className = `wt-g ${ld === null ? '' : ld > 8 ? 'good' : ld > 3 ? '' : 'warn'}`;
    g.stall.b.textContent = this.stallAt === null ? (this.ac.R.stallSharp > 0 ? '—' : 'never') : `${fmt(this.stallAt, 1)}°`;
    g.stall.small.textContent = this.stallAt === null ? (this.ac.R.stallSharp > 0 ? 'no stall in range' : 'Arcade wings never stall') : `max lift ${kg(this.liftMax / G)}`;
    const v = this.verdicts();
    for (const k of ['pitch', 'yaw']) { g[k].b.textContent = v[k][1]; g[k].small.textContent = v[k][2]; g[k].box.className = `wt-g ${v[k][0]}`; }
    this.el.stall.style.display = this.stalled ? 'block' : 'none';
    this.el.boom.style.display = this.mach > 1 && !this.stalled ? 'block' : 'none';
    // tips
    const tips = this.tips(L, D, W, v);
    const html = tips.slice(0, 3).map(([k, t]) => `<li class="${k}">${t}</li>`).join('');
    if (html !== this.tipsHTML) { this.tipsHTML = html; this.el.tips.innerHTML = html; }
    // 3D desk dials: lift (0-2 x weight), drag (0-weight), speed (0-Mach 3)
    const dl = this.set.dials, sw = (x) => -2.2 + clamp(x, 0, 1) * 4.4;
    dl[0].rotation.z = -sw(L / (2 * W)); dl[1].rotation.z = -sw(D / W); dl[2].rotation.z = -sw(st.V / V_MAX);
  }
  tips(L, D, W, v) {
    const st = this.st, S = this.stats, out = [], plane = S.wingArea > 0.5 && !S.heli;
    if (this.stalled) out.push(['bad', 'STALL! The wing is tipped up so far that the air can’t follow its top any more: it tumbles off and the lift drops. Lower the nose!']);
    if (this.mach > 1.02) out.push(['warn', 'Supersonic! The air can’t get out of the way in time, so it piles up into shock waves: the cone-shaped lines.']);
    else if (this.mach > 0.85) out.push(['warn', 'Near the speed of sound the drag shoots up: this is the sound barrier.']);
    if (this.ac.R.gLimit < Infinity && L > W * this.ac.R.gLimit * 1.1) out.push(['bad', `In a real flight this much lift (${fmt(L / W, 0)} times the plane’s weight) would snap the wings off!`]);
    if (v.pitch[0] === 'bad') out.push(['bad', S.finArea > 0 || S.wingArea > 0.5 ? 'Your tail is too small, the plane wants to flip! Try a bigger tail, move it further back, or move the wings back a bit.' : 'It wants to flip! Add a tail at the back.']);
    else if (v.pitch[1] === 'Wobbly') out.push(['warn', 'Only just stable in pitch: it will bob up and down. A bigger tail would help.']);
    else if (v.pitch[1] === 'Very stable') out.push(['warn', 'Very nose-heavy: it will be hard to lift the nose. Move the wings forward a little.']);
    if (v.yaw[0] === 'bad') out.push(['bad', S.finArea < 0.4 ? 'No tail fin! The plane wants to spin round. Add a fin at the back.' : 'Not enough tail fin: the plane wants to spin round! Add a bigger fin at the back.']);
    if (plane && st.V > 8 && !this.stalled) {
      if (L < 0) out.push(['warn', 'The wing points down, so the lift pushes DOWN. Tip the nose up!']);
      else if (L < W * 0.98) out.push(['info', `Not enough lift to fly at this speed yet: ${kg(L)} of lift for ${kg(W)} of plane. Go faster, tip the nose up a little, or use flaps.`]);
      else out.push(['good', `Lift ${kg(L)} holds up ${kg(W)} of plane: enough to fly!`]);
    }
    if (st.flaps > 0) out.push(['info', 'Flaps bend the back of the wing down: more lift for slow flying, but more drag too.']);
    if (Math.abs(st.elev) > 0.1) out.push(['info', st.elev > 0 ? 'Elevator up: the tail pushes down, so the nose wants to go up.' : 'Elevator down: the tail lifts, so the nose wants to go down.']);
    if (Math.abs(st.ail) > 0.1) out.push(['info', 'Ailerons: one goes up and one goes down, so one wing lifts more and the plane rolls.']);
    if (Math.abs(st.rud) > 0.1) out.push(['info', 'Rudder: the fin pushes the tail sideways, so the nose swings the other way.']);
    if (plane && D > 0.05 && L / D > 15) out.push(['good', 'Super slippery: lots of lift for very little drag, like a glider.']);
    if (st.pivot && v.pitch[0] === 'good' && v.yaw[0] === 'good') out.push(['good', 'Free pivot: it keeps swinging back to point into the wind. That’s a stable design!']);
    if (st.mode === 0) out.push(['info', 'Try Smoke: Speed. The air over the top of a lifting wing goes faster than under it.']);
    if (!out.length) out.push(['info', 'Slide the angle up until the wing stalls, or try the free pivot to see if your design is stable.']);
    return out;
  }
  // chart: lift (kg) against angle, drawn as the angle is swept, with the weight line and the stall
  drawChart() {
    const c = this.el.chart, dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const W = this.ac.mass, pts = [...this.curve.entries()].sort((a, b) => a[0] - b[0]);
    let top = W * 1.3, bot = -W * 0.3; for (const [, L] of pts) { top = Math.max(top, L * 1.1); bot = Math.min(bot, L * 1.1); }
    const pl = 34, pr = 8, pt = 8, pb = 18, X = (a) => pl + (a - AOA[0]) / (AOA[1] - AOA[0]) * (w - pl - pr), Yp = (L) => pt + (top - L) / (top - bot) * (h - pt - pb);
    g.font = '10px system-ui, sans-serif'; g.fillStyle = '#95a1ad'; g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
    for (let a = -10; a <= 30; a += 10) { g.beginPath(); g.moveTo(X(a), pt); g.lineTo(X(a), h - pb); g.stroke(); g.fillText(`${a}°`, X(a) - 8, h - 5); }
    g.beginPath(); g.moveTo(pl, Yp(0)); g.lineTo(w - pr, Yp(0)); g.strokeStyle = 'rgba(255,255,255,.3)'; g.stroke();
    g.setLineDash([5, 4]); g.strokeStyle = '#ffd400'; g.beginPath(); g.moveTo(pl, Yp(W)); g.lineTo(w - pr, Yp(W)); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#ffd400'; g.fillText('weight', pl + 2, Yp(W) - 3);
    g.save(); g.translate(10, h / 2); g.rotate(-Math.PI / 2); g.fillStyle = '#95a1ad'; g.fillText('lift', -8, 0); g.restore();
    if (pts.length > 1) {
      g.strokeStyle = '#4cd486'; g.lineWidth = 2.5; g.beginPath();
      pts.forEach(([a, L], i) => (i ? g.lineTo(X(a), Yp(L)) : g.moveTo(X(a), Yp(L)))); g.stroke();
      // stall: the peak, once the curve has gone past it
      let bi = 0; pts.forEach(([, L], i) => { if (L > pts[bi][1]) bi = i; });
      if (bi < pts.length - 3 && pts.at(-1)[1] < pts[bi][1] * 0.97 && this.ac.R.stallSharp > 0) {
        const [a, L] = pts[bi]; g.fillStyle = '#ff5a4f'; g.beginPath(); g.arc(X(a), Yp(L), 5, 0, 7); g.fill(); g.font = 'bold 11px system-ui, sans-serif'; g.fillText(`stall ${fmt(a, 1)}°`, Math.min(X(a) + 6, w - 62), Yp(L) + 4);
      }
    }
    const a = this.st.pivot ? wrapPi(this.piv.th) / D2R : this.st.aoa;
    if (a >= AOA[0] && a <= AOA[1]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(X(a), Yp(this.Fw.y / G), 4, 0, 7); g.fill(); }
  }
  recordCurve() {
    const st = this.st, key = `${Math.round(Math.log(st.V) * 40)}|${st.flaps}|${st.elev}|${st.ail}|${st.rud}|${Math.round(st.pivot ? wrapPi(this.piv.ps) / D2R : st.beta)}|${st.air}|${st.pivot}`;
    if (key !== this.curveKey) { this.curveKey = key; this.curve.clear(); }
    const a = st.pivot ? wrapPi(this.piv.th) / D2R : st.aoa;
    if (a < AOA[0] || a > AOA[1]) return;
    this.curve.set(Math.round(a * 2) / 2, this.Fw.y / G);
  }
  // arrows at the CoM: lift (square to the wind), drag (along it), side force, and the weight to compare with
  arrowsAndLabels() {
    const W = this.ac.mass * G, Fw = this.Fw, len = (F) => (Math.abs(F) < W * 0.01 ? 0 : clamp(0.35 + 2.6 * Math.sqrt(Math.abs(F) / W), 0.35, 5.5));
    const a = this.arrows;
    this.setArrow(a.lift, _d.set(0, Math.sign(Fw.y) || 1, 0), len(Fw.y));
    this.setArrow(a.drag, _d.set(0, 0, Math.sign(Fw.z) || 1), len(Fw.z));
    this.setArrow(a.side, _d.set(Math.sign(Fw.x) || 1, 0, 0), len(Fw.x) > 0.5 ? len(Fw.x) : 0);
    this.setArrow(a.weight, _d.set(0, -1, 0), len(W));
    a.weight.g.position.set(0.25, Y0, 0); a.weight.tip = a.weight.g.position.clone().add(_d.set(0, -len(W) - 0.25, 0));
    const W0 = this.ac.mass, L = Fw.y / G, cam = this.camera, el = this.el.lab, wpx = this.renderer.domElement.clientWidth, hpx = this.renderer.domElement.clientHeight;
    const text = {
      lift: `Lift: ${kg(L)}${L >= W0 * 0.98 ? ' — enough to fly!' : L < 0 ? ' — pushing down!' : ''}`,
      drag: `Drag: ${kg(Fw.z / G)}`, side: `Side push: ${kg(Math.abs(Fw.x / G))}`, weight: `Weight: ${kg(W0)}`,
    };
    for (const k of ['lift', 'drag', 'side', 'weight']) {
      const ar = a[k], e = el[k];
      if (!ar.g.visible || !ar.tip) { e.style.display = 'none'; continue; }
      const p = _p.copy(ar.tip).project(cam);
      if (p.z > 1) { e.style.display = 'none'; continue; }
      e.style.display = ''; e.textContent = text[k];
      e.style.left = `${clamp((p.x * 0.5 + 0.5) * wpx, 60, wpx - 60)}px`; e.style.top = `${clamp((-p.y * 0.5 + 0.5) * hpx, 70, hpx - 20)}px`;
    }
  }

  // ---------- per frame ----------
  frame(dt) {
    if (!this.ready || this.closed) return;
    const t0 = performance.now(), st = this.st, ac = this.ac;
    this.analyse();
    this.physics(dt);
    // the smoke follows the flight model's per-strip loads
    this.flow.setState(this.q, this.mach, this.probe, airDensity(0), st.V, ac.R.stallSharp > 0);
    this.flow.update(dt, st.V, BUDGET[this.tier] * (this.perf.frac < 1 ? 0.6 : 1));
    // control surfaces swing to their deflections; props windmill
    for (const p of ac.parts) {
      for (const s of p.surfaces) if (s.ctrlObj) s.ctrlObj.rotation.x += (s.delta - s.ctrlObj.rotation.x) * Math.min(1, dt * 12);
      const e = p.engine; if (e?.prop?.userData.spinner) e.prop.userData.spinner.rotation.z += dt * Math.min(40, st.V / 4) * (e.spinDir || 1);
    }
    this.set.fan.rotation.z -= dt * (0.6 + Math.min(st.V, 400) / 18);
    this.arrowsAndLabels();
    this.recordCurve();
    this.ui2T = (this.ui2T || 0) + dt;
    if (this.ui2T > 0.12) { this.ui2T = 0; this.readouts(); this.drawChart(); if (st.pivot || this.sweep) this.showValues(); }
    if (this.audioOn) this.sound();
    // log for analytics
    const L = this.log; L.maxV = Math.max(L.maxV, st.V); L.maxMach = Math.max(L.maxMach, this.mach); L.stalled ||= this.stalled;
    const a = st.pivot ? wrapPi(this.piv.th) / D2R : st.aoa; L.aoaMin = Math.min(L.aoaMin, a); L.aoaMax = Math.max(L.aoaMax, a);
    this.controls.update();
    clampCam(this.camera);
    this.o.render(this.scene, this.camera, dt);
    // shaders: all compiled when the tunnel opened; flag any that compile now (a hitch on the tablet)
    const n = this.renderer.info.programs.length;
    if (this.perf.frames === 3) this.progs = n;
    else if (this.perf.frames > 3 && n > this.progs) { console.warn(`[shaders] ${n - this.progs} compiled in the wind tunnel`); window.__tunnelCompiles = (window.__tunnelCompiles || 0) + n - this.progs; this.progs = n; }
    this.govern(dt, performance.now() - t0);
  }
  // keep the frame rate: fewer smoke lines when it struggles, back up when there's room
  govern(dt, cpuMs) {
    const P = this.perf, ms = dt * 1000; P.frames++;
    if (P.frames > 5 && ms < 500) { P.msSum += ms; P.worst = Math.max(P.worst, ms); P.cpu = (P.cpu || 0) + cpuMs; P.n = (P.n || 0) + 1; }
    if (ms > 100) return;
    P.ema += (ms - P.ema) * 0.05;
    if (P.ema > 24) { P.slowT += dt; P.fastT = 0; } else if (P.ema < 17.5) { P.fastT += dt; P.slowT = 0; } else P.slowT = P.fastT = 0;
    if (P.slowT > 1.5 && P.frac > 0.35) { P.frac = Math.max(0.35, P.frac - 0.15); P.slowT = 0; this.flow.setActive(P.frac); this.flow.dirty = true; }
    else if (P.fastT > 5 && P.frac < 1) { P.frac = Math.min(1, P.frac + 0.15); P.fastT = 0; this.flow.setActive(P.frac); this.flow.dirty = true; this.flow.dirtyAt = performance.now(); }
  }
  sound() {
    const a = this.o.audio; if (!a?.ctx || !a.bedGain) return;
    const sp = this.st.V, amt = Math.min(0.5, (Math.min(sp, 340) / 120) ** 1.4 * 0.3 + 0.02);
    a.bedGain('wind_ext', a.airBus, amt * 2.2, 0.25, 0.7 + Math.min(1.2, sp / 250));
  }
  resize(w, h) { if (!this.camera) return; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.drawChart(); }
  stats4test() { const P = this.perf; return { frames: P.n || 0, avgMs: P.n ? P.msSum / P.n : 0, worstMs: P.worst, cpuMs: P.n ? P.cpu / P.n : 0, lines: this.flow.active, compiles: window.__tunnelCompiles || 0 }; }

  // ---------- close ----------
  exit(reason = 'hangar') { if (this.closed) return; this.track(reason); this.o.onExit?.(); }
  track(exit) {
    if (this.tracked || !this.o.analytics) return; this.tracked = true;
    const L = this.log, t = this.o.track || {};
    this.o.analytics.capture('wind_tunnel', {
      ...t, exit, seconds: Math.round((performance.now() - L.t0) / 1000), max_speed_kmh: Math.round(L.maxV * 3.6), max_mach: +L.maxMach.toFixed(2),
      aoa_min: L.aoaMin < 99 ? Math.round(L.aoaMin) : null, aoa_max: L.aoaMax > -99 ? Math.round(L.aoaMax) : null, stalled: L.stalled, free_pivot: L.pivot, sweeps: L.sweeps,
      used_controls: L.controls, used_flaps: L.flaps, smoke_modes: [...L.modes].map((m) => ['white', 'speed', 'pressure'][m]), air: [...L.air],
      pitch: this.verdicts?.().pitch[1] ?? null, yaw: this.verdicts?.().yaw[1] ?? null, stall_deg: this.stallAt ?? null, scale: this.scaleN, quality: this.tier, lines: this.flow?.active ?? null,
      fps_avg: this.perf.n ? Math.round(1000 / (this.perf.msSum / this.perf.n)) : null,
    });
  }
  // Free everything the tunnel put on the GPU (geometry, textures, the environment and shadow maps) except what keep has.
  dispose() {
    this.closed = true;
    removeEventListener('resize', this.onResize); removeEventListener('keydown', this.onKey);
    this.controls?.dispose(); this.ui?.remove();
    const a = this.o.audio; if (a?.ctx && a.bedGain) a.bedGain('wind_ext', a.airBus, 0, 0.2);
    if (!this.scene) return;
    this.scene.environment = null;
    const res = this.o.collectGpu(this.scene), keep = this.o.keepGpu?.() || { geo: new Set(), tex: new Set() };
    for (const kind of ['geo', 'tex']) for (const r of res[kind]) if (!keep[kind].has(r)) r.dispose();
    this.flow.dispose(); this.arrowGeo.shaft.dispose(); this.arrowGeo.head.dispose();
    this.envRT.dispose(); this.pmrem.dispose();
    this.set.sun.shadow.dispose?.(); this.set.sun.shadow.map = null;
    this.renderer.renderLists.dispose();
    this.scene.clear(); this.scene = null;
  }
}

function esc(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
// merge position/normal-only geometries (indexed or not) into one
function mergeAll(geos) {
  let n = 0; const parts = geos.map((g) => { const ng = g.index ? g.toNonIndexed() : g; n += ng.attributes.position.count; return ng; });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; if (!geos.includes(g)) g.dispose(); }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); return out;
}
// keep the camera in the hall, above the floor
function clampCam(cam) {
  const p = cam.position;
  p.x = clamp(p.x, -40, 40); p.y = clamp(p.y, 0.6, 23); p.z = clamp(p.z, -48, 50);
}
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _vb = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _ax = new THREE.Vector3(), _z = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
