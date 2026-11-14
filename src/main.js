import * as THREE from 'three';
import { PARTS, CATEGORIES, PAINTS } from './parts.js';
import { makePresets, encodeDesign, decodeDesign, cloneDesign, analyze } from './design.js';
import { Hangar, makeThumbnails } from './hangar.js';
import { Aircraft, REALISM } from './aircraft.js';
import { World, LOCATIONS, WEATHER } from './world.js';
import { Traffic, buildStatic } from './traffic.js';
import { Effects } from './effects.js';
import { Audio } from './audio.js';
import { Controls } from './controls.js';
import { HUD } from './hud.js';
import { CameraRig } from './cameras.js';
import { MODES, RingRace, LandingChallenge } from './missions.js';
import { clamp } from './noise.js';
import { installFog } from './shaders.js';
import { Post } from './post.js';
installFog();

// ---------- persistence ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('skywright.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('skywright.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const settings = Object.assign({ quality: isTouch ? 'medium' : 'high', units: 'imperial', invert: false, controlMode: 'stick', volume: 0.8, touch: 'auto' }, LS.get('settings', {}));
const flightCfg = Object.assign({ location: 'alpine', time: 10, weather: 'clear', realism: 'pilot', mode: 'free', start: 'runway' }, LS.get('flight', {}));

// ---------- renderer ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const pixelRatio = () => Math.min(window.devicePixelRatio || 1, { low: 1, medium: 1.5, high: 2 }[settings.quality]);
renderer.setPixelRatio(pixelRatio());
const post = new Post(renderer);
post.enabled = settings.quality !== 'low';

const audio = new Audio(); audio.volume = settings.volume;
const $ = (s) => document.querySelector(s);
const presets = makePresets();

// ---------- UI helpers ----------
const ui = {
  hint(t) { const h = $('#hint'); h.textContent = t; h.classList.add('show'); clearTimeout(this._h); this._h = setTimeout(() => h.classList.remove('show'), 2200); },
  modal(html, cls = '') {
    const root = $('#modal-root'); root.innerHTML = `<div class="modal-bg"><div class="modal ${cls}">${html}</div></div>`; root.style.display = 'block';
    const close = () => { root.innerHTML = ''; root.style.display = 'none'; };
    root.querySelector('.modal-bg').addEventListener('pointerdown', (e) => { if (e.target.classList.contains('modal-bg') && !cls.includes('sticky')) close(); });
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: root.querySelector('.modal'), close };
  },
};

// ---------- hangar ----------
const hangar = new Hangar(renderer, ui, audio);
let thumbs = {};
let activeCat = 'fuselage';

function buildPalette() {
  $('#cats').innerHTML = CATEGORIES.map((c) => `<button data-cat="${c.id}" class="${c.id === activeCat ? 'on' : ''}"><span>${c.icon}</span>${c.name}</button>`).join('');
  $('#cats').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { activeCat = b.dataset.cat; audio.play('click'); buildPalette(); }));
  const list = Object.values(PARTS).filter((p) => p.cat === activeCat);
  $('#part-list').innerHTML = list.map((p) => `<button class="part-card ${hangar.placing === p.id ? 'on' : ''}" data-id="${p.id}"><img src="${thumbs[p.id] || ''}" alt=""><div><b>${p.name}</b><small>${p.desc}</small><em>${p.mass.toLocaleString()} kg${p.engine ? ` · ${Math.round((p.engine.ab || p.engine.thrust) / 1000)} kN` : ''}</em></div></button>`).join('');
  $('#part-list').querySelectorAll('.part-card').forEach((b) => b.addEventListener('click', () => {
    audio.init();
    if (hangar.placing === b.dataset.id) hangar.cancelPlacing(); else { hangar.startPlacing(b.dataset.id); if (hangar.design.parts.length > 1 || hangar.placing) ui.hint(isTouch ? 'Tap on your plane to attach' : 'Click on your plane to attach (Esc to cancel)'); }
    buildPalette();
  }));
}

