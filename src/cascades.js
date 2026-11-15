// Cascaded sun shadows (Ultra quality): the sun's own shadow map stays the sharp near cascade around the camera, and
// extra zero-intensity DirectionalLights carry wider shadow maps out to several kilometres, so towns, forests and the
// aircraft's surroundings cast shadows near and far.
//
// No material needs to be set up: lights_fragment_begin is patched once, globally. When a program sees 3 or more
// directional shadow maps (only the Ultra flight scene has that; the hangar and the other tiers have one) it picks,
// per fragment, the tightest cascade the fragment falls inside (blending across a band at each cascade's edge) and
// applies that one shadow to every shadowed directional light. The cascade lights are black, so they add no light.
// The line `getDirectionalLightInfo( directionalLight, directLight );` is kept verbatim: the terrain shader hooks it.
import * as THREE from 'three';

const DIR_LOOP_SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const DIR_LOOP_END = '\t#pragma unroll_loop_end\n#endif\n#if ( NUM_RECT_AREA_LIGHTS > 0 )';
const DIR_LOOP_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n\tDirectionalLight directionalLight;';
const CASCADE_PICK = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 3 && ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	float cascShadow = 0.0, cascLeft = 1.0; IncidentLight cascSun;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		if ( cascLeft > 0.001 ) {
			vec3 cascC = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
			vec2 cascE = min( cascC.xy, 1.0 - cascC.xy );
			float cascW = smoothstep( 0.0, 0.07, min( cascE.x, cascE.y ) ) * step( 0.0, cascC.z ) * step( cascC.z, 1.0 );
			if ( cascW > 0.0 ) {
				DirectionalLightShadow cascS = directionalLightShadows[ i ];
				float cascK = cascLeft * cascW;
				cascShadow += cascK * getShadow( directionalShadowMap[ i ], cascS.shadowMapSize, cascS.shadowIntensity, cascS.shadowBias, cascS.shadowRadius, vDirectionalShadowCoord[ i ] );
				cascLeft -= cascK;
			}
		}
	}
	#pragma unroll_loop_end
	cascShadow += cascLeft;
#endif
`;
let patched = false;
export function patchCascadeChunk() {
  if (patched) return; patched = true;
  const c = THREE.ShaderChunk.lights_fragment_begin;
  if (!c.includes(DIR_LOOP_SHADOW) || !c.includes(DIR_LOOP_START) || !c.includes(DIR_LOOP_END)) { console.warn('cascades: lights_fragment_begin changed, Ultra shadows fall back to one map'); return; }
  // after the loop, directLight is left as the sun (light 0), not the last black cascade light: code after this
  // chunk (flora leaf translucency) reads it
  THREE.ShaderChunk.lights_fragment_begin = c.replace(DIR_LOOP_END, '\t#pragma unroll_loop_end\n\t#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 3\n\tdirectLight = cascSun;\n\t#endif\n#endif\n#if ( NUM_RECT_AREA_LIGHTS > 0 )').replace(DIR_LOOP_START, CASCADE_PICK + DIR_LOOP_START).replace(DIR_LOOP_SHADOW, `
		#if NUM_DIR_LIGHT_SHADOWS >= 3
		directLight.color *= receiveShadow ? cascShadow : 1.0;
		if ( UNROLLED_LOOP_INDEX == 0 ) cascSun = directLight;
		#else
		${DIR_LOOP_SHADOW}
		#endif`);
}
patchCascadeChunk();

// Layer for small shadow casters (house details, cars, parked planes, nearby trees): they render into every cascade
// but the farthest, whose ~4 m texels can't show them anyway. The camera and the nearer cascades see the layer too.
export const NEAR_SHADOW = 2;

const _c = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

