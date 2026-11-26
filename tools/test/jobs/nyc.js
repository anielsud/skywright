// Job: New York (one World, built once; every vehicle swapped into it). Run by tools/test/jobs.py; see harness.js for T
// and the rules (build once, step with T.advance, draw fixed frame counts only for drawing claims, wait on states).
//
// TODO (#278): write the steps. Planned, every check accounted for:
//   - Dragonfly, Pilot (the first T.start here builds New York): helipad checks stepped (helipadcheck.js heli(): it
//     swaps into this World; port helipadcheck.py's verdicts to JS as heliChecks(r)); runway baseline by teleport;
//     the tour flight on the real loop (smoke.js tour() + tourChecks()); cockpit views; the shader sweep's scene and
//     events phases (shadercheck.js sceneDrawn(), eventsFired(), phaseChecks())
//   - Dragonfly, Arcade (swapped: realism doesn't rebuild the World)
//   - Rocket on the pad (padcheck.js rocket('nyc') + rocketChecks())
//   - Dune Buggy: the start arch, road start, the loop run (placecheck.py's stunts part: stunts.js siteCheck/loopRun/
//     judge), walls (walls.js faces/gameRun) = the building crash (shadercheck.js crash('nyc'))
//   - Dirt Bike (arch and road), Speedboat and Jet Ski (water park start: placecheck.py's waterpark part)
//   - startbakes-stunts (startbakes.js stuntsIn(T.F.world) + stuntsChecks())
//   - start-rule wiring (padcheck.js predict() + padcheck.py check_predicted/check_spawns, ported: a plane and a car
//     start where the rule says, nothing but a rocket on the pad, nothing but a helicopter on the helipad)
// Keep BASE's time and weather (T.start's cfg: start, mode, realism, landStart, boatStart only), or New York is built
// again.
export async function run(T) {
  await T.step('nyc: not written yet', async () => { throw new Error('TODO: tools/test/jobs/nyc.js (#278)'); });
}
