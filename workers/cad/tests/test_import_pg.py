"""Whole import job against a real PostGIS: queued file -> rows, counters, events."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.import_job import ImportDeps, run_import
from tests.conftest import QueuedFile
from tests.support.dxf_samples import write_corrupt, write_sample
from tests.support.fakes import CopyConverter, FailingConverter, HookReader, make_job


def deps_for(database_url: str, root: Path, **overrides: Any) -> ImportDeps:
    base: dict[str, Any] = {
        "repo": PostgresCadRepository(database_url, batch_size=4),  # tiny batches: many COPYs
        "storage": FsStorage(root),
        "converter": FailingConverter(),
        "reader": EzdxfReader(),
    }
    return ImportDeps(**{**base, **overrides})


def job_of(f: QueuedFile, attempt: int = 1) -> Any:
    return make_job(f.project_id, f.cad_file_id, f.job_id, f.storage_key, f.format, attempt)  # type: ignore[arg-type]


def event_types(db: psycopg.Connection[Any], f: QueuedFile) -> list[str]:
    rows = db.execute(
        "SELECT type FROM events WHERE entity = 'cad_file' AND entity_id = %s ORDER BY id",
        (str(f.cad_file_id),),
    ).fetchall()
    return [r[0] for r in rows]


def count(db: psycopg.Connection[Any], table: str, f: QueuedFile) -> int:
    row = db.execute(
        f"SELECT count(*) FROM {table} WHERE cad_file_id = %s", (f.cad_file_id,)
    ).fetchone()
    assert row is not None
    return int(row[0])


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


def test_dxf_job_processes_into_postgis(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    data = write_sample(tmp_path / "s.dxf").read_bytes()
    f = make_cad_file(data, "dxf", storage_root)
    outcome = run_import(job_of(f), deps_for(database_url, storage_root), "w1")
    assert outcome == "processed"

    status = db.execute(
        "SELECT status, error_code, converter, dxf_version, ins_units, layer_count, insert_count, "
        "text_count, curve_count, extents_min_x, extents_max_y, processed_at, log, warnings "
        "FROM cad_files WHERE id = %s",
        (f.cad_file_id,),
    ).fetchone()
    assert status is not None
    assert status[:9] == ("processed", None, "none", "AC1032", 6, status[5], 5, 6, 8)
    assert status[9] == pytest.approx(0, abs=1e-6) and status[10] == pytest.approx(220)
    assert status[11] is not None and "extraction:" in status[12]
    assert {w["code"] for w in status[13]} >= {"UNSUPPORTED_ENTITY", "UNREADABLE_TEXT"}

    assert count(db, "cad_inserts", f) == 5 and count(db, "cad_texts", f) == 6
    assert count(db, "cad_curves", f) == 8 and count(db, "cad_layers", f) == status[5]
    assert event_types(db, f) == ["cad_file.processing_started", "cad_file.processed"]

    srid, kind, ndims = db.execute(
        "SELECT ST_SRID(geom), GeometryType(geom), ST_NDims(geom) FROM cad_curves "
        "WHERE cad_file_id = %s LIMIT 1",
        (f.cad_file_id,),
    ).fetchone() or (None, None, None)
    assert (srid, kind, ndims) == (0, "LINESTRING", 3)
    layer = db.execute(
        "SELECT aci_color, true_color, is_on, entity_counts->>'LWPOLYLINE' FROM cad_layers "
        "WHERE cad_file_id = %s AND name = 'TX'",
        (f.cad_file_id,),
    ).fetchone()
    assert layer == (1, 0xFF8800, True, None)
    readable = db.execute(
        "SELECT readable, text, raw_text FROM cad_texts WHERE cad_file_id = %s AND raw_text = 'lrhfv'",
        (f.cad_file_id,),
    ).fetchone()
    assert readable == (False, "lrhfv", "lrhfv")
    attrs = db.execute(
        'SELECT attributes FROM cad_inserts WHERE cad_file_id = %s AND attributes @> \'[{"rawValue": "S1"}]\'',
        (f.cad_file_id,),
    ).fetchone()
    assert attrs is not None and attrs[0][0]["tag"] == "NAME" and attrs[0][0]["readable"] is True


def test_dwg_job_stores_converted_dxf(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    data = write_sample(tmp_path / "s.dxf").read_bytes()
    f = make_cad_file(data, "dwg", storage_root)
    deps = deps_for(database_url, storage_root, converter=CopyConverter())
    assert run_import(job_of(f), deps, "w1") == "processed"
    row = db.execute(
        "SELECT converter, converter_version, converted_storage_key, log FROM cad_files WHERE id = %s",
        (f.cad_file_id,),
    ).fetchone()
    assert row is not None
    key = f"projects/{f.project_id}/cad/{f.cad_file_id}/converted.dxf"
    assert row[:3] == ("libredwg", "0.0-test", key) and "converted by CopyConverter" in row[3]
    assert (storage_root / key).read_bytes() == data
    warning = db.execute(
        "SELECT w FROM cad_files, jsonb_array_elements(warnings) w WHERE id = %s AND w->>'code' = 'DWG_CONVERTED'",
        (f.cad_file_id,),
    ).fetchone()
    assert warning is not None


@pytest.mark.parametrize(
    ("kind", "code"),
    [("corrupt", "DXF_UNREADABLE"), ("missing", "FILE_MISSING"), ("dwg", "CONVERTER_FAILED")],
)
def test_failure_paths(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
    kind: str,
    code: str,
) -> None:
    data = write_corrupt(tmp_path / "bad.dxf").read_bytes()
    f = make_cad_file(
        data, "dwg" if kind == "dwg" else "dxf", storage_root, write_object=kind != "missing"
    )
    assert run_import(job_of(f), deps_for(database_url, storage_root), "w1") == "failed"
    row = db.execute(
        "SELECT status, error_code, error_message, log, processed_at FROM cad_files WHERE id = %s",
        (f.cad_file_id,),
    ).fetchone()
    assert row is not None and row[0] == "failed" and row[1] == code and row[2] and row[4] is None
    if kind == "dwg":
        assert row[3] == "libredwg: boom"
    assert count(db, "cad_curves", f) == 0
    assert event_types(db, f) == ["cad_file.processing_started", "cad_file.failed"]
    payload = db.execute(
        "SELECT payload FROM events WHERE entity_id = %s AND type = 'cad_file.failed'",
        (str(f.cad_file_id),),
    ).fetchone()
    assert payload is not None and payload[0]["errorCode"] == code


def test_stale_job_is_dropped_without_touching_the_file(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f = make_cad_file(write_sample(tmp_path / "s.dxf").read_bytes(), "dxf", storage_root)
    db.execute(
        "UPDATE cad_files SET current_job_id = %s WHERE id = %s", (uuid.uuid4(), f.cad_file_id)
    )
    assert run_import(job_of(f), deps_for(database_url, storage_root), "w1") == "superseded"
    row = db.execute("SELECT status FROM cad_files WHERE id = %s", (f.cad_file_id,)).fetchone()
    assert row == ("queued",)
    assert event_types(db, f) == []
    assert count(db, "cad_curves", f) == 0


def test_job_superseded_while_processing_writes_nothing(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f = make_cad_file(write_sample(tmp_path / "s.dxf").read_bytes(), "dxf", storage_root)
    new_job = uuid.uuid4()

    def supersede() -> None:  # a reprocess request arrives while the worker is loading the file
        db.execute(
            "UPDATE cad_files SET status = 'queued', current_job_id = %s WHERE id = %s",
            (new_job, f.cad_file_id),
        )

    deps = deps_for(database_url, storage_root, reader=HookReader(supersede))
    assert run_import(job_of(f), deps, "w1") == "superseded"
    row = db.execute(
        "SELECT status, current_job_id FROM cad_files WHERE id = %s", (f.cad_file_id,)
    ).fetchone()
    assert row == ("queued", new_job)
    assert count(db, "cad_curves", f) == 0
    assert "cad_file.processed" not in event_types(db, f)


def test_reprocess_replaces_previous_rows(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    f = make_cad_file(write_sample(tmp_path / "s.dxf").read_bytes(), "dxf", storage_root)
    deps = deps_for(database_url, storage_root)
    assert run_import(job_of(f), deps, "w1") == "processed"
    second = uuid.uuid4()
    db.execute(
        "UPDATE cad_files SET status = 'queued', current_job_id = %s WHERE id = %s",
        (second, f.cad_file_id),
    )
    job = make_job(f.project_id, f.cad_file_id, second, f.storage_key, "dxf")
    assert run_import(job, deps, "w1") == "processed"
    assert count(db, "cad_curves", f) == 8 and count(db, "cad_inserts", f) == 5
    assert count(db, "cad_texts", f) == 6
    assert event_types(db, f).count("cad_file.processed") == 2


def test_failed_processing_rolls_back_partial_rows(
    database_url: str,
    db: psycopg.Connection[Any],
    make_cad_file: Any,
    storage_root: Path,
    tmp_path: Path,
) -> None:
    """A failure in the middle of the COPY stream leaves the previous (empty) state intact."""
    f = make_cad_file(write_sample(tmp_path / "s.dxf").read_bytes(), "dxf", storage_root)
    db.execute("ALTER TABLE cad_texts ADD CONSTRAINT boom CHECK (height < 0) NOT VALID")
    try:
        assert run_import(job_of(f), deps_for(database_url, storage_root), "w1") == "failed"
    finally:
        db.execute("ALTER TABLE cad_texts DROP CONSTRAINT boom")
    row = db.execute(
        "SELECT status, error_code FROM cad_files WHERE id = %s", (f.cad_file_id,)
    ).fetchone()
    assert row == ("failed", "INTERNAL")
    assert count(db, "cad_curves", f) == 0 and count(db, "cad_inserts", f) == 0
