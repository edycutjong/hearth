"""Behaviour of the rest of worker.py: presigned I/O, audio loading, segmentation edges, model loading, the keep /
decode / D0 pipelines, reporting and main().

torch, NeMo, soundfile, librosa, omegaconf and huggingface_hub exist only inside the Nebius Job, so they are
replaced by small stand-ins (numpy-backed tensors, scripted models); what is asserted is worker.py's own logic:
what it reads, what it writes where, and what it reports."""
import contextlib
import io
import json
import sys
import tarfile
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import worker as w  # noqa: E402

SPF = 1764


# ── stand-ins ─────────────────────────────────────────────────────────────────────────────
class T(np.ndarray):
    """A torch.Tensor stand-in: an ndarray with .cpu().numpy()."""

    def cpu(self):
        return self

    def numpy(self):
        return np.asarray(self)


def as_t(a):
    return np.asarray(a).view(T)


def fake_torch():
    return types.SimpleNamespace(
        set_num_threads=lambda n: None, get_num_threads=lambda: 4, inference_mode=contextlib.nullcontext,
        from_numpy=lambda a: as_t(a), tensor=lambda v: as_t(np.array(v)))


def tone(spec):
    parts, rng = [], np.random.default_rng(1)
    for secs, loud in spec:
        n = int(secs * 16000)
        t = np.arange(n) / 16000
        parts.append(0.3 * np.sin(2 * np.pi * 220 * t) if loud else 0.0005 * rng.standard_normal(n))
    return np.concatenate(parts).astype(np.float32)


def interp_resample(x, sr_in, sr_out):
    if sr_in == sr_out:
        return x.astype(np.float32)
    n = int(len(x) * sr_out / sr_in)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


class FakeModels:
    """What the pipeline needs of Models: spf, cb_size, runtime, transcribe/encode/decode. Texts switch from the
    original to the round-trip once decode has run."""
    spf = SPF
    cb_size = 2016
    runtime = {"asr": "fake"}
    timings: dict = {}
    asr_path = codec_path = None

    def __init__(self, orig="एक दो तीन चार", rt="एक दो तीन पांच"):
        self.orig, self.rt, self.phase, self.calls = orig, rt, "orig", []

    def transcribe(self, clips, lang):
        self.calls.append((len(clips), lang))
        if lang == "auto":
            return ["<en-US> hello"]
        txt = self.orig if self.phase == "orig" else self.rt
        return [f"{txt} <{lang}>" for _ in clips]

    def encode(self, x):
        n = -(-len(x) // SPF)
        return (np.arange(13 * n).reshape(13, n) % 2000).astype(np.int64)

    def decode(self, codes, n_samples):
        self.phase = "rt"
        return np.full(n_samples, 0.05, dtype=np.float32)


@pytest.fixture
def pipeline(monkeypatch):
    monkeypatch.setattr(w, "resample", interp_resample)
    audio = {"x": tone([(2, True), (1, False), (2, True)]), "sr": 16000}
    monkeypatch.setattr(w, "load_audio", lambda blob, ext: (audio["x"], audio["sr"]))
    return audio


# ── logging and presigned I/O ─────────────────────────────────────────────────────────────
def test_log_keeps_the_last_300_lines(capsys, monkeypatch):
    monkeypatch.setattr(w, "LOG", [])
    for i in range(305):
        w.log(f"m{i}")
    assert len(w.LOG) == 300 and w.LOG[-1].endswith("m304") and "m304" in capsys.readouterr().out


class Res:
    def __init__(self, body=b""):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, n=-1):
        if n < 0 or not self.body:
            out, self.body = self.body, b""
            return out
        out, self.body = self.body[:n], self.body[n:]
        return out


def test_http_retries_then_succeeds(monkeypatch):
    attempts, sleeps = [], []

    def urlopen(req, timeout):
        attempts.append((req.get_method(), req.full_url, req.data, dict(req.header_items())))
        if len(attempts) < 3:
            raise OSError("blip")
        return Res(b"ok")

    monkeypatch.setattr(w.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(w.time, "sleep", sleeps.append)
    assert w.http("PUT", "https://u", b"d", {"X-A": "1"}) == b"ok"
    assert len(attempts) == 3 and sleeps == [1.5, 3.0] and attempts[0][2] == b"d" and attempts[0][3] == {"X-a": "1"}


def test_http_raises_after_all_tries(monkeypatch):
    monkeypatch.setattr(w.urllib.request, "urlopen", lambda req, timeout: (_ for _ in ()).throw(OSError("down")))
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="GET failed after 2 tries: down"):
        w.http("GET", "https://u", tries=2)


def test_put_targets(monkeypatch):
    sent = []
    monkeypatch.setattr(w, "http", lambda method, url, data, headers: sent.append((method, url, data, headers)))
    w.put(None, b"x")
    w.put("", b"x")
    w.put("https://a", b"1")
    w.put({"url": "https://b", "headers": {"h": "v"}}, b"2")
    w.put({"url": "https://c"}, b"3")
    assert sent == [("PUT", "https://a", b"1", {}), ("PUT", "https://b", b"2", {"h": "v"}), ("PUT", "https://c", b"3", {})]


def test_put_json_is_utf8_not_escaped(monkeypatch):
    sent = []
    monkeypatch.setattr(w, "http", lambda method, url, data, headers: sent.append(data))
    w.put_json("https://a", {"t": "नमस्ते"})
    assert json.loads(sent[0]) == {"t": "नमस्ते"} and "नमस्ते".encode() in sent[0]


