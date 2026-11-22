// A collimated head-up display (the fighter's HUD): green symbology on the combiner glass that sits at infinity, as a
// real HUD's does: each fragment of the glass looks up what is drawn in the direction from the eye through it, so the
// pitch ladder lies on the real horizon and the flight path marker on where the aircraft is going wherever the head is.
//   - in the shader, every frame, no texture upload: the horizon line and the pitch ladder (a texture of pitch lines,
//     straight rungs in the HUD's field turned by the bank and slid by the pitch, as a real HUD draws them), the
//     heading scale low in the HUD (as the F-16's in NAV: fixed in the HUD, banking with the jet, 3 degrees of heading to
//     one, slid by the heading; riding under the flight path marker with the gear down), the flight path marker (a ring with wings where the velocity points)
//   - fixed to the aircraft (a small canvas redrawn ~10 times a second while it is watched): airspeed and altitude
//     boxes, Mach, g and the peak g, the gun cross, the heading caret, warnings
// Seen from the cockpit it is drawn after the tone mapping (renderHudOverlay: post.js's last pass before the grade, or
// straight after the scene without post): a saturated green added to the picture as a real HUD's light is, not dimmed
// by the exposure, the tone curve or fog; thin strokes from single-channel textures (mipmapped, anisotropic) with a
// faint dark halo round each stroke only, so it reads over white cloud and sand. Elsewhere (the chase camera, the
// hangar, other players' jets) it is drawn in the scene like any glowing glass.
// One draw call (the glass's quad), a few dozen ALU ops per fragment of it. The uniforms come from the mesh's own
// world matrix in onBeforeRender; the numbers and the flight path marker only move on the player's own aircraft
// (liveDisplays: seen from the cockpit).
// Angles in degrees: az right of the nose, el up from it (in the cockpit part's frame, -Z forward, +Y up).
import * as THREE from 'three';
import { REST, liveStats, liveRenderer, uploadRegion } from './liveDisplays.js';

const AZ = 8, EL0 = 0, EL = 8; // the canvas' half-width and its centre's elevation and half-height
const LADW = 16; // the ladder texture's half-width (degrees of azimuth)
const GREEN = new THREE.Color().setRGB(0.24, 1.0, 0.35, THREE.SRGBColorSpace), GREEN_OUT = new THREE.Color(0.24, 1.0, 0.35); // (#3dff59: in the scene's linear light, and as is on the screen after the tone mapping)
GREEN_OUT.setRGB(0.24, 1.0, 0.35, THREE.LinearSRGBColorSpace); // (stored raw: written straight to the display-referred picture)
let _lad = null, _tape = null;
// a canvas's red channel as a mipmapped single-channel texture (a quarter of the memory and upload of RGBA)
function r8(c, wrap = false) {
  const { width: w, height: h } = c, src = c.getContext('2d').getImageData(0, 0, w, h).data, d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const row = (h - 1 - y) * w * 4, o = y * w; for (let x = 0; x < w; x++) d[o + x] = src[row + x * 4]; } // (rows flipped: v up)
  const t = new THREE.DataTexture(d, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; if (wrap) t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}
