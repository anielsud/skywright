// Photo detail for the ground: CC0 aerial texture sets from Poly Haven (polyhaven.com, CC0, by Rob Tuytel et al.)
// in tex/. Used by both the baked core terrain and the streamed outer tiles. The macro colour (location palette,
// snowline, forests, fields) still comes from the baked albedo / vertex colours; the photos add structure and relief:
// each texture is divided by its own average colour so it modulates the macro colour rather than replacing it.
import * as THREE from 'three';
import { fieldGLSL } from './landcover.js';

const SETS = {
  alpine: { ground: 'aerial_grass_rock', rock: 'aerial_rocks_02' },
  islands: { ground: 'aerial_grass_rock', rock: 'aerial_rocks_02' },
  canyon: { ground: 'dry_ground_rocks', rock: 'cliff_side' },
};
const SAND = 'aerial_beach_01';
const cache = new Map();
const loader = new THREE.TextureLoader();
function tex(name, srgb) {
  if (cache.has(name)) return cache.get(name);
  const t = loader.load(`tex/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, t); return t;
}

// Uniforms for a location. waterLevel drives the beach (sand) band. The land-map uniforms (rivers, lakes) are filled
// in by World.landUniforms. The location's field palette GLSL rides along as a non-enumerable .glsl property.
export function terrainDetailUniforms(locId, waterLevel, snowline = 99999, quality = 'medium') {
  const s = SETS[locId] || SETS.alpine;
  const U = {
    gD: { value: tex(s.ground + '_d', true) }, gN: { value: tex(s.ground + '_n') },
    rD: { value: tex(s.rock + '_d', true) }, rN: { value: tex(s.rock + '_n') },
    sD: { value: tex(SAND + '_d', true) }, sN: { value: tex(SAND + '_n') },
    tWater: { value: waterLevel }, tDetail: { value: 1 }, tSnow: { value: snowline },
    // stochastic (hex-tile) sampling of the ground photos kills visible repeats; 3x the texture reads, so laptop tiers only
    tHex: { value: quality === 'high' || quality === 'ultra' ? 1 : 0 },
    tVarnish: { value: locId === 'canyon' ? 1 : 0 }, // desert varnish streaks down the canyon walls
    landTex: { value: null }, landOn: { value: 0 }, landDry: { value: 0 }, landOrig: { value: new THREE.Vector2() }, landSpan: { value: 1 },
    waterTint: { value: new THREE.Color(...(WATER[locId] || WATER.alpine)) },
  };
  Object.defineProperty(U, 'glsl', { value: fieldGLSL(locId), enumerable: false });
  Object.defineProperty(U, 'key', { value: locId, enumerable: false });
  return U;
}
// river / lake body colour (linear): glacial milky teal in the Alps, clear green on the islands, silty in the desert
const WATER = { alpine: [0.035, 0.085, 0.085], islands: [0.02, 0.07, 0.065], canyon: [0.06, 0.06, 0.04] };
export const TEXTURE_FILES = [...new Set(Object.values(SETS).flatMap((s) => [s.ground, s.rock]).concat(SAND))].flatMap((n) => [`tex/${n}_d.jpg`, `tex/${n}_n.jpg`]);

// GLSL: terrainDetail(world pos, macro world normal, macro colour, out colour multiplier, out normal).
// Ground and sand are projected from above (2 scales, to break up tiling); rock is triplanar with
// whiteout normal blending (Ben Golus), so cliffs aren't smeared.
export const TERRAIN_DETAIL_GLSL = /* glsl */`
  uniform sampler2D gD; uniform sampler2D gN; uniform sampler2D rD; uniform sampler2D rN;
  #ifndef TERRAIN_NO_SAND
  uniform sampler2D sD; uniform sampler2D sN;
  #endif
  uniform float tWater; uniform float tDetail; uniform float tSnow; uniform float tHex; uniform float tVarnish;
  float tvh(vec2 p) { return fract(sin(dot(p, vec2(41.37, 289.13))) * 23421.631); }
  float tvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(tvh(i), tvh(i + vec2(1.0, 0.0)), f.x), mix(tvh(i + vec2(0.0, 1.0)), tvh(i + 1.0), f.x), f.y); }
  // Hex-tile stochastic texturing (after Mikkelsen 2022, offsets only): three randomly offset reads blended over a
  // triangle grid, so a photo never visibly repeats. The gradients come from the unperturbed uv (no mip seams).
  vec2 hexOff(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
  void hexGrid(vec2 uv, out vec3 w, out vec2 o1, out vec2 o2, out vec2 o3) {
    vec2 sk = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv * 3.4641016);
    vec2 b = floor(sk); vec3 t = vec3(fract(sk), 0.0); t.z = 1.0 - t.x - t.y;
    vec2 v1, v2, v3;
    if (t.z > 0.0) { w = vec3(t.z, t.y, t.x); v1 = b; v2 = b + vec2(0.0, 1.0); v3 = b + vec2(1.0, 0.0); }
    else { w = vec3(-t.z, 1.0 - t.y, 1.0 - t.x); v1 = b + 1.0; v2 = b + vec2(1.0, 0.0); v3 = b + vec2(0.0, 1.0); }
    w = pow(w, vec3(6.0)); w /= w.x + w.y + w.z;
    o1 = hexOff(v1); o2 = hexOff(v2); o3 = hexOff(v3);
  }
  vec4 hexTex(sampler2D t, vec2 uv, vec3 w, vec2 o1, vec2 o2, vec2 o3) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    return textureGrad(t, uv + o1, dx, dy) * w.x + textureGrad(t, uv + o2, dx, dy) * w.y + textureGrad(t, uv + o3, dx, dy) * w.z;
  }
  // normalize that never returns NaN (degenerate skirt / silhouette pixels would otherwise poison bloom)
  vec3 snrm(vec3 v) { float l = length(v); return l > 1e-5 ? v / l : vec3(0.0, 1.0, 0.0); }
  vec3 avgOf(sampler2D t) { return max(textureLod(t, vec2(0.5), 12.0).rgb, vec3(0.04)); }
  vec3 udn(vec3 n, vec2 tn, float k) { return snrm(vec3(n.x + tn.x * k, n.y, n.z + tn.y * k)); }
  void terrainDetail(vec3 p, vec3 wn, float dist, out vec3 mul, out vec3 nOut) {
    wn = snrm(wn);
    float fade = (1.0 - smoothstep(1800.0, 7000.0, dist)) * tDetail;
    if (fade <= 0.0) { mul = vec3(1.0); nOut = wn; return; }
    // ground: near pair (26 m x 140 m, rotated so repeats don't line up), far pair (140 m x 900 m), crossfaded by distance
    float far = smoothstep(250.0, 1600.0, dist);
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    vec2 u1 = p.xz / 26.0, u2 = rot * p.xz / 140.0 + 0.37, u3 = rot * rot * p.xz / 900.0 + 0.11;
    vec3 gAvg = avgOf(gD);
    vec4 c1, c2, n1, n2;
    if (tHex > 0.5) {
      vec3 w1, w2; vec2 a1, a2, a3, b1, b2, b3; hexGrid(u1 * 0.5, w1, a1, a2, a3); hexGrid(u2 * 0.5, w2, b1, b2, b3);
      c1 = hexTex(gD, u1, w1, a1, a2, a3); n1 = hexTex(gN, u1, w1, a1, a2, a3);
      c2 = hexTex(gD, u2, w2, b1, b2, b3); n2 = hexTex(gN, u2, w2, b1, b2, b3);
    } else { c1 = texture2D(gD, u1); n1 = texture2D(gN, u1); c2 = texture2D(gD, u2); n2 = texture2D(gN, u2); }
    vec3 t2 = c2.rgb / gAvg;
    vec3 g = mix(sqrt((c1.rgb / gAvg) * t2), sqrt(t2 * (texture2D(gD, u3).rgb / gAvg)), far);
    vec2 gn = (n1.xy * 2.0 - 1.0) * 0.6 * (1.0 - far) + (n2.xy * 2.0 - 1.0) * 0.4;
    vec3 n = udn(wn, gn, 0.9);
    vec3 c = g;
    // beach (real-world locations skip it: the imagery shows beaches, and the texture slots are needed for Ultra's shadow cascades)
    #ifndef TERRAIN_NO_SAND
    float sand = 1.0 - smoothstep(tWater + 1.5, tWater + 4.5, p.y);
    if (sand > 0.0) {
      vec3 sa = texture2D(sD, p.xz / 18.0).rgb / avgOf(sD);
      vec2 sn = texture2D(sN, p.xz / 18.0).xy * 2.0 - 1.0;
      c = mix(c, sa, sand); n = snrm(mix(n, udn(wn, sn, 0.7), sand));
    }
    #endif
    // rock on steep ground, triplanar
    float rock = smoothstep(0.18, 0.4, 1.0 - wn.y);
    if (rock > 0.0) {
      vec3 bw = pow(abs(wn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
      // colour at 34 m and 300 m (crossfaded by distance); relief normals only up close
      float s = 34.0, S2 = 300.0; vec3 rAvg = avgOf(rD);
      vec3 rcN = texture2D(rD, p.zy / s).rgb * bw.x + texture2D(rD, p.xz / s).rgb * bw.y + texture2D(rD, p.xy / s).rgb * bw.z;
      vec3 rcF = texture2D(rD, p.zy / S2).rgb * bw.x + texture2D(rD, p.xz / S2).rgb * bw.y + texture2D(rD, p.xy / S2).rgb * bw.z;
      vec3 rc = mix(sqrt(rcN * rcF), rcF, far) / rAvg;
      vec3 rn = wn;
      if (far < 1.0) {
        vec3 tx = texture2D(rN, p.zy / s).xyz * 2.0 - 1.0, ty = texture2D(rN, p.xz / s).xyz * 2.0 - 1.0, tz = texture2D(rN, p.xy / s).xyz * 2.0 - 1.0;
        tx = vec3(tx.xy + wn.zy, abs(tx.z) * wn.x); ty = vec3(ty.xy + wn.xz, abs(ty.z) * wn.y); tz = vec3(tz.xy + wn.xy, abs(tz.z) * wn.z);
        rn = snrm(mix(snrm(tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z), wn, far));
      }
      // desert varnish: dark manganese streaks running down the walls from the rims
      if (tVarnish > 0.0) {
        float along = dot(p.xz, normalize(vec2(-wn.z, wn.x) + 1e-4)); // horizontal coordinate along the wall
        float st = tvn(vec2(along / 5.0, p.y / 70.0)) * 0.65 + tvn(vec2(along / 1.7, p.y / 25.0)) * 0.35;
        float band = smoothstep(0.35, 0.75, tvn(vec2(along / 40.0, p.y / 18.0)));
        rc *= 1.0 - tVarnish * smoothstep(0.45, 0.8, st) * (0.25 + 0.3 * band) * smoothstep(0.35, 0.6, 1.0 - wn.y);
      }
      // bare grey rock near and above the snowline: no moss up there
      rc = mix(rc, vec3(dot(rc, vec3(0.3, 0.5, 0.2))), smoothstep(tSnow - 450.0, tSnow - 50.0, p.y));
      c = mix(c, rc, rock); n = snrm(mix(n, rn, rock));
    }
    c = mix(c, vec3(dot(c, vec3(0.3, 0.5, 0.2))), smoothstep(tSnow - 100.0, tSnow + 150.0, p.y));
    mul = mix(vec3(1.0), c, fade); nOut = snrm(mix(wn, n, fade));
  }`;
