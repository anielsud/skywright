// Environment: terrain, water, sky, sun, weather, clouds, airport and scenery.
import * as THREE from 'three';
import { makeNoise, mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { glowTexture, M } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { FOG, FOG_GLSL, terrainMaterial, waterMaterial, swayMaterial } from './shaders.js';
import { Atmosphere, skyMaterial, cloudNoiseTexture } from './sky.js';
import { CloudField, deckMaterial } from './clouds.js';
import { planNetwork, flattenGrid, flattenHi, makePainter, buildRoadMeshes, gradeReal, roadSurface } from './roads.js';
import { Flora } from './flora.js';
import { Towns } from './towns.js';
import { Builder, buildingMaterial, C } from './buildings.js';
import { TerrainTiles } from './tiles.js';
import { erode } from './erosion.js';
import { terrainDetailUniforms } from './terrainTex.js';
import { CascadedShadows, NEAR_SHADOW } from './cascades.js';
import { REAL_LOCATIONS, realData } from './realworld.js';
import { SpaceView } from './space.js';
import { RealScenery } from './realBuildings.js';
import { Destruction } from './destruction.js';
import { BAKED, preloadBake, bakeFor, withBake, landAt } from './terrainBake.js';
import { Landcover } from './landcover.js';
import { LaunchPad } from './launchpad.js';
import { Helipads } from './helipad.js';
import { StuntParks, planStunts, padsHeight } from './stuntPark.js';
import { roadStart } from './landStart.js';
import { Marina } from './marina.js';
import { MOON_U, moonAge, moonPhase, moonLagHours, loadMoonTexture } from './moon.js';

export const RWY = { len: 1800, width: 45 };
// Two parallel runways (the airport is centred on the east one, which has the PAPI and the landing mission).
// Facing north the west one is on the left, so it is 36L / 18R; the east one is 36R / 18L.
export const RUNWAYS = [{ x: 0, name: '36R', back: '18L' }, { x: -200, name: '36L', back: '18R' }];

export const LOCATIONS = {
  alpine: { hidden: true, // kept for old saves / sessions, not offered in the picker
    id: 'alpine', name: 'Alpine Valley', desc: 'Snowy peaks, a glacier lake, pine forests and a mountain village.', seed: 11, rwyH: 30, water: 0, cloudBase: 2300, trees: 'pine',
    colors: { grass: [0x4a6b2a, 0x5f7f35, 0x3f5d27], rock: 0x6b6660, snow: 0xf4f6f8, sand: 0x9a8d6a, dirt: 0x6f5a3c }, snowline: 1250, balloons: true, erosion: { cell: 800, depth: 0.16, octaves: 4 },
    height(n, x, z) {
      const vx = x - Math.sin(z / 2600) * 900; // valley centre line meanders
      let dv = Math.abs(vx);
      // more parallel valleys every 9.5 km, so the endless mountains stay flyable
      const k0 = Math.round(x / 9500);
      for (const k of [k0 - 1, k0, k0 + 1]) if (k) dv = Math.min(dv, Math.abs(x - k * 9500 - Math.sin(z / 2600 + k * 1.7) * 900));
      const mask = smoothstep(500, 2600, dv);
      const peaks = n.ridged(x / 3800, z / 3800, 3) * 2100 + n.fbm(x / 1500, z / 1500, 2) * 220; // big shapes only: erosion adds the detail
      let h = 25 + n.fbm(x / 1200, z / 1200, 3) * 18 + mask * peaks;
      const lake = Math.hypot(x - 1500, z + 3800); if (lake < 1300) h = lerp(-25, h, smoothstep(700, 1300, lake));
      return h;
    },
  },
  islands: null, // Bora Bora (real, src/realworld.js) took the Coral Islands' place: same id, so saved settings and online sessions carry over
  canyon: null, // the Grand Canyon (real, src/realworld.js) took the Red Canyon's place, the same way
};

// real places from baked geodata (src/realworld.js): loaded before the World is built
Object.assign(LOCATIONS, REAL_LOCATIONS);

export const WEATHER = {
  clear: { name: 'Clear', clouds: 0.25, cover: 0, fog: 0.000045, wind: 3, turb: 0.15, rain: 0, snow: 0, storm: 0, dark: 0, haze: 1, cirrus: 0.3 },
  cloudy: { name: 'Cumulus', clouds: 0.85, cover: 0, fog: 0.00006, wind: 6, turb: 0.4, rain: 0, snow: 0, storm: 0, dark: 0.1, haze: 1.6, cirrus: 0.4 },
  overcast: { name: 'Overcast', clouds: 0.25, cover: 1, fog: 0.0001, wind: 7, turb: 0.4, rain: 0, snow: 0, storm: 0, dark: 0.45, haze: 2, cirrus: 0.3 },
  rain: { name: 'Rain', clouds: 0.3, cover: 1, fog: 0.00018, wind: 9, turb: 0.7, rain: 1, snow: 0, storm: 0, dark: 0.6, haze: 2.5, cirrus: 0 },
  storm: { name: 'Thunderstorm', clouds: 0.5, cover: 1, fog: 0.00024, wind: 15, turb: 1.4, rain: 1.6, snow: 0, storm: 1, dark: 0.8, haze: 3, cirrus: 0 },
  snow: { name: 'Snow', clouds: 0.2, cover: 1, fog: 0.0002, wind: 5, turb: 0.35, rain: 0, snow: 1, storm: 0, dark: 0.35, haze: 2, cirrus: 0 },
  fog: { name: 'Fog', clouds: 0.1, cover: 0, fog: 0.0007, wind: 1, turb: 0.05, rain: 0, snow: 0, storm: 0, dark: 0.25, haze: 4, cirrus: 0.15 },
};

const SHORE_UNDER = 0.5, SHORE_OVER = 0.3; // metres: see World.shoreSnap
const QUALITY = {
  low: { res: 180, bake: 384, trees: 6000, shadows: false, shadowSize: 1024, clouds: 0.45, cirrus: false, pixel: 1, post: false },
  medium: { res: 220, bake: 640, trees: 12000, shadows: true, shadowSize: 1024, clouds: 0.65, cirrus: true, pixel: 1.25, post: true },
  high: { res: 420, bake: 1024, trees: 32000, shadows: true, shadowSize: 4096, clouds: 1, cirrus: true, pixel: 2, post: true },
  // desktop GPUs: everything High has, plus cascaded shadows out to ~3.6 km (and AO, sun shafts, SMAA in post.js)
  ultra: { res: 420, bake: 1024, trees: 32000, shadows: true, shadowSize: 4096, clouds: 1, cirrus: true, pixel: 2, post: true, cascades: true },
};
// Tables keyed by tier that predate Ultra: look Ultra up as High (World.qBase). Content that wants more on Ultra checks qName.
export const baseTier = (q) => (q === 'ultra' ? 'high' : q);
export { QUALITY };

export class World {
  constructor(renderer, scene, opts) {
    this.renderer = renderer; this.scene = scene;
    this.loc = LOCATIONS[opts.location] || LOCATIONS.alpine;
    this.q = QUALITY[opts.quality] || QUALITY.medium; this.qName = opts.quality || 'medium'; this.qBase = baseTier(this.qName);
    this.noise = makeNoise(this.loc.seed);
    // the one height function everything uses (core bake, streamed tiles, physics fallback): location shape + erosion,
    // plus the offline landscape-evolution bake around the airport where there is one (src/terrainBake.js)
    const base = (x, z) => this.loc.height(this.noise, x, z);
    const analytic = this.loc.erosion === false ? base : erode(base, { seed: this.loc.seed, ...this.loc.erosion });
    this.bake = bakeFor(this.loc.id);
    this.height = withBake(analytic, this.bake);
    if (this.height === analytic) this.bake = null;
    this.cover = new Landcover(this);
    this.rnd = mulberry32(this.loc.seed * 7);
    this.time = opts.time ?? 10; this.weatherId = opts.weather || 'clear';
    this.waterLevel = this.loc.water;
    this.detailU = terrainDetailUniforms(this.loc.id, this.waterLevel, this.loc.snowline, this.qName);
    // real location: satellite imagery is the ground colour, OSM drives roads, buildings and forests
    this.real = this.loc.real ? realData(this.loc) : null;
    if (this.loc.real && !this.real) throw new Error('location data not loaded');
    if (this.real) Object.assign(this.detailU, this.real.uniforms());
    this.landUniforms(); // no bake on real places: rivers/lakes off (and compiled out of the terrain shader)
    this.size = this.loc.core || 22000; // (a real place can ask for a bigger detailed core: New York's reaches the Statue of Liberty)
    this.coreK = this.size / 22000; // grid and bake resolutions scale with it, so the spacing stays the same
    this.stuntPlan = this.loc.stunts ? planStunts(this, this.loc.stunts) : null; // where the stunt sites go (found from the real data) and the ground they level (rawHeight)
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
    if (this.real) this.net.towns = this.real.towns(this);
    this.towns = this.real ? new RealScenery(this) : new Towns(this);
    if (this.stuntPlan) { // the stunt park and the canyon jump (src/stuntPark.js): nothing grows on them
      this.stunts = new StuntParks(this, this.stuntPlan);
      const F = this.flora, bare = F.bare, S = this.stunts; F.setForestMask(F.mask, (x, z) => S.bare(x, z) || (bare ? bare(x, z) : false));
    }
    // rooftop helipads (New York): on the roofs the city found for them; helicopters start on the first
    const hp = this.towns.city?.helipads; this.helipads = hp?.some((h) => h.roof) ? new Helipads(this, hp) : null;
    // structures the flight model stands on (collide.js CollisionMesh: World.surfRay / surfPoint)
    this.surfs = [...(this.stunts?.sites.map((x) => x.cm) || []), ...(this.helipads?.cms || [])];
    // a place's own starts for some kinds of vehicle, instead of the runway (startSite): fits(st) picks the vehicles
    this.sites = [];
    if (this.helipads?.start) { const P = this.helipads.start; this.sites.push({ kind: 'helipad', name: P.name, fits: (st) => st.heli, pos: P.W(0, 0, 0), y: P.y, heading: P.heading, r: P.D }); }
    this.destruct = new Destruction(this); // buildings you can knock down
    this.pad = new LaunchPad(this); // the launch complex rockets start from (after the scenery: it keeps clear of it)
    this.marina = this.loc.marina ? Marina.create(this, this.loc.marina) : null; // where boats start (marina.js), clear of the scenery too
    if (this.marina) this.surfs.push(this.marina.cm); // (its docks and piers are solid)
    if (this.marina) { // boats start afloat at the marina's channel mouth, facing open water (startSite: a boat that picks 'At the marina')
      const M = this.marina, S = M.start, right = new THREE.Vector3(Math.cos(S.heading), 0, -Math.sin(S.heading));
      this.sites.push({ kind: 'marina', name: M.river ? 'the river landing' : 'the marina', fits: (st) => !!st.boat, afloat: true, pos: S.pos, heading: S.heading, y: M.wl, r: 30,
        at: (slot = 0) => S.pos.clone().addScaledVector(right, slot ? (slot % 2 ? -14 : 14) * Math.ceil(slot / 2) : 0) }); // online: side by side, 14 m apart
    }
    this.buildClouds();
    this.buildPrecip();
    this.setWeather(this.weatherId);
    this.setTime(this.time);
    this.tiles = new TerrainTiles(this); // endless land beyond the detailed core
    this.space = new SpaceView(this); // up high: the planet below, a black sky, a sea of cloud (nothing below 5 km)
  }

  // Resolves once everything a World for this location loads asynchronously is in (the terrain bake). Never rejects.
  static prepare(locId) { return BAKED.includes(locId) ? preloadBake(locId).catch(() => null) : Promise.resolve(null); }

  // ---------------- terrain ----------------
  // The baked hydrology/land maps on the GPU: the terrain shader draws rivers, lakes and wet banks from them.
  landUniforms() {
    const B = this.bake, U = this.detailU;
    if (B) {
      const t = new THREE.DataTexture(B.land, B.nw, B.nw, THREE.RGBAFormat);
      t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
      this.landTex = t;
    }
    U.landTex.value = this.landTex || null; U.landOn.value = B ? 1 : 0; U.landDry.value = B?.dry ? 1 : 0;
    U.landOrig.value.set(B ? B.x0 - B.lcell / 2 : 0, B ? B.x0 - B.lcell / 2 : 0); U.landSpan.value = B ? B.span + B.lcell : 1;
  }
  // No rivers or lakes on the airfield or in the towns (they are flattened over): clear the water map there.
  dryLand() {
    const B = this.bake; if (!B) return;
    if (!B.water0) { B.water0 = new Uint8Array(B.nw * B.nw); for (let k = 0; k < B.water0.length; k++) B.water0[k] = B.land[k * 4]; } // pristine copy: towns move with quality
    else for (let k = 0; k < B.water0.length; k++) B.land[k * 4] = B.water0[k];
    const zones = [[(x, z) => Math.hypot(Math.max(0, Math.abs(x - 100) - 350), Math.max(0, Math.abs(z) - RWY.len / 2 - 250)), 150, 500]];
    for (const t of this.net?.towns || []) zones.push([(x, z) => Math.hypot(x - t.c.x, z - t.c.z) - 420 * t.size, 0, 200]);
    const n = B.nw, c = B.lcell, x0 = B.x0, land = B.land;
    for (let j = 0; j < n; j++) {
      const z = x0 + j * c; if (Math.abs(z) > 6000) continue;
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4; if (!land[k]) continue;
        const x = x0 + i * c; let f = 1;
        for (const [d, a, b] of zones) f = Math.min(f, smoothstep(a, b, d(x, z)));
        if (f < 1) land[k] = Math.round(land[k] * f);
      }
    }
    if (this.landTex) this.landTex.needsUpdate = true;
  }
  // [water, drain, depo, wet] at (x,z), each 0..1 (zeros where there is no bake): rivers/lakes, drainage (log area),
  // scree/alluvium, wetness. Vegetation and props can use it to keep out of rivers.
  landAt(x, z, out = [0, 0, 0, 0]) { return landAt(this.bake, x, z, out); }
  // Forest density 0..1 at (x,z): what the vegetation plants (Flora's F) and the canopy colour in the baked albedo.
  // Cached on a 10 m lattice (vegetation asks for it at every candidate tree).
  forestAt(x, z) {
    if (this.real) return smoothstep(-0.02, 0.18, this.noise.fbm(x / 260 + 7, z / 260, 3)); // real places: Flora's mapped-forest mask comes first; noise outside the data, as before
    const ix = Math.round(x / 10), iz = Math.round(z / 10), key = ix * 131072 + iz;
    let c = this.forestCache || (this.forestCache = new Map()), v = c.get(key);
    if (v !== undefined) return v;
    if (c.size > 300000) c.clear();
    const cx = ix * 10, cz = iz * 10, e = 6, h = this.sampleGrid(cx, cz), hx = this.sampleGrid(cx + e, cz), hz = this.sampleGrid(cx, cz + e);
    const l = Math.hypot(h - hx, e, h - hz), slope = 1 - e / l;
    v = this.cover.forest(cx, cz, h, slope, undefined, undefined, (h - hz) / l);
    c.set(key, v); return v;
  }
  // No ground within a few decimetres of the water level, in every height grid the ground is drawn from and physics
  // uses (core bake, coarse core mesh, streamed tiles): under water it is at least SHORE_UNDER below, dry land at least
  // SHORE_OVER above. Otherwise gentle beaches, and the edges of the Jungfrau lakes after resampling their 20 m grid,
  // leave ground and water at nearly the same height over wide areas, which no depth buffer can tell apart at a distance.
  shoreSnap(h) { const wl = this.waterLevel; return h < wl ? Math.min(h, wl - SHORE_UNDER) : Math.max(h, wl + SHORE_OVER); }
  rawHeight(x, z) {
    const h = this.height(x, z);
    // flatten airport
    const dx = Math.max(0, Math.abs(x - 100) - 350), dz = Math.max(0, Math.abs(z) - RWY.len / 2 - 250);
    const d = Math.hypot(dx, dz);
    const t = smoothstep(0, this.loc.padBlend || 700, d); // padBlend: a tighter apron, e.g. an airport on a narrow reef islet
    const a = lerp(this.loc.rwyH, h, t);
    return this.stuntPlan ? padsHeight(this.stuntPlan.pads, x, z, a) : a; // the stunt sites' levelled ground (after the airport's: a park can sit near it)
  }
  buildTerrain() {
    const N = Math.round(this.q.res * this.coreK), S = this.size, half = S / 2, step = S / N;
    this.N = N; this.step = step; this.half = half;
    const H = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H[j * (N + 1) + i] = this.rawHeight(-half + i * step, -half + j * step);
    this.H = H;
    // road / rail network, towns and fields; flattened into the heightfield
    this.rawFine(); // the fine grid's raw heights: routing and road profiles read them, then they are carved and baked
    this.net = this.real ? this.real.network(this) : planNetwork(this);
    if (this.real) gradeReal(this, this.net);
    this.dryLand(); // no-op without a terrain bake (real places)
    flattenGrid(this, this.net);
    for (let k = 0; k < H.length; k++) H[k] = this.shoreSnap(H[k]);
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
    const sst = S / (this.shadowR - 1), maps = { detailU: this.detailU, albedo: this.albedoTex, normal: this.normalTex, shadow: this.shadowTex, orig: new THREE.Vector2(-half - this.hStep / 2, -half - this.hStep / 2), span: S + this.hStep, sOrig: new THREE.Vector2(-half - sst / 2, -half - sst / 2), sSpan: S + sst };
    const mat = terrainMaterial(maps);
    this.terrainMat = mat; this.patchMat = terrainMaterial(maps, true);
    const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true;
    this.terrain = mesh; this.group.add(mesh);
    this.roadGroup = buildRoadMeshes(this, this.net); this.group.add(this.roadGroup);
    this.buildMinimap();
    this.buildPatch();
  }
  // The fine grid's heights straight from the height function (before towns and roads are carved in).
  rawFine() {
    const R = this.bakeRes(), half = this.half, st = this.size / R, W = R + 1, Hh = new Float32Array(W * W);
    for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) Hh[j * W + i] = this.rawHeight(-half + i * st, -half + j * st);
    this.Hh0 = Hh; this.hR0 = R;
  }
  // Bake high-resolution albedo (+AO) and normal maps from the analytic height function.
  bakeTerrain() {
    const R = this.bakeRes(), S = this.size, half = this.half, st = S / R, W = R + 1;
    if (this.hR0 !== R) this.rawFine();
    const Hh = this.Hh0; this.Hh0 = null;
    flattenHi(this, this.net, Hh, R);
    for (let k = 0; k < Hh.length; k++) Hh[k] = this.shoreSnap(Hh[k]);
    const paint = makePainter(this, this.net);
    this.Hh = Hh; this.hR = R; this.hStep = st;
    this.roadSurf = roadSurface(this, this.net); // from here on sampleGrid/groundAt stand on the roads and bridges
    // heights padded beyond the core edge, so AO and normals at the border match the streamed tiles next to it
    const pad = this.bakePad(st), PW = W + 2 * pad, Hp = new Float32Array(PW * PW);
    for (let j = 0; j < PW; j++) for (let i = 0; i < PW; i++) {
      const gi = i - pad, gj = j - pad;
      Hp[j * PW + i] = gi >= 0 && gj >= 0 && gi <= R && gj <= R ? Hh[gj * W + gi] : this.shoreSnap(this.rawHeight(-half + gi * st, -half + gj * st));
    }
    const maps = { alb: new Uint8Array(W * W * 4), nor: new Uint8Array(W * W * 4) };
    const bake = this.bakeMaps(Hp, R, pad, -half, -half, st, paint, maps); while (!bake.next().done);
    this.albedoTex = this.dataTex(maps.alb, W, true);
    this.normalTex = this.dataTex(maps.nor, W);
    const SR = Math.floor(this.q.bake / 2) + 1; // terrain self-shadow map: re-traced when the sun moves, so it keeps the tier's base size
    this.shadowData = new Uint8Array(SR * SR * 4).fill(255);
    this.shadowTex = this.dataTex(this.shadowData, SR); this.shadowTex.generateMipmaps = false; this.shadowTex.minFilter = THREE.LinearFilter;
    this.shadowR = SR;
  }
  // Ground heights of a grid mesh for the water shader (where water is drawn at all, shallows, foam): one texel per
  // vertex, relative to the water level (full precision at the shore even for a lake at 561 m), read texel by texel
  // and interpolated over the mesh's own triangles.
  heightTex(H, W) {
    const d = new Float32Array(W * W);
    for (let k = 0; k < d.length; k++) d[k] = H[k] - this.waterLevel;
    const t = new THREE.DataTexture(d, W, W, THREE.RedFormat, THREE.FloatType);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }
  // Core bake resolution: ultra resolves the eroded terrain's gullies (~14 m texels; ~2 s more loading than 1024)
  bakeRes() { return Math.round((this.qName === 'ultra' && this.bake ? Math.max(this.q.bake, 1536) : this.q.bake) * this.coreK / 8) * 8; }
  // Padding (texels) a bake needs around its grid: the wider AO blur radius, plus one for normals.
  bakePad(st) { return Math.max(1, Math.round(10 * (this.size / this.coreK / this.q.bake) / st)) + 1; }
  // Albedo (+AO in alpha) and normal maps for an (R+1)^2 grid of texels at spacing st starting at (x0,z0). Hp holds the
  // heights with pad extra texels on every side. Shared by the core bake and the streamed outer tiles, so both look the
  // same. AO radii are fixed in metres (the core's 2 and 10 texels), so coarser tiles shade like the core. Generator:
  // yields every few rows so tiles can be built a few ms per frame.
  *bakeMaps(Hp, R, pad, x0, z0, st, paint, out) {
    const W = R + 1, PW = W + 2 * pad, cs = this.size / this.coreK / this.q.bake;
    const blur = (src, r) => { // separable box blur
      const a = new Float32Array(PW * PW), b = new Float32Array(PW * PW), M = PW - 1;
      for (let j = 0; j < PW; j++) { let acc = 0; for (let i = -r; i <= r; i++) acc += src[j * PW + Math.min(M, Math.max(0, i))]; for (let i = 0; i < PW; i++) { a[j * PW + i] = acc / (2 * r + 1); acc += src[j * PW + Math.min(M, i + r + 1)] - src[j * PW + Math.max(0, i - r)]; } }
      for (let i = 0; i < PW; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += a[Math.min(M, Math.max(0, j)) * PW + i]; for (let j = 0; j < PW; j++) { b[j * PW + i] = acc / (2 * r + 1); acc += a[Math.min(M, j + r + 1) * PW + i] - a[Math.max(0, j - r) * PW + i]; } }
      return b;
    };
    const b1 = blur(Hp, Math.max(1, Math.round(2 * cs / st))), b2 = blur(Hp, Math.max(1, Math.round(10 * cs / st)));
    yield;
    const { alb, nor } = out, c = new THREE.Color(), n = new THREE.Vector3();
    for (let j = 0; j <= R; j++) {
      for (let i = 0; i <= R; i++) {
        const k = j * W + i, p = (j + pad) * PW + i + pad, h = Hp[p], x = x0 + i * st, z = z0 + j * st;
        n.set(Hp[p - 1] - Hp[p + 1], 2 * st, Hp[p - PW] - Hp[p + PW]).normalize();
        nor[k * 4] = (n.x * 0.5 + 0.5) * 255; nor[k * 4 + 1] = (n.y * 0.5 + 0.5) * 255; nor[k * 4 + 2] = (n.z * 0.5 + 0.5) * 255;
        const slope = 1 - n.y;
        this.baseColor(x, z, h, slope, c, n);
        nor[k * 4 + 3] = this.cover.lastFarm * 255; // farmland: the shader draws the field parcels there
        if (paint && h > this.waterLevel + 0.5 && slope < 0.25) paint(x, z, c);
        // ambient occlusion from local concavity
        const ao = clamp(1 - Math.max(0, b1[p] - h) * 0.04 - Math.max(0, b2[p] - h) * 0.006, 0.35, 1);
        alb[k * 4] = Math.min(255, c.r * 255); alb[k * 4 + 1] = Math.min(255, c.g * 255); alb[k * 4 + 2] = Math.min(255, c.b * 255); alb[k * 4 + 3] = ao * 255;
      }
      if (j % 8 === 7) yield;
    }
  }
  // The baked colours are written as-is and read back as sRGB: that darker, richer look is the game's ground palette.
  dataTex(data, w, srgb = false) {
    const t = new THREE.DataTexture(data, w, w, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
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
  // Ground colour rules shared by the baked core terrain and the streamed outer tiles.
  baseColor(x, z, h, slope, c, nrm) {
    if (this.real) { this.cover.lastFarm = 0; return this.real.color(x, z, c); }
    if (!this.pal) {
      const L = this.loc.colors;
      this.pal = { grass: L.grass.map((v) => new THREE.Color(v)), rock: new THREE.Color(L.rock), snow: new THREE.Color(L.snow), sand: new THREE.Color(L.sand), dirt: new THREE.Color(L.dirt),
        seabed: new THREE.Color(this.loc.id === 'islands' ? 0xd8c79a : 0x4a4636), forest: new THREE.Color(this.loc.trees === 'pine' ? 0x2a4220 : 0x355a26), tmp: new THREE.Color() };
    }
    return this.cover.color(x, z, h, slope, c, nrm);
  }
  // Ground height. Once the high-res bake exists (Hh: ~21-57 m, roads/towns flattened) it is the truth: the near-camera
  // detail patch is built from exactly these triangles, so physics and placed objects match what's drawn up close.
  // Before the bake (network planning) and outside the core it falls back to the coarse mesh / streamed tiles.
  // Roads: inside a road's footprint the ground is the road's own profile (the grid is too coarse to hold an 8 m
  // road exactly), and just beside it the embankment/cutting down to the grid (roads.js draws both the same way).
  sampleGrid(x, z) {
    if (this.Hh) {
      const R = this.hR, st = this.hStep, fx = (x + this.half) / st, fz = (z + this.half) / st;
      if (fx >= 0 && fz >= 0 && fx < R && fz < R) { const h = this.triAt(this.Hh, R + 1, fx, fz), S = this.roadSurf; return S && S.q(x, z) ? S.over(h) : h; }
    }
    return this.sampleCoarse(x, z);
  }
  // triangle interpolation matching PlaneGeometry's split: (a,b,d) + (b,c,d)
  triAt(H, W, fx, fz) {
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = H[j * W + i], b = H[(j + 1) * W + i], cc = H[(j + 1) * W + i + 1], d = H[j * W + i + 1];
    if (u + v <= 1) return a + (d - a) * u + (b - a) * v;
    return cc + (b - cc) * (1 - u) + (d - cc) * (1 - v);
  }
  sampleCoarse(x, z) {
    const N = this.N, step = this.step, half = this.half;
    const fx = (x + half) / step, fz = (z + half) / step;
    if (fx < 0 || fz < 0 || fx >= N || fz >= N) return this.tiles ? this.tiles.sample(x, z) : this.height(x, z);
    return this.triAt(this.H, N + 1, fx, fz);
  }
  // ---- near-camera detail patch: the coarse core mesh is ~50-120 m triangles; around the camera draw the baked
  // grid itself (P x P cells). Its outer ring takes the coarse mesh heights so the seam is closed, and the coarse
  // mesh discards its pixels inside the patch rectangle.
  buildPatch() {
    const P = this.qName === 'ultra' ? 256 : this.qBase === 'high' ? 192 : this.qName === 'low' ? 80 : 128;
    this.patchP = P;
    const n = P + 1, pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), idx = [];
    for (let k = 0; k < n * n; k++) nor[k * 3 + 1] = 1;
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) { const a = j * n + i, b = (j + 1) * n + i, c = b + 1, d = a + 1; idx.push(a, b, d, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setIndex(idx);
    const mesh = new THREE.Mesh(g, this.patchMat); mesh.receiveShadow = true; mesh.visible = false;
    this.patch = mesh; this.group.add(mesh); this.patchAt = null;
  }
  updatePatch(cp) {
    if (!this.patch) return;
    const st = this.hStep, R = this.hR, P = this.patchP, half = this.half;
    // snap to the bake grid, keep inside the core
    let i0 = Math.round((cp.x + half) / st) - P / 2, j0 = Math.round((cp.z + half) / st) - P / 2;
    i0 = Math.max(0, Math.min(R - P, i0)); j0 = Math.max(0, Math.min(R - P, j0));
    const far = Math.abs(cp.x) > half + P * st * 0.3 || Math.abs(cp.z) > half + P * st * 0.3;
    if (far) { if (this.patch.visible) { this.patch.visible = false; this.terrainMat.userData.U.patchRect.value.set(1e9, 1e9, -1e9, -1e9); } return; }
    if (this.patchAt && Math.abs(i0 - this.patchAt[0]) < P / 6 && Math.abs(j0 - this.patchAt[1]) < P / 6) return;
    this.patchAt = [i0, j0];
    const n = P + 1, pos = this.patch.geometry.attributes.position.array, H = this.Hh, W = R + 1;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gi = i0 + i, gj = j0 + j, x = -half + gi * st, z = -half + gj * st, k = (j * n + i) * 3;
      const edge = i === 0 || j === 0 || i === P || j === P;
      pos[k] = x; pos[k + 2] = z; pos[k + 1] = edge ? this.sampleCoarse(x, z) : H[gj * W + gi];
    }
    const g = this.patch.geometry; g.attributes.position.needsUpdate = true; g.computeBoundingSphere();
    this.patch.visible = true;
    this.terrainMat.userData.U.patchRect.value.set(-half + i0 * st, -half + j0 * st, -half + (i0 + P) * st, -half + (j0 + P) * st);
  }
  heightAt(x, z) { return this.sampleGrid(x, z); }
  maxGround(x, z) {
    const S = this.roadSurf, deck = S && S.q(x, z, true) ? S.y : -Infinity; // bridge decks count
    return Math.max(this.sampleGrid(x, z), this.waterLevel, deck, this.pad ? this.pad.maxAt(x, z) : -Infinity, this.stunts ? this.stunts.topAt(x, z) : -Infinity, this.helipads ? this.helipads.topAt(x, z) : -Infinity, this.marina ? this.marina.topAt(x, z) : -Infinity) + (this.inAirportBox(x, z) ? 25 : 0); // (the launch pad, the stunt park's ramps and loop, rooftop helipads)
  }
  // the nearest front-face hit on a structure's collision mesh along o + d*t, t <= len (collide.js), or null
  surfRay(o, d, len) { let best = null; for (const cm of this.surfs) { const r = cm.ray(o, d, best ? best.t : len); if (r) best = r; } return best; }
  surfPoint(p) { for (const cm of this.surfs) { const r = cm.point(p); if (r) return r; } return null; }
  // where a vehicle of this kind starts at this place instead of the runway (null: the runway). analyze() result in.
  startSite(st) { return this.sites.find((s) => s.fits(st)) || null; }
  // where a car or bike starts (the flight setup's land choices): 'park' the stunt park's arch, 'evel' the canyon jump's
  // run-up, 'road' a street among the buildings (landStart.js); null: the runway
  landStart(start) {
    if (start === 'road') return this.roadStartAt === undefined ? (this.roadStartAt = roadStart(this)) : this.roadStartAt;
    if (start === 'park' || start === 'evel') return this.stunts?.startFor(start) || null;
    return null;
  }
  inAirportBox(x, z) { return x > 150 && x < 420 && Math.abs(z) < 260; }
  // y (optional): height of the point asking. A bridge deck is the ground for anything not well below it, so cars
  // drive over and planes can still fly under.
  groundAt(x, z, y) {
    const e = 1.5, S = this.roadSurf, pad = this.pad?.ground(x, z, y); // the launch pad's slab, trench and stand deck
    if (pad) return pad;
    if (S && S.q(x, z, true, y ?? Infinity)) return { h: S.y, n: new THREE.Vector3(-S.gx, 1, -S.gz).normalize(), type: 'runway' };
    const h = this.sampleGrid(x, z);
    if (S && S.q(x, z) && S.e <= 0) return { h, n: new THREE.Vector3(-S.gx, 1, -S.gz).normalize(), type: 'runway' }; // on a road
    if (h < this.waterLevel) return { h: this.waterLevel, n: new THREE.Vector3(0, 1, 0), type: 'water' };
    const rw = this.real?.waterAt(x, z); if (rw != null && h < rw + 0.3) return { h: rw, n: new THREE.Vector3(0, 1, 0), type: 'water' }; // real rivers above the water level
    if (this.bake && !this.bake.dry && this.landAt(x, z, this.gL || (this.gL = [0, 0, 0, 0]))[0] > 0.6) return { h, n: new THREE.Vector3(0, 1, 0), type: 'water' }; // rivers, lakes
    const hx = this.sampleGrid(x + e, z), hz = this.sampleGrid(x, z + e);
    const n = new THREE.Vector3(h - hx, e, h - hz).normalize();
    let type = 'grass';
    if (Math.abs(z) < RWY.len / 2 + 30 && RUNWAYS.some((r) => Math.abs(x - r.x) < RWY.width / 2 + 2)) type = 'runway';
    else if (this.isPaved(x, z)) type = 'runway';
    else if (n.y < 0.8) type = 'rock';
    else if (this.loc.desert) type = this.real && this.real.forest(x, z) > 0.45 ? 'grass' : 'sand'; // (pine needles under the real rims' forests)
    else if (h > this.loc.snowline + 100) type = 'snow';
    return { h: type === 'runway' ? Math.max(h, this.loc.rwyH) : h, n: type === 'runway' ? new THREE.Vector3(0, 1, 0) : n, type };
  }
  isPaved(x, z) {
    if (x > 60 && x < 100 && Math.abs(z) < RWY.len / 2) return true; // taxiway
    if (x > 20 && x < 100 && (Math.abs(z - RWY.len / 2 + 20) < 15 || Math.abs(z + RWY.len / 2 - 20) < 15 || Math.abs(z) < 15)) return true;
    if (x > 100 && x < 330 && Math.abs(z) < 200) return true; // apron
    if (x > -180 && x < -20 && (Math.abs(z - RWY.len / 2 + 20) < 11 || Math.abs(z + RWY.len / 2 - 20) < 11 || Math.abs(z) < 11)) return true; // links between the runways
    return false;
  }

  buildMinimap() {
    if (this.real) { this.minimap = this.real.minimap(this, RUNWAYS, RWY.len); return; }
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
    g.fillStyle = '#222'; for (const r of RUNWAYS) g.fillRect(s / 2 + (r.x / this.size) * s - 1.5, s / 2 - (RWY.len / this.size) * s / 2, 3, (RWY.len / this.size) * s);
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
    const pal = this.loc.waterColors || (this.loc.id === 'islands' ? { deep: 0x05324a, shallow: 0x19b5b0, sand: 0xe9dcb0 } : this.loc.desert ? { deep: 0x163c38, shallow: 0x3d7a68, sand: 0x9a7a52 } : { deep: 0x0b2a35, shallow: 0x2f6f6a, sand: 0x6b6a55 });
    // where the water is drawn at all, shallows and foam: the fine baked grid, which the ground near the camera is drawn
    // from and physics uses (the coarse core mesh further out is covered by the water shader's depth lift)
    const fine = { tex: this.heightTex(this.Hh, this.hR + 1), grid: new THREE.Vector4(-this.half, -this.half, 1 / this.hStep, this.hR) };
    const mat = waterMaterial({ fine, normal: nt, level: this.waterLevel, ...pal, foam: this.loc.id === 'islands' ? 1 : 0.6, reef: this.loc.waterReef ?? (this.loc.id === 'islands' ? 1 : 0) }); // waterReef: less made-up coral where the depths are real
    const w = new THREE.Mesh(new THREE.PlaneGeometry(300000, 300000), mat); // under the whole far terrain (tiles.js / farfield.js)
    w.rotation.x = -Math.PI / 2; w.position.y = this.waterLevel;
    this.waterMat = mat;
    this.water = w; this.group.add(w);
    this.shoreWater = this.buildShoreWater(waterMaterial({ U: mat.userData.U, shore: true }));
    this.group.add(this.shoreWater);
  }

  // The water along the core's shores as a mesh whose edge IS the shoreline: every grid cell that is partly under water,
  // cut along the water level through the very triangles the ground is drawn with (the fine grid: detail patch and
  // physics), so water and land meet exactly, with no per-pixel test and antialiased like any other edge. A ring of
  // fully wet cells around those overlaps the plane, which draws only fully wet cells in the core (no cracks between).
  buildShoreWater(mat) {
    const R = this.hR, W = R + 1, H = this.Hh, wl = this.waterLevel, st = this.hStep, o = -this.half;
    const wetN = new Uint8Array(R * R); // wet corners per cell
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) { const k = j * W + i; wetN[j * R + i] = (H[k] < wl) + (H[k + 1] < wl) + (H[k + W] < wl) + (H[k + W + 1] < wl); }
    const draw = new Uint8Array(R * R);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const n = wetN[j * R + i]; if (n === 0 || n === 4) continue;
      for (let b = Math.max(0, j - 1); b <= Math.min(R - 1, j + 1); b++) for (let a = Math.max(0, i - 1); a <= Math.min(R - 1, i + 1); a++) if (wetN[b * R + a]) draw[b * R + a] = 1;
    }
    const pos = [], idx = [], ids = new Map();
    // vertices are shared by key (grid vertex, or the crossing on a grid edge), so neighbouring cells meet watertight
    const grid = (g) => { let v = ids.get(g); if (v === undefined) { v = pos.length / 3; ids.set(g, v); pos.push(o + (g % W) * st, wl, o + Math.floor(g / W) * st); } return v; };
    const cross = (g0, g1) => {
      const a = Math.min(g0, g1), b = Math.max(g0, g1), key = -1 - (a * 4 + (b - a === 1 ? 0 : b - a === W ? 1 : 2));
      let v = ids.get(key); if (v !== undefined) return v;
      const t = (H[a] - wl) / (H[a] - H[b]); v = pos.length / 3; ids.set(key, v);
      pos.push(o + ((a % W) + ((b % W) - (a % W)) * t) * st, wl, o + (Math.floor(a / W) + (Math.floor(b / W) - Math.floor(a / W)) * t) * st);
      return v;
    };
    const poly = [];
    const tri = (p, q, r) => { // the part of triangle p,q,r under water, as a fan
      poly.length = 0;
      for (const [g, h] of [[p, q], [q, r], [r, p]]) {
        if (H[g] < wl) poly.push(grid(g));
        if ((H[g] < wl) !== (H[h] < wl)) poly.push(cross(g, h));
      }
      for (let k = 1; k + 1 < poly.length; k++) idx.push(poly[0], poly[k], poly[k + 1]);
    };
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (!draw[j * R + i]) continue;
      const a = j * W + i, b = a + W, c = b + 1, d = a + 1; // same split as the ground: (a,b,d) + (b,c,d)
      tri(a, b, d); tri(b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeBoundingSphere();
    return new THREE.Mesh(g, mat);
  }

  // ---------------- sky / light ----------------
  buildSky() {
    // physically based sky: atmosphere LUT shared by the dome, the reflection map and the aerial-perspective fog
    this.atmo = new Atmosphere(this.renderer);
    FOG.skyLUT.value = this.atmo.texture;
    this.scene.fog = new THREE.FogExp2(0xbfd1e5, 0.00005);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), skyMaterial(this.atmo.texture, { fog: { glsl: FOG_GLSL, uniforms: FOG, color: this.scene.fog.color } }));
    sky.frustumCulled = false; sky.renderOrder = -10;
    this.sky = sky; this.scene.add(sky);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = this.q.shadows;
    this.sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
    const sc = this.sun.shadow.camera; sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.near = 1; sc.far = 1500;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    // Ultra: the sun's map becomes the near cascade; three more (added right after it, so they sort in order) reach out
    if (this.q.cascades && this.q.shadows) {
      this.cascades = new CascadedShadows(this.scene, this.sun, { sizes: [this.q.shadowSize, 2048, 2048, 2048] });
      // the core terrain casts too, so houses and trees in a mountain's shadow are shaded like the ground around them.
      // Back faces only: a heightfield then never shadows its own sunlit slopes (no acne at any cascade's texel size).
      for (const m of [this.terrain, this.patch]) if (m) { m.castShadow = true; m.material.shadowSide = THREE.BackSide; }
    }
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x5a5040, 0.8); this.scene.add(this.hemi);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(this.atmo.texture, { env: true })); this.envScene.add(this.envSky);
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(45, 16), new THREE.MeshBasicMaterial({ color: 0x40453a })); this.envGround.rotation.x = -Math.PI / 2; this.envGround.position.y = -2; this.envScene.add(this.envGround);
    loadMoonTexture(); // the moon is drawn by the sky dome (src/moon.js)
    // overcast deck: a lumpy ceiling from below, a sunlit cloud sea from above
    const dm = deckMaterial(cloudNoiseTexture());
    this.deck = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), dm); this.deck.rotation.x = -Math.PI / 2; this.deck.position.y = this.loc.cloudBase + 200; this.deck.renderOrder = 1; this.scene.add(this.deck);
    this.deck2 = this.deck.clone(); this.deck2.material = deckMaterial(cloudNoiseTexture()); this.deck2.material.uniforms.upper.value = 1; this.deck2.position.y = this.deck.position.y + 250; this.scene.add(this.deck2);
  }

  setTime(t) {
    this.time = ((t % 24) + 24) % 24;
    const sun = this.skyPath(this.time);
    this.sunDir = sun.dir; this.sunElev = sun.el;
    // the moon: today's real phase, trailing the sun along the same path (src/moon.js)
    this.moonAge ??= moonAge();
    const moon = this.skyPath(this.time - moonLagHours(this.moonAge));
    this.moonDir = moon.dir; this.moonElev = moon.el; this.moonPh = moonPhase(this.moonAge);
    this.applyLighting();
  }
  setMoonAge(age) { this.moonAge = age; this.setTime(this.time); }
  // Direction to a body on the sun's daily path at a given hour (and its elevation, rad)
  skyPath(hour) {
    const time = ((hour % 24) + 24) % 24;
    const dayFrac = (time - 6) / 12; // 0 at 6:00, 1 at 18:00
    const elev = Math.sin(dayFrac * Math.PI) * (dayFrac >= 0 && dayFrac <= 1 ? 62 : 25) * (dayFrac < 0 || dayFrac > 1 ? 1 : 1);
    const el = THREE.MathUtils.degToRad(dayFrac >= 0 && dayFrac <= 1 ? elev : -Math.abs(Math.sin(dayFrac * Math.PI)) * 30);
    const az = THREE.MathUtils.degToRad(90 + dayFrac * 180 - 25);
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    if (this.loc.sunLat != null) { // a real place's sun path (equinox): due east at 6:00, true south at noon, due west at 18:00
      const h = (time - 12) * Math.PI / 12, phi = THREE.MathUtils.degToRad(this.loc.sunLat), ce = Math.cos(el);
      const b = Math.PI + Math.atan2(Math.sin(h), Math.sin(phi) * Math.cos(h)) - THREE.MathUtils.degToRad(this.loc.north || 0); // bearing in the game frame
      dir.set(ce * Math.sin(b), Math.sin(el), -ce * Math.cos(b));
    } else if (this.loc.north) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(this.loc.north)); // the world is turned: keep the sun in the true south
    return { dir, el };
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
    const W = this.W, el = this.sunElev, dark = W.dark;
    const day = smoothstep(-0.12, 0.25, el); // 0 night, 1 day
    const golden = smoothstep(0.45, 0.02, el) * smoothstep(-0.15, 0.02, el);
    this.night = day < 0.25;
    this.scene.userData.nightK = clamp(1 - day + dark * 0.6, 0, 1); // running lights (navLights.js): full glow after dark or in murk
    // the atmosphere decides the sky, the horizon haze and the colour of the sunlight
    const atmoKey = `${this.sunDir.x.toFixed(4)},${this.sunDir.y.toFixed(4)},${this.sunDir.z.toFixed(4)},${W.haze ?? 1}`;
    if (atmoKey !== this.atmoKey) { this.atmoKey = atmoKey; this.atmo.update(this.sunDir, W.haze ?? 1); } // GPU bake + readback: only when it changes
    const trans = Atmosphere.sunTransmittance(this.sunDir, W.haze ?? 1);
    const tm = Math.max(trans.r, trans.g, trans.b, 1e-4);
    const sunCol = new THREE.Color(trans.r / tm, trans.g / tm, trans.b / tm).lerp(new THREE.Color(1, 0.97, 0.92).lerp(new THREE.Color(1, 0.62, 0.32), golden), 0.45);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.2 * day * (1 - dark * 0.85);
    // the moon: how high, how full, and the light it gives (0 new or set, 1 a high full moon)
    const mPh = this.moonPh, mUp = smoothstep(-0.02, 0.12, this.moonElev), moonK = mPh.bright * mUp * (1 - dark) * (1 - 0.75 * (W.cover || 0));
    this.moonLight = moonK;
    if (el < 0) { // night: moonlight (cool and dim, by phase), or just starlight
      this.sun.color.set(0x9fb6e6); this.sun.intensity = (0.1 + 1.3 * moonK) * (1 - dark);
    }
    const lightDir = el >= 0 ? this.sunDir : mUp > 0 ? new THREE.Vector3(this.moonDir.x, Math.max(this.moonDir.y, 0.22), this.moonDir.z).normalize() : new THREE.Vector3(0.25, 1, 0.15).normalize();
    this.lightDir = lightDir;
    const grey = (k) => new THREE.Color(0x808890).multiplyScalar(k);
    const skyC = new THREE.Color(0x9ec4ff).lerp(new THREE.Color(0xffb27a), golden * 0.5).lerp(new THREE.Color(0x0a1020), 1 - day).lerp(grey(0.3 + day * 0.7), dark * 0.85);
    this.hemi.color.copy(skyC); this.hemi.groundColor.set(0x4a4436).multiplyScalar(0.3 + day * 0.7);
    this.hemi.intensity = 0.25 + day * 0.9 + (el < 0 ? 0.08 + 0.4 * moonK : 0);
    // fog / horizon: the sky's own horizon colour, greyed by cloud cover
    const hz = this.atmo.horizon.clone(), zen = this.atmo.zenith.clone();
    const hzMax = Math.max(hz.r, hz.g, hz.b);
    if (hzMax > 0.95) hz.multiplyScalar(0.95 / hzMax); // the low sun's glow stays in the sky, not in the flat fog colour
    const fogC = hz.clone().lerp(new THREE.Color(0x9aa1aa).multiplyScalar(0.25 + 0.75 * day), dark * 0.9);
    if (this.loc.desert) fogC.lerp(new THREE.Color(0xe8c9a6).multiplyScalar(0.2 + 0.8 * day), 0.2 * day);
    // a moonlit night: the faint blue of the moonlit sky (the dome adds the same), so far hills fade into it, not black
    const moonSky = new THREE.Color(0.006, 0.011, 0.024).multiplyScalar(moonK * (1 - day) * 1.0);
    fogC.add(moonSky.clone().multiplyScalar(1.3));
    this.scene.fog.color.copy(fogC); this.fogBase = W.fog * (this.weatherId === 'clear' ? 1.0 : 1.5) * (this.q.res < 200 ? 1.3 : 1);
    this.scene.fog.density = W.fog;
    FOG.fogLin.value = this.fogBase;
    FOG.fogBase.value = this.loc.fogBase ?? (this.loc.id === 'alpine' ? this.loc.rwyH - 40 : this.waterLevel);
    FOG.fogFalloff.value = this.weatherId === 'fog' ? 1 / 220 : W.cover ? 1 / 1400 : 1 / 750;
    FOG.fogSunDir.value.copy(this.sunDir);
    FOG.fogSunColor.value.copy(sunCol).multiplyScalar((0.25 + golden * 0.9) * day * (1 - dark * 0.9));
    // aerial perspective: how much the haze takes the sky's colour, and how much bluer it scatters
    this.fogSkyMix = (1 - W.cover * 0.85) * (1 - smoothstep(0.2, 0.8, dark)) * (this.weatherId === 'fog' ? 0.4 : 1);
    FOG.fogSkyMix.value = this.fogSkyMix;
    const blue = (1 - dark) * day;
    FOG.fogExt.value.set(1 - 0.28 * blue, 1 - 0.06 * blue, 1 + 0.32 * blue);
    if (this.waterMat) {
      const U = this.waterMat.userData.U;
      U.sunDir.value.copy(lightDir); U.sunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity / 3.2);
      U.skyZen.value.copy(zen).multiplyScalar(1.3).lerp(skyC.clone().multiplyScalar(0.55 + 0.45 * day), 0.35 + dark * 0.6); U.skyHor.value.copy(fogC).lerp(new THREE.Color(1, 0.75, 0.5), golden * 0.3);
      U.amb.value = 0.25 + 0.75 * day; U.rough.value = W.turb * 0.5;
    }
    for (const m of [this.terrainMat, this.patchMat]) if (m) m.userData.U.shadowOn.value = 1 - dark * 0.8;
    this.fogColor = fogC.clone();
    this.skyDarken = dark;
    // sky dome: sun disc, stars, cirrus
    const disc = Atmosphere.sunTransmittance(this.sunDir, W.haze ?? 1).multiplyScalar(60 * (1 - dark) * smoothstep(-0.03, 0.0, el));
    const cirrus = this.q.cirrus === false || this.skyLite ? 0 : (W.cirrus ?? 0);
    const sunLit = sunCol.clone().multiplyScalar(1.1 * smoothstep(-0.1, 0.05, el) * (1 - dark * 0.7) + 0.03);
    const cirrusAmb = zen.clone().multiplyScalar(0.7).add(hz.clone().multiplyScalar(0.35));
    for (const m of [this.sky.material, this.envSky.material]) {
      const u = m.uniforms;
      u.sunDir.value.copy(this.sunDir); u.sunDisc.value.copy(disc); u.cirrus.value = cirrus;
      u.cirrusLit.value.copy(sunLit); u.cirrusAmb.value.copy(cirrusAmb);
      u.stars.value = (1 - smoothstep(-0.25, 0.02, el)) * (1 - dark) * (1 - 0.45 * moonK); // a bright moon washes out the faint stars
    }
    // the moon's disc and glow (src/moon.js): lit from the sun's side by its phase, reddened low down like the sun
    {
      const md = this.moonDir, sd = this.sunDir, i = Math.PI - mPh.E; // phase angle
      const perp = sd.clone().addScaledVector(md, -sd.dot(md)); if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0).addScaledVector(md, -md.y);
      MOON_U.moonDir.value.copy(md);
      MOON_U.moonLit.value.copy(md).multiplyScalar(-Math.cos(i)).addScaledVector(perp.normalize(), Math.sin(i)).normalize();
      const mt = Atmosphere.sunTransmittance(md, W.haze ?? 1), mtm = Math.max(mt.r, mt.g, mt.b, 1e-4);
      const disc = (1 - dark * 0.95) * smoothstep(-0.03, 0.0, this.moonElev) * (0.6 + 1.6 * (1 - day)); // pale by day
      MOON_U.moonCol.value.setRGB(mt.r / mtm, mt.g / mtm, mt.b / mtm).lerp(new THREE.Color(1, 0.97, 0.92), 0.5).multiplyScalar(disc * Math.min(1, mtm * 1.5));
      MOON_U.moonGlow.value.copy(MOON_U.moonCol.value).multiplyScalar(0.05 * (1 - day) * mPh.frac * (0.6 + 0.4 * (W.haze ?? 1)));
      MOON_U.moonSky.value.copy(moonSky);
    }
    // reflections under an overcast sky see the grey cloud base, not the blue sky above it
    this.envSky.material.uniforms.grey.value = W.cover * 0.9; this.envSky.material.uniforms.greyCol.value.copy(fogC).multiplyScalar(1.1);
    this.sky.material.uniforms.greyCol.value.copy(fogC); this.sky.material.uniforms.grey.value = this.weatherId === 'fog' ? 0.6 : 0;
    // overcast deck
    const deckOp = W.cover;
    for (const [d, k] of [[this.deck, 1], [this.deck2, 0.9]]) {
      const u = d.material.uniforms;
      u.opacity.value = deckOp * k;
      u.below.value.copy(fogC).lerp(new THREE.Color(0xb5bbc2).multiplyScalar(0.15 + day * 0.85), 0.5).multiplyScalar(0.72 * (1 - dark * 0.5));
      u.lit.value.copy(sunLit); u.amb.value.copy(cirrusAmb).multiplyScalar(0.8); u.sunDir.value.copy(this.sunDir);
      d.visible = deckOp > 0.01;
    }
    this.overcastColor = fogC.clone();
    // cloud lighting
    if (this.clouds) {
      const cu = this.clouds.uniforms;
      const moon = el < 0;
      const lit = (moon ? new THREE.Color(0x8aa4d6).multiplyScalar((0.015 + 0.3 * moonK) * (1 - dark)) : sunCol.clone().multiplyScalar(1.15 * day * (1 - dark * 0.75)));
      cu.sunDir.value.copy(lightDir); cu.sunCol.value.copy(lit);
      const top = zen.clone().multiplyScalar(1.15).add(hz.clone().multiplyScalar(0.3)).lerp(grey(0.55 * (0.2 + 0.8 * day)), dark * 0.8);
      top.add(moonSky.clone().multiplyScalar(8)); // under a bright moon the clouds glow grey against the deep blue, not black
      cu.ambTop.value.copy(top);
      cu.ambBottom.value.copy(this.hemi.groundColor).multiplyScalar(0.5).add(hz.clone().multiplyScalar(0.3)).lerp(grey(0.35 * (0.2 + 0.8 * day)), dark * 0.7).add(moonSky.clone().multiplyScalar(6));
      cu.litColor.value.copy(lit).multiplyScalar(0.85).add(top); cu.shadeColor.value.copy(top).multiplyScalar(0.9);
      if (!this.cloudLitDir || this.cloudLitDir.distanceTo(lightDir) > 0.001) { this.cloudLitDir = lightDir.clone(); this.clouds.light(lightDir); }
    }
    if (!this.lastBakeDir || this.lastBakeDir.distanceTo(lightDir) > 0.01) { this.lastBakeDir = lightDir.clone(); this.bakeShadows(); }
    // night lights
    if (this.lightsMat) this.lightsMat.opacity = this.night || dark > 0.55 ? 1 : 0;
    if (this.roadGroup) this.roadGroup.userData.lampMat.opacity = this.night || dark > 0.6 ? 1 : 0;
    if (this.windowMats) for (const m of this.windowMats) m.emissiveIntensity = this.night ? 3.5 : 0;
    this.space?.onLighting();
    this.envDirty = true;
  }
  updateEnv() {
    if (!this.envDirty) return;
    this.envDirty = false;
    this.envGround.material.color.copy(this.hemi.groundColor).multiplyScalar(0.6);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 200);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.25 + 0.75 * smoothstep(-0.12, 0.25, this.sunElev);
  }

  // ---------------- runway & airport ----------------
  // one runway: painted asphalt texture (numbers at both ends) on a flat strip at x = r.x
  buildRunwayStrip(r) {
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
    g.save(); g.translate(w / 2, h - 60 * ppm); g.scale(1, 1.6); g.fillText(r.name, 0, 0); g.restore();
    g.save(); g.translate(w / 2, 60 * ppm); g.rotate(Math.PI); g.scale(1, 1.6); g.fillText(r.back, 0, 0); g.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(RWY.width, RWY.len), new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(r.x, this.loc.rwyH + 0.05, 0); mesh.receiveShadow = true; this.group.add(mesh);
  }

  buildRunway() {
    // a turned world (real places) names its runways by their real heading: 050 -> 05R / 23L ...
    const n = Math.round((this.loc.north || 0) / 10), nm = (k) => String(((k + 35) % 36) + 1).padStart(2, '0');
    const rwys = n ? RUNWAYS.map((r) => ({ ...r, name: nm(n) + r.name.slice(2), back: nm(n + 18) + r.back.slice(2) })) : RUNWAYS;
    for (const r of rwys) this.buildRunwayStrip(r);
    // shoulders, taxiway, apron
    const asph = new THREE.MeshStandardMaterial({ color: 0x55565a, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, map: this.detailTexture() });
    asph.map.repeat.set(20, 20);
    const add = (w2, l, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w2, l), asph); m.rotation.x = -Math.PI / 2; m.position.set(x, this.loc.rwyH + 0.03, z); m.receiveShadow = true; this.group.add(m); };
    // taxiway (centreline + edge lines), connectors with hold-short bars (to both runways), concrete apron with stand markings
    const paved = (tex, w2, l, x, z, rotZ = false) => { const geo = new THREE.PlaneGeometry(w2, l); if (rotZ) geo.rotateZ(Math.PI / 2); const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })); m.rotation.x = -Math.PI / 2; m.position.set(x, this.loc.rwyH + 0.03, z); m.receiveShadow = true; this.group.add(m); };
    paved(this.taxiTexture('taxi'), 36, RWY.len, 80, 0);
    const conn = this.taxiTexture('conn'); for (const z of [RWY.len / 2 - 20, -RWY.len / 2 + 20, 0]) { paved(conn, 22, 60, 50, z, true); add(160, 22, -100, z); }
    paved(this.apronTexture(), 232, 400, 214, 0);
    this.runways = rwys.map((r) => ({ x: r.x, z: 0, h: this.loc.rwyH, len: RWY.len, width: RWY.width, name: r.name, back: r.back, threshold: new THREE.Vector3(r.x, this.loc.rwyH, RWY.len / 2 - 60), heading: 0 }));
    this.runway = this.runways[0];
    // runway & approach lights (points shown at night)
    const lp = [], lc = [];
    const push = (x, z, c, y = 0.4) => { lp.push(x, this.loc.rwyH + y, z); const cc = new THREE.Color(c); lc.push(cc.r, cc.g, cc.b); };
    for (const { x: rx } of RUNWAYS) {
      for (let z = -RWY.len / 2; z <= RWY.len / 2; z += 60) { push(rx - RWY.width / 2 - 1, z, 0xfff0c0); push(rx + RWY.width / 2 + 1, z, 0xfff0c0); }
      for (let x = -RWY.width / 2; x <= RWY.width / 2; x += 4) { push(rx + x, RWY.len / 2 + 2, 0x30ff60); push(rx + x, -RWY.len / 2 - 2, 0xff3030); }
      for (let k = 1; k <= 12; k++) for (let x = -8; x <= 8; x += 4) push(rx + x, RWY.len / 2 + k * 30, 0xffffff, 1 + k * 0.4);
    }
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

  taxiTexture(kind) {
    const conn = kind === 'conn', c = document.createElement('canvas'); c.width = 128; c.height = conn ? 512 : 256; const g = c.getContext('2d');
    g.fillStyle = '#4c4d50'; g.fillRect(0, 0, c.width, c.height);
    const id = g.getImageData(0, 0, c.width, c.height); for (let i = 0; i < id.data.length; i += 4) { const k = (Math.random() - 0.5) * 18; id.data[i] += k; id.data[i + 1] += k; id.data[i + 2] += k; } g.putImageData(id, 0, 0);
    g.fillStyle = '#e2b52a';
    if (!conn) { g.fillRect(62, 0, 5, 256); g.fillRect(4, 0, 3, 256); g.fillRect(121, 0, 3, 256); } // centreline + edges (36 m wide)
    else { g.fillRect(62, 0, 5, 512); const y = (40 - 20) * 512 / 60; g.fillRect(0, y, 128, 4); g.fillRect(0, y + 8, 128, 4); for (let x = 0; x < 128; x += 16) { g.fillRect(x, y + 18, 9, 4); g.fillRect(x, y + 26, 9, 4); } }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapT = THREE.RepeatWrapping; if (!conn) t.repeat.set(1, RWY.len / 40);
    return t;
  }
  apronTexture() {
    const W2 = 1024, H2 = 2048, c = document.createElement('canvas'); c.width = W2; c.height = H2; const g = c.getContext('2d');
    const X = (x) => (x - 98) * W2 / 232, Z = (z) => (z + 200) * H2 / 400, S = W2 / 232; // world metres -> canvas px
    g.fillStyle = '#4e4d4b'; g.fillRect(0, 0, W2, H2);
    const id = g.getImageData(0, 0, W2, H2); for (let i = 0; i < id.data.length; i += 4) { const k = (Math.random() - 0.5) * 14; id.data[i] += k; id.data[i + 1] += k; id.data[i + 2] += k; } g.putImageData(id, 0, 0);
    // concrete slabs: some a shade lighter/darker, joints every 7.5 m
    for (let x = 98; x < 330; x += 7.5) for (let z = -200; z < 200; z += 7.5) { const v = Math.random(); if (v < 0.3) { g.fillStyle = `rgba(${v < 0.15 ? '60,58,54' : '200,198,190'},0.10)`; g.fillRect(X(x), Z(z), 7.5 * S, 7.5 * S); } }
    g.fillStyle = 'rgba(40,40,40,0.35)'; for (let x = 98; x < 330; x += 7.5) g.fillRect(X(x), 0, 1, H2); for (let z = -200; z < 200; z += 7.5) g.fillRect(0, Z(z), W2, 1);
    // oil stains
    for (let k = 0; k < 40; k++) { g.fillStyle = 'rgba(30,28,25,0.12)'; g.beginPath(); g.ellipse(X(140 + Math.random() * 120), Z(-180 + Math.random() * 360), 4 + Math.random() * 10, 3 + Math.random() * 8, 0, 0, 7); g.fill(); }
    const line = (pts, w, col) => { g.strokeStyle = col; g.lineWidth = w * S; g.lineCap = 'round'; g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.stroke(); };
    // apron taxi lane + lead-in lines to each stand (matches addParked spots)
    line([[128, -198], [128, 198]], 0.35, '#e2b52a');
    for (const [x, z] of [[200, -160], [200, -80], [190, 40], [230, 160], [200, 100], [200, -20]]) {
      g.strokeStyle = '#e2b52a'; g.lineWidth = 0.35 * S; g.beginPath(); g.moveTo(X(128), Z(z - 32)); g.quadraticCurveTo(X(128), Z(z), X(150), Z(z)); g.lineTo(X(x + 14), Z(z)); g.stroke();
      line([[x + 14, z - 5], [x + 14, z + 5]], 0.6, '#e2b52a'); // stop bar
      g.strokeStyle = '#d23a2a'; g.lineWidth = 0.25 * S; g.strokeRect(X(x - 14), Z(z - 14), 32 * S, 28 * S); // stand clearance box
      g.save(); g.translate(X(x + 20), Z(z)); g.rotate(Math.PI / 2); g.fillStyle = '#e2b52a'; g.font = `bold ${Math.round(5 * S)}px Arial`; g.textAlign = 'center'; g.fillText(String.fromCharCode(65 + Math.floor((z + 200) / 70)) + (1 + Math.round(Math.abs(z) / 40) % 9), 0, 0); g.restore();
    }
    // service road (white dashes) along the buildings and hatched no-parking zones in front of hangars
    g.setLineDash([3 * S, 3 * S]); line([[258, -198], [258, 198]], 0.25, '#e8e8e2'); line([[250, -198], [250, 198]], 0.25, '#e8e8e2'); g.setLineDash([]);
    for (const z0 of [-142, -62]) { g.strokeStyle = '#e2b52a'; g.lineWidth = 0.3 * S; g.strokeRect(X(262), Z(z0), 8 * S, 44 * S); for (let z = z0; z < z0 + 44; z += 3) line([[262, z], [270, z + 3]], 0.3, '#e2b52a'); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  buildAirport() {
    const y = this.loc.rwyH, A = new Builder(), Dt = new Builder(), F = -Math.PI / 2; // F: buildings whose front faces the apron (-x)
    // big hangars with arched roofs and sliding doors
    const hangar = (x, z, w, d, h, rise, col) => {
      A.setFrame(x, y, z, F); A.seed = 7;
      A.walls(w, d, -0.5, h, C.METAL, col, { front: C.HANGAR_DOOR, back: C.METAL });
      const seg = 10, hw = w / 2 + 0.4, hd = d / 2 + 0.4, P = (k) => { const a = Math.PI * (k / seg); return [-Math.cos(a) * hw, h + Math.sin(a) * rise]; };
      for (let k = 0; k < seg; k++) {
        const [x0, y0] = P(k), [x1, y1] = P(k + 1), L = 2 * hd / 3, a0 = k * Math.PI * hw / seg / 3, a1 = (k + 1) * Math.PI * hw / seg / 3, sx = (w / 2) / hw;
        A.quad([x0, y0, -hd], [x0, y0, hd], [x1, y1, hd], [x1, y1, -hd], [0, a0, L, a0, L, a1, 0, a1], C.SEAM, 0xd8dde2);
        const fu = [0, 0, 1, 0, 0.5, 0.5]; // arched end walls, fanned from the eave centre
        A.tri([0, h, d / 2], [x1 * sx, y1, d / 2], [x0 * sx, y0, d / 2], fu, C.METAL, col);
        A.tri([0, h, -d / 2], [x0 * sx, y0, -d / 2], [x1 * sx, y1, -d / 2], fu, C.METAL, col);
      }
      A.plainQuad([-w * 0.35, 0, d / 2 + 0.06], [w * 0.05, 0, d / 2 + 0.06], [w * 0.05, h - 1.2, d / 2 + 0.06], [-w * 0.35, h - 1.2, d / 2 + 0.06], C.CONCRETE, 0x1a1c1e); // one door slid open
      A.plainQuad([-w / 2, h - 1.1, d / 2 + 0.08], [w / 2, h - 1.1, d / 2 + 0.08], [w / 2, h - 0.2, d / 2 + 0.08], [-w / 2, h - 0.2, d / 2 + 0.08], C.PLAIN, 0x2860a8);
    };
    hangar(300, -120, 44, 60, 10, 7, 0xc4ccd2); hangar(300, -40, 44, 60, 10, 7, 0xa8bcd0);
    // row of small T-hangars
    A.setFrame(310, y, -176, F); A.walls(46, 20, -0.5, 4.6, C.METAL, 0xd8d0c0, { front: C.GARAGE }); A.gable(46, 20, 4.6, 1.2, 0.5, C.SEAM, 0x8a3a30, C.METAL, 0xd8d0c0);
    // maintenance / cargo shed behind the hangars
    A.setFrame(380, y, -80, F); A.walls(50, 30, -0.5, 8, C.METAL, 0xb8c0b0, { front: C.HANGAR_DOOR }); A.gable(50, 30, 8, 3, 0.5, C.SEAM, 0x9aa0a6, C.METAL, 0xb8c0b0);
    // terminal: two storeys of glass facing the apron, offices behind, flat roof with plant
    A.setFrame(315, y, 120, F); A.seed = 40;
    A.walls(110, 30, -0.5, 3.6, C.APT, 0xe8e4dc, { front: C.GLASS, back: C.GLASS, fl: 3.6 });
    A.walls(110, 30, 3.6, 9.4, C.APT, 0xe8e4dc, { front: C.GLASS, fl: 3.6 }); A.flat(110, 30, 8.6, 0.8, C.GRAVEL, 0xffffff, C.PLAIN, 0xe8e4dc);
    A.box(0, 8.6, -4, 60, 1.6, 10, C.CONCRETE, 0xd8d8d8); for (let k = 0; k < 4; k++) Dt.setFrame(315, y, 120, F), Dt.box(-36 + k * 24, 10.2, -4, 5, 1.6, 4, C.METAL, 0xb0b4b8);
    A.box(0, 3.4, -18, 30, 0.5, 6, C.PLAIN, 0xf4f4f0, { bottom: true }); // landside entrance canopy
    // fire station with tall hose tower
    A.setFrame(190, y, 236, Math.PI); A.seed = 90; A.walls(26, 14, -0.5, 4.5, C.BRICK_WIN, 0xffffff, { front: C.GARAGE }); A.walls(26, 14, 4.5, 7.6, C.BRICK_WIN, 0xffffff); A.flat(26, 14, 7, 0.6, C.GRAVEL, 0xffffff, C.BRICK, 0xffffff);
    A.box(10, -0.5, -4, 4, 13, 4, C.BRICK, 0xffffff, { topCell: C.SEAM, topCol: 0x777777 }); A.plainQuad([-12, 5.2, 7.05], [6, 5.2, 7.05], [6, 6.4, 7.05], [-12, 6.4, 7.05], C.PLAIN, 0xc8282e);
    // control tower: concrete shaft, office block at its foot, glass cab
    A.setFrame(255, y, 218, F); A.seed = 3;
    A.walls(16, 10, -0.5, 4, C.APT, 0xe4e0d8, { front: C.GLASS, door: C.DOOR }); A.flat(16, 10, 3.5, 0.5, C.GRAVEL, 0xffffff, C.PLAIN, 0xe4e0d8);
    A.box(0, -0.5, -1, 5, 25, 5, C.CONCRETE, 0xe8e4dc, { top: false });
    A.cyl(0, -1, 24.5, 25.6, 3.6, 5.2, 8, C.CONCRETE, 0xd8d4cc);
    A.cyl(0, -1, 25.6, 29.4, 5.2, 5.6, 8, C.GLASS, 0xffffff); A.cyl(0, -1, 29.4, 30.2, 6.2, 6.2, 8, C.CONCRETE, 0x3a3c40, { cap: true, capCell: C.CONCRETE, capCol: 0x55585c });
    Dt.setFrame(255, y, 218, F); Dt.box(1.5, 30.2, -1, 0.15, 5, 0.15, C.METAL, 0xdddddd); Dt.box(-2, 30.2, 0, 1.2, 0.8, 1.2, C.METAL, 0xcccccc);
    // fuel farm
    A.setFrame(0, y, 0, 0);
    for (let k = 0; k < 3; k++) { A.cyl(360 + k * 13, -200, -0.3, 9, 5, 5, 16, C.SEAM, 0xf2f2ee, { cap: true, capCol: 0xd8d8d4 }); A.cyl(360 + k * 13, -200, 6.5, 7.4, 5.05, 5.05, 16, C.PLAIN, 0xc8282e); }
    A.box(373, -0.5, -186, 30, 1.0, 1.0, C.CONCRETE, 0xbbbbbb);
    // landside car park
    A.plainQuad([338, 0.04, 112], [366, 0.04, 112], [366, 0.04, 52], [338, 0.04, 52], C.CONCRETE, 0x5a5a5c);
    const mat = buildingMaterial({ cellPx: { low: 128, medium: 192, ultra: 384 }[this.qName] ?? 256, interiors: this.qName !== 'low' }); // same atlas as the towns
    this.windowMats = [mat];
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), M.light(0x40ff80).clone()); this.beacon.position.set(256, y + 30.9, 216.5); this.group.add(this.beacon);
    // name board on the terminal roof, lit at night
    {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 128; const g = c.getContext('2d');
      g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 1024, 128); g.fillStyle = '#1f4f9a'; const txt = (this.loc.name || 'Skywright').toUpperCase() + ' AIRPORT'; g.font = 'bold 96px Arial'; const fs = Math.min(96, 96 * 980 / g.measureText(txt).width); g.font = `bold ${fs | 0}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 512, 68);
      const ce = document.createElement('canvas'); ce.width = 1024; ce.height = 128; const ge = ce.getContext('2d'); ge.fillStyle = '#000'; ge.fillRect(0, 0, 1024, 128); ge.font = g.font; ge.textAlign = 'center'; ge.textBaseline = 'middle'; ge.fillStyle = '#fff'; ge.fillText(txt, 512, 68);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const sm = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0x9cc8ff, emissiveMap: new THREE.CanvasTexture(ce), emissiveIntensity: 0 }); this.windowMats.push(sm);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(48, 6), sm); sign.rotation.y = -Math.PI / 2; sign.position.set(299.6, y + 13.2, 120); this.group.add(sign);
      A.setFrame(0, y, 0, 0); A.box(299.9, 10, 120, 0.4, 6.4, 48.4, C.CONCRETE, 0x55595e); for (const z of [104, 136]) A.box(300.2, 8.6, z, 0.3, 1.5, 0.3, C.METAL, 0x55595e);
    }
    // apron flood-light masts (lamps join the night lights)
    const fp = [], fc = [];
    for (const [x, z] of [[104, -196], [104, 196], [104, 0], [326, -196], [326, 30]]) {
      A.setFrame(0, y, 0, 0); A.cyl(x, z, -0.3, 20, 0.4, 0.25, 6, C.METAL, 0x9a9ea4); A.box(x, 19.9, z, 1.6, 0.6, 3, C.METAL, 0x6a6e74, { bottom: true });
      for (const dz of [-1, 0, 1]) { fp.push(x + (x < 200 ? 0.9 : -0.9), y + 19.9, z + dz); fc.push(1, 0.9, 0.7); }
    }
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3)); fg.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
    this.group.add(new THREE.Points(fg, this.lightsMat));
    const shell = new THREE.Mesh(A.toGeometry(), mat); shell.castShadow = shell.receiveShadow = true; this.group.add(shell);
    const det = new THREE.Mesh(Dt.toGeometry(), mat); det.castShadow = true; this.group.add(det);
    // windsock
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 8, 8), M.paint(0xdddddd)); pole.position.set(-45, y + 4, 600); this.group.add(pole);
    const sockG = new THREE.ConeGeometry(0.7, 4, 12, 5, true); sockG.rotateX(-Math.PI / 2); sockG.translate(0, 0, 2);
    const cols = []; const sp = sockG.attributes.position; for (let i = 0; i < sp.count; i++) { const band = Math.floor(sp.getZ(i) / 0.81) % 2; cols.push(1, band ? 1 : 0.35, band ? 1 : 0.05); }
    sockG.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.sock = new THREE.Mesh(sockG, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 })); this.sock.position.set(-45, y + 7.6, 600); this.group.add(this.sock);
  }
  // Ultra: small things cast into the nearer shadow cascades only (see cascades.js NEAR_SHADOW)
  nearShadow(o) { if (this.cascades) o.traverse((c) => c.layers.set(NEAR_SHADOW)); return o; }
  addParked(objs) { // place parked aircraft meshes on the apron stands (painted in apronTexture)
    const spots = [[200, -160, 1.2], [200, -80, 1.6], [190, 40, 1.4], [230, 160, 1.8], [200, 100, 1.5], [200, -20, 1.3]];
    const all = spots.map((s, i) => (i < objs.length ? objs[i] : objs[i % objs.length].clone()));
    spots.forEach((s, i) => { const o = all[i]; o.position.x += s[0]; o.position.y += this.loc.rwyH; o.position.z += s[1]; o.rotation.y = s[2]; this.group.add(this.nearShadow(o)); });
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
  treeHit(p) { return this.flora.hit(p) || this.towns.hit(p) || this.tiles?.treeHit(p) || this.pad?.hit(p) || this.helipads?.hit(p) || this.marina?.hit(p); }
  // Buildings within r of (x, z), as solid boxes for a car's or bike's wall contacts (aircraft.js wallContacts): every
  // building the towns, a real place or New York has, and the landmarks, each once, with its full footprint (destruct.box:
  // the oriented box, not the disc the part-centre test above uses) and its current height (lower once knocked down).
  // Towns and real places file a building under its centre's 50 m cell only, so the search reaches as far as the
  // biggest building does; New York files every box under each cell it covers.
  wallBoxes(x, z, r, out = []) {
    out.length = 0;
    const seen = this._wbSeen || (this._wbSeen = new Set()), D = this.destruct, T = this.towns;
    seen.clear();
    const add = (e) => {
      if (seen.has(e) || !(e[3] > 0.3)) return; seen.add(e);
      const b = D.box(e); if ((b.x - x) ** 2 + (b.z - z) ** 2 > (r + Math.hypot(b.hl, b.hw)) ** 2) return;
      out.push({ x: b.x, z: b.z, ux: b.ux, uz: b.uz, hl: b.hl, hw: b.hw, y0: e[1], y1: e[1] + e[3], e });
    };
    const scan = (g, reach) => {
      if (!g) return;
      const R = r + reach, i0 = Math.floor((x - R) / 50), i1 = Math.floor((x + R) / 50), j0 = Math.floor((z - R) / 50), j1 = Math.floor((z + R) / 50);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = g.get(i + ',' + j); if (a) for (const e of a) if (e.solid) add(e); }
    };
    const reach = (g) => { let m = 0; for (const a of g.values()) for (const e of a) { const b = D.box(e); m = Math.max(m, Math.hypot(b.hl, b.hw)); } return m; };
    if (T.city) scan(T.city.grid, 0);
    else if (T.grid) { if (T.wallN !== T.grid.size) { T.wallN = T.grid.size; T.wallReach = reach(T.grid); } scan(T.grid, T.wallReach); }
    for (const e of T.landmarks?.boxes || []) add(e);
    return out;
  }
  // ---------------- clouds ----------------
  buildClouds() {
    this.clouds = new CloudField(this.q.clouds >= 1 ? 3200 : 1800);
    this.scene.add(this.clouds.mesh);
  }
  layoutClouds() {
    if (!this.clouds) return;
    const W = this.W, r = mulberry32(this.loc.seed + this.weatherId.length * 13);
    const base = this.loc.cloudBase * (W.cover ? 0.75 : 1);
    this.clouds.layout(this.loc.seed + this.weatherId.length * 13, W, base, this.q.clouds * (this.cloudDetail ?? 1));
    this.cloudList = this.clouds.list;
    // thermals under the fair-weather cumulus
    this.thermals = [];
    if (!W.cover) for (const c of this.cloudList) if (r() < 0.7) this.thermals.push({ x: c.x, z: c.z, r: c.r * 0.66, top: c.base, strength: 2 + r() * 2.5, cloud: c });
    this.cloudLitDir = null;
    if (this.lightDir) { this.cloudLitDir = this.lightDir.clone(); this.clouds.light(this.lightDir); }
  }
  // Auto quality (perf level 0..3): at level 2+ thin the clouds out and drop the cirrus layer.
  // Rebuilds the cloud layout, but the governor only changes level every few seconds at most.
  setPerfLevel(level) {
    this.tiles?.far.setPerfLevel(level);
    const k = level >= 2 ? 0.6 : 1, lite = level >= 2;
    if (lite !== !!this.skyLite) { this.skyLite = lite; this.applyLighting(); }
    if ((this.cloudDetail ?? 1) === k) return;
    this.cloudDetail = k; this.layoutClouds(); if (this.cloudAnchor) this.wrapClouds(this.cloudAnchor);
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
  // clouds live in a 26 km square that wraps around the camera, so the sky never runs out
  wrapClouds(cp) {
    this.clouds.wrap(cp);
    for (const t of this.thermals || []) { t.x = t.cloud.x; t.z = t.cloud.z; }
  }
  inCloud(p) {
    let best = this.clouds ? this.clouds.inCloud(p) : 0;
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
    // endless world: stream terrain tiles (and the far terrain), keep the sea and clouds centred on the camera
    const cp = camera.position;
    this.tiles?.update(cp);
    this.updatePatch(cp);
    const snap = (v, g) => Math.round(v / g) * g;
    this.water.position.x = snap(cp.x, 2000); this.water.position.z = snap(cp.z, 2000);
    if (!this.cloudAnchor || Math.hypot(cp.x - this.cloudAnchor.x, cp.z - this.cloudAnchor.z) > 3000) { this.cloudAnchor = cp.clone(); this.wrapClouds(cp); }
    // lights follow camera
    const tgt = camera.userData.focus || camera.position;
    this.sun.target.position.copy(tgt);
    this.sun.position.copy(tgt).addScaledVector(this.lightDir, 600);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.cascades?.update(camera, this.lightDir);
    this.deck.position.x = camera.position.x - (camera.position.x % 4000); this.deck.position.z = camera.position.z - (camera.position.z % 4000);
    this.deck2.position.x = this.deck.position.x; this.deck2.position.z = this.deck.position.z;
    // cloud layers drift with the wind
    const drift = this.windBase;
    for (const d of [this.deck, this.deck2]) d.material.uniforms.off.value.addScaledVector(new THREE.Vector2(drift.x, drift.z), -dt / 9000);
    this.sky.material.uniforms.cirrusOff.value.addScaledVector(new THREE.Vector2(drift.x, drift.z), -dt * 0.000012);
    this.sky.material.uniforms.uTime.value = this.t;
    // in-cloud whiteout
    const ic = this.inCloud(camera.position);
    FOG.fogLin.value = this.fogBase + ic * 0.03;
    if (ic > 0) this.scene.fog.color.copy(this.fogColor).lerp(new THREE.Color(0xd8dde3).multiplyScalar(0.3 + 0.7 * smoothstep(-0.1, 0.25, this.sunElev)), ic);
    else this.scene.fog.color.copy(this.fogColor);
    // above deck: clear fog
    const aboveDeck = W.cover && camera.position.y > this.deck2.position.y + 50;
    if (aboveDeck) FOG.fogLin.value = 0.00003;
    FOG.fogSkyMix.value = aboveDeck ? 1 : this.fogSkyMix * (1 - ic);
    this.deck.renderOrder = this.deck2.renderOrder = aboveDeck ? 3 : 1; // over the low scud when seen from above
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
    this.space.update(camera, dt);
    this.stunts?.update(dt, this, camera.position);
    this.helipads?.update(dt, this);
    this.updateEnv();
  }

  // false while textures the first frames need are still loading (the photo ground detail; the rock impostors are
  // re-captured once the rock photo is in): main.js keeps the loading screen up meanwhile (at most a few seconds)
  loaded() {
    for (const u of Object.values(this.detailU)) if (u?.value?.isTexture && !u.value.image) return false;
    return !this.flora || !this.flora.captured || !!this.flora.rockCaptured;
  }
  dispose() {
    this.cascades?.dispose(this.scene);
    this.scene.remove(this.group, this.sky, this.sun, this.sun.target, this.hemi, this.deck, this.deck2, this.clouds.mesh, this.rain, this.snow);
    this.tiles?.dispose(); this.space.dispose(); this.stunts?.dispose(); this.helipads?.dispose();
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.atmo.dispose(); this.clouds.dispose();
    this.waterMat?.userData.U.fineTex.value.dispose();
    this.scene.environment = null; this.scene.fog = null;
  }
}
