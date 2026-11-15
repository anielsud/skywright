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
import argparse, gzip, io, json, math, os, sys, time, urllib.parse, urllib.request
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
    for url in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']:
        for t in range(3):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': UA})
                d = urllib.request.urlopen(req, timeout=900).read(); js = json.loads(d)
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

def bake_osm(L, cache):
    bb = bbox(L, L['hi'], 500)
    hdr = f'[out:json][timeout:900][maxsize:1073741824][bbox:{bb}];'
    # ways: tags + geometry; relations (multipolygons) also need their members ("body")
    js_b = overpass(hdr + 'way["building"];out tags geom qt;', os.path.join(cache, 'osm', 'buildings.json'))
    js_b['elements'] += overpass(hdr + 'relation["building"]["type"="multipolygon"];out body geom qt;', os.path.join(cache, 'osm', 'buildings_rel.json'))['elements']
    js_w = overpass(hdr + '(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];'
                    'way["railway"~"^(rail|narrow_gauge|light_rail|funicular)$"];way["aerialway"~"^(cable_car|gondola|chair_lift|mixed_lift)$"];);out tags geom qt;', os.path.join(cache, 'osm', 'ways.json'))
    js_l = overpass(hdr + '(way["natural"~"^(water|wood|glacier|scrub)$"];way["landuse"~"^(forest|reservoir|basin)$"];way["waterway"="riverbank"];);out tags geom qt;', os.path.join(cache, 'osm', 'land.json'))
    js_l['elements'] += overpass(hdr + '(relation["natural"~"^(water|wood|glacier|scrub)$"];relation["landuse"~"^(forest|reservoir)$"];);out body geom qt;', os.path.join(cache, 'osm', 'land_rel.json'))['elements']
    try: js_p = overpass(f'[out:json][timeout:120][bbox:{bb}];(node["place"~"^(city|town|village)$"];);out body;', os.path.join(cache, 'osm', 'places.json'))
    except RuntimeError: js_p = {'elements': []}; print('   no place names (Overpass busy): towns left out', flush=True)
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
    roads, rails, cables = [], [], []
    for tags, pts in lines(L, js_w):
        if not in_square(pts, sq, 200): continue
        tun = tags.get('tunnel') in ('yes', 'building_passage', 'culvert') or str(tags.get('layer', '0')).startswith('-')
        br = 1 if tags.get('bridge') not in (None, 'no') else 0
        if 'highway' in tags:
            if tun: continue
            c = HCLASS[tags['highway']]
            w = num(tags.get('width'), HWIDTH[c]); w = min(max(w, 3.5), 16)
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
    return dict(out=dict(buildings=blds, roads=roads, rails=rails, cables=cables, places=places), land=land, roads=roads, blds=blds, rails=rails)

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

def bake_cover(L, osm, N):
    """Vegetation mask over the hi square: 0 = nothing grows (buildings, roads, water, glacier), else 1 + forest * 254."""
    img = Image.new('L', (N, N), 1)
    land = osm['land']
    for test, v in ((lambda t: t.get('landuse') == 'forest' or t.get('natural') == 'wood', 255), (lambda t: t.get('natural') == 'scrub', 110), (lambda t: t.get('natural') == 'glacier', 0)):
        raster(L, N, [r for t, rings in land if test(t) for r in rings], v, img)
        raster(L, N, [r for t, rings in land if test(t) for r in t.get('_inner', [])], 1, img)  # clearings
    raster(L, N, [r for t, rings in water_areas(osm) for r in rings], 0, img)
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
    a = ap.parse_args()
    L = dict(LOCS[a.loc], id=a.loc); only = set(a.only.split(','))
    cache = os.path.join(a.cache, a.loc); out = os.path.join(a.out, a.loc)
    os.makedirs(out, exist_ok=True)
    print('osm', flush=True)
    osm = bake_osm(L, cache)  # heights need the lakes
    if 'heights' in only:
        print('heights', flush=True)
        far = bake_heights(L, L['far'], L['farN'], L['farZoomH'], cache)
        hi = bake_heights(L, L['hi'], L['hiN'], L['hiZoomH'], cache)
        hi = carve_water(L, hi, osm)
        print('  hi range', float(hi.min()), float(hi.max()), ' far', float(far.min()), float(far.max()))
        print('  hi.bin.gz', write_heights(os.path.join(out, 'hi.bin.gz'), hi))
        print('  far.bin.gz', write_heights(os.path.join(out, 'far.bin.gz'), far))
    if 'osm' in only:
        cover = bake_cover(L, osm, L['hiImg'])
        cover.save(os.path.join(out, 'cover.png'), optimize=True)
        print('  cover.png', os.path.getsize(os.path.join(out, 'cover.png')), flush=True)
        if 'lakes' not in osm['out']:
            osm['out']['lakes'] = json.load(open(os.path.join(out, 'osm.json'))).get('lakes', []) if os.path.exists(os.path.join(out, 'osm.json')) else []
        with open(os.path.join(out, 'osm.json'), 'w') as f: json.dump(osm['out'], f, separators=(',', ':'))
        print('  osm.json', os.path.getsize(os.path.join(out, 'osm.json')), flush=True)
    if 'imagery' in only:
        print('imagery', flush=True)
        for key, N, zoom in (('far', L['farImg'], L['farZoomI']), ('hi', L['hiImg'], L['hiZoomI'])):
            img = bake_image(L, L[key], N, zoom, cache)
            if key == 'hi': img = clear_roofs(L, img, osm)
            p = os.path.join(out, key + '.jpg')
            Image.fromarray(img).save(p, quality=86 if key == 'hi' else 88, optimize=True, progressive=True)
            print(' ', key + '.jpg', os.path.getsize(p), flush=True)
    meta = dict(id=a.loc, lat0=L['lat0'], lon0=L['lon0'], north=L.get('north', 0), rwyH=L['rwyH'], water=L['water'],
                hi=dict(x0=L['hi'][0], z0=L['hi'][1], size=L['hi'][2], n=L['hiN']),
                far=dict(x0=L['far'][0], z0=L['far'][1], size=L['far'][2], n=L['farN']))
    with open(os.path.join(out, 'meta.json'), 'w') as f: json.dump(meta, f, indent=1)

if __name__ == '__main__':
    main()
