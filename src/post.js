// Post-processing: HDR bloom, colour grade, vignette and crash shock (chromatic aberration).
import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.32 }, saturation: { value: 1.12 }, contrast: { value: 1.06 }, shock: { value: 0 }, warmth: { value: 0 }, time: { value: 0 }, grain: { value: 0.025 },
    sunUV: { value: new THREE.Vector2(0.5, 0.5) }, sunVis: { value: 0 }, sunTint: { value: new THREE.Color(1, 0.9, 0.7) }, aspect: { value: 1.6 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float vignette; uniform float saturation; uniform float contrast; uniform float shock; uniform float warmth; uniform float time; uniform float grain;
    uniform vec2 sunUV; uniform float sunVis; uniform vec3 sunTint; uniform float aspect;
    varying vec2 vUv;
    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      vec3 c;
      if (shock > 0.001) { // chromatic split on big impacts
        vec2 o = d * shock * 0.03;
        c = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b);
      } else c = texture2D(tDiffuse, vUv).rgb;
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
  setSize(w, h, pr) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  render(scene, camera, dt = 0.016) {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    this.renderPass.scene = scene; this.renderPass.camera = camera;
    const g = this.grade.uniforms; g.time.value = (g.time.value + dt) % 100; g.shock.value *= Math.max(0, 1 - dt * 3);
    this.composer.render(dt);
  }
  flare(uv, vis, tint, aspect) { const g = this.grade.uniforms; g.sunUV.value.copy(uv); g.sunVis.value = vis; g.sunTint.value.copy(tint); g.aspect.value = aspect; }
  shock(a) { this.grade.uniforms.shock.value = Math.min(1.5, this.grade.uniforms.shock.value + a); }
  look(o) { for (const k in o) if (this.grade.uniforms[k]) this.grade.uniforms[k].value = o[k]; if (o.bloom !== undefined) this.bloom.strength = o.bloom; if (o.threshold !== undefined) this.bloom.threshold = o.threshold; }
}
