// Scenery for real-world locations from OpenStreetMap (© OpenStreetMap contributors, ODbL), baked by
// tools/realworld/bake.py: every mapped building extruded from its real footprint (walls from the facade atlas in
// buildings.js, gabled / hipped / flat roofs, Swiss chalet style up in the villages), railways, cable car lines,
// mountain lakes and rivers above the World's water level. (Generated towns, towns.js, went with the generated valley.)
import * as THREE from 'three';
import { Builder, buildingMaterial, buildingDepthMaterial, C, TIER, tierCells, facade, linHex, updateBuildingLights } from './buildings.js';
import { toLocal } from './realworld.js';
import { mulberry32, smoothstep } from './noise.js';
import { CityScenery } from './realCity.js';
import { Landmarks } from './realLandmarks.js';
import { roadIndex, setBack, fitBox, footBoxes, inParts, irregular, lazyParts, FOOT, MAJOR, streetWalls, WORK, workSince, Refiner, fillBare } from './setback.js';

const CHUNK = 1000; // m: buildings are merged per 1 km cell (one draw call each), hidden beyond VIEW
const VIEW = { low: 4500, medium: 8000, high: 14000 };
// kind codes from the bake: 0 house, 1 apartments, 2 farm / barn / shed, 3 church, 4 industrial / commercial, 5 hotel, 6 public
const WALLS = { plaster: [0xf2ece0, 0xe8dcc4, 0xefe2c8, 0xdcd0b8, 0xe6dccc, 0xd8d4c8, 0xf0e8d8], wood: [0xffffff, 0xf0e0c8, 0xd8b898, 0xc8a080] }; // tints over the photo atlas (buildings.js)
const ROOFS = { tile: [0x7a5444, 0x6e4a3c, 0x845a48, 0x664436, 0x8a6250], grey: [0x6a6c70, 0x5a5c62, 0x7a7266, 0x666058], shingle: [0x6e6254, 0x5e544a, 0x7a6c5c, 0x645c54, 0x84786a] }; // (shingles weathered dark: grey-brown)
// loc.osmStyle 'tropical' (Bora Bora): painted plaster and timber houses under corrugated metal, pandanus thatch on the
// resorts, and overwater bungalows (kind 7, or any building standing in the lagoon) on stilts with their piers
const TROPIC = {
  walls: [0xf6f2e8, 0xf2ead6, 0xe6efe2, 0xf4dcc8, 0xd8eaee, 0xf6e6b8, 0xffffff, 0xe8d8c0], wood: [0xfff0dc, 0xf4e0c4, 0xffffff, 0xe8d0b0], // (over the light timber cell: pale to honey)
  metal: [0xa8442e, 0x8e3a2a, 0x3f6e52, 0x3d5f86, 0xc8c8c4, 0xb8b4aa, 0x5a7a8a, 0x7a2e2a], thatch: [0xc8b494, 0xb8a282, 0xd8c49e, 0xa8947a, 0xe6cc96], // (pandanus weathers grey-brown: from the air the resorts' roofs are taupe, a fresh one golden)
};
const DECK = 1.7; // m above the water: bungalow floors and pier decks
// loc.osmStyle 'rustic' (the Grand Canyon): log and stucco tints, low metal roofs in park green and brown
const RUSTIC = {
  log: [0xd8b898, 0xc8a07c, 0xe8c8a8, 0xb88c68, 0xf0d8bc], stucco: [0xd8b896, 0xc8a07a, 0xe0c8a8, 0xbc9474, 0xd4ae8c],
  metal: [0x3f5e48, 0x4a6a4a, 0x56704e, 0x35503e, 0x6a4e3a, 0x5a4232], shingle: [0x6a5444, 0x5a463a, 0x7a6250],
};
// A box roof (gable, hip) spans the footprint's oriented rectangle: only on footprints filling RECT of it, with no point
// of the rectangle's outline more than GAP (m) outside them (a big building's missing corner can be 9% of its rectangle
// and still metres across)
const RECT = 0.9, GAP = 0.6;
// a wall cell's gable ends (the wall above the eaves, no windows)
const END = { [C.WOOD_WIN]: C.WOOD, [C.LOG_WIN]: C.LOG, [C.TIMBER_WIN]: C.CLAP, [C.CLAP_WIN]: C.CLAP, [C.ADOBE_WIN]: C.ADOBE, [C.ADOBE_WIN2]: C.ADOBE, [C.MOTEL_DOOR]: C.ADOBE, [C.STONE_WIN]: C.STONE, [C.CONCRETE]: C.CONCRETE, [C.METAL]: C.METAL, [C.CHURCH_WIN]: C.PLAIN, [C.BOARDS]: C.BOARDS, [C.WOOD]: C.WOOD };

export class RealScenery {
  constructor(world) {
    const W = (this.w = world), D = world.real;
    this.group = new THREE.Group(); world.group.add(this.group);
    this.grid = new Map(); this.chunks = new Map(); this.count = 0;
    this.view = VIEW[W.qName] ?? 8000;
    world.flora?.setForestMask?.((x, z) => D.forest(x, z), W.loc.flora?.bare ? (x, z) => D.bare(x, z) : null); // mapped forests (OSM) instead of noise
    const t0 = performance.now();
    if (D.city) this.city = new CityScenery(world, D, this.group); // a city: baked footprints, built as tiled meshes
    else { this.buildBuildings(D.osm.buildings); W.layout?.onActive((b) => this.relayout(b)); }
    this.landmarks = new Landmarks(world, D, this.group); // bridge structures, the Statue of Liberty, bridge decks to land on
    this.tall = !!D.city || this.landmarks.boxes.length > 0; // obstacles far above the ground: main.js tests hits at any height
    this.buildRails(D.osm.rails);
    this.buildCables(D.osm.cables);
    this.buildLakes(D.osm.lakes || []);
    this.buildRivers(D.rivers);
    this.ms = performance.now() - t0;
  }

