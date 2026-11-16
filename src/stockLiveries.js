// Paint schemes for the stock vehicles (see liveries.js for the layer types). Coordinates are vehicle-space metres
// of the preset as built in design.js: forward -Z, up +Y, right +X. Side decals are drawn nose-LEFT.
import { LIVERIES, ART } from './liveries.js';

const L = (id, def) => { LIVERIES[id] = def; };
const BIG = 1e3, pad = (a, d) => [0, 1, 2].map((k) => a[k] ?? d);
const box = (min, max) => ({ min: pad(min, -BIG), max: pad(max, BIG) }); // [x, y, z]; missing / null = unbounded

// ---------- drawings ----------
// lightning bolt pointing to the right of the drawing (towards the tail on the left side)
const bolt = (w, h, fill = '#f2b705', edge = '#111') => ART.custom(w, h, (g) => {
  const P = [[0.02, 0.42], [0.42, 0.3], [0.38, 0.5], [0.72, 0.36], [0.68, 0.55], [0.98, 0.5], [0.62, 0.78], [0.66, 0.6], [0.32, 0.74], [0.36, 0.56], [0.02, 0.62]];
  g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h))); g.closePath();
  g.lineJoin = 'round'; g.lineWidth = h * 0.06; g.strokeStyle = edge; g.stroke(); g.fillStyle = fill; g.fill();
});
// A star field (seeded, so every build looks the same) that reads as sparkle, not dirt: a few big four-point twinkles
// with long thin rays, some five-point stars, a sprinkling of pin-prick dots, each with a soft glow round it. n is the
// number of stars and twinkles; sizes vary over 1:4. Use it with a decal layer's glow so they shine.
const starField = (w, h, n, cols) => ART.custom(w, h, (g) => {
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647), pts = [];
  const free = (x, y, r) => pts.every(([px, py, pr]) => Math.hypot(px - x, py - y) > (pr + r) * 1.3); // keep them apart: sparse, not clumped
  const glow = (x, y, r, c) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c + '88'); gr.addColorStop(0.25, c + '30'); gr.addColorStop(1, c + '00'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  const star = (x, y, r, pointsN, inner) => { g.beginPath(); for (let k = 0; k < pointsN * 2; k++) { const a = -Math.PI / 2 + (k * Math.PI) / pointsN, rr = k % 2 ? r * inner : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill(); };
  for (let i = 0, tries = 0; i < n && tries < n * 40; tries++) {
    const big = i < Math.max(2, Math.round(n * 0.18)), r = (big ? 0.12 + rnd() * 0.05 : 0.03 + rnd() * 0.035) * h, x = r + rnd() * (w - 2 * r), y = r + rnd() * (h - 2 * r);
    if (!free(x, y, r)) continue;
    pts.push([x, y, r]); const c = cols[i % cols.length]; i++;
    glow(x, y, r * (big ? 0.75 : 1.0), c);
    g.fillStyle = c;
    if (big) { star(x, y, r, 4, 0.16); g.fillStyle = '#ffffff'; star(x, y, r * 0.45, 4, 0.3); } // a twinkle: long rays and a white-hot centre
    else { star(x, y, r * 0.75, 5, 0.45); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, r * 0.16, 0, 7); g.fill(); }
  }
  for (let i = 0; i < n * 1.5; i++) { const x = rnd() * w, y = rnd() * h, r = (0.005 + rnd() * 0.006) * h; if (!free(x, y, r * 2)) continue; glow(x, y, r * 3, cols[i % cols.length]); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
});
// googly eyes and a big grin (nose to the left)
const face = ART.custom(640, 420, (g, w, h) => {
  for (const [x, y, r] of [[0.62, 0.3, 0.2]]) {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x * w, y * h, r * h, 0, 7); g.fill(); g.lineWidth = h * 0.025; g.strokeStyle = '#111'; g.stroke();
    g.fillStyle = '#111'; g.beginPath(); g.arc((x - 0.06) * w, (y + 0.05) * h, r * h * 0.5, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc((x - 0.08) * w, (y + 0.0) * h, r * h * 0.14, 0, 7); g.fill();
  }
  g.beginPath(); g.moveTo(0.06 * w, 0.62 * h); g.quadraticCurveTo(0.3 * w, 0.98 * h, 0.7 * w, 0.72 * h); g.quadraticCurveTo(0.35 * w, 0.82 * h, 0.06 * w, 0.62 * h);
  g.fillStyle = '#7a0d2a'; g.fill(); g.lineWidth = h * 0.025; g.strokeStyle = '#111'; g.stroke();
  g.fillStyle = '#fff'; for (let i = 0; i < 4; i++) { const x = (0.2 + i * 0.1) * w; g.fillRect(x, 0.69 * h + i * 0.012 * h, 0.06 * w, 0.06 * h); }
});
// monster-truck grille: a shark grin across the front (the headlights are modelled on the body) (front projection: drawing as seen from ahead)
const grin = ART.custom(900, 360, (g, w, h) => {
  g.fillStyle = '#111'; g.beginPath(); g.roundRect(0.02 * w, 0.04 * h, 0.96 * w, 0.92 * h, h * 0.18); g.fill();
  g.fillStyle = '#9b0f1c'; g.beginPath(); g.roundRect(0.17 * w, 0.14 * h, 0.66 * w, 0.72 * h, h * 0.16); g.fill();
  g.fillStyle = '#fbfbf6'; g.strokeStyle = '#222'; g.lineWidth = 3; const N = 8, x0 = 0.17 * w, W = 0.66 * w;
  for (let i = 0; i < N; i++) { const a = x0 + (i / N) * W, b = a + W / N, m = (a + b) / 2;
    g.beginPath(); g.moveTo(a, 0.14 * h); g.lineTo(b, 0.14 * h); g.lineTo(m, 0.48 * h); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(a, 0.86 * h); g.lineTo(b, 0.86 * h); g.lineTo(m, 0.54 * h); g.closePath(); g.fill(); g.stroke(); }
});
// airline tail logo: an orange-ringed disc with a white paper plane
const planeLogo = ART.custom(512, 512, (g, s) => {
  g.fillStyle = '#ff8a1f'; g.beginPath(); g.arc(s / 2, s / 2, s * 0.47, 0, 7); g.fill();
  g.fillStyle = '#16306e'; g.beginPath(); g.arc(s / 2, s / 2, s * 0.4, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0.2 * s, 0.56 * s); g.lineTo(0.8 * s, 0.3 * s); g.lineTo(0.5 * s, 0.76 * s); g.lineTo(0.46 * s, 0.6 * s); g.closePath(); g.fill();
  g.fillStyle = '#c9d3e6'; g.beginPath(); g.moveTo(0.46 * s, 0.6 * s); g.lineTo(0.8 * s, 0.3 * s); g.lineTo(0.42 * s, 0.7 * s); g.closePath(); g.fill();
});

