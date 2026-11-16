// Liveries: paint schemes drawn over a vehicle's panelled skin (stripes, flames, sharkmouths, checkerboards, racing
// numbers, airline titles...). A design names one with design.livery = 'id'; applyLivery() (called at the end of
// planeDetail.assemble) swaps each painted-skin material for a livery variant of it.
//
// Every layer lives in VEHICLE space (metres, forward -Z, up +Y, right +X), so it paints straight across part
// boundaries, fillets and junction skins, whatever geometry the parts end up with. Each skin vertex gets its rest
// position in vehicle space (attribute livPos); the fragment shader evaluates the layers there. A layer only paints
// the parts its `on` list names (part ids, categories, or 'body' = fuselages, cockpits, nose and tail cones), so a
// stripe along the body doesn't spill onto a wing passing through the same space.
//
// Layer types (all take `on`, `color`, optional `alpha`, `absx` (mirror across the centreline: |x|) and `box`
// {min:[x,y,z], max:[x,y,z]} to clip):
//   band    : paint where dot(P, dir) + off is in [lo, hi]; with `period` the band repeats (stripes); `wave` (amplitude)
//             and `waveLen` make the edge wavy along Z.
//   checker : checkerboard of `color`/`color2`, `cell` metres, projected 'side' (z,y), 'top' (x,z), 'front' (x,y) or
//             'around' a body of revolution (z, angle × `radius`, axis at height `axisY`).
//   flames  : hot-rod flames licking back from z0 for len metres, centred on height yc, half-height h, n tongues.
//   decal   : a drawing from the livery's `art` (canvas) projected 'side', 'top' or 'front'; at = plane centre
//             (side: [z, y], top: [x, z], front: [x, y]), size = [w, h] in metres; text: true reads correctly
//             from both sides; glow: k makes the drawing self-lit (k × its colour, by its alpha): stars that shine.
// `finish` rules change the paint itself: { on, kind: 'matte' | 'satin' | 'deep' | 'metal' | 'chrome' }.
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { PM } from './planeMaterials.js';

export const LIVERIES = {};
export const liveryOf = (design) => LIVERIES[design?.livery] || null;

const MAXL = 24;
const TYPE = { band: 1, checker: 2, flames: 3, decal: 4 };
const PROJ = { side: 0, top: 1, front: 2, around: 3 };