function fmt(n, d = 0) { return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—'; }
function renderInspector() {
  const d = hangar.design, s = hangar.stats || analyze(d);
  $('#plane-name').value = d.name || '';
  const sel = hangar.sel >= 0 ? d.parts[hangar.sel] : null;
  const sp = $('#sel-panel');
  if (sel) {
    const def = PARTS[sel.id];
    sp.hidden = false;
    sp.innerHTML = `<h3>${def.name}${hangar.partner(hangar.sel) >= 0 && hangar.symmetry ? ' <span class="pill">×2 mirrored</span>' : ''}</h3>
      <p class="desc">${def.desc}</p>
      <div class="pad">
        <div class="pad-group"><label>Move</label>
          <div class="grid3">
            <span></span><button data-n="1,1" title="Up">▲</button><span></span>
            <button data-n="0,-1" title="Left">◀</button><button data-step class="step">${hangar.step >= 0.25 ? 'BIG' : 'FINE'}</button><button data-n="0,1" title="Right">▶</button>
            <span></span><button data-n="1,-1" title="Down">▼</button><span></span>
          </div>
          <div class="row2"><button data-n="2,-1">Forward</button><button data-n="2,1">Back</button></div>
        </div>
        <div class="pad-group"><label>Rotate</label>
          <div class="row2"><button data-r="0,-15">Pitch −</button><button data-r="0,15">Pitch +</button></div>
          <div class="row2"><button data-r="1,15">Yaw −</button><button data-r="1,-15">Yaw +</button></div>
          <div class="row2"><button data-r="2,15">Roll −</button><button data-r="2,-15">Roll +</button></div>
          <div class="row2"><button data-flip>Flip</button><button data-reset>Reset</button></div>
        </div>
      </div>
      <label class="lbl">Paint</label>
      <div class="swatches">${PAINTS.map((c) => `<button style="background:#${c.toString(16).padStart(6, '0')}" data-c="${c}" class="${c === sel.color ? 'on' : ''}"></button>`).join('')}</div>
      <button class="danger wide" data-del>🗑 Remove part${hangar.sel === 0 ? ' (and everything)' : ''}</button>`;
    sp.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => { const [a, dd] = b.dataset.n.split(',').map(Number); hangar.nudge(a, dd); }));
    sp.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { const [a, dd] = b.dataset.r.split(',').map(Number); hangar.rotate(a, dd); }));
    sp.querySelector('[data-step]').addEventListener('click', () => { hangar.step = hangar.step >= 0.25 ? 0.05 : 0.5; renderInspector(); });
    sp.querySelector('[data-flip]').addEventListener('click', () => hangar.flip());
    sp.querySelector('[data-reset]').addEventListener('click', () => hangar.resetRotation());
    sp.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => hangar.paint(+b.dataset.c)));
    sp.querySelector('[data-del]').addEventListener('click', () => hangar.deleteSel());
  } else sp.hidden = true;
  const marginPct = clamp(s.margin, -0.5, 1);
  const balPos = clamp(50 + marginPct * 60, 4, 96);
  $('#stats').innerHTML = `
    <h3>${d.parts.length ? 'Flight check' : 'Empty hangar'}</h3>
    <div class="stat-grid">
      <div><label>Mass</label><b>${fmt(s.mass)} kg</b></div>
      <div><label>Parts</label><b>${d.parts.length}</b></div>
      <div><label>Thrust/Weight</label><b>${fmt(s.tw, 2)}</b></div>
      <div><label>Engines</label><b>${s.engines}</b></div>
      <div><label>Wing area</label><b>${fmt(s.wingArea, 1)} m²</b></div>
      <div><label>Stall speed</label><b>${Number.isFinite(s.stall) ? fmt(s.stall * (settings.units === 'metric' ? 3.6 : 1.944)) + (settings.units === 'metric' ? ' km/h' : ' kt') : '—'}</b></div>
    </div>
    <label class="lbl">Balance <small>(<span style="color:#ffd400">●</span> mass &nbsp;<span style="color:#3ab0ff">●</span> lift)</small></label>
    <div class="balance"><div class="zone"></div><div class="needle" style="left:${balPos}%"></div><span class="l">tail-heavy</span><span class="r">nose-heavy</span></div>
    <ul class="warnings">${s.warnings.map(([k, t]) => `<li class="${k}">${t}</li>`).join('')}</ul>`;
  $('#btn-sym').classList.toggle('on', hangar.symmetry);
  $('#btn-bal').classList.toggle('on', hangar.showBalance);
  $('#btn-fly').disabled = !d.parts.length;
  $('#placing-bar').hidden = !hangar.placing;
  if (hangar.placing) $('#placing-bar span').textContent = `Placing: ${PARTS[hangar.placing].name}`;
  LS.set('current', hangar.design);
}
hangar.onChange = () => { renderInspector(); };

$('#plane-name').addEventListener('input', (e) => { hangar.design.name = e.target.value; LS.set('current', hangar.design); });
$('#btn-undo').addEventListener('click', () => hangar.undo());
$('#btn-redo').addEventListener('click', () => hangar.redo());
$('#btn-sym').addEventListener('click', () => { hangar.symmetry = !hangar.symmetry; renderInspector(); });
$('#btn-bal').addEventListener('click', () => { hangar.showBalance = !hangar.showBalance; hangar.rebuild(); });
$('#btn-frame').addEventListener('click', () => hangar.frame());
$('#placing-bar button').addEventListener('click', () => { hangar.cancelPlacing(); buildPalette(); });
$('#btn-planes').addEventListener('click', () => { audio.init(); planesModal(); });
$('#btn-settings').addEventListener('click', () => settingsModal());
$('#btn-help').addEventListener('click', () => helpModal());
$('#btn-fly').addEventListener('click', () => { audio.init(); flightModal(); });
$('#btn-toggle-left').addEventListener('click', () => document.body.classList.toggle('hide-left'));
$('#btn-toggle-right').addEventListener('click', () => document.body.classList.toggle('hide-right'));
window.addEventListener('keydown', (e) => {
  if (state !== 'hangar' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { hangar.cancelPlacing(); hangar.sel = -1; hangar.updateSelection(); buildPalette(); renderInspector(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && hangar.sel >= 0) hangar.deleteSel();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? hangar.redo() : hangar.undo(); e.preventDefault(); }
});

function planesModal() {
  const mine = LS.get('designs', []);
  const card = (d, i, kind) => { const s = analyze(d); return `<div class="plane-card"><b>${d.name}</b><small>${d.desc || `${d.parts.length} parts · ${fmt(s.mass)} kg`}</small><div class="row2"><button data-load="${kind}:${i}" class="primary">Load</button>${kind === 'mine' ? `<button data-delp="${i}" class="danger">Delete</button>` : ''}</div></div>`; };
  const m = ui.modal(`
    <h2>Planes</h2>
    <div class="tabs"><button class="on" data-tab="presets">Hangar classics</button><button data-tab="mine">My planes (${mine.length})</button><button data-tab="share">Share / import</button></div>
    <div data-pane="presets" class="plane-grid">${presets.map((d, i) => card(d, i, 'preset')).join('')}<div class="plane-card"><b>Blank sheet</b><small>Start from nothing.</small><div class="row2"><button data-new class="primary">New</button></div></div></div>
    <div data-pane="mine" class="plane-grid" hidden>${mine.map((d, i) => card(d, i, 'mine')).join('') || '<p>No saved planes yet.</p>'}<div class="plane-card"><b>Save current</b><small>“${hangar.design.name}”</small><div class="row2"><button data-save class="primary">Save</button></div></div></div>
    <div data-pane="share" hidden>
      <p>Copy this code to share <b>${hangar.design.name}</b>:</p>
      <textarea readonly rows="3" id="share-code">${encodeDesign(hangar.design)}</textarea>
      <div class="row2"><button id="copy-code">Copy code</button></div>
      <p>Paste a code to import a plane:</p>
      <textarea rows="3" id="import-code" placeholder="paste code here"></textarea>
      <div class="row2"><button id="import-btn" class="primary">Import</button></div>
    </div>
    <div class="modal-foot"><button data-close>Close</button></div>`, 'wide');
  const el = m.el;
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b)); el.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab)); }));
  el.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => { const [k, i] = b.dataset.load.split(':'); hangar.load(k === 'preset' ? presets[+i] : mine[+i]); audio.play('clank'); m.close(); }));
  el.querySelectorAll('[data-delp]').forEach((b) => b.addEventListener('click', () => { mine.splice(+b.dataset.delp, 1); LS.set('designs', mine); m.close(); planesModal(); }));
  el.querySelector('[data-new]').addEventListener('click', () => { hangar.load({ name: 'My Plane', parts: [] }); activeCat = 'fuselage'; buildPalette(); m.close(); ui.hint('Pick a body to start'); });
  el.querySelector('[data-save]').addEventListener('click', () => { const i = mine.findIndex((d) => d.name === hangar.design.name); const c = cloneDesign(hangar.design); if (i >= 0) mine[i] = c; else mine.push(c); LS.set('designs', mine); ui.hint('Saved!'); m.close(); });
  el.querySelector('#copy-code').addEventListener('click', () => { const t = el.querySelector('#share-code'); t.select(); navigator.clipboard?.writeText(t.value).then(() => ui.hint('Copied!'), () => document.execCommand('copy')); });
  el.querySelector('#import-btn').addEventListener('click', () => { try { hangar.load(decodeDesign(el.querySelector('#import-code').value)); m.close(); ui.hint('Imported!'); } catch (e) { ui.hint('That code didn’t work'); } });
}

