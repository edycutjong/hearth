"""seed.py: builds the judge sample through the deployed app. Everything external (app, bucket, ffmpeg, clock) is faked."""
import hashlib
import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seed  # noqa: E402


def test_fetch(monkeypatch):
    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"bytes"

    monkeypatch.setattr(seed.urllib.request, "urlopen", lambda url, timeout: R())
    assert seed.fetch("u") == b"bytes"


def test_to_flac_runs_ffmpeg_and_returns_output(monkeypatch):
    seen = {}

    def run(cmd, check):
        seen["cmd"], seen["check"] = cmd, check
        assert Path(cmd[cmd.index("-i") + 1]).read_bytes() == b"WAV"
        Path(cmd[-1]).write_bytes(b"FLAC")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(seed.subprocess, "run", run)
    assert seed.to_flac(b"WAV", ".wav") == b"FLAC"
    assert seen["cmd"][0] == "ffmpeg" and seen["check"] is True and "flac" in seen["cmd"]


def test_median_clip_is_the_median_drift_of_fleurs20(tmp_path, monkeypatch):
    res = tmp_path / "bench" / "results"
    res.mkdir(parents=True)
    (res / "record.json").write_text(json.dumps({"summary": "s.json"}))
    clips = [{"id": "z", "set": "fleurs20", "drift": 0.3}, {"id": "a", "set": "fleurs20", "drift": 0.1},
             {"id": "m", "set": "fleurs20", "drift": 0.2}, {"id": "x", "set": "fleurs20b", "drift": 0.0}]
    (res / "s.json").write_text(json.dumps({"clips": clips}))
    monkeypatch.setattr(seed, "ROOT", tmp_path)
    assert seed.median_clip() == "m"
    clips.append({"id": "b", "set": "fleurs20", "drift": 0.2})
    (res / "s.json").write_text(json.dumps({"clips": clips}))
    assert seed.median_clip() == "b"  # even count: lower median, ties broken by id


def note(nid, glosses, texts):
    return {"id": nid, "glosses": glosses, "transcript": {"segments": [{"i": i, "text": t} for i, t in enumerate(texts)]}}


def test_demo_query_prefers_longest_unique_english_gloss_word():
    notes = [
        note("a", {"0": "hello wonderful world about", "1": "lovely tiny"}, ["x"]),
        note("b", {"0": "hello everyone", "1": "wonderful"}, ["y"]),
    ]
    # "wonderful" occurs in two segments (excluded), "everyone" is only in b; in the A/B note "lovely"
    # (6 letters) beats "hello" (shared with b), "world" (5), and the stop word "about".
    assert seed.demo_query(notes) == {"q": "lovely", "note": "a", "segment": 1, "from": "gloss"}


def test_demo_query_falls_back_to_devanagari_transcript():
    notes = [note("a", {}, ["नमस्ते दोस्त", "ठीक है"]), note("b", {}, ["दोस्त"])]
    assert seed.demo_query(notes) == {"q": "नमस्ते", "note": "a", "segment": 0, "from": "transcript"}


def test_demo_query_none_when_nothing_unique():
    notes = [note("a", {"0": "tiny"}, [None, "ab"]), note("b", {"0": "tiny"}, ["ab"])]
    assert seed.demo_query(notes) is None


# ── produce ───────────────────────────────────────────────────────────────────────────────
class FakeS3:
    def __init__(self):
        self.puts = {}

    def get(self, key):
        return b"RAW:" + key.encode()

    def put(self, key, body, **kw):
        self.puts[key] = body


class FakeApp:
    log: list = []
    memory_polls: list = []
    memory: dict | None = None

    def __init__(self, base):
        self.base = base

    def call(self, method, path, body=None):
        FakeApp.log.append((method, path))
        if path == "/api/notes":
            return 200, {"notes": [{"id": "n1", "putUrl": "https://put/1", "headers": {}}, {"id": "n2", "putUrl": "https://put/2", "headers": {}}]}
        if path == "/api/keep":
            return 200, {}
        if path == "/api/status":
            polled = FakeApp.memory_polls.pop(0)
            return 200, {"notes": [{"id": "n1", "status": "kept", "memory": polled}, {"id": "n2", "status": "kept", "memory": polled}],
                         "jobs": [{"job": "hj", "nebiusId": "nj", "notes": [{"id": "n1"}], "created": "c", "finished": "f",
                                   "state": "done", "timings": {}, "history": []}],
                         "memory": FakeApp.memory}
        if path.startswith("/api/notes/") and path.endswith("/delete-original"):
            return 200, {"raw": {"rawHead": 404, "originalHead": 404, "checkedAt": "t"}}
        if path.startswith("/api/notes/"):
            nid = path.rsplit("/", 1)[1]
            ext = "wav" if nid == "n1" else "opus"
            return 200, {"meta": {"status": "kept", "ext": ext, "anchor": "a", "kept": {"audioS": 5, "bytesHct": 10, "driftNote": 0.01},
                                  "nebiusId": "nj", "job": "hj"},
                         "urls": {"hct": "h", "kept": "k", "original": "o"}, "transcript": {"segments": [{"i": 0, "text": "कुछ"}]}}
        return 200, {}


