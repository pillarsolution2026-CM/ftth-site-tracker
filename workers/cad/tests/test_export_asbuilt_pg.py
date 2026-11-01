"""`cad.export_asbuilt` end to end against a real PostGIS (never mocked); the DXF is read back
with ezdxf (recover + audit). Opening in AutoCAD is a manual check, not covered here."""

from __future__ import annotations

import hashlib
import io
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest
from ezdxf import recover
from ezdxf.document import Drawing

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.ezdxf_writer import EzdxfDxfWriter
from cad_worker.adapters.postgres_export_repo import PostgresExportRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.export_asbuilt import ExportDeps, run_export
from cad_worker.domain.model import CurveRow, InsertRow, TextRow
from tests.support.asbuilt import (
    QueuedExport,
    SeededProject,
    approved_edit,
    line,
    point,
    project_state,
    queue_export,
    seed_design,
)
from tests.support.revisions import X0, Y0

TOL = 0.01  # metres (golden tolerance)
ARABIC_LABEL = "شارع النيل ١٢"
ADDED_LABEL = "كابل جديد F 12"


class CrashingWriter(EzdxfDxfWriter):
    def write(self, drawing: Any) -> bytes:
        raise MemoryError("boom")


class BrokenStorage(FsStorage):
    def upload(self, src: Path, key: str) -> None:
        raise OSError("disk full")


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def deps(database_url: str, storage_root: Path) -> ExportDeps:
    return ExportDeps(
        PostgresExportRepository(database_url), FsStorage(storage_root), EzdxfDxfWriter()
    )


def seed_network(db: psycopg.Connection[Any]) -> SeededProject:
    """Published revision: 2 routes, 2 boxes (one on an invalid layer name), 1 joint; approved
    As-Built: R1 reshaped, B1 moved + labelled, R2 label only, an added route and an added hhi."""
    seeded = seed_design(
        db,
        [
            ("R1", "route", "N_DUC_CBL", None, None, line((0, 0), (100, 0))),
            ("R2", "route", "N_DUC_CBL", None, "F 36 C", line((100, 0), (100, 50))),
            ("B1", "box", "sub", "sub", "1-1", point(0, 2)),
            ("B2", "box", "BAD<LAYER", "sub", "%%u1-2", point(100, 2)),
            ("J1", "joint", "jont 144", "JONT 144", None, point(100, 52)),
        ],
    )
    f = seeded.features
    r1 = line((0, 0), (50, 5), (100, 0))
    e = approved_edit(db, seeded, f["R1"], kind="reshape", feature_type="route", version=1, wkt=r1)
    project_state(db, seeded, f["R1"], feature_type="route", added=False, geometry=(r1, e, 1))

    b1 = point(1, 3)
    g = approved_edit(db, seeded, f["B1"], kind="move", feature_type="box", version=1, wkt=b1)
    lab = approved_edit(
        db, seeded, f["B1"], kind="label", feature_type="box", version=1, label="A\n0\nLINE"
    )
    project_state(
        db,
        seeded,
        f["B1"],
        feature_type="box",
        added=False,
        geometry=(b1, g, 1),
        label=("A\n0\nLINE", lab, 1),
    )

    lab2 = approved_edit(
        db, seeded, f["R2"], kind="label", feature_type="route", version=1, label=ARABIC_LABEL
    )
    project_state(
        db, seeded, f["R2"], feature_type="route", added=False, label=(ARABIC_LABEL, lab2, 1)
    )

    add_route, add_hhi = uuid.uuid4(), uuid.uuid4()
    seeded.features["ADD_R"], seeded.features["ADD_H"] = add_route, add_hhi
    ar = line((0, 10), (30, 10))
    e1 = approved_edit(
        db, seeded, add_route, kind="add_route", feature_type="route", version=1, wkt=ar,
        label=ADDED_LABEL,
    )  # fmt: skip
    project_state(
        db,
        seeded,
        add_route,
        feature_type="route",
        added=True,
        geometry=(ar, e1, 1),
        label=(ADDED_LABEL, e1, 1),
    )
    ah = point(30, 12)
    e2 = approved_edit(
        db, seeded, add_hhi, kind="add_symbol", feature_type="hhi", version=1, wkt=ah
    )
    project_state(db, seeded, add_hhi, feature_type="hhi", added=True, geometry=(ah, e2, 1))
    return seeded