function timeLabel(t) { const h = Math.floor(t), mm = Math.round((t - h) * 60); const lab = t < 5 || t > 20.5 ? 'Night' : t < 7.5 ? 'Dawn' : t < 11 ? 'Morning' : t < 15 ? 'Midday' : t < 18 ? 'Afternoon' : 'Sunset'; return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${lab}`; }
function flightModal() {
  const s = analyze(hangar.design);
  const m = ui.modal(`
    <h2>Ready for take-off: ${hangar.design.name}</h2>
    <label class="lbl">Location</label>
    <div class="choice-row">${Object.values(LOCATIONS).map((l) => `<button class="loc-card ${l.id}${flightCfg.location === l.id ? ' on' : ''}" data-loc="${l.id}"><b>${l.name}</b><small>${l.desc}</small></button>`).join('')}</div>
    <label class="lbl">Time of day <span id="tlab">${timeLabel(flightCfg.time)}</span></label>
    <input type="range" min="0" max="24" step="0.25" value="${flightCfg.time}" id="time" class="time-slider">
    <label class="lbl">Weather</label>
    <div class="chips">${Object.entries(WEATHER).map(([k, w]) => `<button data-w="${k}" class="${flightCfg.weather === k ? 'on' : ''}">${w.name}</button>`).join('')}</div>
    <label class="lbl">Realism</label>
    <div class="choice-row">${Object.values(REALISM).map((r) => `<button class="opt-card${flightCfg.realism === r.id ? ' on' : ''}" data-r="${r.id}"><b>${r.name}</b><small>${{ arcade: 'Anything flies, even with one wing. Very hard to break.', pilot: 'Balance and drag matter a bit. Gentle stalls and some help.', sim: 'Real weight, balance, stalls, G-limits and hard landings.' }[r.id]}</small></button>`).join('')}</div>
    <label class="lbl">Mode</label>
    <div class="choice-row">${Object.entries(MODES).map(([k, mo]) => `<button class="opt-card${flightCfg.mode === k ? ' on' : ''}" data-m="${k}"><b>${mo.name}</b><small>${mo.desc}</small></button>`).join('')}</div>
    <label class="lbl">Start</label>
    <div class="chips"><button data-s="runway" class="${flightCfg.start === 'runway' ? 'on' : ''}">On the runway</button><button data-s="air" class="${flightCfg.start === 'air' ? 'on' : ''}">In the air</button>${s.floats ? `<button data-s="water" class="${flightCfg.start === 'water' ? 'on' : ''}">On the water</button>` : ''}</div>
    <div class="modal-foot"><button data-close>Back</button><button class="primary big" id="go">FLY ▶</button></div>`, 'wide');
  const el = m.el;
  const pick = (attr, key) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => { flightCfg[key] = b.dataset[attr]; el.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle('on', x === b)); audio.play('click'); }));
  pick('loc', 'location'); pick('w', 'weather'); pick('r', 'realism'); pick('m', 'mode'); pick('s', 'start');
  el.querySelector('#time').addEventListener('input', (e) => { flightCfg.time = +e.target.value; el.querySelector('#tlab').textContent = timeLabel(flightCfg.time); });
  el.querySelector('#go').addEventListener('click', () => { LS.set('flight', flightCfg); m.close(); startFlight(); });
}

function settingsModal() {
  const m = ui.modal(`
    <h2>Settings</h2>
    <label class="lbl">Graphics</label><div class="chips">${['low', 'medium', 'high'].map((q) => `<button data-q="${q}" class="${settings.quality === q ? 'on' : ''}">${q[0].toUpperCase() + q.slice(1)}</button>`).join('')}</div>
    <label class="lbl">Units</label><div class="chips"><button data-u="imperial" class="${settings.units === 'imperial' ? 'on' : ''}">Knots &amp; feet</button><button data-u="metric" class="${settings.units === 'metric' ? 'on' : ''}">km/h &amp; metres</button></div>
    <label class="lbl">Touch steering</label><div class="chips"><button data-cm="stick" class="${settings.controlMode === 'stick' ? 'on' : ''}">On-screen stick</button><button data-cm="tilt" class="${settings.controlMode === 'tilt' ? 'on' : ''}">Tilt the tablet</button></div>
    <label class="lbl">On-screen controls</label><div class="chips">${['auto', 'on', 'off'].map((t) => `<button data-t="${t}" class="${settings.touch === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <label class="check"><input type="checkbox" id="inv" ${settings.invert ? 'checked' : ''}> Invert pitch (push stick forward / up-arrow to climb)</label>
    <label class="lbl">Volume</label><input type="range" min="0" max="1" step="0.05" value="${settings.volume}" id="vol">
    <div class="modal-foot"><button data-close class="primary">Done</button></div>`);
  const el = m.el;
  const pick = (attr, key, after) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => { settings[key] = b.dataset[attr]; el.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle('on', x === b)); LS.set('settings', settings); after?.(); }));
  pick('q', 'quality', () => { renderer.setPixelRatio(pixelRatio()); post.enabled = settings.quality !== 'low'; onResize(); });
  pick('u', 'units', renderInspector); pick('cm', 'controlMode', () => controls.setMode(settings.controlMode)); pick('t', 'touch');
  el.querySelector('#inv').addEventListener('change', (e) => { settings.invert = e.target.checked; controls.invert = settings.invert; LS.set('settings', settings); });
  el.querySelector('#vol').addEventListener('input', (e) => { settings.volume = +e.target.value; audio.setVolume(settings.volume); LS.set('settings', settings); });
}
function helpModal() {
  ui.modal(`<h2>How to play</h2>
  <div class="help">
  <h4>Build</h4><p>Pick a part on the left, then tap your plane where it should attach. With <b>Mirror</b> on, side parts are added in pairs. Tap a part to move, rotate, paint or remove it. The yellow dot is the centre of mass, the blue dot is the centre of lift: for a stable plane keep the yellow dot slightly <b>in front of</b> the blue one.</p>
  <h4>Fly — keyboard</h4>
  <table><tr><td>↑ ↓ / W S</td><td>Pitch (↓ pulls the nose up)</td></tr><tr><td>← → / A D</td><td>Roll</td></tr><tr><td>Q E</td><td>Rudder / steer on the ground</td></tr>
  <tr><td>Shift / Ctrl, R / F, 1–0</td><td>Throttle</td></tr><tr><td>B</td><td>Brakes</td></tr><tr><td>G</td><td>Gear up/down</td></tr><tr><td>V</td><td>Flaps</td></tr><tr><td>Space</td><td>Airshow smoke</td></tr><tr><td>C</td><td>Change camera</td></tr><tr><td>H</td><td>Hide HUD (photo mode)</td></tr><tr><td>Esc / P</td><td>Pause</td></tr></table>
  <h4>Fly — tablet</h4><p>Left thumb: throttle lever and rudder slider. Right thumb: the stick (pull down to climb). Or switch on <b>Tilt the tablet</b> in Settings. Drag the sky to look around; pinch to zoom.</p>
  <h4>Gamepad</h4><p>Left stick flies, right stick X is rudder, triggers set throttle, A brakes, B gear, X flaps, Y camera, LB smoke.</p>
  <h4>Tips</h4><p>Take off around the stall speed shown in the hangar. In Simulator mode, land gently (under ~3 m/s sink) or your gear will snap! Sailplanes can ride rising air under cumulus clouds and along sunny ridges.</p>
  </div><div class="modal-foot"><button data-close class="primary">Got it</button></div>`, 'wide');
}

