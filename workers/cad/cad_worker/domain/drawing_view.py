"""«عارض الرسومات» — the drawing view of a CAD file (ADR-039). Pure: no ezdxf, no I/O.

Mirror of `packages/shared/src/cad/drawing-view.schemas.ts` (`DrawingView`). The ezdxf adapter
(`adapters/ezdxf_view.py`) flattens every model-space entity and hands its shapes to a
`DrawingViewBuilder`, which groups them under the top-level handle, keeps the extents and applies
the technical caps deterministically (model-space order).

Caps are enforced WHILE an entity is decomposed (security review M1): each entity collects into
`EntityShapes` that only accept the builder's remaining vertices / texts / parts, so a crafted
drawing (nested-block bomb, a huge arc) never materialises more than the caps allow. Once a shape
does not fit, the entity stops, `truncated` is set and no further shape of that kind is added.

Strings are cut to the contract's limits in UTF-16 code units (what Zod's `.max()` counts).
Coordinates stay in DRAWING units (like problem places' `drawingX/Y`) and are rounded to
`COORD_DECIMALS` decimals; the stored file is compact gzip JSON.
"""

from __future__ import annotations

import gzip
import heapq
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
DRAWING_VIEW_MAX_TEXT_LENGTH = 2000
DRAWING_VIEW_MAX_JSON_BYTES = 96 * 1024 * 1024
HANDLE_MAX_LENGTH = 64
LAYER_NAME_MAX_LENGTH = 255
KIND_MAX_LENGTH = 32
# Worker-only cap: decomposed parts (block contents) read per drawing, drawn or not, so a block
# bomb of empty parts ends too.
DRAWING_VIEW_MAX_PARTS = 1_000_000
# Keys kept per counter in the job event (the rest is summed under "other").
STATS_MAX_KEYS = 50

COORD_DECIMALS = 4
# Curves are flattened with a sagitta of at most this fraction of the drawing diagonal …
EXTENTS_SAGITTA_RATIO = 1e-5
# … and at most this fraction of the shape's own size, so a small symbol stays round when zoomed …
SHAPE_SAGITTA_RATIO = 0.002
# … but never so small that one full turn needs more than this many chords.
MAX_SEGMENTS_PER_TURN = 2048
MIN_SAGITTA = 1e-9

Xy = tuple[float, float]


class ViewTooLargeError(Exception):
    """The uncompressed JSON would exceed `DRAWING_VIEW_MAX_JSON_BYTES`."""


def utf16_cut(text: str, limit: int) -> str:
    """`text` cut to at most `limit` UTF-16 code units, never inside a surrogate pair."""
    if len(text) * 2 <= limit:
        return text  # fast path: even all-astral text fits
    units = 0
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:i]
    return text


def utf16_length(text: str) -> int:
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


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


_TURN_FLOOR = 1.0 - math.cos(math.pi / MAX_SEGMENTS_PER_TURN)


def shape_sagitta(drawing_sagitta: float, shape_size: float) -> float:
    """Sagitta for one curve of size `shape_size` (bounding-box diagonal or diameter). Never
    below what `MAX_SEGMENTS_PER_TURN` chords per turn need, so a huge arc in a small drawing
    cannot ask for millions of vertices."""
    finite_size = math.isfinite(shape_size) and shape_size > 0
    own = shape_size * SHAPE_SAGITTA_RATIO if finite_size else math.inf
    value = min(drawing_sagitta, own)
    if not math.isfinite(value):
        return 1.0  # unknown drawing size and a degenerate shape: any value draws it
    floor = shape_size / 2.0 * _TURN_FLOOR if finite_size else 0.0
    return max(value, floor, MIN_SAGITTA)


def _round(value: float) -> float:
    rounded = round(value, COORD_DECIMALS)
    return rounded + 0.0  # -0.0 -> 0.0


class BudgetExceededError(Exception):
    """Internal: a path has more points than the remaining vertex budget."""


