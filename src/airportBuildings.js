// The airport's terminal, control tower and radar (#227 phase 3). Everything solid goes into World.buildAirport's
// Builder (the towns' building atlas: glass, concrete, metal, windows lit at night), so it costs no draw calls. The
// radar's antenna turns, so it is its own small mesh with the same material. Signs (gate numbers, departures /
// arrivals) are handed to airportKit.js, which draws every airport sign in one mesh.
//
// Airport coordinates (see airportKit.js): the apron is x 100..330, the terminal stands on its east edge, its airside
// face towards -x. Builder frames: setFrame(x, y, z, yaw) maps local +z to world (sin yaw, cos yaw).
import * as THREE from 'three';
import { Builder, C } from './buildings.js';

export const TERMINAL = { x: 315, z: 120, len: 120, depth: 32, h: 12, over: 4, rise: 5 };
export const TOWER = { x: 256, z: 218, shaft: 26, cab: 3.7 };
export const RADAR = { x: 430, z: -140, h: 12 };
const F = -Math.PI / 2; // frame yaw for buildings facing the apron (local +z = world -x)

// A: the airport's Builder, y: runway height. Returns { signs: [...] for buildAirfieldKit, radar: Mesh (needs the
// building material: World sets it), beacon: Vector3 (the tower's rotating beacon), boards: { nameBoard: { x, y, z } } }.
export function buildTerminalArea(A, y) {
  const T = TERMINAL, hw = T.len / 2, hd = T.depth / 2, signs = [];

  // ---- terminal ----
  A.setFrame(T.x, y, T.z, F); A.seed = 40;
  A.walls(T.len, T.depth, -0.5, 5, C.APT, 0xe8e4dc, { front: C.GLASS, back: C.GLASS, side: C.CONCRETE, fl: 5 }); // the hall: glass both long sides
  A.walls(T.len - 2, T.depth - 3, 5, T.h, C.APT, 0xe8e4dc, { front: C.GLASS, back: C.GLASS, side: C.CONCRETE, fl: 3.5 }); // departures level, set back
  A.box(0, 4.75, 0, T.len + 0.3, 0.5, T.depth + 0.3, C.CONCRETE, 0xd8d8d4); // floor slab edge
  A.box(0, T.h - 0.2, 0, T.len - 1.6, 0.4, T.depth - 2.6, C.CONCRETE, 0xd8d8d4); // (the ceiling under the vault)
  // barrel-vault roof over both, overhanging the facades, a glass skylight along the crown, the underside pale
  const SEG = 12, zo = hd + T.over, Y = (z) => T.h + 0.4 + T.rise * (1 - (z / zo) ** 2), x0 = -hw - 2, x1 = hw + 2;
  for (let k = 0; k < SEG; k++) {
    const za = -zo + (2 * zo * k) / SEG, zb = -zo + (2 * zo * (k + 1)) / SEG, ya = Y(za), yb = Y(zb), sky = k === SEG / 2 - 1 || k === SEG / 2;
    const L = (x1 - x0) / 3;
    A.quad([x1, ya, za], [x0, ya, za], [x0, yb, zb], [x1, yb, zb], [0, 0, L, 0, L, 1, 0, 1], sky ? C.GLASS : C.SEAM, sky ? 0xffffff : 0xc8ccd0);
    A.quad([x0, ya - 0.25, za], [x1, ya - 0.25, za], [x1, yb - 0.25, zb], [x0, yb - 0.25, zb], [0, 0, L, 0, L, 1, 0, 1], C.PLAIN, 0xe8e6e0); // underside
    for (const s of [-1, 1]) { const x = s * (hw - 1); A.tri([x, T.h, 0], [x, ya, za * (hd - 1.5) / zo], [x, yb, zb * (hd - 1.5) / zo], [0, 0, 1, 0, 0.5, 0.5], C.METAL, 0xb8bcc0); } // gable ends
  }
  for (const s of [-1, 1]) A.box(0, Y(zo) - 0.45, s * zo, x1 - x0, 0.45, 0.3, C.PLAIN, 0x9aa0a6); // fascia along the eaves
  // roof ribs over the overhangs and slender columns holding the eaves, every 12 m
  for (let x = -hw; x <= hw + 0.1; x += 12) for (const s of [-1, 1]) {
    A.cyl(x, s * (zo - 1.2), -0.3, Y(zo - 1.2) - 0.3, 0.32, 0.26, 8, C.PLAIN, 0xe0e2e4);
    A.box(x, Y(hd) - 0.7, s * (hd + T.over / 2), 0.4, 0.5, T.over, C.PLAIN, 0xd0d4d8);
  }
  // gates along the airside facade: numbers over the doors (gate 1 at the south end)
  for (let k = 0; k < 4; k++) {
    const lx = -45 + 30 * k; // (local x: world z = T.z + lx)
    signs.push({ x: T.x - hd - 0.08, z: T.z + lx, yaw: -Math.PI / 2, base: 5.3, h: 1.3, frame: false, front: [['info', 'Gate'], ['loc', String(k + 1)]] });
    A.box(lx, -0.3, hd + 0.6, 4.4, 3.5, 1.2, C.PLAIN, 0x5a6068); // gate door portal
  }
  // landside: the kerb canopy over the drop-off lane, on columns, departures / arrivals signs on the facade above
  A.box(0, 4.3, -hd - 5, 84, 0.45, 9.6, C.PLAIN, 0xf4f4f0, { bottom: true });
  for (let x = -40; x <= 40.1; x += 10) A.cyl(x, -hd - 9.2, -0.3, 4.4, 0.18, 0.18, 6, C.PLAIN, 0xb8bcc0);
  A.box(0, -0.3, -hd - 4.2, 84, 0.45, 1.2, C.CONCRETE, 0xc8c4bc); // kerb
  signs.push({ x: T.x + hd + 0.08, z: T.z - 22, yaw: Math.PI / 2, base: 5.6, h: 1.1, frame: false, front: [['info', 'Departures']] });
  signs.push({ x: T.x + hd + 0.08, z: T.z + 22, yaw: Math.PI / 2, base: 5.6, h: 1.1, frame: false, front: [['info', 'Arrivals']] });

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

  return { signs, radar, beacon, nameBoard: { x: T.x - hd - T.over - 0.35, y: y + Y(zo) + 3.0, z: T.z } };
}
