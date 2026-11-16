# Smoke test

`smoke.py` boots Skywright in headless Chrome and checks that nothing is broken:

1. the page boots (WebGL context, `window.__sky`, splash gone)
2. audio initialises and every clip in `assets/sfx/index.json` decodes
3. the Settings and Help modals open and close
4. every preset in the hangar flies for 4 s at full throttle: the plane exists, its position and velocity are finite, the frame loop keeps running, and the flight ends cleanly back in the hangar
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
- **floating parts on cars**: the stock cars plus 16 seeded random car builds (`carBuilds`: a body, wheels dropped from
  below and an engine, cage, light bar and wing dropped from above the way the hangar places them; some resized,
  resized as a whole or mirrored). Every connected piece of every mesh (each instance of an instanced suspension link)
  must touch another piece, to within 1 cm, and all of them must hang together as one vehicle. Checked at rest and
  again with every wheel pushed 60 % up its travel and the steered wheels turned, so the moving suspension (carRig.js)
  has to follow. Crew (posed at runtime), prop discs, glows and registration decals are left out. `--cars N` for more.

```sh
python3 tools/test/meshcheck.py                 # serves the repo itself, ~2 min
python3 tools/test/meshcheck.py --json out.json # full report
```

Run it when you change part builders (`parts.js`, `partDetail.js`, `vehicleParts.js`) or the assembly pass.
