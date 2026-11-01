"""AsBuiltExportRepository on PostgreSQL (Phase 4, ADR-030).

Every write is guarded by `asbuilt_exports.current_job_id` and the row status (ADR-013); the
row stays locked from the read of the As-Built state until `done` is committed, so a finished
export is never written twice. `project_id` is part of every query. Events have no actor.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb
from shapely import wkb

from cad_worker.adapters.job_message import CadExportAsBuiltJob
from cad_worker.application.ports import ExportFailureCode, ExportInputs, ExportResult
from cad_worker.domain.asbuilt_drawing import AsBuiltFeatureIn, DesignFeatureIn
from cad_worker.domain.design import FeatureType, Xy
from cad_worker.domain.geo import reproject

START_SQL = """
UPDATE asbuilt_exports SET status = 'processing', started_at = now()
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'processing')
"""
LOCK_SQL = """
SELECT e.revision_id, r.status, r.crs_epsg
FROM asbuilt_exports e
JOIN design_revisions r ON r.id = e.revision_id AND r.project_id = e.project_id
WHERE e.id = %s AND e.project_id = %s AND e.current_job_id = %s AND e.status = 'processing'
FOR UPDATE OF e
"""
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '120s'"
DESIGN_SQL = """
SELECT feature_id, feature_type, layer, code, ST_AsBinary(ST_Force2D(geom)), ST_SRID(geom)
FROM design_features WHERE revision_id = %s AND project_id = %s ORDER BY feature_id
"""
ASBUILT_SQL = """
SELECT feature_id, feature_type, added, ST_AsBinary(ST_Force2D(geom)), ST_SRID(geom), label,
  geometry_version, label_version
FROM asbuilt_features
WHERE project_id = %s AND (geom IS NOT NULL OR label IS NOT NULL)
ORDER BY feature_id
"""
DONE_SQL = """
UPDATE asbuilt_exports SET status = 'done', finished_at = now(), storage_key = %s,
  size_bytes = %s, sha256 = %s, stats = %s, error_code = NULL
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status = 'processing'
"""
FAIL_SQL = """
UPDATE asbuilt_exports SET status = 'failed', finished_at = now(), error_code = %s
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'processing')
"""


def insert_export_event(
    conn: psycopg.Connection[Any],
    job: CadExportAsBuiltJob,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Events of the worker have no actor (actor_id NULL)."""
    conn.execute(
        "INSERT INTO events (project_id, entity, entity_id, type, payload) "
        "VALUES (%s, 'asbuilt_export', %s, %s, %s)",
        (job.project_id, str(job.export_id), event_type, Jsonb(payload)),
    )


def _feature_type(value: object) -> FeatureType:
    if value not in ("route", "box", "hhi", "joint", "mh"):
        raise ValueError(f"unknown feature type {value!r}")
    return value


class PostgresExportRepository:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._dsn)

    def start_export(self, job: CadExportAsBuiltJob, worker_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(START_SQL, (job.export_id, job.project_id, job.id))
            return cur.rowcount == 1

    @contextmanager
    def open_export(self, job: CadExportAsBuiltJob) -> Iterator[PostgresExportSession | None]:
        conn = self._connect()
        try:
            conn.execute(STATEMENT_TIMEOUT_SQL)
            row = conn.execute(LOCK_SQL, (job.export_id, job.project_id, job.id)).fetchone()
            if row is None:
                conn.rollback()
                yield None
                return
            inputs = ExportInputs(
                export_id=job.export_id,
                project_id=job.project_id,
                revision_id=row[0],
                revision_status=str(row[1]),
                crs_epsg=int(row[2]),
            )
            session = PostgresExportSession(conn, job, inputs)
            yield session
            if not session.committed:
                conn.rollback()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def fail(self, job: CadExportAsBuiltJob, code: ExportFailureCode, message: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(FAIL_SQL, (code, job.export_id, job.project_id, job.id))
            if cur.rowcount != 1:
                return False
            insert_export_event(
                conn,
                job,
                "asbuilt_export.failed",
                {"jobId": str(job.id), "attempt": job.attempt, "errorCode": code},
            )
        return True


class PostgresExportSession:
    """The open export transaction (see AsBuiltExportSession)."""

    def __init__(
        self, conn: psycopg.Connection[Any], job: CadExportAsBuiltJob, inputs: ExportInputs
    ) -> None:
        self._conn = conn
        self._job = job
        self.inputs = inputs
        self.committed = False

    def _coords(self, geometry_wkb: bytes, srid: int) -> tuple[Xy, ...]:
        shape = wkb.loads(bytes(geometry_wkb))
        points = tuple((float(x), float(y)) for x, y, *_ in shape.coords)
        return reproject(points, int(srid), self.inputs.crs_epsg)

    def load_design(self) -> tuple[DesignFeatureIn, ...]:
        rows = self._conn.execute(DESIGN_SQL, (self.inputs.revision_id, self.inputs.project_id))
        return tuple(
            DesignFeatureIn(
                feature_id=fid if isinstance(fid, UUID) else UUID(str(fid)),
                feature_type=_feature_type(ftype),
                layer=str(layer),
                code=None if code is None else str(code),
                coords=self._coords(geom, srid),
            )
            for fid, ftype, layer, code, geom, srid in rows
        )

    def load_asbuilt(self) -> tuple[AsBuiltFeatureIn, ...]:
        rows = self._conn.execute(ASBUILT_SQL, (self.inputs.project_id,))
        return tuple(
            AsBuiltFeatureIn(
                feature_id=fid if isinstance(fid, UUID) else UUID(str(fid)),
                feature_type=_feature_type(ftype),
                added=bool(added),
                coords=None if geom is None else self._coords(geom, srid),
                label=None if label is None else str(label),
                geometry_version=int(gv),
                label_version=int(lv),
            )
            for fid, ftype, added, geom, srid, label, gv, lv in rows
        )

    def finish(self, result: ExportResult) -> None:
        job = self._job
        stats = result.stats.to_json()
        cur = self._conn.execute(
            DONE_SQL,
            (
                result.storage_key,
                result.size_bytes,
                result.sha256,
                Jsonb(stats),
                job.export_id,
                job.project_id,
                job.id,
            ),
        )
        if cur.rowcount != 1:
            raise RuntimeError("asbuilt_exports row changed during the export")
        insert_export_event(
            self._conn,
            job,
            "asbuilt_export.done",
            {
                "jobId": str(job.id),
                "attempt": job.attempt,
                "stats": stats,
                "sizeBytes": result.size_bytes,
                "warnings": list(result.warnings),
            },
        )
        self._conn.commit()
        self.committed = True
