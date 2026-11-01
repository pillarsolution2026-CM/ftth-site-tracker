"""As-Built DXF drawing model (Phase 4, ADR-030). Pure: no I/O, no ezdxf.

Inputs are the design features of one revision and the approved As-Built state of the project, all
in the revision CRS (metres). The output is a flat list of layers, symbol blocks and entities that
an adapter writes with ezdxf:

- design features on their original layer (routes as polylines, points as a symbol INSERT, the
  design code as TEXT);
- approved As-Built geometry of a design feature on `ASBUILT_EDITS` (the design entity stays on its
  layer underneath), a label-only change as TEXT on `ASBUILT_EDITS`, and a status text
  `AS-BUILT G<geometryVersion> L<labelVersion>`;
- approved added features on `ASBUILT_ADDED` with their label and the status text `AS-BUILT ADDED`.

Security: every layer name read from the database is checked (control characters, reserved names,
the characters AutoCAD refuses, plus the injected ezdxf validator) and replaced by
`INVALID_LAYER_<n>` when it fails; every text is stripped of control characters and `%%` control
codes are neutralised. Only single-line TEXT is produced (never MTEXT).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from uuid import UUID

from cad_worker.domain.design import FeatureType, Xy

# Layer names of the export (packages/shared ASBUILT_DXF_LAYERS).
LAYER_EDITS = "ASBUILT_EDITS"
LAYER_ADDED = "ASBUILT_ADDED"
# Distinct ACI colours for the two As-Built layers (presentation only).
COLOR_EDITS = 1  # red
COLOR_ADDED = 3  # green
DESIGN_LAYER_COLOR = 7  # white/black: design layers keep a neutral colour

# Presentation parameters in metres (not business rules; tuned for 1:500-1:1000 sheets).
TEXT_HEIGHT_M = 0.5
SYMBOL_SIZE_M = 1.0

# One symbol block per point feature type (defined once, inserted per feature).
SYMBOL_BLOCKS: dict[FeatureType, str] = {
    "box": "FTTH_BOX",
    "hhi": "FTTH_HHI",
    "joint": "FTTH_JOINT",
    "mh": "FTTH_MH",
}

STATUS_ADDED = "AS-BUILT ADDED"
INVALID_LAYER_PREFIX = "INVALID_LAYER_"
MAX_LAYER_NAME = 255
MAX_TEXT = 250  # DXF group code 1 values of TEXT stay below 256 characters
# |x|, |y| in project-CRS metres (packages/shared ASBUILT_LIMITS.maxAbsCoordinate).
MAX_ABS_COORDINATE = 100_000_000.0

# Characters AutoCAD refuses in symbol table names (superset of ezdxf's list: adds `|` and `,`).
_FORBIDDEN_LAYER_CHARS = frozenset('<>/\\":;?*|,=`')
# C0, DEL, C1, and the Unicode line/paragraph separators.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")
_RESERVED_LAYERS = frozenset(n.casefold() for n in (LAYER_EDITS, LAYER_ADDED))


@dataclass(frozen=True, slots=True)
class DesignFeatureIn:
    feature_id: UUID
    feature_type: FeatureType
    layer: str
    code: str | None
    coords: tuple[Xy, ...]  # routes: the polyline; points: one position


@dataclass(frozen=True, slots=True)
class AsBuiltFeatureIn:
    """One `asbuilt_features` row (approved state). `coords` is None for a label-only change."""

    feature_id: UUID
    feature_type: FeatureType
    added: bool
    coords: tuple[Xy, ...] | None
    label: str | None
    geometry_version: int
    label_version: int


@dataclass(frozen=True, slots=True)
class LayerSpec:
    name: str
    color: int


@dataclass(frozen=True, slots=True)
class PolylineEntity:
    layer: str
    points: tuple[Xy, ...]


@dataclass(frozen=True, slots=True)
class SymbolEntity:
    layer: str
    block: str
    position: Xy


@dataclass(frozen=True, slots=True)
class TextEntity:
    layer: str
    text: str  # already sanitised
    position: Xy
    height: float = TEXT_HEIGHT_M


Entity = PolylineEntity | SymbolEntity | TextEntity


@dataclass(frozen=True, slots=True)
class ExportStats:
    """`AsBuiltExportSchema.stats` (packages/shared)."""

    design_features: int
    edited_features: int
    added_features: int

    def to_json(self) -> dict[str, int]:
        return {
            "designFeatures": self.design_features,
            "editedFeatures": self.edited_features,
            "addedFeatures": self.added_features,
        }


@dataclass(frozen=True, slots=True)
class AsBuiltDrawing:
    layers: tuple[LayerSpec, ...]
    blocks: tuple[str, ...]  # symbol blocks used (names from SYMBOL_BLOCKS)
    entities: tuple[Entity, ...]
    stats: ExportStats
    warnings: tuple[dict[str, object], ...] = field(default=())


class DrawingDataError(ValueError):
    """The data cannot be drawn (e.g. a non-finite coordinate). The export is failed."""


def sanitize_text(value: str) -> str:
    """Single-line, inert TEXT content.

    Control characters (C0, DEL, C1, U+2028/2029) become one space, so a label such as
    `"A\\n0\\nLINE"` cannot start a new DXF tag; `%%` is escaped as `%%%` (AutoCAD's literal
    percent) so `%%u`, `%%c`, `%%nnn` … are shown as typed instead of switching formatting.
    """
    flat = _CONTROL.sub(" ", value).strip()
    # Cut before escaping, so an escape sequence is never split.
    while len(_escape_percent(flat)) > MAX_TEXT:
        flat = flat[:-1].rstrip()
    return _escape_percent(flat)


def _escape_percent(value: str) -> str:
    return value.replace("%%", "%%%%%%")


def layer_name_problem(name: str, validator: Callable[[str], bool]) -> str | None:
    """Why a database layer name cannot be written as is, or None when it can."""
    if not name or name != name.strip():
        return "empty or padded"
    if len(name) > MAX_LAYER_NAME:
        return "too long"
    if _CONTROL.search(name):
        return "control character"
    if _FORBIDDEN_LAYER_CHARS.intersection(name):
        return "forbidden character"
    if name.casefold() in _RESERVED_LAYERS:
        return "reserved As-Built layer"
    if not validator(name):
        return "rejected by ezdxf"
    return None


class _LayerNames:
    """Maps database layer names to safe DXF names (same input -> same output)."""

    def __init__(self, validator: Callable[[str], bool]) -> None:
        self._validator = validator
        self._map: dict[str, str] = {}
        self._order: list[str] = []
        self._seen: set[str] = set()
        self.invalid = 0

    def get(self, name: str) -> str:
        found = self._map.get(name)
        if found is not None:
            return found
        if layer_name_problem(name, self._validator) is None:
            safe = name
        else:
            self.invalid += 1
            safe = f"{INVALID_LAYER_PREFIX}{self.invalid}"
        self._map[name] = safe
        if safe.casefold() not in self._seen:  # DXF layer names are case-insensitive
            self._seen.add(safe.casefold())
            self._order.append(safe)
        return safe

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._order)


def anchor(feature_type: FeatureType, coords: Sequence[Xy]) -> Xy:
    """Where texts of a feature go: the point itself, or the middle of a route by length."""
    if feature_type != "route" or len(coords) == 1:
        return coords[0]
    lengths = [math.dist(a, b) for a, b in pairwise(coords)]
    half = sum(lengths) / 2.0
    for (a, b), seg in zip(pairwise(coords), lengths, strict=True):
        if seg >= half and seg > 0:
            t = half / seg
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        half -= seg
    return coords[-1]


def _offset(p: Xy, dx: float, dy: float) -> Xy:
    return (p[0] + dx, p[1] + dy)


# Text positions relative to the anchor (in text heights).
def _code_at(p: Xy) -> Xy:
    return _offset(p, TEXT_HEIGHT_M, TEXT_HEIGHT_M)


def _label_at(p: Xy) -> Xy:
    return _offset(p, TEXT_HEIGHT_M, 2.5 * TEXT_HEIGHT_M)


def _status_at(p: Xy) -> Xy:
    return _offset(p, TEXT_HEIGHT_M, -2.0 * TEXT_HEIGHT_M)


def _check_coords(feature_type: FeatureType, coords: Sequence[Xy], what: str) -> None:
    if feature_type == "route":
        if len(coords) < 2:
            raise DrawingDataError(f"{what}: a route needs at least two vertices")
    elif len(coords) != 1:
        raise DrawingDataError(f"{what}: a point feature needs exactly one position")
    if not all(math.isfinite(v) and abs(v) <= MAX_ABS_COORDINATE for xy in coords for v in xy):
        raise DrawingDataError(f"{what}: coordinate not finite or out of range")


def _shape(layer: str, feature_type: FeatureType, coords: tuple[Xy, ...]) -> Entity:
    if feature_type == "route":
        return PolylineEntity(layer, coords)
    return SymbolEntity(layer, SYMBOL_BLOCKS[feature_type], coords[0])


def _text(layer: str, value: str | None, position: Xy) -> list[TextEntity]:
    if value is None:
        return []
    clean = sanitize_text(value)
    return [TextEntity(layer, clean, position)] if clean else []


def status_text(state: AsBuiltFeatureIn) -> str:
    if state.added:
        return STATUS_ADDED
    return f"AS-BUILT G{state.geometry_version} L{state.label_version}"


def build_drawing(
    design: Iterable[DesignFeatureIn],
    asbuilt: Iterable[AsBuiltFeatureIn],
    layer_validator: Callable[[str], bool],
) -> AsBuiltDrawing:
    """The full drawing model. Raises DrawingDataError on unusable geometry.

    An approved state of a design feature that is not in the exported revision has no design
    position; it is left out and counted in the warning `ASBUILT_FEATURE_NOT_IN_REVISION`
    (the length read model leaves such features out too).
    """
    names = _LayerNames(layer_validator)
    entities: list[Entity] = []
    blocks: set[str] = set()
    design_by_id: dict[UUID, DesignFeatureIn] = {}

    for f in sorted(design, key=lambda d: str(d.feature_id)):
        _check_coords(f.feature_type, f.coords, f"design feature {f.feature_id}")
        layer = names.get(f.layer)
        design_by_id[f.feature_id] = f
        entities.append(_shape(layer, f.feature_type, f.coords))
        entities.extend(_text(layer, f.code, _code_at(anchor(f.feature_type, f.coords))))

    edited = added = not_in_revision = 0
    for s in sorted(asbuilt, key=lambda a: str(a.feature_id)):
        if s.coords is None and s.label is None:
            continue
        if s.added:
            if s.coords is None:
                raise DrawingDataError(f"added feature {s.feature_id} has no geometry")
            _check_coords(s.feature_type, s.coords, f"added feature {s.feature_id}")
            at = anchor(s.feature_type, s.coords)
            entities.append(_shape(LAYER_ADDED, s.feature_type, s.coords))
            entities.extend(_text(LAYER_ADDED, s.label, _label_at(at)))
            entities.append(TextEntity(LAYER_ADDED, status_text(s), _status_at(at)))
            added += 1
            continue
        base = design_by_id.get(s.feature_id)
        if base is None:
            not_in_revision += 1
            continue
        if s.coords is not None:
            _check_coords(s.feature_type, s.coords, f"As-Built feature {s.feature_id}")
            entities.append(_shape(LAYER_EDITS, s.feature_type, s.coords))
            at = anchor(s.feature_type, s.coords)
        else:
            at = anchor(base.feature_type, base.coords)
        entities.extend(_text(LAYER_EDITS, s.label, _label_at(at)))
        entities.append(TextEntity(LAYER_EDITS, status_text(s), _status_at(at)))
        edited += 1

    for e in entities:
        if isinstance(e, SymbolEntity):
            blocks.add(e.block)

    layers = [LayerSpec(n, DESIGN_LAYER_COLOR) for n in names.names]
    layers += [LayerSpec(LAYER_EDITS, COLOR_EDITS), LayerSpec(LAYER_ADDED, COLOR_ADDED)]
    warnings: list[dict[str, object]] = []
    if names.invalid:
        warnings.append({"code": "INVALID_LAYER_NAME", "count": names.invalid})
    if not_in_revision:
        warnings.append({"code": "ASBUILT_FEATURE_NOT_IN_REVISION", "count": not_in_revision})
    return AsBuiltDrawing(
        layers=tuple(layers),
        blocks=tuple(sorted(blocks)),
        entities=tuple(entities),
        stats=ExportStats(len(design_by_id), edited, added),
        warnings=tuple(warnings),
    )
