// Stunt parks: a stunt-driving arena on a levelled pad, at every real location (loc.stunts): kicker ramps, a
// loop-the-loop, a banked turn, a wall-ride bowl or half-pipe, a jump across a gap between two mesas (rock, shipping
// containers, timber or lava), whoops, berms, boost pads, a start arch, barriers, flags, grandstands with a crowd and
// floodlights. Cars (and bikes) start at the arch.
//
// Data-driven: a park is a layout (where everything goes along the track: LAYOUTS) plus a placement (loc.stunts: a
// fixed spot, or a search area the site is found in from the real terrain, water and building data, stuntSite.js)
// plus a theme (its look: stuntKit.js THEMES). The builders are shared (stuntKit.js Site), and so are the materials.
// The Grand Canyon also has the daredevil canyon jump (evelJump.js); StuntParks holds a location's sites.
//
// Everything you can drive on is also a triangle in a site's CollisionMesh (collide.js): the flight model's wheel rays
// and hull points hit it (env.surfRay / env.surfPoint in main.js), so cars drive up ramps, round the loop upside down
// and along the bowl's wall, and planes land on, or crash into, the structures.
//
// Layout (park frame: metres from the pad centre, x along the park, z across it, y up from the pad; the frame is
// turned by the placement's yaw):
//   straight 1 (z = +RT, heading +x): start arch, kickers, (tabletop), boost, loop, rumble strip
//   east turn: banked (20 degrees)            straight 2 (z = -RT, heading -x): boost, mesa ramp, gap, landing, whoops
//   west turn: the bowl (wall ride)
import * as THREE from 'three';
import { clamp, smoothstep } from './noise.js';
import { Site, THEMES, V, Y, PAINT, DIRT, col, kicker, descent, loopCurve, stuntMaterials, ATLAS } from './stuntKit.js';
import { findSite } from './stuntSite.js';
import { EvelJump, planEvel } from './evelJump.js';

const RT = 30, TW = 7, LANE = 3.5; // turn radius, track half width, lane offset
const LINK = 70; // where the park feeds the canyon jump: the link lane from the end of straight 1 to the run-up

// s: metres along a straight from its start. pad: the dirt pad's half size; flat: ground levelled this far beyond it,
// then blended back into the real terrain over `blend` (fill: never raised more than about this: no filling hollows)
export const LAYOUTS = {
  classic: { // the Grand Canyon's: 340 m straights
    XS: 170, pad: [236, 96], flat: 180, blend: 200, fill: 0, start: 44, arch: 40,
    kickers: [[66, 0.6, 16, 6.5], [92, 1.1, 19, 6.5]], tabletop: 116, boost: 193, loop: 212, rumble: 292,
    jump: { boost: 18, mesa: 40, whoops: 170, n: 6 }, berms: [[1, 70, 205], [1, 258, 336], [2, 4, 36], [2, 136, 336]],
    flags: [-150, 150, 22], stands: [[-95, 1, 44], [85, 1, 44], [55, -1, 40]],
    towers: [[-150, 66], [-20, 70], [130, 66], [-120, -66], [10, -70], [140, -66], [-222, 0], [222, 0]],
  },
  compact: { // fits an open lawn or a field: 190 m straights, no tabletop, four whoops
    XS: 95, pad: [146, 76], flat: 30, blend: 60, fill: 8, start: 30, arch: 26, archR: 17, // (the arch well clear of the bowl's exit, and wide: you come out of the bowl wide)
    kickers: [[40, 0.6, 16, 6.5], [58, 1.1, 19, 6.5]], tabletop: null, boost: 96, loop: 124, rumble: 172,
    jump: { boost: 6, mesa: 24, whoops: 122, n: 4 }, berms: [[1, 40, 120], [1, 174, 186], [2, 2, 22], [2, 112, 186]],
    flags: [-80, 80, 20], stands: [[-40, 1, 34], [62, 1, 30], [20, -1, 34]],
    towers: [[-80, 62], [85, 62], [-75, -62], [70, -62], [-132, 0], [132, 0]],
  },
};

// ---- the levelled ground (World.rawHeight): one pad per site ----
export function padHeight(P, x, z, h) {
  const ex = x - P.x, ez = z - P.z, u = ex * P.c - ez * P.s, v = ex * P.s + ez * P.c;
  const dx = Math.max(0, Math.abs(u) - P.hx), dz = Math.max(0, Math.abs(v) - P.hz);
  if (dx >= P.blend || dz >= P.blend) return h;
  let k = 1 - smoothstep(0, P.blend, Math.hypot(dx, dz));
  if (P.fill) k *= 1 - smoothstep(P.fill, P.fill * 2, P.h - h); // (a canyon, a hollow or the sea below the pad is left alone)
  return h + (P.h - h) * k;
}
export function padsHeight(pads, x, z, h) { for (const P of pads) h = padHeight(P, x, z, h); return h; }
// is (x, z) inside one of the plan's closed-road rectangles?
export function inStuntCut(plan, x, z) {
  for (const R of plan?.cut || []) { const ex = x - R.x, ez = z - R.z; if (Math.abs(ex * R.c - ez * R.s) < R.hx && Math.abs(ex * R.s + ez * R.c) < R.hz) return true; }
  return false;
}

