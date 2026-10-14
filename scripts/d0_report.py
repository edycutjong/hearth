#!/usr/bin/env python3
"""Turn a D0 harness run into numbers and gate verdicts.

    python3 scripts/d0_report.py bench/results/d0-<run>-raw.json   ->  bench/results/d0-<run>.json + a table

WER is jiwer over normalised Devanagari (scripts/textnorm.py): "folded" (the gate normaliser: nukta and
chandrabindu folded, as the app compares text) is the primary figure and the one the D0 gate reads; "strict"
(NFC + punctuation only) is always reported beside it. Both normalisers were fixed before the D0 run.
FLEURS is read speech and is in the ASR's own training mix (card), so these are in-domain numbers.

D0 kill gates (build plan, D0 row): ASR RTF <= 0.5; WER_orig <= 15 %; WER_rt <= WER_orig + 5 pts; peak RSS
<= 12 GB; install + load <= 15 min; <= $0.60 per audio-hour. Codec RTF is reported, never a kill.
DRIFT_GATE (fixed prior, note drift <= 5 %): a FLEURS clip PASSES when WER_rt - WER_orig <= 5 pts; the gate is
validated when >= 70 % of passing clips fall under it, and no failing clip slips under it.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import jiwer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from textnorm import words  # noqa: E402

PRICE_PER_HOUR = {"4vcpu-16gb": 4 * 0.015 + 16 * 0.0045, "8vcpu-32gb": 8 * 0.015 + 32 * 0.0045}
DRIFT_GATE = 0.05
STAGES = ("load_s", "segment_s", "lang_check_s", "asr_s", "encode_s", "pack_s", "decode_s", "rt_asr_s")


def refs() -> dict[str, str]:
    out: dict[str, list[str]] = {}
    for name in ("fleurs20.tsv", "fleurs20b.tsv", "fleurs-long.tsv"):
        with (ROOT / "bench" / name).open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\"):
                key = row.get("note") or row["file"].removesuffix(".wav")
                out.setdefault(key, []).append(row["transcription"])
    return {k: " ".join(v) for k, v in out.items()}


def corpus_wer(pairs: list[tuple[str, str]], fold: bool) -> float | None:
    ref = [" ".join(words(r, fold)) for r, _ in pairs]
    hyp = [" ".join(words(h, fold)) for _, h in pairs]
    keep = [(r, h) for r, h in zip(ref, hyp) if r]
    if not keep:
        return None
    return round(jiwer.wer([r for r, _ in keep], [h for _, h in keep]), 4)


def clip_wer(ref: str, hyp: str, fold: bool = True) -> float:
    r, h = " ".join(words(ref, fold)), " ".join(words(hyp, fold))
    if not r:
        return 0.0 if not h else 1.0
    return round(jiwer.wer(r, h) if h else 1.0, 4)


def summarize(raw: dict) -> dict:
    rep = raw["report"]
    ctx = rep.get("context", {})
    preset = raw.get("preset", "4vcpu-16gb")
    price = PRICE_PER_HOUR.get(preset, PRICE_PER_HOUR["4vcpu-16gb"])
    R = refs()
    items = [i for i in rep.get("items", []) if i.get("status") == "processed"]
    clips = []
    for it in items:
        segs = it.get("segments", [])
        hyp = " ".join(s["text"] for s in segs)
        rt = " ".join(s["rt_text"] for s in segs)
        ref = R.get(it["id"], "")
        clips.append({
            "id": it["id"], "set": it.get("set"), "audio_s": it["audio_s"], "bytes_hct": it["bytes_hct"],
            "input_bytes": it.get("input_bytes"), "segments": len(segs),
            "wer_orig": clip_wer(ref, hyp), "wer_rt": clip_wer(ref, rt),
            "wer_orig_strict": clip_wer(ref, hyp, False), "wer_rt_strict": clip_wer(ref, rt, False),
            "drift": clip_wer(hyp, rt), "drift_worker": it.get("drift_note"),
            "lang_detected": it.get("lang_detected"), "timings": it.get("timings", {}),
            "peak_rss_mb": it.get("peak_rss_mb"), "rss_before_mb": it.get("rss_before_mb"), "wall_s": it.get("wall_s"),
            "hyp": hyp, "rt": rt,
        })

    def subset(name: str) -> list[dict]:
        return [c for c in clips if c["set"] == name]

    def stage_rtf(cs: list[dict]) -> dict:
        audio = sum(c["audio_s"] for c in cs) or 1
        out = {k: round(sum(c["timings"].get(k, 0) for c in cs) / audio, 4) for k in STAGES}
        out["codec"] = round(out["encode_s"] + out["decode_s"], 4)
        out["total"] = round(sum(sum(c["timings"].get(k, 0) for k in STAGES) for c in cs) / audio, 4)
        return out

    def wer_block(cs: list[dict]) -> dict:
        pairs_o = [(R.get(c["id"], ""), c["hyp"]) for c in cs]
        pairs_r = [(R.get(c["id"], ""), c["rt"]) for c in cs]
        return {
            "clips": len(cs), "audio_s": round(sum(c["audio_s"] for c in cs), 2),
            "wer_orig": corpus_wer(pairs_o, True), "wer_rt": corpus_wer(pairs_r, True),
            "wer_orig_strict": corpus_wer(pairs_o, False), "wer_rt_strict": corpus_wer(pairs_r, False),
        }

    def drift_gate(cs: list[dict]) -> dict:
        passing = [c for c in cs if c["wer_rt"] - c["wer_orig"] <= 0.05 + 1e-9]
        failing = [c for c in cs if c not in passing]
        under = [c for c in passing if c["drift"] <= DRIFT_GATE + 1e-9]
        slipped = [c["id"] for c in failing if c["drift"] <= DRIFT_GATE + 1e-9]
        rate = len(under) / len(passing) if passing else 0.0
        return {"gate": DRIFT_GATE, "passing_clips": len(passing), "failing_clips": len(failing),
                "passing_under_gate": len(under), "delete_rate": round(rate, 4),
                "validated": rate >= 0.70 and not slipped, "failing_clips_under_gate": slipped,
                "drift_values": sorted(round(c["drift"], 4) for c in cs)}

    f20, f20b = subset("fleurs20"), subset("fleurs20b")
    longs = subset("long") + subset("batch")
    total_audio = sum(c["audio_s"] for c in clips) or 1
    total_bytes = sum(c["bytes_hct"] for c in clips)
    load = rep.get("load", {})
    install_s = (ctx.get("t_install", 0) - ctx.get("t0", 0)) if ctx.get("t0") else None
    created = raw.get("created")
    cold = {
        "create_to_container_s": round(ctx["t0"] - created, 1) if ctx.get("t0") and created else None,
        "install_s": round(install_s, 1) if install_s is not None else None,
        "load_s": load.get("total_s"),
        "load_detail": load,
        "create_to_first_audio_s": round(rep["first_audio_done"] - created, 1) if rep.get("first_audio_done") and created else None,
    }
    rtf_all = stage_rtf(clips)
    rtf_f20 = stage_rtf(f20) if f20 else {}
    usd_per_audio_hour = round(rtf_all["total"] * price, 4)
    w20 = wer_block(f20)
    peak_gb = (rep.get("peak_rss_mb") or 0) / 1024
    gates = {
        "asr_rtf": {"value": rtf_all["asr_s"], "max": 0.5, "pass": rtf_all["asr_s"] <= 0.5},
        "wer_orig": {"value": w20["wer_orig"], "max": 0.15, "pass": w20["wer_orig"] is not None and w20["wer_orig"] <= 0.15},
        "wer_round_trip_minus_orig": {
            "value": round((w20["wer_rt"] or 0) - (w20["wer_orig"] or 0), 4), "max": 0.05,
            "pass": w20["wer_rt"] is not None and w20["wer_orig"] is not None and w20["wer_rt"] - w20["wer_orig"] <= 0.05 + 1e-9},
        "peak_rss_gb": {"value": round(peak_gb, 2), "max": 12, "pass": peak_gb <= 12},
        "install_plus_load_min": {
            "value": round(((install_s or 0) + (load.get("total_s") or 0)) / 60, 2), "max": 15,
            "pass": ((install_s or 0) + (load.get("total_s") or 0)) / 60 <= 15},
        "usd_per_audio_hour": {"value": usd_per_audio_hour, "max": 0.60, "pass": usd_per_audio_hour <= 0.60},
    }
    return {
        "run": raw.get("run"), "preset": preset, "image": raw.get("image"), "nebius_job_id": raw.get("nebius_job_id"),
        "job_state": raw.get("job", {}).get("status", {}).get("state"),
        "context": {k: ctx.get(k) for k in ("cpu_model", "cpus", "mem_total_kb", "python")},
        "versions": rep.get("versions"), "runtime": rep.get("runtime"), "cold_start": cold,
        "determinism": rep.get("determinism"), "load_options": rep.get("load_options"),
        "peak_rss_mb": rep.get("peak_rss_mb"), "price_per_hour_usd": round(price, 4),
        "bytes": {"total_hct": total_bytes, "audio_s": round(total_audio, 2),
                  "bytes_per_audio_hour": round(total_bytes / total_audio * 3600),
                  "x_smaller_than_pcm_22k16": round(total_audio * 44_100 / total_bytes, 1) if total_bytes else None,
                  "x_smaller_than_inputs": round(sum(c["input_bytes"] or 0 for c in clips) / total_bytes, 1) if total_bytes else None},
        "rtf": {"all": rtf_all, "fleurs20": rtf_f20, "long": stage_rtf(longs) if longs else {}},
        "usd_per_audio_hour": usd_per_audio_hour,
        "wer": {"fleurs20": w20, "fleurs20b": wer_block(f20b) if f20b else None, "long": wer_block(longs) if longs else None},
        "drift_gate": {"fleurs20": drift_gate(f20), "fleurs20b": drift_gate(f20b) if f20b else None},
        "gates": gates, "kill": not all(g["pass"] for g in gates.values()),
        "skipped_or_failed": [{"id": i["id"], "status": i.get("status"), "error": i.get("error")} for i in rep.get("items", []) if i.get("status") != "processed"],
        "clips": [{k: v for k, v in c.items() if k not in ("hyp", "rt")} for c in clips],
        "hypotheses": {c["id"]: {"orig": c["hyp"], "round_trip": c["rt"]} for c in clips},
        "honesty": "FLEURS is read speech recorded for ASR research, not phone voice notes, and FLEURS is in the ASR's training mix (card), so it is in-domain for this ASR.",
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = Path(sys.argv[1]).resolve()
    out = summarize(json.loads(src.read_text()))
    dest = src.with_name(src.name.replace("-raw.json", ".json"))
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    g = out["gates"]
    print(f"D0 {out['run']} on {out['preset']} · job {out['nebius_job_id']} · {out['job_state']}")
    for k, v in g.items():
        print(f"  {'PASS' if v['pass'] else 'FAIL'}  {k:<28} {v['value']}  (limit {v['max']})")
    w = out["wer"]["fleurs20"]
    print(f"  WER fleurs20 folded {w['wer_orig']} -> {w['wer_rt']} · strict {w['wer_orig_strict']} -> {w['wer_rt_strict']}")
    print(f"  bytes/hour {out['bytes']['bytes_per_audio_hour']} · x{out['bytes']['x_smaller_than_pcm_22k16']} vs PCM")
    print(f"  RTF {out['rtf']['all']} · ${out['usd_per_audio_hour']}/audio-hour")
    print(f"  cold start {out['cold_start']}")
    print(f"  drift gate {json.dumps(out['drift_gate']['fleurs20'])[:400]}")
    print(f"  determinism {out['determinism']} · load options {out['load_options']}")
    print(f"  KILL: {out['kill']} -> {dest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# ---------------------------------------------------------------- codec-settings ablation (dev split)

SIMPLICITY = ["base", "lead3", "cond", "cond_lead3", "always_lead3"]  # tie-break order: simpler first


def ablation_summary(raw: dict) -> dict:
    """Corpus WER of the original and of each config's round trip on the FLEURS dev clips; the pre-registered rule
    picks the lowest round-trip delta (folded WER), a tie (within 0.1 pt) going to the simpler config."""
    devrefs: dict[str, str] = {}
    with (ROOT / "bench" / "fleurs-dev20.tsv").open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\"):
            devrefs[row["file"].removesuffix(".wav")] = row["transcription"]
    items = [i for i in raw["report"].get("items", []) if i.get("status") == "processed" and "configs" in i]
    names = list(items[0]["configs"]) if items else []
    orig_pairs = [(devrefs[i["id"]], " ".join(i["text"][k] for k in sorted(i["text"], key=int))) for i in items]
    wer_orig = corpus_wer(orig_pairs, True)
    out = {"clips": len(items), "wer_orig": wer_orig, "configs": {}}
    for n in names:
        pairs = [(devrefs[i["id"]], " ".join(i["configs"][n]["rt_text"][k] for k in sorted(i["configs"][n]["rt_text"], key=int))) for i in items]
        w = corpus_wer(pairs, True)
        drifts = [i["configs"][n]["drift"] for i in items]
        out["configs"][n] = {"wer_rt": w, "delta_pts": round(((w or 0) - (wer_orig or 0)) * 100, 2),
                             "clips_drift_over_30pct": sum(1 for d in drifts if d > 0.3),
                             "median_drift": sorted(drifts)[len(drifts) // 2] if drifts else None}
    best = min(names, key=lambda n: (round(out["configs"][n]["delta_pts"], 1), SIMPLICITY.index(n) if n in SIMPLICITY else 99)) if names else None
    out["chosen"] = best
    out["rule"] = "lowest corpus round-trip delta (folded WER) on the FLEURS dev clips; ties within 0.1 pt go to the simpler config"
    return out
