#!/usr/bin/env python3
"""Skywright mesh check: builds every stock vehicle and 20 seeded random player builds (engines, canopies and car parts
in varied places, resized and mirrored) in headless Chrome, the way the hangar shows them, and fails on
  - open shells: a non-flat piece of an opaque one-sided mesh with a hole big enough to look into (a duct, nozzle,
    tyre or cowl with no inside surface, a missing end cap), and
  - car exhausts whose path runs through glass.

Run from anywhere:  python3 tools/test/meshcheck.py [--random 20] [--json out.json]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skymesh-')
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
            report = await cdp.js(f"import('/tools/test/meshcheck.js').then((m) => m.run({{ presets: __sky.presets, random: {a.random} }}))", timeout=600)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = 0
    for r in report:
        ex = r.get('exhaust', {})
        issues = len(r.get('open', [])) + len(ex.get('hits', [])) + (1 if r.get('error') else 0)
        bad += issues
        print(f'{"FAIL" if issues else "PASS"}  {r["name"]:<34} open shells {len(r.get("open", []))}  exhaust paths {ex.get("paths", 0)}, through glass {len(ex.get("hits", []))}')
        if r.get('error'):
            print('      error:', r['error'][:400])
        for o in r.get('open', [])[:8]:
            print(f'      open: {o["part"]:<16} {o["mat"]:<22} hole {o["loop"]} m round, piece {o["size"]} m at {o["at"]}')
        for h in ex.get('hits', [])[:4]:
            print(f'      exhaust through glass at {h["at"]}')
    for p in probs.take()[:10]:
        print('      page:', p)
    print(f'\n{len(report)} vehicles, {bad} problems')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--url', help='check an already running server (e.g. http://127.0.0.1:8000) instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