// Where a location's stunt sites go and the ground they level. Runs before the terrain is built (World constructor).
export function planStunts(w, cfg) {
  const t0 = performance.now(), L = { ...LAYOUTS[cfg.layout || 'classic'], ...(cfg.flat != null ? { flat: cfg.flat, blend: cfg.blend } : {}), ...(cfg.fill != null ? { fill: cfg.fill } : {}) };
  const evel = cfg.evel ? planEvel(w, cfg.evel) : null;
  if (cfg.evel && !evel) console.warn('[stunts] no gap found for the canyon jump');
  let site;
  if (evel && cfg.atJump) { // one daredevil area: the park right behind the jump's run-up, its straight 1 in line with it, so the
    // track runs on through a fork at the east turn, down a link lane, onto the run-up (the park frame turned like the jump's)
    const xe = evel.runStart - LINK - L.XS, { dx, dz } = evel;
    site = { x: evel.x + xe * dx + RT * dz, z: evel.z + xe * dz - RT * dx, yaw: evel.yaw, link: LINK, atJump: true };
  } else site = cfg.x != null ? { x: cfg.x, z: cfg.z, yaw: cfg.yaw || 0, fixed: true } : findSite(w, cfg, L);
  if (!site) { console.warn(`[stunts] no flat, clear site for the stunt park at ${w.loc.id}`); return null; }
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  let sum = 0, n = 0;
  for (let x = -L.pad[0]; x <= L.pad[0]; x += 24) for (let z = -L.pad[1]; z <= L.pad[1]; z += 24) { sum += w.height(site.x + (x * c + z * s), site.z + (-x * s + z * c)); n++; }
  const pad = { x: site.x, z: site.z, c, s, hx: L.pad[0] + L.flat, hz: L.pad[1] + L.flat, blend: L.blend, h: Math.round((sum / n) * 10) / 10, fill: L.fill };
  const plan = { cfg, layout: L, theme: THEMES[cfg.theme || 'canyon'], site, park: { x: site.x, z: site.z, yaw: site.yaw, h: pad.h, link: site.link || 0, linkDy: evel && site.link ? evel.hA - pad.h : 0 }, pads: [pad] };
  if (evel) { plan.evel = evel; plan.pads.push(...evel.pads); }
  // where a real road crossing a site is closed (realworld.js network: no road mesh, no traffic there): the park's pad,
  // its link lane, and the jump's run-up and run-out
  const rect = (x, z, yaw, hx, hz) => ({ x, z, c: Math.cos(yaw), s: Math.sin(yaw), hx, hz });
  plan.cut = [rect(site.x, site.z, site.yaw, L.pad[0] + 10 + (site.link ? LINK / 2 : 0), L.pad[1] + 10)];
  if (site.link) { const k = plan.cut[0]; k.x += (LINK / 2) * k.c; k.z -= (LINK / 2) * k.s; }
  if (evel) for (const P of evel.pads) plan.cut.push(rect(P.x, P.z, evel.yaw, P.hx, 25));
  plan.ms = Math.round(performance.now() - t0);
  return plan;
}

// A location's stunt sites (the park, and the canyon jump where there is one), with one set of materials.
export class StuntParks {
  constructor(world, plan) {
    const t0 = performance.now();
    this.plan = plan; this.mats = stuntMaterials(plan.theme);
    this.park = new StuntPark(world, plan, this.mats);
    this.evel = plan.evel ? new EvelJump(world, plan.evel, plan.theme, this.mats) : null;
    this.sites = [this.park, this.evel].filter(Boolean);
    this.start = this.park.start;
    this.stats = { tris: 0, collTris: 0, draws: 0 };
    for (const s of this.sites) for (const k of Object.keys(this.stats)) this.stats[k] += s.stats[k];
    this.stats.buildMs = Math.round(performance.now() - t0); this.stats.planMs = plan.ms;
  }
  // where a car starts: 'evel' at the canyon jump's run-up (where there is one), anything else at the park's arch
  startFor(start) { return (start === 'evel' && this.evel?.start) || this.park.start; }
  // (collision: each site's CollisionMesh is in World.surfs, which the flight model's wheel rays and hull points query)
  topAt(x, z) { let t = -Infinity; for (const s of this.sites) t = Math.max(t, s.topAt(x, z)); return t; }
  bare(x, z) { for (const s of this.sites) if (s.bare(x, z)) return true; return false; }
  update(dt, world, cam) {
    const night = world.night || (world.W?.dark ?? 0) > 0.55;
    if (night !== this.night) { this.night = night; this.mats.lamp.emissiveIntensity = night ? 7 : 0.4; this.mats.sign.emissiveIntensity = night ? 0.9 : 0.25; }
    for (const s of this.sites) s.update(night, cam, dt);
  }
  drive(ac, dt) { let out = null; for (const s of this.sites) { const m = s.drive(ac, dt); if (m) out = out ? out.concat(m) : m; } return out; }
  dispose() {
    for (const s of this.sites) s.dispose();
    for (const m of Object.values(this.mats)) { if (m.map && m.map !== this.mats.pool.map) m.map.dispose(); m.dispose(); }
  }
}

export class StuntPark extends Site {
  constructor(world, plan, mats) {
    const t0 = performance.now(), P = plan.park;
    super(world, V(P.x, P.h, P.z), P.yaw, plan.theme, 911);
    this.L = plan.layout; this.XS = this.L.XS; this.link = P.link; this.linkDy = P.linkDy;
    this.layout();
    this.cm.build();
    this.buildMeshes(world, mats, 'stuntPark');
    // start: at the arch, in the right-hand lane, facing the first kicker; online, the others line up behind in alternate lanes
    const back = this.Wd(V(-1, 0, 0)), side = this.Wd(V(0, 0, 1)), pos = this.W(V(-this.XS + this.L.start, 0, RT + LANE));
    this.start = { id: 'park', pos, heading: this.heading(1), lane: LANE, at: (slot) => pos.clone().addScaledVector(back, 9 * slot).addScaledVector(side, slot % 2 ? -2 * LANE : 0) };
    this.st = { air: 0, upside: false };
    this.stats.buildMs = Math.round(performance.now() - t0);
  }
  inside(x, z, m = 0) { const [lx, lz] = this.local(x, z); return Math.abs(lx) < this.L.pad[0] + m && Math.abs(lz) < this.L.pad[1] + m; }
  bare(x, z) { return this.inside(x, z, 12); } // no trees or grass tufts on the pad

