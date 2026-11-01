"""EzdxfDxfWriter on its own: every symbol block, the `0` layer, ezdxf recover + audit clean."""

from __future__ import annotations

import io
import uuid

from ezdxf import recover

from cad_worker.adapters.ezdxf_writer import EzdxfDxfWriter
from cad_worker.domain.asbuilt_drawing import (
    SYMBOL_BLOCKS,
    AsBuiltFeatureIn,
    DesignFeatureIn,
    build_drawing,
)
from cad_worker.domain.design import FeatureType

POINT_TYPES: tuple[FeatureType, ...] = ("box", "hhi", "joint", "mh")


def test_all_symbols_and_layer_zero_audit_clean() -> None:
    writer = EzdxfDxfWriter()
    design = [
        DesignFeatureIn(uuid.uuid4(), t, "0" if t == "box" else "NET", None, ((i * 5.0, 0.0),))
        for i, t in enumerate(POINT_TYPES)
    ]
    added = AsBuiltFeatureIn(uuid.uuid4(), "mh", True, ((50.0, 50.0),), "MH-1 %%c", 1, 1)
    drawing = build_drawing(design, [added], writer.is_valid_layer_name)

    data = writer.write(drawing)

    doc, auditor = recover.read(io.BytesIO(data))
    assert not auditor.has_errors and not auditor.has_fixes
    audit = doc.audit()
    assert not audit.has_errors and not audit.has_fixes
    assert doc.header["$INSUNITS"] == 6 and doc.header["$MEASUREMENT"] == 1
    assert set(SYMBOL_BLOCKS.values()) <= {b.name for b in doc.blocks}
    assert doc.layers.get("0").color == 7
    msp = doc.modelspace()
    assert len(msp.query("INSERT")) == 5
    assert {t.dxf.style for t in msp.query("TEXT")} == {"FTTH_TEXT"}
    assert "MH-1 %%%%%%c" in {t.dxf.text for t in msp.query("TEXT")}
    assert data.decode("utf-8")  # R2018 files are UTF-8


def test_layer_validator_is_ezdxf() -> None:
    writer = EzdxfDxfWriter()
    assert writer.is_valid_layer_name("CAP F36")
    assert not writer.is_valid_layer_name("A<B")
