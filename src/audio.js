// Fully synthesized audio (no sample files).
// 3D-positioned engines, location reverb, layered crashes, ambient beds and hangar music.
// Mixer channels the player can set (0..1 each). Sliders are perceptual: see dbGain.
export const MIX_DEFAULTS = { master: 0.75, engines: 0.9, world: 0.85, fx: 0.9, music: 0.75 };
export const OLD_MIX_DEFAULTS = { master: 0.7, engines: 0.7, world: 0.8, fx: 0.8, music: 0.6 }; // 1.6.1: channels too low, stacked with master
// Slider position -> gain. 0 is silent; otherwise -45 dB at the bottom of the travel up to 0 dB at the top,
// so every step sounds like the same change and the lowest steps are genuinely quiet.
export const dbGain = (v) => (v <= 0.001 ? 0 : 10 ** ((-45 * (1 - v)) / 20));
const HEADROOM = 0.25;
// Recorded engine layers (assets/sfx, built by tools/sfx/process.py). Each engine blends an idle and a high-power loop
// by RPM/spool and pitches them with it; 'cabin' layers replace the outside sound in the cockpit view.
// rate: [playbackRate at n=0, at n=1] where n is normalised RPM (props) or spool (turbines).
export const SAMPLE_ENGINES = {
  piston: { idle: ['eng_piston_idle', 0.8, 1.25], high: ['eng_piston_high', 0.82, 1.08], cabin: ['eng_piston_cabin', 0.85, 1.1], gain: 1 },
  radial: { idle: ['eng_radial_idle', 0.8, 1.25], high: ['eng_radial_high', 0.75, 1.0], gain: 1 },
  turboprop: { idle: ['eng_turboprop_ext', 0.78, 0.95], high: ['eng_turboprop_ext', 0.92, 1.12], cabinIdle: ['eng_turboprop_idle', 0.9, 1.05], cabin: ['eng_turboprop_high', 0.9, 1.05], gain: 1 },
  jet: { idle: ['eng_jet_idle', 0.85, 1.15], high: ['eng_jet_high', 0.8, 1.08], ab: 'eng_jet_ab', gain: 1 },
  fan: { idle: ['eng_fan_idle', 0.85, 1.2], high: ['eng_jet_high', 0.68, 0.88], cabin: ['eng_fan_cabin', 0.9, 1.1], gain: 1 },
  rocket: { high: ['eng_rocket', 0.95, 1.05], gain: 1 },
  rotor: { idle: ['eng_rotor_idle', 0.75, 1.15], high: ['eng_rotor_high', 0.45, 0.8], cabin: ['eng_rotor_cabin', 0.7, 1.05], gain: 1 }, // helicopter: see rotorTick
};
export const SAMPLE_LEVEL = { piston: 3.6, radial: 2.7, turboprop: 3.1, jet: 2.1, fan: 2.2, rocket: 3.0, rotor: 4.5 }; // full power ≈ -24 dB props, -28 jets (weighted, tools/sfx measurements)
// Recorded world/foley levels (linear), balanced with tools/sfx-style weighted measurements.
const MUSIC = { hangar: 0.6, cruise: 0.7, mission: 1.3 }; // weighted avg at music 100%: hangar ≈-35, cruise ≈-38 (under the engine), mission ≈-33 dB
const SHOT = { lever: 0.24, voice: 1.8, crash: 0.4, debris: 0.2, glass: 0.35, explosion: 0.4, boom: 0.4, chirp: 0.38, splash: 0.32, gear: 0.32, thunder: 0.3, strike: 0.6 }; // peaks: crash ≈-22, explosion ≈-18, chirp ≈-28 dB weighted
const REC = { windExt: 2.66, windCk: 4.6, roll: 2, rain: 2, day: 0.73, night: 0.52, sea: 1.38, lake: 1.46 }; // wind@120 m/s ≈-32, roll ≈-30, rain ≈-30, day bed ≈-40 dB weighted
// workshop foley (hangar building) levels, and the synth each falls back to while clips load
const WS = { place: 0.48, clunk: 0.37, ratchet: 0.29, tick: 0.25, spray: 0.72, select: 0.25, toolbox: 0.35, button: 0.22, room: 0.23 }; // peaks (weighted, 100%): place ≈-29, remove ≈-28, paint/rotate/flip ≈-31, select/undo ≈-32, ticks ≈-36; room tone ≈-47 avg
const WS_FALLBACK = { place: 'clank', remove: 'clank', paint: 'pop', select: 'click', rotate: 'click', move: 'click', flip: 'click', undo: 'click', redo: 'click', load: 'clank', save: 'clank' };
// music ducking depths (dB) and the stall horn's level
const DUCK = { voice: 6, crash: 6 };
const STALL_HORN = 0.18; // ≈-28 dB weighted while stalled: over the engine at climb power, under the "Stall!" voice
// mission stings (rings, countdown, results)
const MS = { chime: 0.36, beep: 0.53, fanfare: 0.49, fail: 0.47, record: 0.75 }; // peaks (weighted, 100%): chime ≈-27, countdown ≈-29 (GO ≈-26), fanfare ≈-24.5, fail ≈-26.5, record ≈-25
const RING_STEPS = [-5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12, 14]; // semitones: the checkpoint chime climbs a major scale, G up to the D above the octave
export const RPM_RANGE = { piston: [700, 2700], radial: [600, 2600], turboprop: [1000, 2000], rotor: [1000, 2000] };
// Start / shutdown sequences (see engineStart). Times in seconds from the start: catch = the engine fires, blend = the running
// voice fades in over [from, to]. Clips are recorded (tools/sfx: Cessna start/stop, J79 start cart); radials share the
// Cessna start played slower plus a few extra coughs. stopFade = how long the running voice takes to wind out under the stop clip.
const ENG_SEQ = {
  piston: { prop: true, clip: 'eng_start_piston', rate: 1, gain: 1.1, catch: 1.7, blend: [1.9, 3.4], stop: 'eng_stop_piston', stopGain: 0.4, stopFade: 0.6, stopDur: 5.8 },
  radial: { prop: true, clip: 'eng_start_piston', rate: 0.82, gain: 0.9, catch: 2.1, blend: [2.3, 4.3], coughs: [1.2, 1.55, 1.9], stop: 'eng_stop_piston', stopGain: 0.4, stopFade: 0.8, stopDur: 7 },
  turboprop: { clip: 'eng_spool', rate: 1.1, gain: 0.6, catch: 2.6, blend: [2.4, 4.2], stop: 'eng_stop_jet', stopGain: 0.5, stopFade: 2.5, stopDur: 8 },
  jet: { clip: 'eng_start_jet', rate: 1, gain: 0.4, catch: 3.0, blend: [3.2, 5.2], stop: 'eng_stop_jet', stopGain: 0.45, stopFade: 3, stopDur: 9 },
  rotor: { clip: 'eng_spool', rate: 1, gain: 0.6, catch: 2.8, blend: [2.6, 4.2], stop: 'eng_stop_jet', stopGain: 0.5, stopFade: 2.5, stopDur: 8 },
  fan: { clip: 'eng_start_jet', rate: 0.9, gain: 0.4, catch: 3.3, blend: [3.6, 5.8], stop: 'eng_stop_jet', stopGain: 0.45, stopFade: 3.5, stopDur: 10 },
};
const DMG = { pop: 0.35, fire: 1, creak: 0.6, strain: 0.45, rattle: 0.28, flutter: 0.34 }; // damage audio (engineDamage, airframe)
const BOOM = { crack: 0.2, rumble: 0.22, cockpit: 1 }; // sonic boom (sonicBoom) peaks (weighted, 100%): ≈-23 close outside, ≈-36 at 1.5 km, cockpit thump ≈-30; limiter ≥ -2 dB
const ROTOR = { whop: 0.6, whine: 0.012, tail: 0.05 }; // helicopter extras (rotorTick)
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }; // -12 dB overall: a game shouldn't hit the speaker at full scale

