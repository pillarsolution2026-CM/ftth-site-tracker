"""`cad.build_revision` end to end against a real PostGIS (never mocked)."""

from __future__ import annotations

import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
import pytest

from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from tests.support.revisions import (
    QueuedRevision,
    SeededFile,
    publish,
    queue_revision,
    seed_processed_file,
)


class BrokenStorage(FsStorage):
    def upload(self, src: Path, key: str) -> None:
        raise OSError("disk full")


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def deps(database_url: str, storage_root: Path) -> BuildDeps:
    return BuildDeps(PostgresRevisionRepository(database_url), FsStorage(storage_root))


@pytest.fixture
def revision(db: psycopg.Connection[Any]) -> QueuedRevision:
    return queue_revision(db, seed_processed_file(db))


def revision_row(db: psycopg.Connection[Any], r: QueuedRevision) -> dict[str, Any]:
    cur = db.execute(
        "SELECT status, error_code, error_message, counts, text_link_counts, diff_counts, "
        "tiles_storage_key, warnings, log, built_at, build_started_at "
        "FROM design_revisions WHERE id = %s",
        (r.revision_id,),
    )
    row = cur.fetchone()
    assert row is not None and cur.description is not None
    return dict(zip([c.name for c in cur.description], row, strict=True))


def events(db: psycopg.Connection[Any], r: QueuedRevision) -> list[tuple[str, Any, Any]]:
    rows = db.execute(
        "SELECT type, actor_id, payload FROM events WHERE entity = 'design_revision' "
        "AND entity_id = %s ORDER BY id",
        (str(r.revision_id),),
    ).fetchall()
    return [(t, a, p) for t, a, p in rows]


def count(db: psycopg.Connection[Any], table: str, r: QueuedRevision) -> int:
    row = db.execute(
        f"SELECT count(*) FROM {table} WHERE revision_id = %s", (r.revision_id,)
    ).fetchone()
    assert row is not None
    return int(row[0])


def features(db: psycopg.Connection[Any], r: QueuedRevision) -> dict[str, tuple[Any, ...]]:
    rows = db.execute(
        "SELECT source_handle, feature_id, feature_type, code, length_m, ST_SRID(geom), "
        "ST_X(ST_StartPoint(geom)), attrs FROM design_features WHERE revision_id = %s",
        (r.revision_id,),
    ).fetchall()
    return {row[0]: tuple(row[1:]) for row in rows}


def test_build_writes_features_links_diff_counts_events_and_tiles(
    db: psycopg.Connection[Any], deps: BuildDeps, revision: QueuedRevision, storage_root: Path
) -> None:
    assert run_build(revision.job(), deps, "w1") == "built"

    row = revision_row(db, revision)
    assert row["status"] == "draft" and row["error_code"] is None and row["built_at"] is not None
    assert row["counts"] == {
        "features": {"route": 2, "box": 2, "hhi": 1, "joint": 1, "mh": 0},
        "routeLengthM": "200.000",
    }
    assert row["text_link_counts"] == {
        "auto": 2,
        "review": 1,
        "confirmed": 0,
        "rejected": 0,
        "unlinked": 1,
    }
    assert row["diff_counts"] == {
        "added": 6,
        "removed": 0,
        "unchanged": 0,
        "moved": 0,
        "reshaped": 0,
        "attributes_changed": 0,
        "conflict": 0,
    }
    assert row["warnings"] == [{"code": "ROUTE_ZERO_LENGTH_SKIPPED", "count": 1}]
    assert "units: 1 m = 1" in row["log"] and "tiles:" in row["log"]

    key = f"projects/{revision.project_id}/revisions/{revision.revision_id}/design.pmtiles"
    assert row["tiles_storage_key"] == key
    assert (storage_root / key).read_bytes()[:7] == b"PMTiles"

    rows = features(db, revision)
    assert set(rows) == {"C1", "C2", "I1", "I2", "I3", "T3"}
    assert rows["C1"][1:5] == ("route", None, Decimal("100.000"), 32636)
    assert rows["I1"][1:3] == ("box", "1-1")  # code from the auto box_id link
    assert rows["I1"][6]["attributes"][0]["value"] == "S1"
    assert rows["T3"][1] == "hhi" and rows["I3"][1] == "joint"
    assert rows["C1"][6]["texts"] == {"cable": ["F 36 C"]}
    first_revision = db.execute(
        "SELECT count(*) FROM features WHERE first_revision_id = %s", (revision.revision_id,)
    ).fetchone()
    assert first_revision == (6,)

    links = {
        r[0]: r[1:]
        for r in db.execute(
            "SELECT text_handle, kind, status, feature_id, distance_m, confidence, text, readable, "
            "ST_SRID(position) FROM text_links WHERE revision_id = %s",
            (revision.revision_id,),
        ).fetchall()
    }
    assert set(links) == {"T1", "T2", "T4", "T5"}  # T3 consumed by the text rule, T6 unmapped
    assert links["T1"][:3] == ("box_id", "auto", rows["I1"][0])
    assert links["T1"][3] == Decimal("1.118") and links["T1"][4] == Decimal("0.814")
    # T4 lies on route C2: confidence 1, yet an unreadable text is always reviewed.
    assert links["T4"][:5] == (
        "unreadable",
        "review",
        rows["C2"][0],
        Decimal("0.000"),
        Decimal("1.000"),
    )
    assert links["T4"][5:7] == (None, False)  # never guessed
    assert links["T5"][:4] == ("other", "unlinked", None, None)
    assert links["T2"][7] == 32636

    assert [(t, a) for t, a, _ in events(db, revision)] == [
        ("design_revision.build_started", None),
        ("design_revision.built", None),
    ]
    built = events(db, revision)[1][2]
    assert built["counts"] == row["counts"] and built["hasTiles"] is True


