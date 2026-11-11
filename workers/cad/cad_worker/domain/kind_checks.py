"""The ADR-040 checks of the General and the Secondary (ADR-041, part F). Pure; metres.

Run in `roles` reading mode only, from what `role_reading.py` read; every Phase-1 check of
`drawing_checks.py` still runs next to them. Codes, severities and `params` mirror
`packages/shared/src/design/drawing-problems.ts`. The place `handle` is the text to fix for
problems fixed by editing a text, else the symbol; `params.featureHandle` names the other one.

| code | kind | place |
| LABEL_TYPE_MISMATCH (route) | both | bundle type text (labelWays ≠ rule ways) |
| LABEL_MISSING (roles) | both | symbol: box cabinet / number / cable type / cable length, hhi
|   number, sub cabinet name (+ box count in a Secondary), route on a `ways` layer: bundle label
|   (+ cable label in a General) |
| LABEL_LENGTH_MISSING (roles) | both | bundle type text without length, cable text without length |
| HANDHOLE_TYPE_MISSING / _UNKNOWN / _NOT_DRAWN | general | symbol / type text / number text |
| BOX_NUMBER_DUPLICATE / BOX_NOT_REACHED | secondary | number text / symbol |
| BOX_CABINET_UNKNOWN | secondary | box cabinet text naming no cabinet of the drawing |
| CABINET_BOX_COUNT_MISMATCH / CABINET_ZONE_MISSING | secondary | «nB» text / symbol |
| CABINET_NAME_DUPLICATE | both | name text of each cabinet sharing a `cabinetNameKey` |
| CONNECTOR_SIZE_MISSING | secondary | 1way bundle type text with no duct size |
| SPARE_CORES_MISMATCH / CABLE_SLACK_TOO_SHORT / _TOO_LONG | general | SP text / cable text |

A required role text is only asked for when the drawing kind reads that role
(`TEXT_ROLES_BY_KIND`): a General has no box numbers to write. A feature missing several texts has
one LABEL_MISSING place (the place key is code + handle), for the first missing one in `_needs`
order (identity first); the next one shows once that one is written.

Owner answers to the ADR-041 questions (2026-11-11), «anything unclear is an error»:
- Q2: a handhole type the PM confirmed (`handholeTypeAliases`) is read as its list type
  (`role_reading.role_texts`), so it is no HANDHOLE_TYPE_UNKNOWN.
- Q3: a route with no bundle TYPE text is LABEL_MISSING (bundle_label), also when a length-only
  text is linked to it; a route with a type text but no length stays LABEL_LENGTH_MISSING on that
  text. The two never name the same route.
- Q4: «SP n» is checked against its own main cable (`_spare_cores`).
- Q5-Q7: BOX_CABINET_UNKNOWN, the box count / box cable LABEL_MISSING, CABINET_NAME_DUPLICATE,
  box numbers compared without leading zeros.
- Q8: a 1way with no bundle label at all is LABEL_MISSING, not CONNECTOR_SIZE_MISSING.
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from decimal import Decimal

from shapely import STRtree
from shapely.geometry import LineString, Point

from cad_worker.domain.design import DesignFeatureDraft, Xy
from cad_worker.domain.design_build import MappingRules
from cad_worker.domain.drawing_checks import PROBLEM_CODES, ProblemCode, ProblemItem
from cad_worker.domain.role_reading import (
    BOX_REACH_M,
    CONNECTOR_TOUCH_M,
    FeatureTexts,
    Reading,
    RoleText,
    role_text_layers,
)
from cad_worker.domain.text_roles import (
    TEXT_ROLES_BY_KIND,
    CabinetInfoField,
    DrawingKind,
    TextRole,
    cabinet_name_key,
)

# Owner thresholds (ADR-040), metres, compared as decimals; 15 and 30 themselves pass.
CABLE_SLACK_MIN_M = Decimal("15")
CABLE_SLACK_WARN_ABOVE_M = Decimal("30")
_MILLI = Decimal("0.001")
# Technical tolerances of the cable network (owner answer Q4), set on the Al-Fath General: pieces
# of one network meet where an end lies on another route (as a connector), or where their ends lie
# near one joint / handhole symbol (the Al-Fath main is cut at handhole 04B and its pieces end
# 3.4-4.8 m from the symbol; route ends elsewhere are 50 m or more from any symbol).
CABLE_TOUCH_M = CONNECTOR_TOUCH_M
NODE_REACH_M = 6.0
_NODE_TYPES = frozenset({"joint", "hhi", "mh"})

# A role text a feature needs: (role, cabinet_info field, the slot it fills on the feature).
_Need = tuple[TextRole, CabinetInfoField | None, str]
_BOX_NEEDS: tuple[_Need, ...] = (
    ("box_cabinet", None, "box_cabinet"),
    ("box_number", None, "box_number"),
    ("box_cable_type", None, "box_cable_type"),
    ("box_cable_length", None, "box_cable_length"),
)
_ROUTE_NEEDS: tuple[_Need, ...] = (
    ("bundle_label", None, "bundle_label:type"),
    ("cable_label", None, "cable_label"),
)
_CABINET_NAME: _Need = ("cabinet_info", "name", "cabinet_info:name")
_CABINET_BOX_COUNT: _Need = ("cabinet_info", "box_count", "cabinet_info:box_count")

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
            _route_labels(f, ft, reading, rules, problems)
        missing = _missing_role(f, ft, roles, kind, rules)
        if missing is not None and f.source_handle not in phase1_missing:
            role, info_field, _ = missing
            layers = role_text_layers(rules, role)
            params: dict[str, object] = {"role": role}
            if info_field is not None:
                params["field"] = info_field
            if info_field == "box_count":
                drawn = reading.reading_of(f.key).get("boxesDrawn")
                params["suggested"] = str(drawn if isinstance(drawn, int) else 0)
            problems["LABEL_MISSING"].append(
                ProblemItem(
                    _place_of(f),
                    f.layer,
                    f.source_handle,
                    layers[0] if layers else None,
                    None,
                    params,
                )
            )
    _unpaired_cable_lengths(reading, problems)
    _cabinet_names(features, reading, problems)
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


def _place_of(f: DesignFeatureDraft) -> Xy:
    """A symbol's point; a route's middle (half its drawn length)."""
    if not f.is_route or len(f.coords) < 2:
        return f.coords[0]
    middle = LineString(f.coords).interpolate(0.5, normalized=True)
    return (float(middle.x), float(middle.y))


def _needs(f: DesignFeatureDraft, kind: DrawingKind, rules: MappingRules) -> tuple[_Need, ...]:
    """The role texts a feature needs, identity first. Sub cabinets need a name, and in a Secondary
    their box count; a route on a `ways` layer needs its bundle label and its cable label (read in
    a General only, `TEXT_ROLES_BY_KIND`)."""
    if f.feature_type == "box":
        return _BOX_NEEDS
    if f.feature_type == "hhi":
        return (("handhole_number", None, "handhole_number"),)
    if f.feature_type == "cabinet":
        if f.attrs.get("role") != "sub":
            return ()
        return (_CABINET_NAME, _CABINET_BOX_COUNT) if kind == "secondary" else (_CABINET_NAME,)
    if f.is_route and rules.ways.get(f.layer) is not None:
        return _ROUTE_NEEDS
    return ()


def _missing_role(
    f: DesignFeatureDraft,
    ft: FeatureTexts,
    roles: Sequence[TextRole],
    kind: DrawingKind,
    rules: MappingRules,
) -> _Need | None:
    for need in _needs(f, kind, rules):
        if need[0] in roles and ft.one(need[2]) is None:
            return need
    return None


def _route_labels(
    f: DesignFeatureDraft,
    ft: FeatureTexts,
    reading: Reading,
    rules: MappingRules,
    problems: Problems,
) -> None:
    r = reading.reading_of(f.key)
    label = ft.one("bundle_label:type")
    if label is None:
        return
    if (
        reading.drawing_kind == "secondary"
        and rules.ways.get(f.layer) == 1
        and label.reading.duct_size is None
    ):
        # Owner Q8: the 1way's connectors and end caps take their size from this label.
        problems["CONNECTOR_SIZE_MISSING"].append(
            _text_item(label, {"featureHandle": f.source_handle})
        )
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


def _cabinet_names(
    features: Sequence[DesignFeatureDraft], reading: Reading, problems: Problems
) -> None:
    """Owner Q6: two cabinets (main or sub) with one name; one place per cabinet, on its name."""
    by_name: dict[str, list[tuple[DesignFeatureDraft, RoleText]]] = defaultdict(list)
    for f in features:
        if f.feature_type != "cabinet":
            continue
        name = reading.feature_texts.get(f.key, FeatureTexts()).one("cabinet_info:name")
        if name is not None and name.reading.value:
            by_name[cabinet_name_key(name.reading.value)].append((f, name))
    for key, same in sorted(by_name.items()):
        if len(same) < 2:
            continue
        for f, name in same:
            problems["CABINET_NAME_DUPLICATE"].append(
                _text_item(name, {"cabinet": key, "featureHandle": f.source_handle})
            )


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
    """Owner Q4: «SP n» = its main cable's cores - Σ cores of the branch cables leaving that cable.

    The main cable is the cable of the route the SP text is linked to. Routes form networks
    (`_cable_networks`): a network with one main cable gives it every cable with fewer cores; in a
    network with several main cables (several SP texts on cables of different cores) each route
    goes to the main cable it is fewest route pieces away from (ties: the smaller handle's), and
    each main counts the cables with fewer cores that went to it. Unlabelled pieces carry nothing
    but still connect. A branch of a branch is not told apart: it counts, so the SP check then
    fails and the PM looks at it (anything unclear is an error)."""
    routes = [f for f in features if f.is_route and len(f.coords) >= 2]
    index = {f.key: n for n, f in enumerate(routes)}
    cores: list[int | None] = []
    for f in routes:
        value = reading.reading_of(f.key).get("cableCores")
        cores.append(value if isinstance(value, int) and not isinstance(value, bool) else None)
    spares: list[tuple[RoleText, int]] = []
    for t in reading.texts:
        if t.reading.role != "cable_spare" or t.reading.cores is None:
            continue
        route = reading.text_feature.get(t.handle)
        n = index.get(route) if route is not None else None
        if n is not None and cores[n] is not None:
            spares.append((t, n))
    if not spares:
        return
    neighbours = _cable_networks(routes, [f for f in features if f.feature_type in _NODE_TYPES])
    mains = {cores[n] for _, n in spares}
    sources = sorted(
        (n for n, c in enumerate(cores) if c in mains), key=lambda n: routes[n].source_handle
    )
    owner: dict[int, int] = {n: n for n in sources}
    queue = deque(sources)
    while queue:
        n = queue.popleft()
        for m in neighbours[n]:
            if m not in owner:
                owner[m] = owner[n]
                queue.append(m)
    # Branch cores per (network, main cores): a main cable drawn in several pieces (one label per
    # piece) sums the branches of all its pieces.
    component = _components(neighbours)
    branch_cores: dict[tuple[int, int], int] = defaultdict(int)
    for m, source in owner.items():
        c, main_of = cores[m], cores[source]
        if c is not None and main_of is not None and c < main_of:
            branch_cores[(component[source], main_of)] += c
    for t, n in spares:
        main = cores[n]
        if main is None:
            continue
        branches = branch_cores.get((component[n], main), 0)
        expected = main - branches
        if expected != t.reading.cores:
            problems["SPARE_CORES_MISMATCH"].append(
                _text_item(
                    t,
                    {
                        "expected": str(expected),
                        "found": str(t.reading.cores),
                        "mainCores": main,
                        "featureHandle": routes[n].source_handle,
                    },
                )
            )


def _cable_networks(
    routes: Sequence[DesignFeatureDraft], nodes: Sequence[DesignFeatureDraft]
) -> list[list[int]]:
    """Route -> the routes it meets (sorted): an end within CABLE_TOUCH_M of the other route, or
    ends of both within NODE_REACH_M of one joint / handhole symbol."""
    linked: list[set[int]] = [set() for _ in routes]
    if not routes:
        return []
    tree = STRtree([LineString(f.coords) for f in routes])
    ends = [Point(p) for f in routes for p in (f.coords[0], f.coords[-1])]
    left, right = tree.query(ends, predicate="dwithin", distance=CABLE_TOUCH_M)
    for e, j in zip(left.tolist(), right.tolist(), strict=True):
        i = e // 2
        if i != j:
            linked[i].add(j)
            linked[j].add(i)
    if nodes:
        end_tree = STRtree(ends)
        points = [Point(f.coords[0]) for f in nodes]
        at, hit = end_tree.query(points, predicate="dwithin", distance=NODE_REACH_M)
        meeting: dict[int, set[int]] = defaultdict(set)
        for node, e in zip(at.tolist(), hit.tolist(), strict=True):
            meeting[node].add(e // 2)
        for members in meeting.values():
            for i in members:
                linked[i].update(members - {i})
    return [sorted(s) for s in linked]


def _components(neighbours: Sequence[Sequence[int]]) -> list[int]:
    """Route -> the smallest route index of its network."""
    out = [-1] * len(neighbours)
    for start in range(len(neighbours)):
        if out[start] >= 0:
            continue
        out[start] = start
        queue = deque([start])
        while queue:
            n = queue.popleft()
            for m in neighbours[n]:
                if out[m] < 0:
                    out[m] = start
                    queue.append(m)
    return out


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


def box_number_key(number: str) -> str:
    """Owner Q7: «09» and «9» are one box number (leading zeros dropped; «00» = «0»)."""
    return number.strip().lstrip("0") or "0"


def _boxes(features: Sequence[DesignFeatureDraft], reading: Reading, problems: Problems) -> None:
    boxes = [f for f in features if f.feature_type == "box"]
    cabinets = {
        cabinet_name_key(name)
        for f in features
        if f.feature_type == "cabinet"
        and isinstance(name := reading.reading_of(f.key).get("name"), str)
    }
    by_identity: dict[tuple[str, str], list[tuple[DesignFeatureDraft, str]]] = defaultdict(list)
    for f in boxes:
        r = reading.reading_of(f.key)
        cabinet, number = r.get("cabinet"), r.get("number")
        if isinstance(cabinet, str) and cabinet_name_key(cabinet) not in cabinets:
            text = reading.feature_texts[f.key].one("box_cabinet")
            if text is not None:
                problems["BOX_CABINET_UNKNOWN"].append(
                    _text_item(text, {"cabinet": cabinet, "featureHandle": f.source_handle})
                )
        if isinstance(cabinet, str) and isinstance(number, str):
            key = (cabinet_name_key(cabinet), box_number_key(number))
            by_identity[key].append((f, number.strip()))
    for (cabinet, number), same in sorted(by_identity.items()):
        if len(same) < 2:
            continue
        written = ", ".join(sorted({w for _, w in same}))
        for f, _ in same:
            text = reading.feature_texts[f.key].one("box_number")
            if text is not None:
                problems["BOX_NUMBER_DUPLICATE"].append(
                    _text_item(
                        text,
                        {
                            "cabinet": cabinet,
                            "boxNumber": number,
                            "found": written,
                            "featureHandle": f.source_handle,
                        },
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
