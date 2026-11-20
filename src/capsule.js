// Crew capsules in round bodies (visual only; physics never sees any of it). A crew that rides inside a round body (the
// Rocket Stage's capsule) has no canopy part to look out of, so the cockpit view used to sit inside a closed, dark tank.
// One window layout, worked out from the body's profile and its seat, drives both halves, so the windows you look out
// of from inside are the ones on the outside:
//   capsuleWindows(): cuts the windows into the body's skin (glazed, with frames, a dark liner behind them);
//   CapsuleView: the first-person cockpit. Plane cockpits hide the canopy part and look out through the open frame; a
//   capsule instead swaps the whole body for an interior while you're inside it: padded walls with the same windows
//   open to the sky and framed, an aft bulkhead, a seat under you and an instrument panel ahead.
import * as THREE from 'three';
import { M } from './materials.js';
import { PM } from './planeMaterials.js';
import { V, pipe, Bag, seatGeo } from './partDetail.js';
import { clipGeometry } from './skinBlend.js';

// radius of a profile ([[z, r], ...], nose first) at z
export function profileR(prof, z) {
  if (z <= prof[0][0]) return prof[0][1];
  for (let i = 1; i < prof.length; i++) if (prof[i][0] >= z) { const [za, ra] = prof[i - 1], [zb, rb] = prof[i]; return ra + (rb - ra) * ((z - za) / (zb - za || 1)); }
  return prof.at(-1)[1];
}

// Where the crew's eye and the windows go, in the body's own frame, from its profile and the (first) seat:
//   eye: on the axis just nose-wards of the seat (a capsule crew lies with the head towards the nose);
//   side portholes left and right, level with the eye, to look straight out of;
//   a ring of four windows on the nose's shoulder (where it has narrowed to ~88 % of the body), ahead and round the
//   middle of the forward view, like a capsule's forward windows.
// Windows: { az (rad from +x towards +y), z, r (m, along the skin) }.
export function capsuleLayout(prof, seat) {
  const R = Math.max(...prof.map((q) => q[1])), zs = seat[2], eye = V(0, 0.06 * R, zs - 0.45);
  let zf = prof[0][0]; for (let z = prof[0][0]; z < zs; z += 0.01) if (profileR(prof, z) >= 0.88 * R) { zf = z; break; }
  const wins = [];
  for (const az of [0, Math.PI]) wins.push({ az, z: zs - 0.65, r: 0.333 * R, side: true });
  for (let k = 0; k < 4; k++) wins.push({ az: Math.PI / 4 + (k * Math.PI) / 2, z: zf, r: 0.24 * R });
  const zAft = zs + 0.5, zNose = Math.min(zf - 0.6, prof.find((q) => q[1] > 0.3 * R)?.[0] ?? zf - 0.6); // the cabin's ends
  return { R, eye, wins, zAft, zNose };
}

// signed distance (m, along the skin of radius rr) from a point (x, y, z) to the edge of a window: < 0 inside it
const winD = (w, x, y, z, rr) => { let da = Math.atan2(y, x) - w.az; da = Math.atan2(Math.sin(da), Math.cos(da)); return Math.hypot(da * rr, z - w.z) - w.r; };
// a point on the surface of revolution (radius from the profile, plus off) at arc length s round from the window centre
const onSkin = (prof, w, s, dz, off) => { const z = w.z + dz, rr = profileR(prof, z) + off, a = w.az + s / profileR(prof, w.z); return V(Math.cos(a) * rr, Math.sin(a) * rr, z); };
const loop = (prof, w, rr, off, n = 40) => Array.from({ length: n + 1 }, (_, k) => { const a = (k / n) * Math.PI * 2; return onSkin(prof, w, Math.sin(a) * rr, Math.cos(a) * rr, off); });
// a disc of glass laid on the curved skin
function glassDisc(prof, w, rr, off) {
  const g = new THREE.CircleGeometry(rr, 28), P = g.attributes.position;
  for (let i = 0; i < P.count; i++) { const p = onSkin(prof, w, P.getX(i), P.getY(i), off); P.setXYZ(i, p.x, p.y, p.z); }
  g.computeVertexNormals(); return g;
}

const cache = new Map(), mat = (k, make) => { if (!cache.has(k)) cache.set(k, make()); return cache.get(k); };
const liner = () => mat('liner', () => new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.9, side: THREE.BackSide }));

