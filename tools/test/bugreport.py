#!/usr/bin/env python3
"""🐞 report test: in a flight, F8 pauses, takes a picture of the frame and opens the report form; Send queues one
'bug_report' event with the place, the pose, a JPEG that isn't blank and the flight recorder (blackbox.js: path samples
and events, including a forced hit) and posts it. The post is caught in the page (window.fetch), nothing leaves.

Run:  python3 tools/test/bugreport.py      (same requirements as smoke.py)
"""
import asyncio, base64, json, os, sys, tempfile, shutil
import websockets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'

async def main():
    port = free_port(); srv = start_server(port); origin = f'http://127.0.0.1:{port}'
    profile = tempfile.mkdtemp(prefix='skybug-'); proc, ws_url = launch_chrome(free_port(), profile, '1280,800')
    ok = True
    def check(name, cond, detail=''):
        nonlocal ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + name + (f'  ({detail})' if detail else ''))
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); probs = Problems(origin); cdp.handlers.append(probs.on)
            await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/?analytics=1')
            await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 60, 'boot')
            await cdp.wait_for("!document.getElementById('splash')", 30, 'splash')
            await cdp.js("""(() => { window.__posts = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/batch/')) { window.__posts.push(o.body); return Promise.resolve(new Response('{}')); } return f(u, o); }; return 1; })()""")
            await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {{ location: 'islands', online: false, mode: 'free', start: 'runway', time: 11, weather: 'clear' }});
                {S}.hangar.load({S}.presets.find((d) => d.name === 'Kestrel')); {S}.startFlight(); return 1; }})()""")
            await cdp.wait_for(f'{S}.F && {S}.F.t > 2 && !{S}.F.warm', 180, 'flight running')
            await cdp.js("console.warn('test warning'); 1")
            await asyncio.sleep(1.5)
            await cdp.send('Input.dispatchKeyEvent', type='keyDown', key='F8', code='F8', windowsVirtualKeyCode=119)
            await cdp.wait_for("document.getElementById('bug-send')", 20, 'report form')
            check('F8 pauses', await cdp.js(f'{S}.F.paused'))
            await cdp.js("document.getElementById('bug-note').value = 'test note'; document.getElementById('bug-send').click(); 1")
            await cdp.wait_for("window.__posts.some((b) => b.includes('bug_report'))", 20, 'the post')
            ev = json.loads(await cdp.js("window.__posts.find((b) => b.includes('bug_report'))"))
            ev = next(e for e in ev['batch'] if e['event'] == 'bug_report'); p = ev['properties']
            check('unpaused after send', not await cdp.js(f'{S}.F.paused'))
            check('form closed', not await cdp.js("document.getElementById('bug-send')"))
            check('place + pose', p.get('location') == 'islands' and len(p.get('pos', [])) == 3 and len(p.get('quat', [])) == 4 and len(p.get('cam', [])) == 3, str({k: p.get(k) for k in ('location', 'pos', 'cam', 'vehicle')}))
            check('note', p.get('note') == 'test note')
            path, events = p.get('path', []), p.get('events', [])
            check('path recorded', len(path) >= 8 and all(len(r) == 9 for r in path), f'{len(path)} samples, last {path[-1] if path else None}')
            kinds = {e[1] for e in events}
            check('events recorded', {'start', 'action', 'console_warn'} <= kinds, str(sorted(kinds)))
            shot = p.get('screenshot', '')
            jpg = base64.b64decode(shot.split(',', 1)[1]) if shot.startswith('data:image/jpeg') else b''
            out = os.path.join(tempfile.gettempdir(), 'skybug.jpg'); open(out, 'wb').write(jpg)
            # a blank (black/white) 960px JPEG is ~5-10 KB; the islands scene is far more
            check('screenshot not blank', len(jpg) > 25000, f'{len(jpg) // 1024} KB -> {out}')
            check('event size sane', len(json.dumps(ev)) < 400000, f'{len(json.dumps(ev)) // 1024} KB')
            pr = probs.take(); check('no page errors', not pr, '; '.join(pr[:3]))
    finally:
        proc.kill(); srv.shutdown() if hasattr(srv, 'shutdown') else srv.kill(); shutil.rmtree(profile, ignore_errors=True)
    sys.exit(0 if ok else 1)

asyncio.run(main())
