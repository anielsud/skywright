// Job: a real place at Ultra, the baked layout on (its default). Run by tools/test/jobs.py; see harness.js for T.
// Whatever --quality the job is run at (CI: low), this one builds Lauterbrunnen at Ultra: Ultra's 4 cascades' shadow
// maps are 3 samplers more in every lit shader than High's, so a material near the 16 texture units is only over them
// here (1.261.0: today's terrain with the layout's mask was 17, didn't link, and drew holes; shadercheck.js programs).
//   lauterbrunnen at ultra: build + Kestrel (runway); the whole scene drawn (1 frame: every program compiled); every
//                           program links and none is over 16 texture units
import { sceneDrawn, phaseChecks, programs, programChecks } from '../shadercheck.js';

export async function run(T) {
  const S = T.S;
  await T.step('lauterbrunnen at ultra: build + Kestrel', async () => {
    S.settings.quality = 'ultra'; S.applyQuality();
    const s = await T.start('Kestrel', 'lauterbrunnen');
    T.check('built at Ultra (4 cascades)', T.F.world.cascades?.lights.length === 4, `cascades ${T.F.world.cascades?.lights.length ?? 'none'}`);
    T.check('the layout is on', !!T.F.world.layout, '');
    return `${s.how} in ${(s.ms / 1000).toFixed(1)} s, start ${s.start}`;
  });
  await T.step('lauterbrunnen at ultra: scene drawn; programs link, within 16 texture units', async () => {
    const r = await sceneDrawn();
    T.checks(phaseChecks('ultra scene', r, { late: false }));
    const p = programs();
    T.checks(programChecks('ultra', p));
    return `${r.objects} hidden/culled things shown; ${p.n} programs, the most samplers ${p.most} (${p.mostName}) of ${p.units}`;
  });
}
