// What kind of vehicle a design is, for the words the game uses with it and what it says: FLY or DRIVE (SAIL for
// boats), "Flight time" or "Drive time", the start message, the driving modes, the voice callouts. The physics keeps its
// own flags (ac.isCar, ac.isBike, ac.isHeli...); this is the player-facing kind.
//   plane | heli | rocket | car | bike | boat
// A car with real wings (a flying car) is a plane here: it flies. A boat (st.boat, from boats.js once that lands) sails.
import { DRIVE } from './drive.js';

export function vehicleKind(st) { // st: analyze(design)
  if (st.boat) return 'boat';
  if (st.bike) return 'bike';
  if (st.heli) return 'heli';
  if (st.car && st.wingArea < 0.5) return 'car';
  if (st.rocket && st.vertical) return 'rocket';
  return 'plane';
}
// the same from a built Aircraft (callouts.js has one, not the design's analysis)
export function acKind(ac, st) {
  if (st) return vehicleKind(st);
  if (ac.isBoat) return 'boat';
  if (ac.isBike) return 'bike';
  if (ac.isHeli) return 'heli';
  if (ac.isCar && !ac.parts.some((p) => p.d.cat === 'wing')) return 'car';
  if (ac.isRocket && ac.rocketPure) return 'rocket';
  return 'plane';
}
export const isLand = (k) => k === 'car' || k === 'bike';

// The words for each kind. go: the big button; again / restart: the end and pause menus; time: the stats' clock;
// ready: the setup's title; verb / ing: "you'll fly alone", "you're flying alone"; landings: what the stats count.
const FLY = { go: 'FLY', verb: 'fly', ing: 'flying', again: 'Fly again', restart: 'Restart flight', time: 'Flight time', ready: 'Ready for take-off', check: 'Flight check', landings: 'Landings' };
const DRIVE_W = { go: 'DRIVE', verb: 'drive', ing: 'driving', again: 'Drive again', restart: 'Restart drive', time: 'Drive time', ready: 'Ready to drive', check: 'Drive check', landings: 'Jumps landed' };
const SAIL = { go: 'SAIL', verb: 'sail', ing: 'sailing', again: 'Sail again', restart: 'Restart voyage', time: 'Sailing time', ready: 'Ready to sail', check: 'Sea check', landings: 'Landings' };
export const WORDS = { plane: FLY, heli: FLY, rocket: FLY, car: DRIVE_W, bike: DRIVE_W, boat: SAIL };
export const words = (k) => WORDS[k] || FLY;

// The realism choice in the flight setup: planes, helicopters and rockets see the realism levels; land vehicles see
// the driving modes (drive.js), which fill the same three slots (arcade / pilot / sim), so saved settings, online
// sessions and the tests carry over.
const REAL_DESC = { arcade: 'Anything flies, even with one wing. Very hard to break.', pilot: 'Balance and drag matter a bit. Gentle stalls and some help.', sim: 'Real weight, balance, stalls, G-limits and hard landings.' };
const BIKE_DESC = { arcade: 'The rider balances for you. Wheelies and stoppies, and very hard to fall off.', pilot: 'Less help with balance. Wheelies and stoppies.', sim: 'Only a little balance help and no tricks: ride it yourself.' };
export function modeChoice(k, R) { // -> { label, name, desc } for realism level R ({ id, name })
  if (!isLand(k)) return { label: 'Realism', name: R.name, desc: REAL_DESC[R.id] || '' };
  const D = DRIVE[R.id] || DRIVE.pilot;
  return { label: 'Driving mode', name: D.name, desc: k === 'bike' ? BIKE_DESC[R.id] : D.desc };
}

// What the game says as you start: keyed by the vehicle kind and the start id ('runway', 'road', 'stunt', 'pad',
// 'air', 'water', 'approach'; the land-vehicle starts come from the start choices), with the kind's own fallback, then
// the plane's. c: { loc, rwy, stall (the take-off speed, already in the player's units), touch }
export function startMessage(k, start, c) {
  const pedals = c.touch ? 'GAS to go' : 'W to go', steer = c.touch ? 'steer with the stick' : 'A D to steer';
  const M = {
    car: {
      stunt: `Stunt park · ${c.loc}. ${c.touch ? 'GAS' : 'W'} to go: hit the ramps, loop the loop!`,
      runway: `Runway ${c.rwy} · ${c.loc}. ${pedals}, ${steer}!`,
      '*': `${c.loc}. ${pedals}, ${steer}!`,
    },
    bike: {
      stunt: `Stunt park · ${c.loc}. ${c.touch ? 'GAS' : 'W'} to go, lean into the turns, full gas for a wheelie!`,
      '*': `${c.loc}. ${pedals}, lean into the turns with the stick!`,
    },
    heli: {
      runway: `Helipad · ${c.loc}. Throttle up to the middle to lift off and hover!`,
      air: 'Hovering! Push the stick to fly forwards.',
      approach: 'On final approach. Slow down and hover over the runway, then let down gently.',
      '*': `${c.loc}. Throttle up to the middle to lift off!`,
    },
    rocket: {
      pad: `Launch pad · ${c.loc}. Full throttle to launch!`,
      '*': `${c.loc}. Full throttle and point the nose at the sky!`,
    },
    boat: { '*': `${c.loc}. Throttle up to sail, steer with the stick!` },
    plane: {
      pad: `Launch pad · ${c.loc}. Full throttle to launch!`,
      runway: `Runway ${c.rwy} · ${c.loc}. Throttle up and pull back gently at ${c.stall}!`,
      air: 'Airborne! Fly safe.',
      water: 'On the water. Full throttle and lift off!',
      approach: 'On final approach. Follow the PAPI lights: two white, two red.',
    },
  };
  const m = M[k] || M.plane;
  return m[start] || m['*'] || M.plane[start] || M.plane.runway;
}
