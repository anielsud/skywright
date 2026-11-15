// Shared shader upgrades: height fog with sun in-scattering, terrain splatting, water, foliage sway.
import * as THREE from 'three';
import { TERRAIN_DETAIL_GLSL } from './terrainTex.js';

// ---------- global height fog ----------
// One shared set of uniforms, attached by reference to every built-in material at compile time,
// so the world can update them once per frame.
export const FOG = {
  fogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  fogSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
  fogBase: { value: 0 },
  fogFalloff: { value: 1 / 900 },
  fogLin: { value: 0.00008 },
  uTime: { value: 0 },
};

export const FOG_GLSL = /* glsl */`
  uniform vec3 fogSunDir; uniform vec3 fogSunColor; uniform float fogBase; uniform float fogFalloff; uniform float fogLin;
  vec3 applyHeightFog(vec3 col, vec3 wp, vec3 fogCol) {
    vec3 rd = wp - cameraPosition;
    float dist = length(rd);
    float h0 = cameraPosition.y - fogBase, h1 = wp.y - fogBase;
    float k = fogFalloff, dh = h1 - h0;
    float e0 = exp(-k * max(h0, -200.0));
    float integ = abs(dh) > 1.0 ? (e0 - exp(-k * max(h1, -200.0))) / (k * dh) : e0;
    float amt = 1.0 - exp(-fogLin * dist * clamp(integ, 0.0, 4.0));
    float s = max(dot(rd / max(dist, 1e-3), fogSunDir), 0.0);
    vec3 fc = fogCol + fogSunColor * (pow(s, 8.0) * 0.55 + pow(s, 48.0) * 0.6);
    return mix(col, fc, amt);
  }`;

let patched = false;
export function installFog() {
  if (patched) return; patched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = `#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogWorldPos;\n#endif`;
  C.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vec4 fogWP = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fogWP = instanceMatrix * fogWP;
    #endif
    vFogWorldPos = ( modelMatrix * fogWP ).xyz;
  #endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogWorldPos;
    #ifdef FOG_EXP2
      uniform float fogDensity;
      ${FOG_GLSL}
    #else
      uniform float fogNear; uniform float fogFar;
    #endif
  #endif`;
  C.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      gl_FragColor.rgb = applyHeightFog( gl_FragColor.rgb, vFogWorldPos, fogColor );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
  #endif`;
  // attach shared uniforms by reference to every material that doesn't define its own hook
  THREE.Material.prototype.onBeforeCompile = function (shader) { Object.assign(shader.uniforms, FOG); };
}

