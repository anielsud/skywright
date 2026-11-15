// Building kit per location style. Each maker returns { w, d, h, draw(S, D), ... } where S is the shell builder
// (walls + roofs, always drawn) and D the detail builder (balconies, sills, gutters, chimneys, porches: near only),
// both framed at the building's origin with the front facing +z (toward the street).
// Extra fields used by towns.js for the plot: yard (true for detached homes), garage (side -1/1 the drive goes to),
// door (local x of the front door), chimney (local smoke point).
import { C } from './buildings.js';

const pick = (r, a) => a[Math.floor(r() * a.length)];
export const PALETTE = {
  alpine: { walls: [0xf6f1e6, 0xefe2c8, 0xe6d6b8, 0xf2ece0, 0xdcc8a4, 0xe8d0c0, 0xd8e0d0, 0xf0e4b0], roofs: [0x8a8070, 0x6a6c70, 0x9a6a50, 0x5a5c62, 0x7a7266], wood: [0xffffff, 0xf0e0c8, 0xd8b898, 0xc8a080] },
  islands: { walls: [0xfaf2dc, 0xa8dde2, 0xf6cfae, 0xf8d8e4, 0xd2ecc8, 0xfff0a8, 0xb8d8f0, 0xf4b8a0, 0xffffff], roofs: [0xc06848, 0xb05040, 0x5a80a0, 0x4a8a84, 0xc88a60, 0x5a7a50, 0xa84a40, 0x9a9890] },
  canyon: { walls: [0xd89a6a, 0xc8875a, 0xe0b080, 0xcf9f78, 0xe8c49c, 0xb87a52, 0xe8d4b4], roofs: [0x8a6a50, 0x6e6a64, 0xa07a5a, 0x7a5040, 0x5a5a5c] },
};

export function makeBuilding(type, style, r) {
  const P = PALETTE[style];
  const K = KITS[style][type] || KITS.common[type];
  return K(r, P, style);
}

const rot = (B, a) => B.setFrame(B.fx, B.fy, B.fz, Math.atan2(B.sn, B.cs) + a);
// shift a builder frame by a local offset (and turn), returning setFrame args
function offset(B, x, y, z, a = 0) { return [B.fx + x * B.cs + z * B.sn, B.fy + y, B.fz - x * B.sn + z * B.cs, Math.atan2(B.sn, B.cs) + a]; }
// run fn with S and D framed at a local offset, then restore
function at(S, D, x, y, z, a, fn) {
  const s = [S.fx, S.fy, S.fz, S.yaw], d = [D.fx, D.fy, D.fz, D.yaw];
  S.setFrame(...offset(S, x, y, z, a)); D.setFrame(...offset(D, x, y, z, a)); fn();
  S.setFrame(...s); D.setFrame(...d);
}
const darker = (hex, k = 0.8) => { const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255; return (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k); };

