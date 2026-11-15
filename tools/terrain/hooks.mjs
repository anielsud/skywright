// Node module hooks so the browser ES modules in src/ can be imported by the offline tools
// (node --import ./hooks.mjs ...): the bare 'three' specifier resolves to the vendored build, like the
// import map in index.html, and src/*.js (no package.json "type") load as ES modules.
import { registerHooks } from 'node:module';

const THREE_URL = new URL('../../vendor/three.module.min.js', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE_URL, shortCircuit: true, format: 'module' };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith('file:') && url.endsWith('.js')) return { ...next(url, { ...ctx, format: 'module' }), format: 'module', shortCircuit: true };
    return next(url, ctx);
  },
});
