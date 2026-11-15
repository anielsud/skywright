// Towns, villages, farms, field fences, landmarks and animals.
// Buildings come from the kit in buildkit.js and are merged into one mesh per chunk (a town, or a 2 km cell of
// countryside): shell (walls + roofs) always drawn; detail (balconies, sills, gutters, chimneys, fences, street
// lamps) and ground (plots: lawns, drives, paths, flower beds, pools; pavements and the town square) only near
// the camera. Yard trees borrow the vegetation models from flora.js when it exposes them.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { glowTexture } from './materials.js';
import { Builder, buildingMaterial, C, BLD_U } from './buildings.js';
import { makeBuilding } from './buildkit.js';

function vc(g, hex, mult = 1) {
  const geo = g.index ? g.toNonIndexed() : g; const c = new THREE.Color(hex).multiplyScalar(mult), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); return geo;
}
// per quality tier: building density, detail / ground draw distance, detail level (0 none, 1 sills + gutters,
// 2 + lintels, downpipes, rafters), plots, atlas cell size, interior mapping
const TIER = {
  low: { dens: 0.5, detail: 900, ground: 500, fine: 0, plots: false, cell: 128, interiors: false, trees: 0 },
  medium: { dens: 0.8, detail: 1500, ground: 900, fine: 1, plots: true, cell: 192, interiors: true, trees: 0.6 },
  high: { dens: 1, detail: 2400, ground: 1500, fine: 2, plots: true, cell: 256, interiors: true, trees: 1 },
  ultra: { dens: 1.15, detail: 3200, ground: 2200, fine: 2, plots: true, cell: 384, interiors: true, trees: 1.3 },
};

