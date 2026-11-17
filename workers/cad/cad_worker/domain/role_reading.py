"""Reading the General and the Secondary by meaning (ADR-041, ADR-040 B/C). Pure; metres.

Runs in `roles` reading mode only, on the corrected drawing (ADR-038 corrections are applied
before: a `set_text` / `add_text` / `move_layer` fixes role texts too). Mirror of the shapes in
`packages/shared/src/design/feature-reading.schemas.ts` (`attrs.reading`, `ReadingTotals`).

- Role texts: readable texts on layers whose rule carries `textRoles`, read by `read_role_text`
  (unread texts mean nothing and are left alone). Texts made into features by a `text` rule are
  not read. A handhole type outside the list takes the type the PM confirmed for that spelling on
  the text's layer (`handholeTypeAliases`, owner 2026-11-11); unconfirmed it stays unknown.
- Linking: a role text goes to a feature of `TEXT_ROLE_FEATURE[role]` within the ADR-019 radius
  (`role_link_radius_m(text height)`), distance to the point or to the line. Pairs are one-to-one,
  nearest first, ties by handles (as `pair_labels`): a feature takes one text per role — a route
  takes one bundle TYPE text and one LENGTH-only text (`bundle_label`), up to two `bundle_spare`
  texts; a cabinet one `cabinet_info` text per field (name, type, box count, ports).
- General cable labels: a segment carries a bundle label and a cable label written together
  (ADR-040). Each cable text is first paired with the nearest bundle type text within its radius
  (one-to-one); it then goes to that bundle text's route, else to the nearest route with no cable
  text. The cable slack is checked per such pair (`CablePair`), so one polyline drawn through two
  segments cannot mix one segment's bundle with the other's cable.
- Codes: box = `box_code(cabinet, number)` (it belongs to the cabinet written on it), hhi = its
  number, cabinet = its name; None when the text is missing.
- Connectors (Secondary): each end of a 1way route (rule `ways` = 1) lying within
  `CONNECTOR_TOUCH_M` of a route of another known `ways` counts once.
- Zones (Secondary): curves on `zone` layers touching within `ZONE_TOUCH_M` form a group; its area
  is the convex hull of its vertices; a cabinet in a hull has a zone (smallest hull wins, keyed by
  the group's smallest handle).
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from itertools import pairwise

import numpy as np
import shapely
from numpy.typing import NDArray
from shapely import STRtree
from shapely.geometry import LineString, MultiPoint, Point, Polygon

from cad_worker.domain.design import DesignFeatureDraft, FeatureKey, FeatureType, Xy
from cad_worker.domain.design_build import MappingRules, SourceCurve, SourceText
from cad_worker.domain.placement import Placer
from cad_worker.domain.text_links import LINK_MIN_RADIUS_M
from cad_worker.domain.text_roles import (
    CABINET_INFO_FIELDS,
    HANDHOLE_TYPES,
    TEXT_ROLE_FEATURE,
    DrawingKind,
    RoleReading,
    TextRole,
    box_code,
    cabinet_name_key,
    js_trim,
    read_role_text,
)

READING_ATTR_KEY = "reading"
# End caps per spare single (owner: bundle end + cabinet side; `END_CAPS_PER_SPARE`).
END_CAPS_PER_SPARE = 2
# Radius of a role text, in text heights. ADR-041 reuses ADR-019's 15 heights; on the Al-Fath
# Secondary 5 box cabinet texts, 4 box numbers and 5 cable lengths stand 15.1-18.4 heights from
# their own box (the next box is at least 17.8 heights away), so 15 left 5 boxes without their
# cabinet. Role pairs are one-to-one and nearest first, so the wider radius cannot take a text that
# is nearer to another free feature. Technical tuning, recorded for the architect's review.
ROLE_LINK_RADIUS_TEXT_HEIGHTS = 20
# Technical bounds (security review of ADR-041), not business rules. A text's reach never exceeds
# ROLE_LINK_MAX_RADIUS_M, whatever its height (the Al-Fath General writes 7.5 m texts: 150 m), and a
# text weighs only its ROLE_LINK_MAX_CANDIDATES nearest features of its type (ties by handle), so a
# huge text height or stacked entities cannot make the linking quadratic. Pairs stay one-to-one and
# nearest first; a text whose nearest few all went to nearer texts stays unlinked.
ROLE_LINK_MAX_RADIUS_M = 250.0
ROLE_LINK_MAX_CANDIDATES = 16
# Technical tolerances (ADR-041), set on the Al-Fath Secondary golden run: 1way ends lie on the
# bundle they leave (185 within 0.05 m, 187 within 0.5 m and still 187 at 1 m; 192 at 2 m), and
# every box centre is 1.28-1.76 m from the end of its drop.
CONNECTOR_TOUCH_M = 0.5
BOX_REACH_M = 2.5
# Zone curves closer than this are one zone line (ADR-041).
ZONE_TOUCH_M = 0.05
_MILLI = Decimal("0.001")


@dataclass(frozen=True, slots=True)
class RoleText:
    handle: str
    layer: str
    position: Xy  # metres (revision CRS)
    radius_m: float
    text: str  # trimmed
    reading: RoleReading

    @property
    def slot(self) -> str:
        """What the text fills on its feature (one text per slot)."""
        r = self.reading
        if r.role == "bundle_label":
            return "bundle_label:type" if r.ways is not None else "bundle_label:length"
        if r.role == "cabinet_info":
            return f"cabinet_info:{r.field}"
        return r.role


_SLOT_CAPACITY: Mapping[str, int] = {"bundle_spare": 2}


@dataclass(frozen=True, slots=True)
class CablePair:
    """General: a bundle type text and the cable text written with it."""

    bundle: RoleText
    cable: RoleText
    route: FeatureKey | None


@dataclass(frozen=True, slots=True)
class ZoneGroup:
    handle: str  # smallest handle of the group's curves
    hull: Polygon | None  # None: the vertices span no area
    area: float


@dataclass(frozen=True, slots=True)
class FeatureTexts:
    """The role texts one feature took, by slot."""

    by_slot: dict[str, list[RoleText]] = field(default_factory=dict)

    def one(self, slot: str) -> RoleText | None:
        texts = self.by_slot.get(slot)
        return texts[0] if texts else None

    def all(self, slot: str) -> list[RoleText]:
        return self.by_slot.get(slot, [])

    def handles_by_role(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for slot in sorted(self.by_slot, key=_slot_order):
            role = slot.split(":", 1)[0]
            out.setdefault(role, []).extend(t.handle for t in self.by_slot[slot])
        return out


def _slot_order(slot: str) -> tuple[int, int]:
    """Role order, then bundle type before length, cabinet fields in CABINET_INFO_FIELDS order."""
    role, _, sub = slot.partition(":")
    subs: tuple[str, ...] = CABINET_INFO_FIELDS if role == "cabinet_info" else ("type", "length")
    return (_ROLE_INDEX[role], subs.index(sub) if sub in subs else 0)


_ROLE_INDEX: Mapping[str, int] = {r: i for i, r in enumerate(TEXT_ROLE_FEATURE)}


@dataclass(frozen=True, slots=True)
class Reading:
    """Everything the roles reading found; the checks (`kind_checks.py`) work from it."""

    drawing_kind: DrawingKind
    texts: tuple[RoleText, ...]
    # Feature -> its role texts; text handle -> feature.
    feature_texts: Mapping[FeatureKey, FeatureTexts]
    text_feature: Mapping[str, FeatureKey]
    cable_pairs: tuple[CablePair, ...]
    # Feature -> attrs.reading JSON (box, route, hhi, cabinet features; all of them).
    readings: Mapping[FeatureKey, dict[str, object]]
    # Feature -> roles-mode code (box, hhi, cabinet features; None = not named).
    codes: Mapping[FeatureKey, str | None]
    one_way_ends: tuple[Xy, ...]
    zones: tuple[ZoneGroup, ...]
    unread_texts: int = 0

    def reading_of(self, key: FeatureKey) -> Mapping[str, object]:
        return self.readings.get(key, {})


def role_link_radius_m(height_m: float) -> float:
    """Between LINK_MIN_RADIUS_M and ROLE_LINK_MAX_RADIUS_M (a height that is not a number
    reaches the minimum)."""
    radius = ROLE_LINK_RADIUS_TEXT_HEIGHTS * height_m
    if math.isnan(radius):
        return LINK_MIN_RADIUS_M
    return min(max(radius, LINK_MIN_RADIUS_M), ROLE_LINK_MAX_RADIUS_M)


def role_texts(
    texts: Iterable[SourceText], rules: MappingRules, place: Placer, skip: frozenset[str]
) -> tuple[list[RoleText], int]:
    """Read every readable text on a role layer; returns the read ones and how many read nothing."""
    out: list[RoleText] = []
    unread = 0
    for t in texts:
        roles = rules.text_roles.get(t.layer)
        if not roles or not t.readable or t.handle in skip:
            continue
        reading = read_role_text(t.text, roles)
        if reading is None:
            unread += 1 if js_trim(t.text) else 0
            continue
        if reading.role == "handhole_type" and reading.handhole_type is None:
            confirmed = rules.confirmed_handhole_type(t.layer, reading.written or "")
            if confirmed is not None:
                reading = replace(reading, handhole_type=confirmed)
        out.append(
            RoleText(
                t.handle,
                t.layer,
                place.to_project(t.position),
                role_link_radius_m(abs(t.height) * place.unit_m),
                js_trim(t.text),
                reading,
            )
        )
    return out, unread


def read_drawing(
    features: Sequence[DesignFeatureDraft],
    texts: Sequence[SourceText],
    curves: Sequence[SourceCurve],
    rules: MappingRules,
    place: Placer,
    drawing_kind: DrawingKind,
    skip_texts: frozenset[str] = frozenset(),
) -> Reading:
    read, unread = role_texts(texts, rules, place, skip_texts)
    index = _Index(features)
    cables = [t for t in read if t.reading.role == "cable_label"]
    others = [t for t in read if t.reading.role != "cable_label"]
    by_feature, text_feature = _link(others, index)
    pairs = _pair_cables(cables, [t for t in others if t.slot == "bundle_label:type"])
    cable_pairs = _link_cables(cables, pairs, index, by_feature, text_feature)
    one_way = _one_way_routes(features, rules)
    connectors = _connectors(one_way, features, rules)
    ends = tuple(p for f in one_way for p in (f.coords[0], f.coords[-1]))
    zones = _zone_groups(curves, rules, place)
    readings: dict[FeatureKey, dict[str, object]] = {}
    codes: dict[FeatureKey, str | None] = {}
    boxes_by_cabinet: Counter[str] = Counter()
    for f in features:
        ft = by_feature.get(f.key, FeatureTexts())
        if f.feature_type == "box":
            readings[f.key], codes[f.key] = _box(ft)
            cabinet = readings[f.key]["cabinet"]
            if isinstance(cabinet, str):
                boxes_by_cabinet[cabinet_name_key(cabinet)] += 1
        elif f.feature_type == "hhi":
            readings[f.key], codes[f.key] = _handhole(ft)
        elif f.is_route:
            readings[f.key] = _route(ft, rules.ways.get(f.layer), connectors.get(f.key, 0))
    secondary = drawing_kind == "secondary"
    zone_index = _ZoneIndex(zones) if secondary else None
    for f in features:
        if f.feature_type == "cabinet":
            ft = by_feature.get(f.key, FeatureTexts())
            zone = zone_index.of(f.coords[0]) if zone_index is not None else None
            readings[f.key], codes[f.key] = _cabinet(ft, boxes_by_cabinet, secondary, zone)
    return Reading(
        drawing_kind=drawing_kind,
        texts=tuple(read),
        feature_texts=by_feature,
        text_feature=text_feature,
        cable_pairs=tuple(cable_pairs),
        readings=readings,
        codes=codes,
        one_way_ends=ends,
        zones=tuple(zones),
        unread_texts=unread,
    )


# ---------- linking ----------


_QUERY_CHUNK = 1024
# The nearest-features search starts within this reach and widens it by _REACH_GROWTH per round.
_FIRST_REACH_M = 8.0
_REACH_GROWTH = 4.0


class _Near:
    """Geometries with a tie rank; the nearest few within a radius."""

    def __init__(self, geoms: Sequence[Point | LineString], ranks: Sequence[int]) -> None:
        # Of stacked copies of one geometry (same distance to every text) only the lowest ranks
        # can be among a text's nearest few: the others are left out of the tree.
        stacked: dict[bytes, list[int]] = {}
        for i, wkb in enumerate(shapely.to_wkb(list(geoms)).tolist()):
            stacked.setdefault(wkb, []).append(i)
        kept = sorted(
            i
            for same in stacked.values()
            for i in sorted(same, key=ranks.__getitem__)[:ROLE_LINK_MAX_CANDIDATES]
        )
        self.local: NDArray[np.intp] = np.asarray(kept, dtype=np.intp)
        self.geoms: NDArray[np.object_] = np.empty(len(kept), dtype=object)
        self.geoms[:] = [geoms[i] for i in kept]
        self.ranks: NDArray[np.int64] = np.asarray([ranks[i] for i in kept], dtype=np.int64)
        self.tree = STRtree(self.geoms)

    def nearest(
        self, positions: Sequence[Xy], radii: Sequence[float]
    ) -> list[list[tuple[float, int]]]:
        """Per position: (distance, local index) of the ROLE_LINK_MAX_CANDIDATES nearest
        geometries within its radius, nearest first, ties by rank.

        Bulk queries in chunks, reach growing from `_FIRST_REACH_M` up to the radius: a position
        with enough geometries within its current reach has its nearest few among them (all the
        others are farther), so dense or stacked scenes are never searched to the full radius."""
        out: list[list[tuple[float, int]]] = [[] for _ in positions]
        if not positions:
            return out
        xy = np.asarray(positions, dtype=np.float64)
        radius = np.asarray(radii, dtype=np.float64)
        reach = np.minimum(radius, _FIRST_REACH_M)
        pending: NDArray[np.intp] = np.arange(len(positions))
        while len(pending):
            unfinished: list[NDArray[np.intp]] = []
            for start in range(0, len(pending), _QUERY_CHUNK):
                chunk = pending[start : start + _QUERY_CHUNK]
                unfinished.append(self._nearest_chunk(xy[chunk], radius, reach, chunk, out))
            pending = np.concatenate(unfinished)
            reach[pending] = np.minimum(reach[pending] * _REACH_GROWTH, radius[pending])
        return out

    def _nearest_chunk(
        self,
        xy: NDArray[np.float64],
        radius: NDArray[np.float64],
        reach: NDArray[np.float64],
        chunk: NDArray[np.intp],
        out: list[list[tuple[float, int]]],
    ) -> NDArray[np.intp]:
        """Fills `out` for the chunk's settled positions; returns the unsettled ones."""
        points = shapely.points(xy)
        left, right = self.tree.query(points, predicate="dwithin", distance=reach[chunk])
        found = np.bincount(left, minlength=len(chunk))
        settled = (found >= ROLE_LINK_MAX_CANDIDATES) | (reach[chunk] >= radius[chunk])
        mine = settled[left]
        left, right = left[mine], right[mine]
        if len(left):
            dists: NDArray[np.float64] = shapely.distance(points[left], self.geoms[right])
            order = np.lexsort((self.ranks[right], dists, left))
            left, right, dists = left[order], right[order], dists[order]
            # Rank within each position's run; keep the first few.
            firsts = np.flatnonzero(np.r_[True, left[1:] != left[:-1]])
            run_start = np.repeat(firsts, np.diff(np.r_[firsts, len(left)]))
            keep = np.arange(len(left)) - run_start < ROLE_LINK_MAX_CANDIDATES
            for i, j, d in zip(
                chunk[left[keep]].tolist(),
                self.local[right[keep]].tolist(),
                dists[keep].tolist(),
                strict=True,
            ):
                out[i].append((d, j))
        return chunk[~settled]


