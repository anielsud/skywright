// Scripted SR-71 flights for smoke.py (and for tuning by hand): a simple autopilot that flies the stock SR-71 Blackbird
// through the real flight model (Aircraft.step), headless and faster than real time.
//   climb(ac, env, opts): take off from the runway, climb subsonic to ~9 km, accelerate through Mach 1 in a shallow
//     dive, then climb on a Mach schedule to ~23 km and accelerate. Pass: over Mach 2.5 above 60,000 ft, nothing broken.
//   land(ac, env, rwy, opts): from the approach start (gear down, on the glide path), fly the glide path to the aim
//     point, flare, touch down, brake to a stop. Pass: on the runway, gentle, nothing broken, stopped.
// Both are generators: each next() flies `chunk` seconds and yields the state, so a caller can spread a long flight over
// several evaluate calls (CDP timeouts) and watch it. Controls follow Aircraft's conventions: pitch + = nose up,
// roll + = roll right, throttle 0..1 (> 0.95 lights the afterburners).
const FT = 0.3048;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deg = Math.PI / 180;

function attitude(ac) {
  const V3 = ac.x.constructor, fw = new V3(0, 0, -1).applyQuaternion(ac.q), rt = new V3(1, 0, 0).applyQuaternion(ac.q), V = ac.v.length();
  return { pitch: Math.asin(clamp(fw.y, -1, 1)), bank: Math.asin(clamp(rt.y, -1, 1)), heading: Math.atan2(-fw.x, -fw.z), gamma: V > 1 ? Math.asin(clamp(ac.v.y / V, -1, 1)) : 0, V };
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function state(ac, extra = {}) {
  return { t: +ac.time.toFixed(1), x: Math.round(ac.x.x), z: Math.round(ac.x.z), alt: Math.round(ac.x.y), altFt: Math.round(ac.x.y / FT), mach: +(ac.mach || 0).toFixed(3), V: Math.round(ac.v.length()), vs: +ac.v.y.toFixed(1),
    alive: ac.parts.filter((p) => p.alive).length, parts: ac.parts.length, dead: !!ac.dead, wrecked: !!ac.wrecked, onGround: ac.onGround, gear: ac.gearDown, ab: ac.parts.some((p) => p.engine?.abOn), skinC: Math.round(ac.skinC ?? 0), ...extra };
}

// ---------- take-off, climb and dash ----------
export function* climb(ac, env, { dt = 1 / 60, chunk = 30, maxTime = 900, heading = null, ground = 0, cruise = 20 } = {}) {
  const hdg0 = heading ?? attitude(ac).heading;
  let phase = 'roll', t = 0, cruiseT = 0, best = { mach: 0, alt: 0 }, best60 = 0, liftoff = null, roll = null, gearUp = false, done = false, msgs = [];
  const ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 1 };
  ac.engineRunning = true;
  while (!done && t < maxTime) {
    const end = Math.min(maxTime, t + chunk);
    for (; t < end && !done; t += dt) {
      const A = attitude(ac), h = ac.x.y - ground, M = ac.mach || 0, V = A.V;
      let gcmd = null, pcmd = null;
      if (phase === 'roll') { pcmd = 0; if (V > 82) { phase = 'rotate'; roll = Math.round(ac.stats.distance); } }
      else if (phase === 'rotate') { pcmd = 9.5 * deg; if (!ac.onGround && h > 25) { phase = 'climb'; liftoff ??= { V: Math.round(V), t: +ac.time.toFixed(1) }; } }
      else if (phase === 'climb') { // subsonic climb at about Mach 0.9: steeper when faster
        gcmd = clamp(6 * deg + (M - 0.88) * 60 * deg, 2 * deg, 20 * deg); if (h > 9200) phase = 'push';
      } else if (phase === 'push') { // through the sound barrier in a shallow dive
        gcmd = -1.5 * deg; if (M > 1.35) phase = 'zoom'; if (h < 5000) done = true; // (it should never need to dive this far)
      } else if (phase === 'zoom') { // supersonic climb on a Mach schedule (climb only as fast as the speed allows)
        const Mt = 1.35 + 1.45 * clamp((h - 9200) / 12000, 0, 1);
        gcmd = clamp(5 * deg + (M - Mt) * 25 * deg, -1 * deg, 14 * deg); if (h > 22500) phase = 'cruise';
      } else { // cruise climb: hold about 23-24 km and let it accelerate
        gcmd = clamp((23500 - h) * 0.0015, -2 * deg, 3 * deg);
      }
      if (gcmd != null) pcmd = A.pitch + (gcmd - A.gamma) * 1.0;
      if (!ac.onGround) ctl.pitch = clamp((pcmd - A.pitch) * 1.4 - ac.w.x * 0.6, -1, 1);
      else ctl.pitch = clamp((pcmd - A.pitch) * 2.5 - ac.w.x * 0.5, -1, 1);
      ctl.roll = clamp(A.bank * 2.0 - ac.w.z * -0.3, -1, 1); // wings level
      ctl.yaw = ac.onGround ? clamp(wrap(A.heading - hdg0) * 4, -1, 1) : 0;
      ctl.throttle = 1;
      if (!gearUp && !ac.onGround && h > 40) { ac.toggleGear(); gearUp = true; }
      ac.setControls(ctl); ac.brake = 0; ac.step(dt, env);
      for (const e of ac.events) if (e.type === 'msg') msgs.push(`${ac.time.toFixed(0)}s ${e.text}`);
      ac.events.length = 0;
      if (M > best.mach) best = { mach: M, alt: h };
      if (h > 60000 * FT) best60 = Math.max(best60, M);
      if (ac.dead || ac.wrecked) done = true;
      if (phase === 'cruise') cruiseT += dt;
      if (best60 > 2.6 && cruiseT > cruise) done = true;
    }
    yield state(ac, { phase, best, best60: +best60.toFixed(3), liftoff, roll, msgs: msgs.splice(0) });
  }
  return state(ac, { phase, best, best60 });
}

