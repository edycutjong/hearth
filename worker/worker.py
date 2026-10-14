#!/usr/bin/env python3
"""Hearth worker: runs inside a Nebius Serverless AI Job on cpu-d3.

MODE (env, default "keep"):
  keep    for every note in the manifest: load audio -> silence-split into <=20 s segments -> ASR
          (nvidia/nemotron-3.5-asr-streaming-0.6b, LangID hi-IN, att_context_size [56,13] = the card's 1.12 s
          setting) -> NanoCodec encode per <=30 s window -> 11-bit pack -> .hct -> decode -> ASR again on the
          same segment offsets -> drift. PUTs the .hct, transcript, a decoded wav for playback and a per-note
          result; then the job result, then an empty POST to the tick URL.
  decode  for every .hct in the manifest: unpack -> decode -> PUT the decoded wav (the playback cache).
  d0      the D0 harness: the keep pipeline over the benchmark clips plus codec determinism and memory
          checks. Reports hypotheses and timings; WER against references is computed off the box
          (scripts/d0_report.py) so the normaliser lives in one place.

The manifest comes from MANIFEST_URL (a presigned GET) or the injected file /opt/hearth/manifest.json.
No credential ever enters the job: every read and write is a presigned URL, and deleting anything is
the app's job, not this one's.

Top-level imports are stdlib only, so a failed dependency install is still reported through the status
URL instead of dying silently (Jobs expose no logs over REST).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import resource
import struct
import sys
import tempfile
import time
import traceback
import unicodedata
import urllib.request
import wave

T_WORKER = time.time()
ASR_REPO = "nvidia/nemotron-3.5-asr-streaming-0.6b"
ASR_FILE = "nemotron-3.5-asr-streaming-0.6b.nemo"
CODEC_REPO = "nvidia/nemo-nano-codec-22khz-1.78kbps-12.5fps"
CODEC_FILE = "nemo-nano-codec-22khz-1.78kbps-12.5fps.nemo"
ATT_CONTEXT = [56, 13]  # 14 x 80 ms = the 1.12 s operating point (card: hi-IN WER 6.81)
ASR_SR = 16_000
CODEC_SR = 22_050
GRID_S = 0.08  # 1,764 samples at 22.05 kHz = one codec frame; 1,280 samples at 16 kHz
MAX_SEG_S = 20.0
MAX_WIN_S = 30.0
MAX_NOTE_S = 300.0
BITS = 11
MAGIC = b"HCT1"
LOG: list[str] = []


def log(msg: str) -> None:
    line = f"{time.time() - T_WORKER:8.1f}s {msg}"
    LOG.append(line)
    del LOG[:-300]
    print(line, flush=True)


# ---------------------------------------------------------------- presigned I/O (stdlib)

def http(method: str, url: str, data: bytes | None = None, headers: dict | None = None, tries: int = 4) -> bytes:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
            with urllib.request.urlopen(req, timeout=300) as res:
                return res.read()
        except Exception as exc:  # network blips are retried; a 4xx on the last try is raised
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{method} failed after {tries} tries: {last}")


def put(target, body: bytes) -> None:
    """A manifest PUT target is a URL string or {"url", "headers"} (headers the URL was signed with)."""
    if not target:
        return
    url, headers = (target, {}) if isinstance(target, str) else (target["url"], target.get("headers", {}))
    http("PUT", url, body, headers)


def put_json(target, value) -> None:
    put(target, json.dumps(value, ensure_ascii=False, indent=1).encode())


def load_manifest() -> dict:
    url = os.environ.get("MANIFEST_URL", "")
    if url:
        return json.loads(http("GET", url))
    with open(os.environ.get("MANIFEST_PATH", "/opt/hearth/manifest.json"), encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------- text (mirrors scripts/textnorm.py)

PUNCT = re.compile(r"[।॥.,!?;:\"'()\[\]{}<>«»“”‘’…\-–—/\\|*_#@%&+=~`^]")
LANG_TAG = re.compile(r"<([a-z]{2,3}-[A-Z]{2})>")


def strip_tags(text: str) -> tuple[str, str | None]:
    tags = LANG_TAG.findall(text)
    return LANG_TAG.sub(" ", text).strip(), (tags[-1] if tags else None)


def words(text: str) -> list[str]:
    t = unicodedata.normalize("NFC", text).lower()
    return PUNCT.sub(" ", t).split()


def wer(ref: list[str], hyp: list[str]) -> float:
    """Word error rate by Levenshtein over word lists. Empty reference: 0 if both empty, else 1."""
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1] / len(ref)


# ---------------------------------------------------------------- .hct: 11-bit packed NanoCodec codes

def pack_hct(codes, n_samples: int, windows: list[int], samples_per_frame: int, codebook_size: int) -> bytes:
    """codes: int array [n_codebooks, T]. Frame-major, 11 bits per code, little-endian bit order."""
    import numpy as np

    c = np.asarray(codes, dtype=np.int64)
    n_cb, t = c.shape
    if c.size and (c.min() < 0 or c.max() >= (1 << BITS)):
        raise ValueError("code out of 11-bit range")
    flat = c.T.reshape(-1).astype(np.uint32)
    bits = ((flat[:, None] >> np.arange(BITS, dtype=np.uint32)) & 1).astype(np.uint8).reshape(-1)
    payload = np.packbits(bits, bitorder="little").tobytes()
    head = struct.pack("<4sBBHIHHIIH", MAGIC, 1, n_cb, codebook_size, CODEC_SR, samples_per_frame, BITS,
                       t, n_samples, len(windows))
    head += struct.pack(f"<{len(windows)}I", *windows)
    return head + hashlib.sha256(payload).digest() + payload


def unpack_hct(blob: bytes):
    import numpy as np

    fixed = struct.calcsize("<4sBBHIHHIIH")
    magic, ver, n_cb, cb_size, sr, spf, bits, t, n_samples, n_win = struct.unpack_from("<4sBBHIHHIIH", blob)
    if magic != MAGIC or ver != 1 or bits != BITS:
        raise ValueError("not a version-1 .hct file")
    windows = list(struct.unpack_from(f"<{n_win}I", blob, fixed))
    off = fixed + 4 * n_win
    digest, payload = blob[off:off + 32], blob[off + 32:]
    if hashlib.sha256(payload).digest() != digest:
        raise ValueError(".hct payload does not match its sha256")
    n = n_cb * t
    raw = np.unpackbits(np.frombuffer(payload, dtype=np.uint8), bitorder="little")[: n * BITS]
    vals = (raw.reshape(n, BITS).astype(np.int64) << np.arange(BITS)).sum(axis=1)
    codes = vals.reshape(t, n_cb).T
    return codes, {"n_codebooks": n_cb, "codebook_size": cb_size, "sample_rate": sr, "samples_per_frame": spf,
                   "frames": t, "n_samples": n_samples, "windows": windows}


# ---------------------------------------------------------------- audio

def load_audio(blob: bytes, ext: str):
    """Mono float32 at the file's own rate. soundfile (libsndfile: wav, flac, ogg/opus, mp3) first, ffmpeg next."""
    import numpy as np
    import soundfile as sf

    try:
        x, sr = sf.read(io.BytesIO(blob), dtype="float32", always_2d=True)
        return x.mean(axis=1).astype(np.float32), int(sr)
    except Exception:
        import subprocess

        with tempfile.NamedTemporaryFile(suffix=f".{ext or 'bin'}") as src:
            src.write(blob)
            src.flush()
            out = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", src.name, "-ac", "1",
                                  "-ar", str(CODEC_SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
        return np.frombuffer(out, dtype=np.float32).copy(), CODEC_SR


def resample(x, sr_in: int, sr_out: int):
    import librosa
    import numpy as np

    if sr_in == sr_out:
        return x.astype(np.float32)
    return librosa.resample(x, orig_sr=sr_in, target_sr=sr_out, res_type="soxr_hq").astype(np.float32)


def segment(x16, max_seg: float = MAX_SEG_S) -> tuple[list[tuple[float, float, bool]], dict]:
    """Silence-split 16 kHz audio into segments of <= max_seg seconds on the 80 ms codec grid.

    Threshold = the note's noise floor (10th percentile of 25 ms frame energy) + 12 dB, or -30 dBFS when the
    floor is undefined, and never closer than 20 dB below the note's loud level (95th percentile): a note with
    no pauses has no noise floor, and floor + 12 dB would then call the speech itself silence.
    Cuts go in the middle of silences of >= 0.4 s; with none in reach, a hard cut at max_seg.
    Returns [(t0, t1, has_speech)], plus the threshold actually used.
    """
    import numpy as np

    dur = len(x16) / ASR_SR
    hop, win = 160, 400
    n = max(1, 1 + (len(x16) - win) // hop) if len(x16) >= win else 1
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x16, (0, max(0, win - len(x16)))), win)[::hop][:n]
    db = 20 * np.log10(np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1)) + 1e-10)
    floor, loud = float(np.percentile(db, 10)), float(np.percentile(db, 95))
    thr = min(floor + 12 if np.isfinite(floor) and floor > -100 else -30.0, loud - 20)
    silent = db < thr
    cuts: list[float] = []
    run = 0
    for i, s in enumerate(list(silent) + [False]):
        if s:
            run += 1
            continue
        if run >= 40:  # 0.4 s
            cuts.append(((i - run) + i) / 2 * hop / ASR_SR)
        run = 0

    def snap(t: float) -> float:
        return round(round(t / GRID_S) * GRID_S, 2)

    segs: list[tuple[float, float, bool]] = []
    start = 0.0
    while start < dur - 1e-6:
        if dur - start <= max_seg:
            end = dur
        else:
            reach = [c for c in cuts if start + 1.0 < c <= start + max_seg]
            end = min(snap(max(reach)) if reach else snap(start + max_seg), round(start + max_seg, 2))
        a, b = int(start * 100), int(end * 100)
        speech = bool((~silent[a:max(a + 1, b)]).any())
        segs.append((round(start, 2), round(end, 2), speech))
        start = end
    return segs, {"floor_db": round(floor, 1), "loud_db": round(loud, 1), "threshold_db": round(thr, 1),
                  "silences": len(cuts)}


