"""Bake the Moon's near side, seen face-on (orthographic), from an equirectangular albedo map (src/moon.js draws it).

Source: NASA SVS CGI Moon Kit, https://svs.gsfc.nasa.gov/4720 (public domain):
  curl -LO https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg
usage: python3 tools/moon/bake.py lroc_color_poles_1k.jpg assets/moon/moon_256.jpg 256
Needs numpy and Pillow."""
import sys
import numpy as np
from PIL import Image

src = np.asarray(Image.open(sys.argv[1]).convert('L'), dtype=np.float32) / 255.0
H, W = src.shape
S = int(sys.argv[3])
ss = 4  # supersample
N = S * ss
y, x = np.mgrid[0:N, 0:N]
u = (x + 0.5) / N * 2 - 1
v = 1 - (y + 0.5) / N * 2
r2 = u * u + v * v
inside = r2 <= 1
z = np.sqrt(np.clip(1 - r2, 0, 1))
lat = np.arcsin(np.clip(v, -1, 1))
lon = np.arctan2(u, z)  # near side centred on longitude 0, east to the right
px = ((lon / (2 * np.pi) + 0.5) * W).astype(int) % W
py = np.clip(((0.5 - lat / np.pi) * H).astype(int), 0, H - 1)
img = np.where(inside, src[py, px], 0.0)
img = img.reshape(S, ss, S, ss).mean(axis=(1, 3))
# normalise: the brightest highlands to ~0.95 of white (the shader applies the real brightness)
hi = np.percentile(img[img > 0.02], 99.5)
img = np.clip(img / hi * 0.95, 0, 1)
Image.fromarray((img * 255 + 0.5).astype(np.uint8), 'L').save(sys.argv[2], quality=88, optimize=True)
print('ok', S, img.max())
