// The ribbon mesher (src/layout/ribbon.js, a test of "the road carries its own sides", #294) against today's
// (src/layout/mesh.js), on baked chunks as committed. No World: the files and the hi grid on a stand-in World, as
// tools/test/layoutcheck.js does.
//   node --import ./tools/test/node/setup.mjs tools/test/ribboncmp.mjs scan <place>          candidate chunks
//   node --import ./tools/test/node/setup.mjs tools/test/ribboncmp.mjs cmp place:ix,iz ...   the comparison
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeLayout, KIND } from '../../src/layout/format.js';
import { meshChunk, latticeOf, physIndex, physAt } from '../../src/layout/mesh.js';
import { meshRibbon } from '../../src/layout/ribbon.js';
import { latticeHeights, latticeGround, makeRules, KERB, PAVE_RAMP } from '../../src/layout/rules.js';
import { markCheck } from '../bake/markcheck.mjs';
import { World, LOCATIONS } from '../../src/world.js';
import { airportGate } from '../../src/airportKit.js';

const SHORE = new Set(['islands']);
function hiGrid(id) { // (layoutcheck.js's)
  const m = JSON.parse(readFileSync(`assets/real/${id}/meta.json`)), { x0, z0, size, n } = m.hi, b = gunzipSync(readFileSync(`assets/real/${id}/hi.bin.gz`)), u = new Uint16Array(b.buffer, b.byteOffset, n * n), H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) { let v = 0; for (let i = 0; i < n; i++) { v = i ? (v + u[j * n + i]) & 65535 : u[j * n]; H[j * n + i] = v / 8 - 200; } }
  const sp = size / (n - 1), loc = LOCATIONS[id], height = (x, z) => { const fx = Math.max(0, Math.min(n - 1.0001, (x - x0) / sp)), fz = Math.max(0, Math.min(n - 1.0001, (z - z0) / sp)), i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * n + i; return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v; };
  const w = { loc, gate: airportGate(loc), stuntPlan: null, waterLevel: loc.water, height, rawHeight: World.prototype.rawHeight, shoreSnap: World.prototype.shoreSnap };
  return { x0, z0, n, sp, H, water: m.water, w, grid: { x0, z0, sp, wl: SHORE.has(id) ? m.water : -Infinity } };
}
const places = new Map(), placeOf = (p) => { if (!places.has(p)) { const G = hiGrid(p), idx = JSON.parse(readFileSync(`assets/real/${p}/layout/index.json`, 'utf8')); places.set(p, { G, idx, files: new Map(idx.chunks.map((e) => [e.ix + ',' + e.iz, e.file])) }); } return places.get(p); };
export function chunk(place, k) {
  const P = placeOf(place), f = P.files.get(k); if (!f) return null; const buf = gunzipSync(readFileSync(`assets/real/${place}/layout/${f}`));
  const L = decodeLayout(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), grid = P.G.grid, lat = latticeOf(L, grid), G = latticeHeights(P.G.w, grid, lat);
  return { L, grid, G, lat, place, k };
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'scan') {
  // per chunk: the deepest cutting and highest fill of a street's centre line against the natural ground, the steepest
  // junction plane, the sharpest bend on a slope, the nearest road point to the water
  const place = args[0], P = placeOf(place), out = [];
  for (const e of P.idx.chunks) { const c = chunk(place, e.ix + ',' + e.iz), { L } = c, g = latticeGround(c.grid, c.lat, c.G);
    let cut = 0, fill = 0, jslope = 0, bend = 0, wet = Infinity, nj = 0, off = 0; const inC = (x, z) => x > L.x0 && z > L.z0 && x < L.x0 + L.size && z < L.z0 + L.size;
    for (const r of L.net.runs) { if (r.off) { off++; continue; } if (r.minor) continue; for (let s = 0; s < r.h.length; s++) { const x = r.pts[s * 2], z = r.pts[s * 2 + 1]; if (!inC(x, z)) continue; const d = r.h[s] - g(x, z); cut = Math.max(cut, -d); fill = Math.max(fill, d); if (c.grid.wl > -1e9) wet = Math.min(wet, g(x, z) - c.grid.wl);
        if (s > 0 && s + 1 < r.h.length) { const ax = x - r.pts[s * 2 - 2], az = z - r.pts[s * 2 - 1], bx = r.pts[s * 2 + 2] - x, bz = r.pts[s * 2 + 3] - z, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz); if (la > 1 && lb > 1) { const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / la / lb))), sl = Math.hypot(g(x + 4, z) - g(x - 4, z), g(x, z + 4) - g(x, z - 4)) / 8; bend = Math.max(bend, turn * Math.min(1, sl * 3)); } } } }
    for (const j of L.net.junctions) if (inC(j.x, j.z)) { nj++; jslope = Math.max(jslope, Math.hypot(j.gx, j.gz)); }
    out.push({ k: e.ix + ',' + e.iz, cut: +cut.toFixed(1), fill: +fill.toFixed(1), jslope: +jslope.toFixed(3), nj, bend: +bend.toFixed(2), wet: +wet.toFixed(1), off, runs: L.net.runs.length, city: L.city }); }
  if (args[1]) { console.log(JSON.stringify(out.filter((o) => args[1].split(';').includes(o.k)))); process.exit(0); }
  const top = (key, n = 6, f = () => true) => out.filter(f).sort((a, b) => b[key] - a[key]).slice(0, n);
  console.log(JSON.stringify({ cut: top('cut', 8, (o) => !o.off), fill: top('fill', 8, (o) => !o.off), jslope: top('jslope', 8, (o) => !o.off && o.nj >= 2), bend: top('bend', 8, (o) => !o.off), wet: out.filter((o) => !o.off && o.wet < 3).sort((a, b) => a.wet - b.wet).slice(0, 8) }, null, 0).replace(/\],/g, '],\n'));
}

