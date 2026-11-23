# Smoke test

`smoke.py` boots Skywright in headless Chrome and checks that nothing is broken:

1. the page boots (WebGL context, `window.__sky`, splash gone)
2. audio initialises and every clip in `assets/sfx/index.json` decodes
3. the Settings and Help modals open and close
4. every preset in the hangar flies for 4 s at full throttle: the plane exists, its position and velocity are finite, the frame loop keeps running, and the flight ends cleanly back in the hangar (a motorbike rides off on the gas and must still be on its wheels)
5. screenshots of the hangar and of the first flight

Any console error, uncaught exception, or failed/404 request for a file of ours fails the step it happened in.
It prints PASS/FAIL per step with timings, and exits non-zero on any failure. A full run takes about 2 minutes.

## Running the tests: run.py, the Node tier and the browser tier

```sh
python3 tools/test/run.py              # everything
python3 tools/test/run.py --changed    # only suites covering what changed vs origin/main (and uncommitted files)
python3 tools/test/run.py bikeride     # named suites;  --list shows each suite's tier and the files it covers
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
  the browser tier.
- **Browser tier**: what needs a real page (boot, UI, audio, shader compiles, screenshots, the real game loop). Use
  `window.__sky.advance(seconds)` to step the flight without rendering (about 25–50× faster than waiting for frames;
  streaming that works to a per-frame time budget gets less done per game second, so let it settle when a check
  depends on it), and `window.__sky.swapVehicle(design)` to fly another vehicle in the same World (about 1 s instead
  of building a World).

`bikeride` is the reference Node suite: 77 checks in about 2.5 s, against 28 s in Chrome. Its results are identical
with and without `headless`.

## Run it

```sh
pip install websockets          # once
python3 tools/test/smoke.py     # serves the repo root itself on a free port; no server needed
```

| Flag | |
|---|---|
| `--only Kestrel` | fly just one preset (quick check, ~30 s) |
| `--keep` | keep the screenshots and print where they are (they are always kept on failure, with one per failed step) |
| `--out DIR` | write screenshots to DIR (implies `--keep`) |
| `--quality low` | graphics setting for the flights |
| `--min-realtime R` | fail a flight whose clock runs slower than R × realtime (default 0.25; 0 = any frame) |
| `--port N` / `--cdp-port N` | fixed ports for the static server / Chrome debugger (default: free ones) |
| `--shard I/N` | run part I of N: every Nth flight (each part boots and checks audio; part 1 also does the modals and hangar shot, the last part the SR-71 flights). CI runs 6 parts as parallel jobs |
| `--jobs N` | run all N parts at once, each in its own browser. Only faster on a quiet machine: with other sessions' tests running it is slower and flakier |

Each flight's line shows how long the flight took to start and end (`start 8.7 s, end 0.6 s`): starting it (building the
world, the stunt parks, the crew) is most of a step, the flying itself 4 s.

Chrome is found at the usual macOS path, or `google-chrome` / `chromium` on Linux. Set `CHROME=/path/to/chrome` to override.
On Linux it uses SwiftShader for WebGL (no GPU needed), which is how it runs in CI.

## When

**Before every merge to main.** Several sessions and agents merge all day, so run it on your branch after rebasing on
origin/main, right before `gh pr merge`. A FAIL means don't merge: fix it, or if the bug is someone else's, file an issue.

It also runs on every pull request (`.github/workflows/smoke.yml`, not a required check; screenshots are attached to
the run). That is a **reduced** check: GitHub's runners have no GPU, and software WebGL (SwiftShader) draws about one
flight frame every few seconds, so CI flies at `--quality low --min-realtime 0`. It still catches boot errors, missing
files, clips that don't decode, and presets that throw when a flight starts, but it doesn't really fly them. A green CI
run is not a substitute for running it locally.

When you add a preset, a sound clip or a modal, the test picks presets and clips up automatically.

It also flies the **SR-71 Blackbird** with an autopilot (`sr71flight.js`), in Pilot mode, through the real flight model
and world: the game starts the flight as a player would, then pauses its loop while the autopilot steps the aircraft
headless, much faster than real time (about 10 s for 10 minutes of flight).
- *climb*: runway start, take off, climb at about Mach 0.9 to 30,000 ft, dive gently through Mach 1, then climb on a
  Mach schedule to about 75,000 ft. Fails unless it goes faster than Mach 2.5 above 60,000 ft with nothing broken.
  Leaves `sr71-mach3.png` (the game running at Mach 3 for a moment, afterburners lit).
- *land*: Landing Challenge start (on final approach), fly the glide path, flare, touch down and brake. Fails unless it
  stops on the runway with nothing broken.
`--only 'SR-71 Blackbird'` runs just these (and its 4 s flight).

## Landing gear check

`gearcheck.py` builds every preset (as is, resized, mirrored) and seeded random player builds (gear, floats and skids
dropped on bodies, wings, wingtips, pods and flaps, some resized or rotated, all mirrored) and checks with double-sided
rays that no strut passes through a part (control surfaces included), every leg and brace ends on a solid skin, every
wheel stands upright, and mirrored gear mirrors. Six more builds drop gear on the speed parts (a Chined Body with a
thin wing, Spike Ramjets under it; their own seeded stream, `--speed N`). `--seed N --random K` for other builds,
`--dump` prints failing designs, `--url` checks another server (e.g. a build of main, for a before/after count). About
4 minutes.

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
without damage and standing straight. Then it starts every other preset and checks none of them is put on the pad;
with `--ref URL` (a server of main) their spawn poses must match main's exactly.

```sh
python3 tools/test/padcheck.py                                   # ~3 min
python3 tools/test/padcheck.py --ref http://127.0.0.1:9000 --all-spawns   # every preset at every location vs main
```

Run it when you change the pad, the launch stand (`uprightStage` in `hangar.js`) or the spawn code in `main.js`.

## Stunt park check

`stunts.py` visits every location's stunt park (`src/stuntPark.js`; sites found by `src/stuntSite.js`) and the Grand
Canyon's daredevil canyon jump (`src/evelJump.js`), and drives the stock Dune Buggy, Chomper, Dirt Bike and Sport Bike
through them on the real flight model (paused flight, stepped at a fixed 60 Hz from `stunts.js`, with scripted inputs:
gas plus a simple lane-keeping steer; gusts are zeroed so every run is the same), in Pilot and Arcade. At each
location it fails unless:

- the park's site is dry, flat and clear (no water, buildings, roads, woods, or tree canopy where the location asks
  for that);
- every car and bike starts at the start arch ("At the stunt park") and on a street ("On the road"), facing the right
  way, and no shader compiles mid-flight;
- the loop run (kickers or tabletop, boost, loop) gets air off the last jump and lands upright, goes over the top of
  the loop upside down with its wheels on the deck, and comes out upright in the exit lane, all parts intact;
- coasting into the loop at the boost pad's speed still makes it round, and far too slow it rolls back down;
- the mesa jump clears the gap and lands upright;
- the bowl is ridden at 14, 20 and 26 m/s, up the wall and back out upright on its wheels;
- from the start arch at full gas, hands off after the loop (as a kid rides it), every car and bike gets round the
  banked east turn, never over the barrier on its berm, and out upright onto straight 2; at the Grand Canyon that
  hands-off run takes the turn, not the link lane to the canyon jump, and one steered right at the fork goes down the
  link lane onto the canyon jump's run-up;
- at the Grand Canyon: a Kestrel set down on a mesa stands on it and one flown into a cliff hits it; the canyon jump's
  start is at its run-up; a scripted run (full gas, no steering) clears the real gap, lands upright on the far ramp and
  is stopped by the parachute; and a car too slow for it is lowered into the canyon by the rescue parachute.

```sh
python3 tools/test/stunts.py                              # all four locations, ~4 min
python3 tools/test/stunts.py --locations canyon --cars "Dune Buggy,Dirt Bike"
python3 tools/test/stunts.py --shots DIR                  # also screenshots of each park, the jump, cars mid-stunt
```

Run it when you change ground contact (`collide.js`, the contact code in `aircraft.js`), car or bike physics, the
parks, or the real-world data a site is found from.

## Water park check

`waterpark.py` visits the water park at every location with one (`src/waterPark.js`: Bora Bora's lagoon, the Hudson
off the Upper West Side, Lake Brienz; the Grand Canyon's Colorado is too narrow for one) and drives every stock boat,
and a kid's random boat builds, through it on the real flight model (paused flight, stepped at a fixed 60 Hz from
`waterpark.js`, with scripted inputs: full gas plus a lane-keeping steer; gusts zeroed). At each location it fails
unless:

- the park's site is open water: deep enough over the whole course, water in the margin round it, nothing built on it
  (overwater bungalows, piers), no bridge over it, and well clear of the marina and its channel;
- every stock boat that picks 'At the water park' starts at its arch, afloat and facing down the course, nothing
  compiles a shader mid-flight, and the park stays within 6 draw calls and 32k triangles;
- the MEGA JUMP from the start (Arcade and Pilot): the boost strip carries it up the ramp at its speed, it gets real
  air (over a second, more than 4 m up), clears the island / container barge / log raft, splashes down upright and
  keeps every part; the same for 8 random kid's boat builds (any hull, resized, any motor, extras) from the boost strip;
- the kickers' lane at each boat's own speed (a short boost before each kicker): over both and through the hoop,
  upright, nothing broken;
- the slalom (a boat following a line through the five gates) says PERFECT SLALOM, and the waterfall SPLASH!;
- flat out the wrong way into the back and the side of the MEGA JUMP ramp: nothing breaks off, it isn't wrecked.

Sim is flown too and reported, not judged (there's no help in the air: a nose-heavy boat can dive and capsize).
At a location without a water park a boat that picks it starts at the marina.

```sh
python3 tools/test/waterpark.py                              # all four locations, ~6 min
python3 tools/test/waterpark.py --locations nyc --boats "Jet Ski,Fireboat"
python3 tools/test/waterpark.py --shots DIR                  # also screenshots of each park and boats mid-jump
python3 tools/test/waterpark.py --shots DIR --shots-only     # just the site checks and the screenshots
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

