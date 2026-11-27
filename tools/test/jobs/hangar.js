// Job 1: the hangar (no map). Run by tools/test/jobs.py (see harness.js for T). jobs.py boots the page first.
//   audio: init        the AudioContext starts; the clips decode in the background meanwhile (the only job with audio)
//   modal: Settings, modal: How to play    each window opens (the right one) and closes
//   screenshot: hangar the hangar settled, then a screenshot (<job>-hangar.png)
//   wind tunnel: Kestrel, wind tunnel: Dragonfly (a plane and a helicopter): opens; 5 frames drawn with the smoke on
//                      (colour) while the angle sweep starts, the rest of the sweep stepped (no drawing) to the end;
//                      5 frames drawn on the free pivot, 3 s more stepped: it swings; no shader compiled while it ran;
//                      (the tunnel's own ms per drawn frame: logged, no verdict); closes; GPU memory back
//                      to the hangar's (geometries and textures no higher than before it opened)
//   audio: every clip decodes   every clip in assets/sfx/index.json decoded (waited on the loader's own flag)
// (The tunnel's lift curves and forces, every stock vehicle: the Node suite tunnelcheck.)
import { settle as hangarSettled, sweepStepped, pivotStepped } from '../tunnelcheck.js';

const TUNNEL = ['Kestrel', 'Dragonfly'];

export async function run(T) {
  const S = T.S;

  await T.step('audio: init', async () => {
    S.audio.init();
    if (S.audio.ctx?.state === 'suspended') S.audio.ctx.resume();
    await T.until(() => S.audio.ctx?.state === 'running', { what: 'the AudioContext to run', timeout: 30 });
    return `AudioContext running at ${S.audio.ctx.sampleRate} Hz (the clips decode meanwhile: checked last)`;
  });

  for (const [button, title] of [['#btn-settings', 'Settings'], ['#btn-help', 'How to play']]) {
    await T.step(`modal: ${title}`, async () => {
      const root = document.getElementById('modal-root');
      document.querySelector(button).click();
      await T.until(() => root.style.display === 'block', { what: `the ${title} window to open`, timeout: 30 });
      const h2 = root.querySelector('h2')?.textContent;
      T.check(`the ${title} window opens`, h2 === title, `heading ${JSON.stringify(h2)}`);
      root.querySelector('[data-close]').click();
      await T.until(() => root.style.display === 'none', { what: `the ${title} window to close`, timeout: 30 });
    });
  }

  await T.step('screenshot: hangar', async () => {
    const m = await hangarSettled();
    await T.shot('hangar');
    return `${m.geo} geometries, ${m.tex} textures, ${m.progs} shader programs`;
  });

  for (const name of TUNNEL) await T.step(`wind tunnel: ${name}`, () => tunnel(T, name));

  await T.step('audio: every clip decodes', async () => {
    const names = Object.keys(await (await fetch('/assets/sfx/index.json')).json());
    await T.until(() => S.audio.samplesLoading === false, { what: 'the clips to finish decoding', timeout: 240 });
    const missing = names.filter((n) => !(n in S.audio.buffers));
    T.check(`all ${names.length} clips decoded`, !missing.length, missing.length ? `${missing.length} did not: ${missing.slice(0, 12).join(', ')}` : '');
    return `${names.length - missing.length}/${names.length} clips`;
  });
}

// the geometries and textures a scene draws with that another scene doesn't (the tunnel's own, not the hangar's it shares)
function tunnelOwn(scene, other) {
  const collect = (root) => { const out = new Set(); root?.traverse((o) => {
    if (o.geometry) out.add(o.geometry);
    if (o.skeleton?.boneTexture) out.add(o.skeleton.boneTexture);
    for (const m of [].concat(o.material || [])) if (m) for (const v of Object.values(m)) { if (v?.isTexture) out.add(v); else if (Array.isArray(v)) v.forEach((x) => x?.isTexture && out.add(x)); }
    if (o.isBatchedMesh) for (const k of ['_matricesTexture', '_indirectTexture', '_colorsTexture']) if (o[k]?.isTexture) out.add(o[k]);
    for (const m of [].concat(o.material || [])) for (const v of [...Object.values(m?.uniforms || {}), ...Object.values(m?.userData?.U || {})]) if (v?.value?.isTexture) out.add(v.value);
  }); return out; }; // (as main.js collectGpu, which the tunnel's dispose frees by; not the scene's environment, a render target it frees itself)
  const keep = collect(other), own = collect(scene); for (const r of keep) own.delete(r); return own;
}

