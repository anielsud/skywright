// Flying high, up to space: everything the view needs above a few km. The sky darkens to black (the sky-view table is
// re-baked from the camera's height), stars come out in daylight, the horizon drops and curves (the sky dome draws the
// round Earth beyond the local world, textured with NASA's Blue Marble and Black Marble, at the place's real latitude and
// longitude), the cumulus and overcast become a sea of cloud seen from above, and the haze below takes the real air
// column between us and the ground. Below 5 km none of it runs: update() returns straight away and nothing is changed.
import * as THREE from 'three';
import { PLANET, PLANET_R, CLOUD_SEA_GLSL, PLANET_LIGHT_GLSL, Atmosphere, cloudNoiseTexture } from './sky.js';
import { FOG, FOG_GLSL } from './shaders.js';
import { smoothstep } from './noise.js';

// Where each place is on the globe (latitude, longitude). Real places read theirs from their geodata (meta.json);
// the made-up ones get a plausible spot: the Alps, French Polynesia, northern Arizona.
export const GEO = { alpine: [46.45, 8.1], islands: [-16.5, -151.75], canyon: [36.06, -112.14] };
export const SPACE_START = 5000; // m: below this, nothing here runs
const SUN_K = 2.2; // sunlight on the planet's imagery, matched by eye to the local terrain's brightness

