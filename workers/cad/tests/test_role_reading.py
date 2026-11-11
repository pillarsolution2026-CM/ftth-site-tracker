"""Reading by meaning (ADR-041): role text linking, readings, codes, connectors, zones, totals."""

from __future__ import annotations

from cad_worker.domain.design import DesignFeatureDraft
from cad_worker.domain.design_build import DrawingData
from cad_worker.domain.role_reading import CONNECTOR_TOUCH_M, Reading, reading_totals
from tests.support.reading_scenes import (
    GENERAL_RULES,
    SECONDARY_RULES,
    general_drawing,
    insert,
    line,
    read,
    secondary_drawing,
    text,
    with_text,
    without,
)


def by_handle(reading: Reading, features: list[DesignFeatureDraft]) -> dict[str, dict[str, object]]:
    return {f.source_handle: reading.readings[f.key] for f in features if f.key in reading.readings}


def codes(reading: Reading, features: list[DesignFeatureDraft]) -> dict[str, str | None]:
    return {f.source_handle: reading.codes[f.key] for f in features if f.key in reading.codes}


def test_secondary_readings_codes_and_texts() -> None:
    reading, features = read(secondary_drawing(), SECONDARY_RULES, "secondary")
    r = by_handle(reading, features)
    assert r["B1"] == {
        "of": "box",
        "cabinet": "1-3",
        "number": "1",
        "cableCores": 4,
        "cableLengthM": "60.000",
        "texts": {
            "box_cable_type": ["F1"],
            "box_cable_length": ["L1"],
            "box_cabinet": ["K1"],
            "box_number": ["N1"],
        },
    }
    assert codes(reading, features) == {"B1": "1-3/1", "B2": "1-3/2", "CAB": "1-3"}
    assert r["CAB"] == {
        "of": "cabinet",
        "name": "1-3",
        "type": "22U",
        "boxCount": 2,
        "ports": 1,
        "boxesDrawn": 2,
        "zoneHandle": "Z1",
        "texts": {"cabinet_info": ["C-NAME", "C-TYPE", "C-BOXES", "C-PORTS"]},
    }
    assert r["R12"] == {
        "of": "route",
        "ways": 12,
        "labelWays": 12,
        "ductSize": "7/3.5",
        "writtenLengthM": "455.000",
        "cableCores": None,
        "cableLengthM": None,
        "spareCores": None,
        "spares": [{"count": 3, "ductSize": "7/3.5"}],
        "connectors": 0,
        "texts": {"bundle_spare": ["SP"], "bundle_label": ["T12", "M12"]},
    }
    # Type text and length-only text both go to the drop (one each).
    assert r["D1"]["labelWays"] == 1 and r["D1"]["writtenLengthM"] == "10.000"
    assert r["D2"]["writtenLengthM"] == "15.000"


def test_two_drops_from_one_point_are_two_connectors() -> None:
    drawing = secondary_drawing()
    curves = tuple(
        line("D2", "1way", (50, 0), (60, 28.8)) if c.handle == "D2" else c for c in drawing.curves
    )
    reading, features = read(
        DrawingData(curves, drawing.inserts, drawing.texts), SECONDARY_RULES, "secondary"
    )
    r = by_handle(reading, features)
    assert (r["D1"]["connectors"], r["D2"]["connectors"]) == (1, 1)
    totals = reading_totals(reading, features)
    assert totals["connectors"] == [{"ductSize": "7/3.5", "count": 2}]


def test_a_drop_end_near_but_off_the_bundle_is_no_connector() -> None:
    off = CONNECTOR_TOUCH_M + 0.01
    drawing = secondary_drawing()
    curves = tuple(
        line("D1", "1way", (50, off), (40, 28.8)) if c.handle == "D1" else c for c in drawing.curves
    )
    reading, features = read(
        DrawingData(curves, drawing.inserts, drawing.texts), SECONDARY_RULES, "secondary"
    )
    assert by_handle(reading, features)["D1"]["connectors"] == 0


