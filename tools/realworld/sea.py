"""Coasts, lagoons and reefs for sea-level real-world locations (LOCS entries with sea=True), used by bake.py.

Elevation tiles are flat (or a coarse, smoothed ETOPO blob) over the sea, but a tropical island's look is all about
its water: turquoise sand flats, a reef crest breaking the swell, dark passes and coral heads, deep blue beyond the
reef. So the sea floor is estimated from the Sentinel-2 imagery (satellite-derived bathymetry) and baked into the
height grid below the water level; the game's water shader then shades it by depth (shallow tint, seabed showing
through, foam on the reef crest and the beaches) with no runtime cost.

How the depth is estimated (per height-grid sample):
  1. Land is what the OpenStreetMap coastline encloses (motus included); the DEM is used only there, faded in over
     the first few tens of metres from the shore, with a low beach ramp so motus and beaches sit just above water.
  2. Lagoon vs open ocean: shallow-looking water (green >= blue, the cyan of a sandy bottom) plus land, closed with
     a ~700 m disc (seals the passes) and hole-filled, is "inside the reef". The rest is open ocean.
  3. Inside: a single-band Lyzenga-style log-linear model on the green band, depth = ln((G0 - Gd) / (G - Gd)) / k,
     with Gd the deep-lagoon signal and k calibrated to the known anchors (bright sand flats ~1 m, turquoise lagoon
     2-6 m, dark lagoon and passes 25-45 m). Green rather than the blue/green log-ratio alone: the 8-bit true-colour mosaic
     saturates over the flats, which flattens the ratio exactly where the detail is. The log-ratio q = ln(B/G) then caps
     the depth of dark-bottomed water that is still green (coral and seagrass in the shallows read dark, but deep water
     is blue).
     The reef crest (the band of inside water along the ocean, and anywhere the bottom looks like coral rubble:
     red-ish, R/G high) is set to 0.3-0.8 m so the swell breaks on it; lagoon flats are kept >= 1.6 m (calm water,
     no surf) except where they slope up to a beach.
  4. Outside: depth grows with distance from the reef or shore (an outer reef slope that reaches ~200 m within
     ~300 m), never shallower than the lagoon water it is next to (so the passes open into deep water).
The height grid encodes -200 m at the deepest, which is far below anything the water shader can tell apart.
"""
import json, math, os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

import bake as B


def coast_rings(L, sq, cache, name):
    """Closed coastline rings (local x,z arrays) for every island in the square."""
    bb = B.bbox(L, sq, 2000)
    js = B.overpass(f'[out:json][timeout:600][bbox:{bb}];way["natural"="coastline"];out geom qt;', os.path.join(cache, 'osm', f'coast_{name}.json'))
    parts = [B.local_pts(L, e['geometry']) for e in js['elements'] if e['type'] == 'way' and len(e.get('geometry', [])) > 1]
    rings = B.join_rings(parts)
    print(f'  coastline ({name}): {len(parts)} ways -> {len(rings)} islands', flush=True)
    return rings


def raw_grid(L, sq, N, zoom, cache):
    """Sentinel-2 colours (sRGB 0..255 floats, no shadow lift) at the N x N height-grid samples of the square."""
    eox = lambda z, x, y: f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'
    m, px0, py0 = B.mosaic(L, sq, zoom, eox, cache, 's2cloudless')
    src_m = (40075016.7 * math.cos(math.radians(L['lat0']))) / (256 * 2 ** zoom)
    k = (sq[2] / (N - 1)) / src_m
    img = Image.fromarray(m)
    if k > 1.3: img = img.filter(ImageFilter.GaussianBlur(radius=0.42 * k))
    X, Z = B.grid_xy(sq, N)
    lat, lon = B.to_latlon(L, X, Z)
    px, py = B.merc_px(lat, lon, zoom)
    return B.bilinear(np.asarray(img).astype(np.float32), px - px0, py - py0)


