#!/usr/bin/env bash
# Fetch the selected FLEURS hi_in test clips, build the long notes, and upload both to the bucket.
#
#   scripts/fleurs_prepare.sh <workdir>
#
# Needs: curl, tar, ffmpeg, python3, and the AWS CLI with the bucket's S3 keys in the environment
# (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) plus HEARTH_BUCKET. Reads bench/{fleurs20,fleurs20b,fleurs-long}.tsv
# (written by scripts/fleurs_select.py) and writes bench/fleurs-files.sha256, the integrity list of every
# uploaded object. The tarball is streamed: only the selected files ever touch the disk.
set -euo pipefail

WORK="${1:?usage: fleurs_prepare.sh <workdir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REV=70bb2e84b976b7e960aa89f1c648e09c59f894dd
URL="https://huggingface.co/datasets/google/fleurs/resolve/$REV/data/hi_in/audio/test.tar.gz"
ENDPOINT="${NEBIUS_S3_ENDPOINT:-https://storage.eu-west1.nebius.cloud}"
BUCKET="${HEARTH_BUCKET:?set HEARTH_BUCKET}"

mkdir -p "$WORK/wav" "$WORK/long"
python3 - "$ROOT/bench" "$WORK" <<'PY'
import csv, sys, pathlib
bench, work = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
want, longs = set(), {}
for name in ("fleurs20.tsv", "fleurs20b.tsv", "fleurs-long.tsv"):
    with (bench / name).open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\"):
            want.add(row["file"])
            if "note" in row:
                longs.setdefault(row["note"], []).append(row["file"])
(work / "want.txt").write_text("".join(f"test/{f}\n" for f in sorted(want)))
for note, files in longs.items():
    (work / f"{note}.txt").write_text("".join(f"file '{work}/wav/test/{f}'\n" for f in files))
PY

if [ "$(find "$WORK/wav/test" -name '*.wav' 2>/dev/null | wc -l | tr -d ' ')" -lt "$(wc -l < "$WORK/want.txt" | tr -d ' ')" ]; then
  curl -sSL "$URL" | tar -xzf - -C "$WORK/wav" -T "$WORK/want.txt"
fi

# Long notes: the rows of each note, in order, as one 16 kHz mono FLAC (lossless container for the upload).
for list in "$WORK"/long*.txt; do
  note="$(basename "$list" .txt)"
  ffmpeg -nostdin -loglevel error -y -f concat -safe 0 -i "$list" -ac 1 -ar 16000 -sample_fmt s16 "$WORK/long/$note.flac"
done

: > "$ROOT/bench/fleurs-files.sha256"
upload() { # local path, key
  aws --endpoint-url "$ENDPOINT" s3 cp --only-show-errors "$1" "s3://$BUCKET/$2"
  printf '%s  %s\n' "$(shasum -a 256 "$1" | cut -d' ' -f1)" "$2" >> "$ROOT/bench/fleurs-files.sha256"
}
for f in $(sed 's#^test/##' "$WORK/want.txt"); do
  if grep -q "$f" "$ROOT/bench/fleurs20.tsv" "$ROOT/bench/fleurs20b.tsv"; then upload "$WORK/wav/test/$f" "bench/fleurs/hi_in/$f"; fi
done
for f in "$WORK"/long/*.flac; do upload "$f" "bench/fleurs/long/$(basename "$f")"; done
sort -k2 -o "$ROOT/bench/fleurs-files.sha256" "$ROOT/bench/fleurs-files.sha256"
echo "uploaded $(wc -l < "$ROOT/bench/fleurs-files.sha256" | tr -d ' ') objects to s3://$BUCKET/bench/fleurs/"
