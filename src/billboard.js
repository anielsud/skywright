// Instanced camera-facing quads: used for clouds (static) and particles (dynamic).
import * as THREE from 'three';
import { FOG, FOG_GLSL } from './shaders.js';

const vert = /* glsl */`
  attribute vec3 iPos; attribute vec4 iColor; attribute vec2 iSizeRot;
  uniform vec3 camRight; uniform vec3 camUp; uniform float nearFade;
  varying vec2 vUv; varying vec4 vColor; varying float vNear; varying vec3 vWP; varying vec2 vQuad;
  void main() {
    vUv = uv; vQuad = position.xy;
    float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
    vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSizeRot.x;
    vec3 wp = iPos + camRight * p.x + camUp * p.y;
    vWP = wp;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = iColor;
    float d = length(mv.xyz);
    vNear = nearFade > 0.0 ? smoothstep(iSizeRot.x * 0.15, iSizeRot.x * nearFade, d) : 1.0;
  }`;
const frag = /* glsl */`
  uniform sampler2D map; uniform vec3 fogColor; uniform vec3 litColor; uniform vec3 shadeColor; uniform float additive;
  uniform vec3 sunDir; uniform vec3 sunGlow; uniform float useFog;
  varying vec2 vUv; varying vec4 vColor; varying float vNear; varying vec3 vWP; varying vec2 vQuad;
  ${FOG_GLSL}
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = t.a * vColor.a * vNear;
    if (a < 0.003) discard;
    if (additive > 0.5) {
      vec3 col = vColor.rgb * t.r * 2.4;
      vec3 f = useFog > 0.5 ? applyHeightFog(col, vWP, vec3(0.0)) : col;
      gl_FragColor = vec4(f * a, 1.0); return;
    }
    // vertical gradient + per-puff shade, then a silver lining when looking towards the sun
    float up = clamp(0.35 + 0.65 * (vQuad.y + 0.5), 0.0, 1.0);
    vec3 col = vColor.rgb * mix(shadeColor, litColor, clamp(t.r * up, 0.0, 1.0));
    vec3 vd = normalize(vWP - cameraPosition);
    float toward = pow(max(dot(vd, sunDir), 0.0), 6.0);
    float edge = 1.0 - smoothstep(0.0, 0.85, t.a);
    col += sunGlow * toward * (0.35 + edge * 2.2);
    col = useFog > 0.5 ? applyHeightFog(col, vWP, fogColor) : col;
    gl_FragColor = vec4(col, a);
  }`;

export class Billboards {
  constructor(capacity, texture, { additive = false, nearFade = 0, depthTest = true } = {}) {
    this.capacity = capacity; this.count = 0;
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    this.pos = new Float32Array(capacity * 3); this.col = new Float32Array(capacity * 4); this.sr = new Float32Array(capacity * 2);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iSizeRot', new THREE.InstancedBufferAttribute(this.sr, 2).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.uniforms = {
      map: { value: texture }, camRight: { value: new THREE.Vector3(1, 0, 0) }, camUp: { value: new THREE.Vector3(0, 1, 0) },
      fogColor: { value: new THREE.Color(0xbfd1e5) }, fogDensity: { value: 0.00005 }, litColor: { value: new THREE.Color(1, 1, 1) },
      shadeColor: { value: new THREE.Color(0.6, 0.65, 0.72) }, nearFade: { value: nearFade }, additive: { value: additive ? 1 : 0 },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunGlow: { value: new THREE.Color(0, 0, 0) }, useFog: { value: 1 },
      ...FOG,
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.geo = g;
    this.mesh.renderOrder = additive ? 3 : 2;
  }
  set(i, x, y, z, size, rot, r, g, b, a) {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.sr[i * 2] = size; this.sr[i * 2 + 1] = rot;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
  }
  commit(n) {
    this.count = n; this.geo.instanceCount = n;
    for (const k of ['iPos', 'iColor', 'iSizeRot']) { const at = this.geo.attributes[k]; at.needsUpdate = true; at.clearUpdateRanges?.(); }
  }
  updateCamera(camera, fog) {
    camera.updateMatrixWorld();
    this.uniforms.camRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
    this.uniforms.camUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    if (fog) { this.uniforms.fogColor.value.copy(fog.color); this.uniforms.fogDensity.value = fog.density; }
  }
}
