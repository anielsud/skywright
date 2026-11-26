// The start rule's wiring, for the per-map jobs (#278): main.js buildFlight runs src/startChoice.js chooseStart with
// the World's answers. This checks, with no extra flight started, that
//   - every vehicle the job really started here started where the rule predicts for it (the same rule over the same
//     answers: padcheck.js answers / vehicleInfo), and nothing but a rocket on a pad, nothing but a helicopter on a
//     helipad;
//   - over every stock preset and every start choice (cheap logic, no swaps), the rule puts nothing but a rocket on the
//     launch pad and nothing but a helicopter on a helipad; and that it does put a rocket on the pad (every place has
//     one) and, where the place has a helipad, a helicopter on it.
// (The rule itself over every vehicle, choice and kind of place: the Node suite tools/test/startchoice.js.)
//
//   wiringChecks(T, started)   started: [{ name, location, cfg, start }], one per vehicle the job started at the place
//       whose World is running now (name: a preset's name or a design; cfg: what the job passed to T.start over
//       T.BASE; start: what T.start returned as `start`, F.cfgStart). Call it while that World is up: once per map, with
//       the vehicles started there (an entry from another place fails, naming it). Makes T.checks; returns nothing.
//   predictStart(name, cfg, world = the running World) -> chooseStart's { start, spawn, park, ... } for a vehicle with
//       T.BASE + cfg (what buildFlight would pick), for a check that moves a vehicle to a start instead of starting it.
import { chooseStart } from '../../../src/startChoice.js';
import { answers, vehicleInfo, predict } from '../padcheck.js';
import { BASE } from './harness.js';

const sky = () => window.__sky;
const designOf = (name) => {
  if (typeof name !== 'string') return name;
  const d = sky().presets.find((p) => p.name === name); if (!d) throw new Error(`no stock vehicle named ${name}`);
  return d;
};
const label = (name) => (typeof name === 'string' ? name : name?.name ?? 'a design');
const choice = (cfg) => Object.entries(cfg || {}).filter(([k, v]) => ['start', 'mode', 'landStart', 'boatStart', 'realism'].includes(k) && v !== undefined).map(([k, v]) => `${k} ${v}`).join(', ');

export function predictStart(name, cfg = {}, world = sky().F?.world) {
  if (!world) throw new Error('predictStart: no World running');
  const S = sky(), d = designOf(name);
  return chooseStart(S.analyze(d), { ...BASE, location: world.loc?.id, ...cfg }, { ...vehicleInfo(d), ...answers(world) });
}

export async function wiringChecks(T, started) {
  const S = sky(), F = S.F;
  if (!F) { T.check('the start rule: a World to check it in', false, 'no flight running: call wiringChecks while the place is up'); return; }
  const W = F.world, here = W.loc?.id;
  for (const { name, location, cfg = {}, start } of started) {
    const what = `${label(name)}${choice(cfg) ? ` (${choice(cfg)})` : ''}`;
    if (location !== here) { T.check(`${what} at ${location}: starts where the start rule says`, false, `not checked: the World running is ${here} (call wiringChecks once per map, while it is up)`); continue; }
    const st = S.analyze(designOf(name)), want = predictStart(name, cfg, W).start;
    const wrongPad = start === 'pad' && !st.vertical, wrongHeli = start === 'helipad' && !st.heli;
    T.check(`${what}: started where the start rule says`, start === want && !wrongPad && !wrongHeli,
      `started at ${start}, the rule says ${want}${wrongPad ? ' (not a rocket, on the pad)' : ''}${wrongHeli ? ' (not a helicopter, on the helipad)' : ''}`);
  }
  // every stock preset x every start choice, with this place's answers
  const pred = predict(F), names = (l) => [...new Set(l.map((p) => p.name))].sort();
  const all = `${names(pred).length} stock vehicles x their start choices (${pred.length} in all)`;
  const onPad = pred.filter((p) => p.start === 'pad'), onHeli = pred.filter((p) => p.start === 'helipad');
  T.check('the start rule puts nothing but a rocket on the launch pad', onPad.every((p) => p.vertical),
    `${all}: on the pad ${names(onPad).join(', ') || 'nothing'}${onPad.some((p) => !p.vertical) ? `; not rockets: ${names(onPad.filter((p) => !p.vertical)).join(', ')}` : ''}`);
  T.check('the start rule puts nothing but a helicopter on a helipad', onHeli.every((p) => p.heli),
    `${all}: on a helipad ${names(onHeli).join(', ') || 'nothing'}${onHeli.some((p) => !p.heli) ? `; not helicopters: ${names(onHeli.filter((p) => !p.heli)).join(', ')}` : ''}`);
  T.check('the start rule puts a rocket on the launch pad', onPad.length > 0, W.pad ? '' : `${here} has no launch pad`);
  if (W.helipads?.start) T.check('the start rule puts a helicopter on the helipad', onHeli.length > 0, '');
}
