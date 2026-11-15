// Player-facing release notes, newest first. Shown in the "What's new" popup after an update.
// When you bump VERSION in src/version.js, add an entry here with the same version, written for players
// (what they can see or do now), not for developers.
export const CHANGELOG = [
  { v: '1.23.0', items: [
    'Bigger, busier towns: chalets with balconies in the mountains, colourful cottages and hotels with pools on the islands, and adobe houses, motels and water towers in the desert. Farms have barns, silos and fences.',
    'The airport has real hangars, a terminal and a control tower, and at night lots of windows light up.',
  ] },
  { v: '1.22.0', items: [
    'The hangar sounds like a real workshop now! Parts go on with a “brrrt” from the air wrench, removed parts clang onto the concrete, paint hisses out of a spray can, turning a part clicks a ratchet and sliders tick as you drag them.',
    'Loading a plane rattles the toolbox, and you can hear a busy workshop far off in the background (turn it down with the World slider).',
  ] },
  { v: '1.21.0', items: [
    'Shiny new planes: real panel lines and rivets, glossy paint that reflects the sky, see-through canopies with a seat and dashboard inside, and proper rows of windows on airliners.',
    'Lights! Red and green lights on the wingtips, flashing white strobes and a red beacon on the tail — they look great at night.',
  ] },
  { v: '1.20.0', items: [
    'Every airport now has two side-by-side runways, 36L and 36R, joined by taxiways, so there is room for a friend to take off next to you.',
  ] },
  { v: '1.19.0', items: [
    'Go supersonic! Push a jet past the sound barrier for a vapour cloud, a sonic BOOM and “MACH 1!”. Go really fast with rockets and your plane glows red, then orange, then white-hot. Watch your Mach number and skin temperature on the screen.',
  ] },
  { v: '1.18.1', items: [
    'Flying with a keyboard? A new box in the bottom-left corner shows your throttle, where your stick is pointing and your rudder, so you always know what the plane is being told to do.',
  ] },
  { v: '1.18.0', items: [
    'Fly past the edge of the map and the land now looks just the same: same colours, rocks, forests and lakes, with no line where it changes.',
  ] },
  { v: '1.17.1', items: [
    'Fixed: the “What’s new” popup was skipping some updates (like helicopters!).',
  ] },
  { v: '1.17.0', items: [
    'Real music: a cheerful tune in the hangar, a dreamy one when you cruise up high, and a heroic one during missions. It fades away near the ground so you can hear your landing. Set the Music volume in Settings.',
  ] },
  { v: '1.16.0', items: [
    'Cars! The new Car tab has a Car Engine, Car Wheels, Steering Wheels and giant Monster Wheels. Throttle to go, stick to steer, pull the stick back to reverse. Try the ready-made Dune Buggy.',
    'Flipped your car? Wait two seconds and it pops back onto its wheels (Arcade and Pilot).',
  ] },
  { v: '1.15.0', items: [
    'Cockpit voice callouts: it counts down your height as you land (“fifty… forty… thirty…”), says “Rotate” and “Positive rate” on takeoff, and warns “Stall!”, “Sink rate!”, “Pull up!” and “Too low, gear!”. Turn them off in Settings.',
  ] },
  { v: '1.14.0', items: [
    'Sharper ground up close: hills, valleys and runways near you have much more detail.',
  ] },
  { v: '1.13.0', items: [
    'This “What’s new” popup! After each update it tells you what changed. Find it again any time in Settings.',
  ] },
  { v: '1.12.0', items: [
    'Helicopters! Build one with a main rotor, tail rotor and skids, or try the ready-made Dragonfly. They can hover.',
  ] },
  { v: '1.11.0', items: [
    'Sound travels: you see a jet fly past before you hear it, far-away planes sound muffled, and jets are loudest behind them.',
  ] },
  { v: '1.10.0', items: [
    'Real recorded sounds for wind, tyres on the runway, rain, thunder, birds, waves and crashes.',
  ] },
  { v: '1.9.0', items: [
    'Brand-new mountains carved by rivers and rain, with real rock, grass and snow textures on the ground.',
  ] },
  { v: '1.8.1', items: [
    'Afterburners work again!',
  ] },
  { v: '1.8.0', items: [
    'Engines: set how powerful each engine is, and how long rockets burn.',
  ] },
  { v: '1.7.0', items: [
    'Engines now use real recordings that change pitch as you throttle up.',
  ] },
  { v: '1.6.3', items: [
    'One-tap 💾 Save button at the top of the hangar.',
  ] },
  { v: '1.6.2', items: [
    'Hangar: easy arrow pads to move and turn parts. Hold to go faster.',
  ] },
  { v: '1.6.1', items: [
    'Better sound mix, with volume sliders for engines, world, effects and music in Settings.',
  ] },
  { v: '1.6.0', items: [
    'Hangar: resize any part (wingspan, size and more) with sliders and fine +/- buttons.',
  ] },
  { v: '1.5.0', items: [
    'Fly together! Multiplayer with friends on the same Wi-Fi.',
    'The map never ends: keep flying and new land appears.',
  ] },
];

// Compare dotted versions numerically ('1.10.0' > '1.9.0').
export function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Entries newer than `seen`, up to and including `current`, newest first.
export function changesSince(seen, current) {
  return CHANGELOG.filter((e) => newer(e.v, seen) && !newer(e.v, current));
}
