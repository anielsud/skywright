#!/usr/bin/env python3
"""Bake a real-world location for Skywright into static assets under assets/real/<id>/.

Usage:  python3 tools/realworld/bake.py lauterbrunnen [--cache DIR] [--only heights,imagery,osm]
Needs:  Python 3 with numpy, Pillow and scipy. Network access to the sources below (only while baking:
        the game itself loads nothing but the baked files, so it works offline and needs no API keys).

Sources (see README Credits):
  elevation  AWS Open Data Terrain Tiles, Terrarium PNG (https://registry.opendata.aws/terrain-tiles/)
  imagery    EOX Sentinel-2 cloudless 2016 (s2cloudless_3857), CC BY 4.0:
             "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH
              (Contains modified Copernicus Sentinel data 2016)". Later years are CC BY-NC-SA: not used.
             In the US (imagery='naip'): USDA NAIP aerial imagery via the USGS National Map ImageServer, public domain.
             The forest mask comes from the photo's colours.
  map data   OpenStreetMap via the Overpass API, (c) OpenStreetMap contributors, ODbL.

Local frame (the game's world frame): metres, origin at the location's runway centre, y up, the runway along z.
The game's -z points to the compass bearing `north` (degrees; 0 means -z is true north, +x east), so a real runway
of any heading lines up with the game's airport. Equirectangular about the origin (error well under 0.1 %).

Outputs (all little-endian):
  hi.bin.gz / far.bin.gz  heights: uint16 per sample, (h + 200) * 8 (0.125 m steps), each row delta-coded
                          (first value absolute, then differences mod 65536), gzip'd. Row-major, rows go +z.
  hi.jpg / far.jpg        Sentinel-2 imagery over the same squares (top row = -z).
  cover.png               8-bit landcover over the hi square (vegetation mask, see bake_osm).
  osm.json                buildings, roads, rail, cable cars for the hi area (see bake_osm).
  meta.json               extents and grid sizes.
"""
import argparse, gzip, io, json, math, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

R_EARTH = 6371008.8
UA = 'skywright-bake/1.0 (offline asset bake for a hobby flight game)'

LOCS = {
    'lauterbrunnen': dict(
        # runway centre: the old Interlaken military airfield (LSMI) on the Bödeli plain; its runway runs 050/230,
        # so the game's north (-z, along the runway) is turned to bearing 050 (north: the bearing of game -z)
        lat0=46.6768, lon0=7.8792, north=50, rwyH=568,
        # hi-detail square (x0, z0, size m), its grid, and the coarse far square around it
        hi=(-14000, -16000, 40000), hiN=2048, hiImg=4096, hiZoomH=13, hiZoomI=14,
        far=(-120000, -120000, 240000), farN=1024, farImg=2048, farZoomH=9, farZoomI=10,
        # one level for the game's water plane, between Thunersee (557.8 m) and Brienzersee (563.7 m)
        water=561,
    ),
    'islands': dict(
        # Bora Bora: runway centre on Motu Mute, the reef islet north of the main island. Runway 11/29 runs 124.6 deg
        # true, so game -z points there (take-off to the south-east with Otemanu ahead on the right); the terminal and
        # the boat dock sit on the lagoon side (game +x), as the real ones do. The id keeps the old Coral Islands' slot.
        lat0=-16.444372, lon0=-151.751256, north=124.6, rwyH=2.5,
        # detailed square: the whole lagoon and barrier reef with a ring of deep ocean; coarse square: Tupai, Taha'a,
        # Raiatea, Maupiti and Huahine on the horizon
        hi=(-8400, -16400, 24000), hiN=2048, hiImg=4096, hiZoomH=13, hiZoomI=14,
        far=(-70000, -110000, 180000), farN=2048, farImg=4096, farZoomH=11, farZoomI=12,
        padBlend=160,  # = loc.padBlend in src/realworld.js: the airport's apron meets the lagoon within 160 m
        water=0, sea=True,  # sea level; the lagoon and ocean floor come from bathymetry (tools/realworld/sea.py)
    ),
    # The Grand Canyon (replaces the old fictional "Red Canyon", so it keeps the id 'canyon'). Origin: Grand Canyon
    # National Park Airport (KGCN, Tusayan), runway 03/21, whose OSM way runs at true bearing 040.5.
    'canyon': dict(
        lat0=35.95235, lon0=-112.14698, north=40.5, rwyH=2002,
        # the detailed square reaches from the airport over the South Rim villages and the canyon (Hermit's Rest to
        # Desert View, Phantom Ranch, the river) to the North Rim
        hi=(-17000, -35000, 40000), hiN=2048, hiImg=8192, hiTiers=(4096, 2048), coverN=4096, hiZoomH=13,
        far=(-120000, -120000, 240000), farN=1024, farImg=2048, farZoomH=9, farZoomI=10,
        # nothing in the area is anywhere near this low: the river is local water (bake_river), not the game's water plane
        water=200,
        imagery='naip', naipM=3.5, naipFarM=110,  # USGS NAIP (public domain): source metres per pixel
        deshadow=True, forest='rgb', river='Colorado River',
    ),
}

# ---------------------------------------------------------------- geo helpers
def to_latlon(L, x, z):
    th = math.radians(L.get('north', 0))
    E = x * math.cos(th) - z * math.sin(th); N = -x * math.sin(th) - z * math.cos(th)
    lat = L['lat0'] + np.degrees(N / R_EARTH)
    lon = L['lon0'] + np.degrees(E / (R_EARTH * math.cos(math.radians(L['lat0']))))
    return lat, lon

def to_local(L, lat, lon):
    th = math.radians(L.get('north', 0))
    E = np.radians(np.asarray(lon, dtype=np.float64) - L['lon0']) * R_EARTH * math.cos(math.radians(L['lat0']))
    N = np.radians(np.asarray(lat, dtype=np.float64) - L['lat0']) * R_EARTH
    return E * math.cos(th) - N * math.sin(th), -(E * math.sin(th) + N * math.cos(th))

def merc_px(lat, lon, zoom):  # global pixel coords at zoom (256 px tiles)
    n = 256 * 2 ** zoom
    px = (lon + 180) / 360 * n
    s = np.sin(np.radians(lat))
    py = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return px, py

def fetch(url, path, tries=4):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            data = urllib.request.urlopen(req, timeout=60).read()
            with open(path + '.tmp', 'wb') as f: f.write(data)
            os.replace(path + '.tmp', path)
            return path
        except Exception as e:
            if t == tries - 1: raise RuntimeError(f'{url}: {e}')
            time.sleep(1.5 * (t + 1))

