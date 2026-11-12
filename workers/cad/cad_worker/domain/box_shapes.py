"""Box shape signatures, previews and the gallery of a revision (ADR-043). Pure: no I/O, no ezdxf.

Mirror of `packages/shared/src/cad/box-types.schemas.ts`. A box is grouped by what its symbol LOOKS
like, never by its block name:

- the adapter gives the drawn geometry of a symbol (`ShapeGeometry`): polylines, texts and tokens
  (hatch fill kind, entities that are drawn but not read as lines). For a block it is the INSERT
  exploded with the insert's rotation undone and its insertion point at 0,0 (mirroring,
  non-uniform scale and OCS flips are kept: they look different); for a closed-shape group the
  curves as drawn;
- curves are flattened at a fixed `ARC_SEGMENTS_PER_TURN` (circles, arcs, bulges) so the number of
  vertices does not depend on the size;
- the signature normalizes: segments, moved so the bbox centre is 0,0, divided by the larger bbox
  side, quantized to 1 / `QUANTUM`, zero-length and duplicate segments dropped, ends ordered,
  sorted; SHA-256 of the canonical text with the source and the algorithm version.

When in doubt it splits, never merges (a polyline vs. the same lines with one segment split are two
shapes). Colour and layer are not part of the shape.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

Xy = tuple[float, float]

BOX_SHAPE_ALGORITHM_VERSION = 1
BOX_SHAPE_NONE = "none"
BoxShapeSource = Literal["block", "shapes", "text", "none"]
BOX_SHAPE_SOURCES: tuple[BoxShapeSource, ...] = ("block", "shapes", "text", "none")
SIGNATURE_RE = re.compile(r"^(v[1-9]\d{0,2}-[0-9a-f]{64}|none)$")

# Normalization (technical, part of the algorithm version).
ARC_SEGMENTS_PER_TURN = 64
QUANTUM = 1000
TEXT_ROTATION_DECIMALS = 1
# A symbol drawing more segments than this is not read (the box counts as «shape unknown»):
# technical DoS bound, far above any real symbol.
MAX_SHAPE_SEGMENTS = 20_000

# Bounds of the shared contract.
MAX_BOX_SHAPES = 200
MAX_BOX_SHAPE_PREVIEW_VERTICES = 256
MAX_BOX_SHAPE_PREVIEW_PATHS = 128
MAX_BOX_SHAPE_PREVIEW_TEXTS = 8
MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH = 32
MAX_FILE_SHAPES = 2000
MAX_BOX_SHAPE_BLOCK_NAMES = 20
MAX_BOX_SHAPE_SAMPLES = 5
MAX_BOX_TYPE_CHOICES_PER_FILE = 1000
BOX_TYPE_LABEL_MAX = 80
BOX_TYPE_CODE_MAX = 64
BOX_SHAPE_GALLERY_VERSION = 1
PREVIEW_DECIMALS = 4

_HANDLE_MAX = 64


class ShapeTooLargeError(ValueError):
    """The symbol draws more than MAX_SHAPE_SEGMENTS segments."""


@dataclass(frozen=True, slots=True)
class ShapeText:
    """A text drawn inside a symbol: position and height in the symbol's frame, rotation in
    degrees (counter-clockwise), the plain text."""

    x: float
    y: float
    height: float
    rotation: float
    text: str


@dataclass(frozen=True, slots=True)
class ShapeGeometry:
    paths: tuple[tuple[Xy, ...], ...] = ()
    texts: tuple[ShapeText, ...] = ()
    # Facts of the drawing that are not lines (`hatch:solid`, `entity:POINT`, …), in any order.
    tokens: tuple[str, ...] = ()


# ---------- flattening at a fixed number of segments ----------


def arc_segments(sweep: float) -> int:
    """Segments of an arc of `sweep` radians: ARC_SEGMENTS_PER_TURN per full turn, at least 1."""
    return max(1, math.ceil(abs(sweep) / (2.0 * math.pi) * ARC_SEGMENTS_PER_TURN - 1e-9))


def fixed_arc_points(cx: float, cy: float, radius: float, start: float, sweep: float) -> list[Xy]:
    """Arc from `start` (radians), counter-clockwise for a positive sweep; both ends included."""
    n = arc_segments(sweep)
    return [
        (
            cx + radius * math.cos(start + sweep * i / n),
            cy + radius * math.sin(start + sweep * i / n),
        )
        for i in range(n + 1)
    ]


def fixed_bulge_points(p0: Xy, p1: Xy, bulge: float) -> list[Xy]:
    """A polyline segment with a bulge, flattened at the fixed segment count."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    chord = math.hypot(dx, dy)
    if bulge == 0.0 or chord == 0.0:
        return [p0, p1]
    sweep = 4.0 * math.atan(bulge)
    radius = chord / (2.0 * math.sin(abs(sweep) / 2.0))
    offset = (chord / 2.0) * (1.0 - bulge * bulge) / (2.0 * bulge)
    cx = (p0[0] + p1[0]) / 2.0 - dy / chord * offset
    cy = (p0[1] + p1[1]) / 2.0 + dx / chord * offset
    start = math.atan2(p0[1] - cy, p0[0] - cx)
    pts = fixed_arc_points(cx, cy, radius, start, sweep)
    pts[0], pts[-1] = p0, p1
    return pts


