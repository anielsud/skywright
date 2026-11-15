# Smoke test

`smoke.py` boots Skywright in headless Chrome and checks that nothing is broken:

1. the page boots (WebGL context, `window.__sky`, splash gone)
2. audio initialises and every clip in `assets/sfx/index.json` decodes
3. the Settings and Help modals open and close
4. every preset in the hangar flies for 4 s at full throttle: the plane exists, its position and velocity are finite, the frame loop keeps running, and the flight ends cleanly back in the hangar
5. screenshots of the hangar and of the first flight

Any console error, uncaught exception, or failed/404 request for a file of ours fails the step it happened in.
It prints PASS/FAIL per step with timings, and exits non-zero on any failure. A full run takes about 2 minutes.

## Run it

```sh
pip install websockets          # once
python3 tools/test/smoke.py     # serves the repo root itself on a free port; no server needed
```

| Flag | |
|---|---|
| `--only Kestrel` | fly just one preset (quick check, ~30 s) |
| `--keep` | keep the screenshots and print where they are (they are always kept on failure, with one per failed step) |
| `--out DIR` | write screenshots to DIR (implies `--keep`) |
| `--port N` / `--cdp-port N` | fixed ports for the static server / Chrome debugger (default: free ones) |

Chrome is found at the usual macOS path, or `google-chrome` / `chromium` on Linux. Set `CHROME=/path/to/chrome` to override.
On Linux it uses SwiftShader for WebGL (no GPU needed), which is how it runs in CI.

## When

**Before every merge to main.** Several sessions and agents merge all day, so run it on your branch after rebasing on
origin/main, right before `gh pr merge`. A FAIL means don't merge: fix it, or if the bug is someone else's, file an issue.

It also runs on every pull request (`.github/workflows/smoke.yml`, not a required check); screenshots are attached to the run.

When you add a preset, a sound clip or a modal, the test picks presets and clips up automatically.
