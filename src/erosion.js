// Analytic erosion: carves branching gullies and ridges into any height function, point by point.
// No simulation, so the endless streamed tiles stay seamless and physics sees exactly what is drawn.
// Technique: "eroded terrain noise" (Clay John / runevision): Gabor-like stripes aligned with the
// downhill direction, summed over jittered cells, layered over octaves with each octave steered by
// the slope of the ones before it, so small gullies branch off big ones.

const TAU = Math.PI * 2;
// cheap integer hash -> two jitters in [0,0.5)
function jit(ix, iz, seed, out) {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  out[0] = (h & 0xffff) / 131072; out[1] = (h >>> 16) / 131072;
}
// exp(-2 d^2) for d^2 in [0, 4.5], tabulated
const EXP = new Float32Array(1025); for (let i = 0; i <= 1024; i++) EXP[i] = Math.exp(-2 * (i / 1024) * 4.5);
const J = [0, 0];
// One octave. p in cell units, (dx,dz) = unit vector across the slope. Returns [value, d/dx, d/dz] (cell units).
function stripes(px, pz, dx, dz, seed, out) {
  const ix = Math.floor(px), iz = Math.floor(pz), fx = px - ix, fz = pz - iz;
  let v = 0, gx = 0, gz = 0, wt = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    jit(ix - i, iz - j, seed, J);
    const ox = fx + i - J[0] - 0.25, oz = fz + j - J[1] - 0.25, d2 = ox * ox + oz * oz;
    if (d2 >= 4.5) continue;
    const w = EXP[(d2 * 227.5) | 0];
    const m = (ox * dx + oz * dz) * TAU, c = Math.cos(m), s = Math.sin(m) * w * TAU;
    v += c * w; gx -= s * dx; gz -= s * dz; wt += w;
  }
  out[0] = v / wt; out[1] = gx / wt; out[2] = gz / wt;
}

// Wrap height(x,z) in metres. Options: cell = first-octave gully spacing (m), depth = how deep gullies cut
// relative to that spacing, octaves, slope0/slope1 = slope range over which erosion fades in (flat ground stays flat).
export function erode(height, { cell = 520, depth = 0.11, octaves = 3, slope0 = 0.04, slope1 = 0.45, seed = 1, span = 0.25 } = {}) {
  // The steering slope is the big-shape downhill, measured over a quarter cell. Base heights for it are cached on a
  // lattice of that spacing and the node gradients interpolated, which keeps the cost near one base sample per point.
  const e = cell * span, o = [0, 0, 0], G = [0, 0];
  let cache = new Map();
  const node = (i, j) => {
    const k = i * 1048576 + j; let h = cache.get(k);
    if (h === undefined) { if (cache.size > 400000) cache = new Map(); h = height(i * e, j * e); cache.set(k, h); }
    return h;
  };
  const ng = (i, j, out) => { out[0] = (node(i + 1, j) - node(i - 1, j)) / (2 * e); out[1] = (node(i, j + 1) - node(i, j - 1)) / (2 * e); };
  const g00 = [0, 0], g10 = [0, 0], g01 = [0, 0], g11 = [0, 0];
  const grad = (x, z) => {
    const fx = x / e, fz = z / e, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    ng(i, j, g00); ng(i + 1, j, g10); ng(i, j + 1, g01); ng(i + 1, j + 1, g11);
    for (let k = 0; k < 2; k++) G[k] = (g00[k] * (1 - u) + g10[k] * u) * (1 - v) + (g01[k] * (1 - u) + g11[k] * u) * v;
  };
  return function eroded(x, z) {
    const h = height(x, z);
    grad(x, z);
    const gx = G[0], gz = G[1], sl = Math.hypot(gx, gz);
    const fade = sl <= slope0 ? 0 : sl >= slope1 ? 1 : ((sl - slope0) / (slope1 - slope0)) ** 0.8;
    if (fade === 0) return h;
    // across-slope direction, plus feedback from coarser octaves so finer gullies branch
    let ax = -gz, az = gx, acc = 0, a = 1, c = cell;
    for (let k = 0; k < octaves; k++) {
      const l = Math.hypot(ax, az) || 1;
      stripes(x / c, z / c, ax / l, az / l, seed + k * 13, o);
      acc += (o[0] - 0.4) * a * c * depth; // biased so it cuts into slopes more than it piles up
      // the gully's own slope (m/m) bends the next octave's direction
      const sx = o[1] * a * depth, sz = o[2] * a * depth;
      ax += -sz * 1.5; az += sx * 1.5;
      a *= 0.42; c *= 0.5;
    }
    return h + acc * fade;
  };
}