def fixed_polyline_points(vertices: Sequence[tuple[float, float, float]], closed: bool) -> list[Xy]:
    """(x, y, bulge) vertices -> points; a closed polyline repeats its first point."""
    pts: list[Xy] = []
    count = len(vertices)
    if count == 0:
        return pts
    if count == 1:
        return [(vertices[0][0], vertices[0][1])]
    last = count if closed else count - 1
    for i in range(last):
        x0, y0, bulge = vertices[i]
        x1, y1, _ = vertices[(i + 1) % count]
        seg = fixed_bulge_points((x0, y0), (x1, y1), bulge)
        pts.extend(seg if not pts else seg[1:])
    return pts


# ---------- normalization and signature ----------


@dataclass(frozen=True, slots=True)
class _Frame:
    cx: float
    cy: float
    size: float

    def unit(self, p: Xy) -> Xy:
        return ((p[0] - self.cx) / self.size, (p[1] - self.cy) / self.size)


def _finite(p: Xy) -> bool:
    return math.isfinite(p[0]) and math.isfinite(p[1])


def _frame(geometry: ShapeGeometry) -> _Frame:
    """bbox of the lines (of the text anchors when nothing else is drawn), larger side = 1."""
    pts = [p for path in geometry.paths for p in path if _finite(p)]
    if not pts:
        pts = [(t.x, t.y) for t in geometry.texts if _finite((t.x, t.y))]
    if not pts:
        return _Frame(0.0, 0.0, 1.0)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    size = max(max(xs) - min(xs), max(ys) - min(ys))
    if not (size > 0.0 and math.isfinite(size)):
        heights = [abs(t.height) for t in geometry.texts if math.isfinite(t.height) and t.height]
        size = max(heights) if heights else 1.0
    return _Frame((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0, size)


def _q(value: float) -> int:
    return round(value * QUANTUM)


def _segments(geometry: ShapeGeometry, frame: _Frame) -> list[tuple[int, int, int, int]]:
    out: set[tuple[int, int, int, int]] = set()
    for path in geometry.paths:
        prev: tuple[int, int] | None = None
        for p in path:
            if not _finite(p):
                prev = None
                continue
            u = frame.unit(p)
            cur = (_q(u[0]), _q(u[1]))
            if prev is not None and cur != prev:
                a, b = (prev, cur) if prev <= cur else (cur, prev)
                out.add((*a, *b))
                if len(out) > MAX_SHAPE_SEGMENTS:
                    raise ShapeTooLargeError("symbol has too many segments")
            prev = cur
    return sorted(out)


def _rotation(degrees: float) -> str:
    value = round(degrees % 360.0, TEXT_ROTATION_DECIMALS) % 360.0
    return f"{value:.{TEXT_ROTATION_DECIMALS}f}"


def _canonical(geometry: ShapeGeometry, source: BoxShapeSource) -> str:
    frame = _frame(geometry)
    segments = ";".join(f"{a},{b},{c},{d}" for a, b, c, d in _segments(geometry, frame))
    texts = sorted(
        f"{_q(u[0])},{_q(u[1])},{_q(abs(t.height) / frame.size)},{_rotation(t.rotation)},{t.text!r}"
        for t in geometry.texts
        if _finite((t.x, t.y)) and math.isfinite(t.height) and math.isfinite(t.rotation)
        for u in (frame.unit((t.x, t.y)),)
    )
    tokens = sorted(geometry.tokens)
    return "\n".join(
        (
            f"box-shape v{BOX_SHAPE_ALGORITHM_VERSION}",
            f"source {source}",
            f"segments {segments}",
            f"texts {'|'.join(texts)}",
            f"tokens {'|'.join(tokens)}",
        )
    )


def _hash(canonical: str) -> str:
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"v{BOX_SHAPE_ALGORITHM_VERSION}-{digest}"


def shape_signature(geometry: ShapeGeometry, source: BoxShapeSource = "block") -> str:
    """`v1-<sha256>` of the normalized geometry. Raises ShapeTooLargeError."""
    if source in ("none", "text"):
        raise ValueError(f"use {'BOX_SHAPE_NONE' if source == 'none' else 'text_signature'}")
    return _hash(_canonical(geometry, source))


def text_key(text: str) -> str:
    """The `text` rule's symbol: trimmed, upper-cased."""
    return text.strip().upper()


def text_signature(text: str) -> str:
    return _hash(
        "\n".join(
            (f"box-shape v{BOX_SHAPE_ALGORITHM_VERSION}", "source text", f"text {text_key(text)!r}")
        )
    )


def is_signature(value: object) -> bool:
    return isinstance(value, str) and SIGNATURE_RE.match(value) is not None


# ---------- preview ----------


def _path_length(path: Sequence[Xy]) -> float:
    return sum(math.dist(a, b) for a, b in itertools.pairwise(path))


def _decimate(path: list[Xy], step: int) -> list[Xy]:
    """Every `step`-th vertex and the last; at least 4 vertices stay (a closed path stays one)."""
    step = min(step, (len(path) - 1) // 3)
    if step <= 1 or len(path) <= 8:
        return path
    kept = path[::step]
    if kept[-1] != path[-1]:
        kept.append(path[-1])
    return kept


def _clamp_unit(v: float) -> float:
    return round(min(1.0, max(-1.0, v)), PREVIEW_DECIMALS)


def shape_preview(geometry: ShapeGeometry) -> dict[str, object]:
    """`BoxShapePreview`: normalized paths (larger side 1, centred), within the contract's caps.
    Long paths are thinned, then the shortest paths dropped (`truncated`)."""
    frame = _frame(geometry)
    truncated = False
    paths: list[list[Xy]] = []
    for path in geometry.paths:
        pts = [frame.unit(p) for p in path if _finite(p)]
        dedup: list[Xy] = []
        for p in pts:
            r = (_clamp_unit(p[0]), _clamp_unit(p[1]))
            if not dedup or dedup[-1] != r:
                dedup.append(r)
        if len(dedup) >= 2:
            paths.append(dedup)
    total = sum(len(p) for p in paths)
    if total > MAX_BOX_SHAPE_PREVIEW_VERTICES:
        truncated = True
        step = math.ceil(total / MAX_BOX_SHAPE_PREVIEW_VERTICES)
        paths = [_decimate(p, step) for p in paths]
    if len(paths) > MAX_BOX_SHAPE_PREVIEW_PATHS:
        truncated = True
    order = sorted(range(len(paths)), key=lambda i: (-_path_length(paths[i]), i))
    kept: list[int] = []
    vertices = 0
    for i in order:
        n = len(paths[i])
        full = len(kept) >= MAX_BOX_SHAPE_PREVIEW_PATHS
        if full or vertices + n > MAX_BOX_SHAPE_PREVIEW_VERTICES:
            truncated = True
            continue
        kept.append(i)
        vertices += n
    flat = [[c for p in paths[i] for c in p] for i in sorted(kept)]
    texts: list[dict[str, object]] = []
    for t in geometry.texts:
        if not (_finite((t.x, t.y)) and math.isfinite(t.height) and math.isfinite(t.rotation)):
            continue
        if len(texts) >= MAX_BOX_SHAPE_PREVIEW_TEXTS:
            truncated = True
            break
        u = frame.unit((t.x, t.y))
        height = min(1.0, max(0.001, round(abs(t.height) / frame.size, PREVIEW_DECIMALS)))
        texts.append(
            {
                "x": _clamp_unit(u[0]),
                "y": _clamp_unit(u[1]),
                "height": height,
                "rotation": round(t.rotation % 360.0, TEXT_ROTATION_DECIMALS),
                "text": _no_control(t.text)[:MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH],
            }
        )
    return {"paths": flat, "texts": texts, "truncated": truncated}


def text_preview(text: str) -> dict[str, object]:
    return shape_preview(ShapeGeometry(texts=(ShapeText(0.0, 0.0, 0.5, 0.0, text_key(text)),)))


def _no_control(value: str) -> str:
    return "".join(ch if ord(ch) >= 0x20 else " " for ch in value)


# ---------- frozen choices (design_revisions.box_types) ----------


@dataclass(frozen=True, slots=True)
class BoxTypeOnBox:
    """`attrs.reading.boxType` (BoxTypeOnBoxSchema)."""

    work_order_line_id: str
    code: str | None
    label: str | None

    def to_json(self) -> dict[str, object]:
        return {"workOrderLineId": self.work_order_line_id, "code": self.code, "label": self.label}


class BoxTypesInvalidError(ValueError):
    """`design_revisions.box_types` does not satisfy FrozenBoxTypesSchema."""


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")


def parse_frozen_box_types(raw: object) -> dict[str, BoxTypeOnBox]:
    """shape -> type, from the revision's frozen choices (None / null -> none chosen)."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping) or not isinstance(raw.get("choices"), list):
        raise BoxTypesInvalidError("box_types must be an object with a choices array")
    choices = raw["choices"]
    if len(choices) > MAX_BOX_TYPE_CHOICES_PER_FILE:
        raise BoxTypesInvalidError("too many box type choices")
    out: dict[str, BoxTypeOnBox] = {}
    for c in choices:
        if not isinstance(c, Mapping):
            raise BoxTypesInvalidError("box type choice is not an object")
        shape, line_id, line = c.get("shape"), c.get("workOrderLineId"), c.get("line")
        if not is_signature(shape) or not isinstance(line_id, str) or not _UUID_RE.match(line_id):
            raise BoxTypesInvalidError("box type choice has no valid shape / workOrderLineId")
        shape = str(shape)
        if shape in out:
            raise BoxTypesInvalidError(f"duplicate box type choice for {shape}")
        code = label = None
        if line is not None:
            if not isinstance(line, Mapping):
                raise BoxTypesInvalidError("box type line is not an object")
            raw_code, raw_label = line.get("code"), line.get("label")
            if not isinstance(raw_code, str) or not isinstance(raw_label, str):
                raise BoxTypesInvalidError("box type line needs code and label")
            if len(raw_code) > BOX_TYPE_CODE_MAX or len(raw_label) > BOX_TYPE_LABEL_MAX:
                raise BoxTypesInvalidError("box type line code / label too long")
            code, label = raw_code, raw_label
        out[shape] = BoxTypeOnBox(line_id, code, label)
    return out


# ---------- gallery (design_revisions.box_shapes) ----------


@dataclass(frozen=True, slots=True)
class BoxShapeOf:
    """One box of the revision and how its shape was read (`shape` None: not read)."""

    handle: str
    source: BoxShapeSource
    shape: str | None
    block_name: str | None = None
    preview: Mapping[str, object] | None = None


@dataclass(slots=True)
class _Entry:
    source: BoxShapeSource
    count: int = 0
    block_names: set[str] = field(default_factory=set)
    handles: list[str] = field(default_factory=list)
    preview: Mapping[str, object] | None = None


def build_gallery(boxes: Iterable[BoxShapeOf]) -> dict[str, object]:
    """`BoxShapeGallery`: shapes by count (descending) then signature, ≤ MAX_BOX_SHAPES listed,
    `shapeCount` exact, `boxesWithoutShape` for boxes whose shape was not read."""
    entries: dict[str, _Entry] = {}
    box_count = without = 0
    for b in boxes:
        box_count += 1
        if b.shape is None:
            without += 1
            continue
        e = entries.get(b.shape)
        if e is None:
            e = entries[b.shape] = _Entry(b.source)
        e.count += 1
        if b.block_name is not None:
            e.block_names.add(b.block_name[:255])
        if len(b.handle) <= _HANDLE_MAX and not any(ord(ch) < 0x20 for ch in b.handle):
            e.handles.append(b.handle)
        if e.preview is None and b.preview is not None:
            e.preview = b.preview
    ordered = sorted(entries.items(), key=lambda kv: (-kv[1].count, kv[0]))
    shapes: list[dict[str, object]] = []
    for shape, e in ordered[:MAX_BOX_SHAPES]:
        samples = sorted(e.handles)[:MAX_BOX_SHAPE_SAMPLES]
        if not samples:
            continue  # cannot happen for real handles; a shape must have a sample to show
        shapes.append(
            {
                "shape": shape,
                "source": e.source,
                "count": e.count,
                "blockNames": sorted(e.block_names)[:MAX_BOX_SHAPE_BLOCK_NAMES],
                "sampleHandles": samples,
                "preview": dict(e.preview) if e.preview is not None else None,
            }
        )
    return {
        "version": BOX_SHAPE_GALLERY_VERSION,
        "boxCount": box_count,
        "shapeCount": len(entries),
        "shapes": shapes,
        "boxesWithoutShape": without,
    }
