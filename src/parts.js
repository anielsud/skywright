// Parts library. Conventions: forward = -Z, up = +Y, right = +X. Meters / kg / Newtons.
import * as THREE from 'three';
import { M, windowTexture } from './materials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';

// ---------- geometry helpers ----------
// Body of revolution around Z. profile: [[z, r], ...] nose (most negative z) first.
// u = along length, v = around (0 = top, 0.25 = right side, 0.75 = left side).
export function revolve(profile, { segs = 32, sy = 1, sx = 1, yOff = null, cap = false } = {}) {
  const pos = [], uv = [], idx = [];
  const z0 = profile[0][0], z1 = profile[profile.length - 1][0];
  for (let j = 0; j < profile.length; j++) {
    const [z, r] = profile[j];
    const yo = yOff ? yOff(z) : 0;
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      pos.push(Math.sin(th) * r * sx, Math.cos(th) * r * sy + yo, z);
      uv.push((z - z0) / (z1 - z0), i / segs);
    }
  }
  const row = segs + 1;
  for (let j = 0; j < profile.length - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * row + i, b = (j + 1) * row + i, c = (j + 1) * row + i + 1, d = j * row + i + 1;
    idx.push(a, b, c, a, c, d);
  }
  if (cap) { // close open ends with a flat disc (front faces -z, back faces +z)
    for (const [j, front] of [[0, true], [profile.length - 1, false]]) {
      if (profile[j][1] < 0.01) continue;
      const centre = pos.length / 3, yo = yOff ? yOff(profile[j][0]) : 0;
      pos.push(0, yo, profile[j][0]); uv.push(front ? 0 : 1, 0.5);
      for (let i = 0; i < segs; i++) { const a = j * row + i, b = j * row + i + 1; front ? idx.push(centre, a, b) : idx.push(centre, b, a); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// smooth profile from a few control points (catmull-rom in (z,r))
export function smoothProfile(pts, n = 28) {
  const curve = new THREE.SplineCurve(pts.map(([z, r]) => new THREE.Vector2(z, r)));
  return curve.getPoints(n).map((p) => [p.x, Math.max(0, p.y)]);
}

function airfoil(n, thick, camber) {
  // returns closed loop of [x(0..1 chord, LE=0), y] going TE->upper->LE->lower->TE
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos((i / n) * Math.PI));
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = camber * 4 * x * (1 - x);
    up.push([x, yc + yt]); lo.push([x, yc - yt]);
  }
  return { up, lo };
}

// Build a lofted surface between sections. Each section: {x, y, zLE, chord}. Chord range [c0, c1] fraction.
function loft(sections, c0, c1, thick, camber, n = 10, capStart = true, capEnd = true) {
  const { up, lo } = airfoil(40, thick, camber);
  const sample = (arr, x) => { // linear interp of airfoil y at chord fraction x
    for (let i = 1; i < arr.length; i++) if (arr[i][0] >= x) { const a = arr[i - 1], b = arr[i]; const t = (x - a[0]) / (b[0] - a[0] || 1); return a[1] + (b[1] - a[1]) * t; }
    return arr[arr.length - 1][1];
  };
  const xs = [];
  for (let i = 0; i <= n; i++) { const t = i / n; xs.push(c0 + (c1 - c0) * (0.5 - 0.5 * Math.cos(t * Math.PI))); }
  // ring: upper from c1->c0, lower from c0->c1
  const ring = [];
  for (let i = n; i >= 0; i--) ring.push([xs[i], sample(up, xs[i])]);
  for (let i = 1; i < n; i++) ring.push([xs[i], sample(lo, xs[i])]);
  const R = ring.length, pos = [], idx = [], uvs = [];
  sections.forEach((s, k) => { for (const [cx, cy] of ring) { pos.push(s.x, s.y + cy * s.chord, s.zLE + cx * s.chord); uvs.push(cx * s.chord * 0.25, s.x * 0.25 + (cy > 0 ? 0 : 0.5)); } });
  for (let k = 0; k < sections.length - 1; k++) for (let i = 0; i < R; i++) {
    const a = k * R + i, b = k * R + ((i + 1) % R), c = (k + 1) * R + ((i + 1) % R), d = (k + 1) * R + i;
    idx.push(a, d, c, a, c, b);
  }
  const addCap = (k, flip) => {
    const base = pos.length / 3, s = sections[k];
    let mx = 0, my = 0; for (const [cx, cy] of ring) { mx += cx; my += cy; } mx /= R; my /= R;
    pos.push(s.x, s.y + my * s.chord, s.zLE + mx * s.chord); uvs.push(0, 0);
    for (let i = 0; i < R; i++) { const a = k * R + i, b = k * R + ((i + 1) % R); flip ? idx.push(base, b, a) : idx.push(base, a, b); } // root faces -x, tip faces +x
  };
  if (capStart) addCap(0, false);
  if (capEnd) addCap(sections.length - 1, true);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g = g.toNonIndexed(); g.computeVertexNormals();
  return g;
}

/* Wing builder. Canonical: span along +X from origin, root mid-chord at origin, normal +Y.
   opts: span, root, tip, sweep (tip LE aft offset), dihedral deg, thick, camber,
   planform: 'taper'|'ellipse', strips: roles per third ['flap','aileron','aileron'] or 'ctrl', hinge (chord frac) */
function buildWing(o, color) {
  const g = new THREE.Group();
  const K = o.planform === 'ellipse' ? 10 : 4;
  const dih = THREE.MathUtils.degToRad(o.dihedral || 0);
  const chordAt = (s) => o.planform === 'ellipse' ? Math.max(o.tip, o.root * Math.sqrt(Math.max(0, 1 - s * s))) : o.root + (o.tip - o.root) * s;
  const leAt = (s) => o.planform === 'ellipse' ? -o.root / 2 + (o.root - chordAt(s)) * 0.25 + o.sweep * s : -o.root / 2 + o.sweep * s;
  const sec = (s) => ({ x: s * o.span * Math.cos(dih), y: s * o.span * Math.sin(dih), zLE: leAt(s), chord: chordAt(s) });
  const hinge = o.hinge ?? 0.72;
  const paint = M.paint(color);
  const mainSecs = []; for (let k = 0; k <= K; k++) mainSecs.push(sec(k / K));
  const main = new THREE.Mesh(loft(mainSecs, 0, hinge, o.thick ?? 0.12, o.camber ?? 0.02), paint);
  g.add(main);
  const strips = o.strips || ['ctrl', 'ctrl', 'ctrl'];
  const NS = strips.length;
  const controls = [], surfaces = [];
  const area = (() => { let a = 0; for (let k = 0; k < 40; k++) a += chordAt((k + 0.5) / 40) * o.span / 40; return a; })();
  for (let si = 0; si < NS; si++) {
    const s0 = si / NS, s1 = (si + 1) / NS;
    const secs = []; const sub = Math.max(1, Math.round(K / NS));
    for (let k = 0; k <= sub; k++) secs.push(sec(s0 + (s1 - s0) * (k / sub)));
    const role = strips[si];
    // hinge line in canonical coords
    const h0 = new THREE.Vector3(secs[0].x, secs[0].y, secs[0].zLE + hinge * secs[0].chord);
    const h1 = new THREE.Vector3(secs[secs.length - 1].x, secs[secs.length - 1].y, secs.at(-1).zLE + hinge * secs.at(-1).chord);
    const dir = h1.clone().sub(h0).normalize();
    const pivot = new THREE.Object3D(); pivot.position.copy(h0);
    pivot.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    pivot.updateMatrix();
    const inv = pivot.matrix.clone().invert();
    const geo = loft(secs, hinge - 0.005, 1, o.thick ?? 0.12, o.camber ?? 0.02, 6);
    geo.applyMatrix4(inv);
    const hinged = new THREE.Object3D();
    const cm = new THREE.Mesh(geo, role === 'fixed' ? paint : M.paint(color));
    hinged.add(cm); pivot.add(hinged); g.add(pivot);
    controls.push({ obj: hinged, strip: si });
    // physics strip: area, centre at quarter chord
    let sa = 0; for (let k = 0; k < 20; k++) sa += chordAt(s0 + (s1 - s0) * (k + 0.5) / 20) * o.span * (s1 - s0) / 20;
    const sm = (s0 + s1) / 2, cs = sec(sm);
    surfaces.push({
      pos: [cs.x, cs.y, cs.zLE + 0.25 * cs.chord], n: [-Math.sin(dih), Math.cos(dih), 0], f: [0, 0, -1], s: [Math.cos(dih), Math.sin(dih), 0],
      area: sa, role, chord: cs.chord,
    });
  }
  const ar = Math.max(2, (2 * o.span * o.span) / area);
  for (const s of surfaces) s.ar = o.ar || ar;
  g.userData.controls = controls;
  return { group: g, surfaces, area };
}

function fin(o, color) {
  // build as wing then rotate span(+X) to +Y
  const w = buildWing({ ...o, dihedral: 0, camber: 0 }, color);
  const holder = new THREE.Group(); w.group.rotation.z = Math.PI / 2; holder.add(w.group);
  holder.userData.controls = w.group.userData.controls;
  const rot = (v) => [-v[1], v[0], v[2]];
  for (const s of w.surfaces) { s.pos = rot(s.pos); s.n = rot(s.n); s.s = rot(s.s); s.f = rot(s.f); }
  return { group: holder, surfaces: w.surfaces, area: w.area };
}

// ---------- part builders ----------
function fuselage(profile, { color, sy = 1, sx = 1, windows = 0, yOff, segs = 36 }) {
  const g = new THREE.Group();
  const geo = revolve(smoothProfile(profile, 40), { sy, sx, yOff, segs, cap: true });
  let mat = M.paint(color);
  if (windows) { mat = mat.clone(); mat.map = windowTexture(1, windows); }
  g.add(new THREE.Mesh(geo, mat));
  return g;
}

function propeller(radius, blades, color = null) {
  const prop = new THREE.Group();
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, -0.04); bladeShape.quadraticCurveTo(radius * 0.4, -0.1, radius * 0.95, -0.05);
  bladeShape.quadraticCurveTo(radius * 1.02, 0, radius * 0.95, 0.04); bladeShape.quadraticCurveTo(radius * 0.4, 0.07, 0, 0.04);
  const bgeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.025, bevelEnabled: false });
  bgeo.translate(0, 0, -0.012);
  for (let b = 0; b < blades; b++) {
    const bl = new THREE.Mesh(bgeo, M.prop());
    const piv = new THREE.Object3D(); piv.rotation.z = (b / blades) * Math.PI * 2;
    bl.rotation.x = 0.35; // pitch twist
    piv.add(bl);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.08, 0.1, 0.03), M.propTip());
    tip.position.x = radius * 0.93; piv.add(tip);
    prop.add(piv);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), M.propDisc());
  disc.userData.isDisc = true;
  const holder = new THREE.Group(); holder.add(prop); holder.add(disc);
  holder.userData.spinner = prop; holder.userData.disc = disc;
  return holder;
}

