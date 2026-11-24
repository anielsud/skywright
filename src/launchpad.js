// Launch complex: every location has one near the airfield, where vertical launchers (rockets) start their flight.
// A raised concrete pad with a flame trench, the hangar's own launch stand and service tower (hangar.js uprightStage,
// sized from the vehicle about to fly, or from the stock Rocket when something else flies), lightning and flood-light
// masts, a blockhouse, propellant spheres, gas bottles and a water tower.
//
// The site is found procedurally (findPadSite): flat ground in the airfield's cleared zone (no trees, no real
// buildings there), clear of the runways, the apron and the airport buildings, off roads and out of water.
//
// Collision is deliberately simple (flat surfaces): ground(x, z, y) answers World.groundAt on the pad, with the stand's
// deck ring as a floor at the deck's height for anything at or above it (so a rocket rests on the ring by its fins
// while its nozzles hang in the hole; nothing of the stand reaches above the deck), the flame trench floor below the
// hole, and the slab and its ramp. The tower, masts, tanks and buildings are solid obstacles through hit() (World.treeHit,
// like town buildings). Everything is merged: the slab, buildings and tanks are one draw call on the airport's building
// material, the stand is a handful of meshes on cached paint materials, and the lamps join the world's night lights.
import * as THREE from 'three';
import { ALS, LOC_Z } from './airportKit.js';
import { Builder, C } from './buildings.js';
import { buildDesign, uprightStage } from './hangar.js';
import { analyze } from './design.js';

const HALF = 17; // the slab: 34 m square
const RAISE = 1.2; // slab top above the ground
const RAMP = 11, RAMP_W = 8; // access ramp on the -z side
const SPILL = 14; // concrete spillway beyond the trench exit (+z side)
const R_SITE = 56; // the whole complex fits in this radius
const UP = new THREE.Vector3(0, 1, 0);

// Where the complex goes: the flattest clear spot in the airfield's cleared zone (flora.js and realBuildings.js keep
// trees and buildings off x -380..580, |z| < 1250 around the airport), away from the runways, apron, airport
// buildings and roads, and out of water. Scored for flatness, then for a spot well off the runways (~330 m) and
// beside the middle of the field.
export function findPadSite(world) {
  const rw = world.runways || [], P = new THREE.Vector3();
  const clearOfAirport = (x, z, m) => {
    for (const r of rw) if (Math.abs(x - r.x) < r.width / 2 + 140 + m && Math.abs(z) < r.len / 2 + 220 + m) return false;
    for (const r of rw) if (Math.abs(x - r.x) < ALS.half + 10 + m && z > 0 && z < r.len / 2 + ALS.start + ALS.rows * ALS.step + 20 + m) return false; // approach lights (airportKit.js)
    for (const r of rw) if (Math.abs(x - r.x) < 40 + m && z < 0 && z > -r.len / 2 - LOC_Z - 20 - m) return false; // localizer
    const G = world.gate; if (G && x > 300 - m && x < G.x + 70 + m && Math.abs(z - G.z) < 30 + m) return false; // the landside road (airportGround.js)
    if (x > 40 - m && x < 450 + m && Math.abs(z) < 270 + m) return false; // apron, terminal, hangars, tower, fuel farm
    if (Math.hypot(x + 45, z - 600) < 30 + m) return false; // windsock
    return true;
  };
  const rings = [[0, 1], [10, 8], [20, 10], [32, 12], [44, 14], [R_SITE, 16]];
  const test = (x, z, strict) => {
    let lo = Infinity, hi = -Infinity, loC = Infinity, hiC = -Infinity;
    for (const [r, n] of rings) for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r * 0.1, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const g = world.groundAt(px, pz);
      if (g.type === 'water' || g.type === 'runway' || world.isPaved?.(px, pz)) return null;
      if (strict && world.nearRoad(px, pz, 4)) return null;
      if (world.treeHit(P.set(px, g.h + 2, pz))) return null;
      lo = Math.min(lo, g.h); hi = Math.max(hi, g.h);
      if (r <= 20) { loC = Math.min(loC, g.h); hiC = Math.max(hiC, g.h); }
    }
    if (strict && (hiC - loC > 1.2 || hi - lo > 3.5)) return null;
    return { core: hiC - loC, all: hi - lo };
  };
  for (const strict of [true, false]) {
    let best = null;
    for (let x = -380 + R_SITE; x <= 580 - R_SITE; x += 20) for (let z = -1250 + R_SITE; z <= 1250 - R_SITE; z += 20) {
      if (!clearOfAirport(x, z, R_SITE)) continue;
      const dRwy = Math.min(...rw.map((r) => Math.abs(x - r.x)));
      const pre = Math.abs(dRwy - 330) * 0.03 + Math.abs(Math.abs(z) - 600) * 0.01 + (z > 0 ? 0.5 : 0);
      if (best && pre > best.score) continue; // can't win even when perfectly flat
      const t = test(x, z, strict); if (!t) continue;
      const score = pre + t.core * 30 + t.all * 4;
      if (!best || score < best.score) best = { x, z, score };
    }
    if (best) return best;
  }
  return { x: 360, z: -650, score: Infinity };
}

