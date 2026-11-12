"""ADR-043 against a real PostGIS: shapes at import, gallery and box types at build, BOX_TYPE
texts in the As-Built DXF. Needs the columns / tables of migration 0023 (conftest applies the
worker's part of its spec until the API's migration is in the tree)."""

from __future__ import annotations

import io
import json
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest
from ezdxf import recover
from ezdxf.filemanagement import new as new_dxf

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.ezdxf_writer import TEXT_STYLE, EzdxfDxfWriter
from cad_worker.adapters.postgres_export_repo import PostgresExportRepository
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from cad_worker.application.export_asbuilt import ExportDeps, run_export
from cad_worker.application.import_job import ImportDeps, run_import
from tests.conftest import QueuedFile
from tests.support.asbuilt import queue_export, seed_design
from tests.support.fakes import FailingConverter, make_job
from tests.support.revisions import queue_revision, seed_processed_file

SIG_A = "v1-" + "a" * 64
SIG_B = "v1-" + "b" * 64
LINE_ID = "11111111-1111-4111-8111-111111111111"
CHOICE_ID = "22222222-2222-4222-8222-222222222222"
ROLES_RULES: list[dict[str, object]] = [
    {"source": "layer", "layer": "sub", "target": "box"},
    {"source": "layer", "layer": "CAP F36", "target": "label", "textRoles": ["box_number"]},
]
PREVIEW = {"paths": [[-0.5, -0.5, 0.5, 0.5]], "texts": [], "truncated": False}


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


# ---------- import ----------


def _boxes_dxf(path: Path) -> Path:
    doc = new_dxf("R2018", setup=True)
    for name in ("box c", "box copy"):
        block = doc.blocks.new(name)
        block.add_lwpolyline([(0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)], close=True)
        block.add_circle((2.5, 0.5), 0.2)
    msp = doc.modelspace()
    msp.add_blockref("box c", (0, 0), dxfattribs={"layer": "BOX"})
    msp.add_blockref("box copy", (10, 0), dxfattribs={"layer": "BOX", "rotation": 90})
    msp.add_blockref("box c", (20, 0), dxfattribs={"layer": "BOX", "xscale": -1})
    msp.add_line((0, 0), (5, 5))
    doc.saveas(path)
    return path


def _import(database_url: str, root: Path, f: QueuedFile, job_id: uuid.UUID) -> str:
    deps = ImportDeps(
        PostgresCadRepository(database_url, batch_size=2),
        FsStorage(root),
        FailingConverter(),
        EzdxfReader(),
    )
    job = make_job(f.project_id, f.cad_file_id, job_id, f.storage_key, "dxf")
    return run_import(job, deps, "w1")


def test_import_stores_a_signature_per_insert_and_a_preview_per_shape(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f = make_cad_file(_boxes_dxf(tmp_path / "b.dxf").read_bytes(), "dxf", storage_root)
    assert _import(database_url, storage_root, f, f.job_id) == "processed"
    sigs = dict(
        db.execute(
            "SELECT block_name || ':' || ST_X(position)::int, shape_signature FROM cad_inserts "
            "WHERE cad_file_id = %s",
            (f.cad_file_id,),
        ).fetchall()
    )
    assert sigs["box c:0"] == sigs["box copy:10"] != sigs["box c:20"]
    shapes = db.execute(
        "SELECT shape_signature, preview FROM cad_file_shapes WHERE cad_file_id = %s "
        "ORDER BY shape_signature",
        (f.cad_file_id,),
    ).fetchall()
    assert sorted(s for s, _ in shapes) == sorted({sigs["box c:0"], sigs["box c:20"]})
    assert all(p["truncated"] is False and p["paths"] for _, p in shapes)

    # Reprocessing replaces the import output (no duplicate key, same rows).
    second = uuid.uuid4()
    db.execute(
        "UPDATE cad_files SET status = 'queued', current_job_id = %s WHERE id = %s",
        (second, f.cad_file_id),
    )
    assert _import(database_url, storage_root, f, second) == "processed"
    again = db.execute(
        "SELECT shape_signature FROM cad_file_shapes WHERE cad_file_id = %s ORDER BY 1",
        (f.cad_file_id,),
    ).fetchall()
    assert [s for (s,) in again] == sorted(s for s, _ in shapes)


# ---------- build ----------


def _secondary(db: psycopg.Connection[Any]) -> Any:
    seeded = seed_processed_file(db, drawing_kind="secondary")
    db.execute(
        "UPDATE cad_inserts SET shape_signature = %s WHERE cad_file_id = %s AND handle IN ('I1', 'I2')",
        (SIG_A, seeded.cad_file_id),
    )
    db.execute(
        "INSERT INTO cad_file_shapes (project_id, cad_file_id, shape_signature, preview) "
        "VALUES (%s, %s, %s, %s)",
        (seeded.project_id, seeded.cad_file_id, SIG_A, json.dumps(PREVIEW)),
    )
    return seeded


def _frozen(shape: str) -> dict[str, object]:
    return {
        "choices": [
            {
                "choiceId": CHOICE_ID,
                "shape": shape,
                "workOrderLineId": LINE_ID,
                "line": {"code": "B8-4", "description": "بوكس 8 فرعة", "label": "بوكس 8 فرعة"},
            }
        ]
    }


def _build(database_url: str, root: Path, revision: Any) -> str:
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(root))
    return run_build(revision.job(), deps, "w1")


