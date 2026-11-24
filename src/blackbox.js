// Flight recorder for 🐞 reports: the last couple of minutes of a flight, kept in memory only and sent only when the
// player presses 🐞 and Send. A problem isn't always something you can see in a picture (a car that flipped for no
// reason, a stutter, a crash through nothing), so the report carries what led up to it:
//   path:   [t, x, y, z, speed m/s, height above ground m, on ground 0/1, parts left, worst frame ms] four times a second
//   events: [t, kind, detail] — messages shown, parts lost, hits, touchdowns, actions, quality drops, errors
// t is seconds of flight. tools/analytics/reports.py prints it and replays the pose.
const SPAN = 120, DT = 0.25, MAX_EV = 200;
const r1 = (v) => Math.round(v * 10) / 10;

export class Blackbox {
  constructor() { this.reset(); }
  reset() { this.path = []; this.events = []; this.t = 0; this.nextT = 0; this.worst = 0; this.last = null; }
  log(kind, detail = '') {
    this.events.push([r1(this.t), kind, typeof detail === 'string' ? detail.slice(0, 160) : detail]);
    if (this.events.length > MAX_EV) this.events.splice(0, this.events.length - MAX_EV);
  }
  // Each flight frame: s = { t, x, y, z, speed, agl, ground, parts, dead, level, ms }
  step(s) {
    this.t = s.t; this.worst = Math.max(this.worst, s.ms);
    const L = this.last;
    if (L) { // what changed since last frame
      if (s.ground !== L.ground) this.log(s.ground ? 'touchdown' : 'liftoff', `${r1(s.speed)} m/s`);
      if (s.parts < L.parts) this.log('parts_lost', `${L.parts - s.parts} (${s.parts} left) at ${r1(s.speed)} m/s`);
      if (s.dead && !L.dead) this.log('destroyed');
      if (s.level !== L.level) this.log('lite_level', s.level);
      if (s.ms > 250) this.log('hitch', `${Math.round(s.ms)} ms frame`);
    }
    this.last = s;
    if (s.t < this.nextT) return;
    this.nextT = s.t + DT;
    this.path.push([r1(s.t), r1(s.x), r1(s.y), r1(s.z), r1(s.speed), r1(s.agl), s.ground ? 1 : 0, s.parts, Math.round(this.worst)]);
    this.worst = 0;
    const cut = s.t - SPAN; let i = 0; while (i < this.path.length && this.path[i][0] < cut) i++; if (i) this.path.splice(0, i);
  }
  dump() { const cut = this.t - SPAN; return { path: this.path.slice(), events: this.events.filter((e) => e[0] >= cut) }; }
}
