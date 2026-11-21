#!/usr/bin/env python3
"""Skywright frame benchmark: CPU cost per frame and draw calls, per location, at a fixed graphics setting.

  python3 tools/test/bench.py [--quality medium] [--locations islands,canyon,nyc,lauterbrunnen] [--cpu-throttle 4]
                              [--preset Kestrel] [--seconds 6] [--json out.json] [--renderer webgl|webgpu]

For each location it flies the preset off the runway at full throttle, lets it settle, then measures over --seconds:
  frame_ms  JavaScript time per frame (every requestAnimationFrame callback: simulation, world streaming, rendering)
  render_ms of which inside renderer.render / the post-processing chain (scene traversal + draw-call submission)
  calls     draw calls per frame (shadow maps and post passes included), tris = triangles per frame
  fps       frames actually delivered (headless Chrome on this machine's GPU, so mostly a CPU number)
--cpu-throttle slows the page's CPU (DevTools emulation) towards a tablet's. The numbers compare runs on one machine;
they are not the tablet's frame rate. Same requirements as smoke.py (Chrome + websockets).
"""
import argparse, asyncio, json, os, shutil, sys, tempfile
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402

# Installed before the game's own scripts: times every animation-frame callback.
HOOK = """(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__bench = { js: 0, frames: 0, on: false };
  window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); try { cb(t); } finally { if (__bench.on) __bench.js += performance.now() - s; } });
})();"""

SETUP = """(() => { const S = __sky, B = __bench, r = S.renderer, info = r.info; info.autoReset = false;
  B.render = 0; B.calls = 0; B.tris = 0;
  const wrap = (o, k) => { const f = o[k]; o[k] = function (...a) { const s = performance.now(); try { return f.apply(this, a); } finally { if (B.on && !B.inner) B.render += performance.now() - s; } }; };
  // the post chain calls renderer.render inside: count only the outermost call
  const wrapOuter = (o, k) => { const f = o[k]; o[k] = function (...a) { const s = performance.now(), was = B.inner; B.inner = true; try { return f.apply(this, a); } finally { B.inner = was; if (B.on && !was) B.render += performance.now() - s; } }; };
  wrapOuter(r, 'render'); if (S.post?.render) wrapOuter(S.post, 'render');
  const tick = () => { if (B.on) { B.calls += info.render.calls; B.tris += info.render.triangles; B.frames++; } info.reset(); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  return true; })()"""


async def bench(cdp, preset, loc, quality, seconds):
    S = '__sky'
    if await cdp.js(f'!!{S}.F'):
        await cdp.js(f'{S}.endFlight()')
    await cdp.wait_for(f"!{S}.F", 30, 'the hangar')
    await cdp.js(f"""(() => {{ {S}.settings.quality = {json.dumps(quality)}; {S}.perf.scale = 1; {S}.perf.level = 0; {S}.applyQuality();
        Object.assign({S}.flightCfg, {{ location: {json.dumps(loc)}, start: 'runway', mode: 'free', online: false, time: 10, weather: 'clear' }});
        {S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(preset)})); {S}.startFlight(); }})()""")
    await cdp.wait_for(f'{S}.F && {S}.F.ac && {S}.F.t > 1', 180, f'the flight at {loc} to start')
    await cdp.js(f'{S}.controls.setThrottle(1)')
    await asyncio.sleep(4)  # take off, let streaming settle
    # hold the graphics still: no adaptive resolution or feature shedding while measuring
    await cdp.js(f'(() => {{ const p = {S}.perf; p.scale = 1; p.level = 0; p.lastChange = 1e15; {S}.applyQuality(); Object.assign(__bench, {{ js: 0, render: 0, calls: 0, tris: 0, frames: 0, on: true }}); }})()')
    await asyncio.sleep(seconds)
    b = await cdp.js('(() => { __bench.on = false; return { ...__bench }; })()')
    await cdp.js(f'{S}.perf.lastChange = 0')
    n = max(1, b['frames'])
    return {'location': loc, 'fps': round(n / seconds, 1), 'frame_ms': round(b['js'] / n, 2), 'render_ms': round(b['render'] / n, 2),
            'calls': round(b['calls'] / n), 'tris': round(b['tris'] / n)}


async def main(a):
    port = a.port or free_port()
    srv = start_server(port)
    profile = tempfile.mkdtemp(prefix='skybench-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, '1280,800')
    origin = f'http://127.0.0.1:{port}'
    rows = []
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', source=HOOK)
            if a.cpu_throttle > 1:
                await cdp.send('Emulation.setCPUThrottlingRate', rate=a.cpu_throttle)
            q = f'?renderer={a.renderer}' if a.renderer else ''
            await cdp.send('Page.navigate', url=f'{origin}/{q}')
            await cdp.wait_for('window.__sky && window.__sky.hangar', 120, 'the app to boot')
            await cdp.js(SETUP)
            for loc in a.locations.split(','):
                r = await bench(cdp, a.preset, loc, a.quality, a.seconds)
                rows.append(r)
                print(f"{r['location']:<15} {r['fps']:6.1f} fps   frame {r['frame_ms']:6.2f} ms   render {r['render_ms']:6.2f} ms   {r['calls']:5d} calls   {r['tris'] / 1e6:5.2f} M tris", flush=True)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True); srv.shutdown()
    if a.json:
        json.dump({'args': vars(a), 'rows': rows}, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--quality', default='medium'), ap.add_argument('--preset', default='Kestrel')
    ap.add_argument('--locations', default='islands,canyon,nyc,lauterbrunnen')
    ap.add_argument('--seconds', type=float, default=6), ap.add_argument('--cpu-throttle', type=float, default=1)
    ap.add_argument('--renderer', default=None), ap.add_argument('--json')
    ap.add_argument('--port', type=int), ap.add_argument('--cdp-port', type=int)
    asyncio.run(main(ap.parse_args()))