export class LaunchPad {
  constructor(world) {
    this.world = world;
    const s = findPadSite(world);
    this.x = s.x; this.z = s.z;
    // the trench (local +z) points away from the airfield
    const ax = 100, dx = s.x - ax, dz = s.z;
    this.yaw = Math.atan2(dx, dz); this.cs = Math.cos(this.yaw); this.sn = Math.sin(this.yaw);
    let lo = Infinity, hi = -Infinity;
    for (let i = -HALF; i <= HALF; i += HALF / 4) for (let j = -HALF; j <= HALF + SPILL; j += HALF / 4) { const p = this.toWorld(i, j), h = world.heightAt(p.x, p.z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    this.lo = lo; this.g0 = hi; this.top = hi + RAISE; this.floorY = hi + 0.05;
    this.solids = []; this.stand = null; this.info = null; this.armT = 0;
    this.group = new THREE.Group(); world.group.add(this.group);
    this.buildStatic();
  }
  toWorld(lx, lz, out = new THREE.Vector3()) { return out.set(this.x + lx * this.cs + lz * this.sn, 0, this.z - lx * this.sn + lz * this.cs); }
  toLocal(x, z) { const dx = x - this.x, dz = z - this.z; return [dx * this.cs - dz * this.sn, dx * this.sn + dz * this.cs]; }
  get mat() { return this.world.windowMats[0]; } // the airport's building material (concrete, metal, windows lit at night)

  // ---------- the things around the pad (built once per world) ----------
  buildStatic() {
    const W = this.world, A = new Builder(), lamps = [], lampCol = [];
    const at = (lx, lz) => { const p = this.toWorld(lx, lz); p.y = W.heightAt(p.x, p.z); A.setFrame(p.x, p.y, p.z, this.yaw); return p; };
    const solid = (lx, lz, r, y0, y1) => this.solids.push({ lx, lz, r, y0, y1 });
    const lamp = (lx, ly, lz, c) => { const p = this.toWorld(lx, lz); lamps.push(p.x, ly, p.z); lampCol.push(...c); };
    // lightning masts at the slab corners (tall, thin, red light on top)
    for (const [i, j] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lx = i * (HALF + 4), lz = j * (HALF + 4), p = at(lx, lz), h = 34;
      A.cyl(0, 0, -0.5, 0.4, 0.9, 0.9, 8, C.CONCRETE, 0xb8b4ac, { cap: true });
      A.cyl(0, 0, 0.4, h, 0.35, 0.12, 6, C.PLAIN, 0xc8ccd0); A.cyl(0, 0, h, h + 3, 0.05, 0.05, 4, C.PLAIN, 0x9a9ea4);
      lamp(lx, p.y + h + 0.2, lz, [1, 0.12, 0.08]); solid(lx, lz, 0.6, p.y - 1, p.y + h + 3);
    }
    // flood-light masts on the ramp side, lamps aimed at the stand
    for (const i of [-1, 1]) {
      const lx = i * 25, lz = -26, p = at(lx, lz), h = 18;
      A.cyl(0, 0, -0.3, h, 0.35, 0.22, 6, C.PLAIN, 0xa8acb2); A.box(0, h - 0.2, 0, 3.2, 1.4, 0.6, C.METAL, 0x5a5e64, { bottom: true });
      for (const d of [-1, 0, 1]) lamp(lx + d, p.y + h + 0.4, lz + 0.5, [1, 0.92, 0.75]);
      solid(lx, lz, 1.2, p.y - 1, p.y + h + 1.3);
    }
    // blockhouse: a low concrete bunker with a domed roof, a door and slit windows
    {
      const lx = -36, lz = -40, p = at(lx, lz);
      A.box(0, -0.5, 0, 14, 4.3, 10, C.CONCRETE, 0xc8c4bc);
      A.dome(0, 0, 3.8, 4.8, 16, 4, C.CONCRETE, 0xc0bcb4);
      A.plainQuad([-1, 0, 5.02], [1, 0, 5.02], [1, 2.3, 5.02], [-1, 2.3, 5.02], C.CONCRETE, 0x3a3c40);
      for (const x of [-5, -3, 3, 5]) A.plainQuad([x - 0.7, 2.6, 5.02], [x + 0.7, 2.6, 5.02], [x + 0.7, 3.0, 5.02], [x - 0.7, 3.0, 5.02], C.GLASS, 0xffffff);
      A.cyl(4, -2, 6, 10, 0.08, 0.08, 4, C.METAL, 0x9a9ea4); // antenna
      lamp(lx, p.y + 4.6, lz + 5.4, [1, 0.85, 0.6]);
      solid(lx, lz, 7.5, p.y - 1, p.y + 10);
    }
    // propellant: two spheres on legs (oxidiser white, fuel white with a blue band)
    for (const [lz, r, band] of [[-30, 5, 0xffffff], [-44, 4.2, 0x2a5aa8]]) {
      const lx = 38, p = at(lx, lz), yc = r + 3.5;
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; A.cyl(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8, -0.3, yc, 0.22, 0.22, 6, C.PLAIN, 0xb8bcc2); }
      sphere(A, 0, 0, yc, r, 16, 8, C.SEAM, 0xf4f4f0);
      A.cyl(0, 0, yc - 0.5, yc + 0.5, r * 1.005, r * 1.005, 16, C.PLAIN, band);
      A.cyl(0, 0, yc + r - 0.2, yc + r + 0.8, 0.5, 0.5, 6, C.METAL, 0x9a9ea4, { cap: true });
      solid(lx, lz, r + 0.6, p.y - 1, p.y + yc + r + 1);
    }
    // pipes from the tanks along the ground to the pad
    { const p0 = this.toWorld(33, -32), p1 = this.toWorld(HALF, -6); const y = W.heightAt(p0.x, p0.z);
      A.setFrame(0, y, 0, 0); const L = p0.distanceTo(p1), ux = (p1.x - p0.x) / L, uz = (p1.z - p0.z) / L;
      for (const o of [-0.6, 0.6]) A.obox((p0.x + p1.x) / 2 - uz * o, (p0.z + p1.z) / 2 + ux * o, ux, uz, L / 2, 0.2, 0.1, 0.5, C.METAL, 0xc8ccd2); }
    // high-pressure gas bottles
    for (let k = 0; k < 4; k++) { const lx = -40 + k * 3, lz = 26, p = at(lx, lz); A.cyl(0, 0, -0.3, 7, 1.1, 1.1, 10, C.SEAM, 0x7a8a6a); A.dome(0, 0, 7, 1.1, 10, 2, C.SEAM, 0x7a8a6a); solid(lx, lz, 1.4, p.y - 1, p.y + 8.2); }
    // water tower (it floods the pad with water at launch to soak up the noise)
    {
      const lx = -40, lz = 4, p = at(lx, lz), y0 = 20;
      for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; A.cyl(Math.cos(a) * 4, Math.sin(a) * 4, -0.3, y0, 0.3, 0.3, 6, C.PLAIN, 0xb0b4ba); }
      A.cyl(0, 0, -0.3, y0, 0.6, 0.6, 8, C.PLAIN, 0xb0b4ba);
      A.cyl(0, 0, y0, y0 + 7, 5, 5, 20, C.SEAM, 0xe8e8e2); A.cyl(0, 0, y0 + 7, y0 + 9, 5, 0.4, 20, C.SEAM, 0xd8d8d2);
      A.cyl(0, 0, y0 + 3, y0 + 4, 5.03, 5.03, 20, C.PLAIN, 0xc8282e);
      lamp(lx, p.y + y0 + 9.3, lz, [1, 0.12, 0.08]);
      solid(lx, lz, 5.3, p.y - 1, p.y + y0 + 9);
    }
    // spillway: concrete at the trench exit, following the ground
    {
      const q = (lx, lz) => { const p = this.toWorld(lx, lz); return [p.x, Math.max(W.heightAt(p.x, p.z), this.lo) + 0.06, p.z]; };
      A.setFrame(0, 0, 0, 0);
      const n = 4; for (let k = 0; k < n; k++) {
        const z0 = HALF + (k / n) * SPILL, z1 = HALF + ((k + 1) / n) * SPILL, w0 = 4 + (k / n) * 6, w1 = 4 + ((k + 1) / n) * 6;
        A.plainQuad(q(-w0, z0), q(-w1, z1), q(w1, z1), q(w0, z0), C.CONCRETE, k < 2 ? 0x55514c : 0x8a8680);
      }
    }
    const shell = new THREE.Mesh(A.toGeometry(), this.mat); shell.castShadow = shell.receiveShadow = true; this.group.add(shell);
    if (lamps.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(lampCol, 3));
      this.group.add(new THREE.Points(g, W.lightsMat));
    }
  }

  // ---------- the slab and the stand, sized for the vehicle (once per flight) ----------
  // design: the vehicle about to fly if it is a vertical launcher, else the stock rocket (so the pad is never bare)
  setStand(design) {
    if (this.stand) { this.group.remove(this.stand, this.slab); this.stand.traverse((o) => o.geometry?.dispose()); this.slab.geometry.dispose(); this.stand = this.slab = this.info = this.tower = null; }
    const st = design && analyze(design);
    if (!st?.vertical) return null;
    const v = new THREE.Group(); buildDesign(design, v, { near: false });
    const floor = this.floorY - this.top; // the deflector's foot, down in the flame trench
    const up = uprightStage(design, v, st, { floor }); v.traverse((o) => o.geometry?.dispose());
    if (!up) return null;
    const I = up.info;
    // the trench: wide enough for the deflector, narrow enough that the stand's legs stand on the slab either side
    this.w = Math.max(I.rIn * 0.98, Math.min(I.rIn * 1.15, I.legR * Math.SQRT1_2 - 0.4));
    this.info = I; this.vehicleY = up.y; // stand frame: root.position.y for the vehicle
    this.deckY = this.top + I.H;
    // the stand: its vehicle axis (I.c) over the trench's head, at the pad's heading
    const s = up.stand; s.rotation.y = this.yaw;
    const o = this.toWorld(0, 0), off = new THREE.Vector3(I.c.x, 0, I.c.y).applyAxisAngle(UP, this.yaw);
    s.position.set(o.x - off.x, this.top, o.z - off.z); s.updateMatrixWorld(true);
    this.stand = s; this.arm = s.userData.arm; this.armT = 0; this.group.add(s);
    // tower, in pad coordinates
    this.tower = { lx: I.tower.x - I.c.x, lz: I.tower.z - I.c.y, hw: I.tower.w / 2 + 0.15, top: this.top + I.tower.top };
    this.slab = this.buildSlab(); this.group.add(this.slab);
    return up;
  }
  buildSlab() {
    const A = new Builder(), w = this.w, y0 = this.lo - 0.6 - this.top, F = this.floorY - this.top, conc = 0xc4c0b8, dark = 0x4a4642;
    const o = this.toWorld(0, 0); A.setFrame(o.x, this.top, o.z, this.yaw);
    // three blocks around the trench (it runs from under the stand out to the +z edge)
    A.box(-(HALF + w) / 2, y0, 0, HALF - w, -y0, 2 * HALF, C.CONCRETE, conc);
    A.box((HALF + w) / 2, y0, 0, HALF - w, -y0, 2 * HALF, C.CONCRETE, conc);
    A.box(0, y0, -(HALF + w) / 2, 2 * w, -y0, HALF - w, C.CONCRETE, conc);
    // trench floor and its sooty walls
    A.plainQuad([-w, F, HALF], [w, F, HALF], [w, F, -w], [-w, F, -w], C.CONCRETE, dark);
    A.plainQuad([-w + 0.02, F, HALF], [-w + 0.02, F, -w], [-w + 0.02, 0, -w], [-w + 0.02, 0, HALF], C.CONCRETE, 0x5a5652);
    A.plainQuad([w - 0.02, F, -w], [w - 0.02, F, HALF], [w - 0.02, 0, HALF], [w - 0.02, 0, -w], C.CONCRETE, 0x5a5652);
    A.plainQuad([-w, F, -w + 0.02], [w, F, -w + 0.02], [w, 0, -w + 0.02], [-w, 0, -w + 0.02], C.CONCRETE, 0x3a3632);
    // blast-scorched ring around the trench head, and a painted ring around the stand
    const R = Math.max(5, this.info.rOut * 2.6), seg = 24;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2, p = (a, r) => [Math.cos(a) * r, 0.02, Math.sin(a) * r];
      const clip = (q) => (Math.abs(q[0]) < w + 0.05 && q[2] > -w - 0.05 ? null : q);
      const q0 = clip(p(a0, R)), q1 = clip(p(a1, R)), q2 = clip(p(a1, this.info.rOut + 0.3)), q3 = clip(p(a0, this.info.rOut + 0.3));
      if (q0 && q1 && q2 && q3) A.quad(q3, q2, q1, q0, [0, 0, 1, 0, 1, 1, 0, 1], C.CONCRETE, 0x8a8680);
      const r0 = R + 0.1, r1 = R + 0.5, s0 = clip(p(a0, r0)), s1 = clip(p(a1, r0)), s2 = clip(p(a1, r1)), s3 = clip(p(a0, r1));
      if (s0 && s1 && s2 && s3 && k % 2 === 0) A.quad(s0, s1, s2, s3, [0, 0, 1, 0, 1, 1, 0, 1], C.PLAIN, 0xf2b705);
    }
    // ramp down to the ground on the -z side
    const g = this.lo - this.top - 0.3;
    const rw = RAMP_W / 2, rz = -HALF - RAMP;
    A.plainQuad([rw, g, rz], [-rw, g, rz], [-rw, 0, -HALF], [rw, 0, -HALF], C.CONCRETE, 0xb0aca4);
    A.tri([-rw, g, rz], [-rw, g, -HALF], [-rw, 0, -HALF], [0, 0, 3, 0, 3, 0.4], C.CONCRETE, 0xb0aca4);
    A.tri([rw, g, -HALF], [rw, g, rz], [rw, 0, -HALF], [0, 0, 3, 0, 0, 0.4], C.CONCRETE, 0xb0aca4);
    const m = new THREE.Mesh(A.toGeometry(), this.mat); m.castShadow = m.receiveShadow = true;
    return m;
  }

  // ---------- spawn ----------
  // Where the vehicle's design origin goes and how it's turned, standing on the stand as in the hangar
  spawnPose() {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, this.yaw, 0, 'YXZ'));
    const o = this.stand.position.clone(); o.y = this.top + this.vehicleY;
    return { origin: o, q, heading: this.yaw };
  }
  // pad-local distance of a world point from the vehicle axis (the trench head)
  axisDist(x, z) { const [lx, lz] = this.toLocal(x, z); return Math.hypot(lx, lz); }

  // the swing arm has swung far enough back for the vehicle to rise past it (the hold-down clamps wait for this)
  get armClear() { return !this.stand || this.armT > 0.8; }

  // ---------- collision ----------
  // World.groundAt on the pad (null elsewhere). y: the height of the point asking (see the top of this file).
  ground(x, z, y = Infinity) {
    const dx = x - this.x, dz = z - this.z; if (!this.slab || dx * dx + dz * dz > (HALF + RAMP + 2) ** 2 * 2) return null;
    const [lx, lz] = this.toLocal(x, z), I = this.info;
    const r = Math.hypot(lx, lz); if (r > I.rIn && r < I.rOut && y > this.deckY - 0.5) return { h: this.deckY, n: UP.clone(), type: 'runway' };
    if (Math.abs(lx) <= HALF && Math.abs(lz) <= HALF) {
      if (Math.abs(lx) < this.w && lz > -this.w) return { h: this.floorY, n: UP.clone(), type: 'runway' }; // the flame trench
      return { h: this.top, n: UP.clone(), type: 'runway' };
    }
    if (Math.abs(lx) < RAMP_W / 2 && lz < -HALF && lz > -HALF - RAMP) {
      const t = (-HALF - lz) / RAMP, h = this.top + (this.lo - 0.3 - this.top) * t, n = new THREE.Vector3(0, RAMP, this.lo - 0.3 - this.top).normalize();
      return h > this.world.heightAt(x, z) ? { h, n: n.applyAxisAngle(UP, this.yaw), type: 'runway' } : null;
    }
    return null;
  }
  // the highest the pad reaches at (x, z) (World.maxGround), or -Infinity
  maxAt(x, z) {
    const dx = x - this.x, dz = z - this.z; if (!this.slab || dx * dx + dz * dz > (HALF + RAMP + 2) ** 2 * 2) return -Infinity;
    return this.deckY;
  }
  // a solid obstacle (tower, mast, tank, building) at p, as World.treeHit returns them: [x, y0, z, height, radius]
  hit(p) {
    const dx = p.x - this.x, dz = p.z - this.z; if (dx * dx + dz * dz > (R_SITE + 8) ** 2) return null;
    const [lx, lz] = this.toLocal(p.x, p.z);
    const T = this.tower;
    if (T && Math.abs(lx - T.lx) < T.hw && Math.abs(lz - T.lz) < T.hw && p.y > this.top - 1 && p.y < T.top) return this.rec(T.lx, T.lz, this.top, T.top, T.hw);
    for (const s of this.solids) if ((lx - s.lx) ** 2 + (lz - s.lz) ** 2 < s.r * s.r && p.y > s.y0 && p.y < s.y1) return this.rec(s.lx, s.lz, s.y0, s.y1, s.r);
    return null;
  }
  rec(lx, lz, y0, y1, r) { const w = this.toWorld(lx, lz), t = [w.x, y0, w.z, y1 - y0, r]; t.solid = true; return t; }

  // ---------- launch ----------
  // lit: the engine start has begun (the swing arm swings back to the tower). go: 0..1 thrust; steam and smoke billow
  // out of the trench while the plume still reaches the pad (h: the vehicle's height above the deck).
  update(dt, go, h, effects, lit = go > 0) {
    if (!this.stand) return;
    if (lit || this.armT > 0) { this.armT = Math.min(1, this.armT + dt / 1.6); const e = this.armT * this.armT * (3 - 2 * this.armT); this.arm.rotation.y = -1.75 * e; }
    const k = go * Math.max(0, 1 - h / 70); if (k <= 0.02 || !effects) return;
    const exit = this.toWorld(0, HALF), n = Math.round(k * 5 + Math.random()); exit.y = this.floorY + 1;
    for (let i = 0; i < n; i++) { // out of the trench mouth, rolling along the spillway and up
      const sp = 10 + 22 * k * Math.random(), a = this.yaw + (Math.random() - 0.5) * 1.1, g = 0.86 + Math.random() * 0.12;
      effects.puff(exit, { x: Math.sin(a) * sp, y: 2 + Math.random() * 6, z: Math.cos(a) * sp }, { color: [g, g, g], s0: 4, s1: 20 + 18 * k, life: 5 + Math.random() * 4, a: 0.8, drag: 0.45, grav: -0.8 });
    }
    // and out across the deck around the stand (exhaust splashing off it)
    for (let i = Math.round(k * 2 + Math.random() * 0.5); i > 0; i--) { const c = this.toWorld(0, 0), a = Math.random() * Math.PI * 2, sp = 8 + 12 * k; c.y = this.top + 1; effects.puff(c, { x: Math.cos(a) * sp, y: 1 + Math.random() * 3, z: Math.sin(a) * sp }, { color: [0.82, 0.81, 0.79], s0: 3, s1: 14, life: 4, a: 0.6, drag: 0.6, grav: -0.5 }); }
  }
}

// a sphere from stacked frustums (Builder has upright cylinders and domes only)
function sphere(A, cx, cz, yc, r, seg, rings, cell, col) {
  for (let j = 0; j < rings; j++) {
    const b0 = -Math.PI / 2 + (j / rings) * Math.PI, b1 = -Math.PI / 2 + ((j + 1) / rings) * Math.PI;
    A.cyl(cx, cz, yc + Math.sin(b0) * r, yc + Math.sin(b1) * r, Math.cos(b0) * r, Math.cos(b1) * r, seg, cell, col);
  }
}