function propEngine({ len, radius, propR, blades, color, radial = false, spinnerColor }) {
  const g = new THREE.Group();
  const prof = radial
    ? [[0, 0], [0.0, radius * 0.75], [0.05, radius], [len * 0.5, radius * 0.98], [len, radius * 0.7], [len + 0.01, 0]]
    : [[0, 0], [0.0, radius * 0.55], [0.12, radius * 0.9], [len * 0.45, radius], [len, radius * 0.92], [len + 0.01, 0]];
  const cowl = new THREE.Mesh(revolve(prof.length > 5 ? prof : prof, { segs: 32 }), M.paint(color));
  g.add(cowl);
  if (radial) { // visible cylinders through front
    const front = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.74, 24), M.darkMetal());
    front.position.z = 0.02; front.rotation.y = Math.PI; g.add(front);
    for (let i = 0; i < 9; i++) {
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, radius * 0.6, 8), M.steel());
      const a = (i / 9) * Math.PI * 2; cyl.position.set(Math.cos(a) * radius * 0.42, Math.sin(a) * radius * 0.42, 0.06);
      cyl.rotation.z = a - Math.PI / 2; g.add(cyl);
    }
  } else {
    // exhaust stubs + air intakes
    for (const sx of [-1, 1]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.18, 8), M.steel());
      ex.position.set(sx * radius * 0.7, -radius * 0.65, len * 0.75); ex.rotation.x = Math.PI / 2.4; g.add(ex);
    }
  }
  const spinner = new THREE.Mesh(revolve([[-radius * 0.9, 0], [-radius * 0.75, radius * 0.18], [-radius * 0.4, radius * 0.33], [0, radius * 0.36], [0.01, 0]], { segs: 24 }), spinnerColor ? M.paint(spinnerColor) : M.chrome());
  g.add(spinner);
  const p = propeller(propR, blades);
  p.position.z = -radius * 0.25; g.add(p);
  g.userData.prop = p; g.userData.spinnerMesh = spinner;
  return g;
}

