#!/usr/bin/env python3
"""Skywright start-up bakes check: what the deploy bakes into assets/boot (tools/bake/boot.py) and what the game keeps
for the visit or on the device is exactly what it would work out itself (tools/test/startbakes.js):

  - views (Node tier): cockpit views (src/stations.js, which cabin linings cover the windows) of a sample of the stock
    vehicles (every one with linings, plus a few without; --presets all for every one): worked out with no cache ==
    from the visit's cache == from a bake round-tripped through JSON (same linings, same settled eyes), and the cache
    is really used for every seat that has linings. (The deploy's bake checks every stock vehicle against its own
    output: boot.py, verifyBake.)
  - stunts (browser): stunt park sites (src/stuntSite.js findSite) at every place that searches for one, in the World
    built there as a flight builds it: the site the World planned == a fresh search on that World == the bake's
    (bakeStuntSites, as boot.py writes it); planning again there (as a second flight does) takes it from the visit's
    cache and gets the same site.

Run from anywhere:  python3 tools/test/startbakes.py [--only views|stunts] [--presets all|Jumbo,Kestrel] [--locations nyc]
The stunts part needs what smoke.py needs (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, subprocess, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import ROOT, free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

LOCATIONS = ['islands', 'nyc', 'lauterbrunnen']  # (the Grand Canyon's park sits at its jump: no search)
MOD = "import('/tools/test/startbakes.js')"


def views(a):
    env = {**os.environ, **({'SKY_BAKES_VIEWS': a.presets} if a.presets else {})}
    return subprocess.run(['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'startbakes'], cwd=ROOT, env=env).returncode


async def stunts(a):
    port = free_port(); srv = start_server(port)
    profile = tempfile.mkdtemp(prefix='skybake-')
    proc, ws_url = launch_chrome(free_port(), profile, '1000,700')
    origin = f'http://127.0.0.1:{port}'
    out = []  # (name, ok, detail)
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); probs = Problems(origin); cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar && window.__sky.presets.length', 120, 'the app to boot')
            for loc in a.locations.split(','):
                t0 = time.time()
                r = await cdp.js(f'{MOD}.then((m) => m.stuntsAt({json.dumps(loc)}))', timeout=300)
                if not r['searched']:
                    out.append((f'stunts: {loc}', True, 'no site search here')); continue
                p, (s0, s1, s2) = r['planned'] or {}, r['stats']
                out.append((f'stunts: {loc}: planned == fresh search == bake', r['freshSame'] and r['bakeSame'] and bool(r['planned']),
                            f"site ({p.get('x')}, {p.get('z')}) yaw {p.get('yaw')}; fresh {r['freshSame']}, bake {r['bakeSame']}; {time.time() - t0:.1f} s {r['ms']}"))
                out.append((f"stunts: {loc}: planned again from the visit's cache", s2['kept'] == s1['kept'] + 1 and s2['found'] == s1['found'] and r['againSame'],
                            f"stats {s0} -> {s1} -> {s2}, same site {r['againSame']}"))
            for pr in probs.take():
                out.append(('no console errors', False, pr))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True); srv.shutdown()
    bad = 0
    for n, ok, d in out:
        print(f"{'PASS' if ok else 'FAIL'}  {n}  {d}"); bad += not ok
    print(f'{len(out) - bad}/{len(out)} stunt site checks passed')
    return bad


def main(a):
    failed = []
    if a.only in (None, 'views') and views(a):
        failed.append('views')
    if a.only in (None, 'stunts') and asyncio.run(stunts(a)):
        failed.append('stunts')
    print(f"\n{'FAIL' if failed else 'PASS'}  startbakes" + (f": {', '.join(failed)}" if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', choices=['views', 'stunts'])
    ap.add_argument('--presets', help="views of these stock vehicles (comma-separated, or 'all'; default: the sample)")
    ap.add_argument('--locations', default=','.join(LOCATIONS))
    sys.exit(main(ap.parse_args()))
