#!/usr/bin/env python3
"""Skywright browser jobs (#278): one headless Chrome per job, booted once, running tools/test/jobs/<job>.js in the
page against flights in a shared World (each map built once per job, each vehicle swapped in once).

  python3 tools/test/jobs.py                         # every job, in parallel (one Chrome each)
  python3 tools/test/jobs.py nyc                     # one job
  python3 tools/test/jobs.py hangar islands --quality low --keep
  python3 tools/test/jobs.py nyc --quality low --ci  # as CI runs it (one matrix entry per job)

Jobs: hangar (boot, audio, modals, hangar shot, wind tunnel), nyc, islands, canyon-lauterbrunnen. The in-page side,
and the API a job uses (T.step, T.check, T.start, T.advance, T.frames, ...), is tools/test/jobs/harness.js.

Each step prints PASS/FAIL with its wall time, the frames drawn and the game seconds stepped in it. A step fails if
its code throws or a check in it fails, if it compiles a shader mid-flight (a stall), or if the page logs a console
error, throws, or a request for a file of ours fails while it runs. No step waits for wall-clock time: waits are on
game states or frame counts, with safety timeouts that fail loudly (the page-side one names what it waited for; if the
page stops answering altogether this side gives up on it too). Exits non-zero on any failure.
Geodata tiles come from tools/test/fixtures/geo, never the outside network (--geo; see GeoTiles).
Needs Python 3.9+, the `websockets` package (pip install websockets) and Chrome/Chromium. See tools/test/README.md.
"""
import argparse, asyncio, base64, json, os, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request

import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import CDP, Problems, free_port, start_server, launch_chrome  # noqa: E402

JOBS = ['hangar', 'nyc', 'islands', 'canyon-lauterbrunnen']
TAG = '\u0001T'
S = 'window.__sky'
GRACE = 120  # s past a step's own (page-side) safety timeout before this side calls the page hung
GEO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'geo')
# src/geostream.js's two tile hosts: Terrarium heights (z/x/y.png) and EOX Sentinel-2 imagery (z/y/x.jpg)
GEO_URLS = [(re.compile(r'^https://s3\.amazonaws\.com/elevation-tiles-prod/terrarium/(\d+)/(\d+)/(\d+)\.png$'), 'png', False),
            (re.compile(r'^https://tiles\.maps\.eox\.at/wmts/1\.0\.0/s2cloudless_3857/default/g/(\d+)/(\d+)/(\d+)\.jpg$'), 'jpg', True)]
GEO_PATTERNS = ['https://s3.amazonaws.com/elevation-tiles-prod/*', 'https://tiles.maps.eox.at/*']


class GeoTiles:
    """Serves geostream.js's tile requests (made from its Web Worker; a page-level Fetch.enable sees those too) from
    tools/test/fixtures/geo/<z>/<x>/<y>.png|jpg, so no job touches the outside network for geodata. A tile not in the
    set gets a 404, which the game handles as offline (the next coarser level, then the baked edge colour). mode:
    'fixtures' (default), 'record' (fixtures, else the real host, saving what it returns), 'net' (no interception)."""

    def __init__(self, cdp, mode):
        self.cdp, self.mode = cdp, mode
        self.served, self.fetched, self.missed = 0, 0, {}  # missed: fixture path -> times

    async def enable(self):
        if self.mode == 'net':
            return
        self.cdp.handlers.append(self.on)
        await self.cdp.send('Fetch.enable', patterns=[{'urlPattern': u, 'requestStage': 'Request'} for u in GEO_PATTERNS])

    @staticmethod
    def path_of(url):
        for rx, ext, yx in GEO_URLS:
            m = rx.match(url)
            if m:
                z, a, b = m.groups()
                x, y = (b, a) if yx else (a, b)
                return os.path.join(GEO_DIR, z, x, f'{y}.{ext}'), ext
        return None, None

    def on(self, method, p):
        if method == 'Fetch.requestPaused':
            asyncio.ensure_future(self.answer(p['requestId'], p['request']['url']))

    async def answer(self, rid, url):
        path, ext = self.path_of(url)
        body = None
        if path and os.path.exists(path):
            with open(path, 'rb') as f:
                body = f.read()
            self.served += 1
        elif path and self.mode == 'record':
            body = await asyncio.get_event_loop().run_in_executor(None, self.download, url, path)
            if body is not None:
                self.fetched += 1
        if body is None:
            key = os.path.relpath(path, GEO_DIR) if path else url
            self.missed[key] = self.missed.get(key, 0) + 1
        hdrs = [{'name': 'Access-Control-Allow-Origin', 'value': '*'}]  # (the worker fetches with mode: 'cors')
        try:
            if body is None:
                await self.cdp.send('Fetch.fulfillRequest', requestId=rid, responseCode=404, responseHeaders=hdrs, body='')
            else:
                png = body[:4] == b'\x89PNG'  # (EOX answers some empty-sea .jpg tiles with a PNG)
                hdrs.append({'name': 'Content-Type', 'value': 'image/png' if png else 'image/jpeg'})
                await self.cdp.send('Fetch.fulfillRequest', requestId=rid, responseCode=200, responseHeaders=hdrs, body=base64.b64encode(body).decode())
        except Exception:  # noqa: BLE001 - the page went away / navigated: nothing waits for this answer
            pass

    @staticmethod
    def download(url, path):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'skywright-tests'}), timeout=30) as r:
                body = r.read()
        except Exception:  # noqa: BLE001 - a host error is recorded as a miss
            return None
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(body)
        return body

    def summary(self):
        if self.mode == 'net':
            return 'geodata: real network (--geo net)'
        n = sum(self.missed.values())
        s = f'geodata: {self.served} served from fixtures' + (f', {self.fetched} recorded from the hosts' if self.mode == 'record' else '') + f', {n} fell back (404, {len(self.missed)} tiles)'
        if self.missed:
            s += ': ' + ' '.join(sorted(self.missed)[:12]) + (' ...' if len(self.missed) > 12 else '')
        return s


