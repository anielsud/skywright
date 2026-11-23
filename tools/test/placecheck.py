#!/usr/bin/env python3
"""Skywright place check: the browser part of the stunt park, water park and wall tests (their physics runs are Node
suites: tools/test/stunts.js, waterpark.js, walls.js). One headless Chrome, one New York World (it has the stunt park,
the water park and the city's buildings), then the Grand Canyon (no water park). What needs the real page or the
imagery:

  stunts     main.js starts a car and a bike at the stunt park's arch and on the road, facing the right way; New
             York's site is dry, flat and clear, tree canopy included (the imagery doesn't decode in Node), and the
             loop run from its real arch;
  waterpark  main.js starts a boat that picks 'At the water park' at its arch, afloat; at the Grand Canyon (none
             there) at the marina;
  walls      the game loop's own runs (the flight's Dune Buggy, its pedal held down, building damage and all, stepped
             with __sky.advance) into two New York building faces: nothing of it gets inside;
  all        nothing compiles a shader mid-flight at New York (the other places: the shader check, shadercheck.py / smoke.py), no page
             errors, no stunt site or water park warnings.

Run from anywhere:  python3 tools/test/placecheck.py [--only stunts,waterpark,walls]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'
PARTS = ['stunts', 'waterpark', 'walls']
TOL = 0.1  # m: the deepest anything may get inside a building (walls)


async def fly(cdp, loc, design, cfg, swap=False):
    """Start a flight with design at loc (cfg: flightCfg fields), or with swap fly design in the same World with the
    current flight's cfg plus cfg (__sky.swapVehicle); wait until it runs, step it a second, draw a few frames."""
    if swap:
        await cdp.js(f"(() => {{ Object.assign({S}.F.cfg, {json.dumps(cfg)}); {S}.swapVehicle({S}.presets.find((d) => d.name === {json.dumps(design)})); return 1; }})()")
    else:
        await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', start: 'runway', time: 11, realism: 'pilot' }}, {json.dumps(cfg)}); {S}.settings.quality = 'low';
            if ({S}.F) {S}.F.t = 0; {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(design)})); {S}.startFlight(); return 1; }})()""")
    await cdp.wait_for(f'{S}.F && {S}.F.t > 0 && !{S}.F.warm?.pending && {S}.F.world.loc.id === {json.dumps(loc)} && {S}.F.ac.design.name === {json.dumps(design)}', 180, f'{design} at {loc} to start')
    await cdp.js(f'{S}.advance(1)')
    await asyncio.sleep(0.3)  # (a few frames drawn: any shader compiled for them is counted)


async def car_start(cdp, start):
    return await cdp.js(f"""(() => {{ const F = {S}.F, ac = F.ac, f = new {S}.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q);
        const s = F.world.landStart({json.dumps(start)}), ax = new {S}.THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading)), g = F.world.groundAt(ac.x.x, ac.x.z);
        let hit = 0; for (const p of ac.parts) for (const h of p.hull) if (F.world.treeHit?.(ac.worldPoint(h))) hit++;
        return {{ d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), car: ac.isCar, bike: !!ac.isBike, stats: F.world.stunts.stats, cfgStart: F.cfgStart,
          ground: g.type, onRoad: F.world.nearRoad ? F.world.nearRoad(ac.x.x, ac.x.z, 2) : null, hit, road: s.id === 'road' ? {{ x: Math.round(s.pos.x), z: Math.round(s.pos.z), dist: s.dist }} : null }}; }})()""")


async def boat_start(cdp):
    return await cdp.js(f"""(() => {{ const F = {S}.F, W = F.world.waterParks, ac = F.ac; if (!W) return {{ none: true, cfgStart: F.cfgStart }};
        const s = W.start, f = new {S}.THREE.Vector3(0, 0, -1).applyQuaternion(ac.q), ax = new {S}.THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading));
        return {{ d: Math.hypot(ac.x.x - s.pos.x, ac.x.z - s.pos.z), fx: f.dot(ax), wet: ac.boat ? ac.boat.wet : 0, up: ac.up.y, cfgStart: F.cfgStart }}; }})()""")


async def run(cdp, parts, add, warns):
    loc, flying = 'nyc', [False]
    async def at_nyc(design, cfg):  # (the first flight builds New York's World; the rest swap vehicles in it)
        await fly(cdp, loc, design, cfg, swap=flying[0]); flying[0] = True
    if 'stunts' in parts:  # main.js's start path, a car and a bike, at the arch and on the road (every car's pose at every place: Node)
        for i, (car, where) in enumerate([('Dune Buggy', 'park'), ('Dirt Bike', 'park'), ('Dirt Bike', 'road'), ('Dune Buggy', 'road')]):
            await at_nyc(car, {'landStart': where})
            st = await car_start(cdp, where)
            if where == 'park':
                add(f'stunts: {loc}: {car} starts at the start arch, facing the first kicker', st['car'] and st['d'] < 3 and st['fx'] > 0.95 and st['cfgStart'] == 'park', f"{st['d']:.1f} m from the arch, heading {st['fx']:.2f}{' (bike)' if st['bike'] else ''}")
            else:
                add(f'stunts: {loc}: {car} starts on the road, in its lane, facing along it', st['d'] < 3 and st['fx'] > 0.95 and st['hit'] == 0 and st['cfgStart'] == 'road', f"{st['d']:.1f} m from the spot {st['road']}, heading {st['fx']:.2f}, ground {st['ground']}, on a drawn road {st['onRoad']}, {st['hit']} parts in a building")
        # the real site (tree canopy from the imagery) and the loop run from its arch
        r = await cdp.js(f"""import('/tools/test/stunts.js').then((m) => {{ const S = {S}; S.F.paused = true; S.F.world.gust.set(0, 0, 0); S.F.world.gustT.set(0, 0, 0);
            const site = m.siteCheck(S), loop = [m.loopRun(S, 'Dune Buggy', 'pilot')]; return {{ site: {{ ok: site.ok, why: site.why }}, judged: m.judge({{ loop }}, {json.dumps(loc)}) }}; }})""", timeout=120)
        add(f'stunts: {loc}: site: dry, flat and clear', r['site']['ok'], r['site']['why'])
        for n, ok, why in r['judged']:
            add(f'stunts: {n}', ok, why)
        print(f"park: {st['stats']['tris']} triangles drawn, {st['stats']['collTris']} collision triangles, {st['stats']['draws']} draw calls", flush=True)
    if 'waterpark' in parts:  # main.js's start path for a boat that picks the water park (every boat's pose at every place: Node)
        boats = await cdp.js(f'{S}.presets.filter((d) => {S}.analyze(d).boat).map((d) => d.name)')
        for i, boat in enumerate(boats[:2]):
            await at_nyc(boat, {'boatStart': 'waterpark'})
            st = await boat_start(cdp)
            add(f'waterpark: {loc}: {boat} starts at the water park, afloat, facing down the course', not st.get('none') and st['d'] < 3 and st['fx'] > 0.95 and st['wet'] > 0.05 and st['up'] > 0.95 and st['cfgStart'] == 'waterpark',
                f"{st.get('d', -1):.1f} m from the start, heading {st.get('fx', 0):.2f}, wet {st.get('wet', 0):.2f}")
    if 'walls' in parts:  # the game loop's own runs into two building faces near the start
        await at_nyc('Dune Buggy', {'landStart': 'park'})
        g = await cdp.js(f"""import('/tools/test/walls.js').then(async (m) => {{ const S = {S}; S.F.paused = true; const fs = m.faces(S, S.F.ac.x, {{ max: 2 }}), runs = [];
            for (const [k, v, a] of [[0, 30, 0], [fs.length > 1 ? 1 : 0, 10, 35]]) if (fs[k]) runs.push({{ face: k, v, a, ...(await m.gameRun(S, fs[k], v, a)) }});
            return runs; }})""", timeout=120)
        worst = max(g, key=lambda x: x['maxPen'], default=None)
        add(f'walls: {loc}: in the game loop the Dune Buggy stays out ({len(g)} runs)', g and worst['maxPen'] <= TOL, f"deepest {worst['maxPen']} m ({worst['v']} m/s, {worst['a']} deg); closest to the face's middle: " + ', '.join(f"{x['closest']} m" for x in g) if worst else 'no building faces found')
    c = await cdp.js('window.__inflightCompiles || 0')
    add(f'{loc}: no shaders compiled mid-flight', c == 0, f"{c} compiled {' '.join(w for w in warns if 'shaders' in w)[:300]}")
    if 'waterpark' in parts:  # a place with no water park: the marina
        loc = 'canyon'
        boat = (await cdp.js(f'{S}.presets.filter((d) => {S}.analyze(d).boat).map((d) => d.name)'))[0]
        await fly(cdp, loc, boat, {'boatStart': 'waterpark'})
        st = await boat_start(cdp)
        add(f'waterpark: {loc}: no water park here: a boat that picks it starts at the marina', st.get('none') and st['cfgStart'] == 'marina', f"started at {st['cfgStart']}")


async def main(a):
    parts = a.only.split(',') if a.only else PARTS
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skyplace-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, t0 = [], time.time()
    add = lambda name, ok, detail='': results.append((name, bool(ok), detail))
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            warns = []
            cdp.handlers.append(lambda m, p: warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', []))) if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and any(k in str(p.get('args')) for k in ('[shaders]', '[stunts]', '[waterpark]')) else None)
            await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for(f'{S} && {S}.hangar', 60, 'the app to boot')
            await run(cdp, parts, add, warns)
            p = probs.take()
            add('no page errors', not p, '; '.join(p[:5]))
            for k, what in (('stunts', 'stunt site'), ('waterpark', 'water park')):
                if k in parts:
                    add(f'no {what} warnings', not [w for w in warns if f'[{k}]' in w], '; '.join(w for w in warns if f'[{k}]' in w))
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<80} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  placecheck ({', '.join(parts)}): {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', help='comma-separated parts: stunts, waterpark, walls (default: all)')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    return ap


if __name__ == '__main__':
    sys.exit(asyncio.run(main(parser().parse_args())))
