"""Cut the individual leaves / twigs / tufts out of Poly Haven foliage textures (diffuse + alpha mask).
Shared by build_atlas.py. sprites(src_dir, asset, diff, alpha) -> list of RGBA PIL images, largest first."""
import numpy as np
from PIL import Image
from scipy import ndimage


def load_rgba(src, asset, diff, alpha):
    d = Image.open(f"{src}/{asset}/{diff}").convert("RGB")
    a = Image.open(f"{src}/{asset}/{alpha}")
    a = np.asarray(a.convert("I") if a.mode.startswith("I") else a.convert("L"), dtype=np.float64)
    if a.max() > 255: a = a / 257.0
    rgba = np.dstack([np.asarray(d, dtype=np.uint8), np.clip(a, 0, 255).astype(np.uint8)])
    return rgba


def sprites(src, asset, diff, alpha, min_area=1500, pad=2):
    rgba = load_rgba(src, asset, diff, alpha)
    mask = rgba[..., 3] > 100
    # join pieces of one sprite (thin stems) before labelling
    lab, n = ndimage.label(ndimage.binary_dilation(mask, iterations=3))
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab)):
        ys, xs = sl
        area = int((lab[sl] == i + 1).sum())
        if area < min_area: continue
        y0, y1, x0, x1 = max(0, ys.start - pad), min(rgba.shape[0], ys.stop + pad), max(0, xs.start - pad), min(rgba.shape[1], xs.stop + pad)
        crop = rgba[y0:y1, x0:x1].copy()
        crop[..., 3] = np.where(lab[y0:y1, x0:x1] == i + 1, crop[..., 3], 0)
        out.append((area, Image.fromarray(crop, "RGBA")))
    out.sort(key=lambda t: -t[0])
    return [im for _, im in out]


if __name__ == "__main__":  # contact sheet of what each source yields: python3 sprites.py SRC OUT.png
    import sys
    from build_atlas import SOURCES
    src, outp = sys.argv[1], sys.argv[2]
    rows = []
    for key, (asset, diff, alpha) in SOURCES.items():
        sp = sprites(src, asset, diff, alpha)
        print(key, len(sp), [s.size for s in sp[:12]])
        row = Image.new("RGBA", (12 * 128, 128), (190, 200, 255, 255))
        for k, s in enumerate(sp[:12]):
            t = s.copy(); t.thumbnail((124, 124)); row.alpha_composite(t, (k * 128 + 2, 2))
        rows.append(row)
    sheet = Image.new("RGBA", (12 * 128, 128 * len(rows)))
    for i, r in enumerate(rows): sheet.paste(r, (0, i * 128))
    sheet.save(outp)