// Cut the layout's windows into a body's skin (the skin mesh: g's glazed mesh, else its biggest), glaze and frame them,
// and line the cabin behind them. A window the body's own builder already cut (no skin left inside it) is left alone.
export function capsuleWindows(g, prof, seat) {
  const L = capsuleLayout(prof, seat); g.userData.capsuleSeat = seat; // (CapsuleView finds the crewed body by this)
  let skin = null, most = 0;
  g.traverse((o) => { if (!o.isMesh || o.material?.side === THREE.BackSide) return; const n = o.geometry.attributes.position.count; if (o.userData.openOk) { if (!skin?.userData.openOk) skin = o; } else if (!skin?.userData.openOk && n > most) { most = n; skin = o; } });
  if (!skin) return L;
  const P = skin.geometry.attributes.position, v = new THREE.Vector3();
  const todo = L.wins.filter((w) => { for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (winD(w, v.x, v.y, v.z, Math.hypot(v.x, v.y)) < -0.03) return true; } return false; });
  if (!todo.length) return L;
  const d = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); d[i] = Math.min(...todo.map((w) => winD(w, v.x, v.y, v.z, Math.hypot(v.x, v.y)))); }
  const cut = clipGeometry(skin.geometry, d);
  if (cut) { skin.geometry.dispose(); skin.geometry = cut; skin.userData.openOk = 'capsule windows: glazed'; }
  const b = new Bag();
  for (const w of todo) {
    g.add(new THREE.Mesh(glassDisc(prof, w, w.r + 0.03, -0.03), PM.canopy(0x1d2a33)));
    b.add(pipe(loop(prof, w, w.r + 0.02, 0.008), 0.03, 8, 80), M.darkMetal());
  }
  // the dark cabin wall behind windows that the body's own lining doesn't reach (a skin is one-sided: through the glass
  // you'd see out of the far side)
  const zs = todo.map((w) => w.z), z0 = Math.min(...zs) - 0.4, z1 = Math.max(...zs) + 0.4, pts = [];
  for (let z = z0; z <= z1 + 1e-6; z += 0.05) pts.push([z, profileR(prof, z) - 0.04]);
  b.add(revolveXY(pts, 48), liner());
  b.to(g);
  return L;
}

// a surface of revolution about z (outward normals), angle from +x towards +y like the layout, open ends
// (uv in metres: round the wall, along z)
function revolveXY(pts, segs) {
  const pos = [], uv = [], idx = [], row = segs + 1;
  for (const [z, r] of pts) for (let i = 0; i <= segs; i++) { const a = (i / segs) * Math.PI * 2; pos.push(Math.cos(a) * r, Math.sin(a) * r, z); uv.push(a * r, z); }
  for (let j = 0; j < pts.length - 1; j++) for (let i = 0; i < segs; i++) { const a = j * row + i, b = a + row; idx.push(a, a + 1, b + 1, a, b + 1, b); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ---------- first-person ----------
// Inside a closed cabin the sky's reflection light would light every wall evenly (it reads as more sky): the cabin
// materials take little of it, a faint glow of their own (no extra lights: the flight's light set is fixed) and
// the sun only through the windows (the wall casts shadows).
function quilt() { // diamond-quilted padding, 25 cm a diamond
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#c9ccd0'; g.fillRect(0, 0, 64, 64);
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 34); gr.addColorStop(0, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0.18)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#80858c'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, 32); g.lineTo(32, 0); g.lineTo(64, 32); g.lineTo(32, 64); g.closePath(); g.stroke();
  for (const [x, y] of [[0, 32], [32, 0], [64, 32], [32, 64]]) { g.fillStyle = '#5d6168'; g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const cabin = (o) => Object.assign(new THREE.MeshStandardMaterial({ roughness: 0.85, envMapIntensity: 0.2, ...o }));
const padMat = () => mat('pad', () => cabin({ color: 0xaeb3ba, map: quilt(), emissive: 0x15171a, side: THREE.BackSide })); // quilted cabin wall
const wallMat = () => mat('bulk', () => cabin({ color: 0x8c929a, emissive: 0x111215 }));
const ribMat = () => mat('rib', () => cabin({ color: 0x4a4f57, roughness: 0.55, metalness: 0.4 }));
const floorMat = () => mat('floor', () => cabin({ color: 0x3a3e45, roughness: 0.9 }));
const panelMat = () => mat('panel', () => cabin({ color: 0x2b2f36, roughness: 0.6, metalness: 0.2, emissive: 0x0a0b0d, envMapIntensity: 0.4 }));
// the panel's screens: a trajectory arc, a fuel gauge, a little Earth (drawn once, glowing)
function screenTex(kind) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 88; const g = c.getContext('2d');
  g.fillStyle = '#04120c'; g.fillRect(0, 0, 128, 88); g.lineWidth = 3; g.lineCap = 'round';
  if (kind === 0) { g.strokeStyle = '#2bd96b'; g.beginPath(); g.moveTo(10, 80); g.quadraticCurveTo(40, 6, 118, 14); g.stroke(); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(52, 30, 5, 0, 7); g.fill(); g.strokeStyle = 'rgba(43,217,107,0.35)'; g.lineWidth = 1; for (let x = 0; x < 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 88); g.stroke(); } }
  else if (kind === 1) { g.fillStyle = '#1a1206'; g.fillRect(0, 0, 128, 88); g.strokeStyle = '#ffa726'; g.beginPath(); g.arc(64, 70, 46, Math.PI, 2 * Math.PI); g.stroke(); g.lineWidth = 4; g.beginPath(); g.moveTo(64, 70); g.lineTo(94, 36); g.stroke(); g.fillStyle = '#ffa726'; g.font = 'bold 16px sans-serif'; g.fillText('FUEL', 44, 86); }
  else { g.fillStyle = '#020a18'; g.fillRect(0, 0, 128, 88); g.fillStyle = '#1f6fd1'; g.beginPath(); g.arc(64, 44, 34, 0, 7); g.fill(); g.fillStyle = '#3fbf5a'; for (const [x, y, r] of [[52, 34, 12], [76, 52, 10], [70, 28, 6]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); } g.strokeStyle = '#9fd4ff'; g.lineWidth = 2; g.beginPath(); g.ellipse(64, 44, 54, 14, -0.3, 0, 7); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const screenMat = (k) => mat('scr' + k, () => { const t = screenTex(k); return new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.25, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 1.1 }); });
const knobMat = (c) => mat('knob' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.35 }));
const seatMat = () => mat('seat', () => cabin({ color: 0x3b4450, roughness: 0.9, emissive: 0x0b0d10 }));
const glassIn = () => mat('glassIn', () => new THREE.MeshPhysicalMaterial({ color: 0xcfe6ff, roughness: 0.05, transparent: true, opacity: 0.12, depthWrite: false }));

