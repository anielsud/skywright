// Road surface materials (#228): photo asphalt (CC0 ambientCG, tex/roads/, tools/roads/bake_textures.py) tinted per
// region, with the markings drawn in metres by the shader (crisp up close, averaging out to the right grey with
// distance instead of shimmering), worn paint, darker polished wheel tracks, crack sealing on worn blacktop, patch
// repairs and a ragged tarmac edge; and the gravel shoulders either side fading into the ground.
//
// Every road ribbon carries uv = (metres across from its centre line, metres along it) and rinfo = (half width,
// style, seed). style packs what is painted on it (roadStyle): centre line kind + 8 * edge line + 32 * lanes each way.
// Markings follow each place's own rules, from the photos (see the PR for #228):
//   ch (Swiss Alps): light grey asphalt; 15 cm white lines; a dashed white centre line on main roads (6 m dash, 12 m
//     gap; 3 m / 6 m in towns), solid white edge lines on the main roads, nothing on village streets and lanes.
//   us (New York, Arizona): darker blacktop with tar-sealed cracks; 10-15 cm lines; a double yellow centre line on
//     two-way roads (with dashed passing stretches out in the country), white edge lines, dashed white lane lines
//     (3 m dash, 9 m gap: MUTCD's 10 ft / 30 ft); city avenues as one-way, several lanes.
//   fr (French Polynesia): white lines, a dashed centre line (3 m / 10 m), pale coral-sand asphalt.
import * as THREE from 'three';
import { FOG } from './shaders.js';

export const REGION = { alpine: 'ch', lauterbrunnen: 'ch', nyc: 'us', canyon: 'us', islands: 'fr' };
const LOOK = {
  // asphalt tint (linear), how worn (cracks, faded paint), line width, dash/gap (country, town), shoulder gravel tint
  ch: { tint: [0.235, 0.228, 0.215], wear: 0.25, lw: 0.15, dash: [6, 12, 3, 6], yellow: false, gravel: [0.42, 0.41, 0.39] },
  us: { tint: [0.13, 0.125, 0.118], wear: 0.7, lw: 0.13, dash: [3, 9, 3, 9], yellow: true, gravel: [0.48, 0.40, 0.31] },
  fr: { tint: [0.2, 0.192, 0.18], wear: 0.45, lw: 0.12, dash: [3, 10, 3, 10], yellow: false, gravel: [0.55, 0.52, 0.45] },
};
// a place's region's look (the baked layout's materials, layout/runtime.js, follow today's roads')
export const regionLook = (id) => LOOK[REGION[id]] || LOOK.ch;
// centre line kinds
const C_NONE = 0, C_DASH = 1, C_DOUBLE = 2, C_LANES = 3; // C_LANES: one-way, dashed white lane lines only
// edge: 0 none, 1 white both sides, 2 / 3: one carriageway of a divided road, its median on the +x / -x side (US:
// yellow there, white outside; elsewhere white both sides)
export function roadStyle(region, rd, city) {
  const w = rd.width, narrow = w < 6.2 || rd.lane;
  // lanes each way: OSM's lanes where mapped, else from the width
  const perDir = (two) => (rd.lanes ? Math.max(1, Math.round(rd.lanes / (two ? 2 : 1))) : two ? (w >= 13 ? 2 : 1) : w >= 10 ? 3 : w >= 6.5 ? 2 : 1);
  // one-way (OSM's oneway: a divided road's carriageway, most of Manhattan's streets): lane lines only; the left edge
  // (US: yellow, MUTCD) is -x when traffic runs along the road's points (+x is the driver's right), +x when against
  const ow = rd.oneway || (rd.median ? (rd.median > 0 ? -1 : 1) : 0);
  if (ow) { const lanes = Math.min(3, perDir(false)); return (lanes > 1 ? C_LANES : C_NONE) + 8 * (ow > 0 ? 3 : 2) + 32 * lanes; }
  let center = C_NONE, edge = 0;
  const lanes = Math.min(3, perDir(true));
  if (region === 'us') { if (!narrow) { center = C_DOUBLE; edge = city ? (rd.kind === 'highway' ? 1 : 0) : 1; } }
  else if (!narrow && rd.kind !== 'street') { center = C_DASH; edge = region === 'ch' && w >= 7 ? 1 : 0; }
  else if (!narrow && region !== 'ch') center = C_DASH;
  return center + 8 * edge + 32 * lanes;
}

