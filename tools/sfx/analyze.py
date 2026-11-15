#!/usr/bin/env python3
"""Find steady, loopable stretches in field recordings (dev tool).
  analyze.py FILE [--win 4] [--png OUT.png]
Prints a 0.5 s timeline (level dB, spectral centroid, dominant low-frequency peak) and the steadiest windows."""
import subprocess, sys, argparse, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('f'); ap.add_argument('--win', type=float, default=4); ap.add_argument('--png'); ap.add_argument('--quiet', action='store_true')
a = ap.parse_args()
SR = 22050
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', a.f, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.float32)
hop = SR // 2; frames = len(x) // hop
lv, cen, pk = [], [], []
fr = np.fft.rfftfreq(hop, 1 / SR)
for i in range(frames):
    s = x[i * hop:(i + 1) * hop] * np.hanning(hop)
    m = np.abs(np.fft.rfft(s))
    lv.append(10 * np.log10(np.mean(x[i * hop:(i + 1) * hop] ** 2) + 1e-12))
    cen.append(float((fr * m).sum() / (m.sum() + 1e-9)))
    band = (fr > 25) & (fr < 400); pk.append(float(fr[band][np.argmax(m[band])]))
lv, cen, pk = map(np.array, (lv, cen, pk))
if not a.quiet:
    for i in range(frames): print(f"{i/2:6.1f}s {lv[i]:6.1f}dB c{cen[i]:6.0f} p{pk[i]:5.0f}" + ('  ' + '#' * int(max(0, lv[i] + 60) / 2)))
w = int(a.win * 2); best = []
for i in range(0, frames - w):
    seg = slice(i, i + w)
    score = np.std(lv[seg]) + np.std(cen[seg]) / 150 + np.std(pk[seg]) / 40
    best.append((score, i / 2, lv[seg].mean(), cen[seg].mean(), np.median(pk[seg])))
best.sort()
picked = []
for b in best:
    if all(abs(b[1] - p[1]) >= a.win for p in picked): picked.append(b)
    if len(picked) == 4: break
print(f"{a.f.split('/')[-1]}: {len(x)/SR:.1f}s  steadiest {a.win}s windows:")
for s, t, l, c, p in picked: print(f"   t={t:5.1f}s score {s:.2f}  level {l:.1f}dB  centroid {c:.0f}Hz  low peak {p:.0f}Hz")
if a.png:
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.f, '-lavfi', 'showspectrumpic=s=900x300:legend=1:scale=log:fscale=log:stop=8000', a.png])
