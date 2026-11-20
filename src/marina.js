// Marinas: where boats start. Every real location with suitable water has one (loc.marina in realworld.js gives where to
// look and how big the waves are; the spot itself is found from the water and shoreline data, the layout from a fixed
// seed, so a marina is always in the same place and looks the same).
//
// On a sea or a lake (findShore): a stretch of shore with deep water in front of it (at least ~2.5 m under the docks,
// clear water 450 m out for a channel), low, gently sloping land behind it for the boathouse, and no buildings, bridges
// or airport in the way. It gets a main pier on pilings out from the shore with finger piers and boats moored in the
// slips, a T-head fuel dock with pumps and a kiosk, a boathouse with a slipway, lamp posts, red and green buoys marking
// the channel out, and mooring buoys with boats on them.
// On a river high above the world's water level (the Colorado, findRiver): a flat, wide, deep enough reach with a low
// bank: a smaller landing, a dock along the bank with a boat ramp, a fuel pump, a boat shed, boats tied up alongside,
// buoys up and down the channel.
//
// Boats start afloat at the channel's mouth, facing open water (start). The docks, piers and ramps are solid for
// everything that drives or floats (collide.js: one CollisionMesh, like the stunt park's), so cars can drive out onto
// the piers. Drawn as one merged mesh on the world's building material (one draw call), the moored boats as one mesh
// per material (all of them merged), lamps on the world's night-lights points: no new shaders.
import * as THREE from 'three';
import { Builder, C } from './buildings.js';
import { CollisionMesh } from './collide.js';
import { mulberry32, clamp } from './noise.js';
import { makePresets, analyze } from './design.js';
import { buildStatic, mergeByMaterial } from './traffic.js';

const DECK = 0.9; // pier decks above the water (fixed piers on pilings)
const UP = new THREE.Vector3(0, 1, 0);