def windows_for(segs: list[tuple[float, float, bool]], dur: float) -> list[tuple[float, float]]:
    """Group consecutive segments into codec windows of <= 30 s; boundaries stay on the 80 ms grid."""
    wins: list[tuple[float, float]] = []
    w0 = 0.0
    for t0, t1, _ in segs:
        if t1 - w0 > MAX_WIN_S and t0 > w0:
            wins.append((w0, t0))
            w0 = t0
    wins.append((w0, dur))
    return wins


def wav_bytes(x, sr: int) -> bytes:
    import numpy as np

    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0  # Linux: KiB


# ---------------------------------------------------------------- models

class Models:
    def __init__(self) -> None:
        import torch

        torch.set_num_threads(os.cpu_count() or 4)
        from huggingface_hub import hf_hub_download

        self.timings: dict[str, float] = {}
        t = time.time()
        asr_path = hf_hub_download(ASR_REPO, ASR_FILE)
        codec_path = hf_hub_download(CODEC_REPO, CODEC_FILE)
        self.timings["download_s"] = round(time.time() - t, 2)
        log(f"weights downloaded in {self.timings['download_s']} s")

        t = time.time()
        import nemo.collections.asr as nemo_asr

        self.timings["asr_import_s"] = round(time.time() - t, 2)
        t = time.time()
        self.asr = nemo_asr.models.ASRModel.restore_from(restore_path=asr_path, map_location="cpu").eval()
        self.asr.encoder.set_default_att_context_size(ATT_CONTEXT)
        self.timings["asr_restore_s"] = round(time.time() - t, 2)
        t = time.time()
        from nemo.collections.tts.models import AudioCodecModel

        self.timings["codec_import_s"] = round(time.time() - t, 2)
        t = time.time()
        self.codec = AudioCodecModel.restore_from(restore_path=codec_path, map_location="cpu").eval()
        self.timings["codec_restore_s"] = round(time.time() - t, 2)
        self.asr_sr = int(self.asr.cfg.preprocessor.get("sample_rate", ASR_SR))
        self.spf = int(getattr(self.codec, "samples_per_frame", 1764))
        self.cb_size = int(getattr(getattr(self.codec, "vector_quantizer", None), "codebook_size", 2016) or 2016)
        enc = self.asr.encoder
        self.runtime = {
            "asr": "nemo", "asr_class": type(self.asr).__name__, "att_context_size": list(enc.att_context_size),
            "att_context_size_all": [list(a) for a in getattr(enc, "att_context_size_all", []) or []],
            "chunk_s": round((ATT_CONTEXT[1] + 1) * 0.08, 2), "codec_samples_per_frame": self.spf,
            "codec_sample_rate": int(self.codec.sample_rate), "asr_sample_rate": self.asr_sr,
            "torch_threads": torch.get_num_threads(),
        }
        log(f"models loaded: {self.timings} {self.runtime}")

    def transcribe(self, clips: list, lang: str) -> list[str]:
        """clips: 16 kHz float32 arrays, passed as arrays (NeMo's file-path route builds Lhotse cuts with no
        language, so the prompt-conditioned model rejects them). Sorted by length so a batch pads little;
        returned in input order."""
        if not clips:
            return []
        order = sorted(range(len(clips)), key=lambda i: len(clips[i]))
        batch = [resample(clips[i], ASR_SR, self.asr_sr) for i in order]
        res = self.asr.transcribe(batch, batch_size=4, target_lang=lang, verbose=False)
        if isinstance(res, tuple):
            res = res[0]
        out: list[str] = [""] * len(clips)
        for k, i in enumerate(order):
            h = res[k]
            out[i] = h.text if hasattr(h, "text") else str(h)
        return out

    def encode(self, x22):
        import torch

        with torch.inference_mode():
            a = torch.from_numpy(x22)[None]
            tokens, tlen = self.codec.encode(audio=a, audio_len=torch.tensor([a.shape[1]]))
        return tokens[0, :, : int(tlen[0])].cpu().numpy()

    def decode(self, codes, n_samples: int):
        import torch

        with torch.inference_mode():
            t = torch.from_numpy(codes.astype("int64"))[None]
            audio, _ = self.codec.decode(tokens=t, tokens_len=torch.tensor([t.shape[2]]))
        return audio[0].cpu().numpy()[:n_samples].astype("float32")


