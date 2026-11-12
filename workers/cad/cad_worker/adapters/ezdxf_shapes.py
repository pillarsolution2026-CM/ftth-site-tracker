"""The drawn geometry of an INSERT for its shape signature (ADR-043), with ezdxf.

The INSERT is exploded as if it had no rotation and stood at 0,0 (a copy with rotation 0 and
insertion point 0,0): its scale factors (mirroring, non-uniform stretch) and its extrusion (OCS
flip) are kept, since they change the look. Nested blocks are exploded too; ATTRIB / ATTDEF are
left out (they are the box's data, not its symbol); constant TEXT / MTEXT are kept as texts.
Circles, arcs, ellipses and bulges are flattened at a fixed number of segments per turn
(`domain/box_shapes.py`); splines and hatch boundaries with a tolerance relative to their own
size, so the vertices never depend on the drawing's scale.

Work budget (security review M1): every entity visited while exploding a symbol — nested INSERT /
DIMENSION visits, texts and tokens included — is charged to an `ExplosionBudget`, per symbol and
per drawing, for the shape and for the drawn centre (ADR-032). Past it the symbol is «too
complex»: no shape (the box's shape is unknown, which blocks publishing) and its insertion point
as position. A block found too complex is remembered and never exploded again.

Cache (M2): the signature depends only on (block, scale, extrusion); keys -> signatures are kept
in a bounded LRU, and a preview is computed only for a signature not seen before (at most
MAX_FILE_SHAPES), handed out once.
"""

from __future__ import annotations

import math
from collections import OrderedDict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

from ezdxf import bbox
from ezdxf import path as ezpath
from ezdxf.math import BoundingBox, Vec3
from ezdxf.tools.text import plain_mtext

from cad_worker.domain.box_shapes import (
    MAX_FILE_SHAPES,
    MAX_SHAPE_SEGMENTS,
    ShapeGeometry,
    ShapeText,
    ShapeTooLargeError,
    arc_segments,
    fixed_polyline_points,
    shape_preview,
    shape_signature,
)
from cad_worker.domain.model import Xyz

Xy = tuple[float, float]
# Nested block depth explored (AutoCAD itself refuses cycles; this bounds pathological files).
MAX_NESTING = 16
# Entities visited per symbol (a real box symbol has tens to a few hundred) and per drawing (all
# symbols, shape and centre together). Technical DoS bounds, not business rules.
MAX_SYMBOL_ENTITIES = 20_000
MAX_DRAWING_ENTITIES = 20_000_000
MAX_SHAPE_TEXTS = 1_000
# Keys (block, scale, extrusion) -> signature remembered per drawing.
KEY_CACHE_SIZE = 10_000
KEY_DIGITS = 6
# Relative flattening distance for splines / hatch paths (of the curve's own extents).
RELATIVE_DISTANCE = 1e-3
_SKIPPED = frozenset({"ATTDEF", "ATTRIB"})
_LINE_LIKE = frozenset({"SOLID", "TRACE", "3DFACE"})
_NESTED = frozenset({"INSERT", "DIMENSION"})
_SPLINE_FRAME_FLAG = 16


class SymbolTooComplexError(ShapeTooLargeError):
    """The symbol (or the drawing) used up its explosion budget."""


class ExplosionBudget:
    """Entities left to visit in this drawing, the per-symbol allowance, and the blocks already
    found too complex."""

    def __init__(
        self, per_symbol: int = MAX_SYMBOL_ENTITIES, per_drawing: int = MAX_DRAWING_ENTITIES
    ) -> None:
        self.per_symbol = per_symbol
        self.remaining = per_drawing
        self._heavy: set[tuple[object, ...]] = set()

    def is_heavy(self, e: Any) -> bool:
        return self.remaining <= 0 or _heavy_key(e) in self._heavy

    def mark_heavy(self, e: Any) -> None:
        self._heavy.add(_heavy_key(e))

    def meter(self) -> _Meter:
        return _Meter(self)


class _Meter:
    __slots__ = ("_budget", "_left")

    def __init__(self, budget: ExplosionBudget) -> None:
        self._budget = budget
        self._left = budget.per_symbol

    def charge(self) -> None:
        self._left -= 1
        self._budget.remaining -= 1
        if self._left < 0 or self._budget.remaining < 0:
            raise SymbolTooComplexError("symbol too complex")


def _heavy_key(e: Any) -> tuple[object, ...]:
    """What a symbol's entity count depends on: its block and its array (never its transform)."""
    return (str(e.dxf.name), int(e.dxf.get("row_count", 1)), int(e.dxf.get("column_count", 1)))


def _is_multi(e: Any) -> bool:
    return int(e.dxf.get("row_count", 1)) > 1 or int(e.dxf.get("column_count", 1)) > 1


def _explode(e: Any) -> Iterator[Any]:
    if e.dxftype() == "INSERT" and _is_multi(e):
        for ref in e.multi_insert():
            yield from ref.virtual_entities()
    else:
        yield from e.virtual_entities()


