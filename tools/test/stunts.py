#!/usr/bin/env python3
"""Skywright stunt park test: drives stock cars and bikes through the stunt park at every location (and the Grand
Canyon's daredevil canyon jump) in headless Chrome, on the real flight model with scripted inputs (gas, a lane-keeping
steer), and checks, at each location, that

  - the park's site (found from the real terrain, water and building data, src/stuntSite.js) is flat and clear: dry
    land, no buildings, roads, water, woods or tree canopy on the pad;
  - a car and a bike start at the start arch, facing the first kicker, and nothing compiles a shader mid-flight;
  - the loop run (start arch -> kickers (-> tabletop) -> boost -> loop): it gets air off the last jump and lands
    upright, goes over the top of the loop upside down with its wheels on the deck, and comes out upright in the exit lane;
  - coasting into the loop at the boost pad's speed still makes it round; far too slow, it rolls back down;
  - the mesa jump (boost -> mesa -> boost -> lip -> gap -> landing ramp): it clears the gap and lands upright;
  - the bowl (wall ride) at several speeds, up to flat out: round it on the wall, never over the lip, back out upright;
  - from the start, full gas, hands off after the loop: round the banked east turn, never over its barrier, out
    upright onto straight 2 (at the Grand Canyon: not down the link lane); and steered towards the jump at the fork,
    down the link lane onto the canyon jump's run-up;
  - at the Grand Canyon: planes on the mesas (one set down stands on it, one flown into a cliff hits it); the canyon
    jump's start is at its run-up, and a scripted run (full gas, no steering) clears the real gap, lands upright on the
    far ramp and is stopped by the parachute; a car too slow for it is lowered into the canyon by the rescue parachute.

Run from anywhere:  python3 tools/test/stunts.py [--locations canyon,nyc] [--cars "Dune Buggy,Chomper,Dirt Bike"]
                    [--realism pilot,arcade] [--shots DIR]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, math, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'
LOCATIONS = ['canyon', 'nyc', 'lauterbrunnen', 'islands']


def checks(r, loc):
    """(name, ok, detail) for every assertion on the in-page report."""
    out = []
    add = lambda name, ok, detail='': out.append((f'{loc}: {name}', bool(ok), detail))
    for l in r['loop']:
        n = f"{l['name']} ({l['realism']})"
        tt, lp, ex = l['tabletop'], l['loop'], l['exit']
        add(f"{n}: {l['what']} jump, lands upright", tt['air'] > 0.3 and tt['landUp'] > 0.8, f"air {tt['air']} s, lowest up {tt['landUp']}")
        add(f'{n}: loop entry speed', l['entrySpeed'] > 21, f"{l['entrySpeed']} m/s")
        add(f'{n}: over the top of the loop', lp['topY'] > 17 and lp['upAtTop'] < -0.9, f"top {lp['topY']} m, up {lp['upAtTop']}")
        add(f'{n}: upside down on its wheels', lp['invertedOnWheels'] >= 8 and lp['invertedOnWheels'] >= lp['invertedFrames'] - 2, f"{lp['invertedOnWheels']}/{lp['invertedFrames']} frames")
        add(f'{n}: out of the loop upright, exit lane', ex['reached'] and ex['up'] > (0.8 if l.get('bike') else 0.9) and ex['y'] < 2.5 and abs(ex['z'] - 26.5) < 2.5 and ex['minUpAfter'] > 0.8, f"up {ex['up']}, y {ex['y']}, z {ex['z']}, {ex['v']} m/s")
        add(f'{n}: nothing broke on the loop run', l['alive'] == l['parts'] and not l['dead'], f"{l['alive']}/{l['parts']} parts")
    for s in r['speeds']:
        n = f"{s['name']} ({s['realism']})"
        c, t = s['coast'], s['tooSlow']
        add(f'{n}: coasting from the boost loops', c['inverted'] >= 8 and c['exitUp'] > 0.9 and c['exitX'] > s['exitXpark'] + 10 and c['alive'] == c['parts'], f"{c['inverted']} frames inverted, out at x {c['exitX']}")
        add(f'{n}: too slow rolls back, stays out of the ground', t['topY'] < 12 and t['inverted'] == 0 and t['finite'] and t['minY'] > 0.3, f"top {t['topY']} m, lowest {t['minY']} m")
    for j in r['jump']:
        n = f"{j['name']} ({j['realism']})"
        add(f'{n}: mesa jump clears the gap', j['gapMinY'] > 5 and j['air'] > 1.0, f"lip {j['lipSpeed']} m/s, {j['air']} s air, lowest over the gap {j['gapMinY']} m")
        add(f'{n}: mesa jump lands upright', j['landUp'] > 0.8 and j['landed'] and j['after']['up'] > 0.8 and j['alive'] == j['parts'], f"lowest up after landing {j['landUp']}, {j['alive']}/{j['parts']} parts")
    for b in r['bowl']:
        n = f"{b['name']} ({b['realism']}) bowl at {b['speed']} m/s"
        a = b['after']
        # (flat out, a motorbike rides right up to the lip: the catch fence holds it there; it must not go over the top)
        add(f'{n}', b['onWall'] > 60 and b['maxBank'] > 25 and b['maxY'] < (9 if b['speed'] > 28 else 8) and b['maxD'] <= b['rimA'] + 0.05 and a['up'] > 0.9 and a['wheels'] >= min(3, a['of']) and b['alive'] == b['parts'],
            f"bank up to {b['maxBank']} deg, {b['maxY']} m up the wall, {b['maxD']} m out (lip {b['rimA']}), out: up {a['up']}, {a['wheels']}/{a['of']} wheels down")
    for t in r.get('turn', []):
        n = f"{t['name']} ({t['realism']}) loop -> banked turn, hands off"
        e = t['end']
        add(f'{n}: round it, never over the barrier', t['round'] and t['maxD'] <= t['edge'] and t['minUp'] > 0.7 and abs(e['z'] + 30) < 4 and e['up'] > 0.9 and t['alive'] == t['parts'] and not t['dead'],
            f"in at {t['entry']} m/s (up to {t['maxV']}), {t['maxD']} m out (kerb {t['edge']}), up to {t['maxY']} m, lowest up {t['minUp']}; out at x {e['x']}, z {e['z']}, up {e['up']}, {t['alive']}/{t['parts']} parts")
    for f in r.get('fork', []):
        add(f"{f['name']} ({f['realism']}) steered onto the link lane at the fork reaches the canyon jump's run-up", f['onRunUp'] and f['up'] > 0.8 and not f['dead'], f"{f['runUp']['x']} m along the run-up, {f['runUp']['z']} m off its line (park x {f['park']['x']}, z {f['park']['z']})")
    p = r['planes']
    if p:
        la, cr = p['land'], p['crash']
        add(f"{p['name']} set down on the mesa stands on it", la['onGround'] and la['y'] > la['topY'] + 0.3 and la['y'] < la['topY'] + 4 and not la['dead'], f"y {la['y']} m (deck {la['topY']} m)")
        add(f"{p['name']} flown into the cliff hits it", cr['impacts'] > 0 and cr['speedPast'] < 20, f"{cr['impacts']} impacts, {cr['speedPast']} m/s past the face (from {cr['speed0']}), {cr['alive']}/{cr['of']} parts")
    for e in r['evel']:
        n = f"{e['name']} ({e['realism']}) canyon jump"
        add(f'{n}: rocket strip and lip', e['stripSpeed'] > e['plannedSpeed'] - 2 and abs(e['lipZ']) < 1.5, f"{e['stripSpeed']} m/s on the strip, {e['lipSpeed']} m/s at the lip, {e['lipZ']} m off the centreline")
        add(f'{n}: clears the {e["gap"]:.0f} m gap', e['air'] > 4 and e['minYOverGap'] > 5 and e['touchX'] > e['gap'] and e['slowmo'], f"{e['air']} s in the air, up to {e['peakY']} m, lowest over the gap {e['minYOverGap']} m above the rim, down at x {e['touchX']} (far rim {e['gap']})")
        add(f'{n}: lands upright on the far ramp, parachute stops it', e['onFarSide'] and e['landUp'] > 0.85 and e['minUpAfter'] > 0.8 and e['chute'] and e['endX'] < e['runEnd'] and e['endV'] < 6.5 and e['alive'] == e['parts'] and not e['dead'],
            f"lowest up {e['minUpAfter']}, stopped at x {e['endX']} (run-out ends {e['runEnd']}), {e['alive']}/{e['parts']} parts")
    es = r.get('evelShort')
    if es:
        add('too slow for the canyon jump: the rescue parachute lowers it', es['chute'] and es['touchVy'] > -9 and es['endUp'] > 0.5 and not es['dead'], f"falling at {es['fastestFall']} m/s before it opens, {es['touchVy']} m/s at touchdown, {es['endY']} m down in the canyon, up {es['endUp']}, {es['alive']}/{es['parts']} parts")
    return out


async def start(cdp, loc, car, start='park', quality='low'):
    await cdp.js(f"""Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', start: 'runway', landStart: {json.dumps(start)}, time: 11, realism: 'pilot' }}); {S}.settings.quality = {json.dumps(quality)};
        if ({S}.F) {S}.F.t = 0; {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(car)})); {S}.startFlight(); 1""")
    await cdp.wait_for(f'{S}.F && {S}.F.t > 1 && {S}.F.world.loc.id === {json.dumps(loc)}', 180, f'the {loc} flight to start')
    await asyncio.sleep(1.5)
    return await cdp.js(f"""(() => {{ const F = {S}.F, W = F.world.stunts, ac = F.ac, f = new {S}.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q);
        const s = F.world.landStart({json.dumps(start)}), ax = new {S}.THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading)), g = F.world.groundAt(ac.x.x, ac.x.z);
        let hit = 0; for (const p of ac.parts) for (const h of p.hull) if (F.world.treeHit?.(ac.worldPoint(h))) hit++;
        return {{ d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), car: ac.isCar, bike: !!ac.isBike, compiles: window.__inflightCompiles || 0, stats: W.stats, cfgStart: F.cfgStart,
          ground: g.type, onRoad: F.world.nearRoad ? F.world.nearRoad(ac.x.x, ac.x.z, 2) : null, hit, road: s.id === 'road' ? {{ x: Math.round(s.pos.x), z: Math.round(s.pos.z), dist: s.dist }} : null }}; }})()""")


SITE_JS = """(() => { const w = window.__sky.F.world, P = w.stuntPlan, R = w.real, k = w.stunts.park, L = P.layout; let n = 0, wet = 0, bare = 0, wood = 0, can = 0, lo = Infinity, hi = -Infinity;
  const c = { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } };
  for (let x = -L.pad[0]; x <= L.pad[0]; x += 8) for (let z = -L.pad[1]; z <= L.pad[1]; z += 8) { const p = k.W(new window.__sky.THREE.Vector3(x, 0, z)), h = w.height(p.x, p.z); n++;
    lo = Math.min(lo, h); hi = Math.max(hi, h); if (h < w.waterLevel + 0.5 || R.waterAt(p.x, p.z) != null) wet++; if (R.bare(p.x, p.z)) bare++; if ((R.forest(p.x, p.z) ?? 0) > 0.5) wood++;
    R.color(p.x, p.z, c); const s = c.r + c.g + c.b; if (s / 3 < 0.315 && (2 * c.g - c.r - c.b) / s > 0.08) can++; }
  const g = w.groundAt(k.start.pos.x, k.start.pos.z);
  const cfg = w.loc.stunts;
  return { site: P.site, fixed: !!(P.site.fixed || P.site.atJump), woodOK: (cfg.maxForest ?? 0.25) > 0.5 ? 1e9 : 0, canopyOK: cfg.canopy ? (cfg.maxCanopy ?? 0.12) + 0.03 : 1, n, wet, bare, wood, canopy: can / n, range: hi - lo, padH: k.O.y, startDy: g.h - k.O.y, dist: Math.hypot(k.O.x, k.O.z), ms: P.ms }; })()"""


async def shots(cdp, d, loc, evel):
    """The park's overview, the start, the loop with a car upside down at its top; at the canyon, the jump with a car over the gap."""
    os.makedirs(d, exist_ok=True)
    await cdp.js("import('/tools/test/stunts.js').then((m) => { window.__stunts = m; return 1; })")
    await cdp.js(f"""(() => {{ const F = {S}.F; F.paused = true; F.world.gust.set(0, 0, 0);
      window.__cam = (p, t, which) => {{ const c = {S}.rig.cam, site = which === 'evel' ? F.world.stunts.evel : F.world.stunts.park, V = {S}.THREE.Vector3; const a = site.W(new V(...p)), b = site.W(new V(...t)); c.position.copy(a); c.lookAt(b); c.userData.focus = c.position.clone(); F.world.update(0.016, c, new V(), []); F.world.flora?.update?.(c.position); }};
      document.getElementById('flight-ui').style.display = 'none'; return 1; }})()""")
    async def shot(name, js, settle=2.5):
        v = await cdp.js(js)
        if isinstance(v, str): print(f'  {name}: {v}')
        await asyncio.sleep(settle)
        await cdp.screenshot(os.path.join(d, f'{loc}-{name}'))
    await shot('overview.png', "__cam([-170, 150, 210], [0, 0, 0])", 5)
    await shot('start.png', "(() => { const k = __sky.F.world.stunts.park, s = k.Lp(k.start.pos); __cam([s.x - 24, 4.5, s.z + 3], [s.x + 40, 2, s.z - 1]); return 1; })()")
    await shot('loop.png', "(() => { const L = __sky.F.world.stunts.park.loopInfo, x = L.entryX + 21; return __cam([x - 40, 7, 62], [x, 9, 30]); })()")
    await shot('car-mid-loop.png', "(() => { const L = __sky.F.world.stunts.park.loopInfo, b = -__sky.F.world.stunts.park.XS + __sky.F.world.stunts.park.L.boost; const p = __stunts.stage('Dune Buggy', b - 20, 33.5, 1, 20, (a) => a.up.y < -0.95); __cam([p[0] - 14, p[1] - 4, p[2] + 22], p); return 1; })()")
    await shot('bowl.png', "(() => { const X = -__sky.F.world.stunts.park.XS; return __cam([X + 2, 5, -6], [X - 40, 6, 14]); })()")
    await shot('bowl-rim.png', "(() => { const X = -__sky.F.world.stunts.park.XS; return __cam([X - 20, 22, -62], [X - 30, 4, 0]); })()")
    await shot('road.png', "(() => { const w = __sky.F.world, s = w.landStart('road'), c = __sky.rig.cam, V = __sky.THREE.Vector3; if (!s) return 'no road start'; const f = new V(-Math.sin(s.heading), 0, -Math.cos(s.heading)), p = s.pos.clone(); p.y = w.groundAt(p.x, p.z).h; c.position.copy(p).addScaledVector(f, -22).add(new V(0, 7, 0)); c.lookAt(p.clone().addScaledVector(f, 30)); c.userData.focus = c.position.clone(); w.update(0.016, c, new V(), []); w.flora?.update?.(c.position); return 1; })()", 4)
    if evel:
        await shot('evel-overview.png', "(() => { const P = __sky.F.world.stunts.evel.P; __cam([P.gap * 0.5, 120, 330], [P.gap * 0.5, -40, 0], 'evel'); return 1; })()", 5)
        await shot('evel-start.png', "(() => { const E = __sky.F.world.stunts.evel, s = E.Lp(E.start.pos); __cam([s.x - 20, 5, 6], [s.x + 60, 4, 0], 'evel'); return 1; })()")
        await shot('evel-ramp.png', "(() => { const P = __sky.F.world.stunts.evel.P; __cam([P.ramp0 - 30, 12, 36], [-8, 10, 0], 'evel'); return 1; })()")
        await shot('evel-car-over-canyon.png', "(() => { const E = __sky.F.world.stunts.evel, P = E.P, s = E.Lp(E.start.pos); const p = __stunts.stage('Dune Buggy', s.x, 0, 1, 0, (a, x) => x > P.gap * 0.42, 30, null, 'evel', false); __cam([p[0] - 30, p[1] + 6, p[2] + 40], [p[0] + 8, p[1] - 10, p[2]], 'evel'); return 1; })()")
        await shot('evel-landing.png', "(() => { const E = __sky.F.world.stunts.evel, P = E.P, s = E.Lp(E.start.pos); const p = __stunts.stage('Dune Buggy', s.x, 0, 1, 0, (a, x) => x > P.xT + 40, 30, null, 'evel', false); __cam([p[0] - 10, p[1] + 5, p[2] + 26], [p[0] + 6, p[1], p[2]], 'evel'); return 1; })()")


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skystunt-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, t0, reports = [], time.time(), {}
    cars = a.cars.split(',')
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            warns = []
            cdp.handlers.append(lambda m, p: warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', []))) if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and ('[shaders]' in str(p.get('args')) or '[stunts]' in str(p.get('args'))) else None)
            await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            have = set(await cdp.js(f'{S}.presets.map((d) => d.name)'))
            cars = [c for c in cars if c in have]
            for loc in a.locations.split(','):
                print(f'--- {loc}', flush=True)
                add = lambda name, ok, detail='': results.append((f'{loc}: {name}', bool(ok), detail))
                # every stock car and bike starts at the arch
                for car in cars:
                    st = await start(cdp, loc, car, quality=a.quality)
                    add(f'{car} starts at the start arch, facing the first kicker', st['car'] and st['d'] < 3 and st['fx'] > 0.95 and st['cfgStart'] == 'park', f"{st['d']:.1f} m from the arch, heading {st['fx']:.2f}{' (bike)' if st['bike'] else ''}")
                # 'On the road': a street among the buildings
                for car in cars:
                    st = await start(cdp, loc, car, 'road', quality=a.quality)
                    add(f'{car} starts on the road, in its lane, facing along it', st['d'] < 3 and st['fx'] > 0.95 and st['hit'] == 0 and st['cfgStart'] == 'road', f"{st['d']:.1f} m from the spot {st['road']}, heading {st['fx']:.2f}, ground {st['ground']}, on a drawn road {st['onRoad']}, {st['hit']} parts in a building")
                st = await start(cdp, loc, cars[0], quality=a.quality)
                add('no shaders compiled mid-flight', st['compiles'] == 0, f"{st['compiles']} compiled {' '.join(w for w in warns if 'shaders' in w)[:300]}")
                site = await cdp.js(SITE_JS)
                ok = site['wet'] == 0 and site['range'] < (40 if site['fixed'] else 12) and (site['fixed'] or (site['bare'] == 0 and site['wood'] <= site['woodOK'] and site['canopy'] <= site['canopyOK']))
                add('site: dry, flat and clear', ok, f"({site['site']['x']:.0f}, {site['site']['z']:.0f}) yaw {math.degrees(site['site']['yaw']):.0f}, {site['dist']/1000:.1f} km from the runway; ground range {site['range']:.1f} m, "
                    f"water {site['wet']}, buildings/roads {site['bare']}, woods {site['wood']}, canopy {site['canopy']*100:.0f}% of {site['n']} points; start {site['startDy']:+.2f} m off the pad; planned in {site['ms']} ms")
                print(f"park: {st['stats']['tris']} triangles drawn, {st['stats']['collTris']} collision triangles, {st['stats']['draws']} draw calls, built in {st['stats']['buildMs']} ms", flush=True)
                evel = await cdp.js(f'!!{S}.F.world.stunts.evel')
                if evel:
                    for car in cars:
                        st = await start(cdp, loc, car, 'evel', quality=a.quality)
                        add(f'{car} picks the canyon jump start: at its run-up, facing the ramp', st['d'] < 3 and st['fx'] > 0.95, f"{st['d']:.1f} m from it, heading {st['fx']:.2f}")
                if not a.shots_only:
                    report = await cdp.js(f"import('/tools/test/stunts.js').then((m) => m.run({{ cars: {json.dumps(cars)}, realism: {json.dumps(a.realism.split(','))} }}))", timeout=1800)
                    reports[loc] = report
                    results += checks(report, loc)
                if a.shots:
                    await shots(cdp, os.path.abspath(a.shots), loc, evel)
            if a.json:
                json.dump(reports, open(a.json, 'w'), indent=1)
            p = probs.take()
            results.append(('no page errors', not p, '; '.join(p[:5])))
            results.append(('no stunt site warnings', not [w for w in warns if '[stunts]' in w], '; '.join(w for w in warns if '[stunts]' in w)))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<70} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--locations', default=','.join(LOCATIONS), help='comma-separated locations (default: all four)')
    ap.add_argument('--cars', default='Dune Buggy,Chomper,Dirt Bike,Sport Bike', help='comma-separated stock cars and bikes (default: Dune Buggy,Chomper,Dirt Bike,Sport Bike)')
    ap.add_argument('--realism', default='pilot,arcade', help='comma-separated realism levels (default: pilot,arcade)')
    ap.add_argument('--quality', default='low', help='graphics setting (physics does not depend on it)')
    ap.add_argument('--shots', metavar='DIR', help='also save screenshots of each park, the canyon jump and cars mid-stunt to DIR')
    ap.add_argument('--json', metavar='FILE', help='write the full report')
    ap.add_argument('--shots-only', action='store_true', help='with --shots: only the start checks and the screenshots, no driving tests')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(asyncio.run(main(ap.parse_args())))