# ---------------------------------------------------------------- the keep pipeline

def keep_note(m: Models, blob: bytes, ext: str, lang: str, lang_check: bool = True) -> dict:
    """One note end to end. Returns the result plus the artefacts ({hct, transcript, wav}) to upload."""
    import numpy as np

    tm: dict[str, float] = {}
    t = time.time()
    x, sr = load_audio(blob, ext)
    dur = len(x) / sr
    if dur <= 0.3:
        raise ValueError("no audio in this file")
    if dur > MAX_NOTE_S + 0.5:
        raise ValueError(f"note is {dur:.0f} s; v1 keeps notes up to 5 min")
    x16, x22 = resample(x, sr, ASR_SR), resample(x, sr, CODEC_SR)
    tm["load_s"] = time.time() - t

    t = time.time()
    segs, seginfo = segment(x16)
    tm["segment_s"] = time.time() - t

    def cut(arr, rate, a, b):
        return arr[int(round(a * rate)): int(round(b * rate))]

    lang_detected = None
    t = time.time()
    if lang_check:
        first = next((s for s in segs if s[2]), segs[0])
        _, lang_detected = strip_tags(m.transcribe([cut(x16, ASR_SR, first[0], first[1])], "auto")[0])
    tm["lang_check_s"] = time.time() - t

    t = time.time()
    speech = [i for i, s in enumerate(segs) if s[2]]
    hyps = m.transcribe([cut(x16, ASR_SR, segs[i][0], segs[i][1]) for i in speech], lang)
    text = {i: strip_tags(h)[0] for i, h in zip(speech, hyps)}
    tm["asr_s"] = time.time() - t

    wins = windows_for(segs, dur)
    n22 = len(x22)
    t = time.time()
    parts, frames_per_win, bounds = [], [], []
    for w0, w1 in wins:
        a, b = int(round(w0 * CODEC_SR)), (n22 if w1 >= dur else int(round(w1 * CODEC_SR)))
        codes = m.encode(np.ascontiguousarray(x22[a:b]))
        parts.append(codes)
        frames_per_win.append(int(codes.shape[1]))
        bounds.append((a, b))
    codes_all = np.concatenate(parts, axis=1)
    tm["encode_s"] = time.time() - t

    t = time.time()
    hct = pack_hct(codes_all, n22, frames_per_win, m.spf, m.cb_size)
    tm["pack_s"] = time.time() - t

    t = time.time()
    dec = np.concatenate([m.decode(c, b - a) for c, (a, b) in zip(parts, bounds)])
    tm["decode_s"] = time.time() - t

    t = time.time()
    dec16 = resample(dec, CODEC_SR, ASR_SR)
    rt_h = m.transcribe([cut(dec16, ASR_SR, segs[i][0], segs[i][1]) for i in speech], lang)
    rt = {i: strip_tags(h)[0] for i, h in zip(speech, rt_h)}
    tm["rt_asr_s"] = time.time() - t

    seg_out, all_o, all_r = [], [], []
    for i, (t0, t1, sp) in enumerate(segs):
        wo, wr = words(text.get(i, "")), words(rt.get(i, ""))
        all_o += wo
        all_r += wr
        seg_out.append({"i": i, "t0": t0, "t1": t1, "speech": sp, "text": text.get(i, ""), "rt_text": rt.get(i, ""),
                        "words": len(wo), "drift": round(wer(wo, wr), 4) if sp else None})
    drift = round(wer(all_o, all_r), 4)
    long_seg = [s["drift"] for s in seg_out if s["words"] >= 8 and s["drift"] is not None]
    transcript = {"version": 1, "lang": lang, "lang_detected": lang_detected, "duration_s": round(dur, 3),
                  "runtime": dict(m.runtime), "segments": [{k: s[k] for k in ("i", "t0", "t1", "text")} for s in seg_out]}
    result = {
        "audio_s": round(dur, 3), "input_bytes": len(blob), "input_sample_rate": sr, "bytes_hct": len(hct),
        "sha256_hct": hashlib.sha256(hct).hexdigest(), "frames": int(codes_all.shape[1]), "windows": frames_per_win,
        "segments": seg_out, "segmentation": seginfo, "drift_note": drift,
        "max_drift_long_segment": max(long_seg) if long_seg else None, "lang_detected": lang_detected,
        "timings": {k: round(v, 3) for k, v in tm.items()}, "peak_rss_mb": round(rss_mb(), 1),
    }
    return {"result": result, "hct": hct, "transcript": transcript, "wav": wav_bytes(dec, CODEC_SR)}


