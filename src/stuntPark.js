// The stunt park: a dirt stunt-driving arena on a levelled pad (loc.stunts, the Grand Canyon's): kicker ramps, a
// tabletop, a loop-the-loop, a banked turn, a wall-ride bowl, a jump across a gap between two red-rock mesas, whoops,
// berms, boost pads, a start arch, tyre barriers, flags, grandstands with a crowd and floodlights.
//
// Everything you can drive on is also a triangle in one CollisionMesh (collide.js): the flight model's wheel rays and
// hull points hit it (env.surfRay / env.surfPoint in main.js), so cars drive up ramps, round the loop upside down and
// along the bowl's wall, and planes land on, or crash into, the structures.
//
// Cheap to draw: four merged meshes (earth, paint, signs, lamps) plus the night light pools, shared materials, no new
// lights (the light set is fixed: see main.js applyQuality), so nothing compiles mid-flight.
//
// Layout (park frame: metres from the pad centre, x east, z south in the game frame, y up from the pad):
//   straight 1 (z = +30, heading +x): start arch, three kickers, tabletop, boost, loop
//   east turn: banked (20 degrees)            straight 2 (z = -30, heading -x): boost, mesa ramp, gap, landing, whoops
//   west turn: the bowl (wall ride)
import * as THREE from 'three';
import { CollisionMesh } from './collide.js';
import { mulberry32, clamp, smoothstep } from './noise.js';
import { glowTexture } from './materials.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Y = V(0, 1, 0);
const PAINT = 0, DIRT = 1, ROCK = 2; // collide.js SURFACES ids: 'runway' (smooth: painted steel/concrete), 'sand' (dust), 'rock'
const PAD = { hx: 236, hz: 96 }; // the dirt pad (drape) half size
const FLAT = 180, BLEND = 200; // ground levelled this far beyond it, then blended back into the real terrain
const XS = 170, RT = 30, TW = 7, LANE = 3.5; // straights' ends, turn radius, track half width, lane offset
const col = (h) => new THREE.Color(h);

// ---- the levelled pad (World.rawHeight flattens the terrain to this) ----
export function stuntPad(w, cfg) {
  let s = 0, n = 0;
  for (let x = -PAD.hx; x <= PAD.hx; x += 24) for (let z = -PAD.hz; z <= PAD.hz; z += 24) { s += w.height(cfg.x + x, cfg.z + z); n++; }
  return { x: cfg.x, z: cfg.z, hx: PAD.hx + FLAT, hz: PAD.hz + FLAT, blend: BLEND, h: Math.round((s / n) * 10) / 10 };
}
export function padHeight(P, x, z, h) {
  const dx = Math.max(0, Math.abs(x - P.x) - P.hx), dz = Math.max(0, Math.abs(z - P.z) - P.hz);
  if (dx >= P.blend || dz >= P.blend) return h;
  return h + (P.h - h) * (1 - smoothstep(0, P.blend, Math.hypot(dx, dz)));
}

// ---- profiles along a ramp: height h(s) for s in [0, L] ----
const kicker = (H, deg) => { const a = (deg * Math.PI) / 180, R = H / (1 - Math.cos(a)), L = R * Math.sin(a); return { L, H, h: (s) => (s <= 0 ? 0 : s >= L ? H : R - Math.sqrt(R * R - s * s)) }; };
// down from H to 0 at slope `deg`, rounded over r0 m at the top and r1 m at the bottom (a landing)
function descent(H, deg, r0, r1) {
  const k = Math.tan((deg * Math.PI) / 180), L = H / k + (r0 + r1) / 2, n = 400, tab = new Float32Array(n + 1);
  let y = 0; tab[0] = 0;
  for (let i = 1; i <= n; i++) { const s = (L * (i - 0.5)) / n; y += k * smoothstep(0, r0, s) * (1 - smoothstep(L - r1, L, s)) * (L / n); tab[i] = y; }
  const sc = H / y;
  return { L, H, h: (s) => { const f = clamp(s / L, 0, 1) * n, i = Math.min(n - 1, f | 0), t = f - i; return H - (tab[i] * (1 - t) + tab[i + 1] * t) * sc; } };
}
// the loop: curvature grows smoothly into a teardrop (wide at the bottom, tight at the top), no sudden g at the entry
function loopCurve(Rtop, Rbot, thc) {
  const rho = (th) => { const e = Math.min(th, 2 * Math.PI - th); let r = Rtop + (Rbot - Rtop) * Math.cos(th / 2) ** 2; if (e < thc) r *= thc / Math.max(e, 0.012); return r; };
  const pts = [V(0, 0, 0)]; let x = 0, y = 0, th = 0.006, acc = 0; const d = 0.0005;
  while (th < 2 * Math.PI - 0.006) { const ds = rho(th + d / 2) * d; x += Math.cos(th + d / 2) * ds; y += Math.sin(th + d / 2) * ds; th += d; acc += ds; if (acc >= 0.7) { pts.push(V(x, y, 0)); acc = 0; } }
  pts.push(V(x, Math.max(0, y), 0));
  return pts;
}

