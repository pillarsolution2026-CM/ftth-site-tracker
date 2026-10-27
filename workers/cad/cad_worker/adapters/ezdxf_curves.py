"""ezdxf entity -> CurveRow (LineStringZ vertices in drawing units, flattened with a tolerance)."""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from ezdxf.math import Vec3

from cad_worker.domain.flatten import arc_points, circle_points, polyline_points
from cad_worker.domain.model import CurveRow, CurveType, SkippedEntity, Xyz

CURVE_TYPES = frozenset({"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "SPLINE"})
_SPLINE_FRAME_FLAG = 16


def to_wcs(entity: Any, points: Iterable[Xyz]) -> list[Xyz]:
    """Convert OCS points to WCS when the entity has a non-default extrusion."""
    ocs = entity.ocs()
    if not ocs.transform:
        return list(points)
    return [_xyz(ocs.to_wcs(Vec3(p))) for p in points]


def _xyz(v: Vec3) -> Xyz:
    return (float(v.x), float(v.y), float(v.z))


def _aci(entity: Any) -> int:
    return max(0, min(256, int(entity.dxf.get("color", 256))))


def _row(
    entity: Any,
    kind: CurveType,
    points: list[Xyz],
    closed: bool,
    tolerance: float | None,
) -> CurveRow | SkippedEntity:
    layer = str(entity.dxf.layer)
    handle = str(entity.dxf.handle)
    if len(points) < 2:
        return SkippedEntity(layer, kind, "degenerate", handle)
    if not all(math.isfinite(c) for p in points for c in p):
        return SkippedEntity(layer, kind, "error", handle)
    return CurveRow(handle, kind, layer, tuple(points), closed, tolerance, _aci(entity))


def curve_from_entity(entity: Any, tolerance: float) -> CurveRow | SkippedEntity:
    kind: CurveType = entity.dxftype()
    if kind == "LINE":
        pts = [_xyz(Vec3(entity.dxf.start)), _xyz(Vec3(entity.dxf.end))]
        return _row(entity, kind, pts, False, None)
    if kind == "LWPOLYLINE":
        return _lwpolyline(entity, tolerance)
    if kind == "POLYLINE":
        return _polyline(entity, tolerance)
    if kind == "ARC":
        return _arc(entity, tolerance)
    if kind == "CIRCLE":
        c = Vec3(entity.dxf.center)
        radius = float(entity.dxf.radius)
        ring = [(x, y, c.z) for x, y in circle_points(c.x, c.y, radius, tolerance)]
        if radius <= 0:
            return SkippedEntity(str(entity.dxf.layer), kind, "degenerate", str(entity.dxf.handle))
        return _row(entity, kind, to_wcs(entity, ring), True, tolerance)
    return _spline(entity, tolerance)


def _lwpolyline(entity: Any, tolerance: float) -> CurveRow | SkippedEntity:
    verts = [(float(x), float(y), float(b)) for x, y, b in entity.get_points("xyb")]
    closed = bool(entity.closed)
    if len(verts) < 2:
        return SkippedEntity(
            str(entity.dxf.layer), "LWPOLYLINE", "degenerate", str(entity.dxf.handle)
        )
    xy, approximated = polyline_points(verts, closed, tolerance)
    z = float(entity.dxf.get("elevation", 0.0))
    pts = to_wcs(entity, [(x, y, z) for x, y in xy])
    return _row(entity, "LWPOLYLINE", pts, closed, tolerance if approximated else None)


def _polyline(entity: Any, tolerance: float) -> CurveRow | SkippedEntity:
    if entity.is_polygon_mesh or entity.is_poly_face_mesh:
        return SkippedEntity(
            str(entity.dxf.layer), "POLYLINE", "unsupported", str(entity.dxf.handle)
        )
    closed = bool(entity.is_closed)
    base_z = float(Vec3(entity.dxf.get("elevation", (0, 0, 0))).z)
    vertices = [v for v in entity.vertices if not v.dxf.get("flags", 0) & _SPLINE_FRAME_FLAG]
    if entity.is_2d_polyline:
        verts = [
            (float(v.dxf.location.x), float(v.dxf.location.y), float(v.dxf.get("bulge", 0.0)))
            for v in vertices
        ]
        if len(verts) < 2:
            return SkippedEntity(
                str(entity.dxf.layer), "POLYLINE", "degenerate", str(entity.dxf.handle)
            )
        xy, approximated = polyline_points(verts, closed, tolerance)
        pts = to_wcs(entity, [(x, y, base_z) for x, y in xy])
        return _row(entity, "POLYLINE", pts, closed, tolerance if approximated else None)
    pts3 = [_xyz(Vec3(v.dxf.location)) for v in vertices]
    if closed and pts3:
        pts3.append(pts3[0])
    return _row(entity, "POLYLINE", pts3, closed, None)


def _arc(entity: Any, tolerance: float) -> CurveRow | SkippedEntity:
    c = Vec3(entity.dxf.center)
    radius = float(entity.dxf.radius)
    if radius <= 0:
        return SkippedEntity(str(entity.dxf.layer), "ARC", "degenerate", str(entity.dxf.handle))
    start = math.radians(float(entity.dxf.start_angle))
    sweep = (math.radians(float(entity.dxf.end_angle)) - start) % (2.0 * math.pi)
    if sweep == 0.0:
        sweep = 2.0 * math.pi
    pts = to_wcs(
        entity, [(x, y, c.z) for x, y in arc_points(c.x, c.y, radius, start, sweep, tolerance)]
    )
    return _row(entity, "ARC", pts, False, tolerance)


def _spline(entity: Any, tolerance: float) -> CurveRow | SkippedEntity:
    try:
        pts = [_xyz(Vec3(p)) for p in entity.construction_tool().flattening(tolerance)]
    except Exception:  # malformed knots/weights: report, do not fail the whole drawing
        return SkippedEntity(str(entity.dxf.layer), "SPLINE", "error", str(entity.dxf.handle))
    return _row(entity, "SPLINE", pts, bool(entity.closed), tolerance)
