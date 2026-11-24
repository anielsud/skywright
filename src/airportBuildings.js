// The airport's terminal, control tower and radar (#227 phase 3). Everything solid goes into World.buildAirport's
// Builder (the towns' building atlas: glass, concrete, metal, windows lit at night), so it costs no draw calls. The
// radar's antenna turns, so it is its own small mesh with the same material. Signs (gate numbers, departures /
// arrivals) are handed to airportKit.js, which draws every airport sign in one mesh.
//
// Airport coordinates (see airportKit.js): the apron is x 100..330, the terminal stands on its east edge, its airside
// face towards -x. Builder frames: setFrame(x, y, z, yaw) maps local +z to world (sin yaw, cos yaw).
import * as THREE from 'three';
import { Builder, C } from './buildings.js';

// the terminal, proportioned from a photo of a real regional terminal's airside face (Tuticorin's new terminal,
// Wikimedia Commons; signage after Kristiansand Kjevik): a recessed glazed ground floor behind white columns, a white
// floor band, a continuous tinted curtain wall with mullions and transoms, a thin white roof slab cantilevered past the
// glass with the name on its fascia, and solid white gate cores standing out every 38 m, each with a parked jet bridge.
export const TERMINAL = { x: 315, z: 120, len: 120, depth: 34, gf: 4.6, band: 1.2, cw: 7.6, slab: 1.6, over: 3, cant: 6, cores: [-38, 0, 38] };
export const TOWER = { x: 256, z: 218, shaft: 26, cab: 3.7 };
export const RADAR = { x: 430, z: -140, h: 12 };
const F = -Math.PI / 2; // frame yaw for buildings facing the apron (local +z = world -x)

