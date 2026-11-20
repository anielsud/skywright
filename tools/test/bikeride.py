#!/usr/bin/env python3
"""Skywright bike ride test: boots the game in headless Chrome and runs tools/test/bikeride.js.

Run from anywhere:  python3 tools/test/bikeride.py [--json out.json] [--port 9874]
Every stock motorbike, in Arcade, Pilot and Sim, rides a script on flat ground (the game's own physics at 60 Hz):
gas, a left turn, a right turn, a hard stop and a wait. It must stay upright, turn the way it is steered, stop, and
stand still at the end. Arcade and Pilot also check a wheelie and a stoppie (they happen, stay within limits and come
back down); every mode checks a jump lands on both wheels. Then a kid's own bikes (hangar-placed random builds, some
on car wheels) must be detected as bikes and ride, and the stock cars must not be. Exits non-zero on any failure.
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skybike-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1000,700')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            report = await cdp.js("import('/tools/test/bikeride.js').then((m) => { const bike = (d) => __sky.analyze(d).bike; return m.plan(__sky.presets.filter(bike), __sky.presets.filter((d) => !bike(d))); })", timeout=600)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in report if not r['ok']]
    for r in report:
        if 'maxLean' in r:
            print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['name']:<70} lean {r['maxLean']:.2f}  up {r['minUp']:.2f}  top {r['maxSpeed']:4.1f} m/s  pitch {r['minPitch']:+.2f}..{r['maxPitch']:+.2f}" + ('' if r['ok'] else f"\n      {r['why']}"))
        else:
            print(f"{'SKIP' if r.get('skip') else 'PASS' if r['ok'] else 'FAIL'}  {r['name']}" + ('' if r['ok'] and not r.get('skip') else f"  ({r['why']})"))
    for p in probs.take()[:10]:
        print('      page:', p)
        bad.append(p)
    print(f'\n{len(report)} checks, {len(bad)} failed')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--url', help='test an already running server instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