// ---------- the liveries ----------
// Kestrel: white trainer with a red and blue swoosh rising to the tail, red tips, race number on the fin
L('kestrel', {
  name: 'Swoosh',
  art: { num: ART.text('21', 260, 160, { fill: '#f4f4f0', italic: true }), title: ART.text('KESTREL', 600, 130, { fill: '#1d4e89', italic: true }) },
  layers: [
    { type: 'band', on: ['body'], color: 0xc8102e, dir: [0, 1, -0.13], lo: -0.3, hi: -0.1 },
    { type: 'band', on: ['body'], color: 0x1d4e89, dir: [0, 1, -0.13], lo: -0.43, hi: -0.34 },
    { type: 'band', on: ['wing'], color: 0xc8102e, dir: [1, 0, 0], absx: true, lo: 4.35 },
    { type: 'band', on: ['wing'], color: 0x1d4e89, dir: [1, 0, 0], absx: true, lo: 4.1, hi: 4.25 },
    { type: 'band', on: ['t_hstab'], color: 0xc8102e, dir: [1, 0, 0], absx: true, lo: 1.25 },
    { type: 'decal', on: ['t_vfin'], art: 'num', at: [3.95, 1.0], size: [0.7, 0.42], text: true },
    { type: 'decal', on: ['fus_light'], art: 'title', at: [1.6, 0.5], size: [1.5, 0.32], text: true },
  ],
});

