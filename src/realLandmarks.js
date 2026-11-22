// Landmarks of real places that OpenStreetMap can't draw by itself:
//  - the underside of high bridge decks is solid (the decks themselves are ground: roads.js RoadSurface);
//  - the big bridges' structure (osm.json 'bridges': towers at the ends of the main span): steel or masonry towers,
//    main cables hanging between them and down to the anchorages, suspender cables, truss sides on the span;
//  - the Statue of Liberty (loc.city.statue): TT3D's photogrammetry scan of the statue and the top of her pedestal
//    (Sketchfab, CC BY 4.0; tools/liberty/statue.mjs: assets/landmarks/liberty.glb, three levels of detail) on the
//    pedestal's base, the foundation and Fort Wood's eleven-pointed star, at their real heights (the torch 93 m up),
//    the flame lit at night. Without the model (it failed to load): a simple stand-in.
import * as THREE from 'three';
import { buildingMaterial, C } from './buildings.js';
import { MeshW } from './realCity.js';
import { toLocal } from './realworld.js';

const STEEL = { 'Manhattan Bridge': 0x7f9cba, 'Williamsburg Bridge': 0xa89a90, 'George Washington Bridge Upper Level': 0xa8acb0, 'Robert F. Kennedy Bridge': 0xb8b0a0, 'Queensboro Bridge': 0xb0a898 };

// a tapered rod between two points (any direction), seg sides
function rod(M, a, b, r0, r1, seg, cell) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length(); if (L < 1e-3) return;
  d.divideScalar(L);
  const u = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(d).normalize() : new THREE.Vector3(1, 0, 0).cross(d).normalize(), v = d.clone().cross(u);
  const ring = (p, r, k) => { const t = (k / seg) * Math.PI * 2, c = Math.cos(t) * r, s = Math.sin(t) * r; return [p[0] + u.x * c + v.x * s, p[1] + u.y * c + v.y * s, p[2] + u.z * c + v.z * s]; };
  for (let k = 0; k < seg; k++) {
    if (r1 > 0.01) M.poly([ring(a, r0, k), ring(a, r0, k + 1), ring(b, r1, k + 1), ring(b, r1, k)], cell);
    else M.poly([ring(a, r0, k), ring(a, r0, k + 1), b], cell);
  }
}