// For a vehicle flown from inside a round body: the body part (its built object is hidden while you're in the view) and
// a first-person interior in its place. ac: the Aircraft. Returns null when there is no round crewed body.
export class CapsuleView {
  static for(ac) { // (made by stations.js for the capsule's seat: a build may have canopies as well)
    const p = ac.parts.find((q) => { const u = q.obj?.userData; return u?.body?.prof && (u.body.sx ?? 1) === 1 && (u.body.sy ?? 1) === 1 && u.capsuleSeat; });
    return p ? new CapsuleView(ac, p) : null;
  }
  constructor(ac, part) {
    this.ac = ac; this.part = part;
    const u = part.obj.userData, prof = u.body.prof, L = (this.L = capsuleLayout(prof, u.capsuleSeat));
    this.root = buildInterior(prof, L); this.root.visible = false;
    part.m.decompose(this.root.position, this.root.quaternion, this.root.scale);
    ac.root.add(this.root);
    ac.capsuleEye = L.eye.clone().applyMatrix4(part.m); // the cockpit camera sits here (cameras.js)
    // parts tucked away inside the cabin (the stock Rocket's RCS block) would float in the middle of it: hidden too
    const inv = part.m.clone().invert(), c = new THREE.Vector3();
    this.inside = ac.parts.filter((q) => { if (q === part || !q.obj) return false; c.copy(q.center).applyMatrix4(inv); return c.z > L.zNose && c.z < L.zAft && Math.hypot(c.x, c.y) < profileR(prof, c.z) - 0.05; });
    this.on = false;
  }
  set(on) {
    const alive = this.part.alive;
    if (!alive) { this.ac.capsuleEye = null; on = false; }
    if (on === this.on) return; this.on = on;
    this.root.visible = on; this.part.obj.visible = !on;
    for (const q of this.inside) if (q.obj) q.obj.visible = !on;
  }
}