const loader = new THREE.TextureLoader(), cache = new Map();
function tex(name, srgb) {
  if (cache.has(name)) return cache.get(name);
  const t = loader.load(`tex/roads/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, t); return t;
}
export const ROAD_TEXTURE_FILES = ['tex/roads/asphalt_d.jpg', 'tex/roads/asphalt_n.jpg', 'tex/roads/gravel_d.jpg', 'tex/roads/sidewalk_d.jpg'];

const NOISE = /* glsl */`
  float rh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float rn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rh(i), rh(i + vec2(1, 0)), f.x), mix(rh(i + vec2(0, 1)), rh(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { return rn(p) * 0.5 + rn(p * 2.03) * 0.3 + rn(p * 4.1) * 0.2; }
`;

// The tarmac. region: 'ch' | 'us' | 'fr'.
// Street lamps at night (world.js applyLighting: rLamp 0 by day, 1 with every lamp on): their pools of light on the
// tarmac and the pavements, staggered either side of the road about every 28 m (New York's lamp posts, from the night
// photos); far away the pools average into a lit line, so from the air a city's streets draw its grid. All of a
// city's streets; elsewhere the village streets only, dimmer.
export const ROAD_U = { rLamp: { value: 0 } };
const POOL = `
      float lampPool(float v, float x, float hw, float seed, float fv) {
        float sp = 28.0, s = v + seed * 13.0, d = abs(mod(s, sp) - sp * 0.5), side = mod(floor(s / sp), 2.0) * 2.0 - 1.0;
        float pool = exp(-d * d / 50.0) * (0.6 + 0.4 * smoothstep(-hw - 2.0, hw + 2.0, x * side));
        return mix(pool, 0.33, smoothstep(0.15, 0.6, fv / sp));
      }`;
export function tarmacMaterial(region, { city = false } = {}) {
  const L = LOOK[region] || LOOK.ch;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  const U = { rD: { value: tex('asphalt_d', true) }, rN: { value: tex('asphalt_n') }, rTint: { value: new THREE.Color(...L.tint) }, rWear: { value: L.wear },
    rLW: { value: L.lw }, rDash: { value: new THREE.Vector4(...L.dash) }, rYellow: { value: L.yellow ? 1 : 0 }, rRegion: { value: { ch: 0, us: 1, fr: 2 }[region] ?? 0 },
    rLit: { value: city ? 1 : region === 'ch' ? 0.35 : 0.12 }, rCity: { value: city ? 1 : 0 }, rLamp: ROAD_U.rLamp };
  mat.userData.U = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U); // (FOG: the game's height fog, shaders.js installFog: a material with its own hook must add it)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 rinfo; attribute vec4 rjunc; varying vec2 vR; varying vec3 vI; varying vec3 vWP; varying vec4 vJ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = uv; vI = rinfo; vJ = rjunc; vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vR; varying vec3 vI; varying vec3 vWP; varying vec4 vJ; uniform float rRegion; uniform sampler2D rD; uniform sampler2D rN; uniform vec3 rTint; uniform float rWear; uniform float rLW; uniform vec4 rDash; uniform float rYellow; uniform float rLit; uniform float rCity; uniform float rLamp;
      ${NOISE}${POOL}
      // coverage of a line of width w centred at c across x (antialiased; thinner than a pixel: its average)
      // (derivatives taken once, up front: fwidth inside branches or after a discard is undefined)
      float gFx, gFv;
      // coverage of a line of width w centred at c across x (antialiased; thinner than a pixel: its average)
      float lineAA(float x, float c, float w) { float fw = max(gFx, 1e-4), W = max(w, fw); return clamp((W * 0.5 - abs(x - c)) / fw + 0.5, 0.0, 1.0) * (w / W); }
      float dashAA(float v, float dash, float gap) { float p = dash + gap, fw = max(gFv, 1e-4), t = mod(v, p);
        float on = clamp(min(t, dash - t) / fw + 0.5, 0.0, 1.0); return mix(on, dash / p, smoothstep(0.3, 1.0, fw / p)); }`)
      .replace('#include <map_fragment>', `
        float hw = vI.x, st = vI.y, seed = vI.z, x = vR.x, v = vR.y, ax = abs(x);
        gFx = fwidth(x); gFv = fwidth(v);
        // a junction box (junctions.js) is drawn over the junction: the ribbon stops at its mouth (r + 0.6)
        { float dj0 = min(vJ.x, vJ.y), jc0 = vJ.y < vJ.x ? vJ.w : vJ.z; if (jc0 > 0.5 && mod(floor(jc0 / 16.0), 2.0) > 0.5 && dj0 < floor(jc0 / 32.0) / 16.0 + 0.6) discard; }
        float cKind = mod(st, 8.0), edgeOn = mod(floor(st / 8.0), 4.0), lanes = floor(st / 32.0);
        vec2 tp = vec2(x, v) / 3.2; // the photo: 3.2 m square
        vec3 grain = texture2D(rD, tp).rgb * 2.0, nrm = texture2D(rN, tp).rgb;
        float town = step(hw, 3.6);
        // the tarmac's ragged edge: the last 25 cm crumble into the shoulder underneath
        float rag = fbm(vec2(v * 1.7, seed)) * 0.35;
        if (ax > hw - rag * 0.7 + 0.02) discard;
        vec3 col = rTint * grain;
        // patch repairs: now and then a lane-wide stretch of newer, darker tarmac with crisp edges
        float pk = floor(v / 23.0 + seed), pr = rh(vec2(pk, seed * 3.1));
        float patchOn = step(1.0 - 0.07 * rWear, pr) * step(abs(x - (rh(vec2(pk, 7.0)) - 0.5) * hw), hw * 0.45) * step(fract(v / 23.0 + seed), 0.35 + 0.5 * rh(vec2(pk, 9.0)));
        col *= mix(1.0, 0.86, patchOn);
        // large-scale tone (old and new surfacing, dirt), and the wheel tracks: darker and polished
        col *= 0.88 + 0.24 * fbm(vec2(x * 0.15, v * 0.02 + seed));
        float laneW = cKind > 2.5 ? 2.0 * hw / max(lanes, 1.0) : hw / max(lanes, 1.0);
        float lx = mod(cKind > 2.5 ? x + hw : ax, laneW) - laneW * 0.5, tracks = smoothstep(0.55, 0.2, abs(abs(lx) - 0.85)) * (1.0 - town * 0.5);
        col *= 1.0 - 0.13 * tracks; float oil = smoothstep(0.5, 0.0, abs(lx)) * 0.1; col *= 1.0 - oil;
        // cracks, sealed with tar (US: tar snakes), fewer on the Swiss roads
        float crack = smoothstep(0.35, 0.8, nrm.b) * smoothstep(0.35, 0.65, fbm(vec2(x * 0.08 + seed, v * 0.01))) * rWear;
        col = mix(col, vec3(0.025), crack * 0.85 * (1.0 - patchOn));
        // markings
        float lw = rLW, dashC = mix(rDash.x, rDash.z, town), gapC = mix(rDash.y, rDash.w, town);
        float paint = 0.0, yel = 0.0;
        if (cKind > 0.5 && cKind < 1.5) paint = lineAA(x, 0.0, lw) * dashAA(v, dashC, gapC);
        if (cKind > 1.5 && cKind < 2.5) { // double yellow; out in the country, a dashed passing stretch on one side now and then
          float pass = step(0.6, rn(vec2(v / 400.0, seed))), side = step(0.5, rh(vec2(floor(v / 400.0), seed)));
          float l1 = lineAA(x, -lw, lw) * mix(1.0, dashAA(v, rDash.x, rDash.y), pass * side), l2 = lineAA(x, lw, lw) * mix(1.0, dashAA(v, rDash.x, rDash.y), pass * (1.0 - side));
          yel = max(l1, l2) * rYellow; paint = max(l1, l2) * (1.0 - rYellow);
        }
        if (lanes > 1.5) { // lane lines: dashed white between the lanes (on each side of the centre on a two-way road)
          float n = lanes, oneWay = step(2.5, cKind);
          for (int k = 1; k < 4; k++) { if (float(k) >= n) break;
            float c = oneWay > 0.5 ? -hw + 2.0 * hw * float(k) / n : hw * float(k) / n;
            paint = max(paint, lineAA(oneWay > 0.5 ? x : ax, c, lw) * dashAA(v, rDash.z, rDash.w)); }
        }
        // junctions (rjunc, roads.js junctionPoints): the nearer one, its clearance r and flags
        bool nextNear = vJ.y < vJ.x; float dj = min(vJ.x, vJ.y), jc = nextNear ? vJ.w : vJ.z, jr = floor(jc / 32.0) / 16.0, jf = mod(jc, 32.0);
        float jStop = mod(jf, 2.0), jWalk = mod(floor(jf / 2.0), 2.0), mouthP = mod(floor(jf / 4.0), 2.0), mouthN = mod(floor(jf / 8.0), 2.0);
        float inJ = jc > 0.5 ? 1.0 - smoothstep(jr - 0.3, jr + 0.3, dj) : 0.0; // inside the crossing road: no lines
        paint *= 1.0 - inJ; yel *= 1.0 - inJ;
        float mouth = jc > 0.5 ? 1.0 - smoothstep(jr + 1.0, jr + 1.6, dj) : 0.0; // the edge lines open for the side road
        float edgeP = 1.0 - mouth * mouthP, edgeN = 1.0 - mouth * mouthN;
        if (edgeOn > 0.5 && edgeOn < 1.5) paint = max(paint, lineAA(ax, hw - 0.35, lw) * (x > 0.0 ? edgeP : edgeN));
        if (edgeOn > 1.5) { // a divided road's carriageway: the median side yellow (US), the outside white
          float ms = edgeOn < 2.5 ? 1.0 : -1.0, med = lineAA(x * ms, hw - 0.5, lw), outer = lineAA(x * ms, -(hw - 0.35), lw);
          paint = max(paint, outer); yel = max(yel, med * rYellow); paint = max(paint, med * (1.0 - rYellow)); }
        // crossings and the line where traffic stops or gives way, on the approach to a junction
        float jPaint = 0.0, jYel = 0.0;
        if (jc > 0.5) {
          float wc = rRegion > 0.5 && rRegion < 1.5 ? 3.0 : 4.0, c0 = jr + 0.6, c1 = c0 + wc, fwv = max(gFv, 1e-4);
          float band = jWalk * clamp((dj - c0) / fwv + 0.5, 0.0, 1.0) * clamp((c1 - dj) / fwv + 0.5, 0.0, 1.0);
          if (band > 0.0) { // zebra bars along the road: white 0.6 / 0.6 m (US), yellow 0.5 / 0.5 m (Swiss), white (France)
            float per = rRegion > 0.5 && rRegion < 1.5 ? 1.2 : 1.0, bar = lineAA(mod(x + hw + 0.25, per), per * 0.5, per * 0.5) * step(ax, hw - 0.3);
            if (rRegion < 0.5) jYel = band * bar; else jPaint = band * bar;
            paint *= 1.0 - band; yel *= 1.0 - band;
          }
          float r0 = jWalk > 0.5 ? c1 + 1.0 : c0, oneWay = step(2.5, cKind) + step(1.5, edgeOn);
          float lane = oneWay > 0.5 ? step(ax, hw - 0.3) : (nextNear ? step(0.15, x) : step(x, -0.15)) * step(ax, hw - 0.3);
          if (jStop > 0.5 && lane > 0.0) {
            if (rRegion > 0.5 && rRegion < 1.5) { // US: a solid white stop line, 45 cm
              jPaint = max(jPaint, clamp((dj - r0) / fwv + 0.5, 0.0, 1.0) * clamp((r0 + 0.45 - dj) / fwv + 0.5, 0.0, 1.0) * lane);
            } else { // Swiss / French: give way, a row of triangles pointing at the oncoming driver
              float t = (dj - r0) / 0.6, u = abs(fract(x / 1.0) - 0.5);
              jPaint = max(jPaint, step(0.0, t) * step(t, 1.0) * clamp((0.25 * (1.0 - t) - u) / max(gFx, 1e-4) + 0.5, 0.0, 1.0) * lane);
            }
            paint *= 1.0 - step(abs(dj - r0 - 0.3), 0.6) * lane;
          }
        }
        paint = max(paint, jPaint); yel = max(yel, jYel);
        // worn paint: thinned where the tyres run, and patchy
        float wear = rWear * (0.35 + 0.65 * fbm(vec2(x * 3.0, v * 0.7) + seed)) * (0.5 + 0.5 * tracks);
        float keep = 1.0 - smoothstep(0.25, 0.75, wear) * 0.8;
        paint *= keep * (1.0 - patchOn * 0.6); yel *= keep;
        vec3 white = vec3(0.78), yellow = vec3(0.78, 0.52, 0.08);
        col = mix(col, white * (0.92 + 0.08 * grain.r), paint);
        col = mix(col, yellow * (0.92 + 0.08 * grain.r), yel);
        diffuseColor.rgb = col;
        float rPaint = max(paint, yel);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(0.96, 0.84, tracks), 0.7, rPaint) - 0.04 * patchOn;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.44) * (0.4 + 3.5 * lampPool(v, x, hw, seed, gFv)) * rLamp * rLit * mix(town, 1.0, rCity);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec2 g = (nrm.rg * 2.0 - 1.0) * (0.55 - 0.35 * rPaint); vec3 tn = normalize(vec3(g.x, 1.0, -g.y));
          // the ribbon lies flat along the road: its world normal is up, tilted by the profile; add the grain on top
          normal = normalize(normal + (viewMatrix * vec4(tn.x, 0.0, tn.z, 0.0)).xyz); }`);
  };
  mat.customProgramCacheKey = () => 'tarmac4-' + region;
  return mat;
}

