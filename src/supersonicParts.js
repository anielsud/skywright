// Parts for very fast, very high flying (built for the SR-71 Blackbird, usable anywhere):
//   - Chined Body: a long blended fuselage with sharp chines running forward to the nose, widening into a shelf that
//     blends into a wing passing through it.
//   - Spike Ramjet: a turbo-ramjet nacelle with a pointed inlet spike at the front (it slides back as the Mach number
//     climbs) and a big ejector nozzle at the back. It pushes harder the faster it goes, all the way to about Mach 3,
//     and keeps burning much higher than a fighter engine (aircraft.js: engine.ram).
//   - All-Moving Fin: the whole fin turns on a spindle above a short fixed root (tilt it inwards on top of engines).
//   - Tandem Canopy: a small raked two-seat canopy: a pilot under glass, the second crew member under a hatch behind.
// They register into PARTS like parts.js's own (same fields, same build(color, { detail }) contract). Everything is
// procedural and built in part space, so any size, mirror or position works.
import * as THREE from 'three';
import { PARTS, revolve, smoothProfile, loft } from './parts.js';
import { M } from './materials.js';
import { PM, SKIN_TILE } from './planeMaterials.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { V, Bag, bar, pipe, shell, ringLoft, capHoles, norm } from './partDetail.js';
import { tandemInterior } from './jetCockpit.js';

