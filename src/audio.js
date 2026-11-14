// Fully synthesized audio (no sample files): engines, wind, rolling, crashes, thunder, UI, hangar music.
export class Audio {
  constructor() { this.ctx = null; this.voices = {}; this.volume = 0.8; this.muffle = 0; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -14; this.comp.ratio.value = 4;
    this.cockpitLP = ctx.createBiquadFilter(); this.cockpitLP.type = 'lowpass'; this.cockpitLP.frequency.value = 20000;
    this.bus = ctx.createGain(); // engine/wind bus (muffled in cockpit)
    this.bus.connect(this.cockpitLP); this.cockpitLP.connect(this.comp);
    this.fx = ctx.createGain(); this.fx.connect(this.comp);
    this.comp.connect(this.master); this.master.connect(ctx.destination);
    // noise buffers
    const len = ctx.sampleRate * 2;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate); const w = this.white.getChannelData(0); for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate); const b = this.brown.getChannelData(0); let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    this.dist = ctx.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 2.5); } this.dist.curve = curve;
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  noise(type = 'white') { const s = this.ctx.createBufferSource(); s.buffer = type === 'brown' ? this.brown : this.white; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 1.5); return s; }
  osc(type, f) { const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; }
  filt(type, f, Q = 1) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; }
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  set(param, v, t = 0.06) { param.setTargetAtTime(v, this.ctx.currentTime, t); }

  // ---------- continuous voices ----------
  makeVoice(kind) {
    const out = this.gain(0); out.connect(this.bus);
    const v = { kind, out, nodes: [] };
    if (kind === 'piston' || kind === 'radial') {
      v.o1 = this.osc('sawtooth', 50); v.o2 = this.osc('square', 25); v.o3 = this.osc('sawtooth', 100);
      const g1 = this.gain(0.5), g2 = this.gain(0.35), g3 = this.gain(0.15);
      v.lp = this.filt('lowpass', 600, 2);
      const sh = this.ctx.createWaveShaper(); sh.curve = this.dist.curve;
      v.o1.connect(g1); v.o2.connect(g2); v.o3.connect(g3); g1.connect(sh); g2.connect(sh); g3.connect(sh); sh.connect(v.lp);
      // amplitude "chug" modulation
      v.am = this.gain(0.6); v.lfo = this.osc('square', 12); v.lfoG = this.gain(0.4); v.lfo.connect(v.lfoG); v.lfoG.connect(v.am.gain);
      v.lp.connect(v.am); v.am.connect(out);
      // exhaust noise
      v.n = this.noise('brown'); v.nf = this.filt('bandpass', 200, 0.8); v.ng = this.gain(0.6); v.n.connect(v.nf); v.nf.connect(v.ng); v.ng.connect(v.am);
      // prop whoosh
      v.pn = this.noise(); v.pf = this.filt('bandpass', 800, 0.7); v.pg = this.gain(0); v.pl = this.osc('sine', 40); v.plg = this.gain(0); v.pl.connect(v.plg); v.plg.connect(v.pg.gain);
      v.pn.connect(v.pf); v.pf.connect(v.pg); v.pg.connect(out);
    } else if (kind === 'turboprop' || kind === 'electric') {
      v.whine = this.osc('sine', 3000); v.wg = this.gain(kind === 'electric' ? 0.25 : 0.06); v.whine.connect(v.wg); v.wg.connect(out);
      v.w2 = this.osc('triangle', 1500); v.w2g = this.gain(kind === 'electric' ? 0.12 : 0.03); v.w2.connect(v.w2g); v.w2g.connect(out);
      v.buzz = this.osc('sawtooth', 120); v.bf = this.filt('lowpass', 500, 3); v.bg = this.gain(kind === 'electric' ? 0.05 : 0.45); v.buzz.connect(v.bf); v.bf.connect(v.bg); v.bg.connect(out);
      v.n = this.noise(); v.nf = this.filt('bandpass', 900, 0.6); v.ng = this.gain(kind === 'electric' ? 0.1 : 0.5); v.n.connect(v.nf); v.nf.connect(v.ng); v.ng.connect(out);
      v.pl = this.osc('sine', 30); v.plg = this.gain(0.3); v.pl.connect(v.plg); v.plg.connect(v.ng.gain);
    } else if (kind === 'jet' || kind === 'fan') {
      v.n = this.noise(); v.nf = this.filt('bandpass', 500, 0.5); v.ng = this.gain(1); v.n.connect(v.nf); v.nf.connect(v.ng); v.ng.connect(out);
      v.h = this.noise(); v.hf = this.filt('highpass', 3500, 0.5); v.hg = this.gain(0.2); v.h.connect(v.hf); v.hf.connect(v.hg); v.hg.connect(out);
      v.whine = this.osc('sine', 2000); v.wg = this.gain(kind === 'fan' ? 0.05 : 0.08); v.whine.connect(v.wg); v.wg.connect(out);
      v.w2 = this.osc('sawtooth', 300); v.w2f = this.filt('bandpass', 300, 8); v.w2g = this.gain(kind === 'fan' ? 0.25 : 0.05); v.w2.connect(v.w2f); v.w2f.connect(v.w2g); v.w2g.connect(out);
      v.ab = this.noise('brown'); v.abf = this.filt('lowpass', 300, 0.7); v.abg = this.gain(0); v.ab.connect(v.abf); v.abf.connect(v.abg); v.abg.connect(out);
    } else if (kind === 'rocket') {
      v.n = this.noise(); v.nf = this.filt('lowpass', 1200, 0.5); v.ng = this.gain(1); v.n.connect(v.nf); v.nf.connect(v.ng); v.ng.connect(out);
      v.b = this.noise('brown'); v.bg = this.gain(2.5); v.b.connect(v.bg); v.bg.connect(out);
    } else if (kind === 'wind') {
      v.n = this.noise(); v.nf = this.filt('bandpass', 400, 0.6); v.n.connect(v.nf); v.nf.connect(out);
      v.n2 = this.noise('brown'); v.n2g = this.gain(1.5); v.n2.connect(v.n2g); v.n2g.connect(out);
    } else if (kind === 'roll') {
      v.n = this.noise('brown'); v.nf = this.filt('lowpass', 160, 1); v.n.connect(v.nf); v.nf.connect(out);
      v.c = this.noise(); v.cf = this.filt('bandpass', 1200, 1); v.cg = this.gain(0); v.c.connect(v.cf); v.cf.connect(v.cg); v.cg.connect(this.fx);
    } else if (kind === 'stall') {
      v.o = this.osc('square', 440); v.f = this.filt('lowpass', 1800); v.o.connect(v.f); v.f.connect(out); out.disconnect(); out.connect(this.fx);
    } else if (kind === 'rain') {
      v.n = this.noise(); v.nf = this.filt('highpass', 1500, 0.4); v.n.connect(v.nf); v.nf.connect(out); out.disconnect(); out.connect(this.fx);
    }
    return v;
  }
  voice(kind) { if (!this.voices[kind]) this.voices[kind] = this.makeVoice(kind); return this.voices[kind]; }

  // engines: [{sound, rpm, spoolT, thrustFrac, ab, burning}] already aggregated by sound
  update(state) {
    if (!this.ctx) return;
    const s = state;
    const dop = s.doppler || 1, att = s.atten ?? 1;
    this.set(this.cockpitLP.frequency, s.cockpit ? 1400 : 20000, 0.1);
    const seen = new Set();
    for (const e of s.engines) {
      const v = this.voice(e.sound); seen.add(e.sound);
      const thr = e.spoolT;
      if (e.sound === 'piston' || e.sound === 'radial') {
        const rad = e.sound === 'radial';
        const rps = Math.max(1, e.rpm) / 60;
        const fire = rps * (rad ? 4.5 : 2) * dop;
        this.set(v.o1.frequency, fire); this.set(v.o2.frequency, fire / 2); this.set(v.o3.frequency, fire * (rad ? 0.5 : 2.01));
        this.set(v.lfo.frequency, rps * dop * (rad ? 1 : 0.5)); this.set(v.lfoG.gain, rad ? 0.5 : 0.25);
        this.set(v.lp.frequency, 250 + thr * 1400); this.set(v.nf.frequency, 120 + thr * 500);
        this.set(v.pf.frequency, 300 + thr * 900);
        this.set(v.pl.frequency, rps * e.blades * dop); this.set(v.plg.gain, 0.3 * thr); this.set(v.pg.gain, 0.15 + thr * 0.25);
        const g = e.rpm > 50 ? (0.16 + thr * 0.22) * Math.sqrt(e.count) * (rad ? 1.3 : 1) : 0;
        this.set(v.out.gain, g * att);
      } else if (e.sound === 'turboprop' || e.sound === 'electric') {
        const el = e.sound === 'electric';
        this.set(v.whine.frequency, (el ? 400 + thr * 2600 : 2600 + thr * 2400) * dop); this.set(v.w2.frequency, (el ? 200 + thr * 1300 : 1300 + thr * 800) * dop);
        this.set(v.buzz.frequency, (e.rpm / 60) * e.blades * dop); this.set(v.pl.frequency, (e.rpm / 60) * e.blades * 0.25 * dop);
        this.set(v.nf.frequency, 500 + thr * 900);
        this.set(v.out.gain, (0.12 + thr * 0.3) * Math.sqrt(e.count) * att);
      } else if (e.sound === 'jet' || e.sound === 'fan') {
        const fan = e.sound === 'fan';
        this.set(v.nf.frequency, (300 + thr * 1500) * dop); this.set(v.nf.Q, 0.5);
        this.set(v.whine.frequency, (fan ? 900 + thr * 2400 : 1500 + thr * 5500) * dop);
        this.set(v.w2.frequency, (fan ? 60 + thr * 160 : 200 + thr * 400) * dop); this.set(v.w2f.frequency, (fan ? 60 + thr * 160 : 200 + thr * 400) * dop);
        this.set(v.hg.gain, 0.1 + thr * 0.3);
        this.set(v.abg.gain, e.ab ? 1.6 : 0, 0.15);
        this.set(v.out.gain, (0.08 + thr * 0.45) * Math.sqrt(e.count) * att);
      } else if (e.sound === 'rocket') {
        const on = e.burning ? 1 : 0;
        this.set(v.ng.gain, on * (0.8 + Math.random() * 0.5), 0.02);
        this.set(v.out.gain, on * 0.6 * Math.sqrt(e.count) * att, 0.05);
      }
    }
    for (const k of ['piston', 'radial', 'turboprop', 'electric', 'jet', 'fan', 'rocket']) if (!seen.has(k) && this.voices[k]) this.set(this.voices[k].out.gain, 0, 0.15);
    // wind
    const wv = this.voice('wind');
    const sp = s.airspeed;
    this.set(wv.nf.frequency, 250 + sp * 9); this.set(wv.out.gain, Math.min(0.9, (sp / 90) ** 2 * 0.6 + s.alphaWind * 0.2) * (s.cockpit ? 0.6 : 1) * att);
    // rolling
    const rv = this.voice('roll');
    this.set(rv.out.gain, s.onGround ? Math.min(1, s.groundSpeed / 30) * (s.surface === 'runway' ? 0.5 : 1.0) : 0, 0.05);
    this.set(rv.nf.frequency, s.surface === 'runway' ? 120 : 260);
    this.set(rv.cg.gain, s.scrape ? Math.min(0.5, s.scrape / 40) : 0, 0.05);
    // stall horn
    const st = this.voice('stall');
    this.set(st.out.gain, s.stall && Math.floor(this.ctx.currentTime * 4) % 2 === 0 ? 0.08 : 0, 0.01);
    // rain
    const rn = this.voice('rain'); this.set(rn.out.gain, s.rain * 0.12 * (s.cockpit ? 1.5 : 1), 0.3);
  }
  silence() { if (!this.ctx) return; for (const k in this.voices) this.set(this.voices[k].out.gain, 0, 0.05); }

  // ---------- one-shots ----------
  env(g, a, peak, d) { const t = this.ctx.currentTime; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
  burst(type, filter, f, Q, peak, dur, dest = this.fx, delay = 0) {
    const n = this.ctx.createBufferSource(); n.buffer = type === 'brown' ? this.brown : this.white;
    const fl = this.filt(filter, f, Q), g = this.gain(0);
    n.connect(fl); fl.connect(g); g.connect(dest);
    const t = this.ctx.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
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
  play(name, p = 1) {
    if (!this.ctx) return;
    const P = Math.min(2, p);
    switch (name) {
      case 'impact': {
        this.burst('brown', 'lowpass', 300, 0.7, 0.9 * P, 0.4 + P * 0.3);
        this.burst('white', 'bandpass', 900 + Math.random() * 1500, 4, 0.4 * P, 0.3 + P * 0.4);
        for (let i = 0; i < 3; i++) this.burst('white', 'bandpass', 300 + Math.random() * 3000, 18, 0.5 * P, 0.6 + Math.random(), this.fx, Math.random() * 0.1);
        break;
      }
      case 'crack': { this.burst('white', 'highpass', 1800, 0.7, 0.7 * P, 0.15); this.burst('white', 'bandpass', 500, 6, 0.5 * P, 0.5); this.tone('triangle', 900, 120, 0.2 * P, 0.4); break; }
      case 'explosion': {
        this.burst('brown', 'lowpass', 180, 0.5, 1.6, 3.5); this.burst('white', 'lowpass', 1200, 0.5, 0.9, 1.6);
        for (let i = 0; i < 8; i++) this.burst('white', 'bandpass', 200 + Math.random() * 2000, 10, 0.3, 0.3, this.fx, 0.1 + Math.random() * 1.2);
        break;
      }
      case 'chirp': { this.burst('white', 'bandpass', 2600, 3, 0.25 * P, 0.25); this.burst('brown', 'lowpass', 200, 1, 0.5 * P, 0.25); break; }
      case 'splash': { this.burst('white', 'lowpass', 2500, 0.5, 0.7 * P, 1.2); this.burst('brown', 'lowpass', 300, 1, 0.6 * P, 0.8); break; }
      case 'gear': { this.tone('square', 140, 70, 0.08, 0.2); this.burst('brown', 'lowpass', 400, 1, 0.3, 0.3, this.fx, 0.25); this.tone('square', 90, 50, 0.1, 0.15, 2.8); break; }
      case 'thunder': {
        const d = 0; const f = this.burst('brown', 'lowpass', 600, 0.5, 1.2 * (0.5 + P), 5 + P * 3, this.fx, d);
        f.frequency.exponentialRampToValueAtTime(70, this.ctx.currentTime + 4);
        this.burst('white', 'lowpass', 2500, 0.5, 0.4 * P, 0.6, this.fx, d);
        break;
      }
      case 'bird': { this.tone('sine', 2400, 3800, 0.08, 0.12); this.tone('sine', 2800, 4200, 0.06, 0.1, 0.15); this.burst('white', 'bandpass', 600, 2, 0.6, 0.3); break; }
      case 'click': { this.tone('triangle', 1500, 900, 0.08, 0.06); break; }
      case 'clank': { this.tone('triangle', 620 + Math.random() * 80, 600, 0.12, 0.5); this.tone('sine', 1500, 1450, 0.05, 0.6); this.burst('white', 'bandpass', 3000, 2, 0.12, 0.05); break; }
      case 'pop': { this.tone('sine', 400, 900, 0.1, 0.08); break; }
      case 'ring': { this.tone('sine', 880, 880, 0.15, 0.25); this.tone('sine', 1320, 1320, 0.12, 0.4, 0.08); break; }
      case 'win': { [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.15, 0.6, i * 0.12)); break; }
      case 'rocket': { this.burst('white', 'lowpass', 3000, 0.5, 1, 0.8); break; }
      case 'warn': { this.tone('square', 800, 800, 0.06, 0.12); this.tone('square', 600, 600, 0.06, 0.12, 0.15); break; }
    }
  }

  // ---------- hangar music: gentle generative pad ----------
  music(on) {
    if (!this.ctx) return;
    if (on && !this.mus) {
      const out = this.gain(0); out.connect(this.comp);
      const lp = this.filt('lowpass', 900, 0.5); lp.connect(out);
      const delay = this.ctx.createDelay(1); delay.delayTime.value = 0.45; const fb = this.gain(0.35); delay.connect(fb); fb.connect(delay); delay.connect(lp);
      const oscs = [];
      for (let i = 0; i < 4; i++) { const o = this.osc(i % 2 ? 'triangle' : 'sawtooth', 220); const g = this.gain(0.05); o.connect(g); g.connect(lp); g.connect(delay); oscs.push(o); }
      const lfo = this.osc('sine', 0.07), lg = this.gain(400); lfo.connect(lg); lg.connect(lp.frequency);
      const chords = [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 55, 62]];
      let ci = 0;
      const next = () => {
        const ch = chords[ci++ % chords.length];
        oscs.forEach((o, i) => o.frequency.setTargetAtTime(440 * 2 ** ((ch[i] - 69) / 12) * (1 + (i - 1.5) * 0.002), this.ctx.currentTime, 0.8));
        // a soft plucked note on top
        const n = ch[Math.floor(Math.random() * 4)] + 24;
        this.tone('sine', 440 * 2 ** ((n - 69) / 12), 440 * 2 ** ((n - 69) / 12), 0.025, 2.5, 0.3, lp);
      };
      next(); const timer = setInterval(next, 5000);
      this.set(out.gain, 0.5, 1.5);
      this.mus = { out, oscs, timer, lfo };
    } else if (!on && this.mus) {
      const m = this.mus; this.mus = null; clearInterval(m.timer); this.set(m.out.gain, 0, 0.4);
      setTimeout(() => { m.oscs.forEach((o) => o.stop()); m.lfo.stop(); }, 2000);
    }
  }
}
