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
  are not exactly equal are joined by the short gap between them; equal ends share one vertex;
- `dismiss_problem {code, handle, reason}`: changes no row; the build drops that problem place
  (code + handle cut to 64 characters, as the problem list gives it) from the problems (ADR-046);
- `move_item {handle, dx, dy}`: the insert's or text's point, or every point of the curve, moves by
  (dx, dy) (ADR-047);
- `rotate_item {handle, x, y, angle}`: the same points turn by `angle` degrees counter-clockwise
  about (x, y) (ADR-047). Only points are read: an insert or text keeps no orientation here;
- the CAD ribbon (ADR-050): `erase_item {handle}` removes the row; `copy_item {handle, dx, dy}` adds
  a moved copy with handle `FIX-<correction id>`; `mirror_item {handle, x1, y1, x2, y2}` reflects
  the points across that line; `scale_item {handle, x, y, factor}` scales them about (x, y) (a
  text's height too); `add_curve {layer, points, closed}` adds a line / polyline `FIX-<id>`;
  `add_layer {layer, like}` and `rename_layer {from, to}` give a layer the rule of another (the
  build copies that rule to a layer without one, `layer_aliases`; ADR-051: also a layer of the
  drawing without a rule, so what is drawn on it counts; `like` null = a layer for drawing only),
  and a rename moves every row of `from` to `to`;
  `delete_layer {layer}` removes every row on the layer.
- the AutoCAD-like screen (ADR-051): `set_curve {handle, points, closed}` replaces a curve's points
  (the result of Trim, Fillet, Stretch or Extend; handle and layer stay); `add_note {note, layer,
  points, text}` (a dimension or leader) and `set_style {handle, color, linetype, lineweight}` are
  checked and then ignored: they are drawn on the screen only and change no row, quantity or
  problem.
- the drawing screen (owner 2026-11-24): `add_shape {shape, layer, points, pattern, scale, angle,
  color, color2, inner, outer}` (a hatch, gradient, wipeout, donut, XLINE or RAY) and
  `set_order {handle, order}` (AutoCAD's draw order) are checked and then ignored, as notes;
  `copy_item` may carry `toLayer` (COPYTOLAYER: the copy goes on that layer); `merge_layer
  {from, to}` (LAYMRG) moves every row of `from` to `to`, which keeps its own rule (the curves of
  `from` are read even when it has no rule, `merged_layers`); `set_attribute {handle, from, to}`
  (EATTEDIT) gives the insert's first attribute whose value is `from` the value `to`; `set_group
  {name, handles, block}` (GROUP / BLOCK made on the page) is screen only.
- the Text panel, TABLE and HATCH (ADR-055 parts 7-8): `set_text_format {handle, widthFactor,
  mtext, wrap, mask}` (TEXTFIT, TXT2MTXT, TEXTMASK) and `add_table {layer, x, y, columns, rows,
  height, styles, cells}` are checked and then ignored; `add_shape` gains `loops`, `island`,
  `background`, `transparency`, `origin`, `double` and `drawOrder` (checked, ignored).

Items drawn on the page are objects (ADR-061): a later correction may name `FIX-<id>` of an
added text, item, line or copy and is applied to its row like any other. Notes, shapes and tables
(and copies of them) have no row: a correction that names one is checked and ignored, an erase
drops it. A correction naming an added item that has no row any more (its layer was deleted, it
was erased) is skipped, not an error.

A correction that cannot be applied (handle gone after the file was processed again, wrong kind of
entity, pieces not forming one chain) fails the revision loudly (`MAPPING_INVALID`) with the reason:
a correction is never skipped silently. Background tiles render from the raw rows in PostGIS, so
corrections do not show on the background layer (only on features, text links and problems).
"""

from __future__ import annotations

import bisect
import dataclasses
import math
import re
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
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
from cad_worker.domain.drawing_checks import PROBLEM_CODES, ROUTE_END_TOUCH_M

MAX_HANDLE_LENGTH = 64
MAX_LAYER_LENGTH = 255
MAX_TEXT_LENGTH = 255
MAX_HEIGHT = 1_000_000.0
MAX_MERGE_PIECES = 50
MAX_CORRECTIONS = 5000
# |x| and |y| of an added text or item, drawing units (technical cap, as the contract).
MAX_CORRECTION_COORD = 1_000_000_000
# |angle| of a rotation, degrees (as the contract).
MAX_ROTATION_DEG = 360.0
MIN_SCALE_FACTOR = 0.001
MAX_SCALE_FACTOR = 1000.0
MAX_CURVE_POINTS = 2000
MAX_NOTE_POINTS = 50
MAX_LINEWEIGHT_MM = 10.0
NOTE_KINDS = frozenset({"dimension", "leader"})
LINETYPES = frozenset({"continuous", "dashed", "dotted", "center"})
SHAPE_KINDS = frozenset({"hatch", "gradient", "wipeout", "donut", "xline", "ray"})
GRADIENT_PATTERNS = frozenset(
    {
        "GR_LINEAR",
        "GR_CYLIN",
        "GR_INVCYL",
        "GR_SPHER",
        "GR_INVSPH",
        "GR_HEMISP",
        "GR_INVHEM",
        "GR_CURVED",
        "GR_INVCUR",
    }
)
HATCH_PATTERNS = (
    frozenset(
        {
            "SOLID",
            "ANGLE",
            "ANSI31",
            "ANSI32",
            "ANSI33",
            "ANSI34",
            "ANSI35",
            "ANSI36",
            "ANSI37",
            "ANSI38",
            "AR-B816",
            "AR-B88",
            "AR-BRSTD",
            "AR-HBONE",
            "BRICK",
            "CROSS",
            "DASH",
            "DOTS",
            "EARTH",
            "GRASS",
            "HEX",
            "HONEY",
            "LINE",
            "NET",
            "NET3",
            "SQUARE",
            "STARS",
            "TRIANG",
            "ZIGZAG",
            "USER",
        }
    )
    | GRADIENT_PATTERNS
)
HATCH_ISLAND_STYLES = frozenset({"normal", "outer", "ignore"})
HATCH_DRAW_ORDERS = frozenset({"none", "back", "front", "behind", "above"})
MAX_HATCH_LOOPS = 100
MAX_HATCH_TRANSPARENCY = 90
MAX_TEXT_MASK_OFFSET = 5.0
MIN_TEXT_WIDTH_FACTOR = 0.01
MAX_TEXT_WIDTH_FACTOR = 100.0
MAX_TABLE_COLUMNS = 100
MAX_TABLE_ROWS = 500
MAX_TABLE_CELLS = 10_000
TABLE_CELL_STYLES = frozenset({"title", "header", "data"})
MAX_DRAW_ORDER = 1_000_000_000
MAX_GROUP_HANDLES = 2000
_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
ADDED_CURVE_TYPE = "LWPOLYLINE"
# Control characters U+0000-U+001F are refused in handles, layers and texts (as the contract).
_CONTROL = re.compile(r"[\x00-\x1f]")
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


@dataclass(frozen=True, slots=True)
class DismissProblem:
    code: str
    handle: str
    reason: str


@dataclass(frozen=True, slots=True)
class MoveItem:
    handle: str
    dx: float
    dy: float


@dataclass(frozen=True, slots=True)
class RotateItem:
    handle: str
    x: float
    y: float
    angle: float


@dataclass(frozen=True, slots=True)
class EraseItem:
    handle: str


@dataclass(frozen=True, slots=True)
class CopyItem:
    handle: str
    dx: float
    dy: float
    to_layer: str | None = None


@dataclass(frozen=True, slots=True)
class MirrorItem:
    handle: str
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(frozen=True, slots=True)
class ScaleItem:
    handle: str
    x: float
    y: float
    factor: float


@dataclass(frozen=True, slots=True)
class AddCurve:
    layer: str
    points: tuple[Xy, ...]
    closed: bool


@dataclass(frozen=True, slots=True)
class AddLayer:
    layer: str
    # None: a layer for drawing only (owner 2026-11-19, ADR-051): no rule, the build ignores it.
    like: str | None


@dataclass(frozen=True, slots=True)
class RenameLayer:
    from_layer: str
    to_layer: str


@dataclass(frozen=True, slots=True)
class DeleteLayer:
    layer: str


@dataclass(frozen=True, slots=True)
class SetCurve:
    handle: str
    points: tuple[Xy, ...]
    closed: bool


@dataclass(frozen=True, slots=True)
class AddNote:
    """Screen only (ADR-051): the build ignores it."""

    note: str
    layer: str
    points: tuple[Xy, ...]
    text: str | None


@dataclass(frozen=True, slots=True)
class SetStyle:
    """Screen only (ADR-051): the build ignores it."""

    handle: str
    color: str | None
    linetype: str | None
    lineweight: float | None


@dataclass(frozen=True, slots=True)
class AddShape:
    """Screen only (owner 2026-11-24): the build ignores it."""

    shape: str
    layer: str
    points: tuple[Xy, ...]


@dataclass(frozen=True, slots=True)
class SetTextFormat:
    """Screen only (ADR-055 part 7: TEXTFIT, TXT2MTXT, TEXTMASK): the build ignores it."""

    handle: str


@dataclass(frozen=True, slots=True)
class AddTable:
    """Screen only (owner 2026-11-26: TABLE): the build ignores it."""

    layer: str
    rows: int
    columns: int


@dataclass(frozen=True, slots=True)
class MergeLayer:
    from_layer: str
    to_layer: str


@dataclass(frozen=True, slots=True)
class SetAttribute:
    handle: str
    from_value: str
    to_value: str


@dataclass(frozen=True, slots=True)
class SetGroup:
    """Screen only (owner 2026-11-24): the build ignores it."""

    name: str
    handles: tuple[str, ...]
    block: bool


@dataclass(frozen=True, slots=True)
class SetOrder:
    """Screen only (owner 2026-11-24): the build ignores it."""

    handle: str
    order: float


Correction = (
    MoveLayer
    | SetText
    | AddText
    | AddItem
    | MergeRoutes
    | DismissProblem
    | MoveItem
    | RotateItem
    | EraseItem
    | CopyItem
    | MirrorItem
    | ScaleItem
    | AddCurve
    | AddLayer
    | RenameLayer
    | DeleteLayer
    | SetCurve
    | AddNote
    | SetStyle
    | AddShape
    | SetOrder
    | MergeLayer
    | SetAttribute
    | SetGroup
    | SetTextFormat
    | AddTable
)


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
    "dismiss_problem": frozenset({"kind", "code", "handle", "reason"}),
    "move_item": frozenset({"kind", "handle", "dx", "dy"}),
    "rotate_item": frozenset({"kind", "handle", "x", "y", "angle"}),
    "erase_item": frozenset({"kind", "handle"}),
    "copy_item": frozenset({"kind", "handle", "dx", "dy", "toLayer"}),
    "mirror_item": frozenset({"kind", "handle", "x1", "y1", "x2", "y2"}),
    "scale_item": frozenset({"kind", "handle", "x", "y", "factor"}),
    "add_curve": frozenset({"kind", "layer", "points", "closed"}),
    "add_layer": frozenset({"kind", "layer", "like"}),
    "rename_layer": frozenset({"kind", "from", "to"}),
    "delete_layer": frozenset({"kind", "layer"}),
    "set_curve": frozenset({"kind", "handle", "points", "closed"}),
    "add_note": frozenset({"kind", "note", "layer", "points", "text"}),
    "set_style": frozenset({"kind", "handle", "color", "linetype", "lineweight"}),
    "add_shape": frozenset(
        {
            "kind",
            "shape",
            "layer",
            "points",
            "pattern",
            "scale",
            "angle",
            "color",
            "color2",
            "inner",
            "outer",
            "loops",
            "island",
            "background",
            "transparency",
            "origin",
            "double",
            "drawOrder",
        }
    ),
    "set_order": frozenset({"kind", "handle", "order"}),
    "merge_layer": frozenset({"kind", "from", "to"}),
    "set_attribute": frozenset({"kind", "handle", "from", "to"}),
    "set_group": frozenset({"kind", "name", "handles", "block"}),
    "set_text_format": frozenset({"kind", "handle", "widthFactor", "mtext", "wrap", "mask"}),
    "add_table": frozenset(
        {"kind", "layer", "x", "y", "columns", "rows", "height", "styles", "cells"}
    ),
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
    if kind == "dismiss_problem":
        code = body.get("code")
        if code not in PROBLEM_CODES:
            raise CorrectionInvalidError(f"correction {cid}: unknown problem code {code!r}")
        handle = _handle(cid, body.get("handle"))
        return DismissProblem(str(code), handle, _text(cid, body, "reason"))
    if kind == "move_item":
        return MoveItem(
            _handle(cid, body.get("handle")), _finite(cid, body, "dx"), _finite(cid, body, "dy")
        )
    if kind == "rotate_item":
        angle = _number(body.get("angle"))
        if angle is None or abs(angle) > MAX_ROTATION_DEG:
            raise CorrectionInvalidError(
                f"correction {cid}: `angle` must be a number within ±{MAX_ROTATION_DEG:g}"
            )
        return RotateItem(
            _handle(cid, body.get("handle")),
            _finite(cid, body, "x"),
            _finite(cid, body, "y"),
            angle,
        )
    if kind == "erase_item":
        return EraseItem(_handle(cid, body.get("handle")))
    if kind == "copy_item":
        return CopyItem(
            _handle(cid, body.get("handle")),
            _finite(cid, body, "dx"),
            _finite(cid, body, "dy"),
            None if body.get("toLayer") is None else _layer(cid, body, "toLayer"),
        )
    if kind == "mirror_item":
        m = MirrorItem(
            _handle(cid, body.get("handle")),
            _finite(cid, body, "x1"),
            _finite(cid, body, "y1"),
            _finite(cid, body, "x2"),
            _finite(cid, body, "y2"),
        )
        if m.x1 == m.x2 and m.y1 == m.y2:
            raise CorrectionInvalidError(f"correction {cid}: the mirror line needs two points")
        return m
    if kind == "scale_item":
        factor = _number(body.get("factor"))
        if factor is None or not MIN_SCALE_FACTOR <= factor <= MAX_SCALE_FACTOR:
            raise CorrectionInvalidError(
                f"correction {cid}: `factor` must be {MIN_SCALE_FACTOR:g}-{MAX_SCALE_FACTOR:g}"
            )
        return ScaleItem(
            _handle(cid, body.get("handle")),
            _finite(cid, body, "x"),
            _finite(cid, body, "y"),
            factor,
        )
    if kind == "add_curve":
        return AddCurve(
            _layer(cid, body, "layer"), _points(cid, body.get("points")), _flag(cid, body)
        )
    if kind == "add_layer":
        like = None if body.get("like") is None else _layer(cid, body, "like")
        added = AddLayer(_layer(cid, body, "layer"), like)
        if added.layer == added.like:
            raise CorrectionInvalidError(f"correction {cid}: the new layer needs its own name")
        return added
    if kind == "rename_layer":
        renamed = RenameLayer(_layer(cid, body, "from"), _layer(cid, body, "to"))
        if renamed.from_layer == renamed.to_layer:
            raise CorrectionInvalidError(f"correction {cid}: the new name must differ")
        return renamed
    if kind == "delete_layer":
        return DeleteLayer(_layer(cid, body, "layer"))
    if kind == "set_curve":
        return SetCurve(
            _handle(cid, body.get("handle")), _points(cid, body.get("points")), _flag(cid, body)
        )
    if kind == "add_note":
        return _note(cid, body)
    if kind == "set_style":
        return _style(cid, body)
    if kind == "add_shape":
        return _shape(cid, body)
    if kind == "merge_layer":
        merged = MergeLayer(_layer(cid, body, "from"), _layer(cid, body, "to"))
        if merged.from_layer == merged.to_layer:
            raise CorrectionInvalidError(f"correction {cid}: merge into another layer")
        return merged
    if kind == "set_attribute":
        changed = SetAttribute(
            _handle(cid, body.get("handle")), _text(cid, body, "from"), _text(cid, body, "to")
        )
        if changed.from_value == changed.to_value:
            raise CorrectionInvalidError(f"correction {cid}: the new value must differ")
        return changed
    if kind == "set_group":
        handles = body.get("handles")
        if not isinstance(handles, list) or len(handles) > MAX_GROUP_HANDLES:
            raise CorrectionInvalidError(
                f"correction {cid}: `handles` must be an array of at most {MAX_GROUP_HANDLES}"
            )
        block = body.get("block", False)
        if not isinstance(block, bool):
            raise CorrectionInvalidError(f"correction {cid}: `block` must be true or false")
        return SetGroup(_text(cid, body, "name"), tuple(_handle(cid, h) for h in handles), block)
    if kind == "set_text_format":
        return _text_format(cid, body)
    if kind == "add_table":
        return _table(cid, body)
    if kind == "set_order":
        order = _number(body.get("order"))
        if order is None or abs(order) > MAX_DRAW_ORDER:
            raise CorrectionInvalidError(
                f"correction {cid}: `order` must be a number within ±{MAX_DRAW_ORDER}"
            )
        return SetOrder(_handle(cid, body.get("handle")), order)
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
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= MAX_HANDLE_LENGTH
        or _CONTROL.search(value)
    ):
        raise CorrectionInvalidError(f"correction {cid}: invalid handle {value!r}")
    return value


def _layer(cid: str, body: Mapping[str, object], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_LAYER_LENGTH:
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be a 1-255 character string")
    if _CONTROL.search(value):
        raise CorrectionInvalidError(f"correction {cid}: `{key}` has a control character")
    return value


def _text(cid: str, body: Mapping[str, object], key: str = "text") -> str:
    value = body.get(key)
    text = value.strip() if isinstance(value, str) else ""
    if not 1 <= len(text) <= MAX_TEXT_LENGTH:
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be 1-255 characters")
    if _CONTROL.search(text):
        raise CorrectionInvalidError(f"correction {cid}: `{key}` has a control character")
    return text


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _finite(cid: str, body: Mapping[str, object], key: str) -> float:
    number = _number(body.get(key))
    if number is None or abs(number) > MAX_CORRECTION_COORD:
        raise CorrectionInvalidError(
            f"correction {cid}: `{key}` must be a number within ±{MAX_CORRECTION_COORD}"
        )
    return number


def _note(cid: str, body: Mapping[str, object]) -> AddNote:
    note = body.get("note")
    if note not in NOTE_KINDS:
        raise CorrectionInvalidError(f"correction {cid}: unknown note {note!r}")
    text = None if body.get("text") is None else _text(cid, body)
    points = _points(cid, body.get("points"), least=1, most=MAX_NOTE_POINTS)
    return AddNote(str(note), _layer(cid, body, "layer"), points, text)


def _optional_colour(cid: str, body: Mapping[str, object], key: str) -> None:
    value = body.get(key)
    if value is not None and not (isinstance(value, str) and _COLOR.fullmatch(value)):
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be #rrggbb or null")


def _shape(cid: str, body: Mapping[str, object]) -> AddShape:
    shape = body.get("shape")
    if shape not in SHAPE_KINDS:
        raise CorrectionInvalidError(f"correction {cid}: unknown shape {shape!r}")
    points = _points(cid, body.get("points"), least=1)
    count = {"donut": (1, 1), "xline": (2, 2), "ray": (2, 2)}.get(str(shape), (3, MAX_CURVE_POINTS))
    if not count[0] <= len(points) <= count[1]:
        raise CorrectionInvalidError(f"correction {cid}: wrong number of points for a {shape}")
    if shape in ("xline", "ray") and points[0] == points[1]:
        raise CorrectionInvalidError(f"correction {cid}: the direction needs two different points")
    pattern = body.get("pattern")
    if pattern is not None and pattern not in HATCH_PATTERNS:
        raise CorrectionInvalidError(f"correction {cid}: unknown pattern {pattern!r}")
    for key, low, high in (
        ("scale", MIN_SCALE_FACTOR, MAX_SCALE_FACTOR),
        ("angle", -MAX_ROTATION_DEG, MAX_ROTATION_DEG),
    ):
        if key in body:
            number = _number(body.get(key))
            if number is None or not low <= number <= high:
                raise CorrectionInvalidError(f"correction {cid}: `{key}` must be {low:g}-{high:g}")
    _optional_colour(cid, body, "color")
    _optional_colour(cid, body, "color2")
    sizes: dict[str, float | None] = {}
    for key in ("inner", "outer"):
        raw = body.get(key)
        sizes[key] = None if raw is None else _number(raw)
        if raw is not None and (
            sizes[key] is None or not 0 <= (sizes[key] or 0) <= MAX_CORRECTION_COORD
        ):
            raise CorrectionInvalidError(f"correction {cid}: `{key}` must be a size or null")
    if shape == "donut":
        outer, inner = sizes["outer"], sizes["inner"] or 0.0
        if outer is None or outer <= 0 or inner >= outer:
            raise CorrectionInvalidError(
                f"correction {cid}: a donut needs an outer diameter above the inner one"
            )
    _hatch_fields(cid, body, str(shape))
    return AddShape(str(shape), _layer(cid, body, "layer"), points)


def _hatch_fields(cid: str, body: Mapping[str, object], shape: str) -> None:
    """The HATCH fields of `add_shape` (ADR-055 part 8): checked as the contract, then ignored."""
    filled = shape in ("hatch", "gradient")
    pattern = body.get("pattern")
    if filled and pattern is not None and (pattern in GRADIENT_PATTERNS) != (shape == "gradient"):
        raise CorrectionInvalidError(
            f"correction {cid}: GR_ patterns are for a gradient, the others for a hatch"
        )
    loops = body.get("loops", [])
    if not isinstance(loops, list) or len(loops) > MAX_HATCH_LOOPS:
        raise CorrectionInvalidError(
            f"correction {cid}: `loops` must be an array of at most {MAX_HATCH_LOOPS} loops"
        )
    if loops and not filled:
        raise CorrectionInvalidError(f"correction {cid}: only a hatch or gradient has more loops")
    for loop in loops:
        _points(cid, loop, least=3)
    if body.get("island", "normal") not in HATCH_ISLAND_STYLES:
        raise CorrectionInvalidError(f"correction {cid}: unknown island detection")
    if body.get("drawOrder", "behind") not in HATCH_DRAW_ORDERS:
        raise CorrectionInvalidError(f"correction {cid}: unknown hatch draw order")
    _optional_colour(cid, body, "background")
    transparency = body.get("transparency", 0)
    if (
        isinstance(transparency, bool)
        or not isinstance(transparency, int)
        or not 0 <= transparency <= MAX_HATCH_TRANSPARENCY
    ):
        raise CorrectionInvalidError(
            f"correction {cid}: `transparency` must be a whole 0-{MAX_HATCH_TRANSPARENCY}"
        )
    origin = body.get("origin")
    if origin is not None:
        _points(cid, [origin], least=1, most=1)
    if not isinstance(body.get("double", False), bool):
        raise CorrectionInvalidError(f"correction {cid}: `double` must be true or false")


def _text_format(cid: str, body: Mapping[str, object]) -> SetTextFormat:
    raw = body.get("widthFactor")
    factor = None if raw is None else _number(raw)
    if raw is not None and (
        factor is None or not MIN_TEXT_WIDTH_FACTOR <= factor <= MAX_TEXT_WIDTH_FACTOR
    ):
        raise CorrectionInvalidError(
            f"correction {cid}: `widthFactor` must be "
            f"{MIN_TEXT_WIDTH_FACTOR:g}-{MAX_TEXT_WIDTH_FACTOR:g} or null"
        )
    if not isinstance(body.get("mtext", False), bool):
        raise CorrectionInvalidError(f"correction {cid}: `mtext` must be true or false")
    wrap = body.get("wrap")
    if wrap is not None:
        _positive(cid, wrap, "wrap")
    mask = body.get("mask")
    if mask is not None:
        if not isinstance(mask, dict) or set(mask) - {"offset", "color"}:
            raise CorrectionInvalidError(f"correction {cid}: `mask` must be {{offset, color}}")
        fields = cast(Mapping[str, object], mask)
        offset = _number(fields.get("offset"))
        if offset is None or not 0 <= offset <= MAX_TEXT_MASK_OFFSET:
            raise CorrectionInvalidError(
                f"correction {cid}: a mask offset must be 0-{MAX_TEXT_MASK_OFFSET:g}"
            )
        _optional_colour(cid, fields, "color")
    return SetTextFormat(_handle(cid, body.get("handle")))


def _positive(cid: str, value: object, key: str) -> float:
    number = _number(value)
    if number is None or not 0 < number <= MAX_CORRECTION_COORD:
        raise CorrectionInvalidError(f"correction {cid}: `{key}` must be a positive size")
    return number


def _table(cid: str, body: Mapping[str, object]) -> AddTable:
    _finite(cid, body, "x")
    _finite(cid, body, "y")
    _positive(cid, body.get("height"), "height")
    sizes: dict[str, int] = {}
    for key, most in (("columns", MAX_TABLE_COLUMNS), ("rows", MAX_TABLE_ROWS)):
        value = body.get(key)
        if not isinstance(value, list) or not 1 <= len(value) <= most:
            raise CorrectionInvalidError(f"correction {cid}: `{key}` must be 1-{most} sizes")
        for size in value:
            _positive(cid, size, key)
        sizes[key] = len(value)
    if sizes["rows"] * sizes["columns"] > MAX_TABLE_CELLS:
        raise CorrectionInvalidError(f"correction {cid}: too many cells")
    styles = body.get("styles", ["title", "header", "data"])
    if (
        not isinstance(styles, list)
        or len(styles) != 3
        or any(style not in TABLE_CELL_STYLES for style in styles)
    ):
        raise CorrectionInvalidError(f"correction {cid}: `styles` must be three cell styles")
    cells = body.get("cells")
    if not isinstance(cells, list) or len(cells) != sizes["rows"]:
        raise CorrectionInvalidError(f"correction {cid}: one cell per row and column")
    for row in cells:
        if not isinstance(row, list) or len(row) != sizes["columns"]:
            raise CorrectionInvalidError(f"correction {cid}: one cell per row and column")
        for cell in row:
            if not isinstance(cell, str) or len(cell) > MAX_TEXT_LENGTH or _CONTROL.search(cell):
                raise CorrectionInvalidError(f"correction {cid}: a cell must be one line of text")
    return AddTable(_layer(cid, body, "layer"), sizes["rows"], sizes["columns"])


def _style(cid: str, body: Mapping[str, object]) -> SetStyle:
    color = body.get("color")
    if color is not None and not (isinstance(color, str) and _COLOR.fullmatch(color)):
        raise CorrectionInvalidError(f"correction {cid}: `color` must be #rrggbb or null")
    linetype = body.get("linetype")
    if linetype is not None and linetype not in LINETYPES:
        raise CorrectionInvalidError(f"correction {cid}: unknown line type {linetype!r}")
    raw_weight = body.get("lineweight")
    weight = None if raw_weight is None else _number(raw_weight)
    if raw_weight is not None and (weight is None or not 0 <= weight <= MAX_LINEWEIGHT_MM):
        raise CorrectionInvalidError(
            f"correction {cid}: `lineweight` must be 0-{MAX_LINEWEIGHT_MM:g} mm or null"
        )
    return SetStyle(
        _handle(cid, body.get("handle")),
        color if isinstance(color, str) else None,
        linetype if isinstance(linetype, str) else None,
        weight,
    )


def _points(
    cid: str, value: object, *, least: int = 2, most: int = MAX_CURVE_POINTS
) -> tuple[Xy, ...]:
    if not isinstance(value, list) or not least <= len(value) <= most:
        raise CorrectionInvalidError(
            f"correction {cid}: `points` must be {least}-{most} [x, y] pairs"
        )
    out: list[Xy] = []
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            raise CorrectionInvalidError(f"correction {cid}: a point must be [x, y]")
        x, y = _number(point[0]), _number(point[1])
        if x is None or y is None or abs(x) > MAX_CORRECTION_COORD or abs(y) > MAX_CORRECTION_COORD:
            raise CorrectionInvalidError(f"correction {cid}: a point is not a finite coordinate")
        out.append((x, y))
    return tuple(out)


def _flag(cid: str, body: Mapping[str, object]) -> bool:
    value = body.get("closed", False)
    if not isinstance(value, bool):
        raise CorrectionInvalidError(f"correction {cid}: `closed` must be true or false")
    return value


def _height(cid: str, value: object) -> float | None:
    if value is None:
        return None
    number = _number(value)
    if number is None or not 0 < number <= MAX_HEIGHT:
        raise CorrectionInvalidError(f"correction {cid}: `height` must be positive or null")
    return number


def dismissed_places(corrections: Iterable[FrozenCorrection]) -> frozenset[tuple[str, str]]:
    """(problem code, place handle) of the problem places dismissed by a PM (ADR-046)."""
    return frozenset(
        (c.code, c.handle) for fc in corrections if isinstance(c := fc.correction, DismissProblem)
    )


def layer_aliases(corrections: Iterable[FrozenCorrection]) -> dict[str, str]:
    """Layer -> the layer whose mapping rule it takes, from `add_layer` / `rename_layer` in order
    (ADR-050); a chain resolves to the first layer. Mirror of `layerAliases` in the contract."""
    out: dict[str, str] = {}
    for fc in corrections:
        c = fc.correction
        if isinstance(c, AddLayer):
            if c.like is not None:
                out[c.layer] = out.get(c.like, c.like)
        elif isinstance(c, RenameLayer):
            out[c.to_layer] = out.get(c.from_layer, c.from_layer)
    return out


def with_layer_aliases(raw_rules: object, aliases: Mapping[str, str]) -> object:
    """The frozen mapping rules plus, for each aliased layer without a rule of its own, a copy of
    the layer rule of its source (ADR-050). Anything else is returned as it is (parse_rules
    checks it)."""
    if not aliases or not isinstance(raw_rules, list):
        return raw_rules
    by_layer: dict[str, Mapping[str, object]] = {}
    for item in raw_rules:
        if isinstance(item, dict) and item.get("source") == "layer":
            name = item.get("layer")
            if isinstance(name, str):
                by_layer[name] = cast(Mapping[str, object], item)
    extra = [
        {**by_layer[like], "layer": layer}
        for layer, like in aliases.items()
        if layer not in by_layer and like in by_layer
    ]
    return [*raw_rules, *extra]


def curve_handles(corrections: Iterable[FrozenCorrection]) -> frozenset[str]:
    """Handles a correction may name as a curve: the build reads these curves even when their
    layer has no rule (e.g. a line moved onto a route layer)."""
    out: set[str] = set()
    for fc in corrections:
        c = fc.correction
        if isinstance(
            c, MoveLayer | MoveItem | RotateItem | CopyItem | MirrorItem | ScaleItem | SetCurve
        ):
            out.add(c.handle)
        elif isinstance(c, MergeRoutes):
            out.update(c.handles)
    return frozenset(out)


def merged_layers(corrections: Iterable[FrozenCorrection]) -> frozenset[str]:
    """Layers a `merge_layer` empties: their curves are read even when they have no rule, so
    they reach the layer they are merged into."""
    return frozenset(
        fc.correction.from_layer for fc in corrections if isinstance(fc.correction, MergeLayer)
    )


# ---------- applying ----------


def apply_corrections(
    drawing: DrawingData,
    corrections: Sequence[FrozenCorrection],
    *,
    metres_per_unit: float,
    move_targets: frozenset[str] | None = None,
) -> DrawingData:
    """The drawing with every correction applied in order. `metres_per_unit` (after placement)
    turns the route end tolerance into drawing units. `move_targets`: the layers a `move_layer` may
    target (layers whose rule is a feature type or `label`, owner 2026-11-09); None = not checked.
    Raises CorrectionInvalidError."""
    if not corrections:
        return drawing
    if move_targets is not None:
        aliases = layer_aliases(corrections)
        move_targets = move_targets | {a for a, like in aliases.items() if like in move_targets}
        for fc in corrections:
            c = fc.correction
            target = c.to_layer if isinstance(c, MoveLayer | MergeLayer) else None
            if target is not None and target not in move_targets:
                raise CorrectionInvalidError(
                    f"drawing correction {fc.id}: layer {target} has no rule that makes it a "
                    "drawing item or label"
                )
    if not metres_per_unit > 0:
        raise CorrectionInvalidError("metres per drawing unit must be positive")
    rows = _Rows(
        {c.handle: c for c in drawing.curves},
        {i.handle: i for i in drawing.inserts},
        {t.handle: t for t in drawing.texts},
    )
    for t in drawing.texts:
        rows.count_height(t, +1)
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
    # Layer -> sorted heights of its readable texts, kept in step by `put_text`: a default text
    # height is a lookup, not a scan of every text (security review M).
    heights: dict[str, list[float]] = dataclasses.field(default_factory=dict)
    # `FIX-<id>` handles of added items that have no row (note, shape, table and copies of them,
    # ADR-061): later corrections that name them are checked and ignored.
    screen: set[str] = dataclasses.field(default_factory=set)

    def taken(self, handle: str) -> bool:
        return handle in self.curves or handle in self.inserts or handle in self.texts

    def put_text(self, text: SourceText) -> None:
        """Add or replace a text row (by handle), keeping the height index in step."""
        old = self.texts.get(text.handle)
        if old is not None:
            self.count_height(old, -1)
        self.texts[text.handle] = text
        self.count_height(text, +1)

    def count_height(self, text: SourceText, step: int) -> None:
        if not text.readable or not text.height:
            return
        height = abs(text.height)
        layer = self.heights.setdefault(text.layer, [])
        if step > 0:
            bisect.insort(layer, height)
        else:
            del layer[bisect.bisect_left(layer, height)]

    def median_height(self, layer: str) -> float:
        """Median height of the readable texts on the layer, else DEFAULT_TEXT_HEIGHT."""
        heights = self.heights.get(layer)
        if not heights:
            return DEFAULT_TEXT_HEIGHT
        mid = len(heights) // 2
        return heights[mid] if len(heights) % 2 else (heights[mid - 1] + heights[mid]) / 2


def _named_handles(c: Correction) -> tuple[str, ...]:
    """The handles a correction names (none for the corrections that add or name layers)."""
    if isinstance(c, MergeRoutes | SetGroup):
        return tuple(c.handles)
    if isinstance(c, DismissProblem):
        return ()
    handle = getattr(c, "handle", None)
    return (handle,) if isinstance(handle, str) else ()


def _apply_to_added(rows: _Rows, fc: FrozenCorrection) -> bool:
    """Handles the correction that names an item an earlier correction added (ADR-061): True when
    it is done (ignored). A screen-only item has no row: the correction is ignored, an erase drops
    it, a copy of it is screen-only too. An added item with no row any more (its layer was
    deleted, it was erased) makes the correction skipped, not an error. Rows of the drawing and
    rows still there are left to the usual code (and its errors)."""
    c = fc.correction
    named = [h for h in _named_handles(c) if h.startswith(FIX_HANDLE_PREFIX)]
    if not named:
        return False
    if any(h in rows.screen for h in named):
        if isinstance(c, EraseItem):
            rows.screen.discard(c.handle)
        elif isinstance(c, CopyItem):
            rows.screen.add(fc.fix_handle)
        return True
    return any(not rows.taken(h) for h in named)


def _apply(rows: _Rows, fc: FrozenCorrection, touch: float) -> None:
    c = fc.correction
    where = f"drawing correction {fc.id}"
    if _apply_to_added(rows, fc):
        return
    if isinstance(c, MoveLayer):
        _move_layer(rows, c, where)
    elif isinstance(c, SetText):
        text = rows.texts.get(c.handle)
        if text is None:
            raise CorrectionInvalidError(f"{where}: no text with handle {c.handle} in the drawing")
        rows.put_text(dataclasses.replace(text, text=c.text, raw_text=c.text, readable=True))
    elif isinstance(c, AddText):
        _check_free(rows, fc.fix_handle, where)
        height = c.height if c.height is not None else rows.median_height(c.layer)
        rows.put_text(SourceText(fc.fix_handle, c.layer, (c.x, c.y), height, c.text, c.text, True))
    elif isinstance(c, AddItem):
        _check_free(rows, fc.fix_handle, where)
        rows.inserts[fc.fix_handle] = SourceInsert(fc.fix_handle, c.layer, FIX_BLOCK, (c.x, c.y))
    elif isinstance(c, DismissProblem):
        return  # changes no row: the checks drop the place (dismissed_places)
    elif isinstance(c, MoveItem):
        _transform(rows, c.handle, lambda p: (p[0] + c.dx, p[1] + c.dy), where)
    elif isinstance(c, RotateItem):
        rad = math.radians(c.angle)
        cos, sin = math.cos(rad), math.sin(rad)

        def turn(p: Xy) -> Xy:
            dx, dy = p[0] - c.x, p[1] - c.y
            return (c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos)

        _transform(rows, c.handle, turn, where)
    elif isinstance(c, EraseItem):
        _erase(rows, c.handle, where)
    elif isinstance(c, CopyItem):
        _copy(rows, c, fc.fix_handle, where)
    elif isinstance(c, MirrorItem):
        _transform(rows, c.handle, _mirror(c), where)
    elif isinstance(c, ScaleItem):
        _transform(
            rows,
            c.handle,
            lambda p: (c.x + (p[0] - c.x) * c.factor, c.y + (p[1] - c.y) * c.factor),
            where,
            height=c.factor,
        )
    elif isinstance(c, AddCurve):
        _check_free(rows, fc.fix_handle, where)
        rows.curves[fc.fix_handle] = SourceCurve(
            fc.fix_handle, c.layer, c.points, c.closed, ADDED_CURVE_TYPE
        )
    elif isinstance(c, AddLayer):
        return  # changes no row: the build copies the rule (with_layer_aliases)
    elif isinstance(c, SetCurve):
        curve = rows.curves.get(c.handle)
        if curve is None:
            raise CorrectionInvalidError(f"{where}: no line with handle {c.handle} in the drawing")
        rows.curves[c.handle] = dataclasses.replace(curve, points=c.points, closed=c.closed)
    elif isinstance(
        c, AddNote | SetStyle | AddShape | SetOrder | SetGroup | SetTextFormat | AddTable
    ):
        if isinstance(c, AddNote | AddShape | AddTable):
            rows.screen.add(fc.fix_handle)  # an object of the page: later edits are ignored
        return  # screen only (ADR-051): no row, quantity or problem changes
    elif isinstance(c, MergeLayer):
        _relayer(rows, c.from_layer, c.to_layer)
    elif isinstance(c, SetAttribute):
        _set_attribute(rows, c, where)
    elif isinstance(c, RenameLayer):
        _relayer(rows, c.from_layer, c.to_layer)
    elif isinstance(c, DeleteLayer):
        for handle in [h for h, r in rows.inserts.items() if r.layer == c.layer]:
            del rows.inserts[handle]
        for handle in [h for h, t in rows.texts.items() if t.layer == c.layer]:
            _erase(rows, handle, where)
        for handle in [h for h, r in rows.curves.items() if r.layer == c.layer]:
            del rows.curves[handle]
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
        rows.put_text(dataclasses.replace(text, layer=c.to_layer))
    elif (curve := rows.curves.get(c.handle)) is not None:
        rows.curves[c.handle] = dataclasses.replace(curve, layer=c.to_layer)
    else:
        raise CorrectionInvalidError(f"{where}: no item with handle {c.handle} in the drawing")


def _transform(
    rows: _Rows, handle: str, move: Callable[[Xy], Xy], where: str, *, height: float = 1.0
) -> None:
    """Moves the points of the insert, text or curve with this handle (ADR-047); `height`
    multiplies a text's height (a scale, ADR-050)."""
    if (insert := rows.inserts.get(handle)) is not None:
        rows.inserts[handle] = dataclasses.replace(insert, position=move(insert.position))
    elif (text := rows.texts.get(handle)) is not None:
        rows.put_text(
            dataclasses.replace(text, position=move(text.position), height=text.height * height)
        )
    elif (curve := rows.curves.get(handle)) is not None:
        rows.curves[handle] = dataclasses.replace(
            curve, points=tuple(move(p) for p in curve.points)
        )
    else:
        raise CorrectionInvalidError(f"{where}: no item with handle {handle} in the drawing")


def _mirror(c: MirrorItem) -> Callable[[Xy], Xy]:
    dx, dy = c.x2 - c.x1, c.y2 - c.y1
    length_sq = dx * dx + dy * dy

    def reflect(p: Xy) -> Xy:
        t = ((p[0] - c.x1) * dx + (p[1] - c.y1) * dy) / length_sq
        fx, fy = c.x1 + t * dx, c.y1 + t * dy
        return (2 * fx - p[0], 2 * fy - p[1])

    return reflect


def _erase(rows: _Rows, handle: str, where: str) -> None:
    if handle in rows.inserts:
        del rows.inserts[handle]
    elif (text := rows.texts.get(handle)) is not None:
        rows.count_height(text, -1)
        del rows.texts[handle]
    elif handle in rows.curves:
        del rows.curves[handle]
    else:
        raise CorrectionInvalidError(f"{where}: no item with handle {handle} in the drawing")


def _copy(rows: _Rows, c: CopyItem, fix: str, where: str) -> None:
    _check_free(rows, fix, where)

    def shift(p: Xy) -> Xy:
        return (p[0] + c.dx, p[1] + c.dy)

    if (insert := rows.inserts.get(c.handle)) is not None:
        rows.inserts[fix] = dataclasses.replace(
            insert,
            handle=fix,
            position=shift(insert.position),
            layer=c.to_layer or insert.layer,
        )
    elif (text := rows.texts.get(c.handle)) is not None:
        rows.put_text(
            dataclasses.replace(
                text, handle=fix, position=shift(text.position), layer=c.to_layer or text.layer
            )
        )
    elif (curve := rows.curves.get(c.handle)) is not None:
        rows.curves[fix] = dataclasses.replace(
            curve,
            handle=fix,
            points=tuple(shift(p) for p in curve.points),
            layer=c.to_layer or curve.layer,
        )
    else:
        raise CorrectionInvalidError(f"{where}: no item with handle {c.handle} in the drawing")


def _set_attribute(rows: _Rows, c: SetAttribute, where: str) -> None:
    insert = rows.inserts.get(c.handle)
    if insert is None:
        raise CorrectionInvalidError(f"{where}: no block with handle {c.handle} in the drawing")
    for i, attribute in enumerate(insert.attributes):
        if c.from_value in (attribute.value, attribute.raw_value):
            changed = dataclasses.replace(
                attribute, value=c.to_value, raw_value=c.to_value, readable=True
            )
            attributes = (*insert.attributes[:i], changed, *insert.attributes[i + 1 :])
            rows.inserts[c.handle] = dataclasses.replace(insert, attributes=attributes)
            return
    raise CorrectionInvalidError(
        f"{where}: block {c.handle} has no attribute with the value {c.from_value!r}"
    )


def _relayer(rows: _Rows, source: str, target: str) -> None:
    for handle, insert in list(rows.inserts.items()):
        if insert.layer == source:
            rows.inserts[handle] = dataclasses.replace(insert, layer=target)
    for text in [t for t in rows.texts.values() if t.layer == source]:
        rows.put_text(dataclasses.replace(text, layer=target))
    for handle, curve in list(rows.curves.items()):
        if curve.layer == source:
            rows.curves[handle] = dataclasses.replace(curve, layer=target)


def _check_free(rows: _Rows, handle: str, where: str) -> None:
    if rows.taken(handle):
        raise CorrectionInvalidError(f"{where}: handle {handle} already exists")


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
