// Camera modes: chase, cockpit, orbit, tower, flyby.
import * as THREE from 'three';
import { clamp } from './noise.js';

export const CAM_MODES = ['chase', 'cockpit', 'orbit', 'tower', 'flyby'];
const _want = new THREE.Vector3(), _mv = new THREE.Vector3(), _off = new THREE.Vector3(), _yAxis = new THREE.Vector3(0, 1, 0);
const CAM_NAMES = { chase: 'Chase cam', cockpit: 'Cockpit', orbit: 'Orbit (drag to look)', tower: 'Tower cam', flyby: 'Fly-by' };

export class CameraRig {
  constructor(camera, dom) {
    this.cam = camera; this.mode = 'chase';
    this.look = { yaw: 0, pitch: 0, dist: 1 }; this.dragging = false;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.wantPrev = new THREE.Vector3();
    this.shakeAmt = 0; this.flyPos = null; this.init = false;
    this.lookAt = new THREE.Vector3();
    let last = null, pinch = null;
    const pts = new Map();
    dom.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; this.dragging = true; this.lastDrag = performance.now(); });
    dom.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.look.dist = clamp(this.look.dist * (pinch / d), 0.35, 6); pinch = d; return;
      }
      if (!last) return;
      this.look.yaw -= (e.clientX - last.x) * 0.006; this.look.pitch = clamp(this.look.pitch + (e.clientY - last.y) * 0.005, -1.3, 1.3);
      last = { x: e.clientX, y: e.clientY }; this.lastDrag = performance.now();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { this.dragging = false; last = null; } };
    dom.addEventListener('pointerup', up); dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => { this.look.dist = clamp(this.look.dist * (1 + e.deltaY * 0.001), 0.35, 6); e.preventDefault(); }, { passive: false });
  }
  next() { this.mode = CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length]; this.look.yaw = 0; this.look.pitch = 0; this.flyPos = null; return CAM_NAMES[this.mode]; }
  set(mode) { this.mode = mode; this.flyPos = null; }
  shake(a) { this.shakeAmt = Math.min(2, this.shakeAmt + a); }

  update(dt, ac, world, focusOverride) {
    const cam = this.cam; this.frame = (this.frame || 0) + 1;
    const target = focusOverride || ac.x;
    const R = Math.max(4, ac.radius);
    const k = 1 - Math.exp(-dt * 6);
    // drift look offsets back when not dragging (chase/cockpit)
    if (!this.dragging && performance.now() - (this.lastDrag || 0) > 2500 && (this.mode === 'chase' || this.mode === 'cockpit')) { this.look.yaw *= 1 - Math.min(1, dt * 1.5); this.look.pitch *= 1 - Math.min(1, dt * 1.5); }
    let fov = 60;
    const mode = focusOverride && this.mode === 'cockpit' ? 'orbit' : this.mode;
    if (mode === 'chase') {
      const fwd = ac.forward; const vdir = ac.v.lengthSq() > 25 ? ac.v.clone().normalize() : fwd;
      const dir = fwd.clone().lerp(vdir, 0.35).normalize();
      const rk = ac.isRocket ? ac.rocketK : 0;
      if (rk > 0.01) {
        // A rocket's camera follows where the nose points slowly (~1 s), so when you steer you see the nose swing away
        // from the middle of the screen and stay there for a moment against the sky and the HUD's pitch ladder, instead
        // of the view snapping round behind it at once (which read as the nose springing back to the middle).
        if (!this.rocketDir || !this.init) this.rocketDir = dir.clone();
        this.rocketDir.lerp(dir, Math.min(1, dt * 1.1)).normalize();
        dir.lerp(this.rocketDir, rk).normalize();
      } else this.rocketDir = null;
      const flat = new THREE.Vector3(dir.x, 0, dir.z);
      if (rk > 0.01) {
        // A rocket points (nearly) straight up, so "behind it" has no direction: hold the camera's heading and only swing
        // round as the nose tips over. (Chasing the tiny sideways lean flipped the camera about, and with it which way
        // the stick seemed to steer.) It swings round the side, never over the top: turning the old heading towards the
        // new one (a straight blend between opposite headings passed through zero and flipped the view upside down).
        const h = flat.length();
        if (!this.rocketFlat || !this.init) this.rocketFlat = h > 0.3 ? flat.clone().normalize() : new THREE.Vector3(-ac.up.x, 0, -ac.up.z).normalize();
        if (h > 1e-3) {
          const f = this.rocketFlat, tx = flat.x / h, tz = flat.z / h;
          const ang = Math.atan2(f.z * tx - f.x * tz, f.x * tx + f.z * tz); // signed turn (about +Y) from the old heading to the new
          f.applyAxisAngle(_yAxis, ang * Math.min(1, dt * 1.6 * h ** 4)).normalize();
        }
        flat.lerp(this.rocketFlat, rk);
      } else this.rocketFlat = null;
      if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1); flat.normalize();
      const d = (R * 2.2 + 8) * this.look.dist;
      const off = flat.clone().multiplyScalar(-d).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.look.yaw);
      off.y = d * 0.28 + this.look.pitch * d * 0.6 - dir.y * d * 0.5;
      const want = _want.copy(target).add(off);
      if (!this.init) { this.pos.copy(want); this.init = true; }
      if (this.chaseFrame !== this.frame - 1) this.wantPrev.copy(want); // (re)entering chase: no motion history yet
      // Lag behind the wanted spot as a first-order follower, integrated exactly for a spot moving at a steady velocity
      // over the step: the offset from the plane then doesn't depend on the frame time (a plain lerp's lag shrinks on a
      // long frame and grows back on the next, which the eye reads as the plane twitching against the camera).
      const E = Math.exp(-dt * 5), mv = _mv.copy(want).sub(this.wantPrev), off0 = _off.copy(this.pos).sub(this.wantPrev);
      this.pos.copy(want).addScaledVector(off0, E).addScaledVector(mv, dt > 1e-4 ? -(1 - E) / (5 * dt) : -1);
      this.wantPrev.copy(want); this.chaseFrame = this.frame;
      // stay a fixed distance (avoid lag stretching at high speed)
      const rel = this.pos.clone().sub(target); rel.setLength(clamp(rel.length(), d * 0.8, d * 1.25)); this.pos.copy(target).add(rel);
      this.lookAt.copy(target).addScaledVector(dir, R * 0.6);
      cam.up.set(0, 1, 0).lerp(ac.up, 0.15 * (1 - rk)).normalize();
      fov = 60 + clamp((ac.v.length() - 60) / 6, 0, 18);
    } else if (mode === 'cockpit') {
      const eye = ac.worldPoint(ac.capsuleEye || ac.eyePoint()); // (a crew capsule in a body: capsule.js)
      this.pos.copy(eye);
      const q = ac.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.look.pitch * 0.8, this.look.yaw, 0, 'YXZ')));
      cam.position.copy(eye); cam.quaternion.copy(q); cam.userData.cockpit = true;
      cam.fov = 70; cam.updateProjectionMatrix();
      this.finish(dt, world, true); return;
    } else if (mode === 'orbit') {
      if (!this.dragging && focusOverride) this.look.yaw += dt * 0.15;
      const d = (R * 2.6 + 10) * this.look.dist;
      const off = new THREE.Vector3(Math.sin(this.look.yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch) * 0.9 + 0.25, Math.cos(this.look.yaw) * Math.cos(this.look.pitch)).normalize().multiplyScalar(d);
      this.pos.copy(target).add(off); this.lookAt.copy(target); cam.up.set(0, 1, 0);
    } else if (mode === 'tower') {
      let tp = new THREE.Vector3(260, world.loc.rwyH + 34, 210);
      if (tp.distanceTo(target) > 3500) {
        if (!this.spot || this.spot.distanceTo(target) > 3500) { const f = ac.v.clone().setY(0); f.setLength(Math.min(1200, f.length() * 15 + 200)); this.spot = target.clone().add(f).add(new THREE.Vector3(120, 0, 60)); this.spot.y = Math.max(world.heightAt(this.spot.x, this.spot.z), world.waterLevel) + 6; }
        tp = this.spot;
      }
      this.pos.copy(tp); this.lookAt.copy(target); cam.up.set(0, 1, 0);
      const dist = tp.distanceTo(target);
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan((R * 3.5) / dist)) / this.look.dist, 4, 60);
    } else if (mode === 'flyby') {
      if (!this.flyPos || this.flyPos.distanceTo(target) > 400 + R * 10) {
        const v = ac.v.lengthSq() > 4 ? ac.v.clone() : ac.forward.multiplyScalar(5);
        const side = new THREE.Vector3(-v.z, 0, v.x).normalize().multiplyScalar(R * 3 + 12);
        this.flyPos = target.clone().addScaledVector(v, 3.5).add(side);
        this.flyPos.y += 4 + R * 0.6;
        const gh = Math.max(world.heightAt(this.flyPos.x, this.flyPos.z), world.waterLevel);
        this.flyPos.y = Math.max(this.flyPos.y, gh + 3);
      }
      this.pos.copy(this.flyPos); this.lookAt.copy(target); cam.up.set(0, 1, 0);
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan((R * 4) / this.pos.distanceTo(target))), 15, 65);
    }
    cam.userData.cockpit = false;
    // keep above ground
    const gh = Math.max(world.heightAt(this.pos.x, this.pos.z), world.waterLevel) + 1.2;
    if (this.pos.y < gh) this.pos.y = gh;
    cam.position.copy(this.pos);
    cam.lookAt(this.lookAt);
    cam.fov += (fov - cam.fov) * k; cam.updateProjectionMatrix();
    this.finish(dt, world, false);
  }
  finish(dt, world, cockpit) {
    const cam = this.cam;
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt * (cockpit ? 0.02 : 0.15);
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      cam.rotateZ((Math.random() - 0.5) * this.shakeAmt * 0.01);
      this.shakeAmt *= Math.max(0, 1 - dt * 4);
    }
    this.vel.copy(cam.position).sub(this.prev).divideScalar(Math.max(dt, 1e-3));
    if (this.vel.length() > 2000) this.vel.set(0, 0, 0);
    this.prev.copy(cam.position);
    cam.userData.focus = this.lookAt.clone();
  }
}
