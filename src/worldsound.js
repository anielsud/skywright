// Sounds of the living world around you: road traffic, the train (with its horn and level-crossing bells),
// other players' planes, the airfield's circuit plane and helicopter, bird flocks, and the sounds of real places
// (waterfalls, cowbells on the alpine pastures, train horns along the real railways) and rushing rivers.
// Everything is positional and goes through the same "far = quieter, duller and later" chain as the engines
// (panner distance roll-off + air-absorption low-pass + propagation delay, which also gives Doppler).
// Cheap on purpose: a few pooled voices for the nearest sources only, ranked a few times a second; everything
// out of earshot has its source stopped, not just muted.
import * as THREE from 'three';
import { SAMPLE_ENGINES, SAMPLE_LEVEL, RPM_RANGE } from './audio.js';

// Linear trims (clips are normalised to ≈-26 dB weighted, then the master's -12 dB headroom applies).
// Weighted dBFS at the reference distance, sliders at 100%: car ≈-32 @10 m, truck ≈-30, train ≈-32 @30 m,
// horn ≈-27 @80 m, bell ≈-36 @15 m, flock flaps ≈-36 @20 m, calls ≈-37 @25 m; another plane at full power ≈-33 @15 m
// (a few dB under your own engine in the chase view).
const LVL = { car: 1.5, truck: 2, train: 5, horn: 3.6, bell: 1.1, flock: 1.4, call: 1.1, plane: 1.4 };
// Ambience beds (weighted dBFS at full amount, measured over 7 s): airport ≈-40 (under an idling engine), town ≈-39 (bells to ≈-31),
// high wind ≈-38 (gusts to ≈-33), storm wind ≈-34, canopy rain in a storm ≈-35 (on top of the existing rain bed). Nature beds sit at -41..-34.
const AMB = { airport: 0.7, town: 0.7, high: 1, storm: 1, canopy: 0.55, cows: 1.3, city: 1.4 };
// Real-place sounds (weighted dBFS, sliders at 100%): a waterfall ≈-30 at its foot, ≈-40 at 300 m; cowbells ≈-37 over open
// meadow (bells to ≈-28); a train horn down the valley ≈-38 peak at 500 m, plus a quieter echo off the cliffs.
const LVL_FALL = 3, LVL_VHORN = 2 * LVL.horn, FALL_RANGE = 1800, RAIL_RANGE = 2200;
// the famous falls (real positions, game metres; h = drop): where to hang a roaring water bed on the cliff
const FALLS = {
  lauterbrunnen: [
    { name: 'Staubbach', x: 8674, z: 4540, h: 297 },
    { name: 'Trümmelbach', x: 11170, z: 5977, h: 140 },
    { name: 'Mürrenbach', x: 10807, z: 7136, h: 417 },
  ],
};
const COWS = { lauterbrunnen: 1, alpine: 1 }; // places with alpine pastures
// big cities: a dense-traffic roar over the streets instead of the village hum (≈-34 dB weighted low over Midtown, ≈-38
// at 1 km up) and a far-off siren every 30–75 s (≈-37 peak, 400–1100 m away)
const CITY = { nyc: 1 }, LVL_SIREN = 3.5;
// rivers and streams from the terrain bake (world.landAt; not the dry desert washes): ≈-31 dB weighted at the bank of a
// big river, ≈-42 at 150 m; ≈-37 by a small stream
const REAL_RIVER = 0.8; // mapped real rivers carry no size: treat them as big ones
const LVL_RIVER = 3.8, RIVER_RANGE = 450, RIVER_RINGS = [0, 25, 50, 90, 140, 210, 300, 420];
const CAR_VOICES = 3, CAR_RANGE = 240, TRAIN_RANGE = 1600, PLANE_VOICES = 3, PLANE_RANGE = 3500, FLOCK_RANGE = 160;
const HEAVY = { truck: 1, tanker: 1, bus: 1 };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// One positional voice: gain -> air absorption -> delay -> panner -> bus. Sources are attached/stopped on demand.
class Spot {
  constructor(A, dest, ref, rolloff = 1) {
    this.A = A; this.out = A.gain(0); this.air = A.filt('lowpass', 22000, 0.5); this.dl = A.ctx.createDelay(6);
    this.pan = A.ctx.createPanner(); this.pan.panningModel = 'equalpower'; // HRTF per voice is too heavy for a tablet
    this.pan.distanceModel = 'inverse'; this.pan.refDistance = ref; this.pan.rolloffFactor = rolloff; this.pan.maxDistance = 1e5;
    this.out.connect(this.air); this.air.connect(this.dl); this.dl.connect(this.pan); this.pan.connect(dest);
    this.layers = []; this.owner = null; this.d = 1e9;
  }
  // start looping clips (one per layer); returns false if any clip is missing
  start(names) {
    this.kill(); const A = this.A;
    if (!names.every((n) => A.has(n))) return false;
    this.layers = names.map((n) => { const src = A.loop(n), g = A.gain(names.length > 1 ? 0 : 1); src.connect(g); g.connect(this.out); return { src, g }; });
    return true;
  }
  kill() { for (const l of this.layers) { try { l.src.stop(); l.g.disconnect(); } catch { /* gone */ } } this.layers = []; }
  // fade out, then stop the sources (a stopped voice costs nothing)
  release() {
    if (!this.layers.length) { this.owner = null; return; }
    const old = this.layers; this.layers = []; this.owner = null;
    for (const l of old) this.A.set(l.g.gain, 0, 0.12); // fade the layers, not `out`: a new owner may start right away
    setTimeout(() => { for (const l of old) { try { l.src.stop(); l.g.disconnect(); } catch { /* gone */ } } }, 600);
  }
  get on() { return this.layers.length > 0; }
  place(p, lp) {
    const A = this.A, t = A.ctx.currentTime, pan = this.pan;
    if (pan.positionX) { pan.positionX.setTargetAtTime(p.x, t, 0.03); pan.positionY.setTargetAtTime(p.y, t, 0.03); pan.positionZ.setTargetAtTime(p.z, t, 0.03); } else pan.setPosition(p.x, p.y, p.z);
    const d = (this.d = Math.hypot(p.x - lp.x, p.y - lp.y, p.z - lp.z)), target = Math.min(5, d / 343);
    if (Math.abs(target - this.dl.delayTime.value) > 0.12) { this.dl.delayTime.cancelScheduledValues(t); this.dl.delayTime.setValueAtTime(target, t); } else this.dl.delayTime.setTargetAtTime(target, t, 0.08);
    A.set(this.air.frequency, Math.max(700, 22000 * Math.exp(-d / 500)), 0.1);
    return d;
  }
  level(v, t = 0.08) { this.A.set(this.out.gain, v, t); }
  rate(r) { for (const l of this.layers) this.A.set(l.src.playbackRate, r, 0.1); }
  dispose() { this.kill(); try { this.pan.disconnect(); } catch { /* gone */ } }
}

