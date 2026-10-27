"""Summaries of a processed file that are small enough to commit as golden JSON (counts only)."""

from __future__ import annotations

from typing import Any

import psycopg


def summarize(db: psycopg.Connection[Any], cad_file_id: object) -> dict[str, Any]:
    def rows(sql: str) -> list[tuple[Any, ...]]:
        return db.execute(sql, (cad_file_id,)).fetchall()

    totals = rows(
        "SELECT layer_count, insert_count, text_count, curve_count FROM cad_files WHERE id = %s"
    )[0]
    return {
        "totals": dict(zip(("layers", "inserts", "texts", "curves"), totals, strict=True)),
        "unreadable_texts": rows(
            "SELECT count(*) FROM cad_texts WHERE cad_file_id = %s AND NOT readable"
        )[0][0],
        "entity_counts_by_layer": {
            name: counts
            for name, counts in rows(
                "SELECT name, entity_counts FROM cad_layers WHERE cad_file_id = %s "
                "AND entity_total > 0 ORDER BY name"
            )
        },
        "inserts_by_block": dict(
            rows(
                "SELECT block_name, count(*) FROM cad_inserts WHERE cad_file_id = %s "
                "GROUP BY block_name ORDER BY block_name"
            )
        ),
        # ST_Length of the flattened SRID-0 geometry, in drawing units (metres for these drawings)
        "curve_length_by_layer": {
            layer: float(length)
            for layer, length in rows(
                "SELECT layer, ROUND(SUM(length)::numeric, 2) FROM cad_curves "
                "WHERE cad_file_id = %s GROUP BY layer ORDER BY layer"
            )
        },
    }
