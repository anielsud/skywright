// Cockpit voice callouts (pre-rendered clips assets/sfx/vo_*.ogg, played through Audio.say).
// Radio-altimeter counts on landing, GPWS-style warnings, takeoff calls. Each call has a priority; a higher-priority
// call may cut in, a lower one waits its turn or is dropped.
import { analyze } from './design.js';
import { acKind } from './vehicleKind.js';

const FT = 0.3048;
const COUNTS = [100, 50, 40, 30, 20, 10]; // feet, like an airliner's radio altimeter
const PRIO = { vo_pullup: 5, vo_stall: 4, vo_sinkrate: 3, vo_gear: 3, vo_bank: 2, vo_rotate: 2, vo_posrate: 2, vo_smooth: 1, vo_firm: 1 };
// Which calls each kind of vehicle gets (vehicleKind.js). 'count' is the radio-altimeter count. A helicopter has no
// stall, no take-off roll and no wings to over-bank; a rocket only gets told it is about to hit the ground; cars, bikes
// and boats get none of it (a car off a jump is not an aircraft on approach).
const PLANE = new Set(['count', ...Object.keys(PRIO)]);
const ALLOW = { plane: PLANE, heli: new Set(['count', 'vo_pullup', 'vo_sinkrate', 'vo_gear', 'vo_smooth', 'vo_firm']), rocket: new Set(['vo_pullup', 'vo_sinkrate']) };
const LEN = { vo_pullup: 1.2, vo_stall: 1.35, vo_sinkrate: 0.5, vo_gear: 1.1, vo_bank: 1.65, vo_rotate: 0.4, vo_posrate: 0.75, vo_smooth: 0.7, vo_firm: 0.7 };

export class Callouts {
  constructor(audio, ac, kind = acKind(ac)) {
    this.audio = audio; this.ac = ac; this.allow = ALLOW[kind] || new Set(); this.kind = kind; this.t = 0; this.busyUntil = 0; this.busyPrio = 0; this.cool = {};
    // lowest point of the plane (wheel bottoms / hull) relative to the centre of mass, body frame
    let low = 0;
    for (const p of ac.parts) {
      if (p.gear) for (const w of p.gear.wheels) low = Math.min(low, w.top.y - w.len - w.r - ac.com.y);
      for (const h of p.hull) low = Math.min(low, h.y - ac.com.y);
    }
    this.low = low;
    const st = analyze(ac.design).stall;
    this.vr = Number.isFinite(st) ? Math.max(18, st * 1.15) : Infinity; // rotate speed
    this.armed = false; this.nextCount = 0; this.rolled = false; this.liftT = null; this.wasGround = ac.onGround;
  }
  say(name, cooldown = 0) {
    if (!name || !this.allow.has(name)) return false;
    const p = PRIO[name] || 1;
    if (this.t < (this.cool[name] || 0)) return false;
    if (this.t < this.busyUntil && p <= this.busyPrio) return false;
    if (!this.audio.say(name)) return false;
    this.busyUntil = this.t + (LEN[name] || 0.5) + 0.15; this.busyPrio = p; this.cool[name] = this.t + cooldown;
    return true;
  }
  landing(vs) { if (!this.ac.dead) this.say(vs < 2 ? 'vo_smooth' : vs < 3.2 ? 'vo_firm' : null); }
  update(world, dt) {
    const ac = this.ac; this.t += dt;
    if (ac.dead || ac.wrecked || !this.allow.size) return;
    const ground = Math.max(world.heightAt(ac.x.x, ac.x.z), world.waterLevel);
    const agl = ac.x.y + this.low - ground, vy = ac.v.y, V = ac.airspeed || 0;
    const onGround = ac.onGround;
    // ---- takeoff: "Rotate" at Vr on the ground, "Positive rate" once climbing away ----
    if (onGround) {
      if (!this.rolled && V > this.vr && ac.ctl.throttle > 0.5) { this.rolled = true; this.say('vo_rotate'); }
      if (V < 5) this.rolled = false;
      this.liftT = null;
    } else if (this.wasGround) this.liftT = this.t;
    if (this.liftT !== null && this.t - this.liftT < 12 && vy > 1.5 && agl > 10 * FT && agl < 300 * FT && this.rolled) { this.say('vo_posrate'); this.liftT = null; }
    this.wasGround = onGround;
    if (onGround) { this.armed = false; return; }
    // ---- radio altimeter counts on the way down (armed once above 150 ft) ----
    if (agl > 150 * FT) { this.armed = true; this.nextCount = 0; }
    if (this.armed && vy < -0.3 && V > 12) {
      while (this.nextCount < COUNTS.length && agl < COUNTS[this.nextCount] * FT) {
        const c = COUNTS[this.nextCount++];
        if ((this.nextCount === COUNTS.length || agl > COUNTS[this.nextCount] * FT) && this.allow.has('count')) this.audio.say(`vo_${c}`); // skip counts we've already dropped through
      }
    }
    // ---- warnings ----
    const tti = vy < -0.5 ? agl / -vy : Infinity; // seconds to impact at this sink rate
    if (agl < 300 && vy < -8 && tti < 5 && V > 25) this.say('vo_pullup', 2.5);
    else if (agl < 300 && vy < -6 && tti < 10 && V > 20) this.say('vo_sinkrate', 4);
    if (ac.stalled) this.say('vo_stall', 4);
    if (ac.hasRetract && !ac.gearDown && agl < 150 * FT && agl > 5 * FT && vy < -0.5 && V < 90) this.say('vo_gear', 6);
    if (ac.mass > 20000 && agl > 10) { // heavies only: in a fighter, steep banks are the point
      const rightY = 2 * (ac.q.x * ac.q.y + ac.q.w * ac.q.z); // world-up component of the body right axis
      if (Math.abs(rightY) > Math.sin(50 * Math.PI / 180)) this.say('vo_bank', 6);
    }
  }
}