export class Marina {
  // cfg: loc.marina ({ at: [x, z] (where to look), r (how far), river (on a real river), waves (swell, m), seed })
  static create(world, cfg) {
    try {
      const site = cfg.river ? findRiver(world, cfg) : findShore(world, cfg);
      return site ? new Marina(world, cfg, site) : null;
    } catch (e) { console.warn('marina', e); return null; }
  }
  constructor(world, cfg, site) {
    this.world = world; this.cfg = cfg; this.site = site; this.river = !!cfg.river;
    this.x = site.x; this.z = site.z; this.wl = site.wl;
    const s = site.s; this.yaw = Math.atan2(s.x, s.z); this.cs = Math.cos(this.yaw); this.sn = Math.sin(this.yaw); // local +z: out over the water
    this.rnd = mulberry32((cfg.seed ?? 77) + Math.round(site.x) * 7 + Math.round(site.z) * 13);
    this.cm = new CollisionMesh(4); this.solids = []; this.lamps = []; this.lampCol = []; this.moored = [];
    this.group = new THREE.Group(); this.group.name = 'marina'; world.group.add(this.group);
    if (this.river) this.buildRiver(); else this.buildHarbour();
    this.cm.build();
    this.buildBoats();
    const m = new THREE.Mesh(this.A.toGeometry(), world.windowMats[0]); m.castShadow = m.receiveShadow = true; this.group.add(m); this.A = null;
    if (this.lamps.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.lamps, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(this.lampCol, 3));
      this.group.add(new THREE.Points(g, world.lightsMat));
    }
    // nothing grows on the boathouse's patch or the pier roots
    const F = world.flora, bare = F?.bare; if (F) F.setForestMask(F.mask, (x, z) => this.bare(x, z) || (bare ? bare(x, z) : false));
  }
  // local (x along the shore, z out over the water) <-> world
  W(lx, lz, y = 0) { return new THREE.Vector3(this.x + lx * this.cs + lz * this.sn, y, this.z - lx * this.sn + lz * this.cs); }
  L(x, z) { const dx = x - this.x, dz = z - this.z; return [dx * this.cs - dz * this.sn, dx * this.sn + dz * this.cs]; }
  ground(lx, lz) { const p = this.W(lx, lz); return this.world.heightAt(p.x, p.z); }
  water(lx, lz) { if (!this.river) return this.wl; const p = this.W(lx, lz); return this.world.real?.waterAt(p.x, p.z, 30) ?? this.wl; }
  bare(x, z) { const [lx, lz] = this.L(x, z); return lx > this.foot[0] && lx < this.foot[1] && lz > this.foot[2] && lz < this.foot[3]; }
  topAt(x, z) { return this.cm.topAt(x, z); }
  hit(p) {
    const dx = p.x - this.x, dz = p.z - this.z; if (dx * dx + dz * dz > 120 * 120) return null;
    const [lx, lz] = this.L(p.x, p.z);
    for (const s of this.solids) if (Math.abs(lx - s.lx) < s.hx && Math.abs(lz - s.lz) < s.hz && p.y > s.y0 && p.y < s.y1) { const w = this.W(s.lx, s.lz), t = [w.x, s.y0, w.z, s.y1 - s.y0, Math.max(s.hx, s.hz)]; t.solid = true; return t; }
    return null;
  }

  // ---------- building blocks (local frame) ----------
  // a deck: a box from (x0, z0) to (x1, z1), top at y (absolute), drawn and solid
  deck(x0, x1, z0, z1, y, { th = 0.35, cell = C.TRIM, col = 0xc4a27a, side = 0x7a6450 } = {}) {
    const A = this.A; A.setFrame(this.x, 0, this.z, this.yaw);
    A.plainQuad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], cell, col);
    for (const [a, b] of [[[x0, z1], [x1, z1]], [[x1, z1], [x1, z0]], [[x1, z0], [x0, z0]], [[x0, z0], [x0, z1]]]) A.plainQuad([a[0], y - th, a[1]], [b[0], y - th, b[1]], [b[0], y, b[1]], [a[0], y, a[1]], C.DARKWOOD, side);
    this.box(x0, x1, z0, z1, y - th, y);
  }
  // a solid box in the collision mesh: faces outward, the top drives like a road
  box(x0, x1, z0, z1, y0, y1) {
    const P = (x, y, z) => this.W(x, z, y), c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const face = (a, b, cc, d, out, depth) => { const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(cc, a)); if (n.dot(out) < 0) { this.cm.tri(a, cc, b, 0, depth); this.cm.tri(a, d, cc, 0, depth); } else { this.cm.tri(a, b, cc, 0, depth); this.cm.tri(a, cc, d, 0, depth); } };
    face(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), UP, Math.min(1.2, y1 - y0 + 0.6));
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4], mid = this.W((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), ctr = this.W((x0 + x1) / 2, (z0 + z1) / 2), out = mid.sub(ctr).setY(0).normalize();
      face(P(a[0], y0, a[1]), P(b[0], y0, b[1]), P(b[0], y1, b[1]), P(a[0], y1, a[1]), out, Math.min(1.5, Math.abs(k % 2 ? x1 - x0 : z1 - z0) / 2));
    }
  }
  // a sloping ramp from (z0, y0) up to (z1, y1), x0..x1 wide (drawn and drivable)
  ramp(x0, x1, z0, y0, z1, y1, cell = C.CONCRETE, col = 0xb0aca4) {
    const A = this.A; A.setFrame(this.x, 0, this.z, this.yaw);
    A.plainQuad([x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0], cell, col);
    const yl = Math.min(y0, y1) - 1.2; A.plainQuad([x0, yl, z0], [x0, yl, z1], [x0, y1, z1], [x0, y0, z0], cell, 0x8a8680); A.plainQuad([x1, yl, z1], [x1, yl, z0], [x1, y0, z0], [x1, y1, z1], cell, 0x8a8680); // the sides
    const a = this.W(x0, z0, y0), b = this.W(x1, z0, y0), c = this.W(x1, z1, y1), d = this.W(x0, z1, y1), n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.y < 0) { this.cm.tri(a, c, b, 0, 1.2); this.cm.tri(a, d, c, 0, 1.2); } else { this.cm.tri(a, b, c, 0, 1.2); this.cm.tri(a, c, d, 0, 1.2); }
  }
  pile(lx, lz, top) {
    const bed = Math.min(this.ground(lx, lz), this.water(lx, lz) - 3) - 0.5, A = this.A, p = this.W(lx, lz);
    A.setFrame(p.x, 0, p.z, this.yaw); A.cyl(0, 0, bed, top + 0.15, 0.17, 0.15, 6, C.DARKWOOD, 0x5a4634, { cap: true });
  }
  lamp(lx, lz, y, col = [1, 0.85, 0.6]) {
    const A = this.A, p = this.W(lx, lz); A.setFrame(p.x, 0, p.z, this.yaw);
    A.cyl(0, 0, y - 0.05, y + 3.6, 0.07, 0.06, 6, C.METAL, 0x30343a); A.box(0, y + 3.6, 0.25, 0.22, 0.12, 0.6, C.METAL, 0x30343a, { bottom: true });
    this.lamps.push(p.x, y + 3.55, p.z + 0); this.lampCol.push(...col);
  }
  buoy(lx, lz, kind) {
    const A = this.A, p = this.W(lx, lz), y = this.water(lx, lz), col = { red: 0xc8261e, green: 0x2a8a3a, yellow: 0xf2c20a, white: 0xf2f2ee }[kind];
    A.setFrame(p.x, 0, p.z, this.yaw);
    if (kind === 'white') { A.dome(0, 0, y - 0.25, 0.55, 12, 4, C.PLAIN, col); A.cyl(0, 0, y - 0.6, y - 0.24, 0.5, 0.55, 12, C.PLAIN, col); return; }
    A.cyl(0, 0, y - 0.6, y + 0.5, 0.55, 0.5, 12, C.PLAIN, col, { cap: true }); // float
    if (kind === 'red') A.cyl(0, 0, y + 0.5, y + 1.7, 0.42, 0.04, 12, C.PLAIN, col); else A.cyl(0, 0, y + 0.5, y + 1.5, 0.36, 0.36, 12, C.PLAIN, col, { cap: true }); // nun / can
    A.cyl(0, 0, y + 0.25, y + 0.4, 0.57, 0.57, 12, C.PLAIN, 0xf2f2ee);
    if (kind !== 'yellow') { this.lamps.push(p.x, y + 1.9, p.z); this.lampCol.push(...(kind === 'red' ? [1, 0.1, 0.08] : [0.1, 1, 0.2])); }
  }
  // a boathouse on the land at (lx, lz), w along the shore, d deep, its big door facing the water
  boathouse(lx, lz, w, d, h) {
    const A = this.A, p = this.W(lx, lz);
    let base = Infinity; for (const i of [-1, 1]) for (const j of [-1, 1]) base = Math.min(base, this.ground(lx + i * w / 2, lz + j * d / 2));
    base = Math.max(base, this.water(lx, lz) + 0.4);
    A.setFrame(p.x, base, p.z, this.yaw);
    A.plinth(w, d, 0.5);
    A.walls(w, d, 0, h, C.CLAP, 0xd8d0c0, { front: C.HANGAR_DOOR, door: C.HANGAR_DOOR, side: C.CLAP_WIN });
    A.gable(w, d, h, w * 0.32, 0.5, C.SEAM, 0x2e5a7a, C.CLAP, 0xd8d0c0);
    this.solids.push({ lx, lz, hx: w / 2 + 0.3, hz: d / 2 + 0.3, y0: base - 1, y1: base + h + w * 0.32 });
    return base;
  }

  // ---------- a harbour on a sea or lake ----------
  buildHarbour() {
    const A = (this.A = new Builder()), wl = this.wl, y = wl + DECK, R = this.rnd, Lp = this.site.len;
    // main pier: from a ramp on the land out to the T-head
    const land = this.ground(0, -9), rootY = Math.max(land + 0.05, wl + 0.35);
    this.ramp(-1.6, 1.6, -14, Math.max(this.ground(0, -14) + 0.03, wl + 0.3), -4, y);
    this.deck(-1.6, 1.6, -4, Lp, y);
    for (let z = -2; z <= Lp; z += 4) for (const x of [-1.45, 1.45]) this.pile(x, z, y - 0.3);
    // finger piers both sides, every 11 m, with slips between them
    const fingers = []; for (let z = 10; z < Lp - 6; z += 11) fingers.push(z);
    for (const z of fingers) for (const sx of [-1, 1]) {
      this.deck(sx > 0 ? 1.6 : -13, sx > 0 ? 13 : -1.6, z - 0.6, z + 0.6, y - 0.1, { th: 0.25 });
      this.pile(sx * 12.7, z, y - 0.35); this.pile(sx * 7, z, y - 0.35);
    }
    this.slips = [];
    for (let i = 0; i + 1 < fingers.length; i++) for (const sx of [-1, 1]) this.slips.push({ lx: sx * 7.5, lz: (fingers[i] + fingers[i + 1]) / 2, yaw: sx > 0 ? -Math.PI / 2 : Math.PI / 2 }); // bow in to the pier
    // T-head fuel dock: pumps, a kiosk, a lamp at each end
    const T0 = Lp, T1 = Lp + 4.5;
    this.deck(-15, 15, T0, T1, y, { col: 0xd0b088 });
    for (let x = -14; x <= 14; x += 4) for (const z of [T0 + 0.3, T1 - 0.3]) this.pile(x, z, y - 0.3);
    A.setFrame(this.x, 0, this.z, this.yaw);
    for (const x of [-5, 5]) { A.box(x, y, T0 + 2.2, 0.7, 1.5, 0.5, C.METAL, 0xc8261e); A.box(x, y + 1.5, T0 + 2.2, 0.8, 0.3, 0.6, C.PLAIN, 0xf2f2ee); this.solids.push({ lx: x, lz: T0 + 2.2, hx: 0.45, hz: 0.35, y0: y - 0.5, y1: y + 1.9 }); }
    A.box(11, y, T0 + 2.2, 3.2, 2.6, 2.6, C.CLAP, 0xf2f2ee); A.box(11, y + 2.6, T0 + 2.2, 3.8, 0.25, 3.2, C.SEAM, 0x1d4e89); A.box(11, y + 2.85, T0 + 2.2, 2.2, 0.6, 0.12, C.PLAIN, 0xf2b705);
    this.solids.push({ lx: 11, lz: T0 + 2.2, hx: 1.7, hz: 1.4, y0: y - 0.5, y1: y + 3.5 });
    for (const x of [-14.4, 14.4]) this.lamp(x, T1 - 0.4, y);
    for (let z = 6; z < Lp; z += 16) this.lamp(1.3, z, y);
    // the boathouse beside the pier root, with a slipway down into the water
    const bx = this.site.side * 16, bz = -12, base = this.boathouse(bx, bz, 11, 13, 5.2);
    this.ramp(bx - 3, bx + 3, -5.5, base - 0.05, 9, wl - 1.4, C.CONCRETE, 0x9a968e);
    this.foot = [Math.min(bx - 8, -4), Math.max(bx + 8, 4), -24, 4];
    // channel buoys (red on the left going out, green on the right), mooring buoys with boats on two of them
    const ch = this.site.channel;
    for (let k = 0; k < 4; k++) { const z = T1 + 22 + k * 38; if (z > ch - 10) break; this.buoy(-17, z, 'red'); this.buoy(17, z, 'green'); }
    this.moorings = [];
    for (const sx of [-1, 1]) { const lx = sx * (30 + R() * 8), lz = Lp * (0.45 + R() * 0.25); if (this.ground(lx, lz) < wl - 2.5) { this.buoy(lx, lz, 'white'); this.moorings.push({ lx, lz: lz - 4.5, yaw: R() * 0.6 - 0.3 }); } }
    this.buoy(-24, T1 + 8, 'yellow'); this.buoy(24, T1 + 8, 'yellow');
    // where a boat starts: out past the T-head on the channel's line, pointing out
    this.startAt = { lx: 0, lz: T1 + 30, yaw: 0 };
    this.tie = { lx: -9, lz: T1 + 2.3, yaw: Math.PI / 2 }; // the biggest boat alongside the fuel dock's outer face
  }

  // ---------- a landing on a river ----------
  buildRiver() {
    const A = (this.A = new Builder()), R = this.rnd, w = this.site.w, off = 4; // the dock: 4 m out from the bank, along it
    const yAt = (lx, lz) => this.water(lx, lz) + 0.55; // a floating dock rides on the river
    for (let x = -30; x < 30; x += 6) { const y = yAt(x + 3, off + 1.5); this.deck(x, x + 6.02, off, off + 3, y, { th: 0.45, col: 0xb09474 }); }
    for (const x of [-30, -10, 10, 30]) this.pile(x, off + 3.3, yAt(x, off) + 1.2); // guide piles
    this.ramp(-1.2, 1.2, -6, this.ground(0, -6) + 0.05, off, yAt(0, off)); // gangway from the bank
    for (const x of [-18, 14]) this.deck(x - 0.6, x + 0.6, off + 3, off + 11, yAt(x, off + 7), { th: 0.35, col: 0xb09474 }); // two fingers out into the river
    // boat ramp: concrete down the bank beside the dock
    this.ramp(36, 42, -14, this.ground(39, -14) + 0.05, 12, this.water(39, 6) - 1.6, C.CONCRETE, 0x9a968e);
    A.setFrame(this.x, 0, this.z, this.yaw);
    { const y = yAt(-25, off); A.box(-25, y, off + 1.5, 0.7, 1.4, 0.5, C.METAL, 0xc8261e); A.box(-25, y + 1.4, off + 1.5, 0.8, 0.3, 0.6, C.PLAIN, 0xf2f2ee); this.solids.push({ lx: -25, lz: off + 1.5, hx: 0.45, hz: 0.35, y0: y - 0.5, y1: y + 1.8 }); }
    this.lamp(-29, off + 0.4, yAt(-29, off)); this.lamp(29, off + 0.4, yAt(29, off));
    const base = this.boathouse(-14, -13, 9, 8, 4.2);
    this.foot = [-24, 46, -22, 2];
    this.slips = [{ lx: -6, lz: off + 3 + 1.8, yaw: Math.PI / 2 }, { lx: 6, lz: off + 3 + 1.8, yaw: -Math.PI / 2 }, { lx: -24, lz: off + 7, yaw: 0 }];
    this.moorings = [];
    // buoys down the middle of the channel, up and down the reach
    for (const x of [-90, -45, 45, 90]) this.buoy(x, w * 0.55, x < 0 ? 'red' : 'green');
    // start mid-channel, facing along the longer stretch of open water (up or down the river)
    const lz0 = Math.min(w * 0.75, 26), reach = (sx) => { let d = 0; for (; d < 600; d += 10) { const p = this.W(sx * d, lz0); if (this.world.groundAt(p.x, p.z).type !== 'water') break; } return d; };
    this.startAt = { lx: 0, lz: lz0, yaw: reach(1) >= reach(-1) ? Math.PI / 2 : -Math.PI / 2 };
    this.tie = null;
    void base; void R;
  }

  // ---------- moored boats (the stock boats, merged into one mesh per material) ----------
  buildBoats() {
    const designs = makePresets().filter((d) => analyze(d).boat), R = this.rnd, W = this.world;
    if (!designs.length) return;
    const statics = new Map(), root = new THREE.Group();
    const of = (d) => {
      if (statics.has(d.name)) return statics.get(d.name);
      const g = buildStatic(d), lift = g.children[0].position.y - d.parts[0].pos[1], wl = analyze(d).waterline ?? 0; // (buildStatic stood it on its lowest point)
      g.traverse((o) => { o.userData = {}; }); // (scenery: nothing to wire up, and clone() copies userData through JSON)
      const s = { g, y: wl + lift }; statics.set(d.name, s); return s;
    };
    const big = designs.find((d) => d.name === 'Fireboat'), small = designs.filter((d) => d !== big);
    const place = (d, lx, lz, yaw) => {
      const s = of(d), o = s.g.clone(), p = this.W(lx, lz); o.position.set(p.x, this.water(lx, lz) - s.y, p.z); o.rotation.y = this.yaw + yaw; root.add(o);
      this.moored.push({ name: d.name, x: p.x, z: p.z, yaw: this.yaw + yaw });
    };
    for (const s of this.slips || []) if (R() < 0.75) place(small[Math.floor(R() * small.length)], s.lx, s.lz, s.yaw + (R() - 0.5) * 0.08);
    for (const m of this.moorings || []) place(small[Math.floor(R() * small.length)], m.lx, m.lz, m.yaw);
    if (this.tie && big) place(big, this.tie.lx, this.tie.lz, this.tie.yaw);
    if (!root.children.length) return;
    const merged = mergeByMaterial(root); merged.name = 'moored';
    merged.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.group.add(merged);
    for (const s of statics.values()) s.g.traverse((m) => m.geometry?.dispose?.());
    void W;
  }

  // where a boat starts: { pos, heading } (heading as Aircraft.spawn takes it: 0 = -z)
  get start() {
    const s = this.startAt, p = this.W(s.lx, s.lz), a = this.yaw + s.yaw; // local +z (out) in world: (sin a, cos a)
    return { pos: p, heading: Math.atan2(-Math.sin(a), -Math.cos(a)) };
  }
}

