// Job: New York (one World, built once; every vehicle swapped into it once). Run by tools/test/jobs.py; see harness.js
// for T and the rules (build once, step with T.advance, draw fixed frame counts only for drawing claims, wait on
// states). The steps, in order (drawn = frames drawn on the real loop; stepped = game time, no drawing):
//   build + Dragonfly (Pilot)   New York built, the Dragonfly started (it is the one T.start that builds the World)
//   stunt site planned          startbakes' stunts check on this World right after it was built (stuntsIn: the site it
//                               planned == a fresh search == the bake; planned again from the visit's cache)
//   Dragonfly (Pilot): helipad  stepped (helipadcheck.js heliRun + heliChecks): starts on the H, level, facing the
//                               view, skids on the deck, engines off; the building under it has no damage key; the
//                               runway resting baseline (the same Dragonfly teleported to the runway, settled); back on
//                               the pad: rests 5 s as on the runway, rotor stopped, nothing touched; lifts to a 25 m
//                               hover; lands gently on the deck; rests as on the runway
//   Dragonfly: shader sweep     drawn: streaming quiet (T.settle), then the whole scene drawn (every hidden object
//                               shown, culling off) and every event effect fired (the only job that fires them): no
//                               stall, nothing waited for its shader (shadercheck.js sceneDrawn / eventsFired); then
//                               stepped until the effects have died out (not left on screen for the next step)
//   Dragonfly: real loop        drawn: the tour flight (smoke.js tour: full power on the real loop over its 2 cockpit
//                               views, each drawn once; out of the cockpit and back to chase, 3 s stepped)
//   Dragonfly (Arcade): helipad swapped in (realism doesn't rebuild the World); the helipad checks again, stepped
//   Rocket: pad                 swapped in; padcheck.js rocket('nyc'): on the pad, 5 s hold, 10 s burn past the tower,
//                               stepped
//   Rocket: real loop           drawn: the tour flight from where the burn left it
//   Dune Buggy: arch            swapped in (land start 'park'): at the stunt park's arch facing the first kicker
//   stunt park                  stepped (a fresh vehicle on the flight's physics): New York's site dry, flat and clear
//                               (tree canopy from the imagery); the Dune Buggy's kicker jump and loop run from its arch
//   Dune Buggy: road            the rule's road start (land start 'road': predicted with this World's answers), the
//                               flight's buggy put there as buildFlight puts it (teleport, no new start): in its lane,
//                               facing along the road, nothing in a building
//   Dune Buggy: buildings       the crash: placecheck's wall runs (walls.js gameRun: the game loop's own runs, stepped)
//                               into two building faces near the park, nothing of it inside (10 m/s at 35 deg, then
//                               30 m/s straight on); streaming quiet before the 30 m/s one, its impact drawn (5 frames): no
//                               stall, nothing waited for its shader, something broke off
//   Dirt Bike: arch + road      swapped in at the arch; the road start by teleport, as for the buggy
//   Speedboat, Jet Ski          each swapped in with boat start 'waterpark': at the water park's arch, afloat, upright,
//                               facing down the course
//   start rule wiring           every vehicle above started where the start rule predicts (wiring.js); over every
//                               stock preset, nothing but a rocket on the pad, nothing but a helicopter on the helipad
//   no site warnings            no '[stunts]' / '[waterpark]' warning at any point (from the World's build on)
// Every step also fails on a shader stall or a page error (the harness). Keep BASE's time and weather (T.start's cfg:
// start, mode, realism, landStart, boatStart only), or New York is built again.
// Not here, and why: placecheck's canyon marina fallback (Node startchoice + the wiring check at the canyon job);
// placecheck's "no shaders mid-flight" (every step's stall check); padcheck's/helipadcheck's spawn-everything and --ref
// pose comparisons (the wiring check: the rule over every preset, the real starts against it).
import { heliRun, heliChecks } from '../helipadcheck.js';
import { rocket, rocketChecks } from '../padcheck.js';
import { tour, tourChecks } from '../smoke.js';
import { sceneDrawn, eventsFired, phaseChecks } from '../shadercheck.js';
import { stuntsIn, stuntsChecks } from '../startbakes.js';
import { siteCheck, loopRun, judge } from '../stunts.js';
import { faces, gameRun } from '../walls.js';
import { wiringChecks, predictStart } from './wiring.js';