def land_mask(L, sq, N, rings):
    x0, z0, S = sq
    img = Image.new('L', (N, N), 0)
    from PIL import ImageDraw
    d = ImageDraw.Draw(img); k = (N - 1) / S
    for r in rings: d.polygon([((x - x0) * k, (z - z0) * k) for x, z in r], fill=255)
    return np.asarray(img) > 0


def _dilate(mask, r):  # disc dilation by r samples (exact, via the distance transform)
    return ndimage.distance_transform_edt(~mask) <= r


def _smooth(a, s):
    return ndimage.gaussian_filter(a, s) if s > 0 else a


def bathymetry(L, sq, N, H, rings, rgb):
    """Height grid with land from the DEM inside the coastline and the sea floor from the imagery elsewhere."""
    sp = sq[2] / (N - 1)
    wl = L['water']
    land = land_mask(L, sq, N, rings)
    water = ~land
    R, G, Bl = (_smooth(rgb[..., c], 0.6) for c in range(3))
    q = np.log((Bl + 1) / (G + 1))  # > 0: blue water (deep); < 0: cyan / green (a bright bottom close below)
    rho = (R + 1) / (G + 1)
    # 2. inside the reef: shallow-looking water + land, passes sealed, holes filled; tiny specks (glint) dropped
    shallow = water & (q < 0.02) & (G > 70)
    core = shallow | land
    r = max(2, int(round(700 / sp)))
    closed = ~_dilate(~_dilate(core, r), r)  # closing = dilate, then erode
    inside = ndimage.binary_fill_holes(closed) & water
    lab, n = ndimage.label(inside | land)
    keep = np.zeros(n + 1, bool)
    if n:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(n + 1))
        has_land = ndimage.maximum(land, lab, range(n + 1)) > 0
        keep = (sizes * sp * sp > 0.3e6) | has_land
        keep[0] = False
    inside &= keep[lab]
    outside = water & ~inside
    # 3. lagoon depth from the green band
    Gd = max(6.0, float(np.percentile(G[inside], 0.5)) - 3) if inside.any() else 18.0
    G0, k = 250.0, 0.07
    dg = np.log((G0 - Gd) / np.clip(G - Gd, 0.6, None)) / k
    # a dark bottom (coral, seagrass, rubble) also reads dark in green: but deep water is blue, and shallow dark reef
    # is green-brown. Cap the depth by how green the water is (q < 0: < ~6 m; q > 0.25: the green band decides)
    cap = 1.8 + np.maximum(0, q + 0.15) * 40 + np.maximum(0, q) * 120
    dark = np.clip((190 - G) / 40, 0, 1)  # bright sand: the green band alone is right
    dg = np.clip(ndimage.median_filter(dg + (np.minimum(dg, cap) - dg) * dark, 3), 0.0, 48.0)
    d_land = ndimage.distance_transform_edt(water) * sp  # distance from land (0 on land)
    d_out = ndimage.distance_transform_edt(~outside) * sp  # distance from the open ocean (0 there)
    # reef crest: inside water next to the ocean, or coral-rubble coloured shallows near it
    near_ocean = 1 - np.clip((d_out - 40) / 160, 0, 1)
    rubble = np.clip((rho - 0.58) / 0.14, 0, 1) * (q < 0.05)
    crest = np.clip(np.maximum(near_ocean * (dg < 9), rubble * (1 - np.clip((d_out - 250) / 400, 0, 1))), 0, 1) * inside
    crest = _smooth(crest.astype(np.float32), 1.0)
    rng = np.random.default_rng(7)
    wob = _smooth(rng.standard_normal((N, N)).astype(np.float32), 2.0)
    wob = (wob - wob.min()) / max(1e-6, wob.max() - wob.min())
    d_crest = 0.3 + 0.5 * wob
    d_in = np.maximum(dg, 1.6)
    d_in = d_in + (np.minimum(d_in, d_crest) - d_in) * crest
    # beaches: the bottom slopes up to the shore over the last ~25 m
    d_in = np.minimum(d_in, 0.12 + d_land * 0.06)
    # 4. open ocean: an outer reef slope, never shallower than the lagoon water next to it (passes stay open)
    d_reef, (iy, ix) = ndimage.distance_transform_edt(outside, return_indices=True)
    d_reef = d_reef * sp  # distance from the reef / shore out into the ocean
    edge_d = np.where(inside[iy, ix], d_in[iy, ix], 0.5)
    d_sea = np.maximum(0.6 + 0.35 * d_reef + 0.0012 * d_reef ** 2, edge_d * (1 - np.clip(d_reef / 400, 0, 1)) + 0.5)
    d_sea = np.minimum(d_sea, 195.0)
    depth = np.where(inside, d_in, d_sea)
    depth = np.where(water, _smooth(np.where(water, depth, 0.0), 0.7), 0.0)
    # 1. land: the DEM faded in from a low beach ramp
    ramp = wl + 0.35 + 1.6 * (1 - np.exp(-d_land_in(land, sp) / 45))
    fade = np.clip(d_land_in(land, sp) / 40, 0, 1)
    hl = ramp + np.maximum(0, H - ramp) * fade
    out = np.where(land, hl, wl - np.maximum(depth, 0.12)).astype(np.float32)
    print(f'  bathymetry: {int(land.sum())} land, {int(inside.sum())} lagoon, {int(outside.sum())} ocean samples; '
          f'Gd {Gd:.0f}; lagoon depth median {np.median(d_in[inside]) if inside.any() else 0:.1f} m', flush=True)
    return out, dict(land=land, inside=inside, crest=crest)


