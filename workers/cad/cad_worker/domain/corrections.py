"""Drawing corrections made on the program page, applied to the drawing rows (ADR-038). Pure.

Mirror of `FrozenDrawingCorrectionSchema` (`packages/shared/src/cad/drawing-corrections.schemas`).
The drawing file never changes: the revision freezes the corrections in force
(`design_revisions.corrections`, in the order they were made) and the build applies them, in that
order, to the rows read from the file, before classification and drawing checks. Coordinates are in
drawing units.

- `move_layer {handle, toLayer}`: the insert, text or curve with that handle gets the new layer (an
  insert keeps its attributes);
- `set_text {handle, text}`: the text's content (decoded and raw) becomes the value, readable;
- `add_text {layer, x, y, text, height}`: a new text, handle `FIX-<correction id>`. A null height
  is the median height of the readable texts on that layer at that point, else 1 drawing unit;
- `add_item {layer, x, y}`: a new insert of block `__fix__` (no block rule ever matches it, so the
  layer's rule decides its type), handle `FIX-<correction id>`, at (x, y), no attributes. File
  inserts are read at the centre of their drawn block (ADR-032); for an added item (x, y) is that
  centre;
- `merge_routes {handles}`: open lines / polylines of one layer meeting end to end (ends within
  `ROUTE_END_TOUCH_M`, as the `ROUTE_SPLIT` check) are joined into one curve keyed by the smallest
  handle (string order), pieces reversed as needed, in the direction of the key piece. Ends that
  are not exactly equal are joined by the short gap between them; equal ends share one vertex.

A correction that cannot be applied (handle gone after the file was processed again, wrong kind of
entity, pieces not forming one chain) fails the revision loudly (`MAPPING_INVALID`) with the reason:
a correction is never skipped silently. Background tiles render from the raw rows in PostGIS, so
corrections do not show on the background layer (only on features, text links and problems).
"""

from __future__ import annotations

import dataclasses
import math
import statistics
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from cad_worker.domain.design import Xy
from cad_worker.domain.design_build import (
    FIX_BLOCK,
    DrawingData,
    SourceCurve,
    SourceInsert,
    SourceText,
)
from cad_worker.domain.drawing_checks import ROUTE_END_TOUCH_M

MAX_HANDLE_LENGTH = 64
MAX_LAYER_LENGTH = 255
MAX_TEXT_LENGTH = 255
MAX_HEIGHT = 1_000_000.0
MAX_MERGE_PIECES = 50
MAX_CORRECTIONS = 5000
FIX_HANDLE_PREFIX = "FIX-"
# Height of an added text without height on a layer with no readable text (drawing units).
DEFAULT_TEXT_HEIGHT = 1.0
MERGEABLE_TYPES = frozenset({"LINE", "LWPOLYLINE", "POLYLINE"})
MERGED_TYPE = "LWPOLYLINE"


class CorrectionInvalidError(ValueError):
    """The frozen corrections are invalid, or one cannot be applied to the drawing (the revision
    fails `MAPPING_INVALID`)."""


@dataclass(frozen=True, slots=True)
class MoveLayer:
    handle: str
    to_layer: str


@dataclass(frozen=True, slots=True)
class SetText:
    handle: str
    text: str


@dataclass(frozen=True, slots=True)
class AddText:
    layer: str
    x: float
    y: float
    text: str
    height: float | None


@dataclass(frozen=True, slots=True)
class AddItem:
    layer: str
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class MergeRoutes:
    handles: tuple[str, ...]


Correction = MoveLayer | SetText | AddText | AddItem | MergeRoutes


@dataclass(frozen=True, slots=True)
class FrozenCorrection:
    id: str
    correction: Correction

    @property
    def fix_handle(self) -> str:
        """Handle of the text or item this correction adds."""
        return f"{FIX_HANDLE_PREFIX}{self.id}"


# ---------- parsing (strict, as the zod schema) ----------

_KEYS: Mapping[str, frozenset[str]] = {
    "move_layer": frozenset({"kind", "handle", "toLayer"}),
    "set_text": frozenset({"kind", "handle", "text"}),
    "add_text": frozenset({"kind", "layer", "x", "y", "text", "height"}),
    "add_item": frozenset({"kind", "layer", "x", "y"}),
    "merge_routes": frozenset({"kind", "handles"}),
}


def parse_corrections(raw: object) -> tuple[FrozenCorrection, ...]:
    """Validate the revision's frozen `corrections` JSON; None = no corrections."""
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > MAX_CORRECTIONS:
        raise CorrectionInvalidError(
            f"corrections must be an array of at most {MAX_CORRECTIONS} corrections"
        )
    out: list[FrozenCorrection] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise CorrectionInvalidError(f"correction {item!r} is not an object")
        entry = cast(Mapping[str, object], item)
        cid = _uuid(entry.get("id"))
        if cid in seen:
            raise CorrectionInvalidError(f"correction {cid}: duplicate id")
        seen.add(cid)
        body = entry.get("correction")
        if not isinstance(body, dict):
            raise CorrectionInvalidError(f"correction {cid}: `correction` must be an object")
        out.append(FrozenCorrection(cid, _correction(cid, cast(Mapping[str, object], body))))
    return tuple(out)


