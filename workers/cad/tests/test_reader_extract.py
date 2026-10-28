from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest
from ezdxf.filemanagement import new as new_dxf

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.application.extract import extract
from cad_worker.application.ports import ExtractionResult, ImportFailure
from cad_worker.domain.model import CurveRow, InsertRow, TextRow
from tests.support.dxf_samples import (
    ARABIC,
    LEGACY_SHX,
    LEGACY_SHX_DECODED,
    LEGACY_SHX_UNREADABLE,
    MOJIBAKE,
    write_corrupt,
    write_empty,
    write_sample,
    write_utm_sample,
)


class ListSink:
    def __init__(self) -> None:
        self.rows: list[InsertRow | TextRow | CurveRow] = []
        self.result: ExtractionResult | None = None

    @property
    def project_epsg(self) -> int | None:
        return 32636

    def add(self, row: InsertRow | TextRow | CurveRow) -> None:
        self.rows.append(row)

    def commit(self, result: ExtractionResult) -> None:
        self.result = result


def run(path: Path) -> tuple[ListSink, ExtractionResult]:
    sink = ListSink()
    result = extract(
        EzdxfReader().open(path),
        sink,
        converter="none",
        converter_version=None,
        converted_storage_key=None,
        converter_log="",
        project_epsg=sink.project_epsg,
    )
    return sink, result


@pytest.fixture
def sample(tmp_path: Path) -> tuple[ListSink, ExtractionResult]:
    return run(write_sample(tmp_path / "sample.dxf"))


def test_layers_flags_and_colours(sample: tuple[ListSink, ExtractionResult]) -> None:
    layers = {row.definition.name: row for row in sample[1].layers}
    assert layers["CABLE"].definition.aci_color == 3
    assert layers["TX"].definition.true_color == 0xFF8800
    assert layers["FROZEN"].definition.is_frozen
    assert not layers["OFF"].definition.is_on and layers["OFF"].definition.aci_color == 2
    assert layers["LOCKED"].definition.is_locked
    assert layers["CABLE"].entity_counts["LWPOLYLINE"] == 4  # includes the degenerate one
    assert layers["CABLE"].entity_total == sum(layers["CABLE"].entity_counts.values())


def test_inserts_with_attributes(sample: tuple[ListSink, ExtractionResult]) -> None:
    inserts = [r for r in sample[0].rows if isinstance(r, InsertRow)]
    assert Counter(i.block_name for i in inserts) == {"sub": 4, "JONT 144": 1}
    first = next(i for i in inserts if i.attributes and i.attributes[0].raw_value == "S0")
    assert first.position == (100.0, 200.0, 5.0)
    assert first.rotation == 90 and first.scale == (2.0, 1.0, 1.0)
    arabic = next(i for i in inserts if i.attributes and i.attributes[0].raw_value == ARABIC)
    assert arabic.attributes[0].readable and arabic.attributes[0].tag == "NAME"
    joint = next(i for i in inserts if i.block_name == "JONT 144")
    legacy = joint.attributes[0]  # attributes go through the same SHX table as texts
    assert (legacy.raw_value, legacy.value, legacy.readable) == (
        LEGACY_SHX,
        LEGACY_SHX_DECODED,
        True,
    )


def texts(sink: ListSink) -> dict[str, TextRow]:
    return {r.raw_text: r for r in sink.rows if isinstance(r, TextRow)}


def test_texts_readable_and_not(sample: tuple[ListSink, ExtractionResult]) -> None:
    by_raw = texts(sample[0])
    assert by_raw[ARABIC].readable and by_raw[ARABIC].text == ARABIC
    legacy = by_raw[LEGACY_SHX]
    assert legacy.readable and legacy.font == "xarb.shx" and legacy.text == LEGACY_SHX_DECODED
    unreadable = by_raw[LEGACY_SHX_UNREADABLE]  # upper-case key under a legacy font
    assert not unreadable.readable and unreadable.text == LEGACY_SHX_UNREADABLE
    assert not by_raw[MOJIBAKE].readable
    assert by_raw["45%%d"].text == "45°"
    mtext = next(t for t in by_raw.values() if t.kind == "mtext")
    assert mtext.text == "Hello\nworld" or mtext.text == "Hello world"
    assert mtext.raw_text.startswith("{\\fArial")


def test_curves_flattening_and_flags(sample: tuple[ListSink, ExtractionResult]) -> None:
    curves = [r for r in sample[0].rows if isinstance(r, CurveRow)]
    assert Counter(c.entity_type for c in curves) == {
        "LINE": 1,
        "LWPOLYLINE": 3,
        "POLYLINE": 1,
        "ARC": 1,
        "CIRCLE": 1,
        "SPLINE": 1,
    }
    by_type: dict[str, list[CurveRow]] = {}
    for c in curves:
        by_type.setdefault(c.entity_type, []).append(c)
    line = by_type["LINE"][0]
    assert line.points == ((0, 0, 1), (30, 40, 1)) and line.flatten_tolerance is None
    plain = next(c for c in by_type["LWPOLYLINE"] if len(c.points) == 3)
    assert plain.flatten_tolerance is None and not plain.is_closed
    rect = next(c for c in by_type["LWPOLYLINE"] if c.is_closed)
    assert rect.points[0] == rect.points[-1] and len(rect.points) == 5
    bulge = next(c for c in by_type["LWPOLYLINE"] if len(c.points) > 5)
    assert bulge.flatten_tolerance == pytest.approx(0.001)
    assert _length(bulge) == pytest.approx(math.pi * 5, abs=0.01)
    assert _length(by_type["ARC"][0]) == pytest.approx(10 * math.pi / 2, abs=0.01)
    circle = by_type["CIRCLE"][0]
    assert circle.is_closed and circle.points[0] == circle.points[-1]
    assert _length(by_type["POLYLINE"][0]) == pytest.approx(5.0)  # 2D length of the 3D polyline
    assert by_type["POLYLINE"][0].points[-1] == (3, 4, 12)