export class Towns {
  constructor(world) {
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const r = (this.r = mulberry32(world.loc.seed * 5 + 3)), W = world, st = W.loc.id;
    const T = (this.T = TIER[W.qName] || TIER[W.qBase] || TIER.medium);
    this.dens = T.dens; this.detailDist = T.detail;
    this.grid = new Map(); this.chimneys = []; this.chunks = new Map(); this.foot = new Map(); this.count = 0;
    this.parkSpots = []; this.yardTrees = []; this.lamps = [];
    this.cover = new Map(); // 20 m hash of oriented rects (plots, paving, footprints) where no wild grass grows
    const t0 = performance.now();
    // ---- placement with footprint (oriented box) overlap tests ----
    const overlaps = (o) => {
      const R = Math.ceil((o.rad + 20) / 40), cx = Math.floor(o.x / 40), cz = Math.floor(o.z / 40);
      for (let i = cx - R; i <= cx + R; i++) for (let j = cz - R; j <= cz + R; j++) {
        const arr = this.foot.get(i + ',' + j); if (!arr) continue;
        for (const p of arr) if ((p.x - o.x) ** 2 + (p.z - o.z) ** 2 < (p.rad + o.rad) ** 2 && obbHit(p, o)) return true;
      }
      return false;
    };
    const addFoot = (o) => { const R = Math.ceil(o.rad / 40), cx = Math.floor(o.x / 40), cz = Math.floor(o.z / 40); for (let i = cx - R; i <= cx + R; i++) for (let j = cz - R; j <= cz + R; j++) { const k = i + ',' + j; if (!this.foot.has(k)) this.foot.set(k, []); this.foot.get(k).push(o); } };
    const chunkOf = (key) => {
      if (!this.chunks.has(key)) { const ch = { S: new Builder(), D: new Builder(), G: new Builder(), L: [], x: 0, z: 0, n: 0 }; ch.S.det = ch.D; ch.S.fine = ch.D.fine = T.fine; this.chunks.set(key, ch); }
      return this.chunks.get(key);
    };
    this.chunkOf = chunkOf;
    const nearAirport = (x, z) => Math.abs(x - 140) < 380 && Math.abs(z) < 1150;
    // place a building made by makeBuilding(); (x,z) centre, yaw so local +z faces the street
    const place = (b, x, z, yaw, opts = {}) => {
      const cs = Math.cos(yaw), sn = Math.sin(yaw), hw = b.w / 2 + (opts.pad ?? 1), hd = b.d / 2 + (opts.pad ?? 1);
      const o = { x, z, hw, hd, ax: cs, az: -sn, bx: sn, bz: cs, rad: Math.hypot(hw, hd) };
      if (nearAirport(x, z) || overlaps(o)) return false;
      let mn = 1e9, mx = -1e9;
      for (const [u, v] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const px = x + u * hw * cs + v * hd * sn, pz = z - u * hw * sn + v * hd * cs, h = W.sampleGrid(px, pz);
        if (h < W.waterLevel + 0.6) return false;
        if (W.nearRoad(px, pz, opts.road ?? 2.5)) return false;
        if (opts.trees !== false && W.flora?.hit({ x: px, y: h + 1, z: pz })) return false;
        mn = Math.min(mn, h); mx = Math.max(mx, h);
      }
      if (mx - mn > (opts.slope ?? 3.5)) return false;
      addFoot(o); this.covered(x, z, yaw, -b.w / 2, b.w / 2, -b.d / 2, b.d / 2);
      const ch = chunkOf(opts.chunk ?? 'c' + Math.floor(x / 2000) + ',' + Math.floor(z / 2000)), y = mn + 0.05;
      ch.x += x; ch.z += z; ch.n++;
      ch.S.seed = ch.D.seed = Math.floor(r() * 255);
      ch.S.setFrame(x, y, z, yaw); ch.D.setFrame(x, y, z, yaw); b.draw(ch.S, ch.D);
      const key = Math.floor(x / 50) + ',' + Math.floor(z / 50); if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push([x, y, z, b.h, Math.min(b.w, b.d) * 0.5 + 0.5]);
      if (b.chimney && st === 'alpine' && this.chimneys.length < 70 && r() < 0.35) { const [lx, ly, lz] = b.chimney; this.chimneys.push(new THREE.Vector3(x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs)); }
      if (T.plots && b.yard && opts.plot !== false) this.plot(ch, b, x, y, z, yaw, opts.front ?? 4 + r() * 3);
      if (opts.after) opts.after(ch, x, y, z, yaw);
      this.count++;
      return true;
    };
    const mk = (type) => makeBuilding(type, st, r);
    // walk a polyline: point + tangent at arc length s
    const walker = (pts) => {
      const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      return { total: L.at(-1), at(s) { let i = 1; while (i < L.length - 1 && L[i] < s) i++; const a = pts[i - 1], b = pts[i], t = (s - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]), dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return { x: a.x + dx * t, z: a.z + dz * t, dx: dx / l, dz: dz / l }; } };
    };
    // line a road with buildings on both sides (front row + optional back row)
    const lineRoad = (pts, width, s0, s1, chunk, pickType, back, walk = 0) => {
      const wk = walker(pts); s1 = Math.min(s1, wk.total);
      for (const side of [-1, 1]) {
        let s = s0 + r() * 6;
        while (s < s1 - 4) {
          const type = pickType(wk.at(s)), b = mk(type), center = type === 'center';
          const p = wk.at(s + b.w / 2), nx = -p.dz * side, nz = p.dx * side;
          const setback = center ? 3 + walk * 0.6 : 5 + walk + r() * 5, off = width / 2 + setback + b.d / 2, x = p.x + nx * off, z = p.z + nz * off, yaw = Math.atan2(-nx, -nz);
          const ok = place(b, x, z, yaw, { chunk, pad: center ? 0.3 : 1.2, front: setback - walk });
          s += ok ? b.w + (center ? 0.6 + r() * 2 : 4 + r() * 7) : 5;
          if (ok && back && r() < back) { const b2 = mk('house'), off2 = off + b.d / 2 + 9 + r() * 6 + b2.d / 2, flip = r() < 0.25; place(b2, p.x + nx * off2, p.z + nz * off2, yaw + (flip ? Math.PI : 0), { chunk, plot: !flip, front: 4 }); }
        }
      }
    };
    // ---- towns ----
    W.net.towns.forEach((t, ti) => {
      const chunk = 'town' + ti, side = new THREE.Vector3(-t.dir.z, 0, t.dir.x), facing = Math.atan2(t.dir.x, t.dir.z);
      const typeAt = (p) => (Math.hypot(p.x - t.c.x, p.z - t.c.z) < 150 * t.size + 30 ? 'center' : 'house');
      // landmarks first so they get good spots; the church gets a paved square with a fountain
      for (let k = 0; k < 12; k++) if (place(mk('church'), t.c.x + side.x * (40 + k * 6) + t.dir.x * (k - 4) * 9, t.c.z + side.z * (40 + k * 6) + t.dir.z * (k - 4) * 9, facing - Math.PI / 2, { chunk, pad: 6, after: (ch, x, y, z, yaw) => this.square(ch, x, y, z, yaw, st, r) })) break;
      if (st === 'canyon') {
        for (let k = 0; k < 10; k++) if (place(mk('waterTower'), t.c.x - side.x * (50 + k * 10) - t.dir.x * 60, t.c.z - side.z * (50 + k * 10) - t.dir.z * 60, 0, { chunk })) break;
        const e = t.c.clone().addScaledVector(t.dir, 520 * t.size * 0.4 + 30);
        for (let k = 0; k < 10; k++) if (place(mk('gasStation'), e.x + side.x * (24 + k * 6) + t.dir.x * k * 10, e.z + side.z * (24 + k * 6) + t.dir.z * k * 10, facing - Math.PI / 2, { chunk })) break;
      }
      for (const rd of W.net.roads) {
        const near = Math.hypot(rd.pts[0].x - t.c.x, rd.pts[0].z - t.c.z);
        if (rd.kind === 'street' && near < 700) lineRoad(rd.pts, rd.width, 0, 1e9, chunk, typeAt, 0.8 * this.dens, T.plots ? 2.4 : 0);
        else if (rd.kind === 'main' && !rd.closed && near < 5) lineRoad(rd.pts, rd.width, 260 * t.size, 260 * t.size + 260 * this.dens, chunk, () => 'house', 0.3 * this.dens);
      }
      // infill between the streets
      for (let k = 0; k < 140 * t.size * this.dens; k++) {
        const a = r() * 6.28, d = 40 + Math.sqrt(r()) * 340 * t.size, x = t.c.x + Math.cos(a) * d, z = t.c.z + Math.sin(a) * d;
        place(mk(d < 120 * t.size ? 'center' : 'house'), x, z, facing + Math.round(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.15, { chunk });
      }
      // a farm or two on the edge of town
      for (let k = 0; k < 6 * t.size; k++) { const a = r() * 6.28, d = 380 * t.size + r() * 120, x = t.c.x + Math.cos(a) * d, z = t.c.z + Math.sin(a) * d; if (place(mk('barn'), x, z, a, { chunk })) place(mk('silo'), x + Math.cos(a + 1.3) * 16, z + Math.sin(a + 1.3) * 16, 0, { chunk }); }
      this.streets(chunkOf(chunk), t, st);
    });
    // ---- villages strung along main roads and highways ----
    let villages = 0; const maxV = Math.round((st === 'islands' ? 6 : 12) * this.dens);
    for (const rd of W.net.roads) {
      if (rd.kind !== 'highway' && !(rd.kind === 'main')) continue;
      for (let i = 40 + Math.floor(r() * 40); i < rd.pts.length - 20 && villages < maxV; i += 70 + Math.floor(r() * 60)) {
        const p = rd.pts[i];
        if (r() < 0.35 || nearAirport(p.x, p.z) || Math.hypot(p.x - 140, p.z) < 1300) continue;
        if (W.net.towns.some((t) => Math.hypot(t.c.x - p.x, t.c.z - p.z) < 650 * t.size)) continue;
        const h = W.sampleGrid(p.x, p.z); if (h < W.waterLevel + 2 || h > W.loc.snowline - 250) continue;
        const before = this.count;
        lineRoad(rd.pts.slice(Math.max(0, i - 14), i + 14), rd.width, 0, 1e9, undefined, () => 'house', 0.45 * this.dens);
        if (this.count - before >= 3) { villages++; if (st !== 'islands' && r() < 0.5) place(mk('church'), p.x + (r() - 0.5) * 60, p.z + (r() - 0.5) * 60, r() * 6.28); }
      }
    }
    // ---- farmsteads beside the fields ----
    for (const f of W.net.fields) {
      if (r() > 0.25 + 0.65 * this.dens) continue;
      const ca = Math.cos(f.ang), sa = Math.sin(f.ang), toW = (u, v) => [f.x + u * ca - v * sa, f.z + u * sa + v * ca];
      for (let tries = 0; tries < 4 && !f.farm; tries++) {
        const su = r() < 0.5 ? 1 : -1, u = su * (f.sx + 26), v = (r() - 0.5) * f.sz, [x, z] = toW(u, v);
        const yaw = Math.atan2(-su * ca, -su * sa); // face the field
        if (!place(mk('house'), x, z, yaw)) continue;
        f.farm = new THREE.Vector3(x, 0, z);
        const [bx, bz] = toW(u + su * 6, v + (v > 0 ? -1 : 1) * 30); place(mk('barn'), bx, bz, yaw + Math.PI / 2);
        for (let k = 0; k < 1 + Math.floor(r() * 3); k++) { const [sx, sz] = toW(u + su * (20 + k * 8), v + (v > 0 ? -1 : 1) * 30); place(mk('silo'), sx, sz, 0, { pad: 0.5 }); }
        const [hx, hz] = toW(u + su * 24, v + (v > 0 ? 1 : -1) * 6); place(mk('shed'), hx, hz, yaw + Math.PI);
      }
    }
    // ---- beach huts on the islands ----
    if (st === 'islands') for (let k = 0; k < 220 * this.dens; k++) {
      const a = r() * 6.28, x = 140 + Math.cos(a) * 1500 * 0.95, z = Math.sin(a) * 3200;
      for (let s = 0; s < 40; s++) { const xx = x * (1 - s * 0.01), zz = z * (1 - s * 0.01); const h = W.sampleGrid(xx, zz); if (h > W.waterLevel + 1 && h < W.waterLevel + 4) { place(mk('hut'), xx, zz, a + Math.PI, { pad: 4 }); break; } }
    }
    this.buildFences();
    this.buildMeshes();
    this.buildTrees();
    this.buildTime = performance.now() - t0;
    // keep flora's wild grass tufts off lawns, paving and floors (wraps its per-cell generator, if it has one)
    const gc = W.flora?.cover;
    if (gc && typeof gc.gen === 'function' && this.cover.size && !gc._townWrap) {
      const gen = gc.gen.bind(gc), self = this; gc._townWrap = true;
      gc.gen = function (ci, cj) {
        const c = gen(ci, cj), keep = (M, Cc) => { if (!M || !M.length) return [M, Cc]; const m = [], cc = []; for (let i = 0; i < M.length / 16; i++) if (!self.isCovered(M[i * 16 + 12], M[i * 16 + 14])) { for (let k = 0; k < 16; k++) m.push(M[i * 16 + k]); cc.push(Cc[i * 3], Cc[i * 3 + 1], Cc[i * 3 + 2]); } return [new Float32Array(m), new Float32Array(cc)]; };
        if (c && c.g) { [c.g, c.gc] = keep(c.g, c.gc); [c.e, c.ec] = keep(c.e, c.ec); if (c.f) [c.f, c.fc] = keep(c.f, c.fc); }
        return c;
      };
    }
    this.buildLandmarks();
    this.buildAnimals();
  }

