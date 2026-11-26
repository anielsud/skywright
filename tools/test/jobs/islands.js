// Job: Bora Bora (islands; one World, built once; every vehicle swapped into it). Run by tools/test/jobs.py; see
// harness.js for T and the rules (build once, step with T.advance, draw fixed frame counts only for drawing claims,
// wait on states).
//
// TODO (#278): write the steps. Planned, every check accounted for:
//   - Kestrel (the first T.start here builds the islands): the tour flight (smoke.js tour() + tourChecks()); the
//     shader sweep's scene and events phases (shadercheck.js sceneDrawn(), eventsFired(), phaseChecks())
//   - Albatross (water start) and Kite (air start): quick stepped checks (T.advance; finite, in one piece)
//   - Speedboat from the marina (tour)
//   - Rocket on the pad (padcheck.js rocket('islands') + rocketChecks())
//   - SR-71: the climb and the landing stepped (sr71flight.js, as smoke.py sr71_climb / sr71_land drive it: port the
//     verdicts to JS; one screenshot), then the water crash (shadercheck.js crash('islands'))
//   - startbakes-stunts (startbakes.js stuntsIn(T.F.world) + stuntsChecks())
// Keep BASE's time and weather (T.start's cfg: start, mode, realism, landStart, boatStart only), or the islands are
// built again.
export async function run(T) {
  await T.step('islands: not written yet', async () => { throw new Error('TODO: tools/test/jobs/islands.js (#278)'); });
}