function jetEngine({ len, radius, color, fan = false, ab = false }) {
  const g = new THREE.Group();
  const prof = fan
    ? [[0, radius * 0.92], [0.05, radius], [len * 0.35, radius * 1.02], [len * 0.8, radius * 0.85], [len, radius * 0.62]]
    : [[0, radius * 0.85], [0.1, radius], [len * 0.6, radius], [len, radius * 0.78]];
  const outer = revolve(smoothProfile(prof, 20), { segs: 32 });
  g.add(new THREE.Mesh(outer, M.paint(color)));
  // inner duct (dark)
  const inner = revolve(prof.map(([z, r]) => [z, r * 0.88]), { segs: 24 });
  const im = new THREE.Mesh(inner, M.intake()); im.scale.set(-1, 1, 1); g.add(im);
  // fan face / compressor
  const fanG = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.3, radius * 0.6, 20), M.steel());
  hub.rotation.x = -Math.PI / 2; hub.position.z = len * 0.05; fanG.add(hub);
  const nb = fan ? 22 : 16;
  for (let i = 0; i < nb; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.015, radius * 0.82, radius * 0.12), M.steel());
    b.position.y = radius * 0.45; b.rotation.y = 0.5;
    const piv = new THREE.Object3D(); piv.rotation.z = (i / nb) * Math.PI * 2; piv.position.z = len * 0.12; piv.add(b); fanG.add(piv);
  }
  g.add(fanG);
  // nozzle
  const noz = new THREE.Mesh(revolve([[len - 0.02, radius * 0.78], [len + radius * 0.5, radius * 0.6], [len + radius * 0.52, radius * 0.56]], { segs: 24 }), M.darkMetal());
  g.add(noz);
  const core = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.55, 24), M.black()); core.position.z = len + 0.05; g.add(core);
  // flame cones
  const flame = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.55, radius * 4, 20, 1, true), M.flame().clone());
  flame.rotation.x = -Math.PI / 2; flame.position.z = len + radius * 2.4; g.add(flame);
  const flameCore = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.35, radius * 2.2, 16, 1, true), M.flameCore().clone());
  flameCore.rotation.x = -Math.PI / 2; flameCore.position.z = len + radius * 1.5; g.add(flameCore);
  g.userData.fan = fanG; g.userData.flame = flame; g.userData.flameCore = flameCore; g.userData.ab = ab;
  return g;
}

function rocket({ len, radius, color }) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(revolve(smoothProfile([[0, 0], [radius * 1.5, radius * 0.8], [radius * 3, radius], [len, radius]], 20).concat([[len + 0.001, radius * 0.4]]), { segs: 24, cap: true }), M.paint(color)));
  const noz = new THREE.Mesh(revolve([[len, radius * 0.5], [len + radius * 0.9, radius * 0.8]], { segs: 20 }), M.darkMetal());
  g.add(noz);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, radius * 1.2, radius * 2), M.paint(0x333333));
    const piv = new THREE.Object3D(); piv.rotation.z = (i / 4) * Math.PI * 2 + Math.PI / 4; f.position.set(0, radius * 1.2, len - radius); piv.add(f); g.add(piv);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.8, radius * 8, 20, 1, true), M.flame().clone());
  flame.rotation.x = -Math.PI / 2; flame.position.z = len + radius * 4.6; g.add(flame);
  const flameCore = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.5, radius * 4, 16, 1, true), M.flameCore().clone());
  flameCore.rotation.x = -Math.PI / 2; flameCore.position.z = len + radius * 2.5; g.add(flameCore);
  g.userData.flame = flame; g.userData.flameCore = flameCore;
  return g;
}

function wheel(r, w) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, r * 0.3, 12, 24), M.rubber());
  tire.scale.z = w / (r * 0.6); tire.rotation.y = Math.PI / 2; g.add(tire);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.48, r * 0.48, w * 0.8, 16), M.aluminum());
  hub.rotation.z = Math.PI / 2; g.add(hub);
  return g;
}

function gearLeg({ len, r, w = null, color = 0xdddddd, fairing = false, bogie = false, steer = false }) {
  const g = new THREE.Group();
  const strut = new THREE.Group();
  const sm = new THREE.Mesh(new THREE.CylinderGeometry(0.05 + r * 0.08, 0.05 + r * 0.08, len, 10), M.steel());
  sm.position.y = -len / 2; strut.add(sm);
  const oleo = new THREE.Mesh(new THREE.CylinderGeometry(0.07 + r * 0.1, 0.07 + r * 0.1, len * 0.45, 10), M.paint(color));
  oleo.position.y = -len * 0.25; strut.add(oleo);
  const wheels = new THREE.Group(); wheels.position.y = -len; strut.add(wheels);
  const ww = w || r * 0.6;
  if (bogie) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, r * 3.2), M.steel()); wheels.add(beam);
    for (const dz of [-1, 1]) for (const dx of [-1, 1]) { const wh = wheel(r, ww); wh.position.set(dx * ww * 0.75, 0, dz * r * 1.2); wheels.add(wh); }
  } else {
    const wh = wheel(r, ww); wheels.add(wh);
    if (fairing) {
      const sp = new THREE.Mesh(revolve(smoothProfile([[-r * 1.3, 0], [-r, r * 0.45], [0, r * 0.62], [r * 1.5, 0.02]], 16), { segs: 20, sx: 0.55, sy: 1.0 }), M.paint(color));
      wheels.add(sp);
    } else {
      const fork = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.06, 0.06, 0.06), M.steel()); fork.position.y = r * 0.2; wheels.add(fork);
    }
  }
  g.add(strut);
  g.userData.strut = strut; g.userData.wheels = wheels; g.userData.steer = steer;
  return g;
}

function float_({ len, r, color }) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(revolve(smoothProfile([[-len / 2, 0.02], [-len / 2 + 0.6, r * 0.8], [0, r], [len / 2 - 0.5, r * 0.7], [len / 2, 0.05]], 30), { segs: 20, sy: 0.8, cap: true, yOff: (z) => (z < -len / 2 + 0.8 ? (z + len / 2 - 0.8) * -0.2 : 0) }), M.paint(color));
  body.position.y = -1.0; g.add(body);
  for (const dz of [-len * 0.18, len * 0.18]) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 8), M.steel()); st.position.set(0, -0.5, dz); g.add(st);
  }
  return g;
}

// Helicopter rotor: mast up from the origin, blades spinning in the horizontal plane (a disc of radius R).
// side = true builds a tail rotor instead: no mast, disc facing sideways (+X).
function rotorHead({ R, blades, chord, mast = 0, side = false, color }) {
  const g = new THREE.Group();
  if (mast) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, mast, 12), M.steel()); m.position.y = mast / 2; g.add(m); }
  const spin = new THREE.Group();
  const bgeo = new THREE.BoxGeometry(R * 0.94, Math.max(0.03, chord * 0.12), chord); bgeo.translate(R * 0.5, 0, 0);
  for (let b = 0; b < blades; b++) {
    const piv = new THREE.Object3D(); piv.rotation.z = (b / blades) * Math.PI * 2;
    const bl = new THREE.Mesh(bgeo, M.prop()); bl.rotation.x = Math.PI / 2 + 0.12; piv.add(bl); // flat in the disc plane, slight pitch
    const tip = new THREE.Mesh(new THREE.BoxGeometry(R * 0.06, chord * 1.02, 0.05), M.propTip()); tip.position.x = R * 0.95; piv.add(tip);
    spin.add(piv);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(chord * 0.6, chord * 0.6, chord * 0.5, 14), M.paint(color)); hub.rotation.x = Math.PI / 2; spin.add(hub);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 48), M.propDisc()); disc.userData.isDisc = true;
  const holder = new THREE.Group(); holder.add(spin); holder.add(disc);
  holder.userData.spinner = spin; holder.userData.disc = disc;
  if (side) holder.rotation.y = Math.PI / 2; else { holder.rotation.x = -Math.PI / 2; holder.position.y = mast; }
  g.add(holder); g.userData.prop = holder;
  return g;
}
function skid({ len, h, color }) {
  const g = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 10), M.paint(color)); tube.rotation.x = Math.PI / 2; tube.position.y = -h; g.add(tube);
  const tipF = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 8, 12, Math.PI / 2), M.paint(color)); tipF.rotation.y = Math.PI / 2; tipF.position.set(0, -h + 0.22, -len / 2); g.add(tipF);
  for (const dz of [-len * 0.25, len * 0.25]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, h, 8), M.steel()); st.position.set(0, -h / 2, dz); g.add(st); }
  return g;
}