async function tunnel(T, name) {
  const S = T.S, d = S.presets.find((p) => p.name === name);
  if (!d) throw new Error(`no stock vehicle named ${name}`);
  S.hangar.load(d);
  const mem0 = await hangarSettled(), tc0 = window.__tunnelCompiles || 0;
  S.openTunnel();
  try {
    await T.until(() => S.tunnel?.ready, { what: 'the tunnel to open', timeout: 120 });
    const t = S.tunnel;
    // the smoke in colour and the sweep started: a few frames drawn like that (the smoke's shaders), the rest stepped
    t.st.mode = 1; t.flow.setMode(1); t.startSweep();
    await T.frames(5, { what: 'the tunnel sweeping with the smoke on' });
    const sw = sweepStepped(t);
    T.check('the angle sweep runs to the end', sw.done && sw.aoa >= 35 - 1e-6 && sw.from <= -9 && sw.to >= 34 && sw.points >= 60 && sw.finite,
      `${sw.points} points of the lift curve from ${sw.from} to ${sw.to} deg, finite ${sw.finite} (${sw.steps} steps)`);
    // the free pivot: nudged, a few frames drawn, then swung on stepped
    t.setPivot(true); t.piv.thd = 0.6; t.piv.psd = 0.4;
    await T.frames(5, { what: 'the tunnel on the free pivot' });
    const pv = pivotStepped(t, 3);
    T.check('it swings on the free pivot', pv.finite && pv.F && pv.moved > 1e-3, `moved ${pv.moved.toFixed(3)} rad in 3 s, finite ${pv.finite && pv.F}`);
    const perf = t.stats4test(), compiles = (window.__tunnelCompiles || 0) - tc0;
    T.check('no shader compiled while it ran (a stall)', compiles === 0, compiles ? `${compiles} compiled in the wind tunnel` : '');
    // (the tunnel's own work per drawn frame: information, not a verdict. Its smoke retraces to a time budget per frame
    // (tunnelFlow.js update), so neither ms nor lines per frame is a machine-independent count; no timing verdicts)
    if (perf.frames) T.log(`${name}: the tunnel's own work ${perf.cpuMs.toFixed(1)} ms a frame over ${perf.frames} timed frames (${perf.lines} smoke lines)`);
    // what the tunnel holds that the hangar doesn't: each must be disposed when it closes. (Not a before/after count of
    // the renderer's memory: textures the game is still loading in the background, e.g. the flight textures preloaded
    // after boot, can arrive between the two counts and read as a leak on a busy machine.)
    const own = tunnelOwn(t.scene, S.hangar.scene), freed = new Set();
    for (const r of own) r.addEventListener('dispose', () => freed.add(r));
    t.exit();
    await T.until(() => !S.tunnel && !document.getElementById('tunnel-ui'), { what: 'the tunnel to close', timeout: 30 });
    const mem1 = await hangarSettled(), kept = [...own].filter((r) => !freed.has(r));
    T.check("closing it frees what it used (everything the tunnel held that the hangar doesn't)", own.size > 0 && kept.length === 0,
      `${own.size - kept.length} of ${own.size} geometries and textures disposed${kept.length ? `; kept: ${kept.slice(0, 5).map((r) => `${r.type} ${r.name || r.uuid.slice(0, 8)}`).join(', ')}` : ''}; renderer geometries ${mem0.geo} -> ${mem1.geo}, textures ${mem0.tex} -> ${mem1.tex}`);
    return `${sw.points}-point sweep, pivot swung; geo/tex ${mem0.geo}/${mem0.tex} -> ${mem1.geo}/${mem1.tex}`;
  } finally {
    if (S.tunnel) S.tunnel.exit(); // (a failed check above: leave the hangar as the next step expects it)
  }
}
