#!/usr/bin/env python3
"""MakeHuman base mesh -> assets/people/body.bin + body.json (the people's skinned body, crew.js).

Source (CC0 1.0, MakeHuman 1.x bundled assets): makehuman/data/3dobjs/base.obj, rigs/default.mhskel,
rigs/default_weights.mhw from github.com/makehumancommunity/makehuman. Run:
    python3 tools/people/mh_convert.py RAW_DIR
Keeps the 'body' group (plus the eyeball helpers, flagged), converts decimetres -> metres and turns it to face -Z
(the game's forward), triangulates, and stores each vertex's 4 strongest bone weights. Joint positions are the
skeleton's head/tail points (means of their vertex groups), in the same space. Posing to the crew rig happens in
crew.js at build time.
"""
import json, os, struct, sys
import numpy as np

raw = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__)); out = os.path.join(here, '..', '..', 'assets', 'people')
V, faces, grp = [], [], None
for line in open(os.path.join(raw, 'base.obj')):
    if line.startswith('v '): V.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('g '): grp = line.split()[1]
    elif line.startswith('f ') and grp in ('body', 'helper-l-eye', 'helper-r-eye', 'helper-upper-teeth', 'helper-lower-teeth'):
        idx = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
        faces.append((grp, idx))
V = np.array(V) * 0.1 * np.array([-1, 1, -1])  # dm -> m, turn round to face -Z
used = sorted({i for _, f in faces for i in f}); remap = {o: n for n, o in enumerate(used)}
pos = V[used].astype(np.float32)
tris, eye = [], np.zeros(len(used), np.uint8)
for g, f in faces:
    ids = [remap[i] for i in f]
    if g != 'body':
        for i in ids: eye[i] = 1 if g == 'helper-l-eye' else 2 if g == 'helper-r-eye' else 3
    for k in range(1, len(ids) - 1): tris += [ids[0], ids[k], ids[k + 1]]  # (x and z both negated: a half turn, not a mirror, so the winding stays)
sk = json.load(open(os.path.join(raw, 'default.mhskel')))
J = {name: V[ix].mean(0) for name, ix in sk['joints'].items()}
bones = []
for name, b in sk['bones'].items():
    bones.append({'name': name, 'parent': b['parent'], 'head': [round(float(x), 5) for x in J[b['head']]], 'tail': [round(float(x), 5) for x in J[b['tail']]]})
order = {b['name']: i for i, b in enumerate(bones)}
W = json.load(open(os.path.join(raw, 'default_weights.mhw')))['weights']
per = [[] for _ in used]
for bname, lst in W.items():
    if bname not in order: continue
    for vi, w in lst:
        if vi in remap: per[remap[vi]].append((w, order[bname]))
bi = np.zeros((len(used), 4), np.uint8); bw = np.zeros((len(used), 4), np.float32)
for i, l in enumerate(per):
    l.sort(reverse=True); l = l[:4]; s = sum(w for w, _ in l) or 1
    for k, (w, b) in enumerate(l): bi[i, k] = b; bw[i, k] = w / s
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, 'body.bin'), 'wb') as f:
    f.write(pos.tobytes()); f.write(np.array(tris, np.uint16).tobytes()); f.write(bi.tobytes()); f.write((bw * 255 + 0.5).astype(np.uint8).tobytes()); f.write(eye.tobytes())
meta = {'source': 'MakeHuman 1.x base mesh, default skeleton and weights (CC0 1.0)', 'verts': len(used), 'tris': len(tris) // 3, 'bones': bones,
        'layout': ['pos f32x3', 'index u16', 'boneIdx u8x4', 'boneW u8x4 (/255)', 'eye u8 (1 left eye, 2 right eye, 3 teeth)']}
json.dump(meta, open(os.path.join(out, 'body.json'), 'w'))
print(meta['verts'], 'verts', meta['tris'], 'tris', len(bones), 'bones', os.path.getsize(os.path.join(out, 'body.bin')) // 1024, 'KB')
