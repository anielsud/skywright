// Apron life (#227 phase 4): ground support equipment parked round the stands (pushback tugs, belt loaders, airstairs
// trucks, ground power carts, baggage tractors) and cones at the stand corners. There are no free models of these
// (see #231), so they are modelled here from boxes and wheels into the airport's merged building geometry (no draw
// calls), in the street vehicles' palette: airport white, safety yellow, dark grey running gear.
//
// Frames: every piece is built facing local +z (its front), placed with A.setFrame(x, y, z, yaw) (local +z -> world
// (sin yaw, cos yaw)). Stands (World.addParked / apronTexture): parked planes nose towards -x, in a 32 x 28 m box
// (x - 14 .. x + 18, z +- 14); the equipment stays on or just outside the box edges, so it clears any plane.
import { C } from './buildings.js';

const YEL = 0xf2b705, WHITE = 0xf2f2ee, DARK = 0x2a2c30, TYRE = 0x1c1c1e, GREY = 0x8a8e92, GLASS = 0x5a6e80;

// a wheel: an octagonal prism across local x at (x, r, z)
function wheel(A, x, z, r, w) {
  const n = 8, P = (k, s) => { const a = (k / n) * Math.PI * 2; return [x + s * w / 2, r + Math.cos(a) * r, z + Math.sin(a) * r]; };
  for (let k = 0; k < n; k++) {
    A.quad(P(k, -1), P(k + 1, -1), P(k + 1, 1), P(k, 1), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, TYRE);
    for (const s of [-1, 1]) { const c = [x + s * w / 2, r, z]; if (s > 0) A.tri(c, P(k, 1), P(k + 1, 1), [0, 0, 1, 0, 0.5, 0.5], C.PLAIN, GREY); else A.tri(c, P(k + 1, -1), P(k, -1), [0, 0, 1, 0, 0.5, 0.5], C.PLAIN, GREY); }
  }
}
const wheels4 = (A, hx, zf, zr, r, w = 0.3) => { for (const s of [-1, 1]) for (const z of [zf, zr]) wheel(A, s * hx, z, r, w); };

