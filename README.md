# Skywright

Build a plane from parts, then fly it (and crash it) in a 3D world. Runs in a desktop browser or on an Android tablet, and installs as an app (PWA). Nothing to build: plain ES modules and a vendored copy of three.js r170.

## Play

```sh
python3 -m http.server 8000   # any static server works
open http://localhost:8000
```

On a tablet, host it over HTTPS (for example GitHub Pages). Tilt steering and offline install need a secure origin. In Chrome, use "Add to Home screen" to get a full-screen landscape app. There are also Android and iPad app shells for sideloading onto our own tablets: see [native/README.md](native/README.md).

## What's in it

**Hangar**
- 40 parts in 7 groups: bodies, cockpits, wings, tails, engines, gear and extras.
- Tap a part, then tap the plane to attach it. Mirror mode places side parts in pairs.
- Move, rotate, flip or paint any part, or remove it.
- Undo and redo.
- Save planes, or share one as a copy-paste code.
- Live flight check: mass, thrust-to-weight, wing area and stall speed. A balance meter (yellow dot = centre of mass, blue dot = centre of lift) and plain-English warnings such as "Tail-heavy".
- Wind tunnel (`src/windTunnel.js`): the design as a scale model on a sting in a glass test section, with smoke streamlines from a rake, wingtip vortices, separated smoke over a stalled wing and shock cones above Mach 1. Sliders for wind speed (a breeze to Mach 3), angle of attack, sideslip, elevator, ailerons, rudder and flaps; arrows for lift, drag and side force against the weight; gauges for lift, drag, lift-to-drag, stall angle and pitch/yaw stability; a lift-against-angle chart; tips in plain English. "Free pivot" lets the model swing in pitch and yaw so you can see whether it weathervanes back into the wind or flips round. The forces are the flight model's own (`Aircraft.aeroAt`, the function every flight step uses); the smoke is a potential-flow sketch sized from them (`src/tunnelFlow.js`).

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
- Locations: Alpine Valley, plus real places built from real elevation, aerial or satellite imagery and OpenStreetMap data (`tools/realworld/bake.py`, `src/realworld.js`): the Grand Canyon (the South Rim villages, Phantom Ranch, the Colorado River and the North Rim, from Grand Canyon National Park Airport; it replaced the fictional Red Canyon and keeps its id, `canyon`), the Jungfrau Region (Interlaken, Lauterbrunnen, Eiger, Mönch and Jungfrau) and Bora Bora (Mt Otemanu, the lagoon and its reef, the motus and their overwater bungalows, with Taha'a, Raiatea and Maupiti on the horizon; the lagoon and reef depths are estimated from the imagery by `tools/realworld/sea.py`). Bora Bora replaced the fictional Coral Islands and keeps its id (`islands`). New York City: LaGuardia, Manhattan's skyscrapers, the Statue of Liberty, Central Park and the bridges, with every building in the city (`tools/realworld/city.py`, `src/realCity.js`).
- Time-of-day sky, stars and moon.
- Seven weather types, including thunderstorms with lightning and thunder. Clouds you can fly through.
- Wind, gusts, ridge lift and thermals.
- Runway lights and PAPI lights.
- Traffic: cars and trucks with headlights, bird flocks (bird strikes!), hot-air balloons, boats and a plane flying the circuit.

**A living world**
- **Roads:** a ring road, highways, town streets and long bridges (one crosses the sea to the volcano island).
- **Traffic:** 8 kinds of procedurally modelled vehicles (cars, SUVs, pickups, vans, buses, lorries and tankers). They follow lanes, keep their distance, show brake lights, and use headlights at night.
- **Towns:** houses, apartments, shops, churches and stations. Building style follows the location: chalets in the Alps, adobe in the desert, painted houses, thatched resorts and overwater bungalows on Bora Bora. Windows light up at night, chimneys smoke, and street lamps glow.
- **Farmland:** fields of crops (pivot-irrigation circles in the desert), plus farms with barns and silos, and grazing sheep or cows.
- **Plants:** procedural trees in many variants (pines, broadleaf, birch, palms, saguaro cacti, shrubs, rocks), with near/far detail levels and grass near the ground.
- **More life:** a railway with a train in the mountains and the desert, wind turbines, a helicopter shuttle, a radio mast, and boats in the Bora Bora lagoon.
- **Obstacles:** you can crash into buildings and trees. Buildings break the way you hit them (`src/destruction.js`): a small hit punches a hole or knocks off a corner or the roof, a big one brings the whole building down in a cloud of dust, and a skyscraper hit high up loses its top (the floors pancake down, or the top section topples off). Debris wears the building's own walls, glass towers shower glass, and the rubble smoulders. You can fly through the gap afterwards. Damage lasts the whole flight.

**Graphics**
- High-resolution baked terrain textures with ambient occlusion and soft sun shadows from the mountains.
- Per-pixel blending of grass, rock and snow.
- Height fog with sun glow, so valleys get hazy at dawn.
- Water shader with depth colour, lagoons, shoreline foam and sun glints.
- Clouds lit from the sun's side, with silver linings.
- Swaying trees.
- Panel lines and rivets on aircraft skins.
- HDR bloom, lens flare, colour grading and a camera shake on crashes.

**Audio**
- All sound is synthesized with the Web Audio API, with no sound files.
- Engines are positioned in 3D, and reverb changes by location (hangar, mountain echoes, canyon walls).
- Ambient sound: birdsong, gulls, surf and crickets at night.
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
| `src/effects.js`, `src/billboard.js` | Particles and instanced billboards |
| `src/roads.js`, `src/vehicles.js`, `src/flora.js`, `src/towns.js` | Road/rail network, traffic, vegetation, towns and landmarks |
| `src/shaders.js`, `src/post.js` | Height fog, terrain/water/foliage shaders, post-processing |
| `src/sky.js`, `src/clouds.js` | Physically based sky (atmosphere LUT, aerial perspective, stars, cirrus) and lit cumulus / overcast cloud layers |
| `src/audio.js` | Synthesized sound |
| `src/controls.js`, `src/cameras.js`, `src/hud.js` | Input, cameras, HUD |
| `src/missions.js` | Ring Race and Landing Challenge |
| `src/hangar.js` | The builder |
| `src/main.js` | App flow, menus, flight loop |

`window.__sky` exposes the app state for debugging and headless tests.

## Credits

Ground textures in `tex/` are CC0 from [Poly Haven](https://polyhaven.com) (aerial_grass_rock, aerial_rocks_02, aerial_beach_01, dry_ground_rocks, cliff_side).

Building and town materials in `tex/towns/` are CC0 from [ambientCG](https://ambientcg.com) (Plaster001, Plaster007, WoodSiding001, WoodSiding008, WoodSiding009, Planks037A, Bricks085, Bricks076A, RoofingTiles003, RoofingTiles013A, RoofingTiles014A, CorrugatedSteel009, ThatchedRoof001A, PavingStones128, PavingStones142, Gravel023, Asphalt031, Grass005, Concrete034), packed into one colour / normal / roughness sheet by `tools/towns/bake_materials.py`. Windows, doors, shutters, signs, railings and the rooms behind the glass are painted procedurally on top at start-up.

The sky's atmosphere model (Rayleigh/Mie/ozone coefficients, single scattering into a sky-view lookup table) follows Eric Bruneton's *Precomputed Atmospheric Scattering* and Sébastien Hillaire's *A Scalable and Production Ready Sky and Atmosphere Rendering Technique* (EGSR 2020); the code is our own.
The Moon (`assets/moon/moon_256.jpg`, `src/moon.js`): the near side, re-projected face-on, from the [NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720) colour map (`lroc_color_poles_1k.jpg`, built from Lunar Reconnaissance Orbiter LROC WAC mosaics) by `tools/moon/bake.py`; NASA, public domain, credited anyway. Its phase is today's real one.
Real-world locations (`assets/real/`, baked by `tools/realworld/bake.py`):
- Satellite imagery (Jungfrau Region and Bora Bora): [Sentinel-2 cloudless](https://s2maps.eu) 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Shadows lifted and colours graded for the game.
- Aerial imagery (Grand Canyon): [NAIP](https://www.fsa.usda.gov/programs-and-services/aerial-photography/imagery-programs/naip-imagery/) (USDA Farm Service Agency, National Agriculture Imagery Program) via the USGS [National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) NAIP ImageServer, public domain; credited anyway. Shadows lifted for the game; the forest mask comes from its colours.
- Aerial imagery (New York): [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) "Imagery Only" tile cache (mostly USDA NAIP), public domain.
- Building footprints, roof heights and construction years (New York): [NYC Open Data](https://opendata.cityofnewyork.us/) "Building Footprints" by the NYC Office of Technology and Innovation, under the [NYC Open Data terms of use](https://www.nyc.gov/home/terms-of-use.page). Packed with OpenStreetMap building parts into `assets/real/nyc/city.bin.gz`.
- Elevation: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen / Tilezen terrarium tiles; sources include USGS 3DEP (in the US), SRTM, GMTED, ETOPO1 and EU-DEM, see their attribution page).
- Sea floor (Bora Bora): estimated from the Sentinel-2 imagery above (satellite-derived bathymetry, `tools/realworld/sea.py`), not surveyed depths; summit heights of a few peaks from OpenStreetMap.
- Buildings, roads, railways, cable cars, piers, coastlines, lakes, rivers, forests, peaks and place names: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the Open Database License (ODbL); `assets/real/*/osm.json` and `cover.png` are derived databases under the same licence.

Hangar (`src/hangarEnv.js`, `assets/hangar/`): CC0 [Poly Haven](https://polyhaven.com) surface scans (hangar_concrete_floor, box_profile_metal_sheet, corrugated_iron_02, metal_plate, plywood, concrete_block_wall, asphalt_floor, rubber_tiles) baked to WebP by `tools/hangar/bake.py`, and CC0 Poly Haven models (tool_cart, metal_tool_chest, metal_toolbox, steel_frame_shelves_02, Barrel_01, Barrel_02, old_military_compressor, portable_welding_cart, portable_generator, propane_tank, wooden_crate_01, wooden_crate_02, korean_fire_extinguisher_01, ladder_sectioned_01, wall_clock, drill_press_01, bench_vice_01, hand_truck, metal_jerrycan, old_tyre, metal_office_desk, WetFloorSign_01, cardboard_box_01, industrial_storage_cart, spray_paint_bottles, plastic_jerrycan, cement_bag, power_box_01, tire_pump) simplified and packed into `props_512.glb` / `props_256.glb` by `tools/hangar/models.mjs` (fetch both with `tools/hangar/fetch.py`). The building, benches, shelving, engine stand, wing jig, the aircraft under construction, tug, fuel bowser, signs, posters and floor markings are generated in code. `vendor/addons/GLTFLoader.js` and `meshopt_decoder.module.js` are from three.js r170 (MIT; the decoder is meshoptimizer, MIT).

Vegetation (`src/flora.js`): the foliage atlas `assets/flora/foliage_*.webp` is assembled by `tools/flora/build_atlas.py` from CC0 [Poly Haven](https://polyhaven.com) leaf, twig, bark and fern scans (fir_tree_01, pine_tree_01, island_tree_02, shrub_02, shrub_04, fern_02, jacaranda_tree); grass blades, flowers, desert scrub and birch bark are drawn by the same script; boulders reuse the CC0 Poly Haven rock textures above (aerial_rocks_02, cliff_side).