// ---- a geometry accumulator: non-indexed triangles with normals, vertex colours and planar uvs ----
class Geo {
  constructor(uvScale = 0.2) { this.p = []; this.n = []; this.c = []; this.u = []; this.k = uvScale; }
  vert(p, n, c) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.c.push(c.r, c.g, c.b);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z), k = this.k;
    if (ay >= ax && ay >= az) this.u.push(p.x * k, p.z * k); else if (ax >= az) this.u.push(p.z * k, p.y * k); else this.u.push(p.x * k, p.y * k);
  }
  get tris() { return this.p.length / 9; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
const _a = V(), _b = V();
const faceN = (a, b, c) => _a.subVectors(b, a).cross(_b.subVectors(c, a)).normalize().clone();

export class StuntPark {
  constructor(world, cfg) {
    const t0 = performance.now();
    this.w = world; const P = world.stuntPad;
    this.O = V(P.x, P.h, P.z); // the park frame's origin in the world
    this.cm = new CollisionMesh(4);
    this.G = { earth: new Geo(0.11), paint: new Geo(), sign: new Geo(), lamp: new Geo(), pool: new Geo() };
    this.boosts = []; this.rnd = mulberry32(911);
    this.layout();
    this.cm.build();
    this.buildMeshes(world);
    // start: at the arch, in the right-hand lane, facing the first kicker (heading: 0 = -z, -pi/2 = +x)
    this.start = { pos: V(-126, 0, 30 + LANE).add(this.O), heading: -Math.PI / 2, lane: LANE };
    this.st = { air: 0, upside: false };
    this.stats.buildMs = Math.round(performance.now() - t0);
  }
  // world <-> park frame
  W(p) { return V(p.x + this.O.x, p.y + this.O.y, p.z + this.O.z); }
  local(x, z) { return [x - this.O.x, z - this.O.z]; }
  inside(x, z, m = 0) { const [lx, lz] = this.local(x, z); return Math.abs(lx) < PAD.hx + m && Math.abs(lz) < PAD.hz + m; }
  bare(x, z) { return this.inside(x, z, 12); } // no trees or grass tufts on the pad
  topAt(x, z) { return this.cm.topAt(x, z); }

  // ---- primitives (park frame; coll: [type, depth] adds the triangles to the collision mesh) ----
  tri(geo, a, b, c, color, coll, na, nb, nc) {
    const fn = faceN(a, b, c);
    geo.vert(a, na || fn, color); geo.vert(b, nb || fn, color); geo.vert(c, nc || fn, color);
    if (coll) this.cm.tri(this.W(a), this.W(b), this.W(c), coll[0], coll[1], na, nb, nc);
  }
  // a quad a-b-c-d; out: the side it faces (flips it to match); ns: vertex normals
  quad(geo, a, b, c, d, color, coll = null, out = null, ns = null) {
    if (out) { const n = faceN(a, b, c).add(faceN(a, c, d)); if (n.dot(out) < 0) { [b, d] = [d, b]; if (ns) ns = [ns[0], ns[3], ns[2], ns[1]]; } }
    this.tri(geo, a, b, c, color, coll, ns?.[0], ns?.[1], ns?.[2]);
    this.tri(geo, a, c, d, color, coll, ns?.[0], ns?.[2], ns?.[3]);
  }
  // box standing on y0 (no bottom), turned yaw about y
  box(geo, x, y0, z, sx, sy, sz, yaw, color, coll = null, top = color) {
    const c = Math.cos(yaw), s = Math.sin(yaw), P = (u, v, w) => V(x + u * c + w * s, y0 + v, z - u * s + w * c);
    const hx = sx / 2, hz = sz / 2, ctr = V(x, y0 + sy / 2, z);
    const faces = [[[-hx, 0, hz], [hx, 0, hz], [hx, sy, hz], [-hx, sy, hz]], [[hx, 0, -hz], [-hx, 0, -hz], [-hx, sy, -hz], [hx, sy, -hz]],
      [[hx, 0, hz], [hx, 0, -hz], [hx, sy, -hz], [hx, sy, hz]], [[-hx, 0, -hz], [-hx, 0, hz], [-hx, sy, hz], [-hx, sy, -hz]], [[-hx, sy, hz], [hx, sy, hz], [hx, sy, -hz], [-hx, sy, -hz]]];
    faces.forEach((f, i) => { const q = f.map((v) => P(...v)); const m = q.reduce((a, b) => a.add(b), V()).multiplyScalar(0.25); this.quad(geo, ...q, i === 4 ? top : color, coll, m.sub(ctr)); });
  }
  // vertical cylinder (r0 at the bottom, r1 at the top)
  cyl(geo, x, y0, z, r0, r1, h, seg, color, cap = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const n0 = V(c0, 0, s0), n1 = V(c1, 0, s1);
      this.quad(geo, V(x + c0 * r0, y0, z + s0 * r0), V(x + c1 * r0, y0, z + s1 * r0), V(x + c1 * r1, y0 + h, z + s1 * r1), V(x + c0 * r1, y0 + h, z + s0 * r1), color, null, n0.clone().add(n1), [n0, n1, n1, n0]);
      if (cap) this.tri(geo, V(x, y0 + h, z), V(x + c1 * r1, y0 + h, z + s1 * r1), V(x + c0 * r1, y0 + h, z + s0 * r1), color);
    }
  }
  // A heightfield ribbon along a path: path(s) -> { p (ground point on the centreline), t (forward), r (right) };
  // cross(s) -> [[a, y], ...] across it (a along r, y up). Solid down to the ground: side walls and end caps.
  sweep(geo, o) {
    const { s0, s1, n, path, cross } = o, rows = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n, f = path(s), cs = cross(s);
      rows.push({ s, f, pts: cs.map(([a, y]) => f.p.clone().addScaledVector(f.r, a).addScaledVector(Y, y)) });
    }
    const K = rows[0].pts.length, at = (i, k) => rows[clamp(i, 0, n)].pts[clamp(k, 0, K - 1)];
    const nrm = (i, k) => { const da = _a.subVectors(at(i, k + 1), at(i, k - 1)), ds = _b.subVectors(at(i + 1, k), at(i - 1, k)); return da.clone().cross(ds).normalize(); };
    const N = rows.map((r, i) => r.pts.map((p, k) => nrm(i, k)));
    for (let i = 0; i < n; i++) for (let k = 0; k < K - 1; k++) {
      const a = at(i, k), b = at(i, k + 1), c = at(i + 1, k + 1), d = at(i + 1, k);
      if (a.distanceTo(b) < 1e-4 && d.distanceTo(c) < 1e-4) continue;
      const t = o.type ? o.type(rows[i].s, k) : null, ns = o.flat ? null : [N[i][k], N[i][k + 1], N[i + 1][k + 1], N[i + 1][k]];
      this.quad(geo, a, b, c, d, o.color(rows[i].s, k, (a.y + c.y) / 2), t == null ? null : [t, o.depth ?? 1.2], Y, ns);
    }
    if (o.walls === false) return rows;
    const wc = o.wallColor || (() => o.color(0, 0, 0)), wt = o.wallType ?? ROCK, band = o.band || 99;
    const wall = (p0, p1, q0, q1, out) => { // vertical strip from the top edge p0-p1 down to the ground, in height bands
      const top = Math.max(p0.y, p1.y); if (top < 0.02) return;
      for (let y = 0; y < top; y += band) {
        const ya = y, yb = Math.min(top, y + band), cl = (p, yy) => V(p.x, Math.min(p.y, yy), p.z);
        const A = cl(p0, ya), B = cl(p1, ya), C = cl(p1, yb), D = cl(p0, yb);
        if (C.y - B.y < 0.01 && D.y - A.y < 0.01) continue;
        this.quad(geo, A, B, C, D, wc(ya, out), [wt, 1.0], out);
      }
    };
    for (let i = 0; i < n; i++) {
      const fl = rows[i].f.r.clone().negate();
      wall(at(i, 0), at(i + 1, 0), null, null, fl);
      wall(at(i, K - 1), at(i + 1, K - 1), null, null, rows[i].f.r.clone());
    }
    if (o.caps !== false) for (const [i, out] of [[0, rows[0].f.t.clone().negate()], [n, rows[n].f.t.clone()]]) for (let k = 0; k < K - 1; k++) wall(at(i, k), at(i, k + 1), null, null, out);
    return rows;
  }
  // a polygon cross-section [[a, h], ...] (counter-clockwise) swept along frames [{ p, b, n }] (b: across, n: up)
  extrude(geo, frames, poly, colorOf, type, depth) {
    const E = poly.length;
    for (let e = 0; e < E; e++) {
      const [a0, h0] = poly[e], [a1, h1] = poly[(e + 1) % E], l = Math.hypot(a1 - a0, h1 - h0), oa = (h1 - h0) / l, oh = -(a1 - a0) / l;
      for (let i = 0; i < frames.length - 1; i++) {
        const F0 = frames[i], F1 = frames[i + 1], P = (F, a, h) => F.p.clone().addScaledVector(F.b, a).addScaledVector(F.n, h);
        const o0 = F0.b.clone().multiplyScalar(oa).addScaledVector(F0.n, oh), o1 = F1.b.clone().multiplyScalar(oa).addScaledVector(F1.n, oh);
        this.quad(geo, P(F0, a0, h0), P(F0, a1, h1), P(F1, a1, h1), P(F1, a0, h0), colorOf(i, e), type == null ? null : [type(e), depth(e)], o0.clone().add(o1), [o0, o0, o1, o1]);
      }
    }
  }

  // ---- the park ----
  layout() {
    const E = this.G.earth, Pn = this.G.paint, r = this.rnd;
    const dirt = col(0xc49a6a), dirtD = col(0x8f6440), chalk = col(0xe8e2d4), nz2 = this.w.noise;
    // the pad: a cleared lot of packed dirt with a ragged edge (a rounded rectangle, its rim wobbled by noise), patchy,
    // with darker worn ground along the track and the real ground's colour creeping in at the rim
    const real = this.w.real, cc = new THREE.Color(), step = 6, nx = Math.round((PAD.hx * 2) / step), nz = Math.round((PAD.hz * 2) / step);
    const rim = (x, z) => (Math.abs(x) / PAD.hx) ** 5 + (Math.abs(z) / PAD.hz) ** 5 - 0.12 * nz2.fbm(x / 40 + 3, z / 40, 3); // < 1 inside
    const vcol = (x, z) => {
      const t = smoothstep(1, 0.55, rim(x, z)), f = nz2.fbm(x / 70, z / 70 + 11, 4), worn = Math.max(1 - Math.abs(Math.abs(z) - RT) / 16, 0) * (Math.abs(x) < XS + 10 ? 1 : 0);
      const base = dirt.clone().multiplyScalar(0.9 + 0.22 * f + 0.05 * r()).lerp(dirtD, 0.35 * worn);
      if (real) { real.color(x + this.O.x, z + this.O.z, cc); cc.convertSRGBToLinear(); } else cc.copy(dirtD);
      return cc.clone().lerp(base, t);
    };
    const grid = []; for (let j = 0; j <= nz; j++) { grid.push([]); for (let i = 0; i <= nx; i++) { const x = -PAD.hx + i * step, z = -PAD.hz + j * step; grid[j].push({ p: V(x, 0.03, z), c: vcol(x, z), in: rim(x, z) < 1 }); } }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      if (a.in && b.in && c.in) { E.vert(a.p, Y, a.c); E.vert(c.p, Y, c.c); E.vert(b.p, Y, b.c); }
      if (a.in && c.in && d.in) { E.vert(a.p, Y, a.c); E.vert(d.p, Y, d.c); E.vert(c.p, Y, c.c); }
    }
    // the track: groomed darker dirt with chalk edges (on the pad: the terrain is the collision surface)
    const straight = (x0, z, dir) => (s) => ({ p: V(x0 + dir * s, 0, z), t: V(dir, 0, 0), r: V(0, 0, dir) });
    const arc = (cx, psi0) => (s) => { const ps = psi0 - s / RT; return { p: V(cx + RT * Math.cos(ps), 0, RT * Math.sin(ps)), t: V(Math.sin(ps), 0, -Math.cos(ps)), r: V(Math.cos(ps), 0, Math.sin(ps)) }; };
    this.path1 = straight(-XS, RT, 1); this.path2 = straight(XS, -RT, -1);
    const trackX = [[-TW, 0.06], [-TW + 0.4, 0.06], [TW - 0.4, 0.06], [TW, 0.06]];
    const trackC = (s, k) => (k === 1 ? dirtD.clone().multiplyScalar(0.94 + 0.12 * Math.sin(s * 1.7) ** 2) : chalk);
    for (const pth of [this.path1, this.path2]) this.sweep(E, { s0: 0, s1: XS * 2, n: 34, path: pth, cross: () => trackX, color: trackC, walls: false, flat: true });

    this.straight1(); this.straight2();
    this.bankedTurn(arc(XS, Math.PI / 2));
    this.bowl(arc(-XS, -Math.PI / 2));
    this.dressing();
  }

  straight1() {
    const E = this.G.earth, Pn = this.G.paint, p1 = this.path1, lane = (pth, dl) => (s) => { const f = pth(s); f.p.addScaledVector(f.r, dl); return f; };
    const yel = col(0xffc81e), blk = col(0x1c1c1c), red = col(0xe0262a), wht = col(0xf2f2ee), steel = col(0x6c7178);
    // kickers: painted steel, yellow and black chevron stripes (small, medium; in the right-hand lane)
    for (const [s0, H, deg, w] of [[66, 0.6, 16, 6.5], [92, 1.1, 19, 6.5]]) { // (the track's full width: half on a kicker would flip you)
      const k = kicker(H, deg);
      this.sweep(Pn, { s0, s1: s0 + k.L, n: 10, path: p1, cross: (s) => [[-w, k.h(s - s0)], [0, k.h(s - s0)], [w, k.h(s - s0)]], color: (s, kk) => ((Math.floor((s - s0) * 1.4) + kk) % 2 ? yel : blk), type: () => PAINT, depth: 1.0, wallColor: () => steel, wallType: PAINT });
    }
    // the tabletop: up a big kicker, across a dirt table, down a landing
    { const s0 = 116, k = kicker(2.4, 14), T = 6, d = descent(2.4, 12, 1.5, 4), L = k.L + T + d.L, w = 6.5;
      const h = (s) => { const u = s - s0; return u < k.L ? k.h(u) : u < k.L + T ? k.H : d.h(u - k.L - T); };
      this.sweep(E, { s0, s1: s0 + L, n: 40, path: p1, cross: (s) => [[-w, h(s)], [-w + 0.5, h(s)], [w - 0.5, h(s)], [w, h(s)]], color: (s, kk) => (kk !== 1 ? col(0xeeeeee) : col(0xa87850)), type: () => DIRT, depth: 1.5, wallColor: (y) => col(y > 1.2 ? 0x9a6d47 : 0x8a5f3c), wallType: DIRT });
      this.sign(p1(s0 - 6).p.add(V(0, 0, w + 6)), 'TABLETOP', 3.5, -1);
    }
    // the boost pad and the loop
    this.boost(lane(p1, LANE), 193, 16, 25, 0, false, 5.5); // (wide: you can't miss it)
    this.loop(lane(p1, 0), 212);
    // a rumble strip after it: out of the loop flat out, it slows you to a speed the banked turn can take
    this.boost(p1, 292, 14, 20, 0, true, TW, true);
  }

  straight2() {
    const E = this.G.earth, p2 = this.path2;
    // a boost to get up the mesa, the mesa ramp with a rock parapet each side, a boost on top, the lip
    this.boost(p2, 18, 14, 15, 0, true);
    const H = 6, climb = descent(H, 14, 14, 6), A0 = 40, up = climb.L, top = 10, lip = kicker(1.0, 20), AL = up + top + lip.L, gap = 12;
    const hA = (s) => { const u = s - A0; return u < up ? climb.h(up - u) : u < up + top ? H : H + lip.h(u - up - top); }; // (a long round crest: you don't take off before the lip)
    const d = descent(H, 15, 1.2, 6), B0 = A0 + AL + gap;
    const hB = (s) => d.h(s - B0);
    const mesa = (h0, rim) => (s) => { const h = h0(s), hr = Math.max(h + rim, rim); return [[-9.5, hr * 0.92], [-8, hr], [-6.4, h + 0.05], [-6, h], [6, h], [6.4, h + 0.05], [8, hr], [9.5, hr * 0.92]]; };
    const strata = [0xcf9c74, 0xb4553a, 0xa84a34, 0xc0603e, 0xd8b088, 0xb86a48, 0x9c4a30];
    const rockC = (y) => col(strata[Math.floor(y / 1.15) % strata.length]).multiplyScalar(0.9 + 0.2 * this.rnd());
    const ty = (s, k) => (k === 3 ? DIRT : ROCK), cc = (s, k, y) => (k === 3 ? col(0xb48256) : rockC(y));
    this.sweep(E, { s0: A0, s1: A0 + AL, n: 46, path: p2, cross: mesa(hA, 1.6), color: cc, type: ty, depth: 2, wallColor: rockC, band: 1.15, flat: false });
    this.sweep(E, { s0: B0, s1: B0 + d.L, n: 30, path: p2, cross: mesa(hB, 1.6), color: cc, type: ty, depth: 2, wallColor: rockC, band: 1.15 });
    this.boost(p2, A0 + up + 1, 8, 15.5, H, true);
    this.gapAt = { s0: A0 + AL, s1: B0, h: H + lip.H };
    // boulders in the gap, and a sign
    for (let i = 0; i < 9; i++) { const f = p2(A0 + AL + 1.5 + this.rnd() * (gap - 3)); this.rock(f.p.addScaledVector(f.r, (this.rnd() - 0.5) * 16), 0.5 + this.rnd() * 1.2); }
    this.sign(p2(A0 - 4).p.add(V(0, 0, -TW - 3)), 'CANYON JUMP', 5, 1);
    // whoops: rolling dirt bumps
    const W0 = 170, nb = 6, wl = 9;
    this.sweep(E, { s0: W0, s1: W0 + nb * wl, n: nb * 8, path: p2, cross: (s) => { const h = 0.75 * Math.sin((Math.PI * (s - W0)) / wl) ** 2; return [[-TW, h * 0.6], [-TW + 1, h], [TW - 1, h], [TW, h * 0.6]]; }, color: (s, k, y) => col(0x9e7048).multiplyScalar(0.85 + y * 0.3), type: () => DIRT, depth: 1, wallColor: () => col(0x8a6040), wallType: DIRT });
    this.sign(p2(W0 - 5).p.add(V(0, 0, -TW - 3)), 'WHOOPS!', 3.5, 1);
    // berms along the outside of both straights
    const berm = (pth, s0, s1, side) => this.sweep(E, { s0, s1, n: Math.ceil((s1 - s0) / 4), path: pth, cross: () => [[side * 8.5, 0], [side * 9.6, 0.9], [side * 10.4, 0.9], [side * 11.5, 0]].sort((a, b) => a[0] - b[0]), color: (s, k) => col(k === 1 ? 0x9a6a40 : 0x8e6038), type: () => DIRT, depth: 1, walls: false });
    berm(this.path1, 70, 205, 1); berm(this.path1, 258, 336, 1); berm(p2, 4, 36, 1); berm(p2, 136, 336, 1);
  }

  // a loop-the-loop: a teardrop (radius 7 m at the top, 13 m at the bottom) that also steps one lane across, so you
  // come out beside where you went in; a blue steel deck with yellow side rails, held by two towers and a top beam.
  // Needs about 24 m/s (54 mph) at the bottom: the boost pad before it gives you that.
  loop(pth, s0) {
    const Pn = this.G.paint, pts = loopCurve(7, 13, 0.42), n = pts.length, base = pth(s0);
    let len = 0; const cum = [0]; for (let i = 1; i < n; i++) { len += pts[i].distanceTo(pts[i - 1]); cum.push(len); }
    const frames = pts.map((q, i) => {
      const u = cum[i] / len, lat = LANE - 2 * LANE * smoothstep(0.22, 0.78, u);
      return base.p.clone().addScaledVector(base.t, q.x).addScaledVector(Y, q.y).addScaledVector(base.r, lat);
    }).map((p, i, P) => {
      const t = P[Math.min(n - 1, i + 1)].clone().sub(P[Math.max(0, i - 1)]).normalize();
      const b = base.r.clone().addScaledVector(t, -t.dot(base.r)).normalize();
      return { p, t, b, n: b.clone().cross(t).normalize() };
    });
    const w = 3.15, th = 0.3, rh = 0.55, rt = 0.18;
    const poly = [[-w, -th], [w, -th], [w, rh], [w - rt, rh], [w - rt, 0], [-w + rt, 0], [-w + rt, rh], [-w, rh]];
    const blue = col(0x1f6fd8), blue2 = col(0x2a86f0), yel = col(0xffd21e), steel = col(0x5d636b), wht = col(0xf4f4f4);
    const colorOf = (i, e) => (e === 0 ? steel : e === 4 ? (i % 6 < 3 ? blue : blue2) : e === 2 || e === 6 ? wht : yel);
    this.extrude(Pn, frames, poly, colorOf, (e) => (e === 0 ? PAINT : PAINT), (e) => (e === 4 ? 0.45 : 0.3));
    // painted arrows on the entry: the deck's first metres (the sign texture)
    // the guide's frames: 40 m of lane before it (it pulls you into line), then the deck's
    const lead = []; for (let d = 40; d > 0; d -= 1) lead.push({ p: base.p.clone().addScaledVector(base.t, -d).addScaledVector(base.r, LANE), t: base.t.clone(), b: base.r.clone(), n: Y.clone() });
    this.loopInfo = { s0, len, top: Math.max(...pts.map((p) => p.y)), exitX: pts[n - 1].x, frames, guide: [...lead, ...frames], lead: lead.length, i: null };
    // the frame: two lattice towers either side and a beam over the top
    const tp = this.loopInfo.top, mid = pts.reduce((a, p) => (p.y > a.y ? p : a), pts[0]);
    const cx = base.p.x + mid.x;
    for (const side of [-1, 1]) {
      const z = base.p.z + side * (LANE + w + 2.2);
      for (const dx of [-1.2, 1.2]) this.box(Pn, cx + dx, 0, z, 0.35, tp + 1.6, 0.35, 0, steel, [PAINT, 0.4]);
      for (let y = 1.5; y < tp; y += 2.2) { this.box(Pn, cx, y, z, 2.8, 0.18, 0.18, 0, steel); this.box(Pn, cx, y, z, 0.12, 0.12, 0.6, 0, steel); }
      this.box(Pn, cx, 0, z, 3.4, 0.4, 1.2, 0, col(0x8a8a86));
    }
    this.box(Pn, cx, tp + 1.3, base.p.z, 2.8, 0.5, (LANE + w + 2.5) * 2, 0, col(0xe0262a));
    this.box(Pn, cx, tp + 0.3, base.p.z - 0.4, 0.2, 1.0, 0.2, 0, steel);
    this.sign(V(cx, tp + 2.2, base.p.z), 'LOOP', 4, 0, true);
  }

  // the east turn: a dirt berm banked at up to 20 degrees, red and white kerbs, tyre wall outside
  bankedTurn(pth) {
    const E = this.G.earth, Pn = this.G.paint, L = Math.PI * RT;
    const bank = (s) => (20 * Math.PI / 180) * smoothstep(0, 16, s) * (1 - smoothstep(L - 16, L, s));
    const y = (s, a) => (a + TW) * Math.tan(bank(s));
    this.sweep(E, { s0: 0, s1: L, n: 60, path: pth, cross: (s) => [[-TW, 0], [-TW + 0.6, y(s, -TW + 0.6)], [TW - 0.6, y(s, TW - 0.6)], [TW, y(s, TW)], [TW + 1.5, y(s, TW)]], color: (s, k) => (k === 0 || k === 2 ? (Math.floor(s / 2.5) % 2 ? col(0xe0262a) : col(0xf2f2f2)) : k === 3 ? col(0x9a6a42) : col(0xa47650)), type: (s, k) => (k === 0 || k === 2 ? PAINT : DIRT), depth: 1.5, wallColor: () => col(0x8e6038), wallType: DIRT });
    for (let s = 2; s < L; s += 1.6) { const f = pth(s); this.tyres(f.p.clone().addScaledVector(f.r, TW + 3.3), 2); }
    this.wallLine(pth, 0, L, TW + 3.3, 1.0);
    this.sign(pth(L / 2).p.addScaledVector(pth(L / 2).r, TW + 6), 'BANKED TURN', 4, 0, false, pth(L / 2).r);
  }

  // the west turn: a concrete bowl, flat inside and curving up to a wall at 78 degrees: the faster you go, the higher
  // you ride (the wall ride)
  bowl(pth) {
    const Pn = this.G.paint, L = Math.PI * RT, Rw = 9, K = 12;
    const env = (s) => smoothstep(0, 24, s) * (1 - smoothstep(L - 24, L, s));
    const cross = (s) => {
      const amax = (78 * Math.PI) / 180, e = env(s), out = [[-TW, 0], [1, 0]]; // (at its ends the wall is lowered, not narrowed: you ride down off it)
      for (let k = 1; k <= K; k++) { const a = (amax * k) / K; out.push([1 + Rw * Math.sin(a), e * Rw * (1 - Math.cos(a))]); }
      const last = out[out.length - 1]; out.push([last[0] + 1.4, last[1]]);
      return out;
    };
    const conc = col(0xc9c4ba), stripe = [col(0xe0262a), col(0xffd21e), col(0x2a86f0)];
    this.sweep(Pn, { s0: 0, s1: L, n: 64, path: pth, cross, color: (s, k, yy) => (k === 0 ? col(0xbdb6aa) : k >= 2 && k <= K && k % 4 === 0 ? stripe[(k / 4 - 1) % 3] : k === K + 1 ? col(0xe8e4dc) : conc.clone().multiplyScalar(0.95 + 0.05 * Math.sin(s))), type: () => PAINT, depth: 1.6, wallColor: () => col(0xa8a298), wallType: PAINT });
    const a78 = (78 * Math.PI) / 180, rimA = 1 + Rw * Math.sin(a78), rimY = Rw * (1 - Math.cos(a78));
    let s0 = null, s1 = 0;
    for (let s = 6; s < L - 6; s += 1.6) { const f = pth(s); if (env(s) > 0.995) { this.tyres(f.p.clone().addScaledVector(f.r, rimA + 0.9).add(V(0, rimY, 0)), 2); s0 ??= s; s1 = s; } }
    this.wallLine(pth, s0, s1, rimA + 0.5, 1.5, rimY); // the tyres along the rim stop you riding over the top
    this.sign(pth(L / 2).p.addScaledVector(pth(L / 2).r, rimA + 0.9).add(V(0, rimY, 0)), 'WALL RIDE', 4.5, 0, false, pth(L / 2).r);
  }

  // a boost pad: glowing chevrons on the ground; drive over it and you are pushed up to `target` m/s
  boost(pth, s0, L, target, y = 0, exact = false, w = 2.4, rumble = false) { // exact: sets the speed both ways (a jump that needs just the right speed)
    const f0 = pth(s0), h = y + 0.08, n = Math.max(1, Math.round(L / 4)), q = (ss, a) => { const f = pth(ss); return f.p.addScaledVector(f.r, a).setY(h); };
    if (rumble) for (let i = 0; i < L / 1.2; i++) this.quad(this.G.paint, q(s0 + i * 1.2, -w), q(s0 + i * 1.2, w), q(s0 + i * 1.2 + 1.2, w), q(s0 + i * 1.2 + 1.2, -w), i % 2 ? col(0xf2f2f2) : col(0xe0262a), null, Y);
    else for (let i = 0; i < n; i++) { const sa = s0 + (L * i) / n, sb = s0 + (L * (i + 1)) / n; this.signQuad([q(sa, -w), q(sa, w), q(sb, w), q(sb, -w)], ATLAS.chev); }
    this.boosts.push({ a: this.W(f0.p.clone().setY(y)), t: f0.t.clone(), r: f0.r.clone(), L, w: w + 0.6, target, y, exact, rumble });
  }
  // stacks of old tyres, painted
  tyres(p, n = 2, onTop = false) {
    const Pn = this.G.paint, c = [col(0xe0262a), col(0xf2f2f2), col(0x1a1a1a), col(0x1a1a1a)][Math.floor(this.rnd() * 4)];
    this.cyl(Pn, p.x, p.y, p.z, 0.42, 0.42, 0.34 * n, 8, c);
  }
  // an invisible barrier wall (collision only) along a path at lateral offset `a`
  wallLine(pth, s0, s1, a, h, y0 = 0) {
    for (let s = s0; s < s1; s += 2) {
      const f0 = pth(s), f1 = pth(Math.min(s1, s + 2)), p0 = this.W(f0.p.clone().addScaledVector(f0.r, a).setY(y0)), p1 = this.W(f1.p.clone().addScaledVector(f1.r, a).setY(y0));
      const A = p0, B = p1, C = p1.clone().add(V(0, h, 0)), D = p0.clone().add(V(0, h, 0)), out = f0.r.clone().negate();
      const fn = faceN(A, B, C); if (fn.dot(out) < 0) { this.cm.tri(A, C, B, PAINT, 0.6); this.cm.tri(A, D, C, PAINT, 0.6); } else { this.cm.tri(A, B, C, PAINT, 0.6); this.cm.tri(A, C, D, PAINT, 0.6); }
    }
  }
  rock(p, s) {
    const g = new THREE.IcosahedronGeometry(s, 0), pos = g.attributes.position, c = col(0xa85a3a).multiplyScalar(0.8 + this.rnd() * 0.3);
    for (let i = 0; i < pos.count; i += 3) {
      const a = V().fromBufferAttribute(pos, i), b = V().fromBufferAttribute(pos, i + 1), d = V().fromBufferAttribute(pos, i + 2);
      for (const v of [a, b, d]) { v.y *= 0.6; v.add(p).add(V(0, s * 0.3, 0)); }
      this.tri(this.G.earth, a, b, d, c, [ROCK, s]);
    }
  }

  // ---- signs, flags, stands, lights, the start arch ----
  signQuad(q, rect) { // q: a-b-c-d (a-b along the bottom edge, left to right as read)
    const S = this.G.sign, n = faceN(q[0], q[1], q[2]), [u0, v0, u1, v1] = rect, w = col(0xffffff);
    const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const m of [i, j, k]) { S.p.push(q[m].x, q[m].y, q[m].z); S.n.push(n.x, n.y, n.z); S.c.push(w.r, w.g, w.b); S.u.push(...uv[m]); }
  }
  // a signboard on two posts facing `face` (or the track centre); text from the atlas
  sign(p, text, w, side = 0, hang = false, face = null) {
    const Pn = this.G.paint, rect = ATLAS[text], h = (w * (rect[3] - rect[1])) / (rect[2] - rect[0]) * (ATLAS.aspect || 1);
    const dir = face ? face.clone().negate().setY(0).normalize() : side ? V(0, 0, side) : V(-1, 0, 0); // the way the board faces
    const along = V(dir.z, 0, -dir.x), y0 = hang ? p.y : p.y + 2.2;
    const c = p.clone().setY(y0);
    const q = [c.clone().addScaledVector(along, -w / 2), c.clone().addScaledVector(along, w / 2), c.clone().addScaledVector(along, w / 2).add(V(0, h, 0)), c.clone().addScaledVector(along, -w / 2).add(V(0, h, 0))].map((v) => v.addScaledVector(dir, 0.08));
    this.signQuad(q, rect);
    const back = q.map((v) => v.clone().addScaledVector(dir, -0.16));
    this.quad(Pn, back[1], back[0], back[3], back[2], col(0x2c2c2c), null, dir.clone().negate());
    if (!hang) for (const s of [-1, 1]) this.box(Pn, p.x + along.x * s * w * 0.4, p.y, p.z + along.z * s * w * 0.4, 0.15, y0 + h * 0.5 - p.y, 0.15, 0, col(0x55585e));
  }
  flag(p, c) {
    const Pn = this.G.paint, h = 5.5;
    this.cyl(Pn, p.x, 0, p.z, 0.05, 0.04, h, 4, col(0xdddddd), false);
    const a = V(p.x, h, p.z), b = V(p.x, h - 1.0, p.z), t = V(p.x + 1.6, h - 0.45, p.z + (this.rnd() - 0.5) * 0.6);
    this.tri(Pn, a, b, t, c); this.tri(Pn, a, t, b, c);
  }
  dressing() {
    const Pn = this.G.paint, r = this.rnd, flagC = [0xe0262a, 0xffd21e, 0x2a86f0, 0x22b04a, 0xff7a1a, 0xffffff].map(col);
    // start arch: an inflatable red and white arch over the track, the park's name across it, a chequered line
    const ax = -130, az = RT, R = 13, tube = 1.0, segA = 26, segT = 8;
    for (let i = 0; i < segA; i++) for (let j = 0; j < segT; j++) {
      const P = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2, rr = R + tube * Math.cos(b); return V(ax + tube * Math.sin(b), rr * Math.sin(a), az + rr * Math.cos(a)); };
      const Nn = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2; return V(Math.sin(b), Math.cos(b) * Math.sin(a), Math.cos(b) * Math.cos(a)); };
      this.quad(Pn, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), i % 4 < 2 ? col(0xe0262a) : col(0xf4f4f4), null, Nn(i + 0.5, j + 0.5), [Nn(i, j), Nn(i + 1, j), Nn(i + 1, j + 1), Nn(i, j + 1)]);
    }
    for (const s of [-1, 1]) this.box(Pn, ax, 0, az + s * R, 1.8, 1.0, 1.8, 0, col(0x333333), [PAINT, 0.8]);
    const bq = (x, f) => [V(x, 9.4, az - 7 * f), V(x, 9.4, az + 7 * f), V(x, 12, az + 7 * f), V(x, 12, az - 7 * f)];
    this.signQuad(bq(ax - 0.9, 1), ATLAS['STUNT PARK']); // faces the cars coming in (and the start camera)
    this.signQuad(bq(ax + 0.9, -1), ATLAS.START);
    { const q = [V(ax - 1.5, 0.09, az - TW), V(ax - 1.5, 0.09, az + TW), V(ax + 1.5, 0.09, az + TW), V(ax + 1.5, 0.09, az - TW)]; this.signQuad(q, ATLAS.check); }
    // flags along both straights, on the berms
    for (let x = -150; x <= 150; x += 22) { this.flag(V(x, 0, RT + 12.2), flagC[Math.floor(r() * flagC.length)]); this.flag(V(x + 11, 0, -RT - 12.2), flagC[Math.floor(r() * flagC.length)]); }
    // grandstands with a crowd: two along straight 1 (the kickers, the loop), one opposite the canyon jump
    this.stand(-95, RT + 21, 44, 1); this.stand(85, RT + 21, 44, 1); this.stand(55, -RT - 21, 40, -1);
    // tyre walls in front of the stands
    for (const [x0, x1, z] of [[-118, -72, RT + 15.5], [62, 108, RT + 15.5], [34, 76, -RT - 15.5]]) for (let x = x0; x <= x1; x += 0.9) this.tyres(V(x, 0, z), 3);
    // floodlight towers
    for (const [x, z, f] of [[-150, 66, -1], [-20, 70, -1], [130, 66, -1], [-120, -66, 1], [10, -70, 1], [140, -66, 1], [-222, 0, 0], [222, 0, 0]]) this.tower(x, z, f);
  }
  stand(x, z, len, f) { // f: +1 the stand is south of the track (faces -z), -1 north
    const Pn = this.G.paint, tiers = 6, r = this.rnd, shirt = [0xe0262a, 0x2a86f0, 0xffd21e, 0x22b04a, 0xff7a1a, 0xf4f4f4, 0x8a4ad8, 0x1a1a1a].map(col), skin = [0xf1c8a0, 0xd8a070, 0x9a6a44, 0x6a4428].map(col);
    for (let t = 0; t < tiers; t++) { const zz = z + f * (t * 1.0 + 0.5); this.box(Pn, x, 0, zz, len, 0.5 + t * 0.55, 1.0, 0, col(0x9aa0a8), null, t % 2 ? col(0x3c6fb4) : col(0x4a7cc4)); }
    this.box(Pn, x, 0, z + f * (tiers + 0.1), len, tiers * 0.55 + 2.4, 0.3, 0, col(0x6a7078));
    // a striped canopy on posts, and bunting along its front edge
    const ry = tiers * 0.55 + 3.4, rz = z + f * (tiers / 2 + 0.2);
    for (let k = 0; k < len / 4; k++) this.box(Pn, x - len / 2 + 2 + k * 4, ry, rz, 4, 0.18, tiers + 1.6, 0, k % 2 ? col(0xf4f4f4) : col(0xe0262a));
    for (let k = 0; k <= len / 11; k++) this.box(Pn, x - len / 2 + 0.5 + k * ((len - 1) / Math.ceil(len / 11)), 0, z + f * (tiers + 0.4), 0.2, ry, 0.2, 0, col(0x55585e));
    const flagC = [0xe0262a, 0xffd21e, 0x2a86f0, 0x22b04a, 0xff7a1a].map(col), fz = z - f * 0.5;
    for (let k = 0; k < len / 1.2; k++) { const px = x - len / 2 + 0.6 + k * 1.2, sag = 0.5 * Math.sin((k * 1.2 / len) * Math.PI); const a = V(px - 0.4, ry - sag, fz), b = V(px + 0.4, ry - sag, fz), c = V(px, ry - sag - 0.7, fz); this.tri(Pn, a, b, c, flagC[k % 5]); this.tri(Pn, a, c, b, flagC[k % 5]); }
    // one solid block for the collision mesh
    { const c = V(x, 0, z + f * tiers / 2), hx = len / 2, hz = tiers / 2, h = tiers * 0.55, w = (a) => this.W(a); const q = [V(c.x - hx, 0, c.z - hz), V(c.x + hx, 0, c.z - hz), V(c.x + hx, 0, c.z + hz), V(c.x - hx, 0, c.z + hz)].map(w); const t = q.map((p) => p.clone().add(V(0, h, 0)));
      const fc = (a, b, cc, d, out) => { const n = faceN(a, b, cc); if (n.dot(out) < 0) { this.cm.tri(a, cc, b, PAINT, 1.5); this.cm.tri(a, d, cc, PAINT, 1.5); } else { this.cm.tri(a, b, cc, PAINT, 1.5); this.cm.tri(a, cc, d, PAINT, 1.5); } };
      fc(t[0], t[1], t[2], t[3], Y); fc(q[0], q[1], t[1], t[0], V(0, 0, -1)); fc(q[2], q[3], t[3], t[2], V(0, 0, 1)); fc(q[1], q[2], t[2], t[1], V(1, 0, 0)); fc(q[3], q[0], t[0], t[3], V(-1, 0, 0)); }
    for (let t = 0; t < tiers; t++) for (let i = 0; i < len * 0.75; i++) {
      if (r() < 0.25) continue;
      const px = x - len / 2 + 0.6 + r() * (len - 1.2), pz = z + f * (t * 1.0 + 0.55), py = 0.5 + t * 0.55, c = shirt[Math.floor(r() * shirt.length)], sk = skin[Math.floor(r() * skin.length)];
      const stand = r() < 0.2 ? 0.25 : 0; // some are on their feet
      this.box(Pn, px, py, pz, 0.46, 0.62 + stand, 0.3, 0, c);
      this.box(Pn, px, py + 0.66 + stand, pz, 0.24, 0.26, 0.24, 0, sk, null, r() < 0.4 ? shirt[Math.floor(r() * 3)] : col(0x3a2a1c));
    }
  }
  tower(x, z, f) {
    const Pn = this.G.paint, L = this.G.lamp, h = 19, toC = V(-x, 0, -z).normalize(), side = V(-toC.z, 0, toC.x);
    this.cyl(Pn, x, 0, z, 0.35, 0.22, h, 8, col(0x8a9096), false);
    const c = V(x, h, z), w = 4.2, hh = 2.4, tilt = 0.35, fw = toC.clone().multiplyScalar(Math.cos(tilt)).add(V(0, -Math.sin(tilt), 0));
    const up = fw.clone().cross(side).normalize().multiplyScalar(-1); // the head's up, tilted back
    const P = (a, b, d = 0) => c.clone().addScaledVector(side, a).addScaledVector(up, b).addScaledVector(fw, d);
    this.quad(Pn, P(w / 2, -hh / 2, -0.3), P(-w / 2, -hh / 2, -0.3), P(-w / 2, hh / 2, -0.3), P(w / 2, hh / 2, -0.3), col(0x3a3e44), null, fw.clone().negate());
    for (const [a, b, d, e] of [[-w / 2, -hh / 2, w / 2, -hh / 2], [w / 2, hh / 2, -w / 2, hh / 2]]) this.quad(Pn, P(a, b, -0.3), P(d, e, -0.3), P(d, e, 0), P(a, b, 0), col(0x3a3e44), null, up.clone().multiplyScalar(b > 0 ? 1 : -1));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const a = -w / 2 + 0.25 + i * 1.3, b = -hh / 2 + 0.2 + j * 1.1;
      this.quad(L, P(a, b, 0.02), P(a + 1.1, b, 0.02), P(a + 1.1, b + 0.95, 0.02), P(a, b + 0.95, 0.02), col(0xffffff), null, fw);
    }
    // its pool of light on the ground (night)
    const g = c.clone().addScaledVector(toC, 34).setY(0.15), R = 30, Pl = this.G.pool, wh = col(0xffffff);
    const q = [V(g.x - R, 0.15, g.z - R), V(g.x + R, 0.15, g.z - R), V(g.x + R, 0.15, g.z + R), V(g.x - R, 0.15, g.z + R)], uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const [i, j, k] of [[0, 2, 1], [0, 3, 2]]) for (const m of [i, j, k]) { Pl.p.push(q[m].x, q[m].y, q[m].z); Pl.n.push(0, 1, 0); Pl.c.push(wh.r, wh.g, wh.b); Pl.u.push(...uv[m]); }
  }

  buildMeshes(world) {
    const G = this.G, grp = (this.group = new THREE.Group()); grp.position.copy(this.O); grp.name = 'stuntPark';
    const tex = dirtTexture(), atlas = atlasTexture();
    this.mats = {
      earth: new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.97, metalness: 0 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 }),
      sign: new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0xfff2d0, emissiveIntensity: 0.4, roughness: 0.3 }),
      pool: new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(1.0, 0.92, 0.75), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
    };
    this.meshes = {};
    for (const k of ['earth', 'paint', 'sign', 'lamp', 'pool']) {
      const m = new THREE.Mesh(G[k].geometry(), this.mats[k]); m.name = 'stunt-' + k;
      m.receiveShadow = k !== 'pool'; m.castShadow = k === 'earth' || k === 'paint';
      grp.add(m); this.meshes[k] = m;
    }
    this.meshes.pool.visible = false; this.meshes.pool.renderOrder = 2;
    this.stats = { tris: Object.values(G).reduce((a, g) => a + g.tris, 0), collTris: this.cm.n, draws: 5 };
    this.G = null;
    world.group.add(world.nearShadow ? world.nearShadow(grp) : grp);
  }

  // ---- per frame ----
  update(dt, world, cam) {
    const night = world.night || (world.W?.dark ?? 0) > 0.55;
    if (night !== this.night) { this.night = night; this.mats.lamp.emissiveIntensity = night ? 7 : 0.4; this.mats.sign.emissiveIntensity = night ? 0.9 : 0.25; this.meshes.pool.visible = night; }
    if (cam) this.group.visible = Math.hypot(cam.x - this.O.x, cam.z - this.O.z) < 9000;
    for (const b of this.boosts) b.glow = (b.glow || 0) * Math.exp(-dt * 3);
  }
  // A car in the park: boost pads push it to their speed; tells about big air and loops. Returns messages for the HUD.
  drive(ac, dt) {
    if (!ac.isCar || ac.dead || !this.inside(ac.x.x, ac.x.z, 20)) { this.st.air = 0; return null; }
    const st = this.st, msgs = [], up = ac.up || Y;
    const fwd = V(0, 0, -1).applyQuaternion(ac.q);
    if (ac.onGround) {
      for (const b of this.boosts) {
        const d = ac.x.clone().sub(b.a), s = d.dot(b.t), l = d.dot(b.r);
        if (s < 0 || s > b.L || Math.abs(l) > b.w || Math.abs(d.y) > 3) continue;
        const v = ac.v.dot(fwd);
        if (fwd.dot(b.t) < 0.7) continue;
        if (v < b.target && !b.rumble) { ac.v.addScaledVector(fwd, Math.min(b.target - v, 26 * dt)); if (!b.glow || b.glow < 0.2) msgs.push({ center: 'BOOST!' }); b.glow = 1; }
        else if (v > b.target + (b.exact ? 0 : 1)) ac.v.addScaledVector(fwd, -Math.min(v - b.target - (b.exact ? 0 : 1), (b.exact ? 30 : 12) * dt)); // too fast for what's next: it holds you back
      }
      this.guide(ac, dt); this.bowlGuide(ac, dt);
      if (st.air > 1.0) msgs.push({ toast: `BIG AIR! ${st.air.toFixed(1)} s`, good: true });
      st.air = 0;
      if (up.y < -0.6 && ac.stuntUp) st.upside = true; // on the wheels, upside down: in the loop
      if (st.upside && up.y > 0.8) { st.upside = false; msgs.push({ center: 'LOOP THE LOOP!' }); }
    } else { st.air += dt; if (st.air > 3) st.upside = false; }
    return msgs.length ? msgs : null;
  }
  // The loop's side rails steer you: on its deck the car is held to the middle and pointed along it (a kid can't steer
  // upside down, and the loop steps a lane sideways). Only sideways and yaw: whether you make it over the top is up to
  // your speed.
  guide(ac, dt) {
    const L = this.loopInfo, F = L.guide;
    const x = ac.x.x - this.O.x, y = ac.x.y - this.O.y, z = ac.x.z - this.O.z;
    let bi = -1, bd = 49; // (within 7 m: the lead-in catches you anywhere across the track)
    const i0 = L.i == null ? 0 : Math.max(0, L.i - 8), i1 = L.i == null ? F.length : Math.min(F.length, L.i + 9);
    for (let i = i0; i < i1; i++) { const p = F[i].p, d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    L.i = bi < 0 ? null : bi;
    if (bi < 2 || bi > F.length - 3 || (!ac.stuntUp && bi >= L.lead)) return; // (on the deck: only with the wheels on it)
    if (bi < L.lead && ac.v.dot(F[bi].t) < 8) return; // the lead-in only pulls you in when you're going for it
    // like a slot car: turn the car and its velocity together about the deck's normal towards the deck's direction, and
    // ease it back to the middle (no tyre slip, so the tyres don't fight it)
    const f = F[bi], e = (x - f.p.x) * f.b.x + (y - f.p.y) * f.b.y + (z - f.p.z) * f.b.z;
    const fwd = V(0, 0, -1).applyQuaternion(ac.q), err = Math.asin(clamp(fwd.clone().cross(f.t).dot(f.n), -1, 1));
    const turn = new THREE.Quaternion().setFromAxisAngle(f.n, err * Math.min(1, 10 * dt));
    ac.q.premultiply(turn).normalize(); ac.v.applyQuaternion(turn);
    ac.x.addScaledVector(f.b, -e * Math.min(1, 5 * dt));
  }
  // Arcade and Pilot: on the bowl's wall the car is turned to run round it (the bowl is a 180-degree turn you'd have
  // to steer hard into at full speed; kids hit it flat out). How high you ride is still your speed.
  bowlGuide(ac, dt) {
    if (!(ac.R.assist > 0) || !ac.stuntUp || ac.stuntUp.y > 0.97) return;
    const x = ac.x.x - this.O.x + XS, z = ac.x.z - this.O.z, r = Math.hypot(x, z);
    if (x > 0 || r < RT || r > RT + 16) return;
    const n = ac.stuntUp, t = V(z / r, 0, -x / r), psi = Math.atan2(z, x); // (round from psi = -pi/2 via pi to pi/2)
    const out = z > 0 && psi < Math.PI ? smoothstep(1.4, 0.3, psi - Math.PI / 2) : 0; // coming up to the exit: back down off the wall
    // ride the wall where the banking suits your speed (slow: low down, flat out: high up), and come down for the exit
    const bank = Math.acos(clamp(n.y, -1, 1)), eq = Math.atan(ac.v.lengthSq() / (r * 9.81));
    t.addScaledVector(V(-x / r, 0, -z / r), clamp((bank - eq) * 0.8, -0.3, 0.4) * (1 - out) + 0.6 * out * clamp((r - RT - 1) / 6, 0, 1));
    t.addScaledVector(n, -t.dot(n)).normalize();
    const fwd = V(0, 0, -1).applyQuaternion(ac.q);
    if (fwd.dot(t) < 0.3) return; // (not going round it)
    const err = Math.asin(clamp(fwd.clone().cross(t).dot(n), -1, 1)), turn = new THREE.Quaternion().setFromAxisAngle(n, err * Math.min(1, 4 * dt * ac.R.assist / 0.45));
    ac.q.premultiply(turn).normalize(); ac.v.applyQuaternion(turn);
    // turning at the rate the bend needs (and not at all as you leave it: no slide off sideways at the exit)
    const qi = ac.q.clone().invert(), wn = ac.w.clone().applyQuaternion(ac.q).dot(n), want = (ac.v.length() / r) * (1 - out);
    ac.w.add(n.clone().multiplyScalar((want - wn) * Math.min(1, 6 * dt)).applyQuaternion(qi));
    // and it keeps you flat on the wall (no tipping over sideways, tall trucks!), coming level with it as it flattens out
    const up = V(0, 1, 0).applyQuaternion(ac.q), f2 = V(0, 0, -1).applyQuaternion(ac.q), rollErr = Math.asin(clamp(up.clone().cross(n).dot(f2), -1, 1));
    ac.q.premultiply(new THREE.Quaternion().setFromAxisAngle(f2, rollErr * Math.min(1, 5 * dt))).normalize();
    ac.w.z *= Math.max(0, 1 - 5 * dt);
  }
  dispose() {
    for (const m of Object.values(this.meshes || {})) m.geometry.dispose();
    for (const m of Object.values(this.mats || {})) { if (m.map && m.map !== glowTexture()) m.map.dispose(); m.dispose(); }
  }
}

