#!/usr/bin/env python3
"""The baked layout's startup and streaming (#294, ?layout=1), measured in the browser: one Chrome, each version given
(a query, e.g. "?layout=1", or "_main/?layout=1" for main's copy served under the root, as goto.py), each place:

  - a car's street start ('road'): start pressed -> flying (load_s), and when the start's ring of chunks (fine within
    900 m) was meshed, from start pressed (ring_s);
  - then (--fly s) the camera flown at --speed m/s, --alt m up, round a circle about the start that takes the flight's
    time, the flight paused and the world stepped from the camera (as goto.py): the most fine meshes waiting within
    900 m (backlog), the most chunks within 900 m not drawn fine 2 s after they came in range (late), and the main
    thread's layout work (Layout update / got / pump, outermost calls): the longest, and how many over 50 ms.

  python3 tools/test/layoutload.py --versions "_main/?layout=1" "?layout=1" --places nyc lauterbrunnen --fly 60 --tier low
Same requirements as smoke.py. Prints one JSON line per run; the load average with each.
"""
import argparse, asyncio, json, os, sys, tempfile, shutil, time
import websockets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server, launch_chrome, CDP  # noqa: E402

S = 'window.__sky'

# (in the page: the layout's calls timed, outermost only, and its chunks sampled each frame: works on any version's Layout)
PROBE = r"""(() => { const L = __sky.F.world.layout; if (!L || L.__probe) return !!L; const P = (L.__probe = { calls: [], depth: 0, backlog: 0, late: 0, lateFrames: 0, frames: 0, nearT: new Map() });
  for (const f of ['update', 'got', 'pump']) { const o = L[f]; L[f] = function (...a) { const t0 = performance.now(); P.depth++; try { return o.apply(this, a); } finally { if (--P.depth === 0 && P.on) { const ms = performance.now() - t0; P.calls.push(ms); if (ms > 40) (P.slow ||= []).push(f + ' ' + Math.round(ms)); } } }; }
  P.sample = () => { const x = L.cam.x, z = L.cam.z, S = L.size, F = 900, t = performance.now(); let back = 0, late = 0; P.frames++;
    for (const e of L.queue.values()) { const [c, level] = e; if (level === 'fine' && Math.hypot(c.cx - x, c.cz - z) < F) back++; }
    const seen = new Set(), r = Math.ceil(F / S);
    for (let i = Math.floor(x / S) - r; i <= Math.floor(x / S) + r; i++) for (let j = Math.floor(z / S) - r; j <= Math.floor(z / S) + r; j++) { const k = i + ',' + j; if (!L.index.has(k) || Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) >= F) continue;
      seen.add(k); if (!P.nearT.has(k)) P.nearT.set(k, t); if (L.chunks.get(k)?.shown !== 'fine' && t - P.nearT.get(k) > 2000) late++; }
    for (const k of P.nearT.keys()) if (!seen.has(k)) P.nearT.delete(k);
    P.backlog = Math.max(P.backlog, back); P.late = Math.max(P.late, late); if (late) P.lateFrames++; };
  return true; })()"""

