"""«عارض الرسومات» — the drawing view of a CAD file (ADR-039). Pure: no ezdxf, no I/O.

Mirror of `packages/shared/src/cad/drawing-view.schemas.ts` (`DrawingView`). The ezdxf adapter
(`adapters/ezdxf_view.py`) flattens every model-space entity and hands its shapes to a
`DrawingViewBuilder`, which groups them under the top-level handle, keeps the extents and applies
the technical caps deterministically (model-space order; once a shape does not fit, no further
shape of that kind is added and `truncated` is set).

Coordinates stay in DRAWING units (like problem places' `drawingX/Y`) and are rounded to
`COORD_DECIMALS` decimals; the stored file is compact gzip JSON.
"""

from __future__ import annotations

import gzip
import json
import math
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import BinaryIO

from cad_worker.domain.extents import Extents

DRAWING_VIEW_VERSION = 1
# Technical caps of the view file (contract constants), not business rules.
DRAWING_VIEW_MAX_VERTICES = 3_000_000
DRAWING_VIEW_MAX_TEXTS = 200_000

COORD_DECIMALS = 4
KIND_MAX_LENGTH = 32
# Curves are flattened with a sagitta of at most this fraction of the drawing diagonal …
EXTENTS_SAGITTA_RATIO = 1e-5
# … and at most this fraction of the shape's own size, so a small symbol stays round when zoomed.
SHAPE_SAGITTA_RATIO = 0.002
MIN_SAGITTA = 1e-9

Xy = tuple[float, float]


@dataclass(frozen=True, slots=True)
class ViewLayer:
    name: str
    color: str  # '#rrggbb'
    visible: bool


@dataclass(frozen=True, slots=True)
class ViewText:
    x: float
    y: float
    height: float
    rotation: float  # degrees, counter-clockwise
    text: str


@dataclass(frozen=True, slots=True)
class ViewEntity:
    handle: str
    layer: int
    color: str | None  # None = BYLAYER
    kind: str
    paths: tuple[tuple[float, ...], ...]  # flat [x0, y0, x1, y1, …], ≥ 2 points each
    texts: tuple[ViewText, ...]