def test_a_1way_between_two_bundles_counts_both_ends_and_1way_to_1way_counts_none() -> None:
    drawing = secondary_drawing()
    extra = (
        line("R12B", "12way", (0, 20), (30, 20)),
        line("BRIDGE", "1way", (10, 0), (10, 20)),
        line("TAIL", "1way", (40, 28.8), (35, 40)),  # leaves a 1way only
    )
    reading, features = read(
        DrawingData((*drawing.curves, *extra), drawing.inserts, drawing.texts),
        SECONDARY_RULES,
        "secondary",
    )
    r = by_handle(reading, features)
    assert r["BRIDGE"]["connectors"] == 2
    assert r["TAIL"]["connectors"] == 0


def test_one_text_per_feature_per_role_nearest_first() -> None:
    # A second number text further from B1 than N1, nearer than anything else: it stays unlinked.
    drawing = secondary_drawing()
    extra = text("N1B", "TXTNMPER", "7", (40, 36))
    reading, features = read(
        DrawingData(drawing.curves, drawing.inserts, (*drawing.texts, extra)),
        SECONDARY_RULES,
        "secondary",
    )
    assert by_handle(reading, features)["B1"]["number"] == "1"
    assert "N1B" not in reading.text_feature


def test_a_route_takes_at_most_two_spares() -> None:
    drawing = secondary_drawing()
    extra = (
        text("SP2", "sp txt", "SP2(7/3.5)", (1, 1)),
        text("SP4", "sp txt", "SP4(7/3.5)", (90, 1)),
    )
    reading, features = read(
        DrawingData(drawing.curves, drawing.inserts, (*drawing.texts, *extra)),
        SECONDARY_RULES,
        "secondary",
    )
    spares = by_handle(reading, features)["R12"]["spares"]
    assert spares == [{"count": 3, "ductSize": "7/3.5"}, {"count": 2, "ductSize": "7/3.5"}]
    assert reading_totals(reading, features)["spares"] == [
        {"ductSize": "7/3.5", "singles": 5, "endCaps": 10}
    ]


def test_a_box_belongs_to_the_cabinet_written_on_it() -> None:
    drawing = with_text(secondary_drawing(), "K2", "1-4")
    reading, features = read(drawing, SECONDARY_RULES, "secondary")
    assert codes(reading, features)["B2"] == "1-4/2"
    assert by_handle(reading, features)["CAB"]["boxesDrawn"] == 1


def test_unread_texts_mean_nothing() -> None:
    drawing = with_text(secondary_drawing(), "N1", "box one")
    reading, features = read(drawing, SECONDARY_RULES, "secondary")
    assert by_handle(reading, features)["B1"]["number"] is None
    assert codes(reading, features)["B1"] is None
    assert reading.unread_texts == 1


def test_zones_open_lines_hull_and_the_smallest_wins() -> None:
    drawing = secondary_drawing()
    small = (
        line("Z3", "ZOUN", (-15, -5), (-5, -5), (-5, 5)),
        line("Z4", "ZOUN", (-5, 5), (-15, 5)),  # touches Z3; open on the left side
    )
    reading, features = read(
        DrawingData((*drawing.curves, *small), drawing.inserts, drawing.texts),
        SECONDARY_RULES,
        "secondary",
    )
    assert by_handle(reading, features)["CAB"]["zoneHandle"] == "Z3"
    assert {z.handle for z in reading.zones} == {"Z1", "Z3"}
    reading, features = read(without(drawing, "Z1", "Z2"), SECONDARY_RULES, "secondary")
    assert by_handle(reading, features)["CAB"]["zoneHandle"] is None


def test_secondary_totals() -> None:
    reading, features = read(secondary_drawing(), SECONDARY_RULES, "secondary")
    assert reading_totals(reading, features) == {
        "drawingKind": "secondary",
        "bundles": [
            {
                "ways": 1,
                "ductSize": "7/3.5",
                "count": 2,
                "writtenLengthM": "25.000",
                "withoutLength": 0,
            },
            {
                "ways": 12,
                "ductSize": "7/3.5",
                "count": 1,
                "writtenLengthM": "455.000",
                "withoutLength": 0,
            },
        ],
        "connectors": [{"ductSize": "7/3.5", "count": 2}],
        "spares": [{"ductSize": "7/3.5", "singles": 3, "endCaps": 6}],
        "cables": [],
        "handholes": [],
    }


