// Land cover: what the ground is (forest, meadow, fields, scree, glacier, wash...) from terrain shape, the baked
// a few noise fields (the generated valley's baked hydrology is gone; the real places map their rivers). Used by
// World.baseColor for the baked albedo of the core and the streamed tiles, by the vegetation (forestAt), and it
// marks farmland for the terrain shader, which draws the field parcels crisply up close with the same parcel
// layout as fieldColor() below (FIELD_GLSL is the GLSL twin of parcel()).
import * as THREE from 'three';
import { smoothstep, clamp } from './noise.js';

// integer hash -> [0,1): identical in JS and GLSL (uint arithmetic), so baked and shaded fields agree
export function hash3(i, j, k) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Crop palettes (sRGB hex), by location: [weight, colour A, colour B, kind] kind: 0 plain, 1 ploughed furrows, 2 mown stripes, 3 crop rows
const CROPS = {
  alpine: [[0.26, 0x5d7f35, 0x557a30, 0], [0.22, 0x7f9444, 0x6f883c, 2], [0.13, 0x4f7a2a, 0x46702a, 3], [0.12, 0xb59a52, 0xa48a48, 3], [0.12, 0x6a5038, 0x5a4430, 1], [0.04, 0xc9b43a, 0xbba636, 3], [0.11, 0x8a8a52, 0x7c7c4a, 2]],
  islands: [[0.35, 0x5f9636, 0x558a30, 3], [0.2, 0x4e7f2e, 0x46762a, 0], [0.2, 0x2f6a2a, 0x2a6026, 3], [0.15, 0x7a4a30, 0x6a4028, 1], [0.1, 0x8aa048, 0x7a9040, 2]],
  canyon: [[0.45, 0x6a8a36, 0x5e7e30, 3], [0.25, 0x8a6040, 0x7a5436, 1], [0.15, 0xa08a58, 0x92804f, 2], [0.15, 0x7f9a40, 0x728c3a, 3]],
};
export const cropsFor = (id) => CROPS[id] || CROPS.alpine;

// Field parcel at (x,z): regions ~1.2 km across each with their own field direction, split into strips and the
// strips into fields of varying length. out = [field hash, crop hash, distance to the field edge (m), u, v, hedge hash]
export function parcel(x, z, out) {
  const wx = x + 70 * Math.sin(z / 530), wz = z + 70 * Math.sin(x / 470);
  const rx = Math.floor(wx / 1200), rz = Math.floor(wz / 1200);
  const a = hash3(rx, rz, 1) * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
  const u = wx * ca + wz * sa, v = -wx * sa + wz * ca;
  const W = 60 + hash3(rx, rz, 2) * 90, si = Math.floor(u / W);
  const L = 110 + hash3(si, rx * 7 + rz, 3) * 280, off = hash3(si, rz, 4) * L, li = Math.floor((v + off) / L);
  const du = Math.min(u - si * W, (si + 1) * W - u), dv = Math.min(v + off - li * L, (li + 1) * L - v - off);
  const er = Math.min(wx - rx * 1200, (rx + 1) * 1200 - wx, wz - rz * 1200, (rz + 1) * 1200 - wz);
  out[0] = hash3(si, li, rx * 131 + rz * 17); out[1] = hash3(li, si, 77 + rx - rz * 3); out[2] = Math.min(du, dv, er); out[3] = u; out[4] = v; out[5] = hash3(si, li, 5);
  return out;
}