It prints how long posing the crew takes per frame (mean and p95, ms) for each vehicle: the number to watch when
changing the arm solve.

```sh
python3 tools/test/riders.py                  # serves the repo itself, ~1 min
python3 tools/test/riders.py --only "dirt"    # one vehicle
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

```sh
python3 tools/test/gvision.py                 # ~1 min
python3 tools/test/gvision.py --only "viper"
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

```sh
python3 tools/test/boatride.py                     # serves the repo itself, ~3 min
python3 tools/test/boatride.py --only canyon       # just one marina
python3 tools/test/boatride.py --json out.json     # full report
```

Run it when you change `src/boat.js`, the boat parts (`src/boatParts.js`), `src/marina.js` or water contact in
`src/aircraft.js`.

## Wind tunnel check

`tunnelcheck.py` opens the wind tunnel for every stock vehicle in headless Chrome and fails if any of them: logs an
error; (planes) has a lift curve that doesn't rise and then stall as the angle of attack is swept from -10 to +30
degrees; reports forces or moments that differ from what a real flight substep integrates at the same state (a fresh
`Aircraft` in free flight at the same attitude, airspeed, controls and flaps, gravity and engine thrust taken out;
subsonic and supersonic, relative error over 1e-6); compiles a shader while it runs; runs slower than `--max-ms`
(default 50 ms a frame) or does more than `--max-cpu` ms of its own work a frame (default 12) while sweeping the angle
and swinging on the free pivot; or, when closed, leaves geometries or textures on the GPU (`renderer.info.memory`, no
higher than in the hangar before; a second visit must end exactly where the first did and compile nothing new).

