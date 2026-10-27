-- 0003 Work orders (أوامر التكليف) and raw CAD extraction (Phase 1a). ADR-011, ADR-012, ADR-013.
-- Every table carries project_id; children reference parents through (project_id, id) so a row can
-- never point at a parent in another project (pattern from 0002).

-- Generic updated_at maintenance (first use; later migrations reuse it).
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------------------------
CREATE TABLE work_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number      text        NOT NULL CHECK (btrim(number) <> '' AND length(number) <= 64),
  title       text        CHECK (length(title) <= 200),
  issued_on   date,
  notes       text        CHECK (length(notes) <= 4000),
  -- Copied from projects.currency at creation; never changes afterwards.
  currency    char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source      text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  -- Optimistic concurrency; bumped by the repository on every header or item change.
  version     integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_orders_project_number_key UNIQUE (project_id, number),
  CONSTRAINT work_orders_project_id_id_key UNIQUE (project_id, id)
);
CREATE TRIGGER work_orders_set_updated_at
  BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- currency is a snapshot taken at creation.
CREATE FUNCTION work_orders_freeze_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'work_orders.currency and project_id are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_orders_freeze
  BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION work_orders_freeze_currency();

CREATE TABLE work_order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid           NOT NULL,
  work_order_id  uuid           NOT NULL,
  line_no        integer        NOT NULL CHECK (line_no >= 1),
  code           text           NOT NULL CHECK (btrim(code) <> '' AND length(code) <= 64),
  description    text           NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 2000),
  unit           text           NOT NULL CHECK (btrim(unit) <> '' AND length(unit) <= 32),
  quantity       numeric(18, 4) NOT NULL CHECK (quantity >= 0),
  unit_price     numeric(18, 4) NOT NULL CHECK (unit_price >= 0),
  -- Exact product (scale 8), never rounded here. The domain computes the same value; a DB-level
  -- test asserts Σ amount = domain total.
  amount         numeric(36, 8) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  source         text           NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  source_row     integer        CHECK (source_row >= 1),   -- Excel row number when imported
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT work_order_items_order_fkey
    FOREIGN KEY (project_id, work_order_id) REFERENCES work_orders (project_id, id) ON DELETE CASCADE,
  -- Deferrable so a future renumbering can swap line numbers inside one transaction.
  CONSTRAINT work_order_items_line_no_key UNIQUE (work_order_id, line_no) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT work_order_items_project_id_id_key UNIQUE (project_id, id)
);
-- Duplicate codes are allowed only when a user accepted them (checked by the application), so no
-- unique constraint on code; this index supports the duplicate check and BOQ matching (Phase 2).
CREATE INDEX work_order_items_order_code_idx ON work_order_items (work_order_id, code);
CREATE TRIGGER work_order_items_set_updated_at
  BEFORE UPDATE ON work_order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_order_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL,
  work_order_id  uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('document', 'import_source')),
  file_name      text        NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 255),
  content_type   text        NOT NULL CHECK (content_type IN (
                   'application/pdf',
                   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes     bigint      NOT NULL CHECK (size_bytes > 0),
  sha256         char(64)    NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key    text        NOT NULL UNIQUE,
  uploaded_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_order_attachments_order_fkey
    FOREIGN KEY (project_id, work_order_id) REFERENCES work_orders (project_id, id) ON DELETE CASCADE,
  CONSTRAINT work_order_attachments_kind_type CHECK (
    (kind = 'document' AND content_type = 'application/pdf') OR
    (kind = 'import_source' AND content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
);
CREATE INDEX work_order_attachments_order_idx ON work_order_attachments (work_order_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- CAD files and raw extraction (drawing coordinates, SRID 0, until the CRS is confirmed in 1b)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cad_files (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  original_name          text        NOT NULL CHECK (btrim(original_name) <> '' AND length(original_name) <= 255),
  format                 text        NOT NULL CHECK (format IN ('dwg', 'dxf')),
  size_bytes             bigint      NOT NULL CHECK (size_bytes > 0),
  sha256                 char(64)    NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key            text        NOT NULL UNIQUE,   -- immutable original
  converted_storage_key  text,                          -- DXF produced from a DWG by the worker
  status                 text        NOT NULL DEFAULT 'uploaded'
                           CHECK (status IN ('uploaded', 'queued', 'processing', 'processed', 'failed')),
  -- Id of the only job allowed to change this row (ADR-013); a newer reprocess supersedes it.
  current_job_id         uuid,
  converter              text        CHECK (converter IN ('oda', 'libredwg', 'none')),
  converter_version      text,
  dxf_version            text,
  ins_units              integer,
  extents_min_x          double precision,
  extents_min_y          double precision,
  extents_max_x          double precision,
  extents_max_y          double precision,
  layer_count            integer     CHECK (layer_count >= 0),
  insert_count           integer     CHECK (insert_count >= 0),
  text_count             integer     CHECK (text_count >= 0),
  curve_count            integer     CHECK (curve_count >= 0),
  warnings               jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  log                    text,
  error_code             text,
  error_message          text,
  uploaded_by            uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  queued_at              timestamptz,
  processing_started_at  timestamptz,
  processed_at           timestamptz,
  CONSTRAINT cad_files_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT cad_files_extents_complete CHECK (
    (extents_min_x IS NULL) = (extents_max_x IS NULL) AND
    (extents_min_y IS NULL) = (extents_max_y IS NULL) AND
    (extents_min_x IS NULL) = (extents_min_y IS NULL)),
  CONSTRAINT cad_files_failed_has_code CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT cad_files_queued_has_job CHECK (status = 'uploaded' OR current_job_id IS NOT NULL)
);
CREATE INDEX cad_files_project_created_idx ON cad_files (project_id, created_at DESC);
CREATE INDEX cad_files_project_sha_idx ON cad_files (project_id, sha256);
CREATE INDEX cad_files_status_idx ON cad_files (status) WHERE status IN ('queued', 'processing');
CREATE TRIGGER cad_files_set_updated_at
  BEFORE UPDATE ON cad_files FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The original upload is immutable: identity, location and fingerprint of the file never change.
CREATE FUNCTION cad_files_protect_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id    IS DISTINCT FROM OLD.project_id
  OR NEW.original_name IS DISTINCT FROM OLD.original_name
  OR NEW.format        IS DISTINCT FROM OLD.format
  OR NEW.size_bytes    IS DISTINCT FROM OLD.size_bytes
  OR NEW.sha256        IS DISTINCT FROM OLD.sha256
  OR NEW.storage_key   IS DISTINCT FROM OLD.storage_key THEN
    RAISE EXCEPTION 'cad_files original is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cad_files_original_immutable
  BEFORE UPDATE ON cad_files FOR EACH ROW EXECUTE FUNCTION cad_files_protect_original();

-- Extraction rows are replaced as a whole by the worker (DELETE + INSERT in one transaction), so
-- they have no updated_at. ACI colour: 0 = BYBLOCK, 1..255, 256 = BYLAYER.
CREATE TABLE cad_layers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid     NOT NULL,
  cad_file_id    uuid     NOT NULL,
  name           text     NOT NULL,
  aci_color      smallint NOT NULL CHECK (aci_color BETWEEN 1 AND 255),
  true_color     integer  CHECK (true_color BETWEEN 0 AND 16777215),
  linetype       text,
  is_on          boolean  NOT NULL,
  is_frozen      boolean  NOT NULL,
  is_locked      boolean  NOT NULL,
  entity_counts  jsonb    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entity_counts) = 'object'),
  entity_total   integer  NOT NULL DEFAULT 0 CHECK (entity_total >= 0),
  CONSTRAINT cad_layers_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE,
  CONSTRAINT cad_layers_file_name_key UNIQUE (cad_file_id, name)
);

CREATE TABLE cad_inserts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid               NOT NULL,
  cad_file_id  uuid               NOT NULL,
  handle       text               NOT NULL,
  layer        text               NOT NULL,
  block_name   text               NOT NULL,
  position     geometry(PointZ, 0) NOT NULL,
  rotation     double precision   NOT NULL DEFAULT 0,
  scale_x      double precision   NOT NULL DEFAULT 1,
  scale_y      double precision   NOT NULL DEFAULT 1,
  scale_z      double precision   NOT NULL DEFAULT 1,
  aci_color    smallint           NOT NULL DEFAULT 256 CHECK (aci_color BETWEEN 0 AND 256),
  -- [{ "tag": "...", "rawValue": "...", "value": "...", "readable": true }]
  attributes   jsonb              NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attributes) = 'array'),
  CONSTRAINT cad_inserts_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE,
  CONSTRAINT cad_inserts_file_handle_key UNIQUE (cad_file_id, handle)
);
CREATE INDEX cad_inserts_file_layer_idx ON cad_inserts (cad_file_id, layer);
CREATE INDEX cad_inserts_file_block_idx ON cad_inserts (cad_file_id, block_name);
CREATE INDEX cad_inserts_position_gix ON cad_inserts USING gist (position);