// Viper: gunmetal aggressor with a sharkmouth, lightning-bolt fin and a light belly
L('viper', {
  name: 'Shark',
  art: { shark: ART.shark(640, 300), bolt: bolt(512, 200), num: ART.text('07', 256, 160, { fill: '#f4f4f0' }) },
  finish: [{ on: ['body', 'wing', 'tail', 'x_tank'], kind: 'satin' }],
  layers: [
    { type: 'band', on: ['body', 'x_tank'], color: 0xaab2bb, dir: [0, 1, 0], hi: -0.34 },
    { type: 'decal', on: ['fus_fighter'], art: 'shark', at: [-4.1, -0.05], size: [3.7, 1.45] },
    { type: 'decal', on: ['fus_fighter'], art: 'num', at: [-0.7, -0.12], size: [0.75, 0.46], text: true, box: box([0.6], []) },
    { type: 'decal', on: ['t_jet_vfin'], art: 'bolt', at: [4.4, 1.85], size: [2.5, 1.0] },
    { type: 'band', on: ['t_jet_vfin'], color: 0x15161a, dir: [0, 1, 0], lo: 3.05 },
    { type: 'band', on: ['x_tank'], color: 0xc8102e, dir: [0, 0, 1], hi: 0.85 },
    { type: 'band', on: ['wing'], color: 0x15161a, dir: [1, 0, 0], absx: true, lo: 5.4 },
  ],
});

// Tempest: olive warbird, invasion stripes, yellow-and-black checkerboard cowling
L('tempest', {
  name: 'Invasion',
  art: { title: ART.text('TEMPEST', 600, 140, { fill: '#f2b705', stroke: '#111', strokeW: 10, italic: true }) },
  finish: [{ on: ['fus_sport', 'wing', 'tail', 'ck_bubble', 'g_main'], kind: 'matte' }],
  layers: [
    { type: 'band', on: ['fus_sport'], color: 0x98a1a3, dir: [0, 1, 0], hi: -0.2 },
    { type: 'band', on: ['wing'], color: 0xf2f2ee, dir: [1, 0, 0], absx: true, lo: 2.0, hi: 4.25 },
    { type: 'band', on: ['wing'], color: 0x111111, dir: [1, 0, 0], absx: true, off: -2.45, period: 0.9, lo: 0, hi: 0.45, box: box([2.44], [3.81]) },
    { type: 'band', on: ['fus_sport'], color: 0xf2f2ee, dir: [0, 0, 1], lo: 0.73, hi: 2.08 },
    { type: 'band', on: ['fus_sport'], color: 0x111111, dir: [0, 0, 1], off: -1.0, period: 0.54, lo: 0, hi: 0.27, box: box([null, null, 0.99], [null, null, 1.82]) },
    { type: 'checker', on: ['e_radial'], proj: 'around', color: 0xf2b705, color2: 0x111111, cell: 0.32, radius: 0.75, axisY: 0.05 },
    { type: 'band', on: ['t_vfin'], color: 0xf2b705, dir: [0, 1, 0], lo: 1.35 },
    { type: 'decal', on: ['fus_sport'], art: 'title', at: [-1.55, 0.02], size: [1.6, 0.36], text: true },
  ],
});

// Twin Pod: blue racing pods with yellow lightning bolts, numbers 1 and 2, checkerboard centre wing
L('twinpod', {
  name: 'Thunder Twins',
  art: { bolt: bolt(700, 180), one: ART.number('1', 200, { ring: '#f2b705' }), two: ART.number('2', 200, { ring: '#f2b705' }) },
  layers: [
    { type: 'decal', on: ['fus_sport'], art: 'bolt', at: [-0.3, -0.02], size: [3.6, 0.8] },
    { type: 'decal', on: ['fus_sport'], art: 'one', at: [1.75, 0.04], size: [0.5, 0.5], text: true, box: box([], [0]) },
    { type: 'decal', on: ['fus_sport'], art: 'two', at: [1.75, 0.04], size: [0.5, 0.5], text: true, box: box([0], []) },
    { type: 'checker', on: ['w_stub'], proj: 'top', color: 0x1d4e89, color2: 0xf2f2ee, cell: 0.42 },
    { type: 'band', on: ['w_taper'], color: 0x1d4e89, dir: [1, 0, 0], absx: true, lo: 7.4 },
    { type: 'band', on: ['w_taper'], color: 0xf2b705, dir: [1, 0, 0], absx: true, lo: 7.15, hi: 7.32 },
  ],
});

