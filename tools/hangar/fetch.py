"""Download the CC0 Poly Haven textures and models the hangar uses (src/hangarEnv.js), for bake.py / models.mjs.
    python3 tools/hangar/fetch.py OUT_DIR [asset ...]
Textures: 2k diffuse + OpenGL normal + ARM (AO/rough/metal) JPGs into OUT_DIR/tex/<id>/.
Models: the 1k glTF with its .bin and textures into OUT_DIR/models/<id>/."""
import json, sys, os, urllib.request
op = urllib.request.build_opener(); op.addheaders = [("User-Agent", "skywright-asset-fetch/1.0")]; urllib.request.install_opener(op)
TEXTURES = ['hangar_concrete_floor', 'box_profile_metal_sheet', 'corrugated_iron_02', 'metal_plate', 'plywood',
            'concrete_block_wall', 'concrete_floor_01', 'rubber_tiles', 'asphalt_floor']
MODELS = ['tool_cart', 'metal_tool_chest', 'metal_toolbox', 'steel_frame_shelves_01', 'steel_frame_shelves_02', 'Barrel_01', 'Barrel_02',
          'old_military_compressor', 'portable_welding_cart', 'portable_generator', 'propane_tank', 'wooden_crate_01', 'wooden_crate_02',
          'korean_fire_extinguisher_01', 'ladder_sectioned_01', 'wall_clock', 'drill_press_01', 'bench_vice_01',
          'hand_truck', 'metal_jerrycan', 'old_tyre', 'metal_office_desk', 'WetFloorSign_01', 'cardboard_box_01', 'industrial_storage_cart',
          'spray_paint_bottles', 'plastic_jerrycan', 'metal_trash_can', 'cement_bag', 'power_box_01', 'tire_pump', 'hanging_industrial_lamp']
out = sys.argv[1]
want = sys.argv[2:]
def get(u, p):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if not os.path.exists(p): urllib.request.urlretrieve(u, p)
    return os.path.getsize(p)
for a in [t for t in TEXTURES if not want or t in want]:
    d = json.load(urllib.request.urlopen(f"https://api.polyhaven.com/files/{a}"))
    for k in ('Diffuse', 'nor_gl', 'arm'):
        print(a, k, get(d[k]['2k']['jpg']['url'], f"{out}/tex/{a}/{k}.jpg"))
for a in [m for m in MODELS if not want or m in want]:
    d = json.load(urllib.request.urlopen(f"https://api.polyhaven.com/files/{a}"))
    g = d['gltf']['1k']['gltf']
    n = get(g['url'], f"{out}/models/{a}/{a}.gltf")
    for rel, v in g['include'].items(): n += get(v['url'], f"{out}/models/{a}/{rel}")
    print(a, n)