def test_secondary_build_writes_the_gallery_and_the_type_on_each_box(
    database_url: str, db: psycopg.Connection[Any], storage_root: Path
) -> None:
    seeded = _secondary(db)
    revision = queue_revision(
        db, seeded, rules=ROLES_RULES, drawing_kind="secondary", box_types=_frozen(SIG_A)
    )
    assert _build(database_url, storage_root, revision) == "built"
    status, gallery, log = db.execute(
        "SELECT status, box_shapes, log FROM design_revisions WHERE id = %s",
        (revision.revision_id,),
    ).fetchone() or (None, None, None)
    assert status == "draft"
    assert gallery == {
        "version": 1,
        "boxCount": 2,
        "shapeCount": 1,
        "boxesWithoutShape": 0,
        "shapes": [
            {
                "shape": SIG_A,
                "source": "block",
                "count": 2,
                "blockNames": ["sub"],
                "sampleHandles": ["I1", "I2"],
                "preview": PREVIEW,
            }
        ],
    }
    assert "box shapes: 1 shapes, 2 boxes, 0 without a shape" in str(log)
    readings = [
        r
        for (r,) in db.execute(
            "SELECT attrs -> 'reading' FROM design_features WHERE revision_id = %s "
            "AND feature_type = 'box' ORDER BY source_handle",
            (revision.revision_id,),
        ).fetchall()
    ]
    assert [(r["shape"], r["boxType"]["code"]) for r in readings] == [(SIG_A, "B8-4")] * 2
    [payload] = [
        p
        for (t, p) in db.execute(
            "SELECT type, payload FROM events WHERE entity_id = %s", (str(revision.revision_id),)
        ).fetchall()
        if t == "design_revision.built"
    ]
    assert payload["boxShapes"]["shapes"] == [{"shape": SIG_A, "count": 2}]


def test_boxes_of_a_file_processed_before_0023_count_as_without_shape(
    database_url: str, db: psycopg.Connection[Any], storage_root: Path
) -> None:
    seeded = seed_processed_file(db, drawing_kind="secondary")
    revision = queue_revision(db, seeded, rules=ROLES_RULES, drawing_kind="secondary")
    assert _build(database_url, storage_root, revision) == "built"
    row = db.execute(
        "SELECT box_shapes FROM design_revisions WHERE id = %s", (revision.revision_id,)
    ).fetchone()
    assert row is not None
    assert (row[0]["boxCount"], row[0]["shapeCount"], row[0]["boxesWithoutShape"]) == (2, 0, 2)


def test_general_build_has_no_gallery_and_bad_box_types_fail(
    database_url: str, db: psycopg.Connection[Any], storage_root: Path
) -> None:
    general = queue_revision(db, seed_processed_file(db), rules=ROLES_RULES)
    assert _build(database_url, storage_root, general) == "built"
    row = db.execute(
        "SELECT box_shapes FROM design_revisions WHERE id = %s", (general.revision_id,)
    ).fetchone()
    assert row == (None,)

    bad = queue_revision(
        db,
        _secondary(db),
        rules=ROLES_RULES,
        drawing_kind="secondary",
        box_types={"choices": [{"shape": "box c", "workOrderLineId": LINE_ID}]},
    )
    assert _build(database_url, storage_root, bad) == "failed"
    failed = db.execute(
        "SELECT error_code FROM design_revisions WHERE id = %s", (bad.revision_id,)
    ).fetchone()
    assert failed == ("MAPPING_INVALID",)


# ---------- As-Built DXF ----------


def test_asbuilt_dxf_writes_one_box_type_mtext_per_typed_box(
    database_url: str, db: psycopg.Connection[Any], storage_root: Path
) -> None:
    seeded = seed_design(
        db,
        [
            ("B1", "box", "sub", "sub", "1-1", "POINT(325000 3340002)"),
            ("B2", "box", "sub", "sub", "1-2", "POINT(325010 3340002)"),
        ],
        published=False,
    )
    box_type = {"workOrderLineId": LINE_ID, "code": "B8-4", "label": "بوكس {8} فرعة\\"}
    db.execute(
        "UPDATE design_features SET attrs = %s WHERE feature_id = %s",
        (json.dumps({"reading": {"of": "box", "boxType": box_type}}), seeded.features["B1"]),
    )
    db.execute(
        "UPDATE design_revisions SET status = 'published', rev_no = 1, published_at = now() "
        "WHERE id = %s",
        (seeded.revision_id,),
    )
    q = queue_export(db, seeded)
    deps = ExportDeps(
        PostgresExportRepository(database_url), FsStorage(storage_root), EzdxfDxfWriter()
    )
    assert run_export(q.job(), deps, "w1") == "done"
    data = (storage_root / f"projects/{seeded.project_id}/asbuilt/{q.export_id}.dxf").read_bytes()
    doc, auditor = recover.read(io.BytesIO(data))
    assert not auditor.has_errors
    assert doc.layers.get("BOX_TYPE").color == 5
    found: Any = doc.modelspace().query('MTEXT[layer=="BOX_TYPE"]')
    [mtext] = found
    assert mtext.text == "B8-4\\Pبوكس \\{8\\} فرعة\\\\"
    assert mtext.plain_text(split=True) == ["B8-4", "بوكس {8} فرعة\\"]
    assert mtext.dxf.style == TEXT_STYLE
