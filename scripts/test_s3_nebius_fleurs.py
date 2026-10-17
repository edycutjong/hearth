"""s3.py request/convenience paths against a fake urlopen; nebius_jobs.py through a fake `nebius` CLI;
fleurs_select.py on a synthetic FLEURS TSV."""
import io
import json
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleurs_select as fs  # noqa: E402
import nebius_jobs as nj  # noqa: E402
import s3 as s3mod  # noqa: E402
from s3 import S3  # noqa: E402


# ── s3 ────────────────────────────────────────────────────────────────────────────────────
def client():
    return S3(endpoint="https://storage.x.nebius.cloud", region="x", bucket="bk", access_key="AK", secret_key="SK")


def test_from_env_defaults_and_overrides(monkeypatch):
    for k in ("NEBIUS_REGION", "NEBIUS_S3_ENDPOINT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HEARTH_BUCKET", "b")
    monkeypatch.setenv("NEBIUS_S3_ACCESS_KEY_ID", "a")
    monkeypatch.setenv("NEBIUS_S3_SECRET_ACCESS_KEY", "s")
    c = S3.from_env()
    assert (c.endpoint, c.region, c.bucket) == ("https://storage.eu-west1.nebius.cloud", "eu-west1", "b")
    monkeypatch.setenv("NEBIUS_S3_ENDPOINT", "https://h/")
    monkeypatch.setenv("NEBIUS_REGION", "r")
    c = S3.from_env()
    assert (c.endpoint, c.region) == ("https://h", "r")


def test_enc_slash_and_sign_key_deterministic():
    assert s3mod._enc("a b/c") == "a%20b%2Fc"
    assert s3mod._enc("a b/c", slash=False) == "a%20b/c"
    assert s3mod._sign_key("s", "20240101", "r") == s3mod._sign_key("s", "20240101", "r")
    assert len(s3mod._sign_key("s", "20240101", "r")) == 32


class Res:
    def __init__(self, status=200, body=b"", headers=None):
        self.status, self._b, self.headers = status, body, headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


def patch_urlopen(monkeypatch, handler):
    calls = []

    def fake(req, timeout):
        calls.append(req)
        return handler(req)

    monkeypatch.setattr(s3mod.urllib.request, "urlopen", fake)
    return calls


def test_request_signs_and_sends_body_only_for_put_post(monkeypatch):
    calls = patch_urlopen(monkeypatch, lambda r: Res(200, b"ok", {"ETag": '"x"'}))
    c = client()
    assert c.request("PUT", "k/1", b"data", query={"a": "b c"}, headers={"X-Amz-Tagging": " t=1 "}) == (200, {"ETag": '"x"'}, b"ok")
    c.request("GET", "")
    req = calls[0]
    assert req.full_url == "https://storage.x.nebius.cloud/bk/k/1?a=b%20c"
    assert req.data == b"data" and req.get_method() == "PUT"
    assert "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-tagging" in req.get_header("Authorization")
    assert calls[1].full_url == "https://storage.x.nebius.cloud/bk" and calls[1].data is None


def http_error(code, body=b"err"):
    return urllib.error.HTTPError("u", code, "m", {"X": "1"}, io.BytesIO(body))


def test_request_returns_http_errors_as_status(monkeypatch):
    def boom(req):
        raise http_error(412 if req.get_method() == "PUT" else 404)

    patch_urlopen(monkeypatch, boom)
    c = client()
    assert c.request("PUT", "k", b"x")[0] == 412
    assert c.request("PUT", "k", b"x")[2] == b"err"
    assert c.request("HEAD", "k") == (404, {"X": "1"}, b"")


def test_error_without_headers(monkeypatch):
    err = urllib.error.HTTPError("u", 500, "m", None, io.BytesIO(b"e"))  # type: ignore[arg-type]
    patch_urlopen(monkeypatch, lambda r: (_ for _ in ()).throw(err))
    assert client().request("GET", "k") == (500, {}, b"e")


def test_get_put_head_delete(monkeypatch):
    c = client()
    monkeypatch.setattr(c, "request", lambda *a, **k: (404, {}, b""))
    assert c.get("k") is None
    monkeypatch.setattr(c, "request", lambda *a, **k: (200, {}, b"body"))
    assert c.get("k") == b"body"
    monkeypatch.setattr(c, "request", lambda *a, **k: (500, {}, b"bad"))
    with pytest.raises(RuntimeError, match="GET k: 500"):
        c.get("k")
    assert c.head("k") == 500 and c.delete("k") == 500

    sent = {}

    def ok(method, key, body, headers):
        sent.update(method=method, key=key, body=body, headers=headers)
        return 200, {"etag": "e1"}, b""

    monkeypatch.setattr(c, "request", ok)
    assert c.put("k", b"b", tagging="space=anon", content_type="text/plain") == "e1"
    assert sent["headers"] == {"x-amz-tagging": "space=anon", "content-type": "text/plain"}
    assert c.put("k", b"b") == "e1" and sent["headers"] == {}
    monkeypatch.setattr(c, "request", lambda *a, **k: (200, {"ETag": "E"}, b""))
    assert c.put("k", b"b") == "E"
    monkeypatch.setattr(c, "request", lambda *a, **k: (403, {}, b"no"))
    with pytest.raises(RuntimeError, match="PUT k: 403"):
        c.put("k", b"b")


