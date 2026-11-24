// Traffic lights (#228): a city's crossroads (four or more legs meeting at a junction node) run signals. The lanes
// coming in are split by heading into two groups (one street, the cross street); the groups take turns: green, amber,
// then all red, each junction's cycle offset from its neighbours'. Cars (vehicles.js) stop at the stop line when their
// group isn't green; the lights are drawn at the junctions near the camera (poles and heads instanced, the lamps'
// colours set every frame).
import * as THREE from 'three';

const G = 18, A = 3, R = 2, CYCLE = 2 * (G + A + R); // seconds: green, amber, all red (per group)

export class Signals {
  constructor(graph, { city = false } = {}) {
    this.nodes = new Map(); // node key -> { x, y, z, off, lanes: Map(lane -> group), heads: [{ yaw, group }] }
    if (!city) return;
    const into = new Map();
    for (const L of graph.lanes) { let a = into.get(L.to); if (!a) into.set(L.to, (a = [])); a.push(L); }
    for (const [key, inc] of into) {
      if (!key.startsWith('n')) continue;
      const legs = new Set([...inc, ...(graph.out.get(key) || [])].map((L) => L.piece)); if (legs.size < 4) continue; // (a crossroads: four legs, one-way or two-way)
      const dirs = inc.map((L) => { const { rd, a, b } = L.piece, P = rd.pts, i1 = L.fwd ? b : a, i0 = L.fwd ? Math.max(a, b - 1) : Math.min(b, a + 1), p = P[i1], q = P[i0]; return { L, yaw: Math.atan2(p.x - q.x, p.z - q.z), p }; });
      const y0 = dirs[0].yaw, ax = (y) => { const d = Math.abs(Math.atan2(Math.sin(y - y0), Math.cos(y - y0))); return d < Math.PI / 4 || d > (3 * Math.PI) / 4 ? 0 : 1; };
      const lanes = new Map(), groups = [0, 0]; for (const d of dirs) { const g = ax(d.yaw); lanes.set(d.L, g); groups[g]++; }
      if (!groups[0] || !groups[1]) continue; // (a fork, not a crossroads)
      const p = dirs[0].p, h = (key.length * 7.13 + parseInt(key.slice(1), 10) * 0.6180339) % 1;
      this.nodes.set(key, { x: p.x, y: p.y, z: p.z, off: h * CYCLE, lanes, heads: dirs.map((d) => ({ yaw: d.yaw, group: lanes.get(d.L) })) });
    }
  }
  // 'g' | 'a' | 'r' for lane L arriving at its junction at time t (null: no signal there)
  state(L, t) {
    const n = this.nodes.get(L.to); if (!n) return null;
    const g = n.lanes.get(L); if (g === undefined) return null;
    const c = (t + n.off + (g ? G + A + R : 0)) % CYCLE;
    return c < G ? 'g' : c < G + A ? 'a' : 'r';
  }
  // the lights' meshes (added to group): poles and heads instanced, three lamps a head whose colours update() sets
  build(group) {
    if (!this.nodes.size) return;
    const MAX = 220 * 4; // heads drawn at most (the junctions nearest the camera)
    const pole = new THREE.CylinderGeometry(0.09, 0.11, 5.2, 6).translate(0, 2.6, 0);
    const arm = new THREE.BoxGeometry(0.08, 0.08, 3.2).translate(0, 5.0, 1.6);
    const head = new THREE.BoxGeometry(0.34, 1.0, 0.28).translate(0, 4.4, 3.0);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2f3a34, roughness: 0.6, metalness: 0.4 });
    this.poles = new THREE.InstancedMesh(pole, metal, MAX / 4); this.arms = new THREE.InstancedMesh(arm, metal, MAX); this.heads = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ color: 0x1a1a14, roughness: 0.5 }), MAX);
    const lamp = new THREE.CircleGeometry(0.11, 10).translate(0, 0, 0.145);
    this.lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), MAX * 3);
    for (const m of [this.poles, this.arms, this.heads, this.lamps]) { m.count = 0; m.frustumCulled = false; group.add(m); }
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 9), 3);
    this.MAX = MAX; this.near = []; this.at = null;
  }
  // every frame: the junctions near the camera (re-picked when it has moved 60 m) and their lamps' colours
  update(cam, t) {
    if (!this.heads || !cam) return;
    if (!this.at || Math.hypot(cam.x - this.at.x, cam.z - this.at.z) > 60) {
      this.at = { x: cam.x, z: cam.z };
      const near = []; for (const n of this.nodes.values()) { const d = Math.hypot(n.x - cam.x, n.z - cam.z); if (d < 450) near.push([d, n]); }
      near.sort((a, b) => a[0] - b[0]); this.near = near.slice(0, this.MAX / 4).map((e) => e[1]);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3();
      let np = 0, nh = 0;
      for (const n of this.near) {
        // the pole on the corner, back from the junction's middle; an arm and a head over each approach
        const h0 = n.heads[0].yaw, cx = n.x - Math.sin(h0 + 0.8) * 9, cz = n.z - Math.cos(h0 + 0.8) * 9;
        this.poles.setMatrixAt(np++, m4.compose(p.set(cx, n.y, cz), q.identity(), one));
        for (const hd of n.heads) { if (nh >= this.MAX) break; const yaw = hd.yaw + Math.PI; q.setFromAxisAngle(up, Math.atan2(n.x - cx, n.z - cz)); this.arms.setMatrixAt(nh, m4.compose(p.set(cx, n.y, cz), q, one)); this.heads.setMatrixAt(nh, m4.compose(p.set(cx, n.y, cz), q.setFromAxisAngle(up, yaw), one)); hd.slot = nh++; hd.q = q.clone(); hd.c = new THREE.Vector3(cx, n.y, cz); }
      }
      this.poles.count = np; this.arms.count = nh; this.heads.count = nh; this.lamps.count = nh * 3;
      for (const m of [this.poles, this.arms, this.heads]) m.instanceMatrix.needsUpdate = true;
      // lamps: red, amber, green, top to bottom, on the head's face
      const m2 = new THREE.Matrix4(), o = new THREE.Vector3();
      for (const n of this.near) for (const hd of n.heads) { if (hd.slot === undefined || hd.slot >= nh) continue; for (let k = 0; k < 3; k++) { o.set(0, 4.75 - k * 0.33, 3.0).applyQuaternion(hd.q).add(hd.c); this.lamps.setMatrixAt(hd.slot * 3 + k, m2.compose(o, hd.q, one)); } }
      this.lamps.instanceMatrix.needsUpdate = true;
    }
    const C = this.lamps.instanceColor.array, dim = 0.06;
    for (const n of this.near) for (const hd of n.heads) {
      if (hd.slot === undefined) continue;
      const c = (t + n.off + (hd.group ? G + A + R : 0)) % CYCLE, s = c < G ? 2 : c < G + A ? 1 : 0, o = hd.slot * 9;
      C[o] = s === 0 ? 3 : dim; C[o + 1] = dim; C[o + 2] = dim; // red
      C[o + 3] = s === 1 ? 3 : dim; C[o + 4] = s === 1 ? 1.6 : dim; C[o + 5] = dim; // amber
      C[o + 6] = dim; C[o + 7] = s === 2 ? 3 : dim; C[o + 8] = s === 2 ? 1.6 : dim; // green
    }
    this.lamps.instanceColor.needsUpdate = true;
  }
}