function buildInterior(prof, L) {
  const g = new THREE.Group(), b = new Bag(), eye = L.eye, R = L.R;
  // padded wall: the skin less 5 cm from the nose to the aft bulkhead, the windows cut out of it
  const pts = []; for (let z = L.zNose; z <= L.zAft + 1e-6; z += 0.04) pts.push([z, profileR(prof, z) - 0.05]);
  let wall = revolveXY(pts, 72);
  const P = wall.attributes.position, d = new Float32Array(P.count), v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); d[i] = Math.min(...L.wins.map((w) => winD(w, v.x, v.y, v.z, Math.hypot(v.x, v.y)))); }
  wall = clipGeometry(wall, d) || wall;
  const wm = new THREE.Mesh(wall, padMat()); wm.castShadow = true; wm.receiveShadow = true; g.add(wm); // (casts: the sun only gets in through the windows)
  // end caps: aft bulkhead (faces the crew) and the little dome cap at the nose end
  const rA = profileR(prof, L.zAft) - 0.05, aft = new THREE.CircleGeometry(rA, 48); aft.rotateY(Math.PI); aft.translate(0, 0, L.zAft); b.add(aft, wallMat());
  const rN = profileR(prof, L.zNose) - 0.05, nose = new THREE.CircleGeometry(rN, 32); nose.translate(0, 0, L.zNose); b.add(nose, wallMat());
  // windows: frame rings on the inside wall and a faint pane where the skin is
  for (const w of L.wins) {
    b.add(pipe(loop(prof, w, w.r + 0.01, -0.06), 0.035, 8, 80), M.darkMetal());
    b.add(pipe(loop(prof, w, w.r - 0.005, -0.03), 0.012, 6, 60), M.steel());
    b.add(glassDisc(prof, w, w.r + 0.01, -0.025), glassIn());
  }
  // ribs round the wall between the windows, and a floor deck under the seat and the panel
  for (let z = L.zAft - 0.15; z > L.zNose + 0.25; z -= 0.45) {
    if (L.wins.some((w) => Math.abs(z - w.z) < w.r + 0.08)) continue;
    const rr = profileR(prof, z) - 0.065, ring = new THREE.TorusGeometry(rr, 0.025, 6, 48); ring.translate(0, 0, z); b.add(ring, ribMat());
  }
  { const fy = -0.66 * R, z0 = eye.z - 0.85, z1 = L.zAft, rows = [];
    for (let z = z0; z <= z1 + 1e-6; z += 0.05) { const r = profileR(prof, z) - 0.055, hw = Math.sqrt(Math.max(0, r * r - fy * fy)); rows.push([z, hw]); }
    const pos = [], idx = []; rows.forEach(([z, hw], k) => { pos.push(-hw, fy, z, hw, fy, z); if (k) { const a = (k - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } });
    const deck = new THREE.BufferGeometry(); deck.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); deck.setIndex(idx); deck.computeVertexNormals();
    deck.setAttribute('uv', new THREE.Float32BufferAttribute(pos.filter((_, n) => n % 3 !== 1), 2)); b.add(deck, floorMat()); }
  // seat under the eye, its back behind the head
  const st = seatGeo(0.56, 0.8, 0.5, 0.18); st.translate(0, -0.62 * R, eye.z + 0.28); b.add(st, seatMat());
  // instrument panel ahead and below the line of sight, tilted up to face the crew, standing on the floor of the cabin
  const pz = eye.z - 0.58, py = eye.y - 0.44 * R, tilt = -0.6, pw = Math.min(0.85, 0.95 * R), ph = 0.3;
  const face = new THREE.Matrix4().makeRotationX(tilt).setPosition(0, py, pz);
  const slab = new THREE.BoxGeometry(pw, ph, 0.06); slab.applyMatrix4(face); b.add(slab, panelMat());
  const fy = -0.66 * R, foot = new THREE.BoxGeometry(pw * 0.5, Math.max(0.05, py - fy), 0.05); foot.translate(0, (py + fy) / 2, pz + 0.05); b.add(foot, panelMat()); // the panel's pedestal, down to the deck
  const onFace = (geo, x, y) => { geo.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, 0.035)); geo.applyMatrix4(face); return geo; };
  // three screens: a green trajectory, an amber gauge, a blue map
  [-0.3, 0, 0.3].forEach((x, k) => { b.add(onFace(new THREE.PlaneGeometry(0.21, 0.145), x * pw, 0.045), screenMat(k)); });
  for (const [k, x] of [-0.36, -0.22, -0.08, 0.08, 0.22, 0.36].entries()) { const btn = new THREE.CylinderGeometry(0.018, 0.018, 0.02, 12); btn.rotateX(Math.PI / 2); b.add(onFace(btn, x * pw, -0.1), knobMat([0xffd400, 0xffffff, 0x4cd486][k % 3])); }
  const big = new THREE.CylinderGeometry(0.04, 0.045, 0.03, 20); big.rotateX(Math.PI / 2); b.add(onFace(big, 0.42 * pw, 0.08), knobMat(0xe53935)); // the big red button
  // a hand controller on the right of the seat
  const stick = new THREE.CylinderGeometry(0.018, 0.022, 0.2, 10); stick.rotateX(-0.3); stick.translate(0.26, -0.5 * R, eye.z - 0.1); b.add(stick, panelMat());
  const grip = new THREE.SphereGeometry(0.035, 12, 8); grip.translate(0.26, -0.4 * R, eye.z - 0.13); b.add(grip, knobMat(0x222222));
  b.to(g);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = !o.material.transparent; o.receiveShadow = true; } }); // (casters are also drawn by the warm-up frame: no shader compiles mid-flight)
  return g;
}