def _uuid(value: object) -> str:
    try:
        if isinstance(value, str):
            return str(uuid.UUID(value))
    except ValueError:
        pass
    raise CorrectionInvalidError(f"correction id {value!r} is not a UUID")


def _correction(cid: str, body: Mapping[str, object]) -> Correction:
    kind = body.get("kind")
    if not isinstance(kind, str) or kind not in _KEYS:
        raise CorrectionInvalidError(f"correction {cid}: unknown kind {kind!r}")
    unknown = set(body) - _KEYS[kind]
    if unknown:
        raise CorrectionInvalidError(f"correction {cid}: unknown field(s) {sorted(unknown)}")
    if kind == "move_layer":
        return MoveLayer(_handle(cid, body.get("handle")), _layer(cid, body, "toLayer"))
    if kind == "set_text":
        return SetText(_handle(cid, body.get("handle")), _text(cid, body))
    if kind == "add_text":
        return AddText(
            _layer(cid, body, "layer"),
            _finite(cid, body, "x"),
            _finite(cid, body, "y"),
            _text(cid, body),
            _height(cid, body.get("height")),
        )
    if kind == "add_item":
        return AddItem(_layer(cid, body, "layer"), _finite(cid, body, "x"), _finite(cid, body, "y"))
    handles = body.get("handles")
    if not isinstance(handles, list) or not 2 <= len(handles) <= MAX_MERGE_PIECES:
        raise CorrectionInvalidError(
            f"correction {cid}: `handles` must be an array of 2-{MAX_MERGE_PIECES} handles"
        )
    parsed = tuple(_handle(cid, h) for h in handles)
    if len(set(parsed)) != len(parsed):
        raise CorrectionInvalidError(f"correction {cid}: duplicate handle")
    return MergeRoutes(parsed)


