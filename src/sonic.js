// Supersonic and heat effects for one aircraft (ours or a remote player's):
// vapour cone in the transonic band, sonic boom shock rings, shock diamonds in afterburner/rocket flames,
// skin glowing red -> orange -> white-hot with speed (leading edges first), plasma sheath at very high Mach,
// and screen-space heat shimmer segments for post.js. Visual only: nothing here causes damage.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { clamp } from './noise.js';
import { FOG } from './shaders.js';

const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _white = new THREE.Color(1, 1, 1), _violet = new THREE.Color(2.0, 0.6, 2.4), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);

// Bell-shaped collar around the aircraft: local +Y runs from the front edge (0) to the back (1).
let _cone;
function coneGeometry() {
  if (_cone) return _cone;
  const prof = [[0.5, 0], [0.74, 0.07], [0.9, 0.22], [0.98, 0.45], [1.02, 0.72], [1.05, 1]];
  _cone = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 40);
  return _cone;
}
const shellVert = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vUv = uv; vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const shellFrag = /* glsl */`
  uniform float uI; uniform float uT; uniform vec3 uCol; uniform float uPlasma;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p, float per) { // value noise, periodic in x (around the cone)
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hash(vec2(mod(i.x, per), i.y)), b = hash(vec2(mod(i.x + 1.0, per), i.y));
    float c = hash(vec2(mod(i.x, per), i.y + 1.0)), d = hash(vec2(mod(i.x + 1.0, per), i.y + 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    float v = vUv.y;
    vec2 q = vec2(vUv.x * 28.0, v * 5.0 - uT * 9.0);
    float n = 0.6 * vnoise(q, 28.0) + 0.4 * vnoise(q * 2.0 + 7.0, 56.0);
    float front = smoothstep(0.0, 0.04 + 0.06 * n, v);
    float back = pow(clamp(1.0 - v - 0.25 * n * v, 0.0, 1.0), mix(2.2, 2.6, uPlasma));
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float al = uI * front * back * (0.35 + 0.9 * n) * (0.55 + 0.45 * rim) * (1.0 + 1.4 * exp(-v * 10.0));
    gl_FragColor = vec4(uCol * (0.85 + 0.25 * n), clamp(al, 0.0, 1.0));
  }`;
function shellMaterial(additive) {
  return new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uT: { value: 0 }, uCol: { value: new THREE.Color(1, 1, 1) }, uPlasma: { value: additive ? 1 : 0 } },
    vertexShader: shellVert, fragmentShader: shellFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

// Expanding ring left behind by the sonic boom.
let _ring;
function ringGeometry() { return (_ring ||= new THREE.RingGeometry(0.55, 1, 72, 1)); }
const ringFrag = /* glsl */`
  uniform float uA; varying float vR;
  void main() {
    float band = smoothstep(0.55, 0.96, vR) * smoothstep(1.0, 0.965, vR);
    gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), band * uA);
  }`;
