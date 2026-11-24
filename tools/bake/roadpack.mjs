#!/usr/bin/env node
// The deploy's road packs (src/roadPack.js): every real place's roads built and graded once, in Node, at High, before
// the stunt sites are cut out, written to assets/boot/roads-<id>.bin.gz keyed by this build's ROADS (src/version.js: a hash
// of the road code and data, as the deploy stamped it). The game uses a pack only with its own ROADS and PACK_V; locally
// (ROADS 'dev') never.
//   node --import ./tools/test/node/setup.mjs tools/bake/roadpack.mjs [id ...]
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const { nodeWorld } = await import(pathToFileURL(REPO + 'tools/test/node/world.mjs').href);
const { LOCATIONS } = await import(pathToFileURL(REPO + 'src/world.js').href);
const { encodeRoads } = await import(pathToFileURL(REPO + 'src/roadPack.js').href);
const { ROADS } = await import(pathToFileURL(REPO + 'src/version.js').href), COMMIT = process.env.ROADPACK_KEY || ROADS; // (ROADPACK_KEY: tests, with window.SKY_ROADPACK_KEY)
globalThis.SKY_ROADPACK = true; // (realworld.js network: don't cut the stunt sites out; the game does that at load)
mkdirSync(REPO + 'assets/boot', { recursive: true });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.values(LOCATIONS).filter((l) => l?.real).map((l) => l.id);
for (const id of ids) {
  const t = performance.now(), { world } = await nodeWorld(id, 'high');
  const buf = gzipSync(Buffer.from(encodeRoads(world.net.roads, COMMIT)), { level: 9 });
  writeFileSync(REPO + `assets/boot/roads-${id}.bin.gz`, buf);
  console.log(`roads-${id}.bin.gz: ${world.net.roads.length} roads, ${(buf.length / 1024).toFixed(0)} KB, ${((performance.now() - t) / 1000).toFixed(1)} s`);
  world.dispose?.();
}
