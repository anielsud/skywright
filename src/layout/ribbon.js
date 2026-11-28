// A TEST of another runtime design for the baked layout (#294), behind ?layout=1&mesher=ribbon (the fine level only):
// "the road carries its own sides". No polygon union, no constrained triangulation:
//   ground  a plain GRID-metre grid of the ground without the banks (rules.js unbanked: a city's lots, else the natural
//           ground); a cell is dropped where its ground would stand above the road or its banks (a cheap mask: the
//           roads' footprints rasterised, the rules' heights at the cell's corners)
//   roads   a ribbon along each road's stations (carriageway, kerb strip, pavement or verge; a way off the network
//           alone), a round cap at each end; a pavement or verge triangle over another street's carriageway is dropped
//   sides   at each outer edge, per side and station, a face out along the rules' bank (rules.js ground: a fill down, a
//           cutting up) to where it meets the unbanked ground (the embankment line), then an apron on that ground over
//           the dropped cells, then a tuck under the kept ground. Where faces meet the grid the depth buffer draws the line
// Physics: the top surface (physAt with m.top: the highest triangle at a point); the kerb ramps as today's.
// Markings: the ribbon's own along / across coordinates. Same output as mesh.js meshChunk (runtime.js draws it as is).
import { KIND } from './format.js';
import { makeRules, latticeGround, KERB, KERB_W, PAVE_RAMP, BANK_MAX, JBLEND, vergeW, painted, zebra } from './rules.js';

const GRID = 4, OVER = 2, STEP = 6, NEAR = 2, M_PAVED = 0.1, M_CUT = 0.02, CAP = 8, TUCK = [0.75, 0.5], MARCH = 0.5;

