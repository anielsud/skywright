// Rooftop helipads (New York): a raised steel deck on a skyscraper's flat roof, with the H in its circle, green edge
// lights, a safety net around it, flood lights, a windsock and a little stair house with a stair down to the roof.
// Helicopters start on the first one (loc.city.helipads[0].start: 55 Water Street, by the harbour); the others are
// places to land on.
//
// The roofs come from the building data (realCity.js finds the tallest flat roof at each configured point while the
// skyline is built: h.roof = { y, box, P }), so the deck sits exactly on the roof the city draws. Those buildings
// have no damage key: destruction.js never knocks them down (and leaves them standing when a neighbour falls).
//
// Collision: the deck is triangles in a CollisionMesh (collide.js), one per pad: skids and hull points stand on it
// through env.surfRay / env.surfPoint (World.surfRay), and World.maxGround knows its top. The stair house and the
// windsock mast are solid obstacles through hit() (World.treeHit), like the launch pad's tower.
//
// Cheap to draw: every pad shares five merged meshes (deck, paint, net, lamps, the night light pool) on shared
// materials. Lights are the world's night lights: glow points on World.lightsMat (floods, obstruction lights), lamp
// faces that glow in their own colour after dark, and a pool of flood light on the deck (no light objects: the
// scene's fixed light set stays as it is).
import * as THREE from 'three';
import { CollisionMesh } from './collide.js';
import { glowTexture } from './materials.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const RAISE = 2.4; // deck top above the roof (clear of any parapet)
const SLAB = 0.5; // deck thickness
const NET = 1.6; // safety net width beyond the deck edge
const STAIR_W = 1.3;
const col = (h) => new THREE.Color(h);

