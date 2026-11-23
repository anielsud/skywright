#!/usr/bin/env python3
"""Skywright boat ride test (tools/test/boatride.js). It runs in the Node tier: this is a wrapper.

Run from anywhere:  python3 tools/test/boatride.py [--json out.json] [--only nyc] [--visuals] [--browser]
1. On open water with a swell (the game's own physics at 60 Hz): every stock boat in Arcade, Pilot and Sim floats level,
   gets up on the plane (the bow rises, then levels out; a displacement hull reaches hull speed instead), turns left and
   right, stops and stays upright. A capsized boat rights itself (Arcade, Pilot), a boat on land at full gas just sits
   (nothing moves, breaks or explodes), ten random kid's boat builds float (and go, with the motor in the water), and
   no other stock vehicle is taken for a boat; amphibians float, paddle and turn, and drive on land.
2. At every location with a marina (Bora Bora, New York, Jungfrau, Grand Canyon at Low, the Grand Canyon at High too):
   its World is built (in Node: tools/test/node/world.mjs) and every stock boat, in Arcade and Sim, starts afloat and
   level at the marina facing open water and does the same ride in the real world (shore, docks); an amphibious bike
   paddles off; a car drives out along the pier.
By default both parts run in Node (node tools/test/node/run.mjs boatride), the vehicles headless (--visuals: whole).
--browser runs part 2 in headless Chrome instead, in real flights (one World per location, shared over --jobs
browsers, the rides stepped on each flight's own env): to check the Node World against the page. --only LOC: part 2,
just that location. Exits non-zero on any failure. --browser needs what smoke.py needs. See tools/test/README.md.
"""
import argparse, asyncio, json, os, subprocess, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LOCS = ['islands', 'nyc', 'lauterbrunnen', 'canyon']
BOATS = "__sky.presets.filter((d) => __sky.analyze(d).boat)"
# seconds per World on this Mac (build + rides), to share them out over the browsers
COST = {('canyon', 'high'): 9.5, ('nyc', 'low'): 8.5, ('islands', 'low'): 7.5, ('canyon', 'low'): 6.5, ('lauterbrunnen', 'low'): 6.5}


async def session(a, origin, worlds):
    """One Chrome, one page: a World per (location, quality) in turn, the marina rides in each. Returns (rows, problems)."""
    rows_all = []
    profile = tempfile.mkdtemp(prefix='skyboat-')
    proc, ws_url = launch_chrome(free_port(), profile, '1000,700')
    probs = Problems(origin)
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            t0 = time.time()
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            boot = time.time() - t0
            headless = 'false' if a.visuals else 'true'
            for loc, q in worlds:
                t0 = time.time()  # (the flight's own vehicle only has to exist: the smallest boat is the quickest to build)
                await cdp.js(f"(() => {{ const S = __sky; if (S.F) S.endFlight(); S.settings.quality = '{q}'; S.applyQuality(); S.flightCfg.location = '{loc}'; S.flightCfg.mode = 'free'; S.hangar.load({BOATS}.reduce((a, b) => (b.parts.length < a.parts.length ? b : a))); S.startFlight(); return 1; }})()")
                await cdp.wait_for('__sky.F && __sky.F.ac && __sky.F.t > 0.5', 180, f'a flight at {loc}')
                t1 = time.time()
                # the terrain tiles around the start stream in over the first seconds: test on the ground the player gets
                await cdp.wait_for('(() => { const t = __sky.F.world.tiles; return !t || (!t.queue.length && !t.job); })()', 120, f'the terrain tiles at {loc}')
                t2 = time.time()
                # the rides are stepped here, synchronously, on the flight's own env (the game loop paused meanwhile), the
                # test vehicles headless: physics only, as the Node tier proves identical (--visuals builds them whole)
                rows = await cdp.js(f"""Promise.all([import('/tools/test/boatride.js'), import('/src/aircraft.js')]).then(([m, A]) => {{
                    const F = __sky.F, was = A.HEADLESS.on; F.paused = true; A.HEADLESS.on = {headless};
                    try {{ return m.marina(F, {BOATS}, __sky.presets).map(({{ ac, ...x }}) => x); }} finally {{ A.HEADLESS.on = was; F.paused = false; }} }})""", timeout=900)
                print(f'  {loc} [{q}]: boot {boot:.1f} s, flight started in {t1 - t0:.1f} s, tiles {t2 - t1:.1f} s, {len(rows)} checks in {time.time() - t2:.1f} s', flush=True)
                boot = 0
                for r in rows:
                    r['name'] = f"[{q}] {r['name']}"
                rows_all += rows
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
    return rows_all, probs.take()


async def marinas(a, origin):
    # every marina at Low (the tablet's setting: the coarsest terrain tiles), the river landing at High too; the Worlds
    # (3-6 s each to build) are shared out over --jobs browsers, the slowest first
    worlds = [(loc, q) for loc in ([a.only] if a.only else LOCS) for q in (['low', 'high'] if loc == 'canyon' else ['low'])]
    order = sorted(worlds, key=lambda w: -COST.get(w, 5))
    jobs = max(1, min(a.jobs, len(worlds)))
    shares, load = [[] for _ in range(jobs)], [0] * jobs
    for w in order:
        k = load.index(min(load)); shares[k].append(w); load[k] += COST.get(w, 5)
    res = await asyncio.gather(*(session(a, origin, s) for s in shares if s))
    report = [r for rs, _ in res for r in rs]
    # (back in location order)
    pos = {f'[{q}] {loc}': i for i, (loc, q) in enumerate(worlds)}
    report.sort(key=lambda r: next((i for k, i in pos.items() if r['name'].startswith(k)), 99))
    return report, [p for _, ps in res for p in ps]


async def main(a):
    report, probs, failed = [], [], False
    if not a.browser:
        out = os.path.join(tempfile.mkdtemp(prefix='skyboat-'), 'node.json')
        cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'boatride', '--json', out] + (['--only', f'marina {a.only}'] if a.only else [])
        failed = subprocess.run(cmd, cwd=ROOT, env={**os.environ, **({'SKY_VISUALS': '1'} if a.visuals else {})}).returncode != 0
        try:
            report += json.load(open(out))['checks']
        except (OSError, ValueError):
            failed = True
    else:
        port = a.port or free_port()
        srv = None if a.url else start_server(port)
        origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
        t0 = time.time()
        try:
            report, probs = await marinas(a, origin)
        finally:
            if srv:
                srv.shutdown()
        print(f'marinas: {len(report)} checks in {time.time() - t0:.1f} s')
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in report if not r['ok']]
    for r in report:
        nums = f"  top {r['top']:4.1f} m/s  Fn {r['fn']:.2f}  bow up {r['bowUp']:4.1f}°  on the plane {r['cruise']:4.1f}°  turns {r['left']:+.0f}° {r['right']:+.0f}°  bank {r['bank']:.0f}°" if 'left' in r else ''
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['name']:<58}{nums}" + ('' if r['ok'] else f"\n      {r['why']}"))
    for p in probs[:10]:
        print('      page:', p)
        bad.append(p)
    print(f'\n{len(report)} checks, {len(bad)} failed')
    return 1 if bad or failed else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--browser', action='store_true', help='part 2 (the marinas) in headless Chrome, in real flights')
    ap.add_argument('--only', choices=LOCS, help='part 2 only, at this location')
    ap.add_argument('--visuals', action='store_true', help='build the test vehicles whole (not headless), to compare')
    ap.add_argument('--url', help='test an already running server instead of serving the repo')
    ap.add_argument('--jobs', type=int, default=3, help='browsers at once for the marinas (default 3)')
    ap.add_argument('--port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
