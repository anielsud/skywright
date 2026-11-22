// The stunt builders' kit, shared by every stunt park (stuntPark.js) and the Grand Canyon's daredevil jump (evelJump.js):
// a Site is a frame on the ground (origin O, turned yaw about y), with geometry accumulators for its few merged meshes,
// one CollisionMesh for everything you can drive on (collide.js), and the primitives (ramps swept along a path,
// extrusions, boxes, tubes, signs, flags, tyre stacks, grandstands, floodlights, boost pads).
//
// Themes give a park its look (colours, which arch, what the barriers are made of, the sign lettering); the shape comes
// from the layout. Everything draws with five shared materials (earth, paint, signs, lamps, night light pools) and no
// lights of its own (the light set is fixed: see main.js applyQuality), so nothing compiles mid-flight.
import * as THREE from 'three';
import { CollisionMesh } from './collide.js';
import { mulberry32, clamp, smoothstep } from './noise.js';
import { glowTexture } from './materials.js';

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const Y = V(0, 1, 0);
export const PAINT = 0, DIRT = 1, ROCK = 2; // collide.js SURFACES ids: 'runway' (smooth: painted steel/concrete), 'sand' (dust), 'rock'
export const col = (h) => new THREE.Color(h);

// ---- themes: a park's look ----
// jump: what the jump's two mesas are made of (strata: rock bands; containers: stacked shipping containers; timber:
// a wooden stack; lava: black rock). barrier: what lines the turns (tyres, hay bales). arch: the start arch.
export const THEMES = {
  canyon: {
    pad: [0xc49a6a, 0x8f6440, 0xe8e2d4], // ground, worn track, chalk lines
    kicker: [0xffc81e, 0x1c1c1c, 0x6c7178], // stripes, stripes, steel sides
    loop: [0x1f6fd8, 0x2a86f0, 0xffd21e, 0xf4f4f4, 0xe0262a], // deck, deck, rails, rail tops, top beam
    jump: { kind: 'strata', bands: [0xcf9c74, 0xb4553a, 0xa84a34, 0xc0603e, 0xd8b088, 0xb86a48, 0x9c4a30], band: 1.15, top: 0xb48256, type: ROCK, topType: DIRT },
    whoops: 0x9e7048, berm: [0x9a6a40, 0x8e6038], bank: [0xe0262a, 0xf2f2f2, 0xa47650, 0x9a6a42, 0x8e6038],
    bowl: [0xc9c4ba, 0xbdb6aa, 0xe8e4dc, 0xa8a298], stripes: [0xe0262a, 0xffd21e, 0x2a86f0],
    barrier: 'tyres', tyres: [0xe0262a, 0xf2f2f2, 0x1a1a1a, 0x1a1a1a],
    flags: [0xe0262a, 0xffd21e, 0x2a86f0, 0x22b04a, 0xff7a1a, 0xffffff], flag: 'pennant',
    arch: 'inflatable', archC: [0xe0262a, 0xf4f4f4], seats: [0x3c6fb4, 0x4a7cc4], canopy: [0xf4f4f4, 0xe0262a],
    signs: { style: 'classic', name: 'STUNT PARK', jump: 'CANYON JUMP', wall: 'WALL RIDE' },
    rocks: 0xa85a3a,
  },
  urban: { // New York: concrete and asphalt, shipping containers, graffiti colours
    pad: [0x8c8a86, 0x55575a, 0xf2f2ea], // concrete, asphalt, white lines
    kicker: [0xff2d95, 0x18e0e0, 0x3a3d42], // hot pink and cyan graffiti stripes
    loop: [0x7a2cff, 0xff2d95, 0xc6ff1a, 0xf4f4f4, 0x18e0e0],
    jump: { kind: 'containers', bands: [0xc0392b, 0x1f5fa8, 0x2e8b57, 0xe67e22, 0x7f8c8d, 0xf1c40f, 0x8e44ad], band: 2.6, top: 0x5a5e64, type: PAINT, topType: PAINT },
    whoops: 0x9a9894, berm: [0x7a7874, 0x6a6864], bank: [0xff2d95, 0xf2f2f2, 0x8a8884, 0x7a7874, 0x6a6864],
    bowl: [0xb4b2ac, 0xa6a49e, 0x9aa0a8, 0x8e8c86], stripes: [0xff2d95, 0xc6ff1a, 0x18e0e0], coping: true,
    barrier: 'tyres', tyres: [0xff2d95, 0x18e0e0, 0xc6ff1a, 0x1a1a1a],
    flags: [0xff2d95, 0x18e0e0, 0xc6ff1a, 0x7a2cff, 0xff7a1a, 0xffffff], flag: 'pennant',
    arch: 'scaffold', archC: [0x2a2d33, 0xff2d95], seats: [0x5a5e66, 0x6a6e76], canopy: [0x1a1a1a, 0xff2d95],
    signs: { style: 'graffiti', name: 'STUNT PARK', jump: 'CONTAINER JUMP', wall: 'HALF PIPE' },
    rocks: 0x6a6866, containers: true,
  },
  alpine: { // the Jungfrau: a meadow with wooden ramps, hay bales and cowbell flags
    pad: [0x7d8a4a, 0x6f5a3c, 0xf4f1e6], // meadow, dirt track, chalk
    kicker: [0xb07a44, 0x8a5a30, 0x6a4a2a], // planks
    loop: [0xd52b1e, 0xf4f4f4, 0x8a5a30, 0xf4f4f4, 0xd52b1e], // Swiss red and white
    jump: { kind: 'timber', bands: [0xa0703e, 0x8e6234, 0xb07a44, 0x7c5228], band: 0.35, top: 0x9a6a3a, type: PAINT, topType: DIRT },
    whoops: 0x6f5a3c, berm: [0x6a7a3a, 0x5e6c34], bank: [0xd52b1e, 0xf4f4f4, 0x7a6444, 0x6f5a3c, 0x5e6c34],
    bowl: [0xb8b0a0, 0xaaa292, 0xd8d0c0, 0x9a9282], stripes: [0xd52b1e, 0xf4f4f4, 0xd52b1e],
    barrier: 'hay', tyres: [0xd8b45a, 0xcaa44c, 0xe0be66, 0xd0ac54],
    flags: [0xd52b1e, 0xf4f4f4], flag: 'cowbell',
    arch: 'wood', archC: [0x7a4e2a, 0xb03a2e], seats: [0x8a5a30, 0x9a6a3a], canopy: [0xf4f4f4, 0xd52b1e],
    signs: { style: 'alpine', name: 'STUNT PARK', jump: 'ALPINE JUMP', wall: 'WALL RIDE' },
    rocks: 0x8a8680,
  },
  tropical: { // Bora Bora: a sand track lined with palms, bamboo and lava rock, a tiki arch
    pad: [0xe8d8aa, 0xc8b07c, 0xffffff], // pale sand, wet sand, white
    kicker: [0x22c7b8, 0xff6f61, 0x8a6a40], // lagoon turquoise and coral
    loop: [0x12a5c8, 0x22c7b8, 0xffd23a, 0xf4f4f4, 0xff6f61],
    jump: { kind: 'lava', bands: [0x3a3533, 0x4a4240, 0x2e2a28, 0x564c46], band: 0.9, top: 0xd8c08a, type: ROCK, topType: DIRT },
    whoops: 0xd0b884, berm: [0xd8c490, 0xccb680], bank: [0xff6f61, 0xf4f4f4, 0xd8c08a, 0xccb27c, 0xc4aa76],
    bowl: [0xd8cdb6, 0xccc0a8, 0xf0e8d8, 0xb8ae98], stripes: [0xff6f61, 0x22c7b8, 0xffd23a],
    barrier: 'tyres', tyres: [0xff6f61, 0x22c7b8, 0xffd23a, 0x1a1a1a],
    flags: [0xff6f61, 0x22c7b8, 0xffd23a, 0x3fbf5a, 0xff9f1c, 0xffffff], flag: 'pennant',
    arch: 'tiki', archC: [0x6a4424, 0xd8b45a], seats: [0x22a7b8, 0x2ab7c8], canopy: [0xffd23a, 0xff6f61],
    signs: { style: 'tropical', name: 'STUNT PARK', jump: 'LAVA JUMP', wall: 'WALL RIDE' },
    rocks: 0x3a3533, palms: true,
  },
};

