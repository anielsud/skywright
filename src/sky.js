// Physically based sky: a single-scattering atmosphere (Rayleigh + Mie + ozone) baked into a small
// sky-view lookup texture whenever the sun or weather changes. The sky dome, the reflection map,
// and the aerial-perspective fog all read that one texture, so they always agree.
import * as THREE from 'three';
import { FullScreenQuad } from '../vendor/addons/postprocessing/Pass.js';
import { mulberry32 } from './noise.js';
import { MOON_U, MOON_GLSL } from './moon.js';

// Planet / atmosphere in km. Coefficients from Bruneton & Hillaire's Earth presets.
const R0 = 6360, RT = 6460;
const BR = [5.802e-3, 13.558e-3, 33.1e-3], BME = 4.4e-3, OZ = [0.65e-3, 1.881e-3, 0.085e-3];
export const SKY_EXPOSURE = 13; // radiance -> scene units (noon horizon ~ the old fog colour)

// ---- the planet, for flights up to the edge of space (driven by space.js; space = 0 below a few km: nothing here runs) ----
// The Earth is a sphere of radius R0 under the world origin, so the flat local world is its tangent plane there.
// planetCam: the camera in km from the Earth's centre; planetC = |planetCam|² - R0² (computed in doubles on the CPU).
// toEcef turns world directions into Earth-centred axes (z: North Pole, x: lat 0 / lon 0), for the texture lookups.
const _px = new THREE.DataTexture(new Uint8Array([40, 60, 90, 255]), 1, 1); _px.needsUpdate = true;
export const PLANET = {
  space: { value: 0 }, earthDay: { value: _px }, earthLights: { value: _px }, planetCam: { value: new THREE.Vector3(0, R0, 0) }, planetC: { value: 0 },
  toEcef: { value: new THREE.Matrix3() }, cloudCov: { value: 0 }, cloudOff: { value: new THREE.Vector2() }, sunLight: { value: new THREE.Color(1, 1, 1) },
  planetAmb: { value: new THREE.Color(0.05, 0.07, 0.1) },
  gmap: { value: new THREE.Vector3(0, 0, 1) }, // the coarse ground map baked beside the sky: centre x, z and half-size (km)
};
export const PLANET_R = R0;
// A sea of cloud seen from above: the same pattern (world metres, xz) over the local world (space.js) and on the planet,
// so they meet without a seam. Octaves too fine for the pixel are swapped for their average before the threshold,
// so from far away the cover breaks into weather systems instead of turning into a uniform grey film.
export const CLOUD_SEA_GLSL = /* glsl */`
  float cloudSea(sampler2D nt, vec2 p, vec2 off, float cov) {
    float fw = length(fwidth(p)); // metres per pixel: octaves that would alias (and show the texture's tiling) fade out
    // (the noise's R channel has features 1/32 to 1/4 of its tile, G 1/64 to 1/16)
    float n = texture2D(nt, p / 400000.0 + off * 0.05).r * 0.45 + texture2D(nt, p / 90000.0 + off * 0.2).r * 0.35
      + mix(texture2D(nt, p / 20000.0 + off).r, 0.5, smoothstep(250.0, 900.0, fw)) * 0.35
      + mix(texture2D(nt, p / 30000.0 + off * 1.6).g, 0.5, smoothstep(80.0, 300.0, fw)) * 0.25;
    float thr = mix(1.02, 0.42, cov);
    return smoothstep(thr, thr + 0.25, n);
  }`;

