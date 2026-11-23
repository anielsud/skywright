#!/usr/bin/env python3
"""Skywright crew rig test: boots the game in headless Chrome and runs tools/test/riders.js.

Run from anywhere:  python3 tools/test/riders.py [--json out.json] [--only NAME]
Every stock vehicle with people in it is flown/driven at 60 Hz with its controls sweeping; each person's skeleton must
hold together every frame (hands at the ends of their forearms, no bone more than 1.5 m from the hips, no NaN). Then
every bike loses its fork mid-ride: the riders must let go of the flying handlebars and stay in one piece, and posing
must not get more expensive. Prints the crew posing cost (ms per frame) per vehicle. Exits non-zero on any failure.
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skyriders-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1000,700')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    only = json.dumps(a.only or '')
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            report = await cdp.js(f"import('/tools/test/riders.js').then((m) => m.plan(__sky.presets.filter((d) => !{only} || d.name.toLowerCase().includes({only}.toLowerCase()))))", timeout=900)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in report if not r['ok']]
    for r in report:
        ms = r['msBefore'] or {}
        after = f"  after {r['msAfter']['mean']:.2f}" if r.get('msAfter') else ''
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['check']:<10} {r['name']:<34} x{r['people']}  hand gap {r['gap'] * 100:5.2f} cm  far {r['far']:.2f} m  pose {ms.get('mean', 0):.2f} ms (p95 {ms.get('p95', 0):.2f}){after}" + (f"  knees {r['knee']['rest']}->{r['knee']['min']}->{r['knee']['end']} deg, into bike {r.get('hitsRest', 0) * 100:.1f}->{r['hits'] * 100:.1f} cm" if r['check'] == 'landing' else '') + (f"  hips back {r['back'] * 100:.1f} cm, into bike {r.get('hitsRest', 0) * 100:.1f}->{r['hits'] * 100:.1f} cm" if r['check'] in ('hard stop', 'full gas', 'wheelie') else '') + ('' if r['ok'] else f"\n      {r['why']}"))
    for p in probs.take()[:10]:
        print('      page:', p)
        bad.append(p)
    print(f'\n{len(report)} checks, {len(bad)} failed')
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--only', help='only presets whose name contains this')
    ap.add_argument('--url', help='test an already running server instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
