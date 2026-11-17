"""ADR-043: box shape signatures, previews, the gallery and the box type on each box.

The synthetic DXF cases of the ADR: the same geometry under two block names -> 1 shape; the block
rotated 90° and scaled x2 -> the same shape; mirrored -> another shape; a box added on the page
(`add_item`) -> `none`.
"""

from __future__ import annotations

import itertools
import math
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from ezdxf.document import Drawing
from ezdxf.filemanagement import new as new_dxf

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.application.build_revision import compose_design
from cad_worker.domain.asbuilt_drawing import box_type_mtext
from cad_worker.domain.box_shapes import (
    BOX_SHAPE_NONE,
    MAX_BOX_SHAPE_PREVIEW_PATHS,
    MAX_BOX_SHAPE_PREVIEW_TEXTS,
    MAX_BOX_SHAPE_PREVIEW_VERTICES,
    MAX_BOX_SHAPE_SAMPLES,
    MAX_BOX_SHAPES,
    BoxShapeOf,
    BoxTypesInvalidError,
    ShapeGeometry,
    ShapeText,
    build_gallery,
    fixed_arc_points,
    is_signature,
    parse_frozen_box_types,
    shape_preview,
    shape_signature,
    text_signature,
)
from cad_worker.domain.corrections import apply_corrections, parse_corrections
from cad_worker.domain.design_build import SourceCurve, SourceText
from cad_worker.domain.model import InsertRow
from cad_worker.domain.placement import unit_placer
from tests.support.reading_scenes import SECONDARY_RULES, rules_of, secondary_drawing

LINE_ID = "11111111-1111-4111-8111-111111111111"
CHOICE_ID = "22222222-2222-4222-8222-222222222222"
CORRECTION_ID = "33333333-3333-4333-8333-333333333333"

# ---------- pure normalization ----------

L_SHAPE = ((0.0, 0.0), (4.0, 0.0), (4.0, 1.0), (1.0, 1.0), (1.0, 3.0), (0.0, 3.0), (0.0, 0.0))


def _moved(path: tuple[tuple[float, float], ...], f: Any) -> tuple[tuple[float, float], ...]:
    return tuple(f(p) for p in path)


def test_signature_ignores_position_and_size_but_not_mirroring() -> None:
    base = shape_signature(ShapeGeometry((L_SHAPE,)))
    assert is_signature(base) and base.startswith("v1-")
    shifted = _moved(L_SHAPE, lambda p: (p[0] * 2.5 + 1000.0, p[1] * 2.5 - 7.0))
    assert shape_signature(ShapeGeometry((shifted,))) == base
    mirrored = _moved(L_SHAPE, lambda p: (-p[0], p[1]))
    assert shape_signature(ShapeGeometry((mirrored,))) != base
    # Segments, not the way they are drawn: four lines = one closed polyline.
    pieces = tuple((a, b) for a, b in itertools.pairwise(L_SHAPE))
    assert shape_signature(ShapeGeometry(pieces)) == base
    # ...but a segment split in two is another drawing (split, never merge).
    split = ((0.0, 0.0), (2.0, 0.0), (4.0, 0.0), *L_SHAPE[2:])
    assert shape_signature(ShapeGeometry((split,))) != base


def test_signature_keeps_texts_and_tokens_and_the_source() -> None:
    square = ((-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0))
    plain = shape_signature(ShapeGeometry((square,)))
    with_text = shape_signature(ShapeGeometry((square,), (ShapeText(0, 0, 0.5, 0, "8"),)))
    other_text = shape_signature(ShapeGeometry((square,), (ShapeText(0, 0, 0.5, 0, "4"),)))
    hatched = shape_signature(ShapeGeometry((square,), (), ("hatch:solid",)))
    assert len({plain, with_text, other_text, hatched}) == 4
    assert shape_signature(ShapeGeometry((square,)), "shapes") != plain
    assert text_signature("  box 8 ") == text_signature("BOX 8") != text_signature("BOX 4")