@pytest.fixture
def produce_env(tmp_path, monkeypatch):
    out = tmp_path / "public" / "sample"
    out.mkdir(parents=True)
    (out / "stale.hct").write_bytes(b"old")
    (out / "sample.json").write_text("{}")
    monkeypatch.setattr(seed, "OUT", out)
    s3 = FakeS3()
    monkeypatch.setattr(seed, "load_env", lambda *p: None)
    monkeypatch.setattr(seed.S3, "from_env", classmethod(lambda cls: s3))
    FakeApp.log, FakeApp.memory_polls, FakeApp.memory = [], ["pending", "done"], None
    monkeypatch.setattr(seed, "Client", FakeApp)
    monkeypatch.setattr(seed, "consent_version", lambda: "v1")
    monkeypatch.setattr(seed, "fetch", lambda url: b"F:" + url.encode())
    monkeypatch.setattr(seed, "to_flac", lambda data, suffix: b"FLAC(" + data + b")")
    puts = []
    monkeypatch.setattr(seed.urllib.request, "urlopen", lambda req, timeout: types.SimpleNamespace(read=lambda: puts.append((req.full_url, req.data))))
    monkeypatch.setattr(seed.time, "sleep", lambda s: None)
    monkeypatch.setenv("HEARTH_JUDGE_CODE", "c")
    return types.SimpleNamespace(out=out, s3=s3, puts=puts)


UPLOADS = [{"key": "bench/fleurs/hi_in/c.wav", "name": "c.wav", "label": "L1", "title": "T1", "attribution": "attr"},
           {"key": "bench/fleurs/clip60.opus", "name": "clip60.opus", "label": "L2", "title": "T2"}]


def test_produce_publishes_sample_files_and_json(produce_env, capsys):
    FakeApp.memory = {"items": [{"note": "n1"}, {"note": "other"}], "glosses": {"n1": {"0": "wonderful"}}, "calls": [{"c": 1}]}
    sample = seed.produce("https://app", UPLOADS, "fleurs")
    out = produce_env.out
    assert not (out / "stale.hct").exists()
    assert (out / "n1.hct").read_bytes() == b"F:h" and (out / "n1.kept.flac").read_bytes() == b"FLAC(F:k)"
    assert (out / "n1.original.flac").read_bytes() == b"FLAC(F:o)"   # wav original converted
    assert (out / "n2.original.opus").read_bytes() == b"F:o"         # non-wav kept as is
    assert produce_env.puts == [("https://put/1", b"RAW:bench/fleurs/hi_in/c.wav"), ("https://put/2", b"RAW:bench/fleurs/clip60.opus")]
    assert sample == json.loads((out / "sample.json").read_text())
    n1, n2 = sample["notes"]
    assert n1["audio"] == {"original": "/sample/n1.original.flac", "kept": "/sample/n1.kept.flac"}
    assert n2["audio"]["original"] == "/sample/n2.original.opus" and n2["attribution"] is None
    assert n1["raw"] == {"rawHead": 404, "originalHead": 404, "checkedAt": "t"} and n1["job"]["created"] == "c" and n2["job"]["created"] is None
    assert sample["memory"]["items"] == [{"note": "n1"}] and sample["proof"]["memoryCalls"] == [{"c": 1}]
    assert sample["ab"] == {"note": "n1", "t0": 0, "t1": 5, "bytes": 10, "drift": 0.01, "reason": "the median-drift clip of the benchmark of record"}
    assert sample["demoQuery"]["q"] == "wonderful" and sample["proof"]["jobs"][0]["nebiusId"] == "nj"
    assert set(produce_env.s3.puts) >= {"sample/n1.hct", "sample/sample.json", "sample/n2.original.opus"}
    assert FakeApp.log[-1] == ("POST", "/api/delete-all")
    assert "n1=kept/pending" in capsys.readouterr().out