export class CascadedShadows {
  // sun: the world's DirectionalLight (becomes cascade 0). splits: far distance of each cascade in metres.
  constructor(scene, sun, { splits = [45, 220, 900, 3600], sizes = [4096, 2048, 2048, 2048], reach = 2500 } = {}) {
    this.sun = sun; this.splits = splits; this.reach = reach; this.frame = 0;
    this.lights = [sun];
    for (let i = 1; i < splits.length; i++) {
      const l = new THREE.DirectionalLight(0x000000, 0); l.castShadow = true;
      scene.add(l); scene.add(l.target); this.lights.push(l);
    }
    this.lights.forEach((l, i) => {
      l.shadow.mapSize.set(sizes[i] ?? sizes[sizes.length - 1], sizes[i] ?? sizes[sizes.length - 1]);
      l.shadow.map?.dispose(); l.shadow.map = null;
      l.shadow.camera.near = 1;
      l.userData.radius = 0;
      if (i < this.lights.length - 1) l.shadow.camera.layers.enable(NEAR_SHADOW);
    });
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  }
  set enabled(on) { for (const l of this.lights) l.castShadow = on; }
  get enabled() { return this.sun.castShadow; }
  // Fit each cascade's orthographic box to a bounding sphere of its slice of the camera frustum (stable under
  // rotation), and snap it to whole shadow texels in light space (stable under translation: no shimmering edges).
  update(camera, lightDir) {
    camera.layers.enable(NEAR_SHADOW);
    if (!this.sun.castShadow) return;
    this.frame++;
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tanX = tanY * camera.aspect;
    // light-space basis exactly as the shadow camera builds it (z toward the light, y up): snapping in it is exact
    _m.lookAt(_c.set(0, 0, 0), _v.copy(lightDir).negate(), Math.abs(lightDir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : _up);
    _q.setFromRotationMatrix(_m); _qi.copy(_q).invert();
    let near = Math.max(camera.near, 0.1);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i], far = this.splits[i];
      // far cascades are re-rendered every other frame (their texels are metres wide; the matrix stays consistent
      // with whatever the map last held, so a skipped frame only lags the coverage, never misplaces a shadow)
      const sh = l.shadow;
      if (i >= 2) { sh.autoUpdate = false; if ((this.frame + i) % 2 === 0) sh.needsUpdate = true; else if (l.userData.radius) { near = far * 0.9; continue; } }
      // sphere around the frustum slice [near, far]: centre on the view axis, radius to the far corners
      const k2 = tanX * tanX + tanY * tanY;
      const zc = Math.min(far, 0.5 * (far + near) * (1 + k2)); // the sphere through the near and far rings
      const r = Math.max(Math.hypot(far - zc, far * Math.sqrt(k2)), Math.hypot(zc - near, near * Math.sqrt(k2)));
      const R = Math.ceil(r * 1.04 / 4) * 4;
      camera.getWorldDirection(_v); _c.copy(camera.position).addScaledVector(_v, zc);
      // texel snap in light space
      const texel = (2 * R) / sh.mapSize.x;
      _c.applyQuaternion(_qi); _c.x = Math.round(_c.x / texel) * texel; _c.y = Math.round(_c.y / texel) * texel; _c.applyQuaternion(_q);
      const cam = sh.camera, back = R + this.reach * (i === 0 ? 0.25 : 1);
      if (R !== l.userData.radius) { cam.left = cam.bottom = -R; cam.right = cam.top = R; l.userData.radius = R; }
      cam.near = 1; cam.far = back + R; cam.updateProjectionMatrix();
      l.target.position.copy(_c); l.position.copy(_c).addScaledVector(lightDir, back);
      l.target.updateMatrixWorld(); l.updateMatrixWorld();
      // bias grows with the texel size (normal offset in world metres)
      sh.normalBias = Math.max(0.05, texel * 1.4); sh.bias = -0.0002 - 0.00002 * i;
      sh.radius = i === 0 ? 1.5 : 1;
      near = far * 0.9; // overlap: the edge blend band lives inside the previous cascade
    }
  }
  dispose(scene) {
    for (const l of this.lights.slice(1)) { scene.remove(l, l.target); l.shadow.map?.dispose(); l.dispose(); }
    this.sun.shadow.camera.layers.disable(NEAR_SHADOW);
    this.lights.length = 1;
  }
}