// Light on the ground (or a cloud top) from orbit's point of view: sunlight through the air (Rayleigh + a little haze,
// Kasten-Young air mass) plus a dim sky fill. Shared by the planet and the cloud sea so they match.
export const PLANET_LIGHT_GLSL = /* glsl */`
  vec3 planetIrr(float mu, vec3 sunLight, vec3 amb) {
    float am = 1.0 / (max(mu, 0.0) + 0.50572 * pow(max(96.07995 - degrees(acos(clamp(mu, -1.0, 1.0))), 0.01), -1.6364));
    vec3 Ts = exp(-(vec3(${BR.join(', ')}) * 8.0 + 0.0075) * min(am, 40.0));
    return sunLight * Ts * max(mu, 0.0) + amb * smoothstep(-0.15, 0.25, mu);
  }
  // the planet's surface as seen from above, before the air in front of it: imagery under cloud, lit, city lights at night
  vec3 planetShade(vec3 alb, float lights, float cl, float mu, vec3 sunLight, vec3 amb) {
    vec3 surf = mix(alb, vec3(0.8), cl) * planetIrr(mu, sunLight, amb);
    return surf + vec3(1.0, 0.7, 0.4) * lights * lights * (1.0 - smoothstep(-0.12, 0.02, mu)) * (1.0 - cl * 0.85) * 1.2;
  }`;

// Shared lookup: direction -> sky radiance. The table (the first 192 rows) covers the whole sphere, v = 0.5 ± 0.5 sqrt(|elevation|):
// its upper half is exactly the old upper-hemisphere-only table, and skyLook clamps to it as always. skyLookFull also sees
// below the horizon, which matters from high up: the glowing limb, and (alpha) how much light gets through to the ground.
// The rows above hold a coarse map of the planet's lit ground around the camera (groundMap, for flying high: space.js).
const LUT_W = 192, SKY_ROWS = 192, GMAP = 128, LUT_H = SKY_ROWS + GMAP;
export const SKY_LOOKUP_GLSL = /* glsl */`
  const float SKY_V = ${(SKY_ROWS / LUT_H).toFixed(6)}, SKY_VMAX = ${((SKY_ROWS - 0.5) / LUT_H).toFixed(6)}, SKY_VMIN = ${(0.5 / LUT_H).toFixed(6)};
  vec3 skyLook(sampler2D lut, vec3 d) {
    float u = atan(d.z, d.x) * 0.1591549 + 0.5;
    return texture2D(lut, vec2(u, min((0.5 + 0.5 * sqrt(clamp(d.y, 0.0, 1.0))) * SKY_V, SKY_VMAX))).rgb;
  }
  vec4 skyLookFull(sampler2D lut, vec3 d) {
    float u = atan(d.z, d.x) * 0.1591549 + 0.5;
    return texture2D(lut, vec2(u, clamp((0.5 + 0.5 * sign(d.y) * sqrt(min(abs(d.y), 1.0))) * SKY_V, SKY_VMIN, SKY_VMAX)));
  }
  // the planet's lit ground (no air in front) at world position xz (m); gm: the map's centre and half-size, km
  vec3 groundMap(sampler2D lut, vec2 xz, vec3 gm) {
    vec2 g = clamp((xz * 0.001 - gm.xy) / gm.z * 0.5 + 0.5, ${(0.5 / GMAP).toFixed(5)}, ${(1 - 0.5 / GMAP).toFixed(5)});
    return texture2D(lut, vec2(g.x * ${(GMAP / LUT_W).toFixed(6)}, SKY_V + g.y * (1.0 - SKY_V))).rgb;
  }`;