def test_preview_is_normalized_and_bounded() -> None:
    circles = tuple(
        tuple(fixed_arc_points(i * 3.0, 0.0, 1.0, 0.0, 2 * math.pi)) for i in range(300)
    )
    texts = tuple(ShapeText(float(i), 0.0, 0.2, 0.0, "X" * 50) for i in range(20))
    preview = shape_preview(ShapeGeometry(circles, texts))
    paths = preview["paths"]
    assert isinstance(paths, list)
    assert preview["truncated"] is True
    assert len(paths) <= MAX_BOX_SHAPE_PREVIEW_PATHS
    assert sum(len(p) // 2 for p in paths) <= MAX_BOX_SHAPE_PREVIEW_VERTICES
    assert all(len(p) >= 4 and len(p) % 2 == 0 for p in paths)
    assert all(-1.0 <= v <= 1.0 for p in paths for v in p)
    out_texts = preview["texts"]
    assert isinstance(out_texts, list) and len(out_texts) == MAX_BOX_SHAPE_PREVIEW_TEXTS
    assert all(len(t["text"]) <= 32 and 0 < t["height"] <= 1 for t in out_texts)
    small = shape_preview(ShapeGeometry((L_SHAPE,)))
    assert small["truncated"] is False
    paths_small: Any = small["paths"]
    [path] = paths_small
    xs, ys = path[0::2], path[1::2]
    assert max(max(xs) - min(xs), max(ys) - min(ys)) == pytest.approx(1.0)
    assert (min(xs) + max(xs)) / 2 == pytest.approx(0.0)


def test_gallery_counts_sorts_and_caps() -> None:
    boxes = [BoxShapeOf(f"H{i:03}", "block", "v1-" + "a" * 64, "box c") for i in range(7)]
    boxes += [BoxShapeOf("A1", "block", "v1-" + "b" * 64, "box d"), BoxShapeOf("X", "block", None)]
    boxes += [BoxShapeOf("F1", "none", BOX_SHAPE_NONE)]
    g = build_gallery(boxes)
    assert (g["boxCount"], g["shapeCount"], g["boxesWithoutShape"]) == (10, 3, 1)
    shapes = g["shapes"]
    assert isinstance(shapes, list)
    assert [s["shape"] for s in shapes] == ["v1-" + "a" * 64, "none", "v1-" + "b" * 64]
    assert shapes[0]["count"] == 7 and shapes[0]["blockNames"] == ["box c"]
    assert shapes[0]["sampleHandles"] == [f"H{i:03}" for i in range(MAX_BOX_SHAPE_SAMPLES)]
    many = build_gallery(
        BoxShapeOf(f"H{i}", "block", f"v1-{i:064x}") for i in range(MAX_BOX_SHAPES + 5)
    )
    assert many["shapeCount"] == MAX_BOX_SHAPES + 5
    assert len(many["shapes"]) == MAX_BOX_SHAPES  # type: ignore[arg-type]


def test_frozen_box_types_are_validated() -> None:
    frozen = {
        "choices": [
            {
                "choiceId": CHOICE_ID,
                "shape": "none",
                "workOrderLineId": LINE_ID,
                "line": {"code": "B-8", "description": "x", "label": "بوكس 8"},
            },
            {
                "choiceId": CHOICE_ID,
                "shape": "v1-" + "c" * 64,
                "workOrderLineId": LINE_ID,
                "line": None,
            },
        ]
    }
    parsed = parse_frozen_box_types(frozen)
    assert parsed["none"].to_json() == {
        "workOrderLineId": LINE_ID,
        "code": "B-8",
        "label": "بوكس 8",
    }
    assert parsed["v1-" + "c" * 64].code is None
    assert parse_frozen_box_types(None) == {}
    bad: object
    for bad in (
        [],
        {"choices": [{"shape": "box c", "workOrderLineId": LINE_ID}]},
        {"choices": [{"shape": "none", "workOrderLineId": "nope"}]},
        {"choices": [{"shape": "none", "workOrderLineId": LINE_ID}] * 2},
    ):
        with pytest.raises(BoxTypesInvalidError):
            parse_frozen_box_types(bad)


# ---------- synthetic DXF through the worker's reader ----------


def _symbol(doc: Drawing, name: str, base: tuple[float, float] = (0.0, 0.0)) -> None:
    """An asymmetric symbol (L outline, a circle, an arc, a bulge, a constant text, an ATTDEF)."""
    block = doc.blocks.new(name, base_point=(base[0], base[1], 0))
    ox, oy = base
    block.add_lwpolyline([(ox + x, oy + y) for x, y in L_SHAPE[:-1]], close=True)
    block.add_circle((ox + 3.0, oy + 0.5), 0.3)
    block.add_arc((ox + 0.5, oy + 2.5), 0.4, 0, 120)
    block.add_lwpolyline([(ox + 2.0, oy + 2.0, 0.5), (ox + 3.0, oy + 2.0, 0.0)], format="xyb")
    block.add_text("8", dxfattribs={"height": 0.4, "insert": (ox + 2.0, oy + 0.2)})
    block.add_attdef("NO", (ox, oy), dxfattribs={"height": 0.3})


def _write(tmp_path: Path) -> Path:
    doc = new_dxf("R2018", setup=True)
    _symbol(doc, "box c")
    _symbol(doc, "box copy", base=(50.0, -20.0))  # same look, another name and base point
    msp = doc.modelspace()

    def put(handle_hint: str, block: str, at: tuple[float, float], **attribs: float) -> None:
        ref = msp.add_blockref(block, at, dxfattribs={"layer": "BOX", **attribs})
        ref.add_attrib("NO", handle_hint, at)  # attribute values differ: not part of the shape

    put("a", "box c", (0, 0))
    put("b", "box copy", (100, 100))
    put("c", "box c", (200, 0), rotation=90, xscale=2, yscale=2)
    put("d", "box c", (300, 0), rotation=37, xscale=3, yscale=3)
    put("e", "box c", (400, 0), xscale=-1)  # mirrored
    put("f", "box c", (500, 0), yscale=2)  # stretched
    path = tmp_path / "shapes.dxf"
    doc.saveas(path)
    return path


def _inserts(path: Path) -> list[InsertRow]:
    return [r for r in EzdxfReader().open(path).features() if isinstance(r, InsertRow)]


def test_reader_gives_one_shape_per_look(tmp_path: Path) -> None:
    rows = _inserts(_write(tmp_path))
    by_hint = {r.attributes[0].value: r for r in rows}
    sig = {k: r.shape_signature for k, r in by_hint.items()}
    assert all(is_signature(s) for s in sig.values())
    # Two names, one look; rotated 90° and x2; rotated 37° and x3: one shape.
    assert sig["a"] == sig["b"] == sig["c"] == sig["d"]
    # Mirrored, stretched: other shapes.
    assert len({sig["a"], sig["e"], sig["f"]}) == 3
    preview = by_hint["a"].shape_preview
    assert preview is not None and preview["truncated"] is False
    texts: Any = preview["texts"]
    [text] = texts
    assert text["text"] == "8" and text["rotation"] == 0.0
    assert text["height"] == pytest.approx(0.4 / 4.0)  # the symbol's larger side is 4
    # A preview is computed once per look and carried by its first insert only (review M2).
    assert [r.shape_preview is not None for r in rows].count(True) == 3  # a; e mirrored; f


def test_an_unreadable_symbol_has_no_shape(tmp_path: Path) -> None:
    doc = new_dxf("R2018", setup=True)
    block = doc.blocks.new("deep")
    block.add_line((0, 0), (1, 0))
    block.add_blockref("deep", (1, 1))  # self reference: ezdxf refuses / depth bound
    doc.modelspace().add_blockref("deep", (0, 0), dxfattribs={"layer": "BOX"})
    path = tmp_path / "deep.dxf"
    doc.saveas(path)
    [row] = _inserts(path)
    assert row.shape_signature is None and row.shape_preview is None


# ---------- build: shape and type on each box, gallery ----------


def _secondary_with_shapes(sig: str) -> Any:
    drawing = secondary_drawing()
    inserts = tuple(replace(i, shape=sig) if i.layer == "BOX" else i for i in drawing.inserts)
    return replace(drawing, inserts=inserts)


def test_build_writes_shape_and_type_on_every_box_and_the_gallery() -> None:
    sig = "v1-" + "d" * 64
    rules = rules_of(SECONDARY_RULES)
    drawing = _secondary_with_shapes(sig)
    added = apply_corrections(
        replace(
            drawing, curves=tuple(c for c in drawing.curves if c.layer in rules.curve_layers())
        ),
        parse_corrections(
            [
                {
                    "id": CORRECTION_ID,
                    "correction": {"kind": "add_item", "layer": "BOX", "x": 80, "y": 30},
                }
            ]
        ),
        metres_per_unit=1.0,
        move_targets=rules.layers_with("box", "label"),
    )
    frozen = parse_frozen_box_types(
        {
            "choices": [
                {
                    "choiceId": CHOICE_ID,
                    "shape": sig,
                    "workOrderLineId": LINE_ID,
                    "line": {"code": "B8-4", "description": "بوكس 8 فرعة", "label": "بوكس 8 فرعة"},
                }
            ]
        }
    )
    preview = {"paths": [[0, 0, 0.5, 0.5]], "texts": [], "truncated": False}
    build = compose_design(
        added,
        rules,
        unit_placer(1.0),
        (),
        uuid.uuid4,
        "secondary",
        box_types=frozen,
        shape_previews={sig: preview},
    )
    boxes = {
        f.source_handle: f.attrs["reading"] for f in build.rows.features if f.feature_type == "box"
    }
    assert len(boxes) == 3
    for handle in ("B1", "B2"):
        reading = boxes[handle]
        assert reading["shape"] == sig  # type: ignore[index]
        assert reading["boxType"] == {  # type: ignore[index]
            "workOrderLineId": LINE_ID,
            "code": "B8-4",
            "label": "بوكس 8 فرعة",
        }
        assert reading["number"] in ("1", "2")  # type: ignore[index]  # reading kept
    [fix] = [h for h in boxes if h not in ("B1", "B2")]
    assert boxes[fix]["shape"] == BOX_SHAPE_NONE and boxes[fix]["boxType"] is None  # type: ignore[index]
    gallery = build.box_shapes
    assert gallery is not None
    assert (gallery["boxCount"], gallery["shapeCount"], gallery["boxesWithoutShape"]) == (3, 2, 0)
    shapes = gallery["shapes"]
    assert isinstance(shapes, list)
    assert shapes[0] == {
        "shape": sig,
        "source": "block",
        "count": 2,
        "blockNames": ["box c"],
        "sampleHandles": ["B1", "B2"],
        "preview": preview,
    }
    assert shapes[1]["shape"] == "none" and shapes[1]["preview"] is None


def test_closed_shapes_and_text_boxes_get_their_own_shapes_and_old_files_count_as_unknown() -> None:
    rules = rules_of(
        [*SECONDARY_RULES, {"source": "text", "layer": "TXTBOX", "text": "bx", "target": "box"}]
    )
    drawing = secondary_drawing()
    square = ((70.0, 30.0), (72.0, 30.0), (72.0, 32.0), (70.0, 32.0), (70.0, 30.0))
    drawing = replace(
        drawing,
        curves=(*drawing.curves, SourceCurve("S1", "BOX", square, True, "LWPOLYLINE")),
        texts=(*drawing.texts, SourceText("TX", "TXTBOX", (90.0, 30.0), 1.0, "bx", "bx", True)),
    )
    build = compose_design(drawing, rules, unit_placer(1.0), (), uuid.uuid4, "secondary")
    gallery = build.box_shapes
    assert gallery is not None
    assert gallery["boxesWithoutShape"] == 2  # B1, B2: inserts read before migration 0023
    sources = sorted(s["source"] for s in gallery["shapes"])  # type: ignore[attr-defined]
    assert sources == ["shapes", "text"]
    readings = {
        f.source_handle: f.attrs["reading"] for f in build.rows.features if f.feature_type == "box"
    }
    assert readings["B1"]["shape"] is None  # type: ignore[index]
    assert readings["TX"]["shape"] == text_signature("BX")  # type: ignore[index]


def test_general_and_legacy_builds_have_no_gallery() -> None:
    drawing = _secondary_with_shapes("v1-" + "e" * 64)
    general = compose_design(
        drawing, rules_of(SECONDARY_RULES), unit_placer(1.0), (), uuid.uuid4, "general"
    )
    assert general.box_shapes is None
    legacy = compose_design(
        drawing,
        rules_of([{"source": "layer", "layer": "BOX", "target": "box"}]),
        unit_placer(1.0),
        (),
        uuid.uuid4,
        "secondary",
    )
    assert legacy.box_shapes is None
    assert all("shape" not in (f.attrs.get("reading") or {}) for f in legacy.rows.features)  # type: ignore[operator]


def test_box_type_mtext_is_inert() -> None:
    assert box_type_mtext("B-8", "بوكس 8") == "B-8\\Pبوكس 8"
    assert box_type_mtext(None, "x") == "x" and box_type_mtext(None, None) is None
    # Formatting codes, %% codes, carets and control characters stay literal text.
    assert (
        box_type_mtext("A\\Pb", "{\\fArial;x}\n%%u^J") == "A\\\\Pb\\P\\{\\\\fArial;x\\} %%%%%%u^ J"
    )