const ringVert = /* glsl */`
  varying float vR;
  void main() { vR = length(position.xy); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Shock diamonds: a row of bright knots inside a flame cone (engine-local, along +Z behind the nozzle).
function diamondGeometry(flame) {
  const p = flame.geometry.parameters, rc = p.radius, h = p.height, z0 = flame.position.z - h / 2;
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const s = rc * (0.78 - 0.1 * k), g = new THREE.SphereGeometry(1, 12, 6);
    g.scale(s, s, s * 0.55); g.translate(0, 0, z0 + h * (0.1 + 0.17 * k)); parts.push(g); // flattened "Mach disks"
  }
  const m = mergeGeometries(parts); parts.forEach((g) => g.dispose()); return m;
}
const ringMat = () => new THREE.ShaderMaterial({ name: 'sonicRing', uniforms: { uA: { value: 0 } }, vertexShader: ringVert, fragmentShader: ringFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide });
const diamondMat = () => new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.5, 2.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });

// Hot-skin glow: patched copy of a lit material. Kinetic heating peaks where the air stagnates, so each fragment gets
// its own temperature: surfaces facing into the airflow (nose cone, rounded wing/tail leading edges, intake lips) run
// near the full skin temperature, the nose region is hottest of all, and the heat falls off along the body and on
// faces turned away from the flow, where the paint stays visible. Colour is a cheap black-body ramp in HDR, so only
// the hottest spots get bright enough to catch the bloom.
const HEAT_GLSL = /* glsl */`
  uniform vec3 uHeatFwd; uniform vec3 uHeatAxis; uniform vec3 uHeatNose; uniform float uHeatLen; uniform float uHeatC; uniform float uHeatAmb;
  varying vec3 vHeatW;
  // temperature (°C) -> emitted HDR radiance: invisible below ~450, dull red, orange, yellow, white-hot
  vec3 heatRadiance(float T) {
    float k = smoothstep(350.0, 1250.0, T), t = clamp((T - 450.0) / 1000.0, 0.0, 1.0);
    vec3 c = vec3(1.0, 0.06 + 0.8 * pow(t, 1.35), 0.015 + 0.65 * pow(max(t - 0.45, 0.0) * 1.8, 1.6));
    return c * (pow(k, 1.5) * 8.5 + k * 0.3);
  }`;
function heatMaterial(mat, U) {
  const m = mat.clone();
  m.userData.heat = true;
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey(); // keep the skin's own hook (panel skin, livery)
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, FOG); // the global height-fog hook this replaces
    sh.uniforms.uHeatFwd = U.fwd; sh.uniforms.uHeatAxis = U.axis; sh.uniforms.uHeatNose = U.nose; sh.uniforms.uHeatLen = U.len; sh.uniforms.uHeatC = U.c; sh.uniforms.uHeatAmb = U.amb;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeatW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n#ifdef USE_BATCHING\nvHeatW = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;\n#else\nvHeatW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HEAT_GLSL)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float heatHot = 0.0;
        if (uHeatC > 150.0) {
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          float stag = smoothstep(-0.15, 0.8, dot(wn, uHeatFwd));                 // facing into the airflow
          float a = clamp(dot(vHeatW - uHeatNose, -uHeatAxis) / uHeatLen, 0.0, 1.0); // 0 at the nose, 1 at the tail
          float nose = exp(-a * 4.0);
          float e = max(stag * (1.0 - 0.35 * a), nose) + 0.3 * (1.0 - a) * (1.0 - a);
          float T = uHeatAmb + (uHeatC - uHeatAmb) * clamp(0.4 + 0.6 * e, 0.0, 1.0);
          // scorched dark and dull where hot (no glossy sky reflections), so the glow reads even on white paint
          heatHot = 0.96 * smoothstep(250.0, 700.0, T);
          diffuseColor.rgb *= 1.0 - heatHot;
          roughnessFactor = mix(roughnessFactor, 0.85, heatHot); metalnessFactor *= 1.0 - heatHot;
          totalEmissiveRadiance += heatRadiance(T);
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - heatHot;
        #endif`);
  };
  m.customProgramCacheKey = () => 'skyheat2|' + prevKey;
  return m;
}
export function keepHeatPatch(from, to) { // aircraft.damage() clones materials when scorching
  if (!from.userData?.heat) return;
  to.onBeforeCompile = from.onBeforeCompile; to.customProgramCacheKey = from.customProgramCacheKey;
}

