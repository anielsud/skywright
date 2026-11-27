// Job: the shader programs a flight start compiles, per place (a census: counts only, nothing fails on a number).
// Run by tools/test/jobs.py (see harness.js for T); not in the default set:
//   python3 tools/test/jobs.py progs --quality low
// Each place builds its World for the Kestrel's runway start. A program counts if the hangar didn't already have its
// cache key and either this start made it or this World draws with it (one an earlier place left behind, which a fresh
// start here would have compiled too), so every place's count is as from a fresh start. The PASS line gives the count
// and its families: the material's shader (physical, basic, ..., or 'shader' for a ShaderMaterial) and its
// customProgramCacheKey tag (none for the plain hook every material has, shaders.js installFog). Each program costs a
// compile at load (~0.3 s on CI's software GL), so a material set-up switch that could be a uniform shows up here.
import { settle as hangarSettled } from '../tunnelcheck.js';

const PLACES = ['nyc', 'islands', 'canyon', 'lauterbrunnen'];

export async function run(T) {
  await hangarSettled(); await T.frames(60, { what: 'the hangar thumbnails' }); // (their studio's programs come and go)
  const S = T.S, r = S.renderer, base = new Set(r.info.programs.map((p) => p.cacheKey));
  T.log(`hangar: ${base.size} programs`);
  for (const loc of PLACES) {
    await T.step(`${loc}: programs a start compiles`, async () => {
      const had = new Set(r.info.programs);
      await T.start('Kestrel', loc);
      await T.frames(2, { what: 'the first frames after the warm-up' });
      const used = drawnWith(S);
      const fresh = r.info.programs.filter((p) => !base.has(p.cacheKey) && (!had.has(p) || used.has(p)));
      const by = {};
      for (const p of fresh) { const k = family(p.cacheKey); by[k] = (by[k] || 0) + 1; }
      return `${fresh.length} programs: ` + Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
    });
    await T.end();
  }
}

// every program the flight scene's materials (and their custom depth materials) hold
function drawnWith(S) {
  const r = S.renderer, out = new Set();
  S.F.scene.traverse((o) => { for (const m of [o.material, o.customDepthMaterial, o.customDistanceMaterial].flat()) if (m) for (const p of r.properties.get(m)?.programs?.values?.() || []) out.add(p); });
  return out;
}

// three's cache key starts with the shader's id (two numbers for a ShaderMaterial) and ends, after the renderer's
// output colour space, with the material's customProgramCacheKey (its onBeforeCompile's source unless set): the
// shader plus the key's named parts ('skyheat2|cabin1|crew2'; hook source left out)
function family(key) {
  const a = key.slice(0, key.indexOf(',')), at = key.lastIndexOf(',srgb,');
  const parts = at < 0 ? [] : key.slice(at + 6).split('|');
  const named = []; for (const p of parts) { if (/^\s*(function\b|\(?[\w, ]*\)?\s*=>)/.test(p)) break; named.push(p.slice(0, 24)); }
  return (/^\d+$/.test(a) ? 'shader' : a) + (named.length ? ':' + named.join('|') : '');
}
