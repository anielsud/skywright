#!/usr/bin/env python3
"""Skywright stunt park test: drives stock cars and bikes through the stunt park at every location (and the Grand
Canyon's daredevil canyon jump) on the real flight model with scripted inputs (gas, a lane-keeping steer). Two tiers:

  Node (tools/test/stunts.js nodeSuite, run by tools/test/node/run.mjs on real Worlds built in Node, headless):
  - the reference park (the compact layout every place uses, on a flat lot): every car and bike, Pilot and Arcade:
    the loop run (kickers, boost, loop: air off the last kicker, over the top upside down on its wheels, out upright in
    the exit lane), coasting into the loop at the boost's speed still loops and far too slow rolls back, the mesa jump,
    the bowl at 14, 20, 26 and 34 m/s, the banked turn hands off;
  - at every place: the site is dry, flat and clear; every car and bike starts at the arch, on the road (and at the
    Grand Canyon at the canyon jump) facing the right way; the loop run from the arch and the mesa jump (the place's
    ground and theme), in Pilot; no stunt site warnings;
  - at the Grand Canyon, Pilot and Arcade: the loop run and the mesa jump, the link and fork (hands off takes the
    banked turn, steered right takes the link lane onto the canyon jump's run-up), the canyon jump from its start, the
    long run-up from the park (and beside the rocket strip: too slow, the rescue parachute), and a car too slow for the
    jump lowered into the canyon by the parachute.
  Browser (placecheck.py --only stunts, at New York: what needs the page or the imagery):
  - main.js starts a car and a bike at the arch and on the road, facing the right way; New York's site is dry, flat
    and clear, tree canopy included (the imagery doesn't decode in Node), and the loop run from its real arch; no
    shader compiled mid-flight there (the other places: the shader check, shadercheck.py / smoke.py); no page errors or site warnings.

Run from anywhere:  python3 tools/test/stunts.py [--node-only | --browser-only] [--only TEXT] [--shots DIR [--locations canyon,nyc]]
Same requirements as smoke.py (Chrome + the websockets package; Node for the Node tier). See tools/test/README.md.
"""
import argparse, asyncio, json, os, subprocess, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402
import placecheck  # noqa: E402

S = 'window.__sky'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LOCATIONS = ['canyon', 'nyc', 'lauterbrunnen', 'islands']


