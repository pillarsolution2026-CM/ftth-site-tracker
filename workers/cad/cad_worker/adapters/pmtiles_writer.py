"""PMTiles archive of a design revision (ADR-021): `network` + `background` MVT layers, z12-18.

Tiles are cut by PostGIS (`ST_AsMVT`) inside the build's open transaction, so the archive shows
exactly the rows about to be committed. Both layers are first copied into temporary tables
already in web mercator with a GiST index; each tile is then one cheap indexed query.
Tiles are gzip-compressed and empty tiles are skipped. A tile whose buffered envelope touches no
geometry has no non-empty descendants, so the quadtree is only descended below non-empty areas.
"""

from __future__ import annotations

import gzip
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from cad_worker.application.ports import TileStats
from cad_worker.domain.design_build import BackgroundSelection
from cad_worker.domain.geo import lonlat_to_tile, project_crs

MIN_ZOOM = 12
MAX_ZOOM = 18
EXTENT = 4096
BUFFER = 64

_NETWORK_SQL = """
CREATE TEMP TABLE pm_network ON COMMIT DROP AS
SELECT f.feature_id::text AS id, f.feature_type AS type, f.code, f.layer, f.geom AS native,
       ST_Transform(f.geom, 3857) AS geom
  FROM design_features f
 WHERE f.revision_id = %(revision)s AND f.project_id = %(project)s
"""
# Raw drawing rows scaled by the revision's drawing unit (ADR-018) and placed in its CRS.
_BACKGROUND_SQL = """
CREATE TEMP TABLE pm_background ON COMMIT DROP AS
WITH src AS (
  SELECT c.layer, ST_SetSRID(ST_Scale(ST_Force2D(c.geom), %(f)s, %(f)s), %(srid)s) AS native
    FROM cad_curves c
   WHERE c.cad_file_id = %(file)s AND c.project_id = %(project)s AND c.layer = ANY(%(layers)s)
  UNION ALL
  SELECT i.layer, ST_SetSRID(ST_Scale(ST_Force2D(i.position), %(f)s, %(f)s), %(srid)s)
    FROM cad_inserts i
   WHERE i.cad_file_id = %(file)s AND i.project_id = %(project)s AND i.handle = ANY(%(handles)s)
)
SELECT layer, native, ST_Transform(native, 3857) AS geom FROM src
"""
_EXTENT_SQL = """
SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) FROM (
  SELECT ST_Extent(native) AS e FROM (
    SELECT native FROM pm_network UNION ALL SELECT native FROM pm_background) g) x
"""
_TILE_SQL = f"""
WITH env AS (
  SELECT ST_TileEnvelope(%(z)s, %(x)s, %(y)s) AS e,
         ST_TileEnvelope(%(z)s, %(x)s, %(y)s, margin => {BUFFER / EXTENT}) AS b
)
SELECT
  (SELECT ST_AsMVT(t, 'network', {EXTENT}, 'geom') FROM (
     SELECT ST_AsMVTGeom(n.geom, env.e, {EXTENT}, {BUFFER}, true) AS geom,
            n.id, n.type, n.code, n.layer
       FROM pm_network n WHERE n.geom && env.b) t WHERE t.geom IS NOT NULL),
  (SELECT ST_AsMVT(t, 'background', {EXTENT}, 'geom') FROM (
     SELECT ST_AsMVTGeom(g.geom, env.e, {EXTENT}, {BUFFER}, true) AS geom, g.layer
       FROM pm_background g WHERE g.geom && env.b) t WHERE t.geom IS NOT NULL),
  EXISTS (SELECT 1 FROM pm_network n WHERE n.geom && env.b)
    OR EXISTS (SELECT 1 FROM pm_background g WHERE g.geom && env.b)
FROM env
"""

