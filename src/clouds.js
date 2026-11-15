// Cumulus clouds as lit, depth-sorted sprites. Each puff carries a normal/thickness sprite so it shades
// like a lumpy ball, a precomputed "how much cloud is between me and the sun" factor so cloud bodies
// self-shadow (dark bases, bright sunny tops), a flat cut at the condensation level, and forward
// scattering for silver linings. Cheap enough for tablets: one instanced draw, no raymarching.
import * as THREE from 'three';
import { FOG, FOG_GLSL } from './shaders.js';
import { makeNoise, mulberry32 } from './noise.js';

// 2x2 atlas of puff sprites. RG: normal xy, B: thickness, A: density.
const ST = 14; // floats per puff in the source array
let atlas = null;
function puffAtlas() {
  if (atlas) return atlas;
  const T = 128, S = T * 2, data = new Uint8Array(S * S * 4), n = makeNoise(17), r = mulberry32(5);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * T, oy = Math.floor(v / 2) * T;
    // a few overlapping blobs make a cauliflower outline
    const blobs = [[0, -0.05, 0.36]];
    for (let i = 0; i < 6; i++) { const a = r() * Math.PI * 2, d = 0.1 + r() * 0.17; blobs.push([Math.cos(a) * d, Math.sin(a) * d * 0.8 + 0.03, 0.14 + r() * 0.12]); }
    const hgt = new Float32Array(T * T);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const px = (x + 0.5) / T - 0.5, py = (y + 0.5) / T - 0.5;
      let h = 0;
      for (const [bx, by, br] of blobs) { const d2 = (px - bx) ** 2 + (py - by) ** 2; if (d2 < br * br) h = Math.max(h, Math.sqrt(br * br - d2) / 0.36); }
      const ns = n.fbm(px * 5 + v * 13, py * 5, 3) * 0.6 + n.fbm(px * 13 + v * 7, py * 13, 3) * 0.3;
      // eroded more at the rim than in the core: soft, wispy edges instead of a disc outline
      const rim = 1 - Math.min(1, h * 1.6);
      h = Math.max(0, h * 0.85 + ns * (0.18 + 0.4 * rim));
      h *= Math.max(0, Math.min(1, (0.5 - Math.hypot(px, py)) * 12)); // never touch the quad edge
      hgt[y * T + x] = h;
    }
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const h = hgt[y * T + x], g = (xx, yy) => hgt[Math.min(T - 1, Math.max(0, yy)) * T + Math.min(T - 1, Math.max(0, xx))];
      let nx = (g(x - 4, y) - g(x + 4, y)) * 5, ny = (g(x, y - 4) - g(x, y + 4)) * 5;
      const l = Math.hypot(nx, ny, 1); nx /= l; ny /= l;
      const i = ((oy + y) * S + ox + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = Math.min(1, h) * 255;
      const a = Math.min(1, Math.max(0, (h - 0.03) * 1.9)); data[i + 3] = Math.pow(a * a * (3 - 2 * a), 1.2) * 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return (atlas = t);
}

const vert = /* glsl */`
  attribute vec3 iPos; attribute vec3 iSRV; attribute vec4 iLight; attribute vec4 iCloud;
  uniform vec3 camRight; uniform vec3 camUp;
  varying vec2 vUv; varying vec4 vLight; varying vec3 vWP; varying vec2 vRot; varying float vNear; varying vec4 vCloud;
  void main() {
    vCloud = iCloud;
    float c = cos(iSRV.y), s = sin(iSRV.y);
    vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSRV.x;
    vec3 wp = iPos + camRight * p.x + camUp * p.y;
    vWP = wp; vRot = vec2(c, s); vLight = iLight;
    vUv = uv * 0.5 + vec2(mod(iSRV.z, 2.0), floor(iSRV.z * 0.5)) * 0.5;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = length(mv.xyz);
    vNear = smoothstep(iSRV.x * 0.12, iSRV.x * 0.75, d);
  }`;
