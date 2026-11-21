#!/usr/bin/env python3
"""MakeHuman base mesh -> assets/people/body.bin + body.json + targets.bin (the people's skinned body, crew.js).

Source (CC0 1.0, MakeHuman 1.x bundled assets): makehuman/data/3dobjs/base.obj, rigs/default.mhskel,
rigs/default_weights.mhw from github.com/makehumancommunity/makehuman. Run:
    python3 tools/people/mh_convert.py RAW_DIR [TARGETS_DIR]
TARGETS_DIR holds MakeHuman macro targets (CC0, makehuman/data/targets/macrodetails: <ancestry>-<sex>-<age>,
universal-<sex>-young-<muscle>-<weight>, height/<sex>-young-averagemuscle-averageweight-<height>, the last saved as
height-<sex>-<height>.target). Each is stored dense over the body's vertices and the skeleton's joint helper vertices
(signed bytes x a per-target scale), so a person is the base plus a weighted sum, joints included.
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
    bones.append({'name': name, 'parent': b['parent'], 'head': [round(float(x), 5) for x in J[b['head']]], 'tail': [round(float(x), 5) for x in J[b['tail']]], 'hj': b['head'], 'tj': b['tail']})
# joint helper vertices (the skeleton's joints are means of these), for re-deriving joints on a morphed body
jverts = sorted({i for ix in sk['joints'].values() for i in ix}); jmap = {o: n for n, o in enumerate(jverts)}
joints = {name: [jmap[i] for i in ix] for name, ix in sk['joints'].items()}
jpos = V[jverts].astype(np.float32)
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
targets = []
if len(sys.argv) > 2:
    tdir = sys.argv[2]; allv = used + jverts; slot = {}
    for k, o in enumerate(used): slot.setdefault(o, []).append(k)
    for k, o in enumerate(jverts): slot.setdefault(o, []).append(len(used) + k)
    blobs = []
    for fn in sorted(os.listdir(tdir)):
        if not fn.endswith('.target'): continue
        D = np.zeros((len(allv), 3), np.float32)
        for line in open(os.path.join(tdir, fn)):
            if not line.strip() or line.startswith('#'): continue
            t = line.split(); i = int(t[0])
            for k in slot.get(i, ()): D[k] = [float(t[1]) * -0.1, float(t[2]) * 0.1, float(t[3]) * -0.1]  # (dm -> m, the same half turn)
        sc = float(np.abs(D).max()) / 127 or 1e-6
        blobs.append(np.clip(np.round(D / sc), -127, 127).astype(np.int8).tobytes()); targets.append({'name': fn[:-7], 'scale': sc})
    with open(os.path.join(out, 'targets.bin'), 'wb') as f:
        for b in blobs: f.write(b)
with open(os.path.join(out, 'body.bin'), 'wb') as f:
    f.write(pos.tobytes()); f.write(np.array(tris, np.uint16).tobytes()); f.write(bi.tobytes()); f.write((bw * 255 + 0.5).astype(np.uint8).tobytes()); f.write(eye.tobytes())
    f.write(b'\0' * ((-f.tell()) % 4)); f.write(jpos.tobytes())  # (aligned for a Float32Array)
meta = {'source': 'MakeHuman 1.x base mesh, default skeleton and weights (CC0 1.0)', 'verts': len(used), 'tris': len(tris) // 3, 'bones': bones,
        'layout': ['pos f32x3', 'index u16', 'boneIdx u8x4', 'boneW u8x4 (/255)', 'eye u8 (1 left eye, 2 right eye, 3 teeth)', 'jointVert pos f32x3'],
        'jointVerts': len(jverts), 'joints': joints, 'targets': targets,
        'targetsLayout': 'targets.bin: per target, (verts + jointVerts) x i8x3, times its scale (metres)'}
json.dump(meta, open(os.path.join(out, 'body.json'), 'w'))
print(meta['verts'], 'verts', meta['tris'], 'tris', len(bones), 'bones', len(jverts), 'joint verts', os.path.getsize(os.path.join(out, 'body.bin')) // 1024, 'KB,', len(targets), 'targets', (os.path.getsize(os.path.join(out, 'targets.bin')) // 1024) if targets else 0, 'KB')
