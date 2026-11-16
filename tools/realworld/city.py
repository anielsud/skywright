"""City buildings for a real-world location (bake.py LOCS entry with city=True), e.g. New York.

A city has far too many buildings (NYC: hundreds of thousands) to parse and triangulate in the browser, so they
are baked here into ready-to-draw meshes:
  1. load_buildings: every OSM building and building:part in the detailed square (Overpass, fetched in K x K boxes),
     in the game frame, with heights from height / min_height / building:levels (NYC's OSM data was imported from the
     city's own footprints with measured roof heights), roof shapes, colours and materials. A building outline that is
     mostly covered by its parts (setbacks, spires) is replaced by the parts.
  2. bake_city: ground heights from the baked height grid, packed per 1 km tile into a compact binary
     (assets/real/<id>/city.bin.gz) that src/realCity.js turns into meshes with the towns' building kit.
Map data (c) OpenStreetMap contributors, ODbL.
"""
import json, os, time
import numpy as np

from bake import overpass, bbox, areas, num, in_square, in_airport, sample_grid, fetch, to_local

K = 8  # Overpass boxes per side (a box of New York is ~10-40k buildings and ~30 MB of JSON)

# building / building:part tag -> kind code (citymesh.mjs)
KIND = {  # (anything else, mostly building=yes: 7, unknown)
    'house': 0, 'detached': 0, 'semidetached_house': 0, 'terrace': 0, 'bungalow': 0, 'residential': 1, 'apartments': 1, 'dormitory': 1,
    'garage': 2, 'garages': 2, 'shed': 2, 'hut': 2, 'cabin': 2, 'carport': 2,
    'church': 3, 'chapel': 3, 'cathedral': 3, 'synagogue': 3, 'mosque': 3, 'temple': 3,
    'industrial': 4, 'warehouse': 4, 'manufacture': 4, 'hangar': 4, 'storage_tank': 4, 'transportation': 4, 'train_station': 4, 'service': 4,
    'commercial': 5, 'office': 5, 'retail': 5, 'supermarket': 5, 'hotel': 5, 'mixed_use': 5,
    'school': 6, 'public': 6, 'civic': 6, 'hospital': 6, 'university': 6, 'college': 6, 'government': 6, 'museum': 6, 'library': 6,
}

def nyc_footprints(L, cache, bb):
    """NYC Open Data "Building Footprints" (NYC Office of Technology and Innovation, NYC Open Data terms of use): every
    building in the five boroughs with its measured roof height (feet) and construction year."""
    s, w, n, e = map(float, bb.split(','))
    out, k = [], 0
    while True:
        url = ('https://data.cityofnewyork.us/resource/5zhs-2jue.json?$limit=50000&$order=objectid&$offset=' + str(k * 50000) +
               f'&$where=within_box(the_geom,{n},{w},{s},{e})&$select=the_geom,name,construction_year,feature_code,height_roof,objectid')
        d = json.load(open(fetch(url, os.path.join(cache, 'nycbf', f'page_{k}.json'))))
        out += d; k += 1
        if len(d) < 50000: break
    els = []
    for r in out:
        g = r.get('the_geom') or {}
        if g.get('type') != 'MultiPolygon' or not g.get('coordinates'): continue
        fc = str(r.get('feature_code', '2100'))
        if fc in ('2110', '1001', '1005', '1003'): continue  # skybridges, canopies, temporary structures
        poly = max(g['coordinates'], key=lambda pl: len(pl[0]))
        tags = {'building': 'garage' if fc == '5110' else 'storage_tank' if fc == '1002' else 'yes', '_nyc': 1}
        try:
            h = float(r.get('height_roof') or 0) * 0.3048
            if h > 1: tags['height'] = str(round(h, 1))
        except ValueError: pass
        if r.get('construction_year'): tags['start_date'] = str(r['construction_year'])
        if r.get('name'): tags['name'] = r['name']
        els.append((tags, poly))
    print(f'  NYC Open Data: {len(out)} footprints, {len(els)} buildings', flush=True)
    return els

