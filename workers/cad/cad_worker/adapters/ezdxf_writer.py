"""DxfWriter with ezdxf: renders an `AsBuiltDrawing` as DXF R2018 (UTF-8, metres).

All decisions (layers, names, texts) are made in the domain; this adapter only draws. Texts are
written as single-line TEXT (never MTEXT) with a TrueType style so Arabic labels can be shown.
"""

from __future__ import annotations

import io
import math

from ezdxf.document import Drawing
from ezdxf.filemanagement import new as new_dxf
from ezdxf.lldxf.validator import is_valid_layer_name

from cad_worker.domain.asbuilt_drawing import (
    SYMBOL_BLOCKS,
    SYMBOL_SIZE_M,
    AsBuiltDrawing,
    PolylineEntity,
    SymbolEntity,
    TextEntity,
)

DXF_VERSION = "R2018"
INSUNITS_METRES = 6
TEXT_STYLE = "FTTH_TEXT"
TEXT_FONT = "arial.ttf"  # TrueType font with Arabic glyphs on Windows/AutoCAD


def _define_symbols(doc: Drawing, used: tuple[str, ...]) -> None:
    """Small symbols drawn on layer 0 with BYLAYER colour, so they take the INSERT's layer."""
    h = SYMBOL_SIZE_M / 2.0
    square = [(-h, -h), (h, -h), (h, h), (-h, h)]
    attribs = {"layer": "0"}
    for name in used:
        block = doc.blocks.new(name)
        if name == SYMBOL_BLOCKS["box"]:
            block.add_lwpolyline(square, format="xy", close=True, dxfattribs=attribs)
        elif name == SYMBOL_BLOCKS["hhi"]:
            block.add_lwpolyline(square, format="xy", close=True, dxfattribs=attribs)
            block.add_line((-h, -h), (h, h), dxfattribs=attribs)
            block.add_line((-h, h), (h, -h), dxfattribs=attribs)
        elif name == SYMBOL_BLOCKS["joint"]:
            block.add_circle((0, 0), h, dxfattribs=attribs)
        else:  # manhole
            block.add_circle((0, 0), h, dxfattribs=attribs)
            r = h * math.sqrt(0.5)
            block.add_line((-r, -r), (r, r), dxfattribs=attribs)
            block.add_line((-r, r), (r, -r), dxfattribs=attribs)


class EzdxfDxfWriter:
    def is_valid_layer_name(self, name: str) -> bool:
        return bool(is_valid_layer_name(name))

    def write(self, drawing: AsBuiltDrawing) -> bytes:
        doc = new_dxf(DXF_VERSION, setup=False)
        doc.header["$INSUNITS"] = INSUNITS_METRES
        doc.header["$MEASUREMENT"] = 1  # metric
        doc.styles.add(TEXT_STYLE, font=TEXT_FONT)
        for spec in drawing.layers:
            if spec.name in doc.layers:  # "0" exists in every drawing
                doc.layers.get(spec.name).color = spec.color
            else:
                doc.layers.add(spec.name, color=spec.color)
        _define_symbols(doc, drawing.blocks)
        msp = doc.modelspace()
        for e in drawing.entities:
            if isinstance(e, PolylineEntity):
                msp.add_lwpolyline(e.points, format="xy", dxfattribs={"layer": e.layer})
            elif isinstance(e, SymbolEntity):
                msp.add_blockref(e.block, e.position, dxfattribs={"layer": e.layer})
            elif isinstance(e, TextEntity):
                msp.add_text(
                    e.text,
                    height=e.height,
                    dxfattribs={"layer": e.layer, "style": TEXT_STYLE, "insert": e.position},
                )
        stream = io.StringIO()
        doc.write(stream)
        return stream.getvalue().encode(doc.output_encoding)  # R2007+: always UTF-8
