"""Drawing corrections applied before classification and checks (ADR-038). Pure."""

from __future__ import annotations

import time
import uuid
from typing import Any

import pytest

from cad_worker.application.build_revision import compose_design
from cad_worker.domain.corrections import (
    DEFAULT_TEXT_HEIGHT,
    MAX_CORRECTION_COORD,
    AddItem,
    AddText,
    CorrectionInvalidError,
    FrozenCorrection,
    MergeRoutes,
    MoveLayer,
    SetText,
    apply_corrections,
    curve_handles,
    parse_corrections,
)
from cad_worker.domain.design_build import (
    FIX_BLOCK,
    DrawingData,
    SourceAttribute,
    SourceCurve,
    SourceInsert,
    SourceText,
    build_features,
    parse_rules,
)
from cad_worker.domain.drawing_checks import check_drawing
from cad_worker.domain.placement import unit_placer
from tests.test_cabinets_rings_checks import RULES, insert, label, square

ID1 = "11111111-1111-4111-8111-111111111111"
ID2 = "22222222-2222-4222-8222-222222222222"


def line(handle: str, layer: str, *pts: tuple[float, float]) -> SourceCurve:
    return SourceCurve(handle, layer, pts, False, "LWPOLYLINE")


def fix(correction: Any, cid: str = ID1) -> FrozenCorrection:
    return FrozenCorrection(cid, correction)


def apply(drawing: DrawingData, *corrections: Any, unit: float = 1.0) -> DrawingData:
    frozen = [fix(c, str(uuid.UUID(int=i + 1))) for i, c in enumerate(corrections)]
    return apply_corrections(drawing, frozen, metres_per_unit=unit)


def problems(drawing: DrawingData) -> dict[str, list[str]]:
    built = build_features(drawing, RULES, unit_placer(1.0))
    found, _ = check_drawing(built.features, drawing.texts, RULES, unit_placer(1.0))
    return {code: [i.handle for i in items] for code, items in found.items() if items}


def empty(**rows: Any) -> DrawingData:
    return DrawingData(rows.get("curves", ()), rows.get("inserts", ()), rows.get("texts", ()))


# ---------- parsing ----------


def test_parses_every_kind_in_order() -> None:
    raw = [
        {"id": ID1, "correction": {"kind": "move_layer", "handle": "A1", "toLayer": "SUB"}},
        {"id": ID2, "correction": {"kind": "set_text", "handle": "T1", "text": "  Joint 36 "}},
        {
            "id": "33333333-3333-4333-8333-333333333333",
            "correction": {"kind": "add_text", "layer": "L", "x": 1, "y": 2.5, "text": "J"},
        },
        {
            "id": "44444444-4444-4444-8444-444444444444",
            "correction": {
                "kind": "add_text",
                "layer": "L",
                "x": 1,
                "y": 2,
                "text": "J",
                "height": 0.5,
            },
        },
        {
            "id": "55555555-5555-4555-8555-555555555555",
            "correction": {"kind": "add_item", "layer": "L", "x": -1, "y": 0},
        },
        {
            "id": "66666666-6666-4666-8666-666666666666",
            "correction": {"kind": "merge_routes", "handles": ["B", "A"]},
            "createdAt": "ignored",  # outer object is not strict (z.object)
        },
    ]
    parsed = parse_corrections(raw)
    assert [p.correction for p in parsed] == [
        MoveLayer("A1", "SUB"),
        SetText("T1", "Joint 36"),
        AddText("L", 1.0, 2.5, "J", None),
        AddText("L", 1.0, 2.0, "J", 0.5),
        AddItem("L", -1.0, 0.0),
        MergeRoutes(("B", "A")),
    ]
    assert parsed[0].id == ID1
    assert curve_handles(parsed) == {"A1", "B", "A"}


def test_none_and_empty_mean_no_corrections() -> None:
    assert parse_corrections(None) == ()
    assert parse_corrections([]) == ()


