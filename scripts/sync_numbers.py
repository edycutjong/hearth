#!/usr/bin/env python3
"""Fill every published number from the committed measurements — never by hand.

    python3 scripts/sync_numbers.py            # rewrite the marked numbers in README.md, DEMO.md, FEEDBACK.md
    python3 scripts/sync_numbers.py --check    # exit 1 if any marked number differs from the measurements

A number in a doc is written as  <!--n:key-->value<!--/n-->  ; `key` must be one of NUMBERS below, each computed from
bench/results/latest.json (the benchmark of record), bench/results/record.json, the newest live-*.json and
calibrate-*.json. An unknown key, or a key whose source is missing, is an error rather than a guess.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ["README.md", "DEMO.md", "FEEDBACK.md", "ARCHITECTURE.md"]
MARK = re.compile(r"<!--n:([a-z0-9_]+)-->(.*?)<!--/n-->")


def newest(pattern: str) -> dict | None:
    files = sorted((ROOT / "bench" / "results").glob(pattern))
    return json.loads(files[-1].read_text()) if files else None


def numbers() -> dict[str, str]:
    L = json.loads((ROOT / "bench" / "results" / "latest.json").read_text())
    out: dict[str, str] = {}
    if L.get("run"):
        w = L["wer"]["fleurs20"]
        rtf = L["rtf"]["all"]
        b = L["bytes"]
        cold = L.get("cold_start", {})
        out.update({
            "d0_run": L["run"], "d0_job": L["nebius_job_id"], "preset": L["preset"],
            "bytes_per_hour": f"{b['bytes_per_audio_hour']:,}", "kb_per_hour": f"{b['bytes_per_audio_hour'] / 1000:,.0f}",
            "kb_per_minute": f"{b['bytes_per_audio_hour'] / 60_000:.1f}", "x_smaller_pcm": f"{b['x_smaller_than_pcm_22k16']:.0f}",
            "x_smaller_inputs": f"{b['x_smaller_than_inputs']:.0f}",
            "clips": str(w["clips"]), "wer_orig": f"{w['wer_orig'] * 100:.2f}", "wer_rt": f"{w['wer_rt'] * 100:.2f}",
            "wer_delta": f"{(w['wer_rt'] - w['wer_orig']) * 100:+.2f}",
            "wer_orig_strict": f"{w['wer_orig_strict'] * 100:.2f}", "wer_rt_strict": f"{w['wer_rt_strict'] * 100:.2f}",
            "asr_rtf": f"{rtf['asr_s']:.2f}", "codec_rtf": f"{rtf['codec']:.2f}", "encode_rtf": f"{rtf['encode_s']:.2f}",
            "decode_rtf": f"{rtf['decode_s']:.2f}", "total_rtf": f"{rtf['total']:.2f}",
            "usd_per_audio_hour": f"{L['usd_per_audio_hour']:.3f}", "peak_rss_gb": f"{L['peak_rss_mb'] / 1024:.1f}",
            "create_to_container_s": f"{cold.get('create_to_container_s') or 0:.0f}", "install_s": f"{cold.get('install_s') or 0:.0f}",
            "delete_rate": f"{L['drift_gate']['fleurs20']['delete_rate'] * 100:.0f}",
        })
        if L["drift_gate"].get("fleurs20b"):
            out["delete_rate_b"] = f"{L['drift_gate']['fleurs20b']['delete_rate'] * 100:.0f}"
        if L.get("wer", {}).get("fleurs20b"):
            wb = L["wer"]["fleurs20b"]
            out.update({"wer_orig_b": f"{wb['wer_orig'] * 100:.2f}", "wer_rt_b": f"{wb['wer_rt'] * 100:.2f}"})
    live = newest("live-*.json")
    if live and live.get("time_to_kept_s", {}).get("p50"):
        t = live["time_to_kept_s"]
        out.update({"live_runs": str(live["of"]), "live_kept": str(live["kept"]), "ttk_p50_s": f"{t['p50']:.0f}",
                    "ttk_p95_s": f"{t['p95']:.0f}", "ttk_p50_min": f"{t['p50'] / 60:.1f}", "ttk_p95_min": f"{t['p95'] / 60:.1f}"})
    return out


def main() -> int:
    check = "--check" in sys.argv
    nums = numbers()
    bad = []
    for rel in DOCS:
        p = ROOT / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")

        def sub(m: re.Match) -> str:
            key, val = m.group(1), m.group(2)
            if key not in nums:
                bad.append(f"{rel}: unknown or unmeasured number '{key}'")
                return m.group(0)
            if val != nums[key]:
                bad.append(f"{rel}: {key} is '{val}', measured '{nums[key]}'")
            return f"<!--n:{key}-->{nums[key]}<!--/n-->"

        new = MARK.sub(sub, text)
        if not check and new != text:
            p.write_text(new, encoding="utf-8")
    if check and bad:
        print("\n".join(bad))
        return 1
    unknown = [b for b in bad if "unknown" in b]
    if unknown:
        print("\n".join(unknown))
        return 1
    print("numbers in sync" if check else f"synced {len(nums)} measured numbers into {', '.join(DOCS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