def _handle(cid: str, value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_HANDLE_LENGTH:
        raise CorrectionInvalidError(f"correction {cid}: invalid handle {value!r}")
    return value


def _layer(cid: str, body: Mapping[str, object], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_LAYER_LENGTH:
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be a 1-255 character string")
    return value


def _text(cid: str, body: Mapping[str, object]) -> str:
    value = body.get("text")
    text = value.strip() if isinstance(value, str) else ""
    if not 1 <= len(text) <= MAX_TEXT_LENGTH:
        raise CorrectionInvalidError(f"correction {cid}: `text` must be 1-255 characters")
    return text


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _finite(cid: str, body: Mapping[str, object], key: str) -> float:
    number = _number(body.get(key))
    if number is None:
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be a finite number")
    return number


def _height(cid: str, value: object) -> float | None:
    if value is None:
        return None
    number = _number(value)
    if number is None or not 0 < number <= MAX_HEIGHT:
        raise CorrectionInvalidError(f"correction {cid}: `height` must be positive or null")
    return number


def curve_handles(corrections: Iterable[FrozenCorrection]) -> frozenset[str]:
    """Handles a correction may name as a curve: the build reads these curves even when their
    layer has no rule (e.g. a line moved onto a route layer)."""
    out: set[str] = set()
    for fc in corrections:
        c = fc.correction
        if isinstance(c, MoveLayer):
            out.add(c.handle)
        elif isinstance(c, MergeRoutes):
            out.update(c.handles)
    return frozenset(out)


# ---------- applying ----------


def apply_corrections(
    drawing: DrawingData,
    corrections: Sequence[FrozenCorrection],
    *,
    metres_per_unit: float,
) -> DrawingData:
    """The drawing with every correction applied in order. `metres_per_unit` (after placement)
    turns the route end tolerance into drawing units. Raises CorrectionInvalidError."""
    if not corrections:
        return drawing
    if not metres_per_unit > 0:
        raise CorrectionInvalidError("metres per drawing unit must be positive")
    rows = _Rows(
        {c.handle: c for c in drawing.curves},
        {i.handle: i for i in drawing.inserts},
        {t.handle: t for t in drawing.texts},
    )
    touch = ROUTE_END_TOUCH_M / metres_per_unit
    for fc in corrections:
        _apply(rows, fc, touch)
    # Rows keep their reading order (dicts keep insertion order); added rows come last.
    return DrawingData(
        tuple(rows.curves.values()), tuple(rows.inserts.values()), tuple(rows.texts.values())
    )


@dataclass(slots=True)
class _Rows:
    curves: dict[str, SourceCurve]
    inserts: dict[str, SourceInsert]
    texts: dict[str, SourceText]

    def taken(self, handle: str) -> bool:
        return handle in self.curves or handle in self.inserts or handle in self.texts


def _apply(rows: _Rows, fc: FrozenCorrection, touch: float) -> None:
    c = fc.correction
    where = f"drawing correction {fc.id}"
    if isinstance(c, MoveLayer):
        _move_layer(rows, c, where)
    elif isinstance(c, SetText):
        text = rows.texts.get(c.handle)
        if text is None:
            raise CorrectionInvalidError(f"{where}: no text with handle {c.handle} in the drawing")
        rows.texts[c.handle] = dataclasses.replace(
            text, text=c.text, raw_text=c.text, readable=True
        )
    elif isinstance(c, AddText):
        _check_free(rows, fc.fix_handle, where)
        height = c.height if c.height is not None else _default_height(rows.texts.values(), c.layer)
        rows.texts[fc.fix_handle] = SourceText(
            fc.fix_handle, c.layer, (c.x, c.y), height, c.text, c.text, True
        )
    elif isinstance(c, AddItem):
        _check_free(rows, fc.fix_handle, where)
        rows.inserts[fc.fix_handle] = SourceInsert(fc.fix_handle, c.layer, FIX_BLOCK, (c.x, c.y))
    else:
        merged = merge_curves([_piece(rows, h, where) for h in c.handles], touch, where)
        for h in c.handles:
            if h != merged.handle:
                del rows.curves[h]
        rows.curves[merged.handle] = merged


def _move_layer(rows: _Rows, c: MoveLayer, where: str) -> None:
    if (insert := rows.inserts.get(c.handle)) is not None:
        rows.inserts[c.handle] = dataclasses.replace(insert, layer=c.to_layer)
    elif (text := rows.texts.get(c.handle)) is not None:
        rows.texts[c.handle] = dataclasses.replace(text, layer=c.to_layer)
    elif (curve := rows.curves.get(c.handle)) is not None:
        rows.curves[c.handle] = dataclasses.replace(curve, layer=c.to_layer)
    else:
        raise CorrectionInvalidError(f"{where}: no item with handle {c.handle} in the drawing")


def _check_free(rows: _Rows, handle: str, where: str) -> None:
    if rows.taken(handle):
        raise CorrectionInvalidError(f"{where}: handle {handle} already exists")


def _default_height(texts: Iterable[SourceText], layer: str) -> float:
    heights = [abs(t.height) for t in texts if t.layer == layer and t.readable and t.height]
    return float(statistics.median(heights)) if heights else DEFAULT_TEXT_HEIGHT


def _piece(rows: _Rows, handle: str, where: str) -> SourceCurve:
    curve = rows.curves.get(handle)
    if curve is None:
        raise CorrectionInvalidError(f"{where}: no line with handle {handle} in the drawing")
    if curve.closed or curve.entity_type not in MERGEABLE_TYPES or len(curve.points) < 2:
        raise CorrectionInvalidError(f"{where}: {handle} is not an open line or polyline")
    return curve


def merge_curves(pieces: Sequence[SourceCurve], touch: float, where: str) -> SourceCurve:
    """Chain the pieces end to end from the key piece (smallest handle), at both of its ends. At
    each end at most one unused piece may touch; otherwise the pieces are not one chain."""
    if len({p.layer for p in pieces}) != 1:
        raise CorrectionInvalidError(f"{where}: the lines to merge are on different layers")
    key = min(pieces, key=lambda p: p.handle)
    chain: list[Xy] = list(key.points)
    unused = [p for p in pieces if p.handle != key.handle]
    while unused:
        if not (
            _extend(chain, unused, touch, True, where)
            or _extend(chain, unused, touch, False, where)
        ):
            left = ", ".join(sorted(p.handle for p in unused))
            raise CorrectionInvalidError(
                f"{where}: the lines do not meet end to end in one chain ({left} not joined)"
            )
    return SourceCurve(key.handle, key.layer, tuple(chain), False, MERGED_TYPE)


def _extend(
    chain: list[Xy], unused: list[SourceCurve], touch: float, at_end: bool, where: str
) -> bool:
    """Join the one unused piece touching the chain's last (or first) point; False if none."""
    tip = chain[-1] if at_end else chain[0]
    hits = [
        (p, starts_at_tip)
        for p in unused
        for starts_at_tip, end in ((True, p.points[0]), (False, p.points[-1]))
        if math.dist(tip, end) <= touch
    ]
    if not hits:
        return False
    if len(hits) > 1:
        names = ", ".join(sorted({p.handle for p, _ in hits}))
        raise CorrectionInvalidError(
            f"{where}: more than one line end meets at one point ({names}): not one chain"
        )
    piece, starts_at_tip = hits[0]
    unused.remove(piece)
    # The piece's points, starting at the end that touches the tip.
    points = list(piece.points) if starts_at_tip else list(reversed(piece.points))
    if points[0] == tip:
        points = points[1:]  # the same vertex once
    if at_end:
        chain.extend(points)
    else:
        chain[:0] = reversed(points)
    return True
