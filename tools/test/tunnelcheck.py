#!/usr/bin/env python3
"""Skywright wind tunnel check: opens the wind tunnel (src/windTunnel.js) in headless Chrome for every stock vehicle and
fails if, for any of them,
  - the page logs an error or throws;
  - (planes) the lift curve doesn't rise and then stall (lift falls away and STALL! shows) when the angle of attack is swept from
    -10 to +30 degrees;
  - the tunnel's forces and moments differ from what the flight model integrates in a real flight substep at the same
    state (attitude, airspeed, controls, flaps, subsonic and supersonic);
  - a shader compiles while the tunnel runs, or frames are too slow while it sweeps the angle with the smoke on;
  - closing the tunnel leaves geometries or textures behind (renderer.info.memory back where it was in the hangar).

Run from anywhere:  python3 tools/test/tunnelcheck.py [--only Kestrel] [--shots DIR] [--json out.json]
Same requirements as smoke.py (Chrome + the websockets package). See tools/test/README.md.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP, Problems  # noqa: E402

SETTLE = """(async () => { const h = __sky.hangar; const t0 = performance.now();
  while ((h.env.restoring || h.env.loading || performance.now() - t0 < 1500) && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400)); const m = __sky.renderer.info.memory; return { geo: m.geometries, tex: m.textures, progs: __sky.renderer.info.programs.length }; })()"""


async def main(a):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    profile = tempfile.mkdtemp(prefix='skytunnel-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    report, fails = [], 0
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            for d in ('Runtime', 'Log', 'Network'):
                await cdp.send(f'{d}.enable')
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 60, 'the app to boot')
            await cdp.js(SETTLE, timeout=30)
            await cdp.js("import('/tools/test/tunnelcheck.js').then((m) => { window.__tc = m; return 1; })")
            names = await cdp.js("__sky.presets.map((p) => p.name)")
            first = True
            for i, name in enumerate(names):
                if a.only and name.lower() != a.only.lower():
                    continue
                r = {'name': name, 'problems': []}
                t0 = time.time()
                try:
                    kind = await cdp.js(f"(() => {{ const s = __sky.analyze(__sky.presets[{i}]); return s.heli ? 'heli' : s.car && s.wingArea < 0.5 ? 'car' : s.vertical ? 'rocket' : 'plane'; }})()")
                    r['kind'] = kind
                    await cdp.js(f"__sky.hangar.load(__sky.presets[{i}]); 1")
                    mem0 = await cdp.js(SETTLE, timeout=30)
                    await cdp.js("__sky.openTunnel(); 1")
                    await cdp.wait_for('__sky.tunnel && __sky.tunnel.ready', 30, 'the tunnel to open')
                    await asyncio.sleep(1.0)
                    # lift curve
                    lc = await cdp.js("JSON.stringify(__tc.liftCurve(__sky.tunnel))")
                    lc = json.loads(lc); r['stallAt'] = lc['stallAt']
                    cur = lc['curve']; L = [c[1] for c in cur]; A = [c[0] for c in cur]
                    k = max(range(len(L)), key=lambda j: L[j]); r['peak'] = [A[k], round(L[k])]
                    if kind == 'plane':
                        rises = L[k] > L[0] + 0.2 * lc['mass'] and all(L[j + 1] >= L[j] - 0.02 * abs(L[k]) for j in range(0, max(0, A.index(min(A, key=lambda x: abs(x - 8))))))
                        stalls = A[k] < A[-1] and min(L[k:]) < 0.95 * L[k] and any(c[3] for c in cur[k:]) and lc['stallAt'] is not None
                        if not rises:
                            r['problems'].append(f'lift curve does not rise: {[(A[j], round(L[j])) for j in range(0, len(A), 5)]}')
                        if not stalls:
                            r['problems'].append(f'lift curve does not stall: peak {L[k]:.0f} kg at {A[k]} deg, {L[-1]:.0f} kg at {A[-1]} deg')
                    # forces against the flight model
                    fm = await cdp.js("JSON.stringify(__tc.forceMatch(__sky.tunnel))")
                    fm = json.loads(fm); r['force'] = fm
                    worst = max([max(x['errF'], x['errT']) for x in fm if 'errF' in x] or [0]); r['forceErr'] = worst
                    if worst > 1e-6:
                        r['problems'].append(f'forces differ from the flight model (worst relative error {worst:.2e}): ' + json.dumps([x for x in fm if x.get('errF', 0) > 1e-6 or x.get('errT', 0) > 1e-6][:2]))
                    # run it: sweep the angle with the smoke in colour, then the free pivot, and time the frames
                    await cdp.js("(() => { const t = __sky.tunnel; t.perf.n = 0; t.perf.msSum = 0; t.perf.worst = 0; t.perf.cpu = 0; t.st.mode = 1; t.flow.setMode(1); t.startSweep(); return 1; })()")
                    await asyncio.sleep(3.0)
                    if a.shots:
                        await cdp.screenshot(os.path.join(a.shots, f'{i:02d}_{name.replace(" ", "_")}_sweep.png'))
                    await asyncio.sleep(2.8)
                    await cdp.js("(() => { const t = __sky.tunnel; t.setPivot(true); t.piv.thd = 0.6; t.piv.psd = 0.4; return 1; })()")
                    await asyncio.sleep(2.0)
                    perf = await cdp.js("__sky.tunnel.stats4test()")
                    r['perf'] = perf
                    if perf['frames'] < 20:
                        r['problems'].append(f'only {perf["frames"]} frames in 7.8 s')
                    if perf['avgMs'] > a.max_ms:
                        r['problems'].append(f'frames too slow: {perf["avgMs"]:.1f} ms average (limit {a.max_ms})')
                    if perf['cpuMs'] > a.max_cpu:
                        r['problems'].append(f'tunnel frame work {perf["cpuMs"]:.1f} ms average (limit {a.max_cpu})')
                    if perf['compiles']:
                        r['problems'].append(f'{perf["compiles"]} shader(s) compiled while the tunnel ran')
                    progs_open = await cdp.js("__sky.renderer.info.programs.length")
                    # close and count what's left on the GPU
                    await cdp.js("__sky.tunnel.exit(); 1")
                    mem1 = await cdp.js(SETTLE, timeout=30)
                    r['mem'] = {'before': mem0, 'after': mem1}
                    # (the first visit can end lower: the hangar only re-uploads what it still draws)
                    if mem1['geo'] > mem0['geo'] or mem1['tex'] > mem0['tex']:
                        r['problems'].append(f'leak: geometries {mem0["geo"]} -> {mem1["geo"]}, textures {mem0["tex"]} -> {mem1["tex"]}')
                    if first:  # a second visit must not compile anything new
                        first = False
                        await cdp.js("__sky.openTunnel(); 1")
                        await cdp.wait_for('__sky.tunnel && __sky.tunnel.ready', 30, 'the tunnel to reopen')
                        await asyncio.sleep(1.0)
                        progs2 = await cdp.js("__sky.renderer.info.programs.length")
                        await cdp.js("__sky.tunnel.exit(); 1")
                        mem2 = await cdp.js(SETTLE, timeout=30)
                        r['reopen'] = {'programs': [progs_open, progs2], 'mem': mem2}
                        if progs2 > progs_open:
                            r['problems'].append(f'reopening compiled {progs2 - progs_open} new shader programs')
                        if mem2['geo'] != mem1['geo'] or mem2['tex'] != mem1['tex']:  # a second visit: exactly where the first one left it
                            r['problems'].append(f'leak on the second visit: geometries {mem1["geo"]} -> {mem2["geo"]}, textures {mem1["tex"]} -> {mem2["tex"]}')
                    still = await cdp.js("!!__sky.tunnel || !!document.getElementById('tunnel-ui')")
                    if still:
                        r['problems'].append('the tunnel did not close')
                except Exception as e:  # noqa: BLE001
                    r['problems'].append(f'error: {e}')
                    try:
                        await cdp.js("__sky.tunnel && __sky.tunnel.exit(); 1")
                    except Exception:  # noqa: BLE001
                        pass
                r['problems'] += probs.take()
                r['seconds'] = round(time.time() - t0, 1)
                report.append(r)
                bad = len(r['problems']); fails += bad
                p = r.get('perf', {})
                print(f'{"FAIL" if bad else "PASS"}  {name:<12} {r.get("kind", "?"):<6} stall {str(r.get("stallAt")) + "°":<6} peak {str(r.get("peak")):<16} force err {r.get("forceErr", 0):.1e}  '
                      f'frame {p.get("avgMs", 0):5.1f} ms (tunnel {p.get("cpuMs", 0):4.1f} ms, {p.get("lines", 0)} lines)  geo/tex {r.get("mem", {}).get("before", {}).get("geo")}/{r.get("mem", {}).get("before", {}).get("tex")} -> '
                      f'{r.get("mem", {}).get("after", {}).get("geo")}/{r.get("mem", {}).get("after", {}).get("tex")}  {r["seconds"]} s', flush=True)
                for x in r['problems'][:6]:
                    print('      ' + str(x)[:600])
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    print(f'\n{len(report)} vehicles, {fails} problems')
    return 1 if fails or not report else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', help='just this preset (by name)')
    ap.add_argument('--shots', help='save a screenshot of each tunnel here')
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--max-ms', type=float, default=50, help='slowest acceptable average frame time, ms (default 50)')
    ap.add_argument('--max-cpu', type=float, default=12, help='most tunnel work per frame (physics, smoke tracing, readouts), ms (default 12)')
    ap.add_argument('--url', help='check an already running server instead of serving the repo')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    sys.exit(asyncio.run(main(ap.parse_args())))
