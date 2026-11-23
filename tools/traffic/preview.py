#!/usr/bin/env python3
"""Screenshots of every traffic model (tools/traffic/preview.html) in headless Chrome.
python3 tools/traffic/preview.py OUT_DIR [view=three ...] [--lod N] [--paint] [--only id,id] [--size 1600,1000]"""
import argparse, asyncio, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test'))
from smoke import CDP, free_port, start_server, launch_chrome  # noqa: E402
import websockets  # noqa: E402

async def main(a):
    port, cdp_port = free_port(), free_port(); start_server(port)
    proc, ws_url = launch_chrome(cdp_port, tempfile.mkdtemp(), a.size)
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = CDP(ws)
            for v in a.views:
                url = f'http://127.0.0.1:{port}/tools/traffic/preview.html?view={v}&lod={a.lod}' + ('&paint=1' if a.paint else '') + (f'&only={a.only}' if a.only else '') + (a.extra or '')
                await cdp.send('Page.navigate', url=url)
                await cdp.wait_for('window.done || window.err', 60, 'preview render')
                err = await cdp.js('window.err || null')
                if err: sys.exit(f'preview: {err}')
                out = os.path.join(a.out, f'{v}-lod{a.lod}{"-paint" if a.paint else ""}.png'); await cdp.screenshot(out); print(out)
    finally:
        proc.kill()

p = argparse.ArgumentParser(); p.add_argument('out'); p.add_argument('views', nargs='*', default=['three'])
p.add_argument('--lod', type=int, default=0); p.add_argument('--paint', action='store_true'); p.add_argument('--only'); p.add_argument('--size', default='1600,1000'); p.add_argument('--extra')
a = p.parse_args(); os.makedirs(a.out, exist_ok=True); asyncio.run(main(a))
