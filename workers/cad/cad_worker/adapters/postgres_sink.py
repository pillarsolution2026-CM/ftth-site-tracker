"""Streams extraction rows into PostgreSQL with COPY, inside the caller's transaction."""

from __future__ import annotations

import json
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from cad_worker.adapters.job_message import CadImportJob
from cad_worker.adapters.wkt import linestring_z, point_z
from cad_worker.application.ports import ExtractionResult
from cad_worker.domain.box_shapes import MAX_BOX_SHAPE_BLOCK_NAMES, MAX_FILE_SHAPES
from cad_worker.domain.model import CurveRow, InsertRow, LayerRow, TextRow

COPY_INSERTS = (
    "COPY cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, centre, "
    "rotation, scale_x, scale_y, scale_z, aci_color, attributes, shape_signature) FROM STDIN"
)
# ADR-043: one preview per distinct insert shape of the file (migration 0023).
COPY_FILE_SHAPES = (
    "COPY cad_file_shapes (project_id, cad_file_id, shape_signature, insert_count, block_names, "
    "preview) FROM STDIN"
)
MAX_BLOCK_NAME = 255


class _FileShape:
    """One distinct insert shape of the file: how many inserts, which block names, a preview."""

    __slots__ = ("block_names", "count", "preview")

    def __init__(self, preview: str | None) -> None:
        self.count = 0
        self.block_names: set[str] = set()
        self.preview = preview

    def row(self, ids: tuple[str, str], sig: str) -> tuple[Any, ...]:
        names = sorted(self.block_names)[:MAX_BOX_SHAPE_BLOCK_NAMES]
        return (*ids, sig, self.count, json.dumps(names, ensure_ascii=False), self.preview)


COPY_TEXTS = (
    "COPY cad_texts (project_id, cad_file_id, handle, kind, layer, position, height, rotation, "
    "raw_text, text, readable, style, font, aci_color) FROM STDIN"
)
COPY_CURVES = (
    "COPY cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom, is_closed, "
    "flatten_tolerance, aci_color) FROM STDIN"
)
COPY_LAYERS = (
    "COPY cad_layers (project_id, cad_file_id, name, aci_color, true_color, linetype, is_on, "
    "is_frozen, is_locked, entity_counts, entity_total) FROM STDIN"
)
UPDATE_FILE = """
UPDATE cad_files SET status = 'processed', processed_at = now(), error_code = NULL,
  error_message = NULL, converter = %s, converter_version = %s, converted_storage_key = %s,
  dxf_version = %s, ins_units = %s, extents_min_x = %s, extents_min_y = %s, extents_max_x = %s,
  extents_max_y = %s, layer_count = %s, insert_count = %s, text_count = %s, curve_count = %s,
  warnings = %s, log = %s, crs_detection = %s
WHERE id = %s AND project_id = %s AND current_job_id = %s AND status = 'processing'
"""


def insert_event(
    conn: psycopg.Connection[Any], job: CadImportJob, event_type: str, payload: dict[str, Any]
) -> None:
    conn.execute(
        "INSERT INTO events (project_id, entity, entity_id, type, payload) "
        "VALUES (%s, 'cad_file', %s, %s, %s)",
        (job.project_id, str(job.cad_file_id), event_type, Jsonb(payload)),
    )


