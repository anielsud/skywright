# Smoke test

`smoke.py` boots Skywright in headless Chrome and checks that nothing is broken:

1. the page boots (WebGL context, `window.__sky`, splash gone)
2. audio initialises and every clip in `assets/sfx/index.json` decodes
3. the Settings and Help modals open and close
4. every preset in the hangar flies for 4 s at full throttle: the plane exists, its position and velocity are finite, the frame loop keeps running, and the flight ends cleanly back in the hangar (a motorbike rides off on the gas and must still be on its wheels)
5. screenshots of the hangar and of the first flight

Any console error, uncaught exception, or failed/404 request for a file of ours fails the step it happened in.
It prints PASS/FAIL per step with timings, and exits non-zero on any failure. A full run takes about 2 minutes.

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

## Landing gear check

`gearcheck.py` builds every preset (as is, resized, mirrored) and seeded random player builds (gear, floats and skids
dropped on bodies, wings, wingtips, pods and flaps, some resized or rotated, all mirrored) and checks with double-sided
rays that no strut passes through a part (control surfaces included), every leg and brace ends on a solid skin, every
wheel stands upright, and mirrored gear mirrors. `--seed N --random K` for other builds, `--dump` prints failing
designs, `--url` checks another server (e.g. a build of main, for a before/after count). About 4 minutes.

## Mesh check

`meshcheck.py` builds every stock vehicle plus 20 seeded random player builds (engines, canopies and car parts in
varied places, some resized, some mirrored) in headless Chrome, the way the hangar shows them (detail parts and the
assembly pass), and fails on:

- **open shells**: a connected, non-flat piece of an opaque one-sided mesh with a hole you could look into (a duct,
  nozzle, tyre or cowl with no inside surface, a missing end cap). Flat sheets (dials, decals) and double-sided or
  transparent materials are fine; a mesh whose hole is covered by design can say so with `userData.openOk = 'why'`
  (e.g. a cockpit opening closed by its tub and sill). Landing gear is skipped for now.
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

```sh
python3 tools/test/meshcheck.py                 # serves the repo itself
python3 tools/test/meshcheck.py --json out.json # full report
```

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

`stunts.py` starts a car at the Grand Canyon, where cars begin in the stunt park (`src/stuntPark.js`), and drives the
stock Dune Buggy and Chomper through it on the real flight model (paused flight, stepped at a fixed 60 Hz from
`stunts.js`, with scripted inputs: gas plus a simple lane-keeping steer; gusts are zeroed so every run is the same),
in Pilot and Arcade. It fails unless:

- the car starts at the start arch facing the first kicker, with no shader compiled mid-flight;
- the loop run (kickers, tabletop, boost, loop) gets air off the tabletop and lands upright, goes over the top of the
  loop upside down with its wheels on the deck, and comes out upright in the exit lane, all parts intact;
- coasting into the loop at the boost pad's speed still makes it round, and far too slow it rolls back down;
- the canyon jump clears the gap between the mesas and lands upright;
- the bowl is ridden at 14, 20 and 26 m/s, up the wall and back out upright on four wheels;
- a Kestrel set down on a mesa stands on it, and one flown into a cliff hits it.

```sh
python3 tools/test/stunts.py                      # ~30 s
python3 tools/test/stunts.py --shots DIR          # also screenshots of the park and of cars mid-stunt
```

Run it when you change ground contact (`collide.js`, the contact code in `aircraft.js`), car physics or the park.

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
- **a kid's own bikes**: hangar-placed random bike builds (`meshcheck.js` `bikeBuilds`, some on car wheels and a car
  engine, the wheels moved down until they are the lowest things on it) must be detected as bikes and ride without
  falling over; a build whose wheels don't both reach the ground is reported as SKIP.
- every other stock vehicle must not be detected as a bike.

```sh
python3 tools/test/bikeride.py                  # serves the repo itself, ~30 s
python3 tools/test/bikeride.py --json out.json  # full report, with samples
```

Run it when you change `src/bike.js`, the bike parts (`src/bikeParts.js`) or ground contact in `src/aircraft.js`.