@pytest.mark.parametrize(
    "raw",
    [
        {},
        ["x"],
        [{"id": "not-a-uuid", "correction": {"kind": "add_item", "layer": "L", "x": 0, "y": 0}}],
        [{"id": ID1, "correction": {"kind": "rotate", "handle": "A"}}],
        [{"id": ID1, "correction": {"kind": "move_layer", "handle": "A"}}],
        [{"id": ID1, "correction": {"kind": "move_layer", "handle": "", "toLayer": "L"}}],
        [{"id": ID1, "correction": {"kind": "move_layer", "handle": "A", "toLayer": "L", "x": 1}}],
        [{"id": ID1, "correction": {"kind": "set_text", "handle": "A", "text": "   "}}],
        [{"id": ID1, "correction": {"kind": "set_text", "handle": "A", "text": "x" * 256}}],
        [{"id": ID1, "correction": {"kind": "add_item", "layer": "L", "x": True, "y": 0}}],
        [{"id": ID1, "correction": {"kind": "add_item", "layer": "L", "x": float("nan"), "y": 0}}],
        [
            {
                "id": ID1,
                "correction": {
                    "kind": "add_text",
                    "layer": "L",
                    "x": 0,
                    "y": 0,
                    "text": "a",
                    "height": 0,
                },
            }
        ],
        [{"id": ID1, "correction": {"kind": "merge_routes", "handles": ["A"]}}],
        [{"id": ID1, "correction": {"kind": "merge_routes", "handles": ["A", "A"]}}],
        [
            {
                "id": ID1,
                "correction": {"kind": "merge_routes", "handles": [f"h{i}" for i in range(51)]},
            }
        ],
        [
            {"id": ID1, "correction": {"kind": "add_item", "layer": "L", "x": 0, "y": 0}},
            {"id": ID1, "correction": {"kind": "add_item", "layer": "L", "x": 1, "y": 0}},
        ],
    ],
)
def test_invalid_corrections_are_refused(raw: object) -> None:
    with pytest.raises(CorrectionInvalidError):
        parse_corrections(raw)


def _one(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"id": ID1, "correction": body}]


@pytest.mark.parametrize("key", ["x", "y"])
def test_coordinates_are_capped_at_a_billion_drawing_units(key: str) -> None:
    for kind, extra in (("add_item", {}), ("add_text", {"text": "a"})):
        body: dict[str, Any] = {"kind": kind, "layer": "L", "x": 0, "y": 0, **extra}
        parse_corrections(_one({**body, key: -MAX_CORRECTION_COORD}))  # the bound itself is fine
        with pytest.raises(CorrectionInvalidError, match="within"):
            parse_corrections(_one({**body, key: MAX_CORRECTION_COORD + 1}))
        with pytest.raises(CorrectionInvalidError, match="within"):
            parse_corrections(_one({**body, key: -1e10}))