def test_inch_unit_scales_every_length(db: psycopg.Connection[Any], deps: BuildDeps) -> None:
    """ADR-018: the same drawing in inches is 0.0254 times as long; nothing assumes metres."""
    revision = queue_revision(db, seed_processed_file(db), unit="in")
    assert run_build(revision.job(), deps, "w1") == "built"
    row = revision_row(db, revision)
    assert row["counts"]["routeLengthM"] == "5.080"
    assert features(db, revision)["C1"][3] == Decimal("2.540")
    assert "units: 1 in = 0.025400 m" in row["log"]


def test_second_revision_keeps_ids_and_reports_the_moved_box(
    db: psycopg.Connection[Any], deps: BuildDeps, revision: QueuedRevision
) -> None:
    assert run_build(revision.job(), deps, "w1") == "built"
    publish(db, revision)
    first = features(db, revision)
    db.execute(
        "UPDATE cad_inserts SET position = ST_Translate(position, 2, 0, 0) "
        "WHERE cad_file_id = %s AND handle = 'I2'",
        (revision.cad_file_id,),
    )
    seeded = SeededFile(revision.project_id, revision.cad_file_id)
    second = queue_revision(db, seeded, base_revision_id=revision.revision_id)
    assert run_build(second.job(), deps, "w1") == "built"

    now = features(db, second)
    assert {h: v[0] for h, v in now.items()} == {h: v[0] for h, v in first.items()}
    diff = {
        r[0]: r[1:]
        for r in db.execute(
            "SELECT feature_id, change, distance_m, length_delta_m, previous_code, code "
            "FROM revision_diff_items WHERE revision_id = %s",
            (second.revision_id,),
        ).fetchall()
    }
    moved = diff[first["I2"][0]]
    assert moved[:2] == ("moved", Decimal("2.000"))
    assert diff[first["C1"][0]][:3] == ("unchanged", Decimal("0.000"), Decimal("0.000"))
    assert diff[first["I1"][0]][3:] == ("1-1", "1-1")
    assert revision_row(db, second)["diff_counts"]["unchanged"] == 5
    new_ids = db.execute(
        "SELECT count(*) FROM features WHERE first_revision_id = %s", (second.revision_id,)
    ).fetchone()
    assert new_ids == (0,)


