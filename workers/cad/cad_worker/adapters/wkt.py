"""WKT text for geometry columns (SRID 0 typmod): PostGIS parses it in `COPY ... FROM STDIN`."""

from __future__ import annotations

from collections.abc import Iterable

from cad_worker.domain.model import Xyz


def point_z(p: Xyz) -> str:
    return f"POINT Z ({p[0]!r} {p[1]!r} {p[2]!r})"


def linestring_z(points: Iterable[Xyz]) -> str:
    return "LINESTRING Z (" + ", ".join(f"{x!r} {y!r} {z!r}" for x, y, z in points) + ")"
