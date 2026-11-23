#!/usr/bin/env python3
"""Shader check: boots Skywright in headless Chrome and flies one vehicle at several locations in turn, in ONE session,
and fails if any shader program compiles mid-flight (after the loading screen's warm-up): main.js logs those as
'[shaders] N compiled in flight' and counts them in window.__inflightCompiles. A later location must not compile
programs mid-flight for things an earlier one already showed (the crew, issue #187); whatever it does need new must
compile behind its loading screen.

Run from anywhere:  python3 tools/test/shadercheck.py [--plane Kestrel --plane 'Dirt Bike'] [--loc islands --loc canyon ...] [--port N]
Same requirements as smoke.py (Chrome + the websockets package). Exits non-zero on any failure.
"""
import argparse, asyncio, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server  # noqa: E402
from padcheck import session  # noqa: E402

LOCS = ['islands', 'canyon', 'nyc', 'islands']  # (back to the first one at the end)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--plane', action='append', help='preset to fly (repeatable; default Kestrel and Dirt Bike)')
    ap.add_argument('--loc', action='append', help='location, in order (repeatable; default: %s)' % ' '.join(LOCS))
    ap.add_argument('--secs', type=float, default=4, help='flight seconds at each location (default 4)')
    ap.add_argument('--quality', default='medium', help='graphics setting (default medium)')
    ap.add_argument('--url', help='check an already running server instead of serving this checkout')
    ap.add_argument('--port', type=int)
    a = ap.parse_args()
    port = a.port or free_port()
    if not a.url:
        start_server(port)
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')

    async def target(cdp, probs):
        warns = []

        def on(m, p):
            if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and '[shaders]' in str(p.get('args')):
                warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', [])))
        cdp.handlers.append(on)
        await cdp.js(f"window.__sky.settings.quality = {json.dumps(a.quality)}; window.__sky.applyQuality(); 1")
        out = []
        for name in a.plane or ['Kestrel', 'Dirt Bike']:
            for loc in a.loc or LOCS:
                n0 = len(warns)
                r = await cdp.js(f"import('/tools/test/shadercheck.js').then((m) => m.fly({json.dumps(name)}, {json.dumps(loc)}, {a.secs}))", timeout=300)
                r['warns'] = warns[n0:]
                r['problems'] = probs.take()
                out.append(r)
        return out

    bad = 0
    for r in asyncio.run(session(origin, target)):
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