// Albatross: sunshine-yellow island seaplane riding on a teal wave
L('albatross', {
  name: 'Island Hopper',
  art: { title: ART.text('ALBATROSS', 700, 130, { fill: '#0f4f5c', italic: true }) },
  layers: [
    { type: 'band', on: ['body'], color: 0x0f6f7c, dir: [0, 1, 0], hi: -0.2, wave: 0.09, waveLen: 1.7 },
    { type: 'band', on: ['body'], color: 0xf4f4f0, dir: [0, 1, 0], lo: -0.2, hi: -0.11, wave: 0.09, waveLen: 1.7 },
    { type: 'band', on: ['g_float'], color: 0x0f6f7c, dir: [0, 1, 0], hi: -1.5, wave: 0.05, waveLen: 1.3 },
    { type: 'band', on: ['wing'], color: 0x0f6f7c, dir: [1, 0, 0], absx: true, lo: 4.5 },
    { type: 'decal', on: ['fus_light'], art: 'title', at: [1.55, 0.36], size: [2.1, 0.36], text: true },
  ],
});

// Jumbo: Skywright Airlines (white top, navy belly with a gold pinstripe, navy tail with a paper-plane logo)
L('airline', {
  name: 'Skywright Airlines',
  art: { title: ART.text('SKYWRIGHT', 1000, 150, { fill: '#16306e', weight: 900 }), logo: planeLogo },
  layers: [
    { type: 'band', on: ['body'], color: 0x16306e, dir: [0, 1, 0], hi: -0.82 },
    { type: 'band', on: ['body'], color: 0xe8b400, dir: [0, 1, 0], lo: -0.8, hi: -0.68 },
    { type: 'decal', on: ['fus_airliner'], art: 'title', at: [-3.2, 1.0], size: [10.5, 1.55], text: true },
    { type: 'decal', on: ['t_big_vfin'], art: 'logo', at: [9.7, 4.9], size: [3.3, 3.3] },
    { type: 'band', on: ['t_big_vfin'], color: 0xe8b400, dir: [0, 1, 0], lo: 1.9, hi: 2.15 },
  ],
});

// Centipede: purple party bus with googly eyes, a grin, yellow wavy belly and a checkerboard tail
L('centipede', {
  name: 'Party Bug',
  art: { face, title: ART.text('CENTIPEDE', 1000, 150, { fill: '#f2b705', stroke: '#2c0f40', strokeW: 12, italic: true }) },
  layers: [
    { type: 'band', on: ['body'], color: 0xf2b705, dir: [0, 1, 0], hi: -0.7, wave: 0.25, waveLen: 3 },
    { type: 'band', on: ['body'], color: 0x7bc142, dir: [0, 1, 0], lo: -0.7, hi: -0.45, wave: 0.25, waveLen: 3 },
    { type: 'decal', on: ['ck_airliner'], art: 'face', at: [-13.1, -0.05], size: [4.2, 2.75] },
    { type: 'decal', on: ['fus_airliner'], art: 'title', at: [-1.5, 1.05], size: [11, 1.6], text: true },
    { type: 'checker', on: ['t_big_vfin'], proj: 'side', color: 0x6a2c91, color2: 0xf2b705, cell: 0.9 },
  ],
});

// Kite: white sailplane with a red nose and tips, a blue cheatline and a candy-striped fin
L('kite', {
  name: 'Candy Stripe',
  layers: [
    { type: 'band', on: ['fus_glider'], color: 0xc8102e, dir: [0, 0, 1], hi: -1.45 },
    { type: 'band', on: ['fus_glider'], color: 0x1d4e89, dir: [0, 1, 0.02], lo: -0.07, hi: 0.03 },
    { type: 'band', on: ['w_glider'], color: 0xc8102e, dir: [1, 0, 0], absx: true, lo: 8.1 },
    { type: 'band', on: ['t_hstab'], color: 0xc8102e, dir: [1, 0, 0], absx: true, lo: 1.3 },
    { type: 'band', on: ['t_vfin'], color: 0xc8102e, dir: [0, 1, 0], period: 0.34, lo: 0, hi: 0.17 },
  ],
});

// Firecracker: white jet in red-hot flames, candy-striped boosters, a shower of stars on the delta
L('firecracker', {
  name: 'Fireworks',
  art: { stars: starField(512, 512, 26, ['#f2b705', '#fff6c8', '#ffd24a']), title: ART.text('FIRECRACKER', 900, 140, { fill: '#f4f4f0', stroke: '#7a0a05', strokeW: 10, italic: true }) },
  layers: [
    { type: 'flames', on: ['fus_fighter', 'ck_fighter'], color: 0x7a0a05, z0: -6.5, len: 6.4, yc: -0.08, h: 0.8, n: 5, seed: 11 },
    { type: 'band', on: ['e_rocket'], color: 0xc8102e, dir: [0, 0.8, 0.6], period: 0.7, lo: 0, hi: 0.33 },
    { type: 'decal', on: ['w_delta'], art: 'stars', proj: 'top', at: [2.9, 5.6], size: [3.2, 3.2], absx: true, glow: 0.5 },
    { type: 'band', on: ['w_delta'], color: 0xf2b705, dir: [1, 0, 0], absx: true, lo: 4.6 },
    { type: 'decal', on: ['t_jet_vfin'], art: 'title', at: [4.45, 1.75], size: [2.7, 0.42], text: true },
  ],
});

