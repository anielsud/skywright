#!/usr/bin/env python3
"""Skywright wall test: drives cars and bikes into buildings in headless Chrome and checks nothing gets inside them.

At New York (its city boxes), Lauterbrunnen (a real village: OpenStreetMap buildings) and the Alpine Valley town (the
generated towns), it picks building faces with a clear, flat run-up near the start and drives the Dune Buggy and the
Dirt Bike into each one: at 5, 15, 30 and 45 m/s, straight on, at 35 degrees and at 60 degrees the other way, full gas,
on the game's own physics stepped at 60 Hz (tools/test/walls.js). Every hull point and wheel of the vehicle is checked
against every building box nearby, every frame: none may get more than --tol metres inside one, and the straight-on
runs must actually reach the wall. Then a few runs go through the real game loop (the flight's own vehicle, its pedal
held down, building damage and all) and must stay out too.

Run from anywhere:  python3 tools/test/walls.py [--places nyc,lauterbrunnen,alpine] [--json out.json]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'


async def place(cdp, loc, a):
    await cdp.js(f"""(() => {{ if ({S}.F) {S}.endFlight();
        Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', start: 'runway', time: 11, realism: 'pilot' }}); {S}.settings.quality = {json.dumps(a.quality)};
        {S}.hangar.load({S}.presets.find((d) => d.name === 'Dune Buggy')); {S}.startFlight(); return 1; }})()""")
    await cdp.wait_for(f'{S}.F && {S}.F.t > 1', 180, f'the flight at {loc} to start')
    await asyncio.sleep(3)  # (New York streams its nearby tiles in)
    return await cdp.js(f"import('/tools/test/walls.js').then((m) => JSON.stringify(m.run({S}, ['Dune Buggy', 'Dirt Bike'])))", timeout=600)


async def game(cdp):
    return await cdp.js(f"""import('/tools/test/walls.js').then(async (m) => {{ const S = {S}; S.F.paused = true; const fs = m.faces(S, S.F.ac.x, {{ max: 2 }}), runs = [];
        for (const [k, f] of fs.entries()) for (const v of [10, 30]) for (const a of [0, 35]) runs.push({{ face: k, v, a, ...(await m.gameRun(S, f, v, a)) }});
        return JSON.stringify(runs); }})""", timeout=300)


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skywalls-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1000,700')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, report, t0 = [], {}, time.time()
    add = lambda name, ok, detail='': results.append((name, bool(ok), detail))
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            for loc in a.places.split(','):
                r = json.loads(await place(cdp, loc, a))
                report[loc] = r
                add(f'{loc}: clear building faces found', len(r['faces']) >= 1, f"{len(r['faces'])}: " + ', '.join(f"{f['size'][0]}x{f['size'][1]} m, {f['h']} m tall" for f in r['faces']))
                for name in ('Dune Buggy', 'Dirt Bike'):
                    runs = [x for x in r['runs'] if x['name'] == name]
                    worst = max(runs, key=lambda x: x['maxPen'], default=None)
                    add(f'{loc}: {name} stays out of the buildings ({len(runs)} runs)', runs and worst['maxPen'] <= a.tol,
                        f"deepest {worst['maxPen']} m (face {worst['face']}, {worst['v']} m/s, {worst['a']} deg)" if worst else 'no runs')
                    far = [x for x in runs if x['a'] == 0 and x['v'] >= 15 and x['closest'] > 4]
                    add(f'{loc}: {name} reaches the wall', runs and not far, f"{len(far)} straight-on runs stopped short" if far else 'every straight-on run hit it')
                if not a.no_game:
                    g = json.loads(await game(cdp))
                    report[loc + ':game'] = g
                    worst = max(g, key=lambda x: x['maxPen'], default=None)
                    add(f'{loc}: in the game loop the Dune Buggy stays out ({len(g)} runs)', g and worst['maxPen'] <= a.tol, f"deepest {worst['maxPen']} m ({worst['v']} m/s, {worst['a']} deg)" if worst else 'no runs')
                p = probs.take()
                add(f'{loc}: no page errors', not p, '; '.join(p[:5]))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<66} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--places', default='nyc,lauterbrunnen,alpine', help='locations (default: nyc,lauterbrunnen,alpine)')
    ap.add_argument('--tol', type=float, default=0.1, help='deepest allowed penetration, m (default 0.1)')
    ap.add_argument('--no-game', action='store_true', help='skip the runs through the game loop')
    ap.add_argument('--quality', default='low')
    ap.add_argument('--json', metavar='FILE', help='write the full report')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(asyncio.run(main(ap.parse_args())))