// ---- textures ----
function dirtTexture() { // tileable: integer-frequency waves with random phases, plus grit and pebbles
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d'), r = mulberry32(5);
  const waves = []; for (let k = 0; k < 24; k++) { const f = 1 + Math.floor(r() * (k < 8 ? 4 : 18)); waves.push([f * Math.cos(r() * 7), f * Math.sin(r() * 7), r() * 7, 1 / Math.sqrt(f)].map((v, i) => (i < 2 ? Math.round(v) : v))); }
  const img = g.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const x = (i % s) / s * Math.PI * 2, y = ((i / s) | 0) / s * Math.PI * 2;
    let n = 0; for (const [a, b, p, w] of waves) n += Math.sin(a * x + b * y + p) * w;
    const v = 196 + n * 9 + (r() - 0.5) * 34;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v * 0.96; img.data[i * 4 + 2] = v * 0.91; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 220; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '90,66,46' : '246,236,220'},${0.12 + r() * 0.18})`; g.beginPath(); g.arc(r() * s, r() * s, 0.5 + r() * 1.4, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// the sign atlas: [u0, v0, u1, v1] per entry (v up)
const ATLAS = {
  'STUNT PARK': [0, 0.75, 1, 1], START: [0, 0.625, 0.5, 0.75], LOOP: [0.5, 0.625, 1, 0.75], 'CANYON JUMP': [0, 0.5, 1, 0.625],
  'WALL RIDE': [0, 0.375, 0.5, 0.5], 'BANKED TURN': [0.5, 0.375, 1, 0.5], TABLETOP: [0, 0.25, 0.5, 0.375], 'WHOOPS!': [0.5, 0.25, 1, 0.375],
  chev: [0, 0, 0.25, 0.25], check: [0.25, 0, 0.5, 0.25],
};
function atlasTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const box = (r, bg, fg, text, size, edge = '#ffffff') => {
    const x = r[0] * S, y = (1 - r[3]) * S, w = (r[2] - r[0]) * S, h = (r[3] - r[1]) * S;
    g.fillStyle = bg; g.fillRect(x, y, w, h); g.strokeStyle = edge; g.lineWidth = 10; g.strokeRect(x + 8, y + 8, w - 16, h - 16);
    g.font = `900 ${size}px "Arial Black", Impact, sans-serif`; size = Math.min(size, (size * (w - 60)) / g.measureText(text).width); // (fit the board)
    g.fillStyle = fg; g.font = `900 ${size}px "Arial Black", Impact, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = size * 0.12; g.strokeStyle = '#111'; g.strokeText(text, x + w / 2, y + h / 2 + size * 0.04); g.fillText(text, x + w / 2, y + h / 2 + size * 0.04);
  };
  box(ATLAS['STUNT PARK'], '#d81e24', '#ffd21e', 'STUNT PARK', 170);
  box(ATLAS.START, '#111111', '#ffffff', 'START', 92, '#ffd21e'); box(ATLAS.LOOP, '#1f6fd8', '#ffd21e', 'LOOP', 100);
  box(ATLAS['CANYON JUMP'], '#b4553a', '#ffffff', 'CANYON JUMP', 96, '#ffd21e');
  box(ATLAS['WALL RIDE'], '#2a86f0', '#ffffff', 'WALL RIDE', 74); box(ATLAS['BANKED TURN'], '#22b04a', '#ffffff', 'BANKED TURN', 62);
  box(ATLAS.TABLETOP, '#ff7a1a', '#ffffff', 'TABLETOP', 76); box(ATLAS['WHOOPS!'], '#8a4ad8', '#ffd21e', 'WHOOPS!', 80);
  { const x = 0, y = S * 0.75, w = S * 0.25, h = S * 0.25; g.fillStyle = '#1a1a1a'; g.fillRect(x, y, w, h); g.fillStyle = '#ffb000';
    for (let k = 0; k < 2; k++) { const y0 = y + h * (0.9 - k * 0.5); g.beginPath(); g.moveTo(x + w * 0.1, y0); g.lineTo(x + w * 0.5, y0 - h * 0.32); g.lineTo(x + w * 0.9, y0); g.lineTo(x + w * 0.9, y0 - h * 0.12); g.lineTo(x + w * 0.5, y0 - h * 0.44); g.lineTo(x + w * 0.1, y0 - h * 0.12); g.closePath(); g.fill(); } }
  { const x = S * 0.25, y = S * 0.75, n = 8, q = (S * 0.25) / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(x + i * q, y + j * q, q, q); } }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
