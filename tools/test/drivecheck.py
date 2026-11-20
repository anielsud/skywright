#!/usr/bin/env python3
"""Skywright car handling test: boots the game in headless Chrome and runs tools/test/drivecheck.js.

Run from anywhere:  python3 tools/test/drivecheck.py [--json out.json] [--cars "Dune Buggy,Chomper"]
Every stock car (or the ones named), in each driving mode (Easy, Racer, Pro: the arcade / pilot / sim slots), on flat
ground through the game's own physics at 60 Hz:
  - turning circles at 5 to 30 m/s with the stick hard over: a tight circle at walking pace; at speed at least 0.95 g
    of cornering in Easy and Racer (0.6 g in Pro); the turn builds within 0.45 s (Pro 0.9 s); no tipping, and in Easy
    and Racer no wheel in the air;
  - a slalom at 15 m/s (lock to lock every 1.2 s): the heading swings at least 36 degrees (Pro 24), on its wheels;
  - a fishhook at 20 m/s (full lock one way, then the other): Easy and Racer stay on their wheels (Pro may roll);
  - a handbrake turn at 18 m/s: Racer drifts (the tail out past 15 degrees), Easy and Racer never spin (under 50) and
    straighten up once you let go;
  - braking and steering at once from 20 m/s: with ABS (Easy, Racer) it still turns.
Prints the turning-circle table. Exits non-zero on any failure. Same requirements as smoke.py. See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

NAMES = {'arcade': 'Easy', 'pilot': 'Racer', 'sim': 'Pro'}


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skydrive-')
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
            pick = json.dumps([c for c in a.cars.split(',') if c]) if a.cars else 'null'
            report = await cdp.js(f"""import('/tools/test/drivecheck.js').then((m) => {{ const pick = {pick};
                const car = (d) => {{ const s = __sky.analyze(d); return s.car && !s.bike && !s.heli && s.wingArea < 0.5; }};
                return JSON.stringify(m.plan(__sky.presets.filter((d) => car(d) && (!pick || pick.includes(d.name))))); }})""", timeout=600)
            report = json.loads(report)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    print(f"{'':18}" + ''.join(f"{v:>4} m/s: radius   g   {'':3}" for v in [5, 10, 15, 20, 25, 30]))
    for r in report['results']:
        print(f"{r['name']:<11} {NAMES[r['mode']]:<6}" + ''.join(f"{c['radius']:>14.1f} {c['latG']:4.2f}{'':4}" for c in r['circles']))
        s, f, d, b = r['slalom'], r['fishhook'], r['drift'], r['brakeTurn']
        print(f"{'':18}slalom {s['swing']:.0f} deg · fishhook up {f['minUp']:.2f} · handbrake slide {d['maxBeta']:.0f} deg · brake + steer turns {b['turned']} deg")
    bad = [c for c in report['checks'] if not c['ok']]
    for c in bad:
        print(f"FAIL  {c['name']}: {c['why']}")
    for p in probs.take()[:10]:
        print('      page:', p)
        bad.append(p)
    print(f"\n{len(report['checks'])} checks, {len(bad)} failed")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cars', help='comma-separated stock cars (default: every stock car)')
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--url', help='test an already running server instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