FLY = r"""((secs, speed, alt) => new Promise((done) => { const F = __sky.F, W = F.world, cam = __sky.rig.cam, L = W.layout, P = L.__probe; F.paused = true;
  const c0 = [cam.position.x, cam.position.z], R = speed * secs / (2 * Math.PI), cx = c0[0] - R, cz = c0[1], g0 = W.heightAt(c0[0], c0[1]);
  let lt = 0; const lo = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) lt++; }); try { lo.observe({ type: 'longtask' }); } catch {}
  const t0 = performance.now(); let last = t0; P.on = true;
  const step = () => { const t = performance.now(), dt = Math.min(0.1, (t - last) / 1000); last = t; const a = ((t - t0) / 1000) * speed / R, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
    cam.position.set(x, g0 + alt, z); cam.up.set(0, 1, 0); cam.lookAt(x - Math.sin(a) * 400, g0 + alt - 120, z + Math.cos(a) * 400); cam.updateMatrixWorld();
    W.update(dt, cam, cam.position.clone().set(0, 0, 0), []); W.towns?.update(dt, W.t, null, cam.position); W.flora?.update?.(cam.position); P.sample();
    if (t - t0 < secs * 1000) requestAnimationFrame(step); else { P.on = false; lo.disconnect(); const cs = P.calls, own = L.stats || {};
      done({ frames: P.frames, fps: Math.round(P.frames / secs), backlog: P.backlog, late: P.late, lateFrames: P.lateFrames, layoutMaxMs: Math.round(Math.max(0, ...cs)), layoutOver50: cs.filter((v) => v > 50).length, longtasksAll: lt, pool: own.pool ?? 1, slow: P.slow || [], own: own.firstViewMs !== undefined ? { mainMax: Math.round(own.mainMax), long: own.long, backlog: own.backlog, coarseNear: own.coarseNear } : null }); } };
  requestAnimationFrame(step); }))"""


async def main(a):
    port = free_port(); srv = start_server(port); origin = f'http://127.0.0.1:{port}'
    profile = tempfile.mkdtemp(prefix='skylay-'); proc, ws_url = launch_chrome(free_port(), profile, a.size.replace('x', ','))
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws); await cdp.send('Runtime.enable')
            for q in a.versions:
                for loc in a.places:
                    await cdp.send('Page.navigate', url=origin + '/' + (q if '?' in q and not q.startswith('?') else q))
                    await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 60, 'boot')
                    await cdp.wait_for("!document.getElementById('splash')", 30, 'splash')
                    cfg = {'location': loc, 'online': False, 'mode': 'free', 'landStart': 'road'}
                    name = await cdp.js(f"""(() => {{ Object.assign({S}.flightCfg, {json.dumps(cfg)}); {S}.settings.quality = {json.dumps(a.tier)};
                        const d = {S}.presets.find((p) => p.name === 'Dune Buggy'); {S}.hangar.load(d); window.__tGo = performance.now(); {S}.startFlight(); return d.name; }})()""")
                    t_go = time.time()
                    await cdp.wait_for(f'{S}.F && {S}.F.t > 0.5 && !{S}.F.warm', 240, 'flight')
                    load_s = time.time() - t_go
                    st = None
                    for _ in range(100):
                        st = await cdp.js(f"(() => {{ const s = {S}.F.world.layout?.stats; return s ? {{ ring: s.ring.length, ringS: s.firstRingMs == null ? null : (s.t0 + s.firstRingMs - window.__tGo) / 1000, firstRingMs: s.firstRingMs, firstViewMs: s.firstViewMs, loadMainMax: s.loadMainMax, meshed: s.meshed }} : null; }})()")
                        if not st or st.get('firstRingMs') is not None: break
                        await asyncio.sleep(0.2)
                    out = {'version': q, 'location': loc, 'vehicle': name, 'tier': a.tier, 'load_avg': round(os.getloadavg()[0], 1), 'load_s': round(load_s, 2), 'layout': st}
                    if a.fly and loc == a.fly_place and await cdp.js(PROBE):
                        out['flight'] = await cdp.js(f'{FLY}({a.fly}, {a.speed}, {a.alt})', timeout=a.fly + 120)
                        out['flight']['load_avg'] = round(os.getloadavg()[0], 1)
                    print(json.dumps(out), flush=True)
    finally:
        proc.kill(); srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--versions', nargs='+', default=['?layout=1']); ap.add_argument('--places', nargs='+', default=['nyc', 'lauterbrunnen'])
    ap.add_argument('--tier', default='low'); ap.add_argument('--fly', type=float, default=0, help='seconds of flight after the start (at --fly-place)')
    ap.add_argument('--fly-place', default='nyc'); ap.add_argument('--speed', type=float, default=250); ap.add_argument('--alt', type=float, default=500); ap.add_argument('--size', default='1280x720')
    asyncio.run(main(ap.parse_args()))
