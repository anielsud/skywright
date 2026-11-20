// The wind tunnel building (visual only): a glass-walled test section with a turntable and the sting that holds the
// model, the contraction with its honeycomb upstream, the diffuser and the big fan behind a grille downstream, light
// strips over the glass, and a control desk with dials beside it. Air blows along +Z (from the contraction to the
// fan); the model's centre of mass sits at (0, Y0, 0). Everything static is merged into one mesh per material.
// Lights are a fixed set made here once (no light is ever added or removed while the tunnel runs: that would
// recompile every lit shader).
import * as THREE from 'three';
import { Bag, bar, V } from './partDetail.js';

export const Y0 = 5; // height of the model's centre (the test section is 10 high)
export const SECTION = { x0: -8, x1: 8, y0: 0, y1: 10, z0: -14, z1: 14 };

const std = (color, rough = 0.6, metal = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
// a quad from four corners (a, b, c, d anticlockwise seen from the side it faces)
function quad(a, b, c, d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals(); return g;
}
const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };
const cyl = (rt, rb, h, x, y, z, seg = 16, rx = 0, rz = 0) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return g; };

// a canvas texture with a painted sign; the caller disposes it with the scene
function signTexture(lines, w = 1024, h = 256, bg = '#11161d', fg = '#ffcf4a') {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(14, 14, w - 28, h - 28);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach(([t, size, y]) => { g.font = `800 ${size}px system-ui, sans-serif`; g.fillText(t, w / 2, y); });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}

