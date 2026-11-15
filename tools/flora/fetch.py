"""Download the CC0 Poly Haven foliage scans build_atlas.py needs (1k diffuse + alpha + bark).
    python3 tools/flora/fetch.py OUT_DIR"""
import json, sys, os, urllib.request
op = urllib.request.build_opener(); op.addheaders = [("User-Agent", "skywright-asset-fetch/1.0")]; urllib.request.install_opener(op)
ASSETS = ['fir_tree_01', 'pine_tree_01', 'island_tree_02', 'shrub_02', 'shrub_04', 'fern_02']
out = sys.argv[1]
for a in sys.argv[2:] or ASSETS:
    d = json.load(urllib.request.urlopen(f"https://api.polyhaven.com/files/{a}"))
    os.makedirs(f"{out}/{a}", exist_ok=True)
    for k, v in d.items():
        if k in ('blend', 'fbx', 'gltf', 'usd'): continue
        if not any(s in k for s in ('diff', 'alpha', 'Diffuse', 'Alpha')) or 'trunk' in k: continue
        fmt = 'png' if 'alpha' in k.lower() else 'jpg'
        u = v['1k'][fmt]['url']; p = f"{out}/{a}/{k}.{fmt}"
        if not os.path.exists(p): urllib.request.urlretrieve(u, p)
        print(a, k, os.path.getsize(p))