// Car engine: a chunky block with a blower and side pipes (it drives the wheels, not a propeller).
function carMotor({ color }) {
  const g = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.9), M.paint(color)); block.position.y = 0.22; g.add(block);
  const blower = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.5), M.chrome()); blower.position.y = 0.56; g.add(blower);
  const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.3), M.darkMetal()); scoop.position.set(0, 0.73, -0.05); g.add(scoop);
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 10), M.chrome()); pipe.rotation.x = Math.PI / 2; pipe.position.set(sx * 0.42, 0.12, 0.2); g.add(pipe);
  }
  return g;
}

// ---------- the library ----------
const C = { white: 0xf2f2ee, red: 0xc8102e, yellow: 0xf2b705, blue: 0x1d4e89, gray: 0x8a9099, darkgray: 0x4a4f57, orange: 0xe8601c, green: 0x2e6b3f, navy: 0x1b2a41 };

export const PARTS = {};
function def(p) { PARTS[p.id] = p; }

// --- Fuselages ---
def({ id: 'fus_light', cat: 'fuselage', name: 'Light Cabin', desc: 'Four-seat high-wing cabin. The classic trainer body.', mass: 380, hp: 900, color: C.white,
  build: (c) => fuselage([[-3.0, 0.0], [-3.0, 0.5], [-2.6, 0.62], [-1.2, 0.7], [0.4, 0.66], [2.2, 0.4], [3.8, 0.18], [4.4, 0.05]], { color: c, sy: 1.18 }) });
def({ id: 'fus_sport', cat: 'fuselage', name: 'Sport Body', desc: 'Slim aerobatic fuselage. Light and nimble.', mass: 180, hp: 700, color: C.red,
  build: (c) => fuselage([[-2.4, 0.0], [-2.4, 0.42], [-1.6, 0.48], [0, 0.46], [1.6, 0.28], [3.2, 0.1], [3.5, 0.03]], { color: c, sy: 1.15 }) });
def({ id: 'fus_fighter', cat: 'fuselage', name: 'Fighter Body', desc: 'Area-ruled jet fuselage with intake cheeks.', mass: 2200, hp: 2400, color: C.gray,
  build: (c) => {
    const g = fuselage([[-6.5, 0.0], [-5.6, 0.32], [-3.5, 0.7], [-1, 0.9], [2.5, 0.85], [5.2, 0.7], [6.0, 0.6]], { color: c, sy: 0.85, sx: 1.1 });
    for (const sx of [-1, 1]) { // intakes
      const it = new THREE.Mesh(revolve([[-2.6, 0.3], [-2.4, 0.42], [1.5, 0.42], [3, 0.2]], { segs: 16, sy: 1.2, cap: true }), M.paint(c));
      it.position.set(sx * 0.85, -0.15, 0); g.add(it);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), M.intake()); mouth.position.set(sx * 0.85, -0.15, -2.62); mouth.rotation.y = Math.PI; mouth.scale.y = 1.2; g.add(mouth);
    }
    return g;
  } });
def({ id: 'fus_airliner', cat: 'fuselage', name: 'Airliner Tube', desc: 'A long pressurised cabin with 120 windows. Bring big wings.', mass: 14000, hp: 9000, color: C.white,
  build: (c) => fuselage([[-11, 1.9], [-6, 1.95], [0, 1.95], [6, 1.9], [9, 1.55], [11.5, 0.75], [12.6, 0.25]], { color: c, windows: 46, segs: 40, yOff: (z) => (z > 6 ? (z - 6) ** 2 * 0.025 : 0) }) });
def({ id: 'fus_cargo', cat: 'fuselage', name: 'Cargo Hauler', desc: 'Fat, strong freighter body.', mass: 9000, hp: 9000, color: C.green,
  build: (c) => fuselage([[-7, 2.3], [-3, 2.45], [3, 2.45], [6, 2.0], [9, 0.8], [9.6, 0.4]], { color: c, sy: 1.0, yOff: (z) => (z > 4 ? (z - 4) * 0.32 : 0), segs: 36 }) });
def({ id: 'fus_pod', cat: 'fuselage', name: 'Mini Pod', desc: 'Short stubby pod. Great for twin-boom or outrigger builds.', mass: 120, hp: 500, color: C.yellow,
  build: (c) => fuselage([[-1.6, 0], [-1.4, 0.35], [-0.6, 0.5], [0.6, 0.48], [1.5, 0.25], [1.8, 0.05]], { color: c, sy: 1.1 }) });
def({ id: 'fus_boom', cat: 'fuselage', name: 'Tail Boom', desc: 'Thin carbon tube. Push the tail further back.', mass: 45, hp: 300, color: C.darkgray,
  build: (c) => fuselage([[-3, 0.0], [-2.95, 0.17], [2.9, 0.12], [3, 0.0]], { color: c, segs: 16 }) });
def({ id: 'fus_glider', cat: 'fuselage', name: 'Glider Body', desc: 'Long slender sailplane fuselage.', mass: 120, hp: 450, color: C.white,
  build: (c) => fuselage([[-2.0, 0], [-1.7, 0.33], [-0.8, 0.42], [0.4, 0.36], [2.2, 0.16], [5.4, 0.1], [6.0, 0.06]], { color: c, sy: 1.25 }) });

// --- Cockpits / noses ---
def({ id: 'ck_bubble', cat: 'cockpit', name: 'Bubble Canopy', desc: 'All-round view glass bubble. Sits on top of a body.', mass: 60, hp: 250, color: C.darkgray, eye: [0, 0.25, 0.1],
  build: (c) => {
    const g = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.glass()); glass.scale.set(0.9, 0.85, 2.0); g.add(glass);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.025, 6, 40), M.paint(c)); frame.rotation.x = Math.PI / 2; frame.scale.set(0.9, 2.0, 1); g.add(frame);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.02, 6, 20, Math.PI), M.paint(c)); arch.scale.set(0.95, 0.9, 1); arch.position.z = -0.25; g.add(arch);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 0.15), M.black()); seat.position.set(0, 0.1, 0.45); g.add(seat);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), M.pilot()); helmet.position.set(0, 0.28, 0.2); g.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 8, -0.9, 1.8, 1.0, 0.7), M.visor()); visor.position.copy(helmet.position); visor.rotation.y = Math.PI; g.add(visor);
    return g;
  } });
