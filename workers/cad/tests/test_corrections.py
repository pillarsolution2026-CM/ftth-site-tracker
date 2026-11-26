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
    AddCurve,
    AddItem,
    AddLayer,
    AddNote,
    AddShape,
    AddTable,
    AddText,
    CopyItem,
    CorrectionInvalidError,
    DeleteLayer,
    DismissProblem,
    EraseItem,
    FrozenCorrection,
    MergeLayer,
    MergeRoutes,
    MirrorItem,
    MoveItem,
    MoveLayer,
    RenameLayer,
    RotateItem,
    ScaleItem,
    SetAttribute,
    SetCurve,
    SetGroup,
    SetOrder,
    SetStyle,
    SetText,
    SetTextFormat,
    apply_corrections,
    curve_handles,
    dismissed_places,
    layer_aliases,
    merged_layers,
    parse_corrections,
    with_layer_aliases,
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


# ---------- dismissing a misread problem place (ADR-046) ----------


def test_dismiss_is_parsed_strictly() -> None:
    body = {"kind": "dismiss_problem", "code": "LABEL_MISSING", "handle": "j3", "reason": " ok "}
    [parsed] = parse_corrections([{"id": ID1, "correction": body}])
    assert parsed.correction == DismissProblem("LABEL_MISSING", "j3", "ok")
    for bad in (
        {**body, "code": "NOT_A_CODE"},
        {**body, "reason": "  "},
        {**body, "handle": "x" * 65},
        {**body, "extra": 1},
    ):
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": bad}])


def test_dismiss_changes_no_row_and_drops_only_its_place() -> None:
    drawing = empty(
        curves=(
            square("j1", "jont 144", 0, 0),
            square("j3", "jont 144", 200, 0),
            square("j4", "jont 144", 400, 0),
        ),
        texts=(label("t1", "jont 144", "J 144", (3, 3)),),
    )
    dismissal = fix(DismissProblem("LABEL_MISSING", "j3", "no label needed here"))
    assert apply_corrections(drawing, [dismissal], metres_per_unit=1.0) == drawing
    assert dismissed_places([dismissal]) == frozenset({("LABEL_MISSING", "j3")})

    design = compose_design(
        drawing, RULES, unit_placer(1.0), (), uuid.uuid4, dismissed=dismissed_places([dismissal])
    )
    [problem] = design.problems
    assert problem["code"] == "LABEL_MISSING" and problem["count"] == 1
    items = problem["items"]
    assert isinstance(items, list) and [i["handle"] for i in items] == ["j4"]


def test_dismissing_every_place_leaves_no_problem() -> None:
    drawing = empty(
        curves=(square("j1", "jont 144", 0, 0), square("j3", "jont 144", 200, 0)),
        texts=(label("t1", "jont 144", "J 144", (3, 3)),),
    )
    dismissed = frozenset({("LABEL_MISSING", "j3")})
    design = compose_design(drawing, RULES, unit_placer(1.0), (), uuid.uuid4, dismissed=dismissed)
    assert design.problems == []
    # Another code at the same handle is not dismissed.
    other = frozenset({("WRONG_LAYER", "j3")})
    kept = compose_design(drawing, RULES, unit_placer(1.0), (), uuid.uuid4, dismissed=other)
    assert [p["code"] for p in kept.problems] == ["LABEL_MISSING"]


# ---------- move and rotate (ADR-047) ----------


def test_move_and_rotate_are_parsed_strictly() -> None:
    parsed = parse_corrections(
        [
            {"id": ID1, "correction": {"kind": "move_item", "handle": "c1", "dx": 2, "dy": -1.5}},
            {
                "id": ID2,
                "correction": {"kind": "rotate_item", "handle": "c1", "x": 1, "y": 2, "angle": 90},
            },
        ]
    )
    assert [p.correction for p in parsed] == [MoveItem("c1", 2.0, -1.5), RotateItem("c1", 1, 2, 90)]
    for body in (
        {"kind": "move_item", "handle": "c1", "dx": 1},
        {"kind": "move_item", "handle": "c1", "dx": 1, "dy": float("inf")},
        {"kind": "rotate_item", "handle": "c1", "x": 0, "y": 0, "angle": 361},
        {"kind": "rotate_item", "handle": "c1", "x": 0, "y": 0, "angle": True},
        {"kind": "rotate_item", "handle": "c1", "x": 0, "y": 0, "angle": 1, "extra": 1},
    ):
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": body}])