def mosaic(L, sq, zoom, url_fn, cache, kind):
    """Fetch every tile covering the square, return (mosaic array, px0, py0) in global pixel coords."""
    x0, z0, S = sq
    lat_a, lon_a = to_latlon(L, np.array([x0, x0 + S, x0, x0 + S]), np.array([z0, z0, z0 + S, z0 + S]))
    pxa, pya = merc_px(lat_a, lon_a, zoom)
    tx0, tx1 = int(min(pxa) // 256) - 1, int(max(pxa) // 256) + 1
    ty0, ty1 = int(min(pya) // 256) - 1, int(max(pya) // 256) + 1
    jobs = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    print(f'  {kind} z{zoom}: {len(jobs)} tiles', flush=True)
    def get(j):
        tx, ty = j
        return j, fetch(url_fn(zoom, tx, ty), os.path.join(cache, kind, str(zoom), f'{tx}_{ty}' + ('.png' if kind == 'terrarium' else '.jpg')))
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    out = np.zeros((H, W, 3), np.uint8)
    with ThreadPoolExecutor(6) as ex:
        for (tx, ty), p in ex.map(get, jobs):
            im = Image.open(p).convert('RGB')
            if im.size != (256, 256): im = im.resize((256, 256))
            out[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = np.asarray(im)
    return out, tx0 * 256, ty0 * 256

def bilinear(img, fx, fy):
    """Sample img (H,W[,C]) float at fractional pixel coords (pixel centres at +0.5)."""
    fx = np.clip(fx - 0.5, 0, img.shape[1] - 1.001); fy = np.clip(fy - 0.5, 0, img.shape[0] - 1.001)
    i, j = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    u, v = fx - i, fy - j
    if img.ndim == 3: u, v = u[..., None], v[..., None]
    a, b, c, d = img[j, i], img[j, i + 1], img[j + 1, i], img[j + 1, i + 1]
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v

def grid_xy(sq, N, centers=False):
    """Sample positions of an N x N grid over the square. Heights: N samples edge to edge (spacing S/(N-1)).
    Images: pixel centres (spacing S/N)."""
    x0, z0, S = sq
    if centers: t = (np.arange(N) + 0.5) / N * S
    else: t = np.arange(N) / (N - 1) * S
    return np.meshgrid(x0 + t, z0 + t)

# ---------------------------------------------------------------- heights
def bake_heights(L, sq, N, zoom, cache):
    terr = lambda z, x, y: f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
    m, px0, py0 = mosaic(L, sq, zoom, terr, cache, 'terrarium')
    m = m.astype(np.float64)
    elev = m[..., 0] * 256 + m[..., 1] + m[..., 2] / 256 - 32768
    X, Z = grid_xy(sq, N)
    lat, lon = to_latlon(L, X, Z)
    px, py = merc_px(lat, lon, zoom)
    return bilinear(elev, px - px0, py - py0).astype(np.float32)

def bake_image(L, sq, N, zoom, cache):
    eox = lambda z, x, y: f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'
    m, px0, py0 = mosaic(L, sq, zoom, eox, cache, 's2cloudless')
    X, Z = grid_xy(sq, N, centers=True)
    lat, lon = to_latlon(L, X, Z)
    px, py = merc_px(lat, lon, zoom)
    # the source is finer than the output: pre-blur so the resample doesn't alias
    src_m = (40075016.7 * math.cos(math.radians(L['lat0']))) / (256 * 2 ** zoom)
    k = (sq[2] / N) / src_m
    img = Image.fromarray(m)
    if k > 1.3: img = img.filter(ImageFilter.GaussianBlur(radius=0.42 * k))
    out = bilinear(np.asarray(img).astype(np.float32), px - px0, py - py0)
    return np.clip(lift_shadows(out) + 0.5, 0, 255).astype(np.uint8)

# ---------------------------------------------------------------- NAIP (US): USGS National Map ImageServer
NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
RM = 6378137.0

def merc(lat, lon):
    return RM * np.radians(lon), RM * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))

def naip_block(url, path, tries=8):
    """One exportImage request (slow, ~30-90 s, and the service often answers 502/504): retried with backoff,
    and only kept once it decodes as an image."""
    if os.path.exists(path):
        try: Image.open(path).size; return path
        except Exception: os.remove(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for t in range(tries):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=300).read()
            Image.open(io.BytesIO(data)).load()
            with open(path + '.tmp', 'wb') as f: f.write(data)
            os.replace(path + '.tmp', path)
            return path
        except Exception as e:
            if t == tries - 1: raise RuntimeError(f'{url[:120]}: {e}')
            time.sleep(min(60, 4 * 2 ** t))

def naip_mosaic(L, sq, src_m, cache, kind, bands=None, block=2000, pad=300):
    """Fetch NAIP over the (rotated) square in Web Mercator blocks at ~src_m true metres per pixel.
    bands=None: the natural-colour rendering (RGB); else raw bands (e.g. [0, 3] = red, near-infrared).
    Returns (mosaic uint8 HxWxC, mercator x of the left edge, y of the top edge, mercator metres per pixel)."""
    x0, z0, S = sq
    t = np.linspace(0, 1, 17)
    xs = np.concatenate([x0 - pad + t * (S + 2 * pad)] * 2 + [np.full(17, x0 - pad), np.full(17, x0 + S + pad)])
    zs = np.concatenate([np.full(17, z0 - pad), np.full(17, z0 + S + pad)] + [z0 - pad + t * (S + 2 * pad)] * 2)
    mx, my = merc(*to_latlon(L, xs, zs))
    px = src_m / math.cos(math.radians(L['lat0']))
    X0, Y1 = math.floor(mx.min() / px) * px, math.ceil(my.max() / px) * px
    W, H = int(math.ceil((mx.max() - X0) / px)), int(math.ceil((Y1 - my.min()) / px))
    nbx, nby = -(-W // block), -(-H // block)
    C = 3 if bands is None else len(bands)
    out = np.zeros((nby * block, nbx * block, C), np.uint8)
    rule = {'rasterFunction': 'NaturalColor' if bands is None else 'None'}
    ext = 'jpg' if bands is None else 'tif'
    jobs = [(i, j) for j in range(nby) for i in range(nbx)]
    print(f'  naip {kind}: {W}x{H} px at {src_m} m, {len(jobs)} blocks', flush=True)
    def req(bb, size, path, tries):
        q = dict(bbox=','.join(f'{v:.2f}' for v in bb), bboxSR=3857, imageSR=3857, size=f'{size},{size}', format='jpg' if bands is None else 'tiff',
                 compressionQuality=92, renderingRule=json.dumps(rule), interpolation='RSP_BilinearInterpolation', f='image')
        if bands is not None: q.update(bandIds=','.join(map(str, bands)), pixelType='U8', compression='LZ77')
        return naip_block(NAIP + '?' + urllib.parse.urlencode(q), path, tries)
    def get(job):
        i, j = job
        bb = (X0 + i * block * px, Y1 - (j + 1) * block * px, X0 + (i + 1) * block * px, Y1 - j * block * px)
        path = os.path.join(cache, f'naip_{kind}_{src_m}', f'{i}_{j}.{ext}')
        try: return job, np.asarray(Image.open(req(bb, block, path, 3)))
        except RuntimeError:
            # some blocks time out every time: ask for their quarters instead
            h = block // 2; parts = []
            for qj in range(2):
                for qi in range(2):
                    sb = (bb[0] + qi * h * px, bb[3] - (qj + 1) * h * px, bb[0] + (qi + 1) * h * px, bb[3] - qj * h * px)
                    parts.append(np.asarray(Image.open(req(sb, h, path[:-4] + f'_q{qj}{qi}.' + ext, 8))))
            rows = [np.concatenate(parts[k:k + 2], axis=1) for k in (0, 2)]
            return job, np.concatenate(rows, axis=0)
    done = 0
    with ThreadPoolExecutor(5) as ex:
        for (i, j), a in ex.map(get, jobs):
            if a.ndim == 2: a = a[..., None]
            a = a[..., :C]
            out[j * block:j * block + a.shape[0], i * block:i * block + a.shape[1]] = a[:block, :block]
            done += 1
            if done % 10 == 0: print(f'   {done}/{len(jobs)}', flush=True)
    return out[:H, :W], X0, Y1, px

def sample_merc(L, sq, N, M, X0, Y1, px, strip=512):
    """Resample a mercator mosaic onto the square's N x N pixel centres (game frame), a strip of rows at a time."""
    x0, z0, S = sq
    t = (np.arange(N) + 0.5) / N * S
    out = np.zeros((N, N, M.shape[2]), np.float32)
    for r0 in range(0, N, strip):
        X, Z = np.meshgrid(x0 + t, z0 + t[r0:r0 + strip])
        mx, my = merc(*to_latlon(L, X, Z))
        out[r0:r0 + strip] = bilinear(M, (mx - X0) / px, (Y1 - my) / px)
    return out

def bake_image_naip(L, sq, N, src_m, cache, kind):
    """NAIP resampled onto the square (uint8); kept in the cache, so re-tuning what follows is quick."""
    p = os.path.join(cache, f'naip_{kind}_{src_m}_{N}_{sq[0]}_{sq[1]}_{sq[2]}.npy')
    if os.path.exists(p): return np.load(p)
    M, X0, Y1, px = naip_mosaic(L, sq, src_m, cache, kind)
    k = (sq[2] / N) / src_m  # output pixel / source pixel
    if k > 1.3: M = np.asarray(Image.fromarray(M).filter(ImageFilter.GaussianBlur(radius=0.42 * k)))
    out = np.clip(sample_merc(L, sq, N, M, X0, Y1, px) + 0.5, 0, 255).astype(np.uint8)
    np.save(p, out)
    return out

def hillshade(H, sp, az, el):
    """Lambert shading of a height grid (rows +z, game frame) for a sun at compass azimuth az / elevation el (deg),
    already turned into the game frame by the caller."""
    gz, gx = np.gradient(H, sp)
    n = np.stack([-gx, np.ones_like(H), -gz], -1); n /= np.linalg.norm(n, axis=-1, keepdims=True)
    a, e = math.radians(az), math.radians(el)
    s = np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])
    return np.clip(n @ s, 0, 1)

