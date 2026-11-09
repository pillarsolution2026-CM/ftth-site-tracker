"""Drawing view (ADR-039): flattening per top-level entity, colours, texts, caps, JSON."""

from __future__ import annotations

import gzip
import io
import json
import math
import re
from pathlib import Path
from typing import Any

import pytest
from ezdxf.filemanagement import new as new_dxf

from cad_worker.adapters.ezdxf_view import EzdxfViewRenderer, _EntityRenderer
from cad_worker.application.ports import ViewFailure
from cad_worker.domain.drawing_view import (
    DrawingView,
    DrawingViewBuilder,
    EntityShapes,
    ViewEntity,
    ViewLayer,
    flat_path,
    shape_sagitta,
    view_sagitta,
    write_view_gzip,
)
from cad_worker.domain.extents import Extents
from tests.support.dxf_samples import LEGACY_SHX, LEGACY_SHX_DECODED

FILE_ID = "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a99"
HEX = re.compile(r"^#[0-9a-f]{6}$")


def _write(path: Path) -> dict[str, str]:
    """A small drawing; returns the handles of its model-space entities by name."""
    doc = new_dxf("R2018", setup=True)
    doc.layers.add("BLK", color=1)
    doc.layers.add("TRUE", color=3, true_color=0x123456)
    doc.layers.add("WHITE", color=7)
    doc.layers.add("FROZEN", color=5).freeze()
    doc.layers.add("OFF", color=2).off()
    doc.styles.add("x", font="xarb.shx")

    sym = doc.blocks.new("SYM")
    sym.add_circle((0, 0), 1)
    sym.add_line((-1, 0), (1, 0))
    sym.add_attdef("NAME", (0, 1), dxfattribs={"height": 0.5})
    outer = doc.blocks.new("OUTER")
    outer.add_blockref("SYM", (10, 0))
    outer.add_text("IN", dxfattribs={"insert": (0, 5), "height": 1})

    msp = doc.modelspace()
    handles: dict[str, str] = {}
    insert = msp.add_blockref(
        "SYM",
        (100, 50),
        dxfattribs={"layer": "BLK", "rotation": 90, "xscale": 2, "yscale": 2},
    )
    insert.add_attrib("NAME", "S1", (100, 52), dxfattribs={"height": 1})
    hidden = insert.add_attrib("HIDDEN", "secret", (100, 53))
    hidden.is_invisible = True
    handles["insert"] = insert.dxf.handle
    nested = msp.add_blockref("OUTER", (0, 100), dxfattribs={"layer": "OFF", "color": 256})
    handles["nested"] = nested.dxf.handle
    text = msp.add_text(
        "Hello", dxfattribs={"insert": (10, 20), "height": 2.5, "rotation": 30, "layer": "WHITE"}
    )
    text.dxf.color = 3
    handles["text"] = text.dxf.handle
    legacy = msp.add_text(LEGACY_SHX, dxfattribs={"insert": (12, 22), "style": "x"})
    handles["legacy"] = legacy.dxf.handle
    mtext = msp.add_mtext(
        "{\\fArial|b0;Line1}\\PLine2",
        dxfattribs={"insert": (30, 40), "char_height": 1.5, "rotation": 45, "layer": "TRUE"},
    )
    mtext.dxf.true_color = 0xFF8800
    handles["mtext"] = mtext.dxf.handle
    hatch = msp.add_hatch(color=2, dxfattribs={"layer": "FROZEN"})
    hatch.paths.add_polyline_path([(0, 0), (10, 0), (10, 10), (0, 10)], is_closed=True)
    handles["hatch"] = hatch.dxf.handle
    arc = msp.add_lwpolyline(
        [(0, 0, 0, 0, 1), (10, 0)], format="xyseb", dxfattribs={"layer": "TRUE"}
    )
    handles["bulge"] = arc.dxf.handle
    handles["point"] = msp.add_point((5, 5)).dxf.handle
    handles["line"] = msp.add_line((-20, -30), (200, 300), dxfattribs={"color": 7}).dxf.handle
    doc.saveas(path)
    return handles


