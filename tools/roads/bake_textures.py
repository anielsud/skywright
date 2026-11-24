#!/usr/bin/env python3
"""Pack the road surface textures (tex/roads/) from CC0 ambientCG sets (ambientcg.com, CC0):
  Asphalt015 (fine-aggregate asphalt: the surface), Asphalt026C (cracked asphalt: its crack pattern only), Gravel023
  (the shoulders). Each colour map is divided by its own mean, so src/roadSurface.js tints it per region (light grey
  Swiss asphalt, darker US blacktop) instead of carrying one fixed colour.

  python3 tools/roads/bake_textures.py DIR   (DIR holds Asphalt015_1K-JPG.zip, Asphalt026C_1K-JPG.zip, Gravel023_1K-JPG.zip
                                            from https://ambientcg.com/get?file=<id>_1K-JPG.zip)
Writes, 1024 px, tiling:
  asphalt_d.jpg  RGB: asphalt colour / its mean, x 0.5 (so 0.5 = average; the shader multiplies by 2)
  asphalt_n.jpg  RG: asphalt normal (OpenGL, x/y), B: crack mask (1 = crack, from Asphalt026C's displacement)
  gravel_d.jpg   RGB: gravel colour / its mean, x 0.5
"""
import io, os, sys, zipfile
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tex', 'roads')


def img(z, suffix):
    with zipfile.ZipFile(z) as f:
        name = next(n for n in f.namelist() if n.endswith(suffix))
        return np.asarray(Image.open(io.BytesIO(f.read(name))).convert('RGB').resize((1024, 1024), Image.LANCZOS), dtype=np.float32) / 255


def flat(c):
    # divide out the mean colour and the low frequencies (lighting gradients across the photo): keeps the grain
    from PIL import ImageFilter
    low = np.asarray(Image.fromarray((c * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(96)), dtype=np.float32) / 255
    out = c / np.maximum(low, 1e-3) * c.mean(axis=(0, 1)) / c.mean()
    return np.clip(out * 0.5, 0, 1)


def save(a, name):
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, name), quality=78, optimize=True)
    print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')


def main(d):
    z = lambda i: os.path.join(d, f'{i}_1K-JPG.zip')
    save(flat(img(z('Asphalt015'), '_Color.jpg')), 'asphalt_d.jpg')
    n = img(z('Asphalt015'), '_NormalGL.jpg')
    disp = img(z('Asphalt026C'), '_Displacement.jpg')[..., 0]
    # cracks: the narrow dark grooves of the displacement (below its local level), soft-thresholded
    from PIL import ImageFilter
    lvl = np.asarray(Image.fromarray((disp * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)), dtype=np.float32) / 255
    crack = np.clip((lvl - disp - 0.03) * 9, 0, 1)
    save(np.dstack([n[..., 0], n[..., 1], crack]), 'asphalt_n.jpg')
    save(flat(img(z('Gravel023'), '_Color.jpg')), 'gravel_d.jpg')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
