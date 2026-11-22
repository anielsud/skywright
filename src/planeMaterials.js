// Aircraft-only materials: panelled paint skins, canopy glass, decals, nav/strobe lights, tyres.
// Panel detail lives on uv1, which revolve()/loft() fill in real metres (u = part-local Z, v = around/span);
// the skin shader rescales uv1 by the mesh's own scale so panel lines stay the same size when a part is resized.
import * as THREE from 'three';
import { makeNoise, mulberry32 } from './noise.js';
import { paintSkinDetail, SKIN_TEX_SIZE, SKIN_TILE } from './skinTexture.js';

const cache = new Map();
function cached(key, make) { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); }

export { SKIN_TILE };

// The skin's detail texture (skinTexture.js): painted by a worker while the vehicle is built, so the page doesn't wait
// on it. Until it arrives the canvas is plain paint (no seams or rivets), then it is filled in place.
function skinDetailTexture() {
  return cached('skinTex', () => {
    const S = SKIN_TEX_SIZE, mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
    const c = mk(), ctx = c.getContext('2d');
    const t = new THREE.CanvasTexture(c);
    let w = null;
    try { if (typeof OffscreenCanvas !== 'undefined' && new OffscreenCanvas(1, 1).getContext('2d')) w = new Worker(new URL('./skinWorker.js', import.meta.url), { type: 'module' }); } catch { w = null; }
    if (w) {
      ctx.fillStyle = 'rgb(255,200,0)'; ctx.fillRect(0, 0, S, S); // (R: no seam, G: average roughness, B: no wear)
      const paintHere = () => { if (!w) return; w.terminate(); w = null; ctx.putImageData(paintSkinDetail(mk), 0, 0); t.needsUpdate = true; };
      w.onmessage = (e) => { w.terminate(); w = null; ctx.putImageData(new ImageData(new Uint8ClampedArray(e.data), S, S), 0, 0); t.needsUpdate = true; };
      w.onerror = paintHere;
    } else ctx.putImageData(paintSkinDetail(mk), 0, 0);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / SKIN_TILE, 1 / SKIN_TILE); t.channel = 1; t.anisotropy = 4;
    t.offset.set(0.45 / SKIN_TILE, 0.9 / SKIN_TILE); // uv1 = (0,0) (small primitives) lands on clean panel, away from seams
    return t;
  });
}

// uv1 is in metres of the unscaled part; scale it by the mesh's world scale along part Z (u) and X (v).
// Weathering (uGrime 0..1): dirt collects on surfaces facing down and in the panel seams, rain/oil streaks run down the
// sides (world space, so they follow gravity whatever the part's orientation), and grimy paint loses its gloss.
const GRIME_GLSL = /* glsl */`
  uniform float uGrime; varying vec3 vGrimeW;
  float gH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float gN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(gH(i), gH(i + vec3(1,0,0)), f.x), mix(gH(i + vec3(0,1,0)), gH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(gH(i + vec3(0,0,1)), gH(i + vec3(1,0,1)), f.x), mix(gH(i + vec3(0,1,1)), gH(i + vec3(1,1,1)), f.x), f.y), f.z); }`;
function skinCompile(sh) {
  {
    sh.uniforms.uGrime = { value: this?.userData?.grime ?? 0.32 };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGrimeW;')
      .replace('#include <uv_vertex>', `
    #ifdef USE_BATCHING
    mat4 skinM = modelMatrix * getBatchingMatrix( getIndirectIndex( gl_DrawID ) ); // (a batched plane: acBatch.js)
    #else
    mat4 skinM = modelMatrix;
    #endif
    vec2 uv1M = uv1 * vec2(length(skinM[2].xyz), length(skinM[0].xyz));
    #define uv1 uv1M
    #include <uv_vertex>
    #undef uv1`).replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGrimeW = (skinM * vec4(transformed, 1.0)).xyz;');
    // seams and rivets also darken the paint a little under direct sun (the aoMap alone only dims ambient light)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GRIME_GLSL).replace('#include <color_fragment>', `#include <color_fragment>
    vec3 skinT = texture2D(aoMap, vAoMapUv).rgb;
    diffuseColor.rgb *= mix(1.0, skinT.r, 0.4);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.6, 0.62), skinT.b * 0.55); // chipped paint: bare aluminium
    vec3 gWN = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
    float streak = gN(vec3(vGrimeW.x * 26.0, vGrimeW.y * 1.1, vGrimeW.z * 26.0)) * (0.6 + 0.4 * gN(vGrimeW * 7.0)); // thin vertical runs
    float grime = clamp(smoothstep(0.1, -0.8, gWN.y) * 0.65 + smoothstep(0.55, 0.9, streak) * 0.3 * (1.0 - abs(gWN.y)) + (1.0 - skinT.r) * 1.6, 0.0, 1.0) * uGrime;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.55, 0.46) + vec3(0.035, 0.028, 0.02), grime);
    float dust = smoothstep(0.45, 0.95, gWN.y) * (0.35 + 0.65 * smoothstep(0.35, 0.8, gN(vGrimeW * 45.0))) * uGrime * 0.32; // a fine film of settled dust on top surfaces
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.54, 0.45), dust); grime = max(grime, dust);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n    roughnessFactor = mix(roughnessFactor, 0.82, grime);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n    material.clearcoat *= 1.0 - grime * 0.85;');
  }
}