def export_row(db: psycopg.Connection[Any], q: QueuedExport) -> dict[str, Any]:
    cur = db.execute(
        "SELECT status, error_code, storage_key, size_bytes, sha256, stats, started_at, "
        "finished_at FROM asbuilt_exports WHERE id = %s",
        (q.export_id,),
    )
    row = cur.fetchone()
    assert row is not None and cur.description is not None
    return dict(zip([c.name for c in cur.description], row, strict=True))


def events(db: psycopg.Connection[Any], q: QueuedExport) -> list[tuple[str, Any, Any]]:
    rows = db.execute(
        "SELECT type, actor_id, payload FROM events WHERE entity = 'asbuilt_export' "
        "AND entity_id = %s ORDER BY id",
        (str(q.export_id),),
    ).fetchall()
    return [(t, a, p) for t, a, p in rows]


def read_dxf(data: bytes) -> Drawing:
    doc, auditor = recover.read(io.BytesIO(data))
    assert not auditor.has_errors, [e.message for e in auditor.errors]
    assert not auditor.has_fixes, [f.message for f in auditor.fixes]
    audit = doc.audit()
    assert not audit.has_errors and not audit.has_fixes
    return doc


def near(a: Any, b: tuple[float, float]) -> bool:
    return bool(abs(a[0] - (X0 + b[0])) <= TOL and abs(a[1] - (Y0 + b[1])) <= TOL)


def vertices(polyline: Any) -> list[tuple[float, float]]:
    return [(float(x), float(y)) for x, y in polyline.get_points("xy")]


def texts(doc: Drawing, layer: str) -> list[str]:
    return sorted(t.dxf.text for t in doc.modelspace().query(f'TEXT[layer=="{layer}"]'))


