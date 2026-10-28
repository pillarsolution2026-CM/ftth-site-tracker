"""Seed a processed CAD file (synthetic `cad_*` rows) and queued design revisions with SQL."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import psycopg

from cad_worker.adapters.job_message import CadBuildRevisionJob

# Qalyub-like UTM 36N origin: drawing units are metres when the unit is "m".
X0, Y0 = 325_000.0, 3_340_000.0

RULES: list[dict[str, str]] = [
    {"source": "layer", "layer": "N_DUC_CBL", "target": "route"},
    {"source": "block", "block": "sub", "target": "box"},
    {"source": "block", "block": "JONT 144", "target": "joint"},
    {"source": "text", "layer": "RRR", "text": "NEW-HHI", "target": "hhi"},
    {"source": "layer", "layer": "CAP F36", "target": "label"},
    {"source": "layer", "layer": "RRR", "target": "label"},
    {"source": "layer", "layer": "building", "target": "background"},
    {"source": "block", "block": "tree", "target": "background"},
]


@dataclass(frozen=True)
class SeededFile:
    project_id: uuid.UUID
    cad_file_id: uuid.UUID


@dataclass(frozen=True)
class QueuedRevision:
    project_id: uuid.UUID
    cad_file_id: uuid.UUID
    revision_id: uuid.UUID
    job_id: uuid.UUID

    def job(self, attempt: int = 1) -> CadBuildRevisionJob:
        return CadBuildRevisionJob(
            id=self.job_id,
            type="cad.build_revision",
            revisionId=self.revision_id,
            projectId=self.project_id,
            cadFileId=self.cad_file_id,
            attempt=attempt,
            enqueuedAt=datetime.now(UTC),
        )

    def message(self, attempt: int = 1) -> str:
        return json.dumps(
            {
                "id": str(self.job_id),
                "type": "cad.build_revision",
                "revisionId": str(self.revision_id),
                "projectId": str(self.project_id),
                "cadFileId": str(self.cad_file_id),
                "attempt": attempt,
                "enqueuedAt": "2026-10-28T10:00:00.000Z",
            }
        )


def _p(x: float, y: float) -> str:
    return f"POINT Z ({X0 + x!r} {Y0 + y!r} 0)"


def _line(*pts: tuple[float, float]) -> str:
    return "LINESTRING Z (" + ", ".join(f"{X0 + x!r} {Y0 + y!r} 0" for x, y in pts) + ")"


def seed_processed_file(
    db: psycopg.Connection[Any], *, project_id: uuid.UUID | None = None, status: str = "processed"
) -> SeededFile:
    """Two routes (+ one zero-length), two boxes, a joint, background, labels and a NEW-HHI."""
    if project_id is None:
        project_id = uuid.uuid4()
        db.execute(
            "INSERT INTO projects (id, name, client, crs_epsg, currency) "
            "VALUES (%s, 'p', 'c', 32636, 'EGP')",
            (project_id,),
        )
    file_id = uuid.uuid4()
    db.execute(
        "INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, "
        "storage_key, status, current_job_id, ins_units) "
        "VALUES (%s, %s, 'd.dwg', 'dwg', 1, %s, %s, %s, %s, 1)",
        (file_id, project_id, "c" * 64, f"projects/{project_id}/cad/{file_id}/original.dwg",
         status, uuid.uuid4()),
    )  # fmt: skip
    ids = (project_id, file_id)
    curves = [
        ("C1", "N_DUC_CBL", _line((0, 0), (100, 0))),
        ("C2", "N_DUC_CBL", _line((100, 0), (100, 50), (150, 50))),
        ("C3", "N_DUC_CBL", _line((5, 5), (5, 5))),  # zero length: skipped
        ("C4", "building", _line((10, 10), (20, 10), (20, 20), (10, 20), (10, 10))),
        ("C5", "road", _line((0, -10), (200, -10))),  # no rule: ignored everywhere
    ]
    for handle, layer, wkt in curves:
        db.execute(
            "INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom) "
            "VALUES (%s, %s, %s, 'LWPOLYLINE', %s, %s::geometry)",
            (*ids, handle, layer, wkt),
        )
    inserts = [
        (
            "I1",
            "sub",
            "sub",
            _p(0, 2),
            [{"tag": "N", "rawValue": "S1", "value": "S1", "readable": True}],
        ),
        ("I2", "sub", "sub", _p(100, 2), []),
        ("I3", "jont 144", "JONT 144", _p(150, 52), []),
        ("I4", "CAP F144", "144", _p(50, 3), []),  # no rule for the block or the layer
        ("I5", "trees", "tree", _p(30, 30), []),  # background block
    ]
    for handle, layer, block, wkt, attrs in inserts:
        db.execute(
            "INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, "
            "attributes) VALUES (%s, %s, %s, %s, %s, %s::geometry, %s)",
            (*ids, handle, layer, block, wkt, json.dumps(attrs)),
        )
    texts = [
        ("T1", "CAP F36", "1-1", True, _p(0.5, 3)),  # box id of I1
        ("T2", "CAP F36", "F 36 C", True, _p(50, 1)),  # cable on C1
        ("T3", "RRR", "NEW-HHI", True, _p(60, -2)),  # becomes an hhi feature
        ("T4", "CAP F36", "ahvU", False, _p(100, 3)),  # unreadable: reviewed, never guessed
        ("T5", "CAP F36", "hello", True, _p(10, 1)),  # other: unlinked
        ("T6", "tx", "lrhfv", True, _p(70, 70)),  # unmapped layer: not a candidate
    ]
    for handle, layer, value, readable, wkt in texts:
        db.execute(
            "INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, "
            "height, raw_text, text, readable) "
            "VALUES (%s, %s, %s, 'text', %s, %s::geometry, 0.2, %s, %s, %s)",
            (*ids, handle, layer, wkt, value, value, readable),
        )
    return SeededFile(project_id, file_id)


def queue_revision(
    db: psycopg.Connection[Any],
    seeded: SeededFile,
    *,
    rules: object = None,
    unit: str = "m",
    base_revision_id: uuid.UUID | None = None,
) -> QueuedRevision:
    revision_id, job_id = uuid.uuid4(), uuid.uuid4()
    factor = {"m": Decimal("1"), "in": Decimal("0.0254")}[unit]
    db.execute(
        "INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, "
        "base_revision_id, rules, mapping_version, crs_epsg, drawing_unit, metres_per_unit, "
        "ins_units, units_conflict) VALUES (%s, %s, %s, 'queued', %s, %s, %s, 1, 32636, %s, %s, "
        "1, true)",
        (revision_id, seeded.project_id, seeded.cad_file_id, job_id, base_revision_id,
         json.dumps(RULES if rules is None else rules), unit, factor),
    )  # fmt: skip
    return QueuedRevision(seeded.project_id, seeded.cad_file_id, revision_id, job_id)


def publish(db: psycopg.Connection[Any], revision: QueuedRevision, rev_no: int = 1) -> None:
    """What the API does on publish (status, rev_no, published_at)."""
    db.execute(
        "UPDATE design_revisions SET status = 'published', rev_no = %s, published_at = now() "
        "WHERE id = %s",
        (rev_no, revision.revision_id),
    )