def test_list_paginates_and_unescapes(monkeypatch):
    pages = [
        (200, {}, b"<Key>a&amp;b</Key><Key>c</Key><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken>"),
        (200, {}, b"<Key>d</Key><IsTruncated>false</IsTruncated>"),
    ]
    queries = []
    c = client()

    def req(method, key, query):
        queries.append(query)
        return pages.pop(0)

    monkeypatch.setattr(c, "request", req)
    assert c.list("p/") == ["a&b", "c", "d"]
    assert "continuation-token" not in queries[0] and queries[1]["continuation-token"] == "t&1"
    monkeypatch.setattr(c, "request", lambda *a, **k: (500, {}, b"x"))
    with pytest.raises(RuntimeError, match="LIST p/: 500"):
        c.list("p/")


def test_xml_entities():
    assert s3mod._xml("&lt;&gt;&quot;&apos;&amp;") == "<>\"'&"


def test_load_env(tmp_path, monkeypatch):
    f = tmp_path / "e.env"
    f.write_text("# c\n\nBAD\nA_K=\"quoted\"\nB_K='single'\nC_K = plain \nD_K=\"\nE_K=x=y\n")
    g = tmp_path / "g.env"
    g.write_text("C_K=later\n")
    for k in "ABCDE":
        monkeypatch.delenv(f"{k}_K", raising=False)
    s3mod.load_env(str(f), str(tmp_path / "missing.env"), str(g))
    import os
    assert (os.environ["A_K"], os.environ["B_K"], os.environ["C_K"], os.environ["D_K"], os.environ["E_K"]) == ("quoted", "single", "later", '"', "x=y")
    for k in "ABCDE":
        monkeypatch.delenv(f"{k}_K")


# ── nebius_jobs ───────────────────────────────────────────────────────────────────────────
def test_ids_from_env(monkeypatch):
    monkeypatch.setenv("NEBIUS_PROJECT_ID", "p")
    monkeypatch.setenv("NEBIUS_SUBNET_ID", "s")
    assert nj._ids() == ("p", "s")


def fake_run(monkeypatch, stdout="", returncode=0, stderr=""):
    calls = []

    def run(cmd, **kw):
        calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)

    monkeypatch.setattr(nj.subprocess, "run", run)
    return calls


def test_cli_parses_json_after_noise_and_handles_empty(monkeypatch):
    calls = fake_run(monkeypatch, 'warn\n{"a": 1}')
    assert nj._cli(["ai", "job", "get"], timeout=5) == {"a": 1}
    assert calls[0][0] == ["nebius", "ai", "job", "get", "--format", "json"] and calls[0][1]["timeout"] == 5
    fake_run(monkeypatch, "no json here")
    assert nj._cli(["x"]) == {}


def test_cli_failure_raises_with_stderr(monkeypatch):
    fake_run(monkeypatch, returncode=1, stderr="  denied ")
    with pytest.raises(RuntimeError, match="nebius ai job create failed: denied"):
        nj._cli(["ai", "job", "create", "--x"])


def test_create_job_builds_command_and_returns_id(monkeypatch, tmp_path):
    monkeypatch.setenv("NEBIUS_PROJECT_ID", "p")
    monkeypatch.setenv("NEBIUS_SUBNET_ID", "s")
    f = tmp_path / "f.txt"
    f.write_text("hello")
    calls = fake_run(monkeypatch, '{"resourceId": "job-9"}')
    job_id, t = nj.create_job("n", "img", {"K": "V"}, {str(f): "/opt/f"})
    assert job_id == "job-9" and t > 0
    cmd = calls[0][0]
    assert ["--env", "K=V"] == cmd[cmd.index("--env"):cmd.index("--env") + 2]
    assert f"{f}:/opt/f" in cmd and "--timeout" in cmd and "1h" in cmd and "64Gi" in cmd
    fake_run(monkeypatch, '{"resource_id": "job-1"}')
    assert nj.create_job("n", "img", {}, {})[0] == "job-1"


def test_create_job_rejects_bad_files_and_missing_id(monkeypatch, tmp_path):
    monkeypatch.setenv("NEBIUS_PROJECT_ID", "p")
    monkeypatch.setenv("NEBIUS_SUBNET_ID", "s")
    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    big = tmp_path / "big"
    big.write_bytes(b"x" * (64 * 1024 + 1))
    with pytest.raises(ValueError, match="1 B - 64 KiB"):
        nj.create_job("n", "i", {}, {str(empty): "/e"})
    with pytest.raises(ValueError, match="1 B - 64 KiB"):
        nj.create_job("n", "i", {}, {str(big): "/b"})
    a, b = tmp_path / "a", tmp_path / "b"
    a.write_bytes(b"x" * 40000)
    b.write_bytes(b"y" * 40000)  # each under 64 KiB, base64 total over it
    with pytest.raises(ValueError, match="total"):
        nj.create_job("n", "i", {}, {str(a): "/a", str(b): "/b"})
    fake_run(monkeypatch, "{}")
    with pytest.raises(RuntimeError, match="no resource id"):
        nj.create_job("n", "i", {}, {})