const frag = /* glsl */`
  uniform sampler2D map; uniform vec3 fogColor; uniform vec3 camRight; uniform vec3 camUp;
  uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 ambTop; uniform vec3 ambBottom; uniform float opacity;
  varying vec2 vUv; varying vec4 vLight; varying vec3 vWP; varying vec2 vRot; varying float vNear; varying vec4 vCloud;
  ${FOG_GLSL}
  float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5) * 0.0795775; }
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = t.a * 0.9 * vLight.z * vNear * opacity;
    a *= smoothstep(vLight.w - 10.0, vLight.w + 45.0, vWP.y); // flat cloud base at the condensation level
    if (a < 0.004) discard;
    vec2 nxy = t.rg * 2.0 - 1.0;
    nxy = vec2(nxy.x * vRot.x - nxy.y * vRot.y, nxy.x * vRot.y + nxy.y * vRot.x);
    float nz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
    vec3 vd = normalize(vWP - cameraPosition);
    vec3 np = camRight * nxy.x + camUp * nxy.y - vd * nz;
    // blend the puff's own bumps with the whole cloud's shape, so a cloud shades as one body, not a pile of balls
    vec3 nc = normalize((vWP - vCloud.xyz) * vec3(1.0, vCloud.w, 1.0));
    vec3 n = normalize(nc * 0.85 + np * 0.3);
    float thick = t.b;
    float ndl = dot(n, sunDir);
    float cv = dot(vd, sunDir);
    // direct light: through-cloud transmittance (per puff) x local wrap shading, plus forward scattering on thin edges
    float local = clamp(ndl * 0.6 + 0.45, 0.12, 1.0);
    float fwd = hg(cv, 0.6) * 4.0 * (1.0 - thick) + hg(cv, 0.2) * 1.5;
    float tr = vLight.x;
    vec3 direct = sunCol * tr * (local + fwd * mix(0.35, 1.0, tr));
    // sky light from above, darker bounce from below; cloud bases get less of it
    vec3 amb = mix(ambBottom, ambTop, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * mix(0.4, 1.0, vLight.y) * 0.85;
    vec3 col = direct + amb;
    col = applyHeightFog(col, vWP, fogColor);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class CloudField {
  constructor(capacity = 2400) {
    this.capacity = capacity; this.count = 0;
    const g = new THREE.InstancedBufferGeometry(), base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    this.aPos = new Float32Array(capacity * 3); this.aSRV = new Float32Array(capacity * 3); this.aLight = new Float32Array(capacity * 4); this.aCloud = new Float32Array(capacity * 4);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iSRV', new THREE.InstancedBufferAttribute(this.aSRV, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iLight', new THREE.InstancedBufferAttribute(this.aLight, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iCloud', new THREE.InstancedBufferAttribute(this.aCloud, 4).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0; this.geo = g;
    // litColor/shadeColor are read by the smoke particles so they match the clouds
    this.uniforms = {
      map: { value: puffAtlas() }, camRight: { value: new THREE.Vector3(1, 0, 0) }, camUp: { value: new THREE.Vector3(0, 1, 0) },
      fogColor: { value: new THREE.Color(0xbfd1e5) }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) },
      ambTop: { value: new THREE.Color(0.4, 0.5, 0.65) }, ambBottom: { value: new THREE.Color(0.2, 0.22, 0.25) }, opacity: { value: 1 },
      litColor: { value: new THREE.Color(1, 1, 1) }, shadeColor: { value: new THREE.Color(0.6, 0.65, 0.72) },
      ...FOG,
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    // runs for whatever camera renders, so it is right even while the sim is paused
    this.mesh.onBeforeRender = (r, s, cam) => this.updateCamera(cam);
    this.src = new Float32Array(capacity * ST); // x y z size rot variant trans hfrac alpha base | cloud centre xyz, r/ry
    this.order = []; this.lastSort = new THREE.Vector3(1e9, 0, 0);
    this.list = []; // per cloud: {x,y,z,r,ry,first,count,base,top}
  }

  // weather: {clouds, storm, cover}; detail: 0.4..1 (fewer, bigger puffs on slow devices)
  layout(seed, W, base, detail) {
    const r = mulberry32(seed), n = Math.round(W.clouds * 70 * Math.min(1, detail + 0.2));
    this.list = []; let k = 0;
    const per = (big) => Math.round((18 + 30 * big) * detail);
    for (let c = 0; c < n && k < this.capacity - 8; c++) {
      const cx = (r() - 0.5) * 26000, cz = (r() - 0.5) * 26000;
      const big = 0.6 + r() * 1.1 * (W.storm ? 1.5 : 1);
      const R = 380 * big, H = R * (0.75 + r() * 0.5) * (W.storm ? 2.6 : 1) * (W.cover ? 0.6 : 1);
      const cb = base + (r() - 0.5) * 80;
      const cl = { x: cx, y: cb + H * 0.45, z: cz, r: R * 1.1, ry: H * 0.6, first: k, count: 0, base: cb, top: cb + H };
      const np = per(big), sizeK = 1 / Math.sqrt(detail);
      for (let p = 0; p < np && k < this.capacity; p++) {
        const f = Math.pow(r(), 1.4); // more puffs low down: a broad base, a narrower cauliflower top
        const rad = R * Math.sqrt(Math.max(0.04, 1 - f * f)) * Math.sqrt(r());
        const a = r() * Math.PI * 2;
        const size = R * (0.95 - 0.4 * f) * (0.75 + r() * 0.5) * sizeK * (W.storm ? 1.15 : 1);
        const px = cx + Math.cos(a) * rad * 1.3, pz = cz + Math.sin(a) * rad;
        const py = cb + f * H + size * 0.18;
        const o = k * ST; const s = this.src;
        s[o] = px; s[o + 1] = py; s[o + 2] = pz; s[o + 3] = size; s[o + 4] = r() * 6.283; s[o + 5] = Math.floor(r() * 4);
        s[o + 6] = 1; s[o + 7] = Math.min(1, Math.max(0, (py - cb) / H)); s[o + 8] = 0.85 + r() * 0.15; s[o + 9] = cb;
        s[o + 10] = cx; s[o + 11] = cb + H * 0.3; s[o + 12] = cz; s[o + 13] = R / H;
        k++;
      }
      cl.count = k - cl.first; this.list.push(cl);
    }
    this.count = k; this.geo.instanceCount = k;
    this.lastSort.set(1e9, 0, 0);
  }

  // per-puff transmittance towards the light: ray from the puff centre through its neighbours
  light(dir) {
    const s = this.src, dx = dir.x, dy = dir.y, dz = dir.z;
    for (const cl of this.list) {
      const sig = 2.8 / cl.r;
      for (let i = cl.first; i < cl.first + cl.count; i++) {
        const oi = i * ST, x = s[oi], y = s[oi + 1], z = s[oi + 2];
        let od = s[oi + 3] * 0.2;
        for (let j = cl.first; j < cl.first + cl.count; j++) {
          if (j === i) continue;
          const oj = j * ST, rr = s[oj + 3] * 0.4, ex = s[oj] - x, ey = s[oj + 1] - y, ez = s[oj + 2] - z;
          const t = ex * dx + ey * dy + ez * dz; if (t <= 0) continue;
          const d2 = ex * ex + ey * ey + ez * ez - t * t; if (d2 < rr * rr) od += 2 * Math.sqrt(rr * rr - d2) * 0.5;
        }
        s[oi + 6] = 0.12 + 0.88 * Math.exp(-od * sig);
      }
    }
    this.lastSort.set(1e9, 0, 0);
  }

  // clouds live in a 26 km square that wraps around the camera
  wrap(cp) {
    const S = 26000, wrap = (v, c) => c + ((((v - c + S / 2) % S) + S) % S) - S / 2, s = this.src;
    for (const cl of this.list) {
      const nx = wrap(cl.x, cp.x), nz = wrap(cl.z, cp.z), dx = nx - cl.x, dz = nz - cl.z;
      if (!dx && !dz) continue;
      cl.x = nx; cl.z = nz;
      for (let i = cl.first; i < cl.first + cl.count; i++) { const o = i * ST; s[o] += dx; s[o + 2] += dz; s[o + 10] += dx; s[o + 12] += dz; }
    }
    this.lastSort.set(1e9, 0, 0);
  }

  inCloud(p) {
    let best = 0;
    for (const c of this.list) { const d = Math.hypot(p.x - c.x, (p.y - c.y) * (c.r / c.ry), p.z - c.z); if (d < c.r) best = Math.max(best, 1 - d / c.r); }
    return best;
  }

  updateCamera(camera) {
    camera.updateMatrixWorld();
    this.uniforms.camRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
    this.uniforms.camUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    const cp = camera.getWorldPosition(_v);
    if (cp.distanceToSquared(this.lastSort) > 25 * 25) { this.lastSort.copy(cp); this.sort(cp); }
  }

  // back-to-front so the lit tops and shadowed bases layer correctly
  sort(cp) {
    const n = this.count, s = this.src;
    if (this.order.length !== n) { this.order = Array.from({ length: n }, (_, i) => i); this.key = new Float32Array(n); }
    const key = this.key;
    for (let i = 0; i < n; i++) { const o = i * ST, x = s[o] - cp.x, y = s[o + 1] - cp.y, z = s[o + 2] - cp.z; key[i] = x * x + y * y + z * z; }
    this.order.sort((a, b) => key[b] - key[a]);
    const P = this.aPos, R = this.aSRV, L = this.aLight, C = this.aCloud;
    for (let k = 0; k < n; k++) {
      const o = this.order[k] * ST;
      P[k * 3] = s[o]; P[k * 3 + 1] = s[o + 1]; P[k * 3 + 2] = s[o + 2];
      R[k * 3] = s[o + 3]; R[k * 3 + 1] = s[o + 4]; R[k * 3 + 2] = s[o + 5];
      L[k * 4] = s[o + 6]; L[k * 4 + 1] = s[o + 7]; L[k * 4 + 2] = s[o + 8]; L[k * 4 + 3] = s[o + 9];
      C[k * 4] = s[o + 10]; C[k * 4 + 1] = s[o + 11]; C[k * 4 + 2] = s[o + 12]; C[k * 4 + 3] = s[o + 13];
    }
    for (const k of ['iPos', 'iSRV', 'iLight', 'iCloud']) { const at = this.geo.attributes[k]; at.clearUpdateRanges?.(); at.addUpdateRange?.(0, n * at.itemSize); at.needsUpdate = true; }
  }

  dispose() { this.geo.dispose(); this.mesh.material.dispose(); }
}
const _v = new THREE.Vector3();

// Overcast deck: a noise-textured layer. From below it is a lumpy grey ceiling, from above a sunlit sea of cloud.
export function deckMaterial(noiseTex) {
  const U = {
    noiseTex: { value: noiseTex }, off: { value: new THREE.Vector2() }, below: { value: new THREE.Color(0.5, 0.52, 0.55) }, lit: { value: new THREE.Color(1, 1, 1) },
    amb: { value: new THREE.Color(0.4, 0.45, 0.55) }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, opacity: { value: 1 }, upper: { value: 0 }, fogColor: { value: new THREE.Color() },
    ...FOG,
  };
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: /* glsl */`
      uniform sampler2D noiseTex; uniform vec2 off; uniform vec3 below; uniform vec3 lit; uniform vec3 amb; uniform vec3 sunDir; uniform float opacity; uniform float upper; uniform vec3 fogColor;
      varying vec3 vW;
      ${FOG_GLSL}
      void main() {
        vec2 p = vW.xz;
        float n = texture2D(noiseTex, p / 9000.0 + off).r * 0.6 + texture2D(noiseTex, p / 2300.0 + off * 1.6).g * 0.3 + texture2D(noiseTex, p / 1100.0 - off).b * 0.25;
        // fake relief for the sunlit tops: compare with the cloud a little way towards the sun
        vec2 q = p + normalize(sunDir.xz + 1e-4) * 260.0;
        float fromAbove = step(vW.y, cameraPosition.y);
        vec3 col;
        if (fromAbove > 0.5) {
          vec3 vd = normalize(vW - cameraPosition);
          float fw = pow(max(dot(vd, sunDir), 0.0), 8.0);
          float nq = texture2D(noiseTex, q / 2300.0 + off * 1.6).g * 0.3 + texture2D(noiseTex, q / 1100.0 - off).b * 0.25;
          float nn = texture2D(noiseTex, p / 2300.0 + off * 1.6).g * 0.3 + texture2D(noiseTex, p / 1100.0 - off).b * 0.25;
          float relief = clamp(1.0 + (nn - nq) * 3.5 * (1.2 - max(sunDir.y, 0.0)), 0.45, 1.35);
          col = lit * (0.5 + 0.45 * n) * relief * (0.75 + 0.25 * max(sunDir.y, 0.0)) + amb * (0.55 + 0.35 * n) + lit * fw * 0.4;
        } else col = below * (1.35 - 0.75 * n);
        float a = opacity * mix(1.0, smoothstep(0.38, 0.62, n), upper);
        a *= 1.0 - smoothstep(20000.0, 29000.0, length(vW.xz - cameraPosition.xz));
        if (a < 0.004) discard;
        col = applyHeightFog(col, vW, fogColor);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