export function buildTunnelSet({ shadows = true } = {}) {
  const root = new THREE.Group(); root.name = 'tunnel-set';
  const S = SECTION;
  const mat = {
    floor: std(0x34373c, 0.85), dark: std(0x15181c, 0.7), wall: std(0x262b31, 0.9, 0, { side: THREE.BackSide }), steel: std(0x7d848c, 0.35, 0.85), frame: std(0x3e454d, 0.45, 0.7),
    yellow: std(0xe0a400, 0.5, 0.2), stripe: std(0xd8dde2, 0.6), duct: std(0x4b525a, 0.55, 0.6), blade: std(0x2c3136, 0.45, 0.5), desk: std(0x2a2f36, 0.6, 0.2),
    glass: new THREE.MeshStandardMaterial({ color: 0xd8ecff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 2.2 }),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.6, 2.4) }), screen: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.35, 0.55) }),
    led: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 0.6) }), red: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.25, 0.15) }),
    dial: std(0xf2efe6, 0.5), needle: new THREE.MeshBasicMaterial({ color: 0xff3020 }),
  };
  const b = new Bag();
  // ---- the hall ----
  b.add(box(90, 0.2, 110, 0, -0.1, 0), mat.floor);
  b.add(box(90, 26, 110, 0, 12.8, 0), mat.wall); // (seen from inside: BackSide)
  for (let z = -40; z <= 40; z += 10) b.add(box(0.12, 0.02, 4, 18, 0.01, z), mat.yellow); // walkway lines
  b.add(box(0.12, 0.02, 90, 16, 0.01, 0), mat.yellow); b.add(box(0.12, 0.02, 90, -16, 0.01, 0), mat.yellow);
  // ---- test section: floor, turntable, glass box, frames ----
  b.add(box(16, 0.3, 28, 0, -0.14, 0), mat.dark);
  for (let x = -6; x <= 6; x += 2) b.add(box(0.04, 0.02, 28, x, 0.02, 0), mat.frame);
  { const g = new THREE.CylinderGeometry(3, 3, 0.06, 48); g.translate(0, 0.03, 0); b.add(g, mat.frame); }
  { const g = new THREE.TorusGeometry(2.6, 0.035, 6, 64); g.rotateX(Math.PI / 2); g.translate(0, 0.07, 0); b.add(g, mat.stripe); }
  for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; b.add(box(0.04, 0.02, k % 6 ? 0.25 : 0.6, Math.sin(a) * 2.75, 0.07, Math.cos(a) * 2.75, 0, a), mat.stripe); }
  b.add(box(0.25, 0.02, 3.5, 0, 0.02, -10), mat.stripe); // flow arrow on the floor
  { const g = new THREE.ConeGeometry(0.6, 1.2, 3); g.rotateX(Math.PI / 2); g.scale(1, 0.03, 1); g.translate(0, 0.03, -7.8); b.add(g, mat.stripe); }
  const glass = new THREE.Group();
  for (const x of [S.x0, S.x1]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(28, 10), mat.glass); m.rotation.y = Math.PI / 2; m.position.set(x, 5, 0); m.renderOrder = 6; glass.add(m); }
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(16, 28), mat.glass); m.rotation.x = Math.PI / 2; m.position.set(0, 10, 0); m.renderOrder = 6; glass.add(m); }
  root.add(glass);
  for (const z of [-14, -7, 0, 7, 14]) {
    const w = z === -14 || z === 14 ? 0.5 : 0.22;
    for (const x of [S.x0, S.x1]) b.add(box(0.35, 10.4, w, x, 5.1, z), mat.frame);
    b.add(box(16.6, 0.35, w, 0, 10.15, z), mat.frame);
  }
  for (const x of [S.x0, S.x1]) { b.add(box(0.4, 0.4, 28, x, 10.15, 0), mat.frame); b.add(box(0.4, 0.5, 28, x, 0.1, 0), mat.frame); }
  // light strips above the glass
  for (const x of [-5, -1.7, 1.7, 5]) { b.add(box(0.5, 0.12, 26, x, 10.55, 0), mat.lamp); b.add(box(0.8, 0.25, 26.5, x, 10.75, 0), mat.frame); }
  // ---- contraction (upstream) and honeycomb ----
  const zc = -26, X1 = 13, Y1 = 16;
  b.add(quad([S.x0, 0, S.z0], [-X1, 0, zc], [-X1, Y1, zc], [S.x0, 10, S.z0]), mat.duct); // left wall (faces in)
  b.add(quad([S.x1, 0, S.z0], [S.x1, 10, S.z0], [X1, Y1, zc], [X1, 0, zc]), mat.duct);
  b.add(quad([S.x0, 10, S.z0], [-X1, Y1, zc], [X1, Y1, zc], [S.x1, 10, S.z0]), mat.duct); // roof
  b.add(quad([S.x0, 0.001, S.z0], [S.x1, 0.001, S.z0], [X1, 0.001, zc], [-X1, 0.001, zc]), mat.dark);
  for (let x = -X1 + 1; x < X1; x += 1) b.add(box(0.04, Y1, 0.5, x, Y1 / 2, zc + 0.4), mat.frame);
  for (let y = 1; y < Y1; y += 1) b.add(box(2 * X1, 0.04, 0.5, 0, y, zc + 0.4), mat.frame);
  b.add(box(2 * X1 + 1, 0.6, 0.8, 0, Y1 + 0.3, zc + 0.4), mat.yellow); b.add(box(0.6, Y1, 0.8, -X1 - 0.3, Y1 / 2, zc + 0.4), mat.yellow); b.add(box(0.6, Y1, 0.8, X1 + 0.3, Y1 / 2, zc + 0.4), mat.yellow);
  // ---- diffuser and fan (downstream) ----
  const zd = 26, X2 = 9.5, Y2 = 13.5, fanY = 6.6, fanR = 6.2;
  b.add(quad([S.x0, 0, S.z1], [S.x0, 10, S.z1], [-X2, Y2, zd], [-X2, 0, zd]), mat.duct);
  b.add(quad([S.x1, 0, S.z1], [X2, 0, zd], [X2, Y2, zd], [S.x1, 10, S.z1]), mat.duct);
  b.add(quad([S.x0, 10, S.z1], [S.x1, 10, S.z1], [X2, Y2, zd], [-X2, Y2, zd]), mat.duct);
  b.add(quad([S.x0, 0.001, S.z1], [-X2, 0.001, zd], [X2, 0.001, zd], [S.x1, 0.001, S.z1]), mat.dark);
  { // the fan wall: a square plate with a round hole for the fan
    const sh = new THREE.Shape(); sh.moveTo(-X2, 0); sh.lineTo(X2, 0); sh.lineTo(X2, Y2); sh.lineTo(-X2, Y2); sh.closePath();
    const hole = new THREE.Path(); hole.absarc(0, fanY, fanR + 0.3, 0, Math.PI * 2, true); sh.holes.push(hole);
    const g = new THREE.ShapeGeometry(sh, 48); g.translate(0, 0, zd); b.add(g, mat.duct);
    const g2 = g.clone(); g2.rotateY(Math.PI); g2.translate(0, 0, 2 * zd); b.add(g2, mat.duct);
  }
  { const g = new THREE.CylinderGeometry(fanR + 0.3, fanR + 0.3, 3.5, 64, 1, true); g.rotateX(Math.PI / 2); g.translate(0, fanY, zd + 1.75); b.add(g, mat.duct);
    const g2 = new THREE.TorusGeometry(fanR + 0.3, 0.32, 10, 72); g2.translate(0, fanY, zd); b.add(g2, mat.yellow); }
  // grille in front of the fan
  for (const r of [1.8, 3.4, 5.0]) { const g = new THREE.TorusGeometry(r, 0.05, 6, 64); g.translate(0, fanY, zd - 0.2); b.add(g, mat.steel); }
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; b.add(bar(V(Math.cos(a) * 0.9, fanY + Math.sin(a) * 0.9, zd - 0.2), V(Math.cos(a) * (fanR + 0.2), fanY + Math.sin(a) * (fanR + 0.2), zd - 0.2), 0.08, 0.08, true, 6), mat.steel); }
  // motor nacelle and its struts
  b.add(cyl(1.25, 1.25, 4, 0, fanY, zd + 3.4, 32, Math.PI / 2), mat.frame);
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; b.add(bar(V(Math.cos(a) * 1.2, fanY + Math.sin(a) * 1.2, zd + 3.5), V(Math.cos(a) * (fanR + 0.3), fanY + Math.sin(a) * (fanR + 0.3), zd + 3.5), 0.25, 0.25), mat.frame); }
  // ---- the sting: a streamlined strut up from the turntable to the model ----
  { const g = new THREE.CylinderGeometry(0.2, 0.26, Y0 - 0.25, 24); g.scale(0.35, 1, 1); g.translate(0, (Y0 - 0.25) / 2, 0); b.add(g, mat.frame); }
  b.add(box(1.4, 0.5, 1.4, 0, 0.3, 0), mat.frame); // the force balance at its foot
  // ---- control desk (outside the glass, on the left) ----
  const dx = -12.5, dz = 3;
  b.add(box(1.2, 1.0, 7, dx, 0.5, dz), mat.desk);
  b.add(box(1.4, 0.08, 7.2, dx + 0.1, 1.04, dz), mat.frame);
  b.add(box(0.12, 1.1, 7, dx - 0.35, 1.6, dz, 0, 0, -0.45), mat.desk); // slanted console
  for (let k = 0; k < 3; k++) b.add(box(0.05, 0.7, 1.6, dx + 0.0, 1.7, dz - 2.2 + k * 2.2, 0, 0, -0.45), mat.screen);
  for (let k = 0; k < 14; k++) b.add(box(0.06, 0.06, 0.06, dx + 0.45, 1.1, dz - 3 + k * 0.45), k % 4 ? mat.led : mat.red);
  b.add(cyl(0.3, 0.3, 0.08, dx - 1.3, 0.6, dz, 16), mat.desk); b.add(box(0.6, 0.08, 0.6, dx - 1.3, 0.65, dz), mat.desk); b.add(box(0.08, 0.7, 0.6, dx - 1.6, 1.0, dz), mat.desk); // chair
  b.add(cyl(0.04, 0.04, 0.6, dx - 1.3, 0.3, dz, 6), mat.steel);
  // cable trays along the floor to the section
  b.add(box(4.2, 0.12, 0.5, dx + 2.6, 0.06, dz), mat.frame);
  // ---- pillars and big posts in the hall ----
  for (const [x, z] of [[-20, -20], [-20, 20], [20, -20], [20, 20]]) b.add(box(1.2, 26, 1.2, x, 12.8, z), mat.frame);
  b.to(root);
  root.traverse((o) => { if (o.isMesh && o.material !== mat.glass && o.material !== mat.lamp) { o.castShadow = shadows && o.material !== mat.wall; o.receiveShadow = shadows; } });
  // ---- the fan (spins) ----
  const fan = new THREE.Group(); fan.position.set(0, fanY, zd + 1.2);
  { const fb = new Bag();
    fb.add(new THREE.SphereGeometry(1.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), mat.frame);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2, g = new THREE.BoxGeometry(1.1, fanR - 1.2, 0.1);
      g.translate(0, (fanR - 1.2) / 2 + 1.0, 0); g.rotateY(0.45); g.rotateZ(a); fb.add(g, mat.blade);
    }
    fb.to(fan); }
  fan.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  root.add(fan);
  // ---- three dials on the desk: lift, drag, speed (needles turn) ----
  const dials = [];
  for (let k = 0; k < 3; k++) {
    const g = new THREE.Group(); g.position.set(dx - 0.28, 2.05, dz - 2.2 + k * 2.2); g.rotation.set(0, -Math.PI / 2, 0); g.rotateX(-0.45);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), mat.dial); g.add(face);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 40), mat.frame); g.add(rim);
    const nd = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.36, 0.01), mat.needle); nd.geometry.translate(0, 0.16, 0.01); g.add(nd);
    for (let t = 0; t <= 10; t++) { const a = -2.2 + (t / 10) * 4.4, m = new THREE.Mesh(new THREE.BoxGeometry(0.015, t % 5 ? 0.04 : 0.08, 0.005), mat.needle); m.position.set(Math.sin(a) * 0.36, Math.cos(a) * 0.36, 0.005); m.rotation.z = -a; g.add(m); }
    root.add(g); dials.push(nd);
  }
  // ---- signs ----
  const signTex = signTexture([['WIND TUNNEL', 120, 105], ['TEST SECTION 1  ·  AIR FLOWS THIS WAY  →', 44, 195]]);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false }));
  sign.position.set(-14.5, 13.5, 0); sign.rotation.y = Math.PI / 2; root.add(sign);
  // ---- lights (fixed set) ----
  const hemi = new THREE.HemisphereLight(0xc4d8ff, 0x23262b, 0.9); root.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.3); sun.position.set(-9, 22, -10); sun.target.position.set(0, Y0, 0);
  sun.castShadow = shadows;
  if (shadows) { sun.shadow.mapSize.set(1024, 1024); const c = sun.shadow.camera; c.left = -12; c.right = 12; c.top = 14; c.bottom = -14; c.near = 4; c.far = 50; sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; }
  root.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.7); fill.position.set(12, 8, 14); root.add(fill);
  return { root, fan, dials, sun, glass, fanY };
}
