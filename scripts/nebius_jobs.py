"""Nebius Serverless AI Jobs from the scripts, through the `nebius` CLI (the measuring harnesses run as the
operator; the deployed app creates its Jobs over REST with a service account, src/lib/nebius/jobs.ts).

Every create sets the timeout and disk size explicitly: the API's defaults are 24 h and 250 GiB.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "ERROR", "DELETED"}


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
    for local, remote in files.items():
        size = os.path.getsize(local)
        if not 0 < size <= 64 * 1024:
            raise ValueError(f"{local} is {size} bytes; injected files must be 1 B - 64 KiB")
        cmd += ["--inject-file", f"{local}:{remote}"]
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