// ---------- flight ----------
let state = 'hangar';
let F = null; // current flight
const flightUI = $('#flight-ui');
const hud = new HUD($('#hud'));
const controls = new Controls($('#touch-root'), (a) => onAction(a));
controls.invert = settings.invert; controls.setMode(settings.controlMode);
const flightCam = new THREE.PerspectiveCamera(60, 1, 0.2, 60000);
const rig = new CameraRig(flightCam, canvas);
$('#hud').addEventListener('click', (e) => { if (e.target.id === 'h-cam') onAction('camera'); if (e.target.id === 'h-pause') onAction('pause'); });

function findWater(world) {
  for (let r = 300; r < 6000; r += 150) for (let a = 0; a < Math.PI * 2; a += 0.25) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true; for (let k = -6; k <= 6; k++) if (world.heightAt(x, z + k * 60) > world.waterLevel - 2) { ok = false; break; }
    if (ok) return new THREE.Vector3(x, 0, z + 200);
  }
  return null;
}

function startFlight(cfgOverride) {
  const cfg = { ...flightCfg, ...cfgOverride };
  state = 'loading';
  $('#loading').classList.add('show');
  setTimeout(() => {
    try { buildFlight(cfg); } catch (e) { console.error(e); $('#loading').classList.remove('show'); state = 'hangar'; ui.hint('Something went wrong: ' + e.message); }
  }, 50);
}
function buildFlight(cfg) {
  const scene = new THREE.Scene();
  const world = new World(renderer, scene, { location: cfg.location, quality: settings.quality, time: cfg.time, weather: cfg.weather });
  world.addParked([buildStatic(presets[2]), buildStatic(presets[0]), buildStatic(presets[4]), buildStatic(presets[7])]);
  const realism = REALISM[cfg.realism];
  const design = cloneDesign(hangar.design);
  const ac = new Aircraft(design, realism);
  scene.add(ac.root);
  const effects = new Effects(scene);
  const traffic = new Traffic(scene, world, presets);
  const st = analyze(design);
  const env = {
    groundAt: (x, z) => world.groundAt(x, z), maxGround: (x, z) => world.maxGround(x, z), windAt: (p) => world.windAt(p),
    get night() { return world.night || world.W.dark > 0.6; }, groundHeightAtSpawn: world.loc.rwyH,
    onDebrisHit: (d, p, sp, g) => { if (sp > 10) { if (g.type === 'water') effects.splash(p, sp * 0.5); else effects.dust(p, { x: 0, z: 0 }, g.type, 6); } if (sp > 14 && Math.random() < 0.3) audio.play('impact', sp / 40, p.clone()); },
  };
  let start = cfg.start;
  const gearOK = ac.parts.some((p) => p.gear && !p.gear.float);
  if (cfg.mode === 'landing') start = 'approach';
  else if (start === 'water' || (start === 'runway' && st.floats && !gearOK)) start = 'water';
  if (start === 'runway' && (!ac.hasEngine)) start = 'air';
  const vApp = clamp(Number.isFinite(st.stall) ? st.stall * 1.45 : 45, 32, 110);
  if (start === 'runway') { ac.spawn(env, new THREE.Vector3(0, 0, world.runway.len / 2 - 60), 0); }
  else if (start === 'water') {
    const w = findWater(world);
    if (w) ac.spawn(env, w, 0); else { start = 'air'; }
  }
  if (start === 'air') { ac.spawn(env, new THREE.Vector3(0, 0, world.runway.len / 2 + 1200), 0, { air: true, alt: world.loc.rwyH + 450, speed: vApp * 1.1 }); controls.setThrottle(ac.hasEngine ? 0.65 : 0); }
  else if (start === 'approach') {
    const dist = 2600;
    ac.spawn(env, new THREE.Vector3(0, 0, world.runway.len / 2 - 380 + dist), 0, { air: true, alt: world.loc.rwyH + dist * Math.tan(THREE.MathUtils.degToRad(3)) + 3, speed: vApp, pitch: -0.02 });
    ac.gearDown = true; ac.gearT = 1; ac.flaps = 1; controls.setThrottle(0.55);
  } else controls.setThrottle(0);
  if (start === 'air') { ac.flaps = 0; }
  let mission = null;
  if (cfg.mode === 'rings') mission = new RingRace(scene, world, ac, cfg.realism);
  else if (cfg.mode === 'landing') mission = new LandingChallenge(world);
  F = { scene, world, ac, effects, traffic, env, cfg, mission, debris: [], timeScale: 1, slowmo: 0, endT: null, paused: false, shownEnd: false, events: [], sounds: [], cfgStart: start, lastSlowmo: -99 };
  rig.init = false; rig.set('chase'); rig.look.dist = 1;
  hud.setUnits(settings.units); hud.show(true);
  flightUI.style.display = ''; $('#hangar-ui').style.display = 'none';
  const showTouch = settings.touch === 'on' || (settings.touch === 'auto' && isTouch);
  controls.showTouch(showTouch); controls.enabled = true;
  document.body.classList.toggle('touch-on', showTouch);
  hangar.activate(false);
  audio.music(false);
  state = 'flight';
  $('#loading').classList.remove('show');
  onResize();
  const msg = { runway: `Runway 36 · ${world.loc.name}. Throttle up and pull back gently at ${Math.round(st.stall * (settings.units === 'metric' ? 3.6 : 1.944))} ${settings.units === 'metric' ? 'km/h' : 'kt'}!`, air: 'Airborne! Fly safe.', water: 'On the water. Full throttle and lift off!', approach: 'On final approach. Follow the PAPI lights: two white, two red.' }[start];
  hud.center(msg, 3500);
  if (!ac.hasEngine) hud.toast('Glider: look for rising air under clouds and over sunny ridges.');
}

