#!/usr/bin/env node
// Node test runner: runs the Node-tier suites (tools/test/<name>.js modules that export a nodeSuite) on a pool of
// worker threads, one case at a time, and reports them together. Usage (from anywhere):
//   node tools/test/node/run.mjs [suite ...] [--jobs N] [--only TEXT] [--json out.json] [--list]
// With no suite named it runs every registered suite (SUITES below). Exits non-zero on any failed check.
//
// A suite module exports:
//   export const nodeSuite = { files: ['src/bike.js', ...], headless: true }   // the sources it covers (run.py --changed
//     uses this); headless: physics only, Aircraft skips its visual detail (aircraft.js HEADLESS; SKY_VISUALS=1 to compare)
//   export function cases(ctx) { return [{ id: 'Dirt Bike', ... }, ...] }   // plain, serialisable case descriptors
//   export async function runCase(c, ctx) { return [{ name, ok, why, ...extra }, ...] }   // one case's checks
// ctx = { presets: makePresets() } (each worker makes its own). Cases run in any order, on any worker: a case must not
// depend on another having run first. Keep cases a few seconds each so the pool balances.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url)), REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const SUITES = ['bikeride', 'meshcheck']; // (tools/test/<name>.js; add a suite here once it exports nodeSuite)
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
  const t0 = performance.now(), results = [], n = Math.min(jobs, work.length);
  console.log(`${work.length} cases from ${suites.join(', ')} on ${n} workers`);
  // longest first would balance better; without a history, keep the suites' own order and hand out one at a time
  const queue = [...work];
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url));
    const next = () => { const job = queue.shift(); if (job) w.postMessage(job); else { w.terminate(); resolve(); } };
    w.on('message', (m) => {
      if (m.ready) return next();
      results.push(m);
      for (const c of m.checks) if (!c.ok || c.skip) console.log(`${c.ok ? 'skip' : 'FAIL'}  ${m.suite}: ${c.name}${c.why ? '  ' + c.why : ''}`);
      next();
    });
    w.on('error', (e) => { results.push({ suite: '?', i: -1, ms: 0, checks: [{ name: 'worker crashed', ok: false, why: String(e) }] }); resolve(); });
  })));
  const checks = results.flatMap((r) => r.checks.map((c) => ({ suite: r.suite, ...c }))), bad = checks.filter((c) => !c.ok);
  const per = {}; for (const r of results) { const p = (per[r.suite] ??= { cases: 0, ms: 0, checks: 0, failed: 0 }); p.cases++; p.ms += r.ms; p.checks += r.checks.length; p.failed += r.checks.filter((c) => !c.ok).length; }
  for (const [s, p] of Object.entries(per)) console.log(`${p.failed ? 'FAIL' : 'PASS'}  ${s}: ${p.checks - p.failed}/${p.checks} checks, ${p.cases} cases, ${(p.ms / 1000).toFixed(1)} s of work`);
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${checks.length - bad.length}/${checks.length} checks in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${n} workers`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ per, checks }, null, 1));
  process.exit(bad.length ? 1 : 0);
}
