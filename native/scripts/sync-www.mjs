#!/usr/bin/env node
// Copies the web app (the repo root, one folder up) into native/www: the offline fallback the apps ship with.
// The apps normally run the live site from GitHub Pages; this copy is only shown when that can't load
// (first launch with no network, or the service worker's offline cache was cleared). See native/README.md.
//
//   node scripts/sync-www.mjs          everything, including the real-world location data (~80 MB)
//   node scripts/sync-www.mjs --lite   leave out assets/real/ (the fallback then has no real-world places)
//
// src/version.js gets COMMIT/BUILT stamped like the deploy workflow does, so analytics and the build
// label work in the fallback copy too (an unstamped 'dev' build turns analytics off).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const OUT = resolve(here, '..', 'www');
const lite = process.argv.includes('--lite');

// What the site is made of. Not copied: sw.js (the fallback must not install a service worker of its own),
// tools/, native/, docs and repo files.
const FILES = ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg'];
const DIRS = ['src', 'vendor', 'tex', 'assets'];

for (const f of [...FILES, ...DIRS]) if (!existsSync(join(ROOT, f))) { console.error(`sync-www: ${f} not found in ${ROOT}`); process.exit(1); }

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of FILES) cpSync(join(ROOT, f), join(OUT, f));
const skip = (src) => /(^|[/\\])\.DS_Store$/.test(src) || (lite && src.startsWith(join(ROOT, 'assets', 'real')));
for (const d of DIRS) cpSync(join(ROOT, d), join(OUT, d), { recursive: true, filter: (src) => !skip(src) });

// stamp build info (same substitutions as .github/workflows/deploy.yml)
let sha = 'native';
try { sha = execSync('git rev-parse --short=7 HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a git checkout */ }
const built = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const vf = join(OUT, 'src', 'version.js');
writeFileSync(vf, readFileSync(vf, 'utf8')
  .replace(/^export const COMMIT = .*$/m, `export const COMMIT = '${sha}';`)
  .replace(/^export const BUILT = .*$/m, `export const BUILT = '${built}';`));

const size = (p) => statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size;
const version = (readFileSync(vf, 'utf8').match(/VERSION = '([^']+)'/) || [])[1];
console.log(`sync-www: copied Skywright ${version} (${sha}) to ${OUT}: ${(size(OUT) / 1e6).toFixed(0)} MB${lite ? ' (lite: no assets/real)' : ''}`);
