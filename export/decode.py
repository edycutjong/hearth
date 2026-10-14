#!/usr/bin/env python3
"""Play your kept voice notes without Hearth.

Every note in this export is a .hct file: NVIDIA NanoCodec (nemo-nano-codec-22khz-1.78kbps-12.5fps) codes,
13 codebooks x 12.5 frames per second, packed at 11 bits per code, with a header and a sha256 of the codes.
This script turns them back into .wav files with the same open model, on your own computer.

    python3 -m venv venv && . venv/bin/activate
    pip install "nemo_toolkit[asr]==3.0.0" soundfile einops    # CPU is fine
    python3 decode.py notes/*.hct                               # writes a .wav next to each .hct

The first run downloads the codec (about 420 MB) from Hugging Face. What you hear is NanoCodec's
reconstruction of the recording, not the original file.
"""
from __future__ import annotations

import hashlib
import struct
import sys
from pathlib import Path

HEAD_FMT = "<4sBBHIHHIIHHHh"
MODEL = "nvidia/nemo-nano-codec-22khz-1.78kbps-12.5fps"


def read_hct(path: Path):
    import numpy as np

    blob = path.read_bytes()
    magic, ver, n_cb, _cb, sr, spf, bits, frames, n_samples, n_win, lead, ctx, gain = struct.unpack_from(HEAD_FMT, blob)
    if magic != b"HCT1" or ver != 2 or bits != 11:
        raise ValueError(f"{path} is not a version-2 Hearth .hct file")
    off = struct.calcsize(HEAD_FMT)
    windows = list(struct.unpack_from(f"<{n_win}I", blob, off))
    off += 4 * n_win
    digest, payload = blob[off:off + 32], blob[off + 32:]
    if hashlib.sha256(payload).digest() != digest:
        raise ValueError(f"{path}: the codes do not match their sha256")
    n = n_cb * frames
    raw = np.unpackbits(np.frombuffer(payload, dtype=np.uint8), bitorder="little")[: n * 11]
    codes = (raw.reshape(n, 11).astype(np.int64) << np.arange(11)).sum(axis=1).reshape(frames, n_cb).T
    return codes, dict(sr=sr, spf=spf, n_samples=n_samples, windows=windows, lead=lead, ctx=ctx, gain_db=gain / 100)


def decode(model, codes, head):
    import numpy as np
    import torch

    spf, out, f0 = head["spf"], [], 0
    for f in head["windows"]:
        lo = max(0, f0 - head["ctx"])
        with torch.inference_mode():
            t = torch.from_numpy(codes[:, lo:f0 + f])[None]
            audio, _ = model.decode(tokens=t, tokens_len=torch.tensor([t.shape[2]]))
        out.append(audio[0].numpy()[(f0 - lo) * spf:(f0 + f - lo) * spf])
        f0 += f
    lead = head["lead"] * spf
    # The worker raised quiet recordings to a standard level before encoding; give the note its own level back.
    return np.concatenate(out)[lead:lead + head["n_samples"]] / (10 ** (head["gain_db"] / 20))


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 2
    import soundfile as sf
    from nemo.collections.tts.models import AudioCodecModel

    model = AudioCodecModel.from_pretrained(MODEL).eval()
    for p in map(Path, paths):
        codes, head = read_hct(p)
        audio = decode(model, codes, head)
        out = p.with_suffix(".wav")
        sf.write(out, audio, head["sr"])
        print(f"{p.name}: {len(audio) / head['sr']:.1f} s -> {out.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