def test_general_readings_cable_pairs_and_totals() -> None:
    reading, features = read(general_drawing(), GENERAL_RULES, "general")
    r = by_handle(reading, features)
    assert r["MAIN"] == {
        "of": "route",
        "ways": 4,
        "labelWays": 4,
        "ductSize": "16/12",
        "writtenLengthM": "500.000",
        "cableCores": 144,
        "cableLengthM": "520.000",
        "spareCores": 132,
        "spares": [],
        "connectors": 0,
        "texts": {"cable_spare": ["SP"], "cable_label": ["C-MAIN"], "bundle_label": ["B-MAIN"]},
    }
    assert r["H1"] == {
        "of": "hhi",
        "number": "04A",
        "type": "HH-I",
        "typeText": "HH1",
        "texts": {"handhole_type": ["H1T"], "handhole_number": ["H1N"]},
    }
    assert codes(reading, features) == {"H1": "04A", "H2": "04B", "SAP": None}
    assert r["SAP"]["boxesDrawn"] is None and r["SAP"]["zoneHandle"] is None
    assert [(p.bundle.handle, p.cable.handle, p.route) for p in reading.cable_pairs] == [
        ("B-MAIN", "C-MAIN", ("curve", "MAIN")),
        ("B-BR", "C-BR", ("curve", "BRANCH")),
    ]
    totals = reading_totals(reading, features)
    assert totals["cables"] == [
        {"cores": 12, "count": 1, "writtenLengthM": "50.000"},
        {"cores": 144, "count": 1, "writtenLengthM": "520.000"},
    ]
    assert totals["handholes"] == [{"type": "DH", "count": 1}, {"type": "HH-I", "count": 1}]
    assert totals["bundles"] == [
        {
            "ways": 4,
            "ductSize": "16/12",
            "count": 1,
            "writtenLengthM": "500.000",
            "withoutLength": 0,
        },
        {
            "ways": 4,
            "ductSize": "7/3.5",
            "count": 1,
            "writtenLengthM": "20.000",
            "withoutLength": 0,
        },
    ]


def test_a_cable_follows_its_bundle_label_on_a_line_carrying_two_segments() -> None:
    """Al-Fath: one polyline drawn through two segments carries two label pairs; the nearer cable
    text must not join the other segment's bundle text."""
    drawing = DrawingData(
        (line("LONG", "OOOOOO", (0, 0), (300, 0)),),
        (),
        (
            text("B1", "EXCH", "500M/4way 16/12", (100, 10.4)),
            text("C1", "EXCH", "520M/144Core F.O", (100, 4.0)),
            text("B2", "EXCH", "270M/4way 16/12", (108, 10.0)),
            text("C2", "EXCH", "290M/144Core F.O", (108, 4.3)),
        ),
    )
    reading, features = read(drawing, GENERAL_RULES, "general")
    pairs = {(p.bundle.handle, p.cable.handle) for p in reading.cable_pairs}
    assert pairs == {("B1", "C1"), ("B2", "C2")}
    r = by_handle(reading, features)["LONG"]
    # The route takes the nearest bundle text (B2) and the cable written with it (C2).
    assert (r["writtenLengthM"], r["cableLengthM"]) == ("270.000", "290.000")


def test_a_cable_without_its_bundle_text_goes_to_the_nearest_free_route() -> None:
    drawing = DrawingData(
        (line("A", "OOOOOO", (0, 0), (100, 0)),),
        (insert("X", "HH", (500, 500)),),
        (text("C", "EXCH", "50M/12Core F.O", (50, 3)),),
    )
    reading, features = read(drawing, GENERAL_RULES, "general")
    assert reading.cable_pairs == ()
    assert by_handle(reading, features)["A"]["cableCores"] == 12