def test_superseded_job_writes_nothing(
    db: psycopg.Connection[Any], deps: BuildDeps, revision: QueuedRevision
) -> None:
    db.execute(
        "UPDATE design_revisions SET current_job_id = %s WHERE id = %s",
        (uuid.uuid4(), revision.revision_id),
    )
    assert run_build(revision.job(), deps, "w1") == "superseded"
    assert revision_row(db, revision)["status"] == "queued"
    assert events(db, revision) == []
    assert count(db, "design_features", revision) == 0 and count(db, "text_links", revision) == 0


def test_file_not_processed_fails_the_revision(
    db: psycopg.Connection[Any], deps: BuildDeps
) -> None:
    revision = queue_revision(db, seed_processed_file(db, status="processing"))
    assert run_build(revision.job(), deps, "w1") == "failed"
    row = revision_row(db, revision)
    assert (row["status"], row["error_code"]) == ("failed", "CAD_FILE_NOT_PROCESSED")
    assert [t for t, _, _ in events(db, revision)] == [
        "design_revision.build_started",
        "design_revision.failed",
    ]
    assert events(db, revision)[1][2]["errorCode"] == "CAD_FILE_NOT_PROCESSED"
    assert count(db, "design_features", revision) == 0


def test_invalid_rules_fail_with_mapping_invalid(
    db: psycopg.Connection[Any], deps: BuildDeps
) -> None:
    rules = [{"source": "layer", "layer": "X", "target": "pipe"}]
    revision = queue_revision(db, seed_processed_file(db), rules=rules)
    assert run_build(revision.job(), deps, "w1") == "failed"
    assert revision_row(db, revision)["error_code"] == "MAPPING_INVALID"


def test_tile_upload_failure_rolls_back_everything(
    db: psycopg.Connection[Any], database_url: str, revision: QueuedRevision, storage_root: Path
) -> None:
    deps = BuildDeps(PostgresRevisionRepository(database_url), BrokenStorage(storage_root))
    assert run_build(revision.job(), deps, "w1") == "failed"
    row = revision_row(db, revision)
    assert (row["status"], row["error_code"]) == ("failed", "TILES_FAILED")
    # Readers get a fixed message; the exception text is kept in the log only (review L3).
    assert row["error_message"] == "Tile generation failed." and row["counts"] is None
    log = db.execute(
        "SELECT log FROM design_revisions WHERE id = %s", (revision.revision_id,)
    ).fetchone()
    assert log is not None and "disk full" in log[0]
    assert count(db, "design_features", revision) == 0
    assert count(db, "revision_diff_items", revision) == 0


def test_crash_after_start_is_retried_cleanly(
    db: psycopg.Connection[Any], deps: BuildDeps, revision: QueuedRevision
) -> None:
    """A redelivered job (status still `building`) rebuilds from scratch."""
    db.execute(
        "UPDATE design_revisions SET status = 'building' WHERE id = %s", (revision.revision_id,)
    )
    assert run_build(revision.job(attempt=2), deps, "w2") == "built"
    assert count(db, "design_features", revision) == 6


def test_published_revision_is_never_rebuilt_and_triggers_protect_it(
    db: psycopg.Connection[Any], deps: BuildDeps, revision: QueuedRevision
) -> None:
    assert run_build(revision.job(), deps, "w1") == "built"
    publish(db, revision)
    before = (count(db, "design_features", revision), len(events(db, revision)))

    assert run_build(revision.job(), deps, "w1") == "superseded"
    assert (count(db, "design_features", revision), len(events(db, revision))) == before
    assert revision_row(db, revision)["status"] == "published"

    for sql in (
        "DELETE FROM design_features WHERE revision_id = %s",
        "DELETE FROM text_links WHERE revision_id = %s",
        "DELETE FROM revision_diff_items WHERE revision_id = %s",
        "UPDATE design_revisions SET status = 'building' WHERE id = %s",
    ):
        with pytest.raises(psycopg.errors.RestrictViolation):
            db.execute(sql, (revision.revision_id,))
    with pytest.raises(psycopg.errors.RestrictViolation):
        db.execute(
            "UPDATE features SET feature_type = 'mh' WHERE first_revision_id = %s",
            (revision.revision_id,),
        )
    assert count(db, "design_features", revision) == before[0]