class PostgresSink:
    def __init__(
        self,
        conn: psycopg.Connection[Any],
        job: CadImportJob,
        batch_size: int,
        project_epsg: int | None = None,
    ) -> None:
        self._conn = conn
        self._project_epsg = project_epsg
        self._job = job
        self._batch = batch_size
        self._ids = (str(job.project_id), str(job.cad_file_id))
        self._inserts: list[tuple[Any, ...]] = []
        self._texts: list[tuple[Any, ...]] = []
        self._curves: list[tuple[Any, ...]] = []
        # Distinct insert shapes in drawing order; previews kept for the first MAX_FILE_SHAPES.
        self._shapes: dict[str, _FileShape] = {}
        self.committed = False

    @property
    def project_epsg(self) -> int | None:
        return self._project_epsg

    def add(self, row: InsertRow | TextRow | CurveRow) -> None:
        if isinstance(row, InsertRow):
            self._keep_shape(row)
            self._inserts.append(self._insert_tuple(row))
            if len(self._inserts) >= self._batch:
                self._flush(COPY_INSERTS, self._inserts)
        elif isinstance(row, TextRow):
            self._texts.append(self._text_tuple(row))
            if len(self._texts) >= self._batch:
                self._flush(COPY_TEXTS, self._texts)
        else:
            self._curves.append(self._curve_tuple(row))
            if len(self._curves) >= self._batch:
                self._flush(COPY_CURVES, self._curves)

    def commit(self, result: ExtractionResult) -> None:
        self._flush(COPY_INSERTS, self._inserts)
        self._flush(COPY_TEXTS, self._texts)
        self._flush(COPY_CURVES, self._curves)
        self._flush(COPY_LAYERS, [self._layer_tuple(layer) for layer in result.layers])
        self._flush(
            COPY_FILE_SHAPES, [shape.row(self._ids, sig) for sig, shape in self._shapes.items()]
        )
        e = result.extents
        cur = self._conn.execute(
            UPDATE_FILE,
            (
                result.converter,
                result.converter_version,
                result.converted_storage_key,
                result.dxf_version,
                result.ins_units,
                e.min_x if e else None,
                e.min_y if e else None,
                e.max_x if e else None,
                e.max_y if e else None,
                len(result.layers),
                result.insert_count,
                result.text_count,
                result.curve_count,
                Jsonb([w.to_json() for w in result.warnings]),
                result.log,
                Jsonb(result.crs_detection.to_json()),
                self._job.cad_file_id,
                self._job.project_id,
                self._job.id,
            ),
        )
        if cur.rowcount != 1:
            raise RuntimeError("cad_files row changed during processing")
        insert_event(
            self._conn,
            self._job,
            "cad_file.processed",
            {
                "jobId": str(self._job.id),
                "attempt": self._job.attempt,
                "counts": {
                    "layers": len(result.layers),
                    "inserts": result.insert_count,
                    "texts": result.text_count,
                    "curves": result.curve_count,
                },
                "warningCount": len(result.warnings),
                "converter": result.converter,
                "crsDetection": result.crs_detection.to_json(),
            },
        )
        self._conn.commit()
        self.committed = True

    def _flush(self, sql: str, rows: list[tuple[Any, ...]]) -> None:
        if not rows:
            return
        with self._conn.cursor() as cur, cur.copy(sql) as copy:
            for row in rows:
                copy.write_row(row)
        rows.clear()

    def _keep_shape(self, r: InsertRow) -> None:
        """Every distinct signature gets a row with its insert count and block names (≤ 20, each
        ≤ 255 characters); the preview only for the first MAX_FILE_SHAPES shapes, NULL beyond (the
        gallery then shows no picture for that shape)."""
        sig = r.shape_signature
        if sig is None:
            return
        shape = self._shapes.get(sig)
        if shape is None:
            keep = r.shape_preview is not None and len(self._shapes) < MAX_FILE_SHAPES
            preview = json.dumps(r.shape_preview, ensure_ascii=False) if keep else None
            shape = self._shapes[sig] = _FileShape(preview)
        shape.count += 1
        if len(shape.block_names) < MAX_BOX_SHAPE_BLOCK_NAMES or r.block_name in shape.block_names:
            shape.block_names.add(r.block_name[:MAX_BLOCK_NAME])

    def _insert_tuple(self, r: InsertRow) -> tuple[Any, ...]:
        attrs = [
            {"tag": a.tag, "rawValue": a.raw_value, "value": a.value, "readable": a.readable}
            for a in r.attributes
        ]
        return (
            *self._ids,
            r.handle,
            r.layer,
            r.block_name,
            point_z(r.position),
            point_z(r.centre) if r.centre is not None else None,
            r.rotation,
            *r.scale,
            r.aci_color,
            json.dumps(attrs, ensure_ascii=False),
            r.shape_signature,
        )

    def _text_tuple(self, r: TextRow) -> tuple[Any, ...]:
        return (
            *self._ids,
            r.handle,
            r.kind,
            r.layer,
            point_z(r.position),
            r.height,
            r.rotation,
            r.raw_text,
            r.text,
            r.readable,
            r.style,
            r.font,
            r.aci_color,
        )

    def _curve_tuple(self, r: CurveRow) -> tuple[Any, ...]:
        return (
            *self._ids,
            r.handle,
            r.entity_type,
            r.layer,
            linestring_z(r.points),
            r.is_closed,
            r.flatten_tolerance,
            r.aci_color,
        )

    def _layer_tuple(self, layer: LayerRow) -> tuple[Any, ...]:
        d = layer.definition
        return (
            *self._ids,
            d.name,
            d.aci_color,
            d.true_color,
            d.linetype,
            d.is_on,
            d.is_frozen,
            d.is_locked,
            json.dumps(layer.entity_counts),
            layer.entity_total,
        )
