#!/usr/bin/env python3
"""Fail if judge-facing text still holds a placeholder or an illustrative number.

    python3 scripts/check_submission_readiness.py

Checks README.md, DEMO.md, ARCHITECTURE.md, FEEDBACK.md and ../submission/submission-text.md (when present) for
`[measured]`, `TBD`, `TODO`, `[x]%`, `—%`, `XX` placeholders, and for the spec's ILLUSTRATIVE dates (a Mon 12 Oct
anchor) unless the shipped sample's own memory carries them. Exit 1 lists every hit with file:line.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["README.md", "DEMO.md", "ARCHITECTURE.md", "FEEDBACK.md", "../submission/submission-text.md"]
PLACEHOLDERS = re.compile(r"\[measured\]|\bTBD\b|\bTODO\b|\[x\]\s*%|—\s*%|\bXX\b|\?\?\?|lorem ipsum", re.I)
ILLUSTRATIVE = ["Mon 12 Oct", "Sat 17 Oct", "Thu 15 Oct", "Fri 16 Oct", "Mon 19 Oct"]


def main() -> int:
    sample = (ROOT / "public" / "sample" / "sample.json").read_text()
    shipped = {d for d in ILLUSTRATIVE if d in sample}
    hits = []
    for rel in FILES:
        p = (ROOT / rel).resolve()
        if not p.exists():
            continue
        for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if PLACEHOLDERS.search(line):
                hits.append(f"{rel}:{n}: placeholder: {line.strip()[:120]}")
            for d in ILLUSTRATIVE:
                if d in line and d not in shipped:
                    hits.append(f"{rel}:{n}: illustrative date '{d}' not in the shipped sample: {line.strip()[:120]}")
    if hits:
        print("\n".join(hits))
        print(f"NOT READY: {len(hits)} finding(s)")
        return 1
    print("ready: no placeholders, no illustrative dates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
