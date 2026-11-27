// Start choice (Node suite): src/startChoice.js chooseStart, the rule buildFlight uses to decide where a flight starts,
// over every stock vehicle (its real analyze() and its built Aircraft's gear and engines), every start choice the flight
// setup offers (start, land start, boat start, mode) and every combination of what a place has (a rooftop helipad, a
// marina, the launch pad free, a water park, a stunt park, a street start, the canyon jump, open water, someone online
// already on the site): 2^9 places x 3 starts x 3 modes, x 7 land starts for a car or bike, x 5 boat starts for a boat
// (chooseStart reads the land start only for cars and the boat start only for boats).
//
// It proves what padcheck.py and helipadcheck.py used to prove by starting 20-30 real flights: nothing but a rocket is
// ever put on the launch pad and nothing but a helicopter on a helipad; and that rockets do go to the pad, helicopters to
// a free helipad, planes to the runway, and that no car is put in the air. The real places' own answers (World.startSite,
// the pad's stand) are checked in the browser by padcheck.py / helipadcheck.py, with a couple of real spawns.
//
// And one case at a real World (Lauterbrunnen: restartSpawns below): a restart puts each ground and water start type
// exactly where a fresh start did, so the browser restarts only one start per kind of spawn (canyon-lauterbrunnen.js).
import { Aircraft, REALISM } from '../../src/aircraft.js';
import { analyze } from '../../src/design.js';
import { chooseStart, LAND_STARTS, BOAT_STARTS } from '../../src/startChoice.js';

export const nodeSuite = { files: ['src/startChoice.js', 'src/design.js', 'src/landStart.js', 'src/world.js', 'tools/test/restart.js', 'tools/test/startchoice.js', 'tools/test/node/world.mjs'], headless: true };

const STARTS = new Set(['runway', 'air', 'approach', 'water', 'pad', 'helipad', 'marina', 'waterpark', ...LAND_STARTS]);
const BITS = ['helipad', 'marina', 'pad', 'wpark', 'park', 'road', 'evel', 'water', 'busy'];

export function cases(ctx) { return [...ctx.presets.map((d) => ({ id: d.name })), { id: 'lauterbrunnen: a restart starts where a fresh start did', kind: 'restart', loc: 'lauterbrunnen', world: 'lauterbrunnen', cost: 3 }]; }

// the place, as chooseStart sees it: f = which of BITS it has (sites shaped like World's: a helipad fits helicopters,
// the marina fits boats, World.sites)
export function place(f) {
  const HP = { kind: 'helipad', name: 'the helipad', fits: (s) => !!s.heli }, MA = { kind: 'marina', name: 'the marina', afloat: true, fits: (s) => !!s.boat };
  return { water: () => (f.water ? { water: true } : null), site: (s) => [f.helipad && HP, f.marina && MA].find((x) => x && x.fits(s)) || null, siteBusy: () => f.busy,
    padOK: () => f.pad, landStart: (s) => (f[s] ? { park: s } : null), waterPark: () => (f.wpark ? { wpark: true } : null) };
}

export async function runCase(c, ctx) {
  if (c.kind === 'restart') return restartSpawns(c, ctx);
  const d = ctx.presets.find((p) => p.name === c.id), st = analyze(d), ac = new Aircraft(JSON.parse(JSON.stringify(d)), REALISM.pilot);
  const gearOK = ac.parts.some((p) => p.gear && (!p.gear.float || p.gear.skid)), hasEngine = ac.hasEngine;
  const plane = !st.vertical && !st.heli && !st.car && !st.boat;
  const rules = {
    'a known start, placed consistently': (r) => STARTS.has(r.start) && (r.spawn === null) === (r.start === 'air' || r.start === 'approach') && (r.start === 'pad') === (r.spawn === 'pad') && (r.spawn !== 'stand' || r.start === r.site.kind),
    'on the launch pad only if it is a rocket (and the pad is free)': (r, f) => r.start !== 'pad' || (st.vertical && f.pad),
    'a rocket on the launch pad when it is free': (r, f, cfg) => !(st.vertical && f.pad && cfg.start !== 'water') || r.start === 'pad',
    'on a helipad only if it is a helicopter': (r) => r.start !== 'helipad' || !!st.heli,
    'a helicopter on a free helipad from a runway start': (r, f, cfg) => !(st.heli && f.helipad && !f.busy && cfg.start === 'runway' && cfg.mode !== 'landing') || r.start === 'helipad',
    'a plane on the runway from a runway start': (r, f, cfg) => !(plane && cfg.start === 'runway' && cfg.mode !== 'landing' && hasEngine && gearOK) || r.start === 'runway',
    'a car without wings never in the air': (r) => !(st.car && st.wingArea < 0.5) || (r.start !== 'air' && r.start !== 'approach'),
    'a boat only afloat or on the runway': (r) => !(st.boat && !st.heli && !st.car) || ['marina', 'waterpark', 'water', 'runway', 'air'].includes(r.start),
  };
  const bad = Object.fromEntries(Object.keys(rules).map((k) => [k, { n: 0, first: null }]));
  let n = 0;
  for (const start of ['runway', 'air', 'water']) for (const landStart of st.car ? [...LAND_STARTS, 'runway', 'marina', 'water', undefined] : [undefined]) for (const boatStart of st.boat ? [...BOAT_STARTS, undefined] : [undefined]) for (const mode of ['free', 'rings', 'landing']) {
    const cfg = { start, landStart, boatStart, mode };
    for (let m = 0; m < 1 << BITS.length; m++) {
      const f = Object.fromEntries(BITS.map((b, i) => [b, !!((m >> i) & 1)])), r = chooseStart(st, cfg, { gearOK, hasEngine, ...place(f) });
      n++;
      for (const [k, ok] of Object.entries(rules)) if (!ok(r, f, cfg)) { const b = bad[k]; b.n++; b.first ??= `start ${r.start} (spawn ${r.spawn}) for ${JSON.stringify(cfg)} at a place with ${BITS.filter((x) => f[x]).join(', ') || 'nothing'}`; }
    }
  }
  return Object.entries(bad).map(([k, b]) => ({ name: `${c.id}: ${k}`, ok: !b.n, why: b.n ? `${b.n}/${n} choices broke it, e.g. ${b.first}` : '' }));
}