// Cabin windows for airliner tubes: channel-0 lathe UVs (u along the body 0..1, v around: 0 top, 0.25 right, 0.75 left).
export function windowTexture(count = 40) {
  return cached('win' + count, () => {
    const w = 2048, h = 512, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), exitI = Math.round(count * 0.47);
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    // canvas y = (1 - v) * h because CanvasTexture flips Y; rows sit just above the side midline
    for (const yc of [(1 - 0.236) * h, (1 - 0.764) * h]) {
      // cheatline below the windows
      g.fillStyle = 'rgba(40,52,70,0.55)'; const below = yc > h / 2 ? -1 : 1; // canvas direction of 'down the fuselage side' for this row
      g.fillRect(w * 0.06, yc + below * 17 - 3, w * 0.9, 6);
      for (let i = 0; i < count; i++) {
        const x = w * (0.19 + 0.62 * (i / (count - 1)));
        if (i === exitI) continue; // overwing exit
        g.fillStyle = '#8f98a3'; g.beginPath(); g.roundRect(x - 11, yc - 10, 22, 20, 8); g.fill();
        const gr = g.createLinearGradient(0, yc - 8 * below, 0, yc + 8 * below); gr.addColorStop(0, '#2c3e52'); gr.addColorStop(0.45, '#121a24'); gr.addColorStop(1, '#0b1118');
        g.fillStyle = gr; g.beginPath(); g.roundRect(x - 9, yc - 8, 18, 16, 7); g.fill();
      }
      // doors: front, overwing exit, rear
      g.strokeStyle = '#7d8691'; g.lineWidth = 2;
      for (const [fx, dw, dh] of [[0.15, 70, 76], [0.19 + 0.62 * (exitI / (count - 1)), 38, 46], [0.845, 64, 72]]) { g.beginPath(); g.roundRect(w * fx - dw / 2, yc - dh / 2 + below * 18, dw, dh, 9); g.stroke(); }
      g.fillStyle = '#1b2430'; for (const fx of [0.15, 0.845]) { g.beginPath(); g.roundRect(w * fx - 8, yc - 8, 16, 16, 6); g.fill(); }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

// ---- lights: one shared clock / night factor for every nav light, strobe and beacon ----
export const PLANE_FX = { navTime: { value: 0 }, navNight: { value: 0 } };
// Night is read from the scene the light is drawn in: the world dims environmentIntensity after sunset (0.25 at night),
// the hangar sits at 0.85, so no flight code has to drive it.
function tickFx(renderer, scene) {
  PLANE_FX.navTime.value = performance.now() / 1000;
  const e = scene?.environmentIntensity ?? 1;
  PLANE_FX.navNight.value = 1 - THREE.MathUtils.smoothstep(e, 0.32, 0.6);
}
// One material for every plane light; the kind comes from the geometry (uv.x = 0 wingtip, 1 beacon, 2 landing lens),
// so all lights on a plane share one material (and one merged mesh on parked planes).
const LIGHT_GLSL = `
  vec3 col;
  if (vMode < 0.5) { // wingtip: steady red (left) / green (right) plus a short white strobe flash
    // kept below ~2 so ACES tone mapping doesn't wash the colour out to pastel (green desaturates fastest)
    col = vSide > 0.0 ? vec3(0.0, 1.0, 0.1) * mix(0.9, 1.3, navNight) : vec3(1.0, 0.02, 0.01) * mix(1.3, 1.9, navNight);
    col = mix(col, vec3(1.0, 0.97, 0.92) * mix(4.5, 8.0, navNight), step(fract(navTime / 1.3), 0.045));
  } else if (vMode < 1.5) { // fin beacon: red pulse about once a second
    col = vec3(1.0, 0.03, 0.015) * (0.5 + pow(max(0.0, sin(navTime * 5.6)), 12.0) * mix(2.0, 3.0, navNight));
  } else { // landing light lens: white by day, glowing at night
    col = vec3(1.0, 0.96, 0.87) * mix(1.0, 7.0, navNight);
  }
  vec4 diffuseColor = vec4(col, opacity);`;
export function lightGeometry(geo, mode) {
  const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, mode, 0);
  return geo;
}
function lightMat() {
  return cached('light', () => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true, transparent: true }); // transparent: drawn after the skin and never a shadow caster
    m.onBeforeCompile = (sh) => {
      sh.uniforms.navTime = PLANE_FX.navTime; sh.uniforms.navNight = PLANE_FX.navNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vSide; varying float vMode;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSide = sign(determinant(mat3(modelMatrix))) * sign(position.x); vMode = uv.x;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vSide; varying float vMode; uniform float navTime; uniform float navNight;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', LIGHT_GLSL);
    };
    m.customProgramCacheKey = () => 'planeLight';
    m.onBeforeRender = tickFx;
    return m;
  });
}