// ---------- terrain material ----------
// patch=true: draws everything (the near-camera detail mesh, and the streamed outer tiles); otherwise the coarse core mesh, which skips the patch area.
export function terrainMaterial(maps, patch = false) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0 });
  const U = { albedoTex: { value: maps.albedo }, normTex: { value: maps.normal }, shadowTex: { value: maps.shadow },
    tOrig: { value: maps.orig }, tSpan: { value: maps.span }, sOrig: { value: maps.sOrig || maps.orig }, sSpan: { value: maps.sSpan || maps.span },
    shadowOn: { value: maps.shadowOn ?? 1 }, patchRect: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) }, ...maps.detailU };
  mat.userData.U = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vTW; uniform sampler2D albedoTex; uniform sampler2D normTex; uniform sampler2D shadowTex;
      uniform vec2 tOrig; uniform float tSpan; uniform vec2 sOrig; uniform float sSpan; uniform float shadowOn; uniform vec4 patchRect;
      ${TERRAIN_DETAIL_GLSL}`)
      .replace('#include <map_fragment>', `
        ${patch ? '' : 'if (vTW.x > patchRect.x && vTW.x < patchRect.z && vTW.z > patchRect.y && vTW.z < patchRect.w) discard;'}
        vec2 tuv = (vTW.xz - tOrig) / tSpan; // texel centres sit exactly on the bake grid points
        vec4 alb = texture2D(albedoTex, tuv);
        vec3 wn = normalize(texture2D(normTex, tuv).xyz * 2.0 - 1.0);
        float terrainShadow = mix(1.0, texture2D(shadowTex, (vTW.xz - sOrig) / sSpan).r, shadowOn);
        float dist = length(vTW - cameraPosition);
        vec3 mul, dn; terrainDetail(vTW, wn, dist, mul, dn);
        // snow keeps the relief but not the photo colour
        float snowy = smoothstep(0.55, 0.72, min(alb.r, min(alb.g, alb.b)));
        mul = mix(mul, vec3(0.92 + 0.08 * dot(mul, vec3(0.333))), snowy);
        wn = dn;
        diffuseColor.rgb = alb.rgb * mul * (0.6 + 0.4 * alb.a) * 1.12;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = snrm((viewMatrix * vec4(wn, 0.0)).xyz);`)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= terrainShadow;'));
  };
  mat.customProgramCacheKey = () => (patch ? 'terrain2-patch' : 'terrain2');
  return mat;
}

// ---------- water ----------
export function waterMaterial(o) {
  const U = {
    depthTex: { value: o.depthTex }, outerTex: { value: null }, outerOrigin: { value: new THREE.Vector2(0, 0) }, outerSize: { value: 1 }, nrm: { value: o.normal }, tHalf: { value: o.half }, tSize: { value: o.size }, waterLevel: { value: o.level },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) }, skyZen: { value: new THREE.Color(0.3, 0.5, 0.8) },
    skyHor: { value: new THREE.Color(0.7, 0.8, 0.9) }, amb: { value: 1 }, deepCol: { value: new THREE.Color(o.deep) }, shallowCol: { value: new THREE.Color(o.shallow) },
    sandCol: { value: new THREE.Color(o.sand) }, fogColor: { value: new THREE.Color(0, 0, 0) }, foamAmt: { value: o.foam ?? 1 }, rough: { value: 0.35 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(U, FOG),
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D depthTex; uniform sampler2D outerTex; uniform vec2 outerOrigin; uniform float outerSize; uniform sampler2D nrm; uniform float tHalf; uniform float tSize; uniform float waterLevel;
      uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 skyZen; uniform vec3 skyHor; uniform float amb;
      uniform vec3 deepCol; uniform vec3 shallowCol; uniform vec3 sandCol; uniform vec3 fogColor; uniform float foamAmt; uniform float rough; uniform float uTime;
      varying vec3 vW;
      ${FOG_GLSL}
      vec3 nmap(vec2 p) { return texture2D(nrm, p).xzy * 2.0 - 1.0; }
      void main() {
        vec2 tuv = (vW.xz + tHalf) / tSize;
        float th = -80.0;
        if (tuv.x >= 0.0 && tuv.y >= 0.0 && tuv.x <= 1.0 && tuv.y <= 1.0) th = texture2D(depthTex, tuv).r;
        else if (outerSize > 1.0) { vec2 ouv = (vW.xz - outerOrigin) / outerSize; if (ouv.x >= 0.0 && ouv.y >= 0.0 && ouv.x <= 1.0 && ouv.y <= 1.0) th = texture2D(outerTex, ouv).r; }
        float depth = max(0.0, waterLevel - th);
        float dist = length(cameraPosition - vW);
        vec2 p = vW.xz;
        vec3 n = nmap(p / 61.0 + vec2(uTime * 0.011, uTime * 0.007)) + nmap(p / 23.0 - vec2(uTime * 0.016, -uTime * 0.009)) * 0.7 + nmap(p / 260.0 + uTime * 0.002) * 0.8;
        n = normalize(vec3(n.x, 2.6 + dist * 0.0035, n.z));
        vec3 v = normalize(cameraPosition - vW);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        vec3 r = reflect(-v, n);
        vec3 sky = mix(mix(skyHor, skyZen, 0.45), skyZen, pow(clamp(r.y, 0.0, 1.0), 0.45)) * 0.85;
        float sd = max(dot(r, sunDir), 0.0);
        vec3 spec = sunCol * (pow(sd, 900.0) * 30.0 + pow(sd, 90.0) * 0.6) * (1.0 - rough * 0.5);
        // body colour: shallow -> deep, seabed showing through in the shallows
        float dk = 1.0 - exp(-depth * 0.09);
        vec3 body = mix(shallowCol, deepCol, dk);
        body = mix(sandCol * 0.9, body, smoothstep(0.0, 7.0, depth));
        float lit = clamp(dot(vec3(0.0, 1.0, 0.0), sunDir) * 0.8 + 0.2, 0.0, 1.0);
        body *= (amb * 0.55 + lit * length(sunCol) * 0.45);
        vec3 col = mix(body, sky, fres) + spec;
        // shoreline foam: animated bands rolling towards the beach
        float shore = 1.0 - smoothstep(0.0, 1.4, depth);
        float bands = smoothstep(0.55, 0.95, sin(depth * 4.0 - uTime * 1.6 + texture2D(nrm, p / 37.0).r * 4.0) * 0.5 + 0.5);
        float foam = shore * (0.35 + 0.65 * bands) * foamAmt;
        float lightAmt = amb * 0.45 + lit * min(1.0, length(sunCol)) * 0.7;
        col = mix(col, vec3(0.9, 0.93, 0.95) * lightAmt, clamp(foam, 0.0, 1.0) * 0.85);
        col = applyHeightFog(col, vW, fogColor);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.userData.U = U;
  return mat;
}

// ---------- foliage sway (instanced trees) ----------
export function swayMaterial(mat, amount = 0.25) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float sway = sin(uTime * 1.3 + ip.x * 0.05 + ip.z * 0.07) + 0.5 * sin(uTime * 2.7 + ip.z * 0.13);
          transformed.x += sway * ${amount.toFixed(3)} * max(0.0, transformed.y - 1.5) * 0.08;
          transformed.z += sway * ${amount.toFixed(3)} * 0.6 * max(0.0, transformed.y - 1.5) * 0.08;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'sway' + amount;
  return mat;
}