// Dragonfly: air-rescue red and white
L('rescue', {
  name: 'Air Rescue',
  art: {
    rescue: ART.text('RESCUE', 700, 150, { fill: '#c8102e' }),
    cross: ART.custom(256, 256, (g, w) => {
      g.fillStyle = '#f4f4f0'; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 4, 0, 7); g.fill();
      g.fillStyle = '#c8102e'; const a = w * 0.13, b = w * 0.36; g.fillRect(w / 2 - a, w / 2 - b, a * 2, b * 2); g.fillRect(w / 2 - b, w / 2 - a, b * 2, a * 2);
    }),
    num: ART.text('R-08', 300, 120, { fill: '#f4f4f0' }),
  },
  layers: [
    { type: 'band', on: ['body'], color: 0xf4f4f0, dir: [0, 1, 0], lo: -0.52, hi: -0.08 },
    { type: 'band', on: ['body'], color: 0x1b1b1f, dir: [0, 1, 0], hi: -0.86 },
    { type: 'decal', on: ['fus_heli'], art: 'rescue', at: [0.45, -0.3], size: [1.75, 0.36], text: true },
    { type: 'decal', on: ['fus_heli'], art: 'cross', at: [1.35, 0.32], size: [0.55, 0.55] },
    { type: 'checker', on: ['fus_boom'], proj: 'around', color: 0xf2b705, color2: 0x1b1b1f, cell: 0.13, radius: 0.15, axisY: 0.38, box: box([null, null, 6.0], [null, null, 6.78]) },
    { type: 'decal', on: ['fus_boom'], art: 'num', at: [4.4, 0.38], size: [0.75, 0.3], text: true },
    { type: 'band', on: ['t_vfin'], color: 0xf4f4f0, dir: [0, 1, 0], lo: 1.1, hi: 1.35 },
  ],
});

// Dune Buggy: black with hot-rod flames, a big racing 8, sponsor stickers on the wing
L('buggy', {
  name: 'Desert Flame',
  art: {
    num: ART.number('8', 256, { bg: '#f4f4f0', fg: '#111', ring: '#e8601c' }),
    nitro: ART.text('NITRO', 400, 140, { fill: '#f2b705', stroke: '#111', strokeW: 14, italic: true }),
    wing: ART.text('SKYWRIGHT RACING', 900, 120, { fill: '#f4f4f0', italic: true }),
  },
  layers: [
    { type: 'flames', on: ['fus_buggy'], color: 0x7a0a05, z0: -2.2, len: 2.7, yc: -0.04, h: 0.3, n: 4, seed: 3 },
    { type: 'band', on: ['fus_buggy'], color: 0xe8601c, dir: [0, 1, 0], lo: 0.205, hi: 0.235, box: box([null, null, 0.6], []) },
    { type: 'decal', on: ['fus_buggy'], art: 'num', at: [0.25, -0.05], size: [0.58, 0.58], text: true },
    { type: 'decal', on: ['fus_buggy'], art: 'num', proj: 'top', at: [0, -0.85], size: [0.42, 0.42], box: box([null, 0.15, null], [null, null, -0.6]) },
    { type: 'decal', on: ['c_rearwing'], art: 'nitro', at: [1.92, 0.84], size: [0.55, 0.2], text: true },
    { type: 'decal', on: ['c_rearwing'], art: 'wing', proj: 'top', at: [0, 1.95], size: [-1.4, -0.19] },
  ],
});

