#!/usr/bin/env node
// Node test runner: runs the Node-tier suites (tools/test/<name>.js modules that export a nodeSuite) on a pool of
// worker threads, one case at a time, and reports them together. Usage (from anywhere):
//   node tools/test/node/run.mjs [suite ...] [--jobs N] [--shard K/N] [--only TEXT] [--json out.json] [--list]
//   (--shard K/N: part K of N, cases sharing a World or key kept together (shardPlan); --list --shard 1/N: the plan only;
//   --write-times: write this run's case times into the committed tools/test/node/times.json)
// With no suite named it runs every registered suite (SUITES below). Exits non-zero on any failed check. A case that
// fails is re-run once, alone, in a fresh worker: passing then, it is listed as FLAKY at the end and does not fail the run.
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
  const [shardK, shardN] = (opt('--shard', '1/1')).split('/').map(Number); // (part K of N, for parallel CI jobs: shardPlan below)
  const list = args.includes('--list'), files = args.includes('--files'), writeTimes = args.includes('--write-times'), names = args.filter((a) => !a.startsWith('--'));
  const suites = names.length ? names : SUITES;
  await import(pathToFileURL(here + 'setup.mjs').href);
  const ctx = await context(), work = [], allKeys = new Set();
  if (files) { const out = {}; for (const s of suites) out[s] = (await import(modUrl(s))).nodeSuite?.files ?? []; console.log(JSON.stringify(out)); process.exit(0); }
  for (const s of suites) {
    const m = await import(modUrl(s));
    if (!m.nodeSuite || !m.cases || !m.runCase) { console.error(`${s}: not a Node suite (needs nodeSuite, cases, runCase)`); process.exit(2); }
    m.cases(ctx).forEach((c, i) => { allKeys.add(`${s}|${c.id ?? i}`); if (!only || JSON.stringify(c).toLowerCase().includes(only.toLowerCase())) work.push({ suite: s, i, c }); });
  }
  // Case times (ms, by suite|case id): tools/test/node/times.json is committed (so CI's shards know them; refresh it with
  // --write-times after a full run), .times.json is this machine's last run (not committed) and wins where it has one.
  // Unknown: the case's own c.cost (s), else the median known case.
  const timesFile = here + '.times.json', committedFile = here + 'times.json', key = keyOf;
  const readJSON = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; } };
  const committed = readJSON(committedFile), local = readJSON(timesFile), times = { ...committed, ...local };
  const knownMs = work.map((w) => times[key(w)]).filter((v) => v != null).sort((a, b) => a - b), typical = knownMs.length ? knownMs[knownMs.length >> 1] : 2000;
  const est = (w) => times[key(w)] ?? (w.c.cost != null ? w.c.cost * 1000 : typical);
  const plan = shardPlan(work, shardN, est), queue = plan[shardK - 1].flatMap((g) => g.cases).sort((a, b) => est(b) - est(a));
  if (list) {
    if (shardN === 1 && !args.includes('--shard')) { for (const w of work) console.log(`${w.suite}  ${w.c.id ?? w.i}`); process.exit(0); }
    // (dry run: each shard's estimated work, its estimated wall time on --jobs workers, and its groups)
    plan.forEach((gs, k) => {
      const cs = gs.flatMap((g) => g.cases), sum = cs.reduce((s, w) => s + est(w), 0);
      console.log(`shard ${k + 1}/${shardN}: ${cs.length} cases, ${(sum / 1000).toFixed(1)} s of work, ~${(simulate(cs, jobs, est) / 1000).toFixed(1)} s on ${jobs} workers${shardK - 1 === k && args.includes('--shard') ? '  (this shard)' : ''}`);
      for (const g of gs) if (g.name) console.log(`  ${(g.ms / 1000).toFixed(1).padStart(6)} s  ${g.name} (${g.cases.length} cases)`);
      const free = gs.filter((g) => !g.name); console.log(`  ${(free.reduce((s, g) => s + g.ms, 0) / 1000).toFixed(1).padStart(6)} s  ${free.length} cases with no affinity`);
    });
    process.exit(0);
  }
  let knownFails = {}; try { knownFails = JSON.parse(readFileSync(REPO + 'tools/test/known.json', 'utf8')); } catch {}
  // Within a shard: longest first, handed out one at a time. A case may name what it shares with others, c.world (a
  // place's World, node/world.mjs keeps one per worker) or c.key (e.g. a vehicle's built crew): a worker is handed a case
  // for something it already has if there is one, else one for something no worker has started, else one needing none.
  const started = new Set();
  const t0 = performance.now(), results = [], n = Math.min(jobs, queue.length);
  console.log(`${queue.length} cases${shardN > 1 ? ` (part ${shardK}/${shardN} of ${work.length})` : ''} from ${suites.join(', ')} on ${n} workers`);
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url)), mine = new Set();
    const next = () => { const job = pick(queue, mine, started); if (job) { const a = aff(job); if (a != null) { mine.add(a); started.add(a); } w.postMessage(job); } else { w.terminate(); resolve(); } };
    w.on('message', (m) => {
      if (m.ready) return next();
      results.push(m);
      for (const c of m.checks) if (!c.ok || c.skip) console.log(`${c.ok ? 'skip' : knownFails[m.suite]?.[c.name] ? 'known' : 'FAIL'}  ${m.suite}: ${c.name}${c.why ? '  ' + c.why : ''}`);
      next();
    });
    w.on('error', (e) => { results.push({ suite: '?', i: -1, ms: 0, checks: [{ name: 'worker crashed', ok: false, why: String(e) }] }); resolve(); });
  })));
  // Retry net: a case with a failed check (not a known failure) runs once more, alone, in a fresh worker. Passing on
  // the retry it is reported FLAKY (with the first run's failure) and does not fail the run; failing again, it fails.
  const failing = (r) => r.checks.some((c) => !c.ok && !c.skip && !knownFails[r.suite]?.[c.name]), flaky = [];
  const retryable = results.filter((r) => r.i >= 0 && failing(r));
  if (retryable.length) console.log(`retry  ${retryable.length} failed case(s), once each in a fresh worker`);
  for (const r of retryable) {
    const job = work.find((x) => x.suite === r.suite && x.i === r.i); if (!job) continue;
    const again = await runFresh(job);
    if (!failing(again)) {
      const first = r.checks.filter((c) => !c.ok && !knownFails[r.suite]?.[c.name]);
      flaky.push({ suite: r.suite, id: job.c.id ?? job.i, first }); results[results.indexOf(r)] = { ...again, ms: r.ms };
    } else for (const c of again.checks) if (!c.ok && !knownFails[again.suite]?.[c.name]) console.log(`FAIL  ${again.suite}: ${c.name} (again on retry)${c.why ? '  ' + c.why : ''}`);
  }
  const measured = {}; for (const r of results) { const w = work.find((x) => x.suite === r.suite && x.i === r.i); if (w) measured[key(w)] = Math.round(r.ms); }
  try { writeFileSync(timesFile, JSON.stringify({ ...local, ...measured })); } catch {}
  if (writeTimes) { // (this run's times over the committed ones; a listed suite's cases that no longer exist are dropped)
    const out = {}; for (const [k, v] of Object.entries(committed)) if (allKeys.has(k) || !suites.includes(k.split('|')[0])) out[k] = v;
    Object.assign(out, measured);
    writeFileSync(committedFile, timesJSON(out)); console.log(`wrote ${Object.keys(out).length} case times to tools/test/node/times.json`);
  }
  // known failures (tools/test/known.json: suite -> check name -> issue) report as known, not as failures
  let known = {}; try { known = JSON.parse(readFileSync(REPO + 'tools/test/known.json', 'utf8')); } catch {}
  const isKnown = (c) => known[c.suite]?.[c.name];
  const checks = results.flatMap((r) => r.checks.map((c) => ({ suite: r.suite, ...c }))), bad = checks.filter((c) => !c.ok && !isKnown(c));
  const knownBad = checks.filter((c) => !c.ok && isKnown(c)), fixed = checks.filter((c) => c.ok && !c.skip && isKnown(c));
  if (knownBad.length) console.log(`known  ${knownBad.length} known failure(s), not counted: ${[...new Set(knownBad.map((c) => `${c.suite} ${isKnown(c)}`))].join(', ')}`);
  for (const c of fixed) console.log(`fixed  ${c.suite}: ${c.name} passes now: remove it from tools/test/known.json`);
  const per = {}; for (const r of results) { const p = (per[r.suite] ??= { cases: 0, ms: 0, checks: 0, failed: 0 }); p.cases++; p.ms += r.ms; p.checks += r.checks.length; p.failed += r.checks.filter((c) => !c.ok && !known[r.suite]?.[c.name]).length; }
  for (const [s, p] of Object.entries(per)) console.log(`${p.failed ? 'FAIL' : 'PASS'}  ${s}: ${p.checks - p.failed}/${p.checks} checks, ${p.cases} cases, ${(p.ms / 1000).toFixed(1)} s of work`);
  if (flaky.length) {
    console.log(`FLAKY  ${flaky.length} case(s) failed once and passed on retry (not counted; worth a look):`);
    for (const f of flaky) for (const c of f.first) console.log(`FLAKY  ${f.suite} ${f.id}: ${c.name}${c.why ? '  ' + c.why : ''}`);
  }
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${checks.length - bad.length}/${checks.length} checks in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${n} workers`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ per, checks, flaky }, null, 1));
  process.exit(bad.length ? 1 : 0);
}

// one case run alone in a new worker (the retry net): resolves with its result message
function runFresh(job) {
  return new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url)), done = (m) => { w.terminate(); resolve(m); };
    w.on('message', (m) => { if (m.ready) w.postMessage(job); else done(m); });
    w.on('error', (e) => done({ suite: job.suite, i: job.i, ms: 0, checks: [{ name: 'worker crashed', ok: false, why: String(e) }] }));
  });
}
// what a case shares with others (World first: node/world.mjs caches one per worker)
function aff(j) { return j.c.world ?? j.c.key; }
// the case a worker takes next: one for something it already has, else for something no worker has started, else one
// needing nothing, else the longest left (another worker's: built again here rather than idle)
function pick(queue, mine, started) {
  let k = queue.findIndex((j) => aff(j) != null && mine.has(aff(j)));
  if (k < 0) k = queue.findIndex((j) => aff(j) != null && !started.has(aff(j)));
  if (k < 0) k = queue.findIndex((j) => aff(j) == null);
  return queue.splice(Math.max(0, k), 1)[0];
}
// The work split into n shards (separate CI jobs: nothing is shared between them). Cases that share a World or a key
// (transitively: a case with both joins the two) form a group, kept in one shard so each shard builds a place's World
// once. A group bigger than a shard's fair share (total / n) is cut into parts that fit, else that shard would be all
// one group. Then longest first, each group to the shard with the least estimated work. Deterministic for given times.
export function shardPlan(work, n, est) {
  const parent = new Map(), find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const tokens = (w) => [w.c.world != null && 'world ' + w.c.world, w.c.key != null && 'key ' + w.c.key].filter(Boolean);
  for (const w of work) { const ts = tokens(w); for (const t of ts) if (!parent.has(t)) parent.set(t, t); for (const t of ts.slice(1)) parent.set(find(t), find(ts[0])); }
  const byRoot = new Map(), groups = [];
  for (const w of work) {
    const ts = tokens(w);
    if (!ts.length) { groups.push({ name: null, cases: [w], ms: est(w) }); continue; }
    const r = find(ts[0]); if (!byRoot.has(r)) byRoot.set(r, { names: new Set(), cases: [], ms: 0 });
    const g = byRoot.get(r); for (const t of ts) g.names.add(t); g.cases.push(w); g.ms += est(w);
  }
  const total = work.reduce((s, w) => s + est(w), 0), fair = total / n;
  for (const g of byRoot.values()) {
    const name = [...g.names].sort().join(' + ');
    const parts = Math.min(n, Math.ceil(g.ms / fair - 1e-9)); // (a group over a fair share: cut into the fewest parts that fit)
    if (parts <= 1) { groups.push({ name, cases: g.cases, ms: g.ms }); continue; }
    const ps = Array.from({ length: parts }, (_, i) => ({ name: `${name} [part ${i + 1}/${parts}]`, cases: [], ms: 0 }));
    for (const w of [...g.cases].sort((a, b) => est(b) - est(a) || keyOf(a).localeCompare(keyOf(b)))) { const p = ps.reduce((m, p) => (p.ms < m.ms ? p : m)); p.cases.push(w); p.ms += est(w); }
    groups.push(...ps);
  }
  groups.sort((a, b) => b.ms - a.ms || keyOf(a.cases[0]).localeCompare(keyOf(b.cases[0])));
  const shards = Array.from({ length: n }, () => ({ groups: [], ms: 0 }));
  for (const g of groups) { const s = shards.reduce((m, s) => (s.ms < m.ms ? s : m)); s.groups.push(g); s.ms += g.ms; }
  return shards.map((s) => s.groups);
}
function keyOf(w) { return `${w.suite}|${w.c.id ?? w.i}`; }
// a shard's estimated wall time on `jobs` workers, handing out cases the way the run does (pick)
function simulate(cases, jobs, est) {
  const queue = [...cases].sort((a, b) => est(b) - est(a)), started = new Set(), ws = Array.from({ length: Math.min(jobs, queue.length) }, () => ({ t: 0, mine: new Set() }));
  while (queue.length) { const w = ws.reduce((m, w) => (w.t < m.t ? w : m)), j = pick(queue, w.mine, started), a = aff(j); if (a != null) { w.mine.add(a); started.add(a); } w.t += est(j); }
  return Math.max(0, ...ws.map((w) => w.t));
}
// the committed times file: one case per line, sorted (small diffs)
function timesJSON(t) { return '{\n' + Object.keys(t).sort().map((k) => `  ${JSON.stringify(k)}: ${t[k]}`).join(',\n') + '\n}\n'; }