// every triangle under a point: [y, physics y, kind, normal]
function surfIndex(L, m) {
  const C = 2, nc = Math.ceil(L.size / C), cells = Array.from({ length: nc * nc }, () => []), P = m.pos, I = m.idx, nt = m.tk.length, N = new Float32Array(nt * 3);
  for (let q = 0; q < nt; q++) { const a = I[q * 3], b = I[q * 3 + 1], c = I[q * 3 + 2]; const x0 = Math.min(P[a * 3], P[b * 3], P[c * 3]), x1 = Math.max(P[a * 3], P[b * 3], P[c * 3]), z0 = Math.min(P[a * 3 + 2], P[b * 3 + 2], P[c * 3 + 2]), z1 = Math.max(P[a * 3 + 2], P[b * 3 + 2], P[c * 3 + 2]);
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2]; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; N[q * 3] = nx / l; N[q * 3 + 1] = ny / l; N[q * 3 + 2] = nz / l;
    for (let i = Math.max(0, Math.floor((x0 - L.x0) / C)); i <= Math.min(nc - 1, Math.floor((x1 - L.x0) / C)); i++) for (let j = Math.max(0, Math.floor((z0 - L.z0) / C)); j <= Math.min(nc - 1, Math.floor((z1 - L.z0) / C)); j++) cells[j * nc + i].push(q); }
  return (x, z) => { const i = Math.floor((x - L.x0) / C), j = Math.floor((z - L.z0) / C), out = []; if (i < 0 || j < 0 || i >= nc || j >= nc) return out;
    for (const q of cells[j * nc + i]) { if (m.tk[q] === KIND.lip) continue; const a = I[q * 3], b = I[q * 3 + 1], c = I[q * 3 + 2], ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2], d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (!d) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2; if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
      out.push([l1 * P[a * 3 + 1] + l2 * P[b * 3 + 1] + l3 * P[c * 3 + 1], l1 * m.phys[a] + l2 * m.phys[b] + l3 * m.phys[c], m.tk[q], N.subarray(q * 3, q * 3 + 3), m.parts ? m.parts[q] : m.tk[q] === KIND.ground ? 0 : 1]); }
    return out; };
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1], pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r3 = (v) => (v == null ? null : +(+v).toFixed(3));
const KIND_N = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
function measure(c, m, which, R) {
  const { L } = c, at = surfIndex(L, m), o = { tris: m.tk.length };
  // holes (0.5 m), the ground over a road's top, a face over a road's top
  let holes = 0, gOver = 0, fOver = 0, holeAt = null, gAt = null, fAt = null;
  for (let x = L.x0 + 0.25; x < L.x0 + L.size; x += 0.5) for (let z = L.z0 + 0.25; z < L.z0 + L.size; z += 0.5) { const h = at(x, z); if (!h.length) { holes++; holeAt ??= [+x.toFixed(2), +z.toFixed(2)]; continue; }
    let road = -Infinity, gr = -Infinity, fa = -Infinity; for (const [y, , k] of h) { if (k >= KIND.tarmac) road = Math.max(road, y); else if (k === KIND.ground) gr = Math.max(gr, y); else fa = Math.max(fa, y); }
    if (road > -Infinity) { if (gr - road > gOver) { gOver = gr - road; gAt = [+x.toFixed(1), +z.toFixed(1)]; } if (fa - road > fOver) { fOver = fa - road; fAt = [+x.toFixed(1), +z.toFixed(1)]; } } }
  Object.assign(o, { holes, holeAt, groundOverRoad: r3(gOver), groundOverRoadAt: gAt, faceOverRoad: r3(fOver), faceOverRoadAt: fAt });
  // (1 m) a fin: a face (bank, apron, tuck) on top, over both the rules' surface and the kept ground there; the seams'
  // angles: a bank face or tuck against the kept ground where they cross (within 0.3 m); an apron coplanar over kept ground
  let fin = 0, finAt = null, overlap = 0; const ang = [];
  if (which === 'ribbon') for (let x = L.x0 + 0.5; x < L.x0 + L.size; x += 1) for (let z = L.z0 + 0.5; z < L.z0 + L.size; z += 1) { const h = at(x, z); if (!h.length) continue; let top = h[0]; for (const e of h) if (e[0] > top[0]) top = e;
    const gs = h.filter((e) => e[4] === 0), fs = h.filter((e) => e[4] >= 2);
    if (top[4] >= 2 && R.region(x, z) === KIND.ground) { const ref = Math.max(R.ground(x, z), ...gs.map((e) => e[0])), d = top[0] - ref; if (d > fin) { fin = d; finAt = [+x.toFixed(1), +z.toFixed(1), ['', '', 'bank', 'apron', 'tuck'][top[4]]]; } }
    for (const f of fs) for (const gg of gs) { const dy = f[0] - gg[0], cs = Math.abs(f[3][0] * gg[3][0] + f[3][1] * gg[3][1] + f[3][2] * gg[3][2]); if (f[4] !== 3 && Math.abs(dy) < 0.3) ang.push(Math.acos(Math.min(1, cs)) * 180 / Math.PI); if (f[4] === 3 && Math.abs(dy) < 0.05) overlap++; } }
  if (which === 'ribbon') Object.assign(o, { fin: r3(fin), finAt, seamMin: r3(ang.length ? Math.min(...ang) : null), seamP5: r3(pct(ang, 0.05)), seamP50: r3(pct(ang, 0.5)), seamN: ang.length, apronOverGroundM2: overlap });
  const mk = markCheck(L, m, true); Object.assign(o, { markDrift: r3(mk.drift), markSamples: mk.samples, markLost: mk.lost, markWorst: mk.worst, zebras: `${mk.whole}/${mk.mouths}` });
  return { o, at };
}
if (mode === 'cmp') {
  const rows = [];
  for (const a of args) { const [place, k] = a.split(':'), c = chunk(place, k); if (!c) { console.log('no chunk', a); continue; }
    const t = { today: [], ribbon: [] }; let mt, mr;
    for (let i = 0; i < 6; i++) { let s = performance.now(); mt = meshChunk(c.L, c.grid, c.G, 'fine'); if (i) t.today.push(performance.now() - s); s = performance.now(); mr = meshRibbon(c.L, c.grid, c.G, c.lat); if (i) t.ribbon.push(performance.now() - s); }
    const R = makeRules(c.L.net, latticeGround(c.grid, c.lat, c.G), !!c.L.city, c.grid.wl);
    const A = measure(c, mt, 'today', R), B = measure(c, mr, 'ribbon', R);
    // physics at 10k points: today's (physAt) and the ribbon's top surface, each against the rules' (the kerb a ramp)
    const ix = physIndex(c.L, mt); let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff), dd = [], et = [], er = []; let worst = null, worstR = null, nan = 0;
    const rule = (x, z) => { const k = R.region(x, z); if (k === KIND.ground || k === KIND.lip) return R.ground(x, z); const y = R.drawn(x, z, k); if (k !== KIND.pave) return y; const n = R.nearest(x, z, (r) => !r.minor); return y - KERB * (1 - Math.min(1, Math.max(0, n ? n.d : 9) / PAVE_RAMP)); };
    for (let i = 0; i < 10000; i++) { const x = c.L.x0 + 0.01 + rnd() * (c.L.size - 0.02), z = c.L.z0 + 0.01 + rnd() * (c.L.size - 0.02), p0 = physAt(c.L, mt, ix, x, z), h = B.at(x, z); if (!h.length || p0 !== p0) { nan++; continue; }
      let top = h[0]; for (const e of h) if (e[1] > top[1]) top = e; const d = top[1] - p0, w = rule(x, z); dd.push(Math.abs(d)); et.push(Math.abs(p0 - w)); er.push(Math.abs(top[1] - w));
      if (!worst || Math.abs(d) > Math.abs(worst[2])) worst = [+x.toFixed(1), +z.toFixed(1), r3(d), KIND_N[top[2]], KIND_N[R.region(x, z)]];
      if (!worstR || Math.abs(top[1] - w) > Math.abs(worstR[2])) worstR = [+x.toFixed(1), +z.toFixed(1), r3(top[1] - w), KIND_N[top[2]], ['grid', 'ribbon', 'bank', 'apron', 'tuck'][top[4]]]; }
    const st = (a) => ({ p50: r3(pct(a, 0.5)), p99: r3(pct(a, 0.99)), max: r3(Math.max(...a)), over5cm: a.filter((v) => v > 0.05).length });
    const phys = { diff: { ...st(dd), worst }, todayVsRules: st(et), ribbonVsRules: { ...st(er), worst: worstR }, missing: nan };
    rows.push({ chunk: a, today: { ms: r3(med(t.today)), ...A.o }, ribbon: { ms: r3(med(t.ribbon)), ...B.o, stats: mr.stats }, phys });
    console.error(JSON.stringify(rows[rows.length - 1])); }
  console.log(JSON.stringify(rows));
}
