// Scenery for real-world locations from OpenStreetMap (© OpenStreetMap contributors, ODbL), baked by
// tools/realworld/bake.py: every mapped building extruded from its real footprint (walls from the facade atlas in
// buildings.js, gabled / hipped / flat roofs, Swiss chalet style up in the villages), railways, cable car lines and
// mountain lakes. Takes the place of Towns (towns.js) for these locations and offers the same interface.
import * as THREE from 'three';
import { Builder, buildingMaterial, C } from './buildings.js';
import { mulberry32, smoothstep } from './noise.js';

const CHUNK = 1000; // m: buildings are merged per 1 km cell (one draw call each), hidden beyond VIEW
const VIEW = { low: 4500, medium: 8000, high: 14000 };
// kind codes from the bake: 0 house, 1 apartments, 2 farm / barn / shed, 3 church, 4 industrial / commercial, 5 hotel, 6 public
const WALLS = { plaster: [0xf2ece0, 0xe8dcc4, 0xefe2c8, 0xdcd0b8, 0xe6dccc, 0xd8d4c8, 0xf0e8d8], wood: [0xffffff, 0xf0e0c8, 0xd8b898, 0xc8a080] }; // tints over the photo atlas (buildings.js)
const ROOFS = { tile: [0x7a5444, 0x6e4a3c, 0x845a48, 0x664436, 0x8a6250], grey: [0x6a6c70, 0x5a5c62, 0x7a7266, 0x666058], shingle: [0x8a8070, 0x7a7266, 0x6e665a, 0x948a78] };

export class RealScenery {
  constructor(world) {
    const W = (this.w = world), D = world.real;
    this.group = new THREE.Group(); world.group.add(this.group);
    this.grid = new Map(); this.chunks = new Map(); this.count = 0;
    this.view = VIEW[W.qName] ?? 8000;
    world.flora?.setForestMask?.((x, z) => D.forest(x, z)); // mapped forests (OSM) instead of noise
    const t0 = performance.now();
    this.buildBuildings(D.osm.buildings);
    this.buildRails(D.osm.rails);
    this.buildCables(D.osm.cables);
    this.buildLakes(D.osm.lakes || []);
    this.ms = performance.now() - t0;
  }