// ---- shared parts ----
function chimney(D, x, y, z, { col = 0x8a7a6e, cell = C.STONE, h = 3.2 } = {}) {
  D.box(x, y - h + 1.5, z, 0.8, h, 0.8, cell, col, { top: false });
  D.box(x, y + 1.5, z, 1.05, 0.14, 1.05, C.CONCRETE, 0x9a968e, { topCol: 0x55524e });
  D.box(x, y + 1.64, z, 0.5, 0.35, 0.5, C.CONCRETE, 0x6a6058, { topCol: 0x222222 });
}
// balcony along the +z face from x0 to x1 at floor height y: slab, carved/iron railing, brackets
function balcony(D, x0, x1, z, depth, y, { rail = C.RAIL_WOOD, railCol = 0xffffff, slab = C.DARKWOOD, slabCol = 0xffffff, sides = true, brackets = true } = {}) {
  const zf = z + depth, rh = 1.05, L = x1 - x0;
  D.box((x0 + x1) / 2, y - 0.22, z + depth / 2, L, 0.22, depth, slab, slabCol);
  D.panel([x0, y, zf], [x1, y, zf], [x1, y + rh, zf], [x0, y + rh, zf], rail, railCol, 3, [0, 0, L / 1.6, 0, L / 1.6, 1, 0, 1]);
  D.box((x0 + x1) / 2, y + rh, zf, L + 0.1, 0.08, 0.14, slab, slabCol);
  if (sides) for (const x of [x0, x1]) { D.panel(x === x0 ? [x, y, z] : [x, y, zf], x === x0 ? [x, y, zf] : [x, y, z], x === x0 ? [x, y + rh, zf] : [x, y + rh, z], x === x0 ? [x, y + rh, z] : [x, y + rh, zf], rail, railCol, 3, [0, 0, depth / 1.6, 0, depth / 1.6, 1, 0, 1]); }
  if (brackets) for (let x = x0 + 0.3; x <= x1 - 0.2; x += Math.max(1.2, L / Math.max(1, Math.round(L / 2)))) D.box(x, y - 0.7, z + depth * 0.35, 0.14, 0.5, depth * 0.7, slab, slabCol, { top: false });
}
// dormer on the +x slope of a gable roof (ridge along z) whose eave line is at wall height y, half width hw, rise
function dormer(S, D, hw, y, rise, xf, zc, dw, dh, { wallCell, wallCol, roofCell, roofCol, win = C.WIN }) {
  const roofY = (x) => y + rise * (1 - x / hw), yb = roofY(xf), yt = yb + dh, dr = dw * 0.45, o = 0.25;
  const xBack = Math.max(0.2, hw * (1 - (yt - y) / rise)), xRidge = Math.max(0.1, hw * (1 - (yt + dr - y) / rise));
  const z0 = zc - dw / 2, z1 = zc + dw / 2;
  S.quad([xf, yb - 0.2, z1], [xf, yb - 0.2, z0], [xf, yt, z0], [xf, yt, z1], [0, 0.18, 1, 0.18, 1, 0.86, 0, 0.86], win, wallCol);
  S.tri([xBack, yt, z0], [xf, yt, z0], [xf, yb - 0.2, z0], [0, 0, 0.5, 0, 0.5, 0.5], wallCell, wallCol);
  S.tri([xf, yb - 0.2, z1], [xf, yt, z1], [xBack, yt, z1], [0, 0, 0, 0.5, 0.5, 0.5], wallCell, wallCol);
  S.tri([xf, yt, z1], [xf, yt, z0], [xf, yt + dr, zc], [0, 0, 1, 0, 0.5, 0.3], wallCell, wallCol);
  const L = (xf + o - xRidge) / 3, sl = Math.hypot(dw / 2 + o, dr) / 3;
  S.quad([xRidge, yt - 0.1, z1 + o], [xf + o, yt - 0.1, z1 + o], [xf + o, yt + dr, zc], [xRidge, yt + dr, zc], [0, 0, L, 0, L, sl, 0, sl], roofCell, roofCol);
  S.quad([xf + o, yt - 0.1, z0 - o], [xRidge, yt - 0.1, z0 - o], [xRidge, yt + dr, zc], [xf + o, yt + dr, zc], [0, 0, L, 0, L, sl, 0, sl], roofCell, roofCol);
  S.quad([xf + o, yt - 0.28, z1 + o], [xf + o, yt - 0.28, zc], [xf + o, yt + dr - 0.1, zc], [xf + o, yt - 0.1, z1 + o], [0, 0, 1, 0, 1, 0.1, 0, 0.1], C.TRIM, 0xf0eee8);
  S.quad([xf + o, yt - 0.28, zc], [xf + o, yt - 0.28, z0 - o], [xf + o, yt - 0.1, z0 - o], [xf + o, yt + dr - 0.1, zc], [0, 0, 1, 0, 1, 0.1, 0, 0.1], C.TRIM, 0xf0eee8);
}
// solar panels flush on the +x slope of a gable roof
function solar(S, hw, y, rise, over, zc, len, rows) {
  const ex = hw + over, ye = y - over * rise / hw, sx = (t) => ex * (1 - t), sy = (t) => ye + (y + rise - ye) * t;
  const t0 = 0.18, t1 = Math.min(0.85, t0 + rows * 0.24), n = 0.06 * rise / hw;
  S.quad([sx(t0), sy(t0) + 0.1 + n, zc + len / 2], [sx(t0), sy(t0) + 0.1 + n, zc - len / 2], [sx(t1), sy(t1) + 0.1 + n, zc - len / 2], [sx(t1), sy(t1) + 0.1 + n, zc + len / 2], [0, 0, len / 2, 0, len / 2, rows, 0, rows], C.SOLAR, 0xffffff);
}
// porch / veranda across the +z face: deck, posts, railing, lean-to roof
function veranda(S, D, w, d, depth, { postCol = 0xffffff, roofCell = C.SEAM, roofCol = 0xb83a3a, deck = 0.5, rail = C.RAIL_IRON, railCol = 0xf4f4f0, roofY = 2.9, steps = true } = {}) {
  const z0 = d / 2, z1 = d / 2 + depth, hw = w / 2;
  D.box(0, -0.6, (z0 + z1) / 2, w, 0.6 + deck, depth, C.DARKWOOD, 0xe0d8c8, { topCell: C.DARKWOOD, topCol: 0xc8b090 });
  for (let k = 0; k <= Math.max(2, Math.round(w / 2.6)); k++) { const x = -hw + 0.2 + (k / Math.max(2, Math.round(w / 2.6))) * (w - 0.4); D.box(x, deck, z1 - 0.2, 0.18, roofY - deck, 0.18, C.TRIM, postCol, { top: false }); }
  for (const s of [-1, 1]) D.panel(s < 0 ? [-hw + 0.1, deck, z1 - 0.2] : [1.0, deck, z1 - 0.2], s < 0 ? [-1.0, deck, z1 - 0.2] : [hw - 0.1, deck, z1 - 0.2], s < 0 ? [-1.0, deck + 0.9, z1 - 0.2] : [hw - 0.1, deck + 0.9, z1 - 0.2], s < 0 ? [-hw + 0.1, deck + 0.9, z1 - 0.2] : [1.0, deck + 0.9, z1 - 0.2], rail, railCol, 3, [0, 0, (hw - 1.1) / 1.4, 0, (hw - 1.1) / 1.4, 1, 0, 1]);
  if (steps) for (let k = 0; k < 3; k++) D.box(0, -0.4, z1 + 0.25 + k * 0.3, 2.0, deck - k * (deck / 3), 0.32, C.CONCRETE, 0xc8c4bc);
  // lean-to roof
  const ex = hw + 0.3, yl = roofY, yh = roofY + 0.7, zz1 = z1 + 0.35;
  S.quad([-ex, yl, zz1], [ex, yl, zz1], [ex, yh, z0], [-ex, yh, z0], [0, 0, 2 * ex / 3, 0, 2 * ex / 3, depth / 3, 0, depth / 3], roofCell, roofCol);
  S.quad([ex, yl - 0.12, zz1], [-ex, yl - 0.12, zz1], [-ex, yh - 0.12, z0], [ex, yh - 0.12, z0], [0, 0, 1, 0, 1, 1, 0, 1], C.TRIM, 0xf0eee8);
  S.plainQuad([-ex, yl - 0.25, zz1], [ex, yl - 0.25, zz1], [ex, yl, zz1], [-ex, yl, zz1], C.TRIM, 0xf4f2ec);
}
// small garage annex on the +x (side) of a w x d house, door toward +z
function garage(S, D, w, d, { wallCell = C.PLAIN, col, roofCell = C.GRAVEL, roofCol = 0x8a8880, flatRoof = true, gw = 3.6, gd = 6.2 } = {}) {
  const x = w / 2 + gw / 2 - 0.05, z = d / 2 - gd / 2;
  at(S, D, x, 0, z, 0, () => {
    S.walls(gw, gd, -0.8, 2.9, wallCell, col, { front: C.GARAGE });
    if (flatRoof) S.flat(gw, gd, 2.6, 0.3, roofCell, roofCol, wallCell, col); else S.gable(gw, gd, 2.9, 1.2, 0.3, roofCell, roofCol, wallCell, col);
  });
}

