#!/usr/bin/env python3
"""Skywright cockpit check: every cockpit view (one per seat, src/stations.js) of every stock vehicle (as is, resized,
mirrored), multi-station builds (bomber gunners, twin cockpits, resized and turned canopies, a capsule, a build with no
cockpit) and seeded random player builds, built as flight Aircraft in headless Chrome. Fails when an eye point is
  - outside its cockpit (the box of its seat's part and figure),
  - inside solid geometry (within 3 cm of a surface, or looking out through the backs of one-sided surfaces), or
  - without a clear line of sight forward out of the glass (3 of 5 rays ahead must meet glass, or nothing solid
    within 1.2 m).
It also lists the stations of each stock vehicle.

Run from anywhere:  python3 tools/test/cockpitcheck.py [--random 20] [--seed 7] [--json out.json] [--url http://127.0.0.1:8000]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skyck-')
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
            js = f"import('/tools/test/cockpitcheck.js').then((m) => m.run({{ presets: __sky.presets, random: {a.random}, seed: {a.seed} }}))"
            report = await cdp.js(js, timeout=900)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = views = notes = 0
    for r in report:
        if r.get('error'):
            bad += 1
            print(f'FAIL  {r["name"]:<52} error: {r["error"][:300]}')
            continue
        sts = r['stations']; views += len(sts)
        n = sum(1 for s in sts if s['issues']); bad += n
        names = ', '.join(s['name'] for s in sts)
        print(f'{"FAIL" if n else "PASS"}  {r["name"]:<52} {len(sts)} view(s): {names}')
        for s in sts:
            if s.get('note'):
                notes += 1
            if s['issues'] or a.verbose or s.get('note'):
                print(f'      {s["name"]:<16} {s["part"]:<13} eye {s["at"]}  clearance {s.get("clear", "-")} m  forward {s.get("los", "-")}/5  {"; ".join(s["issues"]) or s.get("note", "")}')
    for p in probs.take()[:10]:
        print('      page:', p)
    print(f'\n{len(report)} vehicles, {views} cockpit views, {bad} problems ({notes} cockpits buried in a body: eye above them, checked)')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--seed', type=int, default=7, help='seed for the random builds (default 7)')
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--verbose', action='store_true', help='print every view, not only failing ones')
    ap.add_argument('--url', help='check an already running server (e.g. http://127.0.0.1:8000) instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
