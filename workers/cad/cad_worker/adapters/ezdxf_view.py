"""ezdxf -> DrawingView (ADR-039): every model-space entity flattened on its own.

Each top-level entity is decomposed with `ezdxf.disassemble.recursive_decompose` (blocks exploded
recursively with their attributes, dimensions / leaders into their parts); every part becomes
polylines (curves and bulges flattened, hatch boundaries as outlines, meshes as face outlines) or
texts, all under the top-level handle. The file is read like the import (`ezdxf.recover`, the same
text decoder and style fonts), so texts read the same as in `cad_texts`.

Bounded work (security review M1): the decomposition is consumed lazily and stops as soon as the
entity exceeds the builder's remaining budget (vertices, texts, parts); the model-space loop stops
once nothing more can be added; vertices are pulled from lazy flattening, never materialised past
the budget. The whole render runs in a child process with a timeout and a memory limit
(`adapters/view_process.py`).

One bad entity (or one bad part of a block) never fails the drawing: it is counted and skipped.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from ezdxf import recover
from ezdxf.colors import aci2rgb
from ezdxf.disassemble import make_primitive, recursive_decompose
from ezdxf.math import BoundingBox, Vec3
from ezdxf.path import make_path
from ezdxf.tools.text import plain_mtext

from cad_worker.adapters.ezdxf_curves import to_wcs
from cad_worker.adapters.ezdxf_reader import _clean, _rgb, _text_anchor
from cad_worker.application.ports import RenderOutput, ViewFailure
from cad_worker.domain.drawing_view import (
    BLOCK_NAME_MAX_LENGTH,
    DRAWING_VIEW_MAX_JSON_BYTES,
    DRAWING_VIEW_MAX_PARTS,
    DRAWING_VIEW_MAX_TEXTS,
    DRAWING_VIEW_MAX_VERTICES,
    HANDLE_MAX_LENGTH,
    DrawingViewBuilder,
    EntityShapes,
    RenderedView,
    RenderStats,
    ViewGeometry,
    ViewInsert,
    ViewLayer,
    ViewTooLargeError,
    arc_geometry,
    ellipse_geometry,
    hex_color,
    polyline_geometry,
    shape_sagitta,
    utf16_cut,
    utf16_length,
    view_sagitta,
    write_view_gzip,
)
from cad_worker.domain.extents import Extents
from cad_worker.domain.text_decoder import TextDecoder

PROXY_TYPES = frozenset({"ACAD_PROXY_ENTITY", "PROXY_ENTITY"})
# Curves flattened by the entity itself (more precise than the Bézier path).
_CURVES = frozenset({"ARC", "CIRCLE", "ELLIPSE", "SPLINE", "HELIX"})
_TEXTS = frozenset({"TEXT", "ATTRIB", "ATTDEF"})
_BYLAYER = 256
_BYBLOCK = 0
_WHITE = 7
_BLACK = "#000000"


def _aci_hex(aci: int) -> str:
    if aci in (_WHITE, _BYBLOCK) or not 1 <= aci <= 255:
        return _BLACK  # white / by-block draw black on the white canvas
    rgb = aci2rgb(aci)
    return hex_color((rgb.r << 16) | (rgb.g << 8) | rgb.b)


def entity_color(entity: Any) -> str | None:
    """`#rrggbb` from the true colour, else the ACI; None when BYLAYER."""
    true_color = _rgb(entity.dxf.get("true_color"))
    if true_color is not None:
        return hex_color(true_color)
    aci = int(entity.dxf.get("color", _BYLAYER))
    if aci == _BYLAYER:
        return None
    return _aci_hex(aci)


def layer_color(layer: Any) -> str:
    true_color = _rgb(layer.dxf.get("true_color"))
    if true_color is not None:
        return hex_color(true_color)
    return _aci_hex(abs(int(layer.dxf.get("color", _WHITE))) or _WHITE)


def _layers(doc: Any) -> list[ViewLayer]:
    out: list[ViewLayer] = []
    for layer in doc.layers:
        out.append(
            ViewLayer(
                name=_clean(str(layer.dxf.name)),
                color=layer_color(layer),
                visible=bool(layer.is_on()) and not bool(layer.is_frozen()),
            )
        )
    return out


def _xy(points: Iterable[Any]) -> Iterator[tuple[float, float]]:
    """Lazy: the budget check in `EntityShapes.add_path` stops pulling vertices."""
    return ((float(p[0]), float(p[1])) for p in points)


def _size(points: Iterable[Any]) -> float:
    box = BoundingBox(points)
    if not box.has_data:
        return 0.0
    return float(box.size.magnitude)


def valid_handle(handle: str) -> bool:
    """The contract's handle: 1..64 characters (UTF-16 units)."""
    return len(handle) > 0 and utf16_length(handle) <= HANDLE_MAX_LENGTH


