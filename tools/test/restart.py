#!/usr/bin/env python3
"""Skywright restart test: a restart keeps the World and must look and behave exactly like a fresh start.

A restart (pause > Restart, or "Try again" after a crash: main.js restartFlight) keeps the World when its inputs (place,
quality tier, time, weather, moon) are unchanged, and World.reset() puts back everything a flight changed. At each place
(Lauterbrunnen by default: real buildings, a stunt park, a marina and a water park) it checks, in headless Chrome:

1. damage: a flight knocks down and holes the buildings nearest the runway through the destruction API and flattens
   trees; after a restart it is the same World, every building is whole again (collision heights, the shader's dmg
   bytes, damage slots), no debris, mounds, scorch marks, fires or toppling tops are left, the trees stand, and the
   vehicle starts exactly where it started the first time
2. memory: 6 restarts (damage before every other one): renderer.info geometries and textures, the shader program
   count and the scene's child count stay flat (a leak of one a restart shows over the last five)
3. fresh: back to the hangar frees the kept World; a new start builds a new one, with the same spawn and about the same
   GPU memory as the restarted flights
4. start types: runway, air, the stunt park, a street, the marina, the water park, the launch pad (and New York's
   helipad, if nyc is in --places), each swapped into the World of 3 (__sky.swapVehicle: no World built per start):
   restart, same World, same start and spawn as when it was swapped in, and it rides / flies on for 4 s (alive, finite,
   moving where it has throttle)

The game's own time is stepped with __sky.advance (no frames drawn) wherever the test waits for the game: buildings
coming down, flying on.

Run from anywhere:  python3 tools/test/restart.py [--places lauterbrunnen,nyc] [--restarts 6]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

S = 'window.__sky'
M = "import('/tools/test/restart.js')"
STARTS = [  # (label, preset (or 'rocket': the first vertical preset), flightCfg overrides, throttle)
    ('runway', 'Kestrel', {'start': 'runway'}, 'plane'),
    ('air', 'Kestrel', {'start': 'air'}, 'plane'),
    ('stunt park', 'Dune Buggy', {'landStart': 'park'}, 'gas'),
    ('street', 'Dune Buggy', {'landStart': 'road'}, 'gas'),
    ('marina', 'Speedboat', {'boatStart': 'marina'}, 'gas'),
    ('water park', 'Speedboat', {'boatStart': 'waterpark'}, 'gas'),
    ('launch pad', 'rocket', {'start': 'runway'}, None),
    ('helipad', 'Dragonfly', {'start': 'runway'}, None),
]


async def start(cdp, loc, preset, cfg, quality):
    pick = f"{S}.presets.find((d) => {S}.analyze(d).vertical)" if preset == 'rocket' else f"{S}.presets.find((d) => d.name === {json.dumps(preset)})"
    await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, online: false, mode: 'free', time: 11, weather: 'clear', realism: 'pilot', ...{json.dumps(cfg)} }});
        {S}.settings.quality = {json.dumps(quality)}; {S}.controls.setThrottle(0); {S}.controls.pedal.gas = 0;
        window.__oldF = {S}.F; {S}.hangar.load({pick}); {S}.startFlight(); return 1; }})()""")
    await running(cdp, 180, f'{preset} at {loc} to start')
    # a new World streams textures in over its first real second or so (async loads and uploads): let that settle on the
    # real loop before measuring, as the old real-time waits did
    await cdp.js(f"""(async () => {{ const m = () => {S}.renderer.info.memory, t0 = performance.now(); let last = '', since = performance.now();
        while (performance.now() - t0 < 6000) {{ const k = m().textures + '/' + m().geometries; if (k !== last) {{ last = k; since = performance.now(); }} else if (performance.now() - since > 600) break;
          await new Promise((r) => setTimeout(r, 50)); }} return 1; }})()""", timeout=15)
    return await snap(cdp)