export class Audio {
  constructor() { this.ctx = null; this.voices = {}; this.mix = { ...MIX_DEFAULTS }; this.space = null; this.buffers = {}; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    // Safety limiter only. (A DynamicsCompressor adds automatic make-up gain, so a low threshold makes everything LOUDER;
    // the old -16 dB / 5:1 setting is why the mix was hot even at low volume.)
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -3; this.comp.knee.value = 0; this.comp.ratio.value = 20; this.comp.attack.value = 0.002; this.comp.release.value = 0.15;
    this.subCut = this.filt('highpass', 40, 0.7); this.subCut.connect(this.comp); // nothing useful lives below 40 Hz
    this.cockpitLP = this.filt('lowpass', 20000, 0.7);
    this.bus = this.gain(1); this.bus.connect(this.cockpitLP); this.cockpitLP.connect(this.subCut);
    // engines: a gentle low shelf keeps recorded engine bass (mostly inaudible on a tablet) from eating the limiter's headroom
    this.engLow = ctx.createBiquadFilter(); this.engLow.type = 'lowshelf'; this.engLow.frequency.value = 140; this.engLow.gain.value = -6;
    this.engBus = this.gain(1); this.engBus.connect(this.engLow); this.engLow.connect(this.bus);
    this.airBus = this.gain(1); this.airBus.connect(this.bus); // wind, buffet, wheels rolling: 'world' channel
    // effects: crashes/explosions were mostly sub-bass that tablet speakers can't play but that slammed the limiter
    this.fxLow = ctx.createBiquadFilter(); this.fxLow.type = 'lowshelf'; this.fxLow.frequency.value = 150; this.fxLow.gain.value = -10;
    this.fx = this.gain(1); this.fx.connect(this.fxLow); this.fxLow.connect(this.subCut);
    this.amb = this.gain(1); this.amb.connect(this.subCut);
    this.musBus = this.gain(1); this.musDuck = this.gain(1); this.musBus.connect(this.musDuck); this.musDuck.connect(this.subCut); // musDuck: dips under voices and big crashes
    // reverb send
    this.verb = ctx.createConvolver(); this.verbOut = this.gain(0.9); this.verb.connect(this.verbOut); this.verbOut.connect(this.subCut);
    this.sendBus = this.gain(0.12); this.bus.connect(this.sendBus); this.sendBus.connect(this.verb);
    this.sendFx = this.gain(0.4); this.fx.connect(this.sendFx); this.sendFx.connect(this.verb);
    this.musSend = this.gain(0.8); this.musDuck.connect(this.musSend); this.musSend.connect(this.verb);
    this.comp.connect(this.master); this.master.connect(ctx.destination);
    // meter for tests / balancing, weighted like a tablet speaker heard by a person: little below ~250 Hz, presence boosted (≈K-weighting)
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 2048;
    const mhp = this.filt('highpass', 250, 0.7), msh = ctx.createBiquadFilter(); msh.type = 'highshelf'; msh.frequency.value = 1500; msh.gain.value = 4;
    this.master.connect(mhp); mhp.connect(msh); msh.connect(this.meter);
    this.applyMix(0);
    const len = ctx.sampleRate * 2;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate); const w = this.white.getChannelData(0); for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate); const b = this.brown.getChannelData(0); let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    // sparse crackle (afterburner, rockets, fire)
    this.crackle = ctx.createBuffer(1, len, ctx.sampleRate); const cr = this.crackle.getChannelData(0); for (let i = 0; i < len; i++) { if (Math.random() < 0.0016) { const a = Math.random() * 2 - 1, n = 20 + Math.random() * 120; for (let k = 0; k < n && i + k < len; k++) cr[i + k] += a * Math.exp(-k / (n * 0.3)) * (Math.random() * 2 - 1); } }
    this.shaper = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; this.shaper[i] = Math.tanh(x * 2.5); }
    this.pistonWave = this.makeWave((n) => (n % 2 === 0 ? 1 : 0.4) / Math.pow(n, 0.75));
    this.radialWave = this.makeWave((n) => (n % 9 === 0 ? 1.4 : n % 3 === 0 ? 0.6 : 0.3) / Math.pow(n, 0.6));
    this.setSpace('hangar');
    this.loadSamples();
  }
  // Fetch + decode the recorded clips. Until they arrive (or if a browser can't decode Opus) voices stay synthesized.
  async loadSamples(base = 'assets/sfx/') {
    try {
      const index = await (await fetch(base + 'index.json')).json();
      await Promise.all(Object.keys(index).map(async (n) => {
        try { this.buffers[n] = await this.ctx.decodeAudioData(await (await fetch(`${base}${n}.ogg`)).arrayBuffer()); } catch { /* keep the synth fallback */ }
      }));
      // rebuild engine voices that were created as synth while loading
      for (const k of Object.keys(SAMPLE_ENGINES)) if (this.voices[k] && !this.voices[k].sampled && this.canSample(k)) this.dropVoice(k);
      if (this.roomOn) this.roomTone(true); // the hangar opened before its room tone had loaded
    } catch { /* offline first run etc.: synth only */ }
  }
  canSample(kind) { const d = SAMPLE_ENGINES[kind]; return !!d && ['idle', 'high', 'cabin', 'cabinIdle'].every((r) => !d[r] || this.buffers[d[r][0]]) && (!d.ab || this.buffers[d.ab]); }
  dropVoice(k) { const v = this.voices[k]; delete this.voices[k]; this.set(v.out.gain, 0, 0.05); setTimeout(() => { try { v.out.disconnect(); v.pan?.disconnect(); v.layers?.forEach((l) => l.src.stop()); } catch { /* gone */ } }, 300); }
  loop(name) { const s = this.ctx.createBufferSource(); s.buffer = this.buffers[name]; s.loop = true; s.start(0, Math.random() * s.buffer.duration); return s; }
  has(name) { return !!this.buffers[name]; }
  // cockpit voice callout (src/callouts.js); goes through the Effects channel, never muffled by the cockpit filter
  say(name) { const ok = !!name && this.callouts !== false && this.shot(name, { gain: SHOT.voice, dest: this.fx }); if (ok) this.duck(DUCK.voice, this.buffers[name].duration + 0.2); return ok; }
  // one-shot recording; returns false (so callers fall back to synthesis) if it isn't loaded
  shot(name, { gain = 1, rate = 1, dest = this.fx, delay = 0 } = {}) {
    const b = this.buffers[name]; if (!b || !this.ctx) return false;
    const src = this.ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = rate;
    const g = this.gain(gain); src.connect(g); g.connect(dest); src.start(this.ctx.currentTime + delay);
    src.onended = () => g.disconnect(); return true;
  }
  // looping bed (created once, silent until its gain is set); null if the clip isn't loaded
  bed(name, dest) {
    this.beds ||= {};
    if (!this.beds[name] && this.has(name)) { const src = this.loop(name), g = this.gain(0); src.connect(g); g.connect(dest); this.beds[name] = { src, g }; }
    return this.beds[name] || null;
  }
  bedGain(name, dest, v, t = 0.3, rate) { const b = this.bed(name, dest); if (!b) return false; this.set(b.g.gain, v, t); if (rate) this.set(b.src.playbackRate, rate, 0.1); return true; }
  makeWave(ampFn, N = 64) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) { const a = ampFn(n), ph = Math.random() * Math.PI * 2; re[n] = a * Math.cos(ph); im[n] = a * Math.sin(ph); }
    return this.ctx.createPeriodicWave(re, im);
  }
  // impulse response: decaying stereo noise with optional discrete echoes (mountains, canyon walls)
  setSpace(kind) {
    if (!this.ctx || this.space === kind) return; this.space = kind;
    const sr = this.ctx.sampleRate;
    const cfg = { hangar: { t: 2.6, d: 3.2, echoes: [], wet: 0.9 }, alpine: { t: 2.4, d: 5, echoes: [[0.42, 0.35], [0.95, 0.22], [1.6, 0.12]], wet: 0.6 }, canyon: { t: 3.0, d: 4, echoes: [[0.28, 0.45], [0.61, 0.32], [1.05, 0.2], [1.7, 0.12]], wet: 0.7 }, islands: { t: 1.0, d: 7, echoes: [], wet: 0.25 } }[kind] || { t: 1.2, d: 6, echoes: [], wet: 0.3 };
    const n = Math.floor(sr * cfg.t), buf = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, cfg.d) * (i < sr * 0.01 ? i / (sr * 0.01) : 1) * 0.6;
      for (const [t, a] of cfg.echoes) { const s0 = Math.floor((t + ch * 0.013) * sr); for (let k = 0; k < sr * 0.08 && s0 + k < n; k++) d[s0 + k] += (Math.random() * 2 - 1) * a * Math.exp(-k / (sr * 0.02)); }
    }
    this.verb.buffer = buf; this.set(this.verbOut.gain, cfg.wet, 0.3);
  }
  setMix(mix) { Object.assign(this.mix, mix); this.applyMix(); }
  applyMix(t = 0.05) {
    if (!this.ctx) return;
    const m = this.mix, g = (k) => dbGain(m[k] ?? MIX_DEFAULTS[k]), at = (p, v) => (t ? this.set(p, v, t) : (p.value = v));
    at(this.master.gain, g('master') * HEADROOM); at(this.engBus.gain, g('engines')); at(this.airBus.gain, g('world')); at(this.amb.gain, g('world'));
    at(this.fx.gain, g('fx') * 2.5); at(this.musBus.gain, g('music') * 2); // trims from loudness measurements
  }
  // RMS level of the output in dBFS (after master volume), for balancing tests.
  level() { const a = new Float32Array(this.meter.fftSize); this.meter.getFloatTimeDomainData(a); let s = 0; for (const x of a) s += x * x; return 10 * Math.log10(s / a.length + 1e-12); }
  noise(type = 'white') { const s = this.ctx.createBufferSource(); s.buffer = type === 'brown' ? this.brown : type === 'crackle' ? this.crackle : this.white; s.loop = true; s.start(0, Math.random() * 1.5); return s; }
  osc(type, f, wave) { const o = this.ctx.createOscillator(); if (wave) o.setPeriodicWave(wave); else o.type = type; o.frequency.value = f; o.start(); return o; }
  filt(type, f, Q = 1) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; }
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  shape() { const s = this.ctx.createWaveShaper(); s.curve = this.shaper; return s; }
  set(param, v, t = 0.06) { if (Number.isFinite(v)) param.setTargetAtTime(v, this.ctx.currentTime, t); }
  panner() {
    const p = this.ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 12; p.maxDistance = 20000; p.rolloffFactor = 1.1;
    return p;
  }
  wobble(param, cents, rate = 6) { // organic pitch drift via low-passed noise
    const n = this.noise(), f = this.filt('lowpass', rate, 0.5), g = this.gain(cents); n.connect(f); f.connect(g); g.connect(param); return g;
  }

  // ---------- continuous voices ----------
  makeVoice(kind) {
    const v = { kind, out: this.gain(0) };
    const spatial = !['wind', 'roll', 'stall', 'rain', 'buffet', 'whistle'].includes(kind);
    // engines: out -> air absorption (distant = duller) -> propagation delay (sound arrives d/343 s late; a changing delay
    // is also physically correct Doppler) -> 3D panner
    if (spatial) { v.pan = this.panner(); v.air = this.filt('lowpass', 22000, 0.5); v.dl = this.ctx.createDelay(4); v.seq = this.gain(this.seqGain(kind)); v.out.connect(v.seq); v.seq.connect(v.air); v.air.connect(v.dl); v.dl.connect(v.pan); v.pan.connect(this.engBus); } else v.out.connect(kind === 'stall' ? this.fx : kind === 'rain' ? this.amb : this.airBus);
    const to = (node) => node.connect(v.out);
    if (this.canSample(kind)) { // recorded layers
      const d = SAMPLE_ENGINES[kind]; v.sampled = true; v.layers = [];
      for (const role of ['idle', 'high', 'cabinIdle', 'cabin']) if (d[role]) { const src = this.loop(d[role][0]), g = this.gain(0); src.connect(g); to(g); v.layers.push({ role, src, g, rate: d[role].slice(1) }); }
      if (d.ab) { const src = this.loop(d.ab), g = this.gain(0); src.connect(g); to(g); v.layers.push({ role: 'ab', src, g, rate: [0.95, 1.05] }); }
      return v;
    }
    if (kind === 'piston' || kind === 'radial') {
      const rad = kind === 'radial';
      v.o1 = this.osc(null, 40, rad ? this.radialWave : this.pistonWave); this.wobble(v.o1.detune, rad ? 22 : 12);
      v.sh = this.shape(); v.pre = this.gain(rad ? 1.2 : 0.9); v.o1.connect(v.pre); v.pre.connect(v.sh);
      v.lp = this.filt('lowpass', 600, 1.2); v.sh.connect(v.lp);
      v.body = this.gain(0.8); v.lp.connect(v.body); to(v.body);
      // exhaust breath
      v.n = this.noise('brown'); v.nf = this.filt('bandpass', 180, 0.9); v.ng = this.gain(0.7); v.n.connect(v.nf); v.nf.connect(v.ng); to(v.ng);
      // prop: blade-pass buzz and swish (amplitude-modulated noise)
      v.pb = this.osc('sawtooth', 80); v.pbf = this.filt('bandpass', 240, 2); v.pbg = this.gain(0); v.pb.connect(v.pbf); v.pbf.connect(v.pbg); to(v.pbg);
      v.pn = this.noise(); v.pf = this.filt('bandpass', 900, 0.8); v.pam = this.gain(0); v.pn.connect(v.pf); v.pf.connect(v.pam); to(v.pam);
      v.pl = this.osc('sine', 40); v.plg = this.gain(0); v.pl.connect(v.plg); v.plg.connect(v.pam.gain);
    } else if (kind === 'turboprop' || kind === 'electric') {
      const el = kind === 'electric';
      v.whine = this.osc('sine', 3000); v.wg = this.gain(el ? 0.18 : 0.05); v.whine.connect(v.wg); to(v.wg);
      v.w2 = this.osc('triangle', 1500); v.w2g = this.gain(el ? 0.1 : 0.03); v.w2.connect(v.w2g); to(v.w2g);
      if (el) { v.pwm = this.osc('square', 7800); v.pwmg = this.gain(0.012); v.pwm.connect(v.pwmg); to(v.pwmg); }
      v.buzz = this.osc('sawtooth', 120); this.wobble(v.buzz.detune, 8); v.bf = this.filt('lowpass', 600, 4); v.bg = this.gain(el ? 0.05 : 0.5); v.buzz.connect(v.bf); v.bf.connect(v.bg); to(v.bg);
      v.n = this.noise(); v.nf = this.filt('bandpass', 900, 0.6); v.ng = this.gain(el ? 0.1 : 0.45); v.n.connect(v.nf); v.nf.connect(v.ng); to(v.ng);
      v.rum = this.noise('brown'); v.rf = this.filt('lowpass', 140, 0.7); v.rg = this.gain(el ? 0 : 0.6); v.rum.connect(v.rf); v.rf.connect(v.rg); to(v.rg);
      v.pl = this.osc('sine', 30); v.plg = this.gain(0.3); v.pl.connect(v.plg); v.plg.connect(v.ng.gain);
    } else if (kind === 'jet' || kind === 'fan') {
      const fan = kind === 'fan';
      v.n = this.noise(); v.nf = this.filt('bandpass', 500, 0.5); v.ng = this.gain(1); v.n.connect(v.nf); v.nf.connect(v.ng); to(v.ng);
      v.h = this.noise(); v.hf = this.filt('highpass', 3500, 0.5); v.hg = this.gain(0.2); v.h.connect(v.hf); v.hf.connect(v.hg); to(v.hg);
      v.rum = this.noise('brown'); v.rf = this.filt('lowpass', 110, 0.7); v.rg = this.gain(0.9); v.rum.connect(v.rf); v.rf.connect(v.rg); to(v.rg);
      v.whine = this.osc('sine', 2000); this.wobble(v.whine.detune, 6, 3); v.wg = this.gain(fan ? 0.05 : 0.07); v.whine.connect(v.wg); to(v.wg);
      v.whine2 = this.osc('sine', 2013); v.wg2 = this.gain(fan ? 0.03 : 0.05); v.whine2.connect(v.wg2); to(v.wg2);
      // fan "buzz-saw" (shock tones from supersonic fan tips)
      v.saw = this.osc('sawtooth', 120); v.sawf = this.filt('bandpass', 360, 4); v.sawg = this.gain(0); v.saw.connect(v.sawf); v.sawf.connect(v.sawg); to(v.sawg);
      // afterburner: roar + crackle
      v.ab = this.noise('brown'); v.abf = this.filt('lowpass', 320, 0.7); v.abg = this.gain(0); v.ab.connect(v.abf); v.abf.connect(v.abg); to(v.abg);
      v.cr = this.noise('crackle'); v.crf = this.filt('highpass', 400, 0.7); v.crg = this.gain(0); v.cr.connect(v.crf); v.crf.connect(v.crg); to(v.crg);
    } else if (kind === 'rocket') {
      v.n = this.noise(); v.nf = this.filt('lowpass', 1400, 0.5); v.ng = this.gain(1); v.n.connect(v.nf); v.nf.connect(v.ng); to(v.ng);
      v.b = this.noise('brown'); v.bg = this.gain(2.6); v.b.connect(v.bg); to(v.bg);
      v.cr = this.noise('crackle'); v.crg = this.gain(2.2); v.cr.connect(v.crg); to(v.crg);
    } else if (kind === 'wind') {
      // gusting modulates its own stage (it used to add straight onto out.gain, so wind hissed even when parked)
      v.gust = this.gain(1); to(v.gust);
      v.n = this.noise(); v.nf = this.filt('bandpass', 400, 0.6); v.n.connect(v.nf); v.nf.connect(v.gust);
      v.n2 = this.noise('brown'); v.n2g = this.gain(1.5); v.n2.connect(v.n2g); v.n2g.connect(v.gust);
      v.gl = this.osc('sine', 0.3); v.glg = this.gain(0.25); v.gl.connect(v.glg); v.glg.connect(v.gust.gain);
    } else if (kind === 'whistle') {
      v.n = this.noise(); v.nf = this.filt('bandpass', 1800, 9); v.n.connect(v.nf); to(v.nf);
    } else if (kind === 'buffet') {
      v.n = this.noise('brown'); v.nf = this.filt('lowpass', 90, 1); v.am = this.gain(0.5); v.lfo = this.osc('square', 9); v.lg = this.gain(0.5); v.lfo.connect(v.lg); v.lg.connect(v.am.gain);
      v.n.connect(v.nf); v.nf.connect(v.am); to(v.am);
    } else if (kind === 'roll') {
      v.n = this.noise('brown'); v.nf = this.filt('lowpass', 160, 1); v.n.connect(v.nf); to(v.nf);
      v.bump = this.noise('crackle'); v.bf = this.filt('lowpass', 300); v.bg = this.gain(1.5); v.bump.connect(v.bf); v.bf.connect(v.bg); to(v.bg);
      v.c = this.noise(); v.cf = this.filt('bandpass', 1200, 1); v.cg = this.gain(0); v.c.connect(v.cf); v.cf.connect(v.cg); v.cg.connect(this.fx);
    } else if (kind === 'stall') { // reed stall-warning horn (like a Cessna's): two slightly beating reeds, a nasal formant, breath and flutter
      v.flt = this.gain(1); v.lfo = this.osc('sine', 6.5); v.lg = this.gain(0.2); v.lfo.connect(v.lg); v.lg.connect(v.flt.gain);
      v.o = this.osc('sawtooth', 660); v.o2 = this.osc('sawtooth', 664.5); this.wobble(v.o.detune, 12, 5); this.wobble(v.o2.detune, 12, 5);
      v.f = this.filt('bandpass', 1900, 0.8); v.lp = this.filt('lowpass', 4500, 0.7); v.og = this.gain(0.5);
      v.o.connect(v.og); v.o2.connect(v.og); v.og.connect(v.f); v.f.connect(v.lp); v.lp.connect(v.flt);
      v.br = this.noise(); v.bf = this.filt('bandpass', 1320, 5); v.bg = this.gain(0.5); v.br.connect(v.bf); v.bf.connect(v.bg); v.bg.connect(v.flt);
      to(v.flt);
    } else if (kind === 'rain') {
      v.n = this.noise(); v.nf = this.filt('highpass', 1500, 0.4); v.n.connect(v.nf); to(v.nf);
      v.d = this.noise('crackle'); v.df = this.filt('bandpass', 3000, 1); v.dg = this.gain(0.6); v.d.connect(v.df); v.df.connect(v.dg); to(v.dg);
    }
    return v;
  }
  voice(kind) { if (!this.voices[kind]) this.voices[kind] = this.makeVoice(kind); return this.voices[kind]; }

  setListener(pos, fwd, up) {
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(pos.x, t, 0.02); L.positionY.setTargetAtTime(pos.y, t, 0.02); L.positionZ.setTargetAtTime(pos.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02); L.forwardY.setTargetAtTime(fwd.y, t, 0.02); L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02); L.upY.setTargetAtTime(up.y, t, 0.02); L.upZ.setTargetAtTime(up.z, t, 0.02);
    } else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
  }
  placeVoice(v, p) {
    if (!v.pan || !p) return;
    const t = this.ctx.currentTime;
    if (v.pan.positionX) { v.pan.positionX.setTargetAtTime(p.x, t, 0.02); v.pan.positionY.setTargetAtTime(p.y, t, 0.02); v.pan.positionZ.setTargetAtTime(p.z, t, 0.02); }
    else v.pan.setPosition(p.x, p.y, p.z);
  }

  // state: { engines:[{sound,rpm,spoolT,count,blades,ab,burning,pos}], listener:{pos,fwd,up}, airspeed, buffet, onGround, groundSpeed, surface, scrape, stall, cockpit, doppler, rain, amb:{loc,night,agl,waterNear,day} }
  update(s) {
    if (!this.ctx) return;
    const dop = s.doppler || 1;
    if (s.listener) this.setListener(s.listener.pos, s.listener.fwd, s.listener.up);
    const cabinRec = s.engines.some((e) => this.voices[e.sound]?.sampled && SAMPLE_ENGINES[e.sound]?.cabin);
    this.set(this.cockpitLP.frequency, s.cockpit ? (cabinRec ? 5000 : 1600) : 20000, 0.1);
    const seen = new Set();
    for (let e of s.engines) {
      const v = this.voice(e.sound); seen.add(e.sound); this.engineDamage(v, e); e = this.seqTick(v, e); // misfires; start/shutdown sequence
      if (s.cockpit && v.pan) v.pan.refDistance = 40; else if (v.pan) v.pan.refDistance = 12 + e.count * 3;
      this.placeVoice(v, e.pos);
      if (v.dl && e.pos && s.listener) {
        const d = s.cockpit ? 0 : Math.hypot(e.pos.x - s.listener.pos.x, e.pos.y - s.listener.pos.y, e.pos.z - s.listener.pos.z);
        const target = Math.min(3.5, d / 343), now = this.ctx.currentTime;
        // a camera cut (chase -> tower) would make the delay sweep and the pitch swoop: jump instead
        if (Math.abs(target - v.dl.delayTime.value) > 0.12) { v.dl.delayTime.cancelScheduledValues(now); v.dl.delayTime.setValueAtTime(target, now); } else v.dl.delayTime.setTargetAtTime(target, now, 0.06);
        this.set(v.air.frequency, Math.max(900, 22000 * Math.exp(-d / 550)), 0.1);
        e.toListener = d > 0.01 ? { x: (s.listener.pos.x - e.pos.x) / d, y: (s.listener.pos.y - e.pos.y) / d, z: (s.listener.pos.z - e.pos.z) / d } : null;
      }
      const thr = e.spoolT;
      const multi = Math.sqrt(e.count);
      if (e.sound === 'rotor') this.rotorTick(v, e, s, multi);
      if (v.sampled) { this.updateSampled(v, e, s, 1, multi); continue; } // doppler comes from the delay line
      if (e.sound === 'piston' || e.sound === 'radial') {
        const rad = e.sound === 'radial', rps = Math.max(1, e.rpm) / 60;
        this.set(v.o1.frequency, rps * 0.5 * dop * (rad ? 1 : 2)); // two-revolution cycle
        this.set(v.lp.frequency, 220 + thr * 1500); this.set(v.pre.gain, 0.6 + thr * 1.2); this.set(v.nf.frequency, 110 + thr * 420);
        const bp = rps * e.blades * dop;
        this.set(v.pb.frequency, bp); this.set(v.pbf.frequency, bp * 3); this.set(v.pbg.gain, 0.05 + thr * 0.2);
        this.set(v.pl.frequency, bp); this.set(v.plg.gain, 0.25 * thr); this.set(v.pf.frequency, 400 + thr * 900); this.set(v.pam.gain, 0.1 + thr * 0.3);
        this.set(v.out.gain, e.rpm > 50 ? (0.2 + thr * 0.28) * multi * (rad ? 0.84 : 0.85) : 0); // balanced by measurement: full throttle ≈ -24 dB weighted
        // throttle chop at speed -> exhaust pops
        if ((v.lastThr ?? 0) - thr > 0.25 && e.rpm > 1500) for (let k = 0; k < 4; k++) this.burst('crackle', 'bandpass', 600, 1, 0.5, 0.15, this.engBus, k * 0.12 + Math.random() * 0.1);
        v.lastThr = thr;
      } else if (e.sound === 'turboprop' || e.sound === 'electric') {
        const el = e.sound === 'electric';
        this.set(v.whine.frequency, (el ? 400 + thr * 2600 : 2600 + thr * 2400) * dop); this.set(v.w2.frequency, (el ? 200 + thr * 1300 : 1300 + thr * 800) * dop);
        this.set(v.buzz.frequency, (e.rpm / 60) * e.blades * dop); this.set(v.pl.frequency, (e.rpm / 60) * e.blades * 0.25 * dop);
        this.set(v.nf.frequency, 500 + thr * 900);
        this.set(v.out.gain, (0.14 + thr * 0.32) * multi * (el ? 1.6 : 1.4));
      } else if (e.sound === 'jet' || e.sound === 'fan') {
        const fan = e.sound === 'fan';
        this.set(v.nf.frequency, (300 + thr * 1500) * dop);
        this.set(v.whine.frequency, (fan ? 900 + thr * 2400 : 1500 + thr * 5500) * dop); this.set(v.whine2.frequency, (fan ? 905 + thr * 2420 : 1507 + thr * 5530) * dop);
        this.set(v.saw.frequency, (fan ? 60 + thr * 170 : 150 + thr * 300) * dop); this.set(v.sawf.frequency, (fan ? 60 + thr * 170 : 150 + thr * 300) * 3 * dop);
        this.set(v.sawg.gain, fan ? Math.max(0, thr - 0.55) * 0.9 : 0.03);
        this.set(v.hg.gain, 0.1 + thr * 0.3); this.set(v.rg.gain, 0.3 + thr * 0.9);
        this.set(v.abg.gain, e.ab ? 1.8 : 0, 0.15); this.set(v.crg.gain, e.ab ? 1.6 : 0, 0.15);
        this.set(v.out.gain, (0.1 + thr * 0.45) * multi);
      } else if (e.sound === 'rocket') {
        const on = e.burning ? 1 : 0;
        this.set(v.ng.gain, on * (0.8 + Math.random() * 0.5), 0.02);
        this.set(v.out.gain, on * 0.75 * multi, 0.05);
      }
    }
    for (const k of ['piston', 'radial', 'turboprop', 'electric', 'jet', 'fan', 'rocket', 'rotor']) if (!seen.has(k) && this.voices[k]) this.set(this.voices[k].out.gain, 0, 0.15);
    // airflow
    const sp = s.airspeed, ck = s.cockpit ? 0.65 : 1;
    const wAmt = Math.min(0.4, (sp / 90) ** 2 * 0.3); // wind sits under the engine, even at jet speeds
    const wRate = 0.8 + Math.min(sp, 200) / 400;
    const recWind = this.bedGain('wind_ext', this.airBus, wAmt * (s.cockpit ? 0 : 1) * REC.windExt, 0.15, wRate) & this.bedGain('wind_cockpit', this.airBus, wAmt * (s.cockpit ? 1 : 0) * REC.windCk, 0.15, wRate);
    const wv = this.voice('wind'); this.set(wv.nf.frequency, 250 + Math.min(sp, 130) * 9); this.set(wv.out.gain, recWind ? 0 : wAmt * ck);
    const wh = this.voice('whistle'); this.set(wh.nf.frequency, 900 + sp * 14); this.set(wh.out.gain, Math.max(0, (sp - 60) / 200) ** 2 * 0.1 * ck);
    const bf = this.voice('buffet'); this.set(bf.out.gain, Math.min(1.2, (s.buffet || 0) * 3) * (s.cockpit ? 1.5 : 0.7), 0.05); this.set(bf.lfo.frequency, 6 + Math.random() * 6);
    // ground roll
    const rv = this.voice('roll');
    const rollAmt = s.onGround ? Math.min(1, s.groundSpeed / 30) : 0;
    // recorded rolling per surface (see groundSurface); the synth rumble only stands in where a recording is missing
    const recRoll = this.groundSurface(s, rollAmt);
    this.set(rv.out.gain, recRoll || s.surface === 'water' ? 0 : rollAmt * (s.surface === 'runway' ? 0.45 : 1.0), 0.05);
    this.set(rv.nf.frequency, s.surface === 'runway' ? 120 : 260); this.set(rv.bg.gain, s.surface === 'runway' ? 0.4 : 2.2);
    this.set(rv.cg.gain, s.scrape ? Math.min(0.5, s.scrape / 40) : 0, 0.05);
    const st = this.voice('stall'); this.set(st.out.gain, s.stall ? STALL_HORN : 0, s.stall ? 0.03 : 0.1); // continuous while stalled, like the real reed
    const recRain = this.bedGain('rain', this.amb, s.rain * REC.rain * (s.cockpit ? 1.4 : 1), 0.4);
    const rn = this.voice('rain'); this.set(rn.out.gain, recRain ? 0 : s.rain * 0.13 * (s.cockpit ? 1.6 : 1), 0.3);
    this.ambience(s.amb, s.listener?.pos);
    this.airframe(s);
    if ('music' in s) this.setTrack(s.music, s.music ? MUSIC[s.music] : 0, s.music ? 4 : 2.5);
  }

  updateSampled(v, e, s, dop, multi) {
    const kind = e.sound, rr = RPM_RANGE[kind];
    const n = rr ? Math.min(1, Math.max(0, (e.rpm - rr[0]) / (rr[1] - rr[0]))) : e.spoolT;
    const running = kind === 'rocket' ? e.burning : rr ? e.rpm > 50 : true;
    const x = smooth(0.2, 0.8, n), hasCabin = v.layers.some((l) => l.role === 'cabin');
    const inside = s.cockpit && hasCabin ? 1 : 0;
    // turbines are directional: compressor whine radiates forwards, exhaust roar backwards (c: +1 listener in front, -1 behind)
    const c = e.fwd && e.toListener && !s.cockpit ? e.fwd.x * e.toListener.x + e.fwd.y * e.toListener.y + e.fwd.z * e.toListener.z : 0;
    const turb = (kind === 'jet' || kind === 'fan' || kind === 'rocket') && !s.cockpit;
    const front = turb ? 0.7 + 0.6 * Math.max(0, c) : 1, rear = turb ? 0.65 + 0.35 * Math.max(0, -c) - 0.25 * Math.max(0, c) : 1;
    for (const l of v.layers) {
      let g = 0;
      if (l.role === 'idle') g = Math.cos(x * Math.PI / 2) * (1 - inside) * front;
      else if (l.role === 'high') g = (kind === 'rocket' ? 1 : Math.sin(x * Math.PI / 2)) * (1 - inside) * rear;
      else if (l.role === 'cabin') g = inside * (v.layers.some((q) => q.role === 'cabinIdle') ? Math.sin(x * Math.PI / 2) : 1);
      else if (l.role === 'cabinIdle') g = inside * Math.cos(x * Math.PI / 2);
      else if (l.role === 'ab') g = e.ab ? 1.1 * rear : 0;
      this.set(l.g.gain, g, l.role === 'ab' ? 0.12 : 0.08);
      this.set(l.src.playbackRate, (l.rate[0] + (l.rate[1] - l.rate[0]) * n) * dop * (v.rateMul ?? 1), 0.05);
    }
    // overall level grows with power; balanced by measurement against the synth targets (≈-24 dB props, -26 jets at full)
    const lvl = (SAMPLE_LEVEL[kind] || 1) * (0.32 + 0.68 * n) * multi * (v.lvlMul ?? 1);
    this.set(v.out.gain, running ? lvl : 0, kind === 'rocket' ? 0.05 : 0.1);
    if (kind === 'piston' || kind === 'radial') { // throttle chop at speed -> exhaust pops
      if ((v.lastThr ?? 0) - e.spoolT > 0.25 && e.rpm > 1500) for (let k = 0; k < 4; k++) this.burst('crackle', 'bandpass', 600, 1, 0.5, 0.15, this.engBus, k * 0.12 + Math.random() * 0.1);
      v.lastThr = e.spoolT;
    }
  }

  // ---------- engine start / shutdown ----------
  // main.js decides when the engines start (first throttle-up on a ground start) and stop (parked at idle). Every engine voice
  // has a `seq` gain stage in front of its 3D chain. The start recording plays into that same chain (so it is placed, delayed and
  // muffled like the engine), then the running voice fades in under it from a low catch pitch, so the recording hands over smoothly.
  // States per sound kind: 'off' (silent) -> 'start' -> 'on' -> 'stop' -> 'off'. Kinds without an entry use engDef.
  engState(kind) { return this.engSeq?.[kind]?.mode ?? this.engDef ?? 'on'; }
  seqGain(kind) { return this.engState(kind) === 'off' ? 0 : 1; }
  // new flight: engines already running (air start, approach) or off (on the runway / water)
  engineReset(on) {
    this.engSeq = {}; this.engDef = on ? 'on' : 'off';
    if (this.ctx) for (const k in this.voices) { const v = this.voices[k]; if (v.seq) { v.seq.gain.cancelScheduledValues(this.ctx.currentTime); v.seq.gain.value = on ? 1 : 0; } }
  }
  // play the start sequence for these sound kinds; returns how long (s) the throttle should wait for the engine to catch
  engineStart(kinds) {
    if (!this.ctx) return 0;
    this.engSeq ||= {};
    let hold = 0;
    for (const kind of kinds) {
      const d = ENG_SEQ[kind], st = this.engState(kind);
      if (!d || (st !== 'off' && st !== 'stop')) { this.engSeq[kind] = { mode: 'on' }; continue; } // rockets, electric: instant
      const v = this.voice(kind), now = this.ctx.currentTime, g = v.seq.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(0, now); g.setValueAtTime(0, now + d.blend[0]); g.linearRampToValueAtTime(1, now + d.blend[1]);
      if (!this.shot(d.clip, { gain: d.gain, rate: d.rate, dest: v.air })) this.synthStart(d, v.air);
      if (d.coughs) for (const t of d.coughs) this.burst('crackle', 'bandpass', 380 + Math.random() * 200, 0.8, 0.9, 0.22, v.air, t + Math.random() * 0.08);
      this.engSeq[kind] = { mode: 'start', t0: now };
      hold = Math.max(hold, d.catch + 0.6);
    }
    return hold;
  }
  engineStop(kinds) {
    if (!this.ctx) return;
    this.engSeq ||= {};
    for (const kind of kinds) {
      const d = ENG_SEQ[kind], st = this.engState(kind);
      if (st === 'off' || st === 'stop') continue;
      const v = this.voices[kind]; if (!d || !v?.seq) { this.engSeq[kind] = { mode: 'off' }; continue; }
      const now = this.ctx.currentTime, g = v.seq.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + d.stopFade);
      if (!this.shot(d.stop, { gain: d.stopGain, rate: d.rate, dest: v.air }) && !d.prop) this.sweep('sine', 2200, 180, 0.05, 0.05, 0.5, 3.5, v.air);
      // props: a few last chuffs as it stops turning
      if (d.prop) [0.35, 0.8, 1.4].forEach((t, i) => this.burst('brown', 'lowpass', 260, 1, 0.9 / (i + 1), 0.25, v.air, t * (1 / d.rate) + Math.random() * 0.06));
      this.engSeq[kind] = { mode: 'stop', t0: now };
    }
  }
  // per frame, per engine: keep the voice gated and bend its pitch through the sequence; returns the engine state to voice
  seqTick(v, e) {
    v.rateMul = v.dmgR ?? 1;
    const kind = e.sound, q = this.engSeq?.[kind], mode = q?.mode ?? this.engDef ?? 'on', d = ENG_SEQ[kind];
    if (!v.seq) return e;
    if (!d) { this.set(v.seq.gain, mode === 'off' ? 0 : v.dmgG ?? 1, 0.03); return e; } // rockets/electric: no sequence (also opens a voice created while 'off')
    if (mode === 'on' || mode === 'off') { this.set(v.seq.gain, mode === 'on' ? v.dmgG ?? 1 : 0, 0.03); return e; }
    const t = this.ctx.currentTime - q.t0, rr = RPM_RANGE[kind];
    if (mode === 'start') {
      if (t > d.blend[1] + 0.2) { q.mode = 'on'; return e; }
      // props catch low and flare a little before settling; turbines come up from a slow spool
      const u = Math.min(1, Math.max(0, (t - d.blend[0]) / (d.blend[1] - d.blend[0])));
      v.rateMul = d.prop ? (u < 0.5 ? 0.75 + 0.7 * u : 1.1 - 0.2 * (u - 0.5)) : 0.6 + 0.4 * u;
      return e;
    }
    // stop: keep the voice "running" at idle while its pitch winds down and the seq gain fades it out
    if (t > d.stopDur) { q.mode = 'off'; this.set(v.seq.gain, 0, 0.05); return e; }
    v.rateMul = 1 - (d.prop ? 0.55 : 0.6) * Math.min(1, t / d.stopFade);
    return { ...e, rpm: Math.max(e.rpm, rr ? rr[0] : 0), spoolT: 0, ab: false };
  }
  // synthesized start when the recording isn't loaded
  synthStart(d, dest) {
    if (d.prop) { // starter grind: compression chugs + starter motor whine, then it fires
      for (let t = 0; t < d.catch; t += 0.14) this.burst('brown', 'lowpass', 320, 1, 0.7, 0.1, dest, t);
      this.sweep('sawtooth', 150, 230, 0.03, 0.15, d.catch - 0.3, 0.2, dest);
      for (let k = 0; k < 4; k++) this.burst('crackle', 'bandpass', 500, 0.8, 0.8, 0.2, dest, d.catch + k * 0.12);
    } else { // turbine: starter whine and a rising spool, then the light-off rumble
      this.sweep('sine', 250, 2400, 0.05, d.catch, 1, 1, dest);
      this.burst('white', 'bandpass', 200, 0.6, 0.4, d.catch + 1, dest, 0, 1200);
      this.burst('brown', 'lowpass', 220, 0.7, 1.4, 1.8, dest, d.catch);
    }
  }
  sweep(type, f0, f1, peak, a, hold, r, dest = this.fx, delay = 0) {
    const o = this.ctx.createOscillator(); o.type = type; const g = this.gain(0); o.connect(g); g.connect(dest);
    const t = this.ctx.currentTime + delay, T = a + hold + r;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + T);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setValueAtTime(peak, t + a + hold); g.gain.linearRampToValueAtTime(0, t + T);
    o.start(t); o.stop(t + T + 0.05);
  }

  // ---------- ground surfaces: recorded rolling per surface, float/water taxiing, bumps on rough ground ----------
  // s.surface: world.groundAt().type ('runway'|'grass'|'sand'|'rock'|'snow'|'water'); s.gear: 'wheel'|'float'|'skid' (what touches).
  // Returns false if the clip for this surface isn't loaded (the caller keeps the synth rumble).
  groundSurface(s, amt) {
    const surf = s.surface, gs = s.groundSpeed || 0, water = surf === 'water', on = s.onGround;
    const want = water ? null : GROUND.bed[surf] || 'roll_grass';
    const rate = (GROUND.rate[surf] || 1) * (0.6 + Math.min(gs, 60) / 100);
    // tyre/hull rumble below ~160 Hz is inaudible on a tablet but was pushing the limiter (-3 dB on the runway): shelve it off
    if (!this.rollBus) { this.rollBus = this.gain(1); const ls = this.ctx.createBiquadFilter(); ls.type = 'lowshelf'; ls.frequency.value = 160; ls.gain.value = -9; this.rollBus.connect(ls); ls.connect(this.airBus); }
    // a bed is only created (and starts looping) the first time it's needed
    const bed = (name, v, t, r) => (!this.has(name) ? false : v <= 0 && !this.beds?.[name] ? true : this.bedGain(name, this.rollBus, v, t, r));
    let ok = true;
    for (const name of ['roll_runway', 'roll_grass', 'roll_dirt', 'roll_snow']) {
      const r = bed(name, name === want ? amt * GROUND.level[name] : 0, 0.06, name === want ? rate : undefined);
      if (name === want && !r) ok = false;
    }
    // on the water: hull/float swish grows with speed; small waves slapping the floats even when stopped
    const wAmt = on && water ? Math.min(1, gs / 18) : 0;
    const slap = on && water ? 0.45 + 0.55 * Math.min(1, gs / 6) - 0.5 * Math.min(1, Math.max(0, gs - 12) / 20) : 0;
    const okW = bed('water_taxi', wAmt * GROUND.level.water_taxi, 0.1, 0.75 + Math.min(gs, 40) / 80) & bed('float_slap', slap * GROUND.level.float_slap, 0.3, 0.9 + Math.min(gs, 20) / 100);
    if (water) ok = !!okW;
    // bumps: random knocks through the gear on rough ground, more often the faster you go
    const now = this.ctx.currentTime, dt = Math.min(0.1, now - (this.bumpT ?? now)); this.bumpT = now;
    const rough = on && !water ? GROUND.rough[surf] ?? 0.4 : 0;
    if (rough && gs > 2 && Math.random() < rough * Math.min(1, gs / 15) * 3.5 * dt) {
      const k = 1 + Math.floor(Math.random() * 3), p = Math.min(1, 0.35 + gs / 25) * (0.6 + Math.random() * 0.4);
      this.shot(`bump_${k}`, { gain: GROUND.bump * p * (s.gear === 'wheel' ? 1 : 0.6), rate: (s.gear === 'wheel' ? 0.9 : 0.75) + Math.random() * 0.3, dest: this.rollBus });
    }
    return ok;
  }

  // ---------- damage: misfires, engine fire, airframe creaks, rattles ----------
  // engines past 30 % damage stumble: short dips in the voice's gain and pitch with backfire pops (or a turbine's
  // compressor-stall bang), more often and deeper as the damage grows. Sets v.dmgG / v.dmgR for seqTick to apply.
  engineDamage(v, e) {
    v.dmgG = 1; v.dmgR = 1;
    const f = Math.min(1, Math.max(0, ((e.dmg || 0) - 0.3) / 0.6)); // 0 at 30 % damage, 1 at 90 %
    if (f <= 0 || !v.air || e.sound === 'rocket' || !(e.spoolT > 0.03 || e.rpm > 50)) { v.mis = null; return; }
    const now = this.ctx.currentTime, dt = Math.min(0.1, now - (v.dmgT ?? now)); v.dmgT = now;
    if (v.mis && now < v.mis.end) { v.dmgG = v.mis.g; v.dmgR = v.mis.r; return; }
    if (Math.random() >= (0.5 + 3.5 * f) * dt) return;
    const prop = !['jet', 'fan', 'rotor'].includes(e.sound);
    v.mis = { end: now + 0.06 + Math.random() * (0.1 + 0.25 * f), g: 1 - (0.3 + 0.5 * f) * (0.5 + 0.5 * Math.random()), r: 1 - (prop ? 0.03 + 0.07 * f : 0.04 * f) * Math.random() };
    v.dmgG = v.mis.g; v.dmgR = v.mis.r;
    if (Math.random() < 0.35 + 0.5 * f) {
      if (prop) for (let k = 0, n = 1 + Math.floor(Math.random() * 3); k < n; k++) this.burst('white', 'bandpass', 500 + Math.random() * 600, 0.8, DMG.pop, 0.05, v.air, 0.03 + k * (0.05 + Math.random() * 0.07));
      else this.burst('brown', 'lowpass', 400, 0.7, DMG.pop * 2.5, 0.25, v.air, 0.02);
    }
  }
  // a wing has been overloaded for a moment (aircraft 'strain' event, the "Ease off!" warning): a deep structural groan
  // with a creak on top, louder than the ordinary high-G creaks so it reads as "something is about to give"
  strain(pos, cockpit) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, d = cockpit ? this.fx : this.dest(pos), k = cockpit ? 1 : 0.7;
    if (!this.shot('groan', { gain: DMG.strain * k, rate: 0.8 + Math.random() * 0.1, dest: d })) this.tone('sawtooth', 110, 70, 0.03, 1.2, 0, d);
    this.shot(`creak_${1 + Math.floor(Math.random() * 3)}`, { gain: DMG.creak * 0.8 * k, rate: 0.9 + Math.random() * 0.2, dest: d, delay: 0.25 + Math.random() * 0.2 });
    this.creakT = now + 2.5; // the ordinary G creaks hold off for a moment
  }
  // s.fire {amt, pos}: a burning engine; s.g: load factor; s.rattle: worst damage fraction of a part still attached; s.acPos
  airframe(s) {
    const now = this.ctx.currentTime, ck = !!s.cockpit, fire = s.fire?.amt || 0;
    // fire: a recorded crackling loop, placed at the burning engine
    if (!this.firePan) { this.firePan = this.panner(); this.firePan.refDistance = 15; this.firePan.connect(this.fx); }
    if (s.fire?.pos) this.placeVoice({ pan: this.firePan }, s.fire.pos);
    if (!this.bedGain('fire_loop', this.firePan, fire * DMG.fire * (ck ? 0.7 : 1), 0.4) && fire > 0 && Math.random() < 0.25) this.burst('crackle', 'highpass', 700, 0.7, 0.4 * fire, 0.4, this.firePan);
    // high G: the airframe creaks and groans (recorded metal stress), with a cooldown so it never chatters
    const g = Math.abs(s.g || 0);
    if (g > 4 && now > (this.creakT ?? 0) && Math.random() < 0.05 + 0.05 * (g - 4)) {
      const big = g > 6.5 && Math.random() < 0.5, k = Math.min(1, (g - 4) / 4);
      const d = ck ? this.fx : this.dest(s.acPos); // inside you hear your own airframe; outside it comes from the plane
      if (!this.shot(big ? 'groan' : `creak_${1 + Math.floor(Math.random() * 3)}`, { gain: DMG.creak * (0.5 + 0.5 * k) * (ck ? 1 : 0.6), rate: 0.85 + Math.random() * 0.3, dest: d }))
        this.tone('sawtooth', 160 + Math.random() * 80, 120, 0.02, 0.8, 0, d);
      this.creakT = now + 1.5 + Math.random() * 2.5;
    }
    // damaged but still attached: rattles, and a flutter that speeds up with airspeed
    const r = Math.min(1, Math.max(0, ((s.rattle || 0) - 0.25) / 0.5)) * smooth(20, 90, s.airspeed || 0);
    this.bedGain('rattle_loop', this.fx, r * DMG.rattle * (ck ? 1 : 0.6), 0.2, 0.8 + Math.min(s.airspeed || 0, 200) / 300);
    let fl = this.voices.flutter;
    if (!fl && r > 0) {
      fl = this.voices.flutter = { kind: 'flutter', out: this.gain(0) }; fl.out.connect(this.fx);
      const n = this.noise('brown'), bp = this.filt('bandpass', 220, 1.2), am = this.gain(0.5); fl.lfo = this.osc('square', 14); const lg = this.gain(0.5);
      n.connect(bp); bp.connect(am); fl.lfo.connect(lg); lg.connect(am.gain); am.connect(fl.out);
    }
    if (fl) { this.set(fl.out.gain, r * DMG.flutter * (ck ? 1 : 0.6), 0.2); this.set(fl.lfo.frequency, 8 + Math.min(s.airspeed || 0, 200) / 8, 0.2); }
  }

  // ---------- sonic boom ----------
  // An N-wave: the pressure jumps up at the bow shock, falls steadily, and snaps back at the tail shock, so it is heard as two
  // sharp cracks 0.14 s apart ("ba-BOOM", the same gap as the two visible shock rings), followed by a recorded rolling rumble
  // (Falcon 9 landing boom, Freesound 668561). `delay`: seconds until it reaches the listener (distance / 343).
  // In the cockpit the pilot never hears their own boom, only a muffled thump through the airframe.
  sonicBoom(P = 1, pos = null, delay = 0, cockpit = false) {
    if (!this.ctx) return;
    if (!this.nwave) {
      const sr = this.ctx.sampleRate, T = 0.14, len = Math.floor(sr * (T + 0.05)), b = this.ctx.createBuffer(1, len, sr), x = b.getChannelData(0), rise = sr * 0.0006;
      for (let i = 0; i < len; i++) { const t = i / sr; x[i] = t < T ? 1 - (2 * t) / T : -Math.exp(-(t - T) * 900); }
      for (let i = 0; i < rise; i++) x[i] *= i / rise; // ~0.6 ms shock rise: sharp, but not a digital click
      this.nwave = b;
    }
    const t0 = this.ctx.currentTime + Math.max(0, delay), keep = (Math.max(0, delay) + 6) * 1000;
    let d;
    if (cockpit) { d = this.filt('lowpass', 220, 0.7); d.connect(this.fx); }
    else {
      d = this.panner(); d.refDistance = 400; d.rolloffFactor = 0.8; // a boom carries for miles
      if (pos) { if (d.positionX) { d.positionX.value = pos.x; d.positionY.value = pos.y; d.positionZ.value = pos.z; } else d.setPosition(pos.x, pos.y, pos.z); }
      d.connect(this.fx);
    }
    setTimeout(() => d.disconnect(), keep);
    const src = this.ctx.createBufferSource(); src.buffer = this.nwave;
    // its bass is mostly what a tablet can't play but would slam the limiter: keep the cracks, shelve off the body (except the cockpit thump)
    const hp = this.filt('highpass', cockpit ? 40 : 280, 0.7), hp2 = this.filt('highpass', cockpit ? 40 : 280, 0.7), g = this.gain(BOOM.crack * P * (cockpit ? BOOM.cockpit : 1));
    src.connect(hp); hp.connect(hp2); hp2.connect(g); g.connect(d); src.start(t0); src.onended = () => g.disconnect();
    // the rolling rumble after it (fades out over its last second)
    const rb = this.buffers.sonic_rumble;
    if (rb) {
      const r = this.ctx.createBufferSource(); r.buffer = rb; r.playbackRate.value = 0.9 + Math.random() * 0.15;
      const rg = this.gain(0), L = rb.duration / r.playbackRate.value, v = BOOM.rumble * P * (cockpit ? BOOM.cockpit : 1);
      rg.gain.setValueAtTime(v, t0); rg.gain.setValueAtTime(v, t0 + L - 1.2); rg.gain.linearRampToValueAtTime(0, t0 + L);
      const rh = this.filt('highpass', cockpit ? 40 : 110, 0.7); r.connect(rh); rh.connect(rg); rg.connect(d); r.start(t0); r.onended = () => rg.disconnect();
    } else this.burst('brown', 'lowpass', 300, 0.5, 0.9 * P, 2.2, d, Math.max(0, delay) + 0.05, 60);
  }

  // ---------- helicopter rotor ----------
  // The recorded idle / hover / cabin loops (SAMPLE_ENGINES.rotor) follow rotor speed; on top of them, synthesized:
  // blade-slap "whop" pulses at the blade-pass rate (louder and slappier under collective and when heard from the side),
  // the turbine whine underneath, and the tail rotor's buzz.
  rotorTick(v, e, s, multi) {
    if (!v.whop) this.rotorParts(v);
    const sp = Math.min(1, Math.max(0, e.spoolT)), turning = smooth(0.03, 0.45, sp);
    const load = Math.min(1, Math.max(0, ((e.load ?? 0.5) - 0.25) / 0.45)); // collective: ≈0.5 in a hover, 1 climbing hard, 0 descending
    const rr = RPM_RANGE.rotor, n = Math.min(1, Math.max(0, (e.rpm - rr[0]) / (rr[1] - rr[0])));
    // blade-pass rate: the hover recording is a 4-blade UH-60 (17.2 Hz at its own speed), so the synthesized whop follows the
    // same playback rate to stay in step with it; four-blade rotors run it a bit faster
    if ((e.blades || 2) > 2) v.rateMul *= 1.25;
    const hr = SAMPLE_ENGINES.rotor.high, bp = Math.max(0.5, 17.2 * (hr[1] + (hr[2] - hr[1]) * n) * v.rateMul * sp);
    // side-on (level with the disc, off to the side) is where blade slap carries most; never inside the cabin
    let side = 0;
    if (!s.cockpit && e.fwd && e.toListener) { const c = e.fwd.x * e.toListener.x + e.fwd.y * e.toListener.y + e.fwd.z * e.toListener.z; side = Math.sqrt(Math.max(0, 1 - c * c)) * (1 - Math.abs(e.toListener.y) * 0.5); }
    // the recorded rotor: nearly silent while the blades are stopped, a little louder under load
    v.lvlMul = (0.15 + 0.85 * turning * (0.75 + 0.5 * load)) * (s.cockpit ? 0.6 : 1); // the cabin recording is close-miked: trimmed to match
    // the synthesized parts share v.out with the recorded layers (so silence() and the 3D chain cover them): undo its level
    const k = v.sampled ? 1 / Math.max(0.05, SAMPLE_LEVEL.rotor * (0.32 + 0.68 * n) * v.lvlMul) : 1;
    if (!v.sampled) this.set(v.out.gain, 1, 0.1);
    this.set(v.whopOsc.frequency, bp, 0.05);
    this.set(v.whop.gain, turning * (0.15 + 0.85 * load * load) * (0.45 + 0.55 * side) * (s.cockpit ? 0.35 : 1) * ROTOR.whop * k, 0.12);
    this.set(v.whopBand.frequency, 300 + 500 * load, 0.2);
    this.set(v.whine.frequency, 4200 + 1800 * sp, 0.2); this.set(v.whine2.frequency, (4200 + 1800 * sp) * 1.51, 0.2);
    this.set(v.whineG.gain, ROTOR.whine * (0.35 + 0.65 * sp) * k, 0.2);
    this.set(v.tailOsc.frequency, Math.max(15, (e.rpm / 60) * sp * 2), 0.05);
    this.set(v.tailG.gain, e.tail ? ROTOR.tail * turning * (0.5 + 0.5 * load) * k : 0, 0.15);
  }
  rotorParts(v) {
    // a narrow pulse train (cosine series with coherent phases, so it is a pulse, not a buzz) shapes noise into "whop"s
    const N = 32, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) re[n] = Math.exp(-(n * n) / 16);
    let mx = -1e9, mn = 1e9; for (let i = 0; i < 256; i++) { let x = 0; for (let n = 1; n < N; n++) x += re[n] * Math.cos((2 * Math.PI * n * i) / 256); mx = Math.max(mx, x); mn = Math.min(mn, x); }
    v.whopOsc = this.osc(null, 10, this.ctx.createPeriodicWave(re, im));
    const am = this.gain(-mn / mx); v.whopOsc.connect(am.gain); // offset so the gaps between pulses are silent
    const n1 = this.noise(); v.whopBand = this.filt('bandpass', 450, 0.9); n1.connect(v.whopBand); v.whopBand.connect(am);
    const n2 = this.noise('brown'), lp = this.filt('lowpass', 170, 0.8), g2 = this.gain(1.6); n2.connect(lp); lp.connect(g2); g2.connect(am);
    v.whop = this.gain(0); am.connect(v.whop); v.whop.connect(v.out);
    v.whine = this.osc('sine', 4200); v.whine2 = this.osc('sine', 6300); v.whineG = this.gain(0); const w2 = this.gain(0.4);
    v.whine.connect(v.whineG); v.whine2.connect(w2); w2.connect(v.whineG); v.whineG.connect(v.out);
    v.tailOsc = this.osc('sawtooth', 60); const tf = this.filt('bandpass', 520, 1.4); v.tailG = this.gain(0); v.tailOsc.connect(tf); tf.connect(v.tailG); v.tailG.connect(v.out);
  }

  // ---------- ambient world sounds ----------
  ambience(a, lp) {
    if (!a) return;
    this.setSpace(a.loc);
    const low = Math.max(0, 1 - a.agl / 250);
    if (!this.surf) {
      this.surf = this.gain(0); const n = this.noise('brown'), f = this.filt('lowpass', 700, 0.5), sw = this.gain(0.6), lfo = this.osc('sine', 0.09), lg = this.gain(0.4);
      n.connect(f); f.connect(sw); sw.connect(this.surf); lfo.connect(lg); lg.connect(sw.gain); this.surf.connect(this.amb);
      const h = this.noise(), hf = this.filt('highpass', 2500, 0.3), hg = this.gain(0.15); h.connect(hf); hf.connect(hg); hg.connect(sw);
      this.crickets = this.gain(0); const c = this.osc('sine', 4300), am = this.gain(0), l1 = this.osc('square', 28), l1g = this.gain(0.5), l2 = this.osc('square', 0.7), l2g = this.gain(0.5);
      l1.connect(l1g); l1g.connect(am.gain); l2.connect(l2g); l2g.connect(am.gain); c.connect(am); am.connect(this.crickets); this.crickets.connect(this.amb);
    }
    const near = a.waterNear || 0; // surf only where there is water nearby (sea surf on the islands, gentle lapping on lakes/rivers)
    const sea = a.loc === 'islands';
    const recSea = this.bedGain('amb_sea', this.amb, sea ? near * near * REC.sea : 0, 0.8) & this.bedGain('amb_lake', this.amb, sea ? 0 : near * near * REC.lake, 0.8);
    this.set(this.surf.gain, recSea ? 0 : near * near * (sea ? 0.45 : 0.14), 0.5);
    const recNight = this.bedGain('amb_night', this.amb, a.night ? low * REC.night : 0, 1);
    this.set(this.crickets.gain, a.night && !recNight ? low * 0.025 : 0, 1);
    this.bedGain('amb_day', this.amb, a.day ? low * REC.day : 0, 1); // meadow: insects and distant birds near the ground
    // birdsong: occasional procedural chirps placed around the listener
    if (a.day && low > 0.2 && Math.random() < 0.02 * low) this.bird(sea, lp);
  }
  bird(gull, lp) {
    const t = this.ctx.currentTime;
    const pan = this.panner(); pan.refDistance = 20;
    if (lp) { const ang = Math.random() * Math.PI * 2, d = 30 + Math.random() * 80; if (pan.positionX) { pan.positionX.value = lp.x + Math.cos(ang) * d; pan.positionY.value = lp.y + 10; pan.positionZ.value = lp.z + Math.sin(ang) * d; } }
    pan.connect(this.amb);
    const notes = gull ? 2 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 6);
    const base = gull ? 900 + Math.random() * 300 : 2600 + Math.random() * 2400;
    for (let i = 0; i < notes; i++) {
      const o = this.ctx.createOscillator(), g = this.gain(0); o.type = gull ? 'sawtooth' : 'sine';
      const f = gull ? this.filt('bandpass', 1400, 3) : null;
      o.connect(f || g); if (f) f.connect(g); g.connect(pan);
      const s0 = t + i * (gull ? 0.38 : 0.09 + Math.random() * 0.05), dur = gull ? 0.32 : 0.05 + Math.random() * 0.05;
      const f0 = base * (gull ? 1.2 : 1 + Math.random() * 0.3), f1 = base * (gull ? 0.7 : 1.2 + Math.random() * 0.5);
      o.frequency.setValueAtTime(f0, s0); o.frequency.exponentialRampToValueAtTime(f1, s0 + dur);
      g.gain.setValueAtTime(0.0001, s0); g.gain.linearRampToValueAtTime(gull ? 0.05 : 0.04, s0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, s0 + dur);
      o.start(s0); o.stop(s0 + dur + 0.05);
    }
  }
  silence() { if (!this.ctx) return; for (const k in this.voices) this.set(this.voices[k].out.gain, 0, 0.05); if (this.surf) { this.set(this.surf.gain, 0, 0.1); this.set(this.crickets.gain, 0, 0.1); } for (const k in this.beds || {}) this.set(this.beds[k].g.gain, 0, 0.1); }

  // ---------- one-shots ----------
  dest(pos) {
    if (!pos || !this.ctx) return this.fx;
    const p = this.panner(); p.refDistance = 25;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.fx); setTimeout(() => p.disconnect(), 8000);
    return p;
  }
  burst(type, filter, f, Q, peak, dur, dest = this.fx, delay = 0, fEnd = null) {
    const n = this.ctx.createBufferSource(); n.buffer = type === 'brown' ? this.brown : type === 'crackle' ? this.crackle : this.white;
    const fl = this.filt(filter, f, Q), g = this.gain(0);
    n.connect(fl); fl.connect(g); g.connect(dest);
    const t = this.ctx.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    n.start(t, Math.random()); n.stop(t + dur + 0.1);
    return fl;
  }
  tone(type, f0, f1, peak, dur, delay = 0, dest = this.fx) {
    const o = this.ctx.createOscillator(); o.type = type; const g = this.gain(0); o.connect(g); g.connect(dest);
    const t = this.ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  }
  crunch(P, d, len = 0.35) { // metal: many short resonant grains
    for (let i = 0; i < 10; i++) this.burst('white', 'bandpass', 300 + Math.random() * 3200, 6 + Math.random() * 20, 0.35 * P, 0.08 + Math.random() * 0.3, d, Math.random() * len);
  }
  clatter(P, d, n = 12, len = 1.4) { // debris bouncing
    for (let i = 0; i < n; i++) { const t = Math.random() ** 0.7 * len; this.burst('white', 'bandpass', 1500 + Math.random() * 4000, 8, 0.18 * P * (1 - t / len), 0.05, d, t); this.tone('triangle', 900 + Math.random() * 2500, 700, 0.04 * P, 0.12, t, d); }
  }
  play(name, p = 1, pos = null) {
    if (!this.ctx) return;
    if (name in WS_FALLBACK) { if (this.workshop(name)) return; name = WS_FALLBACK[name]; }
    if (name === 'explosion' || (name === 'impact' && p >= 1.5)) this.duck(DUCK.crash, name === 'explosion' ? 2.5 : 1.2); // let the crash land, then the music comes back
    const P = Math.min(2, p), d = this.dest(pos);
    switch (name) {
      // recorded where we have it (vary pitch so repeats don't sound identical); synthesis as the fallback
      case 'impact':
        this.tone('sine', 90, 35, 0.6 * P, 0.4, 0, d); // body thump
        if (this.shot('crash_metal', { gain: SHOT.crash * P, rate: 0.8 + Math.random() * 0.4, dest: d })) { if (P > 0.6) this.shot('debris_small', { gain: SHOT.debris * P, rate: 0.9 + Math.random() * 0.25, dest: d, delay: 0.12 }); break; }
        this.burst('brown', 'lowpass', 400, 0.7, 0.9 * P, 0.4 + P * 0.3, d); this.crunch(P, d); if (P > 0.6) this.clatter(P, d, 8);
        break;
      case 'crack': this.burst('white', 'highpass', 2000, 0.7, (this.has('debris_small') ? 0.25 : 0.8) * P, 0.12, d);
        if (this.shot('debris_small', { gain: SHOT.debris * P, rate: 1 + Math.random() * 0.3, dest: d })) break;
        this.crunch(P * 0.8, d, 0.15); this.tone('triangle', 900, 120, 0.2 * P, 0.4, 0, d); this.clatter(P, d, 10, 1.8); break;
      case 'glass': if (this.shot('glass', { gain: SHOT.glass, rate: 0.9 + Math.random() * 0.25, dest: d })) break;
        for (let i = 0; i < 18; i++) { this.burst('white', 'bandpass', 4000 + Math.random() * 6000, 12, 0.25, 0.05 + Math.random() * 0.25, d, Math.random() * 0.4); this.tone('sine', 3000 + Math.random() * 5000, 2500, 0.03, 0.3, Math.random() * 0.5, d); } break;
      case 'explosion':
        if (this.shot('explosion', { gain: SHOT.explosion, rate: 0.85 + Math.random() * 0.2, dest: d })) {
          this.shot('boom', { gain: SHOT.boom, rate: 0.8 + Math.random() * 0.2, dest: d }); this.shot('debris_big', { gain: SHOT.debris, dest: d, delay: 0.35 }); break;
        }
        this.tone('sine', 70, 22, 1.6, 2.2, 0, d); this.burst('brown', 'lowpass', 260, 0.5, 2.0, 4.0, d, 0, 60); this.burst('white', 'lowpass', 2400, 0.5, 1.0, 1.4, d, 0, 300);
        for (let i = 0; i < 10; i++) this.burst('crackle', 'highpass', 500, 0.7, 0.8, 0.5, d, 0.1 + Math.random() * 2);
        this.clatter(1.4, d, 20, 3.5);
        break;
      case 'chirp': this.burst('brown', 'lowpass', 180, 1, 0.6 * P, 0.25);
        if (this.shot('tyre_chirp', { gain: SHOT.chirp * P, rate: 0.95 + Math.random() * 0.2 })) break;
        this.burst('white', 'bandpass', 2600, 4, 0.22 * P, 0.12, this.fx, 0, 1700); this.burst('white', 'bandpass', 2300, 4, 0.18 * P, 0.1, this.fx, 0.07, 1600); break;
      case 'splash': if (this.shot('splash', { gain: SHOT.splash * P, rate: 0.85 + Math.random() * 0.3, dest: d })) break;
        this.burst('white', 'lowpass', 3000, 0.5, 0.7 * P, 1.3, d, 0, 500); this.burst('brown', 'lowpass', 300, 1, 0.7 * P, 0.9, d); for (let i = 0; i < 8; i++) this.burst('white', 'bandpass', 1500 + Math.random() * 3000, 4, 0.15 * P, 0.1, d, 0.2 + Math.random() * 0.8); break;
      case 'gear': { // lever click in the cockpit, motor whine, then a clunk into the locks
        const lv = this.lever('sw_gear', SHOT.lever, 0.18);
        const rec = this.shot('gear_motor', { gain: SHOT.gear, delay: lv }), lock = (rec ? 3.6 : 2.7) + lv;
        if (!rec) { this.tone('sawtooth', 140, 210, 0.04, 2.6, lv, this.fx); this.burst('white', 'bandpass', 900, 3, 0.05, 2.6, this.fx, lv); }
        this.tone('sine', 70, 40, 0.5, 0.25, lock); this.burst('brown', 'lowpass', 500, 1, 0.5, 0.3, this.fx, lock); this.burst('white', 'bandpass', 2500, 8, 0.15, 0.08, this.fx, lock + 0.02);
        break;
      }
      case 'flaps': { const lv = this.lever('sw_flaps', SHOT.lever * 1.27, 0.12); this.tone('sawtooth', 220, 260, 0.025, 1.2, lv); this.burst('white', 'bandpass', 1200, 4, 0.03, 1.2, this.fx, lv); this.tone('sine', 120, 80, 0.12, 0.12, 1.2 + lv); break; }
      case 'thunder': {
        if (this.shot(`thunder_${1 + Math.floor(Math.random() * 3)}`, { gain: SHOT.thunder * (0.5 + P * 0.5), rate: 0.85 + Math.random() * 0.25 })) break;
        this.burst('white', 'highpass', 1500, 0.5, 0.5 * P, 0.25); this.burst('white', 'lowpass', 3000, 0.5, 0.6 * P, 0.7, this.fx, 0.02, 400);
        for (let i = 0; i < 4; i++) this.burst('brown', 'lowpass', 500, 0.5, (0.9 + Math.random() * 0.6) * (0.5 + P), 3 + Math.random() * 4, this.fx, i * (0.3 + Math.random() * 0.8), 60);
        break;
      }
      case 'bird': // bird strike: a thwack, then the rest of the flock scattering
        if (this.shot('bird_strike', { gain: SHOT.strike, rate: 0.9 + Math.random() * 0.2, dest: d })) { this.shot('bird_flock', { gain: SHOT.strike * 0.35, rate: 1.05, dest: d, delay: 0.05 }); break; }
        this.tone('sine', 2400, 3800, 0.08, 0.12, 0, d); this.tone('sine', 2800, 4200, 0.06, 0.1, 0.15, d); this.burst('white', 'bandpass', 600, 2, 0.6, 0.3, d); break;
      case 'click': this.tone('triangle', 1700, 1100, 0.07, 0.05); this.burst('white', 'highpass', 4000, 1, 0.05, 0.02); break;
      case 'clank': this.tone('triangle', 620 + Math.random() * 80, 600, 0.12, 0.6); this.tone('sine', 1500, 1450, 0.05, 0.7); this.tone('sine', 2310, 2300, 0.025, 0.5); this.burst('white', 'bandpass', 3000, 2, 0.12, 0.05); this.tone('sine', 90, 60, 0.25, 0.15); break;
      case 'pop': this.tone('sine', 400, 900, 0.1, 0.08); break;
      case 'ring': [880, 1320, 1760].forEach((f, i) => this.tone('sine', f, f, 0.12, 0.6, i * 0.06)); break;
      case 'win': [523, 659, 784, 1046, 1318].forEach((f, i) => { this.tone('triangle', f, f, 0.13, 0.9, i * 0.11); this.tone('sine', f * 2, f * 2, 0.04, 0.6, i * 0.11); }); break;
      case 'sonicboom': this.sonicBoom(P, pos); break; // see sonicBoom (callers delay it by distance themselves)
      case 'rocket': this.burst('white', 'lowpass', 3000, 0.5, 1, 0.8, d); this.tone('sine', 60, 40, 0.8, 0.8, 0, d); break;
      case 'warn': this.tone('square', 800, 800, 0.05, 0.12); this.tone('square', 600, 600, 0.05, 0.12, 0.15); break;
    }
  }

  // ---------- workshop (hangar building) sounds ----------
  // Recorded tool foley for building actions, with several takes and random pitch so repeats never sound identical.
  // play('place'|'remove'|...) routes here; false (clips not loaded) lets play() fall back to the old synth blips.
  wsShot(base, n, gain, lo = 0.92, hi = 1.1, delay = 0) {
    this.wsLast ||= {};
    let i = 1 + Math.floor(Math.random() * n); if (n > 1 && i === this.wsLast[base]) i = (i % n) + 1; // never the same take twice running
    this.wsLast[base] = i;
    return this.shot(n > 1 ? `${base}_${i}` : base, { gain, rate: lo + Math.random() * (hi - lo), delay });
  }
  workshop(action) {
    switch (action) {
      case 'place': // impact-wrench "brrt" bolting the part on, then a little metal settle
        if (!this.wsShot('ws_place', 3, WS.place, 0.95, 1.12)) return false;
        this.wsShot('ws_select', 2, WS.select * 0.5, 0.7, 0.85, 0.12); return true;
      case 'remove': return this.wsShot('ws_clunk', 3, WS.clunk, 0.9, 1.12); // metal dropped on the concrete floor
      case 'paint': return this.wsShot('ws_spray', 2, WS.spray, 0.9, 1.15);
      case 'select': return this.wsShot('ws_select', 2, WS.select, 0.95, 1.15);
      case 'rotate': return this.wsShot('ws_ratchet', 2, WS.ratchet, 0.9, 1.15);
      case 'move': return this.wsShot('ws_tick', 2, WS.tick, 1.3, 1.6);
      case 'flip': if (!this.wsShot('ws_ratchet', 2, WS.ratchet, 1.15, 1.3)) return false; this.wsShot('ws_select', 2, WS.select * 0.6, 1.0, 1.1, 0.25); return true;
      case 'undo': return this.wsShot('ws_button', 1, WS.button, 0.8, 0.86);
      case 'redo': return this.wsShot('ws_button', 1, WS.button, 1.1, 1.18);
      case 'load': return this.wsShot('ws_toolbox', 1, WS.toolbox, 0.92, 1.08); // toolbox clatter as the plane rolls in
      case 'save': if (!this.wsShot('ws_button', 1, WS.button, 0.7, 0.75)) return false; this.wsShot('ws_clunk', 3, WS.clunk * 0.35, 1.3, 1.45, 0.06); return true;
    }
    return false;
  }
  // Repeating ticks while a slider is dragged or a move/turn button is held, rate-limited so a fast drag doesn't machine-gun.
  // v (0..1, optional) raises the pitch with the slider value.
  tick(kind = 'slide', v = 0.5) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, gap = kind === 'ratchet' ? 0.3 : 0.075;
    this.wsTick ||= {}; if (now - (this.wsTick[kind] || 0) < gap) return; this.wsTick[kind] = now;
    if (kind === 'ratchet') { if (!this.workshop('rotate')) this.play('click'); return; }
    if (!this.wsShot('ws_tick', 2, WS.tick * 0.8, 1.2 + v * 0.6, 1.3 + v * 0.6)) this.tone('triangle', 1500 + v * 800, 1100, 0.03, 0.03);
  }
  // quiet room tone under the hangar music: a big workshop with tools going far off ('world' channel)
  roomTone(on) { this.roomOn = on; if (this.ctx) this.bedGain('amb_hangar', this.amb, on ? WS.room : 0, on ? 1.5 : 0.4); }

  // ---------- mix: music ducking, cockpit levers ----------
  // Dip the music by `db` for `hold` seconds (voice callouts, big crashes), then bring it back smoothly. Overlapping ducks extend the hold.
  duck(db, hold) {
    if (!this.musDuck) return;
    const g = this.musDuck.gain, now = this.ctx.currentTime;
    const active = now < (this.duckEnd || 0);
    this.duckDb = active ? Math.max(this.duckDb, db) : db; this.duckEnd = Math.max(active ? this.duckEnd : 0, now + hold);
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now); else { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
    g.setTargetAtTime(10 ** (-this.duckDb / 20), now, 0.06); // ~150 ms down
    g.setTargetAtTime(1, this.duckEnd, 0.35); // ~1 s back up
  }
  // a cockpit lever/switch click before a motor sound; returns the delay to give the motor (0 if the clip isn't loaded)
  lever(name, gain, after) { return this.shot(name, { gain, rate: 0.95 + Math.random() * 0.1 }) ? after : 0; }

  // ---------- mission sounds (rings, countdown, results) ----------
  // Recorded stings, each with a synth fallback, plus optional voice lines (audio.say: off with the callouts setting).
  // kind: 'checkpoint' (n of total: the chime climbs a scale ring by ring), 'count' (n = 3, 2, 1), 'go', 'win', 'ok', 'fail', 'record'
  mission(kind, n = 1, total = 12) {
    if (!this.ctx) return;
    switch (kind) {
      case 'checkpoint': {
        const last = n >= total, i = Math.round(((Math.min(n, total) - 1) / Math.max(1, total - 1)) * (RING_STEPS.length - 1));
        const semi = RING_STEPS[i], rate = 2 ** (semi / 12);
        if (this.shot('ms_chime', { gain: MS.chime, rate })) {
          if (last) [4, 7, 12].forEach((s, k) => this.shot('ms_chime', { gain: MS.chime * 0.7, rate: rate * 2 ** (s / 12), delay: 0.07 * (k + 1) })); // final ring: a sparkling chord
        } else { const f = 1046 * rate; this.tone('sine', f, f, 0.12, 0.6); this.tone('sine', f * 2, f * 2, 0.03, 0.4); if (last) [1.26, 1.5, 2].forEach((m, k) => this.tone('sine', f * m, f * m, 0.08, 0.6, 0.07 * (k + 1))); }
        if (!last) this.sayLater('vo_checkpoint', 0.35);
        break;
      }
      case 'count':
        if (!this.shot('ms_beep', { gain: MS.beep })) this.tone('sine', 880, 880, 0.1, 0.35);
        this.say({ 3: 'vo_three', 2: 'vo_two', 1: 'vo_one' }[n]);
        break;
      case 'go':
        if (!this.shot('ms_go', { gain: MS.beep, rate: 1.5 })) this.tone('sine', 1320, 1320, 0.12, 0.8);
        this.say('vo_go');
        break;
      case 'win': // mission complete: fanfare, then the voice once the brass has had its moment
        if (!this.shot('ms_fanfare', { gain: MS.fanfare })) [523, 659, 784, 1046, 1318].forEach((f, k) => { this.tone('triangle', f, f, 0.13, 0.9, k * 0.11); this.tone('sine', f * 2, f * 2, 0.04, 0.6, k * 0.11); });
        this.sayLater('vo_complete', 1.1);
        break;
      case 'ok': // finished, but not brilliantly: a friendly two-note chime
        if (!this.shot('ms_chime', { gain: MS.chime, rate: 1 }) || !this.shot('ms_chime', { gain: MS.chime, rate: 2 ** (7 / 12), delay: 0.16 })) { this.tone('sine', 1046, 1046, 0.1, 0.6); this.tone('sine', 1568, 1568, 0.1, 0.6, 0.16); }
        break;
      case 'fail': // "wah wah wahhh"
        if (!this.shot('ms_fail', { gain: MS.fail })) [392, 370, 349, 330].forEach((f, k) => this.tone('sawtooth', f, k === 3 ? f * 0.94 : f, 0.04, k === 3 ? 1.1 : 0.4, k * 0.45));
        this.sayLater('vo_aww', 2.6);
        break;
      case 'record':
        if (!this.shot('ms_record', { gain: MS.record })) [784, 988, 1175, 1568].forEach((f, k) => this.tone('triangle', f, f, 0.1, 0.5, k * 0.09));
        this.sayLater('vo_record', 0.5);
        break;
    }
  }
  sayLater(name, s) { setTimeout(() => this.say(name), s * 1000); }

  // ---------- music: streamed tracks (assets/music, Kevin MacLeod, CC BY 4.0), crossfaded by context ----------
  // Streamed through a media element rather than decoded: a decoded 3-minute track would take ~70 MB on a tablet.
  track(key) {
    this.trk ||= {};
    if (key in this.trk) return this.trk[key];
    const el = document.createElement('audio');
    if (!el.canPlayType('audio/ogg; codecs=opus')) return (this.trk[key] = null);
    el.src = `assets/music/${key}.ogg`; el.loop = true; el.preload = 'auto';
    const g = this.gain(0); this.ctx.createMediaElementSource(el).connect(g); g.connect(this.musBus);
    return (this.trk[key] = { el, g, on: false, level: 0 });
  }
  // fade `key` in to `level` and everything else out (key null: all out). false if the track can't play here.
  setTrack(key, level = 1, fade = 2.5) {
    if (!this.ctx) return false;
    for (const [k, t] of Object.entries(this.trk || {})) if (t && k !== key && t.on) {
      t.on = false; t.level = 0; this.set(t.g.gain, 0, fade / 3); clearTimeout(t.stop); t.stop = setTimeout(() => { if (!t.on) t.el.pause(); }, fade * 1000 + 600);
    }
    if (!key) return true;
    const t = this.track(key); if (!t) return false;
    if (!t.on) { t.on = true; clearTimeout(t.stop); t.el.play().catch(() => {}); }
    if (Math.abs(t.level - level) > 0.01) { t.level = level; this.set(t.g.gain, level, fade / 3); }
    return true;
  }
  // ---------- hangar music: recorded track, or the old generative pad + arpeggio if it can't play ----------
  music(on) {
    if (!this.ctx) return;
    this.roomTone(on);
    if (on && this.setTrack('hangar', MUSIC.hangar)) { this.setSpace('hangar'); return; }
    if (!on) this.setTrack(null);
    if (on && !this.mus) {
      this.setSpace('hangar');
      const out = this.gain(0); out.connect(this.musBus);
      const lp = this.filt('lowpass', 900, 0.5); lp.connect(out);
      const delay = this.ctx.createDelay(1); delay.delayTime.value = 0.375; const fb = this.gain(0.38); delay.connect(fb); fb.connect(delay); delay.connect(lp);
      const oscs = [];
      for (let i = 0; i < 4; i++) for (const det of [-6, 6]) { const o = this.osc(i % 2 ? 'triangle' : 'sawtooth', 220); o.detune.value = det; const g = this.gain(0.03); o.connect(g); g.connect(lp); oscs.push(o); }
      const lfo = this.osc('sine', 0.06), lg = this.gain(450); lfo.connect(lg); lg.connect(lp.frequency);
      const chords = [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 55, 62]];
      let ci = 0, step = 0;
      const next = () => {
        const ch = chords[Math.floor(ci / 4) % chords.length]; ci++;
        if (ci % 4 === 1) oscs.forEach((o, i) => o.frequency.setTargetAtTime(440 * 2 ** ((ch[i >> 1] - 69) / 12), this.ctx.currentTime, 0.9));
        for (let k = 0; k < 4; k++) { // arpeggio
          const n = ch[(step++ * 3) % 4] + 24 + (Math.random() < 0.2 ? 12 : 0);
          const f = 440 * 2 ** ((n - 69) / 12);
          this.tone('sine', f, f, 0.02, 1.6, k * 0.375, delay); this.tone('triangle', f, f, 0.012, 0.9, k * 0.375, lp);
        }
      };
      next(); const timer = setInterval(next, 1500);
      this.set(out.gain, 0.55, 1.5);
      this.mus = { out, oscs, timer, lfo };
    } else if (!on && this.mus) {
      const m = this.mus; this.mus = null; clearInterval(m.timer); this.set(m.out.gain, 0, 0.4);
      setTimeout(() => { m.oscs.forEach((o) => o.stop()); m.lfo.stop(); }, 2000);
    }
  }
}

// ---------- ground surfaces: which recording each surface uses, and levels (weighted, sliders 100%: rolling at 30 m/s ≈-29..-31,
// float slap ≈-37, water taxi ≈-31, bumps peak ≈-30) ----------
const GROUND = {
  bed: { runway: 'roll_runway', grass: 'roll_grass', sand: 'roll_dirt', rock: 'roll_dirt', snow: 'roll_snow' },
  rate: { sand: 0.85, rock: 1.1, snow: 0.9 },
  rough: { runway: 0.03, grass: 0.5, sand: 0.4, rock: 1.2, snow: 0.25 },
  level: { roll_runway: 2, roll_grass: 1.9, roll_dirt: 2, roll_snow: 2.1, water_taxi: 2.2, float_slap: 0.8 },
  bump: 0.8,
};