const LUT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform vec3 sunDir; uniform float haze; uniform float exposure; uniform float alt; // alt: camera height, km
  uniform sampler2D earthDay; uniform sampler2D earthLights; uniform sampler2D noiseTex; uniform mat3 toEcef; uniform vec3 gmap;
  uniform vec2 cloudOff; uniform float cloudCov; uniform vec3 sunLight; uniform vec3 planetAmb;
  const float R0 = ${R0.toFixed(1)}; const float RT = ${RT.toFixed(1)};
  const float SKY_V = ${(SKY_ROWS / LUT_H).toFixed(6)};
  ${CLOUD_SEA_GLSL}
  ${PLANET_LIGHT_GLSL}
  const vec3 BR = vec3(${BR.join(', ')}); const float BM = 3.996e-3; const float BME = ${BME}; const vec3 OZ = vec3(${OZ.join(', ')});
  vec2 rs(vec3 o, vec3 d, float r) { float b = dot(o, d); float c = dot(o, o) - r * r; float h = b * b - c; if (h < 0.0) return vec2(-1.0); h = sqrt(h); return vec2(-b - h, -b + h); }
  vec3 dens(float h) { return vec3(exp(-h / 8.0), exp(-h / 1.2) * haze, max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
  vec3 ext(vec3 od) { return exp(-(BR * od.x + BME * od.y + OZ * od.z)); }
  void main() {
    if (vUv.y > SKY_V) { // the ground map: the planet's lit surface around the camera, coarse (see groundMap)
      vec2 g = vec2(vUv.x * ${(LUT_W / GMAP).toFixed(6)}, (vUv.y - SKY_V) / (1.0 - SKY_V));
      if (g.x > 1.0) { gl_FragColor = vec4(0.0); return; }
      vec2 xz = gmap.xy + (g * 2.0 - 1.0) * gmap.z;
      vec3 N = vec3(xz.x, sqrt(max(R0 * R0 - dot(xz, xz), 0.0)), xz.y) / R0, e = toEcef * N;
      vec2 uv = vec2(atan(e.y, e.x) * 0.1591549 + 0.5, asin(clamp(e.z, -1.0, 1.0)) * 0.3183099 + 0.5);
      float cl = cloudSea(noiseTex, xz * 1000.0, cloudOff, cloudCov);
      gl_FragColor = vec4(planetShade(textureLod(earthDay, uv, 0.0).rgb, textureLod(earthLights, uv, 0.0).r, cl, dot(N, sunDir), sunLight, planetAmb), 1.0);
      return;
    }
    float sv = vUv.y / SKY_V * 2.0 - 1.0, y = sign(sv) * sv * sv, c = sqrt(max(0.0, 1.0 - y * y)), az = (vUv.x - 0.5) * 6.2831853;
    vec3 d = vec3(c * cos(az), y, c * sin(az));
    vec3 o = vec3(0.0, R0 + alt, 0.0);
    // from inside the air the march starts at the camera; from space, where the ray enters the atmosphere (if it does)
    vec2 ta = rs(o, d, RT);
    if (ta.y <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float t0 = max(ta.x, 0.0), L = ta.y; vec2 g = rs(o, d, R0); bool ground = g.x > 0.0; if (ground) L = g.x;
    float mu = dot(d, sunDir);
    float pR = 0.0596831 * (1.0 + mu * mu);
    const float gg = 0.8;
    float pM = 0.1193662 * ((1.0 - gg * gg) * (1.0 + mu * mu)) / ((2.0 + gg * gg) * pow(1.0 + gg * gg - 2.0 * gg * mu, 1.5));
    vec3 col = vec3(0.0), od = vec3(0.0); float tp = t0;
    for (int i = 0; i < 32; i++) {
      float f = float(i + 1) / 32.0, t1 = t0 + (L - t0) * f * f, t = 0.5 * (tp + t1), ds = t1 - tp; tp = t1;
      vec3 p = o + d * t; float h = length(p) - R0; vec3 q = dens(h);
      od += q * ds;
      if (rs(p, sunDir, R0).x > 0.0) continue; // in the planet's shadow
      float sl = rs(p, sunDir, RT).y / 8.0; vec3 ods = vec3(0.0);
      for (int j = 0; j < 8; j++) { vec3 ps = p + sunDir * (float(j) + 0.5) * sl; ods += dens(length(ps) - R0) * sl; }
      col += ext(od + ods) * (BR * q.x * pR + BM * q.y * pM) * ds;
    }
    col *= exposure * (ground ? 0.75 : 1.0); // (looking down from high up: a little less veil over the ground, to show it off)
    // the two stand-ins below scale with how much air the ray crosses (1 for every sky ray from the ground; fading out in space)
    float air = min(1.0, od.x / 7.0) * (ground ? 0.5 : 1.0);
    // cheap stand-in for multiple scattering: keeps blue hour blue and the daytime horizon less grey
    float sy = sunDir.y;
    col += vec3(0.22, 0.42, 1.0) * (0.035 * smoothstep(-0.22, 0.0, sy) + 0.07 * smoothstep(0.0, 0.5, sy)) * (0.6 + 0.4 * (1.0 - y)) * (1.0 + haze * 0.15) * air;
    // night: airglow, brighter towards the horizon
    col += vec3(0.0022, 0.0036, 0.0085) * (1.0 + 1.6 * (1.0 - y)) * air;
    // alpha: transmittance (green) down to the ground, for rays that reach it (0 for sky rays)
    gl_FragColor = vec4(col, ground ? ext(od).g : 0.0);
  }`;

export class Atmosphere {
  constructor(renderer, w = LUT_W, h = LUT_H) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.rt.texture.wrapS = THREE.RepeatWrapping; this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = this.rt.texture;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, haze: { value: 1 }, exposure: { value: SKY_EXPOSURE }, alt: { value: 0.6 },
        earthDay: PLANET.earthDay, earthLights: PLANET.earthLights, noiseTex: { value: cloudNoiseTexture() }, toEcef: PLANET.toEcef, gmap: PLANET.gmap,
        cloudOff: PLANET.cloudOff, cloudCov: PLANET.cloudCov, sunLight: PLANET.sunLight, planetAmb: PLANET.planetAmb },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.horizon = new THREE.Color(0.55, 0.67, 0.82); this.zenith = new THREE.Color(0.2, 0.35, 0.7);
    this.alt = 0.6; // km: the camera height the texture shows the sky from (space.js raises it when flying high)
  }
  bake(altKm) {
    const r = this.renderer, prev = r.getRenderTarget();
    this.mat.uniforms.alt.value = altKm; this.bakedAlt = altKm;
    r.setRenderTarget(this.rt); this.quad.render(r); r.setRenderTarget(prev);
  }
  // The CPU-side colours (fog, hemisphere light) are always those of the sky seen from the ground; the texture is
  // then re-baked from the camera's height when that is up high.
  update(sunDir, haze) {
    this.mat.uniforms.sunDir.value.copy(sunDir); this.mat.uniforms.haze.value = haze;
    this.bake(0.6); this.readBack();
    if (this.alt !== 0.6) this.bake(this.alt);
  }
  setAlt(altKm) { this.alt = altKm; if (altKm !== this.bakedAlt) this.bake(altKm); }
  rebake() { this.bake(this.alt); }
  // average horizon and zenith colours for the CPU side (fog colour, clear colour, hemisphere light)
  readBack() {
    const w = this.rt.width, h = SKY_ROWS; // (the sky rows only)
    try {
      const buf = new Uint16Array(w * h * 4);
      this.renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
      const f = THREE.DataUtils.fromHalfFloat;
      const avg = (row, out) => { let r = 0, g = 0, b = 0; for (let x = 0; x < w; x++) { const i = (row * w + x) * 4; r += f(buf[i]); g += f(buf[i + 1]); b += f(buf[i + 2]); } return out.setRGB(r / w, g / w, b / w); };
      const half = h / 2, rowFor = (el) => Math.min(h - 1, half + Math.round(Math.sqrt(Math.sin(el)) * half - 0.5));
      const hz = avg(rowFor(0.035), new THREE.Color()), zn = avg(rowFor(1.3), new THREE.Color());
      if ([hz.r, hz.g, hz.b, zn.r, zn.g, zn.b].every(Number.isFinite)) { this.horizon.copy(hz); this.zenith.copy(zn); this.readOk = true; }
    } catch { this.readOk = false; /* half-float readback unsupported: keep the previous estimate */ }
  }
  // colour of direct sunlight after passing through the air (1,1,1 at noon)
  static sunTransmittance(sunDir, haze = 1, out = new THREE.Color(), altKm = 0.6) {
    const o = [0, R0 + altKm, 0], d = [sunDir.x, Math.max(sunDir.y, -0.5), sunDir.z];
    const b = o[1] * d[1], cG = o[1] ** 2 - R0 * R0, hG = b * b - cG;
    if (hG > 0 && -b - Math.sqrt(hG) > 0) return out.setRGB(0, 0, 0);
    const hT = b * b - (o[1] ** 2 - RT * RT); if (hT <= 0) return out.setRGB(1 / 0.94, 1 / 0.87, 1 / 0.77); // above the air, looking past it
    const t0 = Math.max(0, -b - Math.sqrt(hT)), L = -b + Math.sqrt(hT) - t0, n = 48, ds = L / n; let r = 0, m = 0, z = 0;
    for (let i = 0; i < n; i++) { const t = t0 + (i + 0.5) * ds, h = Math.hypot(d[0] * t, o[1] + d[1] * t, d[2] * t) - R0; r += Math.exp(-h / 8) * ds; m += Math.exp(-h / 1.2) * haze * ds; z += Math.max(0, 1 - Math.abs(h - 25) / 15) * ds; }
    const T = [0, 1, 2].map((c) => Math.exp(-(BR[c] * r + BME * m + OZ[c] * z)));
    return out.setRGB(T[0] / 0.94, T[1] / 0.87, T[2] / 0.77);
  }
  dispose() { this.rt.dispose(); this.mat.dispose(); this.quad.dispose(); }
}

// Tileable noise texture (R: billowy fbm, G: fine fbm, B: cellular): drives the cirrus layer and the overcast deck.
let noiseTex = null;
export function cloudNoiseTexture() {
  if (noiseTex) return noiseTex;
  const S = 256, rnd = mulberry32(911);
  const grads = (P) => { const g = new Float32Array(P * P * 2); for (let i = 0; i < P * P; i++) { const a = rnd() * Math.PI * 2; g[i * 2] = Math.cos(a); g[i * 2 + 1] = Math.sin(a); } return g; };
  const perlin = (x, y, P, g) => { // periodic gradient noise, ~[-0.7, 0.7]
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const dot = (ix, iy, dx, dy) => { const k = (((iy % P) + P) % P) * P + (((ix % P) + P) % P); return g[k * 2] * dx + g[k * 2 + 1] * dy; };
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = dot(xi, yi, xf, yf), b = dot(xi + 1, yi, xf - 1, yf), c = dot(xi, yi + 1, xf, yf - 1), d = dot(xi + 1, yi + 1, xf - 1, yf - 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const oct = [4, 8, 16, 32, 64].map((P) => [P, grads(P)]);
  const fbm = (x, y, from, n) => { let s = 0, a = 1, norm = 0; for (let o = from; o < from + n; o++) { const [P, g] = oct[o]; s += a * perlin(x * P, y * P, P, g); norm += a; a *= 0.5; } return s / norm; };
  const C = 8, pts = Array.from({ length: C * C }, () => [rnd(), rnd()]);
  const cell = (x, y) => { // periodic worley F1
    const X = x * C, Y = y * C, xi = Math.floor(X), yi = Math.floor(Y); let best = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const cx = xi + i, cy = yi + j, p = pts[(((cy % C) + C) % C) * C + (((cx % C) + C) % C)]; best = Math.min(best, Math.hypot(cx + p[0] - X, cy + p[1] - Y)); }
    return best;
  };
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, i = (y * S + x) * 4;
    data[i] = Math.max(0, Math.min(255, 128 + fbm(u, v, 0, 4) * 300));
    data[i + 1] = Math.max(0, Math.min(255, 128 + fbm(u, v, 2, 3) * 300));
    data[i + 2] = Math.max(0, Math.min(255, (1 - cell(u, v)) * 255));
    data[i + 3] = 255;
  }
  noiseTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping; noiseTex.magFilter = THREE.LinearFilter; noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true; noiseTex.needsUpdate = true;
  return noiseTex;
}

// Sky dome: atmosphere + sun disc + stars + a high cirrus/altocumulus layer (+ the planet below, from high up).
// fog: { glsl, uniforms, color } (the world's haze): below the horizon the dome shows exactly the colour the far terrain
// fades into, so the edge of the world melts into it.
export function skyMaterial(lut, { env = false, fog = null } = {}) {
  const U = {
    skyLUT: { value: lut }, noiseTex: { value: cloudNoiseTexture() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunDisc: { value: new THREE.Color(0, 0, 0) },
    stars: { value: 0 }, cirrus: { value: 0 }, cirrusOff: { value: new THREE.Vector2() }, cirrusLit: { value: new THREE.Color(1, 1, 1) }, cirrusAmb: { value: new THREE.Color(0.5, 0.6, 0.7) },
    grey: { value: 0 }, greyCol: { value: new THREE.Color(0.5, 0.5, 0.5) }, uTime: { value: 0 }, ...PLANET, ...MOON_U,
  };
  if (fog) { for (const k in fog.uniforms) if (k.startsWith('fog')) U[k] = fog.uniforms[k]; U.fogColor = { value: fog.color }; }
  return new THREE.ShaderMaterial({
    uniforms: U, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false,
    defines: env ? { ENV: 1 } : {},
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); gl_Position = p; gl_Position.z = p.w * 0.99999; }`,
    fragmentShader: /* glsl */`
      ${fog ? "" : "uniform sampler2D skyLUT; "}uniform sampler2D noiseTex; uniform vec3 sunDir; uniform vec3 sunDisc; uniform float stars; uniform float cirrus; uniform vec2 cirrusOff;
      uniform vec3 cirrusLit; uniform vec3 cirrusAmb; uniform float grey; uniform vec3 greyCol; uniform float uTime;
      uniform float space; uniform sampler2D earthDay; uniform sampler2D earthLights; uniform vec3 planetCam; uniform float planetC; uniform mat3 toEcef;
      uniform float cloudCov; uniform vec2 cloudOff; uniform vec3 sunLight; uniform vec3 planetAmb;
      varying vec3 vDir;
      ${MOON_GLSL}
      ${CLOUD_SEA_GLSL}
      ${PLANET_LIGHT_GLSL}
      ${fog ? 'uniform vec3 fogColor;\n' + fog.glsl : SKY_LOOKUP_GLSL}
      float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyLook(skyLUT, d);
        float below = clamp(-d.y * 6.0, 0.0, 1.0);
        float cs = dot(d, sunDir);
        col *= 1.0 - below * 0.45; // below the horizon: the haze over the ground is a little darker
        // a moonlit night sky is a deep blue, brightest low down (none of it from high up, above the air)
        col += moonSky * (0.6 + 0.8 * (1.0 - abs(d.y))) * (1.0 - space);
        ${fog ? 'vec3 fext; col = mix(col, fogTarget(d, fogColor, fext), smoothstep(0.0, -0.012, d.y));' : ''}
        #ifndef ENV
        // from high up: the round Earth below the horizon, seen through its own atmosphere (sky-view table: in-scattered
        // light, and in alpha how much of the ground's light gets through), with a glowing limb above it
        float hitP = 0.0;
        if (space > 0.001) {
          vec4 L = skyLookFull(skyLUT, d);
          float b = dot(planetCam, d), hh = b * b - planetC, t = -b - sqrt(max(hh, 0.0));
          hitP = step(0.0, hh) * step(0.0, t);
          vec3 P = planetCam + d * max(t, 0.0), N = normalize(P), e = toEcef * N;
          vec2 uv = vec2(atan(e.y, e.x) * 0.1591549 + 0.5, asin(clamp(e.z, -1.0, 1.0)) * 0.3183099 + 0.5);
          vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y), gx = dFdx(uv), gy = dFdy(uv), gx2 = dFdx(uv2), gy2 = dFdy(uv2);
          if (abs(gx2.x) + abs(gy2.x) < abs(gx.x) + abs(gy.x)) { gx = gx2; gy = gy2; } // no mip seam at the date line
          vec3 alb = textureGrad(earthDay, uv, gx, gy).rgb;
          float lights = textureGrad(earthLights, uv, gx, gy).r;
          float cl = cloudSea(noiseTex, P.xz * 1000.0, cloudOff, cloudCov);
          vec3 surf = planetShade(alb, lights, cl, dot(N, sunDir), sunLight, planetAmb);
          // next to the local world: the coarse ground map its far edge fades into, then the full detail further out
          ${fog ? 'surf = mix(groundMap(skyLUT, P.xz * 1000.0, fogGMap), surf, smoothstep(1.0, 1.6, length(P.xz - planetCam.xz) * 1000.0 / fogEnd));' : ''}
          vec3 Tv = pow(vec3(max(L.a, 1e-4)), vec3(${(BR[0] / BR[1]).toFixed(4)}, 1.0, ${(BR[2] / BR[1]).toFixed(4)}));
          if (d.y < 0.0) col = mix(col, L.rgb + Tv * surf * hitP, space);
        }
        // the moon (src/moon.js): behind the haze below the horizon, and behind the planet from up high
        vec3 mc = moonDisc(d) * (1.0 - mix(below, hitP, space));
        // stars (procedural, so haze and clouds hide them) with a little twinkle
        if (stars > 0.002 && moonMask < 0.99 && (d.y > -0.02 || space > 0.0)) {
          vec3 p = d * 220.0, c = floor(p), f = fract(p);
          float h = hash3(c);
          if (h > 0.95) {
            vec3 o = vec3(hash3(c + 1.7), hash3(c + 3.1), hash3(c + 5.3)) * 0.7 + 0.15;
            float px = length(fwidth(p)) * 0.9;
            float r = length(f - o);
            float b = pow((h - 0.95) / 0.05, 5.0) * 3.0 + 0.2;
            float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h * 9.0) + h * 40.0);
            col += vec3(0.85 + 0.3 * hash3(c + 7.0), 0.9, 1.0 + 0.3 * hash3(c + 9.0) - 0.15) * b * tw * smoothstep(px * 1.2, px * 0.3, r) * stars * mix(smoothstep(-0.02, 0.15, d.y), 1.0 - hitP, space)
              * mix(1.0, 1.0 / (1.0 + 60.0 * dot(col, vec3(0.3, 0.6, 0.1))), space) // up high, daylit air still drowns the faint ones
              * (1.0 - moonMask);
          }
        }
        col += mc;
        // sun disc with limb darkening (HDR: blooms through the post chain)
        float disc = smoothstep(0.99990, 0.99993, cs);
        if (disc > 0.0) { float lr = clamp((1.0 - cs) / 0.0001, 0.0, 1.0); col += sunDisc * disc * (1.0 - 0.45 * lr) * (1.0 - mix(below, hitP, space)); }
        #endif
        // high cirrus / altocumulus layer, 8 km up
        if (cirrus > 0.003 && d.y > 0.01) {
          vec2 q = d.xz / d.y * 0.11 + cirrusOff;
          vec2 qs = vec2(q.x * 0.55 + q.y * 0.25, q.y * 1.4);
          float n = texture2D(noiseTex, qs * 0.7).r * 0.65 + texture2D(noiseTex, qs * 2.3 + 0.3).g * 0.35;
          float streak = texture2D(noiseTex, vec2(qs.x * 3.0, qs.y * 0.6)).g;
          float dens = smoothstep(1.0 - cirrus * 0.75, 1.15 - cirrus * 0.6, n * 0.85 + streak * 0.2);
          dens *= smoothstep(0.01, 0.12, d.y);
          float fw = pow(max(cs, 0.0), 12.0) * 2.5 + pow(max(cs, 0.0), 3.0) * 0.5;
          vec3 cc = cirrusAmb + cirrusLit * (0.55 + fw);
          col = mix(col, cc, dens * 0.75);
        }
        col = mix(col, greyCol, grey);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
