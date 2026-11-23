#!/usr/bin/env python3
"""Skywright smoke test: boot the game in headless Chrome, open its windows, decode its sounds, and tour the places
flying one vehicle of each kind (plane, boat, bike, car, helicopter, rocket) on the real game loop, with no console
errors, no NaN, audible engines, every cockpit view drawn, and no shader compiled mid-flight. The SR-71 flies its
scripted climb to Mach 3 and its landing. Every stock vehicle is also built and driven by the Node suite
tools/test/presets.js, run alongside.

Run from anywhere:  python3 tools/test/smoke.py [--only Kestrel] [--keep] [--quality medium] [--shard 1/2]
--shard I/N runs part I of the tour's legs (CI runs the parts as parallel jobs); every part boots the game and checks
audio, part 1 also opens the windows, takes the hangar shot and runs the Node suite.
Needs Python 3.9+, the `websockets` package (pip install websockets), Chrome/Chromium and Node 22.15+.
Exits non-zero if any step fails. See tools/test/README.md.
"""
import argparse, asyncio, base64, functools, http.server, json, os, platform, shutil, socket, subprocess
import sys, tempfile, threading, time, urllib.parse, urllib.request

try:
    import websockets
except ImportError:
    sys.exit("smoke.py needs the 'websockets' package: pip install websockets")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FLIGHT_SECONDS = 2.0


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def find_chrome():
    env = os.environ.get('CHROME')
    if env:
        return env
    if platform.system() == 'Darwin':
        for p in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                  '/Applications/Chromium.app/Contents/MacOS/Chromium']:
            if os.path.exists(p):
                return p
    for name in ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']:
        p = shutil.which(name)
        if p:
            return p
    sys.exit('Chrome not found: set CHROME=/path/to/chrome')


# ---------- static server ----------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def start_server(port):
    handler = functools.partial(QuietHandler, directory=ROOT)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------- Chrome + CDP ----------
def launch_chrome(cdp_port, profile, size):
    args = [find_chrome(), '--headless=new', f'--remote-debugging-port={cdp_port}', f'--user-data-dir={profile}',
            '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
            '--mute-audio', f'--window-size={size}', '--hide-scrollbars', 'about:blank']
    if platform.system() == 'Linux':
        # CI runners have no GPU (WebGL via SwiftShader) and restrict the sandbox's user namespaces.
        args[1:1] = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{cdp_port}/json', timeout=1))
            pages = [t for t in tabs if t.get('type') == 'page']
            if pages:
                return proc, pages[0]['webSocketDebuggerUrl']
        except Exception:
            pass
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    proc.kill()
    sys.exit(f'Chrome did not start (CDP port {cdp_port})')


