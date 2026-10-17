"""bench.py: every published number's driver, run against fake HTTP, a fake bucket and a fake D0 report."""
import io
import json
import sys
import types
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402


@pytest.fixture
def tree(tmp_path, monkeypatch):
    res = tmp_path / "bench" / "results"
    res.mkdir(parents=True)
    monkeypatch.setattr(bench, "ROOT", tmp_path)
    monkeypatch.setattr(bench, "RESULTS", res)
    monkeypatch.setattr(bench, "stamp", lambda: "T1")
    return tmp_path


def args(**kw):
    base = dict(from_=None, run=False, base="https://app.test", clip="bench/fleurs/clip60.opus", max_min=1, record=False, live=0)
    base.update(kw)
    return types.SimpleNamespace(**base)


def test_stamp_format():
    real = bench.stamp()
    assert real.endswith("Z") and len(real) == 16 and real[8] == "T"


def test_consent_version_matches_the_real_copy_ts():
    assert bench.consent_version().startswith("v1-")


def test_record_raw_explicit_and_from_record_json(tree):
    assert bench.record_raw("x/y.json") == Path("x/y.json").resolve()
    (tree / "bench" / "results" / "record.json").write_text(json.dumps({"raw": "d0-a-raw.json"}))
    assert bench.record_raw(None) == (tree / "bench" / "results" / "d0-a-raw.json").resolve()


SUMMARY = {"wer": {"fleurs20": {"wer_orig": 0.1, "wer_rt": 0.12, "wer_orig_strict": 0.2, "wer_rt_strict": 0.22}},
           "bytes": {"bytes_per_audio_hour": 5}, "rtf": {"all": {"total": 0.4}}, "usd_per_audio_hour": 0.1,
           "hypotheses": {"a": 1},
           "drift_gate": {"fleurs20": {"gate": 0.05}, "fleurs20b": {"gate": 0.05, "delete_rate": 0.9, "validated": True,
                                                                   "failing_clips_under_gate": []}}}


def fake_d0_report(monkeypatch):
    mod = types.SimpleNamespace(summarize=lambda raw: {**SUMMARY, "echo": raw["k"]})
    monkeypatch.setitem(sys.modules, "d0_report", mod)


def test_corpus_from_given_report_writes_stamped_and_latest(tree, monkeypatch, capsys):
    fake_d0_report(monkeypatch)
    raw = tree / "raw.json"
    raw.write_text('{"k": 7}')
    assert bench.corpus(args(from_=str(raw))) == 0
    res = tree / "bench" / "results"
    stamped = json.loads((res / "fleurs20-T1.json").read_text())
    assert stamped["source"] == "raw.json" and stamped["echo"] == 7 and "hypotheses" in stamped
    latest = json.loads((res / "latest.json").read_text())
    assert "hypotheses" not in latest and latest["echo"] == 7
    assert "fleurs20: WER 0.1 -> 0.12" in capsys.readouterr().out


def test_corpus_run_launches_d0_and_uses_newest_raw(tree, monkeypatch):
    fake_d0_report(monkeypatch)
    res = tree / "bench" / "results"
    (res / "d0-a-raw.json").write_text('{"k": 1}')
    (res / "d0-b-raw.json").write_text('{"k": 2}')
    calls = []
    monkeypatch.setattr(bench.subprocess, "call", lambda cmd: (calls.append(cmd), 0)[1])
    assert bench.corpus(args(run=True)) == 0
    assert calls[0][1].endswith("d0.py") and "--bucket-weights" in calls[0]
    assert json.loads((res / "latest.json").read_text())["echo"] == 2


def test_corpus_run_propagates_d0_failure(tree, monkeypatch):
    fake_d0_report(monkeypatch)
    monkeypatch.setattr(bench.subprocess, "call", lambda cmd: 5)
    assert bench.corpus(args(run=True)) == 5


def test_calibrate_writes_gate_comparison(tree, monkeypatch, capsys):
    fake_d0_report(monkeypatch)
    raw = tree / "raw.json"
    raw.write_text('{"k": 1}')
    assert bench.calibrate(args(from_=str(raw))) == 0
    out = json.loads((tree / "bench" / "results" / "calibrate-T1.json").read_text())
    assert out["fleurs20b"]["delete_rate"] == 0.9 and out["source"] == "raw.json"
    assert "delete rate 0.9, validated True" in capsys.readouterr().out
    # a run that has no fleurs20b set still prints
    monkeypatch.setitem(sys.modules, "d0_report", types.SimpleNamespace(
        summarize=lambda r: {"drift_gate": {"fleurs20": {}, "fleurs20b": None}}))
    assert bench.calibrate(args(from_=str(raw))) == 0
    assert "DRIFT_GATE None on fleurs20b" in capsys.readouterr().out


# ── Client ────────────────────────────────────────────────────────────────────────────────
class Resp:
    def __init__(self, status, body):
        self.status, self._b = status, body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