@pytest.mark.parametrize("char", ["\x00", "\n", "\t", "\x1f"])
@pytest.mark.parametrize(
    "body",
    [
        {"kind": "move_layer", "handle": "A{c}B", "toLayer": "L"},
        {"kind": "move_layer", "handle": "A", "toLayer": "L{c}M"},
        {"kind": "set_text", "handle": "A", "text": "J{c}36"},
        {"kind": "set_text", "handle": "A{c}", "text": "J"},
        {"kind": "add_text", "layer": "L{c}", "x": 0, "y": 0, "text": "J"},
        {"kind": "add_text", "layer": "L", "x": 0, "y": 0, "text": "J{c}36"},
        {"kind": "add_item", "layer": "{c}L", "x": 0, "y": 0},
        {"kind": "merge_routes", "handles": ["A", "B{c}"]},
    ],
)
def test_control_characters_are_refused(body: dict[str, Any], char: str) -> None:
    def put(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace("{c}", char)
        return [put(v) for v in value] if isinstance(value, list) else value

    with pytest.raises(CorrectionInvalidError):
        parse_corrections(_one({k: put(v) for k, v in body.items()}))


def test_non_control_unicode_is_accepted() -> None:
    [fc] = parse_corrections(_one({"kind": "set_text", "handle": "A", "text": "كابينة 1-7 ✓"}))
    assert fc.correction == SetText("A", "كابينة 1-7 ✓")


# ---------- each kind ----------


def test_no_corrections_leave_the_drawing_as_it_is() -> None:
    drawing = empty(curves=(line("a", "DUCT 4", (0, 0), (1, 0)),))
    assert apply_corrections(drawing, (), metres_per_unit=1.0) is drawing


def test_move_layer_moves_an_insert_with_its_attributes_a_text_and_a_curve() -> None:
    attribute = SourceAttribute("N", "S1", "S1", True)
    drawing = empty(
        curves=(line("c1", "road", (0, 0), (10, 0)),),
        inserts=(SourceInsert("i1", "Sap", "Sap", (5, 5), (attribute,)),),
        texts=(label("t1", "jont 36", "Joint 144", (1, 1)),),
    )
    out = apply(
        drawing, MoveLayer("i1", "SUB"), MoveLayer("t1", "jont 144"), MoveLayer("c1", "DUCT 4")
    )
    assert out.inserts == (SourceInsert("i1", "SUB", "Sap", (5, 5), (attribute,)),)
    assert out.texts[0].layer == "jont 144" and out.texts[0].text == "Joint 144"
    assert out.curves[0].layer == "DUCT 4"
    assert drawing.inserts[0].layer == "Sap"  # the input is not changed


def test_move_layer_to_a_layer_without_a_rule_fails_loudly() -> None:
    """Owner 2026-11-09: a move only to a layer whose rule is a feature type or label."""
    drawing = empty(inserts=(SourceInsert("i1", "Sap", "Sap", (5, 5)),))
    targets = frozenset({"SUB"})
    ok = apply_corrections(
        drawing, [fix(MoveLayer("i1", "SUB"))], metres_per_unit=1.0, move_targets=targets
    )
    assert ok.inserts[0].layer == "SUB"
    with pytest.raises(CorrectionInvalidError, match="has no rule"):
        apply_corrections(
            drawing, [fix(MoveLayer("i1", "NO_RULE"))], metres_per_unit=1.0, move_targets=targets
        )


def test_move_layer_clears_wrong_layer() -> None:
    drawing = empty(
        curves=(square("j2", "jont 144", 100, 0),),
        inserts=(insert("sap1", "Sap", "Sap", (400, 0)), insert("s1", "SUB", "Sub Cab", (500, 0))),
        texts=(label("t2", "jont 36", "Joint 144", (103, 3)),),
    )
    assert problems(drawing)["WRONG_LAYER"] == ["t2", "sap1"]
    fixed = apply(drawing, MoveLayer("t2", "jont 144"), MoveLayer("sap1", "SUB"))
    assert "WRONG_LAYER" not in problems(fixed)


def test_set_text_replaces_the_text_and_makes_it_readable() -> None:
    drawing = empty(texts=(SourceText("t1", "CABLE DATA", (0, 0), 2.0, "ahvU", "ahvU", False),))
    [text] = apply(drawing, SetText("t1", "500m/1x 36 core cable")).texts
    assert (text.text, text.raw_text, text.readable) == (
        "500m/1x 36 core cable",
        "500m/1x 36 core cable",
        True,
    )
    assert (text.handle, text.layer, text.position, text.height) == (
        "t1",
        "CABLE DATA",
        (0, 0),
        2.0,
    )


def test_set_text_clears_label_type_mismatch_and_label_length_missing() -> None:
    drawing = empty(
        curves=(square("j1", "jont 144", 0, 0),),  # a 144 joint: the other kind to compare with
        inserts=(insert("k1", "jont 36", "JONT 36", (300, 0)),),
        texts=(
            label("t1", "jont 144", "J 144", (3, 3)),
            label("t3", "jont 36", "Joint 144", (303, 3)),
            label("c1", "CABLE DATA", "1x 144 core cable", (0, 60)),
        ),
    )
    assert problems(drawing) == {"LABEL_TYPE_MISMATCH": ["k1"], "LABEL_LENGTH_MISSING": ["c1"]}
    fixed = apply(drawing, SetText("t3", "Joint 36"), SetText("c1", "120m/1x 144 core cable"))
    assert problems(fixed) == {}


def test_set_text_only_on_texts() -> None:
    drawing = empty(inserts=(insert("k1", "jont 36", "JONT 36", (0, 0)),))
    with pytest.raises(CorrectionInvalidError, match="no text with handle k1"):
        apply(drawing, SetText("k1", "x"))


def test_add_text_with_and_without_height() -> None:
    drawing = empty(
        texts=(
            SourceText("a", "jont 144", (0, 0), 1.0, "x", "x", True),
            SourceText("b", "jont 144", (0, 0), 3.0, "x", "x", True),
            SourceText("c", "jont 144", (0, 0), 2.5, "x", "x", True),
            SourceText("u", "jont 144", (0, 0), 99.0, "?", "?", False),  # unreadable: not counted
        )
    )
    frozen = [
        FrozenCorrection(ID1, AddText("jont 144", 10, 20, "J 144", None)),
        FrozenCorrection(ID2, AddText("empty", 1, 2, "x", 0.4)),
        FrozenCorrection(str(uuid.UUID(int=3)), AddText("nothing here", 1, 2, "x", None)),
    ]
    out = apply_corrections(drawing, frozen, metres_per_unit=1.0)
    added = out.texts[4:]
    assert added[0] == SourceText(f"FIX-{ID1}", "jont 144", (10, 20), 2.5, "J 144", "J 144", True)
    assert added[1].height == 0.4 and added[1].handle == f"FIX-{ID2}"
    assert added[2].height == DEFAULT_TEXT_HEIGHT


def test_default_height_follows_earlier_corrections() -> None:
    """Texts moved, typed or added earlier count on their new layer, and no longer on the old."""
    drawing = empty(
        texts=(
            SourceText("a", "A", (0, 0), 1.0, "x", "x", True),
            SourceText("b", "A", (0, 0), 9.0, "x", "x", True),
            SourceText("u", "B", (0, 0), 4.0, "?", "?", False),  # unreadable until typed
        )
    )
    steps = [
        MoveLayer("b", "B"),  # A = [1], B = [9]
        SetText("u", "typed"),  # B = [4, 9]
        AddText("B", 0, 0, "n", 20.0),  # B = [4, 9, 20]
        AddText("A", 0, 0, "default on A", None),  # median of [1] -> 1; A = [1, 1]
        AddText("B", 0, 0, "default on B", None),  # median of [4, 9, 20] -> 9; B = [4, 9, 9, 20]
        MoveLayer("b", "A"),  # A = [1, 1, 9], B = [4, 9, 20]
        AddText("A", 0, 0, "again on A", None),  # median of [1, 1, 9] -> 1
        AddText("B", 0, 0, "again on B", None),  # median of [4, 9, 20] -> 9
    ]
    out = apply(drawing, *steps)
    assert [t.height for t in out.texts[4:]] == [1.0, 9.0, 1.0, 9.0]


def test_many_added_texts_on_a_large_drawing_stay_fast() -> None:
    """5000 add_text without height on 100k texts: no scan of every text per correction."""
    drawing = empty(
        texts=tuple(
            SourceText(f"t{i}", f"L{i % 10}", (i, 0), 1.0 + i % 7, "x", "x", True)
            for i in range(100_000)
        )
    )
    corrections = [
        FrozenCorrection(str(uuid.UUID(int=n + 1)), AddText(f"L{n % 10}", n, 1, "J", None))
        for n in range(5000)
    ]
    started = time.perf_counter()
    out = apply_corrections(drawing, corrections, metres_per_unit=1.0)
    assert time.perf_counter() - started < 2.0
    assert len(out.texts) == 105_000
    assert out.texts[-1].height == 4.0  # median of 1..7 on every layer


def test_add_text_clears_label_missing() -> None:
    drawing = empty(
        curves=(square("j1", "jont 144", 0, 0), square("j3", "jont 144", 200, 0)),
        texts=(label("t1", "jont 144", "J 144", (3, 3)),),
    )
    assert problems(drawing) == {"LABEL_MISSING": ["j3"]}
    assert problems(apply(drawing, AddText("jont 144", 203, 3, "J 144 B", None))) == {}


def test_add_item_is_counted_as_its_layers_type() -> None:
    rules = parse_rules(
        [
            {"source": "layer", "layer": "jont 144", "target": "joint", "kind": "144"},
            # Even a block rule named like the marker block does not decide an added item.
            {"source": "block", "block": FIX_BLOCK, "target": "ignore"},
        ]
    )
    drawing = apply(empty(), AddItem("jont 144", 50, 60))
    [item] = drawing.inserts
    assert (item.handle, item.block_name, item.position, item.attributes) == (
        f"FIX-{uuid.UUID(int=1)}",
        FIX_BLOCK,
        (50, 60),
        (),
    )
    design = compose_design(drawing, rules, unit_placer(1.0), (), uuid.uuid4)
    assert design.feature_counts["joint"] == 1
    [row] = design.rows.features
    assert row.coords == ((50.0, 60.0),) and row.attrs == {
        "kind": "144",
        "drawingAt": {"x": 50.0, "y": 60.0},  # the corrected position, in drawing units
    }
    assert row.source_kind == "insert" and row.source_handle == f"FIX-{uuid.UUID(int=1)}"


def test_added_rows_can_be_corrected_later() -> None:
    first = FrozenCorrection(ID1, AddText("jont 36", 0, 0, "J", 1.0))
    then = FrozenCorrection(ID2, MoveLayer(f"FIX-{ID1}", "jont 144"))
    [text] = apply_corrections(empty(), [first, then], metres_per_unit=1.0).texts
    assert text.layer == "jont 144"


def test_an_added_handle_cannot_exist_twice() -> None:
    drawing = empty(texts=(SourceText(f"FIX-{ID1}", "L", (0, 0), 1.0, "x", "x", True),))
    with pytest.raises(CorrectionInvalidError, match="already exists"):
        apply_corrections(drawing, [FrozenCorrection(ID1, AddItem("L", 0, 0))], metres_per_unit=1.0)


# ---------- merge_routes ----------


def test_merge_chains_pieces_in_any_order_and_direction() -> None:
    drawing = empty(
        curves=(
            line("b", "DUCT 4", (40, 0), (60, 0), (80, 0)),
            line("c", "DUCT 4", (120, 0), (80, 0)),  # drawn backwards
            line("a", "DUCT 4", (40, 0), (0, 0)),  # key piece, drawn backwards
            line("z", "DUCT 4", (0, 50), (10, 50)),  # not merged
        )
    )
    out = apply(drawing, MergeRoutes(("c", "b", "a")))
    assert [c.handle for c in out.curves] == ["a", "z"]  # the merged line takes the key's place
    merged = next(c for c in out.curves if c.handle == "a")
    # In the key piece's direction, each shared vertex once.
    assert merged.points == ((120, 0), (80, 0), (60, 0), (40, 0), (0, 0))
    assert (merged.layer, merged.closed, merged.entity_type) == ("DUCT 4", False, "LWPOLYLINE")


def test_merge_clears_route_split_and_keeps_the_drawn_length() -> None:
    drawing = empty(
        curves=(
            line("d1", "DUCT 4", (0, 50), (40, 50)),
            line("d2", "DUCT 4", (90, 50), (40.03, 50)),  # 3 cm gap, reversed
        )
    )
    assert problems(drawing) == {"ROUTE_SPLIT": ["d1/d2"]}
    fixed = apply(drawing, MergeRoutes(("d2", "d1")))
    assert problems(fixed) == {}
    design = compose_design(fixed, RULES, unit_placer(1.0), (), uuid.uuid4)
    assert design.feature_counts["route"] == 1
    assert design.groups[0]["lengthM"] == "90.000"  # 40 + 0.03 gap + 49.97


def test_merge_tolerance_is_in_metres() -> None:
    """Drawing in millimetres: 30 units = 3 cm meet, 60 units = 6 cm do not."""
    near = empty(
        curves=(line("a", "DUCT 4", (0, 0), (1000, 0)), line("b", "DUCT 4", (1030, 0), (2000, 0)))
    )
    assert len(apply(near, MergeRoutes(("a", "b")), unit=0.001).curves) == 1
    far = empty(
        curves=(line("a", "DUCT 4", (0, 0), (1000, 0)), line("b", "DUCT 4", (1060, 0), (2000, 0)))
    )
    with pytest.raises(CorrectionInvalidError, match="one chain"):
        apply(far, MergeRoutes(("a", "b")), unit=0.001)


def test_merge_fails_when_the_pieces_do_not_form_one_chain() -> None:
    drawing = empty(
        curves=(
            line("a", "DUCT 4", (0, 0), (40, 0)),
            line("b", "DUCT 4", (40, 0), (80, 0)),
            line("c", "DUCT 4", (500, 0), (600, 0)),  # far away
        )
    )
    with pytest.raises(CorrectionInvalidError, match=r"one chain \(c not joined\)"):
        apply(drawing, MergeRoutes(("a", "b", "c")))


def test_merge_fails_at_a_junction() -> None:
    drawing = empty(
        curves=(
            line("a", "DUCT 4", (0, 0), (40, 0)),
            line("b", "DUCT 4", (40, 0), (80, 0)),
            line("c", "DUCT 4", (40, 0), (40, 40)),
        )
    )
    with pytest.raises(CorrectionInvalidError, match="more than one line"):
        apply(drawing, MergeRoutes(("a", "b", "c")))


@pytest.mark.parametrize(
    "other",
    [
        SourceCurve("b", "DUCT 4", ((40, 0), (80, 0), (80, 40), (40, 0)), True, "LWPOLYLINE"),
        SourceCurve("b", "DUCT 4", ((40, 0), (80, 0)), False, "ARC"),
        line("b", "DUCT 2", (40, 0), (80, 0)),  # another layer
    ],
)
def test_merge_only_open_lines_of_one_layer(other: SourceCurve) -> None:
    drawing = empty(curves=(line("a", "DUCT 4", (0, 0), (40, 0)), other))
    with pytest.raises(CorrectionInvalidError):
        apply(drawing, MergeRoutes(("a", "b")))


def test_a_merged_away_piece_is_gone_for_later_corrections() -> None:
    drawing = empty(
        curves=(line("a", "DUCT 4", (0, 0), (40, 0)), line("b", "DUCT 4", (40, 0), (80, 0)))
    )
    with pytest.raises(CorrectionInvalidError, match="no item with handle b"):
        apply(drawing, MergeRoutes(("a", "b")), MoveLayer("b", "DUCT 2"))


# ---------- missing handles ----------


@pytest.mark.parametrize(
    "correction",
    [MoveLayer("gone", "L"), SetText("gone", "x"), MergeRoutes(("a", "gone"))],
)
def test_a_handle_missing_from_the_drawing_fails_loudly(correction: Any) -> None:
    drawing = empty(curves=(line("a", "DUCT 4", (0, 0), (40, 0)),))
    with pytest.raises(CorrectionInvalidError, match=f"drawing correction {ID1}: no .* gone"):
        apply_corrections(drawing, [fix(correction)], metres_per_unit=1.0)
