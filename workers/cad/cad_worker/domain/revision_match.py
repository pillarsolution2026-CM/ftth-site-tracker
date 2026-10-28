"""Matching a new revision to its base and the diff report (ADR-020). Pure; metres.

Per feature type, one-to-one, in this order:
1. same source handle (and kind) and within tolerance;
2. same non-empty code, unique among the still unmatched features on both sides;
3. nearest within tolerance (points: distance; routes: Hausdorff), greedy by ascending distance.
   When another unmatched base feature is within tolerance and no farther than the best + 0.5 m,
   the match is a `conflict`: it keeps the nearest id and lists the others.
Matched features are `unchanged` (≤ 1 mm and same code), `moved` (points), `reshaped` (routes) or
`attributes_changed`; leftovers are `added` (new id) or `removed` (base id).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal
from uuid import UUID

import shapely
from shapely import STRtree
from shapely.geometry import LineString, Point

from cad_worker.domain.design import (
    FEATURE_TYPES,
    DesignFeatureDraft,
    FeatureKey,
    FeatureType,
    SourceKind,
    Xy,
    metres3,
    polyline_length,
)

DiffChange = Literal[
    "added", "removed", "unchanged", "moved", "reshaped", "attributes_changed", "conflict"
]
DIFF_CHANGES: tuple[DiffChange, ...] = (
    "added",
    "removed",
    "unchanged",
    "moved",
    "reshaped",
    "attributes_changed",
    "conflict",
)

# Technical tuning (ADR-020), not business rules.
MATCH_TOLERANCE_M = 5.0
CONFLICT_MARGIN_M = 0.5
UNCHANGED_MAX_M = 0.001


@dataclass(frozen=True, slots=True)
class BaseFeature:
    """A feature of the base revision, in the new revision's CRS (metres)."""

    feature_id: UUID
    feature_type: FeatureType
    code: str | None
    source_kind: SourceKind
    source_handle: str
    coords: tuple[Xy, ...]


@dataclass(frozen=True, slots=True)
class DiffEntry:
    feature_id: UUID
    feature_type: FeatureType
    change: DiffChange
    code: str | None
    previous_code: str | None
    distance_m: Decimal | None
    candidate_ids: tuple[UUID, ...]
    # The new feature (None for `removed`).
    key: FeatureKey | None


@dataclass(frozen=True, slots=True)
class RevisionMatch:
    ids: dict[FeatureKey, UUID]
    new_ids: frozenset[UUID]
    entries: tuple[DiffEntry, ...]


def match_revision(
    features: Sequence[DesignFeatureDraft],
    base: Sequence[BaseFeature],
    new_id: Callable[[], UUID],
) -> RevisionMatch:
    ids: dict[FeatureKey, UUID] = {}
    new_ids: set[UUID] = set()
    entries: list[DiffEntry] = []
    for feature_type in FEATURE_TYPES:
        group = sorted((f for f in features if f.feature_type == feature_type), key=_new_order)
        base_group = sorted(
            (b for b in base if b.feature_type == feature_type), key=lambda b: str(b.feature_id)
        )
        pairs = _TypeMatcher(group, base_group).run()
        for feature in group:
            matched = pairs.get(feature.key)
            if matched is None:
                fid = new_id()
                new_ids.add(fid)
                ids[feature.key] = fid
                entries.append(
                    DiffEntry(fid, feature_type, "added", feature.code, None, None, (), feature.key)
                )
                continue
            ids[feature.key] = matched.base.feature_id
            entries.append(_classify(feature, matched))
        used = {m.base.feature_id for m in pairs.values()}
        for b in base_group:
            if b.feature_id not in used:
                entries.append(
                    DiffEntry(b.feature_id, feature_type, "removed", b.code, None, None, (), None)
                )
    return RevisionMatch(ids, frozenset(new_ids), tuple(entries))


def diff_counts(entries: Sequence[DiffEntry]) -> dict[str, int]:
    """`diff_counts`: every change, zeros included."""
    counter = Counter(entry.change for entry in entries)
    return {change: counter.get(change, 0) for change in DIFF_CHANGES}


def _new_order(feature: DesignFeatureDraft) -> FeatureKey:
    return feature.key


@dataclass(frozen=True, slots=True)
class _Match:
    base: BaseFeature
    distance: float
    candidates: tuple[UUID, ...] = ()


