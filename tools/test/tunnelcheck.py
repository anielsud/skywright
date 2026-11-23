#!/usr/bin/env python3
"""Skywright wind tunnel check (src/windTunnel.js), in two tiers:

  Node (tools/test/tunnelcheck.js, every stock vehicle, a few seconds in all): fails if
  - (planes) the lift curve doesn't rise and then stall (lift falls away and STALL! shows) when the angle of attack is
    swept from -10 to +30 degrees;
  - the tunnel's forces and moments differ from what the flight model integrates in a real flight substep at the same
    state (attitude, airspeed, controls, flaps, subsonic and supersonic).
  Browser (--ui; two vehicles by default, the first one opened twice): opens the tunnel in headless Chrome and fails if
  - the page logs an error or throws, or the tunnel doesn't open, or doesn't close;
  - a shader compiles while the tunnel runs (or on reopening), or frames are too slow while it sweeps the angle with
    the smoke on and then swings on the free pivot;
  - closing the tunnel leaves geometries or textures behind (renderer.info.memory back where it was in the hangar).

Run from anywhere:  python3 tools/test/tunnelcheck.py [--node | --ui] [--only Kestrel] [--shots DIR] [--json out.json]
The browser tier needs what smoke.py needs (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, subprocess, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import ROOT, free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

UI_VEHICLES = ['Kestrel', 'Dragonfly']  # a plane (opened twice: the reopen must compile nothing) and a helicopter
MOD = "import('/tools/test/tunnelcheck.js')"


def node_tier(a):
    cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'tunnelcheck'] + (['--only', a.only] if a.only else []) + (['--json', a.json] if a.json else [])
    return subprocess.run(cmd, cwd=ROOT).returncode


async def ui_tier(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skytunnel-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, a.size.replace('x', ','))
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    fails = 0
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            for d in ('Runtime', 'Log', 'Network'):
                await cdp.send(f'{d}.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            await cdp.js(f"{MOD}.then((m) => {{ window.__tc = m; return m.settle(); }})", timeout=60)
            names = await cdp.js("__sky.presets.map((p) => p.name)")
            want = [a.only] if a.only else UI_VEHICLES
            first = True
            for name in want:
                i = next((k for k, n in enumerate(names) if n.lower() == name.lower()), None)
                if i is None:
                    print(f'FAIL  {name}: no such stock vehicle'); fails += 1; continue
                r, t0 = {'name': names[i], 'problems': []}, time.time()
                try:
                    await cdp.js(f"__sky.hangar.load(__sky.presets[{i}]); 1")
                    mem0 = await cdp.js('__tc.settle()', timeout=60)
                    await cdp.js("__sky.openTunnel(); 1")
                    await cdp.wait_for('__sky.tunnel && __sky.tunnel.ready', 30, 'the tunnel to open')
                    # run it: sweep the angle with the smoke in colour, then the free pivot, and time the frames
                    await cdp.js("__tc.frames(10).then(() => { const t = __sky.tunnel; t.perf.n = 0; t.perf.msSum = 0; t.perf.worst = 0; t.perf.cpu = 0; t.st.mode = 1; t.flow.setMode(1); t.startSweep(); return __tc.frames(90); })", timeout=60)
                    if a.shots:
                        await cdp.screenshot(os.path.join(a.shots, f'{i:02d}_{names[i].replace(" ", "_")}_sweep.png'))
                    await cdp.js("(() => { const t = __sky.tunnel; t.setPivot(true); t.piv.thd = 0.6; t.piv.psd = 0.4; return __tc.frames(60); })()", timeout=60)
                    perf = r['perf'] = await cdp.js("__sky.tunnel.stats4test()")
                    if perf['frames'] < 100:
                        r['problems'].append(f'only {perf["frames"]} frames counted of 150')
                    if perf['avgMs'] > a.max_ms:
                        r['problems'].append(f'frames too slow: {perf["avgMs"]:.1f} ms average (limit {a.max_ms})')
                    if perf['cpuMs'] > a.max_cpu:
                        r['problems'].append(f'tunnel frame work {perf["cpuMs"]:.1f} ms average (limit {a.max_cpu})')
                    if perf['compiles']:
                        r['problems'].append(f'{perf["compiles"]} shader(s) compiled while the tunnel ran')
                    progs_open = await cdp.js("__sky.renderer.info.programs.length")
                    # close and count what's left on the GPU
                    await cdp.js("__sky.tunnel.exit(); 1")
                    mem1 = await cdp.js('__tc.settle()', timeout=60)
                    r['mem'] = {'before': mem0, 'after': mem1}
                    # (the first visit can end lower: the hangar only re-uploads what it still draws)
                    if mem1['geo'] > mem0['geo'] or mem1['tex'] > mem0['tex']:
                        r['problems'].append(f'leak: geometries {mem0["geo"]} -> {mem1["geo"]}, textures {mem0["tex"]} -> {mem1["tex"]}')
                    if first:  # a second visit must not compile anything new, and must leave the GPU exactly as the first did
                        first = False
                        await cdp.js("__sky.openTunnel(); 1")
                        await cdp.wait_for('__sky.tunnel && __sky.tunnel.ready', 30, 'the tunnel to reopen')
                        await cdp.js('__tc.frames(10)')
                        progs2 = await cdp.js("__sky.renderer.info.programs.length")
                        await cdp.js("__sky.tunnel.exit(); 1")
                        mem2 = await cdp.js('__tc.settle()', timeout=60)
                        r['reopen'] = {'programs': [progs_open, progs2], 'mem': mem2}
                        if progs2 > progs_open:
                            r['problems'].append(f'reopening compiled {progs2 - progs_open} new shader programs')
                        if mem2['geo'] != mem1['geo'] or mem2['tex'] != mem1['tex']:
                            r['problems'].append(f'leak on the second visit: geometries {mem1["geo"]} -> {mem2["geo"]}, textures {mem1["tex"]} -> {mem2["tex"]}')
                    if await cdp.js("!!__sky.tunnel || !!document.getElementById('tunnel-ui')"):
                        r['problems'].append('the tunnel did not close')
                except Exception as e:  # noqa: BLE001
                    r['problems'].append(f'error: {e}')
                    try:
                        await cdp.js("__sky.tunnel && __sky.tunnel.exit(); 1")
                    except Exception:  # noqa: BLE001
                        pass
                r['problems'] += probs.take()
                bad = len(r['problems']); fails += bad
                p, m = r.get('perf', {}), r.get('mem', {})
                print(f'{"FAIL" if bad else "PASS"}  {names[i]:<12} tunnel UI: frame {p.get("avgMs", 0):5.1f} ms (tunnel {p.get("cpuMs", 0):4.1f} ms, {p.get("lines", 0)} lines, '
                      f'{p.get("frames", 0)} frames)  geo/tex {m.get("before", {}).get("geo")}/{m.get("before", {}).get("tex")} -> {m.get("after", {}).get("geo")}/{m.get("after", {}).get("tex")}  {time.time() - t0:.1f} s', flush=True)
                for x in r['problems'][:6]:
                    print('      ' + str(x)[:600])
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    return fails


def main(a):
    failed = []
    if not a.ui:
        if node_tier(a):
            failed.append('node tier')
    if not a.node:
        if asyncio.run(ui_tier(a)):
            failed.append('tunnel UI')
    print(f"\n{'FAIL' if failed else 'PASS'}  tunnelcheck" + (f": {', '.join(failed)}" if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--node', action='store_true', help='only the Node tier (lift curves and forces, every vehicle)')
    ap.add_argument('--ui', action='store_true', help='only the browser tier (the open tunnel, two vehicles)')
    ap.add_argument('--only', help='just this preset (by name), in both tiers')
    ap.add_argument('--shots', help='save a screenshot of each tunnel here')
    ap.add_argument('--json', help='write the Node tier report here')
    ap.add_argument('--max-ms', type=float, default=50, help='slowest acceptable average frame time, ms (default 50)')
    ap.add_argument('--max-cpu', type=float, default=12, help='most tunnel work per frame (physics, smoke tracing, readouts), ms (default 12)')
    ap.add_argument('--url', help='check an already running server instead of serving the repo (browser tier)')
    ap.add_argument('--size', default='1280x800', help='window size WxH (CI: smaller, software WebGL)')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(main(ap.parse_args()))
