// Post-processing: HDR bloom, colour grade, vignette, crash shock (chromatic aberration) and heat shimmer.
// Ultra adds (AtmosPass, before bloom, in HDR) screen-space ambient occlusion and sun shafts, a filmic split-tone in
// the grade, and SMAA on top of MSAA.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from '../vendor/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from '../vendor/addons/postprocessing/Pass.js';
import { renderHudOverlay } from './liveHud.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.32 }, saturation: { value: 1.12 }, contrast: { value: 1.06 }, shock: { value: 0 }, warmth: { value: 0 }, time: { value: 0 }, grain: { value: 0.025 },
    sunUV: { value: new THREE.Vector2(0.5, 0.5) }, sunVis: { value: 0 }, sunTint: { value: new THREE.Color(1, 0.9, 0.7) }, aspect: { value: 1.6 },
    shimSeg: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, shimPar: { value: [0, 1, 2, 3].map(() => new THREE.Vector2()) }, shimOn: { value: 0 },
    film: { value: 0 }, sharpen: { value: 0 }, texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float vignette; uniform float saturation; uniform float contrast; uniform float shock; uniform float warmth; uniform float time; uniform float grain;
    uniform vec2 sunUV; uniform float sunVis; uniform vec3 sunTint; uniform float aspect;
    uniform vec4 shimSeg[4]; uniform vec2 shimPar[4]; uniform float shimOn; uniform float film; uniform float sharpen; uniform vec2 texel;
    varying vec2 vUv;
    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      vec2 uv = vUv;
      if (shimOn > 0.5) { // heat haze: wobble the image inside capsules behind hot exhausts / around a hot nose
        vec2 asp = vec2(aspect, 1.0), p = vUv * asp, off = vec2(0.0);
        for (int i = 0; i < 4; i++) {
          if (shimPar[i].y <= 0.0) continue;
          vec2 a = shimSeg[i].xy * asp, ab = shimSeg[i].zw * asp - a;
          float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
          float w = shimPar[i].y * smoothstep(shimPar[i].x, 0.0, length(p - a - ab * h)) * (1.0 - 0.6 * h);
          off += w * vec2(sin(p.y * 60.0 + time * 17.0 + 2.0 * sin(p.x * 45.0 - time * 5.0)), cos(p.x * 55.0 - time * 13.0 + 2.0 * sin(p.y * 40.0 + time * 4.0)));
        }
        uv += off * 0.0024;
      }
      vec3 c;
      float ca = shock + film * 0.18 * dot(d, d); // Ultra: a whisper of lateral chromatic aberration towards the corners
      if (ca > 0.001) { // chromatic split on big impacts
        vec2 o = d * ca * 0.03;
        c = vec3(texture2D(tDiffuse, uv + o).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - o).b);
      } else c = texture2D(tDiffuse, uv).rgb;
      if (sharpen > 0.0) { // contrast-adaptive sharpening (AMD CAS-style): restores crispness when rendering below native resolution
        vec3 cn = texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb, cs = texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
        vec3 ce = texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb, cw = texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb;
        vec3 mn = min(c, min(min(cn, cs), min(ce, cw))), mx = max(c, max(max(cn, cs), max(ce, cw)));
        vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
        vec3 wt = -amp / mix(8.0, 5.0, sharpen);
        c = clamp((c + (cn + cs + ce + cw) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c = (c - 0.5) * contrast + 0.5;
      c += vec3(0.02, 0.005, -0.02) * warmth;
      if (film > 0.0) { // filmic split-tone: cool, slightly lifted shadows, warm highlights; a soft shoulder on whites
        float L = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
        c += film * (vec3(-0.012, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.45, L)) + vec3(0.018, 0.006, -0.018) * smoothstep(0.55, 1.0, L));
        c = mix(c, c * (1.0 - 0.06 * L * L), film);
        c = max(c, vec3(0.008 * film));
      }
      if (sunVis > 0.001) { // analytic lens flare: halo + ghosts along the sun-centre axis
        vec2 asp = vec2(aspect, 1.0);
        float d0 = length((vUv - sunUV) * asp);
        c += sunTint * (exp(-d0 * 7.0) * 0.22 + exp(-d0 * 32.0) * 0.35) * sunVis;
        float ring = smoothstep(0.035, 0.0, abs(d0 - 0.32)) * 0.05;
        c += sunTint * ring * sunVis;
        vec2 sv = sunUV - 0.5;
        float gs[5]; gs[0] = -0.35; gs[1] = -0.7; gs[2] = -1.05; gs[3] = 0.45; gs[4] = -1.6;
        vec3 gc[5]; gc[0] = vec3(0.45, 0.8, 0.5); gc[1] = vec3(0.4, 0.5, 1.0); gc[2] = vec3(1.0, 0.55, 0.3); gc[3] = vec3(0.9, 0.9, 0.6); gc[4] = vec3(0.6, 0.4, 1.0);
        float gr[5]; gr[0] = 0.05; gr[1] = 0.09; gr[2] = 0.035; gr[3] = 0.025; gr[4] = 0.14;
        for (int i = 0; i < 5; i++) {
          float dg = length((vUv - (0.5 + sv * gs[i])) * asp);
          c += gc[i] * smoothstep(gr[i], gr[i] * 0.4, dg) * 0.07 * sunVis * (1.0 - 0.6 * film);
        }
      }
      c *= 1.0 - vignette * dot(d, d) * 1.6;
      c += (rnd(vUv * 731.0 + time) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// ---------- Ultra: ambient occlusion + sun shafts, in HDR, right after the scene render ----------
const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const DEPTH_GLSL = /* glsl */`
  #include <packing>
  uniform sampler2D tDepth; uniform mat4 projInv; uniform float cNear; uniform float cFar;
  vec3 viewPos(vec2 uv, float d) { vec4 p = projInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
  float linZ(float d) { return -perspectiveDepthToViewZ(d, cNear, cFar); }`;
const mat = (o) => new THREE.ShaderMaterial({ vertexShader: VS, depthTest: false, depthWrite: false, ...o });

// Scalable-AO style estimator from the depth buffer alone (normals rebuilt from depth), at half resolution. The
// world radius grows with distance so close-ups get contact shadows under wheels and between parts, and a town or a
// forest edge a kilometre away still gets its alleys and canopy gaps darkened; it fades out into the haze.
const AO_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform vec2 texel; uniform float projScale; uniform float aspect; uniform float radiusK; uniform float rMin; uniform float rMax; uniform float maxDist; uniform float strength; uniform float frame;
  varying vec2 vUv;
  #define SAMPLES 14
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999995) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv, d); float dist = -P.z;
    if (!(dist < maxDist)) { gl_FragColor = vec4(1.0); return; } // also catches NaN
    vec3 Pr = viewPos(vUv + vec2(texel.x, 0.0), texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x), Pl = viewPos(vUv - vec2(texel.x, 0.0), texture2D(tDepth, vUv - vec2(texel.x, 0.0)).x);
    vec3 Pu = viewPos(vUv + vec2(0.0, texel.y), texture2D(tDepth, vUv + vec2(0.0, texel.y)).x), Pd = viewPos(vUv - vec2(0.0, texel.y), texture2D(tDepth, vUv - vec2(0.0, texel.y)).x);
    vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
    vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
    vec3 N = normalize(cross(dx, dy));
    if (dot(N, P) > 0.0) N = -N;
    float R = clamp(dist * radiusK, rMin, rMax);
    float sr = min(R * projScale / dist, 0.12); // screen radius (fraction of the screen height)
    if (sr < texel.y * 2.0) { gl_FragColor = vec4(1.0); return; }
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + frame * 0.618);
    float occ = 0.0, bias = 0.1; // cosine bias: flat or gently curved ground stays unoccluded
    for (int i = 0; i < SAMPLES; i++) {
      float t = (float(i) + 0.5) / float(SAMPLES);
      float ang = noise * 6.2831853 + float(i) * 2.3999632;
      vec2 suv = vUv + vec2(cos(ang) / aspect, sin(ang)) * sr * t;
      vec3 S = viewPos(suv, texture2D(tDepth, suv).x);
      vec3 v = S - P; float vv = dot(v, v);
      float f = max(1.0 - vv / (R * R), 0.0);
      occ += f * max(dot(v, N) / sqrt(vv + 1e-6) - bias, 0.0);
    }
    float ao = clamp(1.0 - strength * 2.0 * occ / float(SAMPLES), 0.0, 1.0);
    ao = mix(ao, 1.0, smoothstep(maxDist * 0.55, maxDist, dist));
    gl_FragColor = vec4(ao, ao, ao, 1.0);
  }`;
// depth-aware blur, one axis per pass
const BLUR_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tAO; uniform vec2 dir; varying vec2 vUv;
  void main() {
    float z0 = linZ(texture2D(tDepth, vUv).x), sum = 0.0, ws = 0.0;
    for (int k = -4; k <= 4; k++) {
      vec2 uv = vUv + dir * float(k);
      float z = linZ(texture2D(tDepth, uv).x);
      float w = exp(-float(k * k) * 0.12) * max(0.0, 1.0 - abs(z - z0) / (0.04 * z0 + 0.1));
      sum += texture2D(tAO, uv).r * w; ws += w;
    }
    float a = ws > 1e-4 ? sum / ws : texture2D(tAO, vUv).r;
    gl_FragColor = vec4(a, a, a, 1.0);
  }`;
