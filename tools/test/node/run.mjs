#!/usr/bin/env node
// Node test runner: runs the Node-tier suites (tools/test/<name>.js modules that export a nodeSuite) on a pool of
// worker threads, one case at a time, and reports them together. Usage (from anywhere):
//   node tools/test/node/run.mjs [suite ...] [--jobs N] [--shard K/N] [--only TEXT] [--json out.json] [--list]
// With no suite named it runs every registered suite (SUITES below). Exits non-zero on any failed check.
//
// A suite module exports:
//   export const nodeSuite = { files: ['src/bike.js', ...], headless: true }   // the sources it covers (run.py --changed
//     uses this); headless: physics only, Aircraft skips its visual detail (aircraft.js HEADLESS; SKY_VISUALS=1 to compare)
//   export function cases(ctx) { return [{ id: 'Dirt Bike', ... }, ...] }   // plain, serialisable case descriptors (world: the
//     node/world.mjs World it builds, if any: cases needing the same World go to the same worker where they can)
//   export async function runCase(c, ctx) { return [{ name, ok, why, ...extra }, ...] }   // one case's checks
// ctx = { presets: makePresets() } (each worker makes its own). Cases run in any order, on any worker: a case must not
// depend on another having run first. Keep cases a few seconds each so the pool balances. A case may carry a key
// (c.key, e.g. a vehicle's name): cases with the same key, from any suite, go to the same worker where possible, so
// what that worker built and cached for the first is warm for the rest. A case may say what it costs (c.cost, seconds
// of work, roughly): the costly ones go out first, so they are not left running at the end.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url)), REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const SUITES = ['bikeride', 'drivecheck', 'rocketcheck', 'riders', 'gvision', 'boatride', 'stunts', 'waterpark', 'walls', 'meshcheck', 'cockpitcheck', 'gearcheck', 'startbakes', 'tunnelcheck', 'startchoice', 'presets', 'roadcheck', 'airportcheck', 'bldcheck', 'setbacks']; // (tools/test/<name>.js; add a suite here once it exports nodeSuite)
const modUrl = (name) => pathToFileURL(`${REPO}tools/test/${name}.js`).href;

async function context() { const { makePresets } = await import(pathToFileURL(REPO + 'src/design.js').href); return { presets: makePresets() }; }

