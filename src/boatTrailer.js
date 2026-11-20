// A boat in the hangar (and in its picture) sits on a road trailer fitted to its hull: carpeted bunks shaped to the
// bottom either side of the keel (or under each tube of a pontoon), keel rollers, a galvanised frame on one axle with
// mudguards, an A-frame tongue with a hitch, and a winch post up to the bow. Built from the hull's own columns
// (boat.js hullColumns), so a kid's boat of any shape and size gets a trailer that fits it.
// Visual only, like hangar.uprightStage's launch stand: returns { stand, y } (stand in world space, y for root.position.y).
import * as THREE from 'three';
import { PARTS } from './parts.js';
import { partMatrix } from './design.js';
import { hullColumns } from './boat.js';
import { M } from './materials.js';
import { Bag, bar, V } from './partDetail.js';

const KEEL = 0.62; // the keel's height above the floor
let _mats = null;
const mats = () => _mats || (_mats = {
  galv: new THREE.MeshStandardMaterial({ color: 0xa9aeb3, metalness: 0.8, roughness: 0.45 }),
  carpet: new THREE.MeshStandardMaterial({ color: 0x2a3a5a, metalness: 0, roughness: 0.95 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, metalness: 0, roughness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 0.9, roughness: 0.25 }),
  roller: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0, roughness: 0.7 }),
  red: new THREE.MeshStandardMaterial({ color: 0xc8261e, metalness: 0.2, roughness: 0.5 }),
});