function endFlight() {
  if (!F) return;
  const f = F; F = null;
  f.world.dispose(); f.effects.dispose(); f.traffic.dispose(); f.mission?.dispose?.();
  f.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  renderer.renderLists.dispose();
  audio.silence();
  flightUI.style.display = 'none'; $('#hangar-ui').style.display = '';
  controls.enabled = false; controls.showTouch(false);
  state = 'hangar'; hangar.activate(true); audio.music(true); audio.setSpace('hangar');
  onResize();
}

function onAction(a) {
  if (!F) return;
  const ac = F.ac;
  audio.init();
  switch (a) {
    case 'gear': ac.toggleGear(); break;
    case 'flaps': ac.cycleFlaps(); audio.play('flaps'); break;
    case 'camera': hud.toast(rig.next()); break;
    case 'smoke': if (ac.hasSmoke) { ac.smokeOn = !ac.smokeOn; hud.toast(ac.smokeOn ? 'Smoke on!' : 'Smoke off'); } else hud.toast('Add a Smoke Generator in the hangar for airshow smoke'); break;
    case 'pause': togglePause(); break;
    case 'hud': hud.show(!hud.visible); controls.showTouch(hud.visible && document.body.classList.contains('touch-on')); break;
    case 'debug': F.debug = !F.debug; break;
  }
}
function togglePause(force) {
  if (!F) return;
  F.paused = force ?? !F.paused;
  if (F.paused) {
    audio.silence();
    const m = ui.modal(`<h2>Paused</h2>
      <div class="pause-stats">${statsHTML(F.ac)}</div>
      <div class="col-buttons"><button class="primary big" data-a="resume">Resume</button><button data-a="restart">Restart flight</button><button data-a="calib" ${settings.controlMode !== 'tilt' ? 'hidden' : ''}>Re-centre tilt</button><button data-a="settings">Settings</button><button data-a="help">Controls help</button><button data-a="hangar" class="danger">Back to hangar</button></div>`, 'sticky');
    m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a; m.close();
      if (a === 'resume') F.paused = false;
      if (a === 'restart') { const c = F.cfg; endFlight(); startFlight(c); }
      if (a === 'hangar') endFlight();
      if (a === 'calib') { controls.calibrate(); F.paused = false; }
      if (a === 'settings') { settingsModal(); F.paused = true; }
      if (a === 'help') { helpModal(); F.paused = true; }
    }));
  } else { const r = $('#modal-root'); r.innerHTML = ''; r.style.display = 'none'; }
}
function statsHTML(ac) {
  const U = settings.units === 'metric' ? { s: 3.6, su: 'km/h', a: 1, au: 'm' } : { s: 1.944, su: 'kt', a: 3.28, au: 'ft' };
  const t = ac.stats;
  return `<div class="stat-grid">
    <div><label>Flight time</label><b>${Math.floor(t.time / 60)}:${String(Math.floor(t.time % 60)).padStart(2, '0')}</b></div>
    <div><label>Top speed</label><b>${Math.round(t.maxSpeed * U.s)} ${U.su}</b></div>
    <div><label>Highest</label><b>${Math.round(t.maxAlt * U.a).toLocaleString()} ${U.au}</b></div>
    <div><label>Max G</label><b>${t.maxG.toFixed(1)}</b></div>
    <div><label>Landings</label><b>${t.landings}</b></div>
    <div><label>Softest landing</label><b>${t.bestLanding === null ? '—' : t.bestLanding.toFixed(1) + ' m/s'}</b></div>
    <div><label>Distance</label><b>${(t.distance / 1000).toFixed(1)} km</b></div>
    <div><label>Parts lost</label><b>${t.partsLost}</b></div></div>`;
}
function showEnd(title, extra = '') {
  if (!F || F.shownEnd) return;
  F.shownEnd = true;
  const m = ui.modal(`<h2>${title}</h2>${extra}<div class="pause-stats">${statsHTML(F.ac)}</div>
    <div class="col-buttons"><button class="primary big" data-a="restart">Fly again</button><button data-a="watch">Keep watching</button><button data-a="hangar">Back to hangar (repair)</button></div>`, 'sticky');
  m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.a; m.close();
    if (a === 'restart') { const c = F.cfg; endFlight(); startFlight(c); }
    if (a === 'hangar') endFlight();
  }));
}