def test_produce_actors_without_memory(produce_env):
    FakeApp.memory_polls = ["done"]
    sample = seed.produce("https://app", UPLOADS, "actors")
    assert sample["memory"] is None and sample["proof"]["memoryCalls"] == []
    assert sample["ab"]["reason"] == "the window holding the ask"
    assert sample["notes"][0]["glosses"] == {}


def test_produce_gives_up_after_forty_minutes(produce_env, monkeypatch):
    clock = iter(range(0, 100000, 1500))
    monkeypatch.setattr(seed.time, "time", lambda: next(clock))
    FakeApp.memory_polls = ["pending"] * 10
    # `status` stays at the last poll: kept notes but memory still pending -> the loop ends by the deadline
    sample = seed.produce("https://app", UPLOADS, "fleurs")
    assert len(sample["notes"]) == 2


class StepFailer(FakeApp):
    fail = ""

    def call(self, method, path, body=None):
        if path == StepFailer.fail:
            return 500, {"error": path}
        return super().call(method, path, body)


@pytest.mark.parametrize("path", ["/api/space", "/api/agree", "/api/optin", "/api/notes", "/api/keep"])
def test_produce_stops_when_a_setup_step_fails(produce_env, monkeypatch, path):
    StepFailer.fail = path
    monkeypatch.setattr(seed, "Client", StepFailer)
    with pytest.raises(AssertionError):
        seed.produce("https://app", UPLOADS, "fleurs")


def test_produce_asserts_note_kept(produce_env, monkeypatch):
    class NotKept(FakeApp):
        def call(self, method, path, body=None):
            st, d = super().call(method, path, body)
            if path == "/api/notes/n1":
                d["meta"]["status"] = "failed"
            return st, d

    monkeypatch.setattr(seed, "Client", NotKept)
    with pytest.raises(AssertionError):
        seed.produce("https://app", UPLOADS, "fleurs")


# ── check ─────────────────────────────────────────────────────────────────────────────────
def good_sample(out: Path, **over):
    hct = b"tokens"
    (out / "n1.hct").write_bytes(hct)
    (out / "n1.original.flac").write_bytes(b"o")
    (out / "n1.kept.flac").write_bytes(b"k")
    s = {"status": "ready", "kind": "fleurs", "demoQuery": {"q": "Wonder", "note": "n1", "segment": 0, "from": "gloss"},
         "notes": [{"id": "n1", "hct": "/sample/n1.hct", "kept": {"sha256": hashlib.sha256(hct).hexdigest()},
                    "audio": {"original": "/sample/n1.original.flac", "kept": "/sample/n1.kept.flac"},
                    "raw": {"rawHead": 404}, "glosses": {"0": "a wonderful day"},
                    "transcript": {"segments": [{"i": 0, "text": "दिन"}]}}]}
    s.update(over)
    (out / "sample.json").write_text(json.dumps(s))
    return s


@pytest.fixture
def out(tmp_path, monkeypatch):
    o = tmp_path / "sample"
    o.mkdir()
    monkeypatch.setattr(seed, "OUT", o)
    return o


def test_check_ok(out, capsys):
    good_sample(out)
    assert seed.check() == 0
    assert "seed --check: OK" in capsys.readouterr().out


def test_check_ok_with_transcript_query(out):
    s = good_sample(out)
    s["demoQuery"] = {"q": "दिन", "note": "n1", "segment": 0, "from": "transcript"}
    (out / "sample.json").write_text(json.dumps(s))
    assert seed.check() == 0


def test_check_reports_every_problem(out, capsys):
    s = good_sample(out)
    s["status"] = "pending"
    s["notes"][0]["kept"]["sha256"] = "bad"
    s["notes"][0]["raw"]["rawHead"] = 200
    (out / "n1.kept.flac").unlink()
    (out / "sample.json").write_text(json.dumps(s))
    assert seed.check() == 1
    msg = capsys.readouterr().out
    assert "sample not produced yet" in msg and "sha256 differs" in msg and "kept audio missing" in msg and "not proven deleted" in msg


