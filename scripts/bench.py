#!/usr/bin/env python3
"""Every number Hearth publishes comes from here. Nothing is typed in by hand.

    python3 scripts/bench.py --corpus fleurs20 [--from RAW]   # WER orig -> round trip, bytes/hour, RTF, $/hour
    python3 scripts/bench.py --calibrate [--from RAW]         # DRIFT_GATE re-checked on the disjoint fleurs20b set
    python3 scripts/bench.py --live 10 --record [--base URL]  # p50/p95 time-to-kept through the DEPLOYED app
    python3 scripts/bench.py --memory                         # proposed / quote-dropped / field-removed / kept
    python3 scripts/bench.py --traction                       # counts only, from the volunteers' ratings (kept private)

--corpus/--calibrate read a D0-harness report (a real Nebius Job running the worker's own keep pipeline on the
FLEURS clips). Without --from they use the run of record named in bench/results/record.json; with --run they launch
a fresh one (scripts/d0.py, which costs one Job). --live drives the public app over HTTP exactly as a browser does:
open a space, agree, upload by presigned PUT, keep, poll until kept, then delete everything. Results go to
bench/results/<mode>-<stamp>.json; --corpus fleurs20 also refreshes bench/results/latest.json, which the app renders.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "bench" / "results"
sys.path.insert(0, str(ROOT / "scripts"))


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def record_raw(path: str | None) -> Path:
    if path:
        return Path(path).resolve()
    rec = json.loads((RESULTS / "record.json").read_text())
    return (RESULTS / rec["raw"]).resolve()


def corpus(args) -> int:
    import d0_report

    if args.run:
        rc = subprocess.call([sys.executable, str(ROOT / "scripts" / "d0.py"), "--sets", "fleurs20,long,batch,fleurs20b",
                              "--trimmed", "--bucket-weights", "--no-model-copy"])
        if rc:
            return rc
        args.from_ = str(sorted(RESULTS.glob("d0-*-raw.json"))[-1])
    raw = record_raw(args.from_)
    out = d0_report.summarize(json.loads(raw.read_text()))
    out["source"] = raw.name
    dest = RESULTS / f"fleurs20-{stamp()}.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    (RESULTS / "latest.json").write_text(json.dumps({k: v for k, v in out.items() if k not in ("hypotheses",)}, ensure_ascii=False, indent=1))
    w = out["wer"]["fleurs20"]
    print(f"fleurs20: WER {w['wer_orig']} -> {w['wer_rt']} (strict {w['wer_orig_strict']} -> {w['wer_rt_strict']}), "
          f"{out['bytes']['bytes_per_audio_hour']} B/h, RTF {out['rtf']['all']['total']}, ${out['usd_per_audio_hour']}/audio-h")
    print(f"-> {dest.relative_to(ROOT)} and bench/results/latest.json")
    return 0


def calibrate(args) -> int:
    import d0_report

    raw = record_raw(args.from_)
    out = d0_report.summarize(json.loads(raw.read_text()))
    gate = out["drift_gate"]
    res = {"source": raw.name, "fleurs20": gate["fleurs20"], "fleurs20b": gate["fleurs20b"],
           "note": "fleurs20b is disjoint from fleurs20 and is used only to re-check the fixed DRIFT_GATE prior, never to tune it."}
    dest = RESULTS / f"calibrate-{stamp()}.json"
    dest.write_text(json.dumps(res, indent=1))
    b = gate["fleurs20b"] or {}
    print(f"DRIFT_GATE {b.get('gate')} on fleurs20b: delete rate {b.get('delete_rate')}, validated {b.get('validated')}, "
          f"failing clips under the gate {b.get('failing_clips_under_gate')} -> {dest.relative_to(ROOT)}")
    return 0


class Client:
    """A browser stand-in: a cookie jar and JSON calls."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json"})
        try:
            with self.opener.open(req, timeout=90) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")


def consent_version() -> str:
    text = (ROOT / "src" / "lib" / "copy.ts").read_text()
    return re.search(r'CONSENT_VERSION = "([^"]+)"', text).group(1)


