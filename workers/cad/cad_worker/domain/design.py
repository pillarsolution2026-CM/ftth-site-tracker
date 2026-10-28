"""Design feature value objects (ADR-017). Pure: no I/O, coordinates in metres (revision CRS).

Mirror of `packages/shared/src/design/feature-types.ts`.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

FeatureType = Literal["route", "box", "hhi", "joint", "mh"]
FEATURE_TYPES: tuple[FeatureType, ...] = ("route", "box", "hhi", "joint", "mh")
POINT_FEATURE_TYPES: frozenset[str] = frozenset({"box", "hhi", "joint", "mh"})
SourceKind = Literal["curve", "insert", "text"]
Xy = tuple[float, float]
# Unique within a revision (`design_features_handle_key`), stable while the drawing is unchanged.
FeatureKey = tuple[SourceKind, str]

_MILLIMETRE = Decimal("0.001")


def metres3(value: float) -> Decimal:
    """Metres as an exact decimal with 3 places (numeric(…, 3) columns), half away from zero.

    Built from the float's exact binary value, so no `str(float)` formatting decides a digit.
    """
    return Decimal(value).quantize(_MILLIMETRE, rounding=ROUND_HALF_UP) + 0  # +0 drops "-0.000"


def polyline_length(coords: tuple[Xy, ...]) -> float:
    return sum(math.dist(a, b) for a, b in itertools.pairwise(coords))


@dataclass(frozen=True, slots=True)
class DesignFeatureDraft:
    """One feature built from one drawing entity (curve, insert or text)."""

    feature_type: FeatureType
    layer: str
    block_name: str | None
    source_kind: SourceKind
    source_handle: str
    # Routes: the polyline; points: a single position. Metres in the revision CRS.
    coords: tuple[Xy, ...]
    attrs: Mapping[str, object] = field(default_factory=dict)
    code: str | None = None

    @property
    def key(self) -> FeatureKey:
        return (self.source_kind, self.source_handle)

    @property
    def is_route(self) -> bool:
        return self.feature_type == "route"
