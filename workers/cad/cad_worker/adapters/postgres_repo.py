"""CadRepository on PostgreSQL. Every write is guarded by `cad_files.current_job_id` (ADR-013)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg

from cad_worker.adapters.job_message import CadImportJob
from cad_worker.adapters.postgres_sink import PostgresSink, insert_event
from cad_worker.application.ports import FailureCode, ResultSink

DEFAULT_BATCH_SIZE = 5000
ERROR_MESSAGE_LIMIT = 2000
CHILD_TABLES = ("cad_layers", "cad_inserts", "cad_texts", "cad_curves")

START_SQL = """
UPDATE cad_files SET status = 'processing', processing_started_at = now(),
  error_code = NULL, error_message = NULL
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'processing')
"""
LOCK_SQL = """
SELECT 1 FROM cad_files
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status = 'processing'
FOR UPDATE
"""
PROJECT_EPSG_SQL = "SELECT crs_epsg FROM projects WHERE id = %s"
FAIL_SQL = """
UPDATE cad_files SET status = 'failed', error_code = %s, error_message = %s,
  log = COALESCE(NULLIF(%s, ''), log)
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'processing')
"""


def pg_text(value: str) -> str:
    """Error text may echo file content; PostgreSQL text cannot hold NUL or lone surrogates."""
    return value.replace("\x00", "�").encode("utf-8", "replace").decode("utf-8")


class PostgresCadRepository:
    def __init__(self, dsn: str, batch_size: int = DEFAULT_BATCH_SIZE) -> None:
        self._dsn = dsn
        self._batch = batch_size

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._dsn)

    def ping(self) -> bool:
        with self._connect() as conn:
            return conn.execute("SELECT 1").fetchone() == (1,)

    def start_processing(self, job: CadImportJob, worker_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(START_SQL, (job.cad_file_id, job.project_id, job.id))
            if cur.rowcount != 1:
                return False
            insert_event(
                conn,
                job,
                "cad_file.processing_started",
                {"jobId": str(job.id), "attempt": job.attempt, "workerId": worker_id},
            )
        return True

    @contextmanager
    def open_result(self, job: CadImportJob) -> Iterator[ResultSink | None]:
        conn = self._connect()
        try:
            locked = conn.execute(LOCK_SQL, (job.cad_file_id, job.project_id, job.id)).fetchone()
            if locked is None:
                conn.rollback()
                yield None
                return
            for table in CHILD_TABLES:
                conn.execute(f"DELETE FROM {table} WHERE cad_file_id = %s", (job.cad_file_id,))
            project = conn.execute(PROJECT_EPSG_SQL, (job.project_id,)).fetchone()
            epsg = int(project[0]) if project and project[0] is not None else None
            sink = PostgresSink(conn, job, self._batch, epsg)
            yield sink
            if not sink.committed:
                conn.rollback()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def fail(self, job: CadImportJob, code: FailureCode, message: str, log: str = "") -> bool:
        text = pg_text(message)[:ERROR_MESSAGE_LIMIT]
        log = pg_text(log)
        with self._connect() as conn:
            cur = conn.execute(FAIL_SQL, (code, text, log, job.cad_file_id, job.project_id, job.id))
            if cur.rowcount != 1:
                return False
            insert_event(
                conn,
                job,
                "cad_file.failed",
                {
                    "jobId": str(job.id),
                    "attempt": job.attempt,
                    "errorCode": code,
                    "errorMessage": text,
                },
            )
        return True
