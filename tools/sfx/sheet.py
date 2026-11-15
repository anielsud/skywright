#!/usr/bin/env python3
"""Contact sheet of labelled spectrograms (log freq 20 Hz-10 kHz) + level curve, for eyeballing recordings.
  sheet.py OUT.png FILE[:start-end] ...   (times in seconds)"""
import subprocess, sys, numpy as np
from PIL import Image, ImageDraw
SR = 22050; W, H = 1100, 150
rows = []
for arg in sys.argv[2:]:
    f, _, rng = arg.partition(':')
    cmd = ['ffmpeg', '-v', 'error']
    if rng: s, e = map(float, rng.split('-')); cmd += ['-ss', str(s), '-t', str(e - s)]
    x = np.frombuffer(subprocess.run(cmd + ['-i', f, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout, np.float32)
    n = 2048; hop = max(256, len(x) // W)
    cols = []
    edges = np.geomspace(20, 10000, H + 1); fr = np.fft.rfftfreq(n, 1 / SR)
    idx = [np.where((fr >= edges[i]) & (fr < edges[i + 1]))[0] for i in range(H)]
    lv = []
    for i in range(0, max(1, len(x) - n), hop):
        m = np.abs(np.fft.rfft(x[i:i + n] * np.hanning(n))) + 1e-9
        cols.append([20 * np.log10(m[j].mean()) if len(j) else (20 * np.log10(m[np.searchsorted(fr, edges[k])]) ) for k, j in enumerate(idx)])
        lv.append(10 * np.log10(np.mean(x[i:i + n] ** 2) + 1e-12))
    S = np.array(cols).T[::-1]; S = np.clip((S - (S.max() - 70)) / 70, 0, 1)
    img = Image.fromarray((np.stack([S ** 0.8, S ** 1.6, (1 - S) * S * 2.5 + S ** 3], -1).clip(0, 1) * 255).astype(np.uint8)).resize((W, H))
    d = ImageDraw.Draw(img); lv = np.array(lv); px = np.linspace(0, W - 1, len(lv)); py = H - 1 - np.clip((lv + 60) / 60, 0, 1) * (H - 1)
    d.line(list(zip(px, py)), fill=(255, 255, 255), width=1)
    dur = len(x) / SR
    for t in range(0, int(dur) + 1, 5 if dur > 20 else 1): xx = t / dur * W; d.line([(xx, H - 6), (xx, H)], fill=(255, 255, 255)); d.text((xx + 2, H - 14), f"{t + (float(rng.split('-')[0]) if rng else 0):.0f}", fill=(255, 255, 255))
    for hz in (100, 1000): yy = H - 1 - (np.log(hz / 20) / np.log(10000 / 20)) * H; d.line([(0, yy), (8, yy)], fill=(0, 255, 0)); d.text((10, yy - 6), f"{hz}Hz", fill=(0, 255, 0))
    d.rectangle([0, 0, W, 14], fill=(0, 0, 0)); d.text((4, 1), f"{arg.split('/')[-1]}  {dur:.1f}s", fill=(255, 255, 0))
    rows.append(img)
sheet = Image.new('RGB', (W, H * len(rows))); [sheet.paste(r, (0, i * H)) for i, r in enumerate(rows)]; sheet.save(sys.argv[1])
