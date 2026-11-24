#!/usr/bin/env python3
"""🐞 reports sent from the game (main.js report(), blackbox.js): fetches the latest 'bug_report' events from PostHog,
saves each picture as a JPEG and its whole report as JSON, and prints the note, where it was and the last events.

  set -a; . ~/.config/skywright/posthog.env; set +a
  python3 tools/analytics/reports.py [--days 7] [--limit 10] [--out reports/] [--id <uuid>]

Each report's JSON has the pose to look again: location, pos/quat (vehicle), cam/look/fov (camera), time_of_day,
weather, quality, plus path ([t, x, y, z, speed, agl, ground, parts, worst frame ms]) and events ([t, kind, detail]).
"""
import argparse, base64, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report import hogql  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--days', type=int, default=7); ap.add_argument('--limit', type=int, default=10)
    ap.add_argument('--out', default='reports'); ap.add_argument('--id', help='just this report (uuid prefix)')
    ap.add_argument('--events', type=int, default=15, help='how many of the last events to print')
    a = ap.parse_args()
    where = f"event = 'bug_report' AND timestamp > now() - INTERVAL {int(a.days)} DAY"
    if a.id: where += f" AND toString(uuid) LIKE '{a.id.replace(chr(39), '')}%'"
    _, rows = hogql(f"SELECT uuid, timestamp, properties FROM events WHERE {where} ORDER BY timestamp DESC LIMIT {int(a.limit)}")
    os.makedirs(a.out, exist_ok=True)
    if not rows: print('no reports'); return
    for uid, ts, props in rows:
        p = json.loads(props) if isinstance(props, str) else props
        uid = str(uid); base = os.path.join(a.out, f"{ts[:19].replace(':', '').replace('T', '-')}-{uid[:8]}")
        shot = p.pop('screenshot', '') or ''
        if shot.startswith('data:image'): open(base + '.jpg', 'wb').write(base64.b64decode(shot.split(',', 1)[1]))
        json.dump(p, open(base + '.json', 'w'), indent=1)
        print(f"\n== {ts[:19]}  {uid[:8]}  v{p.get('$app_version') or p.get('version', '?')}  {p.get('location')} · {p.get('vehicle')} · {p.get('tier')} · "
              f"{p.get('time_of_day')}h {p.get('weather')}  ({p.get('flight_s')} s into the flight)")
        print(f"   note: {p.get('note') or '(none)'}")
        print(f"   vehicle {p.get('pos')}  camera {p.get('cam')} looking {p.get('look')} ({p.get('cam_mode')})")
        path = p.get('path') or []
        if path:
            sp = [r[4] for r in path]; hitch = max(r[8] for r in path)
            print(f"   path: {len(path)} samples over {path[-1][0] - path[0][0]:.0f} s, speed {min(sp):.0f}-{max(sp):.0f} m/s, worst frame {hitch} ms")
        for t, kind, detail in (p.get('events') or [])[-a.events:]: print(f"   {t:7.1f}  {kind:<12} {detail}")
        print(f"   -> {base}.jpg / .json")


if __name__ == '__main__':
    main()
