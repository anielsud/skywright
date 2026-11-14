// Road / rail network, town sites and farm fields. Planned before the terrain mesh is built,
// so roads and towns can be flattened into the heightfield and painted into the baked albedo.
import * as THREE from 'three';
import { mulberry32, smoothstep, lerp, clamp } from './noise.js';
import { glowTexture as glow } from './materials.js';

const RWY_HALF = 900;

export function planNetwork(w) {
  const r = mulberry32(w.loc.seed * 13 + 1);
  const H = (x, z) => w.sampleGrid(x, z);
  const isl = w.loc.id === 'islands', desert = !!w.loc.desert;
  const roads = [];
  // 1) ring road around the airport
  {
    const pts = [], rx = isl ? 650 : 900, rz = isl ? 1250 : 2300;
    for (let k = 0; k < 240; k++) {
      const a = (k / 240) * Math.PI * 2, wob = 1 + w.noise.n2(Math.cos(a) * 1.3, Math.sin(a) * 1.3) * 0.18;
      pts.push(new THREE.Vector3(Math.cos(a) * rx * wob + 140, 0, Math.sin(a) * rz * wob));
    }
    roads.push({ pts: resample(new THREE.CatmullRomCurve3(pts, true).getSpacedPoints(800).slice(0, -1), 8, true), closed: true, kind: 'main', width: 9 });
  }
  const ring = roads[0].pts;
  // 2) town sites: flat, dry, away from the runway
  const towns = [];
  const nTowns = isl ? 2 : 3;
  for (let tries = 0; tries < 900 && towns.length < nTowns; tries++) {
    const a = r() * Math.PI * 2, d = (isl ? 700 : 1200) + r() * (isl ? 1000 : 2200);
    const x = 140 + Math.cos(a) * d * (isl ? 0.9 : 0.7), z = Math.sin(a) * d * (isl ? 1.6 : 1.2);
    if (Math.abs(x - 140) < 520 && Math.abs(z) < RWY_HALF + 500) continue;
    const h = H(x, z);
    if (h < w.waterLevel + 3 || h > w.loc.rwyH + (desert ? 140 : 160)) continue;
    let mn = 1e9, mx = -1e9; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const hh = H(x + i * 90, z + j * 90); mn = Math.min(mn, hh); mx = Math.max(mx, hh); }
    if (mx - mn > (isl ? 26 : 32) || mn < w.waterLevel + 1.5) continue;
    if (towns.some((t) => Math.hypot(t.c.x - x, t.c.z - z) < 1500)) continue;
    // nearest ring point -> street axis points from the town to the ring road
    let best = 0, bd = 1e12; ring.forEach((p, i) => { const dd = (p.x - x) ** 2 + (p.z - z) ** 2; if (dd < bd) { bd = dd; best = i; } });
    const tgt = ring[best];
    const dir = new THREE.Vector3(tgt.x - x, 0, tgt.z - z).normalize();
    towns.push({ c: new THREE.Vector3(x, (mn + mx) / 2, z), dir, size: towns.length === 0 ? 1 : 0.7, ringIdx: best, h: (mn + mx) / 2 });
  }
  // 3) connectors + streets
  for (const t of towns) {
    const tgt = ring[t.ringIdx];
    roads.push({ pts: resample([t.c.clone(), tgt.clone()], 8), kind: 'main', width: 8 });
    const L = 520 * t.size, side = new THREE.Vector3(-t.dir.z, 0, t.dir.x);
    roads.push({ pts: resample([t.c.clone().addScaledVector(t.dir, -L * 0.6), t.c.clone().addScaledVector(t.dir, L * 0.4)], 8), kind: 'street', width: 7 });
    const nCross = t.size > 0.9 ? 4 : 3;
    t.streets = [];
    for (let k = 0; k < nCross; k++) {
      const o = t.c.clone().addScaledVector(t.dir, -L * 0.5 + (k + 0.5) * (L * 0.9 / nCross));
      const cl = 200 * t.size + r() * 80;
      roads.push({ pts: resample([o.clone().addScaledVector(side, -cl), o.clone().addScaledVector(side, cl)], 8), kind: 'street', width: 6.5 });
    }
  }
  // 4) highway / causeway: follow low ground away from the ring road (bridges over water)
  const highways = [];
  if (isl) {
    const a = ring.reduce((b, p) => (p.x - p.z > b.x - b.z ? p : b), ring[0]); // NE side of the ring
    const tgt = new THREE.Vector3(5200 - 900, 0, -3800 + 700);
    const pts = []; for (let k = 0; k <= 60; k++) { const t = k / 60; pts.push(new THREE.Vector3(lerp(a.x, tgt.x, t) + Math.sin(t * 3) * 180, 0, lerp(a.z, tgt.z, t))); }
    highways.push(resample(new THREE.CatmullRomCurve3(pts).getSpacedPoints(300), 8));
  } else {
    for (const endIdx of [0, Math.floor(ring.length / 2), Math.floor(ring.length / 4), Math.floor(ring.length * 3 / 4)]) {
      if (highways.length >= (desert ? 3 : 2)) break;
      const start = ring[endIdx];
      let p = start.clone(), heading = Math.atan2(start.x - 140, -start.z) + Math.PI; // pointing away from centre
      heading = Math.atan2(start.x - 140, start.z) ; // direction outward (x,z)
      const pts = [p.clone()];
      let ang = Math.atan2(start.z, start.x - 140);
      for (let s = 0; s < 70; s++) {
        let bestA = ang, bestS = 1e12;
        for (let c = -3; c <= 3; c++) {
          const aa = ang + c * 0.12, q = p.clone().add(new THREE.Vector3(Math.cos(aa) * 130, 0, Math.sin(aa) * 130));
          const hh = H(q.x, q.z), score = Math.abs(hh - H(p.x, p.z)) * 3 + hh * 0.3 + Math.abs(c) * 4 + (Math.hypot(q.x, q.z) > 10200 ? 1e6 : 0);
          if (score < bestS) { bestS = score; bestA = aa; }
        }
        ang = bestA; p = p.clone().add(new THREE.Vector3(Math.cos(ang) * 130, 0, Math.sin(ang) * 130));
        if (Math.abs(p.x) > 10300 || Math.abs(p.z) > 10300) break;
        pts.push(p);
      }
      if (pts.length > 20) highways.push(resample(new THREE.CatmullRomCurve3(pts).getSpacedPoints(pts.length * 16), 8));
    }
  }
  for (const pts of highways) roads.push({ pts, kind: 'highway', width: 10 });
  // heights: smoothed along each road, bridges where crossing water
  for (const rd of roads) {
    const n = rd.pts.length;
    let hs = rd.pts.map((p) => H(p.x, p.z));
    rd.bridge = hs.map((h) => h < w.waterLevel + 0.8);
    // widen bridge spans a little so ramps start on land
    const br = rd.bridge.slice(); for (let i = 0; i < n; i++) if (rd.bridge[i]) for (let k = -4; k <= 4; k++) if (i + k >= 0 && i + k < n) br[i + k] = true; rd.bridge = br;
    hs = hs.map((h, i) => (rd.bridge[i] ? Math.max(h, w.waterLevel + 9) : h));
    for (let it = 0; it < 40; it++) hs = hs.map((h, i) => { const a = hs[rd.closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = hs[rd.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]; return (a + h * 2 + b) / 4; });
    rd.pts.forEach((p, i) => (p.y = hs[i]));
  }
  // 5) railway alongside the first highway (mountains + desert)
  let rail = null;
  if (!isl && highways[0]) {
    const hw = highways[0];
    const pts = hw.map((p, i) => { const a = hw[Math.max(0, i - 1)], b = hw[Math.min(hw.length - 1, i + 1)]; const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); return new THREE.Vector3(p.x - d.z * 40, p.y, p.z + d.x * 40); });
    rail = { pts: resample(pts, 6), width: 5 };
    let hs = rail.pts.map((p) => H(p.x, p.z)); const n = hs.length;
    rail.bridge = hs.map((h) => h < w.waterLevel + 0.8); hs = hs.map((h, i) => (rail.bridge[i] ? Math.max(h, w.waterLevel + 8) : h));
    for (let it = 0; it < 80; it++) hs = hs.map((h, i) => (hs[Math.max(0, i - 1)] + h * 2 + hs[Math.min(n - 1, i + 1)]) / 4);
    rail.pts.forEach((p, i) => (p.y = hs[i]));
  }
  // 6) farm fields (or pivot-irrigation circles in the desert)
  const fields = [];
  const roadNear = (x, z, d) => roads.some((rd) => rd.pts.some((p, i) => i % 3 === 0 && (p.x - x) ** 2 + (p.z - z) ** 2 < d * d));
  const palettes = desert ? [[0x6f8f3a, 0x5c7a2e], [0x8a9a48, 0x768a3c], [0xa48a52, 0x93794a]] : isl ? [[0x3d6e2a, 0x2e5c22], [0x6a8d3a, 0x587a30], [0x4b7a34, 0x3c6a2a]]
    : [[0xb8a24e, 0xa48f42], [0x6e9a3c, 0x5c8832], [0x7a5c3e, 0x6a4e34], [0x8fae4a, 0x7c9a40], [0xc9b860, 0xb2a252]];
  const anchors = towns.length ? towns.map((t) => t.c) : [new THREE.Vector3(140, 0, 0)];
  for (let tries = 0; tries < 2500 && fields.length < (isl ? 25 : 70); tries++) {
    const an = anchors[Math.floor(r() * anchors.length)];
    const x = an.x + (r() - 0.5) * 3600, z = an.z + (r() - 0.5) * 3600;
    if (Math.abs(x - 140) < 600 && Math.abs(z) < RWY_HALF + 400) continue;
    const pivot = desert && r() < 0.8;
    const sx = pivot ? 120 + r() * 160 : 70 + r() * 120, sz = pivot ? sx : 90 + r() * 160;
    const h = H(x, z); if (h < w.waterLevel + 2 || h > w.loc.snowline - 300) continue;
    let flat = true; for (const [ox, oz] of [[sx, sz], [-sx, sz], [sx, -sz], [-sx, -sz]]) if (Math.abs(H(x + ox, z + oz) - h) > (pivot ? 8 : 14)) flat = false;
    if (!flat) continue;
    if (fields.some((f) => Math.hypot(f.x - x, f.z - z) < Math.max(f.sx, f.sz) + Math.max(sx, sz) + 10)) continue;
    if (towns.some((t) => Math.hypot(t.c.x - x, t.c.z - z) < 450)) continue;
    if (roadNear(x, z, Math.max(sx, sz) * 0.7)) continue;
    const pal = palettes[Math.floor(r() * palettes.length)];
    fields.push({ x, z, sx, sz, ang: r() * Math.PI, pivot, c1: new THREE.Color(pal[0]), c2: new THREE.Color(pal[1]), stripe: 4 + r() * 6 });
  }
  return { roads, towns, fields, rail };
}

