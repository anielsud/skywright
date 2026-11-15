#!/usr/bin/env python3
"""Freesound helper for building Skywright's sound set (dev tool, not shipped).
Needs FREESOUND_KEY (free API key) in the environment or ~/.config/skywright/freesound.env.
  fs.py search "query" [--cc0] [--min 3] [--max 120] [-n 15]
  fs.py get ID OUTDIR          downloads the HQ ogg preview + writes ID.json metadata (name, author, license, url)
"""
import json, os, sys, urllib.parse, urllib.request, argparse, pathlib
def key():
    k = os.environ.get('FREESOUND_KEY')
    if not k:
        p = pathlib.Path.home() / '.config/skywright/freesound.env'
        for line in p.read_text().splitlines():
            if line.startswith('FREESOUND_KEY='): k = line.split('=', 1)[1].strip()
    return k
API = 'https://freesound.org/apiv2'
def call(path, **q):
    q['token'] = key()
    with urllib.request.urlopen(f"{API}{path}?{urllib.parse.urlencode(q)}") as r: return json.load(r)
FIELDS = 'id,name,duration,license,username,avg_rating,num_ratings,num_downloads,tags,description,previews,url,samplerate,channels'
ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd')
s = sub.add_parser('search'); s.add_argument('q'); s.add_argument('--cc0', action='store_true'); s.add_argument('--min', type=float, default=2); s.add_argument('--max', type=float, default=300); s.add_argument('-n', type=int, default=15); s.add_argument('--sort', default='score')
g = sub.add_parser('get'); g.add_argument('id'); g.add_argument('out')
a = ap.parse_args()
if a.cmd == 'search':
    f = f'duration:[{a.min} TO {a.max}]' + (' license:"Creative Commons 0"' if a.cc0 else ' (license:"Creative Commons 0" OR license:"Attribution")')
    r = call('/search/text/', query=a.q, filter=f, fields=FIELDS, page_size=a.n, sort=a.sort)
    print(f"{r['count']} results")
    for x in r['results']:
        lic = 'CC0' if 'zero' in x['license'] else 'BY' if '/by/' in x['license'] else x['license']
        print(f"{x['id']:>7} {x['duration']:6.1f}s {lic:4} ★{x['avg_rating']:.1f}({x['num_ratings']}) ↓{x['num_downloads']:<5} {x['name'][:60]!r} by {x['username']}")
        print('         ', (x['description'] or '').replace('\n', ' ')[:200])
elif a.cmd == 'get':
    x = call(f'/sounds/{a.id}/', fields=FIELDS)
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(x['previews']['preview-hq-ogg'], out / f"{a.id}.ogg")
    meta = {k: x[k] for k in ('id', 'name', 'username', 'license', 'url', 'duration', 'description', 'tags')}
    (out / f"{a.id}.json").write_text(json.dumps(meta, indent=1))
    print(f"{a.id}: {x['name']} ({x['duration']:.1f}s) by {x['username']}")