def clean(name):
    return ''.join(c if c.isalnum() or c in '-_' else '_' for c in name)[:80]


class Job:
    """One job in one Chrome: boot, run the job module, print its steps as their events arrive."""

    def __init__(self, args, job, url, ws_url, shots):
        self.a, self.job, self.url, self.ws_url, self.shots = args, job, url, ws_url, shots
        self.results = []  # (name, ok, seconds)
        self.events = None  # (made in run(): a Queue binds to the running loop on Python 3.9)
        self.cur = None  # the step running: {'name', 'timeout', 't0'}
        self.geo = None

    def on_console(self, method, p):
        if method != 'Runtime.consoleAPICalled' or p.get('type') != 'debug':
            return
        a = p.get('args') or []
        v = a[0].get('value') if a else None
        if isinstance(v, str) and v.startswith(TAG):
            try:
                self.events.put_nowait(json.loads(v[len(TAG):]))
            except ValueError:
                pass

    def line(self, ok, name, secs, frames=None, stepped=None, detail=''):
        extra = '' if frames is None else f' {frames:4d} fr {stepped:6.1f} s game'
        print(f'{"PASS" if ok else "FAIL"}  {name:<46} {secs:6.1f} s{extra}  {detail if ok else ""}'.rstrip(), flush=True)

    async def fail_shot(self, name):
        try:
            path = os.path.join(self.shots, f'FAIL-{self.job}-{clean(name)}.png')
            await self.cdp.screenshot(path)
            print(f'      screenshot: {path}', flush=True)
        except Exception:  # noqa: BLE001
            pass

    def problems_lines(self, probs):
        for p in probs[:10]:
            print(f'      {p[:400]}', flush=True)
        if len(probs) > 10:
            print(f'      ... and {len(probs) - 10} more', flush=True)

    async def boot(self):
        cdp = self.cdp
        await cdp.send('Page.navigate', url=self.url)
        t = 240 if self.a.ci else 90
        await cdp.wait_for(f"{S} && {S}.hangar && {S}.presets.length && !document.getElementById('splash')", t, 'the game to boot (window.__sky, splash gone)')
        info = await cdp.js(f'({{ presets: {S}.presets.length, gl: !!{S}.renderer.getContext() }})')
        if not info['gl']:
            raise AssertionError('no WebGL context')
        if self.a.quality:
            await cdp.js(f'{S}.settings.quality = {json.dumps(self.a.quality)}; {S}.applyQuality(); 1')
        return f"{info['presets']} presets, quality {self.a.quality or 'as saved'}"

    async def run(self):
        self.events = asyncio.Queue()
        async with websockets.connect(self.ws_url, max_size=None, ping_interval=None) as ws:
            self.cdp = cdp = CDP(ws)
            self.probs = probs = Problems(self.url.rstrip('/'))
            cdp.handlers.append(probs.on)
            cdp.handlers.append(self.on_console)
            for d in ('Page', 'Runtime', 'Log', 'Network'):
                await cdp.send(f'{d}.enable')
            self.geo = GeoTiles(cdp, self.a.geo)
            await self.geo.enable()
            # boot: this side's own step (the page has no harness until it is up)
            t0 = time.time()
            try:
                detail, err = await self.boot(), None
            except Exception as e:  # noqa: BLE001
                detail, err = '', str(e) or type(e).__name__
            await asyncio.sleep(0.2)
            p = probs.take()
            ok = err is None and not p
            self.results.append(('boot', ok, time.time() - t0))
            self.line(ok, 'boot', time.time() - t0, detail=detail)
            if err:
                print(f'      error: {err}', flush=True)
            self.problems_lines(p)
            if err:
                await self.fail_shot('boot')
                return
            opts = {'quality': self.a.quality, 'ci': self.a.ci}
            await cdp.js(f"import('/tools/test/jobs/harness.js').then((h) => {{ h.runJob({json.dumps(self.job)}, {json.dumps(opts)}); return 1; }})", timeout=120)
            await self.events_loop()

    async def events_loop(self):
        cdp, probs = self.cdp, self.probs
        last = 'boot'
        while True:
            limit = (self.cur['timeout'] + GRACE) if self.cur else 300 * (2 if self.a.ci else 1)
            t_wait = time.time()
            ev = None
            while ev is None:
                try:
                    ev = await asyncio.wait_for(self.events.get(), 5)
                except asyncio.TimeoutError:
                    if cdp.reader.done():
                        where = f"in step '{self.cur['name']}'" if self.cur else f"after '{last}'"
                        self.results.append((self.cur['name'] if self.cur else f'after {last}', False, 0))
                        print(f'FAIL  the browser went away {where}', flush=True)
                        return
                    if time.time() - t_wait > limit:
                        where = f"step '{self.cur['name']}'" if self.cur else f"the next step after '{last}'"
                        name = self.cur['name'] if self.cur else f'after {last}'
                        self.results.append((name, False, time.time() - (self.cur or {'t0': t_wait})['t0']))
                        print(f'FAIL  {name:<46} the page stopped answering in {where} ({limit:.0f} s without word)', flush=True)
                        self.problems_lines(probs.take())
                        await self.fail_shot(name)
                        return
            e = ev.get('e')
            if e == 'begin':
                stray = probs.take()
                if stray:  # (between steps: the previous step's async tail, or the job's own code)
                    self.results.append((f'between steps (after {last})', False, 0))
                    print(f'FAIL  {"between steps (after " + last + ")":<46}', flush=True)
                    self.problems_lines(stray)
                self.cur = {'name': ev['name'], 'timeout': ev.get('timeout') or 600, 't0': time.time()}
                print(f'  ..  {ev["name"]}', flush=True)
            elif e == 'check':
                if ev.get('inStep'):
                    print(f'      {"ok  " if ev["ok"] else "FAIL"}  {ev["name"]}' + (f'  ({ev["detail"]})' if ev.get('detail') else ''), flush=True)
                else:
                    self.results.append((ev['name'], ev['ok'], 0))
                    self.line(ev['ok'], ev['name'], 0, detail=ev.get('detail', ''))
                    if not ev['ok'] and ev.get('detail'):
                        print(f'      {ev["detail"][:600]}', flush=True)
            elif e == 'log':
                print(f'      {ev["msg"]}', flush=True)
            elif e == 'shot':
                try:
                    await cdp.screenshot(os.path.join(self.shots, f'{self.job}-{clean(ev["name"])}.png'))
                except Exception as x:  # noqa: BLE001 - the page's T.shot still gets its answer; a missing picture isn't a failure
                    print(f'      screenshot {ev["name"]} failed: {x}', flush=True)
                await cdp.js(f'window.__T && window.__T.ack({int(ev["id"])})')
            elif e == 'end':
                p = probs.take()
                ok = bool(ev['ok']) and not p
                secs = ev.get('ms', 0) / 1000
                self.results.append((ev['name'], ok, secs))
                self.line(ok, ev['name'], secs, ev.get('frames', 0), ev.get('stepped', 0), ev.get('detail', ''))
                if ev.get('error'):
                    print(f'      error: {ev["error"][:1500]}', flush=True)
                self.problems_lines(p)
                if not ok:
                    await self.fail_shot(ev['name'])
                last, self.cur = ev['name'], None
            elif e == 'done':
                await asyncio.sleep(0.3)
                p = probs.take()
                if ev.get('error'):
                    self.results.append((f'{self.job} (outside any step)', False, 0))
                    print(f'FAIL  the job threw outside any step: {ev["error"][:1500]}', flush=True)
                if p:
                    self.results.append((f'after the last step ({last})', False, 0))
                    print(f'FAIL  after the last step ({last})', flush=True)
                    self.problems_lines(p)
                return