def _ranks(keys: Sequence[str]) -> list[int]:
    """Rank of each key in sorted order (ties between equal distances go to the smallest)."""
    ranks = [0] * len(keys)
    for rank, i in enumerate(sorted(range(len(keys)), key=keys.__getitem__)):
        ranks[i] = rank
    return ranks


class _Index:
    def __init__(self, features: Sequence[DesignFeatureDraft]) -> None:
        self.features = list(features)
        by_type: dict[FeatureType, list[int]] = {}
        for n, f in enumerate(self.features):
            by_type.setdefault(f.feature_type, []).append(n)
        self._by_type: dict[FeatureType, tuple[list[int], _Near]] = {}
        for feature_type, members in by_type.items():
            geoms = [_feature_geom(self.features[n]) for n in members]
            ranks = _ranks([self.features[n].source_handle for n in members])
            self._by_type[feature_type] = (members, _Near(geoms, ranks))

    def within(
        self, texts: Sequence[RoleText], feature_type: FeatureType
    ) -> list[list[tuple[float, int]]]:
        """Per text: (distance, feature index) of the nearest features of a type within the
        text's radius (`_Near.nearest`)."""
        entry = self._by_type.get(feature_type)
        if entry is None or not texts:
            return [[] for _ in texts]
        members, near = entry
        found = near.nearest([t.position for t in texts], [t.radius_m for t in texts])
        return [[(d, members[k]) for d, k in hits] for hits in found]


