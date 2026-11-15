import * as THREE from 'three';
import { PARTS, CATEGORIES, PAINTS } from './parts.js';
import { makePresets, encodeDesign, decodeDesign, cloneDesign, analyze, sizeSliders, sizeValue, thrustScale, partPower, partBurn, POWER_RANGE, BURN_RANGE } from './design.js';
import { Hangar, makeThumbnails } from './hangar.js';
import { Aircraft, REALISM } from './aircraft.js';
import { World, LOCATIONS, WEATHER } from './world.js';
import { Traffic, buildStatic, mergeByMaterial } from './traffic.js';
import { Effects } from './effects.js';
import { SonicFX } from './sonic.js';
import { Audio, MIX_DEFAULTS, OLD_MIX_DEFAULTS } from './audio.js';
import { WorldSound } from './worldsound.js';
import { Callouts } from './callouts.js';
import { Controls } from './controls.js';
import { HUD } from './hud.js';
import { CameraRig } from './cameras.js';
import { MODES, RingRace, LandingChallenge } from './missions.js';
import { clamp, smoothstep } from './noise.js';
import { installFog } from './shaders.js';
import { Post } from './post.js';
import { VERSION, COMMIT, BUILT } from './version.js';
import { CHANGELOG, changesSince, newer } from './changelog.js';
import { Net } from './net.js';
import { Analytics } from './analytics.js';
import { loadReal } from './realworld.js';
installFog();

// ---------- persistence ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('skywright.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('skywright.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
// Must be read before anything below writes to storage (the settings migration does, for every new player).
const returningPlayer = LS.get('settings', null) !== null || LS.get('current', null) !== null;
const settings = Object.assign({ callouts: true, quality: 'auto', units: 'imperial', invert: false, controlMode: 'stick', mix: null, touch: 'auto', showFps: false, analytics: true }, LS.get('settings', {}));
const analytics = new Analytics({ version: VERSION, commit: COMMIT, enabled: settings.analytics !== false });
if ((settings.v || 1) < 2) { settings.quality = 'auto'; settings.v = 2; LS.set('settings', settings); } // move everyone onto adaptive quality once
// 'auto' = medium features on tablets / high on desktops (Ultra is opt-in for now) (set once the renderer
// exists), plus resolution and effects that adapt to the frame rate
let autoTier = isTouch ? 'medium' : 'high';
const qualityTier = () => (settings.quality === 'auto' ? autoTier : settings.quality);
const isHigh = (t) => t === 'high' || t === 'ultra'; // Ultra keeps everything High has
const perf = { scale: 1, level: 0, ema: 16.7, slowT: 0, fastT: 0, lastChange: 0, fps: 60 };
const flightCfg = Object.assign({ location: 'alpine', time: 10, weather: 'clear', realism: 'pilot', mode: 'free', start: 'runway', online: true }, LS.get('flight', {}));
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- renderer ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true; // retracting gear is clipped at the skin so it tucks into its bay
// A dedicated desktop GPU (or Apple silicon) gets Ultra on Auto; integrated / software / mobile GPUs stay on High.
const gpuStr = (() => { try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); } catch { return ''; } })();
if (!isTouch && /nvidia|geforce|rtx|radeon|apple m\d|arc\(tm\)|intel.*arc/i.test(gpuStr) && !/swiftshader|llvmpipe|software|mali|adreno|powervr/i.test(gpuStr)) autoTier = 'high'; // Ultra stays opt-in (Settings > Graphics) until frame pacing is verified on real laptops (#63)
// Ultra also supersamples a little on 1x screens (1.5x internal resolution) and renders at 2x on high-DPI ones
const pixelRatio = () => { const t = qualityTier(), dpr = window.devicePixelRatio || 1; return Math.max(0.5, (t === 'ultra' ? Math.min(2, Math.max(1.5, dpr)) : Math.min(dpr, { low: 1, medium: 1.25, high: 2 }[t])) * (settings.quality === 'auto' ? perf.scale : 1)); };
renderer.setPixelRatio(pixelRatio());
const post = new Post(renderer);
post.enabled = qualityTier() !== 'low';
post.setSamples(isHigh(qualityTier()) ? 4 : 0);
post.setUltra(qualityTier() === 'ultra');
renderer.shadowMap.type = isHigh(qualityTier()) ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