def run_one(a, job):
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    url = (a.url or f'http://127.0.0.1:{port}').rstrip('/') + '/'
    shots = os.path.abspath(a.out) if a.out else tempfile.mkdtemp(prefix=f'skywright-{job}-')
    os.makedirs(shots, exist_ok=True)
    profile = tempfile.mkdtemp(prefix='skywright-chrome-')
    proc, ws_url = launch_chrome(a.cdp_port or free_port(), profile, a.size.replace('x', ','))
    print(f'Skywright job {job}: {url} (quality {a.quality or "as saved"}{", CI" if a.ci else ""})', flush=True)
    t0, j = time.time(), Job(a, job, url, ws_url, shots)
    try:
        asyncio.run(j.run())
    except Exception as e:  # noqa: BLE001
        j.results.append((f'{job} harness', False, 0))
        print(f'FAIL  the harness itself: {e}', flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if srv:
            srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    failed = [n for n, ok, _ in j.results if not ok]
    if j.geo:
        print(j.geo.summary(), flush=True)
    print('-' * 72)
    if failed or not j.results:
        print(f'FAIL  {job}: {len(failed)} of {len(j.results)} failed in {time.time() - t0:.0f} s: {", ".join(failed)}')
    else:
        print(f'PASS  {job}: all {len(j.results)} in {time.time() - t0:.0f} s')
    if a.keep or a.out or failed:
        print(f'screenshots: {shots}')
    else:
        shutil.rmtree(shots, ignore_errors=True)
    return 1 if failed or not j.results else 0


def run_many(a, jobs):
    """Each job in its own jobs.py (own server, Chrome and screenshot folder), all at once; lines prefixed as they come."""
    t0, procs = time.time(), {}
    base = [sys.executable, os.path.abspath(__file__), '--size', a.size] + (['--quality', a.quality] if a.quality else []) + (['--ci'] if a.ci else []) + (['--keep'] if a.keep else []) + (['--url', a.url] if a.url else []) + ['--geo', a.geo]
    for job in jobs:
        cmd = base + [job] + (['--out', os.path.join(os.path.abspath(a.out), job)] if a.out else [])
        procs[job] = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    w = max(len(j) for j in jobs)

    def pump(job, p):
        for ln in p.stdout:
            print(f'[{job:<{w}}] {ln.rstrip()}', flush=True)
    threads = [threading.Thread(target=pump, args=(j, p), daemon=True) for j, p in procs.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    bad = [j for j, p in procs.items() if p.wait() != 0]
    print('=' * 72)
    print(f"{'FAIL' if bad else 'PASS'}  {len(jobs) - len(bad)}/{len(jobs)} jobs passed in {time.time() - t0:.0f} s" + (f": failed {', '.join(bad)}" if bad else ''))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('jobs', nargs='*', metavar='job', help=f'jobs to run (default: all of {", ".join(JOBS)})')
    ap.add_argument('--quality', choices=['auto', 'low', 'medium', 'high', 'ultra'], default='medium', help="graphics setting (default medium; CI: low)")
    ap.add_argument('--size', default='1000x700', help='window size WxH (it does not change a software GPU\'s frame time)')
    ap.add_argument('--ci', action='store_true', help='a CI runner: safety timeouts doubled, no frame-time limits')
    ap.add_argument('--out', metavar='DIR', help='screenshot directory (implies --keep; per job DIR/<job> when several run)')
    ap.add_argument('--keep', action='store_true', help='keep the screenshots (always kept on failure)')
    ap.add_argument('--url', help='test an already running server instead of serving this checkout')
    ap.add_argument('--geo', choices=['fixtures', 'record', 'net'], default='fixtures', help="geodata tiles: from tools/test/fixtures/geo, 404 past them (default); record: fetch and save the missing ones; net: the real hosts")
    ap.add_argument('--port', type=int, default=0, help='static server port (default: a free one)')
    ap.add_argument('--cdp-port', type=int, default=0, help='Chrome debugging port (default: a free one)')
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    jobs = a.jobs or JOBS
    for j in jobs:
        if j not in JOBS and not os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jobs', f'{j}.js')):
            ap.error(f'no job {j!r} (tools/test/jobs/{j}.js); jobs: {", ".join(JOBS)}')
    if len(jobs) > 1:
        if a.port or a.cdp_port:
            ap.error('--port / --cdp-port fix one job\'s ports: run one job with them')
        return run_many(a, jobs)
    return run_one(a, jobs[0])


if __name__ == '__main__':
    sys.exit(main())
