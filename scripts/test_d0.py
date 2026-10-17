"""d0.py: the Job launcher/follower, with a fake bucket, fake `nebius_jobs` calls and a fake clock."""
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d0  # noqa: E402


class FakeS3:
    def __init__(self):
        self.puts = {}

    def presign(self, method, key, expires):
        return f"https://s3/{method}/{key}"

    def put(self, key, body, content_type=None):
        self.puts[key] = json.loads(body)


@pytest.fixture
def tree(tmp_path, monkeypatch):
    b = tmp_path / "bench"
    (b / "results").mkdir(parents=True)
    h = "id\tfile\tduration_s\tgender\traw_transcription\ttranscription\n"
    (b / "fleurs20.tsv").write_text(h + "1\tc1.wav\t5\tF\tr\tt\n")
    (b / "fleurs20b.tsv").write_text(h + "2\tc2.wav\t5\tF\tr\tt\n")
    (b / "fleurs-dev20.tsv").write_text(h + "3\td1.wav\t5\tF\tr\tt\n")
    (b / "fleurs-long.tsv").write_text("note\t" + h + "".join(f"long{i}\t{i}\tl{i}.wav\t5\tF\tr\tt\n" for i in range(1, 6)))
    monkeypatch.setattr(d0, "ROOT", tmp_path)
    return tmp_path


def test_rows_reads_tab_separated(tree):
    assert d0.rows("fleurs20.tsv")[0]["file"] == "c1.wav"


def test_build_notes_for_every_set(tree):
    s3 = FakeS3()
    notes = d0.build_notes(s3, "RUN", ["fleurs20", "fleurs20b", "dev20", "long", "batch", "unknown"])
    by = [(n["id"], n["set"], n["ext"]) for n in notes]
    assert by == [("c1", "fleurs20", "wav"), ("c2", "fleurs20b", "wav"), ("d1", "dev20", "wav"), ("long1", "long", "flac"),
                  ("long2", "batch", "flac"), ("long3", "batch", "flac"), ("long4", "batch", "flac"), ("long5", "batch", "flac")]
    assert notes[0]["get"] == "https://s3/GET/bench/fleurs/hi_in/c1.wav"
    assert notes[2]["get"].endswith("hi_in_dev/d1.wav")
    assert notes[3]["put"]["hct"] == "https://s3/PUT/bench/d0/RUN/hct/long1.hct"


def test_fetch_json(monkeypatch):
    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"a": 1}'

    monkeypatch.setattr(d0.urllib.request, "urlopen", lambda url, timeout: R())
    assert d0.fetch_json("u") == {"a": 1}

    def boom(url, timeout):
        raise OSError("down")

    monkeypatch.setattr(d0.urllib.request, "urlopen", boom)
    assert d0.fetch_json("u") is None


@pytest.fixture
def harness(tree, monkeypatch):
    s3 = FakeS3()
    monkeypatch.setattr(d0, "load_env", lambda *p: None)
    monkeypatch.setattr(d0.S3, "from_env", classmethod(lambda cls: s3))
    monkeypatch.setattr(d0, "worker_files", lambda tmp: {"/a": "/b"})
    monkeypatch.setattr(d0, "running_jobs", lambda: [])
    monkeypatch.setattr(d0.time, "sleep", lambda s: None)
    created = []
    monkeypatch.setattr(d0, "create_job", lambda name, image, env, files, **kw: (created.append((name, image, env, files, kw)), ("job-1", 1000.0))[1])
    return types.SimpleNamespace(s3=s3, created=created, tree=tree)


def run_main(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["d0", *argv])
    return d0.main()


def test_main_builds_manifest_creates_job_and_follows(harness, monkeypatch, capsys):
    followed = []
    monkeypatch.setattr(d0, "follow", lambda s3, run, job_id, t, args: (followed.append((run, job_id, t, args.preset)), 0)[1])
    assert run_main(monkeypatch, "--sets", "fleurs20,long", "--prebuilt", "--trimmed") == 0
    run, job_id, t, preset = followed[0]
    assert job_id == "job-1" and t == 1000.0 and preset == "4vcpu-16gb" and run.endswith("-4vcpu-16gb")
    (key, manifest), = harness.s3.puts.items()
    assert key == f"bench/d0/{run}/manifest.json"
    assert manifest["mode"] == "d0" and manifest["trimmed_codec"] is True and manifest["weights"] is None
    assert manifest["ablation"] is None and set(manifest["model_puts"]) == {"asr", "codec"}
    assert [n["id"] for n in manifest["notes"]] == ["c1", "long1"]
    name, image, env, files, kw = harness.created[0]
    assert env["MODE"] == "d0" and env["HEARTH_PREBUILT"] == "1" and files == {"/a": "/b"} and kw["timeout"] == "2h"
    assert f"re-attach: scripts/d0.py --attach {run} job-1" in capsys.readouterr().out