def _feature_geom(f: DesignFeatureDraft) -> Point | LineString:
    return LineString(f.coords) if f.is_route else Point(f.coords[0])


def _link(
    texts: Sequence[RoleText], index: _Index
) -> tuple[dict[FeatureKey, FeatureTexts], dict[str, FeatureKey]]:
    """One-to-one, nearest pairs first; a feature takes one text per slot (two spares)."""
    by_type: dict[FeatureType, list[int]] = {}
    for j, t in enumerate(texts):
        by_type.setdefault(TEXT_ROLE_FEATURE[t.reading.role], []).append(j)
    pairs: list[tuple[float, str, str, int, int]] = []
    for feature_type, members in by_type.items():
        found = index.within([texts[j] for j in members], feature_type)
        for j, hits in zip(members, found, strict=True):
            for d, n in hits:
                pairs.append((d, index.features[n].source_handle, texts[j].handle, n, j))
    pairs.sort()
    by_feature: dict[FeatureKey, FeatureTexts] = {}
    text_feature: dict[str, FeatureKey] = {}
    for _, _, _, n, j in pairs:
        t = texts[j]
        if t.handle in text_feature:
            continue
        key = index.features[n].key
        ft = by_feature.setdefault(key, FeatureTexts())
        if len(ft.all(t.slot)) >= _SLOT_CAPACITY.get(t.slot, 1):
            continue
        ft.by_slot.setdefault(t.slot, []).append(t)
        text_feature[t.handle] = key
    return by_feature, text_feature


