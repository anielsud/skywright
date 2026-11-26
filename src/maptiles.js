// HUD minimap: small images of the ground on the terrain tiles' grid (T = world.size / 4, the core is tiles -2..1),
// built around the plane as it flies, so the map keeps unrolling wherever you go. Each map pixel samples the same two
// functions the landscape is made from (World.height / sampleGrid for the shape, World.baseColor for the colour: the
// procedural land cover, or a real place's satellite imagery) at map resolution only: no terrain tile is ever built
// for the map, but the two always match. Procedural places get a hillshade from the sun (the imagery has its own
// shading), water below the water level takes the water shader's palette, and the core tiles get the runways (and at
// procedural places the roads, rail and towns) drawn on top. One palette everywhere: the core no longer looks different
// from the land around it.
// Cost: a real place's tile is ~1 ms on a desktop; Alpine's ~11 ms (the eroded height function and the full land
// cover rules). So tiles are built a row at a time inside a ~1 ms/frame budget, nearest first with a lookahead along
// the velocity, coarse (32 px) first and then refined (64 px); flying the SR-71 straight needs about one new tile a
// second (measured, desktop, 3 min at 1 km/s: ~0.4 ms/frame at Alpine, under 0.1 at real places). The HUD draws one canvas: the tiles around the plane composited at their places on the grid (redone only
// when a tile lands or the plane moves into the next tile), so neighbouring tiles never show a seam.
import * as THREE from 'three';
import { STEP } from './stepClock.js';

const PX = 64, COARSE = 32, BOOT = 16; // px a side: full (~86 m/px, the old core image's scale), first pass, load-time pass
const RANGE = 12000; // m: the widest map range (hud.js): the composite always covers this square around the plane
const AHEAD = 8, AHEAD_MAX = 15000; // s / m of lookahead along the velocity (the SR-71 crosses a tile every ~5.5 s)
const MS = 1; // build budget per frame (ms)
const STEP_ROWS = 8; // rows per step instead, under the test stepper (stepClock.js)
const KEEP = 96; // tiles kept (least recently wanted dropped first): 64x64 canvases, ~16 kB each
export const MAP_BG = '#1d3b4a'; // where no tile is built yet