const DECAL_VS = (sh) => {
  // registration text reads nose-to-tail on the left side and tail-to-nose on the right (left-to-right for the viewer);
  // the side comes from the normal and the mirror sign, so mirrored and merged (parked) planes read correctly too.
  sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
    #ifdef USE_MAP
      if (sign(determinant(mat3(modelMatrix))) * normal.x > 0.0) vMapUv.x = 1.0 - vMapUv.x;
    #endif`);
};

function regTexture(text, dark) {
  return cached('regTex' + text + dark, () => {
    const w = 1024, h = 256, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.font = 'bold 200px "Arial Narrow", Arial, Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width, k = Math.min(1, (w * 0.94) / tw);
    g.save(); g.translate(w / 2, h / 2 + 8); g.scale(k, 1);
    g.fillStyle = dark ? '#1c2129' : '#f4f4f0'; g.fillText(text, 0, 0); g.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}
function roundelTexture() {
  return cached('roundelTex', () => {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    for (const [rr, col] of [[0.48, '#f2f2ee'], [0.44, '#1d4e89'], [0.29, '#f2f2ee'], [0.15, '#c8102e']]) { g.fillStyle = col; g.beginPath(); g.arc(s / 2, s / 2, rr * s, 0, 7); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}
const decalMat = (key, map) => cached(key, () => {
  const m = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.35, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.onBeforeCompile = DECAL_VS; m.customProgramCacheKey = () => 'decal';
  return m;
});

const lum = (hex) => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };

let _tyre;
function tyreTexture() {
  if (_tyre) return _tyre;
  // TorusGeometry: u runs around the wheel, v around the tube (v = 0/1 is the tread). R = bump, G = roughness.
  // Sidewalls (v ~ 0.25 / 0.75): a moulded rib near the rim and a band of raised lettering.
  const w = 256, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), rnd = mulberry32(7), glyph = [];
  for (let x = 0; x < w; x++) glyph.push((x % 64) < 40 && rnd() < 0.55); // little blocks of 'letters', three words round the tyre
  for (let y = 0; y < h; y++) {
    const v = y / h, d = Math.min(v, 1 - v); // distance from tread centre
    const groove = d < 0.12 && [0.02, 0.06, 0.1].some((q) => Math.abs(d - q) < 0.008);
    for (let x = 0; x < w; x++) {
      const rib = Math.abs(d - 0.31) < 0.006, letter = d > 0.2 && d < 0.24 && glyph[x] && ((y >> 1) + (x >> 2)) % 3 !== 0;
      const R = groove ? 60 : rib ? 255 : letter ? 250 : 230, G = d < 0.13 ? 255 : letter ? 150 : 200;
      const i = (y * w + x) * 4; img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = 0; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _tyre = new THREE.CanvasTexture(c);
  return _tyre;
}

export const PM = {
  // Painted, panelled skin for bodies, wings, tails, cowlings and nacelles (meshes from revolve()/loft() only).
  skin(color, windows = 0) {
    return cached('skin' + color + 'w' + windows, () => {
      const t = skinDetailTexture();
      const m = new THREE.MeshPhysicalMaterial({
        color, metalness: 0.0, roughness: 0.42, clearcoat: 0.85, clearcoatRoughness: 0.1,
        bumpMap: t, bumpScale: 2.2, roughnessMap: t, aoMap: t, aoMapIntensity: 1,
      });
      if (windows) m.map = windowTexture(windows);
      m.onBeforeCompile = skinCompile;
      return m;
    });
  },
  // Car paint: the same skin program (so liveries paint it) over a clean, seamless texture: no aircraft panel grid or
  // rivet rows on a buggy tub or a pickup body (their shut lines are modelled), deeper gloss.
  carPaint(color, finish = 'gloss') {
    return cached('carPaint' + color + finish, () => {
      const t = cached('carTex', () => {
        const c = document.createElement('canvas'); c.width = c.height = 4; const g = c.getContext('2d'); g.fillStyle = 'rgb(255,190,0)'; g.fillRect(0, 0, 4, 4);
        const tx = new THREE.CanvasTexture(c); tx.channel = 1; tx.wrapS = tx.wrapT = THREE.RepeatWrapping; return tx;
      });
      const satin = finish === 'satin', m = new THREE.MeshPhysicalMaterial({ color, metalness: satin ? 0 : 0.1, roughness: satin ? 0.52 : 0.38, clearcoat: satin ? 0.2 : 1, clearcoatRoughness: satin ? 0.45 : 0.05, sheen: satin ? 0.3 : 0, sheenRoughness: 0.6, bumpMap: t, bumpScale: 0, roughnessMap: t, aoMap: t, aoMapIntensity: 1 });
      m.onBeforeCompile = skinCompile; m.userData.grime = 0.75; // ground vehicles live in the dust
      return m;
    });
  },
  // Canopy glass: faint tint where you look straight through, mirror-like at grazing angles (premultiplied
  // blending, so environment reflections add on top instead of being faded by the low opacity).
  canopy: (tint = 0x2c3c4a) => cached('canopy' + tint, () => {
    const m = new THREE.MeshPhysicalMaterial({ color: tint, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.16, clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    m.onBeforeCompile = (sh) => {
      THREE.Material.prototype.onBeforeCompile.call(m, sh); // the shared height-fog uniforms (shaders.js): without them fogEnd is 0 and the glass is all haze from a metre away
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
        float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
        float ga = mix(diffuseColor.a, 0.9, fres);
        gl_FragColor = vec4(totalDiffuse * ga + max(outgoingLight - totalDiffuse, 0.0), ga);`)
        // premultiplied: the haze laid over the glass is only as strong as the glass is opaque
        .replace('#include <fog_fragment>', 'vec3 preFog = gl_FragColor.rgb;\n#include <fog_fragment>\ngl_FragColor.rgb = mix(preFog, gl_FragColor.rgb, gl_FragColor.a);');
    };
    m.customProgramCacheKey = () => 'canopy';
    return m;
  }),
  // Airliner windscreen / dark glazing: opaque, glossy, reflective.
  windscreen: () => cached('wscreen', () => new THREE.MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.2, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.5 })),
  tyre: () => cached('tyre', () => { const t = tyreTexture(); return new THREE.MeshStandardMaterial({ color: 0x1b1b1c, metalness: 0, roughness: 0.92, roughnessMap: t, bumpMap: t, bumpScale: 2 }); }),
  seat: () => cached('seat', () => new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0, roughness: 0.85 })),
  // registration letters (dark on light paint, light on dark paint) and wing roundels
  reg: (text, paint) => { const dark = lum(paint) > 0.35; return decalMat('reg' + text + dark, regTexture(text, dark)); },
  roundel: () => decalMat('roundel', roundelTexture()),
  // wingtip position lights (green right / red left, from the mirror sign, with strobe), fin beacon, landing-light lens; see lightGeometry()
  light: lightMat,
  // bare and treated metals for fittings, lips, nozzles and blades
  metal: (kind = 'brushed') => cached('metal' + kind, () => {
    const o = { brushed: [0xb9bdc3, 0.9, 0.38], polished: [0xd8dbe0, 1, 0.12], hot: [0x5a4a3e, 0.85, 0.42], titanium: [0x7d828a, 0.9, 0.45], anodised: [0x9c8c4e, 0.75, 0.35] }[kind];
    return new THREE.MeshStandardMaterial({ color: o[0], metalness: o[1], roughness: o[2], roughnessMap: brushedTexture() });
  }),
  // propeller blades: matt black with yellow tips from a two-texel map (blade uv.x = 0.25, tip 0.75)
  blade: () => cached('blade', () => {
    const c = document.createElement('canvas'); c.width = 2; c.height = 1; const g = c.getContext('2d');
    g.fillStyle = '#222326'; g.fillRect(0, 0, 1, 1); g.fillStyle = '#f2c300'; g.fillRect(1, 0, 1, 1);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    return new THREE.MeshStandardMaterial({ map: t, metalness: 0.35, roughness: 0.5 });
  }),
  // inside walls of ducts and liners, seen from either side (intake liners, nozzle sleeves, afterburner petals): metal, lit
  // correctly from the inside (three flips the normal on back faces)
  duct: (c = 0x8e9399, kind = 'matte') => cached('duct' + c + kind, () => new THREE.MeshStandardMaterial({ color: c, metalness: kind === 'hot' ? 0.85 : 0.55, roughness: kind === 'hot' ? 0.42 : 0.6, side: THREE.DoubleSide, ...(kind === 'hot' ? { roughnessMap: brushedTexture() } : {}) })),
  // inside of exhaust pipes and stacks: sooty, dull
  exhaust: () => cached('exhaust', () => new THREE.MeshStandardMaterial({ color: 0x0d0c0b, metalness: 0, roughness: 1 })),
  // instrument faces (planar UVs 0..1)
  dial: () => cached('dial', () => new THREE.MeshBasicMaterial({ map: dialTexture() })),
  // decals draped on the skin (0..1 UVs): soot streaks behind exhausts, walkways, worn leading edges, wheel wells
  soot: () => cached('soot', () => decalish({ color: 0x15120f, roughness: 1, alphaMap: sootTexture() })),
  walkway: () => cached('walk', () => decalish({ map: walkwayTexture(), roughness: 0.9 })),
  wear: () => cached('wear', () => decalish({ color: 0xb4b8be, metalness: 0.85, roughness: 0.35, alphaMap: wearTexture() })),
  formation: () => cached('formation', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.5, 0.26) })),
  bay: () => cached('bay', () => decalish({ color: 0x0b0c0d, roughness: 1, transparent: false })),
};

function decalish(o) {
  return new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...o });
}
// Brushed-metal roughness streaks (G channel), planar or cylinder UVs.
let _brushed;
function brushedTexture() {
  if (_brushed) return _brushed;
  const W = 256, c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d'), img = g.createImageData(W, W), rnd = mulberry32(3), row = new Float32Array(W);
  for (let y = 0; y < W; y++) row[y] = rnd();
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const v = 150 + (row[y] - 0.5) * 70 + (rnd() - 0.5) * 20 + Math.sin((x / W) * Math.PI * 2 * 3 + row[(y * 7) % W] * 6) * 8, i = (y * W + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v)); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  _brushed = new THREE.CanvasTexture(c); _brushed.wrapS = _brushed.wrapT = THREE.RepeatWrapping;
  return _brushed;
}
function dialTexture() {
  return cached('dialTex', () => {
    const S = 64, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    g.fillStyle = '#0c0d0f'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#d8d8d0'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 28, 0, 7); g.stroke();
    g.lineWidth = 2; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.beginPath(); g.moveTo(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20); g.lineTo(32 + Math.cos(a) * 26, 32 + Math.sin(a) * 26); g.stroke(); }
    // (the needle is geometry: partDetail.openCockpitBuild, liveDisplays.js)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  });
}
// u = along the streak (0 at the exhaust), v = across (0..1). alphaMap reads G.
function sootTexture() {
  return cached('sootTex', () => {
    const W = 256, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), img = g.createImageData(W, H), n = makeNoise(9);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H - 0.5, streak = 0.75 + 0.25 * n.fbm(u * 3, v * 14, 3);
      const a = Math.pow(1 - u, 1.4) * Math.exp(-(v * v) / (0.02 + u * 0.06)) * streak * Math.min(1, u * 25);
      const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, a * 300)); img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  });
}
// Non-slip walkway: dark grey grit with a black border line, "NO STEP" style hatching ends.
function walkwayTexture() {
  return cached('walkTex', () => {
    const W = 128, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), rnd = mulberry32(21);
    g.fillStyle = 'rgba(52,54,57,1)'; g.fillRect(6, 6, W - 12, H - 12);
    for (let i = 0; i < 2500; i++) { const v = 40 + rnd() * 40 | 0; g.fillStyle = `rgb(${v},${v},${v + 2})`; g.fillRect(6 + rnd() * (W - 12), 6 + rnd() * (H - 12), 1.5, 1.5); }
    g.strokeStyle = '#141414'; g.lineWidth = 4; g.strokeRect(3, 3, W - 6, H - 6);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  });
}
// Leading-edge erosion: solid along the edge (u = 0.5), breaking up into chips towards both borders.
function wearTexture() {
  return cached('wearTex', () => {
    const W = 512, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), img = g.createImageData(W, H), n = makeNoise(13);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.abs(y / H - 0.5) * 2, k = n.fbm(x / 18, y / 6, 3) * 0.5 + 0.5;
      const a = d < 0.35 ? 1 : k > 0.35 + (d - 0.35) * 1.2 ? 1 : 0, i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; return t;
  });
}
