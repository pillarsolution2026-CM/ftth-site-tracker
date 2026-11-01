"""Seed a published revision, approved As-Built rows and As-Built export rows with SQL.

The order follows the database rules of migration 0009: `sync_operations` -> `asbuilt_edits`
(inserted already approved; the BEFORE INSERT trigger checks the target) -> `asbuilt_features`
(the trigger accepts only geometry and labels coming from an approved edit of that version).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import psycopg

from cad_worker.adapters.job_message import CadExportAsBuiltJob
from tests.support.revisions import X0, Y0, publish, queue_revision, seed_processed_file

SRID = 32636


def line(*pts: tuple[float, float]) -> str:
    return "LINESTRING (" + ", ".join(f"{X0 + x!r} {Y0 + y!r}" for x, y in pts) + ")"


def point(x: float, y: float) -> str:
    return f"POINT ({X0 + x!r} {Y0 + y!r})"


@dataclass
class SeededProject:
    project_id: uuid.UUID
    revision_id: uuid.UUID
    user_id: uuid.UUID
    features: dict[str, uuid.UUID] = field(default_factory=dict)


@dataclass(frozen=True)
class QueuedExport:
    project_id: uuid.UUID
    export_id: uuid.UUID
    job_id: uuid.UUID

    def job(self, attempt: int = 1) -> CadExportAsBuiltJob:
        return CadExportAsBuiltJob(
            id=self.job_id,
            type="cad.export_asbuilt",
            exportId=self.export_id,
            projectId=self.project_id,
            attempt=attempt,
            enqueuedAt=datetime.now(UTC),
        )

    def message(self, attempt: int = 1) -> str:
        return json.dumps(
            {
                "id": str(self.job_id),
                "type": "cad.export_asbuilt",
                "exportId": str(self.export_id),
                "projectId": str(self.project_id),
                "attempt": attempt,
                "enqueuedAt": "2026-11-01T10:00:00.000Z",
            }
        )


def make_user(db: psycopg.Connection[Any]) -> uuid.UUID:
    user_id = uuid.uuid4()
    db.execute(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES (%s, %s, 'u', 'x')",
        (user_id, f"{user_id.hex}@example.test"),
    )
    return user_id


# (key, type, layer, block, code, wkt)
DesignSpec = tuple[str, str, str, str | None, str | None, str]


def seed_design(
    db: psycopg.Connection[Any], specs: list[DesignSpec], *, published: bool = True
) -> SeededProject:
    """A project with one revision holding exactly `specs` (published unless asked otherwise)."""
    revision = queue_revision(db, seed_processed_file(db))
    db.execute(
        "UPDATE design_revisions SET status = 'draft' WHERE id = %s", (revision.revision_id,)
    )
    seeded = SeededProject(revision.project_id, revision.revision_id, make_user(db))
    for i, (key, ftype, layer, block, code, wkt) in enumerate(specs):
        fid = uuid.uuid4()
        seeded.features[key] = fid
        db.execute(
            "INSERT INTO features (id, project_id, feature_type, first_revision_id) "
            "VALUES (%s, %s, %s, %s)",
            (fid, seeded.project_id, ftype, seeded.revision_id),
        )
        db.execute(
            "INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, "
            "code, layer, block_name, source_kind, source_handle, geom) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, ST_GeomFromText(%s, %s))",
            (seeded.revision_id, fid, seeded.project_id, ftype, code, layer, block,
             "curve" if ftype == "route" else "insert", f"H{i}", wkt, SRID),
        )  # fmt: skip
    if published:
        publish(db, revision)
    return seeded


def approved_edit(
    db: psycopg.Connection[Any],
    seeded: SeededProject,
    feature_id: uuid.UUID,
    *,
    kind: str,
    feature_type: str,
    version: int,
    wkt: str | None = None,
    label: str | None = None,
    base: int | None = None,
) -> uuid.UUID:
    """One approved edit, inserted through `sync_operations` like the sync path would."""
    op_id, edit_id = uuid.uuid4(), uuid.uuid4()
    db.execute(
        "INSERT INTO sync_operations (client_op_id, project_id, user_id, device_id, kind, "
        "payload_sha256, result) VALUES (%s, %s, %s, %s, 'asbuilt_edit.record', %s, '{}')",
        (op_id, seeded.project_id, seeded.user_id, uuid.uuid4(), "e" * 64),
    )
    reviewer = make_user(db)
    if base is None and kind not in ("add_route", "add_symbol"):
        base = version - 1
    db.execute(
        "INSERT INTO asbuilt_edits (id, project_id, client_op_id, feature_id, kind, feature_type, "
        "design_revision_id, base_version, geom, label, user_id, device_id, captured_at, status, "
        "reviewed_by, reviewed_at, approved_version) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, "
        "ST_GeomFromText(%s, %s), %s, %s, %s, now(), 'approved', %s, now(), %s)",
        (edit_id, seeded.project_id, op_id, feature_id, kind, feature_type, seeded.revision_id,
         base, wkt, SRID, label, seeded.user_id, uuid.uuid4(), reviewer, version),
    )  # fmt: skip
    return edit_id


def project_state(
    db: psycopg.Connection[Any],
    seeded: SeededProject,
    feature_id: uuid.UUID,
    *,
    feature_type: str,
    added: bool,
    geometry: tuple[str, uuid.UUID, int] | None = None,
    label: tuple[str, uuid.UUID, int] | None = None,
) -> None:
    """Insert the `asbuilt_features` row as an approval would."""
    db.execute(
        "INSERT INTO asbuilt_features (project_id, feature_id, feature_type, added, geom, label, "
        "geometry_version, label_version, geometry_edit_id, label_edit_id) "
        "VALUES (%s, %s, %s, %s, ST_GeomFromText(%s, %s), %s, %s, %s, %s, %s)",
        (seeded.project_id, feature_id, feature_type, added,
         geometry[0] if geometry else None, SRID, label[0] if label else None,
         geometry[2] if geometry else 0, label[2] if label else 0,
         geometry[1] if geometry else None, label[1] if label else None),
    )  # fmt: skip


def queue_export(
    db: psycopg.Connection[Any], seeded: SeededProject, *, status: str = "queued"
) -> QueuedExport:
    export_id, job_id = uuid.uuid4(), uuid.uuid4()
    db.execute(
        "INSERT INTO asbuilt_exports (id, project_id, revision_id, status, current_job_id, "
        "requested_by) VALUES (%s, %s, %s, %s, %s, %s)",
        (export_id, seeded.project_id, seeded.revision_id, status, job_id, seeded.user_id),
    )
    return QueuedExport(seeded.project_id, export_id, job_id)