// Stardust: X-15-style black rocket plane, satin finish, white titles and a scatter of stars
L('stardust', {
  name: 'Black Rocket',
  art: { title: ART.text('STARDUST', 900, 150, { fill: '#f4f4f0' }), x: ART.text('X-8', 300, 150, { fill: '#f4f4f0' }), stars: starField(512, 512, 16, ['#ffffff', '#cfdcff', '#fff1c4']) },
  finish: [{ on: 'all', kind: 'deep' }],
  layers: [
    { type: 'band', on: 'all', color: 0x06070c }, // deep space black-blue under everything: the stars show up against it
    { type: 'decal', on: ['fus_fighter'], art: 'title', at: [0.4, -0.15], size: [3.0, 0.42], text: true, box: box([0.6], []) },
    { type: 'decal', on: ['t_jet_vfin'], art: 'x', at: [4.45, 1.8], size: [1.2, 0.6], text: true },
    { type: 'decal', on: ['w_swept'], art: 'stars', proj: 'top', at: [3.3, 2.6], size: [3.6, 3.6], absx: true, glow: 0.6 },
    { type: 'band', on: ['fus_fighter', 'ck_fighter'], color: 0x8a9099, dir: [0, 0, 1], lo: -6.6, hi: -6.0 },
  ],
});

// Chomper: blue monster truck with a shark grin and yellow flames (real glass in the cab now)
L('chomper', {
  name: 'Chomper',
  art: { grin, title: ART.text('CHOMPER', 700, 160, { fill: '#f2b705', stroke: '#111', strokeW: 14, italic: true }) },
  layers: [
    { type: 'band', on: ['fus_truck'], color: 0x0b2a5c, dir: [0, 1, 0], hi: 0.12 },
    { type: 'flames', on: ['fus_truck'], color: 0x7a0a05, z0: -2.42, len: 2.6, yc: 0.4, h: 0.28, n: 4, seed: 5 },
    { type: 'decal', on: ['fus_truck'], art: 'grin', proj: 'front', at: [0, 0.36], size: [1.8, 0.72], box: box([], [null, 0.74, -1.9]) },
    { type: 'decal', on: ['fus_truck'], art: 'title', at: [1.55, 0.42], size: [1.35, 0.32], text: true },
  ],
});

// Hornet: yellow air racer, checkerboard cowl and fin, black anti-glare panel, race number 88
L('racer', {
  name: 'Checkmate',
  art: { num: ART.number('88', 256, { ring: '#c8102e' }), bolt: bolt(700, 180, '#c8102e') },
  layers: [
    { type: 'checker', on: ['e_piston'], proj: 'around', color: 0x15161a, color2: 0xf4f4f0, cell: 0.26, radius: 0.5 },
    { type: 'checker', on: ['t_vfin'], proj: 'side', color: 0x15161a, color2: 0xf2b705, cell: 0.26 },
    { type: 'band', on: ['fus_sport'], color: 0x15161a, dir: [0, 1, 0], lo: 0.32, box: box([], [null, null, 0]) },
    { type: 'decal', on: ['fus_sport'], art: 'num', at: [1.3, 0.0], size: [0.6, 0.6], text: true },
    { type: 'decal', on: ['fus_sport'], art: 'bolt', at: [-0.9, -0.1], size: [2.4, 0.55] },
    { type: 'checker', on: ['w_taper'], proj: 'top', color: 0x15161a, color2: 0xf4f4f0, cell: 0.28, box: box([3.6], []), absx: true },
  ],
});

// Rocket: white with a black-and-white roll pattern, red nose and fins, its name down the side (Saturn V style)
L('rocket', {
  name: 'Moonshot',
  art: { title: ART.text('SKYWRIGHT', 1000, 150, { fill: '#c8102e' }) },
  layers: [
    { type: 'band', on: ['fus_rocket', 'x_rcs'], color: 0xc8102e, dir: [0, 0, 1], hi: -5.4 },
    { type: 'checker', on: ['fus_rocket'], proj: 'around', color: 0x15161a, color2: 0xf4f4f0, cell: Math.PI * 0.9 / 2, radius: 0.9, origin: [2.2, 0.0001], box: box([null, null, 2.2], [null, null, 3.95]) },
    { type: 'checker', on: ['fus_rocket'], proj: 'around', color: 0x15161a, color2: 0xf4f4f0, cell: Math.PI * 0.9 / 2, radius: 0.9, origin: [-4.4, 0.0001], box: box([null, null, -4.4], [null, null, -3.0]) },
    { type: 'decal', on: ['fus_rocket'], art: 'title', at: [-0.4, 0], size: [4.6, 0.62], text: true, box: box([0.3], []) },
    { type: 'band', on: ['e_rocket'], color: 0xc8102e, dir: [0, 0, 1], hi: 0.3 },
  ],
});
