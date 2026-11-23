#!/usr/bin/env python3
"""Skywright mesh check: builds every stock vehicle and 20 seeded random player builds (engines, canopies and car parts
in varied places, resized and mirrored) in headless Chrome, the way the hangar shows them, and fails on
  - open shells: a non-flat piece of an opaque one-sided mesh with a hole big enough to look into (a duct, nozzle,
    tyre or cowl with no inside surface, a missing end cap), and
  - car exhausts whose path runs through glass, and
  - floating parts: every piece must touch (within 1 cm) the rest of the vehicle, at rest and with the wheels pushed up
    their travel and steered, on every stock vehicle, the 20 random builds re-placed the way the hangar places parts,
    16 seeded random car builds and 10 bike builds, and
  - tube seams (every vehicle, plus 16 seeded random tube-to-tube builds): where two tubes meet end to end, the skin
    across the seam has no inward dip and no crease in the shading.

Run from anywhere:  python3 tools/test/meshcheck.py [--only TEXT] [--jobs N] [--json out.json]
By default it runs in Node on a pool of workers (tools/test/node/run.mjs meshcheck: about a minute; --only matches a
design's name or any part id in it, e.g. --only ck_bubble). --chrome runs the old way, in headless Chrome, one design
after another (same results, several times slower; needs Chrome + the websockets package). See tools/test/README.md.
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
            report = await cdp.js(f"import('/tools/test/meshcheck.js').then((m) => m.run({{ presets: __sky.presets, random: {a.random}, placed: {a.placed}, cars: {a.cars}, bikes: {a.bikes}, speed: {a.speed}, seams: {a.seams} }}))", timeout=1800)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = 0
    for r in report:
        ex = r.get('exhaust', {})
        fl, fm = r.get('floating', []), r.get('floatingMoved', [])
        sm = [j for j in r.get('seams', []) if j['bad']]
        issues = len(r.get('open', [])) + len(ex.get('hits', [])) + len(r.get('nav', [])) + len(fl) + len(fm) + len(sm) + (1 if r.get('error') else 0)
        bad += issues
        car = f'  floating {len(fl)} at rest, {len(fm)} moved ({r["pieces"]} pieces)' if 'floating' in r else ''
        sj = f'  tube seams {len(r["seams"]) - len(sm)}/{len(r["seams"])} smooth' if r.get('seams') else ''
        print(f'{"FAIL" if issues else "PASS"}  {r["name"]:<44} open shells {len(r.get("open", []))}  exhaust paths {ex.get("paths", 0)}, through glass {len(ex.get("hits", []))}{car}{sj}')
        for j in sm[:8]:
            print(f'      tube seam {j["a"]} | {j["b"]} at {j["C"]}: dip {j["dip"] * 1000:.1f} mm (tol {j["tol"] * 1000:.1f}) at {j["dipAt"]}, normal jump {j["nrm"]} deg at {j["nrmAt"]}')
        for o in fl[:8]:
            print(f'      floating: {o["what"]:<60} {o["n"]} piece(s), biggest {o["size"]} m at {o["at"]}, {o.get("gap")} m off')
        for o in fm[:8]:
            print(f'      floating (wheels up and steered): {o["what"]:<40} {o["n"]} piece(s), biggest {o["size"]} m at {o["at"]}, {o.get("gap")} m off')
        if r.get('error'):
            print('      error:', r['error'][:400])
        for o in r.get('nav', [])[:8]:
            print(f'      position light: part {o["part"]}: {o["issue"]}')
        for o in r.get('open', [])[:8]:
            print(f'      open: {o["part"]:<16} {o["mat"]:<22} hole {o["loop"]} m round, piece {o["size"]} m at {o["at"]}')
        for h in ex.get('hits', [])[:4]:
            print(f'      exhaust through glass at {h["at"]}')
    for p in probs.take()[:10]:
        print('      page:', p)
    print(f'\n{len(report)} vehicles, {bad} problems')
    return 1 if bad else 0


def node(a):
    import subprocess
    cmd = ['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'node', 'run.mjs'), 'meshcheck']
    if a.only: cmd += ['--only', a.only]
    if a.jobs: cmd += ['--jobs', str(a.jobs)]
    if a.json: cmd += ['--json', a.json]
    return subprocess.call(cmd)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--chrome', action='store_true', help='run in headless Chrome, one design at a time (the old way; same results)')
    ap.add_argument('--only', help='Node: only designs whose name or parts contain this text')
    ap.add_argument('--jobs', type=int, help='Node: worker threads (default: cores - 2)')
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--placed', type=int, default=20, help='number of random builds re-placed the way the hangar places parts, checked for floating parts (default 20)')
    ap.add_argument('--cars', type=int, default=16, help='number of random car builds checked for floating parts (default 16)')
    ap.add_argument('--bikes', type=int, default=10, help='number of random bike builds checked for floating parts (default 10)')
    ap.add_argument('--speed', type=int, default=10, help='number of random speed builds (SR-71 parts) checked for open shells and floating parts (default 10)')
    ap.add_argument('--seams', type=int, default=16, help='number of random tube-to-tube builds (default 16)')
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--url', help='check an already running server (e.g. http://127.0.0.1:8000) instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    a = ap.parse_args()
    sys.exit(asyncio.run(main(a)) if a.chrome else node(a))