def cast_shadow(H, sp, az, el, steps=160):
    """Cast shadows on a height grid (1 = lit) for a sun direction in the game frame (az: bearing of the sun from
    game -z, clockwise)."""
    a, tanE = math.radians(az), math.tan(math.radians(el))
    dx, dz = math.sin(a), -math.cos(a)
    N = H.shape[0]
    jj, ii = np.mgrid[0:N, 0:N].astype(np.float32)
    lit = np.ones_like(H, bool)
    from scipy import ndimage
    for s in range(1, steps):
        d = s * 1.5  # grid cells
        hs = ndimage.map_coordinates(H, [jj + dz * d, ii + dx * d], order=1, mode='nearest')
        lit &= hs < H + d * sp * tanE
    return lit

def sun_from_image(L, img, H, sp):
    """Where was the sun when the photos were taken? Correlate the image brightness with the shading of the real
    terrain over bare, steep ground, for a grid of sun positions (game-frame azimuth)."""
    n = 512
    g = np.asarray(Image.fromarray(img).resize((n, n), Image.BILINEAR)).astype(np.float32)
    lum = g @ np.array([0.3, 0.59, 0.11], np.float32)
    Hs = np.asarray(Image.fromarray(H).resize((n, n), Image.BILINEAR)); s2 = sp * (H.shape[0] - 1) / (n - 1)
    gz, gx = np.gradient(Hs, s2); slope = np.hypot(gx, gz)
    sel = slope > 0.35
    best = None
    for el in range(25, 76, 5):
        for az in range(0, 360, 6):
            hsd = hillshade(Hs, s2, az, el)[sel]
            c = np.corrcoef(hsd, lum[sel])[0, 1]
            if best is None or c > best[0]: best = (c, az, el)
    c, az, el = best
    for el2 in np.arange(el - 4, el + 5, 2):
        for az2 in np.arange(az - 5, az + 6, 2):
            c2 = np.corrcoef(hillshade(Hs, s2, az2, el2)[sel], lum[sel])[0, 1]
            if c2 > best[0]: best = (c2, az2, el2)
    c, az, el = best
    print(f'  imagery sun: azimuth {(az + L.get("north", 0)) % 360:.0f} (game {az:.0f}), elevation {el:.0f}, r={c:.2f}', flush=True)
    return float(az), float(el)

