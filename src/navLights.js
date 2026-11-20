// Running lights for any vehicle: red (left) / green (right) wingtip position lights, a white tail light, white
// anti-collision strobes (double flash) on the wingtips, red beacons pulsing on top of and under the fuselage, and
// landing lights with a faint beam (plus, for the player's plane at night, a real spot light that throws a pool of
// light on the runway). Helicopters get a searchlight, cars head- and tail-lights.
//
// Where the lamps go is worked out from the assembled model (lightLayout): the outermost points of the wings, the
// rearmost point near the centreline, the top and belly of the body over the wing, the wing's leading edge inboard.
// Every lamp of one vehicle is one THREE.Points draw (all vehicles share one material): additive glow sprites, depth
// tested, with a minimum size in pixels so they stay visible kilometres away like real position lights, and HDR
// brightness that blooms at night but stays a small coloured dot by day.
//
// The emissive lenses planeMaterials.js puts on wingtips and fins are kept as the physical lamp; the sprites here
// are the light coming out of them. The strobe and beacon timing matches theirs (same clock, same rates).
import * as THREE from 'three';
import { smoothstep } from './noise.js';

// mode: 0 steady (directional: brightest along dir, dimmer behind), 1 strobe (double flash), 2 beacon (red pulse),
// 3 landing / head light (a beam along dir: dazzling head-on, a soft dot from the side)
const L = { NAV: 0, STROBE: 1, BEACON: 2, LAND: 3 };
const RED = [1, 0.035, 0.02], GREEN = [0.05, 1, 0.32], WHITE = [1, 0.97, 0.92], LAMP = [1, 0.93, 0.8], TAIL = [1, 0.06, 0.03];

// Shared by every vehicle's lamps (and refreshed from the scene in onBeforeRender: no flight code has to drive it).
export const NAV_U = { time: { value: 0 }, night: { value: 0 }, vpH: { value: 720 }, pr: { value: 1 }, fogK: { value: 0 } };

const VS = /* glsl */`
  attribute vec3 color; attribute vec4 lamp; attribute vec3 dir; attribute float on;
  uniform float time; uniform float night; uniform float vpH; uniform float pr; uniform float fogK;
  varying vec3 vCol; varying float vI; varying float vCore;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = length(mv.xyz);
    vec3 toCam = -mv.xyz / max(dist, 1e-4);
    float d = dot(normalize(mat3(modelViewMatrix) * dir), toCam);
    float mode = lamp.x, size = lamp.y, power = lamp.z, ph = lamp.w;
    float I = power, grow = 1.0;
    if (mode < 0.5) { // position light: covers its side and the front; seen from behind it is dimmer
      I *= mix(0.3, 1.0, smoothstep(-0.55, 0.05, d));
    } else if (mode < 1.5) { // strobe: two short white flashes every 1.3 s (the first one with the lens flash)
      float t = fract((time + ph) / 1.3);
      float f = step(t, 0.045) + step(0.11, t) * step(t, 0.15);
      I *= f; grow = 1.0 + 0.4 * f;
    } else if (mode < 2.5) { // rotating red beacon
      I *= 0.06 + pow(max(0.0, sin((time + ph) * 5.6)), 10.0);
    } else { // landing light: a beam; head-on it dazzles
      float b = max(d, 0.0);
      I *= 0.015 + smoothstep(-0.1, 0.4, d) * (0.1 + 1.2 * pow(b, 5.0) + 3.0 * pow(b, 40.0)); // a lamp in the leading edge: nothing from behind
      grow = 1.0 + 1.5 * pow(b, 12.0);
    }
    I *= on * exp(-dist * fogK);
    // brighter and with a wide halo at night; a small coloured dot by day
    I *= mix(0.35, 1.0, night);
    vCol = color; vI = I; vCore = mix(0.55, 0.3, night);
    // pull the sprite towards the camera so the lamp isn't swallowed by the wingtip it sits on
    mv.xyz += toCam * min(0.4, dist * 0.3);
    gl_Position = projectionMatrix * mv;
    float px = size * grow * mix(0.6, 1.0, night) * projectionMatrix[1][1] * vpH * 0.5 / max(dist, 0.1);
    float minPx = (mode > 0.5 && mode < 1.5 ? 9.0 : 5.0) * pr * mix(0.7, 1.0, night);
    gl_PointSize = I > 0.001 ? clamp(max(px, minPx), 1.0, 300.0) : 0.0;
    // far away the lamp is held at a minimum size, all core: real position lights read as bright points for miles
    float far = 1.0 - clamp(px / minPx, 0.0, 1.0);
    vCore = mix(vCore, 0.75, far); vI = min(vI * (1.0 + 0.5 * far), mix(20.0, 8.0, far)); // (but no blocky bloom off a tiny over-bright dot)
  }`;