async def swap(cdp, preset, cfg):
    """Fly another vehicle (and start choice) in the same World: a restart with a new design (__sky.swapVehicle)."""
    pick = f"{S}.presets.find((d) => {S}.analyze(d).vertical)" if preset == 'rocket' else f"{S}.presets.find((d) => d.name === {json.dumps(preset)})"
    await cdp.js(f"""(() => {{ Object.assign({S}.F.cfg, {{ landStart: undefined, boatStart: undefined, start: 'runway', ...{json.dumps(cfg)} }});
        {S}.controls.setThrottle(0); {S}.controls.pedal.gas = 0; window.__oldF = {S}.F; {S}.swapVehicle({pick}); return 1; }})()""")
    await running(cdp, 120, f'{preset} to be swapped in')
    return await snap(cdp)


async def running(cdp, timeout, what):
    """The new flight's clock runs and its loading screen is gone; then one game second stepped (advance), as the old
    real-time wait for F.t > 1 did."""
    await cdp.wait_for(f'{S}.F && {S}.F !== window.__oldF && {S}.F.t > 0 && !{S}.F.warm', timeout, what)
    await cdp.js(f'{S}.advance(1); 1')
    # and 15 frames drawn: what the snapshot measures (GPU textures) is what drawing uploads. With none drawn the texture
    # count wanders by a block of 15 a few restarts in, depending on how many frames each flight drew (seen with 0 and 4)
    await cdp.js('(async () => { for (let i = 0; i < 15; i++) await new Promise((r) => requestAnimationFrame(r)); return 1; })()')


async def restart(cdp):
    await cdp.js(f'{S}.controls.setThrottle(0); {S}.controls.pedal.gas = 0; window.__oldF = {S}.F; {S}.restartFlight(); 1')
    await running(cdp, 120, 'the restarted flight')
    return await snap(cdp)


async def snap(cdp):
    return json.loads(await cdp.js(f'{M}.then((m) => JSON.stringify(m.snap({S})))'))


async def to_hangar(cdp):
    await cdp.js(f'{S}.endFlight(); 1')
    await cdp.wait_for(f"!{S}.F && document.getElementById('hangar-ui').style.display === ''", 30, 'the hangar')


def same_spawn(a, b, tol=1e-3):
    return all(abs(x - y) <= tol for x, y in zip(a['spawn'], b['spawn']))


