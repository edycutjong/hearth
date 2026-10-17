"""Behaviour of the small CLI scripts, run against tmp trees and fake S3 / network — no live calls."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_submission_readiness as csr  # noqa: E402
import feed_delay  # noqa: E402
import lifecycle_check  # noqa: E402
import pin_requirements as pr  # noqa: E402
import storage_preflight  # noqa: E402
import sync_numbers as sn  # noqa: E402
import textnorm  # noqa: E402


# ── textnorm ──────────────────────────────────────────────────────────────────────────────
def test_textnorm_folds_nukta_and_chandrabindu_and_strips_punct():
    assert textnorm.normalize("फ़ाइल, हाँ!") == "फाइल हां"
    assert textnorm.normalize("फ़ाइल, हाँ!", fold=False) == "फ़ाइल हाँ"
    assert textnorm.normalize("1,000 <hi-IN> A‌B‍।") == "1000 ab"


def test_textnorm_words():
    assert textnorm.words("A,  b") == ["a", "b"]
    assert textnorm.words("...") == []


# ── check_submission_readiness ────────────────────────────────────────────────────────────
def _readiness_tree(tmp_path, monkeypatch, sample: str, docs: dict):
    (tmp_path / "public" / "sample").mkdir(parents=True)
    (tmp_path / "public" / "sample" / "sample.json").write_text(sample)
    for name, body in docs.items():
        (tmp_path / name).write_text(body)
    monkeypatch.setattr(csr, "ROOT", tmp_path)
    monkeypatch.setattr(csr, "FILES", ["README.md", "DEMO.md"])


def test_readiness_clean(tmp_path, monkeypatch, capsys):
    _readiness_tree(tmp_path, monkeypatch, '{"d":"Mon 12 Oct"}', {"README.md": "all good\nMon 12 Oct ok\n"})
    assert csr.main() == 0  # DEMO.md missing is skipped
    assert "ready" in capsys.readouterr().out


def test_readiness_lists_placeholders_and_unshipped_dates(tmp_path, monkeypatch, capsys):
    _readiness_tree(tmp_path, monkeypatch, "{}", {"README.md": "ok\nTBD here\n", "DEMO.md": "due Sat 17 Oct\n"})
    assert csr.main() == 1
    out = capsys.readouterr().out
    assert "README.md:2: placeholder: TBD here" in out
    assert "DEMO.md:1: illustrative date 'Sat 17 Oct'" in out
    assert "NOT READY: 2 finding(s)" in out


# ── pin_requirements ──────────────────────────────────────────────────────────────────────
def test_pinned_requires_freeze():
    with pytest.raises(SystemExit):
        pr.pinned({})


def test_pinned_sorts_and_drops_installer_tools():
    head, lines = pr.pinned({"run": "r1", "nebius_job_id": "j1",
                             "report": {"versions": {"freeze": ["zlib==1", "pip==24", "Numpy==2", "UV==1"]}}})
    assert lines == ["Numpy==2", "zlib==1"]
    assert "D0 run r1, Nebius job j1" in head


RAW = {"run": "r", "nebius_job_id": "j", "report": {"versions": {"freeze": ["a==1", "b==2"]}}}


def _pin_setup(tmp_path, monkeypatch, argv):
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps(RAW))
    req = tmp_path / "worker" / "requirements.txt"
    req.parent.mkdir()
    monkeypatch.setattr(pr, "ROOT", tmp_path)
    monkeypatch.setattr(pr, "REQ", req)
    monkeypatch.setattr(sys, "argv", ["pin", str(raw), *argv])
    return req


def test_pin_usage(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["pin"])
    assert pr.main() == 2
    assert "Pin worker" in capsys.readouterr().out


def test_pin_writes_then_check_passes_then_fails_on_drift(tmp_path, monkeypatch, capsys):
    req = _pin_setup(tmp_path, monkeypatch, [])
    assert pr.main() == 0
    assert req.read_text().endswith("a==1\nb==2\n")
    assert "pinned 2 packages" in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["pin", str(tmp_path / "raw.json"), "--check"])
    assert pr.main() == 0
    assert "match" in capsys.readouterr().out
    req.write_text("stale")
    assert pr.main() == 1
    assert "differs" in capsys.readouterr().out


def test_pin_refuses_oversized_file(tmp_path, monkeypatch):
    req = _pin_setup(tmp_path, monkeypatch, [])
    raw = {**RAW, "report": {"versions": {"freeze": [f"pkg{i}=={'9' * 100}" for i in range(800)]}}}
    (tmp_path / "raw.json").write_text(json.dumps(raw))
    with pytest.raises(SystemExit, match="64 KiB"):
        pr.main()
    assert not req.exists()


# ── sync_numbers ──────────────────────────────────────────────────────────────────────────
LATEST = {
    "run": "r1", "nebius_job_id": "job1", "preset": "4vcpu",
    "wer": {"fleurs20": {"clips": 20, "wer_orig": 0.1, "wer_rt": 0.12, "wer_orig_strict": 0.2, "wer_rt_strict": 0.25},
            "fleurs20b": {"wer_orig": 0.3, "wer_rt": 0.31}},
    "rtf": {"all": {"asr_s": 0.5, "codec": 0.25, "encode_s": 0.1, "decode_s": 0.2, "total": 0.9}},
    "bytes": {"bytes_per_audio_hour": 1234567, "x_smaller_than_pcm_22k16": 40.4, "x_smaller_than_inputs": 9.6},
    "usd_per_audio_hour": 0.01234, "peak_rss_mb": 2048,
    "cold_start": {"create_to_container_s": 30.2, "install_s": None},
    "drift_gate": {"fleurs20": {"delete_rate": 0.05}, "fleurs20b": {"delete_rate": 0.1}},
}
LIVE = {"of": 5, "kept": 4, "time_to_kept_s": {"p50": 120, "p95": 300}}


def _bench(tmp_path, monkeypatch, latest=LATEST, live=LIVE):
    res = tmp_path / "bench" / "results"
    res.mkdir(parents=True)
    (res / "latest.json").write_text(json.dumps(latest))
    if live:
        (res / "live-2.json").write_text(json.dumps({"of": 1}))
        (res / "live-3.json").write_text(json.dumps(live))
    monkeypatch.setattr(sn, "ROOT", tmp_path)
    monkeypatch.setattr(sn, "DOCS", ["README.md", "DEMO.md"])


def test_numbers_computed_from_measurements(tmp_path, monkeypatch):
    _bench(tmp_path, monkeypatch)
    n = sn.numbers()
    assert n["bytes_per_hour"] == "1,234,567" and n["kb_per_minute"] == "20.6"
    assert n["wer_delta"] == "+2.00" and n["delete_rate_b"] == "10" and n["wer_rt_b"] == "31.00"
    assert n["create_to_container_s"] == "30" and n["install_s"] == "0"
    assert n["ttk_p50_min"] == "2.0" and n["live_kept"] == "4" and n["peak_rss_gb"] == "2.0"


def test_numbers_minimal_without_run_or_live(tmp_path, monkeypatch):
    _bench(tmp_path, monkeypatch, latest={}, live=None)
    assert sn.numbers() == {}
    lean = {**LATEST, "wer": {"fleurs20": LATEST["wer"]["fleurs20"]},
            "drift_gate": {"fleurs20": LATEST["drift_gate"]["fleurs20"]}}
    (tmp_path / "bench" / "results" / "latest.json").write_text(json.dumps(lean))
    assert "delete_rate_b" not in sn.numbers() and "wer_orig_b" not in sn.numbers()


def test_sync_rewrites_marked_numbers_and_check_reports_drift(tmp_path, monkeypatch, capsys):
    _bench(tmp_path, monkeypatch)
    doc = tmp_path / "README.md"
    doc.write_text("a <!--n:clips-->99<!--/n--> b")
    monkeypatch.setattr(sys, "argv", ["sync", "--check"])
    assert sn.main() == 1
    assert "clips is '99', measured '20'" in capsys.readouterr().out
    assert doc.read_text() == "a <!--n:clips-->99<!--/n--> b"
    monkeypatch.setattr(sys, "argv", ["sync"])
    assert sn.main() == 0
    assert doc.read_text() == "a <!--n:clips-->20<!--/n--> b"
    assert "synced" in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["sync", "--check"])
    assert sn.main() == 0
    assert "numbers in sync" in capsys.readouterr().out


def test_sync_unknown_key_is_an_error_even_when_writing(tmp_path, monkeypatch, capsys):
    _bench(tmp_path, monkeypatch)
    (tmp_path / "README.md").write_text("<!--n:nope-->1<!--/n-->")
    monkeypatch.setattr(sys, "argv", ["sync"])
    assert sn.main() == 1
    assert "unknown or unmeasured number 'nope'" in capsys.readouterr().out


def test_sync_write_mode_tolerates_stale_value_but_fixes_it(tmp_path, monkeypatch):
    _bench(tmp_path, monkeypatch)
    (tmp_path / "DEMO.md").write_text("<!--n:preset-->old<!--/n-->")
    monkeypatch.setattr(sys, "argv", ["sync"])
    assert sn.main() == 0
    assert (tmp_path / "DEMO.md").read_text() == "<!--n:preset-->4vcpu<!--/n-->"


# ── feed_delay ────────────────────────────────────────────────────────────────────────────
def test_feed_delay_load_default_and_existing(tmp_path, monkeypatch):
    monkeypatch.setattr(feed_delay, "DEST", tmp_path / "fd.json")
    assert feed_delay.load() == {"measured": False, "server": None, "phone": []}
    (tmp_path / "fd.json").write_text('{"measured": true}')
    assert feed_delay.load() == {"measured": True}


def test_feed_delay_record_computes_minutes(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(feed_delay, "DEST", tmp_path / "fd.json")
    monkeypatch.setattr(sys, "argv", ["fd", "--record", "--kept", "2026-10-23T09:00:00Z",
                                      "--seen-android", "2026-10-23T11:42:00Z", "--seen-ios", "2026-10-23T09:03:30Z",
                                      "--alarm-fired", "yes", "--note", "n"])
    assert feed_delay.main() == 0
    doc = json.loads((tmp_path / "fd.json").read_text())
    assert doc["measured"] is True
    assert doc["phone"] == [{"kept": "2026-10-23T09:00:00Z", "alarm_fired": "yes", "note": "n",
                             "android_delay_min": 162.0, "ios_delay_min": 3.5}]
    assert json.loads(capsys.readouterr().out) == doc


def test_feed_delay_probe_polls_until_uid_appears(tmp_path, monkeypatch):
    monkeypatch.setattr(feed_delay, "DEST", tmp_path / "fd.json")
    bodies = [b"nothing", b"BEGIN\nUID:abc@hearth\n"]
    seen = []

    class Res:
        def __init__(self, b):
            self.b = b

        def read(self):
            return self.b

    monkeypatch.setattr(feed_delay.urllib.request, "urlopen", lambda url, timeout: (seen.append(url), Res(bodies.pop(0)))[1])
    slept = []
    monkeypatch.setattr(feed_delay.time, "sleep", slept.append)
    monkeypatch.setattr(sys, "argv", ["fd", "--probe", "http://feed", "--uid", "abc", "--every", "7"])
    assert feed_delay.main() == 0
    assert slept == [7] and seen == ["http://feed"] * 2
    doc = json.loads((tmp_path / "fd.json").read_text())
    assert doc["server"]["uid"] == "abc" and doc["measured"] is False


# ── fake S3 for lifecycle_check / storage_preflight ───────────────────────────────────────
class FakeS3:
    bucket = "b"
    endpoint = "https://e"

    def __init__(self, responses=None):
        self.responses = responses or {}
        self.store: dict[str, tuple[bytes, str]] = {}
        self.n = 0

    # lifecycle
    def request(self, method, key="", body=b"", query=None, headers=None):
        if method == "GET" and query is not None:
            q = next(iter(query))
            return self.responses.get(q, (200, {}, b""))
        headers = headers or {}
        cur = self.store.get(key)
        if method == "PUT":
            if headers.get("If-None-Match") == "*" and cur:
                return 412, {}, b""
            if "If-Match" in headers and (not cur or cur[1] != headers["If-Match"]):
                return 412, {}, b""
            self.n += 1
            etag = f'"e{self.n}"'
            self.store[key] = (body, etag)
            return 200, {"ETag": etag}, b""
        raise AssertionError(method)

    def get(self, key):
        v = self.store.get(key)
        return v[0] if v else None

    def delete(self, key):
        self.store.pop(key, None)
        return 204

    def head(self, key):
        return 200 if key in self.store else 404


LIFECYCLE_XML = (b"<LifecycleConfiguration><Rule><ID>anon</ID><Status>Enabled</Status><Filter><Prefix>raw/</Prefix></Filter>"
                 b"<Expiration><Days>7</Days></Expiration><Tag><Key>space</Key><Value>anon</Value></Tag></Rule>"
                 b"<Rule><Status>Enabled</Status></Rule></LifecycleConfiguration>")


def test_lifecycle_rules_parse():
    r = lifecycle_check.rules(LIFECYCLE_XML.decode())
    assert r[0] == {"id": "anon", "status": "Enabled", "prefix": "raw/", "days": "7", "tag": [("space", "anon")]}
    assert r[1]["id"] is None and r[1]["days"] is None
    assert lifecycle_check.rules("") == []


@pytest.mark.parametrize("xml,code", [(LIFECYCLE_XML, 0), (b"", 1)])
def test_lifecycle_main_writes_evidence(tmp_path, monkeypatch, capsys, xml, code):
    fake = FakeS3({"lifecycle": (200, {}, xml), "cors": (200, {}, b"<CORS/>")})
    (tmp_path / "evidence").mkdir()
    monkeypatch.setattr(lifecycle_check, "ROOT", tmp_path)
    monkeypatch.setattr(lifecycle_check, "load_env", lambda *p: None)
    monkeypatch.setattr(lifecycle_check.S3, "from_env", classmethod(lambda cls: fake))
    assert lifecycle_check.main() == code
    out = json.loads((tmp_path / "evidence" / "bucket-lifecycle.json").read_text())
    assert out["cors"]["response"] == "<CORS/>" and out["bucket"] == "b"
    assert "lifecycle 200 cors 200" in capsys.readouterr().out


def _preflight(tmp_path, monkeypatch, fake):
    (tmp_path / "evidence").mkdir()
    monkeypatch.setattr(storage_preflight, "ROOT", tmp_path)
    monkeypatch.setattr(storage_preflight, "load_env", lambda *p: None)
    monkeypatch.setattr(storage_preflight.S3, "from_env", classmethod(lambda cls: fake))
    return tmp_path / "evidence" / "storage-preflight.json"


def test_storage_preflight_all_pass(tmp_path, monkeypatch, capsys):
    dest = _preflight(tmp_path, monkeypatch, FakeS3({"versioning": (200, {}, b"<VersioningConfiguration/>")}))
    assert storage_preflight.main() == 0
    out = json.loads(dest.read_text())
    assert out["all_pass"] and len(out["etags"]) == 2 and len(out["checks"]) == 7
    assert "PASS  second_create_refused" in capsys.readouterr().out


def test_storage_preflight_fails_when_versioning_enabled(tmp_path, monkeypatch, capsys):
    dest = _preflight(tmp_path, monkeypatch, FakeS3({"versioning": (200, {}, b"<Status>Enabled</Status>")}))
    assert storage_preflight.main() == 1
    assert json.loads(dest.read_text())["checks"]["versioning_off"]["pass"] is False
    assert "FAIL  versioning_off" in capsys.readouterr().out