export class WorldSound {
  constructor(audio, world, traffic) {
    this.A = audio; this.world = world; this.traffic = traffic; this.t = 0; this.rankT = -1; this.on = !!audio.ctx;
    if (!this.on) return;
    const A = audio;
    // 'world' slider; muffled by the cockpit filter like wind. Low shelf: truck/train bass a tablet can't play only eats limiter headroom
    this.low = A.ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 160; this.low.gain.value = -8;
    this.bus = A.gain(1); this.bus.connect(this.low); this.low.connect(A.airBus);
    this.cars = Array.from({ length: CAR_VOICES }, () => new Spot(A, this.bus, 10));
    this.train = new Spot(A, this.bus, 30); this.bell = new Spot(A, this.bus, 15);
    this.planes = Array.from({ length: PLANE_VOICES }, () => new Spot(A, A.engBus, 14)); // engines slider
    this.v = { p: new THREE.Vector3(), d: new THREE.Vector3() };
    this.hornT = 20 + Math.random() * 20; this.crossings = this.findCrossings(); this.crossHorn = new Map();
    this.flockT = new Map();
    this.fall = new Spot(A, this.bus, 100); this.falls = this.findFalls(); this.rails = this.railPoints(); this.railHornT = 15 + Math.random() * 25;
    this.river = new Spot(A, this.bus, 50, 0.7); this.riverP = null; this.riverT = 1; this.riverOff = 0; this.lw = [0, 0, 0, 0]; // gentle roll-off on the river: it's a line of sound, not a point
  }
  // level crossings: rail points that sit on a road (bridges excluded), as arc lengths along the train's out-and-back path
  findCrossings() {
    const net = this.world.net, rail = net?.rail, T = this.traffic?.vehicles?.train; if (!rail || !T) return [];
    const cell = 20, grid = new Map(), key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    for (const rd of net.roads) rd.pts.forEach((p, i) => { if (!rd.bridge?.[i]) { const k = key(p.x, p.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); } });
    const out = [], n = rail.pts.length;
    rail.pts.forEach((p, i) => {
      if (rail.bridge[i] || out.some((c) => c.p.distanceTo(p) < 120)) return;
      const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const q of grid.get(`${cx + a},${cz + b}`) || []) {
        if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 49 && !out.some((c) => c.i === i)) out.push({ i, p: p.clone(), s: [T.path.len[i], T.path.len[2 * n - 1 - i]] });
      }
    });
    return out;
  }

  update(f, lp, dt, players, cockpit = false) {
    if (!this.on || !lp) return;
    this.t += dt;
    const rank = this.t - this.rankT > 0.25; if (rank) this.rankT = this.t;
    const agl = lp.y - Math.max(this.world.heightAt(lp.x, lp.z), this.world.waterLevel);
    this.updateCars(lp, rank, agl);
    this.updateTrain(lp, dt);
    this.updatePlanes(f, lp, rank, players);
    if (rank) this.updateFlocks(lp);
    this.updateAmbience(lp, dt, agl, cockpit);
    this.updatePlaces(lp, dt, agl);
    this.updateRiver(lp, dt, agl);
  }

  // ---------- road traffic: the nearest few cars get a pooled tyre/engine hum ----------
  updateCars(lp, rank, agl) {
    const V = this.traffic?.vehicles; if (!V) return;
    const { p, d } = this.v;
    if (rank) {
      const best = [];
      if (agl < CAR_RANGE) for (const c of V.cars) {
        V.pathPoint(c.path, c.s, p, d);
        const dd = (p.x - lp.x) ** 2 + (p.z - lp.z) ** 2;
        if (dd > CAR_RANGE * CAR_RANGE || c.v < 1) continue;
        if (best.length < CAR_VOICES) best.push([dd, c]); else if (dd < best[best.length - 1][0]) best[best.length - 1] = [dd, c]; else continue;
        best.sort((a, b) => a[0] - b[0]);
      }
      const want = new Set(best.map((b) => b[1]));
      for (const s of this.cars) if (s.owner && !want.has(s.owner)) s.release();
      for (const c of want) {
        if (this.cars.some((s) => s.owner === c)) continue;
        const s = this.cars.find((x) => !x.owner); if (!s) break;
        if (s.start(['veh_road'])) { s.owner = c; s.out.gain.value = 0; }
      }
    }
    for (const s of this.cars) {
      const c = s.owner; if (!c) continue;
      V.pathPoint(c.path, c.s, p, d); p.y += 0.8;
      const dist = s.place(p, lp), heavy = HEAVY[c.type];
      const sp = Math.min(1, c.v / 22);
      s.rate((heavy ? 0.72 : 0.9) + sp * (heavy ? 0.25 : 0.35));
      s.level((heavy ? LVL.truck : LVL.car) * (0.35 + 0.65 * sp) * (1 - smooth(CAR_RANGE * 0.65, CAR_RANGE, dist)), 0.15);
    }
  }

  // ---------- train: rumble at the nearest carriage, horn now and then and before level crossings, crossing bells ----------
  updateTrain(lp, dt) {
    const T = this.traffic?.vehicles?.train; if (!T) return;
    let near = null, nd = 1e18;
    for (const m of T.cars) { const q = m.position, dd = (q.x - lp.x) ** 2 + (q.y - lp.y) ** 2 + (q.z - lp.z) ** 2; if (dd < nd) { nd = dd; near = q; } }
    const dist = Math.sqrt(nd), moving = Math.min(1, T.v / 25);
    if (dist < TRAIN_RANGE && T.v > 0.5) {
      if (!this.train.on) this.train.start(['train_rumble']);
      this.train.place(near, lp); this.train.rate(0.65 + 0.4 * moving);
      this.train.level(LVL.train * (0.25 + 0.75 * moving) * (1 - smooth(TRAIN_RANGE * 0.7, TRAIN_RANGE, dist)), 0.3);
    } else if (this.train.on) this.train.release();
    const loco = T.cars[0].position, ld = loco.distanceTo(lp);
    // level crossings: horn on the approach (long, long, short, long), bell while the train is close to it
    let bellAt = null, bellAmt = 0;
    for (const c of this.crossings) {
      const ahead = Math.min(...c.s.map((s) => (s - T.s + T.path.total) % T.path.total));
      const near2 = Math.min(ahead, c.p.distanceTo(loco));
      if (near2 < 260) { const a = 1 - near2 / 260; if (a > bellAmt) { bellAmt = a; bellAt = c.p; } }
      if (ahead > 80 && ahead < 260 && T.v > 3 && ld < TRAIN_RANGE && this.t - (this.crossHorn.get(c) ?? -99) > 40) { this.crossHorn.set(c, this.t); this.horn(loco, lp, [0, 1.6, 3.2]); }
    }
    if (bellAt && bellAt.distanceTo(lp) < 600) {
      if (!this.bell.on) this.bell.start(['train_bell']);
      this.bell.place(bellAt, lp); this.bell.level(LVL.bell * Math.min(1, bellAmt * 2.5), 0.3);
    } else if (this.bell.on) this.bell.release();
    // and now and then out on the line
    this.hornT -= dt;
    if (this.hornT < 0) { this.hornT = 35 + Math.random() * 40; if (ld < TRAIN_RANGE && T.v > 5) this.horn(loco, lp, Math.random() < 0.5 ? [0] : [0, 1.5]); }
  }
  horn(pos, lp, times) {
    const d = pos.distanceTo(lp);
    for (const t of times) this.shotAt('train_horn', pos, lp, { gain: LVL.horn, ref: 80, delay: t + d / 343, rate: 0.97 + Math.random() * 0.05 });
  }

  // ---------- other planes: remote players, the circuit plane and the shuttle helicopter, with the recorded engine layers ----------
  updatePlanes(f, lp, rank, players) {
    if (rank) {
      const list = [];
      for (const pl of players || []) { const ac = pl.remote?.ac; if (ac && !ac.dead && ac.root.visible) list.push({ key: pl, pos: ac.x, ...this.remoteEngine(ac) }); }
      const P = this.traffic?.pattern; if (P) list.push({ key: P, pos: P.obj.position, kind: 'piston', n: 0.62, count: 1 });
      const H = this.traffic?.heli; if (H) list.push({ key: H, pos: H.g.position, kind: SAMPLE_ENGINES.rotor ? 'rotor' : 'turboprop', n: 0.75, count: 1 });
      const near = list.filter((x) => x.kind && x.pos.distanceTo(lp) < PLANE_RANGE).sort((a, b) => a.pos.distanceTo(lp) - b.pos.distanceTo(lp)).slice(0, PLANE_VOICES);
      for (const s of this.planes) if (s.owner && !near.some((x) => x.key === s.owner.key && x.kind === s.owner.kind)) s.release();
      for (const x of near) {
        const s = this.planes.find((v) => v.owner && v.owner.key === x.key); if (s) { s.owner = x; continue; }
        const free = this.planes.find((v) => !v.owner); if (!free) break;
        const def = SAMPLE_ENGINES[x.kind]; if (!def) continue;
        const roles = ['idle', 'high'].filter((r) => def[r]);
        if (free.start(roles.map((r) => def[r][0]))) { free.owner = x; free.roles = roles.map((r) => def[r]); free.out.gain.value = 0; }
      }
    }
    for (const s of this.planes) {
      const x = s.owner; if (!x) continue;
      // remote players' throttle changes between ranks: re-read it every frame
      if (x.key.remote) Object.assign(x, this.remoteEngine(x.key.remote.ac));
      const dist = s.place(x.pos, lp), n = x.n ?? 0, k = smooth(0.2, 0.8, n), A = this.A;
      s.layers.forEach((l, i) => {
        const role = s.roles[i], two = s.layers.length > 1;
        A.set(l.g.gain, two ? (i === 0 ? Math.cos(k * Math.PI / 2) : Math.sin(k * Math.PI / 2)) : 1, 0.1);
        A.set(l.src.playbackRate, role[1] + (role[2] - role[1]) * n, 0.1);
      });
      s.level(LVL.plane * (SAMPLE_LEVEL[x.kind] || 1) * (0.32 + 0.68 * n) * Math.sqrt(x.count || 1) * (x.running === false ? 0 : 1) * (1 - smooth(PLANE_RANGE * 0.7, PLANE_RANGE, dist)), 0.15);
    }
  }
  // the dominant engine sound of a remote plane and how hard it's working (0..1)
  remoteEngine(ac) {
    let kind = null, n = 0, count = 0, running = false;
    for (const p of ac.parts) {
      const e = p.alive && p.engine; if (!e?.sound || !SAMPLE_ENGINES[e.sound]) continue;
      if (kind && e.sound !== kind) continue;
      kind = e.sound; count++;
      const rr = RPM_RANGE[kind];
      n = Math.max(n, rr ? Math.min(1, Math.max(0, ((e.rpm || 0) - rr[0]) / (rr[1] - rr[0]))) : e.spoolT || 0);
      running = running || (kind === 'rocket' ? !!e.burning : rr ? (e.rpm || 0) > 50 : true);
    }
    return { kind, n, count, running };
  }

  // ---------- bird flocks: wing flaps and calls when you're close ----------
  updateFlocks(lp) {
    for (const fl of this.traffic?.flocks || []) {
      const d = fl.c.distanceTo(lp); if (d > FLOCK_RANGE) continue;
      const next = this.flockT.get(fl) ?? 0; if (this.t < next) continue;
      const alive = fl.birds.filter((b) => b.alive).length; if (!alive) continue;
      const any = fl.birds.find((b) => b.alive).p;
      if (Math.random() < 0.5) this.shotAt('bird_flock', any, lp, { gain: LVL.flock * Math.min(1, alive / 10), ref: 20, rate: fl.seagull ? 0.85 : 0.95 + Math.random() * 0.15 });
      else this.shotAt(fl.seagull ? 'bird_gull' : 'bird_crow', any, lp, { gain: LVL.call, ref: 25, rate: 0.9 + Math.random() * 0.2 });
      this.flockT.set(fl, this.t + 3 + Math.random() * 5);
    }
  }

  // ---------- location ambience: airport bustle, town hum, high/mountain wind, storm wind and rain drumming on the canopy ----------
  // Where you are is checked twice a second with a handful of terrain samples; the beds crossfade slowly and only loop while audible.
  updateAmbience(lp, dt, agl, cockpit) {
    const W = this.world, A = this.A;
    this.ambT = (this.ambT ?? 1) + dt;
    if (this.ambT > 0.5) { this.ambT = 0; this.where = this.locate(lp, agl); }
    const w = this.where; if (!w) return;
    // gusts: a slow random walk the high wind follows
    this.gustT = (this.gustT ?? 0) - dt;
    if (this.gustT < 0) { this.gustT = 0.8 + Math.random() * 2.2; this.gustTo = Math.random() ** 1.5; }
    this.gust = (this.gust ?? 0.5) + ((this.gustTo ?? 0.5) - (this.gust ?? 0.5)) * Math.min(1, dt * 1.2);
    const night = W.night ? 0.6 : 1, storm = W.W?.storm ? Math.min(1, (W.W.wind || 15) / 15) : 0;
    const rain = W.rain?.visible ? W.W.rain : 0;
    this.ambBed('amb_airport', this.bus, w.airport * night * AMB.airport);
    this.ambBed('amb_town', this.bus, CITY[W.loc.id] ? 0 : w.town * night * AMB.town);
    this.ambBed('amb_city', this.bus, w.city * (W.night ? 0.7 : 1) * AMB.city);
    this.ambBed('wind_high', this.bus, w.high * (0.45 + 0.75 * this.gust) * AMB.high * (1 - 0.5 * storm), 0.8 + 0.25 * this.gust);
    this.ambBed('wind_storm', this.bus, storm * AMB.storm * (0.7 + 0.5 * this.gust));
    this.ambBed('amb_cowbells', this.bus, w.cows * (W.night ? 0.25 : 1) * (1 - 0.8 * storm) * AMB.cows);
    // inside the canopy: drumming rain, heavier in a storm (not muffled: it's on the glass right next to you)
    this.ambBed('rain_canopy', A.amb, cockpit ? Math.min(1.6, rain) * AMB.canopy : 0);
  }
  // 0..1 amounts for where the camera is
  locate(lp, agl) {
    const W = this.world, rw = W.runway || { len: 1800 };
    // the airfield: runways + taxiways + apron (x from the runway to past the terminal), only on/near the ground
    const ax = Math.max(-120 - lp.x, 0, lp.x - 430), az = Math.max(0, Math.abs(lp.z) - rw.len / 2 - 60);
    const airport = (1 - smooth(60, 650, Math.hypot(ax, az))) * (1 - smooth(15, 140, agl));
    // towns: low and close
    let town = 0;
    for (const t of W.net?.towns || []) {
      const d = Math.max(0, Math.hypot(lp.x - t.c.x, lp.z - t.c.z) - 260 * t.size);
      town = Math.max(town, (1 - smooth(0, 650, d)) * Math.sqrt(t.size));
    }
    town *= 1 - smooth(50, 380, agl);
    // high up, or skimming close past a mountain (any of 6 samples 250 m around that rises near your height and is a real peak)
    let peak = 0;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2, h = W.heightAt(lp.x + Math.cos(a) * 250, lp.z + Math.sin(a) * 250);
      peak = Math.max(peak, smooth(-300, -40, h - lp.y) * smooth(500, 1100, h - W.waterLevel));
    }
    const high = Math.max(smooth(600, 2000, agl), peak);
    // alpine pastures: open grass (no forest, no village) around you, low enough to hear the herd
    let cows = 0;
    if (COWS[W.loc.id] && agl < 300) {
      let open = 0;
      for (let k = 0; k < 5; k++) {
        const a = (k / 4) * Math.PI * 2, r = k ? 120 : 0, x = lp.x + Math.cos(a) * r, z = lp.z + Math.sin(a) * r;
        if (W.groundAt(x, z).type !== 'grass') continue;
        const fo = W.real ? W.real.forest(x, z) : W.forestAt?.(x, z);
        open += 1 - Math.min(1, (fo ?? 0) * 1.5);
      }
      cows = (open / 5) * (1 - smooth(30, 300, agl)) * (1 - town) * (1 - airport);
    }
    // a city: how much of the ground around (wider the higher you are) is covered in buildings (the 50 m collision grid)
    let city = 0;
    const G = CITY[W.loc.id] && (W.towns?.city?.grid || W.towns?.grid);
    if (G && agl < 1500) {
      const r = 120 + agl * 0.6; let hit = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (G.get(Math.floor((lp.x + a * r) / 50) + ',' + Math.floor((lp.z + b * r) / 50))?.length) hit++;
      city = smooth(1, 6, hit) * (1 - smooth(200, 1500, agl) * 0.75);
    }
    return { airport, town, high, cows, city };
  }
  // a looping bed that only exists while it's audible: created on fade-in, stopped a few seconds after fading out
  ambBed(name, dest, v, rate) {
    this.beds ||= {};
    let b = this.beds[name];
    if (v > 0.002 && !b) { if (!this.A.has(name)) return; const src = this.A.loop(name), g = this.A.gain(0); src.connect(g); g.connect(dest); b = this.beds[name] = { src, g, quiet: 0 }; }
    if (!b) return;
    this.A.set(b.g.gain, Math.max(0, v), 1.2); if (rate) this.A.set(b.src.playbackRate, rate, 0.8);
    b.quiet = v > 0.002 ? 0 : b.quiet + 1;
    if (b.quiet > 400) { try { b.src.stop(); b.g.disconnect(); } catch { /* gone */ } delete this.beds[name]; } // ~6 s of silence at 60 fps
  }

  // ---------- real places: waterfalls roaring down the cliffs, trains hooting along the real railways ----------
  // each fall is a vertical line from its foot to its lip: the sound sits at the point of that line nearest to you
  findFalls() {
    const W = this.world;
    return (FALLS[W.loc.id] || []).map((f) => {
      let foot = W.heightAt(f.x, f.z);
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; foot = Math.min(foot, W.heightAt(f.x + Math.cos(a) * 120, f.z + Math.sin(a) * 120)); }
      return { ...f, foot, p: new THREE.Vector3(f.x, foot, f.z) };
    });
  }
  // the real railways (OSM), thinned to a point every ~150 m
  railPoints() {
    const out = [];
    for (const [, , flat] of this.world.real?.osm?.rails || []) {
      let lx = 1e9, lz = 1e9;
      for (let k = 0; k < flat.length; k += 2) { const x = flat[k], z = flat[k + 1]; if ((x - lx) ** 2 + (z - lz) ** 2 > 150 * 150) { out.push(x, z); lx = x; lz = z; } }
    }
    return out;
  }
  updatePlaces(lp, dt, agl) {
    // the nearest waterfall
    let best = null, bd = FALL_RANGE;
    for (const f of this.falls) {
      f.p.y = Math.min(f.foot + f.h, Math.max(f.foot, lp.y));
      const d = f.p.distanceTo(lp); if (d < bd) { bd = d; best = f; }
    }
    if (best) {
      if (!this.fall.on) { this.fall.start(['amb_waterfall']); this.fall.out.gain.value = 0; }
      this.fall.place(best.p, lp);
      this.fall.level(LVL_FALL * (1 - smooth(FALL_RANGE * 0.6, FALL_RANGE, bd)), 0.4);
    } else if (this.fall.on) this.fall.release();
    // a siren somewhere across the city
    if (this.where?.city > 0.3) {
      this.sirenT = (this.sirenT ?? 10 + Math.random() * 15) - dt;
      if (this.sirenT < 0) {
        this.sirenT = 30 + Math.random() * 45;
        const a = Math.random() * Math.PI * 2, d = 400 + Math.random() * 700, x = lp.x + Math.cos(a) * d, z = lp.z + Math.sin(a) * d;
        this.shotAt(`siren_${1 + (Math.random() < 0.5)}`, new THREE.Vector3(x, Math.max(this.world.heightAt(x, z), this.world.waterLevel) + 3, z), lp, { gain: LVL_SIREN, ref: 120, rate: 0.95 + Math.random() * 0.1 });
      }
    }
    // a train somewhere down the valley sounds its horn now and then (with the echo off the cliffs)
    const R = this.rails; if (!R.length) return;
    this.railHornT -= dt; if (this.railHornT > 0) return;
    this.railHornT = 40 + Math.random() * 50;
    if (agl > 900) return;
    let bi = -1, bd2 = RAIL_RANGE * RAIL_RANGE;
    for (let k = 0; k < R.length; k += 2) { const d2 = (R[k] - lp.x) ** 2 + (R[k + 1] - lp.z) ** 2; if (d2 < bd2 && d2 > 250 * 250) { bd2 = d2; bi = k; } }
    if (bi < 0) return;
    const p = new THREE.Vector3(R[bi], this.world.heightAt(R[bi], R[bi + 1]) + 4, R[bi + 1]), d = p.distanceTo(lp);
    const times = Math.random() < 0.5 ? [0] : [0, 1.4], echo = 1.6 + Math.random() * 1.6, rate = 1.02 + Math.random() * 0.08;
    for (const t of times) {
      this.shotAt('train_horn', p, lp, { gain: LVL_VHORN, ref: 80, delay: t + d / 343, rate });
      this.shotAt('train_horn', p, lp, { gain: LVL_VHORN * 0.3, ref: 80, delay: t + d / 343 + echo, rate });
    }
  }

  // ---------- rivers and streams: rushing water at the nearest bit of river (from the terrain bake's water map) ----------
  // Searched in rings twice a second; the sound glides along the bank as the nearest point changes. Bigger rivers
  // (more drainage) are louder and deeper; small mountain streams are quieter and brighter.
  updateRiver(lp, dt, agl) {
    const W = this.world, real = W.real?.waterAt ? W.real : null; // real places: mapped rivers (the Colorado, the Lütschine…)
    if (!real && (!W.bake || W.bake.dry || !W.landAt)) return;
    this.riverT += dt;
    if (this.riverT > 0.5) {
      this.riverT = 0; this.riverHit = null;
      if (agl < RIVER_RANGE) {
        const L = this.lw;
        for (const r of RIVER_RINGS) {
          const n = r ? Math.max(8, Math.round(r / 12)) : 1;
          let best = null, bw = 0.4;
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2, x = lp.x + Math.cos(a) * r, z = lp.z + Math.sin(a) * r;
            if (real) { const h = real.waterAt(x, z); if (h != null) { best = [x, z, REAL_RIVER, h]; break; } continue; }
            W.landAt(x, z, L); if (L[0] > bw) { bw = L[0]; best = [x, z, L[1], W.heightAt(x, z)]; }
          }
          if (best) { this.riverHit = { p: new THREE.Vector3(best[0], best[3] + 1, best[1]), size: best[2] }; break; }
        }
      }
    }
    const hit = this.riverHit;
    if (hit) {
      if (!this.river.on) { this.river.start(['amb_river']); this.river.out.gain.value = 0; this.riverP = hit.p.clone(); this.riverSize = hit.size; }
      this.riverP.lerp(hit.p, Math.min(1, dt * 2)); this.riverSize += (hit.size - this.riverSize) * Math.min(1, dt);
      const d = this.river.place(this.riverP, lp), sz = this.riverSize;
      this.river.rate(1.12 - 0.22 * sz);
      this.river.level(LVL_RIVER * (0.25 + 0.75 * sz) * (1 - smooth(RIVER_RANGE * 0.6, RIVER_RANGE, d)), 0.5);
    } else if (this.river.on) { this.river.level(0, 0.5); if (++this.riverOff > 120) { this.river.release(); this.riverOff = 0; } }
    if (hit) this.riverOff = 0;
  }

  // positional one-shot with distance roll-off, air absorption and travel delay
  shotAt(name, pos, lp, { gain = 1, ref = 20, delay = 0, rate = 1 } = {}) {
    const A = this.A, b = A.buffers[name]; if (!b) return false;
    const d = Math.hypot(pos.x - lp.x, pos.y - lp.y, pos.z - lp.z);
    const src = A.ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = rate;
    const g = A.gain(gain), lpf = A.filt('lowpass', Math.max(700, 22000 * Math.exp(-d / 500)), 0.5);
    const pan = A.ctx.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = ref; pan.rolloffFactor = 1; pan.maxDistance = 1e5;
    if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; } else pan.setPosition(pos.x, pos.y, pos.z);
    src.connect(g); g.connect(lpf); lpf.connect(pan); pan.connect(this.bus);
    src.start(A.ctx.currentTime + delay); src.onended = () => { g.disconnect(); pan.disconnect(); };
    return true;
  }

  dispose() {
    if (!this.on) return; this.on = false;
    for (const s of [...this.cars, ...this.planes, this.train, this.bell, this.fall, this.river]) s.dispose();
    for (const b of Object.values(this.beds || {})) { this.A.set(b.g.gain, 0, 0.05); setTimeout(() => { try { b.src.stop(); b.g.disconnect(); } catch { /* gone */ } }, 300); }
    this.A.set(this.bus.gain, 0, 0.05); setTimeout(() => { try { this.bus.disconnect(); } catch { /* gone */ } }, 300);
  }
}
