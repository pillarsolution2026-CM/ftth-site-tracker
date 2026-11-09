"""`cad.render_view` against a real PostGIS and the fs storage (ADR-039)."""

from __future__ import annotations

import gzip
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
import pytest

from cad_worker.adapters.ezdxf_view import EzdxfViewRenderer
from cad_worker.adapters.job_message import CadRenderViewJob
from cad_worker.adapters.postgres_view_repo import PostgresViewRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.adapters.view_process import SubprocessViewRenderer
from cad_worker.application.ports import RenderOutput
from cad_worker.application.render_view import ViewDeps, run_render
from cad_worker.domain.extents import Extents
from tests.conftest import QueuedFile
from tests.support.dxf_samples import write_sample


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


def view_job(f: QueuedFile, job_id: uuid.UUID, attempt: int = 1) -> CadRenderViewJob:
    return CadRenderViewJob(
        id=job_id,
        type="cad.render_view",
        cadFileId=f.cad_file_id,
        projectId=f.project_id,
        attempt=attempt,
        enqueuedAt=datetime.now(UTC),
    )


def processed_file(
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
    *,
    fmt: str = "dxf",
    data: bytes | None = None,
    status: str = "processed",
    converted: bytes | None = None,
    write_object: bool = True,
) -> tuple[QueuedFile, uuid.UUID]:
    """A cad_files row in `status` with a queued view; returns the file and the view job id."""
    if data is None:
        data = write_sample(tmp_path / "s.dxf").read_bytes()
    f: QueuedFile = make_cad_file(data, fmt, storage_root, write_object=write_object)
    converted_key = None
    if converted is not None:
        converted_key = f"projects/{f.project_id}/cad/{f.cad_file_id}/converted.dxf"
        (storage_root / converted_key).write_bytes(converted)
    view_job_id = uuid.uuid4()
    db.execute(
        "UPDATE cad_files SET status = %s, converted_storage_key = %s, "
        "extents_min_x = 0, extents_min_y = 0, extents_max_x = 300, extents_max_y = 400, "
        "view_status = 'queued', view_queued_at = now(), view_job_id = %s WHERE id = %s",
        (status, converted_key, view_job_id, f.cad_file_id),
    )
    return f, view_job_id


def view_row(db: psycopg.Connection[Any], f: QueuedFile) -> dict[str, Any]:
    cur = db.execute(
        "SELECT view_status, view_storage_key, view_size_bytes, view_error_code, "
        "view_rendered_at FROM cad_files WHERE id = %s",
        (f.cad_file_id,),
    )
    row = cur.fetchone()
    assert row is not None
    names = ("status", "key", "size", "error", "rendered_at")
    return dict(zip(names, row, strict=True))