def test_move_item_moves_an_insert_a_text_and_every_point_of_a_curve() -> None:
    attribute = SourceAttribute("N", "S1", "S1", True)
    drawing = empty(
        curves=(line("c1", "road", (0, 0), (10, 0)),),
        inserts=(SourceInsert("i1", "Sap", "Sap", (5, 5), (attribute,)),),
        texts=(label("t1", "jont 36", "Joint 144", (1, 1)),),
    )
    out = apply(drawing, MoveItem("i1", 3, -2), MoveItem("t1", 1, 1), MoveItem("c1", 0, 4))
    assert out.inserts == (SourceInsert("i1", "Sap", "Sap", (8, 3), (attribute,)),)
    assert out.texts[0].position == (2, 2) and out.texts[0].text == "Joint 144"
    assert out.curves[0].points == ((0, 4), (10, 4))
    assert drawing.curves[0].points == ((0, 0), (10, 0))  # the input is not changed


def test_rotate_item_turns_points_counter_clockwise_about_the_base_point() -> None:
    drawing = empty(
        curves=(line("c1", "road", (1, 0), (3, 0)),),
        inserts=(insert("i1", "Sap", "Sap", (2, 1)),),
    )
    out = apply(drawing, RotateItem("c1", 1, 0, 90), RotateItem("i1", 2, 1, 45))
    (a, b) = out.curves[0].points
    assert a == pytest.approx((1, 0)) and b == pytest.approx((1, 2))
    assert out.inserts[0].position == pytest.approx((2, 1))  # about its own point: stays


def test_a_moved_label_reaches_its_item_again() -> None:
    # A text far from every item is not a label of anything; moved next to the box it is.
    far = empty(
        inserts=(insert("i1", "jont 36", "J", (0, 0)),),
        texts=(label("t1", "jont 36", "Joint 36", (500, 500)),),
    )
    near = apply(far, MoveItem("t1", -499, -499))
    assert near.texts[0].position == (1, 1)
    assert problems(near) != problems(far)


@pytest.mark.parametrize("correction", [MoveItem("missing", 1, 1), RotateItem("missing", 0, 0, 10)])
def test_moving_a_missing_handle_fails_loudly(correction: Any) -> None:
    with pytest.raises(CorrectionInvalidError, match="no item with handle missing"):
        apply(empty(), correction)


def test_moved_and_rotated_curves_are_read_even_without_a_rule() -> None:
    frozen = [fix(MoveItem("c1", 1, 1), ID1), fix(RotateItem("c2", 0, 0, 5), ID2)]
    assert curve_handles(frozen) == frozenset({"c1", "c2"})


# ---------- CAD ribbon (ADR-050) ----------


