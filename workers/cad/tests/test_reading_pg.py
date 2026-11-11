"""ADR-041 reading by meaning through the real build (PostGIS, never mocked): the revision's
drawing kind is read from `design_revisions.drawing_kind`, readings land in
`design_features.attrs.reading`, totals in `counts.reading`, problems with params in `warnings`,
role texts are not text links, and corrections apply before the reading."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import psycopg

from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from tests.support.revisions import RULES, X0, Y0, queue_revision, seed_processed_file

BASE_RULES: list[dict[str, object]] = [dict(r) for r in RULES]
ROLE_RULES: list[dict[str, object]] = [
    *BASE_RULES,
    {"source": "layer", "layer": "TXTCAP", "target": "label", "textRoles": ["box_cabinet"]},
    {"source": "layer", "layer": "TXTNMPER", "target": "label", "textRoles": ["box_number"]},
    {"source": "layer", "layer": "cab", "target": "cabinet", "role": "sub"},
    {"source": "layer", "layer": "CABINA", "target": "label", "textRoles": ["cabinet_info"]},
    {"source": "layer", "layer": "ZOUN", "target": "zone"},
]


def _revision(db: psycopg.Connection[Any], revision_id: uuid.UUID, columns: str) -> Any:
    row = db.execute(
        f"SELECT {columns} FROM design_revisions WHERE id = %s", (revision_id,)
    ).fetchone()
    assert row is not None
    return row


def _seed_roles(db: psycopg.Connection[Any], project_id: uuid.UUID, file_id: uuid.UUID) -> None:
    """Box I1 (0, 2) named 1-3 / 9; box I2 (100, 2) with its number only; cabinet 1-3 with «2B»
    inside a zone of two open lines."""
    ids = (project_id, file_id)
    for handle, layer, value, x, y in (
        ("R1", "TXTCAP", "1-3", 0.5, 2.5),
        ("R2", "TXTNMPER", "9", -0.5, 2.5),
        ("R3", "TXTNMPER", "10", 100.5, 2.5),
        ("R4", "CABINA", "1-3", 50.5, 30.5),
        ("R5", "CABINA", "2B", 50.5, 29.5),
    ):
        db.execute(
            "INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, "
            "height, raw_text, text, readable) VALUES (%s, %s, %s, 'text', %s, "
            "ST_MakePoint(%s, %s, 0), 0.2, %s, %s, true)",
            (*ids, handle, layer, X0 + x, Y0 + y, value, value),
        )
    db.execute(
        "INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, "
        "attributes) VALUES (%s, %s, 'K1', 'cab', 'cabinet', ST_MakePoint(%s, %s, 0), '[]')",
        (*ids, X0 + 50, Y0 + 30),
    )
    for handle, pts in (
        ("Z1", ((-10, -20), (200, -20), (200, 60))),
        ("Z2", ((200, 60), (-10, 60), (-10, -20))),
    ):
        wkt = "LINESTRING Z (" + ", ".join(f"{X0 + x} {Y0 + y} 0" for x, y in pts) + ")"
        db.execute(
            "INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom) "
            "VALUES (%s, %s, %s, 'LWPOLYLINE', 'ZOUN', %s::geometry)",
            (*ids, handle, wkt),
        )


def test_a_secondary_is_read_by_meaning_and_stored(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    seeded = seed_processed_file(db, drawing_kind="secondary")
    _seed_roles(db, seeded.project_id, seeded.cad_file_id)
    # The PM names box I2's cabinet on the program page (ADR-038): read like any other text.
    add_cabinet = {
        "id": str(uuid.uuid4()),
        "correction": {
            "kind": "add_text",
            "layer": "TXTCAP",
            "x": X0 + 99.5,
            "y": Y0 + 2.5,
            "text": "1-3",
            "height": None,
        },
    }
    revision = queue_revision(
        db, seeded, rules=ROLE_RULES, corrections=[add_cabinet], drawing_kind="secondary"
    )
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(tmp_path))
    assert run_build(revision.job(), deps, "w1") == "built"

    rows = db.execute(
        "SELECT source_handle, code, attrs FROM design_features WHERE revision_id = %s",
        (revision.revision_id,),
    ).fetchall()
    by_handle = {h: (code, attrs) for h, code, attrs in rows}
    assert by_handle["I1"][0] == "1-3/9" and by_handle["I2"][0] == "1-3/10"
    assert by_handle["I1"][1]["reading"]["texts"] == {"box_cabinet": ["R1"], "box_number": ["R2"]}
    fix_handle = f"FIX-{add_cabinet['id']}"
    assert by_handle["I2"][1]["reading"]["texts"]["box_cabinet"] == [fix_handle]
    cabinet_code, cabinet = by_handle["K1"]
    assert cabinet_code == "1-3"
    assert cabinet["reading"]["boxesDrawn"] == 2 and cabinet["reading"]["zoneHandle"] == "Z1"
    # Phase-1 attrs stay next to the reading.
    assert cabinet["role"] == "sub"

    counts, warnings, log = _revision(db, revision.revision_id, "counts, warnings, log")
    assert counts["reading"]["drawingKind"] == "secondary"
    assert "reading: roles (secondary)" in log
    problems = {w["code"]: w for w in warnings}
    # No 1way bundle in this drawing: neither box is reached.
    assert problems["BOX_NOT_REACHED"]["severity"] == "error"
    assert sorted(i["handle"] for i in problems["BOX_NOT_REACHED"]["items"]) == ["I1", "I2"]
    assert "CABINET_BOX_COUNT_MISMATCH" not in problems
    # Owner answer Q5 (2026-11-11): both boxes are named but have no cable type written (no layer
    # of this mapping carries box_cable_type, so no layer is suggested).
    missing = problems["LABEL_MISSING"]["items"]
    assert sorted((i["handle"], i["suggestedLayer"], i["params"]["role"]) for i in missing) == [
        ("I1", None, "box_cable_type"),
        ("I2", None, "box_cable_type"),
    ]
    # Role texts are never text links; the Phase-1 label layers still are.
    linked = {
        h
        for (h,) in db.execute(
            "SELECT text_handle FROM text_links WHERE revision_id = %s", (revision.revision_id,)
        ).fetchall()
    }
    assert not linked & {"R1", "R2", "R3", "R4", "R5", fix_handle}
    assert "T2" in linked
    json.dumps(counts)  # stored as plain JSON


def test_a_general_revision_reads_the_general_checks(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    seeded = seed_processed_file(db)
    _seed_roles(db, seeded.project_id, seeded.cad_file_id)
    rules = [r for r in ROLE_RULES if r.get("target") != "zone"]
    revision = queue_revision(db, seeded, rules=rules)
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(tmp_path))
    assert run_build(revision.job(), deps, "w1") == "built"
    counts, warnings = _revision(db, revision.revision_id, "counts, warnings")
    assert counts["reading"]["drawingKind"] == "general"
    codes = {w["code"] for w in warnings}
    assert not codes & {"BOX_NOT_REACHED", "CABINET_ZONE_MISSING", "CABINET_BOX_COUNT_MISMATCH"}