def deshadow(L, img, H, sp, az, el):
    """The aerial photos have deep cast and self shadows (dark, blue). The game lights the ground itself, so lift
    them to the brightness and colour of the same kind of ground in sunlight nearby. Shadow pixels: dark next to
    the sunlit ground around them, and either where the real terrain is shadowed for the photos' sun or bluish (the
    mosaic mixes flights, so the sun differs a little from place to place). They get the per-channel ratio of sunlit
    / shadowed means in a ~1 km window, and their colour is pulled towards the sunlit ground's."""
    from scipy import ndimage
    N = img.shape[0]
    sh = (~cast_shadow(H, sp, az, el)) | (hillshade(H, sp, az, el) < 0.12)
    sh = ndimage.binary_dilation(sh, iterations=3)
    q = 4; n = N // q
    up = lambda a: np.asarray(Image.fromarray(np.ascontiguousarray(a, np.float32)).resize((N, N), Image.BILINEAR))
    small = lambda a: np.asarray(Image.fromarray(np.ascontiguousarray(a, np.float32)).resize((n, n), Image.BOX))
    f = img.astype(np.float32)
    lum = f @ np.array([0.3, 0.59, 0.11], np.float32)
    geo_s = small(np.asarray(Image.fromarray(sh.astype(np.uint8) * 255).resize((N, N), Image.BILINEAR)) / 255.0)
    s3 = f.sum(-1) + 1
    exg = (2 * f[..., 1] - f[..., 0] - f[..., 2]) / s3  # vegetation is dark too, but green
    open_ = (exg < 0.06).astype(np.float32)
    lum_s = small(lum); open_s = small(open_)
    win = 101  # ~1.2 km at 4096
    # the sunlit brightness around each place: the 75th percentile of the brightness over ~1.2 km (robust where a
    # flight with a lower sun left big shadows the terrain doesn't explain)
    r16 = np.asarray(Image.fromarray(lum_s).resize((n // 4, n // 4), Image.BOX))
    ref = ndimage.percentile_filter(r16, 75, size=25)
    ref = ndimage.uniform_filter(ref, 5)
    ref = np.asarray(Image.fromarray(ref.astype(np.float32)).resize((n, n), Image.BILINEAR))
    zone = np.maximum(geo_s, open_s * (lum_s < ref * 0.55))
    m = zone * np.clip((ref * 0.75 - lum_s) / (ref * 0.35 + 1), 0, 1)
    lit = (1 - zone) * (lum_s > 20)
    wl, ws = ndimage.uniform_filter(lit, win) + 1e-3, ndimage.uniform_filter(m, win) + 1e-3
    gain, litc = np.ones((n, n, 3), np.float32), np.ones((n, n, 3), np.float32)
    for ch in range(3):
        c = small(f[..., ch])
        ml, ms = ndimage.uniform_filter(c * lit, win) / wl, ndimage.uniform_filter(c * m, win) / ws
        gain[..., ch] = np.clip(ml / np.maximum(ms, 4), 1, 5)
        litc[..., ch] = ml
    gain = np.where((ws > 0.01)[..., None], gain, 1)
    litc /= litc.sum(-1, keepdims=True) + 1e-3
    # full resolution: how much each pixel is in shadow, from its own brightness (no blur onto the sunlit side)
    refF = up(ref)
    dark = np.clip((refF * 0.8 - lum) / (refF * 0.4 + 1), 0, 1)
    zoneF = (up(sh.astype(np.float32)) > 0.5) | ((exg < 0.06) & (lum < refF * 0.55)) | (lum < refF * 0.3)
    del exg
    mf = ndimage.gaussian_filter(dark * zoneF, 0.7) * np.clip((refF * 0.95 - lum) / (refF * 0.3 + 1), 0, 1)
    del dark, zoneF
    G = np.stack([up(gain[..., ch]) for ch in range(3)], -1)
    out = f * (1 + (G - 1) * mf[..., None])
    del G, f
    C = np.stack([up(litc[..., ch]) for ch in range(3)], -1)
    s_ = out.sum(-1, keepdims=True)
    out += (s_ * C - out) * (0.8 * mf)[..., None]  # shadowed ground takes the colour of the sunlit ground nearby
    print(f'  deshadowed {float((mf > 0.5).mean()) * 100:.1f}% of the image, mean gain {gain.reshape(-1, 3).mean(0).round(2)}', flush=True)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)

def grade(img, warm=(1.05, 0.985, 0.94), sat=1.1):
    """NAIP's natural-colour rendering reads yellow-green and flat on bare rock (next to photos of the canyon's red
    and buff walls): warm and saturate the open ground a little, leave the vegetation alone."""
    f = img.astype(np.float32)
    exg = (2 * f[..., 1] - f[..., 0] - f[..., 2]) / (f.sum(-1) + 1)
    w = np.clip((0.07 - exg) / 0.05, 0, 1)[..., None]
    g = f * np.array(warm, np.float32)
    m = g.mean(-1, keepdims=True)
    g = m + (g - m) * sat
    return np.clip(f + (g - f) * w + 0.5, 0, 255).astype(np.uint8)

# ---------------------------------------------------------------- rivers (the Grand Canyon's Colorado)
def chain_lines(parts):
    """Join directed line pieces (OSM waterways point downstream) end to start; returns the chains."""
    parts = [p for p in parts if len(p) > 1]
    chains = []
    while parts:
        cur = parts.pop(0)
        grown = True
        while grown:
            grown = False
            for i, q in enumerate(parts):
                if np.hypot(*(cur[-1] - q[0])) < 1: cur = np.concatenate([cur, q[1:]]); parts.pop(i); grown = True; break
                if np.hypot(*(q[-1] - cur[0])) < 1: cur = np.concatenate([q, cur[1:]]); parts.pop(i); grown = True; break
        chains.append(cur)
    return chains

def resample_line(P, step):
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    t = np.arange(0, d[-1], step)
    return np.stack([np.interp(t, d, P[:, 0]), np.interp(t, d, P[:, 1])], 1)

def bake_river(L, H, osm, js_r):
    """The river far below the rim can't be the game's (single-level) water. Follow its centre line downstream,
    take the water surface from the (hydro-flattened) elevation, keep it running downhill, carve a bed under it and
    keep the banks just above it. The runtime lays a water ribbon on that profile (src/realworld.js)."""
    from scipy import ndimage, spatial
    N = H.shape[0]; x0, z0, S = L['hi']; sp = S / (N - 1)
    parts = [pts for t, pts in lines(L, js_r) if t.get('name') == L['river'] and t.get('waterway') == 'river']
    chains = sorted(chain_lines(parts), key=lambda c: -np.hypot(*np.diff(c, axis=0).T).sum())
    if not chains: print('  no river found', flush=True); osm['out']['rivers'] = []; return H
    P = resample_line(chains[0], 20)
    inside = (P[:, 0] > x0 + 200) & (P[:, 0] < x0 + S - 200) & (P[:, 1] > z0 + 200) & (P[:, 1] < z0 + S - 200)
    idx = np.nonzero(inside)[0]; P = P[idx[0]:idx[-1] + 1]
    # width: from the mapped river area (natural=water + water=river), at the cover raster's resolution
    Nw = 4096; kw = Nw / S
    wm = Image.new('L', (Nw, Nw), 0); d = ImageDraw.Draw(wm)
    for t, rings in osm['land']:
        if t.get('water') == 'river' or t.get('waterway') == 'riverbank':
            for r in rings: d.polygon([((x - x0) * kw - 0.5, (z - z0) * kw - 0.5) for x, z in r], fill=255)
    edt = ndimage.distance_transform_edt(np.asarray(wm) > 0) / kw
    ii = np.clip(((P[:, 0] - x0) * kw).astype(int), 0, Nw - 1); jj = np.clip(((P[:, 1] - z0) * kw).astype(int), 0, Nw - 1)
    hw = edt[jj, ii]
    hw = np.where(hw > 8, hw, 40)  # (not mapped as an area here: the Colorado is ~60-100 m wide in the canyon)
    hw = np.clip(ndimage.median_filter(hw, 9), 18, 80); hw = ndimage.uniform_filter1d(hw, 7)
    # surface: the lowest ground across the channel, smoothed, then never rising downstream
    def at(x, z): return ndimage.map_coordinates(H, [(z - z0) / sp, (x - x0) / sp], order=1, mode='nearest')
    tang = np.gradient(P, axis=0); tang /= np.linalg.norm(tang, axis=1, keepdims=True); nrm = np.stack([-tang[:, 1], tang[:, 0]], 1)
    raw = np.min([at(P[:, 0] + nrm[:, 0] * o * hw, P[:, 1] + nrm[:, 1] * o * hw) for o in (-0.4, -0.2, 0, 0.2, 0.4)], axis=0)
    if np.median(raw[:len(raw) // 5]) < np.median(raw[-len(raw) // 5:]):  # drawn upstream: turn it round
        P, hw, raw = P[::-1].copy(), hw[::-1].copy(), raw[::-1].copy()
    s = ndimage.median_filter(raw, 15)
    s = np.minimum.accumulate(s)
    s = ndimage.uniform_filter1d(s, 9, mode='nearest')
    print(f'  river: {len(P) * 20 / 1000:.1f} km, surface {s[0]:.0f} -> {s[-1]:.0f} m, half width {hw.min():.0f}-{hw.max():.0f} m', flush=True)
    # carve: bed under the ribbon, banks just above it
    tree = spatial.cKDTree(P)
    gx, gz = np.meshgrid(x0 + np.arange(N) * sp, z0 + np.arange(N) * sp)
    dist, k = tree.query(np.stack([gx.ravel(), gz.ravel()], 1), distance_upper_bound=float(hw.max()) + 60)
    near = np.isfinite(dist)
    dd, kk = dist[near], k[near]
    Hf = H.ravel().copy()
    si, hi_ = s[kk], hw[kk]
    bed = dd < hi_
    Hf_n = Hf[near]
    Hf_n = np.where(bed, np.minimum(Hf_n, si - 0.8 - 2.6 * (1 - (dd / hi_) ** 2)), Hf_n)
    bank = (~bed) & (dd < hi_ + 50)
    Hf_n = np.where(bank, np.maximum(Hf_n, si + 0.4 + (dd - hi_) * 0.01), Hf_n)
    Hf[near] = Hf_n
    H = Hf.reshape(N, N).astype(np.float32)
    # a seaplane start: the longest straight reach (the ribbon stays within 0.4 of its half width of the chord)
    best = (0, 0, 1)
    for i in range(0, len(P) - 10, 3):
        j = i + 10
        while j < len(P):
            a, b = P[i], P[j]; ab = b - a; Lab = np.hypot(*ab)
            dev = np.abs((P[i:j + 1, 0] - a[0]) * ab[1] - (P[i:j + 1, 1] - a[1]) * ab[0]) / Lab
            if (dev > hw[i:j + 1] * 0.4).any(): break
            j += 1
        if (j - 1 - i) > best[1] - best[0]: best = (i, j - 1, 1)
    i, j, _ = best
    a, b = P[i], P[j]
    start = [round(float(a[0] + (b[0] - a[0]) * 0.1), 1), round(float(a[1] + (b[1] - a[1]) * 0.1), 1), round(float(math.atan2(-(b[0] - a[0]), -(b[1] - a[1]))), 4), round(float(np.hypot(*(b - a))), 0)]
    print(f'  river start: {start} (straight reach {start[3]:.0f} m)', flush=True)
    osm['out']['rivers'] = [[round(float(v), 1) for p, h, w in zip(P, s, hw) for v in (p[0], p[1], h, w)]]
    osm['out']['riverStart'] = start
    return H

def clear_roofs(L, img, osm):
    """The game draws every mapped building in 3D, so take the (10 m, blurry) roofs out of the photo: pixels under and
    right around buildings get the colour of the nearest ground that isn't a building (gardens, streets)."""
    from scipy import ndimage
    N = img.shape[0]; x0, z0, S = L['hi']; k = N / S
    m = Image.new('L', (N, N), 0); d = ImageDraw.Draw(m)
    for b in osm['blds']:
        P = np.array(b[6]).reshape(-1, 2)
        d.polygon([((x - x0) * k - 0.5, (z - z0) * k - 0.5) for x, z in P], fill=255)
    mask = ndimage.binary_dilation(np.asarray(m) > 0, iterations=1)
    _, (iy, ix) = ndimage.distance_transform_edt(mask, return_indices=True)
    out = img[iy, ix].astype(np.float32)
    soft = ndimage.uniform_filter(out, size=(5, 5, 1))
    out = np.where(mask[..., None], soft, out)
    print(f'  cleared {int(mask.sum())} roof pixels', flush=True)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)

def lift_shadows(c):
    """The satellite saw mountainsides in deep shade, lit only by blue skylight (dark teal). The game lights the
    ground itself, so lift those shadows towards the sunlit colour of what's there (mostly forest and pasture):
    brighter, and the skylight's blue cast taken out. Snow / ice in shade (bright, blue) is left alone."""
    L = c[..., 0] * 0.3 + c[..., 1] * 0.59 + c[..., 2] * 0.11
    s = np.clip((60 - L) / 45, 0, 1)
    s = s * s * (3 - 2 * s)
    icy = np.clip((c[..., 2] - c[..., 1] * 1.1) / 20, 0, 1)  # bluer than green: snow / glacier ice
    s *= 1 - icy
    out = c * (1 + 0.9 * s)[..., None]
    out[..., 2] *= 1 - 0.42 * s
    out[..., 0] *= 1 + 0.12 * s
    return out

def write_heights(path, H):
    q = np.clip(np.round((H + 200) * 8), 0, 65535).astype(np.int64)
    d = q.copy(); d[:, 1:] = q[:, 1:] - q[:, :-1]
    raw = (d % 65536).astype('<u2').tobytes()
    with open(path, 'wb') as f: f.write(gzip.compress(raw, 9, mtime=0))
    return os.path.getsize(path)

# ---------------------------------------------------------------- OSM
def overpass(q, path):
    if os.path.exists(path): return json.load(open(path))
    for url in ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.osm.jp/api/interpreter', 'https://overpass-api.de/api/interpreter',
                'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']:
        for t in range(3):
            try:
                try:
                    req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': UA})
                    d = urllib.request.urlopen(req, timeout=900).read()
                except urllib.error.URLError as e:
                    if 'CERTIFICATE' not in str(e): raise
                    # some mirrors' chains are only in the system store (which curl uses, Python's bundle may not)
                    import subprocess
                    d = subprocess.run(['curl', '-sf', '-m', '900', '-A', UA, '--data-urlencode', 'data@-', url], input=q.encode(), capture_output=True, check=True).stdout
                js = json.loads(d)
                if js.get('remark'): print('   overpass remark:', js['remark'], flush=True)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'wb') as f: f.write(d)
                return js
            except Exception as e:
                print('   overpass', url, e, flush=True); time.sleep(5 * (t + 1))
    raise RuntimeError('overpass failed')

def bbox(L, sq, pad=0):
    x0, z0, S = sq
    lat, lon = to_latlon(L, np.array([x0 - pad, x0 + S + pad, x0 - pad, x0 + S + pad]), np.array([z0 - pad, z0 - pad, z0 + S + pad, z0 + S + pad]))
    return f'{lat.min():.5f},{lon.min():.5f},{lat.max():.5f},{lon.max():.5f}'

def local_pts(L, geom):
    lat = np.array([g['lat'] for g in geom]); lon = np.array([g['lon'] for g in geom])
    x, z = to_local(L, lat, lon)
    return np.stack([x, z], 1)

def join_rings(parts):
    """Chain open way geometries (arrays of points) into closed rings."""
    rings, open_ = [], [p for p in parts if len(p) > 1]
    while open_:
        cur = open_.pop(0)
        changed = True
        while changed and np.hypot(*(cur[0] - cur[-1])) > 0.5:
            changed = False
            for i, q in enumerate(open_):
                for qq in (q, q[::-1]):
                    if np.hypot(*(cur[-1] - qq[0])) < 0.5:
                        cur = np.concatenate([cur, qq[1:]]); open_.pop(i); changed = True; break
                if changed: break
        if len(cur) >= 4 and np.hypot(*(cur[0] - cur[-1])) < 1: rings.append(cur)  # open leftovers (cut at the query box) would fill wrong areas
    return rings

def areas(L, js):
    """(tags, outer rings) for closed ways and multipolygon relations."""
    out = []
    for e in js['elements']:
        if e['type'] == 'way' and 'geometry' in e:
            pts = local_pts(L, e['geometry'])
            if len(pts) >= 4 and np.hypot(*(pts[0] - pts[-1])) < 0.5: out.append((e.get('tags', {}), [pts]))
        elif e['type'] == 'relation':
            outer = [local_pts(L, m['geometry']) for m in e.get('members', []) if m.get('role') in ('outer', '') and m.get('geometry')]
            rings = join_rings(outer)
            inner = join_rings([local_pts(L, m['geometry']) for m in e.get('members', []) if m.get('role') == 'inner' and m.get('geometry')])
            if rings: out.append((dict(e.get('tags', {}), _inner=inner), rings))  # holes: clearings in a forest, islands
    return out

def lines(L, js):
    return [(e.get('tags', {}), local_pts(L, e['geometry'])) for e in js['elements'] if e['type'] == 'way' and len(e.get('geometry', [])) > 1]

def num(v, default=None):
    try: return float(str(v).split(';')[0].replace('m', '').replace(',', '.').strip())
    except Exception: return default

BKIND = {  # building tag -> kind code used by the runtime (src/realBuildings.js)
    'house': 0, 'detached': 0, 'residential': 0, 'semidetached_house': 0, 'terrace': 0, 'yes': 0, 'bungalow': 0, 'chalet': 0,
    'apartments': 1, 'dormitory': 1,
    'farm': 2, 'farm_auxiliary': 2, 'barn': 2, 'cowshed': 2, 'stable': 2, 'shed': 2, 'hut': 2, 'cabin': 2, 'sty': 2, 'garage': 2, 'garages': 2,
    'church': 3, 'chapel': 3, 'cathedral': 3,
    'industrial': 4, 'warehouse': 4, 'commercial': 4, 'retail': 4, 'supermarket': 4, 'service': 4, 'transportation': 4, 'train_station': 4, 'office': 4, 'hangar': 4,
    'hotel': 5,
    'stilt_house': 7,  # overwater bungalows (Bora Bora): on stilts above the lagoon
    'school': 6, 'public': 6, 'civic': 6, 'hospital': 6, 'university': 6, 'government': 6, 'kindergarten': 6,
}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'half-hipped': 2, 'pyramidal': 3, 'skillion': 4, 'onion': 3, 'dome': 3, 'round': 1, 'gambrel': 1, 'mansard': 2}
HCLASS = {'motorway': 0, 'trunk': 0, 'motorway_link': 0, 'trunk_link': 0, 'primary': 1, 'primary_link': 1, 'secondary': 1, 'secondary_link': 1,
          'tertiary': 2, 'tertiary_link': 2, 'unclassified': 3, 'residential': 3, 'living_street': 3}
