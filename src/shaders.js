// Shared shader upgrades: height fog with sun in-scattering, terrain splatting, water, foliage sway.
import * as THREE from 'three';
import { TERRAIN_DETAIL_GLSL } from './terrainTex.js';
import { SKY_LOOKUP_GLSL, PLANET } from './sky.js';

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
  // aerial perspective: distant things fade towards the actual sky colour in their direction (sky-view LUT),
  // with blue light scattered in sooner than red
  skyLUT: { value: null },
  fogSkyMix: { value: 0 },
  fogExt: { value: new THREE.Vector3(1, 1, 1) },
  // distance (m) by which everything has faded fully into the haze: the edge of the far terrain
  fogEnd: { value: 1e9 },
  // flying high (space.js): 0 near the ground (none of this runs), 1 from ~16 km up. Things below the camera then take the
  // real air between them and us from the sky-view table, and the edge of the world fades into the planet (its ground map).
  fogSpace: { value: 0 }, fogGMap: PLANET.gmap,
};

export const FOG_GLSL = /* glsl */`
  uniform vec3 fogSunDir; uniform vec3 fogSunColor; uniform float fogBase; uniform float fogFalloff; uniform float fogLin;
  uniform sampler2D skyLUT; uniform float fogSkyMix; uniform vec3 fogExt; uniform float fogEnd; uniform float fogSpace; uniform vec3 fogGMap;
  ${SKY_LOOKUP_GLSL}
  // the colour fully hazed-out things take on, looking along vd (also what the sky dome shows below the horizon)
  vec3 fogTarget(vec3 vd, vec3 fogCol, out vec3 ext) {
    float s = max(dot(vd, fogSunDir), 0.0);
    // a black fog colour means "fade to black" (additive particles): no sky tint then
    float sm = fogSkyMix * step(1e-4, fogCol.r + fogCol.g + fogCol.b);
    vec3 base = fogCol;
    ext = vec3(1.0);
    if (sm > 0.001) {
      // looking down, the haze between us and the ground is the colour of the horizon in that direction
      vec2 hd = vd.xz / max(length(vd.xz), 1e-4);
      float el = max(vd.y, 0.03);
      float hc = sqrt(1.0 - el * el);
      vec3 sky = skyLook(skyLUT, vec3(hd.x * hc, el, hd.y * hc));
      sky = sky / (1.0 + max(max(sky.r, sky.g), sky.b) * 0.25); // keep the low sun's glow out of bloom range
      base = mix(fogCol, sky, sm);
      ext = mix(vec3(1.0), fogExt, sm);
    }
    return base + fogSunColor * (pow(s, 8.0) * 0.55 + pow(s, 48.0) * 0.6) * (1.0 - sm * 0.6);
  }
  vec3 applyHeightFog(vec3 col, vec3 wp, vec3 fogCol) {
    vec3 rd = wp - cameraPosition;
    float dist = length(rd);
    float h0 = cameraPosition.y - fogBase, h1 = wp.y - fogBase;
    float k = fogFalloff, dh = h1 - h0;
    float e0 = exp(-k * max(h0, -200.0));
    float integ = abs(dh) > 1.0 ? (e0 - exp(-k * max(h1, -200.0))) / (k * dh) : e0;
    // a little haze at any height, so from high up the far land still fades with distance (aerial perspective) ...
    float od = fogLin * dist * clamp(integ, 0.3, 4.0);
    // ... and is gone completely by the edge of the far terrain, which then meets the sky below the horizon seamlessly
    float fend = max(fogEnd, 1.0), fe = clamp((dist - fend * 0.45) / (fend * 0.55), 0.0, 1.0);
    od += fe * fe * 8.0;
    vec3 vd = rd / max(dist, 1e-3);
    vec3 ext;
    vec3 fc = fogTarget(vd, fogCol, ext);
    vec3 amt = 1.0 - exp(-od * ext);
    vec3 res = mix(col, fc, amt);
    if (fogSpace > 0.0 && vd.y < 0.0) {
      // from high up, looking down: the table gives the light scattered into the whole air column down to sea level and
      // how much gets through it; this point sees the share of that column between it and us (air thins ~8 km per e-fold)
      vec4 L = skyLookFull(skyLUT, vd);
      float m0 = exp(-max(cameraPosition.y, 0.0) / 8000.0), mp = exp(-max(wp.y, 0.0) / 8000.0);
      float fr = clamp((mp - m0) / max(1.0 - m0, 1e-4), 0.0, 1.0);
      vec3 T = pow(vec3(max(L.a, 1e-3)), vec3(0.4279, 1.0, 2.4414)), Tf = pow(T, vec3(fr));
      vec3 phys = col * Tf + L.rgb * (1.0 - Tf) / max(1.0 - T, vec3(1e-3));
      float feh = clamp((length(wp.xz - cameraPosition.xz) - fend * 0.7) / (fend * 0.3), 0.0, 1.0); // (by ground distance up here)
      phys = mix(phys, L.rgb + T * groundMap(skyLUT, wp.xz, fogGMap), feh * feh); // the world's far edge melts into the planet
      res = mix(res, phys, fogSpace * smoothstep(0.0, 0.03, L.a));
    }
    return res;
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
  const real = !!maps.detailU?.satHi; // real-world location: satellite imagery replaces the baked ground colour
  const U = { albedoTex: { value: maps.albedo }, normTex: { value: maps.normal }, shadowTex: { value: maps.shadow },
    tOrig: { value: maps.orig }, tSpan: { value: maps.span }, sOrig: { value: maps.sOrig || maps.orig }, sSpan: { value: maps.sSpan || maps.span },
    shadowOn: { value: maps.shadowOn ?? 1 }, patchRect: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) }, ...maps.detailU };
  mat.userData.U = U;
  // real-world: no beach detail and no baked hydrology (the imagery has both); keeps the terrain within 16 texture
  // units with Ultra's extra shadow maps. Elsewhere the baked rivers/lakes map is one more sampler (see world.js).
  mat.defines = real ? { TERRAIN_NO_SAND: '' } : { TERRAIN_LAND: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vTW; uniform sampler2D albedoTex; uniform sampler2D normTex; uniform sampler2D shadowTex;
      uniform vec2 tOrig; uniform float tSpan; uniform vec2 sOrig; uniform float sSpan; uniform float shadowOn; uniform vec4 patchRect;
      #ifdef TERRAIN_LAND
      uniform sampler2D landTex; uniform float landOn; uniform float landDry; uniform vec2 landOrig; uniform float landSpan; uniform vec3 waterTint; uniform float uTime;
      #endif
      ${TERRAIN_DETAIL_GLSL}
      ${real ? REAL_SAT_GLSL : ''}
      ${(!real && maps.detailU?.glsl) || 'vec3 fieldShade(vec2 p, float farm, vec3 base, float dist, out float isField) { isField = 0.0; return base; }'}`)
      .replace('#include <map_fragment>', `
        ${patch ? '' : 'if (vTW.x > patchRect.x && vTW.x < patchRect.z && vTW.z > patchRect.y && vTW.z < patchRect.w) discard;'}
        vec2 tuv = (vTW.xz - tOrig) / tSpan; // texel centres sit exactly on the bake grid points
        vec4 alb = texture2D(albedoTex, tuv);
        vec4 nrmS = texture2D(normTex, tuv);
        vec3 wn = normalize(nrmS.xyz * 2.0 - 1.0);
        ${real ? 'alb.rgb = realGround(satColor(vTW.xz), wn); alb.a = mix(1.0, alb.a, 0.5); nrmS.a = 0.0;' : ''}
        float terrainShadow = mix(1.0, texture2D(shadowTex, (vTW.xz - sOrig) / sSpan).r, shadowOn);
        float dist = length(vTW - cameraPosition);
        // farm parcels (farmland mask in the normal map's alpha), crisp up close
        float isField; alb.rgb = fieldShade(vTW.xz, nrmS.a, alb.rgb, dist, isField);
        vec3 mul, dn; terrainDetail(vTW, wn, dist, mul, dn);
        // snow keeps the relief but not the photo colour
        float snowy = smoothstep(0.55, 0.72, min(alb.r, min(alb.g, alb.b)));
        mul = mix(mul, vec3(0.92 + 0.08 * dot(mul, vec3(0.333))), snowy);
        mul = mix(mul, vec3(1.0) + (mul - 1.0) * 0.6, isField); // fields: their own colour, softer photo texture
        wn = dn;
        // rivers, streams and lakes from the baked hydrology: a still or flowing water surface with wet banks
        float tRough = -1.0, river = 0.0;
        #ifdef TERRAIN_LAND
        if (landOn > 0.5) {
          vec4 land = texture2D(landTex, (vTW.xz - landOrig) / landSpan);
          float aa = fwidth(land.r) * 0.75 + 0.02;
          float steep = smoothstep(0.22, 0.45, 1.0 - normalize(nrmS.xyz * 2.0 - 1.0).y); // mountain streams: white water, not mirrors
          river = smoothstep(0.5 - aa, 0.5 + aa, land.r) * (1.0 - landDry) * (1.0 - steep);
          float bank = smoothstep(0.06, 0.45, land.r) * (1.0 - river) * (1.0 - landDry);
          float wetG = smoothstep(0.62, 0.85, land.a) * (1.0 - landDry) * (1.0 - snowy);
          alb.rgb *= 1.0 - bank * 0.35 - wetG * 0.12;
          if (bank + wetG > 0.0) tRough = mix(0.93, 0.45, max(bank, wetG * 0.6));
          if (river > 0.0) {
            // ripples drifting downstream-ish, fading to a mirror with distance
            vec2 rp = vTW.xz / 9.0;
            vec2 rn = (texture2D(gN, rp + vec2(uTime * 0.05, uTime * 0.031)).xy + texture2D(gN, rp * 1.7 - vec2(uTime * 0.04, -uTime * 0.06)).xy - 1.0) * 0.12 * (1.0 - smoothstep(60.0, 900.0, dist));
            wn = normalize(mix(wn, normalize(vec3(rn.x, 1.0, rn.y)), river));
            mul = mix(mul, vec3(1.0), river);
            alb.rgb = mix(alb.rgb, waterTint, river);
            alb.a = mix(alb.a, 1.0, river);
            tRough = mix(tRough < 0.0 ? 0.93 : tRough, 0.06, river);
          }
        }
        #endif
        // snow glitter: tiny facets catching the sun up close
        if (snowy > 0.5 && dist < 220.0) { vec2 gc = floor(vTW.xz * 2.5); float gl = fract(sin(dot(gc, vec2(12.9898, 78.233))) * 43758.5453); if (gl > 0.985) tRough = 0.08; }
        diffuseColor.rgb = alb.rgb * mul * (0.6 + 0.4 * alb.a) * 1.12;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (tRough >= 0.0) roughnessFactor = tRough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = snrm((viewMatrix * vec4(wn, 0.0)).xyz);`)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= terrainShadow;'));
  };
  mat.customProgramCacheKey = () => (patch ? 'terrain3-patch-' : 'terrain3-') + (real ? 'real' : maps.detailU?.key || '');
  return mat;
}

