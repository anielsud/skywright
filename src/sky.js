// Physically based sky: a single-scattering atmosphere (Rayleigh + Mie + ozone) baked into a small
// sky-view lookup texture whenever the sun or weather changes. The sky dome, the reflection map,
// and the aerial-perspective fog all read that one texture, so they always agree.
import * as THREE from 'three';
import { FullScreenQuad } from '../vendor/addons/postprocessing/Pass.js';
import { mulberry32 } from './noise.js';

// Planet / atmosphere in km. Coefficients from Bruneton & Hillaire's Earth presets.
const R0 = 6360, RT = 6460;
const BR = [5.802e-3, 13.558e-3, 33.1e-3], BME = 4.4e-3, OZ = [0.65e-3, 1.881e-3, 0.085e-3];
export const SKY_EXPOSURE = 13; // radiance -> scene units (noon horizon ~ the old fog colour)

// Shared lookup: direction -> sky radiance (only the upper hemisphere is stored; v = sqrt(elevation)).
export const SKY_LOOKUP_GLSL = /* glsl */`
  vec3 skyLook(sampler2D lut, vec3 d) {
    float u = atan(d.z, d.x) * 0.1591549 + 0.5;
    return texture2D(lut, vec2(u, sqrt(clamp(d.y, 0.0, 1.0)))).rgb;
  }`;

