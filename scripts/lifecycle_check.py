#!/usr/bin/env python3
"""Read the bucket's expiry rules and CORS from the real bucket (read-only).

    python3 scripts/lifecycle_check.py      # -> evidence/bucket-lifecycle.json

The 7-day expiry of anonymous spaces and the 1-day cache expiry are bucket rules, not app code; this records what the
bucket itself reports, as XML, so the claim can be checked against the store rather than against our own description.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from s3 import S3, load_env  # noqa: E402


def rules(xml: str) -> list[dict]:
    out = []
    for r in re.findall(r"<Rule>(.*?)</Rule>", xml, re.S):
        def one(tag: str) -> str | None:
            m = re.search(rf"<{tag}>(.*?)</{tag}>", r, re.S)
            return m.group(1) if m else None
        out.append({"id": one("ID"), "status": one("Status"), "prefix": one("Prefix"), "days": one("Days"),
                    "tag": re.findall(r"<Tag><Key>(.*?)</Key><Value>(.*?)</Value></Tag>", r)})
    return out


def main() -> int:
    load_env("~/.config/faultline/local.env", "~/.config/hearth/hearth.env")
    s3 = S3.from_env()
    st, _, body = s3.request("GET", "", query={"lifecycle": ""})
    text = body.decode(errors="replace")
    st_c, _, cors = s3.request("GET", "", query={"cors": ""})
    out = {"at": datetime.now(timezone.utc).isoformat(), "bucket": s3.bucket, "endpoint": s3.endpoint,
           "lifecycle": {"status": st, "rules": rules(text), "response": text[:2000]},
           "cors": {"status": st_c, "response": cors.decode(errors="replace")[:1200]}}
    path = ROOT / "evidence" / "bucket-lifecycle.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out["lifecycle"]["rules"], indent=1), "lifecycle", st, "cors", st_c)
    return 0 if st == 200 and out["lifecycle"]["rules"] else 1


if __name__ == "__main__":
    sys.exit(main())
