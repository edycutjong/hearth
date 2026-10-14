#!/usr/bin/env python3
"""Pin worker/requirements.txt to the environment a measured Job actually ran.

    python3 scripts/pin_requirements.py bench/results/d0-<run>-raw.json        # rewrite worker/requirements.txt
    python3 scripts/pin_requirements.py bench/results/d0-<run>-raw.json --check  # exit 1 if the file differs

The worker reports `pip freeze` (versions.freeze) from inside the Job. Every package in it is pinned exactly, so a
product Job installs the same versions the benchmark of record measured, whatever PyPI publishes later. The
installer's own tools (pip, setuptools, wheel, uv) come from the image and run.sh, and are not pinned here.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQ = ROOT / "worker" / "requirements.txt"
INSTALLER = {"pip", "setuptools", "wheel", "uv"}


def pinned(raw: dict) -> tuple[str, list[str]]:
    report = raw.get("report") or {}
    freeze = (report.get("versions") or {}).get("freeze")
    if not freeze:
        raise SystemExit("this report carries no pip freeze (runs before 2026-10-15 06:19 WIB did not record it)")
    lines = sorted((ln for ln in freeze if ln.split("==")[0].lower() not in INSTALLER), key=str.lower)
    head = (
        "# Hearth worker dependencies, pinned to the environment the benchmark of record ran:\n"
        f"# D0 run {raw.get('run')}, Nebius job {raw.get('nebius_job_id')} (scripts/pin_requirements.py).\n"
        "# torch comes from the PyTorch CPU index (no CUDA wheels on a CPU job). nemo_toolkit[asr] carries both NVIDIA\n"
        "# models' runtime; the codec (nemo.collections.tts) needs only the pure-Python half of the [tts] extra, so\n"
        "# pyopenjtalk and nemo_text_processing are absent on purpose (Japanese G2P and TTS text normalisation, never\n"
        "# called; pyopenjtalk has no wheel and would compile at every cold start).\n"
    )
    return head, lines


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    raw = json.loads(Path(sys.argv[1]).read_text())
    head, lines = pinned(raw)
    text = head + "\n".join(lines) + "\n"
    if "--check" in sys.argv:
        same = REQ.read_text() == text
        print("requirements match the measured environment" if same else "worker/requirements.txt differs from the measured freeze")
        return 0 if same else 1
    if len(text.encode()) > 64 * 1024:
        raise SystemExit("pinned requirements exceed the 64 KiB injected-file limit")
    REQ.write_text(text)
    print(f"pinned {len(lines)} packages from {Path(sys.argv[1]).name} -> {REQ.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
