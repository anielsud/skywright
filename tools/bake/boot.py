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

  python3 tools/bake/boot.py
"""
import asyncio, json, os, shutil, sys, tempfile, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test'))
from smoke import ROOT, CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402

OUT = os.path.join(ROOT, 'assets', 'boot')
JS = """(async () => {
  const S = window.__sky, { thumbnailDrawer, buildDesign } = await import('./src/hangar.js');
  const crew = await import('./src/crew.js'), V = await import('./src/version.js'), { PARTS } = await import('./src/parts.js');
  const dr = thumbnailDrawer(), pics = {};
  for (const id in PARTS) try { pics[id] = dr.draw(id); } catch (e) { console.warn('picture failed', id, e); }
  dr.dispose();
  for (const d of S.presets) {
    const g = new S.THREE.Group();
    try { buildDesign(d, g, { quick: false, near: true }); } catch (e) { console.warn('build failed', d.name, e); }
    g.traverse((o) => { o.geometry?.dispose(); o.skeleton?.dispose(); });
  }
  const { Aircraft } = await import('./src/aircraft.js'), { cloneDesign } = await import('./src/design.js'), views = await import('./src/stations.js');
  for (const d of S.presets) { // the flight's copy: its cockpit views (stations.js) look at the meshes really built
    try { const ac = new Aircraft(cloneDesign(d)); void ac.stations; ac.root.traverse((o) => { o.geometry?.dispose(); o.skeleton?.dispose(); }); } catch (e) { console.warn('views failed', d.name, e); }
  }
  const { bakeStuntSites } = await import('./src/stuntPark.js'), { LOCATIONS } = await import('./src/world.js');
  const sites = await bakeStuntSites(LOCATIONS);
  return { parts: { key: V.COMMIT, pics }, postures: { solver: V.SOLVER, ...crew.solvedPostures() },
    stunts: { key: V.COMMIT, sites }, views: { stamp: V.VIEWS, ...views.solvedViews() } };
})()"""


async def run(url, ws_url):
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
        await cdp.send('Page.navigate', url=url)
        await cdp.wait_for('window.__sky && window.__sky.presets.length', 120, 'window.__sky')
        return await cdp.js(JS, timeout=900)


def main():
    t0 = time.time()
    port, cdp_port = free_port(), free_port()
    srv = start_server(port)
    profile = tempfile.mkdtemp(prefix='sky-bake-')
    proc, ws_url = launch_chrome(cdp_port, profile, '800,600')
    try:
        r = asyncio.run(run(f'http://127.0.0.1:{port}/', ws_url))
    finally:
        proc.kill(); proc.wait(); srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    for name in ('parts', 'postures', 'stunts', 'views'):
        with open(os.path.join(OUT, f'{name}.json'), 'w') as f: json.dump(r[name], f, separators=(',', ':'))
    kb = lambda n: os.path.getsize(os.path.join(OUT, f'{n}.json')) // 1024
    print(f"baked {len(r['parts']['pics'])} part pictures ({kb('parts')} KB, key {r['parts']['key']}), "
          f"{len(r['postures']['list'])} + {len(r['postures']['rides'])} rider postures ({kb('postures')} KB, solver {r['postures']['solver']}), "
          f"{len(r['stunts']['sites'])} stunt sites ({kb('stunts')} KB), {len(r['views']['list'])} cockpit views ({kb('views')} KB, stamp {r['views']['stamp']}) in {time.time() - t0:.0f} s")


if __name__ == '__main__':
    main()
