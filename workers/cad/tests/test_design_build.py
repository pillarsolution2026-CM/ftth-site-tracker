"""Mapping rules -> design features (ADR-017 semantics, ADR-018 scaling). Pure."""

from __future__ import annotations

from decimal import Decimal

import pytest

from cad_worker.domain.design import polyline_length
from cad_worker.domain.design_build import (
    DrawingData,
    MappingInvalidError,
    SourceAttribute,
    SourceCurve,
    SourceInsert,
    SourceText,
    build_features,
    parse_rules,
)

METRE = Decimal("1")
INCH = Decimal("0.0254")


def text(handle: str, layer: str, value: str, xy: tuple[float, float] = (0, 0), *,
         readable: bool = True, height: float = 1.0) -> SourceText:  # fmt: skip
    return SourceText(handle, layer, xy, height, value, value, readable)


RULES = parse_rules(
    [
        {"source": "layer", "layer": "N_DUC_CBL", "target": "route"},
        {"source": "layer", "layer": "sub", "target": "box"},
        {"source": "layer", "layer": "jont", "target": "box"},
        {"source": "layer", "layer": "CAP F36", "target": "label"},
        {"source": "layer", "layer": "RRR", "target": "label"},
        {"source": "layer", "layer": "tx", "target": "background"},
        {"source": "layer", "layer": "junk", "target": "ignore"},
        {"source": "block", "block": "JONT 144", "target": "joint"},
        {"source": "block", "block": "tree", "target": "background"},
        {"source": "block", "block": "skip-me", "target": "ignore"},
        {"source": "text", "layer": "RRR", "text": "NEW-HHI", "target": "hhi"},
    ]
)


def test_parse_rules_tables() -> None:
    assert RULES.layers["N_DUC_CBL"] == "route" and RULES.blocks["JONT 144"] == "joint"
    assert RULES.text_rule("RRR", "  new-hhi ") == "hhi"
    assert RULES.text_rule("OTHER", "NEW-HHI") is None
    assert RULES.layers_with("background") == {"tx"}


@pytest.mark.parametrize(
    "raw",
    [
        "not a list",
        [{"source": "layer", "layer": "a", "target": "pipe"}],
        [{"source": "block", "block": "b", "target": "route"}],
        [{"source": "block", "block": "b", "target": "label"}],
        [{"source": "text", "layer": "a", "text": "x", "target": "label"}],
        [{"source": "text", "layer": "a", "text": "   ", "target": "hhi"}],
        [{"source": "layer", "layer": "", "target": "route"}],
        [{"source": "layer", "target": "route"}],
        [{"source": "zone", "layer": "a", "target": "route"}],
        ["layer"],
        [
            {"source": "layer", "layer": "a", "target": "route"},
            {"source": "layer", "layer": "a", "target": "box"},
        ],
        [
            {"source": "text", "layer": "a", "text": "X", "target": "hhi"},
            {"source": "text", "layer": "a", "text": " x ", "target": "mh"},
        ],
    ],
)
def test_invalid_rules_are_rejected(raw: object) -> None:
    with pytest.raises(MappingInvalidError):
        parse_rules(raw)


def test_block_rule_wins_over_layer_rule() -> None:
    drawing = DrawingData(
        curves=(),
        inserts=(
            SourceInsert("A1", "jont", "JONT 144", (1, 1)),  # layer says box, block says joint
            SourceInsert("A2", "jont", "plain", (2, 2)),  # no block rule: layer rule applies
            SourceInsert("A3", "sub", "skip-me", (3, 3)),  # block ignore beats layer box
            SourceInsert("A4", "sub", "tree", (4, 4)),  # block background beats layer box
            SourceInsert("A5", "nowhere", "JONT 144", (5, 5)),  # block rule on any layer
            SourceInsert("A6", "nowhere", "plain", (6, 6)),  # no rule at all: ignored
            SourceInsert("A7", "CAP F36", "36", (7, 7)),  # label layer: inserts are not features
        ),
        texts=(),
    )
    built = build_features(drawing, RULES, METRE)
    types = {f.source_handle: f.feature_type for f in built.features}
    assert types == {"A1": "joint", "A2": "box", "A5": "joint"}
    assert built.background.insert_handles == {"A4"}
    assert built.background.curve_layers == {"tx"}
    joint = next(f for f in built.features if f.source_handle == "A1")
    assert (joint.source_kind, joint.block_name, joint.coords) == ("insert", "JONT 144", ((1, 1),))


