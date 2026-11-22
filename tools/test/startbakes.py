#!/usr/bin/env python3
"""Skywright start-up bakes check: what the deploy bakes into assets/boot (tools/bake/boot.py) and what the game keeps
for the visit or on the device is exactly what it would work out itself (tools/test/startbakes.js):

  - cockpit views (src/stations.js, which cabin linings cover the windows) of every stock vehicle: worked out with no
    cache == from the visit's cache == from a bake round-tripped through JSON (same linings, same settled eyes), and
    the cache is really used for every seat that has linings;
  - stunt park sites (src/stuntSite.js findSite) at every place that searches for one: the site the World planned ==
    a fresh search on that World == the bake's (bakeStuntSites, as boot.py writes it); a second flight at the same
    place takes it from the visit's cache and gets the same site.

Run from anywhere:  python3 tools/test/startbakes.py [--only views|stunts] [--presets Jumbo,Kestrel] [--locations nyc]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md. About 2-4 minutes.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'
LOCATIONS = ['islands', 'nyc', 'lauterbrunnen']  # (the Grand Canyon's park sits at its jump: no search)
MOD = "import('/tools/test/startbakes.js')"


async def fly(cdp, loc, car):
    await cdp.js(f"""Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', start: 'runway', time: 11 }}); {S}.settings.quality = 'low';
        {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(car)})); {S}.startFlight(); 1""")
    await cdp.wait_for(f'{S}.F && {S}.F.ac && {S}.F.t > 0', 240, f'the flight at {loc}')
    r = await cdp.js(f'{MOD}.then((m) => m.stunts())', timeout=300)
    await cdp.js(f'{S}.endFlight()')
    await cdp.wait_for(f'!{S}.F', 60, 'back in the hangar')
    return r


async def main(a):
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
            await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 120, 'the app to boot')
            await cdp.wait_for("!document.getElementById('splash')", 60, 'the splash')
            if a.only in (None, 'views'):
                names = json.dumps(a.presets.split(',') if a.presets else None)
                rows = await cdp.js(f"{MOD}.then((m) => m.views({S}.presets.filter((d) => !{names} || {names}.includes(d.name))))", timeout=1200)
                for r in rows:
                    n = f"views: {r['name']}"
                    if r.get('error'):
                        out.append((n, False, r['error'][:300])); continue
                    ok = r['firstSame'] and r['againSame'] and r['bakeSame'] and r['keptAgain'] == r['lined'] and r['keptBake'] == r['lined'] and r['workedFirst']
                    out.append((n, ok, f"{r['seats']} seats, {r['lined']} with linings ({r['linings']} swapped); same: first {r['firstSame']}, cached {r['againSame']}, baked {r['bakeSame']}; "
                                       f"cache hits {r['keptAgain']}/{r['keptBake']}; stations ms {r['ms']}"))
            if a.only in (None, 'stunts'):
                for loc in a.locations.split(','):
                    r1 = await fly(cdp, loc, a.car)
                    r2 = await fly(cdp, loc, a.car)
                    if not r1['searched']:
                        out.append((f'stunts: {loc}', True, 'no site search here')); continue
                    p = r1['planned'] or {}
                    out.append((f'stunts: {loc}: planned == fresh search == bake', r1['freshSame'] and r1['bakeSame'] and bool(r1['planned']),
                                f"site ({p.get('x')}, {p.get('z')}) yaw {p.get('yaw')}; fresh {r1['freshSame']}, bake {r1['bakeSame']}"))
                    out.append((f'stunts: {loc}: second flight from the visit\'s cache', r2['stats']['kept'] > r1['stats']['kept'] and r2['planned'] == r1['planned'] and r2['freshSame'],
                                f"stats {r1['stats']} -> {r2['stats']}"))
            for pr in probs.take():
                out.append(('no console errors', False, pr))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True); srv.shutdown()
    bad = 0
    for n, ok, d in out:
        print(f"{'PASS' if ok else 'FAIL'}  {n}  {d}"); bad += not ok
    print(f'\n{len(out) - bad}/{len(out)} checks passed')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', choices=['views', 'stunts'])
    ap.add_argument('--presets', help='comma-separated stock vehicles for the views check (default: all)')
    ap.add_argument('--locations', default=','.join(LOCATIONS))
    ap.add_argument('--car', default='Kestrel', help='what to fly for the stunt site check')
    sys.exit(asyncio.run(main(ap.parse_args())))