export class SonicFX {
  constructor(ac, scene) {
    this.ac = ac; this.scene = scene; this.t = 0;
    this.armed = false; this.best = Math.floor(ac.mach || 0); this.rings = []; this.onBoom = null; this.onMilestone = null;
    // body-frame extent (relative to the centre of mass)
    let minZ = 1e9, maxZ = -1e9, span = 0.5, hgt = 0.5;
    for (const p of ac.parts) for (const h of p.hull) { const r = _v.copy(h).sub(ac.com); minZ = Math.min(minZ, r.z); maxZ = Math.max(maxZ, r.z); span = Math.max(span, Math.abs(r.x)); hgt = Math.max(hgt, Math.abs(r.y)); }
    if (minZ > maxZ) { minZ = -ac.radius; maxZ = ac.radius; }
    this.minZ = minZ; this.maxZ = maxZ; this.len = Math.max(2, maxZ - minZ); this.span = span; this.hgt = hgt;
    // heat glow uniforms (shared by the whole plane)
    this.U = { fwd: { value: new THREE.Vector3(0, 0, -1) }, axis: { value: new THREE.Vector3(0, 0, -1) }, nose: { value: new THREE.Vector3() }, len: { value: this.len }, c: { value: 15 }, amb: { value: 15 } };
    const done = new Map(); // one heat copy per material for the whole plane (not per part: then parts can share draw calls, acBatch.js)
    for (const p of ac.parts) {
      p.obj.traverse((o) => {
        if (!o.isMesh || !o.material?.isMeshStandardMaterial || o.material.transparent) return;
        if (!done.has(o.material)) done.set(o.material, heatMaterial(o.material, this.U));
        o.material = done.get(o.material);
      });
    }
    // vapour cone + plasma sheath
    this.vapour = new THREE.Mesh(coneGeometry(), shellMaterial(false)); this.vapour.frustumCulled = false; this.vapour.visible = false; this.vapour.renderOrder = 2;
    this.plasma = new THREE.Mesh(coneGeometry(), shellMaterial(true)); this.plasma.frustumCulled = false; this.plasma.visible = false; this.plasma.renderOrder = 3;
    // a boom's shock rings are made when it happens; this hidden one is here from the start so the loading screen's
    // warm-up compiles their shader and the boom shows at once (#273: events are never held back)
    this.ringWarm = new THREE.Mesh(ringGeometry(), ringMat()); this.ringWarm.visible = false; this.ringWarm.frustumCulled = false;
    scene.add(this.vapour, this.plasma, this.ringWarm);
    // shock diamonds in every flame
    this.diamonds = [];
    for (const p of ac.parts) {
      const e = p.engine; if (!e?.flame?.geometry?.parameters?.height) continue;
      const d = new THREE.Mesh(diamondGeometry(e.flame), diamondMat()); d.visible = false; d.frustumCulled = false;
      e.flame.parent.add(d); this.diamonds.push({ p, d });
    }
    this.vapourI = 0; this.plasmaI = 0;
  }