def _pair_cables(cables: Sequence[RoleText], bundles: Sequence[RoleText]) -> dict[str, RoleText]:
    """Cable text handle -> the bundle type text written with it (nearest first, one-to-one,
    within the cable text's radius)."""
    if not cables or not bundles:
        return {}
    near = _Near([Point(b.position) for b in bundles], _ranks([b.handle for b in bundles]))
    pairs: list[tuple[float, str, str, int, int]] = []
    found = near.nearest([c.position for c in cables], [c.radius_m for c in cables])
    for i, (c, hits) in enumerate(zip(cables, found, strict=True)):
        for d, j in hits:
            pairs.append((d, c.handle, bundles[j].handle, i, j))
    pairs.sort()
    used: set[int] = set()
    out: dict[str, RoleText] = {}
    for _, _, _, i, j in pairs:
        if cables[i].handle in out or j in used:
            continue
        used.add(j)
        out[cables[i].handle] = bundles[j]
    return out


def _link_cables(
    cables: Sequence[RoleText],
    pairs: Mapping[str, RoleText],
    index: _Index,
    by_feature: dict[FeatureKey, FeatureTexts],
    text_feature: dict[str, FeatureKey],
) -> list[CablePair]:
    def free(key: FeatureKey) -> bool:
        ft = by_feature.get(key)
        return ft is None or not ft.all("cable_label")

    def take(key: FeatureKey, t: RoleText) -> None:
        by_feature.setdefault(key, FeatureTexts()).by_slot.setdefault("cable_label", []).append(t)
        text_feature[t.handle] = key

    # Cables written with a linked bundle text follow it (nearest pair first).
    rest: list[RoleText] = []
    for c in sorted(cables, key=lambda c: c.handle):
        bundle = pairs.get(c.handle)
        route = text_feature.get(bundle.handle) if bundle is not None else None
        if route is not None and free(route):
            take(route, c)
        else:
            rest.append(c)
    candidates: list[tuple[float, str, str, int, RoleText]] = []
    for c, hits in zip(rest, index.within(rest, "route"), strict=True):
        for d, n in hits:
            candidates.append((d, index.features[n].source_handle, c.handle, n, c))
    candidates.sort(key=lambda p: p[:4])
    for _, _, _, n, c in candidates:
        key = index.features[n].key
        if c.handle not in text_feature and free(key):
            take(key, c)
    return [
        CablePair(bundle, c, text_feature.get(c.handle))
        for c in cables
        if (bundle := pairs.get(c.handle)) is not None
    ]