def test_check_missing_hct_file(out, capsys):
    good_sample(out)
    (out / "n1.hct").unlink()
    assert seed.check() == 1
    assert ".hct missing" in capsys.readouterr().out


@pytest.mark.parametrize("dq", [None, {"q": "absent", "note": "n1", "segment": 0, "from": "gloss"},
                                {"q": "x", "note": "zzz", "segment": 0, "from": "gloss"},
                                {"q": "x", "note": "n1", "segment": 9, "from": "transcript"}])
def test_check_flags_bad_demo_query(out, capsys, dq):
    good_sample(out, demoQuery=dq)
    assert seed.check() == 1
    assert "suggested search word" in capsys.readouterr().out


def actor_items(**over):
    items = [{"kind": "task", "dueStatus": "clear", "state": "open", "quote": "q"} for _ in range(5)]
    items[0]["dueStatus"] = "unclear"
    items[1]["state"] = "received"
    for k, v in over.items():
        items[int(k[1:])].update(v)
    return items


def test_check_actor_memory_shape(out, capsys):
    good_sample(out, kind="actors", memory={"items": actor_items()})
    assert seed.check() == 0
    good_sample(out, kind="actors", memory={"items": actor_items()[:4]})
    assert seed.check() == 1
    assert "does not match specs" in capsys.readouterr().out
    good_sample(out, kind="actors", memory={"items": actor_items(i2={"quote": "आज बारिश है"})})
    assert seed.check() == 1
    assert "rain small talk" in capsys.readouterr().out
    good_sample(out, kind="actors")
    assert seed.check() == 1


# ── main ──────────────────────────────────────────────────────────────────────────────────
def run_main(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["seed", *argv])
    return seed.main()


def test_main_check_flag(monkeypatch):
    monkeypatch.setattr(seed, "check", lambda: 7)
    assert run_main(monkeypatch, "--check") == 7


def test_main_fleurs_produces_two_uploads_then_checks(monkeypatch):
    got = {}
    monkeypatch.setattr(seed, "median_clip", lambda: "clipX")
    monkeypatch.setattr(seed, "produce", lambda base, uploads, kind: got.update(base=base, uploads=uploads, kind=kind))
    monkeypatch.setattr(seed, "check", lambda: 0)
    assert run_main(monkeypatch, "--fleurs", "--base", "https://b") == 0
    assert got["kind"] == "fleurs" and got["base"] == "https://b"
    assert [u["key"] for u in got["uploads"]] == ["bench/fleurs/hi_in/clipX.wav", "bench/fleurs/clip60.opus"]
    assert "clipX" in got["uploads"][0]["title"]


def test_main_sample_needs_consented_recordings(tmp_path, monkeypatch, capsys):
    root = tmp_path / "build"
    root.mkdir()
    monkeypatch.setattr(seed, "ROOT", root)
    assert run_main(monkeypatch, "--sample") == 2
    assert "no consented actor recordings" in capsys.readouterr().out
    (tmp_path / "assets" / "sample-raw").mkdir(parents=True)
    (tmp_path / "assets" / "sample-raw" / "notes.txt").write_text("ignored")
    assert run_main(monkeypatch, "--sample") == 2   # no recordings with an audio suffix, no consent dir


def test_main_sample_uploads_recordings_and_produces(tmp_path, monkeypatch):
    root = tmp_path / "build"
    root.mkdir()
    raw = tmp_path / "assets" / "sample-raw"
    raw.mkdir(parents=True)
    (raw / "Maa-1.OPUS").write_bytes(b"m")
    (raw / "sunil.m4a").write_bytes(b"s")
    (tmp_path / "submission" / "consent").mkdir(parents=True)
    s3 = FakeS3()
    monkeypatch.setattr(seed, "ROOT", root)
    monkeypatch.setattr(seed, "load_env", lambda *p: None)
    monkeypatch.setattr(seed.S3, "from_env", classmethod(lambda cls: s3))
    got = {}
    monkeypatch.setattr(seed, "produce", lambda base, uploads, kind: got.update(uploads=uploads, kind=kind))
    monkeypatch.setattr(seed, "check", lambda: 0)
    assert run_main(monkeypatch, "--sample") == 0
    assert got["kind"] == "actors" and [u["label"] for u in got["uploads"]] == ["Maa", "Sunil"]
    assert s3.puts == {"sample-raw/Maa-1.OPUS": b"m", "sample-raw/sunil.m4a": b"s"}