def d_land_in(land, sp):  # distance inland from the coastline (0 in the water)
    return ndimage.distance_transform_edt(land) * sp


def fix_peaks(L, H, sq, cache):
    """Radar elevation models clip narrow volcanic spires (SRTM has Otemanu ~130 m low): lift the DEM to the summit
    heights OpenStreetMap has for named peaks, with a steep cone that leaves the ridges around them alone."""
    bb = B.bbox(L, sq)
    js = B.overpass(f'[out:json][timeout:120][bbox:{bb}];node["natural"="peak"]["ele"];out body;', os.path.join(cache, 'osm', f'peaks_{int(sq[2])}.json'))
    N = H.shape[0]; x0, z0, S = sq; sp = S / (N - 1)
    X, Z = B.grid_xy(sq, N)
    for e in js['elements']:
        ele = B.num(e.get('tags', {}).get('ele'))
        if not ele: continue
        x, z = B.to_local(L, e['lat'], e['lon'])
        i, j = (float(x) - x0) / sp, (float(z) - z0) / sp
        rr = int(250 / sp) + 1
        if not (rr <= i < N - rr and rr <= j < N - rr): continue
        win = H[int(j) - rr:int(j) + rr + 1, int(i) - rr:int(i) + rr + 1]
        top = float(win.max()); lack = ele - top
        if lack < 15 or lack > 400: continue
        jj, ii = np.unravel_index(win.argmax(), win.shape)
        cx, cz = x0 + (int(i) - rr + ii) * sp, z0 + (int(j) - rr + jj) * sp
        cx, cz = (cx + float(x)) / 2, (cz + float(z)) / 2  # between the DEM's summit and the mapped one
        d = np.hypot(X - cx, Z - cz); Rr = 290.0
        w = np.clip((Rr - d) / (Rr * 0.5), 0, 1); w = w * w * (3 - 2 * w)  # steep walls, a small summit block
        H += (lack * w * np.clip((H - (top - 260)) / 200, 0, 1)).astype(np.float32)  # only the summit block, not the valleys
        print(f'  peak {e.get("tags", {}).get("name", "?")}: DEM {top:.0f} m -> {ele:.0f} m', flush=True)
    return H


def vegetation(L, sq, N, rgb, land):
    """Forest density 0..1 on land from the imagery's greenness (Sentinel-2's dark green canopy), 0 in the water."""
    R, G, Bl = (_smooth(rgb[..., c], 1.0) for c in range(3))
    lum = 0.3 * R + 0.59 * G + 0.11 * Bl
    green = (G - np.maximum(R, Bl)) / (G + 1)
    f = np.clip((green - 0.02) / 0.18, 0, 1) * np.clip((150 - lum) / 70, 0, 1)
    return np.where(land, f, 0).astype(np.float32)


