"""DrawingViewRepository on PostgreSQL (ADR-039, `cad_files.view_*`, migration 0016).

Every read and write is guarded by `cad_files.view_job_id` and `view_status = 'queued'`
(ADR-013): a job that is no longer the file's view job writes nothing. `project_id` is part of
every query. Events (`cad_file.view_rendered` / `cad_file.view_failed`) have no actor.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from cad_worker.adapters.job_message import CadRenderViewJob
from cad_worker.application.ports import ViewFailureCode, ViewInputs, ViewResult
from cad_worker.domain.extents import Extents

START_SQL = """
SELECT status, format, storage_key, converted_storage_key,
  extents_min_x, extents_min_y, extents_max_x, extents_max_y
FROM cad_files
WHERE id = %s AND project_id = %s AND view_job_id = %s AND view_status = 'queued'
"""
LOCK_SQL = """
SELECT 1 FROM cad_files
WHERE id = %s AND project_id = %s AND view_job_id = %s AND view_status = 'queued'
FOR UPDATE
"""
READY_SQL = """
UPDATE cad_files SET view_status = 'ready', view_storage_key = %s, view_size_bytes = %s,
  view_rendered_at = now(), view_error_code = NULL
WHERE id = %s AND project_id = %s AND view_job_id = %s AND view_status = 'queued'
"""
FAIL_SQL = """
UPDATE cad_files SET view_status = 'failed', view_error_code = %s, view_storage_key = NULL,
  view_size_bytes = NULL, view_rendered_at = NULL
WHERE id = %s AND project_id = %s AND view_job_id = %s AND view_status = 'queued'
"""
ERROR_MESSAGE_LIMIT = 2000


def _event(
    conn: psycopg.Connection[Any], job: CadRenderViewJob, event_type: str, payload: dict[str, Any]
) -> None:
    conn.execute(
        "INSERT INTO events (project_id, entity, entity_id, type, payload) "
        "VALUES (%s, 'cad_file', %s, %s, %s)",
        (job.project_id, str(job.cad_file_id), event_type, Jsonb(payload)),
    )


def _pg_text(value: str) -> str:
    return value.replace("\x00", "�").encode("utf-8", "replace").decode("utf-8")


def _extents(row: tuple[Any, ...]) -> Extents | None:
    if any(v is None for v in row):
        return None
    return Extents(float(row[0]), float(row[1]), float(row[2]), float(row[3]))


class PostgresViewRepository:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._dsn)

    def start_view(self, job: CadRenderViewJob) -> ViewInputs | None:
        with self._connect() as conn:
            row = conn.execute(START_SQL, (job.cad_file_id, job.project_id, job.id)).fetchone()
        if row is None:
            return None
        return ViewInputs(
            cad_file_id=job.cad_file_id,
            project_id=job.project_id,
            status=str(row[0]),
            format=str(row[1]),
            storage_key=str(row[2]),
            converted_storage_key=None if row[3] is None else str(row[3]),
            extents=_extents(tuple(row[4:8])),
        )

    @contextmanager
    def open_finish(self, job: CadRenderViewJob) -> Iterator[PostgresViewFinish | None]:
        conn = self._connect()
        try:
            locked = conn.execute(LOCK_SQL, (job.cad_file_id, job.project_id, job.id)).fetchone()
            if locked is None:
                conn.rollback()
                yield None
                return
            session = PostgresViewFinish(conn, job)
            yield session
            if not session.committed:
                conn.rollback()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def fail(self, job: CadRenderViewJob, code: ViewFailureCode, message: str) -> bool:
        text = _pg_text(message)[:ERROR_MESSAGE_LIMIT]
        with self._connect() as conn:
            cur = conn.execute(FAIL_SQL, (code, job.cad_file_id, job.project_id, job.id))
            if cur.rowcount != 1:
                return False
            _event(
                conn,
                job,
                "cad_file.view_failed",
                {
                    "jobId": str(job.id),
                    "attempt": job.attempt,
                    "errorCode": code,
                    "errorMessage": text,
                },
            )
        return True


class PostgresViewFinish:
    def __init__(self, conn: psycopg.Connection[Any], job: CadRenderViewJob) -> None:
        self._conn = conn
        self._job = job
        self.committed = False

    def finish(self, result: ViewResult) -> None:
        job = self._job
        cur = self._conn.execute(
            READY_SQL,
            (result.storage_key, result.size_bytes, job.cad_file_id, job.project_id, job.id),
        )
        if cur.rowcount != 1:
            raise RuntimeError("cad_files view row changed during the render")
        _event(
            self._conn,
            job,
            "cad_file.view_rendered",
            {
                "jobId": str(job.id),
                "attempt": job.attempt,
                "storageKey": result.storage_key,
                "sizeBytes": result.size_bytes,
                "stats": result.stats,
            },
        )
        self._conn.commit()
        self.committed = True