def load_buildings(L, cache):
    bb = bbox(L, L['hi']); s, w, n, e = map(float, bb.split(','))
    sq = L['hi']
    recs = []  # (tags, rings in the local frame)
    nycmode = L.get('nyc_open_data')
    if nycmode:
        for tags, poly in nyc_footprints(L, cache, bb):
            rings = [np.stack(to_local(L, np.array([c[1] for c in rg]), np.array([c[0] for c in rg])), 1) for rg in poly]
            if len(rings[0]) < 4: continue
            recs.append((dict(tags, _inner=rings[1:]), [rings[0]]))
    els = []
    # OpenStreetMap: building:parts everywhere (setbacks, spires), and buildings where the NYC data doesn't reach
    # (New Jersey): boxes west of osm_west only, skipping NYC's own import (nycdoitt:bin) which the NYC data has
    js = overpass(f'[out:json][timeout:900][bbox:{bb}];way["building:part"];out tags geom qt;', os.path.join(cache, 'osm', 'parts.json'))
    els += js['elements']
    west = L.get('osm_west', e)
    if L.get('osm_west_tall'):  # only the mapped heights / levels west of osm_west (New Jersey's waterfront towers): one small query
        sub = f'{s:.5f},{L.get("osm_west_min", w):.5f},{n:.5f},{west:.5f}'
        try:
            js = overpass(f'[out:json][timeout:900][bbox:{sub}];(way["building"][!"nycdoitt:bin"]["height"];way["building"][!"nycdoitt:bin"]["building:levels"];);out tags geom qt;', os.path.join(cache, 'osm', 'west_tall.json'), rounds=8)
            print(f'   buildings west (with heights or levels): {len(js["elements"])}', flush=True); els += js['elements']
        except RuntimeError: print('   buildings west: Overpass failed, left out', flush=True)
    for i in range(K):
        if L.get('osm_west_tall'): break
        for j in range(K):
            if w + (e - w) * j / K > west or w + (e - w) * (j + 1) / K < L.get('osm_west_min', w): continue
            sub = f'{s + (n - s) * i / K:.5f},{w + (e - w) * j / K:.5f},{s + (n - s) * (i + 1) / K:.5f},{w + (e - w) * (j + 1) / K:.5f}'
            hdr = f'[out:json][timeout:900][maxsize:1073741824][bbox:{sub}];'
            path = os.path.join(cache, 'osm', f'bw{K}_{i}_{j}.json')  # (all buildings, from an earlier bake) or just the non-NYC ones
            try: js = json.load(open(path)) if os.path.exists(path) else overpass(hdr + 'way["building"][!"nycdoitt:bin"];out tags geom qt;', os.path.join(cache, 'osm', f'bx{K}_{i}_{j}.json'))
            except RuntimeError: print(f'   buildings box {i},{j}: Overpass failed, left out', flush=True); continue
            print(f'   buildings box {i},{j}: {len(js["elements"])}', flush=True)
            els += js['elements']
    try: els += overpass(f'[out:json][timeout:900][bbox:{s},{w},{n},{e}];(relation["building"]["type"="multipolygon"];relation["building:part"]["type"="multipolygon"];);out body geom qt;',
                         os.path.join(cache, 'osm', 'brel.json'), rounds=3)['elements']
    except RuntimeError: print('   no building relations (Overpass busy)', flush=True)
    seen, uniq = set(), []
    for el in els:  # ways on the Overpass box borders come twice
        k = (el['type'], el['id'])
        if k not in seen: seen.add(k); uniq.append(el)
    t0 = time.time()
    blds = []
    for tags, rings in recs + areas(L, {'elements': uniq}):
        if nycmode and 'nycdoitt:bin' in tags and 'building:part' not in tags: continue  # (the NYC data has these, with years)
        part = 'building:part' in tags and 'building' not in tags
        bt = tags.get('building:part' if part else 'building', 'yes')
        if bt in ('no', 'roof', 'construction', 'ruins', 'collapsed', 'bridge', 'canopy', 'carport'): continue
        ring = max(rings, key=len)
        if not in_square(ring, sq) or in_airport(ring): continue
        r = ring[:-1]
        if len(r) < 3: continue
        a = 0.5 * np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])
        if abs(a) < 8: continue
        if a < 0: r = r[::-1]
        lv = num(tags.get('building:levels')); h = num(tags.get('height')); mh = num(tags.get('min_height'))
        mlv = num(tags.get('building:min_level'))
        if h is None and lv is not None: h = lv * 3.3 + 1 + (num(tags.get('roof:levels'), 0) or 0) * 2.5
        if mh is None: mh = mlv * 3.3 if mlv else 0
        if h is not None and h > 600: h = None  # (a typo, or feet)
        kind = KIND.get(bt, 7)
        if tags.get('amenity') == 'place_of_worship': kind = 3
        rec = dict(k=kind, h=round(h, 1) if h is not None else -1, mh=round(mh, 1), lv=lv or -1, rs=tags.get('roof:shape', ''), rh=num(tags.get('roof:height'), -1),
                   col=tags.get('building:colour', ''), mat=tags.get('building:material', ''), rcol=tags.get('roof:colour', ''),
                   nm=tags.get('name', ''), part=part, ring=[round(float(c), 2) for p in r for c in p], area=float(abs(a)),
                   holes=[[round(float(c), 2) for p in hr[:-1] for c in p] for hr in tags.get('_inner', [])][:8],
                   date=tags.get('start_date', '')[:4], nyc='_nyc' in tags)
        rec['tall'] = (rec['h'] >= 20) or (rec['area'] >= 2500 and rec['h'] >= 10)
        blds.append(rec)
    # parts: which building is each one in? An outline mostly covered by its parts is drawn by the parts only.
    cell = 100.0; grid = {}
    outl = [b for b in blds if not b['part']]
    for k, b in enumerate(outl):
        P = np.array(b['ring']).reshape(-1, 2); lo, hi = P.min(0), P.max(0)
        b['_P'] = P; b['_cover'] = 0.0
        for gx in range(int(lo[0] // cell), int(hi[0] // cell) + 1):
            for gz in range(int(lo[1] // cell), int(hi[1] // cell) + 1): grid.setdefault((gx, gz), []).append(k)
    def inside(P, x, z):
        xa, za = P[:, 0], P[:, 1]; xb, zb = np.roll(xa, -1), np.roll(za, -1)
        c = ((za > z) != (zb > z)) & (x < (xb - xa) * (z - za) / (zb - za + 1e-12) + xa)
        return bool(c.sum() % 2)
    # OSM outlines (not parts) standing where the NYC data already has a building: the same building twice
    dup = set()
    for k, b in enumerate(outl):
        if b['nyc'] or not nycmode: continue
        cx, cz = b['_P'].mean(0)
        if any(outl[m]['nyc'] and inside(outl[m]['_P'], cx, cz) for m in grid.get((int(cx // cell), int(cz // cell)), [])): dup.add(id(b))
    if dup:
        blds = [b for b in blds if id(b) not in dup]
        print(f'  {len(dup)} OSM buildings already in the NYC data', flush=True)
    for b in blds:
        if not b['part']: continue
        P = np.array(b['ring']).reshape(-1, 2); cx, cz = P.mean(0)
        for k in grid.get((int(cx // cell), int(cz // cell)), []):
            o = outl[k]
            if id(o) not in dup and inside(o['_P'], cx, cz):
                o['_cover'] += b['area']; b['tall'] = b['tall'] or o['tall'] or b['h'] >= 20
                if not b['nm']: b['nm'] = o['nm']
                if b['h'] < 0 and o['h'] > 0: b['h'] = o['h']
                break
    nh = 0
    for b in outl:
        if b['_cover'] > 0.5 * b['area']: b['hidden'] = True; nh += 1
        del b['_P'], b['_cover']
    blds = [b for b in blds if not b.get('hidden')]
    print(f'  city: {len(blds)} buildings and parts ({sum(b["part"] for b in blds)} parts, {nh} outlines replaced by parts), '
          f'{sum(b["tall"] for b in blds)} tall, {sum(b["h"] < 0 for b in blds)} without a height  [{time.time() - t0:.0f} s]', flush=True)
    return dict(blds=blds)

ROOF = {'gabled': 1, 'hipped': 2, 'half-hipped': 2, 'side_hipped': 2, 'pyramidal': 3, 'dome': 4, 'onion': 5, 'skillion': 6, 'round': 7, 'gambrel': 8, 'mansard': 9, 'cone': 10, 'conical': 10, 'flat': 11}
MAT = {'glass': 2, 'brick': 3, 'stone': 4, 'limestone': 4, 'sandstone': 4, 'granite': 4, 'marble': 4, 'concrete': 5, 'metal': 6, 'steel': 6, 'aluminium': 6}
TILE = 1000

def rgb565(c):
    from PIL import ImageColor
    try: r, g, b = ImageColor.getrgb(c.strip())[:3]
    except Exception: return None
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)

def bake_city(L, H, cb, out, cache, osm):
    """Pack every building into assets/real/<id>/city.bin.gz, a compact binary the runtime (src/realCity.js) turns
    into meshes: the tall ones (the skyline) when the flight loads, the low ones tile by tile around the camera.
    Footprints are a few bytes each (vs ~500 bytes as a finished mesh), so the whole city is ~10 MB, not ~300.

    Layout (little endian): 'SKC1', uint32 header length, JSON header (padded to 4 bytes), then int16 words.
    Header: {tile, x0, z0, nx, nz, q (coordinate units per metre), names, tiles: [[i, j, word offset, n tall, n low]]}.
    Tile (i, j) covers x0 + i*tile .. +tile (same for z); its coordinates are relative to its centre.
    Building record (u = uint16, s = int16; heights in 1/4 m, coordinates in 1/q m):
      u n | holes << 12, u flags, s top (height tag: roof top above ground), s min_height, s ground (lowest corner),
      u ground rise to the highest corner, u kind | roof << 4 | levels << 8, s roof height (-4: none),
      u colour (rgb565), u name index + 1, then the outer ring (first point, then deltas; counter-clockwise in x, z)
      and each hole (u count, points as the ring).
    flags: 1 part (building:part), 2 tall, 4 glass, 8 brick, 16 stone, 32 concrete, 64 metal, 128 has colour,
      date bucket << 8 (0 unknown, 1 <1900, 2 <1930, 3 <1950, 4 <1970, 5 <1990, 6 <2010, 7 later).
    kind: 0 house, 1 apartments, 2 garage / shed, 3 church, 4 industrial, 5 commercial / office, 6 public, 7 unknown."""
    import gzip, struct
    blds = cb['blds']
    allp = np.concatenate([np.array(b['ring']).reshape(-1, 2) for b in blds])
    g = sample_grid(L, H, allp[:, 0], allp[:, 1]); o = 0
    for b in blds:
        n = len(b['ring']) // 2; gg = g[o:o + n]; o += n
        b['g0'] = float(gg.min()); b['g1'] = float(gg.max())
    x0, z0, S = L['hi']; nx = nz = int(np.ceil(S / TILE)); q = 8
    tiles = {}
    for b in blds:
        P = np.array(b['ring']).reshape(-1, 2); c = P.mean(0)
        i, j = int((c[0] - x0) // TILE), int((c[1] - z0) // TILE)
        if 0 <= i < nx and 0 <= j < nz: tiles.setdefault((i, j), []).append(b)
    names, nidx = [], {}
    lm = set(L.get('landmarks', {}))
    words, index = [], []
    def pts(P, cx, cz):
        Q = np.round((P - [cx, cz]) * q).astype(np.int64)
        d = Q.copy(); d[1:] = Q[1:] - Q[:-1]
        return d.reshape(-1).clip(-32768, 32767).tolist()
    dates = [1900, 1930, 1950, 1970, 1990, 2010]
    for (i, j), lst in sorted(tiles.items()):
        cx, cz = x0 + (i + 0.5) * TILE, z0 + (j + 0.5) * TILE
        tall = sorted([b for b in lst if b['tall']], key=lambda b: -(b['h'] + b['mh'] * 0.01))
        low = sorted([b for b in lst if not b['tall']], key=lambda b: -b['area'])
        off = len(words)
        for b in tall + low:
            P = np.array(b['ring']).reshape(-1, 2)
            if len(P) > 4000: continue
            holes = [np.array(h).reshape(-1, 2) for h in b['holes'] if len(h) >= 6][:15]
            fl = (1 if b['part'] else 0) | (2 if b['tall'] else 0)
            m = MAT.get(b['mat'].lower(), 0)
            if m: fl |= 1 << m
            col = rgb565(b['col']) if b['col'] else None
            if col is not None: fl |= 128
            try: y = int(b['date']); fl |= (1 + sum(y >= d for d in dates)) << 8
            except ValueError: pass
            nm = 0
            if b['nm'] and (b['h'] >= 150 or b['nm'] in lm):
                if b['nm'] not in nidx: nidx[b['nm']] = len(names); names.append(b['nm'])
                nm = nidx[b['nm']] + 1
            lv = int(min(255, max(0, b['lv']))) if b['lv'] and b['lv'] > 0 else 0
            h = b['h'] if b['h'] > 0 else -1
            rec = [len(P) | (len(holes) << 12), fl, int(round(h * 4)), int(round(b['mh'] * 4)), int(round(b['g0'] * 4)), int(min(65535, round((b['g1'] - b['g0']) * 4))),
                   (b['k'] & 15) | (ROOF.get(b['rs'], 0) << 4) | (lv << 8), int(round(b['rh'] * 4)) if b['rh'] and b['rh'] > 0 else -4, col or 0, nm]
            rec += pts(P, cx, cz)
            for hh in holes: rec += [len(hh)] + pts(hh, cx, cz)
            words += rec
        index.append([i, j, off, len(tall), len(low)])
    arr = np.array(words, dtype=np.int64)
    arr = np.where(arr > 32767, arr - 65536, arr).astype('<i2')  # the unsigned fields, stored as their bit patterns
    hdr = json.dumps(dict(v=1, tile=TILE, x0=x0, z0=z0, nx=nx, nz=nz, q=q, names=names, tiles=index), separators=(',', ':')).encode()
    hdr += b' ' * (-len(hdr) % 4)
    raw = b'SKC1' + struct.pack('<I', len(hdr)) + hdr + arr.tobytes()
    p = os.path.join(out, 'city.bin.gz')
    with open(p, 'wb') as f: f.write(gzip.compress(raw, 9, mtime=0))
    nt = sum(t[3] for t in index); nl = sum(t[4] for t in index)
    print(f'  city.bin.gz {os.path.getsize(p)} bytes ({len(raw)} raw): {len(index)} tiles, {nt} tall, {nl} low, {len(names)} names', flush=True)
