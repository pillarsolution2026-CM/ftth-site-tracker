"""Drawing problems found while a revision is built (ADR-033, ADR-034). Pure; metres.

Mirror of `packages/shared/src/design/drawing-problems.ts` (codes, severities, item shape). The
build never stops for a problem: each one names where it is (revision and drawing coordinates,
the nearest named item) so the user can fix the drawing or ignore it on their own responsibility.

Labels: the readable texts on the layers mapped to a feature type are that type's labels. Each
label is paired with at most one symbol of the type, nearest pairs first, within the text-link
radius (ADR-019). Counting is by symbol; labels only name and check them.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from cad_worker.domain.design import POINT_FEATURE_TYPES, DesignFeatureDraft, FeatureKey
from cad_worker.domain.design_build import MappingRules, SourceText
from cad_worker.domain.placement import Placer
from cad_worker.domain.text_links import link_radius_m

ProblemCode = Literal[
    "ROUTE_SPLIT",
    "RING_LABEL_MISMATCH",
    "WRONG_LAYER",
    "LABEL_MISSING",
    "LABEL_TYPE_MISMATCH",
    "LABEL_LENGTH_MISSING",
]
PROBLEM_CODES: tuple[ProblemCode, ...] = (
    "ROUTE_SPLIT",
    "RING_LABEL_MISMATCH",
    "WRONG_LAYER",
    "LABEL_MISSING",
    "LABEL_TYPE_MISMATCH",
    "LABEL_LENGTH_MISSING",
)
SEVERITY: Mapping[ProblemCode, str] = {
    "ROUTE_SPLIT": "warning",
    "RING_LABEL_MISMATCH": "warning",
    "WRONG_LAYER": "warning",
    "LABEL_MISSING": "warning",
    "LABEL_TYPE_MISMATCH": "error",
    "LABEL_LENGTH_MISSING": "info",
}
MAX_PROBLEM_ITEMS = 500

# Technical tuning, not business rules: route ends closer than this meet; an item this close to
# a meeting point explains it (the route is cut at a symbol on purpose).
ROUTE_END_TOUCH_M = 0.05
ROUTE_NODE_ITEM_M = 1.0

_NUMBER = re.compile(r"[0-9]+")
_TYPE_WITHOUT_LENGTH = re.compile(r"[0-9]+\s*x\s*[0-9]+\s*(?:core|way)", re.IGNORECASE)
_LENGTH_FIRST = re.compile(r"^\s*[0-9]+(?:\.[0-9]+)?\s*m\b", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class Label:
    handle: str
    layer: str
    position: tuple[float, float]  # metres
    radius_m: float
    text: str


@dataclass(frozen=True, slots=True)
class ProblemItem:
    position: tuple[float, float]  # metres (revision CRS)
    layer: str
    handle: str
    suggested_layer: str | None = None
    text: str | None = None


@dataclass(frozen=True, slots=True)
class Named:
    feature: DesignFeatureDraft
    name: str | None


def labels_for(
    texts: Sequence[SourceText], rules: MappingRules, place: Placer
) -> dict[str, list[Label]]:
    """Feature type -> readable texts on the layers mapped to it (text-rule texts excluded)."""
    out: dict[str, list[Label]] = {}
    for t in texts:
        target = rules.layers.get(t.layer)
        if target not in POINT_FEATURE_TYPES or not t.readable or not t.text.strip():
            continue
        if rules.text_rule(t.layer, t.text) is not None:
            continue
        out.setdefault(target, []).append(
            Label(
                t.handle,
                t.layer,
                place.to_project(t.position),
                link_radius_m(abs(t.height) * place.unit_m),
                t.text.strip(),
            )
        )
    return out


def pair_labels(
    features: Sequence[DesignFeatureDraft], labels: Sequence[Label]
) -> dict[FeatureKey, Label]:
    """One label per symbol and one symbol per label, nearest pairs first, within each label's
    radius. Ties are broken by handles so the result never depends on input order."""
    pairs: list[tuple[float, str, str, int, int]] = []
    for i, f in enumerate(features):
        fx, fy = f.coords[0]
        for j, label in enumerate(labels):
            d = math.hypot(label.position[0] - fx, label.position[1] - fy)
            if d <= label.radius_m:
                pairs.append((d, f.source_handle, label.handle, i, j))
    pairs.sort()
    used_f: set[int] = set()
    used_l: set[int] = set()
    out: dict[FeatureKey, Label] = {}
    for _, _, _, i, j in pairs:
        if i in used_f or j in used_l:
            continue
        used_f.add(i)
        used_l.add(j)
        out[features[i].key] = labels[j]
    return out


def check_drawing(
    features: Sequence[DesignFeatureDraft],
    texts: Sequence[SourceText],
    rules: MappingRules,
    place: Placer,
) -> tuple[dict[ProblemCode, list[ProblemItem]], dict[FeatureKey, str]]:
    """Problems by code, and a display name per labelled point feature (its code or label)."""
    problems: dict[ProblemCode, list[ProblemItem]] = {c: [] for c in PROBLEM_CODES}
    labels = labels_for(texts, rules, place)
    names: dict[FeatureKey, str] = {f.key: f.code for f in features if f.code}
    points = [f for f in features if not f.is_route]
    for feature_type in sorted({f.feature_type for f in points}):
        of_type = [f for f in points if f.feature_type == feature_type]
        pool = labels.get(feature_type, [])
        paired = pair_labels(of_type, pool)
        kinds = {str(f.attrs["kind"]) for f in of_type if f.attrs.get("kind")}
        # A symbol lacks its label only where its own layer carries labels: main cabinets on
        # layer 0 are not compared with the sub cabinets' labels.
        labelled_layers = {label.layer for label in pool}
        for f in of_type:
            label = paired.get(f.key)
            if label is None:
                if f.layer in labelled_layers:
                    code: ProblemCode = (
                        "RING_LABEL_MISMATCH" if feature_type == "ring" else "LABEL_MISSING"
                    )
                    problems[code].append(ProblemItem(f.coords[0], f.layer, f.source_handle))
                continue
            names.setdefault(f.key, label.text)
            if label.layer != f.layer:
                problems["WRONG_LAYER"].append(
                    ProblemItem(label.position, label.layer, label.handle, f.layer, label.text)
                )
            if _kind_mismatch(f, label.text, kinds):
                problems["LABEL_TYPE_MISMATCH"].append(
                    ProblemItem(f.coords[0], f.layer, f.source_handle, None, label.text)
                )
        if feature_type == "ring":
            used = {label.handle for label in paired.values()}
            for label in pool:
                if label.handle not in used:
                    problems["RING_LABEL_MISMATCH"].append(
                        ProblemItem(label.position, label.layer, label.handle, None, label.text)
                    )
    problems["WRONG_LAYER"].extend(_symbols_on_wrong_layer(points, rules))
    problems["ROUTE_SPLIT"].extend(_route_splits(features))
    problems["LABEL_LENGTH_MISSING"].extend(_labels_without_length(texts, rules, place))
    return problems, names


def _kind_mismatch(feature: DesignFeatureDraft, text: str, kinds: set[str]) -> bool:
    """The rule says kind K (e.g. 36); the label names another kind of the same type (144)."""
    kind = feature.attrs.get("kind")
    if not kind:
        return False
    numbers = set(_NUMBER.findall(text))
    return str(kind) not in numbers and bool(numbers & (kinds - {str(kind)}))


def _symbols_on_wrong_layer(
    points: Sequence[DesignFeatureDraft], rules: MappingRules
) -> list[ProblemItem]:
    """A symbol made by a block or text rule on a layer other than the layer(s) mapped to the same
    type, role, status and kind (e.g. sub cabinets drawn on layer `Sap`)."""
    homes: dict[tuple[object, ...], list[str]] = {}
    for layer, target in rules.layers.items():
        if target in POINT_FEATURE_TYPES:
            a = rules.attrs_of(("layer", layer))
            homes.setdefault((target, a.role, a.status or "new", a.kind), []).append(layer)
    out: list[ProblemItem] = []
    for f in points:
        if f.source_kind == "curve" or rules.layers.get(f.layer) == f.feature_type:
            continue
        key = (
            f.feature_type,
            f.attrs.get("role"),
            f.attrs.get("status", "new"),
            f.attrs.get("kind"),
        )
        layers = homes.get(key)
        if layers and f.layer not in layers:
            out.append(ProblemItem(f.coords[0], f.layer, f.source_handle, sorted(layers)[0]))
    return out


def _route_splits(features: Sequence[DesignFeatureDraft]) -> list[ProblemItem]:
    """Two routes of one layer meeting end to end, with no other route end and no symbol there.

    Ends within ROUTE_END_TOUCH_M of each other meet. A grid only finds candidates (this cell and
    its neighbours): ends close together but on either side of a cell line still meet."""
    step = ROUTE_END_TOUCH_M
    End = tuple[DesignFeatureDraft, tuple[float, float]]
    ends: list[End] = []
    grid: dict[tuple[str, int, int], list[int]] = {}
    for f in features:
        if not f.is_route or len(f.coords) < 2:
            continue
        for p in (f.coords[0], f.coords[-1]):
            grid.setdefault((f.layer, math.floor(p[0] / step), math.floor(p[1] / step)), []).append(
                len(ends)
            )
            ends.append((f, p))
    # Union-find over ends that touch.
    parent = list(range(len(ends)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (f, p) in enumerate(ends):
        cx, cy = math.floor(p[0] / step), math.floor(p[1] / step)
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for j in grid.get((f.layer, gx, gy), ()):
                    if j > i and math.dist(p, ends[j][1]) <= step:
                        parent[find(j)] = find(i)
    nodes: dict[int, list[End]] = {}
    for i, end in enumerate(ends):
        nodes.setdefault(find(i), []).append(end)
    points = [f for f in features if not f.is_route]
    out: list[ProblemItem] = []
    for hits in sorted(nodes.values(), key=lambda h: (h[0][0].layer, min(e[1] for e in h))):
        layer = hits[0][0].layer
        if len(hits) != 2 or hits[0][0].key == hits[1][0].key:
            continue
        p = hits[0][1]
        if any(math.dist(p, s.coords[0]) <= ROUTE_NODE_ITEM_M for s in points):
            continue
        # The place is named by the two lines that meet there: one line broken at both ends has
        # two places, and each must be ignorable on its own.
        pair = "/".join(sorted(h[0].source_handle for h in hits))
        out.append(ProblemItem(p, layer, pair))
    return out


def _labels_without_length(
    texts: Sequence[SourceText], rules: MappingRules, place: Placer
) -> list[ProblemItem]:
    """Cable / duct labels (`1x 144 core cable`, `1x4 way`) that do not start with a length."""
    label_layers = rules.layers_with("label", "route")
    out: list[ProblemItem] = []
    for t in texts:
        if t.layer not in label_layers or not t.readable:
            continue
        value = t.text.strip()
        if _TYPE_WITHOUT_LENGTH.search(value) and not _LENGTH_FIRST.match(value):
            position = place.to_project(t.position)
            out.append(ProblemItem(position, t.layer, t.handle, None, value))
    return out


def nearest_named(
    position: tuple[float, float],
    features: Sequence[DesignFeatureDraft],
    names: Mapping[FeatureKey, str],
    skip_handle: str | None = None,
) -> Named | None:
    """The nearest point feature, preferring named ones (within 3x the distance)."""
    best: tuple[float, DesignFeatureDraft] | None = None
    best_named: tuple[float, DesignFeatureDraft] | None = None
    for f in features:
        if f.is_route or f.source_handle == skip_handle:
            continue
        d = math.dist(position, f.coords[0])
        if best is None or d < best[0]:
            best = (d, f)
        if f.key in names and (best_named is None or d < best_named[0]):
            best_named = (d, f)
    if best is None:
        return None
    if best_named is not None and best_named[0] <= max(3 * best[0], 1.0):
        best = best_named
    return Named(best[1], names.get(best[1].key))


def problems_json(
    problems: Mapping[ProblemCode, Sequence[ProblemItem]],
    features: Sequence[DesignFeatureDraft],
    names: Mapping[FeatureKey, str],
    place: Placer,
) -> list[dict[str, object]]:
    """`design_revisions.warnings` entries for the problems (shape: `DrawingProblemSchema`)."""
    out: list[dict[str, object]] = []
    for code in PROBLEM_CODES:
        items = sorted(problems.get(code, ()), key=lambda i: (i.layer, i.position, i.handle))
        if not items:
            continue
        out.append(
            {
                "code": code,
                "severity": SEVERITY[code],
                "count": len(items),
                "items": [_item_json(i, features, names, place) for i in items[:MAX_PROBLEM_ITEMS]],
            }
        )
    return out


def _item_json(
    item: ProblemItem,
    features: Sequence[DesignFeatureDraft],
    names: Mapping[FeatureKey, str],
    place: Placer,
) -> dict[str, object]:
    near = nearest_named(item.position, features, names, skip_handle=item.handle)
    drawing = place.to_drawing(item.position)
    return {
        "x": round(item.position[0], 3),
        "y": round(item.position[1], 3),
        "drawingX": round(drawing[0], 3),
        "drawingY": round(drawing[1], 3),
        "layer": item.layer,
        "handle": item.handle,
        "suggestedLayer": item.suggested_layer,
        "text": item.text,
        "near": None
        if near is None
        else {
            "type": near.feature.feature_type,
            "name": near.name,
            "layer": near.feature.layer,
            "distanceM": round(math.dist(item.position, near.feature.coords[0]), 2),
        },
    }


def problem_counts(problems: Mapping[ProblemCode, Sequence[ProblemItem]]) -> Counter[str]:
    return Counter({code: len(items) for code, items in problems.items() if items})
