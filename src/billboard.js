// Instanced camera-facing quads: used for clouds (static) and particles (dynamic).
import * as THREE from 'three';

const vert = /* glsl */`
  attribute vec3 iPos; attribute vec4 iColor; attribute vec2 iSizeRot;
  uniform vec3 camRight; uniform vec3 camUp; uniform float nearFade;
  varying vec2 vUv; varying vec4 vColor; varying float vFog; varying float vNear;
  uniform float fogDensity;
  void main() {
    vUv = uv;
    float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
    vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSizeRot.x;
    vec3 wp = iPos + camRight * p.x + camUp * p.y;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = iColor;
    float d = length(mv.xyz);
    vFog = 1.0 - exp(-fogDensity * fogDensity * d * d);
    vNear = nearFade > 0.0 ? smoothstep(iSizeRot.x * 0.15, iSizeRot.x * nearFade, d) : 1.0;
  }`;
const frag = /* glsl */`
  uniform sampler2D map; uniform vec3 fogColor; uniform vec3 litColor; uniform vec3 shadeColor; uniform float additive;
  varying vec2 vUv; varying vec4 vColor; varying float vFog; varying float vNear;
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = t.a * vColor.a * vNear;
    if (a < 0.003) discard;
    vec3 col = vColor.rgb * mix(shadeColor, litColor, clamp(t.r * (0.35 + 0.65 * vUv.y), 0.0, 1.0));
    if (additive > 0.5) { col = vColor.rgb * t.r; gl_FragColor = vec4(col * a * (1.0 - vFog), 1.0); return; }
    col = mix(col, fogColor, vFog);
    gl_FragColor = vec4(col, a * (1.0 - vFog * 0.3));
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
