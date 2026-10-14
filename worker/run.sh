#!/bin/bash
# Job entrypoint. Records when the container started and when dependencies were ready, then always starts
# the worker: if the install failed, worker.py (stdlib-only at import) reports that through its status URL.
# The worker and its pinned requirements arrive gzipped — the Jobs API caps ALL injected files at 64 KiB of
# base64 in total (evidence/injected-files-limit.json) — and are unpacked to /tmp/hearth (injected files are
# read-only). The model files stream in from the in-region bucket WHILE the dependencies install:
# `worker.py --prefetch` needs only the standard library, and the worker waits for it after its own imports.
date +%s.%N > /tmp/t0
mkdir -p /tmp/hearth
for f in worker.py requirements.txt; do
  if [ -f "/opt/hearth/$f.gz" ]; then gunzip -c "/opt/hearth/$f.gz" > "/tmp/hearth/$f"; else cp "/opt/hearth/$f" "/tmp/hearth/$f"; fi
done
touch /tmp/prefetch.started
python3 /tmp/hearth/worker.py --prefetch > /tmp/prefetch.log 2>&1 &
if [ -z "${HEARTH_PREBUILT:-}" ]; then
  {
    pip install --no-cache-dir --quiet uv==0.13.1 &&
    uv pip install --system --no-cache --index-strategy unsafe-best-match \
      --extra-index-url https://download.pytorch.org/whl/cpu -r /tmp/hearth/requirements.txt
  } > /tmp/install.log 2>&1
  echo $? > /tmp/install.rc
fi
date +%s.%N > /tmp/t_install
export HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false
exec python3 /tmp/hearth/worker.py
