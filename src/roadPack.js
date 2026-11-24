// The graded road network, baked at deploy (#228: "make it efficient to load"): tools/bake/roadpack.mjs builds each real
// place's World in Node and writes its roads (realworld.js network + roads.js gradeReal, the airport road included,
// before the stunt sites are cut out) to assets/boot/roads-<id>.bin.gz, keyed by the deploy's ROADS (a hash of the road
// code and data, src/version.js) and PACK_V. At load (realworld.js) a pack with this build's ROADS replaces building the
// network and grading it (~1.6 s of New York's start); locally (ROADS 'dev'), or with a stale or missing pack, the World
// works them out as before.
//
// Layout (little-endian): uint32 header length, JSON header { key, v, roads, points, jn }, padded to 4 bytes; then
//   per point: x, y, z as centimetre steps from the road's previous point int16 (its first point: per road, float32);
//     flags uint8 (1 bridge, 2 span: a suspended span, no piers, 4 a tunnel's tube)
//   per road: first point x, y, z float32
//   per road: start, count uint32; jnStart, jnCount uint32; kind, cls, width x 4, flags (1 real, 2 baked, 4 gate,
//     8 roundabout, 16 one-way along, 32 one-way against, 64 tunnel), lanes uint8; layer int8; rank float32; gate h, x, z float32
//   jn: point index (within its road) uint32, node int32
import * as THREE from 'three';

export const PACK_V = 3; // bump with any change to how roads are built or graded: older packs are then ignored
const KINDS = ['highway', 'main', 'street', 'rail'];

export function encodeRoads(roads, key) {
  const R = roads.length; let P = 0, J = 0;
  for (const rd of roads) { P += rd.pts.length; J += rd.jn?.length || 0; }
  const hdr = new TextEncoder().encode(JSON.stringify({ key, v: PACK_V, roads: R, points: P, jn: J }));
  const pad = (n) => (4 - (n % 4)) % 4, hl = hdr.length + pad(hdr.length + 4);
  const sizes = [P * 6, P, R * 12, R * 16, R * 6, R * 16, J * 8];
  const total = 4 + hl + sizes.reduce((a, n) => a + n + pad(n), 0), buf = new ArrayBuffer(total), u8 = new Uint8Array(buf);
  new DataView(buf).setUint32(0, hl, true); u8.set(hdr, 4); u8.fill(32, 4 + hdr.length, 4 + hl);
  let o = 4 + hl; const at = (T, n) => { const a = new T(buf, o, n); o += n * T.BYTES_PER_ELEMENT; o += pad(o); return a; };
  const dq = at(Int16Array, P * 3), pf = at(Uint8Array, P), p0 = at(Float32Array, R * 3), rs = at(Uint32Array, R * 4), ri = at(Uint8Array, R * 6), rf = at(Float32Array, R * 4), jj = at(Int32Array, J * 2);
  let p = 0, j = 0;
  roads.forEach((rd, k) => {
    rs[k * 4] = p; rs[k * 4 + 1] = rd.pts.length; rs[k * 4 + 2] = j; rs[k * 4 + 3] = rd.jn?.length || 0;
    const f0 = rd.pts[0]; p0[k * 3] = f0.x; p0[k * 3 + 1] = f0.y; p0[k * 3 + 2] = f0.z;
    let px = 0, py = 0, pz = 0; // (the previous point, in whole centimetres from the first: steps add up exactly)
    for (let i = 0; i < rd.pts.length; i++, p++) {
      const q = rd.pts[i], cx = Math.round((q.x - f0.x) * 100), cy = Math.round((q.y - f0.y) * 100), cz = Math.round((q.z - f0.z) * 100);
      const dx = cx - px, dy = cy - py, dz = cz - pz; if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > 32767) throw new Error(`roadPack: a step over 327 m on road ${k}`);
      dq[p * 3] = dx; dq[p * 3 + 1] = dy; dq[p * 3 + 2] = dz; px = cx; py = cy; pz = cz; pf[p] = (rd.bridge?.[i] ? 1 : 0) | (rd.span?.[i] ? 2 : 0) | (rd.tube?.[i] ? 4 : 0);
    }
    for (const [i, nd] of rd.jn || []) { jj[j * 2] = i; jj[j * 2 + 1] = nd; j++; }
    ri[k * 6] = Math.max(0, KINDS.indexOf(rd.kind)); ri[k * 6 + 1] = rd.cls ?? 2; ri[k * 6 + 2] = Math.min(255, Math.round(rd.width * 4));
    ri[k * 6 + 3] = (rd.real ? 1 : 0) | (rd.baked ? 2 : 0) | (rd.gate ? 4 : 0) | (rd.roundabout ? 8 : 0) | (rd.oneway > 0 ? 16 : 0) | (rd.oneway < 0 ? 32 : 0) | (rd.tunnel ? 64 : 0);
    ri[k * 6 + 4] = rd.lanes || 0; ri[k * 6 + 5] = ((rd.layer || 0) + 256) % 256;
    rf[k * 4] = rd.rank ?? k; rf[k * 4 + 1] = rd.gate?.h ?? 0; rf[k * 4 + 2] = rd.gate?.x ?? 0; rf[k * 4 + 3] = rd.gate?.z ?? 0;
  });
  return buf;
}

