"""Nebius Serverless AI Jobs from the scripts, through the `nebius` CLI (the measuring harnesses run as the
operator; the deployed app creates its Jobs over REST with a service account, src/lib/nebius/jobs.ts).

Every create sets the timeout and disk size explicitly: the API's defaults are 24 h and 250 GiB.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
import re
import subprocess
import time
from pathlib import Path

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "ERROR", "DELETED"}
# All injected files are encrypted together; their base64 may not pass 64 KiB in total
# (evidence/injected-files-limit.json), so the worker and its requirements travel gzipped and run.sh unpacks them.
INJECTED_TOTAL_MAX_BASE64 = 64 * 1024
WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"


def worker_files(tmpdir: str) -> dict[str, str]:
    """{local path: container path} for a Job: run.sh as is, worker.py and requirements.txt gzipped (mtime 0, so
    the bytes are the same every time), exactly as the app injects them (src/lib/injected.ts)."""
    files = {str(WORKER_DIR / "run.sh"): "/opt/hearth/run.sh"}
    for name in ("worker.py", "requirements.txt"):
        dest = Path(tmpdir) / f"{name}.gz"
        dest.write_bytes(gzip.compress((WORKER_DIR / name).read_bytes(), compresslevel=9, mtime=0))
        files[str(dest)] = f"/opt/hearth/{name}.gz"
    return files


def _ids() -> tuple[str, str]:
    """Project and subnet of the Jobs, from the environment (never hard-coded in the repo)."""
    return os.environ["NEBIUS_PROJECT_ID"], os.environ["NEBIUS_SUBNET_ID"]


def _cli(args: list[str], timeout: int = 120) -> dict:
    out = subprocess.run(["nebius", *args, "--format", "json"], capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(f"nebius {' '.join(args[:3])} failed: {out.stderr.strip()[:800]}")
    text = out.stdout
    return json.loads(text[text.find("{"):]) if "{" in text else {}


def create_job(name: str, image: str, env: dict[str, str], files: dict[str, str], *, preset: str = "4vcpu-16gb",
               platform: str = "cpu-d3", timeout: str = "1h", disk: str = "64Gi",
               command: str = "bash", args: str = "/opt/hearth/run.sh") -> tuple[str, float]:
    """files: {local_path: container_path}. Returns (job id, create time as epoch seconds)."""
    project, subnet = _ids()
    cmd = ["ai", "job", "create", "--async", "--parent-id", project, "--subnet-id", subnet, "--name", name,
           "--image", image, "--platform", platform, "--preset", preset, "--timeout", timeout,
           "--disk-size", disk, "--container-command", command, "--args", args]
    for k, v in env.items():
        cmd += ["--env", f"{k}={v}"]
    total = 0
    for local, remote in files.items():
        size = os.path.getsize(local)
        if not 0 < size <= 64 * 1024:
            raise ValueError(f"{local} is {size} bytes; injected files must be 1 B - 64 KiB")
        total += len(base64.b64encode(Path(local).read_bytes()))
        cmd += ["--inject-file", f"{local}:{remote}"]
    if total > INJECTED_TOTAL_MAX_BASE64:
        raise ValueError(f"injected files total {total} bytes of base64; the API refuses more than {INJECTED_TOTAL_MAX_BASE64}")
    t = time.time()
    op = _cli(cmd)
    job_id = op.get("resource_id") or op.get("resourceId")
    if not job_id:
        raise RuntimeError(f"create returned no resource id: {json.dumps(op)[:500]}")
    return job_id, t


def get_job(job_id: str) -> dict:
    return redact(_cli(["ai", "job", "get", "--id", job_id]))


PRESIGNED = re.compile(r"(https://[^\s\"']+?)\?[^\s\"']*X-Amz-Signature=[0-9a-f]+")


def redact(value):
    """Drop the query of every presigned URL (it is a bearer credential for one key) before anything is saved."""
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return PRESIGNED.sub(r"\1?<presigned>", value)
    return value


def list_jobs() -> list[dict]:
    return _cli(["ai", "job", "list", "--parent-id", _ids()[0]]).get("items", [])


def running_jobs() -> list[dict]:
    return [j for j in list_jobs() if j.get("status", {}).get("state") not in TERMINAL]


def state(job: dict) -> str:
    return job.get("status", {}).get("state", "UNKNOWN")