def test_ribbon_kinds_are_parsed_strictly() -> None:
    raw = [
        {"id": str(uuid.UUID(int=i + 1)), "correction": body}
        for i, body in enumerate(
            [
                {"kind": "erase_item", "handle": "c1"},
                {"kind": "copy_item", "handle": "c1", "dx": 1, "dy": 2},
                {"kind": "mirror_item", "handle": "c1", "x1": 0, "y1": 0, "x2": 1, "y2": 0},
                {"kind": "scale_item", "handle": "c1", "x": 0, "y": 0, "factor": 2},
                {"kind": "add_curve", "layer": "R", "points": [[0, 0], [1, 1]], "closed": False},
                {"kind": "add_layer", "layer": "N", "like": "R"},
                {"kind": "rename_layer", "from": "R", "to": "R2"},
                {"kind": "delete_layer", "layer": "R"},
            ]
        )
    ]
    kinds = [type(p.correction).__name__ for p in parse_corrections(raw)]
    assert kinds == [
        "EraseItem",
        "CopyItem",
        "MirrorItem",
        "ScaleItem",
        "AddCurve",
        "AddLayer",
        "RenameLayer",
        "DeleteLayer",
    ]
    for body in (
        {"kind": "mirror_item", "handle": "c1", "x1": 1, "y1": 1, "x2": 1, "y2": 1},
        {"kind": "scale_item", "handle": "c1", "x": 0, "y": 0, "factor": 0},
        {"kind": "add_curve", "layer": "R", "points": [[0, 0]], "closed": False},
        {"kind": "add_curve", "layer": "R", "points": [[0, 0], [1]], "closed": False},
        {"kind": "add_layer", "layer": "R", "like": "R"},
        {"kind": "rename_layer", "from": "R", "to": "R"},
    ):
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": body}])


def test_erase_copy_mirror_and_scale() -> None:
    drawing = empty(
        curves=(line("c1", "road", (1, 0), (3, 0)),),
        inserts=(insert("i1", "Sap", "Sap", (2, 2)),),
        texts=(label("t1", "jont 36", "Joint 36", (4, 4)),),
    )
    out = apply(
        drawing,
        CopyItem("c1", 0, 5),
        EraseItem("i1"),
        MirrorItem("c1", 0, 0, 0, 1),
        ScaleItem("t1", 0, 0, 2),
    )
    curves = {c.handle: c.points for c in out.curves}
    assert curves["c1"] == ((-1, 0), (-3, 0))
    copy = next(h for h in curves if h.startswith("FIX-"))
    assert curves[copy] == ((1, 5), (3, 5))
    assert out.inserts == ()
    assert out.texts[0].position == (8, 8) and out.texts[0].height == 4.0


def test_a_drawn_route_is_a_route_and_ids_are_unique() -> None:
    out = apply(empty(), AddCurve("DUCT 4", ((0, 0), (10, 0), (10, 5)), False))
    assert out.curves[0].handle.startswith("FIX-")
    assert out.curves[0].layer == "DUCT 4" and len(out.curves[0].points) == 3


def test_layer_rename_and_delete_move_or_remove_every_row() -> None:
    drawing = empty(
        curves=(line("c1", "road", (0, 0), (1, 0)), line("c2", "keep", (0, 0), (1, 0))),
        inserts=(insert("i1", "road", "B", (0, 0)),),
        texts=(label("t1", "old", "x", (0, 0)),),
    )
    out = apply(drawing, RenameLayer("old", "new"), DeleteLayer("road"))
    assert [c.handle for c in out.curves] == ["c2"]
    assert out.inserts == ()
    assert out.texts[0].layer == "new"


def test_added_and_renamed_layers_take_the_rule_of_their_source() -> None:
    frozen = [
        fix(AddLayer("N", "DUCT 4"), ID1),
        fix(RenameLayer("N", "N2"), ID2),
    ]
    aliases = layer_aliases(frozen)
    assert aliases == {"N": "DUCT 4", "N2": "DUCT 4"}
    rules = [{"source": "layer", "layer": "DUCT 4", "target": "route"}]
    extended = with_layer_aliases(rules, aliases)
    assert extended == [
        *rules,
        {"source": "layer", "layer": "N", "target": "route"},
        {"source": "layer", "layer": "N2", "target": "route"},
    ]
    # A move to an added layer is allowed when its source may be targeted.
    out = apply_corrections(
        empty(curves=(line("c1", "x", (0, 0), (1, 0)),)),
        [*frozen, fix(MoveLayer("c1", "N2"), str(uuid.UUID(int=9)))],
        metres_per_unit=1.0,
        move_targets=frozenset({"DUCT 4"}),
    )
    assert out.curves[0].layer == "N2"