// Real-world locations (src/realworld.js): two nested squares of satellite imagery, the detailed one fading into
// the coarse one at its edge. Mipmapped, so from high up it stays smooth.
const REAL_SAT_GLSL = /* glsl */`
  uniform sampler2D satHi; uniform sampler2D satFar; uniform vec4 satHiR; uniform vec4 satFarR;
  vec3 satColor(vec2 p) {
    vec2 u = (p - satHiR.xy) * satHiR.z, v = clamp((p - satFarR.xy) * satFarR.z, 0.0, 1.0);
    float e = min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y));
    vec3 far = texture2D(satFar, v).rgb, hi = texture2D(satHi, clamp(u, 0.0, 1.0)).rgb; // both sampled always: mip derivatives stay valid
    return mix(far, hi, smoothstep(0.0, 0.01, e));
  }
  // the photo already has the light and shadow of the moment it was taken (satSun): take some of that out, so the
  // game's own sun does the shading, and lift it to the game's ground brightness
  uniform vec3 satSun; uniform float satGain; uniform float satDeshade;
  vec3 realGround(vec3 c, vec3 n) {
    float lit = max(dot(n, satSun), 0.0) * 0.75 + 0.25, ref = max(satSun.y, 0.2) * 0.75 + 0.25;
    float k = mix(1.0, clamp(ref / lit, 0.65, 2.0), satDeshade);
    // shade in the photo is lit by the blue sky: lifting it must not turn hillsides blue
    float sh = smoothstep(1.0, 1.6, k);
    // Sentinel-2 greens read cool next to the game's warm sunlight: warm the darker (vegetated) ground a little
    float veg = 1.0 - smoothstep(0.08, 0.3, dot(c, vec3(0.3, 0.59, 0.11)));
    c *= vec3(1.0 + 0.05 * veg, 1.0 + 0.02 * veg, 1.0 - 0.2 * veg);
    // cliffs: seen from above the satellite hardly sees a wall, and smears the meadow above / forest below down it
    float cliff = smoothstep(0.42, 0.7, 1.0 - n.y) * (1.0 - smoothstep(0.35, 0.6, dot(c, vec3(0.3, 0.59, 0.11))));
    c = mix(c, vec3(0.15, 0.14, 0.125) * (0.8 + 0.4 * fract(sin(dot(floor(n.xz * 9.0), vec2(12.9, 78.2))) * 43758.5)), cliff * 0.75);
    c *= vec3(1.0 + 0.06 * sh, 1.0 + 0.03 * sh, 1.0 - 0.3 * sh);
    return min(c * k * satGain, vec3(0.92));
  }`;

