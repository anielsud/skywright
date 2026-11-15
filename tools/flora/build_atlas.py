"""Build the vegetation texture atlas (assets/flora/foliage_*.webp) from CC0 Poly Haven foliage scans.

    python3 tools/flora/fetch.py /tmp/ph             # download the source textures (1k diffuse + alpha)
    python3 tools/flora/build_atlas.py /tmp/ph assets/flora

Each atlas region is a "card" texture assembled from many real leaves / twigs (branch sprays, leaf clusters,
palm fronds, fern clumps, grass tufts), so the runtime trees can stay a few hundred triangles each.
The region rectangles are mirrored in src/flora.js (REG) -- keep them in sync.
Sources (all CC0, https://polyhaven.com): fir_tree_01, pine_tree_01, island_tree_02, shrub_02, shrub_04,
fern_02.
"""
import math, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

SOURCES = {
    'fir': ('fir_tree_01', 'twig_diff.jpg', 'twig_alpha.png'),
    'pine': ('pine_tree_01', 'twig_diff.jpg', 'twig_alpha.png'),
    'leafL': ('island_tree_02', 'leaves_diff.jpg', 'leaves_alpha.png'),
    'shrub': ('shrub_02', 'Diffuse.jpg', 'Alpha.png'),
    'shrub4': ('shrub_04', 'Diffuse.jpg', 'Alpha.png'),
    'fern': ('fern_02', 'Diffuse.jpg', 'Alpha.png'),
}
S = 2048
# name: (x, y, w, h) in the 2048 atlas -- mirrored in src/flora.js
REG = {
    'spray': (0, 0, 1024, 512), 'broad': (1024, 0, 512, 512), 'birch': (1536, 0, 512, 512),
    'frond': (0, 512, 1024, 512), 'tropic': (1024, 512, 512, 512), 'fern': (1536, 512, 512, 512),
    'grass': (0, 1024, 1024, 256), 'flower': (0, 1280, 512, 256), 'scrub': (512, 1280, 512, 256),
    'bark': (1024, 1024, 512, 512), 'birchbark': (1536, 1024, 256, 512), 'pine': (0, 1536, 1024, 512),
    'juniper': (1024, 1536, 512, 512), 'white': (1984, 1984, 64, 64),
}


def rng(seed):
    return np.random.default_rng(seed)


def stamp(cv, sp, base, d, length, tint=(1, 1, 1), bright=1.0, width=None):
    """Paste sprite sp (growth pointing up, stem at the bottom centre) so its stem sits at base, pointing along d."""
    w, h = sp.size
    sc = length / h
    nw, nh = max(2, int(w * (width / length if width else 1) * sc)), max(2, int(length))
    s = sp.resize((nw, nh), Image.LANCZOS)
    if tint != (1, 1, 1) or bright != 1.0:
        a = np.asarray(s).astype(np.float32)
        a[..., :3] *= np.array(tint, np.float32) * bright
        s = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
    ang = math.degrees(math.atan2(-d[0], -d[1]))
    r = s.rotate(ang, resample=Image.BICUBIC, expand=True)
    # where the stem (bottom centre) ended up in the rotated image
    cx, cy = nw / 2, nh / 2
    px, py = 0, nh / 2  # stem relative to centre (y down)
    a = math.radians(ang)
    rx, ry = px * math.cos(a) + py * math.sin(a), -px * math.sin(a) + py * math.cos(a)
    ox, oy = r.size[0] / 2 + rx, r.size[1] / 2 + ry
    paste_clip(cv, r, int(round(base[0] - ox)), int(round(base[1] - oy)))