def test_get_job_redacts_presigned_urls(monkeypatch):
    url = "https://h/b/k?X-Amz-Algorithm=A&X-Amz-Signature=abc123"
    fake_run(monkeypatch, json.dumps({"a": [url, {"b": url}], "n": 3}))
    got = nj.get_job("id")
    assert got == {"a": ["https://h/b/k?<presigned>", {"b": "https://h/b/k?<presigned>"}], "n": 3}


def test_list_running_and_state(monkeypatch):
    monkeypatch.setenv("NEBIUS_PROJECT_ID", "p")
    monkeypatch.setenv("NEBIUS_SUBNET_ID", "s")
    items = [{"status": {"state": "RUNNING"}}, {"status": {"state": "COMPLETED"}}, {}]
    fake_run(monkeypatch, json.dumps({"items": items}))
    assert nj.list_jobs() == items
    assert nj.running_jobs() == [items[0], items[2]]
    assert nj.state(items[0]) == "RUNNING" and nj.state({}) == "UNKNOWN"
    fake_run(monkeypatch, "{}")
    assert nj.list_jobs() == []


# ── fleurs_select ─────────────────────────────────────────────────────────────────────────
def rec(sid, fname, secs, gender="MALE"):
    return "\t".join([str(sid), fname, f"raw{sid}", f"norm{sid}", "ph", str(int(secs * 16000)), gender])


def write_tsv(path, lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_read_rows_sorts_and_validates(tmp_path):
    t = tmp_path / "t.tsv"
    write_tsv(t, [rec(10, "b.wav", 5), rec(2, "z.wav", 6), rec(2, "a.wav", 7)])
    rows = fs.read_rows(t)
    assert [(r["id"], r["file"]) for r in rows] == [(2, "a.wav"), (2, "z.wav"), (10, "b.wav")]
    assert rows[0]["duration_s"] == 7 and rows[0]["transcription"] == "norm2"
    write_tsv(t, ["a\tb"])
    with pytest.raises(ValueError, match="unexpected FLEURS row"):
        fs.read_rows(t)


def dataset(n_eligible=40, long_rows=40, long_secs=100.0):
    rows = [{"id": i, "file": f"{i}.wav", "duration_s": 10.0, "gender": "F", "raw_transcription": "r", "transcription": "t"}
            for i in range(n_eligible)]
    rows.insert(0, {**rows[0], "id": 900, "file": "short.wav", "duration_s": 1.0})  # too short
    rows.append({**rows[1], "file": "dup.wav"})  # duplicate sentence id
    rows += [{"id": 1000 + i, "file": f"l{i}.wav", "duration_s": long_secs, "gender": "M",
              "raw_transcription": "r", "transcription": "t"} for i in range(long_rows)]
    return rows


def test_select_splits_disjoint_and_closes_long_notes_before_300s():
    a, b, longs = fs.select(dataset())
    assert len(a) == 20 and len(b) == 20 and not {r["id"] for r in a} & {r["id"] for r in b}
    assert all(r["id"] != 900 and r["file"] != "dup.wav" for r in a + b)
    assert len(longs) == 5 and all(sum(r["duration_s"] for r in n) <= 300 for n in longs)
    used = {r["id"] for r in a + b}
    assert all(r["id"] not in used for n in longs for r in n)  # rows skipped for the 4-20 s rule may land here


def test_select_skips_ids_already_used_and_fails_when_short():
    with pytest.raises(ValueError, match="only 39 eligible"):
        fs.select(dataset(n_eligible=39))
    with pytest.raises(ValueError, match="long notes"):
        fs.select(dataset(long_rows=3))


def test_main_usage_and_writes_three_tsvs(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["fs"])
    assert fs.main() == 2
    assert "Select the FLEURS" in capsys.readouterr().out
    src = tmp_path / "test.tsv"
    lines = [rec(i, f"{i}.wav", 10) for i in range(40)] + [rec(1000 + i, f"l{i}.wav", 100) for i in range(40)]
    write_tsv(src, lines)
    fake_script = tmp_path / "scripts" / "fleurs_select.py"
    fake_script.parent.mkdir()
    monkeypatch.setattr(fs, "__file__", str(fake_script))
    monkeypatch.setattr(sys, "argv", ["fs", str(src)])
    assert fs.main() == 0
    bench = tmp_path / "bench"
    assert len((bench / "fleurs20.tsv").read_text().splitlines()) == 21
    assert len((bench / "fleurs20b.tsv").read_text().splitlines()) == 21
    long_lines = (bench / "fleurs-long.tsv").read_text().splitlines()
    assert long_lines[0].split("\t")[:2] == ["note", "id"] and long_lines[1].startswith("long1\t")
    out = capsys.readouterr().out
    assert "fleurs20: 20 clips, 200.0 s" in out and "long5:" in out and fs.REVISION in out
