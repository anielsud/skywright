#!/usr/bin/env python3
"""Pictures of the stock vehicles for the Vehicles menu: assets/thumbs/<slug>.webp + assets/thumbs/index.json.

Run after changing a stock vehicle or how parts look:  python3 tools/thumbs/build.py [--check]
It boots the game in headless Chrome (same as tools/test/smoke.py: needs `pip install websockets` and Chrome) and
draws each preset with the game's own picture code (src/thumbs.js), so they match the pictures of saved vehicles.
index.json maps each picture to the design it shows (designKey); when a preset no longer matches its picture the
game draws it live instead, so a stale picture is never wrong, just slower. But a part whose LOOK changed (not its
design) keeps the same key: re-run this after visual changes to parts.
--check: only report which pictures are missing or stale (exit 1 if any).
"""
import argparse, asyncio, base64, json, os, shutil, subprocess, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test'))
from smoke import ROOT, CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402

OUT = os.path.join(ROOT, 'assets', 'thumbs')
JS = """(async () => {
  const T = await import('./src/thumbs.js'), out = [];
  for (const d of window.__sky.presets) {
    const slug = T.presetSlug(d.name), key = T.designKey(d);
    out.push({ slug, key, url: CHECK ? null : await T.renderThumb(d, { size: T.STOCK_SIZE, quality: 0.88 }) });
  }
  return out;
})()"""


async def run(url, ws_url, check):
    async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
        await cdp.send('Network.setCacheDisabled', cacheDisabled=True)
        await cdp.send('Page.navigate', url=url)
        await cdp.wait_for('window.__sky && window.__sky.presets.length', 40, 'window.__sky')
        return await cdp.js(JS.replace('CHECK', 'true' if check else 'false'), timeout=180)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='only report missing/stale pictures')
    args = ap.parse_args()
    port, cdp_port = free_port(), free_port()
    profile = tempfile.mkdtemp(prefix='skywright-chrome-')
    srv = start_server(port)
    proc, ws_url = launch_chrome(cdp_port, profile, '1280,800')
    try:
        items = asyncio.run(run(f'http://127.0.0.1:{port}/', ws_url, args.check))
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    try:
        old = json.load(open(os.path.join(OUT, 'index.json')))
    except Exception:
        old = {}
    if args.check:
        bad = [it['slug'] for it in items if old.get(it['slug']) != it['key']]
        print('stale or missing: ' + ', '.join(bad) if bad else f'all {len(items)} pictures up to date')
        sys.exit(1 if bad else 0)
    os.makedirs(OUT, exist_ok=True)
    index, total = {}, 0
    for it in items:
        if not it['url'] or not it['url'].startswith('data:image/webp;base64,'):
            sys.exit(f"{it['slug']}: no picture (got {str(it['url'])[:30]})")
        data = base64.b64decode(it['url'].split(',', 1)[1])
        with open(os.path.join(OUT, it['slug'] + '.webp'), 'wb') as f:
            f.write(data)
        index[it['slug']] = it['key']; total += len(data)
        print(f"{it['slug']:24s} {len(data) / 1024:5.1f} KB{'' if old.get(it['slug']) == it['key'] else '  (new picture)'}")
    for f in os.listdir(OUT):  # pictures of presets that are gone
        if f.endswith('.webp') and f[:-5] not in index:
            os.remove(os.path.join(OUT, f)); print('removed', f)
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1, sort_keys=True); f.write('\n')
    print(f'{len(index)} pictures, {total / 1024:.0f} KB in {os.path.relpath(OUT, ROOT)}/')


if __name__ == '__main__':
    main()