@pytest.mark.parametrize(
    "correction",
    [EraseItem("missing"), CopyItem("missing", 1, 1), ScaleItem("missing", 0, 0, 2)],
)
def test_ribbon_on_a_missing_handle_fails_loudly(correction: Any) -> None:
    with pytest.raises(CorrectionInvalidError, match="no item with handle missing"):
        apply(empty(), correction)


# ---------- AutoCAD-like screen (ADR-051) ----------


def test_screen_kinds_are_parsed_strictly() -> None:
    raw = [
        {"id": str(uuid.UUID(int=i + 1)), "correction": body}
        for i, body in enumerate(
            [
                {"kind": "set_curve", "handle": "c1", "points": [[0, 0], [2, 0]], "closed": False},
                {
                    "kind": "add_note",
                    "note": "dimension",
                    "layer": "DIM",
                    "points": [[0, 0], [4, 0], [2, 1]],
                    "text": None,
                },
                {
                    "kind": "add_note",
                    "note": "leader",
                    "layer": "DIM",
                    "points": [[1, 1]],
                    "text": "ODB",
                },
                {
                    "kind": "set_style",
                    "handle": "c1",
                    "color": "#FF00aa",
                    "linetype": "dashed",
                    "lineweight": 0.35,
                },
                {
                    "kind": "set_style",
                    "handle": "c1",
                    "color": None,
                    "linetype": None,
                    "lineweight": None,
                },
            ]
        )
    ]
    parsed = [p.correction for p in parse_corrections(raw)]
    assert parsed[0] == SetCurve("c1", ((0, 0), (2, 0)), False)
    assert parsed[1] == AddNote("dimension", "DIM", ((0, 0), (4, 0), (2, 1)), None)
    assert parsed[2] == AddNote("leader", "DIM", ((1, 1),), "ODB")
    assert parsed[3] == SetStyle("c1", "#FF00aa", "dashed", 0.35)
    assert parsed[4] == SetStyle("c1", None, None, None)
    note: dict[str, Any] = {"kind": "add_note", "note": "leader", "layer": "DIM", "text": None}
    style: dict[str, Any] = {"kind": "set_style", "handle": "c1", "color": None, "linetype": None}
    bad: tuple[dict[str, Any], ...] = (
        {"kind": "set_curve", "handle": "c1", "points": [[0, 0]], "closed": False},
        {"kind": "set_curve", "handle": "c1", "points": [[0, 0], [1, 1]], "layer": "R"},
        {**note, "points": []},
        {**note, "points": [[i, i] for i in range(51)]},
        {**note, "note": "table", "points": [[0, 0]]},
        {**note, "points": [[0, 0]], "text": "  "},
        {**style, "color": "red", "lineweight": None},
        {**style, "linetype": "zigzag", "lineweight": None},
        {**style, "lineweight": 11},
        {**style, "lineweight": True},
    )
    for body in bad:
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": body}])


def test_set_curve_replaces_the_points_and_keeps_handle_and_layer() -> None:
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0), (10, 5)),))
    out = apply(drawing, SetCurve("c1", ((0, 0), (6, 0)), False))
    assert out.curves == (SourceCurve("c1", "DUCT 4", ((0, 0), (6, 0)), False, "LWPOLYLINE"),)
    assert "c1" in curve_handles([fix(SetCurve("c1", ((0, 0), (1, 0)), False))])
    with pytest.raises(CorrectionInvalidError, match="no line with handle t1"):
        apply(
            empty(texts=(label("t1", "L", "x", (0, 0)),)),
            SetCurve("t1", ((0, 0), (1, 0)), False),
        )


