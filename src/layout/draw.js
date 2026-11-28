// What a chunk's mesh (mesh.js meshChunk) is drawn with, as plain typed arrays, worked out where it's meshed (worker.js),
// so the main thread only wraps them in buffers (runtime.js show): no per-vertex copying in a frame (#294, startup and
// streaming). Pure (no three.js, no World).
//   surf: { pos, nrm, ang, idx, groups: [start, count, material, ...] } the surface (ground, alleys, gravel, pavers),
//     a corner shared by triangles of two paving angles (mesh.js ang) given a copy for each
//   water: { pos, dep } | null  the surface's part under the water level wl (null: none, or no water here)
//   parts: { tarmac, walk, track }  the street ribbons by material, each { pos, nrm, attrs: { name: [array, size] } } | null
import { KIND } from './format.js';
import { MARK, physIndex, physAt } from './mesh.js';
import { portalsOf, WALL_LIP, DECK_SIDE, DECK_DEPTH, TUBE_SIDE, TUBE_H, PORTAL_TOP, PORTAL_T, PORTAL_FOOT, SILL } from './rules.js';
import { railPieces, railSide, RAIL_TOP, SLEEPER_TOP, SLEEPER_STEP, GAUGE, SLEEPER_L } from './rails.js';

// (the surface's materials, runtime.js matList: ground, alley, gravel, pavers, ballast; -1 not in the surface)
const matOf = (k, ribG) => (k === KIND.ground || k === KIND.bank ? 0 : k === KIND.alley ? 1 : k === KIND.verge || (k === KIND.gravel && !ribG) ? 2 : k === KIND.pavers ? 3 : k === KIND.ballast ? 4 : -1);

export function drawBuffers(m, wl = null) {
  const N0 = m.pos.length / 3, vAng = new Float32Array(N0).fill(NaN), dup = [], dAng = [], idx = m.idx.slice();
  for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] > KIND.bank) continue; const a = m.ang[q]; for (let r = 0; r < 3; r++) { const v = idx[q * 3 + r]; if (vAng[v] !== vAng[v]) vAng[v] = a; else if (vAng[v] !== a) { idx[q * 3 + r] = N0 + dup.length; dup.push(v); dAng.push(a); } } }
  const n1 = N0 + dup.length, pos = new Float32Array(n1 * 3), nrm = new Float32Array(n1 * 3), ang = new Float32Array(n1); pos.set(m.pos); nrm.set(m.nrm);
  for (let k = 0; k < N0; k++) ang[k] = vAng[k] === vAng[k] ? vAng[k] : 0;
  for (let i = 0; i < dup.length; i++) { const v = dup[i], o = N0 + i; for (let e = 0; e < 3; e++) { pos[o * 3 + e] = m.pos[v * 3 + e]; nrm[o * 3 + e] = m.nrm[v * 3 + e]; } ang[o] = dAng[i]; }
  const r = m.rib, n = r.kind.length, ribG = r.kind.includes(KIND.gravel), groups = [];
  for (let q = 0; q < m.tk.length;) { const mi = matOf(m.tk[q], ribG); let e = q; while (e < m.tk.length && matOf(m.tk[e], ribG) === mi) e++; if (mi >= 0) groups.push(q * 3, (e - q) * 3, mi); q = e; }
  const surf = { pos, nrm, ang, idx, groups };
  // the street ribbons (a triangle soup, three corners per triangle) by material
  const part = (want, attrs) => {
    let t = 0; for (let v = 0; v < n; v += 3) if (want(r.kind[v])) t++; if (!t) return null;
    const k = t * 3, P = new Float32Array(k * 3), N = new Float32Array(k * 3), A = attrs.map(([, size]) => new Float32Array(k * size));
    let o = 0; for (let v0 = 0; v0 < n; v0 += 3) { if (!want(r.kind[v0])) continue;
      for (let q = 0; q < 3; q++, o++) { const v = v0 + q; for (let e = 0; e < 3; e++) { P[o * 3 + e] = r.pos[v * 3 + e]; N[o * 3 + e] = r.nrm[v * 3 + e]; } for (let a = 0; a < attrs.length; a++) attrs[a][2](v, A[a], o * attrs[a][1]); } }
    const out = { pos: P, nrm: N, attrs: {} }; attrs.forEach(([name, size], a) => (out.attrs[name] = [A[a], size])); return out; };
  const R = r.road, uv = ['uv', 2, (v, A, o) => { A[o] = R[v * 4 + 1]; A[o + 1] = R[v * 4]; }], rjunc = ['rjunc', 4, (v, A, o) => { A[o] = 99; A[o + 1] = 99; }];
  const parts = {
    // (the carriageway's markings coordinates, aM0, aM1, ...: a vec4 each, MARK floats a corner: runtime.js roadMat)
    tarmac: part((k) => k === KIND.tarmac, Array.from({ length: MARK / 4 }, (_, a) => a).map((a) => ['aM' + a, 4, (v, A, o) => { const s = v * MARK + a * 4; A[o] = r.mark[s]; A[o + 1] = r.mark[s + 1]; A[o + 2] = r.mark[s + 2]; A[o + 3] = r.mark[s + 3]; }])),
    // (the pavement and its kerb, today's material: uv = metres across from the street's centre line, along; rinfo = half width, -, seed)
    walk: part((k) => k === KIND.kerb || k === KIND.pave, [uv, ['rinfo', 3, (v, A, o) => { A[o] = R[v * 4 + 2]; A[o + 2] = 3; }], rjunc]),
    // (the gravel, today's tracks' material: rinfo = half width (half a metre more: its ragged edge stays inside the
    // gravel's own triangles, there's nothing under it), the gravel look 2, seed)
    track: part((k) => k === KIND.gravel, [uv, ['rinfo', 3, (v, A, o) => { A[o] = R[v * 4 + 2] + 0.5; A[o + 1] = 2; A[o + 2] = r.id[v] % 97; }], rjunc]),
  };
  return { surf, water: wl != null && wl > -Infinity ? water(m, wl) : null, parts };
}