```sh
python3 tools/test/tunnelcheck.py               # serves the repo itself, ~3 min
python3 tools/test/tunnelcheck.py --only Viper --shots /tmp/tunnel
```

Run it when you change `aircraft.js` (the aero model), `windTunnel.js`, `tunnelFlow.js` or `tunnelScene.js`.

## Rooftop helipad check

`helipadcheck.py` checks New York's rooftop helipads (`src/helipad.js`). It starts the stock Dragonfly at NYC (Pilot and
Arcade) and checks that it starts on the H of the 55 Water Street pad, level, facing the view, skids resting on the
deck, engines off, and that the building under the pad has no damage key. In calm air it then checks that:

- parked with the throttle closed, it settles onto its skids exactly as it does on the runway (same attitude and
  sink), then for 5 s it moves no more than it does there, with the rotor stopped, no contact and no damage;
- it lifts off to a steady hover 25 m up with no collision;
- it lands back on the pad gently (no hard landing) and rests there stably on both skids.

It then starts every other preset at NYC, and the Dragonfly at other locations, and checks that none starts on the
helipad. With `--ref URL` (a server of main) their spawn poses must match main's exactly.

```sh
python3 tools/test/helipadcheck.py --ref http://127.0.0.1:9000   # ~6 min
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

```sh
python3 tools/test/cockpitcheck.py                       # ~2 min
python3 tools/test/cockpitcheck.py --random 60 --seed 9  # more random builds
```

Run it when you change cockpit, seat or crew builders, or the camera's cockpit view. Smoke also visits every cockpit
view of every preset through the camera button's path.

## Start-up bakes check

`startbakes.py` checks that what the deploy bakes into `assets/boot` (`tools/bake/boot.py`) and what the game keeps for
the visit or on the device is exactly what it would work out itself:

- **cockpit views** (`src/stations.js`: which cabin linings cover the windows) of every stock vehicle: worked out with
  no cache, from the visit's cache, and from a bake round-tripped through JSON (as `views.json` and localStorage
  are): the same linings and the same settled eyes for every seat, and the cache really used for every seat that has
  linings;
- **stunt park sites** (`src/stuntSite.js` `findSite`) at every place that searches for one: the site the World
  planned == a fresh search on that World == the bake's (`bakeStuntSites`, as `boot.py` writes it); a second flight
  at the same place takes it from the visit's cache and gets the same site.

```sh
python3 tools/test/startbakes.py                                   # ~3 min
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

