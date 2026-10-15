#!/usr/bin/env python3
"""The storage guarantees every lock and merge in Hearth relies on, checked against the real bucket.

    python3 scripts/storage_preflight.py      # -> evidence/storage-preflight.json

1. PUT with If-None-Match: * on an existing key is refused (412): the dispatch lock, queue claims, the spend
   meter's first write and the daily counters depend on it.
2. PUT with a stale If-Match is refused (412), and with the current ETag it succeeds: memory.json merges, note
   claims and finalize claims depend on it.
3. Bucket versioning is off, so a DELETE is final and HEAD 404 means the bytes are gone, not hidden.
4. A DELETE is followed by HEAD 404.
Uses a scratch key under sys/preflight/ and deletes it.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from s3 import S3, load_env  # noqa: E402


def main() -> int:
    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    s3 = S3.from_env()
    key = f"sys/preflight/{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out: dict = {"at": datetime.now(timezone.utc).isoformat(), "bucket": s3.bucket, "endpoint": s3.endpoint, "checks": {}}
    st, h, _ = s3.request("PUT", key, b'{"v":1}', headers={"If-None-Match": "*", "Content-Type": "application/json"})
    etag1 = (h.get("ETag") or h.get("Etag") or "").strip()
    out["checks"]["create_if_none_match"] = {"status": st, "pass": st == 200}
    st, _, _ = s3.request("PUT", key, b'{"v":2}', headers={"If-None-Match": "*", "Content-Type": "application/json"})
    out["checks"]["second_create_refused"] = {"status": st, "pass": st == 412}
    st, h, _ = s3.request("PUT", key, b'{"v":3}', headers={"If-Match": etag1, "Content-Type": "application/json"})
    etag3 = (h.get("ETag") or h.get("Etag") or "").strip()
    out["checks"]["if_match_current_accepted"] = {"status": st, "pass": st == 200}
    st, _, _ = s3.request("PUT", key, b'{"v":4}', headers={"If-Match": etag1, "Content-Type": "application/json"})
    out["checks"]["if_match_stale_refused"] = {"status": st, "pass": st == 412}
    out["checks"]["content_after"] = {"body": (s3.get(key) or b"").decode(), "pass": (s3.get(key) or b"") == b'{"v":3}'}
    st, _, body = s3.request("GET", "", query={"versioning": ""})
    text = body.decode(errors="replace")
    enabled = "<Status>Enabled</Status>" in text
    out["checks"]["versioning_off"] = {"status": st, "pass": st == 200 and not enabled, "response": text[:300]}
    st_del = s3.delete(key)
    st_head = s3.head(key)
    out["checks"]["delete_then_head_404"] = {"delete": st_del, "head": st_head, "pass": st_head == 404}
    out["etags"] = [etag1, etag3]
    out["all_pass"] = all(c["pass"] for c in out["checks"].values())
    dest = ROOT / "evidence" / "storage-preflight.json"
    dest.write_text(json.dumps(out, indent=1))
    for name, c in out["checks"].items():
        print(f"{'PASS' if c['pass'] else 'FAIL'}  {name}  {({k: v for k, v in c.items() if k not in ('pass', 'response', 'body')})}")
    print(f"-> {dest.relative_to(ROOT)}")
    return 0 if out["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
