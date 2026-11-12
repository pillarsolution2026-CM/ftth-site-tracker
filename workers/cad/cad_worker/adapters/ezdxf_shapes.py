"""The drawn geometry of an INSERT for its shape signature (ADR-043), with ezdxf.

The INSERT is exploded as if it had no rotation and stood at 0,0 (a copy with rotation 0 and
insertion point 0,0): its scale factors (mirroring, non-uniform stretch) and its extrusion (OCS
flip) are kept, since they change the look. Nested blocks are exploded too; ATTRIB / ATTDEF are
left out (they are the box's data, not its symbol); constant TEXT / MTEXT are kept as texts.
Circles, arcs, ellipses and bulges are flattened at a fixed number of segments per turn
(`domain/box_shapes.py`); splines and hatch boundaries with a tolerance relative to their own
size, so the vertices never depend on the drawing's scale.

The result depends only on (block, scale, extrusion), so it is cached per drawing.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from ezdxf import path as ezpath
from ezdxf.math import BoundingBox, Vec3
from ezdxf.tools.text import plain_mtext

from cad_worker.domain.box_shapes import (
    MAX_SHAPE_SEGMENTS,
    ShapeGeometry,
    ShapeText,
    ShapeTooLargeError,
    arc_segments,
    fixed_polyline_points,
    shape_preview,
    shape_signature,
)

Xy = tuple[float, float]
# Nested block depth explored (AutoCAD itself refuses cycles; this bounds pathological files).
MAX_NESTING = 16
# Relative flattening distance for splines / hatch paths (of the curve's own extents).
RELATIVE_DISTANCE = 1e-3
_SKIPPED = frozenset({"ATTDEF", "ATTRIB"})
_LINE_LIKE = frozenset({"SOLID", "TRACE", "3DFACE"})
_SPLINE_FRAME_FLAG = 16

ShapeRead = tuple[str, dict[str, object]]


class _Collector:
    def __init__(self) -> None:
        self.paths: list[tuple[Xy, ...]] = []
        self.texts: list[ShapeText] = []
        self.tokens: list[str] = []
        self.vertices = 0

    def path(self, points: Iterable[Any]) -> None:
        pts = tuple((float(p[0]), float(p[1])) for p in points)
        self.vertices += len(pts)
        if self.vertices > 4 * MAX_SHAPE_SEGMENTS:
            raise ShapeTooLargeError("symbol has too many vertices")
        if pts:
            self.paths.append(pts)

    def geometry(self) -> ShapeGeometry:
        return ShapeGeometry(tuple(self.paths), tuple(self.texts), tuple(self.tokens))


def _wcs(entity: Any, points: Iterable[tuple[float, float, float]]) -> list[Vec3]:
    ocs = entity.ocs()
    return [ocs.to_wcs(Vec3(p)) if ocs.transform else Vec3(p) for p in points]


def _relative_distance(points: Iterable[Any]) -> float:
    box = BoundingBox(points)
    if not box.has_data:
        return 1.0
    size = max(box.size.x, box.size.y, box.size.z)
    return size * RELATIVE_DISTANCE if size > 0 else 1.0


def _circle(e: Any, out: _Collector, start: float, sweep: float) -> None:
    c = Vec3(e.dxf.center)
    r = float(e.dxf.radius)
    n = arc_segments(sweep)
    pts = [
        (c.x + r * math.cos(start + sweep * i / n), c.y + r * math.sin(start + sweep * i / n), c.z)
        for i in range(n + 1)
    ]
    out.path(_wcs(e, pts))


def _ellipse(e: Any, out: _Collector) -> None:
    ct = e.construction_tool()
    start = float(ct.start_param)
    sweep = (float(ct.end_param) - start) % (2.0 * math.pi) or 2.0 * math.pi
    n = arc_segments(sweep)
    out.path(ct.vertices([start + sweep * i / n for i in range(n + 1)]))


def _bulged(e: Any, verts: list[tuple[float, float, float]], closed: bool, z: float) -> list[Vec3]:
    return _wcs(e, [(x, y, z) for x, y in fixed_polyline_points(verts, closed)])


def _lwpolyline(e: Any, out: _Collector) -> None:
    verts = [(float(x), float(y), float(b)) for x, y, b in e.get_points("xyb")]
    out.path(_bulged(e, verts, bool(e.closed), float(e.dxf.get("elevation", 0.0))))


def _polyline(e: Any, out: _Collector) -> None:
    if e.is_polygon_mesh or e.is_poly_face_mesh:
        out.tokens.append("entity:POLYLINE_MESH")
        return
    vertices = [v for v in e.vertices if not v.dxf.get("flags", 0) & _SPLINE_FRAME_FLAG]
    if e.is_2d_polyline:
        verts = [
            (float(v.dxf.location.x), float(v.dxf.location.y), float(v.dxf.get("bulge", 0.0)))
            for v in vertices
        ]
        z = float(Vec3(e.dxf.get("elevation", (0, 0, 0))).z)
        out.path(_bulged(e, verts, bool(e.is_closed), z))
        return
    pts = [Vec3(v.dxf.location) for v in vertices]
    if e.is_closed and pts:
        pts.append(pts[0])
    out.path(pts)


def _spline(e: Any, out: _Collector) -> None:
    ct = e.construction_tool()
    out.path(ct.flattening(_relative_distance(ct.control_points)))


def _hatch(e: Any, out: _Collector) -> None:
    out.tokens.append("hatch:solid" if int(e.dxf.get("solid_fill", 0)) else "hatch:pattern")
    for p in ezpath.from_hatch(e):
        if len(p) == 0:
            continue
        pts = list(p.flattening(_relative_distance(p.control_vertices())))
        if pts and pts[0] != pts[-1]:
            pts.append(pts[0])
        out.path(pts)


def _text(e: Any, kind: str, out: _Collector) -> None:
    if kind == "MTEXT":
        text = str(plain_mtext(str(e.text), split=False))
        at, height = Vec3(e.dxf.insert), float(e.dxf.get("char_height", 0.0))
        rotation = float(e.get_rotation())
    else:
        text = str(e.dxf.get("text", ""))
        at = _wcs(e, [tuple(Vec3(e.dxf.insert))])[0]
        height, rotation = float(e.dxf.get("height", 0.0)), float(e.dxf.get("rotation", 0.0))
    text = text.replace("\x00", "").strip()
    if text:
        out.texts.append(ShapeText(float(at.x), float(at.y), height, rotation, text))


def _collect(entities: Iterable[Any], out: _Collector, depth: int) -> None:
    for e in entities:
        kind = e.dxftype()
        if kind in _SKIPPED:
            continue
        if kind == "LINE":
            out.path([Vec3(e.dxf.start), Vec3(e.dxf.end)])
        elif kind == "LWPOLYLINE":
            _lwpolyline(e, out)
        elif kind == "POLYLINE":
            _polyline(e, out)
        elif kind == "CIRCLE":
            _circle(e, out, 0.0, 2.0 * math.pi)
        elif kind == "ARC":
            start = math.radians(float(e.dxf.start_angle))
            sweep = (math.radians(float(e.dxf.end_angle)) - start) % (2.0 * math.pi)
            _circle(e, out, start, sweep or 2.0 * math.pi)
        elif kind == "ELLIPSE":
            _ellipse(e, out)
        elif kind == "SPLINE":
            _spline(e, out)
        elif kind == "HATCH":
            _hatch(e, out)
        elif kind in ("TEXT", "MTEXT"):
            _text(e, kind, out)
        elif kind in _LINE_LIKE:
            out.tokens.append(f"entity:{kind}")
            for p in ezpath.make_path(e).sub_paths():
                out.path(p.flattening(1.0))  # straight edges only
        elif kind in ("INSERT", "DIMENSION") and hasattr(e, "virtual_entities"):
            if depth >= MAX_NESTING:
                raise ShapeTooLargeError("blocks nested too deep")
            if kind == "INSERT" and _is_multi(e):
                out.tokens.append(f"minsert:{e.dxf.row_count}x{e.dxf.column_count}")
            _collect(e.virtual_entities(), out, depth + 1)
        else:
            out.tokens.append(f"entity:{kind}")


def _is_multi(e: Any) -> bool:
    return int(e.dxf.get("row_count", 1)) > 1 or int(e.dxf.get("column_count", 1)) > 1


def _key(e: Any) -> tuple[object, ...]:
    return (
        str(e.dxf.name),
        float(e.dxf.get("xscale", 1.0)),
        float(e.dxf.get("yscale", 1.0)),
        float(e.dxf.get("zscale", 1.0)),
        tuple(float(v) for v in Vec3(e.dxf.get("extrusion", (0, 0, 1)))),
        int(e.dxf.get("row_count", 1)),
        int(e.dxf.get("column_count", 1)),
        float(e.dxf.get("row_spacing", 0.0)),
        float(e.dxf.get("column_spacing", 0.0)),
    )


def insert_geometry(e: Any) -> ShapeGeometry:
    """What the INSERT draws, rotation removed, insertion point at 0,0 (drawing units)."""
    unrotated = e.copy()
    unrotated.dxf.rotation = 0.0
    unrotated.dxf.insert = (0.0, 0.0, 0.0)
    out = _Collector()
    if _is_multi(e):
        out.tokens.append(f"minsert:{e.dxf.row_count}x{e.dxf.column_count}")
        for ref in unrotated.multi_insert():
            _collect(ref.virtual_entities(), out, 1)
    else:
        _collect(unrotated.virtual_entities(), out, 1)
    return out.geometry()


class InsertShapes:
    """Signature and preview per INSERT, cached per (block, scale, extrusion) for one drawing."""

    def __init__(self) -> None:
        self._cache: dict[tuple[object, ...], ShapeRead | None] = {}

    def read(self, e: Any) -> ShapeRead | None:
        """(signature, preview), or None when the symbol cannot be read (shape unknown)."""
        try:
            key = _key(e)
        except Exception:
            return None
        if key in self._cache:
            return self._cache[key]
        try:
            geometry = insert_geometry(e)
            found: ShapeRead | None = (shape_signature(geometry, "block"), shape_preview(geometry))
        except Exception:  # one unreadable symbol must not fail the drawing
            found = None
        self._cache[key] = found
        return found
