// Job: the Grand Canyon, then Lauterbrunnen, in one session (two Worlds, each built once; the second place must not
// compile what the first showed: the #187 check). Run by tools/test/jobs.py; see harness.js for T and the rules (build
// once, step with T.advance, draw fixed frame counts only for drawing claims, wait on states).
//
// TODO (#278): write the steps. Planned, every check accounted for:
//   canyon (the first T.start here builds it):
//   - Dirt Bike and Dune Buggy from the stunt park (tour: smoke.js tour() + tourChecks()); the Dune Buggy's ground
//     crash (shadercheck.js crash('canyon')); the shader sweep's scene and events phases
//   - Rocket on the pad (padcheck.js rocket('canyon') + rocketChecks())
//   lauterbrunnen (T.start there ends the canyon flight and builds it; T.noStalls over its first flights: #187):
//   - Rocket on the pad; startbakes-stunts (startbakes.js stuntsIn(T.F.world) + stuntsChecks())
//   - the restart suite (restart.js snap/damage/damaged/whole, as restart.py drives them: damage, restarts flat in
//     memory, every start type swapped in and restarted; T.restart() keeps the World)
// Keep BASE's time and weather (T.start's cfg: start, mode, realism, landStart, boatStart only), or a place is built
// again.
export async function run(T) {
  await T.step('canyon-lauterbrunnen: not written yet', async () => { throw new Error('TODO: tools/test/jobs/canyon-lauterbrunnen.js (#278)'); });
}