  // ---------------- buildings ----------------
  buildBuildings(list) {
    const w0 = { ...WORK }, t0 = performance.now(), roads = roadIndex(this.w); this.setbacks = { cut: 0, dropped: 0, through: 0, flat: 0, ms: performance.now() - t0 }; // (ms: the index and the cuts)
    this.footStats = { n: 0, irr: 0, boxes: 0, max: 0, ms: 0, lazy: 0, load: 0 }; // (the collision boxes: ms in footBoxes, whenever; lazy: the slowest worked out after load; load: at load)
    this.refiner = new Refiner(); // (a huge footprint's boxes, a piece at a time after load: setback.js tiledBoxes)
    const W = this.w, seed0 = W.loc.seed * 5 + 3, lowQ = W.qName === 'low', wl = W.waterLevel;
    // each place's own building rules (loc.osmStyle): 'tropical' Bora Bora, 'rustic' the Grand Canyon, else the Alps
    const trop = W.loc.osmStyle === 'tropical', rustic = W.loc.osmStyle === 'rustic', alpine = !trop && !rustic;
    this.lodgeZones = (W.loc.lodges || []).map(([lat, lon, rr]) => [...toLocal(W.real.meta, lat, lon), rr]);
    this.stats = { n: 0, roof: [0, 0, 0, 0, 0, 0], tiered: 0, balcony: 0, porch: 0, walk: 0, steeple: 0 }; // (what was built: tools/test/bldcheck.js)
    for (const b of list) {
      const [kind, hTag, lv, rsTag, rhTag, minH, flat] = b;
      if (flat.length < 6) continue;
      let P = []; for (let k = 0; k < flat.length; k += 2) P.push([flat[k], flat[k + 1]]);
      const ring = () => { let cx = 0, cz = 0, area = 0; for (let k = 0; k < P.length; k++) { const a = P[k], c = P[(k + 1) % P.length]; cx += a[0]; cz += a[1]; area += a[0] * c[1] - c[0] * a[1]; } return [cx / P.length, cz / P.length, area * 0.5]; };
      let [cx, cz, area] = ring();
      // each building's own random sequence, from where it stands (before any setback): its style is the same whichever
      // others are left out (Low skips the small ones, setbacks drop some) and whatever order they come in
      const r = buildingRng(seed0, cx, cz);
      if (Math.abs(area) < (lowQ ? 60 : W.qName === 'medium' ? 25 : 0)) continue; // lighter on tablets: no garden sheds
      if (Math.abs(cx - 100) < 480 && Math.abs(cz) < 1250) continue; // the game's own airport
      // oriented bounding box: the edge direction giving the smallest rectangle; long axis u, half sizes hl >= hw, centre
      const obb = () => {
        let best = null;
        for (let k = 0; k < P.length; k++) {
          const a = P[k], c = P[(k + 1) % P.length], ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez); if (L < 0.5) continue;
          const ux = ex / L, uz = ez / L;
          let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
          for (const p of P) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
          const ar = (u1 - u0) * (v1 - v0);
          if (!best || ar < best.ar) best = { ar, ux, uz, u0, u1, v0, v1 };
        }
        if (!best) return null;
        let { ux, uz } = best, hl = (best.u1 - best.u0) / 2, hw = (best.v1 - best.v0) / 2;
        const um = (best.u0 + best.u1) / 2, vm = (best.v0 + best.v1) / 2;
        if (hw > hl) { [hl, hw] = [hw, hl]; [ux, uz] = [-uz, ux]; }
        return { ox: um * best.ux - vm * best.uz, oz: um * best.uz + vm * best.ux, ux, uz, hl, hw, ar: best.ar };
      };
      const P0 = P, A0 = Math.abs(area), O0 = obb();
      if (!O0) continue;
      const rect = A0 / Math.max(1, O0.ar);
      // ground under it: walls start just below the lowest corner
      let g0 = Infinity, g1 = -Infinity;
      for (const p of P0) { const h = W.sampleGrid(p[0], p[1]); g0 = Math.min(g0, h); g1 = Math.max(g1, h); }
      const wet = trop && (kind === 7 || g0 < wl + 0.2); // on stilts over the lagoon
      if (wet ? A0 > 900 || g0 < wl - 15 : g0 < wl - 2) continue;
      const base = wet ? wl + DECK : g0 - 0.6;
      // (its looks, roof and height from the footprint as mapped: the setback below cuts the walls, not the style)
      let { ox, oz, ux, uz, hl, hw } = O0; const A = A0;
      // ---- roof shape: 0 flat, 1 gable, 2 hip, 5 a gable cut to the footprint (fitGable). Box roofs (gable, hip) span the
      // footprint's oriented rectangle, so they go only on near-rectangular footprints (on any other shape they'd overhang
      // its empty corners); hipped roofs only where tagged or chosen for a near-rectangle
      let boxy = rect >= RECT;
      for (let a = -1; boxy && a <= 1; a += 0.5) for (const b of a === -1 || a === 1 ? [-1, -0.5, 0, 0.5, 1] : [-1, 1]) { // (the rectangle's outline, 16 points)
        if (outsideRing(P, ox + ux * a * hl - uz * b * hw, oz + uz * a * hl + ux * b * hw) > GAP) { boxy = false; break; }
      }
      const big = A > 450, small = A < 35;
      let roof = rsTag === 4 ? 1 : rsTag === 3 ? 2 : rsTag;
      if (roof < 0) roof = (kind === 4 || kind === 6) && A > 350 ? 0 : trop && kind === 1 && big ? 0 : 1;
      if (alpine && roof === 0 && kind !== 4) roof = 1; // the Alps: flat roofs only on industrial buildings
      // (no giant gables on the huge halls: but the canyon's big lodges keep their low roofs)
      if (!alpine && roof !== 0 && hw > 16 && kind !== 3 && !(rustic && (kind === 1 || kind === 5))) roof = 0;
      const pick = r(); // (drawn whatever the shape: the rest of the building's sequence doesn't depend on it)
      if (roof === 1 && rsTag < 0 && boxy && (alpine ? (kind === 1 || kind === 5 || kind === 6 ? pick < 0.4 : kind === 0 && A > 140 && pick < 0.15) : trop && (wet || kind === 5) && A < 500)) roof = 2;
      if ((roof === 1 || roof === 2) && !boxy) roof = 5;
      const steep = trop && (wet || kind === 5); // thatched resort roofs
      let pitch = kind === 3 ? 1.1 : steep ? 0.95 : kind === 2 ? 0.5 : rustic ? 0.33 : trop ? 0.38 : 0.58;
      // ---- walls: tagged height, from levels, or by kind and size (Bora Bora's houses and the canyon's cabins one storey)
      let rise, walls, eave;
      const heights = () => { // (from the box's width: again if a setback cut it)
        rise = roof === 0 ? 0 : rhTag > 0 ? rhTag : Math.min(hw * pitch * (hw > 16 ? 0.6 : 1), trop ? 5.5 : 9);
        if (hTag > 0) walls = Math.max(2.5, hTag - minH - rise);
        else if (lv > 0) walls = lv * 2.9 + 0.5;
        else if (trop) walls = wet ? 2.9 : small ? 2.5 : kind === 0 || kind === 7 ? 3.6 : kind === 1 ? 8.8 : kind === 3 ? 7.5 : kind === 5 ? (A > 600 ? 7.2 : 3.6) : 5.5;
        else if (rustic) walls = small ? 2.6 : kind === 0 ? (A > 220 ? 6.2 : 3.4) : kind === 1 || kind === 5 ? (A > 1500 ? 9.2 : 6.2) : kind === 2 ? 4 : kind === 3 ? 7 : 6;
        else walls = small ? 2.6 : kind === 0 ? (A > 160 ? 8.6 : 5.9) : kind === 1 ? 11.5 : kind === 2 ? 4.8 : kind === 3 ? 10 : kind === 4 ? 7.5 : kind === 5 ? 12.5 : 9.5;
        if (hTag > 0 && hTag - minH < walls + rise) rise = Math.max(0, hTag - minH - walls);
        eave = wet ? walls : (g0 + g1) / 2 + minH + walls - base;
      };
      heights();
      // ---- style, per place
      const hAbs = (g0 + g1) / 2;
      let chalet = false, motel = false, wallCell, wallCol, roofCell, roofC;
      if (trop) {
        // Bora Bora: painted plaster or light timber under corrugated metal in island colours, pandanus thatch on the
        // resorts; plain windows (no European shutters), no flower boxes
        const thatch = (wet || kind === 5 || (kind === 0 && r() < 0.12)) && A < 600;
        const timber = wet || (thatch && r() < 0.6) || r() < 0.15;
        wallCell = kind === 3 ? C.CHURCH_WIN : timber ? C.TIMBER_WIN : kind === 4 ? C.CONCRETE : small ? C.PLAIN : [C.WIN, C.WIN, C.CLAP_WIN][(r() * 3) | 0];
        wallCol = kind === 3 ? 0xf6f4ee : timber ? TROPIC.wood[(r() * TROPIC.wood.length) | 0] : TROPIC.walls[(r() * TROPIC.walls.length) | 0];
        roofCell = thatch ? C.THATCH : C.SEAM; roofC = thatch ? TROPIC.thatch[(r() * TROPIC.thatch.length) | 0] : TROPIC.metal[(r() * TROPIC.metal.length) | 0];
      } else if (rustic) {
        // the Grand Canyon: log cabins and stuccoed houses under low green or brown metal roofs; the park's lodges stone
        // below and logs above; the motels two storeys of rooms off an outdoor walkway
        const park = this.lodgeZones.some(([x, z, rr]) => Math.hypot(cx - x, cz - z) < rr), u = r(), tint = (pal) => pal[(r() * pal.length) | 0];
        if (kind === 1 || kind === 5) {
          if (park && u < 0.8) { wallCell = eave > 4.5 ? TIER.LODGE : C.LOG_WIN; wallCol = tint(RUSTIC.log); }
          else { const log = u > 0.8; wallCell = log ? C.LOG_WIN : C.ADOBE_WIN; wallCol = tint(log ? RUSTIC.log : RUSTIC.stucco); motel = eave > 4.5 && hl > 6; }
        } else if (kind === 3) { wallCell = C.CHURCH_WIN; wallCol = 0xece4d6; }
        else if (kind === 4) { wallCell = A > 600 ? C.METAL : C.CONCRETE; wallCol = A > 600 ? 0xb8aa98 : 0xd8ccb8; }
        else if (kind === 6) { wallCell = C.ADOBE_WIN2; wallCol = tint(RUSTIC.stucco); }
        else if (kind === 2) { wallCell = C.BOARDS; wallCol = 0xb89878; }
        else { const log = u < (park ? 0.7 : 0.4); wallCell = log ? (small ? C.LOG : C.LOG_WIN) : small ? C.ADOBE : C.ADOBE_WIN; wallCol = tint(log ? RUSTIC.log : RUSTIC.stucco); }
        const metal = kind === 4 || r() < 0.75;
        roofCell = metal ? C.SEAM : C.SHINGLE; roofC = kind === 4 ? 0x8a8c8a : tint(metal ? RUSTIC.metal : RUSTIC.shingle);
      } else {
        // the Alps: chalets (dark timber over a whitewashed masonry ground floor) up in the villages, plaster in the
        // valley towns, plain white churches
        chalet = (kind === 0 || kind === 5 || kind === 2) && r() < (kind === 2 ? 0.75 : smoothstep(600, 1100, hAbs) * 0.6 + 0.12);
        if (kind === 2) { wallCell = chalet ? C.WOOD : C.BOARDS; wallCol = chalet ? WALLS.wood[(r() * 4) | 0] : 0xd8c8b0; }
        else if (chalet) { wallCell = eave > 4.8 ? TIER.CHALET : C.WOOD_WIN; wallCol = WALLS.wood[(r() * 4) | 0]; }
        else if (kind === 1) { wallCell = r() < 0.5 ? C.APT : C.BALCONY; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
        else if (kind === 3) { wallCell = C.CHURCH_WIN; wallCol = 0xf4f2ec; }
        else if (kind === 4) { wallCell = A > 600 ? C.METAL : C.CONCRETE; wallCol = A > 600 ? 0xc8ccd0 : 0xe0ddd6; }
        else if (kind === 5) { wallCell = C.BALCONY; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
        else if (kind === 6) { wallCell = C.WIN; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
        else { wallCell = small ? C.PLAIN : [C.WIN_GREEN, C.WIN, C.WIN_BLUE][(r() * 3) | 0]; wallCol = WALLS.plaster[(r() * WALLS.plaster.length) | 0]; }
        // roofs: the usual Swiss mix (red-brown tiles in the valley towns, dark shingles or grey slate on chalets);
        // the satellite can't help, its 10 m pixels blur roofs into gardens (and the bake clears them from the photo)
        const u = r(), style = kind === 4 ? 'grey' : chalet ? (u < 0.55 ? 'shingle' : u < 0.85 ? 'grey' : 'tile') : (u < 0.68 ? 'tile' : 'grey');
        const pal = ROOFS[style]; roofC = pal[(r() * pal.length) | 0];
        // (the clay photo tile is bright: half the tiled roofs get the weathered dark tile)
        roofCell = style === 'tile' ? (r() < 0.5 ? C.TILES : C.DARKTILE) : style === 'shingle' ? C.SHINGLE : kind === 4 ? C.SEAM : C.SLATE;
      }
      // ---- a chalet's roof (traced from the Grindelwald, Wengen and Lauterbrunnen photos): low, about 23 degrees, over wide
      // eaves, and wider still at the gable, which faces the valley: the ridge runs down the slope (on the level: the
      // gable to the street). Weathered dark shingles; on the barns and the old huts up high, laid shingles weighted with
      // stones on poles. (Its own draws: the rest of the building's sequence, and every other building, keep their looks)
      let overZ = null, across = false;
      const orient = () => { // (the ridge along u: swapped onto n when the gable should face that way)
        if (!(alpine && chalet && (roof === 1 || roof === 5)) || hl > hw * 1.7) return;
        const d = hl + 6, e = hw + 6, gs = (x, z) => W.real.height(x, z); // (the survey's heights: the same at every tier)
        const gu = (gs(ox + ux * d, oz + uz * d) - gs(ox - ux * d, oz - uz * d)) / (2 * d), gn = (gs(ox - uz * e, oz + ux * e) - gs(ox + uz * e, oz - ux * e)) / (2 * e);
        if (Math.hypot(gu, gn) > 0.05) across = Math.abs(gn) > Math.abs(gu);
        else { // level: whichever way the walls on a street face
          const sw = streetWalls(roads, P, 8); let su = 0, sn = 0;
          for (let k = 0; k < P.length; k++) if (sw[k]) { const a = P[k], c = P[(k + 1) % P.length], ex = c[0] - a[0], ez = c[1] - a[1]; su += Math.abs(ex * ux + ez * uz); sn += Math.abs(-ex * uz + ez * ux); }
          across = su > sn * 1.2;
        }
        if (across) { [ux, uz] = [-uz, ux]; [hl, hw] = [hw, hl]; }
      };
      if (trop && roofCell === C.THATCH && roof !== 0) { pitch = 0.95; heights(); } // (thatch is steep, on a house too)
      if (alpine && chalet && roof !== 0 && roof !== 3) {
        const rc = buildingRng(seed0 + 23, cx, cz);
        pitch = kind === 2 ? 0.45 : 0.42;
        orient(); heights();
        overZ = Math.min(2.1, 1.4 + hw * 0.08);
        if ((kind === 2 && rc() < 0.3) || (hAbs > 1000 && rc() < 0.1)) roofCell = C.ROOF_STONES;
      }
      const endCell = END[tierCells(wallCell)[1]] ?? C.PLAIN; // gable ends: the upper floors' wall without windows
      const seed = (r() * 255) | 0, extra = r(); // (extra: which end a steeple stands at; whether a chalet has a balcony)
      // set back from the roads (setback.js): cut back off the tarmac and verge, or left out where the road runs through
      // (after all its draws: every other building keeps its looks). Under a box roof (which covers the footprint's whole
      // rectangle) the house is trimmed as that rectangle: a smaller house under the same roof; a cut gable follows any cut.
      const ts = performance.now(), sb = setBack(roads, P, A0 >= MAJOR.area || hTag >= MAJOR.height || lv >= 8, roof === 1 || roof === 2, { h: walls + rise, tagged: hTag > 0 || lv > 0 }); this.setbacks.ms += performance.now() - ts;
      if (sb.through) this.setbacks.through++;
      if (sb.drop) { this.setbacks.dropped++; continue; }
      if (sb.cut) { this.setbacks.cut++; P = sb.P; [cx, cz, area] = ring(); ({ ox, oz, ux, uz, hl, hw } = obb() || O0); if (overZ != null) orient(); heights(); }
      const n = P.length;
      // the collision box: the footprint's, kept off the road (setback.js fitBox: a box reaches over the tarmac where the
      // walls don't, past a cut-off corner or an L's yard); a box roof over that box would overhang the road too: a gable
      // cut to the footprint then
      const tb = performance.now(), cb = fitBox(roads, { x: ox, z: oz, ux, uz, hl, hw }); // (a passage under it too: its box off the road where it can be) this.setbacks.ms += performance.now() - tb;
      if (cb?.fit && (roof === 1 || roof === 2)) { roof = 5; this.setbacks.flat++; }
      // (an irregular footprint, an L, a U, a cross: a few boxes that hug its walls instead, setback.js footBoxes, worked
      // out when first wanted; its box till then the one round its footprint, FOOT.out wider. So is one whose box moved
      // in off the road, cb.fit, leaving a slice of it bare)
      const tf = performance.now(), irr = (cb?.fit && 4 * cb.hl * cb.hw < 0.93 * Math.abs(area)) || irregular(P, Math.abs(area), ox, oz, ux, uz, hl, hw); this.footStats.n++; this.footStats.load += performance.now() - tf;
      // ---- geometry: everything a building has goes into its chunk's builder in one run (destruction.js)
      const ch = this.chunk(cx, cz), B = ch.B, n0 = B.n;
      B.seed = seed; B.lyOff = wet ? 0 : hAbs - base; // (heights for the facade programs from the mean ground: a plinth shows its height above that, more downhill)
      B.setFrame(0, base, 0, 0);
      const nx = -uz, nz = ux, yaw0 = Math.atan2(ux, uz), ccw = area > 0; // (walls need the outside on their front: walk the ring so the face normal points out)
      // a veranda (Bora Bora's houses) or a walkway (motels) under the roof carried on down: on the long side facing
      // downhill (the lagoon, the car park)
      const porch = roof === 1 && !wet && ((trop && (kind === 0 || kind === 7) && !small && A < 400 && hl > 3) || motel);
      let side = 1; // +1: the porch is on the +n side
      if (porch) { const d = hw + 3; side = W.sampleGrid(ox + nx * d, oz + nz * d) <= W.sampleGrid(ox - nx * d, oz - nz * d) ? 1 : -1; }
      // (a motel under a roof cut to its footprint: the walkway along its longest wall)
      let walkK = -1; if (motel && roof === 5) { let bl = 0; for (let k = 0; k < n; k++) { const a = P[k], c = P[(k + 1) % n], L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (L > bl) { bl = L; walkK = k; } } }
      // ground floors (buildings.js facade programs): a door on a wall facing the street, a plinth, shop fronts
      const fac = this.facades(wallCell, kind, chalet, wet, eave, buildingRng(seed0 + 11, cx, cz)()), street = fac?.front ? streetWalls(roads, P, 8) : null;
      for (let k = 0; k < n; k++) {
        const a = P[k], c = P[(k + 1) % n], [s, e] = ccw ? [c, a] : [a, c];
        let cell = wallCell, u0 = 0, yf = 0;
        if (motel) { const L = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1, on = ((s[1] - e[1]) * nx + (e[0] - s[0]) * nz) / L; if (porch ? on * side > 0.7 : k === walkK) cell = C.MOTEL_DOOR; } // (its outward normal along the walkway side)
        else if (fac) { const front = street && street[k]; cell = front ? fac.front : fac.rear; yf = B.lyOff + fac.yf; if (front) u0 = -Math.floor(Math.max(1, Math.round(Math.hypot(e[0] - s[0], e[1] - s[1]) / 3)) / 2); }
        B.wall(s[0], s[1], e[0], e[1], 0, eave, cell, wallCol, 3, 3, u0, yf);
      }
      if (walkK >= 0) { const a = P[walkK], c = P[(walkK + 1) % n]; this.walkway(B, ccw ? c : a, ccw ? a : c, eave); }
      const yaw = porch && side < 0 ? yaw0 + Math.PI : yaw0; // (the gable's -x side is the porch side)
      if (roof === 1 || roof === 2) {
        B.setFrame(ox, base, oz, yaw);
        // (thatch: a deep eave, and its edge and underside thatch too, thick and with no gutter)
        const thatch = roofCell === C.THATCH, over = kind === 4 ? 0.3 : chalet ? 1.2 : thatch ? 1.0 : 0.6, deep = porch ? (motel ? 2.3 : 2.6) : over;
        const edge = thatch ? { trim: C.THATCH, trimCol: new THREE.Color(roofC).multiplyScalar(0.72).getHex(), th: 0.4, gutter: false } : chalet ? { trim: C.WOOD, trimCol: 0x6a5038, th: 0.3 } : {}; // (a chalet's fascia and barge boards: dark timber, not white)
        if (roof === 1) B.gable(hw * 2, hl * 2, eave, rise, over, roofCell, roofC, endCell, wallCol, { under: chalet ? C.WOOD : null, overN: deep, overZ: overZ ?? over, ...edge });
        else B.hip(hw * 2, hl * 2, eave, rise, over, roofCell, roofC, edge);
        if (porch) this.porch(B, hw, hl, eave, rise, deep, motel);
        // a chalet's balcony: across the gable end facing downhill, on top of the masonry ground floor (the carved railing)
        if (chalet && roof === 1 && wallCell === TIER.CHALET && hw > 2.5 && extra < 0.6) {
          const zs = W.sampleGrid(ox + ux * (hl + 2), oz + uz * (hl + 2)) <= W.sampleGrid(ox - ux * (hl + 2), oz - uz * (hl + 2)) ? 1 : -1;
          this.balcony(B, hw - 0.4, hl * zs, zs, B.lyOff + 2.8); this.stats.balcony++;
        }
      } else if (roof === 5) this.fitGable(B, P, ccw, ox, oz, nx, nz, hw, eave, rise, roofCell, roofC, endCell, wallCol);
      else this.flatRoof(B, P, eave, C.ROOF_GRAVEL, kind === 4 ? 0x9a968e : 0x8a867e); // (a roof cell: the tint decides, not the bright photo)
      // a church's steeple: a white tower at one end, up through the roof, a spire on top
      const steeple = kind === 3 && A > 50;
      if (steeple) {
        B.setFrame(ox, base, oz, yaw0);
        // (at an end of the nave, or wherever along it the tower stands inside the walls: an L-shaped church's arm)
        const s = Math.max(3, Math.min(6, hw * 1.2)), fits = (z) => Math.max(...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => outsideRing(P, ox + ux * (z + a * s / 2) + nx * b * s / 2, oz + uz * (z + a * s / 2) + nz * b * s / 2)));
        let zt = (hl - s / 2) * (extra < 0.5 ? 1 : -1);
        if (fits(zt) > 0.5) zt = [-zt, 0, zt * 0.5, -zt * 0.5].reduce((m, z) => (fits(z) < fits(m) ? z : m), zt);
        const y1 = eave + rise + Math.max(3, s * 0.9), sp = s * (trop ? 1.4 : 2.2);
        B.box(0, 0, zt, s, y1, s, C.PLAIN, wallCol, { top: false });
        B.setFrame(ox + ux * zt, base, oz + uz * zt, yaw0);
        B.hip(s + 0.3, s + 0.3, y1, sp, 0, trop ? C.SEAM : rustic ? C.SHINGLE : C.SLATE, trop ? 0xa8442e : rustic ? 0x5a463a : 0x4a4c52);
      }
      if (wet) this.bungalowDeck(B, ox, oz, ux, uz, hl, hw, base);
      B.lyOff = 0;
      const st = this.stats; st.n++; st.roof[roof]++; if (chalet && wallCell === TIER.CHALET) st.tiered++; if (porch) st.porch++; if (walkK >= 0) st.walk++; if (steeple) st.steeple++;
      ch.n++; ch.x += cx; ch.z += cz;
      // collisions: a disc per building (the aircraft's parts are tested against these)
      const key = Math.floor(cx / 50) + ',' + Math.floor(cz / 50);
      if (!this.grid.has(key)) this.grid.set(key, []);
      const e = [cx, base, cz, eave + rise, Math.sqrt(Math.abs(area) / Math.PI)];
      e.solid = true; e.fp = P; if (sb.through) e.through = true; e.dk = 'r' + this.count; e.rng = [[B, n0, B.n - n0]]; e.ob = irr ? { x: ox, z: oz, ux, uz, hl: hl + FOOT.out, hw: hw + FOOT.out } : cb || { x: ox, z: oz, ux, uz, hl, hw }; if (irr) osmBoxes(this, e, ux, uz, !sb.through, roads, [cb || { x: ox, z: oz, ux, uz, hl, hw }]); if (irr && A > FOOT.eager) void e.parts; // (a big one now: not a hitch later) // destructible (destruction.js); its boxes (World.wallBoxes)
      e.wet = wet; e.kind = kind; e.roof = roof; e.rect = rect; e.walls = walls; e.chalet = chalet; e.pitch = roof === 0 ? 0 : rise / Math.max(0.1, hw); e.rise = rise; e.ridge = [ux, uz]; e.overMax = Math.hypot(chalet ? 1.2 : 0.6, overZ ?? (chalet ? 1.2 : 0.6)); e.stones = roofCell === C.ROOF_STONES; e.tagged = hTag > 0 || lv > 0; e.porch = porch || walkK >= 0; e.steeple = steeple; e.wet = wet; // (what it was built as: tools/test/bldcheck.js)
      this.grid.get(key).push(e);
      this.count++;
    }
    this.footStats.ready = true; this.loadWork = { ...workSince(w0), irr: this.footStats.irr, n: this.footStats.n }; // (setback.js WORK at load: tools/test/setbacks.js)
    this.buildPiers(W.real.osm.piers || []);
    const mat = (this.mat = buildingMaterial({ cellPx: { low: 128, medium: 192, ultra: 384 }[W.qName] ?? 256, interiors: W.qName !== 'low' })); // the towns' atlas
    W.windowMats = W.windowMats || []; W.windowMats.push(mat);
    this.chunkList = [];
    for (const ch of this.chunks.values()) {
      if (ch.B.empty) continue;
      const g = ch.B.toGeometry(), m = new THREE.Mesh(g, mat); m.customDepthMaterial = buildingDepthMaterial();
      m.castShadow = W.qBase === 'high'; m.receiveShadow = true;
      this.group.add(m);
      this.chunkList.push({ m, x: ch.x / ch.n, z: ch.z / ch.n, r: g.boundingSphere.radius });
    }
    this.chunks = null;
  }
  // a baked layout chunk's surface arrived (#294, ?layout=1): each building standing in it moved up or down onto it (its
  // walls from just below its lowest corner, as built: its vertices, one run in its chunk's mesh, and its collision disc)
  relayout(b) {
    const L = this.w.layout, moved = new Map();
    for (const a of this.grid.values()) for (const e of a) {
      if (!e.fp || e.wet || !e.rng || !e.fp.some((p) => p[0] >= b.x0 - 1 && p[0] <= b.x1 + 1 && p[1] >= b.z0 - 1 && p[1] <= b.z1 + 1)) continue; // (one across chunks: once they're all in)
      let g0 = Infinity; for (const p of e.fp) { const y = L.placeY(p[0], p[1]); if (!(y === y)) { g0 = Infinity; break; } g0 = Math.min(g0, y); }
      const dy = g0 - 0.6 - e[1]; if (!(Math.abs(dy) > 0.02 && Math.abs(dy) < 30)) continue;
      for (const [B, s, n] of e.rng) { const P = B.geo?.attributes.position; if (!P || !n) continue; for (let v = s; v < s + n; v++) P.array[v * 3 + 1] += dy; const r = moved.get(P) || [Infinity, -Infinity]; moved.set(P, [Math.min(r[0], s), Math.max(r[1], s + n)]); }
      e[1] += dy;
    }
    for (const [P, [s, t]] of moved) { P.addUpdateRange(s * 3, (t - s) * 3); P.needsUpdate = true; }
  }
  // piers and jetties (OSM man_made=pier): plank decks on piles, walkways out to the overwater bungalows
  buildPiers(list) {
    const W = this.w, wl = W.waterLevel;
    for (const [area, width, flat] of list) {
      const P = []; for (let k = 0; k < flat.length; k += 2) P.push([flat[k], flat[k + 1]]);
      if (P.length < 2 || P.some((p) => Math.abs(p[0] - 100) < 480 && Math.abs(p[1]) < 1250)) continue;
      const deck = (x, z) => Math.max(wl + DECK, W.sampleGrid(x, z) + 0.25);
      if (area) {
        if (P.length < 3) continue;
        let cx = 0, cz = 0; for (const p of P) { cx += p[0] / P.length; cz += p[1] / P.length; }
        const ch = this.chunk(cx, cz); ch.B.setFrame(0, 0, 0, 0);
        this.flatRoof(ch.B, P, deck(cx, cz), C.BOARDS, 0x9a7a58);
        ch.n++; ch.x += cx; ch.z += cz;
        continue;
      }
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
        const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2, y = Math.max(deck(a[0], a[1]), deck(b[0], b[1]));
        const ch = this.chunk(cx, cz), B = ch.B; B.setFrame(0, 0, 0, 0);
        B.obox(cx, cz, ux, uz, L / 2 + width * 0.3, width / 2, y - 0.25, y, C.BOARDS, 0x9a7a58);
        for (let t = 0; t <= L; t += 4) for (const sd of [-1, 1]) {
          const px = a[0] + ux * t - uz * sd * (width / 2 - 0.15), pz = a[1] + uz * t + ux * sd * (width / 2 - 0.15), g = W.sampleGrid(px, pz);
          if (g > y - 0.6) continue;
          B.box(px, Math.min(g, wl - 0.5), pz, 0.24, y - 0.25 - Math.min(g, wl - 0.5), 0.24, C.DARKWOOD, 0x5a4634, { top: false });
        }
        ch.n++; ch.x += cx; ch.z += cz;
      }
    }
  }
  chunk(x, z) {
    const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
    let c = this.chunks.get(k);
    if (!c) {
      this.chunks.set(k, (c = { B: new Builder(), n: 0, x: 0, z: 0 }));
      // High / Ultra: gutters and downpipes (fine 2: no window sills), written into the same builder (so each building's vertices
      // stay one contiguous run for destruction.js, and no extra draw call)
      if (this.w.qBase === 'high') { c.B.det = c.B; c.B.fine = 2; }
    }
    return c;
  }
  // A gable roof cut to any footprint: the two planes of a ridge along the long axis (through the oriented box's centre,
  // normal n across it), over the footprint grown by a short eave (and a soffit under that eave), the walls carried up
  // under them: a gable end wherever a wall crosses the ridge. Nothing hangs over an empty corner. (World frame at base.)
  fitGable(B, P, ccw, ox, oz, nx, nz, hw, eave, rise, cell, col, endCell, wallCol) {
    const k = rise / hw, sl = Math.hypot(1, k) / 3, n = P.length, ux = nz, uz = -nx, OV = 0.45;
    const vOf = (p) => (p[0] - ox) * nx + (p[1] - oz) * nz, hOf = (p) => eave + rise - Math.abs(vOf(p)) * k;
    const cut = (p, q) => { const a = vOf(p), b = vOf(q), t = a / (a - b); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
    // the walls above the eaves
    for (let i = 0; i < n; i++) {
      const a = P[i], c = P[(i + 1) % n], [s, e] = ccw ? [c, a] : [a, c], pts = [s];
      if (vOf(s) * vOf(e) < 0) pts.push(cut(s, e));
      pts.push(e);
      let u0 = 0;
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j - 1], q = pts[j], L = Math.hypot(q[0] - p[0], q[1] - p[1]), hp = hOf(p), hq = hOf(q), u1 = u0 + L / 3, v = eave / 3;
        if (L > 0.05 && (hp > eave + 0.05 || hq > eave + 0.05)) {
          if (hp < eave + 0.02) B.tri([p[0], eave, p[1]], [q[0], eave, q[1]], [q[0], hq, q[1]], [u0, v, u1, v, u1, hq / 3], endCell, wallCol);
          else if (hq < eave + 0.02) B.tri([p[0], eave, p[1]], [q[0], eave, q[1]], [p[0], hp, p[1]], [u0, v, u1, v, u0, hp / 3], endCell, wallCol);
          else B.quad([p[0], eave, p[1]], [q[0], eave, q[1]], [q[0], hq, q[1]], [p[0], hp, p[1]], [u0, v, u1, v, u1, hq / 3, u0, hp / 3], endCell, wallCol);
        }
        u0 = u1;
      }
    }
    // the footprint grown by the eave: each corner out along its mitre
    const sg = ccw ? 1 : -1, Q = [];
    for (let i = 0; i < n; i++) {
      const p = P[i], a = P[(i + n - 1) % n], c = P[(i + 1) % n], l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, l2 = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
      const m1x = sg * (p[1] - a[1]) / l1, m1z = -sg * (p[0] - a[0]) / l1, m2x = sg * (c[1] - p[1]) / l2, m2z = -sg * (c[0] - p[0]) / l2, f = OV / Math.max(0.5, 1 + m1x * m2x + m1z * m2z);
      Q.push([p[0] + (m1x + m2x) * f, p[1] + (m1z + m2z) * f]);
    }
    simplifyRing(Q, 0.2); // (the mapped curves' extra points: under the eave's 45 cm they'd only cost vertices)
    const m = Q.length;
    // the roof: each side of the ridge one plane over its half of the grown footprint
    for (const sgn of [1, -1]) {
      const H = [];
      for (let i = 0; i < m; i++) {
        const p = Q[(i + m - 1) % m], q = Q[i], vp = sgn * vOf(p), vq = sgn * vOf(q);
        if ((vp >= 0) !== (vq >= 0)) H.push(cut(p, q));
        if (vq >= 0) H.push(q);
      }
      const R = H.filter((p, i) => Math.hypot(p[0] - H[(i + 1) % H.length][0], p[1] - H[(i + 1) % H.length][1]) > 0.01);
      if (R.length < 3) continue;
      // (one plane: its vertices shared, Builder.fan)
      const T = [];
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(R.map((p) => new THREE.Vector2(p[0], p[1])), [])) {
        const pa = R[a], pb = R[b], pc = R[c], w = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]);
        if (Math.abs(w) > 0.02) T.push(w > 0 ? [a, b, c] : [a, c, b]); // (slivers left out: in float32 world positions they can flip over)
      }
      const uv = R.map((p) => [((p[0] - ox) * ux + (p[1] - oz) * uz) / 3, (hw - Math.abs(vOf(p))) * sl]);
      B.fan(R.map((p) => [p[0], hOf(p), p[1]]), uv, T, cell, col);
      // its underside (the soffit under the eaves; the rest is inside the walls), High only like the gutters: on a tablet
      // it'd double these roofs' vertices for a strip seen from below
      if (this.w.qBase === 'high') B.fan(R.map((p) => [p[0], hOf(p) - 0.16, p[1]]), uv, T.map(([a, b, c]) => [a, c, b]), C.TRIM, 0xe6e2da); // (real uvs: the shader's tangent frame needs them to vary)
    }
  }
  // A building's facade programs (buildings.js facade): { front: its walls facing a street, rear: the others, yf: the
  // floor datum (v = 0) above the mean ground (Builder.lyOff) }, or null for plain walls. From the reference photos: chalets on a whitewashed masonry ground
  // floor (their door in it) or a stone plinth, the barns on stone; the valley towns' plastered houses on a grey
  // plinth with their door on the street, and the shops (Interlaken, Wengen, Grindelwald) in the ground floor of the
  // hotels and commercial blocks; Bora Bora's houses on their slab, the canyon's adobe with its turquoise door. (u: a
  // draw of the building's own, not from its style sequence)
  facades(cell, kind, chalet, wet, eave, u) {
    const st = this.w.loc.osmStyle, F = facade, stone = linHex(0x8a867e), slab = linHex(0xc8c2b6);
    if (st === 'rustic') return cell === C.ADOBE_WIN && eave > 2.5 ? { front: F({ upper: cell, door: C.ADOBE_DOOR, doorUp: true }), rear: cell, yf: 0 } : null;
    if (st === 'tropical') {
      if (wet || !(cell === C.WIN || cell === C.CLAP_WIN || cell === C.PLAIN)) return null;
      const o = { upper: cell, ground: C.CONCRETE, gH: 0.3, metric: true, groundCol: slab };
      return { front: F({ ...o, door: cell === C.CLAP_WIN ? C.CLAP_DOOR : C.DOOR, doorUp: true }), rear: F(o), yf: 0 };
    }
    if (cell === TIER.CHALET) return { front: F({ upper: C.WOOD_WIN, ground: C.MASONRY_WIN, gH: 2.8, door: C.MASONRY_DOOR }), rear: cell, yf: -0.2 };
    if (chalet || kind === 2) { const o = { upper: cell, ground: C.STONE, gH: 0.8, metric: true, groundCol: stone }; return { front: cell === C.WOOD_WIN ? F({ ...o, door: C.WOOD_DOOR, doorUp: true }) : F(o), rear: F(o), yf: 0 }; }
    if (eave < 3) return null;
    const plinth = { upper: cell, ground: C.CONCRETE, gH: 0.5, metric: true, groundCol: stone };
    // shops: in a hotel's or a commercial block's ground floor, some apartment houses'; the floors above fitted over it
    if (eave > 7 && ((kind === 5 && u < 0.6) || (kind === 4 && cell === C.CONCRETE && u < 0.7) || (kind === 1 && u < 0.3)))
      return { front: F({ upper: cell, ground: C.SHOPFRONT, door2: C.SHOP_DOOR, every: 3, gH: 3.6, band: 0.35, bandCell: C.PLAIN, shop: true }), rear: F(plinth), yf: 0.6 };
    const door = cell === C.WIN || cell === C.WIN_GREEN || cell === C.WIN_BLUE || cell === C.APT || cell === C.BALCONY || cell === C.PLAIN ? C.DOOR : -1;
    return { front: door >= 0 ? F({ ...plinth, door, doorUp: true }) : F(plinth), rear: F(plinth), yf: 0 };
  }
  // Bora Bora's verandas, the motels' walkways (gable frame: the porch is under the roof's deep -x side)
  porch(B, hw, hl, eave, rise, deep, motel) {
    const under = (x) => eave - (-x - hw) * rise / hw - 0.24; // the roof's underside at x (x < -hw)
    // (not the side facing the house; Low: only the face out from under the roof, like the gutters: a 20 cm post
    // seen side on is a pixel wide on a tablet)
    const post = (x, z, c, col) => B.obox(x, z, 1, 0, 0.1, 0.1, 0, under(x), c, col, { top: false, sides: this.w.qName === 'low' ? [3] : [0, 2, 3] });
    if (motel) { // the upper floor's walkway: a slab off the wall, an iron railing, timber posts down to the ground
      const y = 3.6, x1 = -(hw + 1.9);
      face(B, [[x1, y, -hl], [-hw, y, -hl], [-hw, y, hl], [x1, y, hl]], C.CONCRETE, 0xc8c0b4, 0, 1, 0);
      face(B, [[x1, y - 0.25, -hl], [-hw, y - 0.25, -hl], [-hw, y - 0.25, hl], [x1, y - 0.25, hl]], C.CONCRETE, 0xb0a89c, 0, -1, 0);
      face(B, [[x1, y - 0.25, -hl], [x1, y - 0.25, hl], [x1, y, hl], [x1, y, -hl]], C.CONCRETE, 0xc8c0b4, -1, 0, 0);
      const L = (2 * hl) / 1.2;
      B.panel([x1 + 0.05, y, -hl], [x1 + 0.05, y, hl], [x1 + 0.05, y + 1, hl], [x1 + 0.05, y + 1, -hl], C.RAIL_IRON, 0x4a3a2c, 3, [0, 0, L, 0, L, 1, 0, 1]);
      const m = Math.max(2, Math.round((2 * hl) / 5) + 1);
      for (let k = 0; k < m; k++) post(x1 + 0.15, -hl + 0.3 + ((2 * hl - 0.6) * k) / (m - 1), C.DARKWOOD, 0x6a4a30);
    } else { // a veranda: a low floor along the side (its top: 15 cm above the ground at the low corner), white posts at its edge
      const x0 = -(hw + deep - 0.3), y = 0.75;
      face(B, [[x0 - 0.15, y, -hl], [-hw, y, -hl], [-hw, y, hl], [x0 - 0.15, y, hl]], C.CONCRETE, 0xd8d2c8, 0, 1, 0);
      for (const z of hl > 6 ? [-hl + 0.3, 0, hl - 0.3] : [-hl + 0.3, hl - 0.3]) post(x0, z, C.TRIM, 0xf2f0ea);
    }
  }
  // a motel's walkway along one wall s -> e (world frame at base): slab, railing, posts and a lean-to cover
  walkway(B, s, e, eave) {
    const L = Math.hypot(e[0] - s[0], e[1] - s[1]); if (L < 4) return;
    const ux = (e[0] - s[0]) / L, uz = (e[1] - s[1]) / L, ox = -uz, oz = ux, y = 3.6, D = 1.9; // (o: out of the wall)
    const at = (t, d, yy) => [s[0] + ux * t + ox * d, yy, s[1] + uz * t + oz * d];
    face(B, [at(0, 0, y), at(L, 0, y), at(L, D, y), at(0, D, y)], C.CONCRETE, 0xc8c0b4, 0, 1, 0);
    face(B, [at(0, 0, y - 0.25), at(L, 0, y - 0.25), at(L, D, y - 0.25), at(0, D, y - 0.25)], C.CONCRETE, 0xb0a89c, 0, -1, 0);
    face(B, [at(0, D, y - 0.25), at(L, D, y - 0.25), at(L, D, y), at(0, D, y)], C.CONCRETE, 0xc8c0b4, ox, 0, oz);
    const n = L / 1.2; B.panel(at(0, D - 0.05, y), at(L, D - 0.05, y), at(L, D - 0.05, y + 1), at(0, D - 0.05, y + 1), C.RAIL_IRON, 0x4a3a2c, 3, [0, 0, n, 0, n, 1, 0, 1]);
    const top = Math.max(y + 2.4, eave - 0.1), lo = top - 0.5;
    face(B, [at(0, 0, top), at(L, 0, top), at(L, D + 0.3, lo), at(0, D + 0.3, lo)], C.SEAM, 0x4a6a4a, 0, 1, 0);
    face(B, [at(0, 0, top - 0.12), at(L, 0, top - 0.12), at(L, D + 0.3, lo - 0.12), at(0, D + 0.3, lo - 0.12)], C.TRIM, 0xe8e4dc, 0, -1, 0);
    const m = Math.max(2, Math.round(L / 5) + 1);
    for (let k = 0; k < m; k++) { const p = at(0.3 + ((L - 0.6) * k) / (m - 1), D - 0.1, 0); B.box(p[0], 0, p[2], 0.2, lo - 0.1, 0.2, C.DARKWOOD, 0x6a4a30, { top: false }); }
  }
  // a chalet's balcony across a gable end (gable frame: the end at z = zEnd, outward zs), the carved timber railing
  balcony(B, hx, zEnd, zs, y) {
    const z1 = zEnd + zs * 1.2, L = (2 * hx) / 1.5;
    face(B, [[-hx, y, zEnd], [hx, y, zEnd], [hx, y, z1], [-hx, y, z1]], C.WOOD, 0x8a6a4a, 0, 1, 0);
    face(B, [[-hx, y - 0.2, zEnd], [hx, y - 0.2, zEnd], [hx, y - 0.2, z1], [-hx, y - 0.2, z1]], C.WOOD, 0x7a5a3e, 0, -1, 0);
    B.panel([-hx * zs, y, z1 - zs * 0.05], [hx * zs, y, z1 - zs * 0.05], [hx * zs, y + 1, z1 - zs * 0.05], [-hx * zs, y + 1, z1 - zs * 0.05], C.RAIL_WOOD, 0xb08a64, 3, [0, 0, L, 0, L, 1, 0, 1]);
  }
  // an overwater bungalow's deck, on piles down to the lagoon floor: a walk round the house, wide on the side facing the
  // open lagoon (deepest water), with a ladder of piles under its edge (world frame)
  bungalowDeck(B, ox, oz, ux, uz, hl, hw, base) {
    const W = this.w, wl = W.waterLevel, nx = -uz, nz = ux;
    const sides = [[ux, uz, hl], [-ux, -uz, hl], [nx, nz, hw], [-nx, -nz, hw]];
    let deep = 0, lo = Infinity;
    sides.forEach(([dx, dz, e], k) => { const g = W.sampleGrid(ox + dx * (e + 6), oz + dz * (e + 6)); if (g < lo) { lo = g; deep = k; } });
    const m = [1.2, 1.2, 1.2, 1.2]; m[deep] = 3.8;
    const cu = (m[0] - m[1]) / 2, cn = (m[2] - m[3]) / 2, hu = hl + (m[0] + m[1]) / 2, hn = hw + (m[2] + m[3]) / 2, dx = ox + ux * cu + nx * cn, dz = oz + uz * cu + nz * cn;
    B.setFrame(0, 0, 0, 0);
    B.obox(dx, dz, ux, uz, hu, hn, base - 0.3, base, C.BOARDS, 0xb08a62);
    for (const [a, c] of this.w.qName === 'low' ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) { // (Low: the corner piles)
      const px = dx + ux * a * (hu - 0.3) + nx * c * (hn - 0.3), pz = dz + uz * a * (hu - 0.3) + nz * c * (hn - 0.3), y0 = Math.min(wl - 0.5, W.sampleGrid(px, pz));
      B.box(px, y0, pz, 0.36, base - 0.3 - y0, 0.36, C.DARKWOOD, 0x4a3a2c, { top: false });
    }
  }
  flatRoof(B, P, y, cell, colr) {
    const contour = P.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [a, b, c] of tris) {
      const pa = P[a], pb = P[b], pc = P[c];
      // face up: (b - a) x (c - a) must have +y
      const up = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]) > 0;
      const q = up ? [pa, pb, pc] : [pa, pc, pb];
      B.tri([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], [q[0][0] / 3, q[0][1] / 3, q[1][0] / 3, q[1][1] / 3, q[2][0] / 3, q[2][1] / 3], cell, colr);
    }
  }

  // ---------------- railways: ballast + rails draped on the ground, bridges straight ----------------
  buildRails(list) {
    // Merged per 2 km square (a city's rail network spans the whole map: one mesh could never be culled): squares off
    // screen are frustum culled, and update() shows the thin steel rails only near the camera (sub-pixel beyond) and
    // the ballast out to a few km.
    const W = this.w, CELL = 2000, cells = new Map();
    const cellOf = (x, z) => { const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL); let c = cells.get(k); if (!c) cells.set(k, (c = { pos: grow(Float32Array), idx: grow(Uint32Array), steel: grow(Float32Array), sIdx: grow(Uint32Array) })); return c; };
    // ys given: the heights to use (the steel rails reuse their bed's: below); returns the heights it used
    const ribbon = (pts, br, width, lift, which, ys) => {
      // (a bridge: straight between its ends' ground, so only the ends are sampled)
      if (!ys && br) { const a = W.sampleGrid(pts[0][0], pts[0][1]), b = W.sampleGrid(pts.at(-1)[0], pts.at(-1)[1]); ys = pts.map((_, i) => a + (b - a) * (i / (pts.length - 1)) + 1); }
      else if (!ys) ys = pts.map((p) => W.sampleGrid(p[0], p[1]));
      // runs of points in one square (consecutive runs share their boundary point, so the ribbon stays closed)
      let i0 = 0;
      while (i0 < pts.length - 1) {
        const c = cellOf(pts[i0][0], pts[i0][1]), k0 = Math.floor(pts[i0][0] / CELL), m0 = Math.floor(pts[i0][1] / CELL);
        let i1 = i0 + 1; while (i1 < pts.length - 1 && Math.floor(pts[i1][0] / CELL) === k0 && Math.floor(pts[i1][1] / CELL) === m0) i1++;
        const out = which ? c.steel : c.pos, oi = which ? c.sIdx : c.idx, o = out.n / 3;
        for (let i = i0; i <= i1; i++) {
          const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
          const nx = -dz / L * width / 2, nz = dx / L * width / 2;
          out.push(p[0] - nx, ys[i] + lift, p[1] - nz, p[0] + nx, ys[i] + lift, p[1] + nz);
          if (i > i0) { const k = o + (i - 1 - i0) * 2; oi.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); } // (counter-clockwise from above: facing up)
        }
        i0 = i1;
      }
      return ys;
    };
    for (const [kind, br, flat] of list) {
      const raw = []; for (let k = 0; k < flat.length; k += 2) raw.push([flat[k], flat[k + 1]]);
      const pts = densify(raw, 6);
      if (pts.length < 2) continue;
      // the two steel rails at the bed's centre height (+0.2 m): the bed is level across, so they sit on it exactly,
      // whatever the ground's cross-slope does under them (sampling the ground at each rail cost ~100 ms in New York)
      const ys = ribbon(pts, br, 3.6, 0.25, 0);
      for (const s of [-0.55, 0.55]) ribbon(offset(pts, s), br, 0.14, 0.45, 1, ys);
    }
    const ballast = new THREE.MeshStandardMaterial({ color: 0x4e463e, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    const steelM = new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 0.8, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 });
    this.railChunks = [];
    const mk = (p, i, m, steel) => { if (!p.n) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p.a.slice(0, p.n), 3)); g.setIndex(new THREE.BufferAttribute(p.n / 3 > 65535 ? i.a.slice(0, i.n) : Uint16Array.from(i.a.subarray(0, i.n)), 1)); // (setIndex's rule: 32-bit once an index reaches 65535; every vertex is used, the last one too)
      g.setAttribute('normal', new THREE.BufferAttribute(vertexNormals(g.attributes.position.array, g.index.array), 3)); g.computeBoundingSphere(); const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; this.group.add(mesh); this.railChunks.push({ m: mesh, x: g.boundingSphere.center.x, z: g.boundingSphere.center.z, r: g.boundingSphere.radius, steel }); };
    for (const c of cells.values()) { mk(c.pos, c.idx, ballast, false); mk(c.steel, c.sIdx, steelM, true); }
    // empty stand-ins, always there, so both shaders compile behind the loading screen even when no rails are in view
    // yet (a compile mid-flight is a hitch on the tablet)
    if (this.railChunks.length) for (const m of [ballast, steelM]) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); g.setIndex([0, 1, 2]); const w = new THREE.Mesh(g, m); w.frustumCulled = false; w.receiveShadow = true; this.group.add(w); }
    this.railView = { steel: RAIL_STEEL_D[W.qName] ?? 900, ballast: Math.min(this.view, RAIL_BALLAST_D[W.qName] ?? 6000) };
  }

  // ---------------- cable cars / gondolas / chair lifts: sagging cables between the stations ----------------
  buildCables(list) {
    const W = this.w, pts = [];
    for (const [kind, flat] of list) {
      for (let k = 0; k + 3 < flat.length; k += 2) {
        const ax = flat[k], az = flat[k + 1], bx = flat[k + 2], bz = flat[k + 3], L = Math.hypot(bx - ax, bz - az); if (L < 5) continue;
        const ha = W.sampleGrid(ax, az) + 12, hb = W.sampleGrid(bx, bz) + 12, segs = Math.max(4, Math.ceil(L / 40));
        for (const side of kind === 2 ? [0] : [-3, 3]) {
          const nx = -(bz - az) / L * side, nz = (bx - ax) / L * side;
          let prev = null;
          for (let s = 0; s <= segs; s++) {
            const t = s / segs, x = ax + (bx - ax) * t + nx, z = az + (bz - az) * t + nz;
            let y = ha + (hb - ha) * t - Math.sin(t * Math.PI) * L * 0.035; // the sag
            y = Math.max(y, W.sampleGrid(x, z) + 3);
            if (prev) pts.push(...prev, x, y, z);
            prev = [x, y, z];
          }
        }
      }
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.8 })));
  }

  // ---------------- mountain lakes: flat water at their own level (the valley lakes are the World's water) ----------------
  buildLakes(list) {
    const pos = [], idx = [];
    for (const [lvl, flat] of list) {
      const P = []; for (let k = 0; k < flat.length; k += 2) P.push(new THREE.Vector2(flat[k], flat[k + 1]));
      if (P.length < 3) continue;
      const o = pos.length / 3;
      P.forEach((p) => pos.push(p.x, lvl + 0.05, p.y));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(P, [])) {
        const up = (P[b].y - P[a].y) * (P[c].x - P[a].x) - (P[b].x - P[a].x) * (P[c].y - P[a].y) > 0;
        idx.push(o + a, o + (up ? b : c), o + (up ? c : b));
      }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1f4a52, roughness: 0.06, metalness: 0.1, envMapIntensity: 1 }));
    m.receiveShadow = true; this.group.add(m);
  }

  // ---------------- rivers above the World's water level (the Colorado): a ribbon on the baked downhill surface ----------------
  buildRivers(list) {
    if (!list.length) return;
    const pos = [], uv = [], idx = [];
    for (const P of list) {
      const o = pos.length / 3; let v = 0;
      P.forEach((p, i) => {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
        const w = p.w + 14, nx = -dz / L * w, nz = dx / L * w; // a little wider than the bed: the edges tuck under the banks
        if (i) v += Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z);
        pos.push(p.x - nx, p.h, p.z - nz, p.x + nx, p.h, p.z + nz); uv.push(0, v / 40, w / 20, v / 40);
        if (i) { const k = o + (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    g.computeVertexNormals(); g.computeBoundingSphere();
    // ripples: a tileable normal map from a few plane waves, drifting downstream (update)
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const cx = c.getContext('2d'), img = cx.createImageData(s, s), rr = mulberry32(17), wv = [];
    for (let k = 0; k < 24; k++) { const f = 1 + Math.floor(rr() ** 1.5 * 12), a = (rr() - 0.5) * 2.2; wv.push([Math.round(Math.sin(a) * f) || 1, Math.round(Math.cos(a) * f * 1.6), 1 / f, rr() * 6.28]); }
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      let ddx = 0, ddy = 0; for (const [kx, ky, am, ph] of wv) { const cs = Math.cos((2 * Math.PI * (kx * x + ky * y)) / s + ph) * am; ddx += cs * kx; ddy += cs * ky; }
      const n = new THREE.Vector3(-ddx * 0.05, -ddy * 0.05, 1).normalize(), k = (y * s + x) * 4;
      img.data[k] = (n.x * 0.5 + 0.5) * 255; img.data[k + 1] = (n.y * 0.5 + 0.5) * 255; img.data[k + 2] = (n.z * 0.5 + 0.5) * 255; img.data[k + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    const nt = new THREE.CanvasTexture(c); nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ color: this.w.loc.river?.color ?? 0x3a5a50, roughness: 0.3, metalness: 0, normalMap: nt, normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 0.5 });
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true;
    this.river = m; this.group.add(m);
  }

  hit(p) {
    const lh = this.landmarks.hit(p); if (lh) return lh;
    if (this.city) return this.city.hit(p);
    // its box, or its own boxes (the walls, not a disc round its middle); filed under its middle's cell, so the cells
    // round p's too (a building reaching more than a cell from its middle: hit nearer its middle)
    const ci = Math.floor(p.x / 50), cj = Math.floor(p.z / 50);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const t of this.grid.get(i + ',' + j) || NONE) {
      if (p.y > t[1] + t[3] || p.y < t[1] - 2) continue;
      const o = t.ob, dx = p.x - o.x, dz = p.z - o.z;
      if (Math.abs(dx * o.ux + dz * o.uz) < o.hl && Math.abs(-dx * o.uz + dz * o.ux) < o.hw && (!t.parts || inParts(t.parts, p.x, p.z))) return t;
    }
    return null;
  }
  update(dt, t, fx, cam) {
    updateBuildingLights(this.w, t || 0); // (the windows lit at this hour, the place's habits)
    if (this.river) this.river.material.normalMap.offset.y = -(t || 0) * 0.06; // flowing downstream
    if (cam && this.railChunks) for (const c of this.railChunks) c.m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) - c.r < (c.steel ? this.railView.steel : this.railView.ballast);
    if (this.city) { this.city.update(dt, cam); this.landmarks.update(dt, cam); return; }
    if (this.refiner?.jobs.length) this.refiner.step(1); // (a huge footprint's boxes, a millisecond a frame)
    if (!cam || !this.chunkList) return;
    for (const c of this.chunkList) c.m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) < this.view + c.r;
  }
}

