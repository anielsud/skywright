// The Moon: today's real phase, where it is in the sky at the flight's hour, and how it is drawn (a textured disc with
// phase shading in the sky dome, a halo in the haze) and how much light it gives (the night's directional light).
//
// Phase: days since a known new moon (2000-01-06 18:14 UTC) modulo the synodic month, from the real date, so the game's
// moon matches the one outside the window. Position: the Moon follows the Sun's daily path, lagging it by its
// elongation (360° over a synodic month, i.e. about 48 minutes a day): a full moon rises at sunset and is high at
// midnight, a first-quarter moon is high at sunset, a waning crescent rises before dawn. (The Moon's own declination is
// ignored, as the game's sun ignores the seasons.)
import * as THREE from 'three';

export const SYNODIC = 29.530588853; // days
const NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
// age in days (0 new, ~7.4 first quarter, ~14.8 full, ~22.1 last quarter) on a date
export function moonAge(date = new Date()) {
  const d = date.getTime() / 86400000 - NEW_MOON_2000;
  return ((d % SYNODIC) + SYNODIC) % SYNODIC;
}
// phase facts for an age: elongation from the sun (rad), illuminated fraction, and the brightness of moonlight
// relative to a full moon (very non-linear: a half moon gives much less than half the light; kept gentler than reality
// so a quarter moon still shows the land a little)
export function moonPhase(age) {
  const E = (age / SYNODIC) * Math.PI * 2, frac = (1 - Math.cos(E)) / 2;
  return { E, frac, bright: Math.pow(frac, 2.2), age };
}
// how many hours the moon trails the sun on its daily path
export const moonLagHours = (age) => (age / SYNODIC) * 24;
export function phaseName(age) {
  const n = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return n[Math.floor(((age / SYNODIC) * 8 + 0.5)) % 8];
}

// Near side of the Moon, face-on (assets/moon/moon_256.jpg, baked from NASA's LRO colour map; see README Credits).
// A flat grey stand-in until it arrives.
const _grey = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255]), 1, 1); _grey.needsUpdate = true;
export const MOON_U = {
  moonDir: { value: new THREE.Vector3(0, -1, 0) }, moonLit: { value: new THREE.Vector3(0, 1, 0) }, moonCol: { value: new THREE.Color(0, 0, 0) },
  moonGlow: { value: new THREE.Color(0, 0, 0) }, moonSky: { value: new THREE.Color(0, 0, 0) }, moonR: { value: 0.019 }, moonTex: { value: _grey },
};
let _loading = false;
export function loadMoonTexture() {
  if (_loading) return; _loading = true;
  new THREE.TextureLoader().load('assets/moon/moon_256.jpg', (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; MOON_U.moonTex.value = t; }, undefined, () => {});
}

// Sky-dome chunk (src/sky.js): the disc (texture, phase terminator, a hint of earthshine on the dark side) and a soft
// glow around it. Needs the sky dome's `space` uniform declared first. Sets moonMask (1 on the disc) for the stars.
export const MOON_GLSL = /* glsl */`
  uniform vec3 moonDir; uniform vec3 moonLit; uniform vec3 moonCol; uniform vec3 moonGlow; uniform vec3 moonSky; uniform float moonR; uniform sampler2D moonTex;
  float moonMask = 0.0;
  vec3 moonDisc(vec3 d) {
    float cm = dot(d, moonDir);
    if (cm < 0.9) return vec3(0.0);
    vec3 rt = normalize(cross(moonDir, abs(moonDir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0))), up = cross(rt, moonDir);
    vec2 q = vec2(dot(d, rt), dot(d, up)) / moonR;
    float ang = acos(clamp(cm, -1.0, 1.0)) / moonR; // in moon radii
    float r = length(q), aa = max(fwidth(r), 0.002);
    float m = smoothstep(1.0, 1.0 - aa * 1.5, r);
    // aureole: a little glow in the air around a bright moon (more in haze)
    vec3 c = moonGlow * (exp(-max(ang - 1.0, 0.0) * 1.2) * 0.12 + exp(-ang * 0.2) * 0.3 + exp(-ang * 0.05) * 0.07) * (1.0 - m) * smoothstep(0.9, 0.98, cm) * (1.0 - space); // (no air, no halo: space.js)
    if (m > 0.0) {
      moonMask = m;
      vec3 n = q.x * rt + q.y * up - sqrt(max(0.0, 1.0 - r * r)) * moonDir;
      float mu0 = dot(n, moonLit), mu = sqrt(max(0.0, 1.0 - r * r));
      float lit = smoothstep(-0.02, 0.05, mu0) * clamp(2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 1e-3), 0.0, 1.25); // Lommel-Seeliger: a full moon is flat, not a ball
      float alb = texture2D(moonTex, q * 0.5 + 0.5).g;
      c += moonCol * m * (alb * (lit * 1.6 + 0.006) + 0.0015);
    }
    return c;
  }`;
