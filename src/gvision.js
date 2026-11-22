// G-vision: what heavy g does to the eyes in the cockpit view. Pulling hard (eyeballs down, the blood drains from the
// head) a dark grey haze creeps in from the edges of the view (tunnel vision, a greyout); pushing over hard (eyeballs
// up, blood forced into the head) a red one does (a redout). It builds over seconds of sustained g, so a crash's or a
// landing's one-frame spike never shows, and fades over about a second when the g comes off.
//
// Never a blackout: at its worst the haze covers the whole view but it can still be seen through, and the controls
// keep working, in every mode.
//
// The g is what the seat pushes the pilot with along their own head-to-feet axis (planeDetail.js's specific force,
// the same one the crew figures sway against). Jet and rocket crews wear g-suits and tolerate more.
//
// Drawn as two page layers over the 3D view (under the HUD): a big radial ring whose clear middle shrinks by its
// transform, and a flat haze for the middle. Only opacity and transform change per frame (the compositor's job, no
// repaint), and nothing depends on post-processing, so it costs nothing on Low.
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// onset: where the haze starts; full: where it would reach its worst if held (g along the head-to-feet axis)
export const G_TOLERANCE = {
  normal: { onset: 3.5, full: 7.0 },
  gsuit: { onset: 5.0, full: 9.5 }, // (jet and space crews: a g-suit squeezes the legs and belly)
  neg: { onset: -1.5, full: -3.5 }, // (no suit helps with negative g)
};
const RISE = 2.2, FALL = 0.8; // time constants (s): seconds to build, about a second to clear
const MAX_RISE = 0.45; // per second: even a huge g takes over two seconds to haze the whole view
const TINT = { grey: [18, 18, 20], red: [120, 4, 0] };
const LOOK = { grey: { edge: 0.8, haze: 0.5 }, red: { edge: 0.7, haze: 0.42 } }; // most opaque (edges stack both: ~0.9 / 0.83)

// The level a g heads for (0-1), for a seat with g-suit or not; positive for grey, negative for red
export function gTarget(g, gsuit) {
  const T = gsuit ? G_TOLERANCE.gsuit : G_TOLERANCE.normal, N = G_TOLERANCE.neg;
  if (g > T.onset) return clamp((g - T.onset) / (T.full - T.onset), 0, 1);
  if (g < N.onset) return -clamp((g - N.onset) / (N.full - N.onset), 0, 1);
  return 0;
}

const _up = new THREE.Vector3();
const RING = 256; // (css px: a small soft gradient, scaled up by its transform; upscaling a soft gradient costs nothing)
export class GVision {
  constructor(parent) {
    this.grey = 0; this.red = 0; this.g = 1; this.shown = false;
    this.el = document.createElement('div'); this.el.className = 'gvision';
    this.layers = {};
    for (const k of ['grey', 'red']) {
      const [r, g, b] = TINT[k], c = (a) => `rgba(${r},${g},${b},${a})`;
      const ring = document.createElement('div'), haze = document.createElement('div');
      ring.className = 'gv-ring'; haze.className = 'gv-haze';
      // the ring spans 4 screen diagonals (scale 1): clear to 0.22 diagonal from the middle, fully tinted by 0.5, so
      // the corners (0.5) darken first; at scale 0.3 the clear middle is small and the ring still covers the screen
      ring.style.cssText = `width:${RING}px;height:${RING}px;margin:${-RING / 2}px 0 0 ${-RING / 2}px;background:radial-gradient(circle closest-side, ${c(0)} 11%, ${c(0.35)} 17%, ${c(1)} 25%, ${c(1)} 100%)`;
      haze.style.background = c(1);
      this.el.append(ring, haze); this.layers[k] = { ring, haze, a: -1, s: -1, h: -1 };
    }
    parent.prepend(this.el); // (under the HUD)
    this.resize(); this.onResize = () => this.resize(); addEventListener('resize', this.onResize);
    this.draw(false);
  }
  resize() { this.k = (4 * Math.hypot(innerWidth, innerHeight)) / RING; for (const k in this.layers) this.layers[k].s = -1; }
  // From the vehicle: the specific force planeDetail.js measures for its crew (world frame, in g) along the seat's up;
  // st: the seat looked from (stations.js), show: in the cockpit view
  update(dt, ac, st, show) {
    const f = ac._crewG?.f;
    let g = 1;
    if (f && st?.up) g = f.dot(_up.copy(st.up).applyQuaternion(ac.q).normalize());
    else if (f) g = f.dot(_up.set(0, 1, 0).applyQuaternion(ac.q));
    this.step(ac.dead ? 0 : dt, ac.dead ? 1 : g, st ? st.kind === 'jet' || st.kind === 'space' : false, show && !ac.dead);
  }
  // gUp: the g along the pilot's head-to-feet axis; gsuit: their tolerance
  step(dt, gUp, gsuit, show) {
    this.g = gUp;
    if (dt > 0) {
      const t = gTarget(gUp, gsuit), tg = Math.max(0, t), tr = Math.max(0, -t);
      const go = (v, to) => (to > v ? v + Math.min((to - v) * (1 - Math.exp(-dt / RISE)), MAX_RISE * dt) : v + (to - v) * (1 - Math.exp(-dt / FALL)));
      this.grey = go(this.grey, tg); this.red = go(this.red, tr);
      if (this.grey < 1e-3 && !tg) this.grey = 0;
      if (this.red < 1e-3 && !tr) this.red = 0;
    }
    this.draw(show);
  }
  draw(show) {
    this.shown = show;
    for (const k of ['grey', 'red']) {
      const L = show ? this[k] : 0, Y = this.layers[k], lk = LOOK[k];
      const a = +(lk.edge * smooth(0, 0.35, L)).toFixed(3), s = +(1 - 0.7 * smooth(0.12, 0.85, L)).toFixed(3), h = +(lk.haze * smooth(0.55, 1, L)).toFixed(3);
      if (a !== Y.a) { Y.ring.style.opacity = a; Y.ring.style.visibility = a > 0 ? 'visible' : 'hidden'; Y.a = a; }
      if (s !== Y.s) { Y.ring.style.transform = `scale(${(s * this.k).toFixed(3)})`; Y.s = s; }
      if (h !== Y.h) { Y.haze.style.opacity = h; Y.haze.style.visibility = h > 0 ? 'visible' : 'hidden'; Y.h = h; }
    }
  }
  dispose() { removeEventListener('resize', this.onResize); this.el.remove(); }
}