def piers(L, sq, cache):
    """Piers and jetties (man_made=pier ways: walkways to the overwater bungalows, boat docks)."""
    bb = B.bbox(L, sq, 200)
    js = B.overpass(f'[out:json][timeout:300][bbox:{bb}];(way["man_made"~"^(pier|jetty)$"];);out tags geom qt;', os.path.join(cache, 'osm', 'piers.json'))
    out = []
    for e in js['elements']:
        if e['type'] != 'way' or len(e.get('geometry', [])) < 2: continue
        p = B.local_pts(L, e['geometry'])
        if not B.in_square(p, sq): continue
        closed = np.hypot(*(p[0] - p[-1])) < 0.5 and len(p) >= 4
        w = B.num(e.get('tags', {}).get('width'), 2.4)
        out.append([1 if closed else 0, round(min(max(w, 1.5), 8), 1), [round(float(c), 1) for q in (p[:-1] if closed else p) for c in q]])
    print(f'  {len(out)} piers', flush=True)
    return out


def bake_sea(L, hi, far, cache):
    """Both height squares of a sea location: summits fixed, land from the coastline, the sea floor estimated."""
    out = []
    for key, H in (('far', far), ('hi', hi)):
        sq, N = L[key], L[key + 'N']
        rings = coast_rings(L, sq, cache, key)
        rgb = raw_grid(L, sq, N, L[key + 'ZoomI'], cache)
        H = fix_peaks(L, H, sq, cache)
        H, _ = bathymetry(L, sq, N, H, rings, rgb)
        out.append(H)
    return out[1], out[0]


def cover_base(L, cache, out):
    """Landcover base for bake.bake_cover over the hi square (pixel areas, hiImg wide): 0 in the sea, else 1 + forest
    * 254 from the imagery's greenness (OSM forests are drawn on top as usual)."""
    sq, N = L['hi'], L['hiImg']
    rings = coast_rings(L, sq, cache, 'hi')
    eox = lambda z, x, y: f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'
    m, px0, py0 = B.mosaic(L, sq, L['hiZoomI'], eox, cache, 's2cloudless')
    X, Z = B.grid_xy(sq, N, centers=True)
    lat, lon = B.to_latlon(L, X, Z)
    px, py = B.merc_px(lat, lon, L['hiZoomI'])
    rgb = B.bilinear(m.astype(np.float32), px - px0, py - py0)
    land = np.asarray(B.raster(L, N, rings, 255)) > 0
    f = vegetation(L, sq, N, rgb, land)
    return np.where(land, 1 + np.round(f * 254), 0).astype(np.uint8)


def bare_cliffs(L, cover, out):
    """No forest on the cliffs (Otemanu's walls are bare basalt), whatever the photo or the mapped forests say."""
    sq = L['hi']; N = cover.size[0]
    H = read_heights(os.path.join(out, 'hi.bin.gz'), L['hiN'])
    gy, gx = np.gradient(H, sq[2] / (L['hiN'] - 1))
    slope = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)
    X, Z = B.grid_xy(sq, N, centers=True)
    sl = B.bilinear(slope, (X - sq[0]) / sq[2] * (L['hiN'] - 1) + 0.5, (Z - sq[1]) / sq[2] * (L['hiN'] - 1) + 0.5)
    c = np.asarray(cover).astype(np.float32)
    k = np.clip((44 - sl) / 10, 0, 1)
    c = np.where(c > 1, 1 + (c - 1) * k, c)
    print(f'  bare cliffs: {int((k < 0.5).sum())} pixels', flush=True)
    return Image.fromarray(np.round(c).astype(np.uint8))


def read_heights(path, n):
    import gzip
    u = np.frombuffer(gzip.decompress(open(path, 'rb').read()), '<u2').reshape(n, n).astype(np.int64)
    return (np.cumsum(u, axis=1) % 65536) / 8.0 - 200