def _length(curve: CurveRow) -> float:
    return sum(
        math.dist(a[:2], b[:2]) for a, b in zip(curve.points, curve.points[1:], strict=False)
    )


def test_warnings_and_counts(sample: tuple[ListSink, ExtractionResult]) -> None:
    result = sample[1]
    warnings = {(w.code, tuple((w.params or {}).items())): w.count for w in result.warnings}
    assert warnings[("UNSUPPORTED_ENTITY", (("entityType", "ELLIPSE"),))] == 1
    assert warnings[("UNSUPPORTED_ENTITY", (("entityType", "HATCH"),))] == 1
    assert (
        warnings[("UNSUPPORTED_ENTITY", (("entityType", "LWPOLYLINE"), ("reason", "degenerate")))]
        == 1
    )
    unreadable = sum(w.count for w in result.warnings if w.code == "UNREADABLE_TEXT")
    assert unreadable == 2  # "12 M" (upper-case key under the legacy font), mojibake
    assert any(w.code == "CURVE_APPROXIMATED" for w in result.warnings)
    assert not any(w.code in ("UNITS_UNSPECIFIED", "EMPTY_MODELSPACE") for w in result.warnings)
    assert (result.insert_count, result.text_count, result.curve_count) == (5, 6, 8)


def test_extents_from_entities(sample: tuple[ListSink, ExtractionResult]) -> None:
    ext = sample[1].extents
    assert ext is not None
    assert ext.min_x == pytest.approx(0, abs=1e-6) and ext.min_y == pytest.approx(-5, abs=1e-3)
    assert ext.max_x == pytest.approx(120, abs=1e-6) and ext.max_y == pytest.approx(220, abs=1e-6)


def test_empty_drawing_warns(tmp_path: Path) -> None:
    sink, result = run(write_empty(tmp_path / "empty.dxf"))
    assert sink.rows == [] and result.extents is None
    codes = {w.code for w in result.warnings}
    assert {"EMPTY_MODELSPACE", "UNITS_UNSPECIFIED"} <= codes


def test_corrupt_file_is_dxf_unreadable(tmp_path: Path) -> None:
    with pytest.raises(ImportFailure) as exc:
        EzdxfReader().open(write_corrupt(tmp_path / "bad.dxf"))
    assert exc.value.code == "DXF_UNREADABLE"


def test_duplicate_handles_are_made_unique(tmp_path: Path) -> None:
    from cad_worker.domain.model import DrawingMeta, Feature

    class Source:
        meta = DrawingMeta("AC1032", 6, ())

        def features(self) -> Iterator[Feature]:
            row = CurveRow("A1", "LINE", "L", ((0, 0, 0), (1, 1, 0)), False, None, 256)
            return iter([row, row])

    sink = ListSink()
    result = extract(
        Source(),
        sink,
        converter="none",
        converter_version=None,
        converted_storage_key=None,
        converter_log="",
    )
    assert [r.handle for r in sink.rows] == ["A1", "A1~1"]
    assert "duplicate handles renamed: 1" in result.log


def test_extrusion_mirrored_arc_is_converted_to_wcs(tmp_path: Path) -> None:
    doc = new_dxf("R2018")
    doc.modelspace().add_arc((10, 0), 5, 0, 180, dxfattribs={"layer": "0", "extrusion": (0, 0, -1)})
    doc.saveas(tmp_path / "ocs.dxf")
    sink, _ = run(tmp_path / "ocs.dxf")
    arc = next(r for r in sink.rows if isinstance(r, CurveRow))
    assert arc.points[0] == pytest.approx((-15, 0, 0), abs=1e-9)
    assert arc.points[-1] == pytest.approx((-5, 0, 0), abs=1e-9)


def test_crs_detection_and_units_mismatch_warning(tmp_path: Path) -> None:
    _, result = run(write_utm_sample(tmp_path / "utm.dxf", ins_units=1))
    crs = result.crs_detection.to_json()
    assert crs["kind"] == "projected_utm" and crs["suggestedEpsg"] == 32636
    assert crs["unitsConflict"] is True
    mismatch = [w for w in result.warnings if w.code == "UNITS_CRS_MISMATCH"]
    assert [w.to_json() for w in mismatch] == [
        {"code": "UNITS_CRS_MISMATCH", "count": 1, "params": {"declared": "in", "implied": "m"}}
    ]
    assert "crs: projected_utm MATCHES_PROJECT_CRS" in result.log


def test_no_mismatch_warning_when_units_agree(tmp_path: Path) -> None:
    _, result = run(write_utm_sample(tmp_path / "utm.dxf", ins_units=6))
    assert result.crs_detection.units_conflict is False
    assert not any(w.code == "UNITS_CRS_MISMATCH" for w in result.warnings)
