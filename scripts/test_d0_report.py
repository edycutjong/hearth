"""d0_report.py: WER, RTF, cost and kill-gate verdicts from a synthetic D0 raw report. `jiwer` (a bench-only
dependency, not installed in CI) is replaced by a word-level edit-distance WER with the same contract."""
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _wer(ref, hyp):
    refs = [ref] if isinstance(ref, str) else ref
    hyps = [hyp] if isinstance(hyp, str) else hyp
    errors = total = 0
    for r, h in zip(refs, hyps):
        a, b = r.split(), h.split()
        prev = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            cur = [i]
            for j, y in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
            prev = cur
        errors += prev[-1]
        total += len(a)
    return errors / total


sys.modules["jiwer"] = types.SimpleNamespace(wer=_wer)  # always: deterministic and dependency-free
import d0_report as d0r  # noqa: E402


def tsv(path, header, rows):
    path.write_text("\n".join(["\t".join(header)] + ["\t".join(r) for r in rows]) + "\n", encoding="utf-8")


@pytest.fixture
def bench(tmp_path, monkeypatch):
    b = tmp_path / "bench"
    b.mkdir()
    h = ["id", "file", "duration_s", "gender", "raw_transcription", "transcription"]
    tsv(b / "fleurs20.tsv", h, [["1", "c1.wav", "5", "F", "r", "एक दो तीन चार"], ["2", "c2.wav", "5", "F", "r", "पाँच छह सात आठ"]])
    tsv(b / "fleurs20b.tsv", h, [["3", "c3.wav", "5", "F", "r", "नौ दस"]])
    tsv(b / "fleurs-long.tsv", ["note"] + h, [["long1", "4", "l.wav", "9", "F", "r", "ग्यारह बारह"], ["long1", "5", "m.wav", "9", "F", "r", "तेरह"]])
    tsv(b / "fleurs-dev20.tsv", h, [["7", "d1.wav", "5", "F", "r", "एक दो"], ["8", "d2.wav", "5", "F", "r", "तीन चार"]])
    monkeypatch.setattr(d0r, "ROOT", tmp_path)
    return tmp_path


def item(cid, set_, text, rt, **kw):
    return {"id": cid, "set": set_, "status": "processed", "audio_s": 5.0, "bytes_hct": 100, "input_bytes": 1000,
            "segments": [{"text": text, "rt_text": rt}], "drift_note": 0.0, "lang_detected": "hi",
            "timings": {"asr_s": 1.0, "encode_s": 0.5, "decode_s": 0.5}, "peak_rss_mb": 100, "rss_before_mb": 50, "wall_s": 3, **kw}


def raw_report(**over):
    items = [
        item("c1", "fleurs20", "एक दो तीन चार", "एक दो तीन चार"),          # perfect
        item("c2", "fleurs20", "पाँच छह सात आठ", "पाँच छह सात नौ"),         # rt adds 1/4 -> fails the +5 pt rule, drift .25
        item("c3", "fleurs20b", "नौ दस", "नौ दस"),
        item("long1", "long", "ग्यारह बारह तेरह", "ग्यारह बारह तेरह"),
        {"id": "bad", "status": "failed", "error": "boom"},
    ]
    raw = {"run": "r1", "preset": "4vcpu-16gb", "image": "py", "nebius_job_id": "j", "created": 1000.0,
           "job": {"status": {"state": "COMPLETED"}},
           "report": {"items": items, "context": {"t0": 1010.0, "t_install": 1070.0, "cpus": 4}, "load": {"total_s": 30},
                      "first_audio_done": 1100.0, "peak_rss_mb": 2048, "versions": {"v": 1}, "runtime": "rt",
                      "determinism": "ok", "load_options": {"x": 1}}}
    raw.update(over)
    return raw