# ---------------------------------------------------------------- job context and reporting

def job_context() -> dict:
    ctx = {"python": platform.python_version(), "machine": platform.machine(), "cpus": os.cpu_count(),
           "worker_start": T_WORKER, "nebius_job_hint": os.environ.get("HEARTH_JOB_NAME", "")}
    for name in ("t0", "t_install"):
        try:
            with open(f"/tmp/{name}") as fh:
                ctx[name] = float(fh.read().strip())
        except Exception:
            pass
    try:
        with open("/tmp/install.rc") as fh:
            ctx["install_rc"] = int(fh.read().strip() or "0")
    except Exception:
        pass
    try:
        with open("/proc/cpuinfo") as fh:
            ctx["cpu_model"] = next((ln.split(":", 1)[1].strip() for ln in fh if ln.startswith("model name")), "")
        with open("/proc/meminfo") as fh:
            ctx["mem_total_kb"] = int(next(ln.split()[1] for ln in fh if ln.startswith("MemTotal")))
    except Exception:
        pass
    return ctx


def versions() -> dict:
    out = {}
    for mod in ("torch", "nemo", "transformers", "numpy", "librosa", "soundfile", "huggingface_hub", "lightning"):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:
            out[mod] = None
    try:
        from importlib import metadata

        frozen = sorted(f"{d.metadata['Name']}=={d.version}" for d in metadata.distributions())
        out["freeze_sha256"] = hashlib.sha256("\n".join(frozen).encode()).hexdigest()
        out["freeze_count"] = len(frozen)
    except Exception:
        pass
    return out


