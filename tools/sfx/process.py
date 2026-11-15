#!/usr/bin/env python3
"""Build assets/sfx/*.ogg from tools/sfx/sounds.json (dev tool).
Sources are Freesound HQ previews, cached in ~/.cache/skywright/sfx (fetched with fs.py on demand).
Each clip: trim -> mono 48 kHz -> 30 Hz high-pass -> level-matched on speaker-weighted loudness -> (loops) last XF seconds
crossfaded into the start (equal power) -> Opus 80 kbps. Writes assets/sfx/index.json with each clip's
estimated fundamental (f0, used to pitch engine layers against each other) and assets/sfx/CREDITS.md."""
import json, subprocess, pathlib, sys, numpy as np
ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = pathlib.Path.home() / '.cache/skywright/sfx'; OUT = ROOT / 'assets/sfx'; OUT.mkdir(parents=True, exist_ok=True)
SR, XF, TARGET = 48000, 0.6, -26.0  # TARGET: weighted dBFS
man = json.loads((ROOT / 'tools/sfx/sounds.json').read_text()); man.pop('_doc', None)
only = set(sys.argv[1:])
def load(f, s, e):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(s), '-t', str(e - s), '-i', str(f), '-ac', '1', '-ar', str(SR), '-af', 'highpass=f=30', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)
def f0(x):  # fundamental via harmonic product spectrum, 12-300 Hz
    n = 1 << 16; seg = x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))
    m = np.abs(np.fft.rfft(seg * np.hanning(n))); fr = np.fft.rfftfreq(n, 1 / SR)
    hps = np.log(m + 1e-9).copy()
    for h in (2, 3, 4): d = m[::h]; hps[:len(d)] += np.log(d + 1e-9)
    band = (fr > 12) & (fr < 300); return float(fr[band][np.argmax(hps[band])])
def ff(x, af):  # run a float mono signal through an ffmpeg audio filter chain
    return np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', af, '-f', 'f32le', '-'],
                                        input=x.astype(np.float32).tobytes(), capture_output=True, check=True).stdout, np.float32).astype(np.float64)
WEIGHT = 'highpass=f=250:p=2,highshelf=f=1500:g=4'  # same weighting as Audio.level(): what a tablet speaker lets through, presence-weighted
def match_loudness(x):
    # Level-match on speaker-weighted loudness, not raw RMS: bass-heavy clips would otherwise vanish on a tablet.
    # If that pushes peaks too high, shelve off bass (inaudible on tablets anyway) until it fits.
    for cut in (0, -4, -8, -12, -16):
        y = ff(x, f'lowshelf=f=220:g={cut}') if cut else x
        w = ff(y, WEIGHT); g = 10 ** (TARGET / 20) / max(np.sqrt(np.mean(w ** 2)), 1e-9)
        if np.max(np.abs(y)) * g < 0.89: break
    return np.clip(y * g, -0.99, 0.99).astype(np.float32)
index = json.loads((OUT / 'index.json').read_text()) if (OUT / 'index.json').exists() else {}
credits = {}
for name, c in man.items():
    meta = json.loads((CACHE / f"{c['id']}.json").read_text()) if (CACHE / f"{c['id']}.json").exists() else None
    if meta is None:
        subprocess.run([sys.executable, str(ROOT / 'tools/sfx/fs.py'), 'get', str(c['id']), str(CACHE)], check=True)
        meta = json.loads((CACHE / f"{c['id']}.json").read_text())
    credits[c['id']] = meta
    if only and name not in only: continue
    x = load(CACHE / f"{c['id']}.ogg", c['start'], c['end'] + (XF if c.get('loop') else 0))
    if c.get('loop'):
        n = int(XF * SR); L = len(x) - n
        t = np.linspace(0, np.pi / 2, n); fin, fout = np.sin(t), np.cos(t)
        y = x[:L].copy(); y[:n] = x[:n] * fin + x[L:L + n] * fout   # tail fades out over the head fading in
        x = y
    x = match_loudness(x)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '80k', '-vbr', 'on', str(OUT / f'{name}.ogg')], input=x.tobytes(), check=True)
    index[name] = {'f0': round(f0(x), 1), 'dur': round(len(x) / SR, 3), 'src': c['id']}
    print(f"{name:20} {len(x)/SR:5.1f}s f0≈{index[name]['f0']:6.1f}Hz  ({meta['name'][:50]} by {meta['username']})")
(OUT / 'index.json').write_text(json.dumps(index, indent=1))
lic = lambda u: 'CC0' if 'zero' in u else 'CC BY 4.0' if '/by/4' in u else 'CC BY 3.0' if '/by/3' in u else u
lines = ['# Sound credits', '', 'Recordings from [Freesound](https://freesound.org), trimmed, looped and level-matched for the game.', '']
for i, m in sorted(credits.items()): lines.append(f"- \"{m['name']}\" by {m['username']} ({lic(m['license'])}): {m['url']}")
(OUT / 'CREDITS.md').write_text('\n'.join(lines) + '\n')