// The gravel shoulders (the verges either side of the tarmac): a band of gravel and dust whose outer part breaks up
// into the ground beside it (dithered, so no sorting of transparent strips).
export function shoulderMaterial(region) {
  const L = LOOK[region] || LOOK.ch;
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const U = { gD: { value: tex('gravel_d', true) }, gTint: { value: new THREE.Color(...L.gravel) } };
  mat.userData.U = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U); // (FOG: the game's height fog, shaders.js installFog: a material with its own hook must add it)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 rinfo; varying vec2 vR; varying vec3 vI;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = uv; vI = rinfo;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vR; varying vec3 vI; uniform sampler2D gD; uniform vec3 gTint;
      ${NOISE}`)
      .replace('#include <map_fragment>', `
        float hw = vI.x, x = abs(vR.x) - hw, v = vR.y; // x: metres out from the tarmac edge (0 .. VERGE)
        float outK = clamp(x / 1.5, 0.0, 1.0), n = fbm(vec2(v * 0.6, vI.z + vR.x * 0.4));
        if (outK > 0.35 + 0.6 * n) discard; // breaks up into the ground (and grass)
        vec3 col = gTint * texture2D(gD, vec2(vR.x, v) / 1.6).rgb * 2.0 * (0.85 + 0.3 * n);
        col *= mix(0.8, 1.0, smoothstep(0.0, 0.25, x)); // the tarmac's shadow line
        diffuseColor.rgb = col;
      `);
  };
  mat.customProgramCacheKey = () => 'shoulder2-' + region;
  return mat;
}

// A city's pavements (#228): a granite kerb 15 cm up from the gutter, then concrete slabs (1.5 m, with their joints) to
// the building line. uv = (metres across from the road's centre line, metres along); rinfo as the tarmac's (half width);
// rjunc as the tarmac's: the pavement stops at a junction's clearance, where the crossing is, on the side(s) its mouth is on.
export function sidewalkMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  const U = { sD: { value: tex('sidewalk_d', true) }, rLamp: ROAD_U.rLamp };
  mat.userData.U = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 rinfo; attribute vec4 rjunc; varying vec2 vR; varying vec3 vI; varying vec4 vJ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = uv; vI = rinfo; vJ = rjunc;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vR; varying vec3 vI; varying vec4 vJ; uniform sampler2D sD; uniform float rLamp;
      ${NOISE}${POOL}`)
      .replace('#include <map_fragment>', `
        float hw = vI.x, x = abs(vR.x) - hw, v = vR.y; // x: metres out from the kerb's face
        float gFv = fwidth(v), gFx = fwidth(x);
        float dj = min(vJ.x, vJ.y), jc = vJ.y < vJ.x ? vJ.w : vJ.z, jr = floor(jc / 32.0) / 16.0, jBox = mod(floor(jc / 16.0), 2.0);
        float jf = mod(jc, 32.0), jSide = vR.x > 0.0 ? mod(floor(jf / 4.0), 2.0) : mod(floor(jf / 8.0), 2.0); // (the mouth on this side of the road: on a road passing a T, its far side's pavement carries on)
        if (jc > 0.5 && jSide > 0.5 && dj < jr + 0.3 + 0.3 * jBox) discard; // (the junction: the crossing's open roadway; a box's mouth, where its corner pavement takes over)
        vec3 conc = vec3(0.47, 0.465, 0.45) * texture2D(sD, vec2(vR.x, v) / 2.4).rgb * 2.0;
        // slabs: joints every 1.5 m along and across, a little darker and soiled; some slabs a shade off
        vec2 sl = vec2(x - 0.35, v) / 1.5, f = abs(fract(sl) - 0.5) * 1.5;
        float joint = max(smoothstep(0.73 - max(gFx, gFv), 0.75, f.x), smoothstep(0.73 - max(gFx, gFv), 0.75, f.y)) * step(0.35, x);
        conc *= 0.9 + 0.2 * rh(floor(sl) + vI.z);
        conc *= 1.0 - joint * 0.35;
        conc *= 0.88 + 0.12 * fbm(vec2(vR.x, v) * 0.35);
        // the kerb: granite, a band 35 cm wide (top and face)
        float kerb = 1.0 - step(0.35, x);
        vec3 granite = vec3(0.38, 0.37, 0.36) * (0.85 + 0.3 * rh(floor(vec2(v * 0.8, 3.0))));
        diffuseColor.rgb = mix(conc, granite, kerb);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.44) * (0.3 + 2.4 * lampPool(v, vR.x, hw, vI.z, gFv)) * rLamp;`);
  };
  mat.customProgramCacheKey = () => 'sidewalk3';
  return mat;
}