def walk(e: Any, meter: _Meter, depth: int = 1) -> Iterator[Any]:
    """Every entity the INSERT / DIMENSION `e` draws, nested blocks visited (each yielded before
    its content) and charged to `meter`. ATTRIB / ATTDEF are left out."""
    if depth > MAX_NESTING:
        raise SymbolTooComplexError("blocks nested too deep")
    for child in _explode(e):
        meter.charge()
        kind = child.dxftype()
        if kind in _SKIPPED:
            continue
        yield child
        if kind in _NESTED and hasattr(child, "virtual_entities"):
            yield from walk(child, meter, depth + 1)


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

    def text(self, value: ShapeText) -> None:
        if len(self.texts) >= MAX_SHAPE_TEXTS:
            raise ShapeTooLargeError("symbol has too many texts")
        self.texts.append(value)

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
        out.text(ShapeText(float(at.x), float(at.y), height, rotation, text))


def _collect_one(e: Any, kind: str, out: _Collector) -> None:
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
    elif kind == "INSERT":
        if _is_multi(e):
            out.tokens.append(f"minsert:{e.dxf.row_count}x{e.dxf.column_count}")
    elif kind != "DIMENSION":
        out.tokens.append(f"entity:{kind}")


def _q(value: object) -> str:
    """A scale / extrusion component to KEY_DIGITS significant digits: noise far below the
    signature's 1/1000 quantization does not make a new key (review M2)."""
    return f"{float(value):.{KEY_DIGITS}g}"  # type: ignore[arg-type]


def _key(e: Any) -> tuple[object, ...]:
    return (
        str(e.dxf.name),
        _q(e.dxf.get("xscale", 1.0)),
        _q(e.dxf.get("yscale", 1.0)),
        _q(e.dxf.get("zscale", 1.0)),
        tuple(_q(v) for v in Vec3(e.dxf.get("extrusion", (0, 0, 1)))),
        int(e.dxf.get("row_count", 1)),
        int(e.dxf.get("column_count", 1)),
        _q(e.dxf.get("row_spacing", 0.0)),
        _q(e.dxf.get("column_spacing", 0.0)),
    )


def insert_geometry(e: Any, meter: _Meter) -> ShapeGeometry:
    """What the INSERT draws, rotation removed, insertion point at 0,0 (drawing units).
    Raises ShapeTooLargeError (SymbolTooComplexError past the budget)."""
    unrotated = e.copy()
    unrotated.dxf.rotation = 0.0
    unrotated.dxf.insert = (0.0, 0.0, 0.0)
    out = _Collector()
    if _is_multi(e):
        out.tokens.append(f"minsert:{e.dxf.row_count}x{e.dxf.column_count}")
    for child in walk(unrotated, meter):
        _collect_one(child, child.dxftype(), out)
    return out.geometry()


def drawn_centre(e: Any, budget: ExplosionBudget) -> tuple[Xyz | None, bool]:
    """Centre of what the INSERT draws (ADR-032), within the budget: (centre, too_complex).
    Attributes are left out: a long label must not pull the centre away."""
    if budget.is_heavy(e):
        return None, True
    try:
        leaves = [c for c in walk(e, budget.meter()) if c.dxftype() not in _NESTED]
    except SymbolTooComplexError:
        budget.mark_heavy(e)
        return None, True
    except Exception:
        return None, False
    try:
        box = bbox.extents(leaves, fast=True)
    except Exception:
        return None, False
    if not box.has_data:
        return None, False
    c = box.center
    point = (float(c.x), float(c.y), float(c.z))
    return (point if all(math.isfinite(v) for v in point) else None), False


@dataclass(frozen=True, slots=True)
class ShapeResult:
    """`signature` None: not read (`too_complex` tells why). `preview` only on the first insert
    of a signature (and only for the first MAX_FILE_SHAPES signatures)."""

    signature: str | None
    preview: dict[str, object] | None = None
    too_complex: bool = False


_UNREAD = ShapeResult(None)
_TOO_COMPLEX = ShapeResult(None, None, True)


class InsertShapes:
    """Signature per INSERT for one drawing, within the explosion budget."""

    def __init__(
        self, budget: ExplosionBudget | None = None, key_cache_size: int = KEY_CACHE_SIZE
    ) -> None:
        self.budget = budget or ExplosionBudget()
        self._size = key_cache_size
        self._keys: OrderedDict[tuple[object, ...], str | None] = OrderedDict()
        self._seen: set[str] = set()
        self.preview_count = 0

    @property
    def cached_keys(self) -> int:
        return len(self._keys)

    def read(self, e: Any) -> ShapeResult:
        try:
            key = _key(e)
            heavy = self.budget.is_heavy(e)
        except Exception:
            return _UNREAD
        sig: str | None
        if key in self._keys:
            self._keys.move_to_end(key)
            sig = self._keys[key]
            return _UNREAD if sig is None else ShapeResult(sig)
        if heavy:
            return _TOO_COMPLEX
        preview: dict[str, object] | None = None
        try:
            geometry = insert_geometry(e, self.budget.meter())
            sig = shape_signature(geometry, "block")
            if sig not in self._seen:
                self._seen.add(sig)
                if self.preview_count < MAX_FILE_SHAPES:
                    preview = shape_preview(geometry)
                    self.preview_count += 1
        except ShapeTooLargeError:
            self.budget.mark_heavy(e)
            return _TOO_COMPLEX
        except Exception:  # one unreadable symbol must not fail the drawing
            sig = None
        self._keys[key] = sig
        if len(self._keys) > self._size:
            self._keys.popitem(last=False)
        return _UNREAD if sig is None else ShapeResult(sig, preview)
