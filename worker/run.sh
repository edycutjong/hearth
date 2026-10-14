#!/bin/bash
# Job entrypoint. Records when the container started and when dependencies were ready, then always starts
# the worker: if the install failed, worker.py (stdlib-only at import) reports that through its status URL.
date +%s.%N > /tmp/t0
if [ -z "${HEARTH_PREBUILT:-}" ]; then
  {
    pip install --no-cache-dir --quiet uv &&
    uv pip install --system --no-cache --index-strategy unsafe-best-match \
      --extra-index-url https://download.pytorch.org/whl/cpu -r /opt/hearth/requirements.txt
  } > /tmp/install.log 2>&1
  echo $? > /tmp/install.rc
fi
date +%s.%N > /tmp/t_install
export HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false
exec python3 /opt/hearth/worker.py
