#!/usr/bin/env python3
"""Rocket handling check: boots Skywright in headless Chrome and runs tools/test/rocketcheck.js.
(The Node tier runs the same checks without a browser, much faster: python3 tools/test/run.py rocketcheck.)

Run from anywhere:  python3 tools/test/rocketcheck.py [--url http://host/]
Flies the Rocket preset with scripted stick input (no flight scene: flat ground, still air, fixed 1/60 s steps) and
checks, in Arcade and Pilot, that after a 1.2 s pitch-over or sideways push the nose stays where it was pointed when
the stick is let go (attitude hold, within 3 degrees; no swing back towards the start), and that a three-fin rocket
(radial symmetry copies) climbs in Sim with no roll and no lean. Exits non-zero on any failure. Needs what smoke.py needs.
"""
import argparse, asyncio, os, shutil, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402


async def run(url, ws_url):
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
        await cdp.send('Network.setCacheDisabled', cacheDisabled=True)
        await cdp.send('Page.navigate', url=url)
        await cdp.wait_for('window.__sky && window.__sky.presets.length', 40, 'window.__sky')
        return await cdp.js("import('/tools/test/rocketcheck.js').then((m) => m.plan(window.__sky.presets))", timeout=300)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='check the game served here instead of this checkout (it must serve tools/test/rocketcheck.js as a module)')
    args = ap.parse_args()
    port, cdp_port = free_port(), free_port()
    profile = tempfile.mkdtemp(prefix='skywright-chrome-')
    srv = None if args.url else start_server(port)
    proc, ws_url = launch_chrome(cdp_port, profile, '1280,800')
    try:
        res = asyncio.run(run(args.url or f'http://127.0.0.1:{port}/', ws_url))
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if srv:
            srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    for r in res:
        print(f"{'FAIL' if r['bad'] else 'ok  '} {r['label']}: {r['info']}")
        for b in r['bad']:
            print('      ' + b)
    failed = [r for r in res if r['bad']]
    print(f"{len(res) - len(failed)}/{len(res)} rocket checks pass")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