async def place(cdp, loc, a, add):
    # 1. damage, restart, whole again
    s0 = await start(cdp, loc, 'Kestrel', {'start': 'runway'}, a.quality)
    d = json.loads(await cdp.js(f'{M}.then((m) => JSON.stringify(m.damage({S})))'))
    await cdp.js(f'{S}.advance(3); 1')  # (the game brings them down: debris, dust, fires; stepped, not drawn)
    dd = json.loads(await cdp.js(f'{M}.then((m) => JSON.stringify(m.damaged({S})))'))
    add(f'{loc}: buildings damaged before the restart', d['buildings'] > 0 and dd['buildings'] > 0 and dd['cut'] > 0 and dd['chunks'] > 1,
        f"{d['buildings']} hit, {dd['cut']} cut down, {dd['chunks']} debris, {dd['fires']} fires, {d['trees']} trees flattened")
    s1 = await restart(cdp)
    add(f'{loc}: restart keeps the World', s1['world'] == s0['world'], f"world {s0['world']} -> {s1['world']}")
    bad = json.loads(await cdp.js(f'{M}.then((m) => JSON.stringify(m.whole({S})))'))
    add(f'{loc}: everything whole again after the restart', not bad, '; '.join(bad[:6]) or 'buildings, trees, debris, slots')
    add(f'{loc}: same spawn as the first start', same_spawn(s0, s1) and s0['start'] == s1['start'], f"{s0['spawn'][:3]} / {s1['spawn'][:3]}")
    add(f'{loc}: scene child count as a fresh start', s1['kids'] == s0['kids'], f"{s0['kids']} -> {s1['kids']}")
    # 2. memory over many restarts
    snaps = []
    for k in range(a.restarts):
        if k % 2 == 0:
            await cdp.js(f'{M}.then((m) => m.damage({S}))'); await cdp.js(f'{S}.advance(1.5); 1')
        snaps.append(await restart(cdp))
    tail = snaps[1:] or snaps  # (the first restart may still compile a shader the first flight hadn't drawn)
    for key, tol in (('geometries', 3), ('textures', 1), ('programs', 2), ('kids', 0)):
        vals = [s[key] for s in tail]
        add(f'{loc}: {key} flat over {a.restarts} restarts', max(vals) - min(vals) <= tol and vals[-1] - vals[0] <= tol, ' '.join(map(str, [s[key] for s in snaps])))
    add(f'{loc}: one World through every restart', all(s['world'] == s0['world'] for s in snaps))
    # 3. back to the hangar frees it; a fresh start matches the restarts
    await to_hangar(cdp)
    add(f'{loc}: the hangar holds no World', await cdp.js(f'!{S}.kept'))
    s2 = await start(cdp, loc, 'Kestrel', {'start': 'runway'}, a.quality)
    last = snaps[-1]
    add(f'{loc}: fresh start builds a new World with the same spawn', s2['world'] != s0['world'] and same_spawn(s2, s1))
    add(f'{loc}: restarted GPU memory as a fresh start', abs(last['geometries'] - s2['geometries']) <= max(8, s2['geometries'] * 0.05) and abs(last['textures'] - s2['textures']) <= 3,
        f"geometries {last['geometries']} vs {s2['geometries']}, textures {last['textures']} vs {s2['textures']}, kids {last['kids']} vs {s2['kids']}")
    # 4. every start type, swapped into this World (a restart with that vehicle and start), then restarted: the same
    # World, start and spawn as when it was swapped in, and it rides / flies on for 4 game seconds
    for label, preset, cfg, thr in STARTS:
        if label == 'helipad' and loc != 'nyc':
            continue
        f = await swap(cdp, preset, cfg)
        r = await restart(cdp)
        ok = r['world'] == f['world'] == s2['world'] and r['start'] == f['start'] and same_spawn(f, r)
        if thr == 'plane':
            await cdp.js(f'{S}.controls.setThrottle(1); 1')
        elif thr == 'gas':
            await cdp.js(f'{S}.controls.pedal.gas = 1; 1')
        await cdp.js(f'{S}.advance(4); 1')
        e = await snap(cdp)
        moved = sum((x - y) ** 2 for x, y in zip(e['pos'], r['pos'])) ** 0.5
        go = e['alive'] and e['finite'] and (thr is None or moved > 3)
        add(f"{loc}: {label} ({f['start']}): restart as swapped in, then on", ok and go,
            f"world {'kept' if r['world'] == f['world'] == s2['world'] else 'NEW'}, start {f['start']}/{r['start']}, moved {moved:.0f} m{'' if e['alive'] else ', DEAD'}")
    await to_hangar(cdp)


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    results, t0 = [], time.time()
    add = lambda name, ok, detail='': results.append((name, bool(ok), detail))
    try:
        for loc in a.places.split(','):
            profile = tempfile.mkdtemp(prefix='skyrestart-')
            proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1000,700')
            try:
                async with websockets.connect(ws_url, max_size=None) as ws:
                    cdp = CDP(ws)
                    probs = Problems(origin)
                    cdp.handlers.append(probs.on)
                    await cdp.send('Runtime.enable')
                    await cdp.send('Page.navigate', url=origin + '/')
                    await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 60, 'the app to boot')
                    await cdp.wait_for("!document.getElementById('splash')", 30, 'the splash')
                    try:
                        await place(cdp, loc, a, add)
                    except Exception as e:  # (a timeout: report it with the rest)
                        add(f'{loc}: ran to the end', False, repr(e)[:200])
                    p = probs.take()
                    add(f'{loc}: no page errors', not p, '; '.join(p[:5]))
            finally:
                proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
    finally:
        if srv:
            srv.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<66} {detail}")
    print('-' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {len(results) - len(bad)}/{len(results)} checks in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--places', default='lauterbrunnen', help='locations (default: lauterbrunnen; nyc adds the helipad start)')
    ap.add_argument('--restarts', type=int, default=6, help='restarts in the memory check (default 6: a leak of one geometry, texture or program a restart shows over the last 5)')
    ap.add_argument('--quality', default='low')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(asyncio.run(main(ap.parse_args())))