def test_normalisers():
    assert d0r.clip_wer("", "") == 0.0 and d0r.clip_wer("", "x") == 1.0
    assert d0r.clip_wer("a b", "") == 1.0
    assert d0r.clip_wer("a b", "a c") == 0.5
    assert d0r.corpus_wer([("", "x")], True) is None
    assert d0r.corpus_wer([("a b", "a b"), ("c", "d")], True) == round(1 / 3, 4)


def test_refs_join_clips_of_one_long_note(bench):
    r = d0r.refs()
    assert r["c1"] == "एक दो तीन चार" and r["long1"] == "ग्यारह बारह तेरह" and r["c3"] == "नौ दस"


def test_summarize_numbers_and_gates(bench):
    out = d0r.summarize(raw_report())
    assert out["job_state"] == "COMPLETED" and out["cold_start"]["create_to_container_s"] == 10.0
    assert out["cold_start"]["install_s"] == 60.0 and out["cold_start"]["create_to_first_audio_s"] == 100.0
    assert out["wer"]["fleurs20"]["clips"] == 2 and out["wer"]["fleurs20"]["wer_orig"] == 0.0
    assert out["wer"]["fleurs20"]["wer_rt"] == 0.125  # one wrong word in eight
    assert out["wer"]["fleurs20b"]["clips"] == 1 and out["wer"]["long"]["clips"] == 1
    assert out["rtf"]["all"]["asr_s"] == 0.2 and out["rtf"]["all"]["codec"] == 0.2 and out["rtf"]["all"]["total"] == 0.4
    assert out["rtf"]["fleurs20"]["total"] == 0.4 and out["rtf"]["long"]["total"] == 0.4
    assert out["bytes"]["bytes_per_audio_hour"] == round(400 / 20 * 3600)
    assert out["bytes"]["x_smaller_than_inputs"] == 10.0
    assert out["usd_per_audio_hour"] == round(0.4 * (4 * 0.015 + 16 * 0.0045), 4)
    g = out["gates"]
    assert g["wer_round_trip_minus_orig"]["value"] == 0.125 and not g["wer_round_trip_minus_orig"]["pass"]
    assert g["asr_rtf"]["pass"] and g["wer_orig"]["pass"] and g["peak_rss_gb"]["value"] == 2.0
    assert g["install_plus_load_min"]["value"] == 1.5 and out["kill"] is True
    assert out["skipped_or_failed"] == [{"id": "bad", "status": "failed", "error": "boom"}]
    assert "hyp" not in out["clips"][0] and out["hypotheses"]["c2"]["round_trip"].endswith("नौ")
    dg = out["drift_gate"]["fleurs20"]
    assert dg["passing_clips"] == 1 and dg["failing_clips"] == 1 and dg["delete_rate"] == 1.0
    assert dg["validated"] is True and dg["failing_clips_under_gate"] == []


def test_summarize_slipped_clip_and_empty_edges(bench):
    # c1: the round trip is far worse than the original against the reference (fails), yet it differs from the
    # original by only 1 word in 40 (drift .025), so the 5 % gate would still let it through: "slipped".
    raw = raw_report()
    long_hyp = " ".join(["w"] * 40)
    raw["report"]["items"] = [
        item("c1", "fleurs20", long_hyp, long_hyp + " x"),
        item("c2", "fleurs20", "पाँच छह सात आठ", "पाँच छह सात आठ"),
    ]
    out = d0r.summarize(raw)
    dg = out["drift_gate"]["fleurs20"]
    assert dg["failing_clips"] == 1 and dg["failing_clips_under_gate"] == ["c1"] and dg["validated"] is False


def test_summarize_with_no_items_and_unknown_preset(bench):
    raw = {"preset": "weird", "report": {}}
    out = d0r.summarize(raw)
    assert out["preset"] == "weird" and out["price_per_hour_usd"] == round(4 * 0.015 + 16 * 0.0045, 4)
    assert out["cold_start"]["install_s"] is None and out["bytes"]["x_smaller_than_pcm_22k16"] is None
    assert out["wer"]["fleurs20b"] is None and out["wer"]["long"] is None and out["rtf"]["fleurs20"] == {}
    assert out["gates"]["wer_orig"]["pass"] is False and out["kill"] is True
    assert out["drift_gate"]["fleurs20"]["delete_rate"] == 0.0 and out["drift_gate"]["fleurs20b"] is None


