// Probes against warm Worlds: build each place ONCE, then run any number of probe scripts against them.
// Building a World costs ~5 s (Lauterbrunnen) to ~15 s (New York) every time; a probe on a warm one costs milliseconds.
//
//   once:   node --import ./tools/test/node/setup.mjs tools/test/node/probe.mjs once nyc,lauterbrunnen a.mjs b.mjs ...
//           builds the places, runs every probe against them, exits. (After a batch of changes to src/: one build for
//           all the checks of that batch.)
//   serve:  node --import ./tools/test/node/setup.mjs tools/test/node/probe.mjs serve nyc,lauterbrunnen DIR &
//           builds the places, then runs each probe dropped into DIR and writes <name>.out next to it.
//   ask:    node tools/test/node/probe.mjs ask DIR a.mjs [b.mjs ...]
//           hands probes to a running server and prints their output (waits for it).
//
// A probe is an ES module whose default export is called with { worlds, w: first World, at(place), THREE, log }
// (worlds: place -> { world, env, ms } as worldAt gives), src(name) and may return anything JSON-able, which is
// printed. `await src('roadgrade.js')` gives the game's module: the SAME instance the Worlds were built with. A served world is
// the code as it was when the server started: after changing src/, restart the server (or use `once`).
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
// the game's own module, the same instance the Worlds use (import it like this from a probe anywhere on disk)
const src = (name) => import(pathToFileURL(REPO + 'src/' + name).href);

const [mode, ...args] = process.argv.slice(2);

async function run(file, ctx) {
  const lines = [], log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const t0 = performance.now();
  try {
    const m = await import(pathToFileURL(resolve(file)).href + '?t=' + Date.now());
    const r = await m.default({ ...ctx, log });
    if (r !== undefined) lines.push(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
  } catch (e) { lines.push('✗ ' + (e?.stack || e)); }
  lines.push(`(${basename(file)}: ${Math.round(performance.now() - t0)} ms)`);
  return lines.join('\n');
}

async function build(places) {
  const THREE = await import('three');
  const { worldAt } = await import('./world.mjs');
  const worlds = {};
  for (const p of places) { worlds[p] = await worldAt(p); console.error(`[probe] ${p} built in ${worlds[p].ms} ms`); }
  return { worlds, w: worlds[places[0]].world, at: (p) => worlds[p].world, THREE, src };
}

if (mode === 'once') {
  const [places, ...files] = args;
  const ctx = await build(places.split(','));
  for (const f of files) console.log(`== ${basename(f)}\n` + (await run(f, ctx)));
  process.exit(0);
} else if (mode === 'serve') {
  const [places, dir] = args; mkdirSync(dir, { recursive: true });
  const ctx = await build(places.split(','));
  writeFileSync(join(dir, 'READY'), places);
  console.error(`[probe] serving ${places} from ${dir}`);
  for (;;) {
    const todo = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !existsSync(join(dir, f + '.out')));
    for (const f of todo) { const o = join(dir, f + '.out'); writeFileSync(o + '.tmp', await run(join(dir, f), ctx)); renameSync(o + '.tmp', o); }
    await new Promise((r) => setTimeout(r, 100));
  }
} else if (mode === 'ask') {
  const [dir, ...files] = args;
  if (!existsSync(join(dir, 'READY'))) { console.error(`no probe server ready in ${dir} (start one with: probe.mjs serve PLACES ${dir})`); process.exit(1); }
  for (const f of files) {
    const name = `${Date.now()}_${basename(f)}`, out = join(dir, name + '.out');
    copyFileSync(f, join(dir, name));
    while (!existsSync(out)) await new Promise((r) => setTimeout(r, 50));
    console.log(`== ${basename(f)}\n` + readFileSync(out, 'utf8'));
  }
} else {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(1);
}