const LOC = 'nyc';
const TOL = 0.1; // m: the deepest anything may get inside a building (placecheck.py)

export async function run(T) {
  const S = T.S, started = [];
  // the World's own warnings about its stunt site and water park (from the build on: they're logged while it plans)
  const siteWarns = [], warn0 = console.warn;
  console.warn = (...a) => { const m = a.map(String).join(' '); if (/^\[(stunts|waterpark)\]/.test(m)) siteWarns.push(m); warn0(...a); };
  const begin = async (name, cfg = {}) => {
    const s = await T.start(name, LOC, cfg);
    started.push({ name, location: LOC, cfg, start: s.start });
    return `${s.how} in ${(s.ms / 1000).toFixed(1)} s (${s.frames} frames), started at ${s.start}`;
  };
  try {
    await T.step('build New York + Dragonfly (Pilot)', () => begin('Dragonfly'));

    await T.step('stunt site planned == search == bake', async () => {
      const r = await stuntsIn(T.F.world);
      T.checks(stuntsChecks(r));
    });

    await T.step('Dragonfly (Pilot): helipad', () => helipad(T));

    await T.step('Dragonfly: shader sweep (scene, events)', async () => {
      const q = await T.settle();
      const scene = await sceneDrawn();
      T.checks(phaseChecks('scene drawn', scene));
      const events = await eventsFired({ settled: false }); // (just settled; the scene phase streams nothing in)
      T.checks(phaseChecks('every event fired', events));
      return `settled in ${q.rounds} rounds; ${scene.objects} hidden/culled objects shown`;
    });

    await T.step('Dragonfly: real loop + cockpit views', async () => { const f = await tour(); T.checks(tourChecks(f)); return `${f.views} view(s): ${f.names.join(', ')}`; });

    await T.step('Dragonfly (Arcade): helipad', async () => { await begin('Dragonfly', { realism: 'arcade' }); return helipad(T); });

    await T.step('Rocket: on the pad, hold + launch', async () => {
      const r = await rocket(LOC);
      started.push({ name: 'Rocket', location: LOC, cfg: {}, start: r.start });
      T.checks(rocketChecks(r));
      return `released after ${r.burn.releasedAt?.toFixed(2)} s, ${r.burn.height.toFixed(0)} m up after ${r.burn.seconds.toFixed(1)} s`;
    });

    await T.step('Rocket: real loop + cockpit views', async () => { const f = await tour(); T.checks(tourChecks(f)); return `${f.views} view(s): ${f.names.join(', ')}`; });

    let parkAt = null;
    await T.step('Dune Buggy: at the stunt park arch', async () => {
      const how = await begin('Dune Buggy', { landStart: 'park' });
      parkAt = T.F.ac.x.clone();
      archCheck(T, 'Dune Buggy');
      const st = T.F.world.stunts?.stats;
      if (st) T.log(`park: ${st.tris} triangles drawn, ${st.collTris} collision triangles, ${st.draws} draw calls`);
      return how;
    });

    await T.step('stunt park: site, kicker jump + loop run', () => {
      const F = T.F; F.world.gust.set(0, 0, 0); F.world.gustT.set(0, 0, 0);
      const site = siteCheck(S);
      T.check('the site is dry, flat and clear (tree canopy included)', site.ok, site.why);
      const loop = loopRun(S, 'Dune Buggy', 'pilot');
      T.checks(judge({ loop: [loop] }, LOC));
    });

    await T.step('Dune Buggy: road start', () => roadCheck(T, 'Dune Buggy'));

    await T.step('Dune Buggy: into two buildings (the crash)', () => walls(T, parkAt));

    await T.step('Dirt Bike: at the arch + road start', async () => {
      const how = await begin('Dirt Bike', { landStart: 'park' });
      archCheck(T, 'Dirt Bike');
      roadCheck(T, 'Dirt Bike');
      return how;
    });

    for (const boat of ['Speedboat', 'Jet Ski']) {
      await T.step(`${boat}: at the water park`, async () => { const how = await begin(boat, { boatStart: 'waterpark' }); waterparkCheck(T, boat); return how; });
    }

    await T.step('start rule wiring', async () => { await wiringChecks(T, started); return `${started.length} starts: ${started.map((s) => `${s.name} ${s.start}`).join(', ')}`; });

    await T.step('no stunt site / water park warnings', () => {
      for (const [k, what] of [['stunts', 'stunt site'], ['waterpark', 'water park']]) {
        const w = siteWarns.filter((m) => m.startsWith(`[${k}]`));
        T.check(`no ${what} warnings`, !w.length, w.join('; ').slice(0, 600));
      }
    });
  } finally {
    console.warn = warn0;
  }
}