const FS = /* glsl */`
  varying vec3 vCol; varying float vI; varying float vCore;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
    if (r2 > 1.0 || vI < 0.001) discard;
    float core = exp(-r2 / (vCore * vCore * 0.06)), halo = exp(-r2 * 5.0) * (1.0 - r2);
    vec3 col = vCol * vI * (core * 1.5 + halo * 0.5) + vec3(1.0) * vI * core * 0.5; // the hot centre goes white
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

let _mat = null;
function lampMaterial() {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({ uniforms: NAV_U, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  return _mat;
}
// Refresh the shared uniforms from what is being drawn (once a frame is plenty; it is cheap anyway).
const _sz = new THREE.Vector2();
function tick(renderer, scene) {
  NAV_U.time.value = performance.now() / 1000;
  const k = scene?.userData?.nightK;
  NAV_U.night.value = k ?? 1 - smoothstep(0.32, 0.6, scene?.environmentIntensity ?? 1);
  renderer.getDrawingBufferSize(_sz); NAV_U.vpH.value = _sz.y; NAV_U.pr.value = renderer.getPixelRatio();
  NAV_U.fogK.value = scene?.fog?.density ? scene.fog.density * 0.6 : 0;
}

// A faint cone of light in the air in front of a landing light / searchlight (fake volumetric: brightest along the
// axis and near the lamp, soft at the edges, gone where it would be seen end-on).
const BEAM_VS = /* glsl */`
  varying float vT; varying float vEdge; varying float vPhase;
  void main() {
    vT = uv.y; // 0 at the lamp, 1 at the far end
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal), toCam = normalize(-mv.xyz);
    vEdge = abs(dot(n, toCam));
    // haze scatters light forwards: the beam glows when it points at you, and is barely there from behind
    float c = dot(normalize(mat3(modelViewMatrix) * vec3(0.0, 0.0, 1.0)), toCam);
    vPhase = 0.12 + 2.0 * pow(0.5 + 0.5 * c, 4.0);
    gl_Position = projectionMatrix * mv;
  }`;
const BEAM_FS = /* glsl */`
  uniform float k; uniform vec3 col;
  varying float vT; varying float vEdge; varying float vPhase;
  void main() {
    float a = k * vPhase * pow(1.0 - vT, 2.2) * smoothstep(0.0, 0.08, vT) * pow(vEdge, 3.0);
    gl_FragColor = vec4(col * a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
let _beamGeo = null;
function beamGeometry() { // unit cone along +z: apex at the origin, 1 long, radius 1 at the far end
  if (_beamGeo) return _beamGeo;
  const g = new THREE.CylinderGeometry(1, 0.02, 1, 20, 1, true);
  // CylinderGeometry: uv.y 1 at the top (+y). Put the apex (top) at the origin and the open end at +z.
  g.translate(0, -0.5, 0); g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return (_beamGeo = g);
}

// ---------------- where the lamps go ----------------
const _m = new THREE.Matrix4(), _p = new THREE.Vector3();
// Sampled vertex positions (root space) of the meshes under obj: skips glass, prop discs and the lamps themselves.
function points(obj, inv, out, tag) {
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.isDisc || o.userData.planeLight || o.material?.transparent) return;
    const a = o.geometry?.attributes?.position; if (!a) return;
    _m.multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(a.count / 3000));
    for (let i = 0; i < a.count; i += step) { _p.fromBufferAttribute(a, i).applyMatrix4(_m); out.push(_p.x, _p.y, _p.z, tag); }
  });
}
// pts: flat [x, y, z, tag, ...]. Returns the stats of the points passing filter f.
function scan(pts, f) {
  const r = { n: 0, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], sum: [0, 0, 0], at: { min: [], max: [] } };
  for (let i = 0; i < pts.length; i += 4) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2]; if (!f(x, y, z, pts[i + 3])) continue;
    r.n++; const v = [x, y, z];
    for (let k = 0; k < 3; k++) {
      r.sum[k] += v[k];
      if (v[k] < r.min[k]) { r.min[k] = v[k]; r.at.min[k] = [x, y, z, pts[i + 3]]; }
      if (v[k] > r.max[k]) { r.max[k] = v[k]; r.at.max[k] = [x, y, z, pts[i + 3]]; }
    }
  }
  r.mean = r.sum.map((s) => s / Math.max(1, r.n));
  return r;
}

