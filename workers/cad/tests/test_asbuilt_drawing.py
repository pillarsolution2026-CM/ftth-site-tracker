"""Pure As-Built drawing model: layer assignment, text sanitising, layer-name safety."""

from __future__ import annotations

import uuid

import pytest
from ezdxf.lldxf.validator import is_valid_layer_name
from ezdxf.tools.text import plain_text

from cad_worker.domain.asbuilt_drawing import (
    COLOR_ADDED,
    COLOR_EDITS,
    LAYER_ADDED,
    LAYER_EDITS,
    MAX_TEXT,
    AsBuiltFeatureIn,
    DesignFeatureIn,
    DrawingDataError,
    LayerSpec,
    PolylineEntity,
    SymbolEntity,
    TextEntity,
    anchor,
    build_drawing,
    layer_name_problem,
    sanitize_text,
)


def valid(name: str) -> bool:
    return bool(is_valid_layer_name(name))


def route(layer: str = "N_DUC_CBL", code: str | None = None) -> DesignFeatureIn:
    return DesignFeatureIn(uuid.uuid4(), "route", layer, code, ((0.0, 0.0), (10.0, 0.0)))


def box(layer: str = "sub", code: str | None = "1-1") -> DesignFeatureIn:
    return DesignFeatureIn(uuid.uuid4(), "box", layer, code, ((5.0, 5.0),))


def state(
    f: DesignFeatureIn | uuid.UUID,
    *,
    feature_type: str = "route",
    added: bool = False,
    coords: tuple[tuple[float, float], ...] | None = None,
    label: str | None = None,
    gv: int = 0,
    lv: int = 0,
) -> AsBuiltFeatureIn:
    fid = f if isinstance(f, uuid.UUID) else f.feature_id
    ftype = feature_type if isinstance(f, uuid.UUID) else f.feature_type
    return AsBuiltFeatureIn(fid, ftype, added, coords, label, gv, lv)  # type: ignore[arg-type]


def on(entities: tuple[object, ...], layer: str) -> list[object]:
    return [e for e in entities if getattr(e, "layer", None) == layer]


# ---------- text sanitising ----------


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("A\n0\nLINE", "A 0 LINE"),  # cannot start a DXF tag
        ("x\r\n  0\r\nEOF", "x   0 EOF"),
        ("a\x00b\x1fc\x7fd\x85e\x9ff", "a b c d e f"),  # C0, DEL, C1
        ("one\u2028two\u2029three", "one two three"),
        ("\t padded \n", "padded"),
        ("شارع النيل ١٢", "شارع النيل ١٢"),  # Arabic untouched
        ("50%", "50%"),
        ("%%u", "%%%%%%u"),
        ("%%c150", "%%%%%%c150"),
        ("%%%", "%%%%%%%"),
    ],
)
def test_sanitize_text(raw: str, clean: str) -> None:
    assert sanitize_text(raw) == clean


@pytest.mark.parametrize("raw", ["%%u", "%%o%%d%%p", "%%%u", "a %% b", "%%123", "%%%%"])
def test_percent_codes_render_as_typed(raw: str) -> None:
    """ezdxf's TEXT decoder (same rules as AutoCAD) shows the escaped text literally."""
    assert plain_text(sanitize_text(raw)) == raw


def test_long_text_is_cut_before_escaping() -> None:
    raw = "%%" * 200
    out = sanitize_text(raw)
    assert MAX_TEXT - 6 < len(out) <= MAX_TEXT
    shown = plain_text(out)
    assert raw.startswith(shown) and sanitize_text(shown) == out


# ---------- layer names ----------


@pytest.mark.parametrize("name", ["N_DUC_CBL", "CAP F36", "jont 144", "0", "طبقة"])
def test_valid_layer_names(name: str) -> None:
    assert layer_name_problem(name, valid) is None


@pytest.mark.parametrize(
    "name",
    [
        "",
        " lead",
        "trail ",
        "x" * 256,
        "A\n0\nLINE",
        "a\u2028b",
        "BAD<LAYER",
        "a|b",
        "a,b",
        "a=b",
        "asbuilt_edits",
        "ASBUILT_ADDED",
    ],
)
def test_invalid_layer_names(name: str) -> None:
    assert layer_name_problem(name, valid) is not None


def test_injected_validator_is_applied() -> None:
    assert layer_name_problem("FINE", lambda _: False) == "rejected by ezdxf"


def test_invalid_layers_are_substituted_and_counted() -> None:
    a, b, c = box("BAD<X"), box("BAD<X"), route("A\nB")
    drawing = build_drawing([a, b, c, route()], [], valid)
    names = [layer.name for layer in drawing.layers]
    assert names.count("INVALID_LAYER_1") == 1 and "INVALID_LAYER_2" in names
    assert not any("<" in n or "\n" in n for n in names)
    assert {"code": "INVALID_LAYER_NAME", "count": 2} in drawing.warnings
    a_layer = next(e for e in drawing.entities if isinstance(e, SymbolEntity))
    assert a_layer.layer.startswith("INVALID_LAYER_")


def test_layer_names_differing_in_case_are_declared_once() -> None:
    drawing = build_drawing([route("Cable"), route("CABLE")], [], valid)
    declared = [layer.name.casefold() for layer in drawing.layers]
    assert declared.count("cable") == 1


# ---------- layer assignment ----------


