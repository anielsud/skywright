#!/usr/bin/env python3
"""Skywright water park test: drives every stock boat (and a kid's random boat builds) through the water park at every
location that has one (src/waterPark.js) in headless Chrome, on the real flight model with scripted inputs (full gas, a
lane-keeping steer), and checks, at each location, that

  - the park's site (found from the real water, depth, building and bridge data) is open water: deep enough over the
    whole course, water in the margin round it, nothing built on it, no bridge over it, well clear of the marina;
  - every stock boat picks 'At the water park' and starts there, afloat and facing down the course, and nothing
    compiles a shader mid-flight; the park stays within its draw-call and triangle budget;
  - the MEGA JUMP from the start arch (Arcade and Pilot): full gas down the main lane, the boost strip, up the ramp; it
    gets real air, clears the island / barge / raft, splashes down upright and keeps every part;
  - the same for a kid's random boat builds, from the boost strip;
  - the kickers' lane at each boat's own speed: over both kickers to the hoop, upright, nothing broken;
  - the slalom (following a line through the gates) and the waterfall: the park says so;
  - flat out the wrong way into the back and the side of the MEGA JUMP ramp: nothing breaks off, not wrecked.
Sim is flown too and reported (no help in the air there: a nose-heavy boat may dive), not judged.

Run from anywhere:  python3 tools/test/waterpark.py [--locations islands,nyc] [--boats "Jet Ski,Fireboat"] [--shots DIR]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'
LOCATIONS = ['islands', 'nyc', 'lauterbrunnen', 'canyon']
MAX_DRAWS, MAX_TRIS = 6, 32000


def checks(r, loc):
    out = []
    add = lambda name, ok, detail='': out.append((f'{loc}: {name}', bool(ok), detail))
    s = r['site']
    add('site: open, deep water, nothing built, no bridge, clear of the marina', s['dry'] == 0 and s['shallow'] == 0 and s['built'] == 0 and s['bridge'] == 0 and s['marinaDist'] > 300,
        f"({s['site']['x']:.0f}, {s['site']['z']:.0f}), {s['n']} points: {s['dry']} dry, {s['shallow']} too shallow, {s['built']} built, {s['bridge']} under a bridge; shallowest {s['minDepth']} m; marina {s['marinaDist']} m away; found in {s['site'].get('ms', 0)} ms")
    st = s['stats']
    add('draw calls and triangles', st['draws'] <= MAX_DRAWS and st['tris'] <= MAX_TRIS, f"{st['draws']} draw calls, {st['tris']} triangles, {st['collTris']} collision triangles, built in {st['buildMs']} ms")
    for m in r['mega']:
        n = f"{m['name']} ({m['realism']}) MEGA JUMP"
        add(f'{n}: boost and ramp', m['reached'] and m['lipSpeed'] > 18, f"{m['toeSpeed']} m/s at the foot, {m['lipSpeed']} m/s at the lip")
        add(f'{n}: real air, clears the obstacle', m['air'] > 1.2 and m['maxY'] > 4 and m['cleared'], f"{m['air']} s in the air, up to {m['maxY']} m, lowest over the obstacle {m['overMinY']} m (top {m['obstTop']} m), from x {m['from']} to {m['to']}")
        add(f'{n}: splashes down upright, all parts', m['landUp'] > 0.8 and m['endUp'] > 0.9 and m['alive'] == m['parts'] and not m['dead'] and 'SPLASHDOWN!' in m['msgs'],
            f"lowest up after landing {m['landUp']}, end {m['endUp']}, pitch {m['minPitch']}..{m['maxPitchUp']}, {m['alive']}/{m['parts']} parts; {', '.join(m['msgs'])}")
    for m in r['kids']:
        n = f"{m['name']} ({m['realism']})"
        add(f'{n}: MEGA JUMP from the boost strip', m['reached'] and m['air'] > 1.0 and m['cleared'] and m['landUp'] > 0.7 and m['endUp'] > 0.9 and m['alive'] == m['parts'] and not m['dead'],
            f"lip {m['lipSpeed']} m/s, {m['air']} s air, up to {m['maxY']} m, over the obstacle {m['overMinY']} m; lowest up after {m['landUp']}, end {m['endUp']}, {m['alive']}/{m['parts']} parts")
    for k in r['kick']:
        add(f"{k['name']} ({k['realism']}) kickers' lane to the hoop", k['reachedHoop'] and k['minUp'] > 0.6 and k['endUp'] > 0.9 and k['alive'] == k['parts'] and not k['dead'],
            f"{k['air']} s air, lowest up {k['minUp']}, {k['alive']}/{k['parts']} parts; {', '.join(k['msgs'])}")
    for k in r['slalom']:
        add(f"{k['name']} ({k['realism']}) slalom and waterfall", 'PERFECT SLALOM!' in k['msgs'] and 'SPLASH!' in k['msgs'] and k['alive'] == k['parts'] and k['minUp'] > 0.7, ', '.join(k['msgs']))
    for k in r['wrong']:
        add(f"{k['name']} ({k['realism']}) flat out into the {k['what']} of the MEGA JUMP", k['alive'] == k['parts'] and not k['dead'] and k['endUp'] > 0.7, f"{k['alive']}/{k['parts']} parts, lowest up {k['minUp']}, end up {k['endUp']}, got past {k['past']}")
    return out


async def start(cdp, loc, boat, quality='low'):
    await cdp.js(f"""Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', boatStart: 'waterpark', time: 11, realism: 'pilot' }}); {S}.settings.quality = {json.dumps(quality)};
        if ({S}.F) {S}.F.t = 0; {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(boat)})); {S}.startFlight(); 1""")
    await cdp.wait_for(f'{S}.F && {S}.F.t > 1 && {S}.F.world.loc.id === {json.dumps(loc)}', 180, f'the {loc} flight to start')
    await asyncio.sleep(1.5)
    return await cdp.js(f"""(() => {{ const F = {S}.F, W = F.world.waterParks, ac = F.ac; if (!W) return {{ none: true, cfgStart: F.cfgStart }};
        const s = W.start, f = new {S}.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q), ax = new {S}.THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading));
        return {{ d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), wet: ac.boat ? ac.boat.wet : 0, up: ac.up.y, compiles: window.__inflightCompiles || 0, cfgStart: F.cfgStart }}; }})()""")


async def shots(cdp, d, loc):
    os.makedirs(d, exist_ok=True)
    await cdp.js("import('/tools/test/waterpark.js').then((m) => { window.__wp = m; return 1; })")
    await cdp.js(f"""(() => {{ const F = {S}.F; F.paused = true; F.world.gust.set(0, 0, 0);
      window.__cam = (p, t) => {{ const c = {S}.rig.cam, k = F.world.waterParks.park, V = {S}.THREE.Vector3; const a = k.W(new V(...p)), b = k.W(new V(...t)); c.position.copy(a); c.lookAt(b); c.userData.focus = c.position.clone(); F.world.update(0.016, c, new V(), []); F.world.flora?.update?.(c.position); return 1; }};
      document.getElementById('flight-ui').style.display = 'none'; return 1; }})()""")
    async def shot(name, js, settle=2.5):
        v = await cdp.js(js)
        if isinstance(v, str): print(f'  {name}: {v}')
        await asyncio.sleep(settle)
        await cdp.screenshot(os.path.join(d, f'{loc}-water-{name}'))
    await shot('overview.png', "__cam([-230, 95, 150], [-10, 0, 0])", 5)
    await shot('start.png', "(() => { const k = __sky.F.world.waterParks.park, s = k.Lp(k.start.pos); return __cam([s.x - 24, 5, s.z + 4], [s.x + 60, 3, s.z - 1]); })()")
    await shot('mega.png', "(() => { const r = __sky.F.world.waterParks.park.ramps.find((q) => q.name === 'mega'); return __cam([r.x0 - 22, 8, 26], [r.x1 + 10, 2, -2]); })()")
    await shot('boat-in-the-air.png', "(() => { const r = __sky.F.world.waterParks.park.ramps.find((q) => q.name === 'mega'), o = __sky.F.world.waterParks.park.obstacleAt; const p = __wp.stage('Speedboat', (a, x) => x > (o.x0 + o.x1) / 2); return __cam([p[0] - 12, p[1] + 1, p[2] + 22], [p[0] + 2, p[1] - 1, p[2]]); })()")
    await shot('fireboat-in-the-air.png', "(() => { const o = __sky.F.world.waterParks.park.obstacleAt; const p = __wp.stage('Fireboat', (a, x) => x > o.x0 + 2); return __cam([p[0] - 18, p[1] + 3, p[2] - 26], [p[0] + 2, p[1] - 1, p[2]]); })()")
    await shot('kickers-hoop.png', "(() => { const k = __sky.F.world.waterParks.park, h = k.hoops[0]; return __cam([h.x - 55, 7, h.z - 22], [h.x - 10, 3, h.z]); })()")
    await shot('jetski-hoop.png', "(() => { const k = __sky.F.world.waterParks.park, h = k.hoops[0], m = k.ramps.find((q) => q.name === 'small'); const p = __wp.stage('Jet Ski', (a, x) => x > h.x - 1, 40, h.z, m.x0 - 40); return __cam([h.x + 14, 4, h.z - 14], [h.x - 2, p[1], h.z]); })()")
    await shot('slalom-waterfall.png', "(() => { const k = __sky.F.world.waterParks.park, g = k.gates, f = k.falls[0]; return __cam([g[1].x, 9, -90], [g[3].x + 10, 1, f.z]); })()")
    await shot('island-stands.png', "(() => { const k = __sky.F.world.waterParks.park, o = k.obstacleAt; return __cam([o.x1 + 28, 7, 32], [(o.x0 + o.x1) / 2 - 8, 2, -8]); })()")
    await shot('night.png', "(() => { __sky.F.world.setTime(21.5); const k = __sky.F.world.waterParks.park, s = k.Lp(k.start.pos); return __cam([s.x - 24, 6, s.z + 4], [s.x + 60, 3, s.z - 1]); })()", 3)


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skywater-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, t0, reports = [], time.time(), {}
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            warns = []
            cdp.handlers.append(lambda m, p: warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', []))) if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and ('[shaders]' in str(p.get('args')) or '[waterpark]' in str(p.get('args'))) else None)
            await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            boats = a.boats.split(',') if a.boats else await cdp.js(f'{S}.presets.filter((d) => {S}.analyze(d).boat).map((d) => d.name)')
            for loc in a.locations.split(','):
                print(f'--- {loc}', flush=True)
                add = lambda name, ok, detail='': results.append((f'{loc}: {name}', bool(ok), detail))
                has = await cdp.js(f"import('/src/realworld.js').then((m) => !!m.REAL_LOCATIONS[{json.dumps(loc)}]?.waterPark)")
                if not has:
                    st = await start(cdp, loc, boats[0], a.quality)
                    add('no water park here: a boat that picks it starts at the marina', st.get('none') and st['cfgStart'] == 'marina', f"started at {st['cfgStart']}")
                    continue
                c0 = await cdp.js('window.__inflightCompiles || 0')  # (the previous location's screenshots stage fresh boats: not counted here)
                for boat in boats:
                    st = await start(cdp, loc, boat, a.quality)
                    add(f'{boat} starts at the water park, afloat, facing down the course', not st.get('none') and st['d'] < 3 and st['fx'] > 0.95 and st['wet'] > 0.05 and st['up'] > 0.95 and st['cfgStart'] == 'waterpark',
                        f"{st.get('d', -1):.1f} m from the start, heading {st.get('fx', 0):.2f}, wet {st.get('wet', 0):.2f}")
                st['compiles'] = st.get('compiles', 0) - c0
                add('no shaders compiled mid-flight', st['compiles'] == 0, f"{st.get('compiles')} compiled {' '.join(w for w in warns if 'shaders' in w)[:300]}")
                if not a.shots_only:
                    report = await cdp.js(f"import('/tools/test/waterpark.js').then((m) => m.run({{ boats: {json.dumps(boats)}, realism: {json.dumps(a.realism.split(','))}, kids: {a.kids} }}))", timeout=2400)
                    reports[loc] = report
                    results += checks(report, loc)
                    for m in report['sim']:
                        print(f"  info  {loc}: {m['name']} (sim) MEGA JUMP: {m['air']} s air, lowest up after landing {m['landUp']}, end {m['endUp']}, {m['alive']}/{m['parts']} parts")
                else:
                    rep = await cdp.js("import('/tools/test/waterpark.js').then((m) => { window.__sky.F.paused = true; return m.siteCheck(window.__sky); })")
                    results += [c for c in checks({'site': rep, 'mega': [], 'kids': [], 'kick': [], 'slalom': [], 'wrong': []}, loc)]
                if a.shots:
                    await shots(cdp, os.path.abspath(a.shots), loc)
            if a.json:
                json.dump(reports, open(a.json, 'w'), indent=1)
            p = probs.take()
            results.append(('no page errors', not p, '; '.join(p[:5])))
            results.append(('no water park warnings', not [w for w in warns if '[waterpark]' in w], '; '.join(w for w in warns if '[waterpark]' in w)))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<78} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--locations', default=','.join(LOCATIONS), help='comma-separated locations (default: all four; one without a water park checks the fallback)')
    ap.add_argument('--boats', help='comma-separated stock boats (default: every stock boat)')
    ap.add_argument('--realism', default='arcade,pilot', help='comma-separated realism levels judged (default: arcade,pilot)')
    ap.add_argument('--kids', type=int, default=8, help="how many random kid's boat builds (default 8)")
    ap.add_argument('--quality', default='low', help='graphics setting (physics does not depend on it)')
    ap.add_argument('--shots', metavar='DIR', help='also save screenshots of each water park and boats mid-jump to DIR')
    ap.add_argument('--shots-only', action='store_true', help='with --shots: only the start and site checks and the screenshots')
    ap.add_argument('--json', metavar='FILE', help='write the full report')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(asyncio.run(main(ap.parse_args())))
