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
# (asset id, repeats across the 3 m tile, repeats down, rotate 90 deg[, mean luminance to normalise to: tinted
# materials (roofs, lawn) are brought to a mid grey so the per-building tint colour decides the final colour)]
MATS = [
    ('Plaster001', 1, 1, False),        # 0 plaster (tinted per building)
    ('Plaster007', 1, 1, False),        # 1 rough stucco / adobe
    ('WoodSiding008', 1, 1, False),     # 2 weathered chalet boards (horizontal)
    ('WoodSiding009', 2, 4, False),     # 3 painted clapboard
    ('WoodSiding001', 2, 2, True),      # 4 barn boards (vertical)
    ('Planks037A', 1, 1, False),        # 5 dark timber
    ('Bricks085', 2, 4, False),         # 6 red brick
    ('Bricks076A', 2, 2, False),        # 7 rubble stone
    ('RoofingTiles014A', 1, 1, False, 170),  # 8 clay tiles
    ('RoofingTiles003', 2, 2, False, 165),   # 9 slate
    ('RoofingTiles013A', 1, 1, False, 160),  # 10 dark concrete tiles
    ('CorrugatedSteel009', 1, 2, True), # 11 corrugated metal (vertical ribs)
    ('ThatchedRoof001A', 1, 1, False),  # 12 thatch
    ('PavingStones142', 2, 2, False),   # 13 cobbles
    ('PavingStones128', 2, 2, False),   # 14 paving slabs
    ('Gravel023', 2, 2, False),         # 15 gravel
    ('Asphalt031', 1, 1, False),        # 16 asphalt
    ('Grass005', 2, 2, False, 185, 0.35),    # 17 lawn (half grey: tinted with the terrain colour per plot)
    ('Concrete034', 1, 2, False),       # 18 concrete
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
for k, (aid, rx, ry, rot, *norm) in enumerate(MATS):
    col, nor, rough, ao = load(aid, 'Color').convert('RGB'), load(aid, 'NormalGL'), load(aid, 'Roughness'), load(aid, 'AmbientOcclusion')
    if ao is not None: col = ImageChops.multiply(col, ao.convert('L').point(lambda v: int(255 * (v / 255) ** 0.6)).convert('RGB'))
    if len(norm) > 1:  # keep only this fraction of the saturation
        col = Image.blend(col.convert('L').convert('RGB'), col, norm[1])
    if norm:
        st = ImageStat.Stat(col.convert('L')); f = norm[0] / max(1, st.mean[0])
        col = col.point(lambda v: min(255, int(v * f)))
    if rot: col, rough = col.rotate(90, expand=True), rough.rotate(90, expand=True) if rough else None; nor = rot_normal(nor)
    x, y = (k % COLS) * T, (k // COLS) * T
    sheets['c'].paste(tile(col, rx, ry), (x, y))
    sheets['n'].paste(tile(nor.convert('RGB'), rx, ry), (x, y))
    if rough is not None: sheets['r'].paste(tile(rough.convert('L'), rx, ry), (x, y))
sheets['c'].save(os.path.join(OUT, 'mat_color.jpg'), quality=86, optimize=True)
sheets['n'].save(os.path.join(OUT, 'mat_normal.jpg'), quality=90, subsampling=0, optimize=True)
sheets['r'].save(os.path.join(OUT, 'mat_rough.jpg'), quality=85, optimize=True)
for f in ('mat_color.jpg', 'mat_normal.jpg', 'mat_rough.jpg'): print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