export class MapTiles {
  constructor(w, runways, rwyLen) {
    this.w = w; this.T = w.size / 4; this.runways = runways; this.rwyLen = rwyLen;
    this.tiles = new Map(); this.list = []; this.job = null; this.frame = 0; this.rowMs = 0; this.pool = []; this.scratch = new Map();
    this.c = new THREE.Color(); this.nrm = new THREE.Vector3(); this.light = new THREE.Vector3();
    this.stats = { ms: 0, frames: 0, max: 0, built: 0, bootMs: 0 }; // (the headless tests read these)
    // the composite the HUD draws: n x n tiles, enough for the widest view wherever the plane is inside its tile
    this.n = Math.ceil((2 * RANGE) / this.T) + 1;
    this.mos = document.createElement('canvas'); this.mos.width = this.mos.height = this.n * PX;
    this.mg = this.mos.getContext('2d'); this.mosAt = null; this.mosDirty = true;
    // water as the water shader draws it seen from straight above, by depth (0.5 m steps): shallow -> deep, the seabed
    // showing through the shallows with red absorbed first (shaders.js waterMaterial); in linear light, stored as sRGB
    const P = w.waterPal, deep = new THREE.Color(P.deep), sh = new THREE.Color(P.shallow), sand = new THREE.Color(P.sand), K = [0.38, 0.072, 0.05], sky = new THREE.Color().setRGB(0.6, 0.73, 0.84); // (sRGB-coded)
    this.water = new Uint8Array(128 * 3);
    for (let q = 0; q < 128; q++) {
      const d = q * 0.5, dk = 1 - Math.exp(-d * 0.09), body = sh.clone().lerp(deep, dk), out = [];
      ['r', 'g', 'b'].forEach((ch, m) => { const Tr = Math.exp(-K[m] * d * 2); out.push(sand[ch] * 0.9 * Tr + (sh[ch] * 0.55 * (1 - dk) + body[ch] * dk) * (1 - Tr)); });
      this.c.setRGB(out[0], out[1], out[2]).convertLinearToSRGB().lerp(sky, 0.3); // (plus some of the sky it reflects, as the water you see does)
      this.water.set([this.c.r * 255, this.c.g * 255, this.c.b * 255], q * 3);
    }
    // baked rivers and lakes (procedural places with a terrain bake): the terrain shader's water tint
    const wt = w.detailU.waterTint?.value; this.river = wt ? (this.c.copy(wt).convertLinearToSRGB(), [this.c.r * 255, this.c.g * 255, this.c.b * 255]) : null;
    // procedural places: the road and rail lines, bucketed by the core tile their bounding box touches
    this.lines = new Map();
    if (!w.real) {
      const T = this.T, add = (pts, style) => {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.z); c = Math.max(c, p.x); d = Math.max(d, p.z); }
        for (let i = Math.max(-2, Math.floor((a - 50) / T)); i <= Math.min(1, Math.floor((c + 50) / T)); i++) for (let j = Math.max(-2, Math.floor((b - 50) / T)); j <= Math.min(1, Math.floor((d + 50) / T)); j++) {
          const k = this.key(i, j); if (!this.lines.has(k)) this.lines.set(k, []); this.lines.get(k).push(style);
        }
      };
      for (const rd of w.net.roads) add(rd.pts, rd);
      if (w.net.rail) add(w.net.rail.pts, { rail: true, pts: w.net.rail.pts });
    }
  }
  key(i, j) { return (i + 4096) * 8192 + (j + 4096); }
  inCore(i, j) { return i >= -2 && i <= 1 && j >= -2 && j <= 1; }

  // Once a frame (hud.drawMap), plane position and velocity: decide what's wanted, build some of it, return the
  // composite to draw ({ c, x0, z0, span }: canvas and the world square it covers).
  update(px, pz, vx, vz) {
    const t0 = performance.now(), T = this.T; this.frame++;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return this.view(0, 0);
    // first frame, or a jump (respawn, teleport): the whole view square at once, coarse, so the map is never blank;
    // part of loading (~30 ms at Alpine on a desktop, ~3 ms at a real place)
    if (!this.at || Math.hypot(px - this.at[0], pz - this.at[1]) > RANGE) {
      this.job = null; this.want(px, pz, vx, vz);
      const res = this.w.real ? COARSE : BOOT, b0 = performance.now();
      for (const t of this.list) if (t.view && !this.tiles.get(t.key)?.res) { const it = this.build(t.i, t.j, res); let r; while (!(r = it.next()).done); this.finish(t, res, r.value); }
      this.stats.bootMs = performance.now() - b0;
    } else if (Math.hypot(px - this.at[0], pz - this.at[1]) > T * 0.1) this.want(px, pz, vx, vz);
    // the hillshade follows the sun (procedural places): a new time of day redraws the tiles, one by one
    if (!this.w.real && this.frame % 60 === 1 && this.lightKey !== this.lightFor()) { this.lightKey = this.lightFor(); for (const t of this.tiles.values()) t.stale = true; }
    // work, a row at a time, while the next row (its cost so far, rowMs) still fits in the frame's budget; at least one
    // row a frame, so a slow device still gets there
    for (let rows = 0; ; rows++) {
      const t = performance.now(); if (rows && (STEP.on ? rows >= STEP_ROWS : t - t0 + this.rowMs > MS)) break;
      if (!this.job) { this.job = this.pick(); if (!this.job) break; }
      const r = this.job.it.next(), dt = performance.now() - t; this.rowMs += (dt - this.rowMs) * 0.1;
      if (r.done) { const J = this.job; this.job = null; this.finish(J.t, J.res, r.value); if (J.redo) this.tiles.get(J.t.key).stale = true; }
    }
    const v = this.view(px, pz), ms = performance.now() - t0, S = this.stats;
    S.ms += ms; S.frames++; S.max = Math.max(S.max, ms);
    return v;
  }
  // The tiles wanted: the widest view's square around the plane, and around a point AHEAD seconds along its track;
  // nearest first (to a point 2 s ahead, so the side it flies towards wins ties). Far tiles beyond KEEP are dropped.
  want(px, pz, vx, vz) {
    const T = this.T, sp = Math.hypot(vx, vz), ah = Math.min(AHEAD * sp, AHEAD_MAX), q = Math.min(2 * sp, 3000);
    const ax = sp > 1 ? px + (vx / sp) * ah : px, az = sp > 1 ? pz + (vz / sp) * ah : pz, qx = sp > 1 ? px + (vx / sp) * q : px, qz = sp > 1 ? pz + (vz / sp) * q : pz;
    const set = new Map(), add = (cx, cz, view) => {
      for (let i = Math.floor((cx - RANGE) / T); i <= Math.floor((cx + RANGE) / T); i++) for (let j = Math.floor((cz - RANGE) / T); j <= Math.floor((cz + RANGE) / T); j++) {
        const k = this.key(i, j), o = set.get(k); if (o) { o.view ||= view; continue; }
        const dx = Math.max(i * T - qx, 0, qx - (i + 1) * T), dz = Math.max(j * T - qz, 0, qz - (j + 1) * T);
        set.set(k, { i, j, key: k, view, d: Math.hypot(dx, dz) });
      }
    };
    add(px, pz, true); if (ah > T * 0.25) add(ax, az, false);
    this.list = [...set.values()].sort((a, b) => a.d - b.d);
    this.at = [px, pz];
    for (const t of this.list) { const have = this.tiles.get(t.key); if (have) have.used = this.frame; }
    if (this.tiles.size > KEEP) {
      const old = [...this.tiles.values()].filter((t) => !set.has(t.key)).sort((a, b) => a.used - b.used);
      for (const t of old.slice(0, this.tiles.size - KEEP)) { this.tiles.delete(t.key); this.pool.push(t.c); }
    }
  }
  // next job: an unbuilt tile (coarse) or one whose data changed, nearest first; then refine to full detail
  pick() {
    for (const t of this.list) { const have = this.tiles.get(t.key); if (!have?.res || have.stale) return this.start(t, have?.res === PX ? PX : COARSE); }
    for (const t of this.list) { const have = this.tiles.get(t.key); if (have.res < PX) return this.start(t, PX); }
    return null;
  }
  start(t, res) { const have = this.tiles.get(t.key); if (have) have.stale = false; return { t, res, it: this.build(t.i, t.j, res) }; }
  // The ground in tile (i,j) at res x res: heights on a grid of pixel centres with a 1 px pad (slopes for the land
  // cover and the hillshade), then a colour per pixel. Yields every row. Returns a canvas (shared per res).
  *build(i, j, res) {
    const W = this.w, T = this.T, x0 = i * T, z0 = j * T, st = T / res, n = res + 2, H = new Float32Array(n * n);
    const core = this.inCore(i, j); // (the core: its baked grid, with the airport, roads and towns flattened in)
    for (let b = 0; b < n; b++) {
      const z = z0 + (b - 0.5) * st;
      for (let a = 0; a < n; a++) H[b * n + a] = core ? W.sampleGrid(x0 + (a - 0.5) * st, z) : W.height(x0 + (a - 0.5) * st, z);
      yield;
    }
    let S = this.scratch.get(res);
    if (!S) { const c = document.createElement('canvas'); c.width = c.height = res; const g = c.getContext('2d'); S = { c, g, img: g.createImageData(res, res) }; this.scratch.set(res, S); }
    const real = !!W.real; if (!real) this.lightFor();
    const d = S.img.data, c = this.c, nrm = this.nrm, wl = W.waterLevel, L = this.light, lk = 0.8 / L.y;
    const rivers = !real && W.bake && !W.bake.dry && this.river, cover = W.cover, WL = this.water;
    for (let y = 0; y < res; y++) {
      const wz = z0 + (y + 0.5) * st;
      for (let x = 0; x < res; x++) {
        const p = (y + 1) * n + x + 1, h = H[p], k = (y * res + x) * 4, wx = x0 + (x + 0.5) * st;
        d[k + 3] = 255;
        if (h < wl) { const q = Math.min(127, ((wl - h) * 2) | 0) * 3; d[k] = WL[q]; d[k + 1] = WL[q + 1]; d[k + 2] = WL[q + 2]; continue; }
        nrm.set(H[p - 1] - H[p + 1], 2 * st, H[p - n] - H[p + n]).normalize();
        const slope = 1 - nrm.y;
        W.baseColor(wx, wz, h, slope, c, nrm);
        if (real) { d[k] = c.r * 255; d[k + 1] = c.g * 255; d[k + 2] = c.b * 255; continue; } // (the imagery is already shaded)
        if (rivers && cover.L[0] > 0.5 && slope < 0.3) { d[k] = rivers[0]; d[k + 1] = rivers[1]; d[k + 2] = rivers[2]; continue; } // (baseColor just read the land map into cover.L)
        // hillshade: 1 on the flat, brighter facing the sun, darker turned away
        const sh = Math.min(1.35, Math.max(0.5, 1 + (nrm.dot(L) - L.y) * lk));
        d[k] = c.r * 255 * sh; d[k + 1] = c.g * 255 * sh; d[k + 2] = c.b * 255 * sh;
      }
      yield;
    }
    S.g.putImageData(S.img, 0, 0);
    return S.c;
  }
  // the hillshade's light: the sun, kept at least 35° up (a low sun would black out every valley); at night the
  // usual map light from the north-west. Returns a key that changes when it moves noticeably.
  lightFor() {
    const s = this.w.sunDir, L = this.light;
    if (s && s.y > 0) { const hl = Math.hypot(s.x, s.z) || 1, e = Math.max(Math.asin(Math.min(1, s.y)), 0.61); L.set((s.x / hl) * Math.cos(e), Math.sin(e), (s.z / hl) * Math.cos(e)); } else L.set(-0.45, 0.77, -0.45).normalize();
    return Math.round(Math.atan2(L.x, L.z) * 20) + ',' + Math.round(L.y * 20);
  }
  // a built image into the tile's own canvas (scaled up when coarse), with the core's overlays on top
  finish(t, res, src) {
    let tile = this.tiles.get(t.key);
    if (!tile) {
      let c = this.pool.pop(); if (!c) { c = document.createElement('canvas'); c.width = c.height = PX; }
      tile = { key: t.key, i: t.i, j: t.j, c, g: c.getContext('2d'), res: 0, stale: false, used: this.frame };
      this.tiles.set(t.key, tile);
    }
    const g = tile.g; g.imageSmoothingEnabled = true; g.drawImage(src, 0, 0, PX, PX);
    if (this.inCore(t.i, t.j)) this.overlay(g, t.i, t.j);
    tile.res = res; this.mosDirty = true; this.stats.built++;
  }
  // Runways, and at procedural places the roads, rail and towns (real places: the imagery shows them), drawn in world
  // metres through the tile's transform. Same widths in px as the old single core image (the same scale).
  overlay(g, i, j) {
    const W = this.w, T = this.T, k = PX / T, L = this.rwyLen;
    g.save(); g.setTransform(k, 0, 0, k, -i * T * k, -j * T * k);
    g.fillStyle = '#222'; for (const r of this.runways) g.fillRect(r.x - 1.5 / k, -L / 2, 3 / k, L);
    if (!W.real) {
      const line = (pts, close) => { g.beginPath(); pts.forEach((p, m) => (m ? g.lineTo(p.x, p.z) : g.moveTo(p.x, p.z))); if (close) g.closePath(); g.stroke(); };
      for (const rd of this.lines.get(this.key(i, j)) || []) {
        if (rd.rail) { g.strokeStyle = 'rgba(60,40,30,0.9)'; g.lineWidth = 1.1 / k; g.setLineDash([2 / k, 2 / k]); line(rd.pts); g.setLineDash([]); continue; }
        g.strokeStyle = rd.kind === 'highway' ? 'rgba(250,220,120,0.9)' : 'rgba(240,240,230,0.7)'; g.lineWidth = (rd.kind === 'street' ? 0.6 : 1.1) / k; line(rd.pts, rd.closed);
      }
      g.fillStyle = 'rgba(255,230,200,0.85)';
      for (const tw of W.net.towns) { const r = (3.5 * tw.size + 1.5) / k; if (tw.c.x + r < i * T || tw.c.x - r > (i + 1) * T || tw.c.z + r < j * T || tw.c.z - r > (j + 1) * T) continue; g.beginPath(); g.arc(tw.c.x, tw.c.z, r, 0, 7); g.fill(); }
    }
    g.restore();
  }
  // the composite around (px,pz): the n x n tiles from the one holding the view square's corner, background where a
  // tile isn't built yet; redrawn only when that corner moves to another tile or a tile was built
  view(px, pz) {
    const T = this.T, n = this.n, oi = Math.floor((px - RANGE) / T), oj = Math.floor((pz - RANGE) / T);
    if (this.mosDirty || !this.mosAt || this.mosAt[0] !== oi || this.mosAt[1] !== oj) {
      const g = this.mg; this.mosDirty = false; this.mosAt = [oi, oj];
      g.fillStyle = MAP_BG; g.fillRect(0, 0, n * PX, n * PX);
      for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) { const t = this.tiles.get(this.key(oi + a, oj + b)); if (t?.res) g.drawImage(t.c, a * PX, b * PX); }
    }
    return { c: this.mos, x0: oi * T, z0: oj * T, span: n * T };
  }
  // New data for the area x0..x1, z0..z1 (world m), e.g. streamed geodata: the tiles over it are rebuilt (each keeps
  // showing its old image until the new one is done). One pixel of margin: the slopes reach into the neighbours.
  invalidate(x0, z0, x1, z1) {
    const T = this.T, m = (2 * T) / PX;
    for (let i = Math.floor((Math.min(x0, x1) - m) / T); i <= Math.floor((Math.max(x0, x1) + m) / T); i++) for (let j = Math.floor((Math.min(z0, z1) - m) / T); j <= Math.floor((Math.max(z0, z1) + m) / T); j++) {
      const k = this.key(i, j), t = this.tiles.get(k); if (t) t.stale = true;
      if (this.job?.t.key === k) this.job.redo = true;
    }
  }
}