class _EntityRenderer:
    def __init__(self, decoder: TextDecoder, fonts: dict[str, str | None], sagitta: float) -> None:
        self._decoder = decoder
        self._fonts = fonts
        self._sagitta = sagitta

    # ----- texts -----

    def _decode(self, raw: str, style: Any) -> str:
        font = self._fonts.get(str(style or "").lower())
        decoded = self._decoder.decode(raw, font)
        return _clean(decoded.text) if decoded.text is not None else raw

    def text(self, e: Any, kind: str, shapes: EntityShapes) -> None:
        if shapes.texts_closed or shapes.texts_overflow:
            shapes.texts_overflow = True  # no text can be kept: stop this entity
            return
        if kind == "MTEXT":
            raw = _clean(str(plain_mtext(_clean(str(e.text)), split=False)))
            x, y, _ = Vec3(e.dxf.insert)
            shapes.add_text(
                x,
                y,
                e.dxf.get("char_height", 0.0),
                e.get_rotation(),
                self._decode(raw, e.dxf.get("style")),
            )
            return
        if kind == "ATTRIB" and e.is_invisible:
            return
        raw = _clean(str(e.dxf.get("tag" if kind == "ATTDEF" else "text", "")))
        anchor = Vec3(_text_anchor(e))
        x, y, _ = to_wcs(e, [(anchor.x, anchor.y, anchor.z)])[0]
        shapes.add_text(
            x,
            y,
            e.dxf.get("height", 0.0),
            e.dxf.get("rotation", 0.0),
            self._decode(raw, e.dxf.get("style")),
        )

    # ----- shapes -----

    def _path(self, path: Any, shapes: EntityShapes) -> None:
        for sub in path.sub_paths():
            if shapes.full:
                return
            if sub.has_curves:
                sagitta = shape_sagitta(self._sagitta, _size(sub.control_vertices()))
                shapes.add_path(_xy(sub.flattening(sagitta)))
            else:
                shapes.add_path(_xy(sub.control_vertices()))

    def _curve(self, e: Any, kind: str, shapes: EntityShapes) -> None:
        if kind in ("ARC", "CIRCLE"):
            radius = abs(float(e.dxf.radius))
            if not math.isfinite(radius):
                raise ValueError("non-finite radius")  # counted as a part error
            size = 2.0 * radius
        elif kind == "ELLIPSE":
            size = 2.0 * Vec3(e.dxf.major_axis).magnitude
        else:
            size = _size(e.control_points) if kind == "SPLINE" else math.inf
        shapes.add_path(_xy(e.flattening(shape_sagitta(self._sagitta, size))))

    def part(self, e: Any, shapes: EntityShapes) -> bool:
        """Add one decomposed part; False when the part type draws nothing here."""
        kind = e.dxftype()
        if kind in _TEXTS or kind == "MTEXT":
            self.text(e, kind, shapes)
        elif shapes.paths_closed:
            shapes.paths_overflow = True  # the vertex cap is reached: stop this entity
        elif kind == "LINE":
            shapes.add_path(_xy((e.dxf.start, e.dxf.end)))
        elif kind in _CURVES:
            self._curve(e, kind, shapes)
        elif kind == "LWPOLYLINE" or (
            kind == "POLYLINE" and (e.is_2d_polyline or e.is_3d_polyline)
        ):
            self._path(make_path(e), shapes)  # the centre line, also for wide polylines
        else:
            primitive = make_primitive(e)
            if primitive.path is not None:
                self._path(primitive.path, shapes)
            elif primitive.mesh is not None:
                for face in primitive.mesh.faces_as_vertices():
                    if shapes.full:
                        break
                    points = [(float(p[0]), float(p[1])) for p in face]
                    shapes.add_path([*points, points[0]] if points else points)
            else:
                return False
        return True


def _insert_of(entity: Any, kind: str) -> ViewInsert | None:
    """An INSERT's insertion point (WCS), rotation, scale and block name; None when unreadable."""
    if kind != "INSERT":
        return None
    try:
        x, y, z = Vec3(entity.dxf.insert)
        x, y, _ = to_wcs(entity, [(x, y, z)])[0]
        values = (
            float(x),
            float(y),
            float(entity.dxf.get("rotation", 0.0)),
            float(entity.dxf.get("xscale", 1.0)),
            float(entity.dxf.get("yscale", 1.0)),
        )
        if not all(math.isfinite(v) for v in values):
            return None
        name = utf16_cut(_clean(str(entity.dxf.get("name", ""))), BLOCK_NAME_MAX_LENGTH)
        return ViewInsert(*values, name=name)
    except Exception:  # a broken insert keeps its shapes, only without the grip
        return None