def flat_path(
    points: Iterable[Sequence[float]], limit: int | None = None
) -> tuple[float, ...] | None:
    """[(x, y, …), …] -> (x0, y0, x1, y1, …) rounded; consecutive duplicates (after rounding)
    removed. None when fewer than two distinct points remain or a coordinate is not finite.
    Raises BudgetExceededError as soon as more than `limit` points were read (lazy input is
    never read further)."""
    out: list[float] = []
    last: Xy | None = None
    read = 0
    for p in points:
        read += 1
        if limit is not None and read > limit:
            raise BudgetExceededError
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
    """What one top-level entity draws, collected before it is added to the view, within the
    budgets left by the builder (`*_closed`: that kind is already full). A shape that does not
    fit sets `*_overflow` and `full` tells the decomposition to stop, so after a cap is reached
    every later entity stops at its first shape of that kind (an INSERT keeps its attributes,
    which come first) and a block bomb costs a few parts per entity."""

    vertex_budget: int = DRAWING_VIEW_MAX_VERTICES
    text_budget: int = DRAWING_VIEW_MAX_TEXTS
    paths: list[tuple[float, ...]] = field(default_factory=list)
    texts: list[ViewText] = field(default_factory=list)
    vertices: int = 0
    paths_closed: bool = False
    texts_closed: bool = False
    paths_overflow: bool = False
    texts_overflow: bool = False

    @property
    def full(self) -> bool:
        return self.paths_overflow or self.texts_overflow

    def add_path(self, points: Iterable[Sequence[float]]) -> bool:
        if self.paths_overflow or self.paths_closed:
            self.paths_overflow = True
            return False
        try:
            path = flat_path(points, self.vertex_budget - self.vertices)
        except BudgetExceededError:
            self.paths_overflow = True
            return False
        if path is None:
            return False
        self.paths.append(path)
        self.vertices += len(path) // 2
        return True

    def add_text(self, x: float, y: float, height: float, rotation: float, text: str) -> bool:
        if self.texts_overflow or self.texts_closed:
            self.texts_overflow = True
            return False
        values = (float(x), float(y), float(height), float(rotation))
        if not text.strip() or not all(math.isfinite(v) for v in values):
            return False
        if len(self.texts) >= self.text_budget:
            self.texts_overflow = True
            return False
        self.texts.append(
            ViewText(
                x=_round(values[0]),
                y=_round(values[1]),
                height=_round(values[2]),
                rotation=_round(values[3] % 360.0),
                text=utf16_cut(text, DRAWING_VIEW_MAX_TEXT_LENGTH),
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
        max_parts: int = DRAWING_VIEW_MAX_PARTS,
    ) -> None:
        self._cad_file_id = cad_file_id
        self._layers: list[ViewLayer] = []
        self._index: dict[str, int] = {}
        for layer in layers:
            self.layer_index(layer.name, layer)
        self._entities: list[ViewEntity] = []
        self._max_vertices = max_vertices
        self._max_texts = max_texts
        self._max_parts = max_parts
        self._vertices = 0
        self._texts = 0
        self._parts = 0
        self._paths_full = False
        self._texts_full = False
        self._parts_full = False
        self._min_x = self._min_y = math.inf
        self._max_x = self._max_y = -math.inf

    @property
    def truncated(self) -> bool:
        return self._paths_full or self._texts_full or self._parts_full

    @property
    def full(self) -> bool:
        """Nothing more can be added: stop reading the drawing."""
        return (self._paths_full and self._texts_full) or self._parts_full

    def shapes(self) -> EntityShapes:
        """An empty collector holding this builder's remaining budgets."""
        return EntityShapes(
            vertex_budget=0 if self._paths_full else self._max_vertices - self._vertices,
            text_budget=0 if self._texts_full else self._max_texts - self._texts,
            paths_closed=self._paths_full,
            texts_closed=self._texts_full,
        )

    def take_part(self) -> bool:
        """Count one decomposed part; False (and `truncated`) once the parts cap is reached."""
        if self._parts >= self._max_parts:
            self._parts_full = True
            return False
        self._parts += 1
        return True

    def layer_index(self, name: str, default: ViewLayer | None = None) -> int:
        """Index of a layer (DXF layer names are case-insensitive). A name missing from the
        layer table is appended as a visible black layer. Names are cut to the contract's
        length; the index stays keyed by the full name."""
        key = name.casefold()
        found = self._index.get(key)
        if found is not None:
            return found
        layer = default or ViewLayer(name=name, color="#000000", visible=True)
        cut = utf16_cut(layer.name, LAYER_NAME_MAX_LENGTH)
        if cut != layer.name:
            layer = ViewLayer(name=cut, color=layer.color, visible=layer.visible)
        self._layers.append(layer)
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
        """Add an entity's shapes (collected within `shapes()` budgets). False when nothing of
        it was kept."""
        if shapes.paths_overflow:
            self._paths_full = True
        if shapes.texts_overflow:
            self._texts_full = True
        paths: list[tuple[float, ...]] = []
        for path in shapes.paths:
            count = len(path) // 2
            if self._vertices + count > self._max_vertices:  # a collector not from shapes()
                self._paths_full = True
                break
            self._vertices += count
            paths.append(path)
            for i in range(0, len(path), 2):
                self._grow(path[i], path[i + 1])
        texts: list[ViewText] = []
        for text in shapes.texts:
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


def capped_counts(counter: Counter[str], limit: int = STATS_MAX_KEYS) -> dict[str, int]:
    """The `limit` largest counts (ties by name), the rest summed under "other"; keys cut."""
    items = heapq.nsmallest(limit, counter.items(), key=lambda kv: (-kv[1], kv[0]))
    out = {k[:KIND_MAX_LENGTH]: v for k, v in sorted(items)}
    rest = sum(counter.values()) - sum(v for _, v in items)
    if rest:
        out["other"] = out.get("other", 0) + rest
    return out


@dataclass(slots=True)
class RenderStats:
    entities: int = 0
    rendered: int = 0
    empty: int = 0  # drawn nothing (e.g. a POINT, an empty block)
    dropped: int = 0  # left out by the caps
    skipped: Counter[str] = field(default_factory=Counter)  # proxy / unsupported / error / handle
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
            "skipped": capped_counts(self.skipped),
            "skippedTypes": capped_counts(self.skipped_types),
            "partErrors": self.part_errors,
            "unsupportedParts": capped_counts(self.unsupported_parts),
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


def write_view_gzip(
    view: DrawingView, out: BinaryIO, max_json_bytes: int = DRAWING_VIEW_MAX_JSON_BYTES
) -> int:
    """Deterministic gzip (no mtime, no file name) of the view JSON (UTF-8). Returns the
    uncompressed size; raises ViewTooLargeError as soon as it would exceed `max_json_bytes`."""
    written = 0
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=6) as gz:
        for chunk in view_json_chunks(view):
            data = chunk.encode("utf-8")
            written += len(data)
            if written > max_json_bytes:
                raise ViewTooLargeError(f"view JSON exceeds {max_json_bytes} bytes")
            gz.write(data)
    return written
