"""PMTiles archive of a built revision: read back with `pmtiles.reader` (round trip)."""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import Any

import psycopg
from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, TileType

from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from tests.support.revisions import queue_revision, seed_processed_file


def test_archive_round_trips_with_network_and_background_layers(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    revision = queue_revision(db, seed_processed_file(db))
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(tmp_path))
    assert run_build(revision.job(), deps, "w1") == "built"
    row = db.execute(
        "SELECT tiles_storage_key FROM design_revisions WHERE id = %s", (revision.revision_id,)
    ).fetchone()
    assert row is not None and row[0] is not None
    archive = tmp_path / row[0]

    with archive.open("rb") as f:
        get_bytes = MmapSource(f)
        header = Reader(get_bytes).header()
        assert header["tile_type"] == TileType.MVT
        assert header["tile_compression"] == Compression.GZIP
        assert (header["min_zoom"], header["max_zoom"]) == (12, 18)
        # Qalyub-like UTM 36N origin -> about 31.18 E, 30.18 N
        assert 31.1e7 < header["min_lon_e7"] <= header["max_lon_e7"] < 31.3e7
        assert 30.1e7 < header["min_lat_e7"] <= header["max_lat_e7"] < 30.3e7
        tiles = list(all_tiles(get_bytes))
        assert len(tiles) > 0 and header["addressed_tiles_count"] == len(tiles)
        assert {z for (z, _, _), _ in tiles} == set(range(12, 19))
        decoded = [gzip.decompress(data) for _, data in tiles]
        assert all(decoded)  # empty tiles are skipped
        assert any(b"network" in d for d in decoded)
        assert any(b"background" in d for d in decoded)
        z12 = [d for (zxy, _), d in zip(tiles, decoded, strict=True) if zxy[0] == 12]
        assert any(b"N_DUC_CBL" in d and b"building" in d for d in z12)
        metadata = Reader(get_bytes).metadata()
        assert [layer["id"] for layer in metadata["vector_layers"]] == ["network", "background"]


def test_revision_without_anything_to_draw_has_no_archive(
    db: psycopg.Connection[Any], database_url: str, tmp_path: Path
) -> None:
    rules = [{"source": "layer", "layer": "nothing-here", "target": "route"}]
    revision = queue_revision(db, seed_processed_file(db), rules=rules)
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(tmp_path))
    assert run_build(revision.job(), deps, "w1") == "built"
    row = db.execute(
        "SELECT status, tiles_storage_key, counts FROM design_revisions WHERE id = %s",
        (revision.revision_id,),
    ).fetchone()
    assert row is not None and row[:2] == ("draft", None)
    assert row[2]["routeLengthM"] == "0.000"
    assert not (tmp_path / "projects").exists()
