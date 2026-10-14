#!/usr/bin/env python3
"""D0 harness: one Nebius Serverless Job runs the worker in MODE=d0 over the FLEURS benchmark.

    python3 scripts/d0.py --preset 4vcpu-16gb [--image python:3.11] [--sets fleurs20,long,batch,fleurs20b]

Order inside the Job: fleurs20 (the measured 20 clips; clip 1 also runs the codec determinism check) ->
long1 (one ~5-min note) -> long2..long5 (a batch of four ~5-min notes) -> fleurs20b (the disjoint set that
re-checks DRIFT_GATE). Writes bench/results/d0-<run>-raw.json (the worker's report + the Job's own record);
scripts/d0_report.py turns it into WER/RTF/cost and the kill-gate verdicts.

Needs the bucket's S3 keys + HEARTH_BUCKET in the env (or ~/.config/faultline/local.env and
~/.config/hearth/hearth.env) and an authenticated `nebius` CLI.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from nebius_jobs import TERMINAL, create_job, get_job, running_jobs, state  # noqa: E402
from s3 import S3, load_env  # noqa: E402


# Codec settings compared on the FLEURS dev split (never on the test clips that are reported). Rule fixed before the
# run: the config with the lowest corpus round-trip WER delta (folded) wins; a tie goes to the simpler config.
ABLATION = [
    {"name": "base", "gain": "none", "lead": 0},
    {"name": "lead3", "gain": "none", "lead": 3},
    {"name": "cond", "gain": "conditional", "lead": 0},
    {"name": "cond_lead3", "gain": "conditional", "lead": 3},
    {"name": "always_lead3", "gain": "always", "lead": 3},
]


def rows(name: str) -> list[dict]:
    with (ROOT / "bench" / name).open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\"))


def build_notes(s3: S3, run: str, sets: list[str]) -> list[dict]:
    notes = []
    week = 7 * 24 * 3600

    def note(nid: str, key: str, ext: str, set_name: str) -> dict:
        return {"id": nid, "set": set_name, "ext": ext, "get": s3.presign("GET", key, week),
                "put": {"hct": s3.presign("PUT", f"bench/d0/{run}/hct/{nid}.hct", week)}}

    longs = sorted({r["note"] for r in rows("fleurs-long.tsv")})
    for set_name in sets:
        if set_name in ("fleurs20", "fleurs20b"):
            for r in rows(f"{set_name}.tsv"):
                notes.append(note(r["file"].removesuffix(".wav"), f"bench/fleurs/hi_in/{r['file']}", "wav", set_name))
        elif set_name == "dev20":
            for r in rows("fleurs-dev20.tsv"):
                notes.append(note(r["file"].removesuffix(".wav"), f"bench/fleurs/hi_in_dev/{r['file']}", "wav", set_name))
        elif set_name == "long":
            notes.append(note(longs[0], f"bench/fleurs/long/{longs[0]}.flac", "flac", "long"))
        elif set_name == "batch":
            for name in longs[1:5]:
                notes.append(note(name, f"bench/fleurs/long/{name}.flac", "flac", "batch"))
    return notes


def fetch_json(url: str):
    try:
        with urllib.request.urlopen(url, timeout=60) as res:
            return json.loads(res.read())
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="4vcpu-16gb")
    ap.add_argument("--image", default="python:3.11")
    ap.add_argument("--sets", default="fleurs20,long,batch,fleurs20b")
    ap.add_argument("--timeout", default="2h")
    ap.add_argument("--soft-deadline-min", type=float, default=95)
    ap.add_argument("--prebuilt", action="store_true", help="image already holds the dependencies")
    ap.add_argument("--limit", type=int, default=0, help="smoke run: only the first N clips (a dev Job, not a D0 run)")
    ap.add_argument("--no-model-copy", action="store_true", help="do not copy the model files into the bucket")
    ap.add_argument("--only", default="", help="smoke run: only these clip ids (comma-separated; a dev Job, not a D0 run)")
    ap.add_argument("--ablation", action="store_true", help="compare codec settings per clip (a dev Job on the dev set)")
    ap.add_argument("--trimmed", action="store_true", help="load NanoCodec without its training-only parts")
    ap.add_argument("--bucket-weights", action="store_true",
                    help="read both model files from the in-region bucket (the product path) instead of Hugging Face")
    ap.add_argument("--attach", nargs=3, metavar=("RUN", "JOB_ID", "CREATED_EPOCH"), help="re-attach to a running harness Job")
    args = ap.parse_args()

    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    s3 = S3.from_env()
    week = 7 * 24 * 3600
    if args.attach:
        run, job_id, created = args.attach[0], args.attach[1], float(args.attach[2])
        return follow(s3, run, job_id, created, args)
    busy = running_jobs()
    if len(busy) >= 2:
        print(f"eu-west1 already runs {len(busy)} jobs (quota 2, shared); try later", file=sys.stderr)
        return 3

    smoke = bool(args.limit or args.only or args.ablation)
    run = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + args.preset + ("-ablation" if args.ablation else "-smoke" if smoke else "")
    week = 7 * 24 * 3600
    manifest = {
        "version": 1, "mode": "d0", "job": f"d0-{run}", "lang": "hi-IN",
        "soft_deadline_s": args.soft_deadline_min * 60,
        "result_put": s3.presign("PUT", f"bench/d0/{run}/result.json", week),
        "status_put": s3.presign("PUT", f"bench/d0/{run}/status.json", week),
        "trimmed_codec": bool(args.trimmed),
        "weights": {"asr": s3.presign("GET", "models/nemotron-3.5-asr-streaming-0.6b.nemo", week),
                    "codec": s3.presign("GET", "models/nemo-nano-codec-22khz-1.78kbps-12.5fps.nemo", week)}
        if args.bucket_weights else None,
        "ablation": ABLATION if args.ablation else None,
        "notes": [n for n in build_notes(s3, run, args.sets.split(",")) if not args.only or n["id"] in args.only.split(",")][: args.limit or None],
        # The harness also copies both model files into the in-region bucket for the product Jobs.
        "model_puts": {} if smoke or args.no_model_copy else {
            "asr": s3.presign("PUT", "models/nemotron-3.5-asr-streaming-0.6b.nemo", week),
            "codec": s3.presign("PUT", "models/nemo-nano-codec-22khz-1.78kbps-12.5fps.nemo", week),
        },
    }
    s3.put(f"bench/d0/{run}/manifest.json", json.dumps(manifest).encode(), content_type="application/json")
    worker = ROOT / "worker"
    env = {"MODE": "d0", "MANIFEST_URL": s3.presign("GET", f"bench/d0/{run}/manifest.json", week),
           "HEARTH_JOB_NAME": f"hearth-d0-{run.lower()}"}
    if args.prebuilt:
        env["HEARTH_PREBUILT"] = "1"
    job_id, t_create = create_job(
        f"hearth-d0-{run.lower()}"[:60], args.image, env,
        {str(worker / "worker.py"): "/opt/hearth/worker.py", str(worker / "run.sh"): "/opt/hearth/run.sh",
         str(worker / "requirements.txt"): "/opt/hearth/requirements.txt"},
        preset=args.preset, timeout=args.timeout)
    print(f"run {run}: job {job_id} created at {datetime.fromtimestamp(t_create, timezone.utc).isoformat()} "
          f"(re-attach: scripts/d0.py --attach {run} {job_id} {t_create:.3f})", flush=True)
    return follow(s3, run, job_id, t_create, args)


def follow(s3: S3, run: str, job_id: str, t_create: float, args) -> int:
    week = 7 * 24 * 3600
    status_get = s3.presign("GET", f"bench/d0/{run}/status.json", week)
    result_get = s3.presign("GET", f"bench/d0/{run}/result.json", week)
    out = ROOT / "bench" / "results" / f"d0-{run}-raw.json"
    last_stage = None
    job: dict = {}
    while True:
        time.sleep(30)
        try:
            job = get_job(job_id)
        except Exception as exc:  # a CLI hiccup is not a verdict
            print(f"  get failed: {exc}", flush=True)
            continue
        st = fetch_json(status_get) or {}
        stage = (state(job), st.get("stage"), st.get("item") or st.get("note") or st.get("step"))
        if stage != last_stage:
            print(f"  {time.time() - t_create:7.0f}s job={stage[0]} worker={stage[1]} item={stage[2]} "
                  f"rss={st.get('rss_mb')}", flush=True)
            last_stage = stage
        if state(job) in TERMINAL:
            break
    result = fetch_json(result_get)
    record = {"run": run, "preset": getattr(args, "preset", None), "image": getattr(args, "image", None), "nebius_job_id": job_id,
              "created": t_create, "job": job, "report": result, "status": fetch_json(status_get)}
    out.write_text(json.dumps(record, ensure_ascii=False, indent=1))
    print(f"job {job_id} ended {state(job)}; report {'present' if result else 'MISSING'} -> {out.relative_to(ROOT)}")
    return 0 if result and result.get("status") == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