// a chunk's water: the part of its ground under the water level, cut along it through the very triangles the ground is
// drawn with (as World.buildShoreWater does on today's grid), each corner given the depth of the ground under it
function water(m, wl) {
  const P = m.pos, I = m.idx, out = [], dep = [], poly = [];
  for (let q = 0; q < m.tk.length; q++) { if (m.tk[q] > KIND.bank) continue; // (the ground and its banks: a paved region is never water, World.groundAt)
    const v = [I[q * 3], I[q * 3 + 1], I[q * 3 + 2]]; if (P[v[0] * 3 + 1] >= wl && P[v[1] * 3 + 1] >= wl && P[v[2] * 3 + 1] >= wl) continue;
    poly.length = 0;
    for (let r = 0; r < 3; r++) { const a = v[r], b = v[(r + 1) % 3], ya = P[a * 3 + 1], yb = P[b * 3 + 1];
      if (ya < wl) poly.push(P[a * 3], P[a * 3 + 2], wl - ya);
      if ((ya < wl) !== (yb < wl)) { const t = (ya - wl) / (ya - yb); poly.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t, 0); } }
    for (let k = 1; k + 1 < poly.length / 3; k++) for (const e of [0, k, k + 1]) { out.push(poly[e * 3], wl, poly[e * 3 + 1]); dep.push(poly[e * 3 + 2]); } }
  return out.length ? { pos: new Float32Array(out), dep: new Float32Array(dep) } : null;
}

