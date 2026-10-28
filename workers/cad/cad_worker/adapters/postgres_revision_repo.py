"""RevisionRepository on PostgreSQL. Every write is guarded by `design_revisions.current_job_id`
(ADR-013/017); `project_id` is part of every query. The database triggers keep published and
discarded revisions immutable whatever this code does.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb
from shapely import wkb

from cad_worker.adapters.job_message import CadBuildRevisionJob
from cad_worker.adapters.pmtiles_writer import TileSource, write_revision_pmtiles
from cad_worker.adapters.postgres_repo import ERROR_MESSAGE_LIMIT, pg_text
from cad_worker.adapters.wkt import linestring_2d, point_2d
from cad_worker.application.ports import (
    BuildFailure,
    BuildSummary,
    RevisionFailureCode,
    RevisionInputs,
    RevisionRows,
    TileStats,
)
from cad_worker.domain.design import FeatureType, SourceKind, Xy
from cad_worker.domain.design_build import (
    BackgroundSelection,
    DrawingData,
    SourceAttribute,
    SourceCurve,
    SourceInsert,
    SourceText,
)
from cad_worker.domain.geo import reproject
from cad_worker.domain.revision_match import BaseFeature

START_SQL = """
UPDATE design_revisions SET status = 'building', build_started_at = now()
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'building')
"""
LOCK_SQL = """
SELECT cad_file_id, base_revision_id, rules, crs_epsg, drawing_unit, metres_per_unit
FROM design_revisions
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status = 'building'
FOR UPDATE
"""
# Children first (foreign keys), then the feature identities this revision created.
CLEANUP_SQL = (
    "DELETE FROM revision_diff_items WHERE revision_id = %s AND project_id = %s",
    "DELETE FROM text_links WHERE revision_id = %s AND project_id = %s",
    "DELETE FROM design_features WHERE revision_id = %s AND project_id = %s",
    "DELETE FROM features WHERE first_revision_id = %s AND project_id = %s",
)
FILE_STATUS_SQL = "SELECT status FROM cad_files WHERE id = %s AND project_id = %s FOR SHARE"
CURVES_SQL = """
SELECT handle, layer, ST_AsBinary(ST_Force2D(geom)) FROM cad_curves
WHERE cad_file_id = %s AND project_id = %s AND layer = ANY(%s) ORDER BY handle
"""
INSERTS_SQL = """
SELECT handle, layer, block_name, ST_X(position), ST_Y(position), attributes FROM cad_inserts
WHERE cad_file_id = %s AND project_id = %s ORDER BY handle
"""
TEXTS_SQL = """
SELECT handle, layer, ST_X(position), ST_Y(position), height, raw_text, text, readable
FROM cad_texts WHERE cad_file_id = %s AND project_id = %s ORDER BY handle
"""
BASE_SQL = """
SELECT feature_id, feature_type, code, source_kind, source_handle, ST_AsBinary(geom), ST_SRID(geom)
FROM design_features WHERE revision_id = %s AND project_id = %s ORDER BY feature_id
"""
INSERT_FEATURE_IDS = """
INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES (%s, %s, %s, %s)
"""
INSERT_DESIGN_FEATURE = """
INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
  block_name, source_kind, source_handle, geom, attrs)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromText(%s), %s), %s)
"""
INSERT_TEXT_LINK = """
INSERT INTO text_links (project_id, revision_id, text_handle, layer, text, raw_text, readable,
  position, height_m, kind, status, feature_id, distance_m, confidence)
VALUES (%s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromText(%s), %s), %s, %s, %s, %s, %s, %s)
"""
INSERT_DIFF = """
INSERT INTO revision_diff_items (project_id, revision_id, feature_id, feature_type, change, code,
  previous_code, distance_m, candidate_feature_ids)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
"""
# Length deltas from the stored `length_m` of both revisions: exactly what the API shows.
LENGTH_DELTA_SQL = """
UPDATE revision_diff_items d SET length_delta_m = n.length_m - b.length_m
FROM design_features n, design_features b
WHERE d.revision_id = %(rev)s AND d.project_id = %(project)s AND d.feature_type = 'route'
  AND d.change NOT IN ('added', 'removed')
  AND n.revision_id = d.revision_id AND n.feature_id = d.feature_id
  AND b.revision_id = %(base)s AND b.feature_id = d.feature_id