def install_tail() -> str:
    try:
        with open("/tmp/install.log", encoding="utf-8", errors="replace") as fh:
            return fh.read()[-4000:]
    except Exception:
        return ""


class Reporter:
    def __init__(self, manifest: dict) -> None:
        self.manifest = manifest
        self.status_url = manifest.get("status_put")

    def status(self, stage: str, **extra) -> None:
        try:
            put_json(self.status_url, {"stage": stage, "t": time.time(), "elapsed_s": round(time.time() - T_WORKER, 1),
                                       "rss_mb": round(rss_mb(), 1), "log": LOG[-60:], **extra})
        except Exception as exc:
            log(f"status PUT failed: {exc}")


def tick(manifest: dict) -> None:
    url = manifest.get("tick_url")
    if url:
        try:
            http("POST", url, b"", {"Content-Length": "0"}, tries=3)
        except Exception as exc:
            log(f"tick failed: {exc}")


# ---------------------------------------------------------------- modes

def run_keep(manifest: dict, rep: Reporter, m: Models) -> dict:
    lang = manifest.get("lang", "hi-IN")
    notes_out = []
    for note in manifest["notes"]:
        rep.status("note", note=note["id"])
        entry = {"id": note["id"]}
        try:
            blob = http("GET", note["get"])
            out = keep_note(m, blob, note.get("ext", ""), lang)
            put(note["put"]["hct"], out["hct"])
            put_json(note["put"]["transcript"], {**out["transcript"], "note": note["id"]})
            put(note["put"].get("wav"), out["wav"])
            entry.update(out["result"])
            entry["status"] = "processed"
        except Exception as exc:
            entry.update({"status": "failed", "error": str(exc)[:500], "trace": traceback.format_exc()[-1500:]})
            log(f"note {note['id']} failed: {exc}")
        entry["job"] = manifest.get("job")
        put_json(note["put"].get("result"), entry)
        notes_out.append(entry)
    return {"notes": notes_out}