// an irregular building's boxes (setback.js footBoxes), each kept off the roads (fitBox) unless a road runs through it,
// worked out when something first asks for them (lazyParts; out here: a closure in the build loop would keep its
// chunk's builder alive with it)
function osmBoxes(S, e, ux, uz, fit, roads, fallback) {
  lazyParts(e, () => {
    const FS = S.footStats, t0 = performance.now(), w0 = { ...WORK }, B = footBoxes(e.fp, [], ux, uz);
    FS.irr++; if (B) { FS.boxes += B.length; FS.max = Math.max(FS.max, B.length); } { const dt = performance.now() - t0; FS.ms += dt; if (FS.ready && dt > FS.lazy) FS.lazy = dt; }
    if (FS.ready) { const w = workSince(w0); if (w.cells + w.verts > (FS.lazyWork?.cells ?? 0) + (FS.lazyWork?.verts ?? 0)) FS.lazyWork = { ...w, walls: e.fp.length, boxes: B?.length ?? 0 }; } // (the most work any one took: tools/test/setbacks.js)
    // (a huge one under FOOT.retry covered: these for now, then cut into squares a piece at a time, RealScenery.refiner)
    if (B?.refine) S.refiner.add(e.fp, [], ux, uz, (T) => { if (S.w.destruct?.states.has(e.dk)) return; e.parts = fit ? T.map((f) => fitBox(roads, f)) : T; FS.boxes += T.length; FS.max = Math.max(FS.max, T.length); });
    return B ? (fit ? fillBare(e.fp, [], ux, uz, B, (f) => fitBox(roads, f)) : B) : fallback;
  });
}
const NONE = [];
// how far (m) a point is outside a ring of [x, z] points: 0 inside
function outsideRing(P, x, z) {
  let inside = false, d = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[j], [bx, bz] = P[i];
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return inside ? 0 : d;
}
// drop a ring's points that lie within tol of the line through their neighbours (in place; keeps at least 3)
function simplifyRing(Q, tol) {
  for (let i = 0; Q.length > 3 && i < Q.length;) {
    const a = Q[(i + Q.length - 1) % Q.length], p = Q[i], c = Q[(i + 1) % Q.length], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const d = L > 1e-6 ? Math.abs((c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0])) / L : Math.hypot(p[0] - a[0], p[1] - a[1]);
    if (d < tol) Q.splice(i, 1); else i++;
  }
}
// a quad facing (nx, ny, nz): written in whichever order makes its front face that way
function face(B, q, cell, col, nx, ny, nz) {
  const ax = q[1][0] - q[0][0], ay = q[1][1] - q[0][1], az = q[1][2] - q[0][2], bx = q[3][0] - q[0][0], by = q[3][1] - q[0][1], bz = q[3][2] - q[0][2];
  if ((ay * bz - az * by) * nx + (az * bx - ax * bz) * ny + (ax * by - ay * bx) * nz < 0) q = [q[1], q[0], q[3], q[2]];
  B.plainQuad(q[0], q[1], q[2], q[3], cell, col);
}
// a building's own random sequence, seeded from its position (centroid, to half a metre)
export const buildingRng = (seed, x, z) => mulberry32((Math.imul(Math.round(x * 2), 73856093) ^ Math.imul(Math.round(z * 2), 19349663) ^ Math.imul(seed, 83492791)) >>> 0);

