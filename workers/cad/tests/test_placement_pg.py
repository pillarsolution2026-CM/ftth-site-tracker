"""A revision built with a frozen placement (ADR-035), on PostGIS: features and tiles move together."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import psycopg
import pytest
from pmtiles.reader import MmapSource, Reader

from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from cad_worker.domain.placement import EGYPT_RED_BELT_PROJ4
from tests.support.revisions import X0, Y0, queue_revision, seed_processed_file

UTM_36N = "+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs"
TO_RED_BELT = {
    "cad_curves": "geom",
    "cad_inserts": "position",
    "cad_texts": "position",
}


def _build(
    db: psycopg.Connection[Any], tmp_path: Path, database_url: str, *, placement: object = None,
    red_belt: bool = False,
) -> dict[str, tuple[float, float]]:  # fmt: skip
    seeded = seed_processed_file(db)
    if red_belt:  # the same drawing, drawn in Egypt 1907 / Red Belt metres
        for table, column in TO_RED_BELT.items():
            sql = (
                f"UPDATE {table} SET {column} = ST_SetSRID(ST_Transform(ST_SetSRID({column}, 0), "
                f"%s, %s), ST_SRID({column})) WHERE cad_file_id = %s"
            )
            db.execute(sql, (UTM_36N, EGYPT_RED_BELT_PROJ4, seeded.cad_file_id))
    revision = queue_revision(db, seeded, placement=placement)
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(tmp_path))
    assert run_build(revision.job(), deps, "w1") == "built"
    rows = db.execute(
        "SELECT source_handle, ST_X(ST_StartPoint(geom)), ST_Y(ST_StartPoint(geom)) "
        "FROM design_features WHERE revision_id = %s AND GeometryType(geom) = 'LINESTRING' "
        "UNION ALL SELECT source_handle, ST_X(geom), ST_Y(geom) FROM design_features "
        "WHERE revision_id = %s AND GeometryType(geom) = 'POINT'",
        (revision.revision_id, revision.revision_id),
    ).fetchall()
    key = db.execute(
        "SELECT tiles_storage_key FROM design_revisions WHERE id = %s", (revision.revision_id,)
    ).fetchone()
    assert key is not None and key[0] is not None
    with (tmp_path / key[0]).open("rb") as f:
        header = Reader(MmapSource(f)).header()
    out = {str(h): (float(x), float(y)) for h, x, y in rows}
    out["tiles-min"] = (header["min_lon_e7"] / 1e7, header["min_lat_e7"] / 1e7)
    return out


def test_red_belt_drawing_lands_where_the_utm_drawing_is(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    utm = _build(db, tmp_path / "a", database_url)
    red = _build(
        db, tmp_path / "b", database_url, placement={"sourceCrs": "egypt_red_belt"}, red_belt=True
    )
    assert utm.keys() == red.keys() and len(utm) > 3
    for handle, (x, y) in utm.items():
        if handle == "tiles-min":
            assert red[handle] == pytest.approx((x, y), abs=2e-7), "tile bounds"
        else:
            assert math.dist(red[handle], (x, y)) < 0.01, handle


def test_a_hand_adjustment_moves_features_and_tiles_together(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    plain = _build(db, tmp_path / "a", database_url)
    turned = _build(
        db,
        tmp_path / "b",
        database_url,
        placement={
            "adjust": {
                "dx": 10,
                "dy": -5,
                "rotationDeg": 90,
                "scale": 1,
                "pivot": {"x": X0, "y": Y0},
            }
        },
    )
    for handle, (x, y) in plain.items():
        if handle == "tiles-min":
            continue
        expected = (X0 - (y - Y0) + 10, Y0 + (x - X0) - 5)  # 90 deg about (X0, Y0), then moved
        assert math.dist(turned[handle], expected) < 1e-6, handle
    assert turned["tiles-min"] != plain["tiles-min"]
