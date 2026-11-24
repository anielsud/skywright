"""Bake the town material sheet (tex/towns/) from CC0 ambientCG 1K-JPG downloads.

usage: python3 tools/towns/bake_materials.py DOWNLOAD_DIR
DOWNLOAD_DIR holds one folder per asset, each the unzipped ambientCG `<Id>_1K-JPG.zip`
(get it from https://ambientcg.com/get?file=<Id>_1K-JPG.zip).

Each material becomes one 512 px square tile that covers 3 m x 3 m (one facade bay) and tiles seamlessly.
Output, in a 5 x 4 grid of tiles, in the order of MATS below (buildings.js MAT indices must match):
  mat_color.jpg   sRGB albedo with the ambient occlusion multiplied in
  mat_normal.jpg  OpenGL tangent-space normals (4:4:4, no chroma subsampling)
  mat_rough.jpg   grayscale roughness
"""
import os, sys
from PIL import Image, ImageChops, ImageStat

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'tex', 'towns')
T, COLS, ROWS = 512, 5, 4
# (asset id, repeats across the 3 m tile, repeats down, rotate 90 deg[, options]). Options:
#   lum: mean luminance to normalise to. Tinted materials (roofs, thatch, lawn, cut stone) are brought to a mid or light
#        grey so the per-building tint colour decides the final colour
#   sat: keep only this fraction of the saturation
#   crop: (x0, y0, x1, y1) of the 1K source to use (must tile on its own)
#   stagger: (courses, blocks across): shift every other course half a block, so a grid of tiles lays as ashlar
MATS = [
    ('Plaster001', 1, 1, False),        # 0 plaster (tinted per building)
    ('Plaster007', 1, 1, False),        # 1 rough stucco / adobe
    ('WoodSiding008', 1, 1, False),     # 2 weathered chalet boards (horizontal)
    ('WoodSiding009', 2, 4, False),     # 3 painted clapboard
    ('WoodSiding001', 2, 2, True),      # 4 barn boards (vertical)
    ('Planks037A', 1, 1, False),        # 5 dark timber
    ('Bricks085', 2, 4, False),         # 6 red brick
    ('Bricks076A', 2, 2, False),        # 7 rubble stone
    ('RoofingTiles014A', 1, 1, False, dict(lum=126, sat=0.85)),  # 8 clay tiles (weathered terracotta, not salmon)
    ('RoofingTiles003', 2, 2, False, dict(lum=165)),   # 9 slate
    ('RoofingTiles013A', 1, 1, False, dict(lum=160)),  # 10 dark concrete tiles
    ('CorrugatedSteel009', 1, 2, True), # 11 corrugated metal (vertical ribs)
    ('ThatchedRoof001A', 1, 1, False, dict(lum=178, sat=0.3)),  # 12 thatch (pale grey: the straw tint decides)
    ('PavingStones142', 2, 2, False),   # 13 cobbles
    ('PavingStones128', 2, 2, False),   # 14 paving slabs
    ('Gravel023', 2, 2, False),         # 15 gravel
    ('Asphalt031', 1, 1, False),        # 16 asphalt
    ('Grass005', 2, 2, False, dict(lum=185, sat=0.35)),    # 17 lawn (half grey: tinted with the terrain colour per plot)
    ('Concrete034', 1, 2, False),       # 18 concrete
    ('Tiles139', 1, 1, False, dict(crop=(0, 0, 512, 1024), stagger=(6, 3), lum=188, sat=0.12)),  # 19 cut stone: limestone /
    # brownstone ashlar, 1 m x 0.5 m blocks in running bond (near white: tinted per building)
]

def load(aid, kind):
    p = os.path.join(SRC, aid, f'{aid}_1K-JPG_{kind}.jpg')
    return Image.open(p) if os.path.exists(p) else None

def rot_normal(im):
    """rotate a GL normal map 90 deg counter-clockwise: (x, y) -> (-y, x)"""
    r, g, b = im.convert('RGB').rotate(90, expand=True).split()
    return Image.merge('RGB', (ImageChops.invert(g), r, b))

def tile(im, rx, ry):
    tw, th = T // rx, T // ry
    im = im.resize((tw, th), Image.LANCZOS)
    out = Image.new(im.mode, (T, T))
    for i in range(rx):
        for j in range(ry): out.paste(im, (i * tw, j * th))
    return out

os.makedirs(OUT, exist_ok=True)
sheets = {k: Image.new(m, (COLS * T, ROWS * T), c) for k, m, c in (('c', 'RGB', (128, 128, 128)), ('n', 'RGB', (128, 128, 255)), ('r', 'L', 200))}
def stagger(im, n, m):
    """shift every other of n horizontal courses by half a block (m blocks across)"""
    out = im.copy(); w, h = im.size; d = round(w / m / 2)
    for j in range(1, n, 2):
        y0, y1 = round(j * h / n), round((j + 1) * h / n); band = im.crop((0, y0, w, y1))
        out.paste(band.crop((w - d, 0, w, y1 - y0)), (0, y0)); out.paste(band.crop((0, 0, w - d, y1 - y0)), (d, y0))
    return out

for k, (aid, rx, ry, rot, *o) in enumerate(MATS):
    o = o[0] if o else {}
    col, nor, rough, ao = load(aid, 'Color').convert('RGB'), load(aid, 'NormalGL'), load(aid, 'Roughness'), load(aid, 'AmbientOcclusion')
    if 'crop' in o: col, nor, rough, ao = (im.crop(o['crop']) if im is not None else None for im in (col, nor, rough, ao))
    if ao is not None: col = ImageChops.multiply(col, ao.convert('L').point(lambda v: int(255 * (v / 255) ** 0.6)).convert('RGB'))
    if 'sat' in o:  # keep only this fraction of the saturation
        col = Image.blend(col.convert('L').convert('RGB'), col, o['sat'])
    if 'lum' in o:
        st = ImageStat.Stat(col.convert('L')); f = o['lum'] / max(1, st.mean[0])
        col = col.point(lambda v: min(255, int(v * f)))
    if rot: col, rough = col.rotate(90, expand=True), rough.rotate(90, expand=True) if rough else None; nor = rot_normal(nor)
    tc, tn, tr = tile(col, rx, ry), tile(nor.convert('RGB'), rx, ry), tile(rough.convert('L'), rx, ry) if rough is not None else None
    if 'stagger' in o: tc, tn, tr = (stagger(im, *o['stagger']) if im is not None else None for im in (tc, tn, tr))
    x, y = (k % COLS) * T, (k // COLS) * T
    sheets['c'].paste(tc, (x, y)); sheets['n'].paste(tn, (x, y))
    if tr is not None: sheets['r'].paste(tr, (x, y))
sheets['c'].save(os.path.join(OUT, 'mat_color.jpg'), quality=86, optimize=True)
sheets['n'].save(os.path.join(OUT, 'mat_normal.jpg'), quality=90, subsampling=0, optimize=True)
sheets['r'].save(os.path.join(OUT, 'mat_rough.jpg'), quality=85, optimize=True)
for f in ('mat_color.jpg', 'mat_normal.jpg', 'mat_rough.jpg'): print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
