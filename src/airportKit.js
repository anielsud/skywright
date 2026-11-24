// The airfield's furniture: the things that stand up out of the grass around the runways (#227 phase 1).
// Light fixtures you can see by day (runway edge, threshold/end, taxiway edge), the approach light system on its
// stands out over the grass, PAPI housings, taxiway and runway signs (hold, location, direction, distance remaining),
// the ILS localizer arrays past the far ends and the glideslope masts. Everything solid goes into the airport's
// merged building geometry (World.buildAirport's Builder: no extra draw calls); the sign faces are one more mesh
// with their own small canvas atlas, lit at night like the terminal's name board (same material features, so no
// new shader). Night glow points are returned for World.lightsMat (the fixed light set, #99).
//
// Airport coordinates: runways along z at x = RUNWAYS[i].x, 1800 m long, thresholds of the 36s at z = +900 (they
// take off towards -z), the parallel taxiway at x 62..98, the apron east of it. World.buildAirport places all this
// at y = loc.rwyH.
import * as THREE from 'three';
import { C } from './buildings.js';

// where the airport's landside road leaves its no-go box (roads.js routes the rest of the way to the road network;
// the ground along the road is held at runway height out to here). Bora Bora's field is on a reef islet: no road.
export const AIRPORT_GATE = { x: 570, z: 120, heading: Math.PI / 2 };
export function airportGate(loc) {
  if (!loc || loc.id === 'islands') return null;
  return { x: AIRPORT_GATE.x, z: AIRPORT_GATE.z, h: loc.rwyH, heading: AIRPORT_GATE.heading };
}

// the taxiway connectors (World.buildRunway paves them): z of each, and its letter
export const CONNECTORS = [{ z: 880, name: 'B' }, { z: 0, name: 'C' }, { z: -880, name: 'D' }];
export const TAXI = { x0: 62, x1: 98, name: 'A' };
// how far the approach lights, localizers and glideslope masts reach (other sites keep clear: launchpad.js)
// rows at HALF + start + k * step: clear of the 30 m overrun, and inside the box real places' buildings and the road
// network keep clear of (realBuildings.js, roads.js: |x - 100| < 470, |z| < 1250)
export const ALS = { start: 15, rows: 10, step: 30, half: 15, wide: 9 };
export const LOC_Z = 200; // localizer array this far past the far end
const FT = 0.3048;

// ---------------- signs ----------------
const SIGN_H = 1.0, PX = 96; // face height (m), atlas pixels per metre
const STYLE = {
  hold: { bg: '#c51f2a', fg: '#ffffff', border: '#ffffff' },
  loc: { bg: '#141414', fg: '#f2c318', border: '#f2c318' },
  dir: { bg: '#f2c318', fg: '#141414', border: null },
  dist: { bg: '#141414', fg: '#ffffff', border: null },
  info: { bg: '#1f4f9a', fg: '#ffffff', border: null }, // terminal wayfinding (departures, gates)
};
// one sign face: a list of panels side by side, each [kind, text]
function faceWidth(panels, g) {
  let w = 0;
  for (const [, t] of panels) { const m = g?.measureText?.(t)?.width; w += Math.max(0.9, ((m > 0 ? m : t.length * 0.62 * PX * 0.62) / PX) + 0.5); }
  return w;
}
class SignAtlas {
  constructor() { this.faces = []; }
  add(panels) { this.faces.push({ panels }); return this.faces.length - 1; }
  draw() {
    const W = 2048, c = document.createElement('canvas'); c.width = W; const g = c.getContext('2d');
    const font = `bold ${Math.round(PX * 0.62)}px Arial, Helvetica, sans-serif`; if (g) g.font = font;
    let x = 0, y = 0;
    for (const f of this.faces) { f.w = faceWidth(f.panels, g); const wp = Math.ceil(f.w * PX) + 4; if (x + wp > W) { x = 0; y += PX + 4; } f.px = x + 2; f.py = y + 2; x += wp; }
    c.height = THREE.MathUtils.ceilPowerOfTwo(Math.max(64, y + PX + 4));
    if (g?.fillRect) {
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const f of this.faces) {
        let px = f.px;
        for (const [kind, t] of f.panels) {
          const s = STYLE[kind], m = g.measureText(t)?.width || t.length * PX * 0.38, w = Math.max(0.9 * PX, m + 0.5 * PX);
          g.fillStyle = s.bg; g.fillRect(px, f.py, w, PX);
          if (s.border) { g.strokeStyle = s.border; g.lineWidth = PX * 0.05; g.strokeRect(px + PX * 0.09, f.py + PX * 0.09, w - PX * 0.18, PX * 0.82); }
          g.fillStyle = s.fg; g.fillText(t, px + w / 2, f.py + PX * 0.53);
          px += w;
        }
        f.w = (px - f.px) / PX;
      }
    }
    this.canvas = c;
    for (const f of this.faces) f.uv = [f.px / W, 1 - (f.py + PX) / c.height, (f.px + f.w * PX) / W, 1 - f.py / c.height];
  }
}

