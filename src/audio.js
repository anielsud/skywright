// Fully synthesized audio (no sample files).
// 3D-positioned engines, location reverb, layered crashes, ambient beds and hangar music.
// Mixer channels the player can set (0..1 each). Sliders are perceptual: see dbGain.
export const MIX_DEFAULTS = { master: 0.7, engines: 0.7, world: 0.8, fx: 0.8, music: 0.6 };
// Slider position -> gain. 0 is silent; otherwise -45 dB at the bottom of the travel up to 0 dB at the top,
// so every step sounds like the same change and the lowest steps are genuinely quiet.
export const dbGain = (v) => (v <= 0.001 ? 0 : 10 ** ((-45 * (1 - v)) / 20));
const HEADROOM = 0.25; // -12 dB overall: a game shouldn't hit the speaker at full scale

export class Audio {
  constructor() { this.ctx = null; this.voices = {}; this.mix = { ...MIX_DEFAULTS }; this.space = null; }
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
    this.engBus = this.gain(1); this.engBus.connect(this.bus); // engines
    this.airBus = this.gain(1); this.airBus.connect(this.bus); // wind, buffet, wheels rolling: 'world' channel
    // effects: crashes/explosions were mostly sub-bass that tablet speakers can't play but that slammed the limiter
    this.fxLow = ctx.createBiquadFilter(); this.fxLow.type = 'lowshelf'; this.fxLow.frequency.value = 150; this.fxLow.gain.value = -10;
    this.fx = this.gain(1); this.fx.connect(this.fxLow); this.fxLow.connect(this.subCut);
    this.amb = this.gain(1); this.amb.connect(this.subCut);
    this.musBus = this.gain(1); this.musBus.connect(this.subCut);
    // reverb send
    this.verb = ctx.createConvolver(); this.verbOut = this.gain(0.9); this.verb.connect(this.verbOut); this.verbOut.connect(this.subCut);
    this.sendBus = this.gain(0.12); this.bus.connect(this.sendBus); this.sendBus.connect(this.verb);
    this.sendFx = this.gain(0.4); this.fx.connect(this.sendFx); this.sendFx.connect(this.verb);
    this.musSend = this.gain(0.8); this.musBus.connect(this.musSend); this.musSend.connect(this.verb);
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
  }
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
    if (spatial) { v.pan = this.panner(); v.out.connect(v.pan); v.pan.connect(this.engBus); } else v.out.connect(kind === 'stall' ? this.fx : kind === 'rain' ? this.amb : this.airBus);
    const to = (node) => node.connect(v.out);
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
      v.n = this.noise(); v.nf = this.filt('bandpass', 400, 0.6); v.n.connect(v.nf); to(v.nf);
      v.n2 = this.noise('brown'); v.n2g = this.gain(1.5); v.n2.connect(v.n2g); to(v.n2g);
      v.gl = this.osc('sine', 0.3); v.glg = this.gain(0.25); v.gl.connect(v.glg); v.glg.connect(v.out.gain); // gusting
    } else if (kind === 'whistle') {
      v.n = this.noise(); v.nf = this.filt('bandpass', 1800, 9); v.n.connect(v.nf); to(v.nf);
    } else if (kind === 'buffet') {
      v.n = this.noise('brown'); v.nf = this.filt('lowpass', 90, 1); v.am = this.gain(0.5); v.lfo = this.osc('square', 9); v.lg = this.gain(0.5); v.lfo.connect(v.lg); v.lg.connect(v.am.gain);
      v.n.connect(v.nf); v.nf.connect(v.am); to(v.am);
    } else if (kind === 'roll') {
      v.n = this.noise('brown'); v.nf = this.filt('lowpass', 160, 1); v.n.connect(v.nf); to(v.nf);
      v.bump = this.noise('crackle'); v.bf = this.filt('lowpass', 300); v.bg = this.gain(1.5); v.bump.connect(v.bf); v.bf.connect(v.bg); to(v.bg);
      v.c = this.noise(); v.cf = this.filt('bandpass', 1200, 1); v.cg = this.gain(0); v.c.connect(v.cf); v.cf.connect(v.cg); v.cg.connect(this.fx);
    } else if (kind === 'stall') {
      v.o = this.osc('square', 440); v.f = this.filt('lowpass', 1800); v.o.connect(v.f); to(v.f);
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
    this.set(this.cockpitLP.frequency, s.cockpit ? 1600 : 20000, 0.1);
    const seen = new Set();
    for (const e of s.engines) {
      const v = this.voice(e.sound); seen.add(e.sound);
      if (s.cockpit && v.pan) v.pan.refDistance = 40; else if (v.pan) v.pan.refDistance = 12 + e.count * 3;
      this.placeVoice(v, e.pos);
      const thr = e.spoolT;
      const multi = Math.sqrt(e.count);
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
    for (const k of ['piston', 'radial', 'turboprop', 'electric', 'jet', 'fan', 'rocket']) if (!seen.has(k) && this.voices[k]) this.set(this.voices[k].out.gain, 0, 0.15);
    // airflow
    const sp = s.airspeed, ck = s.cockpit ? 0.65 : 1;
    const wv = this.voice('wind'); this.set(wv.nf.frequency, 250 + Math.min(sp, 130) * 9); this.set(wv.out.gain, Math.min(0.4, (sp / 90) ** 2 * 0.3) * ck); // wind sits under the engine, even at jet speeds
    const wh = this.voice('whistle'); this.set(wh.nf.frequency, 900 + sp * 14); this.set(wh.out.gain, Math.max(0, (sp - 60) / 200) ** 2 * 0.1 * ck);
    const bf = this.voice('buffet'); this.set(bf.out.gain, Math.min(1.2, (s.buffet || 0) * 3) * (s.cockpit ? 1.5 : 0.7), 0.05); this.set(bf.lfo.frequency, 6 + Math.random() * 6);
    // ground roll
    const rv = this.voice('roll');
    this.set(rv.out.gain, s.onGround ? Math.min(1, s.groundSpeed / 30) * (s.surface === 'runway' ? 0.45 : 1.0) : 0, 0.05);
    this.set(rv.nf.frequency, s.surface === 'runway' ? 120 : 260); this.set(rv.bg.gain, s.surface === 'runway' ? 0.4 : 2.2);
    this.set(rv.cg.gain, s.scrape ? Math.min(0.5, s.scrape / 40) : 0, 0.05);
    const st = this.voice('stall'); this.set(st.out.gain, s.stall && Math.floor(this.ctx.currentTime * 4) % 2 === 0 ? 0.07 : 0, 0.01);
    const rn = this.voice('rain'); this.set(rn.out.gain, s.rain * 0.13 * (s.cockpit ? 1.6 : 1), 0.3);
    this.ambience(s.amb, s.listener?.pos);
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
    this.set(this.surf.gain, near * near * (a.loc === 'islands' ? 0.45 : 0.14), 0.5);
    this.set(this.crickets.gain, a.night ? low * 0.025 : 0, 1);
    // birdsong: occasional procedural chirps placed around the listener
    if (a.day && low > 0.2 && Math.random() < 0.03 * low) this.bird(a.loc === 'islands', lp);
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
  silence() { if (!this.ctx) return; for (const k in this.voices) this.set(this.voices[k].out.gain, 0, 0.05); if (this.surf) { this.set(this.surf.gain, 0, 0.1); this.set(this.crickets.gain, 0, 0.1); } }

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
    const P = Math.min(2, p), d = this.dest(pos);
    switch (name) {
      case 'impact':
        this.tone('sine', 90, 35, 0.9 * P, 0.5, 0, d); this.burst('brown', 'lowpass', 400, 0.7, 0.9 * P, 0.4 + P * 0.3, d);
        this.crunch(P, d); if (P > 0.6) this.clatter(P, d, 8);
        break;
      case 'crack': this.burst('white', 'highpass', 2000, 0.7, 0.8 * P, 0.12, d); this.crunch(P * 0.8, d, 0.15); this.tone('triangle', 900, 120, 0.2 * P, 0.4, 0, d); this.clatter(P, d, 10, 1.8); break;
      case 'glass': for (let i = 0; i < 18; i++) { this.burst('white', 'bandpass', 4000 + Math.random() * 6000, 12, 0.25, 0.05 + Math.random() * 0.25, d, Math.random() * 0.4); this.tone('sine', 3000 + Math.random() * 5000, 2500, 0.03, 0.3, Math.random() * 0.5, d); } break;
      case 'explosion':
        this.tone('sine', 70, 22, 1.6, 2.2, 0, d); this.burst('brown', 'lowpass', 260, 0.5, 2.0, 4.0, d, 0, 60); this.burst('white', 'lowpass', 2400, 0.5, 1.0, 1.4, d, 0, 300);
        for (let i = 0; i < 10; i++) this.burst('crackle', 'highpass', 500, 0.7, 0.8, 0.5, d, 0.1 + Math.random() * 2);
        this.clatter(1.4, d, 20, 3.5);
        break;
      case 'chirp': this.burst('white', 'bandpass', 2600, 4, 0.22 * P, 0.12, this.fx, 0, 1700); this.burst('white', 'bandpass', 2300, 4, 0.18 * P, 0.1, this.fx, 0.07, 1600); this.burst('brown', 'lowpass', 180, 1, 0.6 * P, 0.25); break;
      case 'splash': this.burst('white', 'lowpass', 3000, 0.5, 0.7 * P, 1.3, d, 0, 500); this.burst('brown', 'lowpass', 300, 1, 0.7 * P, 0.9, d); for (let i = 0; i < 8; i++) this.burst('white', 'bandpass', 1500 + Math.random() * 3000, 4, 0.15 * P, 0.1, d, 0.2 + Math.random() * 0.8); break;
      case 'gear': // motor whine, then a clunk into the locks
        this.tone('sawtooth', 140, 210, 0.04, 2.6, 0, this.fx); this.burst('white', 'bandpass', 900, 3, 0.05, 2.6);
        this.tone('sine', 70, 40, 0.5, 0.25, 2.7); this.burst('brown', 'lowpass', 500, 1, 0.5, 0.3, this.fx, 2.7); this.burst('white', 'bandpass', 2500, 8, 0.15, 0.08, this.fx, 2.72);
        break;
      case 'flaps': this.tone('sawtooth', 220, 260, 0.025, 1.2); this.burst('white', 'bandpass', 1200, 4, 0.03, 1.2); this.tone('sine', 120, 80, 0.12, 0.12, 1.2); break;
      case 'thunder': {
        this.burst('white', 'highpass', 1500, 0.5, 0.5 * P, 0.25); this.burst('white', 'lowpass', 3000, 0.5, 0.6 * P, 0.7, this.fx, 0.02, 400);
        for (let i = 0; i < 4; i++) this.burst('brown', 'lowpass', 500, 0.5, (0.9 + Math.random() * 0.6) * (0.5 + P), 3 + Math.random() * 4, this.fx, i * (0.3 + Math.random() * 0.8), 60);
        break;
      }
      case 'bird': this.tone('sine', 2400, 3800, 0.08, 0.12, 0, d); this.tone('sine', 2800, 4200, 0.06, 0.1, 0.15, d); this.burst('white', 'bandpass', 600, 2, 0.6, 0.3, d); break;
      case 'click': this.tone('triangle', 1700, 1100, 0.07, 0.05); this.burst('white', 'highpass', 4000, 1, 0.05, 0.02); break;
      case 'clank': this.tone('triangle', 620 + Math.random() * 80, 600, 0.12, 0.6); this.tone('sine', 1500, 1450, 0.05, 0.7); this.tone('sine', 2310, 2300, 0.025, 0.5); this.burst('white', 'bandpass', 3000, 2, 0.12, 0.05); this.tone('sine', 90, 60, 0.25, 0.15); break;
      case 'pop': this.tone('sine', 400, 900, 0.1, 0.08); break;
      case 'ring': [880, 1320, 1760].forEach((f, i) => this.tone('sine', f, f, 0.12, 0.6, i * 0.06)); break;
      case 'win': [523, 659, 784, 1046, 1318].forEach((f, i) => { this.tone('triangle', f, f, 0.13, 0.9, i * 0.11); this.tone('sine', f * 2, f * 2, 0.04, 0.6, i * 0.11); }); break;
      case 'rocket': this.burst('white', 'lowpass', 3000, 0.5, 1, 0.8, d); this.tone('sine', 60, 40, 0.8, 0.8, 0, d); break;
      case 'warn': this.tone('square', 800, 800, 0.05, 0.12); this.tone('square', 600, 600, 0.05, 0.12, 0.15); break;
    }
  }

  // ---------- hangar music: warm generative pad + soft arpeggio, through the hangar reverb ----------
  music(on) {
    if (!this.ctx) return;
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