def test_notes_and_styles_change_no_row_and_no_problem() -> None:
    drawing = empty(
        curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),),
        inserts=(insert("i1", "Sap", "Sap", (2, 2)),),
        texts=(label("t1", "jont 36", "Joint 36", (4, 4)),),
    )
    out = apply(
        drawing,
        AddNote("dimension", "DIM", ((0, 0), (10, 0), (5, 2)), None),
        AddNote("leader", "NO RULE", ((1, 1), (3, 3)), "ODB"),
        SetStyle("c1", "#ff0000", "dashed", 0.5),
        # The build never looks the handle up: a style of a gone item is harmless.
        SetStyle("gone", None, None, None),
    )
    assert out == drawing
    assert problems(out) == problems(drawing)


def test_a_layer_for_drawing_only_and_a_layer_given_a_meaning() -> None:
    """Owner 2026-11-19 (ADR-051): a line may be drawn on any layer; on one without a rule the
    build ignores it, and a layer of the drawing without a rule can be given another's meaning."""
    parsed = parse_corrections(
        [{"id": ID1, "correction": {"kind": "add_layer", "layer": "HOUSES", "like": None}}]
    )
    assert parsed[0].correction == AddLayer("HOUSES", None)
    assert layer_aliases(parsed) == {}
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),))
    houses = apply(drawing, AddCurve("HOUSES", ((0, 5), (5, 5), (5, 9), (0, 9)), True))
    built = build_features(houses, RULES, unit_placer(1.0))
    assert built.features == build_features(drawing, RULES, unit_placer(1.0)).features
    assert problems(houses) == problems(drawing)
    # «buildings» has no rule: once it means what DUCT 4 means, a line drawn on it is a route.
    frozen = [fix(AddLayer("buildings", "DUCT 4"), ID1)]
    rules = with_layer_aliases(
        [{"source": "layer", "layer": "DUCT 4", "target": "route"}], layer_aliases(frozen)
    )
    assert rules == [
        {"source": "layer", "layer": "DUCT 4", "target": "route"},
        {"source": "layer", "layer": "buildings", "target": "route"},
    ]


# ---------- screen shapes and draw order (owner 2026-11-24) ----------


def test_shapes_and_draw_order_are_parsed_and_change_nothing() -> None:
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    bodies: list[dict[str, Any]] = [
        {
            "kind": "add_shape",
            "shape": "hatch",
            "layer": "H",
            "points": square,
            "pattern": "ANSI31",
            "scale": 2,
            "angle": 45,
            "color": None,
            "color2": None,
            "inner": None,
            "outer": None,
        },
        {
            "kind": "add_shape",
            "shape": "gradient",
            "layer": "H",
            "points": square,
            "color": "#ff0000",
            "color2": "#0000FF",
        },
        {
            "kind": "add_shape",
            "shape": "donut",
            "layer": "H",
            "points": [[1, 1]],
            "inner": 0,
            "outer": 2,
        },
        {"kind": "add_shape", "shape": "xline", "layer": "H", "points": [[0, 0], [1, 1]]},
        {"kind": "set_order", "handle": "c1", "order": -2.5},
    ]
    raw = [{"id": str(uuid.UUID(int=i + 1)), "correction": b} for i, b in enumerate(bodies)]
    parsed = [p.correction for p in parse_corrections(raw)]
    assert parsed[0] == AddShape("hatch", "H", ((0, 0), (10, 0), (10, 10), (0, 10)))
    assert parsed[2] == AddShape("donut", "H", ((1, 1),))
    assert parsed[4] == SetOrder("c1", -2.5)
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),))
    for correction in parsed:
        assert apply(drawing, correction) == apply(drawing, SetOrder("c1", 0))
    assert apply(drawing, SetOrder("c1", 3)).curves == drawing.curves