  // dt: game seconds. ctx: { effects, world }
  update(dt, ctx) {
    const ac = this.ac; this.t += dt;
    const dead = ac.dead || !ac.root.visible;
    const air = ac.airFx ?? 1; // near-vacuum: no shock waves, no condensation, no plasma
    const M = dead ? 0 : (ac.mach || 0), C = ac.skinC ?? 15, V = ac.v.length();
    // airflow direction (world); never zero so the shaders can't produce NaN
    if (V > 1) this.U.fwd.value.copy(ac.v).divideScalar(V);
    this.U.c.value = dead ? -300 : C; this.U.amb.value = Math.min(C, 15);
    this.U.axis.value.set(0, 0, -1).applyQuaternion(ac.q);
    this.U.nose.value.copy(ac.x).addScaledVector(this.U.axis.value, -this.minZ);
    // --- sonic boom ---
    if (dead) this.armed = false; // (re)appearing already supersonic (e.g. a remote player) is not a boom
    else if (air < 0.05) { /* nothing to boom in (and no Mach milestones) */ }
    else if (M < 0.95) this.armed = true;
    else if (M >= 1 && this.armed) { this.armed = false; this.boom(ctx); }
    const whole = Math.floor(M);
    if (whole > this.best && air >= 0.05) { if (whole >= 2) this.onMilestone?.(whole); this.best = whole; }
    // --- vapour cone: humid low air makes the thickest clouds ---
    const W = ctx.world?.W, hum = clamp(0.4 + 0.6 * (1 - ac.x.y / 7000) + (W?.rain || 0) * 0.3 + (W?.cover || 0) * 0.15, 0.35, 1.2);
    const band = smooth(0.86, 0.97, M) * (1 - smooth(1.04, 1.16, M));
    this.vapourI += (band * hum * air - this.vapourI) * Math.min(1, dt * 8);
    const fwd = _v.copy(this.U.fwd.value);
    _q.setFromUnitVectors(_Y, _v2.copy(fwd).negate());
    if (this.vapourI > 0.01 && !dead) {
      const m = this.vapour, R = Math.max(this.span * 0.62, this.hgt * 1.6), L = this.len * 0.42;
      m.visible = true; m.quaternion.copy(_q); m.scale.set(R, L, R);
      m.position.copy(ac.x).addScaledVector(fwd, Math.min(this.len * 0.15, -this.minZ * 0.5));
      const u = m.material.uniforms; u.uI.value = this.vapourI * 0.95; u.uT.value = this.t;
      if (ctx.world?.clouds) u.uCol.value.copy(ctx.world.clouds.uniforms.litColor.value).lerp(_white, 0.6).multiplyScalar(1.15);
      // streaming condensation off the wings
      if (ctx.effects && Math.random() < this.vapourI * 1.5) {
        const parts = ac.parts.filter((p) => p.alive && p.surfaces.length);
        const p = parts[Math.floor(Math.random() * parts.length)], s = p?.surfaces[Math.floor(Math.random() * p.surfaces.length)];
        if (s) ctx.effects.puff(ac.worldPoint(s.pos), _v2.copy(ac.v).multiplyScalar(0.93), { color: [1, 1, 1], s0: 1.2, s1: 3.5, life: 0.35, a: 0.45 * this.vapourI, drag: 0.5, grav: 0 });
      }
    } else this.vapour.visible = false;
    // --- plasma sheath (very high Mach / white-hot) ---
    const pl = dead ? 0 : Math.max(smooth(4.2, 6, M), smooth(950, 1500, C) * smooth(3, 4, M)) * air;
    this.plasmaI += (pl - this.plasmaI) * Math.min(1, dt * 4);
    if (this.plasmaI > 0.01) {
      const m = this.plasma, R = Math.max(this.span * 0.45, this.hgt * 1.6), L = this.len * 0.9;
      m.visible = true; m.quaternion.copy(_q); m.scale.set(R, L, R);
      m.position.copy(ac.x).addScaledVector(fwd, -this.minZ + 0.6);
      const u = m.material.uniforms; u.uT.value = this.t; u.uI.value = this.plasmaI * (0.4 + 0.08 * Math.sin(this.t * 37));
      u.uCol.value.setRGB(2.4, 0.9 + 0.3 * Math.sin(this.t * 3), 0.35).lerp(_violet, smooth(5.5, 9, M));
    } else this.plasma.visible = false;
    // --- shock diamonds ---
    for (const { p, d } of this.diamonds) {
      const f = p.engine.flame, on = p.alive && !dead && f.visible ? f.material.opacity : 0;
      const k = on * (0.45 + 0.55 * smooth(0.6, 1.4, M)) * (0.85 + Math.random() * 0.3);
      d.visible = k > 0.03; d.material.opacity = Math.min(1, k * 1.2);
    }
    // --- boom rings ---
    for (const r of this.rings) {
      r.t += dt; const k = Math.max(0, r.t) / r.life; r.m.position.addScaledVector(r.vel, dt);
      r.m.scale.setScalar(r.r0 + r.grow * k ** 0.55);
      r.m.material.uniforms.uA.value = r.t < 0 ? 0 : 0.6 * (1 - k) ** 1.5 * Math.min(1, r.t * 12);
    }
    this.rings = this.rings.filter((r) => { if (r.t < r.life) return true; this.scene.remove(r.m); r.m.material.dispose(); return false; });
  }