def({ id: 'ck_fighter', cat: 'cockpit', name: 'Fighter Canopy', desc: 'Gold-tinted teardrop canopy with an ejection seat.', mass: 150, hp: 300, color: C.gray, eye: [0, 0.35, 0.2],
  build: (c) => {
    const g = new THREE.Group();
    const glass = new THREE.Mesh(revolve(smoothProfile([[-1.6, 0.02], [-0.8, 0.42], [0.3, 0.5], [1.4, 0.3], [2.0, 0.04]], 24), { segs: 24, sy: 1.15 }), M.glass(0xd9b25a));
    g.add(glass);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 3.6), M.paint(c)); sill.position.y = -0.03; g.add(sill);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), M.pilot()); helmet.position.set(0, 0.3, 0.2); g.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 8, -0.9, 1.8, 1.0, 0.7), M.visor()); visor.position.copy(helmet.position); visor.rotation.y = Math.PI; g.add(visor);
    return g;
  } });
def({ id: 'ck_airliner', cat: 'cockpit', name: 'Airliner Nose', desc: 'Flight deck with wrap-around windscreen. Bolts to the front of a tube.', mass: 1600, hp: 2500, color: C.white, eye: [0, 0.9, -2.8],
  build: (c) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(revolve(smoothProfile([[-4.6, 0], [-4.4, 0.7], [-3.4, 1.4], [-1.8, 1.82], [0, 1.9]], 24), { segs: 40, yOff: (z) => (z + 0) * -0.04, cap: true }), M.paint(c)));
    const ws = new THREE.Mesh(new THREE.SphereGeometry(1.86, 24, 8, Math.PI * 0.3, Math.PI * 0.4, Math.PI * 0.3, Math.PI * 0.12), M.black());
    ws.position.set(0, 0.0, -1.7); ws.scale.set(1, 1, 1.25); ws.rotation.y = Math.PI / 2 + Math.PI; g.add(ws);
    const radome = new THREE.Mesh(new THREE.SphereGeometry(0.72, 16, 12), M.paint(0x30343a)); radome.position.z = -4.25; radome.scale.z = 0.5; g.add(radome);
    return g;
  } });
def({ id: 'ck_glassnose', cat: 'cockpit', name: 'Greenhouse Nose', desc: 'Framed glass nose, like an old bomber.', mass: 220, hp: 400, color: C.navy, eye: [0, 0.1, -0.6],
  build: (c) => {
    const g = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.glass()); glass.rotation.x = -Math.PI / 2; glass.scale.z = 1.4; g.add(glass);
    for (let i = 0; i < 6; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.018, 6, 24, Math.PI), M.paint(c)); r.rotation.z = (i / 6) * Math.PI; r.rotation.y = Math.PI / 2; r.scale.set(1.4, 1, 1); const h = new THREE.Group(); h.rotation.x = 0; h.add(r); g.add(h); }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.04, 8, 32), M.paint(c)); g.add(ring);
    return g;
  } });
def({ id: 'ck_open', cat: 'cockpit', name: 'Open Cockpit', desc: 'Windscreen, leather seat and a pilot with goggles. Wind in your hair.', mass: 40, hp: 150, color: 0x6b4226, eye: [0, 0.35, 0.25],
  build: (c) => {
    const g = new THREE.Group();
    const ws = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 16, 1, true, -0.9, 1.8), M.glass()); ws.position.set(0, 0.12, -0.2); ws.rotation.y = Math.PI; g.add(ws);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 8, 24), M.paint(c)); rim.rotation.x = Math.PI / 2; rim.scale.set(1, 1.4, 1); g.add(rim);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.4, 12), M.paint(0x5a4632)); body.position.set(0, 0.05, 0.15); g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), M.paint(0x6b4226, 'matte')); head.position.set(0, 0.36, 0.12); g.add(head);
    const goggles = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 6, 16), M.chrome()); goggles.position.set(0, 0.38, 0.03); g.add(goggles);
    const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.5), M.paint(0xffffff, 'matte')); scarf.position.set(0.08, 0.25, 0.4); scarf.rotation.y = 0.2; g.add(scarf);
    return g;
  } });

// --- Wings ---
const wingDef = (id, name, desc, mass, hp, color, o) => def({ id, cat: 'wing', name, desc, mass, hp, color, attach: 'wing', wing: o,
  build: (c) => { const w = buildWing(o, c); w.group.userData.surfaces = w.surfaces; return w.group; } });
wingDef('w_trainer', 'Trainer Wing', 'Straight, thick, gentle stall. Forgiving.', 110, 1100, C.white, { span: 5.4, root: 1.6, tip: 1.4, sweep: 0.05, dihedral: 2, thick: 0.15, camber: 0.04, strips: ['flap', 'flap', 'aileron'], flaps: true });
wingDef('w_taper', 'Tapered Wing', 'Efficient tapered wing for fast props.', 150, 1200, C.white, { span: 5.8, root: 2.2, tip: 1.1, sweep: 0.3, dihedral: 4, thick: 0.13, camber: 0.03, strips: ['flap', 'aileron', 'aileron'], flaps: true });
wingDef('w_ellipse', 'Elliptical Wing', 'Graceful elliptical planform, as seen on famous fighters.', 220, 1500, C.green, { span: 5.6, root: 2.4, tip: 0.5, sweep: 0.15, dihedral: 5, thick: 0.13, camber: 0.025, planform: 'ellipse', strips: ['flap', 'aileron', 'aileron'], flaps: true });
wingDef('w_swept', 'Swept Jet Wing', 'Swept back for speed. Stalls harder.', 500, 2600, C.gray, { span: 5.2, root: 4.2, tip: 1.3, sweep: 3.2, dihedral: -2, thick: 0.07, camber: 0.01, strips: ['flap', 'aileron', 'aileron'], flaps: true, ar: 3.5 });
wingDef('w_delta', 'Delta Wing', 'Huge triangle. High AoA, lots of drag when you pull.', 800, 3200, C.gray, { span: 4.6, root: 9, tip: 0.8, sweep: 7.6, dihedral: 0, thick: 0.05, camber: 0, strips: ['ctrl', 'ctrl', 'ctrl'], hinge: 0.85, ar: 2.0 });
wingDef('w_glider', 'Glider Wing', 'Long, skinny, glides forever.', 95, 700, C.white, { span: 9.0, root: 1.0, tip: 0.45, sweep: 0.15, dihedral: 3, thick: 0.14, camber: 0.04, strips: ['flap', 'flap', 'aileron'], flaps: true });
wingDef('w_airliner', 'Airliner Wing', 'Giant swept wing with plenty of fuel and lift.', 7000, 30000, C.white, { span: 16, root: 7, tip: 1.8, sweep: 7.5, dihedral: 5, thick: 0.11, camber: 0.025, strips: ['flap', 'flap', 'aileron'], flaps: true });
wingDef('w_stub', 'Stub Wing', 'Short, strong. Good for hanging engines on.', 60, 900, C.yellow, { span: 2.4, root: 1.3, tip: 1.1, sweep: 0.1, dihedral: 0, thick: 0.14, camber: 0.02, strips: ['fixed', 'aileron'], flaps: false });