HWIDTH = [10.5, 7.5, 6.5, 5]

def in_square(p, sq, m=0):
    x0, z0, S = sq
    return bool(((p[:, 0] >= x0 - m) & (p[:, 0] <= x0 + S + m) & (p[:, 1] >= z0 - m) & (p[:, 1] <= z0 + S + m)).any())

def in_airport(p):  # the game's own airport (runways, apron, buildings): no OSM buildings there
    return bool(((np.abs(p[:, 0] - 100) < 480) & (np.abs(p[:, 1]) < 1250)).any())

HWAYS = r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$'

def osm_api(L, bb, cache, step=0.08):
    """Fallback when every Overpass mirror is down: the main OSM API's map call (bbox <= 0.25 deg^2, 50k nodes), in
    tiles, parsed into Overpass-style elements (ways with geometry, relations with member geometry, tagged nodes).
    Fine for a modest area like a national park; relations reaching outside the box come back incomplete (their
    rings don't close and are dropped)."""
    import xml.etree.ElementTree as ET
    s_, w_, n_, e_ = map(float, bb.split(','))
    nodes, ways, rels, tagged = {}, {}, {}, []
    tiles = [(a, b) for a in np.arange(s_, n_, step) for b in np.arange(w_, e_, step)]
    print(f'  OSM API: {len(tiles)} tiles', flush=True)
    for k, (a, b) in enumerate(tiles):
        box = f'{b:.5f},{a:.5f},{min(b + step, e_):.5f},{min(a + step, n_):.5f}'
        p = fetch(f'https://api.openstreetmap.org/api/0.6/map?bbox={box}', os.path.join(cache, 'osm', 'api', f'{k}.xml'))
        for el in ET.parse(p).getroot():
            if el.tag not in ('node', 'way', 'relation'): continue
            tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
            i = int(el.get('id'))
            if el.tag == 'node':
                nodes[i] = (float(el.get('lat')), float(el.get('lon')))
                if tags: tagged.append({'type': 'node', 'id': i, 'lat': nodes[i][0], 'lon': nodes[i][1], 'tags': tags})
            elif el.tag == 'way': ways[i] = (tags, [int(n.get('ref')) for n in el.findall('nd')])
            elif el.tag == 'relation': rels[i] = (tags, [(m.get('type'), int(m.get('ref')), m.get('role')) for m in el.findall('member')])
    geom = lambda refs: [{'lat': nodes[r][0], 'lon': nodes[r][1]} for r in refs if r in nodes]
    W = [{'type': 'way', 'id': i, 'tags': t, 'geometry': geom(r)} for i, (t, r) in ways.items()]
    R = [{'type': 'relation', 'id': i, 'tags': t, 'members': [{'type': 'way', 'ref': ref, 'role': role, 'geometry': geom(ways[ref][1])} for ty, ref, role in m if ty == 'way' and ref in ways]} for i, (t, m) in rels.items()]
    seen = set(); tagged = [n for n in tagged if not (n['id'] in seen or seen.add(n['id']))]
    print(f'  OSM API: {len(nodes)} nodes, {len(W)} ways, {len(R)} relations', flush=True)
    return W, R, tagged