It prints the turning-circle table (radius and g per speed, per car and mode).

```sh
python3 tools/test/drivecheck.py                 # ~20 s
python3 tools/test/drivecheck.py --json out.json # every number
```

Run it when you change car physics (`steerAngle`, the tyres in `contacts`, `carAssist` in `aircraft.js`) or `drive.js`.

## Wall test

`walls.py` drives cars and bikes into buildings and fails if anything of theirs gets inside one. At New York (its city
boxes), Lauterbrunnen (a real village's OpenStreetMap buildings) and the Alpine Valley town (generated towns) it picks
building faces with a clear, flat run-up near the start and drives the Dune Buggy and the Dirt Bike into each at 5, 15,
30 and 45 m/s, straight on, at 35° and at 60° the other way, full gas, on the game's physics at 60 Hz
(`tools/test/walls.js`). Every hull point and wheel is checked against every building box nearby, every frame: none
may get more than 0.1 m inside (`--tol`), and the straight-on runs must reach the wall. A few runs then go through the
real game loop (the flight's own vehicle, the pedal held down, building damage and all). The buildings are read from
the world's own collision grids, not through `world.wallBoxes`, so the test doesn't trust the code it tests.

```sh
python3 tools/test/walls.py                      # ~70 s
python3 tools/test/walls.py --places nyc --no-game
```

Run it when you change `wallContacts` in `aircraft.js`, `world.wallBoxes`, or how towns, real places or New York file
their buildings.

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
flattened trees, are all whole after a restart in the same World, with the same spawn; 10 restarts (damage before every
other one) keep `renderer.info` geometries / textures, the program count and the scene's child count flat; the hangar
holds no World and a fresh start matches the restarts (spawn, memory); and a restart at every start type (runway, air,
stunt park, street, marina, water park, launch pad, and the helipad with `--places nyc`) keeps the World, starts the
same way at the same spot and rides / flies on for 4 s. About 2.5 minutes for one place.

```sh
python3 tools/test/restart.py [--places lauterbrunnen,nyc] [--restarts 10] [--quality low]
```

## Shader check

`shadercheck.py` flies vehicles at several locations one after another in ONE page session (default: the Kestrel and
the Dirt Bike, each at islands, canyon, nyc and back to islands) and fails if any shader program compiles after a
flight's loading screen (main.js's `[shaders] N compiled in flight` warning, a visible hitch). It prints how many
programs each flight compiled behind its loading screen, and the warning's program names on a failure.

```sh
python3 tools/test/shadercheck.py                                   # ~3 min
python3 tools/test/shadercheck.py --plane Rocket --loc nyc --loc canyon --quality high
```

Run it when you change shader warm-up (`warmShaders`, `compileAsync` in `main.js`), material patches that set
`customProgramCacheKey` (crew, cabin light, heat glow), or the lights, fog or environment a location sets up.
Note that `window.__inflightCompiles` counts over the whole page session: a test that stages extra vehicles mid-flight
(stunts.js, waterpark.js screenshots) must count per location, or the next location gets the blame (#145, #187).

## Frame benchmark

`bench.py` flies a preset off the runway at each location with the graphics held fixed (no adaptive resolution) and
prints JavaScript time per frame, the part spent inside rendering, draw calls and triangles. `--cpu-throttle 4`
slows the page towards a tablet's CPU. Use it before and after performance work; numbers only compare runs on the
same machine.

```sh
python3 tools/test/bench.py --cpu-throttle 4 --json before.json
```
