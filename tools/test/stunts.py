#!/usr/bin/env python3
"""Skywright stunt park test: drives stock cars through the Grand Canyon stunt park in headless Chrome, on the real
flight model with scripted inputs (gas, a lane-keeping steer), and checks that

  - a car starts at the start arch, facing the first kicker, and nothing compiles a shader mid-flight;
  - the loop run (start arch -> kickers -> tabletop -> boost -> loop): it gets air off the tabletop and lands upright,
    goes over the top of the loop upside down with its wheels on the deck, and comes out upright in the exit lane;
  - coasting into the loop at the boost pad's speed still makes it round; far too slow, it rolls back down;
  - the canyon jump (boost -> mesa -> boost -> lip -> gap -> landing ramp): it clears the gap and lands upright;
  - the bowl (wall ride) at several speeds: round it on the wall, back out upright;
  - planes: one set down on a mesa stands on it, one flown into a cliff hits it.

Run from anywhere:  python3 tools/test/stunts.py [--cars "Dune Buggy,Chomper"] [--realism pilot,arcade] [--shots DIR]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'


def checks(r):
    """(name, ok, detail) for every assertion on the in-page report."""
    out = []
    add = lambda name, ok, detail='': out.append((name, bool(ok), detail))
    for l in r['loop']:
        n = f"{l['name']} ({l['realism']})"
        tt, lp, ex = l['tabletop'], l['loop'], l['exit']
        add(f'{n}: tabletop jump, lands upright', tt['air'] > 0.4 and tt['landUp'] > 0.8, f"air {tt['air']} s, lowest up {tt['landUp']}")
        add(f'{n}: loop entry speed', l['entrySpeed'] > 21, f"{l['entrySpeed']} m/s")
        add(f'{n}: over the top of the loop', lp['topY'] > 17 and lp['upAtTop'] < -0.9, f"top {lp['topY']} m, up {lp['upAtTop']}")
        add(f'{n}: upside down on its wheels', lp['invertedOnWheels'] >= 8 and lp['invertedOnWheels'] >= lp['invertedFrames'] - 2, f"{lp['invertedOnWheels']}/{lp['invertedFrames']} frames")
        add(f'{n}: out of the loop upright, exit lane', ex['reached'] and ex['up'] > 0.9 and ex['y'] < 2.5 and abs(ex['z'] - 26.5) < 2.5 and ex['minUpAfter'] > 0.8, f"up {ex['up']}, y {ex['y']}, z {ex['z']}, {ex['v']} m/s")
        add(f'{n}: nothing broke on the loop run', l['alive'] == l['parts'] and not l['dead'], f"{l['alive']}/{l['parts']} parts")
    for s in r['speeds']:
        n = f"{s['name']} ({s['realism']})"
        c, t = s['coast'], s['tooSlow']
        add(f'{n}: coasting from the boost loops', c['inverted'] >= 8 and c['exitUp'] > 0.9 and c['exitX'] > 90 and c['alive'] == c['parts'], f"{c['inverted']} frames inverted, out at x {c['exitX']}")
        add(f'{n}: too slow rolls back, stays out of the ground', t['topY'] < 12 and t['inverted'] == 0 and t['finite'] and t['minY'] > 0.3, f"top {t['topY']} m, lowest {t['minY']} m")
    for j in r['jump']:
        n = f"{j['name']} ({j['realism']})"
        add(f'{n}: canyon jump clears the gap', j['gapMinY'] > 5 and j['air'] > 1.0, f"lip {j['lipSpeed']} m/s, {j['air']} s air, lowest over the gap {j['gapMinY']} m")
        add(f'{n}: canyon jump lands upright', j['landUp'] > 0.8 and j['landed'] and j['after']['up'] > 0.8 and j['alive'] == j['parts'], f"lowest up after landing {j['landUp']}, {j['alive']}/{j['parts']} parts")
    for b in r['bowl']:
        n = f"{b['name']} ({b['realism']}) bowl at {b['speed']} m/s"
        a = b['after']
        add(f'{n}', b['onWall'] > 60 and b['maxBank'] > 25 and b['maxY'] < 8 and a['up'] > 0.9 and a['wheels'] >= 3 and b['alive'] == b['parts'],
            f"bank up to {b['maxBank']} deg, {b['maxY']} m up the wall, out: up {a['up']}, {a['wheels']} wheels down")
    p = r['planes']
    if p:
        la, cr = p['land'], p['crash']
        add(f"{p['name']} set down on the mesa stands on it", la['onGround'] and la['y'] > la['topY'] + 0.3 and la['y'] < la['topY'] + 4 and not la['dead'], f"y {la['y']} m (deck {la['topY']} m)")
        add(f"{p['name']} flown into the cliff hits it", cr['impacts'] > 0 and cr['speedPast'] < 20, f"{cr['impacts']} impacts, {cr['speedPast']} m/s past the face (from {cr['speed0']}), {cr['alive']}/{cr['of']} parts")
    return out


async def shots(cdp, d):
    """Park overview, the loop, the jump, the bowl, a car mid-loop and mid-jump (paused flight, camera set by hand)."""
    os.makedirs(d, exist_ok=True)
    await cdp.js("import('/tools/test/stunts.js').then((m) => { window.__stunts = m; return 1; })")
    await cdp.js(f"""(() => {{ const F = {S}.F; F.paused = true;
      window.__cam = (p, t) => {{ const c = {S}.rig.cam, O = F.world.stunts.O; c.position.set(O.x + p[0], O.y + p[1], O.z + p[2]); c.lookAt(O.x + t[0], O.y + t[1], O.z + t[2]); c.userData.focus = c.position.clone(); F.world.update(0.016, c, new {S}.THREE.Vector3(), []); F.world.flora?.update?.(c.position); }};
      window.__put = (x, z, dir, v, cond, T, speed) => window.__stunts.stage('Dune Buggy', x, z, dir, v, cond, T, speed);
      document.getElementById('flight-ui').style.display = 'none'; return 1; }})()""")
    async def shot(name, js, settle=2.5):
        v = await cdp.js(js)
        if v not in (None, 1): print(f'  {name}: {v}')
        await asyncio.sleep(settle)
        await cdp.screenshot(os.path.join(d, name))
    await shot('overview.png', '__cam([-60, 190, 250], [10, 0, -10])', 4)
    await shot('loop.png', '__cam([20, 6, 62], [62, 9, 30])')
    await shot('jump.png', '__cam([86, 9, -66], [76, 4, -30])')
    await shot('bowl.png', '__cam([-130, 16, -58], [-190, 2, 0])')
    await shot('start.png', '__cam([-150, 4.5, 36], [-90, 2, 32])')
    # a car mid-loop, upside down at the top, and one in the air over the canyon gap
    await shot('car-mid-loop.png', "(() => { const p = __put(0, 33.5, 1, 20, (a) => a.up.y < -0.95); __cam([p[0] - 14, p[1] - 4, p[2] + 22], p); return p; })()")
    await shot('car-loop-side.png', "(() => { const p = __put(0, 33.5, 1, 20, (a) => a.up.y < 0.1 && a.v.y > 0); __cam([p[0] - 6, p[1] + 1, p[2] + 16], p); return p; })()")
    await shot('car-tabletop.png', "(() => { const p = __put(-62, 30, 1, 17, (a, x) => !a.onGround && x > -28); __cam([p[0] - 3, p[1] + 0.5, p[2] + 15], p); return p; })()")
    await shot('car-canyon-jump.png', "(() => { const G = __sky.F.world.stunts.gapAt; const p = __put(150, -30, -1, 14, (a, x) => x < 170 - G.s0 - 5); __cam([p[0] + 2, p[1] + 3, p[2] + 24], [p[0], p[1] - 1, p[2]]); return p; })()")
    await shot('car-wall-ride.png', "(() => { const p = __put(-140, -30, -1, 24, (a, x) => x < -197, 12, 24); __cam([-168, 3, -8], p); return p; })()")


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skystunt-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, t0 = [], time.time()
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            warns = []
            cdp.handlers.append(lambda m, p: warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', []))) if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and '[shaders]' in str(p.get('args')) else None)
            await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            car = a.cars.split(',')[0]
            await cdp.js(f"""Object.assign({S}.flightCfg, {{ location: 'canyon', online: false, mode: 'free', start: 'runway', time: 11 }}); {S}.settings.quality = {json.dumps(a.quality)};
                {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(car)})); {S}.startFlight(); 1""")
            await cdp.wait_for(f'{S}.F && {S}.F.t > 1 && {S}.F.world.stunts', 120, 'the canyon flight to start')
            await asyncio.sleep(2)
            st = await cdp.js(f"""(() => {{ const F = {S}.F, P = F.world.stunts, ac = F.ac, f = new {S}.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q);
                return {{ d: Math.hypot(ac.x.x - P.start.pos.x, ac.x.z - P.start.pos.z), fx: f.x, car: ac.isCar, start: F.cfgStart, compiles: window.__inflightCompiles || 0, stats: P.stats }}; }})()""")
            results.append(('car starts at the start arch, facing the first kicker', st['car'] and st['d'] < 3 and st['fx'] > 0.95, f"{st['d']:.1f} m from the arch, heading x {st['fx']:.2f}"))
            results.append(('no shaders compiled mid-flight', st['compiles'] == 0, f"{st['compiles']} compiled {' '.join(warns)[:300]}"))
            print(f"park: {st['stats']['tris']} triangles drawn, {st['stats']['collTris']} collision triangles, {st['stats']['draws']} draw calls")
            report = await cdp.js(f"import('/tools/test/stunts.js').then((m) => m.run({{ cars: {json.dumps(a.cars.split(','))}, realism: {json.dumps(a.realism.split(','))} }}))", timeout=900)
            results += checks(report)
            if a.json:
                json.dump(report, open(a.json, 'w'), indent=1)
            if a.shots:
                await shots(cdp, os.path.abspath(a.shots))
                print(f'screenshots: {os.path.abspath(a.shots)}')
            p = probs.take()
            results.append(('no page errors', not p, '; '.join(p[:5])))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<62} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cars', default='Dune Buggy,Chomper', help='comma-separated stock cars (default: Dune Buggy,Chomper)')
    ap.add_argument('--realism', default='pilot,arcade', help='comma-separated realism levels (default: pilot,arcade)')
    ap.add_argument('--quality', default='low', help='graphics setting (physics does not depend on it)')
    ap.add_argument('--shots', metavar='DIR', help='also save screenshots of the park and of cars mid-stunt to DIR')
    ap.add_argument('--json', metavar='FILE', help='write the full report')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(asyncio.run(main(ap.parse_args())))