@pytest.fixture
def drawing(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    path = tmp_path / "view.dxf"
    return path, _write(path)


def _by_handle(view: DrawingView) -> dict[str, ViewEntity]:
    return {e.handle: e for e in view.entities}


def _points(path: tuple[float, ...]) -> list[tuple[float, float]]:
    return [(path[i], path[i + 1]) for i in range(0, len(path), 2)]


def test_entities_are_grouped_by_top_level_handle(drawing: tuple[Path, dict[str, str]]) -> None:
    path, h = drawing
    rendered = EzdxfViewRenderer().render(path, FILE_ID, None)
    view = rendered.view
    entities = _by_handle(view)
    assert set(entities) == {h[k] for k in h if k != "point"}  # a POINT draws nothing
    assert rendered.stats.empty == 1 and rendered.stats.entities == len(h)

    insert = entities[h["insert"]]
    assert insert.kind == "INSERT" and insert.color is None
    assert view.layers[insert.layer].name == "BLK"
    assert len(insert.paths) == 2  # the circle and the line of the block
    circle, line = sorted(insert.paths, key=len, reverse=True)
    # rotated 90°, scaled 2, at (100, 50): the block line (-1,0)-(1,0) becomes vertical
    assert _points(line) == [(100.0, 48.0), (100.0, 52.0)]
    pts = _points(circle)
    assert 16 <= len(pts) <= 200 and pts[0] == pytest.approx(pts[-1], abs=1e-4)
    assert all(math.hypot(x - 100, y - 50) == pytest.approx(2, abs=0.01) for x, y in pts)
    assert [t.text for t in insert.texts] == ["S1"]  # the invisible attribute is not drawn
    assert (insert.texts[0].x, insert.texts[0].y, insert.texts[0].height) == (100, 52, 1)

    nested = entities[h["nested"]]  # a block in a block: still one entity, the outer handle
    assert nested.kind == "INSERT" and len(nested.paths) == 2
    assert [t.text for t in nested.texts] == ["IN"]
    assert (nested.texts[0].x, nested.texts[0].y) == (0, 105)
    assert all(x == pytest.approx(10, abs=1.01) for x, _ in _points(nested.paths[0]))


def test_texts_mtext_and_decoded_shx(drawing: tuple[Path, dict[str, str]]) -> None:
    path, h = drawing
    entities = _by_handle(EzdxfViewRenderer().render(path, FILE_ID, None).view)
    text = entities[h["text"]].texts
    assert [(t.x, t.y, t.height, t.rotation, t.text) for t in text] == [(10, 20, 2.5, 30, "Hello")]
    assert entities[h["text"]].paths == ()
    mtext = entities[h["mtext"]]
    assert mtext.kind == "MTEXT"
    assert [(t.x, t.y, t.height, t.rotation, t.text) for t in mtext.texts] == [
        (30, 40, 1.5, 45, "Line1\nLine2")
    ]
    assert entities[h["legacy"]].texts[0].text == LEGACY_SHX_DECODED


def test_colours_and_layers(drawing: tuple[Path, dict[str, str]]) -> None:
    path, h = drawing
    view = EzdxfViewRenderer().render(path, FILE_ID, None).view
    entities = _by_handle(view)
    assert entities[h["text"]].color == "#00ff00"  # ACI 3
    assert entities[h["mtext"]].color == "#ff8800"  # true colour wins
    assert entities[h["hatch"]].color == "#ffff00"  # ACI 2
    assert entities[h["line"]].color == "#000000"  # ACI 7 drawn black on the white canvas
    assert entities[h["insert"]].color is None and entities[h["nested"]].color is None
    layers = {la.name: la for la in view.layers}
    assert layers["BLK"] == ViewLayer("BLK", "#ff0000", True)
    assert layers["TRUE"].color == "#123456"
    assert layers["WHITE"].color == "#000000"
    assert layers["FROZEN"].visible is False and layers["OFF"].visible is False
    assert all(HEX.match(la.color) for la in view.layers)


def test_hatch_outline_bulge_and_extents(drawing: tuple[Path, dict[str, str]]) -> None:
    path, h = drawing
    view = EzdxfViewRenderer().render(path, FILE_ID, None).view
    entities = _by_handle(view)
    hatch = entities[h["hatch"]]
    assert view.layers[hatch.layer].name == "FROZEN"
    assert _points(hatch.paths[0]) == [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
    bulge = _points(entities[h["bulge"]].paths[0])
    assert len(bulge) > 8 and bulge[0] == (0, 0) and bulge[-1] == (10, 0)
    assert all(math.hypot(x - 5, y) == pytest.approx(5, abs=0.02) for x, y in bulge)
    assert view.extents == Extents(-20, -30, 200, 300)
    assert view.truncated is False


def test_vertex_cap_truncates_deterministically(drawing: tuple[Path, dict[str, str]]) -> None:
    path, _ = drawing
    full = EzdxfViewRenderer().render(path, FILE_ID, None).view
    cap = full.vertex_count // 2
    a = EzdxfViewRenderer(max_vertices=cap).render(path, FILE_ID, None)
    b = EzdxfViewRenderer(max_vertices=cap).render(path, FILE_ID, None)
    assert a.view == b.view and a.view.truncated is True
    assert 0 < a.view.vertex_count <= cap
    assert a.view.text_count == full.text_count  # texts have their own cap


def test_text_cap_truncates() -> None:
    builder = DrawingViewBuilder(FILE_ID, [], max_texts=1)
    for i in range(3):
        shapes = EntityShapes()
        shapes.add_text(i, i, 1, 0, f"T{i}")
        builder.add(f"H{i}", "0", None, "TEXT", shapes)
    view = builder.build()
    assert [e.handle for e in view.entities] == ["H0"] and view.truncated is True
    assert view.layers == (ViewLayer("0", "#000000", True),)  # unknown layer appended


def test_one_bad_part_does_not_lose_the_entity(
    drawing: tuple[Path, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    path, h = drawing
    original = _EntityRenderer.part

    def flaky(self: _EntityRenderer, e: Any, shapes: EntityShapes) -> bool:
        if e.dxftype() == "CIRCLE":
            raise ValueError("broken circle")
        return original(self, e, shapes)

    monkeypatch.setattr(_EntityRenderer, "part", flaky)
    rendered = EzdxfViewRenderer().render(path, FILE_ID, None)
    insert = _by_handle(rendered.view)[h["insert"]]
    assert len(insert.paths) == 1 and [t.text for t in insert.texts] == ["S1"]
    assert rendered.stats.part_errors == 2  # the insert and the nested insert


def test_unreadable_file_is_a_read_failure(tmp_path: Path) -> None:
    bad = tmp_path / "bad.dxf"
    bad.write_bytes(b"\x00\x01 not a dxf")
    with pytest.raises(ViewFailure) as info:
        EzdxfViewRenderer().render(bad, FILE_ID, None)
    assert info.value.code == "READ_FAILED"


def test_sagitta_follows_extents_and_shape_size() -> None:
    assert view_sagitta(None) == math.inf
    assert view_sagitta(Extents(0, 0, 3000, 4000)) == pytest.approx(0.05)
    assert shape_sagitta(0.05, 1000) == pytest.approx(0.05)  # big arc: the drawing bound
    assert shape_sagitta(0.05, 2) == pytest.approx(0.004)  # small symbol: its own size
    assert shape_sagitta(math.inf, math.inf) == 1.0
    assert shape_sagitta(0.05, 0) > 0


def test_flat_path_rounds_and_drops_degenerate_paths() -> None:
    assert flat_path([(1.123456, 2.0), (1.123459, 2.00001), (3, 4)]) == (1.1235, 2.0, 3.0, 4.0)
    assert flat_path([(1, 1), (1, 1)]) is None
    assert flat_path([(0, 0), (math.nan, 1)]) is None


def test_gzip_json_mirrors_the_contract(drawing: tuple[Path, dict[str, str]]) -> None:
    path, h = drawing
    view = EzdxfViewRenderer().render(path, FILE_ID, None).view
    first, second = io.BytesIO(), io.BytesIO()
    write_view_gzip(view, first)
    write_view_gzip(view, second)
    assert first.getvalue() == second.getvalue()  # deterministic (no mtime)
    raw = gzip.decompress(first.getvalue()).decode("utf-8")
    assert ": " not in raw and ", " not in raw.replace("Line1\\nLine2", "")
    data = json.loads(raw)
    assert set(data) == {"version", "cadFileId", "extents", "layers", "entities", "truncated"}
    assert data["version"] == 1 and data["cadFileId"] == FILE_ID and data["truncated"] is False
    assert data["extents"] == {"minX": -20, "minY": -30, "maxX": 200, "maxY": 300}
    for entity in data["entities"]:
        assert set(entity) == {"handle", "layer", "color", "kind", "paths", "texts"}
        assert 0 <= entity["layer"] < len(data["layers"])
        assert entity["color"] is None or HEX.match(entity["color"])
        assert all(len(p) >= 4 and len(p) % 2 == 0 for p in entity["paths"])
        for t in entity["texts"]:
            assert set(t) == {"x", "y", "height", "rotation", "text"}
    text = next(e for e in data["entities"] if e["handle"] == h["text"])
    assert text["texts"] == [
        {"x": 10.0, "y": 20.0, "height": 2.5, "rotation": 30.0, "text": "Hello"}
    ]
