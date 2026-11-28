// The layout bake's cache (all.mjs): each step's output kept under .cache/bake/ (git ignores it) by a checksum of what
// it read, so a bake whose inputs haven't changed gives back the last output instead of working it out again.
//   - the solve (per place: the World, the height solve, the chunks' ground lattices): keyed by every file the bake
//     process loaded up to its end, source modules (Node's module loads, the load hook below) and data (every fetch of
//     a game file: setup.mjs reads them from disk). That list is written beside the entry: the next bake hashes the
//     same files again and, if none changed, the same code would load the same files and give the same output.
//   - a chunk's checks (per chunk): its bytes, its ground lattice, its asks, the place's ground grid and the check
//     code (layout-check.mjs and everything it imports, found by reading their imports).
//   - a city's setbacks: its layout index, the heights its checks gave and every file loaded up to its end.
// Loaded with --import after setup.mjs (all.mjs's children: their workers inherit it), so it sees every module load.
// Deterministic outputs only: an entry is the bytes a step would have made, so a bake from the cache is byte-identical.
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const DIR = REPO + '.cache/bake/';
const loaded = new Set(), fetched = new Set();
// (the --import preloads ran before this hook: setup.mjs, this file)
for (let i = 0; i < process.execArgv.length; i++) { const a = process.execArgv[i]; const v = a === '--import' ? process.execArgv[++i] : a.startsWith('--import=') ? a.slice(9) : null; if (v) loaded.add(v.startsWith('file:') ? fileURLToPath(v) : resolve(v)); }
registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) loaded.add(fileURLToPath(url)); return next(url, ctx); } });
const fetch0 = globalThis.fetch;
if (fetch0) globalThis.fetch = (u, o) => { const s = String(u?.url ?? u); if (!/^https?:/.test(s)) fetched.add((s.startsWith('file:') ? fileURLToPath(s) : REPO + s.replace(/^\.?\//, '')).split('?')[0].split('#')[0]); return fetch0(u, o); };

const rel = (f) => (f.startsWith(REPO) ? f.slice(REPO.length) : f);
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(typeof p === 'string' ? p : p instanceof Uint8Array ? p : new Uint8Array(p.buffer, p.byteOffset, p.byteLength)).update('\0'); return h.digest('hex'); };
export const hashOf = sha;
// every file this process has loaded so far (modules and fetched data), repo-relative, sorted
export const traced = () => [...new Set([...loaded, ...fetched].map(rel))].sort();
// the files' contents as one hash (a missing file hashes as missing)
const fileHash = new Map();
export function stamp(files) {
  const h = createHash('sha256');
  for (const f of files) { const p = f.startsWith('/') ? f : REPO + f; let v = fileHash.get(p); if (v === undefined) { try { v = sha(readFileSync(p)); } catch { v = 'missing'; } fileHash.set(p, v); } h.update(f + '\0' + v + '\n'); }
  return h.digest('hex');
}
export const forget = () => fileHash.clear(); // (after the bake writes files that a later step reads)
// a module and everything it imports (static and literal dynamic imports, read from the source), repo-relative
export function importsOf(url) {
  const seen = new Set(), st = [fileURLToPath(url)], RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f); let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [, s] of src.matchAll(RE)) { if (s === 'three') st.push(REPO + 'vendor/three.module.min.js'); else if (s.startsWith('three/addons/')) st.push(REPO + 'vendor/addons/' + s.slice(13)); else if (s.startsWith('.')) st.push(resolve(dirname(f), s)); } }
  return [...seen].map(rel).sort();
}

const atomic = (f, b) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f + '.tmp', b); renameSync(f + '.tmp', f); };
// A cache (read: false only writes, --no-cache). Two kinds of entry:
//  - traced (name, e.g. 'nyc/solve'): get(name, extra) hashes the files the last put listed (plus extra) and gives
//    { key, value } on a hit; put(name, files, extra, value) keeps one entry per name, the latest;
//  - by key (getK/putK: a hash the caller made of every input).
export function openCache(read = true) {
  const used = new Set();
  const get = (name, extra = '') => {
    let files; try { files = JSON.parse(readFileSync(DIR + name + '.files.json', 'utf8')); } catch { return null; }
    const key = sha(stamp(files), extra), f = `${DIR}${name}.${key.slice(0, 24)}.bin`;
    return read && existsSync(f) ? { key, value: deserialize(readFileSync(f)) } : null;
  };
  const put = (name, files, extra, value) => {
    const key = sha(stamp(files), extra), base = name.split('/').pop(), d = DIR + dirname(name) + '/';
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.startsWith(base + '.') && f.endsWith('.bin')) unlinkSync(d + f);
    atomic(`${DIR}${name}.${key.slice(0, 24)}.bin`, serialize(value)); atomic(DIR + name + '.files.json', JSON.stringify(files, null, 0)); return key;
  };
  const getK = (dir, key) => { used.add(dir + '/' + key); const f = `${DIR}${dir}/${key}.bin`; return read && existsSync(f) ? deserialize(readFileSync(f)) : undefined; };
  const putK = (dir, key, value) => atomic(`${DIR}${dir}/${key}.bin`, serialize(value));
  // drop a by-key directory's entries this run didn't ask for (a place's chunks: those of the last bake are kept)
  const prune = (dir) => { const d = DIR + dir + '/'; if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.bin') && !used.has(dir + '/' + f.slice(0, -4))) unlinkSync(d + f); };
  return { read, get, put, getK, putK, prune, traced, stamp, importsOf, hash: sha, forget };
}
export const preloadURL = pathToFileURL(fileURLToPath(import.meta.url)).href;