# ---------- readings per feature ----------


def _box(ft: FeatureTexts) -> tuple[dict[str, object], str | None]:
    cabinet = ft.one("box_cabinet")
    number = ft.one("box_number")
    cores = ft.one("box_cable_type")
    length = ft.one("box_cable_length")
    cab = cabinet.reading.cabinet if cabinet else None
    num = number.reading.number if number else None
    reading: dict[str, object] = {
        "of": "box",
        "cabinet": cab,
        "number": num,
        "cableCores": _cores(cores.reading.cores) if cores else None,
        "cableLengthM": length.reading.length_m if length else None,
        "texts": ft.handles_by_role(),
    }
    return reading, box_code(cab, num) if cab and num else None


def _handhole(ft: FeatureTexts) -> tuple[dict[str, object], str | None]:
    number = ft.one("handhole_number")
    kind = ft.one("handhole_type")
    num = number.reading.number if number else None
    reading: dict[str, object] = {
        "of": "hhi",
        "number": num,
        "type": kind.reading.handhole_type if kind else None,
        "typeText": kind.reading.written if kind else None,
        "texts": ft.handles_by_role(),
    }
    return reading, num


def _route(ft: FeatureTexts, ways: int | None, connectors: int) -> dict[str, object]:
    label = ft.one("bundle_label:type")
    length = ft.one("bundle_label:length")
    cable = ft.one("cable_label")
    spare = ft.one("cable_spare")
    written = label.reading.length_m if label and label.reading.length_m else None
    if written is None and length is not None:
        written = length.reading.length_m
    return {
        "of": "route",
        "ways": ways,
        "labelWays": _ways(label.reading.ways) if label else None,
        "ductSize": label.reading.duct_size if label else None,
        "writtenLengthM": written,
        "cableCores": _cores(cable.reading.cores) if cable else None,
        "cableLengthM": cable.reading.length_m if cable else None,
        "spareCores": _cores(spare.reading.cores) if spare else None,
        "spares": [
            {"count": t.reading.count, "ductSize": t.reading.duct_size}
            for t in ft.all("bundle_spare")
            if t.reading.count
        ],
        "connectors": connectors,
        "texts": ft.handles_by_role(),
    }