def paste_clip(cv, im, x, y):
    W, H = cv.size; w, h = im.size
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0: return
    cv.alpha_composite(im.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def region(w, h):
    return Image.new('RGBA', (w, h), (0, 0, 0, 0))


def unit(a):
    return (math.cos(a), math.sin(a))


def conifer_spray(twigs, w, h, seed, needle_tint=(1, 1, 1), droopy=False):
    """A spruce / fir branch seen from above: a main axis (trunk at the left, tip at the right), side shoots
    covered by real twig scans, older (darker) growth inside, fresh light-green tips outside."""
    R = rng(seed); cv = region(w, h); cy = h / 2; x0, L = 14, w - 40
    env = lambda t: h * 0.47 * math.sin(math.pi * min(1, t * 1.05 + 0.05)) ** 0.6 * (1 - 0.25 * t)
    # dark inner mass: the old needles deep in the spray, so the card reads solid from a distance
    d = ImageDraw.Draw(cv)
    pts = [(x0 + t * L, cy - env(t) * 0.55) for t in np.linspace(0, 1, 30)] + [(x0 + t * L, cy + env(t) * 0.55) for t in np.linspace(1, 0, 30)]
    d.polygon(pts, fill=(26, 38, 22, 255))
    cv = cv.filter(ImageFilter.GaussianBlur(10))
    a = np.asarray(cv).copy(); a[..., 3] = np.where(a[..., 3] > 150, 255, 0); cv = Image.fromarray(a, 'RGBA')
    d = ImageDraw.Draw(cv)
    d.line([(x0, cy), (x0 + L, cy)], fill=(70, 50, 34, 255), width=7)
    for layer in range(3):  # back (dark, old) -> front (fresh)
        br = (0.55, 0.78, 1.0)[layer]
        n = (34, 30, 26)[layer]
        for k in range(n):
            t = (k + R.random()) / n
            bx = x0 + t * L
            e = env(t)
            if e < 20: continue
            side = 1 if (k + layer) % 2 else -1
            ang = side * (0.75 + R.random() * 0.35)  # angle from the main axis
            dvec = (math.cos(ang), math.sin(ang))
            ln = min(e / max(0.4, abs(math.sin(ang))), 300) * (0.75 + R.random() * 0.35)
            if ln < 30: continue
            sp = twigs[R.integers(len(twigs))]
            tip = 0.6 + 0.4 * t
            stamp(cv, sp, (bx, cy + side * R.random() * 6), dvec, ln, needle_tint, br * (0.85 + 0.25 * R.random()) * (0.85 + 0.25 * tip), width=ln * (0.75 + R.random() * 0.3))
    # the leader shoot along the axis tip
    for k in range(4):
        t = 0.55 + k * 0.12
        stamp(cv, twigs[R.integers(len(twigs))], (x0 + t * L, cy), (1, (R.random() - 0.5) * 0.3), min(L * (1.02 - t) + 60, 260), needle_tint, 1.0)
    return cv


def leaf_cluster(leaves, w, h, seed, n, size, tint=(1, 1, 1), twig=(72, 56, 40), flat=0.0):
    """A clump of real leaves radiating from twigs around the centre; darker underneath / inside."""
    R = rng(seed); cv = region(w, h); cx, cy = w / 2, h / 2
    d = ImageDraw.Draw(cv)
    rad = min(w, h) * 0.5 - size * 0.55
    # twigs
    ends = []
    for k in range(9):
        a = k / 9 * math.tau + R.random() * 0.5
        e = (cx + math.cos(a) * rad * 0.8, cy + math.sin(a) * rad * 0.8)
        d.line([(cx, cy), e], fill=twig + (255,), width=4); ends.append(e)
    order = sorted(range(n), key=lambda i: R.random())
    for q, i in enumerate(order):
        rr = rad * math.sqrt(R.random()) * 0.95
        a = R.random() * math.tau
        p = (cx + math.cos(a) * rr, cy + math.sin(a) * rr * (1 - flat))
        out = rr / rad
        top = 1 - p[1] / h
        dirv = unit(a + (R.random() - 0.5) * 1.2)
        sz = size * (0.7 + R.random() * 0.5)
        br = (0.55 + 0.35 * (q / n)) * (0.85 + 0.2 * top) * (0.85 + 0.3 * out)
        stamp(cv, leaves[R.integers(len(leaves))], (p[0] - dirv[0] * sz * 0.35, p[1] - dirv[1] * sz * 0.35), dirv, sz, tint, br)
    return cv


def palm_frond(leaflets, w, h, seed):
    """Rachis along x (crown at the left), long leaflets swept towards the tip, real leaf scans stretched thin."""
    R = rng(seed); cv = region(w, h); cy = h / 2
    d = ImageDraw.Draw(cv)
    for side in (-1, 1):
        n = 84
        for k in range(n):
            t = 0.04 + 0.94 * k / n
            x = 8 + t * (w - 20)
            L = h * 0.5 * math.sin(math.pi * min(1, 0.1 + t * 0.95)) ** 0.7 * (1 - 0.35 * t) * (0.85 + R.random() * 0.25)
            if L < 15: continue
            a = 0.95 + R.random() * 0.25
            dvec = (math.cos(a), side * math.sin(a))
            stamp(cv, leaflets[R.integers(len(leaflets))], (x, cy), dvec, L, (0.95, 1.0, 0.8), 0.8 + 0.35 * R.random(), width=L * 0.16)
    d.line([(4, cy), (w - 10, cy)], fill=(150, 140, 80, 255), width=6)
    return cv


def fern_clump(fronds, w, h, seed):
    R = rng(seed); cv = region(w, h)
    for k in range(9):
        a = -math.pi / 2 + (k / 8 - 0.5) * 2.4 + (R.random() - 0.5) * 0.2
        stamp(cv, fronds[R.integers(len(fronds))], (w / 2 + (R.random() - 0.5) * 20, h - 6), unit(a), h * (0.75 + R.random() * 0.25), (1, 1, 1), 0.75 + 0.35 * R.random(), width=h * 0.32)
    return cv


def blade_clumps(w, h, seed, clumps=7, blades=46, flowers=False):
    """Grass: separate clumps of tapered, curving blades (dark at the base, light and partly dry at the tips),
    drawn at 2x and downsampled for clean edges. Gaps between the clumps keep the cards from reading as slabs."""
    R = rng(seed); W2, H2 = w * 2, h * 2
    cv = Image.new('RGBA', (W2, H2), (0, 0, 0, 0)); d = ImageDraw.Draw(cv)
    for c in range(clumps):
        cx = (c + 0.5) / clumps * W2 + (R.random() - 0.5) * W2 / clumps * 0.6
        spread = W2 / clumps * (0.25 + R.random() * 0.2)
        for b in range(blades):
            bx = cx + (R.random() - 0.5) * spread
            hh = H2 * (0.35 + R.random() ** 0.7 * 0.62)
            lean = (bx - cx) / spread * hh * 0.5 + (R.random() - 0.5) * hh * 0.35
            bw = 5 + R.random() * 6
            dry = R.random() < 0.15
            n = 8
            left, right = [], []
            for k in range(n + 1):
                t = k / n
                x = bx + lean * t * t
                y = H2 - hh * (t - 0.08 * t * t)
                ww = bw * (1 - t) ** 0.8 / 2
                left.append((x - ww, y)); right.append((x + ww, y))
            col0 = np.array([92, 108, 70]) * (0.8 + 0.4 * R.random())  # pale: tinted per instance with the ground colour
            col1 = (np.array([235, 222, 160]) if dry else np.array([200, 222, 150])) * (0.78 + 0.22 * R.random())
            # draw as segments so the colour runs from the base to the tip
            for k in range(n):
                t = (k + 0.5) / n
                col = tuple(int(v) for v in col0 * (1 - t) + col1 * t) + (255,)
                d.polygon([left[k], left[k + 1], right[k + 1], right[k]], fill=col)
    if flowers:
        for k in range(int(w / 20)):
            x, y = R.random() * W2, H2 * (0.1 + R.random() * 0.45)
            col = [(250, 250, 245), (250, 214, 60), (190, 120, 220), (240, 240, 250), (230, 60, 50)][k % 5]
            d.line([(x, y), (x + (R.random() - 0.5) * 16, H2)], fill=(150, 175, 110, 255), width=3)
            r = 10 + R.random() * 10
            for p in range(6):
                a = p / 6 * math.tau
                d.ellipse([x + math.cos(a) * r * 0.7 - r * 0.5, y + math.sin(a) * r * 0.7 - r * 0.5, x + math.cos(a) * r * 0.7 + r * 0.5, y + math.sin(a) * r * 0.7 + r * 0.5], fill=col + (255,))
            d.ellipse([x - r * 0.35, y - r * 0.35, x + r * 0.35, y + r * 0.35], fill=(235, 190, 40, 255))
    return cv.resize((w, h), Image.LANCZOS)


def scrub(leaves, w, h, seed):
    """Desert sage / creosote: forked grey twigs with tiny grey-green leaves."""
    R = rng(seed); cv = region(w, h); d = ImageDraw.Draw(cv); tips = []
    def br(x, y, a, L, dep):
        ex, ey = x + math.cos(a) * L, y - math.sin(a) * L
        d.line([(x, y), (ex, ey)], fill=(92, 80, 66, 255), width=max(1, dep + 1))
        if dep > 0:
            for _ in range(2 + (R.random() < 0.5)): br(ex, ey, a + (R.random() - 0.5) * 1.1, L * (0.62 + R.random() * 0.2), dep - 1)
        else: tips.append((ex, ey))
    for k in range(7): br(w / 2 + (R.random() - 0.5) * 60, h - 3, math.pi / 2 + (R.random() - 0.5) * 1.5, h * 0.3, 3)
    for (x, y) in tips:
        for q in range(5):
            stamp(cv, leaves[R.integers(len(leaves))], (x + (R.random() - 0.5) * 16, y + (R.random() - 0.5) * 16), unit(R.random() * math.tau), 14 + R.random() * 10, (0.9, 0.95, 0.85), 0.9 + 0.3 * R.random())
    return cv


def birch_bark(w, h, seed):
    R = rng(seed)
    a = np.full((h, w, 3), (226, 222, 210), np.float32)
    a *= (0.9 + 0.1 * ndimage.gaussian_filter(R.random((h, w)), 3))[..., None]
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert('RGBA'); d = ImageDraw.Draw(im)
    for k in range(70):  # lenticels: thin dark horizontal dashes, a few big black patches
        x, y, L = R.random() * w, R.random() * h, 8 + R.random() * 50
        d.line([(x, y), (x + L, y + (R.random() - 0.5) * 3)], fill=(40, 36, 32, 255), width=1 + int(R.random() * 3))
    for k in range(10):
        x, y = R.random() * w, R.random() * h
        d.ellipse([x - 20 - R.random() * 25, y - 6 - R.random() * 10, x + 20 + R.random() * 25, y + 6 + R.random() * 10], fill=(30, 28, 26, 255))
    return im


def dilate_rgb(im):
    """Fill transparent texels with nearby opaque colours, so mipmaps / bilinear filtering never bleed black."""
    a = np.asarray(im).astype(np.float32)
    m = a[..., 3] > 127
    if not m.any(): return im
    idx = ndimage.distance_transform_edt(~m, return_distances=False, return_indices=True)
    rgb = a[..., :3][idx[0], idx[1]]
    rgb = ndimage.gaussian_filter(rgb, (6, 6, 0)) * (~m)[..., None] + a[..., :3] * m[..., None]
    out = np.dstack([rgb, a[..., 3]])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA')


def main(src, outdir):
    from sprites import sprites
    sp = {k: sprites(src, *v) for k, v in SOURCES.items()}
    fir = [sp['fir'][i] for i in (1, 2, 3, 4, 6, 7)]
    pine = [sp['pine'][1]]
    leafL = sp['leafL']
    willow = sp['shrub'][1:]
    oval = sp['shrub4'][1:10]
    ferns = sp['fern']
    atlas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    parts = {
        'spray': conifer_spray(fir, *REG['spray'][2:], 1),
        'pine': conifer_spray(pine, *REG['pine'][2:], 2, (0.78, 1.0, 0.72)),
        'broad': leaf_cluster(oval, *REG['broad'][2:], 3, 230, 64, (0.8, 1.05, 0.7)),
        'birch': leaf_cluster(oval, *REG['birch'][2:], 4, 300, 44, (0.95, 1.15, 0.7)),
        'tropic': leaf_cluster(leafL, *REG['tropic'][2:], 5, 70, 150, (0.95, 1.05, 0.85)),
        'juniper': leaf_cluster([sp['pine'][1]] + fir[:3], *REG['juniper'][2:], 6, 90, 140, (0.8, 0.95, 0.95)),
        'frond': palm_frond(willow + leafL[:3], *REG['frond'][2:], 7),
        'fern': fern_clump(ferns, *REG['fern'][2:], 8),
        'grass': blade_clumps(*REG['grass'][2:], 9, 8, 40),
        'flower': blade_clumps(*REG['flower'][2:], 10, 4, 30, flowers=True),
        'scrub': scrub(oval, *REG['scrub'][2:], 11),
        'bark': Image.open(f"{src}/fir_tree_01/bark_diff.jpg").convert('RGBA').resize(REG['bark'][2:], Image.LANCZOS),
        'birchbark': birch_bark(*REG['birchbark'][2:], 12),
        'white': Image.new('RGBA', REG['white'][2:], (255, 255, 255, 255)),
    }
    for k, im in parts.items():
        x, y, w, h = REG[k]
        atlas.paste(dilate_rgb(im), (x, y))
    os.makedirs(outdir, exist_ok=True)
    for size in (2048, 1024):
        im = atlas if size == S else atlas.resize((size, size), Image.LANCZOS)
        png = f"{outdir}/.foliage_{size}.png"; im.save(png)
        subprocess.run(['cwebp', '-quiet', '-q', '88', '-alpha_q', '100', '-exact', png, '-o', f"{outdir}/foliage_{size}.webp"], check=True)
        os.remove(png)
        print(size, os.path.getsize(f"{outdir}/foliage_{size}.webp"))


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main(sys.argv[1], sys.argv[2])