// sun shafts: bright open sky around the sun (depth = cleared), then a radial blur towards the sun
const MASK_FRAG = /* glsl */`
  uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 sunUV; uniform float aspect; uniform float thr; varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).x;
    vec3 c = texture2D(tColor, vUv).rgb;
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = step(0.9999995, d) * max(L - thr, 0.0) / max(L, 1e-4);
    float fall = pow(max(0.0, 1.0 - length((vUv - sunUV) * vec2(aspect, 1.0)) / 0.4), 2.0);
    gl_FragColor = vec4(min(c * k * fall, vec3(8.0)), 1.0);
  }`;
const RADIAL_FRAG = /* glsl */`
  uniform sampler2D tIn; uniform vec2 sunUV; uniform float stepLen; uniform float decay; varying vec2 vUv;
  #define TAPS 24
  void main() {
    vec2 delta = (sunUV - vUv) * stepLen / float(TAPS);
    vec2 uv = vUv; vec3 sum = vec3(0.0); float w = 1.0, ws = 0.0;
    for (int i = 0; i < TAPS; i++) {
      vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
      sum += texture2D(tIn, uv).rgb * w * inside.x * inside.y; ws += w; w *= decay; uv += delta;
    }
    gl_FragColor = vec4(sum / ws, 1.0);
  }`;