// railways: how far the steel rails (14 cm wide: under a pixel beyond this) and the ballast bed (3.6 m) are drawn
const RAIL_STEEL_D = { low: 600, medium: 900, high: 1500, ultra: 1500 }, RAIL_BALLAST_D = { low: 4000, medium: 6000, high: 10000, ultra: 12000 };
// a growing typed array: push(6 values), the first n are written (a rail mesh's millions of numbers without a JS
// array's boxing and the copy into a typed one after; the same float32 rounding)
function grow(T) {
  return {
    a: new T(4096), n: 0,
    push(p, q, r, s, t, u) { if (this.n + 6 > this.a.length) { const b = new T(this.a.length * 2); b.set(this.a); this.a = b; } const a = this.a, n = this.n; a[n] = p; a[n + 1] = q; a[n + 2] = r; a[n + 3] = s; a[n + 4] = t; a[n + 5] = u; this.n = n + 6; },
  };
}
// three's computeVertexNormals (indexed) on the arrays: the same sums in the same order, stored as float32 at the same
// points, so byte for byte the same normals, without its per-vertex Vector3/attribute calls (~10x faster on New York's
// 1.4M rail vertices)
function vertexNormals(P, I) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3, bx = P[b], by = P[b + 1], bz = P[b + 2];
    const cx = P[c] - bx, cy = P[c + 1] - by, cz = P[c + 2] - bz, ax = P[a] - bx, ay = P[a + 1] - by, az = P[a + 2] - bz;
    const x = cy * az - cz * ay, y = cz * ax - cx * az, z = cx * ay - cy * ax;
    // (all three read before any is written, as three does: a repeated vertex sums the same)
    const a0 = N[a] + x, a1 = N[a + 1] + y, a2 = N[a + 2] + z, b0 = N[b] + x, b1 = N[b + 1] + y, b2 = N[b + 2] + z, c0 = N[c] + x, c1 = N[c + 1] + y, c2 = N[c + 2] + z;
    N[a] = a0; N[a + 1] = a1; N[a + 2] = a2; N[b] = b0; N[b + 1] = b1; N[b + 2] = b2; N[c] = c0; N[c + 1] = c1; N[c + 2] = c2;
  }
  for (let k = 0; k < N.length; k += 3) { const x = N[k], y = N[k + 1], z = N[k + 2], s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1); N[k] = x * s; N[k + 1] = y * s; N[k + 2] = z * s; }
  return N;
}
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
function offset(pts, s) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    return [p[0] - dz / L * s, p[1] + dx / L * s];
  });
}