def test_client_call_json_and_http_errors(monkeypatch):
    c = bench.Client("https://app.test/")
    assert c.base == "https://app.test"
    seen = []

    def opener(req, timeout):
        seen.append(req)
        if req.full_url.endswith("/err"):
            raise urllib.error.HTTPError(req.full_url, 429, "m", {}, io.BytesIO(b'{"error": "cap"}'))
        if req.full_url.endswith("/empty"):
            return Resp(204, b"")
        return Resp(200, b'{"ok": true}')

    monkeypatch.setattr(c.opener, "open", opener)
    assert c.call("POST", "/api/x", {"a": 1}) == (200, {"ok": True})
    assert seen[0].data == b'{"a": 1}' and seen[0].get_method() == "POST"
    assert c.call("GET", "/empty") == (204, {})
    assert seen[1].data is None
    assert c.call("GET", "/err") == (429, {"error": "cap"})
    c2 = bench.Client("https://x")
    monkeypatch.setattr(c2.opener, "open", lambda r, timeout: (_ for _ in ()).throw(urllib.error.HTTPError("u", 500, "m", {}, io.BytesIO(b""))))
    assert c2.call("GET", "/z") == (500, {})


def test_consent_version_reads_copy_ts(tree):
    (tree / "src" / "lib").mkdir(parents=True)
    (tree / "src" / "lib" / "copy.ts").write_text('export const CONSENT_VERSION = "2026-10-v3";\n')
    assert bench.consent_version() == "2026-10-v3"


# ── live ──────────────────────────────────────────────────────────────────────────────────
class FakeLive:
    """Scripted app. `statuses` lists what GET /api/status returns on successive polls."""
    statuses: list = []
    log: list = []
    fail_at: str | None = None

    def __init__(self, base):
        self.base = base

    def call(self, method, path, body=None):
        FakeLive.log.append((method, path))
        if path == FakeLive.fail_at:
            return 500, {"error": "x"}
        if path == "/api/space":
            return 200, {}
        if path == "/api/agree":
            return 200, {}
        if path == "/api/notes":
            return 200, {"notes": [{"id": "n1", "putUrl": "https://put", "headers": {"h": "1"}}]}
        if path == "/api/keep":
            return 200, {}
        if path == "/api/status":
            return 200, FakeLive.statuses.pop(0) if FakeLive.statuses else {}
        if path == "/api/proof":
            return 200, {"visitor": {"job": {"timings": {"asr": 3}}}}
        if path == "/api/delete-all":
            return 200, {"listings": 0}
        raise AssertionError(path)


KEPT = {"id": "n1", "status": "kept", "kept": {"audioS": 60, "bytesHct": 100, "driftNote": "ok"}}
JOB = {"job": "hj", "nebiusId": "nj", "notes": [{"id": "n1"}],
       "history": [{"event": "queued", "at": "2026-10-17T00:00:10Z"}, {"event": "Nebius job created", "at": "2026-10-17T00:00:20Z"}]}


@pytest.fixture
def live_env(tree, monkeypatch):
    FakeLive.statuses, FakeLive.log, FakeLive.fail_at = [], [], None
    monkeypatch.setattr(bench, "Client", FakeLive)
    monkeypatch.setattr(bench, "consent_version", lambda: "v1")
    monkeypatch.setattr(bench.time, "sleep", lambda s: None)
    puts = []
    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda req, timeout: (puts.append(req), Resp(200, b""))[1])
    fake_s3 = types.SimpleNamespace(get=lambda key: b"AUDIO" if key.endswith("opus") else None)
    import s3
    monkeypatch.setattr(s3, "load_env", lambda *p: None)
    monkeypatch.setattr(s3.S3, "from_env", classmethod(lambda cls: fake_s3))
    monkeypatch.setenv("HEARTH_JUDGE_CODE", "code")
    return puts


def test_live_missing_clip(live_env, capsys):
    assert bench.live(args(live=1, clip="nope.wav")) == 2
    assert "nope.wav is not in the bucket" in capsys.readouterr().err


def test_live_records_time_to_kept_and_replaces_latest_when_recorded(tree, live_env, capsys):
    FakeLive.statuses = [{"notes": [{"id": "n1", "status": "processing"}], "jobs": [JOB]},
                         {"notes": [KEPT], "jobs": [JOB]}]
    assert bench.live(args(live=1, record=True)) == 0
    res = tree / "bench" / "results"
    out = json.loads((res / "live-T1.json").read_text())
    run = out["runs"][0]
    assert out["kept"] == 1 and out["of"] == 1 and run["polls"] == 2 and run["status"] == "kept"
    assert run["audio_s"] == 60 and run["job_timings_s"] == {"asr": 3} and run["nebius_job"] == "nj"
    assert run["queue_wait_s"] is not None and out["queue_wait_s"]["p50"] == run["queue_wait_s"]
    assert out["time_to_kept_s"]["median"] == out["time_to_kept_s"]["p50"]
    assert json.loads((res / "live-latest.json").read_text())["source"] == "live-T1.json"
    assert ("POST", "/api/delete-all") in FakeLive.log
    assert "kept 1/1" in capsys.readouterr().out