// --- Tail surfaces ---
const tailDef = (id, name, desc, mass, hp, color, o, isFin = false) => def({ id, cat: 'tail', name, desc, mass, hp, color, attach: isFin ? 'fin' : 'wing', wing: o,
  build: (c) => { const w = isFin ? fin(o, c) : buildWing(o, c); w.group.userData.surfaces = w.surfaces; return w.group; } });
tailDef('t_hstab', 'Tailplane', 'Horizontal stabilizer with elevator. Use a pair at the back.', 25, 500, C.white, { span: 1.8, root: 1.1, tip: 0.7, sweep: 0.3, dihedral: 0, thick: 0.1, camber: 0, strips: ['ctrl', 'ctrl'], hinge: 0.62 });
tailDef('t_vfin', 'Vertical Fin', 'Fin and rudder. Keeps the nose pointing forwards.', 25, 500, C.white, { span: 1.6, root: 1.5, tip: 0.8, sweep: 0.9, thick: 0.1, strips: ['ctrl', 'ctrl'], hinge: 0.62 }, true);
tailDef('t_jet_hstab', 'Swept Tailplane', 'Swept all-moving tail for jets.', 140, 1200, C.gray, { span: 2.8, root: 2.4, tip: 0.9, sweep: 1.9, dihedral: -4, thick: 0.06, camber: 0, strips: ['ctrl', 'ctrl'], hinge: 0.3 });
tailDef('t_jet_vfin', 'Swept Fin', 'Tall swept fin for jets.', 150, 1200, C.gray, { span: 2.9, root: 3.2, tip: 1.1, sweep: 2.6, thick: 0.06, strips: ['ctrl', 'ctrl'], hinge: 0.7 }, true);
tailDef('t_big_hstab', 'Airliner Tailplane', 'Big swept tailplane for heavies.', 900, 9000, C.white, { span: 6.5, root: 4.2, tip: 1.6, sweep: 3.4, dihedral: 6, thick: 0.09, camber: 0, strips: ['ctrl', 'ctrl'], hinge: 0.68 });
tailDef('t_big_vfin', 'Airliner Fin', 'Tall fin for heavies.', 900, 9000, C.blue, { span: 7.0, root: 5.8, tip: 2.2, sweep: 4.6, thick: 0.09, strips: ['ctrl', 'ctrl'], hinge: 0.7 }, true);
tailDef('t_canard', 'Canard', 'Small fore-plane. Mount near the nose for that futuristic look.', 30, 500, C.white, { span: 1.4, root: 0.9, tip: 0.5, sweep: 0.5, dihedral: 0, thick: 0.08, camber: 0, strips: ['ctrl'], hinge: 0.5 });

// --- Engines ---
def({ id: 'e_piston', cat: 'engine', name: 'Piston 180 hp', desc: 'Four-cylinder flat engine with two-blade prop. Putt-putt.', mass: 150, hp: 600, color: C.white,
  engine: { type: 'prop', thrust: 3400, vmax: 85, sound: 'piston', idleRpm: 700, maxRpm: 2700, cyl: 4 },
  build: (c) => propEngine({ len: 1.1, radius: 0.5, propR: 0.95, blades: 2, color: c }) });
def({ id: 'e_radial', cat: 'engine', name: 'Radial 1,400 hp', desc: 'Nine big cylinders, three blades, a glorious rumble.', mass: 750, hp: 1500, color: C.green,
  engine: { type: 'prop', thrust: 14000, vmax: 165, sound: 'radial', idleRpm: 600, maxRpm: 2600, cyl: 9 },
  build: (c) => propEngine({ len: 1.6, radius: 0.75, propR: 1.6, blades: 3, color: c, radial: true, spinnerColor: c }) });
def({ id: 'e_turboprop', cat: 'engine', name: 'Turboprop', desc: 'Turbine-driven four-blade prop. Smooth and strong.', mass: 520, hp: 1400, color: C.white,
  engine: { type: 'prop', thrust: 21000, vmax: 190, sound: 'turboprop', idleRpm: 1000, maxRpm: 2000, cyl: 0, spool: 1.5 },
  build: (c) => propEngine({ len: 2.6, radius: 0.55, propR: 1.7, blades: 4, color: c }) });
def({ id: 'e_electric', cat: 'engine', name: 'Electric Fan', desc: 'Silent-ish ducted electric fan. Instant power, high whine.', mass: 60, hp: 400, color: 0x2a9d8f,
  engine: { type: 'prop', thrust: 2500, vmax: 110, sound: 'electric', idleRpm: 0, maxRpm: 9000, cyl: 0 },
  build: (c) => {
    const g = new THREE.Group();
    const duct = new THREE.Mesh(revolve([[-0.3, 0.42], [-0.25, 0.47], [0.3, 0.46], [0.5, 0.38]], { segs: 28 }), M.paint(c)); g.add(duct);
    const di = new THREE.Mesh(revolve([[-0.3, 0.41], [0.5, 0.37]], { segs: 28 }), M.intake()); di.scale.x = -1; g.add(di);
    const p = propeller(0.4, 6); p.position.z = -0.05; g.add(p); g.userData.prop = p;
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), M.chrome()); hub.scale.z = 1.8; g.add(hub);
    return g;
  } });
def({ id: 'e_jet_small', cat: 'engine', name: 'Small Turbojet', desc: 'Light jet engine. Needs speed to shine.', mass: 300, hp: 900, color: C.gray,
  engine: { type: 'jet', thrust: 13000, spool: 2.5, sound: 'jet' },
  build: (c) => jetEngine({ len: 2.2, radius: 0.38, color: c }) });
def({ id: 'e_jet_ab', cat: 'engine', name: 'Afterburning Turbojet', desc: 'Fighter engine. Push throttle past 95% for the afterburner.', mass: 1600, hp: 2000, color: C.darkgray,
  engine: { type: 'jet', thrust: 55000, ab: 85000, spool: 3.5, sound: 'jet' },
  build: (c) => jetEngine({ len: 4.2, radius: 0.55, color: c, ab: true }) });
def({ id: 'e_turbofan', cat: 'engine', name: 'Big Turbofan', desc: 'High-bypass airliner engine. Huge thrust, slow spool.', mass: 2600, hp: 4000, color: C.white,
  engine: { type: 'jet', thrust: 70000, spool: 5, sound: 'fan' },
  build: (c) => jetEngine({ len: 4.0, radius: 1.15, color: c, fan: true }) });
