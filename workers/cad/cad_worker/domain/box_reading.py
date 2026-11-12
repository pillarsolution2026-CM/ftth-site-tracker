"""The shape and type of every box of a roles-mode Secondary at build (ADR-043). Pure.

- INSERT boxes: the signature read at import (`cad_inserts.shape_signature`, None for files
  processed before migration 0023 → `boxesWithoutShape`), the preview from `cad_file_shapes`;
- a box added on the program page (`add_item`, block FIX_BLOCK): `none`, no preview;
- a group of closed shapes (ADR-033): its curves as drawn (no rotation is known, none removed);
- a `text` rule box: its trimmed upper-cased text.

Each box gets `attrs.reading.shape` and `attrs.reading.boxType` (the frozen choice of its shape or
null), and the revision gets its gallery (`design_revisions.box_shapes`).
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from cad_worker.domain.box_shapes import (
    BOX_SHAPE_NONE,
    BoxShapeOf,
    BoxTypeOnBox,
    ShapeGeometry,
    ShapeTooLargeError,
    build_gallery,
    shape_preview,
    shape_signature,
    text_preview,
    text_signature,
)
from cad_worker.domain.design import DesignFeatureDraft
from cad_worker.domain.design_build import FIX_BLOCK, DrawingData, SourceCurve
from cad_worker.domain.role_reading import READING_ATTR_KEY


@dataclass(frozen=True, slots=True)
class BoxShapesRead:
    features: list[DesignFeatureDraft]
    gallery: dict[str, object]


def _shape_of(
    f: DesignFeatureDraft,
    inserts: Mapping[str, tuple[str, str | None]],
    curves: Mapping[str, SourceCurve],
    previews: Mapping[str, Mapping[str, object]],
) -> BoxShapeOf:
    if f.source_kind == "insert":
        block, sig = inserts.get(f.source_handle, (f.block_name or "", None))
        if block == FIX_BLOCK:
            return BoxShapeOf(f.source_handle, "none", BOX_SHAPE_NONE)
        preview = previews.get(sig) if sig is not None else None
        return BoxShapeOf(f.source_handle, "block", sig, block, preview)
    if f.source_kind == "text":
        text = str(f.attrs.get("text", ""))
        return BoxShapeOf(f.source_handle, "text", text_signature(text), None, text_preview(text))
    raw = f.attrs.get("shapes")
    handles = [str(h) for h in raw] if isinstance(raw, list) else [f.source_handle]
    found = [curves[h] for h in sorted(handles) if h in curves]
    if len(found) != len(handles):
        return BoxShapeOf(f.source_handle, "shapes", None)
    geometry = ShapeGeometry(paths=tuple(c.points for c in found))
    try:
        sig = shape_signature(geometry, "shapes")
    except ShapeTooLargeError:
        return BoxShapeOf(f.source_handle, "shapes", None)
    return BoxShapeOf(f.source_handle, "shapes", sig, None, shape_preview(geometry))


def read_box_shapes(
    features: Sequence[DesignFeatureDraft],
    drawing: DrawingData,
    previews: Mapping[str, Mapping[str, object]],
    frozen: Mapping[str, BoxTypeOnBox],
) -> BoxShapesRead:
    """Boxes get `reading.shape` / `reading.boxType`; other features are returned unchanged."""
    inserts = {i.handle: (i.block_name, i.shape) for i in drawing.inserts}
    curves = {c.handle: c for c in drawing.curves}
    out: list[DesignFeatureDraft] = []
    boxes: list[BoxShapeOf] = []
    for f in features:
        if f.feature_type != "box":
            out.append(f)
            continue
        of = _shape_of(f, inserts, curves, previews)
        boxes.append(of)
        chosen = frozen.get(of.shape) if of.shape is not None else None
        reading = f.attrs.get(READING_ATTR_KEY)
        base = dict(reading) if isinstance(reading, Mapping) else {"of": "box"}
        base["shape"] = of.shape
        base["boxType"] = chosen.to_json() if chosen is not None else None
        out.append(dataclasses.replace(f, attrs={**f.attrs, READING_ATTR_KEY: base}))
    return BoxShapesRead(out, build_gallery(boxes))
