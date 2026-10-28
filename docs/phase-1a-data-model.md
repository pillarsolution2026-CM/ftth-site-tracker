# Phase 1a data model

Source of truth: `apps/api/src/db/migrations/0003_work_orders_and_cad.sql`. `schema.ts` is updated by backend-dev to match (Drizzle names in camelCase). Generated columns (`amount`, `length`, `vertex_count`) are read-only: never insert them.

Conventions: every table has `project_id`; children reference the parent by `(project_id, <parent>_id)` → `parent (project_id, id)` with `ON DELETE CASCADE`; `updated_at` is set by the `set_updated_at()` trigger (do not set it in code); geometry in `cad_*` is drawing coordinates with SRID 0.

## Work orders

| Table | Columns | Constraints |
| --- | --- | --- |
| `work_orders` | id, project_id, number, title?, issued_on? (date), notes?, currency char(3), source (`manual`/`import`), version int, created_by?, created_at, updated_at | unique (project_id, number); unique (project_id, id); currency and project_id immutable (trigger) |
| `work_order_items` | id, project_id, work_order_id, line_no, code, description, unit (≤ 64), quantity numeric(18,4), unit_price numeric(20,6), **amount numeric(38,10) generated = quantity × unit_price**, work_type? (`civil`/`installation`/`planning`; NULL only before migration 0004), source, source_row?, created_at, updated_at | unique (work_order_id, line_no) deferrable; quantity ≥ 0, unit_price ≥ 0; index (work_order_id, code); index (work_order_id, work_type); no unique on code (duplicates need explicit acceptance). Changed by ADR-016 (migration 0004). |
| `work_order_attachments` | id, project_id, work_order_id, kind (`document`/`import_source`), file_name, content_type, size_bytes, sha256, storage_key (unique), uploaded_by?, created_at | `document` ⇔ PDF, `import_source` ⇔ xlsx |

Repository rules: every header or item change bumps `work_orders.version` in the same transaction. List totals may use `SUM(amount)`; detail totals come from the domain `Decimal` (the DB test asserts they are equal).

## CAD

| Table | Columns | Notes |
| --- | --- | --- |
| `cad_files` | id, project_id, original_name, format (`dwg`/`dxf`), size_bytes, sha256, storage_key (unique), converted_storage_key?, status, current_job_id?, converter? (`oda`/`libredwg`/`none`), converter_version?, dxf_version?, ins_units?, extents_min_x/y, extents_max_x/y?, layer_count/insert_count/text_count/curve_count?, warnings jsonb[] (`CadWarning`), log?, error_code?, error_message?, uploaded_by?, created_at, updated_at, queued_at?, processing_started_at?, processed_at? | original fields immutable (trigger); `failed` ⇔ error_code set (clear it on reprocess); any status but `uploaded` needs current_job_id |
| `cad_layers` | id, project_id, cad_file_id, name, aci_color 1..255, true_color?, linetype?, is_on, is_frozen, is_locked, entity_counts jsonb {type: n}, entity_total | unique (cad_file_id, name) |
| `cad_inserts` | id, project_id, cad_file_id, handle, layer, block_name, position PointZ/0, rotation (deg), scale_x/y/z, aci_color 0..256, attributes jsonb `[{tag, rawValue, value, readable}]` | unique (cad_file_id, handle); gist(position) |
| `cad_texts` | id, project_id, cad_file_id, handle, kind (`text`/`mtext`), layer, position PointZ/0, height, rotation, raw_text, text, readable, style?, font?, aci_color | unique (cad_file_id, handle); partial index on unreadable |
| `cad_curves` | id, project_id, cad_file_id, handle, entity_type (LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, SPLINE), layer, geom LineStringZ/0, is_closed, flatten_tolerance? (NULL = exact), aci_color, **length generated = ST_Length(geom)**, **vertex_count generated = ST_NPoints(geom)** | unique (cad_file_id, handle); gist(geom) |

Worker rules: only model-space entities; entities without a handle (virtual/exploded) get `"<parentHandle>/<n>"`. Layer colour is stored as `abs(color)`; a negative DXF colour sets `is_on = false`. Extraction rows for a file are replaced as a whole in one transaction.