// The ways off the street network (roads.js rd.minor) and the plazas, one material for both of their looks (one draw a
// road tile): paving (pedestrian streets, squares and paved footpaths: pavers with sanded joints, no markings, flush
// with the ground) or gravel (farm tracks: compacted gravel with two wheel ruts and a grassy crown, ragged edges).
// (Alleys and other asphalt ones are drawn with the tarmac, with nothing painted.) uv = (metres across, metres along)
// on a ribbon, world (x, z) on a plaza; rinfo as the tarmac's: half width (a plaza: 1e4, no edge band), the look (1
// paving, 2 gravel: roadnet.js SURF), seed; rjunc as the tarmac's (where it meets a street). The pavers follow each place's look: New York's
// grey concrete pavers (60 x 30 cm, running bond), granite setts in the Swiss villages (16 x 12 cm), pale pavers in
// Bora Bora.
const PAVING = {
  ch: { tint: [0.45, 0.42, 0.38], size: [0.16, 0.12], vary: 0.28, joint: 0.5 },
  us: { tint: [0.50, 0.49, 0.47], size: [0.6, 0.3], vary: 0.12, joint: 0.35 },
  fr: { tint: [0.58, 0.55, 0.50], size: [0.4, 0.2], vary: 0.14, joint: 0.35 },
};
export function pathMaterial(region) {
  const L = LOOK[region] || LOOK.ch, P = PAVING[region] || PAVING.ch;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }); // (under a street's tarmac, -4, where the two overlap: the street's mouth)
  const U = { pD: { value: tex('sidewalk_d', true) }, gD: { value: tex('gravel_d', true) }, pTint: { value: new THREE.Color(...P.tint) }, gTint: { value: new THREE.Color(...L.gravel) },
    pSize: { value: new THREE.Vector2(...P.size) }, pVary: { value: P.vary }, pJoint: { value: P.joint }, rLamp: ROAD_U.rLamp };
  mat.userData.U = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, FOG, U); // (FOG: the game's height fog: a material with its own hook must add it)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 rinfo; attribute vec4 rjunc; varying vec2 vR; varying vec3 vI; varying vec4 vJ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = uv; vI = rinfo; vJ = rjunc;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vR; varying vec3 vI; varying vec4 vJ; uniform sampler2D pD; uniform sampler2D gD; uniform vec3 pTint; uniform vec3 gTint; uniform vec2 pSize; uniform float pVary; uniform float pJoint; uniform float rLamp;
      ${NOISE}${POOL}`)
      .replace('#include <map_fragment>', `
        float hw = vI.x, x = vR.x, v = vR.y, ax = abs(x), seed = vI.z, gravel = step(1.5, vI.y); // (rinfo.y: 1 paving, 2 gravel)
        float gFx = fwidth(x), gFv = fwidth(v), gF = max(gFx, gFv); // (derivatives up front: not inside branches or after a discard)
        // where it meets a street (rjunc as the tarmac's, roads.js junctionsFromNodes: a box's flag): it stops at the street's edge
        { float dj = min(vJ.x, vJ.y), jc = vJ.y < vJ.x ? vJ.w : vJ.z; if (jc > 0.5 && mod(floor(jc / 16.0), 2.0) > 0.5 && dj < floor(jc / 32.0) / 16.0 + 0.6) discard; }
        vec3 col;
        if (gravel > 0.5) {
          float n = fbm(vec2(v * 0.5, seed + x * 0.3));
          if (ax > hw - 0.45 * n) discard; // ragged edges, into the grass
          col = gTint * vec3(0.92, 0.86, 0.74) * texture2D(gD, vec2(x, v) / 1.8).rgb * 2.0 * (0.8 + 0.32 * fbm(vec2(x * 0.4, v * 0.15 + seed))); // (a track's dust: browner than the shoulders' grit)
          // two wheel ruts, compacted and darker; between them, on a narrow track, grass coming through the crown
          float rut = smoothstep(0.35, 0.1, abs(ax - min(0.8, hw * 0.45)));
          col *= 1.0 - 0.24 * rut;
          float crown = (1.0 - smoothstep(0.25, 0.5, ax)) * step(hw, 2.2) * smoothstep(0.35, 0.7, fbm(vec2(x * 2.0, v * 0.8) + seed));
          col = mix(col, vec3(0.16, 0.2, 0.08) * (0.8 + 0.4 * n), crown * 0.75);
          float edge = smoothstep(hw - 0.9, hw - 0.2, ax) * smoothstep(0.3, 0.6, fbm(vec2(x * 1.7, v * 1.3) + seed * 2.0));
          col = mix(col, vec3(0.17, 0.2, 0.09), edge * 0.6);
        } else {
          // pavers in running bond: rows across the way (v), every other row shifted half a paver
          vec2 q = vec2(v, x) / pSize; float row = floor(q.y); q.x += 0.5 * mod(row, 2.0);
          vec2 id = floor(q), f = fract(q), e = min(f, 1.0 - f) * pSize; // (metres to the paver's edges)
          float fade = 1.0 - smoothstep(0.03, 0.12, gF); // (far off: the joints and the pavers' shades average out)
          float joint = (1.0 - smoothstep(0.006, 0.006 + gF, min(e.x, e.y))) * fade;
          col = pTint * texture2D(pD, vec2(x, v) / 2.4).rgb * 2.0;
          col *= 1.0 + pVary * (rh(id + seed) - 0.5) * 2.0 * fade;
          col *= 0.86 + 0.14 * fbm(vec2(x, v) * 0.3 + seed); // grime, the worn lines people walk
          col *= 1.0 - joint * pJoint;
          // a ribbon's edge: a band of granite kerb-stones laid flush
          float band = step(hw - 0.22, ax) * step(hw, 9000.0);
          col = mix(col, vec3(0.36, 0.355, 0.35) * (0.85 + 0.3 * rh(vec2(floor(v / 0.8), seed))), band);
        }
        diffuseColor.rgb = col;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.86, 1.0, gravel);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.44) * (0.3 + 1.6 * lampPool(v, x, min(hw, 6.0), seed, gFv)) * rLamp * 0.8 * (1.0 - gravel);`);
  };
  mat.customProgramCacheKey = () => 'path3-' + region;
  return mat;
}
