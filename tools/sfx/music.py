#!/usr/bin/env python3
"""Build assets/music/*.ogg (dev tool). Tracks by Kevin MacLeod (incompetech.com), CC BY 4.0, cached in ~/.cache/skywright/music.
Level-matched on the same speaker weighting as the sound effects, Opus 80 kbps stereo."""
import subprocess, pathlib, numpy as np
ROOT = pathlib.Path(__file__).resolve().parents[2]; CACHE = pathlib.Path.home() / '.cache/skywright/music'; OUT = ROOT / 'assets/music'; OUT.mkdir(exist_ok=True)
TRACKS = {'hangar': 'Easy Lemon', 'cruise': 'Floating Cities', 'mission': 'Heroic Age'}
TARGET = -26.0
for key, title in TRACKS.items():
    src = CACHE / (title.replace(' ', '_') + '.mp3')
    w = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', str(src), '-ac', '1', '-ar', '48000', '-af', 'highpass=f=250:p=2,highshelf=f=1500:g=4', '-f', 'f32le', '-'], capture_output=True, check=True).stdout, np.float32)
    gain_db = TARGET - 10 * np.log10(np.mean(w.astype(np.float64) ** 2) + 1e-12)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-af', f'volume={gain_db:.2f}dB,alimiter=limit=0.95', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '80k', str(OUT / f'{key}.ogg')], check=True)
    print(f"{key:8} {title:16} gain {gain_db:+.1f} dB  {(OUT / f'{key}.ogg').stat().st_size / 1e6:.2f} MB")
(OUT / 'CREDITS.md').write_text('# Music credits\n\n' + ''.join(f'- "{t}" Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 License, http://creativecommons.org/licenses/by/4.0/\n' for t in TRACKS.values()))
