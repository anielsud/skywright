# Tests

`python3 tools/test/run.py` runs everything: the Node tier, then the browser jobs (`jobs.py`, below). CI runs the
same on every pull request. The sections after those two describe each suite and the older one-suite-one-browser
scripts, which still run on their own while their checks move into the jobs (#278).

## Smoke test (older script)

`smoke.py` boots Skywright in headless Chrome and checks that nothing is broken:

1. the page boots (WebGL context, `window.__sky`, splash gone)
2. audio initialises and every clip in `assets/sfx/index.json` decodes
3. the Settings and Help modals open and close
4. a tour of the places, one vehicle of each kind flown on the real game loop (`tools/test/smoke.js`): Bora Bora
   (Kestrel; the Albatross's water start and the Kite's air start as quick stepped checks; the Speedboat from the
   marina), the Grand Canyon (Dirt Bike, Dune Buggy from the stunt park), New York (the Dragonfly from the rooftop
   helipad, the Rocket from the pad), and Bora Bora built again (the SR-71's scripted flights, the Dirt Bike). Each
   place's World is built once and the next vehicle swapped into it (`__sky.swapVehicle`). A tour flight flies 2 s at
   full power on the real loop (frame loop keeps running, the engine of a car, bike or boat audible), 3 game seconds
   more stepped with `__sky.advance` (finite, in one piece, a bike upright and riding off), then draws every cockpit
   view as the camera button steps through them, and must leave the cockpit after the last seat.
5. **no shader stalls mid-flight** on a tour flight (main.js's `[shaders] N compiled in flight, stalling a frame`; formerly
   `shadercheck.py`): visiting the places in one session, a later place must not compile what an earlier one showed
   (the crew, #187), and the first place built again compiles nothing new either
6. every stock vehicle built and driven in Node (`tools/test/presets.js`, run alongside Chrome): built with its cockpit
   views, 6 s at full power on flat ground (water for a boat), finite and in one piece, a bike upright and moving, its
   engine voices known to the audio (a car's, bike's or boat's own motor voice), every cockpit view cycling
7. screenshots of the hangar and of the first flight

Any console error, uncaught exception, or failed/404 request for a file of ours fails the step it happened in.
It prints PASS/FAIL per step with timings, and exits non-zero on any failure. A full run takes about 70 s.

## Running the tests: run.py, the Node tier and the browser tier

```sh
python3 tools/test/run.py              # everything: the Node tier, then every browser job (in parallel)
python3 tools/test/run.py --changed    # only suites covering what changed vs origin/main (and uncommitted files)
python3 tools/test/run.py bikeride nyc # named suites and jobs;  --list shows each one's tier and the files it covers
python3 tools/test/run.py --ci nyc     # a job as CI runs it (jobs.py --ci --quality low)
```

Tests are in two tiers.

- **Node tier** (`tools/test/node/run.mjs`): logic, physics and geometry, with no browser. The game's own modules run
  in Node (`node/setup.mjs`: `three` resolved to the vendored build, plus small browser stand-ins: no-op canvases,
  localStorage, and `fetch` reading the repo from disk) on a pool of worker threads (cores − 2), one case at a time.
  A suite is a `tools/test/<name>.js` module listed in `SUITES` in run.mjs that exports `nodeSuite = { files,
  headless }`, `cases(ctx)` (plain case descriptors) and `runCase(c, ctx)` (that case's checks:
  `[{ name, ok, why }]`); `ctx.presets` is `makePresets()`. With `headless: true` the vehicle skips its purely visual
  detail (aircraft.js `HEADLESS`: the assembly pass and the per-frame crew posing). Set `SKY_VISUALS=1` to run with it,
  to prove a suite's results don't change. Nothing drawn is exercised in Node: textures, shaders and frames belong to
  the browser tier. A case may carry a `key` (cases with the same key, from any suite, go to the worker that ran the
  first: riders and gvision share `crew:<vehicle>`, so a crew built once is warm for the other) and a `cost` (rough
  seconds: costly cases go out first). A real location's World can be built in Node too (`node/world.mjs`, used by
  boatride's marinas; read its header for what differs from the browser's).
- **Browser tier**: what needs a real page (boot, UI, audio, shader compiles, screenshots, the real game loop): the
  browser jobs (`jobs.py`, next section). Use
  `window.__sky.advance(seconds)` to step the flight without rendering (about 25–50× faster than waiting for frames;
  streaming that works to a per-frame time budget gets less done per game second, so let it settle when a check
  depends on it), and `window.__sky.swapVehicle(design)` to fly another vehicle in the same World (about 1 s instead
  of building a World).

**Known failures:** `tools/test/known.json` lists failing checks that are already tracked (suite → check name →
issue). The Node runner reports them as `known` and doesn't count them. A listed check that passes is reported as
`fixed` (take it off the list). **CI** (`.github/workflows/smoke.yml`, "Tests") runs the whole suite on every PR, as
parallel jobs: the four browser jobs (one matrix entry each: `jobs.py <job> --quality low --ci`, screenshots attached
to the run) and the Node tier. There is no nightly run and no selection by what changed: everything, every time.
Where a runner's time goes: it has no GPU, so Chrome's software GPU (SwiftShader) builds every shader program a new
place needs (~100 at Low, ~0.3 s each) and draws a frame in 1-2 s whatever the window size; building a map takes
22-50 s and swapping a vehicle into it 10-30 s. Hence the jobs' rules below. Anything that reads a canvas back
(`getImageData`) asks for `willReadFrequently`, or it waits for that shader queue.

`bikeride` is the reference Node suite: 77 checks in about 2.5 s, against 28 s in Chrome. Its results are identical
with and without `headless`.

A suite that drives through a place builds its real World in Node (`node/world.mjs` `worldAt(id)`: the real data
loaded and the World built as main.js does, with a stand-in renderer and main.js's flight env; offline: the land
streamed in past the baked squares is left out). Everything found from heights, OpenStreetMap and the landcover map is
the same as in the browser (PNGs decode in Node: `setup.mjs`); the imagery's colours (JPEGs) don't, so nothing in Node
may depend on them (only New York's stunt site search does: its tree-canopy rule). A World takes 1–5 s to build and is
kept per worker; a case that needs one says so (`world: 'nyc'`) and the runner hands it to a worker that has it where
it can. `SKY_WORLD_LOG=1` prints each build.

## Browser jobs: jobs.py

```sh
python3 tools/test/jobs.py                      # every job, in parallel (one Chrome each), lines prefixed [job]
python3 tools/test/jobs.py nyc                  # one job
python3 tools/test/jobs.py hangar --keep        # keep the screenshots (always kept on failure)
python3 tools/test/jobs.py nyc --quality low --ci   # as CI runs it
```

A job is one headless Chrome, booted once, running `tools/test/jobs/<job>.js`'s `run(T)` in the page against flights
in a shared World. `T` (`tools/test/jobs/harness.js`; its header is the API reference) runs named steps (`T.step`),
checks (`T.check`), flights (`T.start`: the first at a place builds its World, every later one there swaps the
vehicle into it), game time stepped without drawing (`T.advance`, `T.stepUntil`), fixed frame counts (`T.frames`),
streaming quiet (`T.settle`) and screenshots (`T.shot`). Each step prints PASS/FAIL with its wall time, frames drawn
and game seconds stepped, its checks under it as they happen. A step fails if its code throws, a check in it fails, a
shader program compiles mid-flight during it (a stall), or the page logs a console error, throws, or a request for a
file of ours fails while it runs. The old suites' modules export the checks the jobs reuse against a running flight
(`smoke.js` `tour`/`tourChecks`, `padcheck.js` `rocket`/`rocketChecks`, `helipadcheck.js` `heliRun`/`heliChecks`,
`shadercheck.js` `sceneDrawn`/`eventsFired`/`crash`/`phaseChecks`, `startbakes.js` `stuntsIn`/`stuntsChecks`,
`tunnelcheck.js` `sweepStepped`/`pivotStepped`). `jobs/wiring.js` `wiringChecks(T, started)` checks the start rule's
wiring at the place a job is in: call it once per map, while it is up, with every `{ name, location, cfg, start }` the
job started there.

The rules (#278), which keep CI fast and free of timing flakes:
- **test only what needs testing**: for each check, the one observation that proves its claim, and only that work;
- **build each map once per job, swap each vehicle in once**; keep `T.BASE`'s time and weather (they are part of the
  World's key: changing them builds the map again);
- **step, don't draw**: game time with `T.advance`; frames (`T.frames(n)`, fixed counts) only for claims about drawing
  (shaders, cockpit views, the real loop running);
- **no wall-clock waits**: every wait is on a game state (`T.until`, `T.untilFrames`, `T.stepUntil`) or a frame count.
  Their limits are safety nets: generous, and they fail loudly naming what was awaited (a step's own safety timeout
  skips the rest of the job: the page is in an unknown state).

The jobs:

- **hangar** (no map): boot; the AudioContext starts (the only job with audio; the clips decode meanwhile and are
  checked last: every clip in `assets/sfx/index.json`); the Settings and Help windows open and close; a hangar
  screenshot; the wind tunnel for the Kestrel and the Dragonfly: opens, 5 frames drawn with the smoke on while the angle
  sweep starts, the rest of the sweep stepped to the end (the lift curve recorded over the whole range), 5 frames on the
  free pivot and 3 s more stepped (it swings), no shader compiled while it ran, (locally) the tunnel's own work per
  frame under 12 ms, closes, GPU memory back to the hangar's. (Its lift curves and forces: the Node suite tunnelcheck.)
- **nyc** (one New York World, built once; each vehicle swapped in once; the step list is `jobs/nyc.js`'s header):
  the stunt site New York planned == a fresh search == the bake (`stuntsIn`, right after the build); the Dragonfly in
  Pilot on the rooftop helipad, stepped (`helipadcheck.js` `heliRun`/`heliChecks`: its spawn pose, the building under the
  pad has no damage key, the runway resting baseline by teleporting the same Dragonfly to the runway, then 5 s parked,
  a lift to a 25 m hover, a landing and a rest, each compared with the runway); the shader sweep's scene and events
  (drawn: every hidden object shown, every event effect fired; this is the only job that fires them); the tour flight on
  the real loop and every cockpit view (drawn); the Dragonfly again in Arcade; the Rocket on the pad (hold + launch,
  stepped) and on the real loop; the Dune Buggy at the stunt park's arch, the site dry, flat and clear (tree canopy from
  the imagery) and its kicker jump and loop run, the road start (the rule's pick, the buggy teleported there as
  buildFlight puts it: in its lane, facing along the road), and the crash: two game-loop runs into building faces
  (nothing gets inside), the 30 m/s one drawn (no stall, nothing waited for its shader, something broke off); the Dirt
  Bike at the arch and on the road; the Speedboat and the Jet Ski at the water park's arch, afloat, facing down the
  course; the start rule's wiring (`jobs/wiring.js`: every vehicle started where `chooseStart` predicts with the
  World's answers; over every stock preset nothing but a rocket on the pad, nothing but a helicopter on the helipad);
  no stunt site or water park warnings.
- **islands**, **canyon-lauterbrunnen**: being written (#278); the planned steps are in each file's header.

## Run the smoke test (older script)

```sh
pip install websockets          # once
python3 tools/test/smoke.py     # serves the repo root itself on a free port; no server needed
```

| Flag | |
|---|---|
| `--only Kestrel` | fly just one preset (quick check, ~15 s): its tour step, or a flight at Bora Bora if the tour doesn't fly it |
| `--keep` | keep the screenshots and print where they are (they are always kept on failure, with one per failed step) |
| `--out DIR` | write screenshots to DIR (implies `--keep`) |
| `--quality low` | graphics setting for the flights |
| `--min-realtime R` | fail a flight whose clock runs slower than R × realtime (default 0.25; 0 = any frame) |
| `--flight-seconds S` | wall seconds each tour flight flies on the real loop (default 2) |
| `--no-node` | don't run the Node suite `presets` alongside (`run.py` runs it itself) |
| `--port N` / `--cdp-port N` | fixed ports for the static server / Chrome debugger (default: free ones) |
| `--shard I/N` | run part I of N: the tour's legs (places) k with k mod N = I - 1 (each part boots and checks audio; part 1 also does the modals, the hangar shot and the Node suite). CI runs 2 parts as parallel jobs |
| `--jobs N` | run all N parts at once, each in its own browser. Only faster on a quiet machine: with other sessions' tests running it is slower and flakier |

Each flight's line shows how it started (`new World in 4.5 s` or `swapped in in 1.3 s`, and the start it got): building
a place is most of the run, the flying itself 2 s.

Chrome is found at the usual macOS path, or `google-chrome` / `chromium` on Linux. Set `CHROME=/path/to/chrome` to override.
On Linux it uses SwiftShader for WebGL (no GPU needed), which is how it runs in CI.

## When

**Before every merge to main.** Several sessions and agents merge all day, so run the tests (`run.py`) on your branch
after rebasing on origin/main, right before `gh pr merge`. A FAIL means don't merge: fix it, or if the bug is someone else's, file an issue.

CI (`.github/workflows/smoke.yml`, not a required check) runs the browser jobs on every pull request instead of
smoke.py, at `--quality low --ci` on a runner with no GPU (software WebGL: a frame takes 1-2 s, so the jobs step game
time and draw only fixed frame counts). A green CI run is not a substitute for running the tests locally.

When you add a preset or a sound clip, the test picks it up automatically (the Node suite builds and drives every
preset); a new kind of vehicle wants a tour flight (`TOUR` in smoke.py).

It also flies the **SR-71 Blackbird** with an autopilot (`sr71flight.js`), in Pilot mode, through the real flight model
and world: the game starts the flight as a player would, then pauses its loop while the autopilot steps the aircraft
headless, much faster than real time (about 10 s for 10 minutes of flight).
- *climb*: runway start, take off, climb at about Mach 0.9 to 30,000 ft, dive gently through Mach 1, then climb on a
  Mach schedule to about 75,000 ft. Fails unless it goes faster than Mach 2.5 above 60,000 ft with nothing broken.
  Leaves `sr71-mach3.png` (the game running at Mach 3 for a moment, afterburners lit).
- *land*: Landing Challenge start (on final approach), fly the glide path, flare, touch down and brake. Fails unless it
  stops on the runway with nothing broken.
`--only 'SR-71 Blackbird'` runs just these.

## Landing gear check

`gearcheck.py` builds every preset (as is, resized, mirrored) and seeded random player builds (gear, floats and skids
dropped on bodies, wings, wingtips, pods and flaps, some resized or rotated, all mirrored) and checks with double-sided
rays that no strut passes through a part (control surfaces included), every leg and brace ends on a solid skin, every
wheel stands upright, and mirrored gear mirrors. Six more builds drop gear on the speed parts (a Chined Body with a
thin wing, Spike Ramjets under it; their own seeded stream, `--speed N`). `--seed N --random K` for other builds,
`--dump` prints failing designs, `--only TEXT` just the builds whose name contains it.

Node tier (`node tools/test/node/run.mjs gearcheck`, or `run.py gearcheck`): one case per build, a few seconds in all.
The random builds are made up front, in order (each one's placement reads the build so far), the way the hangar
places parts. The builds it checks leave out the near-only furniture (crew, rivets, the cabin light): the check never
looks at a near-only mesh and the gear is routed before any of it is built, so every ray meets exactly the same
surfaces at the same distances (`SKY_GEAR_NEAR=1` builds it all, to compare), at a seventh of the cost.

## Mesh check

`meshcheck.py` builds every stock vehicle plus 20 seeded random player builds (engines, canopies and car parts in
varied places, some resized, some mirrored) in headless Chrome, the way the hangar shows them (detail parts and the
assembly pass), and fails on:

- **open shells**: a connected, non-flat piece of an opaque one-sided mesh with a hole you could look into (a duct,
  nozzle, tyre or cowl with no inside surface, a missing end cap). Flat sheets (dials, decals) and double-sided or
  transparent materials are fine; a mesh whose hole is covered by design can say so with `userData.openOk = 'why'`
  (e.g. a cockpit opening closed by its tub and sill). A rim lying against another opaque surface (within 1 cm, the
  same reach the floating-parts check calls touching) is closed by it and doesn't count: a bezel standing on its panel,
  a gauge's can sunk into it. Glass never closes a rim: a hole behind glass is one you can see. Landing gear is
  skipped for now.
- **exhausts through glass**: each car engine's chosen exhaust path (`userData.exhaustPaths`) against the vehicle's glass.
- **floating parts**: every connected piece of every mesh (each instance of an instanced suspension link) must touch
  another piece, to within 1 cm, and all of them must hang together as one vehicle. Checked on every stock vehicle, on
  the 20 random builds re-placed the way the hangar places parts (`randomBuilds(n, seed, { placed: true })`: each part
  dropped onto the vehicle along a ray the way `Hangar.placement` seats a tapped part, mirrored copies on the partner),
  on 16 seeded random car builds (`carBuilds`: wheels dropped from below, an engine, cage, light bar and wing from
  above; some resized, resized as a whole or mirrored) and on 10 random bike builds (`bikeBuilds`: a bike frame, pod or
  buggy body, a fork wheel and a swingarm wheel of either kind dropped from below on the centreline, an engine dropped
  from above or below; some resized). Checked at rest and again with every wheel pushed 60 % up its travel and the
  steered wheels turned, so the moving suspension (carRig.js) has to follow, and the bike forks steer and slide and the
  swingarms swing. Crew (posed at runtime), prop discs, glows and registration decals are left out; a piece may opt out
  with `userData.floatOk = 'why'` (a deliberate gap). Each floating piece is reported with how far it is from the
  vehicle. `--placed N`, `--cars N`, `--bikes N` for more.
- **floating parts on the speed parts**: also 10 seeded random speed builds (`speedBuilds`: a Chined Body or another
  body with a delta wing through it, Spike Ramjets mid-wing, under the wing or on the body, All-Moving Fins dropped onto
  the engines or the tail and turned to a random cant, a Tandem Canopy dropped onto the top, retractable gear from
  below; some resized or mirrored), checked for open shells and floating parts. `--speed N`.

- **tube seams**: every vehicle, plus 16 seeded random tube-to-tube builds (`seamBuilds`: a body with a nose cone,
  tail cone, airliner nose, heli bubble, boom or another body bolted to an end, some at an angle, a few cm apart or into
  each other, sized to match or not, some rolled, whole builds resized or mirrored; a boom pushed into a body's tail).
  At each join the surface radius is sampled across the seam at 32 angles; a dip below the neighbouring skin deeper than
  0.6 % of the radius (at least 6 mm), or a turn of the shading normal of more than 10 deg between samples 2.5 % of the
  radius apart, fails. Glass and `userData.trim` (frames, flanges) are looked through. `--seams N` for more.

```sh
python3 tools/test/meshcheck.py                     # Node, all designs on a worker pool (about a minute)
python3 tools/test/meshcheck.py --only ck_bubble    # just the designs with that part (or name): seconds
python3 tools/test/meshcheck.py --json out.json     # full report
python3 tools/test/meshcheck.py --chrome            # the old way, in headless Chrome (same results, much slower)
```

It runs in Node (`tools/test/node/run.mjs meshcheck`, one case per design). The geometry is the game's own builders, so
the report is identical to the Chrome run's. Floating parts put every triangle of a vehicle in one grid, and tube seams
split big meshes into small proxies for the raycaster (`meshfast.js`). Both give the same answers as the old pairwise
versions on every design, many times faster.

Run it when you change part builders (`parts.js`, `partDetail.js`, `vehicleParts.js`) or the assembly pass.

## Launch pad check

`padcheck.py` checks the launch complex every location has (`src/launchpad.js`). At every location it starts the stock
Rocket and checks that it stands upright on the pad's stand, on its axis, held by the hold-down clamps with the engines
off; that it doesn't move, leave the deck or touch anything for 5 s; and that at full throttle the clamps let go once
the swing arm is clear and it climbs past the service tower without touching it (no hull point inside it, a gap kept),
without damage and standing straight (the hold and the burn are stepped 1/60 s at a time with `__sky.advance`, every
step checked). Then it asks the game's start rule (`src/startChoice.js` `chooseStart`, which `buildFlight` runs) with
that place's real answers where every stock vehicle would start for every start choice: only rockets on the pad; and
a plane and a car really start (swapped into the first place's World) where the rule says. The rule itself is tested
over every vehicle, choice and kind of place in Node (`startchoice`). With `--ref URL` (a server of main) the real
spawn poses must match main's exactly.

```sh
python3 tools/test/padcheck.py                                   # ~40 s
python3 tools/test/padcheck.py --ref http://127.0.0.1:9000 --all-spawns   # every preset started at every location vs main
```

Run it when you change the pad, the launch stand (`uprightStage` in `hangar.js`) or the spawn code in `main.js`.

## Start choice test

`startchoice` (Node tier) runs the start rule `buildFlight` uses (`src/startChoice.js` `chooseStart`) for every stock
vehicle (its `analyze()` and its built Aircraft's gear and engines), every start choice the flight setup offers (start,
mode, a car's land start, a boat's boat start) and every combination of what a place has (a rooftop helipad, a marina,
the pad free, a water park, a stunt park, a street start, the canyon jump, open water, someone online on the site).
Only rockets go on the pad and only helicopters on a helipad; rockets and helicopters do get them when they are free;
planes start on the runway; no wingless car starts in the air; boats start afloat or on the runway. About 2 s.

```sh
python3 tools/test/run.py startchoice      # or: node tools/test/node/run.mjs startchoice
```

## Stunt park check

`stunts.py` checks every location's stunt park (`src/stuntPark.js`; sites found by `src/stuntSite.js`) and the Grand
Canyon's daredevil canyon jump (`src/evelJump.js`), driving the stock Dune Buggy, Chomper, Dirt Bike and Sport Bike
through them on the real flight model (stepped at a fixed 60 Hz from `stunts.js`, scripted inputs: gas plus a simple
lane-keeping steer; gusts zeroed so every run is the same), in Pilot and Arcade.

Every place uses the same layout ('compact'), so the track, ramps, loop and bowl are the same mesh in the park's own
frame everywhere. What a place changes is its site, the ground levelled under it, the pad's height (the Grand Canyon's
is at 2,169 m: thinner air), the ground under the track (sand at the Grand Canyon), the wind, the theme (the mesa
jump's surfaces), the road start, and at the Grand Canyon the link lane and fork to the canyon jump. So the full set of
runs is driven once, and per place only what depends on the place. It is a Node suite (real Worlds built in Node:
`node/world.mjs`) plus a short browser check (`placecheck.py`):

- **reference park** (the compact layout on a flat lot), every car and bike, Pilot and Arcade: the loop run (kickers,
  boost, loop) gets air off the last kicker and lands upright, goes over the top upside down with its wheels on the
  deck, and comes out upright in the exit lane, all parts intact; coasting into the loop at the boost pad's speed
  still makes it round, and far too slow it rolls back down; the mesa jump clears the gap and lands upright; the bowl
  at 14, 20, 26 and 34 m/s, up the wall and back out upright on its wheels; from the start arch at full gas, hands off
  after the loop, round the banked east turn, never over the barrier on its berm, and out upright onto straight 2;
- **every place**: the site is dry, flat and clear (no water, buildings, roads, woods, or tree canopy where the place
  asks for that); every car and bike starts at the arch ('At the stunt park') and on a street ('On the road'), facing
  the right way, nothing of it in a building or a tree; the loop run from the arch (the run-up on the place's own
  ground, out into the exit lane) and the mesa jump (its theme's surfaces), in Pilot; no stunt site warnings;
- **the Grand Canyon**, Pilot and Arcade: the loop run and the mesa jump; hands off after the loop it takes the banked
  turn, not the link lane, and steered right at the fork it goes down the link lane onto the canyon jump's run-up; every
  car picks the canyon jump start at its run-up; the canyon jump (full gas, no steering) clears the real gap, lands
  upright on the far ramp and is stopped by the parachute; the long run-up from the park through the fork does too
  (and beside the rocket strip it is too slow: the rescue parachute); a car too slow for it is lowered into the canyon by
  the rescue parachute;
- **in the browser, at New York** (`placecheck.py`): New York's site with its tree canopy (the imagery, which doesn't
  decode in Node) and the loop run from its real arch; main.js starts a car and a bike at the arch and on the road;
  nothing compiles a shader mid-flight there (the other places: the shader check, `shadercheck.py` / `smoke.py`); no page errors.

New York's park in Node stands where the site search puts it without the canopy rule (a few tens of metres from the
game's): the park-frame runs there are the same, and the real site is checked in the browser.

```sh
python3 tools/test/stunts.py                         # Node tier + the browser check, ~30 s
python3 tools/test/stunts.py --node-only --only canyon
node tools/test/node/run.mjs stunts --only "Dirt Bike"
python3 tools/test/stunts.py --shots DIR --shots-only # screenshots of each park, the jump, cars mid-stunt
```

Run it when you change ground contact (`collide.js`, the contact code in `aircraft.js`), car or bike physics, the
parks, or the real-world data a site is found from.

## Water park check

`waterpark.py` checks the water park at every location with one (`src/waterPark.js`: Bora Bora's lagoon, the Hudson
off Liberty State Park, Lake Brienz; the Grand Canyon's Colorado is too narrow for one), driving every stock boat, and
a kid's random boat builds, through it on the real flight model (stepped at a fixed 60 Hz from `waterpark.js`, full gas
plus a lane-keeping steer; gusts zeroed). The course is the same everywhere; a place changes the site, the water level
(Lake Brienz is at 561 m), the swell (New York's harbour is twice as rough as the lakes), the wind and the MEGA JUMP's
obstacle (an island, a container barge, a log raft). A Node suite plus a short browser check (`placecheck.py`):

- **reference park** (Bora Bora's): every stock boat's MEGA JUMP from the start (Arcade and Pilot): the boost strip
  carries it up the ramp at its speed, it gets real air (over a second, more than 4 m up), clears the obstacle,
  splashes down upright and keeps every part (Sim is flown too and reported, not judged: there's no help in the air);
  the same for 8 random kid's boat builds from the boost strip; the kickers' lane at each boat's own speed, over both
  and through the hoop; the slalom says PERFECT SLALOM and the waterfall SPLASH!; flat out the wrong way into the back
  and the side of the MEGA JUMP ramp: nothing breaks off, it isn't wrecked;
- **every place with a water park**: the site is open water (deep enough over the whole course, water in the margin
  round it, nothing built on it, no bridge over it, well clear of the marina and its channel); the park stays within 6
  draw calls and 32k triangles (the merged meshes it builds: the browser draws the same count); every stock boat that
  picks 'At the water park' starts at its arch, afloat and facing down the course; every stock boat's MEGA JUMP in
  Arcade and Pilot (the place's swell and obstacle); no water park warnings. At the Grand Canyon none is built and a
  boat's start site is the marina;
- **in the browser** (`placecheck.py`): main.js starts a boat that picks the water park at New York's arch, afloat, and
  at the Grand Canyon at the marina; nothing compiles a shader mid-flight at New York; no page errors.

```sh
python3 tools/test/waterpark.py                      # Node tier + the browser check, ~25 s
node tools/test/node/run.mjs waterpark --only nyc
python3 tools/test/waterpark.py --shots DIR --shots-only
```

Run it when you change `src/waterPark.js`, boat physics (`src/boat.js`), hull contacts in `src/aircraft.js`,
`src/collide.js`, or the real-world water data a site is found from.

## Bike ride test

`bikeride.py` rides every stock motorbike through the game's own physics (flat ground, 60 Hz, no rendering) in Arcade,
Pilot and Sim, with the controls a player would use:

- **ride**: gas, a left turn, a right turn, a hard stop, a wait. It must stay upright (never picked up by the auto-flip),
  turn the way it is steered, lean, reach a decent speed, stop, and stand still and upright at the end.
- **wheelie** (Arcade, Pilot): full gas from a roll lifts the front, it stays below the loop-out limit, and comes back
  down onto both wheels when the gas is eased; holding full gas from a stop (the keyboard's W) launches on the back
  wheel, then puts the front down and gets going.
- **stoppie** (Arcade, Pilot): a full stop from 18 m/s lifts the back wheel, the nose stays within limits, it lands.
- **jump** (every mode): launched at 2.5 m and 15 m/s with a little nose-up, it lands upright on both wheels.
- **skid** (every mode): at 20 m/s the handbrake (SKID on a touch screen) locks the back wheel. Held straight it
  slows in a straight line and stays up; with the stick held over the tail swings out (Arcade/Pilot: a 20-50 degree
  slide, nose turned the way the stick pushes), it stays up (Sim may lean hard) and stops sooner than a straight skid.
- **a kid's own bikes**: hangar-placed random bike builds (`meshcheck.js` `bikeBuilds`, some on car wheels and a car
  engine, the wheels moved down until they are the lowest things on it) must be detected as bikes and ride without
  falling over; a build whose wheels don't both reach the ground is reported as SKIP.
- every other stock vehicle must not be detected as a bike.

```sh
python3 tools/test/bikeride.py                  # serves the repo itself, ~30 s
python3 tools/test/bikeride.py --json out.json  # full report, with samples
```

Run it when you change `src/bike.js`, the bike parts (`src/bikeParts.js`) or ground contact in `src/aircraft.js`.

## Crew rig test

`riders.py` steps every stock vehicle that carries people through the game's own physics (60 Hz, controls sweeping
to full throw, no rendering) and checks each person's skeleton every frame:

- **ride**: no hand lets go of an intact control, each hand bone sits at the end of its forearm (a grip out of reach is reached by bringing the shoulder
  forward a few centimetres, or let go; the skin between forearm and hand never stretches), no bone is more than
  1.5 m from the hips, no NaN.
- **fork lost** (every bike): the fork breaks off mid-ride and flies away. The rider must let go of the handlebars and
  stay in one piece, and posing the crew must not get more expensive afterwards.
- **landing** (every bike): a jump from 2.5 m at 15 m/s. The rider's knees must bend to soak up the landing (15
  degrees or more standing on the pegs, at least 2 sitting), come back afterwards, and the rider must go no more than
  1 cm further into the bike than when sitting still.
- **hard stop** (every bike): from 18 m/s, a hard brake to a stop. The rider braces with their hips back (6 cm or more
  standing, 2.5 sitting) without letting go or going more than 1 cm further into the bike, and is back in place once
  stopped. (The same brace moves the rider's weight in bike.js, so the bike can stop a little harder before the back
  wheel goes light.)
- **full gas** (every bike, Sim): full gas from a roll. The rider leans forward over the bars (hips forward 3 cm or more
  standing, 1 sitting) under the same rules, and is back in place once stopped. (In bike.js the lean keeps the front
  down, so less of the engine goes into lifting it.)
- **wheelie** (every bike, Arcade): full gas lifts the front and the rider sits back (2 cm or more standing, 1 sitting),
  keeping hold and staying out of the bike.

Each check carries how long posing the crew takes per frame (`msBefore` / `msAfter`: mean and p95, ms; in Node's
clock, comparable run to run, not with the browser's): the number to watch when changing the arm solve. `--json` keeps
them, and `riders.py` (the browser path) prints them.

It is a Node suite, not headless (the crew rig is the subject): one case per vehicle, a bike's six checks together.
Building a vehicle's crew is most of the cost, and a repeat build of the same design is much cheaper, so its cases
share a key with gvision's (`crew:<name>`) and run on the worker that has that vehicle warm.

```sh
node tools/test/node/run.mjs riders                   # ~5 s on a quiet Mac (8 workers)
node tools/test/node/run.mjs riders --only "dirt"     # one vehicle
node tools/test/node/run.mjs riders --json out.json   # every number, the posing cost too
python3 tools/test/riders.py                          # the same checks in headless Chrome (~25 s)
```

Run it when you change `src/crew.js` (the rig, the arm solve, cockpit obstacles) or how the riders get their grips
(`riderInput` in `src/bikeParts.js`).

## G-vision test

`gvision.py` checks the heavy-g haze in the cockpit view (`src/gvision.js`) and the cockpit eye that moves with the
pilot's g sway (`stationEye` in `src/stations.js`):

- **the haze**: a crash-sized one-frame spike and a hard landing never show; holding 7 g greys the view over seconds;
  a g-suit seat (jet, space crews) stays clear at 4.5 g where a light-plane pilot doesn't; -3 g reds it; it clears
  within 2.5 s of the g coming off and hides outside the cockpit view; and at its worst it is never opaque (edges at
  most 90%, the middle 50%), since the view must always be seen through and flown.
- **pull** (every stock vehicle with a seated crew): a full pull for 3.5 s. The eye follows the pilot's swing by no
  more than its seat's clamp (5 cm, or 40% of the seat's clearance: the near plane is at 50%) and comes back once the
  g is off.
- **stick stir**: stirring the controls (the head turns to look round) must not move the view any more than sitting
  still does: the view moves with g only.

It is a Node suite, not headless (the eye follows the crew rig's head): the haze model in one case (arithmetic on
numbers: no check reads the overlay's page elements back, so Node's stand-ins do), then one case per vehicle (keyed
with riders', see above). The numbers match the browser's to the last digit.

```sh
node tools/test/node/run.mjs gvision                  # ~5 s on a quiet Mac
node tools/test/node/run.mjs gvision --only "viper"
python3 tools/test/gvision.py                         # the same checks in headless Chrome (~35 s)
```

Run it when you change `src/gvision.js`, `stationEye`, or the g swing in `src/crew.js`.

## Boat ride test

`boatride.py` drives every stock boat through the game's own physics (60 Hz, no rendering) with the controls a player
would use: full gas, a left turn, a right turn, brake (reverse) to a stop, a wait.

- **open water** (a gentle swell), in Arcade, Pilot and Sim: it starts afloat and level; a planing hull gets up on the
  plane (Froude number > 1.2, the bow rises during the hump and is level again once planing), a displacement hull
  (the Pontoon, the Fireboat) reaches its hull speed; it turns both ways, never nearly capsizes, stops and is upright.
- **capsized** (Arcade, Pilot): dropped in upside down, it is set the right way up.
- **on land** at full gas: nothing moves, breaks or explodes; it just sits.
- **a kid's boats**: ten seeded random builds (any hull, maybe resized, a motor where the hangar would put it, maybe a
  cannon, a ballast block or a light bar) float, and the ones whose motor is in the water go.
- every other stock vehicle must not be detected as a boat.
- **at every marina** (Bora Bora, New York, Jungfrau, Grand Canyon): a flight is started there; the marina must exist
  with open water ahead of its start, and every stock boat, in Arcade and Sim, starts afloat and level within 120 m of
  it and does the ride in the real world (shore, docks, the docks' collision mesh). On the Colorado (a ~50 m channel)
  the turns are a slow S-bend after getting up on the plane. A Dune Buggy drives out along each harbour's pier.
  Every marina at Low (the tablet's setting: the coarsest terrain), the Grand Canyon's river landing at High too.

All of it is a headless Node suite. The open water and land are stand-in envs (as bikeride's flat ground); the marinas
are real Worlds built in Node (`node/world.mjs`: World with a stand-in renderer, and the env main.js gives a flight).
That World has the browser's heights, water, marinas and docks (the marina rides match a real flight's to the last
digit, or within a real flight's own run-to-run spread of 0.1°: the swell's phase follows the World's clock), but
nothing drawn, blank images (a real place's land-cover map reads as empty, so the stunt parks find no site), no
internet geodata past the baked squares, and some NaN real-place buildings: don't rely on it for those yet.
`--browser` runs the marinas in real flights in Chrome instead, to compare.

```sh
node tools/test/node/run.mjs boatride                # ~10 s on a quiet Mac
python3 tools/test/boatride.py                       # the same, printed as a table
python3 tools/test/boatride.py --only canyon         # just one marina
python3 tools/test/boatride.py --json out.json       # full report
python3 tools/test/boatride.py --browser             # the marinas in headless Chrome (3 browsers, ~20 s)
```

Run it when you change `src/boat.js`, the boat parts (`src/boatParts.js`), `src/marina.js` or water contact in
`src/aircraft.js`.

## Wind tunnel check

`tunnelcheck.py` checks the wind tunnel in two tiers.

- **Node** (`tunnelcheck` suite, every stock vehicle, ~3 s): the tunnel's physics with no scene (`WindTunnel.setup`:
  the Aircraft and starting state `open()` makes) fails if (planes) the lift curve doesn't rise and then stall as the
  angle of attack is swept from -10 to +30 degrees, or the forces or moments differ from what a real flight substep
  integrates at the same state (a fresh `Aircraft` in free flight at the same attitude, airspeed, controls and flaps,
  gravity and engine thrust taken out; subsonic and supersonic, relative error over 1e-6).
- **Browser** (`--ui`; Kestrel, opened twice, and Dragonfly, ~25 s; on CI and in `run.py`: the hangar job, stepped): opens the tunnel in
  headless Chrome and fails if the page logs an error; it compiles a shader while it runs; it runs slower than
  `--max-ms` (default 50 ms a frame) or does more than `--max-cpu` ms of its own work a frame (default 12) while
  sweeping the angle (90 frames) and swinging on the free pivot (60 frames); or, when closed, it leaves geometries or
  textures on the GPU (`renderer.info.memory`, no higher than in the hangar before; a second visit must end exactly
  where the first did and compile nothing new). Waits are frames, not seconds.

```sh
python3 tools/test/tunnelcheck.py               # both tiers
python3 tools/test/tunnelcheck.py --ui --only Viper --shots /tmp/tunnel
```

Run it when you change `aircraft.js` (the aero model), `windTunnel.js`, `tunnelFlow.js` or `tunnelScene.js`.

## Rooftop helipad check

`helipadcheck.py` checks New York's rooftop helipads (`src/helipad.js`). It starts the stock Dragonfly at NYC (Pilot and
Arcade) and checks that it starts on the H of the 55 Water Street pad, level, facing the view, skids resting on the
deck, engines off, and that the building under the pad has no damage key. In calm air it then checks that:

- parked with the throttle closed, it settles onto its skids exactly as it does on the runway (same attitude and
  sink; the baseline: the same Dragonfly teleported to the runway first and rested there in the game loop), then for 5 s it moves no more than it does there, with the rotor stopped, no contact and no damage;
- it lifts off to a steady hover 25 m up with no collision;
- it lands back on the pad gently (no hard landing) and rests there stably on both skids.

The flight is stepped with `__sky.advance`, every step checked; Arcade is swapped into the same New York. It then asks
the start rule (as padcheck does) with New York's real answers: only helicopters on the helipad, for every stock
vehicle and start choice; and a plane and a car really start where the rule says. (The Dragonfly elsewhere: padcheck
asks the rule at every place, and the Node suite `startchoice` over every kind of place. Shaders compiled mid-flight
at New York: smoke flies the Dragonfly there on the real loop.) With `--ref URL` (a server of main) the real spawn
poses must match main's exactly.

```sh
python3 tools/test/helipadcheck.py --ref http://127.0.0.1:9000   # ~20 s
```

Run it when you change the helipads, the city's building pipeline (`realCity.js`), ground contact or the spawn code.

## Cockpit check

`cockpitcheck.py` builds every stock vehicle (as is, resized, mirrored), multi-station builds (a bomber with a glass
nose, top, tail and belly gunners; twin cockpits; resized and turned canopies; an airliner nose on a cargo body; a heli
cabin; a mirrored capsule; a build with no cockpit) and seeded random player builds as flight `Aircraft`, and checks
every cockpit view (`Aircraft.stations`, `src/stations.js`, one per seat) the way it is drawn from that seat:

- **inside its cockpit**: the eye is within the box of its seat's part and figure. Only a canopy sunk into a body may
  put the eye above it, and the check confirms there really was no seat inside it that sees out (reported as a note),
- **not in solid geometry**: nothing within 3 cm, and not looking out through the backs of one-sided surfaces
  (10 of 14 directions),
- **clear forward view**: 3 of 5 rays ahead meet glass (with no wall right behind it) or nothing solid within 1.2 m.

It prints the stations of each vehicle ("Captain, First officer", "Pilot, Bomb aimer, Top gunner, ...").

It runs on the Node tier (`cockpitcheck` suite): a stock vehicle's three builds are one case (in order, so what the
game keeps from one build, its crew postures and cabin light bake, serves the next as before), every other build a
case of its own. Building the vehicles (crew postures, cockpit views, the cabin light) is about 90% of the work; the
ray tests only look at triangles within 3 m of the eye and skip any whose box the ray misses.

```sh
python3 tools/test/cockpitcheck.py                       # ~15 s on a quiet machine
python3 tools/test/cockpitcheck.py --random 60 --seed 9  # more random builds
```

Run it when you change cockpit, seat or crew builders, or the camera's cockpit view. Smoke also visits every cockpit
view of every preset through the camera button's path.

## Start-up bakes check

`startbakes.py` checks that what the deploy bakes into `assets/boot` (`tools/bake/boot.py`) and what the game keeps for
the visit or on the device is exactly what it would work out itself:

- **cockpit views** (Node tier, `startbakes` suite; `src/stations.js`: which cabin linings cover the windows) of a
  sample of the stock vehicles (every one with linings, and three without; `--presets all` for every one): worked out
  with no cache, from the visit's cache, and from a bake round-tripped through JSON (as `views.json` and localStorage
  are): the same linings and the same settled eyes for every seat, and the cache really used for every seat that has
  linings;
- **stunt park sites** (browser, `startbakes.py --only stunts`; moving into the map jobs as `stuntsIn`; `src/stuntSite.js` `findSite`) at every place that
  searches for one, in that place's World built as a flight builds it (at Low, no vehicle): the site the World planned
  == a fresh search on that World == the bake's (`bakeStuntSites`, as `boot.py` writes it); planning again there (what
  a second flight does) takes it from the visit's cache and gets the same site.

The deploy's bake checks every stock vehicle itself: `tools/bake/boot.py` reads its `views.json` and `stunts.json` back
and, through `startbakes.js` `verifyBake`, requires every stock vehicle's views from the bake alone to equal the views
worked out with no cache (no seat missing from it) and every stunt site to be exactly what `findSite` finds; otherwise
it removes those files and fails the deploy step. So the local check is a sample. (The stunt sites stay in the
browser: New York's search reads the satellite photo as the browser decodes and scales it.)

```sh
python3 tools/test/startbakes.py                                   # ~25 s
python3 tools/test/startbakes.py --only views --presets Jumbo      # one vehicle
python3 tools/test/startbakes.py --only stunts --locations islands # one place
```

Run it when you change `stations.js`, `stuntSite.js`, `stuntPark.js` or what they read, or `tools/bake/boot.py`.

## Car handling test

`drivecheck.py` drives every stock car (not the bikes) on flat ground through the game's own physics (60 Hz, no
rendering) in each driving mode: Easy, Racer and Pro (the Arcade / Pilot / Sim slots, `src/drive.js`). It fails unless:

- **turning circles** at 5, 10, 15, 20, 25 and 30 m/s with the stick hard over: a radius under 6 m at walking pace; at
  least 0.95 g of cornering in Easy and Racer (0.6 g in Pro) above it; the turn builds to 90 % within 0.45 s (Pro 0.9 s);
  never tipping, and in Easy and Racer no wheel in the air;
- **slalom** at 15 m/s, lock to lock every 1.2 s: the heading swings at least 36° (Pro 24°), on its wheels;
- **fishhook** at 20 m/s (full lock one way, then the other): Easy and Racer stay on their wheels (Pro may roll);
- **handbrake turn** at 18 m/s: Racer drifts (the tail out past 15°); Easy and Racer never spin out (under 50°) and
  straighten up when you let go;
- **brake and steer** from 20 m/s at once: with ABS (Easy, Racer) it still turns;
- **a kid's own cars** (`meshcheck.js` `carBuilds`, some tall and narrow): hard turns at 10 and 20 m/s and the fishhook
  keep them on their wheels in Easy and Racer.

It is a headless Node suite: one case per car and mode, the kid's cars in pairs (built once, in the main thread:
placing their parts the hangar's way costs more than driving them). Each car's first check carries its turning-circle
table as `info` (`--json`); `drivecheck.py` (the browser path) prints it as a table.

```sh
node tools/test/node/run.mjs drivecheck                  # ~4 s
node tools/test/node/run.mjs drivecheck --json out.json  # every number
python3 tools/test/drivecheck.py                         # the same checks in headless Chrome, with the table (~25 s)
```

Run it when you change car physics (`steerAngle`, the tyres in `contacts`, `carAssist` in `aircraft.js`) or `drive.js`.

## Rocket handling check

`rocketcheck.js` flies the Rocket preset on flat ground in still air (fixed 1/60 s steps, scripted stick, steering
relative to a fixed camera behind it):

- **hold** (Arcade, Pilot): launch, push the stick for 1.2 s (pitch over, then sideways), let go: the nose must turn at
  least 20°, then stay within 3° of where it settled 0.75 s after letting go for the next 6 s, and not swing back more
  than 2° towards where it started.
- **three fins** (Sim): a rocket with three fins copied round the body climbs hands off with no roll (under 2°/s), no
  lean (under 2°) and no sideways drift.

```sh
node tools/test/node/run.mjs rocketcheck     # a fraction of a second (headless Node suite)
python3 tools/test/rocketcheck.py            # the same checks in headless Chrome (~4 s)
```

Run it when you change the rocket attitude hold or fin aerodynamics in `aircraft.js`.

## Wall test

`walls.py` checks that cars and bikes driven into buildings stay out of them. What it must prove: the wall-contact code
(`wallContacts` in `aircraft.js`) keeps a vehicle out at any speed and angle, and every place's buildings reach it
(`world.wallBoxes`). A Node suite plus a short browser check (`placecheck.py`):

- **contact**: stand-in buildings on flat ground (square to the street like a town's; turned 27° like an OpenStreetMap
  footprint; a New York tower whose box starts 1.5 m above the street), the Dune Buggy and the Dirt Bike into each at 5,
  15, 30 and 45 m/s, straight on, at 35° and at 60° the other way, full gas, on the game's physics at 60 Hz. Every hull
  point and wheel is checked against the box every frame: none may get more than 0.1 m inside, and the straight-on runs
  must reach the wall;
- **New York** (its city boxes) and **Lauterbrunnen** (a real village's OpenStreetMap buildings), on real Worlds
  built in Node: every building in the place's collision grids is among
  `world.wallBoxes`, with its own box, asked at its middle and just outside each face; building faces with a clear,
  flat run-up near the start, and both vehicles into each at 30 m/s straight on and 15 m/s at 35°, staying out and
  reaching the wall. The buildings are read from the world's own collision grids, not through `world.wallBoxes`, so
  the test doesn't trust the code it tests;
- **in the browser** (`placecheck.py`): two runs through the real game loop at New York (the flight's own Dune Buggy,
  its pedal held down, building damage and all, stepped with `__sky.advance`) stay out too.

```sh
python3 tools/test/walls.py                          # Node tier + the browser check, ~20 s
node tools/test/node/run.mjs walls --only contact
```

Run it when you change `wallContacts` in `aircraft.js`, `world.wallBoxes`, or how towns, real places or New York file
their buildings.

## Building setbacks

`setbacks.js` (Node tier, #228) checks that no building footprint stands on a road, at every real place: each building
as the World built it (Lauterbrunnen, the Grand Canyon and Bora Bora: the footprints `RealScenery` kept; New York: every
city.bin record through `CityScenery.footprint`, the low ones too) against every road's clear zone, its tarmac and
gravel verge (on a city street: tarmac and pavement), measured with the test's own sampled geometry, not `setback.js`'s.
Tunnels' tubes and bridge decks up in the air are left out. Also: few buildings dropped (most are cut back), few big
ones left standing over a road that runs right through them (a passage under them), and the setbacks cost little at
load. The collision boxes: none on a road; none reaching more than 1 m past the walls near a street (an L, a U, a cross
or a trapezoid gets a few boxes that hug its walls, `setback.js footBoxes`, worked out when first wanted); together
they cover the footprints (95% of their area, at most 1% of buildings under 90%); and an irregular building's boxes
are still one building to `destruction.js`. Standalone, it prints the counts before and after and the worst spots:

```sh
node tools/test/node/run.mjs setbacks
node --import ./tools/test/node/setup.mjs tools/test/setbacks.js lauterbrunnen    # before / after counts
```

Run it when you change `setback.js`, road widths, verges or pavements, or how the real places build their buildings.

## Place check (browser)

`placecheck.py` is the browser part of the stunt park, water park and wall tests, in one headless Chrome and one New
York World (it has the stunt park, the water park and the city), then the Grand Canyon: what needs the real page or the
imagery (see each test above). Its checks are moving into the nyc and canyon jobs (#278); `stunts.py`, `waterpark.py` and `walls.py`
run their part of it (`--only stunts|waterpark|walls`).

## Restart test

`restart.py` checks that a restart (pause > Restart, or the "try again" button after a crash) keeps the World and
looks and behaves exactly like a fresh start. `main.js` keeps the World (and its scene) for a restart when its inputs
are unchanged (`World.key`: place, quality tier, time, weather, moon), and `World.reset()` puts back what the flight
changed: buildings (`Destruction.reset`: collision heights, the shader's dmg bytes, damage slots, debris, mounds,
scorch marks, cavities, fires, toppling tops, pending dominoes), flattened trees (`World.flatten`), the stunt sites,
water park and launch pad, the space view, the clocks, gusts and cloud drift. Everything else the flight added to the
scene (the vehicle, effects, traffic, missions, debris, other players) is removed and rebuilt. Back to the hangar
frees the World as before.

At each place (Lauterbrunnen by default) it checks: buildings knocked down and holed through the destruction API, plus
flattened trees, are all whole after a restart in the same World, with the same spawn; 6 restarts (damage before every
other one) keep `renderer.info` geometries / textures, the program count and the scene's child count flat (a leak of
one a restart shows over the last five); the hangar holds no World and a fresh start matches the restarts (spawn,
memory); and every start type (runway, air, stunt park, street, marina, water park, launch pad, and the helipad with
`--places nyc`), swapped into that fresh World, restarts in the same World, the same way at the same spot, and rides /
flies on for 4 s. The game's time is stepped with `__sky.advance` wherever the test waits for the game (buildings
coming down, flying on); each start also draws 15 frames before it is measured (the texture count is what drawing
uploads). About 40 s for one place.

```sh
python3 tools/test/restart.py [--places lauterbrunnen,nyc] [--restarts 6] [--quality low]
```

## Shader check

How shaders are kept from stalling a frame (#273):
- **The loading screen** compiles everything in the scene (`compileAsync` in `main.js`), and its first frame draws
  every hidden shadow caster for the shadow shaders (`warmShaders`).
- **Things added after it** (streamed tiles, street cars, late models, other players) compile between frames and wait
  hidden until ready (`flushNew`): at worst they show a few frames late. Nothing has to be registered.
- **Events must show at once** (crash, explosion, collapse, splash, boom), so their objects are pooled and in the
  scene at load (a sonic boom's rings: one hidden ring from the start). Never make an event's mesh or material when
  it fires.
- **Per-place switches are uniforms, not defines** (#242: a define made a second terrain program for the tiles).
- Give custom materials a `name`: the check's messages print it.

`shadercheck.py` (folding into the per-map jobs, #278: `shadercheck.js` exports the phases) sweeps each place on purpose rather than
by luck (`sweep` in `shadercheck.js`): every object in the scene drawn (hidden ones shown, culling off), every event
effect fired, the map's edges streamed in, and a real crash (a building in New York, water at the islands, the ground
elsewhere). It fails on any **stall** (a program compiled during a frame's draw: `[shaders] N compiled in flight,
stalling a frame`, `window.__inflightCompiles`) and on any event that **waited for its shader**
(`window.__lateShows` outside the streaming phase). Before the event and crash phases the vehicle is held until
streaming around it is quiet, so a late show there is the phase's own.

```sh
python3 tools/test/shadercheck.py                      # islands, canyon, nyc, lauterbrunnen with the Kestrel, ~4 min
python3 tools/test/shadercheck.py --loc nyc --plane Rocket --quality high
python3 tools/test/shadercheck.py --fly                # the older check: a few seconds of flight per place in turn
```

`--fly` flies vehicles at several places one after another (default: the Kestrel and the Dirt Bike, each at
islands, canyon, nyc and back to islands): a later place must not compile what an earlier one showed (the crew,
#187). Note that `window.__inflightCompiles` counts over the whole page session: a test that stages extra vehicles
mid-flight (stunts.js, waterpark.js screenshots) must count per location, or the next location gets the blame
(#145, #187).

## Frame benchmark

`bench.py` flies a preset off the runway at each location with the graphics held fixed (no adaptive resolution) and
prints JavaScript time per frame, the part spent inside rendering, draw calls and triangles. `--cpu-throttle 4`
slows the page towards a tablet's CPU. Use it before and after performance work; numbers only compare runs on the
same machine.

```sh
python3 tools/test/bench.py --cpu-throttle 4 --json before.json
```