// ---- profiles along a ramp: height h(s) for s in [0, L] ----
export const kicker = (H, deg) => { const a = (deg * Math.PI) / 180, R = H / (1 - Math.cos(a)), L = R * Math.sin(a); return { L, H, R, h: (s) => (s <= 0 ? 0 : s >= L ? H : R - Math.sqrt(R * R - s * s)) }; };
// down from H to 0 at slope `deg`, rounded over r0 m at the top and r1 m at the bottom (a landing)
export function descent(H, deg, r0, r1) {
  const k = Math.tan((deg * Math.PI) / 180), L = H / k + (r0 + r1) / 2, n = 400, tab = new Float32Array(n + 1);
  let y = 0; tab[0] = 0;
  for (let i = 1; i <= n; i++) { const s = (L * (i - 0.5)) / n; y += k * smoothstep(0, r0, s) * (1 - smoothstep(L - r1, L, s)) * (L / n); tab[i] = y; }
  const sc = H / y;
  return { L, H, h: (s) => { const f = clamp(s / L, 0, 1) * n, i = Math.min(n - 1, f | 0), t = f - i; return H - (tab[i] * (1 - t) + tab[i + 1] * t) * sc; } };
}
// the loop: curvature grows smoothly into a teardrop (wide at the bottom, tight at the top), no sudden g at the entry
export function loopCurve(Rtop, Rbot, thc) {
  const rho = (th) => { const e = Math.min(th, 2 * Math.PI - th); let r = Rtop + (Rbot - Rtop) * Math.cos(th / 2) ** 2; if (e < thc) r *= thc / Math.max(e, 0.012); return r; };
  const pts = [V(0, 0, 0)]; let x = 0, y = 0, th = 0.006, acc = 0; const d = 0.0005;
  while (th < 2 * Math.PI - 0.006) { const ds = rho(th + d / 2) * d; x += Math.cos(th + d / 2) * ds; y += Math.sin(th + d / 2) * ds; th += d; acc += ds; if (acc >= 0.7) { pts.push(V(x, y, 0)); acc = 0; } }
  pts.push(V(x, Math.max(0, y), 0));
  return pts;
}

// ---- a geometry accumulator: non-indexed triangles with normals, vertex colours and planar uvs ----
export class Geo {
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
export const faceN = (a, b, c) => _a.subVectors(b, a).cross(_b.subVectors(c, a)).normalize().clone();

// The shared materials of a location's stunt sites (one set: the same shader programs everywhere).
export function stuntMaterials(theme) {
  const atlas = atlasTexture(theme);
  return {
    earth: new THREE.MeshStandardMaterial({ map: dirtTexture(), vertexColors: true, roughness: 0.97, metalness: 0 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 }),
    sign: new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0xfff2d0, emissiveIntensity: 0.4, roughness: 0.3 }),
    pool: new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(1.0, 0.92, 0.75), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
  };
}