async def shots(cdp, d, loc, evel):
    """The park's overview, the start, the loop with a car upside down at its top; at the canyon, the jump with a car over the gap."""
    os.makedirs(d, exist_ok=True)
    await cdp.js("import('/tools/test/stunts.js').then((m) => { window.__stunts = m; return 1; })")
    await cdp.js(f"""(() => {{ const F = {S}.F; F.paused = true; F.world.gust.set(0, 0, 0);
      window.__cam = (p, t, which) => {{ const c = {S}.rig.cam, site = which === 'evel' ? F.world.stunts.evel : F.world.stunts.park, V = {S}.THREE.Vector3; const a = site.W(new V(...p)), b = site.W(new V(...t)); c.position.copy(a); c.lookAt(b); c.userData.focus = c.position.clone(); F.world.update(0.016, c, new V(), []); F.world.flora?.update?.(c.position); }};
      document.getElementById('flight-ui').style.display = 'none'; return 1; }})()""")
    async def shot(name, js, settle=2.5):
        v = await cdp.js(js)
        if isinstance(v, str): print(f'  {name}: {v}')
        await asyncio.sleep(settle)
        await cdp.screenshot(os.path.join(d, f'{loc}-{name}'))
    await shot('overview.png', "__cam([-170, 150, 210], [0, 0, 0])", 5)
    await shot('start.png', "(() => { const k = __sky.F.world.stunts.park, s = k.Lp(k.start.pos); __cam([s.x - 24, 4.5, s.z + 3], [s.x + 40, 2, s.z - 1]); return 1; })()")
    await shot('loop.png', "(() => { const L = __sky.F.world.stunts.park.loopInfo, x = L.entryX + 21; return __cam([x - 40, 7, 62], [x, 9, 30]); })()")
    await shot('car-mid-loop.png', "(() => { const L = __sky.F.world.stunts.park.loopInfo, b = -__sky.F.world.stunts.park.XS + __sky.F.world.stunts.park.L.boost; const p = __stunts.stage('Dune Buggy', b - 20, 33.5, 1, 20, (a) => a.up.y < -0.95); __cam([p[0] - 14, p[1] - 4, p[2] + 22], p); return 1; })()")
    await shot('bowl.png', "(() => { const X = -__sky.F.world.stunts.park.XS; return __cam([X + 2, 5, -6], [X - 40, 6, 14]); })()")
    await shot('bowl-rim.png', "(() => { const X = -__sky.F.world.stunts.park.XS; return __cam([X - 20, 22, -62], [X - 30, 4, 0]); })()")
    await shot('road.png', "(() => { const w = __sky.F.world, s = w.landStart('road'), c = __sky.rig.cam, V = __sky.THREE.Vector3; if (!s) return 'no road start'; const f = new V(-Math.sin(s.heading), 0, -Math.cos(s.heading)), p = s.pos.clone(); p.y = w.groundAt(p.x, p.z).h; c.position.copy(p).addScaledVector(f, -22).add(new V(0, 7, 0)); c.lookAt(p.clone().addScaledVector(f, 30)); c.userData.focus = c.position.clone(); w.update(0.016, c, new V(), []); w.flora?.update?.(c.position); return 1; })()", 4)
    if evel:
        await shot('evel-overview.png', "(() => { const P = __sky.F.world.stunts.evel.P; __cam([P.gap * 0.5, 120, 330], [P.gap * 0.5, -40, 0], 'evel'); return 1; })()", 5)
        await shot('evel-start.png', "(() => { const E = __sky.F.world.stunts.evel, s = E.Lp(E.start.pos); __cam([s.x - 20, 5, 6], [s.x + 60, 4, 0], 'evel'); return 1; })()")
        await shot('evel-ramp.png', "(() => { const P = __sky.F.world.stunts.evel.P; __cam([P.ramp0 - 30, 12, 36], [-8, 10, 0], 'evel'); return 1; })()")
        await shot('evel-car-over-canyon.png', "(() => { const E = __sky.F.world.stunts.evel, P = E.P, s = E.Lp(E.start.pos); const p = __stunts.stage('Dune Buggy', s.x, 0, 1, 0, (a, x) => x > P.gap * 0.42, 30, null, 'evel', false); __cam([p[0] - 30, p[1] + 6, p[2] + 40], [p[0] + 8, p[1] - 10, p[2]], 'evel'); return 1; })()")
        await shot('evel-landing.png', "(() => { const E = __sky.F.world.stunts.evel, P = E.P, s = E.Lp(E.start.pos); const p = __stunts.stage('Dune Buggy', s.x, 0, 1, 0, (a, x) => x > P.xT + 40, 30, null, 'evel', false); __cam([p[0] - 10, p[1] + 5, p[2] + 26], [p[0] + 6, p[1], p[2]], 'evel'); return 1; })()")




async def photograph(a):
    """--shots: each place's park (and the canyon jump), in a browser of its own."""
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skystunt-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            for loc in a.locations.split(','):
                await placecheck.fly(cdp, loc, 'Dune Buggy', {'landStart': 'park'})
                await shots(cdp, os.path.abspath(a.shots), loc, await cdp.js(f'!!{S}.F.world.stunts.evel'))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()


def main(a):
    rc = 0
    if not a.browser_only and not a.shots_only:
        rc |= subprocess.run(['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'stunts'] + (['--only', a.only] if a.only else []), cwd=ROOT).returncode
    if not a.node_only and not a.shots_only:
        rc |= asyncio.run(placecheck.main(placecheck.parser().parse_args(['--only', 'stunts', '--port', str(a.port), '--cdp-port', str(a.cdp_port)] + (['--url', a.url] if a.url else []))))
    if a.shots:
        asyncio.run(photograph(a))
    return 1 if rc else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--node-only', action='store_true', help='only the Node tier')
    ap.add_argument('--browser-only', action='store_true', help='only the browser checks')
    ap.add_argument('--only', help='Node tier: only the cases whose descriptor contains this text (e.g. canyon, "Dirt Bike", ref)')
    ap.add_argument('--shots', metavar='DIR', help='also save screenshots of each park, the canyon jump and cars mid-stunt to DIR')
    ap.add_argument('--locations', default=','.join(LOCATIONS), help='with --shots: the places to photograph (default: all four)')
    ap.add_argument('--shots-only', action='store_true', help='with --shots: only the screenshots')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(main(ap.parse_args()))