export function meshRibbon(L, grid, G, lat) {
  const t0 = performance.now(), g = latticeGround(grid, lat, G), R = makeRules(L.net, g, !!L.city, grid.wl ?? -Infinity), runs = L.net.runs, JN = L.net.junctions;
  const X0 = L.x0, Z0 = L.z0, S = L.size, NC = Math.round(S / GRID), NV = NC + 1;
  // ---- triangles, unindexed: position, physics height, kind; the streets' (tarmac, kerb, pavement, gravel) also into rib
  const P = [], PY = [], TK = [], PART = [], rib = { pos: [], road: [], lane: [], kind: [], id: [] };
  const inC = (x, z) => x >= X0 && z >= Z0 && x <= X0 + S && z <= Z0 + S;
  // a triangle (3 corners [x, y, z, py, ...attrs]) clipped to the chunk; attrs (if any): the rib's road (4) for kind k of road ri
  const clipTri = (V) => { let poly = V; for (const [ax, sg, c] of [[0, 1, X0], [0, -1, X0 + S], [2, 1, Z0], [2, -1, Z0 + S]]) { const out = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], da = sg * (a[ax] - c), db = sg * (b[ax] - c); if (da >= 0) out.push(a); if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(a.map((v, q) => v + (b[q] - v) * t)); } } poly = out; if (poly.length < 3) return []; }
    const tris = []; for (let i = 1; i + 1 < poly.length; i++) tris.push([poly[0], poly[i], poly[i + 1]]); return tris; };
  let part = 1; const emit = (V, k, ri = -1, lane = 0) => { const all = V.every((v) => v[0] >= X0 && v[0] <= X0 + S && v[2] >= Z0 && v[2] <= Z0 + S) ? [V] : clipTri(V);
    for (const T of all) { let [a, b, c] = T; const ar = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]); if (Math.abs(ar) < 1e-8) continue; if (ar > 0) { const s = b; b = c; c = s; } // (wound to face up, as mesh.js)
      for (const v of [a, b, c]) { P.push(v[0], v[1], v[2]); PY.push(v[3]); } TK.push(k); PART.push(k === KIND.ground ? 0 : k === KIND.bank ? part : 1);
      if (ri >= 0) for (const v of [a, b, c]) { rib.pos.push(v[0], v[1], v[2]); rib.road.push(v[4], v[5], v[6], v[7]); rib.lane.push(lane); rib.kind.push(k); rib.id.push(ri); } } };
  // ---- the mask: which cells' ground is dropped
  const gv = new Float64Array(NV * NV); for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) gv[j * NV + i] = R.unbanked(X0 + i * GRID, Z0 + j * GRID);
  const foot = new Uint8Array(NC * NC), reach = 2.83 + 0.05; // (a cell whose middle is within a road's widest reach plus half its diagonal)
  const footSeg = (ax, az, bx, bz, w) => { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, W = w + reach;
    for (let j = Math.max(0, Math.floor((Math.min(az, bz) - W - Z0) / GRID)); j <= Math.min(NC - 1, Math.floor((Math.max(az, bz) + W - Z0) / GRID)); j++) for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - W - X0) / GRID)); i <= Math.min(NC - 1, Math.floor((Math.max(ax, bx) + W - X0) / GRID)); i++) {
      const x = X0 + (i + 0.5) * GRID, z = Z0 + (j + 0.5) * GRID, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= W) foot[j * NC + i] = 1; } };
  const widest = (r) => r.hw + (r.minor ? 0 : r.pave || vergeW(r));
  for (const r of runs) { if (r.off) continue; for (let s = 0; s + 1 < r.h.length; s++) footSeg(r.pts[s * 2], r.pts[s * 2 + 1], r.pts[s * 2 + 2], r.pts[s * 2 + 3], widest(r)); }
  for (const a of L.areas) { const ring = a.ring.map(([x, z]) => [x / 100, z / 100]); for (let q = 0; q < ring.length; q++) { const [ax, az] = ring[q], [bx, bz] = ring[(q + 1) % ring.length]; footSeg(ax, az, bx, bz, 0); }
    for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) { if (foot[j * NC + i]) continue; const x = X0 + (i + 0.5) * GRID, z = Z0 + (j + 0.5) * GRID; let c = false; for (let q = 0, n = ring.length; q < n; q++) { const [ax, az] = ring[q], [bx, bz] = ring[(q + 1) % n]; if ((az > z) !== (bz > z) && x < ax + (bx - ax) * (z - az) / (bz - az)) c = !c; } if (c) foot[j * NC + i] = 1; } }
  // (the surface the rules want at a grid point: the paved region's drawn height, else the banks')
  const want = new Float64Array(NV * NV), paved = new Uint8Array(NV * NV), nearRoad = new Uint8Array(NV * NV);
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) if (foot[j * NC + i]) for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) nearRoad[(j + b) * NV + i + a] = 1;
  for (let k = 0; k < NV * NV; k++) { if (!nearRoad[k]) continue; const x = X0 + (k % NV) * GRID, z = Z0 + Math.floor(k / NV) * GRID, kind = R.region(x, z);
    if (kind !== KIND.ground && kind !== KIND.lip) { paved[k] = 1; want[k] = R.drawn(x, z, kind); } else want[k] = R.ground(x, z); }
  const drop = new Uint8Array(NC * NC); let dropped = 0;
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) { let d = false; for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const k = (j + b) * NV + i + a; if (foot[j * NC + i] && (gv[k] > want[k] + M_CUT || gv[k] > want[k] - M_PAVED)) d = true; } if (d) { drop[j * NC + i] = 1; dropped++; } }
  // the first kept cell along a ray from (x, z) (u, w unit) past distance d0: the distance to its edge (dmax if none)
  const keptAt = (x, z, u, w, d0, dmax) => { let d = d0; for (let it = 0; it < 64 && d < dmax; it++) { const px = x + u * d, pz = z + w * d, i = Math.floor((px - X0) / GRID), j = Math.floor((pz - Z0) / GRID); if (i < 0 || j < 0 || i >= NC || j >= NC || !drop[j * NC + i]) return d;
      const tx = u > 1e-9 ? (X0 + (i + 1) * GRID - px) / u : u < -1e-9 ? (X0 + i * GRID - px) / u : Infinity, tz = w > 1e-9 ? (Z0 + (j + 1) * GRID - pz) / w : w < -1e-9 ? (Z0 + j * GRID - pz) / w : Infinity; d += Math.min(tx, tz) + 1e-4; } return Math.min(d, dmax); };
  // ---- the roads
  const minorKind = (r) => (r.surf === 2 || r.kind === 'track' ? KIND.gravel : r.surf === 1 || r.kind === 'ped' ? KIND.pavers : KIND.alley);
  const mouthsOf = (ri) => { const M = [], r = runs[ri]; for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-3) continue; const ux = dx / l, uz = dz / l;
    for (const J of JN) { const fx = ax - J.x, fz = az - J.z; if (Math.abs(fx) > l + J.r || Math.abs(fz) > l + J.r) continue; const b = fx * ux + fz * uz, disc = b * b - (fx * fx + fz * fz - J.r * J.r); if (disc <= 0) continue; for (const sg of [-1, 1]) { const t = -b + sg * Math.sqrt(disc); if (t >= 0 && t < l) M.push([r.s[s] + t, sg]); } } } return M; };
  const nearJ = (x, z) => JN.some((J) => Math.hypot(x - J.x, z - J.z) < J.r + JBLEND + 2);
  let faceN = 0, faceCut = 0, faceFill = 0, tallFill = 0, tallCut = 0, wall = 0;
  // a face out from an outer edge point E (x, y, z, py) along (ux, uz): the bank (the rules' ground) to where it meets the
  // unbanked ground or another road; the apron on the unbanked ground over the dropped cells; the tuck under the kept one
  const face = (E, ux, uz) => { const x0 = E[0], z0 = E[2], yE = E[1], r0 = R.region(x0 + ux * 0.05, z0 + uz * 0.05); if (r0 !== KIND.ground && r0 !== KIND.verge) return { prof: [E, E, E, E, E, E] }; // (its edge on another road: none there; the quads beside close on it)
    const free = (d) => R.region(x0 + ux * d, z0 + uz * d) === KIND.ground;
    let d = 0, stopped = false; for (; d <= BANK_MAX + 1; d += MARCH) { const x = x0 + ux * d, z = z0 + uz * d; if (d > 0 && !free(d)) { stopped = true; d = Math.max(0, d - MARCH); break; } if (Math.abs(R.ground(x, z) - R.unbanked(x, z)) < 0.01) break; }
    const xb = x0 + ux * d, zb = z0 + uz * d, yB = d > 0 ? R.ground(xb, zb) : yE, rise = yB - yE, B = [xb, yB, zb, yB]; if (d > BANK_MAX) wall++;
    if (Math.abs(rise) > 0.05) { faceN++; if (rise > 0) { faceCut++; tallCut = Math.max(tallCut, rise); } else { faceFill++; tallFill = Math.max(tallFill, -rise); } }
    if (stopped) return { prof: [E, B, B, B, B, B], cut: rise > 0 ? [E, B] : null }; // (another road: its surface goes on from there)
    return { E, B, d, x0, z0, ux, uz, free, cut: rise > 0 ? [E, B] : null }; };
  const finish = (f) => { if (f.prof) return f.prof; const { E, B, d, x0, z0, ux, uz, free } = f;
    let dk = Math.min(keptAt(x0, z0, ux, uz, d, d + 12) + OVER, d + 12), hit = false; for (let t = d + MARCH; t < dk; t += MARCH) if (!free(t)) { dk = t - MARCH / 2; hit = true; break; }
    const ap = [1 / 3, 2 / 3, 1].map((f) => { const dd = d + (dk - d) * f, x = x0 + ux * dd, z = z0 + uz * dd, y = R.unbanked(x, z); return [x, y, z, y]; });
    if (hit) return [E, B, ...ap, ap[2]];
    const xt = x0 + ux * (dk + TUCK[0]), zt = z0 + uz * (dk + TUCK[0]), yt = R.unbanked(xt, zt) - TUCK[1];
    return [E, B, ...ap, [xt, yt, zt, yt]]; };
  const jobs = [], quads2 = (F, flip) => { for (let q = 0; q + 1 < F.length; q++) { const A = F[q], B = F[q + 1]; if (!A || !B) continue; for (let p = 0; p + 1 < A.length; p++) { const [a, b, c, dd] = flip ? [A[p], B[p], B[p + 1], A[p + 1]] : [A[p], A[p + 1], B[p + 1], B[p]];
      const cx = (a[0] + c[0]) / 2, cz = (a[2] + c[2]) / 2; if (Math.abs(cx - X0 - S / 2) > S / 2 + 6 || Math.abs(cz - Z0 - S / 2) > S / 2 + 6) continue; part = p === 0 ? 2 : p < 4 ? 3 : 4; emit([a, b, c], KIND.bank); emit([a, c, dd], KIND.bank); } } };
  runs.forEach((r, ri) => { if (r.off) return; const n = r.h.length; if (n < 2) return;
    // the across profile: [offset, kind, physics offset below the drawn height]
    const prof = []; if (r.minor) prof.push([-r.hw, minorKind(r)], [0, minorKind(r)], [r.hw, minorKind(r)]);
    else { const pw = r.pave, vw = pw ? 0 : vergeW(r), side = [];
      if (pw) { const ramp = Math.min(pw, PAVE_RAMP); side.push([r.hw, KIND.tarmac, 0], [r.hw + KERB_W, KIND.pave, KERB * (1 - Math.min(1, KERB_W / PAVE_RAMP))]); if (ramp > KERB_W + 0.05) side.push([r.hw + ramp, KIND.pave, 0]); if (pw > ramp + 0.05) side.push([r.hw + pw, KIND.pave, 0]); }
      else { side.push([r.hw, KIND.tarmac, 0]); if (vw) side.push([r.hw + vw, KIND.verge, 0]); }
      prof.push(...side.slice().reverse().map(([o, k, d]) => [-o, k, d]), [-r.hw / 2, KIND.tarmac, 0], [0, KIND.tarmac, 0], [r.hw / 2, KIND.tarmac, 0], ...side); }
    // the band between two profile lines: its kind (tarmac between tarmac lines; kerb from the carriageway's edge to the kerb's top; else the outer line's)
    const band = (a, b) => { const ka = prof[a][1], kb = prof[b][1]; if (ka === KIND.tarmac && kb === KIND.tarmac) return KIND.tarmac; if (ka === KIND.tarmac || kb === KIND.tarmac) return kb === KIND.pave || ka === KIND.pave ? KIND.kerb : kb === KIND.tarmac ? ka : kb; return Math.abs(prof[a][0]) > Math.abs(prof[b][0]) ? ka : kb; };
    // the stations: the road's own, more between (every STEP m, NEAR near a junction); each with its across direction
    // (a bend's bisector, offsets stretched 1/cos so each segment's edge stays parallel) and its segment
    const st = []; const D = []; for (let s = 0; s + 1 < n; s++) { const dx = r.pts[s * 2 + 2] - r.pts[s * 2], dz = r.pts[s * 2 + 3] - r.pts[s * 2 + 1], l = Math.hypot(dx, dz); D.push(l < 1e-3 ? null : [dx / l, dz / l, l]); }
    for (let s = 0; s + 1 < n; s++) { if (!D[s]) continue; const [ux, uz, l] = D[s], ax = r.pts[s * 2], az = r.pts[s * 2 + 1];
      let pv = null; for (let k = s - 1; k >= 0; k--) if (D[k]) { pv = D[k]; break; }
      let bx = -uz, bz = ux, ch = 1; if (pv) { const mx = pv[0] + ux, mz = pv[1] + uz, ml = Math.hypot(mx, mz); if (ml > 1e-3) { bx = -mz / ml; bz = mx / ml; ch = Math.max(0.5, bx * -uz + bz * ux); } }
      st.push({ x: ax, z: az, nx: bx, nz: bz, ch, s, u: r.s[s] });
      for (let t = 0; t < l;) { const x = ax + ux * t, z = az + uz * t, stp = nearJ(x, z) ? NEAR : STEP; t += stp; if (t >= l - 0.5) break; st.push({ x: ax + ux * t, z: az + uz * t, nx: -uz, nz: ux, ch: 1, s, u: r.s[s] + t }); } }
    { let s = n - 2; while (s >= 0 && !D[s]) s--; if (s < 0) return; st.push({ x: r.pts[(n - 1) * 2], z: r.pts[(n - 1) * 2 + 1], nx: -D[s][1], nz: D[s][0], ch: 1, s, u: r.s[n - 1] }); }
    // keep the stations near the chunk (a road's stored stretch reaches NET_PAD past it)
    const near = (q) => q.x > X0 - 40 && q.z > Z0 - 40 && q.x < X0 + S + 40 && q.z < Z0 + S + 40;
    const M = r.minor ? [] : mouthsOf(ri), lane = Math.min(15, r.lanes) + (r.oneway ? 16 : 0) + (painted(r, L.city) ? 32 : 0) + (zebra(r, L.city) ? 64 : 0);
    const dj = (u) => { let bd = Infinity, v = 99; for (const [um, sg] of M) if (Math.abs(u - um) < bd) { bd = Math.abs(u - um); v = sg * (u - um); } return v; };
    const ribK = (k) => k === KIND.tarmac || k === KIND.kerb || k === KIND.pave || k === KIND.gravel;
    // each station's profile points [x, y, z, py] (the heights from the rules, as mesh.js gives them)
    const pts = st.map((q) => near(q) ? prof.map(([o, k, dp]) => { const x = q.x + q.nx * o / q.ch, z = q.z + q.nz * o / q.ch, y = R.drawn(x, z, k); return [x, y, z, y - (dp || 0)]; }) : null);
    // a corner's rib attributes on segment s's line
    const attrs = (v, s) => { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], [ux, uz] = D[s], u = r.s[s] + (v[0] - ax) * ux + (v[2] - az) * uz, a = ux * (v[2] - az) - uz * (v[0] - ax); return [...v, u, a, r.minor ? 1e4 : r.hw, r.minor ? 99 : dj(u)]; };
    const quadOK = (k, cx, cz) => { if (k === KIND.tarmac) return true; const reg = R.region(cx, cz); return k === KIND.verge ? reg === KIND.verge || reg === KIND.ground : (k === KIND.pave || k === KIND.kerb) ? reg !== KIND.tarmac : reg !== KIND.tarmac && reg !== KIND.pave; };
    const tri = (a, b, c, k, s) => { const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3; if (!inC(cx, cz) && !(Math.abs(cx - X0 - S / 2) < S / 2 + 6 && Math.abs(cz - Z0 - S / 2) < S / 2 + 6)) return; if (!quadOK(k, cx, cz)) return;
      if (ribK(k)) emit([attrs(a, s), attrs(b, s), attrs(c, s)], k, ri, lane); else emit([a, b, c], k); };
    for (let q = 0; q + 1 < st.length; q++) { const A = pts[q], B = pts[q + 1]; if (!A || !B) continue; const s = st[q].s;
      for (let p = 0; p + 1 < prof.length; p++) { const k = band(p, p + 1); tri(A[p], B[p], B[p + 1], k, s); tri(A[p], B[p + 1], A[p + 1], k, s); } }
    // the round caps at each end (not where it stops at a deck or tube): a fan of the carriageway, a ring of the outer band
    for (const [qi, sg] of [[0, -1], [st.length - 1, 1]]) { const q = st[qi], A = pts[qi]; if (!A || (sg < 0 ? r.cutA : r.cutB)) continue; const s = q.s, ux = sg * q.nz, uz = -sg * q.nx; // (out of the road's end)
      const W = prof[prof.length - 1][0], ko = prof[prof.length - 1][1], hw = r.minor ? r.hw : r.hw, kc = r.minor ? prof[0][1] : KIND.tarmac;
      const c0 = [q.x, R.drawn(q.x, q.z, kc), q.z, R.drawn(q.x, q.z, kc)], ring = (rad, k, dp = 0) => { const out = []; for (let i = 0; i <= CAP; i++) { const a = Math.PI * i / CAP, cx = -Math.cos(a), sx = Math.sin(a), x = q.x + (q.nx * cx + ux * sx) * rad, z = q.z + (q.nz * cx + uz * sx) * rad, y = R.drawn(x, z, k); out.push([x, y, z, y - dp]); } return out; };
      const inner = ring(hw, kc); for (let i = 0; i < CAP; i++) tri(c0, inner[i], inner[i + 1], kc, s);
      if (W > hw + 0.05) { const outer = ring(W, ko); for (let i = 0; i < CAP; i++) { tri(inner[i], outer[i], outer[i + 1], ko, s); tri(inner[i], outer[i + 1], inner[i + 1], ko, s); } } }
    // the sides: per side, per station (and round each cap), a face out from the outer edge
    const quads = (F, flip) => jobs.push([F, flip]);
    for (const sd of [-1, 1]) { const e = sd < 0 ? 0 : prof.length - 1; quads(st.map((q, qi) => pts[qi] && face(pts[qi][e], sd * q.nx, sd * q.nz)), sd < 0); }
    for (const [qi, sg] of [[0, -1], [st.length - 1, 1]]) { const q = st[qi]; if (!pts[qi] || (sg < 0 ? r.cutA : r.cutB)) continue; const ux = sg * q.nz, uz = -sg * q.nx, W = prof[prof.length - 1][0], ko = prof[prof.length - 1][1], F = [];
      for (let i = 0; i <= CAP; i++) { const an = Math.PI * i / CAP, cx = -Math.cos(an), sx = Math.sin(an), dx = q.nx * cx + ux * sx, dz = q.nz * cx + uz * sx, x = q.x + dx * W, z = q.z + dz * W, y = R.drawn(x, z, ko); F.push(face([x, y, z, y], dx, dz)); }
      quads(F, sg > 0); }
  });
  // the cuttings: a cell under a cut face whose ground stands above it, dropped (sampled every metre over each face quad)
  const gAt = (x, z) => { const fx = (x - X0) / GRID, fz = (z - Z0) / GRID, i = Math.max(0, Math.min(NC - 1, Math.floor(fx))), j = Math.max(0, Math.min(NC - 1, Math.floor(fz))), u = fx - i, v = fz - j; return (gv[j * NV + i] * (1 - u) + gv[j * NV + i + 1] * u) * (1 - v) + (gv[(j + 1) * NV + i] * (1 - u) + gv[(j + 1) * NV + i + 1] * u) * v; };
  for (const [F] of jobs) for (let q = 0; q + 1 < F.length; q++) { if (!F[q] || !F[q + 1]) continue; const A = F[q].cut, B = F[q + 1].cut; if (!A && !B) continue; const a0 = A || [F[q].E || F[q].prof[0], F[q].B || F[q].prof[1]], b0 = B || [F[q + 1].E || F[q + 1].prof[0], F[q + 1].B || F[q + 1].prof[1]];
    const nu = Math.max(1, Math.ceil(Math.max(Math.hypot(a0[1][0] - a0[0][0], a0[1][2] - a0[0][2]), Math.hypot(b0[1][0] - b0[0][0], b0[1][2] - b0[0][2])))), nv = Math.max(1, Math.ceil(Math.hypot(b0[0][0] - a0[0][0], b0[0][2] - a0[0][2])));
    for (let iu = 0; iu <= nu; iu++) for (let iv = 0; iv <= nv; iv++) { const u = iu / nu, v = iv / nv, P2 = (c) => (a0[0][c] * (1 - u) + a0[1][c] * u) * (1 - v) + (b0[0][c] * (1 - u) + b0[1][c] * u) * v, x = P2(0), y = P2(1), z = P2(2);
      const i = Math.floor((x - X0) / GRID), j = Math.floor((z - Z0) / GRID); if (i < 0 || j < 0 || i >= NC || j >= NC || drop[j * NC + i]) continue; if (gAt(x, z) > y + M_CUT) { drop[j * NC + i] = 1; dropped++; } } }
  const tMask = performance.now() - t0;
  // ---- the ground: the kept cells
  const nrmV = new Float32Array(NV * NV * 3); for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) { const h = (a, b) => gv[Math.max(0, Math.min(NV - 1, b)) * NV + Math.max(0, Math.min(NV - 1, a))], nx = h(i - 1, j) - h(i + 1, j), nz = h(i, j - 1) - h(i, j + 1), ny = 2 * GRID, l = Math.hypot(nx, ny, nz); nrmV.set([nx / l, ny / l, nz / l], (j * NV + i) * 3); }
  const gStart = TK.length; const V = (i, j) => { const y = gv[j * NV + i]; return [X0 + i * GRID, y, Z0 + j * GRID, y]; };
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) { if (drop[j * NC + i]) continue; emit([V(i, j), V(i + 1, j), V(i + 1, j + 1)], KIND.ground); emit([V(i, j), V(i + 1, j + 1), V(i, j + 1)], KIND.ground); }
  const gEnd = TK.length;
  for (const [F, flip] of jobs) quads2(F.map((f) => f && finish(f)), flip);
  // plazas (alley, pavers, gravel areas): a fan from each ring's first corner would fold; a small ear clip
  for (const a of L.areas) { const k = a.surf === 2 ? KIND.gravel : a.surf === 1 ? KIND.pavers : KIND.alley, ring = a.ring.map(([x, z]) => [x / 100, z / 100]); for (const [p, q, w] of earcut(ring)) { const V3 = (v) => { const y = R.drawn(v[0], v[1], k); return [v[0], y, v[1], y, v[0], v[1], 1e4, 99]; }; emit([V3(ring[p]), V3(ring[q]), V3(ring[w])], k, k === KIND.gravel ? 0xffffffff : -1); } }
  // ---- out: sorted by kind (one draw group each), normals per corner (the grid's smooth; the rest flat)
  const nt = TK.length, order = Array.from({ length: nt }, (_, t) => t).sort((a, b) => TK[a] - TK[b] || a - b), NVt = nt * 3;
  const parts = new Uint8Array(nt), pos = new Float32Array(NVt * 3), phys = new Float32Array(NVt), nrm = new Float32Array(NVt * 3), idx = new Uint32Array(NVt), tk = new Uint8Array(nt), ang = new Float32Array(nt);
  order.forEach((t, q) => { tk[q] = TK[t]; parts[q] = PART[t]; for (let c = 0; c < 3; c++) { const v = t * 3 + c, o = q * 3 + c; pos[o * 3] = P[v * 3]; pos[o * 3 + 1] = P[v * 3 + 1]; pos[o * 3 + 2] = P[v * 3 + 2]; phys[o] = PY[v]; idx[o] = o; }
    if (t >= gStart && t < gEnd) for (let c = 0; c < 3; c++) { const o = q * 3 + c, i = Math.round((pos[o * 3] - X0) / GRID), j = Math.round((pos[o * 3 + 2] - Z0) / GRID); nrm.set(nrmV.subarray((j * NV + i) * 3, (j * NV + i) * 3 + 3), o * 3); }
    else { const a = q * 9, ux = pos[a + 3] - pos[a], uy = pos[a + 4] - pos[a + 1], uz = pos[a + 5] - pos[a + 2], vx = pos[a + 6] - pos[a], vy = pos[a + 7] - pos[a + 1], vz = pos[a + 8] - pos[a + 2]; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; for (let c = 0; c < 3; c++) nrm.set([nx / l, ny / l, nz / l], a + c * 3); }
    if (L.city && TK[t] <= KIND.bank) { const a = q * 9, nn = R.nearest((pos[a] + pos[a + 3] + pos[a + 6]) / 3, (pos[a + 2] + pos[a + 5] + pos[a + 8]) / 3, (r) => !r.minor); if (nn) { const th = Math.atan2(nn.dz, nn.dx), h = Math.PI / 2; ang[q] = ((th % h) + h) % h; } } });
  // the rib's normals: flat
  const rn = new Float32Array(rib.pos.length); for (let v = 0; v < rib.pos.length; v += 9) { const p = rib.pos, ux = p[v + 3] - p[v], uy = p[v + 4] - p[v + 1], uz = p[v + 5] - p[v + 2], wx = p[v + 6] - p[v], wy = p[v + 7] - p[v + 1], wz = p[v + 8] - p[v + 2]; let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; for (let c = 0; c < 3; c++) rn.set([nx / l, ny / l, nz / l], v + c * 3); }
  const F32 = (a) => Float32Array.from(a);
  return { level: 'fine', top: true, parts, pos, phys, nrm, idx, tk, ang, rib: { pos: F32(rib.pos), nrm: rn, road: F32(rib.road), lane: F32(rib.lane), kind: Uint8Array.from(rib.kind), id: Uint32Array.from(rib.id) },
    stats: { tris: nt, cells: NC * NC, dropped, faces: faceN, faceCut, faceFill, tallFill, tallCut, wall, maskMs: tMask, totalMs: performance.now() - t0 } };
}

// a simple polygon's triangles (ear clipping; a plaza's ring, tens of points)
function earcut(ring) {
  let V = ring.map((_, i) => i); const n0 = V.length; if (n0 < 3) return []; let area = 0; for (let i = 0; i < n0; i++) { const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n0]; area += ax * bz - bx * az; } if (area < 0) V.reverse();
  const out = [], cr = (a, b, c) => (ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) - (ring[b][1] - ring[a][1]) * (ring[c][0] - ring[a][0]);
  const inT = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
  let guard = 0; while (V.length > 3 && guard++ < 10000) { let cut = false; for (let i = 0; i < V.length; i++) { const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length]; if (cr(a, b, c) <= 0) continue; if (V.some((p) => p !== a && p !== b && p !== c && inT(p, a, b, c))) continue; out.push([a, b, c]); V.splice(i, 1); cut = true; break; } if (!cut) break; }
  if (V.length === 3) out.push(V); return out;
}