CREATE TABLE cad_texts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid               NOT NULL,
  cad_file_id  uuid               NOT NULL,
  handle       text               NOT NULL,
  kind         text               NOT NULL CHECK (kind IN ('text', 'mtext')),
  layer        text               NOT NULL,
  position     geometry(PointZ, 0) NOT NULL,
  height       double precision   NOT NULL,
  rotation     double precision   NOT NULL DEFAULT 0,   -- degrees, counter-clockwise
  raw_text     text               NOT NULL,             -- exactly as stored in the DXF
  text         text               NOT NULL,             -- decoded plain text
  readable     boolean            NOT NULL,
  style        text,
  font         text,
  aci_color    smallint           NOT NULL DEFAULT 256 CHECK (aci_color BETWEEN 0 AND 256),
  CONSTRAINT cad_texts_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE,
  CONSTRAINT cad_texts_file_handle_key UNIQUE (cad_file_id, handle)
);
CREATE INDEX cad_texts_file_layer_idx ON cad_texts (cad_file_id, layer);
-- Review list: unreadable texts first.
CREATE INDEX cad_texts_file_unreadable_idx ON cad_texts (cad_file_id) WHERE NOT readable;
CREATE INDEX cad_texts_position_gix ON cad_texts USING gist (position);

CREATE TABLE cad_curves (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid                    NOT NULL,
  cad_file_id        uuid                    NOT NULL,
  handle             text                    NOT NULL,
  entity_type        text                    NOT NULL
                       CHECK (entity_type IN ('LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'SPLINE')),
  layer              text                    NOT NULL,
  geom               geometry(LineStringZ, 0) NOT NULL,
  is_closed          boolean                 NOT NULL DEFAULT false,
  -- Flattening tolerance in drawing units when arcs/bulges/splines were approximated; NULL = exact.
  flatten_tolerance  double precision        CHECK (flatten_tolerance > 0),
  aci_color          smallint                NOT NULL DEFAULT 256 CHECK (aci_color BETWEEN 0 AND 256),
  -- 2D planar length in drawing units; recomputed in metres once the CRS is confirmed (Phase 1b).
  length             double precision        GENERATED ALWAYS AS (ST_Length(geom)) STORED,
  vertex_count       integer                 GENERATED ALWAYS AS (ST_NPoints(geom)) STORED,
  CONSTRAINT cad_curves_file_fkey
    FOREIGN KEY (project_id, cad_file_id) REFERENCES cad_files (project_id, id) ON DELETE CASCADE,
  CONSTRAINT cad_curves_file_handle_key UNIQUE (cad_file_id, handle)
);
CREATE INDEX cad_curves_file_layer_idx ON cad_curves (cad_file_id, layer);
CREATE INDEX cad_curves_file_type_idx ON cad_curves (cad_file_id, entity_type);
CREATE INDEX cad_curves_geom_gix ON cad_curves USING gist (geom);
