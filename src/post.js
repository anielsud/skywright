// Post-processing: HDR bloom, colour grade, vignette, crash shock (chromatic aberration) and heat shimmer.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.32 }, saturation: { value: 1.12 }, contrast: { value: 1.06 }, shock: { value: 0 }, warmth: { value: 0 }, time: { value: 0 }, grain: { value: 0.025 },
    sunUV: { value: new THREE.Vector2(0.5, 0.5) }, sunVis: { value: 0 }, sunTint: { value: new THREE.Color(1, 0.9, 0.7) }, aspect: { value: 1.6 },
    shimSeg: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, shimPar: { value: [0, 1, 2, 3].map(() => new THREE.Vector2()) }, shimOn: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float vignette; uniform float saturation; uniform float contrast; uniform float shock; uniform float warmth; uniform float time; uniform float grain;
    uniform vec2 sunUV; uniform float sunVis; uniform vec3 sunTint; uniform float aspect;
    uniform vec4 shimSeg[4]; uniform vec2 shimPar[4]; uniform float shimOn;
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
      if (shock > 0.001) { // chromatic split on big impacts
        vec2 o = d * shock * 0.03;
        c = vec3(texture2D(tDiffuse, uv + o).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - o).b);
      } else c = texture2D(tDiffuse, uv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c = (c - 0.5) * contrast + 0.5;
      c += vec3(0.02, 0.005, -0.02) * warmth;
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
          c += gc[i] * smoothstep(gr[i], gr[i] * 0.4, dg) * 0.07 * sunVis;
        }
      }
      c *= 1.0 - vignette * dot(d, d) * 1.6;
      c += (rnd(vUv * 731.0 + time) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.55, 0.92);
    this.output = new OutputPass();
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass); this.composer.addPass(this.bloom); this.composer.addPass(this.output); this.composer.addPass(this.grade);
    this.enabled = true;
  }
  setSamples(n) { for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) { if (rt.samples !== n) { rt.samples = n; rt.dispose(); } } }
  setSize(w, h, pr) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  render(scene, camera, dt = 0.016) {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    this.renderPass.scene = scene; this.renderPass.camera = camera;
    const g = this.grade.uniforms; g.time.value = (g.time.value + dt) % 100; g.shock.value *= Math.max(0, 1 - dt * 3);
    this.composer.render(dt);
  }
  flare(uv, vis, tint, aspect) { const g = this.grade.uniforms; g.sunUV.value.copy(uv); g.sunVis.value = vis; g.sunTint.value.copy(tint); g.aspect.value = aspect; }
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