// a chunk's railways (rails.js; fine level only): the rails and sleepers laid on its surface (or a deck's, a tube's own
// profile), and a rail bridge's deck, a rail tunnel's tube and portals (a road's are roads.js's, but for its headwall
// raised under a way over it). -> null (none), or { pos: { steel, sleeper, deck, tube, ballast } (triangles, x y z),
// nrm (their flat normals), piers: [x, z, top, ux, uz, half width, ...] (a deck's piers' places, every ~30 m) }
export function railBuffers(L, m) {
    const phys = physIndex(L, m), at = (x, z) => physAt(L, m, phys, x, z), pcs = railPieces(L, at), ports = portalsOf(L.net.runs); if (!pcs.length && !L.net.runs.some((r) => r.off) && !ports.length) return null;
    const G = { steel: [], sleeper: [], deck: [], tube: [], ballast: [] }, piers = [], quad = (A, a, b, cc, d) => { for (const v of [a, b, cc, a, cc, d]) A.push(v[0], v[1], v[2]); };
    for (const pc of pcs) { const P = pc.P, n = P.length / 5, half = GAUGE[pc.cls] / 2;
      // the rails: a head 7 cm wide RAIL_TOP over the bed, its sides down to the sleepers
      for (const sd of [-1, 1]) { const S = railSide(pc, sd * half, at, true), k = S.length / 5, a = (i, w, dy) => [S[i * 5] - S[i * 5 + 4] * w, S[i * 5 + 2] + dy, S[i * 5 + 1] + S[i * 5 + 3] * w];
        for (let i = 0; i + 1 < k; i++) { quad(G.steel, a(i, -0.035, RAIL_TOP), a(i, 0.035, RAIL_TOP), a(i + 1, 0.035, RAIL_TOP), a(i + 1, -0.035, RAIL_TOP)); quad(G.steel, a(i, -0.035, SLEEPER_TOP), a(i, -0.035, RAIL_TOP), a(i + 1, -0.035, RAIL_TOP), a(i + 1, -0.035, SLEEPER_TOP)); quad(G.steel, a(i, 0.035, RAIL_TOP), a(i, 0.035, SLEEPER_TOP), a(i + 1, 0.035, SLEEPER_TOP), a(i + 1, 0.035, RAIL_TOP)); } }
      // the sleepers: every SLEEPER_STEP m along, their ends on the bed
      const sl = SLEEPER_L[pc.cls] / 2, E0 = railSide(pc, -sl, at), E1 = railSide(pc, sl, at); let acc = SLEEPER_STEP / 2;
      for (let i = 0; i + 1 < n; i++) { const l = Math.hypot(P[i * 5 + 5] - P[i * 5], P[i * 5 + 6] - P[i * 5 + 1]); while (acc < l) { const t = acc / l, f = (Q, k) => Q[i * 5 + k] + (Q[i * 5 + 5 + k] - Q[i * 5 + k]) * t, ux = P[i * 5 + 3] * 0.11, uz = P[i * 5 + 4] * 0.11;
          const a = [f(E0, 0), f(E0, 2) + SLEEPER_TOP, f(E0, 1)], b = [f(E1, 0), f(E1, 2) + SLEEPER_TOP, f(E1, 1)]; quad(G.sleeper, [a[0] - ux, a[1], a[2] - uz], [b[0] - ux, b[1], b[2] - uz], [b[0] + ux, b[1], b[2] + uz], [a[0] + ux, a[1], a[2] + uz]); acc += SLEEPER_STEP; } acc -= l; }
      if (!pc.off || pc.off === 'rails') continue; /* (a second track in a shared tube: its rails only, the tube the other's) */
      // on a deck or in a tube: its bed (level across), and under it the deck (top, sides and parapets, underside), or round it the tube
      const hw = pc.hw, at3 = (k, o, dy) => [P[k * 5] - P[k * 5 + 4] * o, P[k * 5 + 2] + dy, P[k * 5 + 1] + P[k * 5 + 3] * o];
      for (let i = 0; i + 1 < n; i++) { quad(G.ballast, at3(i, -hw, 0), at3(i, hw, 0), at3(i + 1, hw, 0), at3(i + 1, -hw, 0));
        if (pc.off === 'deck') { const W = hw + DECK_SIDE; quad(G.deck, at3(i, -W, -0.01), at3(i, W, -0.01), at3(i + 1, W, -0.01), at3(i + 1, -W, -0.01)); quad(G.deck, at3(i, W, -DECK_DEPTH), at3(i, -W, -DECK_DEPTH), at3(i + 1, -W, -DECK_DEPTH), at3(i + 1, W, -DECK_DEPTH));
          for (const sd of [-1, 1]) { quad(G.deck, at3(i, W * sd, -DECK_DEPTH), at3(i + 1, W * sd, -DECK_DEPTH), at3(i + 1, W * sd, 0.7), at3(i, W * sd, 0.7)); quad(G.deck, at3(i, (W - 0.3) * sd, 0.7), at3(i + 1, (W - 0.3) * sd, 0.7), at3(i + 1, (W - 0.3) * sd, -0.01), at3(i, (W - 0.3) * sd, -0.01)); quad(G.deck, at3(i, W * sd, 0.7), at3(i + 1, W * sd, 0.7), at3(i + 1, (W - 0.3) * sd, 0.7), at3(i, (W - 0.3) * sd, 0.7)); } }
        else { const W = hw + TUBE_SIDE; for (const sd of [-1, 1]) { quad(G.tube, at3(i, W * sd, -0.3), at3(i + 1, W * sd, -0.3), at3(i + 1, W * sd, TUBE_H * 0.8), at3(i, W * sd, TUBE_H * 0.8)); quad(G.tube, at3(i, W * sd, TUBE_H * 0.8), at3(i + 1, W * sd, TUBE_H * 0.8), at3(i + 1, W * 0.55 * sd, TUBE_H), at3(i, W * 0.55 * sd, TUBE_H)); }
          quad(G.tube, at3(i, -W * 0.55, TUBE_H), at3(i + 1, -W * 0.55, TUBE_H), at3(i + 1, W * 0.55, TUBE_H), at3(i, W * 0.55, TUBE_H)); } }
      // (a deck's piers, every ~30 m where it's 3 m or more over the ground)
      // (the ground under them is today's terrain, the World's: their places here, the piers made on the main thread, runtime.js railsFor)
      if (pc.off === 'deck') for (let i = 15; i < n - 1; i += 15) piers.push(P[i * 5], P[i * 5 + 1], P[i * 5 + 2] - DECK_DEPTH, P[i * 5 + 3], P[i * 5 + 4], hw + DECK_SIDE - 0.4); }
    // a road's tube (with the layout on, roads.js's is hidden in a layout chunk, runtime.js clip: its portal may have moved in,
    // bake.js deepen): its floor, walls and vault at its own profile
    for (const r of L.net.runs) { if (r.off !== 'tube' || r.kind === 'rail') continue; const W = r.hw + TUBE_SIDE, n = r.h.length;
      for (let i = 0; i + 1 < n; i++) { const ax = r.pts[i * 2], az = r.pts[i * 2 + 1], bx = r.pts[i * 2 + 2], bz = r.pts[i * 2 + 3], l = Math.hypot(bx - ax, bz - az); if (l < 1e-3) continue; const mx = (ax + bx) / 2, mz = (az + bz) / 2; if (mx < L.x0 || mx >= L.x0 + L.size || mz < L.z0 || mz >= L.z0 + L.size) continue;
        const nx = -(bz - az) / l, nz = (bx - ax) / l, A = (o, dy) => [ax + nx * o, r.h[i] + dy, az + nz * o], B = (o, dy) => [bx + nx * o, r.h[i + 1] + dy, bz + nz * o];
        quad(G.tube, A(-W, 0), A(W, 0), B(W, 0), B(-W, 0));
        for (const sd of [-1, 1]) { quad(G.tube, A(W * sd, -0.3), B(W * sd, -0.3), B(W * sd, TUBE_H * 0.8), A(W * sd, TUBE_H * 0.8)); quad(G.tube, A(W * sd, TUBE_H * 0.8), B(W * sd, TUBE_H * 0.8), B(W * 0.55 * sd, TUBE_H), A(W * 0.55 * sd, TUBE_H)); }
        quad(G.tube, A(-W * 0.55, TUBE_H), B(-W * 0.55, TUBE_H), B(W * 0.55, TUBE_H), A(W * 0.55, TUBE_H)); } }
    // a tunnel's portals: the headwall round its mouth (as roads.js's), centred on the portal; no higher than the surfaces about it
    // and a wall's lip (over the mouth's lintel at least, up to its top: a way over it); its wings only over its lip (the opening),
    // not over a road beside the portal (outline.js)
    for (const p of ports) { if (p.x < L.x0 || p.x >= L.x0 + L.size || p.z < L.z0 || p.z >= L.z0 + L.size) continue; const T = PORTAL_T / 2, pt = (u, v, y) => [p.x + p.dx * u - p.dz * v, p.y + y, p.z + p.dz * u + p.dx * v];
      const box = (v0, v1, y0, y1) => { for (const u of [-T, T]) quad(G.tube, pt(u, v0, y0), pt(u, v1, y0), pt(u, v1, y1), pt(u, v0, y1)); quad(G.tube, pt(-T, v0, y1), pt(-T, v1, y1), pt(T, v1, y1), pt(T, v0, y1)); for (const v of [v0, v1]) quad(G.tube, pt(-T, v, y0), pt(T, v, y0), pt(T, v, y1), pt(-T, v, y1)); };
      let h = -Infinity; for (const u of [-PORTAL_T, PORTAL_T]) for (let v = -p.W; v <= p.W + 1e-9; v += 0.5) { const q = pt(u, v, 0), y = at(q[0], q[2]); if (y === y) h = Math.max(h, y - p.y); }
      const top = Math.min(p.top, Math.max(TUBE_H + 0.3, h + WALL_LIP)), lipAt = (v) => { const q = pt(PORTAL_T / 4, v, 0), y = at(q[0], q[2]); return !(y === y); };
      for (const sd of [-1, 1]) { let v0 = null; for (let v = p.hwT; v <= p.W + 1e-9; v += 0.5) { const on = v + 0.25 <= p.W + 1e-9 && lipAt(sd * (v + 0.25)); if (on && v0 == null) v0 = v; if (!on && v0 != null) { box(sd > 0 ? v0 : -v, sd > 0 ? v : -v0, -PORTAL_FOOT, top); v0 = null; } } if (v0 != null) box(sd > 0 ? v0 : -p.W, sd > 0 ? p.W : -v0, -PORTAL_FOOT, top); }
      box(-p.hwT, p.hwT, TUBE_H, top); box(-p.hwT, p.hwT, -SILL, -0.05); } // (its wings PORTAL_FOOT deep, a sill across the mouth: roads.js's)
  const pos = {}, nrm = {};
  for (const [k, A] of Object.entries(G)) { if (!A.length) continue; const P = (pos[k] = new Float32Array(A)), N = (nrm[k] = new Float32Array(P.length));
    for (let t = 0; t < P.length; t += 9) { const ax = P[t + 3] - P[t], ay = P[t + 4] - P[t + 1], az = P[t + 5] - P[t + 2], bx = P[t + 6] - P[t], by = P[t + 7] - P[t + 1], bz = P[t + 8] - P[t + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; for (let v = 0; v < 9; v += 3) { N[t + v] = nx; N[t + v + 1] = ny; N[t + v + 2] = nz; } } }
  return { pos, nrm, piers };
}

// every buffer in a drawBuffers result (to transfer it from the worker)
export function drawTransfer(d) {
  const out = [d.surf.pos.buffer, d.surf.nrm.buffer, d.surf.ang.buffer, d.surf.idx.buffer]; if (d.water) out.push(d.water.pos.buffer, d.water.dep.buffer);
  for (const p of Object.values(d.parts)) if (p) { out.push(p.pos.buffer, p.nrm.buffer); for (const [A] of Object.values(p.attrs)) out.push(A.buffer); }
  if (d.rails) for (const k of Object.keys(d.rails.pos)) out.push(d.rails.pos[k].buffer, d.rails.nrm[k].buffer);
  return out;
}