  // ---------------- buildings ----------------
  buildBuildings(list) {
    const W = this.w, r = mulberry32(W.loc.seed * 5 + 3), lowQ = W.qName === 'low';
    for (const b of list) {
      const [kind, hTag, lv, rsTag, rhTag, minH, flat] = b;
      const n = flat.length / 2; if (n < 3) continue;
      const P = []; let cx = 0, cz = 0;
      for (let k = 0; k < n; k++) { P.push([flat[k * 2], flat[k * 2 + 1]]); cx += flat[k * 2]; cz += flat[k * 2 + 1]; }
      cx /= n; cz /= n;
      let area = 0; for (let k = 0; k < n; k++) { const a = P[k], c = P[(k + 1) % n]; area += a[0] * c[1] - c[0] * a[1]; }
      area *= 0.5; const A = Math.abs(area);
      if (A < (lowQ ? 60 : W.qName === 'medium' ? 25 : 0)) continue; // lighter on tablets: no garden sheds
      if (Math.abs(cx - 100) < 480 && Math.abs(cz) < 1250) continue; // the game's own airport
      // oriented bounding box: the edge direction giving the smallest rectangle
      let best = null;
      for (let k = 0; k < n; k++) {
        const a = P[k], c = P[(k + 1) % n], ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez); if (L < 0.5) continue;
        const ux = ex / L, uz = ez / L;
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const p of P) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        const ar = (u1 - u0) * (v1 - v0);
        if (!best || ar < best.ar) best = { ar, ux, uz, u0, u1, v0, v1 };
      }
      if (!best) continue;
      // long axis u, half sizes hl >= hw, centre
      let { ux, uz } = best, hl = (best.u1 - best.u0) / 2, hw = (best.v1 - best.v0) / 2;
      const um = (best.u0 + best.u1) / 2, vm = (best.v0 + best.v1) / 2;
      const ox = um * ux - vm * uz, oz = um * uz + vm * ux;
      if (hw > hl) { [hl, hw] = [hw, hl]; [ux, uz] = [-uz, ux]; }
      const rect = A / Math.max(1, best.ar);
      // ground under it: walls start just below the lowest corner
      let g0 = Infinity, g1 = -Infinity;
      for (const p of P) { const h = W.sampleGrid(p[0], p[1]); g0 = Math.min(g0, h); g1 = Math.max(g1, h); }
      if (g0 < W.waterLevel - 2) continue;
      const base = g0 - 0.6;
      // heights: tagged, from levels, or by kind and size
      const big = A > 450, small = A < 35;
      let roof = rsTag;
      if (roof < 0) roof = kind === 4 || kind === 6 ? (A > 350 ? 0 : 1) : kind === 1 && big ? 0 : rect > 0.78 ? 1 : rect > 0.55 && A < 900 ? 2 : 0;
      if (roof === 4) roof = 1;
      if (roof === 1 && hw > 16) roof = 0; // no giant gables on huge halls
      const pitch = kind === 3 ? 1.1 : kind === 2 ? 0.5 : 0.58;
      let rise = roof === 0 ? 0 : rhTag > 0 ? rhTag : Math.min(hw * pitch, 9);
      let walls;
      if (hTag > 0) walls = Math.max(2.5, hTag - minH - rise);
      else if (lv > 0) walls = lv * 2.9 + 0.5;
      else walls = small ? 2.6 : kind === 0 ? (A > 160 ? 8.6 : 5.9) : kind === 1 ? 11.5 : kind === 2 ? 4.8 : kind === 3 ? 10 : kind === 4 ? 7.5 : kind === 5 ? 12.5 : 9.5;
      if (hTag > 0 && hTag - minH < walls + rise) rise = Math.max(0, hTag - minH - walls);
      const eave = (g0 + g1) / 2 + minH + walls - base;
      // style: Swiss chalets (dark timber) up in the villages, plaster in the valley towns
      const hAbs = (g0 + g1) / 2, chalet = (kind === 0 || kind === 5 || kind === 2) && r() < (kind === 2 ? 0.75 : smoothstep(600, 1100, hAbs) * 0.6 + 0.12);
      let wallCell, wallCol;
      if (kind === 2) { wallCell = chalet ? C.WOOD : C.BOARDS; wallCol = chalet ? WALLS.wood[(r() * 4) | 0] : 0xd8c8b0; }
      else if (chalet) { wallCell = C.WOOD_WIN; wallCol = WALLS.wood[(r() * 4) | 0]; }
      else if (kind === 1) { wallCell = r() < 0.5 ? C.APT : C.BALCONY; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
      else if (kind === 3) { wallCell = C.CHURCH_WIN; wallCol = 0xf2eee6; }
      else if (kind === 4) { wallCell = A > 600 ? C.METAL : C.CONCRETE; wallCol = A > 600 ? 0xc8ccd0 : 0xe0ddd6; }
      else if (kind === 5) { wallCell = C.BALCONY; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
      else if (kind === 6) { wallCell = C.WIN; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
      else { wallCell = small ? C.PLAIN : [C.WIN_GREEN, C.WIN, C.WIN_BLUE][(r() * 3) | 0]; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
      // roofs: the usual Swiss mix (red-brown tiles in the valley towns, dark shingles or grey slate on chalets);
      // the satellite can't help, its 10 m pixels blur roofs into gardens (and the bake clears them from the photo)
      const u = r();
      const style = kind === 4 ? 'grey' : chalet ? (u < 0.55 ? 'shingle' : u < 0.85 ? 'grey' : 'tile') : (u < 0.68 ? 'tile' : 'grey');
      const pal = ROOFS[style], roofCol = pal[(r() * pal.length) | 0];
      // (the clay photo tile is bright: half the tiled roofs get the weathered dark tile)
      const roofCell = style === 'tile' ? (r() < 0.5 ? C.TILES : C.DARKTILE ?? C.TILES) : style === 'shingle' ? C.SHINGLE : kind === 4 ? C.SEAM : C.SLATE;
      // ---- geometry
      const ch = this.chunk(cx, cz), B = ch.B;
      B.seed = (r() * 255) | 0;
      B.setFrame(0, base, 0, 0);
      const ccw = area > 0; // walls need the outside on their front: walk the ring so the face normal points out
      for (let k = 0; k < n; k++) {
        const a = P[k], c = P[(k + 1) % n];
        if (ccw) B.wall(c[0], c[1], a[0], a[1], 0, eave, wallCell, wallCol); else B.wall(a[0], a[1], c[0], c[1], 0, eave, wallCell, wallCol);
      }
      const cxo = ox, czo = oz, yaw = Math.atan2(ux, uz);
      if (roof === 1 || roof === 2 || roof === 3) {
        B.setFrame(cxo, base, czo, yaw);
        const over = kind === 4 ? 0.3 : chalet ? 1.1 : 0.6;
        if (roof === 1) B.gable(hw * 2, hl * 2, eave, rise, over, roofCell, roofCol, wallCell === C.WOOD_WIN ? C.WOOD : C.PLAIN, wallCol, { under: chalet });
        else B.hip(hw * 2, hl * 2, eave, rise, over, roofCell, roofCol);
      } else this.flatRoof(B, P, eave, kind === 4 ? C.GRAVEL : C.CONCRETE, kind === 4 ? 0xa8a49c : 0x9a958c);
      ch.n++; ch.x += cx; ch.z += cz;
      // collisions: a disc per building (the aircraft's parts are tested against these)
      const key = Math.floor(cx / 50) + ',' + Math.floor(cz / 50);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push([cx, base, cz, eave + rise, Math.sqrt(A / Math.PI)]);
      this.count++;
    }
    const mat = (this.mat = buildingMaterial({ cellPx: { low: 128, medium: 192, ultra: 384 }[W.qName] ?? 256, interiors: W.qName !== 'low' })); // the towns' atlas
    W.windowMats = W.windowMats || []; W.windowMats.push(mat);
    this.chunkList = [];
    for (const ch of this.chunks.values()) {
      if (ch.B.empty) continue;
      const g = ch.B.toGeometry(), m = new THREE.Mesh(g, mat);
      m.castShadow = W.qBase === 'high'; m.receiveShadow = true;
      this.group.add(m);
      this.chunkList.push({ m, x: ch.x / ch.n, z: ch.z / ch.n, r: g.boundingSphere.radius });
    }
    this.chunks = null;
  }
  chunk(x, z) {
    const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
    let c = this.chunks.get(k); if (!c) this.chunks.set(k, (c = { B: new Builder(), n: 0, x: 0, z: 0 }));
    return c;
  }
  flatRoof(B, P, y, cell, colr) {
    const contour = P.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [a, b, c] of tris) {
      const pa = P[a], pb = P[b], pc = P[c];
      // face up: (b - a) x (c - a) must have +y
      const up = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]) > 0;
      const q = up ? [pa, pb, pc] : [pa, pc, pb];
      B.tri([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], [q[0][0] / 3, q[0][1] / 3, q[1][0] / 3, q[1][1] / 3, q[2][0] / 3, q[2][1] / 3], cell, colr);
    }
  }

  // ---------------- railways: ballast + rails draped on the ground, bridges straight ----------------
  buildRails(list) {
    const W = this.w, pos = [], idx = [], steel = [], sIdx = [];
    const ribbon = (pts, br, width, lift, out, oi) => {
      const ys = pts.map((p) => W.sampleGrid(p[0], p[1]));
      if (br) { const a = ys[0], b = ys.at(-1); ys.forEach((_, i) => (ys[i] = a + (b - a) * (i / (ys.length - 1)) + 1)); }
      const o = out.length / 3;
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
        const nx = -dz / L * width / 2, nz = dx / L * width / 2;
        out.push(p[0] - nx, ys[i] + lift, p[1] - nz, p[0] + nx, ys[i] + lift, p[1] + nz);
        if (i) { const k = o + (i - 1) * 2; oi.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      });
    };
    for (const [kind, br, flat] of list) {
      const raw = []; for (let k = 0; k < flat.length; k += 2) raw.push([flat[k], flat[k + 1]]);
      const pts = densify(raw, 6);
      if (pts.length < 2) continue;
      ribbon(pts, br, 3.6, 0.25, pos, idx);
      for (const s of [-0.55, 0.55]) ribbon(offset(pts, s), br, 0.14, 0.45, steel, sIdx);
    }
    const mk = (p, i, m) => { if (!p.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(i); g.computeVertexNormals(); const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; this.group.add(mesh); };
    mk(pos, idx, new THREE.MeshStandardMaterial({ color: 0x4e463e, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
    mk(steel, sIdx, new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 0.8, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 }));
  }

  // ---------------- cable cars / gondolas / chair lifts: sagging cables between the stations ----------------
  buildCables(list) {
    const W = this.w, pts = [];
    for (const [kind, flat] of list) {
      for (let k = 0; k + 3 < flat.length; k += 2) {
        const ax = flat[k], az = flat[k + 1], bx = flat[k + 2], bz = flat[k + 3], L = Math.hypot(bx - ax, bz - az); if (L < 5) continue;
        const ha = W.sampleGrid(ax, az) + 12, hb = W.sampleGrid(bx, bz) + 12, segs = Math.max(4, Math.ceil(L / 40));
        for (const side of kind === 2 ? [0] : [-3, 3]) {
          const nx = -(bz - az) / L * side, nz = (bx - ax) / L * side;
          let prev = null;
          for (let s = 0; s <= segs; s++) {
            const t = s / segs, x = ax + (bx - ax) * t + nx, z = az + (bz - az) * t + nz;
            let y = ha + (hb - ha) * t - Math.sin(t * Math.PI) * L * 0.035; // the sag
            y = Math.max(y, W.sampleGrid(x, z) + 3);
            if (prev) pts.push(...prev, x, y, z);
            prev = [x, y, z];
          }
        }
      }
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.8 })));
  }

  // ---------------- mountain lakes: flat water at their own level (the valley lakes are the World's water) ----------------
  buildLakes(list) {
    const pos = [], idx = [];
    for (const [lvl, flat] of list) {
      const P = []; for (let k = 0; k < flat.length; k += 2) P.push(new THREE.Vector2(flat[k], flat[k + 1]));
      if (P.length < 3) continue;
      const o = pos.length / 3;
      P.forEach((p) => pos.push(p.x, lvl + 0.05, p.y));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(P, [])) {
        const up = (P[b].y - P[a].y) * (P[c].x - P[a].x) - (P[b].x - P[a].x) * (P[c].y - P[a].y) > 0;
        idx.push(o + a, o + (up ? b : c), o + (up ? c : b));
      }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1f4a52, roughness: 0.06, metalness: 0.1, envMapIntensity: 1 }));
    m.receiveShadow = true; this.group.add(m);
  }

  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) { const dx = p.x - t[0], dz = p.z - t[2]; if (dx * dx + dz * dz < t[4] * t[4] && p.y < t[1] + t[3] && p.y > t[1] - 2) return t; }
    return null;
  }
  update(dt, t, fx, cam) {
    if (!cam || !this.chunkList) return;
    for (const c of this.chunkList) c.m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) < this.view + c.r;
  }
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
function offset(pts, s) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    return [p[0] - dz / L * s, p[1] + dx / L * s];
  });
}
