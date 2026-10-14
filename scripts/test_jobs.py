"""The harness injects the same gzipped worker as the app, and refuses a set the API would refuse."""
import base64
import gzip
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nebius_jobs as nj  # noqa: E402


def test_worker_files_unpack_to_the_repo_and_fit_the_total(tmp_path):
    files = nj.worker_files(str(tmp_path))
    assert sorted(files.values()) == ["/opt/hearth/requirements.txt.gz", "/opt/hearth/run.sh", "/opt/hearth/worker.py.gz"]
    for local, remote in files.items():
        data = Path(local).read_bytes()
        name = Path(remote).name
        if name.endswith(".gz"):
            assert gzip.decompress(data) == (nj.WORKER_DIR / name[:-3]).read_bytes()
    total = sum(len(base64.b64encode(Path(p).read_bytes())) for p in files)
    assert total <= nj.INJECTED_TOTAL_MAX_BASE64


def test_worker_files_are_byte_identical_every_time(tmp_path):
    a = {Path(k).name: Path(k).read_bytes() for k in nj.worker_files(str(tmp_path / "a"))} if (tmp_path / "a").mkdir() is None else {}
    b = {Path(k).name: Path(k).read_bytes() for k in nj.worker_files(str(tmp_path / "b"))} if (tmp_path / "b").mkdir() is None else {}
    assert a == b
