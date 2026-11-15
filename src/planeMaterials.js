// Aircraft-only materials: panelled paint skins, canopy glass, decals, nav/strobe lights, tyres.
// Panel detail lives on uv1, which revolve()/loft() fill in real metres (u = part-local Z, v = around/span);
// the skin shader rescales uv1 by the mesh's own scale so panel lines stay the same size when a part is resized.
import * as THREE from 'three';
import { makeNoise, mulberry32 } from './noise.js';

const cache = new Map();
function cached(key, make) { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); }

export const SKIN_TILE = 2.4; // metres covered by one tile of the panel texture

// One RGBA texture drives three maps: R = height (bump) and seam/rivet occlusion (aoMap), G = roughness factor.
// Layout (1 tile = 2.4 m): two rows of skin panels 1.2 m tall, 0.6 m frame spacing, staggered like real skins,
// rivet rows along every seam and along the middle stringer, plus a few screwed access panels and a filler cap.
function skinDetailTexture() {
  return cached('skinTex', () => {
    const S = 1024, px = S / SKIN_TILE; // pixels per metre
    const hC = document.createElement('canvas'), rC = document.createElement('canvas');
    hC.width = hC.height = rC.width = rC.height = S;
    const h = hC.getContext('2d'), r = rC.getContext('2d');
    h.fillStyle = '#fff'; h.fillRect(0, 0, S, S);
    // roughness: per-panel variation + soft grime
    const rnd = mulberry32(11);
    r.fillStyle = 'rgb(200,200,200)'; r.fillRect(0, 0, S, S);
    const row = 1.2 * px, frame = 0.6 * px;
    for (let ry = 0; ry < 2; ry++) for (let k = 0; k < 4; k++) {
      const x0 = k * frame + (ry ? frame / 2 : 0), y0 = ry * row, v = 180 + rnd() * 50;
      r.fillStyle = `rgb(${v},${v},${v})`;
      for (const dx of [0, -S]) r.fillRect(x0 + dx, y0, frame, row);
    }
    // seams: a groove a few mm wide with a soft shoulder (wrapping at the tile edges)
    const line = (ctx, x0, y0, x1, y1, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { ctx.beginPath(); ctx.moveTo(x0 + ox, y0 + oy); ctx.lineTo(x1 + ox, y1 + oy); ctx.stroke(); } };
    const seam = (x0, y0, x1, y1) => { line(h, x0, y0, x1, y1, 5, 'rgb(215,215,215)'); line(h, x0, y0, x1, y1, 2.2, 'rgb(135,135,135)'); line(r, x0, y0, x1, y1, 4, 'rgb(255,255,255)'); };
    const dot = (ctx, x, y, rad, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(((x % S) + S) % S, ((y % S) + S) % S, rad, 0, 7); ctx.fill(); };
    const rivets = (x0, y0, x1, y1, step = 0.045 * px) => {
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / step));
      for (let i = 0; i <= n; i++) { const t = i / n; dot(h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.3, 'rgb(170,170,170)'); }
    };
    const off = 0.022 * px;
    for (const y of [0, row]) { seam(0, y, S, y); rivets(0, y + off, S, y + off); rivets(0, y - off, S, y - off); }
    for (let ry = 0; ry < 2; ry++) for (let k = 0; k < 4; k++) {
      const x = k * frame + (ry ? frame / 2 : 0), y0 = ry * row, y1 = y0 + row;
      seam(x, y0, x, y1); rivets(x + off, y0 + off, x + off, y1 - off); rivets(x - off, y0 + off, x - off, y1 - off);
    }
    for (const y of [row / 2, row * 1.5]) rivets(0, y, S, y, 0.06 * px); // stringer rows
    // access panels (rounded rectangles with screws) and a filler cap
    const hatch = (cx, cy, w, hh) => {
      h.strokeStyle = 'rgb(110,110,110)'; h.lineWidth = 2; h.beginPath(); h.roundRect(cx - w / 2, cy - hh / 2, w, hh, 6); h.stroke();
      r.strokeStyle = '#fff'; r.lineWidth = 3; r.beginPath(); r.roundRect(cx - w / 2, cy - hh / 2, w, hh, 6); r.stroke();
      for (const sx of [-1, 0, 1]) for (const sy of [-1, 1]) dot(h, cx + sx * (w / 2 - 6), cy + sy * (hh / 2 - 6), 1.8, 'rgb(120,120,120)');
    };
    hatch(0.3 * px, 0.32 * px, 0.26 * px, 0.16 * px);
    hatch(1.62 * px, 1.75 * px, 0.36 * px, 0.2 * px);
    hatch(2.05 * px, 0.85 * px, 0.14 * px, 0.14 * px);
    h.strokeStyle = 'rgb(100,100,100)'; h.lineWidth = 2; h.beginPath(); h.arc(0.95 * px, 2.0 * px, 0.05 * px, 0, 7); h.stroke();
    // combine (R = height/AO, G = roughness with low-frequency grime)
    const H = h.getImageData(0, 0, S, S).data, R = r.getImageData(0, 0, S, S).data;
    const img = h.createImageData(S, S), o = img.data, n = makeNoise(5);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
      const g = n.fbm(Math.cos(a) * 1.3 + 7, Math.sin(a) * 1.3 + Math.cos(b) * 1.1, 4) * 0.5 + n.fbm(Math.sin(b) * 2.2 + 3, Math.cos(b) * 2.2 + Math.sin(a) * 0.8, 3) * 0.5;
      o[i] = H[i]; o[i + 1] = Math.min(255, Math.max(0, R[i] * (0.92 + g * 0.25))); o[i + 2] = 0; o[i + 3] = 255;
    }
    const c = document.createElement('canvas'); c.width = c.height = S; c.getContext('2d').putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / SKIN_TILE, 1 / SKIN_TILE); t.channel = 1; t.anisotropy = 4;
    t.offset.set(0.45 / SKIN_TILE, 0.9 / SKIN_TILE); // uv1 = (0,0) (small primitives) lands on clean panel, away from seams
    return t;
  });
}

// uv1 is in metres of the unscaled part; scale it by the mesh's world scale along part Z (u) and X (v).
function skinCompile(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `
    vec2 uv1M = uv1 * vec2(length(modelMatrix[2].xyz), length(modelMatrix[0].xyz));
    #define uv1 uv1M
    #include <uv_vertex>
    #undef uv1`);
  // seams and rivets also darken the paint a little under direct sun (the aoMap alone only dims ambient light)
  sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    diffuseColor.rgb *= mix(1.0, texture2D(aoMap, vAoMapUv).r, 0.4);`);
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
  const w = 8, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / h, d = Math.min(v, 1 - v); // distance from tread centre
    const groove = d < 0.12 && [0.02, 0.06, 0.1].some((q) => Math.abs(d - q) < 0.008);
    const R = groove ? 60 : 230, G = d < 0.13 ? 255 : 200;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = 0; img.data[i + 3] = 255; }
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
  // Canopy glass: faint tint where you look straight through, mirror-like at grazing angles (premultiplied
  // blending, so environment reflections add on top instead of being faded by the low opacity).
  canopy: (tint = 0x2c3c4a) => cached('canopy' + tint, () => {
    const m = new THREE.MeshPhysicalMaterial({ color: tint, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.16, clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
        float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
        float ga = mix(diffuseColor.a, 0.9, fres);
        gl_FragColor = vec4(totalDiffuse * ga + max(outgoingLight - totalDiffuse, 0.0), ga);`);
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
};