// Lamps for a vehicle built from parts. parts: [{ obj, d (the PARTS def), i (part index) }], all under root.
// kind: 'plane' | 'heli' | 'car' | 'bike' (default: guessed from the parts). Returns [{ mode, pos, dir, color, size, power, part }].
export function lightLayout(root, parts, kind) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const wing = [], body = [], all = [], eng = [];
  for (const p of parts) {
    const c = p.d?.cat;
    if (c === 'wing') points(p.obj, inv, wing, p.i);
    if (c === 'fuselage' || c === 'cockpit') points(p.obj, inv, body, p.i);
    if (c === 'wing' || c === 'tail' || c === 'fuselage' || c === 'cockpit' || (c === 'extra' && !p.d.light) || (c === 'bike' && !p.d.gear && !p.d.engine)) points(p.obj, inv, all, p.i); // (bike frames: a bike's lamps)
    else if (c === 'engine') points(p.obj, inv, eng, p.i);
  }
  if (!all.length) return [];
  kind = kind || (parts.some((p) => p.d?.engine?.type === 'rotor') ? 'heli' : parts.some((p) => p.d?.engine?.type === 'drive') && !wing.length ? 'car' : 'plane');
  const A = scan(all, () => true), out = [];
  out.box = new THREE.Box3(new THREE.Vector3(...A.min), new THREE.Vector3(...A.max));
  if (eng.length) { const E = scan(eng, () => true); out.box.expandByPoint(new THREE.Vector3(...E.min)).expandByPoint(new THREE.Vector3(...E.max)); } // (props reach past the nose)
  const B = body.length ? scan(body, () => true) : A;
  const len = A.max[2] - A.min[2], add = (mode, pos, dir, color, size, power, part) => out.push({ mode, pos: new THREE.Vector3(...pos), dir: new THREE.Vector3(...dir).normalize(), color, size, power, part });
  const S = Math.max(1, Math.cbrt((A.max[0] - A.min[0]) * len * (A.max[1] - A.min[1]) / 30)); // ~1 for a light plane, ~3 for an airliner

  if (kind === 'bike') { // a motorbike: one headlight at the front of its nose and a tail light at the back, on the centreline
    const H = A.max[1] - A.min[1], mid = (x) => Math.abs(x - (A.max[0] + A.min[0]) / 2) < 0.12;
    const F = scan(all, (x, y) => mid(x) && y > A.min[1] + H * 0.35), R = scan(all, (x) => mid(x));
    if (F.n) { const p = F.at.min[2]; add(L.LAND, [p[0], p[1], p[2] - 0.03], [0, -0.03, -1], LAMP, 0.7, 6, p[3]); }
    if (R.n) { const p = R.at.max[2]; add(L.NAV, [p[0], p[1], p[2] + 0.03], [0, 0, 1], TAIL, 0.5, 2, p[3]); }
    return out;
  }
  if (kind === 'car') { // head- and tail-lights at the corners of the body
    const hw = (A.max[0] - A.min[0]) / 2, xc = (A.max[0] + A.min[0]) / 2, y = A.min[1] + (A.max[1] - A.min[1]) * 0.45;
    for (const s of [-1, 1]) {
      add(L.LAND, [xc + s * hw * 0.7, y, A.min[2] - 0.05], [0, -0.01, -1], LAMP, 0.9, 7, -1);
      add(L.NAV, [xc + s * hw * 0.7, y + 0.05, A.max[2] + 0.05], [0, 0, 1], TAIL, 0.7, 2.5, -1);
    }
    return out;
  }
  // position lights: the outermost points of the main wings (or of the body when there are no wings)
  const W = wing.length ? wing : body.length ? body : all, WS = scan(W, () => true);
  const span = WS.max[0] - WS.min[0];
  for (const s of [1, -1]) {
    const xe = s > 0 ? WS.max[0] : WS.min[0];
    const tip = scan(W, (x) => (s > 0 ? x > xe - span * 0.03 : x < xe + span * 0.03));
    const part = (s > 0 ? WS.at.max[0] : WS.at.min[0])[3];
    const chord = tip.max[2] - tip.min[2];
    const y = tip.mean[1], z = wing.length ? tip.min[2] + chord * 0.3 : tip.mean[2];
    add(L.NAV, [xe + s * 0.06 * S, y, z], [s, 0, -1.2], s > 0 ? GREEN : RED, 0.9 * S, 4.5, part);
    if (kind === 'plane') add(L.STROBE, [xe + s * 0.04 * S, y, Math.min(tip.max[2], z + chord * 0.35 + 0.1)], [0, 0, -1], WHITE, 1.4 * S, 10, part);
  }
  // tail light: the rearmost point near the centreline
  const cw = Math.max(0.35, (B.max[0] - B.min[0]) * 0.3);
  const T = scan(all, (x) => Math.abs(x) < cw);
  if (T.n) {
    const tail = scan(all, (x, y, z) => Math.abs(x) < cw && z > T.max[2] - 0.12 * S);
    add(L.NAV, [0, tail.mean[1], T.max[2] + 0.06 * S], [0, 0.1, 1], WHITE, 0.45 * S, 1.6, T.at.max[2][3]);
  }
  // beacons on top of and under the body, over the wing (or the middle of the body)
  if (body.length) {
    const zw = wing.length ? WS.mean[2] : B.mean[2], bl = B.max[2] - B.min[2], bw = Math.max(0.15, (B.max[0] - B.min[0]) * 0.18);
    const zr = THREE.MathUtils.clamp(zw + bl * 0.08, B.min[2] + bl * 0.2, B.max[2] - bl * 0.2);
    const win = scan(body, (x, y, z) => Math.abs(x) < bw && Math.abs(z - zr) < Math.max(0.3, bl * 0.06));
    if (win.n) {
      add(L.BEACON, [0, win.max[1] + 0.08 * S, win.at.max[1][2]], [0, 1, 0], RED, 1.4 * S, 6, win.at.max[1][3]);
      out.at(-1).phase = 0;
      add(L.BEACON, [0, win.min[1] - 0.08 * S, win.at.min[1][2]], [0, -1, 0], RED, 1.4 * S, 6, win.at.min[1][3]);
      out.at(-1).phase = 0.56;
    }
  }
  // landing lights: the wing's leading edge a quarter of the way out (or under the nose: helicopters' searchlight)
  if (wing.length && kind === 'plane') {
    for (const s of [1, -1]) {
      const x0 = WS.mean[0] + s * span * 0.16;
      const st = scan(wing, (x) => Math.abs(x - x0) < span * 0.025);
      if (!st.n) continue;
      const le = scan(wing, (x, y, z) => Math.abs(x - x0) < span * 0.025 && z < st.min[2] + 0.06 * S);
      add(L.LAND, [x0, le.mean[1] - 0.04 * S, st.min[2] - 0.05 * S], [0, -0.1, -1], LAMP, 1.3 * S, 7, st.at.min[2][3]);
    }
  } else {
    const nose = scan(B === A ? all : body, (x) => Math.abs(x) < cw), y = nose.min[1] + (nose.max[1] - nose.min[1]) * 0.15;
    const zf = scan(B === A ? all : body, (x, yy) => Math.abs(x) < cw && yy < y + 0.2 * S);
    add(L.LAND, [0, y - 0.05 * S, (zf.n ? zf.min[2] : nose.min[2]) + 0.3 * S], kind === 'heli' ? [0, -0.6, -1] : [0, -0.1, -1], LAMP, 1.3 * S, 7, nose.at.min[2]?.[3] ?? -1);
  }
  return out;
}

