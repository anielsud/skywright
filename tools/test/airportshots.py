#!/usr/bin/env python3
"""Airport screenshots (#227): the airfield from fixed cameras, for before/after comparisons.
python3 tools/test/airportshots.py [REPO] OUTDIR TAG [--locs a,b] [--q low,high] [--times 11,21] [--views start,hold,...]
REPO defaults to this checkout (give another checkout's path to photograph its code, e.g. main for a baseline).
Views: start (the runway start's own camera), hold (cockpit height at the 36R threshold), roll (mid takeoff roll
glancing at the terminal), back (300 m climb-out look-back), side (over the runways at the apron), final (short final
over the approach lights), signs (taxiing towards connector B's hold point), loc (localizer), gs (glideslope + PAPI), gate (landside road and fence), terminal, landside, radar. One flight per place, time and quality,
paused; the camera is moved and the world streamed to it before each shot."""
import asyncio, os, sys, tempfile, shutil, json, argparse
p = argparse.ArgumentParser(); p.add_argument('args', nargs='+')
p.add_argument('--locs', default='lauterbrunnen,islands,canyon,nyc'); p.add_argument('--q', default='high'); p.add_argument('--times', default='11,21')
p.add_argument('--views', default='start,hold,roll,back,side'); p.add_argument('--size', default='1280,800'); p.add_argument('--design', default='Kestrel')
p.add_argument('--js', default='', help='JavaScript run in the page after each flight starts (W = the World), e.g. to try a material setting')
a = p.parse_args()
if len(a.args) == 2: a.args.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
a.repo, a.out, a.tag = a.args
sys.path.insert(0, os.path.join(a.repo, 'tools/test'))
import websockets
from smoke import free_port, start_server, launch_chrome, CDP
S = 'window.__sky'
# camera (eye) and target in airport coords; runway 36R at x=0, threshold z=+840, roll towards -z, apron x 100..330
VIEWS = {
  'hold':  ((0, 2.6, 790), (40, 2, 300)),             # cockpit-ish at the threshold looking down the runway, apron on the right
  'roll':  ((0, 2.6, 300), (220, 6, 80)),             # mid takeoff roll glancing right at the terminal/hangars
  'back':  ((-60, 300, -1700), (180, 0, 0)),           # 300 m climb-out look-back
  'side':  ((-250, 60, 420), (230, 5, 40)),            # over the runways looking at the apron & buildings
  'final': ((0, 30, 1250), (0, 0, 800)),               # short final over the approach lights
  'signs': ((74, 3.2, 925), (30, 1, 892)),             # taxiing towards connector B's hold point
  'loc':   ((35, 6, -1060), (0, 2, -1100)),            # the 36R localizer array past the far end
  'gs':    ((-40, 5, 680), (-80, 6, 640)),             # the glideslope mast and PAPI by the touchdown zone
  'gate':  ((620, 7, 170), (420, 1, 110)),            # the landside road through the perimeter fence's gate
  'terminal': ((215, 9, 30), (310, 9, 130)),         # the terminal and tower from the apron
  'landside': ((420, 5, 150), (320, 7, 115)),         # the terminal's kerb from the landside road
  'radar': ((412, 16, -126), (430, 13, -140)),        # the radar on its lattice tower
  'facade': ((262, 5, 92), (300, 9, 122)),
  'front': ((215, 4, 120), (300, 8, 120)),            # square on to the terminal (compare with the reference photo)           # close on the terminal's airside face
}
async def main():
    port = free_port(); srv = start_server(port)
    prof = tempfile.mkdtemp(); proc, ws_url = launch_chrome(free_port(), prof, a.size)
    os.makedirs(a.out, exist_ok=True)
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate', url=f'http://127.0.0.1:{port}/')
            await cdp.wait_for(f'{S} && {S}.hangar', 90, 'boot')
            for q in a.q.split(','):
              for loc in a.locs.split(','):
                for t in a.times.split(','):
                    await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {{ location: '{loc}', online: false, mode: 'free', start: 'runway', time: {t}, weather: 'clear', realism: 'pilot' }}); {S}.settings.quality = '{q}';
                        if ({S}.F) {S}.F.t = 0; {S}.hangar.load({S}.presets.find((d) => d.name === '{a.design}')); {S}.startFlight(); return 1; }})()""")
                    await cdp.wait_for(f"{S}.F && {S}.F.t > 0 && !{S}.F.warm?.pending && {S}.F.world.loc.id === '{loc}'", 240, f'{loc} start')
                    await cdp.js(f'{S}.advance(1)'); await asyncio.sleep(4)
                    if a.js: await cdp.js(f'(() => {{ const W = {S}.F.world; {a.js}; return 1; }})()')
                    for v in a.views.split(','):
                        name = os.path.join(a.out, f'{loc}-{q}-t{t}-{v}-{a.tag}.png')
                        if v == 'start':
                            await cdp.js(f"(() => {{ {S}.F.paused = true; document.getElementById('flight-ui').style.display = 'none'; return 1; }})()")
                        else:
                            (ex, ey, ez), (tx, ty, tz) = VIEWS[v]
                            await cdp.js(f"""(() => {{ {S}.F.paused = true; document.getElementById('flight-ui').style.display = 'none'; const w = {S}.F.world, c = {S}.rig.cam, y = w.loc.rwyH;
                              c.position.set({ex}, y + {ey}, {ez}); c.lookAt({tx}, y + {ty}, {tz}); c.userData.focus = 1; try {{ w.update(0, c, new {S}.THREE.Vector3(), []); }} catch (e) {{ w.real?.stream.update(c.position); w.tiles?.update(c.position); }} try {{ {S}.F.traffic?.update?.(0, null, c.position); }} catch (e) {{}} return 1; }})()""")
                        await asyncio.sleep(3)
                        await cdp.screenshot(name); print(name, flush=True)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(prof, ignore_errors=True)
asyncio.run(main())