// ---------------- the kit ----------------
// A: the airport's Builder (frame reset per piece), y: runway height, world: for ground heights and runway names.
// extra: more signs for the same mesh (the terminal's: airportBuildings.js), each { x, z, yaw, front, back?, base (m above
// y: the face's bottom), h (face height, m), frame: false (mounted on a wall: no box or legs) }.
// Returns { points: [[x, y, z, hexColour], ...] glow points for the night lights, signs: Mesh, solids: [{ x, z, hx, hz }]
// (footprints, axis-aligned half sizes) }.
export function buildAirfieldKit(world, A, y, extra = []) {
  const pts = [], solids = [];
  const RW = world.runways, RWY_W = RW[0].width, HALF = RW[0].len / 2;
  const ground = (x, z) => Math.max(world.heightAt(x, z), world.waterLevel ?? -Infinity);
  const P = (x, yy, z, col) => pts.push([x, yy, z, col]);
  A.setFrame(0, y, 0, 0); A.seed = 11;

  // light fixture: a short yellow frangible stem and a glass head (the head's tint is the light's colour)
  const fixture = (x, z, head, h = 0.36) => {
    A.cyl(x, z, -0.05, h - 0.12, 0.05, 0.05, 5, C.PLAIN, 0xd8b020);
    A.cyl(x, z, h - 0.12, h, 0.11, 0.09, 6, C.PLAIN, head, { cap: true });
  };
  for (const r of RW) {
    for (let z = -HALF; z <= HALF + 0.1; z += 60) for (const s of [-1, 1]) fixture(r.x + s * (RWY_W / 2 + 1), z, 0xf4ecd0);
    for (let x = -RWY_W / 2; x <= RWY_W / 2 + 0.1; x += 4) for (const s of [-1, 1]) fixture(r.x + x, s * (HALF + 2), 0xc8e0c0, 0.3); // threshold / end bars
  }
  // taxiway edge lights (blue), on the runway side only: the east edge is the apron's
  for (let z = -HALF; z <= HALF; z += 40) if (!CONNECTORS.some((c) => Math.abs(z - c.z) < 16)) fixture(TAXI.x0, z, 0x5a86e0);
  for (const c of CONNECTORS) for (const s of [-1, 1]) for (let x = RWY_W / 2 + 8; x < TAXI.x0; x += 14) fixture(x, c.z + s * 12, 0x5a86e0);

  // approach light system: ten rows of five lamps on crossbars, every 30 m out from each 36 threshold, the
  // ninth (~285 m) a wide crossbar. Lamps stay level with the runway unless the ground rises above them.
  for (const r of RW) {
    for (let k = 1; k <= ALS.rows; k++) {
      const z = HALF + ALS.start + k * ALS.step, wide = k === ALS.wide, half = wide ? 15 : 8, g = Math.min(ground(r.x - half, z), ground(r.x, z), ground(r.x + half, z));
      const ly = Math.max(y + 0.9 + k * 0.15, Math.max(ground(r.x - half, z), ground(r.x, z), ground(r.x + half, z)) + 0.7) - y;
      const foot = g - y - 0.4;
      for (const px of wide ? [-12, 0, 12] : [0]) A.box(r.x + px, foot, z, 0.32, ly - foot - 0.1, 0.32, C.PLAIN, 0xe4e0d4);
      A.box(r.x, ly - 0.24, z, half * 2 + 0.5, 0.24, 0.24, C.PLAIN, 0xd0d2d4);
      for (let x = -half; x <= half + 0.1; x += wide ? 2.5 : 4) { A.box(r.x + x, ly - 0.04, z, 0.5, 0.36, 0.42, C.PLAIN, 0xf0f0ea); P(r.x + x, y + ly + 0.1, z, 0xffffff); }
      solids.push({ x: r.x, z, hx: half, hz: 0.3 });
    }
  }

  // PAPI housings: four boxes on short legs, lenses towards the approach (the glow points are World.papi's)
  for (let k = 0; k < 4; k++) {
    const x = RW[0].x - RWY_W / 2 - 12 - k * 9, z = HALF - 300;
    for (const dx of [-0.5, 0.5]) A.box(x + dx, -0.05, z, 0.12, 0.6, 0.12, C.PLAIN, 0xd8b020);
    A.box(x, 0.5, z + 0.2, 1.5, 0.8, 1.1, C.PLAIN, 0x3a3c40);
    A.box(x, 0.62, z + 0.78, 1.2, 0.5, 0.06, C.PLAIN, 0x141416);
  }

  // ILS: localizer arrays past each runway's far end, glideslope masts beside the touchdown zones
  for (const r of RW) {
    const z = -HALF - LOC_Z, g = ground(r.x, z) - y;
    A.box(r.x, g - 0.3, z, 26, 0.3 + 0.3, 2, C.CONCRETE, 0xb8b4ac);
    for (let x = -12; x <= 12.1; x += 4) A.box(r.x + x, g, z, 0.14, 2.4, 0.14, C.METAL, 0xb8bcc0);
    A.box(r.x, g + 2.4, z, 25, 0.16, 0.16, C.METAL, 0xb8bcc0);
    for (let x = -12; x <= 12.1; x += 1.85) { A.box(r.x + x, g + 2.55, z, 0.07, 1.1, 0.07, C.PLAIN, 0xe8e8e8); A.box(r.x + x, g + 3.1, z, 0.9, 0.06, 0.06, C.PLAIN, 0xe8e8e8); }
    A.box(r.x + 18, g, z + 6, 3, 2.6, 2.4, C.METAL, 0xe4e0d6, { topCell: C.SEAM, topCol: 0x9a9ea4 });
    P(r.x - 12.5, y + g + 3.4, z, 0xff3020); P(r.x + 12.5, y + g + 3.4, z, 0xff3020);
    solids.push({ x: r.x + 3, z, hx: 16, hz: 7 });
    // glideslope: a mast with three antennas, 80 m to the left of the centreline (clear of the PAPI)
    const gx = r.x - 80, gz = HALF - 260, gg = ground(gx, gz) - y;
    A.box(gx, gg - 0.2, gz, 1.2, 14.2, 1.2, C.RAIL_IRON, 0xc8282e);
    for (const h of [4.5, 8, 11.5]) A.box(gx, gg + h, gz + 0.8, 1.4, 0.5, 0.5, C.PLAIN, 0xe8e8e8);
    A.box(gx + 4, gg, gz, 2.6, 2.4, 2.2, C.METAL, 0xe4e0d6, { topCell: C.SEAM, topCol: 0x9a9ea4 });
    P(gx, y + gg + 14.4, gz, 0xff3020);
    solids.push({ x: gx + 2, z: gz, hx: 4, hz: 1.5 });
  }

  // ---- signs ----
  const atlas = new SignAtlas(), signs = [];
  // a sign at (x, z) facing (nx, nz), front panels, optional back panels
  const sign = (x, z, nx, nz, front, back = null) => signs.push({ x, z, yaw: Math.atan2(nx, nz), front: atlas.add(front), back: back ? atlas.add(back) : -1 });
  const pair = (r) => `${r.name}-${r.back}`;
  const [R0, R1] = RW;
  for (const c of CONNECTORS) {
    // taxiing west on the connector towards the near runway: hold sign + location sign on the left (+z side)
    sign(RWY_W / 2 + 14, c.z + 17, 1, 0, [['loc', c.name], ['hold', pair(R0)]], R1 ? [['hold', pair(R0)]] : null);
    // and from between the runways towards the far one
    if (R1) sign(R1.x + RWY_W / 2 + 14, c.z + 17, 1, 0, [['loc', c.name], ['hold', pair(R1)]]);
    if (R1) sign(R0.x - RWY_W / 2 - 14, c.z - 17, -1, 0, [['hold', pair(R0)], ['loc', c.name]]);
    // on the parallel taxiway, before each connector from both directions (direction signs: the connector is west)
    sign(TAXI.x0 - 6, c.z + 24, 0, 1, [['loc', TAXI.name], ['dir', `←${c.name}`]]);
    sign(TAXI.x0 - 6, c.z - 24, 0, -1, [['dir', `${c.name}→`], ['loc', TAXI.name]]);
  }
  // distance remaining (thousands of feet), left of each runway taking off towards -z, back faces for the other way
  for (const r of RW) {
    const total = r.len / FT / 1000;
    for (let k = 1; k < total; k++) {
      const z = -HALF + k * 1000 * FT, back = Math.round(total - k);
      if (back < 1) continue;
      sign(r.x - RWY_W / 2 - 18, z, 0, 1, [['dist', String(k)]], [['dist', String(back)]]);
    }
  }
  for (const e of extra) signs.push({ ...e, front: atlas.add(e.front), back: e.back ? atlas.add(e.back) : -1 });
  atlas.draw();
  // frames, legs and faces
  const pos = [], nor = [], uv = [];
  const quad = (fr, f, s) => { // a face quad on the sign's front (s = 1) or back (s = -1)
    const H = fr.h || SIGN_H, F = atlas.faces[f], hw = F.w * H / 2, zf = s * (fr.frame === false ? 0.04 : 0.16), [u0, v0, u1, v1] = F.uv, cs = Math.cos(fr.yaw), sn = Math.sin(fr.yaw);
    const W = (lx, ly) => [fr.x + lx * cs + zf * sn, y + fr.base + ly, fr.z - lx * sn + zf * cs];
    const a = W(-hw * s, 0), b = W(hw * s, 0), c = W(hw * s, H), d = W(-hw * s, H), n = [s * sn, 0, s * cs];
    const ua = s > 0 ? [u0, v0, u1, v0, u1, v1, u0, v1] : [u0, v0, u1, v0, u1, v1, u0, v1];
    for (const [p, i] of [[a, 0], [b, 1], [c, 2], [a, 0], [c, 2], [d, 3]]) { pos.push(...p); nor.push(...n); uv.push(ua[i * 2], ua[i * 2 + 1]); }
  };
  for (const s of signs) {
    if (s.frame === false) { quad(s, s.front, 1); if (s.back >= 0) quad(s, s.back, -1); continue; } // (on a wall: the building is its frame)
    const w = Math.max(atlas.faces[s.front].w, s.back >= 0 ? atlas.faces[s.back].w : 0);
    s.base = ground(s.x, s.z) - y + 0.45;
    A.setFrame(s.x, y, s.z, s.yaw);
    A.box(0, s.base - 0.06, 0, w + 0.16, SIGN_H + 0.12, 0.3, C.PLAIN, 0x3a3c40);
    for (const lx of [-w / 2 + 0.3, w / 2 - 0.3]) A.box(lx, s.base - 0.5, 0, 0.1, 0.5, 0.1, C.PLAIN, 0xd8b020);
    quad(s, s.front, 1); if (s.back >= 0) quad(s, s.back, -1);
    solids.push({ x: s.x, z: s.z, hx: Math.abs(Math.cos(s.yaw)) * w / 2 + 0.2, hz: Math.abs(Math.sin(s.yaw)) * w / 2 + 0.2 });
  }
  A.setFrame(0, y, 0, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const tex = new THREE.CanvasTexture(atlas.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  // (same features as the terminal's name board, map + emissiveMap: shares its shader program)
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0x3a3a3a, emissiveMap: tex, emissiveIntensity: 0 });
  const mesh = new THREE.Mesh(geo, mat); mesh.name = 'airport signs';
  return { points: pts, signs: mesh, signMat: mat, solids, nSigns: signs.length };
}