// ---------- finding a site ----------
// A shore with deep water in front, low land behind, nothing built in the way. Returns { x, z (the shore point), s (unit
// vector out over the water), side (which side of the pier the boathouse goes), len (pier length), channel, wl }.
function findShore(world, cfg) {
  const wl = world.waterLevel, H = (x, z) => world.heightAt(x, z), [hx, hz] = cfg.at, R = cfg.r ?? 2500, step = 40, half = world.half ?? 11000;
  const deck = (x, z) => world.roadSurf?.q(x, z, true); // a bridge deck over the water
  const P = new THREE.Vector3();
  const building = (x, z, h) => !!world.towns?.hit?.(P.set(x, h + 2, z)) || !!world.towns?.hit?.(P.set(x, h + 6, z));
  const airport = (x, z) => x > -500 && x < 800 && Math.abs(z) < 1900;
  let best = null;
  for (let gx = -R; gx <= R; gx += step) for (let gz = -R; gz <= R; gz += step) {
    if (gx * gx + gz * gz > R * R) continue;
    const x = hx + gx, z = hz + gz; if (Math.abs(x) > half - 400 || Math.abs(z) > half - 400) continue;
    if (H(x, z) > wl - 3) continue;
    // land within ~90 m? (8 directions first, then the nearest shore in 32)
    let near = false; for (let k = 0; k < 8 && !near; k++) { const a = (k / 8) * Math.PI * 2; for (const d of [45, 90]) if (H(x + Math.cos(a) * d, z + Math.sin(a) * d) >= wl) { near = true; break; } }
    if (!near) continue;
    let dmin = Infinity, ang = 0;
    for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); for (let d = 6; d <= 96 && d < dmin; d += 3) if (H(x + c * d, z + s * d) >= wl) { dmin = d; ang = a; break; } }
    if (dmin < 30 || dmin > 96) continue;
    const n = new THREE.Vector2(Math.cos(ang), Math.sin(ang)), t = new THREE.Vector2(-n.y, n.x), sx = x + n.x * dmin, sz = z + n.y * dmin; // n: towards the land
    const at = (u, v) => [sx + t.x * u - n.x * v, sz + t.y * u - n.y * v]; // u along the shore, v out over the water
    if (airport(sx, sz)) continue;
    // the marina's water: deep enough under the docks, clear of bridges
    let ok = true, depthMin = Infinity;
    for (let v = 10; v <= 76 && ok; v += 6) for (const u of [-16, -8, 0, 8, 16]) { const [px, pz] = at(u, v), h = H(px, pz); if (h > wl - (v < 18 ? 0.8 : 2.4) || deck(px, pz)) { ok = false; break; } depthMin = Math.min(depthMin, wl - h); }
    if (!ok) continue;
    // a channel out: open water 450 m straight out, 50 m wide
    let channel = 450;
    for (let v = 90; v <= 450 && ok; v += 30) for (const u of [-25, 0, 25]) { const [px, pz] = at(u, v); if (H(px, pz) > wl - 2 || deck(px, pz)) { if (v < 270) ok = false; else channel = Math.min(channel, v - 30); break; } }
    if (!ok) continue;
    // the land behind: low and not steep where the boathouse and the pier root go, no buildings on it (either side)
    let side = 0, sideScore = Infinity, landPen = 0;
    for (const sd of [-1, 1]) {
      let pen = 0, lo = Infinity, hi = -Infinity, bad = false;
      for (let v = -4; v >= -20 && !bad; v -= 4) for (let u = 10; u <= 22; u += 4) { const [px, pz] = at(sd * u, v), h = H(px, pz); if (h < wl + 0.2 || h > wl + 9 || building(px, pz, h)) { bad = true; break; } lo = Math.min(lo, h); hi = Math.max(hi, h); if (world.flora?.hit?.(P.set(px, h + 2, pz))) pen += 2; }
      if (bad) continue;
      pen += (hi - lo) * 4; if (pen < sideScore) { sideScore = pen; side = sd; }
    }
    if (!side) continue;
    for (let v = -2; v >= -16; v -= 4) { const [px, pz] = at(0, v), h = H(px, pz); if (building(px, pz, h)) { ok = false; break; } if (h > wl + 6) landPen += 20; }
    if (!ok) continue;
    // a straight shore: the land the same distance away a little to either side
    let wig = 0; for (const u of [-30, 30]) { let d = 0; for (; d < 80; d += 4) { const [px, pz] = at(u, -d + 30); if (H(px, pz) >= wl) break; } wig += Math.abs(d - 30); }
    const score = Math.hypot(sx - hx, sz - hz) * 0.05 + sideScore + landPen + wig * 0.5 + Math.max(0, 6 - depthMin) * 8 + (450 - channel) * 0.1;
    if (!best || score < best.score) best = { score, x: sx, z: sz, s: new THREE.Vector3(-n.x, 0, -n.y), side, len: 58, channel, wl, depth: depthMin };
  }
  return best;
}