// evenly spaced points along a polyline
export function resample(pts, step, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0].clone()]; let acc = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i], L = a.distanceTo(b); if (L < 1e-6) continue;
    let t = step - acc;
    while (t <= L) { out.push(a.clone().lerp(b, t / L)); t += step; }
    acc = L - (t - step);
  }
  if (closed && out.length > 1 && out.at(-1).distanceTo(out[0]) < step * 0.5) out.pop();
  if (!closed && out.at(-1).distanceTo(src.at(-1)) > step * 0.3) out.push(src.at(-1).clone());
  return out;
}

// Flatten the coarse heightfield along roads / rail and under towns.
export function flattenGrid(w, net) {
  const { N, step, half, H } = w;
  const flat = (p, radius, target) => {
    const i0 = Math.floor((p.x + half) / step), j0 = Math.floor((p.z + half) / step), rr = Math.ceil(radius / step) + 1;
    for (let j = j0 - rr; j <= j0 + rr + 1; j++) for (let i = i0 - rr; i <= i0 + rr + 1; i++) {
      if (i < 0 || j < 0 || i > N || j > N) continue;
      const d = Math.hypot(-half + i * step - p.x, -half + j * step - p.z);
      const t = 1 - smoothstep(radius * 0.55, radius * 1.4, d);
      const k = j * (N + 1) + i; H[k] = lerp(H[k], target, t);
    }
  };
  for (const t of net.towns) flat(t.c, 420 * t.size, t.h);
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) rd.pts.forEach((p, i) => { if (!rd.bridge?.[i]) flat(p, Math.max(step * 0.9, rd.width * 2), p.y - 0.3); });
}

