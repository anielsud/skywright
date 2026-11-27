#!/usr/bin/env python3
"""Look again at a 🐞 report: starts the game headless at the report's place, time, weather and quality with the same
vehicle where it was (pos/quat), pauses, puts the camera exactly where the player's was (cam/look/fov), lets the
world stream in around it and takes a picture. Or many pictures in one launch: give several reports, or a JSON list of
poses. A pose is a report, or just {location, at: [x, z], dist?, elev?, heading?, name?} (looks at that ground spot).
Chrome starts once; the game starts once per place (and quality, time, weather, vehicle), however many poses it has.

  python3 tools/test/goto.py reports/<report>.json [--out shot.png] [--size 1280x720] [--wait 8]
  python3 tools/test/goto.py poses.json other.json --out shots/      (one PNG per pose, named by its 'name')
  python3 tools/test/goto.py poses.json --out after/ --query layout=1 (the page's query string: a flag to try)

(The report JSON is what tools/analytics/reports.py saves.) Same requirements as smoke.py.
"""
import argparse, asyncio, base64, json, os, sys, tempfile, shutil
import websockets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402

S = 'window.__sky'


def poses_of(paths):
    out = []
    for path in paths:
        r = json.load(open(path))
        for i, x in enumerate(r if isinstance(r, list) else [r]):
            x.setdefault('name', os.path.splitext(os.path.basename(path))[0] + (f'_{i}' if isinstance(r, list) else ''))
            out.append(x)
    return out


async def main(a):
    poses = poses_of(a.poses)
    # one Chrome for everything; one game start per (place, quality, time, weather, vehicle), however many poses share it
    groups = {}
    for r in poses:
        groups.setdefault((r['location'], r.get('tier') or 'medium', r.get('time_of_day'), r.get('weather'), r.get('vehicle')), []).append(r)
    port = free_port(); srv = start_server(port); origin = f'http://127.0.0.1:{port}'
    profile = tempfile.mkdtemp(prefix='skygoto-'); proc, ws_url = launch_chrome(free_port(), profile, a.size.replace('x', ','))
    os.makedirs(a.out, exist_ok=True) if len(poses) > 1 else None
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); await cdp.send('Runtime.enable')
            for (loc, tier, tod, weather, vehicle), rs in groups.items():
                await cdp.send('Page.navigate', url=origin + '/' + ('?' + a.query if a.query else ''))
                await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 60, 'boot')
                await cdp.wait_for("!document.getElementById('splash')", 30, 'splash')
                cfg = {'location': loc, 'online': False, 'mode': 'free', 'start': rs[0].get('start') or 'runway'}
                if tod is not None: cfg['time'] = tod
                if weather: cfg['weather'] = weather
                await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {json.dumps(cfg)}); {S}.settings.quality = {json.dumps(tier)};
                    const d = {S}.presets.find((p) => p.name === {json.dumps(vehicle)}) || {S}.presets[0]; {S}.hangar.load(d); {S}.startFlight(); return d.name; }})()""")
                await cdp.wait_for(f'{S}.F && {S}.F.t > 0.5 && !{S}.F.warm', 240, 'flight')
                for r in rs:
                    await cdp.js(f"""(() => {{ const F = {S}.F, ac = F.ac, cam = {S}.rig.cam, r = {json.dumps(r)}; F.paused = true;
                        let p = r.pos, q = r.quat || [0, 0, 0, 1], c = r.cam, l = r.look;
                        if (!c) {{ // a simple pose: {{at: [x, z], dist, elev (deg), heading (deg)}} looks at that spot on the ground
                          const [x, z] = r.at, y = F.world.groundAt(x, z, 1e4)?.h ?? F.world.heightAt(x, z);
                          const d = r.dist ?? 60, e = (r.elev ?? 35) * Math.PI / 180, h = (r.heading ?? 0) * Math.PI / 180;
                          l = [Math.sin(h) * Math.cos(e), -Math.sin(e), -Math.cos(h) * Math.cos(e)];
                          c = [x - l[0] * d, y - l[1] * d, z - l[2] * d]; p = p || [x, y + 1, z];
                        }}
                        ac.x.set(p[0], p[1], p[2]); ac.q.set(q[0], q[1], q[2], q[3]); ac.v?.set(0, 0, 0); ac.w?.set?.(0, 0, 0); ac.syncVisual?.();
                        cam.position.set(c[0], c[1], c[2]); if (r.fov) cam.fov = r.fov; cam.updateProjectionMatrix();
                        cam.lookAt(c[0] + l[0], c[1] + l[1], c[2] + l[2]); document.querySelectorAll('#modal-root').forEach((e) => (e.style.display = 'none')); return 1; }})()""")
                    # (terrain, roads and buildings stream in around the camera: paused, the flight loop doesn't update the world,
                    # so step it here, from the camera, until the wait is over)
                    for _ in range(max(1, int(a.wait))):
                        await cdp.js(f"""(() => {{ const F = {S}.F, cam = {S}.rig.cam; for (let i = 0; i < 20; i++) F.world.update(1 / 60, cam, cam.position.clone().set(0, 0, 0), []);
                            F.world.roadGroup?.userData.update?.(cam.position, 1e5, 3000); return 1; }})()""", timeout=300)
                        await asyncio.sleep(1)
                    shot = await cdp.send('Page.captureScreenshot', format='png')
                    out = a.out if len(poses) == 1 else os.path.join(a.out, r['name'] + '.png')
                    open(out, 'wb').write(base64.b64decode(shot['data'])); print(out, flush=True)
    finally:
        proc.kill(); srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('poses', nargs='+'); ap.add_argument('--out', default='goto.png', help='a file for one pose, a directory for several'); ap.add_argument('--size', default='1280x720'); ap.add_argument('--wait', type=float, default=8); ap.add_argument('--query', default='', help="the page's query string, e.g. layout=1")
    asyncio.run(main(ap.parse_args()))