def run_decode(manifest: dict, rep: Reporter, m: Models) -> dict:
    import numpy as np

    notes_out = []
    for note in manifest["notes"]:
        rep.status("decode", note=note["id"])
        entry = {"id": note["id"]}
        try:
            t = time.time()
            codes, head = unpack_hct(http("GET", note["hct_get"]))
            pieces, f0, s0 = [], 0, 0
            for k, f in enumerate(head["windows"]):
                n = f * head["samples_per_frame"] if k < len(head["windows"]) - 1 else head["n_samples"] - s0
                pieces.append(m.decode(codes[:, f0:f0 + f], n))
                f0, s0 = f0 + f, s0 + n
            audio = np.concatenate(pieces)
            put(note["put"]["wav"], wav_bytes(audio, CODEC_SR))
            entry.update({"status": "decoded", "audio_s": round(len(audio) / CODEC_SR, 3),
                          "decode_s": round(time.time() - t, 3)})
        except Exception as exc:
            entry.update({"status": "failed", "error": str(exc)[:500]})
        notes_out.append(entry)
    return {"notes": notes_out}


def run_d0(manifest: dict, rep: Reporter, m: Models, report: dict) -> dict:
    """Clips in manifest order; partial results are PUT after every item so a timeout still leaves data."""
    import numpy as np

    lang = manifest.get("lang", "hi-IN")
    soft_deadline = T_WORKER + float(manifest.get("soft_deadline_s", 85 * 60))
    items = []
    report["items"] = items
    first_audio = None
    for k, note in enumerate(manifest["notes"]):
        if time.time() > soft_deadline:
            items.append({"id": note["id"], "set": note.get("set"), "status": "skipped_deadline"})
            continue
        rep.status("d0", item=note["id"], k=k, n=len(manifest["notes"]))
        entry = {"id": note["id"], "set": note.get("set")}
        rss_before = rss_mb()
        t = time.time()
        try:
            blob = http("GET", note["get"])
            entry["get_s"] = round(time.time() - t, 3)
            out = keep_note(m, blob, note.get("ext", ""), lang)
            if first_audio is None:
                first_audio = time.time()
                report["first_audio_done"] = first_audio
            entry.update(out["result"])
            entry["status"] = "processed"
            entry["rss_before_mb"] = round(rss_before, 1)
            if note.get("put", {}).get("hct"):
                put(note["put"]["hct"], out["hct"])
            if "determinism" not in report and note.get("set") in ("fleurs20", "fleurs20b"):
                # codec determinism on CPU, on the first short clip: same input twice, same codes? same samples?
                x, sr = load_audio(blob, note.get("ext", ""))
                x22 = resample(x, sr, CODEC_SR)
                c1, c2 = m.encode(x22), m.encode(x22)
                d1, d2 = m.decode(c1, len(x22)), m.decode(c1, len(x22))
                stored, _ = unpack_hct(out["hct"])
                report["determinism"] = {
                    "encode_twice_equal": bool(np.array_equal(c1, c2)),
                    "hct_roundtrip_equals_fresh_encode": bool(stored.shape == c1.shape and np.array_equal(stored, c1)),
                    "decode_twice_max_abs_diff": float(np.abs(d1 - d2).max()),
                }
        except Exception as exc:
            entry.update({"status": "failed", "error": str(exc)[:500], "trace": traceback.format_exc()[-2000:]})
            log(f"item {note['id']} failed: {exc}")
        entry["wall_s"] = round(time.time() - t, 3)
        items.append(entry)
        report["peak_rss_mb"] = round(rss_mb(), 1)
        put_json(manifest["result_put"], report)
    return report


