// The whole layout bake (#294) in one command: every place's road layout (layout.mjs, with its checks) and a city's
// setbacks overlay (setbacks.mjs, on the same World: always after its layout, which it reads and is keyed to), then a
// one-screen summary: per place its chunk files, fallbacks, checks, MB and times, and whether each setbacks overlay's
// key is the layout's (one that isn't: STALE, exit 1).
//
//   node --import ./tools/test/node/setup.mjs tools/bake/all.mjs [--verify] [--no-cache] [place ...]
//     (places: islands lauterbrunnen canyon nyc, all of them if none are named)
//     --verify: the same bake, then every file it owns (assets/real/<id>/layout/*, setbacks.bin.gz) compared by bytes
//     with what was there before it ran: "no diff" or the files that changed (exit 1). The bake is deterministic (no
//     times, no randomness, gzip without a timestamp, files named by their bytes' hash), so a re-bake with the same code
//     and data must print "no diff"; `git status assets/real` says the same against what's committed.
//     --no-cache: every step run (the cache only written), as if nothing were kept from the last bake.
//
// Cached (cache.mjs, in .cache/bake/, git ignores it): a step whose inputs (data files and the code it loaded) haven't
// changed since the last bake gives back its output: per place the World and height solve, per chunk its checks, a
// city's setbacks. The summary says per place what was given back and what was worked out again.
//
// Each place bakes in its own process (one World each, its log under $TMPDIR/skywright-bake/<id>.log): New York in one
// lane, the other places one after another in a second lane beside it (its long single-threaded height solve leaves
// the cores to them). BAKE_WORKERS=n caps each stage's worker threads (default: a core each but one).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { layoutKey, setbacksHeader } from '../../src/layout/setbacks.js';

const PLACES = ['islands', 'lauterbrunnen', 'canyon', 'nyc'];
const REPO = fileURLToPath(new URL('../../', import.meta.url)), LOGS = tmpdir() + '/skywright-bake/';

if (process.argv[2] === '--one') { // (a child: one place, its layout then its setbacks, on one World)
  const id = process.argv[3], C = (await import('./cache.mjs')).openCache(!process.argv.includes('--no-cache')), { bakePlace } = await import('./layout.mjs'), { CHUNK } = await import('../../src/layout/format.js');
  const asksOf = async (w) => (w.real?.city ? (await import('./setbacks.mjs')).tallCorners(w, CHUNK).asks : null);
  const r = await bakePlace(id + ':all', null, asksOf, C); // (the World built inside it, only if a step isn't in the cache)
  if (r.city) { // (its ground from the checks' meshes: the layout's chunks aren't meshed again)
    // the setbacks from the cache if the layout (its index names its files by their bytes), the heights its checks gave
    // and every file the last setbacks bake loaded (city.bin, the code) are the same
    const t = performance.now(), out = `assets/real/${id}/setbacks.bin.gz`; C.forget();
    const extra = C.hash(readFileSync(`assets/real/${id}/layout/index.json`), serialize([...r.heights].sort((p, q) => (p[0] < q[0] ? -1 : 1)))), hit = C.get(`${id}/setbacks`, extra);
    if (hit) { writeFileSync(out, hit.value.gz); r.setbacks = { ...hit.value.summary, s: { all: (performance.now() - t) / 1000 } }; }
    else { r.setbacks = await (await import('./setbacks.mjs')).bakeSetbacks(id, await r.world(), r.heights); C.forget(); C.put(`${id}/setbacks`, C.traced(), extra, { gz: readFileSync(out), summary: r.setbacks }); }
    r.cache.setbacks = !!hit; r.cache.world = r.cache.world || !hit;
  }
  delete r.world; delete r.heights; console.log('@@summary ' + JSON.stringify(r));
  process.exit(process.exitCode || 0);
}

