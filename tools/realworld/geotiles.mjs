#!/usr/bin/env node
// Bake the coarse streamed backdrop into each real place, so the first view needs nothing from outside hosts.
//
// Usage:  node tools/realworld/geotiles.mjs [place ...] [--zooms 6,8,10]   (default: every place in assets/real/, all three)
// Writes: assets/real/<place>/geo.bin
//
// src/geostream.js streams elevation (AWS Terrain Tiles, Terrarium PNG) and imagery (EOX Sentinel-2 cloudless 2016,
// CC BY 4.0) past the baked squares; before a World is built, prime() fetches what the first view needs. This asks the
// game's own GeoStream.plan for that set (planned around the start, standing still, at the largest far-field radius),
// keeps the zoom levels asked for, downloads each tile once and packs the files byte for byte as served, so the game
// decodes them exactly like a fetched tile (same worker decode, per-tile sea carve, grading and tint). Finer tiles keep
// streaming from the network.
//
// geo.bin: 'SKG1', uint32 LE header length, header JSON { v: 1, tiles: [[kind 'e'|'i', z, x, y, bytes], ...] }, then
// the tile files back to back in header order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeoStream, geoTileUrl } from '../../src/geostream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BAND = 5000; // realworld.js BAND: the stream's inset is the coarse square less this
const RADII = [130000, 200000]; // prime's default far-field radius, and at least the World's (viewDist: 23.5 x core / 4, New York's ~194 km)
const UA = 'skywright-bake/1.0 (offline asset bake for a hobby flight game)';

const args = process.argv.slice(2);
let zooms = [6, 8, 10]; // (everything prime asks for: z10 only where the start is near the coarse square's edge)
const zi = args.indexOf('--zooms');
if (zi >= 0) { zooms = args[zi + 1].split(',').map(Number); args.splice(zi, 2); }
const places = args.length ? args : fs.readdirSync(path.join(ROOT, 'assets/real')).filter((d) => fs.existsSync(path.join(ROOT, 'assets/real', d, 'meta.json')));

async function get(url) {
  for (let n = 0; ; n++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (n >= 3) throw e; await new Promise((res) => setTimeout(res, 1000 * 2 ** n)); }
  }
}

for (const id of places) {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/real', id, 'meta.json'), 'utf8')), F = meta.far;
  const want = new Map();
  for (const R of RADII) {
    const s = new GeoStream(meta, [F.x0 + BAND, F.z0 + BAND, F.x0 + F.size - BAND, F.z0 + F.size - BAND], { h: 0, c: [0, 0, 0] }, null, 0);
    s.radius = () => R; s.plan(0, 0); s.dispose();
    for (const q of s.queue) if (zooms.includes(q.Z)) want.set(`${q.kind},${q.Z},${q.tx},${q.ty}`, q);
  }
  const list = [...want.values()].sort((a, b) => a.Z - b.Z || a.kind.localeCompare(b.kind) || a.ty - b.ty || a.tx - b.tx);
  const blobs = await Promise.all(list.map((q) => get(geoTileUrl(q.kind, q.Z, q.tx, q.ty))));
  const hdr = Buffer.from(JSON.stringify({ v: 1, tiles: list.map((q, k) => [q.kind, q.Z, q.tx, q.ty, blobs[k].length]) }));
  const len = Buffer.alloc(4); len.writeUInt32LE(hdr.length);
  const out = Buffer.concat([Buffer.from('SKG1'), len, hdr, ...blobs]);
  fs.writeFileSync(path.join(ROOT, 'assets/real', id, 'geo.bin'), out);
  const by = {}; list.forEach((q, k) => { const t = by[q.kind + q.Z] || (by[q.kind + q.Z] = [0, 0]); t[0]++; t[1] += blobs[k].length; });
  console.log(`${id}: ${list.length} tiles, ${out.length} bytes  ` + Object.entries(by).map(([k, [n, b]]) => `${k} ${n} (${(b / 1024).toFixed(0)} KB)`).join(', '));
}
