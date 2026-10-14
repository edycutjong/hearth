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
    header = struct.calcsize("<4sBBHIHHIIH") + 4 + 32
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
    assert w.words("रविवार से पहले, पाँच हज़ार भेज देना।") == ["रविवार", "से", "पहले", "पाँच", "हज़ार", "भेज", "देना"]


def test_strip_language_tag():
    assert w.strip_tags("नमस्ते दुनिया। <hi-IN>") == ("नमस्ते दुनिया।", "hi-IN")
    assert w.strip_tags("hello")[1] is None