// -> { key, v, roads: [...] } in realworld.js network's shape (graded: pts carry their heights), or null if it isn't one
export function decodeRoads(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true), H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const pad = (n) => (4 - (n % 4)) % 4, P = H.points, R = H.roads, J = H.jn;
  let o = 4 + hl; const at = (T, n) => { const a = new T(buf, o, n); o += n * T.BYTES_PER_ELEMENT; o += pad(o); return a; };
  const dq = at(Int16Array, P * 3), pf = at(Uint8Array, P), p0 = at(Float32Array, R * 3), rs = at(Uint32Array, R * 4), ri = at(Uint8Array, R * 6), rf = at(Float32Array, R * 4), jj = at(Int32Array, J * 2);
  const roads = new Array(R);
  for (let k = 0; k < R; k++) {
    const s = rs[k * 4], n = rs[k * 4 + 1], js = rs[k * 4 + 2], jn = rs[k * 4 + 3], f = ri[k * 6 + 3];
    const pts = new Array(n), bridge = new Array(n); let span = null, tube = null;
    let cx = 0, cy = 0, cz = 0; const fx = p0[k * 3], fy = p0[k * 3 + 1], fz = p0[k * 3 + 2];
    for (let i = 0; i < n; i++) { const q = s + i; cx += dq[q * 3]; cy += dq[q * 3 + 1]; cz += dq[q * 3 + 2]; pts[i] = new THREE.Vector3(fx + cx / 100, fy + cy / 100, fz + cz / 100); bridge[i] = !!(pf[q] & 1); if (pf[q] & 2) (span ??= new Array(n).fill(false))[i] = true; if (pf[q] & 4) (tube ??= new Array(n).fill(false))[i] = true; }
    const rd = { pts, bridge, kind: KINDS[ri[k * 6]], cls: ri[k * 6 + 1], width: ri[k * 6 + 2] / 4, real: !!(f & 1), oneway: f & 16 ? 1 : f & 32 ? -1 : 0, roundabout: !!(f & 8), lanes: ri[k * 6 + 4], layer: ri[k * 6 + 5] > 127 ? ri[k * 6 + 5] - 256 : ri[k * 6 + 5], rank: rf[k * 4], jn: [] };
    if (f & 2) { rd.baked = true; rd.span = span || new Array(n).fill(false); }
    if (f & 4) rd.gate = { h: rf[k * 4 + 1], x: rf[k * 4 + 2], z: rf[k * 4 + 3] };
    if (f & 64) { rd.tunnel = true; rd.tube = tube || new Array(n).fill(false); }
    for (let q = js; q < js + jn; q++) rd.jn.push([jj[q * 2], jj[q * 2 + 1]]);
    roads[k] = rd;
  }
  return { key: H.key, v: H.v, roads };
}