def view_events(db: psycopg.Connection[Any], f: QueuedFile) -> list[tuple[str, dict[str, Any]]]:
    rows = db.execute(
        "SELECT type, payload FROM events WHERE entity = 'cad_file' AND entity_id = %s "
        "AND type LIKE 'cad_file.view_%%' ORDER BY id",
        (str(f.cad_file_id),),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def view_key(f: QueuedFile, job_id: uuid.UUID) -> str:
    return f"projects/{f.project_id}/cad/{f.cad_file_id}/view-{job_id}.json.gz"


def views_in_storage(root: Path, f: QueuedFile) -> list[str]:
    folder = root / f"projects/{f.project_id}/cad/{f.cad_file_id}"
    return sorted(p.name for p in folder.glob("view*"))


def deps_for(database_url: str, root: Path, **overrides: Any) -> ViewDeps:
    base: dict[str, Any] = {
        "repo": PostgresViewRepository(database_url),
        "storage": FsStorage(root),
        "renderer": EzdxfViewRenderer(),
    }
    return ViewDeps(**{**base, **overrides})


def test_view_is_rendered_stored_and_ready(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f, job_id = processed_file(db, make_cad_file, storage_root, tmp_path)
    assert run_render(view_job(f, job_id), deps_for(database_url, storage_root), "w1") == "ready"

    row = view_row(db, f)
    key = view_key(f, job_id)  # one object per job (security review L2)
    stored = storage_root / key
    assert (row["status"], row["key"], row["error"]) == ("ready", key, None)
    assert row["size"] == stored.stat().st_size and row["rendered_at"] is not None
    data = json.loads(gzip.decompress(stored.read_bytes()))
    assert data["version"] == 1 and data["cadFileId"] == str(f.cad_file_id)
    assert len({e["handle"] for e in data["entities"]}) == len(data["entities"])
    assert any(e["kind"] == "INSERT" for e in data["entities"])
    events = view_events(db, f)
    assert [e[0] for e in events] == ["cad_file.view_rendered"]
    payload = events[0][1]
    assert payload["jobId"] == str(job_id) and payload["sizeBytes"] == row["size"]
    assert payload["stats"]["entities"] > 0 and payload["stats"]["truncated"] is False
    assert payload["stats"]["jsonBytes"] > row["size"]


def test_a_new_render_gets_its_own_key(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f, first = processed_file(db, make_cad_file, storage_root, tmp_path)
    deps = deps_for(database_url, storage_root)
    assert run_render(view_job(f, first), deps, "w1") == "ready"
    second = uuid.uuid4()
    db.execute(
        "UPDATE cad_files SET view_status = 'queued', view_queued_at = now(), view_job_id = %s WHERE id = %s",
        (second, f.cad_file_id),
    )
    assert run_render(view_job(f, second), deps, "w1") == "ready"
    assert view_row(db, f)["key"] == view_key(f, second)
    assert (storage_root / view_key(f, first)).is_file()  # the served file is never rewritten


def test_converted_dxf_of_a_dwg_is_drawn(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    dxf = write_sample(tmp_path / "s.dxf").read_bytes()
    f, job_id = processed_file(
        db, make_cad_file, storage_root, tmp_path, fmt="dwg", data=b"DWG", converted=dxf
    )
    assert run_render(view_job(f, job_id), deps_for(database_url, storage_root), "w1") == "ready"
    assert view_row(db, f)["status"] == "ready"


def test_stale_job_is_dropped_without_writing(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f, job_id = processed_file(db, make_cad_file, storage_root, tmp_path)
    deps = deps_for(database_url, storage_root)
    assert run_render(view_job(f, uuid.uuid4()), deps, "w1") == "superseded"
    assert view_row(db, f)["status"] == "queued"
    assert views_in_storage(storage_root, f) == []
    assert view_events(db, f) == []
    # the current job, then a redelivery of it after `ready`: dropped too
    assert run_render(view_job(f, job_id), deps, "w1") == "ready"
    assert run_render(view_job(f, job_id, attempt=2), deps, "w1") == "superseded"
    assert [e[0] for e in view_events(db, f)] == ["cad_file.view_rendered"]


class SupersedingRenderer:
    """Renders, then a newer view job is queued (as POST …/view would) before the upload."""

    def __init__(self, database_url: str, file_id: uuid.UUID) -> None:
        self._inner = EzdxfViewRenderer()
        self._url = database_url
        self._file_id = file_id

    def render_to(
        self, dxf: Path, out: Path, cad_file_id: str, extents: Extents | None
    ) -> RenderOutput:
        output = self._inner.render_to(dxf, out, cad_file_id, extents)
        with psycopg.connect(self._url, autocommit=True) as conn:
            conn.execute(
                "UPDATE cad_files SET view_job_id = %s WHERE id = %s",
                (uuid.uuid4(), self._file_id),
            )
        return output


def test_job_superseded_while_rendering_deletes_its_upload(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f, job_id = processed_file(db, make_cad_file, storage_root, tmp_path)
    deps = deps_for(
        database_url, storage_root, renderer=SupersedingRenderer(database_url, f.cad_file_id)
    )
    assert run_render(view_job(f, job_id), deps, "w1") == "superseded"
    assert view_row(db, f)["status"] == "queued"
    assert views_in_storage(storage_root, f) == []  # uploaded, then deleted (best effort)
    assert view_events(db, f) == []


def test_row_locked_by_another_transaction_times_out_instead_of_hanging(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f, job_id = processed_file(db, make_cad_file, storage_root, tmp_path)
    with psycopg.connect(database_url) as other:
        other.execute("SELECT 1 FROM cad_files WHERE id = %s FOR UPDATE", (f.cad_file_id,))
        with pytest.raises(psycopg.errors.LockNotAvailable):
            run_render(view_job(f, job_id), deps_for(database_url, storage_root), "w1")
        other.rollback()
    assert view_row(db, f)["status"] == "queued"  # redelivered later (ADR-013)


@pytest.mark.parametrize(
    ("case", "code"),
    [
        ("not_processed", "FILE_NOT_PROCESSED"),
        ("dwg_not_converted", "FILE_NOT_PROCESSED"),
        ("missing", "FILE_MISSING"),
        ("unreadable", "READ_FAILED"),
        ("too_large", "TOO_LARGE"),
        ("timeout", "TIMEOUT"),
    ],
)
def test_failures_are_recorded_with_a_code(
    case: str,
    code: str,
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    cases: dict[str, dict[str, Any]] = {
        "not_processed": {"status": "queued"},
        "dwg_not_converted": {"fmt": "dwg", "data": b"DWG"},
        "missing": {"write_object": False},
        "unreadable": {"data": b"\x00\x01 not a dxf"},
        "too_large": {},
        "timeout": {},
    }
    kwargs = cases[case]
    f, job_id = processed_file(db, make_cad_file, storage_root, tmp_path, **kwargs)
    db.execute(
        "UPDATE cad_files SET view_storage_key = 'old', view_size_bytes = 1 WHERE id = %s",
        (f.cad_file_id,),
    )
    renderers: dict[str, Any] = {
        "too_large": EzdxfViewRenderer(max_json_bytes=10),
        "timeout": SubprocessViewRenderer(timeout_s=0.01),
    }
    deps = deps_for(database_url, storage_root, renderer=renderers.get(case, EzdxfViewRenderer()))
    assert run_render(view_job(f, job_id), deps, "w1") == "failed"
    row = view_row(db, f)
    assert (row["status"], row["error"], row["key"], row["size"]) == ("failed", code, None, None)
    events = view_events(db, f)
    assert [(e[0], e[1]["errorCode"]) for e in events] == [("cad_file.view_failed", code)]
    assert views_in_storage(storage_root, f) == []
    # a failed view is final for this job: a redelivery is dropped
    assert run_render(view_job(f, job_id, attempt=2), deps, "w1") == "superseded"