export function boatTrailer(design) {
  // the bottom of every hull part, in the design frame
  const bot = [], m = new THREE.Matrix4(), p = new THREE.Vector3();
  for (const dp of design.parts) {
    if (!PARTS[dp.id]?.boatHull) continue; partMatrix(dp, m);
    for (const c of hullColumns(dp.id)) if (c.n) { p.set(c.x, c.y0, c.z).applyMatrix4(m); bot.push(p.clone()); }
  }
  if (bot.length < 4) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, yLow = Infinity;
  for (const q of bot) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); yLow = Math.min(yLow, q.y); }
  const y = KEEL - yLow, xc = (x0 + x1) / 2, half = Math.max(0.3, (x1 - x0) / 2), L = z1 - z0;
  // where the bunks go: under the lowest points each side if they are well off the middle (pontoon tubes), else a third
  // of the way out from the keel (a V bottom)
  const sideLow = (s) => { let best = null; for (const q of bot) if ((q.x - xc) * s > 0.05 && (!best || q.y < best.y)) best = q; return best; };
  const bunkX = [-1, 1].map((s) => { const q = sideLow(s); return q && Math.abs(q.x - xc) > half * 0.45 ? q.x : xc + s * half * 0.36; });
  // the bottom height along a line x (lowest column within reach), in world space
  const bottomAt = (x, z, reach) => { let h = Infinity; for (const q of bot) if (Math.abs(q.x - x) < reach && Math.abs(q.z - z) < L / 14 + 0.05) h = Math.min(h, q.y); return h === Infinity ? null : h + y; };
  const b = new Bag(), M_ = mats(), railY = 0.42, frameHalf = Math.max(0.35, Math.min(...bunkX.map((x) => Math.abs(x - xc))) - 0.05);
  const za = z0 + L * 0.12, zb = z1 - L * 0.04; // frame from near the bow to the transom
  // the frame: two rails, cross members, the A-frame tongue to a hitch, a jack wheel
  for (const s of [-1, 1]) b.add(bar(V(xc + s * frameHalf, railY, za), V(xc + s * frameHalf, railY, zb), 0.1, 0.14), M_.galv);
  for (const t of [0, 0.33, 0.66, 1]) { const z = za + (zb - za) * t; b.add(bar(V(xc - frameHalf - 0.05, railY, z), V(xc + frameHalf + 0.05, railY, z), 0.1, 0.1), M_.galv); }
  const hitch = V(xc, railY, z0 - Math.max(1.0, L * 0.22));
  for (const s of [-1, 1]) b.add(bar(V(xc + s * frameHalf, railY, za), hitch, 0.09, 0.09), M_.galv);
  { const coupler = new THREE.BoxGeometry(0.14, 0.12, 0.34); coupler.translate(hitch.x, railY, hitch.z - 0.12); b.add(coupler, M_.galv);
    const ball = new THREE.SphereGeometry(0.06, 10, 8); ball.translate(hitch.x, railY - 0.06, hitch.z - 0.24); b.add(ball, M_.rim);
    b.add(bar(V(hitch.x + 0.14, railY + 0.25, hitch.z + 0.3), V(hitch.x + 0.14, 0.12, hitch.z + 0.3), 0.07, 0.07, true, 10), M_.galv); // jack
    const jw = new THREE.CylinderGeometry(0.1, 0.1, 0.06, 14); jw.rotateZ(Math.PI / 2); jw.translate(hitch.x + 0.14, 0.1, hitch.z + 0.3); b.add(jw, M_.tyre);
    b.add(bar(V(hitch.x + 0.06, railY, hitch.z + 0.3), V(hitch.x + 0.14, railY + 0.02, hitch.z + 0.3), 0.06, 0.06), M_.galv); }
  // bunks: carpeted boards laid along the bottom, on posts from the cross members
  for (const bx of bunkX) {
    const pts = []; for (let k = 0; k <= 6; k++) { const z = za + (zb - za) * (0.08 + 0.84 * k / 6), h = bottomAt(bx, z, half * 0.18 + 0.05); if (h != null) pts.push(V(bx, h - 0.045, z)); }
    for (let k = 0; k < pts.length - 1; k++) b.add(bar(pts[k], pts[k + 1].clone().add(V(0, 0, 0.001)), 0.18, 0.09), M_.carpet);
    for (const pt of pts.filter((_, k) => k % 3 === 0)) b.add(bar(V(bx, railY, pt.z), V(bx, pt.y - 0.04, pt.z), 0.07, 0.07), M_.galv);
  }
  // keel rollers on the centreline (a V bottom)
  if (Math.abs(bunkX[0] - xc) < half * 0.5) for (const t of [0.15, 0.5, 0.85]) {
    const z = za + (zb - za) * t, h = bottomAt(xc, z, 0.25); if (h == null) continue;
    const r = new THREE.CylinderGeometry(0.07, 0.07, 0.24, 12); r.rotateZ(Math.PI / 2); r.translate(xc, h - 0.07, z); b.add(r, M_.roller);
    b.add(bar(V(xc, railY, z), V(xc, h - 0.12, z), 0.06, 0.06), M_.galv);
  }
  // one axle a little behind the middle, wheels outside the frame under mudguards
  const az = (z0 + z1) / 2 + L * 0.06, wx = Math.max(frameHalf + 0.35, half * 0.82), R = 0.32;
  b.add(bar(V(xc - wx, R, az), V(xc + wx, R, az), 0.08, 0.08, true, 10), M_.galv);
  for (const s of [-1, 1]) {
    const t = new THREE.TorusGeometry(R - 0.09, 0.09, 10, 24); t.rotateY(Math.PI / 2); t.translate(xc + s * wx, R, az); b.add(t, M_.tyre);
    const rim = new THREE.CylinderGeometry(R - 0.12, R - 0.12, 0.16, 18); rim.rotateZ(Math.PI / 2); rim.translate(xc + s * wx, R, az); b.add(rim, M_.rim);
    const guard = new THREE.CylinderGeometry(R + 0.1, R + 0.1, 0.24, 18, 1, true, -Math.PI / 2, Math.PI); guard.rotateZ(Math.PI / 2); guard.translate(xc + s * wx, R, az); b.add(guard, M_.galv);
    b.add(bar(V(xc + s * frameHalf, railY, az), V(xc + s * (wx - 0.12), R + 0.05, az), 0.08, 0.08), M_.galv);
    const lamp = new THREE.BoxGeometry(0.16, 0.08, 0.05); lamp.translate(xc + s * (frameHalf + 0.05), railY + 0.02, zb + 0.06); b.add(lamp, M_.red);
  }
  // winch post: up from the tongue to just under the bow
  { const bz = z0 + 0.15, h = bottomAt(xc, bz, half) ?? KEEL + 0.4, top = Math.min(h + 0.15, KEEL + 1.0), pz = z0 - 0.15;
    b.add(bar(V(xc, railY, pz), V(xc, top, pz), 0.09, 0.09), M_.galv); b.add(bar(V(xc, railY, pz + 0.6), V(xc, top - 0.1, pz + 0.02), 0.06, 0.06), M_.galv);
    const winch = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 12); winch.rotateZ(Math.PI / 2); winch.translate(xc, top - 0.18, pz - 0.08); b.add(winch, M_.galv);
    const stop = new THREE.CylinderGeometry(0.06, 0.06, 0.2, 10); stop.rotateX(Math.PI / 2); stop.translate(xc, top, pz + 0.1); b.add(stop, M_.roller); }
  const stand = new THREE.Group(); b.to(stand);
  stand.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { stand, y };
}
