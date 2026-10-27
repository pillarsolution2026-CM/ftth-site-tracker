"""Extraction value objects. Coordinates are drawing units (SRID 0); no I/O, no ezdxf."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Xyz = tuple[float, float, float]

CurveType = Literal["LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "SPLINE"]
SkipReason = Literal["unsupported", "degenerate", "proxy", "error"]
WarningCode = Literal[
    "DWG_CONVERTED",
    "DXF_RECOVERED",
    "UNSUPPORTED_ENTITY",
    "PROXY_ENTITY",
    "XREF_NOT_RESOLVED",
    "MISSING_FONT",
    "UNREADABLE_TEXT",
    "UNITS_UNSPECIFIED",
    "EMPTY_MODELSPACE",
    "CURVE_APPROXIMATED",
]


@dataclass(frozen=True, slots=True)
class LayerDef:
    name: str
    aci_color: int
    true_color: int | None
    linetype: str | None
    is_on: bool
    is_frozen: bool
    is_locked: bool


@dataclass(frozen=True, slots=True)
class Attribute:
    tag: str
    raw_value: str
    value: str
    readable: bool


@dataclass(frozen=True, slots=True)
class InsertRow:
    handle: str
    layer: str
    block_name: str
    position: Xyz
    rotation: float
    scale: Xyz
    aci_color: int
    attributes: tuple[Attribute, ...] = ()


@dataclass(frozen=True, slots=True)
class TextRow:
    handle: str
    kind: Literal["text", "mtext"]
    layer: str
    position: Xyz
    height: float
    rotation: float
    raw_text: str
    text: str
    readable: bool
    style: str | None
    font: str | None
    aci_color: int


@dataclass(frozen=True, slots=True)
class CurveRow:
    handle: str
    entity_type: CurveType
    layer: str
    points: tuple[Xyz, ...]
    is_closed: bool
    flatten_tolerance: float | None
    aci_color: int


@dataclass(frozen=True, slots=True)
class SkippedEntity:
    """A model-space entity that produced no row; it still counts in the layer statistics."""

    layer: str
    dxf_type: str
    reason: SkipReason
    handle: str = ""


Feature = InsertRow | TextRow | CurveRow | SkippedEntity


@dataclass(frozen=True, slots=True)
class DrawingMeta:
    dxf_version: str | None
    ins_units: int | None
    layers: tuple[LayerDef, ...]
    recover_fixes: int = 0
    recover_errors: int = 0
    xref_blocks: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class LayerRow:
    definition: LayerDef
    entity_counts: dict[str, int] = field(default_factory=dict)

    @property
    def entity_total(self) -> int:
        return sum(self.entity_counts.values())


@dataclass(frozen=True, slots=True)
class CadWarning:
    code: WarningCode
    count: int = 1
    params: dict[str, str | int | float] | None = None

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {"code": self.code, "count": self.count}
        if self.params:
            out["params"] = self.params
        return out
