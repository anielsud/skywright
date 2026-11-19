#!/usr/bin/env node
// Renders the app icon and splash sources from the site's icon.svg into native/assets/, for
// `capacitor-assets generate` (run both with `npm run assets`), which writes every size into android/ and ios/.
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, '..', '..', 'icon.svg'), 'utf8');
const OUT = resolve(here, '..', 'assets');
mkdirSync(OUT, { recursive: true });

const BG = '#14181d';
const grad = (svg.match(/<defs>.*<\/defs>/) || [''])[0];
const plane = (svg.match(/<path[^>]*\/>/) || [''])[0].replace(/transform="[^"]*"/, '');
if (!grad || !plane) throw new Error('icon.svg: expected a <defs> gradient and one <path>');
const png = (s, size, file) => sharp(Buffer.from(s), { density: 72 * size / 512 }).resize(size, size).png().toFile(join(OUT, file));
// the plane glyph (64x64 units) centred at a given size inside a 512 box
const glyph = (scale) => `<g transform="translate(${256 - 32 * scale} ${256 - 32 * scale}) scale(${scale})">${plane}</g>`;
const gradRect = `${grad}<rect width="512" height="512" fill="url(#g)"/>`;

await Promise.all([
  // full-bleed square (iOS rounds the corners itself; transparent corners would turn black there)
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradRect}${glyph(6)}</svg>`, 1024, 'icon-only.png'),
  // Android adaptive icon: background layer + foreground glyph inside the 66% safe zone
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradRect}</svg>`, 1024, 'icon-background.png'),
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${glyph(4.2)}</svg>`, 1024, 'icon-foreground.png'),
  // splash: the rounded icon small in the middle of the app's background colour
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><g transform="translate(208 208) scale(0.1875)">${svg.replace(/<\?xml[^>]*>/, '').replace(/^<svg[^>]*>/, '<g>').replace(/<\/svg>\s*$/, '</g>')}</g></svg>`, 2732, 'splash.png'),
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><g transform="translate(208 208) scale(0.1875)">${svg.replace(/<\?xml[^>]*>/, '').replace(/^<svg[^>]*>/, '<g>').replace(/<\/svg>\s*$/, '</g>')}</g></svg>`, 2732, 'splash-dark.png'),
]);
console.log(`make-assets: wrote icon and splash sources to ${OUT}`);
