// The real places' road network (#228): assets/real/<id>/roads.bin.gz, baked by tools/realworld/bake.py
// (bake_roadnet) from OpenStreetMap: every road class and road tunnel, with its topology. Ways that meet share a node
// (a junction), so the network is a graph: roads.js grades the ways to meet at their junctions' heights, and
// traffic drives from one way onto the next instead of turning round at the end of each.
//
// decodeRoadnet(arrayBuffer) -> { ways, nodes, x, z, node, y, ... } with typed-array views straight onto the buffer
// (no copying): way k's points are start[k] .. start[k] + count[k] - 1 in x / z / node / y.
export const RF = { BRIDGE: 1, TUNNEL: 2, ONEWAY: 4, ONEWAY_BACK: 8, ROUNDABOUT: 16 };
// way classes (bake.py bake_roadnet): 0 motorway / trunk, 1 primary / secondary, 2 tertiary, 3 residential and the
// like; then the ways off the street network (MINOR and up: no traffic, no junction boxes, markings or kerbs, roads.js
// rd.minor): 4 service (alleys, parking aisles), 5 pedestrian (pedestrian streets, paved footpaths), 6 track
export const MINOR = 4, MINOR_KINDS = ['service', 'ped', 'track'];
// surfaces (R.surf, R.asurf): 0 asphalt, 1 paving (stone or concrete pavers), 2 gravel
export const SURF = { ASPHALT: 0, PAVING: 1, GRAVEL: 2 };

export function decodeRoadnet(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true);
  const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let o = 4 + hl;
  const take = (T, n) => { const a = new T(buf, o, n); o += n * T.BYTES_PER_ELEMENT; o += (4 - (o % 4)) % 4; return a; };
  const P = H.points, W = H.ways;
  const R = { v: H.v, ways: W, nodes: H.nodes, points: P };
  R.x = take(Float32Array, P); R.z = take(Float32Array, P); R.node = take(Int32Array, P); R.y = take(Float32Array, P);
  R.start = take(Uint32Array, W);
  // (uint16 counts: an odd number of ways leaves the next array 2 bytes off a 4-byte boundary; take() pads to 4)
  R.count = take(Uint16Array, W); R.cls = take(Uint8Array, W); R.width = take(Uint8Array, W); R.flags = take(Uint8Array, W);
  R.lanes = take(Uint8Array, W); R.layer = take(Int8Array, W);
  // v2: each way's surface; the plazas (pedestrian areas and squares: outlines, counter-clockwise in x, z)
  if (H.v >= 2) {
    R.surf = take(Uint8Array, W); const A = (R.areas = H.areas), AP = H.apoints;
    R.ax = take(Float32Array, AP); R.az = take(Float32Array, AP); R.astart = take(Uint32Array, A); R.acount = take(Uint32Array, A); R.acls = take(Uint8Array, A); R.asurf = take(Uint8Array, A);
  } else { R.surf = new Uint8Array(W); R.areas = 0; }
  return R;
}

// A way's fields, for code that walks the list (landStart, the network): { cls, width (m), bridge, tunnel, oneway
// (+1 along its points, -1 against, 0 two-way), roundabout, lanes, layer, surf, s (first point), n (points), ys (baked deck
// heights or null) }
export function way(R, k) {
  const f = R.flags[k], s = R.start[k], n = R.count[k];
  return { cls: R.cls[k], width: R.width[k] / 4, bridge: !!(f & RF.BRIDGE), tunnel: !!(f & RF.TUNNEL), oneway: f & RF.ONEWAY ? 1 : f & RF.ONEWAY_BACK ? -1 : 0,
    roundabout: !!(f & RF.ROUNDABOUT), lanes: R.lanes[k], layer: R.layer[k], surf: R.surf[k], s, n, ys: Number.isNaN(R.y[s]) ? null : R.y.subarray(s, s + n) };
}
// the plazas: [{ cls, surf, ring: [x, z, ...] }]
export function plazas(R) {
  const out = [];
  for (let a = 0; a < R.areas; a++) { const s = R.astart[a], n = R.acount[a], ring = new Float32Array(n * 2); for (let i = 0; i < n; i++) { ring[i * 2] = R.ax[s + i]; ring[i * 2 + 1] = R.az[s + i]; } out.push({ cls: R.acls[a], surf: R.asurf[a], ring }); }
  return out;
}
