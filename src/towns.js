// Towns, villages, farms, field fences, landmarks and animals.
// Buildings come from the kit in buildings.js and are merged into one mesh per chunk
// (a town, or a 2 km cell of countryside): shell (walls + roofs) always drawn, detail
// (balconies, chimneys, porches, fences) only near the camera.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { Builder, buildingMaterial, makeBuilding, C } from './buildings.js';

function vc(g, hex, mult = 1) {
  const geo = g.index ? g.toNonIndexed() : g; const c = new THREE.Color(hex).multiplyScalar(mult), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); return geo;
}
const DENSITY = { low: 0.5, medium: 0.8, high: 1 };
const DETAIL_DIST = { low: 900, medium: 1500, high: 2400 };

export class Towns {
  constructor(world) {
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const r = (this.r = mulberry32(world.loc.seed * 5 + 3)), W = world, st = W.loc.id;
    this.dens = DENSITY[W.qName] ?? 0.8; this.detailDist = DETAIL_DIST[W.qName] ?? 1500;
    this.grid = new Map(); this.chimneys = []; this.chunks = new Map(); this.foot = new Map(); this.count = 0;
    const t0 = performance.now();
    // ---- placement with footprint (oriented box) overlap tests ----
    const fkey = (x, z) => Math.floor(x / 40) + ',' + Math.floor(z / 40);
    const overlaps = (o) => {
      const R = Math.ceil((o.rad + 20) / 40), cx = Math.floor(o.x / 40), cz = Math.floor(o.z / 40);
      for (let i = cx - R; i <= cx + R; i++) for (let j = cz - R; j <= cz + R; j++) {
        const arr = this.foot.get(i + ',' + j); if (!arr) continue;
        for (const p of arr) if ((p.x - o.x) ** 2 + (p.z - o.z) ** 2 < (p.rad + o.rad) ** 2 && obbHit(p, o)) return true;
      }
      return false;
    };
    const addFoot = (o) => { const R = Math.ceil(o.rad / 40), cx = Math.floor(o.x / 40), cz = Math.floor(o.z / 40); for (let i = cx - R; i <= cx + R; i++) for (let j = cz - R; j <= cz + R; j++) { const k = i + ',' + j; if (!this.foot.has(k)) this.foot.set(k, []); this.foot.get(k).push(o); } };
    const chunkOf = (key) => { if (!this.chunks.has(key)) this.chunks.set(key, { S: new Builder(), D: new Builder(), x: 0, z: 0, n: 0 }); return this.chunks.get(key); };
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
      addFoot(o);
      const ch = chunkOf(opts.chunk ?? 'c' + Math.floor(x / 2000) + ',' + Math.floor(z / 2000)), y = mn + 0.05;
      ch.x += x; ch.z += z; ch.n++;
      ch.S.seed = ch.D.seed = Math.floor(r() * 255);
      ch.S.setFrame(x, y, z, yaw); ch.D.setFrame(x, y, z, yaw); b.draw(ch.S, ch.D);
      const key = Math.floor(x / 50) + ',' + Math.floor(z / 50); if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push([x, y, z, b.h, Math.min(b.w, b.d) * 0.5 + 0.5]);
      if (b.chimney && st === 'alpine' && this.chimneys.length < 70 && r() < 0.35) { const [lx, ly, lz] = b.chimney; this.chimneys.push(new THREE.Vector3(x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs)); }
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
    const lineRoad = (pts, width, s0, s1, chunk, pickType, back) => {
      const wk = walker(pts); s1 = Math.min(s1, wk.total);
      for (const side of [-1, 1]) {
        let s = s0 + r() * 6;
        while (s < s1 - 4) {
          const type = pickType(wk.at(s)), b = mk(type), center = type === 'center';
          const p = wk.at(s + b.w / 2), nx = -p.dz * side, nz = p.dx * side;
          const off = width / 2 + (center ? 3 : 4.5 + r() * 4) + b.d / 2, x = p.x + nx * off, z = p.z + nz * off, yaw = Math.atan2(-nx, -nz);
          const ok = place(b, x, z, yaw, { chunk, pad: center ? 0.3 : 1.2 });
          s += ok ? b.w + (center ? 0.8 + r() * 2 : 3 + r() * 7) : 5;
          if (ok && back && r() < back) { const b2 = mk('house'), off2 = off + b.d / 2 + 7 + r() * 5 + b2.d / 2; place(b2, p.x + nx * off2, p.z + nz * off2, yaw + (r() < 0.25 ? Math.PI : 0), { chunk }); }
        }
      }
    };
    // ---- towns ----
    W.net.towns.forEach((t, ti) => {
      const chunk = 'town' + ti, side = new THREE.Vector3(-t.dir.z, 0, t.dir.x), facing = Math.atan2(t.dir.x, t.dir.z);
      const typeAt = (p) => (Math.hypot(p.x - t.c.x, p.z - t.c.z) < 150 * t.size + 30 ? 'center' : 'house');
      // landmarks first so they get good spots
      for (let k = 0; k < 12; k++) if (place(mk('church'), t.c.x + side.x * (34 + k * 6) + t.dir.x * (k - 4) * 9, t.c.z + side.z * (34 + k * 6) + t.dir.z * (k - 4) * 9, facing - Math.PI / 2, { chunk })) break;
      if (st === 'canyon') {
        for (let k = 0; k < 10; k++) if (place(mk('waterTower'), t.c.x - side.x * (50 + k * 10) - t.dir.x * 60, t.c.z - side.z * (50 + k * 10) - t.dir.z * 60, 0, { chunk })) break;
        const e = t.c.clone().addScaledVector(t.dir, 520 * t.size * 0.4 + 30);
        for (let k = 0; k < 10; k++) if (place(mk('gasStation'), e.x + side.x * (24 + k * 6) + t.dir.x * k * 10, e.z + side.z * (24 + k * 6) + t.dir.z * k * 10, facing - Math.PI / 2, { chunk })) break;
      }
      for (const rd of W.net.roads) {
        const near = Math.hypot(rd.pts[0].x - t.c.x, rd.pts[0].z - t.c.z);
        if (rd.kind === 'street' && near < 700) lineRoad(rd.pts, rd.width, 0, 1e9, chunk, typeAt, 0.8 * this.dens);
        else if (rd.kind === 'main' && !rd.closed && near < 5) lineRoad(rd.pts, rd.width, 260 * t.size, 260 * t.size + 260 * this.dens, chunk, () => 'house', 0.3 * this.dens);
      }
      // infill between the streets
      for (let k = 0; k < 140 * t.size * this.dens; k++) {
        const a = r() * 6.28, d = 40 + Math.sqrt(r()) * 340 * t.size, x = t.c.x + Math.cos(a) * d, z = t.c.z + Math.sin(a) * d;
        place(mk(d < 120 * t.size ? 'center' : 'house'), x, z, facing + Math.round(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.15, { chunk });
      }
      // a farm or two on the edge of town
      for (let k = 0; k < 6 * t.size; k++) { const a = r() * 6.28, d = 380 * t.size + r() * 120, x = t.c.x + Math.cos(a) * d, z = t.c.z + Math.sin(a) * d; if (place(mk('barn'), x, z, a, { chunk })) place(mk('silo'), x + Math.cos(a + 1.3) * 16, z + Math.sin(a + 1.3) * 16, 0, { chunk }); }
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
    this.buildTime = performance.now() - t0;
    this.buildLandmarks();
    this.buildAnimals();
  }
  // fences / hedges / dry-stone walls around fields (detail layer)
  buildFences() {
    const W = this.w, r = this.r, st = W.loc.id;
    for (const f of W.net.fields) {
      if (f.pivot) continue;
      const kind = st === 'islands' ? (r() < 0.6 ? 'hedge' : 'wall') : st === 'alpine' ? (r() < 0.6 ? 'rail' : 'hedge') : 'post';
      if (this.dens < 0.6 && (kind === 'rail' || kind === 'post')) continue; // low quality: hedges and walls only
      const ca = Math.cos(f.ang), sa = Math.sin(f.ang), toW = (u, v) => [f.x + u * ca - v * sa, f.z + u * sa + v * ca];
      const ch = this.chunks.get('c' + Math.floor(f.x / 2000) + ',' + Math.floor(f.z / 2000)) || (this.chunks.set('c' + Math.floor(f.x / 2000) + ',' + Math.floor(f.z / 2000), { S: new Builder(), D: new Builder(), x: f.x, z: f.z, n: 1 }), this.chunks.get('c' + Math.floor(f.x / 2000) + ',' + Math.floor(f.z / 2000)));
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
    const W = this.w, mat = (this.mat = buildingMaterial());
    W.windowMats.push(mat);
    this.chunkList = [];
    let tris = 0;
    for (const [key, ch] of this.chunks) {
      const c = { key, x: ch.n ? ch.x / ch.n : 0, z: ch.n ? ch.z / ch.n : 0 };
      if (!ch.S.empty) { const g = ch.S.toGeometry(); tris += g.index.count / 3; c.shell = new THREE.Mesh(g, mat); c.shell.castShadow = W.qName === 'high'; c.shell.receiveShadow = true; this.group.add(c.shell); }
      if (!ch.D.empty) { const g = ch.D.toGeometry(); tris += g.index.count / 3; c.detail = new THREE.Mesh(g, mat); c.detail.receiveShadow = true; this.group.add(c.detail); const bs = g.boundingSphere; c.dx = bs.center.x; c.dz = bs.center.z; c.dr = bs.radius; }
      this.chunkList.push(c);
    }
    this.tris = tris; this.chunks = null; this.foot = null;
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
        // a short row of turbines
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
    const W = this.w, night = W.night || W.W.dark > 0.55;
    if (cam) { for (const c of this.chunkList) if (c.detail) c.detail.visible = Math.hypot(c.dx - cam.x, c.dz - cam.z) < this.detailDist + c.dr; }
    for (const s of this.spinners) { if (s.o) s.o.rotation.z += dt * s.sp * (0.6 + W.W.wind * 0.08); if (s.blink) s.blink.visible = Math.floor(t * 1.1) % 2 === 0; }
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
