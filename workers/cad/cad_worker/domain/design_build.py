"""Mapping rules -> design features (ADR-017 rule semantics). Pure.

Mirror of `MappingRuleSchema` (`packages/shared/src/cad/cad-mapping.schemas.ts`):
- `layer` -> `route`: every curve on the layer is one route feature (zero-length ones skipped);
- `layer` -> point type: every INSERT on the layer is one feature, unless a `block` rule matches;
- `layer` -> feature type or `label`: its texts are link candidates;
- `block` (any layer) -> point type | `background` | `ignore`; wins over the layer rule;
- `text` (exact text, trimmed, case-insensitive, on one layer) -> point type: one feature at the
  text's insertion point; such texts are not linked.
Layers without a rule are ignored.

Every coordinate is multiplied by the revision's `metres_per_unit` (ADR-018): no unit is assumed.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, cast

from cad_worker.domain.design import (
    FEATURE_TYPES,
    POINT_FEATURE_TYPES,
    DesignFeatureDraft,
    FeatureType,
    Xy,
    polyline_length,
)

Target = Literal["route", "box", "hhi", "joint", "mh", "label", "background", "ignore"]
MAPPING_TARGETS: frozenset[str] = frozenset({*FEATURE_TYPES, "label", "background", "ignore"})
BLOCK_TARGETS: frozenset[str] = frozenset({*POINT_FEATURE_TYPES, "background", "ignore"})
MAX_NAME_LENGTH = 255
MAX_RULES = 2000


class MappingInvalidError(ValueError):
    """The frozen rules do not satisfy `MappingRuleSchema` (revision fails `MAPPING_INVALID`)."""


@dataclass(frozen=True, slots=True)
class MappingRules:
    layers: Mapping[str, Target]
    blocks: Mapping[str, Target]
    # (layer, trimmed lower-case text) -> point type
    texts: Mapping[tuple[str, str], FeatureType]

    def layers_with(self, *targets: str) -> frozenset[str]:
        return frozenset(name for name, target in self.layers.items() if target in targets)

    def insert_target(self, layer: str, block_name: str) -> Target | None:
        """The block rule wins over the layer rule; None = no rule (ignored)."""
        if block_name in self.blocks:
            return self.blocks[block_name]
        return self.layers.get(layer)

    def text_rule(self, layer: str, text: str) -> FeatureType | None:
        return self.texts.get((layer, text_rule_key(text)))


def text_rule_key(text: str) -> str:
    return text.strip().lower()


def _name(rule: Mapping[str, object], key: str) -> str:
    value = rule.get(key)
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_NAME_LENGTH:
        raise MappingInvalidError(f"rule {dict(rule)!r}: `{key}` must be a 1-255 character string")
    return value


def parse_rules(raw: object) -> MappingRules:
    """Validate the revision's frozen `rules` JSON. Duplicates are invalid, as in the API."""
    if not isinstance(raw, list) or len(raw) > MAX_RULES:
        raise MappingInvalidError("rules must be an array of at most 2000 rules")
    layers: dict[str, Target] = {}
    blocks: dict[str, Target] = {}
    texts: dict[tuple[str, str], FeatureType] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise MappingInvalidError(f"rule {item!r} is not an object")
        rule = cast(Mapping[str, object], item)
        source, target = rule.get("source"), rule.get("target")
        if source == "layer" and target in MAPPING_TARGETS:
            _put(layers, _name(rule, "layer"), cast(Target, target), rule)
        elif source == "block" and target in BLOCK_TARGETS:
            _put(blocks, _name(rule, "block"), cast(Target, target), rule)
        elif source == "text" and target in POINT_FEATURE_TYPES:
            text = _name(rule, "text").strip()
            if not text:
                raise MappingInvalidError(f"rule {dict(rule)!r}: empty text")
            key = (_name(rule, "layer"), text_rule_key(text))
            _put(texts, key, cast(FeatureType, target), rule)
        else:
            raise MappingInvalidError(f"rule {dict(rule)!r}: unknown source or target")
    return MappingRules(layers, blocks, texts)


def _put[K, V](table: dict[K, V], key: K, value: V, rule: Mapping[str, object]) -> None:
    if key in table:
        raise MappingInvalidError(f"duplicate rule {dict(rule)!r}")
    table[key] = value


# ---------- drawing rows (drawing units, SRID 0) ----------


@dataclass(frozen=True, slots=True)
class SourceCurve:
    handle: str
    layer: str
    points: tuple[Xy, ...]


@dataclass(frozen=True, slots=True)
class SourceAttribute:
    tag: str
    raw_value: str
    value: str
    readable: bool


@dataclass(frozen=True, slots=True)
class SourceInsert:
    handle: str
    layer: str
    block_name: str
    position: Xy
    attributes: tuple[SourceAttribute, ...] = ()


