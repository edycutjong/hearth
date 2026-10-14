"""SigV4 presign against AWS's published S3 query-string example (docs: "Authenticating Requests: Using Query
Parameters", GET /test.txt on examplebucket, 2013-05-24, 86400 s)."""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3 import S3  # noqa: E402


def test_presign_matches_aws_published_example():
    s3 = S3(endpoint="https://examplebucket.s3.amazonaws.com", region="us-east-1", bucket="",
            access_key="AKIAIOSFODNN7EXAMPLE", secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    # AWS's example is virtual-hosted (no bucket in the path); this client is path-style, so the bucket is
    # empty and the key carries the path.
    s3._path = lambda key: "/" + key  # type: ignore[method-assign]
    url = s3.presign("GET", "test.txt", 86400, now=dt.datetime(2013, 5, 24, tzinfo=dt.timezone.utc))
    assert url.endswith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")


def test_presign_signs_extra_headers():
    s3 = S3(endpoint="https://storage.eu-west1.nebius.cloud", region="eu-west1", bucket="b",
            access_key="AK", secret_key="SK")
    url = s3.presign("PUT", "raw/u/n.opus", 600, signed_headers={"x-amz-tagging": "space=anon"})
    assert "X-Amz-SignedHeaders=host%3Bx-amz-tagging" in url
    assert url.startswith("https://storage.eu-west1.nebius.cloud/b/raw/u/n.opus?")
