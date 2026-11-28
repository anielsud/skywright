#!/usr/bin/env python3
"""Start-up data the deploy bakes, so a player's device doesn't have to work it out while the game opens:

  assets/boot/parts.json     the palette's part pictures ({ key: COMMIT, pics: { partId: data URL } })
  assets/boot/postures.json  every stock vehicle's crew postures, solved ({ solver: SOLVER, list: [[key, r]] })
  assets/boot/stunts.json    every place's stunt park site (src/stuntSite.js findSite) ({ key: COMMIT, sites: { locId: site } })
  assets/boot/views.json     every stock vehicle's cockpit views: which cabin linings cover the windows (src/stations.js)
                             ({ stamp: VIEWS, list: [[soup fingerprint, lining places]] })

Run by .github/workflows/deploy.yml after it stamps src/version.js (COMMIT, SOLVER, VIEWS): the game only uses the
pictures and stunt sites for that same COMMIT, the postures for that same SOLVER and the views for that same VIEWS,
so a stale or missing file just means the device works them out itself, as before. Locally (COMMIT 'dev') the game ignores these files; the outputs are
not committed (.gitignore). Same requirements as tools/test/smoke.py (Chrome + websockets).

In CI the postures and views of the last deploy with the same SOLVER / VIEWS are restored into assets/boot first
(deploy.yml, actions/cache): the game takes postures.json before building anything, the bake takes views.json, so only
what changed is solved again, and only views worked out now are checked again.

Then it checks its own output, read back from the files (tools/test/startbakes.js verifyBake): every stock vehicle's
cockpit views taken from views.json alone must equal the views worked out with no cache (and no seat may be missing
from it), and every stunt site in stunts.json must be exactly the site findSite finds. If not, it removes those two
files and exits non-zero, failing the deploy step loudly.

  python3 tools/bake/boot.py
"""
import asyncio, json, os, shutil, sys, tempfile, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test'))
from smoke import ROOT, CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402

OUT = os.path.join(ROOT, 'assets', 'boot')
JS = """(async (prevViews) => {
  const S = window.__sky, { thumbnailDrawer } = await import('./src/hangar.js');
  const crew = await import('./src/crew.js'), V = await import('./src/version.js'), { PARTS } = await import('./src/parts.js');
  const T = { t: performance.now() }, lap = (k) => { const n = performance.now(); T[k] = Math.round(n - T.t); T.t = n; };
  const dr = thumbnailDrawer(), pics = {};
  for (const id in PARTS) try { pics[id] = dr.draw(id); } catch (e) { console.warn('picture failed', id, e); }
  dr.dispose(); lap('pictures');
  // (the crews' postures are solved by the flight builds below: the same 21 + 3 as building each preset for the hangar
  // too, value for value, so that pass is gone)
  const { Aircraft } = await import('./src/aircraft.js'), { cloneDesign } = await import('./src/design.js'), views = await import('./src/stations.js');
  views.takeViews(prevViews); // (an earlier deploy's views, restored from the CI cache for this VIEWS: only new seats are worked out)
  for (const d of S.presets) { // the flight's copy: its cockpit views (stations.js) look at the meshes really built
    try { const ac = new Aircraft(cloneDesign(d)); void ac.stations; ac.root.traverse((o) => { o.geometry?.dispose(); o.skeleton?.dispose(); }); } catch (e) { console.warn('views failed', d.name, e); }
  }
  lap('flight builds (postures, views)');
  const { bakeStuntSites } = await import('./src/stuntPark.js'), { LOCATIONS } = await import('./src/world.js');
  const sites = await bakeStuntSites(LOCATIONS); lap('stunt sites'); delete T.t;
  return { parts: { key: V.COMMIT, pics }, postures: { solver: V.SOLVER, ...crew.solvedPostures() },
    ms: T, stunts: { key: V.COMMIT, sites }, views: { stamp: V.VIEWS, ...views.solvedViews() } };
})(PREV)"""


async def run(url, ws_url):
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
        await cdp.send('Page.navigate', url=url)
        await cdp.wait_for('window.__sky && window.__sky.presets.length', 120, 'window.__sky')
        prev = load('views')  # (restored by deploy.yml from the CI cache, for this same VIEWS stamp; else none)
        r = await cdp.js(JS.replace('PREV', json.dumps(prev)), timeout=900)
        write(r)
        # only views worked out now need checking: the rest come from an earlier bake, checked when it was made
        old = {json.dumps(k) for k, _ in (prev or {}).get('list', [])} if prev and prev.get('stamp') == r['views']['stamp'] else set()
        new_views = [k for k, _ in r['views']['list'] if json.dumps(k) not in old]
        print(f"views: {len(r['views']['list']) - len(new_views)} from the cache, {len(new_views)} worked out now; ms per stage {r['ms']}")
        # check the bake as written: read back from its files, it must be what the game works out itself
        # (tools/test/startbakes.js verifyBake)
        back = {n: json.load(open(os.path.join(OUT, f'{n}.json'))) for n in ('views', 'stunts')}
        opts = {'views': bool(new_views), 'fresh': r['stunts']['sites']}
        bad = await cdp.js(f"import('./tools/test/startbakes.js').then((m) => m.verifyBake({json.dumps(back)}, window.__sky.presets, {json.dumps(opts)}))", timeout=900)
        return r, bad


def load(name):
    try:
        return json.load(open(os.path.join(OUT, f'{name}.json')))
    except (OSError, ValueError):
        return None


def write(r):
    os.makedirs(OUT, exist_ok=True)
    for name in ('parts', 'postures', 'stunts', 'views'):
        with open(os.path.join(OUT, f'{name}.json'), 'w') as f: json.dump(r[name], f, separators=(',', ':'))


def main():
    t0 = time.time()
    port, cdp_port = free_port(), free_port()
    srv = start_server(port)
    profile = tempfile.mkdtemp(prefix='sky-bake-')
    proc, ws_url = launch_chrome(cdp_port, profile, '800,600')
    try:
        r, bad = asyncio.run(run(f'http://127.0.0.1:{port}/?layout=0', ws_url))  # (the stunt sites from today's data, the layout's chunks not read)
    finally:
        proc.kill(); proc.wait(); srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)
    kb = lambda n: os.path.getsize(os.path.join(OUT, f'{n}.json')) // 1024
    print(f"baked {len(r['parts']['pics'])} part pictures ({kb('parts')} KB, key {r['parts']['key']}), "
          f"{len(r['postures']['list'])} + {len(r['postures']['rides'])} rider postures ({kb('postures')} KB, solver {r['postures']['solver']}), "
          f"{len(r['stunts']['sites'])} stunt sites ({kb('stunts')} KB), {len(r['views']['list'])} cockpit views ({kb('views')} KB, stamp {r['views']['stamp']}) in {time.time() - t0:.0f} s")
    if bad:  # a bake the game would get wrong: take the bad files away (the game then works it out itself) and fail the step
        for n in ('views', 'stunts'):
            os.remove(os.path.join(OUT, f'{n}.json'))
        print(f'\nBAKE CHECK FAILED: {len(bad)} problem(s); views.json and stunts.json removed', file=sys.stderr)
        for b in bad[:20]:
            print('  ' + b[:600], file=sys.stderr)
        sys.exit(1)
    print(f"bake checked: every stock vehicle's cockpit views from views.json alone, and {len(r['stunts']['sites'])} stunt sites from stunts.json, == worked out")


if __name__ == '__main__':
    main()
