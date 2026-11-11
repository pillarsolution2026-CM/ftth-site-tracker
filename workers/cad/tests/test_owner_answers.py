"""The owner's answers to the ADR-041 open questions (2026-11-11): anything unclear is an error.

Small synthetic scenes (`tests/support/reading_scenes.py`) through `compose_design`, one rule per
test; the Al-Fath numbers are in `test_golden_alfath.py`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from cad_worker.domain.design_build import DrawingData, MappingInvalidError, parse_rules
from cad_worker.domain.drawing_checks import BLOCKS, PROBLEM_CODES, SEVERITY, ProblemCode
from tests.support.reading_scenes import (
    GENERAL_RULES,
    SECONDARY_RULES,
    compose,
    general_drawing,
    insert,
    line,
    problems_of,
    read,
    secondary_drawing,
    text,
    with_text,
    without,
)

NEW_CODES: tuple[ProblemCode, ...] = (
    "BOX_CABINET_UNKNOWN",
    "CABINET_NAME_DUPLICATE",
    "CONNECTOR_SIZE_MISSING",
)


def places(
    drawing: DrawingData, kind: str, rules: Sequence[Mapping[str, object]] | None = None
) -> dict[str, list[dict[str, object]]]:
    if rules is None:
        rules = SECONDARY_RULES if kind == "secondary" else GENERAL_RULES
    return problems_of(compose(drawing, rules, kind))  # type: ignore[arg-type]


def brief(items: list[dict[str, object]]) -> list[tuple[object, ...]]:
    return [(i["handle"], i["suggestedLayer"], i.get("params")) for i in items]


def test_three_new_blocking_error_codes_mirror_the_contract() -> None:
    assert len(PROBLEM_CODES) == 19
    assert PROBLEM_CODES[-3:] == NEW_CODES
    for code in NEW_CODES:
        assert SEVERITY[code] == "error" and BLOCKS[code]


# ---------- Q2: handhole type aliases confirmed by the PM ----------

HH_ALIAS_RULES: list[dict[str, object]] = [
    {
        **r,
        "handholeTypeAliases": {" hh2 ": "HH-II", "MH1": "MH-I"},
    }
    if r["layer"] == "HHT"
    else r
    for r in GENERAL_RULES
]


def test_handhole_type_aliases_are_parsed_on_the_handhole_type_layer() -> None:
    rules = parse_rules(HH_ALIAS_RULES)
    assert rules.handhole_type_aliases == {"HHT": {"HH2": "HH-II", "MH1": "MH-I"}}
    assert rules.confirmed_handhole_type("HHT", "Hh2") == "HH-II"
    assert rules.confirmed_handhole_type("CRO", "HH2") is None


@pytest.mark.parametrize(
    "aliases",
    [
        {"HH2": "HH-9"},
        {"": "DH"},
        {"   ": "DH"},
        {"A" * 17: "DH"},
        ["HH2"],
        {f"X{n}": "DH" for n in range(51)},
    ],
)
def test_invalid_handhole_type_aliases_are_refused(aliases: object) -> None:
    rule = {
        "source": "layer",
        "layer": "HHT",
        "target": "label",
        "textRoles": ["handhole_type"],
        "handholeTypeAliases": aliases,
    }
    with pytest.raises(MappingInvalidError):
        parse_rules([rule])


def test_handhole_type_aliases_need_the_handhole_type_role() -> None:
    rule = {
        "source": "layer",
        "layer": "CRO",
        "target": "label",
        "textRoles": ["handhole_number"],
        "handholeTypeAliases": {"HH2": "HH-II"},
    }
    with pytest.raises(MappingInvalidError):
        parse_rules([rule])
    with pytest.raises(MappingInvalidError):
        parse_rules([{"source": "layer", "layer": "X", "target": "hhi", "handholeTypeAliases": {}}])


def test_a_confirmed_spelling_reads_as_its_list_type() -> None:
    drawing = with_text(general_drawing(), "H1T", "HH2")
    assert brief(places(drawing, "general")["HANDHOLE_TYPE_UNKNOWN"]) == [
        ("H1T", None, {"found": "HH2", "featureHandle": "H1"})
    ]
    found = places(drawing, "general", HH_ALIAS_RULES)
    assert "HANDHOLE_TYPE_UNKNOWN" not in found
    reading, features = read(drawing, HH_ALIAS_RULES, "general")
    h1 = next(f for f in features if f.source_handle == "H1")
    assert reading.reading_of(h1.key)["type"] == "HH-II"
    assert reading.reading_of(h1.key)["typeText"] == "HH2"
    build = compose(drawing, HH_ALIAS_RULES, "general")
    assert build.reading_totals is not None
    assert build.reading_totals["handholes"] == [
        {"type": "DH", "count": 1},
        {"type": "HH-II", "count": 1},
    ]


def test_an_alias_never_overrides_a_list_type_nor_another_layer() -> None:
    # «HH1» is a list spelling (HH-I): an alias for it is not used.
    rules = [
        {**r, "handholeTypeAliases": {"HH1": "MH-IV"}} if r["layer"] == "HHT" else r
        for r in GENERAL_RULES
    ]
    reading, features = read(general_drawing(), rules, "general")
    h1 = next(f for f in features if f.source_handle == "H1")
    assert reading.reading_of(h1.key)["type"] == "HH-I"
    # The alias of another handhole_type layer does not apply to texts on HHT.
    other: list[dict[str, object]] = [
        *GENERAL_RULES,
        {
            "source": "layer",
            "layer": "HHT2",
            "target": "label",
            "textRoles": ["handhole_type"],
            "handholeTypeAliases": {"HH2": "HH-II"},
        },
    ]
    found = places(with_text(general_drawing(), "H1T", "HH2"), "general", other)
    assert brief(found["HANDHOLE_TYPE_UNKNOWN"]) == [
        ("H1T", None, {"found": "HH2", "featureHandle": "H1"})
    ]


def test_conflicting_spellings_of_one_alias_stay_unconfirmed() -> None:
    rules = [
        {**r, "handholeTypeAliases": {"HH2": "HH-II", "hh2": "MH-II"}} if r["layer"] == "HHT" else r
        for r in GENERAL_RULES
    ]
    found = places(with_text(general_drawing(), "H1T", "HH2"), "general", rules)
    assert [i["handle"] for i in found["HANDHOLE_TYPE_UNKNOWN"]] == ["H1T"]


# ---------- Q3: routes without their bundle label / cable label ----------


def test_a_route_with_no_bundle_label() -> None:
    found = places(without(secondary_drawing(), "T2", "M2"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [("D2", "txt ftth", {"role": "bundle_label"})]
    # Its length alone is not its label; no LABEL_LENGTH_MISSING (that one needs a type text).
    found = places(without(secondary_drawing(), "T1"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [("D1", "txt ftth", {"role": "bundle_label"})]
    assert "LABEL_LENGTH_MISSING" not in found
    found = places(without(general_drawing(), "B-BR"), "general")
    assert ("BRANCH", "EXCH", {"role": "bundle_label"}) in brief(found["LABEL_MISSING"])


def test_a_general_segment_with_no_cable_label() -> None:
    found = places(without(general_drawing(), "C-BR"), "general")
    assert ("BRANCH", "EXCH", {"role": "cable_label"}) in brief(found["LABEL_MISSING"])
    # One place per route: with neither label only the bundle label is asked for first.
    found = places(without(general_drawing(), "C-BR", "B-BR"), "general")
    route_places = [p for p in brief(found["LABEL_MISSING"]) if p[0] == "BRANCH"]
    assert route_places == [("BRANCH", "EXCH", {"role": "bundle_label"})]
    # A Secondary does not read cable labels.
    assert "LABEL_MISSING" not in places(secondary_drawing(), "secondary")


def test_routes_on_a_layer_without_ways_need_no_label() -> None:
    rules: list[dict[str, object]] = [
        *SECONDARY_RULES,
        {"source": "layer", "layer": "trench", "target": "route"},
    ]
    drawing = secondary_drawing()
    drawing = DrawingData(
        (*drawing.curves, line("TR", "trench", (0, 200), (100, 200))),
        drawing.inserts,
        drawing.texts,
    )
    assert "LABEL_MISSING" not in places(drawing, "secondary", rules)


# ---------- Q4: spare cores per main cable ----------


def _second_network(drawing: DrawingData) -> DrawingData:
    """A 36-core main cable far from the first with one 12-core branch and «SP 24»."""
    return DrawingData(
        (
            *drawing.curves,
            line("MAIN2", "OOOOOO", (0, 2000), (500, 2000)),
            line("BRANCH2", "OOOOOO", (200, 2000), (200, 1700)),
        ),
        drawing.inserts,
        (
            *drawing.texts,
            text("B-MAIN2", "EXCH", "500M/4way 16/12", (100, 2003)),
            text("C-MAIN2", "EXCH", "520M/36Core F.O", (100, 2006)),
            text("B-BR2", "EXCH", "20M/4way 7/3.5", (203, 1850)),
            text("C-BR2", "EXCH", "50M/12Core F.O", (206, 1853)),
            text("SP2", "EXCH", "SP 24", (300, 2003)),
        ),
    )


def test_each_main_cable_counts_only_the_branches_leaving_it() -> None:
    found = places(_second_network(general_drawing()), "general")
    # The provisional rule summed every smaller cable of the drawing (144 - 12 - 36 - 12 = 84).
    assert "SPARE_CORES_MISMATCH" not in found
    found = places(with_text(_second_network(general_drawing()), "SP2", "SP 12"), "general")
    assert brief(found["SPARE_CORES_MISMATCH"]) == [
        ("SP2", None, {"expected": "24", "found": "12", "mainCores": 36, "featureHandle": "MAIN2"})
    ]


def _main_cut_at_a_handhole() -> DrawingData:
    """The 144 main drawn in two pieces stopping 3.6 m short of handhole 04B; a branch leaves
    each piece; «SP 120» = 144 - 12 - 12 on the first piece."""
    drawing = general_drawing()
    curves = (
        line("MAIN", "OOOOOO", (0, 0), (397, 0)),
        line("MAIN-B", "OOOOOO", (403, 0), (500, 0)),
        line("BRANCH", "OOOOOO", (200, 0), (200, -300)),
        line("BR2", "OOOOOO", (480, 0), (480, -300)),
    )
    inserts = tuple(
        i if i.handle != "H2" else insert("H2", "HH", (400, 2)) for i in drawing.inserts
    )
    texts = (
        *(t for t in drawing.texts if t.handle != "SP"),
        text("SP", "EXCH", "SP 120", (300, 3)),
        text("B-MB", "EXCH", "100M/4way 16/12", (430, 3)),
        text("C-MB", "EXCH", "120M/144Core F.O", (430, 6)),
        text("B-BR2", "EXCH", "20M/4way 7/3.5", (483, -150)),
        text("C-BR2", "EXCH", "50M/12Core F.O", (486, -147)),
    )
    return DrawingData(curves, inserts, texts)


def test_a_main_cable_continues_through_a_handhole_or_joint() -> None:
    found = places(_main_cut_at_a_handhole(), "general")
    assert "SPARE_CORES_MISMATCH" not in found
    # Without the handhole the two pieces are two cables: the first sees one branch only.
    found = places(without(_main_cut_at_a_handhole(), "H2", "H2N", "H2T"), "general")
    assert brief(found["SPARE_CORES_MISMATCH"]) == [
        ("SP", None, {"expected": "132", "found": "120", "mainCores": 144, "featureHandle": "MAIN"})
    ]


# ---------- Q5: box cabinet unknown, cabinet box count, box cable ----------


def test_a_box_naming_a_cabinet_not_in_the_drawing() -> None:
    found = places(with_text(secondary_drawing(), "K2", "1-4"), "secondary")
    assert brief(found["BOX_CABINET_UNKNOWN"]) == [
        ("K2", None, {"cabinet": "1-4", "featureHandle": "B2"})
    ]
    assert found["BOX_CABINET_UNKNOWN"][0]["text"] == "1-4"
    assert "BOX_CABINET_UNKNOWN" not in places(secondary_drawing(), "secondary")
    # Spelled with spaces it is the same cabinet.
    assert "BOX_CABINET_UNKNOWN" not in places(
        with_text(secondary_drawing(), "K2", "1 - 3"), "secondary"
    )


def test_a_cabinet_with_no_written_box_count_gets_the_boxes_drawn_as_suggestion() -> None:
    found = places(without(secondary_drawing(), "C-BOXES"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [
        ("CAB", "CABINA", {"role": "cabinet_info", "field": "box_count", "suggested": "2"})
    ]
    # A General does not ask for the box count.
    rules: list[dict[str, object]] = [
        *GENERAL_RULES,
        {"source": "layer", "layer": "CABT", "target": "label", "textRoles": ["cabinet_info"]},
    ]
    drawing = general_drawing()
    named = DrawingData(
        drawing.curves, drawing.inserts, (*drawing.texts, text("SAPN", "CABT", "1-1", (200, -315)))
    )
    assert "LABEL_MISSING" not in places(named, "general", rules)


def test_a_box_without_its_cable_type_or_length() -> None:
    found = places(without(secondary_drawing(), "F1", "L2"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [
        ("B1", "txtbox", {"role": "box_cable_type"}),
        ("B2", "TXTLINTH", {"role": "box_cable_length"}),
    ]
    # One place per box: its identity (cabinet, number) is asked for first.
    found = places(without(secondary_drawing(), "F1", "K1"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [("B1", "TXTCAP", {"role": "box_cabinet"})]


# ---------- Q6: two cabinets with one name ----------


def _two_cabinets(second_name: str) -> DrawingData:
    drawing = secondary_drawing()
    return DrawingData(
        drawing.curves,
        (*drawing.inserts, insert("CAB2", "sub", (90, 40), "sub")),
        (
            *drawing.texts,
            text("C2-NAME", "CABINA", second_name, (90, 43)),
            text("C2-TYPE", "CABINA", "22U", (90, 45)),
            text("C2-BOXES", "CABINA", "0B", (90, 47)),
        ),
    )


def test_two_cabinets_with_the_same_name() -> None:
    found = places(_two_cabinets("1 - 3"), "secondary")
    assert brief(found["CABINET_NAME_DUPLICATE"]) == [
        ("C-NAME", None, {"cabinet": "1-3", "featureHandle": "CAB"}),
        ("C2-NAME", None, {"cabinet": "1-3", "featureHandle": "CAB2"}),
    ]
    assert "CABINET_NAME_DUPLICATE" not in places(_two_cabinets("1-4"), "secondary")


# ---------- Q7: box numbers equal once leading zeros are dropped ----------


def test_box_numbers_09_and_9_are_one_number() -> None:
    found = places(with_text(secondary_drawing(), "N2", "01"), "secondary")
    params = {"cabinet": "1-3", "boxNumber": "1", "found": "01, 1"}
    assert brief(found["BOX_NUMBER_DUPLICATE"]) == [
        ("N1", None, {**params, "featureHandle": "B1"}),
        ("N2", None, {**params, "featureHandle": "B2"}),
    ]
    found = places(with_text(with_text(secondary_drawing(), "N1", "00"), "N2", "0"), "secondary")
    assert [i["params"]["boxNumber"] for i in found["BOX_NUMBER_DUPLICATE"]] == ["0", "0"]  # type: ignore[index]
    assert "BOX_NUMBER_DUPLICATE" not in places(
        with_text(secondary_drawing(), "N2", "10"), "secondary"
    )


# ---------- Q8: connector size from the 1way label ----------


def test_a_1way_label_without_duct_size() -> None:
    found = places(with_text(secondary_drawing(), "T2", "1way"), "secondary")
    assert brief(found["CONNECTOR_SIZE_MISSING"]) == [("T2", None, {"featureHandle": "D2"})]
    # A 1way with no label at all is a missing label, not a missing size.
    found = places(without(secondary_drawing(), "T2", "M2"), "secondary")
    assert "CONNECTOR_SIZE_MISSING" not in found
    # Other bundles take no connector.
    found = places(with_text(secondary_drawing(), "T12", "12way"), "secondary")
    assert "CONNECTOR_SIZE_MISSING" not in found