  // ---- the park ----
  layout() {
    const E = this.G.earth, L = this.L, T = this.T, r = this.rnd, XS = this.XS, [PX, PZ] = L.pad;
    const dirt = col(T.pad[0]), dirtD = col(T.pad[1]), chalk = col(T.pad[2]), nz2 = this.w.noise;
    // the pad: a cleared lot (packed dirt, concrete, meadow or sand) with a ragged edge (a rounded rectangle, its rim
    // wobbled by noise), patchy, with darker worn ground along the track and the real ground's colour creeping in at the rim
    const real = this.w.real, cc = new THREE.Color(), step = 6, nx = Math.round((PX * 2) / step), nz = Math.round((PZ * 2) / step);
    const rim = (x, z) => (Math.abs(x) / PX) ** 5 + (Math.abs(z) / PZ) ** 5 - 0.12 * nz2.fbm(x / 40 + 3, z / 40, 3); // < 1 inside
    const vcol = (x, z) => {
      const t = smoothstep(1, 0.55, rim(x, z)), f = nz2.fbm(x / 70, z / 70 + 11, 4), worn = Math.max(1 - Math.abs(Math.abs(z) - RT) / 16, 0) * (Math.abs(x) < XS + 10 ? 1 : 0);
      const base = dirt.clone().multiplyScalar(0.9 + 0.22 * f + 0.05 * r()).lerp(dirtD, 0.35 * worn);
      if (real) { const p = this.W(V(x, 0, z)); real.color(p.x, p.z, cc); cc.convertSRGBToLinear(); } else cc.copy(dirtD);
      return cc.clone().lerp(base, t);
    };
    const grid = []; for (let j = 0; j <= nz; j++) { grid.push([]); for (let i = 0; i <= nx; i++) { const x = -PX + i * step, z = -PZ + j * step; grid[j].push({ p: V(x, 0.03, z), c: vcol(x, z), in: rim(x, z) < 1 }); } }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      if (a.in && b.in && c.in) { E.vert(a.p, Y, a.c); E.vert(c.p, Y, c.c); E.vert(b.p, Y, b.c); }
      if (a.in && c.in && d.in) { E.vert(a.p, Y, a.c); E.vert(d.p, Y, d.c); E.vert(c.p, Y, c.c); }
    }
    // the track: groomed darker ground with chalk edges (on the pad: the terrain is the collision surface)
    const straight = (x0, z, dir) => (s) => ({ p: V(x0 + dir * s, 0, z), t: V(dir, 0, 0), r: V(0, 0, dir) });
    const arc = (cx, psi0) => (s) => { const ps = psi0 - s / RT; return { p: V(cx + RT * Math.cos(ps), 0, RT * Math.sin(ps)), t: V(Math.sin(ps), 0, -Math.cos(ps)), r: V(Math.cos(ps), 0, Math.sin(ps)) }; };
    this.path1 = straight(-XS, RT, 1); this.path2 = straight(XS, -RT, -1);
    const trackX = [[-TW, 0.06], [-TW + 0.4, 0.06], [TW - 0.4, 0.06], [TW, 0.06]];
    const trackC = (s, k) => (k === 1 ? dirtD.clone().multiplyScalar(0.94 + 0.12 * Math.sin(s * 1.7) ** 2) : chalk);
    for (const pth of [this.path1, this.path2]) this.sweep(E, { s0: 0, s1: XS * 2, n: Math.round((34 * XS) / 170), path: pth, cross: () => trackX, color: trackC, walls: false, flat: true });

