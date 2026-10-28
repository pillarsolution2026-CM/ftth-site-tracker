"""WKT text for geometry columns: 3D rows of the raw extraction (SRID 0, parsed by PostGIS in
`COPY ... FROM STDIN`) and 2D design geometry (the SRID is set in SQL)."""

from __future__ import annotations

from collections.abc import Iterable

from cad_worker.domain.model import Xyz


def point_z(p: Xyz) -> str:
    return f"POINT Z ({p[0]!r} {p[1]!r} {p[2]!r})"


def linestring_z(points: Iterable[Xyz]) -> str:
    return "LINESTRING Z (" + ", ".join(f"{x!r} {y!r} {z!r}" for x, y, z in points) + ")"


def point_2d(p: tuple[float, float]) -> str:
    return f"POINT ({p[0]!r} {p[1]!r})"


def linestring_2d(points: Iterable[tuple[float, float]]) -> str:
    return "LINESTRING (" + ", ".join(f"{x!r} {y!r}" for x, y in points) + ")"