// A flat, wide reach of a real river (real.rivers) with a low bank. { x, z (the bank), s (out over the river), w, wl, down }
function findRiver(world, cfg) {
  const real = world.real; if (!real?.rivers?.length) return null;
  const [hx, hz] = cfg.at, R = cfg.r ?? 3000, H = (x, z) => world.heightAt(x, z);
  let best = null;
  for (const P of real.rivers) for (let i = 8; i < P.length - 8; i += 2) {
    const p = P[i]; if (Math.hypot(p.x - hx, p.z - hz) > R || p.w < 24) continue;
    const a = P[i - 6], b = P[i + 6]; if (Math.abs(a.h - b.h) > 0.8) continue; // flat water (no rapids)
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz); if (L < 1) continue;
    const t = new THREE.Vector2(dx / L, dz / L);
    // straight: the reach either side lines up
    const c = P[i - 3], e = P[i + 3]; const bend = Math.abs((c.x - p.x) * t.y - (c.z - p.z) * t.x) + Math.abs((e.x - p.x) * t.y - (e.z - p.z) * t.x);
    const depth = p.h - H(p.x, p.z); if (depth < 1.4) continue;
    for (const sd of [-1, 1]) {
      const n = new THREE.Vector2(-t.y * sd, t.x * sd), bx = p.x + n.x * (p.w + 2), bz = p.z + n.y * (p.w + 2); // n: towards this bank
      let lo = Infinity, hi = -Infinity, wet = false;
      for (let v = 0; v <= 22; v += 5) for (const u of [-25, -10, 0, 10, 25, 40]) { const h = H(bx + n.x * v + t.x * u, bz + n.y * v + t.y * u); lo = Math.min(lo, h); hi = Math.max(hi, h); if (real.waterAt(bx + n.x * v + t.x * u, bz + n.y * v + t.y * u) != null && v > 4) wet = true; }
      if (wet || lo < p.h - 0.5) continue;
      const steep = hi - lo, score = steep * 3 + bend * 0.5 + Math.hypot(p.x - hx, p.z - hz) * 0.004 + Math.abs(a.h - b.h) * 10;
      if (steep > 14) continue;
      if (!best || score < best.score) {
        const s = new THREE.Vector3(-n.x, 0, -n.y), along = new THREE.Vector3(t.x, 0, t.y); // downstream: water falls along the list?
        const downDir = (P[Math.min(P.length - 1, i + 20)].h < P[Math.max(0, i - 20)].h) ? 1 : -1;
        // the start heading in local terms: local x runs along (s.z, -s.x); face downstream along the bank
        const lxDir = new THREE.Vector3(s.z, 0, -s.x), dot = along.dot(lxDir) * downDir;
        best = { score, x: bx, z: bz, s, w: p.w, wl: p.h, down: dot > 0 ? Math.PI / 2 : -Math.PI / 2, side: -1 };
      }
    }
  }
  return best;
}