// pushback tug: long low body, a cab offset to one side, push bar at the front
function tug(A) {
  wheels4(A, 1.15, 1.6, -1.6, 0.45, 0.45);
  A.box(0, 0.45, 0, 2.6, 0.9, 5.2, C.PLAIN, YEL); A.box(0, 1.35, 0, 2.5, 0.12, 5.0, C.PLAIN, DARK);
  A.box(0.55, 1.35, -1.2, 1.3, 1.25, 1.6, C.PLAIN, YEL); A.box(0.55, 1.75, -0.38, 1.2, 0.75, 0.04, C.PLAIN, GLASS); // cab + windscreen
  A.box(0, 0.5, 2.75, 2.2, 0.35, 0.3, C.PLAIN, DARK); A.box(0, 0.62, 3.6, 0.18, 0.12, 1.5, C.PLAIN, GREY); // bumper, tow bar
  A.box(0.55, 2.6, -1.2, 0.18, 0.12, 0.18, C.PLAIN, 0xff8a20); // beacon
}
// belt loader: chassis with the conveyor up at an angle, a small driver's seat beside it
function beltLoader(A) {
  wheels4(A, 0.85, 1.5, -1.5, 0.32, 0.25);
  A.box(0, 0.32, 0, 1.8, 0.5, 4.4, C.PLAIN, WHITE); A.box(-0.55, 0.82, -1.3, 0.6, 0.9, 0.7, C.PLAIN, WHITE);
  const L = 7.4, a = 0.32, ca = Math.cos(a), sa = Math.sin(a), z0 = -2.6, y0 = 0.9; // conveyor: from low at the back to the hold door at the front
  const P = (x, t, h) => [x, y0 + t * sa + h, z0 + t * ca];
  for (const [x0, x1, h, col] of [[-0.55, 0.55, 0.12, DARK], [-0.65, -0.55, 0.35, YEL], [0.55, 0.65, 0.35, YEL]]) {
    A.quad(P(x0, 0, h), P(x1, 0, h), P(x1, L, h), P(x0, L, h), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, col);
    A.quad(P(x1, 0, 0), P(x0, 0, 0), P(x0, L, 0), P(x1, L, 0), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, GREY);
  }
  A.box(0, 0.8, 0.6, 0.25, 1.2, 0.25, C.PLAIN, GREY); // strut
}
// airstairs truck: a small truck with a stair flight on its back, rails both sides, a landing at the top
function stairs(A) {
  wheels4(A, 0.95, 1.9, -1.9, 0.4, 0.3);
  A.box(0, 0.4, 0, 2.1, 0.5, 5.6, C.PLAIN, WHITE); A.box(0, 0.9, 2.1, 2.0, 1.3, 1.3, C.PLAIN, WHITE); A.box(0, 1.6, 2.77, 1.8, 0.6, 0.04, C.PLAIN, GLASS); // chassis, cab
  const n = 12, rise = 2.9, run = 4.2, z0 = -2.6, y0 = 0.9;
  for (let k = 0; k < n; k++) A.box(0, y0 + (k * rise) / n, z0 + (k * run) / n, 1.2, 0.1, run / n + 0.05, C.PLAIN, GREY); // treads
  A.box(0, y0 + rise, z0 + run + 0.6, 1.4, 0.12, 1.4, C.PLAIN, GREY); // landing
  for (const s of [-1, 1]) { // stringers and handrails
    const P = (t, h) => [s * 0.7, y0 + t * rise + h, z0 + t * run];
    A.quad(P(0, -0.25), P(1, -0.25), P(1, 0.1), P(0, 0.1), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, WHITE); A.quad(P(1, -0.25), P(0, -0.25), P(0, 0.1), P(1, 0.1), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, WHITE);
    A.quad(P(0, 0.9), P(1, 0.9), P(1, 1.0), P(0, 1.0), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, YEL); A.quad(P(1, 0.9), P(0, 0.9), P(0, 1.0), P(1, 1.0), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, YEL);
    for (const t of [0, 0.5, 1]) A.box(s * 0.7, y0 + t * rise, z0 + t * run, 0.06, 1.0, 0.06, C.PLAIN, YEL);
  }
}
// ground power unit: a box on a two-wheel trailer with a cable reel
function gpu(A) {
  wheel(A, -0.7, -0.3, 0.3, 0.2); wheel(A, 0.7, -0.3, 0.3, 0.2);
  A.box(0, 0.4, 0, 1.3, 1.1, 2.0, C.PLAIN, YEL); A.box(0, 1.5, 0.2, 1.1, 0.06, 1.4, C.PLAIN, DARK);
  A.box(0, 0.55, 1.35, 0.12, 0.12, 0.9, C.PLAIN, GREY); A.cyl(0, -0.6, 1.5, 1.7, 0.35, 0.35, 8, C.PLAIN, DARK, { cap: true });
}
// baggage tractor: small open tractor with a canopy
function tractor(A) {
  wheel(A, -0.6, 0.8, 0.32, 0.25); wheel(A, 0.6, 0.8, 0.32, 0.25); wheel(A, -0.6, -0.7, 0.36, 0.3); wheel(A, 0.6, -0.7, 0.36, 0.3);
  A.box(0, 0.35, 0.1, 1.3, 0.6, 2.6, C.PLAIN, WHITE); A.box(0, 0.95, 0.8, 1.2, 0.35, 0.9, C.PLAIN, WHITE);
  for (const [x, z] of [[-0.55, -0.9], [0.55, -0.9], [-0.55, 0.3], [0.55, 0.3]]) A.box(x, 0.95, z, 0.06, 1.1, 0.06, C.PLAIN, DARK);
  A.box(0, 2.05, -0.3, 1.3, 0.06, 1.4, C.PLAIN, YEL); A.box(0, 0.95, -0.5, 0.8, 0.5, 0.5, C.PLAIN, DARK); // canopy, seat
}
function cone(A) { A.cyl(0, 0, 0, 0.05, 0.22, 0.22, 4, C.PLAIN, 0xd84a1a, { cap: true }); A.cyl(0, 0, 0.05, 0.72, 0.15, 0.03, 6, C.PLAIN, 0xf05a20); A.cyl(0, 0, 0.36, 0.46, 0.105, 0.09, 6, C.PLAIN, 0xf4f4f0); }

export const GSE = { tug, beltLoader, stairs, gpu, tractor, cone };

// Equipment round each stand. stands: [[x, z, yaw], ...] (World.addParked's spots), y: apron height. Returns the
// footprints it used ([{ x, z, hx, hz }], for tests), so nothing lands on the apron vehicles' loop (x 120 / 250, z +-150).
export function buildApronLife(A, y, stands) {
  const out = [], put = (fn, x, z, yaw, r = 3) => { A.setFrame(x, y, z, yaw); A.seed = 13; fn(A); out.push({ x, z, hx: r, hz: r }); };
  const E = Math.PI / 2, W = -Math.PI / 2;
  stands.forEach(([sx, sz], i) => {
    put(tug, sx - 19, sz, E, 3); // on the lead-in line, facing the nose, ready to push back
    put(cone, sx - 14, sz - 14, 0, 0.3); put(cone, sx - 14, sz + 14, 0, 0.3); put(cone, sx + 18, sz - 14, 0, 0.3); put(cone, sx + 18, sz + 14, 0, 0.3);
    if (i % 3 === 0) put(stairs, sx + 4, sz - 17, E, 3.2); // (alongside the box: its stairs reach towards the plane's door)
    if (i % 3 === 1 && sx + 24 < 245) put(beltLoader, sx + 21, sz + 4, W, 4); // behind the tail, its belt up towards the plane
    if (i % 2 === 0) put(gpu, sx - 8, sz + 17, 0, 1.4);
    if (i % 3 === 2) put(tractor, sx + 6, sz + 17, E, 1.6);
  });
  return out;
}
