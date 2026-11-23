#!/usr/bin/env python3
"""Skywright g-vision test: boots the game in headless Chrome and runs tools/test/gvision.js.

Run from anywhere:  python3 tools/test/gvision.py [--json out.json] [--only NAME]
The heavy-g haze (src/gvision.js): spikes never show, sustained g greys the view over seconds (later with a g-suit),
negative g reds it, it clears when the g comes off and is never opaque. Then every stock plane with a seated crew
pulls hard: the cockpit eye follows the pilot's head by no more than its seat's clamp and comes back. Exits non-zero
on any failure.
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skygvision-')
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
            report = await cdp.js(f"import('/tools/test/gvision.js').then((m) => m.plan(__sky.presets.filter((d) => !{only} || d.name.toLowerCase().includes({only}.toLowerCase()))))", timeout=900)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    bad = [r for r in report if not r['ok']]
    for r in report:
        info = {k: v for k, v in r.items() if k not in ('check', 'ok', 'name', 'why')}
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['check']:<16} {r.get('name', ''):<30} {json.dumps(info)}" + (f"\n      {r['why']}" if r.get('why') else ''))
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
