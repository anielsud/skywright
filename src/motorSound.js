// Engine voices for things that drive and sail: cars, motorbikes and boats (the 'drive' and 'marine' engines). The plane
// engines use recorded clips (audio.js SAMPLE_ENGINES); a dirt bike through a Cessna recording sounded like a Cessna, so
// these are synthesized from what makes each engine sound the way it does:
//   - the firing rate: rpm / 60 × cylinders / 2 for a four-stroke. A single-cylinder thumper fires 15-90 times a second
//     (each bang is heard: brap-brap), a V8 50-450 (a rumble), an inline-four sport bike up to 450 (a scream);
//   - the real engine's rev range (MOTOR.rpm), not the physics' rpm (which only says how far along idle..max it is);
//   - a gearbox (audio only) for wheeled vehicles: the revs climb with the speed in each gear and drop at each change up,
//     and the engine revs freely with the wheels off the ground (jumps) or the clutch slipping from a standstill;
//   - lumpiness at idle (a single's thump, a cross-plane V8's burble), exhaust rasp chopped by the firing pulses, the
//     exhaust/intake resonance (a band that rises with the revs), and the extras: a supercharger whine, an outboard's
//     gearcase whine, a jet ski's impeller rush, the wet-exhaust burble of an engine exhausting into the water.
// audio.js owns the voice's spatial chain (v.out -> panner); makeMotor builds the source graph into v.out, updateMotor
// sets it every frame from the engine state ({ rpm, spoolT, idleRpm, maxRpm, vmax, count }) and the audio state
// ({ onGround, groundSpeed }).
export const MOTOR = {
  // gears: audio gearbox ratios (0 = none: boats), wave: firing-pulse spectrum, lp: lowpass range idle..redline,
  // form: resonance band range, rasp/lump/breath: mix, whine: [Hz per rpm, gain], water: wet exhaust burble.
  // gain: balanced by measurement against the Cessna recording (audio.level(), 8 m behind): full throttle ≈ -40, idle ≈ -53 dB weighted
  dirtbike: { rpm: [1700, 11500], cyl: 1, gears: 5, wave: 'thump', lp: [500, 4200], form: [420, 1500], formQ: 3, rasp: 0.55, lump: 0.6, breath: 0.6, gain: 0.53, pops: 1, brap: 1 },
  sportbike: { rpm: [1500, 14000], cyl: 4, gears: 6, wave: 'four', lp: [700, 7500], form: [600, 2800], formQ: 2, rasp: 0.3, lump: 0.05, breath: 0.35, gain: 0.45, pops: 0.8 },
  v8: { rpm: [800, 6800], cyl: 8, gears: 5, wave: 'v8', lp: [320, 3200], form: [180, 750], formQ: 1.6, rasp: 0.35, lump: 0.7, breath: 0.8, gain: 0.42, pops: 1, whine: [1.25, 0.05] },
  outboard: { rpm: [750, 6000], cyl: 6, gears: 0, wave: 'four', lp: [450, 3000], form: [500, 1500], formQ: 2, rasp: 0.25, lump: 0.25, breath: 0.4, gain: 0.57, whine: [0.4, 0.03], water: 0.5 },
  inboard: { rpm: [650, 4800], cyl: 8, gears: 0, wave: 'v8', lp: [260, 1900], form: [150, 550], formQ: 1.5, rasp: 0.2, lump: 0.8, breath: 0.6, gain: 0.4, water: 1 },
  jetski: { rpm: [1300, 7800], cyl: 3, gears: 0, wave: 'four', lp: [600, 4200], form: [700, 2200], formQ: 2.2, rasp: 0.3, lump: 0.2, breath: 0.3, gain: 0.72, whine: [0.55, 0.035], water: 0.4, rush: 0.5 },
};
export const isMotor = (kind) => kind in MOTOR;