_METADATA_LAYERS = [
    {
        "id": "network",
        "fields": {"id": "String", "type": "String", "code": "String", "layer": "String"},
        "minzoom": MIN_ZOOM,
        "maxzoom": MAX_ZOOM,
    },
    {"id": "background", "fields": {"layer": "String"}, "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM},
]


@dataclass(frozen=True, slots=True)
class TileSource:
    revision_id: UUID
    project_id: UUID
    cad_file_id: UUID
    crs_epsg: int
    metres_per_unit: Decimal
    background: BackgroundSelection


def write_revision_pmtiles(
    conn: psycopg.Connection[Any], source: TileSource, dest: Path
) -> TileStats:
    """Cut the tiles in PostGIS and write the archive to `dest` (nothing written when empty)."""
    _prepare(conn, source)
    bounds = _bounds_wgs84(conn, source.crs_epsg)
    if bounds is None:
        return TileStats(0, 0)
    tiles = _cut(conn, bounds)
    if not tiles:
        return TileStats(0, 0)
    _write_archive(dest, tiles, bounds, source.revision_id)
    return TileStats(len(tiles), dest.stat().st_size)


def _prepare(conn: psycopg.Connection[Any], s: TileSource) -> None:
    conn.execute("DROP TABLE IF EXISTS pm_network, pm_background")
    conn.execute(_NETWORK_SQL, {"revision": s.revision_id, "project": s.project_id})
    conn.execute(
        _BACKGROUND_SQL,
        {
            "f": float(s.metres_per_unit),  # geometry only; the exact factor stays on the revision
            "srid": s.crs_epsg,
            "file": s.cad_file_id,
            "project": s.project_id,
            "layers": sorted(s.background.curve_layers),
            "handles": sorted(s.background.insert_handles),
        },
    )
    conn.execute("CREATE INDEX ON pm_network USING gist (geom)")
    conn.execute("CREATE INDEX ON pm_background USING gist (geom)")


def _bounds_wgs84(
    conn: psycopg.Connection[Any], epsg: int
) -> tuple[float, float, float, float] | None:
    row = conn.execute(_EXTENT_SQL).fetchone()
    if row is None or row[0] is None:
        return None
    return project_crs(epsg).bounds_to_wgs84(*(float(v) for v in row))


def _cut(
    conn: psycopg.Connection[Any], bounds: tuple[float, float, float, float]
) -> dict[int, bytes]:
    min_lon, min_lat, max_lon, max_lat = bounds
    x0, y0 = lonlat_to_tile(min_lon, max_lat, MIN_ZOOM)  # tile y grows southwards
    x1, y1 = lonlat_to_tile(max_lon, min_lat, MIN_ZOOM)
    pending = [(MIN_ZOOM, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    tiles: dict[int, bytes] = {}
    while pending:
        z, x, y = pending.pop()
        row = conn.execute(_TILE_SQL, {"z": z, "x": x, "y": y}).fetchone()
        if row is None or not row[2]:
            continue
        mvt = bytes(row[0] or b"") + bytes(row[1] or b"")
        if mvt:
            tiles[zxy_to_tileid(z, x, y)] = gzip.compress(mvt, mtime=0)
        if z < MAX_ZOOM:
            pending.extend((z + 1, 2 * x + dx, 2 * y + dy) for dx in (0, 1) for dy in (0, 1))
    return tiles


def _e7(value: float) -> int:
    return round(value * 10_000_000)


def _write_archive(
    dest: Path,
    tiles: dict[int, bytes],
    bounds: tuple[float, float, float, float],
    revision_id: UUID,
) -> None:
    min_lon, min_lat, max_lon, max_lat = bounds
    header: dict[str, Any] = {
        "tile_type": TileType.MVT,
        "tile_compression": Compression.GZIP,
        "min_lon_e7": _e7(min_lon),
        "min_lat_e7": _e7(min_lat),
        "max_lon_e7": _e7(max_lon),
        "max_lat_e7": _e7(max_lat),
        "center_zoom": MIN_ZOOM,
        "center_lon_e7": _e7((min_lon + max_lon) / 2),
        "center_lat_e7": _e7((min_lat + max_lat) / 2),
    }
    metadata = {
        "name": f"design revision {revision_id}",
        "format": "pbf",
        "vector_layers": _METADATA_LAYERS,
    }
    with dest.open("wb") as f:
        writer = Writer(f)
        for tile_id in sorted(tiles):  # clustered archive: tiles in tile-id order
            writer.write_tile(tile_id, tiles[tile_id])
        writer.finalize(header, metadata)
