"""Synthetic drawings built with ezdxf, so tests run without the client's real files."""

from __future__ import annotations

from pathlib import Path

from ezdxf.document import Drawing
from ezdxf.filemanagement import new as new_dxf

ARABIC = "مقابر"
MOJIBAKE = "Ù…Ø­Ù„"  # "محل" encoded as UTF-8 and read as cp1252
LEGACY_SHX = "lrhfv"  # xarb.shx key codes


def sample_doc() -> Drawing:
    doc = new_dxf("R2018", setup=True)
    doc.header["$INSUNITS"] = 6
    doc.layers.add("CABLE", color=3)
    doc.layers.add("TX", color=1, true_color=0xFF8800)
    doc.layers.add("FROZEN", color=5).freeze()
    doc.layers.add("OFF", color=2).off()
    doc.layers.add("LOCKED", color=6).lock()
    doc.styles.add("x", font="xarb.shx")
    doc.styles.add("Arabic", font="arial.ttf")

    block = doc.blocks.new("sub")
    block.add_attdef("NAME", (0, 0), dxfattribs={"height": 1})
    for i in range(3):
        insert = doc.modelspace().add_blockref(
            "sub", (100 + i, 200, 5), dxfattribs={"layer": "CABLE", "rotation": 90, "xscale": 2}
        )
        insert.add_attrib("NAME", f"S{i}", (100 + i, 200))
    arabic_insert = doc.modelspace().add_blockref("sub", (110, 210), dxfattribs={"layer": "CABLE"})
    arabic_insert.add_attrib("NAME", ARABIC, (110, 210), dxfattribs={"style": "Arabic"})
    doc.blocks.new("JONT 144")
    doc.modelspace().add_blockref("JONT 144", (120, 220), dxfattribs={"layer": "CABLE"})
    _add_texts(doc)
    _add_curves(doc)
    return doc


def _add_texts(doc: Drawing) -> None:
    msp = doc.modelspace()
    msp.add_text(
        ARABIC, height=2.5, dxfattribs={"layer": "TX", "style": "Arabic", "insert": (1, 2)}
    )
    msp.add_text(LEGACY_SHX, height=2.5, dxfattribs={"layer": "TX", "style": "x", "insert": (3, 4)})
    msp.add_text("12 m", height=2.5, dxfattribs={"layer": "TX", "style": "x", "insert": (5, 6)})
    msp.add_text(MOJIBAKE, height=2.5, dxfattribs={"layer": "TX", "insert": (7, 8)})
    msp.add_text("45%%d", height=1, dxfattribs={"layer": "TX", "insert": (9, 10)})
    msp.add_mtext("{\\fArial|b1;Hello}\\Pworld", dxfattribs={"layer": "TX", "insert": (11, 12)})


def _add_curves(doc: Drawing) -> None:
    msp = doc.modelspace()
    msp.add_line((0, 0, 1), (30, 40, 1), dxfattribs={"layer": "CABLE"})
    msp.add_lwpolyline([(0, 0), (10, 0), (10, 10)], dxfattribs={"layer": "CABLE"})
    msp.add_lwpolyline([(0, 0, 0, 0, 1.0), (10, 0)], dxfattribs={"layer": "CABLE"})  # semicircle
    msp.add_lwpolyline([(0, 0), (4, 0), (4, 3), (0, 3)], close=True, dxfattribs={"layer": "CABLE"})
    msp.add_lwpolyline([(5, 5)], dxfattribs={"layer": "CABLE"})  # degenerate
    msp.add_polyline3d([(0, 0, 0), (3, 4, 0), (3, 4, 12)], dxfattribs={"layer": "CABLE"})
    msp.add_arc((0, 0), 10, 0, 90, dxfattribs={"layer": "CABLE"})
    msp.add_circle((50, 50), 5, dxfattribs={"layer": "CABLE"})
    msp.add_spline([(0, 0), (5, 5), (10, 0), (15, 5)], dxfattribs={"layer": "CABLE"})
    msp.add_ellipse((0, 0), (4, 0), 0.5, dxfattribs={"layer": "CABLE"})  # unsupported
    hatch = msp.add_hatch(dxfattribs={"layer": "CABLE"})
    hatch.paths.add_polyline_path([(0, 0), (1, 0), (1, 1)], is_closed=True)


def write_sample(path: Path) -> Path:
    sample_doc().saveas(path)
    return path


def write_empty(path: Path) -> Path:
    doc = new_dxf("R2018")
    doc.header["$INSUNITS"] = 0
    doc.saveas(path)
    return path


def write_corrupt(path: Path) -> Path:
    path.write_bytes(b"\x00\x01 this is not a drawing \xff\xfe" * 20)
    return path