    this.straight1(); this.straight2();
    this.bankedTurn(arc(XS, Math.PI / 2));
    this.bowl(arc(-XS, -Math.PI / 2));
    this.dressing();
  }

  straight1() {
    const E = this.G.earth, Pn = this.G.paint, L = this.L, T = this.T, p1 = this.path1, lane = (pth, dl) => (s) => { const f = pth(s); f.p.addScaledVector(f.r, dl); return f; };
    const ka = col(T.kicker[0]), kb = col(T.kicker[1]), steel = col(T.kicker[2]);
    // kickers: painted steel or planks, striped (small, medium; the track's full width: half on a kicker would flip you)
    for (const [s0, H, deg, w] of L.kickers) {
      const k = kicker(H, deg);
      this.sweep(Pn, { s0, s1: s0 + k.L, n: 10, path: p1, cross: (s) => [[-w, k.h(s - s0)], [0, k.h(s - s0)], [w, k.h(s - s0)]], color: (s, kk) => ((Math.floor((s - s0) * 1.4) + kk) % 2 ? ka : kb), type: () => PAINT, depth: 1.0, wallColor: () => steel, wallType: PAINT });
    }
    // the tabletop: up a big kicker, across a dirt table, down a landing
    if (L.tabletop != null) { const s0 = L.tabletop, k = kicker(2.4, 14), Tt = 6, d = descent(2.4, 12, 1.5, 4), Lt = k.L + Tt + d.L, w = 6.5;
      const h = (s) => { const u = s - s0; return u < k.L ? k.h(u) : u < k.L + Tt ? k.H : d.h(u - k.L - Tt); };
      this.sweep(E, { s0, s1: s0 + Lt, n: 40, path: p1, cross: (s) => [[-w, h(s)], [-w + 0.5, h(s)], [w - 0.5, h(s)], [w, h(s)]], color: (s, kk) => (kk !== 1 ? col(0xeeeeee) : col(0xa87850)), type: () => DIRT, depth: 1.5, wallColor: (y) => col(y > 1.2 ? 0x9a6d47 : 0x8a5f3c), wallType: DIRT });
      this.sign(p1(s0 - 6).p.add(V(0, 0, w + 6)), 'tabletop', 3.5, -1);
    }
    // the boost pad and the loop
    this.boost(lane(p1, LANE), L.boost, 16, 26.5, 0, false, 5.5); // (wide: you can't miss it; enough for a coasting bike in thick air too)
    this.loop(lane(p1, 0), L.loop);
    // a rumble strip after it: out of the loop flat out, it slows you to a speed the banked turn can take
    this.boost(p1, L.rumble, 14, 20, 0, true, TW, true);
  }

  straight2() {
    const p2 = this.path2, L = this.L, T = this.T, J = T.jump, j = L.jump, G = J.kind === 'strata' ? this.G.earth : this.G.paint;
    // a boost to get up the mesa, the mesa ramp with a parapet each side, a boost on top, the lip
    this.boost(p2, j.boost, 14, 15, 0, true);
    const H = 6, climb = descent(H, 14, 14, 6), A0 = j.mesa, up = climb.L, top = 10, lip = kicker(1.0, 20), AL = up + top + lip.L, gap = 12;
    const hA = (s) => { const u = s - A0; return u < up ? climb.h(up - u) : u < up + top ? H : H + lip.h(u - up - top); }; // (a long round crest: you don't take off before the lip)
    const d = descent(H, 15, 1.2, 6), B0 = A0 + AL + gap;
    const hB = (s) => d.h(s - B0);
    const mesa = (h0, rim) => (s) => { const h = h0(s), hr = Math.max(h + rim, rim); return [[-9.5, hr * 0.92], [-8, hr], [-6.4, h + 0.05], [-6, h], [6, h], [6.4, h + 0.05], [8, hr], [9.5, hr * 0.92]]; };
    // the mesas' walls: bands of rock strata, stacked shipping containers, timber or black lava rock
    const rockC = (y) => col(J.bands[Math.floor(y / J.band) % J.bands.length]).multiplyScalar(0.9 + 0.2 * this.rnd());
    const ty = (s, k) => (k === 3 ? J.topType : J.type), cc = (s, k, y) => (k === 3 ? col(J.top) : rockC(y));
    this.sweep(G, { s0: A0, s1: A0 + AL, n: 46, path: p2, cross: mesa(hA, 1.6), color: cc, type: ty, depth: 2, wallColor: rockC, band: J.band, flat: false });
    this.sweep(G, { s0: B0, s1: B0 + d.L, n: 30, path: p2, cross: mesa(hB, 1.6), color: cc, type: ty, depth: 2, wallColor: rockC, band: J.band });
    if (J.kind === 'containers') for (const [s0, s1, hf] of [[A0, A0 + AL, hA], [B0, B0 + d.L, hB]]) this.containerSeams(p2, s0, s1, (s) => Math.max(hf(s) + 1.6, 1.6) * 0.92);
    this.boost(p2, A0 + up + 1, top - 1 + lip.L, 17, H, true); // (right to the lip: a quick bike can't speed up again before it)
    this.gapAt = { s0: A0 + AL, s1: B0, h: H + lip.H };
    const st = B0 + d.L * 0.4; this.jumpAim = { x0: this.XS - (A0 + AL) + 3, x1: this.XS - (B0 + d.L), x: this.XS - st, y: hB(st) + 0.9 }; // (the landing helper's aim: the middle of the landing ramp)
    // boulders in the gap, and a sign
    for (let i = 0; i < 9; i++) { const f = p2(A0 + AL + 1.5 + this.rnd() * (gap - 3)); this.rock(f.p.addScaledVector(f.r, (this.rnd() - 0.5) * 16), 0.5 + this.rnd() * 1.2); }
    this.sign(p2(A0 - 4).p.add(V(0, 0, -TW - 3)), 'jump', 5, 1);
    // whoops: rolling bumps
    const W0 = j.whoops, nb = j.n, wl = 9, wc = col(T.whoops);
    this.sweep(this.G.earth, { s0: W0, s1: W0 + nb * wl, n: nb * 8, path: p2, cross: (s) => { const h = 0.75 * Math.sin((Math.PI * (s - W0)) / wl) ** 2; return [[-TW, h * 0.6], [-TW + 1, h], [TW - 1, h], [TW, h * 0.6]]; }, color: (s, k, y) => wc.clone().multiplyScalar(0.85 + y * 0.3), type: () => DIRT, depth: 1, wallColor: () => wc.clone().multiplyScalar(0.87), wallType: DIRT });
    this.sign(p2(W0 - 5).p.add(V(0, 0, -TW - 3)), 'whoops', 3.5, 1);
    // berms along the outside of both straights
    const bc = [col(T.berm[0]), col(T.berm[1])];
    const berm = (pth, s0, s1, side) => this.sweep(this.G.earth, { s0, s1, n: Math.ceil((s1 - s0) / 4), path: pth, cross: () => [[side * 8.5, 0], [side * 9.6, 0.9], [side * 10.4, 0.9], [side * 11.5, 0]].sort((a, b) => a[0] - b[0]), color: (s, k) => (k === 1 ? bc[0] : bc[1]), type: () => DIRT, depth: 1, walls: false });
    for (const [which, s0, s1] of L.berms) berm(which === 1 ? this.path1 : p2, s0, s1, 1);
  }
  // shipping containers: dark seams where one 6 m box ends and the next begins, up the outer walls of a stack
  containerSeams(pth, s0, s1, top) {
    const Pn = this.G.paint, dark = col(0x1c1c1e);
    for (let s = s0 + 6.1; s < s1 - 1; s += 6.1) for (const side of [-1, 1]) {
      const f = pth(s), p = f.p.clone().addScaledVector(f.r, side * 9.52), h = top(s), out = f.r.clone().multiplyScalar(side);
      this.quad(Pn, p.clone().addScaledVector(f.t, -0.1), p.clone().addScaledVector(f.t, 0.1), p.clone().addScaledVector(f.t, 0.1).add(V(0, h, 0)), p.clone().addScaledVector(f.t, -0.1).add(V(0, h, 0)), dark, null, out);
    }
  }

  // a loop-the-loop: a teardrop (radius 7 m at the top, 13 m at the bottom) that also steps one lane across, so you
  // come out beside where you went in; a painted steel deck with side rails, held by two towers and a top beam.
  // Needs about 24 m/s (54 mph) at the bottom: the boost pad before it gives you that.
  loop(pth, s0) {
    const Pn = this.G.paint, T = this.T, pts = loopCurve(7, 13, 0.42), n = pts.length, base = pth(s0);
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
    const blue = col(T.loop[0]), blue2 = col(T.loop[1]), yel = col(T.loop[2]), steel = col(0x5d636b), wht = col(T.loop[3]);
    const colorOf = (i, e) => (e === 0 ? steel : e === 4 ? (i % 6 < 3 ? blue : blue2) : e === 2 || e === 6 ? wht : yel);
    this.extrude(Pn, frames, poly, colorOf, (e) => (e === 0 ? PAINT : PAINT), (e) => (e === 4 ? 0.45 : 0.3));
    // the guide's frames: 40 m of lane before it (it pulls you into line), then the deck's
    const lead = []; for (let d = 40; d > 0; d -= 1) lead.push({ p: base.p.clone().addScaledVector(base.t, -d).addScaledVector(base.r, LANE), t: base.t.clone(), b: base.r.clone(), n: Y.clone() });
    this.loopInfo = { s0, len, top: Math.max(...pts.map((p) => p.y)), exitX: pts[n - 1].x, frames, guide: [...lead, ...frames], lead: lead.length, i: null, entryX: -this.XS + s0 };
    this.loopInfo.exitXpark = this.loopInfo.entryX + this.loopInfo.exitX;
    // the frame: two lattice towers either side and a beam over the top
    const tp = this.loopInfo.top, mid = pts.reduce((a, p) => (p.y > a.y ? p : a), pts[0]);
    const cx = base.p.x + mid.x;
    for (const side of [-1, 1]) {
      const z = base.p.z + side * (LANE + w + 2.2);
      for (const dx of [-1.2, 1.2]) this.box(Pn, cx + dx, 0, z, 0.35, tp + 1.6, 0.35, 0, steel, [PAINT, 0.4]);
      for (let y = 1.5; y < tp; y += 2.2) { this.box(Pn, cx, y, z, 2.8, 0.18, 0.18, 0, steel); this.box(Pn, cx, y, z, 0.12, 0.12, 0.6, 0, steel); }
      this.box(Pn, cx, 0, z, 3.4, 0.4, 1.2, 0, col(0x8a8a86));
    }
    this.box(Pn, cx, tp + 1.3, base.p.z, 2.8, 0.5, (LANE + w + 2.5) * 2, 0, col(T.loop[4]));
    this.box(Pn, cx, tp + 0.3, base.p.z - 0.4, 0.2, 1.0, 0.2, 0, steel);
    this.sign(V(cx, tp + 2.2, base.p.z), 'loop', 4, 0, true);
  }

  // the east turn: a berm banked at up to 20 degrees, red and white kerbs, a barrier outside
  bankedTurn(pth) {
    const E = this.G.earth, T = this.T, B = T.bank.map(col), L = Math.PI * RT, f0 = this.link ? 30 : 0; // (a fork: the banking starts after it)
    const bank = (s) => (20 * Math.PI / 180) * smoothstep(f0, f0 + 16, s) * (1 - smoothstep(L - 16, L, s));
    const y = (s, a) => (a + TW) * Math.tan(bank(s));
    this.sweep(E, { s0: 0, s1: L, n: 60, path: pth, cross: (s) => [[-TW, 0], [-TW + 0.6, y(s, -TW + 0.6)], [TW - 0.6, y(s, TW - 0.6)], [TW, y(s, TW)], [TW + 1.5, y(s, TW)]], color: (s, k) => (k === 0 || k === 2 ? (Math.floor(s / 2.5) % 2 ? B[0] : B[1]) : k === 3 ? B[3] : B[2]), type: (s, k) => (k === 0 || k === 2 ? PAINT : DIRT), depth: 1.5, wallColor: () => B[4], wallType: DIRT });
    for (let s = f0 + 2; s < L; s += 1.6) { const f = pth(s); this.tyres(f.p.clone().addScaledVector(f.r, TW + 3.3), 2); }
    this.wallLine(pth, f0, L, TW + 3.3, 1.0);
    if (this.link) this.fork();
    this.sign(pth(L / 2).p.addScaledVector(pth(L / 2).r, TW + 6), 'banked', 4, 0, false, pth(L / 2).r);
  }

  // the fork to the canyon jump: straight on at the east turn, a link lane (a deck, so it's smooth at any terrain
  // resolution) to the jump's run-up, red and white kerbs, a sign
  fork() {
    const Pn = this.G.paint, XS = this.XS, x1 = XS + LINK + 2, red = col(0xc8102e), wht = col(0xf4f4f4), asph = col(0x3a3e46);
    const path = (s) => ({ p: V(s, 0, RT), t: V(1, 0, 0), r: V(0, 0, 1) });
    const dy = this.linkDy, y = (s) => 0.05 + dy * smoothstep(XS + 4, x1 - 4, s); // (up or down to the jump's rim level, gently)
    this.sweep(Pn, { s0: XS - 2, s1: x1, n: Math.ceil((x1 - XS + 2) / 3), path, cross: (s) => [[-TW, y(s)], [-TW + 0.6, y(s)], [TW - 0.6, y(s)], [TW, y(s)]], color: (s, k) => (k === 1 ? asph : Math.floor(s / 3) % 2 ? red : wht), type: () => PAINT, depth: 1, wallColor: () => col(0x6c7178), wallType: PAINT, floor: Math.min(0, dy) - 6, flat: true });
    for (let x = XS + 6; x < x1 - 4; x += 8) this.signQuad([V(x, y(x) + 0.02, RT - 2), V(x, y(x) + 0.02, RT + 2), V(x + 4, y(x + 4) + 0.02, RT + 2), V(x + 4, y(x + 4) + 0.02, RT - 2)], ATLAS.chev);
    this.sign(V(XS + 14, 0, RT + TW + 4), 'daredevil', 8, -1);
  }

  // the west turn: a concrete bowl, flat inside and curving up to a wall at 78 degrees: the faster you go, the higher
  // you ride (the wall ride; New York's is a half pipe with a steel coping)
  bowl(pth) {
    const Pn = this.G.paint, T = this.T, L = Math.PI * RT, Rw = 9, K = 12;
    const env = (s) => smoothstep(0, 24, s) * (1 - smoothstep(L - 24, L, s));
    const cross = (s) => {
      const amax = (78 * Math.PI) / 180, e = env(s), out = [[-TW, 0], [1, 0]]; // (at its ends the wall is lowered, not narrowed: you ride down off it)
      for (let k = 1; k <= K; k++) { const a = (amax * k) / K; out.push([1 + Rw * Math.sin(a), e * Rw * (1 - Math.cos(a))]); }
      const last = out[out.length - 1]; out.push([last[0] + 1.4, last[1]]);
      return out;
    };
    const conc = col(T.bowl[0]), stripe = T.stripes.map(col);
    this.sweep(Pn, { s0: 0, s1: L, n: 64, path: pth, cross, color: (s, k, yy) => (k === 0 ? col(T.bowl[1]) : k >= 2 && k <= K && k % 4 === 0 ? stripe[(k / 4 - 1) % 3] : k === K + 1 ? col(T.bowl[2]) : conc.clone().multiplyScalar(0.95 + 0.05 * Math.sin(s))), type: () => PAINT, depth: 1.6, wallColor: () => col(T.bowl[3]), wallType: PAINT });
    const a78 = (78 * Math.PI) / 180, rimA = 1 + Rw * Math.sin(a78), rimY = Rw * (1 - Math.cos(a78));
    let s0 = null, s1 = 0;
    for (let s = 6; s < L - 6; s += 1.6) { const f = pth(s); if (env(s) > 0.995) { this.tyres(f.p.clone().addScaledVector(f.r, rimA + 0.9).add(V(0, rimY, 0)), 2); s0 ??= s; s1 = s; } }
    this.wallLine(pth, s0, s1, rimA + 0.5, 1.5, rimY); // the barrier along the rim stops you riding over the top
    if (T.coping) for (let s = 0; s < L - 2; s += 2.4) { // a half pipe's steel coping along the lip
      const f0 = pth(s), f1 = pth(s + 2.4), h0 = env(s) * rimY, h1 = env(s + 2.4) * rimY;
      this.tube(Pn, f0.p.clone().addScaledVector(f0.r, rimA).add(V(0, h0 + 0.06, 0)), f1.p.clone().addScaledVector(f1.r, rimA).add(V(0, h1 + 0.06, 0)), 0.09, 0.09, 6, col(0xc8ccd2), false);
    }
    this.sign(pth(L / 2).p.addScaledVector(pth(L / 2).r, rimA + 0.9).add(V(0, rimY, 0)), 'wall', 4.5, 0, false, pth(L / 2).r);
  }

  // ---- the start arch, flags, stands, lights ----
  dressing() {
    const L = this.L, T = this.T, r = this.rnd, flagC = T.flags.map(col), XS = this.XS;
    this.arch(-XS + L.arch, RT);
    // flags along both straights, on the berms
    const [F0, F1, Fs] = L.flags;
    for (let x = F0; x <= F1; x += Fs) { this.flag(V(x, 0, RT + 12.2), flagC[Math.floor(r() * flagC.length)]); this.flag(V(x + Fs / 2, 0, -RT - 12.2), flagC[Math.floor(r() * flagC.length)]); }
    // grandstands with a crowd along the straights (the kickers, the loop, the jump), barriers in front of them
    for (const [x, f, len] of L.stands) this.stand(x, f * (RT + 21), len, f);
    const st = this.barrierStep();
    for (const [x, f, len] of L.stands) for (let xx = x - len / 2 - 1; xx <= x + len / 2 + 1; xx += st) this.tyres(V(xx, 0, f * (RT + 15.5)), 3);
    // floodlight towers
    for (const [x, z] of L.towers) this.tower(x, z);
    if (T.palms) this.palms();
  }
  // the start arch over the track at x = ax: the park's name facing the cars coming in, START on the back, a chequered line
  arch(ax, az) {
    const Pn = this.G.paint, T = this.T, A = T.arch, c0 = col(T.archC[0]), c1 = col(T.archC[1]), AR = this.L.archR || 13, PZ = AR - 1, BW = AR * 2 + 1;
    if (A === 'inflatable') { // an inflatable red and white arch
      const R = AR, tube = 1.0, segA = 26, segT = 8;
      for (let i = 0; i < segA; i++) for (let j = 0; j < segT; j++) {
        const P = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2, rr = R + tube * Math.cos(b); return V(ax + tube * Math.sin(b), rr * Math.sin(a), az + rr * Math.cos(a)); };
        const Nn = (ii, jj) => { const a = (ii / segA) * Math.PI, b = (jj / segT) * Math.PI * 2; return V(Math.sin(b), Math.cos(b) * Math.sin(a), Math.cos(b) * Math.cos(a)); };
        this.quad(Pn, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), i % 4 < 2 ? c0 : c1, null, Nn(i + 0.5, j + 0.5), [Nn(i, j), Nn(i + 1, j), Nn(i + 1, j + 1), Nn(i, j + 1)]);
      }
      for (const s of [-1, 1]) this.box(Pn, ax, 0, az + s * R, 1.8, 1.0, 1.8, 0, col(0x333333), [PAINT, 0.8]);
    } else if (A === 'scaffold') { // a steel truss gantry, a graffiti panel on its beam
      for (const s of [-1, 1]) {
        const z = az + s * PZ;
        for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) this.box(Pn, ax + dx, 0, z + dz, 0.16, 12.4, 0.16, 0, c0);
        for (let y = 1; y < 12; y += 1.6) { this.box(Pn, ax, y, z - 0.6, 1.36, 0.1, 0.1, 0, c0); this.box(Pn, ax, y, z + 0.6, 1.36, 0.1, 0.1, 0, c0); this.box(Pn, ax - 0.6, y + 0.8, z, 0.1, 0.1, 1.36, 0, c0); this.box(Pn, ax + 0.6, y + 0.8, z, 0.1, 0.1, 1.36, 0, c0); }
        this.box(Pn, ax, 0, z, 2.2, 0.5, 2.2, 0, col(0x9a9894), [PAINT, 0.8]); // concrete foot
      }
      this.box(Pn, ax, 9.1, az, 1.4, 3.2, BW - 0.4, 0, c0); this.box(Pn, ax, 12.3, az, 1.5, 0.3, BW, 0, c1);
    } else if (A === 'wood') { // log posts, a timber beam and a little shingle roof, a big cowbell in the middle
      for (const s of [-1, 1]) { this.cyl(Pn, ax, 0, az + s * PZ, 0.5, 0.42, 12.4, 8, c0); this.box(Pn, ax, 0, az + s * PZ, 1.6, 0.6, 1.6, 0, col(0x8a8680), [PAINT, 0.8]); }
      this.box(Pn, ax, 9.1, az, 1.2, 3.2, BW, 0, c0);
      for (const s of [-1, 1]) this.quad(Pn, V(ax + s * 1.6, 12.2, az - PZ - 1.5), V(ax, 13.6, az - PZ - 1.5), V(ax, 13.6, az + PZ + 1.5), V(ax + s * 1.6, 12.2, az + PZ + 1.5), c1, null, V(s, 1, 0));
      this.box(Pn, ax, 8.3, az, 0.12, 0.8, 0.12, 0, col(0x5a3a1a)); this.cyl(Pn, ax, 7.3, az, 0.55, 0.35, 1.0, 10, col(0xb08a3a));
    } else if (A === 'tiki') { // two carved tiki poles, a bamboo beam, a thatched roof
      const wood = c0, dark = col(0x2a1a10), wht = col(0xf4efe0), straw = col(0xc8a45a), bam = col(0xd8c07a);
      for (const s of [-1, 1]) {
        const z = az + s * PZ;
        this.cyl(Pn, ax, 0, z, 1.0, 0.9, 12.6, 10, wood);
        for (const y0 of [2.2, 6.4]) for (const fx of [-1, 1]) { // two faces up each pole, front and back: eyes, brows, a big mouth
          const x = ax + fx * 0.95;
          for (const ez of [-0.38, 0.38]) { this.box(Pn, x, y0 + 1.7, z + ez, 0.12, 0.42, 0.42, 0, wht); this.box(Pn, x + fx * 0.04, y0 + 1.8, z + ez, 0.1, 0.2, 0.2, 0, dark); }
          this.box(Pn, x, y0 + 2.25, z, 0.14, 0.18, 1.2, 0, dark); this.box(Pn, x, y0 + 0.5, z, 0.12, 0.7, 1.1, 0, dark); this.box(Pn, x + fx * 0.02, y0 + 0.75, z, 0.1, 0.22, 0.8, 0, wht);
        }
        this.box(Pn, ax, 0, z, 2.4, 0.6, 2.4, 0, col(0x3a3533), [PAINT, 0.8]);
      }
      this.box(Pn, ax, 9.1, az, 1.2, 3.2, BW, 0, bam);
      for (const s of [-1, 1]) this.quad(Pn, V(ax + s * 2.2, 12.1, az - PZ - 2.5), V(ax, 14.4, az - PZ - 2.5), V(ax, 14.4, az + PZ + 2.5), V(ax + s * 2.2, 12.1, az + PZ + 2.5), straw, null, V(s, 1, 0));
    }
    const bq = (x, f) => [V(x, 9.4, az - 7 * f), V(x, 9.4, az + 7 * f), V(x, 12, az + 7 * f), V(x, 12, az - 7 * f)];
    this.signQuad(bq(ax - 0.9, 1), ATLAS.name); // faces the cars coming in (and the start camera)
    this.signQuad(bq(ax + 0.9, -1), ATLAS.start);
    { const q = [V(ax - 1.5, 0.09, az - TW), V(ax - 1.5, 0.09, az + TW), V(ax + 1.5, 0.09, az + TW), V(ax + 1.5, 0.09, az - TW)]; this.signQuad(q, ATLAS.check); }
  }
  // palms along the outside of both straights and round the pad (tropical parks), clear of the stands and lights
  palms() {
    const L = this.L, XS = this.XS, [PX, PZ] = L.pad, r = this.rnd;
    const busy = (x, z) => L.stands.some(([sx, f, len]) => Math.sign(z) === f && Math.abs(x - sx) < len / 2 + 4) || L.towers.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 8);
    for (let x = -XS; x <= XS; x += 15) for (const z of [RT + 17, -RT - 17]) { const px = x + (r() - 0.5) * 5; if (!busy(px, z)) this.palm(V(px, 0, z + (r() - 0.5) * 3), 8 + r() * 4); }
    for (let k = 0; k < 26; k++) { const a = r() * Math.PI * 2, x = Math.cos(a) * (PX - 6), z = Math.sin(a) * (PZ - 6); if (!busy(x, z) && Math.abs(Math.abs(z) - RT) > 16) this.palm(V(x, 0, z), 8 + r() * 5); }
  }

  // ---- per frame ----
  // A car in the park: boost pads push it to their speed; tells about big air and loops. Returns messages for the HUD.
  drive(ac, dt) {
    if (!ac.isCar || ac.dead || !this.inside(ac.x.x, ac.x.z, 20)) { this.st.air = 0; return null; }
    const st = this.st, msgs = [], up = ac.up || Y;
    const fwd = V(0, 0, -1).applyQuaternion(ac.q);
    if (ac.onGround) {
      this.boostPads(ac, dt, fwd, msgs);
      this.guide(ac, dt); this.bowlGuide(ac, dt);
      if (st.air > 1.0) msgs.push({ toast: `BIG AIR! ${st.air.toFixed(1)} s`, good: true });
      st.air = 0;
      if (up.y < -0.6 && ac.stuntUp) st.upside = true; // on the wheels, upside down: in the loop
      if (st.upside && up.y > 0.8) { st.upside = false; msgs.push({ center: 'LOOP THE LOOP!' }); }
    } else { st.air += dt; if (st.air > 3) st.upside = false; this.jumpGuide(ac, dt); if (ac.isBike) this.bikeAir(ac, dt); }
    return msgs.length ? msgs : null;
  }
  // Over the mesa jump's gap: the flight is nudged (a little: 6 m/s^2) to come down on the middle of the landing ramp,
  // whatever came off the lip (a light, quick bike flies higher and further than a buggy)
  jumpGuide(ac, dt) {
    const J = this.jumpAim, lp = this.Lp(ac.x), vl = this.Ld(ac.v);
    if (lp.x > J.x0 || lp.x < J.x1 || Math.abs(lp.z + RT) > 12 || vl.x > -5) return;
    const D = vl.y * vl.y + 2 * 9.81 * (lp.y - J.y); if (D <= 0) return;
    const t = (vl.y + Math.sqrt(D)) / 9.81; if (t < 0.12) return;
    const dvx = (J.x - lp.x) / t - vl.x, dvz = (-RT - lp.z) / t - vl.z, m = Math.hypot(dvx, dvz), k = Math.min(1, (6 * dt) / (m || 1));
    ac.v.add(this.Wd(V(dvx * k, 0, dvz * k)));
  }
  // A bike off a kicker or the mesa: held level and pointed a touch above its flight path (back wheel first), so it
  // doesn't flip over the bars when the front leaves the lip before the back (bike.js levels it too, more gently)
  bikeAir(ac, dt) {
    const vh = Math.hypot(ac.v.x, ac.v.z); if (vh < 4 || ac.up.y < 0) return;
    const pitch = Math.max(-0.5, Math.min(0.5, Math.atan2(ac.v.y, vh) * 0.5)) + 0.05, f = V(ac.v.x / vh * Math.cos(pitch), Math.sin(pitch), ac.v.z / vh * Math.cos(pitch));
    const up = Y.clone().addScaledVector(f, -f.y).normalize(), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.clone().cross(up), up, f.clone().negate()));
    ac.q.slerp(q, Math.min(1, 5 * dt)).normalize(); ac.w.multiplyScalar(Math.max(0, 1 - 8 * dt));
  }
  // The loop's side rails steer you: on its deck the car is held to the middle and pointed along it (a kid can't steer
  // upside down, and the loop steps a lane sideways). Only sideways and yaw: whether you make it over the top is up to
  // your speed.
  guide(ac, dt) {
    const L = this.loopInfo, F = L.guide, lp = this.Lp(ac.x), x = lp.x, y = lp.y, z = lp.z;
    let bi = -1, bd = 49; // (within 7 m: the lead-in catches you anywhere across the track)
    const i0 = L.i == null ? 0 : Math.max(0, L.i - 8), i1 = L.i == null ? F.length : Math.min(F.length, L.i + 9);
    for (let i = i0; i < i1; i++) { const p = F[i].p, d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    L.i = bi < 0 ? null : bi;
    if (bi < 2 || bi > F.length - 3 || (!ac.stuntUp && bi >= L.lead)) return; // (on the deck: only with the wheels on it)
    if (bi < L.lead && ac.v.dot(this.Wd(F[bi].t)) < 8) return; // the lead-in only pulls you in when you're going for it
    // like a slot car: turn the car and its velocity together about the deck's normal towards the deck's direction, and
    // ease it back to the middle (no tyre slip, so the tyres don't fight it)
    const f = F[bi], e = (x - f.p.x) * f.b.x + (y - f.p.y) * f.b.y + (z - f.p.z) * f.b.z;
    const fwd = this.Ld(V(0, 0, -1).applyQuaternion(ac.q)), err = Math.asin(clamp(fwd.clone().cross(f.t).dot(f.n), -1, 1));
    const turn = new THREE.Quaternion().setFromAxisAngle(this.Wd(f.n), err * Math.min(1, 10 * dt));
    ac.q.premultiply(turn).normalize(); ac.v.applyQuaternion(turn);
    ac.x.addScaledVector(this.Wd(f.b), -e * Math.min(1, 5 * dt));
  }
  // Arcade and Pilot: on the bowl's wall the car is turned to run round it (the bowl is a 180-degree turn you'd have
  // to steer hard into at full speed; kids hit it flat out). How high you ride is still your speed.
  bowlGuide(ac, dt) {
    if (!(ac.R.assist > 0) || !ac.stuntUp || ac.stuntUp.y > 0.97) return;
    const lp = this.Lp(ac.x), x = lp.x + this.XS, z = lp.z, r = Math.hypot(x, z);
    if (x > 0 || r < RT || r > RT + 16) return;
    const nW = ac.stuntUp, n = this.Ld(nW), t = V(z / r, 0, -x / r), psi = Math.atan2(z, x); // (round from psi = -pi/2 via pi to pi/2)
    const out = z > 0 && psi < Math.PI ? smoothstep(1.4, 0.3, psi - Math.PI / 2) : 0; // coming up to the exit: back down off the wall
    // ride the wall where the banking suits your speed (slow: low down, flat out: high up), and come down for the exit
    const bank = Math.acos(clamp(n.y, -1, 1)), eq = Math.atan(ac.v.lengthSq() / (r * 9.81));
    t.addScaledVector(V(-x / r, 0, -z / r), clamp((bank - eq) * 0.8, -0.3, 0.4) * (1 - out) + 0.6 * out * clamp((r - RT - 1) / 6, 0, 1));
    t.addScaledVector(n, -t.dot(n)).normalize();
    const fwd = this.Ld(V(0, 0, -1).applyQuaternion(ac.q));
    if (fwd.dot(t) < 0.3) return; // (not going round it)
    const err = Math.asin(clamp(fwd.clone().cross(t).dot(n), -1, 1)), turn = new THREE.Quaternion().setFromAxisAngle(nW, err * Math.min(1, 4 * dt * ac.R.assist / 0.45));
    ac.q.premultiply(turn).normalize(); ac.v.applyQuaternion(turn);
    // turning at the rate the bend needs (and not at all as you leave it: no slide off sideways at the exit)
    const qi = ac.q.clone().invert(), wn = ac.w.clone().applyQuaternion(ac.q).dot(nW), want = (ac.v.length() / r) * (1 - out);
    ac.w.add(nW.clone().multiplyScalar((want - wn) * Math.min(1, 6 * dt)).applyQuaternion(qi));
    // and it keeps you flat on the wall (no tipping over sideways, tall trucks!), coming level with it as it flattens out
    const up = V(0, 1, 0).applyQuaternion(ac.q), f2 = V(0, 0, -1).applyQuaternion(ac.q), rollErr = Math.asin(clamp(up.clone().cross(nW).dot(f2), -1, 1));
    ac.q.premultiply(new THREE.Quaternion().setFromAxisAngle(f2, rollErr * Math.min(1, 5 * dt))).normalize();
    ac.w.z *= Math.max(0, 1 - 5 * dt);
  }
}
