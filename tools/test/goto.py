#!/usr/bin/env python3
"""Look again at a 🐞 report: starts the game headless at the report's place, time, weather and quality with the same
vehicle where it was (pos/quat), pauses, puts the camera exactly where the player's was (cam/look/fov), lets the
world stream in around it and takes a picture.

  python3 tools/test/goto.py reports/<report>.json [--out shot.png] [--size 1280x720] [--wait 8]

(The report JSON is what tools/analytics/reports.py saves.) Same requirements as smoke.py.
"""
import argparse, asyncio, base64, json, os, sys, tempfile, shutil
import websockets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402

S = 'window.__sky'


async def main(a):
    r = json.load(open(a.report))
    port = free_port(); srv = start_server(port); origin = f'http://127.0.0.1:{port}'
    profile = tempfile.mkdtemp(prefix='skygoto-'); proc, ws_url = launch_chrome(free_port(), profile, a.size.replace('x', ','))
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); await cdp.send('Runtime.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 60, 'boot')
            await cdp.wait_for("!document.getElementById('splash')", 30, 'splash')
            cfg = {'location': r['location'], 'online': False, 'mode': 'free', 'start': r.get('start') or 'runway'}
            if r.get('time_of_day') is not None: cfg['time'] = r['time_of_day']
            if r.get('weather'): cfg['weather'] = r['weather']
            await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {json.dumps(cfg)}); {S}.settings.quality = {json.dumps(r.get('tier') or 'medium')};
                const d = {S}.presets.find((p) => p.name === {json.dumps(r.get('vehicle'))}) || {S}.presets[0]; {S}.hangar.load(d); {S}.startFlight(); return d.name; }})()""")
            await cdp.wait_for(f'{S}.F && {S}.F.t > 0.5 && !{S}.F.warm', 240, 'flight')
            p, q, c, l = r['pos'], r['quat'], r['cam'], r['look']
            await cdp.js(f"""(() => {{ const F = {S}.F, ac = F.ac, cam = {S}.rig.cam; F.paused = true;
                ac.x.set({p[0]}, {p[1]}, {p[2]}); ac.q.set({q[0]}, {q[1]}, {q[2]}, {q[3]}); ac.v?.set(0, 0, 0); ac.w?.set?.(0, 0, 0); ac.syncVisual?.();
                cam.position.set({c[0]}, {c[1]}, {c[2]}); cam.fov = {r.get('fov') or 'cam.fov'}; cam.updateProjectionMatrix();
                cam.lookAt({c[0]} + {l[0]}, {c[1]} + {l[1]}, {c[2]} + {l[2]}); document.querySelectorAll('#modal-root').forEach((e) => (e.style.display = 'none')); return 1; }})()""")
            # (terrain, roads and buildings stream in around the camera: paused, the flight loop doesn't update the world,
            # so step it here, from the camera, until the wait is over)
            for _ in range(max(1, int(a.wait))):
                await cdp.js(f"""(() => {{ const F = {S}.F, cam = {S}.rig.cam; for (let i = 0; i < 20; i++) F.world.update(1 / 60, cam, cam.position.clone().set(0, 0, 0), []);
                    F.world.roadGroup?.userData.update?.(cam.position, 1e5, 3000); return 1; }})()""", timeout=300)
                await asyncio.sleep(1)
            shot = await cdp.send('Page.captureScreenshot', format='png')
            open(a.out, 'wb').write(base64.b64decode(shot['data'])); print(a.out)
    finally:
        proc.kill(); srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('report'); ap.add_argument('--out', default='goto.png'); ap.add_argument('--size', default='1280x720'); ap.add_argument('--wait', type=float, default=8)
    asyncio.run(main(ap.parse_args()))