// the pitch ladder by elevation (-90 at the bottom .. 90 at the top) and azimuth (-LADW .. LADW): the horizon line, and
// a rung every 5 degrees (solid above, dashed below, the ends turned towards the horizon), numbered. ~23 texels a
// degree up, 32 across: lines a tenth of a degree, as thin as a real HUD's
function ladderTex() {
  if (_lad) return _lad;
  const W = 1024, H = 4096, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  const X = (az) => W / 2 + (az / LADW) * (W / 2), Y = (el) => (1 - (el + 90) / 180) * H, ax = (W / (2 * LADW)) / (H / 180); // (ax: texels a degree across / up: the numbers drawn wider so they come out square)
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'butt';
  g.lineWidth = 3; g.beginPath(); g.moveTo(X(-LADW), Y(0)); g.lineTo(X(-1.4), Y(0)); g.moveTo(X(1.4), Y(0)); g.lineTo(X(LADW), Y(0)); g.stroke();
  g.font = '600 26px Helvetica, Arial, sans-serif'; g.textBaseline = 'middle';
  for (let p = -85; p <= 85; p += 5) {
    if (!p) continue; const y = Y(p), tick = (p > 0 ? 1 : -1) * 0.45 * (H / 180); g.lineWidth = 2.8; g.setLineDash(p < 0 ? [20, 14] : []);
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(X(s * 3.6), y + tick); g.lineTo(X(s * 3.6), y); g.lineTo(X(s * 0.9), y); g.stroke(); }
    g.setLineDash([]); const t = String(Math.abs(p));
    for (const [x0, al] of [[X(3.9), 'left'], [X(-3.9), 'right']]) { g.save(); g.translate(x0, y + (p > 0 ? 1 : -1) * 0.25 * (H / 180)); g.scale(ax, 1); g.textAlign = al; g.fillText(t, 0, 0); g.restore(); }
  }
  for (const p of [-90, 90]) { g.lineWidth = 2.3; g.beginPath(); g.arc(X(0), Y(p) + (p > 0 ? 20 : -20), 16, 0, 7); g.stroke(); }
  return (_lad = r8(c));
}
// the heading tape: 0..360 degrees across, ticks every 5, numbered every 10 (tens of degrees, as the F-16's), in a
// band 1.2 degrees tall
function tapeTex() {
  if (_tape) return _tape;
  const W = 4096, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = g.fillStyle = '#fff'; g.lineWidth = 3; g.font = '600 96px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const sq = (W / 360) * 3 / (H / 1.2); // (texels per HUD degree across (3 degrees of heading to one) / up: the numbers squeezed to come out square)
  for (let d = 0; d < 360; d += 5) { const x = (d / 360) * W; g.beginPath(); g.moveTo(x, H); g.lineTo(x, d % 10 ? H - 18 : H - 34); g.stroke(); if (!(d % 10)) { const s = String(d / 10).padStart(2, '0'); for (const xx of x < 60 ? [x, x + W] : [x]) { g.save(); g.translate(xx, 46); g.scale(sq, 1); g.fillText(s, 0, 0); g.restore(); } } }
  return (_tape = r8(c, true));
}

