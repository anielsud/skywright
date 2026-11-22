// Remote players' planes: the normal Aircraft model used for visuals only (no physics step).
// State snapshots arrive ~15 times a second; we render ~120 ms in the past and interpolate between them.
import * as THREE from 'three';
import { Aircraft, REALISM } from './aircraft.js';
import { aircraftLights, updateAircraftLights } from './navLights.js';
import { clamp } from './noise.js';
import { SonicFX } from './sonic.js';

export const PLAYER_COLORS = ['#ff5fa2', '#4fd1ff', '#7dff6a', '#ff8a3d', '#b48cff', '#ffffff'];
const DELAY = 120; // ms of buffering
const MAX_EXTRAP = 300; // ms: keep coasting along the last velocity for this long, then hold
const lerp = (a, b, t) => a + (b - a) * t;

// Snapshot wire format (arrays keep payloads small):
// ['s', id, t, x, y, z, qx, qy, qz, qw, vx, vy, vz, throttle, pitch, roll, yaw, flaps, flags]
// flags: 1 = gear down, 2 = smoke on, 4 = rocket burning
export const FLAG = { gear: 1, smoke: 2, rocket: 4 };
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
export function packState(id, ac) {
  const rocket = ac.parts.some((p) => p.alive && p.engine?.burning);
  return ['s', id, Math.round(performance.now()), r1(ac.x.x), r1(ac.x.y), r1(ac.x.z), r3(ac.q.x), r3(ac.q.y), r3(ac.q.z), r3(ac.q.w),
    r1(ac.v.x), r1(ac.v.y), r1(ac.v.z), r2(ac.ctl.throttle), r2(ac.ctl.pitch), r2(ac.ctl.roll), r2(ac.ctl.yaw), ac.flaps,
    (ac.gearDown ? FLAG.gear : 0) | (ac.smokeOn ? FLAG.smoke : 0) | (rocket ? FLAG.rocket : 0)];
}
export function unpackState(a) {
  return { t: a[2], x: new THREE.Vector3(a[3], a[4], a[5]), q: new THREE.Quaternion(a[6], a[7], a[8], a[9]).normalize(), v: new THREE.Vector3(a[10], a[11], a[12]),
    throttle: a[13], pitch: a[14], roll: a[15], yaw: a[16], flaps: a[17] | 0, flags: a[18] | 0 };
}

// Buffer of snapshots for one player. Kept on the player record so it survives (re)building the plane.
export class SnapBuffer {
  constructor() { this.snaps = []; this.off = null; }
  push(s) {
    const now = performance.now();
    // clock offset between our clock and the sender's: the smallest observed (receive - send) delay
    // is the best estimate (jitter only ever adds delay); creep upwards slowly so drift can't stick.
    const o = now - s.t;
    if (this.off === null || o < this.off || o - this.off > 2000) this.off = o; else this.off += 0.02;
    if (this.snaps.length && s.t <= this.snaps.at(-1).t) return; // out of order / duplicate
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
  }
  clear() { this.snaps.length = 0; this.off = null; }
  // interpolated state at render time (sender clock); null if nothing yet
  sample(out) {
    const S = this.snaps; if (!S.length) return null;
    const rt = performance.now() - this.off - DELAY;
    let i = S.length - 1;
    while (i > 0 && S[i - 1].t > rt) i--;
    const b = S[i], a = S[i - 1];
    if (a && a.t <= rt && rt <= b.t) {
      const k = (rt - a.t) / Math.max(1, b.t - a.t);
      out.x.lerpVectors(a.x, b.x, k); out.q.slerpQuaternions(a.q, b.q, k); out.v.lerpVectors(a.v, b.v, k);
      out.src = k < 0.5 ? a : b;
      for (const key of ['throttle', 'pitch', 'roll', 'yaw']) out[key] = lerp(a[key], b[key], k);
    } else if (rt > b.t) { // ran out of snapshots: extrapolate briefly
      const ex = Math.min(rt - b.t, MAX_EXTRAP) / 1000;
      out.x.copy(b.x).addScaledVector(b.v, ex); out.q.copy(b.q); out.v.copy(b.v); out.src = b;
      for (const key of ['throttle', 'pitch', 'roll', 'yaw']) out[key] = b[key];
    } else { // render time is before our oldest snapshot (just joined)
      out.x.copy(b.x); out.q.copy(b.q); out.v.copy(b.v); out.src = b;
      for (const key of ['throttle', 'pitch', 'roll', 'yaw']) out[key] = b[key];
    }
    out.flaps = out.src.flaps; out.flags = out.src.flags;
    out.age = performance.now() - this.off - b.t;
    return out;
  }
}

