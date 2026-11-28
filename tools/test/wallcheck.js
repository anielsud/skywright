// Retaining walls (#294, src/layout/walls.js), checked on the committed layout's chunks where they stand (Lauterbrunnen's
// worst bank-cap step and a switchback on the valley wall; New York's expressway in a trench): every step the ground
// takes at a bank's cap (or, in a city, at a road's edge) over STEP_MAX is inside a wall; no wall stands on a way's paved
// surface (another carriageway: the wall is cut there); a wall's top is the higher surface's, up to its parapet over it.
// Each check is also run on walls broken on purpose (none; one moved onto the road; one raised), which it must catch.
// No World: the files and the hi grid, as layoutcheck.js.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeLayout, KIND } from '../../src/layout/format.js';
import { latticeOf } from '../../src/layout/mesh.js';
import { makeRules, latticeGround, latticeHeights, BANK_MAX, vergeW } from '../../src/layout/rules.js';
import { wallsOf, wallFree, stepAt, SEG_N, PARAPET, WALL_STEP, WALL_T } from '../../src/layout/walls.js';
import { hiGrid } from './layoutcheck.js';

export const nodeSuite = { files: ['src/layout/walls.js', 'src/layout/rules.js', 'src/layout/format.js', 'tools/test/wallcheck.js', 'assets/real/nyc/layout/index.json', 'assets/real/lauterbrunnen/layout/index.json'] };
const CASES = { lauterbrunnen: ['-11,9', '-3,-5'], nyc: ['-15,-10'] }; /* (Lauterbrunnen: the worst cap step, (-5147, 4767), and the switchbacks beside it; New York: the expressway's trench, (-7015, -4515)) */
export function cases() { return Object.keys(CASES).map((place) => ({ id: `${place} retaining walls`, place, cost: 1 })); }
const STEP_MAX = 0.35, PROBE = 0.1, TOP_TOL = 0.2;

// the surface the rules give at (x, z): a paved region's drawn height, else the ground (walls.js's)
const surf = (R, x, z) => { const k = R.region(x, z); return k === KIND.ground || k === KIND.bank ? R.ground(x, z) : R.drawn(x, z, k); };
// the checks on one chunk's walls (W: wallsOf's, its segments all kept: those across the chunk's edge too) ->
// { steps, uncovered, worst: [step m, x, z], at: [some uncovered], onWay, topBad, topWorst }
export function wallChecks(L, R, W) {
  const S = W.seg, ns = S.length / SEG_N, x0 = L.x0, z0 = L.z0, x1 = L.x0 + L.size, z1 = L.z0 + L.size, out = { steps: 0, uncovered: 0, worst: [0], at: [], onWay: 0, topBad: 0, topWorst: 0, topAt: [] };
  // (a point covered: a segment it's beside (along it, and between its faces) whose top reaches the higher side and foot the lower)
  const covered = (x, z, hi, lo) => { for (let q = 0; q < ns; q++) { const o = q * SEG_N, ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, L2 = dx * dx + dz * dz || 1e-9, t = ((x - ax) * dx + (z - az) * dz) / L2; if (t < -0.05 || t > 1.05) continue;
    const tt = Math.max(0, Math.min(1, t)), v = (x - ax - dx * tt) * S[o + 4] + (z - az - dz * tt) * S[o + 5], off = Math.hypot(x - ax - dx * tt, z - az - dz * tt); if (off > Math.max(Math.abs(S[o + 10]), Math.abs(S[o + 11])) + PROBE + 0.05 || v < S[o + 10] - PROBE - 0.05 || v > S[o + 11] + PROBE + 0.05) continue;
    const top = S[o + 6] + (S[o + 8] - S[o + 6]) * tt, bot = S[o + 7] + (S[o + 9] - S[o + 7]) * tt; if (top >= hi - TOP_TOL && bot <= lo + 0.05) return true; } return false; };
  // the steps: along every road's sides, every WALL_STEP m inside each segment, square to it, at the bank's cap (in a city:
  // an expressway's edge): the surface just either side, both off the paved ways (a carriageway: no wall there)
  for (const r of L.net.runs) { if (r.off || r.kind === 'rail' || r.h.length < 2) continue; const side = r.hw + (r.pave || vergeW(r)), offs = L.city ? [] : [side + BANK_MAX]; if (L.city && r.kind === 'highway' && !r.pave) offs.push(side);
    for (let s = 0; s + 1 < r.h.length; s++) { const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], dx = r.pts[s * 2 + 2] - ax, dz = r.pts[s * 2 + 3] - az, l = Math.hypot(dx, dz); if (l < 1e-3) continue;
      for (let t = WALL_STEP / 2; t < l; t += WALL_STEP) for (const sg of [1, -1]) { const nx = (-dz / l) * sg, nz = (dx / l) * sg, cx = ax + dx * t / l, cz = az + dz * t / l;
        for (const d of offs) { const x = cx + nx * d, z = cz + nz * d; if (x < x0 || z < z0 || x >= x1 || z >= z1) continue; const ix = x - nx * PROBE, iz = z - nz * PROBE, ox = x + nx * PROBE, oz = z + nz * PROBE;
          if (!wallFree(R, ox, oz) || !wallFree(R, x + nx * (WALL_T + 0.02), z + nz * (WALL_T + 0.02)) || (d > side && !wallFree(R, ix, iz))) continue; /* (room for a wall: not a median's sliver between two carriageways) */ const yi = surf(R, ix, iz), yo = surf(R, ox, oz), st = stepAt((v) => surf(R, cx + nx * v, cz + nz * v), d); if (st <= STEP_MAX) continue;
          out.steps++; if (!covered(x, z, Math.max(yi, yo), Math.min(yi, yo))) { out.uncovered++; if (st > out.worst[0]) out.worst = [st, x, z]; if (out.at.length < 12) out.at.push([+x.toFixed(1), +z.toFixed(1), +st.toFixed(2), d > side ? 'cap' : 'edge']); } } } } }
  // no wall on a paved surface; its top the higher surface's, up to its parapet over it (at each end, just either side of the step)
  for (let q = 0; q < ns; q++) { const o = q * SEG_N, ax = S[o], az = S[o + 1], bx = S[o + 2], bz = S[o + 3], nx = S[o + 4], nz = S[o + 5], o0 = S[o + 10], o1 = S[o + 11], edge = S[o + 12] === 1, l = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(l / 0.5));
    for (let i = 0; i <= m; i++) { const px = ax + (bx - ax) * i / m, pz = az + (bz - az) * i / m; if ([(o0 + o1) / 2, o1 - 0.02, ...(edge ? [] : [o0 + 0.02])].some((v) => !wallFree(R, px + nx * v, pz + nz * v))) { out.onWay++; break; } }
    /* (along it: the top never under the higher face's surface, and somewhere within the parapet over it) */
    let least = Infinity, under = 0; const fi = edge ? -0.05 : o0, fo = o1;
    for (let i = 0; i <= m; i++) { const t = i / m, x = ax + (bx - ax) * t, z = az + (bz - az) * t, top = S[o + 6] + (S[o + 8] - S[o + 6]) * t, hi = Math.max(surf(R, x + nx * fi, z + nz * fi), surf(R, x + nx * fo, z + nz * fo)), over = top - hi; least = Math.min(least, over); under = Math.max(under, -over); }
    if (under > TOP_TOL || least > PARAPET + TOP_TOL) { if (out.topAt.length < 6) out.topAt.push([+ax.toFixed(1), +az.toFixed(1), +under.toFixed(2), +least.toFixed(2), S[o + 12]]); out.topBad++; out.topWorst = Math.max(out.topWorst, under > TOP_TOL ? under : least); } }
  return out;
}