// GLSL twin of hash3 / parcel, plus the shading of one field (crisp edges, furrows, mowing stripes, hedgerows)
export function fieldGLSL(id) {
  const crops = cropsFor(id), tot = crops.reduce((s, c) => s + c[0], 0);
  // the bake writes Color(hex) values as bytes that the GPU then decodes as sRGB: do the same here so both agree
  const lin = (hex) => { const c = new THREE.Color(hex).convertSRGBToLinear(); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
  let acc = 0, pick = '';
  crops.forEach(([w, A, B, kind], i) => {
    acc += w / tot;
    pick += `${i ? 'else ' : ''}if (t < ${i === crops.length - 1 ? '2.0' : acc.toFixed(4)}) { ca = ${lin(A)}; cb = ${lin(B)}; kind = ${kind}; }\n`;
  });
  return /* glsl */`
  float hash3(int i, int j, int k) {
    uint h = (uint(i) * 0x27d4eb2du) ^ (uint(j) * 0x165667b1u) ^ (uint(k) * 0x9e3779b1u);
    h = (h ^ (h >> 15u)) * 0x85ebca6bu; h = (h ^ (h >> 13u)) * 0xc2b2ae35u; h ^= h >> 16u;
    return float(h) / 4294967296.0;
  }
  // returns field hash, crop hash, edge distance, u, v in f, hedge hash in g
  void parcel(vec2 p, out vec4 f, out vec2 g) {
    float wx = p.x + 70.0 * sin(p.y / 530.0), wz = p.y + 70.0 * sin(p.x / 470.0);
    int rx = int(floor(wx / 1200.0)), rz = int(floor(wz / 1200.0));
    float a = hash3(rx, rz, 1) * 3.14159265, ca = cos(a), sa = sin(a);
    float u = wx * ca + wz * sa, v = -wx * sa + wz * ca;
    float W = 60.0 + hash3(rx, rz, 2) * 90.0; int si = int(floor(u / W));
    float L = 110.0 + hash3(si, rx * 7 + rz, 3) * 280.0, off = hash3(si, rz, 4) * L; int li = int(floor((v + off) / L));
    float du = min(u - float(si) * W, float(si + 1) * W - u), dv = min(v + off - float(li) * L, float(li + 1) * L - v - off);
    float er = min(min(wx - float(rx) * 1200.0, float(rx + 1) * 1200.0 - wx), min(wz - float(rz) * 1200.0, float(rz + 1) * 1200.0 - wz));
    f = vec4(hash3(si, li, rx * 131 + rz * 17), hash3(li, si, 77 + rx - rz * 3), min(min(du, dv), er), u);
    g = vec2(v, hash3(si, li, 5));
  }
  // farm: farmland mask (0..1), base: the baked albedo (linear). Returns the field colour, or base outside fields.
  vec3 fieldShade(vec2 p, float farm, vec3 base, float dist, out float isField) {
    isField = 0.0;
    if (farm < 0.02 || dist > 9000.0) return base;
    vec4 f; vec2 g; parcel(p, f, g);
    if (f.x > farm * 1.25 - 0.1) return base; // fields drop out one by one towards the edge of the farmland
    float t = f.y; vec3 ca = vec3(0.0), cb = vec3(0.0); int kind = 0;
    ${pick}
    vec3 c = mix(mix(ca, cb, fract(f.x * 7.31)), base, 0.2); // a little of the local ground tone
    float px = max(fwidth(f.w), fwidth(g.x)); // metres per pixel
    if (kind == 1) c *= 1.0 + 0.16 * sin(f.w * 2.6) * (1.0 - smoothstep(0.4, 1.2, px)); // furrows
    else if (kind == 2) c *= 1.0 + 0.09 * sign(sin(f.w * 0.27)) * (1.0 - smoothstep(4.0, 9.0, px)); // mowing stripes
    else if (kind == 3) c *= 1.0 + 0.07 * sin(f.w * 7.0) * (1.0 - smoothstep(0.2, 0.5, px)); // crop rows
    // field edges: hedgerow (dark), grass margin or farm track (pale)
    float e = f.z, hedge = g.y;
    vec3 edgeCol = hedge < 0.45 ? base * vec3(0.55, 0.7, 0.5) : hedge < 0.8 ? base * 1.05 : vec3(0.36, 0.31, 0.24);
    float ew = hedge < 0.45 ? 3.5 : hedge < 0.8 ? 1.5 : 2.5;
    float k = 1.0 - smoothstep(ew - px * 0.7, ew + px * 0.7, e);
    c = mix(c, edgeCol, k * (1.0 - smoothstep(6.0, 14.0, px) * 0.6));
    isField = 1.0;
    return mix(c, base, smoothstep(0.02, 0.0, farm));
  }`;
}

const col = (h) => new THREE.Color(h); // these are used as raw (sRGB-coded) bytes in the bake, like the location palettes

export class Landcover {
  constructor(w) {
    this.w = w; this.loc = w.loc; this.B = w.bake; this.n = w.noise;
    this.id = w.loc.id; this.alpine = this.id === 'alpine'; this.isl = this.id === 'islands'; this.desert = !!w.loc.desert;
    this.L = [0, 0, 0, 0]; this.P = [0, 0, 0, 0, 0, 0]; this.tmp = new THREE.Color(); this.tmp2 = new THREE.Color();
    this.crops = cropsFor(this.id).map(([wt, a, b, kind]) => ({ wt, a: col(a), b: col(b), kind }));
    this.cropTot = this.crops.reduce((s, c) => s + c.wt, 0);
    this.c = {
      meadow: col(0x7a8a45), alpMeadow: col(0x86904e), scree: col(0x8c8882), gravel: col(0x9c988c), glacier: col(0xdde8f0), ice: col(0xc4d8e4),
      riparian: col(0x3c5a26), wet: col(0x47582c), conifer: col(0x253d1d), broad: col(0x36572a), lava: col(0x3e3a38), savanna: col(0x8c944c),
      wash: col(0xc9a77c), washScrub: col(0x7d7a52), talus: col(0x9c6c50), caprock: col(0xc4a47e), pavement: col(0x8a4e30), floodplain: col(0x58683a),
      hedgeTrees: col(0x34502a),
    };
  }
  land(x, z) { const L = this.L; L[0] = L[1] = L[2] = L[3] = 0; return L; } // (no baked hydrology at the real places)
  // farmland suitability 0..1 (flat, low, dry ground near settlement), before the per-field cut-off
  farm(x, z, h, slope, L = this.land(x, z)) {
    const w = this.w, wl = w.waterLevel;
    if (L[0] > 0.25) return 0;
    let f;
    if (this.alpine) f = (1 - smoothstep(0.05, 0.11, slope)) * (1 - smoothstep(w.loc.rwyH + 160, w.loc.rwyH + 330, h));
    else if (this.isl) f = (1 - smoothstep(0.06, 0.13, slope)) * smoothstep(wl + 5, wl + 10, h) * (1 - smoothstep(70, 120, h));
    else f = (1 - smoothstep(0.03, 0.08, slope)) * smoothstep(wl + 1.5, wl + 3, h) * (1 - smoothstep(wl + 10, wl + 28, h)) * smoothstep(2.5, 3.6, L[1] * 6); // irrigated floodplain only
    if (f <= 0) return 0;
    // patchy: some of the flat land is left as meadow / woods
    f *= smoothstep(-0.35, 0.05, this.n.fbm(x / 1900 - 3, z / 1900 + 5, 2));
    // not under the airport, towns or the designed fields (painted by roads.js), not out on the endless land
    if (x > -700 && x < 900 && Math.abs(z) < 1500) f *= smoothstep(0, 300, Math.max(Math.abs(z) - 1150, x - 600, -450 - x));
    const net = w.net;
    if (net) {
      for (const t of net.towns) { const d = Math.hypot(t.c.x - x, t.c.z - z), r = 430 * t.size; if (d < r + 200) f *= smoothstep(r, r + 200, d); }
      if (net.fields.length && this.inDesignedField(x, z)) return 0;
    }
    f *= 1 - smoothstep(12500, 16000, Math.max(Math.abs(x), Math.abs(z)));
    return f;
  }
  inDesignedField(x, z) {
    if (!this.fieldGrid) {
      this.fieldGrid = new Map();
      for (const f of this.w.net.fields) { const R = Math.max(f.sx, f.sz) * 1.5 + 10; for (let gx = Math.floor((f.x - R) / 300); gx <= Math.floor((f.x + R) / 300); gx++) for (let gz = Math.floor((f.z - R) / 300); gz <= Math.floor((f.z + R) / 300); gz++) { const k = gx + ',' + gz; if (!this.fieldGrid.has(k)) this.fieldGrid.set(k, []); this.fieldGrid.get(k).push(f); } }
    }
    const fs = this.fieldGrid.get(Math.floor(x / 300) + ',' + Math.floor(z / 300)); if (!fs) return false;
    for (const f of fs) { const dx = x - f.x, dz = z - f.z; if (f.pivot ? Math.hypot(dx, dz) < f.sx + 8 : Math.abs(dx * Math.cos(f.ang) + dz * Math.sin(f.ang)) < f.sx + 8 && Math.abs(-dx * Math.sin(f.ang) + dz * Math.cos(f.ang)) < f.sz + 8) return true; }
    return false;
  }
  // forest density 0..1 (what flora's species densities take as F). nx/nz: ground normal (aspect), optional
  forest(x, z, h, slope, L = this.land(x, z), farm = this.farm(x, z, h, slope, L), nz = 0) {
    const n = this.n;
    let F = smoothstep(-0.02, 0.18, n.fbm(x / 260 + 7, z / 260, 3));
    if (this.desert) return F * smoothstep(0.35, 0.6, L[0] + L[3] * 0.4) * 0.6; // only along washes
    const drain = L[1] * 6; // log10 cells
    if (this.alpine) {
      F = Math.max(F, smoothstep(0.08, 0.3, slope) * 0.75 * smoothstep(-0.3, 0.1, n.fbm(x / 700, z / 700, 2))); // valley sides wooded
      F *= 1 + nz * 0.25; // north-facing (+z) slopes hold more forest
      // avalanche chutes: open strips down the gullies of steep slopes
      F *= 1 - smoothstep(0.28, 0.42, slope) * smoothstep(1.6, 2.4, drain) * smoothstep(0.1, 0.5, n.fbm(x / 150, z / 150, 2) + 0.4);
    } else if (this.isl) {
      F = Math.max(F, smoothstep(0.1, 0.3, slope) * 0.8, smoothstep(1.5, 2.5, drain) * 0.9); // forested slopes and ravines
      F *= 1 - smoothstep(0.1, 0.5, -nz) * smoothstep(0.05, 0.2, slope) * 0.5; // drier south-facing slopes: grass
    }
    // riparian woods along streams, no trees in the water
    F = Math.max(F, smoothstep(2.6, 3.4, drain) * (1 - smoothstep(0.2, 0.4, slope)) * 0.8 * (this.B ? 1 : 0));
    F *= 1 - smoothstep(0.15, 0.4, L[0]);
    // farmland: open, with hedgerow trees and the odd woodlot
    F *= 1 - farm * (0.92 - 0.6 * smoothstep(0.25, 0.45, n.fbm(x / 400 + 2, z / 400, 2)));
    return clamp(F, 0, 1);
  }
  // field colour at a texel (the bake's version of fieldShade)
  fieldColor(x, z, farm, base, c) {
    const P = parcel(x, z, this.P);
    if (P[0] > farm * 1.25 - 0.1) return false;
    let t = P[1] * this.cropTot, k = 0; while (k < this.crops.length - 1 && (t -= this.crops[k].wt) > 0) k++;
    const cr = this.crops[k];
    c.copy(cr.a).lerp(cr.b, (P[0] * 7.31) % 1).lerp(base, 0.2);
    if (P[2] < 3) c.lerp(base, 0.5); // field edge (the bake can't resolve it: just soften)
    return true;
  }
  // the full ground colour (as the bake writes it). nrm: ground normal (optional, for aspect)
  color(x, z, h, slope, c, nrm) {
    const w = this.w, n = this.n, P = w.pal, wl = w.waterLevel, L = this.land(x, z), C = this.c, tmp = this.tmp;
    const nv = n.fbm(x / 700, z / 700, 3) * 0.5 + 0.5, nd = n.n2(x / 90, z / 90) * 0.5 + 0.5;
    const nz = nrm ? nrm.z : 0;
    c.copy(P.grass[0]).lerp(P.grass[1], nv).lerp(P.grass[2], nd * 0.5);
    const water = L[0], drain = L[1] * 6, depo = L[2], wet = L[3];
    let farm = 0;
    if (this.desert) {
      // strata on the walls, varnish streaks, talus aprons, caprock on the mesa tops, pale washes with scrub
      const band = Math.sin(h / 14 + n.n2(x / 400, z / 400) * 1.5) * 0.5 + 0.5, band2 = Math.sin(h / 3.7 + nd * 2) * 0.5 + 0.5;
      c.lerp(tmp.copy(P.pavement ?? C.pavement), 0.25 * smoothstep(0.1, 0.5, n.fbm(x / 300 + 4, z / 300, 2)));
      c.lerp(tmp.copy(P.rock).lerp(P.sand, band).multiplyScalar(0.85 + band2 * 0.25), smoothstep(0.06, 0.22, slope));
      c.lerp(P.sand, smoothstep(0.3, 0, slope) * 0.3);
      c.lerp(C.talus, smoothstep(0.08, 0.3, depo) * smoothstep(0.08, 0.2, slope) * (1 - smoothstep(0.5, 0.8, slope)) * 0.7);
      const cap = smoothstep(260, 330, h) * (1 - smoothstep(0.05, 0.15, slope));
      c.lerp(C.caprock, cap * 0.35);
      if (this.B) {
        c.lerp(C.washScrub, smoothstep(0.05, 0.25, water) * 0.5 + smoothstep(2.4, 3.2, drain) * 0.2 * (1 - smoothstep(0.1, 0.25, slope)));
        c.lerp(C.wash, smoothstep(0.3, 0.7, water) * 0.85);
      }
      // green floodplain along the canyon river
      c.lerp(C.floodplain, (1 - smoothstep(wl + 2, wl + 9, h)) * (1 - smoothstep(0.08, 0.2, slope)) * 0.75);
      farm = this.farm(x, z, h, slope, L);
    } else {
      farm = this.farm(x, z, h, slope, L);
      const forest = this.forest(x, z, h, slope, L, farm, nz);
      const sn = this.loc.snowline;
      if (this.alpine) {
        // meadow above the trees, pastures on the valley sides
        c.lerp(C.alpMeadow, smoothstep(sn - 650, sn - 250, h) * 0.55);
        c.lerp(C.meadow, smoothstep(0.04, 0.15, slope) * (1 - smoothstep(sn - 500, sn - 300, h)) * 0.3 * nv);
      }
      if (this.isl) {
        c.lerp(C.savanna, smoothstep(0.05, 0.35, -nz) * smoothstep(0.06, 0.2, slope) * 0.5);
        c.lerp(C.lava, smoothstep(380, 520, h) * 0.8);
      }
      // wet meadows / marsh in wet hollows, gravel bars by the bigger rivers
      c.lerp(C.wet, smoothstep(0.62, 0.8, wet) * (1 - smoothstep(0.05, 0.15, slope)) * 0.6);
      // forest (the trees stand on it; seen from afar this is the canopy colour)
      if (h < sn - 150 && h > wl + 3) {
        const tl = this.alpine ? 1 - smoothstep(sn - 380, sn - 130, h) : 1;
        const fc = tmp.copy(this.alpine ? C.conifer : C.broad).lerp(C.broad, this.alpine ? smoothstep(600, 250, h) * 0.6 : 0).lerp(C.riparian, smoothstep(2.6, 3.4, drain) * 0.6);
        c.lerp(fc, smoothstep(0.05, 0.45, forest) * 0.8 * tl * (1 - smoothstep(0.42, 0.6, slope)));
      }
      c.lerp(P.dirt, smoothstep(0.12, 0.25, slope) * 0.45);
      // rock, and scree / talus where the debris settles under it
      c.lerp(P.rock, smoothstep(0.24, 0.44, slope + (h > 700 ? 0.1 : 0) + nd * 0.06));
      c.lerp(C.scree, smoothstep(0.12, 0.35, depo) * smoothstep(0.12, 0.25, slope) * (1 - smoothstep(0.62, 0.8, slope)) * 0.75);
      // snow: lower and deeper on north faces, blown off the steepest walls; glaciers fill the high basins
      if (sn < 9000) {
        const sl = sn + nd * 150 - smoothstep(0.0, 0.3, n.fbm(x / 260 + 7, z / 260, 3)) * 120 - nz * 130;
        if (h > sl - 250) {
          const snow = smoothstep(sl, sl + 120, h) * (1 - smoothstep(0.55, 0.85, slope - (h - sl) * 0.0003 - Math.max(0, nz) * 0.12));
          c.lerp(P.snow, snow);
          const glac = smoothstep(sl - 200, sl, h) * smoothstep(1.4, 2.4, drain) * (1 - smoothstep(0.2, 0.42, slope));
          c.lerp(tmp.copy(C.glacier).lerp(C.ice, smoothstep(2.4, 3.4, drain) * 0.6), glac * 0.9);
        }
      }
      if (this.B) c.lerp(C.gravel, smoothstep(0.2, 0.6, water) * (1 - smoothstep(0.7, 0.9, water)) * smoothstep(3.2, 4.0, drain) * 0.7);
    }
    if (farm > 0.02) { const fc = this.tmp2; if (this.fieldColor(x, z, farm, c, fc)) c.lerp(fc, smoothstep(0.02, 0.15, farm)); }
    if (h < wl + 4) c.lerp(P.sand, 1 - smoothstep(wl + 1, wl + 4, h));
    if (h < wl - 1) c.lerp(P.seabed, 0.6);
    this.lastFarm = farm;
    return c;
  }
}
