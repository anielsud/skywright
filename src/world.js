// Environment: terrain, water, sky, sun, weather, clouds, airport and scenery.
import * as THREE from 'three';
import { Sky } from '../vendor/addons/Sky.js';
import { makeNoise, mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { Billboards } from './billboard.js';
import { puffTexture, glowTexture, M } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { FOG, terrainMaterial, waterMaterial, swayMaterial } from './shaders.js';
import { planNetwork, flattenGrid, flattenHi, makePainter, buildRoadMeshes } from './roads.js';
import { Flora } from './flora.js';
import { Towns } from './towns.js';

const RWY = { len: 1800, width: 45 };

export const LOCATIONS = {
  alpine: {
    id: 'alpine', name: 'Alpine Valley', desc: 'Snowy peaks, a glacier lake, pine forests and a mountain village.', seed: 11, rwyH: 30, water: 0, cloudBase: 2300, trees: 'pine',
    colors: { grass: [0x4a6b2a, 0x5f7f35, 0x3f5d27], rock: 0x6b6660, snow: 0xf4f6f8, sand: 0x9a8d6a, dirt: 0x6f5a3c }, snowline: 1250, balloons: true,
    height(n, x, z) {
      const vx = x - Math.sin(z / 2600) * 900; // valley centre line meanders
      const dv = Math.abs(vx);
      const mask = smoothstep(500, 2600, dv);
      const peaks = n.ridged(x / 3800, z / 3800, 6) * 2100 + n.fbm(x / 1500, z / 1500, 4) * 220;
      let h = 25 + n.fbm(x / 1200, z / 1200, 3) * 18 + mask * peaks;
      const lake = Math.hypot(x - 1500, z + 3800); if (lake < 1300) h = lerp(-25, h, smoothstep(700, 1300, lake));
      return h;
    },
  },
  islands: {
    id: 'islands', name: 'Coral Islands', desc: 'Turquoise lagoons, palm-fringed beaches and a volcano island.', seed: 23, rwyH: 6, water: 0, cloudBase: 1100, trees: 'palm',
    colors: { grass: [0x3f7a2c, 0x56913a, 0x2f6125], rock: 0x5a524a, snow: 0x5a524a, sand: 0xe3d3a3, dirt: 0x7a6040 }, snowline: 99999, boats: true,
    height(n, x, z) {
      const r0 = Math.hypot(x * 0.8, z * 0.42);
      let h = 120 * Math.max(0, 1 - r0 / 1500) ** 1.2 + n.fbm(x / 900, z / 900, 4) * 30 - 20;
      const isl = [[5200, -3800, 2100, 650], [-4800, -1500, 1500, 300], [-2800, 5400, 1700, 260], [6200, 4800, 1100, 200], [600, -8200, 1300, 380]];
      for (const [ix, iz, r, hh] of isl) { const d = Math.hypot(x - ix, z - iz); if (d < r * 1.6) h = Math.max(h, hh * Math.max(0, 1 - d / r) ** 1.6 + n.fbm(x / 500, z / 500, 4) * 40 - 15 * (d / r)); }
      // volcano crater on the big island
      const dv = Math.hypot(x - 5200, z + 3800); if (dv < 260) h -= (260 - dv) * 0.9;
      h = Math.max(h, -45 + n.fbm(x / 2000, z / 2000, 3) * 20);
      return h;
    },
  },
  canyon: {
    id: 'canyon', name: 'Red Canyon', desc: 'Towering mesas, a winding canyon river and endless desert.', seed: 37, rwyH: 120, water: 8, cloudBase: 3000, trees: 'cactus',
    colors: { grass: [0xb06a3b, 0xc27d48, 0x9a5a32], rock: 0x8e4a2c, snow: 0xd9b48a, sand: 0xd2a26c, dirt: 0xa0603a }, snowline: 99999, desert: true,
    height(n, x, z) {
      const cz = z + Math.sin(x / 1700) * 1400 + Math.sin(x / 600) * 200 - 2600;
      const canyon = 1 - smoothstep(60, 520, Math.abs(cz));
      let base = 120 + n.fbm(x / 3000, z / 3000, 3) * 30;
      const mesa = n.fbm(x / 2200 + 10, z / 2200, 5);
      if (mesa > 0.12) { const t = smoothstep(0.12, 0.2, mesa); const steps = Math.floor(t * 4) / 4 + smoothstep(0, 1, (t * 4) % 1) / 4 * 0.25; base += steps * 380 + n.fbm(x / 300, z / 300, 2) * 8; }
      return lerp(base, -10 + n.fbm(x / 400, z / 400, 2) * 6, canyon);
    },
  },
};

export const WEATHER = {
  clear: { name: 'Clear', clouds: 0.25, cover: 0, fog: 0.000045, wind: 3, turb: 0.15, rain: 0, snow: 0, storm: 0, dark: 0 },
  cloudy: { name: 'Cumulus', clouds: 0.85, cover: 0, fog: 0.00006, wind: 6, turb: 0.4, rain: 0, snow: 0, storm: 0, dark: 0.1 },
  overcast: { name: 'Overcast', clouds: 0.25, cover: 1, fog: 0.0001, wind: 7, turb: 0.4, rain: 0, snow: 0, storm: 0, dark: 0.45 },
  rain: { name: 'Rain', clouds: 0.3, cover: 1, fog: 0.00018, wind: 9, turb: 0.7, rain: 1, snow: 0, storm: 0, dark: 0.6 },
  storm: { name: 'Thunderstorm', clouds: 0.5, cover: 1, fog: 0.00024, wind: 15, turb: 1.4, rain: 1.6, snow: 0, storm: 1, dark: 0.8 },
  snow: { name: 'Snow', clouds: 0.2, cover: 1, fog: 0.0002, wind: 5, turb: 0.35, rain: 0, snow: 1, storm: 0, dark: 0.35 },
  fog: { name: 'Fog', clouds: 0.1, cover: 0, fog: 0.0007, wind: 1, turb: 0.05, rain: 0, snow: 0, storm: 0, dark: 0.25 },
};

const QUALITY = {
  low: { res: 180, bake: 384, trees: 6000, shadows: false, shadowSize: 1024, clouds: 0.5, pixel: 1, post: false },
  medium: { res: 280, bake: 640, trees: 16000, shadows: true, shadowSize: 2048, clouds: 0.8, pixel: 1.5, post: true },
  high: { res: 420, bake: 1024, trees: 32000, shadows: true, shadowSize: 4096, clouds: 1, pixel: 2, post: true },
};
export { QUALITY };

export class World {
  constructor(renderer, scene, opts) {
    this.renderer = renderer; this.scene = scene;
    this.loc = LOCATIONS[opts.location] || LOCATIONS.alpine;
    this.q = QUALITY[opts.quality] || QUALITY.medium; this.qName = opts.quality || 'medium';
    this.noise = makeNoise(this.loc.seed);
    this.rnd = mulberry32(this.loc.seed * 7);
    this.time = opts.time ?? 10; this.weatherId = opts.weather || 'clear';
    this.waterLevel = this.loc.water;
    this.size = 22000;
    this.group = new THREE.Group(); scene.add(this.group);
    this.t = 0; this.night = false;
    this.windBase = new THREE.Vector3(); this.gust = new THREE.Vector3(); this.gustT = new THREE.Vector3();
    this.thermals = [];
    this.buildTerrain();
    this.buildWater();
    this.buildSky();
    this.buildRunway();
    this.buildAirport();
    this.flora = new Flora(this);
    this.towns = new Towns(this);
    this.buildClouds();
    this.buildPrecip();
    this.setWeather(this.weatherId);
    this.setTime(this.time);
  }

  // ---------------- terrain ----------------
  rawHeight(x, z) {
    let h = this.loc.height(this.noise, x, z);
    // flatten airport
    const dx = Math.max(0, Math.abs(x - 140) - 300), dz = Math.max(0, Math.abs(z) - RWY.len / 2 - 250);
    const d = Math.hypot(dx, dz);
    const t = smoothstep(0, 700, d);
    return lerp(this.loc.rwyH, h, t);
  }
  buildTerrain() {
    const N = this.q.res, S = this.size, half = S / 2, step = S / N;
    this.N = N; this.step = step; this.half = half;
    const H = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H[j * (N + 1) + i] = this.rawHeight(-half + i * step, -half + j * step);
    this.H = H;
    // road / rail network, towns and fields; flattened into the heightfield
    this.net = planNetwork(this);
    flattenGrid(this, this.net);
    this.road = { samples: this.net.roads[0].pts, width: 9 };
    this.roadHash = new Map();
    for (const rd of [...this.net.roads, ...(this.net.rail ? [this.net.rail] : [])]) rd.pts.forEach((p) => { const k = Math.floor(p.x / 40) + ',' + Math.floor(p.z / 40); if (!this.roadHash.has(k)) this.roadHash.set(k, []); this.roadHash.get(k).push([p.x, p.z, rd.width / 2]); });
    // geometry
    const geo = new THREE.PlaneGeometry(S, S, N, N);
    geo.rotateX(-Math.PI / 2); // now x,z plane; vertex order: rows along +z (j), cols along +x (i)
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color(), tmp = new THREE.Color();
    const L = this.loc.colors;
    const grass = L.grass.map((h) => new THREE.Color(h)), rock = new THREE.Color(L.rock), snow = new THREE.Color(L.snow), sand = new THREE.Color(L.sand), dirt = new THREE.Color(L.dirt);
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), z = pos.getZ(v);
      const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
      const h = H[j * (N + 1) + i];
      pos.setY(v, h);
    }
    geo.computeVertexNormals();
    this.bakeTerrain();
    const mat = terrainMaterial({ detail: this.detailTexture(), rock: this.rockTexture(), albedo: this.albedoTex, normal: this.normalTex, shadow: this.shadowTex, half, size: S });
    this.terrainMat = mat;
    const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true;
    this.terrain = mesh; this.group.add(mesh);
    // far skirt so the edge isn't visible
    const skirt = new THREE.Mesh(new THREE.RingGeometry(S * 0.49, S * 4, 64, 1), new THREE.MeshStandardMaterial({ color: this.loc.id === 'islands' ? 0x0d3b4a : new THREE.Color(L.grass[0]).multiplyScalar(this.loc.desert ? 0.9 : 0.6), roughness: 1 }));
    skirt.rotation.x = -Math.PI / 2; skirt.position.y = this.loc.id === 'islands' ? -50 : this.loc.desert ? 110 : 20; this.group.add(skirt);
    this.roadGroup = buildRoadMeshes(this, this.net); this.group.add(this.roadGroup);
    this.buildMinimap();
  }
  // Bake high-resolution albedo (+AO) and normal maps from the analytic height function.
  bakeTerrain() {
    const R = this.q.bake, S = this.size, half = this.half, st = S / R, W = R + 1;
    const Hh = new Float32Array(W * W);
    for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) Hh[j * W + i] = this.rawHeight(-half + i * st, -half + j * st);
    flattenHi(this, this.net, Hh, R);
    const paint = makePainter(this, this.net);
    this.Hh = Hh; this.hR = R; this.hStep = st;
    const blur = (src, r) => { // separable box blur
      const a = new Float32Array(W * W), b = new Float32Array(W * W);
      for (let j = 0; j < W; j++) { let acc = 0; for (let i = -r; i <= r; i++) acc += src[j * W + Math.min(W - 1, Math.max(0, i))]; for (let i = 0; i < W; i++) { a[j * W + i] = acc / (2 * r + 1); acc += src[j * W + Math.min(W - 1, i + r + 1)] - src[j * W + Math.max(0, i - r)]; } }
      for (let i = 0; i < W; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += a[Math.min(W - 1, Math.max(0, j)) * W + i]; for (let j = 0; j < W; j++) { b[j * W + i] = acc / (2 * r + 1); acc += a[Math.min(W - 1, j + r + 1) * W + i] - a[Math.max(0, j - r) * W + i]; } }
      return b;
    };
    const b1 = blur(Hh, 2), b2 = blur(Hh, 10);
    const alb = new Uint8Array(W * W * 4), nor = new Uint8Array(W * W * 4);
    const L = this.loc.colors;
    const grass = L.grass.map((h) => new THREE.Color(h)), rock = new THREE.Color(L.rock), snow = new THREE.Color(L.snow), sand = new THREE.Color(L.sand), dirt = new THREE.Color(L.dirt);
    const seabed = new THREE.Color(this.loc.id === 'islands' ? 0xd8c79a : 0x4a4636), forest = new THREE.Color(this.loc.trees === 'pine' ? 0x2a4220 : 0x355a26);
    const c = new THREE.Color(), tmp = new THREE.Color(), n = new THREE.Vector3();
    const at = (i, j) => Hh[Math.min(R, Math.max(0, j)) * W + Math.min(R, Math.max(0, i))];
    for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) {
      const k = j * W + i, h = Hh[k], x = -half + i * st, z = -half + j * st;
      n.set(at(i - 1, j) - at(i + 1, j), 2 * st, at(i, j - 1) - at(i, j + 1)).normalize();
      nor[k * 4] = (n.x * 0.5 + 0.5) * 255; nor[k * 4 + 1] = (n.y * 0.5 + 0.5) * 255; nor[k * 4 + 2] = (n.z * 0.5 + 0.5) * 255; nor[k * 4 + 3] = 255;
      const slope = 1 - n.y;
      const nv = this.noise.fbm(x / 700, z / 700, 3) * 0.5 + 0.5, nd = this.noise.n2(x / 90, z / 90) * 0.5 + 0.5, nf = this.noise.fbm(x / 260 + 7, z / 260, 3);
      c.copy(grass[0]).lerp(grass[1], nv).lerp(grass[2], nd * 0.5);
      if (this.loc.desert) {
        const band = Math.sin(h / 14 + this.noise.n2(x / 400, z / 400) * 1.5) * 0.5 + 0.5;
        const band2 = Math.sin(h / 3.7 + nd * 2) * 0.5 + 0.5;
        c.lerp(tmp.copy(rock).lerp(sand, band).multiplyScalar(0.85 + band2 * 0.25), smoothstep(0.06, 0.22, slope));
        c.lerp(sand, smoothstep(0.3, 0, slope) * 0.3);
      } else {
        // forests darken the lower slopes where trees grow
        if (h < this.loc.snowline - 150 && h > this.waterLevel + 3) c.lerp(forest, smoothstep(0.0, 0.25, nf) * 0.55 * (1 - smoothstep(0.25, 0.4, slope)));
        c.lerp(dirt, smoothstep(0.12, 0.25, slope) * 0.6);
        c.lerp(rock, smoothstep(0.22, 0.42, slope + (h > 700 ? 0.12 : 0) + nd * 0.06));
        const sl = this.loc.snowline + nd * 150 - smoothstep(0.0, 0.3, nf) * 120;
        if (h > sl) c.lerp(snow, smoothstep(sl, sl + 120, h) * (1 - smoothstep(0.55, 0.85, slope - (h - sl) * 0.0003)));
      }
      if (h < this.waterLevel + 4) c.lerp(sand, 1 - smoothstep(this.waterLevel + 1, this.waterLevel + 4, h));
      if (h < this.waterLevel - 1) c.lerp(seabed, 0.6);
      if (h > this.waterLevel + 0.5 && slope < 0.25) paint(x, z, c);
      // ambient occlusion from local concavity
      const ao = clamp(1 - Math.max(0, b1[k] - h) * 0.04 - Math.max(0, b2[k] - h) * 0.006, 0.35, 1);
      alb[k * 4] = Math.min(255, c.r * 255); alb[k * 4 + 1] = Math.min(255, c.g * 255); alb[k * 4 + 2] = Math.min(255, c.b * 255); alb[k * 4 + 3] = ao * 255;
    }
    const mk = (data, w, fmt = THREE.RGBAFormat) => { const t = new THREE.DataTexture(data, w, w, fmt); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t; };
    this.albedoTex = mk(alb, W); this.albedoTex.colorSpace = THREE.SRGBColorSpace;
    this.normalTex = mk(nor, W);
    const SR = Math.floor(R / 2) + 1;
    this.shadowData = new Uint8Array(SR * SR * 4).fill(255);
    this.shadowTex = mk(this.shadowData, SR); this.shadowTex.generateMipmaps = false; this.shadowTex.minFilter = THREE.LinearFilter;
    this.shadowR = SR;
    // coarse heights for water depth (matches the rendered mesh)
    const N = this.N, hd = new Uint16Array((N + 1) * (N + 1));
    for (let k = 0; k < hd.length; k++) hd[k] = THREE.DataUtils.toHalfFloat(this.H[k]);
    this.depthTex = new THREE.DataTexture(hd, N + 1, N + 1, THREE.RedFormat, THREE.HalfFloatType);
    this.depthTex.magFilter = this.depthTex.minFilter = THREE.LinearFilter; this.depthTex.needsUpdate = true;
  }
  sampleHi(x, z) {
    const R = this.hR, W = R + 1, fx = clamp((x + this.half) / this.hStep, 0, R - 0.001), fz = clamp((z + this.half) / this.hStep, 0, R - 0.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, H = this.Hh;
    return (H[j * W + i] * (1 - u) + H[j * W + i + 1] * u) * (1 - v) + (H[(j + 1) * W + i] * (1 - u) + H[(j + 1) * W + i + 1] * u) * v;
  }
  // Soft terrain self-shadowing for the current sun direction (long mountain shadows at golden hour).
  bakeShadows() {
    if (!this.shadowData || !this.lightDir) return;
    const SR = this.shadowR, st = this.size / (SR - 1), half = this.half, d = this.lightDir;
    const hl = Math.hypot(d.x, d.z), tanE = d.y / Math.max(1e-3, hl), dx = d.x / Math.max(1e-3, hl), dz = d.z / Math.max(1e-3, hl);
    const out = this.shadowData;
    for (let j = 0; j < SR; j++) for (let i = 0; i < SR; i++) {
      const x = -half + i * st, z = -half + j * st, h0 = this.sampleHi(x, z) + 2;
      let sh = 1, t = st * 0.7;
      for (let s = 0; s < 48 && t < 9000; s++) {
        const px = x + dx * t, pz = z + dz * t;
        const diff = h0 + t * tanE - this.sampleHi(px, pz);
        sh = Math.min(sh, (diff / t) * 14 + 0.5);
        if (sh <= 0) break;
        t += st * (0.6 + s * 0.12);
      }
      out[(j * SR + i) * 4] = clamp(sh, 0, 1) * 255;
    }
    this.shadowTex.needsUpdate = true;
  }
  rockTexture() { return this.tileNoise(123, [[4, 0.35], [8, 0.25], [16, 0.2], [48, 0.12], [128, 0.08]], [1, 0.97, 0.93], 3.0, 130, 140); }
  detailTexture() { return this.tileNoise(99, [[8, 0.45], [16, 0.25], [32, 0.15], [64, 0.1], [128, 0.05]], [1, 1.01, 0.96], 1, 150, 120); }
  tileNoise(seed, octs, tint, stretch, base, amp) {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), img = g.createImageData(s, s), r = mulberry32(seed);
    const oct = octs.map(([P, a]) => { const L = new Float32Array(P * P); for (let i = 0; i < L.length; i++) L[i] = r(); return { P, a, L }; });
    const val = (o, x, y) => { const fx = (x / s) * o.P, fy = (y / s) * o.P; const i = Math.floor(fx), j = Math.floor(fy); const u = fx - i, v = fy - j; const P = o.P;
      const at = (a, b) => o.L[((b % P + P) % P) * P + ((a % P + P) % P)]; const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      return (at(i, j) * (1 - su) + at(i + 1, j) * su) * (1 - sv) + (at(i, j + 1) * (1 - su) + at(i + 1, j + 1) * su) * sv; };
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      let v = 0; for (const o of oct) v += val(o, x, stretch > 1 ? (y / stretch) % s : y) * o.a;
      if (stretch > 1) v = v * 0.7 + Math.abs(Math.sin(y / s * Math.PI * 2 * 12 + v * 6)) * 0.3; // strata/cracks for rock
      const k = base + v * amp + (r() - 0.5) * 24;
      const i = (y * s + x) * 4; img.data[i] = k * tint[0]; img.data[i + 1] = k * tint[1]; img.data[i + 2] = k * tint[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  sampleGrid(x, z) {
    const N = this.N, step = this.step, half = this.half;
    const fx = (x + half) / step, fz = (z + half) / step;
    if (fx < 0 || fz < 0 || fx >= N || fz >= N) return this.loc.id === 'islands' ? -50 : this.loc.desert ? 110 : 20;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, W = N + 1, H = this.H;
    const a = H[j * W + i], b = H[(j + 1) * W + i], cc = H[(j + 1) * W + i + 1], d = H[j * W + i + 1];
    // PlaneGeometry triangles: (a,b,d) and (b,c,d) - split along b-d
    if (u + v <= 1) return a + (d - a) * u + (b - a) * v;
    return cc + (b - cc) * (1 - u) + (d - cc) * (1 - v);
  }
  heightAt(x, z) { return this.sampleGrid(x, z); }
  maxGround(x, z) { return Math.max(this.sampleGrid(x, z), this.waterLevel) + (this.inAirportBox(x, z) ? 25 : 0); }
  inAirportBox(x, z) { return x > 150 && x < 420 && Math.abs(z) < 260; }
  groundAt(x, z) {
    const e = 1.5;
    const h = this.sampleGrid(x, z);
    if (h < this.waterLevel) return { h: this.waterLevel, n: new THREE.Vector3(0, 1, 0), type: 'water' };
    const hx = this.sampleGrid(x + e, z), hz = this.sampleGrid(x, z + e);
    const n = new THREE.Vector3(h - hx, e, h - hz).normalize();
    let type = 'grass';
    if (Math.abs(x) < RWY.width / 2 + 2 && Math.abs(z) < RWY.len / 2 + 30) type = 'runway';
    else if (this.isPaved(x, z)) type = 'runway';
    else if (n.y < 0.8) type = 'rock';
    else if (this.loc.desert) type = 'sand';
    else if (h > this.loc.snowline + 100) type = 'snow';
    return { h: type === 'runway' ? Math.max(h, this.loc.rwyH) : h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  isPaved(x, z) {
    if (x > 60 && x < 100 && Math.abs(z) < RWY.len / 2) return true; // taxiway
    if (x > 20 && x < 100 && (Math.abs(z - RWY.len / 2 + 20) < 15 || Math.abs(z + RWY.len / 2 - 20) < 15 || Math.abs(z) < 15)) return true;
    if (x > 100 && x < 330 && Math.abs(z) < 200) return true; // apron
    return false;
  }

  buildMinimap() {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), img = g.createImageData(s, s);
    const col = new THREE.Color();
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const wx = -this.half + (x / s) * this.size, wz = -this.half + (y / s) * this.size;
      const h = this.sampleGrid(wx, wz);
      const hx = this.sampleGrid(wx + 60, wz);
      const shade = clamp(0.75 + (h - hx) * 0.01, 0.4, 1.2);
      if (h < this.waterLevel) col.set(0x2a6f8f); else col.set(this.loc.colors.grass[1]).lerp(new THREE.Color(this.loc.colors.rock), smoothstep(200, 1400, h - this.loc.rwyH)).lerp(new THREE.Color(0xffffff), h > this.loc.snowline ? 0.7 : 0);
      const i = (y * s + x) * 4; img.data[i] = col.r * 255 * shade; img.data[i + 1] = col.g * 255 * shade; img.data[i + 2] = col.b * 255 * shade; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#222'; g.fillRect(s / 2 - 1.5, s / 2 - (RWY.len / this.size) * s / 2, 3, (RWY.len / this.size) * s);
    const toM = (p) => [((p.x + this.half) / this.size) * s, ((p.z + this.half) / this.size) * s];
    for (const rd of this.net.roads) { g.strokeStyle = rd.kind === 'highway' ? 'rgba(250,220,120,0.9)' : 'rgba(240,240,230,0.7)'; g.lineWidth = rd.kind === 'street' ? 0.6 : 1.1; g.beginPath(); rd.pts.forEach((p, i) => { const [x, y] = toM(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (rd.closed) g.closePath(); g.stroke(); }
    if (this.net.rail) { g.strokeStyle = 'rgba(60,40,30,0.9)'; g.setLineDash([2, 2]); g.beginPath(); this.net.rail.pts.forEach((p, i) => { const [x, y] = toM(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.setLineDash([]); }
    for (const t of this.net.towns) { const [x, y] = toM(t.c); g.fillStyle = 'rgba(255,230,200,0.85)'; g.beginPath(); g.arc(x, y, 3.5 * t.size + 1.5, 0, 7); g.fill(); }
    this.minimap = c;
  }

  // ---------------- water ----------------
  buildWater() {
    // tileable ocean normal map from a sum of plane waves with integer wave numbers
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), img = g.createImageData(s, s), r = mulberry32(5);
    const waves = [];
    for (let k = 0; k < 48; k++) {
      const f = 1 + Math.floor(r() ** 1.6 * 22), a = r() * Math.PI * 2;
      let kx = Math.round(Math.cos(a) * f), ky = Math.round(Math.sin(a) * f); if (!kx && !ky) kx = 1;
      waves.push([kx, ky, 1 / Math.pow(Math.hypot(kx, ky), 1.25), r() * 6.28]);
    }
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, amp, ph] of waves) { const th = (2 * Math.PI * (kx * x + ky * y)) / s + ph; const cs = Math.cos(th) * amp; dx += cs * kx; dy += cs * ky; }
      const v = new THREE.Vector3(-dx * 0.09, -dy * 0.09, 1).normalize();
      const i = (y * s + x) * 4; img.data[i] = (v.x * 0.5 + 0.5) * 255; img.data[i + 1] = (v.y * 0.5 + 0.5) * 255; img.data[i + 2] = (v.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const nt = new THREE.CanvasTexture(c); nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    const pal = this.loc.id === 'islands' ? { deep: 0x05324a, shallow: 0x19b5b0, sand: 0xe9dcb0 } : this.loc.desert ? { deep: 0x163c38, shallow: 0x3d7a68, sand: 0x9a7a52 } : { deep: 0x0b2a35, shallow: 0x2f6f6a, sand: 0x6b6a55 };
    const mat = waterMaterial({ depthTex: this.depthTex, normal: nt, half: this.half, size: this.size, level: this.waterLevel, ...pal, foam: this.loc.id === 'islands' ? 1 : 0.6 });
    const w = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), mat);
    w.rotation.x = -Math.PI / 2; w.position.y = this.waterLevel;
    this.waterMat = mat;
    this.water = w; this.group.add(w);
  }

  // ---------------- sky / light ----------------
  buildSky() {
    const sky = new Sky(); sky.scale.setScalar(48000);
    const u = sky.material.uniforms; u.turbidity.value = 3; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    this.sky = sky; this.scene.add(sky);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = this.q.shadows;
    this.sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
    const sc = this.sun.shadow.camera; sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.near = 1; sc.far = 1500;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x5a5040, 0.8); this.scene.add(this.hemi);
    this.scene.fog = new THREE.FogExp2(0xbfd1e5, 0.00005);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(1000); this.envScene.add(this.envSky);
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 16), new THREE.MeshBasicMaterial({ color: 0x40453a })); this.envGround.rotation.x = -Math.PI / 2; this.envGround.position.y = -20; this.envScene.add(this.envGround);
    // stars
    const sp = new Float32Array(3000 * 3), r = mulberry32(4);
    for (let i = 0; i < 3000; i++) { const th = r() * Math.PI * 2, ph = Math.acos(r() * 1.0); const R = 40000; sp[i * 3] = Math.sin(ph) * Math.cos(th) * R; sp[i * 3 + 1] = Math.cos(ph) * R; sp[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * R; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.scene.add(this.stars);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf4f1e6, fog: false }));
    this.moon = moon; this.scene.add(moon);
    // overcast deck
    const deckTex = puffTexture();
    const dm = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false, map: this.deckTexture() });
    this.deck = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), dm); this.deck.rotation.x = -Math.PI / 2; this.deck.position.y = this.loc.cloudBase + 200; this.scene.add(this.deck);
    this.deck2 = this.deck.clone(); this.deck2.material = dm.clone(); this.deck2.position.y = this.deck.position.y + 250; this.scene.add(this.deck2);
  }
  deckTexture() {
    const s = 512, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), img = g.createImageData(s, s), n = makeNoise(77);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const a = (x / s) * Math.PI * 2, b = (y / s) * Math.PI * 2;
      const v = n.fbm(Math.cos(a) * 2 + 1, Math.sin(a) * 2 + Math.cos(b) * 2, 6) * 0.5 + 0.5;
      const k = 150 + v * 105; const i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = k; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(14, 14); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  setTime(t) {
    this.time = ((t % 24) + 24) % 24;
    const dayFrac = (this.time - 6) / 12; // 0 at 6:00, 1 at 18:00
    const elev = Math.sin(dayFrac * Math.PI) * (dayFrac >= 0 && dayFrac <= 1 ? 62 : 25) * (dayFrac < 0 || dayFrac > 1 ? 1 : 1);
    const el = THREE.MathUtils.degToRad(dayFrac >= 0 && dayFrac <= 1 ? elev : -Math.abs(Math.sin(dayFrac * Math.PI)) * 30);
    const az = THREE.MathUtils.degToRad(90 + dayFrac * 180 - 25);
    this.sunDir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    this.sunElev = el;
    this.applyLighting();
  }
  setWeather(id) {
    this.weatherId = id; this.W = WEATHER[id] || WEATHER.clear;
    const a = this.rnd() * Math.PI * 2;
    this.windBase.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(this.W.wind);
    this.layoutClouds();
    this.applyLighting();
  }
  applyLighting() {
    if (!this.W || !this.sunDir) return;
    const W = this.W, el = this.sunElev;
    const day = smoothstep(-0.12, 0.25, el); // 0 night, 1 day
    const golden = smoothstep(0.45, 0.02, el) * smoothstep(-0.15, 0.02, el);
    this.night = day < 0.25;
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = 2 + W.dark * 8; u.rayleigh.value = 1.2 + golden * 1.5 + W.dark;
    const eu = this.envSky.material.uniforms; for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) eu[k].value = u[k].value; eu.sunPosition.value.copy(this.sunDir);
    const sunCol = new THREE.Color(1, 0.97, 0.92).lerp(new THREE.Color(1, 0.62, 0.32), golden);
    const dark = W.dark;
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.2 * day * (1 - dark * 0.85);
    if (el < 0) { // moonlight
      this.sun.color.set(0x8aa4d6); this.sun.intensity = 0.25 * (1 - dark);
    }
    const lightDir = el < 0 ? new THREE.Vector3(-this.sunDir.x, Math.abs(this.sunDir.y) + 0.3, -this.sunDir.z).normalize() : this.sunDir;
    this.lightDir = lightDir;
    const skyC = new THREE.Color(0x9ec4ff).lerp(new THREE.Color(0xffb27a), golden * 0.5).lerp(new THREE.Color(0x0a1020), 1 - day).lerp(new THREE.Color(0x808890).multiplyScalar(0.3 + day * 0.7), dark * 0.85);
    this.hemi.color.copy(skyC); this.hemi.groundColor.set(0x4a4436).multiplyScalar(0.3 + day * 0.7);
    this.hemi.intensity = 0.25 + day * 0.9 + (el < 0 ? 0.15 : 0);
    // fog / horizon
    const fogDay = new THREE.Color(0xc4d6ea).lerp(new THREE.Color(0xf0b88a), golden * 0.8);
    const fogNight = new THREE.Color(0x0b1220);
    const fogC = fogNight.clone().lerp(fogDay, day).lerp(new THREE.Color(0x9aa1aa).multiplyScalar(0.25 + 0.75 * day), dark * 0.9);
    if (this.loc.desert) fogC.lerp(new THREE.Color(0xe8c9a6).multiplyScalar(0.2 + 0.8 * day), 0.2 * day);
    this.scene.fog.color.copy(fogC); this.fogBase = W.fog * (this.weatherId === 'clear' ? 1.0 : 1.5) * (this.q.res < 200 ? 1.3 : 1);
    this.scene.fog.density = W.fog;
    FOG.fogLin.value = this.fogBase;
    FOG.fogBase.value = this.loc.id === 'alpine' ? this.loc.rwyH - 40 : this.waterLevel;
    FOG.fogFalloff.value = this.weatherId === 'fog' ? 1 / 220 : W.cover ? 1 / 1400 : 1 / 750;
    FOG.fogSunDir.value.copy(this.sunDir);
    FOG.fogSunColor.value.copy(sunCol).multiplyScalar((0.25 + golden * 0.9) * day * (1 - dark * 0.9));
    if (this.waterMat) {
      const U = this.waterMat.userData.U;
      U.sunDir.value.copy(lightDir); U.sunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity / 3.2);
      U.skyZen.value.copy(skyC).multiplyScalar(0.55 + 0.45 * day); U.skyHor.value.copy(fogC).lerp(new THREE.Color(1, 0.75, 0.5), golden * 0.3);
      U.amb.value = 0.25 + 0.75 * day; U.rough.value = W.turb * 0.5;
    }
    if (this.terrainMat) this.terrainMat.userData.U.shadowOn.value = 1 - dark * 0.8;
    this.fogColor = fogC.clone();
    this.sky.visible = true;
    this.skyDarken = dark;
    this.stars.material.opacity = (1 - smoothstep(-0.25, 0.02, el)) * (1 - dark);
    this.moon.position.set(-this.sunDir.x, Math.abs(this.sunDir.y) * 0.6 + 0.25, -this.sunDir.z).normalize().multiplyScalar(38000);
    this.moon.visible = el < 0.1 && dark < 0.6;
    // overcast deck
    const deckOp = W.cover * 0.97;
    this.deck.material.opacity = deckOp; this.deck2.material.opacity = deckOp * 0.8;
    const dc = new THREE.Color(0xb5bbc2).multiplyScalar((0.15 + day * 0.85) * (1 - dark * 0.5));
    this.deck.material.color.copy(dc); this.deck2.material.color.copy(dc).multiplyScalar(1.1);
    this.deck.visible = this.deck2.visible = deckOp > 0.01;
    // scene background below the deck when overcast
    this.overcastColor = fogC.clone();
    // clouds colors
    if (this.clouds) {
      const lit = sunCol.clone().lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar((0.35 + day * 0.95) * (1 - dark * 0.55)).add(new THREE.Color(0.12, 0.13, 0.16));
      const shade = new THREE.Color(0.56, 0.6, 0.68).lerp(new THREE.Color(0.32, 0.34, 0.38), dark).multiplyScalar(0.18 + 0.82 * day).lerp(new THREE.Color(0.75, 0.5, 0.45), golden * 0.25);
      this.clouds.uniforms.litColor.value.copy(lit); this.clouds.uniforms.shadeColor.value.copy(shade);
      this.clouds.uniforms.sunDir.value.copy(this.sunDir); this.clouds.uniforms.sunGlow.value.copy(sunCol).multiplyScalar(day * (1 - dark) * (0.6 + golden));
      this.shadeClouds();
    }
    if (!this.lastBakeDir || this.lastBakeDir.distanceTo(lightDir) > 0.01) { this.lastBakeDir = lightDir.clone(); this.bakeShadows(); }
    // night lights
    if (this.lightsMat) this.lightsMat.opacity = this.night || dark > 0.55 ? 1 : 0;
    if (this.roadGroup) this.roadGroup.userData.lampMat.opacity = this.night || dark > 0.6 ? 1 : 0;
    if (this.windowMats) for (const m of this.windowMats) m.emissiveIntensity = this.night ? 3.5 : 0;
    this.envDirty = true;
  }
  updateEnv() {
    if (!this.envDirty) return;
    this.envDirty = false;
    this.envGround.material.color.copy(this.hemi.groundColor).multiplyScalar(0.6);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.25 + 0.75 * smoothstep(-0.12, 0.25, this.sunElev);
  }

  // ---------------- runway & airport ----------------
  buildRunway() {
    const w = 512, h = 4096, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#4a4b4e'; g.fillRect(0, 0, w, h);
    const id = g.getImageData(0, 0, w, h);
    for (let i = 0; i < id.data.length; i += 4) { const k = (Math.random() - 0.5) * 22; id.data[i] += k; id.data[i + 1] += k; id.data[i + 2] += k; }
    g.putImageData(id, 0, 0);
    // patches
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '30,30,32' : '90,90,92'},0.12)`; g.fillRect(Math.random() * w, Math.random() * h, 40 + Math.random() * 160, 60 + Math.random() * 300); }
    const ppm = h / RWY.len, wpm = w / RWY.width;
    g.fillStyle = '#e9e9e4';
    g.fillRect(wpm * 1, 0, wpm * 0.9, h); g.fillRect(w - wpm * 1.9, 0, wpm * 0.9, h); // edges
    for (let z = 120; z < RWY.len - 120; z += 50) g.fillRect(w / 2 - wpm * 0.45, z * ppm, wpm * 0.9, 30 * ppm); // centreline
    const ends = [[0, 1], [h, -1]];
    for (const [base, dir] of ends) {
      for (let k = 0; k < 8; k++) { const x = wpm * (3 + k * 2.4); g.fillRect(x, base + dir * 6 * ppm - (dir < 0 ? 30 * ppm : 0), wpm * 1.6, 30 * ppm); g.fillRect(w - x - wpm * 1.6, base + dir * 6 * ppm - (dir < 0 ? 30 * ppm : 0), wpm * 1.6, 30 * ppm); }
      for (const off of [300, 450, 600]) for (const sx of [-1, 1]) g.fillRect(w / 2 + sx * wpm * 6 - wpm * 1.5, base + dir * off * ppm - (dir < 0 ? 22 * ppm : 0), wpm * 3, 22 * ppm);
      for (const sx of [-1, 1]) g.fillRect(w / 2 + sx * wpm * 9 - wpm * 2.5, base + dir * 380 * ppm - (dir < 0 ? 45 * ppm : 0), wpm * 5, 45 * ppm);
      // skid marks
      g.fillStyle = 'rgba(15,15,15,0.25)';
      for (let k = 0; k < 40; k++) { const x = w / 2 + (Math.random() - 0.5) * wpm * 12; g.fillRect(x, base + dir * (250 + Math.random() * 450) * ppm, 3, 40 * ppm * Math.random()); }
      g.fillStyle = '#e9e9e4';
    }
    g.font = `bold ${Math.round(12 * ppm)}px Arial`; g.textAlign = 'center';
    g.save(); g.translate(w / 2, h - 60 * ppm); g.scale(1, 1.6); g.fillText('36', 0, 0); g.restore();
    g.save(); g.translate(w / 2, 60 * ppm); g.rotate(Math.PI); g.scale(1, 1.6); g.fillText('18', 0, 0); g.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(RWY.width, RWY.len), new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, this.loc.rwyH + 0.05, 0); mesh.receiveShadow = true; this.group.add(mesh);
    // shoulders, taxiway, apron
    const asph = new THREE.MeshStandardMaterial({ color: 0x55565a, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, map: this.detailTexture() });
    asph.map.repeat.set(20, 20);
    const add = (w2, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w2, l), asph); m.rotation.x = -Math.PI / 2; m.position.set(x, this.loc.rwyH + 0.03, z); m.receiveShadow = true; this.group.add(m); };
    add(20, RWY.len, 80, 0); add(230, 400, 215, 0);
    for (const z of [RWY.len / 2 - 20, -RWY.len / 2 + 20, 0]) add(60, 22, 50, z);
    this.runway = { x: 0, z: 0, h: this.loc.rwyH, len: RWY.len, width: RWY.width, threshold: new THREE.Vector3(0, this.loc.rwyH, RWY.len / 2 - 60), heading: 0 };
    // runway & approach lights (points shown at night)
    const lp = [], lc = [];
    const push = (x, z, c, y = 0.4) => { lp.push(x, this.loc.rwyH + y, z); const cc = new THREE.Color(c); lc.push(cc.r, cc.g, cc.b); };
    for (let z = -RWY.len / 2; z <= RWY.len / 2; z += 60) { push(-RWY.width / 2 - 1, z, 0xfff0c0); push(RWY.width / 2 + 1, z, 0xfff0c0); }
    for (let x = -RWY.width / 2; x <= RWY.width / 2; x += 4) { push(x, RWY.len / 2 + 2, 0x30ff60); push(x, -RWY.len / 2 - 2, 0xff3030); }
    for (let k = 1; k <= 12; k++) for (let x = -8; x <= 8; x += 4) push(x, RWY.len / 2 + k * 30, 0xffffff, 1 + k * 0.4);
    for (let z = -RWY.len / 2; z <= RWY.len / 2; z += 40) { push(62, z, 0x3070ff); push(98, z, 0x3070ff); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    this.lightsMat = new THREE.PointsMaterial({ size: 3.2, color: new THREE.Color(3, 3, 3), vertexColors: true, map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });
    this.group.add(new THREE.Points(lg, this.lightsMat));
    // PAPI (4 lights left of runway near threshold): colour depends on viewer angle
    const pg = new THREE.BufferGeometry();
    const pp = []; for (let k = 0; k < 4; k++) pp.push(-RWY.width / 2 - 12 - k * 9, this.loc.rwyH + 1, RWY.len / 2 - 300);
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(12).fill(1), 3));
    this.papi = new THREE.Points(pg, new THREE.PointsMaterial({ size: 4.5, color: new THREE.Color(3, 3, 3), vertexColors: true, map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.group.add(this.papi);
    for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), M.paint(0x333333)); b.position.set(pp[k * 3], this.loc.rwyH + 0.5, pp[k * 3 + 2] + 0.7); this.group.add(b); }
  }

  buildAirport() {
    const y = this.loc.rwyH;
    const box = (w, h, d, x, z, mat, yy = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y + h / 2 + yy, z); m.castShadow = m.receiveShadow = true; this.group.add(m); return m; };
    // hangars with curved roofs
    const hangMat = new THREE.MeshStandardMaterial({ color: 0xa8adb3, metalness: 0.6, roughness: 0.45 });
    for (const z of [-120, -40]) {
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 60, 24, 1, false, -Math.PI / 2, Math.PI), hangMat);
      roof.rotation.x = Math.PI / 2; roof.rotation.z = Math.PI / 2; roof.scale.set(1, 1, 0.55); roof.position.set(300, y + 9, z); roof.castShadow = roof.receiveShadow = true; this.group.add(roof);
      box(60, 9, 44, 300, z, hangMat);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(36, 14), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 1 })); door.position.set(269.9, y + 7, z); door.rotation.y = -Math.PI / 2; this.group.add(door);
    }
    // terminal with windows
    const winTex = this.windowTex();
    const termMat = new THREE.MeshStandardMaterial({ color: 0xe6e2da, roughness: 0.8, map: winTex, emissive: 0xffd99a, emissiveMap: winTex, emissiveIntensity: 0 });
    this.windowMats = [termMat];
    box(30, 12, 110, 315, 120, termMat);
    // tower
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 30, 16), new THREE.MeshStandardMaterial({ color: 0xdcd8d0, roughness: 0.8 })); tw.position.set(260, y + 15, 210); tw.castShadow = true; this.group.add(tw);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(6, 5, 5, 8), M.glass(0x5577aa)); cab.position.set(260, y + 32.5, 210); this.group.add(cab);
    const cr = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.6, 0.8, 8), M.paint(0x333333)); cr.position.set(260, y + 35.3, 210); this.group.add(cr);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), M.light(0x40ff80).clone()); this.beacon.position.set(260, y + 36.5, 210); this.group.add(this.beacon);
    // fuel tanks
    for (let k = 0; k < 3; k++) { const t = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 9, 20), M.paint(0xf2f2ee)); t.position.set(360 + k * 13, y + 4.5, -200); t.castShadow = true; this.group.add(t); }
    // windsock
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 8, 8), M.paint(0xdddddd)); pole.position.set(-45, y + 4, 600); this.group.add(pole);
    const sockG = new THREE.ConeGeometry(0.7, 4, 12, 5, true); sockG.rotateX(-Math.PI / 2); sockG.translate(0, 0, 2);
    const cols = []; const sp = sockG.attributes.position; for (let i = 0; i < sp.count; i++) { const band = Math.floor(sp.getZ(i) / 0.81) % 2; cols.push(1, band ? 1 : 0.35, band ? 1 : 0.05); }
    sockG.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.sock = new THREE.Mesh(sockG, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 })); this.sock.position.set(-45, y + 7.6, 600); this.group.add(this.sock);
  }
  windowTex() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#222a33';
    for (let y = 18; y < 120; y += 34) for (let x = 6; x < 128; x += 20) g.fillRect(x, y, 12, 16);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }

  addParked(objs) { // place parked aircraft meshes on the apron
    const spots = [[200, -160, 1.2], [200, -80, 1.6], [190, 40, 1.4], [230, 160, 1.8]];
    objs.forEach((o, i) => { const s = spots[i % spots.length]; o.position.x += s[0]; o.position.z += s[1]; o.rotation.y = s[2]; this.group.add(o); });
  }

  // ---------------- vegetation ----------------
  nearRoad(x, z, d) {
    const cx = Math.floor(x / 40), cz = Math.floor(z / 40), R = Math.ceil(d / 40);
    for (let i = cx - R; i <= cx + R; i++) for (let j = cz - R; j <= cz + R; j++) {
      const arr = this.roadHash.get(i + ',' + j); if (!arr) continue;
      for (const [px, pz, hw] of arr) if ((px - x) ** 2 + (pz - z) ** 2 < (d + hw) ** 2) return true;
    }
    return false;
  }
  treeHit(p) { return this.flora.hit(p) || this.towns.hit(p); }
  // ---------------- clouds ----------------
  buildClouds() {
    this.clouds = new Billboards(1600, puffTexture(), { nearFade: 0.9 });
    this.scene.add(this.clouds.mesh);
  }
  layoutClouds() {
    if (!this.clouds) return;
    const W = this.W, r = mulberry32(this.loc.seed + this.weatherId.length * 13);
    const n = Math.round(W.clouds * 70 * this.q.clouds);
    this.cloudList = []; this.thermals = []; this.puffs = [];
    let k = 0;
    const base = this.loc.cloudBase * (W.cover ? 0.75 : 1);
    for (let c = 0; c < n && k < 1550; c++) {
      const cx = (r() - 0.5) * 26000, cz = (r() - 0.5) * 26000;
      const big = 0.7 + r() * 1.1 * (W.storm ? 1.6 : 1);
      const puffs = 10 + Math.floor(r() * 14 * big);
      const cy = base + r() * 300;
      const R = 330 * big;
      this.cloudList.push({ x: cx, y: cy + 200 * big, z: cz, r: R });
      if (!W.cover && r() < 0.7) this.thermals.push({ x: cx, z: cz, r: 220 * big, top: cy, strength: 2 + r() * 2.5 });
      for (let p = 0; p < puffs && k < 1550; p++) {
        const a = r() * 6.28, d = Math.sqrt(r()) * R;
        const h = (1 - d / R);
        const px = cx + Math.cos(a) * d * 1.3, pz = cz + Math.sin(a) * d, py = cy + r() * 260 * big * h;
        const size = (260 + r() * 260) * big * (0.6 + 0.6 * h);
        const shade = 0.72 + (py - cy) / (260 * big) * 0.45;
        this.puffs[k] = [px, py + size * 0.25, pz, size, r() * 6.28, shade, 0.9, cx, cy + 120 * big, cz]; this.clouds.set(k++, px, py + size * 0.25, pz, size, this.puffs[k - 1][4], shade, shade, shade, 0.9);
      }
      // flat dark base
      for (let p = 0; p < 4 && k < 1550; p++) { const a = r() * 6.28, d = r() * R * 0.6; this.puffs[k] = [cx + Math.cos(a) * d, cy, cz + Math.sin(a) * d, R * 1.1, r() * 6.28, 0.6, 0.8, cx, cy + 300, cz]; k++; }
    }
    this.cloudCount = k; this.shadeClouds();
  }
  shadeClouds() { // light each puff by which side of its cloud faces the sun
    if (!this.puffs || !this.sunDir) return;
    const d = this.sunDir; let k = 0;
    for (const q of this.puffs) {
      if (!q) continue;
      const ox = q[0] - q[7], oy = (q[1] - q[8]) * 1.6, oz = q[2] - q[9], L = Math.hypot(ox, oy, oz) || 1;
      const side = (ox * d.x + oy * d.y + oz * d.z) / L;
      const sh = q[5] * (0.62 + 0.38 * side) + 0.12;
      this.clouds.set(k++, q[0], q[1], q[2], q[3], q[4], sh, sh, sh, q[6]);
    }
    this.clouds.commit(k);
  }
  // How visible is the sun from the camera? (terrain, clouds and overcast block it)
  sunVisibility(cam) {
    const d = this.sunDir; if (!d || d.y < -0.02) return 0;
    if (this.W.cover && cam.position.y < this.deck2.position.y + 50) return 0;
    const p = cam.position.clone(); let vis = 1;
    for (let i = 1; i <= 36; i++) {
      const t = i * i * 9; p.copy(cam.position).addScaledVector(d, t);
      if (Math.abs(p.x) < this.half && Math.abs(p.z) < this.half && this.sampleGrid(p.x, p.z) > p.y) return 0;
      if (i % 3 === 0) vis = Math.min(vis, 1 - this.inCloud(p) * 3);
      if (vis <= 0) return 0;
    }
    return vis * smoothstep(-0.02, 0.08, d.y);
  }
  inCloud(p) {
    let best = 0;
    if (this.cloudList) for (const c of this.cloudList) { const d = Math.hypot(p.x - c.x, (p.y - c.y) * 1.6, p.z - c.z); if (d < c.r) best = Math.max(best, 1 - d / c.r); }
    if (this.W.cover) { const dy = Math.abs(p.y - (this.deck.position.y + 120)); if (dy < 180) best = Math.max(best, 1 - dy / 180); }
    return best;
  }

  // ---------------- precipitation ----------------
  buildPrecip() {
    const n = 5000;
    const rg = new THREE.BufferGeometry(); this.rainPos = new Float32Array(n * 6); this.rainDrops = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { this.rainDrops[i * 3] = (Math.random() - 0.5) * 120; this.rainDrops[i * 3 + 1] = (Math.random() - 0.5) * 80; this.rainDrops[i * 3 + 2] = (Math.random() - 0.5) * 120; }
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.35, fog: true }));
    this.rain.frustumCulled = false; this.rain.visible = false; this.scene.add(this.rain);
    const sg = new THREE.BufferGeometry(); this.snowPos = new Float32Array(n * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, map: glowTexture(), transparent: true, depthWrite: false }));
    this.snow.frustumCulled = false; this.snow.visible = false; this.scene.add(this.snow);
    this.flash = 0; this.nextBolt = 5;
  }
  updatePrecip(dt, cam, camVel) {
    const W = this.W;
    const below = cam.position.y < this.loc.cloudBase + 200;
    this.rain.visible = W.rain > 0 && below; this.snow.visible = W.snow > 0 && below;
    const d = this.rainDrops, n = d.length / 3;
    const wind = this.windBase;
    if (this.rain.visible) {
      const fall = new THREE.Vector3(wind.x, -14, wind.z);
      const rel = fall.clone().sub(camVel).multiplyScalar(0.025 + 0.0);
      const count = Math.floor(n * Math.min(1, W.rain * 0.7));
      for (let i = 0; i < n; i++) {
        d[i * 3] += (fall.x - camVel.x) * dt; d[i * 3 + 1] += (fall.y - camVel.y) * dt; d[i * 3 + 2] += (fall.z - camVel.z) * dt;
        for (let a = 0; a < 3; a++) { const lim = a === 1 ? 40 : 60; if (d[i * 3 + a] < -lim) d[i * 3 + a] += lim * 2; else if (d[i * 3 + a] > lim) d[i * 3 + a] -= lim * 2; }
        const x = cam.position.x + d[i * 3], y = cam.position.y + d[i * 3 + 1], z = cam.position.z + d[i * 3 + 2];
        const o = i * 6;
        if (i >= count) { this.rainPos.fill(0, o, o + 6); continue; }
        this.rainPos[o] = x; this.rainPos[o + 1] = y; this.rainPos[o + 2] = z;
        this.rainPos[o + 3] = x - rel.x * 1.5; this.rainPos[o + 4] = y - rel.y * 1.5; this.rainPos[o + 5] = z - rel.z * 1.5;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.material.color.copy(this.fogColor).multiplyScalar(1.15);
    }
    if (this.snow.visible) {
      for (let i = 0; i < n; i++) {
        d[i * 3] += (wind.x + Math.sin(this.t + i) * 0.8 - camVel.x) * dt; d[i * 3 + 1] += (-1.5 - camVel.y) * dt; d[i * 3 + 2] += (wind.z + Math.cos(this.t * 0.7 + i) * 0.8 - camVel.z) * dt;
        for (let a = 0; a < 3; a++) { const lim = a === 1 ? 40 : 60; if (d[i * 3 + a] < -lim) d[i * 3 + a] += lim * 2; else if (d[i * 3 + a] > lim) d[i * 3 + a] -= lim * 2; }
        this.snowPos[i * 3] = cam.position.x + d[i * 3]; this.snowPos[i * 3 + 1] = cam.position.y + d[i * 3 + 1]; this.snowPos[i * 3 + 2] = cam.position.z + d[i * 3 + 2];
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ---------------- wind ----------------
  windAt(p) {
    const w = this.windBase.clone().add(this.gust);
    // stronger aloft
    const agl = p.y - this.loc.rwyH;
    w.multiplyScalar(0.6 + Math.min(1, Math.max(0, agl) / 600) * 0.6);
    // ridge lift
    const h = this.sampleGrid(p.x, p.z), hx = this.sampleGrid(p.x + 40, p.z), hz = this.sampleGrid(p.x, p.z + 40);
    const ag = p.y - h;
    if (ag < 700 && ag > 0) w.y += ((hx - h) / 40 * -this.windBase.x + (hz - h) / 40 * -this.windBase.z) * -1 * (1 - ag / 700) * 1.2;
    // thermals
    for (const t of this.thermals) {
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      if (d < t.r * 1.5 && p.y < t.top) w.y += t.strength * Math.max(0, 1 - (d / t.r) ** 2) - (d > t.r ? 0.6 : 0);
    }
    return w;
  }

  update(dt, camera, camVel, events) {
    this.t += dt;
    // gusts / turbulence
    const W = this.W;
    if (Math.random() < dt * 1.5) this.gustT.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 2).multiplyScalar(W.turb * 4);
    this.gust.lerp(this.gustT, Math.min(1, dt * 2));
    // water anim
    FOG.uTime.value = this.t;
    // lights follow camera
    const tgt = camera.userData.focus || camera.position;
    this.sun.target.position.copy(tgt);
    this.sun.position.copy(tgt).addScaledVector(this.lightDir, 600);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.moon.position.add(camera.position.clone().sub(this.lastCam || camera.position));
    this.lastCam = camera.position.clone();
    this.deck.position.x = camera.position.x - (camera.position.x % 4000); this.deck.position.z = camera.position.z - (camera.position.z % 4000);
    this.deck2.position.x = this.deck.position.x; this.deck2.position.z = this.deck.position.z;
    this.deck.material.map.offset.x += dt * 0.0004;
    // clouds
    this.clouds.updateCamera(camera, this.scene.fog);
    // in-cloud whiteout
    const ic = this.inCloud(camera.position);
    FOG.fogLin.value = this.fogBase + ic * 0.03;
    if (ic > 0) this.scene.fog.color.copy(this.fogColor).lerp(new THREE.Color(0xd8dde3).multiplyScalar(0.3 + 0.7 * smoothstep(-0.1, 0.25, this.sunElev)), ic);
    else this.scene.fog.color.copy(this.fogColor);
    // above deck: clear fog
    const aboveDeck = W.cover && camera.position.y > this.deck2.position.y + 50;
    if (aboveDeck) FOG.fogLin.value = 0.00003;
    this.sky.visible = !W.cover || aboveDeck;
    this.renderer.setClearColor(this.scene.fog.color);
    this.waterMat.userData.U.fogColor.value.copy(this.scene.fog.color);
    this.updatePrecip(dt, camera, camVel);
    // lightning
    if (W.storm) {
      this.nextBolt -= dt;
      if (this.nextBolt < 0) { this.nextBolt = 4 + Math.random() * 10; this.flash = 1; events.push({ type: 'thunder', delay: 0.5 + Math.random() * 4, power: Math.random() }); }
    }
    if (this.flash > 0) { this.flash -= dt * 4; this.hemi.intensity += Math.max(0, this.flash) * 3; }
    else if (this.flash > -1) { this.flash = -2; this.applyLighting(); }
    // windsock
    const w = this.windBase.clone().add(this.gust);
    if (w.lengthSq() > 0.01) { this.sock.lookAt(this.sock.position.clone().add(w)); this.sock.rotateX(-0.35 * Math.max(0, 1 - w.length() / 12)); }
    // beacon
    this.beacon.material.color.setHex(Math.floor(this.t * 1.2) % 2 ? 0x40ff80 : 0xffffff).multiplyScalar(5);
    // PAPI
    const thr = new THREE.Vector3(-RWY.width / 2 - 25, this.loc.rwyH, RWY.len / 2 - 300);
    const rel = camera.position.clone().sub(thr);
    const ang = THREE.MathUtils.radToDeg(Math.atan2(rel.y, Math.hypot(rel.x, rel.z)));
    const cols = this.papi.geometry.attributes.color;
    const th = [2.5, 2.83, 3.17, 3.5];
    for (let k = 0; k < 4; k++) { const white = ang > th[k]; cols.setXYZ(k, 1, white ? 1 : 0.1, white ? 1 : 0.1); }
    cols.needsUpdate = true;
    this.updateEnv();
  }

  dispose() {
    this.scene.remove(this.group, this.sky, this.sun, this.sun.target, this.hemi, this.stars, this.moon, this.deck, this.deck2, this.clouds.mesh, this.rain, this.snow);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.scene.environment = null; this.scene.fog = null;
  }
}