// ---------- water ----------
// Two materials share one set of uniforms (o.U): the big plane (open water, and the core's fully-wet grid cells) and,
// with o.shore, the core's shore mesh (World.buildShoreWater), whose edge is the shoreline itself.
export function waterMaterial(o) {
  const U = o.U || {
    // ground heights for the shore, shallows and foam: the fine baked grid (World.heightTex), relative to the water level
    fineTex: { value: o.fine.tex }, fineGrid: { value: o.fine.grid },
    outerTex: { value: null }, outerOrigin: { value: new THREE.Vector2(0, 0) }, outerSize: { value: 1 }, nrm: { value: o.normal }, waterLevel: { value: o.level },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) }, skyZen: { value: new THREE.Color(0.3, 0.5, 0.8) },
    skyHor: { value: new THREE.Color(0.7, 0.8, 0.9) }, amb: { value: 1 }, deepCol: { value: new THREE.Color(o.deep) }, shallowCol: { value: new THREE.Color(o.shallow) },
    sandCol: { value: new THREE.Color(o.sand) }, fogColor: { value: new THREE.Color(0, 0, 0) }, foamAmt: { value: o.foam ?? 1 }, rough: { value: 0.35 }, reef: { value: o.reef ?? 0 },
    // tile-grid cells known to be dry land all over (farfield.js): no water drawn there at all
    farMask: { value: null }, farMaskOrigin: { value: new THREE.Vector2() }, farMaskSize: { value: 0 }, farCell: { value: 1 },
  };
  if (!o.U) Object.assign(U, FOG);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, defines: o.shore ? { WATER_SHORE: '' } : {},
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D fineTex; uniform vec4 fineGrid; uniform mat4 projectionMatrix;
      uniform sampler2D outerTex; uniform vec2 outerOrigin; uniform float outerSize; uniform sampler2D nrm; uniform float waterLevel;
      uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 skyZen; uniform vec3 skyHor; uniform float amb;
      uniform vec3 deepCol; uniform vec3 shallowCol; uniform vec3 sandCol; uniform vec3 fogColor; uniform float foamAmt; uniform float rough; uniform float uTime; uniform float reef;
      float wh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wh(i), wh(i + vec2(1.0, 0.0)), f.x), mix(wh(i + vec2(0.0, 1.0)), wh(i + 1.0), f.x), f.y); }
      uniform sampler2D farMask; uniform vec2 farMaskOrigin; uniform float farMaskSize; uniform float farCell;
      varying vec3 vW;
      ${FOG_GLSL}
      vec3 nmap(vec2 p) { return texture2D(nrm, p).xzy * 2.0 - 1.0; }
      // Ground height relative to the water on the core's fine grid, interpolated over the triangles the ground is
      // drawn with (PlaneGeometry's split (a,b,d) + (b,c,d), as World.triAt). wet: is the whole grid cell under water?
      // grid: world x,z of vertex (0,0), 1/spacing, cells.
      float fineH(vec2 p, out bool wet) {
        vec2 f = clamp((p - fineGrid.xy) * fineGrid.z, vec2(0.0), vec2(fineGrid.w - 0.001));
        ivec2 i = ivec2(floor(f)); vec2 u = f - vec2(i);
        float a = texelFetch(fineTex, i, 0).r, b = texelFetch(fineTex, i + ivec2(0, 1), 0).r, c = texelFetch(fineTex, i + ivec2(1, 1), 0).r, d = texelFetch(fineTex, i + ivec2(1, 0), 0).r;
        wet = max(max(a, b), max(c, d)) < 0.0;
        return u.x + u.y <= 1.0 ? a + (d - a) * u.x + (b - a) * u.y : c + (b - c) * (1.0 - u.x) + (d - c) * (1.0 - u.y);
      }
      void main() {
        float th = -80.0; // ground under this point, relative to the water level
        bool wet = true;
        vec2 cf = (vW.xz - fineGrid.xy) * fineGrid.z;
        bool core = cf.x >= 0.0 && cf.y >= 0.0 && cf.x <= fineGrid.w && cf.y <= fineGrid.w;
        if (core) th = fineH(vW.xz, wet);
        #ifdef WATER_SHORE
        th = min(th, 0.0); // the mesh is the water: right at its edge the ground meets it
        #else
        // In the core the plane only draws grid cells that are under water all over; the shore mesh draws the rest
        // (and overlaps a ring of wet cells, so there is never a gap between them). Outside, the streamed tiles' heights.
        if (core) { if (!wet) discard; }
        else if (outerSize > 1.0) { vec2 ouv = (vW.xz - outerOrigin) / outerSize; if (ouv.x >= 0.0 && ouv.y >= 0.0 && ouv.x <= 1.0 && ouv.y <= 1.0) th = texture2D(outerTex, ouv).r; }
        if (th > 0.02) discard;
        #endif
        // beyond the depth maps: tile-grid cells known to be dry land all over (farfield.js)
        #ifndef WATER_SHORE
        if (farMaskSize > 0.0) {
          vec2 muv = (floor(vW.xz / farCell) - farMaskOrigin + 0.5) / farMaskSize;
          if (muv.x > 0.0 && muv.y > 0.0 && muv.x < 1.0 && muv.y < 1.0) { float m = floor(texture2D(farMask, muv).r * 3.0 + 0.5); if (mod(m, 2.0) > 0.5) discard; }
        }
        #endif
        float depth = max(0.0, -th);
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
        // seabed showing through: sand with ripples, and on the islands coral heads and patch reefs in the shallows
        vec3 seabed = sandCol * 0.9;
        float coral = 0.0;
        if (reef > 0.0 && depth > 0.2 && depth < 16.0 && dist < 25000.0) {
          float rn = vnoise(p / 46.0) * 0.55 + vnoise(p / 13.0) * 0.3 + vnoise(p / 3.7) * 0.15;
          coral = smoothstep(0.5, 0.6, rn) * smoothstep(16.0, 5.0, depth) * smoothstep(0.2, 1.0, depth) * reef;
          seabed = mix(seabed * (0.92 + 0.16 * vnoise(p / 2.1)), vec3(0.19, 0.16, 0.11) + vec3(0.05, 0.08, 0.02) * vnoise(p / 5.0), coral * 0.8);
        }
        body = mix(seabed, body, smoothstep(0.0, 7.0 + coral * 5.0, depth));
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
        // Where it IS water, it wins the depth test against ground less than lift metres above the water. Beyond the
        // detail patch the ground is the coarse ~50 m mesh, whose nearly-level shore triangles stick out over (or sink
        // under) the fine-grid shore by up to a metre or so: seen at a glancing angle they poked through the shallows
        // as flat sheets and flickered against it. The depth written is that of the point on this view ray lift metres
        // above the water: a vertical tolerance, so it works at any angle (a depth offset along the ray, or
        // polygonOffset, is worth nothing at a glancing angle). It grows with distance, as the ground's error does, and
        // stays a small fraction of the camera's height, so from just above the water nothing in front is covered.
        {
          vec3 toCam = cameraPosition - vW;
          float lift = min(clamp(dist * 0.00025, 0.02, 1.2), max(toCam.y, 0.0) * 0.1);
          vec4 cp = projectionMatrix * viewMatrix * vec4(vW + toCam * (lift / max(toCam.y, 0.01)), 1.0);
          gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
        }
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