const KITS = {
  common: {
    church: (r, P, st) => {
      const w = 11, d = 24, h = 10, wallC = st === 'canyon' ? 0xe8d0b0 : 0xf8f6f0, roofC = st === 'canyon' ? 0xb07a52 : st === 'islands' ? 0x3c78b8 : 0x55585e;
      return { w, d: d + 6, h: 34, kind: 'church', draw(S, D) {
        const cell = st === 'canyon' ? C.ADOBE : C.PLAIN;
        S.plinth(w, d, 0.6, C.STONE, 0xd8d0c0);
        S.walls(w, d, -1, h, C.CHURCH_WIN, wallC, { front: cell, door: st === 'canyon' ? C.ADOBE_DOOR : C.DOOR, fl: 5 });
        S.gable(w, d, h, st === 'islands' ? 3 : 6, 0.5, st === 'islands' ? C.TILES : C.SLATE, roofC, cell, wallC);
        // buttresses
        for (let k = -2; k <= 2; k++) for (const s of [-1, 1]) D.box(s * (w / 2 + 0.3), -0.5, k * 4.6, 0.6, h * 0.75, 1.0, C.STONE, 0xd8d0c0);
        const tz = d / 2 + 2.6, tw = 5.2, th = st === 'canyon' ? 17 : 24;
        S.box(0, -0.5, tz, tw + 0.3, 1.2, tw + 0.3, C.STONE, 0xd8d0c0, { top: false });
        S.box(0, 0, tz, tw, th, tw, cell, wallC, { top: false });
        D.box(0, th - 5, tz, tw + 0.1, 3, tw + 0.1, C.CHURCH_WIN, wallC, { top: false, s: 3 });
        D.box(0, th - 1.6, tz, tw + 0.4, 0.3, tw + 0.4, C.CONCRETE, 0xd8d4cc);
        // clock faces
        D.box(0, th - 9, tz + tw / 2 + 0.03, 1.8, 1.8, 0.08, C.TRIM, 0xf8f4e0); D.box(tw / 2 + 0.03, th - 9, tz, 0.08, 1.8, 1.8, C.TRIM, 0xf8f4e0); D.box(-tw / 2 - 0.03, th - 9, tz, 0.08, 1.8, 1.8, C.TRIM, 0xf8f4e0);
        if (st === 'islands') { S.box(0, th, tz, tw, 0.01, tw, C.PLAIN, wallC); S.dome(0, tz, th, 2.8, 14, 5, C.SEAM, roofC); D.cyl(0, tz, th + 2.7, th + 4.6, 0.12, 0.12, 4, C.PLAIN, 0xd4af37); D.box(0, th + 3.9, tz, 1.2, 0.14, 0.14, C.PLAIN, 0xd4af37); }
        else if (st === 'canyon') { S.box(0, th, tz, tw + 0.6, 0.6, tw + 0.6, C.ADOBE, wallC); D.box(0, th + 0.6, tz, 0.3, 3, 0.3, C.DARKWOOD, 0x553322); D.box(0, th + 2.3, tz, 1.8, 0.3, 0.3, C.DARKWOOD, 0x553322); }
        else { S.hip(tw, tw, th, 11, 0.3, C.SLATE, roofC, { gutter: false }); D.cyl(0, tz, th + 10.5, th + 14, 0.12, 0.12, 4, C.PLAIN, 0xd4af37); D.box(0, th + 12.6, tz, 1.4, 0.18, 0.18, C.PLAIN, 0xd4af37); }
      } };
    },
    silo: (r) => { const rad = 2.6 + r() * 1.2, h = 12 + r() * 8, col = pick(r, [0xc8ccd0, 0xd8d8d0, 0x5a7a9a, 0xb8bcc0]); return { w: rad * 2, d: rad * 2, h: h + rad, draw(S, D) { S.cyl(0, 0, -0.5, h, rad, rad, 16, C.METAL, col); S.dome(0, 0, h, rad, 16, 3, C.SEAM, 0xd0d4d8); D.box(rad + 0.3, 0, 0, 0.5, h, 0.5, C.METAL, 0x666666, { top: false }); for (let y = 2; y < h; y += 2.5) D.cyl(0, 0, y, y + 0.12, rad + 0.04, rad + 0.04, 16, C.METAL, 0x8a8a8a); } }; },
    shed: (r, P, st) => { const w = 5 + r() * 4, d = 6 + r() * 5, h = 3 + r() * 1, col = st === 'canyon' ? 0xb8bcc0 : pick(r, [0x9a6a48, 0x7a5638, 0xa8a8a0]); return { w, d, h: h + 2, draw(S) { S.walls(w, d, -0.5, h, st === 'canyon' ? C.METAL : C.BOARDS, col, { door: C.GARAGE }); S.gable(w, d, h, 1.4, 0.3, C.SEAM, 0x8a8e94, st === 'canyon' ? C.METAL : C.BOARDS, col, { gutter: false }); } }; },
    gardenShed: (r, P, st) => { const w = 2.4 + r(), d = 2.2 + r(), col = st === 'alpine' ? 0xffffff : pick(r, [0xe8e0d0, 0xa8c8b0, 0xd8b890]); return { w, d, h: 3, draw(S) { S.walls(w, d, -0.3, 2.1, st === 'alpine' ? C.WOOD : C.CLAP, col); S.gable(w, d, 2.1, 0.8, 0.2, st === 'islands' ? C.SEAM : C.SHINGLE, 0x6a5a4a, st === 'alpine' ? C.WOOD : C.CLAP, col, { gutter: false, th: 0.08 }); } }; },
    hut: (r) => { const w = 4 + r(), d = 4 + r(); return { w, d, h: 5, draw(S, D) { D.box(0, -0.6, 0, w + 1.2, 1.1, d + 1.2, C.DARKWOOD, 0xd8c8a8); S.walls(w, d, 0.4, 2.9, C.BOARDS, 0xe8d8b8, { door: C.DOOR }); S.hip(w, d, 2.9, 2.4, 0.8, C.THATCH, 0xffffff, { trim: C.THATCH, trimCol: 0xffffff, gutter: false, th: 0.3 }); for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) D.box(x * (w / 2 + 0.5), -0.6, z * (d / 2 + 0.5), 0.2, 3.4, 0.2, C.DARKWOOD, 0xb89870, { top: false }); } }; },
  },
  alpine: {
    house: (r, P) => {
      const roll = r();
      if (roll < 0.58) { // Bernese chalet: stone/plaster base, timber floors, low wide gable to the street, deep eaves, balconies
        const w = 10 + r() * 4, d = 11 + r() * 5, fl = 2 + (r() < 0.45 ? 1 : 0), h = fl * 3, rise = w * (0.24 + r() * 0.08), wood = pick(r, P.wood), roof = pick(r, P.roofs);
        const roofCell = pick(r, [C.SLATE, C.DARKTILE, C.SHINGLE, C.SLATE]), plaster = r() < 0.4, baseCol = plaster ? pick(r, P.walls) : 0xffffff, side = r() < 0.5 ? 1 : -1;
        const sideBal = r() < 0.5, attic = rise > 2.6, hasSolar = r() < 0.25, gar = r() < 0.35;
        return { w: w + (gar ? 3.6 : 0), d, h: h + rise, yard: true, garage: gar ? 1 : side, driveX: gar ? w / 2 + 1.8 : undefined, door: 0, chimney: [w * 0.22, h + rise * 0.6 + 1.5, -d * 0.2], draw(S, D) {
          S.plinth(w, d, 0.5, C.STONE, 0xd0c8b8);
          S.walls(w, d, -1, 3, plaster ? C.WIN_GREEN : C.STONE_WIN, baseCol, { door: plaster ? C.DOOR : C.WOOD_DOOR, doorAt: 0.5 });
          S.walls(w, d, 3, h, C.WOOD_WIN, wood, { front: C.WOOD_WIN2, side: C.WOOD_WIN, back: C.WOOD });
          // floor band between masonry and timber
          D.box(0, 2.85, 0, w + 0.16, 0.2, d + 0.16, C.DARKWOOD, wood, { top: false });
          S.gable(w, d, h, rise, 1.5, roofCell, roof, C.WOOD, wood, { under: C.DARKWOOD, overZ: 1.9, trim: C.DARKWOOD, trimCol: darker(wood, 0.9), th: 0.3 });
          if (attic) { const bh = Math.min(2.2, rise * 0.7), a = (w / 2) * (1 - bh / rise) - 0.3; if (a > 1.2) S.quad([-a, h + 0.1, d / 2 + 0.03], [a, h + 0.1, d / 2 + 0.03], [a, h + bh, d / 2 + 0.03], [-a, h + bh, d / 2 + 0.03], [0, 0.16, Math.max(1, Math.round(2 * a / 3)), 0.16, Math.max(1, Math.round(2 * a / 3)), 0.86, 0, 0.86], C.WOOD_WIN2, wood); }
          for (let f = 1; f <= fl - 1 + (attic ? 1 : 0); f++) balcony(D, -w / 2 - 0.3, w / 2 + 0.3, d / 2, 1.4, f * 3 + 0.05, { slabCol: wood, railCol: wood });
          if (sideBal) at(S, D, 0, 0, 0, side * Math.PI / 2, () => balcony(D, -d / 2 + 1, d / 2 - 1, w / 2, 1.2, 3.05, { slabCol: wood, railCol: wood }));
          // rafter tails under the eaves
          if (S.fine > 1) for (let z = -d / 2 - 1.2; z <= d / 2 + 1.2; z += 1.3) for (const s of [-1, 1]) { const y0 = h - 0.32 - 0.75 * rise / (w / 2), x0 = s * (w / 2 + 0.05), x1 = s * (w / 2 + 1.45); for (const dz of [-0.07, 0.07]) D.plainQuad(dz * s > 0 ? [x0, y0 - 0.16, z + dz] : [x1, y0 - 0.16 - 0.1, z + dz], dz * s > 0 ? [x1, y0 - 0.16 - 0.1, z + dz] : [x0, y0 - 0.16, z + dz], dz * s > 0 ? [x1, y0 - 0.1, z + dz] : [x0, y0, z + dz], dz * s > 0 ? [x0, y0, z + dz] : [x1, y0 - 0.1, z + dz], C.DARKWOOD, darker(wood, 0.8)); }
          if (hasSolar) solar(S, w / 2, h, rise, 1.5, 0, Math.min(d, 6 + r() * 4), 2);
          chimney(D, w * 0.22, h + rise * 0.6 + 0.5, -d * 0.2);
          if (gar) garage(S, D, w, d, { wallCell: C.WOOD, col: wood, roofCell: C.GRAVEL });
          // woodpile under the side eave
          if (r() < 0.5) D.box(-side * (w / 2 + 0.45), -0.3, -d * 0.2, 0.7, 1.6, d * 0.5, C.DARKWOOD, 0xc8a070, { topCell: C.DARKWOOD });
        } };
      }
      // plaster village house (Engadin / Bernese Oberland), steep roof with dormers, shutters, maybe an L-wing
      const w = 8 + r() * 4, d = 9 + r() * 4, fl = 2 + (r() < 0.35 ? 1 : 0), h = fl * 3, rise = w * (0.5 + r() * 0.2), wall = pick(r, P.walls), roof = pick(r, P.roofs), hipR = r() < 0.3;
      const win = pick(r, [C.WIN_GREEN, C.WIN_GREEN, C.SHUTTERED, C.WIN, C.WIN_TALL]), roofCell = pick(r, [C.SLATE, C.DARKTILE, C.TILES]), wing = r() < 0.35, dorm = !hipR && r() < 0.7, gar = r() < 0.3;
      const ww = d * 0.55, wd = w * 0.7;
      return { w: w + (wing ? ww * 0.6 : 0) + (gar ? 3.6 : 0), d, h: h + rise, yard: true, garage: gar ? 1 : -1, driveX: gar ? w / 2 + 1.8 : undefined, door: 0, chimney: [-w * 0.2, h + rise * 0.5 + 1.5, d * 0.1], draw(S, D) {
        S.plinth(w, d, 0.4);
        S.walls(w, d, -1, h, win, wall, { door: C.DOOR, back: C.WIN });
        // corner quoins
        for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) D.box(x * (w / 2 + 0.03), -0.3, z * (d / 2 + 0.03), 0.45, h + 0.3, 0.45, C.PLAIN, darker(wall, 0.88), { top: false });
        D.box(0, -0.2, d / 2 + 0.9, 2.4, 0.2, 1.8, C.CONCRETE, 0xc8c4bc);
        if (hipR) S.hip(w, d, h, rise * 0.75, 0.7, roofCell, roof);
        else {
          S.gable(w, d, h, rise, 0.7, roofCell, roof, C.PLAIN, wall);
          if (dorm) for (const s of [1, -1]) { rot(S, s > 0 ? 0 : Math.PI); rot(D, s > 0 ? 0 : Math.PI); const n = d > 11 ? 2 : 1; for (let k = 0; k < n; k++) dormer(S, D, w / 2, h, rise, w * 0.2, (k - (n - 1) / 2) * d * 0.45, 1.8, 1.6, { wallCell: C.PLAIN, wallCol: wall, roofCell, roofCol: roof, win: C.WIN }); rot(S, s > 0 ? 0 : -Math.PI); rot(D, s > 0 ? 0 : -Math.PI); }
        }
        if (wing) at(S, D, -w / 2 - ww / 2 + 0.6, 0, -d / 2 + wd / 2, 0, () => { S.walls(ww, wd, -1, h - 3, C.WIN, wall); rot(S, Math.PI / 2); S.gable(wd, ww, h - 3, wd * 0.45, 0.5, roofCell, roof, C.PLAIN, wall); rot(S, -Math.PI / 2); });
        if (gar) garage(S, D, w, d, { col: wall, flatRoof: false, roofCell, roofCol: roof });
        chimney(D, -w * 0.2, h + rise * 0.5, d * 0.1, { cell: C.PLAIN, col: wall });
        // little entrance canopy
        D.box(0, 2.6, d / 2 + 0.6, 2.4, 0.14, 1.2, C.TRIM, 0xe8e6e0);
      } };
    },
    center: (r, P) => {
      const roll = r();
      if (roll < 0.25) { // shop / restaurant with a roof terrace
        const w = 10 + r() * 6, d = 10 + r() * 4, h = 4.2, wall = pick(r, P.walls);
        return { w, d, h, kind: 'shop', draw(S, D) { S.plinth(w, d, 0.3); S.walls(w, d, -1, h + 1.1, C.PLAIN, wall, { front: pick(r, [C.SHOP, C.SHOP2, C.SHOP3]) }); S.flat(w, d, h, 1.1, C.PAVERS, 0xd0ccc4, C.PLAIN, wall); for (let k = 0; k < 3; k++) { const x = -w * 0.3 + k * w * 0.3; D.cyl(x, 0, h, h + 2.3, 0.05, 0.05, 4, C.METAL, 0x888888); D.cyl(x, 0, h + 2.0, h + 2.6, 1.4, 0.05, 8, C.TRIM, pick(r, [0xf4f0e6, 0xc8283a, 0x2e6b3f])); } } };
      }
      if (roll < 0.55) { // big chalet hotel: balconies on every floor along the long front
        const w = 20 + r() * 10, d = 14 + r() * 4, fl = 4 + (r() < 0.5 ? 1 : 0), h = fl * 3, rise = d * 0.32, wood = pick(r, P.wood), roof = pick(r, P.roofs), wall = pick(r, P.walls);
        return { w, d, h: h + rise, kind: 'hotel', draw(S, D) {
          S.plinth(w, d, 0.5, C.STONE, 0xd0c8b8);
          S.walls(w, d, -1, 3, C.SHOP, wall, { side: C.STONE_WIN, back: C.STONE_WIN });
          S.walls(w, d, 3, h, C.BALCONY, wood, { side: C.WOOD_WIN, back: C.WOOD_WIN });
          rot(S, -Math.PI / 2); rot(D, -Math.PI / 2); S.gable(d, w, h, rise, 1.6, C.SLATE, roof, C.WOOD, wood, { under: C.DARKWOOD, overZ: 1.8, trim: C.DARKWOOD, trimCol: wood, th: 0.32 });
          for (const k of [-1, 1]) dormer(S, D, d / 2, h, rise, d * 0.18, k * w * 0.22, 2.4, 1.8, { wallCell: C.WOOD, wallCol: wood, roofCell: C.SLATE, roofCol: roof, win: C.WOOD_WIN2 });
          rot(S, Math.PI / 2); rot(D, Math.PI / 2);
          for (let f = 1; f < fl; f++) balcony(D, -w / 2, w / 2, d / 2, 1.5, f * 3 + 0.05, { slabCol: wood, railCol: wood, sides: true });
          // hotel name board under the eave
          D.box(0, h - 1.0, d / 2 + 1.6, w * 0.45, 0.8, 0.12, C.TRIM, 0x3a2a1e);
          chimney(D, w * 0.3, h + rise * 0.7, 0, { cell: C.STONE }); chimney(D, -w * 0.3, h + rise * 0.7, 0, { cell: C.STONE });
        } };
      }
      // townhouse with ground floor shop, steep roof parallel to the street with dormers
      const w = 10 + r() * 8, d = 11 + r() * 3, fl = 3 + (r() < 0.4 ? 1 : 0), h = fl * 3, rise = d * 0.45, wall = pick(r, P.walls), roof = pick(r, P.roofs), win = pick(r, [C.WIN_GREEN, C.WIN_TALL, C.SHUTTERED, C.APT]);
      return { w, d, h: h + rise, kind: 'townhouse', draw(S, D) {
        S.plinth(w, d, 0.3);
        S.walls(w, d, -1, 3, C.WIN, wall, { front: pick(r, [C.SHOP, C.SHOP2, C.SHOP3, C.SHOP]) }); S.walls(w, d, 3, h, win, wall, { back: C.WIN });
        D.box(0, 2.9, 0, w + 0.14, 0.24, d + 0.14, C.PLAIN, darker(wall, 0.85), { top: false }); // cornice
        rot(S, -Math.PI / 2); rot(D, -Math.PI / 2); S.gable(d, w, h, rise, 0.6, pick(r, [C.SLATE, C.TILES, C.DARKTILE]), roof, C.PLAIN, wall);
        const n = Math.max(1, Math.round(w / 6)); for (let k = 0; k < n; k++) dormer(S, D, d / 2, h, rise, d * 0.18, (k - (n - 1) / 2) * (w / n), 1.8, 1.7, { wallCell: C.PLAIN, wallCol: wall, roofCell: C.SLATE, roofCol: roof });
        rot(S, Math.PI / 2); rot(D, Math.PI / 2);
        if (win === C.WIN_TALL) for (let f = 1; f < fl; f++) for (let k = 0; k < Math.round(w / 3); k++) balcony(D, -w / 2 + k * (w / Math.round(w / 3)) + 0.5, -w / 2 + (k + 1) * (w / Math.round(w / 3)) - 0.5, d / 2, 0.5, f * 3 + 0.05, { rail: C.RAIL_IRON, railCol: 0x222222, slab: C.CONCRETE, slabCol: 0xd8d4cc, sides: true, brackets: false });
      } };
    },
    barn: (r, P) => {
      const w = 12 + r() * 5, d = 18 + r() * 8, h = 6, rise = w * 0.42, col = pick(r, [0xffffff, 0xe0d0c0, 0xd0b8a0]);
      return { w, d, h: h + rise, draw(S, D) {
        S.walls(w, d, -1, 2.5, C.STONE, 0xffffff); S.walls(w, d, 2.5, h, C.BOARDS, 0xc8a080, { front: C.BOARDS });
        S.gable(w, d, h, rise, 0.9, C.SHINGLE, 0x6a5a4a, C.BOARDS, 0xc8a080, { under: C.DARKWOOD, trim: C.DARKWOOD, trimCol: 0xa08060, gutter: false });
        D.box(0, 0, d / 2 + 0.05, 4, 4, 0.1, C.DARKWOOD, col, { top: false });
        // hay ramp to the upper floor at the back
        D.box(0, -0.5, -d / 2 - 2.5, 4, 2.6, 5, C.STONE, 0xffffff, { topCell: C.GRAVEL });
      } };
    },
  },
  islands: {
    house: (r, P) => {
      const wall = pick(r, P.walls), roof = pick(r, P.roofs), roll = r();
      if (roll < 0.28) { // whitewashed cube with flat roof terrace (Greek style)
        const w = 7 + r() * 4, d = 7 + r() * 4, fl = r() < 0.5 ? 1 : 2, h = fl * 3, col = r() < 0.5 ? 0xffffff : wall, upper = fl === 1 && r() < 0.5;
        return { w, d, h, yard: true, garage: r() < 0.5 ? 1 : -1, door: 0, draw(S, D) {
          S.walls(w, d, -1, h + 0.6, C.WIN_BLUE, col, { door: C.DOOR });
          S.flat(w, d, h, 0.6, C.CONCRETE, 0xf0f0f0, C.PLAIN, col);
          if (upper) at(S, D, -w * 0.2, h, -d * 0.15, 0, () => { S.walls(w * 0.45, d * 0.5, 0, 2.9, C.WIN_BLUE, col); S.flat(w * 0.45, d * 0.5, 2.6, 0.3, C.CONCRETE, 0xf0f0f0, C.PLAIN, col); });
          if (r() < 0.35) D.dome(w * 0.25, -d * 0.2, h, 1.6, 12, 4, C.SEAM, 0x3c78b8);
          // pergola over the terrace
          if (r() < 0.6) { for (const [x, z] of [[1, 1], [1, -0.2]]) D.box(x * w * 0.3, h, z * d * 0.35, 0.16, 2.3, 0.16, C.TRIM, 0xffffff, { top: false }); for (let k = 0; k < 5; k++) D.box(w * 0.3, h + 2.3, -d * 0.07 + (k - 2) * 0.6, w * 0.25, 0.1, 0.12, C.DARKWOOD, 0xc8a070); }
          // outside stair to the roof
          for (let k = 0; k < 8; k++) D.box(w / 2 + 0.6, -0.3 + k * (h / 8), -d / 2 + 0.8 + k * 0.4, 1.0, 0.3 + h / 8, 0.42, C.PLAIN, col);
        } };
      }
      if (roll < 0.7) { // Caribbean clapboard cottage on a plinth with a front veranda and a hip roof
        const w = 8 + r() * 4, d = 8 + r() * 4, fl = r() < 0.75 ? 1 : 2, h = fl * 3 + 0.6, rise = w * (0.3 + r() * 0.12), seam = r() < 0.6, trim = 0xffffff;
        return { w, d: d + 2.6, h: h + rise, yard: true, garage: r() < 0.5 ? 1 : -1, door: 0, draw(S, D) {
          S.plinth(w, d, 0.6, C.CONCRETE, 0xe8e4dc);
          S.walls(w, d, -0.6, h, C.CLAP_WIN, wall, { door: C.CLAP_DOOR });
          for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) D.box(x * (w / 2 + 0.04), 0, z * (d / 2 + 0.04), 0.22, h, 0.22, C.TRIM, trim, { top: false });
          S.hip(w, d, h, rise, 0.6, seam ? C.SEAM : C.TILES, roof, { trimCol: trim });
          veranda(S, D, w, d, 2.4, { roofCell: seam ? C.SEAM : C.TILES, roofCol: roof, deck: 0.6, roofY: 3.0 });
          if (r() < 0.5) D.box(0, h + rise * 0.55, 0, 1.2, 0.8, 1.2, C.CLAP, wall); // little vent cupola
        } };
      }
      // Spanish colonial two-storey with iron balconies and a tiled hip roof
      const w = 9 + r() * 4, d = 9 + r() * 3, h = 6.4, rise = w * 0.28;
      return { w, d, h: h + rise, yard: true, garage: r() < 0.5 ? 1 : -1, door: 0, draw(S, D) {
        S.plinth(w, d, 0.5, C.STONE, 0xd0c8b8);
        S.walls(w, d, -1, 3.2, C.WIN_TALL, wall, { door: C.DOOR }); S.walls(w, d, 3.2, h, C.WIN_TALL, wall);
        D.box(0, 3.1, 0, w + 0.14, 0.22, d + 0.14, C.TRIM, 0xf4f2ec, { top: false });
        S.hip(w, d, h, rise, 0.7, C.TILES, 0xd0603e);
        const n = Math.max(1, Math.round(w / 3)), bw = w / n; for (let k = 0; k < n; k++) balcony(D, -w / 2 + k * bw + 0.4, -w / 2 + (k + 1) * bw - 0.4, d / 2, 0.6, 3.25, { rail: C.RAIL_IRON, railCol: 0x1e1e20, slab: C.CONCRETE, slabCol: 0xe8e4dc, brackets: false });
      } };
    },
    center: (r, P) => {
      const roll = r(), wall = pick(r, P.walls);
      if (roll < 0.3) { // resort hotel with balconies, a pool deck and loungers
        const w = 26 + r() * 16, d = 13, fl = 3 + Math.floor(r() * 4), h = fl * 3;
        return { w, d: d + 16, h: h + 1, kind: 'hotel', draw(S, D) {
          S.walls(w, d, -1, 3, C.GLASS, 0xffffff, { side: C.PLAIN });
          S.walls(w, d, 3, h + 0.8, C.BALCONY, wall, { side: C.PLAIN, back: C.APT });
          S.flat(w, d, h, 0.8, C.GRAVEL, 0xb4b2aa, C.PLAIN, 0xffffff);
          D.box(w * 0.2, h + 0.8, 0, 3, 2.2, 3, C.CONCRETE, 0xdddddd);
          for (let f = 1; f < fl; f++) { const n = Math.round(w / 3), bw = w / n; for (let k = 0; k < n; k++) balcony(D, -w / 2 + k * bw + 0.12, -w / 2 + (k + 1) * bw - 0.12, d / 2, 1.2, f * 3 + 0.05, { rail: C.RAIL_IRON, railCol: 0xf4f4f4, slab: C.CONCRETE, slabCol: 0xf0f0ec, brackets: false, sides: true }); }
          // pool deck in front
          S.box(0, -0.5, d / 2 + 8, w * 0.7, 0.62, 12, C.PAVERS, 0xf0ece4, { topCell: C.PAVERS, topCol: 0xf0ece4 });
          S.plainQuad([-w * 0.25, 0.1, d / 2 + 12], [w * 0.25, 0.1, d / 2 + 12], [w * 0.25, 0.1, d / 2 + 5], [-w * 0.25, 0.1, d / 2 + 5], C.POOL, 0xffffff);
          for (let k = 0; k < Math.round(w / 4); k++) { const x = -w * 0.32 + k * 4; D.box(x, 0.12, d / 2 + 3.6, 0.7, 0.35, 1.9, C.TRIM, 0xffffff); D.cyl(x + 1.4, d / 2 + 3.4, 0.1, 2.4, 0.04, 0.04, 4, C.METAL, 0xdddddd); D.cyl(x + 1.4, d / 2 + 3.4, 2.1, 2.6, 1.3, 0.05, 8, C.TRIM, pick(r, [0xf4f0e6, 0x2f8f8a, 0xe08a50])); }
        } };
      }
      if (roll < 0.7) { // arcaded shop / cafe with apartments above and a flat roof
        const w = 10 + r() * 6, d = 10 + r() * 4, two = r() < 0.6, h = two ? 6.6 : 4;
        return { w, d, h, kind: 'shop', draw(S, D) {
          S.walls(w, d, -1, 3.6, C.PLAIN, wall, { front: pick(r, [C.SHOP, C.SHOP2, C.SHOP3]) });
          if (two) S.walls(w, d, 3.6, h + 0.6, C.WIN_BLUE, wall); else S.walls(w, d, 3.6, h + 0.6, C.PLAIN, wall);
          S.flat(w, d, h, 0.6, C.CONCRETE, 0xeeeeee, C.PLAIN, wall);
          // arcade / colonnade
          D.box(0, 3.4, d / 2 + 1.6, w + 0.4, 0.4, 3.2, C.PLAIN, wall);
          for (let k = 0; k <= Math.round(w / 3); k++) D.box(-w / 2 + k * (w / Math.round(w / 3)), -0.3, d / 2 + 3, 0.4, 3.8, 0.4, C.PLAIN, 0xffffff, { top: false });
        } };
      }
      const w = 14 + r() * 8, d = 12, fl = 3, h = fl * 3; // pastel apartment block
      return { w, d, h: h + 3, kind: 'apartments', draw(S, D) { S.plinth(w, d, 0.4); S.walls(w, d, -1, 3, C.WIN, wall, { front: C.SHOP }); S.walls(w, d, 3, h, C.WIN_TALL, wall); S.hip(w, d, h, 3, 0.7, C.TILES, pick(r, P.roofs)); const n = Math.round(w / 3), bw = w / n; for (let f = 1; f < fl; f++) for (let k = 0; k < n; k++) balcony(D, -w / 2 + k * bw + 0.5, -w / 2 + (k + 1) * bw - 0.5, d / 2, 0.55, f * 3 + 0.05, { rail: C.RAIL_IRON, railCol: 0x222222, slab: C.CONCRETE, slabCol: 0xe8e4dc, brackets: false }); } };
    },
    barn: (r) => {
      const w = 10 + r() * 4, d = 14 + r() * 6, h = 5, col = pick(r, [0xc89060, 0xb8875a, 0xd8b080]);
      return { w, d, h: h + 4, draw(S) { S.walls(w, d, -1, h, C.BOARDS, col, { door: C.GARAGE }); S.gable(w, d, h, 3.6, 0.6, C.SEAM, 0x8a3a30, C.BOARDS, col, { gutter: false }); } };
    },
  },
  canyon: {
    house: (r, P) => {
      const wall = pick(r, P.walls), roll = r();
      if (roll < 0.5) { // pueblo revival adobe: flat roof, rounded parapet steps, vigas, canales, portal, kiva chimney
        const w = 9 + r() * 5, d = 8 + r() * 5, h = 3.4, up = r() < 0.45, portal = r() < 0.6;
        return { w, d: d + (portal ? 2.6 : 0), h: h + (up ? 3 : 0), yard: true, garage: r() < 0.5 ? 1 : -1, door: 0, draw(S, D) {
          S.walls(w, d, -1, h + 0.7, C.ADOBE_WIN, wall, { door: C.ADOBE_DOOR, front: pick(r, [C.ADOBE_WIN, C.ADOBE_WIN2]) });
          S.flat(w, d, h, 0.7, C.GRAVEL, 0xc8a882, C.ADOBE, wall);
          // stepped parapet bumps at the corners
          for (const [x, z] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) D.box(x * (w / 2 - 0.5), h + 0.7, z * (d / 2 - 0.5), 1.2, 0.35, 1.2, C.ADOBE, wall, { top: true });
          if (up) at(S, D, -w * 0.2, h, -d * 0.18, 0, () => { const w2 = w * 0.55, d2 = d * 0.6; S.walls(w2, d2, 0, 3.4, C.ADOBE_WIN, wall); S.flat(w2, d2, 2.8, 0.6, C.GRAVEL, 0xc8a882, C.ADOBE, wall); for (let k = 0; k < Math.floor(w2 / 1.4); k++) D.cyl(-w2 / 2 + 0.7 + k * 1.4, d2 / 2 + 0.35, 2.4, 2.4, 0.13, 0.13, 6, C.DARKWOOD, 0x7a5030); });
          // vigas: round beam ends poking out
          for (let k = 0; k < Math.floor(w / 1.4); k++) D.box(-w / 2 + 0.7 + k * 1.4, h - 0.58, d / 2 + 0.3, 0.26, 0.26, 0.7, C.DARKWOOD, 0x7a5030);
          // canales (roof drain spouts)
          for (const x of [-w * 0.3, w * 0.3]) D.box(x, h + 0.15, -d / 2 - 0.5, 0.3, 0.22, 1.0, C.DARKWOOD, 0x8a6040);
          // kiva chimney
          D.cyl(w / 2 - 0.9, -d / 2 + 0.9, h, h + 2.2, 0.55, 0.42, 10, C.ADOBE, wall, { cap: true, capCell: C.ADOBE });
          if (portal) { // portal: posts with corbels and a viga roof
            const z1 = d / 2 + 2.6; D.box(0, -0.4, (d / 2 + z1) / 2, w * 0.7, 0.5, 2.6, C.PAVERS, 0xd8b890);
            for (let k = 0; k <= 3; k++) { const x = -w * 0.35 + k * w * 0.7 / 3; D.box(x, 0, z1 - 0.15, 0.24, 2.8, 0.24, C.DARKWOOD, 0x8a6040, { top: false }); D.box(x, 2.6, z1 - 0.15, 0.9, 0.2, 0.26, C.DARKWOOD, 0x7a5030); }
            S.box(0, 2.8, (d / 2 + z1) / 2, w * 0.7 + 0.4, 0.3, 2.9, C.DARKWOOD, 0x7a5a40, { topCell: C.GRAVEL, topCol: 0xc8a882, bottom: true });
          }
        } };
      }
      // ranch house: long single storey, low hip roof, attached garage, porch
      const w = 14 + r() * 6, d = 8 + r() * 3, h = 3.2, roof = pick(r, P.roofs), skin = pick(r, [C.CLAP_WIN, C.BRICK_WIN, C.WIN, C.WIN]), col = skin === C.BRICK_WIN ? 0xffffff : pick(r, [0xf2ece0, 0xe8dcc8, 0xd8c8b0, 0xc8d4dc, 0xe8d8a8]);
      return { w: w + 3.6, d: d + 2.6, h: h + 2.5, yard: true, garage: 1, driveX: w / 2 + 3.2, door: -w * 0.15, draw(S, D) {
        S.plinth(w, d, 0.3);
        S.walls(w, d, -1, h, skin, col, { door: skin === C.CLAP_WIN ? C.CLAP_DOOR : C.DOOR, doorAt: 0.35 });
        S.hip(w, d, h, 2.2, 0.7, pick(r, [C.SHINGLE, C.DARKTILE, C.TILES]), roof);
        D.box(-w * 0.15, 2.6, d / 2 + 1.3, w * 0.5, 0.15, 2.6, C.SHINGLE, roof); for (const s of [-1, 0, 1]) D.box(-w * 0.15 + s * w * 0.24, -0.5, d / 2 + 2.4, 0.2, 3.1, 0.2, C.TRIM, 0xffffff, { top: false });
        garage(S, D, w, d, { wallCell: skin === C.BRICK_WIN ? C.BRICK : skin === C.CLAP_WIN ? C.CLAP : C.PLAIN, col, flatRoof: false, roofCell: C.SHINGLE, roofCol: roof, gw: 6.4 });
        // evaporative cooler on the roof
        D.box(w * 0.2, h + 1.1, -d * 0.1, 1.0, 0.9, 1.0, C.METAL, 0xb8bcc0);
      } };
    },
    center: (r, P) => {
      const roll = r(), wall = pick(r, P.walls);
      if (roll < 0.4) { // western storefront with false front + boardwalk awning
        const w = 9 + r() * 5, d = 12 + r() * 4, h = 4.2, two = r() < 0.4;
        return { w, d, h: h + 2, kind: 'shop', draw(S, D) {
          S.walls(w, d, -1, h, C.BOARDS, wall, { front: pick(r, [C.SHOP, C.SHOP3]) });
          if (two) S.walls(w, d, h, h + 3, C.CLAP_WIN, wall, { side: C.CLAP, back: C.CLAP });
          const hh = two ? h + 3 : h;
          S.gable(w, d, hh, 1.5, 0.2, C.SEAM, 0x8a8e94, C.BOARDS, wall, { gutter: false });
          S.box(0, hh, d / 2 - 0.15, w, 2.4, 0.3, C.CLAP, wall); D.box(0, hh + 2.4, d / 2 - 0.15, w + 0.3, 0.25, 0.5, C.TRIM, 0xf0ece0);
          D.box(0, 3.0, d / 2 + 1.4, w, 0.15, 2.8, C.SEAM, 0x8a7a6a); for (const s of [-1, 0, 1]) D.box(s * (w / 2 - 0.2), -0.5, d / 2 + 2.6, 0.2, 3.5, 0.2, C.DARKWOOD, 0xffffff, { top: false });
          D.box(0, -0.4, d / 2 + 1.4, w, 0.55, 2.8, C.DARKWOOD, 0xd8c0a0);
          if (two) balcony(D, -w / 2, w / 2, d / 2 + 1.4, 1.4, 3.15, { rail: C.RAIL_IRON, railCol: 0xf0ece0, slab: C.DARKWOOD, slabCol: 0xd8c0a0, brackets: false, sides: false });
        } };
      }
      if (roll < 0.7) { // two-storey adobe block
        const w = 14 + r() * 8, d = 12 + r() * 3, h = 6.4;
        return { w, d, h, kind: 'shop', draw(S, D) { S.walls(w, d, -1, 3.2, C.ADOBE_WIN, wall, { front: pick(r, [C.SHOP, C.SHOP2]) }); S.walls(w, d, 3.2, h + 0.7, C.ADOBE_WIN2, wall); S.flat(w, d, h, 0.7, C.GRAVEL, 0xc8a882, C.ADOBE, wall); for (let k = 0; k < Math.floor(w / 1.6); k++) D.box(-w / 2 + 0.8 + k * 1.6, h - 0.5, d / 2 + 0.3, 0.26, 0.26, 0.8, C.DARKWOOD, 0x7a5030); balcony(D, -w / 2 + 1, w / 2 - 1, d / 2, 1.6, 3.25, { rail: C.RAIL_IRON, railCol: 0x8a6040, slab: C.DARKWOOD, slabCol: 0xa07850 }); for (let k = 0; k <= 3; k++) D.box(-w / 2 + 1 + k * (w - 2) / 3, -0.4, d / 2 + 1.45, 0.22, 3.6, 0.22, C.DARKWOOD, 0x8a6040, { top: false }); } };
      }
      // motel: long, one storey, doors in a row, walkway canopy, neon sign on a pole
      const w = 30 + r() * 12, d = 9, h = 3.2;
      return { w, d, h: h + 6, kind: 'motel', draw(S, D) {
        S.walls(w, d, -1, h + 0.5, C.WIN, wall, { front: C.DOOR, back: C.WIN }); S.flat(w, d, h, 0.5, C.GRAVEL, 0xa89a88, C.PLAIN, wall);
        D.box(0, 2.7, d / 2 + 1, w, 0.15, 2, C.SEAM, 0x2f8a8a); for (let k = 0; k <= Math.round(w / 6); k++) D.box(-w / 2 + k * (w / Math.round(w / 6)), -0.4, d / 2 + 1.9, 0.14, 3.1, 0.14, C.METAL, 0xdddddd, { top: false });
        D.box(0, -0.4, d / 2 + 1, w, 0.5, 2, C.CONCRETE, 0xc8c4bc);
        D.box(w / 2 + 2, -0.5, d / 2 + 2, 0.4, 8, 0.4, C.METAL, 0x888888, { top: false });
        D.box(w / 2 + 2, 6.0, d / 2 + 2, 0.4, 3.4, 3.4, C.NEON, 0xffffff);
        // ice machine + vending
        D.box(-w / 2 - 0.8, -0.4, d / 2 - 1, 1.2, 2.0, 0.9, C.METAL, 0xd8d8d8);
      } };
    },
    barn: (r) => {
      const w = 12 + r() * 5, d = 18 + r() * 8, h = 6, col = pick(r, [0xb04a32, 0xa0402c, 0x8a3a24]);
      return { w, d, h: h + 5, draw(S, D) {
        S.walls(w, d, -1, h, C.BOARDS, col, { front: C.BOARDS });
        S.gable(w, d, h, 3.2, 0.4, C.SEAM, 0x6a6e74, C.BOARDS, col, { gutter: false });
        D.box(0, 0, d / 2 + 0.05, 4.4, 4.4, 0.1, C.BOARDS, 0xf0ece4, { top: false });
      } };
    },
    waterTower: () => ({ w: 10, d: 10, h: 30, draw(S, D) {
      for (const [x, z] of [[-3, -3], [3, -3], [3, 3], [-3, 3]]) S.box(x, -0.5, z, 0.5, 21, 0.5, C.METAL, 0x9a9a9a, { top: false });
      D.box(0, 10, 0, 6.5, 0.2, 0.2, C.METAL, 0x9a9a9a); D.box(0, 10, 0, 0.2, 0.2, 6.5, C.METAL, 0x9a9a9a);
      S.cyl(0, 0, 20, 27, 4.6, 4.6, 16, C.SEAM, 0xeeeeee, {}); S.cyl(0, 0, 19, 20, 1.5, 4.6, 16, C.SEAM, 0xd8d8d8); S.cyl(0, 0, 27, 29.6, 4.9, 0.3, 16, C.SEAM, 0xc84030);
      S.cyl(0, 0, 23.2, 24.6, 4.62, 4.62, 16, C.PLAIN, 0x2f6fa8);
      D.cyl(0, 0, 20, 20.15, 5.3, 5.3, 16, C.METAL, 0x777777);
    } }),
    gasStation: () => ({ w: 26, d: 22, h: 6, kind: 'gas', draw(S, D) {
      at(S, D, 0, 0, -6, 0, () => { S.walls(14, 9, -1, 4.2, C.PLAIN, 0xf4f4f0, { front: C.SHOP3 }); S.flat(14, 9, 3.8, 0.4, C.GRAVEL, 0xffffff, C.PLAIN, 0xf4f4f0); });
      S.box(0, 5, 5, 20, 1.0, 10, C.PLAIN, 0xc8282e, { topCell: C.PLAIN, topCol: 0xf0f0f0, bottom: true });
      S.plainQuad([-12, 0.06, 12], [12, 0.06, 12], [12, 0.06, -1], [-12, 0.06, -1], C.CONCRETE, 0xb0aca4);
      for (const x of [-6, 6]) { S.box(x, -0.4, 5, 0.6, 5.4, 0.6, C.PLAIN, 0xf0f0f0, { top: false }); D.box(x, 0, 5, 1.0, 1.7, 2.8, C.PLAIN, 0xf8f8f8); D.box(x, 1.5, 5, 1.04, 0.3, 2.84, C.PLAIN, 0xc8282e); D.box(x, -0.2, 5, 1.6, 0.25, 4.6, C.CONCRETE, 0xd8d8d0); }
      D.box(13, -0.4, 10, 0.4, 9, 0.4, C.METAL, 0x888888, { top: false }); D.box(13, 7.5, 10, 0.5, 2.6, 2.6, C.PLAIN, 0xc8282e);
    } }),
  },
};