def live(args) -> int:
    from s3 import S3, load_env

    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    audio = S3.from_env().get(args.clip)
    if audio is None:
        print(f"{args.clip} is not in the bucket", file=sys.stderr)
        return 2
    code = os.environ.get("HEARTH_JUDGE_CODE", "")
    runs = []
    for r in range(args.live):
        c = Client(args.base)
        st, space = c.call("POST", "/api/space", {"timeZone": "Asia/Kolkata"})
        assert st == 200, (st, space)
        st, _ = c.call("POST", "/api/agree", {"agreed": True, "deleteOriginals": True, "textVersion": consent_version()})
        assert st == 200, st
        name = Path(args.clip).name
        st, slots = c.call("POST", "/api/notes", {"files": [{"name": name, "size": len(audio)}]})
        assert st == 200, (st, slots)
        slot = slots["notes"][0]
        put = urllib.request.Request(slot["putUrl"], data=audio, method="PUT", headers=slot["headers"])
        urllib.request.urlopen(put, timeout=120).read()
        t_up = time.time()
        st, kept = c.call("POST", "/api/keep", {"notes": [slot["id"]], "code": code})
        assert st == 200, (st, kept)
        note, job, polls = None, None, 0
        while time.time() - t_up < args.max_min * 60:
            time.sleep(10)
            polls += 1
            st, status = c.call("GET", "/api/status")
            note = next((n for n in status.get("notes", []) if n["id"] == slot["id"]), None)
            job = next((j for j in status.get("jobs", []) if any(x["id"] == slot["id"] for x in j["notes"])), None)
            if note and note["status"] in ("kept", "failed"):
                break
        t_kept = time.time()
        created = next((h["at"] for h in (job or {}).get("history", []) if h["event"].startswith("Nebius job")), None)
        queue_wait = (datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp() - t_up) if created else None
        st, proof = c.call("GET", "/api/proof")
        timings = ((proof.get("visitor") or {}).get("job") or {}).get("timings")
        st, gone = c.call("POST", "/api/delete-all", {"confirm": "delete"})
        runs.append({
            "run": r + 1, "status": (note or {}).get("status"), "time_to_kept_s": round(t_kept - t_up, 1),
            "queue_wait_s": round(queue_wait, 1) if queue_wait is not None else None,
            "nebius_job": (job or {}).get("nebiusId"), "hearth_job": (job or {}).get("job"), "polls": polls,
            "audio_s": ((note or {}).get("kept") or {}).get("audioS"), "bytes_hct": ((note or {}).get("kept") or {}).get("bytesHct"),
            "drift": ((note or {}).get("kept") or {}).get("driftNote"), "error": (note or {}).get("error"),
            "job_timings_s": timings,
            "delete_all_listings": gone.get("listings"),
        })
        print(json.dumps(runs[-1]), flush=True)
    ok = [x["time_to_kept_s"] for x in runs if x["status"] == "kept"]
    q = [x["queue_wait_s"] for x in runs if x["queue_wait_s"] is not None]

    def pct(xs, p):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, max(0, round(p / 100 * (len(xs) - 1))))] if xs else None

    out = {"base": args.base, "clip": args.clip, "runs": runs, "kept": len(ok), "of": len(runs),
           "time_to_kept_s": {"p50": pct(ok, 50), "p95": pct(ok, 95), "median": statistics.median(ok) if ok else None},
           "queue_wait_s": {"p50": pct(q, 50), "p95": pct(q, 95)},
           "note": "time to kept = upload complete -> the note reads 'kept' (validation done), cold start and queue wait included"}
    dest = RESULTS / f"live-{stamp()}.json"
    dest.write_text(json.dumps(out, indent=1))
    if args.record and args.base.startswith("https://") and len(ok) == len(runs):
        # Only a run of record (--record) replaces what the judge page shows; checks and probes never do.
        (RESULTS / "live-latest.json").write_text(json.dumps({**out, "source": dest.name}, indent=1))
    print(f"kept {len(ok)}/{len(runs)} · time to kept p50 {out['time_to_kept_s']['p50']} s, p95 {out['time_to_kept_s']['p95']} s "
          f"· queue wait p50 {out['queue_wait_s']['p50']} s -> {dest.relative_to(ROOT)}")
    return 0 if len(ok) == len(runs) else 1


def memory(_args) -> int:
    sample = json.loads((ROOT / "public" / "sample" / "sample.json").read_text())
    stats = (sample.get("memory") or {}).get("stats")
    runs = []
    for f in sorted((ROOT / "evidence").glob("keep-*.json")):
        runs.append({"file": f.name, "memory": [r.get("memory") for r in json.loads(f.read_text()).get("runs", [])]})
    out = {"sample": {"kind": sample.get("kind"), "stats": stats}, "live_keeps": runs,
           "note": "Volunteer spaces are private: their gate counts are shown to them on their own Kept tab, never collected here."}
    dest = RESULTS / f"memory-{stamp()}.json"
    dest.write_text(json.dumps(out, indent=1))
    print(json.dumps(out["sample"]), "->", dest.relative_to(ROOT))
    return 0


def traction(_args) -> int:
    src = ROOT.parent / "submission" / "traction-ratings.csv"
    if not src.exists():
        print("no ratings yet (submission/traction-ratings.csv, kept private) — nothing to count")
        return 0
    import csv

    rows = list(csv.DictReader(src.open(encoding="utf-8")))
    useful = [int(r["usefulness"]) for r in rows if r.get("usefulness", "").isdigit()]
    out = {"people": len({r.get("person") for r in rows}), "ratings": len(useful),
           "usefulness_mean": round(statistics.mean(useful), 2) if useful else None}
    print(json.dumps(out))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--corpus", choices=["fleurs20"])
    g.add_argument("--calibrate", action="store_true")
    g.add_argument("--live", type=int)
    g.add_argument("--memory", action="store_true")
    g.add_argument("--traction", action="store_true")
    ap.add_argument("--from", dest="from_", help="a D0 raw report (default: bench/results/record.json)")
    ap.add_argument("--run", action="store_true", help="launch a fresh D0-harness Job first (costs one Job)")
    ap.add_argument("--base", default=os.environ.get("HEARTH_PUBLIC_URL", "https://hearth-alpha-six.vercel.app"))
    ap.add_argument("--clip", default="bench/fleurs/clip60.opus")
    ap.add_argument("--max-min", type=float, default=30)
    ap.add_argument("--record", action="store_true", help="--live: this run becomes bench/results/live-latest.json (what /judge shows)")
    args = ap.parse_args()
    if args.corpus:
        return corpus(args)
    if args.calibrate:
        return calibrate(args)
    if args.live:
        return live(args)
    if args.memory:
        return memory(args)
    return traction(args)


if __name__ == "__main__":
    raise SystemExit(main())
