"""Small Secondary and General drawings read by meaning (ADR-041), in metres (1 unit = 1 m).

Every text is 1 m high (role radius 20 m); symbols are spaced so that each text is nearest to its
own feature. Tests change one text or one entity to make one problem.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import replace

from cad_worker.application.build_revision import DesignBuild, compose_design
from cad_worker.domain.design import DesignFeatureDraft
from cad_worker.domain.design_build import (
    DrawingData,
    MappingRules,
    SourceCurve,
    SourceInsert,
    SourceText,
    build_features,
    parse_rules,
)
from cad_worker.domain.placement import unit_placer
from cad_worker.domain.role_reading import Reading, read_drawing
from cad_worker.domain.text_roles import DrawingKind

Xy = tuple[float, float]


def line(handle: str, layer: str, *points: Xy) -> SourceCurve:
    return SourceCurve(handle, layer, tuple(points), False, "LWPOLYLINE")


def text(handle: str, layer: str, value: str, xy: Xy, height: float = 1.0) -> SourceText:
    return SourceText(handle, layer, xy, height, value, value, True)


def insert(handle: str, layer: str, xy: Xy, block: str = "sym") -> SourceInsert:
    return SourceInsert(handle, layer, block, xy)


SECONDARY_RULES: list[dict[str, object]] = [
    {"source": "layer", "layer": "BOX", "target": "box"},
    {"source": "layer", "layer": "TXTNMPER", "target": "label", "textRoles": ["box_number"]},
    {"source": "layer", "layer": "TXTCAP", "target": "label", "textRoles": ["box_cabinet"]},
    {"source": "layer", "layer": "txtbox", "target": "label", "textRoles": ["box_cable_type"]},
    {"source": "layer", "layer": "TXTLINTH", "target": "label", "textRoles": ["box_cable_length"]},
    {"source": "layer", "layer": "1way", "target": "route", "kind": "1way", "ways": 1},
    {"source": "layer", "layer": "12way", "target": "route", "kind": "12way", "ways": 12},
    {"source": "layer", "layer": "txt ftth", "target": "label", "textRoles": ["bundle_label"]},
    {"source": "layer", "layer": "sp txt", "target": "label", "textRoles": ["bundle_spare"]},
    {"source": "layer", "layer": "sub", "target": "cabinet", "role": "sub"},
    {"source": "layer", "layer": "CABINA", "target": "label", "textRoles": ["cabinet_info"]},
    {"source": "layer", "layer": "ZOUN", "target": "zone"},
]


def secondary_drawing() -> DrawingData:
    """Cabinet 1-3 (22U, 2B, 1P) at the start of a 12way bundle; two 1way drops leave the bundle
    to boxes 1 and 2; a spare SP3 at the bundle end; one zone of two open lines."""
    curves = (
        line("R12", "12way", (0, 0), (100, 0)),
        line("D1", "1way", (50, 0), (40, 28.8)),
        line("D2", "1way", (52, 0), (60, 28.8)),
        line("Z1", "ZOUN", (-20, -10), (110, -10), (110, 50)),
        line("Z2", "ZOUN", (110, 50), (-20, 50), (-20, -10)),
    )
    inserts = (
        insert("CAB", "sub", (-10, 0), "sub"),
        insert("B1", "BOX", (40, 30), "box c"),
        insert("B2", "BOX", (60, 30), "box c"),
    )
    texts = (
        text("C-NAME", "CABINA", "1-3", (-10, 3)),
        text("C-TYPE", "CABINA", "22U", (-10, 5)),
        text("C-BOXES", "CABINA", "2B", (-10, 7)),
        text("C-PORTS", "CABINA", "1P", (-10, 9)),
        text("N1", "TXTNMPER", "1", (40, 33)),
        text("K1", "TXTCAP", "1-3", (42, 33)),
        text("F1", "txtbox", "F4C", (38, 33)),
        text("L1", "TXTLINTH", "60M", (40, 35)),
        text("N2", "TXTNMPER", "2", (60, 33)),
        text("K2", "TXTCAP", "1-3", (62, 33)),
        text("F2", "txtbox", "F4C", (58, 33)),
        text("L2", "TXTLINTH", "80M", (60, 35)),
        text("T1", "txt ftth", "1way 7/3.5", (45, 14)),
        text("M1", "txt ftth", "10.0M", (44, 16)),
        text("T2", "txt ftth", "1way 7/3.5", (55, 14)),
        text("M2", "txt ftth", "15.0M", (56, 16)),
        text("T12", "txt ftth", "12way 7/3.5", (80, 2)),
        text("M12", "txt ftth", "455.0M", (80, -2)),
        text("SP", "sp txt", "SP3(7/3.5)", (99, 1)),
    )
    return DrawingData(curves, inserts, texts)


GENERAL_RULES: list[dict[str, object]] = [
    {"source": "layer", "layer": "OOOOOO", "target": "route", "kind": "4way", "ways": 4},
    {"source": "layer", "layer": "HH", "target": "hhi"},
    {
        "source": "layer",
        "layer": "HHT",
        "target": "label",
        "textRoles": ["handhole_number", "handhole_type"],
    },
    {
        "source": "layer",
        "layer": "EXCH",
        "target": "label",
        "textRoles": ["bundle_label", "cable_label", "cable_spare"],
    },
    {"source": "layer", "layer": "CRO", "target": "label", "textRoles": ["handhole_number"]},
    {"source": "layer", "layer": "Sap", "target": "cabinet", "role": "sub"},
]


def general_drawing() -> DrawingData:
    """A 144-core main cable on a 500 m 4way 16/12 bundle; a 12-core branch to one cabinet;
    handholes 04A (HH1) and 04B (DH); «SP 132» = 144 - 12; «CH01» written where nothing is drawn."""
    curves = (
        line("MAIN", "OOOOOO", (0, 0), (500, 0)),
        line("BRANCH", "OOOOOO", (200, 0), (200, -300)),
    )
    inserts = (
        insert("H1", "HH", (200, 5)),
        insert("H2", "HH", (400, 5)),
        insert("SAP", "Sap", (200, -310), "Sap"),
    )
    texts = (
        text("H1N", "HHT", "04A", (205, 12)),
        text("H1T", "HHT", "HH1", (205, 15)),
        text("H2N", "HHT", "04B", (405, 12)),
        text("H2T", "HHT", "DH", (405, 15)),
        text("CRO", "CRO", "CH01", (100, 100)),
        text("B-MAIN", "EXCH", "500M/4way 16/12", (100, 3)),
        text("C-MAIN", "EXCH", "520M/144Core F.O(ELFATH)", (100, 6)),
        text("B-BR", "EXCH", "20M/4way 7/3.5", (203, -150)),
        text("C-BR", "EXCH", "50M/12Core F.O(ABF)", (206, -147)),
        text("SP", "EXCH", "SP 132", (300, 3)),
    )
    return DrawingData(curves, inserts, texts)


def with_text(drawing: DrawingData, handle: str, value: str | None) -> DrawingData:
    """The drawing with one text changed (None = removed)."""
    texts = tuple(
        t if t.handle != handle else replace(t, text=value or "", raw_text=value or "")
        for t in drawing.texts
        if not (t.handle == handle and value is None)
    )
    return replace(drawing, texts=texts)


def without(drawing: DrawingData, *handles: str) -> DrawingData:
    gone = set(handles)
    return DrawingData(
        tuple(c for c in drawing.curves if c.handle not in gone),
        tuple(i for i in drawing.inserts if i.handle not in gone),
        tuple(t for t in drawing.texts if t.handle not in gone),
    )


def rules_of(raw: Sequence[Mapping[str, object]]) -> MappingRules:
    return parse_rules([dict(r) for r in raw])


def read(
    drawing: DrawingData, raw_rules: Sequence[Mapping[str, object]], kind: DrawingKind
) -> tuple[Reading, list[DesignFeatureDraft]]:
    rules = rules_of(raw_rules)
    place = unit_placer(1.0)
    built = build_features(drawing, rules, place)
    reading = read_drawing(
        built.features,
        drawing.texts,
        drawing.curves,
        rules,
        place,
        kind,
        built.text_feature_handles,
    )
    return reading, list(built.features)


def compose(
    drawing: DrawingData, raw_rules: Sequence[Mapping[str, object]], kind: DrawingKind
) -> DesignBuild:
    rules = rules_of(raw_rules)
    layers = rules.curve_layers()
    loaded = replace(drawing, curves=tuple(c for c in drawing.curves if c.layer in layers))
    return compose_design(loaded, rules, unit_placer(1.0), (), uuid.uuid4, kind)


def problems_of(build: DesignBuild) -> dict[str, list[dict[str, object]]]:
    return {str(p["code"]): list(p["items"]) for p in build.problems}  # type: ignore[call-overload]