// ---------- flight event handling ----------
const _v = new THREE.Vector3();
function handleEvents(f, dt) {
  const { ac, effects, world } = f;
  for (const e of ac.events) {
    switch (e.type) {
      case 'msg': hud.toast(e.text, e.bad ? 'bad' : ''); if (e.bad) audio.play('warn'); break;
      case 'impact': {
        const p = Math.min(2, e.speed / 18);
        if (e.surf === 'water') effects.splash(e.pos, e.speed);
        else { effects.sparks(e.pos, ac.v, 12); effects.dust(e.pos, ac.v, e.surf, 4); }
        if (!f.lastImpact || f.t - f.lastImpact > 0.15) { audio.play(e.surf === 'water' ? 'splash' : 'impact', p, e.pos); f.lastImpact = f.t; }
        rig.shake(p); if (p > 0.6) post.shock(p * 0.6);
        break;
      }
      case 'touch': if (e.water || e.float) { effects.splash(e.pos, e.speed * 3); audio.play('splash', 0.4, e.pos); } else { effects.tireSmoke(e.pos, e.speed); audio.play('chirp', Math.min(1.5, e.speed / 2)); } break;
      case 'landing': {
        const vs = e.vs; const ok = vs < 1.0 ? 'Butter! ' : vs < 2 ? 'Nice landing! ' : vs < 3.2 ? 'Firm landing. ' : 'Ouch! ';
        hud.toast(`${ok}${vs.toFixed(1)} m/s`, vs < 2 ? 'good' : ''); break;
      }
      case 'scrape': if (e.surf !== 'water') { effects.sparks(e.pos, ac.v, 4); effects.dust(e.pos, ac.v, e.surf, 2); } f.scrapeT = 0.2; f.scrape = e.speed; break;
      case 'spray': effects.spray(e.pos, e.speed); break;
      case 'dust': effects.dust(e.pos, ac.v, e.surf, 1); break;
      case 'gear': audio.play('gear'); hud.toast(e.down ? 'Gear down' : 'Gear up'); break;
      case 'rocket': audio.play('rocket'); break;
      case 'debris': {
        f.debris.push(e.debris); f.scene.add(e.debris.group);
        audio.play('crack', 1, e.pos); if (e.names.some((n) => /Canopy|Cockpit|Nose/.test(n))) audio.play('glass', 1, e.pos); rig.shake(1.2);
        effects.sparks(e.pos, ac.v, 25);
        effects.puff(e.pos, { x: 0, y: 1, z: 0 }, { color: [0.3, 0.3, 0.3], s0: 2, s1: 10, life: 3 });
        if (e.speed > 12 && f.t - f.lastSlowmo > 8) { f.slowmo = 2.2; f.lastSlowmo = f.t; }
        if (f.debris.length > 40) { const old = f.debris.shift(); f.scene.remove(old.group); }
        break;
      }
      case 'wreck': {
        post.shock(1.2);
        if (e.speed > 25 || ac.parts.some((p) => p.engine)) { effects.explosion(e.pos, Math.min(2, 0.6 + e.speed / 50)); audio.play('explosion', 1, e.pos); }
        else audio.play('impact', 2, e.pos);
        rig.shake(2); f.slowmo = 2.5; f.lastSlowmo = f.t;
        hud.center('CRASH!', 2500);
        break;
      }
    }
  }
}