// A restart (main.js restartFlight: endFlight(true) keeps the World and reset()s it, then buildFlight starts the same
// cfg again) runs the same code for every start type: what differs between start types is which spot the World's
// answers give (World.startSite, landStart, waterParks.start, the runway) and the ground under it. Checked here at the
// real Lauterbrunnen for the ground and water start types the canyon-lauterbrunnen job swaps in (it restarts only the
// stunt park and the water park in the browser now): the start and the spawn pose (chooseStart with the World's answers,
// then Aircraft.spawn the way buildFlight puts each kind there: main.js `pick.spawn ===`), as a fresh World's first
// start gets it (the street start found anew: the World caches it), and again after a flight's damage (restart.js
// damage near every start, the destruction stepped on) and World.reset(): the same start, the same pose (to restart.js
// sameSpawn's 1e-3). The air and launch pad starts are placed by main.js alone (planAirStart, padSpawn): the browser
// job restarts those.
const RESTART_STARTS = [ // [label, vehicle, cfg, the start it must get]
  ['runway', 'Kestrel', { start: 'runway' }, 'runway'], ['stunt park', 'Dune Buggy', { landStart: 'park' }, 'park'], ['street', 'Dune Buggy', { landStart: 'road' }, 'road'],
  ['marina', 'Speedboat', { boatStart: 'marina' }, 'marina'], ['water park', 'Speedboat', { boatStart: 'waterpark' }, 'waterpark']];
async function restartSpawns(c, ctx) {
  const THREE = await import('three'), { findWater } = await import('../../src/startChoice.js'), { roadStart } = await import('../../src/landStart.js');
  const { worldAt } = await import('./node/world.mjs'), { damage } = await import('./restart.js');
  const { world: w, env } = await worldAt(c.loc);
  const fx = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : fx), apply: () => fx }); // (the flight's effects: debris, dust and fires go nowhere)
  const pose = ([, name, cfg], fresh) => {
    const d = ctx.presets.find((p) => p.name === name), st = analyze(d), ac = new Aircraft(JSON.parse(JSON.stringify(d)), REALISM.pilot);
    const gearOK = ac.parts.some((p) => p.gear && (!p.gear.float || p.gear.skid)), rwy = w.runways[0] || w.runway;
    const r = chooseStart(st, { start: 'runway', mode: 'free', ...cfg }, { gearOK, hasEngine: ac.hasEngine, water: () => findWater(w), site: (s) => w.startSite(s), siteBusy: () => false, padOK: () => false,
      landStart: (s) => (fresh && s === 'road' ? roadStart(w) : w.landStart(s)), waterPark: () => w.waterParks?.start ?? null });
    let p = true;
    if (r.spawn === 'waterpark') ac.spawn(env, r.wpark.at(0), r.wpark.heading);
    else if (r.spawn === 'afloat') ac.spawn(env, r.at.at(0), r.at.heading);
    else if (r.spawn === 'park') ac.spawn(env, r.park.at(0), r.park.heading);
    else if (r.spawn === 'runway') ac.spawn(env, new THREE.Vector3(rwy.x, 0, rwy.len / 2 - 60), 0);
    else p = false;
    return { start: r.start, spawn: r.spawn, ac, p: p ? [...ac.x.toArray(), ...ac.q.toArray()] : null };
  };
  const first = RESTART_STARTS.map((s) => pose(s, true));
  let hit = 0;
  for (const f of first) hit += damage({ F: { world: w, effects: fx, ac: f.ac }, THREE }).buildings;
  for (let k = 0; k < 30; k++) w.destruct.update(0.1, fx, { position: new THREE.Vector3() }, []);
  w.reset();
  const again = RESTART_STARTS.map((s) => pose(s, false));
  return RESTART_STARTS.map(([label, name, , want], i) => {
    const a = first[i], b = again[i], same = !!(a.p && b.p) && a.p.every((v, k) => Math.abs(v - b.p[k]) <= 1e-3);
    return { name: `${c.loc}: ${label} (${name}): a restart starts where a fresh start did`, ok: same && a.start === want && b.start === want,
      why: `start ${a.start}/${b.start} (spawn ${a.spawn}) at ${a.p ? a.p.slice(0, 3).map((v) => v.toFixed(1)).join(', ') : '-'}: ${same ? 'same pose' : 'MOVED'} after ${hit} buildings hit and World.reset` };
  });
}
