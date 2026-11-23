#!/usr/bin/env python3
"""Skywright water park test: drives every stock boat (and a kid's random boat builds) through the water park at every
location that has one (src/waterPark.js) on the real flight model with scripted inputs (full gas, a lane-keeping
steer). Two tiers:

  Node (tools/test/waterpark.js nodeSuite, run by tools/test/node/run.mjs on real Worlds built in Node, headless):
  - the reference park (Bora Bora's; the course is the same everywhere): every stock boat's MEGA JUMP from the start
    arch in Arcade and Pilot (boost strip, ramp, real air, clears the island / barge / raft, splashes down upright with
    every part; Sim flown and reported, not judged), the kickers' lane to the hoop, flat out the wrong way into the
    back and the side of the MEGA JUMP ramp (nothing breaks off); the slalom says PERFECT SLALOM and the waterfall
    SPLASH!; 8 random kid's boat builds from the boost strip;
  - at every place with a water park: the site is open, deep water, nothing built on it, no bridge, clear of the
    marina; the park within 6 draw calls and 32k triangles; every stock boat starts at the arch, afloat, facing down
    the course; every stock boat's MEGA JUMP in Arcade and Pilot (the place's swell and obstacle); no warnings. At the
    Grand Canyon (the Colorado is too narrow for one) none is built and a boat's start there is the marina.
  Browser (placecheck.py --only waterpark): main.js starts a boat that picks 'At the water park' at New York's arch,
  afloat, and at the Grand Canyon at the marina; no shader compiled mid-flight at New York; no page errors.

Run from anywhere:  python3 tools/test/waterpark.py [--node-only | --browser-only] [--only TEXT] [--shots DIR [--locations islands,nyc]]
Same requirements as smoke.py (Chrome + the websockets package; Node for the Node tier). See tools/test/README.md.
"""
import argparse, asyncio, os, subprocess, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402
import placecheck  # noqa: E402

S = 'window.__sky'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LOCATIONS = ['islands', 'nyc', 'lauterbrunnen']


async def shots(cdp, d, loc):
    os.makedirs(d, exist_ok=True)
    await cdp.js("import('/tools/test/waterpark.js').then((m) => { window.__wp = m; return 1; })")
    await cdp.js(f"""(() => {{ const F = {S}.F; F.paused = true; F.world.gust.set(0, 0, 0);
      window.__cam = (p, t) => {{ const c = {S}.rig.cam, k = F.world.waterParks.park, V = {S}.THREE.Vector3; const a = k.W(new V(...p)), b = k.W(new V(...t)); c.position.copy(a); c.lookAt(b); c.userData.focus = c.position.clone(); F.world.update(0.016, c, new V(), []); F.world.flora?.update?.(c.position); return 1; }};
      document.getElementById('flight-ui').style.display = 'none'; return 1; }})()""")
    async def shot(name, js, settle=2.5):
        v = await cdp.js(js)
        if isinstance(v, str): print(f'  {name}: {v}')
        await asyncio.sleep(settle)
        await cdp.screenshot(os.path.join(d, f'{loc}-water-{name}'))
    await shot('overview.png', "__cam([-230, 95, 150], [-10, 0, 0])", 5)
    await shot('start.png', "(() => { const k = __sky.F.world.waterParks.park, s = k.Lp(k.start.pos); return __cam([s.x - 24, 5, s.z + 4], [s.x + 60, 3, s.z - 1]); })()")
    await shot('mega.png', "(() => { const r = __sky.F.world.waterParks.park.ramps.find((q) => q.name === 'mega'); return __cam([r.x0 - 22, 8, 26], [r.x1 + 10, 2, -2]); })()")
    await shot('boat-in-the-air.png', "(() => { const r = __sky.F.world.waterParks.park.ramps.find((q) => q.name === 'mega'), o = __sky.F.world.waterParks.park.obstacleAt; const p = __wp.stage('Speedboat', (a, x) => x > (o.x0 + o.x1) / 2); return __cam([p[0] - 12, p[1] + 1, p[2] + 22], [p[0] + 2, p[1] - 1, p[2]]); })()")
    await shot('fireboat-in-the-air.png', "(() => { const o = __sky.F.world.waterParks.park.obstacleAt; const p = __wp.stage('Fireboat', (a, x) => x > o.x0 + 2); return __cam([p[0] - 18, p[1] + 3, p[2] - 26], [p[0] + 2, p[1] - 1, p[2]]); })()")
    await shot('kickers-hoop.png', "(() => { const k = __sky.F.world.waterParks.park, h = k.hoops[0]; return __cam([h.x - 55, 7, h.z - 22], [h.x - 10, 3, h.z]); })()")
    await shot('jetski-hoop.png', "(() => { const k = __sky.F.world.waterParks.park, h = k.hoops[0], m = k.ramps.find((q) => q.name === 'small'); const p = __wp.stage('Jet Ski', (a, x) => x > h.x - 1, 40, h.z, m.x0 - 40); return __cam([h.x + 14, 4, h.z - 14], [h.x - 2, p[1], h.z]); })()")
    await shot('slalom-waterfall.png', "(() => { const k = __sky.F.world.waterParks.park, g = k.gates, f = k.falls[0]; return __cam([g[1].x, 9, -90], [g[3].x + 10, 1, f.z]); })()")
    await shot('island-stands.png', "(() => { const k = __sky.F.world.waterParks.park, o = k.obstacleAt; return __cam([o.x1 + 28, 7, 32], [(o.x0 + o.x1) / 2 - 8, 2, -8]); })()")
    await shot('night.png', "(() => { __sky.F.world.setTime(21.5); const k = __sky.F.world.waterParks.park, s = k.Lp(k.start.pos); return __cam([s.x - 24, 6, s.z + 4], [s.x + 60, 3, s.z - 1]); })()", 3)




async def photograph(a):
    """--shots: each place's water park, in a browser of its own."""
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skywater-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            for loc in a.locations.split(','):
                await placecheck.fly(cdp, loc, 'Speedboat', {'boatStart': 'waterpark'})
                if await cdp.js(f'!!{S}.F.world.waterParks'):
                    await shots(cdp, os.path.abspath(a.shots), loc)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()


def main(a):
    rc = 0
    if not a.browser_only and not a.shots_only:
        rc |= subprocess.run(['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'waterpark'] + (['--only', a.only] if a.only else []), cwd=ROOT).returncode
    if not a.node_only and not a.shots_only:
        rc |= asyncio.run(placecheck.main(placecheck.parser().parse_args(['--only', 'waterpark', '--port', str(a.port), '--cdp-port', str(a.cdp_port)] + (['--url', a.url] if a.url else []))))
    if a.shots:
        asyncio.run(photograph(a))
    return 1 if rc else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--node-only', action='store_true', help='only the Node tier')
    ap.add_argument('--browser-only', action='store_true', help='only the browser checks')
    ap.add_argument('--only', help='Node tier: only the cases whose descriptor contains this text (e.g. nyc, Fireboat, ref)')
    ap.add_argument('--shots', metavar='DIR', help='also save screenshots of each water park and boats mid-jump to DIR')
    ap.add_argument('--locations', default=','.join(LOCATIONS), help='with --shots: the places to photograph (default: the three with a water park)')
    ap.add_argument('--shots-only', action='store_true', help='with --shots: only the screenshots')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(main(ap.parse_args()))