def abl_item(cid, texts, configs):
    return {"id": cid, "status": "processed", "text": texts,
            "configs": {n: {"rt_text": rt, "drift": d} for n, (rt, d) in configs.items()}}


def test_ablation_summary_picks_lowest_delta_then_simplest(bench):
    raw = {"report": {"items": [
        abl_item("d1", {"0": "एक", "1": "दो"}, {"base": ({"0": "एक", "1": "दो"}, 0.0), "lead3": ({"0": "एक", "1": "दो"}, 0.4),
                                                "cond": ({"0": "एक", "1": "x"}, 0.1)}),
        abl_item("d2", {"0": "तीन", "1": "चार"}, {"base": ({"0": "तीन", "1": "चार"}, 0.0), "lead3": ({"0": "तीन", "1": "चार"}, 0.0),
                                                  "cond": ({"0": "तीन", "1": "चार"}, 0.0)}),
        {"id": "skip", "status": "failed"},
    ]}}
    out = d0r.ablation_summary(raw)
    assert out["clips"] == 2 and out["wer_orig"] == 0.0
    assert out["configs"]["cond"]["delta_pts"] == 25.0 and out["configs"]["lead3"]["clips_drift_over_30pct"] == 1
    assert out["configs"]["base"]["median_drift"] == 0.0
    assert out["chosen"] == "base"  # tie with lead3 at 0 pts goes to the simpler config
    empty = d0r.ablation_summary({"report": {"items": []}})
    assert empty["chosen"] is None and empty["configs"] == {}


def test_ablation_unknown_config_name_sorts_last(bench):
    raw = {"report": {"items": [abl_item("d1", {"0": "एक", "1": "दो"}, {"zzz": ({"0": "एक", "1": "दो"}, 0.0), "base": ({"0": "एक", "1": "दो"}, 0.0)})]}}
    assert d0r.ablation_summary(raw)["chosen"] == "base"
    raw = {"report": {"items": [abl_item("d1", {"0": "एक", "1": "दो"}, {"zzz": ({"0": "एक", "1": "दो"}, 0.0)})]}}
    assert d0r.ablation_summary(raw)["chosen"] == "zzz"


def test_main_usage(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["d0r"])
    assert d0r.main() == 2
    assert "Turn a D0 harness run" in capsys.readouterr().out


def test_main_summary_writes_next_to_raw(bench, monkeypatch, capsys):
    res = bench / "bench" / "results"
    res.mkdir()
    raw = res / "d0-r1-raw.json"
    raw.write_text(json.dumps(raw_report()))
    monkeypatch.setattr(sys, "argv", ["d0r", str(raw)])
    assert d0r.main() == 0
    written = json.loads((res / "d0-r1.json").read_text())
    assert written["run"] == "r1" and written["kill"] is True
    out = capsys.readouterr().out
    assert "FAIL  wer_round_trip_minus_orig" in out and "KILL: True" in out and "PASS  asr_rtf" in out


def test_main_ablation_writes_ablation_file(bench, monkeypatch, capsys):
    res = bench / "bench" / "results"
    res.mkdir()
    raw = res / "d0-r2-ablation-raw.json"
    raw.write_text(json.dumps({"run": "r2", "nebius_job_id": "j", "report": {"items": [
        abl_item("d1", {"0": "एक", "1": "दो"}, {"base": ({"0": "एक", "1": "दो"}, 0.0)})]}}))
    monkeypatch.setattr(sys, "argv", ["d0r", str(raw)])
    assert d0r.main() == 0
    assert json.loads((res / "ablation-r2.json").read_text())["chosen"] == "base"
    assert "chosen: base" in capsys.readouterr().out