// ---------- shader ----------
const LIV_GLSL = /* glsl */`
  uniform highp sampler2D livData; uniform sampler2D livArt; uniform int livMask; uniform int livN;
  varying vec3 vLivPos;
  vec3 livGlow = vec3(0.0); // self-lit paint (glowing decals), added to the emissive light
  float livHash(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
  vec3 livery(vec3 base) {
    vec3 P = vLivPos, dpx = dFdx(P), dpy = dFdy(P);
    vec3 N = normalize(cross(dpx, dpy)); // geometric outward normal (vehicle space)
    float px = max(length(dpx), length(dpy)) + 1e-5; // metres per pixel, for soft edges
    vec3 col = base;
    for (int i = 0; i < ${MAXL}; i++) {
      if (i >= livN) break;
      if ((livMask & (1 << i)) == 0) continue;
      vec4 t0 = texelFetch(livData, ivec2(0, i), 0), t1 = texelFetch(livData, ivec2(1, i), 0), A = texelFetch(livData, ivec2(2, i), 0), B = texelFetch(livData, ivec2(3, i), 0);
      vec3 bmin = texelFetch(livData, ivec2(4, i), 0).xyz, bmax = texelFetch(livData, ivec2(5, i), 0).xyz;
      int type = int(t0.x + 0.5), fl = int(t0.y + 0.5), proj = int(t0.z + 0.5);
      vec3 Q = (fl & 1) != 0 ? vec3(abs(P.x), P.y, P.z) : P;
      if (any(lessThan(Q, bmin)) || any(greaterThan(Q, bmax))) continue;
      vec3 c = t1.rgb; float a = 0.0;
      vec2 uv = proj == 0 ? Q.zy : proj == 1 ? Q.xz : Q.xy;
      if (type == 1) { // band / stripes
        float g = length(A.xyz), v = dot(Q, A.xyz) + A.w + t0.w * sin(Q.z * t0.z), w = px * g + B.w; // (optional wavy edge)
        if (B.z > 0.0) v = mod(v, B.z);
        a = smoothstep(B.x - w, B.x + w, v) * (1.0 - smoothstep(B.y - w, B.y + w, v));
      } else if (type == 2) { // checkerboard
        if (proj == 3) uv = vec2(Q.z, atan(Q.x, Q.y - B.w) * A.w); // around the body (radius A.w, axis height B.w)
        vec2 cell = floor((uv - A.yz) / A.x);
        c = mod(cell.x + cell.y, 2.0) < 0.5 ? t1.rgb : B.rgb; a = 1.0;
      } else if (type == 3) { // flames: u from the front (0) to the longest tip (1), v across (-1..1)
        float u = (Q.z - A.x) / A.y, v = proj == 0 ? (Q.y - A.z) / A.w : Q.x / A.w;
        if (u > -0.02 && u < 1.0 && abs(v) < 1.15) {
          float n = B.x, f = (v * 0.5 + 0.5) * n + 0.18 * sin(u * 7.0 + v * 2.0) * u, k = floor(f), fr = fract(f) - 0.5;
          float L = 0.45 + 0.55 * livHash(k + B.y), t = u / L;
          float wdt = 0.55 * pow(max(0.0, 1.0 - t), 0.65) * (0.8 + 0.4 * smoothstep(0.0, 0.25, u)) + 0.25 * (1.0 - smoothstep(0.0, 0.18, u));
          float tongueW = 2.0 * A.w / n, e = px / tongueW, d = wdt - abs(fr); // distance inside the tongue (tongue units)
          float rim = 0.045 / tongueW; // outline thickness (metres -> tongue units)
          a = smoothstep(-e, e, d) * smoothstep(1.15, 1.0, abs(v));
          vec3 hot = mix(vec3(1.0, 0.86, 0.12), vec3(1.0, 0.42, 0.02), smoothstep(0.05, 0.55, t));
          hot = mix(hot, vec3(0.86, 0.06, 0.02), smoothstep(0.5, 0.95, t));
          c = mix(c, hot, smoothstep(rim - e, rim + e, d));
        }
      } else if (type == 4) { // decal from the art atlas
        float face = abs(proj == 0 ? N.x : proj == 1 ? N.y : N.z); // both faces: clip with the box where that matters
        vec2 p = proj == 1 ? vec2(Q.x, -Q.z) : proj == 2 ? vec2(-Q.x, Q.y) : uv;
        vec2 ctr = proj == 1 ? vec2(A.x, -A.y) : proj == 2 ? vec2(-A.x, A.y) : A.xy;
        vec2 d = (p - ctr) / A.zw + 0.5;
        if (face > 0.15 && all(greaterThan(d, vec2(0.0))) && all(lessThan(d, vec2(1.0)))) {
          bool flip = (fl & 2) != 0 && (proj == 0 ? N.x > 0.0 : P.x > 0.0); // side text reads right from whichever side you look at it (N faces the viewer): no mirrored text on the inside of a wing endplate
          if (flip) d.x = 1.0 - d.x;
          vec2 sz = B.zw - B.xy, tuv = B.xy + d * sz;
          vec2 gx = (proj == 0 ? dpx.zy : proj == 1 ? vec2(dpx.x, -dpx.z) : vec2(-dpx.x, dpx.y)) / A.zw * sz;
          vec2 gy = (proj == 0 ? dpy.zy : proj == 1 ? vec2(dpy.x, -dpy.z) : vec2(-dpy.x, dpy.y)) / A.zw * sz;
          if (flip) { gx.x = -gx.x; gy.x = -gy.x; }
          vec4 tx = textureGrad(livArt, tuv, gx, gy);
          c = tx.rgb; a = tx.a * smoothstep(0.15, 0.35, face);
          livGlow += c * a * t0.w;
        }
      }
      col = mix(col, c, clamp(a * t1.a, 0.0, 1.0));
    }
    return col;
  }`;