// A frame on the ground with its builders. Park frame: x along the site's length, z across it (z = right when you
// face +x), y up from O.y. World = O + (x cos yaw + z sin yaw, y, -x sin yaw + z cos yaw) (THREE's rotation.y = yaw).
export class Site {
  constructor(world, O, yaw, theme, seed) {
    this.w = world; this.O = O; this.yaw = yaw; this.cs = Math.cos(yaw); this.sn = Math.sin(yaw);
    this.T = theme; this.cm = new CollisionMesh(4);
    this.G = { earth: new Geo(0.11), paint: new Geo(), sign: new Geo(), lamp: new Geo(), pool: new Geo() };
    this.boosts = []; this.rnd = mulberry32(seed); this.hideAt = 9000;
  }
  // park frame <-> world
  W(p) { const c = this.cs, s = this.sn; return V(this.O.x + (p.x * c + p.z * s), this.O.y + p.y, this.O.z + (-p.x * s + p.z * c)); }
  Wd(d) { const c = this.cs, s = this.sn; return V(d.x * c + d.z * s, d.y, -d.x * s + d.z * c); }
  Lp(p) { const dx = p.x - this.O.x, dz = p.z - this.O.z, c = this.cs, s = this.sn; return V(dx * c - dz * s, p.y - this.O.y, dx * s + dz * c); }
  Ld(d) { const c = this.cs, s = this.sn; return V(d.x * c - d.z * s, d.y, d.x * s + d.z * c); }
  local(x, z) { const dx = x - this.O.x, dz = z - this.O.z; return [dx * this.cs - dz * this.sn, dx * this.sn + dz * this.cs]; }
  // a heading (the flight model's: 0 = -z, -pi/2 = +x) of the park frame's +x (dir 1) or -x (dir -1)
  heading(dir = 1) { return this.yaw + (dir > 0 ? -Math.PI / 2 : Math.PI / 2); }
  topAt(x, z) { return this.cm.topAt(x, z); }