// mixer: the old single linear 'volume' setting is dropped (its scale meant something else); start from the new defaults
if (!settings.mix || Object.keys(OLD_MIX_DEFAULTS).every((k) => settings.mix[k] === OLD_MIX_DEFAULTS[k])) settings.mix = { ...MIX_DEFAULTS }; delete settings.volume;
const audio = new Audio(); audio.setMix(settings.mix); audio.callouts = settings.callouts;
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
let sizeDrag = false; // a slider drag or button hold is in progress: don't rebuild the panel under the finger
// Size sliders: an absolute slider for coarse changes and +/- buttons (tap = one fine step, hold = repeat).
function ctlRows(p) {
  const x = (v) => `${v.toFixed(2)}×`;
  return [
    ['Size', sizeSliders(p.id).map(([a, name, lo, hi]) => ({ k: 's' + a, name, v: sizeValue(p, a), lo, hi, step: 0.01, fine: 0.01, fmt: x }))],
    ['Engine', engineRows(p)],
  ].filter(([, rows]) => rows.length);
}
// Power: % of stock thrust, shown with the resulting kN. Rockets also get a burn time.
function engineRows(p) {
  const e = PARTS[p.id].engine; if (!e) return [];
  const kN = (v) => `${Math.round(v * 100)}% · ${Math.round((e.ab || e.thrust) * thrustScale(p) * v / 1000)} kN`;
  return [
    { k: 'tpower', name: 'Power', v: partPower(p), lo: POWER_RANGE[0], hi: POWER_RANGE[1], step: 0.05, fine: 0.05, fmt: kN, stock: 1 },
    ...(e.type === 'rocket' ? [{ k: 'tburn', name: 'Burn time', v: partBurn(p), lo: BURN_RANGE[0], hi: BURN_RANGE[1], step: 1, fine: 1, fmt: (v) => `${Math.round(v)} s`, stock: e.burn }] : []),
  ];
}
function applyCtl(k, v, undo) {
  if (k[0] === 't') { const p = hangar.design.parts[hangar.sel], e = PARTS[p.id].engine; hangar.setTune(k.slice(1), v, k === 'tburn' ? e.burn : 1, undo); }
  else hangar.resizePart(k.slice(1), v, undo);
}
// Press-and-hold repeat for a button: tick(first, held, ticks) once on press, then every 60 ms after a short pause.
// held = seconds since the repeat started and ticks = 60 ms periods since the last call, both from the clock,
// so a hold moves at the same speed even when a busy tablet fires the timer late.
function holdRepeat(b, tick, done) {
  let timer = 0, t0 = 0, last = 0;
  const stop = () => { if (!timer) return; clearTimeout(timer); clearInterval(timer); timer = 0; done(); };
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); b.setPointerCapture?.(ev.pointerId);
    tick(true, 0, 1);
    timer = setTimeout(() => {
      t0 = last = performance.now();
      timer = setInterval(() => { const now = performance.now(); tick(false, (now - t0) / 1000, Math.max(1, (now - last) / 60)); last = now; }, 60);
    }, 400);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, stop);
}
// Move and Rotate pads: big arrow buttons laid out the way the part will go, so "Up" is up and "Left" is left.
// Tap = 1 cm / 1°, hold = repeat and speed up (to 10 cm / 6° per step), so no slider is needed.
const PAD_MOVE = [
  ['m1', 1, '▲', 'Up', 'u'], ['m0', -1, '◀', 'Left', 'l'], ['m0', 1, '▶', 'Right', 'r'], ['m1', -1, '▼', 'Down', 'd'],
  ['m2', -1, '⇑', 'Front', 'f'], ['m2', 1, '⇓', 'Back', 'b'],
];
const PAD_ROT = [
  ['r2', 1, '⟲', 'Roll left', 'tl'], ['r0', 1, '⤴', 'Nose up', 'u'], ['r2', -1, '⟳', 'Roll right', 'tr'],
  ['r1', 1, '↶', 'Turn left', 'l'], ['r1', -1, '↷', 'Turn right', 'r'], ['r0', -1, '⤵', 'Nose down', 'd'],
];
function padHTML(kind, btns, centre = '') {
  return `<div class="pad pad-${kind}">${btns.map(([k, dir, icon, name, at]) =>
    `<button class="at-${at}" data-nudge="${k},${dir}" aria-label="${name}"><i>${icon}</i><small>${name}</small></button>`).join('')}${centre}</div>`;
}
function padReadout(p) {
  const e = hangar.euler(), m = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  return { m: `Side ${m(p.pos[0])} · Up ${m(p.pos[1])} · Back ${m(p.pos[2])} m`, r: `Nose ${Math.round(e[0])}° · Turn ${Math.round(e[1])}° · Roll ${Math.round(e[2])}°` };
}
function wirePads(sp, sel) {
  const L = Math.max(4, Math.ceil(Math.max(...hangar.design.parts.flatMap((q) => q.pos.map(Math.abs)))) + 2);
  let raf = 0, pending = null;
  const show = () => { const r = padReadout(hangar.design.parts[hangar.sel]); sp.querySelector('[data-ro=m]').textContent = r.m; sp.querySelector('[data-ro=r]').textContent = r.r; };
  const apply = (fn, first) => {
    if (first) { fn(true); show(); return; }
    pending = fn;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; pending(false); show(); }); // at most one rebuild per frame
  };
  sp.querySelectorAll('[data-nudge]').forEach((b) => {
    const [k, d] = b.dataset.nudge.split(','), dir = +d, axis = +k[1];
    let v = 0, base = null;
    holdRepeat(b, (first, held, ticks) => {
      // 1 step per tick at first, ramping over ~2 s to 10 cm or 6° per tick (about 1.7 m/s or 100°/s)
      const per = Math.min(k[0] === 'm' ? 10 : 6, 1 + (held / 0.06) ** 2 / 40) * ticks;
      if (first) { sizeDrag = true; audio.play(k[0] === 'm' ? 'move' : 'rotate'); const p = hangar.design.parts[hangar.sel]; v = k[0] === 'm' ? p.pos[axis] : 0; base = [...p.quat]; } else audio.tick(k[0] === 'm' ? 'slide' : 'ratchet');
      if (k[0] === 'm') { v = clamp(v + dir * 0.01 * per, -L, L); const t = Math.round(v * 100) / 100; apply((u) => hangar.setPos(axis, t, u), first); }
      else { v += dir * per; const t = Math.round(v); apply((u) => hangar.rotateFrom(base, axis, t, u), first); }
    }, () => { if (raf) { cancelAnimationFrame(raf); raf = 0; pending(false); } pending = null; sizeDrag = false; renderInspector(); });
  });
  sp.querySelector('[data-reset]').addEventListener('click', () => { audio.play('rotate'); hangar.resetRotation(); });
}
function wireCtls(sp, sel) {
  const rows = Object.fromEntries(ctlRows(sel).flatMap(([, r]) => r).map((c) => [c.k, c]));
  let raf = 0, pending = null;
  const show = (k, v) => { sp.querySelector(`[data-cv="${k}"]`).textContent = rows[k].fmt(v); };
  const begin = () => {};
  const step = (k, v, first) => {
    if (first) { applyCtl(k, v, true); return; }
    pending = [k, v];
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyCtl(...pending, false); }); // at most one rebuild per frame
  };
  const end = (k, v) => { cancelAnimationFrame(raf); raf = 0; if (sizeDrag) { applyCtl(k, v, false); sizeDrag = false; renderInspector(); } };
  sp.querySelectorAll('[data-ctl]').forEach((r) => {
    const k = r.dataset.ctl;
    r.addEventListener('input', () => { audio.tick('slide', (r.value - r.min) / (r.max - r.min)); const first = !sizeDrag; if (first) begin(); sizeDrag = true; show(k, +r.value); step(k, +r.value, first); });
    r.addEventListener('change', () => end(k, +r.value));
  });
  sp.querySelectorAll('[data-fine]').forEach((b) => {
    const [k, dir] = b.dataset.fine.split(','), c = rows[k], slider = sp.querySelector(`[data-ctl="${k}"]`);
    let timer = 0, v = c.v;
    const tick = (first) => {
      v = Math.min(c.hi, Math.max(c.lo, +(v + dir * c.fine).toFixed(3)));
      slider.value = v; show(k, v); step(k, v, first); audio.tick('slide', (v - c.lo) / (c.hi - c.lo));
    };
    const stop = () => { if (!timer) return; clearTimeout(timer); clearInterval(timer); timer = 0; end(k, v); };
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); b.setPointerCapture?.(ev.pointerId);
      v = +slider.value; begin(); sizeDrag = true; tick(true);
      timer = setTimeout(() => { timer = setInterval(() => tick(false), 60); }, 400); // hold to repeat
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, stop);
  });
}
function renderInspector() {
  const d = hangar.design, s = hangar.stats || analyze(d);
  $('#plane-name').value = d.name || '';
  const sel = hangar.sel >= 0 ? d.parts[hangar.sel] : null;
  const sp = $('#sel-panel');
  if (sel && sizeDrag) { /* keep the slider being dragged alive: don't rebuild the panel mid-drag */ }
  else if (sel) {
    const def = PARTS[sel.id];
    sp.hidden = false;
    sp.innerHTML = `<h3>${def.name}${hangar.partner(hangar.sel) >= 0 && hangar.symmetry ? ' <span class="pill">×2 mirrored</span>' : ''}</h3>
      <p class="desc">${def.desc}</p>
      <label class="lbl grp">Move</label>
      ${padHTML('move', PAD_MOVE, '<span class="pad-plane" aria-hidden="true">✈</span>')}
      <p class="pad-ro" data-ro="m">${padReadout(sel).m}</p>
      <label class="lbl grp">Turn</label>
      ${padHTML('rot', PAD_ROT, '<button class="at-c" data-reset aria-label="Straighten"><i>⊙</i><small>Straight</small></button>')}
      <p class="pad-ro" data-ro="r">${padReadout(sel).r}</p>
      ${ctlRows(sel).map(([group, rows]) => `<label class="lbl grp">${group}</label>` + rows.map((c) => `
        <div class="ctl"><label class="lbl">${c.name} <b data-cv="${c.k}">${c.fmt(c.v)}</b></label>
          <div class="ctl-row"><button data-fine="${c.k},-1" aria-label="${c.name} down">−</button>
          <input type="range" data-ctl="${c.k}" min="${c.lo}" max="${c.hi}" step="${c.step}" value="${c.v}">
          <button data-fine="${c.k},1" aria-label="${c.name} up">+</button></div></div>`).join('')).join('')}
      <button class="wide" data-flip>⇄ Flip</button>
      <label class="lbl">Paint</label>
      <div class="swatches">${PAINTS.map((c) => `<button style="background:#${c.toString(16).padStart(6, '0')}" data-c="${c}" class="${c === sel.color ? 'on' : ''}"></button>`).join('')}</div>
      <button class="danger wide" data-del>🗑 Remove part${hangar.sel === 0 ? ' (and everything)' : ''}</button>`;
    sp.querySelector('[data-flip]').addEventListener('click', () => { hangar.flip(); audio.play('flip'); });
    sp.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => hangar.paint(+b.dataset.c)));
    sp.querySelector('[data-del]').addEventListener('click', () => hangar.deleteSel());
    wireCtls(sp, sel); wirePads(sp, sel);
  } else sp.hidden = true;
  const marginPct = clamp(s.margin, -0.5, 1);
  const balPos = clamp(50 + marginPct * 60, 4, 96);
  $('#stats').innerHTML = `
    <h3>${d.parts.length ? 'Flight check' : 'Empty hangar'}</h3>
    <div class="stat-grid">
      <div><label>Mass</label><b>${fmt(s.mass)} kg</b></div>
      <div><label>Parts</label><b>${d.parts.length}</b></div>
      ${s.car && !s.heli && s.wingArea < 0.5 ? `<div><label>Power/Weight</label><b>${fmt(s.grip, 2)}</b></div>
      <div><label>Wheels</label><b>${s.wheels} (${s.driveWheels} driven)</b></div>` : s.heli ? `<div><label>Lift/Weight</label><b>${fmt(s.hover, 2)}</b></div>
      <div><label>Rotors</label><b>${s.rotors} + ${s.tailRotors} tail</b></div>` : `<div><label>Thrust/Weight</label><b>${fmt(s.tw, 2)}</b></div>
      <div><label>Engines</label><b>${s.engines}</b></div>
      <div><label>Wing area</label><b>${fmt(s.wingArea, 1)} m²</b></div>
      <div><label>Stall speed</label><b>${Number.isFinite(s.stall) ? fmt(s.stall * (settings.units === 'metric' ? 3.6 : 1.944)) + (settings.units === 'metric' ? ' km/h' : ' kt') : '—'}</b></div>`}
    </div>
    ${s.heli || (s.car && s.wingArea < 0.5) ? '' : `<label class="lbl">Balance <small>(<span style="color:#ffd400">●</span> mass &nbsp;<span style="color:#3ab0ff">●</span> lift)</small></label>
    <div class="balance"><div class="zone"></div><div class="needle" style="left:${balPos}%"></div><span class="l">tail-heavy</span><span class="r">nose-heavy</span></div>`}
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
const undo = () => { if (hangar.undoStack.length) audio.play('undo'); hangar.undo(); }, redo = () => { if (hangar.redoStack.length) audio.play('redo'); hangar.redo(); };
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-sym').addEventListener('click', () => { hangar.symmetry = !hangar.symmetry; renderInspector(); });
$('#btn-bal').addEventListener('click', () => { hangar.showBalance = !hangar.showBalance; hangar.rebuild(); });
$('#btn-frame').addEventListener('click', () => hangar.frame());
$('#placing-bar button').addEventListener('click', () => { hangar.cancelPlacing(); buildPalette(); });
$('#btn-save').addEventListener('click', () => { audio.init(); saveCurrent(); });
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
});

// For analytics: preset planes by name; anything built or changed by the player is just 'custom' (their names stay on the device)
const planeLabel = (d) => presets.find((p) => p.name === d.name && p.parts.length === d.parts.length)?.name || 'custom';
const planeKind = (st) => (st.heli ? 'helicopter' : st.car && st.wingArea < 0.5 ? 'car' : st.floats ? 'seaplane' : 'plane');
// Save the plane on the hangar floor into "My planes" under its name (same name = overwrite that save).
function saveCurrent() {
  if (!hangar.design.parts.length) { ui.hint('Build something first!'); return; }
  const mine = LS.get('designs', []), name = (hangar.design.name || '').trim() || 'My Plane';
  hangar.design.name = name; $('#plane-name').value = name;
  const i = mine.findIndex((d) => d.name === name), c = cloneDesign(hangar.design);
  if (i >= 0) mine[i] = c; else mine.push(c);
  LS.set('designs', mine); audio.play('save');
  analytics.capture('plane_saved', { parts: c.parts.length, overwrite: i >= 0, saved_planes: mine.length });
  ui.hint(`Saved “${name}” — find it in Planes`);
}
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
  el.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => { const [k, i] = b.dataset.load.split(':'); hangar.load(k === 'preset' ? presets[+i] : mine[+i]); audio.play('load'); m.close(); analytics.capture('plane_loaded', { source: k, plane: k === 'preset' ? presets[+i].name : 'custom' }); }));
  el.querySelectorAll('[data-delp]').forEach((b) => b.addEventListener('click', () => { mine.splice(+b.dataset.delp, 1); LS.set('designs', mine); m.close(); planesModal(); }));
  el.querySelector('[data-new]').addEventListener('click', () => { hangar.load({ name: 'My Plane', parts: [] }); analytics.capture('plane_loaded', { source: 'blank' }); activeCat = 'fuselage'; buildPalette(); m.close(); ui.hint('Pick a body to start'); });
  el.querySelector('[data-save]').addEventListener('click', () => { saveCurrent(); m.close(); });
  el.querySelector('#copy-code').addEventListener('click', () => { const t = el.querySelector('#share-code'); t.select(); navigator.clipboard?.writeText(t.value).then(() => ui.hint('Copied!'), () => document.execCommand('copy')); });
  el.querySelector('#import-btn').addEventListener('click', () => { try { hangar.load(decodeDesign(el.querySelector('#import-code').value)); audio.play('load'); m.close(); ui.hint('Imported!'); analytics.capture('plane_loaded', { source: 'import' }); } catch (e) { ui.hint('That code didn’t work'); } });
}

function timeLabel(t) { const h = Math.floor(t), mm = Math.round((t - h) * 60); const lab = t < 5 || t > 20.5 ? 'Night' : t < 7.5 ? 'Dawn' : t < 11 ? 'Morning' : t < 15 ? 'Midday' : t < 18 ? 'Afternoon' : 'Sunset'; return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${lab}`; }
function flightModal() {
  const s = analyze(hangar.design);
  const m = ui.modal(`
    <h2>Ready for take-off: ${hangar.design.name}</h2>
    <label class="lbl">Location</label>
    <div class="choice-row">${Object.values(LOCATIONS).map((l) => `<button class="loc-card ${l.id}${flightCfg.location === l.id ? ' on' : ''}" data-loc="${l.id}"><span class="loc-online" data-online="${l.id}"></span><b>${l.name}</b><small>${l.desc}</small></button>`).join('')}</div>
    <div class="mp-online">
      <div class="mp-head"><b>Fly together</b><div class="chips"><button data-on="1" class="${flightCfg.online !== false ? 'on' : ''}">With others</button><button data-on="0" class="${flightCfg.online === false ? 'on' : ''}">Alone</button></div>
        <label class="mp-name">Your name <input id="mp-name" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(net.name)}"></label></div>
      <div id="mp-list"></div>
    </div>
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
  // ----- online sessions: everyone at a location flies together unless they pick "Alone" -----
  const list = el.querySelector('#mp-list');
  const renderOnline = () => {
    if (!list.isConnected) return;
    const on = flightCfg.online !== false, loc = flightCfg.location;
    el.querySelector('.mp-online').classList.toggle('off', !on);
    for (const b of el.querySelectorAll('[data-online]')) {
      const n = net.sessionsAt(b.dataset.online).reduce((a, r) => a + Math.max(0, r.count), 0);
      b.textContent = on && n ? `👥 ${n} flying` : ''; b.hidden = !(on && n);
    }
    if (!on) { list.innerHTML = '<p class="mp-note">You’ll fly on your own. Nobody else will see your plane.</p>'; return; }
    const rows = net.sessionsAt(loc).filter((r) => r.count > 0);
    const target = rows.find((r) => r.count < r.max);
    const sess = rows.map((r) => `<div class="mp-row${r === target ? ' target' : ''}"><div><b>Session ${r.n}</b> · ${r.count} pilot${r.count === 1 ? '' : 's'}: ${r.names.slice(0, 4).map(esc).join(', ')}${r.names.length > 4 ? '…' : ''}
        <small>${esc(WEATHER[r.cfg.weather]?.name || '')}${Number.isFinite(r.cfg.time) ? ` · ${timeLabel(r.cfg.time)}` : ''}</small></div>
        <button data-join="${r.n}" ${r.count >= r.max ? 'disabled' : ''}>${r.count >= r.max ? 'Full' : 'Join'}</button></div>`).join('');
    const status = net.scanning && !rows.length ? 'Looking for other pilots…'
      : net.scanError ? 'Couldn’t check who’s online. FLY will try again, or fly alone if there’s no internet.'
      : target ? `FLY joins <b>Session ${target.n}</b> (it keeps its own time of day and weather).`
      : `Nobody’s flying at ${esc(LOCATIONS[loc].name)} yet. FLY starts a session, and anyone who flies here joins you.`;
    list.innerHTML = `${sess}<p class="mp-note">${status}</p>${rows.length ? `<button class="mp-new" data-newsess>+ Start a new session with my time and weather</button>` : ''}`;
    list.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => fly({ join: +b.dataset.join })));
    list.querySelector('[data-newsess]')?.addEventListener('click', () => fly({ host: true }));
  };
  const scan = () => { if (flightCfg.online !== false && !net.scanning) net.scan(Object.keys(LOCATIONS), renderOnline); renderOnline(); };
  el.querySelectorAll('[data-loc]').forEach((b) => b.addEventListener('click', renderOnline));
  el.querySelectorAll('[data-on]').forEach((b) => b.addEventListener('click', () => { flightCfg.online = b.dataset.on === '1'; el.querySelectorAll('[data-on]').forEach((x) => x.classList.toggle('on', x === b)); audio.play('click'); scan(); }));
  el.querySelector('#mp-name').addEventListener('input', (e) => net.setName(e.target.value));
  const rescan = setInterval(() => { if (!list.isConnected) { clearInterval(rescan); return; } scan(); }, 15000);
  scan();
  const fly = async (choice) => {
    LS.set('flight', flightCfg); m.close(); clearInterval(rescan);
    if (!choice) { startFlight(); return; }
    const load = $('#loading'), txt = load.querySelector('p'); load.classList.add('show'); txt.textContent = 'Finding other pilots…';
    let o = null, err = null;
    try { o = await net.connect(flightCfg, choice); } catch (e) { console.warn(e); err = e; net.leave(); }
    txt.textContent = 'Generating world…';
    startFlight(o || {});
    if (err) setTimeout(() => hud.toast(choice.auto ? 'Couldn’t go online, so you’re flying alone.' : `${err.message} Flying alone.`, 'bad'), 1500);
  };
  el.querySelector('#go').addEventListener('click', () => fly(flightCfg.online !== false ? { auto: true } : null));
}

function buildInfo() {
  const when = BUILT ? new Date(BUILT).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'local dev build';
  return `Skywright ${VERSION} · build ${COMMIT} · ${when}`;
}
// ---------- updates ----------
// The deployed src/version.js is the source of truth: poll it (a ~200-byte no-store fetch) and when its COMMIT differs
// from the one we're running, wipe the offline cache and reload. Relying on the browser's service-worker update alone
// was unreliable: it only checks on load / every 10 min / on refocus, and its all-or-nothing precache can fail on flaky wifi.
let updatePending = false, lastInput = 0;
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(ev, () => { lastInput = performance.now(); }, { capture: true, passive: true });
async function liveCommit() {
  const txt = await (await fetch(`src/version.js?t=${Date.now()}`, { cache: 'no-store' })).text();
  return (txt.match(/COMMIT = '([^']+)'/) || [])[1] || null;
}
async function reloadFresh() {
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k); // scripts then come from the network
  location.reload();
}
// Called when the hangar is idle: no modal open and no touches for a few seconds, so nobody gets yanked mid-drag.
function applyUpdateWhenIdle() {
  if (state !== 'hangar') { updatePending = true; return; } // flights reload when they end
  const busy = $('#modal-root').style.display === 'block' || performance.now() - lastInput < 4000 || hangar.placing || net.active; // don't drop a multiplayer room either
  if (busy) { setTimeout(applyUpdateWhenIdle, 2000); return; }
  ui.hint('Updating to the latest version…'); setTimeout(reloadFresh, 800);
}
let checking = false;
async function autoCheckUpdate() {
  if (checking || COMMIT === 'dev' || document.hidden || !navigator.onLine) return;
  checking = true;
  try {
    const live = await liveCommit();
    if (!live || live === 'dev' || live === COMMIT) return;
    // loop guard: if a reload didn't bring in this build (CDN still propagating), try it at most once a minute
    const tried = JSON.parse(sessionStorage.getItem('skywright.updTried') || 'null');
    if (tried && tried.live === live && Date.now() - tried.t < 60000) return;
    sessionStorage.setItem('skywright.updTried', JSON.stringify({ live, t: Date.now() }));
    applyUpdateWhenIdle();
  } catch { /* offline or server hiccup: next poll */ } finally { checking = false; }
}
// Settings button: same check, with feedback, and it reloads even on a dev build.
async function updateNow(status) {
  status.textContent = 'Checking…';
  try {
    const live = await liveCommit();
    if (live && live === COMMIT && COMMIT !== 'dev') { status.textContent = 'You have the latest version ✓'; return; }
    status.textContent = live && live !== 'dev' ? `Updating to build ${live}…` : 'Reloading…';
    setTimeout(reloadFresh, 400);
  } catch (e) { status.textContent = 'Couldn’t reach the server. Are you online?'; }
}
// ---------- what's new ----------
// After an update brings in a higher VERSION, list what changed since the version this player last saw.
function whatsNewModal(entries, title = 'What’s new ✨') {
  const MAX = 10, shown = entries.slice(0, MAX);
  const m = ui.modal(`<h2>${title}</h2>
    <div class="whats-new">${shown.map((e, i) => `<section${i ? '' : ' class="latest"'}>
      <h4>Version ${e.v}</h4><ul>${e.items.map((t) => `<li>${t}</li>`).join('')}</ul></section>`).join('')}
    ${entries.length > MAX ? `<p class="more">…and ${entries.length - MAX} more updates before that.</p>` : ''}</div>
    <div class="modal-foot"><button data-close class="primary">Let’s fly!</button></div>`);
  m.el.querySelector('[data-close]').addEventListener('click', () => audio.play('click'));
}
function maybeShowWhatsNew() {
  // 1.11.0 is the last release before this popup existed, so a player with saved stuff but no record has seen at least that.
  // A brand-new player starts at the current version with no popup.
  const LEGACY_SEEN = '1.11.0';
  let seen = LS.get('seenVersion', null) || (returningPlayer ? LEGACY_SEEN : VERSION);
  // One-time repair: 1.13–1.17 showed pre-popup players only the newest release, so they never heard about
  // helicopters (1.12). Rewind them once so they get the full list.
  if (!LS.get('seenRepair1', false)) { if (newer(seen, LEGACY_SEEN) && !newer(seen, '1.17.0')) seen = LEGACY_SEEN; LS.set('seenRepair1', true); }
  LS.set('seenVersion', VERSION);
  if (!newer(VERSION, seen)) return;
  const entries = changesSince(seen, VERSION);
  if (!entries.length) return;
  // let the splash fade first, and don't cover another modal or a flight
  setTimeout(() => { if (state === 'hangar' && $('#modal-root').style.display !== 'block') whatsNewModal(entries); }, 1200);
}
function settingsModal() {
  const m = ui.modal(`
    <h2>Settings</h2>
    <label class="lbl">Graphics</label><div class="chips">${['auto', 'low', 'medium', 'high', 'ultra'].map((q) => `<button data-q="${q}" class="${settings.quality === q ? 'on' : ''}">${q === 'auto' ? 'Auto (recommended)' : q[0].toUpperCase() + q.slice(1)}</button>`).join('')}</div>
    <p class="version" style="margin:6px 0 4px;text-align:left">Auto picks ${autoTier[0].toUpperCase() + autoTier.slice(1)} on this device. Ultra adds far-reaching shadows, ambient occlusion, sun shafts and sharper edges: for desktop graphics cards. A new tier applies fully from the next flight.</p>
    <label class="check"><input type="checkbox" id="fps" ${settings.showFps ? 'checked' : ''}> Show frame rate</label>
    <label class="lbl">Units</label><div class="chips"><button data-u="imperial" class="${settings.units === 'imperial' ? 'on' : ''}">Knots &amp; feet</button><button data-u="metric" class="${settings.units === 'metric' ? 'on' : ''}">km/h &amp; metres</button></div>
    <label class="lbl">Touch steering</label><div class="chips"><button data-cm="stick" class="${settings.controlMode === 'stick' ? 'on' : ''}">On-screen stick</button><button data-cm="tilt" class="${settings.controlMode === 'tilt' ? 'on' : ''}">Tilt the tablet</button></div>
    <label class="lbl">On-screen controls</label><div class="chips">${['auto', 'on', 'off'].map((t) => `<button data-t="${t}" class="${settings.touch === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <label class="check"><input type="checkbox" id="inv" ${settings.invert ? 'checked' : ''}> Invert pitch (push stick forward / up-arrow to climb)</label>
    <label class="lbl">Sound</label>
    <label class="check"><input type="checkbox" id="callouts" ${settings.callouts ? 'checked' : ''}> Voice callouts (altitude on landing, stall, pull up)</label>
    <div class="mixer">${[['master', 'Volume'], ['engines', 'Engines'], ['world', 'Wind & world'], ['fx', 'Effects'], ['music', 'Music']].map(([k, n]) =>
      `<label>${n}</label><input type="range" min="0" max="1" step="0.02" value="${settings.mix[k]}" data-mix="${k}"><b data-mixv="${k}">${Math.round(settings.mix[k] * 100)}</b>`).join('')}</div>
    <label class="lbl">Privacy</label>
    <label class="check"><input type="checkbox" id="stats" ${settings.analytics !== false ? 'checked' : ''}> Share anonymous usage stats (which planes and places get flown, frame rate, errors). No names or locations.</label>
    <p class="version">${buildInfo()} · device ${analytics.id}</p>
    <div class="update-row"><button id="upd">Check for updates</button><button id="wn">What’s new</button><span id="upd-status"></span></div>
    <div class="modal-foot"><button data-close class="primary">Done</button></div>`);
  const el = m.el;
  const pick = (attr, key, after) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => { settings[key] = b.dataset[attr]; el.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle('on', x === b)); LS.set('settings', settings); analytics.capture('setting_changed', { setting: key, value: settings[key] }); after?.(); }));
  pick('q', 'quality', () => { perf.scale = 1; perf.level = 0; applyQuality(); });
  el.querySelector('#upd').addEventListener('click', () => updateNow(el.querySelector('#upd-status')));
  el.querySelector('#wn').addEventListener('click', () => whatsNewModal(CHANGELOG, 'What’s new'));
  el.querySelector('#fps').addEventListener('change', (e) => { settings.showFps = e.target.checked; LS.set('settings', settings); analytics.capture('setting_changed', { setting: 'showFps', value: settings.showFps }); });
  el.querySelector('#stats').addEventListener('change', (e) => { settings.analytics = e.target.checked; LS.set('settings', settings); analytics.setEnabled(settings.analytics); });
  pick('u', 'units', renderInspector); pick('cm', 'controlMode', () => controls.setMode(settings.controlMode)); pick('t', 'touch');
  el.querySelector('#inv').addEventListener('change', (e) => { settings.invert = e.target.checked; controls.invert = settings.invert; LS.set('settings', settings); analytics.capture('setting_changed', { setting: 'invert', value: settings.invert }); });
  el.querySelector('#callouts').addEventListener('change', (e) => { settings.callouts = audio.callouts = e.target.checked; LS.set('settings', settings); analytics.capture('setting_changed', { setting: 'callouts', value: settings.callouts }); });
  el.querySelectorAll('[data-mix]').forEach((r) => r.addEventListener('input', () => {
    const k = r.dataset.mix; settings.mix[k] = +r.value; el.querySelector(`[data-mixv="${k}"]`).textContent = Math.round(r.value * 100);
    audio.setMix(settings.mix); LS.set('settings', settings);
  }));
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
  <h4>Credits</h4><p>Voice callouts use the open-source Piper voice "joe". Engines, wind, tyres, weather, nature and crash sounds are real recordings from <a href="https://freesound.org" target="_blank" rel="noopener">Freesound</a>: <a href="assets/sfx/CREDITS.md" target="_blank" rel="noopener">sound credits</a>. Music: “Easy Lemon”, “Floating Cities” and “Heroic Age” by Kevin MacLeod (incompetech.com), licensed under <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.</p>
  <p>Jungfrau Region: satellite imagery <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2016</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016, CC BY 4.0); elevation from Terrain Tiles on AWS; map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL).</p>
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
const net = new Net({ ui, hud, audio, LS, getDesign: () => hangar.design, getCfg: () => flightCfg });
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
  const fail = (e) => { console.error(e); $('#loading').classList.remove('show'); state = 'hangar'; ui.hint('Something went wrong: ' + e.message); };
  // real-world places load their baked geodata first (cached by the service worker after the first visit)
  const loc = LOCATIONS[cfg.location], msg = $('#loading p'), msg0 = msg.textContent;
  const ready = loc?.real ? loadReal(loc, qualityTier(), (f) => (msg.textContent = `Loading ${loc.name}… ${Math.round(f * 100)}%`)) : Promise.resolve();
  ready.then(() => setTimeout(() => {
    msg.textContent = msg0;
    try { buildFlight(cfg); } catch (e) { fail(e); }
  }, 50), (e) => { msg.textContent = msg0; fail(new Error(`couldn’t load ${loc.name} (it needs the internet the first time): ${e.message}`)); });
}
function buildFlight(cfg) {
  const scene = new THREE.Scene();
  const world = new World(renderer, scene, { location: cfg.location, quality: qualityTier(), time: cfg.time, weather: cfg.weather });
  world.addParked([2, 0, 4, 7].map((i) => mergeByMaterial(buildStatic(presets[i]))));
  const realism = REALISM[cfg.realism];
  const design = cloneDesign(hangar.design);
  const ac = new Aircraft(design, realism);
  scene.add(ac.root);
  const effects = new Effects(scene);
  const sonic = new SonicFX(ac, scene);
  const traffic = new Traffic(scene, world, presets);
  const st = analyze(design);
  const env = {
    groundAt: (x, z) => world.groundAt(x, z), maxGround: (x, z) => world.maxGround(x, z), windAt: (p) => world.windAt(p),
    get night() { return world.night || world.W.dark > 0.6; }, groundHeightAtSpawn: world.loc.rwyH,
    onDebrisHit: (d, p, sp, g) => { if (sp > 10) { if (g.type === 'water') effects.splash(p, sp * 0.5); else effects.dust(p, { x: 0, z: 0 }, g.type, 6); } if (sp > 14 && Math.random() < 0.3) audio.play('impact', sp / 40, p.clone()); },
  };
  let start = cfg.start;
  const gearOK = ac.parts.some((p) => p.gear && (!p.gear.float || p.gear.skid)); // skids can sit on a runway
  if (cfg.mode === 'landing') start = 'approach';
  else if (start === 'water' || (start === 'runway' && st.floats && !gearOK)) start = 'water';
  if (start === 'runway' && (!ac.hasEngine)) start = 'air';
  if (st.car && st.wingArea < 0.5 && (start === 'air' || start === 'approach')) start = 'runway'; // cars without wings start on the ground
  const slot = cfg.mpSlot || 0, slotX = slot ? (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * 70 : 0; // multiplayer: side by side, stepped up
  const vApp = clamp(Number.isFinite(st.stall) ? st.stall * 1.45 : 45, 32, 110);
  const rwy = world.runways[net.active ? net.freeRunway(world) : cfg.rwy || 0] || world.runway; // online: a runway nobody is on
  if (start === 'runway') { ac.spawn(env, new THREE.Vector3(rwy.x, 0, rwy.len / 2 - 60), 0); }
  else if (start === 'water') {
    const w = findWater(world);
    if (w) ac.spawn(env, w, 0); else { start = 'air'; }
  }
  if (start === 'air') { ac.spawn(env, new THREE.Vector3(slotX, 0, world.runway.len / 2 + 1200 + slot * 40), 0, { air: true, alt: world.loc.rwyH + (st.heli ? 120 : 450) + slot * 30, speed: st.heli ? 0 : vApp * 1.1 }); controls.setThrottle(st.heli ? 0.5 : ac.hasEngine ? 0.65 : 0); } // helicopters start hovering
  else if (start === 'approach') {
    const dist = 2600;
    ac.spawn(env, new THREE.Vector3(0, 0, world.runway.len / 2 - 380 + dist), 0, { air: true, alt: world.loc.rwyH + dist * Math.tan(THREE.MathUtils.degToRad(3)) + 3, speed: st.heli ? 20 : vApp, pitch: -0.02 });
    ac.gearDown = true; ac.gearT = 1; ac.flaps = 1; controls.setThrottle(st.heli ? 0.45 : 0.55);
  } else controls.setThrottle(0);
  if (start === 'air') { ac.flaps = 0; }
  if (st.car && !st.heli) setTimeout(() => ui.hint('Car: throttle to go, stick to steer, pull the stick back to reverse'), 1500);
  if (st.heli) setTimeout(() => ui.hint(cfg.realism === 'sim' ? 'Helicopter: throttle is the collective. Good luck!' : 'Helicopter: throttle to the middle to hover, more to climb'), 1500);
  let mission = null;
  if (cfg.mode === 'rings') mission = new RingRace(scene, world, ac, cfg.realism);
  else if (cfg.mode === 'landing') mission = new LandingChallenge(world);
  sonic.onBoom = (pos) => {
    const ck = rig.mode === 'cockpit'; // outside, the boom reaches the camera distance/343 s later, from where the shock formed
    audio.sonicBoom(1.5, pos, ck ? 0 : Math.min(8, flightCam.position.distanceTo(pos) / 343), ck);
    hud.center('MACH 1!', 2200); if (!ac.boomed) hud.toast('You broke the sound barrier!', 'good');
    ac.boomed = true; rig.shake(1.4); post.shock(0.45);
  };
  sonic.onMilestone = (n) => { hud.center(`MACH ${n}!`, 1800); audio.play('ring'); };
  F = { scene, world, ac, effects, sonic, shim: [], traffic, env, cfg, mission, debris: [], timeScale: 1, slowmo: 0, endT: null, paused: false, shownEnd: false, events: [], sounds: [], cfgStart: start, lastSlowmo: -99 };
  applyQuality(); // the tier may have changed since the last flight (post effects, shadow cascades)
  F.callouts = new Callouts(audio, ac);
  F.worldSound = new WorldSound(audio, world, traffic);
  // engines: already running for air starts; on the ground they start with the first throttle-up (see engineSwitch)
  F.eng = { on: start === 'air' || start === 'approach', hold: 0, idleT: 0 }; ac.engineRunning = F.eng.on; audio.engineReset(F.eng.on);
  net.attach(F);
  rig.init = false; rig.set('chase'); rig.look.dist = 1;
  hud.setUnits(settings.units); hud.show(true);
  flightUI.style.display = ''; $('#hangar-ui').style.display = 'none';
  const showTouch = settings.touch === 'on' || (settings.touch === 'auto' && isTouch);
  controls.showTouch(showTouch); controls.enabled = true;
  document.body.classList.toggle('touch-on', showTouch);
  hud.setTouch(showTouch);
  hangar.activate(false);
  audio.music(false);
  state = 'flight';
  F.track = { location: cfg.location, realism: cfg.realism, mode: cfg.mode, start, time_of_day: cfg.time, weather: cfg.weather, online: !!net.active, plane: planeLabel(design), kind: planeKind(st), engine: ac.hasEngine };
  Object.assign(F, { t0: performance.now(), frames: 0, activeT: 0, fpsLow: Infinity, maxLevel: perf.level, playersMax: net.count });
  analytics.capture('flight_start', { ...F.track, parts: design.parts.length, part_types: [...new Set(design.parts.map((p) => p.id))], quality: settings.quality, touch: showTouch, control_mode: settings.controlMode });
  $('#loading').classList.remove('show');
  onResize();
  const msg = { runway: `Runway ${rwy.name} · ${world.loc.name}. Throttle up and pull back gently at ${Math.round(st.stall * (settings.units === 'metric' ? 3.6 : 1.944))} ${settings.units === 'metric' ? 'km/h' : 'kt'}!`, air: 'Airborne! Fly safe.', water: 'On the water. Full throttle and lift off!', approach: 'On final approach. Follow the PAPI lights: two white, two red.' }[start];
  hud.center(msg, 3500);
  if (world.loc.credit) setTimeout(() => { if (F?.world === world) hud.toast(world.loc.credit); }, 4000); // real places: data attribution
  if (!ac.hasEngine) hud.toast('Glider: look for rising air under clouds and over sunny ridges.');
}

// One flight_end per flight: outcome is how it ended (crash, mission result) or why it was left (hangar, restart, closed the app)
function trackFlightEnd(f, exit) {
  if (!f || f.tracked || !f.track) return; f.tracked = true;
  const s = f.ac.stats, secs = (performance.now() - f.t0) / 1000;
  analytics.capture('flight_end', {
    ...f.track, outcome: f.outcome || exit, exit, seconds: Math.round(secs), air_seconds: Math.round(s.airTime),
    max_speed_kmh: Math.round(s.maxSpeed * 3.6), max_alt_m: Math.round(s.maxAlt), max_mach: +(s.maxMach || 0).toFixed(2), max_g: +s.maxG.toFixed(1),
    distance_km: +(s.distance / 1000).toFixed(1), landings: s.landings, best_landing_ms: s.bestLanding == null ? null : +s.bestLanding.toFixed(2), parts_lost: s.partsLost,
    fps_avg: f.activeT > 1 ? Math.round(f.frames / f.activeT) : null, fps_low: Number.isFinite(f.fpsLow) ? Math.round(f.fpsLow) : null,
    quality_level: f.maxLevel, res_scale: +perf.scale.toFixed(2), players_max: f.playersMax,
  });
}
analytics.onLeave = () => trackFlightEnd(F, 'closed');
function endFlight(restarting = false) {
  if (!F) return;
  trackFlightEnd(F, restarting ? 'restart' : 'hangar');
  net.detach(); if (!restarting) net.leave();
  if (updatePending) { reloadFresh(); return; }
  const f = F; F = null;
  f.world.dispose(); f.effects.dispose(); f.sonic.dispose(); post.shimmer(null); f.traffic.dispose(); f.mission?.dispose?.();
  f.worldSound?.dispose();
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
    const m = ui.modal(`<h2>Paused</h2>${net.pauseHTML()}
      <div class="pause-stats">${statsHTML(F.ac)}</div>
      <div class="col-buttons"><button class="primary big" data-a="resume">Resume</button><button data-a="restart">${net.active ? 'Respawn' : 'Restart flight'}</button><button data-a="calib" ${settings.controlMode !== 'tilt' ? 'hidden' : ''}>Re-centre tilt</button><button data-a="settings">Settings</button><button data-a="help">Controls help</button><button data-a="hangar" class="danger">Back to hangar${net.active ? ' (leave game)' : ''}</button></div>`, 'sticky');
    m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a; m.close();
      if (a === 'resume') F.paused = false;
      if (a === 'restart') restartFlight();
      if (a === 'hangar') endFlight();
      if (a === 'calib') { controls.calibrate(); F.paused = false; }
      if (a === 'settings') { settingsModal(); F.paused = true; }
      if (a === 'help') { helpModal(); F.paused = true; }
    }));
  } else { const r = $('#modal-root'); r.innerHTML = ''; r.style.display = 'none'; }
}
function restartFlight() { const c = F.cfg; endFlight(true); startFlight(c); }
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
    <div><label>Parts lost</label><b>${t.partsLost}</b></div>${t.maxMach >= 0.8 ? `
    <div><label>Top Mach</label><b>${t.maxMach.toFixed(2)}</b></div>` : ''}</div>`;
}
function showEnd(title, extra = '') {
  if (!F || F.shownEnd) return;
  F.shownEnd = true;
  F.outcome = /Kaboom/.test(title) ? 'destroyed' : /Splash/.test(title) ? 'splashdown' : /Course/.test(title) ? 'race_done' : /Landing score/.test(title) ? 'landing_done' : 'crashed';
  const m = ui.modal(`<h2>${title}</h2>${extra}<div class="pause-stats">${statsHTML(F.ac)}</div>
    <div class="col-buttons"><button class="primary big" data-a="restart">Fly again</button><button data-a="watch">Keep watching</button><button data-a="hangar">Back to hangar (repair)${net.active ? ' · leaves the game' : ''}</button></div>`, 'sticky');
  m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.a; m.close();
    if (a === 'restart') restartFlight();
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
        const vs = e.vs; F?.callouts?.landing(vs); const ok = vs < 1.0 ? 'Butter! ' : vs < 2 ? 'Nice landing! ' : vs < 3.2 ? 'Firm landing. ' : 'Ouch! ';
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

// Engine start and shutdown. On a ground start the engines are off: the first throttle-up plays the start sequence and the
// throttle waits until the engine catches. Parked with the throttle closed for a few seconds, they shut down. Air starts never
// play a start (the engines are running already), and with ac.engineRunning set, a prop idles at zero throttle instead of stopping.
// which engine voice a part uses: main rotors get the helicopter rotor voice (tail rotors are part of it)
const engSound = (e) => (e.type === 'rotor' ? 'rotor' : e.sound);
const engineKinds = (ac) => [...new Set(ac.parts.filter((p) => p.alive && p.engine && engSound(p.engine)).map((p) => engSound(p.engine)))];
function engineSwitch(f, ac, thr, dt) {
  const E = f.eng; if (!E || ac.dead || !ac.hasEngine) return thr;
  if (E.hold > 0) { E.hold -= dt; if (E.hold <= 0) E.on = true; else thr = 0; }
  else if (!E.on && thr > 0.02) { E.hold = audio.engineStart(engineKinds(ac)); if (E.hold > 0) thr = 0; else E.on = true; }
  else if (E.on && ac.onGround && thr < 0.02 && ac.v.length() < 0.5) { E.idleT += dt; if (E.idleT > 6) { E.on = false; E.idleT = 0; audio.engineStop(engineKinds(ac)); } }
  else E.idleT = 0;
  ac.engineRunning = E.on || E.hold > 0;
  return thr;
}

function stepFlight(dtReal) {
  const f = F; if (!f || f.paused) return;
  const { ac, world, effects, traffic } = f;
  f.t = (f.t || 0) + dtReal;
  if (f.slowmo > 0) { f.slowmo -= dtReal; f.timeScale = 0.3; } else f.timeScale = Math.min(1, f.timeScale + dtReal * 2);
  const dt = Math.min(dtReal, 1 / 20) * f.timeScale;
  const c = controls.update(dtReal), thr = engineSwitch(f, ac, c.throttle, dtReal);
  ac.setControls({ pitch: c.pitch, roll: c.roll, yaw: c.yaw, throttle: thr });
  ac.brake = c.brake || (thr < 0.03 && ac.onGround && ac.v.length() < 3 && !(ac.isCar && c.pitch > 0.2) ? 1 : 0); // parking brake (not while a car reverses)
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
  net.update(dtReal, f, flightCam, settings.units);
  f.mission?.update(dt, ac, f.events);
  ac.events.length = 0;
  for (const e of f.events.splice(0)) {
    if (e.type === 'count') { audio.mission(e.n ? 'count' : 'go', e.n); hud.center(e.n ? `${e.n}` : 'GO!', 800); }
    if (e.type === 'ring') { audio.mission('checkpoint', e.n, e.total); hud.center(`${e.n} / ${e.total}`, 900); }
    if (e.type === 'raceDone') { audio.mission('win'); analytics.capture('mission_done', { ...f.track, mission: 'rings', seconds: +e.time.toFixed(1) }); const best = LS.get('best', {}); const key = `${f.cfg.location}:${hangar.design.name}`; const pb = !best[key] || e.time < best[key]; if (pb) { best[key] = e.time; LS.set('best', best); setTimeout(() => audio.mission('record'), 2600); } setTimeout(() => showEnd(`Course complete: ${e.time.toFixed(1)} s`, pb ? '<p class="good">New personal best!</p>' : `<p>Best: ${best[key].toFixed(1)} s</p>`), 1500); }
    if (e.type === 'landingDone') { analytics.capture('mission_done', { ...f.track, mission: 'landing', crashed: !!e.crashed, score: e.score, sink_ms: +e.vs.toFixed(2), on_runway: !!e.onRwy }); audio.mission(e.crashed || e.score < 300 ? 'fail' : e.score > 500 ? 'win' : 'ok'); const stars = '★'.repeat(Math.round(e.score / 200)) + '☆'.repeat(5 - Math.round(e.score / 200)); setTimeout(() => showEnd(e.crashed ? 'Crashed on landing' : `Landing score: ${e.score}`, e.crashed ? '' : `<p class="stars">${stars}</p><p>Sink rate ${e.vs.toFixed(1)} m/s · ${Math.abs(e.cl).toFixed(1)} m off centreline · ${Math.round(Math.abs(e.aim))} m ${e.aim > 0 ? 'short of' : 'past'} the aim point${e.onRwy ? '' : ' · missed the runway!'}</p>`), 800); }
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
  f.sonic.update(dt, { effects, world });
  traffic.update(dt, effects, flightCam.position);
  const wind = world.windBase.clone().add(world.gust);
  effects.update(dt, wind);
  // camera
  let focus = null;
  if (ac.dead || ac.wrecked) { const biggest = ac.dead ? f.debris.reduce((a, d) => (!a || d.mass > a.mass ? d : a), null) : null; focus = biggest ? biggest.x : null; if (rig.mode === 'cockpit') rig.set('orbit'); }
  rig.update(dtReal, ac, world, focus);
  ac.setCockpitView(rig.mode === 'cockpit' && !focus);
  world.update(dtReal, flightCam, rig.vel, f.events);
  effects.setLighting(world, flightCam);
  post.shimmer(f.sonic.shimmer(flightCam, f.shim), perf.level < 1 && qualityTier() !== 'low'); // heat haze is the first thing Auto quality sheds
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
    if (!p.alive || !p.engine || !engSound(p.engine)) continue; const e = p.engine;
    const k = engSound(e); if (!engines[k]) engines[k] = { sound: k, rpm: 0, spoolT: 0, count: 0, blades: { e_turboprop: 4, e_radial: 3, e_electric: 6, r_main4: 4 }[p.p.id] || 2, ab: false, burning: false, pos: new THREE.Vector3(), fwd: ac.forward };
    if (k === 'rotor') { engines[k].load = ac.collective ?? 0.5; engines[k].tail = ac.parts.some((q) => q.alive && q.engine?.type === 'tailrotor'); }
    const a = engines[k]; a.count++; a.rpm = Math.max(a.rpm, e.rpm || 0); a.spoolT = Math.max(a.spoolT, e.spoolT || 0); a.ab = a.ab || e.abOn; a.burning = a.burning || e.burning;
    a.pos.add(ac.worldPoint(e.pos)); a.dmg = Math.max(a.dmg || 0, p.dmg / p.hp); // damage: sputter and misfire (audio.engineDamage)
  }
  // damage audio: the worst burning engine (same > 70 % rule as the flames above), and damaged parts still attached (rattle)
  const dmgAudio = { fire: null, rattle: 0 };
  if (!ac.dead) for (const p of ac.parts) {
    if (!p.alive) continue; const fr = p.dmg / p.hp;
    if (p.engine && fr > 0.7 && fr > (dmgAudio.fire?.fr ?? 0)) dmgAudio.fire = { fr, amt: 0.5 + 0.5 * Math.min(1, (fr - 0.7) / 0.3), pos: ac.worldPoint(p.engine.pos) };
    else if (!p.engine && !p.gear) dmgAudio.rattle = Math.max(dmgAudio.rattle, fr);
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
    gear: contactGear(ac), scrape: f.scrapeT > 0 ? f.scrape : 0, stall: ac.stalled && !ac.dead, cockpit, doppler, rain: world.rain.visible ? world.W.rain : 0,
    listener: { pos: flightCam.position, fwd: camFwd, up: camUp },
    amb: { loc: world.loc.id, night: world.night, day: !world.night && world.W.rain === 0, agl, waterNear: waterProximity(f, world, flightCam.position) },
    fire: dmgAudio.fire, rattle: dmgAudio.rattle, g: ac.dead ? 0 : ac.g, acPos: ac.x,
    music: flightMusic(f, ac, world) });
  f.worldSound?.update(f, flightCam.position, dtReal, net.players?.values(), cockpit);
  f.callouts?.update(world, dtReal);
  hud.update(ac, world, f.mission, flightCam, net.markers());
  if (f.debug) $('#debug').textContent = `α ${(ac.alpha * 57.3).toFixed(1)}° g ${ac.g.toFixed(2)} V ${ac.airspeed?.toFixed(1)} m=${Math.round(ac.mass)} com=${ac.com.toArray().map((v) => v.toFixed(2))} w=${ac.w.toArray().map((v) => v.toFixed(2))}`;
  $('#debug').style.display = f.debug ? '' : 'none';
}

// Which music track suits the moment: the heroic one during a mission, a quiet one when cruising high, nothing near the ground or after a crash.
function flightMusic(f, ac, world) {
  if (ac.dead || ac.wrecked) return null;
  if (f.mission && !f.mission.done) return 'mission';
  const h = ac.x.y - Math.max(world.heightAt(ac.x.x, ac.x.z), world.waterLevel);
  f.musicHigh = h > (f.musicHigh ? 120 : 250); // hysteresis so it doesn't flicker around the threshold
  return f.musicHigh && !ac.onGround ? 'cruise' : null;
}
// what is touching the ground: 'skid' (helicopter skids), 'float' or 'wheel' (picks the ground-roll sound)
function contactGear(ac) {
  for (const p of ac.parts) if (p.alive && p.gear?.wheels.some((w) => w.contact)) return p.gear.skid ? 'skid' : p.gear.float ? 'float' : 'wheel';
  return 'wheel';
}
// 0..1: how close the camera is to open water (sampled in rings, refreshed twice a second)
function waterProximity(f, world, p) {
  if (f.waterT && f.t - f.waterT < 0.5) return f.waterNear;
  f.waterT = f.t;
  let best = 1e9;
  for (const r of [0, 30, 70, 130, 220, 340, 500]) {
    for (let k = 0; k < (r ? 12 : 1); k++) {
      const a = (k / 12) * Math.PI * 2;
      if (world.sampleGrid(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r) < world.waterLevel) { best = r; break; }
    }
    if (best < 1e9) break;
  }
  // height above the water also counts as distance
  const d = Math.hypot(best, Math.max(0, p.y - world.waterLevel));
  f.waterNear = best < 1e9 ? Math.max(0, 1 - d / 450) : 0;
  return f.waterNear;
}

// ---------- main loop ----------
let last = performance.now();
function applyQuality() {
  const tier = qualityTier();
  renderer.setPixelRatio(pixelRatio());
  post.enabled = tier !== 'low' && perf.level < 2;
  post.setSamples(isHigh(tier) && perf.level < 1 ? 4 : 0);
  post.setUltra(tier === 'ultra' && perf.level < 1); // AO, sun shafts, SMAA: the first things Auto sheds on Ultra
  renderer.shadowMap.type = isHigh(tier) ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (F) { if (F.world.cascades) F.world.cascades.enabled = F.world.q.shadows && perf.level < 3; else F.world.sun.castShadow = F.world.q.shadows && perf.level < 3; }
  if (F) F.world.detailU.tDetail.value = perf.level < 3 ? 1 : 0; // photo ground detail goes last, with shadows
  if (F) F.world.setPerfLevel?.(perf.level); // thinner clouds, no cirrus when struggling
  if (F) F.world.flora.setPerf?.(perf.level); // grass ring, then tree LOD range shrink under load
  hangar.setQuality(tier);
  onResize();
}
// Adaptive quality: keep the frame rate up by lowering the render resolution, then
// switching off the most expensive effects (MSAA -> bloom/post -> shadows) if needed.
function governPerf(dt) {
  const ms = dt * 1000; perf.ema += (ms - perf.ema) * 0.05; perf.fps = 1000 / perf.ema;
  if (state === 'flight' && F?.t0) { if (ms < 1000) { F.frames++; F.activeT += dt; } if (!F.paused && performance.now() - F.t0 > 8000 && ms < 1000) F.fpsLow = Math.min(F.fpsLow, perf.fps); F.maxLevel = Math.max(F.maxLevel, perf.level); if (net.count > F.playersMax) F.playersMax = net.count; }
  const fpsEl = document.getElementById('fps-meter');
  if (fpsEl) { fpsEl.style.display = settings.showFps && state === 'flight' ? '' : 'none'; if (settings.showFps) fpsEl.textContent = `${Math.round(perf.fps)} fps · ${Math.round(renderer.getPixelRatio() * 100)}% res${perf.level ? ' · lite ' + perf.level : ''}`; }
  if (settings.quality !== 'auto' || (state !== 'flight' && state !== 'hangar')) return;
  const now = performance.now();
  if (ms > 100) return; // ignore hitches (loading, tab switches)
  if (perf.ema > 22) { perf.slowT += dt; perf.fastT = 0; } else if (perf.ema < 17.5) { perf.fastT += dt; perf.slowT = 0; } else { perf.slowT = perf.fastT = 0; }
  if (now - perf.lastChange < 1500) return;
  if (perf.slowT > 1.5) {
    if (qualityTier() === 'ultra' && perf.level === 0 && perf.scale < 0.95) perf.level = 1; // Ultra: shed the post effects after one resolution step
    else if (perf.scale > 0.55) perf.scale = Math.max(0.55, perf.scale - 0.12); else if (perf.level < 3) perf.level++;
    perf.slowT = 0; perf.lastChange = now; applyQuality();
  } else if (perf.fastT > 5 && (perf.scale < 1 || perf.level > 0)) {
    if (perf.level > 0 && perf.scale >= 0.9) perf.level--; else perf.scale = Math.min(1, perf.scale + 0.08);
    perf.fastT = 0; perf.lastChange = now; applyQuality();
  }
}
// Depth precision is set almost entirely by the near plane: at 0.2 m a 24-bit depth buffer resolves only ~250 m steps
// 30 km out, so from high up the far sea, skirt and terrain tiles z-fight in horizontal bands. Push the near plane out
// as far as the closest things allow (our own plane's bounding sphere, the ground below the camera); the cockpit view,
// a close orbit and crashes keep the default.
function fitNearPlane(f) {
  const cam = flightCam, ac = f.ac, w = f.world, p = cam.position;
  let room = 0;
  if (!ac.dead && !ac.wrecked) {
    const dAc = p.distanceTo(ac.x) - ac.radius * 1.3;
    const dGnd = p.y - Math.max(w.heightAt(p.x, p.z), w.waterLevel) - 60; // trees, buildings, hills nearby
    room = Math.min(dAc, dGnd);
  }
  const near = clamp(room * 0.5, 0.2, w.rain?.visible || w.snow?.visible ? 0.5 : 20); // rain/snow streaks right in front of the lens
  // the far plane reaches the edge of the far terrain (where the haze has swallowed everything); depth precision is
  // set by the near plane, so the long far plane costs next to nothing
  const far = Math.max(60000, w.tiles?.far.viewDist() ?? 0);
  if (Math.abs(near - cam.near) > 0.02 || far !== cam.far) { cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  governPerf(dt);
  if (state === 'hangar') {
    if (hangar.update(dt)) {
      post.look({ bloom: 0.3, threshold: 3.0, vignette: 0.35, warmth: 0.3 });
      post.ambientOcclusion({ radiusK: 0.03, rMin: 0.12, rMax: 1.2, maxDist: 250, strength: 1.1 }); post.shafts(post.atmos.sunUV, 0); // Ultra: contact shadows under the plane
      if (isHigh(qualityTier()) && perf.level < 2) post.render(hangar.scene, hangar.camera, dt); else renderer.render(hangar.scene, hangar.camera);
    }
  }
  else if (state === 'flight' && F) {
    stepFlight(dt);
    if (F) {
      // sun flare + per-time-of-day grade
      const w = F.world, vis = w.sunVisibility(flightCam);
      F.sunVis = (F.sunVis ?? 0) + (vis - (F.sunVis ?? 0)) * Math.min(1, dt * 6);
      const sp = flightCam.position.clone().addScaledVector(w.sunDir, 1000).project(flightCam);
      const onScreen = sp.z < 1 && Math.abs(sp.x) < 1.4 && Math.abs(sp.y) < 1.4;
      post.flare(new THREE.Vector2(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5), onScreen ? F.sunVis * (1 - w.W.dark) : 0, w.sun.color, flightCam.aspect);
      // Ultra: sun shafts from the open sky around the sun (also when the sun itself is just behind a ridge or a cloud)
      post.ambientOcclusion({ radiusK: 0.04, rMin: 1.5, rMax: 8, maxDist: 1200, strength: 1.8 });
      post.shafts(new THREE.Vector2(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5), sp.z < 1 && w.sunDir.y > -0.03 ? (1 - w.W.dark) * smoothstep(1.8, 1.0, Math.max(Math.abs(sp.x), Math.abs(sp.y))) : 0, w.sun.color);
      const golden = Math.max(0, 1 - Math.abs(w.sunElev - 0.08) / 0.3);
      post.look({ bloom: w.night ? 0.65 : 0.5, threshold: w.night ? 2.5 : 4.0, warmth: golden * 1.5 - w.W.dark * 0.5, saturation: 1.1 + golden * 0.1 - w.W.dark * 0.25, vignette: 0.3 });
      fitNearPlane(F);
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
// Long-presses on a tablet must never open the browser's context menu or start a text selection:
// both cancel the touch and leave the controls stuck.
// Only real text boxes keep the menu (for paste). Sliders are <input> too, but on Android a long-press on one
// opened the browser's own menu, so they are covered like everything else.
const TEXT_INPUT = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=number]';
const notText = (e) => !(e.target.closest && e.target.closest(TEXT_INPUT));
for (const t of [window, document]) {
  t.addEventListener('contextmenu', (e) => { if (notText(e)) { e.preventDefault(); e.stopPropagation(); } }, { capture: true });
  t.addEventListener('selectstart', (e) => { if (notText(e)) e.preventDefault(); }, { capture: true });
}
window.oncontextmenu = (e) => !notText(e) || false;
// Stop the long-press gesture itself on the 3D view and the flight controls (Chrome/Android shows its menu
// from the touch, not only via the contextmenu event). Pointer events still arrive, so nothing else changes.
const noTouchDefault = (el) => el.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
noTouchDefault(canvas); noTouchDefault(document.getElementById('touch-root'));
// Scroll rails: a big grab handle beside each side panel, so a finger can scroll the panel without landing on
// (and nudging) a control. Drag the thumb, or touch anywhere on the rail to jump there.
function scrollRail(scroller, rail) {
  const thumb = rail.firstElementChild;
  const sync = () => {
    const h = scroller.clientHeight, H = scroller.scrollHeight, track = rail.clientHeight;
    const over = H > h + 2; rail.classList.toggle('idle', !over);
    const th = over ? Math.max(56, track * h / H) : track;
    thumb.style.height = th + 'px';
    thumb.style.transform = `translateY(${over ? (track - th) * scroller.scrollTop / (H - h) : 0}px)`;
  };
  let grab = null;
  const to = (y) => {
    const r = rail.getBoundingClientRect(), th = thumb.offsetHeight, H = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = clamp((y - r.top - grab) / Math.max(1, r.height - th), 0, 1) * H;
  };
  rail.addEventListener('pointerdown', (e) => {
    e.preventDefault(); rail.setPointerCapture?.(e.pointerId);
    const t = thumb.getBoundingClientRect();
    grab = e.clientY >= t.top && e.clientY <= t.bottom ? e.clientY - t.top : t.height / 2; // off the thumb: centre it under the finger
    rail.classList.add('drag'); to(e.clientY);
  });
  rail.addEventListener('pointermove', (e) => { if (grab !== null) to(e.clientY); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) rail.addEventListener(t, () => { grab = null; rail.classList.remove('drag'); });
  rail.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  scroller.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(scroller);
  new MutationObserver(sync).observe(scroller, { childList: true, subtree: true });
  sync();
}
scrollRail($('#insp-scroll'), $('.inspector .rail'));
scrollRail($('#part-list'), $('.palette .rail'));
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'flight' && F && !F.paused) togglePause(true); });

// ---------- boot ----------
function gpuName() { try { const gl = renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : null; } catch { return null; } }
async function boot() {
  onResize();
  const saved = LS.get('current', null);
  hangar.load(saved && saved.parts?.length ? saved : presets[0]);
  try { thumbs = makeThumbnails(); } catch (e) { console.warn('thumbnails failed', e); }
  buildPalette(); renderInspector();
  hangar.setQuality(qualityTier());
  hangar.activate(true);
  requestAnimationFrame(frame);
  $('#splash').classList.add('hide');
  setTimeout(() => $('#splash').remove(), 900);
  maybeShowWhatsNew();
  analytics.open({ quality: settings.quality, units: settings.units, control_mode: settings.controlMode, saved_planes: LS.get('designs', []).length, gpu: gpuName() });
  document.addEventListener('pointerdown', () => { audio.init(); if (state === 'hangar') audio.music(true); }, { once: true });
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !location.hostname.match(/^(localhost|127\.)/)) {
    // The service worker is for offline play; updates are driven by autoCheckUpdate (see above).
    navigator.serviceWorker.addEventListener('controllerchange', autoCheckUpdate);
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (location.protocol !== 'file:') {
    setTimeout(autoCheckUpdate, 3000);
    setInterval(autoCheckUpdate, 60 * 1000);
    document.addEventListener('visibilitychange', autoCheckUpdate);
    addEventListener('online', autoCheckUpdate);
    addEventListener('focus', autoCheckUpdate);
  }
  window.__sky = { THREE, PARTS, Aircraft, REALISM, analyze, audio, post, renderer, get perf() { return perf; }, hangar, get F() { return F; }, startFlight, endFlight, net, presets, settings, flightCfg, controls, rig, analytics };
}
boot();