def test_live_without_record_flag_or_https_never_replaces_latest(tree, live_env):
    FakeLive.statuses = [{"notes": [KEPT], "jobs": []}]
    assert bench.live(args(live=1)) == 0
    assert not (tree / "bench" / "results" / "live-latest.json").exists()
    FakeLive.statuses = [{"notes": [KEPT], "jobs": []}]
    assert bench.live(args(live=1, record=True, base="http://localhost:3000")) == 0
    assert not (tree / "bench" / "results" / "live-latest.json").exists()


def test_live_timeout_counts_as_not_kept(tree, live_env):
    # max_min 0: the poll loop never runs, the note is never seen, no percentile exists
    assert bench.live(args(live=1, max_min=0)) == 1
    out = json.loads((tree / "bench" / "results" / "live-T1.json").read_text())
    assert out["kept"] == 0 and out["time_to_kept_s"] == {"p50": None, "p95": None, "median": None}
    assert out["runs"][0]["status"] is None and out["runs"][0]["queue_wait_s"] is None


def test_live_failed_note_stops_polling(tree, live_env):
    FakeLive.statuses = [{"notes": [{"id": "n1", "status": "failed", "error": "bad"}], "jobs": []}]
    assert bench.live(args(live=1)) == 1
    out = json.loads((tree / "bench" / "results" / "live-T1.json").read_text())
    assert out["runs"][0]["error"] == "bad" and out["runs"][0]["polls"] == 1


@pytest.mark.parametrize("path", ["/api/space", "/api/agree", "/api/notes", "/api/keep"])
def test_live_asserts_each_setup_step(live_env, path):
    FakeLive.fail_at = path
    with pytest.raises(AssertionError):
        bench.live(args(live=1))


# ── memory / traction / main ──────────────────────────────────────────────────────────────
def test_memory_collects_sample_stats_and_live_keeps(tree, capsys):
    (tree / "public" / "sample").mkdir(parents=True)
    (tree / "public" / "sample" / "sample.json").write_text(json.dumps({"kind": "fleurs", "memory": {"stats": {"kept": 2}}}))
    (tree / "evidence").mkdir()
    (tree / "evidence" / "keep-1.json").write_text(json.dumps({"runs": [{"memory": {"a": 1}}, {}]}))
    assert bench.memory(None) == 0
    out = json.loads((tree / "bench" / "results" / "memory-T1.json").read_text())
    assert out["sample"] == {"kind": "fleurs", "stats": {"kept": 2}}
    assert out["live_keeps"] == [{"file": "keep-1.json", "memory": [{"a": 1}, None]}]
    assert '"stats"' in capsys.readouterr().out


def test_memory_sample_without_memory(tree):
    (tree / "public" / "sample").mkdir(parents=True)
    (tree / "public" / "sample" / "sample.json").write_text("{}")
    assert bench.memory(None) == 0
    assert json.loads((tree / "bench" / "results" / "memory-T1.json").read_text())["sample"]["stats"] is None


def test_traction_counts_only(tree, capsys, monkeypatch):
    (tree / "sub").mkdir()
    monkey_root = tree / "sub" / "root"
    monkey_root.mkdir()
    monkeypatch.setattr(bench, "ROOT", monkey_root)  # traction reads ROOT.parent/submission
    assert bench.traction(None) == 0
    assert "no ratings yet" in capsys.readouterr().out
    (tree / "sub" / "submission").mkdir()
    (tree / "sub" / "submission" / "traction-ratings.csv").write_text("person,usefulness\nA,4\nA,5\nB,x\nB,\n")
    assert bench.traction(None) == 0
    assert json.loads(capsys.readouterr().out) == {"people": 2, "ratings": 2, "usefulness_mean": 4.5}
    (tree / "sub" / "submission" / "traction-ratings.csv").write_text("person,usefulness\nA,x\n")
    bench.traction(None)
    assert json.loads(capsys.readouterr().out)["usefulness_mean"] is None


@pytest.mark.parametrize("flag,fn,extra", [
    (["--corpus", "fleurs20"], "corpus", []),
    (["--calibrate"], "calibrate", []),
    (["--live", "3"], "live", []),
    (["--memory"], "memory", []),
    (["--traction"], "traction", []),
])
def test_main_dispatches_each_mode(monkeypatch, flag, fn, extra):
    called = []
    for name in ("corpus", "calibrate", "live", "memory", "traction"):
        monkeypatch.setattr(bench, name, lambda a, n=name: (called.append(n), 0)[1])
    monkeypatch.setattr(sys, "argv", ["bench", *flag, *extra])
    assert bench.main() == 0
    assert called == [fn]


def test_main_requires_a_mode(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["bench"])
    with pytest.raises(SystemExit):
        bench.main()
