// A collimated head-up display (the fighter's HUD): green symbology on the combiner glass that sits at infinity, as a
// real HUD's does: each fragment of the glass looks up what is drawn in the direction from the eye through it, so the
// pitch ladder lies on the real horizon and the flight path marker on where the aircraft is going wherever the head is.
//   - world-referenced (in the shader, every frame, no texture upload): the horizon line and the pitch ladder (a
//     texture laid out by elevation and by azimuth off the nose's heading: rolling, it turns with the world), the
//     heading tape along the top (a strip of the compass, slid by the heading), the flight path marker (a ring
//     with wings where the velocity points)
//   - fixed to the aircraft (a small canvas redrawn ~10 times a second while it is watched): airspeed and altitude
//     boxes, Mach, g and the peak g, the gun cross, the heading caret, warnings
// One draw call (the glass's quad), a few dozen ALU ops per fragment of it. The uniforms come from the mesh's own
// world matrix in onBeforeRender, so it is right in the hangar and on other players' jets too; the numbers and the
// flight path marker only move on the player's own aircraft (liveDisplays: seen from the cockpit).
// Angles in degrees: az right of the nose, el up from it (in the cockpit part's frame, -Z forward, +Y up).
import * as THREE from 'three';
import { REST } from './liveDisplays.js';

const AZ = 8, EL0 = -1.8, EL = 8; // the canvas' half-width and its centre's elevation and half-height
const LADW = 16; // the ladder texture's half-width (degrees of azimuth)
let _lad = null, _tape = null;
// the pitch ladder by elevation (-90 at the bottom .. 90 at the top) and azimuth (-LADW .. LADW): the horizon line, and
// a rung every 5 degrees (solid above, dashed below, the ends turned towards the horizon), numbered
function ladderTex() {
  if (_lad) return _lad;
  const W = 512, H = 2048, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const X = (az) => W / 2 + (az / LADW) * (W / 2), Y = (el) => (1 - (el + 90) / 180) * H;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'butt';
  g.lineWidth = 3; g.beginPath(); g.moveTo(X(-LADW), Y(0)); g.lineTo(X(-1.4), Y(0)); g.moveTo(X(1.4), Y(0)); g.lineTo(X(LADW), Y(0)); g.stroke();
  g.font = 'bold 12px monospace'; g.textBaseline = 'middle';
  for (let p = -85; p <= 85; p += 5) {
    if (!p) continue; const y = Y(p), tick = (p > 0 ? 1 : -1) * 0.45 * (H / 180); g.lineWidth = 2.4; g.setLineDash(p < 0 ? [10, 7] : []);
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(X(s * 3.6), y + tick); g.lineTo(X(s * 3.6), y); g.lineTo(X(s * 0.9), y); g.stroke(); }
    g.setLineDash([]); const t = String(Math.abs(p)), ax = (W / (2 * LADW)) / (H / 180); // (texels per degree across / along: the numbers drawn wider so they come out square)
    for (const [x0, al] of [[X(3.9), 'left'], [X(-3.9), 'right']]) { g.save(); g.translate(x0, y); g.scale(ax, 1); g.textAlign = al; g.fillText(t, 0, 0); g.restore(); }
  }
  for (const p of [-90, 90]) { g.lineWidth = 2.4; g.beginPath(); g.arc(X(0), Y(p) + (p > 0 ? 10 : -10), 9, 0, 7); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return (_lad = t);
}
// the heading tape: 0..360 degrees across, ticks every 5, numbered every 10 (tens of degrees, as the F-16's), in a
// band one degree tall
function tapeTex() {
  if (_tape) return _tape;
  const W = 4096, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = g.fillStyle = '#fff'; g.lineWidth = 3; g.font = 'bold 30px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const sq = (W / 360) * 3 / (H / 1.2); // (texels per HUD degree across (the tape shows 3 degrees of heading per degree) / up the 1.2 degree band: the numbers squeezed to come out square)
  for (let d = 0; d < 360; d += 5) { const x = (d / 360) * W; g.beginPath(); g.moveTo(x, H); g.lineTo(x, d % 10 ? H - 14 : H - 24); g.stroke(); if (!(d % 10)) { const s = String(d / 10).padStart(2, '0'); for (const xx of x < 60 ? [x, x + W] : [x]) { g.save(); g.translate(xx, 20); g.scale(sq, 1); g.fillText(s, 0, 0); g.restore(); } } }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4; return (_tape = t);
}

