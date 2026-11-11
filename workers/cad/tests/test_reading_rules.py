"""Mapping rules with meaning (ADR-041): textRoles, ways, zone; the reading mode. Pure.

Mirror of the `mapping rules with meaning` cases of `text-roles.spec.ts`.
"""

from __future__ import annotations

import pytest

from cad_worker.domain.design_build import (
    DrawingData,
    MappingInvalidError,
    SourceCurve,
    SourceText,
    build_features,
    parse_rules,
)
from cad_worker.domain.placement import unit_placer


def test_accepts_text_roles_ways_and_zone_layers() -> None:
    rules = parse_rules(
        [
            {
                "source": "layer",
                "layer": "TXTNMPER",
                "target": "label",
                "textRoles": ["box_number"],
            },
            {
                "source": "layer",
                "layer": "CABINA",
                "target": "cabinet",
                "role": "sub",
                "textRoles": ["cabinet_info"],
            },
            {"source": "layer", "layer": "ftth", "target": "route", "kind": "1way", "ways": 1},
            {"source": "layer", "layer": "ZONE", "target": "zone"},
            {
                "source": "layer",
                "layer": "EXCH",
                "target": "label",
                "textRoles": ["cable_spare", "bundle_label", "cable_label"],
            },
        ]
    )
    assert rules.text_roles["TXTNMPER"] == ("box_number",)
    assert rules.text_roles["CABINA"] == ("cabinet_info",)
    # Kept in TEXT_ROLES order whatever the order of the rule.
    assert rules.text_roles["EXCH"] == ("cable_spare", "cable_label", "bundle_label")
    assert rules.ways == {"ftth": 1}
    assert rules.layers["ZONE"] == "zone"
    assert rules.curve_layers() == {"CABINA", "ftth", "ZONE"}
    assert rules.reading_mode == "roles"


@pytest.mark.parametrize(
    "rule",
    [
        {"source": "layer", "layer": "A", "target": "box", "textRoles": ["cabinet_info"]},
        {
            "source": "layer",
            "layer": "A",
            "target": "label",
            "textRoles": ["box_number", "box_number"],
        },
        {"source": "layer", "layer": "A", "target": "label", "textRoles": []},
        {"source": "layer", "layer": "A", "target": "label", "textRoles": ["street"]},
        {"source": "layer", "layer": "A", "target": "label", "textRoles": "box_number"},
        {"source": "layer", "layer": "A", "target": "box", "ways": 4},
        {"source": "layer", "layer": "A", "target": "route", "ways": 0},
        {"source": "layer", "layer": "A", "target": "route", "ways": 289},
        {"source": "layer", "layer": "A", "target": "route", "ways": True},
        {"source": "layer", "layer": "A", "target": "route", "ways": "4"},
        {"source": "layer", "layer": "A", "target": "zone", "kind": "x"},
        {"source": "layer", "layer": "A", "target": "zone", "status": "new"},
    ],
)
def test_refuses_roles_on_the_wrong_target_duplicates_ways_off_routes_attrs_on_zones(
    rule: dict[str, object],
) -> None:
    with pytest.raises(MappingInvalidError):
        parse_rules([rule])


def test_block_and_text_rules_carry_no_meaning() -> None:
    # zod strips unknown keys of block / text rules: they parse and carry no roles.
    rules = parse_rules(
        [
            {"source": "block", "block": "B", "target": "box", "textRoles": ["box_number"]},
            {"source": "text", "layer": "L", "text": "X", "target": "hhi", "ways": 3},
        ]
    )
    assert rules.text_roles == {} and rules.ways == {}
    assert rules.reading_mode == "legacy"


def test_keeps_old_mappings_in_legacy_reading_mode() -> None:
    legacy = [{"source": "layer", "layer": "BOX", "target": "box"}]
    zone = {"source": "layer", "layer": "Z", "target": "zone"}
    role = {"source": "layer", "layer": "T", "target": "label", "textRoles": ["box_cabinet"]}
    ways_only = {"source": "layer", "layer": "R", "target": "route", "ways": 4}
    assert parse_rules(legacy).reading_mode == "legacy"
    assert parse_rules([*legacy, ways_only]).reading_mode == "legacy"
    assert parse_rules([*legacy, zone]).reading_mode == "roles"
    assert parse_rules([*legacy, role]).reading_mode == "roles"
    # Legacy rules read the same curves as before (no zone layer).
    assert parse_rules(legacy).curve_layers() == {"BOX"}


def test_zone_curves_and_role_texts_are_never_features_nor_text_links() -> None:
    rules = parse_rules(
        [
            {"source": "layer", "layer": "BOX", "target": "box"},
            {"source": "layer", "layer": "NUM", "target": "label", "textRoles": ["box_number"]},
            {"source": "layer", "layer": "OLD", "target": "label"},
            {"source": "layer", "layer": "Z", "target": "zone"},
        ]
    )
    ring = ((0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 0.0))
    drawing = DrawingData(
        (SourceCurve("Z1", "Z", ring, True, "LWPOLYLINE"),),
        (),
        (
            SourceText("T1", "NUM", (1, 1), 1.0, "9", "9", True),
            SourceText("T2", "OLD", (1, 1), 1.0, "1-3", "1-3", True),
        ),
    )
    built = build_features(drawing, rules, unit_placer(1.0))
    assert built.features == ()
    assert [t.handle for t in built.link_texts] == ["T2"]
