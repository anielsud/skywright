#!/usr/bin/env python3
"""Skywright boat ride test: boots the game in headless Chrome and runs tools/test/boatride.js.

Run from anywhere:  python3 tools/test/boatride.py [--json out.json] [--port 9874] [--only nyc]
1. On open water with a swell (the game's own physics at 60 Hz): every stock boat in Arcade, Pilot and Sim floats level,
   gets up on the plane (the bow rises, then levels out; a displacement hull reaches hull speed instead), turns left and
   right, stops and stays upright. A capsized boat rights itself (Arcade, Pilot), a boat on land at full gas just sits
   (nothing moves, breaks or explodes), ten random kid's boat builds float (and go, with the motor in the water), and
   no other stock vehicle is taken for a boat.
2. At every location with a marina (Bora Bora, New York, Jungfrau, Grand Canyon): a flight is started there and every
   stock boat, in Arcade and Sim, starts afloat and level at the marina facing open water and does the same ride in the
   real world (shore, docks); a car drives out along the pier.
Exits non-zero on any failure. Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

LOCS = ['islands', 'nyc', 'lauterbrunnen', 'canyon']
BOATS = "__sky.presets.filter((d) => __sky.analyze(d).boat)"


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skyboat-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1000,700')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    report = []
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            if not a.only:
                report += await cdp.js(f"import('/tools/test/boatride.js').then((m) => {{ const b = {BOATS}; return m.flat(b, __sky.presets.filter((d) => !b.includes(d))).map(({{ ac, ...r }}) => r); }})", timeout=900)
                report += await cdp.js("import('/tools/test/boatride.js').then((m) => m.amphibRides(__sky.presets).map(({ ac, ...r }) => r))", timeout=900)
            # every marina at Low (the tablet's setting: the coarsest terrain tiles), the river landing at High too
            for loc in ([a.only] if a.only else LOCS):
              for q in (['low', 'high'] if loc == 'canyon' else ['low']):
                await cdp.js(f"(() => {{ const S = __sky; if (S.F) S.endFlight(); S.settings.quality = '{q}'; S.applyQuality(); S.flightCfg.location = '{loc}'; S.flightCfg.mode = 'free'; S.hangar.load({BOATS}[0]); S.startFlight(); return 1; }})()")
                await cdp.wait_for('__sky.F && __sky.F.ac && __sky.F.t > 0.5', 180, f'a flight at {loc}')
                # the terrain tiles around the start stream in over the first seconds: test on the ground the player gets
                await cdp.wait_for('(() => { const t = __sky.F.world.tiles; return !t || (!t.queue.length && !t.job); })()', 120, f'the terrain tiles at {loc}')
                rows = await cdp.js(f"import('/tools/test/boatride.js').then((m) => {{ __sky.F.paused = true; const r = m.marina(__sky.F, {BOATS}, __sky.presets); __sky.F.paused = false; return r.map(({{ ac, ...x }}) => x); }})", timeout=900)
                for r in rows:
                    r['name'] = f"[{q}] {r['name']}"
                report += rows
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in report if not r['ok']]
    for r in report:
        nums = f"  top {r['top']:4.1f} m/s  Fn {r['fn']:.2f}  bow up {r['bowUp']:4.1f}°  on the plane {r['cruise']:4.1f}°  turns {r['left']:+.0f}° {r['right']:+.0f}°  bank {r['bank']:.0f}°" if 'left' in r else ''
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['name']:<58}{nums}" + ('' if r['ok'] else f"\n      {r['why']}"))
    for p in probs.take()[:10]:
        print('      page:', p)
        bad.append(p)
    print(f'\n{len(report)} checks, {len(bad)} failed')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--only', choices=LOCS, help='just the marina rides at this location')
    ap.add_argument('--url', help='test an already running server instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