// Earth imagery, loaded once per session on the first climb (~2 MB; cached offline by the service worker afterwards).
// NASA Visible Earth, public domain: Blue Marble Next Generation (land and oceans, no clouds) and Earth at Night 2012.
let earth = null;
function loadEarth() {
  if (earth) return earth;
  earth = { day: null, lights: null };
  const L = new THREE.TextureLoader();
  L.load('assets/earth/earth_day.jpg', (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
    earth.day = t;
  });
  L.load('assets/earth/earth_lights.jpg', (t) => { t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; earth.lights = t; });
  return earth;
}
const _c = new THREE.Color();
export class SpaceView {
  constructor(world) {
    this.w = world;
    const m = world.real?.meta;
    const [lat, lon] = m?.lat0 != null ? [m.lat0, m.lon0] : world.loc.lat != null ? [world.loc.lat, world.loc.lon] : GEO[world.loc.id] || [46.5, 8];
    this.lat = lat; this.lon = lon;
    // world directions -> Earth-centred axes. Game heading 0 (-z) points to compass bearing loc.north (see hud.js).
    const f = THREE.MathUtils.degToRad(lat), l = THREE.MathUtils.degToRad(lon), N = THREE.MathUtils.degToRad(world.loc.north || 0);
    const eE = [-Math.sin(l), Math.cos(l), 0], nE = [-Math.sin(f) * Math.cos(l), -Math.sin(f) * Math.sin(l), Math.cos(f)], uE = [Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)];
    const E = new THREE.Matrix3().set(eE[0], nE[0], uE[0], eE[1], nE[1], uE[1], eE[2], nE[2], uE[2]);
    const Wm = new THREE.Matrix3().set(Math.cos(N), 0, -Math.sin(N), -Math.sin(N), 0, -Math.cos(N), 0, 1, 0);
    this.toEcef = E.multiply(Wm);
    this.active = false; this.k = 0; this.base = null; this.bakeT = 0;
    // the sea of cloud over the local world, seen from above (the planet carries the same pattern on beyond it)
    const U = { noiseTex: { value: cloudNoiseTexture() }, off: PLANET.cloudOff, cov: PLANET.cloudCov, alpha: { value: 0 },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunLight: PLANET.sunLight, planetAmb: PLANET.planetAmb, fogColor: { value: new THREE.Color() }, ...FOG };
    this.sheetU = U;
    this.sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: /* glsl */`
        uniform sampler2D noiseTex; uniform vec2 off; uniform float cov; uniform float alpha; uniform vec3 sunDir; uniform vec3 sunLight; uniform vec3 planetAmb; uniform vec3 fogColor;
        varying vec3 vW;
        ${CLOUD_SEA_GLSL}
        ${PLANET_LIGHT_GLSL}
        ${FOG_GLSL}
        void main() {
          float c = cloudSea(noiseTex, vW.xz, off, cov);
          float a = c * alpha;
          if (a < 0.004) discard;
          // a little relief: thicker cloud is brighter on top, thin edges let the shade through
          vec3 col = vec3(0.8) * planetIrr(sunDir.y, sunLight, planetAmb) * (0.8 + 0.25 * c);
          col = applyHeightFog(col, vW, fogColor);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.sheet.frustumCulled = false; this.sheet.visible = false; this.sheet.renderOrder = 3;
    world.scene.add(this.sheet);
  }

  // world.applyLighting() just ran: remember what it set (restored when we come back down), then re-apply ours
  onLighting() {
    const w = this.w, u = w.sky.material.uniforms;
    this.base = { stars: u.stars.value, cirrus: u.cirrus.value, disc: u.sunDisc.value.clone(), deck: [w.deck.material.uniforms.opacity.value, w.deck2.material.uniforms.opacity.value] };
    this.lightKey = null;
  }

  update(camera, dt) {
    const w = this.w, h = camera.position.y;
    if (h < SPACE_START) { if (this.active) this.leave(); return; }
    if (!this.base) this.onLighting();
    this.active = true;
    const E = loadEarth();
    let rebake = this.pendingBake;
    if (E.day && PLANET.earthDay.value !== E.day) { PLANET.earthDay.value = E.day; rebake = true; }
    if (E.lights && PLANET.earthLights.value !== E.lights) { PLANET.earthLights.value = E.lights; rebake = true; }
    // how far into "high up" we are: the planet and the column-of-air haze fade in from 6 to 16 km
    const k = (this.k = smoothstep(6000, 16000, h));
    PLANET.space.value = E.day ? k : 0; FOG.fogSpace.value = k;
    const p = camera.position, R0 = PLANET_R;
    PLANET.planetCam.value.set(p.x / 1000, R0 + h / 1000, p.z / 1000);
    PLANET.planetC.value = (p.x * p.x + h * h + p.z * p.z) / 1e6 + 2 * R0 * h / 1000;
    PLANET.toEcef.value.copy(this.toEcef);
    const W = w.W, el = w.sunElev, sd = w.sunDir, atmo = w.atmo;
    // what the planet's surface looks like (also baked into the coarse ground map beside the sky table)
    PLANET.sunLight.value.setRGB(1.06, 1.15, 1.3).multiplyScalar(SUN_K); // top-of-atmosphere sun, matched to the local terrain by eye
    PLANET.planetAmb.value.setRGB(0.12, 0.17, 0.26);
    PLANET.cloudCov.value = W.cover ? 0.92 : (W.clouds || 0) * 0.45;
    PLANET.cloudOff.value.copy(w.deck.material.uniforms.off.value);
    // the ground map follows the camera (re-centred every 20 km), out past where the local world fades into the planet
    const gm = PLANET.gmap.value, half = FOG.fogEnd.value * 2.2 / 1000;
    if (Math.hypot(p.x / 1000 - gm.x, p.z / 1000 - gm.y) > 20 || Math.abs(gm.z - half) > 1) { gm.set(p.x / 1000, p.z / 1000, half); rebake = true; }
    // the sky from up here: re-bake the table as we climb (a GPU pass, no read-back), at most ~8 times a second, and every
    // few seconds anyway (the clouds drift)
    const altKm = 0.6 + Math.max(0, h / 1000 - 0.6) * smoothstep(SPACE_START, 11000, h);
    this.bakeT -= dt; this.sinceBake = (this.sinceBake || 0) + dt;
    if (this.bakeT <= 0 && (rebake || this.sinceBake > 3 || Math.abs(altKm - atmo.alt) > 0.03 + 0.015 * altKm)) {
      atmo.alt = altKm; atmo.rebake(); this.bakeT = 0.12; this.sinceBake = 0; rebake = false;
    }
    this.pendingBake = rebake;
    // sky dome: stars by day from ~25 km, no cirrus once we're above it, a harder and whiter sun
    const u = w.sky.material.uniforms, B = this.base;
    u.stars.value = Math.max(B.stars, 0.45 * smoothstep(22000, 45000, h));
    u.cirrus.value = B.cirrus * (1 - smoothstep(7000, 9500, h));
    const key = `${atmo.alt.toFixed(2)}|${k.toFixed(2)}|${sd.x.toFixed(3)},${sd.y.toFixed(3)}`;
    if (key !== this.lightKey) {
      this.lightKey = key;
      const dip = Math.acos(R0 / (R0 + atmo.alt)); // the horizon sinks as we climb: the sun sets later up here
      Atmosphere.sunTransmittance(sd, W.haze ?? 1, _c, atmo.alt).multiplyScalar(60 * (1 - W.dark * (1 - k)) * smoothstep(-dip - 0.03, -dip, el));
      this.disc = _c.clone();
    }
    u.sunDisc.value.copy(B.disc).lerp(this.disc, k);
    // clouds: the 3D cumulus and the overcast deck give way to a flat sea of cloud seen from above (8-14 km)
    const fade = 1 - smoothstep(8000, 14000, h);
    w.clouds.uniforms.opacity.value = fade; w.clouds.mesh.visible = fade > 0.001;
    [w.deck, w.deck2].forEach((d, i) => { d.material.uniforms.opacity.value = B.deck[i] * fade; d.visible = B.deck[i] * fade > 0.01; });
    // the sea under the world is a 300 km square: trim it to just past the far terrain, so its hazed-out corners can't show
    const ws = Math.min(1, FOG.fogEnd.value * 2.04 / 300000); w.water.scale.set(ws, ws, 1);
    const S = this.sheet, sa = smoothstep(7000, 13000, h) * (PLANET.cloudCov.value > 0.01 ? 1 : 0);
    this.sheetU.alpha.value = sa; S.visible = sa > 0.001;
    if (S.visible) {
      const r = Math.min(FOG.fogEnd.value, 200000) * 1.3;
      S.position.set(p.x, w.loc.cloudBase * (W.cover ? 0.75 : 1) + (W.cover ? 450 : 700), p.z); S.scale.set(r * 2, 1, r * 2);
      this.sheetU.sunDir.value.copy(sd); this.sheetU.fogColor.value.copy(w.scene.fog.color);
    }
  }

  // back below 5 km: put everything back exactly as the world left it
  leave() {
    const w = this.w, B = this.base;
    this.active = false; this.k = 0;
    PLANET.space.value = 0; FOG.fogSpace.value = 0;
    w.atmo.setAlt(0.6); this.sinceBake = 0;
    if (B) {
      const u = w.sky.material.uniforms; u.stars.value = B.stars; u.cirrus.value = B.cirrus; u.sunDisc.value.copy(B.disc);
      [w.deck, w.deck2].forEach((d, i) => { d.material.uniforms.opacity.value = B.deck[i]; d.visible = B.deck[i] > 0.01; });
    }
    w.clouds.uniforms.opacity.value = 1; w.clouds.mesh.visible = true;
    w.water.scale.set(1, 1, 1);
    this.sheet.visible = false;
  }

  dispose() {
    if (this.active) this.leave();
    this.w.scene.remove(this.sheet); this.sheet.geometry.dispose(); this.sheet.material.dispose();
  }
}
