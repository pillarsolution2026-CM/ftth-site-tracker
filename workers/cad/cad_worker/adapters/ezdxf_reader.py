"""DrawingReader backed by `ezdxf.recover` (tolerant reader). Model space only."""

from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ezdxf import recover
from ezdxf.math import Vec3
from ezdxf.tools.text import plain_mtext

from cad_worker.adapters.ezdxf_curves import CURVE_TYPES, curve_from_entity, to_wcs
from cad_worker.application.ports import DrawingSource, ImportFailure
from cad_worker.domain.flatten import FLATTEN_TOLERANCE
from cad_worker.domain.model import (
    Attribute,
    DrawingMeta,
    Feature,
    InsertRow,
    LayerDef,
    SkippedEntity,
    SkipReason,
    TextRow,
    Xyz,
)
from cad_worker.domain.text_decoder import TextDecoder

_PROXY_TYPES = frozenset({"ACAD_PROXY_ENTITY", "PROXY_ENTITY"})
_XREF_FLAG = 4
_ALIGNED_OR_FIT = (3, 5)


def _clean(text: str) -> str:
    """PostgreSQL text cannot hold NUL, and lone surrogates cannot be encoded."""
    return text.replace("\x00", "").encode("utf-8", "replace").decode("utf-8")


def _aci(entity: Any) -> int:
    return max(0, min(256, int(entity.dxf.get("color", 256))))


def _point(entity: Any, value: Any) -> Xyz:
    v = Vec3(value)
    point = to_wcs(entity, [(float(v.x), float(v.y), float(v.z))])[0]
    if not all(math.isfinite(c) for c in point):
        raise ValueError("non-finite coordinate")  # becomes a SkippedEntity(error)
    return point


class EzdxfSource:
    def __init__(self, doc: Any, meta: DrawingMeta, decoder: TextDecoder, tolerance: float) -> None:
        self._doc = doc
        self.meta = meta
        self._decoder = decoder
        self._tolerance = tolerance
        self._fonts = {s.dxf.name.lower(): str(s.dxf.get("font", "")) or None for s in doc.styles}

    def features(self) -> Iterator[Feature]:
        for entity in self._doc.modelspace():
            kind = entity.dxftype()
            try:
                feature = self._convert(entity, kind)
            except Exception:  # one bad entity must not fail the drawing
                feature = SkippedEntity(
                    str(entity.dxf.get("layer", "0")),
                    kind,
                    "error",
                    str(entity.dxf.get("handle", "")),
                )
            yield feature

    def _convert(self, entity: Any, kind: str) -> Feature:
        if kind in CURVE_TYPES:
            return curve_from_entity(entity, self._tolerance)
        if kind == "INSERT":
            return self._insert(entity)
        if kind in ("TEXT", "MTEXT"):
            return self._text(entity, kind)
        reason: SkipReason = "proxy" if kind in _PROXY_TYPES else "unsupported"
        return SkippedEntity(str(entity.dxf.layer), kind, reason, str(entity.dxf.handle))

    def _font(self, style: str | None) -> str | None:
        return self._fonts.get((style or "").lower())

    def _insert(self, e: Any) -> InsertRow:
        attributes = tuple(self._attribute(a) for a in e.attribs)
        return InsertRow(
            handle=str(e.dxf.handle),
            layer=_clean(str(e.dxf.layer)),
            block_name=_clean(str(e.dxf.name)),
            position=_point(e, e.dxf.insert),
            rotation=float(e.dxf.get("rotation", 0.0)),
            scale=(
                float(e.dxf.get("xscale", 1.0)),
                float(e.dxf.get("yscale", 1.0)),
                float(e.dxf.get("zscale", 1.0)),
            ),
            aci_color=_aci(e),
            attributes=attributes,
        )

    def _attribute(self, a: Any) -> Attribute:
        raw = _clean(str(a.dxf.get("text", "")))
        decoded = self._decoder.decode(raw, self._font(a.dxf.get("style")))
        return Attribute(
            tag=_clean(str(a.dxf.get("tag", ""))),
            raw_value=raw,
            value=_clean(decoded.text) if decoded.text is not None else raw,
            readable=decoded.readable,
        )

    def _text(self, e: Any, kind: str) -> TextRow:
        style = str(e.dxf.get("style", "")) or None
        font = self._font(style)
        if kind == "MTEXT":
            raw = _clean(str(e.text))
            plain = _clean(str(plain_mtext(raw, split=False)))
            anchor, height, rotation = e.dxf.insert, e.dxf.get("char_height", 0.0), e.get_rotation()
        else:
            raw = plain = _clean(str(e.dxf.get("text", "")))
            anchor, height, rotation = (
                _text_anchor(e),
                e.dxf.get("height", 0.0),
                e.dxf.get("rotation", 0.0),
            )
        decoded = self._decoder.decode(plain, font)
        return TextRow(
            handle=str(e.dxf.handle),
            kind="mtext" if kind == "MTEXT" else "text",
            layer=_clean(str(e.dxf.layer)),
            position=_point(e, anchor),
            height=float(height),
            rotation=float(rotation),
            raw_text=raw,
            text=_clean(decoded.text) if decoded.text is not None else raw,
            readable=decoded.readable,
            style=_clean(style) if style else None,
            font=_clean(font) if font else None,
            aci_color=_aci(e),
        )


def _text_anchor(e: Any) -> Any:
    """Alignment point for aligned TEXT, otherwise the insertion point."""
    aligned = e.dxf.get("halign", 0) or e.dxf.get("valign", 0)
    if aligned and e.dxf.get("halign", 0) not in _ALIGNED_OR_FIT and e.dxf.hasattr("align_point"):
        return e.dxf.align_point
    return e.dxf.insert


def _is_xref(block_layout: Any) -> bool:
    block = block_layout.block
    return block is not None and bool(int(block.dxf.get("flags", 0)) & _XREF_FLAG)


def _layer_defs(doc: Any) -> tuple[LayerDef, ...]:
    out: list[LayerDef] = []
    for layer in doc.layers:
        aci = abs(int(layer.dxf.get("color", 7))) or 7
        out.append(
            LayerDef(
                name=_clean(str(layer.dxf.name)),
                aci_color=min(aci, 255),
                true_color=layer.dxf.get("true_color"),
                linetype=_clean(str(layer.dxf.linetype)) if layer.dxf.hasattr("linetype") else None,
                is_on=bool(layer.is_on()),
                is_frozen=bool(layer.is_frozen()),
                is_locked=bool(layer.is_locked()),
            )
        )
    return tuple(out)


class EzdxfReader:
    def __init__(
        self, decoder: TextDecoder | None = None, tolerance: float = FLATTEN_TOLERANCE
    ) -> None:
        self._decoder = decoder or TextDecoder()
        self._tolerance = tolerance

    def open(self, path: Path) -> DrawingSource:
        try:
            doc, auditor = recover.readfile(str(path))
        except Exception as exc:
            raise ImportFailure("DXF_UNREADABLE", f"{type(exc).__name__}: {exc}") from exc
        ins_units = doc.header.get("$INSUNITS")
        xrefs = tuple(_clean(str(b.name)) for b in doc.blocks if _is_xref(b))
        meta = DrawingMeta(
            dxf_version=str(doc.dxfversion) if doc.dxfversion else None,
            ins_units=int(ins_units) if ins_units is not None else None,
            layers=_layer_defs(doc),
            recover_fixes=len(auditor.fixes),
            recover_errors=len(auditor.errors),
            xref_blocks=xrefs,
        )
        return EzdxfSource(doc, meta, self._decoder, self._tolerance)
