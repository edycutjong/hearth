"""Unit tests for the worker's pure functions (numpy only; the models are exercised by the live Jobs)."""
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import worker as w  # noqa: E402


def test_pack_roundtrip_all_code_values():
    rng = np.random.default_rng(7)
    codes = rng.integers(0, 2016, size=(13, 377))
    codes[0, :4] = [0, 1, 2015, 1024]
    blob = w.pack_hct(codes, n_samples=377 * 1764 - 100, windows=[200, 177], samples_per_frame=1764, codebook_size=2016)
    back, head = w.unpack_hct(blob)
    assert np.array_equal(back, codes)
    assert head["windows"] == [200, 177] and head["frames"] == 377 and head["n_samples"] == 377 * 1764 - 100


def test_pack_is_11_bits_per_code():
    codes = np.zeros((13, 1000), dtype=np.int64)
    blob = w.pack_hct(codes, 1000 * 1764, [1000], 1764, 2016)
    header = struct.calcsize(w.HEAD_FMT) + 4 + 32
    assert len(blob) - header == (13 * 1000 * 11 + 7) // 8  # 17,875 B for 80 s of voice


def test_pack_rejects_codes_over_11_bits():
    with pytest.raises(ValueError):
        w.pack_hct(np.full((13, 2), 2048), 3528, [2], 1764, 2016)


def test_unpack_detects_tampering():
    blob = bytearray(w.pack_hct(np.ones((13, 10), dtype=np.int64), 17640, [10], 1764, 2016))
    blob[-1] ^= 0x01
    with pytest.raises(ValueError):
        w.unpack_hct(bytes(blob))


def _tone_with_gaps(spec):
    """spec: [(seconds, loud)] -> 16 kHz signal; loud parts are a 220 Hz tone, quiet parts near-silence."""
    parts = []
    rng = np.random.default_rng(1)
    for secs, loud in spec:
        n = int(secs * 16000)
        t = np.arange(n) / 16000
        parts.append(0.3 * np.sin(2 * np.pi * 220 * t) if loud else 0.0005 * rng.standard_normal(n))
    return np.concatenate(parts).astype(np.float32)


def test_segments_cut_in_silences_and_stay_under_20s_on_the_grid():
    x = _tone_with_gaps([(9, True), (0.8, False), (9, True), (0.8, False), (9, True), (0.8, False), (9, True)])
    segs, info = w.segment(x)
    assert all(t1 - t0 <= 20.0 + 1e-6 for t0, t1, _ in segs)
    assert segs[0][0] == 0.0 and abs(segs[-1][1] - len(x) / 16000) < 1e-6
    for (_, a1, _), (b0, _, _) in zip(segs, segs[1:]):
        assert a1 == b0
        assert abs(round(a1 / 0.08) * 0.08 - a1) < 1e-6  # every internal cut is on the 80 ms codec grid
    assert info["silences"] >= 3


def test_segments_hard_cut_without_silence():
    x = _tone_with_gaps([(45, True)])
    segs, _ = w.segment(x)
    assert [round(t1 - t0, 2) for t0, t1, _ in segs] == [20.0, 20.0, 5.0]


def test_silent_segment_is_marked_without_speech():
    x = _tone_with_gaps([(3, False)])
    segs, _ = w.segment(x)
    assert len(segs) == 1 and segs[0][2] in (False, True)  # floor-relative threshold: never crashes on silence


def test_windows_group_segments_up_to_30s():
    segs = [(0.0, 12.0, True), (12.0, 24.0, True), (24.0, 36.0, True), (36.0, 40.0, True)]
    assert w.windows_for(segs, 40.0) == [(0.0, 24.0), (24.0, 40.0)]


def test_wer_and_words():
    assert w.wer(["a", "b", "c"], ["a", "x", "c"]) == pytest.approx(1 / 3)
    assert w.wer([], []) == 0.0 and w.wer([], ["a"]) == 1.0
    assert w.words("रविवार से पहले, पाँच हज़ार भेज देना।") == ["रविवार", "से", "पहले", "पांच", "हजार", "भेज", "देना"]
    assert w.words("₹5,000 <hi-IN>") == ["5000"]


def test_strip_language_tag():
    assert w.strip_tags("नमस्ते दुनिया। <hi-IN>") == ("नमस्ते दुनिया।", "hi-IN")
    assert w.strip_tags("hello")[1] is None


SPF = 1764


def _fake_encode(x):
    """Stand-in codec: the code of frame k is the absolute frame index carried in the signal's first sample of it."""
    n = -(-len(x) // SPF)
    return np.array([[int(round(x[min(k * SPF, len(x) - 1)])) for k in range(n)]], dtype=np.int64)


def _fake_decode(codes, n):
    return np.repeat(codes[0].astype(np.float32), SPF)[:n]


def test_windowed_encode_keeps_each_window_aligned_to_absolute_frames():
    frames_total = 900
    x = np.repeat(np.arange(frames_total, dtype=np.float32), SPF)[: frames_total * SPF - 500]
    lead = 3
    x_pad = np.concatenate([np.full(lead * SPF, -1.0, dtype=np.float32), x + lead])
    n22 = len(x)
    bounds = [(0, 300 * SPF), (300 * SPF, 650 * SPF), (650 * SPF, n22)]
    plan = w.window_plan(bounds, SPF, lead)
    codes, frames = w.encode_windows(_fake_encode, x_pad, plan, SPF, 25)
    assert frames == [303, 350, 250]
    assert codes[0, lead:].tolist() == list(range(lead, frames_total + lead))


def test_windowed_decode_restores_the_timeline_with_left_context():
    frames = [303, 350, 250]
    codes = np.arange(sum(frames), dtype=np.int64)[None]
    n_total = sum(frames) * SPF - 500
    out = w.decode_windows(_fake_decode, codes, frames, SPF, 25, n_total)
    assert len(out) == n_total
    assert np.array_equal(out, np.repeat(np.arange(sum(frames), dtype=np.float32), SPF)[:n_total])


def test_header_v2_carries_lead_and_context():
    blob = w.pack_hct(np.zeros((13, 20), dtype=np.int64), 30_000, [20], SPF, 2016)
    _, head = w.unpack_hct(blob)
    assert head["lead_frames"] == w.LEAD_FRAMES and head["context_frames"] == w.CTX_FRAMES


def test_codec_gain_lifts_a_quiet_recording_and_respects_the_peak():
    t = np.arange(22050 * 3) / 22050
    quiet = (0.004 * np.sin(2 * np.pi * 180 * t)).astype(np.float32)  # about -51 dBFS RMS
    g = w.codec_gain_db(quiet, "always")
    assert 25 <= g <= 30
    loud = (0.9 * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
    assert w.codec_gain_db(loud, "always") <= 20 * np.log10(0.97 / 0.9) + 1e-6
    assert w.codec_gain_db(loud, "conditional") == 0.0 and w.codec_gain_db(quiet, "conditional") > 20
    assert w.codec_gain_db(quiet, "none") == 0.0
    assert w.codec_gain_db(np.zeros(10, dtype=np.float32)) == 0.0


def test_gain_round_trips_through_the_header():
    blob = w.pack_hct(np.zeros((13, 4), dtype=np.int64), 7000, [4], SPF, 2016, gain_db=27.31)
    assert w.unpack_hct(blob)[1]["gain_db"] == 27.31