const args = process.argv.slice(2), verify = args.includes('--verify'), noCache = args.includes('--no-cache'), places = args.filter((a) => !a.startsWith('--'));
const want = places.length ? places : PLACES, bad = want.filter((p) => !PLACES.includes(p)); if (bad.length) { console.error(`no place ${bad.join(', ')} (${PLACES.join(', ')})`); process.exit(1); }
// every file the bake owns, by its bytes' hash
const owned = () => { const m = new Map(); for (const id of want) { const d = `${REPO}assets/real/${id}/`; if (existsSync(d + 'layout')) for (const f of readdirSync(d + 'layout')) m.set(`${id}/layout/${f}`, hash(d + 'layout/' + f)); if (existsSync(d + 'setbacks.bin.gz')) m.set(`${id}/setbacks.bin.gz`, hash(d + 'setbacks.bin.gz')); } return m; };
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const before = verify ? owned() : null, t0 = performance.now(); mkdirSync(LOGS, { recursive: true });
const one = (id) => new Promise((res) => { const log = [], t = performance.now();
  const ch = spawn(process.execPath, ['--import', pathToFileURL(REPO + 'tools/test/node/setup.mjs').href, '--import', pathToFileURL(REPO + 'tools/bake/cache.mjs').href, fileURLToPath(import.meta.url), '--one', id, ...(noCache ? ['--no-cache'] : [])], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  ch.stdout.on('data', (d) => log.push(d)); ch.stderr.on('data', (d) => log.push(d));
  ch.on('close', (code) => { const text = Buffer.concat(log).toString(); writeFileSync(LOGS + id + '.log', text); const line = text.split('\n').find((l) => l.startsWith('@@summary '));
    const s = line ? JSON.parse(line.slice(10)) : { id, error: `exit ${code}` }; s.wall = (performance.now() - t) / 1000; console.log(`  ${id} done in ${s.wall.toFixed(0)} s${s.error ? ' FAILED (' + s.error + ')' : ''}`); res(s); }); });
console.log(`baking ${want.join(', ')} (logs in ${LOGS}; ${noCache ? 'no cache: every step run' : 'cache in .cache/bake/: unchanged steps given back'})`);
const lanes = [want.filter((p) => p === 'nyc'), want.filter((p) => p !== 'nyc')].filter((l) => l.length);
let stale = false;
const out = (await Promise.all(lanes.map(async (l) => { const r = []; for (const id of l) r.push(await one(id)); return r; }))).flat().sort((a, b) => want.indexOf(a.id) - want.indexOf(b.id));
// ---- the summary
const f1 = (v) => (v == null ? '-' : v.toFixed(0)), pad = (s, n) => String(s).padStart(n);
console.log('\nplace           chunks  fallback  failed  seams       holes    MB    World  bake  checks  ground  setbacks  wall (s)');
for (const s of out) { if (s.error) { console.log(`${s.id.padEnd(14)}  FAILED: ${s.error} (see ${LOGS}${s.id}.log)`); continue; }
  console.log(`${s.id.padEnd(14)}${pad(s.chunks, 8)}${pad(s.fallback, 10)}${pad(s.failed, 8)}  ${s.seams.padEnd(10)}${pad(s.holes, 6)}${pad(s.mb.toFixed(2), 7)}${pad(f1(s.s.world), 8)}${pad(f1(s.s.bake), 6)}${pad(f1(s.s.checks), 8)}${pad(f1(s.s.ground), 8)}${pad(f1(s.setbacks?.s.all), 10)}${pad(f1(s.wall), 10)}`);
  if (s.extent) console.log(`${''.padEnd(14)}  extent ${s.extent} chunks: ${s.added} added (${s.ground} only ground, no file; ${s.mbAdded.toFixed(3)} MB of files added); visible edges inside ${s.visible}; outer edge step vs today's terrain p99 ${s.outerP99?.toFixed(2)} m, max ${s.outerMax?.toFixed(2)} m`);
  if (s.cache) { const c = s.cache; console.log(`${''.padEnd(14)}  cache: solve ${c.solve ? 'hit' : 'miss'}, chunks re-checked ${c.checked}/${c.of}${'setbacks' in c ? `, setbacks ${c.setbacks ? 'hit' : 'miss'}` : ''}; World ${c.world ? 'built' : 'not built'}`); }
  if (s.setbacks) console.log(`${''.padEnd(14)}  setbacks ${s.setbacks.kb.toFixed(0)} KB: ${s.setbacks.cut} cut, ${s.setbacks.drop} dropped, ${s.setbacks.through} with a road through (ground ${f1(s.setbacks.s.ground)} s, buildings ${f1(s.setbacks.s.buildings)} s)`); }
// (a setbacks overlay is keyed to the layout it was baked against: the game ignores one whose key isn't the layout's)
for (const id of want) { const d = `${REPO}assets/real/${id}/`; if (!existsSync(d + 'setbacks.bin.gz')) continue;
  const k = setbacksHeader(new Uint8Array(gunzipSync(readFileSync(d + 'setbacks.bin.gz')))).key, lk = layoutKey(JSON.parse(readFileSync(d + 'layout/index.json', 'utf8')));
  if (k === lk) console.log(`${id}: setbacks overlay key ${k} matches the layout`); else { console.log(`${id}: setbacks overlay STALE: key ${k}, the layout's ${lk} (re-bake: setbacks.mjs ${id})`); stale = true; } }
console.log(`(failed: chunks a check failed, kept today's roads, counted in fallback; seams: shared edges matching / compared)\nall in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
let code = out.some((s) => s.error) || stale ? 1 : 0;
if (verify) { const after = owned(), diff = [];
  for (const [f, h] of after) if (before.get(f) !== h) diff.push((before.has(f) ? 'changed ' : 'new     ') + f);
  for (const f of before.keys()) if (!after.has(f)) diff.push('gone    ' + f);
  if (diff.length) { console.log(`verify: ${diff.length} files differ from before the bake:\n  ` + diff.slice(0, 20).join('\n  ') + (diff.length > 20 ? `\n  ... ${diff.length - 20} more` : '')); code = 1; } else console.log(`verify: no diff (${after.size} files byte-identical)`); }
process.exit(code);