function ensureUv1(obj) {
  obj.traverse((m) => { const g = m.geometry; if (m.isMesh && !g.attributes.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
  return obj;
}
function def(p) { const b = p.build; p.build = (c, o) => ensureUv1(b(c, o?.detail || 0)); PARTS[p.id] = p; }
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => { if (k <= 1e-6) return Math.max(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
// a smooth function of z through control points [[z, v], ...] (catmull-rom, tabulated)
function table(pts, n = 300) {
  const c = smoothProfile(pts, n), z0 = c[0][0], z1 = c.at(-1)[0];
  return (z) => {
    if (z <= z0) return c[0][1]; if (z >= z1) return c.at(-1)[1];
    let lo = 0, hi = c.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m][0] <= z) lo = m; else hi = m; }
    const a = c[lo], b = c[hi]; return a[1] + (b[1] - a[1]) * ((z - a[0]) / (b[0] - a[0] || 1));
  };
}

// ---------- Chined Body ----------
// Each section is the smooth union of a round core (radius rc, flatter underneath) and a lens-shaped chine shelf of
// half-span w whose faces meet at a sharp edge (y = tu(1 - x²/w²) above, -tl(1 - x²/w²) below). The union is taken on
// the radius in polar form (soft max = a fillet where the shelf meets the core). The upper and lower halves are separate
// strips so the chine edge shades crisp.
const CH = {
  z0: -17.5, z1: 13.5, KB: 0.8,
  rc: table([[-17.5, 0], [-16.7, 0.17], [-15, 0.4], [-13, 0.58], [-11, 0.71], [-8, 0.8], [-4, 0.85], [2, 0.85], [7, 0.8], [10, 0.62], [12, 0.36], [13.5, 0]]),
  w: table([[-17.5, 0], [-16.2, 0.42], [-14, 0.84], [-11, 1.22], [-8, 1.55], [-6, 1.82], [-4.5, 2.1], [-3, 2.5], [-1.5, 3.1], [0, 3.4], [6, 3.4], [9, 2.9], [10.7, 1.2], [12, 0.4], [13.5, 0]]),
};
function chineSec(z) {
  const rc = Math.max(1e-4, CH.rc(z)), w = Math.max(rc, CH.w(z), 1e-4), fade = smoothstep(0, 0.35 * rc + 0.02, w - rc);
  return { rc, w, tu: 0.8 * rc + 0.04 * fade, tl: 0.42 * rc, k: 0.3 * rc * fade };
}
function chineR(th, S) {
  const s = Math.abs(Math.sin(th)), c = Math.cos(th), cc = Math.abs(c);
  const h = c >= 0 ? S.rc : S.rc * CH.KB, Rc = 1 / Math.hypot(s / S.rc, c / h);
  const t = c >= 0 ? S.tu : S.tl, A = (t * s * s) / (S.w * S.w);
  const Rl = A < 1e-9 ? t / Math.max(cc, 1e-9) : (-cc + Math.sqrt(cc * cc + 4 * A * t)) / (2 * A);
  return smax(Rc, Rl, S.k);
}
export const chinePoint = (z, th) => { const r = chineR(th, chineSec(z)); return V(Math.sin(th) * r, Math.cos(th) * r, z); };
function chineGeometry(NZ = 84, NT = 40) {
  const { z0, z1 } = CH, half = SKIN_TILE / 2, circ = Math.max(1, Math.round((2 * Math.PI * 1.6) / half)) * half;
  const zs = []; for (let j = 0; j <= NZ; j++) { const t = j / NZ; zs.push(z0 + (z1 - z0) * (t - (0.09 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI))); } // (closer rings at the nose and tail)
  const geos = [];
  for (const [ta, tb] of [[-Math.PI / 2, Math.PI / 2], [Math.PI / 2, Math.PI * 1.5]]) { // upper strip (left edge, top, right edge), lower strip
    const pos = [], uv = [], uv1 = [], idx = [];
    for (const z of zs) {
      const S = chineSec(z);
      for (let i = 0; i <= NT; i++) {
        const t = i / NT, th = ta + (tb - ta) * (t - (0.55 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI)); // denser towards the chine edges
        const r = chineR(th, S);
        pos.push(Math.sin(th) * r, Math.cos(th) * r, z); uv.push((z - z0) / (z1 - z0), (th + Math.PI / 2) / (2 * Math.PI)); uv1.push(z, ((th + Math.PI / 2) / (2 * Math.PI)) * circ);
      }
    }
    const row = NT + 1;
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < NT; i++) { const a = j * row + i, b = (j + 1) * row + i, c = (j + 1) * row + i + 1, d = j * row + i + 1; idx.push(a, b, c, a, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
    g.setIndex(idx); g.computeVertexNormals(); geos.push(g);
  }
  return geos;
}
function chineBody(c, lv) {
  const g = new THREE.Group(), paint = PM.skin(c);
  g.add(new THREE.Mesh(mergeGeometries(chineGeometry(lv ? 96 : 72, lv ? 44 : 32)), paint)); // (one closed skin: the halves meet at the chine edges)
  if (!lv) return g;
  // detail: a pitot probe out of the nose tip, blade antennas under the belly and on the spine, a drag-chute door seam
  const b = new Bag(), nb = new Bag(), dark = M.darkMetal();
  const tip = V(0, 0, CH.z0);
  b.add(bar(tip.clone().add(V(0, 0, 0.35)), tip.clone().add(V(0, 0, -1.1)), 0.07, 0.025, true, 10), dark);
  nb.add(bar(tip.clone().add(V(0, 0, -1.05)), tip.clone().add(V(0, 0, -1.35)), 0.025, 0.012, true, 8), dark);
  const blade = (z, th, h) => { const p = chinePoint(z, th), n = p.clone().setZ(0).normalize(), q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), n);
    const s = new THREE.Shape(); s.moveTo(-h * 0.6, 0); s.lineTo(h * 0.5, 0); s.lineTo(h * 0.15, h); s.lineTo(-h * 0.1, h); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false }); geo.translate(0, -0.03, -0.01); geo.rotateY(Math.PI / 2);
    geo.applyMatrix4(new THREE.Matrix4().compose(p, q, V(1, 1, 1))); return geo; };
  for (const [z, th, h] of [[-6, Math.PI, 0.32], [2, Math.PI, 0.26], [-4.5, 0, 0.22]]) nb.add(blade(z, th, h), M.black());
  // the drag-chute door on the spine ahead of the tail cone: a dark seam ring
  const seam = []; for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; seam.push(chinePoint(9.2 + 0.7 * Math.cos(a), 0.32 * Math.sin(a)).multiplyScalar(1.004)); }
  nb.add(pipe(seam, 0.012, 4, 64), M.black());
  b.to(g); nb.to(g, true);
  return g;
}
def({ id: 'fus_chine', cat: 'fuselage', name: 'Chined Body', desc: 'Long blended speed body with sharp chines to the nose. Put a thin delta wing through it. Made for Mach 3.', mass: 24000, hp: 9000, color: 0x2b2f37, frontal: 0.4,
  build: chineBody });