export async function runCase(c) {
  const G = hiGrid(c.place), dir = `assets/real/${c.place}/layout/`, idx = JSON.parse(readFileSync(dir + 'index.json', 'utf8')), out = [], grid = { x0: G.x0, z0: G.z0, sp: G.sp, wl: -Infinity };
  for (const k of CASES[c.place]) { const e = idx.chunks.find((e) => e.ix + ',' + e.iz === k); if (!e) { out.push({ name: `${c.place} ${k}: in the layout`, ok: false, why: 'no such chunk' }); continue; }
    const buf = gunzipSync(readFileSync(dir + e.file)), L = decodeLayout(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), lat = latticeOf(L, grid), g = latticeGround(grid, lat, latticeHeights(G.w, grid, lat));
    const R = makeRules(L.net, g, !!L.city, -Infinity, [L.x0 - 30, L.z0 - 30, L.x0 + L.size + 30, L.z0 + L.size + 30]), W = wallsOf(L, R, g, true), r = wallChecks(L, R, W), name = `${c.place} ${k}`;
    out.push({ name: `${name}: every step over ${STEP_MAX} m at a bank's cap (or a city road's edge) is inside a wall`, ok: r.uncovered === 0 && r.steps > 0, why: `${r.steps} steps, ${r.uncovered} uncovered${r.uncovered ? ` (worst ${r.worst[0].toFixed(2)} m at ${r.worst[1].toFixed(0)}, ${r.worst[2].toFixed(0)})` : ''}; ${W.n} wall segments, ${W.len.toFixed(0)} m` });
    out.push({ name: `${name}: no wall stands on a way's paved surface`, ok: r.onWay === 0 && W.n > 0, why: `${r.onWay} of ${W.n} segments on one` });
    out.push({ name: `${name}: each wall's top is the higher surface's, up to its parapet (${PARAPET} m) over it`, ok: r.topBad === 0 && W.n > 0, why: `${r.topBad} ends off (worst ${r.topWorst.toFixed(2)} m)` });
    // (the checks catch walls broken on purpose: none at all; one moved square across onto the road; one raised 3 m)
    const none = wallChecks(L, R, { seg: new Float32Array(0) }), q = W.seg.slice(), moved = q.slice(0, SEG_N), up = q.slice(0, SEG_N);
    const x = (moved[0] + moved[2]) / 2, z = (moved[1] + moved[3]) / 2, nr = R.nearest(x, z, (r) => !r.minor);
    if (nr) { const sx = nr.px - x, sz = nr.pz - z; moved[0] += sx; moved[2] += sx; moved[1] += sz; moved[3] += sz; }
    up[6] += 3; up[8] += 3;
    out.push({ name: `${name}: negative: with no walls, the steps check fails`, ok: none.uncovered > 0, why: `${none.uncovered} uncovered` });
    out.push({ name: `${name}: negative: a wall moved onto a carriageway, the paved-surface check fails`, ok: !!nr && wallChecks(L, R, { seg: moved }).onWay > 0, why: nr ? `moved ${Math.hypot(nr.px - x, nr.pz - z).toFixed(1)} m` : 'no street near' });
    out.push({ name: `${name}: negative: a wall raised 3 m, the top check fails`, ok: wallChecks(L, R, { seg: up }).topBad > 0, why: '' });
  }
  return out;
}