def _cabinet(
    ft: FeatureTexts,
    boxes_by_cabinet: Mapping[str, int],
    secondary: bool,
    zone: ZoneGroup | None,
) -> tuple[dict[str, object], str | None]:
    def value(field_name: str) -> str | None:
        t = ft.one(f"cabinet_info:{field_name}")
        return t.reading.value if t else None

    name = value("name")
    box_count = value("box_count")
    ports = value("ports")
    reading: dict[str, object] = {
        "of": "cabinet",
        "name": name,
        "type": value("type"),
        "boxCount": int(box_count) if box_count is not None else None,
        "ports": int(ports) if ports is not None else None,
        "boxesDrawn": (boxes_by_cabinet.get(cabinet_name_key(name), 0) if name else 0)
        if secondary
        else None,
        "zoneHandle": zone.handle if zone else None,
        "texts": ft.handles_by_role(),
    }
    return reading, name


def _cores(value: int | None) -> int | None:
    """The contract's cores are ≥ 1: a written 0 reads as no cable type."""
    return value if value else None


def _ways(value: int | None) -> int | None:
    return value if value is not None and 1 <= value <= 288 else None


# ---------- connectors ----------


def _one_way_routes(
    features: Sequence[DesignFeatureDraft], rules: MappingRules
) -> list[DesignFeatureDraft]:
    return [f for f in features if f.is_route and rules.ways.get(f.layer) == 1]