def test_main_smoke_ablation_bucket_weights_and_filters(harness, monkeypatch):
    monkeypatch.setattr(d0, "follow", lambda *a: 0)
    assert run_main(monkeypatch, "--sets", "fleurs20,fleurs20b", "--only", "c2", "--ablation", "--bucket-weights") == 0
    (key, manifest), = harness.s3.puts.items()
    assert "-ablation/" in key and manifest["ablation"] == d0.ABLATION and manifest["model_puts"] == {}
    assert [n["id"] for n in manifest["notes"]] == ["c2"] and manifest["weights"]["asr"].endswith(".nemo")
    assert "HEARTH_PREBUILT" not in harness.created[0][2]
    harness.s3.puts.clear()
    assert run_main(monkeypatch, "--sets", "fleurs20,fleurs20b", "--limit", "1") == 0
    (key, manifest), = harness.s3.puts.items()
    assert "-smoke/" in key and len(manifest["notes"]) == 1


def test_main_no_model_copy(harness, monkeypatch):
    monkeypatch.setattr(d0, "follow", lambda *a: 0)
    run_main(monkeypatch, "--no-model-copy")
    assert next(iter(harness.s3.puts.values()))["model_puts"] == {}


def test_main_refuses_when_quota_is_used(harness, monkeypatch, capsys):
    monkeypatch.setattr(d0, "running_jobs", lambda: [1, 2])
    assert run_main(monkeypatch) == 3
    assert "already runs 2 jobs" in capsys.readouterr().err
    assert harness.created == []


def test_main_attach_follows_existing_job(harness, monkeypatch):
    got = []
    monkeypatch.setattr(d0, "follow", lambda s3, run, job_id, t, args: (got.append((run, job_id, t)), 0)[1])
    assert run_main(monkeypatch, "--attach", "R", "J", "12.5") == 0
    assert got == [("R", "J", 12.5)] and harness.created == []


def follow_env(tree, monkeypatch, jobs, fetches):
    monkeypatch.setattr(d0.time, "sleep", lambda s: None)
    jobs = list(jobs)

    def get_job(job_id):
        item = jobs.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    fetches = list(fetches)
    monkeypatch.setattr(d0, "get_job", get_job)
    monkeypatch.setattr(d0, "fetch_json", lambda url: fetches.pop(0) if fetches else None)


def job(state):
    return {"status": {"state": state}}


def test_follow_prints_stage_changes_and_saves_raw(tree, monkeypatch, capsys):
    follow_env(tree, monkeypatch,
               jobs=[job("RUNNING"), RuntimeError("cli hiccup"), job("RUNNING"), job("COMPLETED")],
               # per loop: status; final: result, status(record)
               fetches=[{"stage": "load", "item": "c1", "rss_mb": 5}, {"stage": "load", "item": "c1"},
                        {"stage": "asr", "note": "n"}, {"status": "done"}, {"stage": "done"}])
    a = types.SimpleNamespace(preset="4vcpu-16gb", image="py")
    assert d0.follow(FakeS3(), "R", "J", 0.0, a) == 0
    out = capsys.readouterr().out
    assert "get failed: cli hiccup" in out and "worker=load item=c1 rss=5" in out and "worker=asr item=n" in out
    assert out.count("worker=load") == 1  # unchanged stage is not re-printed
    assert "report present" in out
    rec = json.loads((tree / "bench" / "results" / "d0-R-raw.json").read_text())
    assert rec["report"] == {"status": "done"} and rec["nebius_job_id"] == "J" and rec["preset"] == "4vcpu-16gb"


def test_follow_missing_or_failed_report_is_exit_1(tree, monkeypatch, capsys):
    follow_env(tree, monkeypatch, jobs=[job("FAILED")], fetches=[None, None, None])
    assert d0.follow(FakeS3(), "R2", "J", 0.0, types.SimpleNamespace()) == 1
    assert "report MISSING" in capsys.readouterr().out
    rec = json.loads((tree / "bench" / "results" / "d0-R2-raw.json").read_text())
    assert rec["preset"] is None
    follow_env(tree, monkeypatch, jobs=[job("COMPLETED")], fetches=[{"stage": "x"}, {"status": "error"}, None])
    assert d0.follow(FakeS3(), "R3", "J", 0.0, types.SimpleNamespace()) == 1