const COMP_FRAG = /* glsl */`
  uniform sampler2D tDepthDbg;
  uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tRays; uniform float aoOn; uniform float raysOn; uniform vec3 rayTint; uniform float debug; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    if (debug > 2.5) { float dd = texture2D(tDepthDbg, vUv).x; c.rgb = vec3(dd >= 1.0 ? 1.0 : 0.0, fract(dd * 1000.0), dd < 0.5 ? 1.0 : 0.0); gl_FragColor = c; return; }
    if (debug > 0.5) c.rgb = debug < 1.5 ? vec3(texture2D(tAO, vUv).r) : texture2D(tRays, vUv).rgb * 0.5 + c.rgb * 0.1; // __sky.post.atmos.compMat.uniforms.debug
    if (aoOn > 0.5) { float ao = texture2D(tAO, vUv).r; c.rgb *= ao >= 0.0 && ao <= 1.0 ? ao : 1.0; } // NaN-safe: a NaN here would blacken the frame through bloom
    if (raysOn > 0.0) { vec3 r = texture2D(tRays, vUv).rgb; if (!any(isnan(r)) && !any(isinf(r))) c.rgb += r * rayTint * raysOn * 0.3; }
    gl_FragColor = c;
  }`;

// the fighter's HUD seen from its cockpit (liveHud.js), drawn after the tone mapping: its green light as is
class HudPass extends Pass {
  constructor() { super(); this.needsSwap = false; this.camera = null; }
  render(renderer, writeBuffer, readBuffer) { if (this.camera) renderHudOverlay(renderer, this.camera, this.renderToScreen ? null : readBuffer); }
}
class AtmosPass extends Pass {
  constructor() {
    super();
    const rt = (o) => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, ...o });
    this.aoA = rt({ type: THREE.UnsignedByteType }); this.aoB = rt({ type: THREE.UnsignedByteType });
    this.rA = rt({ type: THREE.HalfFloatType }); this.rB = rt({ type: THREE.HalfFloatType });
    const depthU = () => ({ tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, cNear: { value: 1 }, cFar: { value: 1000 } });
    this.aoMat = mat({ fragmentShader: AO_FRAG, uniforms: { ...depthU(), texel: { value: new THREE.Vector2() }, projScale: { value: 1 }, aspect: { value: 1 }, radiusK: { value: 0.035 }, rMin: { value: 0.6 }, rMax: { value: 14 }, maxDist: { value: 2500 }, strength: { value: 1.0 }, frame: { value: 0 } } });
    this.blurMat = mat({ fragmentShader: BLUR_FRAG, uniforms: { ...depthU(), tAO: { value: null }, dir: { value: new THREE.Vector2() } } });
    this.maskMat = mat({ fragmentShader: MASK_FRAG, uniforms: { tColor: { value: null }, tDepth: { value: null }, sunUV: { value: new THREE.Vector2() }, aspect: { value: 1 }, thr: { value: 3.0 } } });
    this.radMat = mat({ fragmentShader: RADIAL_FRAG, uniforms: { tIn: { value: null }, sunUV: { value: new THREE.Vector2() }, stepLen: { value: 1 }, decay: { value: 0.96 } } });
    this.compMat = mat({ fragmentShader: COMP_FRAG, uniforms: { tColor: { value: null }, tAO: { value: null }, tRays: { value: null }, aoOn: { value: 1 }, raysOn: { value: 0 }, rayTint: { value: new THREE.Color(1, 0.9, 0.75) }, debug: { value: 0 }, tDepthDbg: { value: null } } });
    this.quad = new FullScreenQuad(null);
    this.camera = null; this.ao = true; this.rays = 0; this.sunUV = new THREE.Vector2(0.5, 0.5); this.frame = 0;
  }
  setSize(w, h) {
    this.w = w; this.h = h;
    this.aoA.setSize(Math.ceil(w / 2), Math.ceil(h / 2)); this.aoB.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.rA.setSize(Math.ceil(w / 4), Math.ceil(h / 4)); this.rB.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
  }
  draw(renderer, m, target) { this.quad.material = m; renderer.setRenderTarget(target); this.quad.render(renderer); }
  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera, depth = readBuffer.depthTexture;
    if (!cam || !depth) { this.compMat.uniforms.aoOn.value = 0; this.compMat.uniforms.raysOn.value = 0; }
    const setDepth = (u) => { u.tDepth.value = depth; u.projInv.value.copy(cam.projectionMatrixInverse); u.cNear.value = cam.near; u.cFar.value = cam.far; };
    const C = this.compMat.uniforms;
    C.tColor.value = readBuffer.texture; C.tDepthDbg.value = depth;
    C.aoOn.value = this.ao && cam && depth ? 1 : 0;
    if (C.aoOn.value) {
      const A = this.aoMat.uniforms; setDepth(A);
      A.texel.value.set(1 / this.w, 1 / this.h); A.projScale.value = cam.projectionMatrix.elements[5] * 0.5; A.aspect.value = this.w / this.h;
      A.frame.value = 0; // static noise: without a temporal resolve, animated noise would crawl
      this.draw(renderer, this.aoMat, this.aoA);
      const B = this.blurMat.uniforms; setDepth(B);
      B.tAO.value = this.aoA.texture; B.dir.value.set(2 / this.w, 0); this.draw(renderer, this.blurMat, this.aoB);
      B.tAO.value = this.aoB.texture; B.dir.value.set(0, 2 / this.h); this.draw(renderer, this.blurMat, this.aoA);
      C.tAO.value = this.aoA.texture;
    }
    C.raysOn.value = cam && depth ? this.rays : 0;
    if (C.raysOn.value > 0.001) {
      const M = this.maskMat.uniforms; M.tColor.value = readBuffer.texture; M.tDepth.value = depth; M.sunUV.value.copy(this.sunUV); M.aspect.value = this.w / this.h;
      this.draw(renderer, this.maskMat, this.rA);
      const R = this.radMat.uniforms; R.sunUV.value.copy(this.sunUV);
      R.tIn.value = this.rA.texture; R.stepLen.value = 1; R.decay.value = 0.975; this.draw(renderer, this.radMat, this.rB);
      R.tIn.value = this.rB.texture; R.stepLen.value = 1 / 24; R.decay.value = 1; this.draw(renderer, this.radMat, this.rA);
      C.tRays.value = this.rA.texture;
    }
    this.draw(renderer, this.compMat, this.renderToScreen ? null : writeBuffer);
  }
  dispose() { for (const r of [this.aoA, this.aoB, this.rA, this.rB]) r.dispose(); for (const m of [this.aoMat, this.blurMat, this.maskMat, this.radMat, this.compMat]) m.dispose(); this.quad.dispose(); }
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.atmos = new AtmosPass(); this.atmos.enabled = false;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.55, 0.92);
    this.output = new OutputPass();
    this.smaa = new SMAAPass(size.x, size.y); this.smaa.enabled = false;
    this.grade = new ShaderPass(GradeShader);
    this.hud = new HudPass();
    for (const p of [this.renderPass, this.atmos, this.bloom, this.output, this.hud, this.smaa, this.grade]) this.composer.addPass(p);
    this.enabled = true; this.ultra = false;
  }
  setSamples(n) { for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) { if (rt.samples !== n) { rt.samples = n; rt.dispose(); } } }
  // Ultra: depth-textured scene targets for AO + sun shafts, SMAA, the filmic grade
  setUltra(on) {
    if (on === this.ultra) return; this.ultra = on;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      rt.depthTexture?.dispose();
      rt.depthTexture = on ? new THREE.DepthTexture(rt.width, rt.height, THREE.FloatType) : null;
      rt.dispose();
    }
    this.atmos.enabled = on;
    this.grade.uniforms.film.value = on ? 1 : 0;
  }
  setSize(w, h, pr) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); this.grade.uniforms.texel.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr)); }
  // SMAA (cheap, post) instead of MSAA (expensive at high resolution: measured 7-22 ms/frame at 1-2x on an M1 Pro)
  setSMAA(on) { this.smaa.enabled = on; }
  setSharpen(v) { this.grade.uniforms.sharpen.value = v; }
  render(scene, camera, dt = 0.016) {
    if (!this.enabled) { this.renderer.render(scene, camera); renderHudOverlay(this.renderer, camera, null); return; }
    this.renderPass.scene = scene; this.renderPass.camera = camera; this.atmos.camera = camera; this.hud.camera = camera;
    const g = this.grade.uniforms; g.time.value = (g.time.value + dt) % 100; g.shock.value *= Math.max(0, 1 - dt * 3);
    this.composer.render(dt);
  }
  flare(uv, vis, tint, aspect) { const g = this.grade.uniforms; g.sunUV.value.copy(uv); g.sunVis.value = vis; g.sunTint.value.copy(tint); g.aspect.value = aspect; }
  // Ultra sun shafts: sun position in screen UV (may be off screen), strength 0..1, ray colour
  shafts(uv, k, tint) { this.atmos.sunUV.copy(uv); this.atmos.rays = this.ultra ? k : 0; if (tint) this.atmos.compMat.uniforms.rayTint.value.copy(tint); }
  // Ultra AO: world radius as a fraction of the distance, its clamp, and how far out it reaches (metres)
  ambientOcclusion(o) { const A = this.atmos.aoMat.uniforms; this.atmos.ao = o.on !== false; for (const k of ['radiusK', 'rMin', 'rMax', 'maxDist', 'strength']) if (o[k] !== undefined) A[k].value = o[k]; }
  // segs: [{ a:[u,v], b:[u,v], r, s }] in screen UV (r in screen heights), at most 4. Off on low quality.
  shimmer(segs, on = true) {
    const g = this.grade.uniforms; let n = 0;
    if (on && segs) for (const sg of segs) { if (n >= 4) break; if (![...sg.a, ...sg.b, sg.r, sg.s].every(Number.isFinite)) continue; g.shimSeg.value[n].set(sg.a[0], sg.a[1], sg.b[0], sg.b[1]); g.shimPar.value[n].set(sg.r, sg.s); n++; }
    for (let i = n; i < 4; i++) g.shimPar.value[i].set(0, 0);
    g.shimOn.value = n ? 1 : 0;
  }
  shock(a) { this.grade.uniforms.shock.value = Math.min(1.5, this.grade.uniforms.shock.value + a); }
  look(o) { for (const k in o) if (this.grade.uniforms[k]) this.grade.uniforms[k].value = o[k]; if (o.bloom !== undefined) this.bloom.strength = o.bloom; if (o.threshold !== undefined) this.bloom.threshold = o.threshold; }
}