def test_insert_attributes_are_decoded_and_unreadable_values_never_guessed() -> None:
    attrs = (
        SourceAttribute("NAME", "S1", "S1", True),
        SourceAttribute("ST", "ahvU", "ahvU", False),
    )
    drawing = DrawingData((), (SourceInsert("B", "sub", "sub", (0, 0), attrs),), ())
    (feature,) = build_features(drawing, RULES, METRE).features
    assert feature.attrs == {
        "attributes": [
            {"tag": "NAME", "value": "S1", "rawValue": "S1", "readable": True},
            {"tag": "ST", "value": None, "rawValue": "ahvU", "readable": False},
        ]
    }


def test_text_rules_create_point_features_and_are_not_linked() -> None:
    drawing = DrawingData(
        curves=(),
        inserts=(),
        texts=(
            text("T1", "RRR", " new-hhi ", (10, 20)),
            text("T2", "CAP F36", "NEW-HHI"),  # other layer: just a label candidate
            text("T3", "RRR", "NEW-HHI", readable=False),  # unreadable never matches a rule
            text("T4", "RRR", "1-1"),
            text("T5", "tx", "street"),  # background layer: not a candidate
            text("T6", "unmapped", "F 36 C"),  # no rule: not a candidate
            text("T7", "N_DUC_CBL", "F 36 C"),  # feature layer: candidate
        ),
    )
    built = build_features(drawing, RULES, METRE)
    (hhi,) = built.features
    assert (hhi.feature_type, hhi.source_kind, hhi.source_handle) == ("hhi", "text", "T1")
    assert hhi.coords == ((10, 20),) and hhi.attrs == {"text": "new-hhi"}
    assert [t.handle for t in built.link_texts] == ["T2", "T3", "T4", "T7"]
    unreadable = next(t for t in built.link_texts if t.handle == "T3")
    assert unreadable.text is None and unreadable.raw_text == "NEW-HHI"


def test_routes_one_per_curve_and_zero_length_skipped() -> None:
    drawing = DrawingData(
        curves=(
            SourceCurve("C1", "N_DUC_CBL", ((0, 0), (3, 4))),
            SourceCurve("C2", "N_DUC_CBL", ((5, 5), (5, 5))),  # zero length
            SourceCurve("C3", "N_DUC_CBL", ((1, 1),)),  # single vertex
            SourceCurve("C4", "tx", ((0, 0), (1, 0))),  # background layer: tiles only
            SourceCurve("C5", "sub", ((0, 0), (1, 0))),  # point layer: curves ignored
        ),
        inserts=(),
        texts=(),
    )
    built = build_features(drawing, RULES, METRE)
    assert [f.source_handle for f in built.features] == ["C1"]
    assert built.zero_length_routes == 2
    assert polyline_length(built.features[0].coords) == 5.0


def test_every_coordinate_is_scaled_by_the_revision_factor() -> None:
    """ADR-018: inches (0.0254) scale lengths, positions and text heights alike."""
    drawing = DrawingData(
        curves=(SourceCurve("C1", "N_DUC_CBL", ((0, 0), (300, 400))),),
        inserts=(SourceInsert("B", "sub", "sub", (1000, 2000)),),
        texts=(text("T", "CAP F36", "1-1", (100, 100), height=2.5),),
    )
    metres = build_features(drawing, RULES, METRE)
    inches = build_features(drawing, RULES, INCH)
    route_m = polyline_length(metres.features[0].coords)
    route_in = polyline_length(inches.features[0].coords)
    assert route_m == 500.0 and route_in == pytest.approx(500.0 * 0.0254)
    assert inches.features[1].coords[0] == pytest.approx((25.4, 50.8))
    assert inches.link_texts[0].position == pytest.approx((2.54, 2.54))
    assert inches.link_texts[0].height_m == pytest.approx(2.5 * 0.0254)
