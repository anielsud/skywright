// Where a flight starts: the start choice (the flight setup's start, land start and boat start) turned into the start
// this vehicle really gets at this place, and how it is put there. Pure: everything it needs to know about the place
// comes in as `w` (main.js buildFlight passes the World's answers), so the rule can be tested over every vehicle and
// every choice without building a World (tools/test/startchoice.js).

export const BOAT_STARTS = ['marina', 'waterpark', 'water', 'runway']; // boats' start choices (flightCfg.boatStart): afloat at the marina (the default), at the water park's start arch (where there is one: waterPark.js), out on open water, or sat on the runway
export const LAND_STARTS = ['park', 'road', 'evel']; // cars' and bikes' start choices besides the runway (flightCfg.landStart; World.landStart)
// An amphibian (a car or bike with a boat hull) can also start afloat: at the marina or out on the water.
export const AFLOAT_STARTS = ['marina', 'water'];

// st: analyze(design). cfg: the flight config (start, landStart, boatStart, mode). w: the place and the vehicle:
//   gearOK         it has wheels or skids that can stand on a runway (not only floats)
//   hasEngine      it has an engine (a glider starts in the air)
//   water()        open water to start on (main.js findWater), or null
//   site(st)       the place's own start for this kind of vehicle (World.startSite: a rooftop helipad, the marina), or null
//   siteBusy(site) online: someone is already on that site
//   padOK()        the launch pad's stand fits this vehicle and nobody is on the pad
//   landStart(s)   a car's or bike's start ('park', 'road', 'evel': World.landStart), or null
//   waterPark()    the water park's start arch, or null
// Returns { start, spawn, site, park, wpark, at }: start is the start id (F.cfgStart); spawn says how to put it there:
//   'waterpark' (afloat at wpark), 'afloat' (at the site `at`, floating), 'stand' (standing on `site`), 'park' (at
//   park), 'runway', 'pad', 'water' (at `at`, the water spot) or null (start 'air' / 'approach': placed after this).
export function chooseStart(st, cfg, w) {
  // cars and bikes have their own start choices (LAND_STARTS), the stunt park by default; an amphibian (with a boat
  // hull) may pick a boat's start instead (AFLOAT_STARTS), and then starts as a boat does
  const afloatStart = st.car && st.boat && !st.heli && AFLOAT_STARTS.includes(cfg.landStart);
  const land = st.car && !st.heli && !afloatStart;
  let start = land ? (LAND_STARTS.includes(cfg.landStart) ? cfg.landStart : 'park') : afloatStart ? cfg.landStart : st.boat ? (BOAT_STARTS.includes(cfg.boatStart) ? cfg.boatStart : 'marina') : cfg.start; // (boats: BOAT_STARTS, the marina by default)
  if (cfg.mode === 'landing' && !st.boat) start = 'approach';
  else if (start === 'water' || (start === 'runway' && st.floats && !w.gearOK)) start = 'water';
  if (start === 'runway' && !w.hasEngine && !st.boat) start = 'air';
  if (st.boat && (start === 'water' || (start === 'marina' && !w.site(st))) && !w.water()) start = 'runway'; // no water here at all: it sits on the runway
  if (st.car && st.wingArea < 0.5 && (start === 'air' || start === 'approach')) start = 'runway'; // cars without wings start on the ground
  if (st.vertical && start !== 'water') start = w.padOK() ? 'pad' : 'runway'; // rockets launch standing on their tail
  const park = land && start !== 'runway' && cfg.mode !== 'landing' ? w.landStart(start) : null; // cars and bikes: the stunt park's arch, a street or the canyon jump (World.landStart)
  if (!park && LAND_STARTS.includes(start)) start = 'runway'; // (none here: the runway)
  // a place's own start for this kind of vehicle (world.sites: New York's helicopters on a rooftop helipad), if nobody is on it
  const site = !park && cfg.mode !== 'landing' && ((start === 'runway' && !st.boat) || start === 'marina') ? w.site(st) : null; // (boats: the marina, when they pick it)
  if (start === 'marina' && !site) start = 'water'; // (no marina here: any open water)
  const wpark = start === 'waterpark' ? w.waterPark() : null; // boats: the water park's start arch (waterPark.js)
  if (start === 'waterpark' && !wpark) start = w.site(st) ? 'marina' : 'water'; // (none here: the marina)
  let spawn = null, at = null;
  if (wpark) spawn = 'waterpark'; // afloat at the arch, facing the boost strip and the MEGA JUMP
  else if (start === 'marina' && !site) { const s2 = w.site(st); if (s2) { start = s2.kind; spawn = 'afloat'; at = s2; } else start = 'water'; } // (no water park here: the marina)
  else if (site?.afloat) { start = site.kind; spawn = 'afloat'; at = site; } // a boat floats at its waterline (Aircraft.spawn), side by side online
  else if (site && !w.siteBusy(site)) { start = site.kind; spawn = 'stand'; } // standing on it, engines off
  else if (park) spawn = 'park';
  else if (start === 'runway') spawn = 'runway';
  else if (start === 'pad') spawn = 'pad';
  else if (start === 'water') { const p = w.water(); if (p) { spawn = 'water'; at = p; } else start = 'air'; }
  return { start, spawn, site, park, wpark, at };
}