def bake_osm(L, cache, api=False):
    bb = bbox(L, L['hi'], 500)
    hdr = f'[out:json][timeout:900][maxsize:1073741824][bbox:{bb}];'
    js_r = None
    try:
        if api: raise RuntimeError('--osm-api')
        # ways: tags + geometry; relations (multipolygons) also need their members ("body")
        js_b = overpass(hdr + 'way["building"];out tags geom qt;', os.path.join(cache, 'osm', 'buildings.json'))
        js_b['elements'] += overpass(hdr + 'relation["building"]["type"="multipolygon"];out body geom qt;', os.path.join(cache, 'osm', 'buildings_rel.json'))['elements']
        js_w = overpass(hdr + f'(way["highway"~"{HWAYS}"];'
                        'way["railway"~"^(rail|narrow_gauge|light_rail|funicular)$"];way["aerialway"~"^(cable_car|gondola|chair_lift|mixed_lift)$"];);out tags geom qt;', os.path.join(cache, 'osm', 'ways.json'))
        js_l = overpass(hdr + '(way["natural"~"^(water|wood|glacier|scrub)$"];way["landuse"~"^(forest|reservoir|basin)$"];way["waterway"="riverbank"];);out tags geom qt;', os.path.join(cache, 'osm', 'land.json'))
        js_l['elements'] += overpass(hdr + '(relation["natural"~"^(water|wood|glacier|scrub)$"];relation["landuse"~"^(forest|reservoir)$"];);out body geom qt;', os.path.join(cache, 'osm', 'land_rel.json'))['elements']
        if L.get('river'): js_r = overpass(hdr + 'way["waterway"="river"];out tags geom qt;', os.path.join(cache, 'osm', 'rivers.json'))
        try: js_p = overpass(f'[out:json][timeout:120][bbox:{bb}];(node["place"~"^(city|town|village)$"];);out body;', os.path.join(cache, 'osm', 'places.json'))
        except RuntimeError: js_p = {'elements': []}; print('   no place names (Overpass busy): towns left out', flush=True)
    except RuntimeError as e:
        print('  Overpass unavailable, using the OSM API:', e, flush=True)
        import re
        W, R, Nd = osm_api(L, bb, cache)
        has = lambda t, k, rx: k in t and re.match(rx, t[k])
        js_b = {'elements': [w for w in W if 'building' in w['tags']] + [r for r in R if 'building' in r['tags'] and r['tags'].get('type') == 'multipolygon']}
        js_w = {'elements': [w for w in W if has(w['tags'], 'highway', HWAYS) or has(w['tags'], 'railway', '^(rail|narrow_gauge|light_rail|funicular)$') or has(w['tags'], 'aerialway', '^(cable_car|gondola|chair_lift|mixed_lift)$')]}
        land = lambda t: has(t, 'natural', '^(water|wood|glacier|scrub)$') or has(t, 'landuse', '^(forest|reservoir|basin)$')
        js_l = {'elements': [w for w in W if land(w['tags']) or w['tags'].get('waterway') == 'riverbank'] + [r for r in R if land(r['tags'])]}
        js_r = {'elements': [w for w in W if w['tags'].get('waterway') == 'river']}
        js_p = {'elements': [n for n in Nd if has(n['tags'], 'place', '^(city|town|village)$')]}
    sq = L['hi']
    q = lambda v: round(float(v), 1)
    flat = lambda pts: [q(c) for p in pts for c in p]
    # ---- buildings
    blds = []
    for tags, rings in areas(L, js_b):
        ring = max(rings, key=len)
        if not in_square(ring, sq) or in_airport(ring): continue
        bt = tags.get('building', 'yes')
        if bt in ('roof', 'no', 'construction', 'ruins', 'collapsed', 'carport', 'bridge'): continue
        kind = BKIND.get(bt, 0)
        if tags.get('amenity') == 'place_of_worship' and kind == 0: kind = 3
        if tags.get('tourism') in ('hotel', 'alpine_hut', 'guest_house') and kind in (0, 2): kind = 5
        lv = num(tags.get('building:levels')); h = num(tags.get('height')); rh = num(tags.get('roof:height'))
        rs = ROOF.get(tags.get('roof:shape', ''), -1)
        mh = num(tags.get('min_height'), 0) or 0
        r = ring[:-1]
        if len(r) < 3: continue
        a = 0.5 * np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])
        if abs(a) < 6: continue
        if a < 0: r = r[::-1]  # consistent winding: positive signed area in (x, z)
        blds.append([kind, q(h if h is not None else -1), q(lv if lv is not None else -1), rs, q(rh if rh is not None else -1), q(mh), flat(r)])
    # ---- roads / rail / cable cars
    roads, rails, cables, tunnels = [], [], [], []
    for tags, pts in lines(L, js_w):
        if not in_square(pts, sq, 200): continue
        tun = tags.get('tunnel') in ('yes', 'building_passage', 'culvert') or str(tags.get('layer', '0')).startswith('-')
        br = 1 if tags.get('bridge') not in (None, 'no') else 0
        if 'highway' in tags:
            c = HCLASS[tags['highway']]
            w = num(tags.get('width'), HWIDTH[c]); w = min(max(w, 3.5), 16)
            if tun: tunnels.append([c, q(w), flat(pts)]); continue  # [class, width, x,z...]: not drawn yet
            roads.append([c, q(w), br, flat(pts)])
        elif 'railway' in tags:
            if tun: continue
            rails.append([1 if tags['railway'] == 'funicular' else 0, br, flat(pts)])
        elif 'aerialway' in tags:
            cables.append([{'cable_car': 0, 'gondola': 1}.get(tags['aerialway'], 2), flat(pts)])
    # ---- places
    places = []
    for e in js_p['elements']:
        t = e.get('tags', {})
        x, z = to_local(L, e['lat'], e['lon'])
        if in_square(np.array([[x, z]]), sq) and t.get('name'):
            places.append([t['name'], q(x), q(z), t['place']])
    land = areas(L, js_l)
    print(f'  {len(blds)} buildings, {len(roads)} roads, {len(rails)} rails, {len(cables)} cable cars, {len(land)} land areas, {len(places)} places', flush=True)
    return dict(out=dict(buildings=blds, roads=roads, rails=rails, cables=cables, places=places, tunnels=tunnels), land=land, roads=roads, blds=blds, rails=rails, js_r=js_r)

