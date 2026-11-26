// Job 1: the hangar (no map). Run by tools/test/jobs.py (see harness.js for T). jobs.py boots the page first.
//   audio: init        the AudioContext starts; the clips decode in the background meanwhile (the only job with audio)
//   modal: Settings, modal: How to play    each window opens (the right one) and closes
//   screenshot: hangar the hangar settled, then a screenshot (<job>-hangar.png)
//   wind tunnel: Kestrel, wind tunnel: Dragonfly (a plane and a helicopter): opens; 5 frames drawn with the smoke on
//                      (colour) while the angle sweep starts, the rest of the sweep stepped (no drawing) to the end;
//                      5 frames drawn on the free pivot, 3 s more stepped: it swings; no shader compiled while it ran;
//                      (locally, not --ci: the tunnel's own work per drawn frame under 12 ms); closes; GPU memory back
//                      to the hangar's (geometries and textures no higher than before it opened)
//   audio: every clip decodes   every clip in assets/sfx/index.json decoded (waited on the loader's own flag)
// (The tunnel's lift curves and forces, every stock vehicle: the Node suite tunnelcheck.)
import { settle as hangarSettled, sweepStepped, pivotStepped } from '../tunnelcheck.js';

const TUNNEL = ['Kestrel', 'Dragonfly'];
const MAX_CPU_MS = 12; // the tunnel's own work per drawn frame (locally; a CI runner's software GPU makes it meaningless)

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
    if (!T.ci && perf.frames) T.check(`the tunnel's own work per frame under ${MAX_CPU_MS} ms`, perf.cpuMs <= MAX_CPU_MS, `${perf.cpuMs.toFixed(1)} ms over ${perf.frames} timed frames (${perf.lines} smoke lines)`);
    t.exit();
    await T.until(() => !S.tunnel && !document.getElementById('tunnel-ui'), { what: 'the tunnel to close', timeout: 30 });
    const mem1 = await hangarSettled();
    // (it can end lower: the hangar only re-uploads what it still draws)
    T.check("closing it frees what it used (GPU memory back to the hangar's)", mem1.geo <= mem0.geo && mem1.tex <= mem0.tex,
      `geometries ${mem0.geo} -> ${mem1.geo}, textures ${mem0.tex} -> ${mem1.tex}`);
    return `${sw.points}-point sweep, pivot swung; geo/tex ${mem0.geo}/${mem0.tex} -> ${mem1.geo}/${mem1.tex}`;
  } finally {
    if (S.tunnel) S.tunnel.exit(); // (a failed check above: leave the hangar as the next step expects it)
  }
}