const LUT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform vec3 sunDir; uniform float haze; uniform float exposure; uniform float alt;
  const float R0 = ${R0.toFixed(1)}; const float RT = ${RT.toFixed(1)};
  const vec3 BR = vec3(${BR.join(', ')}); const float BM = 3.996e-3; const float BME = ${BME}; const vec3 OZ = vec3(${OZ.join(', ')});
  vec2 rs(vec3 o, vec3 d, float r) { float b = dot(o, d); float c = dot(o, o) - r * r; float h = b * b - c; if (h < 0.0) return vec2(-1.0); h = sqrt(h); return vec2(-b - h, -b + h); }
  vec3 dens(float h) { return vec3(exp(-h / 8.0), exp(-h / 1.2) * haze, max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
  vec3 ext(vec3 od) { return exp(-(BR * od.x + BME * od.y + OZ * od.z)); }
  void main() {
    float az = (vUv.x - 0.5) * 6.2831853, y = vUv.y * vUv.y, c = sqrt(max(0.0, 1.0 - y * y));
    vec3 d = vec3(c * cos(az), y, c * sin(az));
    vec3 o = vec3(0.0, R0 + alt, 0.0);
    float L = rs(o, d, RT).y; vec2 g = rs(o, d, R0); if (g.x > 0.0) L = g.x;
    float mu = dot(d, sunDir);
    float pR = 0.0596831 * (1.0 + mu * mu);
    const float gg = 0.8;
    float pM = 0.1193662 * ((1.0 - gg * gg) * (1.0 + mu * mu)) / ((2.0 + gg * gg) * pow(1.0 + gg * gg - 2.0 * gg * mu, 1.5));
    vec3 col = vec3(0.0), od = vec3(0.0); float tp = 0.0;
    for (int i = 0; i < 32; i++) {
      float f = float(i + 1) / 32.0, t1 = L * f * f, t = 0.5 * (tp + t1), ds = t1 - tp; tp = t1;
      vec3 p = o + d * t; float h = length(p) - R0; vec3 q = dens(h);
      od += q * ds;
      if (rs(p, sunDir, R0).x > 0.0) continue; // in the planet's shadow
      float sl = rs(p, sunDir, RT).y / 8.0; vec3 ods = vec3(0.0);
      for (int j = 0; j < 8; j++) { vec3 ps = p + sunDir * (float(j) + 0.5) * sl; ods += dens(length(ps) - R0) * sl; }
      col += ext(od + ods) * (BR * q.x * pR + BM * q.y * pM) * ds;
    }
    col *= exposure;
    // cheap stand-in for multiple scattering: keeps blue hour blue and the daytime horizon less grey
    float sy = sunDir.y;
    col += vec3(0.22, 0.42, 1.0) * (0.035 * smoothstep(-0.22, 0.0, sy) + 0.07 * smoothstep(0.0, 0.5, sy)) * (0.6 + 0.4 * (1.0 - y)) * (1.0 + haze * 0.15);
    // night: airglow, brighter towards the horizon
    col += vec3(0.0022, 0.0036, 0.0085) * (1.0 + 1.6 * (1.0 - y));
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Atmosphere {
  constructor(renderer, w = 192, h = 96) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.rt.texture.wrapS = THREE.RepeatWrapping; this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = this.rt.texture;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, haze: { value: 1 }, exposure: { value: SKY_EXPOSURE }, alt: { value: 0.6 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.horizon = new THREE.Color(0.55, 0.67, 0.82); this.zenith = new THREE.Color(0.2, 0.35, 0.7);
  }
  update(sunDir, haze) {
    const r = this.renderer, prev = r.getRenderTarget();
    this.mat.uniforms.sunDir.value.copy(sunDir); this.mat.uniforms.haze.value = haze;
    r.setRenderTarget(this.rt); this.quad.render(r); r.setRenderTarget(prev);
    this.readBack();
  }
  // average horizon and zenith colours for the CPU side (fog colour, clear colour, hemisphere light)
  readBack() {
    const { width: w, height: h } = this.rt;
    try {
      const buf = new Uint16Array(w * h * 4);
      this.renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
      const f = THREE.DataUtils.fromHalfFloat;
      const avg = (row, out) => { let r = 0, g = 0, b = 0; for (let x = 0; x < w; x++) { const i = (row * w + x) * 4; r += f(buf[i]); g += f(buf[i + 1]); b += f(buf[i + 2]); } return out.setRGB(r / w, g / w, b / w); };
      const rowFor = (el) => Math.min(h - 1, Math.round(Math.sqrt(Math.sin(el)) * h - 0.5));
      const hz = avg(rowFor(0.035), new THREE.Color()), zn = avg(rowFor(1.3), new THREE.Color());
      if ([hz.r, hz.g, hz.b, zn.r, zn.g, zn.b].every(Number.isFinite)) { this.horizon.copy(hz); this.zenith.copy(zn); this.readOk = true; }
    } catch { this.readOk = false; /* half-float readback unsupported: keep the previous estimate */ }
  }
  // colour of direct sunlight after passing through the air (1,1,1 at noon)
  static sunTransmittance(sunDir, haze = 1, out = new THREE.Color()) {
    const o = [0, R0 + 0.6, 0], d = [sunDir.x, Math.max(sunDir.y, -0.2), sunDir.z];
    const b = o[1] * d[1], cG = o[1] ** 2 - R0 * R0, hG = b * b - cG;
    if (hG > 0 && -b - Math.sqrt(hG) > 0) return out.setRGB(0, 0, 0);
    const L = -b + Math.sqrt(b * b - (o[1] ** 2 - RT * RT)), n = 48, ds = L / n; let r = 0, m = 0, z = 0;
    for (let i = 0; i < n; i++) { const t = (i + 0.5) * ds, h = Math.hypot(d[0] * t, o[1] + d[1] * t, d[2] * t) - R0; r += Math.exp(-h / 8) * ds; m += Math.exp(-h / 1.2) * haze * ds; z += Math.max(0, 1 - Math.abs(h - 25) / 15) * ds; }
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

// Sky dome: atmosphere + sun disc + stars + a high cirrus/altocumulus layer.
export function skyMaterial(lut, { env = false } = {}) {
  const U = {
    skyLUT: { value: lut }, noiseTex: { value: cloudNoiseTexture() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunDisc: { value: new THREE.Color(0, 0, 0) },
    stars: { value: 0 }, cirrus: { value: 0 }, cirrusOff: { value: new THREE.Vector2() }, cirrusLit: { value: new THREE.Color(1, 1, 1) }, cirrusAmb: { value: new THREE.Color(0.5, 0.6, 0.7) },
    grey: { value: 0 }, greyCol: { value: new THREE.Color(0.5, 0.5, 0.5) }, uTime: { value: 0 },
  };
  return new THREE.ShaderMaterial({
    uniforms: U, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false,
    defines: env ? { ENV: 1 } : {},
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); gl_Position = p; gl_Position.z = p.w * 0.99999; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D skyLUT; uniform sampler2D noiseTex; uniform vec3 sunDir; uniform vec3 sunDisc; uniform float stars; uniform float cirrus; uniform vec2 cirrusOff;
      uniform vec3 cirrusLit; uniform vec3 cirrusAmb; uniform float grey; uniform vec3 greyCol; uniform float uTime;
      varying vec3 vDir;
      ${SKY_LOOKUP_GLSL}
      float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyLook(skyLUT, d);
        float below = clamp(-d.y * 6.0, 0.0, 1.0);
        float cs = dot(d, sunDir);
        col *= 1.0 - below * 0.45; // below the horizon: the haze over the ground is a little darker
        #ifndef ENV
        // stars (procedural, so haze and clouds hide them) with a little twinkle
        if (stars > 0.002 && d.y > -0.02) {
          vec3 p = d * 220.0, c = floor(p), f = fract(p);
          float h = hash3(c);
          if (h > 0.95) {
            vec3 o = vec3(hash3(c + 1.7), hash3(c + 3.1), hash3(c + 5.3)) * 0.7 + 0.15;
            float px = length(fwidth(p)) * 0.9;
            float r = length(f - o);
            float b = pow((h - 0.95) / 0.05, 5.0) * 3.0 + 0.2;
            float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h * 9.0) + h * 40.0);
            col += vec3(0.85 + 0.3 * hash3(c + 7.0), 0.9, 1.0 + 0.3 * hash3(c + 9.0) - 0.15) * b * tw * smoothstep(px * 1.2, px * 0.3, r) * stars * smoothstep(-0.02, 0.15, d.y);
          }
        }
        // sun disc with limb darkening (HDR: blooms through the post chain)
        float disc = smoothstep(0.99990, 0.99993, cs);
        if (disc > 0.0) { float lr = clamp((1.0 - cs) / 0.0001, 0.0, 1.0); col += sunDisc * disc * (1.0 - 0.45 * lr) * (1.0 - below); }
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
