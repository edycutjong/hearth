#!/usr/bin/env python3
"""Build the judge sample with the REAL pipeline, through the deployed app — never by hand.

    python3 scripts/seed.py --fleurs [--base URL]   # FLEURS read speech, labelled as such, until the family sample exists
    python3 scripts/seed.py --sample [--base URL]   # the consented actor recordings in ../assets/sample-raw/
    python3 scripts/seed.py --check                 # assert public/sample/sample.json against the expected memory

The sample is uploaded to a fresh space on the live app (presigned PUT), kept by one Nebius Job, remembered by
Nemotron 3 Super (the space opts in), and its pipeline copy of the original is deleted and HEAD-checked. What the
Job produced — tokens (.hct), transcript, NanoCodec's reconstruction, the original, memory — is then published under
public/sample/ (and copied to the bucket's permanent sample/ prefix), so /judge needs no Job, no cap, no account.
FLEURS audio is CC BY 4.0 (Google, hi_in); attribution is on the page and in bench/LICENSE-DATA.md.

Clip choice for --fleurs, fixed before the run: the fleurs20 clip whose round-trip drift is the MEDIAN in the
benchmark of record (representative, neither the best nor the worst), plus the 60-second Opus note (clip60.opus).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sample"
sys.path.insert(0, str(ROOT / "scripts"))
from bench import Client, consent_version  # noqa: E402
from s3 import S3, load_env  # noqa: E402

FLEURS_ATTR = "Google FLEURS (hi_in test split), CC BY 4.0"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as res:
        return res.read()


def to_flac(data: bytes, suffix: str) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / f"in{suffix}", Path(tmp) / "out.flac"
        src.write_bytes(data)
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-sample_fmt", "s16", "-c:a", "flac", str(dst)], check=True)
        return dst.read_bytes()


def median_clip() -> str:
    rec = json.loads((ROOT / "bench" / "results" / "record.json").read_text())
    summary = json.loads((ROOT / "bench" / "results" / rec["summary"]).read_text())
    clips = sorted((c for c in summary["clips"] if c["set"] == "fleurs20"), key=lambda c: (c["drift"], c["id"]))
    return clips[(len(clips) - 1) // 2]["id"]


def produce(base: str, uploads: list[dict], kind: str) -> dict:
    """uploads: [{key (bucket), name, title, label, attribution}] -> sample.json content."""
    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    s3 = S3.from_env()
    c = Client(base)
    assert c.call("POST", "/api/space", {"timeZone": "Asia/Kolkata"})[0] == 200
    assert c.call("POST", "/api/agree", {"agreed": True, "deleteOriginals": True, "textVersion": consent_version()})[0] == 200
    assert c.call("POST", "/api/optin", {"optIn": True})[0] == 200
    blobs = [s3.get(u["key"]) for u in uploads]
    st, slots = c.call("POST", "/api/notes", {"files": [{"name": u["name"], "size": len(b)} for u, b in zip(uploads, blobs)]})
    assert st == 200, slots
    for slot, blob in zip(slots["notes"], blobs):
        urllib.request.urlopen(urllib.request.Request(slot["putUrl"], data=blob, method="PUT", headers=slot["headers"]), timeout=120).read()
    ids = [s["id"] for s in slots["notes"]]
    st, kept = c.call("POST", "/api/keep", {"notes": ids, "code": os.environ.get("HEARTH_JUDGE_CODE", "")})
    assert st == 200, kept
    t0 = time.time()
    status = {}
    while time.time() - t0 < 40 * 60:
        time.sleep(15)
        st, status = c.call("GET", "/api/status")
        notes = [n for n in status.get("notes", []) if n["id"] in ids]
        if notes and all(n["status"] in ("kept", "failed") for n in notes) and all(n.get("memory") not in ("pending",) for n in notes):
            break
        print(f"  {round(time.time() - t0)} s: " + ", ".join(f"{n['id']}={n['status']}/{n.get('memory')}" for n in notes), flush=True)
    jobs = status.get("jobs", [])
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*"):
        if f.name != "sample.json":
            f.unlink()
    out_notes = []
    for u, nid in zip(uploads, ids):
        st, d = c.call("GET", f"/api/notes/{nid}")
        assert st == 200 and d["meta"]["status"] == "kept", d
        meta, urls = d["meta"], d["urls"]
        hct = fetch(urls["hct"])
        (OUT / f"{nid}.hct").write_bytes(hct)
        (OUT / f"{nid}.kept.flac").write_bytes(to_flac(fetch(urls["kept"]), ".wav"))
        original = fetch(urls["original"])
        ext = meta["ext"]
        if ext == "wav":
            (OUT / f"{nid}.original.flac").write_bytes(to_flac(original, ".wav"))
            orig_name = f"{nid}.original.flac"
        else:
            (OUT / f"{nid}.original.{ext}").write_bytes(original)
            orig_name = f"{nid}.original.{ext}"
        st, gone = c.call("POST", f"/api/notes/{nid}/delete-original")
        raw = gone.get("raw", {})
        job = next((j for j in jobs if any(x["id"] == nid for x in j["notes"])), {})
        out_notes.append({
            "id": nid, "label": u["label"], "anchor": meta["anchor"], "title": u["title"], "source": u["key"],
            "attribution": u.get("attribution"),
            "audio": {"original": f"/sample/{orig_name}", "kept": f"/sample/{nid}.kept.flac"},
            "hct": f"/sample/{nid}.hct", "transcript": d["transcript"],
            "glosses": (status.get("memory") or {}).get("glosses", {}).get(nid, {}),
            "kept": meta["kept"],
            "job": {"nebiusId": meta.get("nebiusId"), "hearthJob": meta.get("job"), "preset": "4vcpu-16gb", "region": "eu-west1",
                    "created": job.get("created"), "finished": job.get("finished"), "image": "python:3.11"},
            "raw": {"rawHead": raw.get("rawHead"), "originalHead": raw.get("originalHead"), "checkedAt": raw.get("checkedAt")},
        })
    memory = status.get("memory")
    if memory:
        memory = {**memory, "items": [i for i in memory.get("items", []) if i["note"] in ids]}
    ab_note = out_notes[0]
    sample = {
        "version": 1, "status": "ready", "kind": kind, "notes": out_notes, "memory": memory,
        "ab": {"note": ab_note["id"], "t0": 0, "t1": ab_note["kept"]["audioS"], "bytes": ab_note["kept"]["bytesHct"],
               "drift": ab_note["kept"]["driftNote"], "reason": "the median-drift clip of the benchmark of record" if kind == "fleurs" else "the window holding the ask"},
        "proof": {"base": base, "jobs": [{k: j.get(k) for k in ("job", "nebiusId", "state", "created", "finished", "history")} for j in jobs],
                  "memoryCalls": (memory or {}).get("calls", [])},
    }
    (OUT / "sample.json").write_text(json.dumps(sample, ensure_ascii=False, indent=1))
    for f in OUT.glob("*"):
        s3.put(f"sample/{f.name}", f.read_bytes())
    c.call("POST", "/api/delete-all", {"confirm": "delete"})
    print(f"sample ready: {len(out_notes)} notes -> public/sample/ (and bucket sample/)")
    return sample


def check() -> int:
    s = json.loads((OUT / "sample.json").read_text())
    problems = []
    if s.get("status") != "ready":
        problems.append("sample not produced yet")
    for n in s.get("notes", []):
        hct = OUT / Path(n["hct"]).name
        import hashlib

        if not hct.exists() or hashlib.sha256(hct.read_bytes()).hexdigest() != n["kept"]["sha256"]:
            problems.append(f"{n['id']}: .hct missing or its sha256 differs from the Job's report")
        for side in ("original", "kept"):
            if not (OUT / Path(n["audio"][side]).name).exists():
                problems.append(f"{n['id']}: {side} audio missing")
        if n["raw"].get("rawHead") != 404:
            problems.append(f"{n['id']}: the pipeline's raw copy was not proven deleted")
    if s.get("kind") == "actors":
        items = (s.get("memory") or {}).get("items", [])
        kinds = sorted(i["kind"] for i in items)
        if len(items) != 5 or sum(1 for i in items if i["dueStatus"] == "unclear") != 1 or sum(1 for i in items if i["state"] == "received") != 1:
            problems.append(f"actor sample memory does not match specs §2: {kinds}")
        if any("बारिश" in i["quote"] for i in items):
            problems.append("the rain small talk became an item")
    print("seed --check:", "OK" if not problems else "; ".join(problems))
    return 0 if not problems else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--fleurs", action="store_true")
    g.add_argument("--sample", action="store_true")
    g.add_argument("--check", action="store_true")
    ap.add_argument("--base", default=os.environ.get("HEARTH_PUBLIC_URL", "https://hearth-alpha-six.vercel.app"))
    args = ap.parse_args()
    if args.check:
        return check()
    if args.fleurs:
        clip = median_clip()
        uploads = [
            {"key": f"bench/fleurs/hi_in/{clip}.wav", "name": f"{clip}.wav", "label": "FLEURS reader",
             "title": f"one FLEURS hi_in test sentence (clip {clip}, the median round-trip drift of 20)", "attribution": FLEURS_ATTR},
            {"key": "bench/fleurs/clip60.opus", "name": "clip60.opus", "label": "FLEURS readers",
             "title": "a 60-second note of FLEURS hi_in test sentences, as a 16 kbps Opus voice note", "attribution": FLEURS_ATTR},
        ]
        produce(args.base, uploads, "fleurs")
        return check()
    raw = ROOT.parent / "assets" / "sample-raw"
    files = sorted(p for p in raw.glob("*") if p.suffix.lower() in (".opus", ".ogg", ".m4a", ".mp3", ".wav"))
    if not files or not (ROOT.parent / "submission" / "consent").exists():
        print("no consented actor recordings yet (assets/sample-raw/ + submission/consent/) — the human records them first")
        return 2
    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    s3 = S3.from_env()
    uploads = []
    for f in files:
        s3.put(f"sample-raw/{f.name}", f.read_bytes())
        uploads.append({"key": f"sample-raw/{f.name}", "name": f.name, "label": "Maa" if "maa" in f.name.lower() else "Sunil",
                        "title": f"actors, consented: {f.name}"})
    produce(args.base, uploads, "actors")
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