def test_bad_shapes_and_orders_fail_loudly() -> None:
    shape: dict[str, Any] = {"kind": "add_shape", "shape": "hatch", "layer": "H"}
    bad: tuple[dict[str, Any], ...] = (
        {**shape, "points": [[0, 0], [1, 1]]},
        {**shape, "shape": "cloud", "points": [[0, 0], [1, 0], [1, 1]]},
        {**shape, "points": [[0, 0], [1, 0], [1, 1]], "pattern": "BRICKS"},
        {**shape, "points": [[0, 0], [1, 0], [1, 1]], "color": "red"},
        {**shape, "points": [[0, 0], [1, 0], [1, 1]], "scale": 0},
        {**shape, "shape": "donut", "points": [[0, 0]], "inner": 2, "outer": 2},
        {**shape, "shape": "donut", "points": [[0, 0]]},
        {**shape, "shape": "ray", "points": [[0, 0], [0, 0]]},
        {**shape, "shape": "ray", "points": [[0, 0]]},
        {**shape, "points": [[0, 0], [1, 0], [1, 1]], "extra": 1},
        {"kind": "set_order", "handle": "c1", "order": "top"},
        {"kind": "set_order", "handle": "c1", "order": 2e9},
    )
    for body in bad:
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": body}])


# ---------- layers, groups and attributes (owner 2026-11-24) ----------


def test_copy_to_another_layer_keeps_the_original() -> None:
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),))
    out = apply(drawing, CopyItem("c1", 0, 5, "NEW"))
    layers = sorted((c.handle[:3], c.layer) for c in out.curves)
    assert layers == [("FIX", "NEW"), ("c1", "DUCT 4")]
    parsed = parse_corrections(
        [
            {
                "id": ID1,
                "correction": {
                    "kind": "copy_item",
                    "handle": "c1",
                    "dx": 0,
                    "dy": 0,
                    "toLayer": "N",
                },
            }
        ]
    )
    assert parsed[0].correction == CopyItem("c1", 0, 0, "N")


def test_merge_layer_moves_every_row_and_needs_a_target_with_a_rule() -> None:
    drawing = empty(curves=(line("c1", "OLD", (0, 0), (10, 0)), line("c2", "KEEP", (0, 1), (1, 1))))
    out = apply(drawing, MergeLayer("OLD", "DUCT 4"))
    assert {c.handle: c.layer for c in out.curves} == {"c1": "DUCT 4", "c2": "KEEP"}
    assert merged_layers([fix(MergeLayer("OLD", "DUCT 4"))]) == frozenset({"OLD"})
    with pytest.raises(CorrectionInvalidError, match="has no rule"):
        apply_corrections(
            drawing,
            [fix(MergeLayer("OLD", "NOWHERE"))],
            metres_per_unit=1.0,
            move_targets=frozenset({"DUCT 4"}),
        )


def test_set_attribute_changes_the_first_attribute_with_that_value() -> None:
    attrs = (SourceAttribute("A", "S1", "S1", True), SourceAttribute("B", "S1", "S1", True))
    block = SourceInsert("i1", "L", "sym", (0, 0), attrs)
    out = apply(empty(inserts=(block,)), SetAttribute("i1", "S1", "S2"))
    assert [a.value for a in out.inserts[0].attributes] == ["S2", "S1"]
    with pytest.raises(CorrectionInvalidError, match="no attribute with the value"):
        apply(empty(inserts=(block,)), SetAttribute("i1", "X", "Y"))


def test_groups_are_screen_only_and_parsed_strictly() -> None:
    body: dict[str, Any] = {"kind": "set_group", "name": "G1", "handles": ["c1"], "block": True}
    parsed = parse_corrections([{"id": ID1, "correction": body}])
    assert parsed[0].correction == SetGroup("G1", ("c1",), True)
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),))
    assert apply(drawing, SetGroup("G1", ("c1",), False)).curves == drawing.curves
    for bad in ({**body, "block": "yes"}, {**body, "name": " "}, {**body, "handles": "c1"}):
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": bad}])
    for bad in (
        {"kind": "merge_layer", "from": "A", "to": "A"},
        {"kind": "set_attribute", "handle": "i1", "from": "A", "to": "A"},
    ):
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": bad}])


# ---------- Text panel, TABLE and HATCH (ADR-055 parts 7-8) ----------

_SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]]
_TABLE: dict[str, Any] = {
    "kind": "add_table",
    "layer": "ANY",
    "x": 0,
    "y": 50,
    "columns": [63.5, 63.5],
    "rows": [9, 9],
    "height": 4.5,
    "styles": ["title", "header", "data"],
    "cells": [["Title", ""], ["A", "B"]],
}
_FORMAT: dict[str, Any] = {
    "kind": "set_text_format",
    "handle": "t1",
    "widthFactor": 1.25,
    "mtext": True,
    "wrap": 40,
    "mask": {"offset": 0.35, "color": None},
}


def test_text_formats_tables_and_full_hatches_are_parsed_and_change_nothing() -> None:
    hatch: dict[str, Any] = {
        "kind": "add_shape",
        "shape": "hatch",
        "layer": "H",
        "points": _SQUARE,
        "pattern": "AR-B816",
        "loops": [[[3, 3], [6, 3], [6, 6]]],
        "island": "outer",
        "background": "#202020",
        "transparency": 50,
        "origin": [5, 5],
        "double": False,
        "drawOrder": "front",
    }
    gradient = {**hatch, "shape": "gradient", "pattern": "GR_SPHER"}
    bodies = [_FORMAT, {"kind": "set_text_format", "handle": "t1"}, _TABLE, hatch, gradient]
    raw = [{"id": str(uuid.UUID(int=i + 1)), "correction": b} for i, b in enumerate(bodies)]
    parsed = [p.correction for p in parse_corrections(raw)]
    assert parsed[0] == SetTextFormat("t1")
    assert parsed[2] == AddTable("ANY", 2, 2)
    assert parsed[3] == AddShape("hatch", "H", ((0, 0), (10, 0), (10, 10), (0, 10)))
    drawing = empty(curves=(line("c1", "DUCT 4", (0, 0), (10, 0)),))
    for correction in parsed:
        assert apply(drawing, correction) == apply(drawing, SetOrder("c1", 0))


def test_bad_text_formats_tables_and_hatches_fail_loudly() -> None:
    hatch: dict[str, Any] = {"kind": "add_shape", "shape": "hatch", "layer": "H", "points": _SQUARE}
    bad: tuple[dict[str, Any], ...] = (
        {**_FORMAT, "widthFactor": 0},
        {**_FORMAT, "wrap": -1},
        {**_FORMAT, "mtext": "yes"},
        {**_FORMAT, "mask": {"offset": 9}},
        {**_FORMAT, "mask": {"offset": 1, "color": "red"}},
        {**_FORMAT, "mask": {"offset": 1, "size": 2}},
        {**_FORMAT, "rotation": 5},
        {**_TABLE, "cells": [["a", "b"]]},
        {**_TABLE, "cells": [["a"], ["b"]]},
        {**_TABLE, "columns": [0, 1]},
        {**_TABLE, "columns": []},
        {**_TABLE, "styles": ["title", "header"]},
        {**_TABLE, "styles": ["title", "header", "note"]},
        {**_TABLE, "cells": [["a", ""], ["", ""]]},
        {**_TABLE, "height": 0},
        {**hatch, "pattern": "GR_LINEAR"},
        {**hatch, "shape": "gradient", "pattern": "ANSI31"},
        {**hatch, "loops": [[[0, 0], [1, 1]]]},
        {**hatch, "loops": [_SQUARE] * 101},
        {**hatch, "shape": "wipeout", "loops": [_SQUARE]},
        {**hatch, "island": "all"},
        {**hatch, "drawOrder": "top"},
        {**hatch, "transparency": 91},
        {**hatch, "transparency": 1.5},
        {**hatch, "background": "grey"},
        {**hatch, "origin": [1]},
        {**hatch, "double": 1},
    )
    for body in bad:
        with pytest.raises(CorrectionInvalidError):
            parse_corrections([{"id": ID1, "correction": body}])