"""
ROUTE_LENGTH_SQL = """
SELECT COALESCE(SUM(length_m), 0) FROM design_features
WHERE revision_id = %s AND project_id = %s AND feature_type = 'route'
"""
FINISH_SQL = """
UPDATE design_revisions SET status = 'draft', built_at = now(), counts = %s,
  text_link_counts = %s, diff_counts = %s, tiles_storage_key = %s, warnings = %s, log = %s,
  error_code = NULL, error_message = NULL
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status = 'building'
"""
FAIL_SQL = """
UPDATE design_revisions SET status = 'failed', error_code = %s, error_message = %s,
  log = COALESCE(NULLIF(%s, ''), log)
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status IN ('queued', 'building')
"""


def insert_revision_event(
    conn: psycopg.Connection[Any],
    job: CadBuildRevisionJob,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Events of the worker have no actor (actor_id NULL)."""
    conn.execute(
        "INSERT INTO events (project_id, entity, entity_id, type, payload) "
        "VALUES (%s, 'design_revision', %s, %s, %s)",
        (job.project_id, str(job.revision_id), event_type, Jsonb(payload)),
    )


def _coords(geometry_wkb: bytes) -> tuple[Xy, ...]:
    return tuple((float(x), float(y)) for x, y, *_ in wkb.loads(bytes(geometry_wkb)).coords)