@dataclass(frozen=True, slots=True)
class SourceText:
    handle: str
    layer: str
    position: Xy
    height: float
    raw_text: str
    # Decoded text; for unreadable texts `cad_texts.text` holds the raw text, which is ignored.
    text: str
    readable: bool


@dataclass(frozen=True, slots=True)
class DrawingData:
    curves: tuple[SourceCurve, ...]
    inserts: tuple[SourceInsert, ...]
    texts: tuple[SourceText, ...]


# ---------- build output ----------


@dataclass(frozen=True, slots=True)
class LinkText:
    """A text that may be linked to a feature, already scaled to metres."""

    handle: str
    layer: str
    position: Xy
    height_m: float
    raw_text: str
    text: str | None  # None when unreadable: never guessed
    readable: bool


@dataclass(frozen=True, slots=True)
class BackgroundSelection:
    """What goes into the `background` tile layer (rendered in PostGIS from the raw rows)."""

    curve_layers: frozenset[str]
    insert_handles: frozenset[str]


@dataclass(frozen=True, slots=True)
class BuiltFeatures:
    features: tuple[DesignFeatureDraft, ...]
    link_texts: tuple[LinkText, ...]
    background: BackgroundSelection
    zero_length_routes: int


def scale_point(point: Xy, factor: float) -> Xy:
    return (point[0] * factor, point[1] * factor)


def build_features(
    drawing: DrawingData, rules: MappingRules, metres_per_unit: Decimal
) -> BuiltFeatures:
    factor = float(metres_per_unit)  # exact decimal kept on the revision; float for geometry only
    routes, zero_length = _routes(drawing.curves, rules, factor)
    points, background_inserts = _insert_features(drawing.inserts, rules, factor)
    text_features, consumed = _text_features(drawing.texts, rules, factor)
    candidate_layers = rules.layers_with(*FEATURE_TYPES, "label")
    link_texts = tuple(
        _link_text(t, factor)
        for t in drawing.texts
        if t.layer in candidate_layers and t.handle not in consumed
    )
    return BuiltFeatures(
        features=(*routes, *points, *text_features),
        link_texts=link_texts,
        background=BackgroundSelection(rules.layers_with("background"), background_inserts),
        zero_length_routes=zero_length,
    )


def _routes(
    curves: Iterable[SourceCurve], rules: MappingRules, factor: float
) -> tuple[list[DesignFeatureDraft], int]:
    route_layers = rules.layers_with("route")
    out: list[DesignFeatureDraft] = []
    skipped = 0
    for curve in curves:
        if curve.layer not in route_layers:
            continue
        coords = tuple(scale_point(p, factor) for p in curve.points)
        if len(coords) < 2 or polyline_length(coords) <= 0:
            skipped += 1  # a LineString of zero length is not a route
            continue
        out.append(
            DesignFeatureDraft("route", curve.layer, None, "curve", curve.handle, coords, {})
        )
    return out, skipped


def _insert_features(
    inserts: Iterable[SourceInsert], rules: MappingRules, factor: float
) -> tuple[list[DesignFeatureDraft], frozenset[str]]:
    out: list[DesignFeatureDraft] = []
    background: set[str] = set()
    for insert in inserts:
        target = rules.insert_target(insert.layer, insert.block_name)
        if target == "background":
            background.add(insert.handle)
        if target not in POINT_FEATURE_TYPES:
            continue
        out.append(
            DesignFeatureDraft(
                cast(FeatureType, target),
                insert.layer,
                insert.block_name,
                "insert",
                insert.handle,
                (scale_point(insert.position, factor),),
                {"attributes": _attributes(insert.attributes)} if insert.attributes else {},
            )
        )
    return out, frozenset(background)


def _attributes(attributes: Sequence[SourceAttribute]) -> list[dict[str, object]]:
    """Decoded attribute values; an unreadable value is kept raw and never guessed."""
    return [
        {
            "tag": a.tag,
            "value": a.value if a.readable else None,
            "rawValue": a.raw_value,
            "readable": a.readable,
        }
        for a in attributes
    ]


def _text_features(
    texts: Iterable[SourceText], rules: MappingRules, factor: float
) -> tuple[list[DesignFeatureDraft], frozenset[str]]:
    out: list[DesignFeatureDraft] = []
    consumed: set[str] = set()
    for text in texts:
        if not text.readable:
            continue
        target = rules.text_rule(text.layer, text.text)
        if target is None:
            continue
        consumed.add(text.handle)
        out.append(
            DesignFeatureDraft(
                target,
                text.layer,
                None,
                "text",
                text.handle,
                (scale_point(text.position, factor),),
                {"text": text.text.strip()},
            )
        )
    return out, frozenset(consumed)


def _link_text(text: SourceText, factor: float) -> LinkText:
    return LinkText(
        handle=text.handle,
        layer=text.layer,
        position=scale_point(text.position, factor),
        height_m=abs(text.height) * factor,
        raw_text=text.raw_text,
        text=text.text if text.readable else None,
        readable=text.readable,
    )
