// A collimated head-up display (the fighter's HUD): green symbology on the combiner glass that sits at infinity, as a
// real HUD's does: each fragment of the glass looks up what is drawn in the direction from the eye through it, so the
// pitch ladder lies on the real horizon and the flight path marker on where the aircraft is going wherever the head is.
//   - world-referenced (in the shader, every frame, no texture upload): the horizon line and the pitch ladder (a
//     texture laid out by elevation and by azimuth off the nose's heading: rolling, it turns with the world), the
//     heading tape along the top (a strip of the compass, 3 degrees of heading to one of the HUD, slid by the
//     heading), the flight path marker (a ring with wings where the velocity points)
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
import { REST } from './liveDisplays.js';

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
uniform sampler2D uLad, uTape, uDyn; uniform mat3 uM; uniform float uHdg, uHdgN, uI, uHalo; uniform vec2 uFpm; uniform vec3 uCol, uEye, uBoxC[3], uBoxH[3];
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
  if (cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) { s = texture(uDyn, cu).r; h = texture(uDyn, cu, 2.5).r; }
  float wel = asin(clamp(d.y, -1.0, 1.0)) * D, waz = atan(d.x, -d.z) - uHdg; waz = (mod(waz + PI, 2.0 * PI) - PI) * D;
  if (abs(waz) < ${LADW.toFixed(1)}) { vec2 lu = vec2(waz / ${(2 * LADW).toFixed(1)} + 0.5, (wel + 90.0) / 180.0); s = max(s, texture(uLad, lu).r); h = max(h, texture(uLad, lu, 2.5).r); }
  if (el > 2.0 && el < 3.2 && abs(az) < 4.6) { vec2 tu = vec2((uHdgN * D + az * 3.0) / 360.0, (el - 2.0) / 1.2); float fade = 1.0 - smoothstep(3.6, 4.6, abs(az)); s = max(s, texture(uTape, tu).r * fade); h = max(h, texture(uTape, tu, 2.5).r * fade); }
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
const _m3 = new THREE.Matrix3(), _v = new THREE.Vector3();
// the HUD on a quad (geo, in the part's own coordinates) for a LivePanel lp (its hook redraws the canvas)
// occluders: up to three boxes [cx, cy, cz, hx, hy, hz] (part coordinates) that hide the glass's foot from the eye (the HUD's body, things beside it)
export function collimatedHud(lp, parent, geo, { intensity = 2.2, px = 512, hz = 10, occluders = [] } = {}) {
  const box = (i, o) => new THREE.Vector3(...(occluders[i] || [0, -100, 0, 0, 0, 0]).slice(o, o + 3));
  const cv = document.createElement('canvas'); cv.width = cv.height = px; const ctx = cv.getContext('2d'), dyn = new THREE.CanvasTexture(cv);
  dyn.anisotropy = 8; dyn.minFilter = THREE.LinearMipmapLinearFilter;
  const U = { uLad: { value: ladderTex() }, uTape: { value: tapeTex() }, uDyn: { value: dyn }, uM: { value: new THREE.Matrix3() }, uHdg: { value: 0 }, uHdgN: { value: 0 }, uFpm: { value: new THREE.Vector2() }, uCol: { value: GREEN.clone() }, uI: { value: intensity }, uHalo: { value: 0.3 }, uEye: { value: new THREE.Vector3() }, uBoxC: { value: [0, 1, 2].map((i) => box(i, 0)) }, uBoxH: { value: [0, 1, 2].map((i) => box(i, 3)) } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, fog: false, opacity: 0.3 }); // (opacity: unused by the shader; it marks the quad see-through, as glass, for stations.js' line of sight)
  const mesh = new THREE.Mesh(geo, mat); mesh.userData.live = lp; mesh.userData.near = true; mesh.userData.keepShape = true; mesh.castShadow = false; mesh.renderOrder = 2;
  let north = 0;
  const _inv = new THREE.Matrix4();
  mesh.onBeforeRender = (r, sc, cam) => { // the cockpit's orientation, from its world matrix: into its frame, and its heading; the eye in it
    U.uEye.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv.copy(mesh.matrixWorld).invert());
    const e = mesh.matrixWorld.elements; _m3.setFromMatrix4(mesh.matrixWorld);
    for (let c = 0; c < 3; c++) { const L = Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]) || 1; for (let r2 = 0; r2 < 3; r2++) _m3.elements[c * 3 + r2] /= L; }
    U.uM.value.copy(_m3).transpose();
    _v.set(-e[8], -e[9], -e[10]); U.uHdg.value = Math.atan2(_v.x, -_v.z); U.uHdgN.value = U.uHdg.value + north;
  };
  const draw = (S) => { hudCanvas(ctx, S, px); dyn.needsUpdate = true; };
  draw(REST);
  let t = 1e9;
  lp.hook((S, dt) => {
    north = (S.north || 0) * Math.PI / 180; U.uFpm.value.set(Math.max(-6.5, Math.min(6.5, S.fpmAz)), Math.max(-8, Math.min(4.5, S.fpmEl)));
    if ((t += dt) >= 1 / hz) { t = 0; draw(S); }
    OV.mesh = mesh; OV.t = performance.now(); mesh.layers.set(OV_LAYER); // (seen from the cockpit: drawn after the tone mapping)
  });
  parent.add(mesh); return mesh;
}
// what is drawn fixed to the aircraft (white on black: the shader takes red as the symbology's brightness), 32 texels a
// degree: strokes about a tenth of a degree, a real HUD's thin lines
function hudCanvas(c, S, W) {
  const X = (az) => ((az + AZ) / (2 * AZ)) * W, Y = (el) => (1 - (el - (EL0 - EL)) / (2 * EL)) * W, k = W / (2 * AZ); // (px per degree)
  c.fillStyle = '#000'; c.fillRect(0, 0, W, W); c.strokeStyle = c.fillStyle = '#fff'; c.lineWidth = Math.max(1.5, k * 0.11); c.lineJoin = 'miter';
  const T = (s, az, el, deg = 1.2, al = 'center') => { c.font = `600 ${Math.round(k * deg)}px Helvetica, Arial, sans-serif`; c.textAlign = al; c.textBaseline = 'middle'; c.fillText(s, X(az), Y(el)); };
  const box = (az, el, w, h) => c.strokeRect(Math.round(X(az - w / 2)) + 0.5, Math.round(Y(el + h / 2)) + 0.5, Math.round(w * k), Math.round(h * k));
  // airspeed (knots) left, altitude (feet) right, in boxes; Mach and the peak g under the speed, g over it
  // (sizes: over a degree for the numbers, larger than an F-16's so they read on a screen with a 90 degree view)
  box(-5.2, -0.6, 3.2, 1.6); T(String(Math.round(S.kt)), -5.2, -0.6);
  const ft = Math.max(0, Math.round(S.alt / 10) * 10); box(4.85, -0.6, 4.6, 1.6); T(ft >= 1000 ? `${Math.floor(ft / 1000)},${String(ft % 1000).padStart(3, '0')}` : String(ft), 4.85, -0.6, 1.15);
  T((S.g || 0).toFixed(1), -6.8, 1.5, 1.05, 'left'); T(`${(S.mach || 0).toFixed(2)}`, -6.8, -2.6, 1.0, 'left'); T((S.gMax || 1).toFixed(1), -6.8, -4.0, 1.0, 'left');
  T(`${S.vs >= 0 ? '' : '-'}${Math.abs(Math.round(S.vs / 10) * 10)}`, 7.1, -2.6, 1.0, 'right'); // (vertical speed, ft/min)
  // the gun cross on the boresight; the heading tape's caret under the tape
  const gx = X(0), gy = Y(0.2), L = k * 0.55; c.beginPath(); c.moveTo(gx - L, gy); c.lineTo(gx - L * 0.3, gy); c.moveTo(gx + L * 0.3, gy); c.lineTo(gx + L, gy); c.moveTo(gx, gy - L); c.lineTo(gx, gy - L * 0.3); c.moveTo(gx, gy + L * 0.3); c.lineTo(gx, gy + L); c.stroke();
  c.beginPath(); c.moveTo(X(0), Y(1.95)); c.lineTo(X(-0.22), Y(1.6)); c.lineTo(X(0.22), Y(1.6)); c.closePath(); c.fill();
  // warnings
  if (S.stall) T('STALL', 0, -4.4, 1.2); else if (S.ab) T('AB', 0, -4.4, 1.05); if ((S.g || 1) > 7.5) T('OVER G', 0, -5.8, 1.2);
}
