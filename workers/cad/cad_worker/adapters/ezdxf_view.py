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
    DRAWING_VIEW_MAX_JSON_BYTES,
    DRAWING_VIEW_MAX_PARTS,
    DRAWING_VIEW_MAX_TEXTS,
    DRAWING_VIEW_MAX_VERTICES,
    HANDLE_MAX_LENGTH,
    DrawingViewBuilder,
    EntityShapes,
    RenderedView,
    RenderStats,
    ViewLayer,
    ViewTooLargeError,
    hex_color,
    shape_sagitta,
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
        elif builder.add(handle, layer, color, kind, shapes):
            stats.rendered += 1
        else:
            stats.dropped += 1  # over the caps (the view is `truncated`)