// ---- a geometry accumulator: non-indexed triangles with normals, vertex colours and uvs ----
class Geo {
  constructor() { this.p = []; this.n = []; this.c = []; this.u = []; }
  tri(a, b, c, color, ua = [0, 0], ub = [1, 0], uc = [1, 1], n = null) {
    const fn = n || new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const [p, u] of [[a, ua], [b, ub], [c, uc]]) { this.p.push(p.x, p.y, p.z); this.n.push(fn.x, fn.y, fn.z); this.c.push(color.r, color.g, color.b); this.u.push(u[0], u[1]); }
  }
  quad(a, b, c, d, color, uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) { this.tri(a, b, c, color, uv[0], uv[1], uv[2]); this.tri(a, c, d, color, uv[0], uv[2], uv[3]); }
  get count() { return this.p.length / 3; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// the deck's paint: dark non-slip surface, white edge line, the yellow touchdown circle, the white H, the weight box
function deckTexture() {
  const s = 1024, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 24; // (drawn for a 24 m deck: the marks scale with smaller decks)
  g.fillStyle = '#44484c'; g.fillRect(0, 0, s, s);
  for (let k = 0; k < 9000; k++) { const v = 56 + Math.random() * 30; g.fillStyle = `rgba(${v},${v + 3},${v + 6},0.5)`; g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2 + Math.random() * 3); }
  g.strokeStyle = '#f2f2ee'; g.lineWidth = 0.35 * m; g.strokeRect(0.5 * m, 0.5 * m, s - m, s - m); // the landing area's edge
  g.strokeStyle = '#f5c518'; g.lineWidth = 1.0 * m; g.beginPath(); g.arc(s / 2, s / 2, 6.6 * m, 0, Math.PI * 2); g.stroke(); // touchdown/positioning circle
  g.fillStyle = '#f7f7f2'; const hw = 1.9 * m, hh = 2.6 * m, b = 0.75 * m; // the H (its legs along the approach)
  g.fillRect(s / 2 - hw, s / 2 - hh, b, 2 * hh); g.fillRect(s / 2 + hw - b, s / 2 - hh, b, 2 * hh); g.fillRect(s / 2 - hw, s / 2 - b / 2, 2 * hw, b);
  g.strokeStyle = '#f7f7f2'; g.lineWidth = 0.25 * m; g.strokeRect(s / 2 - 1.6 * m, s - 3.4 * m, 3.2 * m, 1.9 * m); // max weight box (tonnes)
  g.fillStyle = '#f7f7f2'; g.font = `bold ${1.4 * m}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('6.0', s / 2, s - 2.42 * m);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// the safety net: a coarse rope mesh (cut out by alphaTest)
function netTexture() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'); g.clearRect(0, 0, s, s); g.strokeStyle = '#fff'; g.lineWidth = 5;
  g.beginPath(); for (let k = 0; k <= 2; k++) { g.moveTo(k * 32, 0); g.lineTo(k * 32, s); g.moveTo(0, k * 32); g.lineTo(s, k * 32); } g.stroke();
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// one pad: a frame on its roof (u along the roof's long axis, w across it, y up), its collision mesh and solids
class Pad {
  constructor(H, cfg) {
    const R = cfg.roof, b = R.box;
    this.name = cfg.name; this.start = !!cfg.start;
    this.ux = b.ux; this.uz = b.uz; // the roof's long axis
    const D = (this.D = Math.min(12, b.hw - NET - 1.2)); // deck half size: 24 m square on a big roof
    // along the roof: towards the view (the end nearer the look point), leaving room for the stair house behind
    const s = cfg.look ? Math.sign((cfg.look.x - b.cx) * b.ux + (cfg.look.z - b.cz) * b.uz) || 1 : 0;
    const off = s * Math.max(0, b.hl - D - NET - 2);
    this.cx = b.cx + b.ux * off; this.cz = b.cz + b.uz * off;
    this.back = s >= 0 ? -1 : 1; // the stair house side (local u)
    this.roofY = R.y; this.y = R.y + RAISE;
    this.hl = b.hl; this.hw = b.hw; this.off = off; this.cfg = cfg;
    // where a helicopter starts: on the H, facing the view
    const look = cfg.look || { x: this.cx + b.ux, z: this.cz + b.uz };
    this.heading = Math.atan2(-(look.x - this.cx), -(look.z - this.cz));
    this.cm = new CollisionMesh(4); this.solids = [];
    this.build(H);
    this.cm.build();
  }
  W(u, y, w) { return V(this.cx + this.ux * u - this.uz * w, y, this.cz + this.uz * u + this.ux * w); }
  local(x, z) { const dx = x - this.cx, dz = z - this.cz; return [dx * this.ux + dz * this.uz, -dx * this.uz + dz * this.ux]; }
  // a box in pad coordinates (u0..u1, y0..y1, w0..w1), all five visible faces (no bottom); coll: add its faces to the collision mesh
  box(G, u0, u1, y0, y1, w0, w1, color, top = color, coll = false) {
    const P = (u, y, w) => this.W(u, y, w);
    const f = [[P(u0, y0, w1), P(u1, y0, w1), P(u1, y1, w1), P(u0, y1, w1)], [P(u1, y0, w0), P(u0, y0, w0), P(u0, y1, w0), P(u1, y1, w0)],
      [P(u1, y0, w1), P(u1, y0, w0), P(u1, y1, w0), P(u1, y1, w1)], [P(u0, y0, w0), P(u0, y0, w1), P(u0, y1, w1), P(u0, y1, w0)]];
    for (const q of f) { G.quad(...q, color); if (coll) { this.cm.tri(q[0], q[1], q[2], 0, 0.6); this.cm.tri(q[0], q[2], q[3], 0, 0.6); } }
    G.quad(P(u0, y1, w1), P(u1, y1, w1), P(u1, y1, w0), P(u0, y1, w0), top);
  }
  build(H) {
    const { deck, paint, net, lamp, pool } = H.G, D = this.D, Y = this.y, r = this.roofY;
    const steel = col(0x6c7278), dark = col(0x3a3e44), white = col(0xe8e8e2), yellow = col(0xf2b705), red = col(0xc8282e);
    // ---- the deck: its painted top (the canvas texture), steel edges; solid (collision) on top and round the sides
    const c = [this.W(-D, Y, D), this.W(D, Y, D), this.W(D, Y, -D), this.W(-D, Y, -D)];
    deck.quad(c[0], c[1], c[2], c[3], col(0xffffff), [[1, 0], [1, 1], [0, 1], [0, 0]]); // (texture v along u, x along w: the H's legs point at the view)
    this.cm.tri(c[0], c[1], c[2], 0, 1.2); this.cm.tri(c[0], c[2], c[3], 0, 1.2);
    for (let k = 0; k < 4; k++) {
      const a = c[k], bb = c[(k + 1) % 4], a2 = a.clone().setY(Y - SLAB), b2 = bb.clone().setY(Y - SLAB);
      paint.quad(a2, b2, bb, a, steel); this.cm.tri(a2, b2, bb, 0, 0.6); this.cm.tri(a2, bb, a, 0, 0.6);
    }
    // under it: a grid of steel columns and beams standing on the roof
    const n = Math.max(2, Math.round(D / 4));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const u = -D + 0.4 + (i / n) * (2 * D - 0.8), w = -D + 0.4 + (j / n) * (2 * D - 0.8);
      this.box(paint, u - 0.18, u + 0.18, r - 0.2, Y - SLAB, w - 0.18, w + 0.18, steel);
    }
    for (let i = 0; i <= n; i++) { const u = -D + 0.4 + (i / n) * (2 * D - 0.8); this.box(paint, u - 0.15, u + 0.15, Y - SLAB - 0.45, Y - SLAB, -D + 0.2, D - 0.2, dark); }
    // ---- safety net round the edge: a shelf just below the deck, rising outwards, on brackets; a gap for the stair
    const gap = (side, t) => side === this.back * 2 && Math.abs(t) < STAIR_W / 2 + 0.2;
    for (let k = 0; k < 4; k++) {
      const [nu, nw] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k], side = nu * 2 + nw * 3; // (side === back*2: the stair house end)
      const segs = [[-D - NET, D + NET]];
      if (side === this.back * 2) segs.splice(0, 1, [-D - NET, -STAIR_W / 2 - 0.2], [STAIR_W / 2 + 0.2, D + NET]);
      for (const [t0, t1] of segs) {
        // t runs along the edge; in: the deck edge at Y - 0.3, out: NET further at Y - 0.05
        const P = (t, o, y) => (nu ? this.W(nu * (D + o), y, t) : this.W(t, y, nw * (D + o)));
        const tt0 = Math.max(t0, -D), tt1 = Math.min(t1, D);
        const q = [P(tt0, 0, Y - 0.3), P(tt1, 0, Y - 0.3), P(t1, NET, Y - 0.05), P(t0, NET, Y - 0.05)];
        const uv = [[tt0 / 1.2, 0], [tt1 / 1.2, 0], [t1 / 1.2, NET / 1.2], [t0 / 1.2, NET / 1.2]];
        net.quad(q[0], q[1], q[2], q[3], col(0xffffff), uv); net.quad(q[3], q[2], q[1], q[0], col(0xffffff), [uv[3], uv[2], uv[1], uv[0]]);
        // the outer rail: a tube (square section) along the net's edge
        const o0 = P(t0, NET, Y - 0.05), o1 = P(t1, NET, Y - 0.05), d = new THREE.Vector3(nu ? 0 : 0, 0.06, 0);
        paint.quad(o0.clone().sub(d), o1.clone().sub(d), o1.clone().add(d), o0.clone().add(d), yellow);
        paint.quad(o1.clone().sub(d), o0.clone().sub(d), o0.clone().add(d), o1.clone().add(d), yellow);
        for (let t = t0; t <= t1 + 0.01; t += Math.max(1.5, (t1 - t0) / Math.ceil((t1 - t0) / 2.4))) { // brackets
          const a = P(t, 0, Y - SLAB), bb = P(t, NET, Y - 0.08), e = new THREE.Vector3(0, 0.05, 0);
          paint.quad(a.clone().sub(e), bb.clone().sub(e), bb.clone().add(e), a.clone().add(e), dark); paint.quad(bb.clone().sub(e), a.clone().sub(e), a.clone().add(e), bb.clone().add(e), dark);
        }
      }
      // green edge lights along the deck edge, every ~3 m: little lamps that glow green after dark, with small glow
      // points (the world's night-light points at a third of their size: these sit close together)
      const m = Math.round(2 * D / 3);
      for (let i = 0; i <= m; i++) {
        const t = -D + (i / m) * 2 * D; if (gap(side, t)) continue;
        const p = nu ? this.W(nu * (D + 0.15), Y + 0.08, t) : this.W(t, Y + 0.08, nw * (D + 0.15));
        this.lightBox(lamp, p.clone().setY(Y - 0.02), 0.1, 0.14, col(0x48e060)); H.lamp(p.clone().setY(Y + 0.15), [0.25, 1, 0.35], true);
      }
      // a flood light in the middle of each side, on a short post at the net's outer rail, aimed back at the deck
      if (side !== this.back * 2) {
        const base = nu ? this.W(nu * (D + NET - 0.1), Y - 0.05, 0) : this.W(0, Y - 0.05, nw * (D + NET - 0.1));
        const head = base.clone().setY(Y + 0.45), toward = nu ? this.W(0, 0, 0).sub(this.W(nu, 0, 0)) : this.W(0, 0, 0).sub(this.W(0, 0, nw));
        toward.y = 0; toward.normalize();
        this.post(paint, base, head, dark);
        const side2 = new THREE.Vector3(-toward.z, 0, toward.x), hw = 0.45, hh = 0.25;
        const f = (a, bb) => head.clone().addScaledVector(side2, a).add(V(0, bb, 0)).addScaledVector(toward, 0.16);
        const bk = (a, bb) => head.clone().addScaledVector(side2, a).add(V(0, bb, 0)).addScaledVector(toward, -0.16);
        paint.quad(bk(hw, hh), bk(-hw, hh), bk(-hw, -hh), bk(hw, -hh), dark); // back
        paint.quad(bk(-hw, hh), bk(hw, hh), f(hw, hh), f(-hw, hh), dark); // top
        paint.quad(bk(-hw, hh), f(-hw, hh), f(-hw, -hh), bk(-hw, -hh), dark); paint.quad(f(hw, hh), bk(hw, hh), bk(hw, -hh), f(hw, -hh), dark);
        lamp.quad(f(-hw + 0.05, hh - 0.05), f(hw - 0.05, hh - 0.05), f(hw - 0.05, -hh + 0.05), f(-hw + 0.05, -hh + 0.05), col(0xfff4dc));
        H.lamp(f(0, 0).addScaledVector(toward, 0.05), [1, 0.94, 0.8]);
      }
    }
    // the night pool of flood light on the deck (an additive glow; its opacity follows the night)
    { const R = D * 1.25, q = [this.W(-R, Y + 0.04, -R), this.W(R, Y + 0.04, -R), this.W(R, Y + 0.04, R), this.W(-R, Y + 0.04, R)];
      pool.quad(q[0], q[3], q[2], q[1], col(0xffffff), [[0, 0], [0, 1], [1, 1], [1, 0]]); }
    // ---- the stair house on the roof behind the deck, a stair up to the deck, a red light on top
    const bu = this.back, run = Math.ceil((Y - r) / 0.2) * 0.26, su0 = bu * (D + run + 1.2), su1 = bu * (D + run + 5.2), sw = 2.2, sh = 3.2;
    const [a0, a1] = su0 < su1 ? [su0, su1] : [su1, su0];
    if (this.hl + Math.abs(this.off) > D + run + 6) {
      this.box(paint, a0, a1, r - 0.2, r + sh, -sw, sw, col(0xc8c4bc), col(0x8a8680));
      this.box(paint, a0 - 0.15, a1 + 0.15, r + sh, r + sh + 0.25, -sw - 0.15, sw + 0.15, col(0x9a9690)); // roof cap
      const fu = su0 - bu * 0.02; // the door, facing the deck
      paint.quad(this.W(fu, r, -bu * 0.6), this.W(fu, r, bu * 0.6), this.W(fu, r + 2.2, bu * 0.6), this.W(fu, r + 2.2, -bu * 0.6), col(0x2c3a4a));
      lamp.quad(this.W(fu - bu * 0.01, r + 2.45, -bu * 0.25), this.W(fu - bu * 0.01, r + 2.45, bu * 0.25), this.W(fu - bu * 0.01, r + 2.65, bu * 0.25), this.W(fu - bu * 0.01, r + 2.65, -bu * 0.25), col(0xfff0d0));
      H.lamp(this.W(fu - bu * 0.15, r + 2.55, 0), [1, 0.85, 0.6]);
      H.lamp(this.W((a0 + a1) / 2, r + sh + 0.6, 0), [1, 0.12, 0.08]); // obstruction light
      this.post(paint, this.W((a0 + a1) / 2, r + sh + 0.25, 0), this.W((a0 + a1) / 2, r + sh + 0.55, 0), dark);
      this.solids.push({ u0: a0 - 0.3, u1: a1 + 0.3, w0: -sw - 0.3, w1: sw + 0.3, y0: r - 1, y1: r + sh + 0.9 });
    }
    // the stair: from the deck's back edge down to the roof, towards the stair house door
    { const steps = Math.ceil((Y - r) / 0.2), u0 = bu * D, w = STAIR_W / 2;
      for (let k = 0; k < steps; k++) {
        const ua = u0 + bu * k * 0.26, ub = ua + bu * 0.26, y = Y - (k + 1) * (Y - r) / steps;
        const [p0, p1] = ua < ub ? [ua, ub] : [ub, ua];
        this.box(paint, p0, p1, y - 0.06, y, -w, w, col(0x8a9096));
      }
      for (const sd of [-1, 1]) { // stringers and hand rails
        const top = this.W(u0, Y, sd * (w + 0.05)), bot = this.W(u0 + bu * run, r, sd * (w + 0.05)), up = V(0, 1, 0);
        paint.quad(bot, top, top.clone().addScaledVector(up, 1.0), bot.clone().addScaledVector(up, 1.0), dark);
        paint.quad(top, bot, bot.clone().addScaledVector(up, 1.0), top.clone().addScaledVector(up, 1.0), dark);
      }
    }
    // ---- the windsock: a mast on the roof by the deck's back corner, the sock turned by the wind each frame (update)
    { const cu = bu * (D + NET + 1.5), cw = Math.min(D + NET + 1.5, this.hw - 1.5), base = this.W(cu, r, cw), h = 6;
      this.post(paint, base, base.clone().setY(r + h), col(0xe8e8e2), 0.09);
      H.lamp(base.clone().setY(r + h + 0.25), [1, 0.12, 0.08]);
      this.solids.push({ u0: cu - 0.5, u1: cu + 0.5, w0: cw - 0.5, w1: cw + 0.5, y0: r - 1, y1: r + h + 0.5 });
      this.sockAt = base.clone().setY(r + h - 0.2);
    }
  }
  // a thin square post from a to b
  post(G, a, b, color, r = 0.06) {
    const e1 = V(r, 0, 0), e2 = V(0, 0, r);
    for (const [s, t] of [[e1, e2], [e2, e1.clone().negate()], [e1.clone().negate(), e2.clone().negate()], [e2.clone().negate(), e1]]) G.quad(a.clone().add(t), a.clone().add(s), b.clone().add(s), b.clone().add(t), color);
  }
  // a small lamp body (all faces glow after dark)
  lightBox(G, p, s, h, color) {
    const q = (dx, dz) => p.clone().add(V(dx, 0, dz));
    G.quad(q(-s, s).add(V(0, h, 0)), q(s, s).add(V(0, h, 0)), q(s, -s).add(V(0, h, 0)), q(-s, -s).add(V(0, h, 0)), color);
    for (const [a, b] of [[q(-s, s), q(s, s)], [q(s, s), q(s, -s)], [q(s, -s), q(-s, -s)], [q(-s, -s), q(-s, s)]]) G.quad(a, b, b.clone().add(V(0, h, 0)), a.clone().add(V(0, h, 0)), color);
  }
  hit(p) {
    const dx = p.x - this.cx, dz = p.z - this.cz; if (dx * dx + dz * dz > (this.hl + this.hw + 20) ** 2 || p.y < this.roofY - 2 || p.y > this.roofY + 12) return null;
    const [u, w] = this.local(p.x, p.z);
    for (const s of this.solids) if (u > s.u0 && u < s.u1 && w > s.w0 && w < s.w1 && p.y > s.y0 && p.y < s.y1) {
      const c = this.W((s.u0 + s.u1) / 2, 0, (s.w0 + s.w1) / 2), t = [c.x, s.y0, c.z, s.y1 - s.y0, Math.hypot(s.u1 - s.u0, s.w1 - s.w0) / 2]; t.solid = true; return t;
    }
    return null;
  }
  // how far (x, z) is from the middle of the H, on the deck's level
  onDeck(x, z, m = 0) { const [u, w] = this.local(x, z); return Math.abs(u) < this.D + m && Math.abs(w) < this.D + m; }
}

export class Helipads {
  // cfgs: realCity.js CityScenery.helipads (each with .roof when its building was found)
  constructor(world, cfgs) {
    this.w = world;
    this.G = { deck: new Geo(), paint: new Geo(), net: new Geo(), lamp: new Geo(), pool: new Geo() };
    this.lamps = []; this.lampCol = []; this.small = []; this.smallCol = [];
    this.pads = cfgs.filter((c) => c.roof?.box).map((c) => new Pad(this, c));
    this.start = this.pads.find((p) => p.start) || null;
    this.cms = this.pads.map((p) => p.cm);
    this.buildMeshes();
  }
  lamp(p, c, small = false) { (small ? this.small : this.lamps).push(p.x, p.y, p.z); (small ? this.smallCol : this.lampCol).push(...c); }
  buildMeshes() {
    const G = this.G, grp = (this.group = new THREE.Group()); grp.name = 'helipads';
    this.mats = {
      deck: new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.85, metalness: 0.05 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
      net: new THREE.MeshStandardMaterial({ map: netTexture(), color: 0x2a2c2e, alphaTest: 0.5, roughness: 0.9 }),
      lamp: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 }), // (glows in its own colour: below)
      pool: new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(1.0, 0.94, 0.8), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
    };
    this.mats.lamp.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor;'); };
    this.meshes = {};
    for (const k of ['deck', 'paint', 'net', 'lamp', 'pool']) {
      if (!G[k].count) continue;
      const m = new THREE.Mesh(G[k].geometry(), this.mats[k]); m.name = 'helipad-' + k;
      m.castShadow = k === 'deck' || k === 'paint'; m.receiveShadow = k !== 'pool';
      if (k === 'pool') m.renderOrder = 2;
      grp.add(m); this.meshes[k] = m;
    }
    // the lamps: glow points on the world's night-light material (shown after dark)
    const points = (P, C, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); grp.add(new THREE.Points(g, mat)); };
    if (this.lamps.length) points(this.lamps, this.lampCol, this.w.lightsMat);
    if (this.small.length) { this.mats.small = this.w.lightsMat.clone(); this.mats.small.size = this.w.lightsMat.size / 3; points(this.small, this.smallCol, this.mats.small); } // (switched with the world's)
    // windsocks: one small mesh each, turned by the wind
    const sg = sockGeometry(), sm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    this.socks = this.pads.map((p) => { const m = new THREE.Mesh(sg, sm); m.position.copy(p.sockAt); m.castShadow = true; grp.add(m); return m; });
    this.mats.sock = sm;
    this.stats = { pads: this.pads.length, tris: Object.values(G).reduce((a, g) => a + g.count / 3, 0), collTris: this.cms.reduce((a, c) => a + c.n, 0) };
    this.G = null;
    this.w.group.add(this.w.nearShadow ? this.w.nearShadow(grp) : grp);
  }
  // ---- collision (World.maxGround / surfRay / surfPoint / treeHit) ----
  topAt(x, z) { let t = -Infinity; for (const c of this.cms) t = Math.max(t, c.topAt(x, z)); return t; }
  hit(p) { for (const pad of this.pads) { const t = pad.hit(p); if (t) return t; } return null; }
  // ---- per frame: lights after dark, the socks in the wind ----
  update(dt, world) {
    const night = world.night || (world.W?.dark ?? 0) > 0.55;
    if (this.mats.small) this.mats.small.opacity = world.lightsMat.opacity;
    if (night !== this.night) { this.night = night; this.mats.lamp.emissiveIntensity = night ? 12 : 0.2; this.mats.pool.opacity = night ? 0.5 : 0; }
    const w = world.windBase, sp = Math.hypot(w.x, w.z), droop = 1.35 - Math.min(1, sp / 8) * 1.2; // limp in calm air, straight out in a breeze
    const yaw = sp > 0.05 ? Math.atan2(w.x, w.z) : 0; // (the sock points downwind)
    this.sway = (this.sway || 0) + dt;
    for (const s of this.socks) s.rotation.set(droop + Math.sin(this.sway * 3.1) * 0.05, yaw + Math.sin(this.sway * 2.3) * 0.08 * Math.min(1, sp / 3), 0, 'YXZ');
  }
  dispose() { for (const [k, m] of Object.entries(this.mats)) { if (k !== 'pool' && k !== 'small') m.map?.dispose(); m.dispose(); } } // (the glow texture is shared)
}

// the sock: a tapered cone, orange and white bands, along +z from its hoop at the mast top (then turned by the wind)
function sockGeometry() {
  const G = new Geo(), seg = 10, L = 2.6, r0 = 0.32, r1 = 0.14, bands = 5;
  for (let b = 0; b < bands; b++) {
    const z0 = (b / bands) * L, z1 = ((b + 1) / bands) * L, ra = r0 + (r1 - r0) * (b / bands), rb = r0 + (r1 - r0) * ((b + 1) / bands);
    const c = b % 2 ? col(0xf2f2ee) : col(0xff5a14);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      G.quad(V(Math.cos(a0) * ra, Math.sin(a0) * ra, z0), V(Math.cos(a1) * ra, Math.sin(a1) * ra, z0), V(Math.cos(a1) * rb, Math.sin(a1) * rb, z1), V(Math.cos(a0) * rb, Math.sin(a0) * rb, z1), c);
    }
  }
  const g = G.geometry(); g.translate(0.15, 0, 0.1); // (hung off the mast's side)
  return g;
}