  boom(ctx) {
    const ac = this.ac, fwd = this.U.fwd.value;
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
    for (const [delay, grow] of [[0, 140], [0.14, 110]]) { // bow and tail shock: the double "ba-boom"
      const m = new THREE.Mesh(ringGeometry(), ringMat());
      m.position.copy(ac.x).addScaledVector(ac.v, -delay); m.quaternion.copy(_q); m.frustumCulled = false; m.renderOrder = 2;
      const r0 = Math.max(this.span, 3) * 1.2; m.scale.setScalar(r0);
      // the shock is dragged along with the plane and slides back past the chase camera
      this.scene.add(m); this.rings.push({ m, t: -delay, life: 1.6, r0, grow, vel: ac.v.clone().multiplyScalar(0.86) });
    }
    if (ctx.effects) { // a burst of condensation blown outwards in a ring
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      a.copy(fwd).cross(Math.abs(fwd.y) < 0.9 ? _Y : new THREE.Vector3(1, 0, 0)).normalize(); b.copy(fwd).cross(a);
      const R = Math.max(this.span, 3);
      for (let i = 0; i < 28; i++) {
        const th = (i / 28) * Math.PI * 2, dir = _v2.copy(a).multiplyScalar(Math.cos(th)).addScaledVector(b, Math.sin(th));
        const p = ac.x.clone().addScaledVector(dir, R);
        ctx.effects.puff(p, dir.clone().multiplyScalar(35 + Math.random() * 20).addScaledVector(ac.v, 0.6), { color: [1, 1, 1], s0: 3, s1: 11, life: 1.3, a: 0.5, drag: 1.4, grav: 0 });
      }
    }
    this.onBoom?.(ac.x.clone(), ac.v.clone());
  }

  // Heat-haze segments in screen space for post.shimmer(): behind hot exhausts and around a hot nose.
  shimmer(camera, out = []) {
    const ac = this.ac; out.length = 0;
    if (ac.dead || !ac.root.visible) return out;
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), segs = [], cf = camera.getWorldDirection(_v2.set(0, 0, -1)).clone();
    const add = (p0, p1, rWorld, s) => {
      if (s < 0.02) return;
      // both ends well in front of the camera, or the projection blows up across the whole screen
      const d0 = _v.copy(p0).sub(camera.position).dot(cf), d1 = _v.copy(p1).sub(camera.position).dot(cf);
      if (d0 < rWorld * 3 + 2 || d1 < rWorld * 3 + 2) return;
      const a = p0.clone().project(camera), b = p1.clone().project(camera);
      const r = (rWorld / (Math.min(d0, d1) * tanH)) * 0.5;
      if (r < 0.003 || r > 0.25 || Math.hypot(a.x - b.x, a.y - b.y) > 1.2) return;
      segs.push({ a: [a.x * 0.5 + 0.5, a.y * 0.5 + 0.5], b: [b.x * 0.5 + 0.5, b.y * 0.5 + 0.5], r, s: Math.min(1, s) });
    };
    for (const p of ac.parts) {
      const e = p.engine; if (!p.alive || !e || (e.type !== 'jet' && e.type !== 'rocket')) continue;
      const hot = e.type === 'rocket' ? (e.burning ? 1 : 0) : (e.spoolT || 0) * 0.55 + (e.abOn ? 0.45 : 0);
      if (hot < 0.05) continue;
      const rad = Math.max(0.3, Math.max(p.size.x, p.size.y) * 0.5);
      const nozzle = ac.worldPoint(_v.copy(e.pos).addScaledVector(e.dir, -p.size.z * 0.5));
      const tail = ac.worldPoint(_v.copy(e.pos).addScaledVector(e.dir, -p.size.z * 0.5 - rad * (5 + 6 * hot)));
      add(nozzle, tail, rad * 1.4, hot);
    }
    const nose = smooth(60, 500, ac.skinC ?? 0);
    if (nose > 0) { const f = this.U.fwd.value; const n0 = ac.x.clone().addScaledVector(f, -this.minZ); add(n0.clone().addScaledVector(f, -this.len * 0.1), n0.clone().addScaledVector(f, -this.len * 0.7), Math.max(this.span, 2) * 0.7, nose * 0.8); }
    segs.sort((x, y) => y.s * y.r - x.s * x.r);
    for (const s of segs.slice(0, 4)) out.push(s);
    return out;
  }

  dispose() {
    this.scene.remove(this.vapour, this.plasma, this.ringWarm);
    this.vapour.material.dispose(); this.plasma.material.dispose(); this.ringWarm.material.dispose(); this.ringWarm.geometry.dispose();
    for (const r of this.rings) { this.scene.remove(r.m); r.m.material.dispose(); }
    for (const { d } of this.diamonds) { d.parent?.remove(d); d.geometry.dispose(); d.material.dispose(); }
    this.rings = [];
  }
}