def test_load_manifest_from_url_and_from_path(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIFEST_URL", "https://m")
    monkeypatch.setattr(w, "http", lambda method, url: b'{"from": "url"}')
    assert w.load_manifest() == {"from": "url"}
    monkeypatch.delenv("MANIFEST_URL")
    p = tmp_path / "m.json"
    p.write_text('{"from": "path"}')
    monkeypatch.setenv("MANIFEST_PATH", str(p))
    assert w.load_manifest() == {"from": "path"}


# ── segmentation edges ────────────────────────────────────────────────────────────────────
def test_segment_audio_shorter_than_one_analysis_window():
    segs, info = w.segment(np.full(100, 0.1, dtype=np.float32))
    assert segs == [(0.0, 0.01, True)] and info["silences"] == 0


def test_segment_speech_without_pauses_is_not_called_silence():
    segs, info = w.segment(tone([(12, True)]))
    assert segs == [(0.0, 12.0, True)] and info["threshold_db"] <= info["loud_db"] - 20


def test_segment_marks_a_silent_stretch_without_speech():
    segs, _ = w.segment(tone([(5, True), (30, False)]))
    assert segs[0][2] is True and segs[-1][2] is False and len(segs) >= 2


# ── audio loading ─────────────────────────────────────────────────────────────────────────
def test_load_audio_prefers_soundfile_and_downmixes(monkeypatch):
    stereo = np.array([[0.2, 0.4], [1.0, 0.0]], dtype=np.float32)
    seen = {}
    monkeypatch.setitem(sys.modules, "soundfile", types.SimpleNamespace(
        read=lambda f, dtype, always_2d: (seen.update(blob=f.read()), (stereo, 44100))[1]))
    x, sr = w.load_audio(b"BYTES", "wav")
    assert sr == 44100 and x.dtype == np.float32 and np.allclose(x, [0.3, 0.5]) and seen["blob"] == b"BYTES"


@pytest.mark.parametrize("ext,suffix", [("m4a", ".m4a"), ("", ".bin")])
def test_load_audio_falls_back_to_ffmpeg(monkeypatch, ext, suffix):
    def bad_read(*a, **k):
        raise RuntimeError("unsupported")

    monkeypatch.setitem(sys.modules, "soundfile", types.SimpleNamespace(read=bad_read))
    monkeypatch.setattr(w, "ffmpeg_exe", lambda: "/ff")
    import subprocess
    seen = {}

    def run(cmd, capture_output, check):
        seen["cmd"] = cmd
        seen["input"] = Path(cmd[cmd.index("-i") + 1]).read_bytes()
        return types.SimpleNamespace(stdout=np.array([0.5, -0.5], dtype=np.float32).tobytes())

    monkeypatch.setattr(subprocess, "run", run)
    x, sr = w.load_audio(b"M4A", ext)
    assert sr == w.CODEC_SR and x.tolist() == [0.5, -0.5] and x.flags.writeable
    assert seen["input"] == b"M4A" and seen["cmd"][0] == "/ff" and seen["cmd"][seen["cmd"].index("-i") + 1].endswith(suffix)


def test_resample_same_rate_skips_librosa_and_other_rates_use_soxr(monkeypatch):
    calls = []
    monkeypatch.setitem(sys.modules, "librosa", types.SimpleNamespace(
        resample=lambda x, orig_sr, target_sr, res_type: (calls.append((orig_sr, target_sr, res_type)), x[:2].astype(np.float64))[1]))
    x = np.arange(4, dtype=np.float64)
    assert w.resample(x, 16000, 16000).dtype == np.float32 and calls == []
    out = w.resample(x, 22050, 16000)
    assert out.dtype == np.float32 and len(out) == 2 and calls == [(22050, 16000, "soxr_hq")]


def test_wav_bytes_is_a_16bit_mono_wav_with_clipping():
    import wave
    blob = w.wav_bytes(np.array([0.0, 0.5, 2.0, -2.0], dtype=np.float32), 22050)
    with wave.open(io.BytesIO(blob)) as f:
        assert (f.getnchannels(), f.getsampwidth(), f.getframerate()) == (1, 2, 22050)
        pcm = np.frombuffer(f.readframes(4), dtype="<i2")
    assert pcm.tolist() == [0, 16383, 32767, -32767]


def test_rss_mb_is_positive():
    assert w.rss_mb() > 0


def test_ffmpeg_exe_finds_the_system_binary(monkeypatch):
    import shutil
    monkeypatch.setattr(shutil, "which", lambda n: "/usr/bin/ffmpeg")
    assert w.ffmpeg_exe() == "/usr/bin/ffmpeg"


# ── model files ───────────────────────────────────────────────────────────────────────────
def test_load_codec_trimmed_drops_training_only_parts(tmp_path, monkeypatch):
    nemo = tmp_path / "codec.nemo"
    with tarfile.open(nemo, "w") as tar:
        for name, data in (("./other.txt", b"x"), ("./model_config.yaml", b"a: 1\n")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    created = {}

    class Cfg(types.SimpleNamespace):
        pass

    omegaconf = types.SimpleNamespace(
        OmegaConf=types.SimpleNamespace(create=lambda text: (created.update(text=text), Cfg(discriminator="d", use_scl_loss=True, use_slm_loss=True))[1]),
        open_dict=lambda cfg: contextlib.nullcontext(cfg))
    monkeypatch.setitem(sys.modules, "omegaconf", omegaconf)
    restored = {}

    class Codec:
        @classmethod
        def restore_from(cls, **kw):
            restored.update(kw)
            return types.SimpleNamespace(eval=lambda: "eval-model")

    assert w.load_codec_trimmed(Codec, str(nemo)) == "eval-model"
    assert created["text"] == "a: 1\n"
    cfg = restored["override_config_path"]
    assert cfg.discriminator is None and cfg.use_scl_loss is False and cfg.use_slm_loss is False
    assert restored["strict"] is False and restored["map_location"] == "cpu"


@pytest.fixture
def weights_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(w, "PREFETCH_DIR", str(tmp_path / "weights"))
    monkeypatch.setattr(w, "PREFETCH_DONE", str(tmp_path / "weights" / "prefetch.json"))
    monkeypatch.setattr(w, "PREFETCH_STARTED", str(tmp_path / "prefetch.started"))
    return tmp_path


def make_weights(tmp_path):
    asr = tmp_path / "asr.nemo"
    with tarfile.open(asr, "w") as tar:
        d = tarfile.TarInfo("subdir")
        d.type = tarfile.DIRTYPE
        tar.addfile(d)
        info = tarfile.TarInfo("model_weights.ckpt")
        info.size = 4
        tar.addfile(info, io.BytesIO(b"abcd"))
    codec = tmp_path / "codec.nemo"
    codec.write_bytes(b"codec")
    return {"asr": asr.as_uri(), "codec": codec.as_uri()}


def test_fetch_bucket_weights_unpacks_asr_and_keeps_codec(weights_dir):
    asr_dir, codec = w.fetch_bucket_weights(make_weights(weights_dir))
    assert (Path(asr_dir) / "model_weights.ckpt").read_bytes() == b"abcd" and Path(codec).read_bytes() == b"codec"
    asr_dir2, codec2 = w.fetch_bucket_weights({"codec": make_weights(weights_dir)["codec"]}, need_asr=False)
    assert asr_dir2 is None and codec2 == codec


def test_fetch_bucket_weights_raises_the_codec_download_error(weights_dir):
    weights = make_weights(weights_dir)
    weights["codec"] = (weights_dir / "missing.nemo").as_uri()
    with pytest.raises(OSError):
        w.fetch_bucket_weights(weights)


def test_prefetch_reports_a_failed_download_instead_of_raising(weights_dir, monkeypatch):
    manifest = weights_dir / "m.json"
    manifest.write_text(json.dumps({"mode": "keep", "weights": {"asr": "file:///nope", "codec": "file:///nope"}}))
    monkeypatch.delenv("MANIFEST_URL", raising=False)
    monkeypatch.setenv("MANIFEST_PATH", str(manifest))
    monkeypatch.delenv("MODE", raising=False)
    assert w.prefetch_main() == 0
    out = json.loads((weights_dir / "weights" / "prefetch.json").read_text())
    assert out["ok"] is False and out["reason"]


def test_wait_prefetch_times_out_and_polls(weights_dir, monkeypatch):
    (weights_dir / "prefetch.started").touch()
    assert w.wait_prefetch(limit_s=0)["reason"] == "no prefetch result after 0 s"
    (weights_dir / "weights").mkdir()

    def sleep(s):
        Path(w.PREFETCH_DONE).write_text('{"ok": true}')

    monkeypatch.setattr(w.time, "sleep", sleep)
    assert w.wait_prefetch(limit_s=60) == {"ok": True}


# ── Models ────────────────────────────────────────────────────────────────────────────────
class FakeEncoder:
    att_context_size = [56, 13]
    att_context_size_all = [(56, 13), (70, 0)]

    def __init__(self):
        self.set_to = None

    def set_default_att_context_size(self, v):
        self.set_to = v


class FakeASR:
    instances: list = []

    def __init__(self, res=None):
        self.encoder = FakeEncoder()
        self.cfg = types.SimpleNamespace(preprocessor={"sample_rate": 16000})
        self.res = res
        self.batches = []
        FakeASR.instances.append(self)

    def eval(self):
        return self

    def transcribe(self, batch, batch_size, target_lang, verbose):
        self.batches.append((batch, target_lang))
        return self.res if self.res is not None else [types.SimpleNamespace(text=f"t{len(b)}") for b in batch]


class FakeCodec:
    sample_rate = 22050
    samples_per_frame = SPF
    vector_quantizer = types.SimpleNamespace(codebook_size=2016)

    def eval(self):
        return self

    def encode(self, audio, audio_len):
        n = int(audio_len[0]) // SPF + 1
        return as_t(np.arange(13 * n).reshape(1, 13, n)), as_t(np.array([n - 1]))

    def decode(self, tokens, tokens_len):
        return as_t(np.zeros((1, int(tokens_len[0]) * SPF), dtype=np.float32)), None


class FakeAudioCodecModel:
    restored: list = []

    @classmethod
    def restore_from(cls, **kw):
        cls.restored.append(kw)
        return FakeCodec()


@pytest.fixture
def nemo_stack(monkeypatch):
    FakeASR.instances, FakeAudioCodecModel.restored = [], []
    asr_model = types.SimpleNamespace(restore_from=lambda **kw: _restore_asr(**kw))
    mods = {}

    def mod(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        mods[name] = m
        return m

    asr_pkg = mod("nemo.collections.asr", models=types.SimpleNamespace(ASRModel=asr_model))
    tts_models = mod("nemo.collections.tts.models", AudioCodecModel=FakeAudioCodecModel)
    conn_mod = mod("nemo.core.connectors.save_restore_connector", SaveRestoreConnector=type("Conn", (), {}))
    nemo = mod("nemo")
    coll = mod("nemo.collections", asr=asr_pkg)
    nemo.collections = coll
    mod("nemo.collections.tts", models=tts_models)
    mod("nemo.core")
    mod("nemo.core.connectors")
    for k, v in mods.items():
        monkeypatch.setitem(sys.modules, k, v)
    monkeypatch.setitem(sys.modules, "torch", fake_torch())
    return conn_mod


ASR_RESTORES: list = []


def _restore_asr(**kw):
    ASR_RESTORES.append(kw)
    return FakeASR()


def test_models_from_pre_extracted_bucket_copy(nemo_stack, monkeypatch, tmp_path):
    ASR_RESTORES.clear()
    asr_dir = tmp_path / "asr"
    asr_dir.mkdir()
    monkeypatch.setattr(w, "wait_prefetch", lambda: {"ok": True, "asr": str(asr_dir), "codec": "/c.nemo", "s": 2.5})
    m = w.Models({"asr": "a", "codec": "c"})
    assert m.weights_source == "bucket" and m.prefetched is True and m.timings["prefetch_s"] == 2.5
    assert ASR_RESTORES[0]["save_restore_connector"].model_extracted_dir == str(asr_dir)
    assert m.asr.encoder.set_to == [56, 13] and m.asr_sr == 16000
    assert m.spf == SPF and m.cb_size == 2016 and m.timings["codec_trimmed"] == 0.0
    assert m.runtime["asr"] == "nemo" and m.runtime["att_context_size_all"] == [[56, 13], [70, 0]]
    assert m.runtime["chunk_s"] == 1.12 and m.runtime["weights_prefetched"] is True and m.runtime["torch_threads"] == 4
    assert FakeAudioCodecModel.restored[0]["restore_path"] == "/c.nemo"


def test_models_from_nemo_file_trimmed_codec_without_prefetch(nemo_stack, monkeypatch):
    ASR_RESTORES.clear()
    monkeypatch.setattr(w, "wait_prefetch", lambda: None)
    monkeypatch.setattr(w, "fetch_bucket_weights", lambda weights, need_asr: ("/missing-dir.nemo", "/c.nemo"))
    trimmed = []
    monkeypatch.setattr(w, "load_codec_trimmed", lambda cls, path: (trimmed.append(path), FakeCodec())[1])
    m = w.Models({"asr": "a", "codec": "c"}, trimmed_codec=True)
    assert "save_restore_connector" not in ASR_RESTORES[0] and ASR_RESTORES[0]["restore_path"] == "/missing-dir.nemo"
    assert trimmed == ["/c.nemo"] and m.timings["codec_trimmed"] == 1.0 and m.weights_source == "bucket"


def test_models_decode_only_loads_no_asr(nemo_stack, monkeypatch):
    monkeypatch.setattr(w, "wait_prefetch", lambda: None)
    monkeypatch.setattr(w, "fetch_bucket_weights", lambda weights, need_asr: (None, "/c.nemo"))
    m = w.Models({"codec": "c"}, asr=False)
    assert m.asr is None and "asr" not in m.runtime and "asr_import_s" not in m.timings


def hf_stub(monkeypatch, calls):
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(
        hf_hub_download=lambda repo, name: (calls.append((repo, name)), f"/hf/{name}")[1]))


def models_shell():
    m = object.__new__(w.Models)
    m.timings = {}
    return m


def test_fetch_weights_unready_prefetch_falls_back_to_bucket(monkeypatch):
    monkeypatch.setattr(w, "wait_prefetch", lambda: {"ok": False, "reason": "boom"})
    monkeypatch.setattr(w, "fetch_bucket_weights", lambda weights, need_asr: ("A", "C"))
    m = models_shell()
    assert m.fetch_weights({"asr": "a", "codec": "c"}) == ("A", "C")
    assert m.weights_source == "bucket" and m.prefetched is False and m.timings["prefetch_s"] == 0.0


def test_fetch_weights_falls_back_to_hugging_face(monkeypatch):
    calls = []
    hf_stub(monkeypatch, calls)
    monkeypatch.setattr(w, "wait_prefetch", lambda: None)

    def broken(weights, need_asr):
        raise OSError("403")

    monkeypatch.setattr(w, "fetch_bucket_weights", broken)
    m = models_shell()
    assert m.fetch_weights({"asr": "a", "codec": "c"}) == ("/hf/" + w.ASR_FILE, "/hf/" + w.CODEC_FILE)
    assert m.weights_source == "huggingface" and calls == [(w.ASR_REPO, w.ASR_FILE), (w.CODEC_REPO, w.CODEC_FILE)]
    calls.clear()
    assert m.fetch_weights({}, need_asr=False) == (None, "/hf/" + w.CODEC_FILE) and calls == [(w.CODEC_REPO, w.CODEC_FILE)]


def test_transcribe_orders_by_length_and_returns_in_input_order(monkeypatch):
    monkeypatch.setattr(w, "resample", lambda x, a, b: x)
    m = models_shell()
    m.asr, m.asr_sr = FakeASR(), 16000
    clips = [np.zeros(30), np.zeros(10), np.zeros(20)]
    assert m.transcribe(clips, "hi-IN") == ["t30", "t10", "t20"]
    assert [len(c) for c in m.asr.batches[0][0]] == [10, 20, 30] and m.asr.batches[0][1] == "hi-IN"
    assert m.transcribe([], "hi-IN") == []


def test_transcribe_accepts_tuple_results_and_plain_strings(monkeypatch):
    monkeypatch.setattr(w, "resample", lambda x, a, b: x)
    m = models_shell()
    m.asr, m.asr_sr = FakeASR(res=(["plain", "text"], None)), 16000
    assert m.transcribe([np.zeros(2), np.zeros(1)], "hi-IN") == ["text", "plain"]  # input order, sorted by length


def test_encode_and_decode_strip_padding(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", fake_torch())
    m = models_shell()
    m.codec = FakeCodec()
    codes = m.encode(np.zeros(SPF * 5, dtype=np.float32))
    assert codes.shape == (13, 5) and isinstance(codes, np.ndarray)
    audio = m.decode(codes, SPF * 4 + 10)
    assert audio.shape == (SPF * 4 + 10,) and audio.dtype == np.float32


# ── pipeline ──────────────────────────────────────────────────────────────────────────────
def test_prepare_note_transcribes_speech_segments_and_strips_tags(pipeline):
    m = FakeModels()
    prep = w.prepare_note(m, b"blob", "wav", "hi-IN", False, 300)
    assert prep["dur"] == 5.0 and prep["input_bytes"] == 4 and prep["speech"] == [0]
    assert prep["text"] == {0: "एक दो तीन चार"} and prep["lang"] == "hi-IN" and prep["lang_detected"] is None
    assert m.calls == [(1, "hi-IN")] and set(prep["tm"]) == {"load_s", "segment_s", "lang_check_s", "asr_s"}


@pytest.mark.parametrize("lang,expect_lang", [("detect", "hi-IN"), ("hi-IN", "hi-IN")])
def test_prepare_note_language_check_and_detect(pipeline, lang, expect_lang):
    m = FakeModels()
    prep = w.prepare_note(m, b"b", "wav", lang, True, 300)
    assert prep["lang_detected"] is None or prep["lang_detected"] == "en-US"
    assert m.calls[0] == (1, "auto")
    assert prep["lang"] == ("en-US" if lang == "detect" else expect_lang)


def test_prepare_note_detect_unknown_language_defaults_to_hindi(pipeline):
    class Odd(FakeModels):
        def transcribe(self, clips, lang):
            return ["<xx-XX> zzz"] if lang == "auto" else super().transcribe(clips, lang)

    prep = w.prepare_note(Odd(), b"b", "wav", "detect", False, 300)
    assert prep["lang_detected"] == "xx-XX" and prep["lang"] == "hi-IN"


def test_prepare_note_rejects_empty_and_too_long(pipeline):
    pipeline["x"] = np.zeros(1000, dtype=np.float32)
    with pytest.raises(ValueError, match="no audio"):
        w.prepare_note(FakeModels(), b"b", "wav", "hi-IN", False, 300)
    pipeline["x"] = tone([(5, True)])
    with pytest.raises(ValueError, match=r"note is 5 s; this space keeps notes up to 0\.0666667 min"):
        w.prepare_note(FakeModels(), b"b", "wav", "hi-IN", False, 4)


def test_prepare_note_silent_only_note_still_checks_first_segment(pipeline):
    pipeline["x"] = tone([(2, False)])
    m = FakeModels()
    prep = w.prepare_note(m, b"b", "wav", "hi-IN", True, 300)
    assert m.calls[0] == (1, "auto") and prep["segs"]


def test_codec_roundtrip_packs_decodes_and_measures_drift(pipeline):
    m = FakeModels()
    prep = w.prepare_note(m, b"b", "wav", "hi-IN", False, 300)
    rt = w.codec_roundtrip(m, prep)
    codes, head = w.unpack_hct(rt["hct"])
    assert np.array_equal(codes, rt["codes"]) and head["windows"] == rt["frames"] and head["lead_frames"] == w.LEAD_FRAMES
    assert head["n_samples"] == len(prep["x22"]) and head["gain_db"] == rt["gain_db"]
    assert rt["drift"] == 0.25 and rt["segments"][0]["drift"] == 0.25 and rt["segments"][0]["words"] == 4
    assert rt["segments"][0]["rt_text"] == "एक दो तीन पांच" and len(rt["dec"]) == len(prep["x22"])


def test_codec_roundtrip_options_override_gain_and_lead(pipeline):
    m = FakeModels()
    prep = w.prepare_note(m, b"b", "wav", "hi-IN", False, 300)
    rt = w.codec_roundtrip(m, prep, "none", 0)
    assert rt["gain_db"] == 0.0 and rt["lead"] == 0


def test_codec_roundtrip_non_speech_segment_has_no_drift(pipeline):
    pipeline["x"] = tone([(5, True), (30, False)])
    m = FakeModels()
    prep = w.prepare_note(m, b"b", "wav", "hi-IN", False, 300)
    rt = w.codec_roundtrip(m, prep)
    assert any(s["drift"] is None and s["text"] == "" for s in rt["segments"])


def test_keep_note_returns_result_and_artefacts(pipeline, monkeypatch):
    m = FakeModels(orig="एक दो तीन चार पांच छह सात आठ", rt="एक दो तीन चार पांच छह सात नौ")
    out = w.keep_note(m, b"blob", "wav", "hi-IN")
    r = out["result"]
    assert r["audio_s"] == 5.0 and r["bytes_hct"] == len(out["hct"]) and r["drift_note"] == 0.125
    assert r["max_drift_long_segment"] == 0.125 and r["frames"] == sum(r["windows"])
    import hashlib
    assert r["sha256_hct"] == hashlib.sha256(out["hct"]).hexdigest() and r["peak_rss_mb"] > 0
    assert out["transcript"]["segments"][0] == {"i": 0, "t0": 0.0, "t1": 5.0, "text": "एक दो तीन चार पांच छह सात आठ"}
    assert out["transcript"]["runtime"] == {"asr": "fake"} and out["wav"][:4] == b"RIFF"


def test_keep_note_short_segments_have_no_long_segment_drift(pipeline):
    out = w.keep_note(FakeModels(), b"b", "wav", "hi-IN")
    assert out["result"]["max_drift_long_segment"] is None


def test_ablate_note_runs_every_config(pipeline):
    m = FakeModels()
    out = w.ablate_note(m, b"b", "wav", "hi-IN", [{"name": "base", "gain": "none", "lead": 0}, {"name": "l3", "gain": "always", "lead": 3}])
    assert out["text"] == {"0": "एक दो तीन चार"} and set(out["configs"]) == {"base", "l3"}
    assert out["configs"]["base"]["gain_db"] == 0.0 and out["configs"]["l3"]["rt_text"] == {"0": "एक दो तीन पांच"}
    assert out["configs"]["l3"]["bytes_hct"] > 0 and out["configs"]["l3"]["drift"] == 0.25


# ── run_keep / run_decode ─────────────────────────────────────────────────────────────────
class Rep:
    def __init__(self):
        self.calls = []

    def status(self, stage, **kw):
        self.calls.append((stage, kw))


def test_run_keep_processes_fails_and_uploads(monkeypatch):
    puts, json_puts = [], []
    monkeypatch.setattr(w, "put", lambda target, body: puts.append((target, body)))
    monkeypatch.setattr(w, "put_json", lambda target, value: json_puts.append((target, value)))
    monkeypatch.setattr(w, "http", lambda method, url: b"audio:" + url.encode())

    def keep(m, blob, ext, lang, max_s):
        if b"bad" in blob:
            raise ValueError("cannot read")
        return {"result": {"audio_s": 1}, "hct": b"H", "transcript": {"t": 1}, "wav": b"W"}

    monkeypatch.setattr(w, "keep_note", keep)
    manifest = {"job": "j", "lang": "hi-IN", "max_note_s": 120, "notes": [
        {"id": "good", "get": "g", "ext": "opus", "put": {"hct": "h", "transcript": "t", "wav": "w", "result": "r"}},
        {"id": "bad", "get": "bad", "put": {"hct": "h2", "transcript": "t2", "result": "r2"}}]}
    rep = Rep()
    out = w.run_keep(manifest, rep, m=None)
    good, bad = out["notes"]
    assert good == {"id": "good", "audio_s": 1, "status": "processed", "job": "j"}
    assert bad["status"] == "failed" and bad["error"] == "cannot read" and "ValueError" in bad["trace"]
    assert puts == [("h", b"H"), ("w", b"W")]
    assert ("t", {"t": 1, "note": "good"}) in json_puts and ("r2", bad) in json_puts
    assert [c[1]["note"] for c in rep.calls] == ["good", "bad"]


def test_run_decode_restores_audio_and_reports_failures(monkeypatch):
    import numpy
    codes = (numpy.arange(13 * 6).reshape(13, 6) % 2000).astype(numpy.int64)
    blob = w.pack_hct(codes, n_samples=SPF * 3 - 10, windows=[6], samples_per_frame=SPF, codebook_size=2016, lead=1, ctx=2, gain_db=6.0)
    puts = []
    monkeypatch.setattr(w, "http", lambda method, url: blob if url == "ok" else b"garbage" * 10)
    monkeypatch.setattr(w, "put", lambda target, body: puts.append((target, body)))
    m = FakeModels()
    out = w.run_decode({"notes": [{"id": "a", "hct_get": "ok", "put": {"wav": "w"}}, {"id": "b", "hct_get": "no", "put": {"wav": "w2"}}]}, Rep(), m)
    a, b = out["notes"]
    assert a["status"] == "decoded" and a["audio_s"] == round((SPF * 3 - 10) / w.CODEC_SR, 3)
    assert b["status"] == "failed" and b["error"]
    assert len(puts) == 1 and puts[0][0] == "w" and puts[0][1][:4] == b"RIFF"


# ── run_d0 / d0_extras ────────────────────────────────────────────────────────────────────
@pytest.fixture
def d0env(pipeline, monkeypatch):
    puts, hct_puts = [], []
    monkeypatch.setattr(w, "put_json", lambda target, value: puts.append((target, json.loads(json.dumps(value)))))
    monkeypatch.setattr(w, "put", lambda target, body: hct_puts.append((target, body)))
    monkeypatch.setattr(w, "http", lambda method, url: b"blob")
    extras = []
    monkeypatch.setattr(w, "d0_extras", lambda manifest, rep, m, report: extras.append(report["items"]))
    return types.SimpleNamespace(json_puts=puts, hct_puts=hct_puts, extras=extras)


def test_run_d0_processes_clips_with_determinism_and_partial_results(d0env):
    manifest = {"result_put": "R", "notes": [
        {"id": "c1", "set": "fleurs20", "get": "g", "put": {"hct": "H"}},
        {"id": "c2", "set": "fleurs20b", "get": "g", "put": {}},
        {"id": "l1", "set": "long", "get": "g"}]}
    report = {}
    out = w.run_d0(manifest, Rep(), FakeModels(), report)
    assert out is report and [i["status"] for i in report["items"]] == ["processed"] * 3
    d = report["determinism"]
    assert d["encode_twice_equal"] is True and isinstance(d["hct_roundtrip_equals_fresh_encode"], bool)
    assert d["decode_twice_max_abs_diff"] == 0.0
    assert report["first_audio_done"] > 0 and report["peak_rss_mb"] > 0 and report["items"][0]["rss_before_mb"] > 0
    assert d0env.hct_puts[0][0] == "H" and len(d0env.hct_puts) == 1
    assert len(d0env.json_puts) == 4 and d0env.extras  # one PUT per item, one at the end


def test_run_d0_ablation_mode(d0env, monkeypatch):
    monkeypatch.setattr(w, "ablate_note", lambda m, blob, ext, lang, configs: {"configs": {"base": {}}})
    report = {}
    w.run_d0({"result_put": "R", "ablation": [{"name": "base"}], "notes": [{"id": "d1", "set": "dev20", "get": "g"}]}, Rep(), FakeModels(), report)
    assert report["items"][0]["status"] == "processed" and report["items"][0]["configs"] == {"base": {}}
    assert "first_audio_done" not in report


def test_run_d0_failed_clip_and_deadline(d0env, monkeypatch):
    monkeypatch.setattr(w, "http", lambda method, url: (_ for _ in ()).throw(RuntimeError("get failed")))
    report = {}
    w.run_d0({"result_put": "R", "notes": [{"id": "c1", "set": "fleurs20", "get": "g"}]}, Rep(), FakeModels(), report)
    assert report["items"][0]["status"] == "failed" and report["items"][0]["error"] == "get failed"
    monkeypatch.setattr(w, "T_WORKER", w.time.time() - 7200)
    report = {}
    w.run_d0({"result_put": "R", "soft_deadline_s": 60, "notes": [{"id": "c1", "set": "x"}]}, Rep(), FakeModels(), report)
    assert report["items"] == [{"id": "c1", "set": "x", "status": "skipped_deadline"}]


def extras_models(tmp_path, trimmed=0.0, asr_is_file=True):
    asr_path = tmp_path / "asr.nemo"
    with tarfile.open(asr_path, "w") as tar:
        info = tarfile.TarInfo("model_config.yaml")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    codec_path = tmp_path / "codec.nemo"
    codec_path.write_bytes(b"codec")
    m = FakeModels()
    m.timings = {"codec_trimmed": trimmed}
    m.asr_path = str(asr_path) if asr_is_file else str(tmp_path)
    m.codec_path = str(codec_path)
    return m


def test_d0_extras_measures_trimmed_codec_unpack_and_uploads(nemo_stack, tmp_path, monkeypatch):
    monkeypatch.setattr(w, "load_codec_trimmed", lambda cls, path: FakeCodec())
    uploads = []
    monkeypatch.setattr(w.urllib.request, "urlopen", lambda req, timeout: (uploads.append((req.full_url, req.data.read(), dict(req.header_items()))), Res())[1])

    class M(FakeModels):
        def encode(self, x):
            return np.arange(13 * -(-len(x) // SPF)).reshape(13, -(-len(x) // SPF)).astype(np.int64)

        def decode(self, codes, n):
            return np.zeros(n, dtype=np.float32)

    m = M()
    m.timings, m.asr_path, m.codec_path = {"codec_trimmed": 0.0}, extras_models(tmp_path).asr_path, str(tmp_path / "codec.nemo")
    report = {}
    rep = Rep()
    w.d0_extras({"model_puts": {"asr": "https://u/asr", "codec": "https://u/codec"}}, rep, m, report)
    e = report["load_options"]
    assert "codec_trimmed_error" not in e and e["codec_trimmed_restore_s"] >= 0
    assert isinstance(e["codec_trimmed_codes_equal"], bool) and e["codec_trimmed_decode_max_abs_diff"] == 0.0
    assert e["asr_nemo_unpack_s"] >= 0 and e["codec_bytes"] == 5 and e["asr_bytes"] == (tmp_path / "asr.nemo").stat().st_size
    assert [u[0] for u in uploads] == ["https://u/asr", "https://u/codec"] and uploads[1][1] == b"codec"
    assert uploads[1][2]["Content-length"] == "5"
    assert [c[1]["step"] for c in rep.calls] == ["trimmed codec", "asr unpack", "upload asr", "upload codec"]


def test_d0_extras_skips_when_trimmed_or_not_applicable(tmp_path, monkeypatch):
    m = extras_models(tmp_path, trimmed=1.0, asr_is_file=False)
    report = {}
    w.d0_extras({"model_puts": {"asr": "https://u/asr", "codec": ""}}, Rep(), m, report)
    e = report["load_options"]
    assert "already the trimmed load" in e["codec_trimmed_error"]
    assert "asr_nemo_unpack_s" not in e and "asr_bytes" not in e and "codec_bytes" not in e  # dir is no file; no codec url


def test_d0_extras_records_failures_without_raising(nemo_stack, tmp_path, monkeypatch):
    m = extras_models(tmp_path)
    monkeypatch.setattr(w, "load_codec_trimmed", lambda cls, path: (_ for _ in ()).throw(RuntimeError("no trim")))
    monkeypatch.setattr(tarfile, "open", lambda *a, **k: (_ for _ in ()).throw(OSError("bad tar")))
    monkeypatch.setattr(w.urllib.request, "urlopen", lambda req, timeout: (_ for _ in ()).throw(OSError("put refused")))
    report = {}
    w.d0_extras({"model_puts": {"asr": "https://u/a"}}, Rep(), m, report)
    e = report["load_options"]
    assert e["codec_trimmed_error"] == "no trim" and e["asr_unpack_error"] == "bad tar" and e["asr_upload_error"] == "put refused"


# ── job context and reporting ─────────────────────────────────────────────────────────────
def fake_files(monkeypatch, files):
    def fake_open(path, *a, **k):
        if path in files:
            return io.StringIO(files[path])
        raise FileNotFoundError(path)

    monkeypatch.setattr(w, "open", fake_open, raising=False)


def test_job_context_reads_install_markers_and_hardware(monkeypatch):
    fake_files(monkeypatch, {"/tmp/t0": "100.5\n", "/tmp/t_install": "160.5", "/tmp/install.rc": "0\n",
                             "/proc/cpuinfo": "processor: 0\nmodel name\t: Fake CPU\n", "/proc/meminfo": "MemTotal:  16000 kB\nMemFree: 1 kB\n"})
    monkeypatch.setenv("HEARTH_JOB_NAME", "job-x")
    ctx = w.job_context()
    assert ctx["t0"] == 100.5 and ctx["t_install"] == 160.5 and ctx["install_rc"] == 0
    assert ctx["cpu_model"] == "Fake CPU" and ctx["mem_total_kb"] == 16000 and ctx["nebius_job_hint"] == "job-x"
    assert ctx["ffmpeg"] and ctx["python"]


def test_job_context_survives_missing_files_and_empty_rc(monkeypatch):
    fake_files(monkeypatch, {"/tmp/install.rc": "\n"})
    ctx = w.job_context()
    assert ctx["install_rc"] == 0 and "t0" not in ctx and "cpu_model" not in ctx


def test_job_context_ffmpeg_lookup_failure_is_ignored(monkeypatch):
    import shutil
    monkeypatch.setattr(shutil, "which", lambda n: (_ for _ in ()).throw(RuntimeError("x")))
    fake_files(monkeypatch, {})
    assert "ffmpeg" not in w.job_context()


def test_versions_reports_modules_and_freeze_hash(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(__version__="2.0"))
    monkeypatch.delitem(sys.modules, "lightning", raising=False)
    out = w.versions()
    assert out["torch"] == "2.0" and "nemo" in out
    assert out["freeze_count"] == len(out["freeze"]) and len(out["freeze_sha256"]) == 64


def test_versions_without_importlib_metadata(monkeypatch):
    import importlib.metadata as md
    monkeypatch.setattr(md, "distributions", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    out = w.versions()
    assert "freeze" not in out


def test_install_tail(monkeypatch):
    fake_files(monkeypatch, {"/tmp/install.log": "x" * 5000 + "END"})
    assert len(w.install_tail()) == 4000 and w.install_tail().endswith("END")
    fake_files(monkeypatch, {})
    assert w.install_tail() == ""


def test_reporter_status_puts_and_swallows_failures(monkeypatch):
    sent = []
    monkeypatch.setattr(w, "put_json", lambda target, value: sent.append((target, value)))
    r = w.Reporter({"status_put": "S"})
    r.status("note", note="n1")
    assert sent[0][0] == "S" and sent[0][1]["stage"] == "note" and sent[0][1]["note"] == "n1" and sent[0][1]["rss_mb"] > 0
    monkeypatch.setattr(w, "put_json", lambda target, value: (_ for _ in ()).throw(OSError("x")))
    r.status("again")
    assert "status PUT failed: x" in w.LOG[-1]


def test_tick_posts_empty_body_once_and_tolerates_failure(monkeypatch):
    seen = []
    monkeypatch.setattr(w, "http", lambda method, url, data, headers, tries: seen.append((method, url, data, headers, tries)))
    w.tick({})
    w.tick({"tick_url": "https://t"})
    assert seen == [("POST", "https://t", b"", {"Content-Length": "0"}, 3)]
    monkeypatch.setattr(w, "http", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("nope")))
    w.tick({"tick_url": "https://t"})
    assert "tick failed: nope" in w.LOG[-1]


# ── main ──────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def main_env(monkeypatch):
    rec = types.SimpleNamespace(results=[], statuses=[], ticks=[], modes=[])
    monkeypatch.setattr(w, "put_json", lambda target, value: rec.results.append((target, value)))

    class R:
        def __init__(self, manifest):
            pass

        def status(self, stage, **kw):
            rec.statuses.append(stage)

    monkeypatch.setattr(w, "Reporter", R)
    monkeypatch.setattr(w, "tick", lambda manifest: rec.ticks.append(manifest))
    monkeypatch.setattr(w, "job_context", lambda: {"install_rc": 0})
    monkeypatch.setattr(w, "versions", lambda: {"v": 1})

    class M:
        timings = {"download_s": 1}
        runtime = {"r": 1}

        def __init__(self, weights, trimmed_codec, asr):
            rec.modes.append((weights, trimmed_codec, asr))

    monkeypatch.setattr(w, "Models", M)
    monkeypatch.delenv("MODE", raising=False)
    monkeypatch.setattr(sys, "argv", ["worker.py"])
    return rec


def test_main_prefetch_flag(monkeypatch):
    monkeypatch.setattr(w, "prefetch_main", lambda: 0)
    monkeypatch.setattr(sys, "argv", ["worker.py", "--prefetch"])
    assert w.main() == 0


def test_main_without_a_manifest_exits_2(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["worker.py"])
    monkeypatch.setattr(w, "load_manifest", lambda: (_ for _ in ()).throw(OSError("none")))
    assert w.main() == 2


@pytest.mark.parametrize("mode,fn", [("keep", "run_keep"), ("decode", "run_decode")])
def test_main_runs_the_selected_mode(main_env, monkeypatch, mode, fn):
    monkeypatch.setattr(w, "load_manifest", lambda: {"mode": mode, "result_put": "RES", "job": "j", "weights": {"w": 1}, "trimmed_codec": True})
    monkeypatch.setattr(w, fn, lambda manifest, rep, m: {"notes": [{"id": "n"}]})
    assert w.main() == 0
    target, report = main_env.results[-1]
    assert target == "RES" and report["status"] == "done" and report["notes"] == [{"id": "n"}] and report["mode"] == mode
    assert report["load"]["download_s"] == 1 and report["runtime"] == {"r": 1} and report["versions"] == {"v": 1}
    assert main_env.modes == [({"w": 1}, True, mode != "decode")] and main_env.statuses == ["loading", "loaded", "done"]
    assert main_env.ticks


def test_main_d0_mode_from_env_override(main_env, monkeypatch):
    monkeypatch.setenv("MODE", "d0")
    monkeypatch.setattr(w, "load_manifest", lambda: {"mode": "keep", "result_put": "RES"})
    called = []
    monkeypatch.setattr(w, "run_d0", lambda manifest, rep, m, report: called.append(report["mode"]))
    assert w.main() == 0 and called == ["d0"]


def test_main_reports_a_failed_install(main_env, monkeypatch):
    monkeypatch.setattr(w, "load_manifest", lambda: {"result_put": "RES"})
    monkeypatch.setattr(w, "job_context", lambda: {"install_rc": 1})
    monkeypatch.setattr(w, "install_tail", lambda: "pip said no")
    assert w.main() == 1
    report = main_env.results[-1][1]
    assert report["status"] == "failed" and "dependency install failed" in report["error"] and report["install_tail"] == "pip said no"
    assert main_env.statuses == ["failed"] and main_env.modes == []


def test_main_survives_result_put_failure(main_env, monkeypatch):
    monkeypatch.setattr(w, "load_manifest", lambda: {"result_put": "RES"})
    monkeypatch.setattr(w, "run_keep", lambda manifest, rep, m: {})
    monkeypatch.setattr(w, "put_json", lambda target, value: (_ for _ in ()).throw(OSError("S3 down")))
    assert w.main() == 0
    assert "result PUT failed: S3 down" in w.LOG[-1] and main_env.ticks