def({ id: 'e_rocket', cat: 'engine', name: 'Rocket Booster', desc: 'Pure chaos: fires when throttle > 50%, burns 20 s unless you change it. No refills!', mass: 450, hp: 700, color: C.orange,
  engine: { type: 'rocket', thrust: 90000, burn: 20, sound: 'rocket' },
  build: (c) => rocket({ len: 3.2, radius: 0.32, color: c }) });

// --- Helicopter rotors ---
// Main rotors lift straight up along the mast. Throttle is the collective: in Arcade, middle = hover.
// A single main rotor twists the body the other way; a tail rotor cancels that and gives rudder control.
def({ id: 'r_main', cat: 'rotor', name: 'Main Rotor', desc: 'Two-blade helicopter rotor. Mount on top, over the middle. Needs a tail rotor!', mass: 220, hp: 900, color: C.darkgray,
  engine: { type: 'rotor', thrust: 12000, sound: 'turboprop', idleRpm: 1000, maxRpm: 2000, spool: 2.5 },
  build: (c) => rotorHead({ R: 4.2, blades: 2, chord: 0.3, mast: 0.7, color: c }) });
def({ id: 'r_main4', cat: 'rotor', name: 'Four-Blade Rotor', desc: 'Bigger, smoother four-blade rotor for heavier helicopters.', mass: 600, hp: 2000, color: C.darkgray,
  engine: { type: 'rotor', thrust: 52000, sound: 'turboprop', idleRpm: 1000, maxRpm: 2000, spool: 3 },
  build: (c) => rotorHead({ R: 6.5, blades: 4, chord: 0.45, mast: 0.9, color: c }) });
def({ id: 'r_tail', cat: 'rotor', name: 'Tail Rotor', desc: 'Small side rotor for the end of the tail. Stops the spin and lets the rudder turn you.', mass: 30, hp: 300, color: C.darkgray,
  engine: { type: 'tailrotor', thrust: 0, idleRpm: 1000, maxRpm: 2000 },
  build: (c) => rotorHead({ R: 0.75, blades: 2, chord: 0.14, side: true, color: c }) });

// --- Landing gear (origin = strut top; wheel ray down) ---
const gearDef = (id, name, desc, mass, hp, opts, gearInfo) => def({ id, cat: 'gear', name, desc, mass, hp, color: 0xdddddd, attach: 'gear', gear: gearInfo,
  build: (c) => gearLeg({ ...opts, color: c }) });
gearDef('g_nose', 'Nose Wheel', 'Steerable nose wheel. Rudder steers on the ground.', 25, 260, { len: 0.95, r: 0.22, steer: true, fairing: false }, { len: 0.95, r: 0.22, steer: true, brake: false, limit: 4.5, k: 2.2 });
gearDef('g_main', 'Main Gear Leg', 'Spring-steel leg with a faired wheel. Use one each side.', 35, 380, { len: 1.05, r: 0.28, fairing: true }, { len: 1.05, r: 0.28, steer: false, brake: true, limit: 5.0, k: 3 });
gearDef('g_tail', 'Tail Wheel', 'Little steerable tail wheel for taildraggers.', 10, 160, { len: 0.38, r: 0.12, steer: true }, { len: 0.38, r: 0.12, steer: true, brake: false, limit: 4.0, k: 1.2 });
gearDef('g_bush', 'Bush Tires', 'Giant soft tires. Land anywhere.', 60, 500, { len: 1.2, r: 0.45, w: 0.4 }, { len: 1.2, r: 0.45, steer: false, brake: true, limit: 7.5, k: 3 });
gearDef('g_retract', 'Retractable Gear', 'Folds away with G. Less drag, more speed.', 120, 900, { len: 1.5, r: 0.36 }, { len: 1.5, r: 0.36, steer: false, brake: true, retract: true, limit: 4.5, k: 6 });
gearDef('g_retract_nose', 'Retractable Nose Gear', 'Steerable nose gear that folds away.', 80, 700, { len: 1.6, r: 0.3, steer: true }, { len: 1.6, r: 0.3, steer: true, brake: false, retract: true, limit: 4.5, k: 4 });
gearDef('g_bogie', 'Heavy Bogie', 'Four-wheel airliner bogie. Handles huge weights.', 900, 9000, { len: 2.8, r: 0.6, bogie: true }, { len: 2.8, r: 0.6, steer: false, brake: true, retract: true, limit: 4.0, k: 40, wheels: 4 });
def({ id: 'g_float', cat: 'gear', name: 'Float', desc: 'Pontoon float. Land on water! (Skids on ground.)', mass: 90, hp: 700, color: C.white, attach: 'gear',
  gear: { float: true, len: 1.0, r: 0.35, flen: 5.2, limit: 6, k: 3 }, build: (c) => float_({ len: 5.2, r: 0.4, color: c }) });
def({ id: 'g_skid', cat: 'gear', name: 'Helicopter Skid', desc: 'Landing skid for helicopters. Use one each side.', mass: 30, hp: 600, color: 0x4a4f57, attach: 'gear',
  gear: { float: true, skid: true, flen: 3.0, clen: 0.95, cr: 0.11, limit: 6, k: 3 }, build: (c) => skid({ len: 3.0, h: 1.0, color: c }) });

// --- Car parts: a Car Engine drives every wheel marked drive. Throttle = go, stick left/right = steer, pull back = reverse.
def({ id: 'c_motor', cat: 'car', name: 'Car Engine', desc: 'V8 with a blower. Drives the car wheels. Throttle to go, pull the stick back to reverse.', mass: 220, hp: 900, color: C.red,
  engine: { type: 'drive', thrust: 5000, vmax: 50, sound: 'piston', idleRpm: 800, maxRpm: 2700, cyl: 8 },
  build: (c) => carMotor({ color: c }) });
const carWheel = (id, name, desc, mass, r, len, w, steer) => def({ id, cat: 'car', name, desc, mass, hp: 700, color: 0x2a2a2a, attach: 'gear',
  gear: { len, r, steer, brake: true, drive: true, limit: 8, k: 3 }, build: (c) => gearLeg({ len, r, w, steer, color: c }) });
carWheel('c_wheel', 'Car Wheel', 'Driven wheel with a fat tyre. Put them at the back.', 30, 0.36, 0.35, 0.3, false);
carWheel('c_wheel_steer', 'Steering Wheel', 'Driven wheel that steers. Put them at the front.', 32, 0.36, 0.35, 0.3, true);
carWheel('c_monster', 'Monster Wheel', 'Huge bouncy monster-truck wheel. Drives and steers.', 120, 0.8, 0.6, 0.6, true);

// --- Extras ---
def({ id: 'x_nosecone', cat: 'extra', name: 'Nose Cone', desc: 'Pointy aerodynamic nose cap.', mass: 30, hp: 300, color: C.darkgray,
  build: (c) => { const g = new THREE.Group(); g.add(new THREE.Mesh(revolve(smoothProfile([[-1.6, 0], [-1.2, 0.18], [-0.5, 0.38], [0, 0.45]], 16).concat([[0.001, 0]]), { segs: 28 }), M.paint(c))); return g; } });
