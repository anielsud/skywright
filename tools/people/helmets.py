#!/usr/bin/env python3
"""Helmet models (Sketchfab GLBs) -> assets/people/helmets.bin + helmets.json (crew.js fits them to each head).

    uv run --no-project --with numpy --with pillow --with scipy --with fast-simplification \
        python tools/people/helmets.py SRC_DIR [--inspect]

Sources (SRC_DIR):
  road  : motorcycle_helmet_-_racing_helmet.glb  "Motorcycle helmet - racing helmet" by ramyouny (Sketchfab Standard
          licence). Its sponsor livery texture is dropped: the shell is repainted in each outfit's colours.
  mx    : fox_x_supreme_helmet.glb  "Fox X Supreme Helmet" by Muhammad Seno Aji, CC BY 4.0. Its brand livery is dropped:
          each triangle goes by the majority of texture samples over it: red, its white lettering and the grey panels ->
          shell (logos and panel edges are painted across the triangles, so one colour reads cleanly), dark vent mesh ->
          rubber. The goggle frame is the accent.
  space : space_helmet.glb  "space helmet" by J4747, CC BY 4.0.
Each model's node transforms are baked, it is turned to face -Z with +Y up, scaled to unit width (x extent) and
centred on its eye point (a landmark per model, below). Its parts become roles: 'shell' (the outfit's helmet colour),
'accent' (helmet2), 'visor' (glass, the outfit's visor tint), 'liner' (dark fabric), 'rubber', 'metal', or 'baked'
(the source texture sampled into vertex colours). Every part is simplified to its triangle budget and stored with
positions, vertex colours and 16-bit indices. --inspect prints the parts and their bounds after normalising.
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
import fast_simplification

SRC = sys.argv[1]; INSPECT = '--inspect' in sys.argv
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'people')

def load_glb(path):
    b = open(path, 'rb').read(); jl = struct.unpack('<I', b[12:16])[0]; J = json.loads(b[20:20 + jl])
    o = 20 + jl; bl = struct.unpack('<I', b[o:o + 4])[0]; BIN = b[o + 8:o + 8 + bl]
    return J, BIN

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def accessor(J, BIN, i):
    a = J['accessors'][i]; bv = J['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride', 0) or dt.itemsize * n
    raw = np.frombuffer(BIN, dtype=np.uint8, count=stride * (a['count'] - 1) + dt.itemsize * n, offset=off)
    arr = np.lib.stride_tricks.as_strided(raw.view(dt) if stride % dt.itemsize == 0 else raw, shape=(a['count'], n), strides=(stride, dt.itemsize)) if stride % dt.itemsize == 0 else None
    arr = np.array([np.frombuffer(BIN, dtype=dt, count=n, offset=off + k * stride) for k in range(a['count'])]) if arr is None else np.array(arr)
    if a.get('normalized'): arr = arr.astype(np.float32) / np.iinfo(dt).max
    return arr.astype(np.float32) if dt == np.float32 or a.get('normalized') else arr

def node_matrix(n):
    if 'matrix' in n: return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
    t = np.array(n.get('translation', [0, 0, 0])); q = n.get('rotation', [0, 0, 0, 1]); s = np.array(n.get('scale', [1, 1, 1]))
    x, y, z, w = q; R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t; return M

def parts_of(path):
    """[(node name, material name, positions (world), uv or None, material index)] for every primitive"""
    J, BIN = load_glb(path); out = []
    def walk(i, M, names):
        n = J['nodes'][i]; M2 = M @ node_matrix(n); nm = names + [n.get('name', '')]
        if 'mesh' in n:
            for p in J['meshes'][n['mesh']]['primitives']:
                P = accessor(J, BIN, p['attributes']['POSITION']).astype(np.float64); P = (np.c_[P, np.ones(len(P))] @ M2.T)[:, :3]
                F = accessor(J, BIN, p['indices']).reshape(-1, 3).astype(np.int64) if 'indices' in p else np.arange(len(P)).reshape(-1, 3)
                mi = p.get('material'); mat = J['materials'][mi] if mi is not None else {}
                tc = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture'); uv = None
                if tc is not None: uv = accessor(J, BIN, p['attributes'][f"TEXCOORD_{tc.get('texCoord', 0)}"])
                out.append(dict(node='/'.join(x for x in nm if x), mat=mat.get('name', ''), P=P, F=F, uv=uv, mi=mi,
                                color=mat.get('pbrMetallicRoughness', {}).get('baseColorFactor', [1, 1, 1, 1])))
        for c in n.get('children', []): walk(c, M2, nm)
    for r in J['scenes'][J.get('scene', 0)]['nodes']: walk(r, np.eye(4), [])
    return J, BIN, out

def texture(J, BIN, mi):
    t = J['materials'][mi]['pbrMetallicRoughness']['baseColorTexture']['index']; img = J['images'][J['textures'][t]['source']]
    bv = J['bufferViews'][img['bufferView']]; data = BIN[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
    return np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), dtype=np.float32) / 255

ROT = {'-z': np.eye(3), '+z': np.diag([-1, 1, -1]), '-x': np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], float)}  # (turns the model's front onto -Z)

# per model: file, its front, its eye point (normalised units: fractions of the width, from the bbox centre), roles by
# node / material name (first match wins; None drops the part), triangle budget per role
MODELS = {
  'road': dict(src='motorcycle_helmet_-_racing_helmet.glb', front='-z', eye=None,
               roles=[('visorlogo', None), ('INTERIOR PADDING', None), ('RED FABRIC', None), ('Object_14', 'rubber'), ('visor padding', 'rubber'), ('bottom pading', 'liner'), ('interior', 'liner'),
                      ('visor', 'visor'), ('aero back', 'accent'), ('front vent', 'rubber'), ('GRILLS', 'rubber'), ('screws', 'metal'), ('ALUMINIUM', 'metal'), ('main', 'shell')],
               budget=dict(shell=8000, accent=1100, visor=4800, liner=2200, rubber=14000, metal=1200)),
  'mx': dict(src='fox_x_supreme_helmet.glb', front='-z', eye=None, eyeBack=0.12,
             roles=[('material_6', 'accent'), ('black_gloss', 'visor'), ('bLACK', 'rubber'), ('Google', 'rubber'), ('Metalicc', 'metal'), ('White', 'rubber'), ('material', 'livery')],
             budget=dict(shell=20000, accent=20000, rubber=20000, visor=20000, metal=20000)),
  'space': dict(src='space_helmet.glb', front='+z', eye=None, roles=[('', 'baked')], budget=dict(baked=40000, visor=40000, metal=40000)),
}

def role_of(cfg, p):
    for key, role in cfg['roles']:
        if key in p['node'] or key == p['mat'] or (key and key in p['mat']): return role, True
    return None, False

ROLE_RGB = dict(shell=(0.95, 0.95, 0.95), accent=(0.1, 0.1, 0.1), visor=(0.1, 0.1, 0.1), liner=(0.15, 0.15, 0.16), rubber=(0.08, 0.08, 0.09), metal=(0.6, 0.62, 0.65))
SLOT = dict(shell='paint', accent='paint', visor='glass', liner='fabric', rubber='rubber', metal='metal', baked='paint')

def simplify(P, F, budget):
    if len(F) <= budget: return P, F
    P2, F2 = fast_simplification.simplify(P.astype(np.float32), F.astype(np.int32), target_reduction=1 - budget / len(F))
    return P2.astype(np.float64), F2.astype(np.int64)

def compact(P, F):
    used = np.unique(F); remap = -np.ones(len(P), np.int64); remap[used] = np.arange(len(used)); return P[used], remap[F], used

result, pos_all, col_all, idx_all = {}, [], [], []
nv_tot = ni_tot = 0
for name, cfg in ([] if INSPECT else MODELS.items()):
    J, BIN, parts = parts_of(os.path.join(SRC, cfg['src']))
    R = ROT[cfg['front']]; allP = np.vstack([p['P'] for p in parts]) @ R.T
    lo, hi = allP.min(0), allP.max(0); c = (lo + hi) / 2; w = hi[0] - lo[0]
    groups = {}  # role -> list of (P, F, colours per vertex)
    for p in parts:
        role, _ = role_of(cfg, p)
        if role is None: continue
        Q = (p['P'] @ R.T - c) / w
        if role == 'baked':  # one mesh: split into its connected pieces; the dark dome in front is the visor, the other dark
            # pieces (neck rings, valves) metal, the rest the white shell, its baked lighting kept as soft shading
            img = texture(J, BIN, p['mi']); H, W = img.shape[:2]; uv = p['uv'] % 1.0
            lum = img[np.clip((uv[:, 1] * H).astype(int), 0, H - 1), np.clip((uv[:, 0] * W).astype(int), 0, W - 1)].mean(1)
            key = np.round(Q / 1e-5).astype(np.int64); _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
            Fw = inv[p['F']]; par = np.arange(inv.max() + 1)
            def find(a):
                while par[a] != a: par[a] = par[par[a]]; a = par[a]
                return a
            for a, b, c3 in Fw: ra = find(a); par[find(b)] = ra; par[find(c3)] = ra
            comp = np.array([find(v) for v in Fw[:, 0]]); kind = np.empty(len(Fw), object)
            for cid in np.unique(comp):
                m = comp == cid; v = np.unique(p['F'][m]); P = Q[v]; L = lum[p['F'][m]].mean()
                kind[m] = 'visor' if L < 0.4 and P[:, 2].mean() < -0.2 and np.ptp(P[:, 1]) > 0.3 else 'metal' if L < 0.4 else 'baked'
            C = np.tile([0.93, 0.93, 0.92], (len(Q), 1)) * (0.7 + 0.3 * np.clip(lum / 0.9, 0, 1))[:, None]
            C[np.isin(np.arange(len(Q)), p['F'][kind == 'metal'].ravel())] = (0.62, 0.64, 0.67)
            for k in ('visor', 'metal', 'baked'): groups.setdefault(k, []).append((Q, p['F'][kind == k], C))
        elif role == 'livery':  # each triangle by the majority of 7 texture samples over it -> shell / accent / rubber
            img = texture(J, BIN, p['mi']); H, W = img.shape[:2]; uv = p['uv'] % 1.0; U = uv[p['F']]
            bary = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1 / 3] * 3, [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]])
            pts = np.einsum('kj,tjc->tkc', bary, U); C = img[np.clip((pts[..., 1] * H).astype(int), 0, H - 1), np.clip((pts[..., 0] * W).astype(int), 0, W - 1)]
            lum = C.mean(-1); red = C[..., 0] - C[..., 1] > 0.18
            vote = np.where(red | (lum > 0.6), 0, 2)  # (red ground, its white lettering and the grey panels: shell (the panels' edges are painted across the triangles, so one colour reads cleaner); dark mesh: rubber)
            kind = np.array(['shell', 'accent', 'rubber'])[np.array([np.bincount(v, minlength=3).argmax() for v in vote])]
            for k in ('shell', 'accent', 'rubber'): groups.setdefault(k, []).append((Q, p['F'][kind == k], None))
        else:
            groups.setdefault(role, []).append((Q, p['F'], None))
    if cfg.get('frameNear'):  # the goggles' frame: the body's triangles next to the lens, black rubber
        lens = np.vstack([q[np.unique(F)] for q, F, _ in groups['visor']]); tree = cKDTree(lens); Q, F, C0 = groups['shell'][0]
        d, _ = tree.query(Q[F].mean(1)); near = d < cfg['frameNear']
        groups['shell'] = [(Q, F[~near], C0)]; groups.setdefault('rubber', []).append((Q, F[near], C0))
    if cfg.get('orient'):  # a mesh made of closed pieces, some inside out: each piece turned so its volume is positive
        for role, lst in groups.items():
            out = []
            for Q, F, C in lst:
                key = np.round(Q / 1e-5).astype(np.int64); _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel(); Fw = inv[F]; par = np.arange(inv.max() + 1)
                def find(a):
                    while par[a] != a: par[a] = par[par[a]]; a = par[a]
                    return a
                for a, b, c3 in Fw: ra = find(a); par[find(b)] = ra; par[find(c3)] = ra
                comp = np.array([find(v) for v in Fw[:, 0]]); F = F.copy()
                for cid in np.unique(comp):
                    m = comp == cid; T = Q[F[m]]; vol = np.einsum('ij,ij->i', T[:, 0], np.cross(T[:, 1], T[:, 2])).sum()
                    if vol < 0: F[m] = F[m][:, ::-1]
                out.append((Q, F, C))
            groups[role] = out
    if cfg.get('peak'):  # the peak (fused into the shell): the shell's triangles above the eye point and reaching well ahead of
        # it (cfg: fractions of the width above, and ahead) -> accent
        vis = np.vstack([q[np.unique(F)] for q, F, _ in groups['visor']]); ey0, ez0 = (vis[:, 1].min() + vis[:, 1].max()) / 2, vis[:, 2].min() + cfg.get('eyeBack', 0.16)
        Q, F, C0 = groups['shell'][0]; cen = Q[F].mean(1); pk = (cen[:, 1] > ey0 + cfg['peak'][0]) & (cen[:, 2] < ez0 - cfg['peak'][1])
        groups['shell'] = [(Q, F[~pk], C0)]; groups.setdefault('accent', []).append((Q, F[pk], C0))
    if cfg.get('double'):  # a mesh wound both ways: every triangle again, reversed, on its own vertices (so normals don't cancel)
        for role, lst in groups.items():
            groups[role] = [(np.vstack([Q, Q]), np.vstack([F, F[:, ::-1] + len(Q)]), None if C is None else np.vstack([C, C])) for Q, F, C in lst]
    meta = dict(parts=[])
    for role, lst in groups.items():
        tris = sum(len(F) for _, F, _ in lst); budget = cfg['budget'].get(role, 2000)
        for Q, F, C in lst:
            if not len(F): continue
            Pc, Fc, used = compact(Q, F); Cc = C[used] if C is not None else None
            P2, F2 = simplify(Pc, Fc, max(min(len(F), 3000), int(budget * len(F) / tris)))  # (small parts kept as modelled)
            if Cc is not None: _, nn = cKDTree(Pc).query(P2); col = Cc[nn]
            else: col = np.tile(ROLE_RGB[role], (len(P2), 1))
            for s0 in range(0, len(F2), 21000):  # (16-bit indices: big parts in pieces)
                Fs = F2[s0:s0 + 21000]; Ps, Fs2, us = compact(P2, Fs)
                meta['parts'].append(dict(role=role, slot=SLOT[role], v0=nv_tot, nv=len(Ps), i0=ni_tot, ni=Fs2.size))
                pos_all.append(Ps.astype(np.float32)); col_all.append((np.clip(col[us], 0, 1) * 255).astype(np.uint8)); idx_all.append(Fs2.astype(np.uint16).ravel())
                nv_tot += len(Ps); ni_tot += Fs2.size
    allQ = np.vstack([q for lst in groups.values() for q, _, _ in lst])
    meta['bounds'] = [np.round(allQ.min(0), 4).tolist(), np.round(allQ.max(0), 4).tolist()]
    if name == 'space':  # its neck ring (the chrome round its lower half, tilted on the model): plane by PCA, centre, radius
        met = np.vstack([q[np.unique(F)] for q, F, _ in groups['metal']]); r0 = np.hypot(met[:, 0], met[:, 2]); ring = met[(met[:, 1] < -0.12) & (r0 > 0.3)]
        cen = ring.mean(0); _, _, Vt = np.linalg.svd(ring - cen); nrm = Vt[2] * (1 if Vt[2][1] > 0 else -1)
        d = ring - cen; rad = np.linalg.norm(d - np.outer(d @ nrm, nrm), axis=1)
        meta['ring'] = dict(c=np.round(cen, 4).tolist(), n=np.round(nrm, 4).tolist(), r=float(np.median(rad)), lo=float(((ring - cen) @ nrm).min()), hi=float(((ring - cen) @ nrm).max()), count=int(len(ring)))
    else:  # the eye point: the visor's / lens's middle, set back behind it
        vis = np.vstack([q[np.unique(F)] for q, F, _ in groups['visor']]); front = vis[:, 2].min()
        meta['eye'] = [0.0, float((vis[:, 1].min() + vis[:, 1].max()) / 2), float(front + cfg.get('eyeBack', 0.16))]
    result[name] = meta
    print(name, 'parts', len(meta['parts']), 'tris', sum(p['ni'] for p in meta['parts']) // 3, {k: v for k, v in meta.items() if k != 'parts'})

if not INSPECT:
    with open(os.path.join(OUT, 'helmets.bin'), 'wb') as f:
        P = np.concatenate(pos_all); C = np.concatenate(col_all); I = np.concatenate(idx_all)
        f.write(np.round(P / 0.7 * 32767).astype(np.int16).tobytes()); f.write(C.tobytes()); f.write(b'\0' * ((4 - (P.size * 2 + C.nbytes) % 4) % 4)); f.write(I.tobytes())  # (positions as 16-bit fractions of 0.7)
    json.dump(dict(verts=int(nv_tot), indices=int(ni_tot), posScale=0.7, helmets=result), open(os.path.join(OUT, 'helmets.json'), 'w'))
    print('wrote', nv_tot, 'verts', ni_tot // 3, 'tris', os.path.getsize(os.path.join(OUT, 'helmets.bin')) // 1024, 'KB')