// A: the airport's Builder, y: runway height. Returns { signs: [...] for buildAirfieldKit, radar: Mesh (needs the
// building material: World sets it), beacon: Vector3 (the tower's rotating beacon), boards: { nameBoard: { x, y, z } } }.
export function buildTerminalArea(A, y) {
  const T = TERMINAL, hw = T.len / 2, hd = T.depth / 2, signs = [];
  const yB = T.gf, yC = T.gf + T.band, yS = yC + T.cw, yR = yS + T.slab; // band, curtain wall, slab bottom / roof
  const ALU = 0x30363a, WHITE = 0xf2f1ec, GLASS = 0x3f7c84, GF_GLASS = 0x3a565c, rec = 3; // mullions, cladding, tinted glass, ground floor recess

  // ---- terminal ----
  A.setFrame(T.x, y, T.z, F); A.seed = 40;
  // curtain wall with mullions and transoms, on one face: z (local) = zf, facing sgn (+1 airside, -1 landside)
  const curtain = (zf, sgn, y0, y1, x0 = -hw, x1 = hw, step = 1.5, rows = [y0 + 2.5, y0 + 5.0], tint = GLASS) => {
    const [ax, bx] = sgn > 0 ? [x0, x1] : [x1, x0];
    A.wall(ax, zf, bx, zf, y0, y1, C.GLASS, tint, step, (y1 - y0) / 3);
    const n = Math.round((x1 - x0) / step);
    for (let k = 0; k <= n; k++) A.box(x0 + ((x1 - x0) * k) / n, y0, zf + sgn * 0.07, 0.09, y1 - y0, 0.14, C.PLAIN, ALU);
    for (const ty of [y0, ...rows, y1 - 0.1]) A.box((x0 + x1) / 2, ty, zf + sgn * 0.08, x1 - x0, 0.1, 0.16, C.PLAIN, ALU);
  };
  // airside: recessed glazed ground floor, the soffit over it, white columns on the facade line
  curtain(hd - rec, 1, 0, yB, -hw, hw, 1.8, [2.6], GF_GLASS);
  A.quad([-hw, yB, hd], [hw, yB, hd], [hw, yB, hd - rec], [-hw, yB, hd - rec], [0, 0, 40, 0, 40, 1, 0, 1], C.PLAIN, 0xe4e2dc); // soffit (faces down)
  for (let x = -hw + 5.5; x <= hw - 5.5; x += 11) if (!T.cores.some((c) => Math.abs(x - c) < 7)) A.cyl(x, hd - 0.6, -0.3, yB, 0.34, 0.34, 10, C.PLAIN, WHITE);
  A.box(0, yB, hd - 0.35, T.len, T.band, 0.7, C.PLAIN, WHITE, { bottom: true }); // floor band
  curtain(hd, 1, yC, yS);
  // landside: glazed both floors, the band between
  curtain(-hd, -1, 0, yB, -hw, hw, 1.8, [2.6], GF_GLASS); A.box(0, yB, -hd + 0.35, T.len, T.band, 0.7, C.PLAIN, WHITE, { bottom: true }); curtain(-hd, -1, yC, yS);
  // end walls: white cladding panels with joints, a glazed strip at the airside corner
  for (const s of [-1, 1]) {
    const x = s * hw, [za, zb] = s > 0 ? [hd, -hd] : [-hd, hd];
    A.wall(x, za, x, zb, -0.3, yS, C.PLAIN, WHITE, 3, 3);
    for (let z = -hd + 3; z < hd; z += 3) A.box(x + s * 0.03, -0.3, z, 0.06, yS + 0.3, 0.05, C.PLAIN, 0xc8c8c4);
    for (const yy of [yB, yC]) A.box(x + s * 0.03, yy, 0, 0.06, 0.05, T.depth, C.PLAIN, 0xc8c8c4);
    A.cyl(x + s * 0.25, hd - 1.2, -0.3, yS, 0.1, 0.1, 6, C.PLAIN, 0xb8bcc0); A.cyl(x + s * 0.25, -hd + 1.2, -0.3, yS, 0.1, 0.1, 6, C.PLAIN, 0xb8bcc0); // downpipes
  }
  // roof slab: cantilevered past the glass (most at the ends), white fascia, gravel roof behind a parapet
  const sw = T.len + 2 * T.cant, sd = T.depth + 2 * T.over;
  A.box(0, yS, 0, sw, T.slab, sd, C.PLAIN, WHITE, { top: false, bottom: true });
  A.flat(sw, sd, yR, 0.6, C.GRAVEL, 0xffffff, C.PLAIN, WHITE);
  A.box(0, yS - 0.02, hd + T.over / 2, sw - 0.4, 0.04, T.over - 0.4, C.PLAIN, 0xd8d6d0, { top: false, bottom: true }); // soffit panel line
  // rooftop: air handling units with louvres, ducts, skylight strips, a maintenance railing along the airside
  for (const [x, z] of [[-34, -6], [-10, -8], [22, -6], [44, -9]]) {
    A.box(x, yR, z, 7, 2.2, 3.2, C.METAL, 0xb8bcc0, { topCell: C.SEAM, topCol: 0x9aa0a6 });
    for (let k = 0; k < 3; k++) A.cyl(x - 2.2 + k * 2.2, z, yR + 2.2, yR + 2.6, 0.6, 0.6, 10, C.PLAIN, 0x8a8e92, { cap: true }); // fans
    A.box(x, yR + 0.6, z + 1.6 + 2.5, 0.8, 0.8, 5, C.METAL, 0xa8acb0); // duct
  }
  for (const x of [-48, -24, 0, 24, 48]) A.box(x, yR, 6, 14, 0.7, 2.4, C.GLASS, 0xa8d0d8, { topCell: C.GLASS, topCol: 0xa8d0d8 }); // skylights
  for (let x = -sw / 2 + 1; x <= sw / 2 - 1; x += 3) A.box(x, yR + 0.6, sd / 2 - 1, 0.05, 1.1, 0.05, C.PLAIN, 0xd8b020); // railing posts
  A.box(0, yR + 1.65, sd / 2 - 1, sw - 2, 0.06, 0.06, C.PLAIN, 0xd8b020);

  // gate cores: solid white towers standing out from the curtain wall, a rounded airside end, a door, a slot window,
  // the gate number; each with a jet bridge parked against it (rotunda, tunnel with glazing, cab, drive leg)
  const yc = yS - 3.2;
  T.cores.forEach((cx, i) => {
    A.box(cx - 1.2, -0.3, hd + 2.6, 8, yc + 0.3, 5.2, C.PLAIN, WHITE);
    A.cyl(cx + 2.8, hd + 2.6, -0.3, yc, 2.6, 2.6, 12, C.PLAIN, WHITE, { cap: true });
    A.box(cx - 3.2, -0.3, hd + 5.25, 1.6, 2.6, 0.08, C.PLAIN, 0x4a5056); // door
    A.box(cx - 1.2, 3.2, hd + 5.24, 0.7, yc - 5, 0.06, C.GLASS, GLASS); // slot window
    signs.push({ x: T.x - (hd + 5.32), z: T.z + cx - 1.2, yaw: -Math.PI / 2, base: yc - 2.4, h: 1.1, frame: false, front: [['info', 'Gate'], ['loc', String(i + 1)]] });
    // jet bridge: rotunda on a column, a tunnel out towards the apron, a cab at its end, a drive leg on two wheels
    const by = 4.2, z0 = hd + 5.2, z1 = z0 + 13;
    A.cyl(cx + 6, z0 + 1.6, -0.3, by + 3.2, 1.9, 1.9, 12, C.PLAIN, 0xd8d8d4, { cap: true });
    A.box(cx + 6, by, (z0 + 1.6 + z1) / 2, 2.8, 3.0, z1 - z0 - 1.6, C.PLAIN, 0xd8d8d4, { bottom: true });
    for (const sx of [-1, 1]) A.box(cx + 6 + sx * 1.42, by + 1.1, (z0 + 1.6 + z1) / 2, 0.04, 1.0, z1 - z0 - 3, C.GLASS, GLASS);
    A.box(cx + 6, by - 0.2, z1 + 1.6, 3.6, 3.4, 3.2, C.PLAIN, 0xc8c8c4, { bottom: true });
    A.box(cx + 6, by + 0.4, z1 + 3.3, 3.0, 2.6, 0.3, C.PLAIN, 0x2a2c30); // rubber canopy
    A.box(cx + 6, -0.3, z1 - 1.5, 0.5, by + 0.3, 0.5, C.PLAIN, 0x8a8e92); A.box(cx + 6, 0.2, z1 - 1.5, 3.2, 0.5, 1.0, C.PLAIN, 0x5a5e62); // drive leg
    for (const sx of [-1.3, 1.3]) A.cyl(cx + 6 + sx, z1 - 1.5, 0, 0.9, 0.45, 0.45, 8, C.PLAIN, 0x1c1c1e);
  });
  // ground floor doors to the apron between the cores, Kjevik-style gate letters over them
  [-57, -19, 19, 57].forEach((dx, i) => {
    A.box(dx, -0.3, hd - rec + 0.12, 3.2, 2.9, 0.1, C.PLAIN, 0x3a4046);
    signs.push({ x: T.x - (hd - rec + 0.2), z: T.z + dx, yaw: -Math.PI / 2, base: 3.05, h: 0.6, frame: false, front: [['loc', String.fromCharCode(65 + i)]] });
  });
  // landside: the kerb canopy over the drop-off lane, revolving doors, the kerb, departures / arrivals over the doors
  A.box(0, 4.3, -hd - 5, 84, 0.45, 9.6, C.PLAIN, WHITE, { bottom: true });
  A.box(0, 4.75, -hd - 9.75, 84, 0.5, 0.1, C.PLAIN, 0x9aa0a6);
  for (let x = -40; x <= 40.1; x += 10) A.cyl(x, -hd - 9.2, -0.3, 4.4, 0.18, 0.18, 8, C.PLAIN, 0xb8bcc0);
  A.box(0, -0.3, -hd - 4.2, 84, 0.45, 1.2, C.CONCRETE, 0xc8c4bc); // kerb
  for (const x of [-22, 22]) { A.cyl(x, -hd - 1.6, -0.3, 2.9, 1.6, 1.6, 12, C.GLASS, GLASS); A.cyl(x, -hd - 1.6, 2.9, 3.3, 1.75, 1.75, 12, C.PLAIN, 0x8a8e92, { cap: true }); } // revolving doors
  signs.push({ x: T.x + hd + 0.12, z: T.z - 22, yaw: Math.PI / 2, base: yB + 0.08, h: 1.0, frame: false, front: [['info', 'Departures']] });
  signs.push({ x: T.x + hd + 0.12, z: T.z + 22, yaw: Math.PI / 2, base: yB + 0.08, h: 1.0, frame: false, front: [['info', 'Arrivals']] });

  // ---- control tower: office block at its foot, tapered shaft, outward-leaning glass cab, catwalk, antenna mast ----
  const W = TOWER;
  A.setFrame(W.x - 1, y, W.z, F); A.seed = 3;
  A.walls(16, 10, -0.5, 7.4, C.APT, 0xe4e0d8, { front: C.GLASS, door: C.DOOR, fl: 3.7 }); A.flat(16, 10, 7, 0.5, C.GRAVEL, 0xffffff, C.PLAIN, 0xe4e0d8);
  A.setFrame(0, y, 0, 0); A.seed = 5;
  const c0 = W.shaft, c1 = c0 + 1.1, c2 = c1 + W.cab;
  A.cyl(W.x, W.z, -0.5, c0, 3.4, 2.5, 8, C.CONCRETE, 0xe8e4dc);
  for (let k = 0; k < 8; k += 2) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; A.box(W.x + Math.sin(a) * 2.9, 4, W.z + Math.cos(a) * 2.9, 0.5, c0 - 6, 0.5, C.GLASS, 0xffffff); } // stair windows
  A.cyl(W.x, W.z, c0, c1, 2.5, 5.0, 8, C.CONCRETE, 0xd8d4cc); // the flare under the cab
  A.cyl(W.x, W.z, c1 - 0.08, c1 + 0.06, 6.0, 6.0, 8, C.CONCRETE, 0xb8b4ac, { cap: true }); // catwalk
  A.cyl(W.x, W.z, c1 + 0.06, c1 + 1.1, 6.0, 6.0, 16, C.RAIL_IRON, 0xd8d8d8); // its railing
  A.cyl(W.x, W.z, c1, c2, 4.5, 5.4, 8, C.GLASS, 0xffffff); // cab glass, leaning out
  A.cyl(W.x, W.z, c2, c2 + 0.9, 6.2, 6.0, 8, C.CONCRETE, 0x3a3c40, { cap: true, capCell: C.GRAVEL, capCol: 0x8a8c90 }); // roof
  A.cyl(W.x, W.z, c2 + 0.9, c2 + 1.8, 2.2, 2.2, 8, C.METAL, 0xb0b4b8, { cap: true }); // plant on the roof
  A.box(W.x, c2 + 1.8, W.z, 0.22, 6, 0.22, C.METAL, 0xdddddd); // antenna mast
  for (const [dx, dz, h] of [[1.6, 0.4, 3], [-1.4, -0.9, 2.2]]) A.box(W.x + dx, c2 + 1.8, W.z + dz, 0.08, h, 0.08, C.METAL, 0xdddddd); // whips
  A.box(W.x - 1.6, c2 + 2.2, W.z + 1, 0.9, 0.9, 0.25, C.PLAIN, 0xeeeeee); // dish
  const beacon = new THREE.Vector3(W.x, y + c2 + 8.2, W.z);

  // ---- surveillance radar: a lattice tower by the cargo shed, the antenna turning on top ----
  const R = RADAR;
  A.box(R.x, -0.3, R.z, 2.6, R.h + 0.3, 2.6, C.RAIL_IRON, 0xd8d8d8);
  A.box(R.x, R.h, R.z, 3.6, 0.35, 3.6, C.METAL, 0x9a9ea4);
  A.box(R.x + 4, -0.3, R.z, 3.4, 2.9, 2.6, C.METAL, 0xe4e0d6, { topCell: C.SEAM, topCol: 0x9a9ea4 }); // equipment hut
  const B = new Builder(); B.seed = 7;
  B.cyl(0, 0, 0, 1.1, 0.55, 0.45, 8, C.METAL, 0x8a8e92, { cap: true });
  const S = 10, w = 7.6;
  for (let k = 0; k < S; k++) { // the reflector: a curved band, leaning back
    const xa = -w / 2 + (w * k) / S, xb = -w / 2 + (w * (k + 1)) / S, za = 0.5 * (xa / (w / 2)) ** 2, zb = 0.5 * (xb / (w / 2)) ** 2, lean = 0.5;
    const P = (x, z, v) => [x, 1.2 + v * 2.4, z + v * lean];
    B.quad(P(xa, za, 0), P(xb, zb, 0), P(xb, zb, 1), P(xa, za, 1), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, 0xe8e8e8);
    B.quad(P(xb, zb + 0.06, 0), P(xa, za + 0.06, 0), P(xa, za + 0.06, 1), P(xb, zb + 0.06, 1), [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, 0xd0d2d4);
  }
  B.box(0, 1.1, -1.0, 0.16, 0.16, 2.2, C.METAL, 0x8a8e92); B.box(0, 1.0, -2.1, 0.5, 0.5, 0.5, C.PLAIN, 0x5a5e62); // feed horn arm
  const radar = new THREE.Mesh(B.toGeometry()); radar.position.set(R.x, y + R.h + 0.35, R.z); radar.castShadow = true; radar.name = 'airport radar';

  return { signs, radar, beacon, nameBoard: { x: T.x - hd - T.over - 0.06, y: y + yS + T.slab / 2 + 0.3, z: T.z + 26, w: 36, h: 1.5, flush: true } };
}
