"""The ADR-040 checks of the General and the Secondary (ADR-041, part F). Pure; metres.

Run in `roles` reading mode only, from what `role_reading.py` read; every Phase-1 check of
`drawing_checks.py` still runs next to them. Codes, severities and `params` mirror
`packages/shared/src/design/drawing-problems.ts`. The place `handle` is the text to fix for
problems fixed by editing a text, else the symbol; `params.featureHandle` names the other one.

| code | kind | place |
| LABEL_TYPE_MISMATCH (route) | both | bundle type text (labelWays ≠ rule ways) |
| LABEL_MISSING (roles) | both | symbol: box number / cabinet, hhi number, sub cabinet name |
| LABEL_LENGTH_MISSING (roles) | both | bundle type text without length, cable text without length |
| HANDHOLE_TYPE_MISSING / _UNKNOWN / _NOT_DRAWN | general | symbol / type text / number text |
| BOX_NUMBER_DUPLICATE / BOX_NOT_REACHED | secondary | number text / symbol |
| CABINET_BOX_COUNT_MISMATCH / CABINET_ZONE_MISSING | secondary | «nB» text / symbol |
| SPARE_CORES_MISMATCH / CABLE_SLACK_TOO_SHORT / _TOO_LONG | general | SP text / cable text |

A required role text is only asked for when the drawing kind reads that role
(`TEXT_ROLES_BY_KIND`): a General has no box numbers to write.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from decimal import Decimal

from shapely import STRtree
from shapely.geometry import Point

from cad_worker.domain.design import DesignFeatureDraft, FeatureKey
from cad_worker.domain.design_build import MappingRules
from cad_worker.domain.drawing_checks import PROBLEM_CODES, ProblemCode, ProblemItem
from cad_worker.domain.role_reading import (
    BOX_REACH_M,
    FeatureTexts,
    Reading,
    RoleText,
    role_text_layers,
)
from cad_worker.domain.text_roles import (
    TEXT_ROLES,
    TEXT_ROLES_BY_KIND,
    CabinetInfoField,
    TextRole,
    cabinet_name_key,
)

# Owner thresholds (ADR-040), metres, compared as decimals; 15 and 30 themselves pass.
CABLE_SLACK_MIN_M = Decimal("15")
CABLE_SLACK_WARN_ABOVE_M = Decimal("30")
_MILLI = Decimal("0.001")

# Feature type -> the role texts it needs (+ cabinet_info field); sub cabinets only need a name.
_REQUIRED: Mapping[str, tuple[tuple[TextRole, CabinetInfoField | None], ...]] = {
    "box": (("box_cabinet", None), ("box_number", None)),
    "hhi": (("handhole_number", None),),
    "cabinet": (("cabinet_info", "name"),),
}

Problems = dict[ProblemCode, list[ProblemItem]]


def check_kind(
    features: Sequence[DesignFeatureDraft],
    reading: Reading,
    rules: MappingRules,
    phase1_missing: frozenset[str] = frozenset(),
) -> Problems:
    """The roles-mode problems by code. `phase1_missing`: symbols already named by a Phase-1
    LABEL_MISSING (not reported twice)."""
    problems: Problems = {c: [] for c in PROBLEM_CODES}
    kind = reading.drawing_kind
    roles = TEXT_ROLES_BY_KIND[kind]
    texts = reading.feature_texts
    for f in features:
        ft = texts.get(f.key, FeatureTexts())
        if f.is_route:
            _route_labels(f, ft, reading, problems)
        missing = _missing_role(f, ft, roles)
        if missing is not None and f.source_handle not in phase1_missing:
            role, info_field = missing
            layers = role_text_layers(rules, role)
            params: dict[str, object] = {"role": role}
            if info_field is not None:
                params["field"] = info_field
            problems["LABEL_MISSING"].append(
                ProblemItem(
                    f.coords[0],
                    f.layer,
                    f.source_handle,
                    layers[0] if layers else None,
                    None,
                    params,
                )
            )
    _unpaired_cable_lengths(reading, problems)
    if kind == "general":
        _handholes(features, reading, rules, problems)
        _spare_cores(features, reading, problems)
        _cable_slack(reading, problems)
    else:
        _boxes(features, reading, problems)
        _cabinets(features, reading, problems)
    return problems


def _text_item(t: RoleText, params: Mapping[str, object] | None = None) -> ProblemItem:
    return ProblemItem(t.position, t.layer, t.handle, None, t.text, params)


def _missing_role(
    f: DesignFeatureDraft, ft: FeatureTexts, roles: Sequence[TextRole]
) -> tuple[TextRole, CabinetInfoField | None] | None:
    if f.feature_type == "cabinet" and f.attrs.get("role") != "sub":
        return None
    needed = sorted(
        (r for r in _REQUIRED.get(f.feature_type, ()) if r[0] in roles),
        key=lambda r: TEXT_ROLES.index(r[0]),
    )
    for role, info_field in needed:
        slot = f"{role}:{info_field}" if info_field else role
        if ft.one(slot) is None:
            return role, info_field
    return None


def _route_labels(
    f: DesignFeatureDraft, ft: FeatureTexts, reading: Reading, problems: Problems
) -> None:
    r = reading.reading_of(f.key)
    label = ft.one("bundle_label:type")
    if label is None:
        return
    ways, label_ways = r.get("ways"), r.get("labelWays")
    if ways is not None and label_ways is not None and ways != label_ways:
        problems["LABEL_TYPE_MISMATCH"].append(
            _text_item(
                label,
                {
                    "role": "bundle_label",
                    "expected": str(ways),
                    "found": str(label_ways),
                    "featureHandle": f.source_handle,
                },
            )
        )
    if r.get("writtenLengthM") is None:
        problems["LABEL_LENGTH_MISSING"].append(
            _text_item(label, {"role": "bundle_label", "featureHandle": f.source_handle})
        )


def _unpaired_cable_lengths(reading: Reading, problems: Problems) -> None:
    """Every cable label needs its length («520M/144Core»)."""
    for t in reading.texts:
        if t.reading.role == "cable_label" and t.reading.length_m is None:
            params: dict[str, object] = {"role": "cable_label"}
            feature = reading.text_feature.get(t.handle)
            if feature is not None:
                params["featureHandle"] = feature[1]
            problems["LABEL_LENGTH_MISSING"].append(_text_item(t, params))


# ---------- General ----------


def _handholes(
    features: Sequence[DesignFeatureDraft],
    reading: Reading,
    rules: MappingRules,
    problems: Problems,
) -> None:
    handholes = [f for f in features if f.feature_type == "hhi"]
    type_layers = role_text_layers(rules, "handhole_type")
    for f in handholes:
        kind = reading.feature_texts.get(f.key, FeatureTexts()).one("handhole_type")
        if kind is None:
            problems["HANDHOLE_TYPE_MISSING"].append(
                ProblemItem(
                    f.coords[0],
                    f.layer,
                    f.source_handle,
                    type_layers[0] if type_layers else None,
                    None,
                    {"role": "handhole_type"},
                )
            )
        elif kind.reading.handhole_type is None:
            problems["HANDHOLE_TYPE_UNKNOWN"].append(
                _text_item(
                    kind,
                    {"found": kind.reading.written or kind.text, "featureHandle": f.source_handle},
                )
            )
    hhi_layers = sorted(name for name, t in rules.layers.items() if t == "hhi")
    tree = STRtree([Point(f.coords[0]) for f in handholes]) if handholes else None
    for t in reading.texts:
        if t.reading.role != "handhole_number":
            continue
        near = (
            tree.query(Point(t.position), predicate="dwithin", distance=t.radius_m) if tree else []
        )
        if len(near) == 0:
            problems["HANDHOLE_NOT_DRAWN"].append(
                ProblemItem(
                    t.position,
                    t.layer,
                    t.handle,
                    hhi_layers[0] if hhi_layers else None,
                    t.text,
                    {"role": "handhole_number"},
                )
            )


def _spare_cores(
    features: Sequence[DesignFeatureDraft], reading: Reading, problems: Problems
) -> None:
    """Provisional rule (ADR-041 Q4): main cores = cores of the cable on the route the «SP n»
    text links to; branch cores = Σ cores of the cable labels (one per route) with fewer cores."""
    cores_by_route: dict[FeatureKey, int] = {}
    for f in features:
        cores = reading.reading_of(f.key).get("cableCores")
        if f.is_route and isinstance(cores, int):
            cores_by_route[f.key] = cores
    for t in reading.texts:
        if t.reading.role != "cable_spare" or t.reading.cores is None:
            continue
        route = reading.text_feature.get(t.handle)
        main = cores_by_route.get(route) if route is not None else None
        if route is None or main is None:
            continue
        branches = sum(c for c in cores_by_route.values() if c < main)
        expected = main - branches
        if expected != t.reading.cores:
            problems["SPARE_CORES_MISMATCH"].append(
                _text_item(
                    t,
                    {
                        "expected": str(expected),
                        "found": str(t.reading.cores),
                        "mainCores": main,
                        "featureHandle": route[1],
                    },
                )
            )


def _cable_slack(reading: Reading, problems: Problems) -> None:
    for pair in reading.cable_pairs:
        bundle_m, cable_m = pair.bundle.reading.length_m, pair.cable.reading.length_m
        if bundle_m is None or cable_m is None:
            continue
        slack = Decimal(cable_m) - Decimal(bundle_m)
        code: ProblemCode
        if slack < CABLE_SLACK_MIN_M:
            code = "CABLE_SLACK_TOO_SHORT"
        elif slack > CABLE_SLACK_WARN_ABOVE_M:
            code = "CABLE_SLACK_TOO_LONG"
        else:
            continue
        params: dict[str, object] = {
            "cableLengthM": cable_m,
            "bundleLengthM": bundle_m,
            "slackM": format(slack.quantize(_MILLI), "f"),
        }
        if pair.route is not None:
            params["featureHandle"] = pair.route[1]
        problems[code].append(_text_item(pair.cable, params))


# ---------- Secondary ----------


def _boxes(features: Sequence[DesignFeatureDraft], reading: Reading, problems: Problems) -> None:
    boxes = [f for f in features if f.feature_type == "box"]
    by_identity: dict[tuple[str, str], list[DesignFeatureDraft]] = defaultdict(list)
    for f in boxes:
        r = reading.reading_of(f.key)
        cabinet, number = r.get("cabinet"), r.get("number")
        if isinstance(cabinet, str) and isinstance(number, str):
            by_identity[(cabinet_name_key(cabinet), number.strip())].append(f)
    for (cabinet, number), same in sorted(by_identity.items()):
        if len(same) < 2:
            continue
        for f in same:
            text = reading.feature_texts[f.key].one("box_number")
            if text is not None:
                problems["BOX_NUMBER_DUPLICATE"].append(
                    _text_item(
                        text,
                        {"cabinet": cabinet, "boxNumber": number, "featureHandle": f.source_handle},
                    )
                )
    ends = [Point(p) for p in reading.one_way_ends]
    tree = STRtree(ends) if ends else None
    for f in boxes:
        hits = (
            tree.query(Point(f.coords[0]), predicate="dwithin", distance=BOX_REACH_M)
            if tree
            else []
        )
        if len(hits) == 0:
            problems["BOX_NOT_REACHED"].append(ProblemItem(f.coords[0], f.layer, f.source_handle))


def _cabinets(features: Sequence[DesignFeatureDraft], reading: Reading, problems: Problems) -> None:
    for f in features:
        if f.feature_type != "cabinet":
            continue
        r = reading.reading_of(f.key)
        written, drawn, name = r.get("boxCount"), r.get("boxesDrawn"), r.get("name")
        count_text = reading.feature_texts.get(f.key, FeatureTexts()).one("cabinet_info:box_count")
        if isinstance(written, int) and written != drawn and count_text is not None:
            params: dict[str, object] = {
                "expected": str(written),
                "found": str(drawn),
                "featureHandle": f.source_handle,
            }
            if isinstance(name, str):
                params["cabinet"] = name
            problems["CABINET_BOX_COUNT_MISMATCH"].append(_text_item(count_text, params))
        if r.get("zoneHandle") is None:
            problems["CABINET_ZONE_MISSING"].append(
                ProblemItem(f.coords[0], f.layer, f.source_handle)
            )
