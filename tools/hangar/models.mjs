// Pack the CC0 Poly Haven hangar props (downloaded by fetch.py) into one GLB per texture size.
//   npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions sharp meshoptimizer   (in any folder)
//   node models.mjs DOWNLOAD_DIR OUT_DIR     (copy this file next to that node_modules, or set NODE_PATH-free imports)
// Each model becomes one top-level node named after its Poly Haven id, recentred so its footprint centre sits at the
// origin with its base on y = 0 (wall items: back at z = 0), its meshes joined per material and welded, heavy ones
// simplified, and its textures resized and re-encoded as WebP. Out: props_512.glb (high / ultra) and props_256.glb.
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, flatten, join, weld, simplify, dedup, prune, textureCompress, transformMesh, mergeDocuments, unpartition, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mat4 } from 'gl-matrix';
import fs from 'fs';

const [SRC, OUT] = process.argv.slice(2);
// id: [scale, max triangles, texture size factor (1 = full tier size, 0.5 = half), wall-mounted]
const MODELS = {
  tool_cart: [1, 4000, 1], metal_tool_chest: [1, 2500, 1], metal_toolbox: [1, 1500, 0.5], steel_frame_shelves_02: [1, 1500, 1],
  Barrel_01: [1, 1200, 1], Barrel_02: [1, 1200, 1], old_military_compressor: [1, 6000, 1], portable_welding_cart: [1, 4000, 1],
  portable_generator: [1, 4000, 1], propane_tank: [1, 1200, 0.5], wooden_crate_01: [1, 1500, 1], wooden_crate_02: [1, 1500, 1],
  korean_fire_extinguisher_01: [1, 1200, 0.5], ladder_sectioned_01: [1, 2000, 1],
  wall_clock: [1, 1200, 0.5, true], drill_press_01: [1, 4000, 1], bench_vice_01: [1, 1500, 0.5], hand_truck: [1, 2500, 0.5],
  metal_jerrycan: [1, 1500, 0.5], old_tyre: [1, 900, 0.5], metal_office_desk: [1, 2500, 1], WetFloorSign_01: [1, 300, 0.5],
  cardboard_box_01: [1, 500, 0.5], industrial_storage_cart: [1, 4000, 1], spray_paint_bottles: [1, 1000, 0.25],
  plastic_jerrycan: [1, 1500, 0.5], cement_bag: [1, 600, 0.5], power_box_01: [1, 2000, 0.5, true], tire_pump: [1, 1000, 0.25],
};
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready; await MeshoptEncoder.ready; io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const tris = (doc) => doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);

async function one(id, size) {
  const [scale, maxTris, tf, wall] = MODELS[id];
  const doc = await io.read(`${SRC}/models/${id}/${id}.gltf`);
  await doc.transform(flatten(), join({ keepNamed: false }), weld());
  const n = tris(doc);
  if (n > maxTris) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: maxTris / n, error: 0.05, lockBorder: false }));
  // bake every node transform into its mesh, then recentre
  const root = doc.getRoot(), scene = root.listScenes()[0];
  // (world matrices first: resetting a parent before its children are read would drop the parent's transform)
  const baked = root.listNodes().filter((n) => n.getMesh()).map((n) => [n, n.getWorldMatrix()]);
  for (const node of root.listNodes()) node.setMatrix(mat4.create());
  const done = new Set(); for (const [node, wm] of baked) { const mesh = node.getMesh(); if (done.has(mesh)) continue; done.add(mesh); transformMesh(mesh, wm); }
  const b = getBounds(scene), c = [(b.min[0] + b.max[0]) / 2, b.min[1], wall ? b.min[2] : (b.min[2] + b.max[2]) / 2];
  const m = mat4.create(); mat4.scale(m, m, [scale, scale, scale]); mat4.translate(m, m, [-c[0], -c[1], -c[2]]);
  for (const mesh of root.listMeshes()) transformMesh(mesh, m);
  const top = doc.createNode(id);
  for (const node of scene.listChildren()) { scene.removeChild(node); top.addChild(node); }
  scene.addChild(top);
  const px = Math.max(64, Math.round(size * tf));
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [px, px], quality: 80 }), dedup(), prune());
  console.log(id.padEnd(28), Math.round(n), '->', Math.round(tris(doc)), 'tris', px + 'px');
  return doc;
}
for (const size of [512, 256]) {
  const out = new Document(); out.createBuffer(); const scene = out.createScene('props');
  for (const id of Object.keys(MODELS)) {
    const d = await one(id, size);
    const map = mergeDocuments(out, d);
    for (const s of d.getRoot().listScenes()) for (const node of s.listChildren()) scene.addChild(map.get(node));
  }
  for (const s of out.getRoot().listScenes()) if (s !== scene) s.dispose();
  await out.transform(unpartition(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' })); // EXT_meshopt_compression + quantized attributes (vendor/addons/meshopt_decoder.module.js)
  fs.mkdirSync(OUT, { recursive: true });
  await io.write(`${OUT}/props_${size}.glb`, out);
  console.log(`props_${size}.glb`, fs.statSync(`${OUT}/props_${size}.glb`).size);
}