// ---------- Spike Ramjet ----------
// Local: the inlet lip at z = 0, the nacelle back to the ejector at z = L. The spike (userData.spike) pokes out in front;
// planeDetail.updateDetail slides it aft with the Mach number (locked forward below Mach 1.6, fully back by 3.2).
const RJ = { L: 15.5, R: 1.2, spikeTravel: 0.66, fanZ: 2.0, nozZ: 13.6 };
export const RAMJET = RJ;
const NAC = [[0, 0.96], [0.25, 1.04], [1.5, 1.13], [3.5, 1.19], [5.5, 1.2], [10, 1.2], [12, 1.16], [14, 1.23], [15.5, 1.22]];
function ramjet(c, lv) {
  const g = new THREE.Group(), paint = PM.skin(c), { fanZ, nozZ } = RJ;
  // nacelle: one skin with a wall (its inside is the inlet duct in front and the ejector shroud behind)
  const prof = smoothProfile(NAC, 48), skin = revolve(prof, { segs: lv ? 56 : 36 });
  g.add(new THREE.Mesh(shell(skin, 0.05), paint));
  // the spike: a cone out of the inlet, then the centrebody narrowing back into the compressor hub
  const spike = new THREE.Group();
  const sp = revolve(smoothProfile([[-2.4, 0], [-1.6, 0.24], [-0.6, 0.5], [0, 0.6], [0.6, 0.62], [1.3, 0.52], [fanZ, 0.36]], 30), { segs: lv ? 40 : 24, cap: true });
  spike.add(new THREE.Mesh(sp, paint));
  g.add(spike); g.userData.spike = spike;
  // compressor face (spins: userData.fan) with its hub, which the spike's tail slides into; a dark bulkhead behind it
  const fan = new THREE.Group(), steel = M.steel();
  const hub = new THREE.Mesh(revolve([[fanZ - 0.25, 0.39], [fanZ + 1.1, 0.39]], { segs: 24, cap: true }), M.darkMetal()); fan.add(hub);
  const rIn = 1.12, nb = lv ? 22 : 14;
  if (lv) {
    const blades = [];
    for (let i = 0; i < nb; i++) {
      const rings = [];
      for (let k = 0; k <= 3; k++) { const t = k / 3, rr = 0.36 + (rIn - 0.34) * t, tw = 0.9 - 0.45 * t, cd = 0.2 * (1 + 0.3 * t), d = V(Math.cos(tw), 0, Math.sin(tw)), n = V(-Math.sin(tw), 0, Math.cos(tw)), ring = [];
        for (const [x, y] of [[-0.5, 0], [0, 0.012], [0.5, 0], [0, -0.012]]) ring.push(V(0, rr, 0).addScaledVector(d, x * cd).addScaledVector(n, y)); rings.push(ring); }
      const bg = ringLoft(rings, true, true); bg.rotateZ((i / nb) * Math.PI * 2); bg.translate(0, 0, fanZ + 0.2); blades.push(norm(bg));
    }
    fan.add(new THREE.Mesh(mergeGeometries(blades), PM.metal('titanium')));
  } else for (let i = 0; i < nb; i++) {
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.03, rIn - 0.36, 0.2), steel); bl.position.y = (rIn + 0.36) / 2; bl.rotation.y = 0.5;
    const piv = new THREE.Object3D(); piv.rotation.z = (i / nb) * Math.PI * 2; piv.position.z = fanZ + 0.2; piv.add(bl); fan.add(piv);
  }
  g.add(fan); g.userData.fan = fan;
  const wallR = (z) => { for (let i = 1; i < prof.length; i++) if (prof[i][0] >= z) { const a = prof[i - 1], b = prof[i]; return a[1] + (b[1] - a[1]) * ((z - a[0]) / (b[0] - a[0] || 1)); } return prof.at(-1)[1]; };
  const bulk = new THREE.Mesh(new THREE.CircleGeometry(wallR(fanZ + 0.9) - 0.04, 32), PM.exhaust()); bulk.position.z = fanZ + 0.9; bulk.rotation.y = Math.PI; g.add(bulk);
  // afterburner: the primary nozzle deep in the ejector, a sooty flame-holder face that closes the nacelle, the flames
  const ab = new THREE.Mesh(revolve([[nozZ - 1.6, wallR(nozZ - 1.6) - 0.05], [nozZ - 0.6, 0.95], [nozZ, 0.8], [nozZ + 0.05, 0.82]], { segs: 32 }), PM.duct(0x5a4a3e, 'hot')); g.add(ab);
  const face = new THREE.Mesh(new THREE.CircleGeometry(wallR(nozZ - 1.6) - 0.04, 32), PM.exhaust()); face.position.z = nozZ - 1.6; g.add(face);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.82, 9, 24, 1, true), M.flame().clone()); flame.rotation.x = -Math.PI / 2; flame.position.z = nozZ + 4.5; g.add(flame);
  const flameCore = new THREE.Mesh(new THREE.ConeGeometry(0.56, 4.6, 18, 1, true), M.flameCore().clone()); flameCore.rotation.x = -Math.PI / 2; flameCore.position.z = nozZ + 2.3; g.add(flameCore);
  g.userData.flame = flame; g.userData.flameCore = flameCore; g.userData.ab = true;
  if (lv) ramjetDetail(g, { paint, wallR, flameCore });
  return g;
}
function ramjetDetail(g, { paint, wallR, flameCore }) {
  const { nozZ } = RJ, b = new Bag(), nbag = new Bag(), dark = M.darkMetal();
  // sharp titanium cowl lip, a shock-trap seam on the spike, the spike's bleed slots
  const lip = new THREE.TorusGeometry(0.985, 0.028, 8, 64); lip.translate(0, 0, 0.03); b.add(lip, PM.metal('titanium'));
  const spike = g.userData.spike, sb = new Bag();
  for (const [z, r] of [[-0.62, 0.505], [0.3, 0.625]]) { const t = new THREE.TorusGeometry(r, 0.012, 4, 40); t.translate(0, 0, z); sb.add(t, M.black()); }
  for (let i = 0; i < 18; i++) { const s = new THREE.BoxGeometry(0.035, 0.012, 0.42); s.translate(0, 0.628, 0.25); s.rotateZ((i / 18) * Math.PI * 2); sb.add(s, M.black()); }
  sb.to(spike);
  // bypass and suck-in door outlines on the nacelle (dark seams flush with the skin), the ejector's tertiary door ring
  const ring = (z, r, rad = 0.014) => { const t = new THREE.TorusGeometry(r, rad, 4, 64); t.translate(0, 0, z); return t; };
  for (const z of [3.4, 5.0, 11.2]) nbag.add(ring(z, wallR(z) + 0.004), M.black());
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + 0.13; const d = new THREE.BoxGeometry(0.42, 0.02, 0.9); d.translate(0, wallR(4.2) - 0.006, 4.2); d.rotateZ(a); nbag.add(d, M.black()); }
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const d = new THREE.BoxGeometry(0.3, 0.02, 0.75); d.translate(0, wallR(13.0) - 0.006, 13.0); d.rotateZ(a); nbag.add(d, dark); }
  // ejector: free-floating flaps round the exit (heat-tinted), the afterburner's petals and flame-holder rings inside
  const nP = 20, petalM = PM.duct(0x5a4a3e, 'hot');
  for (let i = 0; i < nP; i++) { const a0 = (i / nP) * Math.PI * 2, da = (Math.PI * 2 / nP) * 0.6, p = new THREE.CylinderGeometry(0.97, 0.82, 0.7, 3, 1, true, a0 - da, da * 2); p.rotateX(-Math.PI / 2); p.translate(0, 0, nozZ - 0.32); b.add(p, petalM); }
  for (const [rr, dz] of [[0.62, 0.05], [0.36, 0.1]]) { const t = new THREE.TorusGeometry(rr, 0.03, 6, 32); t.translate(0, 0, nozZ - 1.6 + dz); b.add(t, M.steel()); }
  // flame-holder spokes from the inner ring to the wall
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2, d = V(Math.sin(a), Math.cos(a), 0), z = nozZ - 1.55; b.add(bar(d.clone().multiplyScalar(0.34).setZ(z), d.clone().multiplyScalar(wallR(z) - 0.02).setZ(z), 0.05, 0.05), M.steel()); }
  // the turbine face glows with the flame (it shares the flame core's material, so it lights with the afterburner)
  const glow = new THREE.Mesh(new THREE.CircleGeometry(wallR(nozZ - 1.6) - 0.06, 32), flameCore.material); glow.position.z = nozZ - 1.56; glow.userData.cosmetic = true; glow.castShadow = false; g.add(glow);
  // a hot ring at the primary nozzle throat, lit with the flame too
  const hotRing = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.05, 6, 40), flameCore.material); hotRing.position.z = nozZ + 0.02; hotRing.userData.cosmetic = true; hotRing.castShadow = false; g.add(hotRing);
  b.to(g); nbag.to(g, true);
}
def({ id: 'e_ramjet', cat: 'engine', name: 'Spike Ramjet', desc: 'Turbo-ramjet with an inlet spike. Pushes harder the faster you go, up to about Mach 3, and breathes very high. Full throttle for the afterburner.', mass: 2800, hp: 4000, color: 0x3a3e46, frontal: 0.4, // (the inlet swallows most of the front)
  engine: { type: 'jet', thrust: 62000, ab: 106000, spool: 4.5, sound: 'jet', ram: true },
  build: ramjet });