  // ---- ground helpers (world coordinates) ----
  // a rectangle in a building's frame (centre x,z, yaw), u from u0..u1 (local x), v from v0..v1 (local z), draped on the ground
  covered(x, z, yaw, u0, u1, v0, v1) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw), o = { x, z, cs, sn, u0, u1, v0, v1 }, R = Math.max(-u0, u1, -v0, v1) * 1.42;
    for (let i = Math.floor((x - R) / 20); i <= Math.floor((x + R) / 20); i++) for (let j = Math.floor((z - R) / 20); j <= Math.floor((z + R) / 20); j++) { const k = i + ',' + j; if (!this.cover.has(k)) this.cover.set(k, []); this.cover.get(k).push(o); }
  }
  // is (x,z) on a plot, paving or under a building? (keeps flora's wild grass tufts off lawns and drives)
  isCovered(x, z) {
    const arr = this.cover.get(Math.floor(x / 20) + ',' + Math.floor(z / 20)); if (!arr) return false;
    for (const o of arr) { const dx = x - o.x, dz = z - o.z, u = dx * o.cs - dz * o.sn, v = dx * o.sn + dz * o.cs; if (u > o.u0 && u < o.u1 && v > o.v0 && v < o.v1) return true; }
    return false;
  }
  drape(G, x, z, yaw, u0, u1, v0, v1, cell, col, lift = 0.1, step = 6) {
    this.covered(x, z, yaw, u0, u1, v0, v1);
    const W = this.w, cs = Math.cos(yaw), sn = Math.sin(yaw), nu = Math.max(1, Math.ceil((u1 - u0) / step)), nv = Math.max(1, Math.ceil((v1 - v0) / step));
    const P = (u, v) => { const px = x + u * cs + v * sn, pz = z - u * sn + v * cs; return [px, W.sampleGrid(px, pz) + lift, pz]; };
    G.setFrame(0, 0, 0, 0);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const ua = u0 + (u1 - u0) * i / nu, ub = u0 + (u1 - u0) * (i + 1) / nu, va = v0 + (v1 - v0) * j / nv, vb = v0 + (v1 - v0) * (j + 1) / nv;
      G.quad(P(ua, vb), P(ub, vb), P(ub, va), P(ua, va), [ua / 3, vb / 3, ub / 3, vb / 3, ub / 3, va / 3, ua / 3, va / 3], cell, col);
    }
  }
  // a fence / hedge / wall run in a building's frame from (u0,v0) to (u1,v1)
  fence(D, x, z, yaw, u0, v0, u1, v1, kind, col) {
    const W = this.w, cs = Math.cos(yaw), sn = Math.sin(yaw), L = Math.hypot(u1 - u0, v1 - v0); if (L < 0.5) return;
    const n = Math.max(1, Math.ceil(L / 7));
    D.setFrame(0, 0, 0, 0);
    for (let k = 0; k < n; k++) {
      const ua = u0 + (u1 - u0) * k / n, va = v0 + (v1 - v0) * k / n, ub = u0 + (u1 - u0) * (k + 1) / n, vb = v0 + (v1 - v0) * (k + 1) / n;
      const ax = x + ua * cs + va * sn, az = z - ua * sn + va * cs, bx = x + ub * cs + vb * sn, bz = z - ub * sn + vb * cs, ya = W.sampleGrid(ax, az), yb = W.sampleGrid(bx, bz), l = L / n;
      if (kind === 'hedge' || kind === 'wall' || kind === 'adobe') {
        const hgt = kind === 'hedge' ? 1.3 : kind === 'wall' ? 0.8 : 1.4, th = kind === 'hedge' ? 0.8 : 0.4, cell = kind === 'hedge' ? C.HEDGE : kind === 'wall' ? C.STONE : C.ADOBE;
        const ux = (bx - ax) / l, uz = (bz - az) / l, hl = l / 2 + (kind === 'hedge' ? 0.2 : 0.02), y0 = Math.min(ya, yb) - 0.3, y1 = Math.min(ya, yb) + hgt, mx = (ax + bx) / 2, mz = (az + bz) / 2, px = -uz * th / 2, pz = ux * th / 2;
        for (const sg of [1, -1]) D.plainQuad([mx - ux * hl * sg + px * sg, y0, mz - uz * hl * sg + pz * sg], [mx + ux * hl * sg + px * sg, y0, mz + uz * hl * sg + pz * sg], [mx + ux * hl * sg + px * sg, y1, mz + uz * hl * sg + pz * sg], [mx - ux * hl * sg + px * sg, y1, mz - uz * hl * sg + pz * sg], cell, col);
        D.plainQuad([mx - ux * hl + px, y1, mz - uz * hl + pz], [mx + ux * hl + px, y1, mz + uz * hl + pz], [mx + ux * hl - px, y1, mz + uz * hl - pz], [mx - ux * hl - px, y1, mz - uz * hl - pz], cell, col);
      } else { // picket / rail panel (double sided, alpha cut-outs) + posts
        const hgt = kind === 'picket' ? 0.95 : 1.1;
        D.panel([ax, ya - 0.05, az], [bx, yb - 0.05, bz], [bx, yb + hgt, bz], [ax, ya + hgt, az], kind === 'picket' ? C.RAIL_IRON : C.RAIL_WOOD, col, 3, [0, 0, l / 1.2, 0, l / 1.2, 1, 0, 1]);
        D.obox(ax, az, (bx - ax) / l, (bz - az) / l, 0.06, 0.06, ya - 0.2, ya + hgt + 0.1, C.TRIM, col, { top: false });
      }
    }
  }
  // a detached home's plot: lawn, drive, path, flower beds, fences, trees, maybe a pool or garden shed, a car
  plot(ch, b, x, y, z, yaw, front) {
    const r = this.r, st = this.w.loc.id, G = ch.G, D = ch.D, cs = Math.cos(yaw), sn = Math.sin(yaw);
    const hw = b.w / 2, hd = b.d / 2, side = b.garage || 1, dx = b.driveX ?? side * (hw + 1.8), back = 6 + r() * 8;
    const uL = Math.min(-hw - 2 - r() * 2, dx - 2), uR = Math.max(hw + 2 + r() * 2, dx + 2), vF = hd + Math.max(1.5, front), vB = -hd - back;
    const W = this.w, gh = W.sampleGrid(x, z), tc = W.baseColor ? W.baseColor(x, z, gh, 0, new THREE.Color()) : new THREE.Color(0.2, 0.3, 0.1);
    // lawns: the terrain's own colour, a little brighter and greener (mown, watered); desert yards: gravel between sand and terrain
    const lawnCol = st === 'canyon' ? new THREE.Color(0xc8a888).lerp(tc, 0.35).getHex() : tc.multiplyScalar(0.5 + r() * 0.15).lerp(new THREE.Color(0.07, 0.13, 0.03), 0.2).getHex();
    const lift = 0.06 + r() * 0.04;
    this.drape(G, x, z, yaw, uL, uR, vB, vF, st === 'canyon' && r() < 0.7 ? C.GRAVEL : C.LAWN, lawnCol, lift);
    // drive + path + flower bed
    const dcell = st === 'alpine' ? (r() < 0.5 ? C.PAVERS : C.ASPHALT) : st === 'canyon' ? C.CONCRETE : (r() < 0.5 ? C.PAVERS : C.GRAVEL);
    this.drape(G, x, z, yaw, dx - 1.5, dx + 1.5, hd - (b.driveX != null ? 0 : 6), vF, dcell, 0xffffff, lift + 0.03);
    const doorX = b.door ?? 0;
    this.drape(G, x, z, yaw, doorX - 0.6, doorX + 0.6, hd, vF, C.PAVERS, 0xf0e8e0, lift + 0.04);
    if (st !== 'canyon' || r() < 0.4) for (const [a, c] of [[-hw + 0.3, doorX - 1], [doorX + 1, Math.min(hw, dx - 1.6) - 0.3]]) if (c - a > 1) this.drape(G, x, z, yaw, a, c, hd + 0.1, hd + 1.0, C.FLOWERS, 0xffffff, lift + 0.05);
    // boundary: front fence with gaps for path + drive, sides and back
    const kind = st === 'alpine' ? (r() < 0.5 ? 'rail' : r() < 0.5 ? 'hedge' : 'picket') : st === 'islands' ? (r() < 0.45 ? 'picket' : r() < 0.6 ? 'hedge' : 'wall') : (r() < 0.6 ? 'adobe' : 'none');
    const fcol = kind === 'picket' ? 0xf4f4f0 : kind === 'hedge' ? [0x8fae70, 0x7a9a60, 0x9ab878][Math.floor(r() * 3)] : kind === 'adobe' ? 0xd8a878 : kind === 'rail' ? 0xd8b890 : 0xffffff;
    if (kind !== 'none' && this.T.fine > 0) {
      const gaps = [[doorX - 0.8, doorX + 0.8], [dx - 1.8, dx + 1.8]].sort((a, c) => a[0] - c[0]);
      let u = uL; for (const [a, c] of gaps) { if (a > u) this.fence(D, x, z, yaw, u, vF, Math.min(a, uR), vF, kind, fcol); u = Math.max(u, c); }
      if (u < uR) this.fence(D, x, z, yaw, u, vF, uR, vF, kind, fcol);
      if (kind !== 'picket' || r() < 0.5) { this.fence(D, x, z, yaw, uL, vB, uL, vF - 0.3, kind === 'picket' ? 'hedge' : kind, fcol); this.fence(D, x, z, yaw, uR, vF - 0.3, uR, vB, kind === 'picket' ? 'hedge' : kind, fcol); this.fence(D, x, z, yaw, uR, vB, uL, vB, kind === 'picket' ? 'hedge' : kind, fcol); }
    }
    const W2 = (u, v) => [x + u * cs + v * sn, z - u * sn + v * cs];
    // a car on the drive
    if (r() < 0.6) { const vc_ = front > 6 ? hd + 3.2 : hd - 3; const [px, pz] = W2(dx, vc_); this.parkSpots.push({ x: px, z: pz, yaw: yaw + (r() < 0.5 ? 0 : Math.PI) }); }
    // trees in the back / side yard
    for (let k = 0; k < (this.T.trees > 0 ? (r() < 0.75 ? 1 : 0) + (r() < 0.35 * this.T.trees ? 1 : 0) : 0); k++) {
      const u = uL + 1.5 + r() * (uR - uL - 3), v = vB + 1.5 + r() * Math.max(0.5, back - 3);
      const [px, pz] = W2(u, v); this.yardTrees.push({ x: px, z: pz, s: 0.4 + r() * 0.4, kind: k === 0 && r() < 0.3 ? 'conifer' : 'tree' });
    }
    if (front > 5.5 && r() < 0.4) { const [px, pz] = W2(-side * (hw * 0.6), vF - 2.5); this.yardTrees.push({ x: px, z: pz, s: 0.35 + r() * 0.3, kind: 'tree' }); }
    // pool (islands / canyon) or a garden shed
    if ((st === 'islands' || st === 'canyon') && back > 9 && r() < 0.45) {
      const pw = 3.5 + r() * 2, pl = 6 + r() * 3, pu = (uL + uR) / 2 + (r() - 0.5) * 3, pv = vB + back * 0.5;
      this.drape(G, x, z, yaw, pu - pw / 2 - 1.2, pu + pw / 2 + 1.2, pv - pl / 2 - 1.2, pv + pl / 2 + 1.2, C.PAVERS, 0xf4f0e8, lift + 0.06);
      this.drape(G, x, z, yaw, pu - pw / 2, pu + pw / 2, pv - pl / 2, pv + pl / 2, C.POOL, 0xffffff, lift + 0.09, 20);
    } else if (r() < 0.3 && back > 7) {
      const sb = makeBuilding('gardenShed', st, r), [px, pz] = W2(uL + 2, vB + 2); const ys = this.w.sampleGrid(px, pz);
      ch.S.setFrame(px, ys, pz, yaw); ch.D.setFrame(px, ys, pz, yaw); sb.draw(ch.S, ch.D);
    }
  }
  // town square around the church: cobbles, a fountain, benches, trees, market stalls / umbrellas
  square(ch, x, y, z, yaw, st, r) {
    if (!this.T.plots) return;
    const G = ch.G, D = ch.D, cs = Math.cos(yaw), sn = Math.sin(yaw), W2 = (u, v) => [x + u * cs + v * sn, z - u * sn + v * cs];
    this.drape(G, x, z, yaw, -17, 17, -16, 34, st === 'canyon' ? C.PAVERS : C.COBBLE, st === 'canyon' ? 0xe8c8a0 : 0xffffff, 0.12);
    // fountain in front of the church
    const [fx, fz] = W2(0, 26), fy = this.w.sampleGrid(fx, fz);
    D.setFrame(fx, fy, fz, yaw);
    if (st === 'alpine') { // a long wooden/stone village trough with a spout column
      D.box(0, -0.2, 0, 4.2, 0.9, 1.6, C.STONE, 0xd8d0c0, { topCell: C.STONE }); D.box(0, 0.62, 0, 3.8, 0.04, 1.2, C.POOL, 0xffffff);
      D.box(-2.4, -0.2, 0, 0.5, 2.0, 0.5, C.STONE, 0xd8d0c0); D.box(-2.0, 1.45, 0, 0.6, 0.08, 0.08, C.METAL, 0x5a5a5a); for (let k = 0; k < 4; k++) D.box(-2.4, 1.8 + k * 0.01, 0, 0.6, 0.12, 0.6, C.FLOWERS, 0xffffff);
    } else {
      D.cyl(0, 0, -0.2, 0.7, 3.4, 3.4, 20, C.STONE, 0xe8e0d0, { cap: false }); D.cyl(0, 0, 0.55, 0.56, 3.2, 3.2, 20, C.POOL, 0xffffff, { cap: true, capCell: C.POOL });
      D.cyl(0, 0, 0.5, 2.2, 0.35, 0.25, 8, C.STONE, 0xe8e0d0); D.cyl(0, 0, 2.2, 2.4, 1.2, 1.2, 12, C.STONE, 0xe8e0d0, { cap: true }); D.cyl(0, 0, 2.4, 3.0, 0.15, 0.08, 6, C.STONE, 0xe8e0d0);
    }
    // benches + trees around the square
    for (const [u, v, a] of [[-12, 20, Math.PI / 2], [12, 20, -Math.PI / 2], [-12, 30, Math.PI / 2], [12, 30, -Math.PI / 2]]) {
      const [bx, bz] = W2(u, v), by = this.w.sampleGrid(bx, bz); D.setFrame(bx, by, bz, yaw + a);
      D.box(0, 0.42, 0, 1.8, 0.06, 0.45, C.DARKWOOD, 0xc8a070); D.box(0, 0.5, -0.22, 1.8, 0.45, 0.05, C.DARKWOOD, 0xc8a070); for (const s of [-0.8, 0.8]) D.box(s, -0.1, 0, 0.08, 0.55, 0.45, C.METAL, 0x333333);
      const [tx, tz] = W2(u * 1.25, v - 3); this.yardTrees.push({ x: tx, z: tz, s: 0.6 + r() * 0.3, kind: st === 'islands' ? 'palm' : 'tree' });
    }
    // market stalls with striped awnings / umbrellas
    if (st !== 'canyon') for (let k = 0; k < 6; k++) {
      const [mx, mz] = W2(-10 + k * 4, 12 + (k % 2) * 1.5), my = this.w.sampleGrid(mx, mz); D.setFrame(mx, my, mz, yaw);
      const col = [0xc8283a, 0x2e6b3f, 0x1d4e89, 0xe8a43c][k % 4];
      D.box(0, -0.1, 0, 2.6, 0.95, 1.4, C.DARKWOOD, 0xc8a070); for (const [a, c] of [[-1.2, -0.6], [1.2, -0.6], [-1.2, 0.6], [1.2, 0.6]]) D.box(a, 0.8, c, 0.06, 1.5, 0.06, C.METAL, 0x666666, { top: false });
      D.quad([-1.5, 2.2, 0.9], [1.5, 2.2, 0.9], [1.5, 2.6, -0.9], [-1.5, 2.6, -0.9], [0, 0, 1, 0, 1, 1, 0, 1], C.SHOP, col);
      D.box(0, 0.86, 0, 2.4, 0.12, 1.2, C.FLOWERS, 0xffffff);
    }
  }
  // pavements with kerbs, street lamps and parking bays along a town's streets
  streets(ch, t, st) {
    if (!this.T.plots) return;
    const W = this.w, G = ch.G, D = ch.D, roads = W.net.roads.filter((rd) => rd.kind === 'street' && Math.hypot(rd.pts[0].x - t.c.x, rd.pts[0].z - t.c.z) < 700);
    const others = W.net.roads.filter((rd) => !rd.closed && Math.hypot(rd.pts[0].x - t.c.x, rd.pts[0].z - t.c.z) < 1500);
    // pavements stop where another road crosses; a road running along the same corridor (the town's connector on its
    // main street) just widens the kerb line instead
    const along = (o, i, ux, uz) => { const a = o.pts[Math.max(0, i - 1)], b = o.pts[Math.min(o.pts.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1; return Math.abs(((b.x - a.x) * ux + (b.z - a.z) * uz) / l) > 0.9; };
    const onOther = (rd, x, z, pad, ux, uz, out) => { for (const o of others) { if (o === rd) continue; for (let i = 0; i < o.pts.length; i++) { const p = o.pts[i]; if ((p.x - x) ** 2 + (p.z - z) ** 2 < (o.width / 2 + pad) ** 2) { if (along(o, i, ux, uz)) { out.w = Math.max(out.w, o.width / 2); continue; } return true; } } } return false; };
    const pw = 2.4, kerb = 0.15, pcell = st === 'canyon' ? C.CONCRETE : C.PAVERS, pcol = st === 'canyon' ? 0xa8a29a : 0xe8e4dc;
    for (const rd of roads) {
      const P = rd.pts, hw = rd.width / 2;
      let lampAcc = 0, li = 0;
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz); if (L < 0.1) continue;
        const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
        for (const s of [-1, 1]) {
          const mx = (a.x + b.x) / 2 + nx * s * (hw + pw / 2), mz = (a.z + b.z) / 2 + nz * s * (hw + pw / 2), wide = { w: hw };
          if (onOther(rd, (a.x + b.x) / 2 + nx * s * hw, (a.z + b.z) / 2 + nz * s * hw, pw, ux, uz, wide) || onOther(rd, mx, mz, pw * 0.5, ux, uz, wide)) continue;
          const kw = wide.w + 0.4 * (wide.w > hw);
          const pa = [a.x + nx * s * kw, a.z + nz * s * kw], pb = [b.x + nx * s * kw, b.z + nz * s * kw], qa = [pa[0] + nx * s * pw, pa[1] + nz * s * pw], qb = [pb[0] + nx * s * pw, pb[1] + nz * s * pw];
          const y = (p) => Math.max(W.sampleGrid(p[0], p[1]), a.y - 1.5) + 0.25 + kerb;
          G.setFrame(0, 0, 0, 0); this.covered(mx, mz, Math.atan2(nx, nz), -pw / 2 - 0.3, pw / 2 + 0.3, -L / 2 - 0.5, L / 2 + 0.5);
          const A = [pa[0], y(pa), pa[1]], B = [pb[0], y(pb), pb[1]], Aq = [qa[0], y(qa), qa[1]], Bq = [qb[0], y(qb), qb[1]];
          const u0 = i * L / 3, u1 = (i + 1) * L / 3;
          if (s < 0) G.quad(A, B, Bq, Aq, [u0, 0, u1, 0, u1, pw / 3, u0, pw / 3], pcell, pcol); else G.quad(B, A, Aq, Bq, [u1, 0, u0, 0, u0, pw / 3, u1, pw / 3], pcell, pcol);
          // kerb face toward the road
          const A0 = [A[0], A[1] - kerb - 0.05, A[2]], B0 = [B[0], B[1] - kerb - 0.05, B[2]];
          if (s > 0) G.quad(B0, A0, A, B, [0, 0, L / 3, 0, L / 3, 0.06, 0, 0.06], C.CONCRETE, 0xd8d6d0); else G.quad(A0, B0, B, A, [0, 0, L / 3, 0, L / 3, 0.06, 0, 0.06], C.CONCRETE, 0xd8d6d0);
          // lamps every ~26 m, alternating sides
          if (s === (li % 2 ? 1 : -1)) {
            lampAcc += L; if (lampAcc > 26) { lampAcc = 0; li++; this.lamp(D, ch, qa[0] - nx * s * 0.5, W.sampleGrid(qa[0], qa[1]) + 0.25 + kerb, qa[1] - nz * s * 0.5, Math.atan2(-nx * s, -nz * s), st); }
          }
        }
      }
    }
  }
  lamp(D, ch, x, y, z, yaw, st) {
    D.setFrame(x, y, z, yaw);
    const pole = st === 'islands' ? 0xf0f0ec : st === 'canyon' ? 0x8a8e94 : 0x2a2c2e;
    D.cyl(0, 0, -0.3, 0.6, 0.16, 0.12, 6, C.METAL, pole); D.cyl(0, 0, 0.6, 5.2, 0.08, 0.06, 6, C.METAL, pole);
    if (st === 'canyon') { D.box(0, 5.1, 0.9, 0.1, 0.1, 1.8, C.METAL, pole); D.box(0, 4.95, 1.8, 0.35, 0.18, 0.7, C.METAL, pole); ch.L.push([x, y + 4.88, z, yaw, 1.8]); }
    else if (st === 'islands') { D.box(0, 5.15, 0, 0.12, 0.12, 0.12, C.METAL, pole); ch.L.push([x, y + 5.5, z, yaw, 0]); }
    else { D.box(0, 5.0, 0.35, 0.06, 0.06, 0.7, C.METAL, pole); D.cyl(0, 0.7, 4.5, 4.55, 0.22, 0.22, 6, C.METAL, pole); D.cyl(0, 0.7, 4.85, 5.1, 0.25, 0.08, 6, C.METAL, pole); ch.L.push([x, y + 4.7, z, yaw, 0.7]); }
  }
  // fences / hedges / dry-stone walls around fields (detail layer)
  buildFences() {
    const W = this.w, r = this.r, st = W.loc.id;
    for (const f of W.net.fields) {
      if (f.pivot) continue;
      const kind = st === 'islands' ? (r() < 0.6 ? 'hedge' : 'wall') : st === 'alpine' ? (r() < 0.6 ? 'rail' : 'hedge') : 'post';
      if (this.dens < 0.6 && (kind === 'rail' || kind === 'post')) continue; // low quality: hedges and walls only
      const ca = Math.cos(f.ang), sa = Math.sin(f.ang), toW = (u, v) => [f.x + u * ca - v * sa, f.z + u * sa + v * ca];
      const ch = this.chunkOf('c' + Math.floor(f.x / 2000) + ',' + Math.floor(f.z / 2000)); if (!ch.n) { ch.x = f.x; ch.z = f.z; ch.n = 1; }
      const B = kind === 'hedge' || kind === 'wall' ? ch.S : ch.D; B.setFrame(0, 0, 0, 0); B.seed = 0;
      const sx = f.sx + 1.5, sz = f.sz + 1.5, corners = [[-sx, -sz], [sx, -sz], [sx, sz], [-sx, sz]], gate = Math.floor(r() * 4);
      const hedgeCol = [0x6f8f50, 0x5f8048, 0x7a9658][Math.floor(r() * 3)];
      for (let e = 0; e < 4; e++) {
        const [u0, v0] = corners[e], [u1, v1] = corners[(e + 1) % 4], L = Math.hypot(u1 - u0, v1 - v0), seg = kind === 'hedge' || kind === 'wall' ? 12 : 10, n = Math.max(1, Math.round(L / seg));
        for (let k = 0; k < n; k++) {
          if (e === gate && k === Math.floor(n / 2)) continue;
          const [ax, az] = toW(u0 + (u1 - u0) * k / n, v0 + (v1 - v0) * k / n), [bx, bz] = toW(u0 + (u1 - u0) * (k + 1) / n, v0 + (v1 - v0) * (k + 1) / n);
          const ya = W.sampleGrid(ax, az), yb = W.sampleGrid(bx, bz);
          if (ya < W.waterLevel + 0.5 || yb < W.waterLevel + 0.5 || W.nearRoad((ax + bx) / 2, (az + bz) / 2, 3) || Math.abs(ya - yb) > 4) continue;
          const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), nx = dz / l, nz = -dx / l; // outward-ish normal
          const strip = (h0, h1, th, cell, col, top) => { // a thin wall from ground+h0 to ground+h1, two-sided, thickness th
            for (const s of [1, -1]) { const ox = nx * th / 2 * s, oz = nz * th / 2 * s; const P = s < 0 ? [[ax + ox, ya + h0, az + oz], [bx + ox, yb + h0, bz + oz], [bx + ox, yb + h1, bz + oz], [ax + ox, ya + h1, az + oz]] : [[bx + ox, yb + h0, bz + oz], [ax + ox, ya + h0, az + oz], [ax + ox, ya + h1, az + oz], [bx + ox, yb + h1, bz + oz]]; B.plainQuad(P[0], P[1], P[2], P[3], cell, col); }
            if (top) B.plainQuad([ax - nx * th / 2, ya + h1, az - nz * th / 2], [bx - nx * th / 2, yb + h1, bz - nz * th / 2], [bx + nx * th / 2, yb + h1, bz + nz * th / 2], [ax + nx * th / 2, ya + h1, az + nz * th / 2], cell, col);
          };
          if (kind === 'hedge') strip(-0.3, 1.6 + r() * 0.8, 1.4, C.HEDGE, hedgeCol, true);
          else if (kind === 'wall') strip(-0.3, 1.0, 0.7, C.STONE, 0xffffff, true);
          else {
            if (kind === 'rail') { strip(0.45, 0.62, 0.08, C.DARKWOOD, 0xd8c8b0, false); strip(0.95, 1.12, 0.08, C.DARKWOOD, 0xd8c8b0, false); }
            else strip(1.0, 1.04, 0.03, C.METAL, 0x555555, false);
            B.box(ax, ya - 0.3, az, 0.2, 1.6, 0.2, C.DARKWOOD, 0xc0a888, { top: false });
          }
        }
      }
    }
  }
  buildMeshes() {
    const W = this.w, T = this.T;
    const mat = (this.mat = buildingMaterial({ cellPx: T.cell, interiors: T.interiors }));
    const gmat = (this.gmat = buildingMaterial({ cellPx: T.cell, interiors: false, ground: true }));
    W.windowMats.push(mat);
    this.chunkList = [];
    let tris = 0; const lt = (this.layerTris = { S: 0, D: 0, G: 0 });
    const lampHeads = [], glowPos = [];
    const castDetail = W.qName === 'high' || W.qName === 'ultra';
    for (const [key, ch] of this.chunks) {
      const c = { key, x: ch.n ? ch.x / ch.n : 0, z: ch.n ? ch.z / ch.n : 0 };
      if (!ch.S.empty) { const g = ch.S.toGeometry(); tris += g.index.count / 3; lt.S += g.index.count / 3; c.shell = new THREE.Mesh(g, mat); c.shell.castShadow = W.q.shadows && W.qName !== 'medium'; c.shell.receiveShadow = true; this.group.add(c.shell); }
      if (!ch.D.empty) { const g = ch.D.toGeometry(); tris += g.index.count / 3; lt.D += g.index.count / 3; c.detail = new THREE.Mesh(g, mat); c.detail.receiveShadow = true; c.detail.castShadow = castDetail; this.group.add(c.detail); const bs = g.boundingSphere; c.dx = bs.center.x; c.dz = bs.center.z; c.dr = bs.radius; }
      if (!ch.G.empty) { const g = ch.G.toGeometry(); tris += g.index.count / 3; lt.G += g.index.count / 3; c.ground = new THREE.Mesh(g, gmat); c.ground.receiveShadow = true; c.ground.renderOrder = -1; this.group.add(c.ground); const bs = g.boundingSphere; c.gx = bs.center.x; c.gz = bs.center.z; c.gr = bs.radius; }
      for (const l of ch.L) { lampHeads.push(l); glowPos.push(l[0] + Math.sin(l[3]) * l[4], l[1], l[2] + Math.cos(l[3]) * l[4]); }
      this.chunkList.push(c);
    }
    this.tris = tris; this.chunks = null; this.foot = null;
    // street lamp heads (glowing at night) + light pools on the ground
    if (lampHeads.length) {
      const st = W.loc.id;
      const head = st === 'islands' ? new THREE.SphereGeometry(0.28, 10, 8) : st === 'canyon' ? new THREE.BoxGeometry(0.3, 0.06, 0.6) : new THREE.CylinderGeometry(0.2, 0.16, 0.36, 6);
      this.lampMat = new THREE.MeshStandardMaterial({ color: 0xf8f0e0, emissive: 0xffd8a0, emissiveIntensity: 0, roughness: 0.3 });
      const im = new THREE.InstancedMesh(head, this.lampMat, lampHeads.length), m4 = new THREE.Matrix4();
      lampHeads.forEach((l, i) => { m4.makeTranslation(l[0] + Math.sin(l[3]) * l[4], l[1], l[2] + Math.cos(l[3]) * l[4]); im.setMatrixAt(i, m4); });
      this.group.add(im); this.lampHeads = im;
      const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
      this.glowMat = new THREE.PointsMaterial({ size: 3.2, color: new THREE.Color(3.4, 2.4, 1.3), map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      this.glow = new THREE.Points(gg, this.glowMat); this.group.add(this.glow);
      // pools of light on the ground
      const pool = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const pc = document.createElement('canvas'); pc.width = pc.height = 64; const pg = pc.getContext('2d'); const gr = pg.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); pg.fillStyle = gr; pg.fillRect(0, 0, 64, 64);
      this.poolMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(pc), color: new THREE.Color(1.0, 0.72, 0.42), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
      const pi = new THREE.InstancedMesh(pool, this.poolMat, lampHeads.length);
      lampHeads.forEach((l, i) => { const x = l[0] + Math.sin(l[3]) * l[4], z = l[2] + Math.cos(l[3]) * l[4]; m4.makeScale(19, 1, 19).setPosition(x, W.sampleGrid(x, z) + 0.45, z); pi.setMatrixAt(i, m4); });
      pi.visible = false; pi.renderOrder = 2; this.group.add(pi); this.pools = pi;
      this.lampCount = lampHeads.length;
    }
  }
  // yard / square trees: the vegetation models from flora.js when available (same materials, so they sway and
  // match the forests), otherwise a simple vertex-coloured stand-in
  buildTrees() {
    const W = this.w, list = this.yardTrees; if (!list.length) return;
    if (typeof W.flora?.addTrees === 'function') { // flora's public API: same models, impostors, collisions and sway
      const st = W.loc.id, kind = (k) => (k === 'palm' || st === 'islands' ? 'palm' : k === 'conifer' ? 'conifer' : 'broadleaf');
      W.flora.addTrees(list.map((t) => ({ x: t.x, z: t.z, kind: kind(t.kind), scale: t.kind === 'conifer' ? 0.35 + t.s * 0.5 : 0.45 + t.s * 0.6 })));
      return;
    }
    const st = W.loc.id, vars = W.flora?.vars || [];
    const find = (sps) => { for (const sp of sps) { const v = vars.filter((V) => V.sp === sp && V.model?.geo && V.near?.material); if (v.length) return v; } return []; };
    const groups = { tree: find(st === 'islands' ? ['palm', 'broadleaf'] : st === 'canyon' ? ['broadleaf', 'juniper', 'shrub', 'palm'] : ['broadleaf']), conifer: find(st === 'islands' ? ['palm'] : st === 'canyon' ? ['juniper', 'broadleaf'] : ['spruce', 'broadleaf']), palm: find(['palm', 'broadleaf']) };
    const buckets = new Map(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    let fallback = null;
    for (const t of list) {
      const g = groups[t.kind]?.length ? groups[t.kind] : groups.tree; let V = g.length ? g[Math.floor(this.r() * g.length)] : null;
      if (!V) V = fallback || (fallback = { model: { geo: simpleTree() }, near: { material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }) } });
      if (!buckets.has(V)) buckets.set(V, []);
      const y = W.sampleGrid(t.x, t.z) - 0.1, s = V === fallback ? 0.7 + t.s : (V.sp === 'spruce' ? t.s * 0.7 : V.sp === 'palm' ? 0.55 + t.s * 0.5 : 0.3 + t.s * 0.6);
      buckets.get(V).push(m4.compose(new THREE.Vector3(t.x, y, t.z), q.setFromAxisAngle(up, this.r() * 6.28), new THREE.Vector3(s, s * (0.9 + this.r() * 0.2), s)).clone());
    }
    this.treeMeshes = [];
    for (const [V, mats] of buckets) {
      const im = new THREE.InstancedMesh(V.model.geo, V.near.material, mats.length);
      mats.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, col.setRGB(0.85 + this.r() * 0.3, 0.85 + this.r() * 0.3, 0.85 + this.r() * 0.2)); });
      im.castShadow = W.q.shadows; im.receiveShadow = true; im.frustumCulled = false; this.group.add(im); this.treeMeshes.push(im);
    }
  }
  buildLandmarks() {
    const W = this.w, r = this.r;
    this.spinners = [];
    // wind turbines on open high ground
    if (W.loc.id !== 'islands') {
      const tower = mergeGeometries([vc(new THREE.CylinderGeometry(1.1, 2, 80, 12).translate(0, 40, 0), 0xf0f0f0), vc(new THREE.BoxGeometry(3, 3, 9).translate(0, 81, 1.5), 0xf0f0f0)]);
      const bladeG = mergeGeometries([0, 1, 2].map((k) => vc(new THREE.BoxGeometry(1.4, 38, 0.4).translate(0, 19, 0).rotateZ((k / 3) * Math.PI * 2), 0xf4f4f4)).concat([vc(new THREE.SphereGeometry(1.4, 10, 8), 0xf0f0f0)]));
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
      let placed = 0;
      for (let k = 0; k < 600 && placed < 12; k++) {
        const x = (r() - 0.5) * 14000, z = (r() - 0.5) * 14000, h = W.sampleGrid(x, z);
        if (Math.hypot(x - 140, z) < 2600 || h < W.loc.rwyH + 60 || h > (W.loc.desert ? 900 : 1100)) continue;
        if (W.groundAt(x, z).n.y < 0.93) continue;
        const a = r() * 6.28;
        for (let j = 0; j < 4 && placed < 12; j++) {
          const xx = x + Math.cos(a) * j * 160, zz = z + Math.sin(a) * j * 160, hh = W.sampleGrid(xx, zz);
          if (Math.abs(hh - h) > 60) continue;
          const t = new THREE.Mesh(tower, mat); t.position.set(xx, hh - 1, zz); t.rotation.y = W.windBase ? Math.atan2(W.windBase.x, W.windBase.z) : 0; t.castShadow = true; this.group.add(t);
          const rot = new THREE.Mesh(bladeG, mat); rot.position.set(0, 81, -3.6); t.add(rot); this.spinners.push({ o: rot, sp: 1 + r() * 0.4 });
          const blink = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.1) })); blink.position.set(0, 83, 3); t.add(blink); this.spinners.push({ blink });
          placed++;
        }
      }
    }
    // radio mast on a peak near the airport
    {
      let best = null; for (let k = 0; k < 200; k++) { const x = 140 + (r() - 0.5) * 7000, z = (r() - 0.5) * 7000, h = W.sampleGrid(x, z); if (!best || h > best.h) best = { x, z, h }; }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.2, 60, 6), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.6 })); mast.position.set(best.x, best.h + 29, best.z); this.group.add(mast);
      const blink = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.3, 0.2) })); blink.position.y = 31; mast.add(blink); this.spinners.push({ blink });
    }
    // lighthouse + harbour on the islands
    if (W.loc.id === 'islands') {
      let spot = null; for (let a = 0; a < 6.28 && !spot; a += 0.05) for (let d = 1300; d < 4000; d += 20) { const x = 140 + Math.cos(a) * d * 0.6, z = Math.sin(a) * d; const h = W.sampleGrid(x, z); if (h < W.waterLevel + 1) { if (d > 1600 && Math.abs(Math.sin(a)) > 0.6) spot = { x: 140 + Math.cos(a) * (d - 40) * 0.6, z: Math.sin(a) * (d - 40), a }; break; } }
      if (spot) {
        const h = Math.max(W.sampleGrid(spot.x, spot.z), W.waterLevel + 1);
        const lh = new THREE.Group(); lh.position.set(spot.x, h, spot.z);
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(2, 3, 26, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })); tower.position.y = 13; lh.add(tower);
        for (let k = 0; k < 3; k++) { const band = new THREE.Mesh(new THREE.CylinderGeometry(2.6 - k * 0.25, 2.75 - k * 0.25, 3, 16), new THREE.MeshStandardMaterial({ color: 0xc8102e })); band.position.y = 5 + k * 7; lh.add(band); }
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.6, 2.6) })); lamp.position.y = 27.5; lh.add(lamp);
        const beam = new THREE.Mesh(new THREE.ConeGeometry(14, 300, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        beam.rotation.z = Math.PI / 2; beam.position.x = 150; const piv = new THREE.Object3D(); piv.position.y = 27.5; piv.add(beam); lh.add(piv);
        lh.traverse((o) => { if (o.isMesh && o !== beam) o.castShadow = true; });
        this.group.add(lh); this.lighthouse = { piv, beam, lamp };
        // harbour pier with moored boats
        const pier = new THREE.Group(); const plank = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 });
        const dir = new THREE.Vector3(Math.cos(spot.a) * 0.6, 0, Math.sin(spot.a)).normalize();
        const base = new THREE.Vector3(spot.x, W.waterLevel, spot.z).addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), 120);
        for (let k = 0; k < 14; k++) { const p = base.clone().addScaledVector(dir, k * 8 - 10); const deck = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 8.2), plank); deck.position.set(p.x, W.waterLevel + 1.6, p.z); deck.rotation.y = Math.atan2(dir.x, dir.z); pier.add(deck); for (const s of [-1.8, 1.8]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5), plank); post.position.set(p.x - dir.z * s, W.waterLevel - 0.5, p.z + dir.x * s); pier.add(post); } }
        this.group.add(pier);
        this.moored = [];
        for (let k = 0; k < 6; k++) { const p = base.clone().addScaledVector(dir, 15 + k * 14).addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), (k % 2 ? 1 : -1) * 6); this.moored.push(p); }
      }
    }
  }
  buildAnimals() {
    const W = this.w, r = this.r;
    const sheep = W.loc.id === 'alpine', g = [];
    if (sheep) { g.push(vc(new THREE.IcosahedronGeometry(0.6, 1).scale(1, 0.75, 1.3).translate(0, 0.85, 0), 0xf2efe6)); g.push(vc(new THREE.BoxGeometry(0.3, 0.32, 0.4).translate(0, 1.0, -0.85), 0x2a2622)); }
    else { g.push(vc(new THREE.BoxGeometry(0.9, 0.9, 2.0).translate(0, 1.2, 0), 0xffffff)); g.push(vc(new THREE.BoxGeometry(0.5, 0.55, 0.7).translate(0, 1.5, -1.25), 0xffffff)); }
    for (const [x, z] of [[-0.3, -0.6], [0.3, -0.6], [-0.3, 0.6], [0.3, 0.6]]) g.push(vc(new THREE.CylinderGeometry(0.08, 0.08, sheep ? 0.6 : 0.8, 5).translate(x * (sheep ? 1 : 1.2), sheep ? 0.3 : 0.4, z * (sheep ? 1 : 1.3)), 0x2a2622));
    const geo = mergeGeometries(g);
    this.animals = [];
    for (const f of W.net.fields) {
      if (!f.farm || f.pivot) continue;
      const n = 6 + Math.floor(r() * 10);
      for (let k = 0; k < n; k++) this.animals.push({ x: f.x + (r() - 0.5) * f.sx, z: f.z + (r() - 0.5) * f.sz, yaw: r() * 6.28, f, t: r() * 10, walk: 0 });
    }
    if (!this.animals.length) return;
    this.herd = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), this.animals.length);
    const col = new THREE.Color();
    this.animals.forEach((a, i) => this.herd.setColorAt(i, sheep ? col.set(0xffffff) : col.set([0x5a3a28, 0x2a2622, 0xf0ece4, 0x8a5a3a][i % 4])));
    this.herd.castShadow = true; this.herd.frustumCulled = false; this.group.add(this.herd);
  }
  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) { const dx = p.x - t[0], dz = p.z - t[2]; if (dx * dx + dz * dz < t[4] * t[4] && p.y < t[1] + t[3] && p.y > t[1] - 2) return t; }
    return null;
  }
  update(dt, t, fx, cam) {
    const W = this.w, night = W.night || (W.W?.dark ?? 0) > 0.55;
    BLD_U.uDay.value = Math.max(0.05, Math.min(1, ((W.sunElev ?? 0.5) + 0.05) * 3)) * (1 - 0.5 * (W.W?.dark ?? 0));
    if (cam) for (const c of this.chunkList) {
      if (c.detail) c.detail.visible = Math.hypot(c.dx - cam.x, c.dz - cam.z) < this.detailDist + c.dr;
      if (c.ground) c.ground.visible = Math.hypot(c.gx - cam.x, c.gz - cam.z) < this.T.ground + c.gr;
    }
    if (this.lampMat) { this.lampMat.emissiveIntensity = night ? 6 : 0; this.glowMat.opacity = night ? 1 : 0; this.poolMat.opacity = night ? 0.6 : 0; this.pools.visible = night; }
    for (const s of this.spinners || []) { if (s.o) s.o.rotation.z += dt * s.sp * (0.6 + W.W.wind * 0.08); if (s.blink) s.blink.visible = Math.floor(t * 1.1) % 2 === 0; }
    if (this.lighthouse) { this.lighthouse.piv.rotation.y += dt * 0.6; this.lighthouse.beam.material.opacity = night ? 0.08 : 0; this.lighthouse.lamp.visible = true; }
    if (fx && cam) for (const c of this.chimneys) if (Math.random() < dt * 1.5 && c.distanceToSquared(cam) < 2500 * 2500) fx.smoke.add(c.x, c.y, c.z, W.windBase.x * 0.3 + (Math.random() - 0.5), 1.2, W.windBase.z * 0.3 + (Math.random() - 0.5), 9, 0.8, 7, 0.75, 0.75, 0.78, 0.35, 0.2, -0.15);
    if (this.herd) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      this.animals.forEach((a, i) => {
        a.t -= dt;
        if (a.t < 0) { a.walk = Math.random() < 0.3 ? 0.6 : 0; a.yaw += (Math.random() - 0.5) * 1.5; a.t = 3 + Math.random() * 8; }
        if (a.walk) { a.x -= Math.sin(a.yaw) * a.walk * dt; a.z -= Math.cos(a.yaw) * a.walk * dt; if (Math.abs(a.x - a.f.x) > a.f.sx * 0.8 || Math.abs(a.z - a.f.z) > a.f.sz * 0.8) a.yaw += Math.PI; }
        q.setFromAxisAngle(up, a.yaw); m.compose(new THREE.Vector3(a.x, W.sampleGrid(a.x, a.z) - 0.05, a.z), q, one); this.herd.setMatrixAt(i, m);
      });
      this.herd.instanceMatrix.needsUpdate = true;
    }
  }
}

// stand-in yard tree (if flora.js offers no models): trunk + a few leafy blobs
function simpleTree() {
  const g = [vc(new THREE.CylinderGeometry(0.12, 0.2, 3, 6).translate(0, 1.5, 0), 0x5a4030)];
  for (const [x, y, z, s] of [[0, 4, 0, 2], [0.9, 3.4, 0.3, 1.4], [-0.8, 3.6, -0.4, 1.5], [0.2, 5.0, -0.2, 1.3]]) g.push(vc(new THREE.IcosahedronGeometry(s, 1).translate(x, y, z), 0x4a6a2a));
  return mergeGeometries(g);
}

// separating-axis test for two oriented rectangles {x,z,hw,hd,ax,az,bx,bz}
function obbHit(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ux, uz] of [[a.ax, a.az], [a.bx, a.bz], [b.ax, b.az], [b.bx, b.bz]]) {
    const ra = a.hw * Math.abs(a.ax * ux + a.az * uz) + a.hd * Math.abs(a.bx * ux + a.bz * uz);
    const rb = b.hw * Math.abs(b.ax * ux + b.az * uz) + b.hd * Math.abs(b.bx * ux + b.bz * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}
