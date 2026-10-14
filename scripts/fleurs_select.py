#!/usr/bin/env python3
"""Select the FLEURS hi_in benchmark clips deterministically.

Rule (written before any clip was heard or scored):
  * rows of the FLEURS `hi_in` TEST split (google/fleurs, pinned revision below),
  * sorted by (sentence id as an integer, file name),
  * duration 4-20 s (num_samples / 16000),
  * at most one row per sentence id, so no sentence is counted twice,
  * the first 20 rows  -> bench/fleurs20.tsv   (the measured set),
  * the next 20 rows   -> bench/fleurs20b.tsv  (the disjoint set that re-checks DRIFT_GATE; never used to tune it),
  * the remaining rows, in the same order and excluding every sentence id above, are concatenated
    into one note and a batch of four more (bench/fleurs-long.tsv), each closing before it would pass
    300 s (v1 rejects notes over 5 minutes), for the memory/windowing checks of the D0 harness.

Usage:
  python3 scripts/fleurs_select.py test.tsv          # writes the three TSVs into bench/
The audio is CC BY 4.0 (see bench/LICENSE-DATA.md); this script only reads the transcript TSV.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
SAMPLE_RATE = 16_000
MIN_S, MAX_S = 4.0, 20.0
LONG_NOTE_S = 300.0
LONG_NOTES = 5  # one 5-min note + a batch of four 5-min notes

HEADER = ["id", "file", "duration_s", "gender", "raw_transcription", "transcription"]


def read_rows(tsv: Path) -> list[dict]:
    rows = []
    with tsv.open(encoding="utf-8", newline="") as fh:
        for rec in csv.reader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(rec) != 7:
                raise ValueError(f"unexpected FLEURS row with {len(rec)} fields: {rec[:2]}")
            sid, fname, raw, norm, _phonemes, n, gender = rec
            rows.append(
                {
                    "id": int(sid),
                    "file": fname,
                    "duration_s": int(n) / SAMPLE_RATE,
                    "gender": gender,
                    "raw_transcription": raw,
                    "transcription": norm,
                }
            )
    rows.sort(key=lambda r: (r["id"], r["file"]))
    return rows


def select(rows: list[dict]) -> tuple[list[dict], list[dict], list[list[dict]]]:
    picked: list[dict] = []
    seen: set[int] = set()
    for r in rows:
        if not (MIN_S <= r["duration_s"] <= MAX_S) or r["id"] in seen:
            continue
        picked.append(r)
        seen.add(r["id"])
        if len(picked) == 40:
            break
    if len(picked) < 40:
        raise ValueError(f"only {len(picked)} eligible rows; need 40")
    a, b = picked[:20], picked[20:]
    used_ids = {r["id"] for r in picked}

    longs: list[list[dict]] = []
    current: list[dict] = []
    total = 0.0
    for r in rows:
        if r["id"] in used_ids:
            continue
        # v1 rejects notes over 5 minutes, so a long note closes before it would pass 300 s.
        if total + r["duration_s"] > LONG_NOTE_S:
            longs.append(current)
            current, total = [], 0.0
            if len(longs) == LONG_NOTES:
                break
        current.append(r)
        total += r["duration_s"]
    if len(longs) < LONG_NOTES:
        raise ValueError(f"only {len(longs)} long notes could be built")
    return a, b, longs


def fmt(r: dict) -> list[str]:
    return [str(r["id"]), r["file"], f"{r['duration_s']:.3f}", r["gender"], r["raw_transcription"], r["transcription"]]


def write(path: Path, rows: list[dict], extra: list[str] | None = None) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\", lineterminator="\n")
        w.writerow((extra or []) + HEADER)
        for r in rows:
            w.writerow(([r["_note"]] if extra else []) + fmt(r))


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    rows = read_rows(Path(sys.argv[1]))
    a, b, longs = select(rows)
    bench = Path(__file__).resolve().parent.parent / "bench"
    bench.mkdir(exist_ok=True)
    write(bench / "fleurs20.tsv", a)
    write(bench / "fleurs20b.tsv", b)
    flat = []
    for i, note in enumerate(longs):
        for r in note:
            flat.append({**r, "_note": f"long{i + 1}"})
    write(bench / "fleurs-long.tsv", flat, extra=["note"])
    dur = lambda rs: sum(r["duration_s"] for r in rs)  # noqa: E731
    print(f"fleurs20: {len(a)} clips, {dur(a):.1f} s · fleurs20b: {len(b)} clips, {dur(b):.1f} s")
    for i, note in enumerate(longs):
        print(f"long{i + 1}: {len(note)} rows, {dur(note):.1f} s")
    print(f"FLEURS revision {REVISION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