def _flip(entity: Any) -> float | None:
    """+1 for the default extrusion, -1 for (0, 0, -1) (a mirrored 2D entity: x is negated, so
    bulges and arc directions turn the other way); None for a tilted one (not 2D)."""
    ex = Vec3(entity.dxf.get("extrusion", (0, 0, 1)))
    if ex.isclose(Vec3(0, 0, 1), abs_tol=1e-9):
        return 1.0
    if ex.isclose(Vec3(0, 0, -1), abs_tol=1e-9):
        return -1.0
    return None


def _polyline_vertices(entity: Any, kind: str) -> tuple[list[tuple[float, float, float]], bool]:
    if kind == "LWPOLYLINE":
        z = float(entity.dxf.get("elevation", 0.0))
        verts = [(float(x), float(y), z, float(b)) for x, y, b in entity.get_points("xyb")]
        return _wcs_vertices(entity, verts), bool(entity.closed)
    z = float(Vec3(entity.dxf.get("elevation", (0, 0, 0))).z)
    verts = [
        (float(v.dxf.location.x), float(v.dxf.location.y), z, float(v.dxf.get("bulge", 0.0)))
        for v in entity.vertices
        if not int(v.dxf.get("flags", 0)) & 16  # spline frame points are not vertices
    ]
    return _wcs_vertices(entity, verts), bool(entity.is_closed)


def _wcs_vertices(
    entity: Any, verts: list[tuple[float, float, float, float]]
) -> list[tuple[float, float, float]]:
    flip = _flip(entity) or 1.0
    points = to_wcs(entity, [(x, y, z) for x, y, z, _ in verts])
    return [(p[0], p[1], b * flip) for p, (_, _, _, b) in zip(points, verts, strict=True)]


def _angle(cx: float, cy: float, p: Any) -> float:
    return math.degrees(math.atan2(float(p[1]) - cy, float(p[0]) - cx)) % 360.0


def _geometry_of(entity: Any, kind: str) -> ViewGeometry | None:
    """A top-level entity's own 2D geometry (ADR-062): polyline vertices with bulges, circle /
    arc, ellipse. None for other kinds, a tilted (3D) one, a spline-fit or 3D polyline, or when
    unreadable (the entity keeps its paths and today's grips)."""
    try:
        if kind == "POLYLINE" and not entity.is_2d_polyline:
            return None
        if kind == "POLYLINE" and int(entity.dxf.get("flags", 0)) & 4:
            return None  # spline-fit: its vertices are not where it is drawn
        if kind in ("LWPOLYLINE", "POLYLINE"):
            if _flip(entity) is None:
                return None
            verts, closed = _polyline_vertices(entity, kind)
            return polyline_geometry(verts, closed)
        if kind in ("CIRCLE", "ARC"):
            flip = _flip(entity)
            if flip is None:
                return None
            r = abs(float(entity.dxf.radius))
            c = Vec3(entity.dxf.center)
            cx, cy, _ = to_wcs(entity, [(c.x, c.y, c.z)])[0]
            if kind == "CIRCLE":
                return arc_geometry(cx, cy, r, 0.0, 360.0)
            a0 = math.radians(float(entity.dxf.start_angle))
            a1 = math.radians(float(entity.dxf.end_angle))
            ends = to_wcs(
                entity,
                [(c.x + r * math.cos(a), c.y + r * math.sin(a), c.z) for a in (a0, a1)],
            )
            first, last = (ends[0], ends[1]) if flip > 0 else (ends[1], ends[0])
            start = _angle(cx, cy, first)
            sweep = (_angle(cx, cy, last) - start) % 360.0 or 360.0
            return arc_geometry(cx, cy, r, start, start + sweep)
        if kind == "ELLIPSE":
            ex = Vec3(entity.dxf.get("extrusion", (0, 0, 1)))
            major = Vec3(entity.dxf.major_axis)
            if abs(ex.x) > 1e-9 or abs(ex.y) > 1e-9 or abs(major.z) > 1e-9:
                return None
            c = Vec3(entity.dxf.center)
            t0 = float(entity.dxf.get("start_param", 0.0))
            t1 = float(entity.dxf.get("end_param", 2.0 * math.pi))
            if ex.z < 0:  # the minor axis turns clockwise: the parameters run the other way
                t0, t1 = -t1, -t0
            sweep = (t1 - t0) % (2.0 * math.pi) or 2.0 * math.pi
            ratio = float(entity.dxf.get("ratio", 1.0))
            return ellipse_geometry(c.x, c.y, major.x, major.y, ratio, t0, t0 + sweep)
    except Exception:  # the entity keeps its paths, only without its own geometry
        return None
    return None