// Same idea for the hi-res bake heights (so normals show the road cuttings)
export function flattenHi(w, net, Hh, R) {
  const st = w.size / R, W = R + 1, half = w.half;
  const flat = (p, radius, target) => {
    const i0 = Math.floor((p.x + half) / st), j0 = Math.floor((p.z + half) / st), rr = Math.ceil(radius * 1.4 / st) + 1;
    for (let j = j0 - rr; j <= j0 + rr; j++) for (let i = i0 - rr; i <= i0 + rr; i++) {
      if (i < 0 || j < 0 || i > R || j > R) continue;
      const d = Math.hypot(-half + i * st - p.x, -half + j * st - p.z);
      const t = 1 - smoothstep(radius * 0.6, radius * 1.4, d);
      if (t > 0) { const k = j * W + i; Hh[k] = lerp(Hh[k], target, t); }
    }
  };
  for (const t of net.towns) flat(t.c, 420 * t.size, t.h);
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) rd.pts.forEach((p, i) => { if (!rd.bridge?.[i] && i % 2 === 0) flat(p, Math.max(st * 1.2, rd.width * 1.4), p.y - 0.3); });
}

// Paint fields / road verges into the baked albedo at texel (x,z). Returns a colour or null.
export function makePainter(w, net) {
  const cell = 300, grid = new Map();
  const add = (key, item) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(item); };
  for (const f of net.fields) {
    const R = Math.max(f.sx, f.sz) * 1.5;
    for (let gx = Math.floor((f.x - R) / cell); gx <= Math.floor((f.x + R) / cell); gx++) for (let gz = Math.floor((f.z - R) / cell); gz <= Math.floor((f.z + R) / cell); gz++) add(gx + ',' + gz, { f });
  }
  for (const rd of [...net.roads, ...(net.rail ? [net.rail] : [])]) rd.pts.forEach((p, i) => { if (i % 2 === 0 && !rd.bridge?.[i]) add(Math.floor(p.x / cell) + ',' + Math.floor(p.z / cell), { p, w: rd.width, rail: rd === net.rail }); });
  const tmp = new THREE.Color();
  return (x, z, c) => {
    const items = grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell)); if (!items) return;
    for (const it of items) {
      if (it.f) {
        const f = it.f, dx = x - f.x, dz = z - f.z;
        if (f.pivot) {
          const d = Math.hypot(dx, dz); if (d > f.sx) continue;
          const ring = Math.sin(d / f.stripe * 2) * 0.5 + 0.5;
          tmp.copy(f.c1).lerp(f.c2, ring * 0.6); c.lerp(tmp, 0.9 * smoothstep(f.sx, f.sx - 6, d));
        } else {
          const ca = Math.cos(f.ang), sa = Math.sin(f.ang), u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
          if (Math.abs(u) > f.sx || Math.abs(v) > f.sz) continue;
          const rows = Math.sin(u / f.stripe * Math.PI) * 0.5 + 0.5;
          tmp.copy(f.c1).lerp(f.c2, rows); c.lerp(tmp, 0.88);
          if (Math.abs(u) > f.sx - 3 || Math.abs(v) > f.sz - 3) c.multiplyScalar(0.8); // hedgerow edge
        }
      } else {
        const d = Math.hypot(x - it.p.x, z - it.p.z), half = it.w * 0.5;
        if (d < half + 4) c.lerp(tmp.set(it.rail ? 0x5a5048 : 0x6e6a60), (1 - smoothstep(half, half + 4, d)) * 0.8);
      }
    }
  };
}