// ---------- the helipad ----------
function helipad(T) {
  const r = heliRun(T.F);
  T.checks(heliChecks(r));
  if (!r.hold) return `started at ${r.start}`;
  return `pad ${r.pad.name}: deck ${r.pad.deckY.toFixed(1)} m; hover band ${r.lift.hoverBand.toFixed(2)} m; touchdown ${(-r.land.touch?.vy || 0).toFixed(2)} m/s, ${r.land.off.toFixed(2)} m off the H`;
}

// ---------- cars and bikes (placecheck.py's stunts part) ----------
// where the flight's vehicle stands against World.landStart(where): distance from the spot, facing along its heading,
// any hull point inside a building or tree (after a second stepped with the brake on, as placecheck did)
function carAt(T, where) {
  const S = T.S, F = S.F, ac = F.ac, W = F.world, THREE = S.THREE, s = W.landStart(where);
  if (!s) return null;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(ac.q), ax = new THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading)), g = W.groundAt(ac.x.x, ac.x.z);
  let hit = 0; for (const p of ac.parts) for (const h of p.hull) if (W.treeHit?.(ac.worldPoint(h))) hit++;
  return { d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), car: !!ac.isCar, bike: !!ac.isBike, cfgStart: F.cfgStart, ground: g.type,
    onRoad: W.nearRoad ? W.nearRoad(ac.x.x, ac.x.z, 2) : null, hit, road: s.id === 'road' ? { x: Math.round(s.pos.x), z: Math.round(s.pos.z), dist: s.dist } : null };
}
function archCheck(T, name) {
  T.advance(1);
  const st = carAt(T, 'park');
  T.check(`${name} starts at the start arch, facing the first kicker`, st && st.car && st.d < 3 && st.fx > 0.95 && st.cfgStart === 'park',
    st ? `${st.d.toFixed(1)} m from the arch, heading ${st.fx.toFixed(2)}, started at ${st.cfgStart}${st.bike ? ' (bike)' : ''}` : 'no stunt park start here');
}
// The road start without a new flight: the rule (with this World's answers) must send this vehicle to World.landStart
// ('road') through buildFlight's 'park' spawn; the flight's vehicle is then put there as buildFlight puts it.
function roadCheck(T, name) {
  const F = T.F, ac = F.ac, p = predictStart(name, { landStart: 'road' }, F.world);
  T.check(`${name}: the start rule sends a road start to the road`, p.start === 'road' && p.spawn === 'park' && !!p.park, `start ${p.start}, spawn ${p.spawn}`);
  if (!p.park) return;
  T.S.controls.pedal.gas = 0; T.S.controls.keys.clear?.();
  ac.spawn(F.env, p.park.at(0), p.park.heading); // (buildFlight: ac.spawn(env, park.at(slot), park.heading))
  T.advance(1);
  const st = carAt(T, 'road');
  T.check(`${name} starts on the road, in its lane, facing along it`, st && st.d < 3 && st.fx > 0.95 && st.hit === 0,
    st ? `${st.d.toFixed(1)} m from the spot ${JSON.stringify(st.road)}, heading ${st.fx.toFixed(2)}, ground ${st.ground}, on a drawn road ${st.onRoad}, ${st.hit} hull points in a building` : 'no road start');
}

