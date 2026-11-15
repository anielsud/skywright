"""Bake the hangar's surface textures (assets/hangar/) from the CC0 Poly Haven 2k JPGs that fetch.py downloads.

usage: python3 tools/hangar/bake.py DOWNLOAD_DIR
Per material and size, three WebPs:
  <name>_<px>_c.webp  sRGB albedo with the ambient occlusion multiplied in (optionally desaturated to a grey that
                      src/hangarEnv.js tints, and normalised to a target mean luminance)
  <name>_<px>_n.webp  OpenGL tangent-space normals
  <name>_<px>_r.webp  roughness (greyscale)
The big size is for High / Ultra, the small one for Medium / Low (the tablet).
"""
import os, sys
from PIL import Image, ImageChops, ImageStat

SRC = os.path.join(sys.argv[1], 'tex')
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'hangar')
# name: (Poly Haven id, sizes, desaturate, target mean luminance or None)
MATS = {
    'floor': ('hangar_concrete_floor', (2048, 1024), False, 150),
    'cladding': ('box_profile_metal_sheet', (1024, 512), True, 175),
    'door': ('corrugated_iron_02', (1024, 512), True, 190),
    'plate': ('metal_plate', (512, 256), True, 140),
    'plywood': ('plywood', (512, 256), False, None),
    'block': ('concrete_block_wall', (1024, 512), True, 185),
    'apron': ('asphalt_floor', (1024, 512), True, 180),
    'rubber': ('rubber_tiles', (512, 256), False, None),
}
os.makedirs(OUT, exist_ok=True)
total = 0
for name, (aid, sizes, grey, lum) in MATS.items():
    d = os.path.join(SRC, aid)
    col = Image.open(os.path.join(d, 'Diffuse.jpg')).convert('RGB')
    arm = Image.open(os.path.join(d, 'arm.jpg')).convert('RGB')
    nor = Image.open(os.path.join(d, 'nor_gl.jpg')).convert('RGB')
    ao, rough, _ = arm.split()
    ao = ao.point(lambda v: int(255 - (255 - v) * 0.7))  # keep some AO for the env lighting, but don't double-darken
    col = ImageChops.multiply(col, Image.merge('RGB', (ao, ao, ao)))
    if grey: col = col.convert('L').convert('RGB')
    if lum:
        m = ImageStat.Stat(col.convert('L')).mean[0]
        col = col.point(lambda v: min(255, int(v * lum / m)))
    for px in sizes:
        for suf, im, q in (('c', col, 82), ('n', nor, 88), ('r', rough, 80)):
            p = os.path.join(OUT, f'{name}_{px}_{suf}.webp')
            im.resize((px, px), Image.LANCZOS).save(p, 'WEBP', quality=q, method=6)
            total += os.path.getsize(p)
            print(p, os.path.getsize(p))
print('total', total)
