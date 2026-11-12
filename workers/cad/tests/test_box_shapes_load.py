"""ADR-043 security review M1 / M2 / L1: the import's work on a symbol is bounded.

- M1: every entity visited while exploding an INSERT (nested INSERT / DIMENSION visits, texts,
  tokens included) is charged to a budget, per symbol and per drawing, for the shape AND for the
  drawn centre; past it the symbol is «too complex» (no shape, insertion point as position).
- M2: the per-drawing cache keeps signatures only (bounded); a preview is computed once per new
  signature.
- L1: preview texts and block names are cut by UTF-16 length (the zod `.max()` unit).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ezdxf.filemanagement import new as new_dxf

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.ezdxf_shapes import ExplosionBudget, InsertShapes
from cad_worker.application.extract import extract
from cad_worker.domain.box_shapes import (
    MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH,
    BoxShapeOf,
    ShapeGeometry,
    ShapeText,
    build_gallery,
    shape_preview,
)
from cad_worker.domain.drawing_view import utf16_length
from cad_worker.domain.model import InsertRow
from tests.test_reader_extract import ListSink

# Generous wall-clock bounds for CI machines; the bounded work takes ~1-2 s here.
FAN_OUT_SECONDS = 15.0


def _fan_out_dxf(path: Path, fan_out: int, depth: int, copies: int = 1) -> Path:
    """`L<depth>` draws fan_out^depth lines (6^8 ≈ 1.7 M): a tiny file with a huge explosion."""
    doc = new_dxf("R2018", setup=True)
    doc.blocks.new("L0").add_line((0, 0), (1, 0))
    for level in range(1, depth + 1):
        block = doc.blocks.new(f"L{level}")
        for i in range(fan_out):
            block.add_blockref(f"L{level - 1}", (i * 2.0, level * 1.0))
    msp = doc.modelspace()
    for i in range(copies):
        msp.add_blockref(f"L{depth}", (i * 100.0, 0), dxfattribs={"layer": "BOX"})
    msp.add_line((0, 0), (5, 5))
    doc.saveas(path)
    return path


def _extract(path: Path) -> tuple[list[InsertRow], str]:
    sink = ListSink()
    result = extract(
        EzdxfReader().open(path),
        sink,
        converter="none",
        converter_version=None,
        converted_storage_key=None,
        converter_log="",
        project_epsg=None,
    )
    return [r for r in sink.rows if isinstance(r, InsertRow)], result.log


def test_a_fan_out_block_is_too_complex_and_bounded(tmp_path: Path) -> None:
    path = _fan_out_dxf(tmp_path / "fan.dxf", fan_out=6, depth=8, copies=3)
    started = time.monotonic()
    rows, log = _extract(path)
    took = time.monotonic() - started
    assert took < FAN_OUT_SECONDS, f"{took:.1f}s"
    assert len(rows) == 3
    for row in rows:
        assert row.too_complex
        assert row.shape_signature is None and row.shape_preview is None
        assert row.centre is None  # the insertion point is used as its position
    assert "symbols too complex: 3" in log


def test_a_deep_block_ends(tmp_path: Path) -> None:
    path = _fan_out_dxf(tmp_path / "deep.dxf", fan_out=2, depth=15)
    started = time.monotonic()
    [row], _ = _extract(path)
    assert time.monotonic() - started < FAN_OUT_SECONDS
    assert row.too_complex and row.shape_signature is None


def test_texts_and_tokens_are_charged_too() -> None:
    doc = new_dxf("R2018", setup=True)
    block = doc.blocks.new("dots")
    for i in range(500):
        block.add_point((i, 0))
        block.add_text("x", dxfattribs={"insert": (i, 1)})
    ref = doc.modelspace().add_blockref("dots", (0, 0))
    shapes = InsertShapes(ExplosionBudget(per_symbol=300))
    found = shapes.read(ref)
    assert found.too_complex and found.signature is None
    assert shapes.read(ref).too_complex  # known heavy block: not exploded again


def test_the_drawing_budget_stops_further_explosions() -> None:
    doc = new_dxf("R2018", setup=True)
    for n in range(5):
        block = doc.blocks.new(f"B{n}")
        for i in range(10):
            block.add_line((0, i), (n + 1, i))
    refs = [doc.modelspace().add_blockref(f"B{n}", (0, 0)) for n in range(5)]
    budget = ExplosionBudget(per_symbol=100, per_drawing=25)
    shapes = InsertShapes(budget)
    results = [shapes.read(r) for r in refs]
    assert results[0].signature is not None and results[1].signature is not None
    assert all(r.too_complex and r.signature is None for r in results[2:])


def test_scale_jitter_keeps_one_preview_and_a_bounded_cache() -> None:
    doc = new_dxf("R2018", setup=True)
    block = doc.blocks.new("box c")
    block.add_lwpolyline([(0, 0), (3, 0), (3, 1), (0, 1)], close=True)
    block.add_circle((1, 0.5), 0.2)
    msp = doc.modelspace()
    refs: list[Any] = [
        msp.add_blockref("box c", (i, 0), dxfattribs={"xscale": 1 + i * 1e-7}) for i in range(3000)
    ]
    shapes = InsertShapes(ExplosionBudget(), key_cache_size=10)
    started = time.monotonic()
    results = [shapes.read(r) for r in refs]
    assert time.monotonic() - started < FAN_OUT_SECONDS
    # Up to 3e-4 of stretch: one look (two if a quantization step is crossed).
    signatures = {r.signature for r in results}
    assert 1 <= len(signatures) <= 2 and None not in signatures
    # A preview is computed once per signature and carried once, however many keys missed.
    assert sum(r.preview is not None for r in results) == len(signatures) == shapes.preview_count
    assert shapes.cached_keys <= 10


def test_preview_texts_and_block_names_are_cut_by_utf16_length() -> None:
    preview = shape_preview(
        ShapeGeometry((((0.0, 0.0), (1.0, 1.0)),), (ShapeText(0.5, 0.5, 0.1, 0.0, "😀" * 40),))
    )
    texts: Any = preview["texts"]
    [text] = texts
    assert utf16_length(text["text"]) <= MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH
    gallery = build_gallery([BoxShapeOf("H1", "block", "v1-" + "a" * 64, "😀" * 200)])
    shapes: Any = gallery["shapes"]
    [shape] = shapes
    [name] = shape["blockNames"]
    assert 250 <= utf16_length(name) <= 255