// The game loop's own runs into building faces near the park (placecheck.py's walls part), the second one the crash
// that's drawn (shadercheck's crash phase at New York). Stepped; only the crash's frames (and streaming quiet before
// it) drawn.
async function walls(T, near) {
  const S = T.S, F = T.F, ac = F.ac, THREE = S.THREE;
  const fs = faces(S, near || ac.x, { max: 2 });
  if (!fs.length) { T.check('in the game loop the Dune Buggy stays out of the buildings', false, 'no building faces found near the park'); return; }
  const runs = [], gentle = fs.length > 1 ? 1 : 0, f0 = fs[0];
  // the gentle run first (10 m/s at 35 deg, into the second face): after the crash it would be driving a wreck
  runs.push({ face: gentle, v: 10, a: 35, ...(await gameRun(S, fs[gentle], 10, 35)) });
  F.paused = false; // (gameRun pauses the flight when it's done)
  // then streaming quiet where the crash happens (the first face, 14 m out, where walls.js sets a straight-on run up),
  // so a late show in the drawn frames is the crash's own
  ac.spawn(F.env, new THREE.Vector3(f0.cx + f0.nx * 14, 0, f0.cz + f0.nz * 14), Math.atan2(f0.nx, f0.nz));
  await T.settle();
  const c0 = T.counters(), lost0 = ac.stats.partsLost;
  runs.push({ face: 0, v: 30, a: 0, ...(await gameRun(S, f0, 30, 0)) });
  F.paused = false;
  const lost = ac.stats.partsLost - lost0;
  await T.frames(5, { what: 'the crash drawn' });
  T.noLateShows('the crash drawn: nothing waited for its shader', c0);
  T.check('the crash happened (something broke off)', lost > 0, `${lost} parts lost at 30 m/s`);
  const worst = runs.reduce((a, x) => (x.maxPen > a.maxPen ? x : a));
  T.check(`in the game loop the Dune Buggy stays out of the buildings (${runs.length} runs)`, worst.maxPen <= TOL,
    `deepest ${worst.maxPen} m (${worst.v} m/s, ${worst.a} deg); closest to the face's middle: ${runs.map((x) => `${x.closest} m`).join(', ')}`);
  return runs.map((x) => `${x.v} m/s ${x.a} deg: ${x.maxPen} m in${x.dead ? ', dead' : ''}`).join('; ');
}

// ---------- boats (placecheck.py's waterpark part) ----------
function waterparkCheck(T, name) {
  T.advance(1);
  const F = T.F, ac = F.ac, P = F.world.waterParks, THREE = T.THREE;
  if (!P) { T.check(`${name} starts at the water park`, false, `New York has no water park (started at ${F.cfgStart})`); return; }
  const s = P.start, f = new THREE.Vector3(0, 0, -1).applyQuaternion(ac.q), ax = new THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading));
  const d = Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx = f.dot(ax), wet = ac.boat ? ac.boat.wet : 0, up = ac.up.y;
  T.check(`${name} starts at the water park, afloat, facing down the course`, d < 3 && fx > 0.95 && wet > 0.05 && up > 0.95 && F.cfgStart === 'waterpark',
    `${d.toFixed(1)} m from the start, heading ${fx.toFixed(2)}, wet ${wet.toFixed(2)}, up ${up.toFixed(2)}, started at ${F.cfgStart}`);
}