class CDP:
    def __init__(self, ws):
        self.ws, self.n, self.pending, self.handlers = ws, 0, {}, []
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if 'id' in m:
                fut = self.pending.pop(m['id'], None)
                if fut and not fut.done():
                    fut.set_result(m)
            else:
                for h in self.handlers:
                    h(m['method'], m.get('params', {}))

    async def send(self, method, _timeout=30, **params):
        self.n += 1
        fut = asyncio.get_event_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        try:
            m = await asyncio.wait_for(fut, _timeout)
        except asyncio.TimeoutError:
            # the page's main thread can be busy for many seconds (world generation on a software GPU)
            raise RuntimeError(f'{method}: no reply in {_timeout:.0f} s (page busy or hung)') from None
        if 'error' in m:
            raise RuntimeError(f"{method}: {m['error'].get('message')}")
        return m.get('result', {})

    async def js(self, expr, timeout=30, gesture=False):
        """Evaluate an expression (awaiting promises) and return its value; page exceptions raise."""
        r = await self.send('Runtime.evaluate', _timeout=timeout + 5, expression=expr, awaitPromise=True,
                            returnByValue=True, userGesture=gesture, timeout=int(timeout * 1000))
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            raise RuntimeError((d.get('exception') or {}).get('description') or d.get('text'))
        return r.get('result', {}).get('value')

    async def wait_for(self, cond, timeout, what):
        """Poll a JS boolean expression until true."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if await self.js(f'!!({cond})', timeout=5):
                    return
            except RuntimeError:
                pass
            await asyncio.sleep(0.1)
        raise AssertionError(f'timed out after {timeout:.0f} s waiting for {what}')

    async def screenshot(self, path):
        r = await self.send('Page.captureScreenshot', format='png')
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))


# ---------- page problems (console errors, exceptions, failed requests) ----------
class Problems:
    def __init__(self, origin):
        self.origin, self.items, self.urls = origin, [], {}

    def on(self, method, p):
        if method == 'Runtime.consoleAPICalled' and p.get('type') in ('error', 'assert'):
            args = ' '.join(str(a.get('value', a.get('description', ''))) for a in p.get('args', []))
            self.items.append(f'console.error: {args}')
        elif method == 'Runtime.exceptionThrown':
            d = p.get('exceptionDetails', {})
            desc = (d.get('exception') or {}).get('description') or d.get('text')
            self.items.append(f'uncaught: {desc} ({d.get("url", "")}:{d.get("lineNumber")})')
        elif method == 'Log.entryAdded':
            e = p.get('entry', {})
            # network-sourced entries duplicate the Network checks below, and include other origins we don't care about
            if e.get('level') == 'error' and e.get('source') != 'network':
                self.items.append(f'log.error: {e.get("text")} {e.get("url", "")}')
        elif method == 'Network.requestWillBeSent':
            self.urls[p['requestId']] = p['request']['url']
        elif method == 'Network.responseReceived':
            r = p.get('response', {})
            if r.get('status', 0) >= 400 and r.get('url', '').startswith(self.origin):
                self.items.append(f'HTTP {r["status"]}: {r["url"][len(self.origin):]}')
        elif method == 'Network.loadingFailed':
            url = self.urls.get(p.get('requestId'), '')
            # canceled = aborted on purpose (a music stream switched off, a page navigation), not broken
            if url.startswith(self.origin) and not p.get('canceled'):
                self.items.append(f'request failed: {url[len(self.origin):]} ({p.get("errorText")})')

    def take(self):
        out, self.items = self.items, []
        return out


# ---------- steps ----------
class Runner:
    def __init__(self, cdp, problems, shots):
        self.cdp, self.problems, self.shots, self.results = cdp, problems, shots, []

    async def step(self, name, coro_fn, timeout=60):
        t0 = time.time()
        self.problems.take()  # problems belong to the step that caused them
        err, detail = None, ''
        try:
            detail = await asyncio.wait_for(coro_fn(), timeout) or ''
        except asyncio.TimeoutError:
            err = f'step timed out after {timeout} s'
        except Exception as e:  # noqa: BLE001 - every failure becomes a FAIL line
            err = str(e) or type(e).__name__
        await asyncio.sleep(0.2)  # let late console events for this step arrive
        probs = self.problems.take()
        ok = err is None and not probs
        dt = time.time() - t0
        self.results.append((name, ok, dt))
        print(f'{"PASS" if ok else "FAIL"}  {name:<34} {dt:5.1f} s  {detail if ok else ""}', flush=True)
        if err:
            print(f'      error: {err}')
        for p in probs[:10]:
            print(f'      {p[:400]}')
        if len(probs) > 10:
            print(f'      ... and {len(probs) - 10} more')
        if not ok:
            try:
                path = os.path.join(self.shots, f'FAIL-{"".join(c if c.isalnum() else "_" for c in name)}.png')
                await self.cdp.screenshot(path)
                print(f'      screenshot: {path}')
            except Exception:
                pass
        return ok


# ---------- the tour ----------
# One vehicle of each kind flown on the real game loop (frames drawn, engines heard: 'fly'), spread over the places, one
# World built per place and the next vehicle swapped into it (__sky.swapVehicle: the World is kept); the start paths no
# tour flight takes (open water, an air start) as quick in-page steps ('quick': stepped with __sky.advance, not drawn).
# Visiting the places in one session is also the shader check (formerly shadercheck.py, #187): no shader program may
# compile mid-flight on a tour flight, so a later place must not compile what an earlier one showed (the crew), and the
# first place, built again at the end, compiles nothing new in flight either.
# Every stock vehicle is built and driven by the Node suite tools/test/presets.js (run alongside, below).
SR71 = 'SR-71 Blackbird'
TOUR = [  # (place, [(step, preset, flight config over smoke.js BASE)])
    ('islands', [('fly', 'Kestrel', {}), ('quick', 'Albatross', {}), ('quick', 'Kite', {}), ('fly', 'Speedboat', {'boatStart': 'marina'})]),
    ('canyon', [('fly', 'Dirt Bike', {'landStart': 'park'}), ('fly', 'Dune Buggy', {'landStart': 'park'})]),
    ('nyc', [('fly', 'Dragonfly', {}), ('fly', 'Rocket', {})]),
    ('islands', [('sr71-climb', SR71, {}), ('sr71-land', SR71, {}), ('fly', 'Dirt Bike', {'landStart': 'park'})]),
]
M = "import('/tools/test/smoke.js')"


def plan(args, names):
    """This run's legs: the tour, or with --only the one step for that preset (a 'fly' at the first place if no leg has
    it; the SR-71: both scripted flights), split --shard ways (leg k to part k mod N)."""
    legs = TOUR
    if args.only:
        legs = [(loc, [s for s in steps if s[1] == args.only]) for loc, steps in TOUR]
        legs = [l for l in legs if l[1]][:1] or [('islands', [('fly', args.only, {})])]
        if args.only == SR71:
            legs = [('islands', [('sr71-climb', SR71, {}), ('sr71-land', SR71, {})])]
    k, n = args.shard
    return [l for i, l in enumerate(legs) if i % n == k - 1]


async def node_presets(only):
    """tools/test/presets.js (every stock vehicle built and driven in Node), started before Chrome boots."""
    cmd = ['node', os.path.join(ROOT, 'tools', 'test', 'node', 'run.mjs'), 'presets'] + (['--only', only] if only else [])
    try:
        return await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, cwd=ROOT)
    except OSError as e:
        return e


async def run(args, url, ws_url, shots):
    origin = url.rstrip('/')
    node = None if args.no_node or args.shard[0] != 1 else await node_presets(args.only)
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        problems = Problems(origin)
        cdp.handlers.append(problems.on)
        shader_warns = []
        cdp.handlers.append(lambda m, p: shader_warns.append(' '.join(str(x.get('value', '')) for x in p.get('args', [])))
                            if m == 'Runtime.consoleAPICalled' and p.get('type') == 'warning' and '[shaders]' in str(p.get('args')) else None)
        for d in ('Page', 'Runtime', 'Log', 'Network'):
            await cdp.send(f'{d}.enable')
        await cdp.send('Network.setCacheDisabled', cacheDisabled=True)
        r = Runner(cdp, problems, shots)
        S = 'window.__sky'

        async def boot():
            await cdp.send('Page.navigate', url=url)
            await cdp.wait_for(f'{S} && {S}.hangar && {S}.presets.length', 30, 'window.__sky')
            await cdp.wait_for("!document.getElementById('splash')", 10, 'the splash to go')
            info = await cdp.js(f'({{ presets: {S}.presets.length, gl: !!{S}.renderer.getContext() }})')
            if not info['gl']:
                raise AssertionError('no WebGL context')
            if args.quality:
                await cdp.js(f'{S}.settings.quality = {json.dumps(args.quality)}')
            return f"{info['presets']} presets"

        if not await r.step('boot', boot):
            return r.results  # nothing else can work

        async def audio():
            index = json.load(open(os.path.join(ROOT, 'assets', 'sfx', 'index.json')))
            await cdp.js(f'{S}.audio.init()', gesture=True)
            await cdp.wait_for(f'{S}.audio.ctx && {S}.audio.ctx.state === "running"', 10, 'the AudioContext to run')
            want = json.dumps(sorted(index))
            try:  # (all decode in ~1 s locally, 10-20 s on a CI runner, longer when its CPU is busy)
                await cdp.wait_for(f'{want}.every((n) => n in {S}.audio.buffers)', 40, 'clips to decode')
            except AssertionError:
                have = await cdp.js(f'Object.keys({S}.audio.buffers)')
                missing = sorted(set(index) - set(have))
                if missing:  # (all there by the time we looked: slow, not broken)
                    raise AssertionError(f'{len(missing)}/{len(index)} clips did not decode: {", ".join(missing[:12])}')
            return f'{len(index)} clips decoded'

        await r.step('audio: init + decode clips', audio)

        async def modal(button, title):
            await cdp.js(f"document.querySelector('{button}').click()", gesture=True)
            await cdp.wait_for("document.getElementById('modal-root').style.display === 'block'", 5, 'the modal to open')
            h2 = await cdp.js("document.querySelector('#modal-root h2')?.textContent")
            if h2 != title:
                raise AssertionError(f'expected a "{title}" modal, got {h2!r}')
            await cdp.js("document.querySelector('#modal-root [data-close]').click()", gesture=True)
            await cdp.wait_for("document.getElementById('modal-root').style.display === 'none'", 5, 'the modal to close')

        async def hangar_shot():
            await asyncio.sleep(0.3)
            await cdp.screenshot(os.path.join(shots, 'hangar.png'))

        if args.shard[0] == 1 and not args.only:
            await r.step('modal: Settings', lambda: modal('#btn-settings', 'Settings'))
            await r.step('modal: Help', lambda: modal('#btn-help', 'How to play'))
            await r.step('screenshot: hangar', hangar_shot)

        names = await cdp.js(f'{S}.presets.map((d) => d.name)')
        if args.only and args.only not in names:
            print(f'FAIL  no preset named {args.only!r}; have: {", ".join(names)}')
            r.results.append((f'preset {args.only}', False, 0))
            return r.results

        async def start(name, loc, cfg):
            s = await cdp.js(f'{M}.then((m) => m.start({json.dumps(name)}, {json.dumps(loc)}, {json.dumps(cfg)}))', timeout=200)
            return s, f"{s['how']} in {s['ms'] / 1000:.1f} s, start {s['start']}"

        shot_taken = False

        async def fly(name, loc, cfg):
            nonlocal shot_taken
            n0 = len(shader_warns)
            s, said = await start(name, loc, cfg)
            f = await cdp.js(f'{M}.then((m) => m.fly({args.flight_seconds}, 3))', timeout=120)
            if not shot_taken:
                await cdp.screenshot(os.path.join(shots, f'flight-{name}.png')); shot_taken = True
            e, ride = f['end'], f['ride']
            if e is None or ride is None:
                raise AssertionError('the flight ended on its own')
            if not (ride['pos'] and ride['vel'] and e['pos'] and e['vel']):
                raise AssertionError(f'non-finite position/velocity: {ride} / {e}')
            if not e['parts']:
                raise AssertionError('the vehicle has no parts')
            if f['ran'] <= 0 or f['ran'] < f['wall'] * args.min_realtime:
                raise AssertionError(f"frame loop stalled: flight clock moved {f['ran']:.2f} s in {f['wall']:.1f} s")
            if s['kind'] == 'bike' or name in ('Dirt Bike', 'Sport Bike'):
                if ride['up'] < 0.7:
                    raise AssertionError(f"the bike fell over (up {ride['up']:.2f})")
                if ride['speed'] < 3:
                    raise AssertionError(f"the bike didn't ride off ({ride['speed']:.1f} m/s)")
            m = f['motor']
            if m and m['gain'] < 0.01 and not f['stalled']:
                raise AssertionError(f"its {m['kind']} engine is silent at full throttle")
            if not f['leftCockpit']:
                raise AssertionError(f"the camera button did not leave the cockpit after every seat ({', '.join(f['names'])})")
            if f['compiles']:
                raise AssertionError(f"{f['compiles']} shader programs compiled mid-flight: {'; '.join(shader_warns[n0:])[:600]}")
            note = ' (audio clock stalled: engine sound not checked)' if m and f['stalled'] else ''
            return (f"{said}; {ride['speed']:.0f} m/s, alt {ride['alt']:.0f} m, {e['alive']}/{e['parts']} parts, {f['ran'] / f['wall'] * 100:.0f}% realtime, "
                    f"{f['views']} cockpit view(s)" + (f", engine {m['gain']:.2f}" if m else '') + note)

        async def quick(name, loc, cfg):
            s, said = await start(name, loc, cfg)
            q = await cdp.js(f'{M}.then((m) => m.quick(2))')
            if q is None:
                raise AssertionError('the flight ended on its own')
            if not q['pos'] or not q['vel']:
                raise AssertionError(f'non-finite position/velocity: {q}')
            return f"{said}; after 2 s {q['speed']:.0f} m/s, alt {q['alt']:.0f} m, {q['alive']}/{q['parts']} parts"

        for loc, steps in plan(args, names):
            for kind, name, cfg in steps:
                if kind == 'fly':
                    await r.step(f'{loc}: fly {name}', lambda n=name, c=cfg: fly(n, loc, c), timeout=240)
                elif kind == 'quick':
                    await r.step(f'{loc}: start {name}', lambda n=name, c=cfg: quick(n, loc, c), timeout=240)
                elif kind == 'sr71-climb':
                    await r.step('SR-71: Mach 2.5+ above 60k ft', lambda: sr71_climb(cdp, shots, loc), timeout=420)
                elif kind == 'sr71-land':
                    await r.step('SR-71: land from the approach', lambda: sr71_land(cdp, shots, loc), timeout=300)

        async def to_hangar():
            if not await cdp.js(f'!!{S}.F'):
                return 'no flight'
            await cdp.js(f'{S}.endFlight(); 1')
            await cdp.wait_for(f"!{S}.F && document.getElementById('hangar-ui').style.display === ''", 30, 'the hangar')  # (up to ~14 s on a CI runner)
            return 'the flight ended cleanly'

        await r.step('back to the hangar', to_hangar, timeout=60)

        if node:
            async def presets():
                if isinstance(node, Exception):
                    raise AssertionError(f'could not run node: {node}')
                out = (await node.communicate())[0].decode(errors='replace').splitlines()
                for line in out:
                    if line.startswith('FAIL'):
                        print(f'      {line}')
                if node.returncode:
                    raise AssertionError(f'tools/test/presets.js failed: {out[-1] if out else "no output"}')
                return (out[-1] if out else '').replace('PASS  ', '')
            await r.step('every preset built and driven (Node)', presets, timeout=180)
        return r.results


# ---------- the SR-71's scripted flights (tools/test/sr71flight.js) ----------
# The game starts the flight as a player would (runway or approach start, Pilot mode, the real world), then the game loop
# is paused and an autopilot flies the aircraft headless through Aircraft.step, much faster than real time.
MACH_MIN, ALT_MIN_FT = 2.5, 60000


async def sr71_start(cdp, cfg, loc):
    S = 'window.__sky'
    await cdp.js(f'{M}.then((m) => m.start({json.dumps(SR71)}, {json.dumps(loc)}, {json.dumps(cfg)}))', timeout=200)
    await cdp.js(f'{S}.advance(0.5); 1')  # (settled half a second)
    await cdp.js(f'(async () => {{ {S}.F.paused = true; {S}.F.eng.on = true; {S}.F.ac.engineRunning = true; window.__srMod = await import("/tools/test/sr71flight.js"); return 1; }})()')


async def sr71_run(cdp, start_gen, limit_s):
    """Drive a generator from sr71flight.js to its end (each next() flies a chunk), return the states."""
    await cdp.js(start_gen)
    states, t0 = [], time.time()
    while time.time() - t0 < limit_s:
        st = await cdp.js('(() => { const r = window.__srGen.next(); return r.done ? null : r.value; })()', timeout=120)
        if st is None:
            break
        states.append(st)
        if st.get('dead') or st.get('wrecked'):
            break
    return states


async def sr71_show(cdp, path, seconds):
    """Let the real game loop run (rendering, sonic effects) for a moment at full throttle and take a picture."""
    S = 'window.__sky'
    await cdp.js(f'{S}.controls.setThrottle(1); {S}.F.eng.on = true; {S}.F.paused = false; {S}.rig.set("chase"); 1')
    await asyncio.sleep(seconds)
    await cdp.screenshot(path)
    await cdp.js(f'{S}.F.paused = true; 1')


async def sr71_climb(cdp, shots, loc):
    S = 'window.__sky'
    await sr71_start(cdp, {'realism': 'pilot', 'start': 'runway', 'mode': 'free'}, loc)
    states = await sr71_run(cdp, f'window.__srGen = window.__srMod.climb({S}.F.ac, {S}.F.env, {{ ground: {S}.F.world.loc.rwyH, chunk: 60, maxTime: 1200 }}); 1', 300)
    if not states:
        raise AssertionError('the scripted flight did not run')
    last = states[-1]
    for st in states:
        for m in st.get('msgs', []):
            if 'broke' in m or 'snapped' in m or 'collapsed' in m:
                raise AssertionError(f'something broke: {m}')
    if last['dead'] or last['wrecked'] or last['alive'] < last['parts']:
        raise AssertionError(f"it broke up: {last['alive']}/{last['parts']} parts at {last['altFt']} ft, Mach {last['mach']}")
    if last['best60'] < MACH_MIN:
        raise AssertionError(f"only Mach {last['best60']:.2f} above {ALT_MIN_FT} ft (best Mach {last['best']['mach']:.2f} at {last['best']['alt'] / 0.3048:.0f} ft)")
    await sr71_show(cdp, os.path.join(shots, 'sr71-mach3.png'), 2.5)
    lo = last['liftoff'] or {}
    return (f"lift-off {lo.get('V')} m/s after a {last['roll']} m roll; Mach {last['best60']:.2f} above {ALT_MIN_FT} ft "
            f"(now Mach {last['mach']:.2f} at {last['altFt']} ft, {last['t']:.0f} s), skin {last['skinC']} C, {last['alive']}/{last['parts']} parts")


async def sr71_land(cdp, shots, loc):
    S = 'window.__sky'
    await sr71_start(cdp, {'realism': 'pilot', 'mode': 'landing'}, loc)
    rwy = f'''(() => {{ const F = {S}.F, m = F.mission, w = F.world, L = w.runway.len; return {{ x: m.rwyX, h: w.loc.rwyH, s: m.side, aimZ: m.side * (L / 2 - 380), len: L, width: w.runway.width }}; }})()'''
    v_app = f'Math.min(110, Math.max(32, {S}.analyze({S}.F.ac.design).stall * 1.45))'
    states = await sr71_run(cdp, f'window.__srGen = window.__srMod.land({S}.F.ac, {S}.F.env, {rwy}, {{ chunk: 4, vApp: {v_app} }}); 1', 200)
    if not states:
        raise AssertionError('the scripted landing did not run')
    last, td = states[-1], states[-1].get('td')
    if last['dead'] or last['wrecked'] or last['alive'] < last['parts']:
        msgs = [m for st in states for m in st.get('msgs', [])]
        raise AssertionError(f"it broke: {last['alive']}/{last['parts']} parts, touchdown {td}; {'; '.join(msgs[-6:])}; track {[(st['t'], st['alt'], st['V'], st['vs'], st['phase']) for st in states]}")
    if not td:
        raise AssertionError(f"never touched down ({last['altFt']} ft, {last['V']} m/s)")
    if not last.get('stopped') or not last.get('onRwy'):
        raise AssertionError(f"did not stop on the runway: touchdown {td}, now at x {last['x']} z {last['z']}, {last['V']} m/s")
    await cdp.screenshot(os.path.join(shots, 'sr71-landed.png'))
    return f"touchdown {td['vs']} m/s down at {td['V']} m/s, {td['x']} m off the centreline; stopped on the runway"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', metavar='NAME', help='fly just this preset (e.g. Kestrel)')
    ap.add_argument('--keep', action='store_true', help='keep the screenshots (printed path)')
    ap.add_argument('--out', metavar='DIR', help='screenshot directory (implies --keep)')
    ap.add_argument('--port', type=int, default=0, help='static server port (default: a free one)')
    ap.add_argument('--cdp-port', type=int, default=0, help='Chrome debugging port (default: a free one)')
    ap.add_argument('--quality', choices=['auto', 'low', 'medium', 'high', 'ultra'],
                    help="graphics setting for the flights (CI uses 'low': software WebGL is slow)")
    ap.add_argument('--min-realtime', type=float, default=0.25, metavar='R',
                    help='fail a flight if its clock runs slower than R x realtime (default 0.25; 0 = any frame '
                         'at all, for CI where software WebGL draws about one flight frame every few seconds)')
    ap.add_argument('--size', default='1280x800', help='window size WxH')
    ap.add_argument('--shard', default='1/1', metavar='I/N', help='run part I of N (the flights split N ways; CI runs the parts in parallel)')
    ap.add_argument('--jobs', type=int, default=1, metavar='N', help='run all N parts at once, each in its own browser, and report them together')
    ap.add_argument('--flight-seconds', type=float, default=FLIGHT_SECONDS, metavar='S', help=f'wall seconds each tour flight flies on the real game loop (default {FLIGHT_SECONDS})')
    ap.add_argument('--no-node', action='store_true', help="don't run the Node suite tools/test/presets.js alongside (run.py runs it itself)")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # keep step lines in order when piped (CI logs)
    try:
        args.shard = tuple(int(x) for x in args.shard.split('/'))
        assert len(args.shard) == 2 and 1 <= args.shard[0] <= args.shard[1]
    except (ValueError, AssertionError):
        ap.error('--shard wants I/N, e.g. 2/4')
    if args.jobs > 1:
        sys.exit(run_jobs(args))

    port, cdp_port = args.port or free_port(), args.cdp_port or free_port()
    shots = os.path.abspath(args.out) if args.out else tempfile.mkdtemp(prefix='skywright-smoke-')
    os.makedirs(shots, exist_ok=True)
    profile = tempfile.mkdtemp(prefix='skywright-chrome-')
    srv = start_server(port)
    url = f'http://127.0.0.1:{port}/'
    proc, ws_url = launch_chrome(cdp_port, profile, args.size.replace('x', ','))
    print(f'Skywright smoke test: {url} (Chrome CDP {cdp_port})', flush=True)
    t0 = time.time()
    try:
        results = asyncio.run(run(args, url, ws_url, shots))
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    failed = [n for n, ok, _ in results if not ok]
    total = time.time() - t0
    print('-' * 60)
    if failed:
        print(f'FAIL  {len(failed)} of {len(results)} steps failed in {total:.0f} s: {", ".join(failed)}')
    else:
        print(f'PASS  all {len(results)} steps in {total:.0f} s')
    if args.keep or args.out or failed:
        print(f'screenshots: {shots}')
    else:
        shutil.rmtree(shots, ignore_errors=True)
    sys.exit(1 if failed else 0)


def run_jobs(args):
    """--jobs N: every part in its own smoke.py (own server, browser and screenshot folder), the outputs printed in
    order once all are done."""
    t0, n, procs = time.time(), args.jobs, []
    rest, skip = [], False
    for a in sys.argv[1:]:  # (the same options, minus --jobs and --shard)
        if skip: skip = False; continue
        if a in ('--jobs', '--shard'): skip = True; continue
        if not a.startswith(('--jobs=', '--shard=')): rest.append(a)
    for k in range(1, n + 1):
        cmd = [sys.executable, os.path.abspath(__file__), *rest, '--shard', f'{k}/{n}']
        if args.out:
            cmd += ['--out', os.path.join(os.path.abspath(args.out), f'part{k}')]
        procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
    bad = 0
    for k, p in enumerate(procs, 1):
        out, _ = p.communicate()
        print(f'===== part {k}/{n}' + ('' if p.returncode == 0 else '  (FAILED)'))
        print(out.rstrip())
        bad += p.returncode != 0
    print('=' * 60)
    print(f"{'FAIL' if bad else 'PASS'}  {n - bad}/{n} parts passed in {time.time() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == '__main__':
    main()