class PostgresRevisionRepository:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._dsn)

    def start_build(self, job: CadBuildRevisionJob, worker_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(START_SQL, (job.revision_id, job.project_id, job.id))
            if cur.rowcount != 1:
                return False
            insert_revision_event(
                conn,
                job,
                "design_revision.build_started",
                {"jobId": str(job.id), "attempt": job.attempt, "workerId": worker_id},
            )
        return True

    @contextmanager
    def open_build(self, job: CadBuildRevisionJob) -> Iterator[PostgresRevisionBuild | None]:
        conn = self._connect()
        try:
            row = conn.execute(LOCK_SQL, (job.revision_id, job.project_id, job.id)).fetchone()
            if row is None:
                conn.rollback()
                yield None
                return
            for sql in CLEANUP_SQL:
                conn.execute(sql, (job.revision_id, job.project_id))
            inputs = RevisionInputs(
                revision_id=job.revision_id,
                project_id=job.project_id,
                cad_file_id=row[0],
                base_revision_id=row[1],
                rules=row[2],
                crs_epsg=int(row[3]),
                drawing_unit=str(row[4]),
                metres_per_unit=Decimal(row[5]),
            )
            build = PostgresRevisionBuild(conn, job, inputs)
            yield build
            if not build.committed:
                conn.rollback()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def fail(
        self, job: CadBuildRevisionJob, code: RevisionFailureCode, message: str, log: str = ""
    ) -> bool:
        text = pg_text(message)[:ERROR_MESSAGE_LIMIT]
        with self._connect() as conn:
            cur = conn.execute(
                FAIL_SQL, (code, text, pg_text(log), job.revision_id, job.project_id, job.id)
            )
            if cur.rowcount != 1:
                return False
            insert_revision_event(
                conn,
                job,
                "design_revision.failed",
                {
                    "jobId": str(job.id),
                    "attempt": job.attempt,
                    "errorCode": code,
                    "errorMessage": text,
                },
            )
        return True


class PostgresRevisionBuild:
    """The open build transaction (see RevisionBuild)."""

    def __init__(
        self, conn: psycopg.Connection[Any], job: CadBuildRevisionJob, inputs: RevisionInputs
    ) -> None:
        self._conn = conn
        self._job = job
        self.inputs = inputs
        self.committed = False

    @property
    def _ids(self) -> tuple[UUID, UUID]:
        return (self.inputs.cad_file_id, self.inputs.project_id)

    def load_drawing(self, curve_layers: frozenset[str]) -> DrawingData:
        status = self._conn.execute(FILE_STATUS_SQL, self._ids).fetchone()
        if status is None or status[0] != "processed":
            found = status[0] if status else "missing"
            raise BuildFailure("CAD_FILE_NOT_PROCESSED", f"CAD file is {found}, not processed")
        curves = tuple(
            SourceCurve(str(h), str(layer), _coords(g))
            for h, layer, g in self._conn.execute(CURVES_SQL, (*self._ids, sorted(curve_layers)))
        )
        inserts = tuple(
            SourceInsert(
                str(h),
                str(layer),
                str(block),
                (float(x), float(y)),
                tuple(
                    SourceAttribute(
                        str(a.get("tag", "")),
                        str(a.get("rawValue", "")),
                        str(a.get("value", "")),
                        bool(a.get("readable", False)),
                    )
                    for a in attrs
                ),
            )
            for h, layer, block, x, y, attrs in self._conn.execute(INSERTS_SQL, self._ids)
        )
        texts = tuple(
            SourceText(
                str(h),
                str(layer),
                (float(x), float(y)),
                float(height),
                str(raw),
                str(text),
                bool(readable),
            )
            for h, layer, x, y, height, raw, text, readable in self._conn.execute(
                TEXTS_SQL, self._ids
            )
        )
        return DrawingData(curves, inserts, texts)

    def load_base(self) -> tuple[BaseFeature, ...]:
        base = self.inputs.base_revision_id
        if base is None:
            return ()
        out: list[BaseFeature] = []
        for fid, ftype, code, kind, handle, geom, srid in self._conn.execute(
            BASE_SQL, (base, self.inputs.project_id)
        ):
            coords = reproject(_coords(geom), int(srid), self.inputs.crs_epsg)
            out.append(
                BaseFeature(
                    fid, _feature_type(ftype), code, _source_kind(kind), str(handle), coords
                )
            )
        return tuple(out)

    def write(self, rows: RevisionRows) -> Decimal:
        rev, project, srid = self.inputs.revision_id, self.inputs.project_id, self.inputs.crs_epsg
        with self._conn.cursor() as cur:
            cur.executemany(
                INSERT_FEATURE_IDS,
                [(fid, project, ftype, rev) for fid, ftype in rows.new_feature_ids],
            )
            cur.executemany(
                INSERT_DESIGN_FEATURE,
                [
                    (
                        rev,
                        f.feature_id,
                        project,
                        f.feature_type,
                        f.code,
                        f.layer,
                        f.block_name,
                        f.source_kind,
                        f.source_handle,
                        linestring_2d(f.coords)
                        if f.feature_type == "route"
                        else point_2d(f.coords[0]),
                        srid,
                        Jsonb(f.attrs),
                    )
                    for f in rows.features
                ],
            )
            cur.executemany(
                INSERT_TEXT_LINK,
                [
                    (
                        project,
                        rev,
                        t.text_handle,
                        t.layer,
                        t.text,
                        t.raw_text,
                        t.readable,
                        point_2d(t.position),
                        srid,
                        t.height_m,
                        t.kind,
                        t.status,
                        t.feature_id,
                        t.distance_m,
                        t.confidence,
                    )
                    for t in rows.text_links
                ],
            )
            cur.executemany(
                INSERT_DIFF,
                [
                    (
                        project,
                        rev,
                        d.feature_id,
                        d.feature_type,
                        d.change,
                        d.code,
                        d.previous_code,
                        d.distance_m,
                        list(d.candidate_ids),
                    )
                    for d in rows.diff
                ],
            )
        if self.inputs.base_revision_id is not None:
            self._conn.execute(
                LENGTH_DELTA_SQL,
                {"rev": rev, "project": project, "base": self.inputs.base_revision_id},
            )
        total = self._conn.execute(ROUTE_LENGTH_SQL, (rev, project)).fetchone()
        return Decimal(total[0]) if total else Decimal("0.000")

    def render_tiles(self, dest: Path, background: BackgroundSelection) -> TileStats:
        source = TileSource(
            revision_id=self.inputs.revision_id,
            project_id=self.inputs.project_id,
            cad_file_id=self.inputs.cad_file_id,
            crs_epsg=self.inputs.crs_epsg,
            metres_per_unit=self.inputs.metres_per_unit,
            background=background,
        )
        return write_revision_pmtiles(self._conn, source, dest)

    def finish(self, summary: BuildSummary) -> None:
        job = self._job
        cur = self._conn.execute(
            FINISH_SQL,
            (
                Jsonb(summary.counts),
                Jsonb(summary.text_link_counts),
                Jsonb(summary.diff_counts),
                summary.tiles_storage_key,
                Jsonb(summary.warnings),
                pg_text(summary.log),
                job.revision_id,
                job.project_id,
                job.id,
            ),
        )
        if cur.rowcount != 1:
            raise RuntimeError("design_revisions row changed during the build")
        insert_revision_event(
            self._conn,
            job,
            "design_revision.built",
            {
                "jobId": str(job.id),
                "attempt": job.attempt,
                "counts": summary.counts,
                "textLinkCounts": summary.text_link_counts,
                "diffCounts": summary.diff_counts,
                "hasTiles": summary.tiles_storage_key is not None,
            },
        )
        self._conn.commit()
        self.committed = True


def _feature_type(value: object) -> FeatureType:
    if value not in ("route", "box", "hhi", "joint", "mh"):
        raise ValueError(f"unknown feature type {value!r}")
    return value


def _source_kind(value: object) -> SourceKind:
    if value not in ("curve", "insert", "text"):
        raise ValueError(f"unknown source kind {value!r}")
    return value