export class RemotePlane {
  constructor(player, scene, labelRoot) {
    this.player = player; this.scene = scene;
    this.ac = new Aircraft(player.design, REALISM[player.realism] || REALISM.pilot);
    // no real lights on other players' planes (their running lights are sprites): a light arriving mid-flight changes
    // the scene's light count and recompiles every lit shader for everyone
    const lights = []; this.ac.root.traverse((o) => { if (o.isLight) lights.push(o); }); for (const l of lights) l.parent.remove(l); this.ac.landingLight = null;
    this.ac.ctl.throttle = 0;
    this.ac.root.userData.detail?.lod?.crewDetail(); // (their people get lighter with distance: planeDetail DetailLOD)
    scene.add(this.ac.root);
    this.ac.root.visible = false; // until the first snapshot
    this.sonic = new SonicFX(this.ac, scene); // vapour cone, glow and sonic booms for other players too
    this.nav = aircraftLights(this.ac, { phase: Math.random() * 1.3 }); // running lights (out of step with ours)
    this.st = { x: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3() };
    this.first = true;
    this.label = document.createElement('div'); this.label.className = 'mp-label';
    this.label.innerHTML = `<b style="color:${player.color}">●</b> <span></span><small></small>`;
    this.label.querySelector('span').textContent = player.name;
    labelRoot.appendChild(this.label);
    for (const i of player.broken) this.breakSilently(i);
  }
  dispose() { this.scene.remove(this.ac.root); this.sonic.dispose(); this.label.remove(); }
  // replay damage for someone who broke parts before we arrived: no effects
  breakSilently(i) { this.ac.breakPart(i, 'impact'); for (const e of this.ac.events) if (e.type === 'debris') e.debris.group.clear(); this.ac.events.length = 0; }

  update(dt, env) {
    const ac = this.ac, s = this.player.buf.sample(this.st);
    if (!s) return;
    ac.root.visible = true;
    ac.x.copy(s.x); ac.q.copy(s.q); ac.v.copy(s.v); ac.airspeed = s.v.length();
    Object.assign(ac.ctl, { throttle: s.throttle, pitch: s.pitch, roll: s.roll, yaw: s.yaw });
    ac.flaps = s.flaps; ac.gearDown = !!(s.flags & FLAG.gear); ac.smokeOn = !!(s.flags & FLAG.smoke);
    if (this.first) { ac.gearT = ac.gearDown ? 1 : 0; this.first = false; }
    ac.time += dt;
    // control surfaces: same mixing the physics uses (Aircraft.substep), without the aerodynamics
    const flapDefl = [0, 0.18, 0.35, 0.6][ac.flaps] || 0;
    for (const p of ac.parts) {
      if (!p.alive) continue;
      for (const sf of p.surfaces) {
        const dCtl = clamp(s.pitch * sf.mix.pitch + s.roll * sf.mix.roll + s.yaw * sf.mix.yaw, -1, 1) * 0.38;
        sf.delta = dCtl + (sf.role === 'flap' && p.d.wing?.flaps ? flapDefl : 0);
      }
      const e = p.engine; if (!e) continue;
      const target = e.type === 'rocket' ? (s.flags & FLAG.rocket ? 1 : 0) : s.throttle;
      const spool = e.type === 'jet' ? e.spool || 3 : e.type === 'rocket' ? 0.15 : e.sound === 'electric' ? 0.1 : e.spool || 0.5;
      e.spoolT = (e.spoolT || 0) + (target - (e.spoolT || 0)) * Math.min(1, dt / (spool * 0.5));
      e.burning = e.type === 'rocket' && !!(s.flags & FLAG.rocket);
      e.abOn = e.type === 'jet' && !!e.ab && s.throttle > 0.95 && e.spoolT > 0.9;
      e.rpm = e.type === 'prop' ? (s.throttle <= 0.001 && e.spoolT < 0.01 ? 0 : lerp(e.idleRpm, e.maxRpm, e.spoolT)) : e.spoolT;
    }
    ac.syncVisual();
    ac.updateVisuals(dt, env);
    updateAircraftLights(this.nav, dt, env);
  }

  // airshow smoke, like the local plane
  effects(effects) {
    const ac = this.ac; if (ac.dead || !ac.smokeOn || !ac.root.visible) return;
    for (const p of ac.parts) if (p.alive && p.smoke) effects.trail(ac.worldPoint(p.smoke.pos), p.smoke.color, 1);
  }

  // project the name tag above the plane
  updateLabel(camera, units) {
    const ac = this.ac, el = this.label;
    if (ac.dead || !ac.root.visible) { el.style.display = 'none'; return; }
    const p = ac.x.clone(); p.y += ac.radius * 0.8 + 2;
    const d = p.distanceTo(camera.position);
    p.project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1 || d > 15000) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.transform = `translate(${((p.x + 1) / 2) * innerWidth}px, ${((1 - p.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
    el.querySelector('small').textContent = units === 'metric' ? (d < 1000 ? ` ${Math.round(d)} m` : ` ${(d / 1000).toFixed(1)} km`) : ` ${(d / 1852).toFixed(1)} nm`;
  }
}
