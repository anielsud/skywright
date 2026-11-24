// Where cars and bikes start (the flight setup's land choices, World.landStart): 'park' at the stunt park's start arch,
// 'evel' at the canyon jump's run-up (stuntPark.js), 'runway' on the runway (main.js), and 'road': on a street among
// the buildings, found here from the road data.
//
// The street: a straight, level stretch of a mapped road (no bridge, not in a tunnel, not on the airfield or across a
// stunt site), as near as possible to the location's hint (loc.roadStart: a named place from the map data, or a
// lat/lon): a Manhattan avenue, the village street of Wilderswil, Bora Bora's ring road at Vaitape, the main road
// through Tusayan. You start in the right-hand lane, facing along the road.
import * as THREE from 'three';
import { toLocal } from './realworld.js';
import { inStuntCut } from './stuntPark.js';

export function roadStart(w) {
  const cfg = w.loc.roadStart || {}, R = w.real, lim = w.size / 2 - 400;
  let hx = 0, hz = 0;
  if (cfg.place && R) { const p = R.osm.places.find((q) => q[0] === cfg.place); if (p) [hx, hz] = [p[1], p[2]]; }
  else if (cfg.near?.lat != null && R) [hx, hz] = toLocal(R.meta, cfg.near.lat, cfg.near.lon);
  // the roads: every mapped class for a real place (a city draws only its avenues on some tiers; the streets are still there)
  const RL = R?.roadList();
  const roads = R ? RL.roads.filter((r) => r.cls <= (cfg.maxClass ?? 3) && !r.bridge && !r.baked)
    : w.net.roads.filter((r) => !r.bridge?.some((b) => b)).map((r) => ({ pts: r.pts.map((p) => [p.x, p.z]), width: r.width }));
  const tunnels = RL?.tunnels || [];
  const inTunnel = (x, z) => tunnels.some(({ width: wd, pts: tp }) => { for (let k = 0; k + 1 < tp.length; k++) { const [ax, az] = tp[k], dx = tp[k + 1][0] - ax, dz = tp[k + 1][1] - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); if (Math.hypot(ax + dx * t - x, az + dz * t - z) < wd + 10) return true; } return false; });
  let best = null;
  for (const r of roads) {
    // walk the road at 5 m: a point with 35 m of straight road either side
    const P = []; for (let i = 0; i + 1 < r.pts.length; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5)); for (let k = 0; k < n; k++) P.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]); }
    for (let i = 7; i + 7 < P.length; i++) {
      const [x, z] = P[i], d = Math.hypot(x - hx, z - hz); if (best && d >= best.d) continue;
      if (Math.abs(x) > lim || Math.abs(z) > lim || (x > -400 && x < 600 && Math.abs(z) < 1300) || inStuntCut(w.stuntPlan, x, z)) continue;
      const a = P[i - 7], b = P[i + 7], d1 = [x - a[0], z - a[1]], d2 = [b[0] - x, b[1] - z], l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      if (l1 < 25 || l2 < 25 || (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) < Math.cos(0.12)) continue; // (straight)
      const h0 = w.heightAt(a[0], a[1]), h1 = w.heightAt(b[0], b[1]), h = w.heightAt(x, z);
      if (Math.abs(h1 - h0) / (l1 + l2) > 0.07 || h < w.waterLevel + 0.6 || inTunnel(x, z)) continue; // (level, dry, in the open)
      best = { d, x, z, fx: (d1[0] + d2[0]) / (l1 + l2), fz: (d1[1] + d2[1]) / (l1 + l2), width: r.width };
    }
  }
  if (!best) return null;
  const f = new THREE.Vector3(best.fx, 0, best.fz).normalize(), right = new THREE.Vector3(-f.z, 0, f.x), lane = Math.min(3, best.width / 4);
  const pos = new THREE.Vector3(best.x, 0, best.z).addScaledVector(right, lane);
  return { id: 'road', pos, heading: Math.atan2(-f.x, -f.z), lane, at: (slot) => pos.clone().addScaledVector(f, -12 * slot), dist: Math.round(best.d) };
}