export class Landmarks {
  constructor(world, D, group) {
    this.w = world; this.D = D; this.group = group;
    this.boxes = []; // collision: [cx, y0, cz, h, r, ux, uz, hl, hw]
    this.buildDecks();
    const bridges = D.osm.bridges || [];
    const city = world.loc.city;
    if (bridges.length || city?.statue) {
      this.mat = buildingMaterial({ cellPx: 128, interiors: false });
      for (const b of bridges) { // (one mesh each: positions are int16 around the mesh's centre)
        const M = new MeshW((b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2, 8192);
        this.bridge(M, b);
        if (M.n) { const m = M.mesh(this.mat); m.castShadow = world.qBase === 'high'; m.receiveShadow = true; group.add(m); }
      }
      if (city?.statue) this.statue(city.statue);
    }
  }

  // ---------------- bridge decks as ground ----------------
  buildDecks() {
    this.decks = new Map();
    for (const rd of this.w.net?.roads || []) {
      if (!rd.bridge || !rd.real) continue;
      const P = rd.pts, hw = rd.width / 2 + 1.2;
      for (let i = 1; i < P.length; i++) {
        if (!rd.bridge[i] || !rd.bridge[i - 1]) continue;
        const a = P[i - 1], b = P[i];
        if (Math.min(a.y, b.y) - Math.max(this.w.sampleGrid(a.x, a.z), this.w.sampleGrid(b.x, b.z), this.w.waterLevel) < 2) continue; // at ground level: the ground does
        const seg = [a.x, a.y, a.z, b.x, b.y, b.z, hw];
        const k0 = Math.floor((Math.min(a.x, b.x) - hw) / 30), k1 = Math.floor((Math.max(a.x, b.x) + hw) / 30), j0 = Math.floor((Math.min(a.z, b.z) - hw) / 30), j1 = Math.floor((Math.max(a.z, b.z) + hw) / 30);
        for (let x = k0; x <= k1; x++) for (let z = j0; z <= j1; z++) { const k = x + ',' + z; let arr = this.decks.get(k); if (!arr) this.decks.set(k, (arr = [])); arr.push(seg); }
      }
    }
  }
  // the deck height under (x, z) if it is at or below y + 4 (y: the aircraft's height), else null
  deckAt(x, z, y = Infinity) {
    const arr = this.decks.get(Math.floor(x / 30) + ',' + Math.floor(z / 30)); if (!arr) return null;
    let best = null;
    for (const s of arr) {
      const dx = s[3] - s[0], dz = s[5] - s[2], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[2]) * dz) / L2));
      const px = s[0] + dx * t - x, pz = s[2] + dz * t - z; if (px * px + pz * pz > s[6] * s[6]) continue;
      const h = s[1] + (s[4] - s[1]) * t;
      if (h <= y + 4 && (best === null || h > best)) best = h;
    }
    return best;
  }

  // ---------------- bridge structures ----------------
  bridge(M, b) {
    const ux0 = b.b[0] - b.a[0], uz0 = b.b[1] - b.a[1], L = Math.hypot(ux0, uz0), ux = ux0 / L, uz = uz0 / L, nx = -uz, nz = ux;
    const W = b.width || 28, T = this.w.waterLevel + b.tower, wl = this.w.waterLevel, masonry = b.kind === 'masonry';
    const off = W / 2 + (masonry ? 3 : 2);
    const col = masonry ? 0xd0c0a4 : STEEL[b.name] ?? 0xa8acb0, cell = masonry ? C.CONCRETE : C.METAL; // (granite: the light atlas cell, tinted)
    M.seed = 40; M.yg = wl;
    const towers = [[b.a[0], b.a[1], b.ya], [b.b[0], b.b[1], b.yb]];
    for (const [x, z, yd] of towers) {
      const base = Math.min(this.w.sampleGrid(x, z), wl) - 4;
      M.color(col);
      if (masonry) {
        // three piers, gothic arches for the two roadways, a solid top
        const archTop = yd + 28;
        for (const s of [-1, 0, 1]) M.box(x + nx * s * (W / 2 + 1), z + nz * s * (W / 2 + 1), ux, uz, 9, s ? 5 : 4, base, archTop, cell);
        M.box(x, z, ux, uz, 9, W / 2 + 6, archTop, T, cell);
        M.box(x, z, ux, uz, 10, W / 2 + 7, base, yd - 6, cell); // the caisson below the deck
        this.boxes.push(this.obox(x, z, ux, uz, 9, W / 2 + 6, base, T));
      } else {
        // two steel legs, portal struts
        for (const s of [-1, 1]) { M.box(x + nx * s * off, z + nz * s * off, ux, uz, 3.2, 2.4, base, T, cell); this.boxes.push(this.obox(x + nx * s * off, z + nz * s * off, ux, uz, 3.2, 2.4, base, T)); }
        for (const y of b.kind === 'cantilever' ? [yd - 3, T - 8] : [yd - 3, (yd + T) / 2, T - 6]) M.box(x, z, ux, uz, 1.6, off, y - 2, y + 2, cell);
        M.box(x, z, ux, uz, 5, off + 3, base, wl + 3, C.CONCRETE); // pier
      }
    }
    if (b.kind === 'cantilever') return;
    // main cables: a parabola between the tower tops, down to 4 m above the deck at mid-span; side spans to the anchorages
    const sag = (t) => 1 - (2 * t - 1) ** 2, yMid = b.deck + 4, top = T - 2;
    const cable = (p0, p1, f, n) => {
      const pts = [];
      for (let k = 0; k <= n; k++) { const t = k / n; pts.push([p0[0] + (p1[0] - p0[0]) * t, f(t), p0[1] + (p1[1] - p0[1]) * t]); }
      return pts;
    };
    const cabs = [];
    for (const s of [-1, 1]) {
      const o = [nx * s * off, nz * s * off];
      const A = [b.a[0] + o[0], b.a[1] + o[1]], B = [b.b[0] + o[0], b.b[1] + o[1]];
      cabs.push({ pts: cable(A, B, (t) => top - (top - yMid) * sag(t), 40), main: true });
      // side spans: from each tower top down to the chain end beyond it
      for (const [P, e] of [[A, b.ends?.[0]], [B, b.ends?.[1]]]) {
        if (!e) continue;
        // pair each tower with the nearer end
        const ends = b.ends.slice().sort((p, q) => Math.hypot(p[0] - P[0], p[1] - P[1]) - Math.hypot(q[0] - P[0], q[1] - P[1]));
        const E = [ends[0][0] + o[0], ends[0][1] + o[1]], ye = ends[0][2] + 3, d = Math.hypot(E[0] - P[0], E[1] - P[1]);
        if (d < 50 || d > 1200) continue;
        cabs.push({ pts: cable(P, E, (t) => top + (ye - top) * t - (top - ye) * 0.12 * Math.sin(t * Math.PI), Math.ceil(d / 30)) });
        if (e === b.ends[1]) break;
      }
    }
    M.color(masonry ? 0x9a9690 : col);
    for (const c of cabs) for (let k = 1; k < c.pts.length; k++) rod(M, c.pts[k - 1], c.pts[k], 0.5, 0.5, 4, C.METAL);
    // suspenders (lines) and truss sides along the main span
    const lp = [];
    for (const c of cabs) {
      if (!c.main) continue;
      for (let k = 1; k < c.pts.length - 1; k++) { const p = c.pts[k], t = k / (c.pts.length - 1); lp.push(p[0], p[1], p[2], p[0], b.ya + (b.yb - b.ya) * t + 0.5, p[2]); }
    }
    if (lp.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a3c40, transparent: true, opacity: 0.7 })));
    }
    if (!masonry) {
      M.color(col);
      for (const s of [-1, 1]) {
        const o = [nx * s * (W / 2 + 0.5), nz * s * (W / 2 + 0.5)];
        for (let k = 0; k < 20; k++) {
          const t0 = k / 20, t1 = (k + 1) / 20, y0 = b.ya + (b.yb - b.ya) * t0, y1 = b.ya + (b.yb - b.ya) * t1;
          const p0 = [b.a[0] + ux0 * t0 + o[0], b.a[1] + uz0 * t0 + o[1]], p1 = [b.a[0] + ux0 * t1 + o[0], b.a[1] + uz0 * t1 + o[1]];
          const q = [[p0[0], y0 - 7, p0[1]], [p1[0], y1 - 7, p1[1]], [p1[0], y1 + 1, p1[1]], [p0[0], y0 + 1, p0[1]]];
          M.poly(s > 0 ? q : q.slice().reverse(), C.RAIL_IRON, 4); M.poly(s > 0 ? q.slice().reverse() : q, C.RAIL_IRON, 4);
        }
      }
    }
  }
  obox(cx, cz, ux, uz, hl, hw, y0, y1) { return [cx, y0, cz, y1 - y0, Math.hypot(hl, hw), ux, uz, hl, hw]; }

  // ---------------- the Statue of Liberty ----------------
  statue(cfg) {
    const W = this.w, [x, z] = toLocal(this.D.meta, cfg.lat, cfg.lon), g = W.sampleGrid(x, z);
    const th = THREE.MathUtils.degToRad(this.D.meta.north || 0), br = THREE.MathUtils.degToRad(cfg.facing);
    const E = Math.sin(br), N = Math.cos(br), fx = E * Math.cos(th) - N * Math.sin(th), fz = -(E * Math.sin(th) + N * Math.cos(th)); // facing, game frame
    const rx = fz, rz = -fx; // her left hand side... (right of the facing direction seen from above)
    const at = (a, y, f) => [x + rx * a + fx * f, y, z + rz * a + fz * f]; // local: a across (+: her left), f forward
    if (this.D.statue) return this.statueScan(this.D.statue, x, z, g, fx, fz);
    // Fort Wood's eleven-pointed star, then the granite pedestal
    const S = new MeshW(x, z, 4096); S.seed = 21; S.yg = g;
    S.color(0xd0c8b8);
    const star = []; for (let k = 0; k < 22; k++) { const a = (k / 22) * Math.PI * 2, r = k % 2 ? 34 : 48; star.push([x + Math.cos(a) * r, z + Math.sin(a) * r]); }
    for (let k = 0; k < 22; k++) { const p = star[k], q = star[(k + 1) % 22]; S.wall(q[0], q[1], p[0], p[1], g - 2, g + 9, g, C.CONCRETE, 3, 3); }
    S.color(0x9a968a); S.roof(star, [], g + 9, C.PAVERS);
    S.color(0xbcb2a2); // pink-grey granite
    const ped = [[g + 9, g + 20, 16], [g + 20, g + 44, 11], [g + 44, g + 47, 12.5], [g + 47, g + 50, 9]];
    for (const [y0, y1, h] of ped) S.box(x, z, fx, fz, h, h, y0, y1, C.CONCRETE);
    this.boxes.push(this.obox(x, z, fx, fz, 16, 16, g, g + 50));
    const sm = S.mesh(this.mat); sm.castShadow = W.qBase === 'high'; sm.receiveShadow = true; this.group.add(sm);
    // the copper statue (46 m to the torch)
    const y0 = g + 50, M = new MeshW(x, z, 4096); M.color(0xffffff); M.yg = y0;
    const robe = [[0, 5.9], [6, 5.5], [14, 4.9], [22, 4.4], [26, 4.0], [29, 3.6]];
    for (let k = 1; k < robe.length; k++) {
      const [ya, ra] = robe[k - 1], [yb, rb] = robe[k], seg = 16;
      for (let s = 0; s < seg; s++) { // folds: every other facet pushed out
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2, fa = s % 2 ? 1 : 0.9, fb = s % 2 ? 0.9 : 1;
        const p = (a, r, y) => at(Math.sin(a) * r, y0 + y, Math.cos(a) * r * 0.82);
        M.poly([p(a0, ra * fa, ya), p(a1, ra * fb, ya), p(a1, rb * fb, yb), p(a0, rb * fa, yb)], C.PLAIN);
      }
    }
    rod(M, at(0, y0 + 29, 0), at(0, y0 + 31, 0.2), 1.6, 1.3, 8, C.PLAIN); // neck
    rod(M, at(0, y0 + 31, 0.2), at(0, y0 + 33.6, 0.4), 2.0, 2.1, 10, C.PLAIN); // head
    rod(M, at(0, y0 + 33.6, 0.4), at(0, y0 + 35.2, 0.3), 2.1, 0.4, 10, C.PLAIN);
    for (let k = 0; k < 7; k++) { // the crown's rays
      const a = (-0.42 + k * 0.14) * Math.PI, base = at(Math.sin(a) * 1.9, y0 + 34.4, 0.4 + Math.cos(a) * 1.9), tip = at(Math.sin(a) * 4.6, y0 + 36.2 + Math.cos(a) * 0.8, 0.4 + Math.cos(a) * 4.6);
      rod(M, base, tip, 0.35, 0.02, 4, C.PLAIN);
    }
    // right arm up with the torch (her right: -a)
    rod(M, at(-3.3, y0 + 28.5, 0), at(-3.9, y0 + 36.5, 0.5), 1.25, 1.0, 8, C.PLAIN);
    rod(M, at(-3.9, y0 + 36.5, 0.5), at(-4.2, y0 + 42.4, 0.7), 1.0, 0.75, 8, C.PLAIN);
    rod(M, at(-4.2, y0 + 42.4, 0.7), at(-4.25, y0 + 43.8, 0.72), 0.8, 1.2, 8, C.PLAIN); // torch cup
    // left arm down, the tablet against her side
    rod(M, at(3.3, y0 + 28.3, 0), at(3.9, y0 + 22.5, 1.0), 1.15, 0.9, 8, C.PLAIN);
    const tc = at(3.4, 0, 1.6); M.box(tc[0], tc[2], fx, fz, 2.1, 0.45, y0 + 19.5, y0 + 27.5, C.PLAIN);
    const copper = new THREE.MeshStandardMaterial({ color: 0x6aa892, roughness: 0.62, metalness: 0.12 });
    const cm = M.mesh(copper); cm.castShadow = W.qBase === 'high'; cm.receiveShadow = true; this.group.add(cm);
    // the gold flame
    const F = new MeshW(x, z, 256); F.color(0xffffff); F.yg = y0;
    rod(F, at(-4.25, y0 + 43.8, 0.72), at(-4.25, y0 + 46.3, 0.8), 1.15, 0.0, 10, C.PLAIN);
    this.flame = new THREE.MeshStandardMaterial({ color: 0xd8a640, metalness: 0.85, roughness: 0.28, emissive: 0xffb040, emissiveIntensity: 0 });
    this.group.add(F.mesh(this.flame));
    this.boxes.push(this.obox(x, z, fx, fz, 6, 5.5, y0, y0 + 47));
    this.statuePos = new THREE.Vector3(x, y0 + 46, z);
  }

  // the scanned statue: Fort Wood's star (walls to 8 m, its parade paved), the foundation in two steps to 19.8 m, the
  // pedestal's base up to where the scan's pedestal starts, and the scan (the statue's base 46.9 m up: the real figures)
  statueScan(model, x, z, g, fx, fz) {
    const W = this.w, info = model.userData || {}, cut = info.cut || { y: -20.87, half: 12.2 }, y0 = g + 46.9;
    const S = new MeshW(x, z, 4096); S.seed = 21; S.yg = g;
    S.color(0xc9bfae);
    const star = []; for (let k = 0; k < 22; k++) { const a = (k / 22) * Math.PI * 2 + Math.atan2(fz, fx), r = k % 2 ? 36 : 52; star.push([x + Math.cos(a) * r, z + Math.sin(a) * r]); }
    for (let k = 0; k < 22; k++) { const p = star[k], q = star[(k + 1) % 22]; S.wall(q[0], q[1], p[0], p[1], g - 2, g + 8, g, C.CONCRETE, 3, 3); }
    S.color(0xa29d90); S.roof(star, [], g + 8, C.PAVERS);
    S.color(0xc4baa8); // the foundation's concrete
    S.box(x, z, fx, fz, 17, 17, g + 8, g + 10, C.CONCRETE); S.box(x, z, fx, fz, 15.6, 15.6, g + 10, g + 15.5, C.CONCRETE); S.box(x, z, fx, fz, 14.4, 14.4, g + 15.5, g + 19.8, C.CONCRETE);
    S.color(0xd2c4ae); // the pedestal's granite, up to the scan
    const h = cut.half + 0.35; S.box(x, z, fx, fz, h + 0.8, h + 0.8, g + 19.8, g + 21.2, C.CONCRETE); S.box(x, z, fx, fz, h, h, g + 21.2, y0 + cut.y + 0.4, C.CONCRETE);
    this.boxes.push(this.obox(x, z, fx, fz, 17, 17, g, g + 19.8), this.obox(x, z, fx, fz, h, h, g + 19.8, y0 - 1));
    const sm = S.mesh(this.mat); sm.castShadow = W.qBase === 'high'; sm.receiveShadow = true; this.group.add(sm);
    // the scan, nearest level of detail first; facing -Z in the model
    // (at night floodlit: an emissive glow in the scan's own colours, so the copper stays green and the granite pale)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0.06, emissive: 0xffffff, emissiveIntensity: 0 }), lod = new THREE.LOD();
    mat.onBeforeCompile = (sh) => { THREE.Material.prototype.onBeforeCompile.call(mat, sh); sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= diffuseColor.rgb;'); };
    mat.customProgramCacheKey = () => 'liberty-flood'; this.flood = mat;
    [0, 450, 1600].forEach((d, i) => { const src = model.getObjectByName('lod' + i); if (!src) return; const m = src.clone(); m.material = mat; m.castShadow = i < 2 && W.qBase === 'high'; m.receiveShadow = true; lod.addLevel(m, d); });
    lod.position.set(x, y0, z); lod.rotation.y = Math.atan2(-fx, -fz); lod.name = 'liberty'; lod.updateMatrixWorld(true);
    this.group.add(lod);
    // the torch's gold flame (the scan's own): lit at night
    const fsrc = model.getObjectByName('flame');
    this.flame = new THREE.MeshStandardMaterial({ color: 0xd8a640, metalness: 0.85, roughness: 0.28, emissive: 0xffb040, emissiveIntensity: 0 });
    if (fsrc) { const f = fsrc.clone(); f.material = this.flame; lod.add(f); } // (rides with the nearest level: it's small)
    this.boxes.push(this.obox(x, z, fx, fz, 6.5, 6.5, y0, y0 + 47));
    this.statuePos = new THREE.Vector3(x, y0 + 46, z);
  }

  hit(p) {
    for (const t of this.boxes) {
      if (p.y > t[1] + t[3] || p.y < t[1]) continue;
      const dx = p.x - t[0], dz = p.z - t[2]; if (dx * dx + dz * dz > (t[4] + 2) ** 2) continue;
      if (Math.abs(dx * t[5] + dz * t[6]) < t[7] && Math.abs(-dx * t[6] + dz * t[5]) < t[8]) { t.solid = true; return t; }
    }
    // the underside of a bridge deck
    const d = this.deckAt(p.x, p.z, Infinity);
    if (d !== null && p.y < d - 0.4 && p.y > d - 3) return Object.assign([p.x, d - 3, p.z, 3, 1], { solid: true });
    return null;
  }
  update(dt, cam) {
    const night = this.w.night ? 1 : 0;
    if (this.flame) this.flame.emissiveIntensity = night ? 3 : 0.15;
    if (this.flood) this.flood.emissiveIntensity = night ? 0.9 : 0;
  }
}