// ---------------- meshes ----------------
function roadTexture(kind) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = kind === 'rail' ? '#5b5249' : '#3b3c3f'; g.fillRect(0, 0, 128, 256);
  const img = g.getImageData(0, 0, 128, 256); for (let i = 0; i < img.data.length; i += 4) { const k = (Math.random() - 0.5) * (kind === 'rail' ? 50 : 22); img.data[i] += k; img.data[i + 1] += k; img.data[i + 2] += k; } g.putImageData(img, 0, 0);
  if (kind === 'rail') {
    g.fillStyle = '#4a3a2c'; for (let y = 4; y < 256; y += 21) g.fillRect(16, y, 96, 9); // sleepers
  } else {
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(34, 0, 10, 256); g.fillRect(84, 0, 10, 256); // tyre wear
    g.fillStyle = '#d9d9d2';
    if (kind !== 'street') { g.fillRect(5, 0, 4, 256); g.fillRect(119, 0, 4, 256); }
    g.fillStyle = kind === 'highway' ? '#e8c547' : '#d9d9d2';
    if (kind === 'highway') { g.fillRect(60, 0, 3, 256); g.fillRect(65, 0, 3, 256); }
    else if (kind === 'main') g.fillRect(62, 0, 4, 140);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildRoadMeshes(w, net) {
  const group = new THREE.Group();
  const mats = {};
  const mat = (kind) => mats[kind] || (mats[kind] = new THREE.MeshStandardMaterial({ map: roadTexture(kind), roughness: kind === 'rail' ? 1 : 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
  const verge = new THREE.MeshStandardMaterial({ color: 0x4a4538, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 0.9, roughness: 0.35 });
  const bridgeGeos = [], railGeos = [];
  const ribbon = (rd, width, yOff, material, vScale, kind) => {
    const P = rd.pts, n = P.length, closed = !!rd.closed, pos = [], uv = [], idx = [];
    let dist = 0;
    for (let k = 0; k <= (closed ? n : n - 1); k++) {
      const i = k % n, p = P[i], a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(), rt = new THREE.Vector3(-d.z, 0, d.x);
      if (k > 0) dist += P[i].distanceTo(P[(i - 1 + n) % n]);
      const br = rd.bridge?.[i];
      for (const s of [-1, 1]) {
        const x = p.x + rt.x * width * 0.5 * s, z = p.z + rt.z * width * 0.5 * s;
        const y = br ? p.y + yOff : Math.max(w.sampleGrid(x, z), p.y - 1.5) + yOff;
        pos.push(x, y, z); uv.push(s < 0 ? 0 : 1, dist / vScale);
      }
      if (k > 0) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      if (br && kind && (k % 5 === 0)) { // bridge deck slab + pillar
        const deck = new THREE.BoxGeometry(width + 1.5, 1.2, 10).rotateY(Math.atan2(d.x, d.z)).translate(p.x, p.y + yOff - 0.65, p.z); bridgeGeos.push(deck);
        const gh = w.sampleGrid(p.x, p.z), ph = p.y - Math.min(gh, w.waterLevel - 3);
        if (k % 10 === 0 && ph > 2) bridgeGeos.push(new THREE.CylinderGeometry(0.9, 1.1, ph, 10).translate(p.x, p.y - ph / 2 - 1, p.z));
        for (const s of [-1, 1]) railGeos.push(new THREE.BoxGeometry(0.12, 0.9, 10.2).rotateY(Math.atan2(d.x, d.z)).translate(p.x + rt.x * (width / 2 + 0.6) * s, p.y + yOff + 0.45, p.z + rt.z * (width / 2 + 0.6) * s));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, material); m.receiveShadow = true; group.add(m);
  };
  for (const rd of net.roads) { ribbon(rd, rd.width + 3, 0.12, verge, 10); ribbon(rd, rd.width, 0.25, mat(rd.kind), 14, rd.kind); }
  if (net.rail) {
    const rl = net.rail;
    ribbon(rl, 4.6, 0.3, mat('rail'), 8, 'rail');
    // the two rails
    for (const s of [-0.72, 0.72]) {
      const P = rl.pts, pos = [], idx = [];
      P.forEach((p, i) => {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], d = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
        const x = p.x - d.z * s, z = p.z + d.x * s, y = rl.bridge[i] ? p.y + 0.5 : Math.max(w.sampleGrid(x, z), p.y - 1.5) + 0.5;
        pos.push(x - d.z * 0.05, y, z + d.x * 0.05, x + d.z * 0.05, y, z - d.x * 0.05);
        if (i > 0) { const o = (i - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      group.add(new THREE.Mesh(g, steel));
    }
  }
  // street lamps (glow at night)
  const lamps = [];
  for (const rd of net.roads) { if (rd.kind === 'highway') continue; const every = rd.kind === 'street' ? 4 : 6; rd.pts.forEach((p, i) => { if (i % every) return; const a = rd.pts[Math.max(0, i - 1)], b = rd.pts[Math.min(rd.pts.length - 1, i + 1)], d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(); const s = (i / every) % 2 ? 1 : -1; const x = p.x - d.z * (rd.width / 2 + 1.5) * s, z = p.z + d.x * (rd.width / 2 + 1.5) * s; lamps.push(x, (rd.bridge?.[i] ? p.y : w.sampleGrid(x, z)) + 7, z); }); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));
  const lampMat = new THREE.PointsMaterial({ size: 3, color: new THREE.Color(3.2, 2.2, 1.1), map: glow(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  group.add(new THREE.Points(lg, lampMat)); group.userData.lampMat = lampMat;
  if (bridgeGeos.length) { const m = new THREE.Mesh(mergeAll(bridgeGeos), concrete); m.castShadow = m.receiveShadow = true; group.add(m); }
  if (railGeos.length) group.add(new THREE.Mesh(mergeAll(railGeos), steel));
  return group;
}

function mergeAll(geos) {
  const ni = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of ni) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const g of ni) { g.computeVertexNormals(); pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// Lane paths for traffic: closed roads -> two loops; open roads -> out on one lane, back on the other.
export function lanePaths(net) {
  const paths = [];
  const offset = (pts, off, closed) => pts.map((p, i) => {
    const n = pts.length, a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
    return new THREE.Vector3(p.x - d.z * off, p.y, p.z + d.x * off);
  });
  for (const rd of net.roads) {
    const lane = rd.width * 0.25, speed = rd.kind === 'highway' ? 27 : rd.kind === 'main' ? 20 : 11;
    if (rd.closed) {
      paths.push({ pts: offset(rd.pts, lane, true), speed, kind: rd.kind, bridge: rd.bridge });
      const rev = rd.pts.slice().reverse(); paths.push({ pts: offset(rev, lane, true), speed, kind: rd.kind, bridge: rd.bridge.slice().reverse() });
    } else {
      const fwd = offset(rd.pts, lane, false), back = offset(rd.pts.slice().reverse(), lane, false);
      paths.push({ pts: [...fwd, ...back], speed, kind: rd.kind, bridge: [...rd.bridge, ...rd.bridge.slice().reverse()] });
    }
  }
  for (const p of paths) {
    p.len = []; let L = 0; p.pts.forEach((q, i) => { if (i) L += q.distanceTo(p.pts[i - 1]); p.len.push(L); }); p.total = L + p.pts.at(-1).distanceTo(p.pts[0]);
  }
  return paths;
}