def main() -> int:
    manifest: dict = {}
    report: dict = {"version": 1, "context": job_context()}
    try:
        manifest = load_manifest()
    except Exception as exc:
        log(f"no manifest: {exc}")
        return 2
    mode = os.environ.get("MODE", manifest.get("mode", "keep"))
    report.update({"mode": mode, "job": manifest.get("job")})
    rep = Reporter(manifest)
    try:
        if report["context"].get("install_rc", 0) != 0:
            raise RuntimeError("dependency install failed (see install_tail)")
        rep.status("loading")
        t = time.time()
        m = Models()
        report["load"] = {**m.timings, "total_s": round(time.time() - t, 2)}
        report["runtime"] = m.runtime
        report["versions"] = versions()
        rep.status("loaded", load=report["load"])
        if mode == "d0":
            run_d0(manifest, rep, m, report)
        elif mode == "decode":
            report.update(run_decode(manifest, rep, m))
        else:
            report.update(run_keep(manifest, rep, m))
        report["status"] = "done"
    except Exception as exc:
        report.update({"status": "failed", "error": str(exc)[:800], "trace": traceback.format_exc()[-3000:],
                       "install_tail": install_tail()})
        log(f"job failed: {exc}")
    report["peak_rss_mb"] = round(rss_mb(), 1)
    report["finished"] = time.time()
    report["log"] = LOG[-120:]
    try:
        put_json(manifest.get("result_put"), report)
    except Exception as exc:
        log(f"result PUT failed: {exc}")
    rep.status(report["status"])
    tick(manifest)
    return 0 if report["status"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
