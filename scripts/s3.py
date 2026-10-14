"""Minimal S3 SigV4 client for Nebius Object Storage, stdlib only (scripts and harnesses; the app has its own in TS).

Presigned URLs sign `host` plus any headers passed in `signed_headers` (Hearth signs `x-amz-tagging`, so a
PUT through the URL must carry exactly that tag). Requests sign with the bucket's S3 access key from the env:
NEBIUS_S3_ACCESS_KEY_ID, NEBIUS_S3_SECRET_ACCESS_KEY, HEARTH_BUCKET, optional NEBIUS_S3_ENDPOINT / NEBIUS_REGION.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

ALGO = "AWS4-HMAC-SHA256"


def _enc(value: str, slash: bool = True) -> str:
    out = urllib.parse.quote(value, safe="-_.~")
    return out if slash else out.replace("%2F", "/")


def _sign_key(secret: str, day: str, region: str, service: str = "s3") -> bytes:
    k = hmac.new(f"AWS4{secret}".encode(), day.encode(), hashlib.sha256).digest()
    for part in (region, service, "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    return k


@dataclass
class S3:
    endpoint: str
    region: str
    bucket: str
    access_key: str
    secret_key: str

    @classmethod
    def from_env(cls) -> "S3":
        region = os.environ.get("NEBIUS_REGION", "eu-west1")
        return cls(
            endpoint=os.environ.get("NEBIUS_S3_ENDPOINT", f"https://storage.{region}.nebius.cloud").rstrip("/"),
            region=region,
            bucket=os.environ["HEARTH_BUCKET"],
            access_key=os.environ["NEBIUS_S3_ACCESS_KEY_ID"],
            secret_key=os.environ["NEBIUS_S3_SECRET_ACCESS_KEY"],
        )

    def _path(self, key: str) -> str:
        return f"/{self.bucket}/{key.lstrip('/')}"

    def presign(self, method: str, key: str, expires: int = 3600, signed_headers: dict | None = None,
                now: _dt.datetime | None = None) -> str:
        now = now or _dt.datetime.now(_dt.timezone.utc)
        amz = now.strftime("%Y%m%dT%H%M%SZ")
        day = amz[:8]
        host = urllib.parse.urlparse(self.endpoint).netloc
        headers = {"host": host, **{k.lower(): str(v).strip() for k, v in (signed_headers or {}).items()}}
        names = sorted(headers)
        scope = f"{day}/{self.region}/s3/aws4_request"
        query = {
            "X-Amz-Algorithm": ALGO,
            "X-Amz-Credential": f"{self.access_key}/{scope}",
            "X-Amz-Date": amz,
            "X-Amz-Expires": str(max(1, min(604800, int(expires)))),
            "X-Amz-SignedHeaders": ";".join(names),
        }
        cq = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(query.items()))
        canon = "\n".join([method.upper(), _enc(self._path(key), slash=False), cq,
                           "".join(f"{n}:{headers[n]}\n" for n in names), ";".join(names), "UNSIGNED-PAYLOAD"])
        sts = "\n".join([ALGO, amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
        sig = hmac.new(_sign_key(self.secret_key, day, self.region), sts.encode(), hashlib.sha256).hexdigest()
        return f"{self.endpoint}{_enc(self._path(key), slash=False)}?{cq}&X-Amz-Signature={sig}"

    def request(self, method: str, key: str = "", body: bytes = b"", query: dict | None = None,
                headers: dict | None = None) -> tuple[int, dict, bytes]:
        now = _dt.datetime.now(_dt.timezone.utc)
        amz = now.strftime("%Y%m%dT%H%M%SZ")
        day = amz[:8]
        host = urllib.parse.urlparse(self.endpoint).netloc
        payload_hash = hashlib.sha256(body).hexdigest()
        hdrs = {"host": host, "x-amz-date": amz, "x-amz-content-sha256": payload_hash,
                **{k.lower(): str(v).strip() for k, v in (headers or {}).items()}}
        names = sorted(hdrs)
        q = query or {}
        cq = "&".join(f"{_enc(k)}={_enc(str(v))}" for k, v in sorted(q.items()))
        path = self._path(key) if key else f"/{self.bucket}"
        canon = "\n".join([method.upper(), _enc(path, slash=False), cq,
                           "".join(f"{n}:{hdrs[n]}\n" for n in names), ";".join(names), payload_hash])
        scope = f"{day}/{self.region}/s3/aws4_request"
        sts = "\n".join([ALGO, amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
        sig = hmac.new(_sign_key(self.secret_key, day, self.region), sts.encode(), hashlib.sha256).hexdigest()
        send = {k: v for k, v in hdrs.items() if k != "host"}
        send["Authorization"] = f"{ALGO} Credential={self.access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={sig}"
        url = f"{self.endpoint}{_enc(path, slash=False)}" + (f"?{cq}" if cq else "")
        req = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method, headers=send)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers or {}), err.read() if method != "HEAD" else b""

    # conveniences -----------------------------------------------------------------------------------
    def get(self, key: str) -> bytes | None:
        status, _, body = self.request("GET", key)
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"GET {key}: {status} {body[:200]!r}")
        return body

    def put(self, key: str, body: bytes, tagging: str | None = None, content_type: str | None = None) -> str:
        headers = {}
        if tagging:
            headers["x-amz-tagging"] = tagging
        if content_type:
            headers["content-type"] = content_type
        status, hdrs, resp = self.request("PUT", key, body, headers=headers)
        if status != 200:
            raise RuntimeError(f"PUT {key}: {status} {resp[:200]!r}")
        return hdrs.get("ETag", hdrs.get("etag", ""))

    def head(self, key: str) -> int:
        return self.request("HEAD", key)[0]

    def delete(self, key: str) -> int:
        return self.request("DELETE", key)[0]

    def list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token = None
        while True:
            q = {"list-type": "2", "prefix": prefix}
            if token:
                q["continuation-token"] = token
            status, _, body = self.request("GET", "", query=q)
            if status != 200:
                raise RuntimeError(f"LIST {prefix}: {status} {body[:200]!r}")
            xml = body.decode()
            keys += [_xml(k) for k in re.findall(r"<Key>([^<]*)</Key>", xml)]
            if "<IsTruncated>true</IsTruncated>" not in xml:
                return keys
            token = _xml(re.search(r"<NextContinuationToken>([^<]*)</NextContinuationToken>", xml).group(1))


def _xml(v: str) -> str:
    return re.sub(r"&(amp|lt|gt|quot|apos);", lambda m: {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}[m.group(1)], v)


def load_env(*paths: str) -> None:
    """KEY=VALUE files into os.environ (values never printed). Later files win."""
    for path in paths:
        path = os.path.expanduser(path)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                os.environ[k.strip()] = v