if (!isMainThread) { // a worker: set up once, then run whatever case it is sent
  await import(pathToFileURL(here + 'setup.mjs').href);
  const ctx = await context(), mods = {};
  parentPort.on('message', async ({ suite, i, c }) => {
    const t = performance.now();
    try {
      if (!mods[suite]) { mods[suite] = await import(modUrl(suite)); }
      const { HEADLESS } = await import(pathToFileURL(REPO + 'src/aircraft.js').href); HEADLESS.on = !!mods[suite].nodeSuite?.headless && !process.env.SKY_VISUALS;
      const checks = await mods[suite].runCase(c, ctx);
      parentPort.postMessage({ suite, i, ms: performance.now() - t, checks: JSON.parse(JSON.stringify(checks)) });
    } catch (e) { parentPort.postMessage({ suite, i, ms: performance.now() - t, checks: [{ name: `${c.id ?? i}: threw`, ok: false, why: String(e?.stack || e).split('\n').slice(0, 4).join(' | ') }] }); }
  });
  parentPort.postMessage({ ready: true });
} else {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const jobs = +opt('--jobs', Math.max(1, availableParallelism() - 2)), only = opt('--only', null), jsonOut = opt('--json', null);
  const [shardK, shardN] = (opt('--shard', '1/1')).split('/').map(Number); // (part K of N: every Nth case, longest first, for parallel CI jobs)
  const list = args.includes('--list'), files = args.includes('--files'), names = args.filter((a) => !a.startsWith('--'));
  const suites = names.length ? names : SUITES;
  await import(pathToFileURL(here + 'setup.mjs').href);
  const ctx = await context(), work = [];
  if (files) { const out = {}; for (const s of suites) out[s] = (await import(modUrl(s))).nodeSuite?.files ?? []; console.log(JSON.stringify(out)); process.exit(0); }
  for (const s of suites) {
    const m = await import(modUrl(s));
    if (!m.nodeSuite || !m.cases || !m.runCase) { console.error(`${s}: not a Node suite (needs nodeSuite, cases, runCase)`); process.exit(2); }
    m.cases(ctx).forEach((c, i) => { if (!only || JSON.stringify(c).toLowerCase().includes(only.toLowerCase())) work.push({ suite: s, i, c }); });
  }
  if (list) { for (const w of work) console.log(`${w.suite}  ${w.c.id ?? w.i}`); process.exit(0); }
  let knownFails = {}; try { knownFails = JSON.parse(readFileSync(REPO + 'tools/test/known.json', 'utf8')); } catch {}
  // longest first (times from earlier runs, tools/test/node/.times.json, not committed; else a case's own c.cost in s;
  // unknown cases count as long), handed out one at a time. A case may name what it shares with others, c.world (a
  // place's World, node/world.mjs keeps one per worker) or c.key (e.g. a vehicle's built crew): a worker is handed a case
  // for something it already has if there is one, else one for something no worker has started, else one needing none.
  const timesFile = here + '.times.json', key = (w) => `${w.suite}|${w.c.id ?? w.i}`, aff = (j) => j.c.world ?? j.c.key;
  let times = {}; try { times = JSON.parse(readFileSync(timesFile, 'utf8')); } catch {}
  const est = (w) => times[key(w)] ?? (w.c.cost != null ? w.c.cost * 1000 : 1e9);
  const queue = [...work].sort((a, b) => est(b) - est(a)).filter((w, i) => i % shardN === shardK - 1), started = new Set();
  const t0 = performance.now(), results = [], n = Math.min(jobs, queue.length);
  console.log(`${queue.length} cases${shardN > 1 ? ` (part ${shardK}/${shardN} of ${work.length})` : ''} from ${suites.join(', ')} on ${n} workers`);
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url)), mine = new Set();
    const pick = () => { let k = queue.findIndex((j) => aff(j) != null && mine.has(aff(j))); if (k < 0) k = queue.findIndex((j) => aff(j) != null && !started.has(aff(j))); if (k < 0) k = queue.findIndex((j) => aff(j) == null); return queue.splice(Math.max(0, k), 1)[0]; };
    const next = () => { const job = pick(); if (job) { const a = aff(job); if (a != null) { mine.add(a); started.add(a); } w.postMessage(job); } else { w.terminate(); resolve(); } };
    w.on('message', (m) => {
      if (m.ready) return next();
      results.push(m);
      for (const c of m.checks) if (!c.ok || c.skip) console.log(`${c.ok ? 'skip' : knownFails[m.suite]?.[c.name] ? 'known' : 'FAIL'}  ${m.suite}: ${c.name}${c.why ? '  ' + c.why : ''}`);
      next();
    });
    w.on('error', (e) => { results.push({ suite: '?', i: -1, ms: 0, checks: [{ name: 'worker crashed', ok: false, why: String(e) }] }); resolve(); });
  })));
  for (const r of results) { const w = work.find((x) => x.suite === r.suite && x.i === r.i); if (w) times[key(w)] = Math.round(r.ms); }
  try { writeFileSync(timesFile, JSON.stringify(times)); } catch {}
  // known failures (tools/test/known.json: suite -> check name -> issue) report as known, not as failures
  let known = {}; try { known = JSON.parse(readFileSync(REPO + 'tools/test/known.json', 'utf8')); } catch {}
  const isKnown = (c) => known[c.suite]?.[c.name];
  const checks = results.flatMap((r) => r.checks.map((c) => ({ suite: r.suite, ...c }))), bad = checks.filter((c) => !c.ok && !isKnown(c));
  const knownBad = checks.filter((c) => !c.ok && isKnown(c)), fixed = checks.filter((c) => c.ok && !c.skip && isKnown(c));
  if (knownBad.length) console.log(`known  ${knownBad.length} known failure(s), not counted: ${[...new Set(knownBad.map((c) => `${c.suite} ${isKnown(c)}`))].join(', ')}`);
  for (const c of fixed) console.log(`fixed  ${c.suite}: ${c.name} passes now: remove it from tools/test/known.json`);
  const per = {}; for (const r of results) { const p = (per[r.suite] ??= { cases: 0, ms: 0, checks: 0, failed: 0 }); p.cases++; p.ms += r.ms; p.checks += r.checks.length; p.failed += r.checks.filter((c) => !c.ok && !known[r.suite]?.[c.name]).length; }
  for (const [s, p] of Object.entries(per)) console.log(`${p.failed ? 'FAIL' : 'PASS'}  ${s}: ${p.checks - p.failed}/${p.checks} checks, ${p.cases} cases, ${(p.ms / 1000).toFixed(1)} s of work`);
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${checks.length - bad.length}/${checks.length} checks in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${n} workers`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ per, checks }, null, 1));
  process.exit(bad.length ? 1 : 0);
}