def fill_pad(L, img, out):
    """The game flattens its airport (two runways, apron, terminal) out of the islet at rwyH, blending back to the real
    ground over padBlend metres (world.js rawHeight): where that raised ground used to be lagoon, the photo shows
    water. Paint it as the islet's sandy grass instead."""
    sq, N = L['hi'], img.shape[0]
    H = read_heights(os.path.join(out, 'hi.bin.gz'), L['hiN'])
    X, Z = B.grid_xy(sq, N, centers=True)
    h = B.bilinear(H.astype(np.float32), (X - sq[0]) / sq[2] * (L['hiN'] - 1) + 0.5, (Z - sq[1]) / sq[2] * (L['hiN'] - 1) + 0.5)
    d = np.hypot(np.maximum(0, np.abs(X - 100) - 350), np.maximum(0, np.abs(Z) - 900 - 250))
    t = np.clip(d / L['padBlend'], 0, 1); t = t * t * (3 - 2 * t)
    g = L['rwyH'] + (h - L['rwyH']) * t  # the game's ground there
    c = img.astype(np.float32)
    wet = np.clip((c[..., 2] - c[..., 0] - 25) / 40, 0, 1) * (g > L['water'] + 0.1) * (d < L['padBlend'])
    rng = np.random.default_rng(3)
    n = ndimage.gaussian_filter(rng.standard_normal((N, N)).astype(np.float32), 3) * 25
    grass = np.stack([118 + n, 122 + n * 0.9, 84 + n * 0.6], -1)
    sand = np.array([196, 186, 150], np.float32)
    fill = grass + (sand - grass) * np.clip((L['padBlend'] - d)[..., None] / 40, 0, 1) * (d > L['padBlend'] - 40)[..., None]
    fill = ndimage.gaussian_filter(fill, (1.5, 1.5, 0))
    c = c + (fill - c) * ndimage.gaussian_filter(wet, 2)[..., None]
    print(f'  airport apron: {int((wet > 0.5).sum())} lagoon pixels painted as land', flush=True)
    return np.clip(c + 0.5, 0, 255).astype(np.uint8)


def fix_summit_cloud(L, img, out):
    """The cloudless mosaic still has a little cloud on the summits (Otemanu wears one most days): bright, grey-white
    pixels high up on land become the dark basalt of the cliffs."""
    sq, N = L['hi'], img.shape[0]
    H = read_heights(os.path.join(out, 'hi.bin.gz'), L['hiN'])
    X, Z = B.grid_xy(sq, N, centers=True)
    h = B.bilinear(H.astype(np.float32), (X - sq[0]) / sq[2] * (L['hiN'] - 1) + 0.5, (Z - sq[1]) / sq[2] * (L['hiN'] - 1) + 0.5)
    c = img.astype(np.float32)
    lum = c @ np.array([0.3, 0.59, 0.11], np.float32)
    sat = c.max(-1) - c.min(-1)
    m = np.clip((lum - 120) / 40, 0, 1) * np.clip((60 - sat) / 30, 0, 1) * np.clip((h - 150) / 80, 0, 1)
    m = ndimage.maximum_filter(m, 5)
    # and the cliffs themselves: the photo smears forest (or, on the shaded side, blue-green skylight) down them
    gy, gx = np.gradient(H, sq[2] / (L['hiN'] - 1))
    sl = B.bilinear(np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32), (X - sq[0]) / sq[2] * (L['hiN'] - 1) + 0.5, (Z - sq[1]) / sq[2] * (L['hiN'] - 1) + 0.5)
    m = np.maximum(m, np.clip((sl - 44) / 10, 0, 1) * np.clip((h - 120) / 80, 0, 1) * 0.85)
    m = ndimage.gaussian_filter(m, 2)
    rng = np.random.default_rng(5)
    n = ndimage.gaussian_filter(rng.standard_normal((N, N)).astype(np.float32), 1.5) * 18
    rock = np.stack([88 + n, 92 + n, 84 + n], -1)
    c = c + (rock - c) * m[..., None]
    print(f'  summit cloud and cliffs: {int((m > 0.5).sum())} pixels painted as rock', flush=True)
    return np.clip(c + 0.5, 0, 255).astype(np.uint8)
