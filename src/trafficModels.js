// The road traffic and airport ground vehicles' models (built by tools/traffic/build.mjs from CC BY models: credits in
// main.js and README): assets/traffic/vehicles.glb (every vehicle at three levels of detail, plus its wheels), one
// colour atlas and one data atlas (R paint mask, G roughness, B metalness).
//
// Everything is one material, so all the traffic on screen can be one THREE.BatchedMesh: one draw call. A car's own
// colour (the batch's per-instance colour) only tints where the paint mask says, so a taxi's chequers, the glass, the
// lights and the tyres keep their colours whatever the car's paint.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/addons/meshopt_decoder.module.js';
import { FOG } from './shaders.js';

const DIR = new URL('../assets/traffic/', import.meta.url).href;
let loading = null;

// meta[id] = { kind, paint, L, W, H, wheels: [[x, y, z, r]...], head: [[x, y, z] x2], tail, tris }
// geo[id] = { lod: [lod0, lod1, lod2], wheels: [geometry centred on its axle...] }, all in the vehicle's frame
// (metres, forward -Z, standing on y = 0), plain Float32 attributes ready for a BatchedMesh.
export function trafficModels(quality = 'high') {
  if (loading) return loading;
  if (typeof createImageBitmap === 'undefined' || typeof fetch === 'undefined') return (loading = Promise.resolve(null)); // (Node tests: no pictures)
  loading = (async () => {
    const half = quality !== 'high'; // the atlas at half size below High (4096 x 3328 RGBA is ~70 MB of GPU memory with mipmaps)
    const pic = async (f, opt) => createImageBitmap(await (await fetch(DIR + f)).blob(), opt);
    const [glb, colour, data] = await Promise.all([
      fetch(DIR + 'vehicles.glb').then((r) => r.arrayBuffer()),
      pic('atlas.webp', half ? { resizeWidth: 2048, resizeHeight: 1664, resizeQuality: 'high', premultiplyAlpha: 'none' } : { premultiplyAlpha: 'none' }),
      pic('data.webp', half ? { resizeWidth: 1024, resizeHeight: 832, resizeQuality: 'high' } : {}),
    ]);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb, '');
    const meta = gltf.scene.userData.vehicles, geo = {};
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const [id, part] = o.name.split('_'), g = plain(o.geometry, o.matrixWorld), G = (geo[id] ??= { lod: [], wheels: [] });
      if (part.startsWith('lod')) G.lod[+part.slice(3)] = g; else G.wheels[+part.slice(5)] = g;
      o.geometry.dispose();
    });
    return { meta, geo, material: material(colour, data) };
  })().catch((e) => { console.warn('[traffic] models did not load', e); return null; });
  return loading;
}

// quantized glTF attributes (normalized ints, the dequantizing scale on the node) -> Float32 in the vehicle's frame
function plain(g, m) {
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv']) {
    const a = g.attributes[k], n = g.attributes.position.count, s = k === 'uv' ? 2 : 3, f = new Float32Array(n * s);
    if (a) for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) f[i * s + c] = a.getComponent(i, c); // (an all-zero attribute can come out of the compressor missing)
    out.setAttribute(k, new THREE.BufferAttribute(f, s));
  }
  out.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.index.array), 1));
  out.applyMatrix4(m);
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}

function material(colour, data) {
  const map = new THREE.Texture(colour), rm = new THREE.Texture(data);
  for (const t of [map, rm]) { t.flipY = false; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; }
  map.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map, roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: 1, alphaTest: 0.5 });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, FOG); // (the world's height fog: shaders.js installFog)
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', `
#ifdef USE_COLOR
      diffuseColor.rgb *= mix( vec3( 1.0 ), vColor, texture2D( roughnessMap, vRoughnessMapUv ).r ); // paint only where the mask says
#endif`);
  };
  m.customProgramCacheKey = () => 'traffic-paint';
  return m;
}
