"""Mapping rules -> design features (ADR-017 rule semantics). Pure.

Mirror of `MappingRuleSchema` (`packages/shared/src/cad/cad-mapping.schemas.ts`):
- `layer` -> `route`: every curve on the layer is one route feature (zero-length ones skipped);
- `layer` -> point type: every INSERT on the layer is one feature, unless a `block` rule matches,
  and every group of closed shapes touching each other on the layer is one feature at the centre
  of the group (ADR-033);
- `layer` -> feature type or `label`: its texts are link candidates;
- `block` (any layer) -> point type | `background` | `ignore`; wins over the layer rule;
- `text` (exact text, trimmed, case-insensitive, on one layer) -> point type: one feature at the
  text's insertion point; such texts are not linked.
Items added by a drawing correction (block `FIX_BLOCK`, ADR-038) follow their layer's rule only.
Layers without a rule are ignored. A rule to a feature type may carry `kind`, `status` and (cabinet
only, required) `role`; the feature keeps them in `attrs` (ADR-033/034).

ADR-041 (reading by meaning), `layer` rules only: `textRoles` (what the layer's texts mean, see
`text_roles.py`; target `label` or the roles' feature type), `ways` (route rules: the bundle type)
and the target `zone` (curves around a cabinet and its boxes; never a feature). Reading mode
`legacy` (no rule with `textRoles`, none to `zone`) builds exactly as Phase 1; `roles` adds the
reading of `role_reading.py` (mirror of `readingModeOf`).

Every coordinate is multiplied by the revision's `metres_per_unit` (ADR-018): no unit is assumed.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, cast

from cad_worker.domain.design import (
    CABINET_ROLES,
    FEATURE_TYPES,
    ITEM_STATUSES,
    MAX_KIND_LENGTH,
    POINT_FEATURE_TYPES,
    DesignFeatureDraft,
    FeatureType,
    Xy,
    polyline_length,
)
from cad_worker.domain.placement import Placer
from cad_worker.domain.text_roles import (
    MAX_BUNDLE_WAYS,
    TEXT_ROLES,
    TextRole,
    text_role_fits_target,
)

Target = Literal[
    "route",
    "box",
    "hhi",
    "joint",
    "mh",
    "cabinet",
    "ring",
    "label",
    "zone",
    "background",
    "ignore",
]
MAPPING_TARGETS: frozenset[str] = frozenset(
    {*FEATURE_TYPES, "label", "zone", "background", "ignore"}
)
ReadingMode = Literal["legacy", "roles"]
BLOCK_TARGETS: frozenset[str] = frozenset({*POINT_FEATURE_TYPES, "background", "ignore"})
MAX_NAME_LENGTH = 255
MAX_RULES = 2000
# Closed shapes on one point layer closer than this (metres) are one symbol (ADR-033). Technical
# tuning, not a business rule.
SHAPE_TOUCH_M = 0.05
# Block name of an item added by a drawing correction (ADR-038): no block rule applies to it, its
# layer's rule decides what it is.
FIX_BLOCK = "__fix__"


class MappingInvalidError(ValueError):
    """The frozen rules do not satisfy `MappingRuleSchema` (revision fails `MAPPING_INVALID`)."""


@dataclass(frozen=True, slots=True)
class RuleAttrs:
    """`kind` / `role` / `status` of a feature rule; None = not given (status then means `new`)."""

    kind: str | None = None
    role: str | None = None
    status: str | None = None

    def to_attrs(self) -> dict[str, object]:
        return {
            k: v
            for k, v in (("kind", self.kind), ("role", self.role), ("status", self.status))
            if v is not None
        }


NO_ATTRS = RuleAttrs()


@dataclass(frozen=True, slots=True)
class MappingRules:
    layers: Mapping[str, Target]
    blocks: Mapping[str, Target]
    # (layer, trimmed lower-case text) -> point type
    texts: Mapping[tuple[str, str], FeatureType]
    # Attributes per rule key: ("layer", name) | ("block", name) | ("text", layer, text key)
    attrs: Mapping[tuple[str, ...], RuleAttrs] = field(default_factory=dict)
    # ADR-041: layer -> its text roles (TEXT_ROLES order); route layer -> bundle ways.
    text_roles: Mapping[str, tuple[TextRole, ...]] = field(default_factory=dict)
    ways: Mapping[str, int] = field(default_factory=dict)

    @property
    def reading_mode(self) -> ReadingMode:
        """`roles` when a rule carries text roles or targets `zone` (`readingModeOf`)."""
        if self.text_roles or any(t == "zone" for t in self.layers.values()):
            return "roles"
        return "legacy"

    def curve_layers(self) -> frozenset[str]:
        """Layers whose curves the build reads: feature layers, and zone layers (ADR-041)."""
        return self.layers_with(*FEATURE_TYPES, "zone")

    def layers_with(self, *targets: str) -> frozenset[str]:
        return frozenset(name for name, target in self.layers.items() if target in targets)

    def insert_target(self, layer: str, block_name: str) -> Target | None:
        """The block rule wins over the layer rule; None = no rule (ignored)."""
        if block_name in self.blocks and block_name != FIX_BLOCK:
            return self.blocks[block_name]
        return self.layers.get(layer)

    def insert_rule(self, layer: str, block_name: str) -> tuple[str, ...]:
        """Key of the rule that decides an INSERT (block rule first)."""
        if block_name in self.blocks and block_name != FIX_BLOCK:
            return ("block", block_name)
        return ("layer", layer)

    def text_rule(self, layer: str, text: str) -> FeatureType | None:
        return self.texts.get((layer, text_rule_key(text)))

    def attrs_of(self, key: tuple[str, ...]) -> RuleAttrs:
        return self.attrs.get(key, NO_ATTRS)


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
    attrs: dict[tuple[str, ...], RuleAttrs] = {}
    text_roles: dict[str, tuple[TextRole, ...]] = {}
    ways: dict[str, int] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise MappingInvalidError(f"rule {item!r} is not an object")
        rule = cast(Mapping[str, object], item)
        source, target = rule.get("source"), rule.get("target")
        key: tuple[str, ...]
        if source == "layer" and target in MAPPING_TARGETS:
            name = _name(rule, "layer")
            _put(layers, name, cast(Target, target), rule)
            key = ("layer", name)
            roles = _text_roles(rule, str(target))
            if roles:
                text_roles[name] = roles
            rule_ways = _ways(rule, str(target))
            if rule_ways is not None:
                ways[name] = rule_ways
        elif source == "block" and target in BLOCK_TARGETS:
            name = _name(rule, "block")
            _put(blocks, name, cast(Target, target), rule)
            key = ("block", name)
        elif source == "text" and target in POINT_FEATURE_TYPES:
            text = _name(rule, "text").strip()
            if not text:
                raise MappingInvalidError(f"rule {dict(rule)!r}: empty text")
            text_key = (_name(rule, "layer"), text_rule_key(text))
            _put(texts, text_key, cast(FeatureType, target), rule)
            key = ("text", *text_key)
        else:
            raise MappingInvalidError(f"rule {dict(rule)!r}: unknown source or target")
        rule_attrs = _rule_attrs(rule, str(target))
        if rule_attrs != NO_ATTRS:
            attrs[key] = rule_attrs
    return MappingRules(layers, blocks, texts, attrs, text_roles, ways)


def _text_roles(rule: Mapping[str, object], target: str) -> tuple[TextRole, ...]:
    """`textRoles`: 1+ unique known roles, each fitting the target; returned in TEXT_ROLES order."""
    raw = rule.get("textRoles")
    if raw is None:
        return ()
    if not isinstance(raw, list) or not 1 <= len(raw) <= len(TEXT_ROLES):
        raise MappingInvalidError(f"rule {dict(rule)!r}: invalid textRoles")
    if len(set(map(str, raw))) != len(raw) or any(r not in TEXT_ROLES for r in raw):
        raise MappingInvalidError(f"rule {dict(rule)!r}: unknown or duplicate text role")
    for role in raw:
        if not text_role_fits_target(cast(TextRole, role), target):
            raise MappingInvalidError(
                f"rule {dict(rule)!r}: text role {role} does not fit target {target}"
            )
    return tuple(r for r in TEXT_ROLES if r in raw)


def _ways(rule: Mapping[str, object], target: str) -> int | None:
    raw = rule.get("ways")
    if raw is None:
        return None
    if (
        isinstance(raw, bool)
        or not isinstance(raw, int)
        or not 1 <= raw <= MAX_BUNDLE_WAYS
        or target != "route"
    ):
        raise MappingInvalidError(f"rule {dict(rule)!r}: ways must be 1-288 on a route rule")
    return raw


def _rule_attrs(rule: Mapping[str, object], target: str) -> RuleAttrs:
    """`kind` / `status` on feature rules only; `role` required on cabinet rules, else absent."""
    kind, role, status = rule.get("kind"), rule.get("role"), rule.get("status")
    is_feature = target in FEATURE_TYPES
    if kind is not None and (
        not is_feature or not isinstance(kind, str) or not 1 <= len(kind.strip()) <= MAX_KIND_LENGTH
    ):
        raise MappingInvalidError(f"rule {dict(rule)!r}: invalid kind")
    if status is not None and (not is_feature or status not in ITEM_STATUSES):
        raise MappingInvalidError(f"rule {dict(rule)!r}: invalid status")
    if target == "cabinet" and role not in CABINET_ROLES:
        raise MappingInvalidError(f"rule {dict(rule)!r}: a cabinet rule needs role main or sub")
    if target != "cabinet" and role is not None:
        raise MappingInvalidError(f"rule {dict(rule)!r}: only cabinet rules have a role")
    return RuleAttrs(
        kind.strip() if isinstance(kind, str) else None,
        role if isinstance(role, str) else None,
        status if isinstance(status, str) else None,
    )


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
    closed: bool = False
    entity_type: str = ""


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
    # Texts that became features through a `text` rule (never read as labels).
    text_feature_handles: frozenset[str] = frozenset()


def build_features(drawing: DrawingData, rules: MappingRules, place: Placer) -> BuiltFeatures:
    routes, zero_length = _routes(drawing.curves, rules, place)
    points, background_inserts = _insert_features(drawing.inserts, rules, place)
    shapes = _shape_features(drawing.curves, rules, place)
    text_features, consumed = _text_features(drawing.texts, rules, place)
    # Texts on role layers are read by meaning (ADR-041), never text-linked (no review items).
    candidate_layers = rules.layers_with(*FEATURE_TYPES, "label") - rules.text_roles.keys()
    link_texts = tuple(
        _link_text(t, place)
        for t in drawing.texts
        if t.layer in candidate_layers and t.handle not in consumed
    )
    return BuiltFeatures(
        features=(*routes, *points, *shapes, *text_features),
        link_texts=link_texts,
        background=BackgroundSelection(rules.layers_with("background"), background_inserts),
        zero_length_routes=zero_length,
        text_feature_handles=consumed,
    )


def _routes(
    curves: Iterable[SourceCurve], rules: MappingRules, place: Placer
) -> tuple[list[DesignFeatureDraft], int]:
    route_layers = rules.layers_with("route")
    out: list[DesignFeatureDraft] = []
    skipped = 0
    for curve in curves:
        if curve.layer not in route_layers:
            continue
        coords = tuple(place.to_project(p) for p in curve.points)
        if len(coords) < 2 or polyline_length(coords) <= 0:
            skipped += 1  # a LineString of zero length is not a route
            continue
        attrs = rules.attrs_of(("layer", curve.layer)).to_attrs()
        out.append(
            DesignFeatureDraft("route", curve.layer, None, "curve", curve.handle, coords, attrs)
        )
    return out, skipped


def _insert_features(
    inserts: Iterable[SourceInsert], rules: MappingRules, place: Placer
) -> tuple[list[DesignFeatureDraft], frozenset[str]]:
    out: list[DesignFeatureDraft] = []
    background: set[str] = set()
    for insert in inserts:
        target = rules.insert_target(insert.layer, insert.block_name)
        if target == "background":
            background.add(insert.handle)
        if target not in POINT_FEATURE_TYPES:
            continue
        attrs = rules.attrs_of(rules.insert_rule(insert.layer, insert.block_name)).to_attrs()
        if insert.attributes:
            attrs["attributes"] = _attributes(insert.attributes)
        out.append(
            DesignFeatureDraft(
                cast(FeatureType, target),
                insert.layer,
                insert.block_name,
                "insert",
                insert.handle,
                (place.to_project(insert.position),),
                attrs,
            )
        )
    return out, frozenset(background)


def _shape_features(
    curves: Iterable[SourceCurve], rules: MappingRules, place: Placer
) -> list[DesignFeatureDraft]:
    """Closed shapes on a point-type layer; shapes touching each other are one symbol, placed at
    the centre of their joint extents (ADR-032/033). Keyed by the smallest handle of the group.
    Extents are taken in the drawing (in metres), then the centre is placed (ADR-035)."""
    point_layers = {
        name: cast(FeatureType, t) for name, t in rules.layers.items() if t in POINT_FEATURE_TYPES
    }
    by_layer: dict[str, list[tuple[str, tuple[float, float, float, float]]]] = {}
    for curve in curves:
        if curve.layer in point_layers and curve.closed and len(curve.points) >= 2:
            xs = [p[0] * place.unit_m for p in curve.points]
            ys = [p[1] * place.unit_m for p in curve.points]
            by_layer.setdefault(curve.layer, []).append(
                (curve.handle, (min(xs), min(ys), max(xs), max(ys)))
            )
    out: list[DesignFeatureDraft] = []
    for layer, shapes in by_layer.items():
        attrs = rules.attrs_of(("layer", layer)).to_attrs()
        for group in _touching_groups(shapes):
            boxes = [shapes[i][1] for i in group]
            handles = sorted(shapes[i][0] for i in group)
            centre = (
                (min(b[0] for b in boxes) + max(b[2] for b in boxes)) / 2,
                (min(b[1] for b in boxes) + max(b[3] for b in boxes)) / 2,
            )
            extra = {"shapes": handles} if len(handles) > 1 else {}
            out.append(
                DesignFeatureDraft(
                    point_layers[layer],
                    layer,
                    None,
                    "curve",
                    handles[0],
                    (place.to_project((centre[0] / place.unit_m, centre[1] / place.unit_m)),),
                    {**attrs, **extra},
                )
            )
    return out


def _touching_groups(
    shapes: Sequence[tuple[str, tuple[float, float, float, float]]],
) -> list[list[int]]:
    """Union-find over extents that overlap or lie within SHAPE_TOUCH_M of each other."""
    parent = list(range(len(shapes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    order = sorted(range(len(shapes)), key=lambda i: shapes[i][1][0])
    for n, i in enumerate(order):
        a = shapes[i][1]
        for j in order[n + 1 :]:
            b = shapes[j][1]
            if b[0] > a[2] + SHAPE_TOUCH_M:
                break  # sorted by min x: nothing further can touch
            if b[1] <= a[3] + SHAPE_TOUCH_M and a[1] <= b[3] + SHAPE_TOUCH_M:
                parent[find(j)] = find(i)
    groups: dict[int, list[int]] = {}
    for i in range(len(shapes)):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=lambda g: min(shapes[i][0] for i in g))


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
    texts: Iterable[SourceText], rules: MappingRules, place: Placer
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
                (place.to_project(text.position),),
                {
                    **rules.attrs_of(("text", text.layer, text_rule_key(text.text))).to_attrs(),
                    "text": text.text.strip(),
                },
            )
        )
    return out, frozenset(consumed)


def _link_text(text: SourceText, place: Placer) -> LinkText:
    return LinkText(
        handle=text.handle,
        layer=text.layer,
        position=place.to_project(text.position),
        height_m=abs(text.height) * place.unit_m,
        raw_text=text.raw_text,
        text=text.text if text.readable else None,
        readable=text.readable,
    )