def test_design_only_drawing() -> None:
    r, b = route(code="F 36 C"), box()
    drawing = build_drawing([r, b], [], valid)
    assert drawing.stats.to_json() == {"designFeatures": 2, "editedFeatures": 0, "addedFeatures": 0}
    assert LayerSpec(LAYER_EDITS, COLOR_EDITS) in drawing.layers
    assert LayerSpec(LAYER_ADDED, COLOR_ADDED) in drawing.layers
    assert on(drawing.entities, "N_DUC_CBL") == [
        PolylineEntity("N_DUC_CBL", r.coords),
        TextEntity("N_DUC_CBL", "F 36 C", (5.5, 0.5)),
    ]
    assert SymbolEntity("sub", "FTTH_BOX", (5.0, 5.0)) in drawing.entities
    assert drawing.blocks == ("FTTH_BOX",) and drawing.warnings == ()


def test_edited_geometry_goes_to_edits_and_keeps_the_design() -> None:
    r, b = route(), box()
    new_route = ((0.0, 0.0), (5.0, 2.0), (10.0, 0.0))
    drawing = build_drawing(
        [r, b],
        [
            state(r, coords=new_route, gv=2),
            state(b, coords=((6.0, 6.0),), label="X\n1", gv=1, lv=3),
        ],
        valid,
    )
    edits = on(drawing.entities, LAYER_EDITS)
    assert PolylineEntity(LAYER_EDITS, new_route) in edits
    assert SymbolEntity(LAYER_EDITS, "FTTH_BOX", (6.0, 6.0)) in edits
    texts = {e.text for e in edits if isinstance(e, TextEntity)}
    assert texts == {"AS-BUILT G2 L0", "AS-BUILT G1 L3", "X 1"}
    assert PolylineEntity("N_DUC_CBL", r.coords) in drawing.entities  # original kept
    assert SymbolEntity("sub", "FTTH_BOX", (5.0, 5.0)) in drawing.entities
    assert drawing.stats.edited_features == 2 and drawing.stats.added_features == 0


def test_label_only_change_is_a_text_at_the_design_position() -> None:
    r = route()
    drawing = build_drawing([r], [state(r, label="شارع", lv=1)], valid)
    edits = on(drawing.entities, LAYER_EDITS)
    assert all(isinstance(e, TextEntity) for e in edits)
    assert TextEntity(LAYER_EDITS, "شارع", (5.5, 1.25)) in edits  # route midpoint + offset
    assert TextEntity(LAYER_EDITS, "AS-BUILT G0 L1", (5.5, -1.0)) in edits


def test_added_features_go_to_added() -> None:
    new_route, new_mh = uuid.uuid4(), uuid.uuid4()
    drawing = build_drawing(
        [],
        [
            state(new_route, added=True, coords=((0.0, 0.0), (0.0, 8.0)), label="L", gv=1, lv=1),
            state(new_mh, feature_type="mh", added=True, coords=((1.0, 1.0),), gv=1),
        ],
        valid,
    )
    added = on(drawing.entities, LAYER_ADDED)
    assert PolylineEntity(LAYER_ADDED, ((0.0, 0.0), (0.0, 8.0))) in added
    assert SymbolEntity(LAYER_ADDED, "FTTH_MH", (1.0, 1.0)) in added
    assert [e.text for e in added if isinstance(e, TextEntity)].count("AS-BUILT ADDED") == 2
    assert drawing.stats.to_json() == {"designFeatures": 0, "editedFeatures": 0, "addedFeatures": 2}
    assert drawing.blocks == ("FTTH_MH",)


def test_state_of_a_feature_missing_from_the_revision_is_left_out() -> None:
    gone = uuid.uuid4()
    drawing = build_drawing([route()], [state(gone, coords=((0.0, 0.0), (1.0, 1.0)), gv=1)], valid)
    assert on(drawing.entities, LAYER_EDITS) == []
    assert drawing.stats.edited_features == 0
    assert drawing.warnings == ({"code": "ASBUILT_FEATURE_NOT_IN_REVISION", "count": 1},)


def test_empty_rows_and_empty_texts_are_skipped() -> None:
    r = route(code="\n\n")
    drawing = build_drawing([r], [state(r)], valid)
    assert drawing.entities == (PolylineEntity("N_DUC_CBL", r.coords),)


@pytest.mark.parametrize(
    "bad",
    [
        DesignFeatureIn(uuid.uuid4(), "route", "L", None, ((0.0, 0.0),)),
        DesignFeatureIn(uuid.uuid4(), "box", "L", None, ((0.0, 0.0), (1.0, 1.0))),
        DesignFeatureIn(uuid.uuid4(), "box", "L", None, ((float("nan"), 0.0),)),
        DesignFeatureIn(uuid.uuid4(), "route", "L", None, ((0.0, 0.0), (float("inf"), 0.0))),
        DesignFeatureIn(uuid.uuid4(), "box", "L", None, ((0.0, -1.0e9),)),
    ],
)
def test_unusable_geometry_is_a_data_error(bad: DesignFeatureIn) -> None:
    with pytest.raises(DrawingDataError):
        build_drawing([bad], [], valid)


def test_added_feature_without_geometry_is_a_data_error() -> None:
    with pytest.raises(DrawingDataError):
        build_drawing([], [state(uuid.uuid4(), added=True, label="x", lv=1)], valid)


def test_anchor_is_the_middle_of_a_route_by_length() -> None:
    assert anchor("route", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]) == (10.0, 0.0)
    assert anchor("route", [(0.0, 0.0), (0.0, 0.0), (4.0, 0.0)]) == (2.0, 0.0)
    assert anchor("box", [(3.0, 4.0)]) == (3.0, 4.0)
