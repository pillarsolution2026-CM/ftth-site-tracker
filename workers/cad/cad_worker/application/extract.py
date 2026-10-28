"""Feature stream -> sink + statistics (layers, counts, extents, warnings). Pure orchestration."""

from __future__ import annotations

import dataclasses
from collections import Counter, defaultdict
from typing import Literal

from cad_worker.application.ports import DrawingSource, ExtractionResult, ResultSink
from cad_worker.domain.crs_detect import detect_crs
from cad_worker.domain.extents import ExtentsAccumulator
from cad_worker.domain.flatten import FLATTEN_TOLERANCE
from cad_worker.domain.model import (
    CurveRow,
    InsertRow,
    LayerDef,
    LayerRow,
    SkippedEntity,
    TextRow,
)
from cad_worker.domain.warnings import WarningCollector

DEFAULT_ACI = 7


def _unique_handle(handle: str, seen: set[str]) -> str:
    candidate, n = handle, 1
    while candidate in seen:
        candidate = f"{handle}~{n}"
        n += 1
    seen.add(candidate)
    return candidate


def extract(
    source: DrawingSource,
    sink: ResultSink,
    *,
    converter: Literal["libredwg", "oda", "none"],
    converter_version: str | None,
    converted_storage_key: str | None,
    converter_log: str,
    project_epsg: int | None = None,
) -> ExtractionResult:
    meta = source.meta
    warnings = WarningCollector()
    extents = ExtentsAccumulator()
    layer_counts: dict[str, Counter[str]] = defaultdict(Counter)
    seen: dict[str, set[str]] = {"insert": set(), "text": set(), "curve": set()}
    n_insert = n_text = n_curve = 0
    renamed = 0

    for feature in source.features():
        if isinstance(feature, SkippedEntity):
            layer_counts[feature.layer][feature.dxf_type] += 1
            _warn_skipped(warnings, feature)
        elif isinstance(feature, InsertRow):
            handle = _unique_handle(feature.handle, seen["insert"])
            renamed += handle != feature.handle
            row = dataclasses.replace(feature, handle=handle)
            sink.add(row)
            n_insert += 1
            layer_counts[row.layer]["INSERT"] += 1
            extents.add(row.position[0], row.position[1])
            unreadable = sum(1 for a in row.attributes if not a.readable)
            if unreadable:
                warnings.add("UNREADABLE_TEXT", unreadable, source="attribute")
        elif isinstance(feature, TextRow):
            handle = _unique_handle(feature.handle, seen["text"])
            renamed += handle != feature.handle
            trow = dataclasses.replace(feature, handle=handle)
            sink.add(trow)
            n_text += 1
            layer_counts[trow.layer][trow.kind.upper()] += 1
            extents.add(trow.position[0], trow.position[1])
            if not trow.readable:
                warnings.add("UNREADABLE_TEXT", font=trow.font or "unknown", source="text")
        else:
            handle = _unique_handle(feature.handle, seen["curve"])
            renamed += handle != feature.handle
            crow: CurveRow = dataclasses.replace(feature, handle=handle)
            sink.add(crow)
            n_curve += 1
            layer_counts[crow.layer][crow.entity_type] += 1
            extents.add_points(crow.points)
            if crow.flatten_tolerance is not None:
                warnings.add("CURVE_APPROXIMATED", tolerance=crow.flatten_tolerance)

    layers = _layer_rows(meta.layers, layer_counts)
    total = sum(r.entity_total for r in layers)
    if total == 0:
        warnings.add("EMPTY_MODELSPACE")
    if not meta.ins_units:
        warnings.add("UNITS_UNSPECIFIED")
    # LibreDWG output always carries harmless orphan XRECORDs that the audit deletes; for a
    # converted file only unfixable errors are worth a warning (fixes stay in the log).
    recovered = meta.recover_errors + (0 if converter != "none" else meta.recover_fixes)
    if recovered:
        warnings.add("DXF_RECOVERED", recovered)
    for name in meta.xref_blocks:
        warnings.add("XREF_NOT_RESOLVED", name=name)
    if converter != "none":
        warnings.add("DWG_CONVERTED", converter=converter)
    drawing_extents = extents.result()
    crs = detect_crs(drawing_extents, meta.ins_units, project_epsg)
    if crs.units_conflict and crs.declared_unit and crs.implied_unit:
        warnings.add("UNITS_CRS_MISMATCH", declared=crs.declared_unit, implied=crs.implied_unit)

    log = [
        converter_log.strip(),
        f"extraction: layers={len(layers)} inserts={n_insert} texts={n_text} curves={n_curve} "
        f"entities={total} flatten_tolerance={FLATTEN_TOLERANCE}",
        f"recover: fixes={meta.recover_fixes} errors={meta.recover_errors}",
        f"crs: {crs.kind} {crs.reason} suggested={crs.suggested_epsg} "
        f"implied={crs.implied_unit} declared={crs.declared_unit}",
    ]
    if renamed:
        log.append(f"duplicate handles renamed: {renamed}")
    return ExtractionResult(
        layers=layers,
        insert_count=n_insert,
        text_count=n_text,
        curve_count=n_curve,
        extents=drawing_extents,
        warnings=warnings.result(),
        log="\n".join(line for line in log if line),
        dxf_version=meta.dxf_version,
        ins_units=meta.ins_units,
        converter=converter,
        converter_version=converter_version,
        converted_storage_key=converted_storage_key,
        crs_detection=crs,
    )


def _warn_skipped(warnings: WarningCollector, item: SkippedEntity) -> None:
    if item.reason == "proxy":
        warnings.add("PROXY_ENTITY", entityType=item.dxf_type)
    elif item.reason == "unsupported":
        warnings.add("UNSUPPORTED_ENTITY", entityType=item.dxf_type)
    else:
        warnings.add("UNSUPPORTED_ENTITY", entityType=item.dxf_type, reason=item.reason)


def _layer_rows(defs: tuple[LayerDef, ...], counts: dict[str, Counter[str]]) -> list[LayerRow]:
    rows = {d.name: LayerRow(d, dict(counts.get(d.name, {}))) for d in defs}
    for name, counter in counts.items():
        if name not in rows:  # entity on an undefined layer: AutoCAD treats it as a default layer
            default = LayerDef(name, DEFAULT_ACI, None, None, True, False, False)
            rows[name] = LayerRow(default, dict(counter))
    return sorted(rows.values(), key=lambda r: r.definition.name)
