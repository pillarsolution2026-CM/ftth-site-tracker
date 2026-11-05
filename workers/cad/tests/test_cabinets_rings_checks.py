"""Cabinets, rings, shape-drawn symbols, rule attributes and drawing problems (ADR-033, ADR-034)."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from cad_worker.application.build_revision import compose_design, feature_groups
from cad_worker.domain.design_build import (
    DrawingData,
    MappingInvalidError,
    SourceCurve,
    SourceInsert,
    SourceText,
    build_features,
    parse_rules,
)
from cad_worker.domain.drawing_checks import check_drawing
from cad_worker.domain.placement import unit_placer

METRE = Decimal("1")


def square(handle: str, layer: str, x: float, y: float, size: float = 2.0) -> SourceCurve:
    pts = ((x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y))
    return SourceCurve(handle, layer, pts, True, "HATCH")


def label(handle: str, layer: str, value: str, xy: tuple[float, float]) -> SourceText:
    return SourceText(handle, layer, xy, 2.0, value, value, True)


def insert(handle: str, layer: str, block: str, xy: tuple[float, float]) -> SourceInsert:
    return SourceInsert(handle, layer, block, xy)


# Rabaa-like rules: joint 144 / 36 layers, sub cabinets on their layer, `Sap` = sub cabinets drawn
# on another layer, main cabinets by block, new and existing handholes, two duct kinds, cable data.
RULES = parse_rules(
    [
        {"source": "layer", "layer": "jont 144", "target": "joint", "kind": "144"},
        {"source": "layer", "layer": "jont 36", "target": "joint", "kind": "36"},
        {"source": "layer", "layer": "SUB", "target": "cabinet", "role": "sub"},
        {"source": "block", "block": "Sap", "target": "cabinet", "role": "sub"},
        {"source": "block", "block": "Main Cab", "target": "cabinet", "role": "main"},
        {"source": "layer", "layer": "HH NEW", "target": "hhi", "status": "new"},
        {"source": "layer", "layer": "HH OLD", "target": "hhi", "status": "existing"},
        {"source": "layer", "layer": "DUCT 4", "target": "route", "kind": "4 way"},
        {"source": "layer", "layer": "DUCT 2", "target": "route", "kind": "2 way"},
        {"source": "layer", "layer": "CABLE DATA", "target": "label"},
        {"source": "layer", "layer": "RING", "target": "ring"},
    ]
)


@pytest.mark.parametrize(
    "rule",
    [
        {"source": "layer", "layer": "a", "target": "cabinet"},  # role required
        {"source": "layer", "layer": "a", "target": "cabinet", "role": "zone"},
        {"source": "layer", "layer": "a", "target": "box", "role": "main"},  # cabinet only
        {"source": "layer", "layer": "a", "target": "label", "kind": "x"},  # feature rules only
        {"source": "layer", "layer": "a", "target": "hhi", "status": "old"},
        {"source": "layer", "layer": "a", "target": "route", "kind": "  "},
        {"source": "block", "block": "b", "target": "background", "status": "new"},
    ],
)
def test_invalid_rule_attributes(rule: dict[str, object]) -> None:
    with pytest.raises(MappingInvalidError):
        parse_rules([rule])


def test_rule_attributes_land_on_features() -> None:
    drawing = DrawingData(
        curves=(
            SourceCurve("r1", "DUCT 4", ((0, 0), (100, 0))),
            SourceCurve("r2", "DUCT 2", ((0, 10), (30, 10))),
        ),
        inserts=(
            insert("m1", "0", "Main Cab", (5, 5)),
            insert("s1", "SUB", "Sub Cab", (50, 50)),
            insert("h1", "HH NEW", "New HH", (10, 0)),
            insert("h2", "HH OLD", "Old HH", (20, 0)),
        ),
        texts=(),
    )
    built = build_features(drawing, RULES, unit_placer(1.0))
    attrs = {f.source_handle: (f.feature_type, dict(f.attrs)) for f in built.features}
    assert attrs["r1"] == ("route", {"kind": "4 way"})
    assert attrs["m1"] == ("cabinet", {"role": "main"})
    assert attrs["s1"] == ("cabinet", {"role": "sub"})
    assert attrs["h1"] == ("hhi", {"status": "new"})
    assert attrs["h2"] == ("hhi", {"status": "existing"})
    groups = {
        (g["type"], g["kind"], g["role"], g["status"]): (g["count"], g["lengthM"])
        for g in feature_groups(built.features)
    }
    assert groups[("route", "4 way", None, "new")] == (1, "100.000")
    assert groups[("route", "2 way", None, "new")] == (1, "30.000")
    assert groups[("cabinet", None, "main", "new")] == (1, None)
    assert groups[("hhi", None, None, "existing")] == (1, None)


def test_closed_shapes_on_a_point_layer_are_symbols_and_touching_ones_are_one() -> None:
    drawing = DrawingData(
        curves=(
            square("a", "jont 144", 0, 0),
            square("b", "jont 144", 2.03, 0),  # touches a (3 cm gap)
            square("c", "jont 144", 50, 50),
            SourceCurve("open", "jont 144", ((0, 0), (5, 5))),  # not closed: ignored
        ),
        inserts=(),
        texts=(),
    )
    joints = sorted(
        build_features(drawing, RULES, unit_placer(1.0)).features, key=lambda f: f.source_handle
    )
    assert [f.source_handle for f in joints] == ["a", "c"]
    assert joints[0].coords[0] == pytest.approx((2.015, 1.0))
    assert joints[1].coords[0] == pytest.approx((51.0, 51.0))
    assert dict(joints[0].attrs) == {"kind": "144", "shapes": ["a", "b"]}


def _problems(drawing: DrawingData) -> dict[str, list[tuple[str, str | None, str | None]]]:
    built = build_features(drawing, RULES, unit_placer(1.0))
    found, _ = check_drawing(built.features, drawing.texts, RULES, unit_placer(1.0))
    return {
        code: [(i.handle, i.suggested_layer, i.text) for i in items]
        for code, items in found.items()
        if items
    }


def test_rabaa_like_problems_are_found_with_their_places() -> None:
    drawing = DrawingData(
        curves=(
            square("j1", "jont 144", 0, 0),
            square("j2", "jont 144", 100, 0),  # its label sits on the 36 layer
            square("j3", "jont 144", 200, 0),  # no label at all
            SourceCurve("d1", "DUCT 4", ((0, 50), (40, 50))),
            SourceCurve("d2", "DUCT 4", ((40, 50), (90, 50))),  # end to end with d1: split
        ),
        inserts=(
            insert("k1", "jont 36", "JONT 36", (300, 0)),  # rule says 36, label says 144
            insert("sap1", "Sap", "Sap", (400, 0)),  # sub cabinet on another layer
            insert("s1", "SUB", "Sub Cab", (500, 0)),
        ),
        texts=(
            label("t1", "jont 144", "J  144 F", (3, 3)),
            label("t2", "jont 36", "Joint 144", (103, 3)),
            label("t3", "jont 36", "Joint 144", (303, 3)),
            label("c1", "CABLE DATA", "1x 144 core cable", (0, 60)),
            label("c2", "CABLE DATA", "500m/1x 36 core cable", (0, 70)),
        ),
    )
    assert _problems(drawing) == {
        "WRONG_LAYER": [("t2", "jont 144", "Joint 144"), ("sap1", "SUB", None)],
        "LABEL_MISSING": [("j3", None, None)],
        "LABEL_TYPE_MISMATCH": [("k1", None, "Joint 144")],
        "ROUTE_SPLIT": [("d1/d2", None, None)],
        "LABEL_LENGTH_MISSING": [("c1", None, "1x 144 core cable")],
    }


def test_a_clean_drawing_has_no_problems() -> None:
    drawing = DrawingData(
        curves=(square("j1", "jont 144", 0, 0), SourceCurve("d1", "DUCT 4", ((0, 50), (90, 50)))),
        inserts=(insert("k1", "jont 144", "JONT 36", (300, 0)), insert("s1", "SUB", "Sap", (9, 9))),
        texts=(
            label("t1", "jont 144", "J  144 F", (3, 3)),
            label("t3", "jont 144", "Joint 144", (303, 3)),
        ),
    )
    assert _problems(drawing) == {}


def test_a_route_cut_at_a_symbol_is_not_a_split() -> None:
    drawing = DrawingData(
        curves=(
            SourceCurve("d1", "DUCT 4", ((0, 0), (40, 0))),
            SourceCurve("d2", "DUCT 4", ((40, 0), (90, 0))),
        ),
        inserts=(insert("h1", "HH NEW", "New HH", (40.5, 0)),),
        texts=(),
    )
    assert "ROUTE_SPLIT" not in _problems(drawing)


def test_rings_without_labels_and_labels_without_rings() -> None:
    drawing = DrawingData(
        curves=(square("r1", "RING", 0, 0), square("r2", "RING", 100, 0)),
        inserts=(),
        texts=(label("l1", "RING", "R1", (2, 2)), label("l9", "RING", "R9", (500, 500))),
    )
    assert _problems(drawing) == {"RING_LABEL_MISMATCH": [("r2", None, None), ("l9", None, "R9")]}


def test_problems_and_groups_reach_the_revision_summary() -> None:
    drawing = DrawingData(
        curves=(square("j1", "jont 144", 0, 0), square("j3", "jont 144", 200, 0)),
        inserts=(),
        texts=(label("t1", "jont 144", "J  144 F", (3, 3)),),
    )
    design = compose_design(drawing, RULES, unit_placer(1.0), (), uuid.uuid4)
    assert design.groups == [
        {
            "type": "joint",
            "kind": "144",
            "role": None,
            "status": "new",
            "count": 2,
            "lengthM": None,
        }
    ]
    [problem] = design.problems
    assert problem["code"] == "LABEL_MISSING" and problem["severity"] == "warning"
    items = problem["items"]
    assert isinstance(items, list) and len(items) == 1
    item: dict[str, object] = items[0]
    assert item["handle"] == "j3" and (item["x"], item["y"]) == (201.0, 1.0)
    assert item["near"] == {"type": "joint", "name": "J  144 F", "layer": "jont 144",
                            "distanceM": 200.0}  # fmt: skip


def test_each_split_place_has_its_own_id_even_on_one_line() -> None:
    """A line broken at both ends gave two ROUTE_SPLIT places the same id (the line's handle), so
    ignoring one ignored both (found on staging with Rabaa, line 15049)."""
    drawing = DrawingData(
        curves=(
            SourceCurve("a", "DUCT 4", ((0, 0), (40, 0))),
            SourceCurve("m", "DUCT 4", ((40, 0), (80, 0))),  # split at both of its ends
            SourceCurve("b", "DUCT 4", ((80, 0), (120, 0))),
        ),
        inserts=(),
        texts=(),
    )
    places = _problems(drawing)["ROUTE_SPLIT"]
    assert len(places) == 2
    assert len({handle for handle, _, _ in places}) == 2
    assert sorted(handle for handle, _, _ in places) == ["a/m", "b/m"]


def test_route_ends_on_either_side_of_a_grid_line_still_meet() -> None:
    """Ends 2 mm apart fell into neighbouring cells of the 5 cm grid, so a junction of three routes
    looked like a split of two (Rabaa in UTM: 58 places instead of 57)."""
    drawing = DrawingData(
        curves=(
            SourceCurve("a", "DUCT 4", ((-40, 0), (0.024, 0))),
            SourceCurve("b", "DUCT 4", ((0.026, 0), (40, 0))),
            SourceCurve("c", "DUCT 4", ((0.025, 0.001), (0.025, 40))),
        ),
        inserts=(),
        texts=(),
    )
    assert "ROUTE_SPLIT" not in _problems(drawing)