def raster(L, N, polys, value, img=None, grid=False):
    """Draw polygons (arrays of x,z) into an N x N 8-bit image over the hi square.
    grid=False: pixel areas (image texels); grid=True: N samples edge to edge (height grid)."""
    x0, z0, S = L['hi']
    img = img if img is not None else Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(img)
    k = (N - 1) / S if grid else N / S
    o = 0 if grid else -0.5  # PIL draws pixel i at coordinate i; a texel centre sits half a texel in
    for p in polys:
        d.polygon([((x - x0) * k + o, (z - z0) * k + o) for x, z in p], fill=value)
    return img

def water_areas(osm):
    return [(t, rings) for t, rings in osm['land'] if t.get('natural') == 'water' or t.get('landuse') in ('reservoir', 'basin') or t.get('waterway') == 'riverbank']

def carve_water(L, H, osm):
    """Lakes in the valley floor become real (game) water: carve them under the location's water level, and keep
    every other ground at least a little above it. Mountain lakes get carved at their own level and listed, so the
    runtime can lay flat water meshes on them."""
    from scipy import ndimage
    N = H.shape[0]; wl = L['water']; sp = L['hi'][2] / (N - 1)
    low, lakes = Image.new('L', (N, N), 0), []
    for t, rings in water_areas(osm):
        for r in rings:
            mk = np.asarray(raster(L, N, [r], 255, grid=True)) > 0
            if mk.sum() == 0: continue
            hs = H[mk]
            river = t.get('water') in ('river', 'stream', 'canal', 'stream_pool', 'rapids') or t.get('waterway') == 'riverbank'
            lo, hi_ = np.percentile(hs, 10), np.percentile(hs, 90)
            if np.median(hs) < wl + 8 and hi_ < wl + 12: raster(L, N, [r], 255, low, grid=True)
            elif river or hi_ - lo > 12: continue  # rivers running downhill / water on slopes: the imagery shows them
            elif mk.sum() >= 4:
                lvl = float(np.percentile(hs, 25))
                lakes.append([round(lvl, 1), [round(float(c), 1) for p in r[:-1] for c in p]])
                er = ndimage.binary_dilation(mk, iterations=1)
                d = ndimage.distance_transform_edt(er) * sp
                H[er] = np.minimum(H[er], lvl - 0.8 - np.minimum(25, d[er] * 0.12))
    mk = np.asarray(low) > 0
    d = ndimage.distance_transform_edt(mk) * sp
    H = np.where(mk, wl - 1.2 - np.minimum(90, d * 0.14), np.maximum(H, wl + 0.6)).astype(np.float32)
    osm['out']['lakes'] = lakes
    print(f'  carved {int(mk.sum())} lake samples, {len(lakes)} mountain lakes', flush=True)
    return H

def rgb_forest(img, N):
    """Forest density 0..1 from the aerial photo itself: the rims' ponderosa pine and pinyon-juniper canopy is
    dark olive green against tan soil, red rock and (blue-grey) shadow. (NAIP's near-infrared band would be better,
    but the ImageServer only hands out one band at a time and is very slow.) Smoothed over ~25 m."""
    from scipy import ndimage
    f = np.asarray(Image.fromarray(img).resize((N, N), Image.BOX)).astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    s = r + g + b + 1
    exg = (2 * g - r - b) / s  # excess green
    lum = s / 3
    p = np.percentile(exg, [5, 25, 50, 75, 95])
    print('  excess-green percentiles 5/25/50/75/95:', p.round(3), flush=True)
    v = np.clip((exg - 0.095) / 0.07, 0, 1) * np.clip((150 - lum) / 50, 0, 1) * np.clip((lum - 18) / 15, 0, 1)
    return ndimage.gaussian_filter(v, 2.5 * N / 4096)