const VERT = /* glsl */`
varying vec3 vView;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const FRAG = /* glsl */`
uniform sampler2D uLad, uTape, uDyn; uniform mat3 uM; uniform float uHdg, uHdgN, uI; uniform vec2 uFpm; uniform vec3 uCol;
varying vec3 vView;
const float D = 57.29578, PI = 3.14159265;
float line(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }
void main() {
  vec3 d = normalize((vec4(normalize(vView), 0.0) * viewMatrix).xyz); // the look direction, world space
  vec3 a = uM * d; // ...in the cockpit's frame
  float az = atan(a.x, -a.z) * D, el = atan(a.y, length(a.xz)) * D, aa = max(fwidth(az), fwidth(el)) * 0.75;
  float s = 0.0;
  vec2 cu = vec2((az + ${AZ.toFixed(1)}) / ${(2 * AZ).toFixed(1)}, (el - (${(EL0 - EL).toFixed(2)})) / ${(2 * EL).toFixed(1)});
  if (cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) s = texture2D(uDyn, cu).r;
  float wel = asin(clamp(d.y, -1.0, 1.0)) * D, waz = atan(d.x, -d.z) - uHdg; waz = (mod(waz + PI, 2.0 * PI) - PI) * D;
  if (abs(waz) < ${LADW.toFixed(1)}) s = max(s, texture2D(uLad, vec2(waz / ${(2 * LADW).toFixed(1)} + 0.5, (wel + 90.0) / 180.0)).r);
  if (el > 2.0 && el < 3.2 && abs(az) < 4.6) s = max(s, texture2D(uTape, vec2((uHdgN * D + az * 3.0) / 360.0, (el - 2.0) / 1.2)).r * (1.0 - smoothstep(3.6, 4.6, abs(az))));
  vec2 p = vec2(az, el) - uFpm; float r = length(p), w = 0.06;
  float f = line(abs(r - 0.42), w, aa);
  f = max(f, line(abs(p.y), w, aa) * step(0.42, abs(p.x)) * line(abs(p.x) - 0.76, 0.34, aa));
  f = max(f, line(abs(p.x), w, aa) * step(0.42, p.y) * line(p.y - 0.6, 0.18, aa));
  s = max(s, f);
  if (s < 0.03) discard;
  gl_FragColor = vec4(uCol * uI * s, s * 0.7); // (the sky behind dimmed a little where the symbology is: it reads against a bright sky)
}`;
const _m3 = new THREE.Matrix3(), _v = new THREE.Vector3();
// the HUD on a quad (geo, in the part's own coordinates) for a LivePanel lp (its hook redraws the canvas)
export function collimatedHud(lp, parent, geo, { color = 0x48ff6e, intensity = 1.8, px = 320, hz = 10 } = {}) {
  const cv = document.createElement('canvas'); cv.width = cv.height = px; const ctx = cv.getContext('2d'), dyn = new THREE.CanvasTexture(cv);
  const U = { uLad: { value: ladderTex() }, uTape: { value: tapeTex() }, uDyn: { value: dyn }, uM: { value: new THREE.Matrix3() }, uHdg: { value: 0 }, uHdgN: { value: 0 }, uFpm: { value: new THREE.Vector2() }, uCol: { value: new THREE.Color(color) }, uI: { value: intensity } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
  const mesh = new THREE.Mesh(geo, mat); mesh.userData.live = lp; mesh.userData.near = true; mesh.userData.keepShape = true; mesh.castShadow = false; mesh.renderOrder = 2;
  let north = 0;
  mesh.onBeforeRender = () => { // the cockpit's orientation, from its world matrix: into its frame, and its heading
    const e = mesh.matrixWorld.elements; _m3.setFromMatrix4(mesh.matrixWorld);
    for (let c = 0; c < 3; c++) { const L = Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]) || 1; for (let r2 = 0; r2 < 3; r2++) _m3.elements[c * 3 + r2] /= L; }
    U.uM.value.copy(_m3).transpose();
    _v.set(-e[8], -e[9], -e[10]); U.uHdg.value = Math.atan2(_v.x, -_v.z); U.uHdgN.value = U.uHdg.value + north;
  };
  const draw = (S) => { hudCanvas(ctx, S, px); dyn.needsUpdate = true; };
  draw(REST);
  let t = 1e9;
  lp.hook((S, dt) => { north = (S.north || 0) * Math.PI / 180; U.uFpm.value.set(Math.max(-6.5, Math.min(6.5, S.fpmAz)), Math.max(-8, Math.min(4.5, S.fpmEl))); if ((t += dt) >= 1 / hz) { t = 0; draw(S); } });
  parent.add(mesh); return mesh;
}
// what is drawn fixed to the aircraft (white on black: the shader takes red as the symbology's brightness)
function hudCanvas(c, S, W) {
  const X = (az) => ((az + AZ) / (2 * AZ)) * W, Y = (el) => (1 - (el - (EL0 - EL)) / (2 * EL)) * W, k = W / (2 * AZ); // (px per degree)
  c.fillStyle = '#000'; c.fillRect(0, 0, W, W); c.strokeStyle = c.fillStyle = '#fff'; c.lineWidth = Math.max(1.5, k * 0.09);
  const T = (s, az, el, deg = 0.75, al = 'center') => { c.font = `bold ${Math.round(k * deg)}px monospace`; c.textAlign = al; c.textBaseline = 'middle'; c.fillText(s, X(az), Y(el)); };
  const box = (az, el, w, h) => c.strokeRect(X(az - w / 2), Y(el + h / 2), w * k, h * k);
  // airspeed (knots) left, altitude (feet) right, in boxes; Mach and the peak g under the speed, g over it
  box(-5.4, -0.6, 2.6, 1.1); T(String(Math.round(S.kt)), -5.4, -0.6);
  const ft = Math.max(0, Math.round(S.alt / 10) * 10); box(5.3, -0.6, 3.0, 1.1); T(ft >= 1000 ? `${Math.floor(ft / 1000)},${String(ft % 1000).padStart(3, '0')}` : String(ft), 5.3, -0.6);
  T((S.g || 0).toFixed(1), -6.6, 1.2, 0.7, 'left'); T(`${(S.mach || 0).toFixed(2)}`, -6.6, -2.1, 0.62, 'left'); T((S.gMax || 1).toFixed(1), -6.6, -3.1, 0.62, 'left');
  T(`${S.vs >= 0 ? '' : '-'}${Math.abs(Math.round(S.vs / 10) * 10)}`, 6.6, -2.1, 0.55, 'right'); // (vertical speed, ft/min)
  // the gun cross on the boresight; the heading tape's caret under the tape
  const gx = X(0), gy = Y(0.2), L = k * 0.55; c.beginPath(); c.moveTo(gx - L, gy); c.lineTo(gx - L * 0.3, gy); c.moveTo(gx + L * 0.3, gy); c.lineTo(gx + L, gy); c.moveTo(gx, gy - L); c.lineTo(gx, gy - L * 0.3); c.moveTo(gx, gy + L * 0.3); c.lineTo(gx, gy + L); c.stroke();
  c.beginPath(); c.moveTo(X(0), Y(1.95)); c.lineTo(X(-0.25), Y(1.55)); c.lineTo(X(0.25), Y(1.55)); c.closePath(); c.fill();
  // warnings
  if (S.stall) T('STALL', 0, -4.6, 0.9); else if (S.ab) T('AB', 0, -4.6, 0.7); if ((S.g || 1) > 7.5) T('OVER G', 0, -5.6, 0.9);
}
