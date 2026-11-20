#!/usr/bin/env python3
"""Skywright smoke test: boot the game in headless Chrome and fly every preset.

Run from anywhere:  python3 tools/test/smoke.py [--only Kestrel] [--keep] [--port 8774]
Needs Python 3.9+, the `websockets` package (pip install websockets) and Chrome/Chromium.
Exits non-zero if any step fails. See tools/test/README.md.
"""
import argparse, asyncio, base64, functools, http.server, json, os, platform, shutil, socket, subprocess
import sys, tempfile, threading, time, urllib.parse, urllib.request

try:
    import websockets
except ImportError:
    sys.exit("smoke.py needs the 'websockets' package: pip install websockets")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FLIGHT_SECONDS = 4.0


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


async def run(args, url, ws_url, shots):
    origin = url.rstrip('/')
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        problems = Problems(origin)
        cdp.handlers.append(problems.on)
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
            try:
                await cdp.wait_for(f'{want}.every((n) => n in {S}.audio.buffers)', 20, 'clips to decode')  # all decode in ~1 s locally
            except AssertionError:
                have = await cdp.js(f'Object.keys({S}.audio.buffers)')
                missing = sorted(set(index) - set(have))
                raise AssertionError(f'{len(missing)}/{len(index)} clips did not decode: {", ".join(missing[:12])}')
            return f'{len(index)} clips decoded'

        await r.step('audio: init + decode clips', audio)

        async def modal(button, title):
            await cdp.js(f"document.querySelector('{button}').click()", gesture=True)
            await cdp.wait_for("document.getElementById('modal-root').style.display === 'block'", 5, 'the modal to open')
            h2 = await cdp.js("document.querySelector('#modal-root h2')?.textContent")
            if h2 != title:
                raise AssertionError(f'expected a "{title}" modal, got {h2!r}')
            await asyncio.sleep(0.3)
            await cdp.js("document.querySelector('#modal-root [data-close]').click()", gesture=True)
            await cdp.wait_for("document.getElementById('modal-root').style.display === 'none'", 5, 'the modal to close')

        await r.step('modal: Settings', lambda: modal('#btn-settings', 'Settings'))
        await r.step('modal: Help', lambda: modal('#btn-help', 'How to play'))

        async def hangar_shot():
            await asyncio.sleep(0.5)
            await cdp.screenshot(os.path.join(shots, 'hangar.png'))

        await r.step('screenshot: hangar', hangar_shot)

        names = await cdp.js(f'{S}.presets.map((d) => d.name)')
        if args.only:
            if args.only not in names:
                print(f'FAIL  no preset named {args.only!r}; have: {", ".join(names)}')
                r.results.append((f'preset {args.only}', False, 0))
                return r.results
            names = [args.only]

        for i, name in enumerate(names):
            async def fly(name=name, shoot=(i == 0)):
                # a previous step that failed mid-flight may have left its flight running: never measure that one
                if await cdp.js(f'!!{S}.F'):
                    await cdp.js(f'{S}.endFlight()')
                await cdp.wait_for(f"!{S}.F && document.getElementById('hangar-ui').style.display === ''", 30, 'the hangar')
                await cdp.js(f'{S}.hangar.load({S}.presets.find((d) => d.name === {json.dumps(name)})); {S}.startFlight()')
                await cdp.wait_for(f'{S}.F && {S}.F.ac && {S}.F.t > 0', 90, 'the flight to start')
                await cdp.js(f'{S}.controls.setThrottle(1)')
                bike = await cdp.js(f'!!{S}.F.ac.isBike')
                if bike:  # a motorbike rides off on the gas (W) and must still be on its wheels at the end
                    await cdp.js(f"{S}.controls.keys.add('w')")
                t0, w0 = await cdp.js(f'{S}.F.t'), time.time()
                await asyncio.sleep(FLIGHT_SECONDS)
                if shoot:
                    await cdp.screenshot(os.path.join(shots, f'flight-{name}.png'))
                s = await cdp.js(f"""(() => {{ const F = {S}.F; if (!F) return null; const a = F.ac;
                    const n = (v) => [v.x, v.y, v.z].every(Number.isFinite);
                    return {{ t: F.t, pos: n(a.x), vel: n(a.v), alive: a.parts.filter((p) => p.alive).length,
                             parts: a.parts.length, speed: a.v.length(), alt: a.x.y, thr: {S}.controls.throttle, up: a.up.y }}; }})()""")
                if bike:
                    await cdp.js(f"{S}.controls.keys.delete('w')")
                wall = time.time() - w0
                if s is None:
                    raise AssertionError('the flight ended on its own')
                if not s['pos'] or not s['vel']:
                    raise AssertionError(f'non-finite position/velocity: {s}')
                if not s['parts']:
                    raise AssertionError('the plane has no parts')
                ran = s['t'] - t0
                if bike and s['up'] < 0.7:
                    raise AssertionError(f"the bike fell over (up {s['up']:.2f})")
                if bike and s['speed'] < 3 and ran > 2:
                    raise AssertionError(f"the bike didn't ride off ({s['speed']:.1f} m/s)")
                if ran <= 0 or ran < wall * args.min_realtime:
                    raise AssertionError(f'frame loop stalled: flight clock moved {ran:.2f} s in {wall:.1f} s')
                await cdp.js(f'{S}.endFlight()')
                await cdp.wait_for(f"!{S}.F && document.getElementById('hangar-ui').style.display === ''", 10, 'the hangar')
                return (f"{s['speed']:.0f} m/s, alt {s['alt']:.0f} m, {s['alive']}/{s['parts']} parts, "
                        f"{ran / wall * 100:.0f}% realtime")
            await r.step(f'fly: {name}', fly, timeout=150)
        return r.results


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
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # keep step lines in order when piped (CI logs)

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


if __name__ == '__main__':
    main()