// ---------- All-Moving Fin ----------
// Built span-up like parts.js's fins (span +Y, thickness along X, chord along +Z from the leading edge): a short fixed
// root and, above a hairline gap, the whole fin turning on a spindle. One control strip (the whole fin).
const FIN = { span: 2.8, root: 3.4, tip: 1.2, sweep: 2.3, thick: 0.05, stub: 0.1, hinge: 0.98, axis: 0.4 }; // axis: spindle at this chord fraction of the middle
function allMovingFin(o, color, lv) {
  const wing = new THREE.Group(), paint = PM.skin(color);
  const chordAt = (s) => o.root + (o.tip - o.root) * s, leAt = (s) => -o.root / 2 + o.sweep * s;
  const sec = (s) => ({ x: s * o.span, y: 0, zLE: leAt(s), chord: chordAt(s) });
  const s0 = o.stub, s1 = o.stub + 0.012;
  wing.add(new THREE.Mesh(loft([sec(0), sec(s0)], 0, 1, o.thick, 0, lv ? 14 : 10), paint)); // the fixed root
  const secs = []; for (let k = 0; k <= 4; k++) secs.push(sec(s1 + (1 - s1) * (k / 4)));
  // the spindle runs straight out along the span (square to the root), through 40 % chord of the fin's middle: the pivot
  // only moves, never turns, so the part's box stays tight round the fin
  const zp = leAt(0.4) + o.axis * chordAt(0.4), pivot = new THREE.Object3D(); pivot.position.set(sec(s1).x, 0, zp); pivot.updateMatrix();
  const inv = pivot.matrix.clone().invert(), geo = loft(secs, 0, 1, o.thick, 0, lv ? 14 : 10); geo.applyMatrix4(inv);
  const hinged = new THREE.Object3D(); hinged.add(new THREE.Mesh(geo, paint)); pivot.add(hinged); wing.add(pivot);
  // the spindle: from inside the root up into the moving fin (it carries it)
  const sp = new THREE.Mesh(bar(V(sec(0.02).x, 0, zp), V(sec(s1 + 0.12).x, 0, zp), 0.07, 0.07, true, 10), M.darkMetal()); wing.add(sp);
  if (lv) { // a hinge fairing bump over the spindle on each side of the root
    const fb = new Bag(); for (const sgn of [1, -1]) { const f = new THREE.SphereGeometry(1, 12, 8); f.scale(o.span * 0.05, o.thick * o.root * 0.36, o.root * 0.11); f.translate(o.span * s0 * 0.55, 0, zp); f.scale(1, sgn, 1); fb.add(f, paint); } fb.to(wing);
  }
  let area = 0; for (let k = 0; k < 40; k++) area += chordAt((k + 0.5) / 40) * o.span / 40;
  const cs = sec(0.5), surfaces = [{ pos: [cs.x, 0, cs.zLE + 0.25 * cs.chord], n: [0, 1, 0], f: [0, 0, -1], s: [1, 0, 0], area, role: 'ctrl', chord: cs.chord, ar: Math.max(2, (2 * o.span * o.span) / area) }];
  const controls = [{ obj: hinged, strip: 0, role: 'ctrl', pivot, inv, secs }];
  const holder = new THREE.Group(); wing.rotation.z = Math.PI / 2; holder.add(wing);
  const rot = (v) => [-v[1], v[0], v[2]];
  for (const s of surfaces) { s.pos = rot(s.pos); s.n = rot(s.n); s.s = rot(s.s); s.f = rot(s.f); }
  holder.userData.controls = controls; holder.userData.surfaces = surfaces;
  return holder;
}
def({ id: 't_allmove', cat: 'tail', name: 'All-Moving Fin', desc: 'The whole fin turns, not just a rudder. Tilt it inwards on top of your engines, like a Blackbird.', mass: 260, hp: 1300, color: 0x2b2f37,
  attach: 'fin', allMoving: true, wing: FIN, build: (c, lv) => allMovingFin(FIN, c, lv) });