def _geometry(coords: tuple[Xy, ...], route: bool) -> Point | LineString:
    return LineString(coords) if route else Point(coords[0])


class _TypeMatcher:
    """Matching of one feature type (both sides share the geometry kind)."""

    def __init__(self, new: list[DesignFeatureDraft], base: list[BaseFeature]) -> None:
        self._new = new
        self._base = base
        self._new_geom = [_geometry(f.coords, f.is_route) for f in new]
        self._base_geom = [_geometry(b.coords, b.feature_type == "route") for b in base]
        self._open_new = set(range(len(new)))
        self._open_base = set(range(len(base)))
        self._result: dict[FeatureKey, _Match] = {}

    def run(self) -> dict[FeatureKey, _Match]:
        if self._new and self._base:
            self._by_handle()
            self._by_code()
            self._by_distance()
        return self._result

    def distance(self, i: int, j: int) -> float:
        a, b = self._new_geom[i], self._base_geom[j]
        if isinstance(a, LineString):
            return float(shapely.hausdorff_distance(a, b))
        return float(a.distance(b))

    def _take(self, i: int, j: int, distance: float, candidates: tuple[UUID, ...] = ()) -> None:
        self._open_new.discard(i)
        self._open_base.discard(j)
        self._result[self._new[i].key] = _Match(self._base[j], distance, candidates)

    def _by_handle(self) -> None:
        by_handle = {(b.source_kind, b.source_handle): j for j, b in enumerate(self._base)}
        for i, feature in enumerate(self._new):
            j = by_handle.get(feature.key)
            if j is None or j not in self._open_base:
                continue
            distance = self.distance(i, j)
            if distance <= MATCH_TOLERANCE_M:
                self._take(i, j, distance)

    def _by_code(self) -> None:
        new_codes = Counter(self._new[i].code for i in self._open_new if self._new[i].code)
        base_codes = Counter(self._base[j].code for j in self._open_base if self._base[j].code)
        base_by_code = {self._base[j].code: j for j in self._open_base if self._base[j].code}
        for i in sorted(self._open_new):
            code = self._new[i].code
            if code and new_codes[code] == 1 and base_codes.get(code) == 1:
                j = base_by_code[code]
                self._take(i, j, self.distance(i, j))

    def _by_distance(self) -> None:
        open_base = sorted(self._open_base)
        tree = STRtree([self._base_geom[j] for j in open_base])
        near: dict[int, list[tuple[float, int]]] = {}
        for i in sorted(self._open_new):
            hits = tree.query(self._new_geom[i], predicate="dwithin", distance=MATCH_TOLERANCE_M)
            found = [(self.distance(i, open_base[int(h)]), open_base[int(h)]) for h in hits]
            near[i] = sorted((d, j) for d, j in found if d <= MATCH_TOLERANCE_M)
        pairs = sorted(
            ((d, self._new[i].key, i, j) for i, cands in near.items() for d, j in cands),
            key=lambda p: (p[0], p[1], str(self._base[p[3]].feature_id)),
        )
        for d, _, i, j in pairs:
            if i not in self._open_new or j not in self._open_base:
                continue
            others = tuple(
                self._base[k].feature_id
                for dk, k in near[i]
                if k != j and k in self._open_base and dk <= d + CONFLICT_MARGIN_M
            )
            self._take(i, j, d, others)


def _classify(feature: DesignFeatureDraft, match: _Match) -> DiffEntry:
    base = match.base
    if match.candidates:
        change: DiffChange = "conflict"
    elif _geometry_changed(feature, base, match.distance):
        change = "reshaped" if feature.is_route else "moved"
    elif (feature.code or None) != (base.code or None):
        change = "attributes_changed"
    else:
        change = "unchanged"
    return DiffEntry(
        base.feature_id,
        feature.feature_type,
        change,
        feature.code,
        base.code,
        metres3(match.distance),
        match.candidates,
        feature.key,
    )


def _geometry_changed(feature: DesignFeatureDraft, base: BaseFeature, distance: float) -> bool:
    if distance > UNCHANGED_MAX_M:
        return True
    if feature.is_route:
        return abs(polyline_length(feature.coords) - polyline_length(base.coords)) > UNCHANGED_MAX_M
    return False