def test_export_writes_audited_dxf_row_and_event(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    seeded = seed_network(db)
    q = queue_export(db, seeded)

    assert run_export(q.job(), deps, "w1") == "done"

    row = export_row(db, q)
    key = f"projects/{seeded.project_id}/asbuilt/{q.export_id}.dxf"
    data = (storage_root / key).read_bytes()
    assert row["status"] == "done" and row["error_code"] is None
    assert row["storage_key"] == key and row["size_bytes"] == len(data)
    assert row["sha256"] == hashlib.sha256(data).hexdigest()
    assert row["started_at"] is not None and row["finished_at"] is not None
    stats = {"designFeatures": 5, "editedFeatures": 3, "addedFeatures": 2}
    assert row["stats"] == stats
    [(etype, actor, payload)] = events(db, q)
    assert (etype, actor) == ("asbuilt_export.done", None)
    assert payload["stats"] == stats and payload["sizeBytes"] == len(data)
    assert payload["warnings"] == [{"code": "INVALID_LAYER_NAME", "count": 1}]

    doc = read_dxf(data)
    assert doc.dxfversion == "AC1032" and doc.header["$INSUNITS"] == 6
    assert doc.layers.get("ASBUILT_EDITS").color == 1
    assert doc.layers.get("ASBUILT_ADDED").color == 3
    for name in ("N_DUC_CBL", "sub", "jont 144", "INVALID_LAYER_1"):
        assert name in doc.layers
    assert "BAD<LAYER" not in doc.layers
    msp = doc.modelspace()
    assert len(msp.query("MTEXT")) == 0 and len(msp.query("LINE")) == 0

    # Design entities stay on their original layers (R1 under its edit).
    design_routes = sorted(vertices(e) for e in msp.query('LWPOLYLINE[layer=="N_DUC_CBL"]'))
    assert len(design_routes) == 2
    assert near(design_routes[0][0], (0, 0)) and near(design_routes[0][1], (100, 0))
    [sub_box] = msp.query('INSERT[layer=="sub"]')
    assert sub_box.dxf.name == "FTTH_BOX" and near(sub_box.dxf.insert, (0, 2))
    [joint] = msp.query('INSERT[layer=="jont 144"]')
    assert joint.dxf.name == "FTTH_JOINT"
    [bad] = msp.query('INSERT[layer=="INVALID_LAYER_1"]')
    assert near(bad.dxf.insert, (100, 2))
    assert texts(doc, "sub") == ["1-1"] and texts(doc, "N_DUC_CBL") == ["F 36 C"]
    # `%%u` is escaped: shown literally, never switching on underline.
    code: Any = msp.query('TEXT[layer=="INVALID_LAYER_1"]').first
    assert code.dxf.text == "%%%%%%u1-2" and code.plain_text() == "%%u1-2"

    # Approved As-Built edits.
    [edited_route] = msp.query('LWPOLYLINE[layer=="ASBUILT_EDITS"]')
    pts = vertices(edited_route)
    assert len(pts) == 3 and near(pts[1], (50, 5)) and near(pts[2], (100, 0))
    [moved] = msp.query('INSERT[layer=="ASBUILT_EDITS"]')
    assert moved.dxf.name == "FTTH_BOX" and near(moved.dxf.insert, (1, 3))
    assert texts(doc, "ASBUILT_EDITS") == sorted(
        ["A 0 LINE", "AS-BUILT G0 L1", "AS-BUILT G1 L0", "AS-BUILT G1 L1", ARABIC_LABEL]
    )

    # Added features.
    [added_route] = msp.query('LWPOLYLINE[layer=="ASBUILT_ADDED"]')
    apts = vertices(added_route)
    assert near(apts[0], (0, 10)) and near(apts[1], (30, 10))
    [added_hhi] = msp.query('INSERT[layer=="ASBUILT_ADDED"]')
    assert added_hhi.dxf.name == "FTTH_HHI" and near(added_hhi.dxf.insert, (30, 12))
    assert texts(doc, "ASBUILT_ADDED") == sorted(["AS-BUILT ADDED", "AS-BUILT ADDED", ADDED_LABEL])
    for name in ("FTTH_BOX", "FTTH_HHI", "FTTH_JOINT"):
        assert name in doc.blocks
    assert "FTTH_MH" not in doc.blocks  # only symbols that are used


def test_exported_dxf_loads_through_the_import_reader(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    """The file goes back through the worker's own read path (ezdxf recover + extraction)."""
    seeded = seed_network(db)
    q = queue_export(db, seeded)
    assert run_export(q.job(), deps, "w1") == "done"
    path = storage_root / f"projects/{seeded.project_id}/asbuilt/{q.export_id}.dxf"

    source = EzdxfReader().open(path)
    assert source.meta.ins_units == 6 and source.meta.recover_errors == 0
    rows = list(source.features())
    curves = [r for r in rows if isinstance(r, CurveRow)]
    inserts = [r for r in rows if isinstance(r, InsertRow)]
    text_rows = [r for r in rows if isinstance(r, TextRow)]
    assert len(curves) == 4 and len(inserts) == 5
    assert all(t.kind == "text" for t in text_rows)
    assert ARABIC_LABEL in {t.text for t in text_rows}


def test_second_delivery_does_nothing(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    q = queue_export(db, seed_network(db))
    assert run_export(q.job(), deps, "w1") == "done"
    first = export_row(db, q)
    path = storage_root / str(first["storage_key"])
    data = path.read_bytes()

    assert run_export(q.job(attempt=2), deps, "w2") == "superseded"
    assert export_row(db, q) == first
    assert path.read_bytes() == data
    assert [t for t, _, _ in events(db, q)] == ["asbuilt_export.done"]


def test_job_that_is_not_current_is_dropped(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    q = queue_export(db, seed_network(db))
    db.execute(
        "UPDATE asbuilt_exports SET current_job_id = %s WHERE id = %s", (uuid.uuid4(), q.export_id)
    )
    assert run_export(q.job(), deps, "w1") == "superseded"
    row = export_row(db, q)
    assert row["status"] == "queued" and row["started_at"] is None
    assert events(db, q) == []
    assert not (storage_root / "projects").exists()


def test_redelivered_job_after_crash_completes(
    db: psycopg.Connection[Any], deps: ExportDeps
) -> None:
    """A crash after `processing` leaves the row in `processing`; the redelivery finishes it."""
    q = queue_export(db, seed_network(db), status="processing")
    assert run_export(q.job(attempt=2), deps, "w2") == "done"
    assert export_row(db, q)["status"] == "done"


def test_export_without_any_as_built_change(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    seeded = seed_design(db, [("R1", "route", "N_DUC_CBL", None, None, line((0, 0), (5, 0)))])
    q = queue_export(db, seeded)
    assert run_export(q.job(), deps, "w1") == "done"
    row = export_row(db, q)
    assert row["stats"] == {"designFeatures": 1, "editedFeatures": 0, "addedFeatures": 0}
    doc = read_dxf((storage_root / str(row["storage_key"])).read_bytes())
    # Both As-Built layers exist even when empty.
    assert "ASBUILT_EDITS" in doc.layers and "ASBUILT_ADDED" in doc.layers
    assert events(db, q)[0][2]["warnings"] == []


def test_unpublished_revision_fails_the_export(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    seeded = seed_design(
        db, [("R1", "route", "N_DUC_CBL", None, None, line((0, 0), (5, 0)))], published=False
    )
    q = queue_export(db, seeded)
    assert run_export(q.job(), deps, "w1") == "failed"
    row = export_row(db, q)
    assert (row["status"], row["error_code"]) == ("failed", "REVISION_NOT_PUBLISHED")
    assert row["finished_at"] is not None and row["storage_key"] is None
    [(etype, actor, payload)] = events(db, q)
    assert (etype, actor, payload["errorCode"]) == (
        "asbuilt_export.failed",
        None,
        "REVISION_NOT_PUBLISHED",
    )
    assert not (storage_root / "projects").exists()
    # A failed export is final: the same job is not run again.
    assert run_export(q.job(attempt=2), deps, "w1") == "superseded"


def test_storage_failure_fails_and_writes_nothing(
    db: psycopg.Connection[Any], database_url: str, storage_root: Path
) -> None:
    deps = ExportDeps(
        PostgresExportRepository(database_url), BrokenStorage(storage_root), EzdxfDxfWriter()
    )
    q = queue_export(db, seed_network(db))
    assert run_export(q.job(), deps, "w1") == "failed"
    row = export_row(db, q)
    assert (row["status"], row["error_code"], row["stats"]) == ("failed", "STORAGE_FAILED", None)
    assert [t for t, _, _ in events(db, q)] == ["asbuilt_export.failed"]


def test_non_finite_coordinate_fails_with_geometry_invalid(
    db: psycopg.Connection[Any], deps: ExportDeps, storage_root: Path
) -> None:
    """PostGIS stores NaN coordinates; the export refuses to draw them."""
    seeded = seed_design(db, [("B1", "box", "sub", "sub", None, "POINT (NaN 1)")])
    q = queue_export(db, seeded)
    assert run_export(q.job(), deps, "w1") == "failed"
    assert export_row(db, q)["error_code"] == "GEOMETRY_INVALID"
    assert not (storage_root / "projects").exists()


def test_unexpected_error_fails_with_internal(
    db: psycopg.Connection[Any], database_url: str, storage_root: Path
) -> None:
    deps = ExportDeps(
        PostgresExportRepository(database_url), FsStorage(storage_root), CrashingWriter()
    )
    q = queue_export(db, seed_network(db))
    assert run_export(q.job(), deps, "w1") == "failed"
    assert export_row(db, q)["error_code"] == "INTERNAL"
    assert [p["errorCode"] for _, _, p in events(db, q)] == ["INTERNAL"]