const VERT = /* glsl */`
varying vec3 vView, vPart;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; vPart = position; gl_Position = projectionMatrix * mv; }`;
const FRAG = /* glsl */`
uniform sampler2D uLad, uTape, uDyn; uniform mat3 uM; uniform float uHdgN, uI, uHalo, uTapeEl, uPitch, uRoll; uniform vec2 uFpm; uniform vec3 uCol, uEye, uBoxC[3], uBoxH[3];
varying vec3 vView, vPart;
const float D = 57.29578, PI = 3.14159265;
float line(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }
void main() {
  vec3 d = normalize((vec4(normalize(vView), 0.0) * viewMatrix).xyz); // the look direction, world space
  vec3 a = uM * d; // ...in the cockpit's frame
  for (int k = 0; k < 3; k++) { // drawn after the scene without its depth: where the HUD's body or the indexers beside it hide the glass from the eye, nothing (ray / box tests)
    vec3 inv = 1.0 / (vPart - uEye), t0 = (uBoxC[k] - uBoxH[k] - uEye) * inv, t1 = (uBoxC[k] + uBoxH[k] - uEye) * inv, lo = min(t0, t1), hi = max(t0, t1);
    float tn = max(max(lo.x, lo.y), lo.z), tf = min(min(hi.x, hi.y), hi.z); if (tf > max(tn, 0.0) && tn < 1.0) discard; }
  float az = atan(a.x, -a.z) * D, el = atan(a.y, length(a.xz)) * D, aa = max(fwidth(az), fwidth(el)) * 0.75;
  float s = 0.0, h = 0.0; // the symbology, and a halo round it (from a blurrier mip level)
  vec2 cu = vec2((az + ${AZ.toFixed(1)}) / ${(2 * AZ).toFixed(1)}, (el - (${(EL0 - EL).toFixed(2)})) / ${(2 * EL).toFixed(1)});
  if (cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) { cu.y = 1.0 - cu.y; s = texture(uDyn, cu).r; h = texture(uDyn, cu, 2.5).r; } // (the canvas unflipped: its top row first)
  // the ladder, as a real HUD draws it: straight rungs in the HUD's own field, the field turned back by the bank (cos /
  // sin of uRoll) and slid by the pitch, a pitch line every 5 degrees. Past the vertical (over the top of a loop) the
  // lines continue the other way round (180 - p, mirrored): nothing pinches or spins near straight up or down.
  { float cr = cos(uRoll), sr = sin(uRoll), lu0 = az * cr + el * sr, pl = uPitch * D - az * sr + el * cr;
    if (pl > 90.0) { pl = 180.0 - pl; lu0 = -lu0; } else if (pl < -90.0) { pl = -180.0 - pl; lu0 = -lu0; }
    if (abs(lu0) < ${LADW.toFixed(1)}) { vec2 lu = vec2(lu0 / ${(2 * LADW).toFixed(1)} + 0.5, (pl + 90.0) / 180.0); s = max(s, texture(uLad, lu).r); h = max(h, texture(uLad, lu, 2.5).r); } }
  // the heading scale, as the F-16's in NAV: fixed in the HUD (it banks with the jet, it does not turn with the world),
  // 3 degrees of heading to one, a caret over it at the nose's heading; it sits low in the HUD (rides with the flight path
  // marker with the gear down: uTapeEl)
  { float b = uTapeEl - 0.6; // (the band's foot)
    if (el > b && el < b + 1.2 && abs(az) < 4.6) { vec2 tu = vec2((uHdgN * D + az * 3.0) / 360.0, (el - b) / 1.2); float fade = 1.0 - smoothstep(3.6, 4.6, abs(az)); s = max(s, texture(uTape, tu).r * fade); h = max(h, texture(uTape, tu, 2.5).r * fade); }
    float cy = el - (b + 1.25); if (cy > 0.0 && cy < 0.4) { float cv = line(abs(az), (0.4 - cy) * 0.55, aa); s = max(s, cv); h = max(h, cv); } }
  vec2 p = vec2(az, el) - uFpm; float r = length(p);
  for (int k = 0; k < 2; k++) { float w = k == 0 ? 0.045 : 0.15;
    float f = line(abs(r - 0.42), w, aa);
    f = max(f, line(abs(p.y), w, aa) * step(0.42, abs(p.x)) * line(abs(p.x) - 0.76, 0.34 + w - 0.045, aa));
    f = max(f, line(abs(p.x), w, aa) * step(0.42, p.y) * line(p.y - 0.6, 0.18 + w - 0.045, aa));
    if (k == 0) s = max(s, f); else h = max(h, f * 0.5); }
  float halo = max(clamp(h * 2.4, 0.0, 1.0) * (1.0 - s) * uHalo, s * 0.7); // (a dark rim round each stroke and the background dimmed under it: green stays green over white cloud and sand)
  if (s < 0.01 && halo < 0.01) discard;
  gl_FragColor = vec4(uCol * uI * s, halo); // (the green added to the picture)
}`;
// the HUD drawn after the tone mapping while the player looks through it from the cockpit (its scene copy: a proxy on
// the same geometry and material, placed where the real one is; the real one moved to a layer the camera skips)
const OV = { mesh: null, t: 0, proxy: null, scene: new THREE.Scene() };
const OV_LAYER = 31;
export function renderHudOverlay(renderer, camera, target) {
  const m = OV.mesh; if (!m) return;
  if (performance.now() - OV.t > 300 || !m.parent) { m.layers.set(0); OV.mesh = null; return; } // (left the cockpit: back in the scene)
  if (!OV.proxy || OV.proxy.userData.of !== m) { if (OV.proxy) OV.scene.remove(OV.proxy); OV.proxy = new THREE.Mesh(m.geometry, m.material); OV.proxy.matrixAutoUpdate = false; OV.proxy.userData.of = m; OV.proxy.onBeforeRender = m.onBeforeRender; OV.proxy.frustumCulled = false; OV.scene.add(OV.proxy); }
  m.updateMatrixWorld(); OV.proxy.matrix.copy(m.matrixWorld);
  const U = m.material.uniforms, i0 = U.uI.value, h0 = U.uHalo.value, dt0 = m.material.depthTest, ac = renderer.autoClear, prev = renderer.getRenderTarget();
  const c0 = U.uCol.value.clone(); U.uCol.value.copy(GREEN_OUT); U.uI.value = 1.0; U.uHalo.value = 0.5; m.material.depthTest = false; // (display space: green as is)
  const ar = renderer.info.autoReset; renderer.info.autoReset = false; // (keep the frame's draw counts)
  renderer.setRenderTarget(target); renderer.autoClear = false; renderer.render(OV.scene, camera);
  renderer.info.autoReset = ar; renderer.autoClear = ac; renderer.setRenderTarget(prev); U.uCol.value.copy(c0); U.uI.value = i0; U.uHalo.value = h0; m.material.depthTest = dt0;
}
const _m3 = new THREE.Matrix3(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
// the HUD on a quad (geo, in the part's own coordinates) for a LivePanel lp (its hook redraws the canvas)
// occluders: up to three boxes [cx, cy, cz, hx, hy, hz] (part coordinates) that hide the glass's foot from the eye (the HUD's body, things beside it)
export function collimatedHud(lp, parent, geo, { intensity = 2.2, px = 512, hz = 10, occluders = [] } = {}) {
  const box = (i, o) => new THREE.Vector3(...(occluders[i] || [0, -100, 0, 0, 0, 0]).slice(o, o + 3));
  const cv = document.createElement('canvas'); cv.width = cv.height = px; const ctx = cv.getContext('2d'), dyn = new THREE.CanvasTexture(cv);
  dyn.anisotropy = 8; dyn.minFilter = THREE.LinearMipmapLinearFilter; dyn.flipY = false; // (its rows as the canvas has them: a field is uploaded on its own)
  const U = { uLad: { value: ladderTex() }, uTape: { value: tapeTex() }, uDyn: { value: dyn }, uM: { value: new THREE.Matrix3() }, uN: { value: new THREE.Vector3(1, 0, 0) }, uPitch: { value: 0 }, uRoll: { value: 0 }, uHdgN: { value: 0 }, uTapeEl: { value: -4.6 }, uFpm: { value: new THREE.Vector2() }, uCol: { value: GREEN.clone() }, uI: { value: intensity }, uHalo: { value: 0.3 }, uEye: { value: new THREE.Vector3() }, uBoxC: { value: [0, 1, 2].map((i) => box(i, 0)) }, uBoxH: { value: [0, 1, 2].map((i) => box(i, 3)) } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, fog: false, opacity: 0.3 }); // (opacity: unused by the shader; it marks the quad see-through, as glass, for stations.js' line of sight)
  const mesh = new THREE.Mesh(geo, mat); mesh.userData.live = lp; mesh.userData.near = true; mesh.userData.keepShape = true; mesh.castShadow = false; mesh.renderOrder = 2;
  let north = 0;
  const _inv = new THREE.Matrix4();
  mesh.onBeforeRender = (r, sc, cam) => { // the cockpit's orientation, from its world matrix: into its frame, and its heading; the eye in it
    U.uEye.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv.copy(mesh.matrixWorld).invert());
    const e = mesh.matrixWorld.elements; _m3.setFromMatrix4(mesh.matrixWorld);
    for (let c = 0; c < 3; c++) { const L = Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]) || 1; for (let r2 = 0; r2 < 3; r2++) _m3.elements[c * 3 + r2] /= L; }
    U.uM.value.copy(_m3).transpose();
    // the heading: from the horizontal square to the nose (forward x up), held where it was within ~3 degrees of the
    // vertical (undefined there)
    _v.set(-e[8], -e[9], -e[10]).normalize(); _n.set(-_v.z, 0, _v.x); const L = _n.length();
    if (L > 0.05) U.uN.value.copy(_n.divideScalar(L));
    const n = U.uN.value; U.uHdgN.value = Math.atan2(n.z, n.x) + north;
    // pitch and bank of the nose (the bank, at the very top of a loop, flips with the pitch's other side: continuous)
    _r.set(e[0], e[1], e[2]).normalize(); _u.set(e[4], e[5], e[6]).normalize(); U.uPitch.value = Math.asin(Math.max(-1, Math.min(1, _v.y))); U.uRoll.value = Math.atan2(-_r.y, _u.y); // (the heading: the horizontal square to that axis, the nose's way)
  };
  const draw = hudFields(ctx, dyn, px);
  draw(REST);
  let t = 1e9;
  lp.hook((S, dt) => {
    north = (S.north || 0) * Math.PI / 180; U.uFpm.value.set(Math.max(-6.5, Math.min(6.5, S.fpmAz)), Math.max(-8, Math.min(4.5, S.fpmEl)));
    U.uTapeEl.value = S.gearDown && S.gearMove === 0 && S.hasRetract ? Math.max(-5.2, Math.min(-1.5, U.uFpm.value.y - 3.0)) : -4.6; // (gear down: under the flight path marker)
    if ((t += dt) >= 1 / hz) { t = 0; draw(S); }
    OV.mesh = mesh; OV.t = performance.now(); mesh.layers.set(OV_LAYER); // (seen from the cockpit: drawn after the tone mapping)
  });
  parent.add(mesh); return mesh;
}
// what is drawn fixed to the aircraft (white on black: the shader takes red as the symbology's brightness), 32 texels a
// degree: strokes about a tenth of a degree, a real HUD's thin lines. In fields, each redrawn and uploaded (its own
// rectangle of the canvas) only when what it shows changed: a number ticking over sends a few kilobytes, not the canvas.
// Sizes: over a degree for the numbers, larger than an F-16's so they read on a screen with a 90 degree view.
const FIELDS = [ // [what, az, el (the rectangle's centre), width, height (degrees), key, draw]
  ['kt', -5.2, -0.6, 3.6, 2.0, (S) => Math.round(S.kt), (f, S) => { f.box(-5.2, -0.6, 3.2, 1.6); f.T(String(Math.round(S.kt)), -5.2, -0.6); }],
  ['alt', 4.85, -0.6, 5.0, 2.0, (S) => Math.round(S.alt / 10), (f, S) => { const ft = Math.max(0, Math.round(S.alt / 10) * 10); f.box(4.85, -0.6, 4.6, 1.6); f.T(ft >= 1000 ? `${Math.floor(ft / 1000)},${String(ft % 1000).padStart(3, '0')}` : String(ft), 4.85, -0.6, 1.15); }],
  ['g', -5.6, 1.5, 3.0, 1.5, (S) => (S.g || 0).toFixed(1), (f, S) => f.T((S.g || 0).toFixed(1), -6.8, 1.5, 1.05, 'left')],
  ['mach', -5.6, -2.6, 3.0, 1.4, (S) => (S.mach || 0).toFixed(2), (f, S) => f.T(`${(S.mach || 0).toFixed(2)}`, -6.8, -2.6, 1.0, 'left')],
  ['gmax', -5.6, -4.0, 3.0, 1.4, (S) => (S.gMax || 1).toFixed(1), (f, S) => f.T((S.gMax || 1).toFixed(1), -6.8, -4.0, 1.0, 'left')],
  ['vs', 5.4, -2.6, 3.6, 1.4, (S) => Math.round(S.vs / 10), (f, S) => f.T(`${S.vs >= 0 ? '' : '-'}${Math.abs(Math.round(S.vs / 10) * 10)}`, 7.1, -2.6, 1.0, 'right')], // (vertical speed, ft/min)
  ['gun', 0, 0.2, 1.4, 1.4, () => 1, (f) => { const { c, X, Y, k } = f, gx = X(0), gy = Y(0.2), L = k * 0.55; c.beginPath(); c.moveTo(gx - L, gy); c.lineTo(gx - L * 0.3, gy); c.moveTo(gx + L * 0.3, gy); c.lineTo(gx + L, gy); c.moveTo(gx, gy - L); c.lineTo(gx, gy - L * 0.3); c.moveTo(gx, gy + L * 0.3); c.lineTo(gx, gy + L); c.stroke(); }], // (the gun cross on the boresight)
  ['warn', 0, 3.7, 7.0, 2.8, (S) => `${S.stall}${S.ab}${(S.g || 1) > 7.5}`, (f, S) => { if (S.stall) f.T('STALL', 0, 3.0, 1.2); else if (S.ab) f.T('AB', 0, 3.0, 1.05); if ((S.g || 1) > 7.5) f.T('OVER G', 0, 4.4, 1.2); }],
];
// (the fields uploaded together: the left column, the right, the middle)
const GROUP = { kt: 0, g: 0, mach: 0, gmax: 0, alt: 1, vs: 1, gun: 2, warn: 2 };
// the canvas and its texture (not flipped: a field's rows go up as they are); returns update(S): redraws and uploads the
// fields that changed
function hudFields(c, tex, W) {
  const X = (az) => ((az + AZ) / (2 * AZ)) * W, Y = (el) => (1 - (el - (EL0 - EL)) / (2 * EL)) * W, k = W / (2 * AZ); // (px per degree)
  const f = { c, X, Y, k,
    T: (s, az, el, deg = 1.2, al = 'center') => { c.font = `600 ${Math.round(k * deg)}px Helvetica, Arial, sans-serif`; c.textAlign = al; c.textBaseline = 'middle'; c.fillText(s, X(az), Y(el)); },
    box: (az, el, w, h) => c.strokeRect(Math.round(X(az - w / 2)) + 0.5, Math.round(Y(el + h / 2)) + 0.5, Math.round(w * k), Math.round(h * k)) };
  const rects = FIELDS.map(([, az, el, w, h]) => { const x0 = Math.max(0, Math.floor(X(az - w / 2))), y0 = Math.max(0, Math.floor(Y(el + h / 2))); return [x0, y0, Math.min(W, Math.ceil(X(az + w / 2))) - x0, Math.min(W, Math.ceil(Y(el - h / 2))) - y0]; });
  const last = FIELDS.map(() => null);
  c.fillStyle = '#000'; c.fillRect(0, 0, W, W);
  return (S) => {
    const R = liveRenderer(), direct = R && R.properties.get(tex).__webglTexture && tex.version > 0; let n = 0; const up = [];
    FIELDS.forEach(([name, , , , , key, draw], i) => {
      const kk = key(S); if (kk === last[i]) return; last[i] = kk;
      const [x0, y0, w, h] = rects[i]; c.save(); c.fillStyle = '#000'; c.fillRect(x0, y0, w, h); c.beginPath(); c.rect(x0, y0, w, h); c.clip();
      c.strokeStyle = c.fillStyle = '#fff'; c.lineWidth = Math.max(1.5, k * 0.11); c.lineJoin = 'miter'; draw(f, S); c.restore();
      if (direct) { const g = up[GROUP[name]] ||= [W, W, 0, 0], [x0, y0, w, h] = rects[i]; g[0] = Math.min(g[0], x0); g[1] = Math.min(g[1], y0); g[2] = Math.max(g[2], x0 + w); g[3] = Math.max(g[3], y0 + h); } else n++;
    });
    const gs = up.filter(Boolean); gs.forEach(([x0, y0, x1, y1], i) => uploadRegion(R, c.canvas, tex, x0, y0, x1 - x0, y1 - y0, i === gs.length - 1)); // (the changed fields, gathered by where they are on the canvas: a few uploads, the mip levels rebuilt once)
    if (n) { tex.needsUpdate = true; liveStats.bytes += W * W * 4; liveStats.uploads++; }
  };
}