// ---------- approach and landing ----------
// rwy: { x, h, s (+1 = approaching over +z flying towards -z), aimZ (the aim point's z, signed), len, width }
export function* land(ac, env, rwy, { dt = 1 / 60, chunk = 20, maxTime = 400, glide = 3, vApp = null } = {}) {
  const hdg = rwy.s > 0 ? 0 : Math.PI, Vref = vApp ?? ac.v.length();
  let t = 0, phase = 'approach', td = null, done = false, msgs = [], idle = 0;
  const ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0.5 };
  ac.engineRunning = true;
  let thrI = 0.5;
  while (!done && t < maxTime) {
    const end = Math.min(maxTime, t + chunk);
    for (; t < end && !done; t += dt) {
      const A = attitude(ac), h = ac.x.y - rwy.h, along = (ac.x.z - rwy.aimZ) * rwy.s; // metres before the aim point
      const xErr = (ac.x.x - rwy.x) * rwy.s; // + = right of the centreline when approaching from +z
      if (phase === 'approach') {
        const want = Math.max(0, along) * Math.tan(glide * deg) + 3;
        const gcmd = -glide * deg + clamp((want - h) * 0.01, -3 * deg, 3 * deg);
        ctl.pitch = clamp((gcmd - A.gamma) * 0.9 - ac.w.x * 0.6, -1, 1);
        thrI = clamp(thrI + (Vref - A.V) * 0.02 * dt, 0.05, 0.9); ctl.throttle = clamp(thrI + (Vref - A.V) * 0.04, 0, 0.94);
        if (h < 18) phase = 'flare';
      } else if (phase === 'flare') { // sink ever slower as the wheels come down to the runway
        const gcmd = Math.asin(clamp(-clamp(0.1 * h + 0.5, 0.5, 4.5) / Math.max(30, A.V), -0.5, 0.5));
        ctl.pitch = clamp((gcmd - A.gamma) * 1.2 - ac.w.x * 0.6, -1, 1); ctl.throttle = 0;
        if (ac.onGround) { phase = 'rollout'; td = { vs: +(-ac.v.y).toFixed(2), V: Math.round(A.V), x: +(ac.x.x - rwy.x).toFixed(1), z: Math.round(ac.x.z), pitchDeg: +(A.pitch / deg).toFixed(1) }; }
      } else { // rollout: nose down, brakes, stay on the centreline
        ctl.pitch = clamp((0 - A.pitch) * 1.5, -0.6, 0.3); ctl.throttle = 0; ac.brake = A.pitch < 2 * deg || A.V < 70 ? 1 : 0;
        if (A.V < 0.8) { idle += dt; if (idle > 1) done = true; }
      }
      // lateral: track the centreline (heading towards it), wings level-ish
      const hdgCmd = hdg + clamp(xErr * 0.004, -0.15, 0.15); // head back towards the centreline
      const bankCmd = phase === 'approach' ? clamp(wrap(hdgCmd - A.heading) * 2.0, -0.25, 0.25) : 0; // (bank + = left wing down = turning left)
      ctl.roll = clamp((A.bank - bankCmd) * 2.0, -1, 1);
      ctl.yaw = phase === 'rollout' ? clamp(wrap(A.heading - hdgCmd) * 4, -1, 1) : 0;
      if (phase !== 'rollout') ac.brake = 0;
      ac.setControls(ctl); ac.step(dt, env);
      for (const e of ac.events) if (e.type === 'msg') msgs.push(`${ac.time.toFixed(0)}s ${e.text}`);
      ac.events.length = 0;
      if (ac.dead || ac.wrecked) done = true;
    }
    const onRwy = Math.abs(ac.x.x - rwy.x) < rwy.width / 2 && Math.abs(ac.x.z) < rwy.len / 2;
    yield state(ac, { phase, td, onRwy, stopped: done && !ac.dead, msgs: msgs.splice(0) });
  }
}

// a flat world with a runway along z at x = 0 (for tuning without the game world)
export function flatEnv(V3) {
  const n = new V3(0, 1, 0), wind = new V3();
  return { groundAt: () => ({ h: 0, n, type: 'runway' }), maxGround: () => 0, windAt: () => wind, night: false, groundHeightAtSpawn: 0 };
}
