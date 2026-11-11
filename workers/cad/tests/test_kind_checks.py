"""The ADR-040 checks of the General and the Secondary (ADR-041 part F), through compose_design."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from cad_worker.application.build_revision import _summary, compose_design
from cad_worker.domain.corrections import apply_corrections, parse_corrections
from cad_worker.domain.design_build import DrawingData
from cad_worker.domain.drawing_checks import BLOCKS, PROBLEM_CODES, SEVERITY
from cad_worker.domain.placement import unit_placer
from tests.support.reading_scenes import (
    GENERAL_RULES,
    SECONDARY_RULES,
    compose,
    general_drawing,
    insert,
    line,
    problems_of,
    rules_of,
    secondary_drawing,
    text,
    with_text,
    without,
)


def places(drawing: DrawingData, kind: str) -> dict[str, list[dict[str, object]]]:
    rules = SECONDARY_RULES if kind == "secondary" else GENERAL_RULES
    return problems_of(compose(drawing, rules, kind))  # type: ignore[arg-type]


def brief(items: list[dict[str, object]]) -> list[tuple[object, ...]]:
    return [(i["handle"], i["suggestedLayer"], i.get("params")) for i in items]


def test_severities_and_blocking_mirror_the_contract() -> None:
    assert len(PROBLEM_CODES) == 16
    assert [c for c in PROBLEM_CODES if not BLOCKS[c]] == ["CABLE_SLACK_TOO_LONG"]
    assert SEVERITY["CABLE_SLACK_TOO_LONG"] == "warning"
    assert SEVERITY["ROUTE_SPLIT"] == "warning" and BLOCKS["ROUTE_SPLIT"]
    assert all(SEVERITY[c] == "error" for c in PROBLEM_CODES[6:15])


def test_clean_drawings_have_no_problems() -> None:
    assert places(secondary_drawing(), "secondary") == {}
    general = places(general_drawing(), "general")
    # CH01 is written with no handhole drawn; the cabinet has no name (no cabinet_info layer).
    assert set(general) == {"HANDHOLE_NOT_DRAWN", "LABEL_MISSING"}
    assert brief(general["HANDHOLE_NOT_DRAWN"]) == [("CRO", "HH", {"role": "handhole_number"})]
    assert brief(general["LABEL_MISSING"]) == [
        ("SAP", None, {"role": "cabinet_info", "field": "name"})
    ]


def test_bundle_label_type_contradicting_its_line_layer() -> None:
    found = places(with_text(secondary_drawing(), "T12", "7way 7/3.5"), "secondary")
    item = found["LABEL_TYPE_MISMATCH"][0]
    assert (item["handle"], item["layer"], item["text"]) == ("T12", "txt ftth", "7way 7/3.5")
    assert item["params"] == {
        "role": "bundle_label",
        "expected": "12",
        "found": "7",
        "featureHandle": "R12",
    }


def test_missing_role_texts_name_the_symbol_and_the_layer_to_type_on() -> None:
    found = places(without(secondary_drawing(), "K1", "N2", "C-NAME"), "secondary")
    assert brief(found["LABEL_MISSING"]) == [
        ("B1", "TXTCAP", {"role": "box_cabinet"}),
        ("B2", "TXTNMPER", {"role": "box_number"}),
        ("CAB", "CABINA", {"role": "cabinet_info", "field": "name"}),
    ]


def test_a_bundle_type_without_its_length_and_a_cable_label_without_length() -> None:
    found = places(without(secondary_drawing(), "M1"), "secondary")
    assert brief(found["LABEL_LENGTH_MISSING"]) == [
        ("T1", None, {"role": "bundle_label", "featureHandle": "D1"})
    ]
    found = places(with_text(general_drawing(), "C-BR", "12Core F.O"), "general")
    assert brief(found["LABEL_LENGTH_MISSING"]) == [
        ("C-BR", None, {"role": "cable_label", "featureHandle": "BRANCH"})
    ]
    # The combined «455M/12way 7/3.5» form carries its length.
    found = places(
        with_text(without(secondary_drawing(), "M12"), "T12", "455M/12way 7/3.5"), "secondary"
    )
    assert "LABEL_LENGTH_MISSING" not in found


def test_handhole_type_missing_and_unknown() -> None:
    found = places(with_text(without(general_drawing(), "H2T"), "H1T", "HH3"), "general")
    assert brief(found["HANDHOLE_TYPE_MISSING"]) == [("H2", "HHT", {"role": "handhole_type"})]
    assert brief(found["HANDHOLE_TYPE_UNKNOWN"]) == [
        ("H1T", None, {"found": "HH3", "featureHandle": "H1"})
    ]


def test_handhole_number_with_a_symbol_in_reach_is_drawn() -> None:
    drawing = general_drawing()
    moved = DrawingData(
        drawing.curves,
        (*drawing.inserts, insert("H3", "HH", (100, 90))),
        drawing.texts,
    )
    found = places(moved, "general")
    assert "HANDHOLE_NOT_DRAWN" not in found
    # H3 now has a number but no type.
    assert brief(found["HANDHOLE_TYPE_MISSING"]) == [("H3", "HHT", {"role": "handhole_type"})]


def test_two_boxes_with_one_number_under_one_cabinet() -> None:
    found = places(with_text(secondary_drawing(), "N2", "1"), "secondary")
    assert brief(found["BOX_NUMBER_DUPLICATE"]) == [
        ("N1", None, {"cabinet": "1-3", "boxNumber": "1", "featureHandle": "B1"}),
        ("N2", None, {"cabinet": "1-3", "boxNumber": "1", "featureHandle": "B2"}),
    ]
    # Same number under another cabinet is fine.
    assert "BOX_NUMBER_DUPLICATE" not in places(
        with_text(with_text(secondary_drawing(), "N2", "1"), "K2", "1-4"), "secondary"
    )


def test_a_box_no_1way_reaches() -> None:
    found = places(without(secondary_drawing(), "D2", "T2", "M2"), "secondary")
    assert brief(found["BOX_NOT_REACHED"]) == [("B2", None, None)]


def test_cabinet_box_count_and_zone() -> None:
    found = places(with_text(secondary_drawing(), "C-BOXES", "3B"), "secondary")
    assert brief(found["CABINET_BOX_COUNT_MISMATCH"]) == [
        ("C-BOXES", None, {"expected": "3", "found": "2", "featureHandle": "CAB", "cabinet": "1-3"})
    ]
    found = places(without(secondary_drawing(), "Z1", "Z2"), "secondary")
    assert brief(found["CABINET_ZONE_MISSING"]) == [("CAB", None, None)]
    # Without any zone layer mapped every cabinet lacks its zone.
    rules = [r for r in SECONDARY_RULES if r["target"] != "zone"]
    found = problems_of(compose(secondary_drawing(), rules, "secondary"))
    assert brief(found["CABINET_ZONE_MISSING"]) == [("CAB", None, None)]


def test_spare_cores_written_against_main_minus_branches() -> None:
    found = places(with_text(general_drawing(), "SP", "SP 48"), "general")
    assert brief(found["SPARE_CORES_MISMATCH"]) == [
        ("SP", None, {"expected": "132", "found": "48", "mainCores": 144, "featureHandle": "MAIN"})
    ]


@pytest.mark.parametrize(
    ("written", "code", "slack"),
    [
        ("514", "CABLE_SLACK_TOO_SHORT", "14.000"),
        ("490", "CABLE_SLACK_TOO_SHORT", "-10.000"),
        ("515", None, None),
        ("530", None, None),
        ("530.5", "CABLE_SLACK_TOO_LONG", "30.500"),
    ],
)
def test_cable_slack_thresholds_15_and_30_pass(
    written: str, code: str | None, slack: str | None
) -> None:
    cable = f"{written}M/144Core F.O"
    found = places(with_text(general_drawing(), "C-MAIN", cable), "general")
    slack_codes = {c for c in found if c.startswith("CABLE_SLACK")}
    if code is None:
        assert slack_codes == set()
        return
    assert slack_codes == {code}
    item = found[code][0]
    assert item["handle"] == "C-MAIN"
    assert item["params"] == {
        "cableLengthM": format(Decimal(written).quantize(Decimal("0.001")), "f"),
        "bundleLengthM": "500.000",
        "slackM": slack,
        "featureHandle": "MAIN",
    }


def test_too_long_is_a_warning_in_the_stored_problems() -> None:
    build = compose(
        with_text(general_drawing(), "C-MAIN", "600M/144Core"), GENERAL_RULES, "general"
    )
    stored = {p["code"]: p["severity"] for p in build.problems}
    assert stored["CABLE_SLACK_TOO_LONG"] == "warning"


def test_checks_run_per_drawing_kind() -> None:
    # The Secondary's checks do not run on a General and the other way round.
    secondary_as_general = problems_of(compose(secondary_drawing(), SECONDARY_RULES, "general"))
    assert not {"BOX_NOT_REACHED", "CABINET_BOX_COUNT_MISMATCH"} & set(secondary_as_general)
    # A General asks for no box numbers (the General's roles have none).
    assert all(
        i["params"] != {"role": "box_number"} for i in secondary_as_general.get("LABEL_MISSING", [])
    )
    general_as_secondary = problems_of(compose(general_drawing(), GENERAL_RULES, "secondary"))
    assert not {"HANDHOLE_NOT_DRAWN", "SPARE_CORES_MISMATCH"} & set(general_as_secondary)


def test_roles_mode_build_stores_readings_codes_totals_and_no_role_text_links() -> None:
    build = compose(secondary_drawing(), SECONDARY_RULES, "secondary")
    rows = {f.source_handle: f for f in build.rows.features}
    assert rows["B1"].code == "1-3/1" and rows["CAB"].code == "1-3"
    assert rows["B1"].attrs["reading"]["of"] == "box"  # type: ignore[index]
    assert rows["R12"].attrs["kind"] == "12way"
    assert build.rows.text_links == ()
    assert build.reading_totals is not None
    assert build.reading_totals["drawingKind"] == "secondary"
    summary = _summary("m", Decimal(1), build, Decimal(0), None, [])
    assert summary.counts["reading"] == build.reading_totals
    assert "CABLE_SLACK_TOO_LONG" not in summary.log


def test_legacy_mode_stores_no_reading() -> None:
    rules = [
        {k: v for k, v in r.items() if k not in ("textRoles", "ways")}
        for r in SECONDARY_RULES
        if r["target"] != "zone"
    ]
    build = compose(secondary_drawing(), rules, "secondary")
    assert build.reading_totals is None
    assert all("reading" not in f.attrs for f in build.rows.features)
    # Phase 1: box code = nearest N-N text (both boxes see «1-3»), texts linked for review.
    assert {f.source_handle: f.code for f in build.rows.features if f.feature_type == "box"} == {
        "B1": "1-3",
        "B2": "1-3",
    }
    assert build.rows.text_links
    assert all("params" not in i for p in build.problems for i in p["items"])  # type: ignore[attr-defined]


def test_role_layers_are_left_out_of_phase1_label_pairing() -> None:
    # CABINA texts on the cabinet layer itself: Phase 1 would pair them as cabinet labels.
    rules = [
        {
            "source": "layer",
            "layer": "sub",
            "target": "cabinet",
            "role": "sub",
            "textRoles": ["cabinet_info"],
        }
        if r["layer"] == "sub"
        else r
        for r in SECONDARY_RULES
        if r["layer"] != "CABINA"
    ]
    drawing = secondary_drawing()
    moved = DrawingData(
        drawing.curves,
        drawing.inserts,
        tuple(
            t if t.layer != "CABINA" else text(t.handle, "sub", t.text, t.position)
            for t in drawing.texts
        ),
    )
    build = compose(moved, rules, "secondary")
    assert problems_of(build) == {}
    assert {f.source_handle: f.code for f in build.rows.features}["CAB"] == "1-3"


def test_corrections_fix_role_texts_before_reading() -> None:
    drawing = with_text(secondary_drawing(), "C-BOXES", "3B")
    rules = rules_of(SECONDARY_RULES)
    fixed = apply_corrections(
        drawing,
        parse_corrections(
            [
                {
                    "id": str(uuid.UUID(int=1)),
                    "correction": {"kind": "set_text", "handle": "C-BOXES", "text": "2B"},
                },
                {
                    "id": str(uuid.UUID(int=2)),
                    "correction": {"kind": "move_layer", "handle": "SP", "toLayer": "txt ftth"},
                },
                {
                    "id": str(uuid.UUID(int=3)),
                    "correction": {
                        "kind": "add_text",
                        "layer": "sp txt",
                        "x": 1,
                        "y": 1,
                        "text": "SP2(7/3.5)",
                        "height": None,
                    },
                },
            ]
        ),
        metres_per_unit=1.0,
        move_targets=rules.layers_with("route", "box", "cabinet", "label"),
    )
    build = compose_design(fixed, rules, unit_placer(1.0), (), uuid.uuid4, "secondary")
    assert problems_of(build) == {}
    assert build.reading_totals is not None
    # SP3 moved to a bundle_label layer means nothing there; the added SP2 counts.
    assert build.reading_totals["spares"] == [{"ductSize": "7/3.5", "singles": 2, "endCaps": 4}]


def test_a_unit_scale_is_applied_to_role_text_radius() -> None:
    drawing = DrawingData(
        (line("A", "OOOOOO", (0, 0), (1000, 0)),),
        (),
        (text("B", "EXCH", "500M/4way 16/12", (500, 15), height=1.0),),
    )
    rules = rules_of(GENERAL_RULES)
    # 1 unit = 1 cm: the text is 0.15 m from the line and 0.01 m high (radius = 1 m minimum).
    build = compose_design(drawing, rules, unit_placer(0.01), (), uuid.uuid4, "general")
    reading = {f.source_handle: f.attrs.get("reading") for f in build.rows.features}["A"]
    assert reading is not None and reading["writtenLengthM"] == "500.000"  # type: ignore[index]
