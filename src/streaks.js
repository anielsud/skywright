// Speed streaks (visual only): faint lines of air rushing past the camera in rocket mode, so speed and the direction of
// travel read even when the view holds nothing but sky (a climbing rocket), and fade out as the air thins.
import * as THREE from 'three';
import { clamp } from './noise.js';

const N = 80, R = 45; // streaks, and the radius (m) of the space round the camera they live in
const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3(), _t = new THREE.Vector3();

export class Streaks {
  constructor(scene) {
    this.p = Array.from({ length: N }, () => new THREE.Vector3(1e9, 0, 0));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(N * 6); for (let i = 0; i < N; i++) col.set([1, 1, 1, 0, 0, 0], i * 6); // bright head, dark tail
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(geo, this.mat); this.lines.frustumCulled = false; this.lines.visible = false; this.lines.renderOrder = 5;
    scene.add(this.lines);
  }
  // seed a streak somewhere ahead of the camera along the way we're going, off to the side of the line of flight
  spawn(p, cam, dir, ahead) {
    _s.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).addScaledVector(dir, -_s.dot(dir));
    if (_s.lengthSq() < 1e-4) _s.set(1, 0, 0);
    _s.normalize().multiplyScalar(R * (0.25 + 0.75 * Math.sqrt(Math.random())));
    p.copy(cam).add(_s).addScaledVector(dir, ahead ? R * (0.3 + 0.7 * Math.random()) : R * (Math.random() * 2 - 1));
  }
  update(dt, camPos, ac, on) {
    const V = ac.v.length(), k = on && !ac.dead ? clamp((V - 50) / 120, 0, 1) * clamp(ac.airFx ?? 1, 0, 1) : 0;
    this.mat.opacity += (k * 0.4 - this.mat.opacity) * Math.min(1, dt * 3);
    const vis = this.mat.opacity > 0.01; this.lines.visible = vis;
    if (!vis) { for (const p of this.p) p.set(1e9, 0, 0); return; }
    const dir = _d.copy(ac.v).divideScalar(Math.max(V, 1e-3)), len = clamp(V * 0.03, 1.5, 9), a = this.lines.geometry.attributes.position;
    this.p.forEach((p, i) => {
      _r.copy(p).sub(camPos);
      const along = _r.dot(dir);
      if (_r.lengthSq() > R * R * 2.2 || along < -R * 0.6) this.spawn(p, camPos, dir, p.x < 1e8);
      _t.copy(p).addScaledVector(dir, -len); // the air stands still: the tail trails back along our path
      a.setXYZ(i * 2, p.x, p.y, p.z); a.setXYZ(i * 2 + 1, _t.x, _t.y, _t.z);
    });
    a.needsUpdate = true;
  }
  dispose() { this.lines.removeFromParent(); this.lines.geometry.dispose(); this.mat.dispose(); }
}
