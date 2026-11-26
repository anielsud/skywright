#!/usr/bin/env python3
"""Shader check (#273): boots Skywright in headless Chrome and, at each location in turn in ONE session, sweeps
everything a flight can show, on purpose rather than by luck (shadercheck.js sweep): every object in the scene drawn,
every event effect fired, the map's edges streamed in, and a real crash. It fails on any shader STALL (a program
compiled during a frame's draw: main.js's '[shaders] N compiled in flight' warning, window.__inflightCompiles), and
on any event that had to wait for its shader (window.__lateShows outside the streaming phase: crashes, explosions,
splashes and booms must show at once). Streamed content may compile new shaders: it waits hidden until they are ready.

Run from anywhere:  python3 tools/test/shadercheck.py [--plane Kestrel] [--loc islands --loc nyc ...] [--quality low]
  --fly: the older check instead, a few seconds of flight per place (a later place must not compile what an
         earlier one showed, #187).
Same requirements as smoke.py (Chrome + the websockets package). Exits non-zero on any failure.
"""
import argparse, asyncio, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server  # noqa: E402
from padcheck import session  # noqa: E402

LOCS = ['islands', 'canyon', 'nyc', 'islands']  # --fly (back to the first one at the end)
SWEEP_LOCS = ['islands', 'canyon', 'nyc', 'lauterbrunnen']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--plane', action='append', help='preset to fly (repeatable; default Kestrel and Dirt Bike)')
    ap.add_argument('--loc', action='append', help='location, in order (repeatable; default: %s)' % ' '.join(LOCS))
    ap.add_argument('--secs', type=float, default=4, help='flight seconds at each location (default 4)')
    ap.add_argument('--quality', default='medium', help='graphics setting (default medium)')
    ap.add_argument('--url', help='check an already running server instead of serving this checkout')
    ap.add_argument('--port', type=int)
    ap.add_argument('--fly', action='store_true', help='the older fly-around check instead of the sweep')
    a = ap.parse_args()
    port = a.port or free_port()
    if not a.url:
        start_server(port)
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')

    async def target(cdp, probs):
        warns = []

        def on(m, p):
            if m == 'Runtime.consoleAPICalled' and p.get('type') in ('warning', 'info') and '[shaders]' in str(p.get('args')):
                warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', [])))
        cdp.handlers.append(on)
        await cdp.js(f"window.__sky.settings.quality = {json.dumps(a.quality)}; window.__sky.applyQuality(); 1")
        out = []
        if not a.fly:
            for loc in a.loc or SWEEP_LOCS:
                for name in a.plane or ['Kestrel']:
                    n0 = len(warns)
                    r = await cdp.js(f"import('/tools/test/shadercheck.js').then((m) => m.sweep({json.dumps(name)}, {json.dumps(loc)}))", timeout=600)
                    r['warns'] = warns[n0:]
                    r['problems'] = probs.take()
                    out.append(r)
            return out
        for name in a.plane or ['Kestrel', 'Dirt Bike']:
            for loc in a.loc or LOCS:
                n0 = len(warns)
                r = await cdp.js(f"import('/tools/test/shadercheck.js').then((m) => m.fly({json.dumps(name)}, {json.dumps(loc)}, {a.secs}))", timeout=300)
                r['warns'] = warns[n0:]
                r['problems'] = probs.take()
                out.append(r)
        return out

    results = asyncio.run(session(origin, target))
    if not a.fly:
        bad = 0
        for r in results:
            ph = r['phases']
            fails = [f"{k}: {v['stall']} stalled a frame" for k, v in ph.items() if v['stall']]
            fails += [f"{k}: {v['late']} waited for their shader" for k, v in ph.items() if v['late'] and k != 'streaming']
            fails += [f'problem: {p}' for p in r['problems']]
            bad += bool(fails)
            print(f"{'FAIL' if fails else 'PASS'}  {r['name']} at {r['location']}: {r['warmed']} programs behind the loading screen; "
                  f"scene drawn ({ph['scene']['objects']} hidden/culled shown), events, streaming ({ph['streaming']['late']} new shown when ready), "
                  f"crash into {ph['crash']['target']} ({ph['crash']['partsLost']} parts lost); {r['programs']} programs in all")
            for f in fails:
                print(f'      {f}')
            for w in r['warns'] if fails else []:
                print(f'      {w}')
        print(f'FAIL ({bad} places)' if bad else 'PASS')
        sys.exit(1 if bad else 0)
    bad = 0
    for r in results:
        r['warns'] = [w for w in r['warns'] if 'shown when compiled' not in w]
        ok = r['inflight'] == 0 and not r['warns'] and not r['problems']
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {r['name']} at {r['location']}: {r['warmed']} programs compiled behind the loading screen, "
              f"{r['inflight']} in flight ({r['programs']} in all)")
        for w in r['warns']:
            print(f'      {w}')
        for p in r['problems']:
            print(f'      problem: {p}')
    print(f'FAIL ({bad} flights compiled shaders in flight or had problems)' if bad else 'PASS')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