@dataclass(frozen=True, slots=True)
class DrawingView:
    cad_file_id: str
    extents: Extents
    layers: tuple[ViewLayer, ...]
    entities: tuple[ViewEntity, ...]
    truncated: bool

    @property
    def vertex_count(self) -> int:
        return sum(len(p) // 2 for e in self.entities for p in e.paths)

    @property
    def text_count(self) -> int:
        return sum(len(e.texts) for e in self.entities)


def hex_color(rgb: int) -> str:
    return f"#{rgb & 0xFFFFFF:06x}"


def view_sagitta(extents: Extents | None) -> float:
    """Upper bound of the chord-to-curve distance for the whole drawing (drawing units);
    `inf` when the extents are unknown (then only the shape's own size bounds it)."""
    if extents is None:
        return math.inf
    diagonal = math.hypot(extents.max_x - extents.min_x, extents.max_y - extents.min_y)
    if not math.isfinite(diagonal) or diagonal <= 0:
        return math.inf
    return diagonal * EXTENTS_SAGITTA_RATIO


def shape_sagitta(drawing_sagitta: float, shape_size: float) -> float:
    """Sagitta for one curve of size `shape_size` (bounding-box diagonal or diameter)."""
    own = shape_size * SHAPE_SAGITTA_RATIO if math.isfinite(shape_size) else math.inf
    value = min(drawing_sagitta, own)
    if not math.isfinite(value):
        return 1.0  # unknown drawing size and a degenerate shape: any value draws it
    return max(value, MIN_SAGITTA)


def _round(value: float) -> float:
    rounded = round(value, COORD_DECIMALS)
    return rounded + 0.0  # -0.0 -> 0.0


def flat_path(points: Iterable[Sequence[float]]) -> tuple[float, ...] | None:
    """[(x, y, …), …] -> (x0, y0, x1, y1, …) rounded; consecutive duplicates (after rounding)
    removed. None when fewer than two distinct points remain or a coordinate is not finite."""
    out: list[float] = []
    last: Xy | None = None
    for p in points:
        x, y = float(p[0]), float(p[1])
        if not (math.isfinite(x) and math.isfinite(y)):
            return None
        xy = (_round(x), _round(y))
        if xy == last:
            continue
        out.extend(xy)
        last = xy
    return tuple(out) if len(out) >= 4 else None


@dataclass(slots=True)
class EntityShapes:
    """What one top-level entity draws, collected before it is added to the view."""

    paths: list[tuple[float, ...]] = field(default_factory=list)
    texts: list[ViewText] = field(default_factory=list)

    def add_path(self, points: Iterable[Sequence[float]]) -> bool:
        path = flat_path(points)
        if path is None:
            return False
        self.paths.append(path)
        return True

    def add_text(self, x: float, y: float, height: float, rotation: float, text: str) -> bool:
        values = (float(x), float(y), float(height), float(rotation))
        if not text.strip() or not all(math.isfinite(v) for v in values):
            return False
        self.texts.append(
            ViewText(
                x=_round(values[0]),
                y=_round(values[1]),
                height=_round(values[2]),
                rotation=_round(values[3] % 360.0),
                text=text,
            )
        )
        return True


class DrawingViewBuilder:
    def __init__(
        self,
        cad_file_id: str,
        layers: Iterable[ViewLayer],
        *,
        max_vertices: int = DRAWING_VIEW_MAX_VERTICES,
        max_texts: int = DRAWING_VIEW_MAX_TEXTS,
    ) -> None:
        self._cad_file_id = cad_file_id
        self._layers: list[ViewLayer] = []
        self._index: dict[str, int] = {}
        for layer in layers:
            self.layer_index(layer.name, layer)
        self._entities: list[ViewEntity] = []
        self._max_vertices = max_vertices
        self._max_texts = max_texts
        self._vertices = 0
        self._texts = 0
        self._paths_full = False
        self._texts_full = False
        self._min_x = self._min_y = math.inf
        self._max_x = self._max_y = -math.inf

    @property
    def truncated(self) -> bool:
        return self._paths_full or self._texts_full

    def layer_index(self, name: str, default: ViewLayer | None = None) -> int:
        """Index of a layer (DXF layer names are case-insensitive). A name missing from the
        layer table is appended as a visible black layer."""
        key = name.casefold()
        found = self._index.get(key)
        if found is not None:
            return found
        self._layers.append(default or ViewLayer(name=name, color="#000000", visible=True))
        self._index[key] = len(self._layers) - 1
        return self._index[key]

    def _grow(self, x: float, y: float) -> None:
        self._min_x = min(self._min_x, x)
        self._min_y = min(self._min_y, y)
        self._max_x = max(self._max_x, x)
        self._max_y = max(self._max_y, y)

    def add(
        self, handle: str, layer: str, color: str | None, kind: str, shapes: EntityShapes
    ) -> bool:
        """Add an entity's shapes within the caps. False when nothing of it was kept."""
        paths: list[tuple[float, ...]] = []
        for path in shapes.paths:
            if self._paths_full:
                break
            count = len(path) // 2
            if self._vertices + count > self._max_vertices:
                self._paths_full = True
                break
            self._vertices += count
            paths.append(path)
            for i in range(0, len(path), 2):
                self._grow(path[i], path[i + 1])
        texts: list[ViewText] = []
        for text in shapes.texts:
            if self._texts_full:
                break
            if self._texts + 1 > self._max_texts:
                self._texts_full = True
                break
            self._texts += 1
            texts.append(text)
            self._grow(text.x, text.y)
        if not paths and not texts:
            return False
        self._entities.append(
            ViewEntity(
                handle=handle,
                layer=self.layer_index(layer),
                color=color,
                kind=kind[:KIND_MAX_LENGTH],
                paths=tuple(paths),
                texts=tuple(texts),
            )
        )
        return True

    def build(self) -> DrawingView:
        if self._min_x > self._max_x:
            extents = Extents(0.0, 0.0, 0.0, 0.0)
        else:
            extents = Extents(self._min_x, self._min_y, self._max_x, self._max_y)
        return DrawingView(
            cad_file_id=self._cad_file_id,
            extents=extents,
            layers=tuple(self._layers),
            entities=tuple(self._entities),
            truncated=self.truncated,
        )


@dataclass(slots=True)
class RenderStats:
    entities: int = 0
    rendered: int = 0
    empty: int = 0  # drawn nothing (e.g. a POINT, an empty block)
    dropped: int = 0  # left out by the caps
    skipped: Counter[str] = field(default_factory=Counter)  # proxy / unsupported / error
    skipped_types: Counter[str] = field(default_factory=Counter)
    part_errors: int = 0
    unsupported_parts: Counter[str] = field(default_factory=Counter)

    def skip(self, reason: str, kind: str) -> None:
        self.skipped[reason] += 1
        self.skipped_types[kind] += 1

    def to_json(self) -> dict[str, object]:
        return {
            "entities": self.entities,
            "rendered": self.rendered,
            "empty": self.empty,
            "dropped": self.dropped,
            "skipped": dict(sorted(self.skipped.items())),
            "skippedTypes": dict(sorted(self.skipped_types.items())),
            "partErrors": self.part_errors,
            "unsupportedParts": dict(sorted(self.unsupported_parts.items())),
        }


@dataclass(frozen=True, slots=True)
class RenderedView:
    view: DrawingView
    stats: RenderStats


# ---------- serialization (camelCase JSON of the contract) ----------

_SEPARATORS = (",", ":")


def _dumps(value: object) -> str:
    return json.dumps(value, separators=_SEPARATORS, ensure_ascii=False, allow_nan=False)


def _entity_json(e: ViewEntity) -> dict[str, object]:
    return {
        "handle": e.handle,
        "layer": e.layer,
        "color": e.color,
        "kind": e.kind,
        "paths": [list(p) for p in e.paths],
        "texts": [
            {"x": t.x, "y": t.y, "height": t.height, "rotation": t.rotation, "text": t.text}
            for t in e.texts
        ],
    }


def view_json_chunks(view: DrawingView) -> Iterable[str]:
    """The view as compact JSON, in chunks (one per entity) so a large view is never held as a
    single string."""
    ext = view.extents
    head = {
        "version": DRAWING_VIEW_VERSION,
        "cadFileId": view.cad_file_id,
        "extents": {"minX": ext.min_x, "minY": ext.min_y, "maxX": ext.max_x, "maxY": ext.max_y},
        "layers": [
            {"name": la.name, "color": la.color, "visible": la.visible} for la in view.layers
        ],
        "truncated": view.truncated,
    }
    yield _dumps(head)[:-1] + ',"entities":['
    for i, entity in enumerate(view.entities):
        yield ("," if i else "") + _dumps(_entity_json(entity))
    yield "]}"


def write_view_gzip(view: DrawingView, out: BinaryIO) -> None:
    """Deterministic gzip (no mtime, no file name) of the view JSON (UTF-8)."""
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=6) as gz:
        for chunk in view_json_chunks(view):
            gz.write(chunk.encode("utf-8"))
