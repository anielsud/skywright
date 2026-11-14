# Skywright

Build a plane from parts, then fly it (and crash it) in a 3D world. Runs in a desktop browser or on an Android tablet, and installs as an app (PWA). Nothing to build: plain ES modules and a vendored copy of three.js r170.

## Play

```sh
python3 -m http.server 8000   # any static server works
open http://localhost:8000
```

On a tablet, host it over HTTPS (for example GitHub Pages). Tilt steering and offline install need a secure origin. In Chrome, use "Add to Home screen" to get a full-screen landscape app.

## What's in it

**Hangar**
- 40 parts in 7 groups: bodies, cockpits, wings, tails, engines, gear and extras.
- Tap a part, then tap the plane to attach it. Mirror mode places side parts in pairs.
- Move, rotate, flip or paint any part, or remove it.
- Undo and redo.
- Save planes, or share one as a copy-paste code.
- Live flight check: mass, thrust-to-weight, wing area and stall speed. A balance meter (yellow dot = centre of mass, blue dot = centre of lift) and plain-English warnings such as "Tail-heavy".

**Starter planes (9)**

| Plane | What it is |
|---|---|
| Kestrel | Trainer |
| Viper | Afterburning jet |
| Tempest | Warbird taildragger |
| Twin Pod | Two bodies joined by one wing |
| Albatross | Floatplane |
| Jumbo | 4-engine airliner |
| Centipede | 14 engines, props and jets |
| Kite | Sailplane |
| Firecracker | Rocket delta |

**Flight model**
- Every lifting surface is a set of strips with its own lift and drag curves, including stall.
- Forces come from where each part actually sits on the plane: thrust lines, prop torque, weight and balance.
- Controls are mixed automatically, so canards, V-tails and twin booms work without setup.
- Gear uses spring suspension with steering and brakes. Floats work on water.

**Realism**

| Mode | Behaviour |
|---|---|
| Arcade | Anything flies, even with one wing. Very forgiving. |
| Pilot | Balance and drag matter. Gentle stalls, some assistance. |
| Simulator | Real torques, sharp stalls, G-limits, gear that snaps on hard landings. |

**Damage**
- Each part has hit points.
- Impacts dent and crumple the meshes.
- Hard landings snap gear. Wings fail from over-G.
- Broken parts fall off with everything attached to them and tumble as debris.
- Fire, smoke, sparks, explosions, plus slow motion on big crashes.

**World**
- Three locations: Alpine Valley, Coral Islands and Red Canyon.
- Time-of-day sky, stars and moon.
- Seven weather types, including thunderstorms with lightning and thunder. Clouds you can fly through.
- Wind, gusts, ridge lift and thermals.
- Runway lights and PAPI lights.
- Traffic: cars and trucks with headlights, bird flocks (bird strikes!), hot-air balloons, boats and a plane flying the circuit.

**Audio**
- All sound is synthesized with the Web Audio API, with no sound files.
- Engines: piston, radial, turboprop, electric, jet, turbofan and rocket. Engine sound has Doppler on fly-bys.
- Wind, tyres, crash noises, stall horn, rain, thunder, and gentle hangar music.

**Modes**
- Free Flight.
- Ring Race: rings follow the valleys. Best times are saved.
- Landing Challenge: a score out of 1000, plus stars.

**Controls**
- Keyboard and gamepad.
- On a tablet: on-screen stick, throttle and rudder, or tilt steering.
- Five cameras: chase, cockpit, orbit, tower and fly-by.
- Photo mode (`H`).

## Keyboard

| Key | Action |
|---|---|
| ↑ ↓ / W S | Pitch (↓ pulls the nose up) |
| ← → / A D | Roll |
| Q E | Rudder (and steering on the ground) |
| Shift / Ctrl, R / F, 1–0 | Throttle |
| B | Brakes |
| G | Gear |
| V | Flaps |
| Space | Smoke |
| C | Camera |
| H | Hide HUD |
| Esc / P | Pause |

## Code map

| File | What it does |
|---|---|
| `src/parts.js` | Parts library: procedural meshes plus physics data (surfaces, engines, gear) |
| `src/design.js` | Design model, mirroring, balance analysis, presets, share codes |
| `src/aircraft.js` | Rigid-body flight model, ground contact, damage, deformation, break-up, debris |
| `src/world.js` | Terrain, water, sky, lighting, weather, clouds, airport, trees, village |
| `src/traffic.js` | Cars, birds, balloons, boats, the circuit plane |
| `src/effects.js`, `src/billboard.js` | Particles and instanced billboards (shared with clouds) |
| `src/audio.js` | Synthesized sound |
| `src/controls.js`, `src/cameras.js`, `src/hud.js` | Input, cameras, HUD |
| `src/missions.js` | Ring Race and Landing Challenge |
| `src/hangar.js` | The builder |
| `src/main.js` | App flow, menus, flight loop |

`window.__sky` exposes the app state for debugging and headless tests.