  // ---- primitives (park frame; coll: [type, depth] adds the triangles to the collision mesh) ----
  tri(geo, a, b, c, color, coll, na, nb, nc) {
    const fn = faceN(a, b, c);
    geo.vert(a, na || fn, color); geo.vert(b, nb || fn, color); geo.vert(c, nc || fn, color);
    if (coll) this.cm.tri(this.W(a), this.W(b), this.W(c), coll[0], coll[1], na && this.Wd(na), nb && this.Wd(nb), nc && this.Wd(nc));
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
  // a tube from p0 to p1 (any direction), radius r0 to r1, with end caps
  tube(geo, p0, p1, r0, r1, seg, color, caps = true) {
    const ax = p1.clone().sub(p0).normalize(), u = Math.abs(ax.y) < 0.9 ? V(0, 1, 0).cross(ax).normalize() : V(1, 0, 0).cross(ax).normalize(), w = ax.clone().cross(u);
    const ring = (p, r, a) => p.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(w, Math.sin(a) * r);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const n0 = u.clone().multiplyScalar(Math.cos(a0)).addScaledVector(w, Math.sin(a0)), n1 = u.clone().multiplyScalar(Math.cos(a1)).addScaledVector(w, Math.sin(a1));
      this.quad(geo, ring(p0, r0, a0), ring(p0, r0, a1), ring(p1, r1, a1), ring(p1, r1, a0), color, null, n0.clone().add(n1), [n0, n1, n1, n0]);
      if (caps) { this.tri(geo, p1, ring(p1, r1, a0), ring(p1, r1, a1), color, null); this.tri(geo, p0, ring(p0, r0, a1), ring(p0, r0, a0), color, null); }
    }
  }
  // A heightfield ribbon along a path: path(s) -> { p (ground point on the centreline), t (forward), r (right) };
  // cross(s) -> [[a, y], ...] across it (a along r, y up). Solid down to the ground (o.floor, default 0): side walls and end caps.
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
    const wc = o.wallColor || (() => o.color(0, 0, 0)), wt = o.wallType ?? ROCK, band = o.band || 99, fl = o.floor ?? 0;
    const wall = (p0, p1, out) => { // vertical strip from the top edge p0-p1 down to the floor, in height bands
      const top = Math.max(p0.y, p1.y); if (top < fl + 0.02) return;
      for (let y = fl; y < top; y += band) {
        const ya = y, yb = Math.min(top, y + band), cl = (p, yy) => V(p.x, Math.min(p.y, yy), p.z);
        const A = cl(p0, ya), B = cl(p1, ya), C = cl(p1, yb), D = cl(p0, yb);
        if (C.y - B.y < 0.01 && D.y - A.y < 0.01) continue;
        this.quad(geo, A, B, C, D, wc(ya, out), [wt, 1.0], out);
      }
    };
    for (let i = 0; i < n; i++) {
      wall(at(i, 0), at(i + 1, 0), rows[i].f.r.clone().negate());
      wall(at(i, K - 1), at(i + 1, K - 1), rows[i].f.r.clone());
    }
    if (o.caps !== false) for (const [i, out] of [[0, rows[0].f.t.clone().negate()], [n, rows[n].f.t.clone()]]) for (let k = 0; k < K - 1; k++) wall(at(i, k), at(i, k + 1), out);
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
  // an invisible barrier wall (collision only) along a path at lateral offset `a`, from height y0 (or y0(s): along a
  // rising berm's top)
  wallLine(pth, s0, s1, a, h, y0 = 0) {
    const yb = typeof y0 === 'function' ? y0 : () => y0;
    for (let s = s0; s < s1; s += 2) {
      const sb = Math.min(s1, s + 2), f0 = pth(s), f1 = pth(sb), p0 = this.W(f0.p.clone().addScaledVector(f0.r, a).setY(yb(s))), p1 = this.W(f1.p.clone().addScaledVector(f1.r, a).setY(yb(sb)));
      const A = p0, B = p1, C = p1.clone().add(V(0, h, 0)), D = p0.clone().add(V(0, h, 0)), out = this.Wd(f0.r.clone().negate());
      const fn = faceN(A, B, C); if (fn.dot(out) < 0) { this.cm.tri(A, C, B, PAINT, 0.6); this.cm.tri(A, D, C, PAINT, 0.6); } else { this.cm.tri(A, B, C, PAINT, 0.6); this.cm.tri(A, C, D, PAINT, 0.6); }
    }
  }
  // a solid block (collision only): box x0..x1, z0..z1 (park frame), height h
  solid(x0, x1, z0, z1, h, depth = 1.5, y0 = 0) {
    const q = [V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)].map((a) => this.W(a)), t = q.map((p) => p.clone().add(V(0, h, 0)));
    const fc = (a, b, cc, d, out) => { const n = faceN(a, b, cc), o = this.Wd(out); if (n.dot(o) < 0) { this.cm.tri(a, cc, b, PAINT, depth); this.cm.tri(a, d, cc, PAINT, depth); } else { this.cm.tri(a, b, cc, PAINT, depth); this.cm.tri(a, cc, d, PAINT, depth); } };
    fc(t[0], t[1], t[2], t[3], Y); fc(q[0], q[1], t[1], t[0], V(0, 0, -1)); fc(q[2], q[3], t[3], t[2], V(0, 0, 1)); fc(q[1], q[2], t[2], t[1], V(1, 0, 0)); fc(q[3], q[0], t[0], t[3], V(-1, 0, 0));
  }
  rock(p, s, c = col(this.T.rocks)) {
    const g = new THREE.IcosahedronGeometry(s, 0), pos = g.attributes.position, cc = c.clone().multiplyScalar(0.8 + this.rnd() * 0.3);
    for (let i = 0; i < pos.count; i += 3) {
      const a = V().fromBufferAttribute(pos, i), b = V().fromBufferAttribute(pos, i + 1), d = V().fromBufferAttribute(pos, i + 2);
      for (const v of [a, b, d]) { v.y *= 0.6; v.add(p).add(V(0, s * 0.3, 0)); }
      this.tri(this.G.earth, a, b, d, cc, [ROCK, s]);
    }
    g.dispose();
  }

  // ---- boost pads ----
  // glowing chevrons on the ground; drive over it and you are pushed up to `target` m/s
  // exact: sets the speed both ways (a jump that needs just the right speed); rumble: a slowing strip; push: m/s^2;
  // o.add: instead a steady push (m/s^2) on top of your own speed, up to target; o.cap = false: never holds you back
  boost(pth, s0, L, target, y = 0, exact = false, w = 2.4, rumble = false, o = {}) {
    const f0 = pth(s0), h = y + 0.08, n = Math.max(1, Math.round(L / (o.tile || 4))), q = (ss, a) => { const f = pth(ss); return f.p.addScaledVector(f.r, a).setY(h); };
    if (rumble) for (let i = 0; i < L / 1.2; i++) this.quad(this.G.paint, q(s0 + i * 1.2, -w), q(s0 + i * 1.2, w), q(s0 + i * 1.2 + 1.2, w), q(s0 + i * 1.2 + 1.2, -w), i % 2 ? col(0xf2f2f2) : col(0xe0262a), null, Y);
    else for (let i = 0; i < n; i++) { const sa = s0 + (L * i) / n, sb = s0 + (L * (i + 1)) / n; this.signQuad([q(sa, -w), q(sa, w), q(sb, w), q(sb, -w)], ATLAS[o.tex || 'chev']); }
    this.boosts.push({ a: this.W(f0.p.clone().setY(y)), t: this.Wd(f0.t), r: this.Wd(f0.r), L, w: w + 0.6, target, y, exact, rumble, push: o.push || 26, msg: o.msg || 'BOOST!', add: o.add || 0, cap: o.cap !== false });
  }
  // the boost pads under a car on the ground: push or hold it back (messages for the HUD into msgs)
  boostPads(ac, dt, fwd, msgs) {
    for (const b of this.boosts) {
      const d = ac.x.clone().sub(b.a), s = d.dot(b.t), l = d.dot(b.r);
      if (s < 0 || s > b.L || Math.abs(l) > b.w || Math.abs(d.y) > 3) continue;
      const v = ac.v.dot(fwd);
      if (fwd.dot(b.t) < 0.7) continue;
      if (b.add) { if (v < b.target) { ac.v.addScaledVector(fwd, Math.min(b.target - v, b.add * dt)); if (!b.glow || b.glow < 0.2) msgs.push({ center: b.msg }); b.glow = 1; } continue; } // (a steady push on top of your own speed, up to a ceiling: the faster you come in, the faster you go out)
      if (v < b.target && !b.rumble) { ac.v.addScaledVector(fwd, Math.min(b.target - v, b.push * dt)); if (!b.glow || b.glow < 0.2) msgs.push({ center: b.msg }); b.glow = 1; }
      else if (b.cap && v > b.target + (b.exact ? 0 : 1)) ac.v.addScaledVector(fwd, -Math.min(v - b.target - (b.exact ? 0 : 1), (b.exact ? 30 : 12) * dt)); // too fast for what's next: it holds you back
    }
  }

  // ---- dressing: barriers, signs, flags, stands, lights ----
  // a stack of n old tyres (or a hay bale, or a bamboo post: the theme's barrier)
  tyres(p, n = 2) {
    const Pn = this.G.paint, T = this.T, c = col(T.tyres[Math.floor(this.rnd() * T.tyres.length)]);
    if (T.barrier === 'hay') this.cyl(Pn, p.x, p.y, p.z, 0.62, 0.6, 0.3 * n + 0.3, 10, c);
    else this.cyl(Pn, p.x, p.y, p.z, 0.42, 0.42, 0.34 * n, 8, c);
  }
  barrierStep() { return this.T.barrier === 'hay' ? 1.3 : 0.9; }
  signQuad(q, rect) { // q: a-b-c-d (a-b along the bottom edge, left to right as read)
    const S = this.G.sign, n = faceN(q[0], q[1], q[2]), [u0, v0, u1, v1] = rect, w = col(0xffffff);
    const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const m of [i, j, k]) { S.p.push(q[m].x, q[m].y, q[m].z); S.n.push(n.x, n.y, n.z); S.c.push(w.r, w.g, w.b); S.u.push(...uv[m]); }
  }
  // a signboard on two posts facing `face` (or the track centre); key: an atlas entry
  sign(p, key, w, side = 0, hang = false, face = null) {
    const Pn = this.G.paint, rect = ATLAS[key], h = (w * (rect[3] - rect[1])) / (rect[2] - rect[0]);
    const dir = face ? face.clone().negate().setY(0).normalize() : side ? V(0, 0, side) : V(-1, 0, 0); // the way the board faces
    const along = V(dir.z, 0, -dir.x), y0 = hang ? p.y : p.y + 2.2;
    const c = p.clone().setY(y0);
    const q = [c.clone().addScaledVector(along, -w / 2), c.clone().addScaledVector(along, w / 2), c.clone().addScaledVector(along, w / 2).add(V(0, h, 0)), c.clone().addScaledVector(along, -w / 2).add(V(0, h, 0))].map((v) => v.addScaledVector(dir, 0.08));
    this.signQuad(q, rect);
    const back = q.map((v) => v.clone().addScaledVector(dir, -0.16));
    this.quad(Pn, back[1], back[0], back[3], back[2], col(0x2c2c2c), null, dir.clone().negate());
    if (!hang) for (const s of [-1, 1]) this.box(Pn, p.x + along.x * s * w * 0.4, p.y, p.z + along.z * s * w * 0.4, 0.15, y0 + h * 0.5 - p.y, 0.15, 0, col(0x55585e));
  }
  // a flag on a pole (the theme's: a pennant, or a Swiss flag with a cowbell under it)
  flag(p, c) {
    const Pn = this.G.paint, h = 5.5, y = p.y || 0;
    this.cyl(Pn, p.x, y, p.z, 0.05, 0.04, h, 4, col(0xdddddd), false);
    if (this.T.flag === 'cowbell') {
      const red = col(0xd52b1e), wht = col(0xf4f4f4), s = 1.3, x0 = p.x + 0.05, two = (a, b, cc, d, k) => { this.quad(Pn, a, b, cc, d, k, null, V(0, 0, 1)); this.quad(Pn, a, b, cc, d, k, null, V(0, 0, -1)); };
      const Q = (u0, v0, u1, v1, k) => two(V(x0 + u0, y + h - s + v0, p.z), V(x0 + u1, y + h - s + v0, p.z), V(x0 + u1, y + h - s + v1, p.z), V(x0 + u0, y + h - s + v1, p.z), k);
      Q(0, 0, s, s, red); Q(s * 0.42, s * 0.18, s * 0.58, s * 0.82, wht); Q(s * 0.18, s * 0.42, s * 0.82, s * 0.58, wht); // (the cross: drawn twice over the red, nudged by polygon order)
      // the cowbell on its strap, hanging from the pole's crossbar
      this.box(Pn, p.x + 0.35, y + h - s - 0.75, p.z, 0.06, 0.75, 0.06, 0, col(0x6a3a1a));
      this.cyl(Pn, p.x + 0.35, y + h - s - 1.25, p.z, 0.2, 0.12, 0.5, 8, col(0xb08a3a));
      return;
    }
    const a = V(p.x, y + h, p.z), b = V(p.x, y + h - 1.0, p.z), t = V(p.x + 1.6, y + h - 0.45, p.z + (this.rnd() - 0.5) * 0.6);
    this.tri(Pn, a, b, t, c); this.tri(Pn, a, t, b, c);
  }
  // a grandstand with a crowd at (x, z), len long; f: +1 the stand is south of the track (faces -z), -1 north
  stand(x, z, len, f) {
    const Pn = this.G.paint, T = this.T, tiers = 6, r = this.rnd, shirt = [0xe0262a, 0x2a86f0, 0xffd21e, 0x22b04a, 0xff7a1a, 0xf4f4f4, 0x8a4ad8, 0x1a1a1a].map(col), skin = [0xf1c8a0, 0xd8a070, 0x9a6a44, 0x6a4428].map(col);
    for (let t = 0; t < tiers; t++) { const zz = z + f * (t * 1.0 + 0.5); this.box(Pn, x, 0, zz, len, 0.5 + t * 0.55, 1.0, 0, col(0x9aa0a8), null, col(T.seats[t % 2 ? 0 : 1])); }
    this.box(Pn, x, 0, z + f * (tiers + 0.1), len, tiers * 0.55 + 2.4, 0.3, 0, col(0x6a7078));
    // a striped canopy on posts, and bunting along its front edge
    const ry = tiers * 0.55 + 3.4, rz = z + f * (tiers / 2 + 0.2);
    for (let k = 0; k < len / 4; k++) this.box(Pn, x - len / 2 + 2 + k * 4, ry, rz, 4, 0.18, tiers + 1.6, 0, k % 2 ? col(T.canopy[0]) : col(T.canopy[1]));
    for (let k = 0; k <= len / 11; k++) this.box(Pn, x - len / 2 + 0.5 + k * ((len - 1) / Math.ceil(len / 11)), 0, z + f * (tiers + 0.4), 0.2, ry, 0.2, 0, col(0x55585e));
    const flagC = T.flags.slice(0, 5).map(col), fz = z - f * 0.5, nf = flagC.length;
    for (let k = 0; k < len / 1.2; k++) { const px = x - len / 2 + 0.6 + k * 1.2, sag = 0.5 * Math.sin((k * 1.2 / len) * Math.PI); const a = V(px - 0.4, ry - sag, fz), b = V(px + 0.4, ry - sag, fz), c = V(px, ry - sag - 0.7, fz); this.tri(Pn, a, b, c, flagC[k % nf]); this.tri(Pn, a, c, b, flagC[k % nf]); }
    // one solid block for the collision mesh
    this.solid(x - len / 2, x + len / 2, z + f * tiers / 2 - tiers / 2, z + f * tiers / 2 + tiers / 2, tiers * 0.55);
    for (let t = 0; t < tiers; t++) for (let i = 0; i < len * 0.75; i++) {
      if (r() < 0.25) continue;
      const px = x - len / 2 + 0.6 + r() * (len - 1.2), pz = z + f * (t * 1.0 + 0.55), py = 0.5 + t * 0.55, c = shirt[Math.floor(r() * shirt.length)], sk = skin[Math.floor(r() * skin.length)];
      const stand = r() < 0.2 ? 0.25 : 0; // some are on their feet
      this.box(Pn, px, py, pz, 0.46, 0.62 + stand, 0.3, 0, c);
      this.box(Pn, px, py + 0.66 + stand, pz, 0.24, 0.26, 0.24, 0, sk, null, r() < 0.4 ? shirt[Math.floor(r() * 3)] : col(0x3a2a1c));
    }
  }
  // a floodlight tower at (x, z) aimed at `at` (park frame, default the centre), and its pool of light on the ground
  tower(x, z, f, at = V(0, 0, 0)) {
    const Pn = this.G.paint, L = this.G.lamp, h = 19, toC = V(at.x - x, 0, at.z - z).normalize(), side = V(-toC.z, 0, toC.x);
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
  // a palm tree (tropical parks), leaning a little
  palm(p, h = 9) {
    const Pn = this.G.paint, r = this.rnd, lean = V((r() - 0.5) * 1.6, h, (r() - 0.5) * 1.6), top = p.clone().add(lean);
    const trunk = col(0x8a6a48), leaf = [0x2f7a2a, 0x3a8c30, 0x276a24].map(col);
    const mid = p.clone().lerp(top, 0.5).add(V(lean.x * 0.15, 0, lean.z * 0.15));
    this.tube(Pn, p, mid, 0.32, 0.26, 6, trunk, false); this.tube(Pn, mid, top, 0.26, 0.2, 6, trunk, false);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r() * 0.4, d = V(Math.cos(a), 0, Math.sin(a)), s = V(-d.z, 0, d.x), L = 3.4 + r() * 1.2;
      const tip = top.clone().addScaledVector(d, L).add(V(0, -1.6 - r(), 0)), m = top.clone().addScaledVector(d, L * 0.5).add(V(0, 0.35, 0));
      const c = leaf[i % 3];
      for (const [a0, a1] of [[top, m], [m, tip]]) { const wv = a0 === top ? 0.7 : 0.5; this.tri(Pn, a0, a1, a1.clone().addScaledVector(s, wv), c); this.tri(Pn, a0, a1.clone().addScaledVector(s, -wv), a1, c); this.tri(Pn, a0, a1.clone().addScaledVector(s, wv), a1, c); this.tri(Pn, a0, a1, a1.clone().addScaledVector(s, -wv), c); }
    }
    this.cyl(Pn, top.x, top.y - 0.6, top.z, 0.28, 0.3, 0.5, 6, col(0x6a5030)); // coconuts and frond bases
  }

  // ---- meshes ----
  buildMeshes(world, mats, name) {
    const G = this.G, grp = (this.group = new THREE.Group()); grp.position.copy(this.O); grp.rotation.y = this.yaw; grp.name = name;
    this.mats = mats; this.meshes = {};
    for (const k of ['earth', 'paint', 'sign', 'lamp', 'pool']) {
      if (!G[k].tris) continue;
      const m = new THREE.Mesh(G[k].geometry(), mats[k]); m.name = name + '-' + k;
      m.receiveShadow = k !== 'pool'; m.castShadow = k === 'earth' || k === 'paint';
      grp.add(m); this.meshes[k] = m;
    }
    if (this.meshes.pool) { this.meshes.pool.visible = false; this.meshes.pool.renderOrder = 2; }
    this.stats = { tris: Object.values(G).reduce((a, g) => a + g.tris, 0), collTris: this.cm.n, draws: Object.keys(this.meshes).length };
    this.G = null;
    world.group.add(world.nearShadow ? world.nearShadow(grp) : grp);
  }
  update(night, cam, dt) {
    if (this.meshes.pool) this.meshes.pool.visible = night;
    if (cam) this.group.visible = Math.hypot(cam.x - this.O.x, cam.z - this.O.z) < this.hideAt;
    for (const b of this.boosts) b.glow = (b.glow || 0) * Math.exp(-dt * 3);
  }
  dispose() { for (const m of Object.values(this.meshes || {})) m.geometry.dispose(); }
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
export const ATLAS = {
  name: [0, 0.75, 1, 1], start: [0, 0.625, 0.5, 0.75], loop: [0.5, 0.625, 1, 0.75], jump: [0, 0.5, 1, 0.625],
  wall: [0, 0.375, 0.5, 0.5], banked: [0.5, 0.375, 1, 0.5], tabletop: [0, 0.25, 0.5, 0.375], whoops: [0.5, 0.25, 1, 0.375],
  chev: [0, 0, 0.25, 0.25], check: [0.25, 0, 0.5, 0.25],
  daredevil: [0.5, 0.125, 1, 0.25], stars: [0.5, 0, 0.625, 0.125], rocket: [0.625, 0, 0.75, 0.125], tv: [0.75, 0, 0.875, 0.125], stripes: [0.875, 0, 1, 0.125],
};
// each theme's lettering: [background, letters, edge] per board
const STYLE = {
  classic: { font: '"Arial Black", Impact, sans-serif', name: ['#d81e24', '#ffd21e'], start: ['#111111', '#ffffff', '#ffd21e'], loop: ['#1f6fd8', '#ffd21e'], jump: ['#b4553a', '#ffffff', '#ffd21e'], wall: ['#2a86f0', '#ffffff'], banked: ['#22b04a', '#ffffff'], tabletop: ['#ff7a1a', '#ffffff'], whoops: ['#8a4ad8', '#ffd21e'] },
  graffiti: { font: 'Impact, "Arial Black", sans-serif', name: ['#2b2b30', '#ff2d95'], start: ['#2b2b30', '#c6ff1a'], loop: ['#3a2b55', '#18e0e0'], jump: ['#2b2b30', '#ffb000'], wall: ['#2b3a3a', '#ff2d95'], banked: ['#2b2b30', '#c6ff1a'], tabletop: ['#2b2b30', '#18e0e0'], whoops: ['#3a2b55', '#ffd21e'], graffiti: true },
  alpine: { font: 'Georgia, "Times New Roman", serif', name: ['#7a4e2a', '#ffffff', '#d52b1e'], start: ['#d52b1e', '#ffffff'], loop: ['#d52b1e', '#ffffff'], jump: ['#7a4e2a', '#ffffff', '#d52b1e'], wall: ['#5e6c34', '#ffffff'], banked: ['#5e6c34', '#ffffff'], tabletop: ['#7a4e2a', '#ffffff'], whoops: ['#7a4e2a', '#ffd21e'], wood: true },
  tropical: { font: '"Arial Black", Impact, sans-serif', name: ['#6a4424', '#ffd23a', '#22c7b8'], start: ['#22c7b8', '#ffffff'], loop: ['#12a5c8', '#ffd23a'], jump: ['#3a3533', '#ff6f61', '#ffd23a'], wall: ['#ff6f61', '#ffffff'], banked: ['#3fbf5a', '#ffffff'], tabletop: ['#ff9f1c', '#ffffff'], whoops: ['#22c7b8', '#ffffff'], wood: true },
};
function atlasTexture(theme) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const st = STYLE[theme.signs.style] || STYLE.classic, words = { name: theme.signs.name, start: 'START', loop: 'LOOP', jump: theme.signs.jump, wall: theme.signs.wall, banked: 'BANKED TURN', tabletop: 'TABLETOP', whoops: 'WHOOPS!', ...theme.signs.words }; // (signs.words: a park's own boards, e.g. the water park's)
  const rnd = mulberry32(17);
  const box = (r, bg, fg, text, size, edge = '#ffffff') => {
    const x = r[0] * S, y = (1 - r[3]) * S, w = (r[2] - r[0]) * S, h = (r[3] - r[1]) * S;
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    if (st.wood) for (let k = 0; k < h; k += 14) { g.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.08})`; g.fillRect(x, y + k, w, 2); } // planks
    if (st.graffiti) for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(255,255,255,${0.03 + rnd() * 0.05})`; g.fillRect(x + rnd() * w, y + rnd() * h, 6 + rnd() * 40, 3 + rnd() * 10); } // a scuffed wall
    if (!st.graffiti) { g.strokeStyle = edge; g.lineWidth = 10; g.strokeRect(x + 8, y + 8, w - 16, h - 16); }
    g.font = `900 ${size}px ${st.font}`; size = Math.min(size, (size * (w - 60)) / g.measureText(text).width); // (fit the board)
    g.font = `900 ${size}px ${st.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tx = x + w / 2, ty = y + h / 2 + size * 0.04;
    if (st.graffiti) { // spray paint: a fat dark outline, a bright drop shadow, a two-tone fill and drips
      g.save(); g.translate(tx, ty); g.rotate(-0.04); g.transform(1, 0, -0.12, 1, 0, 0);
      g.lineJoin = 'round'; g.lineWidth = size * 0.3; g.strokeStyle = '#111'; g.strokeText(text, 4, 4);
      g.lineWidth = size * 0.16; g.strokeStyle = '#ffffff'; g.strokeText(text, 0, 0);
      const gr = g.createLinearGradient(0, -size / 2, 0, size / 2); gr.addColorStop(0, fg); gr.addColorStop(1, '#ffd21e');
      g.fillStyle = gr; g.fillText(text, 0, 0); g.restore();
      g.fillStyle = fg; for (let k = 0; k < 7; k++) { const dx = x + 40 + rnd() * (w - 80), dl = 10 + rnd() * h * 0.25; g.fillRect(dx, ty + size * 0.3, 4, dl); g.beginPath(); g.arc(dx + 2, ty + size * 0.3 + dl, 4, 0, 7); g.fill(); }
      return;
    }
    g.lineWidth = size * 0.12; g.strokeStyle = '#111'; g.fillStyle = fg; g.strokeText(text, tx, ty); g.fillText(text, tx, ty);
  };
  const sizes = { name: 170, start: 92, loop: 100, jump: 96, wall: 74, banked: 62, tabletop: 76, whoops: 80 };
  for (const k of Object.keys(sizes)) box(ATLAS[k], st[k][0], st[k][1], words[k], sizes[k], st[k][2]);
  const R = (k) => { const r = ATLAS[k]; return [r[0] * S, (1 - r[3]) * S, (r[2] - r[0]) * S, (r[3] - r[1]) * S]; };
  // chevrons (boost pads) and a chequered start line
  { const [x, y, w, h] = R('chev'); g.fillStyle = '#1a1a1a'; g.fillRect(x, y, w, h); g.fillStyle = '#ffb000';
    for (let k = 0; k < 2; k++) { const y0 = y + h * (0.9 - k * 0.5); g.beginPath(); g.moveTo(x + w * 0.1, y0); g.lineTo(x + w * 0.5, y0 - h * 0.32); g.lineTo(x + w * 0.9, y0); g.lineTo(x + w * 0.9, y0 - h * 0.12); g.lineTo(x + w * 0.5, y0 - h * 0.44); g.lineTo(x + w * 0.1, y0 - h * 0.12); g.closePath(); g.fill(); } }
  { const [x, y] = R('check'), n = 8, q = (S * 0.25) / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(x + i * q, y + j * q, q, q); } }
  // the daredevil jump (evelJump.js): its sign, stars on blue, a red-white-blue rocket chevron, the TV camera board, stripes
  { const [x, y, w, h] = R('daredevil'); g.fillStyle = '#0a2a6c'; g.fillRect(x, y, w, h);
    for (let k = 0; k < 7; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#c8102e'; g.fillRect(x, y + h * 0.78 + k * (h * 0.22 / 7), w, h * 0.22 / 7 + 1); }
    g.fillStyle = '#ffffff'; for (let k = 0; k < 9; k++) star(g, x + 26 + k * (w - 52) / 8, y + 22, 10);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 8; g.strokeStyle = '#111';
    for (const [t, yy, sz, cc] of [['DAREDEVIL', 0.33, 74, '#ffd21e'], ['CANYON JUMP', 0.6, 58, '#ffffff']]) { g.font = `900 ${sz}px "Arial Black", Impact, sans-serif`; g.strokeText(t, x + w / 2, y + h * yy); g.fillStyle = cc; g.fillText(t, x + w / 2, y + h * yy); } }
  { const [x, y, w, h] = R('stars'); g.fillStyle = '#0a2a6c'; g.fillRect(x, y, w, h); g.fillStyle = '#ffffff'; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) star(g, x + w * (0.18 + i * 0.32), y + h * (0.18 + j * 0.32), 13); }
  { const [x, y, w, h] = R('rocket'); g.fillStyle = '#0a2a6c'; g.fillRect(x, y, w, h);
    for (let k = 0; k < 2; k++) { const y0 = y + h * (0.92 - k * 0.48); g.fillStyle = k ? '#ffffff' : '#c8102e'; g.beginPath(); g.moveTo(x + w * 0.08, y0); g.lineTo(x + w * 0.5, y0 - h * 0.34); g.lineTo(x + w * 0.92, y0); g.lineTo(x + w * 0.92, y0 - h * 0.14); g.lineTo(x + w * 0.5, y0 - h * 0.48); g.lineTo(x + w * 0.08, y0 - h * 0.14); g.closePath(); g.fill(); } }
  { const [x, y, w, h] = R('tv'); g.fillStyle = '#111'; g.fillRect(x, y, w, h); g.fillStyle = '#c8102e'; g.beginPath(); g.arc(x + w * 0.2, y + h * 0.5, h * 0.14, 0, 7); g.fill();
    g.font = '900 52px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffffff'; g.fillText('LIVE', x + w * 0.6, y + h * 0.52); }
  { const [x, y, w, h] = R('stripes'); for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#c8102e'; g.fillRect(x + k * w / 8, y, w / 8 + 1, h); } }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function star(g, x, y, r) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.42 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill(); }
