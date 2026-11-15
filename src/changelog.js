// Player-facing release notes, newest first. Shown in the "What's new" popup after an update.
// When you bump VERSION in src/version.js, add an entry here with the same version, written for players
// (what they can see or do now), not for developers.
export const CHANGELOG = [
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