def _connectors(
    one_way: Sequence[DesignFeatureDraft],
    features: Sequence[DesignFeatureDraft],
    rules: MappingRules,
) -> dict[FeatureKey, int]:
    """1way route -> ends lying on a route of another known ways (0, 1 or 2)."""
    bundles = [
        f
        for f in features
        if f.is_route and rules.ways.get(f.layer) not in (None, 1) and len(f.coords) >= 2
    ]
    if not bundles:
        return {}
    geoms = [LineString(f.coords) for f in bundles]
    tree = STRtree(geoms)
    out: dict[FeatureKey, int] = {}
    for f in one_way:
        n = 0
        for end in (f.coords[0], f.coords[-1]):
            hits = tree.query(Point(end), predicate="dwithin", distance=CONNECTOR_TOUCH_M)
            n += 1 if len(hits) else 0
        if n:
            out[f.key] = n
    return out


# ---------- zones ----------


def _zone_groups(
    curves: Sequence[SourceCurve], rules: MappingRules, place: Placer
) -> list[ZoneGroup]:
    zone_layers = rules.layers_with("zone")
    items = [
        (c.handle, [place.to_project(p) for p in c.points])
        for c in curves
        if c.layer in zone_layers and c.points
    ]
    if not items:
        return []
    # Stacked copies of one curve are one shape (same group, same hull).
    unique: dict[tuple[Xy, ...], int] = {}
    shape_of = [unique.setdefault(tuple(pts), len(unique)) for _, pts in items]
    shapes = list(unique)
    # Two curves touch when two of their segments do; segments have small envelopes, so nested or
    # overlapping zone lines are not compared all against all.
    pieces: list[Point | LineString] = []
    owner: list[int] = []
    for n, pts in enumerate(shapes):
        if len(pts) < 2:
            pieces.append(Point(pts[0]))
            owner.append(n)
            continue
        for p, q in pairwise(pts):
            pieces.append(LineString((p, q)))
            owner.append(n)
    tree = STRtree(pieces)
    parent = list(range(len(shapes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    left, right = tree.query(pieces, predicate="dwithin", distance=ZONE_TOUCH_M)
    owners = np.asarray(owner, dtype=np.int64)
    first, second = owners[left], owners[right]
    touching = np.unique(np.stack((first, second), axis=1)[first < second], axis=0)
    for i, j in touching.tolist():
        a, b = find(i), find(j)
        if a != b:
            parent[b] = a
    handles: dict[int, str] = {}
    for (handle, _), shape in zip(items, shape_of, strict=True):
        root = find(shape)
        if root not in handles or handle < handles[root]:
            handles[root] = handle
    groups: dict[int, list[int]] = {}
    for shape in range(len(shapes)):
        groups.setdefault(find(shape), []).append(shape)
    out: list[ZoneGroup] = []
    for root, members in groups.items():
        hull = MultiPoint([p for m in members for p in shapes[m]]).convex_hull
        polygon = hull if isinstance(hull, Polygon) and hull.area > 0 else None
        out.append(ZoneGroup(handles[root], polygon, polygon.area if polygon is not None else 0.0))
    return sorted(out, key=lambda z: z.handle)


class _ZoneIndex:
    """The zone hulls, smallest first (area, then handle), in an STRtree; `of` = the smallest
    hull covering a point. Hulls are tried smallest first and the first covering one wins, so
    nested zones are not all tested."""

    def __init__(self, zones: Sequence[ZoneGroup]) -> None:
        self.zones = sorted(
            (z for z in zones if z.hull is not None), key=lambda z: (z.area, z.handle)
        )
        self.hulls: NDArray[np.object_] = np.empty(len(self.zones), dtype=object)
        self.hulls[:] = [z.hull for z in self.zones]
        shapely.prepare(self.hulls)
        self.tree = STRtree(self.hulls) if self.zones else None

    def of(self, position: Xy) -> ZoneGroup | None:
        if self.tree is None:
            return None
        point = Point(position)
        candidates: NDArray[np.intp] = np.sort(self.tree.query(point))
        for start in range(0, len(candidates), _ZONE_BATCH):
            batch = candidates[start : start + _ZONE_BATCH]
            covered = np.flatnonzero(shapely.covers(self.hulls[batch], point))
            if len(covered):
                return self.zones[int(batch[covered[0]])]
        return None


_ZONE_BATCH = 32


# ---------- totals (`counts.reading`) ----------


def _m3(value: Decimal) -> str:
    return format(value.quantize(_MILLI), "f")


@dataclass(slots=True)
class _Sum:
    count: int = 0
    length: Decimal = Decimal(0)
    without_length: int = 0

    def add(self, length: object) -> None:
        self.count += 1
        if isinstance(length, str):
            self.length += Decimal(length)
        else:
            self.without_length += 1


def _opt_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _opt_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def reading_totals(reading: Reading, features: Sequence[DesignFeatureDraft]) -> dict[str, object]:
    """`ReadingTotalsSchema`: bundles per ways / duct size (Σ written length), connectors, spares
    and end caps per size, cables per cores, handholes per type."""
    bundles: dict[tuple[int | None, str | None], _Sum] = {}
    connectors: Counter[str | None] = Counter()
    spares: Counter[str] = Counter()
    cables: dict[int, _Sum] = {}
    handholes: Counter[str | None] = Counter()
    for f in features:
        r = reading.reading_of(f.key)
        if f.is_route:
            ways, duct = _opt_int(r.get("ways")), _opt_str(r.get("ductSize"))
            bundles.setdefault((ways, duct), _Sum()).add(r.get("writtenLengthM"))
            connectors[duct] += _opt_int(r.get("connectors")) or 0
            for spare in _list(r.get("spares")):
                spares[str(spare["ductSize"])] += _opt_int(spare["count"]) or 0
            cores = _opt_int(r.get("cableCores"))
            if cores is not None:
                cables.setdefault(cores, _Sum()).add(r.get("cableLengthM"))
        elif f.feature_type == "hhi":
            handholes[_opt_str(r.get("type"))] += 1
    type_order: dict[str, int] = {t: i for i, t in enumerate(HANDHOLE_TYPES)}
    return {
        "drawingKind": reading.drawing_kind,
        "bundles": [
            {
                "ways": ways,
                "ductSize": duct,
                "count": total.count,
                "writtenLengthM": _m3(total.length),
                "withoutLength": total.without_length,
            }
            for (ways, duct), total in sorted(
                bundles.items(),
                key=lambda kv: (kv[0][0] is None, kv[0][0] or 0, kv[0][1] is None, kv[0][1] or ""),
            )
        ],
        "connectors": [
            {"ductSize": duct, "count": n}
            for duct, n in sorted(connectors.items(), key=lambda kv: (kv[0] is None, kv[0] or ""))
            if n
        ],
        "spares": [
            {"ductSize": duct, "singles": n, "endCaps": END_CAPS_PER_SPARE * n}
            for duct, n in sorted(spares.items())
            if n
        ],
        "cables": [
            {"cores": cores, "count": total.count, "writtenLengthM": _m3(total.length)}
            for cores, total in sorted(cables.items())
        ],
        "handholes": [
            {"type": hh_type, "count": n}
            for hh_type, n in sorted(
                handholes.items(),
                key=lambda kv: (kv[0] is None, type_order.get(kv[0] or "", 0)),
            )
        ],
    }


def _list(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, Mapping)]


def role_text_layers(rules: MappingRules, role: TextRole) -> list[str]:
    """Layers carrying a role, sorted (the `suggestedLayer` of a missing text)."""
    return sorted(layer for layer, roles in rules.text_roles.items() if role in roles)