// Lamps for a hand-built helicopter (traffic.js): position lights on the cabin sides (side: half-width), red beacons
// on top and underneath, a white tail light and a searchlight under the nose. Positions in the model's frame.
export function heliLamps({ side, top, belly, tail, nose }) {
  const l = (mode, pos, dir, color, size, power, phase = 0) => ({ mode, pos: new THREE.Vector3(...pos), dir: new THREE.Vector3(...dir).normalize(), color, size, power, part: -1, phase });
  return [l(L.NAV, [side, 0, -0.3], [1, 0, -1.2], GREEN, 0.9, 4.5), l(L.NAV, [-side, 0, -0.3], [-1, 0, -1.2], RED, 0.9, 4.5),
    l(L.BEACON, top, [0, 1, 0], RED, 1.4, 6), l(L.BEACON, belly, [0, -1, 0], RED, 1.4, 6, 0.56), l(L.NAV, tail, [0, 0.1, 1], WHITE, 0.45, 1.6),
    l(L.LAND, nose, [0, -0.6, -1], LAMP, 1.3, 7)];
}

// ---------------- the lamps on one vehicle ----------------
// NavLights(root, lights, opts): lights from lightLayout (or hand-made). opts.phase: offsets this vehicle's flash
// timing (traffic shouldn't all blink in step); opts.spot: a real SpotLight for the landing lights (the player's
// plane, at night only: adding a light to the scene later would recompile every shader).
export class NavLights {
  constructor(root, lights, { phase = 0, spot = null, spotPower = 12000, beams = true } = {}) {
    this.root = root; this.lights = lights; this.land = 0;
    const n = lights.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), lamp = new Float32Array(n * 4), dir = new Float32Array(n * 3);
    this.on = new Float32Array(n);
    lights.forEach((l, i) => {
      l.pos.toArray(pos, i * 3); l.dir.toArray(dir, i * 3); col.set(l.color, i * 3);
      lamp.set([l.mode, l.size, l.power, (l.phase || 0) + phase], i * 4);
      this.on[i] = l.mode === L.LAND ? 0 : 1;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('lamp', new THREE.BufferAttribute(lamp, 4)); g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('on', new THREE.BufferAttribute(this.on, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); // never culled (the lamps outshine the model's bounds)
    this.points = new THREE.Points(g, lampMaterial());
    this.points.frustumCulled = false; this.points.renderOrder = 5; this.points.onBeforeRender = tick;
    root.add(this.points);
    // beams in front of the landing lights
    this.beams = [];
    if (beams) for (const l of lights) if (l.mode === L.LAND) {
      const m = new THREE.ShaderMaterial({ uniforms: { k: { value: 0 }, col: { value: new THREE.Color(...l.color) } }, vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
      const b = new THREE.Mesh(beamGeometry(), m), Lb = 70 * Math.sqrt(l.size), R = Lb * 0.2;
      b.scale.set(R, R, Lb); b.position.copy(l.pos); b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), l.dir); b.visible = false; b.renderOrder = 4;
      b.userData.light = l; root.add(b); this.beams.push(b);
    }
    // the real light: one spot between the landing lights (shadows off)
    this.spot = spot;
    if (spot) {
      const ls = lights.filter((l) => l.mode === L.LAND);
      const c = ls.reduce((a, l) => a.add(l.pos), new THREE.Vector3()).divideScalar(Math.max(1, ls.length));
      const d = ls[0]?.dir.clone() ?? new THREE.Vector3(0, -0.1, -1);
      if (lights.box) c.z = Math.min(c.z, lights.box.min.z - 0.5); // out in front of the nose: it must not light up its own plane
      if (spot.parent !== root) root.add(spot);
      spot.position.copy(c); spot.target.position.copy(c).addScaledVector(d.clone().setY(d.y - 0.03).normalize(), 50);
      if (spot.target.parent !== root) root.add(spot.target);
      spot.castShadow = false; spot.color.set(0xfff0d8); spot.angle = 0.3; spot.penumbra = 0.6; spot.decay = 1.6; spot.distance = 1600; spot.intensity = 0;
      this.spotPower = spotPower;
    }
  }
  // land: 0..1 landing lights; alive(i): is part i still attached?; dead: all off; night: 0..1 (for the spot and beams)
  update(dt, { land = this.land, alive = null, dead = false, night = NAV_U.night.value } = {}) {
    this.land += (land - this.land) * Math.min(1, dt * 4);
    let dirty = false;
    this.lights.forEach((l, i) => {
      const v = dead || (alive && l.part >= 0 && !alive(l.part)) ? 0 : l.mode === L.LAND ? this.land : 1;
      if (Math.abs(this.on[i] - v) > 0.004 || (v !== this.on[i] && (v === 0 || v === 1))) { this.on[i] = v; dirty = true; }
    });
    if (dirty) this.points.geometry.attributes.on.needsUpdate = true;
    for (const b of this.beams) {
      const i = this.lights.indexOf(b.userData.light), haze = THREE.MathUtils.clamp(NAV_U.fogK.value / 2.7e-5, 1, 4); // murk shows the beam
      const k = this.on[i] * night * (0.05 + 0.03 * haze);
      b.material.uniforms.k.value = k; b.visible = k > 0.002;
    }
    if (this.spot) {
      const lit = this.lights.some((l, i) => l.mode === L.LAND && this.on[i] > 0) ? this.land : 0;
      this.spot.intensity = this.spotPower * lit * night;
    }
  }
  dispose() {
    this.root.remove(this.points, ...this.beams); this.points.geometry.dispose();
    for (const b of this.beams) b.material.dispose();
    if (this.spot) this.root.remove(this.spot, this.spot.target);
  }
}

// ---------------- hooks ----------------
// The lamps for an Aircraft (the player's, or another player's). spot: give it a real landing light (night flights).
export function aircraftLights(ac, { spot = false, phase = 0 } = {}) {
  const parts = ac.parts.map((p) => ({ obj: p.obj, d: p.d, i: p.i }));
  const kind = ac.isHeli ? 'heli' : ac.isBike ? 'bike' : ac.isCar && !parts.some((p) => p.d.cat === 'wing') ? 'car' : 'plane';
  const lights = lightLayout(ac.root, parts, kind);
  let sl = null;
  if (spot) sl = ac.landingLight || new THREE.SpotLight(0xfff0d8, 0);
  // (low lamps light the ground close by: a car's headlights and a helicopter's searchlight are much weaker than an airliner's)
  const nl = new NavLights(ac.root, lights, { phase, spot: sl, spotPower: kind === 'car' || kind === 'bike' ? 900 : kind === 'heli' ? 1500 : 12000 });
  nl.ac = ac; nl.kind = kind; nl.aglT = 0; nl.agl = 0; nl.byI = new Map(ac.parts.map((p) => [p.i, p]));
  return nl;
}
// Per frame for an Aircraft: landing lights on with the gear down (retractable gear) or low (below ~300 m), headlights
// on a car after dark; everything off on a wreck. env: anything with groundAt(x, z).
export function updateAircraftLights(nl, dt, env) {
  if (!nl?.ac) return;
  const ac = nl.ac;
  nl.aglT -= dt;
  if (nl.aglT <= 0 && env?.groundAt) { nl.aglT = 0.3; nl.agl = ac.x.y - (env.groundAt(ac.x.x, ac.x.z)?.h ?? 0); }
  const low = nl.agl < 300, night = NAV_U.night.value;
  const land = nl.kind === 'car' || nl.kind === 'bike' ? (night > 0.3 ? 1 : 0) : (ac.hasRetract && ac.gearDown) || low ? 1 : 0;
  nl.update(dt, { land, dead: ac.dead, alive: (i) => nl.byI.get(i)?.alive !== false, night });
}
