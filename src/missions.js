// Game modes: free flight, ring race, landing challenge.
import * as THREE from 'three';
import { clamp } from './noise.js';

export const MODES = {
  free: { name: 'Free Flight', desc: 'Go anywhere. Do anything. Break everything.' },
  rings: { name: 'Ring Race', desc: 'Fly through 12 glowing rings as fast as you can.' },
  landing: { name: 'Landing Challenge', desc: 'Start on final approach. Land gently on the centreline.' },
};

export class RingRace {
  constructor(scene, world, ac, realism) {
    this.scene = scene; this.world = world; this.group = new THREE.Group(); scene.add(this.group);
    this.R = realism === 'arcade' ? 32 : realism === 'pilot' ? 26 : 22;
    this.R = Math.max(this.R, ac.radius * 1.6);
    this.rings = []; this.idx = 0; this.time = 0; this.done = false; this.started = false;
    this.cdT = 0; this.cdNext = 3; // 3-2-1-GO countdown; the clock starts at GO (or as soon as you move off)
    const pts = [];
    let p = new THREE.Vector3(0, world.loc.rwyH + 150, -1500), heading = 0; // north = -Z
    const rnd = (() => { let s = world.loc.seed * 31; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let i = 0; i < 12; i++) {
      // choose the lowest terrain among candidate headings: follows valleys / canyons
      let best = null;
      for (let c = -2; c <= 2; c++) {
        const h = heading + c * 0.45 + (rnd() - 0.5) * 0.2;
        const q = p.clone().add(new THREE.Vector3(Math.sin(h) * -700, 0, Math.cos(h) * -700));
        let gh = 0; for (let s = 0.25; s <= 1; s += 0.25) { const pp = p.clone().lerp(q, s); gh = Math.max(gh, Math.max(world.heightAt(pp.x, pp.z), world.waterLevel)); }
        const score = gh + Math.abs(c) * 20 + (Math.hypot(q.x, q.z) > 7000 ? 5000 : 0);
        if (!best || score < best.score) best = { score, h, q, gh };
      }
      heading = best.h;
      const alt = clamp(best.gh + 90 + rnd() * 80, world.loc.rwyH + 80, world.loc.cloudBase - 100);
      best.q.y = alt; pts.push(best.q); p = best.q;
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8a00, emissiveIntensity: 1.2, metalness: 0.2, roughness: 0.4 });
    const tor = new THREE.TorusGeometry(this.R, 1.3, 12, 48);
    pts.forEach((q, i) => {
      const next = pts[i + 1] || q.clone().add(q.clone().sub(pts[i - 1]));
      const prev = i === 0 ? new THREE.Vector3(0, q.y, 0) : pts[i - 1];
      const dir = next.clone().sub(prev).setY(0).normalize();
      const m = new THREE.Mesh(tor, mat.clone());
      m.position.copy(q); m.lookAt(q.clone().add(dir));
      this.group.add(m);
      this.rings.push({ p: q.clone(), n: dir, mesh: m, passed: false });
    });
    this.prevSide = null;
  }
  update(dt, ac, events) {
    if (this.done) return;
    if (this.cdNext >= 0) { // a beat every second: 3 at 0.6 s, 2, 1, then GO
      this.cdT += dt;
      if (this.cdT >= 0.6 + (3 - this.cdNext)) { events.push({ type: 'count', n: this.cdNext }); if (this.cdNext-- === 0) this.started = true; }
    }
    if (!this.started && ac.airspeed > 5) this.started = true;
    if (this.started) this.time += dt;
    const r = this.rings[this.idx];
    const rel = ac.x.clone().sub(r.p); const side = rel.dot(r.n);
    if (this.prevSide !== null && this.prevSide < 0 && side >= 0) {
      const lat = rel.clone().addScaledVector(r.n, -side).length();
      if (lat < this.R + 2) {
        r.passed = true; r.mesh.material.color.set(0x40ff80); r.mesh.material.emissive.set(0x20c060); r.mesh.material.opacity = 0.3; r.mesh.material.transparent = true;
        this.idx++; events.push({ type: 'ring', n: this.idx, total: this.rings.length });
        if (this.idx >= this.rings.length) { this.done = true; events.push({ type: 'raceDone', time: this.time }); return; }
      }
    }
    this.prevSide = this.idx < this.rings.length ? ac.x.clone().sub(this.rings[this.idx].p).dot(this.rings[this.idx].n) : null;
    // pulse next ring
    this.rings.forEach((rr, i) => { if (!rr.passed) { const on = i === this.idx; rr.mesh.material.emissiveIntensity = on ? 1.4 + Math.sin(performance.now() / 150) * 0.6 : 0.25; rr.mesh.scale.setScalar(on ? 1 : 0.8); } });
  }
  target() { return this.done ? null : this.rings[this.idx].p; }
  hud() { return this.done ? `Finished! ${this.time.toFixed(1)} s` : `Ring ${this.idx + 1}/${this.rings.length} · ${this.time.toFixed(1)} s`; }
  dispose() { this.scene.remove(this.group); }
}

export class LandingChallenge {
  constructor(world, side = 1, rwyX = 0, rwyName = '36R') { this.world = world; this.side = side; this.rwyX = rwyX; this.rwyName = rwyName; this.done = false; this.score = null; this.touch = null; this.time = 0; } // side: +1 = approach from +z (the spawn planner may pick the other end)
  update(dt, ac, events) {
    this.time += dt;
    if (this.done) return;
    for (const e of ac.events) if (e.type === 'landing' && !this.touch) {
      const x = ac.x.x - this.rwyX, z = ac.x.z * this.side; // runway-relative, as if approaching from +z
      const onRwy = Math.abs(x) < this.world.runway.width / 2 && Math.abs(z) < this.world.runway.len / 2;
      this.touch = { vs: e.vs, x, z, onRwy };
    }
    if (this.touch && ac.v.length() < 2 && ac.onGround) {
      this.done = true;
      const t = this.touch;
      const aim = this.world.runway.len / 2 - 380;
      const sVs = clamp(1 - (t.vs - 0.6) / 3, 0, 1) * 400;
      const sCl = clamp(1 - Math.abs(t.x) / 18, 0, 1) * 250;
      const sAim = clamp(1 - Math.abs(t.z - aim) / 500, 0, 1) * 250;
      const sStop = Math.abs(ac.x.x - this.rwyX) < this.world.runway.width / 2 && Math.abs(ac.x.z) < this.world.runway.len / 2 ? 100 : 0;
      const intact = ac.stats.partsLost === 0 ? 1 : 0.3;
      this.score = Math.round((t.onRwy ? sVs + sCl + sAim + sStop : (sVs * 0.5)) * intact);
      events.push({ type: 'landingDone', score: this.score, vs: t.vs, cl: t.x, aim: t.z - aim, parts: ac.stats.partsLost, onRwy: t.onRwy });
    }
    if (ac.wrecked && !this.done) { this.done = true; this.score = 0; events.push({ type: 'landingDone', score: 0, crashed: true }); }
  }
  target() { return this.done ? null : new THREE.Vector3(0, this.world.loc.rwyH, this.world.runway.len / 2 - 380); }
  hud() { return this.done ? `Score: ${this.score}` : this.touch ? `Touchdown ${this.touch.vs.toFixed(1)} m/s — now stop!` : `Land on runway ${this.rwyName} · aim for the big white blocks`; }
  dispose() {}
}