function liveryCompile(base, L, mask) {
  return function (sh, r) {
    base.onBeforeCompile.call(this, sh, r);
    sh.uniforms.livData = { value: L.data }; sh.uniforms.livArt = { value: L.art }; sh.uniforms.livMask = { value: mask }; sh.uniforms.livN = { value: L.n };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 livPos; varying vec3 vLivPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLivPos = livPos;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + LIV_GLSL)
      .replace('#include <map_fragment>', 'diffuseColor.rgb = livery(diffuseColor.rgb);\n#include <map_fragment>')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += livGlow;');
  };
}

// ---------- compiling a livery: layer table (float texture) + art atlas ----------
const lin = (hex) => new THREE.Color(hex); // working (linear) colour from an sRGB hex
let blankArt = null;
function compile(id) {
  const def = LIVERIES[id];
  if (def._c) return def._c;
  const layers = def.layers.slice(0, MAXL), n = layers.length, buf = new Float32Array(6 * 4 * Math.max(1, n));
  const art = def.art ? drawArt(def.art) : null;
  layers.forEach((l, i) => {
    const o = i * 24, set = (k, a) => buf.set(a, o + k * 4), c = lin(l.color ?? 0xffffff);
    const proj = PROJ[l.proj || 'side'];
    set(0, [TYPE[l.type], (l.absx ? 1 : 0) | (l.text ? 2 : 0), l.type === 'band' ? (2 * Math.PI) / (l.waveLen || 1) : proj, l.type === 'band' ? l.wave || 0 : l.type === 'decal' ? l.glow || 0 : 0]);
    set(1, [c.r, c.g, c.b, l.alpha ?? 1]);
    if (l.type === 'band') { set(2, [...(l.dir || [0, 1, 0]), l.off || 0]); set(3, [l.lo ?? -1e6, l.hi ?? 1e6, l.period || 0, l.soft || 0]); }
    if (l.type === 'checker') { const c2 = lin(l.color2 ?? 0x111111); set(2, [l.cell || 0.3, ...(l.origin || [0, 0]), l.radius || 1]); set(3, [c2.r, c2.g, c2.b, l.axisY || 0]); }
    if (l.type === 'flames') { set(2, [l.z0, l.len, l.yc || 0, l.h]); set(3, [l.n || 5, l.seed || 1, 0, 0]); }
    if (l.type === 'decal') {
      const r = art?.rects[l.art]; if (!r) console.warn('livery art missing', id, l.art);
      set(2, [...l.at, ...l.size]); set(3, r || [0, 0, 0, 0]);
    }
    set(4, l.box?.min || [-1e6, -1e6, -1e6]); set(5, l.box?.max || [1e6, 1e6, 1e6]);
  });
  const data = new THREE.DataTexture(buf, 6, Math.max(1, n), THREE.RGBAFormat, THREE.FloatType);
  data.needsUpdate = true;
  if (!art && !blankArt) { blankArt = new THREE.DataTexture(new Uint8Array(4), 1, 1); blankArt.needsUpdate = true; }
  def._c = { data, art: art ? art.tex : blankArt, n, layers, mats: new Map() };
  return def._c;
}