const WAVES = { // harmonic n of the firing rate -> amplitude
  thump: (n) => (n === 1 ? 1 : n === 2 ? 0.9 : n === 3 ? 0.8 : 0.75) / n ** 0.55, // a sharp, barky pulse
  four: (n) => (n % 2 ? 0.8 : 1) / n ** 1.05, // smooth and even
  v8: (n) => (n % 2 ? 0.65 : 1) / n ** 0.8,
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function makeMotor(A, v, kind) {
  const M = MOTOR[kind], to = (node) => node.connect(v.out);
  A.motorWaves ||= {};
  const wave = (A.motorWaves[M.wave] ||= A.makeWave(WAVES[M.wave]));
  v.motor = M; v.gear = 0; v.rpmNow = M.rpm[0];
  // the firing pulses, plus a half-rate thump (the uneven beat at idle), driven through a soft clipper
  v.o1 = A.osc(null, 40, wave); A.wobble(v.o1.detune, M.cyl === 1 ? 30 : 14, M.cyl === 1 ? 9 : 6);
  v.lo = A.osc('triangle', 20); v.log = A.gain(0); v.lo.connect(v.log);
  v.pre = A.gain(1); v.o1.connect(v.pre); v.log.connect(v.pre);
  v.sh = A.shape(); v.pre.connect(v.sh);
  v.lp = A.filt('lowpass', 800, 0.9); v.sh.connect(v.lp);
  v.body = A.gain(0.7); v.lp.connect(v.body); to(v.body);
  v.form = A.filt('bandpass', 600, M.formQ); v.fg = A.gain(0.9); v.sh.connect(v.form); v.form.connect(v.fg); to(v.fg);
  // rasp: noise chopped by the firing pulses (the "brrr" in the exhaust note)
  v.rn = A.noise(); v.rf = A.filt('bandpass', 2000, 0.9); v.rg = A.gain(0); v.rn.connect(v.rf); v.rf.connect(v.rg); to(v.rg);
  v.ram = A.osc('sine', 40); v.ramg = A.gain(0); v.ram.connect(v.ramg); v.ramg.connect(v.rg.gain);
  // exhaust breath
  v.bn = A.noise('brown'); v.bf = A.filt('bandpass', 200, 0.8); v.bg = A.gain(0); v.bn.connect(v.bf); v.bf.connect(v.bg); to(v.bg);
  if (M.whine) { v.wh = A.osc('sine', 1000); v.whg = A.gain(0); v.wh.connect(v.whg); to(v.whg); }
  if (M.water) { // wet exhaust: a low gurgle, wobbling as the outlet dips in and out of the water
    v.wn = A.noise('brown'); v.wf = A.filt('lowpass', 300, 1.5); v.wg = A.gain(0); v.wn.connect(v.wf); v.wf.connect(v.wg); to(v.wg);
    v.wl = A.osc('sine', 5); v.wlg = A.gain(0); v.wl.connect(v.wlg); v.wlg.connect(v.wg.gain);
  }
  if (M.rush) { v.jn = A.noise(); v.jf = A.filt('highpass', 1500, 0.7); v.jg = A.gain(0); v.jn.connect(v.jf); v.jf.connect(v.jg); to(v.jg); }
}

// The engine's revs as a driver would hear them: through the gearbox on wheels, straight from the physics on the water.
function motorRpm(v, e, s) {
  const M = v.motor, [idle, red] = M.rpm, thr = e.spoolT || 0;
  const span = Math.max(1, (e.maxRpm || 2700) - (e.idleRpm || 0)), nPhys = Math.min(1, Math.max(0, ((e.rpm || 0) - (e.idleRpm || 0)) / span));
  if (!M.gears) return { rpm: idle + (red - idle) * nPhys, shift: 0 };
  const G = M.gears, top = (g) => ((g + 1) / G) ** 0.8; // each gear's top speed as a fraction of the vehicle's
  const f = Math.min(1.05, (s.groundSpeed || 0) / (e.vmax || 50));
  let shift = 0;
  if (v.gear < G - 1 && f > top(v.gear) * 0.97) { v.gear++; shift = 1; } else if (v.gear > 0 && f < top(v.gear - 1) * 0.72) { v.gear--; shift = -1; }
  let rpm = Math.max(idle, red * Math.min(1, f / top(v.gear)) * 0.97);
  // wheels off the ground: it revs to the throttle; pulling away: the clutch slips and the revs rise with the throttle
  const free = !s.onGround ? 0.95 : f < 0.1 ? 0.5 * (1 - f / 0.1) : 0;
  rpm = Math.max(rpm, idle + (red - idle) * thr * free);
  return { rpm, shift };
}

export function updateMotor(A, v, e, s, multi) {
  const M = v.motor, thr = e.spoolT || 0, running = (e.rpm || 0) > 50, now = A.ctx.currentTime;
  const { rpm, shift } = motorRpm(v, e, s), rm = v.rateMul ?? 1;
  const r = rpm * rm, n = smooth(0, 1, (rpm - M.rpm[0]) / (M.rpm[1] - M.rpm[0])), fire = (r / 60) * (M.cyl / 2);
  // a gear change: the revs drop fast (and the sound dips for a moment); otherwise they follow smoothly
  const tc = shift > 0 ? 0.04 : 0.07;
  A.set(v.o1.frequency, fire, tc); A.set(v.lo.frequency, fire / 2, tc); A.set(v.ram.frequency, fire, tc);
  if (shift > 0) v.shiftT = now;
  const dip = v.shiftT && now - v.shiftT < 0.14 ? 0.45 : 1;
  const load = 0.35 + 0.65 * thr; // off the throttle the note thins out
  A.set(v.log.gain, M.lump * (1 - n) ** 2 * 0.9);
  A.set(v.pre.gain, 0.7 + load * 1.4 + (M.brap ? 0.6 * thr : 0));
  A.set(v.lp.frequency, M.lp[0] + (M.lp[1] - M.lp[0]) * (0.25 * n + 0.75 * n * load));
  A.set(v.form.frequency, M.form[0] + (M.form[1] - M.form[0]) * n);
  A.set(v.rf.frequency, 1200 + 2600 * n); A.set(v.rg.gain, M.rasp * 0.15 * load); A.set(v.ramg.gain, M.rasp * 0.25 * load);
  A.set(v.bf.frequency, 120 + 500 * n); A.set(v.bg.gain, M.breath * (0.25 + 0.6 * thr));
  if (v.wh) { A.set(v.wh.frequency, r * M.whine[0]); A.set(v.whg.gain, M.whine[1] * (0.3 + thr) * (0.3 + n)); }
  if (v.wg) { const wet = s.surface === 'water' ? 1 : 0.3; A.set(v.wg.gain, M.water * 0.5 * wet * (1 - 0.6 * n)); A.set(v.wl.frequency, 3 + 6 * n); A.set(v.wlg.gain, M.water * 0.35 * wet); }
  if (v.jg) A.set(v.jg.gain, M.rush * 0.12 * thr * (0.4 + n));
  A.set(v.out.gain, running ? (0.18 + 0.22 * load + 0.12 * n) * M.gain * multi * dip : 0, shift > 0 ? 0.02 : 0.06);
  // lifting off at high revs: pops and crackles in the exhaust; a change up on a bike: a little pop
  if (M.pops && running) {
    if ((v.lastThr ?? 0) - thr > 0.3 && n > 0.35) for (let k = 0; k < 3 + Math.floor(Math.random() * 3); k++) A.burst('crackle', 'bandpass', 500 + Math.random() * 500, 1, 0.55 * M.pops, 0.12, A.engBus, k * 0.09 + Math.random() * 0.08);
    if (shift > 0 && thr > 0.5 && M.cyl <= 4) A.burst('crackle', 'bandpass', 700, 1, 0.35 * M.pops, 0.08, A.engBus, 0.02);
  }
  v.lastThr = thr;
}