class EzdxfViewRenderer:
    """In-process renderer (tests, and the child process of `SubprocessViewRenderer`)."""

    def __init__(
        self,
        decoder: TextDecoder | None = None,
        *,
        max_vertices: int = DRAWING_VIEW_MAX_VERTICES,
        max_texts: int = DRAWING_VIEW_MAX_TEXTS,
        max_parts: int = DRAWING_VIEW_MAX_PARTS,
        max_json_bytes: int = DRAWING_VIEW_MAX_JSON_BYTES,
    ) -> None:
        self._decoder = decoder or TextDecoder()
        self._max_vertices = max_vertices
        self._max_texts = max_texts
        self._max_parts = max_parts
        self._max_json_bytes = max_json_bytes

    def render(self, path: Path, cad_file_id: str, extents: Extents | None) -> RenderedView:
        """Raises ViewFailure(READ_FAILED) when the file cannot be read. `extents` (from the
        import) bound the flattening sagitta."""
        try:
            doc, _auditor = recover.readfile(str(path))
        except Exception as exc:
            raise ViewFailure("READ_FAILED", f"{type(exc).__name__}: {exc}") from exc
        fonts = {s.dxf.name.lower(): str(s.dxf.get("font", "")) or None for s in doc.styles}
        renderer = _EntityRenderer(self._decoder, fonts, view_sagitta(extents))
        builder = DrawingViewBuilder(
            cad_file_id,
            _layers(doc),
            max_vertices=self._max_vertices,
            max_texts=self._max_texts,
            max_parts=self._max_parts,
        )
        stats = RenderStats()
        for entity in doc.modelspace():
            if builder.full:
                break  # both caps (or the parts cap) reached: the rest cannot be added
            stats.entities += 1
            self._entity(entity, renderer, builder, stats)
        return RenderedView(builder.build(), stats)

    def render_to(
        self, dxf: Path, out: Path, cad_file_id: str, extents: Extents | None
    ) -> RenderOutput:
        """Render and write the gzip JSON to `out`. Raises ViewFailure(READ_FAILED | TOO_LARGE)."""
        rendered = self.render(dxf, cad_file_id, extents)
        view = rendered.view
        try:
            with out.open("wb") as fh:
                json_bytes = write_view_gzip(view, fh, self._max_json_bytes)
        except ViewTooLargeError as exc:
            out.unlink(missing_ok=True)
            raise ViewFailure("TOO_LARGE", str(exc)) from exc
        stats: dict[str, object] = {
            **rendered.stats.to_json(),
            "vertices": view.vertex_count,
            "texts": view.text_count,
            "truncated": view.truncated,
            "jsonBytes": json_bytes,
        }
        return RenderOutput(size_bytes=out.stat().st_size, json_bytes=json_bytes, stats=stats)

    def _entity(
        self,
        entity: Any,
        renderer: _EntityRenderer,
        builder: DrawingViewBuilder,
        stats: RenderStats,
    ) -> None:
        kind = str(entity.dxftype())
        if kind in PROXY_TYPES:
            stats.skip("proxy", kind)
            return
        shapes = builder.shapes()
        supported = unsupported = 0
        try:
            handle = str(entity.dxf.get("handle", "") or "")
            if not valid_handle(handle):
                stats.skip("handle", kind)  # the viewer could not pick it: never sent
                return
            layer = _clean(str(entity.dxf.get("layer", "0")))
            color = entity_color(entity)
            for part in recursive_decompose([entity]):
                if not builder.take_part():
                    break  # parts cap: `truncated`
                try:
                    if renderer.part(part, shapes):
                        supported += 1
                    else:
                        unsupported += 1
                        stats.unsupported_parts[str(part.dxftype())] += 1
                except Exception:  # one bad part of a block must not lose the rest
                    stats.part_errors += 1
                if shapes.full:
                    break  # over this entity's budget: stop decomposing (never read further)
        except Exception:  # broken entity or block: keep what was collected
            if not shapes.paths and not shapes.texts:
                stats.skip("error", kind)
                return
            stats.part_errors += 1
        if not shapes.paths and not shapes.texts:
            if shapes.full:
                builder.add(handle, layer, color, kind, shapes)  # records the overflow
                stats.dropped += 1
            elif unsupported and not supported:
                stats.skip("unsupported", kind)
            else:
                stats.empty += 1  # e.g. a POINT, an empty block, a blank text
        elif builder.add(
            handle, layer, color, kind, shapes, _insert_of(entity, kind), _geometry_of(entity, kind)
        ):
            stats.rendered += 1
        else:
            stats.dropped += 1  # over the caps (the view is `truncated`)