// art: { key: { w, h, draw(ctx, w, h) } } packed into one canvas (shelf packing, 1024 wide)
function drawArt(items) {
  const W = 1024, pad = 6, rects = {}, place = []; let x = pad, y = pad, rowH = 0;
  for (const [k, it] of Object.entries(items)) {
    if (x + it.w + pad > W) { x = pad; y += rowH + pad * 2; rowH = 0; }
    place.push([k, it, x, y]); x += it.w + pad * 2; rowH = Math.max(rowH, it.h);
  }
  const H = Math.min(2048, 2 ** Math.ceil(Math.log2(y + rowH + pad)));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  for (const [k, it, px, py] of place) {
    g.save(); g.translate(px, py); g.beginPath(); g.rect(0, 0, it.w, it.h); g.clip(); it.draw(g, it.w, it.h); g.restore();
    rects[k] = [px / W, 1 - (py + it.h) / H, (px + it.w) / W, 1 - py / H]; // flipY: v from the bottom
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return { tex, rects };
}

// ---------- applying ----------
const BODYISH = new Set(['x_nosecone', 'x_tailcone']);
function matches(on, p, i) {
  if (!on || on === 'all') return true;
  const d = PARTS[p.id];
  return on.some((k) => k === i || k === p.id || k === d.cat || (k === 'body' && (d.cat === 'fuselage' || d.cat === 'cockpit' || BODYISH.has(p.id))));
}
let SKIN_HOOK = null;
const isSkin = (m) => m && m.isMeshPhysicalMaterial && m.onBeforeCompile === SKIN_HOOK;
const FINISH = {
  gloss: {}, satin: { roughness: 0.5, clearcoat: 0.45 }, matte: { roughness: 0.7, clearcoat: 0.08, clearcoatRoughness: 0.5 },
  metal: { metalness: 0.95, roughness: 0.3, clearcoat: 0.3 }, chrome: { metalness: 1, roughness: 0.12, clearcoat: 0.6 },
  deep: { roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.5 }, // soft, dark: reflections don't grey out a black paint job
};
function liveryMaterial(L, base, mask, finish) {
  const key = base.uuid + '|' + mask + '|' + finish;
  if (L.mats.has(key)) return L.mats.get(key);
  const m = base.clone();
  Object.assign(m, FINISH[finish] || {});
  m.onBeforeCompile = liveryCompile(base, L, mask);
  m.customProgramCacheKey = () => 'skinLivery2';
  L.mats.set(key, m);
  return m;
}

const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
// objs[i]: the built object of design part i, all under root (see planeDetail.assemble).
export function applyLivery(design, objs, root) {
  const def = liveryOf(design); if (!def) return;
  SKIN_HOOK ??= PM.skin(0xffffff).onBeforeCompile;
  const L = compile(design.livery);
  root.updateMatrixWorld(true); _inv.copy(root.matrixWorld).invert();
  design.parts.forEach((p, i) => {
    const obj = objs[i]; if (!obj || !PARTS[p.id]) return;
    let mask = 0; L.layers.forEach((l, k) => { if (matches(l.on, p, i)) mask |= 1 << k; });
    const fin = (def.finish || []).find((f) => matches(f.on, p, i))?.kind || 'gloss';
    if (!mask && fin === 'gloss') return;
    obj.traverse((o) => {
      if (!o.isMesh || !isSkin(o.material)) return;
      const g = o.geometry.clone(), pos = g.attributes.position, lp = new Float32Array(pos.count * 3);
      _m.multiplyMatrices(_inv, o.matrixWorld);
      for (let k = 0; k < pos.count; k++) { _v.fromBufferAttribute(pos, k).applyMatrix4(_m); lp[k * 3] = _v.x; lp[k * 3 + 1] = _v.y; lp[k * 3 + 2] = _v.z; }
      g.setAttribute('livPos', new THREE.BufferAttribute(lp, 3));
      o.geometry = g; o.material = liveryMaterial(L, o.material, mask, fin);
    });
  });
}

// ---------- art helpers ----------
const FONT = '"Arial Black", "Helvetica Neue", Impact, Arial, sans-serif';
export const ART = {
  // text centred in the box, squeezed to fit; opts: fill, stroke, strokeW, italic, weight, font, shadow
  text: (txt, w, h, o = {}) => ({ w, h, draw(g) {
    g.font = `${o.italic ? 'italic ' : ''}${o.weight || 900} ${Math.round(h * (o.scale || 0.78))}px ${o.font || FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(txt).width, k = Math.min(1, (w * 0.96 - (o.strokeW || 0) * 2) / tw);
    g.translate(w / 2, h / 2 + h * 0.04); g.scale(k, 1);
    if (o.shadow) { g.fillStyle = o.shadow; g.fillText(txt, h * 0.05, h * 0.05); }
    if (o.stroke) { g.lineJoin = 'round'; g.lineWidth = o.strokeW || h * 0.1; g.strokeStyle = o.stroke; g.strokeText(txt, 0, 0); }
    g.fillStyle = o.fill || '#fff'; g.fillText(txt, 0, 0);
  } }),
  // racing number in a disc (or rounded square): bg, fg, ring colour
  number: (txt, s, o = {}) => ({ w: s, h: s, draw(g) {
    const r = s / 2 - 4; g.fillStyle = o.ring || '#111'; g.beginPath(); o.square ? g.roundRect(4, 4, s - 8, s - 8, s * 0.12) : g.arc(s / 2, s / 2, r, 0, 7); g.fill();
    g.fillStyle = o.bg || '#fff'; g.beginPath(); o.square ? g.roundRect(s * 0.08, s * 0.08, s * 0.84, s * 0.84, s * 0.09) : g.arc(s / 2, s / 2, r * 0.86, 0, 7); g.fill();
    g.font = `italic 900 ${Math.round(s * 0.62)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(txt).width, k = Math.min(1, (s * 0.72) / tw); g.translate(s / 2, s / 2 + s * 0.04); g.scale(k, 1);
    g.fillStyle = o.fg || '#111'; g.fillText(txt, 0, 0);
  } }),
  // sharkmouth, nose to the LEFT of the drawing (side projection puts image-left at the front)
  shark: (w, h) => ({ w, h, draw(g) {
    const top = (x) => h * (0.42 + 0.1 * Math.pow(x / w, 1.4)), bot = (x) => h * (0.5 + 0.42 * Math.sin(Math.PI * Math.pow(x / w, 0.8)) * (1 - 0.25 * x / w));
    const path = () => { g.beginPath(); g.moveTo(0, h * 0.47); for (let x = 0; x <= w; x += 4) g.lineTo(x, top(x)); for (let x = w; x >= 0; x -= 4) g.lineTo(x, bot(x)); g.closePath(); };
    path(); g.fillStyle = '#b3101c'; g.fill();
    // throat shadow
    const gr = g.createLinearGradient(0, h * 0.45, 0, h); gr.addColorStop(0, 'rgba(60,0,0,0.6)'); gr.addColorStop(1, 'rgba(60,0,0,0)'); g.fillStyle = gr; path(); g.fill();
    // teeth along both jaws
    g.fillStyle = '#fbfbf6'; g.strokeStyle = '#222'; g.lineWidth = 2;
    const N = 11;
    for (let i = 0; i < N; i++) {
      const x0 = (i / N) * w * 0.98 + w * 0.01, x1 = ((i + 1) / N) * w * 0.98 + w * 0.01, xm = (x0 + x1) / 2;
      const tl = h * (0.12 + 0.12 * Math.sin(Math.PI * (i + 0.5) / N));
      g.beginPath(); g.moveTo(x0, top(x0) - 1); g.lineTo(x1, top(x1) - 1); g.lineTo(xm, top(xm) + tl); g.closePath(); g.fill(); g.stroke();
      if (i > 0 && i < N - 1) { g.beginPath(); g.moveTo(x0, bot(x0) + 1); g.lineTo(x1, bot(x1) + 1); g.lineTo(xm, bot(xm) - tl * 0.9); g.closePath(); g.fill(); g.stroke(); }
    }
    path(); g.strokeStyle = '#0d0d0f'; g.lineWidth = h * 0.035; g.stroke();
    // the eye: white, black pupil, a mean brow
    const ex = w * 0.62, ey = h * 0.2, er = h * 0.12;
    g.fillStyle = '#fbfbf6'; g.beginPath(); g.ellipse(ex, ey, er * 1.25, er, -0.15, 0, 7); g.fill(); g.lineWidth = h * 0.03; g.strokeStyle = '#0d0d0f'; g.stroke();
    g.fillStyle = '#0d0d0f'; g.beginPath(); g.arc(ex - er * 0.35, ey + er * 0.1, er * 0.55, 0, 7); g.fill();
    g.beginPath(); g.moveTo(ex - er * 1.6, ey - er * 0.6); g.lineTo(ex + er * 1.5, ey - er * 1.5); g.lineTo(ex + er * 1.4, ey - er * 0.9); g.closePath(); g.fill();
  } }),
  // a five-pointed star (stencil-style insignia)
  star: (s, o = {}) => ({ w: s, h: s, draw(g) {
    if (o.disc) { g.fillStyle = o.disc; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 2, 0, 7); g.fill(); }
    g.fillStyle = o.fill || '#fff'; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = (i % 2 ? 0.2 : 0.48) * s * (o.disc ? 0.85 : 1), a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); }
    g.closePath(); g.fill();
  } }),
  // anything else: a custom draw(ctx, w, h)
  custom: (w, h, draw) => ({ w, h, draw: (g) => draw(g, w, h) }),
};