// ---------- Tandem Canopy ----------
// Origin at the middle of the base. The pilot sits under a raked glass canopy in front; the second crew member behind
// under a hatch with two small windows. Sits on top of a body (its base sinks a little into the skin).
const TC = { z0: -2.3, z1: 2.3, split: 0.05,
  w: table([[-2.3, 0.2], [-1.7, 0.4], [-0.9, 0.47], [0.6, 0.47], [1.6, 0.42], [2.3, 0.18]]),
  h: table([[-2.3, 0.02], [-1.55, 0.44], [-0.8, 0.56], [0.1, 0.55], [1.2, 0.49], [2.3, 0.04]]) };
const tcPt = (z, a, k = 1) => { const w = TC.w(z) * k, h = TC.h(z) * k, c = Math.cos(a); return V(Math.sin(a) * w, -0.06 + (h + 0.06) * Math.sign(c) * Math.abs(c) ** 0.75, z); }; // a = -pi/2 (left base) .. pi/2 (right base)
function tcSurface(za, zb, NZ, NA, k = 1) {
  const rings = []; for (let j = 0; j <= NZ; j++) { const z = za + (zb - za) * (j / NZ), ring = []; for (let i = 0; i <= NA; i++) ring.push(tcPt(z, -Math.PI / 2 + Math.PI * (i / NA), k)); rings.push(ring); }
  const pos = [], idx = [], uv1 = [], row = NA + 1;
  rings.forEach((r) => r.forEach((p, i) => { pos.push(p.x, p.y, p.z); uv1.push(p.z, (i / NA) * 1.6); }));
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NA; i++) { const a = j * row + i, b = (j + 1) * row + i, c = (j + 1) * row + i + 1, d = j * row + i + 1; idx.push(a, b, c, a, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function tandemCanopy(c, lv) {
  const g = new THREE.Group(), paint = PM.skin(c), { z0, z1, split } = TC, b = new Bag(), nb = new Bag();
  // pilot's glass and the second crew member's hatch (closed underneath, below the base)
  g.add(new THREE.Mesh(tcSurface(z0, split, lv ? 22 : 10, lv ? 24 : 12), PM.canopy(0x2a3440)));
  // (a shell, not capped at the base: a lid there cut through the second crew member at the chest)
  const hatch = lv ? shell(tcSurface(split, z1, 18, 24), 0.02) : capHoles(tcSurface(split, z1, 8, 12)); g.add(new THREE.Mesh(hatch, paint));
  // frames: windscreen bow, the arch between the two, a sill round the base
  const bow = (z, rad) => { const pts = []; for (let i = 0; i <= 18; i++) pts.push(tcPt(z, -Math.PI / 2 + Math.PI * (i / 18), 1.012)); return pipe(pts, rad, 6, 48); };
  b.add(bow(-1.62, 0.03), paint); b.add(bow(split, 0.04), paint);
  const sill = []; for (let i = 0; i < 40; i++) { const t = i / 40, z = t < 0.5 ? z0 + 0.04 + (z1 - z0 - 0.08) * (t * 2) : z1 - 0.04 - (z1 - z0 - 0.08) * ((t - 0.5) * 2), sgn = t < 0.5 ? 1 : -1; sill.push(tcPt(z, sgn * Math.PI / 2, 1.0).add(V(sgn * 0.02, 0.0, 0))); }
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sill, true), 120, 0.035, 6, true), paint);
  // the windscreen centre post (a V windscreen) and a frame line along the top of the pilot's hood
  { const pts = []; for (let i = 0; i <= 8; i++) pts.push(tcPt(-1.62 - 0.6 * (i / 8) ** 1.3, 0, 1.012)); b.add(pipe(pts, 0.022, 6, 24), paint); }
  if (lv) {
    // two small side windows in the hatch (glass panes standing just proud of it, framed)
    for (const sgn of [1, -1]) {
      const ctr = tcPt(0.85, sgn * 0.95, 1.0), n = tcPt(0.85, sgn * 0.95, 1.1).sub(ctr).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n), m = new THREE.Matrix4().compose(ctr.clone().addScaledVector(n, 0.006), q, V(1, 1, 1));
      const pane = new THREE.CircleGeometry(0.13, 20); pane.scale(1.4, 1, 1); pane.applyMatrix4(m); b.add(pane, PM.windscreen());
      const fr = new THREE.TorusGeometry(0.13, 0.014, 4, 24); fr.scale(1.4, 1, 1); fr.applyMatrix4(m); b.add(fr, paint);
    }
    // the cockpit tub under the glass and the hatch (it sinks into the body it sits on): the seats and panel stand on its floor
    { const rings = [-0.06, -0.72].map((y) => { const r = []; for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2, z = -1.95 * Math.cos(a); r.push(V(Math.sin(a) * TC.w(z) * 0.9, y, z)); } return r; });
      const tub = new THREE.Mesh(ringLoft(rings, true, true), PM.seat()); tub.userData.ownTub = true; g.add(tub); } // (planeDetail swaps it for one from the skin's opening when seated on a body)
    // the seats' risers (the tub floor at -0.72 and both seats on risers: the seats sat on a floor 10 cm under the cushion, no room for legs)
    for (const [y, z] of [[-0.48, -0.78], [-0.53, 1.02]]) { const h = y - 0.03 + 0.72, rs = new THREE.BoxGeometry(0.3, h, 0.28); rs.translate(0, -0.72 + h / 2, z); b.add(rs, M.darkMetal()); }
    // the rudder pedals' mounts on the floor (crew.js draws the pedals at the pilot's controls.pedZ / pedY)
    for (const sx of [-1, 1]) { const pm = new THREE.BoxGeometry(0.07, 0.07, 0.1); pm.translate(sx * 0.112, -0.685, -1.2); b.add(pm, M.darkMetal()); }
    // the bulkhead between the two cockpits, under the arch
    { const sh = new THREE.Shape(); sh.moveTo(-TC.w(split) * 0.9, -0.72); for (let i = 0; i <= 16; i++) { const p = tcPt(split, -Math.PI / 2 + Math.PI * (i / 16), 0.985); sh.lineTo(p.x, p.y); } sh.lineTo(TC.w(split) * 0.9, -0.72); sh.closePath();
      const bh = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false }); bh.translate(0, 0, split + 0.03); g.userData.bulkhead = bh; } // (painted with the stations: tandemInterior)
    // both stations (jetCockpit.js): ejection seats, consoles, the panels, glare shield, periscope; the crew's seats
    tandemInterior(g, b, nb, { T: TC, tcPt, split, paint });
  } else {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.6, 0.14), PM.seat()); seat.position.set(0, -0.12, -0.48); g.add(seat);
  }
  b.to(g); nb.to(g, true);
  return g;
}
def({ id: 'ck_tandem', cat: 'cockpit', name: 'Tandem Canopy', desc: 'Small raked two-seat canopy: the pilot in front, a second crew member behind. Sits on top of a long body.', mass: 320, hp: 500, color: 0x2b2f37,
  eye: [0, 0.36, -0.95], build: tandemCanopy });
// for planeDetail's canopy seat (the skirt down to the body when it sits on a body): th runs round the base from the
// front, ph from the base (0) over the top (pi/2)
// Signed distance-like value of a point (part coordinates) to the glass and hatch volume (< 0 inside): planeDetail cuts
// the opening in the body skin the canopy sinks into with it
export const TANDEM_VOL = (x, y, z) => {
  if (z < TC.z0 || z > TC.z1) return Math.max(TC.z0 - z, z - TC.z1) + 0.01;
  const w = TC.w(z), H = TC.h(z) + 0.06, yy = y + 0.06; if (yy <= 0) return Math.abs(x) - w;
  return (Math.hypot(x / w, (yy / H) ** (4 / 3)) - 1) * Math.min(w, H); // (the section: x = w sin a, y + 0.06 = H cos^0.75 a)
};
export const TANDEM_SHAPE = (th, ph) => tcPt(-(TC.z1 - 0.04) * Math.cos(th), (Math.sin(th) >= 0 ? 1 : -1) * (Math.PI / 2 - ph));