def bake_cover(L, osm, N, base=None, forest=None):
    """Vegetation mask over the hi square: 0 = nothing grows (buildings, roads, water, glacier), else 1 + forest * 254.
    base: a starting mask (sea locations: the sea and the imagery's green canopy, tools/realworld/sea.py).
    forest: a density map (rgb_forest) instead of the mapped OSM forests."""
    land = osm['land']
    if forest is not None:
        f = np.clip(1 + np.round(forest * 16) / 16 * 254 + 0.5, 1, 255).astype(np.uint8)  # 17 levels: plenty, and a much smaller PNG
        img = Image.fromarray(np.minimum(f, base) if base is not None else f)
    else:
        img = Image.fromarray(base) if base is not None else Image.new('L', (N, N), 1)
        for test, v in ((lambda t: t.get('landuse') == 'forest' or t.get('natural') == 'wood', 255), (lambda t: t.get('natural') == 'scrub', 110), (lambda t: t.get('natural') == 'glacier', 0)):
            raster(L, N, [r for t, rings in land if test(t) for r in rings], v, img)
            raster(L, N, [r for t, rings in land if test(t) for r in t.get('_inner', [])], 1, img)  # clearings
    raster(L, N, [r for t, rings in water_areas(osm) for r in rings], 0, img)
    rivers = osm['out'].get('rivers')
    if rivers is None and os.path.exists(L.get('_osm_json', '')): rivers = json.load(open(L['_osm_json'])).get('rivers', [])
    for flat in rivers or []:  # the baked river ribbons (bake_river)
        R = np.array(flat).reshape(-1, 4); x0, z0, S = L['hi']; k = N / S
        for a, b in zip(R[:-1], R[1:]):
            ImageDraw.Draw(img).line([((a[0] - x0) * k - 0.5, (a[1] - z0) * k - 0.5), ((b[0] - x0) * k - 0.5, (b[1] - z0) * k - 0.5)], fill=0, width=max(1, int(round(2 * a[3] * k))))
    x0, z0, S = L['hi']; k = N / S
    d = ImageDraw.Draw(img)
    for c, w, br, pts in osm['roads']:
        P = np.array(pts).reshape(-1, 2)
        d.line([((x - x0) * k - 0.5, (z - z0) * k - 0.5) for x, z in P], fill=0, width=max(1, int(round((w + 4) * k))))
    for kind, br, pts in osm['rails']:
        P = np.array(pts).reshape(-1, 2)
        d.line([((x - x0) * k - 0.5, (z - z0) * k - 0.5) for x, z in P], fill=0, width=max(1, int(round(8 * k))))
    for b in osm['blds']:
        P = np.array(b[6]).reshape(-1, 2)
        c = P.mean(0); ext = np.abs(P - c).max(0)
        P = c + (P - c) * (1 + 4 / max(3, ext.min()))  # ~4 m clearance round the house
        d.polygon([((x - x0) * k - 0.5, (z - z0) * k - 0.5) for x, z in P], fill=0)
    return img

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('loc', choices=sorted(LOCS))
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/skywright-real'))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'real'))
    ap.add_argument('--only', default='heights,imagery,osm')
    ap.add_argument('--osm-api', action='store_true', help='skip Overpass, read the main OSM API (small areas only)')
    a = ap.parse_args()
    L = dict(LOCS[a.loc], id=a.loc); only = set(a.only.split(','))
    cache = os.path.join(a.cache, a.loc); out = os.path.join(a.out, a.loc)
    L['_osm_json'] = os.path.join(out, 'osm.json')
    os.makedirs(out, exist_ok=True)
    print('osm', flush=True)
    osm = bake_osm(L, cache, a.osm_api)  # heights need the lakes
    hi = None
    sea = None
    if L.get('sea'):  # coasts, lagoons and reefs (bathymetry from the imagery) instead of lakes
        import sea
        osm['out']['piers'] = sea.piers(L, L['hi'], cache)
    if 'heights' in only:
        print('heights', flush=True)
        far = bake_heights(L, L['far'], L['farN'], L['farZoomH'], cache)
        hi = bake_heights(L, L['hi'], L['hiN'], L['hiZoomH'], cache)
        if sea: hi, far = sea.bake_sea(L, hi, far, cache); osm['out']['lakes'] = []
        else: hi = carve_water(L, hi, osm)
        if L.get('river'): hi = bake_river(L, hi, osm, osm['js_r'])
        print('  hi range', float(hi.min()), float(hi.max()), ' far', float(far.min()), float(far.max()))
        print('  runway centre height', float(hi[int(round(-L['hi'][1] / L['hi'][2] * (L['hiN'] - 1))), int(round(-L['hi'][0] / L['hi'][2] * (L['hiN'] - 1)))]))
        print('  hi.bin.gz', write_heights(os.path.join(out, 'hi.bin.gz'), hi))
        print('  far.bin.gz', write_heights(os.path.join(out, 'far.bin.gz'), far))
    def write_cover(forest=None):
        cover = bake_cover(L, osm, L.get('coverN', L['hiImg']), sea.cover_base(L, cache, out) if sea else None, forest)
        if sea: cover = sea.bare_cliffs(L, cover, out)
        cover.save(os.path.join(out, 'cover.png'), optimize=True)
        print('  cover.png', os.path.getsize(os.path.join(out, 'cover.png')), flush=True)
    if 'osm' in only:
        if L.get('forest') != 'rgb': write_cover()  # (forest from the photo: written with the imagery)
        old = json.load(open(os.path.join(out, 'osm.json'))) if os.path.exists(os.path.join(out, 'osm.json')) else {}
        for k in ('lakes', 'rivers', 'riverStart'):  # made with the heights
            if k not in osm['out'] and k in old: osm['out'][k] = old[k]
        with open(os.path.join(out, 'osm.json'), 'w') as f: json.dump(osm['out'], f, separators=(',', ':'))
        print('  osm.json', os.path.getsize(os.path.join(out, 'osm.json')), flush=True)
    meta_p = os.path.join(out, 'meta.json')
    meta = json.load(open(meta_p)) if os.path.exists(meta_p) else {}
    if 'imagery' in only:
        print('imagery', flush=True)
        for key, N in (('far', L['farImg']), ('hi', L['hiImg'])):
            if L.get('imagery') == 'naip':
                try: img = bake_image_naip(L, L[key], N, L['naipM'] if key == 'hi' else L['naipFarM'], cache, key)
                except RuntimeError as e:
                    if key == 'hi': raise
                    print('  NAIP far imagery failed, Sentinel-2 instead:', e, flush=True); img = bake_image(L, L[key], N, L['farZoomI'], cache)
            else: img = bake_image(L, L[key], N, L[key + 'ZoomI'], cache)
            if key == 'hi':
                if L.get('deshadow'):
                    H = hi if hi is not None else read_heights(os.path.join(out, 'hi.bin.gz'), L['hiN'])
                    sp = L['hi'][2] / (L['hiN'] - 1)
                    az, el = sun_from_image(L, img, H, sp)
                    meta['sun'] = [round((az + L.get('north', 0)) % 360, 1), round(el, 1)]  # true azimuth, elevation
                    img = deshadow(L, img, H, sp, az, el)
                if L.get('imagery') == 'naip': img = grade(img)
                if L.get('forest') == 'rgb': write_cover(rgb_forest(img, L.get('coverN', L['hiImg'])))
                img = clear_roofs(L, img, osm)
            if key == 'hi' and sea: img = sea.fix_summit_cloud(L, sea.fill_pad(L, img, out), out)
            p = os.path.join(out, key + '.jpg')
            Image.fromarray(img).save(p, quality=86 if key == 'hi' else 88, optimize=True, progressive=True)
            print(' ', key + '.jpg', os.path.getsize(p), flush=True)
            if key == 'hi':
                for n in L.get('hiTiers', ()):  # smaller files for the lower quality tiers
                    p = os.path.join(out, f'hi-{n // 1024}k.jpg')
                    Image.fromarray(img).resize((n, n), Image.LANCZOS).save(p, quality=86, optimize=True, progressive=True)
                    print(' ', os.path.basename(p), os.path.getsize(p), flush=True)
    meta.update(id=a.loc, lat0=L['lat0'], lon0=L['lon0'], north=L.get('north', 0), rwyH=L['rwyH'], water=L['water'],
                hi=dict(x0=L['hi'][0], z0=L['hi'][1], size=L['hi'][2], n=L['hiN']),
                far=dict(x0=L['far'][0], z0=L['far'][1], size=L['far'][2], n=L['farN']))
    if L.get('hiTiers'): meta['img'] = {str(L['hiImg']): 'hi.jpg', **{str(n): f'hi-{n // 1024}k.jpg' for n in L['hiTiers']}}
    with open(meta_p, 'w') as f: json.dump(meta, f, indent=1)

def read_heights(path, n):
    q = np.frombuffer(gzip.decompress(open(path, 'rb').read()), '<u2').reshape(n, n).astype(np.int64)
    return (np.cumsum(q, axis=1) % 65536 / 8 - 200).astype(np.float32)

if __name__ == '__main__':
    main()