function stepFlight(dtReal) {
  const f = F; if (!f || f.paused) return;
  const { ac, world, effects, traffic } = f;
  f.t = (f.t || 0) + dtReal;
  if (f.slowmo > 0) { f.slowmo -= dtReal; f.timeScale = 0.3; } else f.timeScale = Math.min(1, f.timeScale + dtReal * 2);
  const dt = Math.min(dtReal, 1 / 20) * f.timeScale;
  const c = controls.update(dtReal);
  ac.setControls({ pitch: c.pitch, roll: c.roll, yaw: c.yaw, throttle: c.throttle });
  ac.brake = c.brake || (c.throttle < 0.03 && ac.onGround && ac.v.length() < 3 ? 1 : 0); // parking brake
  ac.step(dt, f.env);
  // trees
  if (!ac.dead && ac.x.y - Math.max(world.heightAt(ac.x.x, ac.x.z), 0) < 30) {
    for (const p of ac.parts) {
      if (!p.alive) continue;
      const wp = ac.worldPoint(p.center, _v);
      const t = world.treeHit(wp);
      if (t && ac.v.length() > 5) {
        effects.leaves(wp); audio.play('impact', 0.5, wp.clone()); rig.shake(0.5);
        ac.damage(p, ac.v.length() * 8 / ac.R.crashMult, wp);
        ac.v.multiplyScalar(0.92);
        t[3] = 0; // flatten the tree so we don't hit it forever
      }
    }
  }
  // bird strikes
  if (!ac.dead) {
    const hits = traffic.birdStrikes(ac.x, ac.radius * 0.7);
    for (const h of hits) {
      effects.feathers(h); audio.play('bird', 1, h);
      let best = null, bd = 1e9; for (const p of ac.parts) { if (!p.alive) continue; const d = ac.worldPoint(p.center).distanceTo(h); if (d < bd) { bd = d; best = p; } }
      if (best) { ac.damage(best, best.engine ? best.hp * 0.35 : best.hp * 0.08, h); hud.toast(best.engine ? `Bird strike! ${best.name} damaged` : 'Bird strike!', 'bad'); }
    }
  }
  handleEvents(f, dt);
  f.mission?.update(dt, ac, f.events);
  ac.events.length = 0;
  for (const e of f.events.splice(0)) {
    if (e.type === 'ring') { audio.play('ring'); hud.center(`${e.n} / ${e.total}`, 900); }
    if (e.type === 'raceDone') { audio.play('win'); const best = LS.get('best', {}); const key = `${f.cfg.location}:${hangar.design.name}`; const pb = !best[key] || e.time < best[key]; if (pb) { best[key] = e.time; LS.set('best', best); } setTimeout(() => showEnd(`Course complete: ${e.time.toFixed(1)} s`, pb ? '<p class="good">New personal best!</p>' : `<p>Best: ${best[key].toFixed(1)} s</p>`), 1500); }
    if (e.type === 'landingDone') { audio.play(e.score > 500 ? 'win' : 'warn'); const stars = '★'.repeat(Math.round(e.score / 200)) + '☆'.repeat(5 - Math.round(e.score / 200)); setTimeout(() => showEnd(e.crashed ? 'Crashed on landing' : `Landing score: ${e.score}`, e.crashed ? '' : `<p class="stars">${stars}</p><p>Sink rate ${e.vs.toFixed(1)} m/s · ${Math.abs(e.cl).toFixed(1)} m off centreline · ${Math.round(Math.abs(e.aim))} m ${e.aim > 0 ? 'short of' : 'past'} the aim point${e.onRwy ? '' : ' · missed the runway!'}</p>`), 800); }
    if (e.type === 'thunder') setTimeout(() => audio.play('thunder', e.power), e.delay * 1000);
  }
  // debris
  const burnPts = [];
  for (const d of f.debris) {
    d.step(dt, f.env);
    if (d.burning > 0 && d.age < 40) burnPts.push([d.x, d.burning]);
    else if (d.smoking > 0 && d.age < 6 && Math.random() < 0.3) effects.engineSmoke(d.x, d.v, 0.25);
  }
  for (const [p, b] of burnPts) effects.burn(p, b);
  // engine smoke for damaged engines, airshow smoke, exhaust
  if (!ac.dead) for (const p of ac.parts) {
    if (!p.alive) continue;
    if (p.engine && p.dmg > p.hp * 0.3 && Math.random() < 0.6) effects.engineSmoke(ac.worldPoint(p.engine.pos), ac.v, p.dmg > p.hp * 0.6 ? 0.08 : 0.35);
    if (p.engine && p.dmg > p.hp * 0.7 && Math.random() < 0.5) effects.flame(ac.worldPoint(p.engine.pos), ac.v, 0.6);
    if (p.engine?.burning) for (let k = 0; k < 2; k++) effects.engineSmoke(ac.worldPoint(p.center.clone().add(p.engine.dir.clone().multiplyScalar(-3.5))), ac.v, 0.85);
    if (p.smoke && ac.smokeOn) effects.trail(ac.worldPoint(p.smoke.pos), p.smoke.color, 1);
  }
  // wingtip contrails / vortices when pulling hard in humid air
  if (!ac.dead && Math.abs(ac.g) > 4 && ac.airspeed > 60) for (const p of ac.parts) if (p.alive && p.d.wing && p.d.cat === 'wing') { const tip = p.surfaces.at(-1); if (tip && Math.random() < 0.5) effects.puff(ac.worldPoint(tip.pos), ac.v.clone().multiplyScalar(0.8), { color: [1, 1, 1], s0: 0.3, s1: 1.5, life: 0.5, a: 0.4, drag: 2 }); }
  traffic.update(dt, effects);
  const wind = world.windBase.clone().add(world.gust);
  effects.update(dt, wind);
  // camera
  let focus = null;
  if (ac.dead || ac.wrecked) { const biggest = ac.dead ? f.debris.reduce((a, d) => (!a || d.mass > a.mass ? d : a), null) : null; focus = biggest ? biggest.x : null; if (rig.mode === 'cockpit') rig.set('orbit'); }
  rig.update(dtReal, ac, world, focus);
  ac.setCockpitView(rig.mode === 'cockpit' && !focus);
  world.update(dtReal, flightCam, rig.vel, f.events);
  effects.setLighting(world, flightCam);
  // end of flight detection
  const stopped = ac.v.length() < 0.6;
  if (!f.shownEnd && f.mission?.done !== true) {
    if (ac.dead || (ac.wrecked && stopped)) { f.endT = (f.endT ?? 0) + dtReal; if (f.endT > 4) showEnd(ac.dead ? 'Kaboom! The plane is in pieces.' : 'Crashed!'); }
    else if (ac.onGround && stopped && ac.stats.partsLost > 0 && ac.stats.airTime > 3) { f.endT = (f.endT ?? 0) + dtReal; if (f.endT > 4) showEnd('Crash landing!'); }
    else if (ac.x.y < world.waterLevel - 2) { f.endT = (f.endT ?? 0) + dtReal; if (f.endT > 3) showEnd('Splashdown! Glub glub.'); }
    else f.endT = null;
  }
  // audio
  const engines = {};
  if (!ac.dead) for (const p of ac.parts) {
    if (!p.alive || !p.engine) continue; const e = p.engine;
    const k = e.sound; if (!engines[k]) engines[k] = { sound: k, rpm: 0, spoolT: 0, count: 0, blades: { e_turboprop: 4, e_radial: 3, e_electric: 6 }[p.p.id] || 2, ab: false, burning: false, pos: new THREE.Vector3() };
    const a = engines[k]; a.count++; a.rpm = Math.max(a.rpm, e.rpm || 0); a.spoolT = Math.max(a.spoolT, e.spoolT || 0); a.ab = a.ab || e.abOn; a.burning = a.burning || e.burning;
    a.pos.add(ac.worldPoint(e.pos));
  }
  for (const k in engines) engines[k].pos.divideScalar(engines[k].count);
  const cockpit = rig.mode === 'cockpit' && !ac.dead;
  let doppler = 1;
  if (!cockpit) {
    const toCam = flightCam.position.clone().sub(ac.x).normalize();
    doppler = clamp((343 - rig.vel.dot(toCam)) / (343 - ac.v.dot(toCam)), 0.5, 2);
  }
  f.scrapeT = (f.scrapeT || 0) - dtReal;
  const gs = ac.v.length();
  const surf = world.groundAt(ac.x.x, ac.x.z).type;
  const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(flightCam.quaternion), camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(flightCam.quaternion);
  const agl = flightCam.position.y - Math.max(world.heightAt(flightCam.position.x, flightCam.position.z), world.waterLevel);
  audio.update({ engines: Object.values(engines), airspeed: ac.dead ? 0 : (ac.airspeed || 0), buffet: ac.dead || ac.onGround ? 0 : Math.max(0, ac.alpha - 0.22) + (ac.stalled ? 0.15 : 0),
    onGround: ac.onGround && ac.parts.some((p) => p.alive && p.gear?.wheels.some((w) => w.contact)), groundSpeed: gs, surface: surf,
    scrape: f.scrapeT > 0 ? f.scrape : 0, stall: ac.stalled && !ac.dead, cockpit, doppler, rain: world.rain.visible ? world.W.rain : 0,
    listener: { pos: flightCam.position, fwd: camFwd, up: camUp },
    amb: { loc: world.loc.id, night: world.night, day: !world.night && world.W.rain === 0, agl, overWater: world.groundAt(flightCam.position.x, flightCam.position.z).type === 'water' } });
  hud.update(ac, world, f.mission, flightCam);
  if (f.debug) $('#debug').textContent = `α ${(ac.alpha * 57.3).toFixed(1)}° g ${ac.g.toFixed(2)} V ${ac.airspeed?.toFixed(1)} m=${Math.round(ac.mass)} com=${ac.com.toArray().map((v) => v.toFixed(2))} w=${ac.w.toArray().map((v) => v.toFixed(2))}`;
  $('#debug').style.display = f.debug ? '' : 'none';
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (state === 'hangar') { hangar.update(dt); post.look({ bloom: 0.3, threshold: 3.0, vignette: 0.35, warmth: 0.3 }); post.render(hangar.scene, hangar.camera, dt); }
  else if (state === 'flight' && F) {
    stepFlight(dt);
    if (F) {
      // sun flare + per-time-of-day grade
      const w = F.world, vis = w.sunVisibility(flightCam);
      F.sunVis = (F.sunVis ?? 0) + (vis - (F.sunVis ?? 0)) * Math.min(1, dt * 6);
      const sp = flightCam.position.clone().addScaledVector(w.sunDir, 1000).project(flightCam);
      const onScreen = sp.z < 1 && Math.abs(sp.x) < 1.4 && Math.abs(sp.y) < 1.4;
      post.flare(new THREE.Vector2(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5), onScreen ? F.sunVis * (1 - w.W.dark) : 0, w.sun.color, flightCam.aspect);
      const golden = Math.max(0, 1 - Math.abs(w.sunElev - 0.08) / 0.3);
      post.look({ bloom: w.night ? 0.65 : 0.5, threshold: w.night ? 2.5 : 4.0, warmth: golden * 1.5 - w.W.dark * 0.5, saturation: 1.1 + golden * 0.1 - w.W.dark * 0.25, vignette: 0.3 });
      post.render(F.scene, flightCam, dt);
    }
  }
}
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  post.setSize(w, h, renderer.getPixelRatio());
  hangar.resize(w, h); flightCam.aspect = w / h; flightCam.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'flight' && F && !F.paused) togglePause(true); });

// ---------- boot ----------
async function boot() {
  onResize();
  const saved = LS.get('current', null);
  hangar.load(saved && saved.parts?.length ? saved : presets[0]);
  try { thumbs = makeThumbnails(); } catch (e) { console.warn('thumbnails failed', e); }
  buildPalette(); renderInspector();
  hangar.activate(true);
  requestAnimationFrame(frame);
  $('#splash').classList.add('hide');
  setTimeout(() => $('#splash').remove(), 900);
  document.addEventListener('pointerdown', () => { audio.init(); if (state === 'hangar') audio.music(true); }, { once: true });
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !location.hostname.match(/^(localhost|127\.)/)) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__sky = { THREE, Aircraft, REALISM, analyze, audio, hangar, get F() { return F; }, startFlight, endFlight, presets, settings, flightCfg, controls, rig };
}
boot();
