"""Text-to-feature linking (ADR-019). Pure; distances in metres (revision CRS).

Mirror of `packages/shared/src/design/text-link.ts` (`TEXT_LINK_PATTERNS`, `TEXT_LINK_TARGETS`,
`LINK_RADIUS_TEXT_HEIGHTS`, `LINK_MIN_RADIUS_M`, `AUTO_LINK_MIN_CONFIDENCE`) — change both together.
The kinds only classify a text; their business meaning (e.g. B/P/U) is not interpreted.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from shapely import STRtree
from shapely.geometry import LineString, Point

from cad_worker.domain.design import DesignFeatureDraft, FeatureKey, FeatureType, metres3
from cad_worker.domain.design_build import LinkText

TextLinkKind = Literal["cable", "duct", "length", "box_id", "box_bpu", "other", "unreadable"]
TextLinkStatus = Literal["auto", "review", "confirmed", "rejected", "unlinked"]
TEXT_LINK_STATUSES: tuple[TextLinkStatus, ...] = (
    "auto",
    "review",
    "confirmed",
    "rejected",
    "unlinked",
)

# JavaScript `\d` is ASCII-only while Python's matches any Unicode digit: spelled `[0-9]`.
# `fullmatch` replaces the JS anchors (Python's `$` would also accept a trailing newline).
TEXT_LINK_PATTERNS: tuple[tuple[TextLinkKind, re.Pattern[str]], ...] = (
    ("cable", re.compile(r"F\s*[0-9]+\s*C", re.IGNORECASE)),
    ("duct", re.compile(r"[0-9]+\s*X\s*[0-9]+\s*Way\S*", re.IGNORECASE)),
    ("length", re.compile(r"[0-9]+(?:\.[0-9]+)?\s*M", re.IGNORECASE)),
    ("box_id", re.compile(r"[0-9]+\s*-\s*[0-9]+")),
    ("box_bpu", re.compile(r"[0-9]+\s*[BPU]", re.IGNORECASE)),
)

_ALL_TYPES: tuple[FeatureType, ...] = ("route", "box", "hhi", "joint", "mh")
TEXT_LINK_TARGETS: Mapping[TextLinkKind, tuple[FeatureType, ...]] = {
    "cable": ("route",),
    "duct": ("route",),
    "length": ("route",),
    "box_id": ("box",),
    "box_bpu": ("box",),
    "other": _ALL_TYPES,
    "unreadable": _ALL_TYPES,
}

# Technical tuning (ADR-019), not business rules.
LINK_RADIUS_TEXT_HEIGHTS = 15
LINK_MIN_RADIUS_M = 1.0
AUTO_LINK_MIN_CONFIDENCE = Decimal("0.8")
_CONFIDENCE_PLACES = Decimal("0.001")


def classify_link_text(text: str) -> TextLinkKind:
    """First matching pattern on the whole trimmed text, else `other`."""
    value = text.strip()
    for kind, pattern in TEXT_LINK_PATTERNS:
        if pattern.fullmatch(value):
            return kind
    return "other"


def link_radius_m(height_m: float) -> float:
    return max(LINK_RADIUS_TEXT_HEIGHTS * height_m, LINK_MIN_RADIUS_M)


def link_confidence(d1: float, d2: float | None, radius: float) -> Decimal:
    """0.5 * proximity + 0.5 * uniqueness, 3 decimals (the stored `numeric(4,3)` value).

    proximity = 1 - d1 / radius; uniqueness = 1 - d1 / d2, or 1 without a second candidate. Two
    candidates at the same spot (d2 = 0) are fully ambiguous: uniqueness 0.
    """
    proximity = 1.0 - d1 / radius
    if d2 is None:
        uniqueness = 1.0
    elif d2 <= 0:
        uniqueness = 0.0
    else:
        uniqueness = 1.0 - d1 / d2
    value = min(1.0, max(0.0, 0.5 * proximity + 0.5 * uniqueness))
    return Decimal(value).quantize(_CONFIDENCE_PLACES, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class TextLinkDraft:
    text: LinkText
    kind: TextLinkKind
    status: TextLinkStatus
    feature: FeatureKey | None
    distance_m: Decimal | None
    confidence: Decimal


def link_texts(
    texts: Sequence[LinkText], features: Sequence[DesignFeatureDraft]
) -> list[TextLinkDraft]:
    index = _FeatureIndex(features)
    return [_link_one(text, index) for text in texts]


def _link_one(text: LinkText, index: _FeatureIndex) -> TextLinkDraft:
    kind: TextLinkKind = classify_link_text(text.text) if text.text is not None else "unreadable"
    if kind == "other":
        return TextLinkDraft(text, kind, "unlinked", None, None, Decimal("0.000"))
    radius = link_radius_m(text.height_m)
    ranked = index.ranked(text.position, radius, TEXT_LINK_TARGETS[kind])
    if not ranked:
        return TextLinkDraft(text, kind, "review", None, None, Decimal("0.000"))
    d1, best = ranked[0]
    d2 = ranked[1][0] if len(ranked) > 1 else None
    confidence = link_confidence(d1, d2, radius)
    # Unreadable texts get the nearest feature as a proposal but are always reviewed.
    auto = kind != "unreadable" and confidence >= AUTO_LINK_MIN_CONFIDENCE
    return TextLinkDraft(
        text, kind, "auto" if auto else "review", best.key, metres3(d1), confidence
    )


class _FeatureIndex:
    def __init__(self, features: Sequence[DesignFeatureDraft]) -> None:
        self._features = list(features)
        self._geoms = [_geometry(f) for f in self._features]
        self._tree = STRtree(self._geoms)

    def ranked(
        self, position: tuple[float, float], radius: float, types: Sequence[FeatureType]
    ) -> list[tuple[float, DesignFeatureDraft]]:
        """Allowed features within the radius, nearest first (ties broken by type and handle)."""
        if not self._features:
            return []
        point = Point(position)
        hits = self._tree.query(point, predicate="dwithin", distance=radius)
        found: list[tuple[float, DesignFeatureDraft]] = []
        for i in hits:
            feature = self._features[int(i)]
            if feature.feature_type in types:
                found.append((float(point.distance(self._geoms[int(i)])), feature))
        found.sort(key=lambda item: (item[0], item[1].feature_type, item[1].key))
        return found


def _geometry(feature: DesignFeatureDraft) -> Point | LineString:
    return LineString(feature.coords) if feature.is_route else Point(feature.coords[0])


def box_codes(
    links: Sequence[TextLinkDraft], features: Sequence[DesignFeatureDraft]
) -> dict[FeatureKey, str]:
    """A box's code = its best `box_id` link (auto or confirmed): highest confidence, then the
    nearest, then the text handle (deterministic)."""
    boxes = {f.key for f in features if f.feature_type == "box"}
    best: dict[FeatureKey, TextLinkDraft] = {}
    for link in links:
        if link.kind != "box_id" or link.status not in ("auto", "confirmed"):
            continue
        if link.feature is None or link.feature not in boxes or link.text.text is None:
            continue
        current = best.get(link.feature)
        if current is None or _rank(link) < _rank(current):
            best[link.feature] = link
    return {key: link.text.text.strip() for key, link in best.items() if link.text.text}


def _rank(link: TextLinkDraft) -> tuple[Decimal, Decimal, str]:
    return (-link.confidence, link.distance_m or Decimal(0), link.text.handle)


def linked_texts_by_kind(
    links: Sequence[TextLinkDraft],
) -> dict[FeatureKey, dict[str, list[str]]]:
    """Auto-linked texts per feature and kind (stored in `design_features.attrs.texts`)."""
    out: dict[FeatureKey, dict[str, list[str]]] = {}
    ordered = sorted(links, key=_rank)
    for link in ordered:
        if link.status != "auto" or link.feature is None or link.text.text is None:
            continue
        out.setdefault(link.feature, {}).setdefault(link.kind, []).append(link.text.text.strip())
    return out


def status_counts(links: Sequence[TextLinkDraft]) -> dict[str, int]:
    """`text_link_counts`: every status, zeros included."""
    counter = Counter(link.status for link in links)
    return {status: counter.get(status, 0) for status in TEXT_LINK_STATUSES}
