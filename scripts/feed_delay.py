#!/usr/bin/env python3
"""How long a calendar takes to show a new reminder — measured, never assumed.

    # server half: poll a space's feed until a reminder's UID appears (records when the feed carried it)
    python3 scripts/feed_delay.py --probe "https://…/api/reminders.ics?k=…" --uid <item id> [--every 30]
    # phone half: a human subscribes on a real Android phone / Google Calendar web and records when it showed up
    python3 scripts/feed_delay.py --record --kept 2026-10-23T09:00:00Z --seen-android 2026-10-23T11:42:00Z \
        [--seen-gcal-web …] [--seen-ios …] [--alarm-fired yes|no] [--note "…"]

Writes bench/results/feed-delay.json, which the Kept tab renders. Until a human has run the phone half, the
file says so and no delay is claimed anywhere.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "bench" / "results" / "feed-delay.json"


def load() -> dict:
    return json.loads(DEST.read_text()) if DEST.exists() else {"measured": False, "server": None, "phone": []}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--probe")
    ap.add_argument("--uid")
    ap.add_argument("--every", type=int, default=30)
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--kept")
    ap.add_argument("--seen-android")
    ap.add_argument("--seen-gcal-web")
    ap.add_argument("--seen-ios")
    ap.add_argument("--alarm-fired", choices=["yes", "no"])
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    doc = load()
    if a.probe:
        t0 = time.time()
        while True:
            body = urllib.request.urlopen(a.probe, timeout=60).read().decode()
            if f"UID:{a.uid}@hearth" in body:
                doc["server"] = {"uid": a.uid, "in_feed_at": datetime.now(timezone.utc).isoformat(), "waited_s": round(time.time() - t0)}
                break
            time.sleep(a.every)
    if a.record:
        kept = datetime.fromisoformat(a.kept.replace("Z", "+00:00"))
        row = {"kept": a.kept, "alarm_fired": a.alarm_fired, "note": a.note}
        for name, val in (("android", a.seen_android), ("gcal_web", a.seen_gcal_web), ("ios", a.seen_ios)):
            if val:
                row[f"{name}_delay_min"] = round((datetime.fromisoformat(val.replace("Z", "+00:00")) - kept).total_seconds() / 60, 1)
        doc["phone"].append(row)
        doc["measured"] = True
    DEST.write_text(json.dumps(doc, indent=1))
    print(json.dumps(doc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
