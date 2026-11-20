#!/usr/bin/env python3
"""Landing gear geometry check: boots Skywright in headless Chrome and runs tools/test/gearcheck.js.

Run from anywhere:  python3 tools/test/gearcheck.py [--only Kestrel] [--random 20] [--seed 1]
Builds every preset (as is, resized, mirrored) plus seeded random player builds (gear, floats and skids dropped on
bodies, wings, wingtips, pods and flaps the way the hangar places them, some resized or rotated, and mirrored) and
checks that no strut passes through a part (control surfaces included), every leg/brace ends on a solid skin, every
wheel stands upright, and mirrored gear mirrors exactly. Exits non-zero on any failure. Needs what smoke.py needs.
"""
import argparse, asyncio, json, os, shutil, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import ROOT, CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402


async def run(url, ws_url, arg):
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
        await cdp.send('Network.setCacheDisabled', cacheDisabled=True)
        await cdp.send('Page.navigate', url=url)
        await cdp.wait_for('window.__sky && window.__sky.presets.length', 40, 'window.__sky')
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gearcheck.js')).read()
        return await cdp.js(f'(async (ARG) => {{ {body}\n}})({json.dumps(arg)})', timeout=900)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', action='append', help='check just this preset (repeatable; no random builds)')
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--speed', type=int, default=6, help='number of random builds on the speed parts (Chined Body, Spike Ramjet) (default 6)')
    ap.add_argument('-v', '--verbose', action='store_true', help='list every build, not just failures')
    ap.add_argument('--dump', action='store_true', help='print the design JSON of each failing build')
    ap.add_argument('--url', help='check the game served here instead of this checkout (e.g. a baseline build)')
    args = ap.parse_args()
    port, cdp_port = free_port(), free_port()
    profile = tempfile.mkdtemp(prefix='skywright-chrome-')
    srv = None if args.url else start_server(port)
    proc, ws_url = launch_chrome(cdp_port, profile, '1280,800')
    try:
        res = asyncio.run(run(args.url or f'http://127.0.0.1:{port}/', ws_url, {'only': args.only, 'random': args.random, 'seed': args.seed, 'speed': args.speed}))
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if srv:
            srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    failed = [r for r in res if r['bad']]
    for r in res:
        if r['bad'] or args.verbose:
            print(f"{'FAIL' if r['bad'] else 'ok  '} {r['label']} ({r['gear']} gear)")
            for b in r['bad']:
                print('      ' + b)
            if args.dump and r.get('design'):
                print('      design: ' + json.dumps(r['design']))
    print(f"{len(res) - len(failed)}/{len(res)} builds pass ({sum(r['gear'] for r in res)} gear parts checked)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