def({ id: 'x_tailcone', cat: 'extra', name: 'Tail Cone', desc: 'Tapered tail end.', mass: 40, hp: 300, color: C.white,
  build: (c) => { const g = new THREE.Group(); g.add(new THREE.Mesh(revolve([[0, 0], [0.001, 0.5], [1.0, 0.38], [2.2, 0.12], [2.4, 0]], { segs: 28 }), M.paint(c))); return g; } });
def({ id: 'x_tank', cat: 'extra', name: 'Drop Tank', desc: 'Streamlined pod. Adds weight down low.', mass: 160, hp: 300, color: C.gray,
  build: (c) => { const g = new THREE.Group(); g.add(new THREE.Mesh(revolve(smoothProfile([[-1.3, 0], [-1.0, 0.2], [0, 0.3], [1.0, 0.2], [1.5, 0]], 20), { segs: 20 }), M.paint(c)));
    for (let i = 0; i < 3; i++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.22, 0.3), M.paint(c)); const p = new THREE.Object3D(); p.rotation.z = i * 2.09; f.position.set(0, 0.2, 1.2); p.add(f); g.add(p); } return g; } });
def({ id: 'x_ballast', cat: 'extra', name: 'Ballast Weight', desc: '250 kg lead block. Fix (or ruin) your balance.', mass: 250, hp: 2000, color: 0x555555,
  build: (c) => { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), M.paint(c, 'metal')); g.add(b); return g; } });
def({ id: 'x_smoke', cat: 'extra', name: 'Smoke Generator', desc: 'Airshow smoke! Toggle with the smoke button (or Space).', mass: 20, hp: 200, color: C.red, smoke: true,
  build: (c) => { const g = new THREE.Group(); g.add(new THREE.Mesh(revolve(smoothProfile([[-0.5, 0], [-0.4, 0.09], [0.3, 0.1], [0.5, 0.06]], 12).concat([[0.501, 0]]), { segs: 16 }), M.paint(c))); return g; } });
def({ id: 'x_navlight', cat: 'extra', name: 'Strobe Light', desc: 'Blinking position light. Red on the left, green on the right, white strobe in the middle.', mass: 2, hp: 80, color: 0xeeeeee, light: 'nav',
  build: (c) => { const g = new THREE.Group(); const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.06, 10), M.paint(c)); g.add(base);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), M.light(0xffffff).clone()); bulb.position.y = 0.05; g.add(bulb); g.userData.bulb = bulb; return g; } });
def({ id: 'x_landlight', cat: 'extra', name: 'Landing Light', desc: 'Bright spotlight for night landings.', mass: 4, hp: 80, color: 0xcccccc, light: 'landing',
  build: (c) => { const g = new THREE.Group(); const h = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.09, 0.15, 14), M.paint(c)); h.rotation.x = Math.PI / 2; g.add(h);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14), new THREE.MeshBasicMaterial({ color: 0xfff4dd })); lens.position.z = -0.08; lens.rotation.y = Math.PI; g.add(lens); return g; } });
def({ id: 'x_strut', cat: 'extra', name: 'Strut', desc: 'Structural strut. Connect wings for biplanes.', mass: 12, hp: 400, color: 0x888888,
  build: (c) => { const g = new THREE.Group(); const s = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8), M.paint(c)); g.add(s); return g; } });
def({ id: 'x_pylon', cat: 'extra', name: 'Pylon', desc: 'Vertical mounting pylon. Hang engines lower or higher.', mass: 40, hp: 600, color: C.gray,
  build: (c) => { const g = new THREE.Group(); const sh = new THREE.Shape(); sh.moveTo(-0.8, 0); sh.lineTo(0.9, 0); sh.lineTo(0.5, -0.8); sh.lineTo(-0.4, -0.8); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false }); geo.rotateY(Math.PI / 2); geo.translate(-0.06, 0, 0); g.add(new THREE.Mesh(geo, M.paint(c))); return g; } });

export const CATEGORIES = [
  { id: 'fuselage', name: 'Bodies', icon: '▬' },
  { id: 'cockpit', name: 'Cockpits', icon: '◓' },
  { id: 'wing', name: 'Wings', icon: '◢' },
  { id: 'tail', name: 'Tails', icon: '▲' },
  { id: 'engine', name: 'Engines', icon: '✇' },
  { id: 'gear', name: 'Gear', icon: '◉' },
  { id: 'rotor', name: 'Rotors', icon: '✢' },
  { id: 'car', name: 'Car', icon: '🚗' },
  { id: 'extra', name: 'Extras', icon: '✦' },
];

export const PAINTS = [0xf2f2ee, 0xc8102e, 0xf2b705, 0x1d4e89, 0x8a9099, 0x4a4f57, 0xe8601c, 0x2e6b3f, 0x1b2a41, 0x7b2d8b, 0x111111, 0x6fb7e9, 0xd9c7a3, 0xff6fa8];

// --- per-part derived info (bbox, hull sample points) ---
const infoCache = new Map();
export function partInfo(id) {
  if (infoCache.has(id)) return infoCache.get(id);
  const p = PARTS[id];
  const obj = p.build(p.color);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  // hull points: support points of all vertices along 26 directions
  const dirs = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push(new THREE.Vector3(x, y, z).normalize());
  const best = dirs.map(() => ({ d: -Infinity, v: new THREE.Vector3() }));
  const v = new THREE.Vector3();
  obj.traverse((m) => {
    if (!m.isMesh || m.userData.isDisc || m.material?.blending === THREE.AdditiveBlending) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      for (let k = 0; k < dirs.length; k++) { const d = v.dot(dirs[k]); if (d > best[k].d) { best[k].d = d; best[k].v.copy(v); } }
    }
  });
  const hull = [];
  for (const b of best) if (!hull.some((h) => h.distanceTo(b.v) < 0.05)) hull.push(b.v.clone());
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // volume centroid (signed tetrahedra) for a better mass centre; fall back to bbox centre
  let vol = 0; const cen = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  obj.traverse((m) => {
    if (!m.isMesh || m.userData.isDisc || m.material?.blending === THREE.AdditiveBlending || m.material?.transparent) return;
    const g = m.geometry, pos = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      const v = a.dot(b.clone().cross(c)) / 6;
      vol += v; cen.x += v * (a.x + b.x + c.x) / 4; cen.y += v * (a.y + b.y + c.y) / 4; cen.z += v * (a.z + b.z + c.z) / 4;
    }
  });
  let centroid = center.clone();
  if (Math.abs(vol) > 1e-4) { const cc = cen.divideScalar(vol); if (box.clone().expandByScalar(0.01).containsPoint(cc)) centroid = cc; }
  const info = { box, size, center, centroid, hull, surfaces: obj.userData.surfaces || [] };
  infoCache.set(id, info);
  return info;
}
